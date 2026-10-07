import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  digest,
  parseBuildReceipt,
  verifiedAssets,
  verifyWasmAsset,
  wasmAssetNames,
  wasmBindings,
  type WasmAssetName,
} from "./wasm-assets.ts";

const leb = (value: number): number[] => {
  const bytes: number[] = [];
  do {
    const part = value & 127;
    value >>>= 7;
    bytes.push(part | (value ? 128 : 0));
  } while (value);
  return bytes;
};
const vector = (values: readonly number[][]): number[] => [...leb(values.length), ...values.flat()];
const text = (value: string): number[] => {
  const bytes = [...new TextEncoder().encode(value)];
  return [...leb(bytes.length), ...bytes];
};
const section = (tag: number, bytes: number[]): number[] => [tag, ...leb(bytes.length), ...bytes];
// A tiny independent WASM module with real functions and memory, no Rust build needed.
function fixture(
  name: WasmAssetName,
  options: { omit?: string; wrongArity?: string; memory?: boolean } = {},
): Uint8Array {
  const entries = Object.entries(wasmBindings[name]).filter(
    ([binding]) => binding !== options.omit,
  );
  const types = vector(
    [0, 1, 2, 3].map((arity) => [0x60, ...vector(Array.from({ length: arity }, () => [0x7f])), 0]),
  );
  const functions = vector(
    entries.map(([binding, arity]) =>
      leb(binding === options.wrongArity ? (arity + 1) % 4 : arity),
    ),
  );
  const exports = vector([
    ...(options.memory === false ? [] : [[...text("memory"), 2, 0]]),
    ...entries.map(([binding], index) => [...text(binding), 0, ...leb(index)]),
  ]);
  const bodies = vector(entries.map(() => [2, 0, 0x0b]));
  return Uint8Array.from([
    0,
    97,
    115,
    109,
    1,
    0,
    0,
    0,
    ...section(1, types),
    ...section(3, functions),
    ...section(5, [1, 0, 0]),
    ...section(7, exports),
    ...section(10, bodies),
  ]);
}
const receipt = (bytes: Uint8Array) => ({ sha256: digest(bytes), bytes: bytes.length });

test("WASM assets must match both build hashes and sizes", () => {
  const bytes = fixture("generic_engine.wasm");
  verifyWasmAsset("generic_engine.wasm", bytes, receipt(bytes));
  assert.throws(
    () =>
      verifyWasmAsset("generic_engine.wasm", bytes, { ...receipt(bytes), sha256: "0".repeat(64) }),
    /build receipt/,
  );
  assert.throws(
    () =>
      verifyWasmAsset("generic_engine.wasm", bytes, { ...receipt(bytes), bytes: bytes.length + 1 }),
    /build receipt/,
  );
});

test("actual WASM memory, function names and arities are checked before staging", () => {
  for (const name of wasmAssetNames) {
    const binding = Object.keys(wasmBindings[name])[0];
    for (const options of [{ omit: binding }, { wrongArity: binding }, { memory: false }]) {
      const bytes = fixture(name, options);
      assert.throws(() => verifyWasmAsset(name, bytes, receipt(bytes)), /binding/);
    }
  }
});

test("receipt decoding rejects absent, unknown or malformed asset/source inventories", () => {
  const artifacts = Object.fromEntries(
    wasmAssetNames.map((name) => [name, receipt(fixture(name))]),
  );
  const good = { artifacts, sourceSha256: { "source.rs": "a".repeat(64) } };
  assert.equal(Object.keys(parseBuildReceipt(good).artifacts).length, 2);
  for (const value of [
    null,
    {},
    { ...good, sourceSha256: {} },
    { ...good, sourceSha256: { "source.rs": "bad" } },
    { ...good, artifacts: { ...artifacts, unexpected: artifacts["generic_engine.wasm"] } },
    {
      ...good,
      artifacts: { ...artifacts, "generic_engine.wasm": { bytes: 3, sha256: "a".repeat(64) } },
    },
  ])
    assert.throws(() => parseBuildReceipt(value));
});

test("packaging verifies the complete staged artifact pair and rejects a stale second file", () => {
  const directory = mkdtempSync(join(tmpdir(), "client-wasm-contract-"));
  try {
    const artifacts = Object.fromEntries(
      wasmAssetNames.map((name) => {
        const bytes = fixture(name);
        writeFileSync(join(directory, name), bytes);
        return [name, receipt(bytes)];
      }),
    );
    const build = parseBuildReceipt({ artifacts, sourceSha256: { "source.rs": "a".repeat(64) } });
    assert.equal(verifiedAssets(directory, build).length, 2);
    writeFileSync(join(directory, "product_core.wasm"), fixture("generic_engine.wasm"));
    assert.throws(() => verifiedAssets(directory, build), /build receipt/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
