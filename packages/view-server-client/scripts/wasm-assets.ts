/** Verify generated assets at the packaging boundary; this module never invokes Cargo. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const wasmBindings = {
  "generic_engine.wasm": {
    view_engine_new: 0,
    view_engine_free: 1,
    view_engine_alloc: 1,
    view_engine_dealloc: 2,
    view_engine_command: 3,
    view_engine_output_ptr: 1,
    view_engine_output_len: 1,
  },
  "product_core.wasm": {
    product_core_new: 0,
    product_core_alloc: 1,
    product_core_dealloc: 2,
    product_core_apply: 3,
    product_core_result: 3,
    product_core_stats: 1,
    product_core_dirty_ids: 1,
    product_core_output_ptr: 1,
    product_core_output_len: 1,
    product_core_error_ptr: 1,
    product_core_error_len: 1,
    product_core_free: 1,
  },
} as const;
export type WasmAssetName = keyof typeof wasmBindings;
export const wasmAssetNames: readonly WasmAssetName[] = [
  "generic_engine.wasm",
  "product_core.wasm",
];
export type AssetReceipt = { sha256: string; bytes: number };
export type BuildReceipt = {
  artifacts: Record<WasmAssetName, AssetReceipt>;
  sourceSha256: Record<string, string>;
};
export function digest(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function artifact(value: unknown): AssetReceipt {
  if (
    !record(value) ||
    !hash(value.sha256) ||
    typeof value.bytes !== "number" ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 8 ||
    value.bytes > 32 * 1024 * 1024
  )
    throw Error("Invalid WASM artifact receipt");
  return { sha256: value.sha256, bytes: value.bytes };
}
export function parseBuildReceipt(value: unknown): BuildReceipt {
  if (
    !record(value) ||
    !record(value.artifacts) ||
    !record(value.sourceSha256) ||
    Object.keys(value.sourceSha256).length === 0
  )
    throw Error("Missing WASM build receipt; run vp run build:wasm first");
  if (Object.keys(value.artifacts).length !== wasmAssetNames.length)
    throw Error("Unexpected WASM artifact inventory");
  const sourceSha256: Record<string, string> = {};
  for (const [path, valueHash] of Object.entries(value.sourceSha256)) {
    if (!hash(valueHash)) throw Error(`Invalid WASM source receipt: ${path}`);
    sourceSha256[path] = valueHash;
  }
  return {
    artifacts: {
      "generic_engine.wasm": artifact(value.artifacts["generic_engine.wasm"]),
      "product_core.wasm": artifact(value.artifacts["product_core.wasm"]),
    },
    sourceSha256,
  };
}
export function readBuildReceipt(path: string): BuildReceipt {
  return parseBuildReceipt(JSON.parse(readFileSync(path, "utf8")));
}
export function verifyWasmAsset(
  name: WasmAssetName,
  data: Uint8Array,
  expected: AssetReceipt,
): void {
  if (data.byteLength !== expected.bytes || digest(data) !== expected.sha256)
    throw Error(`WASM artifact does not match current build receipt: ${name}`);
  const module = new WebAssembly.Module(new Uint8Array(data));
  if (WebAssembly.Module.imports(module).length !== 0)
    throw Error(`Unexpected WASM imports: ${name}`);
  const instance = new WebAssembly.Instance(module, {});
  if (!(instance.exports.memory instanceof WebAssembly.Memory))
    throw Error(`WASM memory binding missing: ${name}`);
  for (const [binding, arity] of Object.entries(wasmBindings[name])) {
    const value = instance.exports[binding];
    if (typeof value !== "function" || value.length !== arity)
      throw Error(`WASM binding mismatch: ${name}:${binding}/${arity}`);
  }
}
export function verifiedAssets(
  directory: string,
  receipt: BuildReceipt,
): ReadonlyArray<{ name: WasmAssetName; data: Uint8Array; receipt: AssetReceipt }> {
  return wasmAssetNames.map((name) => {
    const data = readFileSync(join(directory, name));
    verifyWasmAsset(name, data, receipt.artifacts[name]);
    return { name, data, receipt: receipt.artifacts[name] };
  });
}
