import type {
  BrunoTableClientSource,
  BrunoTableRowId,
  BrunoTableSourceStatus,
} from "../public-types";
import type {
  BrunoTableClientProjectionInvalid,
  BrunoTableQuerySnapshot,
  BrunoTableQueryConfiguration,
  BrunoTableRowPipelinePublication,
  BrunoTableRowPipelineRuntimeView,
  BrunoTableRowSpaceSnapshot,
} from "./grid-runtime";
import { createBrunoTableInvalidCellValue, isBrunoTableInvalidCellValue } from "./grid-runtime";
import type { CompiledColumn } from "./compile-columns";
import { readCompiledColumnValue } from "./cell-value";
import type { BrunoTableClientFilterCollection, ClientOrderBy } from "./grid-query";
import {
  compileClientFilterPlan,
  compileClientFilterCollection,
  reconcileClientOrderBy,
  sanitizeClientInitialOrderBy,
} from "./grid-query";
import {
  createClientQueryPredicate,
  readClientQuickFilterField,
  snapshotBrunoTableQuickFilterFields,
} from "./quick-filter";
import {
  snapshotBrunoTableSourceMessage,
  snapshotBrunoTableSourceStatusCode,
} from "./source-lifecycle";
import { recordBrunoTableToolbarLifetime } from "./toolbar-instrumentation";
import type { BrunoTableClientGroupedRow } from "./client-grouping";
import type { BrunoTableCompiledGroupRowsColumn } from "./client-grouping-presentation";

// Keep configuration snapshot work bounded even when a hostile Proxy changes array length.
// The public Quick Filter contract documents this limit alongside its tuple type.

export type BrunoTableClientReconciliationEvent = Readonly<{
  readonly durationMs: number;
  readonly residentRows: number;
  readonly changedRows: number;
  readonly resolvedRowIds: number;
  readonly identityPatches: number;
  readonly rebuiltSourceSequence: boolean;
  readonly rebuiltIdentityIndex: boolean;
}>;

let reconciliationListener: ((event: BrunoTableClientReconciliationEvent) => void) | undefined;
let valueCachePruneListener: ((visitedEntries: number) => void) | undefined;

export function installBrunoTableClientReconciliationListener(
  listener: (event: BrunoTableClientReconciliationEvent) => void,
): () => void {
  reconciliationListener = listener;
  return () => {
    if (reconciliationListener === listener) reconciliationListener = undefined;
  };
}

export function installBrunoTableClientValueCachePruneListener(
  listener: (visitedEntries: number) => void,
): () => void {
  valueCachePruneListener = listener;
  return () => {
    if (valueCachePruneListener === listener) valueCachePruneListener = undefined;
  };
}

export class BrunoTableClientRowPipelineAdapter<TRow> {
  private groupRowsColumn: BrunoTableCompiledGroupRowsColumn | undefined;
  private readonly resultRowCountListeners = new Set<() => void>();
  private readonly projectionInputListeners = new Set<() => void>();
  private readonly editSourceListeners = new Set<
    (changedRowIds: ReadonlySet<BrunoTableRowId> | undefined) => void
  >();
  private resultRowCount = 0;
  private resultRowCountInitialized = false;
  private observedRows: TRow[] | undefined;
  private source: ClientSourceSnapshot<TRow>;
  private getRowId: (row: TRow) => BrunoTableRowId;
  private publication: BrunoTableRowPipelinePublication<TRow>;
  private coherent: ClientCoherentSnapshot<TRow> | undefined;
  private editCoherent: ClientCoherentSnapshot<TRow> | undefined;
  private editSourceStatus: BrunoTableSourceStatus;
  private editSourceVersion: number;
  private editSourceChangedRowIds: ReadonlySet<BrunoTableRowId> | undefined = undefined;
  private acceptedCoherent: ClientCoherentSnapshot<TRow> | undefined;
  private readonly initialFilters: readonly unknown[];
  private readonly initialFilterCollection: BrunoTableClientFilterCollection;
  private readonly initialOrderBy: ClientOrderBy;
  private readonly quickFilterFields: readonly string[];
  private sourceColumns: readonly CompiledColumn[];
  private queryColumns: readonly CompiledColumn[];
  private queryConfiguration: BrunoTableQueryConfiguration;
  private projectionInput: BrunoTableClientProjectionInputSnapshot;
  private projectionInputEpoch = 0;
  private queryFallbackActive = false;
  private lifecycleFallbackCoherent: ClientCoherentSnapshot<TRow> | undefined;
  private queryRejected:
    | Readonly<{
        readonly coherent: ClientCoherentSnapshot<TRow>;
        readonly publication: BrunoTableRowPipelinePublication<TRow>;
      }>
    | undefined;
  private readonly valueCache = new ClientCanonicalValueCache();

  public constructor(
    source: BrunoTableClientSource<TRow>,
    getRowId: (row: TRow) => BrunoTableRowId,
    columns: readonly CompiledColumn[],
    initialFilters: readonly unknown[] | undefined,
    initialOrderBy: ClientOrderBy | undefined,
    quickFilterFields?: readonly string[],
    groupRowsColumn?: BrunoTableCompiledGroupRowsColumn,
  ) {
    this.groupRowsColumn = groupRowsColumn;
    this.initialFilterCollection = compileClientFilterCollection(initialFilters, columns, {
      rejectOverBudget: true,
    });
    this.initialFilters = this.initialFilterCollection.filters;
    this.initialOrderBy = sanitizeClientInitialOrderBy(initialOrderBy, columns);
    this.quickFilterFields = snapshotBrunoTableQuickFilterFields(quickFilterFields);
    this.source = snapshotSource(source);
    this.observedRows =
      this.source.inputRows === undefined ? undefined : Array.from(this.source.rows.asArray());
    this.getRowId = getRowId;
    this.publication = createPublication(
      this.source,
      getRowId,
      columns,
      undefined,
      undefined,
      false,
      this.valueCache,
    );
    this.resultRowCount = this.publication.rowSpace?.loadedRows ?? 0;
    this.coherent = nextCoherent(this.coherent, this.publication);
    this.editCoherent = undefined;
    this.editSourceStatus = this.publication.status;
    this.editSourceVersion = this.publication.version;
    this.acceptEmptyCoherent();
    this.sourceColumns = columns;
    this.queryColumns = columns;
    this.valueCache.retainColumns(columns, this.coherent?.validatedColumns);
    this.queryConfiguration = Object.freeze({
      baselineFilters: this.initialFilters,
      baselineFilterCollection: this.initialFilterCollection,
      baselineOrderBy: this.initialOrderBy,
      quickFilterFields: this.quickFilterFields,
    });
    this.projectionInput = createProjectionInputSnapshot(
      this.projectionInputEpoch,
      this.publication,
      columns,
      this.queryConfiguration,
      groupRowsColumn,
    );
  }

  public readonly getPublication = (): BrunoTableRowPipelinePublication<TRow> => this.publication;

  public readonly hasAuthoritativeEditSource = (): boolean =>
    this.editCoherent !== undefined &&
    (this.editSourceStatus === "ready" || this.editSourceStatus === "stale");

  public readonly getEditSourceChangedRowIds = (): ReadonlySet<BrunoTableRowId> | undefined =>
    this.editSourceChangedRowIds;

  public readonly isEditSourceConfiguredFor = (columns: readonly CompiledColumn[]): boolean =>
    this.editCoherent?.validatedColumns === columns;

  public readonly subscribeEditSource = (
    listener: (changedRowIds: ReadonlySet<BrunoTableRowId> | undefined) => void,
  ): (() => void) => {
    this.editSourceListeners.add(listener);
    return () => this.editSourceListeners.delete(listener);
  };

  public readonly getProjectionInputSnapshot = (): BrunoTableClientProjectionInputSnapshot =>
    this.projectionInput;

  public readonly getAuthoritativeEditRowSnapshot = (rowId: BrunoTableRowId): unknown =>
    this.editCoherent?.admittedById.get(rowId)?.raw;

  public readonly getAuthoritativeEditCellSnapshot = (
    rowId: BrunoTableRowId,
    columnId: string,
  ):
    | Readonly<{ readonly found: false }>
    | Readonly<{ readonly found: true; readonly value: unknown }> => {
    const admitted = this.editCoherent?.admittedById.get(rowId);
    const column = this.editCoherent?.columnsById.get(columnId);
    if (admitted === undefined || column === undefined) return Object.freeze({ found: false });
    return Object.freeze({
      found: true,
      value: admitted.values.read(admitted.raw, admitted.rowId, admitted.rowIndex, column),
    });
  };

  public readonly subscribeProjectionInput = (listener: () => void): (() => void) => {
    this.projectionInputListeners.add(listener);
    return () => this.projectionInputListeners.delete(listener);
  };

  public readonly publishProjectionInput = (
    columns: readonly CompiledColumn[],
    queryConfiguration: BrunoTableQueryConfiguration,
    notify = true,
  ): void => {
    if (
      this.projectionInput.publication === this.publication &&
      this.projectionInput.columns === columns &&
      this.projectionInput.queryConfiguration === queryConfiguration &&
      this.projectionInput.groupRowsColumn === this.groupRowsColumn
    ) {
      return;
    }
    this.projectionInputEpoch += 1;
    this.projectionInput = createProjectionInputSnapshot(
      this.projectionInputEpoch,
      this.publication,
      columns,
      queryConfiguration,
      this.groupRowsColumn,
    );
    if (notify) notifyRowsStoreListeners(this.projectionInputListeners);
  };

  public readonly projectGroupedRows = (
    rows: readonly BrunoTableClientGroupedRow[],
    changedRowIds: ReadonlySet<string>,
    sourceAuthoritative: boolean,
  ): BrunoTableRowPipelinePublication<unknown> => {
    if (!sourceAuthoritative) {
      return Object.freeze({ ...this.publication, changedRowIds });
    }
    const rowIndexById = new Map(rows.map((row, index) => [row.rowId, index]));
    const rowsById = new Map(rows.map((row) => [row.rowId, row]));
    const rowSpace = Object.freeze({
      brunoTableClientGrouped: true as const,
      totalRows: rows.length,
      loadedRows: rows.length,
      getRowId: (index: number) => rows[index]?.rowId,
      getRow: (rowId: BrunoTableRowId) => rowsById.get(rowId),
      getCellValue: (rowId: BrunoTableRowId, columnId: string) =>
        rowsById.get(rowId)?.values.get(columnId),
      findRowIndex: (rowId: BrunoTableRowId) => rowIndexById.get(rowId),
      setRequiredRange: (_start: number, _end: number) => undefined,
    });
    return Object.freeze({
      ...this.publication,
      totalRows: rows.length,
      rowSpace,
      changedRowIds,
      hasCoherentRows: true,
    });
  };

