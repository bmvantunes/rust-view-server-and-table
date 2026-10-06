import type {
  BrunoTableJsonValue,
  BrunoTableRowId,
  BrunoTableSourceRetry,
  BrunoTableSourceStatus,
} from "../public-types";
import type { CompiledColumn } from "./compile-columns";
import {
  BRUNO_TABLE_DEFAULT_GROUP_ROWS_COLUMN_WIDTH,
  BRUNO_TABLE_MAX_COLUMN_WIDTH,
  BRUNO_TABLE_MIN_COLUMN_WIDTH,
  applyBrunoTableGridCommand,
  getBrunoTableColumnWidthBounds,
  getBrunoTableColumnLayoutSnapshot,
  isBrunoTableColumnLayoutCommand,
  reconcileBrunoTableColumnLayout,
  type BrunoTableColumnLayoutSnapshot,
  type BrunoTableColumnLayoutState,
  type BrunoTableGridCommand,
} from "./column-management";
import type {
  BrunoTableClientFilterCollection,
  BrunoTableFilterComplexity,
  BrunoTableOrderBy,
} from "./grid-query";
import {
  compileClientFilterCollection,
  normalizeBrunoTableFilterText,
  reconcileBrunoTableOrderBy,
  removeClientFilterColumn,
  replaceClientFilterColumn,
  restoreClientFilterColumn,
  sameBrunoTableFilterColumn,
  sameBrunoTableFilterCollections,
} from "./grid-query";
import { recordBrunoTableGridCommand } from "./grid-command-instrumentation";
import {
  recordBrunoTableColumnCommandSubscriptionNotification,
  recordBrunoTableColumnFilterSubscriptionEvent,
  recordBrunoTableReviewCellSubscription,
} from "./grid-subscription-instrumentation";
import { recordBrunoTableClientQueryTransition } from "./render-instrumentation";
import {
  BRUNO_TABLE_ROWS_COLUMN_ID,
  isBrunoTableServerGroupedRow,
  type BrunoTableServerGroupedRowSnapshot,
} from "./grouped-row";
import { isBrunoTableQuickFilterTextWithinLimit } from "./quick-filter";
import {
  applyBrunoTableSortingCommand,
  isBrunoTableSortingCommand,
  type BrunoTableSortingCommand,
} from "./sorting";
import {
  createBrunoTableGridPreferences,
  createBrunoTablePersistedState,
} from "./grid-preferences";

type Listener = () => void;
type RowChangeListener = (changedRowIds: ReadonlySet<BrunoTableRowId> | undefined) => void;
/**
 * Optional editor-owned gate for commands that can change the filtered row projection.
 * The registered editor owns parsing, validation, and focus restoration; returning false
 * rejects the filter command before it is instrumented or published. Client editing is
 * intentionally not installed by the current read-only filter slice, but this seam keeps
 * future editor capabilities out of the filter controls and command implementations.
 */
export type BrunoTableActiveEditorCommitGate = () => boolean;
export type BrunoTableEditCommandHandler = (
  command: Extract<BrunoTableGridCommand, { readonly type: `edits.${string}` }>,
) => boolean;

export type BrunoTableGridPreferencesRuntimeOptions = Readonly<{
  readonly initialPersistedState?: unknown;
  readonly grouping?: boolean;
  readonly groupRowsWidth?: number;
  readonly beforeGroupingChange?: (entering: boolean) => void;
  readonly getOnPersistChange?: () =>
    | ((state: Readonly<Record<string, BrunoTableJsonValue>>) => void)
    | undefined;
}>;

function isBrunoTableFilterCommand(command: BrunoTableGridCommand): boolean {
  switch (command.type) {
    case "column.filter.clear":
    case "column.filters.clear":
    case "column.filter.reset":
    case "column.filter.replace":
    case "quick-filter.replace":
      return true;
    case "column.resize.commit":
    case "column.reorder.commit":
    case "column.visibility.commit":
    case "column.pin.commit":
    case "column.reset.order":
    case "column.reset.widths":
    case "column.reset.visibility":
    case "column.reset.pinning":
    case "column.reset.layout":
    case "column.sort.toggle":
    case "sorting.add":
    case "sorting.remove":
    case "sorting.move":
    case "sorting.reset":
    case "grouping.add":
    case "grouping.remove":
    case "grouping.move":
    case "edits.reset":
    case "edits.undo":
    case "edits.redo":
      return false;
    default:
      return assertNeverBrunoTableGridCommand(command);
  }
}

function isBrunoTableDurablePreferenceCommand(command: BrunoTableGridCommand): boolean {
  switch (command.type) {
    case "column.resize.commit":
    case "column.reorder.commit":
    case "column.visibility.commit":
    case "column.pin.commit":
    case "column.reset.order":
    case "column.reset.widths":
    case "column.reset.visibility":
    case "column.reset.pinning":
    case "column.reset.layout":
    case "column.sort.toggle":
    case "sorting.add":
    case "sorting.remove":
    case "sorting.move":
    case "sorting.reset":
    case "column.filter.clear":
    case "column.filters.clear":
    case "column.filter.reset":
    case "column.filter.replace":
    case "grouping.add":
    case "grouping.remove":
    case "grouping.move":
      return true;
    case "quick-filter.replace":
    case "edits.reset":
    case "edits.undo":
    case "edits.redo":
      return false;
    default:
      return assertNeverBrunoTableGridCommand(command);
  }
}

function assertNeverBrunoTableGridCommand(value: never): never {
  throw new TypeError(`Unsupported BrunoTable grid command: ${String(value)}`);
}

export type BrunoTableInvalidSourceSnapshot =
  | Readonly<{
      readonly kind: "row-count-mismatch";
      readonly expectedRows: number;
      readonly receivedRows: number;
    }>
  | Readonly<{
      readonly kind: "invalid-value";
      readonly rowIndex: number;
      readonly columnId: string;
      readonly message: string;
    }>
  | Readonly<{
      readonly kind: "invalid-group";
      readonly columnId: string;
      readonly message: string;
    }>
  | Readonly<{
      readonly kind: "invalid-status";
      readonly receivedStatus: string;
    }>
  | Readonly<{
      readonly kind: "invalid-lifecycle";
      readonly field: "status" | "totalRows" | "version";
    }>
  | Readonly<{
      readonly kind: "invalid-rows";
      readonly receivedRows: string;
    }>;

const BRUNO_TABLE_INVALID_CELL_VALUE: unique symbol = Symbol("BrunoTableInvalidCellValue");
const BRUNO_TABLE_INVALID_CELL_VALUES = new WeakSet<object>();

export type BrunoTableInvalidCellValue = Readonly<{
  readonly [BRUNO_TABLE_INVALID_CELL_VALUE]: true;
  readonly invalid: Extract<BrunoTableInvalidSourceSnapshot, { readonly kind: "invalid-value" }>;
}>;

export type BrunoTableClientProjectionInvalid = Extract<
  BrunoTableInvalidSourceSnapshot,
  { readonly kind: "invalid-value" | "invalid-group" }
>;

export function createBrunoTableInvalidCellValue(
  invalid: BrunoTableInvalidCellValue["invalid"],
): BrunoTableInvalidCellValue {
  const value = Object.freeze({ [BRUNO_TABLE_INVALID_CELL_VALUE]: true as const, invalid });
  BRUNO_TABLE_INVALID_CELL_VALUES.add(value);
  return value;
}

export function isBrunoTableInvalidCellValue(value: unknown): value is BrunoTableInvalidCellValue {
  return typeof value === "object" && value !== null && BRUNO_TABLE_INVALID_CELL_VALUES.has(value);
}

export type BrunoTableChromeSnapshot = Readonly<{
  readonly status: BrunoTableSourceStatus;
  readonly statusCode?: string;
  readonly message?: string;
  readonly retry?: BrunoTableSourceRetry;
  readonly hasCoherentRows: boolean;
  readonly invalid?: BrunoTableInvalidSourceSnapshot;
}>;

export type BrunoTableSourceSnapshot = Readonly<{
  readonly totalRows: number;
  readonly loadedRows: number;
}>;

export type BrunoTableSourceVersionSnapshot = Readonly<{
  readonly version: number;
}>;

export type BrunoTableBodySnapshot =
  | Readonly<{ readonly kind: "rows"; readonly ariaRowCount?: number }>
  | Readonly<{
      readonly kind: "loading";
      readonly totalRows: number;
      readonly ariaRowCount?: number;
    }>
  | Readonly<{ readonly kind: "invalid" }>
  | Readonly<{ readonly kind: "empty" }>;

export type BrunoTableQueryNavigationMode =
  | "reset"
  | "reconcile"
  | "clear"
  | "projection-reset"
  | "restore";

export const BRUNO_TABLE_RAW_CLIENT_PROJECTION_LAYOUT_KEY: string = JSON.stringify(["raw", []]);

export type BrunoTableRowSpaceSnapshot<TRow> = Readonly<{
  readonly totalRows: number;
  readonly loadedRows: number;
  readonly getRowId: (index: number) => BrunoTableRowId | undefined;
  readonly getRow: (rowId: BrunoTableRowId) => TRow | undefined;
  readonly getCellValue: (rowId: BrunoTableRowId, columnId: string) => unknown;
}>;

type BrunoTableInstalledClientProjectionBase = Readonly<{
  readonly epoch: number;
  readonly layoutKey: string;
  readonly groupBy: readonly string[];
  readonly columns: readonly CompiledColumn[];
  readonly rowIds: readonly BrunoTableRowId[];
  readonly rowSpace: Readonly<{
    readonly totalRows: number;
    readonly getRowId: (index: number) => string | undefined;
    readonly findRowIndex: (rowId: string) => number | undefined;
    readonly setRequiredRange: (start: number, end: number) => void;
  }>;
  /** Server projections keep sparse rowspace authority in their dedicated pipeline subscription. */
  readonly rowSpaceAuthority?: "pipeline";
  readonly queryGeneration: number;
  readonly queryNavigationMode: BrunoTableQueryNavigationMode;
  /** Stable semantic/layout revision for the installed presentation columns. */
  readonly presentationKey: string;
}>;

export type BrunoTableInstalledClientProjectionSnapshot =
  | (BrunoTableInstalledClientProjectionBase & Readonly<{ readonly kind: "raw" | "grouped" }>)
  | (BrunoTableInstalledClientProjectionBase &
      Readonly<{
        readonly kind: "invalid";
        readonly invalid: BrunoTableClientProjectionInvalid;
      }>);

export type BrunoTableInstalledGroupingStructureSnapshot = Readonly<{
  readonly layoutKey: string;
  readonly presentationKey: string;
  readonly groupBy: readonly string[];
  /** Installed grouped presentation structure; absent for the raw projection. */
  readonly columns: readonly CompiledColumn[] | undefined;
}>;

type WithoutClientProjectionEpoch<T> = T extends unknown ? Omit<T, "epoch"> : never;
type BrunoTableClientProjectionPublication =
  WithoutClientProjectionEpoch<BrunoTableInstalledClientProjectionSnapshot>;

export type BrunoTableRuntimeView = {
  /** Private atomic Client projection epoch; absent for Server and before Client installation. */
  readonly getInstalledClientProjectionSnapshot: () =>
    | BrunoTableInstalledClientProjectionSnapshot
    | undefined;
  readonly subscribeInstalledClientProjection: (listener: Listener) => () => void;
  readonly getInstalledGroupingStructureSnapshot: () => BrunoTableInstalledGroupingStructureSnapshot;
  readonly subscribeInstalledGroupingStructure: (listener: Listener) => () => void;
  readonly getInstalledRowsHeaderNameSnapshot: () => string;
  readonly subscribeInstalledRowsPresentation: (listener: Listener) => () => void;
  readonly getChromeSnapshot: () => BrunoTableChromeSnapshot;
  readonly getSourceSnapshot: () => BrunoTableSourceSnapshot;
  readonly getSourceVersionSnapshot: () => BrunoTableSourceVersionSnapshot;
  readonly getBodySnapshot: () => BrunoTableBodySnapshot;
  readonly getRowSpaceSnapshot: () => BrunoTableRowSpaceSnapshot<unknown> | undefined;
  readonly getRowSnapshot: (rowId: BrunoTableRowId) => unknown;
  readonly getRowPresentationSnapshot: (rowId: BrunoTableRowId) => BrunoTableRowSnapshot;
  readonly getRowCellSnapshot: (
    rowId: BrunoTableRowId,
    columnId: string,
  ) => BrunoTableRowCellSnapshot;
  readonly getCellSnapshot: (rowId: BrunoTableRowId, columnId: string) => BrunoTableCellSnapshot;
  readonly getCellValueSnapshot: (rowId: BrunoTableRowId, columnId: string) => unknown;
  readonly captureCellCommandReader: () => (
    rowId: BrunoTableRowId,
    columnId: string,
  ) => BrunoTableCellSnapshot;
  readonly getCellCacheDiagnosticSnapshot: () => Readonly<{
    readonly installed: number;
    readonly pending: number;
  }>;
  readonly getColumnCommandSnapshot: (columnId: string) => BrunoTableColumnCommandSnapshot;
  readonly getColumnFilterSnapshot: (columnId: string) => unknown;
  readonly getColumnFilterVersionSnapshot: (columnId: string) => number;
  /** Invalidates queued editor candidates even when a Clear/Reset command is a semantic no-op. */
  readonly getColumnFilterCommandEpochSnapshot: (columnId: string) => number;
  readonly getFilterComplexitySnapshot: () => BrunoTableFilterComplexity;
  readonly getQuickFilterSnapshot: () => string;
  /** Resets Client filter position for committed raw text changes that preserve semantics. */
  readonly getFilterPositionResetEpochSnapshot: () => number;
  /** Invalidates queued Quick Filter candidates when any Quick Filter command commits. */
  readonly getQuickFilterCommandEpochSnapshot: () => number;
  readonly getQuickFilterFieldsSnapshot: () => readonly string[];
  readonly getQuerySnapshot: () => BrunoTableQuerySnapshot;
  readonly getGroupBySnapshot: () => readonly string[];
  readonly getGroupingEnabledSnapshot: () => boolean;
  readonly getSortingSnapshot: () => BrunoTableOrderBy;
  readonly getLoadedRowCountSnapshot: () => number;
  readonly getActiveFilterCountSnapshot: () => number;
  readonly getActiveSortCountSnapshot: () => number;
  readonly getColumnLayoutSnapshot: () => BrunoTableColumnLayoutSnapshot;
  /** Controlled Client column input; width-only commits do not publish it. */
  readonly getColumnStructureSnapshot: () => BrunoTableColumnLayoutSnapshot;
  readonly subscribeChrome: (listener: Listener) => () => void;
  readonly subscribeSource: (listener: Listener) => () => void;
  readonly subscribeSourceVersion: (listener: Listener) => () => void;
  readonly subscribeBody: (listener: Listener) => () => void;
  readonly subscribeRowSpace: (listener: Listener) => () => void;
  /** Private causal row-change seam for non-React indexes. */
  readonly subscribeRowChanges: (listener: RowChangeListener) => () => void;
  readonly subscribeRow: (rowId: BrunoTableRowId, listener: Listener) => () => void;
  readonly subscribeRowCell: (
    rowId: BrunoTableRowId,
    columnId: string,
    listener: Listener,
  ) => () => void;
  readonly subscribeCell: (
    rowId: BrunoTableRowId,
    columnId: string,
    listener: Listener,
  ) => () => void;
  readonly subscribeColumnCommands: (columnId: string, listener: Listener) => () => void;
  readonly subscribeColumnFilter: (columnId: string, listener: Listener) => () => void;
  readonly subscribeColumnFilterCommandEpoch: (columnId: string, listener: Listener) => () => void;
  readonly subscribeQuickFilter: (listener: Listener) => () => void;
  readonly subscribeFilterPositionReset: (listener: Listener) => () => void;
  readonly subscribeQuickFilterCommandEpoch: (listener: Listener) => () => void;
  readonly subscribeQuery: (listener: Listener) => () => void;
  readonly subscribeGroupBy: (listener: Listener) => () => void;
  /** Imperative invalidation sink for same-value Quick Filter command cancellation. */
  readonly registerQuickFilterInvalidation: (listener: Listener) => () => void;
  readonly subscribeSorting: (listener: Listener) => () => void;
  readonly subscribeLoadedRowCount: (listener: Listener) => () => void;
  readonly subscribeActiveFilterCount: (listener: Listener) => () => void;
  readonly subscribeActiveSortCount: (listener: Listener) => () => void;
  readonly subscribeColumnLayout: (listener: Listener) => () => void;
  readonly subscribeColumnStructure: (listener: Listener) => () => void;
  readonly registerActiveEditorCommitGate: (gate: BrunoTableActiveEditorCommitGate) => () => void;
  readonly registerEditCommandHandler: (handler: BrunoTableEditCommandHandler) => () => void;
  readonly dispatchGridCommand: (command: BrunoTableGridCommand) => boolean;
  readonly toggleColumnSort: (columnId: string, multi: boolean) => void;
  readonly clearColumnFilters: (columnId: string) => void;
  readonly resetColumnFilters: (columnId: string) => void;
  readonly retry: () => void;
};

export type BrunoTableRowPipelineRuntimeView = BrunoTableRuntimeView & {
  readonly getFilterSnapshot: () => BrunoTableFilterSnapshot;
  readonly subscribeFilter: (listener: Listener) => () => void;
  /**
   * Accepts authoritative Adapter input during runtime notifications. When a publication pass is
   * already active, that pass completes first; re-entrant publications then apply in call order
   * before the outer publication returns or rethrows its first read/listener failure.
   */
  readonly publishRowPipeline: (publication: BrunoTableRowPipelinePublication<unknown>) => void;
  readonly reconcileClientProjection: (
    publication: BrunoTableRowPipelinePublication<unknown>,
    columns: readonly CompiledColumn[],
    queryConfiguration: BrunoTableQueryConfiguration,
    groupRowsWidth: number,
  ) => void;
  readonly stageClientProjectionConfiguration: (
    columns: readonly CompiledColumn[],
    queryConfiguration: BrunoTableQueryConfiguration,
    groupRowsWidth: number,
  ) => BrunoTableClientProjectionConfigurationSnapshot;
};

