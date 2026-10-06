import { describe, expect, it, vi } from "vitest";

import { compileColumns, type CompiledColumn } from "./compile-columns";
import { createBrunoTableClientFacetStore } from "./client-facet";
import { BrunoTableSelectColumn } from "../column-helpers";
import {
  BrunoTableClientRowPipelineAdapter,
  type BrunoTableClientReconciliationEvent,
  type BrunoTableClientRowOrderChangeDetector,
  installBrunoTableClientReconciliationListener,
  installBrunoTableClientValueCachePruneListener,
} from "./client-source-adapter";
import { BrunoTableClientProjectionStore } from "./client-row-pipeline";
import type { BrunoTableClientAdmittedRow } from "./client-source-adapter";
import { BrunoTableGridRuntime, isBrunoTableInvalidCellValue } from "./grid-runtime";
import { sanitizeClientInitialFilters, sameBrunoTableFilterCollection } from "./grid-query";
import { BRUNO_TABLE_MAX_QUICK_FILTER_LENGTH } from "./quick-filter";
import type { BrunoTableValueType } from "../public-types";

type Row = { readonly id: string; readonly name: string; readonly note?: string };

const source = (
  rows: readonly Row[],
  status: "loading" | "ready" | "stale" | "closed" | "error" = "ready",
  extra: Partial<{
    readonly totalRows: number;
    readonly statusCode: string;
    readonly message: string;
    readonly retry: { readonly run: () => void; readonly pending: boolean };
  }> = {},
) => ({
  rows,
  totalRows: extra.totalRows ?? rows.length,
  version: 1,
  status,
  ...(extra.statusCode === undefined ? {} : { statusCode: extra.statusCode }),
  ...(extra.message === undefined ? {} : { message: extra.message }),
  ...(extra.retry === undefined ? {} : { retry: extra.retry }),
});

const runtimeColumns = compileColumns([
  {
    columnId: "COL_ID_NAME",
    field: "name",
    headerName: "Name",
    valueType: "text",
  },
]);

const parserValueType = (acceptsNew: boolean): BrunoTableValueType<string, "text", "text"> => ({
  codecId: "test/filter-parser-cache",
  codecVersion: 1,
  filterFamily: "text",
  editorFamily: "text",
  cellAlign: "start",
  editorLayout: "inline",
  defaultWidth: 120,
  decodeRuntime: (input) =>
    typeof input === "string"
      ? { _tag: "Success", value: input }
      : { _tag: "Failure", message: "Expected text." },
  equivalent: (left, right) => left === right,
  compare: (left, right) => (left === right ? 0 : left < right ? -1 : 1),
  formatCanonicalText: (value) => value,
  parseCanonicalText: (text) =>
    acceptsNew && text === "new"
      ? { _tag: "Success", value: text }
      : { _tag: "Failure", message: "Parser rejected." },
  formatDisplay: (value) => value,
  encodePersisted: (value) => value,
  decodePersisted: (input) =>
    typeof input === "string"
      ? { _tag: "Success", value: input }
      : { _tag: "Failure", message: "Expected persisted text." },
});

const rawRows = (admitted: readonly BrunoTableClientAdmittedRow[]): readonly unknown[] =>
  admitted.map((row) => row.raw);

const createRuntime = (
  initialSource: ReturnType<typeof source>,
  getRowId: (row: Row) => string = (row) => row.id,
) =>
  createClientRuntime(initialSource, getRowId, runtimeColumns, undefined, [
    { columnId: "COL_ID_NAME", direction: "asc" },
  ]);

function createClientRuntime(
  initialSource: ReturnType<typeof source>,
  initialGetRowId: (row: Row) => string,
  columns: readonly CompiledColumn[],
  initialFilters: readonly unknown[] | undefined,
  initialOrderBy: readonly { readonly columnId: string; readonly direction: "asc" | "desc" }[],
) {
  const adapter = new BrunoTableClientRowPipelineAdapter(
    initialSource,
    initialGetRowId,
    columns,
    initialFilters,
    initialOrderBy,
  );
  const runtime = new BrunoTableGridRuntime(
    adapter.getPublication(),
    columns,
    adapter.getQueryConfiguration(columns),
    "TABLE_ID_GRID_RUNTIME_CREATE_CLIENT",
  );
  const view = runtime.getView();
  const acceptCurrentRows = () => {
    const rows = adapter.createRowsStore(view, () => () => true).getSnapshot();
    adapter.acceptRows(rows);
  };
  acceptCurrentRows();
  return Object.freeze({
    ...view,
    getView: runtime.getView,
    resolveRowId: adapter.resolveRowId,
    createRowsStore: (detector: BrunoTableClientRowOrderChangeDetector) =>
      adapter.createRowsStore(view, () => detector),
    publish: (nextSource: ReturnType<typeof source>) => {
      runtime.publish(adapter.publish(nextSource));
      acceptCurrentRows();
    },
    reconcile: (
      nextSource: ReturnType<typeof source>,
      nextGetRowId: (row: Row) => string,
      nextColumns: readonly CompiledColumn[],
    ) => {
      const queryConfiguration = adapter.getQueryConfiguration(nextColumns);
      runtime.reconcile(
        adapter.reconcile(nextSource, nextGetRowId, nextColumns),
        nextColumns,
        queryConfiguration,
      );
      acceptCurrentRows();
    },
    configure: (nextGetRowId: (row: Row) => string, nextColumns: readonly CompiledColumn[]) => {
      const queryConfiguration = adapter.getQueryConfiguration(nextColumns);
      runtime.reconcile(
        adapter.configure(nextGetRowId, nextColumns),
        nextColumns,
        queryConfiguration,
      );
      acceptCurrentRows();
    },
  });
}

describe("BrunoTableGridRuntime sorting invariant", () => {
  it("notifies every Result Row Count subscriber before rethrowing a listener failure", () => {
    const adapter = new BrunoTableClientRowPipelineAdapter(
      source([{ id: "first", name: "Ada" }]),
      (row: Row) => row.id,
      runtimeColumns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const laterListener = vi.fn();
    adapter.subscribeResultRowCount(() => {
      throw new Error("listener failed");
    });
    adapter.subscribeResultRowCount(laterListener);

    expect(() => adapter.publishResultRowCount(0)).toThrow("listener failed");
    expect(laterListener).toHaveBeenCalledOnce();
    expect(adapter.getResultRowCountSnapshot()).toBe(0);
  });

  it("normalizes an empty baseline when sortable columns are installed", () => {
    const adapter = new BrunoTableClientRowPipelineAdapter(
      source([]),
      (row: Row) => row.id,
      runtimeColumns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const runtime = new BrunoTableGridRuntime(
      adapter.getPublication(),
      runtimeColumns,
      { baselineFilters: [], baselineOrderBy: [] },
      "TABLE_ID_NON_EMPTY_SORTING",
    );

    expect(runtime.getView().getSortingSnapshot()).toEqual([
      { columnId: "COL_ID_NAME", direction: "asc" },
    ]);
  });
});

describe("BrunoTableGridRuntime Client grouping intent", () => {
  it("notifies the Group By tuple only for accepted tuple changes", () => {
    const groupedColumns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
        groupBy: true,
      },
    ]);
    const adapter = new BrunoTableClientRowPipelineAdapter(
      source([{ id: "first", name: "Ada" }]),
      (row: Row) => row.id,
      groupedColumns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const runtime = new BrunoTableGridRuntime(
      adapter.getPublication(),
      groupedColumns,
      adapter.getQueryConfiguration(groupedColumns),
      "TABLE_ID_GROUP_BY_SUBSCRIPTION",
      { grouping: true },
    );
    const view = runtime.getView();
    const listener = vi.fn();
    view.subscribeGroupBy(listener);

    expect(view.getGroupBySnapshot()).toEqual([]);
    view.dispatchGridCommand({ type: "quick-filter.replace", text: "Ada" });
    expect(listener).not.toHaveBeenCalled();

    view.dispatchGridCommand({ type: "grouping.add", columnId: "COL_ID_NAME" });
    expect(listener).toHaveBeenCalledOnce();
    expect(view.getGroupBySnapshot()).toEqual(["COL_ID_NAME"]);

    view.dispatchGridCommand({
      type: "column.sort.toggle",
      columnId: "COL_ID_NAME",
      multi: false,
    });
    view.dispatchGridCommand({
      type: "column.resize.commit",
      columnId: "COL_ID_BRUNO_TABLE_ROWS",
      width: 180,
    });
    expect(listener).toHaveBeenCalledOnce();

    view.dispatchGridCommand({ type: "grouping.remove", columnId: "COL_ID_NAME" });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(view.getGroupBySnapshot()).toEqual([]);
  });

  it("resets the dormant Rows width atomically with width and full-layout resets", () => {
    const groupedColumns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
        groupBy: true,
      },
    ]);
    const adapter = new BrunoTableClientRowPipelineAdapter(
      source([{ id: "first", name: "Ada" }]),
      (row: Row) => row.id,
      groupedColumns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const persisted: Readonly<Record<string, unknown>>[] = [];
    const runtime = new BrunoTableGridRuntime(
      adapter.getPublication(),
      groupedColumns,
      adapter.getQueryConfiguration(groupedColumns),
      "TABLE_ID_ROWS_WIDTH_RESET",
      { grouping: true, getOnPersistChange: () => (state) => persisted.push(state) },
    );
    const view = runtime.getView();
    const resizeAndUngroup = () => {
      view.dispatchGridCommand({ type: "grouping.add", columnId: "COL_ID_NAME" });
      view.dispatchGridCommand({
        type: "column.resize.commit",
        columnId: "COL_ID_BRUNO_TABLE_ROWS",
        width: 180,
      });
      view.dispatchGridCommand({ type: "grouping.remove", columnId: "COL_ID_NAME" });
      expect(view.getQuerySnapshot().rowsWidth).toBe(180);
      expect(persisted.at(-1)?.["columnWidths"]).toMatchObject({
        COL_ID_BRUNO_TABLE_ROWS: 180,
      });
    };

    resizeAndUngroup();
    const widthResetPersistenceCount = persisted.length;
    expect(view.dispatchGridCommand({ type: "column.reset.widths" })).toBe(true);
    expect(persisted).toHaveLength(widthResetPersistenceCount + 1);
    expect(persisted.at(-1)?.["columnWidths"]).not.toHaveProperty("COL_ID_BRUNO_TABLE_ROWS");

    resizeAndUngroup();
    const layoutResetPersistenceCount = persisted.length;
    expect(view.dispatchGridCommand({ type: "column.reset.layout" })).toBe(true);
    expect(persisted).toHaveLength(layoutResetPersistenceCount + 1);
    expect(persisted.at(-1)?.["columnWidths"]).not.toHaveProperty("COL_ID_BRUNO_TABLE_ROWS");
  });

  it("keeps non-order base column preferences operable while grouped", () => {
    const groupedColumns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
        groupBy: true,
      },
      {
        columnId: "COL_ID_NOTE",
        field: "note",
        headerName: "Note",
        valueType: "text",
        aggFunc: "countDistinct",
      },
      {
        columnId: "COL_ID_DORMANT",
        field: "note",
        headerName: "Dormant",
        valueType: "text",
      },
    ]);
    const adapter = new BrunoTableClientRowPipelineAdapter(
      source([{ id: "first", name: "Ada", note: "first" }]),
      (row: Row) => row.id,
      groupedColumns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const persisted: Readonly<Record<string, unknown>>[] = [];
    const runtime = new BrunoTableGridRuntime(
      adapter.getPublication(),
      groupedColumns,
      adapter.getQueryConfiguration(groupedColumns),
      "TABLE_ID_GROUPED_BASE_RESETS",
      { grouping: true, getOnPersistChange: () => (state) => persisted.push(state) },
    );
    const view = runtime.getView();
    const projectionStore = new BrunoTableClientProjectionStore(view, adapter, undefined);
    const deactivateProjection = projectionStore.activate();

    view.dispatchGridCommand({ type: "grouping.add", columnId: "COL_ID_NAME" });
    const groupedStructure = view.getInstalledGroupingStructureSnapshot();
    const structureNotifications = vi.fn();
    const unsubscribeStructure = view.subscribeInstalledGroupingStructure(structureNotifications);
    const persistenceBeforeKeyResize = persisted.length;
    expect(
      view.dispatchGridCommand({
        type: "column.resize.commit",
        columnId: "COL_ID_NAME",
        width: 210,
      }),
    ).toBe(true);
    expect(persisted).toHaveLength(persistenceBeforeKeyResize + 1);
    expect(persisted.at(-1)?.["columnWidths"]).toMatchObject({ COL_ID_NAME: 210 });
    expect(structureNotifications).toHaveBeenCalledOnce();
    expect(view.getInstalledGroupingStructureSnapshot()).not.toBe(groupedStructure);
    expect(
      view
        .getInstalledClientProjectionSnapshot()
        ?.columns.find(({ columnId }) => columnId === "COL_ID_NAME")?.semantics.width,
    ).toBe(210);
    expect(
      view.dispatchGridCommand({
        type: "column.resize.commit",
        columnId: "COL_ID_DORMANT",
        width: 220,
      }),
    ).toBe(false);
    expect(
      view.dispatchGridCommand({
        type: "column.reorder.commit",
        columnId: "COL_ID_NAME",
        targetIndex: 1,
        pinned: undefined,
      }),
    ).toBe(false);
    unsubscribeStructure();
    view.dispatchGridCommand({ type: "grouping.remove", columnId: "COL_ID_NAME" });
    expect(view.getColumnCommandSnapshot("COL_ID_NAME").width).toBe(210);
    view.dispatchGridCommand({ type: "grouping.add", columnId: "COL_ID_NAME" });
    expect(
      view
        .getInstalledClientProjectionSnapshot()
        ?.columns.find(({ columnId }) => columnId === "COL_ID_NAME")?.semantics.width,
    ).toBe(210);
    expect(
      view.dispatchGridCommand({
        type: "column.pin.commit",
        columnId: "COL_ID_NOTE",
        pinned: "start",
      }),
    ).toBe(true);
    expect(
      view.dispatchGridCommand({
        type: "column.resize.commit",
        columnId: "COL_ID_NOTE",
        width: 240,
      }),
    ).toBe(true);
    expect(
      view.dispatchGridCommand({
        type: "column.visibility.commit",
        columnId: "COL_ID_NOTE",
        visible: false,
      }),
    ).toBe(true);
    expect(
      view.dispatchGridCommand({
        type: "column.resize.commit",
        columnId: "COL_ID_NOTE",
        width: 250,
      }),
    ).toBe(false);

    const widthResetCount = persisted.length;
    expect(view.dispatchGridCommand({ type: "column.reset.widths" })).toBe(true);
    expect(persisted).toHaveLength(widthResetCount + 1);
    expect(persisted.at(-1)?.["columnWidths"]).not.toHaveProperty("COL_ID_NOTE");

    const visibilityResetCount = persisted.length;
    expect(view.dispatchGridCommand({ type: "column.reset.visibility" })).toBe(true);
    expect(persisted).toHaveLength(visibilityResetCount + 1);
    expect(persisted.at(-1)?.["columnVisibility"]).toMatchObject({ COL_ID_NOTE: true });

    const pinningResetCount = persisted.length;
    expect(view.dispatchGridCommand({ type: "column.reset.pinning" })).toBe(true);
    expect(persisted).toHaveLength(pinningResetCount + 1);
    expect(persisted.at(-1)?.["columnPinning"]).toEqual({ start: [], end: [] });

    expect(view.getColumnCommandSnapshot("COL_ID_NOTE")).toMatchObject({
      visible: true,
      width: 160,
    });
    expect(view.getColumnCommandSnapshot("COL_ID_NOTE").pinned).toBeUndefined();
    expect(view.dispatchGridCommand({ type: "column.reset.order" })).toBe(false);
    expect(view.dispatchGridCommand({ type: "column.reset.layout" })).toBe(false);

    view.dispatchGridCommand({ type: "grouping.remove", columnId: "COL_ID_NAME" });
    expect(view.getColumnCommandSnapshot("COL_ID_NOTE")).toMatchObject({
      visible: true,
      width: 160,
    });
    expect(view.getColumnCommandSnapshot("COL_ID_NOTE").pinned).toBeUndefined();
    deactivateProjection();
  });

  it("keeps normal and grouped sort contexts separate and orders the shape transition hook first", () => {
    const groupedColumns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
        groupBy: true,
      },
      {
        columnId: "COL_ID_AMOUNT",
        field: "amount",
        headerName: "Amount",
        valueType: "bigint",
        aggFunc: "sum",
        enableSorting: false,
      },
      {
        columnId: "COL_ID_PLAIN",
        field: "note",
        headerName: "Plain dormant column",
        valueType: "text",
      },
    ]);
    const initialRows = [{ id: "first", name: "Ada", amount: 2n }];
    const initialSource = source(initialRows);
    const adapter = new BrunoTableClientRowPipelineAdapter(
      initialSource,
      (row: Row) => row.id,
      groupedColumns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "desc" }],
    );
    const transitions: string[] = [];
    const persisted: Readonly<Record<string, unknown>>[] = [];
    const runtime = new BrunoTableGridRuntime(
      adapter.getPublication(),
      groupedColumns,
      adapter.getQueryConfiguration(groupedColumns),
      "TABLE_ID_GROUPING_RUNTIME",
      {
        grouping: true,
        groupRowsWidth: 112,
        beforeGroupingChange: (entering) => transitions.push(`before:${String(entering)}`),
        getOnPersistChange: () => (state) => persisted.push(state),
      },
    );
    runtime.getView().subscribeQuery(() => transitions.push("query"));

    expect(
      runtime.getView().dispatchGridCommand({
        type: "grouping.add",
        columnId: "COL_ID_NAME",
      }),
    ).toBe(true);
    expect(transitions).toEqual(["before:true", "query"]);
    expect(runtime.getView().getQuerySnapshot()).toMatchObject({
      orderBy: [{ columnId: "COL_ID_NAME", direction: "desc" }],
      groupBy: ["COL_ID_NAME"],
      groupOrderBy: [{ columnId: "COL_ID_NAME", direction: "asc" }],
    });
    expect(persisted.at(-1)?.["columnWidths"]).not.toHaveProperty("COL_ID_BRUNO_TABLE_ROWS");
    expect(
      runtime.getView().dispatchGridCommand({
        type: "column.resize.commit",
        columnId: "COL_ID_BRUNO_TABLE_ROWS",
        width: 180,
      }),
    ).toBe(true);
    expect(transitions).toEqual(["before:true", "query", "query"]);
    expect(persisted.at(-1)?.["columnWidths"]).toMatchObject({
      COL_ID_BRUNO_TABLE_ROWS: 180,
    });

    runtime.getView().dispatchGridCommand({
      type: "column.sort.toggle",
      columnId: "COL_ID_BRUNO_TABLE_ROWS",
      multi: false,
    });
    expect(transitions).toEqual(["before:true", "query", "query", "query"]);
    expect(runtime.getView().getQuerySnapshot()).toMatchObject({
      orderBy: [{ columnId: "COL_ID_NAME", direction: "desc" }],
      groupOrderBy: [{ columnId: "COL_ID_BRUNO_TABLE_ROWS", direction: "asc" }],
    });
    expect(
      runtime.getView().dispatchGridCommand({
        type: "sorting.remove",
        columnId: "COL_ID_BRUNO_TABLE_ROWS",
      }),
    ).toBe(true);
    expect(runtime.getView().getQuerySnapshot().groupOrderBy).toHaveLength(1);
    expect(
      runtime.getView().dispatchGridCommand({
        type: "column.reorder.commit",
        columnId: "COL_ID_AMOUNT",
        targetIndex: 0,
        pinned: undefined,
      }),
    ).toBe(false);

    runtime.getView().dispatchGridCommand({
      type: "column.sort.toggle",
      columnId: "COL_ID_NAME",
      multi: false,
    });
    runtime.getView().dispatchGridCommand({
      type: "column.sort.toggle",
      columnId: "COL_ID_NAME",
      multi: false,
    });
    expect(runtime.getView().getQuerySnapshot().groupOrderBy).toEqual([
      { columnId: "COL_ID_NAME", direction: "desc" },
    ]);

    runtime.getView().dispatchGridCommand({
      type: "grouping.remove",
      columnId: "COL_ID_NAME",
    });
    expect(runtime.getView().getQuerySnapshot()).toMatchObject({
      orderBy: [{ columnId: "COL_ID_NAME", direction: "desc" }],
      groupBy: [],
      groupOrderBy: [{ columnId: "COL_ID_NAME", direction: "desc" }],
    });
    expect(persisted.at(-1)).toMatchObject({
      groupBy: [],
      groupOrderBy: [{ columnId: "COL_ID_NAME", direction: "desc" }],
    });
    runtime.getView().dispatchGridCommand({ type: "grouping.add", columnId: "COL_ID_NAME" });
    expect(runtime.getView().getQuerySnapshot().groupOrderBy).toEqual([
      { columnId: "COL_ID_NAME", direction: "desc" },
    ]);
  });

  it("sanitizes hidden aggregate sorting and treats definition-driven tuple loss as a shape change", () => {
    const groupedColumns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
        groupBy: true,
      },
      {
        columnId: "COL_ID_AMOUNT",
        field: "amount",
        headerName: "Amount",
        valueType: "bigint",
        aggFunc: "sum",
        enableSorting: false,
      },
      {
        columnId: "COL_ID_PLAIN",
        field: "note",
        headerName: "Plain dormant column",
        valueType: "text",
      },
    ]);
    const sourceRows = [{ id: "first", name: "Ada", amount: 2n }];
    const sourceValue = source(sourceRows);
    const adapter = new BrunoTableClientRowPipelineAdapter(
      sourceValue,
      (row: Row) => row.id,
      groupedColumns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const transitions: string[] = [];
    const runtime = new BrunoTableGridRuntime(
      adapter.getPublication(),
      groupedColumns,
      adapter.getQueryConfiguration(groupedColumns),
      "TABLE_ID_GROUPING_RECONCILIATION",
      {
        grouping: true,
        beforeGroupingChange: () => transitions.push("before"),
      },
    );
    runtime.getView().subscribeQuery(() => transitions.push("query"));
    const atomicLayoutNotifications: Array<{
      readonly kind: "query" | "structure";
      readonly visibleColumnIds: readonly string[];
    }> = [];
    runtime.getView().subscribeColumnStructure(() =>
      atomicLayoutNotifications.push({
        kind: "structure",
        visibleColumnIds: runtime.getView().getColumnStructureSnapshot().visibleColumnIds,
      }),
    );
    runtime.getView().subscribeQuery(() =>
      atomicLayoutNotifications.push({
        kind: "query",
        visibleColumnIds: runtime.getView().getColumnStructureSnapshot().visibleColumnIds,
      }),
    );
    runtime.getView().dispatchGridCommand({ type: "grouping.add", columnId: "COL_ID_NAME" });
    expect(runtime.getView().getColumnCommandSnapshot("COL_ID_AMOUNT").sortable).toBe(true);
    expect(
      runtime.getView().dispatchGridCommand({
        type: "column.visibility.commit",
        columnId: "COL_ID_NAME",
        visible: false,
      }),
    ).toBe(false);
    expect(
      runtime.getView().dispatchGridCommand({
        type: "column.visibility.commit",
        columnId: "COL_ID_PLAIN",
        visible: false,
      }),
    ).toBe(true);
    expect(runtime.getView().getColumnCommandSnapshot("COL_ID_PLAIN").visible).toBe(false);
    runtime.getView().dispatchGridCommand({
      type: "column.sort.toggle",
      columnId: "COL_ID_AMOUNT",
      multi: false,
    });
    expect(runtime.getView().getQuerySnapshot().navigationMode).toBe("reset");
    expect(runtime.getView().getQuerySnapshot().groupOrderBy).toEqual([
      { columnId: "COL_ID_AMOUNT", direction: "asc" },
    ]);

    atomicLayoutNotifications.length = 0;
    runtime.getView().dispatchGridCommand({
      type: "column.visibility.commit",
      columnId: "COL_ID_AMOUNT",
      visible: false,
    });
    expect(runtime.getView().getQuerySnapshot().groupOrderBy).toEqual([
      { columnId: "COL_ID_NAME", direction: "asc" },
    ]);
    expect(atomicLayoutNotifications).toEqual([
      { kind: "structure", visibleColumnIds: ["COL_ID_NAME"] },
      { kind: "query", visibleColumnIds: ["COL_ID_NAME"] },
    ]);
    expect(transitions.filter((transition) => transition === "before")).toHaveLength(1);

    const replacementColumns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
      {
        columnId: "COL_ID_AMOUNT",
        field: "amount",
        headerName: "Amount",
        valueType: "bigint",
        aggFunc: "sum",
        enableSorting: false,
      },
    ]);
    runtime.reconcile(
      adapter.configure((row: Row) => row.id, replacementColumns),
      replacementColumns,
      adapter.getQueryConfiguration(replacementColumns),
    );
    expect(runtime.getView().getQuerySnapshot()).toMatchObject({
      groupBy: [],
      navigationMode: "projection-reset",
    });
    expect(transitions.filter((transition) => transition === "before")).toHaveLength(2);
  });

  it("stages definition-driven tuple loss and current grouping capability as one configuration", () => {
    const initialColumns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    const groupingColumns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
        groupBy: true,
      },
      {
        columnId: "COL_ID_NOTE",
        field: "note",
        headerName: "Note",
        valueType: "text",
        aggFunc: "countDistinct",
      },
    ]);
    const sourceValue = source([{ id: "first", name: "Ada", note: "one" }]);
    const adapter = new BrunoTableClientRowPipelineAdapter(
      sourceValue,
      (row: Row) => row.id,
      initialColumns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const persisted: Readonly<Record<string, unknown>>[] = [];
    const runtime = new BrunoTableGridRuntime(
      adapter.getPublication(),
      initialColumns,
      adapter.getQueryConfiguration(initialColumns),
      "TABLE_ID_DYNAMIC_GROUPING_CAPABILITY",
      {
        grouping: true,
        groupRowsWidth: 96,
        initialPersistedState: {
          version: 1,
          tableId: "TABLE_ID_DYNAMIC_GROUPING_CAPABILITY",
          filters: [],
          orderBy: [{ columnId: "COL_ID_NAME", direction: "asc" }],
          groupBy: [],
          groupOrderBy: [],
          columnOrder: ["COL_ID_NAME"],
          columnVisibility: { COL_ID_NAME: true },
          columnWidths: { COL_ID_BRUNO_TABLE_ROWS: 333 },
          columnPinning: { start: [], end: [] },
        },
        getOnPersistChange: () => (state) => persisted.push(state),
      },
    );
    expect(runtime.getView().getQuerySnapshot().rowsWidth).toBeUndefined();
    expect(
      runtime.getView().dispatchGridCommand({
        type: "column.resize.commit",
        columnId: "COL_ID_NAME",
        width: 170,
      }),
    ).toBe(true);
    expect(persisted.at(-1)?.["columnWidths"]).not.toHaveProperty("COL_ID_BRUNO_TABLE_ROWS");

    runtime.reconcile(
      adapter.configure((row: Row) => row.id, groupingColumns),
      groupingColumns,
      adapter.getQueryConfiguration(groupingColumns),
      144,
    );
    expect(
      runtime.getView().dispatchGridCommand({ type: "grouping.add", columnId: "COL_ID_NAME" }),
    ).toBe(true);
    expect(runtime.getView().getColumnCommandSnapshot("COL_ID_BRUNO_TABLE_ROWS").width).toBe(144);
    runtime.getView().dispatchGridCommand({
      type: "column.resize.commit",
      columnId: "COL_ID_BRUNO_TABLE_ROWS",
      width: 173,
    });

    const staged = runtime
      .getView()
      .stageClientProjectionConfiguration(
        initialColumns,
        adapter.getQueryConfiguration(initialColumns),
        96,
      );
    expect(staged.query).toMatchObject({
      columns: initialColumns,
      groupBy: [],
      groupOrderBy: [{ columnId: "COL_ID_BRUNO_TABLE_ROWS", direction: "asc" }],
      navigationMode: "projection-reset",
    });
    expect(staged.query.rowsWidth).toBeUndefined();

    runtime.reconcile(
      adapter.configure((row: Row) => row.id, initialColumns),
      initialColumns,
      adapter.getQueryConfiguration(initialColumns),
      96,
    );
    expect(runtime.getView().getQuerySnapshot()).toMatchObject({
      groupBy: [],
      groupOrderBy: [{ columnId: "COL_ID_BRUNO_TABLE_ROWS", direction: "asc" }],
    });
    expect(runtime.getView().getQuerySnapshot().rowsWidth).toBeUndefined();
    expect(
      runtime.getView().dispatchGridCommand({ type: "grouping.add", columnId: "COL_ID_NAME" }),
    ).toBe(false);
    expect(
      runtime.getView().dispatchGridCommand({
        type: "column.resize.commit",
        columnId: "COL_ID_NAME",
        width: 180,
      }),
    ).toBe(true);
    expect(persisted.at(-1)?.["columnWidths"]).toMatchObject({
      COL_ID_BRUNO_TABLE_ROWS: 173,
    });

    runtime.reconcile(
      adapter.configure((row: Row) => row.id, groupingColumns),
      groupingColumns,
      adapter.getQueryConfiguration(groupingColumns),
      144,
    );
    expect(
      runtime.getView().dispatchGridCommand({ type: "grouping.add", columnId: "COL_ID_NAME" }),
    ).toBe(true);
    expect(runtime.getView().getColumnCommandSnapshot("COL_ID_BRUNO_TABLE_ROWS").width).toBe(173);
  });

  it("reconciles Active navigation for grouped filters and publishes the effective sort count", () => {
    const groupedColumns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
        groupBy: true,
      },
      {
        columnId: "COL_ID_NOTE",
        field: "note",
        headerName: "Note",
        valueType: "text",
        aggFunc: "countDistinct",
      },
    ]);
    const sourceValue = source([{ id: "first", name: "Ada", note: "one" }]);
    const adapter = new BrunoTableClientRowPipelineAdapter(
      sourceValue,
      (row: Row) => row.id,
      groupedColumns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const runtime = new BrunoTableGridRuntime(
      adapter.getPublication(),
      groupedColumns,
      adapter.getQueryConfiguration(groupedColumns),
      "TABLE_ID_GROUPED_FILTER_RECONCILIATION",
      { grouping: true },
    );
    const counts: number[] = [];
    runtime
      .getView()
      .subscribeActiveSortCount(() => counts.push(runtime.getView().getActiveSortCountSnapshot()));
    runtime.getView().dispatchGridCommand({ type: "grouping.add", columnId: "COL_ID_NAME" });
    runtime.getView().dispatchGridCommand({
      type: "column.sort.toggle",
      columnId: "COL_ID_NOTE",
      multi: true,
    });
    expect(runtime.getView().getActiveSortCountSnapshot()).toBe(2);
    expect(counts.at(-1)).toBe(2);

    runtime.getView().dispatchGridCommand({
      type: "column.filter.replace",
      columnId: "COL_ID_NAME",
      filter: { columnId: "COL_ID_NAME", type: "equals", filter: "Ada" },
    });
    expect(runtime.getView().getQuerySnapshot().navigationMode).toBe("reset");

    runtime.getView().dispatchGridCommand({ type: "grouping.remove", columnId: "COL_ID_NAME" });
    expect(runtime.getView().getActiveSortCountSnapshot()).toBe(1);
    expect(counts.at(-1)).toBe(1);
  });

  it("retains dormant grouped sorting when the initial columns have no grouping capability", () => {
    const clientPersist = vi.fn();
    const serverPersist = vi.fn();
    const createPersistenceSubject = (grouping: boolean, persist: typeof clientPersist) => {
      const adapter = new BrunoTableClientRowPipelineAdapter(
        source([{ id: "first", name: "Ada" }]),
        (row: Row) => row.id,
        runtimeColumns,
        undefined,
        [{ columnId: "COL_ID_NAME", direction: "asc" }],
      );
      return new BrunoTableGridRuntime(
        adapter.getPublication(),
        runtimeColumns,
        adapter.getQueryConfiguration(runtimeColumns),
        `TABLE_ID_PERSISTENCE_CAPABILITY_${String(grouping)}`,
        { grouping, getOnPersistChange: () => persist },
      ).getView();
    };
    const client = createPersistenceSubject(true, clientPersist);
    const server = createPersistenceSubject(false, serverPersist);

    client.dispatchGridCommand({
      type: "column.resize.commit",
      columnId: "COL_ID_NAME",
      width: 201,
    });
    server.dispatchGridCommand({
      type: "column.resize.commit",
      columnId: "COL_ID_NAME",
      width: 201,
    });

    expect(clientPersist).toHaveBeenCalledWith(
      expect.objectContaining({
        groupBy: [],
        groupOrderBy: [{ columnId: "COL_ID_BRUNO_TABLE_ROWS", direction: "asc" }],
      }),
    );
    expect(serverPersist).toHaveBeenCalledWith(
      expect.objectContaining({ groupBy: [], groupOrderBy: [] }),
    );
  });
});