  public readonly projectUngroupedRows = (): BrunoTableRowPipelinePublication<unknown> =>
    this.publication as BrunoTableRowPipelinePublication<unknown>;

  public readonly getResultRowCountSnapshot = (): number => this.resultRowCount;

  public readonly subscribeResultRowCount = (listener: () => void): (() => void) => {
    this.resultRowCountListeners.add(listener);
    return () => this.resultRowCountListeners.delete(listener);
  };

  public readonly publishResultRowCount = (count: number): void => {
    this.resultRowCountInitialized = true;
    if (this.resultRowCount === count) return;
    this.resultRowCount = count;
    notifyRowsStoreListeners(this.resultRowCountListeners);
  };

  public readonly initializeResultRowCount = (
    query: BrunoTableQuerySnapshot,
    rowSpace: BrunoTableRowSpaceSnapshot<unknown> | undefined,
  ): boolean => {
    if (this.resultRowCountInitialized) return false;
    this.resultRowCountInitialized = true;
    const coherent = asClientCoherent(rowSpace as BrunoTableRowSpaceSnapshot<TRow> | undefined);
    this.resultRowCount = this.projectResultRowCount(
      query,
      coherent?.admittedRows.asArray() ?? EMPTY_ROWS,
    );
    return true;
  };

  private readonly projectResultRowCount = (
    query: BrunoTableQuerySnapshot,
    rows: readonly BrunoTableClientAdmittedRow[] = this.coherent?.admittedRows.asArray() ??
      EMPTY_ROWS,
  ): number => {
    const filterPlan = compileClientFilterPlan(
      query.columns,
      query.filters,
      query.filterCollection,
    );
    const { filterPredicate, orderedColumns } = createClientAdmittedQueryProjectionPlan(
      query.columns,
      query.filters,
      query.quickFilter,
      this.quickFilterFields,
      query.orderBy,
      filterPlan,
    );
    let count = 0;
    try {
      for (const row of rows) {
        if (filterPredicate !== undefined && !filterPredicate(row)) continue;
        for (const column of orderedColumns) {
          const value = row.values.read(row.raw, row.rowId, row.rowIndex, column);
          if (isBrunoTableInvalidCellValue(value)) throw value.invalid;
        }
        count += 1;
      }
    } catch {
      count = 0;
    }
    return count;
  };

  public readonly getFacetRowsSnapshot = (
    rowSpace: BrunoTableRowSpaceSnapshot<unknown> | undefined,
  ): BrunoTableClientFacetRowsSnapshot => {
    const sourceRowSpace = isClientGroupedRowSpace(rowSpace)
      ? this.publication.rowSpace
      : (rowSpace as BrunoTableRowSpaceSnapshot<TRow> | undefined);
    const coherent = asClientCoherent(sourceRowSpace);
    const sequence = coherent?.admittedRows ?? EMPTY_PERSISTENT_SEQUENCE;
    return Object.freeze({
      rows: sequence.asArray(),
      token: sequence.token,
      ...(sequence.parentToken === undefined ? {} : { parentToken: sequence.parentToken }),
      changedIndexes: sequence.changedIndexes,
    });
  };

  public readonly getQueryConfiguration = (
    columns: readonly CompiledColumn[],
  ): BrunoTableQueryConfiguration => {
    if (columns === this.queryColumns) return this.queryConfiguration;
    const baselineFilterCollection = compileClientFilterCollection(
      this.initialFilterCollection.filters,
      columns,
    );
    const baselineFilters = baselineFilterCollection.filters;
    const baselineOrderBy = reconcileClientOrderBy(
      this.initialOrderBy,
      this.initialOrderBy,
      columns,
    );
    if (baselineOrderBy.length === 0) {
      throw new TypeError("BrunoTableClient requires at least one sortable column.");
    }
    this.queryColumns = columns;
    this.queryConfiguration = Object.freeze({
      baselineFilters,
      baselineFilterCollection,
      baselineOrderBy,
      quickFilterFields: this.quickFilterFields,
    });
    return this.queryConfiguration;
  };

  public readonly reconcile = (
    source: BrunoTableClientSource<TRow>,
    getRowId: (row: TRow) => BrunoTableRowId,
    columns: readonly CompiledColumn[],
    groupRowsColumn: BrunoTableCompiledGroupRowsColumn | undefined = this.groupRowsColumn,
  ): BrunoTableRowPipelinePublication<TRow> => {
    this.groupRowsColumn = groupRowsColumn;
    const sourceSnapshot = snapshotSource(source, this.source, this.observedRows);
    if (sourceSnapshot.status !== "ready" && sourceSnapshot.status !== "stale") {
      this.transitionEditSource(undefined, sourceSnapshot.status, sourceSnapshot.version);
    }
    const queryRejected = this.queryRejected;
    const retainedSourceInvalid = retainedSourceInvalidSnapshot(sourceSnapshot);
    const sameRetainedCandidate =
      this.queryFallbackActive &&
      queryRejected !== undefined &&
      retainsPreviousRows(this.source) &&
      retainsPreviousRows(sourceSnapshot) &&
      ((this.source.invalidStatus === sourceSnapshot.invalidStatus &&
        this.source.invalidLifecycle === sourceSnapshot.invalidLifecycle &&
        this.source.invalidRows === sourceSnapshot.invalidRows) ||
        retainedSourceInvalid !== undefined) &&
      this.source.rows === sourceSnapshot.rows &&
      this.source.totalRows === sourceSnapshot.totalRows &&
      this.getRowId === getRowId &&
      this.sourceColumns === columns;
    if (sameRetainedCandidate && queryRejected !== undefined) {
      this.publication = refreshPublicationSource(
        this.publication,
        sourceSnapshot,
        retainedSourceInvalid,
      );
      this.queryRejected = Object.freeze({
        coherent: queryRejected.coherent,
        publication: refreshPublicationSource(
          queryRejected.publication,
          sourceSnapshot,
          retainedSourceInvalid,
        ),
      });
      if (sourceSnapshot.inputRows !== undefined) {
        this.observedRows = commitObservedRows(
          sourceSnapshot.rows,
          sourceSnapshot.rows.changedIndexes,
          this.observedRows,
        );
      }
      this.source = sourceSnapshot;
      const publishedCoherent = asClientCoherent(this.publication.rowSpace);
      if (publishedCoherent === undefined || hasInvalidSourceEvidence(sourceSnapshot)) {
        this.transitionEditSource(undefined, this.publication.status, this.publication.version);
      } else if (this.editCoherent === publishedCoherent) {
        this.transitionEditSource(
          publishedCoherent,
          this.publication.status,
          this.publication.version,
        );
      }
      return this.publication;
    }
    this.queryFallbackActive = false;
    this.queryRejected = undefined;
    const previousCoherent = this.coherent;
    if (!retainsPreviousRows(sourceSnapshot)) {
      this.lifecycleFallbackCoherent = undefined;
    } else if (
      sourceSnapshot.invalidRows !== undefined ||
      sourceSnapshot.invalidLifecycle !== undefined ||
      sourceSnapshot.invalidStatus !== undefined ||
      !retainsPreviousRows(this.source) ||
      this.source.rows !== sourceSnapshot.rows ||
      this.source.totalRows !== sourceSnapshot.totalRows
    ) {
      this.lifecycleFallbackCoherent = this.acceptedCoherent;
    }
    this.lifecycleFallbackCoherent = reconfigureFallback(
      this.lifecycleFallbackCoherent,
      getRowId,
      columns,
      this.valueCache,
    );
    const publication = createPublication(
      sourceSnapshot,
      getRowId,
      columns,
      this.coherent,
      this.lifecycleFallbackCoherent,
      this.getRowId !== getRowId,
      this.valueCache,
    );
    const next = nextCoherent(this.coherent, publication);
    const preciseChangedRowIds = deriveChangedRawRowIds(previousCoherent, next);
    const changedRowIds =
      preciseChangedRowIds?.size === 0 &&
      (this.source.version !== sourceSnapshot.version ||
        this.source.status !== sourceSnapshot.status)
        ? undefined
        : preciseChangedRowIds;
    this.publication =
      changedRowIds === undefined ? publication : Object.freeze({ ...publication, changedRowIds });
    this.coherent = next;
    const publishedCoherent = asClientCoherent(this.publication.rowSpace);
    if (publishedCoherent === undefined || hasInvalidSourceEvidence(sourceSnapshot)) {
      this.transitionEditSource(undefined, sourceSnapshot.status, sourceSnapshot.version);
    } else if (this.editCoherent === publishedCoherent) {
      this.transitionEditSource(publishedCoherent, sourceSnapshot.status, sourceSnapshot.version);
    }
    this.acceptEmptyCoherent();
    if (
      this.coherent !== undefined &&
      this.coherent !== previousCoherent &&
      this.coherent.changeFromPrevious.rowIdsChanged
    ) {
      this.valueCache.retainRowIds(this.coherent.hasRowId);
    }
    if (sourceSnapshot.inputRows !== undefined) {
      this.observedRows = commitObservedRows(
        sourceSnapshot.rows,
        sourceSnapshot.rows.changedIndexes,
        this.observedRows,
      );
    }
    this.valueCache.retainColumns(columns, this.coherent?.validatedColumns);
    this.source = sourceSnapshot;
    this.getRowId = getRowId;
    this.sourceColumns = columns;
    return this.publication;
  };

  public readonly publish = (
    source: BrunoTableClientSource<TRow>,
  ): BrunoTableRowPipelinePublication<TRow> =>
    this.reconcile(source, this.getRowId, this.sourceColumns);