export type BrunoTableClientProjectionConfigurationSnapshot = Readonly<{
  readonly query: BrunoTableQuerySnapshot;
  readonly columnLayout: BrunoTableColumnLayoutSnapshot;
  readonly quickFilterFields: readonly string[];
}>;

export type BrunoTableFilterSnapshot = Readonly<{
  readonly columns: readonly CompiledColumn[];
  readonly filters: readonly unknown[];
  /** Runtime-owned immutable lookup used by active-filter review without reparsing the root AST. */
  readonly filtersByColumn: Readonly<{
    readonly get: (columnId: string) => unknown;
  }>;
  /** Bounded label compiled with the admitted column expression for active-filter review. */
  readonly activeFilterLabelsByColumn: Readonly<{
    readonly get: (columnId: string) => string | undefined;
  }>;
  readonly quickFilter: string;
}>;

export type BrunoTableQuerySnapshot = Readonly<{
  readonly columns: readonly CompiledColumn[];
  readonly filters: readonly unknown[];
  readonly filterCollection: BrunoTableClientFilterCollection;
  readonly quickFilter: string;
  readonly orderBy: BrunoTableOrderBy;
  readonly groupBy: readonly string[];
  readonly groupOrderBy: BrunoTableOrderBy;
  readonly rowsWidth?: number;
  readonly generation: number;
  /** Immutable Active Cell policy for this exact query generation. */
  readonly navigationMode: BrunoTableQueryNavigationMode;
}>;

function createFilterSnapshot(
  query: BrunoTableQuerySnapshot,
  filtersByColumn: ReadonlyMap<string, unknown>,
  activeFilterLabelsByColumn: ReadonlyMap<string, string>,
): BrunoTableFilterSnapshot {
  return Object.freeze({
    columns: query.columns,
    filters: query.filters,
    filtersByColumn: createFilterColumnIndex(filtersByColumn),
    activeFilterLabelsByColumn: createFilterLabelIndex(activeFilterLabelsByColumn),
    quickFilter: query.quickFilter,
  });
}

function createFilterColumnIndex(
  filtersByColumn: ReadonlyMap<string, unknown>,
): Readonly<{ readonly get: (columnId: string) => unknown }> {
  const snapshot = new Map(filtersByColumn);
  return Object.freeze({ get: (columnId: string): unknown => snapshot.get(columnId) });
}

function createFilterLabelIndex(
  activeFilterLabelsByColumn: ReadonlyMap<string, string>,
): Readonly<{ readonly get: (columnId: string) => string | undefined }> {
  const snapshot = new Map(activeFilterLabelsByColumn);
  return Object.freeze({
    get: (columnId: string): string | undefined => snapshot.get(columnId),
  });
}

function createQuerySnapshot(
  columns: readonly CompiledColumn[],
  filterCollection: BrunoTableClientFilterCollection,
  quickFilter: string,
  orderBy: BrunoTableOrderBy,
  generation: number,
  navigationMode: BrunoTableQueryNavigationMode = "reset",
  groupBy: readonly string[] = EMPTY_GROUPING,
  groupOrderBy: BrunoTableOrderBy = EMPTY_GROUPING,
  rowsWidth?: number,
): BrunoTableQuerySnapshot {
  const snapshot = {
    columns,
    filters: filterCollection.filters,
    quickFilter,
    orderBy,
    generation,
  } as BrunoTableQuerySnapshot & { filterCollection: BrunoTableClientFilterCollection };
  Object.defineProperty(snapshot, "filterCollection", {
    configurable: false,
    enumerable: false,
    value: filterCollection,
    writable: false,
  });
  Object.defineProperty(snapshot, "navigationMode", {
    configurable: false,
    enumerable: false,
    value: navigationMode,
    writable: false,
  });
  Object.defineProperty(snapshot, "groupBy", {
    configurable: false,
    enumerable: false,
    value: groupBy,
    writable: false,
  });
  Object.defineProperty(snapshot, "groupOrderBy", {
    configurable: false,
    enumerable: false,
    value: groupOrderBy,
    writable: false,
  });
  if (rowsWidth !== undefined) {
    Object.defineProperty(snapshot, "rowsWidth", {
      configurable: false,
      enumerable: false,
      value: rowsWidth,
      writable: false,
    });
  }
  return Object.freeze(snapshot);
}

export type BrunoTableQueryConfiguration = Readonly<{
  readonly baselineFilters: readonly unknown[];
  readonly baselineFilterCollection?: BrunoTableClientFilterCollection;
  readonly baselineOrderBy: BrunoTableOrderBy;
  readonly quickFilterFields?: readonly string[];
}>;

export type BrunoTableColumnCommandSnapshot = Readonly<{
  readonly sortable: boolean;
  readonly sortDirection?: "asc" | "desc";
  readonly sortPriority?: number;
  readonly filterActive: boolean;
  readonly filterBaselineAvailable: boolean;
  readonly visible: boolean;
  readonly pinned?: "start" | "end";
  readonly width: number;
  readonly minWidth: number;
  readonly maxWidth: number;
}>;

const BODY_ROWS: BrunoTableBodySnapshot = Object.freeze({ kind: "rows" });
const BODY_INVALID: BrunoTableBodySnapshot = Object.freeze({ kind: "invalid" });
const BODY_EMPTY: BrunoTableBodySnapshot = Object.freeze({ kind: "empty" });
const EMPTY_COLUMN_COMMAND: BrunoTableColumnCommandSnapshot = Object.freeze({
  sortable: false,
  filterActive: false,
  filterBaselineAvailable: false,
  visible: false,
  width: 0,
  minWidth: 0,
  maxWidth: 0,
});

export type BrunoTableRowPipelinePublication<TRow> = Readonly<{
  readonly status: BrunoTableSourceStatus;
  readonly totalRows: number;
  /** Private accessibility count for non-authoritative loading geometry. */
  readonly loadingAriaRowCount?: number;
  readonly version: number;
  readonly statusCode?: string;
  readonly message?: string;
  readonly retry?: BrunoTableSourceRetry;
  readonly rowSpace?: BrunoTableRowSpaceSnapshot<TRow>;
  /** Private same-generation value hint; absence requires a complete reconciliation. */
  readonly changedRowIds?: ReadonlySet<BrunoTableRowId>;
  readonly hasCoherentRows: boolean;
  readonly invalid?: BrunoTableInvalidSourceSnapshot;
  /** Private complete Client projection candidate installed atomically with this publication. */
  readonly clientProjection?: BrunoTableClientProjectionPublication | null;
}>;

type RuntimeState<TRow> = Readonly<{
  readonly chrome: BrunoTableChromeSnapshot;
  readonly source: BrunoTableSourceSnapshot;
  readonly sourceVersion: BrunoTableSourceVersionSnapshot;
  readonly body: BrunoTableBodySnapshot;
  readonly rowSpace: BrunoTableRowSpaceSnapshot<TRow> | undefined;
}>;

export type BrunoTableCellSnapshot =
  | Readonly<{
      readonly kind: "available";
      readonly column: CompiledColumn | undefined;
      readonly rowPresent: boolean;
      readonly value: unknown;
    }>
  | Readonly<{
      readonly kind: "unavailable";
      readonly column: CompiledColumn | undefined;
      readonly value: undefined;
    }>;

type CachedCellSnapshot = Readonly<{
  readonly snapshot: BrunoTableCellSnapshot;
  readonly publicationEpoch: number;
}>;

export type BrunoTableRowSnapshot =
  | Readonly<{
      readonly kind: "available";
      readonly rowSpace: BrunoTableRowSpaceSnapshot<unknown> | undefined;
      readonly row: unknown;
    }>
  | Readonly<{
      readonly kind: "unavailable";
      readonly rowSpace: BrunoTableRowSpaceSnapshot<unknown> | undefined;
      readonly row: undefined;
    }>;

export type BrunoTableRowCellSnapshot =
  | Readonly<{
      readonly kind: "available";
      readonly column: CompiledColumn | undefined;
      readonly rowSpace: BrunoTableRowSpaceSnapshot<unknown> | undefined;
      readonly row: unknown;
      readonly value: unknown;
    }>
  | Readonly<{
      readonly kind: "unavailable";
      readonly column: CompiledColumn | undefined;
      readonly rowSpace: BrunoTableRowSpaceSnapshot<unknown> | undefined;
      readonly row: undefined;
      readonly value: undefined;
    }>;

const PENDING_CELL_SNAPSHOT_LIMIT = 4_096;
const EMPTY_QUICK_FILTER_FIELDS: readonly string[] = Object.freeze([]);
const EMPTY_GROUPING: readonly never[] = Object.freeze([]);
const RAW_INSTALLED_GROUPING_STRUCTURE: BrunoTableInstalledGroupingStructureSnapshot =
  Object.freeze({
    layoutKey: BRUNO_TABLE_RAW_CLIENT_PROJECTION_LAYOUT_KEY,
    presentationKey: BRUNO_TABLE_RAW_CLIENT_PROJECTION_LAYOUT_KEY,
    groupBy: EMPTY_GROUPING,
    columns: undefined,
  });

type QueryTransition = Readonly<{
  readonly filterChanged: boolean;
  readonly queryChanged: boolean;
  readonly quickFilterChanged: boolean;
  readonly sortingChanged: boolean;
  readonly groupByChanged: boolean;
  readonly activeFilterCountChanged: boolean;
  readonly activeSortCountChanged: boolean;
  readonly previousCommands: ReadonlyMap<string, BrunoTableColumnCommandSnapshot>;
  readonly previousColumnFilters: ReadonlyMap<string, unknown>;
}>;

type ColumnConfiguration = Readonly<{
  readonly columns: readonly CompiledColumn[];
  readonly baselineFilters: readonly unknown[];
  readonly baselineFilterCollection: BrunoTableClientFilterCollection;
  readonly baselineOrderBy: BrunoTableOrderBy;
  readonly quickFilterFields: readonly string[];
  readonly groupingEnabled: boolean;
  readonly groupRowsWidth: number;
  readonly rowsWidth?: number;
  readonly query: BrunoTableQuerySnapshot;
  readonly columnCommands: Map<string, BrunoTableColumnCommandSnapshot>;
  readonly columnLayout: BrunoTableColumnLayoutState;
  readonly invalidatedColumnIds: readonly string[];
  readonly transition: QueryTransition;
}>;

type PublicationConfiguration = Readonly<{
  readonly columns: readonly CompiledColumn[];
  readonly queryConfiguration: BrunoTableQueryConfiguration;
  readonly groupRowsWidth: number;
}>;

type QueuedPublication<TRow> = Readonly<{
  readonly publication: BrunoTableRowPipelinePublication<TRow>;
  readonly configuration: PublicationConfiguration;
}>;

function activeFilterCount(
  filterCollection: BrunoTableClientFilterCollection,
  quickFilter: string,
): number {
  return (
    filterCollection.filters.length +
    (normalizeBrunoTableFilterText(quickFilter).length === 0 ? 0 : 1)
  );
}

export class BrunoTableGridRuntime<TRow> {
  private readonly chromeListeners = new Set<Listener>();
  private readonly sourceListeners = new Set<Listener>();
  private readonly sourceVersionListeners = new Set<Listener>();
  private readonly bodyListeners = new Set<Listener>();
  private readonly rowSpaceListeners = new Set<Listener>();
  private readonly rowChangeListeners = new Set<RowChangeListener>();
  private readonly rowListeners = new Map<BrunoTableRowId, Set<Listener>>();
  private readonly rowSnapshots = new Map<BrunoTableRowId, BrunoTableRowSnapshot>();
  private readonly rowCellListeners = new Map<BrunoTableRowId, Map<string, Set<Listener>>>();
  private readonly rowCellSnapshots = new Map<
    BrunoTableRowId,
    Map<string, BrunoTableRowCellSnapshot>
  >();
  private readonly pendingRowCellTokensByRow = new Map<BrunoTableRowId, Map<string, object>>();
  private readonly pendingRowCellLru = new Map<
    object,
    Readonly<{ readonly rowId: BrunoTableRowId; readonly columnId: string }>
  >();
  private readonly cellListeners = new Map<BrunoTableRowId, Map<string, Set<Listener>>>();
  private readonly cellSnapshots = new Map<BrunoTableRowId, Map<string, CachedCellSnapshot>>();
  private cellSnapshotPublicationEpoch = 0;
  private readonly unavailableRows = new Set<BrunoTableRowId>();
  private readonly unavailableRowCellRows = new Set<BrunoTableRowId>();
  private readonly unavailableRowCellCounts = new Map<BrunoTableRowId, number>();
  private readonly unavailableCellRows = new Set<BrunoTableRowId>();
  private readonly unavailableCellCounts = new Map<BrunoTableRowId, number>();
  private readonly pendingCellTokensByRow = new Map<BrunoTableRowId, Map<string, object>>();
  private readonly pendingCellLru = new Map<
    object,
    Readonly<{ rowId: BrunoTableRowId; columnId: string }>
  >();
  private readonly queryListeners = new Set<Listener>();
  private readonly groupByListeners = new Set<Listener>();
  private readonly filterListeners = new Set<Listener>();
  private readonly quickFilterListeners = new Set<Listener>();
  private readonly filterPositionResetListeners = new Set<Listener>();
  private readonly sortingListeners = new Set<Listener>();
  private readonly loadedRowCountListeners = new Set<Listener>();
  private readonly activeFilterCountListeners = new Set<Listener>();
  private readonly activeSortCountListeners = new Set<Listener>();
  private readonly columnCommandListeners = new Map<string, Set<Listener>>();
  private readonly columnFilterListeners = new Map<string, Set<Listener>>();
  private readonly columnFilterCommandEpochListeners = new Map<string, Set<Listener>>();
  private readonly quickFilterCommandEpochListeners = new Set<Listener>();
  private readonly columnLayoutListeners = new Set<Listener>();
  private readonly columnStructureListeners = new Set<Listener>();
  private readonly installedClientProjectionListeners = new Set<Listener>();
  private readonly installedGroupingStructureListeners = new Set<Listener>();
  private readonly installedRowsPresentationListeners = new Set<Listener>();
  private readonly activeEditorCommitGates = new Set<BrunoTableActiveEditorCommitGate>();
  private editCommandHandler: BrunoTableEditCommandHandler | undefined;
  private readonly queuedPublications: (QueuedPublication<TRow> | undefined)[] = [];
  private publishing = false;
  private installedPublicationConfiguration: PublicationConfiguration;
  private logicalPublicationConfiguration: PublicationConfiguration;
  private logicalPublication: BrunoTableRowPipelinePublication<TRow>;
  private view: BrunoTableRowPipelineRuntimeView | undefined;
  private state: RuntimeState<TRow>;
  private publication: BrunoTableRowPipelinePublication<TRow>;
  private columns: readonly CompiledColumn[];
  private columnsById: ReadonlyMap<string, CompiledColumn>;
  private presentationColumnsById: ReadonlyMap<string, CompiledColumn>;
  private installedClientProjection: BrunoTableInstalledClientProjectionSnapshot | undefined;
  private installedGroupingStructure = RAW_INSTALLED_GROUPING_STRUCTURE;
  private installedRowsHeaderName = "Rows";
  private baselineFilters: readonly unknown[];
  private baselineFilterCollection: BrunoTableClientFilterCollection;
  private baselineOrderBy: BrunoTableOrderBy;
  private quickFilterFields: readonly string[];
  private query: BrunoTableQuerySnapshot;
  private filterCollection: BrunoTableClientFilterCollection;
  private filterSnapshot: BrunoTableFilterSnapshot;
  private columnFilterSnapshots: ReadonlyMap<string, unknown>;
  private readonly columnFilterVersions = new Map<string, number>();
  private readonly columnFilterCommandEpochs = new Map<string, number>();
  private quickFilterCommandEpoch = 0;
  private filterPositionResetEpoch = 0;
  private columnLayout: BrunoTableColumnLayoutState;
  private columnLayoutSnapshot: BrunoTableColumnLayoutSnapshot;
  private columnStructureSnapshot: BrunoTableColumnLayoutSnapshot;
  private columnCommands = new Map<string, BrunoTableColumnCommandSnapshot>();
  private readonly tableId: string;
  private readonly groupingPermitted: boolean;
  private groupingEnabled: boolean;
  private hasDurableGroupOrderByIntent: boolean;
  private readonly beforeGroupingChange: ((entering: boolean) => void) | undefined;
  private groupRowsWidth: number;
  private rowsWidth: number | undefined;
  private persistenceRevision = 0;
  private getOnPersistChange: NonNullable<
    BrunoTableGridPreferencesRuntimeOptions["getOnPersistChange"]
  >;

