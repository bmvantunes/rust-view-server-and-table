import { describe, expect, it, vi } from "vitest";
import * as BigDecimal from "effect/BigDecimal";

import { compileColumns, type CompiledColumn } from "./compile-columns";
import { BrunoTableGridRuntime } from "./grid-runtime";
import { BrunoTableServerRowPipelineAdapter } from "./server-source-adapter";
import { brunoTableTestSemanticQueryKey } from "./server-semantic-key.test-support";
import { BrunoTableBigDecimalColumn, BrunoTableBigDecimalValueType } from "../effect";
import type { BrunoTableColumns, BrunoTableValueType } from "../public-types";

type Row = Readonly<{ readonly symbol: string; readonly price: number }>;

const columns = compileColumns([
  {
    columnId: "COL_ID_SYMBOL",
    field: "symbol",
    headerName: "Symbol",
    valueType: "text",
  },
  {
    columnId: "COL_ID_PRICE",
    field: "price",
    headerName: "Price",
    valueType: "number",
    pinned: "end",
  },
]);

const query = Object.freeze({
  generation: 0,
  navigationMode: "reconcile" as const,
  filters: Object.freeze([]),
  quickFilter: "",
  orderBy: Object.freeze([{ columnId: "COL_ID_SYMBOL", direction: "asc" as const }]),
});

const completeRawSelect = ["symbol", "price"] as const;

function makeViewport<TRow = Row>() {
  let request:
    | Readonly<{
        readonly query: unknown;
        readonly window: Readonly<{ readonly firstRow: number; readonly lastRow: number }>;
        readonly sink: Readonly<{
          readonly setRowCount: (count: number, keepRenderedRows?: boolean) => void;
          readonly setRowData: (
            rows: Readonly<Record<number, TRow>>,
            keys: Readonly<Record<number, string>>,
          ) => void;
        }>;
      }>
    | undefined;
  const setWindow = vi.fn();
  const release = vi.fn();
  const semanticKey = vi.fn(brunoTableTestSemanticQueryKey);
  const replace = vi.fn((next: NonNullable<typeof request>) => {
    request = next;
    return { setWindow, release };
  });
  return {
    viewport: { replace, semanticKey },
    replace,
    semanticKey,
    setWindow,
    release,
    getRequest: () => request,
  };
}

