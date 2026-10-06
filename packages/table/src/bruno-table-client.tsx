import {
  memo,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { ReactNode } from "react";

import type {
  BrunoTableClientProps,
  BrunoTableColumns,
  BrunoTableEditableClientProps,
  BrunoTableEditRowPatch,
  BrunoTableEditRowProjector,
  BrunoTableJsonValue,
  BrunoTableReadOnlyClientProps,
  BrunoTableSortBy,
} from "./public-types";
import {
  BrunoTableToolbar,
  BrunoTableToolbarStore,
  BrunoTableView,
} from "./internal/bruno-table-view";
import {
  BrunoTableClientProjectionStore,
  BrunoTableClientRowPipeline,
} from "./internal/client-row-pipeline";
import {
  BrunoTableClientFilterProvider,
  BrunoTableActiveFilters,
  BrunoTableQuickFilter,
  renderBrunoTableClientColumnFilter,
} from "./internal/client-filter-controls";
import { BrunoTableClientRowPipelineAdapter } from "./internal/client-source-adapter";
import { compileColumns } from "./internal/compile-columns";
import { BrunoTableGridRuntime, isBrunoTableInvalidCellValue } from "./internal/grid-runtime";
import { registerBrunoTableIdentity } from "./internal/table-identity-registry";
import {
  BrunoTableActiveFilterCount,
  BrunoTableActiveSortCount,
  BrunoTableFilterControl,
  BrunoTableLoadedRowCount,
  BrunoTableResultRowCount,
  BrunoTableToolbarProvider,
  BrunoTableToolbarSpacer,
} from "./internal/toolbar-capabilities";
import { recordBrunoTableToolbarLifetime } from "./internal/toolbar-instrumentation";
import { recordBrunoTableReviewCellSubscription } from "./internal/grid-subscription-instrumentation";
import { BrunoTableRowSelectionRuntime } from "./internal/row-selection";
import { BrunoTableCellRangeRuntime } from "./internal/cell-range-clipboard";
import {
  BrunoTableCellEditRuntime,
  type BrunoTableCellEditDraftReviewSourceRow,
  type BrunoTableCellEditRowProjector,
} from "./internal/cell-edit";
import { brunoTableCellPresentationUsesRawRow } from "./internal/cell-presentation";
import {
  BrunoTableConflictReviewResolution,
  BrunoTableEditModeControl,
} from "./internal/edit-chrome";
import { BrunoTableEditMemoryRuntime } from "./internal/edit-memory";
import {
  adaptBrunoTableSaveHandler,
  BrunoTableSaveOperationRuntime,
} from "./internal/save-operations";
import { compileBrunoTableGroupRowsColumn } from "./internal/client-grouping-presentation";
import { BrunoTableClientGroupBy } from "./internal/client-grouping-controls";
import { reconcileBrunoTableClientEditSourcePublication } from "./internal/client-edit-source";
import { createBrunoTableClientEditCapability } from "./internal/client-edit-capability";

function adaptBrunoTableRowVersionExtractor<TRow>(
  extractor: ((row: TRow) => unknown) | undefined,
): ((row: object) => unknown) | undefined {
  return extractor === undefined ? undefined : (row) => extractor(row as TRow);
}

function adaptBrunoTableEditRowProjector<
  TRow,
  TColumns extends BrunoTableColumns<TRow>,
  TRowVersion,
>(
  projector: BrunoTableEditRowProjector<TRow, TColumns, TRowVersion> | undefined,
): BrunoTableCellEditRowProjector | undefined {
  return projector === undefined
    ? undefined
    : ({ row, patch, rowVersion }) =>
        projector({
          row: row as TRow,
          patch: patch as BrunoTableEditRowPatch<TRow, TColumns>,
          rowVersion: rowVersion as TRowVersion,
        });
}

export {
  BrunoTableActiveFilterCount,
  BrunoTableActiveSortCount,
  BrunoTableFilterControl,
  BrunoTableLoadedRowCount,
  BrunoTableQuickFilter,
  BrunoTableResultRowCount,
  BrunoTableToolbar,
  BrunoTableToolbarSpacer,
};
export type {
  BrunoTableFilterControlProps,
  BrunoTableGridFilterCommandCapability,
} from "./internal/toolbar-capabilities";

export function BrunoTableClient<
  TRow,
  const TColumns extends BrunoTableColumns<TRow>,
  TGetRowVersion extends (row: TRow) => unknown,
>(props: BrunoTableEditableClientProps<TRow, TColumns, TGetRowVersion>): ReactNode;
export function BrunoTableClient<TRow, const TColumns extends BrunoTableColumns<TRow>, TRowVersion>(
  props: BrunoTableClientProps<TRow, TColumns, TRowVersion>,
): ReactNode;
export function BrunoTableClient<TRow, const TColumns extends BrunoTableColumns<TRow>>(
  props: BrunoTableReadOnlyClientProps<TRow, TColumns>,
): ReactNode;
export function BrunoTableClient<TRow, const TColumns extends BrunoTableColumns<TRow>, TRowVersion>(
  props: BrunoTableClientProps<TRow, TColumns, TRowVersion>,
): ReactNode {
  const tableId = requireBrunoTableId(props.tableId);
  return (
    <BrunoTableClientInstance
      key={`${tableId}:${props.editable === true ? "editable" : "readonly"}`}
      props={props}
      tableId={tableId}
    />
  );
}

function BrunoTableClientInstance<
  TRow,
  const TColumns extends BrunoTableColumns<TRow>,
  TRowVersion,
>({
  gridAriaLabel,
  props,
  registerIdentity = true,
  reviewRowSelection,
  tableId,
}: Readonly<{
  readonly gridAriaLabel?: string;
  readonly props: BrunoTableClientProps<TRow, TColumns, TRowVersion>;
  readonly registerIdentity?: boolean;
  readonly reviewRowSelection?: BrunoTableRowSelectionRuntime;
  readonly tableId: string;
}>): ReactNode {
  const compiledColumns = useMemo(() => compileColumns(props.columns), [props.columns]);
  const editable = props.editable === true;
  const getRowId = props.getRowId;
  const onSaveEdits = props.onSaveEdits;
  const projectEditRow = props.projectEditRow;
  if (editable && typeof props.getRowVersion !== "function") {
    throw new TypeError("BrunoTable editable Client Tables require getRowVersion.");
  }
  if (editable && typeof onSaveEdits !== "function") {
    throw new TypeError("BrunoTable editable Client Tables require onSaveEdits.");
  }
  if (
    editable &&
    !compiledColumns.some(
      (column) =>
        column.kind === "field" && column.isEditable !== undefined && column.isEditable !== false,
    )
  ) {
    throw new TypeError(
      "BrunoTable editable Client Tables require at least one potentially editable column.",
    );
  }
  if (
    editable &&
    typeof projectEditRow !== "function" &&
    compiledColumns.some(
      (column) =>
        column.kind === "field" &&
        column.isEditable !== undefined &&
        column.isEditable !== false &&
        brunoTableCellPresentationUsesRawRow(column),
    )
  ) {
    throw new TypeError(
      "BrunoTable editable Client Tables with row-aware presentation require projectEditRow.",
    );
  }
  const editRowProjector = useMemo(
    () => adaptBrunoTableEditRowProjector(projectEditRow),
    [projectEditRow],
  );
  const projectedRowId = useMemo(
    () => (editRowProjector === undefined ? undefined : (row: object) => getRowId(row as TRow)),
    [editRowProjector, getRowId],
  );
  const normalizedGroupRowsColumn = useMemo(
    () => compileBrunoTableGroupRowsColumn(editable ? undefined : props.groupRowsColumn),
    [editable, props.groupRowsColumn],
  );
  const {
    cellClassName: groupRowsCellClassName,
    cellRenderer: groupRowsCellRenderer,
    headerName: groupRowsHeaderName,
    valueFormatter: groupRowsValueFormatter,
    width: groupRowsWidth,
  } = normalizedGroupRowsColumn;
  const groupRowsColumn = useMemo(
    () =>
      Object.freeze({
        headerName: groupRowsHeaderName,
        width: groupRowsWidth,
        ...(groupRowsValueFormatter === undefined
          ? {}
          : { valueFormatter: groupRowsValueFormatter }),
        ...(groupRowsCellRenderer === undefined ? {} : { cellRenderer: groupRowsCellRenderer }),
        ...(groupRowsCellClassName === undefined ? {} : { cellClassName: groupRowsCellClassName }),
      }),
    [
      groupRowsCellClassName,
      groupRowsCellRenderer,
      groupRowsHeaderName,
      groupRowsValueFormatter,
      groupRowsWidth,
    ],
  );
  const [ownedRowSelectionRuntime] = useState(() => new BrunoTableRowSelectionRuntime([]));
  const rowSelectionRuntime = reviewRowSelection ?? ownedRowSelectionRuntime;
  const rowSelectionEnabled = props.rowSelection === true;
  const rowSelection = rowSelectionEnabled ? rowSelectionRuntime : undefined;
  const previousRowSelectionEnabled = useRef(rowSelectionEnabled);
  const [cellRange] = useState(() => new BrunoTableCellRangeRuntime(tableId));
  const [rowPipelineAdapter] = useState(
    () =>
      new BrunoTableClientRowPipelineAdapter(
        props.clientSource,
        props.getRowId,
        compiledColumns,
        props.initialFilters,
        props.initialOrderBy,
        props.quickFilterFields,
        groupRowsColumn,
      ),
  );
  const [runtime] = useState(() => {
    const created = new BrunoTableGridRuntime(
      rowPipelineAdapter.getPublication(),
      compiledColumns,
      rowPipelineAdapter.getQueryConfiguration(compiledColumns),
      tableId,
      {
        initialPersistedState: props.initialPersistedState,
        grouping: !editable,
        groupRowsWidth: groupRowsColumn.width,
        beforeGroupingChange: (entering) => {
          cellRange.clear();
          if (entering) rowSelectionRuntime.enterGroupedProjection();
        },
      },
    );
    if (__BRUNO_TABLE_TEST_DIAGNOSTICS__) {
      recordBrunoTableToolbarLifetime({
        tableId,
        kind: "runtime-create",
        identity: created,
      });
    }
    return created;
  });
  const [editMemory] = useState(() => (editable ? new BrunoTableEditMemoryRuntime() : undefined));
  const [cellEdit] = useState(() =>
    editable
      ? new BrunoTableCellEditRuntime({
          columns: compiledColumns,
          getRow: rowPipelineAdapter.getAuthoritativeEditRowSnapshot,
          getCanonicalValue: (rowId, columnId) => {
            const snapshot = rowPipelineAdapter.getAuthoritativeEditCellSnapshot(rowId, columnId);
            return snapshot.found && !isBrunoTableInvalidCellValue(snapshot.value)
              ? Object.freeze({ _tag: "Success" as const, value: snapshot.value })
              : Object.freeze({ _tag: "Failure" as const });
          },
          ...(props.getRowVersion === undefined
            ? {}
            : { getRowVersion: adaptBrunoTableRowVersionExtractor(props.getRowVersion)! }),
          ...(editRowProjector === undefined || projectedRowId === undefined
            ? {}
            : { projectEditRow: editRowProjector, getRowId: projectedRowId }),
          isSourceAuthoritative: rowPipelineAdapter.hasAuthoritativeEditSource,
          ...(editMemory === undefined
            ? {}
            : {
                onCommit: (change) => editMemory.requestImmediateSave([change]),
                onCommitGesture: (changes) => editMemory.requestImmediateSave(changes),
              }),
          incrementalTraversal: true,
        })
      : undefined,
  );
  const [saveOperations] = useState(() =>
    cellEdit === undefined || editMemory === undefined
      ? undefined
      : new BrunoTableSaveOperationRuntime(cellEdit, editMemory),
  );
  const renderResetReview = useCallback(
    (reviewRows: readonly BrunoTableCellEditDraftReviewSourceRow[]) => (
      <BrunoTableResetReviewTable reviewRows={reviewRows} />
    ),
    [],
  );
  const renderConflictReview = useMemo(() => {
    if (editMemory === undefined) return undefined;
    return (
      reviewRows: readonly BrunoTableCellEditDraftReviewSourceRow[],
      selection: BrunoTableRowSelectionRuntime,
      resolve: (id: string, resolution: "mine" | "server") => void,
    ) => (
      <BrunoTableConflictReviewTable
        rows={reviewRows}
        selection={selection}
        runtime={editMemory}
        resolve={resolve}
      />
    );
  }, [editMemory]);
  const renderBlockedReview = useMemo(() => {
    if (editMemory === undefined) return undefined;
    return (
      reviewRows: readonly BrunoTableCellEditDraftReviewSourceRow[],
      selection: BrunoTableRowSelectionRuntime,
    ) => <BrunoTableBlockedReviewTable rows={reviewRows} selection={selection} />;
  }, [editMemory]);
  const editCapability = useMemo(
    () =>
      cellEdit === undefined || editMemory === undefined
        ? undefined
        : createBrunoTableClientEditCapability({
            cellEdit,
            editMemory,
            renderResetReview,
            ...(renderConflictReview === undefined ? {} : { renderConflictReview }),
            ...(renderBlockedReview === undefined ? {} : { renderBlockedReview }),
          }),
    [cellEdit, editMemory, renderBlockedReview, renderConflictReview, renderResetReview],
  );
  const [toolbar] = useState(() => new BrunoTableToolbarStore(props.children));
  const runtimeView = runtime.getView();
  const [projectionStore] = useState(
    () => new BrunoTableClientProjectionStore(runtimeView, rowPipelineAdapter, rowSelection),
  );

  useLayoutEffect(() => {
    projectionStore.setRowSelection(rowSelection);
  }, [projectionStore, rowSelection]);
  useLayoutEffect(() => {
    cellEdit?.setRowVersionExtractor(adaptBrunoTableRowVersionExtractor(props.getRowVersion));
  }, [cellEdit, props.getRowVersion]);
  useLayoutEffect(() => {
    cellEdit?.setEditRowProjector(editRowProjector, projectedRowId);
  }, [cellEdit, editRowProjector, projectedRowId]);
  useLayoutEffect(() => projectionStore.activate(), [projectionStore]);
  useLayoutEffect(() => {
    editMemory?.activate();
    return () => editMemory?.dispose();
  }, [editMemory]);
  useLayoutEffect(() => {
    if (editMemory === undefined || cellEdit === undefined) return;
    return editMemory.connectCellEdit(cellEdit);
  }, [cellEdit, editMemory]);
  useLayoutEffect(() => {
    if (saveOperations === undefined || onSaveEdits === undefined) return;
    return saveOperations.setHandler(adaptBrunoTableSaveHandler(onSaveEdits));
  }, [onSaveEdits, saveOperations]);
  useLayoutEffect(() => {
    if (saveOperations === undefined) return;
    return saveOperations.activate();
  }, [saveOperations]);
  useLayoutEffect(() => {
    if (editMemory === undefined) return;
    return runtime.registerEditCommandHandler((command) => {
      switch (command.type) {
        case "edits.reset":
          return editMemory.openResetReview();
        case "edits.undo":
          return editMemory.undo();
        case "edits.redo":
          return editMemory.redo();
      }
    });
  }, [editMemory, runtime]);
  useLayoutEffect(() => {
    const previouslyEnabled = previousRowSelectionEnabled.current;
    previousRowSelectionEnabled.current = rowSelectionEnabled;
    if (previouslyEnabled && !rowSelectionEnabled) {
      rowSelectionRuntime.enterGroupedProjection();
      return;
    }
    if (!previouslyEnabled && rowSelectionEnabled) {
      const projectionInput = rowPipelineAdapter.getProjectionInputSnapshot();
      if (runtime.getGroupBySnapshot().length === 0) {
        rowSelectionRuntime.leaveGroupedProjection(
          projectionInput.sourceRowIds.authoritative ? projectionInput.sourceRowIds.rowIds : [],
        );
      }
    }
  }, [rowPipelineAdapter, rowSelectionEnabled, rowSelectionRuntime, runtime]);
  const gridOwnedControls = useMemo(
    () => (
      <>
        {editable ? (
          editMemory === undefined ? null : (
            <BrunoTableEditModeControl runtime={editMemory} />
          )
        ) : (
          <BrunoTableClientGroupBy columns={compiledColumns} runtime={runtimeView} />
        )}
        <BrunoTableActiveFilters />
      </>
    ),
    [compiledColumns, editable, editMemory, runtimeView],
  );

  const reconcilePublishedEditSource = useCallback(
    (changedRowIds: ReadonlySet<string> | undefined): void => {
      if (rowPipelineAdapter.hasAuthoritativeEditSource()) {
        cellEdit?.reconcileColumns(compiledColumns, (rowId) =>
          rowPipelineAdapter.getAuthoritativeEditRowSnapshot(rowId),
        );
        cellEdit?.reconcileTraversalRows(changedRowIds);
      }
      reconcileBrunoTableClientEditSourcePublication(
        rowPipelineAdapter,
        editMemory,
        cellEdit,
        changedRowIds,
      );
    },
    [cellEdit, compiledColumns, editMemory, rowPipelineAdapter],
  );

  useLayoutEffect(() => {
    const unsubscribe = rowPipelineAdapter.subscribeEditSource(reconcilePublishedEditSource);
    if (rowPipelineAdapter.isEditSourceConfiguredFor(compiledColumns)) {
      reconcilePublishedEditSource(rowPipelineAdapter.getEditSourceChangedRowIds());
    }
    return unsubscribe;
  }, [compiledColumns, reconcilePublishedEditSource, rowPipelineAdapter]);

  useLayoutEffect(() => {
    const publication = rowPipelineAdapter.reconcile(
      props.clientSource,
      props.getRowId,
      compiledColumns,
      groupRowsColumn,
    );
    const queryConfiguration = rowPipelineAdapter.getQueryConfiguration(compiledColumns);
    const installedProjection = runtime.getInstalledClientProjectionSnapshot();
    const groupingProjectionActive =
      runtime.getQuerySnapshot().groupBy.length > 0 ||
      installedProjection?.kind === "grouped" ||
      installedProjection?.kind === "invalid";
    rowPipelineAdapter.publishProjectionInput(
      compiledColumns,
      queryConfiguration,
      groupingProjectionActive,
    );
    editMemory?.setSavePreflightAvailable(rowPipelineAdapter.hasAuthoritativeEditSource());
    if (!groupingProjectionActive) {
      runtime.reconcile(publication, compiledColumns, queryConfiguration, groupRowsColumn.width);
    }
  }, [
    cellEdit,
    compiledColumns,
    editMemory,
    groupRowsColumn,
    props.clientSource,
    props.getRowId,
    rowPipelineAdapter,
    runtime,
  ]);

  useLayoutEffect(() => {
    runtime.setOnPersistChange(
      props.onPersistChange as
        | ((state: Readonly<Record<string, BrunoTableJsonValue>>) => void)
        | undefined,
    );
  }, [props.onPersistChange, runtime]);

  useLayoutEffect(() => {
    toolbar.publish(props.children);
  }, [props.children, toolbar]);

  useLayoutEffect(
    () =>
      __BRUNO_TABLE_DEVELOPMENT__ && registerIdentity
        ? registerBrunoTableIdentity(tableId, compiledColumns)
        : undefined,
    [compiledColumns, registerIdentity, tableId],
  );

  useLayoutEffect(() => () => cellRange.dispose(), [cellRange]);
  useLayoutEffect(() => {
    cellEdit?.activate();
    return () => cellEdit?.dispose();
  }, [cellEdit]);
  return (
    <BrunoTableClientFilterProvider facetRows={rowPipelineAdapter} runtime={runtimeView}>
      <BrunoTableToolbarProvider
        columns={compiledColumns}
        resultRows={rowPipelineAdapter}
        runtime={runtimeView}
        tableId={tableId}
      >
        <BrunoTableView
          runtime={runtimeView}
          tableId={tableId}
          {...(gridAriaLabel === undefined ? {} : { gridAriaLabel })}
          compiledColumns={compiledColumns}
          toolbar={toolbar}
          rowPipeline={BrunoTableClientRowPipeline}
          rowPipelineAdapter={rowPipelineAdapter}
          rowSelection={rowSelection}
          cellRange={reviewRowSelection === undefined ? cellRange : undefined}
          editCapability={editCapability}
          renderColumnFilter={renderBrunoTableClientColumnFilter}
          gridOwnedControls={gridOwnedControls}
        />
      </BrunoTableToolbarProvider>
    </BrunoTableClientFilterProvider>
  );
}

type BrunoTableEditReviewDisplayRow = BrunoTableCellEditDraftReviewSourceRow;

const BrunoTableEditReviewStatus = memo(function BrunoTableEditReviewStatus({
  row,
  tableId,
  columnId,
}: Readonly<{
  readonly row: BrunoTableEditReviewDisplayRow;
  readonly tableId?: string;
  readonly columnId?: string;
}>): ReactNode {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (__BRUNO_TABLE_TEST_DIAGNOSTICS__ && tableId !== undefined && columnId !== undefined) {
        recordBrunoTableReviewCellSubscription({
          tableId,
          rowId: row.id,
          columnId,
          source: "review-status",
          phase: "subscribe",
        });
      }
      const unsubscribe = row.subscribe(listener);
      return () => {
        unsubscribe();
        if (__BRUNO_TABLE_TEST_DIAGNOSTICS__ && tableId !== undefined && columnId !== undefined) {
          recordBrunoTableReviewCellSubscription({
            tableId,
            rowId: row.id,
            columnId,
            source: "review-status",
            phase: "unsubscribe",
          });
        }
      };
    },
    [columnId, row, tableId],
  );
  const getSnapshot = useCallback(() => row.getSnapshot().status, [row]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
});