describe("BrunoTable Grid Preferences runtime boundary", () => {
  it("restores once and emits one complete replacement only for committed durable commands", () => {
    const adapter = new BrunoTableClientRowPipelineAdapter(
      source([{ id: "first", name: "Ada" }]),
      (row: Row) => row.id,
      runtimeColumns,
      [{ columnId: "COL_ID_NAME", type: "equals", filter: "baseline" }],
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const onPersistChange = vi.fn();
    const runtime = new BrunoTableGridRuntime(
      adapter.getPublication(),
      runtimeColumns,
      adapter.getQueryConfiguration(runtimeColumns),
      "TABLE_ID_PREFERENCES_RUNTIME",
      {
        initialPersistedState: {
          version: 1,
          tableId: "TABLE_ID_PREFERENCES_RUNTIME",
          filters: [],
          orderBy: [{ columnId: "COL_ID_NAME", direction: "desc" }],
          groupBy: [],
          groupOrderBy: [],
          columnOrder: ["COL_ID_NAME"],
          columnVisibility: { COL_ID_NAME: true },
          columnWidths: { COL_ID_NAME: 222 },
          columnPinning: { start: [], end: ["COL_ID_NAME"] },
        },
        getOnPersistChange: () => onPersistChange,
      },
    );
    const view = runtime.getView();

    expect(view.getSortingSnapshot()).toEqual([{ columnId: "COL_ID_NAME", direction: "desc" }]);
    expect(view.getFilterSnapshot().filters).toEqual([]);
    expect(view.getColumnLayoutSnapshot().allColumns[0]).toMatchObject({
      columnId: "COL_ID_NAME",
      pinned: "end",
    });
    expect(view.getColumnLayoutSnapshot().allColumns[0]?.semantics.width).toBe(222);
    expect(onPersistChange).not.toHaveBeenCalled();

    view.dispatchGridCommand({ type: "column.filter.reset", columnId: "COL_ID_NAME" });
    expect(view.getFilterSnapshot().filters).toEqual([
      { columnId: "COL_ID_NAME", type: "equals", filter: "baseline" },
    ]);
    view.dispatchGridCommand({ type: "column.filter.clear", columnId: "COL_ID_NAME" });
    expect(view.getFilterSnapshot().filters).toEqual([]);

    view.dispatchGridCommand({
      type: "column.filter.replace",
      columnId: "COL_ID_NAME",
      filter: { columnId: "COL_ID_NAME", type: "equals", filter: "Grace" },
    });
    view.dispatchGridCommand({ type: "column.resize.commit", columnId: "COL_ID_NAME", width: 240 });
    view.dispatchGridCommand({ type: "column.sort.toggle", columnId: "COL_ID_NAME", multi: false });
    expect(onPersistChange).toHaveBeenCalledTimes(5);
    expect(onPersistChange.mock.lastCall?.[0]).toMatchObject({
      version: 1,
      tableId: "TABLE_ID_PREFERENCES_RUNTIME",
      orderBy: [{ columnId: "COL_ID_NAME", direction: "asc" }],
      groupBy: [],
      groupOrderBy: [],
      columnWidths: { COL_ID_NAME: 240 },
    });
    expect(onPersistChange.mock.lastCall?.[0]?.["columnWidths"]).not.toHaveProperty(
      "COL_ID_BRUNO_TABLE_ROWS",
    );
    expect(JSON.stringify(onPersistChange.mock.lastCall?.[0])).toContain(
      '"codecId":"@bruno/table/text"',
    );

    view.dispatchGridCommand({ type: "quick-filter.replace", text: "ada" });
    runtime.publish(adapter.publish({ ...source([{ id: "first", name: "Augusta" }]), version: 2 }));
    expect(onPersistChange).toHaveBeenCalledTimes(5);
  });

  it("keeps committed state when the latest callback throws", () => {
    const adapter = new BrunoTableClientRowPipelineAdapter(
      source([]),
      (row: Row) => row.id,
      runtimeColumns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const runtime = new BrunoTableGridRuntime(
      adapter.getPublication(),
      runtimeColumns,
      adapter.getQueryConfiguration(runtimeColumns),
      "TABLE_ID_PREFERENCES_CALLBACK_FAILURE",
      {
        getOnPersistChange: () => () => {
          throw new Error("consumer transport failed");
        },
      },
    );
    expect(() =>
      runtime.getView().dispatchGridCommand({
        type: "column.resize.commit",
        columnId: "COL_ID_NAME",
        width: 321,
      }),
    ).not.toThrow();
    expect(runtime.getView().getColumnLayoutSnapshot().allColumns[0]?.semantics.width).toBe(321);
  });

  it("rethrows undefined from command listeners after installing committed state", () => {
    const adapter = new BrunoTableClientRowPipelineAdapter(
      source([]),
      (row: Row) => row.id,
      runtimeColumns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const runtime = new BrunoTableGridRuntime(
      adapter.getPublication(),
      runtimeColumns,
      adapter.getQueryConfiguration(runtimeColumns),
      "TABLE_ID_UNDEFINED_COMMAND_ERROR",
    );
    runtime.getView().subscribeColumnLayout(() => {
      throw undefined;
    });
    let caught = false;

    try {
      runtime.getView().dispatchGridCommand({
        type: "column.resize.commit",
        columnId: "COL_ID_NAME",
        width: 321,
      });
    } catch (error) {
      caught = true;
      expect(error).toBeUndefined();
    }

    expect(caught).toBe(true);
    expect(runtime.getView().getColumnLayoutSnapshot().allColumns[0]?.semantics.width).toBe(321);
  });

  it("rethrows undefined from persisted codecs after installing committed state", () => {
    const throwingValueType: BrunoTableValueType<string, "equality", "text"> = {
      codecId: "test/throws-undefined",
      codecVersion: 1,
      filterFamily: "equality",
      editorFamily: "text",
      cellAlign: "start",
      editorLayout: "inline",
      defaultWidth: 120,
      decodeRuntime: (input) =>
        typeof input === "string"
          ? { _tag: "Success", value: input }
          : { _tag: "Failure", message: "Expected text." },
      equivalent: (left, right) => left === right,
      compare: (left, right) => (left === right ? 0 : left < right ? -1 : 1),
      formatCanonicalText: (value) => value,
      parseCanonicalText: (text) => ({ _tag: "Success", value: text }),
      formatDisplay: (value) => value,
      encodePersisted: () => {
        throw undefined;
      },
      decodePersisted: () => ({ _tag: "Failure" as const, message: "Not persisted." }),
    };
    const throwingColumns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: throwingValueType,
      },
    ]);
    const adapter = new BrunoTableClientRowPipelineAdapter(
      source([]),
      (row: Row) => row.id,
      throwingColumns,
      [{ columnId: "COL_ID_NAME", type: "equals", filter: "persist me" }],
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const runtime = new BrunoTableGridRuntime(
      adapter.getPublication(),
      throwingColumns,
      adapter.getQueryConfiguration(throwingColumns),
      "TABLE_ID_UNDEFINED_PERSIST_ERROR",
    );
    let caught = false;

    try {
      runtime.getView().dispatchGridCommand({
        type: "column.resize.commit",
        columnId: "COL_ID_NAME",
        width: 321,
      });
    } catch (error) {
      caught = true;
      expect(error).toBeUndefined();
    }

    expect(caught).toBe(true);
    expect(runtime.getView().getColumnLayoutSnapshot().allColumns[0]?.semantics.width).toBe(321);
  });

  it("does not overwrite newer preferences persisted by a re-entrant filter listener", () => {
    const adapter = new BrunoTableClientRowPipelineAdapter(
      source([]),
      (row: Row) => row.id,
      runtimeColumns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const onPersistChange = vi.fn();
    const view = new BrunoTableGridRuntime(
      adapter.getPublication(),
      runtimeColumns,
      adapter.getQueryConfiguration(runtimeColumns),
      "TABLE_ID_REENTRANT_PERSISTENCE",
      { getOnPersistChange: () => onPersistChange },
    ).getView();
    let nested = false;
    view.subscribeFilter(() => {
      if (nested) return;
      nested = true;
      view.dispatchGridCommand({
        type: "column.filter.replace",
        columnId: "COL_ID_NAME",
        filter: { columnId: "COL_ID_NAME", type: "equals", filter: "newer" },
      });
    });

    view.dispatchGridCommand({
      type: "column.filter.replace",
      columnId: "COL_ID_NAME",
      filter: { columnId: "COL_ID_NAME", type: "equals", filter: "older" },
    });

    expect(view.getFilterSnapshot().filters).toEqual([
      { columnId: "COL_ID_NAME", type: "equals", filter: "newer" },
    ]);
    expect(onPersistChange).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(onPersistChange.mock.lastCall?.[0])).toContain('"newer"');
    expect(JSON.stringify(onPersistChange.mock.lastCall?.[0])).not.toContain('"older"');
  });

  it("does not persist an older snapshot when nested durable notification fails", () => {
    const adapter = new BrunoTableClientRowPipelineAdapter(
      source([]),
      (row: Row) => row.id,
      runtimeColumns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const onPersistChange = vi.fn();
    let failNextLookup = false;
    const view = new BrunoTableGridRuntime(
      adapter.getPublication(),
      runtimeColumns,
      adapter.getQueryConfiguration(runtimeColumns),
      "TABLE_ID_REENTRANT_PERSISTENCE_FAILURE",
      {
        getOnPersistChange: () => {
          if (failNextLookup) {
            failNextLookup = false;
            throw new Error("Consumer callback unavailable.");
          }
          return onPersistChange;
        },
      },
    ).getView();
    view.subscribeFilter(() => {
      failNextLookup = true;
      view.dispatchGridCommand({
        type: "column.resize.commit",
        columnId: "COL_ID_NAME",
        width: 321,
      });
    });

    view.dispatchGridCommand({
      type: "column.filter.replace",
      columnId: "COL_ID_NAME",
      filter: { columnId: "COL_ID_NAME", type: "equals", filter: "newer" },
    });

    expect(view.getColumnLayoutSnapshot().allColumns[0]?.semantics.width).toBe(321);
    expect(onPersistChange).not.toHaveBeenCalled();
  });

  it("rejects filter preflight superseded by a durable command inside its encoder", () => {
    let onEncode = () => {};
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: {
          ...parserValueType(true),
          encodePersisted: (value: string) => {
            onEncode();
            return value;
          },
        },
      },
    ]);
    const adapter = new BrunoTableClientRowPipelineAdapter(
      source([]),
      (row: Row) => row.id,
      columns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const onPersistChange = vi.fn();
    const view = new BrunoTableGridRuntime(
      adapter.getPublication(),
      columns,
      adapter.getQueryConfiguration(columns),
      "TABLE_ID_ENCODER_REENTRY",
      { getOnPersistChange: () => onPersistChange },
    ).getView();
    onEncode = () => {
      onEncode = () => {};
      view.dispatchGridCommand({
        type: "column.resize.commit",
        columnId: "COL_ID_NAME",
        width: 321,
      });
    };

    expect(() =>
      view.dispatchGridCommand({
        type: "column.filter.replace",
        columnId: "COL_ID_NAME",
        filter: { columnId: "COL_ID_NAME", type: "equals", filter: "new" },
      }),
    ).toThrow("Grid preferences changed while preparing this filter.");
    expect(view.getFilterSnapshot().filters).toEqual([]);
    expect(view.getColumnLayoutSnapshot().allColumns[0]?.semantics.width).toBe(321);
    expect(onPersistChange).toHaveBeenCalledTimes(1);
    expect(onPersistChange.mock.lastCall?.[0]).toMatchObject({
      filters: [],
      columnWidths: { COL_ID_NAME: 321 },
    });
  });

  it("reuses the exact preflight snapshot when publishing a filter preference", () => {
    let encodeCalls = 0;
    const singleUseValueType: BrunoTableValueType<string, "equality", "text"> = {
      codecId: "test/single-use-persistence",
      codecVersion: 1,
      filterFamily: "equality",
      editorFamily: "text",
      cellAlign: "start",
      editorLayout: "inline",
      defaultWidth: 120,
      decodeRuntime: (input) =>
        typeof input === "string"
          ? { _tag: "Success", value: input }
          : { _tag: "Failure", message: "Expected text." },
      equivalent: (left, right) => left === right,
      compare: (left, right) => (left === right ? 0 : left < right ? -1 : 1),
      formatCanonicalText: (value) => value,
      parseCanonicalText: (text) => ({ _tag: "Success", value: text }),
      formatDisplay: (value) => value,
      encodePersisted: (value) => {
        encodeCalls += 1;
        if (encodeCalls > 1) throw new Error("codec must not be invoked after publication");
        return value;
      },
      decodePersisted: (input) =>
        typeof input === "string"
          ? { _tag: "Success", value: input }
          : { _tag: "Failure", message: "Expected persisted text." },
    };
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: singleUseValueType,
      },
    ]);
    const adapter = new BrunoTableClientRowPipelineAdapter(
      source([]),
      (row: Row) => row.id,
      columns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const onPersistChange = vi.fn();
    const runtime = new BrunoTableGridRuntime(
      adapter.getPublication(),
      columns,
      adapter.getQueryConfiguration(columns),
      "TABLE_ID_SINGLE_USE_PERSISTENCE",
      { getOnPersistChange: () => onPersistChange },
    );
    const filterListener = vi.fn();
    runtime.getView().subscribeFilter(filterListener);

    expect(
      runtime.getView().dispatchGridCommand({
        type: "column.filter.replace",
        columnId: "COL_ID_NAME",
        filter: { columnId: "COL_ID_NAME", type: "equals", filter: "next" },
      }),
    ).toBe(true);
    expect(runtime.getView().getFilterSnapshot().filters).toEqual([
      { columnId: "COL_ID_NAME", type: "equals", filter: "next" },
    ]);
    expect(filterListener).toHaveBeenCalledTimes(1);
    expect(onPersistChange).toHaveBeenCalledTimes(1);
    expect(encodeCalls).toBe(1);
  });

  it("rejects a filter persistence preflight failure without publishing partial state", () => {
    const persistenceFailure = new Error("Persistence codec failed.");
    const throwingValueType: BrunoTableValueType<string, "equality", "text"> = {
      codecId: "test/throwing-filter-persistence",
      codecVersion: 1,
      filterFamily: "equality",
      editorFamily: "text",
      cellAlign: "start",
      editorLayout: "inline",
      defaultWidth: 120,
      decodeRuntime: (input) =>
        typeof input === "string"
          ? { _tag: "Success", value: input }
          : { _tag: "Failure", message: "Expected text." },
      equivalent: (left, right) => left === right,
      compare: (left, right) => (left === right ? 0 : left < right ? -1 : 1),
      formatCanonicalText: (value) => value,
      parseCanonicalText: (text) => ({ _tag: "Success", value: text }),
      formatDisplay: (value) => value,
      encodePersisted: () => {
        throw persistenceFailure;
      },
      decodePersisted: () => ({ _tag: "Failure", message: "Not persisted." }),
    };
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: throwingValueType,
      },
    ]);
    const adapter = new BrunoTableClientRowPipelineAdapter(
      source([]),
      (row: Row) => row.id,
      columns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const onPersistChange = vi.fn();
    const runtime = new BrunoTableGridRuntime(
      adapter.getPublication(),
      columns,
      adapter.getQueryConfiguration(columns),
      "TABLE_ID_THROWING_FILTER_PERSISTENCE",
      { getOnPersistChange: () => onPersistChange },
    );
    const filterListener = vi.fn();
    runtime.getView().subscribeFilter(filterListener);

    expect(() =>
      runtime.getView().dispatchGridCommand({
        type: "column.filter.replace",
        columnId: "COL_ID_NAME",
        filter: { columnId: "COL_ID_NAME", type: "equals", filter: "next" },
      }),
    ).toThrow(persistenceFailure);
    expect(runtime.getView().getFilterSnapshot().filters).toEqual([]);
    expect(filterListener).not.toHaveBeenCalled();
    expect(onPersistChange).not.toHaveBeenCalled();
  });

  it("replaces the callback without recreating the runtime or waking row and cell subscribers", () => {
    const row = { id: "first", name: "Ada" };
    const adapter = new BrunoTableClientRowPipelineAdapter(
      source([row]),
      (candidate: Row) => candidate.id,
      runtimeColumns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const firstCallback = vi.fn();
    const secondCallback = vi.fn();
    const runtime = new BrunoTableGridRuntime(
      adapter.getPublication(),
      runtimeColumns,
      adapter.getQueryConfiguration(runtimeColumns),
      "TABLE_ID_PREFERENCES_CALLBACK_REPLACEMENT",
      { getOnPersistChange: () => firstCallback },
    );
    const view = runtime.getView();
    const rowListener = vi.fn();
    const cellListener = vi.fn();
    const rowId = adapter.resolveRowId(row);
    const unsubscribeRow = view.subscribeRow(rowId, rowListener);
    const unsubscribeCell = view.subscribeCell(rowId, "COL_ID_NAME", cellListener);

    runtime.setOnPersistChange(secondCallback);

    expect(runtime.getView()).toBe(view);
    expect(rowListener).not.toHaveBeenCalled();
    expect(cellListener).not.toHaveBeenCalled();
    view.dispatchGridCommand({ type: "column.resize.commit", columnId: "COL_ID_NAME", width: 222 });
    expect(firstCallback).not.toHaveBeenCalled();
    expect(secondCallback).toHaveBeenCalledOnce();
    expect(rowListener).not.toHaveBeenCalled();
    expect(cellListener).not.toHaveBeenCalled();
    unsubscribeCell();
    unsubscribeRow();
  });

  it("emits the single logical order, visibility, widths, and pinning projection", () => {
    const columns = compileColumns([
      { columnId: "COL_ID_FIRST", field: "name", headerName: "First", valueType: "text" },
      { columnId: "COL_ID_SECOND", field: "name", headerName: "Second", valueType: "text" },
      { columnId: "COL_ID_THIRD", field: "name", headerName: "Third", valueType: "text" },
    ]);
    const adapter = new BrunoTableClientRowPipelineAdapter(
      source([]),
      (row: Row) => row.id,
      columns,
      undefined,
      [{ columnId: "COL_ID_FIRST", direction: "asc" }],
    );
    const onPersistChange = vi.fn();
    const runtime = new BrunoTableGridRuntime(
      adapter.getPublication(),
      columns,
      adapter.getQueryConfiguration(columns),
      "TABLE_ID_LAYOUT_PREFERENCES",
      { getOnPersistChange: () => onPersistChange },
    );
    const view = runtime.getView();

    view.dispatchGridCommand({
      type: "column.pin.commit",
      columnId: "COL_ID_THIRD",
      pinned: "start",
    });
    view.dispatchGridCommand({
      type: "column.reorder.commit",
      columnId: "COL_ID_FIRST",
      targetIndex: 2,
      pinned: undefined,
    });
    view.dispatchGridCommand({
      type: "column.visibility.commit",
      columnId: "COL_ID_SECOND",
      visible: false,
    });
    view.dispatchGridCommand({
      type: "column.resize.commit",
      columnId: "COL_ID_FIRST",
      width: 245,
    });

    expect(onPersistChange).toHaveBeenCalledTimes(4);
    expect(onPersistChange.mock.lastCall?.[0]).toMatchObject({
      columnOrder: ["COL_ID_THIRD", "COL_ID_SECOND", "COL_ID_FIRST"],
      columnVisibility: {
        COL_ID_THIRD: true,
        COL_ID_FIRST: true,
        COL_ID_SECOND: false,
      },
      columnWidths: {
        COL_ID_FIRST: 245,
      },
      columnPinning: { start: ["COL_ID_THIRD"], end: [] },
    });
  });
});