  public readonly configure = (
    getRowId: (row: TRow) => BrunoTableRowId,
    columns: readonly CompiledColumn[],
  ): BrunoTableRowPipelinePublication<TRow> => {
    const editSourceNeedsReadmission =
      this.getRowId !== getRowId || this.editCoherent?.validatedColumns !== columns;
    this.queryFallbackActive = false;
    this.queryRejected = undefined;
    const previousCoherent = this.coherent;
    this.lifecycleFallbackCoherent = reconfigureFallback(
      this.lifecycleFallbackCoherent,
      getRowId,
      columns,
      this.valueCache,
    );
    this.publication = createPublication(
      this.source,
      getRowId,
      columns,
      this.coherent,
      this.lifecycleFallbackCoherent,
      this.getRowId !== getRowId,
      this.valueCache,
    );
    this.coherent = nextCoherent(this.coherent, this.publication);
    if (editSourceNeedsReadmission) {
      this.transitionEditSource(undefined, this.publication.status, this.publication.version);
    }
    this.acceptEmptyCoherent();
    if (
      this.coherent !== undefined &&
      this.coherent !== previousCoherent &&
      this.coherent.changeFromPrevious.rowIdsChanged
    ) {
      this.valueCache.retainRowIds(this.coherent.hasRowId);
    }
    this.valueCache.retainColumns(columns, this.coherent?.validatedColumns);
    this.getRowId = getRowId;
    this.sourceColumns = columns;
    return this.publication;
  };

  public readonly resolveRowId = (row: unknown): BrunoTableRowId => this.getRowId(row as TRow);

  public readonly acceptRows = (
    rows: readonly BrunoTableClientAdmittedRow[],
  ): "accepted-changed" | "accepted-unchanged" | "invalid-source" | "stale-snapshot" => {
    if (this.coherent?.admittedRows.asArray() !== rows) return "stale-snapshot";
    if (hasInvalidSourceEvidence(this.source)) return "invalid-source";
    this.acceptedCoherent = this.coherent;
    return this.transitionEditSource(
      this.coherent,
      this.publication.status,
      this.publication.version,
    )
      ? "accepted-changed"
      : "accepted-unchanged";
  };

  public readonly rejectQueryRows = (
    rows: readonly BrunoTableClientAdmittedRow[],
    invalid: BrunoTableClientProjectionInvalid,
  ): BrunoTableRowPipelinePublication<TRow> | undefined => {
    const rejectedCoherent = this.coherent;
    if (rejectedCoherent?.admittedRows.asArray() !== rows || !retainsPreviousRows(this.source)) {
      return undefined;
    }
    if (this.queryFallbackActive) {
      this.publication = rejectPublicationRows(
        this.publication,
        retainedSourceInvalidSnapshot(this.source) ?? invalid,
      );
      this.coherent = undefined;
      this.transitionEditSource(undefined, this.publication.status, this.publication.version);
      this.valueCache.retainColumns(this.sourceColumns);
      return this.publication;
    }
    const fallbackCoherent =
      this.lifecycleFallbackCoherent === rejectedCoherent
        ? undefined
        : this.lifecycleFallbackCoherent === undefined
          ? undefined
          : refreshRowOrderEvidence(this.lifecycleFallbackCoherent);
    this.queryFallbackActive = true;
    this.queryRejected = Object.freeze({
      coherent: rejectedCoherent,
      publication: this.publication,
    });
    this.publication = createPublication(
      this.source,
      this.getRowId,
      this.sourceColumns,
      rejectedCoherent,
      fallbackCoherent,
      false,
      this.valueCache,
      invalid,
    );
    this.coherent = asClientCoherent(this.publication.rowSpace);
    this.transitionEditSource(this.coherent, this.publication.status, this.publication.version);
    const changedRowIds = deriveEditSourceChangedRawRowIds(rejectedCoherent, this.coherent);
    if (changedRowIds !== undefined) {
      this.publication = Object.freeze({ ...this.publication, changedRowIds });
    }
    this.valueCache.retainColumns(this.sourceColumns, this.coherent?.validatedColumns);
    return this.publication;
  };

  public readonly retryQueryRows = (): BrunoTableRowPipelinePublication<TRow> | undefined => {
    const rejected = this.queryRejected;
    if (!this.queryFallbackActive || rejected === undefined) return undefined;
    const previousCoherent = this.coherent;
    this.queryFallbackActive = false;
    this.queryRejected = undefined;
    this.coherent = refreshRowOrderEvidence(rejected.coherent);
    const changedRowIds = deriveEditSourceChangedRawRowIds(previousCoherent, this.coherent);
    const { changedRowIds: _rejectedChangedRowIds, ...retriedPublication } = rejected.publication;
    this.publication = Object.freeze({
      ...retriedPublication,
      rowSpace: this.coherent,
      ...(changedRowIds === undefined ? {} : { changedRowIds }),
    });
    return this.publication;
  };

  private readonly acceptEmptyCoherent = (): void => {
    if (this.coherent?.admittedRows.length === 0) this.acceptedCoherent = this.coherent;
  };

  private readonly transitionEditSource = (
    coherent: ClientCoherentSnapshot<TRow> | undefined,
    status: BrunoTableSourceStatus,
    version: number,
  ): boolean => {
    const next = status === "ready" || status === "stale" ? coherent : undefined;
    const envelopeChanged = this.editSourceStatus !== status || this.editSourceVersion !== version;
    if (this.editCoherent === next && !envelopeChanged) return false;
    const preciseChangedRowIds = deriveEditSourceChangedRawRowIds(this.editCoherent, next);
    this.editSourceChangedRowIds =
      preciseChangedRowIds?.size === 0 && envelopeChanged ? undefined : preciseChangedRowIds;
    this.editCoherent = next;
    this.editSourceStatus = status;
    this.editSourceVersion = version;
    notifyEditSourceListeners(this.editSourceListeners, this.editSourceChangedRowIds);
    return true;
  };

  public readonly createRowsStore = (
    runtime: BrunoTableRowPipelineRuntimeView,
    createDetector: () => BrunoTableClientRowOrderChangeDetector,
    tableId = "",
  ): BrunoTableClientRowsStore => {
    const readRuntimeRowSpace = () =>
      runtime.getRowSpaceSnapshot() as BrunoTableRowSpaceSnapshot<TRow> | undefined;
    const readRuntimeCoherent = () => asClientCoherent(readRuntimeRowSpace());
    const installedCoherent = readRuntimeCoherent();
    let snapshot: readonly BrunoTableClientAdmittedRow[] =
      installedCoherent?.admittedRows.asArray() ?? EMPTY_ROWS;
    const emptySourceRowIdsSnapshot = Object.freeze({
      authoritative: false,
      rowIds: EMPTY_ROWS,
      token: EMPTY_PERSISTENT_SEQUENCE.token,
    });
    const sourceRowIdsByRows = new WeakMap<object, BrunoTableClientSourceRowIdsSnapshot>();
    const registerSourceRowIds = (
      rows: readonly BrunoTableClientAdmittedRow[],
      coherent: ClientCoherentSnapshot<TRow> | undefined,
    ): void => {
      const rowIds = coherent?.rowIds ?? EMPTY_PERSISTENT_SEQUENCE;
      sourceRowIdsByRows.set(
        rows,
        Object.freeze({
          authoritative: coherent !== undefined,
          rowIds: rowIds.asArray(),
          token: rowIds.token,
        }),
      );
    };
    registerSourceRowIds(snapshot, installedCoherent);
    let evaluatedCoherent = installedCoherent;
    let detector: BrunoTableClientRowOrderChangeDetector | undefined;
    const listeners = new Set<() => void>();
    const identity = Object.freeze({});
    let unsubscribeRuntime: (() => void) | undefined;
    let displayedRowSpace = installedCoherent !== undefined;
    const publish = () => {
      if (isClientGroupedRowSpace(readRuntimeRowSpace())) return;
      const previousRows = snapshot;
      const nextCoherent = readRuntimeCoherent();
      const nextRows = nextCoherent?.admittedRows.asArray() ?? EMPTY_ROWS;
      const nextDisplayedRowSpace = nextCoherent !== undefined;
      if (!nextDisplayedRowSpace) {
        this.publishResultRowCount(0);
      } else if (!displayedRowSpace) {
        if (this.resultRowCountListeners.size > 0) {
          if (__BRUNO_TABLE_TEST_DIAGNOSTICS__) {
            recordBrunoTableToolbarLifetime({
              tableId,
              kind: "result-row-count-project",
              identity: this,
            });
          }
          this.publishResultRowCount(
            this.projectResultRowCount(runtime.getQuerySnapshot(), nextRows),
          );
        } else {
          this.resultRowCountInitialized = false;
        }
      }
      displayedRowSpace = nextDisplayedRowSpace;
      const change = clientRowsStoreChange(evaluatedCoherent, nextCoherent);
      evaluatedCoherent = nextCoherent;
      const activeDetector = detector;
      if (activeDetector === undefined) return;
      try {
        if (!activeDetector(previousRows, nextRows, change)) {
          if (nextCoherent !== undefined) this.acceptRows(nextRows);
          return;
        }
      } catch (error) {
        snapshot = nextRows;
        registerSourceRowIds(snapshot, nextCoherent);
        notifyRowsStoreListeners(listeners, Object.freeze({ value: error }));
        return;
      }
      snapshot = nextRows;
      registerSourceRowIds(snapshot, nextCoherent);
      notifyRowsStoreListeners(listeners);
    };
    return Object.freeze({
      getSnapshot: () => snapshot,
      getSourceRowIdsSnapshot: (rows) => sourceRowIdsByRows.get(rows) ?? emptySourceRowIdsSnapshot,
      subscribe: (listener: () => void) => {
        if (__BRUNO_TABLE_TEST_DIAGNOSTICS__) {
          recordBrunoTableToolbarLifetime({
            tableId,
            kind: "row-pipeline-subscribe",
            identity,
          });
        }
        listeners.add(listener);
        if (unsubscribeRuntime === undefined) {
          detector ??= createDetector();
          const installedCoherent = readRuntimeCoherent();
          snapshot = installedCoherent?.admittedRows.asArray() ?? EMPTY_ROWS;
          registerSourceRowIds(snapshot, installedCoherent);
          evaluatedCoherent = installedCoherent;
          displayedRowSpace = installedCoherent !== undefined;
          unsubscribeRuntime = runtime.subscribeRowSpace(publish);
        }
        let subscribed = true;
        return () => {
          if (!subscribed) return;
          subscribed = false;
          listeners.delete(listener);
          if (__BRUNO_TABLE_TEST_DIAGNOSTICS__) {
            recordBrunoTableToolbarLifetime({
              tableId,
              kind: "row-pipeline-unsubscribe",
              identity,
            });
          }
          if (listeners.size === 0) {
            unsubscribeRuntime?.();
            unsubscribeRuntime = undefined;
          }
        };
      },
    });
  };
}