  public constructor(
    publication: BrunoTableRowPipelinePublication<TRow>,
    columns: readonly CompiledColumn[],
    queryConfiguration: BrunoTableQueryConfiguration,
    tableId: string,
    preferencesOptions: BrunoTableGridPreferencesRuntimeOptions = {},
  ) {
    this.tableId = tableId;
    this.groupingPermitted = preferencesOptions.grouping === true;
    this.groupingEnabled =
      this.groupingPermitted && columns.some((column) => column.kind === "field" && column.groupBy);
    this.groupRowsWidth =
      preferencesOptions.groupRowsWidth ?? BRUNO_TABLE_DEFAULT_GROUP_ROWS_COLUMN_WIDTH;
    this.beforeGroupingChange = preferencesOptions.beforeGroupingChange;
    this.columns = columns;
    this.columnsById = indexColumns(columns);
    this.presentationColumnsById = this.columnsById;
    this.baselineFilterCollection =
      queryConfiguration.baselineFilterCollection ??
      compileClientFilterCollection(queryConfiguration.baselineFilters, columns, {
        rejectOverBudget: true,
      });
    this.baselineFilters = this.baselineFilterCollection.filters;
    this.quickFilterFields = queryConfiguration.quickFilterFields ?? EMPTY_QUICK_FILTER_FIELDS;
    const normalizedBaselineOrderBy = reconcileBrunoTableOrderBy(
      queryConfiguration.baselineOrderBy,
      queryConfiguration.baselineOrderBy,
      columns,
    );
    this.baselineOrderBy = sameOrderBy(
      queryConfiguration.baselineOrderBy,
      normalizedBaselineOrderBy,
    )
      ? queryConfiguration.baselineOrderBy
      : normalizedBaselineOrderBy;
    const restoredPreferences = createBrunoTableGridPreferences({
      tableId,
      columns,
      initialFilters: this.baselineFilters,
      initialOrderBy: this.baselineOrderBy,
      initialPersistedState: preferencesOptions.initialPersistedState,
      grouping: this.groupingPermitted,
    });
    this.filterCollection = restoredPreferences.filterCollection;
    this.hasDurableGroupOrderByIntent =
      restoredPreferences.hasDurableGroupOrderByIntent || restoredPreferences.groupBy.length > 0;
    this.getOnPersistChange = preferencesOptions.getOnPersistChange ?? (() => undefined);
    this.rowsWidth = this.groupingEnabled ? restoredPreferences.rowsWidth : undefined;
    this.query = createQuerySnapshot(
      columns,
      this.filterCollection,
      "",
      restoredPreferences.orderBy,
      0,
      restoredPreferences.groupBy.length > 0 ? "restore" : "reset",
      restoredPreferences.groupBy,
      restoredPreferences.groupOrderBy,
      this.rowsWidth,
    );
    this.columnFilterSnapshots = createColumnFilterSnapshots(this.filterCollection);
    this.filterSnapshot = createFilterSnapshot(
      this.query,
      this.columnFilterSnapshots,
      this.filterCollection.activeFilterLabelsByColumn,
    );
    for (const columnId of this.columnFilterSnapshots.keys()) {
      this.columnFilterVersions.set(columnId, 0);
      this.columnFilterCommandEpochs.set(columnId, 0);
    }
    this.columnLayout = restoredPreferences.columnLayout;
    this.columnLayoutSnapshot = getBrunoTableColumnLayoutSnapshot(this.columnLayout);
    this.columnStructureSnapshot = this.columnLayoutSnapshot;
    this.columnCommands = createColumnCommandSnapshots(
      columns,
      this.query,
      this.baselineFilterCollection,
      undefined,
      this.columnLayoutSnapshot,
      this.groupRowsWidth,
    );
    this.publication = publication;
    this.state = this.createState(publication);
    this.installedPublicationConfiguration = Object.freeze({
      columns,
      queryConfiguration: Object.freeze({
        baselineFilters: this.baselineFilters,
        baselineFilterCollection: this.baselineFilterCollection,
        baselineOrderBy: this.baselineOrderBy,
        quickFilterFields: this.quickFilterFields,
      }),
      groupRowsWidth: this.groupRowsWidth,
    });
    this.logicalPublicationConfiguration = this.installedPublicationConfiguration;
    this.logicalPublication = publication;
  }

  public readonly getView = (): BrunoTableRowPipelineRuntimeView => {
    if (this.view === undefined) {
      this.view = Object.freeze({
        getInstalledClientProjectionSnapshot: this.getInstalledClientProjectionSnapshot,
        subscribeInstalledClientProjection: this.subscribeInstalledClientProjection,
        getInstalledGroupingStructureSnapshot: this.getInstalledGroupingStructureSnapshot,
        subscribeInstalledGroupingStructure: this.subscribeInstalledGroupingStructure,
        getInstalledRowsHeaderNameSnapshot: this.getInstalledRowsHeaderNameSnapshot,
        subscribeInstalledRowsPresentation: this.subscribeInstalledRowsPresentation,
        getChromeSnapshot: this.getChromeSnapshot,
        getSourceSnapshot: this.getSourceSnapshot,
        getSourceVersionSnapshot: this.getSourceVersionSnapshot,
        getBodySnapshot: this.getBodySnapshot,
        getRowSpaceSnapshot: this.getRowSpaceSnapshot,
        getRowSnapshot: this.getRowSnapshot,
        getRowPresentationSnapshot: this.getRowPresentationSnapshot,
        getRowCellSnapshot: this.getRowCellSnapshot,
        getCellSnapshot: this.getCellSnapshot,
        getCellValueSnapshot: this.getCellValueSnapshot,
        captureCellCommandReader: this.captureCellCommandReader,
        getCellCacheDiagnosticSnapshot: this.getCellCacheDiagnosticSnapshot,
        getQuerySnapshot: this.getQuerySnapshot,
        getGroupBySnapshot: this.getGroupBySnapshot,
        getGroupingEnabledSnapshot: this.getGroupingEnabledSnapshot,
        getFilterSnapshot: this.getFilterSnapshot,
        getQuickFilterSnapshot: this.getQuickFilterSnapshot,
        getFilterPositionResetEpochSnapshot: this.getFilterPositionResetEpochSnapshot,
        getQuickFilterFieldsSnapshot: this.getQuickFilterFieldsSnapshot,
        getColumnCommandSnapshot: this.getColumnCommandSnapshot,
        getColumnFilterSnapshot: this.getColumnFilterSnapshot,
        getColumnFilterVersionSnapshot: this.getColumnFilterVersionSnapshot,
        getColumnFilterCommandEpochSnapshot: this.getColumnFilterCommandEpochSnapshot,
        getFilterComplexitySnapshot: this.getFilterComplexitySnapshot,
        getSortingSnapshot: this.getSortingSnapshot,
        getLoadedRowCountSnapshot: this.getLoadedRowCountSnapshot,
        getActiveFilterCountSnapshot: this.getActiveFilterCountSnapshot,
        getActiveSortCountSnapshot: this.getActiveSortCountSnapshot,
        getQuickFilterCommandEpochSnapshot: this.getQuickFilterCommandEpochSnapshot,
        getColumnLayoutSnapshot: this.getColumnLayoutSnapshot,
        getColumnStructureSnapshot: this.getColumnStructureSnapshot,
        subscribeChrome: this.subscribeChrome,
        subscribeSource: this.subscribeSource,
        subscribeSourceVersion: this.subscribeSourceVersion,
        subscribeBody: this.subscribeBody,
        subscribeRowSpace: this.subscribeRowSpace,
        subscribeRowChanges: this.subscribeRowChanges,
        subscribeRow: this.subscribeRow,
        subscribeRowCell: this.subscribeRowCell,
        subscribeCell: this.subscribeCell,
        subscribeQuery: this.subscribeQuery,
        subscribeGroupBy: this.subscribeGroupBy,
        subscribeFilter: this.subscribeFilter,
        subscribeQuickFilter: this.subscribeQuickFilter,
        subscribeFilterPositionReset: this.subscribeFilterPositionReset,
        registerQuickFilterInvalidation: this.registerQuickFilterInvalidation,
        publishRowPipeline: this.publishRowPipeline,
        reconcileClientProjection: this.reconcileClientProjection,
        stageClientProjectionConfiguration: this.stageClientProjectionConfiguration,
        subscribeColumnCommands: this.subscribeColumnCommands,
        subscribeColumnFilter: this.subscribeColumnFilter,
        subscribeColumnFilterCommandEpoch: this.subscribeColumnFilterCommandEpoch,
        subscribeSorting: this.subscribeSorting,
        subscribeLoadedRowCount: this.subscribeLoadedRowCount,
        subscribeActiveFilterCount: this.subscribeActiveFilterCount,
        subscribeActiveSortCount: this.subscribeActiveSortCount,
        subscribeColumnLayout: this.subscribeColumnLayout,
        subscribeColumnStructure: this.subscribeColumnStructure,
        registerActiveEditorCommitGate: this.registerActiveEditorCommitGate,
        registerEditCommandHandler: this.registerEditCommandHandler,
        subscribeQuickFilterCommandEpoch: this.subscribeQuickFilterCommandEpoch,
        dispatchGridCommand: this.dispatchGridCommand,
        toggleColumnSort: this.toggleColumnSort,
        clearColumnFilters: this.clearColumnFilters,
        resetColumnFilters: this.resetColumnFilters,
        retry: this.retry,
      });
    }
    return this.view;
  };

  public readonly publish = (publication: BrunoTableRowPipelinePublication<TRow>): void => {
    this.acceptPublication(publication, this.logicalPublicationConfiguration);
  };

  private readonly publishRowPipeline = (
    publication: BrunoTableRowPipelinePublication<unknown>,
  ): void => {
    this.publish(publication as BrunoTableRowPipelinePublication<TRow>);
  };

  private readonly reconcileClientProjection = (
    publication: BrunoTableRowPipelinePublication<unknown>,
    columns: readonly CompiledColumn[],
    queryConfiguration: BrunoTableQueryConfiguration,
    groupRowsWidth: number,
  ): void => {
    this.reconcile(
      publication as BrunoTableRowPipelinePublication<TRow>,
      columns,
      queryConfiguration,
      groupRowsWidth,
    );
  };

  private readonly stageClientProjectionConfiguration = (
    columns: readonly CompiledColumn[],
    queryConfiguration: BrunoTableQueryConfiguration,
    groupRowsWidth: number,
  ): BrunoTableClientProjectionConfigurationSnapshot => {
    const configuration = this.requiresColumnConfiguration(
      columns,
      queryConfiguration,
      groupRowsWidth,
    )
      ? this.stageColumns(columns, queryConfiguration, groupRowsWidth)
      : undefined;
    return Object.freeze({
      query: configuration?.query ?? this.query,
      columnLayout:
        configuration === undefined
          ? this.columnLayoutSnapshot
          : getBrunoTableColumnLayoutSnapshot(configuration.columnLayout),
      quickFilterFields: configuration?.quickFilterFields ?? this.quickFilterFields,
    });
  };

  public readonly reconcile = (
    publication: BrunoTableRowPipelinePublication<TRow>,
    columns: readonly CompiledColumn[],
    queryConfiguration: BrunoTableQueryConfiguration = this.logicalPublicationConfiguration
      .queryConfiguration,
    groupRowsWidth: number = this.groupRowsWidth,
  ): void => {
    this.acceptPublication(
      publication,
      Object.freeze({ columns, queryConfiguration, groupRowsWidth }),
    );
  };

  private acceptPublication(
    publication: BrunoTableRowPipelinePublication<TRow>,
    configuration: PublicationConfiguration,
  ): void {
    this.logicalPublication = publication;
    this.logicalPublicationConfiguration = configuration;
    if (this.publishing) {
      this.queuedPublications.push({ publication, configuration });
      return;
    }

    this.publishing = true;
    let firstError: NotificationFailure | undefined;
    try {
      firstError = this.reconcilePublication(publication, configuration);
      for (let index = 0; index < this.queuedPublications.length; index += 1) {
        const queued = this.queuedPublications[index];
        this.queuedPublications[index] = undefined;
        if (queued === undefined) continue;
        firstError = firstNotificationFailure(
          firstError,
          this.reconcilePublication(queued.publication, queued.configuration),
        );
      }
    } finally {
      let acceptedConfiguration: PublicationConfiguration | undefined;
      for (let index = this.queuedPublications.length - 1; index >= 0; index -= 1) {
        const queued = this.queuedPublications[index];
        if (queued === undefined) continue;
        acceptedConfiguration = queued.configuration;
        break;
      }
      this.queuedPublications.length = 0;
      this.publishing = false;
      this.logicalPublication = this.publication;
      this.logicalPublicationConfiguration =
        acceptedConfiguration ?? this.installedPublicationConfiguration;
    }
    if (firstError !== undefined) throw firstError.value;
  }

  private reconcilePublication(
    publication: BrunoTableRowPipelinePublication<TRow>,
    publicationConfiguration: PublicationConfiguration,
  ): NotificationFailure | undefined {
    const { columns, queryConfiguration, groupRowsWidth } = publicationConfiguration;
    const previous = this.state;
    const previousLayoutSnapshot = this.columnLayoutSnapshot;
    const configuration = this.requiresColumnConfiguration(
      columns,
      queryConfiguration,
      groupRowsWidth,
    )
      ? this.stageColumns(columns, queryConfiguration, groupRowsWidth)
      : undefined;
    const next = this.createState(publication);
    const previousClientProjection = this.installedClientProjection;
    const nextClientProjection = stabilizeInstalledClientProjection(
      previousClientProjection,
      publication.clientProjection,
    );
    const clientProjectionChanged = nextClientProjection !== previousClientProjection;
    const previousGroupingStructure = this.installedGroupingStructure;
    const nextGroupingStructure = stabilizeInstalledGroupingStructure(
      previousGroupingStructure,
      nextClientProjection,
    );
    const groupingStructureChanged = nextGroupingStructure !== previousGroupingStructure;
    const previousRowsHeaderName = this.installedRowsHeaderName;
    const nextRowsHeaderName = installedRowsHeaderName(
      nextClientProjection,
      previousRowsHeaderName,
    );
    const rowsPresentationChanged = nextRowsHeaderName !== previousRowsHeaderName;
    const clientProjectionLayoutChanged =
      previousClientProjection?.layoutKey !== nextClientProjection?.layoutKey;

    if (configuration !== undefined) {
      if (!sameStringArray(this.query.groupBy, configuration.query.groupBy)) {
        this.beforeGroupingChange?.(this.query.groupBy.length === 0);
      }
      this.columns = configuration.columns;
      this.columnsById = indexColumns(configuration.columns);
      this.baselineFilters = configuration.baselineFilters;
      this.baselineFilterCollection = configuration.baselineFilterCollection;
      this.baselineOrderBy = configuration.baselineOrderBy;
      this.quickFilterFields = configuration.quickFilterFields;
      this.groupingEnabled = configuration.groupingEnabled;
      this.groupRowsWidth = configuration.groupRowsWidth;
      this.rowsWidth = configuration.rowsWidth;
      this.query = configuration.query;
      this.filterCollection = this.query.filterCollection;
      this.updateColumnFilterSnapshots();
      this.filterSnapshot = createFilterSnapshot(
        this.query,
        this.columnFilterSnapshots,
        this.filterCollection.activeFilterLabelsByColumn,
      );
      this.columnLayout = configuration.columnLayout;
      this.columnLayoutSnapshot = getBrunoTableColumnLayoutSnapshot(this.columnLayout);
      this.columnCommands = configuration.columnCommands;
    }
    this.publication = publication;
    const installed = stabilizeRuntimeState(previous, next);
    this.state = installed;
    this.installedClientProjection = nextClientProjection;
    this.installedGroupingStructure = nextGroupingStructure;
    this.installedRowsHeaderName = nextRowsHeaderName;
    this.presentationColumnsById =
      nextClientProjection === undefined
        ? this.columnsById
        : indexColumns(nextClientProjection.columns);
    this.installedPublicationConfiguration = publicationConfiguration;
    let configurationError: NotificationFailure | undefined;
    if (configuration !== undefined) {
      for (const columnId of configuration.invalidatedColumnIds) {
        configurationError = firstNotificationFailure(
          configurationError,
          this.invalidateColumnFilterCommand(columnId),
        );
      }
    }
    const transitionError =
      configuration === undefined
        ? undefined
        : firstNotificationFailure(
            firstNotificationFailure(
              this.notifyQueryTransition(configuration.transition),
              this.notifyColumnLayoutTransition(previousLayoutSnapshot),
            ),
            this.notifyColumnStructureTransition(previousLayoutSnapshot),
          );
    const projectionError = clientProjectionChanged
      ? notify(this.installedClientProjectionListeners)
      : undefined;
    const groupingStructureError = groupingStructureChanged
      ? notify(this.installedGroupingStructureListeners)
      : undefined;
    const rowsPresentationError = rowsPresentationChanged
      ? notify(this.installedRowsPresentationListeners)
      : undefined;
    const commitError = this.commitState(
      previous,
      installed,
      configuration === undefined ? publication.changedRowIds : undefined,
      clientProjectionLayoutChanged,
    );
    const firstError = firstNotificationFailure(
      firstNotificationFailure(
        firstNotificationFailure(
          firstNotificationFailure(configurationError, transitionError),
          projectionError,
        ),
        firstNotificationFailure(groupingStructureError, rowsPresentationError),
      ),
      commitError,
    );
    return firstError;
  }

  private requiresColumnConfiguration(
    columns: readonly CompiledColumn[],
    queryConfiguration: BrunoTableQueryConfiguration,
    groupRowsWidth: number,
  ): boolean {
    return (
      this.columns !== columns ||
      this.baselineFilterCollection !== queryConfiguration.baselineFilterCollection ||
      this.baselineOrderBy !== queryConfiguration.baselineOrderBy ||
      !sameStringArray(
        this.quickFilterFields,
        queryConfiguration.quickFilterFields ?? EMPTY_QUICK_FILTER_FIELDS,
      ) ||
      this.groupRowsWidth !== groupRowsWidth
    );
  }

  private commitState(
    previous: RuntimeState<TRow>,
    next: RuntimeState<TRow>,
    changedRowIds: ReadonlySet<BrunoTableRowId> | undefined,
    suppressClientFineNotifications = false,
  ): NotificationFailure | undefined {
    const chromeChanged = previous.chrome !== next.chrome;
    const sourceChanged = previous.source !== next.source;
    const sourceVersionChanged = previous.sourceVersion !== next.sourceVersion;
    const bodyChanged = previous.body !== next.body;
    const rowSpaceChanged = previous.rowSpace !== next.rowSpace;
    this.state = next;

    let firstError: NotificationFailure | undefined;
    if (chromeChanged) firstError = notify(this.chromeListeners);
    if (sourceChanged) {
      firstError = firstNotificationFailure(firstError, notify(this.sourceListeners));
    }
    if (previous.source.loadedRows !== next.source.loadedRows) {
      firstError = firstNotificationFailure(firstError, notify(this.loadedRowCountListeners));
    }
    if (sourceVersionChanged) {
      firstError = firstNotificationFailure(firstError, notify(this.sourceVersionListeners));
    }
    if (bodyChanged) firstError = firstNotificationFailure(firstError, notify(this.bodyListeners));
    if (rowSpaceChanged) {
      firstError = firstNotificationFailure(firstError, notify(this.rowSpaceListeners));
    }
    const cellSnapshotsMayChange =
      rowSpaceChanged || changedRowIds === undefined || changedRowIds.size > 0;
    if (cellSnapshotsMayChange) {
      this.cellSnapshotPublicationEpoch += 1;
      firstError = firstNotificationFailure(
        firstError,
        notifyRowChangeListeners(this.rowChangeListeners, changedRowIds),
      );
    }
    return firstNotificationFailure(
      firstError,
      suppressClientFineNotifications
        ? undefined
        : this.notifyChangedRows(previous.rowSpace, next.rowSpace, changedRowIds),
    );
  }