describe("BrunoTable filter runtime primitives", () => {
  it("gates every filter and sorting command through the optional active editor seam", () => {
    const runtime = createClientRuntime(
      source([{ id: "first", name: "Ada" }]),
      (row) => row.id,
      runtimeColumns,
      [{ columnId: "COL_ID_NAME", type: "contains", filter: "A" }],
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const gate = vi.fn(() => false);
    const unregister = runtime.registerActiveEditorCommitGate(gate);
    const before = runtime.getQuerySnapshot();

    expect(
      runtime.dispatchGridCommand({ type: "column.filter.clear", columnId: "COL_ID_NAME" }),
    ).toBe(false);
    expect(runtime.dispatchGridCommand({ type: "column.filters.clear" })).toBe(false);
    expect(
      runtime.dispatchGridCommand({ type: "column.filter.reset", columnId: "COL_ID_NAME" }),
    ).toBe(false);
    expect(
      runtime.dispatchGridCommand({
        type: "column.filter.replace",
        columnId: "COL_ID_NAME",
        filter: { columnId: "COL_ID_NAME", type: "contains", filter: "B" },
      }),
    ).toBe(false);
    expect(runtime.dispatchGridCommand({ type: "quick-filter.replace", text: "ada" })).toBe(false);
    expect(
      runtime.dispatchGridCommand({
        type: "column.sort.toggle",
        columnId: "COL_ID_NAME",
        multi: false,
      }),
    ).toBe(false);

    expect(gate).toHaveBeenCalledTimes(6);
    expect(runtime.getQuerySnapshot()).toBe(before);

    const gateCallsBeforeRejectedQuickFilter = gate.mock.calls.length;
    expect(
      runtime.dispatchGridCommand({
        type: "quick-filter.replace",
        text: "x".repeat(BRUNO_TABLE_MAX_QUICK_FILTER_LENGTH + 1),
      }),
    ).toBe(false);
    expect(gate).toHaveBeenCalledTimes(gateCallsBeforeRejectedQuickFilter);

    unregister();
    runtime.dispatchGridCommand({ type: "quick-filter.replace", text: "ada" });
    expect(runtime.getQuerySnapshot().quickFilter).toBe("ada");
  });

  it("rejects a replacement that exceeds the remaining aggregate operand budget atomically", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
      {
        columnId: "COL_ID_SCORE",
        field: "score",
        headerName: "Score",
        valueType: "number",
      },
    ]);
    const runtime = createClientRuntime(
      source([{ id: "first", name: "name-0" }]),
      (row) => row.id,
      columns,
      [
        {
          columnId: "COL_ID_NAME",
          filter: Array.from({ length: 16_383 }, (_, index) => `name-${String(index)}`),
          type: "in",
        },
        { columnId: "COL_ID_SCORE", filter: 1, type: "equals" },
      ],
      [{ columnId: "COL_ID_SCORE", direction: "asc" }],
    );
    const before = runtime.getQuerySnapshot();
    expect(before.filterCollection.complexity.operands).toBe(16_384);

    expect(
      runtime.dispatchGridCommand({
        type: "column.filter.replace",
        columnId: "COL_ID_SCORE",
        filter: {
          columnId: "COL_ID_SCORE",
          filter: [1, 2],
          type: "in",
        },
      }),
    ).toBe(false);
    expect(runtime.getQuerySnapshot()).toBe(before);
    expect(runtime.getQuerySnapshot().generation).toBe(before.generation);
  });

  it("sanitizes Boolean notEqual operands", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_ACTIVE",
        field: "active",
        headerName: "Active",
        valueType: "boolean",
      },
    ]);
    expect(
      sanitizeClientInitialFilters(
        [{ columnId: "COL_ID_ACTIVE", type: "notEqual", filter: true }],
        columns,
      ),
    ).toEqual([{ columnId: "COL_ID_ACTIVE", type: "notEqual", filter: true }]);
  });

  it("admits exact Boolean and Select inclusion independently of the Set Filter surface", () => {
    const selectColumn = Reflect.apply(BrunoTableSelectColumn, undefined, [
      {
        columnId: "COL_ID_STATUS",
        field: "status",
        headerName: "Status",
        options: ["open", "closed"],
        enableSetFilter: false,
      },
    ]) as Readonly<Record<string, unknown>>;
    const columns = compileColumns([
      {
        columnId: "COL_ID_ACTIVE",
        field: "active",
        headerName: "Active",
        valueType: "boolean",
        enableSetFilter: false,
      },
      selectColumn,
    ]);

    expect(
      sanitizeClientInitialFilters(
        [
          { columnId: "COL_ID_ACTIVE", type: "in", filter: [true] },
          { columnId: "COL_ID_STATUS", type: "in", filter: ["open"] },
        ],
        columns,
      ),
    ).toEqual([
      { columnId: "COL_ID_ACTIVE", type: "in", filter: [true] },
      { columnId: "COL_ID_STATUS", type: "in", filter: ["open"] },
    ]);
    expect(
      sanitizeClientInitialFilters([{ columnId: "COL_ID_ACTIVE", type: "matchNone" }], columns),
    ).toEqual([]);
  });

  it("admits membership for an explicitly opted-in custom equality Value Type", () => {
    type Token = Readonly<{ readonly id: number }>;
    const columns = compileColumns([
      {
        columnId: "COL_ID_TOKEN",
        enableSetFilter: true,
        field: "token",
        headerName: "Token",
        valueType: {
          codecId: "test/equality-set-filter",
          codecVersion: 1,
          filterFamily: "equality",
          editorFamily: "text",
          cellAlign: "start",
          editorLayout: "inline",
          defaultWidth: 120,
          decodeRuntime: (input: unknown) =>
            typeof input === "object" && input !== null && "id" in input
              ? ({ _tag: "Success", value: input as Token } as const)
              : ({ _tag: "Failure", message: "Expected token." } as const),
          equivalent: (left: Token, right: Token) => left.id === right.id,
          compare: (left: Token, right: Token) => left.id - right.id,
          formatCanonicalText: (value: Token) => String(value.id),
          parseCanonicalText: (text: string) =>
            ({ _tag: "Success", value: { id: Number(text) } }) as const,
          formatDisplay: (value: Token) => String(value.id),
          encodePersisted: (value: Token) => value.id,
          decodePersisted: (input: unknown) =>
            typeof input === "number"
              ? ({ _tag: "Success", value: { id: input } } as const)
              : ({ _tag: "Failure", message: "Expected token." } as const),
        },
      },
    ]);
    const selected = Object.freeze({ id: 1 });

    expect(
      sanitizeClientInitialFilters(
        [{ columnId: "COL_ID_TOKEN", type: "in", filter: [selected] }],
        columns,
      ),
    ).toEqual([{ columnId: "COL_ID_TOKEN", type: "in", filter: [selected] }]);
  });

  it("does not publish an equivalent text filter when sensitivity defaults are omitted", () => {
    const runtime = createClientRuntime(
      source([{ id: "first", name: "Ada" }]),
      (row) => row.id,
      runtimeColumns,
      [{ columnId: "COL_ID_NAME", type: "equals", filter: "Ada" }],
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const query = runtime.getQuerySnapshot();
    const queryListener = vi.fn();
    runtime.subscribeQuery(queryListener);

    runtime.dispatchGridCommand({
      type: "column.filter.replace",
      columnId: "COL_ID_NAME",
      filter: {
        columnId: "COL_ID_NAME",
        type: "equals",
        filter: "Ada",
        caseSensitive: false,
        accentSensitive: false,
      },
    });

    expect(runtime.getQuerySnapshot()).toBe(query);
    expect(queryListener).not.toHaveBeenCalled();

    runtime.dispatchGridCommand({
      type: "column.filter.replace",
      columnId: "COL_ID_NAME",
      filter: { columnId: "COL_ID_NAME", type: "equals", filter: "ada" },
    });

    expect(runtime.getQuerySnapshot()).toBe(query);
    expect(queryListener).not.toHaveBeenCalled();
  });

  it("compares in operands as an unordered semantic set without duplicate members", () => {
    const runtime = createClientRuntime(
      source([{ id: "first", name: "Ada" }]),
      (row) => row.id,
      runtimeColumns,
      [{ columnId: "COL_ID_NAME", type: "in", filter: ["Ada", "Grace"] }],
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const query = runtime.getQuerySnapshot();
    const queryListener = vi.fn();
    runtime.subscribeQuery(queryListener);

    runtime.dispatchGridCommand({
      type: "column.filter.replace",
      columnId: "COL_ID_NAME",
      filter: { columnId: "COL_ID_NAME", type: "in", filter: ["Grace", "Ada", "Ada"] },
    });

    expect(runtime.getQuerySnapshot()).toBe(query);
    expect(queryListener).not.toHaveBeenCalled();
  });

  it("does not collide when unordered in operands contain delimiters", () => {
    const runtime = createClientRuntime(
      source([{ id: "first", name: "a" }]),
      (row) => row.id,
      runtimeColumns,
      [{ columnId: "COL_ID_NAME", type: "in", filter: ["a", "b,text:c"] }],
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const query = runtime.getQuerySnapshot();
    const queryListener = vi.fn();
    runtime.subscribeQuery(queryListener);

    runtime.dispatchGridCommand({
      type: "column.filter.replace",
      columnId: "COL_ID_NAME",
      filter: { columnId: "COL_ID_NAME", type: "in", filter: ["a,text:b", "c"] },
    });

    expect(runtime.getQuerySnapshot()).not.toBe(query);
    expect(queryListener).toHaveBeenCalledOnce();
  });

  it("compares large text in operands through bounded keyed matching", () => {
    const values = Array.from({ length: 4_096 }, (_, index) => `Name-${String(index)}`);
    const runtime = createClientRuntime(
      source([{ id: "first", name: "Name-0" }]),
      (row) => row.id,
      runtimeColumns,
      [{ columnId: "COL_ID_NAME", type: "in", filter: values }],
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const query = runtime.getQuerySnapshot();
    const queryListener = vi.fn();
    runtime.subscribeQuery(queryListener);

    runtime.dispatchGridCommand({
      type: "column.filter.replace",
      columnId: "COL_ID_NAME",
      filter: { columnId: "COL_ID_NAME", type: "in", filter: [...values].reverse() },
    });

    expect(runtime.getQuerySnapshot()).toBe(query);
    expect(queryListener).not.toHaveBeenCalled();
  });

  it("keeps unsupported custom membership out of semantic comparison", () => {
    type OpaqueValue = Readonly<{ readonly id: number }>;
    const equivalent = vi.fn(
      (left: OpaqueValue, right: OpaqueValue): boolean => left.id === right.id,
    );
    const columns = compileColumns([
      {
        columnId: "COL_ID_OPAQUE",
        field: "value",
        headerName: "Opaque",
        valueType: {
          codecId: "test/opaque-filter-comparison",
          codecVersion: 1,
          filterFamily: "equality",
          editorFamily: "text",
          cellAlign: "start",
          editorLayout: "inline",
          defaultWidth: 120,
          decodeRuntime: (input: unknown) =>
            typeof input === "object" && input !== null
              ? { _tag: "Success" as const, value: input as OpaqueValue }
              : { _tag: "Failure" as const, message: "Expected an object." },
          equivalent,
          compare: () => 0,
          formatCanonicalText: (value: OpaqueValue) => String(value.id),
          parseCanonicalText: (text: string) => ({
            _tag: "Success" as const,
            value: Object.freeze({ id: Number(text) }),
          }),
          formatDisplay: (value: OpaqueValue) => String(value.id),
          encodePersisted: (value: OpaqueValue) => value.id,
          decodePersisted: (input: unknown) =>
            typeof input === "number"
              ? { _tag: "Success" as const, value: Object.freeze({ id: input }) }
              : { _tag: "Failure" as const, message: "Expected a number." },
        },
      } as never,
    ]);
    const columnsById = new Map(columns.map((column) => [column.columnId, column]));
    const previous = Array.from({ length: 4_096 }, (_, id) => ({
      columnId: "COL_ID_OPAQUE",
      type: "equals" as const,
      filter: Object.freeze({ id }),
    }));
    const next = [...previous].reverse();

    expect(sameBrunoTableFilterCollection(previous, next, columnsById)).toBe(false);
    expect(equivalent.mock.calls.length).toBe(0);

    equivalent.mockClear();
    const operands = Array.from({ length: 4_096 }, (_, id) => Object.freeze({ id }));
    const previousIn = [{ columnId: "COL_ID_OPAQUE", type: "in" as const, filter: operands }];
    const nextIn = [
      { columnId: "COL_ID_OPAQUE", type: "in" as const, filter: [...operands].reverse() },
    ];
    // Set-style membership for Boolean, Select, and custom equality families belongs to issue
    // #13. Both unsupported collections sanitize to empty rather than entering a comparator
    // fallback that would rescan every operand.
    expect(sameBrunoTableFilterCollection(previousIn, nextIn, columnsById)).toBe(true);
    expect(sanitizeClientInitialFilters(previousIn, columns)).toEqual([]);
    expect(sanitizeClientInitialFilters(nextIn, columns)).toEqual([]);
    expect(equivalent.mock.calls.length).toBe(0);

    equivalent.mockClear();
    const multiplePrevious = Array.from({ length: 16_384 }, (_, id) => ({
      columnId: "COL_ID_OPAQUE",
      type: "in" as const,
      filter: [Object.freeze({ id })],
    }));
    const multipleNext = multiplePrevious.map((entry) => ({
      ...entry,
      filter: entry.filter.map((operand) => Object.freeze({ id: operand.id })),
    }));
    expect(sameBrunoTableFilterCollection(multiplePrevious, multipleNext, columnsById)).toBe(true);
    expect(equivalent.mock.calls.length).toBe(0);

    equivalent.mockClear();
    const snapshotOperands = Array.from({ length: 2_048 }, (_, id) => Object.freeze({ id }));
    const snapshotFilters = [
      { columnId: "COL_ID_OPAQUE", type: "in" as const, filter: snapshotOperands },
      {
        columnId: "COL_ID_OPAQUE",
        type: "in" as const,
        filter: snapshotOperands.map((operand) => Object.freeze({ id: operand.id })),
      },
    ];
    const snapshotRuntime = createClientRuntime(
      source([{ id: "first", name: "Ada" }]),
      (row) => row.id,
      columns,
      snapshotFilters,
      [{ columnId: "COL_ID_OPAQUE", direction: "asc" }],
    );
    equivalent.mockClear();
    snapshotRuntime.configure((row) => row.id, [...columns]);
    expect(equivalent.mock.calls.length).toBeLessThanOrEqual(4_096);
  });

  it("canonicalizes a column replacement array to one AND expression", () => {
    const runtime = createClientRuntime(
      source([{ id: "first", name: "Name-0" }]),
      (row) => row.id,
      runtimeColumns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const filters = Array.from({ length: 1_024 }, (_, index) => ({
      columnId: "COL_ID_NAME",
      type: "equals" as const,
      filter: `Name-${String(index)}`,
    }));
    const generation = runtime.getQuerySnapshot().generation;

    runtime.dispatchGridCommand({
      type: "column.filter.replace",
      columnId: "COL_ID_NAME",
      filter: filters,
    });

    expect(runtime.getQuerySnapshot().filters).toEqual([{ type: "AND", conditions: filters }]);
    expect(runtime.getQuerySnapshot().generation).toBe(generation + 1);
  });

  it("compares a large canonical column expression through linear semantic keys", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_A",
        field: "score",
        headerName: "A",
        valueType: "number",
      },
    ]);
    const filters = Array.from({ length: 8_192 }, () => ({
      columnId: "COL_ID_A",
      type: "blank" as const,
    }));
    const runtime = createClientRuntime(
      source([{ id: "first", name: "Name-0" }]),
      (row) => row.id,
      columns,
      filters,
      [{ columnId: "COL_ID_A", direction: "asc" }],
    );
    const query = runtime.getQuerySnapshot();
    const queryListener = vi.fn();
    runtime.subscribeQuery(queryListener);

    runtime.dispatchGridCommand({
      type: "column.filter.replace",
      columnId: "COL_ID_A",
      filter: [...filters].reverse(),
    });

    expect(runtime.getQuerySnapshot()).toBe(query);
    expect(queryListener).not.toHaveBeenCalled();
  });

  it("invalidates filter editor candidates for no-op Clear and Reset commands", () => {
    const runtime = createClientRuntime(
      source([{ id: "first", name: "Ada" }]),
      (row) => row.id,
      runtimeColumns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const view = runtime.getView();
    const before = view.getColumnFilterCommandEpochSnapshot("COL_ID_NAME");

    view.dispatchGridCommand({ type: "column.filter.clear", columnId: "COL_ID_NAME" });
    expect(view.getColumnFilterCommandEpochSnapshot("COL_ID_NAME")).toBe(before + 1);
    view.dispatchGridCommand({ type: "column.filter.reset", columnId: "COL_ID_NAME" });
    expect(view.getColumnFilterCommandEpochSnapshot("COL_ID_NAME")).toBe(before + 2);
    view.dispatchGridCommand({ type: "column.filters.clear" });
    expect(view.getColumnFilterCommandEpochSnapshot("COL_ID_NAME")).toBe(before + 3);
  });

  it("notifies unaffected open filter editors when Clear All invalidates their candidates", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
      {
        columnId: "COL_ID_NOTE",
        field: "note",
        headerName: "Note",
        valueType: "text",
      },
    ]);
    const runtime = createClientRuntime(
      source([{ id: "first", name: "Ada", note: "first" }]),
      (row) => row.id,
      columns,
      [{ columnId: "COL_ID_NAME", type: "equals", filter: "Ada" }],
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const view = runtime.getView();
    const listener = vi.fn();
    view.subscribeColumnFilterCommandEpoch("COL_ID_NOTE", listener);
    const before = view.getColumnFilterCommandEpochSnapshot("COL_ID_NOTE");

    view.dispatchGridCommand({ type: "column.filters.clear" });

    expect(view.getColumnFilterCommandEpochSnapshot("COL_ID_NOTE")).toBe(before + 1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps a multi-root column snapshot stable when another column changes", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
      {
        columnId: "COL_ID_NOTE",
        field: "note",
        headerName: "Note",
        valueType: "text",
      },
    ]);
    const runtime = createClientRuntime(
      source([{ id: "first", name: "Ada", note: "first" }]),
      (row) => row.id,
      columns,
      [
        { columnId: "COL_ID_NOTE", type: "equals", filter: "first" },
        { columnId: "COL_ID_NOTE", type: "notEqual", filter: "second" },
      ],
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const view = runtime.getView();
    const noteSnapshot = view.getColumnFilterSnapshot("COL_ID_NOTE");
    const noteVersion = view.getColumnFilterVersionSnapshot("COL_ID_NOTE");
    const noteListener = vi.fn();
    view.subscribeColumnFilter("COL_ID_NOTE", noteListener);

    expect(
      view.dispatchGridCommand({
        type: "column.filter.replace",
        columnId: "COL_ID_NAME",
        filter: { columnId: "COL_ID_NAME", type: "equals", filter: "Grace" },
      }),
    ).toBe(true);

    expect(view.getColumnFilterSnapshot("COL_ID_NOTE")).toBe(noteSnapshot);
    expect(view.getColumnFilterVersionSnapshot("COL_ID_NOTE")).toBe(noteVersion);
    expect(noteListener).not.toHaveBeenCalled();
  });

  it("invalidates only columns whose filter baseline changed during reconciliation", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
      {
        columnId: "COL_ID_NOTE",
        field: "note",
        headerName: "Note",
        valueType: "text",
      },
    ]);
    const baseline = [{ columnId: "COL_ID_NOTE", type: "equals", filter: "first" }] as const;
    const adapter = new BrunoTableClientRowPipelineAdapter(
      source([{ id: "first", name: "Ada", note: "first" }]),
      (row) => row.id,
      columns,
      baseline,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const runtime = new BrunoTableGridRuntime(
      adapter.getPublication(),
      columns,
      adapter.getQueryConfiguration(columns),
      "TABLE_ID_BASELINE_INVALIDATION_SCOPE",
    );
    const view = runtime.getView();
    const nameEpoch = view.getColumnFilterCommandEpochSnapshot("COL_ID_NAME");
    const noteEpoch = view.getColumnFilterCommandEpochSnapshot("COL_ID_NOTE");

    runtime.reconcile(adapter.getPublication(), columns, {
      baselineFilters: [],
      baselineOrderBy: [{ columnId: "COL_ID_NAME", direction: "asc" }],
    });

    expect(view.getColumnFilterCommandEpochSnapshot("COL_ID_NAME")).toBe(nameEpoch);
    expect(view.getColumnFilterCommandEpochSnapshot("COL_ID_NOTE")).toBe(noteEpoch + 1);
  });

  it("compares cloned custom Select options once during column reconciliation", () => {
    type SelectOption = Readonly<{ readonly id: number }>;
    const equivalent = vi.fn(
      (left: SelectOption, right: SelectOption): boolean => left.id === right.id,
    );
    const valueType = Object.freeze({
      codecId: "test/select-reconciliation",
      codecVersion: 1,
      filterFamily: "select" as const,
      editorFamily: "select" as const,
      cellAlign: "start" as const,
      editorLayout: "fullWidth" as const,
      defaultWidth: 160,
      decodeRuntime: (input: unknown) =>
        typeof input === "object" && input !== null && typeof Reflect.get(input, "id") === "number"
          ? {
              _tag: "Success" as const,
              value: Object.freeze({ id: Reflect.get(input, "id") }),
            }
          : { _tag: "Failure" as const, message: "Expected an option." },
      equivalent,
      compare: (left: SelectOption, right: SelectOption) => left.id - right.id,
      formatCanonicalText: (value: SelectOption) => String(value.id),
      parseCanonicalText: (text: string) => ({
        _tag: "Success" as const,
        value: Object.freeze({ id: Number(text) }),
      }),
      formatDisplay: (value: SelectOption) => String(value.id),
      encodePersisted: (value: SelectOption) => value.id,
      decodePersisted: (input: unknown) =>
        typeof input === "number"
          ? { _tag: "Success" as const, value: Object.freeze({ id: input }) }
          : { _tag: "Failure" as const, message: "Expected an option id." },
    });
    const optionCount = 16_384;
    const createOptions = (): readonly SelectOption[] =>
      Array.from({ length: optionCount }, (_, id) => Object.freeze({ id }));
    const createSelectColumns = (options: readonly SelectOption[]) =>
      compileColumns([
        {
          columnId: "COL_ID_SELECT_RECONCILIATION",
          field: "status",
          headerName: "Status",
          valueType,
          options,
        } as never,
      ]);
    const previousColumns = createSelectColumns(createOptions());
    const nextColumns = createSelectColumns(createOptions());
    const runtime = createClientRuntime(
      source([{ id: "first", name: "Ada" }]),
      (row) => row.id,
      previousColumns,
      undefined,
      [{ columnId: "COL_ID_SELECT_RECONCILIATION", direction: "asc" }],
    );

    equivalent.mockClear();
    runtime.configure((row) => row.id, nextColumns);

    expect(equivalent).toHaveBeenCalledTimes(optionCount);
  });

  it("rejects over-limit Quick Filter text at the command boundary", () => {
    const runtime = createClientRuntime(
      source([{ id: "first", name: "Ada" }]),
      (row) => row.id,
      runtimeColumns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const view = runtime.getView();
    expect(
      view.dispatchGridCommand({
        type: "quick-filter.replace",
        text: "x".repeat(BRUNO_TABLE_MAX_QUICK_FILTER_LENGTH + 50),
      }),
    ).toBe(false);
    expect(view.getQuickFilterSnapshot()).toBe("");
  });

  it("invalidates queued Quick Filter candidates for every replacement command", () => {
    const runtime = createClientRuntime(
      source([{ id: "first", name: "Ada" }]),
      (row) => row.id,
      runtimeColumns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const view = runtime.getView();
    const before = view.getQuickFilterCommandEpochSnapshot();
    const epochListener = vi.fn();
    view.subscribeQuickFilterCommandEpoch(epochListener);

    view.dispatchGridCommand({ type: "quick-filter.replace", text: "ada" });
    expect(view.getQuickFilterCommandEpochSnapshot()).toBe(before + 1);
    view.dispatchGridCommand({ type: "quick-filter.replace", text: "" });
    expect(view.getQuickFilterCommandEpochSnapshot()).toBe(before + 2);
    expect(epochListener).toHaveBeenCalledTimes(2);
  });

  it("compares scalar array operands through their Value Semantics", () => {
    type Vector = readonly string[];
    type VectorRow = Readonly<{ readonly id: string; readonly vector: Vector }>;
    const vectorValueType: BrunoTableValueType<Vector, "equality", "text"> = {
      codecId: "test/vector",
      codecVersion: 1,
      filterFamily: "equality",
      editorFamily: "text",
      cellAlign: "start",
      editorLayout: "inline",
      defaultWidth: 120,
      decodeRuntime: (input) =>
        Array.isArray(input) && input.every((value) => typeof value === "string")
          ? { _tag: "Success", value: Object.freeze([...input]) }
          : { _tag: "Failure", message: "Expected a string vector." },
      equivalent: (left, right) =>
        left.length === right.length && left.every((value, index) => value === right[index]),
      compare: () => 0,
      formatCanonicalText: (value) => value.join(","),
      parseCanonicalText: (text) => ({ _tag: "Success", value: Object.freeze(text.split(",")) }),
      formatDisplay: (value) => value.join(","),
      encodePersisted: (value) => [...value],
      decodePersisted: (input) =>
        Array.isArray(input) && input.every((value) => typeof value === "string")
          ? { _tag: "Success", value: Object.freeze([...input]) }
          : { _tag: "Failure", message: "Expected a persisted string vector." },
    };
    const columns = compileColumns([
      {
        columnId: "COL_ID_VECTOR",
        field: "vector",
        headerName: "Vector",
        valueType: vectorValueType,
      },
    ]);
    const initialVector = Object.freeze(["a", "b"]);
    const adapter = new BrunoTableClientRowPipelineAdapter<VectorRow>(
      {
        rows: [{ id: "first", vector: initialVector }],
        totalRows: 1,
        version: 1,
        status: "ready",
      },
      (row) => row.id,
      columns,
      [{ columnId: "COL_ID_VECTOR", type: "equals", filter: initialVector }],
      [{ columnId: "COL_ID_VECTOR", direction: "asc" }],
    );
    const runtime = new BrunoTableGridRuntime(
      adapter.getPublication(),
      columns,
      adapter.getQueryConfiguration(columns),
      "TABLE_ID_VECTOR_FILTER_RUNTIME",
    );
    const view = runtime.getView();
    const query = view.getQuerySnapshot();
    const queryListener = vi.fn();
    view.subscribeQuery(queryListener);

    view.dispatchGridCommand({
      type: "column.filter.replace",
      columnId: "COL_ID_VECTOR",
      filter: { columnId: "COL_ID_VECTOR", type: "equals", filter: ["a", "b"] },
    });

    expect(view.getQuerySnapshot()).not.toBe(query);
    expect(queryListener).toHaveBeenCalledTimes(1);
  });

  it("compares same-column compound conditions as an unordered set", () => {
    const runtime = createClientRuntime(
      source([{ id: "first", name: "Ada" }]),
      (row) => row.id,
      runtimeColumns,
      [
        {
          type: "AND",
          conditions: [
            { columnId: "COL_ID_NAME", type: "equals", filter: "Ada" },
            { columnId: "COL_ID_NAME", type: "contains", filter: "a" },
          ],
        },
      ],
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const query = runtime.getQuerySnapshot();
    const queryListener = vi.fn();
    runtime.subscribeQuery(queryListener);

    runtime.dispatchGridCommand({
      type: "column.filter.replace",
      columnId: "COL_ID_NAME",
      filter: {
        type: "AND",
        conditions: [
          { columnId: "COL_ID_NAME", type: "contains", filter: "A" },
          { columnId: "COL_ID_NAME", type: "equals", filter: "ada" },
        ],
      },
    });

    expect(runtime.getQuerySnapshot()).toBe(query);
    expect(queryListener).not.toHaveBeenCalled();
  });

  it("drops filter versions for columns removed during replacement", () => {
    const runtime = createClientRuntime(
      source([{ id: "first", name: "Ada" }]),
      (row) => row.id,
      runtimeColumns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    runtime.dispatchGridCommand({
      type: "column.filter.replace",
      columnId: "COL_ID_NAME",
      filter: { columnId: "COL_ID_NAME", type: "equals", filter: "Ada" },
    });
    expect(runtime.getColumnFilterVersionSnapshot("COL_ID_NAME")).toBe(1);
    const view = runtime.getView();
    const epochListener = vi.fn(() => view.getColumnFilterSnapshot("COL_ID_NAME"));
    view.subscribeColumnFilterCommandEpoch("COL_ID_NAME", epochListener);

    const replacementColumns = compileColumns([
      {
        columnId: "COL_ID_ALIAS",
        field: "name",
        headerName: "Alias",
        valueType: "text",
      },
    ]);
    runtime.configure((row) => row.id, replacementColumns);

    expect(runtime.getColumnFilterVersionSnapshot("COL_ID_NAME")).toBe(0);
    expect(epochListener).toHaveBeenCalledOnce();
    expect(epochListener).toHaveReturnedWith(undefined);
  });

  it("publishes one generation for a committed Quick Filter without changing Grid Filters", () => {
    const adapter = new BrunoTableClientRowPipelineAdapter(
      source([{ id: "first", name: "Ada" }]),
      (row) => row.id,
      runtimeColumns,
      [{ columnId: "COL_ID_NAME", type: "equals", filter: "Ada" }],
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
      ["name"],
    );
    const runtime = new BrunoTableGridRuntime(
      adapter.getPublication(),
      runtimeColumns,
      adapter.getQueryConfiguration(runtimeColumns),
      "TABLE_ID_QUICK_FILTER_RUNTIME",
    );
    const view = runtime.getView();
    const queryListener = vi.fn();
    const filterListener = vi.fn();
    const quickFilterListener = vi.fn();
    const filterPositionResetListener = vi.fn();
    const columnFilterListener = vi.fn();
    view.subscribeQuery(queryListener);
    view.subscribeFilter(filterListener);
    view.subscribeQuickFilter(quickFilterListener);
    view.subscribeFilterPositionReset(filterPositionResetListener);
    view.subscribeColumnFilter("COL_ID_NAME", columnFilterListener);
    const before = view.getQuerySnapshot();

    view.dispatchGridCommand({ type: "quick-filter.replace", text: "ada" });

    expect(view.getQuerySnapshot()).toEqual({
      ...before,
      quickFilter: "ada",
      generation: before.generation + 1,
    });
    expect(view.getQuerySnapshot().filters).toBe(before.filters);
    expect(queryListener).toHaveBeenCalledOnce();
    expect(filterListener).toHaveBeenCalledOnce();
    expect(quickFilterListener).toHaveBeenCalledOnce();
    expect(columnFilterListener).not.toHaveBeenCalled();

    const committedGeneration = view.getQuerySnapshot().generation;
    const committedPositionResetEpoch = view.getFilterPositionResetEpochSnapshot();
    queryListener.mockClear();
    filterListener.mockClear();
    quickFilterListener.mockClear();
    view.dispatchGridCommand({ type: "quick-filter.replace", text: "ADA" });
    expect(view.getQuerySnapshot().quickFilter).toBe("ADA");
    expect(view.getQuerySnapshot().generation).toBe(committedGeneration);
    expect(queryListener).not.toHaveBeenCalled();
    expect(filterListener).toHaveBeenCalledOnce();
    expect(quickFilterListener).toHaveBeenCalledOnce();
    expect(view.getFilterPositionResetEpochSnapshot()).toBe(committedPositionResetEpoch + 1);
    expect(filterPositionResetListener).toHaveBeenCalledOnce();

    filterListener.mockClear();
    queryListener.mockClear();
    view.dispatchGridCommand({ type: "column.sort.toggle", columnId: "COL_ID_NAME", multi: false });
    expect(filterListener).not.toHaveBeenCalled();
    expect(queryListener).toHaveBeenCalledOnce();
  });

  it("does not publish a new generation when Reset already matches its baseline", () => {
    const adapter = new BrunoTableClientRowPipelineAdapter(
      source([{ id: "first", name: "Ada" }]),
      (row) => row.id,
      runtimeColumns,
      [{ columnId: "COL_ID_NAME", type: "equals", filter: "Ada" }],
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const runtime = new BrunoTableGridRuntime(
      adapter.getPublication(),
      runtimeColumns,
      adapter.getQueryConfiguration(runtimeColumns),
      "TABLE_ID_FILTER_RESET_NOOP",
    );
    const view = runtime.getView();
    const queryListener = vi.fn();
    view.subscribeQuery(queryListener);
    const before = view.getQuerySnapshot();

    view.resetColumnFilters("COL_ID_NAME");

    expect(view.getQuerySnapshot()).toBe(before);
    expect(queryListener).not.toHaveBeenCalled();
  });

  it("keeps Reset a no-op when another column changes public entry order", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
      {
        columnId: "COL_ID_NOTE",
        field: "note",
        headerName: "Note",
        valueType: "text",
      },
    ]);
    const runtime = createClientRuntime(
      source([{ id: "first", name: "Ada", note: "math" }]),
      (row) => row.id,
      columns,
      [{ columnId: "COL_ID_NAME", type: "equals", filter: "Ada" }],
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    runtime.dispatchGridCommand({
      type: "column.filter.replace",
      columnId: "COL_ID_NOTE",
      filter: { columnId: "COL_ID_NOTE", type: "equals", filter: "math" },
    });
    const query = runtime.getQuerySnapshot();
    const queryListener = vi.fn();
    runtime.subscribeQuery(queryListener);

    runtime.resetColumnFilters("COL_ID_NAME");

    expect(runtime.getQuerySnapshot()).toBe(query);
    expect(queryListener).not.toHaveBeenCalled();
  });

  it("rejects an over-budget Reset without reporting success or publishing", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
      {
        columnId: "COL_ID_SCORE",
        field: "score",
        headerName: "Score",
        valueType: "number",
      },
    ]);
    const runtime = createClientRuntime(
      source([{ id: "first", name: "Ada", note: "first" }]),
      (row) => row.id,
      columns,
      [{ columnId: "COL_ID_NAME", type: "equals", filter: "Ada" }],
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    expect(
      runtime.dispatchGridCommand({ type: "column.filter.clear", columnId: "COL_ID_NAME" }),
    ).toBe(true);
    expect(
      runtime.dispatchGridCommand({
        type: "column.filter.replace",
        columnId: "COL_ID_SCORE",
        filter: {
          columnId: "COL_ID_SCORE",
          type: "in",
          filter: Array.from({ length: 16_384 }, (_, index) => index),
        },
      }),
    ).toBe(true);
    const before = runtime.getQuerySnapshot();

    expect(
      runtime.dispatchGridCommand({ type: "column.filter.reset", columnId: "COL_ID_NAME" }),
    ).toBe(false);
    expect(runtime.getQuerySnapshot()).toBe(before);
  });

  it("snapshots Quick Filter fields as immutable table configuration", () => {
    const adapter = new BrunoTableClientRowPipelineAdapter(
      source([{ id: "first", name: "Ada" }]),
      (row) => row.id,
      runtimeColumns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
      ["name"],
    );
    const runtime = new BrunoTableGridRuntime(
      adapter.getPublication(),
      runtimeColumns,
      adapter.getQueryConfiguration(runtimeColumns),
      "TABLE_ID_QUICK_FILTER_FIELDS_RUNTIME",
    );
    const view = runtime.getView();
    const configuration = adapter.getQueryConfiguration(runtimeColumns);
    expect(view.getQuickFilterFieldsSnapshot()).toBe(configuration.quickFilterFields);
    expect(adapter.getQueryConfiguration(runtimeColumns)).toBe(configuration);

    const quickFilterPublication = vi.fn();
    const queryPublication = vi.fn();
    const filterPublication = vi.fn();
    const bodyPublication = vi.fn();
    const columnLayoutPublication = vi.fn();
    const columnStructurePublication = vi.fn();
    view.subscribeQuickFilter(quickFilterPublication);
    view.subscribeQuery(queryPublication);
    view.subscribeFilter(filterPublication);
    view.subscribeBody(bodyPublication);
    view.subscribeColumnLayout(columnLayoutPublication);
    view.subscribeColumnStructure(columnStructurePublication);
    runtime.configure(runtimeColumns, {
      ...configuration,
      quickFilterFields: Object.freeze(["name", "desk"]),
    });
    expect(view.getQuickFilterFieldsSnapshot()).toEqual(["name", "desk"]);
    expect(quickFilterPublication).toHaveBeenCalledTimes(1);
    expect(queryPublication).toHaveBeenCalledTimes(1);
    expect(filterPublication).not.toHaveBeenCalled();
    expect(bodyPublication).not.toHaveBeenCalled();
    expect(columnLayoutPublication).not.toHaveBeenCalled();
    expect(columnStructurePublication).not.toHaveBeenCalled();
    expect(view.dispatchGridCommand({ type: "quick-filter.replace", text: "ada" })).toBe(true);
    expect(view.getActiveFilterCountSnapshot()).toBe(1);

    runtime.configure(runtimeColumns, {
      ...configuration,
      quickFilterFields: Object.freeze([]),
    });
    expect(view.getQuickFilterFieldsSnapshot()).toEqual([]);
    expect(view.getQuickFilterSnapshot()).toBe("");
    expect(view.getActiveFilterCountSnapshot()).toBe(0);
    expect(quickFilterPublication).toHaveBeenCalledTimes(3);

    runtime.configure(runtimeColumns, {
      ...configuration,
      quickFilterFields: Object.freeze(["name"]),
    });
    expect(view.getQuickFilterSnapshot()).toBe("");
    expect(view.getActiveFilterCountSnapshot()).toBe(0);
    expect(quickFilterPublication).toHaveBeenCalledTimes(4);
  });

  it("rejects sparse Quick Filter field tuples", () => {
    const sparseFields = Array(1) as unknown as readonly string[];

    expect(
      () =>
        new BrunoTableClientRowPipelineAdapter(
          source([{ id: "first", name: "Ada" }]),
          (row) => row.id,
          runtimeColumns,
          undefined,
          [{ columnId: "COL_ID_NAME", direction: "asc" }],
          sparseFields,
        ),
    ).toThrow(TypeError);
  });

  it("captures Quick Filter field length once and bounds hostile field tuples", () => {
    let lengthReads = 0;
    const growingFields = new Proxy(["name"] as readonly string[], {
      get(target, property, receiver) {
        if (property === "length") {
          lengthReads += 1;
          return lengthReads === 1 ? 1 : Number.MAX_SAFE_INTEGER;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const adapter = new BrunoTableClientRowPipelineAdapter(
      source([{ id: "first", name: "Ada" }]),
      (row) => row.id,
      runtimeColumns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
      growingFields,
    );

    expect(lengthReads).toBe(1);
    expect(adapter.getQueryConfiguration(runtimeColumns).quickFilterFields).toEqual(["name"]);
    expect(
      () =>
        new BrunoTableClientRowPipelineAdapter(
          source([{ id: "first", name: "Ada" }]),
          (row) => row.id,
          runtimeColumns,
          undefined,
          [{ columnId: "COL_ID_NAME", direction: "asc" }],
          Array.from({ length: 257 }, () => "name"),
        ),
    ).toThrow(/between 1 and 256/);
  });

  it("uses Value Semantics for opaque cyclic filter operands", () => {
    type CyclicOperand = { normalized?: CyclicOperand };
    const createCyclicOperand = (): CyclicOperand => {
      const operand: CyclicOperand = {};
      operand.normalized = operand;
      return operand;
    };
    const columns = compileColumns([
      {
        columnId: "COL_ID_CYCLIC",
        field: "name",
        headerName: "Cyclic",
        valueType: {
          codecId: "test/cyclic",
          codecVersion: 1,
          filterFamily: "equality",
          editorFamily: "text",
          cellAlign: "start",
          editorLayout: "inline",
          defaultWidth: 100,
          decodeRuntime: (input: unknown) =>
            typeof input === "object" && input !== null
              ? { _tag: "Success", value: input as CyclicOperand }
              : { _tag: "Failure", message: "Expected an object." },
          equivalent: (left: unknown, right: unknown) => left === right,
          compare: () => 0,
          formatCanonicalText: () => "cyclic",
          parseCanonicalText: () => ({ _tag: "Failure", message: "Not text." }),
          formatDisplay: () => "cyclic",
          encodePersisted: () => ({ value: "cyclic" }),
          decodePersisted: () => ({ _tag: "Failure", message: "Not persisted." }),
        },
      },
    ]);
    const adapter = new BrunoTableClientRowPipelineAdapter(
      source([{ id: "first", name: "Ada" }]),
      (row) => row.id,
      columns,
      undefined,
      [{ columnId: "COL_ID_CYCLIC", direction: "asc" }],
    );
    const runtime = new BrunoTableGridRuntime(
      adapter.getPublication(),
      columns,
      adapter.getQueryConfiguration(columns),
      "TABLE_ID_CYCLIC_FILTER_RUNTIME",
    );
    const view = runtime.getView();
    const first = createCyclicOperand();
    const second = createCyclicOperand();

    expect(() =>
      view.dispatchGridCommand({
        type: "column.filter.replace",
        columnId: "COL_ID_CYCLIC",
        filter: { columnId: "COL_ID_CYCLIC", type: "equals", filter: first },
      }),
    ).not.toThrow();
    const generation = view.getQuerySnapshot().generation;
    expect(() =>
      view.dispatchGridCommand({
        type: "column.filter.replace",
        columnId: "COL_ID_CYCLIC",
        filter: { columnId: "COL_ID_CYCLIC", type: "equals", filter: second },
      }),
    ).not.toThrow();
    expect(view.getQuerySnapshot().generation).toBe(generation + 1);
  });

  it("rejects invalid filter replacements and preserves semantic no-ops", () => {
    const adapter = new BrunoTableClientRowPipelineAdapter(
      source([{ id: "first", name: "Ada" }]),
      (row) => row.id,
      runtimeColumns,
      [{ columnId: "COL_ID_NAME", type: "equals", filter: "Ada" }],
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const runtime = new BrunoTableGridRuntime(
      adapter.getPublication(),
      runtimeColumns,
      adapter.getQueryConfiguration(runtimeColumns),
      "TABLE_ID_FILTER_REPLACEMENT_GUARDS",
    );
    const view = runtime.getView();
    const queryListener = vi.fn();
    view.subscribeQuery(queryListener);
    const before = view.getQuerySnapshot();

    view.dispatchGridCommand({
      type: "column.filter.replace",
      columnId: "COL_ID_NAME",
      filter: { columnId: "COL_ID_NAME", type: "unsupported", filter: "Ada" },
    });
    expect(view.getQuerySnapshot()).toBe(before);
    expect(queryListener).not.toHaveBeenCalled();

    view.dispatchGridCommand({
      type: "column.filter.replace",
      columnId: "COL_ID_NAME",
      filter: { columnId: "COL_ID_NAME", type: "equals", filter: "Ada" },
    });
    expect(view.getQuerySnapshot()).toBe(before);
    expect(queryListener).not.toHaveBeenCalled();
  });
});

describe("BrunoTable Grid Runtime with Client Row Pipeline Adapter", () => {
  it("keeps grouped projection input on displayed publication authority, not recovery memory", () => {
    const row = { id: "first", name: "Ada" } satisfies Row;
    const adapter = new BrunoTableClientRowPipelineAdapter(
      source([row]),
      (candidate) => candidate.id,
      runtimeColumns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const readyInput = adapter.getProjectionInputSnapshot();
    expect(rawRows(readyInput.rows)).toEqual([row]);
    expect(readyInput.publication.rowSpace?.getRow("first")).toBe(row);

    adapter.reconcile(
      source([], "loading", { totalRows: 1 }),
      (candidate) => candidate.id,
      runtimeColumns,
    );
    adapter.publishProjectionInput(runtimeColumns, adapter.getQueryConfiguration(runtimeColumns));
    const loadingInput = adapter.getProjectionInputSnapshot();

    expect(loadingInput.publication.rowSpace).toBeUndefined();
    expect(loadingInput.rows).toEqual([]);
    expect(loadingInput.sourceRowIds.authoritative).toBe(false);
    expect(readyInput.rows).toHaveLength(1);
  });

  it("does not republish an unchanged grouped projection input", () => {
    const adapter = new BrunoTableClientRowPipelineAdapter(
      source([{ id: "first", name: "Ada" }]),
      (candidate) => candidate.id,
      runtimeColumns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const configuration = adapter.getQueryConfiguration(runtimeColumns);
    const initial = adapter.getProjectionInputSnapshot();
    const listener = vi.fn();
    adapter.subscribeProjectionInput(listener);

    adapter.publishProjectionInput(runtimeColumns, configuration);

    expect(adapter.getProjectionInputSnapshot()).toBe(initial);
    expect(listener).not.toHaveBeenCalled();
  });

  it("constructs a row-order detector only after subscription and reuses it", () => {
    const first = { id: "first", name: "Ada" } satisfies Row;
    const adapter = new BrunoTableClientRowPipelineAdapter(
      source([first]),
      (row) => row.id,
      runtimeColumns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const runtime = new BrunoTableGridRuntime(
      adapter.getPublication(),
      runtimeColumns,
      adapter.getQueryConfiguration(runtimeColumns),
      "TABLE_ID_GRID_RUNTIME_DETECTOR",
    );
    const detector = vi.fn<BrunoTableClientRowOrderChangeDetector>(() => true);
    const createDetector = vi.fn(() => detector);
    const rowsStore = adapter.createRowsStore(runtime.getView(), createDetector);

    expect(createDetector).not.toHaveBeenCalled();
    const disposeInitial = rowsStore.subscribe(() => undefined);
    expect(createDetector).toHaveBeenCalledOnce();
    disposeInitial();

    const listener = vi.fn();
    const disposeReplacement = rowsStore.subscribe(listener);
    expect(createDetector).toHaveBeenCalledOnce();
    runtime.publish(adapter.publish(source([{ ...first, name: "Ada Lovelace" }])));
    expect(detector).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
    disposeReplacement();
  });

  it("accepts a sparse source-neutral logical row space without inventing identities", () => {
    const loaded = { id: "loaded", name: "Ada" } satisfies Row;
    const rowSpace = Object.freeze({
      totalRows: 3,
      loadedRows: 1,
      getRowId: (index: number) => (index === 1 ? "loaded" : undefined),
      getRow: (rowId: string) => (rowId === "loaded" ? loaded : undefined),
      getCellValue: (rowId: string, columnId: string) =>
        rowId === "loaded" && columnId === "COL_ID_NAME" ? loaded.name : undefined,
    });
    const runtime = new BrunoTableGridRuntime(
      Object.freeze({
        status: "loading" as const,
        totalRows: 3,
        version: 1,
        rowSpace,
        hasCoherentRows: true,
      }),
      runtimeColumns,
      Object.freeze({
        baselineFilters: Object.freeze([]),
        baselineOrderBy: Object.freeze([
          Object.freeze({ columnId: "COL_ID_NAME", direction: "asc" as const }),
        ]),
      }),
      "TABLE_ID_GRID_RUNTIME_SPARSE_LOADING",
    );

    expect(runtime.getBodySnapshot()).toEqual({ kind: "rows" });
    expect(runtime.getRowSpaceSnapshot()?.totalRows).toBe(3);
    expect(runtime.getRowSpaceSnapshot()?.getRowId(0)).toBeUndefined();
    expect(runtime.getRowSpaceSnapshot()?.getRowId(1)).toBe("loaded");
    expect(runtime.getRowSnapshot("loaded")).toBe(loaded);
  });

  it("keeps a non-empty sparse row space renderable before any slot loads", () => {
    const runtime = new BrunoTableGridRuntime<Row>(
      Object.freeze({
        status: "loading" as const,
        totalRows: 1_000_000,
        version: 1,
        rowSpace: Object.freeze({
          totalRows: 1_000_000,
          loadedRows: 0,
          getRowId: () => undefined,
          getRow: () => undefined,
          getCellValue: () => undefined,
        }),
        hasCoherentRows: false,
      }),
      runtimeColumns,
      Object.freeze({
        baselineFilters: Object.freeze([]),
        baselineOrderBy: Object.freeze([
          Object.freeze({ columnId: "COL_ID_NAME", direction: "asc" as const }),
        ]),
      }),
      "TABLE_ID_GRID_RUNTIME_SPARSE_EMPTY",
    );

    expect(runtime.getBodySnapshot()).toEqual({ kind: "rows" });
  });

  it("publishes immutable snapshots and isolates changed row subscribers", () => {
    const first = { id: "first", name: "Ada" } satisfies Row;
    const second = { id: "second", name: "Grace" } satisfies Row;
    const runtime = createRuntime(source([first, second]));
    const bodyListener = vi.fn();
    const chromeListener = vi.fn();
    const rowsListener = vi.fn();
    const rowsStore = runtime.createRowsStore(() => true);
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    runtime.subscribeBody(bodyListener);
    runtime.subscribeChrome(chromeListener);
    rowsStore.subscribe(rowsListener);
    runtime.subscribeRow("first", firstListener);
    runtime.subscribeRow("second", secondListener);
    const bodySnapshot = runtime.getBodySnapshot();

    const nextSecond = { id: "second", name: "Grace Hopper" } satisfies Row;
    runtime.publish(source([first, nextSecond]));

    expect(bodyListener).not.toHaveBeenCalled();
    expect(chromeListener).not.toHaveBeenCalled();
    expect(rowsListener).toHaveBeenCalledOnce();
    expect(firstListener).not.toHaveBeenCalled();
    expect(secondListener).toHaveBeenCalledOnce();
    expect(runtime.getBodySnapshot()).toBe(bodySnapshot);
    expect(runtime.getBodySnapshot()).toEqual({ kind: "rows" });
    expect(rawRows(rowsStore.getSnapshot())).toEqual([first, nextSecond]);
    expect(Object.isFrozen(runtime.getBodySnapshot())).toBe(true);
    expect(runtime.getView()).toBe(runtime.getView());
  });

  it("observes replacements, insertions, removals, and reorders in a reused source array", () => {
    const first = { id: "first", name: "Ada" } satisfies Row;
    const second = { id: "second", name: "Grace" } satisfies Row;
    const reusedRows: Row[] = [first, second];
    const runtime = createRuntime(source(reusedRows));
    const rowsStore = runtime.createRowsStore(() => true);
    rowsStore.subscribe(() => undefined);

    const replacement = { id: "second", name: "Grace Hopper" } satisfies Row;
    reusedRows[1] = replacement;
    runtime.publish(source(reusedRows));
    expect(rawRows(rowsStore.getSnapshot())).toEqual([first, replacement]);
    expect(runtime.getRowSnapshot("second")).toBe(replacement);

    const third = { id: "third", name: "Katherine" } satisfies Row;
    reusedRows.push(third);
    runtime.publish(source(reusedRows));
    expect(rawRows(rowsStore.getSnapshot())).toEqual([first, replacement, third]);
    expect(runtime.getRowSnapshot("third")).toBe(third);

    reusedRows.reverse();
    runtime.publish(source(reusedRows));
    expect(rawRows(rowsStore.getSnapshot())).toEqual([third, replacement, first]);
    expect(runtime.getRowSpaceSnapshot()?.getRowId(0)).toBe("third");
    expect(runtime.getRowSpaceSnapshot()?.getRowId(2)).toBe("first");

    reusedRows.splice(1, 1);
    runtime.publish(source(reusedRows));
    expect(rawRows(rowsStore.getSnapshot())).toEqual([third, first]);
    expect(runtime.getRowSnapshot("second")).toBeUndefined();
  });

  it("patches only isolated row evidence in a large resident source", () => {
    const residentRows = Array.from({ length: 100_000 }, (_unused, index) => ({
      id: `row-${String(index)}`,
      name: `Name ${String(index)}`,
    })) satisfies readonly Row[];
    const getRowId = vi.fn((row: Row) => row.id);
    const reconciliationEvents: BrunoTableClientReconciliationEvent[] = [];
    const restoreInstrumentation = installBrunoTableClientReconciliationListener((event) => {
      reconciliationEvents.push(event);
    });

    try {
      const runtime = createRuntime(source(residentRows), getRowId);
      const unchanged = runtime.getRowSnapshot("row-99999");
      getRowId.mockClear();
      reconciliationEvents.length = 0;
      const replacement = { id: "row-50000", name: "Changed" } satisfies Row;

      runtime.publish(source(residentRows.with(50_000, replacement)));

      expect(getRowId).toHaveBeenCalledOnce();
      expect(reconciliationEvents).toEqual([
        {
          residentRows: 100_000,
          changedRows: 1,
          resolvedRowIds: 1,
          identityPatches: 1,
          rebuiltSourceSequence: false,
          rebuiltIdentityIndex: false,
          durationMs: expect.any(Number),
        },
      ]);
      expect(runtime.getRowSnapshot("row-50000")).toBe(replacement);
      expect(runtime.getRowSnapshot("row-99999")).toBe(unchanged);
    } finally {
      restoreInstrumentation();
    }
  });

  it("publishes stable per-cell snapshots for unchanged canonical values", () => {
    const cellColumns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
      {
        columnId: "COL_ID_NOTE",
        field: "note",
        headerName: "Note",
        valueType: "text",
      },
    ]);
    const first = { id: "first", name: "Ada", note: "Initial" } satisfies Row;
    const runtime = createClientRuntime(source([first]), (row) => row.id, cellColumns, undefined, [
      { columnId: "COL_ID_NAME", direction: "asc" },
    ]);
    const nameListener = vi.fn();
    const noteListener = vi.fn();
    runtime.subscribeCell("first", "COL_ID_NAME", nameListener);
    runtime.subscribeCell("first", "COL_ID_NOTE", noteListener);
    const nameSnapshot = runtime.getCellSnapshot("first", "COL_ID_NAME");
    const noteSnapshot = runtime.getCellSnapshot("first", "COL_ID_NOTE");

    runtime.publish(source([{ ...first, note: "Changed" }]));

    expect(nameListener).not.toHaveBeenCalled();
    expect(noteListener).toHaveBeenCalledOnce();
    expect(runtime.getCellSnapshot("first", "COL_ID_NAME")).toBe(nameSnapshot);
    expect(runtime.getCellSnapshot("first", "COL_ID_NOTE")).not.toBe(noteSnapshot);
    expect(runtime.getCellValueSnapshot("first", "COL_ID_NOTE")).toBe("Changed");
  });

  it("keeps stable cell snapshots without retaining prior row spaces", () => {
    const cellColumns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    const runtime = createClientRuntime(
      source([{ id: "first", name: "Ada", note: "Initial" } satisfies Row]),
      (row) => row.id,
      cellColumns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const listener = vi.fn();
    runtime.subscribeCell("first", "COL_ID_NAME", listener);
    const snapshot = runtime.getCellSnapshot("first", "COL_ID_NAME");
    const firstRowSpace = runtime.getRowSpaceSnapshot();

    runtime.publish(source([{ id: "first", name: "Ada", note: "Second" } satisfies Row]));
    const secondRowSpace = runtime.getRowSpaceSnapshot();
    runtime.publish(source([{ id: "first", name: "Ada", note: "Third" } satisfies Row]));

    expect(firstRowSpace).not.toBe(secondRowSpace);
    expect(listener).not.toHaveBeenCalled();
    expect(runtime.getCellSnapshot("first", "COL_ID_NAME")).toBe(snapshot);
    expect("rowSpace" in snapshot).toBe(false);
    expect("rowSpace" in runtime.captureCellCommandReader()("first", "COL_ID_NAME")).toBe(false);
  });

  it("preserves cell snapshots for freshly decoded equivalent canonical values", () => {
    const [baseColumn] = runtimeColumns;
    const objectColumns = Object.freeze([
      Object.freeze({
        ...baseColumn!,
        semantics: Object.freeze({
          ...baseColumn!.semantics,
          decodeRuntime: (input: unknown) =>
            typeof input === "string"
              ? ({ _tag: "Success", value: Object.freeze({ text: input }) } as const)
              : ({ _tag: "Failure", message: "Expected text." } as const),
          equivalent: (left: unknown, right: unknown) =>
            (left as { readonly text: string }).text === (right as { readonly text: string }).text,
          compare: (left: unknown, right: unknown) => {
            const leftText = (left as { readonly text: string }).text;
            const rightText = (right as { readonly text: string }).text;
            return leftText === rightText ? 0 : leftText < rightText ? -1 : 1;
          },
          formatDisplay: (value: unknown) => (value as { readonly text: string }).text,
        }),
      }),
    ] satisfies readonly CompiledColumn[]);
    const first = { id: "first", name: "Ada", note: "Initial" } satisfies Row;
    const runtime = createClientRuntime(
      source([first]),
      (row) => row.id,
      objectColumns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const listener = vi.fn();
    runtime.subscribeCell("first", "COL_ID_NAME", listener);
    const snapshot = runtime.getCellSnapshot("first", "COL_ID_NAME");

    runtime.publish(source([{ ...first, note: "Changed" }]));

    expect(listener).not.toHaveBeenCalled();
    expect(runtime.getCellSnapshot("first", "COL_ID_NAME")).toBe(snapshot);
  });

  it("publishes subscribed nullish cell transitions without invoking value callbacks", () => {
    const cellColumns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
      {
        columnId: "COL_ID_NOTE",
        field: "note",
        headerName: "Note",
        valueType: "text",
      },
    ]);
    const nullNote = { id: "first", name: "Ada", note: null } as unknown as Row;
    const runtime = createClientRuntime(
      source([nullNote]),
      (row) => row.id,
      cellColumns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const listener = vi.fn();
    runtime.subscribeCell("first", "COL_ID_NOTE", listener);
    const nullSnapshot = runtime.getCellSnapshot("first", "COL_ID_NOTE");

    runtime.publish(source([{ id: "first", name: "Ada" }]));

    expect(listener).toHaveBeenCalledOnce();
    const undefinedSnapshot = runtime.getCellSnapshot("first", "COL_ID_NOTE");
    expect(undefinedSnapshot).not.toBe(nullSnapshot);
    expect(undefinedSnapshot.value).toBeUndefined();
    listener.mockClear();

    runtime.publish(source([{ id: "first", name: "Ada", note: "Ready" }]));

    expect(listener).toHaveBeenCalledOnce();
    expect(runtime.getCellValueSnapshot("first", "COL_ID_NOTE")).toBe("Ready");
  });

  it("indexes columns before reconciling subscribed cells", () => {
    const indexedColumns = [...runtimeColumns];
    const first = { id: "first", name: "Ada" } satisfies Row;
    const runtime = createClientRuntime(
      source([first]),
      (row) => row.id,
      indexedColumns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const find = vi.spyOn(indexedColumns, "find");
    const listener = vi.fn();
    runtime.subscribeCell("first", "COL_ID_NAME", listener);
    runtime.getCellSnapshot("first", "COL_ID_NAME");

    runtime.publish(source([{ ...first, name: "Augusta" }]));

    expect(find).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledOnce();
    expect(runtime.getCellValueSnapshot("first", "COL_ID_NAME")).toBe("Augusta");
  });

  it("refreshes abandoned cell reads and bounds pending snapshots", () => {
    const manyRows = Array.from({ length: 4_100 }, (_, index) => ({
      id: `row-${String(index)}`,
      name: `Name ${String(index)}`,
    })) satisfies readonly Row[];
    const runtime = createRuntime(source(manyRows));
    const firstSnapshot = runtime.getCellSnapshot("row-0", "COL_ID_NAME");
    for (let index = 1; index <= 4_096; index += 1) {
      runtime.getCellSnapshot(`row-${String(index)}`, "COL_ID_NAME");
    }

    const rereadAfterEviction = runtime.getCellSnapshot("row-0", "COL_ID_NAME");
    expect(rereadAfterEviction).not.toBe(firstSnapshot);
    expect(rereadAfterEviction.value).toBe("Name 0");

    const changedRows = manyRows.with(0, { id: "row-0", name: "Changed" });
    runtime.publish(source(changedRows));

    const refreshed = runtime.getCellSnapshot("row-0", "COL_ID_NAME");
    expect(refreshed).not.toBe(rereadAfterEviction);
    expect(refreshed.value).toBe("Changed");
  });

  it("captures coherent command reads without installing reactive cell snapshots", () => {
    const manyRows = Array.from({ length: 4_100 }, (_, index) => ({
      id: `row-${String(index)}`,
      name: `Name ${String(index)}`,
    })) satisfies readonly Row[];
    const runtime = createRuntime(source(manyRows));
    const readCommandCell = runtime.captureCellCommandReader();
    expect(runtime.getCellCacheDiagnosticSnapshot()).toEqual({ installed: 0, pending: 0 });
    for (const row of manyRows) {
      expect(readCommandCell(row.id, "COL_ID_NAME").value).toBe(row.name);
    }
    expect(runtime.getCellCacheDiagnosticSnapshot()).toEqual({ installed: 0, pending: 0 });

    const installed = runtime.getCellSnapshot("row-0", "COL_ID_NAME");
    expect(runtime.getCellSnapshot("row-0", "COL_ID_NAME")).toBe(installed);

    runtime.publish(source(manyRows.with(0, { id: "row-0", name: "Changed" })));
    expect(readCommandCell("row-0", "COL_ID_NAME").value).toBe("Name 0");
    expect(runtime.captureCellCommandReader()("row-0", "COL_ID_NAME").value).toBe("Changed");
  });

  it("refreshes abandoned row-aware cell reads and bounds pending snapshots", () => {
    const manyRows = Array.from({ length: 4_100 }, (_, index) => ({
      id: `row-${String(index)}`,
      name: `Name ${String(index)}`,
    })) satisfies readonly Row[];
    const runtime = createRuntime(source(manyRows));
    const firstSnapshot = runtime.getRowCellSnapshot("row-0", "COL_ID_NAME");
    for (let index = 1; index <= 4_096; index += 1) {
      runtime.getRowCellSnapshot(`row-${String(index)}`, "COL_ID_NAME");
    }

    const rereadAfterEviction = runtime.getRowCellSnapshot("row-0", "COL_ID_NAME");
    expect(rereadAfterEviction).not.toBe(firstSnapshot);
    expect(rereadAfterEviction.value).toBe("Name 0");

    const changedRows = manyRows.with(0, { id: "row-0", name: "Changed" });
    runtime.publish(source(changedRows));

    const refreshed = runtime.getRowCellSnapshot("row-0", "COL_ID_NAME");
    expect(refreshed).not.toBe(rereadAfterEviction);
    expect(refreshed.value).toBe("Changed");
  });

  it("retains generic row snapshots only while a row subscription owns them", () => {
    const row = { id: "first", name: "Ada" } satisfies Row;
    const adapter = new BrunoTableClientRowPipelineAdapter(
      source([row]),
      (candidate: Row) => candidate.id,
      runtimeColumns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const runtime = new BrunoTableGridRuntime(
      adapter.getPublication(),
      runtimeColumns,
      adapter.getQueryConfiguration(runtimeColumns),
      "TABLE_ID_ROW_SNAPSHOT_OWNERSHIP",
    );
    const view = runtime.getView();
    const publication = adapter.publish(source([row]));
    const rowSpace = publication.rowSpace;
    if (rowSpace === undefined) throw new Error("Expected a resident row space.");
    const getRow = vi.fn((rowId: string) => rowSpace.getRow(rowId));
    runtime.publish({ ...publication, rowSpace: { ...rowSpace, getRow } });

    expect(view.getRowSnapshot("first")).toBe(row);
    expect(view.getRowSnapshot("first")).toBe(row);
    expect(getRow).toHaveBeenCalledTimes(2);

    const unsubscribe = view.subscribeRow("first", () => undefined);
    expect(view.getRowSnapshot("first")).toBe(row);
    expect(view.getRowSnapshot("first")).toBe(row);
    expect(getRow).toHaveBeenCalledTimes(3);

    unsubscribe();
    expect(view.getRowSnapshot("first")).toBe(row);
    expect(view.getRowSnapshot("first")).toBe(row);
    expect(getRow).toHaveBeenCalledTimes(5);
  });

  it("advances a derived row-order snapshot only with its notification", () => {
    const first = { id: "first", name: "Ada" } satisfies Row;
    const second = { id: "second", name: "Grace" } satisfies Row;
    const runtime = createRuntime(source([first, second]));
    const changes: unknown[] = [];
    const rowsStore = runtime.createRowsStore((previousRows, nextRows, change) => {
      changes.push(change);
      if (change.rowIdsChanged) return true;
      return change.changedIndexes.some(
        (index) =>
          (previousRows[index]?.raw as Row | undefined)?.name !==
          (nextRows[index]?.raw as Row | undefined)?.name,
      );
    });
    const listener = vi.fn();
    rowsStore.subscribe(listener);
    const initialSnapshot = rowsStore.getSnapshot();
    const unrelatedUpdate = { id: "second", name: "Grace", note: "updated" } satisfies Row;

    runtime.publish(source([first, unrelatedUpdate]));

    expect(listener).not.toHaveBeenCalled();
    expect(rowsStore.getSnapshot()).toBe(initialSnapshot);
    expect(changes).toEqual([{ rowIdsChanged: false, changedIndexes: [1] }]);

    const orderingUpdate = { ...unrelatedUpdate, name: "Hopper" } satisfies Row;
    runtime.publish(source([first, orderingUpdate]));

    expect(listener).toHaveBeenCalledOnce();
    expect(rawRows(rowsStore.getSnapshot())).toEqual([first, orderingUpdate]);
    expect(changes).toEqual([
      { rowIdsChanged: false, changedIndexes: [1] },
      { rowIdsChanged: false, changedIndexes: [1] },
    ]);
  });

  it("releases and resynchronizes derived row stores across idempotent disposal", () => {
    const first = { id: "first", name: "Ada" } satisfies Row;
    const runtime = createRuntime(source([first]));
    const rowsStore = runtime.createRowsStore(() => true);
    const staleListener = vi.fn();
    const unsubscribe = rowsStore.subscribe(staleListener);
    const initialSnapshot = rowsStore.getSnapshot();

    unsubscribe();
    unsubscribe();
    const updated = { id: "first", name: "Ada Lovelace" } satisfies Row;
    runtime.publish(source([updated]));

    expect(staleListener).not.toHaveBeenCalled();
    expect(rowsStore.getSnapshot()).toBe(initialSnapshot);

    const liveListener = vi.fn();
    const disposeLive = rowsStore.subscribe(liveListener);
    expect(rawRows(rowsStore.getSnapshot())).toEqual([updated]);
    const latest = { id: "first", name: "Countess Lovelace" } satisfies Row;
    runtime.publish(source([latest]));
    expect(liveListener).toHaveBeenCalledOnce();
    expect(rawRows(rowsStore.getSnapshot())).toEqual([latest]);
    disposeLive();
  });

  it("retains and silences unchanged column-command snapshots", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
      {
        columnId: "COL_ID_NOTE",
        field: "note",
        headerName: "Note",
        valueType: "text",
      },
    ]);
    const runtime = createClientRuntime(
      source([{ id: "first", name: "Ada", note: "math" }]),
      (row) => row.id,
      columns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const unchangedListener = vi.fn();
    const previous = runtime.getColumnCommandSnapshot("COL_ID_NOTE");
    runtime.subscribeColumnCommands("COL_ID_NOTE", unchangedListener);

    runtime.toggleColumnSort("COL_ID_NAME", false);

    expect(runtime.getColumnCommandSnapshot("COL_ID_NOTE")).toBe(previous);
    expect(unchangedListener).not.toHaveBeenCalled();
  });

  it("keeps unsubscribe functions idempotent after a subscription key is reused", () => {
    const first = { id: "first", name: "Ada" } satisfies Row;
    const runtime = createRuntime(source([first]));
    const staleRowListener = vi.fn();
    const liveRowListener = vi.fn();
    const staleCommandListener = vi.fn();
    const liveCommandListener = vi.fn();

    const unsubscribeRow = runtime.subscribeRow("first", staleRowListener);
    unsubscribeRow();
    runtime.subscribeRow("first", liveRowListener);
    unsubscribeRow();

    const unsubscribeCommand = runtime.subscribeColumnCommands("COL_ID_NAME", staleCommandListener);
    unsubscribeCommand();
    runtime.subscribeColumnCommands("COL_ID_NAME", liveCommandListener);
    unsubscribeCommand();

    runtime.publish(source([{ id: "first", name: "Ada Lovelace" }]));
    runtime.toggleColumnSort("COL_ID_NAME", false);

    expect(staleRowListener).not.toHaveBeenCalled();
    expect(liveRowListener).toHaveBeenCalledOnce();
    expect(staleCommandListener).not.toHaveBeenCalled();
    expect(liveCommandListener).toHaveBeenCalledOnce();
  });

  it("notifies every listener in one channel before rethrowing the first listener error", () => {
    const runtime = createRuntime(source([{ id: "first", name: "Ada" }]));
    const laterListener = vi.fn();
    runtime.subscribeChrome(() => {
      throw new Error("listener failed");
    });
    runtime.subscribeChrome(laterListener);

    expect(() => runtime.publish(source([], "loading"))).toThrow("listener failed");
    expect(laterListener).toHaveBeenCalledOnce();
    expect(runtime.getChromeSnapshot().status).toBe("loading");
  });

  it("finishes state and query notifications before rethrowing a listener error", () => {
    const runtime = createRuntime(source([{ id: "first", name: "Ada" }]));
    const replacementColumns = compileColumns([
      {
        columnId: "COL_ID_ALIAS",
        field: "name",
        headerName: "Alias",
        valueType: "text",
      },
    ]);
    const bodyListener = vi.fn();
    const queryListener = vi.fn();
    const aliasCommandListener = vi.fn();
    runtime.subscribeChrome(() => {
      throw new Error("chrome failed");
    });
    runtime.subscribeBody(bodyListener);
    runtime.subscribeQuery(queryListener);
    runtime.subscribeColumnCommands("COL_ID_ALIAS", aliasCommandListener);

    expect(() =>
      runtime.reconcile(
        source([], "loading", { totalRows: 1 }),
        (row) => row.id,
        replacementColumns,
      ),
    ).toThrow("chrome failed");

    expect(bodyListener).toHaveBeenCalledOnce();
    expect(queryListener).toHaveBeenCalledOnce();
    expect(aliasCommandListener).toHaveBeenCalledOnce();
    expect(runtime.getQuerySnapshot()).toMatchObject({
      orderBy: [{ columnId: "COL_ID_ALIAS", direction: "asc" }],
      generation: 1,
    });
  });

  it("finishes row and query notifications when a row-order detector throws", () => {
    const runtime = createRuntime(source([{ id: "first", name: "Ada" }]));
    const replacementColumns = compileColumns([
      {
        columnId: "COL_ID_ALIAS",
        field: "name",
        headerName: "Alias",
        valueType: "text",
      },
    ]);
    const throwingRowsListener = vi.fn();
    const laterRowsListener = vi.fn();
    const changedRowListener = vi.fn();
    const queryListener = vi.fn();
    const aliasCommandListener = vi.fn();
    const throwingRowsStore = runtime.createRowsStore(() => {
      throw new Error("detector failed");
    });
    const laterRowsStore = runtime.createRowsStore(() => true);
    throwingRowsStore.subscribe(throwingRowsListener);
    laterRowsStore.subscribe(laterRowsListener);
    runtime.subscribeRow("first", changedRowListener);
    runtime.subscribeQuery(queryListener);
    runtime.subscribeColumnCommands("COL_ID_ALIAS", aliasCommandListener);

    expect(() =>
      runtime.reconcile(
        source([{ id: "first", name: "Ada Lovelace" }]),
        (row) => row.id,
        replacementColumns,
      ),
    ).toThrow("detector failed");

    expect(throwingRowsListener).toHaveBeenCalledOnce();
    expect(laterRowsListener).toHaveBeenCalledOnce();
    expect(changedRowListener).toHaveBeenCalledOnce();
    expect(queryListener).toHaveBeenCalledOnce();
    expect(aliasCommandListener).toHaveBeenCalledOnce();
  });

  it("reuses row collections when a source publishes the same row references", () => {
    const rows = [{ id: "first", name: "Ada" }] satisfies readonly Row[];
    const getRowId = vi.fn((row: Row) => row.id);
    const runtime = createRuntime(source(rows), getRowId);
    const bodyListener = vi.fn();
    runtime.subscribeBody(bodyListener);
    const firstSnapshot = runtime.getBodySnapshot();
    getRowId.mockClear();

    runtime.publish(source(Array.from(rows)));

    expect(getRowId).not.toHaveBeenCalled();
    expect(bodyListener).not.toHaveBeenCalled();
    expect(runtime.getBodySnapshot()).toBe(firstSnapshot);
  });

  it("keeps unchanged row subscriptions quiet when the identity callback is recreated", () => {
    const first = { id: "first", name: "Ada" } satisfies Row;
    const second = { id: "second", name: "Grace" } satisfies Row;
    const rows = [first, second] as const;
    const runtime = createRuntime(source(rows));
    const bodyListener = vi.fn();
    const firstListener = vi.fn();
    const rowsListener = vi.fn();
    const rowsStore = runtime.createRowsStore((_previous, _next, change) => change.rowIdsChanged);
    runtime.subscribeBody(bodyListener);
    runtime.subscribeRow("first", firstListener);
    rowsStore.subscribe(rowsListener);
    const firstSnapshot = runtime.getRowSnapshot("first");

    const replacementGetRowId = vi.fn((row: Row) => row.id);
    runtime.configure(replacementGetRowId, runtimeColumns);

    expect(bodyListener).not.toHaveBeenCalled();
    expect(firstListener).not.toHaveBeenCalled();
    expect(rowsListener).not.toHaveBeenCalled();
    expect(runtime.getRowSnapshot("first")).toBe(firstSnapshot);
    expect(replacementGetRowId).toHaveBeenCalledTimes(rows.length);

    replacementGetRowId.mockClear();
    runtime.publish(source(Array.from(rows)));
    expect(replacementGetRowId).not.toHaveBeenCalled();
  });

  it("publishes an identity revision when getRowId changes for the same row array", () => {
    const row = { id: "first", name: "Ada" } satisfies Row;
    const rows = [row] as const;
    const runtime = createRuntime(source(rows));
    const rowsStore = runtime.createRowsStore((_previous, _next, change) => change.rowIdsChanged);
    const listener = vi.fn();
    rowsStore.subscribe(listener);
    const previousRows = rowsStore.getSnapshot();

    runtime.configure((value) => `next:${value.id}`, runtimeColumns);

    expect(listener).toHaveBeenCalledOnce();
    expect(rowsStore.getSnapshot()).not.toBe(previousRows);
    expect(rawRows(rowsStore.getSnapshot())).toEqual(rows);
    expect(runtime.getRowSnapshot("first")).toBeUndefined();
    expect(runtime.getRowSnapshot("next:first")).toBe(row);
  });

  it("accepts a unique identity swap when getRowId changes for unchanged rows", () => {
    const first = { id: "first", name: "Ada" } satisfies Row;
    const second = { id: "second", name: "Grace" } satisfies Row;
    const runtime = createRuntime(source([first, second]));
    const rowsStore = runtime.createRowsStore((_previous, _next, change) => change.rowIdsChanged);
    const listener = vi.fn();
    rowsStore.subscribe(listener);

    runtime.configure((row) => (row.id === "first" ? "second" : "first"), runtimeColumns);

    expect(listener).toHaveBeenCalledOnce();
    expect(runtime.getRowSpaceSnapshot()?.getRowId(0)).toBe("second");
    expect(runtime.getRowSpaceSnapshot()?.getRowId(1)).toBe("first");
    expect(runtime.getRowSnapshot("second")).toBe(first);
    expect(runtime.getRowSnapshot("first")).toBe(second);
  });

  it("reconciles a new source and identity callback in one row pass", () => {
    const runtime = createRuntime(source([{ id: "initial", name: "Initial" }]));
    const nextRows = [
      { id: "first", name: "Ada" },
      { id: "second", name: "Grace" },
    ] satisfies readonly Row[];
    const getRowId = vi.fn((row: Row) => row.id);

    runtime.reconcile(source(nextRows), getRowId, runtimeColumns);

    expect(getRowId).toHaveBeenCalledTimes(nextRows.length);
    expect(runtime.getBodySnapshot()).toEqual({ kind: "rows" });
    const rowsStore = runtime.createRowsStore(() => true);
    expect(rawRows(rowsStore.getSnapshot())).toEqual(nextRows);
  });

  it("notifies simultaneous source, identity, and column replacement as one coherent state", () => {
    const runtime = createRuntime(source([{ id: "initial", name: "Initial" }]));
    const replacementColumns = compileColumns([
      {
        columnId: "COL_ID_ALIAS",
        field: "name",
        headerName: "Alias",
        valueType: "text",
      },
    ]);
    const nextRow = { id: "next", name: "Ada" } satisfies Row;
    const observations: unknown[] = [];
    runtime.subscribeQuery(() => {
      observations.push({
        body: runtime.getBodySnapshot(),
        query: runtime.getQuerySnapshot(),
        resolvedRowId: runtime.resolveRowId(nextRow),
        row: runtime.getRowSnapshot("next:next"),
      });
    });

    runtime.reconcile(source([nextRow]), (row) => `next:${row.id}`, replacementColumns);

    expect(observations).toEqual([
      {
        body: { kind: "rows" },
        query: {
          columns: replacementColumns,
          filters: [],
          quickFilter: "",
          orderBy: [{ columnId: "COL_ID_ALIAS", direction: "asc" }],
          generation: 1,
        },
        resolvedRowId: "next:next",
        row: nextRow,
      },
    ]);
  });

  it("leaves every observable projection unchanged when reconciliation validation fails", () => {
    const runtime = createRuntime(source([{ id: "initial", name: "Initial" }]));
    const replacementColumns = compileColumns([
      {
        columnId: "COL_ID_ALIAS",
        field: "name",
        headerName: "Alias",
        valueType: "text",
      },
    ]);
    const previousBody = runtime.getBodySnapshot();
    const previousChrome = runtime.getChromeSnapshot();
    const previousQuery = runtime.getQuerySnapshot();
    const rowsStore = runtime.createRowsStore(() => true);
    const previousRows = rowsStore.getSnapshot();
    const previousRow = runtime.getRowSnapshot("initial");
    const previousNameCommand = runtime.getColumnCommandSnapshot("COL_ID_NAME");
    const previousAliasCommand = runtime.getColumnCommandSnapshot("COL_ID_ALIAS");
    const chromeListener = vi.fn();
    const queryListener = vi.fn();
    const bodyListener = vi.fn();
    const rowsListener = vi.fn();
    const rowListener = vi.fn();
    const nameCommandListener = vi.fn();
    const aliasCommandListener = vi.fn();
    runtime.subscribeChrome(chromeListener);
    runtime.subscribeQuery(queryListener);
    runtime.subscribeBody(bodyListener);
    rowsStore.subscribe(rowsListener);
    runtime.subscribeRow("initial", rowListener);
    runtime.subscribeColumnCommands("COL_ID_NAME", nameCommandListener);
    runtime.subscribeColumnCommands("COL_ID_ALIAS", aliasCommandListener);

    expect(() =>
      runtime.reconcile(
        source([
          { id: "first", name: "Ada" },
          { id: "second", name: "Grace" },
        ]),
        () => "duplicate",
        replacementColumns,
      ),
    ).toThrow(/duplicate row identity/u);

    expect(runtime.getBodySnapshot()).toBe(previousBody);
    expect(runtime.getChromeSnapshot()).toBe(previousChrome);
    expect(runtime.getQuerySnapshot()).toBe(previousQuery);
    expect(rowsStore.getSnapshot()).toBe(previousRows);
    expect(runtime.getRowSnapshot("initial")).toBe(previousRow);
    expect(runtime.getColumnCommandSnapshot("COL_ID_NAME")).toBe(previousNameCommand);
    expect(runtime.getColumnCommandSnapshot("COL_ID_ALIAS")).toBe(previousAliasCommand);
    expect(runtime.resolveRowId({ id: "still-old", name: "Old getter" })).toBe("still-old");
    expect(chromeListener).not.toHaveBeenCalled();
    expect(queryListener).not.toHaveBeenCalled();
    expect(bodyListener).not.toHaveBeenCalled();
    expect(rowsListener).not.toHaveBeenCalled();
    expect(rowListener).not.toHaveBeenCalled();
    expect(nameCommandListener).not.toHaveBeenCalled();
    expect(aliasCommandListener).not.toHaveBeenCalled();

    const recovered = { id: "recovered", name: "Recovered" } satisfies Row;
    runtime.reconcile(source([recovered]), (row) => row.id, runtimeColumns);
    expect(runtime.getRowSnapshot("initial")).toBeUndefined();
    expect(runtime.getRowSnapshot("recovered")).toBe(recovered);
  });

  it("rejects incomplete ready and stale source snapshots visibly", () => {
    const row = { id: "first", name: "Ada" } satisfies Row;
    const runtime = createRuntime(source([row]));

    runtime.publish(source([], "ready", { totalRows: 1 }));
    expect(runtime.getChromeSnapshot()).toMatchObject({
      invalid: { kind: "row-count-mismatch", expectedRows: 1, receivedRows: 0 },
    });
    expect(runtime.getBodySnapshot().kind).toBe("invalid");

    runtime.publish(source([], "stale", { totalRows: 1 }));
    expect(runtime.getChromeSnapshot()).toMatchObject({
      invalid: { kind: "row-count-mismatch" },
    });
    expect(runtime.getBodySnapshot().kind).toBe("rows");
  });

  it("brands invalid source values for the row model or presentation island to reject", () => {
    type NumberRow = { readonly id: string; readonly name: string; readonly score: number };
    const numberColumns = compileColumns([
      {
        columnId: "COL_ID_SCORE",
        field: "score",
        headerName: "Score",
        valueType: "number",
      },
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    const invalidRows = [
      { id: "invalid", name: "Invalid", score: Number.NaN },
    ] satisfies readonly NumberRow[];
    const adapter = new BrunoTableClientRowPipelineAdapter(
      {
        rows: invalidRows,
        totalRows: invalidRows.length,
        version: 1,
        status: "ready",
      },
      (row) => row.id,
      numberColumns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const runtime = new BrunoTableGridRuntime(
      adapter.getPublication(),
      numberColumns,
      adapter.getQueryConfiguration(numberColumns),
      "TABLE_ID_GRID_RUNTIME_INVALID_VALUE",
    );

    const value = runtime.getCellValueSnapshot("invalid", "COL_ID_SCORE");
    expect(isBrunoTableInvalidCellValue(value)).toBe(true);
    if (!isBrunoTableInvalidCellValue(value)) return;
    expect(value.invalid).toEqual({
      kind: "invalid-value",
      rowIndex: 0,
      columnId: "COL_ID_SCORE",
      message: "Expected a finite number value.",
    });
    expect(runtime.getBodySnapshot()).toEqual({ kind: "rows" });
  });

  it("leaves exhaustive query decoding to actual row-model reads", () => {
    const [baseColumn] = runtimeColumns;
    const decodeRuntime = vi.fn(baseColumn!.semantics.decodeRuntime);
    const instrumentedColumns = Object.freeze([
      Object.freeze({
        ...baseColumn!,
        semantics: Object.freeze({ ...baseColumn!.semantics, decodeRuntime }),
      }),
    ] satisfies readonly CompiledColumn[]);
    const initialRows = [
      { id: "first", name: "Ada" },
      { id: "second", name: "Grace" },
    ] satisfies readonly Row[];
    const initialSource = source(initialRows);
    const getRowId = (row: Row) => row.id;
    const adapter = new BrunoTableClientRowPipelineAdapter(
      initialSource,
      getRowId,
      instrumentedColumns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );

    expect(decodeRuntime).not.toHaveBeenCalled();

    adapter.reconcile(initialSource, getRowId, instrumentedColumns);
    expect(decodeRuntime).not.toHaveBeenCalled();
  });

  it("decodes only changed source rows when column semantics stay installed", () => {
    const [baseColumn] = runtimeColumns;
    const decodeRuntime = vi.fn(baseColumn!.semantics.decodeRuntime);
    const instrumentedColumns = Object.freeze([
      Object.freeze({
        ...baseColumn!,
        semantics: Object.freeze({ ...baseColumn!.semantics, decodeRuntime }),
      }),
    ] satisfies readonly CompiledColumn[]);
    const first = { id: "first", name: "Ada" } satisfies Row;
    const second = { id: "second", name: "Grace" } satisfies Row;
    const adapter = new BrunoTableClientRowPipelineAdapter(
      source([first, second]),
      (row) => row.id,
      instrumentedColumns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );

    let rowSpace = adapter.getPublication().rowSpace!;
    rowSpace.getCellValue("first", "COL_ID_NAME");
    rowSpace.getCellValue("second", "COL_ID_NAME");
    expect(decodeRuntime).toHaveBeenCalledTimes(2);

    adapter.publish(source([first, second]));
    rowSpace = adapter.getPublication().rowSpace!;
    rowSpace.getCellValue("first", "COL_ID_NAME");
    rowSpace.getCellValue("second", "COL_ID_NAME");
    expect(decodeRuntime).toHaveBeenCalledTimes(2);

    const updatedSecond = { id: "second", name: "Hopper" } satisfies Row;
    adapter.publish(source([first, updatedSecond]));
    rowSpace = adapter.getPublication().rowSpace!;
    rowSpace.getCellValue("first", "COL_ID_NAME");
    rowSpace.getCellValue("second", "COL_ID_NAME");
    expect(decodeRuntime).toHaveBeenCalledTimes(3);

    const replacementColumns = Object.freeze(Array.from(instrumentedColumns));
    adapter.configure((row) => (row as Row).id, replacementColumns);
    rowSpace = adapter.getPublication().rowSpace!;
    rowSpace.getCellValue("first", "COL_ID_NAME");
    rowSpace.getCellValue("second", "COL_ID_NAME");
    expect(decodeRuntime).toHaveBeenCalledTimes(3);

    adapter.publish(source([first, updatedSecond]));
    rowSpace = adapter.getPublication().rowSpace!;
    rowSpace.getCellValue("first", "COL_ID_NAME");
    rowSpace.getCellValue("second", "COL_ID_NAME");
    expect(decodeRuntime).toHaveBeenCalledTimes(3);
  });

  it("reuses canonical values across sustained sparse source publications", () => {
    const [baseColumn] = runtimeColumns;
    const decodeRuntime = vi.fn(baseColumn!.semantics.decodeRuntime);
    const instrumentedColumns = Object.freeze([
      Object.freeze({
        ...baseColumn!,
        semantics: Object.freeze({ ...baseColumn!.semantics, decodeRuntime }),
      }),
    ] satisfies readonly CompiledColumn[]);
    let rows = Array.from({ length: 256 }, (_, index) => ({
      id: `row-${String(index)}`,
      name: `Name ${String(index)}`,
    })) satisfies readonly Row[];
    const adapter = new BrunoTableClientRowPipelineAdapter(
      source(rows),
      (row) => row.id,
      instrumentedColumns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );

    for (const row of rows) {
      adapter.getPublication().rowSpace?.getCellValue(row.id, "COL_ID_NAME");
    }
    expect(decodeRuntime).toHaveBeenCalledTimes(rows.length);

    for (let publication = 0; publication < 64; publication += 1) {
      const changedIndex = publication % rows.length;
      rows = rows.with(changedIndex, {
        ...rows[changedIndex]!,
        name: `Changed ${String(publication)}`,
      });
      adapter.publish(source(rows));
      for (const row of rows) {
        adapter.getPublication().rowSpace?.getCellValue(row.id, "COL_ID_NAME");
      }
    }

    expect(decodeRuntime).toHaveBeenCalledTimes(256 + 64);
  });

  it("prunes canonical values only when the retained column schema changes", () => {
    const first = { id: "first", name: "Ada" } satisfies Row;
    const second = { id: "second", name: "Grace" } satisfies Row;
    const adapter = new BrunoTableClientRowPipelineAdapter(
      source([first, second]),
      (row) => row.id,
      runtimeColumns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const rowSpace = adapter.getPublication().rowSpace!;
    rowSpace.getCellValue("first", "COL_ID_NAME");
    rowSpace.getCellValue("second", "COL_ID_NAME");
    const prunes = vi.fn();
    const restore = installBrunoTableClientValueCachePruneListener(prunes);
    try {
      adapter.publish(source([first, { ...second, note: "Changed" }]));
      expect(prunes).not.toHaveBeenCalled();

      const replacementColumns = Object.freeze(
        runtimeColumns.map((column) => Object.freeze({ ...column })),
      );
      adapter.configure((row) => row.id, replacementColumns);
      expect(prunes).toHaveBeenCalledOnce();
      expect(prunes).toHaveBeenCalledWith(2);
    } finally {
      restore();
    }
  });

  it("decodes query columns columnarly and presentation cells on demand", () => {
    const decodeRuntime = vi.fn((input: unknown) => ({ _tag: "Success", value: input }) as const);
    const wideColumns = Object.freeze(
      compileColumns(
        Array.from({ length: 1_000 }, (_, index) => ({
          columnId: `COL_ID_LAZY_${String(index).padStart(4, "0")}`,
          field: "name",
          headerName: `Lazy ${String(index)}`,
          valueType: "text",
        })),
      ).map((column) =>
        Object.freeze({
          ...column,
          semantics: Object.freeze({ ...column.semantics, decodeRuntime }),
        }),
      ),
    );
    const first = { id: "first", name: "Ada" } satisfies Row;
    const second = { id: "second", name: "Grace" } satisfies Row;
    const adapter = new BrunoTableClientRowPipelineAdapter(
      source([first, second]),
      (row) => row.id,
      wideColumns,
      undefined,
      [{ columnId: "COL_ID_LAZY_0000", direction: "asc" }],
    );
    const runtime = new BrunoTableGridRuntime(
      adapter.getPublication(),
      wideColumns,
      adapter.getQueryConfiguration(wideColumns),
      "TABLE_ID_GRID_RUNTIME_LAZY_VALUES",
    );

    expect(runtime.getCellValueSnapshot("first", "COL_ID_LAZY_0000")).toBe("Ada");
    expect(runtime.getCellValueSnapshot("second", "COL_ID_LAZY_0000")).toBe("Grace");
    expect(decodeRuntime).toHaveBeenCalledTimes(2);
    expect(runtime.getCellValueSnapshot("first", "COL_ID_LAZY_0999")).toBe("Ada");
    expect(decodeRuntime).toHaveBeenCalledTimes(3);
    expect(runtime.getCellValueSnapshot("first", "COL_ID_LAZY_0999")).toBe("Ada");
    expect(decodeRuntime).toHaveBeenCalledTimes(3);
  });

  it("enforces one table-wide bound for primitive-row canonical values", () => {
    const decodeRuntime = vi.fn((input: unknown) => ({ _tag: "Success", value: input }) as const);
    const primitiveColumns = Object.freeze(
      compileColumns([
        {
          columnId: "COL_ID_LENGTH_PRIMARY",
          field: "length",
          headerName: "Primary length",
          valueType: "number",
        },
        {
          columnId: "COL_ID_LENGTH_SECONDARY",
          field: "length",
          headerName: "Secondary length",
          valueType: "number",
        },
      ]).map((column) =>
        Object.freeze({
          ...column,
          semantics: Object.freeze({ ...column.semantics, decodeRuntime }),
        }),
      ),
    );
    const primitiveRows = Array.from({ length: 9_000 }, (_, index) => `row-${String(index)}`);
    const adapter = new BrunoTableClientRowPipelineAdapter(
      {
        rows: primitiveRows,
        totalRows: primitiveRows.length,
        version: 1,
        status: "ready",
      },
      (row) => row,
      primitiveColumns,
      undefined,
      [{ columnId: "COL_ID_LENGTH_PRIMARY", direction: "asc" }],
    );
    const rowSpace = adapter.getPublication().rowSpace!;

    for (const rowId of primitiveRows) {
      rowSpace.getCellValue(rowId, "COL_ID_LENGTH_PRIMARY");
    }
    expect(decodeRuntime).toHaveBeenCalledTimes(9_000);
    for (const rowId of primitiveRows) {
      rowSpace.getCellValue(rowId, "COL_ID_LENGTH_SECONDARY");
    }
    expect(decodeRuntime).toHaveBeenCalledTimes(18_000);

    rowSpace.getCellValue(primitiveRows[0]!, "COL_ID_LENGTH_PRIMARY");
    expect(decodeRuntime).toHaveBeenCalledTimes(18_001);
  });

  it("enforces the same table-wide bound for retained object rows", () => {
    const decodeRuntime = vi.fn((input: unknown) => ({ _tag: "Success", value: input }) as const);
    const objectColumns = Object.freeze(
      compileColumns([
        {
          columnId: "COL_ID_NAME_PRIMARY",
          field: "name",
          headerName: "Primary name",
          valueType: "text",
        },
        {
          columnId: "COL_ID_NAME_SECONDARY",
          field: "name",
          headerName: "Secondary name",
          valueType: "text",
        },
      ]).map((column) =>
        Object.freeze({
          ...column,
          semantics: Object.freeze({ ...column.semantics, decodeRuntime }),
        }),
      ),
    );
    const objectRows = Array.from({ length: 9_000 }, (_, index) => ({
      id: `row-${String(index)}`,
      name: `Name ${String(index)}`,
    }));
    const adapter = new BrunoTableClientRowPipelineAdapter(
      {
        rows: objectRows,
        totalRows: objectRows.length,
        version: 1,
        status: "ready",
      },
      (row) => row.id,
      objectColumns,
      undefined,
      [{ columnId: "COL_ID_NAME_PRIMARY", direction: "asc" }],
    );
    const rowSpace = adapter.getPublication().rowSpace!;

    for (const row of objectRows) {
      rowSpace.getCellValue(row.id, "COL_ID_NAME_PRIMARY");
    }
    expect(decodeRuntime).toHaveBeenCalledTimes(9_000);
    for (const row of objectRows) {
      rowSpace.getCellValue(row.id, "COL_ID_NAME_SECONDARY");
    }
    expect(decodeRuntime).toHaveBeenCalledTimes(18_000);

    rowSpace.getCellValue(objectRows[0]!.id, "COL_ID_NAME_PRIMARY");
    expect(decodeRuntime).toHaveBeenCalledTimes(18_001);
  });

  it("retains canonical decoder output separately from the raw source row", () => {
    const [baseColumn] = runtimeColumns;
    const canonicalColumns = Object.freeze([
      Object.freeze({
        ...baseColumn!,
        semantics: Object.freeze({
          ...baseColumn!.semantics,
          decodeRuntime: (input: unknown) =>
            typeof input === "string"
              ? ({ _tag: "Success", value: input.toUpperCase() } as const)
              : ({ _tag: "Failure", message: "Expected text." } as const),
        }),
      }),
    ] satisfies readonly CompiledColumn[]);
    const raw = { id: "first", name: "ada" } satisfies Row;
    const adapter = new BrunoTableClientRowPipelineAdapter(
      source([raw]),
      (row) => row.id,
      canonicalColumns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const runtime = new BrunoTableGridRuntime(
      adapter.getPublication(),
      canonicalColumns,
      adapter.getQueryConfiguration(canonicalColumns),
      "TABLE_ID_GRID_RUNTIME_CANONICAL_VALUES",
    );

    expect(runtime.getRowSnapshot("first")).toBe(raw);
    expect(runtime.getCellValueSnapshot("first", "COL_ID_NAME")).toBe("ADA");
    expect(
      adapter.createRowsStore(runtime.getView(), () => () => true).getSnapshot()[0],
    ).toMatchObject({
      raw,
      rowId: "first",
    });
    const admitted = adapter.createRowsStore(runtime.getView(), () => () => true).getSnapshot()[0]!;
    expect(
      admitted.values.read(admitted.raw, admitted.rowId, admitted.rowIndex, canonicalColumns[0]!),
    ).toBe("ADA");
  });

  it("retains the last coherent rows under an incomplete stale publication", () => {
    const row = { id: "first", name: "Ada" } satisfies Row;
    const runtime = createRuntime(source([row]));

    runtime.publish(source([], "stale", { totalRows: 1, message: "delayed partial" }));

    expect(runtime.getChromeSnapshot()).toMatchObject({
      status: "stale",
      invalid: { kind: "row-count-mismatch" },
      hasCoherentRows: true,
    });
    expect(runtime.getBodySnapshot()).toEqual({ kind: "rows" });
    expect(runtime.getRowSnapshot("first")).toBe(row);
  });

  it("transitions retained query rows without re-resolving resident identities", () => {
    const residentRows = Array.from({ length: 20_000 }, (_unused, index) => ({
      id: `row-${String(index)}`,
      name: `Accepted ${String(index)}`,
    })) satisfies readonly Row[];
    const candidateRows = residentRows.map((row, index) => ({
      ...row,
      name: `Candidate ${String(index)}`,
    }));
    const getRowId = vi.fn((row: Row) => row.id);
    const adapter = new BrunoTableClientRowPipelineAdapter(
      source(residentRows),
      getRowId,
      runtimeColumns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const runtime = new BrunoTableGridRuntime(
      adapter.getPublication(),
      runtimeColumns,
      adapter.getQueryConfiguration(runtimeColumns),
      "TABLE_ID_GRID_RUNTIME_RETAINED_ROWS",
    );
    const rowsStore = adapter.createRowsStore(runtime.getView(), () => () => true);
    const unsubscribe = rowsStore.subscribe(() => undefined);
    adapter.acceptRows(rowsStore.getSnapshot());
    runtime.publish(adapter.publish(source(candidateRows, "stale")));
    const rejectedRows = rowsStore.getSnapshot();
    const reconciliationEvents = vi.fn<(event: BrunoTableClientReconciliationEvent) => void>();
    const removeReconciliationListener =
      installBrunoTableClientReconciliationListener(reconciliationEvents);
    getRowId.mockClear();

    try {
      const fallback = adapter.rejectQueryRows(rejectedRows, {
        kind: "invalid-value",
        rowIndex: 0,
        columnId: "COL_ID_NAME",
        message: "Rejected by the active query.",
      });
      runtime.publish(fallback!);
      const fallbackRows = rowsStore.getSnapshot();
      const empty = adapter.rejectQueryRows(fallbackRows, {
        kind: "invalid-value",
        rowIndex: 1,
        columnId: "COL_ID_NAME",
        message: "The retained predecessor also failed.",
      });

      expect(getRowId).not.toHaveBeenCalled();
      expect(reconciliationEvents).not.toHaveBeenCalled();
      expect(fallback?.rowSpace?.getRow("row-0")).toBe(residentRows[0]);
      expect(fallback?.invalid).toMatchObject({ kind: "invalid-value" });
      expect(empty).toMatchObject({ hasCoherentRows: false });
      expect(empty?.rowSpace).toBeUndefined();
    } finally {
      removeReconciliationListener();
      unsubscribe();
    }
  });

  it("rejects an unsupported source status without admitting its rows", () => {
    const malformed = {
      rows: [{ id: "invalid", name: "Untrusted" }],
      totalRows: 1,
      version: 1,
      status: "offline",
    } as unknown as ReturnType<typeof source>;
    const runtime = createRuntime(malformed);

    expect(runtime.getChromeSnapshot()).toEqual({
      status: "error",
      hasCoherentRows: false,
      invalid: { kind: "invalid-status", receivedStatus: "offline" },
    });
    expect(runtime.getBodySnapshot()).toEqual({ kind: "empty" });
    expect(runtime.getRowSnapshot("invalid")).toBeUndefined();
  });

  it("retains coherent rows while rejecting an unsupported source status", () => {
    const accepted = { id: "accepted", name: "Ada" } satisfies Row;
    const runtime = createRuntime(source([accepted]));
    const malformed = {
      rows: [{ id: "candidate", name: "Untrusted" }],
      totalRows: 1,
      version: 2,
      status: "offline",
    } as unknown as ReturnType<typeof source>;

    runtime.publish(malformed);

    expect(runtime.getChromeSnapshot()).toEqual({
      status: "error",
      hasCoherentRows: true,
      invalid: { kind: "invalid-status", receivedStatus: "offline" },
    });
    expect(runtime.getBodySnapshot()).toEqual({ kind: "rows" });
    expect(runtime.getRowSnapshot("accepted")).toBe(accepted);
    expect(runtime.getRowSnapshot("candidate")).toBeUndefined();
  });

  it("does not read rows from unsupported-status publications", () => {
    const rowsRead = vi.fn();
    const malformed = (version: number) =>
      ({
        get rows(): readonly Row[] {
          rowsRead();
          throw new Error("Unsupported-status rows must stay unread.");
        },
        totalRows: 1,
        version,
        status: "offline",
      }) as unknown as ReturnType<typeof source>;
    const initialRuntime = createRuntime(malformed(1));
    const accepted = { id: "accepted", name: "Ada" } satisfies Row;
    const updatedRuntime = createRuntime(source([accepted]));

    updatedRuntime.publish(malformed(2));

    expect(initialRuntime.getChromeSnapshot()).toEqual({
      status: "error",
      hasCoherentRows: false,
      invalid: { kind: "invalid-status", receivedStatus: "offline" },
    });
    expect(updatedRuntime.getChromeSnapshot()).toEqual({
      status: "error",
      hasCoherentRows: true,
      invalid: { kind: "invalid-status", receivedStatus: "offline" },
    });
    expect(updatedRuntime.getRowSnapshot("accepted")).toBe(accepted);
    expect(rowsRead).not.toHaveBeenCalled();
  });

  it.each(["status", "totalRows", "version"] as const)(
    "contains an unreadable required Client Source %s getter and retains accepted rows",
    (property) => {
      const unreadable = (version: number) => {
        const candidate = {
          rows: [{ id: "candidate", name: "Untrusted" }],
          totalRows: 1,
          version,
          status: "ready" as const,
        };
        Object.defineProperty(candidate, property, {
          get: () => {
            throw new Error(`Unreadable ${property}.`);
          },
        });
        return candidate as ReturnType<typeof source>;
      };
      const getRowId = vi.fn((row: Row) => row.id);
      const initialRuntime = createRuntime(unreadable(1), getRowId);
      const accepted = { id: "accepted", name: "Ada" } satisfies Row;
      const updatedRuntime = createRuntime(source([accepted]), getRowId);
      const identityReads = getRowId.mock.calls.length;

      expect(() => updatedRuntime.publish(unreadable(2))).not.toThrow();

      expect(initialRuntime.getChromeSnapshot()).toEqual({
        status: "error",
        hasCoherentRows: false,
        invalid: { kind: "invalid-lifecycle", field: property },
      });
      expect(initialRuntime.getBodySnapshot()).toEqual({ kind: "empty" });
      expect(updatedRuntime.getChromeSnapshot()).toEqual({
        status: "error",
        hasCoherentRows: true,
        invalid: { kind: "invalid-lifecycle", field: property },
      });
      expect(updatedRuntime.getRowSnapshot("accepted")).toBe(accepted);
      expect(updatedRuntime.getRowSnapshot("candidate")).toBeUndefined();
      expect(getRowId).toHaveBeenCalledTimes(identityReads);
    },
  );

  it.each([
    [
      "totalRows",
      {
        [Symbol.toPrimitive]: () => {
          throw new Error("Do not coerce.");
        },
      },
    ],
    ["totalRows", -1],
    ["totalRows", 1.5],
    ["version", "2"],
    ["version", Number.NaN],
    ["version", Number.POSITIVE_INFINITY],
  ] as const)("contains an invalid required Client Source %s value", (property, value) => {
    const malformed = {
      rows: [{ id: "candidate", name: "Untrusted" }],
      totalRows: 1,
      version: 1,
      status: "ready",
      [property]: value,
    } as unknown as ReturnType<typeof source>;

    expect(() => createRuntime(malformed)).not.toThrow();
    const runtime = createRuntime(malformed);
    expect(runtime.getChromeSnapshot()).toEqual({
      status: "error",
      hasCoherentRows: false,
      invalid: { kind: "invalid-lifecycle", field: property },
    });
    expect(runtime.getBodySnapshot()).toEqual({ kind: "empty" });
  });

  it.each(["statusCode", "message", "retry"] as const)(
    "omits an unreadable optional Client Source %s getter while admitting ready rows",
    (property) => {
      const candidate = { id: "candidate", name: "Trusted" } satisfies Row;
      const ready = source([candidate]);
      Object.defineProperty(ready, property, {
        get: () => {
          throw new Error(`Unreadable ${property}.`);
        },
      });

      const runtime = createRuntime(ready);

      expect(runtime.getChromeSnapshot()).toEqual({ status: "ready", hasCoherentRows: true });
      expect(runtime.getBodySnapshot()).toEqual({ kind: "rows" });
      expect(runtime.getRowSnapshot("candidate")).toBe(candidate);
    },
  );

  it.each(["statusCode", "message", "retry"] as const)(
    "preserves loading skeletons when the optional Client Source %s getter is unreadable",
    (property) => {
      const loading = source([], "loading", { totalRows: 2 });
      Object.defineProperty(loading, property, {
        get: () => {
          throw new Error(`Unreadable ${property}.`);
        },
      });

      const runtime = createRuntime(loading);

      expect(runtime.getChromeSnapshot()).toEqual({ status: "loading", hasCoherentRows: false });
      expect(runtime.getBodySnapshot()).toEqual({ kind: "loading", totalRows: 2 });
    },
  );

  it("rejects a malformed Client Source row collection without throwing", () => {
    const malformed = {
      rows: null,
      totalRows: 1,
      version: 1,
      status: "ready",
    } as unknown as ReturnType<typeof source>;
    const runtime = createRuntime(malformed);

    expect(runtime.getChromeSnapshot()).toEqual({
      status: "error",
      hasCoherentRows: false,
      invalid: { kind: "invalid-rows", receivedRows: "null" },
    });
    expect(runtime.getBodySnapshot()).toEqual({ kind: "empty" });
  });

  it("rejects a sparse Client Source row collection before resolving row identities", () => {
    const sparseRows = Array<Row>(2);
    sparseRows[1] = { id: "candidate", name: "Untrusted" };
    const getRowId = vi.fn((row: Row) => row.id);

    const runtime = createRuntime(source(sparseRows), getRowId);

    expect(runtime.getChromeSnapshot()).toEqual({
      status: "error",
      hasCoherentRows: false,
      invalid: { kind: "invalid-rows", receivedRows: "sparse array" },
    });
    expect(runtime.getBodySnapshot()).toEqual({ kind: "empty" });
    expect(getRowId).not.toHaveBeenCalled();
  });

  it("captures a published Array proxy length and entries exactly once inside the guarded snapshot", () => {
    const accepted = { id: "accepted", name: "Ada" } satisfies Row;
    const stable = { id: "stable", name: "Grace" } satisfies Row;
    const updated = { id: "accepted", name: "Ada Lovelace" } satisfies Row;
    const runtime = createRuntime(source([accepted, stable]));
    let lengthReads = 0;
    const entryReads = new Map<PropertyKey, number>();
    const proxiedRows = new Proxy([updated, stable], {
      get: (target, property, receiver) => {
        if (property === "length") {
          lengthReads += 1;
          if (lengthReads > 1) throw new Error("Client Source rows length was reread.");
        }
        if (property === "0" || property === "1") {
          const reads = (entryReads.get(property) ?? 0) + 1;
          entryReads.set(property, reads);
          if (reads > 1) throw new Error(`Client Source row ${property} was reread.`);
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    runtime.publish({
      rows: proxiedRows,
      totalRows: 2,
      version: 2,
      status: "ready",
    });

    expect(runtime.getChromeSnapshot()).toEqual({ status: "ready", hasCoherentRows: true });
    expect(runtime.getRowSnapshot("accepted")).toBe(updated);
    expect(runtime.getRowSnapshot("stable")).toBe(stable);
    expect(lengthReads).toBe(1);
    expect(entryReads).toEqual(
      new Map<PropertyKey, number>([
        ["0", 1],
        ["1", 1],
      ]),
    );
  });

  it("contains a cyclic Client Source rows prototype chain", () => {
    let cyclicRows: Row[];
    cyclicRows = new Proxy([] as Row[], {
      getPrototypeOf: () => cyclicRows,
    });

    expect(() =>
      createRuntime({ rows: cyclicRows, totalRows: 0, version: 1, status: "ready" }),
    ).not.toThrow();
    const runtime = createRuntime({
      rows: cyclicRows,
      totalRows: 0,
      version: 1,
      status: "ready",
    });
    expect(runtime.getChromeSnapshot()).toEqual({
      status: "error",
      hasCoherentRows: false,
      invalid: { kind: "invalid-rows", receivedRows: "unreadable" },
    });
    expect(runtime.getBodySnapshot()).toEqual({ kind: "empty" });
  });

  it("retains coherent rows while rejecting a malformed later row collection", () => {
    const accepted = { id: "accepted", name: "Ada" } satisfies Row;
    const runtime = createRuntime(source([accepted]));

    runtime.publish({
      rows: null,
      totalRows: 1,
      version: 2,
      status: "ready",
    } as unknown as ReturnType<typeof source>);

    expect(runtime.getChromeSnapshot()).toEqual({
      status: "error",
      hasCoherentRows: true,
      invalid: { kind: "invalid-rows", receivedRows: "null" },
    });
    expect(runtime.getBodySnapshot()).toEqual({ kind: "rows" });
    expect(runtime.getRowSnapshot("accepted")).toBe(accepted);
  });

  it("retains coherent rows while rejecting a sparse later row collection", () => {
    const accepted = { id: "accepted", name: "Ada" } satisfies Row;
    const getRowId = vi.fn((row: Row) => row.id);
    const runtime = createRuntime(source([accepted]), getRowId);
    const identityReads = getRowId.mock.calls.length;
    const sparseRows = Array<Row>(2);
    sparseRows[1] = { id: "candidate", name: "Untrusted" };

    runtime.publish(source(sparseRows));

    expect(runtime.getChromeSnapshot()).toEqual({
      status: "error",
      hasCoherentRows: true,
      invalid: { kind: "invalid-rows", receivedRows: "sparse array" },
    });
    expect(runtime.getBodySnapshot()).toEqual({ kind: "rows" });
    expect(runtime.getRowSnapshot("accepted")).toBe(accepted);
    expect(runtime.getRowSnapshot("candidate")).toBeUndefined();
    expect(getRowId).toHaveBeenCalledTimes(identityReads);
  });

  it.each([
    ["malformed rows", "stale" as const],
    ["unsupported status", "offline" as const],
  ])("retains initially stale accepted rows after %s", (_label, nextStatus) => {
    const accepted = { id: "accepted", name: "Ada" } satisfies Row;
    const runtime = createRuntime(source([accepted], "stale"));
    const malformed = {
      rows: nextStatus === "stale" ? null : [{ id: "candidate", name: "Untrusted" }],
      totalRows: 1,
      version: 2,
      status: nextStatus,
    } as unknown as ReturnType<typeof source>;

    runtime.publish(malformed);

    expect(runtime.getChromeSnapshot()).toMatchObject({
      status: "error",
      hasCoherentRows: true,
    });
    expect(runtime.getBodySnapshot()).toEqual({ kind: "rows" });
    expect(runtime.getRowSnapshot("accepted")).toBe(accepted);
    expect(runtime.getRowSnapshot("candidate")).toBeUndefined();
  });

  it("contains unreadable non-loading row collections and retains accepted rows", () => {
    const rowsRead = vi.fn();
    const unreadable = (version: number, status: "ready" | "stale") =>
      ({
        get rows(): readonly Row[] {
          rowsRead();
          throw new Error("Hostile row getter.");
        },
        totalRows: 1,
        version,
        status,
      }) as ReturnType<typeof source>;
    const initialRuntime = createRuntime(unreadable(1, "ready"));
    const accepted = { id: "accepted", name: "Ada" } satisfies Row;
    const updatedRuntime = createRuntime(source([accepted], "stale"));

    expect(() => updatedRuntime.publish(unreadable(2, "stale"))).not.toThrow();

    expect(initialRuntime.getChromeSnapshot()).toEqual({
      status: "error",
      hasCoherentRows: false,
      invalid: { kind: "invalid-rows", receivedRows: "unreadable" },
    });
    expect(initialRuntime.getBodySnapshot()).toEqual({ kind: "empty" });
    expect(updatedRuntime.getChromeSnapshot()).toEqual({
      status: "error",
      hasCoherentRows: true,
      invalid: { kind: "invalid-rows", receivedRows: "unreadable" },
    });
    expect(updatedRuntime.getBodySnapshot()).toEqual({ kind: "rows" });
    expect(updatedRuntime.getRowSnapshot("accepted")).toBe(accepted);
    expect(rowsRead).toHaveBeenCalledTimes(2);
  });

  it("keeps the last coherent rows available after a rejected ready publication", () => {
    const row = { id: "first", name: "Ada" } satisfies Row;
    const runtime = createRuntime(source([row]));

    runtime.publish(source([], "ready", { totalRows: 1 }));
    expect(runtime.getBodySnapshot()).toEqual({ kind: "invalid" });

    runtime.publish(source([], "error", { totalRows: 0, message: "connection lost" }));
    expect(runtime.getChromeSnapshot()).toMatchObject({
      status: "error",
      hasCoherentRows: true,
    });
    expect(runtime.getBodySnapshot()).toEqual({ kind: "rows" });
    expect(runtime.getRowSnapshot("first")).toBe(row);
  });

  it("keeps complete loading rows behind skeletons and retains prior coherent evidence", () => {
    const row = { id: "first", name: "Ada" } satisfies Row;
    const runtime = createRuntime(source([row]));
    const zeroRowLoading = createRuntime(source([], "loading"));

    expect(zeroRowLoading.getBodySnapshot()).toMatchObject({ kind: "loading" });

    runtime.publish(source([{ ...row, name: "Loading candidate" }], "loading", { totalRows: 1 }));
    expect(runtime.getBodySnapshot()).toEqual({ kind: "loading", totalRows: 1 });

    runtime.publish(source([], "error", { totalRows: 0, message: "connection lost" }));
    expect(runtime.getBodySnapshot()).toEqual({ kind: "rows" });
    expect(runtime.getRowSnapshot("first")).toBe(row);
  });

  it("does not read candidate rows from loading publications", () => {
    const rowsRead = vi.fn();
    const loadingSource = (version: number) =>
      ({
        get rows(): readonly Row[] {
          rowsRead();
          throw new Error("Loading rows must stay unread.");
        },
        totalRows: 1_000_000,
        version,
        status: "loading",
      }) as ReturnType<typeof source>;
    const runtime = createRuntime(loadingSource(1));

    expect(runtime.getBodySnapshot()).toEqual({ kind: "loading", totalRows: 1_000_000 });
    runtime.publish(loadingSource(2));
    expect(runtime.getBodySnapshot()).toEqual({ kind: "loading", totalRows: 1_000_000 });
    expect(rowsRead).not.toHaveBeenCalled();
  });

  it("directly constructs the first valid row sequence after loading", () => {
    const first = { id: "first", name: "Ada" } satisfies Row;
    const second = { id: "second", name: "Grace" } satisfies Row;
    const replacement = { id: "second", name: "Grace Hopper" } satisfies Row;
    const reconciliationEvents: BrunoTableClientReconciliationEvent[] = [];
    const restoreInstrumentation = installBrunoTableClientReconciliationListener((event) => {
      reconciliationEvents.push(event);
    });

    try {
      const runtime = createRuntime(source([], "loading", { totalRows: 2 }));

      runtime.publish(source([first, second]));
      expect(reconciliationEvents.at(-1)).toMatchObject({
        residentRows: 2,
        rebuiltSourceSequence: true,
        rebuiltIdentityIndex: true,
      });

      runtime.publish(source([first, replacement]));
      expect(reconciliationEvents.at(-1)).toMatchObject({
        residentRows: 2,
        changedRows: 1,
        rebuiltSourceSequence: false,
        rebuiltIdentityIndex: false,
      });

      runtime.configure((row) => row.id, runtimeColumns);
      expect(reconciliationEvents.at(-1)).toMatchObject({
        residentRows: 2,
        rebuiltSourceSequence: false,
        rebuiltIdentityIndex: false,
      });
    } finally {
      restoreInstrumentation();
    }
  });

  it("delivers an initial reconciliation only to the listener captured at its start", () => {
    const first = { id: "first", name: "Ada" } satisfies Row;
    const startedEvents = vi.fn<(event: BrunoTableClientReconciliationEvent) => void>();
    const replacementEvents = vi.fn<(event: BrunoTableClientReconciliationEvent) => void>();
    const removeStartedListener = installBrunoTableClientReconciliationListener(startedEvents);
    let removeReplacementListener: () => void = () => undefined;
    let replaced = false;
    const getRowId = (row: Row): string => {
      if (!replaced) {
        replaced = true;
        removeReplacementListener =
          installBrunoTableClientReconciliationListener(replacementEvents);
      }
      return row.id;
    };

    try {
      const runtime = createRuntime(source([], "loading", { totalRows: 1 }), getRowId);

      runtime.publish(source([first]));

      expect(startedEvents).toHaveBeenCalledOnce();
      expect(startedEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          residentRows: 1,
          durationMs: expect.any(Number),
          rebuiltIdentityIndex: true,
        }),
      );
      expect(replacementEvents).not.toHaveBeenCalled();
    } finally {
      removeReplacementListener();
      removeStartedListener();
    }
  });

  it("delivers an incremental reconciliation only to the listener captured at its start", () => {
    const first = { id: "first", name: "Ada" } satisfies Row;
    const replacement = { id: "first", name: "Ada Lovelace" } satisfies Row;
    const startedEvents = vi.fn<(event: BrunoTableClientReconciliationEvent) => void>();
    const replacementEvents = vi.fn<(event: BrunoTableClientReconciliationEvent) => void>();
    let removeReplacementListener: () => void = () => undefined;
    let replaceDuringReconciliation = false;
    let replaced = false;
    const getRowId = (row: Row): string => {
      if (replaceDuringReconciliation && !replaced) {
        replaced = true;
        removeReplacementListener =
          installBrunoTableClientReconciliationListener(replacementEvents);
      }
      return row.id;
    };
    const runtime = createRuntime(source([first]), getRowId);
    const removeStartedListener = installBrunoTableClientReconciliationListener(startedEvents);

    try {
      replaceDuringReconciliation = true;
      runtime.publish(source([replacement]));

      expect(startedEvents).toHaveBeenCalledOnce();
      expect(startedEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          residentRows: 1,
          changedRows: 1,
          durationMs: expect.any(Number),
          rebuiltIdentityIndex: false,
        }),
      );
      expect(replacementEvents).not.toHaveBeenCalled();
    } finally {
      removeReplacementListener();
      removeStartedListener();
    }
  });

  it("routes filter commands only through sanitized structural ownership", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
      {
        columnId: "COL_ID_ALIAS",
        field: "name",
        headerName: "Alias",
        valueType: "text",
      },
    ]);
    const runtime = createClientRuntime(
      source([{ id: "first", name: "Ada" }]),
      (row) => row.id,
      columns,
      [
        {
          columnId: "COL_ID_NAME",
          type: "blank",
          condition: { columnId: "COL_ID_ALIAS", type: "blank" },
        },
      ],
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const query = runtime.getQuerySnapshot();
    const queryListener = vi.fn();
    runtime.subscribeQuery(queryListener);

    expect(runtime.getColumnCommandSnapshot("COL_ID_NAME").filterBaselineAvailable).toBe(true);
    expect(runtime.getColumnCommandSnapshot("COL_ID_ALIAS").filterBaselineAvailable).toBe(false);
    runtime.resetColumnFilters("COL_ID_ALIAS");

    expect(runtime.getQuerySnapshot()).toBe(query);
    expect(queryListener).not.toHaveBeenCalled();
  });

  it("owns live non-empty sorting and reversible initial filter commands", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
      {
        columnId: "COL_ID_ALIAS",
        field: "name",
        headerName: "Alias",
        valueType: "text",
      },
    ]);
    const runtime = createClientRuntime(
      source([{ id: "first", name: "Ada" }]),
      (row) => row.id,
      columns,
      [{ columnId: "COL_ID_NAME", type: "equals", filter: "Ada" }],
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const queryListener = vi.fn();
    const sortingListener = vi.fn();
    const nameListener = vi.fn();
    const aliasListener = vi.fn();
    runtime.subscribeQuery(queryListener);
    runtime.subscribeSorting(sortingListener);
    runtime.subscribeColumnCommands("COL_ID_NAME", nameListener);
    runtime.subscribeColumnCommands("COL_ID_ALIAS", aliasListener);

    runtime.toggleColumnSort("COL_ID_NAME", false);
    expect(runtime.getQuerySnapshot().orderBy).toEqual([
      { columnId: "COL_ID_NAME", direction: "desc" },
    ]);
    expect(runtime.getQuerySnapshot().navigationMode).toBe("clear");
    runtime.reconcile(source([{ id: "first", name: "Ada" }]), (row) => row.id, columns);
    expect(runtime.getQuerySnapshot().navigationMode).toBe("clear");
    expect(nameListener).toHaveBeenCalledOnce();
    expect(aliasListener).not.toHaveBeenCalled();
    expect(sortingListener).toHaveBeenCalledOnce();
    expect(runtime.getSortingSnapshot()).toEqual([{ columnId: "COL_ID_NAME", direction: "desc" }]);

    runtime.clearColumnFilters("COL_ID_NAME");
    expect(runtime.getQuerySnapshot().filters).toEqual([]);
    expect(runtime.getQuerySnapshot().navigationMode).toBe("reset");
    runtime.reconcile(source([{ id: "first", name: "Ada" }]), (row) => row.id, columns);
    expect(runtime.getQuerySnapshot().navigationMode).toBe("reset");
    expect(runtime.getColumnCommandSnapshot("COL_ID_NAME")).toMatchObject({
      filterActive: false,
      filterBaselineAvailable: true,
    });
    expect(sortingListener).toHaveBeenCalledOnce();

    runtime.resetColumnFilters("COL_ID_NAME");
    expect(runtime.getQuerySnapshot().filters).toHaveLength(1);
    expect(runtime.getQuerySnapshot().navigationMode).toBe("reset");
    expect(runtime.getColumnCommandSnapshot("COL_ID_NAME").filterActive).toBe(true);
    expect(runtime.getQuerySnapshot().generation).toBe(3);
    expect(queryListener).toHaveBeenCalledTimes(3);
    expect(sortingListener).toHaveBeenCalledOnce();
  });

  it("publishes named toolbar counts only when their semantic number changes", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
      {
        columnId: "COL_ID_ALIAS",
        field: "name",
        headerName: "Alias",
        valueType: "text",
      },
    ]);
    const runtime = createClientRuntime(
      source([{ id: "first", name: "Ada" }]),
      (row) => row.id,
      columns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const loaded = vi.fn();
    const filters = vi.fn();
    const sorts = vi.fn();
    runtime.subscribeLoadedRowCount(loaded);
    runtime.subscribeActiveFilterCount(filters);
    runtime.subscribeActiveSortCount(sorts);

    runtime.publish(source([{ id: "first", name: "Grace" }]));
    runtime.dispatchGridCommand({
      type: "column.sort.toggle",
      columnId: "COL_ID_NAME",
      multi: false,
    });
    runtime.dispatchGridCommand({
      type: "column.filter.replace",
      columnId: "COL_ID_NAME",
      filter: { columnId: "COL_ID_NAME", type: "contains", filter: "a" },
    });
    runtime.dispatchGridCommand({
      type: "column.filter.replace",
      columnId: "COL_ID_NAME",
      filter: { columnId: "COL_ID_NAME", type: "equals", filter: "Ada" },
    });
    expect(loaded).not.toHaveBeenCalled();
    expect(filters).toHaveBeenCalledOnce();
    expect(sorts).not.toHaveBeenCalled();

    runtime.dispatchGridCommand({ type: "sorting.add", columnId: "COL_ID_ALIAS" });
    runtime.publish(
      source([
        { id: "first", name: "Grace" },
        { id: "second", name: "Ada" },
      ]),
    );
    expect(loaded).toHaveBeenCalledOnce();
    expect(sorts).toHaveBeenCalledOnce();
    expect(runtime.getLoadedRowCountSnapshot()).toBe(2);
    expect(runtime.getActiveFilterCountSnapshot()).toBe(1);
    expect(runtime.getActiveSortCountSnapshot()).toBe(2);
  });

  it("routes panel sorting commands through one non-empty runtime projection", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
      {
        columnId: "COL_ID_ALIAS",
        field: "name",
        headerName: "Alias",
        valueType: "text",
      },
      {
        columnId: "COL_ID_NOTE",
        field: "note",
        headerName: "Note",
        valueType: "text",
      },
    ]);
    const runtime = createClientRuntime(
      source([{ id: "first", name: "Ada" }]),
      (row) => row.id,
      columns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const listener = vi.fn();
    runtime.subscribeSorting(listener);

    runtime.dispatchGridCommand({ type: "sorting.add", columnId: "COL_ID_ALIAS" });
    runtime.dispatchGridCommand({ type: "sorting.add", columnId: "COL_ID_NOTE" });
    runtime.dispatchGridCommand({
      type: "sorting.move",
      columnId: "COL_ID_NOTE",
      targetIndex: 0,
    });
    runtime.dispatchGridCommand({ type: "sorting.remove", columnId: "COL_ID_ALIAS" });
    runtime.dispatchGridCommand({ type: "sorting.remove", columnId: "COL_ID_NAME" });
    runtime.dispatchGridCommand({ type: "sorting.remove", columnId: "COL_ID_NOTE" });

    expect(runtime.getSortingSnapshot()).toEqual([{ columnId: "COL_ID_NOTE", direction: "asc" }]);
    expect(listener).toHaveBeenCalledTimes(5);

    runtime.dispatchGridCommand({ type: "sorting.reset" });
    expect(runtime.getSortingSnapshot()).toEqual([{ columnId: "COL_ID_NAME", direction: "asc" }]);
    expect(listener).toHaveBeenCalledTimes(6);
  });

  it("does not retain mutable caller-owned order entries in query snapshots", () => {
    const mutableOrderBy = [{ columnId: "COL_ID_NAME", direction: "asc" as "asc" | "desc" }];
    const runtime = createClientRuntime(
      source([{ id: "first", name: "Ada" }]),
      (row) => row.id,
      runtimeColumns,
      undefined,
      mutableOrderBy,
    );

    mutableOrderBy[0]!.direction = "desc";

    expect(runtime.getQuerySnapshot().orderBy).toEqual([
      { columnId: "COL_ID_NAME", direction: "asc" },
    ]);
    expect(Object.isFrozen(runtime.getQuerySnapshot().orderBy[0])).toBe(true);

    runtime.toggleColumnSort("COL_ID_NAME", false);
    expect(Object.isFrozen(runtime.getQuerySnapshot().orderBy[0])).toBe(true);
  });

  it("re-sanitizes owned query state when column definitions are replaced", () => {
    const row = { id: "first", name: "Ada" } satisfies Row;
    const runtime = createClientRuntime(
      source([row]),
      (value) => value.id,
      runtimeColumns,
      [{ columnId: "COL_ID_NAME", type: "equals", filter: "Ada" }],
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const replacementColumns = compileColumns([
      {
        columnId: "COL_ID_ALIAS",
        field: "name",
        headerName: "Alias",
        valueType: "text",
      },
    ]);

    runtime.configure((value) => value.id, replacementColumns);

    expect(runtime.getQuerySnapshot()).toEqual({
      columns: replacementColumns,
      filters: [],
      quickFilter: "",
      orderBy: [{ columnId: "COL_ID_ALIAS", direction: "asc" }],
      generation: 1,
    });
  });

  it("rejects a sort-free replacement before changing observable state", () => {
    const runtime = createRuntime(source([{ id: "first", name: "Ada" }]));
    const previousQuery = runtime.getQuerySnapshot();
    const previousBody = runtime.getBodySnapshot();
    const sortFreeColumns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
        enableSorting: false,
      },
    ]);
    const queryListener = vi.fn();
    runtime.subscribeQuery(queryListener);

    expect(() => runtime.configure((row) => row.id, sortFreeColumns)).toThrow(
      /requires at least one sortable column/u,
    );

    expect(runtime.getQuerySnapshot()).toBe(previousQuery);
    expect(runtime.getBodySnapshot()).toBe(previousBody);
    expect(queryListener).not.toHaveBeenCalled();
  });

  it("preserves query state across layout-only column replacement", () => {
    const runtime = createClientRuntime(
      source([{ id: "first", name: "Ada" }]),
      (row) => row.id,
      runtimeColumns,
      [{ columnId: "COL_ID_NAME", type: "equals", filter: "Ada" }],
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const previousQuery = runtime.getQuerySnapshot();
    const previousCommandEpoch = runtime.getColumnFilterCommandEpochSnapshot("COL_ID_NAME");
    const queryListener = vi.fn();
    runtime.subscribeQuery(queryListener);
    const replacementColumns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Display name",
        valueType: "text",
        width: 240,
      },
    ]);

    runtime.configure((row) => row.id, replacementColumns);

    expect(runtime.getQuerySnapshot()).toEqual({
      columns: replacementColumns,
      filters: previousQuery.filters,
      quickFilter: previousQuery.quickFilter,
      orderBy: previousQuery.orderBy,
      generation: previousQuery.generation,
    });
    expect(runtime.getColumnFilterCommandEpochSnapshot("COL_ID_NAME")).toBe(previousCommandEpoch);
    expect(queryListener).toHaveBeenCalledOnce();
  });

  it("invalidates filter editor epochs when a custom parser changes", () => {
    const initialColumns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: parserValueType(false),
      },
    ]);
    const replacementColumns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: parserValueType(true),
      },
    ]);
    const runtime = createClientRuntime(
      source([{ id: "first", name: "new" }]),
      (row) => row.id,
      initialColumns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const previousEpoch = runtime.getColumnFilterCommandEpochSnapshot("COL_ID_NAME");

    runtime.configure((row) => row.id, replacementColumns);

    expect(runtime.getColumnFilterCommandEpochSnapshot("COL_ID_NAME")).toBe(previousEpoch + 1);
  });

  it("advances query generation when an active column changes query semantics", () => {
    const runtime = createClientRuntime(
      source([{ id: "first", name: "Ada", note: "Countess" }]),
      (row) => row.id,
      runtimeColumns,
      [{ columnId: "COL_ID_NAME", type: "equals", filter: "Ada" }],
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const previousQuery = runtime.getQuerySnapshot();
    const queryListener = vi.fn();
    runtime.subscribeQuery(queryListener);
    const replacementColumns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "note",
        headerName: "Note",
        valueType: "text",
      },
    ]);

    runtime.configure((row) => row.id, replacementColumns);

    expect(runtime.getQuerySnapshot()).toEqual({
      columns: replacementColumns,
      filters: previousQuery.filters,
      quickFilter: previousQuery.quickFilter,
      orderBy: previousQuery.orderBy,
      generation: 1,
    });
    expect(queryListener).toHaveBeenCalledOnce();
  });

  it("retains coherent rows for terminal lifecycle states and delegates only explicit retry", () => {
    const row = { id: "first", name: "Ada" } satisfies Row;
    const run = vi.fn();
    const retry = { run, pending: false };
    const runtime = createRuntime(source([row]));

    runtime.publish(source([row], "closed", { message: "socket ended", retry }));
    expect(runtime.getBodySnapshot().kind).toBe("rows");
    expect(runtime.getChromeSnapshot()).toMatchObject({
      status: "closed",
      hasCoherentRows: true,
    });
    runtime.retry();
    expect(run).toHaveBeenCalledOnce();

    // The runtime snapshots source-owned pending state; later caller mutation cannot rewrite it.
    retry.pending = true;
    runtime.retry();
    expect(run).toHaveBeenCalledTimes(2);

    runtime.publish(source([], "error", { totalRows: 1, retry: { run, pending: true } }));
    expect(runtime.getBodySnapshot().kind).toBe("rows");
    runtime.retry();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("admits only bounded string lifecycle metadata", () => {
    const row = { id: "first", name: "Ada" } satisfies Row;
    const runtime = createRuntime(source([row]));
    const malformed = {
      ...source([row], "stale"),
      statusCode: 503,
      message: null,
    } as unknown as ReturnType<typeof source>;

    expect(() => runtime.publish(malformed)).not.toThrow();
    expect(runtime.getChromeSnapshot()).toMatchObject({ status: "stale" });
    expect(runtime.getChromeSnapshot()).not.toHaveProperty("statusCode");
    expect(runtime.getChromeSnapshot()).not.toHaveProperty("message");

    runtime.publish(
      source([row], "stale", {
        statusCode: "s".repeat(256),
        message: "m".repeat(1_024),
      }),
    );
    expect(runtime.getChromeSnapshot().statusCode).toHaveLength(128);
    expect(runtime.getChromeSnapshot().message).toHaveLength(512);
  });

  it("omits malformed source Retry capabilities", () => {
    const row = { id: "first", name: "Ada" } satisfies Row;
    const runtime = createRuntime(source([row]));
    const malformedRetries = [null, { run: null, pending: false }, { run: vi.fn(), pending: 1 }];

    for (const retry of malformedRetries) {
      const malformed = { ...source([row], "error"), retry } as unknown as ReturnType<
        typeof source
      >;
      expect(() => runtime.publish(malformed)).not.toThrow();
      expect(runtime.getChromeSnapshot()).not.toHaveProperty("retry");
      expect(() => runtime.retry()).not.toThrow();
    }

    const run = vi.fn();
    let runReads = 0;
    let pendingReads = 0;
    const changingRetry = {
      get run() {
        runReads += 1;
        return runReads === 1 ? run : null;
      },
      get pending() {
        pendingReads += 1;
        return pendingReads === 1 ? false : "invalid";
      },
    };
    runtime.publish({
      ...source([row], "error"),
      retry: changingRetry,
    } as unknown as ReturnType<typeof source>);
    runtime.retry();
    expect(runReads).toBe(1);
    expect(pendingReads).toBe(1);
    expect(runtime.getChromeSnapshot().retry?.pending).toBe(false);
    expect(run).toHaveBeenCalledOnce();

    const throwingRetries = [
      {
        get run(): never {
          throw new Error("run getter failed");
        },
        pending: false,
      },
      {
        run,
        get pending(): never {
          throw new Error("pending getter failed");
        },
      },
    ];
    for (const retry of throwingRetries) {
      const malformed = { ...source([row], "error"), retry } as unknown as ReturnType<
        typeof source
      >;
      expect(() => runtime.publish(malformed)).not.toThrow();
      expect(runtime.getChromeSnapshot()).not.toHaveProperty("retry");
    }
  });

  it("partitions source counts, source version, and chrome without waking rows or body", () => {
    const rows = [{ id: "first", name: "Ada" }] as const;
    const iterateRows = vi.spyOn(rows, Symbol.iterator);
    const getRowId = vi.fn((row: Row) => row.id);
    const runtime = createClientRuntime(source(rows), getRowId, runtimeColumns, undefined, [
      { columnId: "COL_ID_NAME", direction: "asc" },
    ]);
    const detector = vi.fn(() => true);
    const rowsStore = runtime.createRowsStore(detector);
    const rowsListener = vi.fn();
    const bodyListener = vi.fn();
    const chromeListener = vi.fn();
    const sourceListener = vi.fn();
    const sourceVersionListener = vi.fn();
    rowsStore.subscribe(rowsListener);
    runtime.subscribeBody(bodyListener);
    runtime.subscribeChrome(chromeListener);
    runtime.subscribeSource(sourceListener);
    runtime.subscribeSourceVersion(sourceVersionListener);
    iterateRows.mockClear();
    getRowId.mockClear();

    runtime.publish({ ...source(rows), version: 2 });

    expect(iterateRows).not.toHaveBeenCalled();
    expect(getRowId).not.toHaveBeenCalled();
    expect(detector).not.toHaveBeenCalled();
    expect(rowsListener).not.toHaveBeenCalled();
    expect(bodyListener).not.toHaveBeenCalled();
    expect(chromeListener).not.toHaveBeenCalled();
    expect(sourceListener).not.toHaveBeenCalled();
    expect(sourceVersionListener).toHaveBeenCalledOnce();
    expect(runtime.getSourceSnapshot()).toEqual({ totalRows: 1, loadedRows: 1 });
    expect(runtime.getSourceVersionSnapshot().version).toBe(2);

    runtime.publish({ ...source(rows), version: 3, status: "stale", message: "Delayed" });

    expect(chromeListener).toHaveBeenCalledOnce();
    expect(sourceListener).not.toHaveBeenCalled();
    expect(sourceVersionListener).toHaveBeenCalledTimes(2);
    expect(runtime.getSourceVersionSnapshot().version).toBe(3);

    runtime.publish({ ...source([], "loading", { totalRows: 2 }), version: 3 });

    expect(sourceListener).toHaveBeenCalledOnce();
    expect(sourceVersionListener).toHaveBeenCalledTimes(2);
    expect(runtime.getSourceSnapshot()).toEqual({ totalRows: 2, loadedRows: 0 });
  });

  it("invokes source retry with an undefined receiver", () => {
    const receivers: unknown[] = [];
    const run = function (this: void): void {
      receivers.push(this);
    };
    const runtime = createRuntime(source([], "error", { retry: { run, pending: false } }));

    runtime.retry();

    expect(receivers).toEqual([undefined]);
  });

  it("retains prior coherent rows when a complete terminal publication is empty", () => {
    const row = { id: "first", name: "Ada" } satisfies Row;
    const runtime = createRuntime(source([row]));

    runtime.publish(source([], "error", { totalRows: 0, message: "connection lost" }));

    expect(runtime.getChromeSnapshot()).toMatchObject({
      status: "error",
      hasCoherentRows: true,
    });
    expect(runtime.getBodySnapshot()).toEqual({ kind: "rows" });
    expect(runtime.getRowSnapshot("first")).toBe(row);
  });

  it("uses a terminal Empty projection when no coherent rows exist", () => {
    const run = vi.fn();
    const runtime = createRuntime(source([], "error", { retry: { run, pending: false } }));

    expect(runtime.getBodySnapshot()).toEqual({ kind: "empty" });
  });
});