function deriveChangedRawRowIds<TRow>(
  previous: ClientCoherentSnapshot<TRow> | undefined,
  next: ClientCoherentSnapshot<TRow> | undefined,
  changedIndexes: readonly number[] | undefined = next?.changeFromPrevious.changedIndexes,
): ReadonlySet<BrunoTableRowId> | undefined {
  if (previous === undefined || next === undefined) return undefined;
  if (previous === next) return new Set();
  const changed = new Set<BrunoTableRowId>();
  const completeIdentityReconciliation = previous.identityResolver !== next.identityResolver;
  const indexes = completeIdentityReconciliation
    ? Array.from(
        { length: Math.max(previous.rows.length, next.rows.length) },
        (_unused, index) => index,
      )
    : [
        ...(changedIndexes ?? []),
        ...Array.from(
          { length: Math.abs(previous.rows.length - next.rows.length) },
          (_unused, offset) => Math.min(previous.rows.length, next.rows.length) + offset,
        ),
      ];
  for (const index of indexes) {
    const previousRowId = previous.rowIds.get(index);
    const nextRowId = next.rowIds.get(index);
    if (previousRowId === nextRowId && previous.rows.get(index) === next.rows.get(index)) {
      continue;
    }
    if (previousRowId !== undefined) changed.add(previousRowId);
    if (nextRowId !== undefined) changed.add(nextRowId);
  }
  return changed;
}

function deriveEditSourceChangedRawRowIds<TRow>(
  previous: ClientCoherentSnapshot<TRow> | undefined,
  next: ClientCoherentSnapshot<TRow> | undefined,
): ReadonlySet<BrunoTableRowId> | undefined {
  if (previous === undefined || next === undefined) return undefined;
  const change = persistentSequenceChange(previous.rows, next.rows);
  return deriveChangedRawRowIds(previous, next, change.changedIndexes);
}

export type BrunoTableClientRowOrderChangeDetector = (
  previousRows: readonly BrunoTableClientAdmittedRow[],
  nextRows: readonly BrunoTableClientAdmittedRow[],
  change: BrunoTableClientRowOrderChange,
) => boolean;

export type BrunoTableClientProjectionInputSnapshot = Readonly<{
  readonly epoch: number;
  readonly publication: BrunoTableRowPipelinePublication<unknown>;
  readonly rows: readonly BrunoTableClientAdmittedRow[];
  readonly sourceRowIds: BrunoTableClientSourceRowIdsSnapshot;
  readonly columns: readonly CompiledColumn[];
  readonly queryConfiguration: BrunoTableQueryConfiguration;
  readonly groupRowsColumn: BrunoTableCompiledGroupRowsColumn | undefined;
}>;

export type BrunoTableClientRowOrderChange = Readonly<{
  readonly rowIdsChanged: boolean;
  readonly changedIndexes: readonly number[];
}>;

export type BrunoTableClientRowsStore = Readonly<{
  readonly getSnapshot: () => readonly BrunoTableClientAdmittedRow[];
  readonly getSourceRowIdsSnapshot: (
    rows: readonly BrunoTableClientAdmittedRow[],
  ) => BrunoTableClientSourceRowIdsSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
}>;

export type BrunoTableClientSourceRowIdsSnapshot = Readonly<{
  readonly authoritative: boolean;
  readonly rowIds: readonly BrunoTableRowId[];
  readonly token: object;
}>;

export type BrunoTableClientFacetRowsSource = Readonly<{
  readonly getFacetRowsSnapshot: (
    rowSpace: BrunoTableRowSpaceSnapshot<unknown> | undefined,
  ) => BrunoTableClientFacetRowsSnapshot;
}>;

function clientRowsStoreChange<TRow>(
  previous: ClientCoherentSnapshot<TRow> | undefined,
  next: ClientCoherentSnapshot<TRow> | undefined,
): BrunoTableClientRowOrderChange {
  const previousSequence = previous?.admittedRows ?? EMPTY_PERSISTENT_SEQUENCE;
  const nextSequence = next?.admittedRows ?? EMPTY_PERSISTENT_SEQUENCE;
  if (previousSequence === nextSequence) {
    return next?.changeFromPrevious ?? EMPTY_ROW_ORDER_CHANGE;
  }
  if (next !== undefined && nextSequence.parentToken === previousSequence.token) {
    return next.changeFromPrevious;
  }
  let rowIdsChanged = previousSequence.length !== nextSequence.length;
  const changedIndexes: number[] = [];
  for (let index = 0; index < nextSequence.length; index += 1) {
    const previousRow = previousSequence.get(index);
    const nextRow = nextSequence.get(index);
    if (previousRow !== nextRow) changedIndexes.push(index);
    if (previousRow?.rowId !== nextRow?.rowId) rowIdsChanged = true;
  }
  return Object.freeze({
    rowIdsChanged,
    changedIndexes: Object.freeze(changedIndexes),
  });
}

export type BrunoTableClientFacetRowsSnapshot = Readonly<{
  readonly rows: readonly BrunoTableClientAdmittedRow[];
  readonly token: object;
  readonly parentToken?: object;
  readonly changedIndexes: readonly number[];
}>;

export type BrunoTableClientAdmittedRow = Readonly<{
  readonly raw: unknown;
  readonly rowId: BrunoTableRowId;
  readonly rowIndex: number;
  readonly values: BrunoTableClientValueCache;
}>;

export function createClientAdmittedQueryProjectionPlan(
  columns: readonly CompiledColumn[],
  filters: readonly unknown[],
  quickFilter: string,
  quickFilterFields: readonly string[],
  orderBy: ClientOrderBy,
  filterPlan: ReturnType<typeof compileClientFilterPlan>,
): Readonly<{
  readonly orderedColumns: readonly CompiledColumn[];
  readonly filterPredicate: ((row: BrunoTableClientAdmittedRow) => boolean) | undefined;
}> {
  const columnsById = new Map<string, CompiledColumn>(
    columns.map((column) => [column.columnId, column] as const),
  );
  const orderedColumns = Object.freeze(
    orderBy.flatMap((sort) => {
      const column = columnsById.get(sort.columnId);
      return column === undefined || column.enableSorting === false ? [] : [column];
    }),
  );
  const filterPredicate = createClientQueryPredicate<BrunoTableClientAdmittedRow>(
    columns,
    filters,
    quickFilter,
    quickFilterFields,
    (column, row) => {
      const value = row.values.read(row.raw, row.rowId, row.rowIndex, column);
      if (isBrunoTableInvalidCellValue(value)) throw value.invalid;
      return value;
    },
    (row, field) => readClientQuickFilterField(row.raw, field),
    filterPlan,
  );
  return Object.freeze({ orderedColumns, filterPredicate });
}

export type BrunoTableClientValueCache = Readonly<{
  readonly read: (
    row: unknown,
    rowId: BrunoTableRowId,
    rowIndex: number,
    column: CompiledColumn,
  ) => unknown;
}>;

type ClientCoherentSnapshot<TRow> = BrunoTableRowSpaceSnapshot<TRow> &
  Readonly<{
    readonly rows: ClientPersistentSequence<TRow>;
    readonly admittedRows: ClientPersistentSequence<BrunoTableClientAdmittedRow>;
    readonly rowIds: ClientPersistentSequence<BrunoTableRowId>;
    readonly admittedById: ClientPersistentIdentityIndex;
    readonly columnsById: ReadonlyMap<string, CompiledColumn>;
    readonly hasRowId: (rowId: BrunoTableRowId) => boolean;
    readonly identityResolver: (row: TRow) => BrunoTableRowId;
    readonly changeFromPrevious: BrunoTableClientRowOrderChange;
    readonly validatedColumns: readonly CompiledColumn[];
  }>;

type ClientSourceSnapshot<TRow> = Omit<BrunoTableClientSource<TRow>, "rows" | "status"> &
  Readonly<{
    readonly rows: ClientPersistentSequence<TRow>;
    readonly status: BrunoTableSourceStatus;
    readonly invalidStatus?: string;
    readonly invalidLifecycle?: "status" | "totalRows" | "version";
    readonly invalidRows?: string;
    readonly inputRows?: readonly TRow[];
  }>;

type ClientPersistentSequence<T> = Readonly<{
  readonly length: number;
  readonly token: object;
  readonly parentToken?: object;
  readonly chunks: readonly (readonly T[])[];
  readonly changedIndexes: readonly number[];
  readonly get: (index: number) => T | undefined;
  readonly asArray: () => readonly T[];
}>;

type ClientPersistentSequenceSnapshot<T> =
  | Readonly<{ readonly rows: ClientPersistentSequence<T> }>
  | Readonly<{ readonly invalidRows: string }>;

type ClientPersistentIdentityIndex = Readonly<{
  readonly buckets: ReadonlyMap<number, ReadonlyMap<BrunoTableRowId, BrunoTableClientAdmittedRow>>;
  readonly get: (rowId: BrunoTableRowId) => BrunoTableClientAdmittedRow | undefined;
  readonly has: (rowId: BrunoTableRowId) => boolean;
}>;

const EMPTY_ROWS: readonly [] = Object.freeze([]);
const EMPTY_PERSISTENT_SEQUENCE = basePersistentSequence(EMPTY_ROWS);
const CLIENT_MAX_PROTOTYPE_DEPTH = 64;
const EMPTY_ROW_ORDER_CHANGE: BrunoTableClientRowOrderChange = Object.freeze({
  rowIdsChanged: false,
  changedIndexes: EMPTY_ROWS,
});
const EMPTY_COLUMNS: readonly CompiledColumn[] = Object.freeze([]);
const NOT_FOUND = Object.freeze({ found: false as const });
const CLIENT_BOUNDED_VALUE_CACHE_LIMIT = 16_384;
const CLIENT_PERSISTENT_SEQUENCE_CHUNK_SIZE = 256;
const CLIENT_PERSISTENT_SEQUENCE_CHUNK_SHIFT = 8;
const CLIENT_PERSISTENT_SEQUENCE_CHUNK_MASK = CLIENT_PERSISTENT_SEQUENCE_CHUNK_SIZE - 1;
const CLIENT_PERSISTENT_IDENTITY_BUCKETS = 4_096;