function createBrunoTableResetReviewColumns(tableId: string) {
  return [
    {
      columnId: "COL_ID_ROW",
      field: "rowId",
      headerName: "Row",
      valueType: "text",
      pinned: "start",
    },
    {
      columnId: "COL_ID_COLUMN",
      field: "columnLabel",
      headerName: "Column",
      valueType: "text",
      pinned: "start",
    },
    {
      columnId: "COL_ID_SERVER_NOW",
      field: "serverText",
      headerName: "Server now",
      valueType: "text",
      enableSorting: false,
      enableFilter: false,
    },
    {
      columnId: "COL_ID_YOURS",
      field: "mineText",
      headerName: "Yours",
      valueType: "text",
      enableSorting: false,
      enableFilter: false,
    },
    {
      columnId: "COL_ID_STATUS",
      field: "statusText",
      headerName: "Status",
      valueType: "text",
      enableSorting: false,
      enableFilter: false,
      cellRenderer: ({ row }: { readonly row: BrunoTableEditReviewDisplayRow }) => (
        <BrunoTableEditReviewStatus row={row} tableId={tableId} columnId="COL_ID_STATUS" />
      ),
    },
  ] satisfies BrunoTableColumns<BrunoTableEditReviewDisplayRow>;
}
const BRUNO_TABLE_RESET_REVIEW_INITIAL_ORDER_BY = [
  { columnId: "COL_ID_ROW", direction: "asc" },
] as const satisfies BrunoTableSortBy<ReturnType<typeof createBrunoTableResetReviewColumns>>;
const getBrunoTableEditReviewRowId = (row: BrunoTableEditReviewDisplayRow): string => row.id;

