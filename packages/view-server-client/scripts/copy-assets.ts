import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readBuildReceipt, verifiedAssets } from "./wasm-assets.ts";

const client = resolve(import.meta.dirname, "..");
const root = resolve(client, "../..");
const receipt = readBuildReceipt(join(root, ".local/wasm-build.json"));
// Packaging consumes only verified staged artifacts, never a Rust source directory.
const assets = verifiedAssets(join(client, "src"), receipt);
const destination = join(client, "dist");
mkdirSync(destination, { recursive: true });
for (const { name, data } of assets) writeFileSync(join(destination, name), data);
verifiedAssets(destination, receipt);