function snapshotObservedPersistentSequence<T>(
  input: readonly T[],
  previous: ClientPersistentSequence<T>,
  observed: T[],
): ClientPersistentSequenceSnapshot<T> {
  const changedIndexes: number[] = [];
  const patches = new Map<number, T>();
  let length = 0;
  try {
    length = input.length;
    const indexedPrototype = hasIndexedPrototypeProperty(input);
    for (let index = 0; index < length; index += 1) {
      if (!(indexedPrototype ? Object.hasOwn(input, index) : index in input)) {
        return Object.freeze({ invalidRows: "sparse array" });
      }
      const next = input[index]!;
      if (index >= observed.length || observed[index] !== next) {
        changedIndexes.push(index);
        patches.set(index, next);
      }
    }
  } catch {
    return Object.freeze({ invalidRows: "unreadable" });
  }
  if (previous.length === length && changedIndexes.length === 0) {
    return Object.freeze({ rows: previous });
  }
  return Object.freeze({
    rows: patchPersistentSequence(previous, length, patches, changedIndexes, (index) =>
      patches.get(index)!,
    ),
  });
}

function commitObservedRows<T>(
  input: ClientPersistentSequence<T>,
  changedIndexes: readonly number[],
  observed: T[] | undefined,
): T[] {
  if (observed === undefined) return Array.from(input.asArray());
  for (const index of changedIndexes) observed[index] = input.get(index)!;
  observed.length = input.length;
  return observed;
}

function snapshotBasePersistentSequence<T>(
  input: readonly T[],
): ClientPersistentSequenceSnapshot<T> {
  const chunks: (readonly T[])[] = [];
  let length = 0;
  try {
    length = input.length;
    const indexedPrototype = hasIndexedPrototypeProperty(input);
    for (let start = 0; start < length; start += CLIENT_PERSISTENT_SEQUENCE_CHUNK_SIZE) {
      const end = Math.min(length, start + CLIENT_PERSISTENT_SEQUENCE_CHUNK_SIZE);
      const chunk: T[] = [];
      for (let index = start; index < end; index += 1) {
        if (!(indexedPrototype ? Object.hasOwn(input, index) : index in input)) {
          return Object.freeze({ invalidRows: "sparse array" });
        }
        chunk.push(input[index]!);
      }
      chunks.push(Object.freeze(chunk));
    }
  } catch {
    return Object.freeze({ invalidRows: "unreadable" });
  }
  return Object.freeze({
    rows: persistentSequence(Object.freeze(chunks), length, EMPTY_ROWS),
  });
}

function hasIndexedPrototypeProperty(input: readonly unknown[]): boolean {
  const visited = new WeakSet<object>();
  let depth = 0;
  let prototype: object | null = Object.getPrototypeOf(input) as object | null;
  while (prototype !== null) {
    if (visited.has(prototype) || depth >= CLIENT_MAX_PROTOTYPE_DEPTH) {
      throw new TypeError("Client Source rows have an invalid prototype chain.");
    }
    visited.add(prototype);
    depth += 1;
    for (const key of Object.getOwnPropertyNames(prototype)) {
      const index = Number(key);
      if (Number.isInteger(index) && index >= 0 && index < 4_294_967_295 && String(index) === key) {
        return true;
      }
    }
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
  return false;
}

function patchPersistentSequence<T>(
  previous: ClientPersistentSequence<T>,
  length: number,
  patches: ReadonlyMap<number, T>,
  changedIndexes: readonly number[],
  materialize: (index: number) => T,
): ClientPersistentSequence<T> {
  if (previous.length === length && patches.size === 0) return previous;
  const chunkCount = Math.ceil(length / CLIENT_PERSISTENT_SEQUENCE_CHUNK_SIZE);
  const chunks = Array.from({ length: chunkCount }, (_unused, chunkIndex) =>
    previous.chunks[chunkIndex] === undefined
      ? Object.freeze([] as T[])
      : previous.chunks[chunkIndex]!,
  );
  const changedChunks = new Set<number>();
  for (const index of patches.keys()) {
    changedChunks.add(Math.floor(index / CLIENT_PERSISTENT_SEQUENCE_CHUNK_SIZE));
  }
  if (
    length < previous.length &&
    length > 0 &&
    length % CLIENT_PERSISTENT_SEQUENCE_CHUNK_SIZE !== 0
  ) {
    changedChunks.add(Math.floor((length - 1) / CLIENT_PERSISTENT_SEQUENCE_CHUNK_SIZE));
  }
  for (const chunkIndex of changedChunks) {
    const start = chunkIndex * CLIENT_PERSISTENT_SEQUENCE_CHUNK_SIZE;
    const chunkLength = Math.min(CLIENT_PERSISTENT_SEQUENCE_CHUNK_SIZE, length - start);
    chunks[chunkIndex] = Object.freeze(
      Array.from({ length: chunkLength }, (_unused, offset) => {
        const index = start + offset;
        if (patches.has(index)) return patches.get(index)!;
        return index < previous.length ? previous.get(index)! : materialize(index);
      }),
    );
  }
  return persistentSequence(
    Object.freeze(chunks),
    length,
    Object.freeze(Array.from(changedIndexes)),
    previous.token,
  );
}

function basePersistentSequence<T>(
  input: readonly T[],
  changedIndexes: readonly number[] = EMPTY_ROWS,
): ClientPersistentSequence<T> {
  const chunks: (readonly T[])[] = [];
  for (let start = 0; start < input.length; start += CLIENT_PERSISTENT_SEQUENCE_CHUNK_SIZE) {
    chunks.push(
      Object.freeze(Array.from(input.slice(start, start + CLIENT_PERSISTENT_SEQUENCE_CHUNK_SIZE))),
    );
  }
  return persistentSequence(
    Object.freeze(chunks),
    input.length,
    Object.freeze(Array.from(changedIndexes)),
  );
}

function persistentSequence<T>(
  chunks: readonly (readonly T[])[],
  length: number,
  changedIndexes: readonly number[],
  parentToken?: object,
): ClientPersistentSequence<T> {
  const token = Object.freeze({});
  let arrayView: readonly T[] | undefined;
  const sequence: ClientPersistentSequence<T> = Object.freeze({
    length,
    token,
    ...(parentToken === undefined ? {} : { parentToken }),
    chunks,
    changedIndexes,
    get: (index: number) =>
      index < 0 || index >= length
        ? undefined
        : chunks[index >>> CLIENT_PERSISTENT_SEQUENCE_CHUNK_SHIFT]?.[
            index & CLIENT_PERSISTENT_SEQUENCE_CHUNK_MASK
          ],
    asArray: () => (arrayView ??= persistentSequenceArray(sequence)),
  });
  return sequence;
}

function persistentSequenceArray<T>(sequence: ClientPersistentSequence<T>): readonly T[] {
  const target: T[] = [];
  return new Proxy(target, {
    get: (_target, property, receiver) => {
      if (property === "length") return sequence.length;
      if (property === Symbol.iterator) {
        return function* iteratePersistentSequence() {
          for (let index = 0; index < sequence.length; index += 1) yield sequence.get(index)!;
        };
      }
      const index = arrayIndex(property);
      return index === undefined ? Reflect.get(target, property, receiver) : sequence.get(index);
    },
    has: (_target, property) => {
      const index = arrayIndex(property);
      return index === undefined ? Reflect.has(target, property) : index < sequence.length;
    },
    set: () => false,
    deleteProperty: () => false,
  });
}

function arrayIndex(property: string | symbol): number | undefined {
  if (typeof property !== "string" || !/^(0|[1-9]\d*)$/u.test(property)) return undefined;
  const index = Number(property);
  return Number.isSafeInteger(index) ? index : undefined;
}

function persistentSequenceChange<T>(
  previous: ClientPersistentSequence<T>,
  next: ClientPersistentSequence<T>,
): Readonly<{
  readonly changedIndexes: readonly number[];
  readonly removedIndexes: readonly number[];
}> {
  if (previous === next) {
    return Object.freeze({ changedIndexes: EMPTY_ROWS, removedIndexes: EMPTY_ROWS });
  }
  const removedIndexes =
    previous.length <= next.length
      ? EMPTY_ROWS
      : Object.freeze(
          Array.from(
            { length: previous.length - next.length },
            (_unused, offset) => next.length + offset,
          ),
        );
  if (next.parentToken === previous.token) {
    return Object.freeze({ changedIndexes: next.changedIndexes, removedIndexes });
  }
  const changedIndexes: number[] = [];
  for (let index = 0; index < next.length; index += 1) {
    if (previous.get(index) !== next.get(index)) changedIndexes.push(index);
  }
  return Object.freeze({
    changedIndexes: Object.freeze(changedIndexes),
    removedIndexes,
  });
}

function patchPersistentIdentityIndex(
  previous: ClientPersistentIdentityIndex,
  patches: ReadonlyMap<BrunoTableRowId, BrunoTableClientAdmittedRow>,
  removedRowIds: ReadonlySet<BrunoTableRowId>,
): ClientPersistentIdentityIndex {
  if (patches.size === 0 && removedRowIds.size === 0) return previous;
  const buckets = new Map(previous.buckets);
  const removalsByBucket = new Map<number, BrunoTableRowId[]>();
  const patchesByBucket = new Map<number, [BrunoTableRowId, BrunoTableClientAdmittedRow][]>();
  for (const rowId of removedRowIds) {
    const bucketIndex = clientIdentityBucket(rowId);
    const removals = removalsByBucket.get(bucketIndex) ?? [];
    removals.push(rowId);
    removalsByBucket.set(bucketIndex, removals);
  }
  for (const patch of patches) {
    const bucketIndex = clientIdentityBucket(patch[0]);
    const bucketPatches = patchesByBucket.get(bucketIndex) ?? [];
    bucketPatches.push(patch);
    patchesByBucket.set(bucketIndex, bucketPatches);
  }
  const changedBuckets = new Set([...removalsByBucket.keys(), ...patchesByBucket.keys()]);
  for (const bucketIndex of changedBuckets) {
    const bucket = new Map(previous.buckets.get(bucketIndex));
    for (const rowId of removalsByBucket.get(bucketIndex) ?? EMPTY_ROWS) bucket.delete(rowId);
    for (const [rowId, admitted] of patchesByBucket.get(bucketIndex) ?? EMPTY_ROWS) {
      bucket.set(rowId, admitted);
    }
    if (bucket.size === 0) buckets.delete(bucketIndex);
    else buckets.set(bucketIndex, bucket);
  }
  return persistentIdentityIndex(buckets);
}

function persistentIdentityIndex(
  buckets: ReadonlyMap<number, ReadonlyMap<BrunoTableRowId, BrunoTableClientAdmittedRow>>,
): ClientPersistentIdentityIndex {
  return Object.freeze({
    buckets,
    get: (rowId: BrunoTableRowId) => buckets.get(clientIdentityBucket(rowId))?.get(rowId),
    has: (rowId: BrunoTableRowId) => buckets.get(clientIdentityBucket(rowId))?.has(rowId) ?? false,
  });
}

function clientIdentityBucket(rowId: BrunoTableRowId): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < rowId.length; index += 1) {
    hash = Math.imul(hash ^ rowId.charCodeAt(index), 16_777_619);
  }
  return (hash >>> 0) % CLIENT_PERSISTENT_IDENTITY_BUCKETS;
}