describe("BrunoTable installed grouping structure", () => {
  it("publishes grouped presentation columns once and stays silent for value-only updates", () => {
    type GroupedRow = Readonly<{ id: string; group: string; value: bigint }>;
    const columns = compileColumns([
      {
        columnId: "COL_ID_GROUP",
        field: "group",
        headerName: "Group",
        valueType: "text",
        groupBy: true,
      },
      {
        columnId: "COL_ID_VALUE",
        field: "value",
        headerName: "Value",
        valueType: "bigint",
        aggFunc: "sum",
      },
    ]);
    const source = (value: bigint, version: number, status: "ready" | "loading" = "ready") => ({
      rows: status === "ready" ? [{ id: "one", group: "A", value }] : [],
      totalRows: 1,
      version,
      status,
    });
    const adapter = new BrunoTableClientRowPipelineAdapter(
      source(1n, 1),
      (row: GroupedRow) => row.id,
      columns,
      undefined,
      [{ columnId: "COL_ID_VALUE", direction: "asc" }],
    );
    const runtime = new BrunoTableGridRuntime(
      adapter.getPublication(),
      columns,
      adapter.getQueryConfiguration(columns),
      "TABLE_ID_GROUPED_LOADING_STRUCTURE",
      { grouping: true },
    );
    const view = runtime.getView();
    const store = new BrunoTableClientProjectionStore(view, adapter, undefined);
    const deactivate = store.activate();
    view.dispatchGridCommand({
      type: "column.pin.commit",
      columnId: "COL_ID_VALUE",
      pinned: "start",
    });
    view.dispatchGridCommand({ type: "grouping.add", columnId: "COL_ID_GROUP" });
    const installed = view.getInstalledGroupingStructureSnapshot();

    expect(installed.columns?.map((column) => column.columnId)).toEqual([
      "COL_ID_GROUP",
      "COL_ID_BRUNO_TABLE_ROWS",
      "COL_ID_VALUE",
    ]);
    expect(installed.columns?.every((column) => column.pinned === undefined)).toBe(true);
    const listener = vi.fn();
    view.subscribeInstalledGroupingStructure(listener);

    adapter.publish(source(2n, 2));
    adapter.publishProjectionInput(columns, adapter.getQueryConfiguration(columns));

    expect(view.getInstalledGroupingStructureSnapshot()).toBe(installed);
    expect(listener).not.toHaveBeenCalled();

    runtime.publish(adapter.publish(source(2n, 3, "loading")));
    adapter.publishProjectionInput(columns, adapter.getQueryConfiguration(columns));

    expect(view.getInstalledClientProjectionSnapshot()?.kind).toBe("grouped");
    expect(view.getInstalledGroupingStructureSnapshot().columns).toBe(installed.columns);
    deactivate();
  });
});

