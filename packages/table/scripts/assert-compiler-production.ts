import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { resolve, relative, extname } from "node:path";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "vite";

import { chromium, type Browser } from "playwright";
import { reactCompiler, react } from "../../../config/react-compiler.ts";
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
await mkdir(resolve(packageRoot, "test-results"), { recursive: true });
const root = await mkdtemp(resolve(packageRoot, "test-results/compiler-production-"));
let browser: Browser | undefined, server: Server | undefined;
try {
  const probe = relative(root, resolve(packageRoot, "src/internal/compiler-numeric-probe.tsx"));
  await writeFile(
    resolve(root, "main.tsx"),
    `import {createRoot} from 'react-dom/client'; import {NumericProbe} from ${JSON.stringify(probe)}; createRoot(document.getElementById('root')!).render(<NumericProbe/>);`,
  );
  await writeFile(
    resolve(root, "index.html"),
    '<!doctype html><html><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
  );
  await build({
    root,
    configFile: false,
    mode: "production",
    plugins: [reactCompiler(), ...react()],
    build: { outDir: "dist", minify: true, sourcemap: true },
  });
  const assets = await readdir(resolve(root, "dist/assets"));
  const maps = await Promise.all(
    assets
      .filter((f) => f.endsWith(".map"))
      .map((f) => readFile(resolve(root, "dist/assets", f), "utf8")),
  );
  assert(
    maps.some((text) => text.includes("90071992547409931234567890n")),
    "production source map retains exact BigInt source",
  );
  server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      const file = resolve(root, "dist", "." + (pathname === "/" ? "/index.html" : pathname));
      if (!file.startsWith(resolve(root, "dist") + "/")) throw Error("path");
      const content = await readFile(file);
      res.setHeader(
        "Content-Type",
        new Map([
          [".html", "text/html"],
          [".js", "text/javascript"],
          [".css", "text/css"],
          [".map", "application/json"],
        ]).get(extname(file)) ?? "application/octet-stream",
      );
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  const listeningServer = server;
  await new Promise<void>((ok, fail) => {
    listeningServer.once("error", fail);
    listeningServer.listen(0, "127.0.0.1", ok);
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  await page.goto(`http://127.0.0.1:${address.port}`);
  const output = page.getByRole("status", { name: "Compiled exact values", exact: true });
  await output.waitFor();
  assert.equal(
    await output.textContent(),
    "90071992547409931234567890|-90071992547409931234567890|264|2000|true|true|true|42",
  );
  await page.getByRole("button", { name: "Next exact value", exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector("output")?.textContent?.startsWith("90071992547409931234567891|"),
  );
  assert.equal(
    await output.textContent(),
    "90071992547409931234567891|-90071992547409931234567890|264|2000|true|true|true|42",
  );
  assert.deepEqual(errors, []);
  console.log("Production minified React19 browser state/callback BigInt qualification passed.");
} finally {
  await browser?.close();
  if (server) {
    const closingServer = server;
    await new Promise<void>((ok, fail) =>
      closingServer.close((error) => (error ? fail(error) : ok())),
    );
  }
  await rm(root, { recursive: true, force: true });
}