function createPublication<TRow>(
  source: ClientSourceSnapshot<TRow>,
  getRowId: (row: TRow) => BrunoTableRowId,
  columns: readonly CompiledColumn[],
  previousCoherent: ClientCoherentSnapshot<TRow> | undefined,
  fallbackCoherent: ClientCoherentSnapshot<TRow> | undefined,
  resolveRowIds: boolean,
  valueCache: ClientCanonicalValueCache,
  queryRejection?: BrunoTableClientProjectionInvalid,
): BrunoTableRowPipelinePublication<TRow> {
  const complete = isCompleteSource(source);
  const invalid =
    source.invalidRows !== undefined
      ? Object.freeze({
          kind: "invalid-rows" as const,
          receivedRows: source.invalidRows,
        })
      : source.invalidLifecycle !== undefined
        ? Object.freeze({
            kind: "invalid-lifecycle" as const,
            field: source.invalidLifecycle,
          })
        : source.invalidStatus !== undefined
          ? Object.freeze({
              kind: "invalid-status" as const,
              receivedStatus: source.invalidStatus,
            })
          : (source.status === "ready" || source.status === "stale") && !complete
            ? Object.freeze({
                kind: "row-count-mismatch" as const,
                expectedRows: source.totalRows,
                receivedRows: source.rows.length,
              })
            : undefined;
  const coherentResult =
    source.invalidRows === undefined &&
    source.invalidLifecycle === undefined &&
    source.invalidStatus === undefined &&
    complete &&
    source.status !== "loading"
      ? createCoherent(source.rows, getRowId, columns, previousCoherent, resolveRowIds, valueCache)
      : undefined;
  const terminal = source.status === "closed" || source.status === "error";
  const currentCoherent = coherentResult?.coherent;
  const retainPrevious = retainsPreviousRows(source);
  const rejectCurrent = queryRejection !== undefined && retainPrevious;
  const useFallback =
    fallbackCoherent !== undefined &&
    retainPrevious &&
    (queryRejection !== undefined ||
      currentCoherent === undefined ||
      (terminal && currentCoherent.rows.length === 0));
  const fallbackResult: CoherentResult<TRow> | undefined = useFallback
    ? queryRejection === undefined
      ? createCoherent(
          fallbackCoherent.rows,
          getRowId,
          columns,
          previousCoherent,
          resolveRowIds,
          valueCache,
        )
      : Object.freeze({ coherent: fallbackCoherent })
    : undefined;
  const coherent = rejectCurrent
    ? fallbackResult?.coherent
    : useFallback
      ? fallbackResult?.coherent
      : currentCoherent;
  const hasCoherentRows = coherent !== undefined && (!terminal || coherent.rows.length > 0);
  const resolvedInvalid =
    invalid ?? queryRejection ?? coherentResult?.invalid ?? fallbackResult?.invalid;
  return Object.freeze({
    status: source.status,
    totalRows: source.totalRows,
    version: source.version,
    ...(source.statusCode === undefined ? {} : { statusCode: source.statusCode }),
    ...(source.message === undefined ? {} : { message: source.message }),
    ...(source.retry === undefined ? {} : { retry: source.retry }),
    ...(coherent === undefined ? {} : { rowSpace: coherent }),
    hasCoherentRows,
    ...(resolvedInvalid === undefined ? {} : { invalid: resolvedInvalid }),
  });
}

type CoherentResult<TRow> = Readonly<{
  readonly coherent?: ClientCoherentSnapshot<TRow>;
  readonly invalid?: Readonly<{
    readonly kind: "invalid-value";
    readonly rowIndex: number;
    readonly columnId: string;
    readonly message: string;
  }>;
}>;

function createInitialCoherent<TRow>(
  rows: ClientPersistentSequence<TRow>,
  getRowId: (row: TRow) => BrunoTableRowId,
  columns: readonly CompiledColumn[],
  valueCache: ClientCanonicalValueCache,
): CoherentResult<TRow> {
  const reconciliationDiagnostic = reconciliationListener;
  const reconciliationStartedAt = reconciliationDiagnostic === undefined ? 0 : performance.now();
  const rowIdValues = Array.from<BrunoTableRowId>({ length: rows.length });
  const admittedValues = Array.from<BrunoTableClientAdmittedRow>({ length: rows.length });
  const identityBuckets = new Map<number, Map<BrunoTableRowId, BrunoTableClientAdmittedRow>>();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows.get(index)!;
    const rowId = getRowId(row);
    if (typeof rowId !== "string" || rowId.length === 0) {
      throw new TypeError("BrunoTable getRowId must return a non-empty string.");
    }
    const bucketIndex = clientIdentityBucket(rowId);
    const bucket = identityBuckets.get(bucketIndex) ?? new Map();
    if (bucket.has(rowId)) {
      throw new TypeError(`BrunoTable getRowId returned a duplicate row identity: ${rowId}`);
    }
    const admitted = Object.freeze({ raw: row, rowId, rowIndex: index, values: valueCache });
    rowIdValues[index] = rowId;
    admittedValues[index] = admitted;
    bucket.set(rowId, admitted);
    identityBuckets.set(bucketIndex, bucket);
  }
  reconciliationDiagnostic?.(
    Object.freeze({
      residentRows: rows.length,
      durationMs: Math.max(0, performance.now() - reconciliationStartedAt),
      changedRows: rows.length,
      resolvedRowIds: rows.length,
      identityPatches: rows.length,
      rebuiltSourceSequence: rows.parentToken === undefined,
      rebuiltIdentityIndex: true,
    }),
  );
  return coherentResult(
    rows,
    basePersistentSequence(rowIdValues),
    basePersistentSequence(admittedValues),
    persistentIdentityIndex(identityBuckets),
    new Map(columns.map((column) => [column.columnId, column])),
    getRowId,
    Object.freeze({ rowIdsChanged: true, changedIndexes: EMPTY_ROWS }),
    columns,
  );
}

function createCoherent<TRow>(
  rows: ClientPersistentSequence<TRow>,
  getRowId: (row: TRow) => BrunoTableRowId,
  columns: readonly CompiledColumn[],
  previous: ClientCoherentSnapshot<TRow> | undefined,
  resolveRowIds: boolean,
  valueCache: ClientCanonicalValueCache,
): CoherentResult<TRow> {
  if (previous === undefined) return createInitialCoherent(rows, getRowId, columns, valueCache);
  const resolveCurrentRowIds = resolveRowIds || previous.identityResolver !== getRowId;
  if (!resolveCurrentRowIds && previous.rows === rows && previous.validatedColumns === columns) {
    return Object.freeze({ coherent: previous });
  }
  const reconciliationDiagnostic = reconciliationListener;
  const reconciliationStartedAt = reconciliationDiagnostic === undefined ? 0 : performance.now();
  const sourceChange = persistentSequenceChange(previous.rows, rows);
  const indexesToResolve = resolveCurrentRowIds
    ? Array.from({ length: rows.length }, (_unused, index) => index)
    : sourceChange.changedIndexes;
  const changedIndexSet = new Set([...sourceChange.changedIndexes, ...sourceChange.removedIndexes]);
  const rowIdPatches = new Map<number, BrunoTableRowId>();
  const admittedPatches = new Map<number, BrunoTableClientAdmittedRow>();
  const identityPatches = new Map<BrunoTableRowId, BrunoTableClientAdmittedRow>();
  const removedRowIds = new Set<BrunoTableRowId>();
  const resolvedRowIds = new Set<BrunoTableRowId>();
  let rowIdsChanged = previous.rows.length !== rows.length;
  for (const index of sourceChange.removedIndexes) {
    const removedRowId = previous.rowIds.get(index);
    if (removedRowId !== undefined) removedRowIds.add(removedRowId);
  }
  for (const index of indexesToResolve) {
    const row = rows.get(index)!;
    const previousRowId = previous.rowIds.get(index);
    const rowId = getRowId(row);
    if (typeof rowId !== "string" || rowId.length === 0) {
      throw new TypeError("BrunoTable getRowId must return a non-empty string.");
    }
    if (previousRowId !== undefined && previousRowId !== rowId) {
      removedRowIds.add(previousRowId);
      rowIdsChanged = true;
    }
    const existing = previous.admittedById.get(rowId);
    if (
      resolvedRowIds.has(rowId) ||
      (!resolveCurrentRowIds &&
        existing !== undefined &&
        existing.rowIndex !== index &&
        !changedIndexSet.has(existing.rowIndex))
    ) {
      throw new TypeError(`BrunoTable getRowId returned a duplicate row identity: ${rowId}`);
    }
    resolvedRowIds.add(rowId);
    const previousAdmitted = previous.admittedRows.get(index);
    const admitted =
      previousAdmitted?.raw === row && previousAdmitted !== undefined
        ? previousAdmitted.rowId === rowId
          ? previousAdmitted
          : Object.freeze({ ...previousAdmitted, rowId })
        : Object.freeze({ raw: row, rowId, rowIndex: index, values: valueCache });
    if (previousRowId !== rowId) rowIdPatches.set(index, rowId);
    if (previousAdmitted !== admitted) admittedPatches.set(index, admitted);
    if (previousRowId !== rowId || previousAdmitted !== admitted) {
      identityPatches.set(rowId, admitted);
    }
  }
  const rowIds = patchPersistentSequence(
    previous.rowIds,
    rows.length,
    rowIdPatches,
    sourceChange.changedIndexes,
    (index) => previous.rowIds.get(index) ?? getRowId(rows.get(index)!),
  );
  const patchedAdmittedRows = patchPersistentSequence(
    previous.admittedRows,
    rows.length,
    admittedPatches,
    sourceChange.changedIndexes,
    (index) => {
      const row = rows.get(index)!;
      const rowId = rowIds.get(index)!;
      return Object.freeze({ raw: row, rowId, rowIndex: index, values: valueCache });
    },
  );
  const admittedRows =
    previous.validatedColumns !== columns && patchedAdmittedRows === previous.admittedRows
      ? persistentSequence(
          previous.admittedRows.chunks,
          previous.admittedRows.length,
          sourceChange.changedIndexes,
          previous.admittedRows.token,
        )
      : patchedAdmittedRows;
  const admittedById = patchPersistentIdentityIndex(
    previous.admittedById,
    identityPatches,
    removedRowIds,
  );
  reconciliationDiagnostic?.(
    Object.freeze({
      residentRows: rows.length,
      durationMs: Math.max(0, performance.now() - reconciliationStartedAt),
      changedRows: sourceChange.changedIndexes.length,
      resolvedRowIds: indexesToResolve.length,
      identityPatches: identityPatches.size,
      rebuiltSourceSequence: previous.rows !== rows && rows.parentToken === undefined,
      rebuiltIdentityIndex: false,
    }),
  );
  if (
    !rowIdsChanged &&
    sourceChange.changedIndexes.length === 0 &&
    previous.validatedColumns === columns
  ) {
    return Object.freeze({
      coherent:
        previous.identityResolver === getRowId
          ? previous
          : Object.freeze({
              ...previous,
              identityResolver: getRowId,
              changeFromPrevious: EMPTY_ROW_ORDER_CHANGE,
            }),
    });
  }
  const changeFromPrevious: BrunoTableClientRowOrderChange = Object.freeze({
    rowIdsChanged,
    changedIndexes: sourceChange.changedIndexes,
  });
  const columnsById =
    previous.validatedColumns === columns
      ? previous.columnsById
      : new Map(columns.map((column) => [column.columnId, column]));
  return coherentResult(
    rows,
    rowIds,
    admittedRows,
    admittedById,
    columnsById,
    getRowId,
    changeFromPrevious,
    columns,
  );
}

