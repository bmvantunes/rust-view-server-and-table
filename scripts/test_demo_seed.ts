import test from "node:test";
import assert from "node:assert/strict";
import { record } from "./seed.ts";
test("seed identity is topic-isolated and revision-stable", () => {
  const client = record("client_orders", 199999),
    server = record("server_orders", 199999),
    update = record("client_orders", 199999, 1);
  assert.deepEqual(client.key, server.key);
  assert.deepEqual(client.key, update.key);
  assert.notEqual(client.row.units, server.row.units);
  assert.notEqual(client.row.units, update.row.units);
  assert.equal(client.partition, update.partition);
});
test("2048 facets and identities are distinct", () => {
  const rows = Array.from({ length: 2048 }, (_, i) => record("client_orders", i));
  assert.equal(new Set(rows.map((row) => row.row.customer)).size, 2048);
  assert.equal(new Set(rows.map((row) => row.key.id)).size, 2048);
  assert.deepEqual(new Set(rows.map((row) => row.partition)), new Set([0, 1]));
});
test("exact integers decimals and absent/null/empty values survive seed construction", () => {
  const rows = Array.from({ length: 4 }, (_, i) => record("client_orders", i).row);
  assert.equal(rows[0].units, "9007199254740993");
  assert.equal(rows[0].price, "0.00123456789012345678");
  assert(!Object.hasOwn(rows[0], "note"));
  assert.equal(rows[1].note, null);
  assert.equal(rows[2].note, "");
  assert.match(rows[3].note ?? "", /e\u0301/);
});