function BrunoTableResetReviewTable({
  reviewRows,
}: Readonly<{
  readonly reviewRows: readonly BrunoTableCellEditDraftReviewSourceRow[];
}>): ReactNode {
  const instanceId = useId();
  const tableId = `BRUNO_TABLE_INTERNAL_RESET_REVIEW_${instanceId}`;
  const columns = useMemo(() => createBrunoTableResetReviewColumns(tableId), [tableId]);
  const rows = reviewRows;
  if (rows.length === 0) {
    return <p role="status">All changes now match the server.</p>;
  }
  return (
    <BrunoTableClientInstance
      gridAriaLabel="Reset Review changes"
      tableId={tableId}
      registerIdentity={false}
      props={{
        tableId,
        columns,
        initialOrderBy: BRUNO_TABLE_RESET_REVIEW_INITIAL_ORDER_BY,
        clientSource: {
          rows,
          totalRows: rows.length,
          version: rows.length,
          status: "ready",
        },
        getRowId: getBrunoTableEditReviewRowId,
      }}
    />
  );
}

function BrunoTableConflictReviewTable({
  rows,
  runtime,
  selection,
  resolve,
}: Readonly<{
  readonly rows: readonly BrunoTableCellEditDraftReviewSourceRow[];
  readonly runtime: BrunoTableEditMemoryRuntime;
  readonly selection: BrunoTableRowSelectionRuntime;
  readonly resolve: (id: string, resolution: "mine" | "server") => void;
}>): ReactNode {
  const instanceId = useId();
  const tableId = `BRUNO_TABLE_INTERNAL_CONFLICT_REVIEW_${instanceId}`;
  const columns = useMemo(
    () =>
      [
        {
          columnId: "COL_ID_ROW",
          field: "rowId",
          headerName: "Row",
          valueType: "text",
          pinned: "start",
        },
        {
          columnId: "COL_ID_COLUMN",
          field: "columnLabel",
          headerName: "Column",
          valueType: "text",
          pinned: "start",
        },
        {
          columnId: "COL_ID_BASE",
          field: "baseText",
          headerName: "Base",
          valueType: "text",
          enableSorting: false,
          enableFilter: false,
        },
        {
          columnId: "COL_ID_SERVER_NOW",
          field: "serverText",
          headerName: "Server now",
          valueType: "text",
          enableSorting: false,
          enableFilter: false,
        },
        {
          columnId: "COL_ID_YOURS",
          field: "mineText",
          headerName: "Yours",
          valueType: "text",
          enableSorting: false,
          enableFilter: false,
        },
        {
          columnId: "COL_ID_RESOLUTION",
          field: "resolutionText",
          headerName: "Resolution",
          valueType: "text",
          pinned: "end",
          enableSorting: false,
          enableFilter: false,
          cellRenderer: ({ row }: { readonly row: BrunoTableCellEditDraftReviewSourceRow }) => (
            <BrunoTableConflictReviewResolution
              row={row}
              runtime={runtime}
              resolve={resolve}
              tableId={tableId}
              columnId="COL_ID_RESOLUTION"
            />
          ),
        },
      ] satisfies BrunoTableColumns<BrunoTableCellEditDraftReviewSourceRow>,
    [resolve, runtime, tableId],
  );
  const initialOrderBy = useMemo(() => [{ columnId: "COL_ID_ROW", direction: "asc" }] as const, []);
  if (rows.length === 0) return <p role="status">All conflicts are current.</p>;
  return (
    <BrunoTableClientInstance
      gridAriaLabel="Conflict Review changes"
      tableId={tableId}
      registerIdentity={false}
      reviewRowSelection={selection}
      props={{
        tableId,
        columns,
        initialOrderBy,
        clientSource: {
          rows,
          totalRows: rows.length,
          version: rows.reduce((version, row) => version + row.getSnapshot().reviewVersion, 0),
          status: "ready",
        },
        getRowId: getBrunoTableEditReviewRowId,
        rowSelection: true,
      }}
    />
  );
}