function coherentResult<TRow>(
  rows: ClientPersistentSequence<TRow>,
  rowIds: ClientPersistentSequence<BrunoTableRowId>,
  admittedRows: ClientPersistentSequence<BrunoTableClientAdmittedRow>,
  admittedById: ClientPersistentIdentityIndex,
  columnsById: ReadonlyMap<string, CompiledColumn>,
  getRowId: (row: TRow) => BrunoTableRowId,
  changeFromPrevious: BrunoTableClientRowOrderChange,
  columns: readonly CompiledColumn[],
): CoherentResult<TRow> {
  return Object.freeze({
    coherent: Object.freeze({
      rows,
      admittedRows,
      rowIds,
      admittedById,
      columnsById,
      totalRows: rows.length,
      loadedRows: rows.length,
      getRowId: (index: number) => rowIds.get(index),
      hasRowId: (rowId: BrunoTableRowId) => admittedById.has(rowId),
      identityResolver: getRowId,
      getRow: (rowId: BrunoTableRowId) => admittedById.get(rowId)?.raw as TRow | undefined,
      getCellValue: (rowId: BrunoTableRowId, columnId: string) => {
        const admitted = admittedById.get(rowId);
        const column = columnsById.get(columnId);
        return admitted === undefined || column === undefined
          ? undefined
          : admitted.values.read(admitted.raw, admitted.rowId, admitted.rowIndex, column);
      },
      changeFromPrevious,
      validatedColumns: columns,
    }),
  });
}

type ClientBoundedValue = Readonly<{
  readonly raw: unknown;
  readonly value: unknown;
  readonly token: object;
}>;

class ClientCanonicalValueCache implements BrunoTableClientValueCache {
  private readonly boundedValuesByRow = new Map<
    BrunoTableRowId,
    Map<CompiledColumn, ClientBoundedValue>
  >();
  private readonly boundedLru = new Map<
    object,
    Readonly<{ rowId: BrunoTableRowId; column: CompiledColumn }>
  >();
  private retainedColumnGroups: readonly (readonly CompiledColumn[] | undefined)[] = Object.freeze(
    [],
  );

  public readonly read = (
    row: unknown,
    rowId: BrunoTableRowId,
    rowIndex: number,
    column: CompiledColumn,
  ): unknown => {
    const bounded = this.readBounded(row, rowId, rowIndex, column);
    if (bounded.found) {
      return bounded.value;
    }
    let value: unknown;
    try {
      value = readCompiledColumnValue(column, row);
    } catch {
      const invalid = createBrunoTableInvalidCellValue(
        invalidValue(rowIndex, column.columnId, "The source value could not be read."),
      );
      this.store(row, rowId, column, invalid);
      return invalid;
    }
    if (value === null || value === undefined) {
      this.store(row, rowId, column, value);
      return value;
    }
    const decoded = column.semantics.decodeRuntime(value);
    if (decoded._tag === "Failure") {
      const invalid = createBrunoTableInvalidCellValue(
        invalidValue(rowIndex, column.columnId, decoded.message),
      );
      this.store(row, rowId, column, invalid);
      return invalid;
    }
    this.store(row, rowId, column, decoded.value);
    return decoded.value;
  };

  public readonly retainRowIds = (hasRowId: (rowId: BrunoTableRowId) => boolean): void => {
    for (const [rowId, values] of this.boundedValuesByRow) {
      if (hasRowId(rowId)) continue;
      for (const entry of values.values()) this.boundedLru.delete(entry.token);
      this.boundedValuesByRow.delete(rowId);
    }
  };

  public readonly retainColumns = (
    ...columnGroups: readonly (readonly CompiledColumn[] | undefined)[]
  ): void => {
    if (
      this.retainedColumnGroups.length === columnGroups.length &&
      this.retainedColumnGroups.every((columns, index) => columns === columnGroups[index])
    ) {
      return;
    }
    this.retainedColumnGroups = Object.freeze(Array.from(columnGroups));
    const retained = new Set(columnGroups.flatMap((columns) => columns ?? EMPTY_COLUMNS));
    let visitedEntries = 0;
    for (const [rowId, values] of this.boundedValuesByRow) {
      for (const [column, entry] of values) {
        visitedEntries += 1;
        if (retained.has(column)) continue;
        values.delete(column);
        this.boundedLru.delete(entry.token);
      }
      if (values.size === 0) this.boundedValuesByRow.delete(rowId);
    }
    valueCachePruneListener?.(visitedEntries);
  };

  private readonly readBounded = (
    row: unknown,
    rowId: BrunoTableRowId,
    rowIndex: number,
    column: CompiledColumn,
  ): Readonly<{ found: true; value: unknown }> | Readonly<{ found: false }> => {
    const values = this.boundedValuesByRow.get(rowId);
    const cached = values?.get(column);
    if (cached === undefined) return NOT_FOUND;
    if (!Object.is(cached.raw, row)) {
      values?.delete(column);
      this.boundedLru.delete(cached.token);
      if (values?.size === 0) this.boundedValuesByRow.delete(rowId);
      return NOT_FOUND;
    }
    this.boundedLru.delete(cached.token);
    this.boundedLru.set(cached.token, { rowId, column });
    const value = currentInvalidRow(cached.value, rowIndex, column.columnId);
    if (value !== cached.value) values?.set(column, Object.freeze({ ...cached, value }));
    return Object.freeze({ found: true, value });
  };

  private readonly store = (
    row: unknown,
    rowId: BrunoTableRowId,
    column: CompiledColumn,
    value: unknown,
  ): void => {
    let values = this.boundedValuesByRow.get(rowId);
    if (values === undefined) {
      values = new Map();
      this.boundedValuesByRow.set(rowId, values);
    }
    const previous = values.get(column);
    if (previous !== undefined) this.boundedLru.delete(previous.token);
    const token = Object.freeze({});
    values.set(column, Object.freeze({ raw: row, value, token }));
    this.boundedLru.set(token, { rowId, column });
    if (this.boundedLru.size <= CLIENT_BOUNDED_VALUE_CACHE_LIMIT) return;
    const oldestToken = this.boundedLru.keys().next().value;
    if (oldestToken === undefined) return;
    const oldest = this.boundedLru.get(oldestToken);
    this.boundedLru.delete(oldestToken);
    if (oldest === undefined) return;
    const oldestValues = this.boundedValuesByRow.get(oldest.rowId);
    if (oldestValues?.get(oldest.column)?.token !== oldestToken) return;
    oldestValues.delete(oldest.column);
    if (oldestValues.size === 0) this.boundedValuesByRow.delete(oldest.rowId);
  };
}

function currentInvalidRow(value: unknown, rowIndex: number, columnId: string): unknown {
  if (!isBrunoTableInvalidCellValue(value) || value.invalid.rowIndex === rowIndex) return value;
  return createBrunoTableInvalidCellValue(invalidValue(rowIndex, columnId, value.invalid.message));
}

function invalidValue(
  rowIndex: number,
  columnId: string,
  message: string,
): NonNullable<CoherentResult<unknown>["invalid"]> {
  return Object.freeze({
    kind: "invalid-value",
    rowIndex,
    columnId,
    message: boundedText(message, 256),
  });
}

function asClientCoherent<TRow>(
  rowSpace: BrunoTableRowSpaceSnapshot<TRow> | undefined,
): ClientCoherentSnapshot<TRow> | undefined {
  if (isClientGroupedRowSpace(rowSpace)) return undefined;
  return rowSpace as ClientCoherentSnapshot<TRow> | undefined;
}

function isClientGroupedRowSpace<TRow>(
  rowSpace: BrunoTableRowSpaceSnapshot<TRow> | undefined,
): boolean {
  return (
    rowSpace !== undefined &&
    "brunoTableClientGrouped" in rowSpace &&
    rowSpace.brunoTableClientGrouped === true
  );
}

type ClientListenerError = Readonly<{ readonly value: unknown }>;

function notifyRowsStoreListeners(
  listeners: Set<() => void>,
  initialError?: ClientListenerError,
): void {
  let firstError = initialError;
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      firstError ??= Object.freeze({ value: error });
    }
  }
  if (firstError !== undefined) throw firstError.value;
}

function notifyEditSourceListeners(
  listeners: Set<(changedRowIds: ReadonlySet<BrunoTableRowId> | undefined) => void>,
  changedRowIds: ReadonlySet<BrunoTableRowId> | undefined,
): void {
  let firstError: ClientListenerError | undefined;
  for (const listener of listeners) {
    try {
      listener(changedRowIds);
    } catch (error) {
      firstError ??= Object.freeze({ value: error });
    }
  }
  if (firstError !== undefined) throw firstError.value;
}