describe("BrunoTableServerRowPipelineAdapter", () => {
  it("notifies structure subscribers even when a metadata subscriber throws", () => {
    const transport = makeViewport();
    const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      columns,
      undefined,
      [],
      query.orderBy,
      completeRawSelect,
    );
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect,
      totalRows: 100,
      version: 1,
      status: "ready",
    });
    adapter.replace(transport.viewport, query);
    const request = transport.getRequest()!;
    request.sink.setRowCount(100);
    const failure = new Error("metadata subscriber failed");
    const observedTotals: number[] = [];
    adapter.subscribeMetadata(() => {
      throw failure;
    });
    adapter.subscribeStructure(() => {
      observedTotals.push(adapter.getStructureSnapshot().totalRows);
    });
    expect(() => request.sink.setRowCount(200, true)).toThrow(failure);
    expect(observedTotals).toEqual([200]);
    expect(adapter.getMetadataSnapshot().totalRows).toBe(200);
  });

  it("isolates query metadata from immutable sparse identity publications", () => {
    const transport = makeViewport();
    const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      columns,
      undefined,
      [],
      query.orderBy,
      completeRawSelect,
    );
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect,
      totalRows: 100,
      version: 1,
      status: "ready",
    });
    adapter.replace(transport.viewport, query);
    const request = transport.getRequest()!;
    request.sink.setRowCount(100);
    adapter.setRequiredRange(0, 3);
    request.sink.setRowData(
      { 0: { symbol: "A", price: 1 }, 1: { symbol: "B", price: 2 }, 2: { symbol: "C", price: 3 } },
      { 0: "a", 1: "b", 2: "c" },
    );
    const metadata = adapter.getMetadataSnapshot();
    const originalIdentities = adapter.getStructureSnapshot();
    const onMetadata = vi.fn();
    const onIdentity = vi.fn();
    const removeMetadata = adapter.subscribeMetadata(onMetadata);
    const removeIdentity = adapter.subscribeStructure(onIdentity);
    try {
      adapter.setRequiredRange(1, 4);
      const retainedIdentities = adapter.getStructureSnapshot();
      expect(retainedIdentities.getRowId(0)).toBeUndefined();
      expect(retainedIdentities.getRowId(1)).toBe("b");
      expect(originalIdentities.findRowIndex("a")).toBe(0);
      expect(retainedIdentities.findRowIndex("a")).toBeUndefined();
      request.sink.setRowData({ 3: { symbol: "D", price: 4 } }, { 3: "d" });
      expect(adapter.getStructureSnapshot().getRowId(3)).toBe("d");
      expect(originalIdentities.getRowId(0)).toBe("a");
      expect(originalIdentities.getRowId(3)).toBeUndefined();
      expect(retainedIdentities.getRowId(3)).toBeUndefined();
      expect(originalIdentities.findRowIndex("d")).toBeUndefined();
      expect(retainedIdentities.findRowIndex("d")).toBeUndefined();
      expect(adapter.getStructureSnapshot().findRowIndex("d")).toBe(3);
      expect(onIdentity).toHaveBeenCalledTimes(2);
      expect(onMetadata).not.toHaveBeenCalled();
      expect(adapter.getMetadataSnapshot()).toBe(metadata);
      request.sink.setRowCount(200, true);
      expect(onMetadata).toHaveBeenCalledOnce();
      expect(adapter.getMetadataSnapshot().totalRows).toBe(200);
      const beforeQuery = adapter.getMetadataSnapshot();
      adapter.replace(transport.viewport, {
        ...query,
        orderBy: [{ columnId: "COL_ID_SYMBOL", direction: "desc" }],
      });
      expect(adapter.getMetadataSnapshot().generation).not.toBe(beforeQuery.generation);
      expect(onMetadata.mock.calls.length).toBeGreaterThan(1);
      expect(originalIdentities.findRowIndex("a")).toBe(0);
      expect(retainedIdentities.findRowIndex("b")).toBe(1);
      expect(adapter.getStructureSnapshot().findRowIndex("b")).toBeUndefined();
    } finally {
      removeMetadata();
      removeIdentity();
    }
  });

  it("rejects unsupported Server arithmetic before construction or column reconciliation", () => {
    const unsupportedColumns = compileColumns([
      {
        columnId: "COL_ID_GROUP",
        field: "symbol",
        headerName: "Group",
        valueType: "text",
        groupBy: true,
      },
      {
        columnId: "COL_ID_UNSUPPORTED_SUM",
        field: "price",
        headerName: "Unsupported sum",
        valueType: Object.assign({}, BrunoTableBigDecimalValueType, {
          codecId: "example/client-only-arithmetic",
        }),
        aggFunc: "sum",
      },
    ]);
    expect(
      () =>
        new BrunoTableServerRowPipelineAdapter<Row>(
          unsupportedColumns,
          undefined,
          [],
          [{ columnId: "COL_ID_GROUP", direction: "asc" }],
          completeRawSelect,
        ),
    ).toThrow(
      "BrunoTable Server aggregate has no source-compatible exact result Value Type: COL_ID_UNSUPPORTED_SUM",
    );

    const transport = makeViewport();
    const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      columns,
      undefined,
      [],
      query.orderBy,
      completeRawSelect,
    );
    expect(() => adapter.reconcileColumns(unsupportedColumns, undefined)).toThrow(
      "BrunoTable Server aggregate has no source-compatible exact result Value Type: COL_ID_UNSUPPORTED_SUM",
    );
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect,
      totalRows: 1,
      version: 1,
      status: "ready",
    });
    adapter.replace(transport.viewport, query);
    expect(transport.getRequest()?.query).toEqual({
      select: ["symbol", "price"],
      where: [],
      orderBy: [{ field: "symbol", direction: "asc" }],
    });
  });

  it("does not infer grouped rows from a legitimate raw values Map field", () => {
    type RawMapRow = Readonly<{
      readonly symbol: string;
      readonly values: ReadonlyMap<string, unknown>;
    }>;
    const rawColumns = compileColumns([
      {
        columnId: "COL_ID_SYMBOL",
        field: "symbol",
        headerName: "Symbol",
        valueType: "text",
      },
    ]);
    const transport = makeViewport<RawMapRow>();
    const adapter = new BrunoTableServerRowPipelineAdapter<RawMapRow>(
      rawColumns,
      undefined,
      [],
      [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
      ["symbol", "values"],
    );
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect: ["symbol", "values"],
      totalRows: 1,
      version: 1,
      status: "ready",
    });
    adapter.replace(transport.viewport, query);
    const values = new Map([["COL_ID_SYMBOL", "WRONG"]]);
    const first = { symbol: "AAPL", values } as const;
    transport.getRequest()!.sink.setRowData({ 0: first }, { 0: "raw-map" });

    expect(adapter.getPublication().rowSpace?.getCellValue("raw-map", "COL_ID_SYMBOL")).toBe(
      "AAPL",
    );
    transport.getRequest()!.sink.setRowData({ 0: { symbol: "AAPL", values } }, { 0: "raw-map" });
    expect(adapter.getPublication().rowSpace?.getRow("raw-map")).toBe(first);
  });

  it("installs authoritative grouped keys and decodes private aliases by Column Identity", () => {
    const groupedColumns = compileColumns([
      {
        columnId: "COL_ID_DESK",
        field: "desk",
        headerName: "Desk",
        valueType: "text",
        groupBy: true,
      },
      {
        columnId: "COL_ID_MIN_PRICE",
        field: "price",
        headerName: "Minimum",
        valueType: "number",
        aggFunc: "min",
      },
      {
        columnId: "COL_ID_MAX_PRICE",
        field: "price",
        headerName: "Maximum",
        valueType: "number",
        aggFunc: "max",
      },
    ]);
    const transport = makeViewport<Record<string, unknown>>();
    const adapter = new BrunoTableServerRowPipelineAdapter<Record<string, unknown>>(
      groupedColumns,
      undefined,
      [],
      [{ columnId: "COL_ID_DESK", direction: "asc" }],
      ["desk", "price"],
    );
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect: ["desk", "price"],
      totalRows: 2,
      version: 1,
      status: "ready",
    });
    const runtime = new BrunoTableGridRuntime(
      adapter.getPublication(),
      groupedColumns,
      adapter.getQueryConfiguration(),
      "TABLE_ID_GROUPED_SERVER_PUBLICATIONS",
      { grouping: true },
    );
    const runtimeView = runtime.getView();
    adapter.subscribePublication(() => runtimeView.publishRowPipeline(adapter.getPublication()));
    const groupingNotifications = vi.fn();
    const projectionNotifications = vi.fn();
    runtimeView.subscribeInstalledGroupingStructure(groupingNotifications);
    runtimeView.subscribeInstalledClientProjection(projectionNotifications);
    adapter.replace(
      transport.viewport,
      {
        ...query,
        groupBy: ["COL_ID_DESK"],
        groupOrderBy: [{ columnId: "COL_ID_MAX_PRICE", direction: "desc" }],
        orderBy: [{ columnId: "COL_ID_DESK", direction: "asc" }],
      },
      {
        routeBy: undefined,
        externalFilters: undefined,
        visibleColumnIds: ["COL_ID_DESK", "COL_ID_MIN_PRICE", "COL_ID_MAX_PRICE"],
      },
    );

    const request = transport.getRequest()!;
    const groupedPlan = request.query as {
      readonly groupBy: readonly string[];
      readonly aggregates: Readonly<Record<string, { readonly aggFunc: string }>>;
      readonly orderBy: readonly { readonly aggregate?: string }[];
    };
    const aliases = Object.keys(groupedPlan.aggregates);
    const rowsAlias = aliases.find((alias) => groupedPlan.aggregates[alias]!.aggFunc === "count")!;
    const minAlias = aliases.find((alias) => groupedPlan.aggregates[alias]!.aggFunc === "min")!;
    const maxAlias = aliases.find((alias) => groupedPlan.aggregates[alias]!.aggFunc === "max")!;
    expect(groupedPlan.groupBy).toEqual(["desk"]);
    expect(minAlias).not.toBe(maxAlias);
    expect(groupedPlan.orderBy).toEqual([{ aggregate: maxAlias, direction: "desc" }]);

    request.sink.setRowCount(1, true);
    let authoritativeKeyReads = 0;
    const authoritativeKeys = {} as Record<number, string>;
    Object.defineProperty(authoritativeKeys, "0", {
      enumerable: true,
      get: () =>
        authoritativeKeyReads++ === 0 ? "authoritative-group-key" : "unvalidated-group-key",
    });
    request.sink.setRowData(
      { 0: { desk: "Rates", [rowsAlias]: 3n, [minAlias]: 10, [maxAlias]: 20 } },
      authoritativeKeys,
    );
    const publication = adapter.getPublication();
    expect(authoritativeKeyReads).toBe(1);
    expect(publication.rowSpace?.getRowId(0)).toBe("authoritative-group-key");
    expect(publication.rowSpace?.getRow("authoritative-group-key")).toMatchObject({
      rowId: "authoritative-group-key",
    });
    expect(publication.rowSpace?.getCellValue("authoritative-group-key", "COL_ID_DESK")).toBe(
      "Rates",
    );
    expect(
      publication.rowSpace?.getCellValue("authoritative-group-key", "COL_ID_BRUNO_TABLE_ROWS"),
    ).toBe(3n);
    expect(publication.rowSpace?.getCellValue("authoritative-group-key", "COL_ID_MIN_PRICE")).toBe(
      10,
    );
    expect(publication.rowSpace?.getCellValue("authoritative-group-key", "COL_ID_MAX_PRICE")).toBe(
      20,
    );
    expect(publication.clientProjection).toMatchObject({
      kind: "grouped",
      groupBy: ["COL_ID_DESK"],
    });
    const retained = publication.rowSpace?.getRow("authoritative-group-key");
    groupingNotifications.mockClear();
    projectionNotifications.mockClear();
    request.sink.setRowData(
      { 0: { desk: "Rates", [rowsAlias]: 3n, [minAlias]: 10, [maxAlias]: 20 } },
      { 0: "authoritative-group-key" },
    );
    expect(adapter.getPublication().rowSpace?.getRow("authoritative-group-key")).toBe(retained);
    request.sink.setRowData(
      { 0: { desk: "Rates", [rowsAlias]: 3n, [minAlias]: 10, [maxAlias]: 21 } },
      { 0: "authoritative-group-key" },
    );
    expect(adapter.getPublication().rowSpace?.getRow("authoritative-group-key")).not.toBe(retained);
    expect(
      adapter
        .getPublication()
        .rowSpace?.getCellValue("authoritative-group-key", "COL_ID_MAX_PRICE"),
    ).toBe(21);
    const groupedRow = { desk: "Rates", [rowsAlias]: 3n, [minAlias]: 10, [maxAlias]: 21 };
    expect(() => request.sink.setRowData({ 0: groupedRow }, {})).toThrow("invalid row/key maps");
    expect(() => request.sink.setRowData({}, { 0: "extra-key" })).toThrow("invalid row/key maps");
    expect(() =>
      request.sink.setRowData(
        { 0: groupedRow, 1: groupedRow },
        { 0: "duplicate-key", 1: "duplicate-key" },
      ),
    ).toThrow("invalid row/key maps");
    expect(() => request.sink.setRowData({ 0: groupedRow }, { 0: "" })).toThrow(
      "invalid row/key maps",
    );
    expect(adapter.getPublication().rowSpace?.getRowId(0)).toBe("authoritative-group-key");
    request.sink.setRowData({ 0: groupedRow }, { 0: "moved-authoritative-group-key" });
    expect(groupingNotifications).not.toHaveBeenCalled();
    expect(projectionNotifications).not.toHaveBeenCalled();
  });

  it("publishes deterministic grouped invalid values without throwing or dropping coherent rows", () => {
    const groupedColumns = compileColumns([
      {
        columnId: "COL_ID_DESK",
        field: "desk",
        headerName: "Desk",
        valueType: "text",
        groupBy: true,
      },
      {
        columnId: "COL_ID_MAX_PRICE",
        field: "price",
        headerName: "Maximum",
        valueType: "number",
        aggFunc: "max",
      },
    ]);
    const transport = makeViewport<Record<string, unknown>>();
    const adapter = new BrunoTableServerRowPipelineAdapter<Record<string, unknown>>(
      groupedColumns,
      undefined,
      [],
      [{ columnId: "COL_ID_DESK", direction: "asc" }],
      ["desk", "price"],
    );
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect: ["desk", "price"],
      totalRows: 2,
      version: 1,
      status: "ready",
    });
    adapter.replace(transport.viewport, {
      ...query,
      orderBy: [{ columnId: "COL_ID_DESK", direction: "asc" }],
      groupBy: ["COL_ID_DESK"],
      groupOrderBy: [{ columnId: "COL_ID_MAX_PRICE", direction: "desc" }],
    });
    const request = transport.getRequest()!;
    const aggregateQuery = (request.query as { aggregates: Record<string, { aggFunc: string }> })
      .aggregates;
    const rowsAlias = Object.entries(aggregateQuery).find(
      ([, aggregate]) => aggregate.aggFunc === "count",
    )![0];
    const maxAlias = Object.entries(aggregateQuery).find(
      ([, aggregate]) => aggregate.aggFunc === "max",
    )![0];
    request.sink.setRowCount(2, true);
    request.sink.setRowData(
      {
        0: { desk: "Rates", [rowsAlias]: 2n, [maxAlias]: 20 },
        1: { desk: "Credit", [rowsAlias]: 4n, [maxAlias]: 40 },
      },
      { 0: "rates", 1: "credit" },
    );
    const coherentRow = adapter.getPublication().rowSpace?.getRow("rates");
    const coherentCredit = adapter.getPublication().rowSpace?.getRow("credit");
    const publicationNotification = vi.fn();
    const structureNotification = vi.fn();
    const resultNotification = vi.fn();
    const unsubscribePublication = adapter.subscribePublication(publicationNotification);
    const unsubscribeStructure = adapter.subscribeStructure(structureNotification);
    const unsubscribeResult = adapter.subscribeResultRowCount(resultNotification);

    expect(() =>
      request.sink.setRowData(
        {
          0: { desk: "Rates", [rowsAlias]: 2n, [maxAlias]: "invalid" },
          1: { desk: "Credit", [rowsAlias]: 5n, [maxAlias]: 41 },
        },
        { 0: "rates", 1: "credit" },
      ),
    ).not.toThrow();
    expect(adapter.getPublication()).toMatchObject({
      hasCoherentRows: true,
      invalid: {
        kind: "invalid-value",
        rowIndex: 0,
        columnId: "COL_ID_MAX_PRICE",
        message: "Expected a finite number value.",
      },
    });
    expect(adapter.getPublication().rowSpace?.getRow("rates")).toBe(coherentRow);
    expect(adapter.getPublication().rowSpace?.getRow("credit")).toBe(coherentCredit);
    expect(publicationNotification).toHaveBeenCalledOnce();
    expect(structureNotification).not.toHaveBeenCalled();
    expect(resultNotification).not.toHaveBeenCalled();

    publicationNotification.mockClear();
    request.sink.setRowData(
      { 0: { desk: "Rates", [rowsAlias]: 3n, [maxAlias]: 21 } },
      { 0: "rates" },
    );
    expect(adapter.getPublication().invalid).toMatchObject({ rowIndex: 0 });
    expect(adapter.getPublication().rowSpace?.getRow("rates")).not.toBe(coherentRow);
    expect(adapter.getPublication().rowSpace?.getRow("credit")).toBe(coherentCredit);

    request.sink.setRowData(
      { 1: { desk: "Credit", [rowsAlias]: 5n, [maxAlias]: 41 } },
      { 1: "credit" },
    );
    expect(adapter.getPublication().invalid).toBeUndefined();
    expect(publicationNotification).toHaveBeenCalledTimes(2);

    request.sink.setRowData(
      { 0: { desk: "Rates", [rowsAlias]: 3n, [maxAlias]: "invalid" } },
      { 0: "rates" },
    );
    expect(() =>
      request.sink.setRowData(
        { 2: { desk: "Out of range", [rowsAlias]: 1n, [maxAlias]: 10 } },
        { 2: "out-of-range" },
      ),
    ).toThrow("invalid row/key maps");
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect: ["desk", "price"],
      totalRows: 2,
      version: 2,
      status: "stale",
    });
    expect(adapter.getPublication().invalid).toMatchObject({ rowIndex: 0 });

    request.sink.setRowData(
      { 1: { desk: "Credit", [rowsAlias]: 4n, [maxAlias]: "invalid" } },
      { 1: "credit" },
    );
    request.sink.setRowData(
      { 0: { desk: "Rates", [rowsAlias]: 3n, [maxAlias]: 21 } },
      { 0: "rates" },
    );
    expect(adapter.getPublication().invalid).toMatchObject({ rowIndex: 1 });
    expect(adapter.getPublication().rowSpace?.getCellValue("rates", "COL_ID_MAX_PRICE")).toBe(21);

    request.sink.setRowData(
      { 1: { desk: "Credit", [rowsAlias]: 5n, [maxAlias]: 41 } },
      { 1: "credit" },
    );
    expect(adapter.getPublication().invalid).toBeUndefined();

    expect(() =>
      request.sink.setRowData(
        { 0: { desk: "Rates", [rowsAlias]: 0n, [maxAlias]: 21 } },
        { 0: "rates" },
      ),
    ).not.toThrow();
    expect(adapter.getPublication().invalid).toMatchObject({
      kind: "invalid-value",
      rowIndex: 0,
      columnId: "COL_ID_BRUNO_TABLE_ROWS",
    });

    request.sink.setRowCount(100, true);
    publicationNotification.mockClear();
    adapter.setRequiredRange(50, 51);
    expect(adapter.getPublication().invalid).toBeUndefined();
    expect(publicationNotification).toHaveBeenCalledOnce();

    publicationNotification.mockClear();
    expect(() =>
      request.sink.setRowData(
        { 0: { desk: "Late", [rowsAlias]: 1n, [maxAlias]: "invalid" } },
        { 0: "late" },
      ),
    ).not.toThrow();
    expect(adapter.getPublication().invalid).toBeUndefined();
    expect(publicationNotification).not.toHaveBeenCalled();
    expect(() =>
      request.sink.setRowData(
        { 100: { desk: "Beyond", [rowsAlias]: 1n, [maxAlias]: "invalid" } },
        { 100: "beyond" },
      ),
    ).toThrow("invalid row/key maps");
    expect(adapter.getPublication().invalid).toBeUndefined();

    request.sink.setRowData(
      { 50: { desk: "Admitted", [rowsAlias]: 1n, [maxAlias]: "invalid" } },
      { 50: "admitted" },
    );
    expect(adapter.getPublication().invalid).toMatchObject({ rowIndex: 50 });
    publicationNotification.mockClear();
    request.sink.setRowCount(50, true);
    expect(adapter.getPublication().invalid).toBeUndefined();
    expect(publicationNotification).toHaveBeenCalledOnce();

    request.sink.setRowCount(100, true);
    request.sink.setRowData(
      { 50: { desk: "Admitted", [rowsAlias]: 1n, [maxAlias]: "invalid" } },
      { 50: "admitted" },
    );
    expect(adapter.getPublication().invalid).toMatchObject({ rowIndex: 50 });

    adapter.replace(transport.viewport, {
      ...query,
      orderBy: [{ columnId: "COL_ID_DESK", direction: "asc" }],
      groupBy: ["COL_ID_DESK"],
      groupOrderBy: [{ columnId: "COL_ID_MAX_PRICE", direction: "asc" }],
    });
    expect(adapter.getPublication().invalid).toBeUndefined();
    unsubscribeResult();
    unsubscribeStructure();
    unsubscribePublication();
  });

  it("contains an invalid grouped delivery made synchronously by replacement", () => {
    const groupedColumns = compileColumns([
      {
        columnId: "COL_ID_DESK",
        field: "desk",
        headerName: "Desk",
        valueType: "text",
        groupBy: true,
      },
      {
        columnId: "COL_ID_MAX_PRICE",
        field: "price",
        headerName: "Maximum",
        valueType: "number",
        aggFunc: "max",
      },
    ]);
    type Request = {
      query: unknown;
      sink: {
        setRowCount: (count: number, keepRenderedRows?: boolean) => void;
        setRowData: (
          rows: Readonly<Record<number, Record<string, unknown>>>,
          keys: Readonly<Record<number, string>>,
        ) => void;
      };
    };
    const release = vi.fn();
    let synchronousRequest: Request | undefined;
    const deliverInvalid = (request: Request, index = 0) => {
      const aggregates = (request.query as { aggregates: Record<string, { aggFunc: string }> })
        .aggregates;
      const rowsAlias = Object.entries(aggregates).find(
        ([, aggregate]) => aggregate.aggFunc === "count",
      )![0];
      const maxAlias = Object.entries(aggregates).find(
        ([, aggregate]) => aggregate.aggFunc === "max",
      )![0];
      if (index === 0) request.sink.setRowCount(1, true);
      request.sink.setRowData(
        { [index]: { desk: "Rates", [rowsAlias]: 1n, [maxAlias]: "invalid" } },
        { [index]: `rates-${String(index)}` },
      );
    };
    const replace = vi.fn((request: Request) => {
      synchronousRequest = request;
      deliverInvalid(request);
      return { setWindow: vi.fn(), release };
    });
    const viewport = {
      semanticKey: brunoTableTestSemanticQueryKey,
      replace,
    };
    const adapter = new BrunoTableServerRowPipelineAdapter<Record<string, unknown>>(
      groupedColumns,
      undefined,
      [],
      [{ columnId: "COL_ID_DESK", direction: "asc" }],
      ["desk", "price"],
    );
    adapter.reconcileSource({
      viewport,
      completeRawSelect: ["desk", "price"],
      totalRows: 1,
      version: 1,
      status: "ready",
    });

    expect(() =>
      adapter.replace(viewport, {
        ...query,
        groupBy: ["COL_ID_DESK"],
        groupOrderBy: [{ columnId: "COL_ID_MAX_PRICE", direction: "desc" }],
      }),
    ).not.toThrow();
    expect(adapter.getPublication()).toMatchObject({
      hasCoherentRows: false,
      invalid: {
        kind: "invalid-value",
        rowIndex: 0,
        columnId: "COL_ID_MAX_PRICE",
      },
    });

    synchronousRequest!.sink.setRowCount(100, true);
    const publicationNotification = vi.fn();
    const unsubscribePublication = adapter.subscribePublication(publicationNotification);
    adapter.setRequiredRange(50, 51);
    expect(adapter.getPublication().invalid).toBeUndefined();
    expect(publicationNotification).toHaveBeenCalledOnce();
    deliverInvalid(synchronousRequest!, 50);
    expect(adapter.getPublication().invalid).toMatchObject({ rowIndex: 50 });
    unsubscribePublication();

    release.mockImplementationOnce(() => {
      throw new Error("release failure");
    });
    expect(() =>
      adapter.replace(viewport, {
        ...query,
        groupBy: ["COL_ID_DESK"],
        groupOrderBy: [{ columnId: "COL_ID_MAX_PRICE", direction: "asc" }],
      }),
    ).toThrow("release failure");
    expect(adapter.getPublication().invalid).toBeUndefined();

    replace.mockImplementationOnce((request) => {
      deliverInvalid(request);
      throw new Error("replace failure");
    });
    expect(() =>
      adapter.replace(viewport, {
        ...query,
        groupBy: ["COL_ID_DESK"],
        groupOrderBy: [{ columnId: "COL_ID_MAX_PRICE", direction: "asc" }],
      }),
    ).toThrow("replace failure");
    expect(adapter.getPublication().invalid).toBeUndefined();
  });

  it("updates grouped key and aggregate widths without replacing the source generation", () => {
    const groupedColumns = compileColumns([
      {
        columnId: "COL_ID_DESK",
        field: "desk",
        headerName: "Desk",
        valueType: "text",
        groupBy: true,
      },
      {
        columnId: "COL_ID_PRICE",
        field: "price",
        headerName: "Price",
        valueType: "number",
        aggFunc: "max",
      },
    ]);
    const transport = makeViewport<Record<string, unknown>>();
    const adapter = new BrunoTableServerRowPipelineAdapter<Record<string, unknown>>(
      groupedColumns,
      undefined,
      [],
      [{ columnId: "COL_ID_DESK", direction: "asc" }],
      ["desk", "price"],
    );
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect: ["desk", "price"],
      totalRows: 1,
      version: 1,
      status: "ready",
    });
    const groupedQuery = {
      ...query,
      orderBy: [{ columnId: "COL_ID_DESK", direction: "asc" as const }],
      groupBy: ["COL_ID_DESK"],
      groupOrderBy: [{ columnId: "COL_ID_DESK", direction: "asc" as const }],
    };
    adapter.replace(transport.viewport, groupedQuery, {
      routeBy: undefined,
      externalFilters: undefined,
      visibleColumnIds: ["COL_ID_DESK", "COL_ID_PRICE"],
      presentationColumns: groupedColumns,
    });
    const resizedColumns = Object.freeze(
      groupedColumns.map((column) =>
        Object.freeze({
          ...column,
          semantics: Object.freeze({
            ...column.semantics,
            width: column.columnId === "COL_ID_DESK" ? 231 : 287,
          }),
        }),
      ),
    );
    adapter.replace(transport.viewport, groupedQuery, {
      routeBy: undefined,
      externalFilters: undefined,
      visibleColumnIds: ["COL_ID_DESK", "COL_ID_PRICE"],
      presentationColumns: resizedColumns,
    });

    expect(transport.replace).toHaveBeenCalledOnce();
    expect(transport.release).not.toHaveBeenCalled();
    const projection = adapter.getPublication().clientProjection;
    expect(projection?.kind).toBe("grouped");
    expect(projection?.columns.map((column) => [column.columnId, column.semantics.width])).toEqual([
      ["COL_ID_DESK", 231],
      ["COL_ID_BRUNO_TABLE_ROWS", 96],
      ["COL_ID_PRICE", 287],
    ]);
  });

  it("owns one clean generation across raw, ordered grouped, reordered, and raw projections", () => {
    const transitionColumns = compileColumns([
      {
        columnId: "COL_ID_REGION",
        field: "region",
        headerName: "Region",
        valueType: "text",
        groupBy: true,
      },
      {
        columnId: "COL_ID_DESK",
        field: "desk",
        headerName: "Desk",
        valueType: "text",
        groupBy: true,
      },
      {
        columnId: "COL_ID_PRICE",
        field: "price",
        headerName: "Price",
        valueType: "number",
        aggFunc: "max",
      },
    ]);
    const transport = makeViewport<Record<string, unknown>>();
    const adapter = new BrunoTableServerRowPipelineAdapter<Record<string, unknown>>(
      transitionColumns,
      undefined,
      [],
      [{ columnId: "COL_ID_REGION", direction: "asc" }],
      ["region", "desk", "price"],
    );
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect: ["region", "desk", "price"],
      totalRows: 1,
      version: 1,
      status: "ready",
    });
    const replace = (groupBy: readonly string[], groupOrderBy: typeof query.orderBy): void =>
      adapter.replace(transport.viewport, {
        ...query,
        orderBy: [{ columnId: "COL_ID_REGION", direction: "asc" }],
        groupBy,
        groupOrderBy,
      });

    replace([], []);
    const rawSink = transport.getRequest()!.sink;
    rawSink.setRowCount(1, true);
    rawSink.setRowData({ 0: { region: "EMEA", desk: "Rates", price: 10 } }, { 0: "raw-1" });
    expect(adapter.getPublication().rowSpace?.getRowId(0)).toBe("raw-1");

    replace(["COL_ID_REGION"], [{ columnId: "COL_ID_REGION", direction: "asc" }]);
    const singleSink = transport.getRequest()!.sink;
    expect(adapter.getPublication().rowSpace?.loadedRows).toBe(0);
    expect(adapter.getPublication().clientProjection).toMatchObject({
      groupBy: ["COL_ID_REGION"],
    });

    replace(["COL_ID_REGION", "COL_ID_DESK"], [{ columnId: "COL_ID_REGION", direction: "asc" }]);
    const multiSink = transport.getRequest()!.sink;
    replace(["COL_ID_DESK", "COL_ID_REGION"], [{ columnId: "COL_ID_DESK", direction: "asc" }]);
    const reorderedSink = transport.getRequest()!.sink;
    replace(["COL_ID_DESK"], [{ columnId: "COL_ID_DESK", direction: "asc" }]);
    const finalGroupedSink = transport.getRequest()!.sink;
    replace([], []);

    expect(transport.replace).toHaveBeenCalledTimes(6);
    expect(transport.release).toHaveBeenCalledTimes(5);
    expect(adapter.getPublication().clientProjection).toBeNull();
    expect(adapter.getPublication().rowSpace?.loadedRows).toBe(0);

    for (const [index, releasedSink] of [
      rawSink,
      singleSink,
      multiSink,
      reorderedSink,
      finalGroupedSink,
    ].entries()) {
      releasedSink.setRowCount(1, true);
      releasedSink.setRowData(
        { 0: { region: `LATE-${String(index)}` } },
        { 0: `late-${String(index)}` },
      );
    }
    expect(adapter.getPublication().rowSpace?.loadedRows).toBe(0);
  });

  it("replaces one generation when ordered Group Column Identities reorder over one field", () => {
    const sameFieldColumns = compileColumns([
      {
        columnId: "COL_ID_DESK_PRIMARY",
        field: "desk",
        headerName: "Primary desk",
        valueType: "text",
        groupBy: true,
      },
      {
        columnId: "COL_ID_DESK_SECONDARY",
        field: "desk",
        headerName: "Secondary desk",
        valueType: "text",
        groupBy: true,
      },
    ]);
    const transport = makeViewport<Record<string, unknown>>();
    const adapter = new BrunoTableServerRowPipelineAdapter<Record<string, unknown>>(
      sameFieldColumns,
      undefined,
      [],
      [{ columnId: "COL_ID_DESK_PRIMARY", direction: "asc" }],
      ["desk"],
    );
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect: ["desk"],
      totalRows: 1,
      version: 1,
      status: "ready",
    });
    adapter.replace(transport.viewport, {
      ...query,
      orderBy: [{ columnId: "COL_ID_DESK_PRIMARY", direction: "asc" }],
      groupBy: ["COL_ID_DESK_PRIMARY", "COL_ID_DESK_SECONDARY"],
      groupOrderBy: [{ columnId: "COL_ID_DESK_PRIMARY", direction: "asc" }],
      navigationMode: "projection-reset",
    });
    const firstQuery = transport.getRequest()!.query;
    adapter.replace(transport.viewport, {
      ...query,
      orderBy: [{ columnId: "COL_ID_DESK_PRIMARY", direction: "asc" }],
      groupBy: ["COL_ID_DESK_SECONDARY", "COL_ID_DESK_PRIMARY"],
      groupOrderBy: [{ columnId: "COL_ID_DESK_SECONDARY", direction: "asc" }],
      navigationMode: "projection-reset",
    });

    expect(transport.getRequest()!.query).toEqual(firstQuery);
    expect(transport.replace).toHaveBeenCalledTimes(2);
    expect(transport.release).toHaveBeenCalledOnce();
    expect(adapter.getPublication().clientProjection).toMatchObject({
      groupBy: ["COL_ID_DESK_SECONDARY", "COL_ID_DESK_PRIMARY"],
      queryNavigationMode: "projection-reset",
    });
  });

  it("replaces one generation when grouped-sort Column Identity changes over one field", () => {
    const sameFieldColumns = compileColumns([
      {
        columnId: "COL_ID_DESK_PRIMARY",
        field: "desk",
        headerName: "Primary desk",
        valueType: "text",
        groupBy: true,
      },
      {
        columnId: "COL_ID_DESK_SECONDARY",
        field: "desk",
        headerName: "Secondary desk",
        valueType: "text",
        groupBy: true,
      },
    ]);
    const transport = makeViewport<Record<string, unknown>>();
    const adapter = new BrunoTableServerRowPipelineAdapter<Record<string, unknown>>(
      sameFieldColumns,
      undefined,
      [],
      [{ columnId: "COL_ID_DESK_PRIMARY", direction: "asc" }],
      ["desk"],
    );
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect: ["desk"],
      totalRows: 2,
      version: 1,
      status: "ready",
    });
    const grouped = {
      ...query,
      orderBy: [{ columnId: "COL_ID_DESK_PRIMARY", direction: "asc" as const }],
      groupBy: ["COL_ID_DESK_PRIMARY", "COL_ID_DESK_SECONDARY"],
      navigationMode: "reset" as const,
    };
    adapter.replace(transport.viewport, {
      ...grouped,
      groupOrderBy: [{ columnId: "COL_ID_DESK_PRIMARY", direction: "asc" }],
    });
    const firstRequest = transport.getRequest()!;
    const firstQuery = firstRequest.query;
    const rowsAlias = Object.entries(
      (firstQuery as { aggregates: Record<string, { aggFunc: string }> }).aggregates,
    ).find(([, aggregate]) => aggregate.aggFunc === "count")![0];
    firstRequest.sink.setRowCount(1, true);
    firstRequest.sink.setRowData({ 0: { desk: "Rates", [rowsAlias]: 1n } }, { 0: "rates" });

    adapter.replace(transport.viewport, {
      ...grouped,
      generation: 1,
      groupOrderBy: [{ columnId: "COL_ID_DESK_SECONDARY", direction: "asc" }],
    });

    expect(transport.getRequest()!.query).toEqual(firstQuery);
    expect(transport.replace).toHaveBeenCalledTimes(2);
    expect(transport.release).toHaveBeenCalledOnce();
    expect(adapter.getPublication().rowSpace?.loadedRows).toBe(0);
    expect(adapter.getStructureSnapshot().navigationMode).toBe("reset");
    firstRequest.sink.setRowData({ 0: { desk: "LATE", [rowsAlias]: 1n } }, { 0: "late" });
    expect(adapter.getPublication().rowSpace?.loadedRows).toBe(0);
  });

  it("snapshots one source field once for duplicate Group Column Identities", () => {
    const sameFieldColumns = compileColumns([
      {
        columnId: "COL_ID_DESK_PRIMARY",
        field: "desk",
        headerName: "Primary desk",
        valueType: "text",
        groupBy: true,
      },
      {
        columnId: "COL_ID_DESK_SECONDARY",
        field: "desk",
        headerName: "Secondary desk",
        valueType: "text",
        groupBy: true,
      },
    ]);
    const transport = makeViewport<Record<string, unknown>>();
    const adapter = new BrunoTableServerRowPipelineAdapter<Record<string, unknown>>(
      sameFieldColumns,
      undefined,
      [],
      [{ columnId: "COL_ID_DESK_PRIMARY", direction: "asc" }],
      ["desk"],
    );
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect: ["desk"],
      totalRows: 1,
      version: 1,
      status: "ready",
    });
    adapter.replace(transport.viewport, {
      ...query,
      orderBy: [{ columnId: "COL_ID_DESK_PRIMARY", direction: "asc" }],
      groupBy: ["COL_ID_DESK_PRIMARY", "COL_ID_DESK_SECONDARY"],
      groupOrderBy: [{ columnId: "COL_ID_DESK_PRIMARY", direction: "asc" }],
    });
    const request = transport.getRequest()!;
    const rowsAlias = Object.entries(
      (request.query as { aggregates: Record<string, { aggFunc: string }> }).aggregates,
    ).find(([, aggregate]) => aggregate.aggFunc === "count")![0];
    let reads = 0;
    const result = { [rowsAlias]: 1n } as Record<string, unknown>;
    Object.defineProperty(result, "desk", {
      enumerable: true,
      get: () => (reads++ === 0 ? "SNAPSHOT" : "DRIFTED"),
    });

    request.sink.setRowData({ 0: result }, { 0: "group" });

    expect(reads).toBe(1);
    expect(adapter.getPublication().rowSpace?.getCellValue("group", "COL_ID_DESK_PRIMARY")).toBe(
      "SNAPSHOT",
    );
    expect(adapter.getPublication().rowSpace?.getCellValue("group", "COL_ID_DESK_SECONDARY")).toBe(
      "SNAPSHOT",
    );
  });

  it("keeps the newest reentrant grouped delivery", () => {
    const groupedColumns = compileColumns([
      {
        columnId: "COL_ID_DESK",
        field: "desk",
        headerName: "Desk",
        valueType: "text",
        groupBy: true,
      },
    ]);
    const transport = makeViewport<Record<string, unknown>>();
    const adapter = new BrunoTableServerRowPipelineAdapter<Record<string, unknown>>(
      groupedColumns,
      undefined,
      [],
      [{ columnId: "COL_ID_DESK", direction: "asc" }],
      ["desk"],
    );
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect: ["desk"],
      totalRows: 1,
      version: 1,
      status: "ready",
    });
    adapter.replace(transport.viewport, {
      ...query,
      orderBy: [{ columnId: "COL_ID_DESK", direction: "asc" }],
      groupBy: ["COL_ID_DESK"],
      groupOrderBy: [{ columnId: "COL_ID_DESK", direction: "asc" }],
    });
    const request = transport.getRequest()!;
    const rowsAlias = Object.entries(
      (request.query as { aggregates: Record<string, { aggFunc: string }> }).aggregates,
    ).find(([, aggregate]) => aggregate.aggFunc === "count")![0];
    request.sink.setRowCount(1, true);
    let nested = false;
    const older = { [rowsAlias]: 1n } as Record<string, unknown>;
    Object.defineProperty(older, "desk", {
      enumerable: true,
      get: () => {
        if (!nested) {
          nested = true;
          request.sink.setRowData({ 0: { desk: "NEWEST", [rowsAlias]: 1n } }, { 0: "group" });
        }
        return "OLDER";
      },
    });

    expect(() => request.sink.setRowData({ 0: older }, { 0: "group" })).not.toThrow();
    expect(adapter.getPublication().rowSpace?.getCellValue("group", "COL_ID_DESK")).toBe("NEWEST");

    nested = false;
    const olderKeys = {} as Record<number, string>;
    Object.defineProperty(olderKeys, "0", {
      enumerable: true,
      get: () => {
        if (!nested) {
          nested = true;
          request.sink.setRowData(
            { 0: { desk: "NEWEST-SNAPSHOT", [rowsAlias]: 1n } },
            { 0: "group" },
          );
        }
        return "group";
      },
    });
    expect(() =>
      request.sink.setRowData({ 0: { desk: "OLDER-SNAPSHOT", [rowsAlias]: 1n } }, olderKeys),
    ).not.toThrow();
    expect(adapter.getPublication().rowSpace?.getCellValue("group", "COL_ID_DESK")).toBe(
      "NEWEST-SNAPSHOT",
    );

    nested = false;
    const supersededInvalid = { [rowsAlias]: 1n } as Record<string, unknown>;
    Object.defineProperty(supersededInvalid, "desk", {
      enumerable: true,
      get: () => {
        if (!nested) {
          nested = true;
          request.sink.setRowData({ 0: { desk: "NEWEST-VALID", [rowsAlias]: 1n } }, { 0: "group" });
        }
        return 42;
      },
    });
    expect(() => request.sink.setRowData({ 0: supersededInvalid }, { 0: "group" })).not.toThrow();
    expect(adapter.getPublication().invalid).toBeUndefined();
    expect(adapter.getPublication().rowSpace?.getCellValue("group", "COL_ID_DESK")).toBe(
      "NEWEST-VALID",
    );
  });

  it("discards grouped admission superseded by a reentrant authoritative count", () => {
    type Token = Readonly<{ readonly id: number; readonly label: string }>;
    let reenterCount = false;
    let decodeFailureCount: number | undefined;
    let sink:
      | Readonly<{
          readonly setRowCount: (count: number, keepRenderedRows?: boolean) => void;
        }>
      | undefined;
    const tokenType = {
      codecId: "test/reentrant-count-token",
      codecVersion: 1,
      filterFamily: "equality" as const,
      editorFamily: "text" as const,
      cellAlign: "start" as const,
      editorLayout: "inline" as const,
      defaultWidth: 120,
      decodeRuntime: (input: unknown) => {
        if (typeof input === "object" && input !== null && "failAfterCount" in input) {
          const count = decodeFailureCount;
          decodeFailureCount = undefined;
          if (count !== undefined) sink?.setRowCount(count, true);
          return { _tag: "Failure", message: "Expected token." } as const;
        }
        return typeof input === "object" && input !== null && "id" in input && "label" in input
          ? ({ _tag: "Success", value: input as Token } as const)
          : ({ _tag: "Failure", message: "Expected token." } as const);
      },
      equivalent: (left: Token, right: Token) => {
        if (reenterCount) {
          reenterCount = false;
          sink?.setRowCount(1, true);
        }
        return left.id === right.id;
      },
      compare: (left: Token, right: Token) => left.id - right.id,
      formatCanonicalText: (value: Token) => String(value.id),
      parseCanonicalText: (text: string) =>
        ({ _tag: "Success", value: { id: Number(text), label: text } }) as const,
      formatDisplay: (value: Token) => value.label,
      encodePersisted: (value: Token) => ({ id: value.id, label: value.label }),
      decodePersisted: (input: unknown) =>
        typeof input === "object" && input !== null && "id" in input && "label" in input
          ? ({ _tag: "Success", value: input as Token } as const)
          : ({ _tag: "Failure", message: "Expected token." } as const),
    };
    const groupedColumns = compileColumns([
      {
        columnId: "COL_ID_KEY",
        field: "key",
        headerName: "Key",
        valueType: tokenType,
        groupBy: true,
      },
    ] as never);
    const transport = makeViewport<Record<string, unknown>>();
    const adapter = new BrunoTableServerRowPipelineAdapter<Record<string, unknown>>(
      groupedColumns,
      undefined,
      [],
      [{ columnId: "COL_ID_KEY", direction: "asc" }],
      ["key"],
    );
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect: ["key"],
      totalRows: 2,
      version: 1,
      status: "ready",
    });
    adapter.replace(transport.viewport, {
      ...query,
      orderBy: [{ columnId: "COL_ID_KEY", direction: "asc" }],
      groupBy: ["COL_ID_KEY"],
      groupOrderBy: [{ columnId: "COL_ID_KEY", direction: "asc" }],
    });
    const request = transport.getRequest()!;
    sink = request.sink;
    const rowsAlias = Object.entries(
      (request.query as { aggregates: Record<string, { aggFunc: string }> }).aggregates,
    ).find(([, aggregate]) => aggregate.aggFunc === "count")![0];
    request.sink.setRowCount(2, true);
    request.sink.setRowData(
      {
        0: { key: { id: 1, label: "ONE" }, [rowsAlias]: 1n },
        1: { key: { id: 2, label: "TWO" }, [rowsAlias]: 1n },
      },
      { 0: "one", 1: "two" },
    );

    reenterCount = true;
    expect(() =>
      request.sink.setRowData(
        { 0: { key: { id: 99, label: "OUTER" }, [rowsAlias]: 1n } },
        { 0: "one" },
      ),
    ).not.toThrow();

    expect(adapter.getPublication().invalid).toBeUndefined();
    expect(adapter.getPublication().rowSpace?.totalRows).toBe(1);
    expect(
      (adapter.getPublication().rowSpace?.getCellValue("one", "COL_ID_KEY") as Token | undefined)
        ?.label,
    ).toBe("ONE");
    request.sink.setRowCount(2, true);
    expect(adapter.getPublication().rowSpace?.getRowId(1)).toBeUndefined();

    request.sink.setRowData({ 1: { key: { id: 2, label: "TWO" }, [rowsAlias]: 1n } }, { 1: "two" });
    decodeFailureCount = 1;
    expect(() =>
      request.sink.setRowData(
        { 1: { key: { failAfterCount: true }, [rowsAlias]: 1n } },
        { 1: "two" },
      ),
    ).not.toThrow();
    expect(adapter.getPublication().invalid).toBeUndefined();
    expect(adapter.getPublication().rowSpace?.totalRows).toBe(1);
    expect(adapter.getPublication().rowSpace?.getRowId(1)).toBeUndefined();

    decodeFailureCount = 1;
    request.sink.setRowData(
      { 0: { key: { failAfterCount: true }, [rowsAlias]: 1n } },
      { 0: "one" },
    );
    expect(adapter.getPublication().invalid).toMatchObject({
      kind: "invalid-value",
      rowIndex: 0,
      columnId: "COL_ID_KEY",
    });
    request.sink.setRowData({ 0: { key: { id: 1, label: "ONE" }, [rowsAlias]: 1n } }, { 0: "one" });
    expect(adapter.getPublication().invalid).toBeUndefined();
  });

  it("retains one grouped generation across definition-only aggregate reorder", () => {
    const initialColumns = compileColumns([
      {
        columnId: "COL_ID_DESK",
        field: "desk",
        headerName: "Desk",
        valueType: "text",
        groupBy: true,
      },
      {
        columnId: "COL_ID_MIN_PRICE",
        field: "price",
        headerName: "Minimum",
        valueType: "number",
        aggFunc: "min",
      },
      {
        columnId: "COL_ID_MAX_PRICE",
        field: "price",
        headerName: "Maximum",
        valueType: "number",
        aggFunc: "max",
      },
    ]);
    const reorderedColumns = Object.freeze([
      initialColumns[2]!,
      initialColumns[0]!,
      initialColumns[1]!,
    ]);
    const transport = makeViewport<Record<string, unknown>>();
    const adapter = new BrunoTableServerRowPipelineAdapter<Record<string, unknown>>(
      initialColumns,
      undefined,
      [],
      [{ columnId: "COL_ID_DESK", direction: "asc" }],
      ["desk", "price"],
    );
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect: ["desk", "price"],
      totalRows: 1,
      version: 1,
      status: "ready",
    });
    const groupedQuery = {
      ...query,
      orderBy: [{ columnId: "COL_ID_DESK", direction: "asc" as const }],
      groupBy: ["COL_ID_DESK"],
      groupOrderBy: [{ columnId: "COL_ID_MAX_PRICE", direction: "desc" as const }],
    };
    const inputs = {
      routeBy: undefined,
      externalFilters: undefined,
      visibleColumnIds: ["COL_ID_DESK", "COL_ID_MIN_PRICE", "COL_ID_MAX_PRICE"],
    };
    adapter.replace(transport.viewport, groupedQuery, inputs);
    const request = transport.getRequest()!;
    const aggregateQuery = (request.query as { aggregates: Record<string, { aggFunc: string }> })
      .aggregates;
    const rowsAlias = Object.entries(aggregateQuery).find(
      ([, aggregate]) => aggregate.aggFunc === "count",
    )![0];
    const minAlias = Object.entries(aggregateQuery).find(
      ([, aggregate]) => aggregate.aggFunc === "min",
    )![0];
    const maxAlias = Object.entries(aggregateQuery).find(
      ([, aggregate]) => aggregate.aggFunc === "max",
    )![0];
    request.sink.setRowCount(1, true);
    request.sink.setRowData(
      { 0: { desk: "Rates", [rowsAlias]: 2n, [minAlias]: 10, [maxAlias]: 20 } },
      { 0: "rates" },
    );
    const before = adapter.getPublication();
    const retainedRow = before.rowSpace?.getRow("rates");
    const structureNotification = vi.fn();
    const unsubscribe = adapter.subscribeStructure(structureNotification);

    adapter.reconcileColumns(reorderedColumns, undefined);
    adapter.replace(transport.viewport, groupedQuery, inputs);

    expect(transport.getRequest()!.query).toEqual(request.query);
    expect(transport.replace).toHaveBeenCalledOnce();
    expect(transport.release).not.toHaveBeenCalled();
    expect(adapter.getPublication().clientProjection?.queryGeneration).toBe(
      before.clientProjection?.queryGeneration,
    );
    expect(adapter.getPublication().rowSpace?.getRow("rates")).toBe(retainedRow);
    expect(structureNotification).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("starts a clean grouped generation when decoder authority changes under one source query", () => {
    type DecodedDesk = Readonly<{ readonly raw: string; readonly revision: "old" | "new" }>;
    const valueType = (revision: DecodedDesk["revision"]) => ({
      codecId: "test/grouped-decoder",
      codecVersion: 1,
      filterFamily: "equality" as const,
      editorFamily: "text" as const,
      cellAlign: "start" as const,
      editorLayout: "inline" as const,
      defaultWidth: 120,
      decodeRuntime: (input: unknown) =>
        typeof input === "string"
          ? ({ _tag: "Success", value: { raw: input, revision } satisfies DecodedDesk } as const)
          : ({ _tag: "Failure", message: "Expected desk text." } as const),
      equivalent: (left: DecodedDesk, right: DecodedDesk) =>
        left.raw === right.raw && left.revision === right.revision,
      compare: (left: DecodedDesk, right: DecodedDesk) => left.raw.localeCompare(right.raw),
      formatCanonicalText: (value: DecodedDesk) => value.raw,
      parseCanonicalText: (text: string) =>
        ({ _tag: "Success", value: { raw: text, revision } satisfies DecodedDesk }) as const,
      formatDisplay: (value: DecodedDesk) => `${value.revision}:${value.raw}`,
      encodePersisted: (value: DecodedDesk) => value.raw,
      decodePersisted: (input: unknown) =>
        typeof input === "string"
          ? ({ _tag: "Success", value: { raw: input, revision } satisfies DecodedDesk } as const)
          : ({ _tag: "Failure", message: "Expected persisted desk text." } as const),
    });
    const createColumns = (revision: DecodedDesk["revision"]) =>
      compileColumns([
        {
          columnId: "COL_ID_DESK",
          field: "desk",
          headerName: "Desk",
          valueType: valueType(revision),
          groupBy: true,
        },
      ] as never);
    const initialColumns = createColumns("old");
    const transport = makeViewport<Record<string, unknown>>();
    const adapter = new BrunoTableServerRowPipelineAdapter<Record<string, unknown>>(
      initialColumns,
      undefined,
      [],
      [{ columnId: "COL_ID_DESK", direction: "asc" }],
      ["desk"],
    );
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect: ["desk"],
      totalRows: 1,
      version: 1,
      status: "ready",
    });
    const groupedQuery = {
      ...query,
      orderBy: [{ columnId: "COL_ID_DESK", direction: "asc" as const }],
      groupBy: ["COL_ID_DESK"],
      groupOrderBy: [{ columnId: "COL_ID_DESK", direction: "asc" as const }],
    };
    adapter.replace(transport.viewport, groupedQuery);
    const firstRequest = transport.getRequest()!;
    const rowsAlias = Object.entries(
      (firstRequest.query as { aggregates: Record<string, { aggFunc: string }> }).aggregates,
    ).find(([, aggregate]) => aggregate.aggFunc === "count")![0];
    firstRequest.sink.setRowCount(1, true);
    firstRequest.sink.setRowData({ 0: { desk: "Rates", [rowsAlias]: 1n } }, { 0: "rates" });
    expect(adapter.getPublication().rowSpace?.getCellValue("rates", "COL_ID_DESK")).toEqual({
      raw: "Rates",
      revision: "old",
    });

    const nextColumns = createColumns("new");
    adapter.reconcileColumns(nextColumns, undefined);
    adapter.replace(transport.viewport, groupedQuery);
    expect(transport.replace).toHaveBeenCalledTimes(2);
    expect(transport.release).toHaveBeenCalledOnce();
    expect(adapter.getPublication().rowSpace?.loadedRows).toBe(0);
    firstRequest.sink.setRowData({ 0: { desk: "LATE", [rowsAlias]: 1n } }, { 0: "late" });
    expect(adapter.getPublication().rowSpace?.getRow("late")).toBeUndefined();

    transport
      .getRequest()!
      .sink.setRowData({ 0: { desk: "Rates", [rowsAlias]: 1n } }, { 0: "rates" });
    expect(adapter.getPublication().rowSpace?.getCellValue("rates", "COL_ID_DESK")).toEqual({
      raw: "Rates",
      revision: "new",
    });
  });

  it.each(["groupKey", "aggregate"] as const)(
    "starts a clean grouped generation when %s retention semantics change",
    (role) => {
      type Token = Readonly<{ readonly id: number; readonly label: string }>;
      const decodeRuntime = (input: unknown) =>
        typeof input === "object" && input !== null && "id" in input && "label" in input
          ? ({ _tag: "Success", value: input as Token } as const)
          : ({ _tag: "Failure", message: "Expected token." } as const);
      const equivalent = (left: Token, right: Token) => left.id === right.id;
      const formatDisplay = (value: Token) => String(value.id);
      const valueType = (observeLabel: boolean) => ({
        codecId: "test/grouped-retention-authority",
        codecVersion: 1,
        filterFamily: "equality" as const,
        editorFamily: "text" as const,
        cellAlign: "start" as const,
        editorLayout: "inline" as const,
        defaultWidth: 120,
        aggregateResults: { min: "self" as const },
        decodeRuntime,
        equivalent,
        compare: (left: Token, right: Token) =>
          left.id === right.id ? 0 : left.id < right.id ? -1 : 1,
        formatCanonicalText: (value: Token) =>
          observeLabel ? `${String(value.id)}:${value.label}` : String(value.id),
        parseCanonicalText: (text: string) =>
          ({ _tag: "Success", value: { id: Number(text), label: text } }) as const,
        formatDisplay,
        encodePersisted: (value: Token) => ({ id: value.id, label: value.label }),
        decodePersisted: decodeRuntime,
      });
      const createColumns = (observeLabel: boolean) =>
        compileColumns(
          role === "groupKey"
            ? [
                {
                  columnId: "COL_ID_TOKEN",
                  field: "token",
                  headerName: "Token",
                  valueType: valueType(observeLabel),
                  groupBy: true,
                },
              ]
            : [
                {
                  columnId: "COL_ID_GROUP",
                  field: "group",
                  headerName: "Group",
                  valueType: "text",
                  groupBy: true,
                },
                {
                  columnId: "COL_ID_TOKEN",
                  field: "token",
                  headerName: "Token",
                  valueType: valueType(observeLabel),
                  aggFunc: "min",
                },
              ],
        ) as readonly CompiledColumn[];
      const initialColumns = createColumns(false);
      const transport = makeViewport<Record<string, unknown>>();
      const adapter = new BrunoTableServerRowPipelineAdapter<Record<string, unknown>>(
        initialColumns,
        undefined,
        [],
        [{ columnId: role === "groupKey" ? "COL_ID_TOKEN" : "COL_ID_GROUP", direction: "asc" }],
        role === "groupKey" ? ["token"] : ["group", "token"],
      );
      adapter.reconcileSource({
        viewport: transport.viewport,
        completeRawSelect: role === "groupKey" ? ["token"] : ["group", "token"],
        totalRows: 1,
        version: 1,
        status: "ready",
      });
      const groupedQuery = {
        ...query,
        orderBy: [
          {
            columnId: role === "groupKey" ? "COL_ID_TOKEN" : "COL_ID_GROUP",
            direction: "asc" as const,
          },
        ],
        groupBy: [role === "groupKey" ? "COL_ID_TOKEN" : "COL_ID_GROUP"],
        groupOrderBy: [
          {
            columnId: role === "groupKey" ? "COL_ID_TOKEN" : "COL_ID_GROUP",
            direction: "asc" as const,
          },
        ],
      };
      adapter.replace(transport.viewport, groupedQuery);
      const firstRequest = transport.getRequest()!;
      const aggregateQuery = (
        firstRequest.query as { aggregates: Record<string, { aggFunc: string }> }
      ).aggregates;
      const rowsAlias = Object.entries(aggregateQuery).find(
        ([, aggregate]) => aggregate.aggFunc === "count",
      )![0];
      const tokenAlias = Object.entries(aggregateQuery).find(
        ([, aggregate]) => aggregate.aggFunc === "min",
      )?.[0];
      const oldToken = { id: 1, label: "OLD" } as const;
      const newToken = { id: 1, label: "NEW" } as const;
      const delivery = (token: Token) =>
        role === "groupKey"
          ? { token, [rowsAlias]: 1n }
          : { group: "Rates", [rowsAlias]: 1n, [tokenAlias!]: token };
      firstRequest.sink.setRowCount(1, true);
      firstRequest.sink.setRowData({ 0: delivery(oldToken) }, { 0: "rates" });
      firstRequest.sink.setRowData({ 0: delivery(newToken) }, { 0: "rates" });
      expect(adapter.getPublication().rowSpace?.getCellValue("rates", "COL_ID_TOKEN")).toBe(
        oldToken,
      );

      adapter.reconcileColumns(createColumns(true), undefined);
      adapter.replace(transport.viewport, groupedQuery);
      expect(transport.replace).toHaveBeenCalledTimes(2);
      expect(transport.release).toHaveBeenCalledOnce();
      expect(adapter.getPublication().rowSpace?.loadedRows).toBe(0);
      transport.getRequest()!.sink.setRowData({ 0: delivery(newToken) }, { 0: "rates" });
      expect(adapter.getPublication().rowSpace?.getCellValue("rates", "COL_ID_TOKEN")).toBe(
        newToken,
      );
    },
  );

  it("preserves exact bigint, optional, and Effect BigDecimal grouped result domains", () => {
    const optionalNumberValueType = {
      codecId: "test/optional-number",
      codecVersion: 1,
      filterFamily: "numeric" as const,
      editorFamily: "number" as const,
      cellAlign: "end" as const,
      editorLayout: "inline" as const,
      defaultWidth: 120,
      aggregateResults: { min: "self" as const },
      decodeRuntime: (input: unknown) =>
        typeof input === "number" && Number.isFinite(input)
          ? ({ _tag: "Success", value: input } as const)
          : ({ _tag: "Failure", message: "Expected a number." } as const),
      equivalent: (left: number, right: number) => left === right,
      compare: (left: number, right: number) => (left === right ? 0 : left > right ? 1 : -1),
      formatCanonicalText: String,
      parseCanonicalText: (text: string) =>
        Number.isFinite(Number(text))
          ? ({ _tag: "Success", value: Number(text) } as const)
          : ({ _tag: "Failure", message: "Expected a number." } as const),
      formatDisplay: String,
      encodePersisted: (value: number) => value,
      decodePersisted: (input: unknown) =>
        typeof input === "number" && Number.isFinite(input)
          ? ({ _tag: "Success", value: input } as const)
          : ({ _tag: "Failure", message: "Expected a number." } as const),
    } satisfies BrunoTableValueType<number>;
    type ExactRow = Readonly<{
      desk: string | null;
      quantity: bigint;
      amount: BigDecimal.BigDecimal;
      optionalScore: number | null;
    }>;
    const exactColumns = compileColumns([
      {
        columnId: "COL_ID_DESK",
        field: "desk",
        headerName: "Desk",
        valueType: "text",
        groupBy: true,
      },
      {
        columnId: "COL_ID_QUANTITY",
        field: "quantity",
        headerName: "Quantity",
        valueType: "bigint",
        aggFunc: "sum",
      },
      BrunoTableBigDecimalColumn({
        columnId: "COL_ID_AMOUNT",
        field: "amount",
        headerName: "Average amount",
        aggFunc: "avg",
      }),
      {
        columnId: "COL_ID_OPTIONAL_SCORE",
        field: "optionalScore",
        headerName: "Minimum optional score",
        valueType: optionalNumberValueType,
        aggFunc: "min",
      },
    ] satisfies BrunoTableColumns<ExactRow>);
    const transport = makeViewport<Record<string, unknown>>();
    const adapter = new BrunoTableServerRowPipelineAdapter<Record<string, unknown>>(
      exactColumns,
      undefined,
      [],
      [{ columnId: "COL_ID_DESK", direction: "asc" }],
      ["desk", "quantity", "amount", "optionalScore"],
    );
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect: ["desk", "quantity", "amount", "optionalScore"],
      totalRows: 1,
      version: 1,
      status: "ready",
    });
    adapter.replace(transport.viewport, {
      ...query,
      orderBy: [{ columnId: "COL_ID_DESK", direction: "asc" }],
      groupBy: ["COL_ID_DESK"],
      groupOrderBy: [{ columnId: "COL_ID_DESK", direction: "asc" }],
    });
    const request = transport.getRequest()!;
    const groupedQuery = request.query as {
      readonly aggregates: Readonly<Record<string, { readonly aggFunc: string }>>;
    };
    const aliases = Object.keys(groupedQuery.aggregates);
    const rowsAlias = aliases.find((alias) => groupedQuery.aggregates[alias]!.aggFunc === "count")!;
    const quantityAlias = aliases.find(
      (alias) => groupedQuery.aggregates[alias]!.aggFunc === "sum",
    )!;
    const amountAlias = aliases.find((alias) => groupedQuery.aggregates[alias]!.aggFunc === "avg")!;
    const optionalScoreAlias = aliases.find(
      (alias) => groupedQuery.aggregates[alias]!.aggFunc === "min",
    )!;
    const amount = BigDecimal.fromStringUnsafe("12.3400");
    const validDelivery = {
      desk: null,
      [rowsAlias]: 2n,
      [quantityAlias]: 9007199254740993n,
      [amountAlias]: amount,
      [optionalScoreAlias]: null,
    };
    request.sink.setRowCount(1, true);
    request.sink.setRowData({ 0: validDelivery }, { 0: "exact-group" });

    const rowSpace = adapter.getPublication().rowSpace!;
    const coherentRow = rowSpace.getRow("exact-group");
    expect(rowSpace.getCellValue("exact-group", "COL_ID_DESK")).toBeNull();
    expect(rowSpace.getCellValue("exact-group", "COL_ID_QUANTITY")).toBe(9007199254740993n);
    const admittedAmount = rowSpace.getCellValue("exact-group", "COL_ID_AMOUNT");
    expect(BigDecimal.isBigDecimal(admittedAmount)).toBe(true);
    expect(BigDecimal.format(admittedAmount as BigDecimal.BigDecimal)).toBe("12.34");
    expect(rowSpace.getCellValue("exact-group", "COL_ID_OPTIONAL_SCORE")).toBeNull();

    for (const [alias, columnId] of [
      [quantityAlias, "COL_ID_QUANTITY"],
      [amountAlias, "COL_ID_AMOUNT"],
    ] as const) {
      for (const invalid of [null, undefined]) {
        expect(() =>
          request.sink.setRowData(
            { 0: { ...validDelivery, [alias]: invalid } },
            { 0: "exact-group" },
          ),
        ).not.toThrow();
        expect(adapter.getPublication().invalid).toMatchObject({
          kind: "invalid-value",
          rowIndex: 0,
          columnId,
        });
        expect(adapter.getPublication().rowSpace?.getRow("exact-group")).toBe(coherentRow);
        request.sink.setRowData({ 0: validDelivery }, { 0: "exact-group" });
        expect(adapter.getPublication().invalid).toBeUndefined();
      }
    }
  });

  it("contains throwing grouped accessors as deterministic invalid deliveries", () => {
    const groupedColumns = compileColumns([
      {
        columnId: "COL_ID_DESK",
        field: "desk",
        headerName: "Desk",
        valueType: "text",
        groupBy: true,
      },
      {
        columnId: "COL_ID_QUANTITY",
        field: "quantity",
        headerName: "Quantity",
        valueType: "bigint",
        aggFunc: "sum",
      },
    ]);
    const transport = makeViewport<Record<string, unknown>>();
    const adapter = new BrunoTableServerRowPipelineAdapter<Record<string, unknown>>(
      groupedColumns,
      undefined,
      [],
      [{ columnId: "COL_ID_DESK", direction: "asc" }],
      ["desk", "quantity"],
    );
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect: ["desk", "quantity"],
      totalRows: 1,
      version: 1,
      status: "ready",
    });
    adapter.replace(transport.viewport, {
      ...query,
      orderBy: [{ columnId: "COL_ID_DESK", direction: "asc" }],
      groupBy: ["COL_ID_DESK"],
      groupOrderBy: [{ columnId: "COL_ID_DESK", direction: "asc" }],
    });
    const request = transport.getRequest()!;
    const aggregates = (request.query as { aggregates: Record<string, { aggFunc: string }> })
      .aggregates;
    const rowsAlias = Object.entries(aggregates).find(
      ([, aggregate]) => aggregate.aggFunc === "count",
    )![0];
    const quantityAlias = Object.entries(aggregates).find(
      ([, aggregate]) => aggregate.aggFunc === "sum",
    )![0];
    const valid = { desk: "Rates", [rowsAlias]: 2n, [quantityAlias]: 3n };
    request.sink.setRowCount(1, true);
    request.sink.setRowData({ 0: valid }, { 0: "rates" });
    const coherentRow = adapter.getPublication().rowSpace?.getRow("rates");

    for (const [field, columnId] of [
      ["desk", "COL_ID_DESK"],
      [rowsAlias, "COL_ID_BRUNO_TABLE_ROWS"],
      [quantityAlias, "COL_ID_QUANTITY"],
    ] as const) {
      const throwing = { ...valid };
      Object.defineProperty(throwing, field, {
        enumerable: true,
        get: () => {
          throw new Error("hostile grouped accessor");
        },
      });
      expect(() => request.sink.setRowData({ 0: throwing }, { 0: "rates" })).not.toThrow();
      expect(adapter.getPublication().invalid).toMatchObject({
        kind: "invalid-value",
        rowIndex: 0,
        columnId,
      });
      expect(adapter.getPublication().rowSpace?.getRow("rates")).toBe(coherentRow);
      request.sink.setRowData({ 0: valid }, { 0: "rates" });
      expect(adapter.getPublication().invalid).toBeUndefined();
    }
  });

  it("keeps bigint semantic keys distinct from numeric-looking strings", () => {
    expect(brunoTableTestSemanticQueryKey({ filter: 1n })).not.toBe(
      brunoTableTestSemanticQueryKey({ filter: "1n" }),
    );
  });

  it("owns semantic replacement and keeps window movement inside one generation", () => {
    const transport = makeViewport();
    const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      columns,
      ["symbol"],
      [],
      query.orderBy,
    );
    const publish = vi.fn();
    adapter.subscribePublication(publish);
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect,
      totalRows: 100,
      version: 1,
      status: "ready",
    });
    adapter.replace(transport.viewport, query);
    expect(transport.replace).toHaveBeenCalledTimes(1);
    expect(transport.getRequest()?.query).toEqual({
      select: ["symbol", "price"],
      where: [],
      orderBy: [{ field: "symbol", direction: "asc" }],
    });
    const firstPublication = adapter.getPublication();
    expect(firstPublication.rowSpace?.totalRows).toBe(18);
    expect(firstPublication.rowSpace?.loadedRows).toBe(0);

    firstPublication.rowSpace?.getRowId(0);
    publish.mockClear();
    adapter.setRequiredRange(10, 30);
    expect(transport.setWindow).toHaveBeenCalledTimes(1);
    expect(transport.setWindow).toHaveBeenLastCalledWith({ firstRow: 10, lastRow: 29 });
    expect(transport.replace).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
  });

  it("uses source-owned semantic identity for exact Route and external operands", () => {
    const transport = makeViewport();
    const stableKey = Object.freeze({});
    transport.semanticKey.mockReturnValue(stableKey);
    const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      columns,
      ["symbol"],
      [],
      query.orderBy,
      completeRawSelect,
    );
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect,
      totalRows: 100,
      version: 1,
      status: "ready",
    });

    adapter.replace(transport.viewport, query, {
      routeBy: { book: 9_007_199_254_740_993n },
      externalFilters: [{ field: "price", type: "equals", filter: 10 }],
      visibleColumnIds: ["COL_ID_SYMBOL", "COL_ID_PRICE"],
    });
    adapter.replace(transport.viewport, query, {
      routeBy: { book: 9_007_199_254_740_993n },
      externalFilters: [{ field: "price", type: "equals", filter: 10 }],
      visibleColumnIds: ["COL_ID_SYMBOL", "COL_ID_PRICE"],
    });

    expect(transport.semanticKey).toHaveBeenCalledTimes(2);
    expect(transport.replace).toHaveBeenCalledTimes(1);
    expect(transport.getRequest()?.query).toEqual({
      routeBy: { book: 9_007_199_254_740_993n },
      select: ["symbol", "price"],
      where: [{ field: "price", type: "equals", filter: 10 }],
      orderBy: [{ field: "symbol", direction: "asc" }],
    });
  });

  it("resets navigation only when prop-owned query inputs change semantically", () => {
    const transport = makeViewport();
    const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      columns,
      undefined,
      [],
      query.orderBy,
      completeRawSelect,
    );
    const reconcileQuery = Object.freeze({ ...query, navigationMode: "reconcile" as const });
    const rates = {
      routeBy: { book: 1n },
      externalFilters: [{ field: "price", type: "equals", filter: 10 }],
      visibleColumnIds: ["COL_ID_SYMBOL", "COL_ID_PRICE"],
    } as const;
    adapter.replace(transport.viewport, reconcileQuery, rates, true);
    adapter.replace(
      transport.viewport,
      { ...reconcileQuery, generation: 1 },
      {
        ...rates,
        externalFilters: [{ field: "price", type: "equals", filter: 20 }],
      },
      true,
    );
    expect(adapter.getStructureSnapshot().navigationMode).toBe("reset");

    adapter.replace(
      transport.viewport,
      {
        ...reconcileQuery,
        generation: 2,
        orderBy: [{ columnId: "COL_ID_SYMBOL", direction: "desc" }],
      },
      {
        ...rates,
        externalFilters: [{ field: "price", type: "equals", filter: 20 }],
      },
      true,
    );
    expect(adapter.getStructureSnapshot().navigationMode).toBe("reconcile");
  });

  it("rejects a malformed replacement viewport before changing the active source", () => {
    const transport = makeViewport();
    const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      columns,
      undefined,
      [],
      query.orderBy,
      completeRawSelect,
    );
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect,
      totalRows: 100,
      version: 1,
      status: "ready",
    });
    adapter.replace(transport.viewport, query);
    transport.getRequest()?.sink.setRowCount(250, true);
    transport.getRequest()?.sink.setRowData({ 0: { symbol: "OLD", price: 1 } }, { 0: "old" });
    const before = adapter.getPublication();

    expect(() =>
      adapter.reconcileSource({
        viewport: Object.freeze({}),
        completeRawSelect,
        totalRows: 7,
        version: 2,
        status: "error",
        message: "replacement",
      }),
    ).toThrow("BrunoTable Server viewportSource.viewport must expose replace().");
    expect(adapter.getPublication()).toBe(before);
    expect(adapter.getPublication().rowSpace?.getRow("old")).toEqual({
      symbol: "OLD",
      price: 1,
    });
    expect(adapter.getResultRowCountSnapshot()).toBe(250);
    expect(transport.release).not.toHaveBeenCalled();
  });

  it("resets navigation for a replacement viewport even when the runtime query reconciles", () => {
    const first = makeViewport();
    const second = makeViewport();
    const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      columns,
      undefined,
      [],
      query.orderBy,
      completeRawSelect,
    );
    const reconcileQuery = Object.freeze({ ...query, navigationMode: "reconcile" as const });

    adapter.reconcileSource({
      viewport: first.viewport,
      completeRawSelect,
      totalRows: 100,
      version: 1,
      status: "ready",
    });
    adapter.replace(first.viewport, reconcileQuery);
    expect(adapter.getStructureSnapshot().navigationMode).toBe("reset");
    expect(adapter.getStructureSnapshot().generation).toBe(1);

    adapter.reconcileSource({
      viewport: second.viewport,
      completeRawSelect,
      totalRows: 100,
      version: 2,
      status: "ready",
    });
    adapter.release();
    expect(adapter.getStructureSnapshot().generation).toBe(1);
    adapter.replace(second.viewport, { ...reconcileQuery, generation: 1 });

    expect(adapter.getStructureSnapshot().navigationMode).toBe("reset");
    expect(adapter.getStructureSnapshot().generation).toBe(2);
  });

  it("forces reset when source-owned or Quick Filter projection changes override reconcile", () => {
    const transport = makeViewport();
    const rawPresentationColumns = compileColumns([
      {
        columnId: "COL_ID_SYMBOL",
        field: "symbol",
        headerName: "Symbol",
        valueType: "text",
        valueFormatter: ({ value }: { readonly value: string }) => value,
      },
      {
        columnId: "COL_ID_PRICE",
        field: "price",
        headerName: "Price",
        valueType: "number",
      },
    ]);
    const sourceProjectionAdapter = new BrunoTableServerRowPipelineAdapter<Row>(
      rawPresentationColumns,
      undefined,
      [],
      query.orderBy,
      completeRawSelect,
    );
    sourceProjectionAdapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect,
      totalRows: 100,
      version: 1,
      status: "ready",
    });
    sourceProjectionAdapter.replace(transport.viewport, query);
    sourceProjectionAdapter.replace(transport.viewport, {
      ...query,
      generation: 1,
      orderBy: [{ columnId: "COL_ID_SYMBOL", direction: "desc" }],
    });
    expect(sourceProjectionAdapter.getStructureSnapshot().navigationMode).toBe("reconcile");

    sourceProjectionAdapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect: ["symbol", "price", "desk"],
      totalRows: 100,
      version: 2,
      status: "ready",
    });
    sourceProjectionAdapter.replace(transport.viewport, {
      ...query,
      generation: 2,
      orderBy: [{ columnId: "COL_ID_SYMBOL", direction: "desc" }],
    });
    expect(sourceProjectionAdapter.getStructureSnapshot().navigationMode).toBe("reset");

    const quickFilterAdapter = new BrunoTableServerRowPipelineAdapter<Row>(
      columns,
      ["symbol"],
      [],
      query.orderBy,
      completeRawSelect,
    );
    const quickQuery = Object.freeze({ ...query, quickFilter: "desk" });
    quickFilterAdapter.replace(transport.viewport, quickQuery);
    quickFilterAdapter.replace(transport.viewport, {
      ...quickQuery,
      generation: 1,
      orderBy: [{ columnId: "COL_ID_SYMBOL", direction: "desc" }],
    });
    expect(quickFilterAdapter.getStructureSnapshot().navigationMode).toBe("reconcile");

    quickFilterAdapter.reconcileColumns(columns, ["symbol", "desk"]);
    quickFilterAdapter.replace(transport.viewport, {
      ...quickQuery,
      generation: 2,
      orderBy: [{ columnId: "COL_ID_SYMBOL", direction: "desc" }],
    });
    expect(quickFilterAdapter.getStructureSnapshot().navigationMode).toBe("reset");
  });

  it("rejects missing or malformed complete projection authority without mutating the active source", () => {
    const first = makeViewport();
    const second = makeViewport();
    const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      columns,
      undefined,
      [],
      query.orderBy,
      completeRawSelect,
    );
    adapter.reconcileSource({
      viewport: first.viewport,
      completeRawSelect,
      totalRows: 100,
      version: 1,
      status: "ready",
    });
    adapter.replace(first.viewport, query);
    first.getRequest()!.sink.setRowData({ 0: { symbol: "OLD", price: 1 } }, { 0: "old" });
    const coherentPublication = adapter.getPublication();
    const sparseCompleteRawSelect: unknown[] = ["symbol", "price"];
    sparseCompleteRawSelect.length = 3;

    for (const invalidSource of [
      {
        viewport: second.viewport,
        totalRows: 200,
        version: 2,
        status: "ready",
      },
      {
        viewport: second.viewport,
        completeRawSelect: ["symbol", "symbol"],
        totalRows: 200,
        version: 2,
        status: "ready",
      },
      {
        viewport: second.viewport,
        completeRawSelect: sparseCompleteRawSelect,
        totalRows: 200,
        version: 2,
        status: "ready",
      },
    ]) {
      expect(() =>
        adapter.reconcileSource(
          invalidSource as unknown as Parameters<typeof adapter.reconcileSource>[0],
        ),
      ).toThrowError(
        "BrunoTable Server viewportSource.completeRawSelect must be a non-empty unique source field tuple.",
      );
      expect(adapter.getPublication()).toBe(coherentPublication);
      expect(adapter.getPublication().rowSpace?.getRow("old")).toEqual({
        symbol: "OLD",
        price: 1,
      });
      expect(first.release).not.toHaveBeenCalled();
      expect(second.replace).not.toHaveBeenCalled();
    }

    adapter.reconcileSource({
      viewport: second.viewport,
      completeRawSelect,
      totalRows: 200,
      version: 2,
      status: "ready",
    });
    adapter.replace(second.viewport, { ...query, generation: 1 });
    expect(first.release).toHaveBeenCalledTimes(1);
    expect(second.replace).toHaveBeenCalledTimes(1);
  });

  it("reconciles Quick Filter projection fields and replaces only their semantic change", () => {
    const transport = makeViewport();
    const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      columns,
      ["symbol"],
      [],
      query.orderBy,
    );
    const quickQuery = { ...query, quickFilter: "desk" };
    adapter.replace(transport.viewport, quickQuery);

    adapter.reconcileColumns(columns, ["symbol", "desk"]);
    adapter.replace(transport.viewport, { ...quickQuery, generation: 1 });

    expect(transport.replace).toHaveBeenCalledTimes(2);
    expect(transport.getRequest()?.query).toEqual({
      select: ["symbol", "price", "desk"],
      where: [
        {
          type: "OR",
          conditions: [
            { field: "desk", type: "contains", filter: "desk" },
            { field: "symbol", type: "contains", filter: "desk" },
          ],
        },
      ],
      orderBy: [{ field: "symbol", direction: "asc" }],
    });
  });

  it("keeps one generation when Quick Filter fields are only reordered", () => {
    const transport = makeViewport();
    const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      columns,
      ["symbol", "desk"],
      [],
      query.orderBy,
    );
    const quickQuery = { ...query, quickFilter: "desk" };
    adapter.replace(transport.viewport, quickQuery);

    adapter.reconcileColumns(columns, ["desk", "symbol"]);
    adapter.replace(transport.viewport, { ...quickQuery, generation: 1 });

    expect(transport.replace).toHaveBeenCalledTimes(1);
    expect(transport.release).not.toHaveBeenCalled();
  });

  it("never publishes provisional loading geometry as the result row count", () => {
    const transport = makeViewport();
    const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      columns,
      undefined,
      [],
      query.orderBy,
    );
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect,
      totalRows: 100,
      version: 1,
      status: "loading",
    });
    adapter.replace(transport.viewport, query);

    expect(adapter.getPublication().rowSpace?.totalRows).toBe(18);
    expect(adapter.getPublication().rowSpace?.loadedRows).toBe(0);
    expect(adapter.getPublication().rowSpace?.getRowId(0)).toBeUndefined();
    expect(adapter.getPublication().totalRows).toBe(18);
    expect(adapter.getResultRowCountSnapshot()).toBe(0);
    transport.getRequest()!.sink.setRowCount(250, true);
    expect(adapter.getResultRowCountSnapshot()).toBe(250);
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect,
      totalRows: 100,
      version: 2,
      status: "stale",
    });
    expect(adapter.getResultRowCountSnapshot()).toBe(250);
  });

  it("stages restored grouped projection authority without a raw result count or reset mode", () => {
    const transport = makeViewport();
    const groupedColumns = compileColumns([
      {
        columnId: "COL_ID_SYMBOL",
        field: "symbol",
        headerName: "Symbol",
        valueType: "text",
        groupBy: true,
      },
      {
        columnId: "COL_ID_PRICE",
        field: "price",
        headerName: "Price",
        valueType: "number",
        aggFunc: "max",
      },
    ]);
    const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      groupedColumns,
      undefined,
      [],
      query.orderBy,
      completeRawSelect,
    );
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect,
      totalRows: 100,
      version: 1,
      status: "ready",
    });
    const restoredGroupedQuery = Object.freeze({
      ...query,
      navigationMode: "restore" as const,
      groupBy: ["COL_ID_SYMBOL"],
      groupOrderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" as const }],
    });

    adapter.stageProjection(restoredGroupedQuery);

    expect(adapter.getPublication().clientProjection).not.toBeNull();
    expect(adapter.getPublication().totalRows).toBe(18);
    expect(adapter.getPublication().loadingAriaRowCount).toBe(-1);
    expect(adapter.getResultRowCountSnapshot()).toBe(0);
    expect(adapter.getStructureSnapshot().navigationMode).toBe("restore");
    expect(transport.replace).not.toHaveBeenCalled();

    adapter.replace(transport.viewport, restoredGroupedQuery);
    expect(adapter.getStructureSnapshot().navigationMode).toBe("restore");
    expect(transport.replace).toHaveBeenCalledTimes(1);
  });

  it("bounds Server lifecycle status and message text at source admission", () => {
    const transport = makeViewport();
    const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      columns,
      undefined,
      [],
      query.orderBy,
    );

    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect,
      totalRows: 100,
      version: 1,
      status: "error",
      statusCode: "S".repeat(256),
      message: "M".repeat(1_024),
    });

    expect(adapter.getPublication().statusCode).toHaveLength(128);
    expect(adapter.getPublication().message).toHaveLength(512);
  });

  it("clears the old authoritative result count until the replacement generation publishes", () => {
    const transport = makeViewport();
    const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      columns,
      undefined,
      [],
      query.orderBy,
      completeRawSelect,
    );
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect,
      totalRows: 100,
      version: 1,
      status: "ready",
    });
    adapter.replace(transport.viewport, query);
    const oldSink = transport.getRequest()!.sink;
    oldSink.setRowCount(250, true);
    expect(adapter.getResultRowCountSnapshot()).toBe(250);

    adapter.replace(transport.viewport, query, {
      externalFilters: [{ field: "price", type: "greaterThan", filter: 10 }],
      routeBy: undefined,
      visibleColumnIds: undefined,
    });
    expect(adapter.getResultRowCountSnapshot()).toBe(0);
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect,
      totalRows: 250,
      version: 2,
      status: "loading",
    });
    expect(adapter.getResultRowCountSnapshot()).toBe(0);
    oldSink.setRowCount(999, true);
    expect(adapter.getResultRowCountSnapshot()).toBe(0);

    transport.getRequest()!.sink.setRowCount(3, true);
    expect(adapter.getResultRowCountSnapshot()).toBe(3);
  });

  it("projects loading geometry without retained or newly delivered row identity", () => {
    const transport = makeViewport();
    const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      columns,
      undefined,
      [],
      query.orderBy,
      completeRawSelect,
    );
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect,
      totalRows: 100,
      version: 1,
      status: "ready",
    });
    adapter.replace(transport.viewport, query);
    transport.getRequest()!.sink.setRowData({ 0: { symbol: "OLD", price: 1 } }, { 0: "old" });
    expect(adapter.getStructureSnapshot().findRowIndex("old")).toBe(0);

    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect,
      totalRows: 100,
      version: 2,
      status: "loading",
    });
    expect(adapter.getStructureSnapshot().findRowIndex("old")).toBeUndefined();
    const structure = vi.fn();
    adapter.subscribeStructure(structure);
    transport.getRequest()!.sink.setRowData({ 1: { symbol: "MOVED", price: 2 } }, { 1: "old" });
    expect(adapter.getStructureSnapshot().findRowIndex("old")).toBeUndefined();
    expect(structure).not.toHaveBeenCalled();

    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect,
      totalRows: 100,
      version: 3,
      status: "ready",
    });
    expect(adapter.getStructureSnapshot().findRowIndex("old")).toBe(1);
  });

  it("hides provisional rows when a new generation is already stale", () => {
    const transport = makeViewport();
    const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      columns,
      undefined,
      [],
      query.orderBy,
      completeRawSelect,
    );
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect,
      totalRows: 100,
      version: 1,
      status: "stale",
    });
    adapter.replace(transport.viewport, query);

    expect(adapter.getPublication()).toMatchObject({
      status: "stale",
      totalRows: 18,
      hasCoherentRows: false,
    });
    expect(adapter.getPublication().rowSpace).toBeUndefined();
  });

  it("invalidates a generation whose transport replacement throws", () => {
    let failedSink:
      | Readonly<{
          readonly setRowCount: (count: number, keepRenderedRows?: boolean) => void;
          readonly setRowData: (
            rows: Readonly<Record<number, Row>>,
            keys: Readonly<Record<number, string>>,
          ) => void;
        }>
      | undefined;
    const failure = new Error("replace failed");
    const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      columns,
      undefined,
      [],
      query.orderBy,
    );
    const initial = makeViewport();
    adapter.reconcileSource({
      viewport: initial.viewport,
      completeRawSelect,
      totalRows: 100,
      version: 1,
      status: "ready",
    });
    adapter.replace(initial.viewport, query);
    initial.getRequest()!.sink.setRowCount(250, true);
    expect(adapter.getResultRowCountSnapshot()).toBe(250);
    const publishedRows: string[] = [];
    adapter.subscribePublication(() => {
      const rowSpace = adapter.getPublication().rowSpace;
      if (rowSpace === undefined) return;
      const rowId = rowSpace.getRowId(0);
      const row = rowId === undefined ? undefined : rowSpace.getRow(rowId);
      if (row !== undefined) publishedRows.push(row.symbol);
    });
    expect(() =>
      adapter.replace(
        {
          semanticKey: brunoTableTestSemanticQueryKey,
          replace(request: Readonly<{ readonly sink: NonNullable<typeof failedSink> }>) {
            failedSink = request.sink;
            request.sink.setRowCount(1, true);
            request.sink.setRowData({ 0: { symbol: "FAILED", price: 0 } }, { 0: "failed" });
            throw failure;
          },
        },
        query,
      ),
    ).toThrow(failure);
    expect(publishedRows).toEqual([]);
    expect(adapter.getPublication().rowSpace).toBeUndefined();
    expect(adapter.getPublication().totalRows).toBe(100);
    expect(adapter.getResultRowCountSnapshot()).toBe(0);
    failedSink!.setRowData({ 0: { symbol: "LATE", price: 0 } }, { 0: "late" });
    expect(adapter.getPublication().rowSpace).toBeUndefined();

    const recovered = makeViewport();
    expect(() => adapter.replace(recovered.viewport, query)).not.toThrow();
    expect(recovered.replace).toHaveBeenCalledTimes(1);
  });

  it("preserves a newer replacement that reenters before the outer controller installs", () => {
    type Request = Readonly<{
      readonly query: unknown;
      readonly sink: Readonly<{
        readonly setRowCount: (count: number, keepRenderedRows?: boolean) => void;
        readonly setRowData: (
          rows: Readonly<Record<number, Row>>,
          keys: Readonly<Record<number, string>>,
        ) => void;
      }>;
    }>;
    const requests: Request[] = [];
    const controllers: Array<
      Readonly<{
        readonly setWindow: ReturnType<typeof vi.fn>;
        readonly release: ReturnType<typeof vi.fn>;
      }>
    > = [];
    let adapter: BrunoTableServerRowPipelineAdapter<Row>;
    let nested = false;
    const viewport = {
      semanticKey: brunoTableTestSemanticQueryKey,
      replace(request: Request) {
        requests.push(request);
        const controller = Object.freeze({ setWindow: vi.fn(), release: vi.fn() });
        controllers.push(controller);
        if (!nested) {
          nested = true;
          adapter.replace(viewport, {
            ...query,
            generation: 1,
            navigationMode: "reset",
            orderBy: [{ columnId: "COL_ID_SYMBOL", direction: "desc" }],
          });
        }
        return controller;
      },
    };
    adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      columns,
      undefined,
      [],
      query.orderBy,
      completeRawSelect,
    );
    adapter.reconcileSource({
      viewport,
      completeRawSelect,
      totalRows: 2,
      version: 1,
      status: "ready",
    });

    expect(() => adapter.replace(viewport, query)).not.toThrow();

    expect(requests).toHaveLength(2);
    expect(controllers[0]!.release).toHaveBeenCalledOnce();
    expect(controllers[1]!.release).not.toHaveBeenCalled();
    requests[0]!.sink.setRowCount(1, true);
    requests[0]!.sink.setRowData({ 0: { symbol: "OUTER", price: 1 } }, { 0: "outer" });
    expect(adapter.getPublication().rowSpace?.loadedRows).toBe(0);
    requests[1]!.sink.setRowCount(1, true);
    requests[1]!.sink.setRowData({ 0: { symbol: "NEWEST", price: 2 } }, { 0: "newest" });
    expect(adapter.getPublication().rowSpace?.getRowId(0)).toBe("newest");
    expect(adapter.getPublication().rowSpace?.getRow("newest")?.symbol).toBe("NEWEST");

    adapter.setRequiredRange(20, 30);
    expect(controllers[0]!.setWindow).not.toHaveBeenCalled();
    expect(controllers[1]!.setWindow).toHaveBeenCalledOnce();
    expect(adapter.getStructureSnapshot().generation).toBe(1);
    expect(adapter.getStructureSnapshot().navigationMode).toBe("reset");
  });

  it("keeps newer projection authority when outer query input snapshotting reenters", () => {
    const groupedColumns = compileColumns([
      {
        columnId: "COL_ID_DESK",
        field: "desk",
        headerName: "Desk",
        valueType: "text",
        groupBy: true,
      },
    ]);
    const transport = makeViewport<Record<string, unknown>>();
    const adapter = new BrunoTableServerRowPipelineAdapter<Record<string, unknown>>(
      groupedColumns,
      undefined,
      [],
      [{ columnId: "COL_ID_DESK", direction: "asc" }],
      ["desk"],
    );
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect: ["desk"],
      totalRows: 1,
      version: 1,
      status: "ready",
    });
    const groupedQuery = {
      ...query,
      generation: 1,
      navigationMode: "projection-reset" as const,
      orderBy: [{ columnId: "COL_ID_DESK", direction: "asc" as const }],
      groupBy: ["COL_ID_DESK"],
      groupOrderBy: [{ columnId: "COL_ID_DESK", direction: "asc" as const }],
    };
    let nested = false;
    const routeBy = {} as Record<string, unknown>;
    Object.defineProperty(routeBy, "desk", {
      enumerable: true,
      get: () => {
        if (!nested) {
          nested = true;
          adapter.replace(transport.viewport, groupedQuery);
        }
        return "outer";
      },
    });

    adapter.replace(
      transport.viewport,
      {
        ...query,
        orderBy: [{ columnId: "COL_ID_DESK", direction: "asc" }],
      },
      {
        routeBy,
        externalFilters: undefined,
        visibleColumnIds: undefined,
      },
    );

    expect(transport.replace).toHaveBeenCalledOnce();
    const request = transport.getRequest()!;
    expect(request.query).toHaveProperty("groupBy", ["desk"]);
    const rowsAlias = Object.entries(
      (request.query as { aggregates: Record<string, { aggFunc: string }> }).aggregates,
    ).find(([, aggregate]) => aggregate.aggFunc === "count")![0];
    request.sink.setRowCount(1, true);
    request.sink.setRowData({ 0: { desk: "Rates", [rowsAlias]: 1n } }, { 0: "rates" });
    expect(adapter.getPublication().clientProjection).toMatchObject({
      groupBy: ["COL_ID_DESK"],
    });
    expect(adapter.getPublication().rowSpace?.getCellValue("rates", "COL_ID_DESK")).toBe("Rates");
  });

  it("keeps newer raw projection equality when outer query input snapshotting reenters", () => {
    type Token = Readonly<{ readonly id: number; readonly label: string }>;
    type TokenRow = Readonly<{ readonly token: Token }>;
    const valueType = (observeLabel: boolean) => ({
      codecId: `test/reentrant-raw-${observeLabel ? "label" : "id"}`,
      codecVersion: 1,
      filterFamily: "equality" as const,
      editorFamily: "text" as const,
      cellAlign: "start" as const,
      editorLayout: "inline" as const,
      defaultWidth: 120,
      decodeRuntime: (input: unknown) =>
        typeof input === "object" && input !== null && "id" in input && "label" in input
          ? ({ _tag: "Success", value: input as Token } as const)
          : ({ _tag: "Failure", message: "Expected token." } as const),
      equivalent: (left: Token, right: Token) =>
        left.id === right.id && (!observeLabel || left.label === right.label),
      compare: (left: Token, right: Token) => left.id - right.id,
      formatCanonicalText: (value: Token) =>
        observeLabel ? `${String(value.id)}:${value.label}` : String(value.id),
      parseCanonicalText: (text: string) =>
        ({ _tag: "Success", value: { id: Number(text), label: text } }) as const,
      formatDisplay: (value: Token) => (observeLabel ? value.label : String(value.id)),
      encodePersisted: (value: Token) => ({ id: value.id, label: value.label }),
      decodePersisted: (input: unknown) =>
        typeof input === "object" && input !== null && "id" in input && "label" in input
          ? ({ _tag: "Success", value: input as Token } as const)
          : ({ _tag: "Failure", message: "Expected token." } as const),
    });
    const tokenColumns = compileColumns([
      {
        columnId: "COL_ID_TOKEN_ID",
        field: "token",
        headerName: "Token identity",
        valueType: valueType(false),
      },
      {
        columnId: "COL_ID_TOKEN_LABEL",
        field: "token",
        headerName: "Token label",
        valueType: valueType(true),
      },
    ] as never);
    const rawQuery = {
      ...query,
      orderBy: [{ columnId: "COL_ID_TOKEN_ID", direction: "asc" as const }],
    };
    const transport = makeViewport<TokenRow>();
    const adapter = new BrunoTableServerRowPipelineAdapter<TokenRow>(
      tokenColumns,
      undefined,
      [],
      rawQuery.orderBy,
      ["token"],
    );
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect: ["token"],
      totalRows: 1,
      version: 1,
      status: "ready",
    });
    let nested = false;
    const routeBy = {} as Record<string, unknown>;
    Object.defineProperty(routeBy, "desk", {
      enumerable: true,
      get: () => {
        if (!nested) {
          nested = true;
          adapter.replace(transport.viewport, rawQuery, {
            routeBy: undefined,
            externalFilters: undefined,
            visibleColumnIds: ["COL_ID_TOKEN_ID"],
          });
        }
        return "outer";
      },
    });

    adapter.replace(transport.viewport, rawQuery, {
      routeBy,
      externalFilters: undefined,
      visibleColumnIds: ["COL_ID_TOKEN_ID", "COL_ID_TOKEN_LABEL"],
    });

    expect(transport.replace).toHaveBeenCalledOnce();
    const request = transport.getRequest()!;
    expect(request.query).toEqual({
      select: ["token"],
      where: [],
      orderBy: [{ field: "token", direction: "asc" }],
    });
    request.sink.setRowCount(1, true);
    const first = { token: { id: 1, label: "OLD" } } as const;
    request.sink.setRowData({ 0: first }, { 0: "token" });
    expect(adapter.getPublication().rowSpace?.getRow("token")).toBe(first);

    request.sink.setRowData({ 0: { token: { id: 1, label: "NEW" } } }, { 0: "token" });
    expect(adapter.getPublication().rowSpace?.getRow("token")).toBe(first);
  });

  it("does not invalidate a newer replacement when a superseded outer transport throws", () => {
    type Request = Readonly<{
      readonly sink: Readonly<{
        readonly setRowCount: (count: number, keepRenderedRows?: boolean) => void;
        readonly setRowData: (
          rows: Readonly<Record<number, Row>>,
          keys: Readonly<Record<number, string>>,
        ) => void;
      }>;
    }>;
    const requests: Request[] = [];
    const nestedController = Object.freeze({ setWindow: vi.fn(), release: vi.fn() });
    const failure = new Error("superseded outer replacement failed");
    let adapter: BrunoTableServerRowPipelineAdapter<Row>;
    let nested = false;
    const viewport = {
      semanticKey: brunoTableTestSemanticQueryKey,
      replace(request: Request) {
        requests.push(request);
        if (!nested) {
          nested = true;
          adapter.replace(viewport, {
            ...query,
            generation: 1,
            navigationMode: "reset",
            orderBy: [{ columnId: "COL_ID_SYMBOL", direction: "desc" }],
          });
          throw failure;
        }
        return nestedController;
      },
    };
    adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      columns,
      undefined,
      [],
      query.orderBy,
      completeRawSelect,
    );
    adapter.reconcileSource({
      viewport,
      completeRawSelect,
      totalRows: 1,
      version: 1,
      status: "ready",
    });

    expect(() => adapter.replace(viewport, query)).toThrow(failure);

    expect(requests).toHaveLength(2);
    expect(nestedController.release).not.toHaveBeenCalled();
    requests[1]!.sink.setRowCount(1, true);
    requests[1]!.sink.setRowData({ 0: { symbol: "NEWEST", price: 2 } }, { 0: "newest" });
    expect(adapter.getPublication().rowSpace?.getRowId(0)).toBe("newest");
    expect(adapter.getStructureSnapshot().generation).toBe(1);
    expect(adapter.getStructureSnapshot().navigationMode).toBe("reset");
  });

  it("invalidates a generation whose source semantic identity throws", () => {
    const failure = new Error("semantic key failed");
    const transport = makeViewport();
    const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      columns,
      undefined,
      [],
      query.orderBy,
    );
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect,
      totalRows: 100,
      version: 1,
      status: "ready",
    });
    adapter.replace(transport.viewport, query);
    const firstSink = transport.getRequest()!.sink;
    firstSink.setRowData({ 0: { symbol: "OLD", price: 1 } }, { 0: "old" });
    transport.semanticKey.mockImplementationOnce(() => {
      throw failure;
    });

    expect(() =>
      adapter.replace(transport.viewport, {
        ...query,
        filters: [{ columnId: "COL_ID_SYMBOL", type: "startsWith", filter: "A" }],
      }),
    ).toThrow(failure);
    expect(transport.release).toHaveBeenCalledOnce();
    expect(adapter.getPublication().rowSpace).toBeUndefined();
    firstSink.setRowData({ 0: { symbol: "LATE", price: 2 } }, { 0: "late" });
    expect(adapter.getPublication().rowSpace).toBeUndefined();
  });

  it("invalidates when comparing the prior source semantic identity throws", () => {
    const failure = new Error("prior semantic key failed");
    const transport = makeViewport();
    const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      columns,
      undefined,
      [],
      query.orderBy,
    );
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect,
      totalRows: 100,
      version: 1,
      status: "ready",
    });
    adapter.replace(transport.viewport, query);
    const firstSink = transport.getRequest()!.sink;
    firstSink.setRowData({ 0: { symbol: "OLD", price: 1 } }, { 0: "old" });
    transport.semanticKey
      .mockImplementationOnce(() => Object.freeze({ changed: true }))
      .mockImplementationOnce(() => {
        throw failure;
      });

    expect(() =>
      adapter.replace(
        transport.viewport,
        {
          ...query,
          filters: [{ columnId: "COL_ID_SYMBOL", type: "startsWith", filter: "A" }],
        },
        {
          routeBy: undefined,
          externalFilters: [{ field: "price", type: "greaterThan", filter: 10 }],
          visibleColumnIds: ["COL_ID_SYMBOL", "COL_ID_PRICE"],
        },
        true,
      ),
    ).toThrow(failure);
    expect(transport.release).toHaveBeenCalledOnce();
    expect(adapter.getPublication().rowSpace).toBeUndefined();
    firstSink.setRowData({ 0: { symbol: "LATE", price: 2 } }, { 0: "late" });
    expect(adapter.getPublication().rowSpace).toBeUndefined();
  });

  it("best-effort releases a partially valid generation before rejecting it", () => {
    const release = vi.fn(() => {
      throw new Error("secondary release failure");
    });
    const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      columns,
      undefined,
      [],
      query.orderBy,
      completeRawSelect,
    );
    const viewport = {
      semanticKey: brunoTableTestSemanticQueryKey,
      replace: vi.fn(() => ({ release, setWindow: undefined })),
    };
    adapter.reconcileSource({
      viewport,
      completeRawSelect,
      totalRows: 100,
      version: 1,
      status: "ready",
    });

    expect(() => adapter.replace(viewport, query)).toThrow(
      "BrunoTable Server viewport generation must expose setWindow() and release().",
    );
    expect(release).toHaveBeenCalledOnce();
    expect(adapter.getPublication().rowSpace).toBeUndefined();
  });

  it("publishes row invalidation before propagating a controller release failure", () => {
    const releaseFailure = new Error("release failed");
    const first = makeViewport();
    first.release.mockImplementation(() => {
      throw releaseFailure;
    });
    const second = makeViewport();
    const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      columns,
      undefined,
      [],
      query.orderBy,
    );
    adapter.reconcileSource({
      viewport: first.viewport,
      completeRawSelect,
      totalRows: 100,
      version: 1,
      status: "ready",
    });
    adapter.replace(first.viewport, query);
    const firstSink = first.getRequest()!.sink;
    firstSink.setRowCount(250, true);
    firstSink.setRowData({ 0: { symbol: "OLD", price: 1 } }, { 0: "old" });
    expect(adapter.getResultRowCountSnapshot()).toBe(250);
    const structureFailure = vi.fn(() => {
      throw new Error("structure subscriber failed");
    });
    const countFailure = vi.fn(() => {
      throw new Error("count subscriber failed");
    });
    const publish = vi.fn(() => {
      throw new Error("publication subscriber failed");
    });
    adapter.subscribeStructure(structureFailure);
    adapter.subscribeResultRowCount(countFailure);
    adapter.subscribePublication(publish);

    let observedFailure: unknown;
    try {
      adapter.replace(second.viewport, { ...query, generation: 1 });
    } catch (error) {
      observedFailure = error;
    }
    expect(observedFailure).toBe(releaseFailure);
    expect(adapter.getPublication().rowSpace).toBeUndefined();
    expect(adapter.getResultRowCountSnapshot()).toBe(0);
    expect(structureFailure).toHaveBeenCalledTimes(1);
    expect(countFailure).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(second.replace).not.toHaveBeenCalled();
    firstSink.setRowData({ 0: { symbol: "LATE", price: 2 } }, { 0: "late" });
    expect(adapter.getPublication().rowSpace).toBeUndefined();
  });

  it("surfaces malformed active deliveries while ignoring released-generation writes", () => {
    const first = makeViewport();
    const second = makeViewport();
    const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      columns,
      undefined,
      [],
      query.orderBy,
    );
    adapter.replace(first.viewport, query);
    const firstSink = first.getRequest()!.sink;
    const initialPublication = adapter.getPublication();
    const publish = vi.fn();
    adapter.subscribePublication(publish);

    for (const count of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => firstSink.setRowCount(count, true)).toThrow(
        "BrunoTable Server viewport delivered an invalid row count.",
      );
    }
    expect(adapter.getPublication()).toBe(initialPublication);
    expect(adapter.getResultRowCountSnapshot()).toBe(0);
    expect(publish).not.toHaveBeenCalled();

    expect(() => firstSink.setRowData({ 0: { symbol: "BROKEN", price: 1 } }, {})).toThrow(
      "BrunoTable Server viewport delivered invalid row/key maps.",
    );
    expect(adapter.getPublication().rowSpace?.getRowId(0)).toBeUndefined();

    adapter.replace(second.viewport, { ...query, generation: 1 });
    expect(() => firstSink.setRowCount(-1, true)).not.toThrow();
    expect(() => firstSink.setRowData({ 0: { symbol: "LATE", price: 2 } }, {})).not.toThrow();
  });

  it("forwards one sanitized required window including authoritative empty space", () => {
    const invalidTransport = makeViewport();
    const invalidAdapter = new BrunoTableServerRowPipelineAdapter<Row>(
      columns,
      undefined,
      [],
      query.orderBy,
    );
    invalidAdapter.replace(invalidTransport.viewport, query);
    invalidAdapter.setRequiredRange(Number.NaN, Number.POSITIVE_INFINITY);
    expect(invalidTransport.setWindow).toHaveBeenLastCalledWith({ firstRow: 0, lastRow: 0 });

    const emptyTransport = makeViewport();
    const emptyAdapter = new BrunoTableServerRowPipelineAdapter<Row>(
      columns,
      undefined,
      [],
      query.orderBy,
    );
    emptyAdapter.replace(emptyTransport.viewport, query);
    emptyTransport.getRequest()!.sink.setRowCount(0, true);
    emptyAdapter.setRequiredRange(50, 75);
    expect(emptyTransport.setWindow).toHaveBeenLastCalledWith({ firstRow: 0, lastRow: 0 });

    const boundedTransport = makeViewport();
    const boundedAdapter = new BrunoTableServerRowPipelineAdapter<Row>(
      columns,
      undefined,
      [],
      query.orderBy,
    );
    boundedAdapter.replace(boundedTransport.viewport, query);
    boundedTransport.getRequest()!.sink.setRowCount(3, true);
    boundedAdapter.setRequiredRange(50, 75);
    expect(boundedTransport.setWindow).toHaveBeenLastCalledWith({ firstRow: 2, lastRow: 2 });
  });

  it("retries an unchanged required window after controller dispatch fails", () => {
    const transport = makeViewport();
    transport.setWindow.mockImplementationOnce(() => {
      throw new Error("window failed");
    });
    const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      columns,
      undefined,
      [],
      query.orderBy,
    );
    adapter.replace(transport.viewport, query);

    expect(() => adapter.setRequiredRange(10, 30)).toThrow("window failed");
    expect(() => adapter.setRequiredRange(10, 30)).not.toThrow();
    expect(transport.setWindow).toHaveBeenNthCalledWith(1, { firstRow: 10, lastRow: 29 });
    expect(transport.setWindow).toHaveBeenNthCalledWith(2, { firstRow: 10, lastRow: 29 });
    expect(transport.replace).toHaveBeenCalledTimes(1);
  });

  it("falls back to a current sortable identity when columns replace the baseline", () => {
    const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      columns,
      undefined,
      [],
      query.orderBy,
    );
    const priceOnly = compileColumns([
      {
        columnId: "COL_ID_PRICE_NEXT",
        field: "price",
        headerName: "Price",
        valueType: "number",
      },
    ]);

    expect(() => adapter.reconcileColumns(priceOnly, undefined)).not.toThrow();
    expect(adapter.getQueryConfiguration().baselineOrderBy).toEqual([
      { columnId: "COL_ID_PRICE_NEXT", direction: "asc" },
    ]);
  });

  it("publishes one coherent sparse delivery and ignores released sinks", () => {
    const firstTransport = makeViewport();
    const secondTransport = makeViewport();
    const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      columns,
      undefined,
      [],
      query.orderBy,
    );
    const publish = vi.fn();
    adapter.subscribePublication(publish);
    adapter.reconcileSource({
      viewport: firstTransport.viewport,
      completeRawSelect,
      totalRows: 100,
      version: 1,
      status: "ready",
    });
    adapter.replace(firstTransport.viewport, query);
    const firstSink = firstTransport.getRequest()!.sink;
    firstSink.setRowCount(100, true);
    publish.mockClear();
    const stable = { symbol: "AAPL", price: 240 } as const;
    firstSink.setRowData({ 12: stable }, { 12: "row-a" });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(adapter.getPublication().rowSpace?.getRow("row-a")).toBe(stable);

    adapter.replace(secondTransport.viewport, query);
    expect(firstTransport.release).toHaveBeenCalledTimes(1);
    expect(adapter.getPublication().rowSpace?.getRowId(12)).toBeUndefined();
    firstSink.setRowData({ 0: { symbol: "LATE", price: 0 } }, { 0: "late" });
    expect(adapter.getPublication().rowSpace?.getRowId(0)).toBeUndefined();
  });

  it("partitions sparse value publications from structural row-space changes", () => {
    const transport = makeViewport();
    const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      columns,
      undefined,
      [],
      query.orderBy,
    );
    const publishStructure = vi.fn();
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect,
      totalRows: 100,
      version: 1,
      status: "ready",
    });
    adapter.replace(transport.viewport, query);
    adapter.subscribeStructure(publishStructure);

    transport.getRequest()!.sink.setRowData({ 0: { symbol: "AAPL", price: 240 } }, { 0: "row-a" });
    expect(publishStructure).toHaveBeenCalledTimes(1);
    const loadedStructure = adapter.getStructureSnapshot();

    publishStructure.mockClear();
    transport.getRequest()!.sink.setRowData({ 0: { symbol: "AAPL", price: 241 } }, { 0: "row-a" });
    expect(adapter.getPublication().rowSpace?.getCellValue("row-a", "COL_ID_PRICE")).toBe(241);
    expect(adapter.getStructureSnapshot()).toBe(loadedStructure);
    expect(publishStructure).not.toHaveBeenCalled();

    transport.getRequest()!.sink.setRowData({ 0: { symbol: "MSFT", price: 510 } }, { 0: "row-b" });
    expect(adapter.getStructureSnapshot()).not.toBe(loadedStructure);
    expect(publishStructure).toHaveBeenCalledTimes(1);

    publishStructure.mockClear();
    transport.getRequest()!.sink.setRowCount(50, true);
    expect(adapter.getStructureSnapshot().totalRows).toBe(50);
    expect(publishStructure).toHaveBeenCalledTimes(1);
  });

  it("notifies only subscribers for row identities affected by one sparse batch", () => {
    const transport = makeViewport();
    const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      columns,
      undefined,
      [],
      query.orderBy,
      completeRawSelect,
    );
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect,
      totalRows: 100,
      version: 1,
      status: "ready",
    });
    adapter.replace(transport.viewport, query);
    const runtime = new BrunoTableGridRuntime(
      adapter.getPublication(),
      columns,
      adapter.getQueryConfiguration(),
      "TABLE_ID_SERVER_AFFECTED_SLOTS",
    );
    const view = runtime.getView();
    const reads: string[] = [];
    adapter.subscribePublication(() => {
      const publication = adapter.getPublication();
      const rowSpace = publication.rowSpace;
      runtime.publish(
        rowSpace === undefined
          ? publication
          : {
              ...publication,
              rowSpace: {
                ...rowSpace,
                getCellValue(rowId, columnId) {
                  reads.push(rowId);
                  return rowSpace.getCellValue(rowId, columnId);
                },
              },
            },
      );
    });
    const initialRows = Object.fromEntries(
      Array.from({ length: 18 }, (_, index) => [
        index,
        { symbol: `ROW-${String(index)}`, price: index },
      ]),
    );
    const initialKeys = Object.fromEntries(
      Array.from({ length: 18 }, (_, index) => [index, `row-${String(index)}`]),
    );
    transport.getRequest()!.sink.setRowData(initialRows, initialKeys);
    const notifications = Array.from({ length: 18 }, () => vi.fn());
    for (let index = 0; index < notifications.length; index += 1) {
      view.subscribeCell(`row-${String(index)}`, "COL_ID_PRICE", notifications[index]!);
    }
    reads.length = 0;
    for (const notification of notifications) notification.mockClear();

    transport.getRequest()!.sink.setRowData({ 7: { symbol: "ROW-7", price: 700 } }, { 7: "row-7" });

    expect(reads).toEqual(["row-7"]);
    expect(notifications[7]).toHaveBeenCalledOnce();
    expect(notifications.filter((notification) => notification.mock.calls.length > 0)).toEqual([
      notifications[7],
    ]);
  });

  it("does not retain semantically equivalent rows when display or raw-row evidence changes", () => {
    type Token = Readonly<{ readonly id: number; readonly label: string }>;
    type TokenRow = Readonly<{ readonly token: Token }>;
    const valueType = (formatDisplay: (value: Token) => string) => ({
      codecId: "test/server-token",
      codecVersion: 1,
      filterFamily: "equality" as const,
      editorFamily: "text" as const,
      cellAlign: "start" as const,
      editorLayout: "inline" as const,
      defaultWidth: 120,
      decodeRuntime: (input: unknown) =>
        typeof input === "object" && input !== null && "id" in input && "label" in input
          ? ({ _tag: "Success", value: input as Token } as const)
          : ({ _tag: "Failure", message: "Expected token." } as const),
      equivalent: (left: Token, right: Token) => left.id === right.id,
      compare: (left: Token, right: Token) => left.id - right.id,
      formatCanonicalText: (value: Token) => String(value.id),
      parseCanonicalText: (text: string) =>
        ({ _tag: "Success", value: { id: Number(text), label: text } }) as const,
      formatDisplay,
      encodePersisted: (value: Token) => ({ id: value.id, label: value.label }),
      decodePersisted: (input: unknown) =>
        typeof input === "object" && input !== null && "id" in input && "label" in input
          ? ({ _tag: "Success", value: input as Token } as const)
          : ({ _tag: "Failure", message: "Expected token." } as const),
    });
    const run = (rawRowAware: boolean) => {
      const tokenColumns = compileColumns([
        {
          columnId: "COL_ID_TOKEN",
          field: "token",
          headerName: "Token",
          valueType: valueType((value) => (rawRowAware ? String(value.id) : value.label)),
          ...(rawRowAware
            ? { valueFormatter: ({ row }: { readonly row: TokenRow }) => row.token.label }
            : {}),
        },
      ] as never);
      const transport = makeViewport<TokenRow>();
      const adapter = new BrunoTableServerRowPipelineAdapter<TokenRow>(
        tokenColumns,
        undefined,
        [],
        [{ columnId: "COL_ID_TOKEN", direction: "asc" }],
        ["token"],
      );
      adapter.reconcileSource({
        viewport: transport.viewport,
        completeRawSelect: ["token"],
        totalRows: 1,
        version: 1,
        status: "ready",
      });
      adapter.replace(transport.viewport, {
        generation: 0,
        navigationMode: "reset",
        filters: [],
        quickFilter: "",
        orderBy: [{ columnId: "COL_ID_TOKEN", direction: "asc" }],
      });
      const previous = { token: { id: 1, label: "OLD" } } as const;
      const next = { token: { id: 1, label: "NEW" } } as const;
      transport.getRequest()!.sink.setRowData({ 0: previous }, { 0: "token-1" });
      const previousReference = adapter.getPublication().rowSpace?.getRow("token-1");
      transport.getRequest()!.sink.setRowData({ 0: next }, { 0: "token-1" });
      expect(adapter.getPublication().rowSpace?.getRow("token-1")).toBe(next);
      expect(adapter.getPublication().rowSpace?.getRow("token-1")).not.toBe(previousReference);
    };

    run(false);
    run(true);
  });

  it("retains grouped equivalent values only when no active role callback can observe them", () => {
    type Token = Readonly<{
      readonly id: number;
      readonly label: string;
      readonly canonical: string;
    }>;
    const tokenType = {
      codecId: "test/grouped-callback-token",
      codecVersion: 1,
      filterFamily: "equality" as const,
      editorFamily: "text" as const,
      cellAlign: "start" as const,
      editorLayout: "inline" as const,
      defaultWidth: 120,
      aggregateResults: { min: "self" as const },
      decodeRuntime: (input: unknown) =>
        typeof input === "object" &&
        input !== null &&
        "id" in input &&
        "label" in input &&
        "canonical" in input
          ? ({ _tag: "Success", value: input as Token } as const)
          : ({ _tag: "Failure", message: "Expected token." } as const),
      equivalent: (left: Token, right: Token) => left.id === right.id,
      compare: (left: Token, right: Token) => left.id - right.id,
      formatCanonicalText: (value: Token) => value.canonical,
      parseCanonicalText: (text: string) =>
        ({ _tag: "Success", value: { id: Number(text), label: text, canonical: text } }) as const,
      formatDisplay: (value: Token) => String(value.id),
      encodePersisted: (value: Token) => ({
        id: value.id,
        label: value.label,
        canonical: value.canonical,
      }),
      decodePersisted: (input: unknown) =>
        typeof input === "object" &&
        input !== null &&
        "id" in input &&
        "label" in input &&
        "canonical" in input
          ? ({ _tag: "Success", value: input as Token } as const)
          : ({ _tag: "Failure", message: "Expected token." } as const),
    };
    const run = (observer: "none" | "role" | "rows" | "canonical"): void => {
      const tokenColumns = compileColumns([
        {
          columnId: "COL_ID_KEY",
          field: "key",
          headerName: "Key",
          valueType: tokenType,
          groupBy: true,
          ...(observer === "role"
            ? {
                groupKeyValueFormatter: ({ value }: { readonly value: Token }) => value.label,
              }
            : {}),
        },
        {
          columnId: "COL_ID_AGGREGATE",
          field: "aggregate",
          headerName: "Aggregate",
          valueType: tokenType,
          aggFunc: "min",
          ...(observer === "role"
            ? {
                aggregateCellRenderer: ({ value }: { readonly value: Token }) => value.label,
              }
            : {}),
        },
      ] as never);
      const transport = makeViewport<Record<string, unknown>>();
      const adapter = new BrunoTableServerRowPipelineAdapter<Record<string, unknown>>(
        tokenColumns,
        undefined,
        [],
        [{ columnId: "COL_ID_KEY", direction: "asc" }],
        ["key", "aggregate"],
        observer === "rows"
          ? {
              valueFormatter: ({
                groupKeys,
              }: {
                readonly groupKeys: readonly Readonly<{
                  readonly _tag: "Present";
                  readonly value: Token;
                }>[];
              }) => groupKeys[0]?.value.label ?? "missing",
            }
          : undefined,
      );
      adapter.reconcileSource({
        viewport: transport.viewport,
        completeRawSelect: ["key", "aggregate"],
        totalRows: 1,
        version: 1,
        status: "ready",
      });
      adapter.replace(transport.viewport, {
        ...query,
        orderBy: [{ columnId: "COL_ID_KEY", direction: "asc" }],
        groupBy: ["COL_ID_KEY"],
        groupOrderBy: [{ columnId: "COL_ID_KEY", direction: "asc" }],
      });
      const request = transport.getRequest()!;
      const aggregates = (
        request.query as {
          aggregates: Record<string, { aggFunc: string }>;
        }
      ).aggregates;
      const rowsAlias = Object.entries(aggregates).find(
        ([, aggregate]) => aggregate.aggFunc === "count",
      )![0];
      const aggregateAlias = Object.entries(aggregates).find(
        ([, aggregate]) => aggregate.aggFunc === "min",
      )![0];
      request.sink.setRowData(
        {
          0: {
            key: {
              id: 1,
              label: observer === "role" || observer === "rows" ? "OLD KEY" : "KEY",
              canonical: observer === "canonical" ? "OLD KEY" : "1",
            },
            [rowsAlias]: 1n,
            [aggregateAlias]: {
              id: 2,
              label: observer === "role" ? "OLD AGGREGATE" : "AGGREGATE",
              canonical: observer === "canonical" ? "OLD AGGREGATE" : "2",
            },
          },
        },
        { 0: "group" },
      );
      const previous = adapter.getPublication().rowSpace?.getRow("group");
      request.sink.setRowData(
        {
          0: {
            key: {
              id: 1,
              label: observer === "role" || observer === "rows" ? "NEW KEY" : "KEY",
              canonical: observer === "canonical" ? "NEW KEY" : "1",
            },
            [rowsAlias]: 1n,
            [aggregateAlias]: {
              id: 2,
              label: observer === "role" ? "NEW AGGREGATE" : "AGGREGATE",
              canonical: observer === "canonical" ? "NEW AGGREGATE" : "2",
            },
          },
        },
        { 0: "group" },
      );
      const next = adapter.getPublication().rowSpace?.getRow("group");
      if (observer === "role" || observer === "rows" || observer === "canonical")
        expect(next).not.toBe(previous);
      else expect(next).toBe(previous);
    };

    run("none");
    run("role");
    run("rows");
    run("canonical");
  });

  it("starts a clean admission generation when a grouped callback begins observing exact values", () => {
    type Token = Readonly<{ readonly id: number; readonly label: string }>;
    const tokenType = {
      codecId: "test/grouped-late-callback-token",
      codecVersion: 1,
      filterFamily: "equality" as const,
      editorFamily: "text" as const,
      cellAlign: "start" as const,
      editorLayout: "inline" as const,
      defaultWidth: 120,
      decodeRuntime: (input: unknown) =>
        typeof input === "object" && input !== null && "id" in input && "label" in input
          ? ({ _tag: "Success", value: input as Token } as const)
          : ({ _tag: "Failure", message: "Expected token." } as const),
      equivalent: (left: Token, right: Token) => left.id === right.id,
      compare: (left: Token, right: Token) => left.id - right.id,
      formatCanonicalText: (value: Token) => String(value.id),
      parseCanonicalText: (text: string) =>
        ({ _tag: "Success", value: { id: Number(text), label: text } }) as const,
      formatDisplay: (value: Token) => String(value.id),
      encodePersisted: (value: Token) => ({ id: value.id, label: value.label }),
      decodePersisted: (input: unknown) =>
        typeof input === "object" && input !== null && "id" in input && "label" in input
          ? ({ _tag: "Success", value: input as Token } as const)
          : ({ _tag: "Failure", message: "Expected token." } as const),
    };
    const makeColumns = (observes: boolean) =>
      compileColumns([
        {
          columnId: "COL_ID_KEY",
          field: "key",
          headerName: "Key",
          valueType: tokenType,
          groupBy: true,
          ...(observes
            ? { groupKeyValueFormatter: ({ value }: { readonly value: Token }) => value.label }
            : {}),
        },
      ] as never);
    const transport = makeViewport<Record<string, unknown>>();
    const adapter = new BrunoTableServerRowPipelineAdapter<Record<string, unknown>>(
      makeColumns(false),
      undefined,
      [],
      [{ columnId: "COL_ID_KEY", direction: "asc" }],
      ["key"],
    );
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect: ["key"],
      totalRows: 1,
      version: 1,
      status: "ready",
    });
    const groupedQuery = {
      ...query,
      orderBy: [{ columnId: "COL_ID_KEY", direction: "asc" as const }],
      groupBy: ["COL_ID_KEY"],
      groupOrderBy: [{ columnId: "COL_ID_KEY", direction: "asc" as const }],
      navigationMode: "projection-reset" as const,
    };
    adapter.replace(transport.viewport, groupedQuery);
    const firstRequest = transport.getRequest()!;
    const rowsAlias = Object.entries(
      (firstRequest.query as { aggregates: Record<string, { aggFunc: string }> }).aggregates,
    ).find(([, aggregate]) => aggregate.aggFunc === "count")![0];
    firstRequest.sink.setRowData(
      { 0: { key: { id: 1, label: "OLD" }, [rowsAlias]: 1n } },
      { 0: "group" },
    );
    firstRequest.sink.setRowData(
      { 0: { key: { id: 1, label: "LATEST" }, [rowsAlias]: 1n } },
      { 0: "group" },
    );
    const retained = adapter.getPublication().rowSpace?.getCellValue("group", "COL_ID_KEY") as
      | Token
      | undefined;
    expect(retained?.label).toBe("OLD");

    adapter.reconcileColumns(makeColumns(true), undefined);
    adapter.replace(transport.viewport, { ...groupedQuery, generation: 1 });

    expect(transport.replace).toHaveBeenCalledTimes(2);
    expect(transport.release).toHaveBeenCalledOnce();
    expect(adapter.getPublication().rowSpace?.loadedRows).toBe(0);
    expect(adapter.getStructureSnapshot().navigationMode).toBe("reconcile");

    const secondRequest = transport.getRequest()!;
    secondRequest.sink.setRowCount(1, true);
    secondRequest.sink.setRowData(
      { 0: { key: { id: 1, label: "LATEST" }, [rowsAlias]: 1n } },
      { 0: "group" },
    );
    const exactRow = adapter.getPublication().rowSpace?.getRow("group");
    adapter.reconcileColumns(makeColumns(false), undefined);
    adapter.replace(transport.viewport, { ...groupedQuery, generation: 2 });

    expect(transport.replace).toHaveBeenCalledTimes(2);
    expect(transport.release).toHaveBeenCalledOnce();
    expect(adapter.getPublication().rowSpace?.getRow("group")).toBe(exactRow);
    expect(
      (adapter.getPublication().rowSpace?.getCellValue("group", "COL_ID_KEY") as Token | undefined)
        ?.label,
    ).toBe("LATEST");
  });

  it("keeps built-in Number format changes presentation-only for grouped values", () => {
    const makeColumns = (minimumFractionDigits: number) =>
      compileColumns([
        {
          columnId: "COL_ID_KEY",
          field: "key",
          headerName: "Key",
          valueType: "number",
          format: { minimumFractionDigits },
          groupBy: true,
        },
        {
          columnId: "COL_ID_AGGREGATE",
          field: "aggregate",
          headerName: "Aggregate",
          valueType: "number",
          format: { minimumFractionDigits },
          aggFunc: "min",
        },
      ] as const);
    const transport = makeViewport<Record<string, unknown>>();
    const adapter = new BrunoTableServerRowPipelineAdapter<Record<string, unknown>>(
      makeColumns(0),
      undefined,
      [],
      [{ columnId: "COL_ID_KEY", direction: "asc" }],
      ["key", "aggregate"],
    );
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect: ["key", "aggregate"],
      totalRows: 1,
      version: 1,
      status: "ready",
    });
    const groupedQuery = {
      ...query,
      orderBy: [{ columnId: "COL_ID_KEY", direction: "asc" as const }],
      groupBy: ["COL_ID_KEY"],
      groupOrderBy: [{ columnId: "COL_ID_KEY", direction: "asc" as const }],
      navigationMode: "projection-reset" as const,
    };
    adapter.replace(transport.viewport, groupedQuery);
    const request = transport.getRequest()!;
    const aggregates = (request.query as { aggregates: Record<string, { aggFunc: string }> })
      .aggregates;
    const rowsAlias = Object.entries(aggregates).find(
      ([, aggregate]) => aggregate.aggFunc === "count",
    )![0];
    const aggregateAlias = Object.entries(aggregates).find(
      ([, aggregate]) => aggregate.aggFunc === "min",
    )![0];
    request.sink.setRowCount(1, true);
    request.sink.setRowData(
      { 0: { key: 1.5, [rowsAlias]: 1n, [aggregateAlias]: 2.5 } },
      { 0: "group" },
    );
    const retained = adapter.getPublication().rowSpace?.getRow("group");

    adapter.reconcileColumns(makeColumns(2), undefined);
    adapter.replace(transport.viewport, { ...groupedQuery, generation: 1 });

    expect(transport.replace).toHaveBeenCalledOnce();
    expect(transport.release).not.toHaveBeenCalled();
    expect(adapter.getPublication().rowSpace?.getRow("group")).toBe(retained);
  });

  it("requires own exact non-negative countDistinct and own positive Rows results", () => {
    const groupedColumns = compileColumns([
      {
        columnId: "COL_ID_DESK",
        field: "desk",
        headerName: "Desk",
        valueType: "text",
        groupBy: true,
      },
      {
        columnId: "COL_ID_DISTINCT_PRICE",
        field: "price",
        headerName: "Distinct price",
        valueType: "number",
        aggFunc: "countDistinct",
      },
    ]);
    const transport = makeViewport<Record<string, unknown>>();
    const adapter = new BrunoTableServerRowPipelineAdapter<Record<string, unknown>>(
      groupedColumns,
      undefined,
      [],
      [{ columnId: "COL_ID_DESK", direction: "asc" }],
      ["desk", "price"],
    );
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect: ["desk", "price"],
      totalRows: 1,
      version: 1,
      status: "ready",
    });
    adapter.replace(transport.viewport, {
      ...query,
      orderBy: [{ columnId: "COL_ID_DESK", direction: "asc" }],
      groupBy: ["COL_ID_DESK"],
      groupOrderBy: [{ columnId: "COL_ID_DESK", direction: "asc" }],
    });
    const request = transport.getRequest()!;
    const aggregates = (request.query as { aggregates: Record<string, { aggFunc: string }> })
      .aggregates;
    const rowsAlias = Object.entries(aggregates).find(
      ([, aggregate]) => aggregate.aggFunc === "count",
    )![0];
    const distinctAlias = Object.entries(aggregates).find(
      ([, aggregate]) => aggregate.aggFunc === "countDistinct",
    )![0];

    for (const value of [null, undefined, -1n]) {
      request.sink.setRowData(
        { 0: { desk: "Rates", [rowsAlias]: 1n, [distinctAlias]: value } },
        { 0: "rates" },
      );
      expect(adapter.getPublication().invalid).toMatchObject({
        kind: "invalid-value",
        rowIndex: 0,
        columnId: "COL_ID_DISTINCT_PRICE",
        message: "Expected an exact bigint aggregate.",
      });
      expect(adapter.getPublication().rowSpace?.loadedRows).toBe(0);
    }

    request.sink.setRowData({ 0: { desk: "Rates", [rowsAlias]: 1n } }, { 0: "rates" });
    expect(adapter.getPublication().invalid).toMatchObject({
      kind: "invalid-value",
      rowIndex: 0,
      columnId: "COL_ID_DISTINCT_PRICE",
    });
    expect(adapter.getPublication().rowSpace?.loadedRows).toBe(0);

    const inheritedRows = Object.assign(Object.create({ [rowsAlias]: 1n }), {
      desk: "Rates",
      [distinctAlias]: 0n,
    }) as Record<string, unknown>;
    request.sink.setRowData({ 0: inheritedRows }, { 0: "rates" });
    expect(adapter.getPublication().invalid).toMatchObject({
      kind: "invalid-value",
      rowIndex: 0,
      columnId: "COL_ID_BRUNO_TABLE_ROWS",
    });
    expect(adapter.getPublication().rowSpace?.loadedRows).toBe(0);

    request.sink.setRowData(
      { 0: { desk: "Rates", [rowsAlias]: 1n, [distinctAlias]: 0n } },
      { 0: "rates" },
    );
    expect(adapter.getPublication().invalid).toBeUndefined();
    expect(adapter.getPublication().rowSpace?.getCellValue("rates", "COL_ID_DISTINCT_PRICE")).toBe(
      0n,
    );
  });

  it("never publishes a new source envelope with old-generation rows", () => {
    const firstTransport = makeViewport();
    const secondTransport = makeViewport();
    const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      columns,
      undefined,
      [],
      query.orderBy,
    );
    adapter.reconcileSource({
      viewport: firstTransport.viewport,
      completeRawSelect,
      totalRows: 100,
      version: 1,
      status: "ready",
    });
    adapter.replace(firstTransport.viewport, query);
    firstTransport.getRequest()!.sink.setRowData({ 0: { symbol: "OLD", price: 1 } }, { 0: "old" });
    const observed: Array<Readonly<{ readonly version: number; readonly rowId?: string }>> = [];
    adapter.subscribePublication(() => {
      const publication = adapter.getPublication();
      const rowId = publication.rowSpace?.getRowId(0);
      observed.push(
        rowId === undefined
          ? { version: publication.version }
          : { version: publication.version, rowId },
      );
    });

    adapter.release();
    adapter.reconcileSource({
      viewport: secondTransport.viewport,
      completeRawSelect,
      totalRows: 200,
      version: 2,
      status: "ready",
    });
    expect(observed).toEqual([{ version: 1 }, { version: 2 }]);
    adapter.replace(secondTransport.viewport, query);
    expect(observed.some((snapshot) => snapshot.version === 2 && snapshot.rowId === "old")).toBe(
      false,
    );
    expect(observed.at(-1)).toEqual({ version: 2 });
  });

  it("releases deterministically and rejects cleanup writes after release", () => {
    const transport = makeViewport();
    const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      columns,
      undefined,
      [],
      query.orderBy,
    );
    adapter.replace(transport.viewport, query);
    const sink = transport.getRequest()!.sink;

    adapter.release();
    expect(transport.release).toHaveBeenCalledTimes(1);
    sink.setRowCount(999, true);
    sink.setRowData({ 0: { symbol: "LATE", price: 0 } }, { 0: "late" });
    expect(adapter.getPublication().rowSpace?.getRowId(0)).toBeUndefined();
  });

  it("publishes direct-release invalidation before preserving a controller failure", () => {
    const releaseFailure = new Error("release failed");
    const transport = makeViewport();
    transport.release.mockImplementationOnce(() => {
      throw releaseFailure;
    });
    const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      columns,
      undefined,
      [],
      query.orderBy,
      completeRawSelect,
    );
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect,
      totalRows: 100,
      version: 1,
      status: "ready",
    });
    adapter.replace(transport.viewport, query);
    transport.getRequest()!.sink.setRowCount(250, true);
    transport.getRequest()!.sink.setRowData({ 0: { symbol: "OLD", price: 1 } }, { 0: "old" });
    const publications: Array<Readonly<{ readonly totalRows: number; readonly hasRows: boolean }>> =
      [];
    adapter.subscribePublication(() => {
      publications.push({
        totalRows: adapter.getResultRowCountSnapshot(),
        hasRows: adapter.getPublication().rowSpace !== undefined,
      });
    });

    expect(() => adapter.release()).toThrow(releaseFailure);
    expect(publications.at(-1)).toEqual({ totalRows: 0, hasRows: false });
    expect(adapter.getPublication().rowSpace).toBeUndefined();
    expect(adapter.getResultRowCountSnapshot()).toBe(0);
  });

  it("replaces only when the normalized source projection changes", () => {
    const transport = makeViewport();
    const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      columns,
      undefined,
      [],
      query.orderBy,
    );
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect,
      totalRows: 100,
      version: 1,
      status: "ready",
    });
    adapter.replace(transport.viewport, query);
    transport.getRequest()?.sink.setRowCount(100, true);
    transport.getRequest()?.sink.setRowData({ 0: { symbol: "OLD", price: 1 } }, { 0: "old" });
    expect(adapter.getPublication().rowSpace?.loadedRows).toBe(1);
    expect(adapter.getPublication().rowSpace?.getRowId(0)).toBe("old");
    expect(adapter.getPublication().rowSpace?.getRow("old")).toMatchObject({ symbol: "OLD" });

    adapter.replace(transport.viewport, { ...query, generation: 1 });
    expect(transport.replace).toHaveBeenCalledTimes(1);

    adapter.reconcileColumns(
      compileColumns([
        {
          columnId: "COL_ID_SYMBOL",
          field: "symbol",
          headerName: "Symbol again",
          valueType: "text",
        },
        {
          columnId: "COL_ID_PRICE",
          field: "price",
          headerName: "Price again",
          valueType: "number",
          pinned: "end",
        },
      ]),
      undefined,
    );
    expect(adapter.getPublication().rowSpace?.getRow("old")).toMatchObject({ symbol: "OLD" });
    adapter.replace(transport.viewport, query);
    expect(transport.replace).toHaveBeenCalledTimes(1);

    adapter.reconcileColumns(
      compileColumns([
        {
          columnId: "COL_ID_SYMBOL",
          field: "symbol",
          headerName: "Symbol",
          valueType: "text",
        },
        {
          columnId: "COL_ID_PRICE",
          fields: ["price", "symbol"],
          headerName: "Derived price",
          valueType: "number",
          valueGetter: ({ row }: { readonly row: Row }) => row.price,
        },
      ]),
      undefined,
    );
    expect(adapter.getPublication().rowSpace?.getRow("old")).toMatchObject({ symbol: "OLD" });
    adapter.replace(transport.viewport, query);
    expect(transport.replace).toHaveBeenCalledTimes(1);

    adapter.reconcileColumns(
      compileColumns([
        {
          columnId: "COL_ID_SYMBOL",
          field: "symbol",
          headerName: "Symbol",
          valueType: "text",
        },
        {
          columnId: "COL_ID_PRICE",
          fields: ["symbol"],
          headerName: "Derived price",
          valueType: "number",
          valueGetter: ({ row }: { readonly row: Row }) => row.price,
        },
      ]),
      undefined,
    );
    expect(adapter.getPublication().rowSpace?.getRow("old")).toMatchObject({ symbol: "OLD" });
    expect(transport.release).not.toHaveBeenCalled();
    adapter.replace(transport.viewport, query);
    expect(adapter.getPublication().rowSpace?.loadedRows).toBe(0);
    expect(adapter.getPublication().rowSpace?.getRow("old")).toBeUndefined();
    expect(transport.replace).toHaveBeenCalledTimes(2);
    expect(transport.release).toHaveBeenCalledTimes(1);
  });

  it("replaces exactly once when raw-row presentation changes projection mode", () => {
    const transport = makeViewport();
    const completeRawSelect = ["symbol", "price", "desk"] as const;
    const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      columns,
      undefined,
      [],
      query.orderBy,
      completeRawSelect,
    );
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect,
      totalRows: 100,
      version: 1,
      status: "ready",
    });
    adapter.replace(transport.viewport, query);
    expect(transport.getRequest()?.query).toMatchObject({ select: ["symbol", "price"] });

    const presentedColumns = compileColumns([
      {
        columnId: "COL_ID_SYMBOL",
        field: "symbol",
        headerName: "Symbol",
        valueType: "text",
        valueFormatter: () => "formatted",
      },
      columns[1]!,
    ]);
    adapter.reconcileColumns(presentedColumns, undefined);
    expect(transport.release).not.toHaveBeenCalled();
    adapter.replace(transport.viewport, { ...query, generation: 1 });
    expect(adapter.getPublication().rowSpace?.loadedRows).toBe(0);
    expect(transport.release).toHaveBeenCalledTimes(1);
    expect(transport.replace).toHaveBeenCalledTimes(2);
    expect(transport.getRequest()?.query).toMatchObject({ select: completeRawSelect });

    adapter.reconcileColumns(
      compileColumns([
        {
          columnId: "COL_ID_SYMBOL",
          field: "symbol",
          headerName: "Symbol again",
          valueType: "text",
          cellRenderer: () => "rendered",
        },
        columns[1]!,
      ]),
      undefined,
    );
    adapter.replace(transport.viewport, { ...query, generation: 2 });
    expect(transport.replace).toHaveBeenCalledTimes(2);
    expect(transport.release).toHaveBeenCalledTimes(1);

    adapter.reconcileColumns(columns, undefined);
    expect(transport.release).toHaveBeenCalledTimes(1);
    adapter.replace(transport.viewport, { ...query, generation: 3 });
    expect(transport.release).toHaveBeenCalledTimes(2);
    expect(transport.replace).toHaveBeenCalledTimes(3);
    expect(transport.getRequest()?.query).toMatchObject({ select: ["symbol", "price"] });
  });

  it("keeps one filtered source generation across unrelated same-field columns", () => {
    const equivalentColumns = compileColumns([
      {
        columnId: "COL_ID_SYMBOL_PRIMARY",
        field: "symbol",
        headerName: "Primary symbol",
        valueType: "text",
      },
      {
        columnId: "COL_ID_SYMBOL_SECONDARY",
        field: "symbol",
        headerName: "Secondary symbol",
        valueType: "text",
      },
    ]);
    const transport = makeViewport();
    const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      equivalentColumns,
      undefined,
      [],
      [{ columnId: "COL_ID_SYMBOL_PRIMARY", direction: "asc" }],
    );

    adapter.replace(transport.viewport, {
      ...query,
      filters: [{ columnId: "COL_ID_SYMBOL_PRIMARY", type: "startsWith", filter: "A" }],
      orderBy: [{ columnId: "COL_ID_SYMBOL_PRIMARY", direction: "asc" }],
    });
    adapter.reconcileColumns(
      compileColumns([
        {
          columnId: "COL_ID_SYMBOL_PRIMARY",
          field: "symbol",
          headerName: "Primary symbol",
          valueType: "text",
        },
      ]),
      undefined,
    );
    adapter.replace(transport.viewport, {
      ...query,
      generation: 1,
      filters: [{ columnId: "COL_ID_SYMBOL_PRIMARY", type: "startsWith", filter: "A" }],
      orderBy: [{ columnId: "COL_ID_SYMBOL_PRIMARY", direction: "asc" }],
    });
    adapter.reconcileColumns(equivalentColumns.toReversed(), undefined);
    adapter.replace(transport.viewport, {
      ...query,
      generation: 2,
      filters: [{ columnId: "COL_ID_SYMBOL_PRIMARY", type: "startsWith", filter: "A" }],
      orderBy: [{ columnId: "COL_ID_SYMBOL_PRIMARY", direction: "asc" }],
    });

    expect(transport.replace).toHaveBeenCalledTimes(1);
    expect(transport.release).not.toHaveBeenCalled();

    adapter.replace(transport.viewport, {
      ...query,
      generation: 3,
      filters: [{ columnId: "COL_ID_SYMBOL_PRIMARY", type: "startsWith", filter: "B" }],
      orderBy: [{ columnId: "COL_ID_SYMBOL_PRIMARY", direction: "asc" }],
    });
    expect(transport.replace).toHaveBeenCalledTimes(2);
    expect(transport.release).toHaveBeenCalledTimes(1);
  });

  it("keeps one source generation when presentation reorders distinct projection fields", () => {
    const transport = makeViewport();
    const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      columns,
      undefined,
      [],
      query.orderBy,
    );

    adapter.replace(transport.viewport, query);
    expect(transport.getRequest()?.query).toEqual({
      select: ["symbol", "price"],
      where: [],
      orderBy: [{ field: "symbol", direction: "asc" }],
    });

    adapter.reconcileColumns(columns.toReversed(), undefined);
    adapter.replace(transport.viewport, { ...query, generation: 1 });

    expect(transport.replace).toHaveBeenCalledTimes(1);
    expect(transport.release).not.toHaveBeenCalled();
    expect(transport.getRequest()?.query).toEqual({
      select: ["symbol", "price"],
      where: [],
      orderBy: [{ field: "symbol", direction: "asc" }],
    });
  });

  it("ignores hidden computed dependencies and presentation until the column becomes visible", () => {
    const transport = makeViewport();
    const initialColumns = compileColumns([
      columns[0]!,
      {
        columnId: "COL_ID_DERIVED",
        fields: ["price"],
        headerName: "Derived",
        valueType: "number",
        valueGetter: () => 0,
      },
    ]);
    const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      initialColumns,
      undefined,
      [],
      query.orderBy,
      completeRawSelect,
    );
    const visibleSymbol = {
      routeBy: undefined,
      externalFilters: undefined,
      visibleColumnIds: ["COL_ID_SYMBOL"],
    } as const;

    adapter.replace(transport.viewport, query, visibleSymbol);
    expect(transport.getRequest()?.query).toMatchObject({ select: ["symbol"] });

    adapter.reconcileColumns(
      compileColumns([
        columns[0]!,
        {
          columnId: "COL_ID_DERIVED",
          fields: ["symbol"],
          headerName: "Derived again",
          valueType: "number",
          valueGetter: () => 1,
          cellRenderer: () => "rendered",
        },
      ]),
      undefined,
    );
    adapter.replace(transport.viewport, { ...query, generation: 1 }, visibleSymbol);

    expect(transport.replace).toHaveBeenCalledTimes(1);
    expect(transport.release).not.toHaveBeenCalled();

    adapter.replace(
      transport.viewport,
      { ...query, generation: 2 },
      {
        routeBy: undefined,
        externalFilters: undefined,
        visibleColumnIds: ["COL_ID_SYMBOL", "COL_ID_DERIVED"],
      },
    );
    expect(transport.replace).toHaveBeenCalledTimes(2);
    expect(transport.release).toHaveBeenCalledTimes(1);
    expect(transport.getRequest()?.query).toMatchObject({ select: completeRawSelect });
  });

  it("records visibility after a semantic no-op for later column reconciliation", () => {
    const transport = makeViewport();
    const initialColumns = compileColumns([
      columns[0]!,
      {
        columnId: "COL_ID_DERIVED",
        fields: ["symbol"],
        headerName: "Derived",
        valueType: "number",
        valueGetter: () => 0,
      },
    ]);
    const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      initialColumns,
      undefined,
      [],
      query.orderBy,
    );

    adapter.replace(transport.viewport, query, {
      routeBy: undefined,
      externalFilters: undefined,
      visibleColumnIds: ["COL_ID_SYMBOL"],
    });
    adapter.replace(
      transport.viewport,
      { ...query, generation: 1 },
      {
        routeBy: undefined,
        externalFilters: undefined,
        visibleColumnIds: ["COL_ID_SYMBOL", "COL_ID_DERIVED"],
      },
    );
    expect(transport.replace).toHaveBeenCalledTimes(1);

    adapter.reconcileColumns(
      compileColumns([
        columns[0]!,
        {
          columnId: "COL_ID_DERIVED",
          fields: ["price"],
          headerName: "Derived",
          valueType: "number",
          valueGetter: () => 0,
        },
      ]),
      undefined,
    );

    expect(transport.release).not.toHaveBeenCalled();
    adapter.replace(
      transport.viewport,
      { ...query, generation: 2 },
      {
        routeBy: undefined,
        externalFilters: undefined,
        visibleColumnIds: ["COL_ID_SYMBOL", "COL_ID_DERIVED"],
      },
    );
    expect(transport.release).toHaveBeenCalledTimes(1);
    expect(transport.replace).toHaveBeenCalledTimes(2);
  });

  it("defers projection until replacement visibility exists for new Column Identities", () => {
    const transport = makeViewport();
    const first = compileColumns([columns[0]!]);
    const second = compileColumns([
      {
        columnId: "COL_ID_REPLACEMENT",
        field: "price",
        headerName: "Replacement",
        valueType: "number",
      },
    ]);
    const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      first,
      undefined,
      [],
      [{ columnId: "COL_ID_SYMBOL", direction: "asc" }],
    );
    adapter.replace(
      transport.viewport,
      { ...query, orderBy: [{ columnId: "COL_ID_SYMBOL", direction: "asc" }] },
      {
        routeBy: undefined,
        externalFilters: undefined,
        visibleColumnIds: ["COL_ID_SYMBOL"],
      },
    );

    expect(() => adapter.reconcileColumns(second, undefined)).not.toThrow();
    adapter.replace(
      transport.viewport,
      { ...query, orderBy: [{ columnId: "COL_ID_REPLACEMENT", direction: "asc" }] },
      {
        routeBy: undefined,
        externalFilters: undefined,
        visibleColumnIds: ["COL_ID_REPLACEMENT"],
      },
    );

    expect(transport.release).toHaveBeenCalledTimes(1);
    expect(transport.replace).toHaveBeenCalledTimes(2);
    expect(transport.getRequest()?.query).toMatchObject({ select: ["price"] });
  });

  it("defers partial Column Identity projection until final reconciled visibility", () => {
    const transport = makeViewport();
    const first = compileColumns([
      {
        columnId: "COL_ID_A",
        field: "symbol",
        headerName: "A",
        valueType: "text",
      },
      {
        columnId: "COL_ID_B",
        field: "price",
        headerName: "B",
        valueType: "number",
      },
    ]);
    const second = compileColumns([
      first[1]!,
      {
        columnId: "COL_ID_C",
        field: "symbol",
        headerName: "C",
        valueType: "text",
      },
    ]);
    const stableQuery = {
      ...query,
      orderBy: [{ columnId: "COL_ID_B", direction: "asc" as const }],
    };
    const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      first,
      undefined,
      [],
      stableQuery.orderBy,
    );
    adapter.replace(transport.viewport, stableQuery, {
      routeBy: undefined,
      externalFilters: undefined,
      visibleColumnIds: ["COL_ID_A", "COL_ID_B"],
    });
    transport.getRequest()?.sink.setRowData({ 0: { symbol: "AAA", price: 10 } }, { 0: "row-1" });
    const retained = adapter.getPublication().rowSpace?.getRow("row-1");

    adapter.reconcileColumns(second, undefined);
    adapter.replace(transport.viewport, stableQuery, {
      routeBy: undefined,
      externalFilters: undefined,
      visibleColumnIds: ["COL_ID_B", "COL_ID_C"],
    });

    expect(transport.replace).toHaveBeenCalledTimes(1);
    expect(transport.release).not.toHaveBeenCalled();
    expect(adapter.getPublication().rowSpace?.getRow("row-1")).toBe(retained);
  });

  it("keeps hidden computed and raw-row presentation dormant during equivalent deliveries", () => {
    const run = (kind: "computed" | "raw-presentation") => {
      const hiddenGetter = vi.fn(() => 1);
      const hiddenColumn =
        kind === "computed"
          ? {
              columnId: "COL_ID_HIDDEN",
              fields: ["price"] as const,
              headerName: "Hidden derived",
              valueType: "number" as const,
              valueGetter: hiddenGetter,
            }
          : {
              columnId: "COL_ID_HIDDEN",
              field: "price" as const,
              headerName: "Hidden raw presentation",
              valueType: "number" as const,
              valueFormatter: () => "formatted",
            };
      const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
        compileColumns([columns[0]!, hiddenColumn]),
        undefined,
        [],
        query.orderBy,
        completeRawSelect,
      );
      const transport = makeViewport();
      adapter.reconcileSource({
        viewport: transport.viewport,
        completeRawSelect,
        totalRows: 1,
        version: 1,
        status: "ready",
      });
      adapter.replace(transport.viewport, query, {
        routeBy: undefined,
        externalFilters: undefined,
        visibleColumnIds: ["COL_ID_SYMBOL"],
      });
      const stable = { symbol: "AAPL", price: 1 } as const;
      transport.getRequest()!.sink.setRowData({ 0: stable }, { 0: "row-a" });
      const publish = vi.fn();
      adapter.subscribePublication(publish);
      hiddenGetter.mockClear();

      transport.getRequest()!.sink.setRowData({ 0: { symbol: "AAPL", price: 1 } }, { 0: "row-a" });

      expect(hiddenGetter).not.toHaveBeenCalled();
      expect(adapter.getPublication().rowSpace?.getRow("row-a")).toBe(stable);
      expect(publish).not.toHaveBeenCalled();
    };

    run("computed");
    run("raw-presentation");
  });

  it("uses the shared Quick Filter field admission policy", () => {
    expect(
      () =>
        new BrunoTableServerRowPipelineAdapter<Row>(
          columns,
          ["symbol", "symbol"],
          [],
          query.orderBy,
        ),
    ).not.toThrow();
    expect(
      () => new BrunoTableServerRowPipelineAdapter<Row>(columns, [""], [], query.orderBy),
    ).toThrow("non-empty source fields");
    expect(
      () =>
        new BrunoTableServerRowPipelineAdapter<Row>(
          columns,
          Array.from({ length: 257 }, () => "symbol"),
          [],
          query.orderBy,
        ),
    ).toThrow("between 1 and 256 fields");
  });

  it("retains moved row references through compiled exact BigDecimal semantics", () => {
    type ExactRow = Readonly<{
      readonly symbol: string;
      readonly amount: BigDecimal.BigDecimal;
      readonly desk: string;
    }>;
    const exactDefinitions = [
      {
        columnId: "COL_ID_SYMBOL",
        field: "symbol",
        headerName: "Symbol",
        valueType: "text",
      },
      BrunoTableBigDecimalColumn({
        columnId: "COL_ID_AMOUNT",
        field: "amount",
        headerName: "Amount",
      }),
    ] satisfies BrunoTableColumns<ExactRow>;
    const exactColumns = compileColumns(exactDefinitions);
    const transport = makeViewport();
    const adapter = new BrunoTableServerRowPipelineAdapter<ExactRow>(
      exactColumns,
      undefined,
      [],
      query.orderBy,
    );
    adapter.reconcileSource({
      viewport: transport.viewport,
      completeRawSelect: ["symbol", "amount"],
      totalRows: 100,
      version: 1,
      status: "ready",
    });
    adapter.replace(transport.viewport, query);
    const sink = transport.getRequest()!.sink as unknown as Readonly<{
      readonly setRowData: (
        rows: Readonly<Record<number, ExactRow>>,
        keys: Readonly<Record<number, string>>,
      ) => void;
    }>;
    const stable = {
      symbol: "AAPL",
      amount: BigDecimal.fromStringUnsafe("1.50"),
      desk: "LDN",
    } as const;
    sink.setRowData({ 0: stable }, { 0: "row-a" });
    sink.setRowData(
      { 1: { symbol: "AAPL", amount: BigDecimal.fromStringUnsafe("1.5"), desk: "LDN" } },
      { 1: "row-a" },
    );
    expect(adapter.getPublication().rowSpace?.getRow("row-a")).toBe(stable);
    expect(adapter.findRowIndex("row-a")).toBe(1);

    sink.setRowData(
      { 1: { symbol: "AAPL", amount: BigDecimal.fromStringUnsafe("1.5"), desk: "NYC" } },
      { 1: "row-a" },
    );
    expect(adapter.getPublication().rowSpace?.getRow("row-a")).toMatchObject({ desk: "NYC" });
    expect(adapter.getPublication().rowSpace?.getRow("row-a")).not.toBe(stable);
  });

  it("distinguishes delimiter-bearing projection field tuples", () => {
    const transport = makeViewport();
    const first = compileColumns([
      columns[0],
      {
        columnId: "COL_ID_COMPUTED",
        fields: ["a\u001fb"],
        headerName: "Computed",
        valueType: "text",
        valueGetter: () => "",
      },
    ]);
    const second = compileColumns([
      columns[0],
      {
        columnId: "COL_ID_COMPUTED",
        fields: ["a", "b"],
        headerName: "Computed",
        valueType: "text",
        valueGetter: () => "",
      },
    ]);
    const adapter = new BrunoTableServerRowPipelineAdapter<Row>(
      first,
      undefined,
      [],
      query.orderBy,
    );
    adapter.replace(transport.viewport, query);
    adapter.reconcileColumns(second, undefined);
    adapter.replace(transport.viewport, query);
    expect(transport.replace).toHaveBeenCalledTimes(2);
    expect(transport.release).toHaveBeenCalledTimes(1);
  });
});
