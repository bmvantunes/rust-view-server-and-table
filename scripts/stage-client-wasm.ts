/** Stage fresh verified Rust build outputs into the browser package's relative asset URLs. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  digest,
  readBuildReceipt,
  verifiedAssets,
} from "../packages/view-server-client/scripts/wasm-assets.ts";

export function stageClientWasm(root: string): void {
  const receipt = readBuildReceipt(join(root, ".local/wasm-build.json"));
  for (const [path, hash] of Object.entries(receipt.sourceSha256)) {
    const resolved = resolve(root, path),
      rel = relative(root, resolved);
    if (isAbsolute(path) || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
      throw Error(`WASM source receipt escapes repository: ${path}`);
    if (digest(readFileSync(resolved)) !== hash)
      throw Error(`WASM source changed since build: ${path}; run vp run build:wasm`);
  }
  // Validate both outputs before touching either staged asset.
  const assets = verifiedAssets(join(root, "artifacts/wasm"), receipt);
  const destination = join(root, "packages/view-server-client/src");
  mkdirSync(destination, { recursive: true });
  for (const { name, data } of assets) writeFileSync(join(destination, name), data);
  verifiedAssets(destination, receipt);
  const staging = {
    source: "artifacts/wasm",
    destination: "packages/view-server-client/src",
    artifacts: receipt.artifacts,
    sourceSha256: receipt.sourceSha256,
    bindingsVerified: true,
  };
  writeFileSync(join(root, ".local/client-wasm.json"), JSON.stringify(staging, null, 2) + "\n");
  console.log(
    JSON.stringify({ staged: assets.map((asset) => asset.name), bindingsVerified: true }),
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw Error("stage-client-wasm takes no arguments");
  stageClientWasm(resolve(import.meta.dirname, ".."));
}
