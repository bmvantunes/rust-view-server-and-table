/** Compile a broken scratch engine and prove the real public React consumer fails. */
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { command } from "../../scripts/common.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sdk = join(root, "packages/view-server-client");
const rust = join(root, "packages/rust-view-server");
function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function files(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(join(path, entry.name))
      : entry.isFile()
        ? [join(path, entry.name)]
        : [],
  );
}
const inputs = ["core", "wasm"].flatMap((crate) => files(join(rust, "crates", crate))).sort();
const manifest = () =>
  Object.fromEntries(inputs.map((path) => [relative(root, path), digest(path)]));
const before = JSON.stringify(manifest());
mkdirSync(join(root, ".local"), { recursive: true });
const scratch = mkdtempSync(join(root, ".local/engine-mutation-"));
const source = join(scratch, "crates/core/src/generic.rs");
let original: string | undefined;
const interruption = new AbortController();
const interrupt = () => interruption.abort();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
  for (const crate of ["core", "wasm"])
    cpSync(join(rust, "crates", crate), join(scratch, "crates", crate), { recursive: true });
  writeFileSync(
    join(scratch, "Cargo.toml"),
    '[workspace]\nresolver="3"\nmembers=["crates/core","crates/wasm"]\n',
  );
  cpSync(join(root, "Cargo.lock"), join(scratch, "Cargo.lock"));
  original = readFileSync(source, "utf8");
  const needle = "staged.insert(key.clone(),None);";
  if (original.split(needle).length !== 2)
    throw Error("mutation target changed; inspect rather than guessing");
  writeFileSync(
    source,
    original.replace(needle, "/* intentional scratch defect: ignore valid deletes */"),
  );
  await command(
    [
      process.execPath,
      join(root, "scripts/rust.ts"),
      "build",
      "--offline",
      "--manifest-path",
      join(scratch, "Cargo.toml"),
      "-p",
      "view-server-generic-wasm",
      "--target",
      "wasm32-unknown-unknown",
      "--release",
    ],
    {
      cwd: root,
      env: { ...process.env, CARGO_TARGET_DIR: join(scratch, "target") },
      stdio: "inherit",
      timeoutMs: 600_000,
      signal: interruption.signal,
    },
  );
  const binary = join(
    scratch,
    "target/wasm32-unknown-unknown/release/view_server_generic_wasm.wasm",
  );
  const result = await command(
    [
      "vp",
      "test",
      "run",
      "--config",
      "browser.config.ts",
      "tests/memory.browser.test.tsx",
      "-t",
      "publishes before mount",
    ],
    {
      cwd: sdk,
      env: { ...process.env, RVS_TEST_WASM_URL: "/@fs" + binary },
      timeoutMs: 180_000,
      signal: interruption.signal,
      check: false,
    },
  );
  const output = (result.stdout ?? "") + (result.stderr ?? "");
  writeFileSync(join(root, ".local/engine-mutation.log"), output);
  // Compilation, module-load, signal or timeout failures are not mutation evidence.
  if (result.code === 0 || !output.includes("expected") || !output.includes("changed:0"))
    throw Error(
      "consumer did not report the expected retained-row deletion violation; inspect .local/engine-mutation.log",
    );
  writeFileSync(source, original);
  const restored = readFileSync(source, "utf8") === original;
  if (JSON.stringify(manifest()) !== before)
    throw Error("owned production source changed during mutation qualification");
  const receipt = {
    mutation: "ignore admitted deletes in generic Runtime.apply_committed",
    consumer: "emitted SDK Provider with actual generic Worker/WASM; publishes before mount test",
    consumerExitCode: result.code,
    expectedFailureObserved: true,
    scratchSourceRestored: restored,
    productionSourceUnchanged: true,
    mutatedWasmSha256: digest(binary),
  };
  writeFileSync(join(root, ".local/engine-mutation.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt));
} finally {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  if (original !== undefined && existsSync(source)) writeFileSync(source, original);
  rmSync(scratch, { recursive: true, force: true });
}
