import { describe, expect, it, vi } from "vitest";

import { BrunoTableAggregateAlgebra } from "../public-types";
import { compileColumns } from "./compile-columns";
import {
  applyBrunoTableGridCommand,
  createBrunoTableColumnLayout,
  getBrunoTableColumnLayoutSnapshot,
} from "./column-management";
import {
  BrunoTableClientProjectionPlanCompiler,
  BrunoTableClientProjectionStore,
  ClientRowOrderStore,
  deriveClientProjectionRowModel,
} from "./client-row-pipeline";
import { BrunoTableClientRowPipelineAdapter } from "./client-source-adapter";
import { compileClientFilterCollection } from "./grid-query";
import { BrunoTableGridRuntime } from "./grid-runtime";

describe("BrunoTableClientRowPipelineAdapter edit reconciliation deltas", () => {
  it("publishes precise changed and removed raw Row Identities", () => {
    type Row = Readonly<{ readonly id: string; readonly value: string }>;
    const columns = compileColumns([
      {
        columnId: "COL_ID_VALUE",
        field: "value",
        headerName: "Value",
        valueType: "text",
      },
    ]);
    const first: Row = Object.freeze({ id: "first", value: "A" });
    const second: Row = Object.freeze({ id: "second", value: "B" });
    const adapter = new BrunoTableClientRowPipelineAdapter(
      { rows: [first, second], totalRows: 2, version: 1, status: "ready" },
      (row: Row) => row.id,
      columns,
      undefined,
      [{ columnId: "COL_ID_VALUE", direction: "asc" }],
    );

    const changedSecond = Object.freeze({ ...second, value: "C" });
    const changed = adapter.reconcile(
      { rows: [first, changedSecond], totalRows: 2, version: 2, status: "ready" },
      (row: Row) => row.id,
      columns,
    );
    expect(changed.changedRowIds).toEqual(new Set([second.id]));

    const removed = adapter.reconcile(
      { rows: [first], totalRows: 1, version: 3, status: "ready" },
      (row: Row) => row.id,
      columns,
    );
    expect(removed.changedRowIds).toEqual(new Set([second.id]));

    const versionOnly = adapter.reconcile(
      { rows: [first], totalRows: 1, version: 4, status: "ready" },
      (row: Row) => row.id,
      columns,
    );
    expect(versionOnly.changedRowIds).toBeUndefined();
  });
});

describe("ClientRowOrderStore", () => {
  it("keeps the raw row-space authority stable until identities or generation change", () => {
    const store = new ClientRowOrderStore(["first", "second", "third"], 0);
    const initialRowSpace = store.getSnapshot().rowSpace;
    expect(initialRowSpace.identitySnapshot?.rowIds).toEqual(["first", "second", "third"]);
    expect(initialRowSpace.identitySnapshot?.rowIndexById.get("third")).toBe(2);

    const listener = vi.fn();
    store.subscribe(listener);
    store.publish(["first", "second", "third"], 0);
    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot().rowSpace).toBe(initialRowSpace);

    store.publish(["first", "second", "third"], 1);
    expect(listener).toHaveBeenCalledOnce();
    expect(store.getSnapshot().rowSpace).toBe(initialRowSpace);

    store.publish(["third", "first", "second"], 1);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().rowSpace).not.toBe(initialRowSpace);
    expect(store.getSnapshot().rowSpace.findRowIndex("first")).toBe(1);
  });

  it("publishes the complete replacement even when an earlier listener throws", () => {
    const store = new ClientRowOrderStore(["first", "second"], 0);
    const failure = new Error("listener failed");
    const laterListener = vi.fn();
    store.subscribe(() => {
      throw failure;
    });
    store.subscribe(laterListener);

    expect(() => store.publish(["second", "first"], 1)).toThrow(failure);
    expect(laterListener).toHaveBeenCalledOnce();
    expect(store.getSnapshot().queryGeneration).toBe(1);
    expect(store.getSnapshot().rowSpace.identitySnapshot?.rowIds).toEqual(["second", "first"]);
  });
});