function createProjectionInputSnapshot(
  epoch: number,
  publication: BrunoTableRowPipelinePublication<unknown>,
  columns: readonly CompiledColumn[],
  queryConfiguration: BrunoTableQueryConfiguration,
  groupRowsColumn?: BrunoTableCompiledGroupRowsColumn,
): BrunoTableClientProjectionInputSnapshot {
  const coherent = asClientCoherent(publication.rowSpace);
  const rows = coherent?.admittedRows.asArray() ?? EMPTY_ROWS;
  const rowIds = coherent?.rowIds ?? EMPTY_PERSISTENT_SEQUENCE;
  return Object.freeze({
    epoch,
    publication,
    rows,
    sourceRowIds: Object.freeze({
      authoritative: coherent !== undefined,
      rowIds: rowIds.asArray(),
      token: rowIds.token,
    }),
    columns,
    queryConfiguration,
    groupRowsColumn,
  });
}

function snapshotSource<TRow>(
  source: BrunoTableClientSource<TRow>,
  previous?: ClientSourceSnapshot<TRow>,
  observedRows?: TRow[],
): ClientSourceSnapshot<TRow> {
  const required = snapshotRequiredSourceEnvelope(source);
  if ("invalidLifecycle" in required) {
    return Object.freeze({
      rows: previous?.rows ?? (EMPTY_PERSISTENT_SEQUENCE as ClientPersistentSequence<TRow>),
      totalRows: previous?.totalRows ?? 0,
      version: previous?.version ?? 0,
      status: "error",
      invalidLifecycle: required.invalidLifecycle,
    });
  }
  const { sourceStatus, totalRows, version } = required;
  const status = snapshotSourceStatus(sourceStatus);
  const statusCode = snapshotBrunoTableSourceStatusCode(
    readOptionalSourceField(() => source.statusCode),
  );
  const message = snapshotBrunoTableSourceMessage(readOptionalSourceField(() => source.message));
  const retry = snapshotRetry(readOptionalSourceField(() => source.retry));
  const rowInput =
    status === undefined || status === "loading" ? undefined : snapshotSourceRows(source);
  const inputRows = rowInput?.inputRows;
  const sequenceSnapshot =
    inputRows === undefined
      ? undefined
      : previous === undefined || observedRows === undefined
        ? snapshotBasePersistentSequence(inputRows)
        : snapshotObservedPersistentSequence(inputRows, previous.rows, observedRows);
  const sequenceRows =
    sequenceSnapshot !== undefined && "rows" in sequenceSnapshot
      ? sequenceSnapshot.rows
      : undefined;
  const invalidRows =
    rowInput?.invalidRows ??
    (sequenceSnapshot !== undefined && "invalidRows" in sequenceSnapshot
      ? sequenceSnapshot.invalidRows
      : undefined);
  const rows =
    sequenceRows ?? previous?.rows ?? (EMPTY_PERSISTENT_SEQUENCE as ClientPersistentSequence<TRow>);
  return Object.freeze({
    rows,
    totalRows,
    version,
    status: invalidRows === undefined ? (status ?? "error") : "error",
    ...(status === undefined ? { invalidStatus: describeInvalidStatus(sourceStatus) } : {}),
    ...(invalidRows === undefined ? {} : { invalidRows }),
    ...(inputRows === undefined || invalidRows !== undefined ? {} : { inputRows }),
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(message === undefined ? {} : { message }),
    ...(retry === undefined ? {} : { retry }),
  });
}

type ClientRequiredSourceEnvelope = Readonly<{
  readonly sourceStatus: unknown;
  readonly totalRows: number;
  readonly version: number;
}>;

function snapshotRequiredSourceEnvelope<TRow>(
  source: BrunoTableClientSource<TRow>,
):
  | ClientRequiredSourceEnvelope
  | Readonly<{ readonly invalidLifecycle: "status" | "totalRows" | "version" }> {
  let sourceStatus: unknown;
  try {
    sourceStatus = source.status;
  } catch {
    return Object.freeze({ invalidLifecycle: "status" });
  }
  let totalRows: unknown;
  try {
    totalRows = source.totalRows;
  } catch {
    return Object.freeze({ invalidLifecycle: "totalRows" });
  }
  if (typeof totalRows !== "number" || !Number.isSafeInteger(totalRows) || totalRows < 0) {
    return Object.freeze({ invalidLifecycle: "totalRows" });
  }
  let version: unknown;
  try {
    version = source.version;
  } catch {
    return Object.freeze({ invalidLifecycle: "version" });
  }
  if (typeof version !== "number" || !Number.isFinite(version)) {
    return Object.freeze({ invalidLifecycle: "version" });
  }
  return Object.freeze({ sourceStatus, totalRows, version });
}

function readOptionalSourceField(read: () => unknown): unknown {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function snapshotSourceRows<TRow>(
  source: BrunoTableClientSource<TRow>,
): Readonly<{ readonly inputRows?: readonly TRow[]; readonly invalidRows?: string }> {
  try {
    const rows: unknown = source.rows;
    return Array.isArray(rows)
      ? Object.freeze({ inputRows: rows as readonly TRow[] })
      : Object.freeze({ invalidRows: describeInvalidRows(rows) });
  } catch {
    return Object.freeze({ invalidRows: "unreadable" });
  }
}

function snapshotSourceStatus(value: unknown): BrunoTableSourceStatus | undefined {
  return value === "loading" ||
    value === "ready" ||
    value === "stale" ||
    value === "closed" ||
    value === "error"
    ? value
    : undefined;
}

function describeInvalidStatus(value: unknown): string {
  if (typeof value === "string") return boundedText(value, 128);
  if (value === null) return "null";
  return typeof value;
}

function describeInvalidRows(value: unknown): string {
  if (value === null) return "null";
  return typeof value;
}

function snapshotRetry(value: unknown): BrunoTableClientSource<unknown>["retry"] {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const candidate = value as { readonly run?: unknown; readonly pending?: unknown };
    const run = candidate.run;
    const pending = candidate.pending;
    return typeof run === "function" && typeof pending === "boolean"
      ? Object.freeze({ run: run as (this: void) => void, pending })
      : undefined;
  } catch {
    return undefined;
  }
}

function retainsPreviousRows(source: Pick<ClientSourceSnapshot<unknown>, "status">): boolean {
  return source.status === "stale" || source.status === "closed" || source.status === "error";
}

function refreshRowOrderEvidence<TRow>(
  coherent: ClientCoherentSnapshot<TRow>,
): ClientCoherentSnapshot<TRow> {
  return Object.freeze({
    ...coherent,
    changeFromPrevious: Object.freeze({
      rowIdsChanged: true,
      changedIndexes: EMPTY_ROWS,
    }),
  });
}

function refreshPublicationSource<TRow>(
  publication: BrunoTableRowPipelinePublication<TRow>,
  source: ClientSourceSnapshot<TRow>,
  invalid: BrunoTableRowPipelinePublication<TRow>["invalid"] = publication.invalid,
): BrunoTableRowPipelinePublication<TRow> {
  const terminal = source.status === "closed" || source.status === "error";
  return Object.freeze({
    status: source.status,
    totalRows: source.totalRows,
    version: source.version,
    ...(source.statusCode === undefined ? {} : { statusCode: source.statusCode }),
    ...(source.message === undefined ? {} : { message: source.message }),
    ...(source.retry === undefined ? {} : { retry: source.retry }),
    ...(publication.rowSpace === undefined ? {} : { rowSpace: publication.rowSpace }),
    hasCoherentRows:
      publication.rowSpace !== undefined && (!terminal || publication.rowSpace.loadedRows > 0),
    ...(invalid === undefined ? {} : { invalid }),
  });
}

function retainedSourceInvalidSnapshot<TRow>(
  source: ClientSourceSnapshot<TRow>,
): BrunoTableRowPipelinePublication<TRow>["invalid"] {
  return source.invalidRows !== undefined
    ? Object.freeze({ kind: "invalid-rows" as const, receivedRows: source.invalidRows })
    : source.invalidLifecycle !== undefined
      ? Object.freeze({ kind: "invalid-lifecycle" as const, field: source.invalidLifecycle })
      : source.invalidStatus !== undefined
        ? Object.freeze({ kind: "invalid-status" as const, receivedStatus: source.invalidStatus })
        : undefined;
}

function hasInvalidSourceEvidence<TRow>(source: ClientSourceSnapshot<TRow>): boolean {
  return (
    source.invalidRows !== undefined ||
    source.invalidLifecycle !== undefined ||
    source.invalidStatus !== undefined ||
    ((source.status === "ready" || source.status === "stale") && !isCompleteSource(source))
  );
}

function rejectPublicationRows<TRow>(
  publication: BrunoTableRowPipelinePublication<TRow>,
  invalid: NonNullable<BrunoTableRowPipelinePublication<TRow>["invalid"]>,
): BrunoTableRowPipelinePublication<TRow> {
  return Object.freeze({
    status: publication.status,
    totalRows: publication.totalRows,
    version: publication.version,
    ...(publication.statusCode === undefined ? {} : { statusCode: publication.statusCode }),
    ...(publication.message === undefined ? {} : { message: publication.message }),
    ...(publication.retry === undefined ? {} : { retry: publication.retry }),
    hasCoherentRows: false,
    invalid,
  });
}

function reconfigureFallback<TRow>(
  fallback: ClientCoherentSnapshot<TRow> | undefined,
  getRowId: (row: TRow) => BrunoTableRowId,
  columns: readonly CompiledColumn[],
  valueCache: ClientCanonicalValueCache,
): ClientCoherentSnapshot<TRow> | undefined {
  return fallback === undefined
    ? undefined
    : createCoherent(
        fallback.rows,
        getRowId,
        columns,
        fallback,
        fallback.identityResolver !== getRowId,
        valueCache,
      ).coherent;
}

function nextCoherent<TRow>(
  previous: ClientCoherentSnapshot<TRow> | undefined,
  publication: BrunoTableRowPipelinePublication<TRow>,
): ClientCoherentSnapshot<TRow> | undefined {
  const next = asClientCoherent(publication.rowSpace);
  return (
    next ??
    (publication.status === "loading" || publication.invalid !== undefined ? previous : undefined)
  );
}

function boundedText(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit);
}

function isCompleteSource<TRow>(source: ClientSourceSnapshot<TRow>): boolean {
  return (
    Number.isSafeInteger(source.totalRows) &&
    source.totalRows >= 0 &&
    source.rows.length === source.totalRows
  );
}
