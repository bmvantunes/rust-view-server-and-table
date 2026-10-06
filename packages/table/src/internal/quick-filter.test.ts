import { describe, expect, it } from "vitest";

import { compileColumns, type CompiledColumn } from "./compile-columns";
import {
  BRUNO_TABLE_MAX_QUICK_FILTER_FIELDS,
  BRUNO_TABLE_MAX_QUICK_FILTER_LENGTH,
  createClientQueryPredicate,
  createClientQuickFilterPredicate,
  validateBrunoTableQuickFilterFields,
} from "./quick-filter";

type QuickRow = {
  readonly id: string;
  readonly status: "open" | "closed";
  readonly symbol: string;
  readonly description: string;
};

const readColumn = (column: CompiledColumn, row: QuickRow): unknown =>
  column.kind === "field" ? row[column.field as keyof QuickRow] : undefined;

const readField = (row: QuickRow, field: string): unknown => row[field as keyof QuickRow];

describe("BrunoTable Client Quick Filter", () => {
  const columns = compileColumns([
    {
      columnId: "COL_ID_STATUS",
      field: "status",
      headerName: "Status",
      valueType: "text",
    },
  ]);

  const rows = [
    { id: "one", status: "open", symbol: "AAPL", description: "Apple Inc." },
    { id: "two", status: "closed", symbol: "MSFT", description: "Microsoft" },
    { id: "three", status: "open", symbol: "SAP", description: "Café software" },
  ] as const satisfies readonly QuickRow[];

  it("matches contains across configured source fields with the settled defaults", () => {
    const predicate = createClientQuickFilterPredicate(
      "CAFE",
      ["symbol", "description"],
      readField,
    );

    expect(predicate).toBeDefined();
    expect(rows.filter(predicate!).map((row) => row.id)).toEqual(["three"]);
  });

  it("does not create a predicate for text that normalizes to empty", () => {
    expect(createClientQuickFilterPredicate("\u0301", ["symbol"], readField)).toBeUndefined();
  });

  it("combines Grid Filters and Quick Filter with AND while preserving the empty-query identity", () => {
    const empty = createClientQueryPredicate(
      columns,
      [],
      "",
      ["symbol", "description"],
      readColumn,
      readField,
    );
    expect(empty).toBeUndefined();

    const predicate = createClientQueryPredicate(
      columns,
      [{ columnId: "COL_ID_STATUS", type: "equals", filter: "open" }],
      "MICRO",
      ["symbol", "description"],
      readColumn,
      readField,
    );

    expect(predicate).toBeDefined();
    expect(rows.filter(predicate!).map((row) => row.id)).toEqual([]);

    const matchingPredicate = createClientQueryPredicate(
      columns,
      [{ columnId: "COL_ID_STATUS", type: "equals", filter: "open" }],
      "APPLE",
      ["symbol", "description"],
      readColumn,
      readField,
    );
    expect(rows.filter(matchingPredicate!).map((row) => row.id)).toEqual(["one"]);
  });

  it("treats an unreadable or non-string field as a non-match without escaping the predicate", () => {
    const predicate = createClientQuickFilterPredicate("a", ["description"], () => {
      throw new Error("hostile getter");
    });

    expect(predicate?.({})).toBe(false);

    const nonStringPredicate = createClientQuickFilterPredicate("1", ["price"], () => 1);
    expect(nonStringPredicate?.({})).toBe(false);
  });

  it("rejects over-limit predicate text and bounds field snapshots", () => {
    const boundedText = "a".repeat(BRUNO_TABLE_MAX_QUICK_FILTER_LENGTH);
    const boundaryPredicate = createClientQuickFilterPredicate(
      boundedText,
      ["description"],
      () => boundedText,
    );
    expect(boundaryPredicate?.({})).toBe(true);

    const longTextPredicate = createClientQuickFilterPredicate(
      `${boundedText}x`,
      ["description"],
      readField,
    );
    expect(longTextPredicate).toBeUndefined();

    expect(
      createClientQuickFilterPredicate(
        "a",
        Array.from(
          { length: BRUNO_TABLE_MAX_QUICK_FILTER_FIELDS + 1 },
          (_, index) => `field-${index}`,
        ),
        readField,
      ),
    ).toBeUndefined();

    const boundaryFields = Array.from(
      { length: BRUNO_TABLE_MAX_QUICK_FILTER_FIELDS },
      (_, index) => `field-${index}`,
    );
    const boundaryFieldsPredicate = createClientQuickFilterPredicate(
      "match",
      boundaryFields,
      () => "match",
    );
    expect(boundaryFieldsPredicate?.({})).toBe(true);
    expect(validateBrunoTableQuickFilterFields(["symbol", "symbol"])).toEqual({
      ok: true,
      fields: ["symbol"],
    });
  });
});