describe("grouped Client projection planning", () => {
  it("subscribes only while the table-local projection owner is committed", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_GROUP",
        field: "group",
        headerName: "Group",
        valueType: "text",
        groupBy: true,
      },
    ]);
    type Row = Readonly<{ id: string; group: string }>;
    const adapter = new BrunoTableClientRowPipelineAdapter(
      { rows: [{ id: "one", group: "A" }], totalRows: 1, version: 1, status: "ready" },
      (row: Row) => row.id,
      columns,
      undefined,
      [{ columnId: "COL_ID_GROUP", direction: "asc" }],
    );
    const runtime = new BrunoTableGridRuntime(
      adapter.getPublication(),
      columns,
      adapter.getQueryConfiguration(columns),
      "TABLE_ID_COMMITTED_PROJECTION_OWNER",
      { grouping: true },
    );
    const view = runtime.getView();
    const projectionUnsubscribe = vi.fn();
    const queryUnsubscribe = vi.fn();
    const structureUnsubscribe = vi.fn();
    const subscribeProjectionInput = adapter.subscribeProjectionInput.bind(adapter);
    const projectionSubscribe = vi
      .spyOn(adapter, "subscribeProjectionInput")
      .mockImplementation((listener) => {
        const unsubscribe = subscribeProjectionInput(listener);
        return () => {
          projectionUnsubscribe();
          unsubscribe();
        };
      });
    const querySubscribe = vi.fn((listener) => {
      const unsubscribe = view.subscribeQuery(listener);
      return () => {
        queryUnsubscribe();
        unsubscribe();
      };
    });
    const structureSubscribe = vi.fn((listener) => {
      const unsubscribe = view.subscribeColumnStructure(listener);
      return () => {
        structureUnsubscribe();
        unsubscribe();
      };
    });
    const monitoredView = {
      ...view,
      subscribeQuery: querySubscribe,
      subscribeColumnStructure: structureSubscribe,
    } satisfies typeof view;

    const abandoned = new BrunoTableClientProjectionStore(monitoredView, adapter, undefined);
    expect(view.getInstalledClientProjectionSnapshot()).toBeUndefined();
    expect(projectionSubscribe).not.toHaveBeenCalled();
    expect(querySubscribe).not.toHaveBeenCalled();
    expect(structureSubscribe).not.toHaveBeenCalled();
    void abandoned;

    const committed = new BrunoTableClientProjectionStore(monitoredView, adapter, undefined);
    const deactivate = committed.activate();
    expect(projectionSubscribe).toHaveBeenCalledOnce();
    expect(querySubscribe).toHaveBeenCalledOnce();
    expect(structureSubscribe).toHaveBeenCalledOnce();
    deactivate();
    expect(projectionUnsubscribe).toHaveBeenCalledOnce();
    expect(queryUnsubscribe).toHaveBeenCalledOnce();
    expect(structureUnsubscribe).toHaveBeenCalledOnce();

    const projectGroupedRows = vi.spyOn(adapter, "projectGroupedRows");
    view.dispatchGridCommand({ type: "grouping.add", columnId: "COL_ID_GROUP" });
    expect(projectGroupedRows).not.toHaveBeenCalled();
    expect(view.getInstalledClientProjectionSnapshot()).toBeUndefined();

    const deactivateAgain = committed.activate();
    expect(projectGroupedRows).toHaveBeenCalledOnce();
    expect(view.getInstalledClientProjectionSnapshot()?.kind).toBe("grouped");
    deactivateAgain();
    expect(projectionUnsubscribe).toHaveBeenCalledTimes(2);
    expect(queryUnsubscribe).toHaveBeenCalledTimes(2);
    expect(structureUnsubscribe).toHaveBeenCalledTimes(2);
  });

  it("keeps hidden aggregates out of the real projection-store execution plan", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_GROUP",
        field: "group",
        headerName: "Group",
        valueType: "text",
        groupBy: true,
      },
      {
        columnId: "COL_ID_HIDDEN_TOTAL",
        field: "amount",
        headerName: "Hidden total",
        valueType: "bigint",
        aggFunc: "sum",
      },
    ]);
    type Row = Readonly<{ id: string; group: string; amount: bigint }>;
    let hiddenReads = 0;
    const createRow = (version: number): Row => {
      const row = { id: `row-${String(version)}`, group: "A" } as {
        id: string;
        group: string;
        amount: bigint;
      };
      Object.defineProperty(row, "amount", {
        enumerable: true,
        get: () => {
          hiddenReads += 1;
          throw new Error("A hidden aggregate must never execute.");
        },
      });
      return row;
    };
    const source = (version: number) => ({
      rows: [createRow(version)],
      totalRows: 1,
      version,
      status: "ready" as const,
    });
    const adapter = new BrunoTableClientRowPipelineAdapter(
      source(1),
      (row: Row) => row.id,
      columns,
      undefined,
      [{ columnId: "COL_ID_GROUP", direction: "asc" }],
    );
    const runtime = new BrunoTableGridRuntime(
      adapter.getPublication(),
      columns,
      adapter.getQueryConfiguration(columns),
      "TABLE_ID_HIDDEN_AGGREGATE_EXECUTION",
      { grouping: true },
    );
    const view = runtime.getView();
    view.dispatchGridCommand({
      type: "column.visibility.commit",
      columnId: "COL_ID_HIDDEN_TOTAL",
      visible: false,
    });
    const store = new BrunoTableClientProjectionStore(view, adapter, undefined);
    const deactivate = store.activate();
    view.dispatchGridCommand({ type: "grouping.add", columnId: "COL_ID_GROUP" });
    expect(view.getInstalledClientProjectionSnapshot()?.kind).toBe("grouped");
    expect(hiddenReads).toBe(0);

    const rowId = view.getInstalledClientProjectionSnapshot()?.rowIds[0];
    expect(rowId).toBeDefined();
    const rowNotifications = vi.fn();
    const cellNotifications = vi.fn();
    const structuralNotifications = vi.fn();
    const unsubscribeRow = view.subscribeRow(rowId!, rowNotifications);
    const unsubscribeCell = view.subscribeCell(rowId!, "COL_ID_GROUP", cellNotifications);
    const unsubscribeStructural = view.subscribeInstalledClientProjection(structuralNotifications);
    adapter.reconcile(source(2), (row: Row) => row.id, columns);
    adapter.publishProjectionInput(columns, adapter.getQueryConfiguration(columns));
    expect(hiddenReads).toBe(0);
    expect(rowNotifications).not.toHaveBeenCalled();
    expect(cellNotifications).not.toHaveBeenCalled();
    expect(structuralNotifications).not.toHaveBeenCalled();

    view.dispatchGridCommand({
      type: "column.visibility.commit",
      columnId: "COL_ID_HIDDEN_TOTAL",
      visible: true,
    });
    expect(hiddenReads).toBeGreaterThan(0);
    expect(view.getInstalledClientProjectionSnapshot()?.kind).toBe("invalid");
    unsubscribeRow();
    unsubscribeCell();
    unsubscribeStructural();
    deactivate();
  });

  it("keeps dormant visibility out of grouped presentation identity", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_GROUP",
        field: "group",
        headerName: "Group",
        valueType: "text",
        groupBy: true,
      },
      {
        columnId: "COL_ID_TOTAL",
        field: "amount",
        headerName: "Total",
        valueType: "bigint",
        aggFunc: "sum",
      },
      {
        columnId: "COL_ID_DORMANT",
        field: "note",
        headerName: "Dormant",
        valueType: "text",
      },
    ]);
    type Row = Readonly<{ id: string; group: string; amount: bigint; note: string }>;
    const adapter = new BrunoTableClientRowPipelineAdapter(
      {
        rows: [{ id: "one", group: "A", amount: 1n, note: "private" }],
        totalRows: 1,
        version: 1,
        status: "ready",
      },
      (row: Row) => row.id,
      columns,
      undefined,
      [{ columnId: "COL_ID_GROUP", direction: "asc" }],
    );
    const persisted: Readonly<Record<string, unknown>>[] = [];
    const runtime = new BrunoTableGridRuntime(
      adapter.getPublication(),
      columns,
      adapter.getQueryConfiguration(columns),
      "TABLE_ID_DORMANT_GROUPED_VISIBILITY",
      { grouping: true, getOnPersistChange: () => (state) => persisted.push(state) },
    );
    const view = runtime.getView();
    const planCompiler = new BrunoTableClientProjectionPlanCompiler();
    const store = new BrunoTableClientProjectionStore(view, adapter, undefined, planCompiler);
    const deactivate = store.activate();
    view.dispatchGridCommand({ type: "grouping.add", columnId: "COL_ID_GROUP" });
    const grouped = view.getInstalledClientProjectionSnapshot();
    expect(grouped?.kind).toBe("grouped");
    if (grouped?.kind !== "grouped") throw new Error("Expected grouped projection.");
    const groupedColumns = grouped.columns;
    const groupedColumnRefs = Object.freeze(Array.from(grouped.columns));
    const compilationCount = planCompiler.getCompilationDiagnosticSnapshot();
    const projectionNotifications = vi.fn();
    const unsubscribe = view.subscribeInstalledClientProjection(projectionNotifications);

    expect(
      view.dispatchGridCommand({
        type: "column.visibility.commit",
        columnId: "COL_ID_DORMANT",
        visible: false,
      }),
    ).toBe(true);

    expect(persisted.at(-1)?.["columnVisibility"]).toMatchObject({ COL_ID_DORMANT: false });
    expect(view.getInstalledClientProjectionSnapshot()).toBe(grouped);
    expect(view.getInstalledClientProjectionSnapshot()?.columns).toBe(groupedColumns);
    expect(
      view
        .getInstalledClientProjectionSnapshot()
        ?.columns.every((column, index) => column === groupedColumnRefs[index]),
    ).toBe(true);
    expect(planCompiler.getCompilationDiagnosticSnapshot()).toEqual({
      logical: compilationCount.logical,
      presentation: compilationCount.presentation,
      presentationDescriptors: compilationCount.presentationDescriptors + 1,
    });
    expect(projectionNotifications).not.toHaveBeenCalled();

    expect(
      view.dispatchGridCommand({
        type: "column.visibility.commit",
        columnId: "COL_ID_TOTAL",
        visible: false,
      }),
    ).toBe(true);

    expect(projectionNotifications).toHaveBeenCalledOnce();
    const withoutAggregate = view.getInstalledClientProjectionSnapshot();
    expect(withoutAggregate).not.toBe(grouped);
    expect(withoutAggregate?.columns.map((column) => column.columnId)).toEqual([
      "COL_ID_GROUP",
      "COL_ID_BRUNO_TABLE_ROWS",
    ]);
    expect(planCompiler.getCompilationDiagnosticSnapshot()).toEqual({
      logical: compilationCount.logical,
      presentation: compilationCount.presentation + 1,
      presentationDescriptors: compilationCount.presentationDescriptors + 2,
    });
    unsubscribe();
    deactivate();
  });

  it("retains compatible grouped rows when a stale pre-group filter read is invalid", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_GROUP",
        field: "group",
        headerName: "Group",
        valueType: "text",
        groupBy: true,
      },
      {
        columnId: "COL_ID_AMOUNT",
        field: "amount",
        headerName: "Amount",
        valueType: "bigint",
        aggFunc: "sum",
      },
    ]);
    type Row = Readonly<{ id: string; group: string; amount: unknown }>;
    const source = (amount: unknown, version: number, status: "ready" | "stale") => ({
      rows: [{ id: "one", group: "A", amount }],
      totalRows: 1,
      version,
      status,
      ...(status === "stale" ? { message: "Stale filter value" } : {}),
    });
    const adapter = new BrunoTableClientRowPipelineAdapter(
      source(1n, 1, "ready"),
      (row: Row) => row.id,
      columns,
      undefined,
      [{ columnId: "COL_ID_GROUP", direction: "asc" }],
    );
    const runtime = new BrunoTableGridRuntime(
      adapter.getPublication(),
      columns,
      adapter.getQueryConfiguration(columns),
      "TABLE_ID_PRE_GROUP_FILTER_FALLBACK",
      { grouping: true },
    );
    const view = runtime.getView();
    const store = new BrunoTableClientProjectionStore(view, adapter, undefined);
    const deactivate = store.activate();
    view.dispatchGridCommand({ type: "grouping.add", columnId: "COL_ID_GROUP" });
    view.dispatchGridCommand({
      type: "column.filter.replace",
      columnId: "COL_ID_AMOUNT",
      filter: { columnId: "COL_ID_AMOUNT", type: "equals", filter: 1n },
    });
    const readyProjection = view.getInstalledClientProjectionSnapshot();
    expect(readyProjection?.kind).toBe("grouped");
    const readyRowId = readyProjection?.rowIds[0];
    expect(readyRowId).toBeDefined();

    adapter.reconcile(source("invalid-bigint", 2, "stale"), (row: Row) => row.id, columns);
    adapter.publishProjectionInput(columns, adapter.getQueryConfiguration(columns));

    expect(view.getInstalledClientProjectionSnapshot()).toMatchObject({
      kind: "grouped",
      rowIds: [readyRowId],
    });
    expect(view.getChromeSnapshot()).toMatchObject({
      status: "stale",
      hasCoherentRows: true,
      invalid: { kind: "invalid-value", columnId: "COL_ID_AMOUNT" },
    });
    expect(view.getCellSnapshot(readyRowId!, "COL_ID_AMOUNT")).toMatchObject({
      kind: "available",
      value: 1n,
    });
    deactivate();
  });

  it.each(["stale", "closed", "error"] as const)(
    "retains the compatible ready grouped epoch when a %s aggregate candidate fails",
    (status) => {
      type Money = Readonly<{ readonly minorUnits: bigint }>;
      type Row = Readonly<{ id: string; group: string; amount: Money; note: string }>;
      let rejectedOperation: "add" | "divide" | undefined;
      const columns = compileColumns([
        {
          columnId: "COL_ID_GROUP",
          field: "group",
          headerName: "Group",
          valueType: "text",
          groupBy: true,
        },
        {
          columnId: "COL_ID_AMOUNT",
          field: "amount",
          headerName: "Amount",
          valueType: {
            codecId: "test/pipeline-money",
            codecVersion: 1,
            filterFamily: "numeric",
            editorFamily: "text",
            cellAlign: "end",
            editorLayout: "inline",
            defaultWidth: 120,
            aggregateResults: { avg: "self" },
            aggregateAlgebra: BrunoTableAggregateAlgebra<Money>({
              add: (left, right) => {
                if (rejectedOperation === "add") throw new Error("aggregate candidate failed");
                return { minorUnits: left.minorUnits + right.minorUnits };
              },
              divideByCount: (total, count) => {
                if (rejectedOperation === "divide") {
                  throw new Error("aggregate candidate failed");
                }
                return { minorUnits: total.minorUnits / count };
              },
            }),
            decodeRuntime: (input: unknown) =>
              typeof input === "object" &&
              input !== null &&
              "minorUnits" in input &&
              typeof input.minorUnits === "bigint"
                ? { _tag: "Success" as const, value: input as Money }
                : { _tag: "Failure" as const, message: "Expected Money." },
            equivalent: (left: Money, right: Money) => left.minorUnits === right.minorUnits,
            compare: (left: Money, right: Money) =>
              left.minorUnits === right.minorUnits
                ? 0
                : left.minorUnits < right.minorUnits
                  ? -1
                  : 1,
            formatCanonicalText: (value: Money) => value.minorUnits.toString(),
            parseCanonicalText: (text: string) => ({
              _tag: "Success" as const,
              value: { minorUnits: BigInt(text) },
            }),
            formatDisplay: (value: Money) => value.minorUnits.toString(),
            encodePersisted: (value: Money) => value.minorUnits.toString(),
            decodePersisted: (input: unknown) =>
              typeof input === "string"
                ? { _tag: "Success" as const, value: { minorUnits: BigInt(input) } }
                : { _tag: "Failure" as const, message: "Expected persisted Money." },
          },
          aggFunc: "avg",
        },
        {
          columnId: "COL_ID_DORMANT",
          field: "note",
          headerName: "Dormant",
          valueType: "text",
        },
      ]);
      const readyRows: readonly Row[] = [
        { id: "one", group: "A", amount: { minorUnits: 1n }, note: "first" },
        { id: "two", group: "A", amount: { minorUnits: 2n }, note: "second" },
      ];
      const source = (
        rows: readonly Row[],
        version: number,
        sourceStatus: typeof status | "ready",
      ) =>
        ({
          rows,
          totalRows: rows.length,
          version,
          status: sourceStatus,
          ...(sourceStatus === "ready" ? {} : { message: `${sourceStatus} candidate failed` }),
        }) as const;
      const adapter = new BrunoTableClientRowPipelineAdapter(
        source(readyRows, 1, "ready"),
        (row: Row) => row.id,
        columns,
        undefined,
        [{ columnId: "COL_ID_GROUP", direction: "asc" }],
      );
      const runtime = new BrunoTableGridRuntime(
        adapter.getPublication(),
        columns,
        adapter.getQueryConfiguration(columns),
        `TABLE_ID_GROUPED_${status.toUpperCase()}_FALLBACK`,
        { grouping: true },
      );
      const view = runtime.getView();
      const store = new BrunoTableClientProjectionStore(view, adapter, undefined);
      const deactivate = store.activate();
      view.dispatchGridCommand({ type: "grouping.add", columnId: "COL_ID_GROUP" });
      const readyProjection = view.getInstalledClientProjectionSnapshot();
      expect(readyProjection?.kind).toBe("grouped");
      const readyRowId = readyProjection?.rowIds[0];
      expect(readyRowId).toBeDefined();
      const readyAggregateCell = view.getCellSnapshot(readyRowId!, "COL_ID_AMOUNT");
      expect(readyAggregateCell).toMatchObject({
        kind: "available",
        value: { minorUnits: 1n },
      });

      rejectedOperation = "divide";
      const rejectedRows: readonly Row[] = [
        readyRows[0]!,
        { id: "two", group: "A", amount: { minorUnits: 4n }, note: "second" },
      ];
      adapter.reconcile(source(rejectedRows, 2, status), (row: Row) => row.id, columns);
      adapter.publishProjectionInput(columns, adapter.getQueryConfiguration(columns));

      const retainedProjection = view.getInstalledClientProjectionSnapshot();
      expect(retainedProjection).toMatchObject({
        kind: "grouped",
        rowIds: [readyRowId],
      });
      expect(retainedProjection?.columns).toBe(readyProjection?.columns);
      expect(retainedProjection?.presentationKey).toBe(readyProjection?.presentationKey);
      expect(retainedProjection?.queryGeneration).toBe(readyProjection?.queryGeneration);
      expect(view.getChromeSnapshot()).toMatchObject({
        status,
        message: `${status} candidate failed`,
        hasCoherentRows: true,
        invalid: {
          kind: "invalid-group",
          columnId: "COL_ID_AMOUNT",
          message: "Aggregate Algebra operation threw.",
        },
      });
      expect(view.getCellSnapshot(readyRowId!, "COL_ID_AMOUNT").value).toBe(
        readyAggregateCell.value,
      );
      expect(readyAggregateCell).toMatchObject({
        kind: "available",
        value: { minorUnits: 1n },
      });

      rejectedOperation = undefined;
      const recoveredRows: readonly Row[] = [
        readyRows[0]!,
        { id: "two", group: "A", amount: { minorUnits: 5n }, note: "second" },
      ];
      adapter.reconcile(source(recoveredRows, 3, "ready"), (row: Row) => row.id, columns);
      adapter.publishProjectionInput(columns, adapter.getQueryConfiguration(columns));

      expect(view.getInstalledClientProjectionSnapshot()?.kind).toBe("grouped");
      expect(view.getCellSnapshot(readyRowId!, "COL_ID_AMOUNT")).toMatchObject({
        kind: "available",
        value: { minorUnits: 3n },
      });
      expect(view.getChromeSnapshot()).toMatchObject({ status: "ready", hasCoherentRows: true });

      const installedStructure = view.getInstalledGroupingStructureSnapshot();
      const structureNotifications = vi.fn();
      const unsubscribeStructure = view.subscribeInstalledGroupingStructure(structureNotifications);
      rejectedOperation = "divide";
      adapter.reconcile(source(rejectedRows, 4, "ready"), (row: Row) => row.id, columns);
      adapter.publishProjectionInput(columns, adapter.getQueryConfiguration(columns));
      expect(view.getInstalledClientProjectionSnapshot()).toMatchObject({
        kind: "invalid",
        rowIds: [],
        invalid: {
          kind: "invalid-group",
          columnId: "COL_ID_AMOUNT",
          message: "Aggregate Algebra operation threw.",
        },
      });
      expect(view.getChromeSnapshot().status).toBe("ready");
      expect(
        view.getInstalledClientProjectionSnapshot()?.columns.map(({ columnId }) => columnId),
      ).toEqual(["COL_ID_GROUP", "COL_ID_BRUNO_TABLE_ROWS", "COL_ID_AMOUNT"]);
      const invalidStructure = view.getInstalledGroupingStructureSnapshot();
      expect(invalidStructure).not.toBe(installedStructure);
      expect(invalidStructure.columns).toBe(installedStructure.columns);
      expect(structureNotifications).toHaveBeenCalledOnce();
      structureNotifications.mockClear();

      expect(
        view.dispatchGridCommand({
          type: "column.visibility.commit",
          columnId: "COL_ID_DORMANT",
          visible: false,
        }),
      ).toBe(true);
      expect(view.getInstalledGroupingStructureSnapshot()).toBe(invalidStructure);
      expect(structureNotifications).not.toHaveBeenCalled();

      adapter.reconcile(source(rejectedRows, 5, "ready"), (row: Row) => row.id, columns);
      adapter.publishProjectionInput(columns, adapter.getQueryConfiguration(columns));
      expect(view.getInstalledGroupingStructureSnapshot()).toBe(invalidStructure);
      expect(structureNotifications).not.toHaveBeenCalled();

      rejectedOperation = undefined;
      adapter.reconcile(source(recoveredRows, 6, "ready"), (row: Row) => row.id, columns);
      adapter.publishProjectionInput(columns, adapter.getQueryConfiguration(columns));
      expect(view.getInstalledClientProjectionSnapshot()?.kind).toBe("grouped");

      rejectedOperation = "add";
      adapter.reconcile(source(rejectedRows, 7, "ready"), (row: Row) => row.id, columns);
      adapter.publishProjectionInput(columns, adapter.getQueryConfiguration(columns));
      expect(view.getInstalledClientProjectionSnapshot()).toMatchObject({
        kind: "invalid",
        rowIds: [],
        invalid: {
          kind: "invalid-value",
          rowIndex: 1,
          columnId: "COL_ID_AMOUNT",
          message: "Aggregate Algebra operation threw.",
        },
      });
      expect(view.getChromeSnapshot().status).toBe("ready");

      rejectedOperation = undefined;
      adapter.reconcile(source(recoveredRows, 8, "ready"), (row: Row) => row.id, columns);
      adapter.publishProjectionInput(columns, adapter.getQueryConfiguration(columns));
      expect(view.getInstalledClientProjectionSnapshot()?.kind).toBe("grouped");
      expect(view.getCellSnapshot(readyRowId!, "COL_ID_AMOUNT")).toMatchObject({
        kind: "available",
        value: { minorUnits: 3n },
      });
      unsubscribeStructure();
      deactivate();
    },
  );

  it("reuses the exact logical and presentation plan across real value-only publications", () => {
    const groupKeyValueFormatter = vi.fn(({ value }: { readonly value: string }) => value);
    const aggregateValueFormatter = vi.fn(({ value }: { readonly value: bigint }) => String(value));
    const columns = compileColumns([
      {
        columnId: "COL_ID_GROUP",
        field: "group",
        headerName: "Group",
        valueType: "text",
        groupBy: true,
        groupKeyValueFormatter,
      },
      {
        columnId: "COL_ID_VALUE",
        field: "value",
        headerName: "Value",
        valueType: "bigint",
        aggFunc: "sum",
        aggregateValueFormatter,
      },
    ]);
    type Row = Readonly<{ id: string; group: string; value: bigint }>;
    const source = (value: bigint, version: number) => ({
      rows: [{ id: "one", group: "A", value }],
      totalRows: 1,
      version,
      status: "ready" as const,
    });
    const adapter = new BrunoTableClientRowPipelineAdapter(
      source(1n, 1),
      (row: Row) => row.id,
      columns,
      undefined,
      [{ columnId: "COL_ID_VALUE", direction: "asc" }],
    );
    const runtime = new BrunoTableGridRuntime(
      adapter.getPublication(),
      columns,
      adapter.getQueryConfiguration(columns),
      "TABLE_ID_STABLE_PROJECTION_PLAN",
      { grouping: true },
    );
    const view = runtime.getView();
    const planCompiler = new BrunoTableClientProjectionPlanCompiler();
    const store = new BrunoTableClientProjectionStore(view, adapter, undefined, planCompiler);
    const deactivate = store.activate();
    view.dispatchGridCommand({
      type: "column.resize.commit",
      columnId: "COL_ID_GROUP",
      width: 180,
    });
    view.dispatchGridCommand({
      type: "column.pin.commit",
      columnId: "COL_ID_VALUE",
      pinned: "start",
    });
    view.dispatchGridCommand({ type: "grouping.add", columnId: "COL_ID_GROUP" });
    const installed = view.getInstalledClientProjectionSnapshot();
    expect(installed?.kind).toBe("grouped");
    if (installed === undefined) {
      throw new Error("Expected an installed grouped Client projection.");
    }
    const initialCompilations = planCompiler.getCompilationDiagnosticSnapshot();

    for (const [value, version] of [
      [2n, 2],
      [3n, 3],
    ] as const) {
      adapter.publish(source(value, version));
      adapter.publishProjectionInput(columns, adapter.getQueryConfiguration(columns));
      const next = view.getInstalledClientProjectionSnapshot();
      expect(next?.columns).toBe(installed.columns);
      expect(next?.columns.map((column) => column.valueFormatter)).toEqual(
        installed.columns.map((column) => column.valueFormatter),
      );
      expect(planCompiler.getCompilationDiagnosticSnapshot()).toEqual(initialCompilations);
    }
    deactivate();
  });

  it("derives and installs one candidate for one column-configuration transition", () => {
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
    type Row = Readonly<{ id: string; group: string; value: bigint }>;
    const adapter = new BrunoTableClientRowPipelineAdapter(
      { rows: [{ id: "one", group: "A", value: 1n }], totalRows: 1, version: 1, status: "ready" },
      (row: Row) => row.id,
      columns,
      undefined,
      [{ columnId: "COL_ID_VALUE", direction: "asc" }],
    );
    const runtime = new BrunoTableGridRuntime(
      adapter.getPublication(),
      columns,
      adapter.getQueryConfiguration(columns),
      "TABLE_ID_ONE_PROJECTION_TRANSITION",
      { grouping: true },
    );
    const view = runtime.getView();
    const store = new BrunoTableClientProjectionStore(view, adapter, undefined);
    const deactivate = store.activate();
    view.dispatchGridCommand({ type: "grouping.add", columnId: "COL_ID_GROUP" });
    const projectGroupedRows = vi.spyOn(adapter, "projectGroupedRows");
    const queryNotifications = vi.fn();
    const columnNotifications = vi.fn();
    view.subscribeQuery(queryNotifications);
    view.subscribeColumnStructure(columnNotifications);
    const replacementColumns = compileColumns([
      {
        columnId: "COL_ID_GROUP",
        field: "group",
        headerName: "Renamed Group",
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

    adapter.publishProjectionInput(
      replacementColumns,
      adapter.getQueryConfiguration(replacementColumns),
    );

    expect(projectGroupedRows).toHaveBeenCalledOnce();
    expect(queryNotifications).toHaveBeenCalledOnce();
    expect(columnNotifications).not.toHaveBeenCalled();
    expect(view.getInstalledClientProjectionSnapshot()?.columns[0]?.headerName).toBe(
      "Renamed Group",
    );
    deactivate();
  });

  it("does not execute dormant ordinary sorting while deriving grouped source rows", () => {
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
      {
        columnId: "COL_ID_DORMANT_SORT",
        field: "rank",
        headerName: "Dormant sort",
        valueType: "number",
      },
    ]);
    type Row = Readonly<{ id: string; group: string; value: bigint; rank: number }>;
    const rows = ["one", "two"].map(
      (id) =>
        Object.defineProperty({ id, group: "A", value: 1n }, "rank", {
          enumerable: true,
          get: () => {
            throw new TypeError("Dormant ordinary sort was evaluated.");
          },
        }) as Row,
    );
    const adapter = new BrunoTableClientRowPipelineAdapter(
      { rows, totalRows: 2, version: 1, status: "ready" },
      (candidate: Row) => candidate.id,
      columns,
      undefined,
      [{ columnId: "COL_ID_DORMANT_SORT", direction: "asc" }],
    );
    const projectionInput = adapter.getProjectionInputSnapshot();
    const filterCollection = compileClientFilterCollection([], columns);
    const rowModel = deriveClientProjectionRowModel(projectionInput.rows, {
      columns,
      columnLayout: getBrunoTableColumnLayoutSnapshot(createBrunoTableColumnLayout(columns)),
      filters: filterCollection.filters,
      filterCollection,
      quickFilter: "",
      quickFilterFields: [],
      orderBy: [{ columnId: "COL_ID_DORMANT_SORT", direction: "asc" }],
      groupBy: ["COL_ID_GROUP"],
      groupOrderBy: [{ columnId: "COL_ID_GROUP", direction: "asc" }],
      queryGeneration: 1,
      queryNavigationMode: "projection-reset",
    });

    expect(rowModel.kind).toBe("ready");
    if (rowModel.kind === "ready") expect(rowModel.rowIds).toEqual(["one", "two"]);
  });

  it("retains a hidden eligible key in the full logical projection authority", () => {
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
    type Row = Readonly<{ id: string; group: string; value: bigint }>;
    const row: Row = { id: "one", group: "A", value: 1n };
    const adapter = new BrunoTableClientRowPipelineAdapter(
      { rows: [row], totalRows: 1, version: 1, status: "ready" },
      (candidate: Row) => candidate.id,
      columns,
      undefined,
      [{ columnId: "COL_ID_VALUE", direction: "asc" }],
    );
    const layout = applyBrunoTableGridCommand(createBrunoTableColumnLayout(columns), {
      type: "column.visibility.commit",
      columnId: "COL_ID_GROUP",
      visible: false,
    });
    const filterCollection = compileClientFilterCollection([], columns);
    const rowModel = deriveClientProjectionRowModel(adapter.getProjectionInputSnapshot().rows, {
      columns,
      columnLayout: getBrunoTableColumnLayoutSnapshot(layout),
      filters: filterCollection.filters,
      filterCollection,
      quickFilter: "",
      quickFilterFields: [],
      orderBy: [{ columnId: "COL_ID_VALUE", direction: "asc" }],
      groupBy: ["COL_ID_GROUP"],
      groupOrderBy: [{ columnId: "COL_ID_GROUP", direction: "asc" }],
      queryGeneration: 1,
      queryNavigationMode: "projection-reset",
    });

    expect(rowModel.kind).toBe("ready");
    if (rowModel.kind !== "ready") return;
    expect(rowModel.columns.map((column) => column.columnId)).toEqual([
      "COL_ID_GROUP",
      "COL_ID_VALUE",
    ]);
    expect(rowModel.visibleColumns.map((column) => column.columnId)).toEqual(["COL_ID_VALUE"]);
  });
});