  public readonly configure = (
    columns: readonly CompiledColumn[],
    queryConfiguration: BrunoTableQueryConfiguration,
  ): void => {
    this.reconcile(this.logicalPublication, columns, queryConfiguration);
  };

  public readonly setOnPersistChange = (
    callback: ((state: Readonly<Record<string, BrunoTableJsonValue>>) => void) | undefined,
  ): void => {
    this.getOnPersistChange = () => callback;
  };

  public readonly getChromeSnapshot = (): BrunoTableChromeSnapshot => this.state.chrome;

  public readonly getInstalledClientProjectionSnapshot = ():
    | BrunoTableInstalledClientProjectionSnapshot
    | undefined => this.installedClientProjection;

  public readonly subscribeInstalledClientProjection = (listener: Listener): (() => void) =>
    subscribe(this.installedClientProjectionListeners, listener);

  public readonly getInstalledGroupingStructureSnapshot =
    (): BrunoTableInstalledGroupingStructureSnapshot => this.installedGroupingStructure;

  public readonly subscribeInstalledGroupingStructure = (listener: Listener): (() => void) =>
    subscribe(this.installedGroupingStructureListeners, listener);

  public readonly getInstalledRowsHeaderNameSnapshot = (): string => this.installedRowsHeaderName;

  public readonly subscribeInstalledRowsPresentation = (listener: Listener): (() => void) =>
    subscribe(this.installedRowsPresentationListeners, listener);

  public readonly getSourceSnapshot = (): BrunoTableSourceSnapshot => this.state.source;

  public readonly getSourceVersionSnapshot = (): BrunoTableSourceVersionSnapshot =>
    this.state.sourceVersion;

  public readonly getBodySnapshot = (): BrunoTableBodySnapshot => this.state.body;

  public readonly getRowSpaceSnapshot = (): BrunoTableRowSpaceSnapshot<TRow> | undefined =>
    this.state.rowSpace;

  public readonly getRowSnapshot = (rowId: BrunoTableRowId): TRow | undefined =>
    this.currentRowSnapshot(rowId).row as TRow | undefined;

  public readonly getRowPresentationSnapshot = (rowId: BrunoTableRowId): BrunoTableRowSnapshot =>
    this.currentRowSnapshot(rowId);

  public readonly getRowCellSnapshot = (
    rowId: BrunoTableRowId,
    columnId: string,
  ): BrunoTableRowCellSnapshot => {
    const snapshot = this.currentRowCellSnapshot(rowId, columnId);
    if (!this.rowCellListeners.get(rowId)?.has(columnId)) {
      this.trackPendingRowCellSnapshot(rowId, columnId);
    }
    return snapshot;
  };

  public readonly getCellSnapshot = (
    rowId: BrunoTableRowId,
    columnId: string,
  ): BrunoTableCellSnapshot => {
    const snapshot = this.currentCellSnapshot(rowId, columnId);
    if (!this.cellListeners.get(rowId)?.has(columnId)) {
      this.installCellSnapshot(rowId, columnId, snapshot);
      this.trackPendingCellSnapshot(rowId, columnId);
    }
    return snapshot;
  };

  public readonly getCellValueSnapshot = (rowId: BrunoTableRowId, columnId: string): unknown =>
    this.currentCellSnapshot(rowId, columnId).value;

  public readonly captureCellCommandReader = (): ((
    rowId: BrunoTableRowId,
    columnId: string,
  ) => BrunoTableCellSnapshot) => {
    const rowSpace = this.state.rowSpace;
    const columnsById = this.presentationColumnsById;
    return (rowId, columnId) => readCellSnapshot(rowSpace, columnsById, rowId, columnId);
  };

  public readonly getCellCacheDiagnosticSnapshot = (): Readonly<{
    readonly installed: number;
    readonly pending: number;
  }> =>
    Object.freeze({
      installed: [...this.cellSnapshots.values()].reduce(
        (count, snapshots) => count + snapshots.size,
        0,
      ),
      pending: this.pendingCellLru.size,
    });

  public readonly getQuerySnapshot = (): BrunoTableQuerySnapshot => this.query;

  public readonly getGroupBySnapshot = (): readonly string[] => this.query.groupBy;

  public readonly getGroupingEnabledSnapshot = (): boolean => this.groupingEnabled;

  public readonly getFilterSnapshot = (): BrunoTableFilterSnapshot => this.filterSnapshot;

  public readonly getQuickFilterSnapshot = (): string => this.query.quickFilter;

  public readonly getFilterPositionResetEpochSnapshot = (): number => this.filterPositionResetEpoch;

  public readonly getQuickFilterCommandEpochSnapshot = (): number => this.quickFilterCommandEpoch;

  public readonly getQuickFilterFieldsSnapshot = (): readonly string[] => this.quickFilterFields;

  public readonly getSortingSnapshot = (): BrunoTableOrderBy =>
    this.query.groupBy.length === 0 ? this.query.orderBy : this.query.groupOrderBy;

  public readonly getLoadedRowCountSnapshot = (): number => this.state.source.loadedRows;

  public readonly getActiveFilterCountSnapshot = (): number =>
    activeFilterCount(this.filterCollection, this.query.quickFilter);

  public readonly getActiveSortCountSnapshot = (): number => this.getSortingSnapshot().length;

  public readonly getColumnCommandSnapshot = (columnId: string): BrunoTableColumnCommandSnapshot =>
    this.columnCommands.get(columnId) ?? EMPTY_COLUMN_COMMAND;

  public readonly getColumnFilterSnapshot = (columnId: string): unknown =>
    this.columnFilterSnapshots.get(columnId);

  public readonly getColumnFilterVersionSnapshot = (columnId: string): number =>
    this.columnFilterVersions.get(columnId) ?? 0;

  public readonly getColumnFilterCommandEpochSnapshot = (columnId: string): number =>
    this.columnFilterCommandEpochs.get(columnId) ?? 0;

  public readonly getFilterComplexitySnapshot = (): BrunoTableFilterComplexity =>
    this.filterCollection.complexity;

  public readonly getColumnLayoutSnapshot = (): BrunoTableColumnLayoutSnapshot =>
    this.columnLayoutSnapshot;

  public readonly getColumnStructureSnapshot = (): BrunoTableColumnLayoutSnapshot =>
    this.columnStructureSnapshot;

  public readonly subscribeChrome = (listener: Listener): (() => void) =>
    subscribe(this.chromeListeners, listener);

  public readonly subscribeSource = (listener: Listener): (() => void) =>
    subscribe(this.sourceListeners, listener);

  public readonly subscribeSourceVersion = (listener: Listener): (() => void) =>
    subscribe(this.sourceVersionListeners, listener);

  public readonly subscribeBody = (listener: Listener): (() => void) =>
    subscribe(this.bodyListeners, listener);

  public readonly subscribeRowSpace = (listener: Listener): (() => void) =>
    subscribe(this.rowSpaceListeners, listener);

  public readonly subscribeRowChanges = (listener: RowChangeListener): (() => void) => {
    this.rowChangeListeners.add(listener);
    return () => this.rowChangeListeners.delete(listener);
  };

