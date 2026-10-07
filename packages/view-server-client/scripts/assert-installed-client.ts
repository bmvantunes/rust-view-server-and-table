/** Install only the packed browser SDK, then execute its real React/Worker/WASM boundary. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative, resolve, sep } from "node:path";
import { chromium } from "playwright";
import { command, ROOT } from "../../../scripts/common.ts";
import { isolatedProcessEnvironment } from "../../../config/isolated-process-environment.ts";

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
const client = resolve(import.meta.dirname, "..");
const owned = realpathSync(mkdtempSync(join(tmpdir(), "bruno-client-pack-")));
const consumer = join(owned, "consumer");
mkdirSync(consumer);
const interruption = new AbortController();
const negativeControl = process.argv.slice(2).includes("--interrupt-after-browser-open");
if (process.argv.slice(2).some((argument) => argument !== "--interrupt-after-browser-open"))
  throw Error("Unknown installed-client verification option");
let closingBrowser: Promise<void> | undefined;
function closeBrowser(): Promise<void> {
  if (!browser) return Promise.resolve();
  return (closingBrowser ??= browser.close());
}
const interrupt = () => {
  interruption.abort(Error("Installed client verification interrupted"));
  // Closing the owned browser wakes page/navigation waits. Cleanup awaits the same promise.
  void closeBrowser().catch(() => {});
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const evidence: Record<string, unknown> = { status: "running", consumer };
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof createServer> | undefined;
try {
  const rootPackage = record(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")));
  const sdkPackage = record(JSON.parse(readFileSync(join(client, "package.json"), "utf8")));
  const dependencies = record(sdkPackage.dependencies);
  assert.ok(
    !Object.hasOwn(dependencies, "@bruno/rust-view-server"),
    "Client must not install the Cargo adapter as a runtime dependency",
  );
  await command(["vp", "pm", "pack", "--pack-destination", owned], {
    cwd: client,
    timeoutMs: 120000,
    signal: interruption.signal,
  });
  const archives = readdirSync(owned).filter((name) => name.endsWith(".tgz"));
  assert.equal(archives.length, 1);
  const tarball = join(owned, archives[0]);
  evidence.tarballSha256 = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  const sdkDevelopment = record(sdkPackage.devDependencies);
  const packageJson = {
    name: "isolated-view-server-client-proof",
    private: true,
    type: "module",
    engines: rootPackage.engines,
    devEngines: rootPackage.devEngines,
    dependencies: {
      "@bruno/view-server-client": `file:${tarball}`,
      react: sdkDevelopment.react,
      "react-dom": sdkDevelopment["react-dom"],
    },
    devDependencies: {
      "vite-plus": "1.0.0",
      typescript: sdkDevelopment.typescript,
      "@types/react": sdkDevelopment["@types/react"],
      "@types/react-dom": sdkDevelopment["@types/react-dom"],
      "@types/node": "26.6.4",
    },
  };
  writeFileSync(join(consumer, "package.json"), JSON.stringify(packageJson, null, 2));
  writeFileSync(
    join(consumer, "pnpm-workspace.yaml"),
    'packages: []\noverrides:\n  "vite@*": "npm:@voidzero-dev/vite-plus-core@1.0.0"\n',
  );
  writeFileSync(
    join(consumer, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "ES2024",
          module: "ESNext",
          moduleResolution: "Bundler",
          lib: ["ES2024", "DOM"],
          types: ["node"],
          skipLibCheck: false,
        },
        include: ["*.ts"],
      },
      null,
      2,
    ),
  );
  cpSync(join(import.meta.dirname, "fixtures/packed-client"), consumer, { recursive: true });
  // Any attempted Rust invocation is a test failure, even though the host has Rust installed.
  const blockers = join(owned, "no-rust");
  mkdirSync(blockers);
  const marker = join(owned, "rust-invoked");
  for (const name of ["cargo", "rustc", "rustup", "rustdoc", "cargo-clippy", "clippy-driver"])
    writeFileSync(
      join(blockers, name),
      '#!/bin/sh\necho "$0" >> ' + "'" + marker.replaceAll("'", "'\"'\"'") + "'" + "\nexit 97\n",
      { mode: 0o755 },
    );
  const env = isolatedProcessEnvironment(consumer);
  env.PATH = blockers + delimiter + env.PATH;
  for (const name of [
    "CARGO_HOME",
    "RUSTUP_HOME",
    "RUSTC",
    "RUSTDOC",
    "RUSTC_WRAPPER",
    "RUSTC_WORKSPACE_WRAPPER",
  ])
    delete env[name];
  const run = async (args: string[], timeoutMs = 180000) => {
    const result = await command(["vp", ...args], {
      cwd: consumer,
      env,
      timeoutMs,
      signal: interruption.signal,
    });
    process.stdout.write(result.stdout);
    return result;
  };
  await run(["install", "--prefer-offline", "--ignore-scripts", "--no-frozen-lockfile"]);
  const installed = join(consumer, "node_modules/@bruno/view-server-client");
  assert.ok(
    realpathSync(installed).startsWith(consumer + sep),
    "Installed SDK must not point back into checkout",
  );
  const packageFiles = readdirSync(installed, { recursive: true });
  assert.ok(
    !packageFiles.some((file) =>
      /(^|\/)(src|crates|Cargo\.toml|Cargo\.lock)(\/|$)|\.rs$/.test(String(file)),
    ),
    "Installed client contains Rust/source workspace files",
  );
  assert.ok(
    !existsSync(join(consumer, "node_modules/@bruno/rust-view-server")),
    "Consumer installed Rust adapter",
  );
  assert.ok(
    !readdirSync(join(consumer, "node_modules/.pnpm")).some((name) =>
      name.startsWith("@bruno+rust-view-server@"),
    ),
    "Consumer transitive graph installed Rust adapter",
  );
  await run(["exec", "tsc", "-p", "tsconfig.json"]);
  await run(["build"]);
  const dist = join(consumer, "dist");
  server = createServer((request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
      const path = resolve(dist, "." + (pathname === "/" ? "/index.html" : pathname));
      const rel = relative(dist, path);
      if (rel === ".." || rel.startsWith(".." + sep)) {
        response.writeHead(403);
        response.end();
        return;
      }
      const bytes = readFileSync(path);
      response.setHeader(
        "Content-Type",
        path.endsWith(".html")
          ? "text/html"
          : path.endsWith(".wasm")
            ? "application/wasm"
            : path.endsWith(".js") || path.endsWith(".mjs")
              ? "application/javascript"
              : "application/octet-stream",
      );
      response.end(bytes);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  interruption.signal.throwIfAborted();
  browser = await chromium.launch({ headless: true });
  interruption.signal.throwIfAborted();
  const page = await browser.newPage();
  if (negativeControl) {
    evidence.negativeControl = "SIGTERM after browser opened";
    process.kill(process.pid, "SIGTERM");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  interruption.signal.throwIfAborted();
  const workers: string[] = [],
    requests: string[] = [],
    sockets: string[] = [],
    pageErrors: string[] = [];
  page.on("worker", (worker) => workers.push(worker.url()));
  page.on("request", (request) => requests.push(request.url()));
  page.on("websocket", (socket) => sockets.push(socket.url()));
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/*", (route) =>
    route
      .request()
      .url()
      .startsWith(origin + "/")
      ? route.continue()
      : route.abort(),
  );
  await page.goto(origin);
  await page.waitForFunction(
    () => document.getElementById("result")?.textContent !== "running",
    {},
    { timeout: 30000 },
  );
  interruption.signal.throwIfAborted();
  const result = record(JSON.parse(await page.locator("#result").innerText()));
  assert.equal(result.status, "passed", JSON.stringify(result));
  assert.equal(workers.length, 2, "Both fixtures must create actual production Workers");
  assert.ok(
    workers.every((url) => url.startsWith(origin + "/") && url.includes("generic.worker")),
    "Workers must be emitted assets from installed package",
  );
  assert.ok(
    requests.some((url) => url.endsWith(".wasm")),
    "Default package WASM asset was not fetched",
  );
  assert.ok(
    requests.every((url) => url.startsWith(origin + "/")),
    "Consumer attempted an external service",
  );
  assert.deepEqual(sockets, []);
  assert.deepEqual(pageErrors, []);
  assert.ok(!existsSync(marker), "Qualification attempted to invoke Rust");
  interruption.signal.throwIfAborted();
  Object.assign(evidence, {
    status: "passed",
    result,
    workers,
    requests,
    webSockets: sockets,
    rustInvocations: 0,
    installedFromTarball: true,
    checkoutSourceFallback: false,
    consumerTypecheck: true,
  });
} catch (error) {
  evidence.status = "failed";
  evidence.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  const cleanupErrors: string[] = [];
  if (browser) {
    try {
      await closeBrowser();
    } catch (error) {
      cleanupErrors.push(String(error));
    }
  }
  if (server) {
    try {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
    } catch (error) {
      cleanupErrors.push(String(error));
    }
  }
  try {
    rmSync(owned, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(String(error));
  }
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  evidence.interrupted = interruption.signal.aborted;
  if (interruption.signal.aborted) {
    evidence.status = "failed";
    evidence.error ??= "Installed client verification interrupted";
  }
  evidence.cleaned = cleanupErrors.length === 0;
  evidence.cleanupErrors = cleanupErrors;
  if (cleanupErrors.length) evidence.status = "failed";
  mkdirSync(join(ROOT, ".local"), { recursive: true });
  writeFileSync(join(ROOT, ".local/client-packed.json"), JSON.stringify(evidence, null, 2) + "\n");
  if (cleanupErrors.length)
    throw Error(`Installed client cleanup failed: ${cleanupErrors.join("; ")}`);
}
interruption.signal.throwIfAborted();
console.log(JSON.stringify(evidence));
