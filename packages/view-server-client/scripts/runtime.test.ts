import assert from "node:assert/strict";
import test from "node:test";
import { reconstruct, type ReconstructionContract } from "../src/row-delta.ts";
import { validRowId } from "../src/row-id.ts";
import { decodeGeneric, encodeGeneric, decode, encode } from "../src/wire/msgpack.ts";
import { exactBigInt, exactBytes } from "../src/wire/values.ts";
import { preflight } from "../src/wire/scan.ts";

const snapshot = () => ({
  kind: "snapshot",
  subscription: "q",
  query_generation: 1,
  sequence: 1,
  start_rank: 0,
  version: 1,
  total_rows: 3,
  revision: 1,
  contentVersion: 1,
  windowId: 1,
  effectiveEnd: 2,
  projection: ["id", "quantity"],
  keys: ["a", "b"],
  rows: [
    { id: "a", quantity: "9007199254740993" },
    { id: "b", quantity: "-9007199254740993" },
  ],
});
const delta = (operations: unknown[], extra: Record<string, unknown> = {}) => ({
  ...snapshot(),
  kind: "delta",
  revision: 2,
  sequence: 2,
  contentVersion: 2,
  fromRevision: 1,
  fromVersion: 1,
  toVersion: 2,
  rows: undefined,
  keys: undefined,
  operations,
  ...extra,
});

test("reconstructs snapshot and all row operations without mutating the prior result", () => {
  const prior = reconstruct(undefined, snapshot());
  const before = structuredClone(prior);
  const next = reconstruct(
    prior,
    delta([
      { type: "remove", key: "a" },
      { type: "insert", key: "c", index: 1, row: { id: "c", quantity: "7" } },
      { type: "update", key: "b", index: 0, row: { id: "b", quantity: "8" } },
      { type: "move", key: "c", fromIndex: 1, toIndex: 0 },
    ]),
  );
  assert.deepEqual(next.keys, ["c", "b"]);
  assert.deepEqual(next.rows, [
    { id: "c", quantity: "7" },
    { id: "b", quantity: "8" },
  ]);
  assert.equal(next.operations, undefined);
  assert.deepEqual(prior, before);
});

test("rejects final invalid operation atomically, preserving the previous rows and identities", () => {
  const prior = reconstruct(undefined, snapshot());
  const before = structuredClone(prior);
  assert.throws(
    () =>
      reconstruct(
        prior,
        delta([
          { type: "update", key: "a", index: 0, row: { id: "a", quantity: "9" } },
          { type: "remove", key: "absent" },
        ]),
      ),
    /remove key/,
  );
  assert.deepEqual(prior, before);
});

test("validates unknown metadata, exact scalars, identity and every delta base field", () => {
  for (const invalid of [
    null,
    [],
    4,
    { ...snapshot(), projection: [5] },
    { ...snapshot(), keys: ["a", "a"] },
    { ...snapshot(), effectiveEnd: 1 },
    { ...snapshot(), keys: ["different", "b"] },
    {
      ...snapshot(),
      rows: [
        { id: "a", quantity: 9007199254740992 },
        { id: "b", quantity: "1" },
      ],
    },
  ])
    assert.throws(() => reconstruct(undefined, invalid));
  const prior = reconstruct(undefined, snapshot());
  for (const field of [
    "fromRevision",
    "revision",
    "fromVersion",
    "toVersion",
    "query_generation",
    "start_rank",
    "windowId",
  ])
    assert.throws(() => reconstruct(prior, delta([], { [field]: 99 })), /delta base/);
  assert.throws(() => reconstruct(prior, { ...snapshot(), revision: 1 }), /stale snapshot/);
});

const contract: ReconstructionContract = {
  topic: "nested",
  schema: "v1",
  fields: ["id", "nested.value"],
  key: "id",
  fieldPatches: true,
  validate(value) {
    assert.ok(value && typeof value === "object" && !Array.isArray(value));
    assert.ok("id" in value && typeof value.id === "string");
    if ("nested" in value) {
      assert.ok(value.nested && typeof value.nested === "object");
      if ("value" in value.nested) assert.equal(typeof value.nested.value, "string");
    }
  },
};
const nested = () => ({
  ...snapshot(),
  topic: "nested",
  schema: "v1",
  total_rows: 1,
  effectiveEnd: 1,
  projection: ["id", "nested.value"],
  keys: ["a"],
  rows: [{ id: "a", nested: { value: "old" } }],
});
const nestedDelta = (changes: unknown[]) => ({
  ...delta([{ type: "patch", key: "a", index: 0, changes }]),
  topic: "nested",
  schema: "v1",
  total_rows: 1,
  effectiveEnd: 1,
  projection: ["id", "nested.value"],
});

test("nested patches copy touched paths and retain the old object, including a rejected later patch", () => {
  const prior = reconstruct(undefined, nested(), contract);
  const oldRow = prior.rows[0];
  const oldNested = oldRow.nested;
  const next = reconstruct(
    prior,
    nestedDelta([{ type: "set", path: "nested.value", value: "new" }]),
    contract,
  );
  assert.deepEqual(next.rows, [{ id: "a", nested: { value: "new" } }]);
  assert.deepEqual(oldNested, { value: "old" });
  assert.equal(prior.rows[0], oldRow);
  assert.notEqual(next.rows[0].nested, oldNested);
  assert.throws(
    () =>
      reconstruct(
        prior,
        nestedDelta([
          { type: "set", path: "nested.value", value: "new" },
          { type: "set", path: "nested.value", value: "twice" },
        ]),
        contract,
      ),
    /patch path/,
  );
  assert.deepEqual(prior.rows, [{ id: "a", nested: { value: "old" } }]);
});