  public readonly subscribeRow = (rowId: BrunoTableRowId, listener: Listener): (() => void) => {
    let listeners = this.rowListeners.get(rowId);
    if (listeners === undefined) {
      listeners = new Set<Listener>();
      this.rowListeners.set(rowId, listeners);
    }
    listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.rowListeners.get(rowId) !== listeners) return;
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.rowListeners.delete(rowId);
        this.rowSnapshots.delete(rowId);
        this.unavailableRows.delete(rowId);
      }
    };
  };

  public readonly subscribeRowCell = (
    rowId: BrunoTableRowId,
    columnId: string,
    listener: Listener,
  ): (() => void) => {
    if (__BRUNO_TABLE_TEST_DIAGNOSTICS__) {
      recordBrunoTableReviewCellSubscription({
        tableId: this.tableId,
        rowId,
        columnId,
        source: "grid-row-cell",
        phase: "subscribe",
      });
    }
    const snapshot = this.currentRowCellSnapshot(rowId, columnId);
    let rowListeners = this.rowCellListeners.get(rowId);
    if (rowListeners === undefined) {
      rowListeners = new Map();
      this.rowCellListeners.set(rowId, rowListeners);
    }
    let listeners = rowListeners.get(columnId);
    if (listeners === undefined) {
      listeners = new Set();
      rowListeners.set(columnId, listeners);
    }
    listeners.add(listener);
    this.clearPendingRowCellSnapshot(rowId, columnId);
    this.installRowCellSnapshot(rowId, columnId, snapshot);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (__BRUNO_TABLE_TEST_DIAGNOSTICS__) {
        recordBrunoTableReviewCellSubscription({
          tableId: this.tableId,
          rowId,
          columnId,
          source: "grid-row-cell",
          phase: "unsubscribe",
        });
      }
      if (this.rowCellListeners.get(rowId)?.get(columnId) !== listeners) return;
      listeners.delete(listener);
      if (listeners.size > 0) return;
      rowListeners?.delete(columnId);
      this.deleteRowCellSnapshot(rowId, columnId);
      this.clearPendingRowCellSnapshot(rowId, columnId);
      if (rowListeners?.size === 0) this.rowCellListeners.delete(rowId);
      if (this.rowCellSnapshots.get(rowId)?.size === 0) this.rowCellSnapshots.delete(rowId);
    };
  };

  public readonly subscribeCell = (
    rowId: BrunoTableRowId,
    columnId: string,
    listener: Listener,
  ): (() => void) => {
    const snapshot = this.currentCellSnapshot(rowId, columnId);
    let rowListeners = this.cellListeners.get(rowId);
    if (rowListeners === undefined) {
      rowListeners = new Map();
      this.cellListeners.set(rowId, rowListeners);
    }
    let listeners = rowListeners.get(columnId);
    if (listeners === undefined) {
      listeners = new Set();
      rowListeners.set(columnId, listeners);
    }
    listeners.add(listener);
    this.clearPendingCellSnapshot(rowId, columnId);
    this.installCellSnapshot(rowId, columnId, snapshot);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.cellListeners.get(rowId)?.get(columnId) !== listeners) return;
      listeners.delete(listener);
      if (listeners.size > 0) return;
      rowListeners?.delete(columnId);
      this.deleteCellSnapshot(rowId, columnId);
      this.clearPendingCellSnapshot(rowId, columnId);
      if (rowListeners?.size === 0) this.cellListeners.delete(rowId);
      if (this.cellSnapshots.get(rowId)?.size === 0) this.cellSnapshots.delete(rowId);
    };
  };

  public readonly subscribeQuery = (listener: Listener): (() => void) =>
    subscribe(this.queryListeners, listener);

  public readonly subscribeGroupBy = (listener: Listener): (() => void) =>
    subscribe(this.groupByListeners, listener);

  public readonly subscribeFilter = (listener: Listener): (() => void) =>
    subscribe(this.filterListeners, listener);

  public readonly subscribeQuickFilter = (listener: Listener): (() => void) =>
    subscribe(this.quickFilterListeners, listener);

  public readonly subscribeFilterPositionReset = (listener: Listener): (() => void) =>
    subscribe(this.filterPositionResetListeners, listener);

  public readonly subscribeQuickFilterCommandEpoch = (listener: Listener): (() => void) =>
    subscribe(this.quickFilterCommandEpochListeners, listener);

  public readonly registerQuickFilterInvalidation = (listener: Listener): (() => void) =>
    this.subscribeQuickFilterCommandEpoch(listener);

  public readonly subscribeSorting = (listener: Listener): (() => void) =>
    subscribe(this.sortingListeners, listener);

  public readonly subscribeLoadedRowCount = (listener: Listener): (() => void) =>
    subscribe(this.loadedRowCountListeners, listener);

  public readonly subscribeActiveFilterCount = (listener: Listener): (() => void) =>
    subscribe(this.activeFilterCountListeners, listener);

  public readonly subscribeActiveSortCount = (listener: Listener): (() => void) =>
    subscribe(this.activeSortCountListeners, listener);

  public readonly subscribeColumnCommands = (
    columnId: string,
    listener: Listener,
  ): (() => void) => {
    let listeners = this.columnCommandListeners.get(columnId);
    if (listeners === undefined) {
      listeners = new Set<Listener>();
      this.columnCommandListeners.set(columnId, listeners);
    }
    listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.columnCommandListeners.get(columnId) !== listeners) return;
      listeners.delete(listener);
      if (listeners.size === 0) this.columnCommandListeners.delete(columnId);
    };
  };

  public readonly subscribeColumnFilter = (columnId: string, listener: Listener): (() => void) => {
    let listeners = this.columnFilterListeners.get(columnId);
    if (listeners === undefined) {
      listeners = new Set<Listener>();
      this.columnFilterListeners.set(columnId, listeners);
    }
    listeners.add(listener);
    if (__BRUNO_TABLE_TEST_DIAGNOSTICS__) {
      recordBrunoTableColumnFilterSubscriptionEvent(
        this.tableId,
        columnId,
        listeners.size,
        "subscribe",
      );
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.columnFilterListeners.get(columnId) !== listeners) return;
      listeners.delete(listener);
      if (__BRUNO_TABLE_TEST_DIAGNOSTICS__) {
        recordBrunoTableColumnFilterSubscriptionEvent(
          this.tableId,
          columnId,
          listeners.size,
          "unsubscribe",
        );
      }
      if (listeners.size === 0) this.columnFilterListeners.delete(columnId);
    };
  };

  public readonly subscribeColumnFilterCommandEpoch = (
    columnId: string,
    listener: Listener,
  ): (() => void) => {
    let listeners = this.columnFilterCommandEpochListeners.get(columnId);
    if (listeners === undefined) {
      listeners = new Set<Listener>();
      this.columnFilterCommandEpochListeners.set(columnId, listeners);
    }
    listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.columnFilterCommandEpochListeners.get(columnId) !== listeners) return;
      listeners.delete(listener);
      if (listeners.size === 0) this.columnFilterCommandEpochListeners.delete(columnId);
    };
  };

  public readonly subscribeColumnLayout = (listener: Listener): (() => void) =>
    subscribe(this.columnLayoutListeners, listener);

  public readonly subscribeColumnStructure = (listener: Listener): (() => void) =>
    subscribe(this.columnStructureListeners, listener);

  public readonly dispatchGridCommand = (command: BrunoTableGridCommand): boolean => {
    const previousFilterCollection = this.filterCollection;
    const previousOrderBy = this.query.orderBy;
    const previousLayout = this.columnLayout;
    const previousGroupBy = this.query.groupBy;
    const previousGroupOrderBy = this.query.groupOrderBy;
    const previousRowsWidth = this.rowsWidth;
    let accepted = false;
    let commandThrew = false;
    let commandError: unknown;
    let preparedPersistedState: Readonly<Record<string, BrunoTableJsonValue>> | undefined;
    let preparedPersistenceRevision: number | undefined;
    try {
      accepted = this.dispatchGridCommandImpl(command, (snapshot, revision) => {
        preparedPersistedState = snapshot;
        preparedPersistenceRevision = revision;
      });
    } catch (error) {
      commandThrew = true;
      commandError = error;
    }
    let persistThrew = false;
    let persistError: unknown;
    if (
      isBrunoTableDurablePreferenceCommand(command) &&
      (previousFilterCollection !== this.filterCollection ||
        !sameOrderBy(previousOrderBy, this.query.orderBy) ||
        !sameStringArray(previousGroupBy, this.query.groupBy) ||
        !sameOrderBy(previousGroupOrderBy, this.query.groupOrderBy) ||
        previousRowsWidth !== this.rowsWidth ||
        previousLayout !== this.columnLayout)
    ) {
      let persistedState: Readonly<Record<string, BrunoTableJsonValue>> | undefined;
      const superseded =
        preparedPersistenceRevision !== undefined &&
        preparedPersistenceRevision !== this.persistenceRevision;
      // Committed durable state supersedes older snapshots even when persistence fails.
      const previousPersistenceRevision = ++this.persistenceRevision;
      try {
        if (!superseded) {
          persistedState = preparedPersistedState ?? this.createPersistedState(this.query.filters);
        }
      } catch (error) {
        persistThrew = true;
        persistError = error;
      }
      if (persistedState !== undefined) {
        try {
          const onPersistChange = this.getOnPersistChange();
          if (previousPersistenceRevision === this.persistenceRevision) {
            // A nested durable command owns any newer complete preference snapshot.
            onPersistChange?.(persistedState);
          }
        } catch {
          // Consumer notification failures never participate in grid command ownership.
        }
      }
    }
    if (commandThrew) throw commandError;
    if (persistThrew) throw persistError;
    return accepted;
  };

  private readonly dispatchGridCommandImpl = (
    command: BrunoTableGridCommand,
    preparePersistedState: (
      snapshot: Readonly<Record<string, BrunoTableJsonValue>>,
      revision: number,
    ) => void,
  ): boolean => {
    if (
      command.type === "quick-filter.replace" &&
      !isBrunoTableQuickFilterTextWithinLimit(command.text)
    ) {
      return false;
    }
    if (
      (isBrunoTableFilterCommand(command) || isBrunoTableSortingCommand(command)) &&
      !this.commitActiveEditor()
    ) {
      return false;
    }
    if (__BRUNO_TABLE_TEST_DIAGNOSTICS__) {
      recordBrunoTableGridCommand(this.tableId, command);
    }
    if (
      command.type === "edits.reset" ||
      command.type === "edits.undo" ||
      command.type === "edits.redo"
    ) {
      return this.editCommandHandler?.(command) === true;
    }
    if (
      command.type === "grouping.add" ||
      command.type === "grouping.remove" ||
      command.type === "grouping.move"
    ) {
      return this.dispatchGroupingCommand(command);
    }
    if (isBrunoTableSortingCommand(command)) {
      if (this.query.groupBy.length > 0) {
        const nextGroupOrderBy = applyGroupedSortingCommand(
          this.query.groupOrderBy,
          this.query.groupBy,
          this.columns,
          this.columnLayoutSnapshot.visibleColumnIds,
          command,
        );
        if (nextGroupOrderBy !== this.query.groupOrderBy) {
          this.publishGroupingQuery(this.query.groupBy, nextGroupOrderBy, "reset");
        }
        return true;
      }
      const nextOrderBy = applyBrunoTableSortingCommand(
        this.query.orderBy,
        this.baselineOrderBy,
        this.columns,
        command,
      );
      this.publishQuery(this.filterCollection, nextOrderBy);
      return true;
    }
    if (command.type === "column.filter.clear") {
      const invalidationError = this.invalidateColumnFilterCommand(command.columnId);
      this.clearColumnFiltersImpl(command.columnId);
      if (invalidationError !== undefined) throw invalidationError.value;
      return true;
    }
    if (command.type === "column.filters.clear") {
      let invalidationError: NotificationFailure | undefined;
      for (const column of this.columns) {
        invalidationError = firstNotificationFailure(
          invalidationError,
          this.invalidateColumnFilterCommand(column.columnId),
        );
      }
      this.clearAllColumnFiltersImpl();
      if (invalidationError !== undefined) throw invalidationError.value;
      return true;
    }
    if (command.type === "column.filter.reset") {
      const invalidationError = this.invalidateColumnFilterCommand(command.columnId);
      const accepted = this.resetColumnFiltersImpl(command.columnId);
      if (invalidationError !== undefined) throw invalidationError.value;
      return accepted;
    }
    if (command.type === "column.filter.replace") {
      return this.replaceColumnFilterImpl(command.columnId, command.filter, preparePersistedState);
    }
    if (command.type === "quick-filter.replace") {
      this.quickFilterCommandEpoch += 1;
      this.publishQuery(this.filterCollection, this.query.orderBy, command.text);
      const error = notify(this.quickFilterCommandEpochListeners);
      if (error !== undefined) throw error.value;
      return true;
    }
    if (this.query.groupBy.length > 0) {
      if (
        command.type === "column.reorder.commit" ||
        command.type === "column.reset.order" ||
        command.type === "column.reset.layout"
      ) {
        return false;
      }
      if (command.type === "column.visibility.commit") {
        const column = this.columnsById.get(command.columnId);
        if (column === undefined || this.query.groupBy.includes(command.columnId)) {
          return false;
        }
      }
      if (
        command.type === "column.resize.commit" &&
        command.columnId !== "COL_ID_BRUNO_TABLE_ROWS"
      ) {
        const column = this.columnsById.get(command.columnId);
        const participates =
          column?.kind === "field" &&
          (this.query.groupBy.includes(command.columnId) ||
            (column.aggFunc !== undefined &&
              this.columnLayoutSnapshot.visibleColumnIds.includes(command.columnId)));
        if (!participates) {
          return false;
        }
      }
    }
    if (command.type === "column.resize.commit" && command.columnId === "COL_ID_BRUNO_TABLE_ROWS") {
      if (
        !this.groupingEnabled ||
        this.query.groupBy.length === 0 ||
        !Number.isFinite(command.width)
      ) {
        return false;
      }
      this.rowsWidth = Math.min(
        BRUNO_TABLE_MAX_COLUMN_WIDTH,
        Math.max(BRUNO_TABLE_MIN_COLUMN_WIDTH, command.width),
      );
      this.publishRowsWidth();
      return true;
    }
    if (!isBrunoTableColumnLayoutCommand(command)) return true;
    const previousLayoutSnapshot = this.columnLayoutSnapshot;
    const previousCommands = this.columnCommands;
    const resetsRowsWidth =
      this.rowsWidth !== undefined &&
      (command.type === "column.reset.widths" || command.type === "column.reset.layout");
    const nextLayout = applyBrunoTableGridCommand(this.columnLayout, command);
    if (nextLayout === this.columnLayout && !resetsRowsWidth) return true;
    this.columnLayout = nextLayout;
    this.columnLayoutSnapshot = getBrunoTableColumnLayoutSnapshot(nextLayout);
    if (resetsRowsWidth) {
      this.rowsWidth = undefined;
      this.query = createQuerySnapshot(
        this.columns,
        this.filterCollection,
        this.query.quickFilter,
        this.query.orderBy,
        this.query.generation,
        this.query.navigationMode,
        this.query.groupBy,
        this.query.groupOrderBy,
      );
    }
    let groupingSortChanged = false;
    if (
      this.query.groupBy.length > 0 &&
      (command.type === "column.visibility.commit" || command.type === "column.reset.visibility")
    ) {
      const nextGroupOrderBy = reconcileGroupedOrderBy(
        this.query.groupOrderBy,
        this.query.groupBy,
        this.columns,
        this.columnLayoutSnapshot.visibleColumnIds,
      );
      if (!sameOrderBy(nextGroupOrderBy, this.query.groupOrderBy)) {
        groupingSortChanged = true;
        this.query = createQuerySnapshot(
          this.columns,
          this.filterCollection,
          this.query.quickFilter,
          this.query.orderBy,
          this.query.generation + 1,
          "reconcile",
          this.query.groupBy,
          nextGroupOrderBy,
          this.rowsWidth,
        );
      }
    }
    this.columnCommands = createColumnCommandSnapshots(
      this.columns,
      this.query,
      this.baselineFilterCollection,
      previousCommands,
      this.columnLayoutSnapshot,
      this.groupRowsWidth,
    );
    let error = firstNotificationFailure(
      this.notifyColumnLayoutTransition(previousLayoutSnapshot, previousCommands),
      this.notifyColumnStructureTransition(previousLayoutSnapshot),
    );
    error = firstNotificationFailure(
      error,
      groupingSortChanged
        ? firstNotificationFailure(notify(this.queryListeners), notify(this.sortingListeners))
        : resetsRowsWidth
          ? notify(this.queryListeners)
          : undefined,
    );
    if (error !== undefined) throw error.value;
    return true;
  };

  private readonly dispatchGroupingCommand = (
    command: Extract<
      BrunoTableGridCommand,
      { readonly type: "grouping.add" | "grouping.remove" | "grouping.move" }
    >,
  ): boolean => {
    if (!this.groupingEnabled) return false;
    const current = this.query.groupBy;
    let next: readonly string[];
    if (command.type === "grouping.add") {
      const column = this.columnsById.get(command.columnId);
      if (column?.kind !== "field" || !column.groupBy || current.includes(command.columnId)) {
        return false;
      }
      next = Object.freeze([...current, command.columnId]);
    } else if (command.type === "grouping.remove") {
      if (!current.includes(command.columnId)) return false;
      next = Object.freeze(current.filter((columnId) => columnId !== command.columnId));
    } else {
      const index = current.indexOf(command.columnId);
      const target = index + command.direction;
      if (index < 0 || target < 0 || target >= current.length) return false;
      const mutable = Array.from(current);
      [mutable[index], mutable[target]] = [mutable[target]!, mutable[index]!];
      next = Object.freeze(mutable);
    }
    const nextOrderBy =
      current.length === 0 && next.length > 0 && !this.hasDurableGroupOrderByIntent
        ? Object.freeze(
            next.map((columnId) => Object.freeze({ columnId, direction: "asc" as const })),
          )
        : next.length === 0
          ? this.query.groupOrderBy
          : reconcileGroupedOrderBy(
              this.query.groupOrderBy,
              next,
              this.columns,
              this.columnLayoutSnapshot.visibleColumnIds,
            );
    if (next.length > 0) this.hasDurableGroupOrderByIntent = true;
    this.publishGroupingQuery(next, nextOrderBy);
    return true;
  };

  private readonly publishGroupingQuery = (
    groupBy: readonly string[],
    groupOrderBy: BrunoTableOrderBy,
    navigationMode?: BrunoTableQueryNavigationMode,
  ): void => {
    const previousActiveSortCount = this.getActiveSortCountSnapshot();
    const tupleChanged = !sameStringArray(this.query.groupBy, groupBy);
    if (tupleChanged) this.beforeGroupingChange?.(this.query.groupBy.length === 0);
    const previousCommands = this.columnCommands;
    this.query = createQuerySnapshot(
      this.columns,
      this.filterCollection,
      this.query.quickFilter,
      this.query.orderBy,
      this.query.generation + 1,
      navigationMode ?? (tupleChanged ? "projection-reset" : "reconcile"),
      groupBy,
      groupOrderBy,
      this.rowsWidth,
    );
    this.columnCommands = createColumnCommandSnapshots(
      this.columns,
      this.query,
      this.baselineFilterCollection,
      previousCommands,
      this.columnLayoutSnapshot,
      this.groupRowsWidth,
    );
    const error = firstNotificationFailure(
      firstNotificationFailure(
        firstNotificationFailure(
          firstNotificationFailure(notify(this.queryListeners), notify(this.sortingListeners)),
          tupleChanged ? notify(this.groupByListeners) : undefined,
        ),
        previousActiveSortCount === this.getActiveSortCountSnapshot()
          ? undefined
          : notify(this.activeSortCountListeners),
      ),
      this.notifyColumnLayoutTransition(this.columnLayoutSnapshot, previousCommands),
    );
    if (error !== undefined) throw error.value;
  };

  private readonly publishRowsWidth = (): void => {
    const previousCommands = this.columnCommands;
    this.query = createQuerySnapshot(
      this.columns,
      this.filterCollection,
      this.query.quickFilter,
      this.query.orderBy,
      this.query.generation,
      this.query.navigationMode,
      this.query.groupBy,
      this.query.groupOrderBy,
      this.rowsWidth,
    );
    this.columnCommands = createColumnCommandSnapshots(
      this.columns,
      this.query,
      this.baselineFilterCollection,
      previousCommands,
      this.columnLayoutSnapshot,
      this.groupRowsWidth,
    );
    const error = firstNotificationFailure(
      notify(this.queryListeners),
      this.notifyColumnLayoutTransition(this.columnLayoutSnapshot, previousCommands),
    );
    if (error !== undefined) throw error.value;
  };

  public readonly registerActiveEditorCommitGate = (
    gate: BrunoTableActiveEditorCommitGate,
  ): (() => void) => {
    this.activeEditorCommitGates.add(gate);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.activeEditorCommitGates.delete(gate);
    };
  };

  public readonly registerEditCommandHandler = (
    handler: BrunoTableEditCommandHandler,
  ): (() => void) => {
    this.editCommandHandler = handler;
    return () => {
      if (this.editCommandHandler === handler) this.editCommandHandler = undefined;
    };
  };

  private readonly commitActiveEditor = (): boolean => {
    for (const gate of this.activeEditorCommitGates) {
      if (!gate()) return false;
    }
    return true;
  };

  public readonly toggleColumnSort = (columnId: string, multi: boolean): void => {
    this.dispatchGridCommand({ type: "column.sort.toggle", columnId, multi });
  };

  public readonly clearColumnFilters = (columnId: string): void => {
    this.dispatchGridCommand({ type: "column.filter.clear", columnId });
  };

  private readonly clearAllColumnFiltersImpl = (): void => {
    if (this.query.filters.length === 0) return;
    this.publishQuery(compileClientFilterCollection([], this.columns), this.query.orderBy);
  };

  private readonly invalidateColumnFilterCommand = (
    columnId: string,
  ): NotificationFailure | undefined => {
    this.columnFilterCommandEpochs.set(
      columnId,
      (this.columnFilterCommandEpochs.get(columnId) ?? 0) + 1,
    );
    const listeners = this.columnFilterCommandEpochListeners.get(columnId);
    return listeners === undefined ? undefined : notify(listeners);
  };

  private readonly clearColumnFiltersImpl = (columnId: string): void => {
    const next = removeClientFilterColumn(this.filterCollection, columnId);
    if (next === this.filterCollection) return;
    this.publishQuery(next, this.query.orderBy);
  };

  private readonly replaceColumnFilterImpl = (
    columnId: string,
    candidate: unknown,
    preparePersistedState: (
      snapshot: Readonly<Record<string, BrunoTableJsonValue>>,
      revision: number,
    ) => void,
  ): boolean => {
    const next = replaceClientFilterColumn(this.filterCollection, columnId, candidate);
    if (next === undefined) return false;
    if (next === this.filterCollection) return true;
    const revision = this.persistenceRevision;
    preparePersistedState(this.createPersistedState(next.filters), revision);
    if (revision !== this.persistenceRevision) {
      throw new Error("Grid preferences changed while preparing this filter.");
    }
    this.publishQuery(next, this.query.orderBy);
    return true;
  };

  private readonly createPersistedState = (
    filters: readonly unknown[],
  ): Readonly<Record<string, BrunoTableJsonValue>> =>
    createBrunoTablePersistedState({
      tableId: this.tableId,
      columns: this.columns,
      filters,
      orderBy: this.query.orderBy,
      groupBy: this.query.groupBy,
      groupOrderBy: this.query.groupOrderBy,
      ...(this.rowsWidth === undefined ? {} : { rowsWidth: this.rowsWidth }),
      columnLayout: this.columnLayout,
    });

  public readonly resetColumnFilters = (columnId: string): void => {
    this.dispatchGridCommand({ type: "column.filter.reset", columnId });
  };

  private readonly resetColumnFiltersImpl = (columnId: string): boolean => {
    const next = restoreClientFilterColumn(
      this.filterCollection,
      this.baselineFilterCollection,
      columnId,
    );
    if (next === undefined) return false;
    if (next === this.filterCollection) return true;
    this.publishQuery(next, this.query.orderBy);
    return true;
  };

  public readonly retry = (): void => {
    const retry = this.state.chrome.retry;
    if (retry !== undefined && !retry.pending) {
      const run = retry.run;
      run();
    }
  };

  private createState(publication: BrunoTableRowPipelinePublication<TRow>): RuntimeState<TRow> {
    const rowSpace = publication.rowSpace;
    const chrome = Object.freeze({
      status: publication.status,
      ...(publication.statusCode === undefined ? {} : { statusCode: publication.statusCode }),
      ...(publication.message === undefined ? {} : { message: publication.message }),
      ...(publication.retry === undefined ? {} : { retry: publication.retry }),
      hasCoherentRows: publication.hasCoherentRows,
      ...(publication.invalid === undefined ? {} : { invalid: publication.invalid }),
    });
    const source = Object.freeze({
      totalRows: publication.totalRows,
      loadedRows: rowSpace?.loadedRows ?? 0,
    });
    const sourceVersion = Object.freeze({ version: publication.version });
    const body = bodySnapshot(publication);
    return Object.freeze({ chrome, source, sourceVersion, body, rowSpace });
  }

  private stageColumns(
    columns: readonly CompiledColumn[],
    queryConfiguration: BrunoTableQueryConfiguration,
    groupRowsWidth: number,
  ): ColumnConfiguration {
    const baselineFilterCollection =
      queryConfiguration.baselineFilterCollection ??
      compileClientFilterCollection(queryConfiguration.baselineFilters, columns, {
        rejectOverBudget: true,
      });
    const baselineFilters = baselineFilterCollection.filters;
    const baselineOrderBy = queryConfiguration.baselineOrderBy;
    const quickFilterFields = queryConfiguration.quickFilterFields ?? EMPTY_QUICK_FILTER_FIELDS;
    const quickFilterFieldsChanged = !sameStringArray(this.quickFilterFields, quickFilterFields);
    const nextColumnsById = indexColumns(columns);
    const invalidatedColumnIds = new Set<string>();
    for (const column of this.columns) {
      const next = nextColumnsById.get(column.columnId);
      if (
        next === undefined ||
        !sameFilterCommandSemantics(column, next) ||
        !sameBrunoTableFilterColumn(
          this.baselineFilterCollection,
          baselineFilterCollection,
          column.columnId,
        )
      ) {
        invalidatedColumnIds.add(column.columnId);
      }
    }
    for (const column of columns) {
      const previous = this.columnsById.get(column.columnId);
      if (previous === undefined) invalidatedColumnIds.add(column.columnId);
    }
    const nextFilterCollection = compileClientFilterCollection(this.query.filters, columns);
    const nextOrderBy = reconcileBrunoTableOrderBy(this.query.orderBy, baselineOrderBy, columns);
    const nextQuickFilter = quickFilterFields.length === 0 ? "" : this.query.quickFilter;
    const semanticsChanged =
      !sameBrunoTableFilterCollections(this.query.filterCollection, nextFilterCollection) ||
      !sameOrderBy(this.query.orderBy, nextOrderBy) ||
      this.query.quickFilter !== nextQuickFilter ||
      quickFilterFieldsChanged ||
      activeQuerySemanticsChanged(this.columns, columns, this.query);
    const nextGroupBy = this.query.groupBy.filter((columnId) => {
      const column = nextColumnsById.get(columnId);
      return column?.kind === "field" && column.groupBy;
    });
    const columnLayout =
      this.columns === columns
        ? this.columnLayout
        : reconcileBrunoTableColumnLayout(
            this.columnLayout,
            columns,
            this.columnLayout.version + 1,
          );
    const groupingEnabled =
      this.groupingPermitted && columns.some((column) => column.kind === "field" && column.groupBy);
    const nextGroupOrderBy = this.groupingPermitted
      ? reconcileGroupedOrderBy(
          this.query.groupOrderBy,
          nextGroupBy,
          columns,
          getBrunoTableColumnLayoutSnapshot(columnLayout).visibleColumnIds,
        )
      : EMPTY_GROUPING;
    const groupingTupleChanged = !sameStringArray(this.query.groupBy, nextGroupBy);
    const groupingSortChanged = !sameOrderBy(this.query.groupOrderBy, nextGroupOrderBy);
    const groupingChanged = groupingTupleChanged || groupingSortChanged;
    const rowsWidth = this.rowsWidth;
    const queryRowsWidth = groupingEnabled ? rowsWidth : undefined;
    const query = createQuerySnapshot(
      columns,
      nextFilterCollection,
      nextQuickFilter,
      nextOrderBy,
      semanticsChanged || groupingChanged ? this.query.generation + 1 : this.query.generation,
      semanticsChanged || groupingChanged
        ? groupingTupleChanged
          ? "projection-reset"
          : !sameOrderBy(this.query.orderBy, nextOrderBy)
            ? "clear"
            : "reconcile"
        : this.query.navigationMode,
      Object.freeze(nextGroupBy),
      nextGroupOrderBy,
      queryRowsWidth,
    );
    const columnCommands = createColumnCommandSnapshots(
      columns,
      query,
      baselineFilterCollection,
      this.columnCommands,
      getBrunoTableColumnLayoutSnapshot(columnLayout),
      groupRowsWidth,
    );
    return Object.freeze({
      columns,
      baselineFilters,
      baselineFilterCollection,
      baselineOrderBy,
      quickFilterFields,
      groupingEnabled,
      groupRowsWidth,
      ...(rowsWidth === undefined ? {} : { rowsWidth }),
      query,
      columnCommands,
      columnLayout,
      invalidatedColumnIds: Object.freeze([...invalidatedColumnIds]),
      transition: Object.freeze({
        filterChanged:
          this.columns !== columns ||
          !sameBrunoTableFilterCollections(this.query.filterCollection, nextFilterCollection) ||
          this.query.quickFilter !== nextQuickFilter,
        queryChanged: true,
        quickFilterChanged: this.query.quickFilter !== nextQuickFilter || quickFilterFieldsChanged,
        sortingChanged: !sameOrderBy(
          this.getSortingSnapshot(),
          query.groupBy.length === 0 ? query.orderBy : query.groupOrderBy,
        ),
        groupByChanged: !sameStringArray(this.query.groupBy, query.groupBy),
        activeFilterCountChanged:
          activeFilterCount(this.filterCollection, this.query.quickFilter) !==
          activeFilterCount(nextFilterCollection, nextQuickFilter),
        activeSortCountChanged:
          this.getActiveSortCountSnapshot() !==
          (query.groupBy.length === 0 ? query.orderBy.length : query.groupOrderBy.length),
        previousCommands: this.columnCommands,
        previousColumnFilters: this.columnFilterSnapshots,
      }),
    });
  }

  private publishQuery(
    filterCollection: BrunoTableClientFilterCollection,
    orderBy: BrunoTableOrderBy,
    quickFilter = this.query.quickFilter,
    forceColumnRefresh = false,
  ): void {
    const transition = this.updateQuery(filterCollection, orderBy, quickFilter, forceColumnRefresh);
    if (transition === undefined) return;
    const error = this.notifyQueryTransition(transition);
    if (error !== undefined) throw error.value;
  }

  private updateQuery(
    filterCollection: BrunoTableClientFilterCollection,
    orderBy: BrunoTableOrderBy,
    quickFilter: string,
    forceColumnRefresh = false,
  ): QueryTransition | undefined {
    const previousActiveFilterCount = this.getActiveFilterCountSnapshot();
    const previousActiveSortCount = this.getActiveSortCountSnapshot();
    const sortingChanged = !sameOrderBy(this.query.orderBy, orderBy);
    const quickFilterChanged = this.query.quickFilter !== quickFilter;
    const quickFilterSemanticsChanged =
      normalizeBrunoTableFilterText(this.query.quickFilter) !==
      normalizeBrunoTableFilterText(quickFilter);
    const filterCollectionChanged = !sameBrunoTableFilterCollections(
      this.filterCollection,
      filterCollection,
    );
    const queryChanged = filterCollectionChanged || sortingChanged || quickFilterSemanticsChanged;
    const filterChanged = filterCollectionChanged || quickFilterChanged;
    if (!queryChanged && !quickFilterChanged && !forceColumnRefresh) return undefined;
    const previousCommands = this.columnCommands;
    const previousColumnFilters = this.columnFilterSnapshots;
    const filterColumnIdentitiesChanged =
      filterCollectionChanged &&
      !sameStringSet(this.filterCollection.columnIds, filterCollection.columnIds);
    if (queryChanged) {
      this.query = createQuerySnapshot(
        this.columns,
        filterCollection,
        quickFilter,
        orderBy,
        this.query.generation + 1,
        sortingChanged ? "clear" : "reset",
        this.query.groupBy,
        this.query.groupOrderBy,
        this.rowsWidth,
      );
      this.filterCollection = filterCollection;
      this.updateColumnFilterSnapshots();
    } else if (quickFilterChanged) {
      this.query = createQuerySnapshot(
        this.columns,
        this.filterCollection,
        quickFilter,
        this.query.orderBy,
        this.query.generation,
        this.query.navigationMode,
        this.query.groupBy,
        this.query.groupOrderBy,
        this.rowsWidth,
      );
    }
    if (filterChanged) {
      this.filterSnapshot = createFilterSnapshot(
        this.query,
        this.columnFilterSnapshots,
        this.filterCollection.activeFilterLabelsByColumn,
      );
    }
    this.columnCommands =
      !sortingChanged && !forceColumnRefresh && !filterColumnIdentitiesChanged
        ? previousCommands
        : createColumnCommandSnapshots(
            this.columns,
            this.query,
            this.baselineFilterCollection,
            previousCommands,
            this.columnLayoutSnapshot,
            this.groupRowsWidth,
          );
    return Object.freeze({
      filterChanged,
      queryChanged,
      quickFilterChanged,
      sortingChanged,
      groupByChanged: false,
      activeFilterCountChanged: previousActiveFilterCount !== this.getActiveFilterCountSnapshot(),
      activeSortCountChanged: previousActiveSortCount !== this.getActiveSortCountSnapshot(),
      previousCommands,
      previousColumnFilters,
    });
  }

  private notifyQueryTransition(transition: QueryTransition): NotificationFailure | undefined {
    if (__BRUNO_TABLE_TEST_DIAGNOSTICS__ && transition.queryChanged) {
      recordBrunoTableClientQueryTransition(this.tableId, this.query.generation);
    }
    let firstError = transition.queryChanged ? notify(this.queryListeners) : undefined;
    if (transition.groupByChanged) {
      firstError = firstNotificationFailure(firstError, notify(this.groupByListeners));
    }
    if (transition.filterChanged) {
      firstError = firstNotificationFailure(firstError, notify(this.filterListeners));
    }
    if (transition.filterChanged && !transition.queryChanged) {
      this.filterPositionResetEpoch += 1;
      firstError = firstNotificationFailure(firstError, notify(this.filterPositionResetListeners));
    }
    if (transition.quickFilterChanged) {
      firstError = firstNotificationFailure(firstError, notify(this.quickFilterListeners));
    }
    if (transition.sortingChanged) {
      firstError = firstNotificationFailure(firstError, notify(this.sortingListeners));
    }
    if (transition.activeFilterCountChanged) {
      firstError = firstNotificationFailure(firstError, notify(this.activeFilterCountListeners));
    }
    if (transition.activeSortCountChanged) {
      firstError = firstNotificationFailure(firstError, notify(this.activeSortCountListeners));
    }
    const columnIds = new Set([
      ...transition.previousCommands.keys(),
      ...this.columnCommands.keys(),
    ]);
    for (const columnId of columnIds) {
      if (
        !sameColumnCommand(
          transition.previousCommands.get(columnId),
          this.columnCommands.get(columnId),
        )
      ) {
        const listeners = this.columnCommandListeners.get(columnId);
        if (listeners !== undefined) {
          if (__BRUNO_TABLE_TEST_DIAGNOSTICS__) {
            recordBrunoTableColumnCommandSubscriptionNotification(
              this.tableId,
              columnId,
              listeners.size,
            );
          }
          firstError = firstNotificationFailure(firstError, notify(listeners));
        }
      }
    }
    const filterColumnIds = new Set([
      ...transition.previousColumnFilters.keys(),
      ...this.columnFilterSnapshots.keys(),
      ...this.columnFilterListeners.keys(),
    ]);
    if (__BRUNO_TABLE_TEST_DIAGNOSTICS__) {
      for (const column of this.columns) filterColumnIds.add(column.columnId);
    }
    for (const columnId of filterColumnIds) {
      const listeners = this.columnFilterListeners.get(columnId);
      if (
        Object.is(
          transition.previousColumnFilters.get(columnId),
          this.columnFilterSnapshots.get(columnId),
        )
      ) {
        continue;
      }
      if (__BRUNO_TABLE_TEST_DIAGNOSTICS__) {
        recordBrunoTableColumnFilterSubscriptionEvent(
          this.tableId,
          columnId,
          listeners?.size ?? 0,
          "notify",
        );
      }
      if (listeners !== undefined) {
        firstError = firstNotificationFailure(firstError, notify(listeners));
      }
    }
    return firstError;
  }

  private updateColumnFilterSnapshots(): void {
    const next = createColumnFilterSnapshots(this.filterCollection, this.columnFilterSnapshots);
    const columnIds = new Set([...this.columnFilterSnapshots.keys(), ...next.keys()]);
    for (const columnId of columnIds) {
      if (Object.is(this.columnFilterSnapshots.get(columnId), next.get(columnId))) continue;
      this.columnFilterVersions.set(columnId, (this.columnFilterVersions.get(columnId) ?? 0) + 1);
    }
    this.columnFilterSnapshots = next;
    const currentColumnIds = new Set<string>(this.columns.map((column) => column.columnId));
    for (const columnId of this.columnFilterVersions.keys()) {
      if (!currentColumnIds.has(columnId)) {
        this.columnFilterVersions.delete(columnId);
        this.columnFilterCommandEpochs.delete(columnId);
      }
    }
    for (const columnId of currentColumnIds) {
      if (!this.columnFilterCommandEpochs.has(columnId)) {
        this.columnFilterCommandEpochs.set(columnId, 0);
      }
    }
  }

  private notifyColumnLayoutTransition(
    previous: BrunoTableColumnLayoutSnapshot,
    previousCommands: ReadonlyMap<string, BrunoTableColumnCommandSnapshot> = this.columnCommands,
  ): NotificationFailure | undefined {
    let firstError =
      previous.version === this.columnLayoutSnapshot.version
        ? undefined
        : notify(this.columnLayoutListeners);
    const columnIds = new Set([...previousCommands.keys(), ...this.columnCommands.keys()]);
    for (const columnId of columnIds) {
      if (!sameColumnCommand(previousCommands.get(columnId), this.columnCommands.get(columnId))) {
        const listeners = this.columnCommandListeners.get(columnId);
        if (listeners !== undefined) {
          if (__BRUNO_TABLE_TEST_DIAGNOSTICS__) {
            recordBrunoTableColumnCommandSubscriptionNotification(
              this.tableId,
              columnId,
              listeners.size,
            );
          }
          firstError = firstNotificationFailure(firstError, notify(listeners));
        }
      }
    }
    return firstError;
  }

  private notifyColumnStructureTransition(
    previous: BrunoTableColumnLayoutSnapshot,
  ): NotificationFailure | undefined {
    if (sameColumnProjection(previous, this.columnLayoutSnapshot, this.query.groupBy)) {
      return undefined;
    }
    this.columnStructureSnapshot = this.columnLayoutSnapshot;
    return notify(this.columnStructureListeners);
  }

  private notifyChangedRows(
    previous: BrunoTableRowSpaceSnapshot<TRow> | undefined,
    next: BrunoTableRowSpaceSnapshot<TRow> | undefined,
    changedRowIds: ReadonlySet<BrunoTableRowId> | undefined,
  ): NotificationFailure | undefined {
    if (
      previous === next &&
      this.unavailableRows.size === 0 &&
      this.unavailableRowCellRows.size === 0 &&
      this.unavailableCellRows.size === 0 &&
      !this.hasStaleSubscribedColumnSnapshot()
    ) {
      return undefined;
    }
    if (
      changedRowIds !== undefined &&
      changedRowIds.size === 0 &&
      this.unavailableRows.size === 0 &&
      this.unavailableRowCellRows.size === 0 &&
      this.unavailableCellRows.size === 0
    ) {
      return undefined;
    }
    let firstError: NotificationFailure | undefined;
    const rowListenerEntries = selectChangedRowEntries(
      this.rowListeners,
      unionChangedRowIds(changedRowIds, this.unavailableRows),
    );
    for (const [rowId, listeners] of rowListenerEntries) {
      if (previous === next && !this.unavailableRows.has(rowId)) continue;
      const recovering = this.unavailableRows.delete(rowId);
      let previousSnapshot = this.rowSnapshots.get(rowId);
      let nextSnapshot: BrunoTableRowSnapshot;
      let previousReadFailed = false;
      let nextReadFailed = false;
      if (!recovering && previousSnapshot === undefined) {
        try {
          previousSnapshot = readRowSnapshot(previous, rowId);
          this.installRowSnapshot(rowId, previousSnapshot);
        } catch (error) {
          previousReadFailed = true;
          firstError = firstNotificationFailure(firstError, notificationFailure(error));
        }
      }
      try {
        nextSnapshot = readRowSnapshot(next, rowId);
      } catch (error) {
        nextReadFailed = true;
        firstError = firstNotificationFailure(firstError, notificationFailure(error));
        nextSnapshot = unavailableRowSnapshot(next);
      }
      if (nextReadFailed) this.unavailableRows.add(rowId);
      this.installRowSnapshot(rowId, nextSnapshot);
      if (
        previousReadFailed ||
        nextReadFailed ||
        recovering ||
        previousSnapshot === undefined ||
        previousSnapshot.kind !== nextSnapshot.kind ||
        previousSnapshot.row !== nextSnapshot.row
      ) {
        firstError = firstNotificationFailure(firstError, notify(listeners));
      }
    }
    const rowCellListenerEntries = selectChangedRowEntries(
      this.rowCellListeners,
      unionChangedRowIds(changedRowIds, this.unavailableRowCellRows),
    );
    for (const [rowId, columns] of rowCellListenerEntries) {
      for (const [columnId, listeners] of columns) {
        const previousSnapshot = this.rowCellSnapshots.get(rowId)?.get(columnId);
        if (
          previous === next &&
          previousSnapshot?.kind !== "unavailable" &&
          previousSnapshot?.column === this.presentationColumnsById.get(columnId)
        ) {
          continue;
        }
        let nextSnapshot: BrunoTableRowCellSnapshot;
        try {
          nextSnapshot = readRowCellSnapshot(next, this.presentationColumnsById, rowId, columnId);
        } catch (error) {
          firstError = firstNotificationFailure(firstError, notificationFailure(error));
          const unavailableSnapshot = unavailableRowCellSnapshot(
            next,
            this.presentationColumnsById.get(columnId),
          );
          if (
            previousSnapshot === undefined ||
            !sameRowCellSnapshot(previousSnapshot, unavailableSnapshot)
          ) {
            this.installRowCellSnapshot(rowId, columnId, unavailableSnapshot);
            firstError = firstNotificationFailure(firstError, notify(listeners));
          }
          continue;
        }
        if (
          previousSnapshot === undefined ||
          !sameRowCellSnapshot(previousSnapshot, nextSnapshot)
        ) {
          this.installRowCellSnapshot(rowId, columnId, nextSnapshot);
          firstError = firstNotificationFailure(firstError, notify(listeners));
        }
      }
    }
    const cellListenerEntries = selectChangedRowEntries(
      this.cellListeners,
      unionChangedRowIds(changedRowIds, this.unavailableCellRows),
    );
    for (const [rowId, columns] of cellListenerEntries) {
      for (const [columnId, listeners] of columns) {
        const previousSnapshot = this.cellSnapshots.get(rowId)?.get(columnId)?.snapshot;
        if (
          previous === next &&
          previousSnapshot?.kind !== "unavailable" &&
          previousSnapshot?.column === this.presentationColumnsById.get(columnId)
        ) {
          continue;
        }
        let nextSnapshot: BrunoTableCellSnapshot;
        try {
          nextSnapshot = readCellSnapshot(next, this.presentationColumnsById, rowId, columnId);
        } catch (error) {
          firstError = firstNotificationFailure(firstError, notificationFailure(error));
          const unavailableSnapshot = unavailableCellSnapshot(
            this.presentationColumnsById.get(columnId),
          );
          if (
            previousSnapshot === undefined ||
            !sameCellSnapshot(previousSnapshot, unavailableSnapshot)
          ) {
            this.installCellSnapshot(rowId, columnId, unavailableSnapshot);
            firstError = firstNotificationFailure(firstError, notify(listeners));
          }
          continue;
        }
        if (previousSnapshot === undefined) {
          this.installCellSnapshot(rowId, columnId, nextSnapshot);
          firstError = firstNotificationFailure(firstError, notify(listeners));
          continue;
        }
        if (previousSnapshot.column !== nextSnapshot.column) {
          this.installCellSnapshot(rowId, columnId, nextSnapshot);
          firstError = firstNotificationFailure(firstError, notify(listeners));
          continue;
        }
        if (sameCellSnapshot(previousSnapshot, nextSnapshot)) {
          this.installCellSnapshot(rowId, columnId, previousSnapshot);
          continue;
        }
        this.installCellSnapshot(rowId, columnId, nextSnapshot);
        firstError = firstNotificationFailure(firstError, notify(listeners));
      }
    }
    return firstError;
  }

  private currentRowSnapshot(rowId: BrunoTableRowId): BrunoTableRowSnapshot {
    const current = this.rowSnapshots.get(rowId);
    if (current !== undefined && current.rowSpace === this.state.rowSpace) return current;
    const next = readRowSnapshot(this.state.rowSpace, rowId);
    if (this.rowListeners.has(rowId)) this.installRowSnapshot(rowId, next);
    return next;
  }

  private installRowSnapshot(rowId: BrunoTableRowId, snapshot: BrunoTableRowSnapshot): void {
    this.rowSnapshots.set(rowId, snapshot);
  }

  private currentRowCellSnapshot(
    rowId: BrunoTableRowId,
    columnId: string,
  ): BrunoTableRowCellSnapshot {
    const current = this.rowCellSnapshots.get(rowId)?.get(columnId);
    const column = this.presentationColumnsById.get(columnId);
    const subscribed = this.rowCellListeners.get(rowId)?.has(columnId) ?? false;
    if (
      current !== undefined &&
      current.column === column &&
      (subscribed || current.rowSpace === this.state.rowSpace)
    ) {
      return current;
    }
    const next = readRowCellSnapshot(
      this.state.rowSpace,
      this.presentationColumnsById,
      rowId,
      columnId,
    );
    this.installRowCellSnapshot(rowId, columnId, next);
    return next;
  }

  private installRowCellSnapshot(
    rowId: BrunoTableRowId,
    columnId: string,
    snapshot: BrunoTableRowCellSnapshot,
  ): void {
    let rowSnapshots = this.rowCellSnapshots.get(rowId);
    if (rowSnapshots === undefined) {
      rowSnapshots = new Map();
      this.rowCellSnapshots.set(rowId, rowSnapshots);
    }
    const previous = rowSnapshots.get(columnId);
    rowSnapshots.set(columnId, snapshot);
    this.updateUnavailableSnapshotCount(
      rowId,
      previous?.kind === "unavailable",
      snapshot.kind === "unavailable",
      this.unavailableRowCellCounts,
      this.unavailableRowCellRows,
    );
  }

  private trackPendingRowCellSnapshot(rowId: BrunoTableRowId, columnId: string): void {
    let rowTokens = this.pendingRowCellTokensByRow.get(rowId);
    if (rowTokens === undefined) {
      rowTokens = new Map();
      this.pendingRowCellTokensByRow.set(rowId, rowTokens);
    }
    const currentToken = rowTokens.get(columnId);
    if (currentToken !== undefined) this.pendingRowCellLru.delete(currentToken);
    const token = currentToken ?? Object.freeze({});
    rowTokens.set(columnId, token);
    this.pendingRowCellLru.set(token, { rowId, columnId });
    if (this.pendingRowCellLru.size <= PENDING_CELL_SNAPSHOT_LIMIT) return;
    const oldestToken = this.pendingRowCellLru.keys().next().value;
    if (oldestToken === undefined) return;
    const oldest = this.pendingRowCellLru.get(oldestToken);
    if (oldest === undefined) return;
    this.clearPendingRowCellSnapshot(oldest.rowId, oldest.columnId);
    if (!this.rowCellListeners.get(oldest.rowId)?.has(oldest.columnId)) {
      this.deleteRowCellSnapshot(oldest.rowId, oldest.columnId);
      if (this.rowCellSnapshots.get(oldest.rowId)?.size === 0) {
        this.rowCellSnapshots.delete(oldest.rowId);
      }
    }
  }

  private clearPendingRowCellSnapshot(rowId: BrunoTableRowId, columnId: string): void {
    const rowTokens = this.pendingRowCellTokensByRow.get(rowId);
    const token = rowTokens?.get(columnId);
    if (token === undefined) return;
    rowTokens?.delete(columnId);
    this.pendingRowCellLru.delete(token);
    if (rowTokens?.size === 0) this.pendingRowCellTokensByRow.delete(rowId);
  }

  private deleteRowCellSnapshot(rowId: BrunoTableRowId, columnId: string): void {
    const rowSnapshots = this.rowCellSnapshots.get(rowId);
    const previous = rowSnapshots?.get(columnId);
    if (previous === undefined) return;
    rowSnapshots?.delete(columnId);
    this.updateUnavailableSnapshotCount(
      rowId,
      previous.kind === "unavailable",
      false,
      this.unavailableRowCellCounts,
      this.unavailableRowCellRows,
    );
  }

  private deleteCellSnapshot(rowId: BrunoTableRowId, columnId: string): void {
    const rowSnapshots = this.cellSnapshots.get(rowId);
    const previous = rowSnapshots?.get(columnId)?.snapshot;
    if (previous === undefined) return;
    rowSnapshots?.delete(columnId);
    this.updateUnavailableSnapshotCount(
      rowId,
      previous.kind === "unavailable",
      false,
      this.unavailableCellCounts,
      this.unavailableCellRows,
    );
  }

  private updateUnavailableSnapshotCount(
    rowId: BrunoTableRowId,
    previousUnavailable: boolean,
    nextUnavailable: boolean,
    counts: Map<BrunoTableRowId, number>,
    rows: Set<BrunoTableRowId>,
  ): void {
    if (previousUnavailable === nextUnavailable) return;
    const nextCount = (counts.get(rowId) ?? 0) + (nextUnavailable ? 1 : -1);
    if (nextCount > 0) {
      counts.set(rowId, nextCount);
      rows.add(rowId);
      return;
    }
    counts.delete(rowId);
    rows.delete(rowId);
  }

  private hasStaleSubscribedColumnSnapshot(): boolean {
    for (const [rowId, columns] of this.rowCellListeners) {
      for (const columnId of columns.keys()) {
        if (
          this.rowCellSnapshots.get(rowId)?.get(columnId)?.column !==
          this.presentationColumnsById.get(columnId)
        ) {
          return true;
        }
      }
    }
    for (const [rowId, columns] of this.cellListeners) {
      for (const columnId of columns.keys()) {
        if (
          this.cellSnapshots.get(rowId)?.get(columnId)?.snapshot.column !==
          this.presentationColumnsById.get(columnId)
        ) {
          return true;
        }
      }
    }
    return false;
  }

  private currentCellSnapshot(rowId: BrunoTableRowId, columnId: string): BrunoTableCellSnapshot {
    const current = this.cellSnapshots.get(rowId)?.get(columnId);
    const column = this.presentationColumnsById.get(columnId);
    const subscribed = this.cellListeners.get(rowId)?.has(columnId) ?? false;
    if (
      current !== undefined &&
      current.snapshot.column === column &&
      (subscribed || current.publicationEpoch === this.cellSnapshotPublicationEpoch)
    ) {
      return current.snapshot;
    }
    const next = this.readCellSnapshot(rowId, columnId);
    if (this.cellListeners.get(rowId)?.has(columnId)) {
      this.installCellSnapshot(rowId, columnId, next);
    }
    return next;
  }

  private readCellSnapshot(rowId: BrunoTableRowId, columnId: string): BrunoTableCellSnapshot {
    return readCellSnapshot(this.state.rowSpace, this.presentationColumnsById, rowId, columnId);
  }

  private installCellSnapshot(
    rowId: BrunoTableRowId,
    columnId: string,
    snapshot: BrunoTableCellSnapshot,
  ): void {
    let rowSnapshots = this.cellSnapshots.get(rowId);
    if (rowSnapshots === undefined) {
      rowSnapshots = new Map();
      this.cellSnapshots.set(rowId, rowSnapshots);
    }
    const previous = rowSnapshots.get(columnId)?.snapshot;
    rowSnapshots.set(
      columnId,
      Object.freeze({ snapshot, publicationEpoch: this.cellSnapshotPublicationEpoch }),
    );
    this.updateUnavailableSnapshotCount(
      rowId,
      previous?.kind === "unavailable",
      snapshot.kind === "unavailable",
      this.unavailableCellCounts,
      this.unavailableCellRows,
    );
  }

  private trackPendingCellSnapshot(rowId: BrunoTableRowId, columnId: string): void {
    let rowTokens = this.pendingCellTokensByRow.get(rowId);
    if (rowTokens === undefined) {
      rowTokens = new Map();
      this.pendingCellTokensByRow.set(rowId, rowTokens);
    }
    const currentToken = rowTokens.get(columnId);
    if (currentToken !== undefined) this.pendingCellLru.delete(currentToken);
    const token = currentToken ?? Object.freeze({});
    rowTokens.set(columnId, token);
    this.pendingCellLru.set(token, { rowId, columnId });
    if (this.pendingCellLru.size <= PENDING_CELL_SNAPSHOT_LIMIT) return;
    const oldestToken = this.pendingCellLru.keys().next().value;
    if (oldestToken === undefined) return;
    const oldest = this.pendingCellLru.get(oldestToken);
    if (oldest === undefined) return;
    this.clearPendingCellSnapshot(oldest.rowId, oldest.columnId);
    if (!this.cellListeners.get(oldest.rowId)?.has(oldest.columnId)) {
      this.deleteCellSnapshot(oldest.rowId, oldest.columnId);
      if (this.cellSnapshots.get(oldest.rowId)?.size === 0) {
        this.cellSnapshots.delete(oldest.rowId);
      }
    }
  }

  private clearPendingCellSnapshot(rowId: BrunoTableRowId, columnId: string): void {
    const rowTokens = this.pendingCellTokensByRow.get(rowId);
    const token = rowTokens?.get(columnId);
    if (token === undefined) return;
    rowTokens?.delete(columnId);
    this.pendingCellLru.delete(token);
    if (rowTokens?.size === 0) this.pendingCellTokensByRow.delete(rowId);
  }
}

