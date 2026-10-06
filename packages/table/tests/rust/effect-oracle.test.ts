import { Effect, Schema } from "effect";
import * as BigDecimal from "effect/BigDecimal";
import { ViewServerId } from "effect-view-server/config";
import { createColumnLiveViewEngine } from "effect-view-server/column-live-view-engine";
import { expect, test } from "vite-plus/test";

// Pinned behavior oracle: effect-view-server 4.2.8 / Effect 4.0.0-rc.111.
// Expectations are independent literal values, not another returned query total.
const schema = Schema.Struct({
  id: ViewServerId,
  group: Schema.String,
  text: Schema.optionalKey(Schema.NullOr(Schema.String)),
  n: Schema.Number,
});
const inputs = [
  { id: "a", group: "g", text: "ÉCOLE", n: 0.1 },
  { id: "b", group: "g", text: "e\u0301cole", n: 0.2 },
  { id: "c", group: "g", text: "\uE000", n: 0 },
  { id: "d", group: "g", text: "\u{10000}", n: 0 },
  { id: "e", group: "g", text: null, n: 0 },
  { id: "f", group: "g", n: 0 },
];

async function fixture() {
  const engine = await Effect.runPromise(createColumnLiveViewEngine({ topics: { probe: { schema } } }));
  await Effect.runPromise(engine.publishMany("probe", inputs));
  return engine;
}

test("pinned oracle distinguishes UTF-16 raw order, missing and null", async () => {
  const engine = await fixture();
  try {
    const result = await Effect.runPromise(engine.snapshot("probe", {
      select: ["id", "text"], orderBy: [{ field: "text", direction: "asc" }],
    }));
    expect(result.rows.map(row => row.id)).toEqual(["e", "f", "b", "a", "d", "c"]);
    expect(result.rows[0]?.text).toBeNull();
    expect(Object.hasOwn(result.rows[1]!, "text")).toBe(false);
  } finally { await Effect.runPromise(engine.close()); }
});

test("pinned oracle normalizes text, including strict canonical normalization", async () => {
  const engine = await fixture();
  try {
    const folded = await Effect.runPromise(engine.snapshot("probe", {
      select: ["id"], where: [{ field: "text", type: "equals", filter: "école" }],
    }));
    const strict = await Effect.runPromise(engine.snapshot("probe", {
      select: ["id"], where: [{ field: "text", type: "equals", filter: "école", caseSensitive: true, accentSensitive: true }],
    }));
    expect(folded.rows.map(row => row.id)).toEqual(["a", "b"]);
    expect(strict.rows.map(row => row.id)).toEqual(["b"]);
  } finally { await Effect.runPromise(engine.close()); }
});

test("pinned oracle negated text includes absent values", async () => {
  const engine = await fixture();
  try {
    const result = await Effect.runPromise(engine.snapshot("probe", {
      select: ["id"], where: [{ field: "text", type: "notContains", filter: "École" }],
    }));
    expect(result.rows.map(row => row.id)).toEqual(["c", "d", "e", "f"]);
  } finally { await Effect.runPromise(engine.close()); }
});

test("pinned oracle accumulates Number sum before conversion loss and preserves aggregate absence", async () => {
  const engine = await fixture();
  try {
    const result = await Effect.runPromise(engine.snapshot("probe", {
      groupBy: ["group"], aggregates: {
        total: { aggFunc: "sum", field: "n" }, average: { aggFunc: "avg", field: "n" },
        minimum: { aggFunc: "min", field: "text" }, maximum: { aggFunc: "max", field: "text" },
        distinct: { aggFunc: "countDistinct", field: "text" },
      },
    }));
    const row = result.rows[0]!;
    expect(BigDecimal.format(row.total)).toBe("0.3");
    expect(BigDecimal.format(row.average)).toBe("0.05");
    expect(Object.hasOwn(row, "minimum")).toBe(true);
    expect(row.minimum).toBeUndefined();
    expect(row.maximum).toBe("\uE000");
    expect(row.distinct).toBe(6n);
  } finally { await Effect.runPromise(engine.close()); }
});

test("pinned decimal division uses 100 significant digits and terminal rounding", () => {
  const third = BigDecimal.divideUnsafe(BigDecimal.fromBigInt(1n), BigDecimal.fromBigInt(3n));
  const sixth = BigDecimal.divideUnsafe(BigDecimal.fromBigInt(1n), BigDecimal.fromBigInt(6n));
  expect(third.value.toString()).toBe("3".repeat(100));
  expect(third.scale).toBe(100);
  expect(sixth.value.toString()).toBe("1" + "6".repeat(98) + "7");
  expect(sixth.scale).toBe(100);
});