describe("BrunoTable Grid Runtime re-entrant publication", () => {
  const createSubject = (
    rows: readonly Row[] = [{ id: "first", name: "Ada", note: "math" }],
    columns: readonly CompiledColumn[] = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
      {
        columnId: "COL_ID_NOTE",
        field: "note",
        headerName: "Note",
        valueType: "text",
      },
    ]),
  ) => {
    const initial = source(rows);
    const adapter = new BrunoTableClientRowPipelineAdapter(
      initial,
      (row: Row) => row.id,
      columns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const runtime = new BrunoTableGridRuntime(
      adapter.getPublication(),
      columns,
      adapter.getQueryConfiguration(columns),
      "TABLE_ID_REENTRANT_PUBLICATION",
    );
    return { adapter, columns, runtime, view: runtime.getView() };
  };

  it("drains a publication queued by a query listener after the configuration pass", () => {
    const { adapter, runtime, view } = createSubject();
    const replacementColumns = compileColumns([
      {
        columnId: "COL_ID_ALIAS",
        field: "name",
        headerName: "Alias",
        valueType: "text",
      },
    ]);
    const newest = { id: "first", name: "Countess Lovelace", note: "newest" } satisfies Row;
    const events: string[] = [];
    view.subscribeQuery(() => {
      events.push("query");
      view.publishRowPipeline(adapter.publish(source([newest])));
    });
    view.subscribeRow("first", () =>
      events.push(`row:${String(view.getCellValueSnapshot("first", "COL_ID_ALIAS"))}`),
    );

    runtime.reconcile(
      adapter.reconcile(
        source([{ id: "first", name: "Augusta", note: "outer" }]),
        (row) => row.id,
        replacementColumns,
      ),
      replacementColumns,
      adapter.getQueryConfiguration(replacementColumns),
    );

    expect(events).toEqual(["query", "row:Augusta", "row:Countess Lovelace"]);
    expect(view.getRowSnapshot("first")).toBe(newest);
    expect(view.getCellValueSnapshot("first", "COL_ID_ALIAS")).toBe("Countess Lovelace");
  });

  it.each(["chrome", "source"] as const)(
    "drains a publication queued by a %s listener",
    (channel) => {
      const { adapter, runtime, view } = createSubject();
      const events: string[] = [];
      const newest = { id: "latest", name: "Grace", note: "ready" } satisfies Row;
      const listener = () => {
        events.push(`${channel}:${view.getChromeSnapshot().status}`);
        if (view.getChromeSnapshot().status === "loading") {
          runtime.publish(adapter.publish(source([newest])));
        }
      };
      if (channel === "chrome") view.subscribeChrome(listener);
      else view.subscribeSource(listener);

      runtime.publish(adapter.publish(source([], "loading", { totalRows: 1 })));

      expect(events).toEqual([`${channel}:loading`, `${channel}:ready`]);
      expect(view.getRowSnapshot("latest")).toBe(newest);
      expect(view.getChromeSnapshot().status).toBe("ready");
    },
  );

  it("drains a publication queued by a row listener and adopts its row order and cells", () => {
    const first = { id: "first", name: "Ada", note: "outer" } satisfies Row;
    const second = { id: "second", name: "Grace", note: "outer" } satisfies Row;
    const newestSecond = {
      id: "second",
      name: "Rear Admiral Hopper",
      note: "newest",
    } satisfies Row;
    const newestThird = { id: "third", name: "Katherine", note: "newest" } satisfies Row;
    const { adapter, runtime, view } = createSubject([first, second]);
    view.subscribeRow("first", () => {
      if (view.getRowSnapshot("first") !== undefined) {
        runtime.publish(adapter.publish(source([newestThird, newestSecond])));
      }
    });

    runtime.publish(adapter.publish(source([{ ...first, name: "Augusta" }, second])));

    expect(view.getRowSpaceSnapshot()?.getRowId(0)).toBe("third");
    expect(view.getRowSpaceSnapshot()?.getRowId(1)).toBe("second");
    expect(view.getRowSnapshot("first")).toBeUndefined();
    expect(view.getCellValueSnapshot("second", "COL_ID_NAME")).toBe("Rear Admiral Hopper");
  });

  it("keeps Client rows-store snapshots aligned with each installed publication", () => {
    const initial = { id: "first", name: "Initial" } satisfies Row;
    const outer = { id: "first", name: "Outer" } satisfies Row;
    const newest = { id: "first", name: "Newest" } satisfies Row;
    const { adapter, runtime, view } = createSubject([initial]);
    view.subscribeRowSpace(() => {
      if (view.getCellValueSnapshot("first", "COL_ID_NAME") === "Outer") {
        runtime.publish(adapter.publish(source([newest])));
      }
    });
    const rowsStore = adapter.createRowsStore(view, () => () => true);
    const events: string[] = [];
    rowsStore.subscribe(() => {
      const storeRow = rowsStore.getSnapshot()[0]?.raw as Row | undefined;
      events.push(`${storeRow?.name}:${String(view.getCellValueSnapshot("first", "COL_ID_NAME"))}`);
    });

    runtime.publish(adapter.publish(source([outer])));

    expect(events).toEqual(["Outer:Outer", "Newest:Newest"]);
    expect(rowsStore.getSnapshot()[0]?.raw).toBe(newest);
    expect(view.getRowSnapshot("first")).toBe(newest);
  });

  it("keeps the raw Client rows store warm while a grouped projection is installed", () => {
    const initial = { id: "first", name: "Initial" } satisfies Row;
    const { adapter, runtime, view } = createSubject([initial]);
    const rowsStore = adapter.createRowsStore(view, () => () => true);
    const listener = vi.fn();
    rowsStore.subscribe(listener);
    const rawSnapshot = rowsStore.getSnapshot();

    runtime.publish({
      ...adapter.getPublication(),
      rowSpace: Object.freeze({
        brunoTableClientGrouped: true as const,
        totalRows: 1,
        loadedRows: 1,
        getRowId: (_index: number) => "private-group",
        getRow: (_rowId: string) => undefined,
        getCellValue: (_rowId: string, _columnId: string) => undefined,
      }),
    });

    expect(listener).not.toHaveBeenCalled();
    expect(rowsStore.getSnapshot()).toBe(rawSnapshot);
    expect((rowsStore.getSnapshot()[0]?.raw as Row | undefined)?.name).toBe("Initial");
  });

  it("constructs a Client rows store from the installed publication", () => {
    const initial = { id: "first", name: "Initial" } satisfies Row;
    const outer = { id: "first", name: "Outer" } satisfies Row;
    const newest = { id: "first", name: "Newest" } satisfies Row;
    const { adapter, runtime, view } = createSubject([initial]);
    let constructedName: string | undefined;
    view.subscribeRowSpace(() => {
      if (view.getCellValueSnapshot("first", "COL_ID_NAME") === "Outer") {
        runtime.publish(adapter.publish(source([newest])));
      }
    });
    view.subscribeRowSpace(() => {
      if (constructedName !== undefined) return;
      const rowsStore = adapter.createRowsStore(view, () => () => true);
      constructedName = (rowsStore.getSnapshot()[0]?.raw as Row | undefined)?.name;
    });

    runtime.publish(adapter.publish(source([outer])));

    expect(constructedName).toBe("Outer");
    expect(view.getCellValueSnapshot("first", "COL_ID_NAME")).toBe("Newest");
  });

  it("re-subscribes a Client rows store to the installed publication", () => {
    const initial = { id: "first", name: "Initial" } satisfies Row;
    const outer = { id: "first", name: "Outer" } satisfies Row;
    const newest = { id: "first", name: "Newest" } satisfies Row;
    const { adapter, runtime, view } = createSubject([initial]);
    const rowsStore = adapter.createRowsStore(
      view,
      () => (previousRows, nextRows) => previousRows !== nextRows,
    );
    rowsStore.subscribe(() => undefined)();
    const events: string[] = [];
    let disposeRowsStore: (() => void) | undefined;
    view.subscribeRowSpace(() => {
      if (view.getCellValueSnapshot("first", "COL_ID_NAME") !== "Outer") return;
      const newestPublication = adapter.publish(source([newest]));
      disposeRowsStore = rowsStore.subscribe(() => {
        const storeRow = rowsStore.getSnapshot()[0]?.raw as Row | undefined;
        events.push(
          `notify:${storeRow?.name}:${String(view.getCellValueSnapshot("first", "COL_ID_NAME"))}`,
        );
      });
      const installedRow = rowsStore.getSnapshot()[0]?.raw as Row | undefined;
      events.push(
        `subscribe:${installedRow?.name}:${String(view.getCellValueSnapshot("first", "COL_ID_NAME"))}`,
      );
      runtime.publish(newestPublication);
    });

    runtime.publish(adapter.publish(source([outer])));

    expect(events).toEqual(["subscribe:Outer:Outer", "notify:Newest:Newest"]);
    disposeRowsStore?.();
  });

  it("initializes lazy Result count from the installed publication", () => {
    const initial = { id: "initial", name: "Initial" } satisfies Row;
    const outer = { id: "outer", name: "Outer" } satisfies Row;
    const newest = { id: "newest", name: "Newest" } satisfies Row;
    const second = { id: "second", name: "Second" } satisfies Row;
    const { adapter, runtime, view } = createSubject([initial]);
    const events: string[] = [];
    const initializedResults: boolean[] = [];
    view.subscribeRowSpace(() => {
      const installedName = String(
        view.getCellValueSnapshot(view.getRowSpaceSnapshot()?.getRowId(0) ?? "", "COL_ID_NAME"),
      );
      if (installedName === "Outer") {
        runtime.publish(adapter.publish(source([newest, second])));
        initializedResults.push(
          adapter.initializeResultRowCount(view.getQuerySnapshot(), view.getRowSpaceSnapshot()),
        );
      } else {
        adapter.publishResultRowCount(view.getLoadedRowCountSnapshot());
      }
      events.push(
        `${String(adapter.getResultRowCountSnapshot())}:${String(view.getLoadedRowCountSnapshot())}`,
      );
    });

    runtime.publish(adapter.publish(source([outer])));

    expect(initializedResults).toEqual([true]);
    expect(events).toEqual(["1:1", "2:2"]);
  });

  it("projects Client facets from each installed publication", () => {
    const facetColumns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        enableSetFilter: true,
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    const initial = { id: "first", name: "Initial" } satisfies Row;
    const outer = { id: "first", name: "Outer" } satisfies Row;
    const newest = { id: "first", name: "Newest" } satisfies Row;
    const { adapter, runtime, view } = createSubject([initial], facetColumns);
    view.subscribeRowSpace(() => {
      if (view.getCellValueSnapshot("first", "COL_ID_NAME") === "Outer") {
        runtime.publish(adapter.publish(source([newest])));
      }
    });
    const facetStore = createBrunoTableClientFacetStore({
      column: facetColumns[0]!,
      rows: adapter,
      runtime: view,
    });
    facetStore.getSnapshot();
    const events: string[] = [];
    facetStore.subscribe(() => {
      const values = facetStore
        .getSnapshot()
        .options.map((option) => String(option.value))
        .join(",");
      events.push(`${values}:${String(view.getCellValueSnapshot("first", "COL_ID_NAME"))}`);
    });

    runtime.publish(adapter.publish(source([outer])));

    expect(events).toEqual(["Outer:Outer", "Newest:Newest"]);
  });

  it("keeps grouped facets on the displayed raw source publication", () => {
    const facetColumns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        enableSetFilter: true,
        field: "name",
        headerName: "Name",
        valueType: "text",
        groupBy: true,
      },
    ]);
    const adapter = new BrunoTableClientRowPipelineAdapter(
      source([{ id: "first", name: "Raw facet" }]),
      (row: Row) => row.id,
      facetColumns,
      undefined,
      [{ columnId: "COL_ID_NAME", direction: "asc" }],
    );
    const groupedRowSpace = Object.freeze({
      brunoTableClientGrouped: true as const,
    }) as unknown as Parameters<typeof adapter.getFacetRowsSnapshot>[0];

    expect(
      adapter.getFacetRowsSnapshot(groupedRowSpace).rows.map((row) => (row.raw as Row).name),
    ).toEqual(["Raw facet"]);

    adapter.publish(source([], "loading", { totalRows: 1 }));
    expect(adapter.getFacetRowsSnapshot(groupedRowSpace).rows).toEqual([]);
  });

  it("inherits queued configuration for later ordinary publications", () => {
    const replacementColumns = compileColumns([
      {
        columnId: "COL_ID_ALIAS",
        field: "name",
        headerName: "Alias",
        valueType: "text",
      },
    ]);
    const { adapter, runtime, view } = createSubject();
    const middle = { id: "first", name: "Middle" } satisfies Row;
    const newest = { id: "first", name: "Newest" } satisfies Row;
    view.subscribeChrome(() => {
      if (view.getChromeSnapshot().status !== "loading") return;
      runtime.reconcile(
        adapter.reconcile(source([middle]), (row) => row.id, replacementColumns),
        replacementColumns,
        adapter.getQueryConfiguration(replacementColumns),
      );
      runtime.publish(adapter.publish(source([newest])));
    });

    runtime.publish(adapter.publish(source([], "loading", { totalRows: 1 })));

    expect(view.getQuerySnapshot().columns).toBe(replacementColumns);
    expect(view.getCellValueSnapshot("first", "COL_ID_ALIAS")).toBe("Newest");
    expect(view.getRowSnapshot("first")).toBe(newest);
  });

  it("configures the newest publication already accepted by the drain", () => {
    const replacementColumns = compileColumns([
      {
        columnId: "COL_ID_ALIAS",
        field: "name",
        headerName: "Alias",
        valueType: "text",
      },
    ]);
    const { adapter, runtime, view } = createSubject();
    const newest = { id: "first", name: "Newest" } satisfies Row;
    let queued = false;
    view.subscribeChrome(() => {
      if (queued || view.getChromeSnapshot().status !== "loading") return;
      queued = true;
      runtime.publish(adapter.reconcile(source([newest]), (row) => row.id, replacementColumns));
      runtime.configure(replacementColumns, adapter.getQueryConfiguration(replacementColumns));
    });

    runtime.publish(adapter.publish(source([], "loading", { totalRows: 1 })));

    expect(view.getQuerySnapshot().columns).toBe(replacementColumns);
    expect(view.getCellValueSnapshot("first", "COL_ID_ALIAS")).toBe("Newest");
    expect(view.getRowSnapshot("first")).toBe(newest);
  });

  it("restores installed configuration authority after an internal failure", () => {
    const replacementColumns = compileColumns([
      {
        columnId: "COL_ID_ALIAS",
        field: "name",
        headerName: "Alias",
        valueType: "text",
      },
    ]);
    const { adapter, columns, runtime, view } = createSubject();
    const internalFailure = new Error("queued configuration failed");
    const unreadable = {
      ...adapter.getPublication(),
      get status(): "ready" {
        throw internalFailure;
      },
    };
    view.subscribeChrome(() => {
      if (view.getChromeSnapshot().status === "loading") {
        runtime.reconcile(
          unreadable,
          replacementColumns,
          adapter.getQueryConfiguration(replacementColumns),
        );
      }
    });

    expect(() => runtime.publish(adapter.publish(source([], "loading")))).toThrow(internalFailure);

    const newest = { id: "first", name: "Newest" } satisfies Row;
    runtime.publish(adapter.publish(source([newest])));
    expect(view.getQuerySnapshot().columns).toBe(columns);
    expect(view.getCellValueSnapshot("first", "COL_ID_NAME")).toBe("Newest");
  });

  it("retains installed configuration after a contained row-read failure", () => {
    const replacementColumns = compileColumns([
      {
        columnId: "COL_ID_ALIAS",
        field: "name",
        headerName: "Alias",
        valueType: "text",
      },
    ]);
    const initial = { id: "first", name: "Initial" } satisfies Row;
    const failed = { id: "first", name: "Failed" } satisfies Row;
    const newest = { id: "first", name: "Newest" } satisfies Row;
    const { adapter, runtime, view } = createSubject([initial]);
    const sourceReadFailure = new Error("installed row space failed");
    view.subscribeRow("first", () => undefined);
    const rejected = adapter.reconcile(source([failed]), (row) => row.id, replacementColumns);
    const rejectedRowSpace = rejected.rowSpace;
    if (rejectedRowSpace === undefined) throw new Error("Expected a resident row space");
    let rowReadFailed = false;
    const unreadable = {
      ...rejected,
      rowSpace: {
        ...rejectedRowSpace,
        getRow(rowId: string): Row | undefined {
          if (!rowReadFailed) {
            rowReadFailed = true;
            throw sourceReadFailure;
          }
          return rejectedRowSpace.getRow(rowId);
        },
      },
    };

    expect(() =>
      runtime.reconcile(
        unreadable,
        replacementColumns,
        adapter.getQueryConfiguration(replacementColumns),
      ),
    ).toThrow(sourceReadFailure);

    runtime.publish(adapter.publish(source([newest])));
    expect(view.getQuerySnapshot().columns).toBe(replacementColumns);
    expect(view.getCellValueSnapshot("first", "COL_ID_ALIAS")).toBe("Newest");
  });

  it("drains accepted adapter configuration after a contained outer row-read failure", () => {
    const replacementColumns = compileColumns([
      {
        columnId: "COL_ID_ALIAS",
        field: "name",
        headerName: "Alias",
        valueType: "text",
      },
    ]);
    const initial = { id: "first", name: "Initial" } satisfies Row;
    const outer = { id: "first", name: "Outer" } satisfies Row;
    const queued = { id: "first", name: "Queued" } satisfies Row;
    const newest = { id: "first", name: "Newest" } satisfies Row;
    const { adapter, runtime, view } = createSubject([initial]);
    const sourceReadFailure = new Error("outer row space failed");
    let accepted = false;
    view.subscribeRowSpace(() => {
      if (accepted) return;
      accepted = true;
      runtime.reconcile(
        adapter.reconcile(source([queued]), (row) => row.id, replacementColumns),
        replacementColumns,
        adapter.getQueryConfiguration(replacementColumns),
      );
    });
    view.subscribeRow("first", () => undefined);
    const rejected = adapter.publish(source([outer]));
    const rejectedRowSpace = rejected.rowSpace;
    if (rejectedRowSpace === undefined) throw new Error("Expected a resident row space");
    let rowReadFailed = false;

    expect(() =>
      runtime.publish({
        ...rejected,
        rowSpace: {
          ...rejectedRowSpace,
          getRow(rowId: string): Row | undefined {
            if (!rowReadFailed) {
              rowReadFailed = true;
              throw sourceReadFailure;
            }
            return rejectedRowSpace.getRow(rowId);
          },
        },
      }),
    ).toThrow(sourceReadFailure);

    runtime.publish(adapter.publish(source([newest])));
    expect(view.getQuerySnapshot().columns).toBe(replacementColumns);
    expect(view.getCellValueSnapshot("first", "COL_ID_ALIAS")).toBe("Newest");
    expect(view.getRowSnapshot("first")).toBe(newest);
  });

  it("falls back to complete change evidence after discarded Client candidates", () => {
    const initialFirst = { id: "first", name: "Outer first", note: "initial" } satisfies Row;
    const initialSecond = { id: "second", name: "Outer second", note: "initial" } satisfies Row;
    const outerFirst = { ...initialFirst, note: "outer" } satisfies Row;
    const outerSecond = { ...initialSecond, note: "outer" } satisfies Row;
    const discardedFirst = { ...outerFirst, name: "Discarded first" } satisfies Row;
    const discardedSecond = { ...outerSecond, name: "Discarded second" } satisfies Row;
    const skippedFirst = { ...discardedFirst, name: "Installed first" } satisfies Row;
    const skippedSecond = { ...discardedSecond, name: "Installed second" } satisfies Row;
    const finalSecond = { ...skippedSecond, note: "final" } satisfies Row;
    const { adapter, runtime, view } = createSubject([initialFirst, initialSecond]);
    const internalFailure = new Error("discard queued Client candidates");
    let queued = false;
    view.subscribeRowSpace(() => {
      if (queued || view.getCellValueSnapshot("first", "COL_ID_NOTE") !== "outer") return;
      queued = true;
      const rejected = adapter.publish(source([discardedFirst, discardedSecond]));
      runtime.publish({
        ...rejected,
        get status(): "ready" {
          throw internalFailure;
        },
      });
      runtime.publish(adapter.publish(source([skippedFirst, skippedSecond])));
    });
    const rowsStore = adapter.createRowsStore(view, () => (previousRows, nextRows, change) => {
      if (change.rowIdsChanged) return true;
      return change.changedIndexes.some(
        (index) =>
          (previousRows[index]?.raw as Row | undefined)?.name !==
          (nextRows[index]?.raw as Row | undefined)?.name,
      );
    });
    const rowsListener = vi.fn();
    rowsStore.subscribe(rowsListener);

    expect(() => runtime.publish(adapter.publish(source([outerFirst, outerSecond])))).toThrow(
      internalFailure,
    );
    expect(rowsListener).not.toHaveBeenCalled();
    expect(rowsStore.getSnapshot()[0]?.raw).toBe(initialFirst);

    runtime.publish(adapter.publish(source([skippedFirst, finalSecond])));

    expect(rowsListener).toHaveBeenCalledOnce();
    expect(rowsStore.getSnapshot()[0]?.raw).toBe(skippedFirst);
    expect(rowsStore.getSnapshot()[1]?.raw).toBe(finalSecond);
    expect(view.getRowSnapshot("first")).toBe(skippedFirst);
    expect(view.getRowSnapshot("second")).toBe(finalSecond);
  });

  it("advances Client change lineage after detector-false installed updates", () => {
    const first = { id: "first", name: "First", note: "initial" } satisfies Row;
    const second = { id: "second", name: "Second", note: "initial" } satisfies Row;
    const nextFirst = { ...first, note: "first update" } satisfies Row;
    const nextSecond = { ...second, note: "second update" } satisfies Row;
    const { adapter, runtime, view } = createSubject([first, second]);
    const changes: number[][] = [];
    const rowsStore = adapter.createRowsStore(view, () => (_previous, _next, change) => {
      changes.push([...change.changedIndexes]);
      return false;
    });
    const rowsListener = vi.fn();
    rowsStore.subscribe(rowsListener);

    runtime.publish(adapter.publish(source([nextFirst, second])));
    runtime.publish(adapter.publish(source([nextFirst, nextSecond])));

    expect(changes).toEqual([[0], [1]]);
    expect(rowsListener).not.toHaveBeenCalled();
    expect(rowsStore.getSnapshot()[0]?.raw).toBe(first);
  });

  it("retains the source Row Identity snapshot across value-only publications", () => {
    const first = { id: "first", name: "First", note: "initial" } satisfies Row;
    const second = { id: "second", name: "Second", note: "initial" } satisfies Row;
    const { adapter, runtime, view } = createSubject([first, second]);
    const rowsStore = adapter.createRowsStore(view, () => () => true);
    rowsStore.subscribe(() => undefined);
    const initialSource = rowsStore.getSourceRowIdsSnapshot(rowsStore.getSnapshot());
    expect(initialSource.authoritative).toBe(true);

    runtime.publish(adapter.publish(source([{ ...first, note: "updated" }, second])));

    expect(rowsStore.getSourceRowIdsSnapshot(rowsStore.getSnapshot()).rowIds).toBe(
      initialSource.rowIds,
    );
    expect(rowsStore.getSourceRowIdsSnapshot(rowsStore.getSnapshot()).token).toBe(
      initialSource.token,
    );

    runtime.publish(
      adapter.publish(source([{ id: "replacement", name: "Replacement", note: "next" }, second])),
    );

    const revisedSource = rowsStore.getSourceRowIdsSnapshot(rowsStore.getSnapshot());
    expect(revisedSource.authoritative).toBe(true);
    expect(revisedSource.token).not.toBe(initialSource.token);
    expect(Array.from(revisedSource.rowIds)).toEqual(["replacement", "second"]);
  });

  it("preserves forced row-order evidence when a Client sequence is reused", () => {
    const resident = { id: "first", name: "Resident" } satisfies Row;
    const candidate = { id: "first", name: "Candidate" } satisfies Row;
    const { adapter, runtime, view } = createSubject([resident]);
    const changes: { readonly rowIdsChanged: boolean }[] = [];
    const rowsStore = adapter.createRowsStore(view, () => (_previous, _next, change) => {
      changes.push(change);
      return true;
    });
    rowsStore.subscribe(() => undefined);
    adapter.acceptRows(rowsStore.getSnapshot());
    runtime.publish(adapter.publish(source([candidate], "stale")));
    const fallback = adapter.rejectQueryRows(rowsStore.getSnapshot(), {
      kind: "invalid-value",
      rowIndex: 0,
      columnId: "COL_ID_NAME",
      message: "Rejected candidate.",
    });
    if (fallback === undefined) throw new Error("Expected a retained-row fallback.");
    expect(fallback.changedRowIds).toEqual(new Set(["first"]));
    runtime.publish(fallback);
    const retry = adapter.retryQueryRows();
    if (retry === undefined) throw new Error("Expected rejected rows to be retryable.");
    expect(retry.changedRowIds).toEqual(new Set(["first"]));

    runtime.publish(retry);

    expect(changes.at(-1)?.rowIdsChanged).toBe(true);
    expect(rowsStore.getSnapshot()[0]?.raw).toBe(candidate);
  });

  it("derives fallback and retry row deltas across every superseded provisional publication", () => {
    const first = { id: "first", name: "Resident first" } satisfies Row;
    const second = { id: "second", name: "Resident second" } satisfies Row;
    const provisionalFirst = { ...first, name: "Provisional first" } satisfies Row;
    const rejectedSecond = { ...second, name: "Rejected second" } satisfies Row;
    const { adapter, runtime, view } = createSubject([first, second]);
    const rowsStore = adapter.createRowsStore(view, () => () => true);
    rowsStore.subscribe(() => undefined);
    expect(adapter.acceptRows(rowsStore.getSnapshot())).toBe("accepted-changed");

    runtime.publish(adapter.publish(source([provisionalFirst, second], "stale")));
    runtime.publish(adapter.publish(source([provisionalFirst, rejectedSecond], "stale")));
    const fallback = adapter.rejectQueryRows(rowsStore.getSnapshot(), {
      kind: "invalid-value",
      rowIndex: 1,
      columnId: "COL_ID_NAME",
      message: "Rejected second candidate.",
    });
    if (fallback === undefined) throw new Error("Expected a retained-row fallback.");
    expect(fallback.changedRowIds).toEqual(new Set(["first", "second"]));
    runtime.publish(fallback);

    const retry = adapter.retryQueryRows();
    if (retry === undefined) throw new Error("Expected rejected rows to be retryable.");
    expect(retry.changedRowIds).toEqual(new Set(["first", "second"]));
  });

  it("withdraws edit authority while a retained query fallback is also invalid", () => {
    const resident = { id: "first", name: "Resident" } satisfies Row;
    const candidate = { id: "first", name: "Candidate" } satisfies Row;
    const { adapter, runtime, view } = createSubject([resident]);
    const rowsStore = adapter.createRowsStore(view, () => () => true);
    rowsStore.subscribe(() => undefined);
    adapter.acceptRows(rowsStore.getSnapshot());
    runtime.publish(adapter.publish(source([candidate], "stale")));
    const fallback = adapter.rejectQueryRows(rowsStore.getSnapshot(), {
      kind: "invalid-value",
      rowIndex: 0,
      columnId: "COL_ID_NAME",
      message: "Rejected candidate.",
    });
    if (fallback === undefined) throw new Error("Expected a retained-row fallback.");
    runtime.publish(fallback);
    expect(adapter.hasAuthoritativeEditSource()).toBe(true);

    const invalidGap = adapter.rejectQueryRows(rowsStore.getSnapshot(), {
      kind: "invalid-value",
      rowIndex: 0,
      columnId: "COL_ID_NAME",
      message: "Rejected retained fallback.",
    });
    if (invalidGap === undefined) throw new Error("Expected the fallback rejection to publish.");
    runtime.publish(invalidGap);
    expect(invalidGap.rowSpace).toBeUndefined();
    expect(adapter.hasAuthoritativeEditSource()).toBe(false);

    const retry = adapter.retryQueryRows();
    if (retry === undefined) throw new Error("Expected rejected rows to be retryable.");
    expect(adapter.hasAuthoritativeEditSource()).toBe(false);
    expect(retry.changedRowIds).toBeUndefined();
    runtime.publish(retry);
    adapter.acceptRows(rowsStore.getSnapshot());
    expect(adapter.hasAuthoritativeEditSource()).toBe(true);
    expect(rowsStore.getSnapshot()[0]?.raw).toBe(candidate);
  });

  it("derives accepted edit deltas across superseded provisional Client publications", () => {
    const resident = { id: "first", name: "Resident" } satisfies Row;
    const provisional = { id: "first", name: "Provisional" } satisfies Row;
    const { adapter, runtime, view } = createSubject([resident]);
    const rowsStore = adapter.createRowsStore(view, () => () => true);
    rowsStore.subscribe(() => undefined);
    expect(adapter.acceptRows(rowsStore.getSnapshot())).toBe("accepted-changed");

    runtime.publish(adapter.publish(source([provisional], "stale")));
    runtime.publish(adapter.publish(source([provisional], "stale")));
    expect(adapter.acceptRows(rowsStore.getSnapshot())).toBe("accepted-changed");

    expect(adapter.getEditSourceChangedRowIds()).toEqual(new Set(["first"]));
  });

  it("distinguishes a stale row snapshot from an unchanged accepted transition", () => {
    const resident = { id: "first", name: "Resident" } satisfies Row;
    const replacement = { id: "first", name: "Replacement" } satisfies Row;
    const { adapter, runtime, view } = createSubject([resident]);
    const rowsStore = adapter.createRowsStore(view, () => () => true);
    rowsStore.subscribe(() => undefined);
    const residentRows = rowsStore.getSnapshot();
    expect(adapter.acceptRows(residentRows)).toBe("accepted-changed");
    expect(adapter.acceptRows(residentRows)).toBe("accepted-unchanged");

    runtime.publish(adapter.publish(source([replacement])));

    expect(adapter.acceptRows(residentRows)).toBe("stale-snapshot");
    expect(adapter.acceptRows(rowsStore.getSnapshot())).toBe("accepted-changed");
  });

  it("withdraws edit authority until replacement column semantics are admitted", () => {
    const resident = { id: "first", name: "Ada", note: "math" } satisfies Row;
    const initialColumns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    const replacementColumns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "note",
        headerName: "Note",
        valueType: "text",
      },
    ]);
    const getRowId = (row: Row) => row.id;
    const { adapter, runtime, view } = createSubject([resident], initialColumns);
    const rowsStore = adapter.createRowsStore(view, () => () => true);
    rowsStore.subscribe(() => undefined);
    expect(adapter.acceptRows(rowsStore.getSnapshot())).toBe("accepted-changed");
    expect(adapter.getAuthoritativeEditCellSnapshot("first", "COL_ID_NAME")).toEqual({
      found: true,
      value: "Ada",
    });

    const configured = adapter.configure(getRowId, replacementColumns);

    expect(adapter.hasAuthoritativeEditSource()).toBe(false);
    expect(adapter.isEditSourceConfiguredFor(replacementColumns)).toBe(false);
    expect(adapter.getAuthoritativeEditCellSnapshot("first", "COL_ID_NAME")).toEqual({
      found: false,
    });

    runtime.reconcile(
      configured,
      replacementColumns,
      adapter.getQueryConfiguration(replacementColumns),
    );
    expect(adapter.acceptRows(rowsStore.getSnapshot())).toBe("accepted-changed");
    expect(adapter.isEditSourceConfiguredFor(replacementColumns)).toBe(true);
    expect(adapter.getAuthoritativeEditCellSnapshot("first", "COL_ID_NAME")).toEqual({
      found: true,
      value: "math",
    });
  });

  it("withdraws edit authority for a ready source with no coherent row space", () => {
    const resident = { id: "first", name: "Resident" } satisfies Row;
    const replacement = { id: "first", name: "Replacement" } satisfies Row;
    const { adapter, runtime, view } = createSubject([resident]);
    const rowsStore = adapter.createRowsStore(view, () => () => true);
    rowsStore.subscribe(() => undefined);
    expect(adapter.acceptRows(rowsStore.getSnapshot())).toBe("accepted-changed");
    expect(adapter.hasAuthoritativeEditSource()).toBe(true);

    const invalid = adapter.publish(source([replacement], "ready", { totalRows: 2 }));
    runtime.publish(invalid);
    expect(invalid.rowSpace).toBeUndefined();
    expect(adapter.hasAuthoritativeEditSource()).toBe(false);
    expect(adapter.getAuthoritativeEditRowSnapshot("first")).toBeUndefined();

    runtime.publish(adapter.publish(source([replacement])));
    expect(adapter.hasAuthoritativeEditSource()).toBe(false);
    expect(adapter.acceptRows(rowsStore.getSnapshot())).toBe("accepted-changed");
    expect(adapter.hasAuthoritativeEditSource()).toBe(true);
    expect(adapter.getAuthoritativeEditRowSnapshot("first")).toBe(replacement);
  });

  it("withdraws edit authority when an invalid stale source retains coherent rows", () => {
    const resident = { id: "first", name: "Resident" } satisfies Row;
    const replacement = { id: "first", name: "Replacement" } satisfies Row;
    const { adapter, runtime, view } = createSubject([resident]);
    const rowsStore = adapter.createRowsStore(view, () => () => false);
    rowsStore.subscribe(() => undefined);
    expect(adapter.acceptRows(rowsStore.getSnapshot())).toBe("accepted-changed");

    const invalid = adapter.publish(source([replacement], "stale", { totalRows: 2 }));
    runtime.publish(invalid);

    expect(invalid.rowSpace?.getRow("first")).toBe(resident);
    expect(invalid.invalid).toEqual({
      kind: "row-count-mismatch",
      expectedRows: 2,
      receivedRows: 1,
    });
    expect(adapter.hasAuthoritativeEditSource()).toBe(false);
    expect(adapter.getAuthoritativeEditRowSnapshot("first")).toBeUndefined();
    expect(adapter.acceptRows(rowsStore.getSnapshot())).toBe("invalid-source");
    expect(adapter.hasAuthoritativeEditSource()).toBe(false);
  });

  it("publishes full edit invalidation for accepted source envelope-only changes", () => {
    const resident = { id: "first", name: "Resident" } satisfies Row;
    const residentRows = [resident] as const;
    const { adapter, view } = createSubject(residentRows);
    const rowsStore = adapter.createRowsStore(view, () => () => true);
    rowsStore.subscribe(() => undefined);
    expect(adapter.acceptRows(rowsStore.getSnapshot())).toBe("accepted-changed");
    const changes: Array<ReadonlySet<string> | undefined> = [];
    adapter.subscribeEditSource((changedRowIds) => changes.push(changedRowIds));

    const versionOnly = adapter.publish({ ...source(residentRows), version: 2 });
    const staleOnly = adapter.publish({ ...source(residentRows, "stale"), version: 2 });

    expect(versionOnly.changedRowIds).toBeUndefined();
    expect(staleOnly.changedRowIds).toBeUndefined();
    expect(changes).toEqual([undefined, undefined]);
    expect(adapter.hasAuthoritativeEditSource()).toBe(true);
  });

  it("preserves undefined failures from Client rows-store subscribers across the drain", () => {
    const initial = { id: "first", name: "Initial" } satisfies Row;
    const outer = { id: "first", name: "Outer" } satisfies Row;
    const newest = { id: "first", name: "Newest" } satisfies Row;
    const { adapter, runtime, view } = createSubject([initial]);
    const rowsStore = adapter.createRowsStore(view, () => () => true);
    const laterFailure = new Error("later rows-store listener failed");
    const events: string[] = [];
    rowsStore.subscribe(() => {
      const row = rowsStore.getSnapshot()[0]?.raw as Row | undefined;
      if (row?.name !== "Outer") return;
      runtime.publish(adapter.publish(source([newest])));
      throw undefined;
    });
    rowsStore.subscribe(() => {
      const row = rowsStore.getSnapshot()[0]?.raw as Row | undefined;
      if (row?.name === "Outer") throw laterFailure;
    });
    rowsStore.subscribe(() => {
      const row = rowsStore.getSnapshot()[0]?.raw as Row | undefined;
      events.push(String(row?.name));
    });

    let caught = false;
    try {
      runtime.publish(adapter.publish(source([outer])));
    } catch (error) {
      caught = true;
      expect(error).toBeUndefined();
    }

    expect(caught).toBe(true);
    expect(events).toEqual(["Outer", "Newest"]);
    expect(view.getRowSnapshot("first")).toBe(newest);
  });

  it("preserves an undefined Client row detector failure while draining newer work", () => {
    const initial = { id: "first", name: "Initial" } satisfies Row;
    const outer = { id: "first", name: "Outer" } satisfies Row;
    const newest = { id: "first", name: "Newest" } satisfies Row;
    const { adapter, runtime, view } = createSubject([initial]);
    view.subscribeRowSpace(() => {
      if (view.getCellValueSnapshot("first", "COL_ID_NAME") === "Outer") {
        runtime.publish(adapter.publish(source([newest])));
      }
    });
    const rowsStore = adapter.createRowsStore(view, () => (_previousRows, nextRows) => {
      if ((nextRows[0]?.raw as Row | undefined)?.name === "Outer") throw undefined;
      return true;
    });
    const rowsListener = vi.fn();
    rowsStore.subscribe(rowsListener);

    let caught = false;
    try {
      runtime.publish(adapter.publish(source([outer])));
    } catch (error) {
      caught = true;
      expect(error).toBeUndefined();
    }

    expect(caught).toBe(true);
    expect(rowsListener).toHaveBeenCalledTimes(2);
    expect(view.getRowSnapshot("first")).toBe(newest);
  });

  it("preserves undefined Result-count listener failures while continuing notification", () => {
    const { adapter } = createSubject();
    const laterListener = vi.fn();
    const unsubscribe = adapter.subscribeResultRowCount(() => {
      throw undefined;
    });
    adapter.subscribeResultRowCount(laterListener);

    let caught = false;
    try {
      adapter.publishResultRowCount(2);
    } catch (error) {
      caught = true;
      expect(error).toBeUndefined();
    }
    expect(caught).toBe(true);
    expect(adapter.getResultRowCountSnapshot()).toBe(2);
    expect(laterListener).toHaveBeenCalledOnce();

    unsubscribe();
    expect(() => adapter.publishResultRowCount(3)).not.toThrow();
    expect(laterListener).toHaveBeenCalledTimes(2);
  });

  it("does not let later outer cell traversal replace newer cached snapshots", () => {
    const { adapter, runtime, view } = createSubject();
    const newest = { id: "first", name: "Newest name", note: "newest note" } satisfies Row;
    const events: string[] = [];
    view.subscribeCell("first", "COL_ID_NAME", () => {
      events.push(`name:${String(view.getCellValueSnapshot("first", "COL_ID_NAME"))}`);
      if (view.getCellValueSnapshot("first", "COL_ID_NAME") === "Outer name") {
        runtime.publish(adapter.publish(source([newest])));
      }
    });
    view.subscribeCell("first", "COL_ID_NOTE", () => {
      events.push(`note:${String(view.getCellValueSnapshot("first", "COL_ID_NOTE"))}`);
    });

    runtime.publish(
      adapter.publish(source([{ id: "first", name: "Outer name", note: "outer note" }])),
    );

    expect(events).toEqual([
      "name:Outer name",
      "note:outer note",
      "name:Newest name",
      "note:newest note",
    ]);
    expect(view.getCellSnapshot("first", "COL_ID_NOTE").value).toBe("newest note");
  });

  it("drains multiple nested publications in call order with the newest terminal state", () => {
    const { adapter, runtime, view } = createSubject();
    const events: string[] = [];
    const middle = { id: "middle", name: "Middle" } satisfies Row;
    const latest = { id: "latest", name: "Latest" } satisfies Row;
    view.subscribeChrome(() => {
      events.push(
        `first:${view.getChromeSnapshot().status}:${String(view.getRowSpaceSnapshot()?.getRowId(0))}`,
      );
      if (view.getChromeSnapshot().status === "loading") {
        runtime.publish(adapter.publish(source([middle], "stale")));
      }
    });
    view.subscribeChrome(() => {
      events.push(
        `second:${view.getChromeSnapshot().status}:${String(view.getRowSpaceSnapshot()?.getRowId(0))}`,
      );
      if (view.getChromeSnapshot().status === "loading") {
        runtime.publish(adapter.publish(source([latest])));
      }
    });

    runtime.publish(adapter.publish(source([], "loading", { totalRows: 1 })));

    expect(events).toEqual([
      "first:loading:undefined",
      "second:loading:undefined",
      "first:stale:middle",
      "second:stale:middle",
      "first:ready:latest",
      "second:ready:latest",
    ]);
    expect(view.getRowSnapshot("latest")).toBe(latest);
  });

  it("drains newer work after a listener throws before another listener queues it", () => {
    const { adapter, runtime, view } = createSubject();
    const firstFailure = new Error("first listener failed");
    const newest = { id: "latest", name: "Latest" } satisfies Row;
    view.subscribeChrome(() => {
      if (view.getChromeSnapshot().status === "loading") throw firstFailure;
    });
    view.subscribeChrome(() => {
      if (view.getChromeSnapshot().status === "loading") {
        runtime.publish(adapter.publish(source([newest])));
      }
    });

    expect(() => runtime.publish(adapter.publish(source([], "loading", { totalRows: 1 })))).toThrow(
      firstFailure,
    );
    expect(view.getRowSnapshot("latest")).toBe(newest);

    expect(() => runtime.publish(adapter.publish(source([], "closed")))).not.toThrow();
    expect(view.getChromeSnapshot().status).toBe("closed");
  });

  it("keeps the first error when a listener queues newer work before throwing", () => {
    const { adapter, runtime, view } = createSubject();
    const firstFailure = new Error("outer listener failed");
    const laterFailure = new Error("nested listener failed");
    const newest = { id: "latest", name: "Latest" } satisfies Row;
    view.subscribeChrome(() => {
      if (view.getChromeSnapshot().status === "loading") {
        runtime.publish(adapter.publish(source([newest])));
        throw firstFailure;
      }
      if (view.getChromeSnapshot().status === "ready") throw laterFailure;
    });

    expect(() => runtime.publish(adapter.publish(source([], "loading", { totalRows: 1 })))).toThrow(
      firstFailure,
    );
    expect(view.getRowSnapshot("latest")).toBe(newest);

    expect(() => runtime.publish(adapter.publish(source([], "closed")))).not.toThrow();
  });

  it("preserves an undefined first failure and listener cleanup across the queued pass", () => {
    const { adapter, runtime, view } = createSubject();
    const newest = { id: "latest", name: "Latest" } satisfies Row;
    const removedListener = vi.fn();
    const unsubscribe = view.subscribeChrome(removedListener);
    view.subscribeChrome(() => {
      if (view.getChromeSnapshot().status !== "loading") return;
      unsubscribe();
      view.publishRowPipeline(adapter.publish(source([newest])));
      throw undefined;
    });

    let caught = false;
    try {
      runtime.publish(adapter.publish(source([], "loading", { totalRows: 1 })));
    } catch (error) {
      caught = true;
      expect(error).toBeUndefined();
    }
    expect(caught).toBe(true);
    expect(removedListener).toHaveBeenCalledOnce();
    expect(view.getRowSnapshot("latest")).toBe(newest);

    runtime.publish(adapter.publish(source([], "closed")));
    expect(removedListener).toHaveBeenCalledOnce();
  });

  it("does not mask an internal publication failure as a collected listener error", () => {
    const { adapter, runtime, view } = createSubject();
    const listenerFailure = new Error("listener failed");
    const internalFailure = new Error("publication invariant failed");
    const unreadable = {
      ...adapter.getPublication(),
      get status(): "ready" {
        throw internalFailure;
      },
    };
    view.subscribeChrome(() => {
      if (view.getChromeSnapshot().status !== "loading") return;
      view.publishRowPipeline(unreadable);
      throw listenerFailure;
    });

    expect(() => runtime.publish(adapter.publish(source([], "loading")))).toThrow(internalFailure);

    expect(() => runtime.publish(adapter.publish(source([], "closed")))).not.toThrow();
    expect(view.getChromeSnapshot().status).toBe("closed");
  });

  it("contains a middle cell value read failure and notifies successful siblings in order", () => {
    const initialRows = [
      { id: "first", name: "Initial first" },
      { id: "second", name: "Initial second" },
      { id: "third", name: "Initial third" },
    ] satisfies readonly Row[];
    const nextRows = [
      { id: "first", name: "Next first" },
      { id: "second", name: "Next second" },
      { id: "third", name: "Next third" },
    ] satisfies readonly Row[];
    const { adapter, runtime, view } = createSubject(initialRows);
    const readFailure = new Error("second cell read failed");
    const events: string[] = [];
    for (const row of initialRows) {
      view.subscribeCell(row.id, "COL_ID_NAME", () => events.push(`notify:${row.id}`));
    }
    const publication = adapter.publish(source(nextRows));
    const rowSpace = publication.rowSpace;
    if (rowSpace === undefined) throw new Error("Expected a resident row space.");

    expect(() =>
      runtime.publish({
        ...publication,
        rowSpace: {
          ...rowSpace,
          getCellValue(rowId, columnId) {
            events.push(`read:${rowId}`);
            if (rowId === "second") throw readFailure;
            return rowSpace.getCellValue(rowId, columnId);
          },
        },
      }),
    ).toThrow(readFailure);

    expect(events).toEqual([
      "read:first",
      "notify:first",
      "read:second",
      "notify:second",
      "read:third",
      "notify:third",
    ]);
  });

  it("contains a middle row read failure and continues later subscribed cells", () => {
    const initialRows = [
      { id: "first", name: "Initial first" },
      { id: "second", name: "Initial second" },
      { id: "third", name: "Initial third" },
    ] satisfies readonly Row[];
    const nextRows = initialRows.map((row) => ({ ...row, name: `Next ${row.id}` }));
    const { adapter, runtime, view } = createSubject(initialRows);
    const readFailure = new Error("second row read failed");
    const events: string[] = [];
    for (const row of initialRows) {
      view.subscribeCell(row.id, "COL_ID_NAME", () => events.push(`notify:${row.id}`));
    }
    const publication = adapter.publish(source(nextRows));
    const rowSpace = publication.rowSpace;
    if (rowSpace === undefined) throw new Error("Expected a resident row space.");

    expect(() =>
      runtime.publish({
        ...publication,
        rowSpace: {
          ...rowSpace,
          getRow(rowId) {
            events.push(`row:${rowId}`);
            if (rowId === "second") throw readFailure;
            return rowSpace.getRow(rowId);
          },
        },
      }),
    ).toThrow(readFailure);

    expect(events).toEqual([
      "row:first",
      "notify:first",
      "row:second",
      "notify:second",
      "row:third",
      "notify:third",
    ]);
  });

  it("invalidates a row-aware subscriber after getRow fails and recovers it later", () => {
    const initial = { id: "first", name: "Initial" } satisfies Row;
    const failed = { id: "first", name: "Failed publication" } satisfies Row;
    const recovered = { id: "first", name: "Recovered" } satisfies Row;
    const { adapter, runtime, view } = createSubject([initial]);
    const observedRows: (Row | undefined)[] = [];
    view.subscribeRow("first", () =>
      observedRows.push(view.getRowSnapshot("first") as Row | undefined),
    );
    const publication = adapter.publish(source([failed]));
    const rowSpace = publication.rowSpace;
    if (rowSpace === undefined) throw new Error("Expected a resident row space.");

    expect(() =>
      runtime.publish({
        ...publication,
        rowSpace: {
          ...rowSpace,
          getRow() {
            throw new Error("unreadable current row");
          },
        },
      }),
    ).toThrow("unreadable current row");
    expect(observedRows).toEqual([undefined]);
    expect(view.getRowSnapshot("first")).toBeUndefined();

    runtime.publish(adapter.publish(source([recovered])));
    expect(observedRows).toEqual([undefined, recovered]);
    expect(view.getRowSnapshot("first")).toBe(recovered);
  });

  it("contains a row-aware cell-value read and continues later subscribed work", () => {
    const initialRows = [
      { id: "first", name: "Initial first" },
      { id: "second", name: "Initial second" },
    ] satisfies readonly Row[];
    const nextRows = initialRows.map((row) => ({ ...row, name: `Next ${row.id}` }));
    const { adapter, runtime, view } = createSubject(initialRows);
    const readFailure = new Error("row-aware cell read failed");
    const events: string[] = [];
    view.subscribeRowCell("first", "COL_ID_NAME", () => {
      events.push(`notify:first:${view.getRowCellSnapshot("first", "COL_ID_NAME").kind}`);
    });
    view.subscribeCell("second", "COL_ID_NAME", () => events.push("notify:second"));
    const publication = adapter.publish(source(nextRows));
    const rowSpace = publication.rowSpace;
    if (rowSpace === undefined) throw new Error("Expected a resident row space.");

    expect(() =>
      runtime.publish({
        ...publication,
        rowSpace: {
          ...rowSpace,
          getCellValue(rowId, columnId) {
            events.push(`read:${rowId}`);
            if (rowId === "first") throw readFailure;
            return rowSpace.getCellValue(rowId, columnId);
          },
        },
      }),
    ).toThrow(readFailure);

    expect(events).toEqual([
      "read:first",
      "notify:first:unavailable",
      "read:second",
      "notify:second",
    ]);
  });

  it("does not renotify cells that remain unavailable across failed retries", () => {
    const initialRows = [
      { id: "first", name: "Initial first" },
      { id: "second", name: "Initial second" },
    ] satisfies readonly Row[];
    const nextRows = initialRows.map((row) => ({ ...row, name: `Next ${row.id}` }));
    const { adapter, runtime, view } = createSubject(initialRows);
    const rowCellListener = vi.fn();
    const cellListener = vi.fn();
    view.subscribeRowCell("first", "COL_ID_NAME", rowCellListener);
    view.subscribeCell("second", "COL_ID_NAME", cellListener);
    const publication = adapter.publish(source(nextRows));
    const rowSpace = publication.rowSpace;
    if (rowSpace === undefined) throw new Error("Expected a resident row space.");
    const readFailure = new Error("reads remain unavailable");
    let readCount = 0;
    const failingPublication = {
      ...publication,
      rowSpace: {
        ...rowSpace,
        getCellValue() {
          readCount += 1;
          throw readFailure;
        },
      },
    };

    expect(() => runtime.publish(failingPublication)).toThrow(readFailure);
    expect(readCount).toBe(2);
    expect(rowCellListener).toHaveBeenCalledOnce();
    expect(cellListener).toHaveBeenCalledOnce();
    const unavailableRowCellSnapshot = view.getRowCellSnapshot("first", "COL_ID_NAME");
    const unavailableCellSnapshot = view.getCellSnapshot("second", "COL_ID_NAME");

    expect(() => runtime.publish(failingPublication)).toThrow(readFailure);
    expect(readCount).toBe(4);
    expect(rowCellListener).toHaveBeenCalledOnce();
    expect(cellListener).toHaveBeenCalledOnce();
    expect(view.getRowCellSnapshot("first", "COL_ID_NAME")).toBe(unavailableRowCellSnapshot);
    expect(view.getCellSnapshot("second", "COL_ID_NAME")).toBe(unavailableCellSnapshot);

    expect(() =>
      runtime.publish({
        ...failingPublication,
        rowSpace: { ...failingPublication.rowSpace },
      }),
    ).toThrow(readFailure);
    expect(readCount).toBe(6);
    expect(rowCellListener).toHaveBeenCalledOnce();
    expect(cellListener).toHaveBeenCalledOnce();
    expect(view.getRowCellSnapshot("first", "COL_ID_NAME")).toBe(unavailableRowCellSnapshot);
    expect(view.getCellSnapshot("second", "COL_ID_NAME")).toBe(unavailableCellSnapshot);

    runtime.publish(adapter.publish(source(nextRows)));
    expect(rowCellListener).toHaveBeenCalledTimes(2);
    expect(cellListener).toHaveBeenCalledTimes(2);
    expect(view.getRowCellSnapshot("first", "COL_ID_NAME")).not.toBe(unavailableRowCellSnapshot);
    expect(view.getCellSnapshot("second", "COL_ID_NAME")).not.toBe(unavailableCellSnapshot);
  });

  it("retries indexed unavailable cells alongside a different affected row", () => {
    const initialRows = [
      { id: "first", name: "Initial first" },
      { id: "second", name: "Initial second" },
      { id: "third", name: "Initial third" },
    ] satisfies readonly Row[];
    const recoveredRows = initialRows.map((row) => ({
      ...row,
      name: row.id === "second" ? "Changed second" : row.name,
    }));
    const failedRows = initialRows.map((row) => ({
      ...row,
      name: row.id === "second" ? "Failed second" : row.name,
    }));
    const { adapter, runtime, view } = createSubject(initialRows);
    const listeners = new Map(initialRows.map((row) => [row.id, vi.fn()]));
    for (const row of initialRows) {
      view.subscribeCell(row.id, "COL_ID_NAME", listeners.get(row.id)!);
    }
    const failedPublication = adapter.publish(source(failedRows));
    const failedRowSpace = failedPublication.rowSpace;
    if (failedRowSpace === undefined) throw new Error("Expected a resident row space.");

    expect(() =>
      runtime.publish({
        ...failedPublication,
        rowSpace: {
          ...failedRowSpace,
          getCellValue(rowId, columnId) {
            if (rowId === "first") throw new Error("transient first-row failure");
            return failedRowSpace.getCellValue(rowId, columnId);
          },
        },
      }),
    ).toThrow("transient first-row failure");
    for (const listener of listeners.values()) listener.mockClear();

    const reads: string[] = [];
    const recoveredPublication = adapter.publish(source(recoveredRows));
    const recoveredRowSpace = recoveredPublication.rowSpace;
    if (recoveredRowSpace === undefined) throw new Error("Expected a resident row space.");
    runtime.publish({
      ...recoveredPublication,
      changedRowIds: new Set(["second"]),
      rowSpace: {
        ...recoveredRowSpace,
        getCellValue(rowId, columnId) {
          reads.push(rowId);
          return recoveredRowSpace.getCellValue(rowId, columnId);
        },
      },
    });

    expect(reads).toHaveLength(2);
    expect(new Set(reads)).toEqual(new Set(["first", "second"]));
    expect(listeners.get("first")).toHaveBeenCalledOnce();
    expect(listeners.get("second")).toHaveBeenCalledOnce();
    expect(listeners.get("third")).not.toHaveBeenCalled();
    expect(view.getCellSnapshot("first", "COL_ID_NAME").kind).toBe("available");
  });

  it("retains a row-aware snapshot when a successful publication is presentation-equivalent", () => {
    const initial = { id: "first", name: "Initial" } satisfies Row;
    const next = { id: "first", name: "Next" } satisfies Row;
    const { adapter, runtime, view } = createSubject([initial]);
    const listener = vi.fn();
    view.subscribeRowCell("first", "COL_ID_NAME", listener);
    const publication = adapter.publish(source([next]));
    const rowSpace = publication.rowSpace;
    if (rowSpace === undefined) throw new Error("Expected a resident row space.");
    runtime.publish(publication);
    expect(listener).toHaveBeenCalledOnce();
    const snapshot = view.getRowCellSnapshot("first", "COL_ID_NAME");

    runtime.publish({
      ...publication,
      rowSpace: { ...rowSpace },
    });

    expect(listener).toHaveBeenCalledOnce();
    expect(view.getRowCellSnapshot("first", "COL_ID_NAME")).toBe(snapshot);
  });

  it.each(["row-aware", "ordinary"] as const)(
    "does not retain a phantom %s cell subscription when its initial read fails",
    (kind) => {
      const initial = { id: "first", name: "Initial" } satisfies Row;
      const next = { id: "first", name: "Next" } satisfies Row;
      const { adapter, runtime, view } = createSubject([initial]);
      if (kind === "row-aware") view.getRowCellSnapshot("first", "COL_ID_NAME");
      else view.getCellSnapshot("first", "COL_ID_NAME");
      const publication = adapter.publish(source([next]));
      const rowSpace = publication.rowSpace;
      if (rowSpace === undefined) throw new Error("Expected a resident row space.");
      const readFailure = new Error(`${kind} subscription read failed`);
      let readCount = 0;
      const failingRowSpace = {
        ...rowSpace,
        getCellValue() {
          readCount += 1;
          throw readFailure;
        },
      };
      runtime.publish({ ...publication, rowSpace: failingRowSpace });

      expect(() =>
        kind === "row-aware"
          ? view.subscribeRowCell("first", "COL_ID_NAME", () => undefined)
          : view.subscribeCell("first", "COL_ID_NAME", () => undefined),
      ).toThrow(readFailure);
      expect(readCount).toBe(1);

      expect(() =>
        runtime.publish({ ...publication, rowSpace: { ...failingRowSpace } }),
      ).not.toThrow();
      expect(readCount).toBe(1);
    },
  );

  it("contains subscribed reads for replacement columns on the same row space", () => {
    const initialRows = [
      { id: "first", name: "Initial first" },
      { id: "second", name: "Initial second" },
    ] satisfies readonly Row[];
    const nextRows = initialRows.map((row) => ({ ...row, name: `Next ${row.id}` }));
    const { adapter, runtime, view } = createSubject(initialRows);
    const readFailure = new Error("replacement column read failed");
    const events: string[] = [];
    view.subscribeRowCell("first", "COL_ID_NAME", () => events.push("notify:first"));
    view.subscribeCell("second", "COL_ID_NAME", () => events.push("notify:second"));
    const publication = adapter.publish(source(nextRows));
    const rowSpace = publication.rowSpace;
    if (rowSpace === undefined) throw new Error("Expected a resident row space.");
    let failFirstRead = false;
    const sharedPublication = {
      ...publication,
      rowSpace: {
        ...rowSpace,
        getCellValue(rowId: string, columnId: string) {
          events.push(`read:${rowId}`);
          if (failFirstRead && rowId === "first") throw readFailure;
          return rowSpace.getCellValue(rowId, columnId);
        },
      },
    };
    runtime.publish(sharedPublication);
    events.length = 0;
    const replacementColumns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Replacement Name",
        valueType: "text",
      },
    ]);
    failFirstRead = true;

    expect(() =>
      runtime.reconcile(
        sharedPublication,
        replacementColumns,
        adapter.getQueryConfiguration(replacementColumns),
      ),
    ).toThrow(readFailure);
    expect(events).toEqual(["read:first", "notify:first", "read:second", "notify:second"]);
    expect(view.getRowCellSnapshot("first", "COL_ID_NAME").kind).toBe("unavailable");
    expect(view.getCellSnapshot("second", "COL_ID_NAME")).toMatchObject({
      kind: "available",
      column: replacementColumns[0],
      value: "Next second",
    });
    events.length = 0;

    view.getRowCellSnapshot("first", "COL_ID_NAME");
    view.getCellSnapshot("second", "COL_ID_NAME");
    expect(events).toEqual([]);
  });

  it("preserves an undefined read failure ahead of later listener failures", () => {
    const initialRows = [
      { id: "first", name: "Initial first" },
      { id: "second", name: "Initial second" },
    ] satisfies readonly Row[];
    const nextRows = initialRows.map((row) => ({ ...row, name: `Next ${row.id}` }));
    const { adapter, runtime, view } = createSubject(initialRows);
    const laterFailure = new Error("later listener failed");
    view.subscribeCell("first", "COL_ID_NAME", () => undefined);
    view.subscribeCell("second", "COL_ID_NAME", () => {
      throw laterFailure;
    });
    const publication = adapter.publish(source(nextRows));
    const rowSpace = publication.rowSpace;
    if (rowSpace === undefined) throw new Error("Expected a resident row space.");
    let caught = false;

    try {
      runtime.publish({
        ...publication,
        rowSpace: {
          ...rowSpace,
          getCellValue(rowId, columnId) {
            if (rowId === "first") throw undefined;
            return rowSpace.getCellValue(rowId, columnId);
          },
        },
      });
    } catch (error) {
      caught = true;
      expect(error).toBeUndefined();
    }

    expect(caught).toBe(true);
  });

  it("keeps an earlier listener failure ahead of later read and listener failures", () => {
    const initialRows = [
      { id: "first", name: "Initial first" },
      { id: "second", name: "Initial second" },
      { id: "third", name: "Initial third" },
    ] satisfies readonly Row[];
    const nextRows = initialRows.map((row) => ({ ...row, name: `Next ${row.id}` }));
    const { adapter, runtime, view } = createSubject(initialRows);
    const firstFailure = new Error("first listener failed");
    const laterListener = vi.fn(() => {
      throw new Error("later listener failed");
    });
    view.subscribeCell("first", "COL_ID_NAME", () => {
      throw firstFailure;
    });
    view.subscribeCell("second", "COL_ID_NAME", () => undefined);
    view.subscribeCell("third", "COL_ID_NAME", laterListener);
    const publication = adapter.publish(source(nextRows));
    const rowSpace = publication.rowSpace;
    if (rowSpace === undefined) throw new Error("Expected a resident row space.");

    expect(() =>
      runtime.publish({
        ...publication,
        rowSpace: {
          ...rowSpace,
          getCellValue(rowId, columnId) {
            if (rowId === "second") throw undefined;
            return rowSpace.getCellValue(rowId, columnId);
          },
        },
      }),
    ).toThrow(firstFailure);
    expect(laterListener).toHaveBeenCalledOnce();
  });

  it("does not expose a stale successful value after a failed read and recovers later", () => {
    const initial = { id: "first", name: "Initial" } satisfies Row;
    const failed = { id: "first", name: "Failed publication" } satisfies Row;
    const recovered = { id: "first", name: "Recovered" } satisfies Row;
    const { adapter, runtime, view } = createSubject([initial]);
    const observedSnapshots: unknown[] = [];
    const listener = vi.fn(() => {
      observedSnapshots.push(view.getCellSnapshot("first", "COL_ID_NAME"));
    });
    view.subscribeCell("first", "COL_ID_NAME", listener);
    const publication = adapter.publish(source([failed]));
    const rowSpace = publication.rowSpace;
    if (rowSpace === undefined) throw new Error("Expected a resident row space.");
    let currentRow = failed;
    let cellReadFails = true;
    const sharedRowSpace = {
      ...rowSpace,
      getRow(rowId: string) {
        return rowId === currentRow.id ? currentRow : undefined;
      },
      getCellValue() {
        if (cellReadFails) throw new Error("unreadable current value");
        return currentRow.name;
      },
    };
    const sharedPublication = { ...publication, rowSpace: sharedRowSpace };

    expect(() => runtime.publish(sharedPublication)).toThrow("unreadable current value");
    expect(listener).toHaveBeenCalledOnce();
    const unavailableSnapshot = view.getCellSnapshot("first", "COL_ID_NAME");
    expect(unavailableSnapshot).toMatchObject({
      kind: "unavailable",
      value: undefined,
    });
    expect(unavailableSnapshot).not.toHaveProperty("rowPresent");
    expect(observedSnapshots).toEqual([
      expect.objectContaining({ kind: "unavailable", value: undefined }),
    ]);
    expect(observedSnapshots[0]).not.toHaveProperty("rowPresent");

    currentRow = recovered;
    cellReadFails = false;
    runtime.publish(sharedPublication);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(view.getCellSnapshot("first", "COL_ID_NAME").value).toBe("Recovered");
    expect(observedSnapshots.at(-1)).toMatchObject({ kind: "available", value: "Recovered" });
  });

  it("retains FIFO newest authority when a later cell queues recovery after a read failure", () => {
    const initialRows = [
      { id: "first", name: "Initial first" },
      { id: "second", name: "Initial second" },
      { id: "third", name: "Initial third" },
    ] satisfies readonly Row[];
    const outerRows = initialRows.map((row) => ({ ...row, name: `Outer ${row.id}` }));
    const newestRows = initialRows.map((row) => ({ ...row, name: `Newest ${row.id}` }));
    const { adapter, runtime, view } = createSubject(initialRows);
    const readFailure = new Error("outer second read failed");
    const events: string[] = [];
    for (const row of initialRows) {
      view.subscribeCell(row.id, "COL_ID_NAME", () => {
        const value = String(view.getCellValueSnapshot(row.id, "COL_ID_NAME"));
        events.push(`${row.id}:${value}`);
        if (row.id === "third" && value === "Outer third") {
          runtime.publish(adapter.publish(source(newestRows)));
        }
      });
    }
    const publication = adapter.publish(source(outerRows));
    const rowSpace = publication.rowSpace;
    if (rowSpace === undefined) throw new Error("Expected a resident row space.");

    expect(() =>
      runtime.publish({
        ...publication,
        rowSpace: {
          ...rowSpace,
          getCellValue(rowId, columnId) {
            if (rowId === "second") throw readFailure;
            return rowSpace.getCellValue(rowId, columnId);
          },
        },
      }),
    ).toThrow(readFailure);

    expect(events).toEqual([
      "first:Outer first",
      "second:undefined",
      "third:Outer third",
      "first:Newest first",
      "second:Newest second",
      "third:Newest third",
    ]);
    expect(view.getRowSnapshot("first")).toBe(newestRows[0]);
    expect(view.getCellSnapshot("second", "COL_ID_NAME").value).toBe("Newest second");
  });

  it("prioritizes a nested internal invariant failure over collected read and listener errors", () => {
    const initialRows = [
      { id: "first", name: "Initial first" },
      { id: "second", name: "Initial second" },
    ] satisfies readonly Row[];
    const outerRows = initialRows.map((row) => ({ ...row, name: `Outer ${row.id}` }));
    const newest = { id: "first", name: "Reusable" } satisfies Row;
    const { adapter, runtime, view } = createSubject(initialRows);
    const readFailure = new Error("read failed");
    const listenerFailure = new Error("listener failed");
    const invariantFailure = new Error("publication invariant failed");
    const unreadable = {
      ...adapter.getPublication(),
      get status(): "ready" {
        throw invariantFailure;
      },
    };
    let queuedInvariantFailure = false;
    view.subscribeCell("first", "COL_ID_NAME", () => undefined);
    view.subscribeCell("second", "COL_ID_NAME", () => {
      if (queuedInvariantFailure) return;
      queuedInvariantFailure = true;
      view.publishRowPipeline(unreadable);
      throw listenerFailure;
    });
    const publication = adapter.publish(source(outerRows));
    const rowSpace = publication.rowSpace;
    if (rowSpace === undefined) throw new Error("Expected a resident row space.");

    expect(() =>
      runtime.publish({
        ...publication,
        rowSpace: {
          ...rowSpace,
          getCellValue(rowId, columnId) {
            if (rowId === "first") throw readFailure;
            return rowSpace.getCellValue(rowId, columnId);
          },
        },
      }),
    ).toThrow(invariantFailure);

    expect(() => runtime.publish(adapter.publish(source([newest])))).not.toThrow();
    expect(view.getRowSnapshot("first")).toBe(newest);
  });
});