function readCellSnapshot<TRow>(
  rowSpace: BrunoTableRowSpaceSnapshot<TRow> | undefined,
  columnsById: ReadonlyMap<string, CompiledColumn>,
  rowId: BrunoTableRowId,
  columnId: string,
): BrunoTableCellSnapshot {
  const column = columnsById.get(columnId);
  const rowPresent = rowSpace?.getRow(rowId) !== undefined;
  return Object.freeze({
    kind: "available",
    column,
    rowPresent,
    value: rowPresent ? rowSpace?.getCellValue(rowId, columnId) : undefined,
  });
}

function readRowSnapshot<TRow>(
  rowSpace: BrunoTableRowSpaceSnapshot<TRow> | undefined,
  rowId: BrunoTableRowId,
): BrunoTableRowSnapshot {
  return Object.freeze({
    kind: "available",
    rowSpace,
    row: rowSpace?.getRow(rowId),
  });
}

function unavailableRowSnapshot<TRow>(
  rowSpace: BrunoTableRowSpaceSnapshot<TRow> | undefined,
): BrunoTableRowSnapshot {
  return Object.freeze({ kind: "unavailable", rowSpace, row: undefined });
}

function readRowCellSnapshot<TRow>(
  rowSpace: BrunoTableRowSpaceSnapshot<TRow> | undefined,
  columnsById: ReadonlyMap<string, CompiledColumn>,
  rowId: BrunoTableRowId,
  columnId: string,
): BrunoTableRowCellSnapshot {
  const column = columnsById.get(columnId);
  const row = rowSpace?.getRow(rowId);
  return Object.freeze({
    kind: "available",
    column,
    rowSpace,
    row,
    value: row === undefined ? undefined : rowSpace?.getCellValue(rowId, columnId),
  });
}