test("patch negotiation, parent shape, pollution paths and dataset identity stay enforced", () => {
  const prior = reconstruct(undefined, nested(), contract);
  assert.throws(
    () =>
      reconstruct(prior, nestedDelta([{ type: "remove", path: "nested.value" }]), {
        ...contract,
        fieldPatches: false,
      }),
    /patch capability/,
  );
  for (const path of ["nested.__proto__", "constructor", "nested.absent", "nested"])
    assert.throws(() =>
      reconstruct(prior, nestedDelta([{ type: "set", path, value: "bad" }]), contract),
    );
  assert.throws(
    () => reconstruct(prior, { ...nestedDelta([]), schema: "other" }, contract),
    /dataset mismatch/,
  );
  assert.throws(
    () => reconstruct(prior, nestedDelta([{ type: "object", path: "nested" }]), contract),
    /already present/,
  );
  const removed = reconstruct(prior, nestedDelta([{ type: "remove", path: "nested" }]), contract);
  assert.deepEqual(removed.rows, [{ id: "a" }]);
});

test("legacy and generic result quotas remain distinct and operations are bounded", () => {
  const big = {
    ...snapshot(),
    total_rows: 2048,
    effectiveEnd: 2048,
    keys: Array.from({ length: 2048 }, (_, i) => String(i)),
    rows: Array.from({ length: 2048 }, (_, i) => ({ id: String(i), quantity: "0" })),
  };
  assert.throws(() => reconstruct(undefined, big), /snapshot shape/);
  const expanded: ReconstructionContract = {
    topic: "t",
    schema: "s",
    fields: ["id", "quantity"],
    key: "id",
    maxRows: 4096,
    validate(value) {
      assert.ok(value && typeof value === "object");
    },
  };
  assert.equal(
    reconstruct(undefined, { ...big, topic: "t", schema: "s" }, expanded).rows.length,
    2048,
  );
  assert.throws(
    () =>
      reconstruct(undefined, { ...big, topic: "t", schema: "s" }, { ...expanded, maxRows: 4097 }),
    /result row bound/,
  );
  assert.throws(
    () =>
      reconstruct(
        reconstruct(undefined, snapshot()),
        delta(Array.from({ length: 4097 }, () => ({ type: "remove", key: "a" }))),
      ),
    /delta shape/,
  );
});

test("canonical tuple row IDs validate byte structure, exact values and UTF-8", () => {
  assert.equal(validRowId("rid2:0101010000000178"), true);
  for (const value of [
    null,
    "rid2:01010100000001ff",
    "rid2:010101000000017800",
    "rid2:0101020000000102",
    "rid2:010106000000022d30",
    "rid2:01010100000001",
    "RID2:0101010000000178",
  ])
    assert.equal(validRowId(value), false);
});

test("v14 exact values round-trip without Number coercion and reject noncanonical coefficients", () => {
  const value = {
    quantity: "9007199254740993123456789",
    amount: { coefficient: "-999999999999999999999999999", scale: 19 },
    source_sequence: "18446744073709551615",
  };
  assert.deepEqual(decode(encode(value)), value);
  assert.deepEqual([...exactBytes("256")], [0, 1, 0]);
  assert.equal(exactBigInt(new Uint8Array([1, 1, 0])), -256n);
  for (const value of ["01", "-0", "+1", "1.0"])
    assert.throws(() => exactBytes(value), /canonical/);
  assert.throws(
    () => decode(encode({ amount: { coefficient: "10", scale: 1 } })),
    /noncanonical decimal/,
  );
  assert.throws(() => encode({ source_sequence: "18446744073709551616" }), /u64/);
});

test("generic MessagePack retains decimal strings and finite fractional numbers", () => {
  const value = {
    decimal: "9007199254740993.123456789012345678",
    value: 1.25,
    missing: null,
    values: [true, false],
  };
  assert.deepEqual(JSON.parse(JSON.stringify(decodeGeneric(encodeGeneric(value)))), value);
  assert.deepEqual([...encodeGeneric([1, "x", null])], [0x93, 0x01, 0xa1, 0x78, 0xc0]);
  for (const value of [Infinity, NaN, undefined, 1n, "\ud800"])
    assert.throws(() => encodeGeneric(value));
});

test("preflight rejects duplicate keys, overlong integers, truncation, trailing bytes and forbidden markers", () => {
  const invalid = [
    [0x82, 0xa1, 0x61, 1, 0xa1, 0x61, 2],
    [0xcc, 1],
    [0xa2, 0x61],
    [0xc0, 0xc0],
    [0xc1],
    [0xd4, 41, 0],
  ];
  for (const bytes of invalid) assert.throws(() => decodeGeneric(Uint8Array.from(bytes)));
  assert.throws(() => preflight(new Uint8Array(4194305), "msgpack"), /frame budget/);
  assert.throws(
    () => decodeGeneric(Uint8Array.from([0xcf, 0x20, 0, 0, 0, 0, 0, 0, 0])),
    /safe integer marker/,
  );
});

test("generic depth and collection budgets reject input before encoding", () => {
  assert.throws(() => encodeGeneric(Array(8193).fill(null)), /collection/);
  let deep: unknown = null;
  for (let i = 0; i < 130; i++) deep = [deep];
  assert.throws(() => encodeGeneric(deep), /depth\/value budget/);
});