function BrunoTableBlockedReviewTable({
  rows,
  selection,
}: Readonly<{
  readonly rows: readonly BrunoTableCellEditDraftReviewSourceRow[];
  readonly selection: BrunoTableRowSelectionRuntime;
}>): ReactNode {
  const instanceId = useId();
  const tableId = `BRUNO_TABLE_INTERNAL_BLOCKED_REVIEW_${instanceId}`;
  const columns = useMemo(
    () =>
      [
        {
          columnId: "COL_ID_ROW",
          field: "rowId",
          headerName: "Row",
          valueType: "text",
          pinned: "start",
        },
        {
          columnId: "COL_ID_COLUMN",
          field: "columnLabel",
          headerName: "Column",
          valueType: "text",
          pinned: "start",
        },
        {
          columnId: "COL_ID_SERVER_NOW",
          field: "serverText",
          headerName: "Server now",
          valueType: "text",
          enableSorting: false,
          enableFilter: false,
        },
        {
          columnId: "COL_ID_MINE",
          field: "mineText",
          headerName: "Mine",
          valueType: "text",
          enableSorting: false,
          enableFilter: false,
        },
        {
          columnId: "COL_ID_REASON",
          field: "statusText",
          headerName: "Reason",
          valueType: "text",
          enableSorting: false,
          enableFilter: false,
          cellRenderer: ({ row }: { readonly row: BrunoTableCellEditDraftReviewSourceRow }) => (
            <BrunoTableEditReviewStatus row={row} tableId={tableId} columnId="COL_ID_REASON" />
          ),
        },
      ] satisfies BrunoTableColumns<BrunoTableCellEditDraftReviewSourceRow>,
    [tableId],
  );
  const initialOrderBy = useMemo(() => [{ columnId: "COL_ID_ROW", direction: "asc" }] as const, []);
  if (rows.length === 0) return null;
  return (
    <BrunoTableClientInstance
      gridAriaLabel="Blocked Changes Review changes"
      tableId={tableId}
      registerIdentity={false}
      reviewRowSelection={selection}
      props={{
        tableId,
        columns,
        initialOrderBy,
        clientSource: {
          rows,
          totalRows: rows.length,
          version: rows.reduce((version, row) => version + row.getSnapshot().reviewVersion, 0),
          status: "ready",
        },
        getRowId: getBrunoTableEditReviewRowId,
        rowSelection: true,
      }}
    />
  );
}

function requireBrunoTableId(tableId: unknown): string {
  if (typeof tableId !== "string" || tableId.trim().length === 0) {
    throw new TypeError("BrunoTable tableId must be a non-empty string.");
  }
  return tableId;
}