function unavailableRowCellSnapshot<TRow>(
  rowSpace: BrunoTableRowSpaceSnapshot<TRow> | undefined,
  column: CompiledColumn | undefined,
): BrunoTableRowCellSnapshot {
  return Object.freeze({ kind: "unavailable", column, rowSpace, row: undefined, value: undefined });
}

function unavailableCellSnapshot(column: CompiledColumn | undefined): BrunoTableCellSnapshot {
  return Object.freeze({
    kind: "unavailable",
    column,
    value: undefined,
  });
}

function indexColumns(columns: readonly CompiledColumn[]): ReadonlyMap<string, CompiledColumn> {
  return new Map(columns.map((column) => [column.columnId, column]));
}

function createColumnFilterSnapshots(
  collection: BrunoTableClientFilterCollection,
  previousSnapshots?: ReadonlyMap<string, unknown>,
): ReadonlyMap<string, unknown> {
  const snapshots = new Map<string, unknown>();
  for (const [columnId, value] of collection.filtersByColumn) {
    const previous = previousSnapshots?.get(columnId);
    snapshots.set(columnId, Object.is(previous, value) ? previous : value);
  }
  return snapshots;
}

function sameStringSet(previous: ReadonlySet<string>, next: ReadonlySet<string>): boolean {
  return previous.size === next.size && [...previous].every((value) => next.has(value));
}

function sameCellSnapshot(previous: BrunoTableCellSnapshot, next: BrunoTableCellSnapshot): boolean {
  if (previous.kind !== next.kind) return false;
  if (previous.column !== next.column) return false;
  if (previous.kind === "unavailable" || next.kind === "unavailable") return true;
  if (previous.rowPresent !== next.rowPresent) return false;
  return sameAvailableCellValue(previous.value, next.value, next.column);
}

function sameRowCellSnapshot(
  previous: BrunoTableRowCellSnapshot,
  next: BrunoTableRowCellSnapshot,
): boolean {
  if (previous.kind !== next.kind || previous.column !== next.column) return false;
  if (previous.kind === "unavailable" || next.kind === "unavailable") return true;
  const previousServerGrouped = isBrunoTableServerGroupedRow(previous.row);
  const nextServerGrouped = isBrunoTableServerGroupedRow(next.row);
  if (previousServerGrouped || nextServerGrouped) {
    return (
      previousServerGrouped &&
      nextServerGrouped &&
      sameServerGroupedCellDependency(previous.row, next.row, next.column)
    );
  }
  const previousGroupedRowCount = groupedRowCount(previous);
  const nextGroupedRowCount = groupedRowCount(next);
  if (previousGroupedRowCount !== undefined || nextGroupedRowCount !== undefined) {
    return (
      previousGroupedRowCount === nextGroupedRowCount &&
      sameAvailableCellValue(previous.value, next.value, next.column)
    );
  }
  return (
    previous.row === next.row && sameAvailableCellValue(previous.value, next.value, next.column)
  );
}

function sameServerGroupedCellDependency(
  previous: BrunoTableServerGroupedRowSnapshot,
  next: BrunoTableServerGroupedRowSnapshot,
  column: CompiledColumn | undefined,
): boolean {
  if (previous.rowCount !== next.rowCount || column === undefined) return false;
  if (column.columnId === BRUNO_TABLE_ROWS_COLUMN_ID) {
    return sameExactGroupedPresences(previous.groupKeys, next.groupKeys);
  }
  return sameExactGroupedPresence(
    previous.presences.get(column.columnId),
    next.presences.get(column.columnId),
  );
}

function sameExactGroupedPresences(
  previous: BrunoTableServerGroupedRowSnapshot["groupKeys"],
  next: BrunoTableServerGroupedRowSnapshot["groupKeys"],
): boolean {
  return (
    previous.length === next.length &&
    previous.every((presence, index) => sameExactGroupedPresence(presence, next[index]))
  );
}

function sameExactGroupedPresence(
  previous: BrunoTableServerGroupedRowSnapshot["groupKeys"][number] | undefined,
  next: BrunoTableServerGroupedRowSnapshot["groupKeys"][number] | undefined,
): boolean {
  if (previous?._tag !== next?._tag) return false;
  return previous?._tag !== "Present" || next?._tag !== "Present"
    ? true
    : Object.is(previous.value, next.value);
}

function groupedRowCount(snapshot: BrunoTableRowCellSnapshot): bigint | undefined {
  const rowSpace = snapshot.rowSpace;
  const row = snapshot.row;
  if (
    rowSpace === undefined ||
    !("brunoTableClientGrouped" in rowSpace) ||
    rowSpace.brunoTableClientGrouped !== true ||
    typeof row !== "object" ||
    row === null ||
    !("rowCount" in row) ||
    typeof row.rowCount !== "bigint"
  ) {
    return undefined;
  }
  return row.rowCount;
}

function sameAvailableCellValue(
  previous: unknown,
  next: unknown,
  column: CompiledColumn | undefined,
): boolean {
  if (Object.is(previous, next)) return true;
  if (isBrunoTableInvalidCellValue(previous) || isBrunoTableInvalidCellValue(next)) {
    return (
      isBrunoTableInvalidCellValue(previous) &&
      isBrunoTableInvalidCellValue(next) &&
      sameInvalidSource(previous.invalid, next.invalid)
    );
  }
  if (previous === null || previous === undefined || next === null || next === undefined) {
    return false;
  }
  return (
    column !== undefined &&
    column.semantics.equivalent(previous, next) &&
    column.semantics.formatDisplay(previous) === column.semantics.formatDisplay(next)
  );
}

function sameChrome(previous: BrunoTableChromeSnapshot, next: BrunoTableChromeSnapshot): boolean {
  return (
    previous.status === next.status &&
    previous.statusCode === next.statusCode &&
    previous.message === next.message &&
    previous.retry?.run === next.retry?.run &&
    previous.retry?.pending === next.retry?.pending &&
    previous.hasCoherentRows === next.hasCoherentRows &&
    sameInvalidSource(previous.invalid, next.invalid)
  );
}

function sameInvalidSource(
  previous: BrunoTableInvalidSourceSnapshot | undefined,
  next: BrunoTableInvalidSourceSnapshot | undefined,
): boolean {
  if (previous?.kind !== next?.kind) return false;
  if (previous === undefined || next === undefined) return previous === next;
  if (previous.kind === "row-count-mismatch" && next.kind === "row-count-mismatch") {
    return (
      previous.expectedRows === next.expectedRows && previous.receivedRows === next.receivedRows
    );
  }
  if (previous.kind === "invalid-status" && next.kind === "invalid-status") {
    return previous.receivedStatus === next.receivedStatus;
  }
  if (previous.kind === "invalid-lifecycle" && next.kind === "invalid-lifecycle") {
    return previous.field === next.field;
  }
  if (previous.kind === "invalid-rows" && next.kind === "invalid-rows") {
    return previous.receivedRows === next.receivedRows;
  }
  if (previous.kind === "invalid-group" && next.kind === "invalid-group") {
    return previous.columnId === next.columnId && previous.message === next.message;
  }
  return (
    previous.kind === "invalid-value" &&
    next.kind === "invalid-value" &&
    previous.rowIndex === next.rowIndex &&
    previous.columnId === next.columnId &&
    previous.message === next.message
  );
}

function sameSource(previous: BrunoTableSourceSnapshot, next: BrunoTableSourceSnapshot): boolean {
  return previous.totalRows === next.totalRows && previous.loadedRows === next.loadedRows;
}

function sameSourceVersion(
  previous: BrunoTableSourceVersionSnapshot,
  next: BrunoTableSourceVersionSnapshot,
): boolean {
  return previous.version === next.version;
}

function sameBody(previous: BrunoTableBodySnapshot, next: BrunoTableBodySnapshot): boolean {
  return (
    previous.kind === next.kind &&
    (previous.kind === "rows"
      ? next.kind === "rows" && previous.ariaRowCount === next.ariaRowCount
      : previous.kind !== "loading" ||
        (next.kind === "loading" &&
          previous.totalRows === next.totalRows &&
          previous.ariaRowCount === next.ariaRowCount))
  );
}

function stabilizeRuntimeState<TRow>(
  previous: RuntimeState<TRow>,
  next: RuntimeState<TRow>,
): RuntimeState<TRow> {
  return Object.freeze({
    chrome: sameChrome(previous.chrome, next.chrome) ? previous.chrome : next.chrome,
    source: sameSource(previous.source, next.source) ? previous.source : next.source,
    sourceVersion: sameSourceVersion(previous.sourceVersion, next.sourceVersion)
      ? previous.sourceVersion
      : next.sourceVersion,
    body: sameBody(previous.body, next.body) ? previous.body : next.body,
    rowSpace: next.rowSpace,
  });
}

function bodySnapshot<TRow>(
  publication: BrunoTableRowPipelinePublication<TRow>,
): BrunoTableBodySnapshot {
  if (publication.rowSpace !== undefined) {
    if (publication.rowSpace.totalRows === 0) return BODY_EMPTY;
    return publication.loadingAriaRowCount === undefined
      ? BODY_ROWS
      : Object.freeze({ kind: "rows", ariaRowCount: publication.loadingAriaRowCount });
  }
  if (
    (publication.invalid?.kind === "invalid-value" ||
      publication.invalid?.kind === "invalid-group" ||
      publication.invalid?.kind === "invalid-status" ||
      publication.invalid?.kind === "invalid-lifecycle" ||
      publication.invalid?.kind === "invalid-rows") &&
    (publication.status === "closed" || publication.status === "error")
  ) {
    return BODY_EMPTY;
  }
  if (publication.invalid !== undefined) return BODY_INVALID;
  if (publication.status === "loading" && publication.rowSpace === undefined) {
    return Object.freeze({
      kind: "loading",
      totalRows: publication.totalRows,
      ...(publication.loadingAriaRowCount === undefined
        ? {}
        : { ariaRowCount: publication.loadingAriaRowCount }),
    });
  }
  return BODY_EMPTY;
}

function createColumnCommandSnapshots(
  columns: readonly CompiledColumn[],
  query: BrunoTableQuerySnapshot,
  baselineFilterCollection: BrunoTableClientFilterCollection,
  previous?: ReadonlyMap<string, BrunoTableColumnCommandSnapshot>,
  layout?: BrunoTableColumnLayoutSnapshot,
  groupRowsWidth = BRUNO_TABLE_DEFAULT_GROUP_ROWS_COLUMN_WIDTH,
): Map<string, BrunoTableColumnCommandSnapshot> {
  const snapshots = new Map<string, BrunoTableColumnCommandSnapshot>();
  const activeFilterColumnIds = query.filterCollection.columnIds;
  const baselineFilterColumnIds = baselineFilterCollection.columnIds;
  const layoutById = new Map(
    (layout?.allColumns ?? columns).map((column) => [column.columnId, column]),
  );
  const baselineById = new Map(
    (layout?.baselineColumns ?? columns).map((column) => [column.columnId, column]),
  );
  const visibleIds = new Set(layout?.visibleColumnIds ?? columns.map((column) => column.columnId));
  const effectiveOrderBy = query.groupBy.length === 0 ? query.orderBy : query.groupOrderBy;
  const groupedSortable = groupedSortableColumnIds(
    query.groupBy,
    columns,
    layout?.visibleColumnIds ?? columns.map((column) => column.columnId),
  );
  for (const column of columns) {
    const sortIndex = effectiveOrderBy.findIndex((sort) => sort.columnId === column.columnId);
    const sort = effectiveOrderBy[sortIndex];
    const layoutColumn = layoutById.get(column.columnId);
    const widthColumn = layoutColumn ?? column;
    const widthBounds = getBrunoTableColumnWidthBounds(
      widthColumn,
      baselineById.get(column.columnId)?.semantics.width ?? widthColumn.semantics.width,
    );
    const next = Object.freeze({
      sortable:
        query.groupBy.length > 0
          ? groupedSortable.has(column.columnId)
          : column.enableSorting !== false,
      ...(sort === undefined ? {} : { sortDirection: sort.direction, sortPriority: sortIndex + 1 }),
      filterActive: activeFilterColumnIds.has(column.columnId),
      filterBaselineAvailable: baselineFilterColumnIds.has(column.columnId),
      visible: visibleIds.has(column.columnId),
      ...(layoutColumn?.pinned === undefined ? {} : { pinned: layoutColumn.pinned }),
      width: layoutColumn?.semantics.width ?? column.semantics.width,
      minWidth: widthBounds.min,
      maxWidth: widthBounds.max,
    });
    const previousSnapshot = previous?.get(column.columnId);
    snapshots.set(
      column.columnId,
      sameColumnCommand(previousSnapshot, next) && previousSnapshot !== undefined
        ? previousSnapshot
        : next,
    );
  }
  if (query.groupBy.length > 0) {
    const sortIndex = effectiveOrderBy.findIndex(
      (sort) => sort.columnId === "COL_ID_BRUNO_TABLE_ROWS",
    );
    const sort = effectiveOrderBy[sortIndex];
    snapshots.set(
      "COL_ID_BRUNO_TABLE_ROWS",
      Object.freeze({
        sortable: true,
        ...(sort === undefined
          ? {}
          : { sortDirection: sort.direction, sortPriority: sortIndex + 1 }),
        filterActive: false,
        filterBaselineAvailable: false,
        visible: true,
        width: query.rowsWidth ?? groupRowsWidth,
        minWidth: BRUNO_TABLE_MIN_COLUMN_WIDTH,
        maxWidth: BRUNO_TABLE_MAX_COLUMN_WIDTH,
      }),
    );
  }
  return snapshots;
}

function sameColumnCommand(
  previous: BrunoTableColumnCommandSnapshot | undefined,
  next: BrunoTableColumnCommandSnapshot | undefined,
): boolean {
  return (
    previous?.sortable === next?.sortable &&
    previous?.sortDirection === next?.sortDirection &&
    previous?.sortPriority === next?.sortPriority &&
    previous?.filterActive === next?.filterActive &&
    previous?.filterBaselineAvailable === next?.filterBaselineAvailable &&
    previous?.visible === next?.visible &&
    previous?.pinned === next?.pinned &&
    previous?.width === next?.width &&
    previous?.minWidth === next?.minWidth &&
    previous?.maxWidth === next?.maxWidth
  );
}

function sameColumnProjection(
  previous: BrunoTableColumnLayoutSnapshot,
  next: BrunoTableColumnLayoutSnapshot,
  groupBy: readonly string[],
): boolean {
  return (
    sameColumnIdentityAndPinning(previous.allColumns, next.allColumns) &&
    sameStringArray(previous.visibleColumnIds, next.visibleColumnIds) &&
    (groupBy.length === 0 || sameGroupedPresentationWidths(previous, next, groupBy))
  );
}

function sameGroupedPresentationWidths(
  previous: BrunoTableColumnLayoutSnapshot,
  next: BrunoTableColumnLayoutSnapshot,
  groupBy: readonly string[],
): boolean {
  const active = new Set(groupBy);
  const visible = new Set(next.visibleColumnIds);
  const previousById = new Map(previous.allColumns.map((column) => [column.columnId, column]));
  return next.allColumns.every((column) => {
    const participates =
      column.kind === "field" &&
      (active.has(column.columnId) ||
        (column.aggFunc !== undefined && visible.has(column.columnId)));
    return (
      !participates || previousById.get(column.columnId)?.semantics.width === column.semantics.width
    );
  });
}

function sameColumnIdentityAndPinning(
  previous: readonly CompiledColumn[],
  next: readonly CompiledColumn[],
): boolean {
  return (
    previous.length === next.length &&
    previous.every(
      (column, index) =>
        column.columnId === next[index]?.columnId && column.pinned === next[index]?.pinned,
    )
  );
}

function sameStringArray(previous: readonly string[], next: readonly string[]): boolean {
  return previous.length === next.length && previous.every((value, index) => value === next[index]);
}

function selectChangedRowEntries<TValue>(
  entries: ReadonlyMap<BrunoTableRowId, TValue>,
  changedRowIds: ReadonlySet<BrunoTableRowId> | undefined,
): Iterable<readonly [BrunoTableRowId, TValue]> {
  if (changedRowIds === undefined) return entries;
  const selected: Array<readonly [BrunoTableRowId, TValue]> = [];
  for (const rowId of changedRowIds) {
    if (!entries.has(rowId)) continue;
    selected.push([rowId, entries.get(rowId)!]);
  }
  return selected;
}

function unionChangedRowIds(
  changedRowIds: ReadonlySet<BrunoTableRowId> | undefined,
  recoveryRowIds: ReadonlySet<BrunoTableRowId>,
): ReadonlySet<BrunoTableRowId> | undefined {
  if (changedRowIds === undefined || recoveryRowIds.size === 0) return changedRowIds;
  const combined = new Set(changedRowIds);
  for (const rowId of recoveryRowIds) combined.add(rowId);
  return combined;
}

function activeQuerySemanticsChanged(
  previousColumns: readonly CompiledColumn[],
  nextColumns: readonly CompiledColumn[],
  query: BrunoTableQuerySnapshot,
): boolean {
  const activeColumnIds = new Set(query.orderBy.map((sort) => sort.columnId));
  for (const sort of query.groupOrderBy) activeColumnIds.add(sort.columnId);
  for (const columnId of query.groupBy) activeColumnIds.add(columnId);
  for (const columnId of query.filterCollection.columnIds) activeColumnIds.add(columnId);
  for (const columnId of activeColumnIds) {
    const previous = previousColumns.find((column) => column.columnId === columnId);
    const next = nextColumns.find((column) => column.columnId === columnId);
    if (previous === undefined || next === undefined) return true;
    if (!sameQuerySemantics(previous, next)) return true;
  }
  return false;
}

function groupedSortableColumnIds(
  groupBy: readonly string[],
  columns: readonly CompiledColumn[],
  visibleColumnIds: readonly string[],
): ReadonlySet<string> {
  const visible = new Set(visibleColumnIds);
  const result = new Set<string>(["COL_ID_BRUNO_TABLE_ROWS", ...groupBy]);
  for (const column of columns) {
    if (
      column.kind === "field" &&
      column.aggFunc !== undefined &&
      !result.has(column.columnId) &&
      visible.has(column.columnId)
    ) {
      result.add(column.columnId);
    }
  }
  return result;
}

function reconcileGroupedOrderBy(
  input: BrunoTableOrderBy,
  groupBy: readonly string[],
  columns: readonly CompiledColumn[],
  visibleColumnIds: readonly string[],
): BrunoTableOrderBy {
  const admitted = groupedSortableColumnIds(groupBy, columns, visibleColumnIds);
  const seen = new Set<string>();
  const result = input.flatMap((sort) => {
    if (!admitted.has(sort.columnId) || seen.has(sort.columnId)) return [];
    seen.add(sort.columnId);
    return [sort];
  });
  return Object.freeze(
    result.length === 0
      ? (groupBy.length === 0 ? ["COL_ID_BRUNO_TABLE_ROWS"] : groupBy).map((columnId) =>
          Object.freeze({ columnId, direction: "asc" as const }),
        )
      : result,
  );
}

function applyGroupedSortingCommand(
  current: BrunoTableOrderBy,
  groupBy: readonly string[],
  columns: readonly CompiledColumn[],
  visibleColumnIds: readonly string[],
  command: BrunoTableSortingCommand,
): BrunoTableOrderBy {
  const admitted = groupedSortableColumnIds(groupBy, columns, visibleColumnIds);
  const stable = reconcileGroupedOrderBy(current, groupBy, columns, visibleColumnIds);
  if (command.type === "sorting.reset") {
    return Object.freeze(
      groupBy.map((columnId) => Object.freeze({ columnId, direction: "asc" as const })),
    );
  }
  if (!admitted.has(command.columnId)) return stable;
  const index = stable.findIndex((sort) => sort.columnId === command.columnId);
  const selected = stable[index];
  if (command.type === "sorting.add") {
    return selected === undefined
      ? Object.freeze([...stable, Object.freeze({ columnId: command.columnId, direction: "asc" })])
      : stable;
  }
  if (command.type === "sorting.remove") {
    return selected === undefined || stable.length === 1
      ? stable
      : Object.freeze(stable.filter((sort) => sort.columnId !== command.columnId));
  }
  if (command.type === "sorting.move") {
    if (
      selected === undefined ||
      !Number.isInteger(command.targetIndex) ||
      command.targetIndex < 0 ||
      command.targetIndex >= stable.length ||
      command.targetIndex === index
    ) {
      return stable;
    }
    const next = Array.from(stable);
    next.splice(index, 1);
    next.splice(command.targetIndex, 0, selected);
    return Object.freeze(next);
  }
  const direction = selected?.direction === "asc" ? "desc" : "asc";
  return Object.freeze(
    command.multi
      ? selected === undefined
        ? [...stable, Object.freeze({ columnId: command.columnId, direction: "asc" as const })]
        : stable.map((sort, sortIndex) =>
            sortIndex === index ? Object.freeze({ columnId: command.columnId, direction }) : sort,
          )
      : [Object.freeze({ columnId: command.columnId, direction })],
  );
}

function sameFilterCommandSemantics(previous: CompiledColumn, next: CompiledColumn): boolean {
  if (
    previous.columnId !== next.columnId ||
    previous.enableFilter !== next.enableFilter ||
    previous.semantics.editorFamily !== next.semantics.editorFamily
  ) {
    return false;
  }
  if (!sameQuerySemantics(previous, next)) return false;
  if (previous.selectOptions === undefined || next.selectOptions === undefined) {
    return previous.selectOptions === next.selectOptions;
  }
  if (previous.selectOptions.length !== next.selectOptions.length) return false;
  try {
    return previous.selectOptions.every((value, index) =>
      next.semantics.equivalent(value, next.selectOptions?.[index]),
    );
  } catch {
    return false;
  }
}

function sameQuerySemantics(previous: CompiledColumn, next: CompiledColumn): boolean {
  if (
    previous.kind !== next.kind ||
    !Object.is(previous.valueType, next.valueType) ||
    previous.semantics.codecId !== next.semantics.codecId ||
    previous.semantics.codecVersion !== next.semantics.codecVersion ||
    previous.semantics.filterFamily !== next.semantics.filterFamily
  ) {
    return false;
  }
  if (previous.kind === "field" && next.kind === "field") {
    return previous.field === next.field && previous.aggFunc === next.aggFunc;
  }
  if (previous.kind === "computed" && next.kind === "computed") {
    return (
      previous.valueGetter === next.valueGetter &&
      previous.fields.length === next.fields.length &&
      previous.fields.every((field, index) => field === next.fields[index])
    );
  }
  return false;
}

function sameOrderBy(previous: BrunoTableOrderBy, next: BrunoTableOrderBy): boolean {
  return (
    previous.length === next.length &&
    previous.every(
      (sort, index) =>
        sort.columnId === next[index]?.columnId && sort.direction === next[index]?.direction,
    )
  );
}

function stabilizeInstalledClientProjection(
  previous: BrunoTableInstalledClientProjectionSnapshot | undefined,
  candidate: BrunoTableClientProjectionPublication | null | undefined,
): BrunoTableInstalledClientProjectionSnapshot | undefined {
  if (candidate === undefined) return previous;
  if (candidate === null) return undefined;
  if (
    previous !== undefined &&
    previous.kind === candidate.kind &&
    previous.layoutKey === candidate.layoutKey &&
    previous.presentationKey === candidate.presentationKey &&
    previous.queryGeneration === candidate.queryGeneration &&
    previous.queryNavigationMode === candidate.queryNavigationMode &&
    sameStringArray(previous.groupBy, candidate.groupBy) &&
    sameStringArray(previous.rowIds, candidate.rowIds) &&
    sameInvalidClientProjection(previous, candidate)
  ) {
    return previous;
  }
  return Object.freeze({ ...candidate, epoch: (previous?.epoch ?? -1) + 1 });
}

function stabilizeInstalledGroupingStructure(
  previous: BrunoTableInstalledGroupingStructureSnapshot,
  projection: BrunoTableInstalledClientProjectionSnapshot | undefined,
): BrunoTableInstalledGroupingStructureSnapshot {
  const layoutKey = projection?.layoutKey ?? BRUNO_TABLE_RAW_CLIENT_PROJECTION_LAYOUT_KEY;
  const groupBy = projection?.groupBy ?? EMPTY_GROUPING;
  const columns = groupBy.length === 0 ? undefined : projection?.columns;
  const presentationKey =
    groupBy.length === 0
      ? BRUNO_TABLE_RAW_CLIENT_PROJECTION_LAYOUT_KEY
      : (projection?.presentationKey ?? BRUNO_TABLE_RAW_CLIENT_PROJECTION_LAYOUT_KEY);
  if (
    previous.layoutKey === layoutKey &&
    previous.presentationKey === presentationKey &&
    sameStringArray(previous.groupBy, groupBy)
  ) {
    return previous;
  }
  return Object.freeze({ layoutKey, presentationKey, groupBy, columns });
}

function installedRowsHeaderName(
  projection: BrunoTableInstalledClientProjectionSnapshot | undefined,
  previous: string,
): string {
  if (projection === undefined || projection.groupBy.length === 0) return "Rows";
  return (
    projection.columns.find((column) => column.columnId === "COL_ID_BRUNO_TABLE_ROWS")
      ?.headerName ?? previous
  );
}

function sameInvalidClientProjection(
  previous: BrunoTableInstalledClientProjectionSnapshot,
  next: BrunoTableClientProjectionPublication,
): boolean {
  return (
    previous.kind === next.kind &&
    (previous.kind !== "invalid" ||
      next.kind !== "invalid" ||
      sameInvalidSource(previous.invalid, next.invalid))
  );
}

function subscribe(listeners: Set<Listener>, listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

type NotificationFailure = Readonly<{ readonly value: unknown }>;

function notificationFailure(value: unknown): NotificationFailure {
  return Object.freeze({ value });
}

function firstNotificationFailure(
  current: NotificationFailure | undefined,
  next: NotificationFailure | undefined,
): NotificationFailure | undefined {
  return current ?? next;
}

function notifyListeners<TArguments extends readonly unknown[]>(
  listeners: ReadonlySet<(...arguments_: TArguments) => void>,
  ...arguments_: TArguments
): NotificationFailure | undefined {
  let firstError: NotificationFailure | undefined;
  for (const listener of listeners) {
    try {
      listener(...arguments_);
    } catch (error) {
      firstError ??= notificationFailure(error);
    }
  }
  return firstError;
}

function notify(listeners: Set<Listener>): NotificationFailure | undefined {
  return notifyListeners(listeners);
}

function notifyRowChangeListeners(
  listeners: Set<RowChangeListener>,
  changedRowIds: ReadonlySet<BrunoTableRowId> | undefined,
): NotificationFailure | undefined {
  return notifyListeners(listeners, changedRowIds);
}
