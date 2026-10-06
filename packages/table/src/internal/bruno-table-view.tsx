import { Alert, AlertDescription, AlertTitle } from "@bruno/shadcn/alert";
import { buttonVariants } from "@bruno/shadcn/button";
import { DirectionProvider } from "@bruno/shadcn/direction";
import { Skeleton } from "@bruno/shadcn/skeleton";
import { Spinner } from "@bruno/shadcn/spinner";
import { Checkbox } from "@bruno/shadcn/checkbox";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@bruno/shadcn/dropdown-menu";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowsHorizontalIcon,
  DotsThreeVerticalIcon,
  PushPinIcon,
  PushPinSlashIcon,
  WarningDiamondIcon,
} from "@phosphor-icons/react";
import {
  createContext,
  useCallback,
  useContext,
  forwardRef,
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { flushSync } from "react-dom";
import { BrunoTableMountedRowSlots } from "./mounted-row-slots";
import { BrunoTableSortPanel } from "./renderer-sort-panel";
import { EmptySourceBody, invalidSourceDetails, SourceLifecycle } from "./renderer-source-chrome";
import {
  BrunoTableToolbar,
  BrunoTableToolbarStore,
  GridOwnedToolRail,
  ToolbarOutlet,
} from "./renderer-toolbar";

import type {
  ComponentType,
  CSSProperties,
  ForwardedRef,
  NamedExoticComponent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
  ReactNode,
  RefCallback,
  RefObject,
} from "react";
import { useBatcher } from "@tanstack/react-pacer";

import type { BrunoTableColumnId } from "../public-types";

import type { CompiledColumn } from "./compile-columns";
import {
  brunoTableCellPresentationUsesRawRow as cellPresentationUsesRawRow,
  brunoTableProxyPresentationUsesRawRow as proxyPresentationUsesRawRow,
  resolveBrunoTableCellClassName as resolveCellClassName,
  resolveBrunoTableCellContent as resolveCellContent,
  resolveBrunoTableProxyCellClassName as resolveProxyCellClassName,
  resolveBrunoTableProxyCellContent as resolveProxyCellContent,
} from "./cell-presentation";
import { prepareBrunoTableGroupingRemovalFocus } from "./client-grouping-focus";
import { isBrunoTableDocumentFocusChainActive } from "./focus-ownership";
import { useBrunoTableGridTabStopHandoff } from "./focus";
import {
  armBrunoTableProducedTextCapture,
  installBrunoTableProducedTextEvidence,
} from "./produced-text-evidence";
import {
  type BrunoTableHotkeyGesture,
  isBrunoTableHotkeyWorkflowOwner,
  requestBrunoTableHotkeyWorkflowAction,
  useBrunoTableGridHotkeys,
  useBrunoTableHotkeyWorkflowAction,
  BrunoTableHeldShiftHotkeyAdapter,
  isBrunoTableHotkeyHeld,
} from "./hotkey-adapter";
import {
  BrunoTableGridSurfaceCommitDiagnosticProbe,
  BrunoTableHeaderCommitDiagnosticProbe,
  BrunoTableRowCommitDiagnosticProbe,
  BrunoTableRowSelectionCommitDiagnosticProbe,
  BrunoTableViewCommitDiagnosticProbe,
  createBrunoTableCellCommitDiagnosticRef,
} from "./commit-diagnostic-probes";
import {
  createBrunoTableColumnGestureActor,
  type BrunoTableColumnGestureActor,
} from "./column-gesture";
import {
  projectBrunoTableLogicalColumnIndex,
  resolveBrunoTableReorderCenterBounds,
  resolveBrunoTableReorderTargetIndex,
  type BrunoTableReorderMeasurement,
} from "./column-geometry";
import {
  BRUNO_TABLE_LIVE_TOTAL_WIDTH_CSS_VARIABLE,
  BRUNO_TABLE_LIVE_VIEWPORT_FILL_CSS_VARIABLE,
  BRUNO_TABLE_LIVE_LEFT_PADDING_CSS_VARIABLE,
  BRUNO_TABLE_LIVE_RIGHT_PADDING_CSS_VARIABLE,
  brunoTableColumnCssVariable,
  brunoTablePinnedWidthCssVariable,
  clampBrunoTableColumnWidth,
  type BrunoTableColumnLayoutSnapshot,
  type BrunoTableGridCommand,
} from "./column-management";
import {
  BrunoTableNavigationRuntime,
  isBrunoTableCellRangeNavigationCommandAdmitted,
  type BrunoTableActiveCell,
  type BrunoTableNavigationCommand,
} from "./navigation";
import type {
  BrunoTableCellSnapshot,
  BrunoTableChromeSnapshot,
  BrunoTableColumnCommandSnapshot,
  BrunoTableQueryNavigationMode,
  BrunoTableRowCellSnapshot,
  BrunoTableRowSpaceSnapshot,
  BrunoTableRuntimeView,
} from "./grid-runtime";
import {
  BRUNO_TABLE_RAW_CLIENT_PROJECTION_LAYOUT_KEY,
  isBrunoTableInvalidCellValue,
} from "./grid-runtime";
import {
  recordBrunoTableClientColumnPreviewStyleWrite,
  recordBrunoTableClientColumnReorderFrame,
  recordBrunoTableClientColumnResizeFrame,
  recordBrunoTableClientColumnGestureFrame,
  recordBrunoTableClientColumnGestureListener,
  hasBrunoTableClientColumnGestureFrameListener,
} from "./render-instrumentation";
import { recordBrunoTableReviewCellSubscription } from "./grid-subscription-instrumentation";
import {
  BrunoTableLoadingViewportAdapterBoundary,
  BrunoTableViewportAdapterBoundary,
  useBrunoTableRowIdentitySnapshot,
} from "./react-compiler-adapters";
import {
  BRUNO_TABLE_DEFAULT_VIEWPORT_HEIGHT,
  BRUNO_TABLE_HEADER_HEIGHT_CSS_VARIABLE,
  BRUNO_TABLE_PREPARED_ENTERING_DISPLAY_CSS_VARIABLE,
  BRUNO_TABLE_PREPARED_LEFT_PADDING_CSS_VARIABLE,
  BRUNO_TABLE_PREPARED_RETIRING_DISPLAY_CSS_VARIABLE,
  BRUNO_TABLE_PREPARED_RIGHT_PADDING_CSS_VARIABLE,
  BRUNO_TABLE_ROW_HEIGHT,
  BRUNO_TABLE_SCROLLBAR_TRACK_THICKNESS,
  BRUNO_TABLE_VIEWPORT_INLINE_SIZE_CSS_VARIABLE,
  BRUNO_TABLE_VIEWPORT_LOGICAL_SCROLL_LEFT_CSS_VARIABLE,
  type BrunoTableBodyColumnWindowSnapshot,
  type BrunoTableRowRangeSnapshot,
  type BrunoTableViewportSnapshot,
  type BrunoTableViewportBodyHitRequest,
} from "./virtual-viewport";

import {
  BRUNO_TABLE_ROW_SELECTION_COLUMN_ID,
  type BrunoTableRowSelectionRuntime,
} from "./row-selection";
import {
  captureBrunoTableClipboardSnapshot,
  clipboardTargetFromRange,
  clipboardTargetFromSelection,
  brunoTableCellRangePointerHit,
  createBrunoTableCellRangeStructure,
  createBrunoTableCellRangeStructureFromRowSpace,
  serializeBrunoTableClipboardSnapshot,
  type BrunoTableCellRange,
  type BrunoTableCellRangeRuntime,
} from "./cell-range-clipboard";
import type {
  BrunoTableCellEditRuntime,
  BrunoTableCellEditDraftReviewSourceRow,
  BrunoTableCellEditMovement,
  BrunoTableCellEditMovementOrigin,
  BrunoTableCellEditProjection,
  BrunoTableCellEditSessionSnapshot,
} from "./cell-edit";
import { isBrunoTableCellEditDraftReviewSourceRow } from "./cell-edit-evidence";
import type {
  BrunoTablePasteRuntime,
  BrunoTablePasteConfirmation,
  BrunoTablePasteDiagnostic,
} from "./cell-paste";
import type {
  BrunoTableDragFillRuntime,
  BrunoTableDragFillInteractionGeometry,
  BrunoTableDragFillSource,
  BrunoTableDragFillSourceShape,
} from "./drag-fill";
import type { BrunoTableEditMemoryRuntime } from "./edit-memory";
import type { BrunoTableEditCapability } from "./client-edit-capability";
import { BRUNO_TABLE_REVIEW_VIEWPORT_MAX_HEIGHT_PROPERTY } from "./review-viewport";

const ROW_HEIGHT = BRUNO_TABLE_ROW_HEIGHT;
const ROW_SELECTION_COLUMN_WIDTH = 40;
const BRUNO_TABLE_HEADER_GHOST_BUTTON_CLASS = buttonVariants({ variant: "ghost", size: "xs" });
type BrunoTableCellCommandReader = ReturnType<BrunoTableRuntimeView["captureCellCommandReader"]>;
type BrunoTableEditValueCommandReader = ReturnType<
  BrunoTableCellEditRuntime["captureEditValueCommandReader"]
>;

function readBrunoTableEffectiveCanonicalCell(
  readCell: BrunoTableCellCommandReader,
  readEditValue: BrunoTableEditValueCommandReader | undefined,
  rowId: string,
  columnId: string,
):
  | Readonly<{
      readonly value: unknown;
      readonly formatCanonicalText: (value: unknown) => string;
    }>
  | undefined {
  const cell = readCell(rowId, columnId);
  if (cell.kind !== "available" || !cell.rowPresent || cell.column === undefined) {
    return undefined;
  }
  const editValue = readEditValue?.(rowId, columnId);
  const effectiveValue = editValue?.hasEditValue === true ? editValue.value : cell.value;
  if (isBrunoTableInvalidCellValue(effectiveValue)) return undefined;
  const editPresentationColumn =
    editValue?.hasEditValue === true ? editValue.presentationColumn : undefined;
  return Object.freeze({
    value: effectiveValue,
    formatCanonicalText:
      editPresentationColumn?.semantics.formatCanonicalText ??
      cell.column.semantics.formatCanonicalText,
  });
}

const EMPTY_DRAG_FILL_INTERACTION_GEOMETRY: BrunoTableDragFillInteractionGeometry = Object.freeze({
  bodyTop: 0,
  bodyBottom: 1,
  centreLeft: 0,
  centreRight: 0,
});
const SAVE_SUCCESS_KEYFRAMES = `
@keyframes bruno-table-save-success {
  0%, 20% { opacity: 1; }
  100% { opacity: 0; }
}
[data-bruno-save-success]::after {
  animation: bruno-table-save-success 2s ease-out both;
  background: color-mix(in oklab, var(--color-success) 28%, transparent);
  content: "";
  inset: 0;
  pointer-events: none;
  position: absolute;
}
@media (prefers-reduced-motion: reduce) {
  [data-bruno-save-success]::after { animation: none; opacity: 1; }
}`;

type BrunoTableColumnWindow = Readonly<
  Pick<
    BrunoTableViewportSnapshot["virtualWindow"],
    | "pinnedStart"
    | "center"
    | "pinnedEnd"
    | "pinningSuspended"
    | "centerStartIndex"
    | "centerCount"
    | "leftPadding"
    | "rightPadding"
    | "totalWidth"
  >
>;
type InteractiveDomElement = HTMLElement | SVGElement;
type BrunoTableColumnGesture = {
  readonly kind: "resize" | "reorder";
  readonly pointerId: number;
  readonly columnId: string;
  readonly sourceIndex: number;
  readonly startX: number;
  readonly initialWidth: number;
  readonly minWidth: number;
  readonly maxWidth: number;
  readonly direction: "ltr" | "rtl";
  readonly sourcePinned: "start" | "end" | undefined;
  readonly pinningSuspended: boolean;
  readonly groupStart: number;
  readonly groupEnd: number;
  readonly target: HTMLElement;
  readonly onPointerMove: (event: globalThis.PointerEvent) => void;
  readonly onPointerUp: (event: globalThis.PointerEvent) => void;
  readonly onPointerCancel: (event: globalThis.PointerEvent) => void;
  reorderGeometry: readonly BrunoTableReorderGeometry[];
  reorderGeometryVersion: number;
  reorderGeometryVersionBeforeScroll: number;
  readonly reorderCenterBounds: Readonly<{ readonly left: number; readonly right: number }>;
  currentX: number;
  previewedX: number | undefined;
  reorderPreviewApplied: boolean;
  targetIndex: number;
  targetPinned: "start" | "end" | undefined;
  frame: number | null;
};
type BrunoTableReorderGeometry = BrunoTableReorderMeasurement &
  Readonly<{ readonly element: HTMLElement }>;
type BrunoTableColumnPointerDownHandler = (
  event: ReactPointerEvent<HTMLElement>,
  column: CompiledColumn,
  kind: "resize" | "reorder",
) => void;
const INTERACTIVE_DESCENDANT_SELECTOR =
  'a[href],area[href],button,input,select,summary,textarea,iframe,object,embed,audio[controls],video[controls],[contenteditable]:not([contenteditable="false"]),[tabindex]';
const EMBEDDED_BROWSING_CONTEXT_SELECTOR = "iframe,object,embed";
const VISUALLY_HIDDEN: CSSProperties = {
  clip: "rect(0 0 0 0)",
  clipPath: "inset(50%)",
  height: 1,
  overflow: "hidden",
  position: "absolute",
  whiteSpace: "nowrap",
  width: 1,
};

const BrunoTableCellEditContext = createContext<BrunoTableCellEditRuntime | undefined>(undefined);
const BrunoTableEditMemoryContext = createContext<BrunoTableEditMemoryRuntime | undefined>(
  undefined,
);
const NO_CELL_EDIT_PROJECTION: BrunoTableCellEditProjection = Object.freeze({
  active: false,
  hasDraft: false,
});
const NO_CELL_EDIT_SESSION: BrunoTableCellEditSessionSnapshot = Object.freeze({ kind: "idle" });
const subscribeNoCellEditSession =
  (_listener: () => void): (() => void) =>
  () =>
    undefined;
const getNoCellEditSession = (): BrunoTableCellEditSessionSnapshot => NO_CELL_EDIT_SESSION;
const EMPTY_ACTIVE_BODY_COLUMN_WINDOW: BrunoTableBodyColumnWindowSnapshot = Object.freeze({
  center: Object.freeze([]),
  centerStartIndex: 0,
  leftPadding: 0,
  rightPadding: 0,
});
const subscribeInactiveBodyColumnWindow =
  (_listener: () => void): (() => void) =>
  () =>
    undefined;
const getInactiveBodyColumnWindow = (): BrunoTableBodyColumnWindowSnapshot =>
  EMPTY_ACTIVE_BODY_COLUMN_WINDOW;
const EMPTY_ROW_RANGE: BrunoTableRowRangeSnapshot = Object.freeze({
  rowStart: 0,
  rowEnd: 0,
  segmentedRows: false,
  totalHeight: 0,
});
const getInactiveRowRange = (): BrunoTableRowRangeSnapshot => EMPTY_ROW_RANGE;
const BrunoTableEditCapabilityContext = createContext<BrunoTableEditCapability | undefined>(
  undefined,
);
const EMPTY_TRAVERSAL_QUEUE = Object.freeze({
  addItem: (_item: number): boolean => false,
  clear: (): void => undefined,
});
const BrunoTableBodyColumnWindowContext = createContext<BrunoTableBodyColumnWindowSnapshot>(
  EMPTY_ACTIVE_BODY_COLUMN_WINDOW,
);

const BrunoTableBodyColumnWindowProvider = memo(function BrunoTableBodyColumnWindowProvider({
  children,
  enabled,
  getSnapshot,
  subscribe,
}: {
  readonly children: ReactNode;
  readonly enabled: boolean;
  readonly getSnapshot: () => BrunoTableBodyColumnWindowSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
}) {
  const snapshot = useSyncExternalStore(
    enabled ? subscribe : subscribeInactiveBodyColumnWindow,
    enabled ? getSnapshot : getInactiveBodyColumnWindow,
    enabled ? getSnapshot : getInactiveBodyColumnWindow,
  );
  return (
    <BrunoTableBodyColumnWindowContext.Provider value={snapshot}>
      {children}
    </BrunoTableBodyColumnWindowContext.Provider>
  );
});

function totalColumnWidth(columns: readonly CompiledColumn[]): number {
  return columns.reduce((total, column) => total + column.semantics.width, 0);
}

function columnHeaderName(columns: readonly CompiledColumn[], columnId: string): string {
  return columns.find((column) => column.columnId === columnId)?.headerName ?? columnId;
}

function commitBrunoTableColumnResize(
  runtime: BrunoTableRuntimeView,
  columnId: string,
  requestedWidth: number,
): number {
  const command = runtime.getColumnCommandSnapshot(columnId);
  const width = clampBrunoTableColumnWidth(requestedWidth, {
    min: command.minWidth,
    max: command.maxWidth,
  });
  if (width !== command.width) {
    runtime.dispatchGridCommand({ type: "column.resize.commit", columnId, width });
  }
  return runtime.getColumnCommandSnapshot(columnId).width;
}

function readBrunoTableMenuDirection(element?: Element | null): "ltr" | "rtl" {
  if (typeof document === "undefined") return "ltr";
  const source = element ?? document.activeElement;
  const grid = source?.closest<HTMLElement>('[role="grid"]') ?? null;
  const ownerDocument = source?.ownerDocument ?? document;
  return getComputedStyle(grid ?? ownerDocument.documentElement).direction === "rtl"
    ? "rtl"
    : "ltr";
}

function isNodeInBrunoTableRealm(owner: HTMLElement, target: EventTarget | null): target is Node {
  const OwnerNode = owner.ownerDocument.defaultView?.Node;
  return OwnerNode !== undefined && target instanceof OwnerNode;
}

function asBrunoTableRealmElement(owner: HTMLElement, target: EventTarget | null): Element | null {
  const OwnerElement = owner.ownerDocument.defaultView?.Element;
  return OwnerElement !== undefined && target instanceof OwnerElement ? target : null;
}

function asBrunoTableRealmInteractiveElement(
  owner: HTMLElement,
  target: EventTarget | null,
): InteractiveDomElement | null {
  const element = asBrunoTableRealmElement(owner, target);
  if (element === null) return null;
  const ownerWindow = owner.ownerDocument.defaultView;
  return (ownerWindow?.HTMLElement !== undefined && element instanceof ownerWindow.HTMLElement) ||
    (ownerWindow?.SVGElement !== undefined && element instanceof ownerWindow.SVGElement)
    ? element
    : null;
}

export function asBrunoTableRealmHTMLElement(
  owner: HTMLElement,
  target: EventTarget | null,
): HTMLElement | null {
  const OwnerHTMLElement = owner.ownerDocument.defaultView?.HTMLElement;
  return OwnerHTMLElement !== undefined && target instanceof OwnerHTMLElement ? target : null;
}

export function isBrunoTableColumnMenuTriggerTarget(
  owner: HTMLElement | null,
  target: EventTarget | null,
): boolean {
  if (owner === null) return false;
  const element = asBrunoTableRealmHTMLElement(owner, target);
  return element !== null && element.closest("button[data-bruno-column-menu-trigger]") !== null;
}

function cellDomId(instanceId: string, tableId: string, rowId: string, columnId: string): string {
  return `bruno-table-cell-${encodeDomIdSegment(instanceId)}-${encodeDomIdSegment(tableId)}-${encodeDomIdSegment(rowId)}-${encodeDomIdSegment(columnId)}`;
}

function preparedCellDomId(
  instanceId: string,
  tableId: string,
  rowId: string,
  columnId: string,
  stage: "entering" | "retiring",
): string {
  return `${cellDomId(instanceId, tableId, rowId, columnId)}--prepared-${stage}`;
}

function headerDomId(instanceId: string, tableId: string, columnId: string): string {
  return `bruno-table-header-${encodeDomIdSegment(instanceId)}-${encodeDomIdSegment(tableId)}-${encodeDomIdSegment(columnId)}`;
}

function loadingCellDomId(
  instanceId: string,
  tableId: string,
  rowIndex: number,
  columnId: string,
): string {
  return `bruno-table-loading-cell-${encodeDomIdSegment(instanceId)}-${encodeDomIdSegment(tableId)}-${String(rowIndex)}-${encodeDomIdSegment(columnId)}`;
}

const BRUNO_TABLE_DOM_ID_SEGMENT_CACHE_LIMIT = 16_384;
const brunoTableDomIdSegmentCache = new Map<string, string>();

function encodeDomIdSegment(value: string): string {
  const cached = brunoTableDomIdSegmentCache.get(value);
  if (cached !== undefined) return cached;
  let encoded = "";
  for (let index = 0; index < value.length; index += 1) {
    encoded += value.charCodeAt(index).toString(16).padStart(4, "0");
  }
  if (brunoTableDomIdSegmentCache.size >= BRUNO_TABLE_DOM_ID_SEGMENT_CACHE_LIMIT) {
    const oldest = brunoTableDomIdSegmentCache.keys().next().value;
    if (oldest !== undefined) brunoTableDomIdSegmentCache.delete(oldest);
  }
  brunoTableDomIdSegmentCache.set(value, encoded);
  return encoded;
}

function activeDomId(
  instanceId: string,
  tableId: string,
  activeCell: BrunoTableActiveCell,
): string | undefined {
  return activeCell.region === "header"
    ? headerDomId(instanceId, tableId, activeCell.columnId)
    : activeCell.rowId === undefined
      ? loadingCellDomId(instanceId, tableId, activeCell.rowIndex, activeCell.columnId)
      : cellDomId(instanceId, tableId, activeCell.rowId, activeCell.columnId);
}

function mountedActiveDomId(
  instanceId: string,
  tableId: string,
  activeCell: BrunoTableActiveCell,
  rowSpace: BrunoTableRowSpaceSnapshot<unknown> | undefined,
): string | undefined {
  return activeDomIdForRowIdentity(
    instanceId,
    tableId,
    activeCell,
    rowSpace?.getRowId(activeCell.rowIndex),
  );
}

function activeDomIdForRowIdentity(
  instanceId: string,
  tableId: string,
  activeCell: BrunoTableActiveCell,
  currentRowId: string | undefined,
): string | undefined {
  if (
    activeCell.region === "body" &&
    activeCell.rowId !== undefined &&
    currentRowId === undefined
  ) {
    return loadingCellDomId(instanceId, tableId, activeCell.rowIndex, activeCell.columnId);
  }
  return activeDomId(instanceId, tableId, activeCell);
}

export { BrunoTableToolbar, BrunoTableToolbarStore };

export type BrunoTableViewProps<
  TRuntime extends BrunoTableRuntimeView = BrunoTableRuntimeView,
  TAdapter = unknown,
> = {
  readonly runtime: TRuntime;
  readonly tableId: string;
  /** Private accessible name override for an internally composed grid. */
  readonly gridAriaLabel?: string | undefined;
  readonly compiledColumns: readonly CompiledColumn[];
  readonly toolbar: BrunoTableToolbarStore;
  readonly rowPipeline: ComponentType<BrunoTableRowPipelineProps<TRuntime, TAdapter>>;
  readonly rowPipelineAdapter: TAdapter;
  readonly renderColumnFilter?: BrunoTableColumnFilterRenderer | undefined;
  /** Private read-only capability: copy one loaded Active Cell through canonical semantics. */
  readonly enableActiveCellCopy?: boolean;
  /** Private capability seam for controls that belong to every variant's grid-owned rail. */
  readonly gridOwnedControls?: ReactNode;
  /** Private Client-only Row Selection capability. */
  readonly rowSelection?: BrunoTableRowSelectionRuntime | undefined;
  /** Private Client-only one-axis Cell Range Selection and Copy capability. */
  readonly cellRange?: BrunoTableCellRangeRuntime | undefined;
  /** Private Client-only edit workflow and rendering capability. */
  readonly editCapability?: BrunoTableEditCapability | undefined;
};

function getBrunoTableGridAriaKeyShortcuts({
  copyEnabled,
  pasteEnabled,
  redoEnabled,
  rowSelectionEnabled,
  undoEnabled,
}: Readonly<{
  readonly copyEnabled: boolean;
  readonly pasteEnabled: boolean;
  readonly redoEnabled: boolean;
  readonly rowSelectionEnabled: boolean;
  readonly undoEnabled: boolean;
}>): string {
  const shortcuts = ["Alt+ArrowLeft", "Alt+ArrowRight", "Shift+F10", "ContextMenu"];
  if (copyEnabled) shortcuts.push("Control+C", "Meta+C");
  if (pasteEnabled) shortcuts.push("Control+V", "Meta+V");
  if (rowSelectionEnabled) {
    shortcuts.push("Space", "Shift+Space", "Control+A", "Meta+A");
  }
  if (undoEnabled) shortcuts.push("Control+Z", "Meta+Z");
  if (redoEnabled) shortcuts.push("Control+Shift+Z", "Meta+Shift+Z", "Control+Y", "Meta+Y");
  return shortcuts.join(" ");
}

export type BrunoTableColumnFilterRendererProps = {
  readonly column: CompiledColumn;
  readonly command: BrunoTableColumnCommandSnapshot;
  readonly runtime: BrunoTableRuntimeView;
  readonly activateHeaderCommand: (columnId: string) => void;
  readonly restoreColumnFocus: (columnId: string) => void;
  readonly registerColumnFilterOpener: (columnId: string, open: () => void) => () => void;
};

export type BrunoTableColumnFilterRenderer = (
  props: BrunoTableColumnFilterRendererProps,
) => ReactElement;

function supportsBrunoTableCustomColumnFilter(
  column: CompiledColumn,
  renderColumnFilter: BrunoTableColumnFilterRenderer | undefined,
): boolean {
  return (
    renderColumnFilter !== undefined && column.kind === "field" && column.enableFilter !== false
  );
}

export type BrunoTableRowPipelineProps<
  TRuntime extends BrunoTableRuntimeView = BrunoTableRuntimeView,
  TAdapter = unknown,
> = {
  readonly runtime: TRuntime;
  readonly tableId: string;
  readonly columns: readonly CompiledColumn[];
  readonly rowPipelineAdapter: TAdapter;
  readonly rowSelection?: BrunoTableRowSelectionRuntime | undefined;
  readonly cellRange?: BrunoTableCellRangeRuntime | undefined;
  readonly children: (snapshot: BrunoTableRowPipelineSnapshot) => ReactElement;
};

export type BrunoTableRowPipelineSnapshot =
  | Readonly<{
      readonly kind: "rows";
      readonly runtime: BrunoTableRuntimeView;
      readonly columns: readonly CompiledColumn[];
      readonly rowSpace: BrunoTableLogicalRowSpace;
      readonly queryGeneration: number;
      readonly queryNavigationMode: BrunoTableQueryNavigationMode;
      readonly loading: boolean;
    }>
  | Readonly<{
      readonly kind: "invalid";
      readonly columns: readonly CompiledColumn[];
      readonly invalid: Extract<
        BrunoTableChromeSnapshot["invalid"],
        { readonly kind: "invalid-value" | "invalid-group" }
      >;
    }>;

export type BrunoTableLogicalRowSpace = Readonly<{
  readonly totalRows: number;
  readonly getRowId: (index: number) => string | undefined;
  readonly findRowIndex: (rowId: string) => number | undefined;
  readonly setRequiredRange: (start: number, end: number) => void;
  readonly identitySource?: Readonly<{
    readonly getSnapshot: () => Readonly<{
      readonly getRowId: (index: number) => string | undefined;
      readonly findRowIndex: (rowId: string) => number | undefined;
    }>;
    readonly subscribe: (listener: () => void) => () => void;
  }>;
  readonly identitySnapshot?:
    | Readonly<{
        readonly rowIds: readonly string[];
        readonly rowIndexById: ReadonlyMap<string, number>;
      }>
    | undefined;
  readonly missingRowIdentityBehavior?:
    | "clear-conflicting-active-cell"
    | "fallback-to-display-index";
}>;

function BrunoTableViewImplementation<TRuntime extends BrunoTableRuntimeView, TAdapter>({
  runtime,
  tableId,
  gridAriaLabel,
  compiledColumns,
  toolbar,
  rowPipeline,
  rowPipelineAdapter,
  renderColumnFilter,
  enableActiveCellCopy = false,
  gridOwnedControls,
  rowSelection,
  cellRange,
  editCapability,
}: BrunoTableViewProps<TRuntime, TAdapter>): ReactElement {
  const editMemory = editCapability?.editMemory;
  const resolvedGridAriaLabel = gridAriaLabel ?? `Data for ${tableId}`;
  const tableElement = useRef<HTMLElement | null>(null);
  const focusFallback = useMemo(
    () => () => tableElement.current?.focus({ preventScroll: true }),
    [],
  );
  useLayoutEffect(
    () =>
      editMemory?.registerGridFocusCommand(
        () => {
          const owner = tableElement.current;
          const grid = [
            ...(owner?.querySelectorAll<HTMLElement>("[data-bruno-scroll-owner]") ?? []),
          ].find((candidate) => candidate.closest("[data-bruno-table]") === owner);
          if (grid === undefined || grid === null) focusFallback();
          else grid.focus({ preventScroll: true });
        },
        () => tableElement.current?.ownerDocument,
      ),
    [editMemory, focusFallback],
  );
  return (
    <section
      ref={tableElement}
      aria-label={gridAriaLabel ?? tableId}
      className="relative data-[bruno-table]:isolate"
      data-bruno-table={tableId}
      tabIndex={-1}
    >
      <style href="bruno-table-save-success" precedence="default">
        {SAVE_SUCCESS_KEYFRAMES}
      </style>
      {__BRUNO_TABLE_TEST_DIAGNOSTICS__ ? (
        <BrunoTableViewCommitDiagnosticProbe commitEvidence={compiledColumns} tableId={tableId} />
      ) : null}
      <BrunoTableSortPanel
        columns={compiledColumns}
        reserveEndSpace={gridOwnedControls !== undefined && gridOwnedControls !== null}
        runtime={runtime}
        tableId={tableId}
      />
      <GridOwnedToolRail controls={gridOwnedControls} />
      <div className="min-w-0">
        <ToolbarOutlet
          reserveEndSpace={gridOwnedControls !== undefined && gridOwnedControls !== null}
          toolbar={toolbar}
        />
        <SourceLifecycle runtime={runtime} focusFallback={focusFallback} />
        <BrunoTableGridBody
          runtime={runtime}
          tableId={tableId}
          gridAriaLabel={resolvedGridAriaLabel}
          compiledColumns={compiledColumns}
          focusFallback={focusFallback}
          rowPipeline={rowPipeline}
          rowPipelineAdapter={rowPipelineAdapter}
          renderColumnFilter={renderColumnFilter}
          enableActiveCellCopy={enableActiveCellCopy}
          rowSelection={rowSelection}
          cellRange={cellRange}
        />
        {editMemory === undefined || editCapability === undefined ? null : (
          <editCapability.EditSafetyFooter
            dispatchGridCommand={runtime.dispatchGridCommand}
            runtime={editMemory}
            renderReview={editCapability.renderResetReview}
            renderConflictReview={editCapability.renderConflictReview}
            renderBlockedReview={editCapability.renderBlockedReview}
            tableId={tableId}
          />
        )}
      </div>
    </section>
  );
}

const MemoizedBrunoTableView = memo(
  BrunoTableViewImplementation,
) as typeof BrunoTableViewImplementation;

export function BrunoTableView<TRuntime extends BrunoTableRuntimeView, TAdapter>(
  props: BrunoTableViewProps<TRuntime, TAdapter>,
): ReactElement {
  return (
    <BrunoTableEditCapabilityContext value={props.editCapability}>
      <BrunoTableCellEditContext value={props.editCapability?.cellEdit}>
        <BrunoTableEditMemoryContext value={props.editCapability?.editMemory}>
          <MemoizedBrunoTableView {...props} />
        </BrunoTableEditMemoryContext>
      </BrunoTableCellEditContext>
    </BrunoTableEditCapabilityContext>
  );
}

type BrunoTableGridBodyProps<TRuntime extends BrunoTableRuntimeView, TAdapter> = {
  readonly runtime: TRuntime;
  readonly tableId: string;
  readonly gridAriaLabel: string;
  readonly compiledColumns: readonly CompiledColumn[];
  readonly focusFallback: () => void;
  readonly rowPipeline: ComponentType<BrunoTableRowPipelineProps<TRuntime, TAdapter>>;
  readonly rowPipelineAdapter: TAdapter;
  readonly renderColumnFilter?: BrunoTableColumnFilterRenderer | undefined;
  readonly enableActiveCellCopy: boolean;
  readonly rowSelection?: BrunoTableRowSelectionRuntime | undefined;
  readonly cellRange?: BrunoTableCellRangeRuntime | undefined;
};

function BrunoTableGridBody<TRuntime extends BrunoTableRuntimeView, TAdapter>({
  runtime,
  tableId,
  gridAriaLabel,
  compiledColumns,
  focusFallback,
  rowPipeline: RowPipeline,
  rowPipelineAdapter,
  renderColumnFilter,
  enableActiveCellCopy,
  rowSelection,
  cellRange,
}: BrunoTableGridBodyProps<TRuntime, TAdapter>) {
  const cellEdit = useContext(BrunoTableCellEditContext);
  const editCapability = useContext(BrunoTableEditCapabilityContext);
  const [navigation] = useState(() => new BrunoTableNavigationRuntime());
  const [focusHandoff] = useState(() => new BrunoTableBodyFocusHandoff());
  const [interactionAnnouncer] = useState(() => new BrunoTableInteractionAnnouncer());
  const [pasteRuntime] = useState(() =>
    cellEdit === undefined || editCapability === undefined
      ? undefined
      : editCapability.createPasteRuntime(focusFallback),
  );
  const [dragFillRuntime] = useState(() =>
    cellEdit === undefined || cellRange === undefined || editCapability === undefined
      ? undefined
      : editCapability.createDragFillRuntime(tableId),
  );
  useEffect(() => () => pasteRuntime?.dispose(), [pasteRuntime]);
  useEffect(() => () => dragFillRuntime?.dispose(), [dragFillRuntime]);
  const body = useSyncExternalStore(
    runtime.subscribeBody,
    runtime.getBodySnapshot,
    runtime.getBodySnapshot,
  );
  const installedGroupingStructure = useSyncExternalStore(
    runtime.subscribeInstalledGroupingStructure,
    runtime.getInstalledGroupingStructureSnapshot,
    runtime.getInstalledGroupingStructureSnapshot,
  );
  const loadingRowSelection =
    installedGroupingStructure.groupBy.length === 0 ? rowSelection : undefined;
  const loadingColumns = installedGroupingStructure.columns ?? compiledColumns;
  const emptyCellRangeStructure = useMemo(
    () =>
      createBrunoTableCellRangeStructure(
        [],
        compiledColumns.map(({ columnId }) => columnId),
      ),
    [compiledColumns],
  );
  useLayoutEffect(() => {
    if (body.kind !== "rows" && body.kind !== "loading") {
      navigation.setShape([], compiledColumns);
      focusHandoff.clear();
    }
  }, [body.kind, compiledColumns, focusHandoff, navigation]);
  useLayoutEffect(() => {
    if (body.kind !== "rows") cellRange?.reconcile(emptyCellRangeStructure);
  }, [body.kind, cellRange, emptyCellRangeStructure]);
  if (body.kind === "loading") {
    return (
      <>
        <LoadingRows
          runtime={runtime}
          totalRows={body.totalRows}
          ariaRowCount={body.ariaRowCount ?? body.totalRows}
          compiledColumns={loadingColumns}
          structuralColumns={installedGroupingStructure.columns}
          focusFallback={focusFallback}
          focusHandoff={focusHandoff}
          tableId={tableId}
          rowSelection={loadingRowSelection}
        />
        {pasteRuntime === undefined || editCapability === undefined ? null : (
          <editCapability.PasteChrome runtime={pasteRuntime} />
        )}
        {dragFillRuntime === undefined || editCapability === undefined ? null : (
          <editCapability.DragFillChrome runtime={dragFillRuntime} />
        )}
      </>
    );
  }
  const rowPipeline = (
    <RowPipeline
      key="row-pipeline"
      runtime={runtime}
      tableId={tableId}
      columns={compiledColumns}
      rowPipelineAdapter={rowPipelineAdapter}
      rowSelection={rowSelection}
      cellRange={cellRange}
    >
      {(snapshot) =>
        body.kind === "empty" || body.kind === "invalid" ? (
          <></>
        ) : snapshot.kind === "invalid" ? (
          <>
            <BrunoTableCellRangeProjectionReset
              cellRange={cellRange}
              structure={emptyCellRangeStructure}
            />
            <Alert variant="destructive">
              <AlertTitle>Invalid source value</AlertTitle>
              <AlertDescription>{invalidSourceDetails(snapshot.invalid)}</AlertDescription>
            </Alert>
          </>
        ) : (
          <BrunoTableViewportAdapter
            tableId={tableId}
            gridAriaLabel={gridAriaLabel}
            rowSpace={snapshot.rowSpace}
            runtime={snapshot.runtime}
            columns={snapshot.columns}
            focusFallback={focusFallback}
            focusHandoff={focusHandoff}
            navigation={navigation}
            queryGeneration={snapshot.queryGeneration}
            queryNavigationMode={snapshot.queryNavigationMode}
            loading={snapshot.loading}
            ariaRowCount={body.ariaRowCount}
            renderColumnFilter={renderColumnFilter}
            enableActiveCellCopy={enableActiveCellCopy}
            rowSelection={rowSelection}
            cellRange={cellRange}
            interactionAnnouncer={interactionAnnouncer}
            pasteRuntime={pasteRuntime}
            dragFillRuntime={dragFillRuntime}
          />
        )
      }
    </RowPipeline>
  );
  return (
    <>
      {body.kind === "empty" ? (
        <EmptySourceBody key="empty-source" runtime={runtime} focusFallback={focusFallback} />
      ) : null}
      {rowPipeline}
      {pasteRuntime === undefined || editCapability === undefined ? null : (
        <editCapability.PasteChrome runtime={pasteRuntime} />
      )}
      {dragFillRuntime === undefined || editCapability === undefined ? null : (
        <editCapability.DragFillChrome runtime={dragFillRuntime} />
      )}
    </>
  );
}

function BrunoTableCellRangeProjectionReset({
  cellRange,
  structure,
}: {
  readonly cellRange: BrunoTableCellRangeRuntime | undefined;
  readonly structure: ReturnType<typeof createBrunoTableCellRangeStructure>;
}): null {
  useLayoutEffect(() => {
    cellRange?.reconcile(structure);
  }, [cellRange, structure]);
  return null;
}

type BrunoTableColumnFocusRequest = Readonly<{
  columnId: string;
  ownerDocument: Document;
  tableRoot: HTMLElement;
  sourceGrid: HTMLElement;
  requireGridReplacement: boolean;
  origin: HTMLElement | null;
  menuScope: HTMLElement | null;
}>;

class BrunoTableBodyFocusHandoff {
  private pending = false;
  private pendingColumnFocus: BrunoTableColumnFocusRequest | undefined;

  public readonly release = (): void => {
    this.pending = true;
  };

  public readonly claim = (): boolean => {
    if (!this.pending) return false;
    this.pending = false;
    return true;
  };

  public readonly releaseColumnFocus = (
    columnId: string,
    tableRoot: HTMLElement,
    sourceGrid: HTMLElement,
    origin: HTMLElement | null,
    requireGridReplacement = false,
  ): BrunoTableColumnFocusRequest => {
    const pending = this.pendingColumnFocus;
    if (pending?.columnId === columnId && pending.tableRoot === tableRoot) return pending;
    const request = Object.freeze({
      columnId,
      ownerDocument: tableRoot.ownerDocument,
      tableRoot,
      sourceGrid,
      requireGridReplacement,
      origin,
      menuScope: origin?.closest<HTMLElement>('[role="menu"]') ?? null,
    });
    this.pendingColumnFocus = request;
    return request;
  };

  public readonly claimColumnFocus = (): BrunoTableColumnFocusRequest | undefined => {
    return this.pendingColumnFocus;
  };

  public readonly clearColumnFocus = (request: BrunoTableColumnFocusRequest): void => {
    if (this.pendingColumnFocus === request) this.pendingColumnFocus = undefined;
  };

  public readonly clear = (): void => {
    this.pending = false;
    this.pendingColumnFocus = undefined;
  };
}

class BrunoTableInteractionAnnouncer {
  private element: HTMLSpanElement | null = null;
  private message = "";

  public readonly attach = (element: HTMLSpanElement | null): void => {
    this.element = element;
    if (element !== null) element.textContent = this.message;
  };

  public readonly announce = (message: string): void => {
    this.message = message;
    if (this.element === null) return;
    this.element.textContent = "";
    this.element.textContent = message;
  };

  public readonly getMessage = (): string => this.message;
}

type BrunoTableViewportAdapterProps = {
  readonly tableId: string;
  readonly gridAriaLabel: string;
  readonly rowSpace: BrunoTableLogicalRowSpace;
  readonly runtime: BrunoTableRuntimeView;
  readonly columns: readonly CompiledColumn[];
  readonly focusFallback: () => void;
  readonly focusHandoff: BrunoTableBodyFocusHandoff;
  readonly navigation: BrunoTableNavigationRuntime;
  readonly queryGeneration: number;
  readonly queryNavigationMode: BrunoTableQueryNavigationMode;
  readonly loading: boolean;
  readonly ariaRowCount?: number | undefined;
  readonly renderColumnFilter?: BrunoTableColumnFilterRenderer | undefined;
  readonly enableActiveCellCopy: boolean;
  readonly rowSelection?: BrunoTableRowSelectionRuntime | undefined;
  readonly cellRange?: BrunoTableCellRangeRuntime | undefined;
  readonly interactionAnnouncer: BrunoTableInteractionAnnouncer;
  readonly pasteRuntime?: BrunoTablePasteRuntime | undefined;
  readonly dragFillRuntime?: BrunoTableDragFillRuntime | undefined;
};

export const BrunoTableViewportAdapter: NamedExoticComponent<BrunoTableViewportAdapterProps> = memo(
  function BrunoTableViewportAdapter({
    tableId,
    gridAriaLabel,
    rowSpace,
    runtime,
    columns,
    focusFallback,
    focusHandoff,
    navigation,
    queryGeneration,
    queryNavigationMode,
    loading,
    ariaRowCount,
    renderColumnFilter,
    enableActiveCellCopy,
    rowSelection,
    cellRange,
    interactionAnnouncer,
    pasteRuntime,
    dragFillRuntime,
  }: BrunoTableViewportAdapterProps): ReactElement {
    const cellEdit = useContext(BrunoTableCellEditContext);
    const installedProjection = useSyncExternalStore(
      runtime.subscribeInstalledClientProjection,
      runtime.getInstalledClientProjectionSnapshot,
      runtime.getInstalledClientProjectionSnapshot,
    );
    const authoritativeRowSpace =
      installedProjection?.rowSpaceAuthority === "pipeline"
        ? rowSpace
        : (installedProjection?.rowSpace ?? rowSpace);
    const installedRowSpace = useMemo(
      () =>
        installedProjection?.kind === "grouped"
          ? Object.freeze({
              ...authoritativeRowSpace,
              missingRowIdentityBehavior: "fallback-to-display-index" as const,
            })
          : authoritativeRowSpace,
      [authoritativeRowSpace, installedProjection?.kind],
    );
    const installedColumns = installedProjection?.columns ?? columns;
    const installedQueryGeneration = installedProjection?.queryGeneration ?? queryGeneration;
    const installedQueryNavigationMode =
      installedProjection?.queryNavigationMode ?? queryNavigationMode;
    const projectionLayoutKey =
      installedProjection?.layoutKey ?? BRUNO_TABLE_RAW_CLIENT_PROJECTION_LAYOUT_KEY;
    const projectedRowSelection =
      installedProjection?.kind === "grouped" ? undefined : rowSelection;
    const viewportLayoutKey = `${projectionLayoutKey}:${
      cellEdit === undefined
        ? projectedRowSelection === undefined
          ? "without-row-selection"
          : "with-row-selection"
        : "editable-stable-owner"
    }`;
    const reconcileRangeAnchorAfterCommittedNavigation = useCallback(
      (activeCell: BrunoTableActiveCell | undefined, logicalColumns: readonly CompiledColumn[]) => {
        if (cellRange === undefined) return;
        const structure = createBrunoTableCellRangeStructureFromRowSpace(
          installedRowSpace,
          logicalColumns.map((column) => column.columnId),
        );
        cellRange.reconcileAfterCommittedNavigation(
          structure,
          activeCell?.region === "body" && activeCell.rowId !== undefined
            ? { rowId: activeCell.rowId, columnId: activeCell.columnId }
            : undefined,
        );
      },
      [cellRange, installedRowSpace],
    );
    return (
      <BrunoTableViewportAdapterBoundary
        key={viewportLayoutKey}
        columns={installedColumns}
        leadingUtilityWidth={projectedRowSelection === undefined ? 0 : ROW_SELECTION_COLUMN_WIDTH}
        navigation={navigation}
        projectionKind={installedProjection?.kind ?? "raw"}
        queryGeneration={installedQueryGeneration}
        queryNavigationMode={installedQueryNavigationMode}
        onCommittedNavigationChange={reconcileRangeAnchorAfterCommittedNavigation}
        rowSpace={installedRowSpace}
        runtime={runtime}
      >
        {(adapter) => (
          <BrunoTableGridSurface
            announce={interactionAnnouncer.announce}
            announcementMessage={interactionAnnouncer.getMessage()}
            attachAnnouncement={interactionAnnouncer.attach}
            instanceId={adapter.instanceId}
            tableId={tableId}
            gridAriaLabel={gridAriaLabel}
            rowSpace={installedRowSpace}
            runtime={runtime}
            columns={adapter.columns}
            allColumns={adapter.columnLayout.allColumns}
            visibleColumnIds={adapter.columnLayout.visibleColumnIds}
            columnLayout={adapter.columnLayout}
            queryGeneration={installedQueryGeneration}
            loading={loading}
            ariaRowCount={ariaRowCount}
            viewportSnapshot={adapter.viewportSnapshot}
            attach={adapter.attach}
            attachBodyLayer={adapter.attachBodyLayer}
            attachPinnedEditorHost={adapter.attachPinnedEditorHost}
            attachRowLayer={adapter.attachRowLayer}
            attachHeader={adapter.attachHeader}
            attachScrollbarOverlay={adapter.attachScrollbarOverlay}
            subscribeViewportEnvironment={adapter.subscribeViewportEnvironment}
            subscribeColumnWindow={adapter.subscribeColumnWindow}
            getColumnWindowSnapshot={adapter.getColumnWindowSnapshot}
            subscribeHeaderColumnWindow={adapter.subscribeHeaderColumnWindow}
            getHeaderColumnWindowSnapshot={adapter.getHeaderColumnWindowSnapshot}
            getHeaderColumnActivitySnapshot={adapter.getHeaderColumnActivitySnapshot}
            attachHeaderColumn={adapter.attachHeaderColumn}
            subscribeRowRange={adapter.subscribeRowRange}
            subscribeFrameCommit={adapter.subscribeFrameCommit}
            getRowRangeSnapshot={adapter.getRowRangeSnapshot}
            subscribeBodyRowColumnWindow={adapter.subscribeBodyRowColumnWindow}
            getBodyRowColumnWindowSnapshot={adapter.getBodyRowColumnWindowSnapshot}
            scrollByLogical={adapter.scrollByLogical}
            scrollVerticalByLogical={adapter.scrollVerticalByLogical}
            adjustVerticalByLogical={adapter.adjustVerticalByLogical}
            resolveBodyHit={adapter.resolveBodyHit}
            previewColumnWidth={adapter.previewColumnWidth}
            clearColumnWidthPreview={adapter.clearColumnWidthPreview}
            focusFallback={focusFallback}
            focusHandoff={focusHandoff}
            navigation={navigation}
            revealCell={adapter.revealCell}
            renderColumnFilter={renderColumnFilter}
            enableActiveCellCopy={enableActiveCellCopy}
            rowSelection={projectedRowSelection}
            cellRange={cellRange}
            pasteRuntime={pasteRuntime}
            dragFillRuntime={dragFillRuntime}
          />
        )}
      </BrunoTableViewportAdapterBoundary>
    );
  },
);

const BrunoTableGridSurface = memo(function BrunoTableGridSurface({
  announce: setAnnouncement,
  announcementMessage,
  attachAnnouncement,
  instanceId,
  tableId,
  gridAriaLabel,
  rowSpace,
  runtime,
  columns,
  allColumns,
  visibleColumnIds,
  columnLayout,
  queryGeneration,
  loading,
  ariaRowCount,
  viewportSnapshot,
  attach,
  attachBodyLayer,
  attachPinnedEditorHost,
  attachRowLayer,
  attachHeader,
  attachScrollbarOverlay,
  subscribeViewportEnvironment,
  subscribeColumnWindow,
  getColumnWindowSnapshot,
  subscribeHeaderColumnWindow,
  getHeaderColumnWindowSnapshot,
  getHeaderColumnActivitySnapshot,
  attachHeaderColumn,
  subscribeRowRange,
  subscribeFrameCommit,
  getRowRangeSnapshot,
  subscribeBodyRowColumnWindow,
  getBodyRowColumnWindowSnapshot,
  scrollByLogical,
  scrollVerticalByLogical,
  adjustVerticalByLogical,
  resolveBodyHit,
  previewColumnWidth,
  clearColumnWidthPreview,
  focusFallback,
  focusHandoff,
  navigation,
  revealCell,
  renderColumnFilter,
  enableActiveCellCopy,
  rowSelection,
  cellRange,
  pasteRuntime,
  dragFillRuntime,
}: {
  readonly announce: (message: string) => void;
  readonly announcementMessage: string;
  readonly attachAnnouncement: (element: HTMLSpanElement | null) => void;
  readonly instanceId: string;
  readonly tableId: string;
  readonly gridAriaLabel: string;
  readonly rowSpace: BrunoTableLogicalRowSpace;
  readonly runtime: BrunoTableRuntimeView;
  readonly columns: readonly CompiledColumn[];
  /** BrunoTable layout runtime's complete logical projection, including hidden columns. */
  readonly allColumns: readonly CompiledColumn[];
  readonly visibleColumnIds: readonly string[];
  readonly columnLayout: BrunoTableColumnLayoutSnapshot;
  readonly queryGeneration: number;
  readonly loading: boolean;
  readonly ariaRowCount?: number | undefined;
  readonly viewportSnapshot: BrunoTableViewportSnapshot;
  readonly attach: (element: HTMLElement | null) => void;
  readonly attachBodyLayer: RefCallback<HTMLElement>;
  readonly attachPinnedEditorHost: RefCallback<HTMLElement>;
  readonly attachRowLayer: (element: HTMLElement | null) => void;
  readonly attachHeader: (element: HTMLElement | null) => void;
  readonly attachScrollbarOverlay: (element: HTMLElement | null) => void;
  readonly subscribeViewportEnvironment: (listener: () => void) => () => void;
  readonly subscribeColumnWindow: (listener: () => void) => () => void;
  readonly getColumnWindowSnapshot: () => BrunoTableBodyColumnWindowSnapshot;
  readonly subscribeHeaderColumnWindow: (listener: () => void) => () => void;
  readonly getHeaderColumnWindowSnapshot: () => BrunoTableBodyColumnWindowSnapshot;
  readonly getHeaderColumnActivitySnapshot: (columnId: string) => boolean;
  readonly attachHeaderColumn: (columnId: string, element: HTMLElement | null) => void;
  readonly subscribeRowRange: (listener: () => void) => () => void;
  readonly subscribeFrameCommit: (listener: () => void) => () => void;
  readonly getRowRangeSnapshot: () => BrunoTableRowRangeSnapshot;
  readonly subscribeBodyRowColumnWindow: (
    logicalRowIndex: number,
    listener: () => void,
  ) => () => void;
  readonly getBodyRowColumnWindowSnapshot: (
    logicalRowIndex: number,
  ) => BrunoTableBodyColumnWindowSnapshot;
  readonly scrollByLogical: (delta: number) => boolean;
  readonly scrollVerticalByLogical: (delta: number) => boolean;
  readonly adjustVerticalByLogical: (delta: number) => number | undefined;
  readonly resolveBodyHit: (
    request: BrunoTableViewportBodyHitRequest,
  ) => Readonly<{ readonly rowIndex: number; readonly columnId: string }> | undefined;
  readonly previewColumnWidth: (columnId: string, width: number) => void;
  readonly clearColumnWidthPreview: (publishSnapshot?: boolean) => void;
  readonly focusFallback: () => void;
  readonly focusHandoff: BrunoTableBodyFocusHandoff;
  readonly navigation: BrunoTableNavigationRuntime;
  readonly revealCell: (
    rowIndex: number,
    columnId: string,
    region?: "header" | "body",
    rowId?: string,
  ) => void;
  readonly renderColumnFilter?: BrunoTableColumnFilterRenderer | undefined;
  readonly enableActiveCellCopy: boolean;
  readonly rowSelection?: BrunoTableRowSelectionRuntime | undefined;
  readonly cellRange?: BrunoTableCellRangeRuntime | undefined;
  readonly pasteRuntime?: BrunoTablePasteRuntime | undefined;
  readonly dragFillRuntime?: BrunoTableDragFillRuntime | undefined;
}) {
  const cellEdit = useContext(BrunoTableCellEditContext);
  const editMemory = useContext(BrunoTableEditMemoryContext);
  const editCapability = useContext(BrunoTableEditCapabilityContext);
  const pasteCapability = editCapability?.paste;
  const addDragFillRejectionEvidence = editCapability?.addDragFillRejectionEvidence;
  const columnGesture = useRef<BrunoTableColumnGesture | undefined>(undefined);
  const isPointerInteractionActive = useCallback(
    (except?: "cell-range" | "drag-fill"): boolean =>
      (except !== "cell-range" && cellRange?.isPointerGestureActive() === true) ||
      (except !== "drag-fill" && dragFillRuntime?.getSnapshot().active === true) ||
      columnGesture.current !== undefined,
    [cellRange, dragFillRuntime],
  );
  const getActiveEditRowId = useCallback((): string | undefined => {
    const session = cellEdit?.getSessionSnapshot();
    return session?.kind === "editing" ? session.rowId : undefined;
  }, [cellEdit]);
  const activeEditRowId = useSyncExternalStore(
    cellEdit?.subscribeSession ?? subscribeNoCellEditSession,
    getActiveEditRowId,
    getActiveEditRowId,
  );
  const traversalQueueRef = useRef<{
    readonly addItem: (item: number) => boolean;
    readonly clear: () => void;
  } | null>(null);
  const traversalBuildVersionRef = useRef(0);
  const enqueueTraversalBuild = useCallback(
    (version: number) => {
      if (version !== traversalBuildVersionRef.current) return;
      if (cellEdit?.buildTraversalSlice()) traversalQueueRef.current?.addItem(version);
    },
    [cellEdit],
  );
  const installTraversalQueue = useCallback((queue: typeof EMPTY_TRAVERSAL_QUEUE) => {
    traversalQueueRef.current = queue;
  }, []);
  const yieldGridTabStop = useBrunoTableGridTabStopHandoff();
  const virtualWindow = viewportSnapshot.virtualWindow;
  const columnWindow = useMemo<BrunoTableColumnWindow>(
    () =>
      Object.freeze({
        pinnedStart: virtualWindow.pinnedStart,
        center: virtualWindow.center,
        pinnedEnd: virtualWindow.pinnedEnd,
        pinningSuspended: virtualWindow.pinningSuspended,
        centerStartIndex: virtualWindow.centerStartIndex,
        centerCount: virtualWindow.centerCount,
        leftPadding: virtualWindow.leftPadding,
        rightPadding: virtualWindow.rightPadding,
        totalWidth: virtualWindow.totalWidth,
      }),
    [
      virtualWindow.pinnedStart,
      virtualWindow.center,
      virtualWindow.pinnedEnd,
      virtualWindow.pinningSuspended,
      virtualWindow.centerStartIndex,
      virtualWindow.centerCount,
      virtualWindow.leftPadding,
      virtualWindow.rightPadding,
      virtualWindow.totalWidth,
    ],
  );
  const tableWidth = columnWindow.totalWidth;
  const rowSelectionWidth = rowSelection === undefined ? 0 : ROW_SELECTION_COLUMN_WIDTH;
  const viewportFill =
    columnWindow.pinnedEnd.length === 0 ? 0 : Math.max(0, viewportSnapshot.width - tableWidth);
  const renderedTableWidth = tableWidth + viewportFill;
  const logicalColumns = columns;
  const commandColumns = useRef(logicalColumns);
  useLayoutEffect(() => {
    commandColumns.current = logicalColumns;
  }, [logicalColumns]);
  const copyEnabled = enableActiveCellCopy || cellRange !== undefined;
  const cellRangeStructure = useMemo(
    () =>
      cellRange === undefined
        ? undefined
        : createBrunoTableCellRangeStructureFromRowSpace(
            rowSpace,
            logicalColumns.map((column) => column.columnId),
          ),
    [cellRange, logicalColumns, rowSpace],
  );
  const columnIndexOffset = rowSelection === undefined ? 0 : 1;
  const gridElement = useRef<HTMLDivElement | null>(null);
  const dragFillLayout = useRef<
    | Readonly<{
        readonly direction: "ltr" | "rtl";
        readonly interactionGeometry: BrunoTableDragFillInteractionGeometry;
      }>
    | undefined
  >(undefined);
  const dragFillLayoutInput = useRef(
    Object.freeze({
      pinnedStart: columnWindow.pinnedStart,
      pinnedEnd: columnWindow.pinnedEnd,
      rowSelectionWidth,
    }),
  );
  const producedTextCapture = useRef<HTMLSpanElement | null>(null);
  const interactionFrame = useRef<number | null>(null);
  const focusRestoreFrame = useRef<number | null>(null);
  const focusRestoreRetry = useRef<() => void>(() => undefined);
  const filterOpenFrame = useRef<number | null>(null);
  const filterOpenToken = useRef(0);
  const copyCommandToken = useRef(0);
  const filterOpenRetry = useRef<() => void>(() => undefined);
  const columnFilterOpeners = useRef(new Map<string, () => void>());
  const gestureCancel = useRef<() => void>(() => undefined);
  const columnPointerDownHandler = useRef<BrunoTableColumnPointerDownHandler>(() => undefined);
  const [columnGestureActor] = useState<BrunoTableColumnGestureActor>(() =>
    createBrunoTableColumnGestureActor(),
  );
  const reorderGeometryVersion = useRef(0);
  const advanceReorderGeometryVersion = useCallback(() => {
    reorderGeometryVersion.current += 1;
  }, []);
  const previewProperties = useRef<Set<string>>(new Set());
  const reorderTarget = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    reorderGeometryVersion.current += 1;
  }, [
    columnWindow.center,
    columnWindow.centerStartIndex,
    columnWindow.leftPadding,
    columnWindow.rightPadding,
    columnWindow.pinnedEnd,
    columnWindow.pinnedStart,
    columnWindow.totalWidth,
  ]);
  useLayoutEffect(() => {
    if (cellRangeStructure !== undefined) cellRange?.reconcile(cellRangeStructure);
  }, [cellRange, cellRangeStructure]);

  const restoreColumnFocus = useMemo(
    () =>
      (columnId: string): void => {
        const grid = gridElement.current;
        const tableRoot = grid?.closest<HTMLElement>("[data-bruno-table]");
        if (grid === null || tableRoot === undefined || tableRoot === null) return;
        const activeElement = grid.ownerDocument.activeElement;
        const request = focusHandoff.releaseColumnFocus(
          columnId,
          tableRoot,
          grid,
          asBrunoTableRealmHTMLElement(grid, activeElement),
        );
        if (focusRestoreFrame.current !== null) {
          cancelAnimationFrame(focusRestoreFrame.current);
        }
        let attemptsRemaining = 4;
        focusRestoreRetry.current = (): void => {
          focusRestoreFrame.current = null;
          if (focusHandoff.claimColumnFocus() !== request) return;
          const currentGrid = gridElement.current;
          if (
            currentGrid === null ||
            currentGrid.ownerDocument !== request.ownerDocument ||
            currentGrid.closest("[data-bruno-table]") !== request.tableRoot
          ) {
            focusHandoff.clearColumnFocus(request);
            return;
          }
          if (!isBrunoTableDocumentFocusChainActive(request.ownerDocument)) {
            focusHandoff.clearColumnFocus(request);
            return;
          }
          const header = [
            ...currentGrid.querySelectorAll<HTMLElement>("th[data-bruno-column-id]"),
          ].find((candidate) => candidate.dataset["brunoColumnId"] === columnId);
          const trigger = [...(header?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
            (candidate) => candidate.dataset["brunoColumnMenuTrigger"] === columnId,
          );
          const proxy = [
            ...currentGrid.querySelectorAll<HTMLButtonElement>(
              '[data-bruno-active-header-menu-trigger=""]',
            ),
          ].find((candidate) => candidate.dataset["brunoColumnMenuTrigger"] === columnId);
          const currentActiveElement = request.ownerDocument.activeElement;
          const currentActiveHTMLElement = asBrunoTableRealmHTMLElement(
            currentGrid,
            currentActiveElement,
          );
          if (
            currentActiveHTMLElement !== null &&
            currentActiveHTMLElement.isConnected &&
            currentActiveHTMLElement !== request.ownerDocument.body &&
            currentActiveHTMLElement !== request.tableRoot &&
            currentActiveHTMLElement !== currentGrid &&
            currentActiveHTMLElement !== request.origin &&
            request.menuScope?.contains(currentActiveHTMLElement) !== true &&
            currentActiveHTMLElement !== trigger &&
            currentActiveHTMLElement !== proxy
          ) {
            focusHandoff.clearColumnFocus(request);
            return;
          }
          const columnExists = commandColumns.current.some(
            (column) => column.columnId === request.columnId,
          );
          if (!columnExists) {
            focusHandoff.clearColumnFocus(request);
            currentGrid.focus({ preventScroll: true });
            return;
          }
          if (
            request.requireGridReplacement &&
            currentGrid === request.sourceGrid &&
            trigger === undefined
          ) {
            attemptsRemaining -= 1;
            if (attemptsRemaining > 0) {
              focusRestoreFrame.current = requestAnimationFrame(focusRestoreRetry.current);
              return;
            }
            focusHandoff.clearColumnFocus(request);
            currentGrid.focus({ preventScroll: true });
            return;
          }
          const activeCell = navigation.getSnapshot();
          const eligibleProxy =
            activeCell?.region === "header" && activeCell.columnId === columnId ? proxy : undefined;
          const target = trigger ?? eligibleProxy;
          if (target !== undefined) {
            target.focus({ preventScroll: true });
            focusHandoff.clearColumnFocus(request);
            return;
          }
          attemptsRemaining -= 1;
          if (attemptsRemaining > 0) {
            focusRestoreFrame.current = requestAnimationFrame(focusRestoreRetry.current);
            return;
          }
          focusHandoff.clearColumnFocus(request);
          currentGrid.focus({ preventScroll: true });
        };
        focusRestoreFrame.current = requestAnimationFrame(focusRestoreRetry.current);
      },
    [focusHandoff, navigation],
  );
  useLayoutEffect(() => {
    const request = focusHandoff.claimColumnFocus();
    if (request !== undefined) restoreColumnFocus(request.columnId);
  }, [focusHandoff, restoreColumnFocus]);

  const clearReorderTarget = (): void => {
    const target = reorderTarget.current;
    if (target !== null) {
      target.removeAttribute("data-bruno-reorder-target");
      target.style.removeProperty("outline");
      target.style.removeProperty("outline-offset");
    }
    reorderTarget.current = null;
  };

  const clearPreviewStyles = (): void => {
    const grid = gridElement.current;
    if (grid !== null) {
      for (const property of previewProperties.current) grid.style.removeProperty(property);
    }
    previewProperties.current.clear();
    clearReorderTarget();
  };

  const clearReorderPreviewStyles = (geometry: readonly BrunoTableReorderGeometry[]): void => {
    const grid = gridElement.current;
    if (grid === null) return;
    for (const cell of geometry) {
      const column = logicalColumns[cell.columnIndex];
      if (column === undefined) continue;
      const property = brunoTableColumnCssVariable("transform", column.columnId);
      if (previewProperties.current.delete(property)) grid.style.removeProperty(property);
    }
  };

  const writePreviewProperty = (property: string, value: string): void => {
    const grid = gridElement.current;
    if (grid === null) return;
    grid.style.setProperty(property, value);
    if (__BRUNO_TABLE_TEST_DIAGNOSTICS__) {
      recordBrunoTableClientColumnPreviewStyleWrite(property);
    }
    previewProperties.current.add(property);
  };

  const applyResizePreview = (gesture: BrunoTableColumnGesture): void => {
    const delta = gesture.currentX - gesture.startX;
    const logicalDelta = gesture.direction === "rtl" ? -delta : delta;
    const width = clampBrunoTableColumnWidth(gesture.initialWidth + logicalDelta, {
      min: gesture.minWidth,
      max: gesture.maxWidth,
    });
    previewColumnWidth(gesture.columnId, width);
    gesture.target.setAttribute("aria-valuenow", String(width));
    if (__BRUNO_TABLE_TEST_DIAGNOSTICS__) recordBrunoTableClientColumnResizeFrame();
  };

  const readReorderGeometry = (direction: "ltr" | "rtl"): readonly BrunoTableReorderGeometry[] =>
    Object.freeze(
      [...(gridElement.current?.querySelectorAll<HTMLElement>("th[data-bruno-column-id]") ?? [])]
        .map((element) => {
          const columnIndex = logicalColumns.findIndex(
            (candidate) => candidate.columnId === element.dataset["brunoColumnId"],
          );
          const candidate = logicalColumns[columnIndex];
          if (candidate === undefined) return undefined;
          const rect = element.getBoundingClientRect();
          return Object.freeze({ columnIndex, element, left: rect.left, width: rect.width });
        })
        .filter((value): value is BrunoTableReorderGeometry => value !== undefined)
        .sort((left, right) =>
          direction === "rtl" ? right.left - left.left : left.left - right.left,
        ),
    );

  const isReorderCenterWindowCommitted = (): boolean => {
    const targetIds = getColumnWindowSnapshot().center.map((column) => column.columnId);
    const targetIdSet = new Set<string>(targetIds);
    const mountedTargetIds = [
      ...(gridElement.current?.querySelectorAll<HTMLElement>("th[data-bruno-column-id]") ?? []),
    ].flatMap((element) => {
      const columnId = element.dataset["brunoColumnId"];
      return columnId !== undefined && targetIdSet.has(columnId) ? [columnId] : [];
    });
    return (
      mountedTargetIds.length === targetIds.length &&
      mountedTargetIds.every((columnId, index) => columnId === targetIds[index])
    );
  };

  const resolveReorderTargetPin = (
    gesture: BrunoTableColumnGesture,
    headerCells: readonly BrunoTableReorderGeometry[],
  ): "start" | "end" | undefined => {
    const { left, right } = gesture.reorderCenterBounds;
    if (gesture.currentX < left) return gesture.direction === "rtl" ? "end" : "start";
    if (gesture.currentX > right) return gesture.direction === "rtl" ? "start" : "end";

    const remainingCells = headerCells.filter((cell) => cell.columnIndex !== gesture.sourceIndex);
    if (!remainingCells.some((cell) => logicalColumns[cell.columnIndex]?.pinned === undefined)) {
      // A narrow centreless layout temporarily renders formerly pinned columns
      // in the centre window. Only that suspended projection preserves the
      // source pin; a fitting all-pinned layout keeps the centre gap as the
      // pointer's explicit unpin drop zone.
      return gesture.pinningSuspended ? gesture.sourcePinned : undefined;
    }
    let referenceCell = remainingCells.at(-1);
    for (const cell of remainingCells) {
      if (
        gesture.direction === "rtl"
          ? gesture.currentX > cell.left + cell.width / 2
          : gesture.currentX < cell.left + cell.width / 2
      ) {
        referenceCell = cell;
        break;
      }
    }
    return logicalColumns[referenceCell?.columnIndex ?? gesture.targetIndex]?.pinned;
  };

  const autoScrollReorder = (gesture: BrunoTableColumnGesture): boolean => {
    const { left: centerLeft, right: centerRight } = gesture.reorderCenterBounds;
    const edge = 48;
    const physicalDelta =
      gesture.currentX >= centerLeft && gesture.currentX < centerLeft + edge
        ? -64
        : gesture.currentX <= centerRight && gesture.currentX > centerRight - edge
          ? 64
          : 0;
    if (physicalDelta === 0) return false;
    const logicalDelta = gesture.direction === "rtl" ? -physicalDelta : physicalDelta;
    return scrollByLogical(logicalDelta);
  };

  const applyReorderPreview = (
    gesture: BrunoTableColumnGesture,
    allowAutoScroll = true,
  ): boolean => {
    gesture.reorderPreviewApplied = false;
    const didScroll = allowAutoScroll && autoScrollReorder(gesture);
    let headerCells = gesture.reorderGeometry;
    if (didScroll) {
      // Wait for the viewport's own rAF publication and React layout effect before reading the
      // next geometry. This prevents a mounted-window edge from becoming a logical boundary.
      gesture.reorderGeometryVersion = -1;
      gesture.reorderGeometryVersionBeforeScroll = reorderGeometryVersion.current;
      scheduleGestureFrame();
      return false;
    }
    if (gesture.reorderGeometryVersion === -1) {
      if (
        allowAutoScroll &&
        reorderGeometryVersion.current === gesture.reorderGeometryVersionBeforeScroll &&
        !isReorderCenterWindowCommitted()
      ) {
        scheduleGestureFrame();
        return false;
      }
      gesture.reorderGeometryVersion = reorderGeometryVersion.current;
      clearReorderPreviewStyles(headerCells);
      headerCells = readReorderGeometry(gesture.direction);
      gesture.reorderGeometry = headerCells;
    } else if (gesture.reorderGeometryVersion !== reorderGeometryVersion.current) {
      clearReorderPreviewStyles(headerCells);
      headerCells = readReorderGeometry(gesture.direction);
      gesture.reorderGeometry = headerCells;
      gesture.reorderGeometryVersion = reorderGeometryVersion.current;
    }
    const pointerX = gesture.currentX;
    const sourceCell = headerCells.find((cell) => cell.columnIndex === gesture.sourceIndex);
    gesture.targetIndex = resolveBrunoTableReorderTargetIndex(
      headerCells,
      pointerX,
      gesture.direction,
      gesture.sourceIndex,
      gesture.groupStart,
      gesture.groupEnd,
    );
    gesture.targetPinned = resolveReorderTargetPin(gesture, headerCells);
    const displacement = gesture.currentX - gesture.startX;
    const sourceWidth = sourceCell?.width ?? gesture.initialWidth;
    for (const cell of headerCells) {
      const column = logicalColumns[cell.columnIndex];
      if (column === undefined) continue;
      const property = brunoTableColumnCssVariable("transform", column.columnId);
      let transform = "none";
      if (cell.columnIndex === gesture.sourceIndex) {
        transform = `translate3d(${String(displacement)}px, 0, 0)`;
      } else {
        const projectedIndex = projectBrunoTableLogicalColumnIndex(
          cell.columnIndex,
          gesture.sourceIndex,
          gesture.targetIndex,
        );
        const logicalShift = projectedIndex - cell.columnIndex;
        if (logicalShift !== 0) {
          const visualShift = gesture.direction === "rtl" ? -logicalShift : logicalShift;
          transform = `translate3d(${String(visualShift * sourceWidth)}px, 0, 0)`;
        }
      }
      writePreviewProperty(property, transform);
    }
    const targetColumn = logicalColumns[gesture.targetIndex];
    const targetCell =
      targetColumn === undefined
        ? null
        : (headerCells.find((cell) => cell.columnIndex === gesture.targetIndex)?.element ?? null);
    clearReorderTarget();
    if (targetCell !== null && targetCell !== gesture.target) {
      targetCell.setAttribute("data-bruno-reorder-target", "");
      targetCell.style.setProperty("outline", "2px dashed CanvasText");
      targetCell.style.setProperty("outline-offset", "-2px");
      reorderTarget.current = targetCell;
    } else {
      reorderTarget.current = null;
    }
    if (__BRUNO_TABLE_TEST_DIAGNOSTICS__) recordBrunoTableClientColumnReorderFrame();
    gesture.reorderPreviewApplied = true;
    return true;
  };

  const scheduleGestureFrame = (): void => {
    const gesture = columnGesture.current;
    if (gesture === undefined || gesture.frame !== null) return;
    const measureFrame =
      __BRUNO_TABLE_TEST_DIAGNOSTICS__ && hasBrunoTableClientColumnGestureFrameListener(tableId);
    const frameId = requestAnimationFrame(() => {
      const startedAt = measureFrame ? performance.now() : undefined;
      gesture.frame = null;
      if (columnGesture.current === gesture) {
        if (gesture.kind === "resize") {
          applyResizePreview(gesture);
          gesture.previewedX = gesture.currentX;
        } else if (applyReorderPreview(gesture)) {
          gesture.previewedX = gesture.currentX;
        }
      }
      if (startedAt !== undefined) {
        recordBrunoTableClientColumnGestureFrame(tableId, {
          phase: "ran",
          kind: gesture.kind,
          frameId,
          durationMs: performance.now() - startedAt,
        });
      }
    });
    gesture.frame = frameId;
    if (measureFrame) {
      recordBrunoTableClientColumnGestureFrame(tableId, {
        phase: "scheduled",
        kind: gesture.kind,
        frameId,
      });
    }
  };

  const finishColumnGesture = (commit: boolean): void => {
    const gesture = columnGesture.current;
    if (gesture === undefined) return;
    if (columnGestureActor.getSnapshot().value !== "active") return;
    columnGestureActor.send({ type: commit ? "COMMIT" : "CANCEL" });
    if (columnGestureActor.getSnapshot().value !== "idle") return;
    const needsSynchronousFinalPreview =
      commit &&
      (gesture.previewedX !== gesture.currentX ||
        (gesture.kind === "reorder" && !gesture.reorderPreviewApplied));
    if (needsSynchronousFinalPreview) {
      const measureSynchronousWork =
        __BRUNO_TABLE_TEST_DIAGNOSTICS__ && hasBrunoTableClientColumnGestureFrameListener(tableId);
      const startedAt = measureSynchronousWork ? performance.now() : undefined;
      if (gesture.kind === "resize") applyResizePreview(gesture);
      else if (applyReorderPreview(gesture, false)) gesture.previewedX = gesture.currentX;
      if (startedAt !== undefined) {
        recordBrunoTableClientColumnGestureFrame(tableId, {
          phase: "synchronous",
          kind: gesture.kind,
          durationMs: performance.now() - startedAt,
        });
      }
    }
    if (gesture.frame !== null) {
      const frameId = gesture.frame;
      cancelAnimationFrame(frameId);
      if (__BRUNO_TABLE_TEST_DIAGNOSTICS__) {
        recordBrunoTableClientColumnGestureFrame(tableId, {
          phase: "cancelled",
          kind: gesture.kind,
          frameId,
        });
      }
    }
    gesture.frame = null;
    window.removeEventListener("pointermove", gesture.onPointerMove, true);
    if (__BRUNO_TABLE_TEST_DIAGNOSTICS__) {
      recordBrunoTableClientColumnGestureListener(tableId, {
        phase: "detach",
        event: "pointermove",
      });
    }
    window.removeEventListener("pointerup", gesture.onPointerUp, true);
    if (__BRUNO_TABLE_TEST_DIAGNOSTICS__) {
      recordBrunoTableClientColumnGestureListener(tableId, {
        phase: "detach",
        event: "pointerup",
      });
    }
    window.removeEventListener("pointercancel", gesture.onPointerCancel, true);
    if (__BRUNO_TABLE_TEST_DIAGNOSTICS__) {
      recordBrunoTableClientColumnGestureListener(tableId, {
        phase: "detach",
        event: "pointercancel",
      });
    }
    try {
      if (typeof gesture.target.hasPointerCapture === "function") {
        if (gesture.target.hasPointerCapture(gesture.pointerId)) {
          if (typeof gesture.target.releasePointerCapture === "function") gesture.target.releasePointerCapture(gesture.pointerId);
        }
      }
    } catch {
      // Synthetic browser tests may not have a native pointer capture to release.
    }
    columnGesture.current = undefined;
    if (gesture.kind === "resize") {
      const delta = gesture.currentX - gesture.startX;
      const logicalDelta = gesture.direction === "rtl" ? -delta : delta;
      const width = clampBrunoTableColumnWidth(gesture.initialWidth + logicalDelta, {
        min: gesture.minWidth,
        max: gesture.maxWidth,
      });
      const widthChanged = width !== gesture.initialWidth;
      clearColumnWidthPreview(commit && widthChanged ? false : true);
      if (commit && widthChanged) {
        runtime.dispatchGridCommand({
          type: "column.resize.commit",
          columnId: gesture.columnId,
          width,
        });
      }
      const settledWidth = runtime.getColumnCommandSnapshot(gesture.columnId).width;
      gesture.target.setAttribute("aria-valuenow", String(settledWidth));
      if (commit) {
        setAnnouncement(
          `${columnHeaderName(columns, gesture.columnId)} width ${String(settledWidth)} pixels`,
        );
      }
    } else if (
      commit &&
      (gesture.targetIndex !== gesture.sourceIndex || gesture.targetPinned !== gesture.sourcePinned)
    ) {
      const grid = gridElement.current;
      const tableRoot = grid?.closest<HTMLElement>("[data-bruno-table]");
      if (grid !== null && tableRoot !== undefined && tableRoot !== null) {
        focusHandoff.releaseColumnFocus(gesture.columnId, tableRoot, grid, gesture.target, true);
      }
      runtime.dispatchGridCommand({
        type: "column.reorder.commit",
        columnId: gesture.columnId,
        targetIndex: gesture.targetIndex,
        pinned: gesture.targetPinned,
      });
      const settledIndex = runtime
        .getColumnLayoutSnapshot()
        .visibleColumnIds.indexOf(gesture.columnId);
      setAnnouncement(
        `${columnHeaderName(columns, gesture.columnId)} position ${String(settledIndex + 1)} of ${String(logicalColumns.length)}`,
      );
    }
    if (gesture.kind === "reorder") restoreColumnFocus(gesture.columnId);
    clearPreviewStyles();
    if (!commit) setAnnouncement("Column layout change cancelled");
  };
  const onColumnPointerMove = (event: globalThis.PointerEvent): void => {
    const gesture = columnGesture.current;
    if (gesture === undefined || event.pointerId !== gesture.pointerId) return;
    event.preventDefault();
    gesture.currentX = event.clientX;
    scheduleGestureFrame();
  };
  const onColumnPointerUp = (event: globalThis.PointerEvent): void => {
    const gesture = columnGesture.current;
    if (gesture === undefined || event.pointerId !== gesture.pointerId) return;
    gesture.currentX = event.clientX;
    finishColumnGesture(true);
  };
  const onColumnPointerCancel = (event: globalThis.PointerEvent): void => {
    const gesture = columnGesture.current;
    if (gesture === undefined || event.pointerId !== gesture.pointerId) return;
    finishColumnGesture(false);
  };
  const startColumnGesture = (
    event: ReactPointerEvent<HTMLElement>,
    column: CompiledColumn,
    kind: "resize" | "reorder",
  ): void => {
    if (
      event.button !== 0 ||
      isPointerInteractionActive() ||
      columnGesture.current !== undefined ||
      columnGestureActor.getSnapshot().status !== "active" ||
      columnGestureActor.getSnapshot().value !== "idle"
    )
      return;
    event.preventDefault();
    const target = event.currentTarget;
    navigation.activateHeader(column.columnId);
    target.focus({ preventScroll: true });
    try {
      if (typeof target.setPointerCapture === "function") target.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic browser tests can dispatch a pointer without a native active pointer.
      // Real pointer input still receives capture before the rAF preview begins.
    }
    const direction =
      getComputedStyle(gridElement.current ?? target).direction === "rtl" ? "rtl" : "ltr";
    const sourceIndex = logicalColumns.findIndex(
      (candidate) => candidate.columnId === column.columnId,
    );
    const reorderGeometry = readReorderGeometry(direction);
    const grid = gridElement.current;
    const gridRect = grid?.getBoundingClientRect();
    const pinnedStartRects = [
      ...(grid?.querySelectorAll<HTMLElement>(
        'th[data-bruno-column-id][data-pinned-region="start"]',
      ) ?? []),
    ].map((element) => element.getBoundingClientRect());
    const pinnedEndRects = [
      ...(grid?.querySelectorAll<HTMLElement>(
        'th[data-bruno-column-id][data-pinned-region="end"]',
      ) ?? []),
    ].map((element) => element.getBoundingClientRect());
    const leftPinnedRects = direction === "rtl" ? pinnedEndRects : pinnedStartRects;
    const rightPinnedRects = direction === "rtl" ? pinnedStartRects : pinnedEndRects;
    const selectionRect = grid
      ?.querySelector<HTMLElement>(
        `th[data-bruno-column-id="${BRUNO_TABLE_ROW_SELECTION_COLUMN_ID}"]`,
      )
      ?.getBoundingClientRect();
    const reorderCenterBounds = resolveBrunoTableReorderCenterBounds(
      direction,
      gridRect ?? { left: 0, right: 0 },
      leftPinnedRects,
      rightPinnedRects,
      selectionRect,
    );
    columnGesture.current = {
      kind,
      pointerId: event.pointerId,
      columnId: column.columnId,
      sourceIndex,
      startX: event.clientX,
      initialWidth: column.semantics.width,
      minWidth: runtime.getColumnCommandSnapshot(column.columnId).minWidth,
      maxWidth: runtime.getColumnCommandSnapshot(column.columnId).maxWidth,
      direction,
      sourcePinned: column.pinned,
      pinningSuspended: columnWindow.pinningSuspended,
      groupStart: 0,
      groupEnd: Math.max(0, logicalColumns.length - 1),
      target,
      onPointerMove: onColumnPointerMove,
      onPointerUp: onColumnPointerUp,
      onPointerCancel: onColumnPointerCancel,
      reorderGeometry,
      reorderGeometryVersion: reorderGeometryVersion.current,
      reorderGeometryVersionBeforeScroll: reorderGeometryVersion.current,
      reorderCenterBounds,
      currentX: event.clientX,
      previewedX: undefined,
      reorderPreviewApplied: false,
      targetIndex: sourceIndex,
      targetPinned: column.pinned,
      frame: null,
    };
    columnGestureActor.send({ type: "START", kind });
    window.addEventListener("pointermove", columnGesture.current.onPointerMove, true);
    if (__BRUNO_TABLE_TEST_DIAGNOSTICS__) {
      recordBrunoTableClientColumnGestureListener(tableId, {
        phase: "attach",
        event: "pointermove",
      });
    }
    window.addEventListener("pointerup", columnGesture.current.onPointerUp, true);
    if (__BRUNO_TABLE_TEST_DIAGNOSTICS__) {
      recordBrunoTableClientColumnGestureListener(tableId, {
        phase: "attach",
        event: "pointerup",
      });
    }
    window.addEventListener("pointercancel", columnGesture.current.onPointerCancel, true);
    if (__BRUNO_TABLE_TEST_DIAGNOSTICS__) {
      recordBrunoTableClientColumnGestureListener(tableId, {
        phase: "attach",
        event: "pointercancel",
      });
    }
    if (kind === "resize") {
      writePreviewProperty(
        brunoTableColumnCssVariable("width", column.columnId),
        `${column.semantics.width}px`,
      );
      setAnnouncement(`Resizing ${column.headerName}`);
    } else {
      setAnnouncement(`Reordering ${column.headerName}`);
    }
  };

  useEffect(() => {
    gestureCancel.current = () => finishColumnGesture(false);
    columnPointerDownHandler.current = startColumnGesture;
  });
  useEffect(() => {
    columnGestureActor.start();
    return () => {
      gestureCancel.current();
      columnGestureActor.stop();
    };
  }, [columnGestureActor]);
  useEffect(
    () =>
      subscribeViewportEnvironment(() => {
        gestureCancel.current();
      }),
    [subscribeViewportEnvironment],
  );
  useEffect(
    () =>
      runtime.subscribeChrome(() => {
        const status = runtime.getChromeSnapshot().status;
        if (status === "stale" || status === "closed" || status === "error") {
          gestureCancel.current();
        }
      }),
    [runtime],
  );
  const gestureShapeRef = useRef<
    | {
        readonly columns: readonly CompiledColumn[];
        readonly layoutVersion: number;
        readonly queryGeneration: number;
        readonly totalRows: number;
      }
    | undefined
  >(undefined);
  useEffect(() => {
    const previous = gestureShapeRef.current;
    const next = Object.freeze({
      columns: logicalColumns,
      layoutVersion: columnLayout.version,
      queryGeneration,
      totalRows: rowSpace.totalRows,
    });
    if (
      previous !== undefined &&
      (previous.columns !== next.columns ||
        previous.layoutVersion !== next.layoutVersion ||
        previous.queryGeneration !== next.queryGeneration ||
        previous.totalRows !== next.totalRows)
    ) {
      gestureCancel.current();
    }
    gestureShapeRef.current = next;
  }, [columnLayout.version, logicalColumns, queryGeneration, rowSpace.totalRows]);
  const onColumnPointerDown = useMemo<BrunoTableColumnPointerDownHandler>(
    () => (event, column, kind) => columnPointerDownHandler.current(event, column, kind),
    [],
  );
  const refreshDragFillLayout = useCallback((): void => {
    const grid = gridElement.current;
    if (grid === null) {
      dragFillLayout.current = undefined;
      return;
    }
    const bounds = grid.getBoundingClientRect();
    const headerBottom =
      grid.querySelector("thead")?.getBoundingClientRect().bottom ?? bounds.top + ROW_HEIGHT;
    const direction = getComputedStyle(grid).direction === "rtl" ? "rtl" : "ltr";
    const input = dragFillLayoutInput.current;
    const pinnedStartWidth = totalColumnWidth(input.pinnedStart);
    const pinnedEndWidth = totalColumnWidth(input.pinnedEnd);
    const startInset = input.rowSelectionWidth + pinnedStartWidth;
    const endInset = pinnedEndWidth;
    const centreLeft = Math.min(
      Math.max(bounds.left + (direction === "rtl" ? endInset : startInset), bounds.left),
      bounds.right,
    );
    const centreRight = Math.max(
      centreLeft,
      Math.min(bounds.right - (direction === "rtl" ? startInset : endInset), bounds.right),
    );
    dragFillLayout.current = Object.freeze({
      direction,
      interactionGeometry: Object.freeze({
        bodyTop: Math.min(Math.max(headerBottom, bounds.top), bounds.bottom),
        bodyBottom: bounds.bottom,
        centreLeft,
        centreRight,
      }),
    });
  }, []);
  const attachGrid = useMemo(
    () => (element: HTMLDivElement | null) => {
      const previousGrid = gridElement.current;
      const activeElement = previousGrid?.ownerDocument.activeElement;
      if (
        element === null &&
        previousGrid !== null &&
        activeElement !== undefined &&
        activeElement !== null &&
        previousGrid.contains(activeElement)
      ) {
        focusHandoff.release();
        focusFallback();
      }
      gridElement.current = element;
      cellRange?.attachGrid(element);
      attach(element);
      refreshDragFillLayout();
      if (element !== null && focusHandoff.claim()) element.focus({ preventScroll: true });
    },
    [attach, cellRange, focusFallback, focusHandoff, refreshDragFillLayout],
  );
  useLayoutEffect(() => {
    dragFillLayoutInput.current = Object.freeze({
      pinnedStart: columnWindow.pinnedStart,
      pinnedEnd: columnWindow.pinnedEnd,
      rowSelectionWidth,
    });
    refreshDragFillLayout();
  }, [
    columnWindow.pinnedEnd,
    columnWindow.pinnedStart,
    refreshDragFillLayout,
    rowSelectionWidth,
    viewportSnapshot.height,
  ]);
  useEffect(
    () =>
      subscribeViewportEnvironment(() => {
        dragFillRuntime?.cancel();
        refreshDragFillLayout();
      }),
    [dragFillRuntime, refreshDragFillLayout, subscribeViewportEnvironment],
  );
  const attachBodyLayerWithFocusHandoff = useMemo<RefCallback<HTMLElement>>(
    () => (element) => {
      const detach = attachBodyLayer(element);
      if (element === null) return detach;
      return () => {
        const activeElement = element.ownerDocument.activeElement;
        if (activeElement !== null && element.contains(activeElement)) {
          gridElement.current?.focus({ preventScroll: true });
        }
        detach?.();
      };
    },
    [attachBodyLayer],
  );
  const activateHeaderCommand = useMemo(
    () => (columnId: string) => {
      navigation.activateHeader(columnId);
      gridElement.current?.focus({ preventScroll: true });
    },
    [navigation],
  );
  const registerColumnFilterOpener = useCallback(
    (columnId: string, open: () => void): (() => void) => {
      columnFilterOpeners.current.set(columnId, open);
      return () => {
        if (columnFilterOpeners.current.get(columnId) === open) {
          columnFilterOpeners.current.delete(columnId);
        }
      };
    },
    [],
  );
  const requestColumnFilterOpen = useCallback((columnId: string): boolean => {
    const open = columnFilterOpeners.current.get(columnId);
    if (open === undefined) return false;
    open();
    return true;
  }, []);
  const cancelFilterOpenRetry = useCallback((): void => {
    filterOpenToken.current += 1;
    filterOpenRetry.current = () => undefined;
    if (filterOpenFrame.current !== null) {
      cancelAnimationFrame(filterOpenFrame.current);
      filterOpenFrame.current = null;
    }
  }, []);
  const toggleHeaderSort = useMemo(
    () =>
      (columnId: string, multi: boolean): void => {
        const accepted = runtime.dispatchGridCommand({
          type: "column.sort.toggle",
          columnId,
          multi,
        });
        if (!accepted) return;
        const next = runtime.getColumnCommandSnapshot(columnId);
        const column = commandColumns.current.find((candidate) => candidate.columnId === columnId);
        if (column === undefined) return;
        setAnnouncement(columnSortAnnouncement(column.headerName, next));
      },
    [runtime, setAnnouncement],
  );
  const toggleHeaderFilter = useMemo(
    () =>
      (columnId: string): void => {
        const command = runtime.getColumnCommandSnapshot(columnId);
        const column = commandColumns.current.find((candidate) => candidate.columnId === columnId);
        if (column === undefined) return;
        const action = command.filterActive ? "cleared" : "reset";
        const accepted = runtime.dispatchGridCommand({
          type: command.filterActive ? "column.filter.clear" : "column.filter.reset",
          columnId,
        });
        if (!accepted) return;
        setAnnouncement(`${column.headerName} filter ${action}`);
      },
    [runtime, setAnnouncement],
  );
  const openHeaderFilter = useMemo(
    () =>
      (columnId: string): void => {
        const column = commandColumns.current.find((candidate) => candidate.columnId === columnId);
        if (column === undefined) return;
        cancelFilterOpenRetry();
        if (requestColumnFilterOpen(column.columnId)) return;
        revealCell(0, column.columnId, "header");
        const token = filterOpenToken.current;
        let attemptsRemaining = 4;
        filterOpenRetry.current = (): void => {
          filterOpenFrame.current = null;
          const active = navigation.getSnapshot();
          if (
            token !== filterOpenToken.current ||
            active?.region !== "header" ||
            active.columnId !== column.columnId ||
            !commandColumns.current.some((candidate) => candidate.columnId === column.columnId)
          ) {
            return;
          }
          if (requestColumnFilterOpen(column.columnId)) return;
          attemptsRemaining -= 1;
          if (attemptsRemaining > 0) {
            filterOpenFrame.current = requestAnimationFrame(filterOpenRetry.current);
          }
        };
        filterOpenFrame.current = requestAnimationFrame(filterOpenRetry.current);
      },
    [cancelFilterOpenRetry, navigation, requestColumnFilterOpen, revealCell],
  );
  useEffect(
    () => () => {
      if (interactionFrame.current !== null) cancelAnimationFrame(interactionFrame.current);
      if (focusRestoreFrame.current !== null) cancelAnimationFrame(focusRestoreFrame.current);
      cancelFilterOpenRetry();
      columnFilterOpeners.current.clear();
      focusRestoreFrame.current = null;
      focusRestoreRetry.current = () => undefined;
      gestureCancel.current();
    },
    [cancelFilterOpenRetry],
  );

  const enterInteractiveCell = (active: BrunoTableActiveCell, column: CompiledColumn): boolean => {
    if (active.region !== "body" || column.cellRenderer === undefined) return false;
    const activeId = activeDomId(instanceId, tableId, active);
    if (activeId === undefined) return false;
    const cell = gridElement.current?.querySelector<HTMLElement>(`#${activeId}`) ?? null;
    if (cell !== null && !cell.hasAttribute("data-bruno-active-proxy")) {
      return focusFirstInteractiveDescendant(cell);
    }
    revealCell(active.rowIndex, active.columnId, active.region, active.rowId);
    if (interactionFrame.current !== null) cancelAnimationFrame(interactionFrame.current);
    let attemptsRemaining = 4;
    const focusAfterMount = () => {
      interactionFrame.current = null;
      const current = navigation.getSnapshot();
      if (
        current?.region !== active.region ||
        current.rowIndex !== active.rowIndex ||
        current.rowId !== active.rowId ||
        current.columnId !== active.columnId
      ) {
        return;
      }
      const mountedCell = gridElement.current?.querySelector<HTMLElement>(`#${activeId}`) ?? null;
      if (
        mountedCell !== null &&
        !mountedCell.hasAttribute("data-bruno-active-proxy") &&
        focusFirstInteractiveDescendant(mountedCell)
      ) {
        return;
      }
      attemptsRemaining -= 1;
      if (attemptsRemaining > 0) interactionFrame.current = requestAnimationFrame(focusAfterMount);
    };
    interactionFrame.current = requestAnimationFrame(focusAfterMount);
    return true;
  };

  const ownsGridSurface = (event: BrunoTableHotkeyGesture): boolean =>
    event.target === gridElement.current || event.target === producedTextCapture.current;
  const ownsRowSelectionCommand = (event: BrunoTableHotkeyGesture): boolean => {
    const grid = gridElement.current;
    if (grid === null) return false;
    if (event.target === grid) return true;
    if (!isNodeInBrunoTableRealm(grid, event.target)) return false;
    const ElementConstructor = grid.ownerDocument.defaultView?.Element;
    if (ElementConstructor === undefined || !(event.target instanceof ElementConstructor)) {
      return false;
    }
    return (
      event.target.closest("[data-bruno-row-selection-checkbox]")?.closest('[role="grid"]') === grid
    );
  };
  const resolveEventColumn = (event: BrunoTableHotkeyGesture): CompiledColumn | undefined => {
    const target = event.target instanceof Element ? event.target : null;
    const header = target?.closest<HTMLElement>("th[data-bruno-column-id]");
    const columnId = header?.dataset["brunoColumnId"];
    return logicalColumns.find((candidate) => candidate.columnId === columnId);
  };
  const runNavigation = (
    event: BrunoTableHotkeyGesture,
    command: BrunoTableNavigationCommand,
    extendCellRange = false,
  ): void => {
    if (!ownsGridSurface(event)) return;
    event.preventDefault();
    if (isPointerInteractionActive()) return;
    const currentRange = cellRange?.getSnapshot().range;
    const extendingRange = extendCellRange && cellRange !== undefined;
    if (extendingRange && currentRange !== undefined && cellRangeStructure !== undefined) {
      const rowIndex = cellRangeStructure.rowIndexById.get(currentRange.focus.rowId);
      if (rowIndex !== undefined) {
        navigation.activateBody(rowIndex, currentRange.focus.rowId, currentRange.focus.columnId);
      }
    } else {
      navigation.activateForFocus();
    }
    const current = navigation.getSnapshot();
    if (
      extendingRange &&
      current?.region === "body" &&
      !isBrunoTableCellRangeNavigationCommandAdmitted(currentRange?.axis, command, current.rowIndex)
    ) {
      return;
    }
    const axisProjectedCommand =
      extendingRange && currentRange !== undefined && command.type === "grid-edge"
        ? currentRange.axis === "horizontal"
          ? ({ type: "row-edge", edge: command.edge } as const)
          : ({ type: "column-edge", edge: command.edge } as const)
        : command;
    const effectiveCommand =
      extendingRange && axisProjectedCommand.type === "column-edge"
        ? ({
            type: "page",
            rowDelta:
              axisProjectedCommand.edge === "start" ? -rowSpace.totalRows : rowSpace.totalRows,
          } as const)
        : axisProjectedCommand;
    navigation.navigate(effectiveCommand);
    let next = navigation.getSnapshot();
    if (cellRange !== undefined) {
      if (next?.region === "body" && next.rowId !== undefined && cellRangeStructure !== undefined) {
        if (extendingRange && current?.region === "body" && current.rowId !== undefined) {
          const currentCoordinate = { rowId: current.rowId, columnId: current.columnId };
          const nextCoordinate = { rowId: next.rowId, columnId: next.columnId };
          const selection = cellRange.extendFromCurrent(
            currentCoordinate,
            nextCoordinate,
            cellRangeStructure,
          );
          const focus = selection.range?.focus ?? selection.anchor;
          if (focus !== undefined) {
            const rowIndex = cellRangeStructure.rowIndexById.get(focus.rowId);
            if (rowIndex !== undefined) {
              navigation.activateBody(rowIndex, focus.rowId, focus.columnId);
              next = navigation.getSnapshot();
            }
          }
        } else {
          cellRange.replace({ rowId: next.rowId, columnId: next.columnId }, cellRangeStructure);
        }
      } else {
        cellRange.clear();
      }
    }
    if (next !== undefined) revealCell(next.rowIndex, next.columnId, next.region, next.rowId);
  };
  const runPageNavigation = (
    event: BrunoTableHotkeyGesture,
    direction: -1 | 1,
    extendCellRange = false,
  ): void => {
    const grid = gridElement.current;
    if (grid === null || event.target !== grid) return;
    runNavigation(
      event,
      { type: "page", rowDelta: direction * viewportPageSize(grid) },
      extendCellRange,
    );
  };
  const runCopy = (event: BrunoTableHotkeyGesture): void => {
    if ((!enableActiveCellCopy && cellRange === undefined) || !ownsGridSurface(event)) return;
    const clipboard = navigator.clipboard;
    if (cellRange !== undefined) event.preventDefault();
    const active = navigation.getSnapshot();
    if (cellRangeStructure !== undefined) cellRange?.reconcile(cellRangeStructure);
    const structurallyInvalidated = cellRange?.consumeStructuralInvalidation() === true;
    const selection = cellRange?.getSnapshot() ?? {};
    const activeCoordinate =
      active?.region === "body" && active.rowId !== undefined
        ? { rowId: active.rowId, columnId: active.columnId }
        : undefined;
    const target =
      selection.range !== undefined
        ? clipboardTargetFromRange(selection.range)
        : activeCoordinate === undefined
          ? undefined
          : clipboardTargetFromSelection({}, activeCoordinate);
    if (!structurallyInvalidated && target === undefined) return;
    const copyToken = ++copyCommandToken.current;
    const announceCopy = (message: string): void => {
      if (copyCommandToken.current === copyToken) setAnnouncement(message);
    };
    if (structurallyInvalidated) {
      announceCopy("Copy failed: the selected cells are no longer available");
      return;
    }
    if (clipboard?.writeText === undefined) {
      announceCopy("Copy failed: clipboard access is unavailable");
      return;
    }
    if (target === undefined) return;
    let snapshot: ReturnType<typeof captureBrunoTableClipboardSnapshot>;
    try {
      const readCell = runtime.captureCellCommandReader();
      let readEditValue: BrunoTableEditValueCommandReader | undefined;
      if (cellEdit) readEditValue = cellEdit.captureEditValueCommandReader();
      snapshot = captureBrunoTableClipboardSnapshot(target, ({ rowId, columnId }) =>
        readBrunoTableEffectiveCanonicalCell(readCell, readEditValue, rowId, columnId),
      );
    } catch {
      announceCopy("Copy failed: a selected value could not be serialized");
      return;
    }
    if (snapshot === undefined) {
      announceCopy("Copy failed: the selected cells are no longer available");
      return;
    }
    const text = serializeBrunoTableClipboardSnapshot(snapshot);
    event.preventDefault();
    let write: Promise<void>;
    try {
      write = clipboard.writeText(text);
    } catch {
      announceCopy("Copy failed: the browser rejected the clipboard write");
      return;
    }
    void write.then(
      () =>
        announceCopy(
          `${String(snapshot.canonicalTexts.length)} ${snapshot.canonicalTexts.length === 1 ? "cell" : "cells"} copied`,
        ),
      () => announceCopy("Copy failed: the browser rejected the clipboard write"),
    );
  };
  const latestPasteStructure = useRef(cellRangeStructure);
  const latestDragFillStructure = useRef(cellRangeStructure);
  const latestPasteColumnLabels = useRef<ReadonlyMap<string, string> | undefined>(
    new Map(logicalColumns.map((column) => [column.columnId, column.headerName])),
  );
  const describePasteCoordinate = useCallback(
    (coordinate: { readonly rowId: string; readonly columnId: string }) => {
      const currentRow = latestPasteStructure.current?.rowIndexById.get(coordinate.rowId);
      return pasteCapability!.coordinateEvidence(
        latestPasteColumnLabels.current?.get(coordinate.columnId) ?? coordinate.columnId,
        currentRow === undefined ? coordinate.rowId : String(currentRow + 1),
      );
    },
    [pasteCapability],
  );
  const rejectDirectPaste = useCallback(
    (diagnostic: BrunoTablePasteDiagnostic): void => {
      pasteRuntime?.notify(diagnostic);
    },
    [pasteRuntime],
  );
  useLayoutEffect(() => {
    latestPasteStructure.current = cellRangeStructure;
    latestDragFillStructure.current = cellRangeStructure;
    latestPasteColumnLabels.current = new Map(
      logicalColumns.map((column) => [column.columnId, column.headerName]),
    );
  }, [cellRangeStructure, logicalColumns]);
  useEffect(
    () => () => {
      latestPasteStructure.current = undefined;
      latestDragFillStructure.current = undefined;
      latestPasteColumnLabels.current = undefined;
    },
    [],
  );
  const runPaste = (event: BrunoTableHotkeyGesture): void => {
    if (
      cellEdit === undefined ||
      cellRange === undefined ||
      cellRangeStructure === undefined ||
      pasteRuntime === undefined ||
      pasteCapability === undefined ||
      !ownsGridSurface(event)
    ) {
      return;
    }
    event.preventDefault();
    if (isPointerInteractionActive()) return;
    if (pasteRuntime.isClipboardReadPending()) {
      rejectDirectPaste(pasteCapability.diagnostic("clipboard-read-pending"));
      return;
    }
    const clipboard = navigator.clipboard;
    if (clipboard?.readText === undefined) {
      rejectDirectPaste(pasteCapability.diagnostic("clipboard-unavailable"));
      return;
    }
    const active = navigation.getSnapshot();
    const activeCoordinate =
      active?.region === "body" && active.rowId !== undefined
        ? { rowId: active.rowId, columnId: active.columnId }
        : undefined;
    cellRange.reconcile(cellRangeStructure);
    if (cellRange.consumeStructuralInvalidation()) {
      rejectDirectPaste(pasteCapability.diagnostic("structure-changed"));
      return;
    }
    const selection = cellRange.getSnapshot();
    const target = clipboardTargetFromSelection(selection, activeCoordinate);
    if (target === undefined) {
      rejectDirectPaste(pasteCapability.diagnostic("no-target"));
      return;
    }
    const readSequence = pasteRuntime.beginClipboardRead();
    if (readSequence === undefined) {
      rejectDirectPaste(pasteCapability.diagnostic("clipboard-read-pending"));
      return;
    }
    let read: Promise<string>;
    try {
      read = clipboard.readText();
    } catch {
      pasteRuntime.finishClipboardRead(readSequence);
      rejectDirectPaste(pasteCapability.diagnostic("clipboard-read-rejected"));
      return;
    }
    void read.then(
      (text) => {
        if (!pasteRuntime.finishClipboardRead(readSequence)) return;
        const currentStructure = latestPasteStructure.current;
        if (
          currentStructure === undefined ||
          !pasteCapability.isTargetCurrent(target, currentStructure)
        ) {
          rejectDirectPaste(pasteCapability.diagnostic("structure-changed"));
          return;
        }
        const plan = pasteCapability.plan(text, target, currentStructure);
        if (plan.kind === "rejected") {
          rejectDirectPaste(plan.diagnostic);
          return;
        }
        if (plan.kind === "direct") {
          const result = cellEdit.applyCanonicalTextGesture(plan.gesture);
          if (result.kind === "rejected") {
            rejectDirectPaste(pasteCapability.fromCellEdit(result));
          } else {
            pasteRuntime.clearNotification();
            setAnnouncement(
              `${String(plan.gesture.length)} ${plan.gesture.length === 1 ? "cell" : "cells"} pasted`,
            );
          }
          return;
        }
        const copiedLength = plan.paste.canonicalTexts.length;
        const selectedLength =
          plan.selected.axis === "horizontal"
            ? plan.selected.columnIds.length
            : plan.selected.rowIds.length;
        const rowIndex = currentStructure.rowIndexById.get(plan.start.rowId) ?? 0;
        const columnIndex = currentStructure.columnIndexById.get(plan.start.columnId) ?? 0;
        const proposedEndCoordinate =
          plan.proposed === undefined
            ? plan.paste.axis === "horizontal"
              ? pasteCapability.coordinateEvidence(
                  `column ${String(columnIndex + copiedLength)}`,
                  String(rowIndex + 1),
                )
              : pasteCapability.coordinateEvidence(
                  logicalColumns.find((column) => column.columnId === plan.start.columnId)
                    ?.headerName ?? plan.start.columnId,
                  String(rowIndex + copiedLength),
                )
            : describePasteCoordinate({
                rowId: plan.proposed.rowIds.at(-1)!,
                columnId: plan.proposed.columnIds.at(-1)!,
              });
        pasteRuntime.open(
          Object.freeze({
            paste: plan.paste,
            selected: plan.selected,
            start: plan.start,
            proposed: plan.proposed,
            copiedDescription: `${String(copiedLength)}-cell ${plan.paste.axis} line`,
            selectedDescription: `${String(selectedLength)}-cell ${plan.selected.axis} line`,
            proposedDescription: `${String(copiedLength)}-cell ${plan.paste.axis} line`,
            startCoordinate: describePasteCoordinate(plan.start),
            endCoordinate: proposedEndCoordinate,
          }),
        );
      },
      () => {
        if (!pasteRuntime.finishClipboardRead(readSequence)) return;
        rejectDirectPaste(pasteCapability.diagnostic("clipboard-read-rejected"));
      },
    );
  };
  useEffect(() => {
    if (pasteRuntime === undefined || cellEdit === undefined || pasteCapability === undefined)
      return;
    return pasteRuntime.register(
      (confirmation: BrunoTablePasteConfirmation) => {
        const currentStructure = latestPasteStructure.current;
        if (currentStructure === undefined) {
          return Object.freeze({
            kind: "rejected" as const,
            diagnostic: pasteCapability.diagnostic("destination-unavailable"),
          });
        }
        const target = pasteCapability.projectTarget(
          confirmation.paste,
          confirmation.start,
          currentStructure,
        );
        if (confirmation.proposed === undefined) {
          return Object.freeze({
            kind: "rejected" as const,
            diagnostic: pasteCapability.diagnostic("out-of-bounds"),
          });
        }
        if (target === undefined || !pasteCapability.sameTarget(target, confirmation.proposed)) {
          return Object.freeze({
            kind: "rejected" as const,
            diagnostic: pasteCapability.diagnostic("confirmation-changed"),
          });
        }
        const gesture = pasteCapability.gesture(
          confirmation.paste,
          confirmation.proposed,
          currentStructure,
        );
        if (gesture === undefined) {
          return Object.freeze({
            kind: "rejected" as const,
            diagnostic: pasteCapability.diagnostic("destination-unavailable"),
          });
        }
        const result = cellEdit.applyCanonicalTextGesture(gesture);
        return result.kind === "accepted"
          ? result
          : Object.freeze({
              kind: "rejected" as const,
              diagnostic: pasteCapability.fromCellEdit(result),
            });
      },
      () => gridElement.current?.focus({ preventScroll: true }),
      describePasteCoordinate,
    );
  }, [cellEdit, describePasteCoordinate, pasteCapability, pasteRuntime]);

  const dragFillShape = useRef<
    | Readonly<{
        readonly axis: "horizontal" | "vertical";
        readonly sourceFirstIdentity: string;
        readonly sourceLastIdentity: string;
        readonly perpendicularIdentity: string;
        readonly sourceCellCount: number;
        readonly handle: Readonly<{ readonly rowId: string; readonly columnId: string }>;
        readonly range: BrunoTableCellRange | undefined;
        readonly identity: object;
        readonly source: BrunoTableDragFillSourceShape;
      }>
    | undefined
  >(undefined);
  const refreshDragFillSourceShape = useCallback((): void => {
    const structure = latestDragFillStructure.current;
    if (
      dragFillRuntime === undefined ||
      cellRange === undefined ||
      structure === undefined ||
      editMemory?.getConflictReviewSnapshot().open === true ||
      editMemory?.getResetReviewSnapshot().open === true ||
      editMemory?.getBlockedReviewSnapshot().open === true
    ) {
      dragFillShape.current = undefined;
      return;
    }
    const active = navigation.getSnapshot();
    const activeCoordinate =
      active?.region === "body" && active.rowId !== undefined
        ? Object.freeze({ rowId: active.rowId, columnId: active.columnId })
        : undefined;
    const selection = cellRange.getSnapshot();
    const range = selection.range;
    const cell = activeCoordinate ?? selection.anchor;
    if (range === undefined && cell === undefined) {
      dragFillShape.current = undefined;
      return;
    }
    const axis = range?.axis ?? "horizontal";
    const handle = range?.focus ?? cell!;
    const parallelSpan =
      range?.axis === "horizontal"
        ? range.columnSpan
        : range?.axis === "vertical"
          ? range.rowSpan
          : undefined;
    const sourceFirstIdentity =
      parallelSpan === undefined ? handle.columnId : parallelSpan.identities[parallelSpan.start]!;
    const sourceLastIdentity =
      parallelSpan === undefined ? handle.columnId : parallelSpan.identities[parallelSpan.end]!;
    const perpendicularIdentity = axis === "horizontal" ? handle.rowId : handle.columnId;
    const sourceCellCount =
      parallelSpan === undefined ? 1 : parallelSpan.end - parallelSpan.start + 1;
    const previous = dragFillShape.current;
    const shapeCurrent =
      previous !== undefined &&
      previous.axis === axis &&
      previous.sourceFirstIdentity === sourceFirstIdentity &&
      previous.sourceLastIdentity === sourceLastIdentity &&
      previous.perpendicularIdentity === perpendicularIdentity &&
      previous.sourceCellCount === sourceCellCount &&
      previous.handle.rowId === handle.rowId &&
      previous.handle.columnId === handle.columnId;
    const identity = shapeCurrent ? previous.identity : Object.freeze({});
    const source = Object.freeze({
      shapeIdentity: identity,
      axis,
      sourceCellCount,
      sourceFirstIdentity,
      sourceLastIdentity,
      perpendicularIdentity,
      handle: Object.freeze({ ...handle }),
    });
    dragFillShape.current = Object.freeze({
      axis,
      sourceFirstIdentity,
      sourceLastIdentity,
      perpendicularIdentity,
      sourceCellCount,
      handle: Object.freeze({ ...handle }),
      range,
      identity,
      source,
    });
  }, [cellRange, dragFillRuntime, editMemory, navigation]);
  const getDragFillSourceShape = useCallback(
    (): BrunoTableDragFillSourceShape | undefined => dragFillShape.current?.source,
    [],
  );
  const captureDragFillSource = useCallback((): BrunoTableDragFillSource | undefined => {
    refreshDragFillLayout();
    const currentShape = dragFillShape.current;
    const shape = currentShape?.source;
    if (shape === undefined || currentShape === undefined || cellEdit === undefined)
      return undefined;
    try {
      const readCell = runtime.captureCellCommandReader();
      const readEditValue = cellEdit.captureEditValueCommandReader();
      let target: ReturnType<typeof clipboardTargetFromRange>;
      if (currentShape.range === undefined) target = Object.freeze({
              axis: "horizontal" as const,
              rowIds: Object.freeze([shape.handle.rowId] as const),
              columnIds: Object.freeze([shape.handle.columnId] as const),
            });
      else target = clipboardTargetFromRange(currentShape.range);
      const snapshot = captureBrunoTableClipboardSnapshot(target, ({ rowId, columnId }) => {
        return readBrunoTableEffectiveCanonicalCell(readCell, readEditValue, rowId, columnId);
      });
      if (snapshot === undefined) return undefined;
      return Object.freeze({
            ...shape,
            rowIds: snapshot.rowIds,
            columnIds: snapshot.columnIds,
            canonicalTexts: snapshot.canonicalTexts,
          });
    } catch {
      return undefined;
    }
  }, [cellEdit, refreshDragFillLayout, runtime]);
  useLayoutEffect(() => {
    const grid = gridElement.current;
    if (grid === null || dragFillRuntime === undefined || cellEdit === undefined) return;
    const unregister = dragFillRuntime.register({
      grid,
      canStart: () =>
        !isPointerInteractionActive("drag-fill") &&
        cellEdit.getSessionSnapshot().kind !== "editing" &&
        pasteRuntime?.isClipboardReadPending() !== true &&
        pasteRuntime?.getSnapshot().open !== true,
      getSourceShape: () =>
        cellEdit.getSessionSnapshot().kind === "editing" ? undefined : getDragFillSourceShape(),
      captureSource: captureDragFillSource,
      getStructure: () => latestDragFillStructure.current,
      apply: (cells) => {
        const result = cellEdit.applyCanonicalTextGesture(cells);
        if (result.kind === "accepted") return result;
        if (result.reason === "unchanged") {
          return Object.freeze({ kind: "unchanged" as const });
        }
        const reason = result.reason;
        return addDragFillRejectionEvidence!(cells, Object.freeze({ ...result, reason }));
      },
      interactionGeometry: () =>
        dragFillLayout.current?.interactionGeometry ?? EMPTY_DRAG_FILL_INTERACTION_GEOMETRY,
      resolvePointerHit: (clientX, clientY, phase) => {
        const geometry = dragFillLayout.current?.interactionGeometry;
        if (geometry === undefined) return undefined;
        const hit = resolveBodyHit({ ...geometry, clientX, clientY, phase });
        if (hit === undefined) return undefined;
        const rowId = rowSpace.getRowId(hit.rowIndex);
        return rowId === undefined ? undefined : Object.freeze({ rowId, columnId: hit.columnId });
      },
      scrollHorizontalByPhysical: (delta) =>
        scrollByLogical((dragFillLayout.current?.direction === "rtl" ? -1 : 1) * delta),
      scrollVerticalByLogical,
      describeCoordinate: (coordinate) => {
        const evidence = describePasteCoordinate(coordinate);
        return `${evidence.columnLabel}, row ${evidence.rowLabel}`;
      },
    });
    const reconcile = (): void => {
      refreshDragFillSourceShape();
      dragFillRuntime.reconcile();
    };
    const unsubscribeRange = cellRange?.subscribe(reconcile);
    const unsubscribeNavigation = navigation.subscribe(reconcile);
    const unsubscribeEditSession = cellEdit.subscribeSession(reconcile);
    const unsubscribeConflictReview = editMemory?.subscribeConflictReview(reconcile);
    const unsubscribeResetReview = editMemory?.subscribeResetReview(reconcile);
    const unsubscribeBlockedReview = editMemory?.subscribeBlockedReview(reconcile);
    reconcile();
    return () => {
      unsubscribeBlockedReview?.();
      unsubscribeResetReview?.();
      unsubscribeConflictReview?.();
      unsubscribeEditSession();
      unsubscribeNavigation();
      unsubscribeRange?.();
      unregister();
      dragFillShape.current = undefined;
    };
  }, [
    captureDragFillSource,
    cellEdit,
    cellRange,
    addDragFillRejectionEvidence,
    describePasteCoordinate,
    dragFillRuntime,
    editMemory,
    getDragFillSourceShape,
    isPointerInteractionActive,
    navigation,
    pasteRuntime,
    refreshDragFillSourceShape,
    rowSpace,
    scrollByLogical,
    scrollVerticalByLogical,
    resolveBodyHit,
  ]);
  useLayoutEffect(() => {
    refreshDragFillSourceShape();
    dragFillRuntime?.reconcile();
  }, [cellRangeStructure, dragFillRuntime, refreshDragFillSourceShape]);

  const runCellRangePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (
      cellRange === undefined ||
      cellRangeStructure === undefined ||
      isPointerInteractionActive("cell-range")
    ) {
      return;
    }
    const grid = event.currentTarget;
    const hit = brunoTableCellRangePointerHit(event.target, grid);
    if (hit === undefined) return;
    const extendingWithShift = isBrunoTableHotkeyHeld("Shift");
    const horizontalLogicalSign = getComputedStyle(grid).direction === "rtl" ? -1 : 1;
    const activeBefore = navigation.getSnapshot();
    const currentActive =
      activeBefore?.region === "body" && activeBefore.rowId !== undefined
        ? { rowId: activeBefore.rowId, columnId: activeBefore.columnId }
        : undefined;
    cellRange.startPointerGesture(
      event.nativeEvent,
      hit,
      grid,
      (next) => {
        navigation.activateBody(next.rowIndex, next.rowId, next.columnId);
      },
      () => {
        navigation.restoreActiveCell(activeBefore);
      },
      (physicalDelta) => scrollByLogical(horizontalLogicalSign * physicalDelta),
      currentActive,
      extendingWithShift,
    );
  };
  const runColumnResize = (
    event: BrunoTableHotkeyGesture,
    adjustment: "minimum" | "maximum" | number,
    step: number,
    allowActiveHeader = false,
  ): void => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const separator = target?.closest<HTMLElement>('[role="separator"]') ?? null;
    const active = navigation.getSnapshot();
    const column =
      separator !== null
        ? resolveEventColumn(event)
        : allowActiveHeader && ownsGridSurface(event) && active?.region === "header"
          ? logicalColumns.find((candidate) => candidate.columnId === active.columnId)
          : undefined;
    if (column === undefined) return;
    const command = runtime.getColumnCommandSnapshot(column.columnId);
    const directionSource = gridElement.current ?? target;
    if (directionSource === null) return;
    const direction = getComputedStyle(directionSource).direction === "rtl" ? "rtl" : "ltr";
    const width =
      adjustment === "minimum"
        ? command.minWidth
        : adjustment === "maximum"
          ? command.maxWidth
          : command.width + (direction === "rtl" ? -adjustment : adjustment) * step;
    event.preventDefault();
    const nextWidth = commitBrunoTableColumnResize(runtime, column.columnId, width);
    setAnnouncement(`${column.headerName} width ${String(nextWidth)} pixels`);
  };
  const runHeaderMenu = (event: BrunoTableHotkeyGesture): void => {
    if (event.defaultPrevented) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    const directTrigger =
      target?.closest<HTMLButtonElement>("button[data-bruno-column-menu-trigger]") ?? null;
    if (
      directTrigger !== null &&
      gridElement.current?.contains(directTrigger) &&
      isBrunoTableHotkeyWorkflowOwner(directTrigger)
    ) {
      event.preventDefault();
      const column = resolveEventColumn(event);
      if (column !== undefined) navigation.activateHeader(column.columnId);
      requestBrunoTableHotkeyWorkflowAction(directTrigger);
      return;
    }
    if (!ownsGridSurface(event)) return;
    navigation.activateForFocus();
    const active = navigation.getSnapshot();
    if (active?.region !== "header") return;
    const header = [
      ...(gridElement.current?.querySelectorAll<HTMLElement>("th[data-bruno-column-id]") ?? []),
    ].find((candidate) => candidate.dataset["brunoColumnId"] === active.columnId);
    const trigger =
      header?.querySelector<HTMLButtonElement>("button[data-bruno-column-menu-trigger]") ??
      [
        ...(gridElement.current?.querySelectorAll<HTMLButtonElement>(
          '[data-bruno-active-header-menu-trigger=""]',
        ) ?? []),
      ].find(isBrunoTableHotkeyWorkflowOwner);
    if (trigger === undefined || !isBrunoTableHotkeyWorkflowOwner(trigger)) return;
    event.preventDefault();
    requestBrunoTableHotkeyWorkflowAction(trigger);
  };
  const moveWithinEditableRange = (direction: -1 | 1): "moved" | "pending" | "unavailable" => {
    if (cellEdit === undefined || cellRange === undefined) return "unavailable";
    const active = navigation.getSnapshot();
    const range = cellRange.getSnapshot().range;
    if (active?.region !== "body" || active.rowId === undefined || range === undefined)
      return "unavailable";
    if (!cellEdit.isTraversalReady()) return "pending";
    const destination = cellEdit.findRangeTraversalDestination(
      range,
      active.rowId,
      active.columnId,
      direction,
    );
    if (!cellEdit.isTraversalReady()) return "pending";
    if (destination === undefined) return "unavailable";
    navigation.activateBody(destination.rowIndex, destination.rowId, destination.columnId);
    revealCell(destination.rowIndex, destination.columnId, "body", destination.rowId);
    return "moved";
  };
  const runActivation = (
    event: BrunoTableHotkeyGesture,
    intent: "enter" | "f2" | "space",
    alt: boolean,
    shift: boolean,
  ): void => {
    if (!ownsGridSurface(event)) return;
    const grid = gridElement.current;
    const focusedElement = grid?.ownerDocument.activeElement ?? null;
    if (
      isBrunoTableColumnMenuTriggerTarget(grid, event.target) ||
      (grid !== null &&
        isNodeInBrunoTableRealm(grid, focusedElement) &&
        grid.contains(focusedElement) &&
        isBrunoTableColumnMenuTriggerTarget(grid, focusedElement))
    )
      return;
    if (isPointerInteractionActive()) {
      event.preventDefault();
      return;
    }
    navigation.activateForFocus();
    const active = navigation.getSnapshot();
    if (
      intent === "space" &&
      rowSelection !== undefined &&
      active !== undefined &&
      active.region === "body"
    ) {
      event.preventDefault();
      const rowId = active.rowId ?? rowSpace.getRowId(active.rowIndex);
      if (rowId === undefined) return;
      const checked = rowSelection.getRowSnapshot(rowId);
      const result = rowSelection.toggleRow(rowId, !checked, shift);
      if (result.kind === "ignored") return;
      setAnnouncement(
        result.kind === "range" && result.rowCount > 1
          ? `${String(result.rowCount)} rows ${result.checked ? "selected" : "deselected"}, rows ${String(result.startIndex + 1)} through ${String(result.endIndex + 1)}`
          : `Row ${String(active.rowIndex + 1)} ${checked ? "deselected" : "selected"}`,
      );
      return;
    }
    const column = logicalColumns.find((candidate) => candidate.columnId === active?.columnId);
    if (active?.region === "body" && (intent === "enter" || intent === "f2")) {
      if (intent === "enter") {
        const rangeMovement = moveWithinEditableRange(shift ? -1 : 1);
        if (rangeMovement !== "unavailable" || cellEdit?.isTraversalReady() === false) {
          event.preventDefault();
          return;
        }
      }
      if (
        cellEdit !== undefined &&
        active.rowId !== undefined &&
        cellEdit.start(active.rowId, active.columnId)
      ) {
        event.preventDefault();
        return;
      }
      if (column !== undefined && enterInteractiveCell(active, column)) event.preventDefault();
      return;
    }
    if (active?.region !== "header" || column === undefined || intent === "f2") return;
    const command = runtime.getColumnCommandSnapshot(column.columnId);
    const filterable = supportsBrunoTableCustomColumnFilter(column, renderColumnFilter);
    const legacyFilterable = column.kind === "field" && column.enableFilter !== false;
    if (alt && filterable) {
      event.preventDefault();
      if (shift && (command.filterActive || command.filterBaselineAvailable)) {
        toggleHeaderFilter(column.columnId);
      } else {
        openHeaderFilter(column.columnId);
      }
    } else if (alt && legacyFilterable && command.filterBaselineAvailable) {
      event.preventDefault();
      toggleHeaderFilter(column.columnId);
    } else if (command.sortable) {
      event.preventDefault();
      toggleHeaderSort(column.columnId, shift);
    } else if (command.filterActive || command.filterBaselineAvailable) {
      event.preventDefault();
      toggleHeaderFilter(column.columnId);
    } else if (filterable) {
      event.preventDefault();
      openHeaderFilter(column.columnId);
    }
  };
  const moveAfterCellEdit = (
    movement: BrunoTableCellEditMovement,
    origin: BrunoTableCellEditMovementOrigin | undefined,
  ): boolean => {
    if (origin === undefined) return false;
    const currentRowIndex = rowSpace.findRowIndex(origin.rowId);
    const originRowIndex = currentRowIndex ?? origin.retainedRowIndex;
    if (moveWithinEditableRange(movement.endsWith("forward") ? 1 : -1) !== "unavailable")
      return true;
    if (movement === "enter-forward" || movement === "enter-backward") {
      const rowIndex =
        currentRowIndex === undefined
          ? originRowIndex + (movement === "enter-forward" ? 0 : -1)
          : originRowIndex + (movement === "enter-forward" ? 1 : -1);
      const rowId = rowSpace.getRowId(rowIndex);
      if (rowId === undefined) return false;
      navigation.activateBody(rowIndex, rowId, origin.columnId);
      revealCell(rowIndex, origin.columnId, "body", rowId);
      return true;
    }
    if (cellEdit === undefined) return false;
    const direction = movement === "tab-forward" ? 1 : -1;
    const destination =
      currentRowIndex === undefined
        ? cellEdit.findTraversalDestinationFromRowBoundary(originRowIndex, direction)
        : cellEdit.findTraversalDestination(originRowIndex, origin.columnId, direction);
    if (destination === undefined) return false;
    navigation.activateBody(destination.rowIndex, destination.rowId, destination.columnId);
    revealCell(destination.rowIndex, destination.columnId, "body", destination.rowId);
    return true;
  };
  const runEditableTab = (event: BrunoTableHotkeyGesture, direction: -1 | 1): void => {
    if (cellEdit === undefined || !ownsGridSurface(event)) {
      return;
    }
    if (isPointerInteractionActive()) {
      event.preventDefault();
      return;
    }
    if (!cellEdit.isTraversalReady()) {
      event.preventDefault();
      return;
    }
    if (moveWithinEditableRange(direction) !== "unavailable") {
      event.preventDefault();
      return;
    }
    const active = navigation.getSnapshot();
    if (active?.region !== "body") return;
    const destination = cellEdit.findTraversalDestination(
      active.rowIndex,
      active.columnId,
      direction,
    );
    if (destination === undefined) return;
    event.preventDefault();
    navigation.activateBody(destination.rowIndex, destination.rowId, destination.columnId);
    revealCell(destination.rowIndex, destination.columnId, "body", destination.rowId);
  };
  const startReplaceFromProducedText = (producedText: string): boolean => {
    if (cellEdit === undefined || producedText.length === 0 || isPointerInteractionActive()) {
      return false;
    }
    const active = navigation.getSnapshot();
    const column = logicalColumns.find((candidate) => candidate.columnId === active?.columnId);
    if (
      column?.semantics.editorFamily === "boolean" ||
      column?.semantics.editorFamily === "select"
    ) {
      return false;
    }
    return (
      active?.region === "body" &&
      active.rowId !== undefined &&
      cellEdit.start(active.rowId, active.columnId, "replace", producedText)
    );
  };
  const moveAfterCellEditRef = useRef(moveAfterCellEdit);
  const startReplaceFromProducedTextRef = useRef(startReplaceFromProducedText);
  useLayoutEffect(() => {
    moveAfterCellEditRef.current = moveAfterCellEdit;
    startReplaceFromProducedTextRef.current = startReplaceFromProducedText;
  });
  useEffect(
    () =>
      cellEdit === undefined
        ? undefined
        : runtime.registerActiveEditorCommitGate(cellEdit.commitActiveCandidate),
    [cellEdit, runtime],
  );
  useEffect(() => {
    const grid = gridElement.current;
    if (grid === null || cellEdit === undefined) return;
    return installBrunoTableProducedTextEvidence(grid, producedTextCapture.current, (text) =>
      startReplaceFromProducedTextRef.current(text),
    );
  }, [cellEdit]);
  useLayoutEffect(() => {
    const grid = gridElement.current;
    if (grid === null || editMemory === undefined) return;
    const reconcile = (): void => {
      const availability = editMemory.getHotkeyAvailabilitySnapshot();
      grid.setAttribute(
        "aria-keyshortcuts",
        getBrunoTableGridAriaKeyShortcuts({
          copyEnabled,
          pasteEnabled: cellEdit !== undefined && cellRange !== undefined,
          redoEnabled: availability.redo,
          rowSelectionEnabled: rowSelection !== undefined,
          undoEnabled: availability.undo,
        }),
      );
    };
    reconcile();
    return editMemory.subscribeHotkeyAvailability(reconcile);
  }, [cellEdit, cellRange, copyEnabled, editMemory, rowSelection]);
  useLayoutEffect(() => {
    if (cellEdit === undefined) return;
    const reconcileAndScheduleTraversal = () => {
      const buildVersion = traversalBuildVersionRef.current + 1;
      traversalBuildVersionRef.current = buildVersion;
      (traversalQueueRef.current ?? EMPTY_TRAVERSAL_QUEUE).clear();
      if (cellEdit.reconcileTraversal(logicalColumns, rowSpace)) {
        (traversalQueueRef.current ?? EMPTY_TRAVERSAL_QUEUE).addItem(buildVersion);
      }
    };
    reconcileAndScheduleTraversal();
    const unsubscribeTraversalInvalidation = cellEdit.subscribeTraversalInvalidation(
      reconcileAndScheduleTraversal,
    );
    const unsubscribe = runtime.subscribeRowChanges((changedRowIds) => {
      cellEdit.reconcileTraversalRows(changedRowIds);
    });
    return () => {
      unsubscribe();
      unsubscribeTraversalInvalidation();
      traversalBuildVersionRef.current += 1;
      (traversalQueueRef.current ?? EMPTY_TRAVERSAL_QUEUE).clear();
    };
  }, [cellEdit, logicalColumns, rowSpace, runtime]);
  useLayoutEffect(() => {
    if (cellEdit === undefined || cellRange === undefined) {
      cellEdit?.reconcileTraversalRange(undefined);
      return;
    }
    const reconcileRange = () => {
      cellEdit.reconcileTraversalRange(cellRange.getSnapshot().range);
    };
    reconcileRange();
    return cellRange.subscribe(reconcileRange);
  }, [cellEdit, cellRange]);
  useEffect(
    () =>
      cellEdit === undefined
        ? undefined
        : cellEdit.registerMovementCommand((movement, origin) =>
            moveAfterCellEditRef.current(movement, origin),
          ),
    [cellEdit],
  );
  const runSelectAll = (event: BrunoTableHotkeyGesture): void => {
    if (!ownsRowSelectionCommand(event) || rowSelection === undefined) return;
    event.preventDefault();
    const header = rowSelection.getHeaderSnapshot();
    if (header.disabled) return;
    if (header.checked) return;
    rowSelection.toggleAll(true);
    const selectedCount = rowSelection.getHeaderSnapshot().selectedCount;
    setAnnouncement(
      `${String(selectedCount)} matching ${selectedCount === 1 ? "row" : "rows"} selected`,
    );
  };
  useBrunoTableGridHotkeys(gridElement, {
    documentEscapeActive: () =>
      editMemory?.getResetReviewSnapshot().open !== true &&
      (dragFillRuntime?.getSnapshot().active === true ||
        columnGesture.current !== undefined ||
        cellRange?.isPointerGestureActive() === true ||
        cellEdit?.getSessionSnapshot().kind === "editing"),
    escape: (event) => {
      if (editMemory?.getResetReviewSnapshot().open === true) return;
      if (dragFillRuntime?.cancel() === true) {
        event.preventDefault();
        return;
      }
      if (cellRange?.cancelPointerGesture() === true) {
        event.preventDefault();
        return;
      }
      if (columnGesture.current !== undefined) {
        event.preventDefault();
        gestureCancel.current();
        return;
      }
      if (cellEdit?.cancel() === true) {
        event.preventDefault();
        gridElement.current?.focus({ preventScroll: true });
        return;
      }
      const range = cellRange?.getSnapshot().range;
      const active = navigation.getSnapshot();
      if (cellRange !== undefined && range !== undefined && ownsGridSurface(event)) {
        event.preventDefault();
        if (
          active?.region === "body" &&
          active.rowId !== undefined &&
          cellRangeStructure !== undefined
        ) {
          cellRange.replace({ rowId: active.rowId, columnId: active.columnId }, cellRangeStructure);
        } else {
          cellRange.clear();
        }
        return;
      }
      if (event.defaultPrevented) return;
      const grid = gridElement.current;
      if (
        grid !== null &&
        event.target !== grid &&
        isNodeInBrunoTableRealm(grid, event.target) &&
        grid.contains(event.target)
      ) {
        event.preventDefault();
        gestureCancel.current();
        grid.focus({ preventScroll: true });
      }
    },
    tab: runEditableTab,
    shiftTab: (event) => {
      const grid = gridElement.current;
      if (
        grid !== null &&
        event.target !== grid &&
        isNodeInBrunoTableRealm(grid, event.target) &&
        grid.contains(event.target)
      ) {
        yieldGridTabStop(grid);
      }
    },
    headerMenu: runHeaderMenu,
    copy: runCopy,
    ...(cellEdit === undefined ? {} : { paste: runPaste }),
    ...(editMemory === undefined
      ? {}
      : {
          undo: (event: BrunoTableHotkeyGesture) => {
            if (!ownsGridSurface(event)) return;
            if (isPointerInteractionActive()) {
              event.preventDefault();
              return;
            }
            if (!runtime.dispatchGridCommand({ type: "edits.undo" })) return;
            event.preventDefault();
          },
          redo: (event: BrunoTableHotkeyGesture) => {
            if (!ownsGridSurface(event)) return;
            if (isPointerInteractionActive()) {
              event.preventDefault();
              return;
            }
            if (!runtime.dispatchGridCommand({ type: "edits.redo" })) return;
            event.preventDefault();
          },
        }),
    ...(rowSelection === undefined ? {} : { selectAll: runSelectAll }),
    resize: runColumnResize,
    activate: runActivation,
    navigate: runNavigation,
    page: runPageNavigation,
  });
  return (
    <div style={{ position: "relative" }}>
      {editCapability === undefined ? null : (
        <editCapability.TraversalQueueProvider
          callback={enqueueTraversalBuild}
          onQueue={installTraversalQueue}
        />
      )}
      {__BRUNO_TABLE_TEST_DIAGNOSTICS__ ? (
        <BrunoTableGridSurfaceCommitDiagnosticProbe
          commitEvidence={[columns, columnLayout, queryGeneration, rowSpace, viewportSnapshot]}
          tableId={tableId}
        />
      ) : null}
      <BrunoTableHeldShiftHotkeyAdapter />
      <div
        ref={attachGrid}
        data-bruno-scroll-owner=""
        data-bruno-column-layout-version={columnLayout.version}
        role="grid"
        contentEditable={cellEdit === undefined ? undefined : "plaintext-only"}
        suppressContentEditableWarning={cellEdit === undefined ? undefined : true}
        aria-label={gridAriaLabel}
        aria-busy={loading || undefined}
        aria-multiselectable={cellRange === undefined ? undefined : true}
        tabIndex={0}
        aria-rowcount={ariaRowCount ?? rowSpace.totalRows + 1}
        aria-colcount={
          columnWindow.pinnedStart.length +
          columnWindow.centerCount +
          columnWindow.pinnedEnd.length +
          (rowSelection === undefined ? 0 : 1)
        }
        aria-keyshortcuts={
          editMemory === undefined
            ? getBrunoTableGridAriaKeyShortcuts({
                copyEnabled,
                pasteEnabled: cellEdit !== undefined && cellRange !== undefined,
                redoEnabled: false,
                rowSelectionEnabled: rowSelection !== undefined,
                undoEnabled: false,
              })
            : undefined
        }
        onFocus={(event) => {
          if (event.target === event.currentTarget) {
            navigation.activateForFocus();
            armBrunoTableProducedTextCapture(event.currentTarget, producedTextCapture.current);
          }
        }}
        onPointerDown={runCellRangePointerDown}
        onPointerUp={(event) => {
          if (event.currentTarget.ownerDocument.activeElement === event.currentTarget) {
            armBrunoTableProducedTextCapture(event.currentTarget, producedTextCapture.current);
          }
        }}
        style={{
          maxHeight: `min(var(${BRUNO_TABLE_REVIEW_VIEWPORT_MAX_HEIGHT_PROPERTY}, ${BRUNO_TABLE_DEFAULT_VIEWPORT_HEIGHT}px), ${BRUNO_TABLE_DEFAULT_VIEWPORT_HEIGHT}px)`,
          overflow: "auto",
          position: "relative",
        }}
      >
        {cellEdit === undefined ? null : (
          <span
            ref={producedTextCapture}
            aria-hidden="true"
            data-bruno-produced-text-capture=""
            style={VISUALLY_HIDDEN}
          />
        )}
        <NavigationActiveDescendantAdapter
          gridElement={gridElement}
          instanceId={instanceId}
          navigation={navigation}
          runtime={runtime}
          tableId={tableId}
        />
        <span
          ref={attachAnnouncement}
          aria-label="Table interaction status"
          aria-live="polite"
          role="log"
          style={VISUALLY_HIDDEN}
        >
          {announcementMessage}
        </span>
        <div
          ref={attachRowLayer}
          contentEditable={false}
          data-bruno-row-layer=""
          style={{
            position: "relative",
            width: rowSelectionSurfaceWidth(renderedTableWidth, rowSelection),
          }}
        >
          <table
            role="presentation"
            style={{
              tableLayout: "fixed",
              width: rowSelectionSurfaceWidth(renderedTableWidth, rowSelection),
            }}
          >
            <BrunoTableHeaderRow
              attachHeader={attachHeader}
              activateHeaderCommand={activateHeaderCommand}
              announce={setAnnouncement}
              openHeaderFilter={openHeaderFilter}
              toggleHeaderFilter={toggleHeaderFilter}
              toggleHeaderSort={toggleHeaderSort}
              navigation={navigation}
              onColumnPointerDown={onColumnPointerDown}
              onColumnWindowCommitted={advanceReorderGeometryVersion}
              restoreColumnFocus={restoreColumnFocus}
              columnWindow={columnWindow}
              getColumnWindowSnapshot={getColumnWindowSnapshot}
              getHeaderColumnWindowSnapshot={getHeaderColumnWindowSnapshot}
              getHeaderColumnActivitySnapshot={getHeaderColumnActivitySnapshot}
              attachHeaderColumn={attachHeaderColumn}
              instanceId={instanceId}
              renderedTableWidth={renderedTableWidth}
              runtime={runtime}
              tableId={tableId}
              viewportFill={viewportFill}
              renderColumnFilter={renderColumnFilter}
              registerColumnFilterOpener={registerColumnFilterOpener}
              rowSelection={rowSelection}
              subscribeColumnWindow={subscribeColumnWindow}
              subscribeHeaderColumnWindow={subscribeHeaderColumnWindow}
              columnIndexOffset={columnIndexOffset}
            />
            <BrunoTableCenterBodyRows
              activeEditRowId={activeEditRowId}
              attachBodyLayer={attachBodyLayerWithFocusHandoff}
              columnIndexOffset={columnIndexOffset}
              getColumnWindowSnapshot={getColumnWindowSnapshot}
              getBodyRowColumnWindowSnapshot={getBodyRowColumnWindowSnapshot}
              getRowRangeSnapshot={getRowRangeSnapshot}
              instanceId={instanceId}
              pinnedEnd={columnWindow.pinnedEnd}
              pinnedStart={columnWindow.pinnedStart}
              rowSelection={rowSelection}
              rowSpace={rowSpace}
              runtime={runtime}
              subscribeColumnWindow={subscribeColumnWindow}
              subscribeBodyRowColumnWindow={subscribeBodyRowColumnWindow}
              subscribeRowRange={subscribeRowRange}
              subscribeFrameCommit={subscribeFrameCommit}
              tableId={tableId}
              viewportFill={viewportFill}
              width={renderedTableWidth}
            />
          </table>
          {columnWindow.pinnedStart.length > 0 ? (
            <BrunoTablePinnedBodyRegion
              attachBodyLayer={attachBodyLayerWithFocusHandoff}
              columns={columnWindow.pinnedStart}
              getRowRangeSnapshot={getRowRangeSnapshot}
              instanceId={instanceId}
              pinnedStartCount={columnWindow.pinnedStart.length}
              rowSpace={rowSpace}
              runtime={runtime}
              side="start"
              tableId={tableId}
              layerWidth={renderedTableWidth}
              leadingUtilityWidth={rowSelectionWidth}
              columnIndexOffset={columnIndexOffset}
              suppressedRowId={activeEditRowId}
              subscribeRowRange={subscribeRowRange}
            />
          ) : null}
          {columnWindow.pinnedEnd.length > 0 ? (
            <BrunoTablePinnedBodyRegion
              attachBodyLayer={attachBodyLayerWithFocusHandoff}
              columns={columnWindow.pinnedEnd}
              getRowRangeSnapshot={getRowRangeSnapshot}
              instanceId={instanceId}
              pinnedStartCount={columnWindow.pinnedStart.length}
              precedingColumnCount={columnWindow.centerCount}
              rowSpace={rowSpace}
              runtime={runtime}
              side="end"
              tableId={tableId}
              layerWidth={renderedTableWidth}
              leadingUtilityWidth={rowSelectionWidth}
              columnIndexOffset={columnIndexOffset}
              suppressedRowId={activeEditRowId}
              subscribeRowRange={subscribeRowRange}
            />
          ) : null}
          {cellEdit === undefined ? null : (
            <BrunoTableEditOwnedRow
              attachPinnedEditorHost={attachPinnedEditorHost}
              adjustVerticalByLogical={adjustVerticalByLogical}
              columnIndexOffset={columnIndexOffset}
              editRuntime={cellEdit}
              gridElement={gridElement}
              getColumnWindowSnapshot={getColumnWindowSnapshot}
              getRowRangeSnapshot={getRowRangeSnapshot}
              instanceId={instanceId}
              logicalColumns={logicalColumns}
              navigation={navigation}
              pinnedEnd={columnWindow.pinnedEnd}
              pinnedStart={columnWindow.pinnedStart}
              pinnedStartCount={columnWindow.pinnedStart.length}
              rowSelection={rowSelection}
              rowSpace={rowSpace}
              subscribeColumnWindow={subscribeColumnWindow}
              subscribeRowRange={subscribeRowRange}
              tableId={tableId}
              viewRuntime={runtime}
              viewportFill={viewportFill}
              width={renderedTableWidth}
              yieldGridTabStop={yieldGridTabStop}
            />
          )}
        </div>
        <ActiveDescendantOutlet
          allColumns={allColumns}
          announce={setAnnouncement}
          gridElement={gridElement}
          getBodyRowColumnWindowSnapshot={getBodyRowColumnWindowSnapshot}
          getColumnWindowSnapshot={getColumnWindowSnapshot}
          getRowRangeSnapshot={getRowRangeSnapshot}
          instanceId={instanceId}
          logicalColumns={logicalColumns}
          navigation={navigation}
          cellRange={cellRange}
          openHeaderFilter={openHeaderFilter}
          renderColumnFilter={renderColumnFilter}
          restoreColumnFocus={restoreColumnFocus}
          runtime={runtime}
          subscribeBodyRowColumnWindow={subscribeBodyRowColumnWindow}
          subscribeColumnWindow={subscribeColumnWindow}
          subscribeRowRange={subscribeRowRange}
          tableId={tableId}
          visibleColumnIds={visibleColumnIds}
          virtualWindow={virtualWindow}
          columnIndexOffset={columnIndexOffset}
        />
      </div>
      <BrunoTableScrollbarOverlay attach={attachScrollbarOverlay} />
    </div>
  );
});

const BrunoTableScrollbarOverlay = memo(function BrunoTableScrollbarOverlay({
  attach,
}: {
  readonly attach: (element: HTMLElement | null) => void;
}) {
  return (
    <div
      ref={attach}
      aria-hidden="true"
      data-bruno-scrollbar-overlay=""
      style={{ inset: 0, pointerEvents: "none", position: "absolute", zIndex: 8 }}
    >
      <div
        data-bruno-scrollbar-track="horizontal"
        style={{
          background: "color-mix(in srgb, CanvasText 12%, transparent)",
          bottom: "var(--bruno-table-scrollbar-horizontal-bottom, 0px)",
          display: "var(--bruno-table-scrollbar-horizontal-display, none)",
          height: BRUNO_TABLE_SCROLLBAR_TRACK_THICKNESS,
          insetInlineEnd: "var(--bruno-table-scrollbar-horizontal-end, 0px)",
          insetInlineStart: "var(--bruno-table-scrollbar-horizontal-start, 0px)",
          position: "absolute",
        }}
      >
        <div
          data-bruno-scrollbar-thumb="horizontal"
          style={{
            background: "color-mix(in srgb, CanvasText 42%, transparent)",
            borderRadius: 999,
            height: "100%",
            insetInlineStart: 0,
            position: "absolute",
            transform:
              "translate3d(var(--bruno-table-scrollbar-horizontal-thumb-offset, 0px), 0, 0)",
            width: "var(--bruno-table-scrollbar-horizontal-thumb-width, 0px)",
          }}
        />
      </div>
      <div
        data-bruno-scrollbar-track="vertical"
        style={{
          background: "color-mix(in srgb, CanvasText 12%, transparent)",
          bottom: "var(--bruno-table-scrollbar-vertical-bottom, 0px)",
          display: "var(--bruno-table-scrollbar-vertical-display, none)",
          insetInlineEnd: "var(--bruno-table-scrollbar-vertical-right, 0px)",
          position: "absolute",
          top: "var(--bruno-table-scrollbar-vertical-top, 0px)",
          width: BRUNO_TABLE_SCROLLBAR_TRACK_THICKNESS,
        }}
      >
        <div
          data-bruno-scrollbar-thumb="vertical"
          style={{
            background: "color-mix(in srgb, CanvasText 42%, transparent)",
            borderRadius: 999,
            height: "var(--bruno-table-scrollbar-vertical-thumb-height, 0px)",
            insetInlineStart: 0,
            position: "absolute",
            transform: "translate3d(0, var(--bruno-table-scrollbar-vertical-thumb-offset, 0px), 0)",
            width: "100%",
          }}
        />
      </div>
    </div>
  );
});

// Active Cell movement updates the composite attribute without waking the structural grid tree.
const NavigationActiveDescendantAdapter = memo(function NavigationActiveDescendantAdapter({
  gridElement,
  instanceId,
  navigation,
  runtime,
  tableId,
}: {
  readonly gridElement: Readonly<{ current: HTMLDivElement | null }>;
  readonly instanceId: string;
  readonly navigation: BrunoTableNavigationRuntime;
  readonly runtime: BrunoTableRuntimeView;
  readonly tableId: string;
}) {
  useLayoutEffect(() => {
    const synchronize = () => {
      const element = gridElement.current;
      if (element === null) return;
      const activeCell = navigation.getSnapshot();
      const id =
        activeCell === undefined
          ? undefined
          : mountedActiveDomId(instanceId, tableId, activeCell, runtime.getRowSpaceSnapshot());
      if (id === undefined) element.removeAttribute("aria-activedescendant");
      else element.setAttribute("aria-activedescendant", id);
    };
    synchronize();
    const unsubscribeNavigation = navigation.subscribe(synchronize);
    const unsubscribeRows = runtime.subscribeRowSpace(synchronize);
    return () => {
      unsubscribeRows();
      unsubscribeNavigation();
    };
  }, [gridElement, instanceId, navigation, runtime, tableId]);
  return null;
});

const ActiveDescendantOutlet = memo(function ActiveDescendantOutlet({
  allColumns,
  announce,
  gridElement,
  getBodyRowColumnWindowSnapshot,
  getColumnWindowSnapshot,
  getRowRangeSnapshot,
  instanceId,
  logicalColumns,
  navigation,
  cellRange,
  openHeaderFilter,
  renderColumnFilter,
  restoreColumnFocus,
  runtime,
  subscribeBodyRowColumnWindow,
  subscribeColumnWindow,
  subscribeRowRange,
  tableId,
  visibleColumnIds,
  virtualWindow,
  columnIndexOffset,
}: {
  readonly allColumns: readonly CompiledColumn[];
  readonly announce: (message: string) => void;
  readonly gridElement: Readonly<{ current: HTMLDivElement | null }>;
  readonly getBodyRowColumnWindowSnapshot: (
    logicalRowIndex: number,
  ) => BrunoTableBodyColumnWindowSnapshot;
  readonly getColumnWindowSnapshot: () => BrunoTableBodyColumnWindowSnapshot;
  readonly getRowRangeSnapshot: () => BrunoTableRowRangeSnapshot;
  readonly instanceId: string;
  readonly logicalColumns: readonly CompiledColumn[];
  readonly navigation: BrunoTableNavigationRuntime;
  readonly cellRange?: BrunoTableCellRangeRuntime | undefined;
  readonly openHeaderFilter: (columnId: string) => void;
  readonly renderColumnFilter?: BrunoTableColumnFilterRenderer | undefined;
  readonly restoreColumnFocus: (columnId: string) => void;
  readonly runtime: BrunoTableRuntimeView;
  readonly subscribeBodyRowColumnWindow: (
    logicalRowIndex: number,
    listener: () => void,
  ) => () => void;
  readonly subscribeColumnWindow: (listener: () => void) => () => void;
  readonly subscribeRowRange: (listener: () => void) => () => void;
  readonly tableId: string;
  readonly visibleColumnIds: readonly string[];
  readonly virtualWindow: BrunoTableViewportSnapshot["virtualWindow"];
  readonly columnIndexOffset: number;
}) {
  const cellEdit = useContext(BrunoTableCellEditContext);
  const editSession = useSyncExternalStore(
    cellEdit?.subscribeSession ?? subscribeNoCellEditSession,
    cellEdit?.getSessionSnapshot ?? getNoCellEditSession,
    cellEdit?.getSessionSnapshot ?? getNoCellEditSession,
  );
  const activeCell = useSyncExternalStore(
    navigation.subscribe,
    navigation.getSnapshot,
    navigation.getSnapshot,
  );
  const activeBodyRowIndex = activeCell?.region === "body" ? activeCell.rowIndex : -1;
  const activeHeader = activeCell?.region === "header";
  const subscribeActiveHeaderWindow = useMemo(
    () => (activeHeader ? subscribeColumnWindow : subscribeInactiveBodyColumnWindow),
    [activeHeader, subscribeColumnWindow],
  );
  const getActiveHeaderWindowSnapshot = useMemo(
    () => (activeHeader ? getColumnWindowSnapshot : getInactiveBodyColumnWindow),
    [activeHeader, getColumnWindowSnapshot],
  );
  const headerColumnWindow = useSyncExternalStore(
    subscribeActiveHeaderWindow,
    getActiveHeaderWindowSnapshot,
    getActiveHeaderWindowSnapshot,
  );
  const subscribeActiveBodyWindow = useMemo(
    () => (listener: () => void) =>
      activeBodyRowIndex < 0
        ? subscribeInactiveBodyColumnWindow(listener)
        : subscribeBodyRowColumnWindow(activeBodyRowIndex, listener),
    [activeBodyRowIndex, subscribeBodyRowColumnWindow],
  );
  const getActiveBodyWindowSnapshot = useMemo(
    () => () =>
      activeBodyRowIndex < 0
        ? getInactiveBodyColumnWindow()
        : getBodyRowColumnWindowSnapshot(activeBodyRowIndex),
    [activeBodyRowIndex, getBodyRowColumnWindowSnapshot],
  );
  const activeBodyWindow = useSyncExternalStore(
    subscribeActiveBodyWindow,
    getActiveBodyWindowSnapshot,
    getActiveBodyWindowSnapshot,
  );
  const rowRange = useSyncExternalStore(
    subscribeRowRange,
    getRowRangeSnapshot,
    getRowRangeSnapshot,
  );
  if (activeCell === undefined) return null;
  const effectiveActiveCenter =
    activeCell.region === "body" ? activeBodyWindow.center : headerColumnWindow.center;
  const activePreparedStage =
    activeCell.region === "body" && activeBodyWindow.preparedCenter !== undefined
      ? (() => {
          const preparedIndex = activeBodyWindow.preparedCenter.findIndex(
            (column) => column.columnId === activeCell.columnId,
          );
          return preparedIndex < 0 || activeBodyWindow.preparedCenterStartIndex === undefined
            ? undefined
            : preparedColumnStage(
                activeBodyWindow,
                activeBodyWindow.preparedCenterStartIndex + preparedIndex,
              );
        })()
      : undefined;
  const activeColumnMounted =
    [virtualWindow.pinnedStart, effectiveActiveCenter, virtualWindow.pinnedEnd].some((columns) =>
      columns.some((column) => column.columnId === activeCell.columnId),
    ) && activePreparedStage === undefined;
  const activeRowMounted =
    activeCell.region === "header" ||
    (activeCell.rowIndex >= rowRange.rowStart && activeCell.rowIndex < rowRange.rowEnd);
  const activeCellOwnedByEdit =
    activeCell.region === "body" &&
    activeCell.rowId !== undefined &&
    editSession.kind === "editing" &&
    editSession.rowId === activeCell.rowId &&
    editSession.columnId === activeCell.columnId;
  const ownershipKey = activeCell.region === "body" ? activeBodyWindow : headerColumnWindow;
  if (activeCell.region === "header" && !activeColumnMounted) {
    return (
      <ActiveHeaderMenuProxy
        activeCell={activeCell}
        announce={announce}
        allColumns={allColumns}
        visibleColumnIds={visibleColumnIds}
        column={logicalColumns.find((column) => column.columnId === activeCell.columnId)}
        columnIndex={offsetLogicalColumnIndex(
          logicalColumns.findIndex((column) => column.columnId === activeCell.columnId),
          columnIndexOffset,
        )}
        gridElement={gridElement}
        instanceId={instanceId}
        openHeaderFilter={openHeaderFilter}
        renderColumnFilter={renderColumnFilter}
        restoreColumnFocus={restoreColumnFocus}
        runtime={runtime}
        tableId={tableId}
        ownerRowIndex={1}
        ownershipKey={ownershipKey}
      />
    );
  }
  if (activeCellOwnedByEdit || (activeColumnMounted && activeRowMounted)) return null;
  return (
    <ActiveDescendantProxy
      activeCell={activeCell}
      cellRange={cellRange}
      column={logicalColumns.find((column) => column.columnId === activeCell.columnId)}
      columnIndex={offsetLogicalColumnIndex(
        logicalColumns.findIndex((column) => column.columnId === activeCell.columnId),
        columnIndexOffset,
      )}
      gridElement={gridElement}
      instanceId={instanceId}
      ownerRowIndex={activeRowMounted ? activeCell.rowIndex + 2 : undefined}
      ownershipKey={ownershipKey}
      renderColumnFilter={renderColumnFilter}
      runtime={runtime}
      tableId={tableId}
    />
  );
});

type BrunoTableMenuFilterTransfer = Readonly<{
  closeMenu: (preserveFocus?: boolean) => void;
  consumeFocusRestore: () => boolean;
  onOpenChange: (nextOpen: boolean) => void;
  openHeaderFilterFromMenu: (columnId: string) => void;
}>;

function useBrunoTableMenuFilterTransfer({
  columnId,
  onOpen,
  openHeaderFilter,
  restoreFocus,
  restoreColumnFocus,
  setOpen,
}: {
  readonly columnId: string;
  readonly onOpen?: () => void;
  readonly openHeaderFilter: (columnId: string) => void;
  readonly restoreFocus?: () => void;
  readonly restoreColumnFocus: (columnId: string) => void;
  readonly setOpen: (open: boolean) => void;
}): BrunoTableMenuFilterTransfer {
  const menuFilterTransfer = useRef(false);
  const menuFocusRestore = useRef(false);
  const openHeaderFilterFromMenu = useCallback(
    (nextColumnId: string): void => {
      menuFilterTransfer.current = true;
      openHeaderFilter(nextColumnId);
    },
    [openHeaderFilter],
  );
  const closeMenu = useCallback(
    (preserveFocus = false): void => {
      if (preserveFocus) menuFilterTransfer.current = true;
      setOpen(false);
    },
    [setOpen],
  );
  const onOpenChange = useCallback(
    (nextOpen: boolean): void => {
      if (nextOpen) onOpen?.();
      setOpen(nextOpen);
      if (!nextOpen) {
        const transferred = menuFilterTransfer.current;
        menuFilterTransfer.current = false;
        menuFocusRestore.current = !transferred;
        if (!transferred) {
          restoreColumnFocus(columnId);
          restoreFocus?.();
        }
      }
    },
    [columnId, onOpen, restoreColumnFocus, restoreFocus, setOpen],
  );
  const consumeFocusRestore = useCallback((): boolean => {
    const restore = menuFocusRestore.current;
    menuFocusRestore.current = false;
    return restore;
  }, []);
  return { closeMenu, consumeFocusRestore, onOpenChange, openHeaderFilterFromMenu };
}

const BrunoTableOpenColumnMenu = memo(function BrunoTableOpenColumnMenu({
  announce,
  columnId,
  direction,
  groupBy,
  instanceId,
  onClosed,
  open,
  openHeaderFilter,
  restoreMenuFocus,
  restoreColumnFocus,
  renderColumnFilter,
  runtime,
  setOpen,
  triggerElement,
  tableId,
}: {
  readonly announce: (message: string) => void;
  readonly columnId: string;
  readonly direction: "ltr" | "rtl";
  readonly groupBy: readonly string[];
  readonly instanceId: string;
  readonly onClosed: () => void;
  readonly open: boolean;
  readonly openHeaderFilter: (columnId: string) => void;
  readonly restoreMenuFocus: () => void;
  readonly restoreColumnFocus: (columnId: string) => void;
  readonly renderColumnFilter?: BrunoTableColumnFilterRenderer | undefined;
  readonly runtime: BrunoTableRuntimeView;
  readonly setOpen: (open: boolean) => void;
  readonly triggerElement: HTMLButtonElement;
  readonly tableId: string;
}) {
  const layout = useSyncExternalStore(
    runtime.subscribeColumnLayout,
    runtime.getColumnLayoutSnapshot,
    runtime.getColumnLayoutSnapshot,
  );
  const grouping = useSyncExternalStore(
    runtime.subscribeInstalledGroupingStructure,
    runtime.getInstalledGroupingStructureSnapshot,
    runtime.getInstalledGroupingStructureSnapshot,
  );
  const column = (grouping.columns ?? layout.columns).find(
    (candidate) => candidate.columnId === columnId,
  );
  useLayoutEffect(() => {
    if (column === undefined) {
      setOpen(false);
      onClosed();
    }
  }, [column, onClosed, setOpen]);
  const subscribe = useMemo(
    () => (listener: () => void) => runtime.subscribeColumnCommands(columnId, listener),
    [columnId, runtime],
  );
  const getSnapshot = useMemo(
    () => () => runtime.getColumnCommandSnapshot(columnId),
    [columnId, runtime],
  );
  const command = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const menuTriggerId = headerDomId(instanceId, tableId, "shared-menu-proxy");
  const finalFocusTarget = useMemo(() => ({ current: triggerElement }), [triggerElement]);
  const { closeMenu, consumeFocusRestore, onOpenChange, openHeaderFilterFromMenu } =
    useBrunoTableMenuFilterTransfer({
      columnId,
      openHeaderFilter,
      restoreFocus: () => {
        if (triggerElement.isConnected) restoreMenuFocus();
      },
      restoreColumnFocus,
      setOpen,
    });
  if (column === undefined) return null;
  return (
    <DirectionProvider direction={direction}>
      <DropdownMenu
        open={open}
        onOpenChange={onOpenChange}
        onOpenChangeComplete={(nextOpen) => {
          if (!nextOpen) {
            const activeElement = triggerElement.ownerDocument.activeElement;
            const grid = triggerElement.closest('[role="grid"]');
            if (
              consumeFocusRestore() &&
              triggerElement.isConnected &&
              (activeElement === triggerElement ||
                activeElement === triggerElement.ownerDocument.body ||
                (activeElement === grid &&
                  grid?.getAttribute("aria-activedescendant") ===
                    headerDomId(instanceId, tableId, columnId)))
            ) {
              restoreMenuFocus();
            }
            onClosed();
          }
        }}
        triggerId={menuTriggerId}
      >
        <DropdownMenuTrigger
          aria-hidden="true"
          id={menuTriggerId}
          style={VISUALLY_HIDDEN}
          tabIndex={-1}
        />
        <ColumnManagementMenu
          allColumns={layout.allColumns}
          announce={announce}
          closeMenu={closeMenu}
          column={column}
          command={command}
          direction={direction}
          finalFocusTarget={finalFocusTarget}
          groupBy={groupBy}
          openHeaderFilter={openHeaderFilterFromMenu}
          renderColumnFilter={renderColumnFilter}
          restoreColumnFocus={restoreColumnFocus}
          runtime={runtime}
          menuAnchor={triggerElement}
          menuId={headerDomId(instanceId, tableId, "shared-menu-popup")}
          visibleColumnIds={layout.visibleColumnIds}
        />
      </DropdownMenu>
    </DirectionProvider>
  );
});

const ActiveHeaderMenuProxy = memo(function ActiveHeaderMenuProxy({
  allColumns,
  activeCell,
  announce,
  column,
  columnIndex,
  gridElement,
  instanceId,
  openHeaderFilter,
  restoreColumnFocus,
  renderColumnFilter,
  runtime,
  tableId,
  ownerRowIndex,
  ownershipKey,
  visibleColumnIds,
}: {
  readonly allColumns: readonly CompiledColumn[];
  readonly activeCell: BrunoTableActiveCell;
  readonly announce: (message: string) => void;
  readonly column: CompiledColumn | undefined;
  readonly columnIndex: number;
  readonly gridElement: Readonly<{ current: HTMLDivElement | null }>;
  readonly instanceId: string;
  readonly openHeaderFilter: (columnId: string) => void;
  readonly restoreColumnFocus: (columnId: string) => void;
  readonly renderColumnFilter?: BrunoTableColumnFilterRenderer | undefined;
  readonly runtime: BrunoTableRuntimeView;
  readonly tableId: string;
  readonly ownerRowIndex: number;
  readonly ownershipKey: object;
  readonly visibleColumnIds: readonly string[];
}) {
  const [open, setOpen] = useState(false);
  const [menuDirection, setMenuDirection] = useState<"ltr" | "rtl">("ltr");
  const { closeMenu, onOpenChange, openHeaderFilterFromMenu } = useBrunoTableMenuFilterTransfer({
    columnId: column?.columnId ?? "",
    onOpen: () => setMenuDirection(readBrunoTableMenuDirection()),
    openHeaderFilter,
    restoreColumnFocus,
    setOpen,
  });
  const columnId = column?.columnId ?? "";
  const subscribe = useMemo(
    () => (listener: () => void) => runtime.subscribeColumnCommands(columnId, listener),
    [columnId, runtime],
  );
  const getSnapshot = useMemo(
    () => () => runtime.getColumnCommandSnapshot(columnId),
    [columnId, runtime],
  );
  const command = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const groupingStructure = useSyncExternalStore(
    runtime.subscribeInstalledGroupingStructure,
    runtime.getInstalledGroupingStructureSnapshot,
    runtime.getInstalledGroupingStructureSnapshot,
  );
  const groupBy = groupingStructure.groupBy;
  const menuTriggerId = headerDomId(instanceId, tableId, `${columnId}-menu-proxy`);
  const attachMenuHotkeyWorkflow = useBrunoTableHotkeyWorkflowAction(() => {
    if (column !== undefined) {
      setMenuDirection(readBrunoTableMenuDirection());
      setOpen(true);
    }
  });
  if (column === undefined) return null;
  return (
    <>
      <ActiveDescendantProxy
        activeCell={activeCell}
        column={column}
        columnIndex={columnIndex}
        gridElement={gridElement}
        instanceId={instanceId}
        ownerRowIndex={ownerRowIndex}
        ownershipKey={ownershipKey}
        renderColumnFilter={renderColumnFilter}
        runtime={runtime}
        tableId={tableId}
      />
      <DirectionProvider direction={menuDirection}>
        <DropdownMenu
          open={open}
          onOpenChange={onOpenChange}
          triggerId={open ? menuTriggerId : null}
        >
          <DropdownMenuTrigger
            ref={attachMenuHotkeyWorkflow}
            aria-label={`Column menu for ${column.headerName}`}
            aria-keyshortcuts="Shift+F10 ContextMenu"
            data-bruno-active-header-menu-trigger=""
            data-bruno-column-menu-trigger={column.columnId}
            id={menuTriggerId}
            style={VISUALLY_HIDDEN}
            tabIndex={-1}
          />
          {open ? (
            <ColumnManagementMenu
              allColumns={allColumns}
              announce={announce}
              closeMenu={closeMenu}
              column={column}
              command={command}
              direction={menuDirection}
              groupBy={groupBy}
              openHeaderFilter={openHeaderFilterFromMenu}
              preventMenuFinalFocus
              renderColumnFilter={renderColumnFilter}
              restoreColumnFocus={restoreColumnFocus}
              runtime={runtime}
              visibleColumnIds={visibleColumnIds}
            />
          ) : null}
        </DropdownMenu>
      </DirectionProvider>
    </>
  );
});

const BrunoTableRowSelectionHeaderCell = memo(function BrunoTableRowSelectionHeaderCell({
  selection,
  tableId,
}: {
  readonly selection: BrunoTableRowSelectionRuntime;
  readonly tableId: string;
}) {
  const checkbox = useRef<HTMLSpanElement | null>(null);
  const snapshot = useSyncExternalStore(
    selection.subscribeHeader,
    selection.getHeaderSnapshot,
    selection.getHeaderSnapshot,
  );
  useLayoutEffect(() => {
    const element = checkbox.current;
    if (!snapshot.disabled || element === null || element.ownerDocument.activeElement !== element) {
      return;
    }
    element.closest<HTMLElement>('[role="grid"]')?.focus({ preventScroll: true });
  }, [snapshot.disabled]);
  return (
    <th
      aria-colindex={1}
      data-bruno-column-id={BRUNO_TABLE_ROW_SELECTION_COLUMN_ID}
      role="columnheader"
      scope="col"
      style={rowSelectionCellStyle(6)}
    >
      {__BRUNO_TABLE_TEST_DIAGNOSTICS__ ? (
        <BrunoTableRowSelectionCommitDiagnosticProbe commitEvidence={snapshot} tableId={tableId} />
      ) : null}
      <Checkbox
        ref={checkbox}
        aria-label="Select all rows"
        aria-keyshortcuts="Control+A Meta+A"
        checked={snapshot.checked}
        data-bruno-row-selection-checkbox=""
        disabled={snapshot.disabled}
        indeterminate={snapshot.mixed}
        onClick={() => selection.toggleAll(!snapshot.checked)}
        onPointerDown={(event) => event.stopPropagation()}
        tabIndex={-1}
      />
    </th>
  );
});

type BrunoTableHeaderMenuSession = Readonly<{
  readonly columnId: string;
  readonly direction: "ltr" | "rtl";
  readonly triggerElement: HTMLButtonElement;
}>;

const BrunoTableHeaderColumnWindowCommitBoundary = memo(
  function BrunoTableHeaderColumnWindowCommitBoundary({
    getSnapshot,
    onCommitted,
    subscribe,
  }: {
    readonly getSnapshot: () => BrunoTableBodyColumnWindowSnapshot;
    readonly onCommitted: () => void;
    readonly subscribe: (listener: () => void) => () => void;
  }) {
    useLayoutEffect(() => {
      onCommitted();
      return subscribe(() => {
        onCommitted();
      });
    }, [getSnapshot, onCommitted, subscribe]);
    return null;
  },
);

const BrunoTableHeaderPaddingCell = memo(function BrunoTableHeaderPaddingCell({
  padding,
}: {
  readonly padding: number;
}) {
  return <th aria-hidden="true" style={{ padding: 0, width: padding }} />;
});

const BrunoTableHeaderRow = memo(function BrunoTableHeaderRow(props: {
  readonly attachHeader: (element: HTMLElement | null) => void;
  readonly activateHeaderCommand: (columnId: string) => void;
  readonly announce: (message: string) => void;
  readonly navigation: BrunoTableNavigationRuntime;
  readonly onColumnPointerDown: (
    event: ReactPointerEvent<HTMLElement>,
    column: CompiledColumn,
    kind: "resize" | "reorder",
  ) => void;
  readonly onColumnWindowCommitted: () => void;
  readonly openHeaderFilter: (columnId: string) => void;
  readonly restoreColumnFocus: (columnId: string) => void;
  readonly toggleHeaderFilter: (columnId: string) => void;
  readonly toggleHeaderSort: (columnId: string, multi: boolean) => void;
  readonly columnWindow: BrunoTableColumnWindow;
  readonly getColumnWindowSnapshot: () => BrunoTableBodyColumnWindowSnapshot;
  readonly getHeaderColumnWindowSnapshot: () => BrunoTableBodyColumnWindowSnapshot;
  readonly getHeaderColumnActivitySnapshot: (columnId: string) => boolean;
  readonly attachHeaderColumn: (columnId: string, element: HTMLElement | null) => void;
  readonly instanceId: string;
  readonly renderedTableWidth: number;
  readonly runtime: BrunoTableRuntimeView;
  readonly renderColumnFilter?: BrunoTableColumnFilterRenderer | undefined;
  readonly registerColumnFilterOpener: (columnId: string, open: () => void) => () => void;
  readonly tableId: string;
  readonly viewportFill: number;
  readonly rowSelection?: BrunoTableRowSelectionRuntime | undefined;
  readonly subscribeColumnWindow: (listener: () => void) => () => void;
  readonly subscribeHeaderColumnWindow: (listener: () => void) => () => void;
  readonly columnIndexOffset: number;
}) {
  const attachHeader = props.attachHeader;
  const attachHeaderElement = useCallback(
    (element: HTMLElement | null) => attachHeader(element),
    [attachHeader],
  );
  const {
    activateHeaderCommand,
    announce,
    navigation,
    onColumnPointerDown,
    onColumnWindowCommitted,
    openHeaderFilter,
    restoreColumnFocus,
    toggleHeaderFilter,
    toggleHeaderSort,
    columnWindow: baseColumnWindow,
    getColumnWindowSnapshot,
    getHeaderColumnWindowSnapshot,
    getHeaderColumnActivitySnapshot,
    attachHeaderColumn,
    instanceId,
    renderedTableWidth,
    runtime,
    renderColumnFilter,
    registerColumnFilterOpener,
    tableId,
    viewportFill,
    rowSelection,
    subscribeColumnWindow,
    subscribeHeaderColumnWindow,
    columnIndexOffset,
  } = props;
  const headerCenterWindow = useSyncExternalStore(
    subscribeHeaderColumnWindow,
    getHeaderColumnWindowSnapshot,
    getHeaderColumnWindowSnapshot,
  );
  const columnWindow = baseColumnWindow;
  const groupingStructure = useSyncExternalStore(
    runtime.subscribeInstalledGroupingStructure,
    runtime.getInstalledGroupingStructureSnapshot,
    runtime.getInstalledGroupingStructureSnapshot,
  );
  const groupBy = groupingStructure.groupBy;
  const [menuSession, setMenuSession] = useState<BrunoTableHeaderMenuSession>();
  const [menuOpen, setMenuOpen] = useState(false);
  const openColumnMenu = useCallback(
    (columnId: string, triggerElement: HTMLButtonElement): void => {
      setMenuSession({
        columnId,
        direction: readBrunoTableMenuDirection(triggerElement),
        triggerElement,
      });
      setMenuOpen(true);
    },
    [],
  );
  const pinnedHeaderColumnIds = useMemo(
    () =>
      new Set<string>([
        ...columnWindow.pinnedStart.map((column) => column.columnId),
        ...columnWindow.pinnedEnd.map((column) => column.columnId),
      ]),
    [columnWindow.pinnedEnd, columnWindow.pinnedStart],
  );
  const isHeaderColumnActive = useCallback(
    (columnId: string) =>
      pinnedHeaderColumnIds.has(columnId) || getHeaderColumnActivitySnapshot(columnId),
    [getHeaderColumnActivitySnapshot, pinnedHeaderColumnIds],
  );
  const pinnedStartStyles = useMemo(
    () =>
      columnWindow.pinnedStart.map((_column, index) =>
        pinnedCellStyle(
          "start",
          columnWindow.pinnedStart,
          index,
          rowSelection === undefined ? 0 : ROW_SELECTION_COLUMN_WIDTH,
        ),
      ),
    [columnWindow.pinnedStart, rowSelection],
  );
  const pinnedEndStyles = useMemo(
    () =>
      columnWindow.pinnedEnd.map((_column, index) =>
        pinnedCellStyle("end", columnWindow.pinnedEnd, index),
      ),
    [columnWindow.pinnedEnd],
  );
  return (
    <thead
      ref={attachHeaderElement}
      role="rowgroup"
      style={{
        background: "Canvas",
        position: "sticky",
        top: 0,
        width: rowSelectionSurfaceWidth(renderedTableWidth, rowSelection),
        zIndex: 4,
      }}
    >
      <tr aria-rowindex={1} role="row" style={{ height: ROW_HEIGHT, maxHeight: ROW_HEIGHT }}>
        {rowSelection === undefined ? null : (
          <BrunoTableRowSelectionHeaderCell selection={rowSelection} tableId={tableId} />
        )}
        <BrunoTableHeaderColumnWindowCommitBoundary
          getSnapshot={getColumnWindowSnapshot}
          onCommitted={onColumnWindowCommitted}
          subscribe={subscribeColumnWindow}
        />
        {__BRUNO_TABLE_TEST_DIAGNOSTICS__ ? (
          <BrunoTableHeaderCommitDiagnosticProbe
            commitEvidence={{ props, headerCenterWindow, groupingStructure, menuSession, menuOpen }}
            tableId={tableId}
          />
        ) : null}
        {columnWindow.pinnedStart.map((column, index) => (
          <BrunoTableHeaderCell
            key={column.columnId}
            pinned="start"
            activateHeaderForResize={navigation.activateHeader}
            navigation={navigation}
            instanceId={instanceId}
            tableId={tableId}
            columnIndex={columnIndexOffset + index}
            column={column}
            groupBy={groupBy}
            runtime={runtime}
            renderColumnFilter={renderColumnFilter}
            registerColumnFilterOpener={registerColumnFilterOpener}
            activateHeaderCommand={activateHeaderCommand}
            toggleHeaderFilter={toggleHeaderFilter}
            toggleHeaderSort={toggleHeaderSort}
            onColumnPointerDown={onColumnPointerDown}
            openColumnMenu={openColumnMenu}
            restoreColumnFocus={restoreColumnFocus}
            style={pinnedStartStyles[index]!}
            menuOpen={menuOpen && menuSession?.columnId === column.columnId}
          />
        ))}
        {columnWindow.centerCount > 0 ? (
          <BrunoTableHeaderPaddingCell padding={headerCenterWindow.leftPadding} />
        ) : null}
        {headerCenterWindow.center.map((column, index) => (
          <BrunoTableHeaderCell
            key={column.columnId}
            attachHeaderColumn={attachHeaderColumn}
            getActiveInColumnWindowSnapshot={getHeaderColumnActivitySnapshot}
            activateHeaderForResize={navigation.activateHeader}
            navigation={navigation}
            instanceId={instanceId}
            tableId={tableId}
            columnIndex={
              columnIndexOffset +
              columnWindow.pinnedStart.length +
              headerCenterWindow.centerStartIndex +
              index
            }
            column={column}
            groupBy={groupBy}
            runtime={runtime}
            renderColumnFilter={renderColumnFilter}
            registerColumnFilterOpener={registerColumnFilterOpener}
            activateHeaderCommand={activateHeaderCommand}
            toggleHeaderFilter={toggleHeaderFilter}
            toggleHeaderSort={toggleHeaderSort}
            onColumnPointerDown={onColumnPointerDown}
            openColumnMenu={openColumnMenu}
            restoreColumnFocus={restoreColumnFocus}
            menuOpen={menuOpen && menuSession?.columnId === column.columnId}
          />
        ))}
        {columnWindow.centerCount > 0 ? (
          <BrunoTableHeaderPaddingCell padding={headerCenterWindow.rightPadding} />
        ) : null}
        {columnWindow.pinnedEnd.length > 0 ? (
          <th
            aria-hidden="true"
            style={{
              padding: 0,
              width: rowSelectionViewportFillWidth(viewportFill, rowSelection),
            }}
          />
        ) : null}
        {columnWindow.pinnedEnd.map((column, index) => (
          <BrunoTableHeaderCell
            key={column.columnId}
            pinned="end"
            activateHeaderForResize={navigation.activateHeader}
            navigation={navigation}
            instanceId={instanceId}
            tableId={tableId}
            columnIndex={
              columnIndexOffset + columnWindow.pinnedStart.length + columnWindow.centerCount + index
            }
            column={column}
            groupBy={groupBy}
            runtime={runtime}
            renderColumnFilter={renderColumnFilter}
            registerColumnFilterOpener={registerColumnFilterOpener}
            activateHeaderCommand={activateHeaderCommand}
            toggleHeaderFilter={toggleHeaderFilter}
            toggleHeaderSort={toggleHeaderSort}
            onColumnPointerDown={onColumnPointerDown}
            openColumnMenu={openColumnMenu}
            restoreColumnFocus={restoreColumnFocus}
            style={pinnedEndStyles[index]!}
            menuOpen={menuOpen && menuSession?.columnId === column.columnId}
          />
        ))}
        <th aria-hidden="true" style={{ padding: 0, width: 0 }}>
          {menuSession === undefined ? null : (
            <BrunoTableOpenColumnMenu
              announce={announce}
              columnId={menuSession.columnId}
              direction={menuSession.direction}
              groupBy={groupBy}
              instanceId={instanceId}
              onClosed={() => {
                if (!menuOpen) setMenuSession(undefined);
              }}
              open={menuOpen}
              openHeaderFilter={openHeaderFilter}
              renderColumnFilter={renderColumnFilter}
              restoreColumnFocus={restoreColumnFocus}
              restoreMenuFocus={() => {
                if (
                  menuSession.triggerElement.isConnected &&
                  isHeaderColumnActive(menuSession.columnId)
                ) {
                  menuSession.triggerElement.focus({ preventScroll: true });
                }
              }}
              runtime={runtime}
              setOpen={setMenuOpen}
              tableId={tableId}
              triggerElement={menuSession.triggerElement}
            />
          )}
        </th>
      </tr>
    </thead>
  );
});

const BrunoTableRowSelectionCell = memo(function BrunoTableRowSelectionCell({
  id,
  logicalRowIndex,
  rowId,
  selection,
  tableId,
}: {
  readonly id?: string | undefined;
  readonly logicalRowIndex: number;
  readonly rowId: string;
  readonly selection: BrunoTableRowSelectionRuntime;
  readonly tableId: string;
}) {
  const subscribe = useMemo(
    () => (listener: () => void) => selection.subscribeRow(rowId, listener),
    [rowId, selection],
  );
  const getSnapshot = useMemo(() => () => selection.getRowSnapshot(rowId), [rowId, selection]);
  const checked = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return (
    <td
      id={id}
      aria-colindex={1}
      data-bruno-column-id={BRUNO_TABLE_ROW_SELECTION_COLUMN_ID}
      data-bruno-row-id={rowId}
      role="gridcell"
      style={rowSelectionCellStyle(5)}
    >
      {__BRUNO_TABLE_TEST_DIAGNOSTICS__ ? (
        <BrunoTableRowSelectionCommitDiagnosticProbe
          commitEvidence={checked}
          rowId={rowId}
          tableId={tableId}
        />
      ) : null}
      <Checkbox
        aria-label={`Select row ${String(logicalRowIndex + 1)}`}
        checked={checked}
        data-bruno-row-selection-checkbox=""
        onClick={(event) =>
          selection.toggleRow(rowId, !checked, event.detail > 0 && isBrunoTableHotkeyHeld("Shift"))
        }
        onPointerDown={(event) => event.stopPropagation()}
        tabIndex={-1}
      />
    </td>
  );
});

const BrunoTableRowSelectionLoadingCell = memo(function BrunoTableRowSelectionLoadingCell() {
  return (
    <td
      aria-colindex={1}
      aria-label="Row selection loading"
      data-bruno-column-id={BRUNO_TABLE_ROW_SELECTION_COLUMN_ID}
      role="gridcell"
      style={rowSelectionCellStyle(5)}
    >
      <Skeleton aria-hidden="true" className="size-4" />
    </td>
  );
});

function rowSelectionCellStyle(zIndex: number): CSSProperties {
  return {
    alignItems: "center",
    background: "Canvas",
    display: "flex",
    height: ROW_HEIGHT,
    insetInlineStart: 0,
    justifyContent: "center",
    padding: 0,
    position: "sticky",
    width: ROW_SELECTION_COLUMN_WIDTH,
    zIndex,
  };
}

function rowSelectionSurfaceWidth(
  fallbackWidth: number,
  selection: BrunoTableRowSelectionRuntime | undefined,
): string {
  return surfaceWidthWithUtility(
    fallbackWidth,
    selection === undefined ? 0 : ROW_SELECTION_COLUMN_WIDTH,
  );
}

function surfaceWidthWithUtility(fallbackWidth: number, utilityWidth: number): string {
  const liveWidth = `var(${BRUNO_TABLE_LIVE_TOTAL_WIDTH_CSS_VARIABLE}, ${String(fallbackWidth)}px)`;
  return utilityWidth === 0 ? liveWidth : `calc(${liveWidth} + ${String(utilityWidth)}px)`;
}

function rowSelectionViewportFillWidth(
  fallbackWidth: number,
  _selection: BrunoTableRowSelectionRuntime | undefined,
): string {
  const liveWidth = `var(${BRUNO_TABLE_LIVE_VIEWPORT_FILL_CSS_VARIABLE}, ${String(fallbackWidth)}px)`;
  return liveWidth;
}

function offsetLogicalColumnIndex(index: number, offset: number): number {
  return index < 0 ? index : index + offset;
}

const BrunoTableHeaderCell = memo(function BrunoTableHeaderCell({
  attachHeaderColumn,
  getActiveInColumnWindowSnapshot,
  menuOpen = false,
  activateHeaderCommand,
  activateHeaderForResize,
  onColumnPointerDown,
  openColumnMenu,
  restoreColumnFocus,
  toggleHeaderFilter,
  toggleHeaderSort,
  instanceId,
  tableId,
  columnIndex,
  column,
  groupBy,
  pinned,
  navigation,
  runtime,
  renderColumnFilter,
  registerColumnFilterOpener,
  style,
}: {
  readonly attachHeaderColumn?:
    | ((columnId: string, element: HTMLElement | null) => void)
    | undefined;
  readonly getActiveInColumnWindowSnapshot?: ((columnId: string) => boolean) | undefined;
  readonly activateHeaderCommand: (columnId: string) => void;
  readonly menuOpen?: boolean;
  readonly activateHeaderForResize: (columnId: string) => void;
  readonly onColumnPointerDown: (
    event: ReactPointerEvent<HTMLElement>,
    column: CompiledColumn,
    kind: "resize" | "reorder",
  ) => void;
  readonly openColumnMenu: (columnId: string, triggerElement: HTMLButtonElement) => void;
  readonly restoreColumnFocus: (columnId: string) => void;
  readonly toggleHeaderFilter: (columnId: string) => void;
  readonly toggleHeaderSort: (columnId: string, multi: boolean) => void;
  readonly instanceId: string;
  readonly tableId: string;
  readonly columnIndex: number;
  readonly column: CompiledColumn;
  readonly groupBy: readonly string[];
  readonly pinned?: "start" | "end";
  readonly navigation: BrunoTableNavigationRuntime;
  readonly runtime: BrunoTableRuntimeView;
  readonly renderColumnFilter?: BrunoTableColumnFilterRenderer | undefined;
  readonly registerColumnFilterOpener: (columnId: string, open: () => void) => () => void;
  readonly style?: CSSProperties;
}) {
  const activeInColumnWindow = getActiveInColumnWindowSnapshot?.(column.columnId) ?? true;
  const attachHeaderCell = useCallback(
    (element: HTMLTableCellElement | null) => attachHeaderColumn?.(column.columnId, element),
    [attachHeaderColumn, column.columnId],
  );
  const subscribe = useMemo(
    () => (listener: () => void) => runtime.subscribeColumnCommands(column.columnId, listener),
    [column.columnId, runtime],
  );
  const getSnapshot = useMemo(
    () => () => runtime.getColumnCommandSnapshot(column.columnId),
    [column.columnId, runtime],
  );
  const command = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const subscribeActiveResize = useMemo(
    () => (listener: () => void) => navigation.subscribeColumn(column.columnId, listener),
    [column.columnId, navigation],
  );
  const resizeActive = useSyncExternalStore(
    subscribeActiveResize,
    () => navigation.getColumnSnapshot(column.columnId),
    () => navigation.getColumnSnapshot(column.columnId),
  );
  const presentation = headerSortPresentation(column.headerName, command);
  const sortLabel =
    command.sortDirection === undefined
      ? `Sort by ${column.headerName}`
      : `Sort by ${column.headerName}, currently ${presentation.direction}${sortPriorityLabel(command.sortPriority)}`;
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  const attachMenuHotkeyWorkflow = useBrunoTableHotkeyWorkflowAction(() => {
    const trigger = menuTrigger.current;
    if (trigger !== null) openColumnMenu(column.columnId, trigger);
  });
  const attachMenuTrigger = useCallback(
    (trigger: HTMLButtonElement | null) => {
      menuTrigger.current = trigger;
      attachMenuHotkeyWorkflow(trigger);
    },
    [attachMenuHotkeyWorkflow],
  );
  const pinLabel = command.pinned === undefined ? "unpinned" : `pinned ${command.pinned}`;
  const menuTriggerId = headerDomId(instanceId, tableId, `${column.columnId}-menu`);

  const content = (
    <div className="flex min-w-0 items-center gap-0.5 overflow-hidden">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
        {command.sortable ? (
          <button
            aria-label={sortLabel}
            className={BRUNO_TABLE_HEADER_GHOST_BUTTON_CLASS}
            data-slot="button"
            tabIndex={-1}
            type="button"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              activateHeaderCommand(column.columnId);
            }}
            onClick={() => {
              activateHeaderCommand(column.columnId);
              toggleHeaderSort(column.columnId, isBrunoTableHotkeyHeld("Shift"));
            }}
          >
            <span className="truncate">{column.headerName}</span>
            {command.sortPriority === undefined ? null : (
              <>
                <span aria-hidden="true">{command.sortDirection === "asc" ? "↑" : "↓"}</span>
                <span aria-hidden="true">{String(command.sortPriority)}</span>
              </>
            )}
          </button>
        ) : (
          <span className="truncate">{column.headerName}</span>
        )}
        {supportsBrunoTableCustomColumnFilter(column, renderColumnFilter)
          ? renderColumnFilter?.({
              activateHeaderCommand,
              column,
              command,
              restoreColumnFocus,
              runtime,
              registerColumnFilterOpener,
            })
          : null}
        {command.filterActive || command.filterBaselineAvailable ? (
          <button
            aria-label={`${command.filterActive ? "Clear" : "Reset"} filter for ${column.headerName}`}
            className={BRUNO_TABLE_HEADER_GHOST_BUTTON_CLASS}
            data-slot="button"
            tabIndex={-1}
            type="button"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.focus({ preventScroll: true });
              navigation.activateHeader(column.columnId);
            }}
            onClick={(event) => {
              const header = event.currentTarget.closest("th");
              event.currentTarget.focus({ preventScroll: true });
              navigation.activateHeader(column.columnId);
              toggleHeaderFilter(column.columnId);
              const next = runtime.getColumnCommandSnapshot(column.columnId);
              if (!next.filterActive && !next.filterBaselineAvailable) {
                requestAnimationFrame(() => {
                  const label = `Filter ${column.headerName}`;
                  const trigger = [
                    ...(header?.querySelectorAll<HTMLButtonElement>("button") ?? []),
                  ].find((candidate) => candidate.getAttribute("aria-label")?.startsWith(label));
                  trigger?.focus({ preventScroll: true });
                });
              }
            }}
          >
            {command.filterActive ? "Clear" : "Reset"}
          </button>
        ) : null}
      </div>
      {groupBy.length === 0 ? (
        <button
          aria-label={`Reorder ${column.headerName}`}
          className="inline-flex size-5 shrink-0 cursor-grab items-center justify-center rounded-sm text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 active:cursor-grabbing"
          tabIndex={-1}
          type="button"
          onPointerDown={(event) => onColumnPointerDown(event, column, "reorder")}
        >
          <ArrowsHorizontalIcon aria-hidden="true" />
        </button>
      ) : null}
      <button
        ref={attachMenuTrigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={activeInColumnWindow ? menuOpen : undefined}
        aria-controls={
          activeInColumnWindow && menuOpen
            ? headerDomId(instanceId, tableId, "shared-menu-popup")
            : undefined
        }
        aria-label={`Column menu for ${column.headerName}`}
        aria-keyshortcuts="Shift+F10 ContextMenu"
        className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
        data-bruno-column-menu-trigger={activeInColumnWindow ? column.columnId : undefined}
        data-bruno-retained-column-menu-trigger={menuTriggerId}
        id={activeInColumnWindow ? menuTriggerId : undefined}
        tabIndex={-1}
        onPointerDown={(event) => {
          if (event.button === 0) {
            activateHeaderForResize(column.columnId);
          }
        }}
        onClick={(event) => {
          openColumnMenu(column.columnId, event.currentTarget);
        }}
      >
        <DotsThreeVerticalIcon aria-hidden="true" />
      </button>
      {groupBy.length === 0 ||
      column.columnId === "COL_ID_BRUNO_TABLE_ROWS" ||
      (column.kind === "field" &&
        (column.aggFunc !== undefined || groupBy.includes(column.columnId))) ? (
        <span
          aria-label={`Resize ${column.headerName}`}
          aria-orientation="vertical"
          aria-valuemax={command.maxWidth}
          aria-valuemin={command.minWidth}
          aria-valuenow={command.width}
          aria-keyshortcuts="ArrowLeft ArrowRight Home End"
          className="-mr-1 inline-flex h-7 w-2 shrink-0 cursor-col-resize touch-none items-center justify-center outline-none after:h-4 after:w-px after:bg-border hover:after:bg-ring focus-visible:ring-2 focus-visible:ring-ring/30"
          role="separator"
          tabIndex={resizeActive ? 0 : -1}
          onFocus={() => activateHeaderForResize(column.columnId)}
          onPointerDown={(event) => onColumnPointerDown(event, column, "resize")}
        />
      ) : null}
    </div>
  );
  const headerProps = {
    "data-pinned-region": pinned,
    "data-bruno-column-id": activeInColumnWindow ? column.columnId : undefined,
    "data-bruno-retained-header-id": headerDomId(instanceId, tableId, column.columnId),
    id: activeInColumnWindow ? headerDomId(instanceId, tableId, column.columnId) : undefined,
    "aria-hidden": activeInColumnWindow ? undefined : true,
    // Retained centre headers stay aria-hidden while they are outside the
    // mounted body window, but keep their stable semantics so the viewport
    // runtime can promote one atomically without waiting for a React commit.
    "aria-label": `${presentation.label}, width ${String(command.width)} pixels, ${pinLabel}`,
    "aria-colindex": columnIndex + 1,
    "aria-keyshortcuts": supportsBrunoTableCustomColumnFilter(column, renderColumnFilter)
      ? "Alt+Enter Alt+Shift+Enter"
      : command.filterBaselineAvailable
        ? "Alt+Enter"
        : undefined,
    "aria-sort": presentation.ariaSort,
    role: "columnheader",
    style: {
      boxSizing: "border-box",
      height: ROW_HEIGHT,
      maxHeight: ROW_HEIGHT,
      overflow: "hidden",
      ...style,
      visibility: activeInColumnWindow ? style?.visibility : "hidden",
      transform: `var(${brunoTableColumnCssVariable("transform", column.columnId)}, none)`,
      width: `var(${brunoTableColumnCssVariable("width", column.columnId)}, ${String(column.semantics.width)}px)`,
    } satisfies CSSProperties,
  } as const;
  return (
    <th ref={attachHeaderCell} {...headerProps} scope="col">
      {content}
    </th>
  );
});

const ColumnManagementMenu = memo(function ColumnManagementMenu({
  allColumns,
  announce,
  closeMenu,
  column,
  command,
  direction,
  finalFocusTarget,
  groupBy,
  menuAnchor,
  menuId,
  openHeaderFilter,
  preventMenuFinalFocus = false,
  renderColumnFilter,
  restoreColumnFocus,
  runtime,
  visibleColumnIds,
}: {
  readonly allColumns: readonly CompiledColumn[];
  readonly announce: (message: string) => void;
  readonly closeMenu: (preserveFocus?: boolean) => void;
  readonly column: CompiledColumn;
  readonly command: BrunoTableColumnCommandSnapshot;
  readonly direction: "ltr" | "rtl";
  readonly finalFocusTarget?: Readonly<{ current: HTMLElement | null }>;
  readonly groupBy: readonly string[];
  readonly menuAnchor?: Element | null | undefined;
  readonly menuId?: string;
  readonly openHeaderFilter: (columnId: string) => void;
  readonly preventMenuFinalFocus?: boolean;
  readonly renderColumnFilter?: BrunoTableColumnFilterRenderer | undefined;
  readonly restoreColumnFocus: (columnId: string) => void;
  readonly runtime: BrunoTableRuntimeView;
  readonly visibleColumnIds: readonly string[];
}) {
  const index = visibleColumnIds.indexOf(column.columnId);
  const MoveStartIcon = direction === "rtl" ? ArrowRightIcon : ArrowLeftIcon;
  const MoveEndIcon = direction === "rtl" ? ArrowLeftIcon : ArrowRightIcon;
  const groupIndexes = visibleColumnIds.flatMap((id, candidateIndex) => {
    const candidate = allColumns.find((columnToCheck) => columnToCheck.columnId === id);
    return candidate?.pinned === command.pinned ? [candidateIndex] : [];
  });
  const groupStart = groupIndexes[0] ?? index;
  const groupEnd = groupIndexes.at(-1) ?? index;
  const isFirst = index < 0 || index <= groupStart;
  const isLast = index < 0 || index >= groupEnd;
  const filterTransfer = useRef(false);
  const finalFocus = preventMenuFinalFocus
    ? false
    : () => {
        if (!filterTransfer.current) return finalFocusTarget?.current ?? null;
        filterTransfer.current = false;
        return false;
      };
  const closeMenuPreservingActiveFocus = (): void => {
    const focusTarget =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    filterTransfer.current = true;
    closeMenu(true);
    requestAnimationFrame(() => {
      if (focusTarget?.isConnected) focusTarget.focus({ preventScroll: true });
    });
  };
  const dispatch = (commandToDispatch: BrunoTableGridCommand): boolean => {
    const accepted = runtime.dispatchGridCommand(commandToDispatch);
    if (!accepted) return false;
    restoreColumnFocus(column.columnId);
    return true;
  };
  const move = (requestedIndex: number): void => {
    const targetIndex = Math.max(groupStart, Math.min(groupEnd, requestedIndex));
    if (targetIndex === index) return;
    if (
      !dispatch({
        type: "column.reorder.commit",
        columnId: column.columnId,
        targetIndex,
        pinned: command.pinned,
      })
    )
      return;
    announce(
      `${column.headerName} position ${String(targetIndex + 1)} of ${String(visibleColumnIds.length)}`,
    );
  };
  const resize = (delta: number): void => {
    const width = clampBrunoTableColumnWidth(command.width + delta, {
      min: command.minWidth,
      max: command.maxWidth,
    });
    if (width === command.width) return;
    if (!dispatch({ type: "column.resize.commit", columnId: column.columnId, width })) return;
    announce(`${column.headerName} width ${String(width)} pixels`);
  };
  const grouped = groupBy.length > 0;
  const groupingEligible =
    runtime.getGroupingEnabledSnapshot() && column.kind === "field" && column.groupBy;
  const groupingActive = groupBy.includes(column.columnId);
  const groupedResizeAvailable =
    column.columnId === "COL_ID_BRUNO_TABLE_ROWS" ||
    (column.kind === "field" && (column.aggFunc !== undefined || groupingActive));
  const visibilityColumns = grouped
    ? allColumns.filter(
        (candidate) =>
          candidate.columnId !== "COL_ID_BRUNO_TABLE_ROWS" && !groupBy.includes(candidate.columnId),
      )
    : allColumns;
  return (
    <DropdownMenuContent
      align="start"
      anchor={menuAnchor}
      finalFocus={finalFocus}
      id={menuId}
      aria-label={`Column menu for ${column.headerName}`}
    >
      {command.sortable ? (
        <DropdownMenuGroup>
          <DropdownMenuLabel>Sort</DropdownMenuLabel>
          <DropdownMenuItem
            closeOnClick={false}
            aria-label={
              command.sortDirection === undefined
                ? `Sort by ${column.headerName}`
                : `Sort by ${column.headerName}, currently ${
                    command.sortDirection === "asc" ? "ascending" : "descending"
                  }${sortPriorityLabel(command.sortPriority)}`
            }
            onClick={() => {
              const accepted = runtime.dispatchGridCommand({
                type: "column.sort.toggle",
                columnId: column.columnId,
                multi: false,
              });
              if (!accepted) {
                closeMenuPreservingActiveFocus();
                return;
              }
              const next = runtime.getColumnCommandSnapshot(column.columnId);
              announce(columnSortAnnouncement(column.headerName, next));
              closeMenu();
              restoreColumnFocus(column.columnId);
            }}
          >
            Sort by {column.headerName}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      ) : null}
      {groupingEligible ? (
        <DropdownMenuGroup>
          <DropdownMenuLabel>Group</DropdownMenuLabel>
          <DropdownMenuItem
            onClick={() => {
              const cancelGroupingFocus = groupingActive
                ? prepareBrunoTableGroupingRemovalFocus(runtime, column.columnId)
                : () => undefined;
              const accepted = runtime.dispatchGridCommand({
                type: groupingActive ? "grouping.remove" : "grouping.add",
                columnId: column.columnId,
              });
              if (!accepted) {
                cancelGroupingFocus();
                return;
              }
              if (groupingActive) {
                filterTransfer.current = true;
                closeMenu(true);
              } else {
                closeMenu();
                restoreColumnFocus(column.columnId);
              }
              const remaining = groupBy.length - 1;
              announce(
                groupingActive
                  ? `${column.headerName} removed from Group By, ${String(remaining)} ${remaining === 1 ? "group" : "groups"} remaining`
                  : `${column.headerName} added to Group By`,
              );
            }}
          >
            {groupingActive
              ? `Remove ${column.headerName} from grouping`
              : `Group by ${column.headerName}`}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      ) : null}
      {supportsBrunoTableCustomColumnFilter(column, renderColumnFilter) ||
      command.filterActive ||
      command.filterBaselineAvailable ? (
        <DropdownMenuGroup>
          <DropdownMenuLabel>Filter</DropdownMenuLabel>
          {supportsBrunoTableCustomColumnFilter(column, renderColumnFilter) ? (
            <DropdownMenuItem
              onClick={() => {
                filterTransfer.current = true;
                openHeaderFilter(column.columnId);
              }}
            >
              Open filter for {column.headerName}
            </DropdownMenuItem>
          ) : null}
          {command.filterActive || command.filterBaselineAvailable ? (
            <DropdownMenuItem
              closeOnClick={false}
              onClick={() => {
                const action = command.filterActive ? "cleared" : "reset";
                const accepted = runtime.dispatchGridCommand({
                  type: command.filterActive ? "column.filter.clear" : "column.filter.reset",
                  columnId: column.columnId,
                });
                if (!accepted) {
                  closeMenuPreservingActiveFocus();
                  return;
                }
                announce(`${column.headerName} filter ${action}`);
                closeMenu();
                restoreColumnFocus(column.columnId);
              }}
            >
              {command.filterActive ? "Clear filter" : "Reset filter"}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuGroup>
      ) : null}
      {!grouped || groupedResizeAvailable ? (
        <DropdownMenuGroup>
          <DropdownMenuLabel>Resize</DropdownMenuLabel>
          <DropdownMenuItem
            disabled={command.width <= command.minWidth}
            onClick={() => resize(-10)}
          >
            Decrease width
          </DropdownMenuItem>
          <DropdownMenuItem disabled={command.width >= command.maxWidth} onClick={() => resize(10)}>
            Increase width
          </DropdownMenuItem>
        </DropdownMenuGroup>
      ) : null}
      {column.columnId !== "COL_ID_BRUNO_TABLE_ROWS" ? <DropdownMenuSeparator /> : null}
      {column.columnId !== "COL_ID_BRUNO_TABLE_ROWS" ? (
        <DropdownMenuGroup>
          <DropdownMenuLabel>Pin</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={command.pinned ?? "none"}
            onValueChange={(value) => {
              if (value === "start" || value === "end" || value === "none") {
                if (
                  !dispatch({
                    type: "column.pin.commit",
                    columnId: column.columnId,
                    pinned: value === "none" ? undefined : value,
                  })
                )
                  return;
                announce(
                  value === "none"
                    ? `${column.headerName} unpinned`
                    : `${column.headerName} pinned to logical ${value}`,
                );
                closeMenu();
              }
            }}
          >
            <DropdownMenuRadioItem value="start">
              <PushPinIcon aria-hidden="true" />
              Pin to logical start
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="end">
              <PushPinIcon aria-hidden="true" />
              Pin to logical end
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="none">
              <PushPinSlashIcon aria-hidden="true" />
              Unpin
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      ) : null}
      {!grouped ? (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Move</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem disabled={isFirst} onClick={() => move(index - 1)}>
              <MoveStartIcon aria-hidden="true" />
              Move toward logical start
            </DropdownMenuItem>
            <DropdownMenuItem disabled={isLast} onClick={() => move(index + 1)}>
              <MoveEndIcon aria-hidden="true" />
              Move toward logical end
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ) : null}
      {visibilityColumns.length > 0 ? (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Visibility</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuGroup>
              <DropdownMenuLabel>Columns</DropdownMenuLabel>
              {visibilityColumns.map((candidate) => {
                const visible = visibleColumnIds.includes(candidate.columnId);
                return (
                  <DropdownMenuCheckboxItem
                    key={candidate.columnId}
                    checked={visible}
                    disabled={visible && visibleColumnIds.length === 1}
                    onCheckedChange={(checked) => {
                      if (checked === true || checked === false) {
                        if (
                          !dispatch({
                            type: "column.visibility.commit",
                            columnId: candidate.columnId,
                            visible: checked,
                          })
                        )
                          return;
                        announce(`${candidate.headerName} ${checked ? "shown" : "hidden"}`);
                      }
                    }}
                  >
                    {candidate.headerName}
                  </DropdownMenuCheckboxItem>
                );
              })}
            </DropdownMenuGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ) : null}
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>Reset</DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {!grouped ? (
            <DropdownMenuItem
              onClick={() => {
                if (dispatch({ type: "column.reset.order" })) announce("Column order reset");
              }}
            >
              Reset order
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            onClick={() => {
              if (dispatch({ type: "column.reset.widths" })) announce("Column widths reset");
            }}
          >
            Reset widths
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              if (dispatch({ type: "column.reset.visibility" }))
                announce("Column visibility reset");
            }}
          >
            Reset visibility
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              if (dispatch({ type: "column.reset.pinning" })) announce("Column pinning reset");
            }}
          >
            Reset pinning
          </DropdownMenuItem>
          {!grouped ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => {
                  if (dispatch({ type: "column.reset.layout" }))
                    announce("Complete column layout reset");
                }}
              >
                Reset complete layout
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </DropdownMenuContent>
  );
});

const ActiveDescendantProxy = memo(function ActiveDescendantProxy({
  activeCell,
  cellRange,
  column,
  columnIndex,
  gridElement,
  instanceId,
  ownerRowIndex,
  ownershipKey,
  runtime,
  renderColumnFilter,
  tableId,
}: {
  readonly activeCell: BrunoTableActiveCell;
  readonly cellRange?: BrunoTableCellRangeRuntime | undefined;
  readonly column: CompiledColumn | undefined;
  readonly columnIndex: number;
  readonly gridElement: Readonly<{ current: HTMLDivElement | null }>;
  readonly instanceId: string;
  readonly ownerRowIndex?: number | undefined;
  readonly ownershipKey: object;
  readonly runtime: BrunoTableRuntimeView;
  readonly renderColumnFilter?: BrunoTableColumnFilterRenderer | undefined;
  readonly tableId: string;
}) {
  if (column === undefined || columnIndex < 0) return null;
  if (activeCell.region === "header") {
    return (
      <ActiveHeaderDescendantProxy
        column={column}
        columnIndex={columnIndex}
        gridElement={gridElement}
        instanceId={instanceId}
        ownerRowIndex={ownerRowIndex}
        ownershipKey={ownershipKey}
        renderColumnFilter={renderColumnFilter}
        runtime={runtime}
        tableId={tableId}
      />
    );
  }
  return (
    <ActiveBodyDescendantProxy
      activeCell={activeCell}
      cellRange={cellRange}
      column={column}
      columnIndex={columnIndex}
      gridElement={gridElement}
      instanceId={instanceId}
      ownerRowIndex={ownerRowIndex}
      ownershipKey={ownershipKey}
      runtime={runtime}
      tableId={tableId}
    />
  );
});

const ActiveHeaderDescendantProxy = memo(function ActiveHeaderDescendantProxy({
  column,
  columnIndex,
  gridElement,
  instanceId,
  ownerRowIndex,
  ownershipKey,
  renderColumnFilter,
  runtime,
  tableId,
}: {
  readonly column: CompiledColumn;
  readonly columnIndex: number;
  readonly gridElement: Readonly<{ current: HTMLDivElement | null }>;
  readonly instanceId: string;
  readonly ownerRowIndex?: number | undefined;
  readonly ownershipKey: object;
  readonly renderColumnFilter?: BrunoTableColumnFilterRenderer | undefined;
  readonly runtime: BrunoTableRuntimeView;
  readonly tableId: string;
}) {
  const subscribe = useMemo(
    () => (listener: () => void) => runtime.subscribeColumnCommands(column.columnId, listener),
    [column.columnId, runtime],
  );
  const getSnapshot = useMemo(
    () => () => runtime.getColumnCommandSnapshot(column.columnId),
    [column.columnId, runtime],
  );
  const command = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const presentation = headerSortPresentation(column.headerName, command);
  const id = headerDomId(instanceId, tableId, column.columnId);
  const proxyElement = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const proxy = proxyElement.current;
    const grid = gridElement.current;
    if (proxy === null || grid === null) return;
    const retainedHeader = [
      ...grid.querySelectorAll<HTMLElement>("[data-bruno-retained-header-id]"),
    ].find((candidate) => candidate.dataset["brunoRetainedHeaderId"] === id);
    if (retainedHeader?.id === id) retainedHeader.removeAttribute("id");
    proxy.id = id;
    return () => {
      if (retainedHeader?.dataset["brunoColumnId"] !== column.columnId) return;
      proxy.removeAttribute("id");
      retainedHeader.id = id;
    };
  }, [column.columnId, gridElement, id]);
  useActiveDescendantRowOwnership(gridElement, ownerRowIndex, id, ownershipKey);
  const proxy = (
    <div
      ref={proxyElement}
      id={id}
      data-bruno-active-proxy=""
      aria-colindex={columnIndex + 1}
      aria-keyshortcuts={
        supportsBrunoTableCustomColumnFilter(column, renderColumnFilter)
          ? "Alt+Enter Alt+Shift+Enter"
          : command.filterBaselineAvailable
            ? "Alt+Enter"
            : undefined
      }
      aria-label={presentation.label}
      aria-sort={presentation.ariaSort}
      role="columnheader"
    >
      {column.headerName}
    </div>
  );
  return ownerRowIndex === undefined ? (
    <div aria-rowindex={1} role="row" style={VISUALLY_HIDDEN}>
      {proxy}
    </div>
  ) : (
    <div style={VISUALLY_HIDDEN}>{proxy}</div>
  );
});

const ActiveBodyDescendantProxy = memo(function ActiveBodyDescendantProxy({
  activeCell,
  cellRange,
  column,
  columnIndex,
  gridElement,
  instanceId,
  ownerRowIndex,
  ownershipKey,
  runtime,
  tableId,
}: {
  readonly activeCell: BrunoTableActiveCell;
  readonly cellRange?: BrunoTableCellRangeRuntime | undefined;
  readonly column: CompiledColumn;
  readonly columnIndex: number;
  readonly gridElement: Readonly<{ current: HTMLDivElement | null }>;
  readonly instanceId: string;
  readonly ownerRowIndex?: number | undefined;
  readonly ownershipKey: object;
  readonly runtime: BrunoTableRuntimeView;
  readonly tableId: string;
}) {
  const rowId = activeCell.rowId;
  const subscribeCellRange = useMemo(
    () => cellRange?.subscribe ?? (() => () => undefined),
    [cellRange],
  );
  const getCellRangeSelection = useMemo(
    () => () => rowId !== undefined && cellRange?.isCellSelected(rowId, column.columnId) === true,
    [cellRange, column.columnId, rowId],
  );
  const selected = useSyncExternalStore(
    subscribeCellRange,
    getCellRangeSelection,
    getCellRangeSelection,
  );
  const rowAware = proxyPresentationUsesRawRow(column);
  const getRowIdentitySnapshot = useMemo(
    () => () => runtime.getRowSpaceSnapshot()?.getRowId(activeCell.rowIndex),
    [activeCell.rowIndex, runtime],
  );
  const currentRowId = useSyncExternalStore(
    runtime.subscribeRowSpace,
    getRowIdentitySnapshot,
    getRowIdentitySnapshot,
  );
  const loadingSlot = rowId !== undefined && currentRowId === undefined;
  const subscribe = useMemo(
    () => (listener: () => void) =>
      rowId === undefined || loadingSlot
        ? () => undefined
        : rowAware
          ? runtime.subscribeRowCell(rowId, column.columnId, listener)
          : runtime.subscribeCell(rowId, column.columnId, listener),
    [column.columnId, loadingSlot, rowAware, rowId, runtime],
  );
  const getSnapshot = useMemo(
    () => () =>
      rowId === undefined || loadingSlot
        ? undefined
        : rowAware
          ? runtime.getRowCellSnapshot(rowId, column.columnId)
          : runtime.getCellSnapshot(rowId, column.columnId),
    [column.columnId, loadingSlot, rowAware, rowId, runtime],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const cellSnapshot = rowAware ? undefined : (snapshot as BrunoTableCellSnapshot | undefined);
  const rowSnapshot = rowAware ? (snapshot as BrunoTableRowCellSnapshot | undefined) : undefined;
  const row = rowSnapshot?.row;
  const unavailable = rowAware
    ? rowSnapshot?.kind === "unavailable"
    : cellSnapshot?.kind === "unavailable";
  const rowPresent = rowAware
    ? row !== undefined
    : cellSnapshot?.kind === "available" && cellSnapshot.rowPresent;
  const value = rowAware ? rowSnapshot?.value : cellSnapshot?.value;
  const invalid = isBrunoTableInvalidCellValue(value) ? value : undefined;
  const content = loadingSlot
    ? "Loading row"
    : unavailable
      ? null
      : !rowPresent
        ? "Loading row"
        : invalid
          ? invalidSourceDetails(invalid.invalid)
          : resolveProxyCellContent(column, row, value);
  const id = activeDomIdForRowIdentity(instanceId, tableId, activeCell, currentRowId);
  useActiveDescendantRowOwnership(gridElement, ownerRowIndex, id, ownershipKey);
  const proxy = (
    <div
      id={id}
      data-bruno-active-proxy=""
      aria-colindex={columnIndex + 1}
      aria-selected={selected || undefined}
      role="gridcell"
    >
      {content}
    </div>
  );
  return ownerRowIndex === undefined ? (
    <div aria-rowindex={activeCell.rowIndex + 2} role="row" style={VISUALLY_HIDDEN}>
      {proxy}
    </div>
  ) : (
    <div style={VISUALLY_HIDDEN}>{proxy}</div>
  );
});

function useActiveDescendantRowOwnership(
  gridElement: Readonly<{ current: HTMLDivElement | null }>,
  ownerRowIndex: number | undefined,
  ownedId: string | undefined,
  ownershipKey: object,
): void {
  const assignmentRef = useRef<
    Readonly<{ readonly owner: HTMLElement; readonly ownedId: string }> | undefined
  >(undefined);
  useLayoutEffect(() => {
    const grid = gridElement.current;
    if (grid === null || ownerRowIndex === undefined || ownedId === undefined) return;
    const owner = [...grid.querySelectorAll<HTMLElement>('[role="row"][aria-rowindex]')].find(
      (row) => row.getAttribute("aria-rowindex") === String(ownerRowIndex),
    );
    if (owner === undefined) return;
    const ownedElement = grid.ownerDocument.getElementById(ownedId);
    if (ownedElement !== null && owner.contains(ownedElement)) return;
    const assignment = Object.freeze({ owner, ownedId });
    assignmentRef.current = assignment;
    const ownedIds = owner.getAttribute("aria-owns")?.split(" ").filter(Boolean) ?? [];
    if (!ownedIds.includes(ownedId)) {
      owner.setAttribute("aria-owns", [...ownedIds, ownedId].join(" "));
    }
    return () => {
      if (assignmentRef.current === assignment) assignmentRef.current = undefined;
      queueMicrotask(() => {
        const currentOwnedElement = grid.ownerDocument.getElementById(ownedId);
        const replacement = assignmentRef.current;
        if (
          currentOwnedElement !== null &&
          !owner.contains(currentOwnedElement) &&
          replacement?.owner === owner &&
          replacement.ownedId === ownedId
        ) {
          return;
        }
        const remainingIds =
          owner
            .getAttribute("aria-owns")
            ?.split(" ")
            .filter((candidate) => candidate.length > 0 && candidate !== ownedId) ?? [];
        if (remainingIds.length === 0) owner.removeAttribute("aria-owns");
        else owner.setAttribute("aria-owns", remainingIds.join(" "));
      });
    };
  }, [gridElement, ownedId, ownerRowIndex, ownershipKey]);
}

const UnloadedRow = memo(function UnloadedRow({
  attachBodyLayer,
  center,
  centerStartIndex,
  instanceId,
  leftPadding,
  logicalRowIndex,
  pinnedEnd,
  pinnedStart,
  rightPadding,
  tableId,
  top,
  viewportFill,
  width,
  rowSelection,
  columnIndexOffset,
}: {
  readonly attachBodyLayer: RefCallback<HTMLElement>;
  readonly center: readonly CompiledColumn[];
  readonly centerStartIndex: number;
  readonly instanceId: string;
  readonly leftPadding: number;
  readonly logicalRowIndex: number;
  readonly pinnedEnd: readonly CompiledColumn[];
  readonly pinnedStart: readonly CompiledColumn[];
  readonly rightPadding: number;
  readonly tableId: string;
  readonly top: number;
  readonly viewportFill: number;
  readonly width: number;
  readonly rowSelection?: BrunoTableRowSelectionRuntime | undefined;
  readonly columnIndexOffset: number;
}) {
  return (
    <LoadingRow
      ariaRowIndexOffset={2}
      attachBodyLayer={attachBodyLayer}
      center={center}
      centerStartIndex={centerStartIndex}
      instanceId={instanceId}
      leftPadding={leftPadding}
      logicalRowIndex={logicalRowIndex}
      pinnedEnd={pinnedEnd}
      pinnedStart={pinnedStart}
      rightPadding={rightPadding}
      tableId={tableId}
      top={top}
      viewportFill={viewportFill}
      width={width}
      rowSelection={rowSelection}
      columnIndexOffset={columnIndexOffset}
    />
  );
});

type BrunoTableRowProps = Readonly<{
  readonly attachBodyLayer: RefCallback<HTMLElement>;
  readonly rowId: string;
  readonly instanceId: string;
  readonly tableId: string;
  readonly centerStartIndex: number;
  readonly pinnedStartCount: number;
  readonly runtime: BrunoTableRuntimeView;
  readonly center: readonly CompiledColumn[];
  readonly pinnedStart: readonly CompiledColumn[];
  readonly pinnedEnd: readonly CompiledColumn[];
  readonly leftPadding: number;
  readonly rightPadding: number;
  readonly viewportFill: number;
  readonly logicalRowIndex: number;
  readonly top: number;
  readonly width: number;
  readonly rowSelection?: BrunoTableRowSelectionRuntime | undefined;
  readonly renderRowSelection?: boolean | undefined;
  readonly ownRowSelection?: boolean | undefined;
  readonly columnIndexOffset: number;
  readonly renderActiveEditor?: boolean | undefined;
  readonly activeEditorColumnId?: BrunoTableColumnId | undefined;
  readonly activeEditorCenterIndex?: number | undefined;
  readonly semanticRowIndex?: number | null | undefined;
  readonly onCommittedOutsideCellPointer?: ((rowId: string, columnId: string) => void) | undefined;
  readonly yieldGridTabStop?: ((grid: HTMLElement) => void) | undefined;
  readonly projectionSuppressed?: boolean | undefined;
  readonly useSharedCenterWindow?: boolean | undefined;
  readonly getBodyRowColumnWindowSnapshot?:
    | ((logicalRowIndex: number) => BrunoTableBodyColumnWindowSnapshot)
    | undefined;
  readonly subscribeBodyRowColumnWindow?:
    | ((logicalRowIndex: number, listener: () => void) => () => void)
    | undefined;
}>;

const BrunoTableCenterBodyRows = memo(function BrunoTableCenterBodyRows({
  subscribeFrameCommit,
  activeEditRowId,
  attachBodyLayer,
  columnIndexOffset,
  getColumnWindowSnapshot,
  getBodyRowColumnWindowSnapshot,
  getRowRangeSnapshot,
  instanceId,
  pinnedEnd,
  pinnedStart,
  rowSelection,
  rowSpace,
  runtime,
  subscribeColumnWindow,
  subscribeBodyRowColumnWindow,
  subscribeRowRange,
  tableId,
  viewportFill,
  width,
}: {
  readonly activeEditRowId: string | undefined;
  readonly subscribeFrameCommit: (listener: () => void) => () => void;
  readonly attachBodyLayer: RefCallback<HTMLElement>;
  readonly columnIndexOffset: number;
  readonly getColumnWindowSnapshot: () => BrunoTableBodyColumnWindowSnapshot;
  readonly getBodyRowColumnWindowSnapshot: (
    logicalRowIndex: number,
  ) => BrunoTableBodyColumnWindowSnapshot;
  readonly getRowRangeSnapshot: () => BrunoTableRowRangeSnapshot;
  readonly instanceId: string;
  readonly pinnedEnd: readonly CompiledColumn[];
  readonly pinnedStart: readonly CompiledColumn[];
  readonly rowSelection?: BrunoTableRowSelectionRuntime | undefined;
  readonly rowSpace: BrunoTableLogicalRowSpace;
  readonly runtime: BrunoTableRuntimeView;
  readonly subscribeColumnWindow: (listener: () => void) => () => void;
  readonly subscribeBodyRowColumnWindow: (
    logicalRowIndex: number,
    listener: () => void,
  ) => () => void;
  readonly subscribeRowRange: (listener: () => void) => () => void;
  readonly tableId: string;
  readonly viewportFill: number;
  readonly width: number;
}) {
  const [mountedSlots] = useState(
    () =>
      new BrunoTableMountedRowSlots(
        getRowRangeSnapshot,
        rowSpace.identitySource?.getSnapshot() ?? rowSpace,
      ),
  );
  useLayoutEffect(() => {
    const refreshIdentities = () =>
      mountedSlots.setIdentities(rowSpace.identitySource?.getSnapshot() ?? rowSpace);
    const unsubscribeRange = subscribeRowRange(refreshIdentities);
    const unsubscribeIdentities = rowSpace.identitySource?.subscribe(refreshIdentities);
    // Recheck after subscribing to cover source changes between render and commit.
    refreshIdentities();
    return () => {
      unsubscribeRange();
      unsubscribeIdentities?.();
    };
  }, [mountedSlots, rowSpace, subscribeRowRange]);
  const {
    range: rowRange,
    rows: slots,
    hasUnloadedRows,
  } = useSyncExternalStore(
    mountedSlots.subscribe,
    mountedSlots.getSnapshot,
    mountedSlots.getSnapshot,
  );
  return (
    <BrunoTablePreparedCenterScheduler subscribeFrameCommit={subscribeFrameCommit}>
      <BrunoTableBodyColumnWindowProvider
        enabled={hasUnloadedRows}
        getSnapshot={getColumnWindowSnapshot}
        subscribe={subscribeColumnWindow}
      >
        <tbody
          role="rowgroup"
          style={{
            display: "block",
            height: rowRange.totalHeight,
            position: "relative",
            width: rowSelectionSurfaceWidth(width, rowSelection),
          }}
        >
          {slots.map(({ logicalRowIndex, rowId, key }, offset) => {
            return (
              <BrunoTableBodyRowSlot
                key={`viewport-row-slot:${String(key)}`}
                attachBodyLayer={attachBodyLayer}
                columnIndexOffset={columnIndexOffset}
                instanceId={instanceId}
                getBodyRowColumnWindowSnapshot={getBodyRowColumnWindowSnapshot}
                logicalRowIndex={logicalRowIndex}
                pinnedEnd={pinnedEnd}
                pinnedStart={pinnedStart}
                projectionSuppressed={rowId !== undefined && rowId === activeEditRowId}
                rowId={rowId}
                rowSelection={rowSelection}
                runtime={runtime}
                subscribeBodyRowColumnWindow={subscribeBodyRowColumnWindow}
                tableId={tableId}
                top={(rowRange.segmentedRows ? offset : logicalRowIndex) * ROW_HEIGHT}
                viewportFill={viewportFill}
                width={width}
              />
            );
          })}
        </tbody>
      </BrunoTableBodyColumnWindowProvider>
    </BrunoTablePreparedCenterScheduler>
  );
});

const BrunoTableBodyRowSlot = memo(function BrunoTableBodyRowSlot({
  attachBodyLayer,
  columnIndexOffset,
  instanceId,
  getBodyRowColumnWindowSnapshot,
  logicalRowIndex,
  pinnedEnd,
  pinnedStart,
  projectionSuppressed,
  rowId,
  rowSelection,
  runtime,
  subscribeBodyRowColumnWindow,
  tableId,
  top,
  viewportFill,
  width,
}: {
  readonly attachBodyLayer: RefCallback<HTMLElement>;
  readonly columnIndexOffset: number;
  readonly instanceId: string;
  readonly getBodyRowColumnWindowSnapshot: (
    logicalRowIndex: number,
  ) => BrunoTableBodyColumnWindowSnapshot;
  readonly logicalRowIndex: number;
  readonly pinnedEnd: readonly CompiledColumn[];
  readonly pinnedStart: readonly CompiledColumn[];
  readonly projectionSuppressed: boolean;
  readonly rowId: string | undefined;
  readonly rowSelection?: BrunoTableRowSelectionRuntime | undefined;
  readonly runtime: BrunoTableRuntimeView;
  readonly subscribeBodyRowColumnWindow: (
    logicalRowIndex: number,
    listener: () => void,
  ) => () => void;
  readonly tableId: string;
  readonly top: number;
  readonly viewportFill: number;
  readonly width: number;
}) {
  return rowId === undefined ? (
    <BrunoTableContextUnloadedRow
      attachBodyLayer={attachBodyLayer}
      columnIndexOffset={columnIndexOffset}
      instanceId={instanceId}
      logicalRowIndex={logicalRowIndex}
      pinnedEnd={pinnedEnd}
      pinnedStart={pinnedStart}
      rowSelection={rowSelection}
      tableId={tableId}
      top={top}
      viewportFill={viewportFill}
      width={width}
    />
  ) : (
    <BrunoTableRow
      attachBodyLayer={attachBodyLayer}
      center={EMPTY_ACTIVE_BODY_COLUMN_WINDOW.center}
      centerStartIndex={EMPTY_ACTIVE_BODY_COLUMN_WINDOW.centerStartIndex}
      columnIndexOffset={columnIndexOffset}
      getBodyRowColumnWindowSnapshot={getBodyRowColumnWindowSnapshot}
      instanceId={instanceId}
      leftPadding={EMPTY_ACTIVE_BODY_COLUMN_WINDOW.leftPadding}
      logicalRowIndex={logicalRowIndex}
      pinnedEnd={pinnedEnd}
      pinnedStart={pinnedStart}
      pinnedStartCount={pinnedStart.length}
      projectionSuppressed={projectionSuppressed}
      rightPadding={EMPTY_ACTIVE_BODY_COLUMN_WINDOW.rightPadding}
      rowId={rowId}
      rowSelection={rowSelection}
      runtime={runtime}
      subscribeBodyRowColumnWindow={subscribeBodyRowColumnWindow}
      tableId={tableId}
      top={top}
      viewportFill={viewportFill}
      width={width}
      useSharedCenterWindow
    />
  );
});

const BrunoTableContextUnloadedRow = memo(function BrunoTableContextUnloadedRow(
  props: Omit<
    Parameters<typeof UnloadedRow>[0],
    "center" | "centerStartIndex" | "leftPadding" | "rightPadding"
  >,
) {
  const centerWindow = useContext(BrunoTableBodyColumnWindowContext);
  return (
    <UnloadedRow
      {...props}
      center={centerWindow.center}
      centerStartIndex={centerWindow.centerStartIndex}
      leftPadding={centerWindow.leftPadding}
      rightPadding={centerWindow.rightPadding}
    />
  );
});

type BrunoTableRowOwnedCellIdentity = Readonly<{
  readonly ariaOwns: string;
  readonly centerCellIds: readonly string[];
  readonly rowSelectionId: string | undefined;
}>;

function brunoTableRowOwnedCellIdentity({
  activeEditorCenterIndex,
  activeEditorColumnId,
  center,
  centerStartIndex,
  instanceId,
  ownRowSelection,
  pinnedEnd,
  pinnedStart,
  rowId,
  rowSelection,
  tableId,
  centerCellIds: providedCenterCellIds,
}: Pick<
  BrunoTableRowProps,
  | "activeEditorCenterIndex"
  | "activeEditorColumnId"
  | "center"
  | "centerStartIndex"
  | "instanceId"
  | "ownRowSelection"
  | "pinnedEnd"
  | "pinnedStart"
  | "rowId"
  | "rowSelection"
  | "tableId"
> &
  Readonly<{
    readonly centerCellIds?: readonly string[] | undefined;
  }>): BrunoTableRowOwnedCellIdentity {
  const centerCellIds =
    providedCenterCellIds ??
    center.map((column) => cellDomId(instanceId, tableId, rowId, column.columnId));
  let centerOwnershipIds = centerCellIds;
  if (
    activeEditorColumnId !== undefined &&
    activeEditorCenterIndex !== undefined &&
    !center.some((column) => column.columnId === activeEditorColumnId)
  ) {
    const insertionIndex = Math.min(
      Math.max(activeEditorCenterIndex - centerStartIndex, 0),
      centerCellIds.length,
    );
    centerOwnershipIds = centerCellIds.toSpliced(
      insertionIndex,
      0,
      cellDomId(instanceId, tableId, rowId, activeEditorColumnId),
    );
  }
  const rowSelectionId =
    rowSelection === undefined || ownRowSelection === false
      ? undefined
      : cellDomId(instanceId, tableId, rowId, BRUNO_TABLE_ROW_SELECTION_COLUMN_ID);
  return Object.freeze({
    ariaOwns: [
      ...(rowSelectionId === undefined ? [] : [rowSelectionId]),
      ...pinnedStart.map((column) => cellDomId(instanceId, tableId, rowId, column.columnId)),
      ...centerOwnershipIds,
      ...pinnedEnd.map((column) => cellDomId(instanceId, tableId, rowId, column.columnId)),
    ].join(" "),
    centerCellIds,
    rowSelectionId,
  });
}

type BrunoTableCenterRowProjectionProps = Readonly<{
  readonly activeEditorColumnId: BrunoTableColumnId | undefined;
  readonly cellEdit: BrunoTableCellEditRuntime | undefined;
  readonly centerWindow: BrunoTableBodyColumnWindowSnapshot;
  readonly columnIndexOffset: number;
  readonly draftReviewSource: boolean;
  readonly instanceId: string;
  readonly logicalRowIndex: number;
  readonly onCommittedOutsideCellPointer: ((rowId: string, columnId: string) => void) | undefined;
  readonly pinnedStartCount: number;
  readonly renderActiveEditor: boolean;
  readonly rowId: string;
  readonly runtime: BrunoTableRuntimeView;
  readonly tableId: string;
  readonly yieldGridTabStop: ((grid: HTMLElement) => void) | undefined;
  readonly preparedCenter?: readonly CompiledColumn[] | undefined;
  readonly preparedCenterStartIndex?: number | undefined;
}>;

function preparedColumnStage(
  centerWindow: BrunoTableBodyColumnWindowSnapshot,
  absoluteCenterIndex: number,
): "entering" | "retiring" | undefined {
  const sourceCenterStartIndex =
    centerWindow.preparedSourceCenterStartIndex ?? centerWindow.centerStartIndex;
  const sourceCenterEndIndex =
    centerWindow.preparedSourceCenterEndIndex ??
    centerWindow.centerStartIndex + centerWindow.center.length;
  const staged =
    absoluteCenterIndex < sourceCenterStartIndex || absoluteCenterIndex >= sourceCenterEndIndex;
  return staged
    ? "entering"
    : centerWindow.preparedTargetCenterStartIndex !== undefined &&
        centerWindow.preparedTargetCenterEndIndex !== undefined &&
        (absoluteCenterIndex < centerWindow.preparedTargetCenterStartIndex ||
          absoluteCenterIndex >= centerWindow.preparedTargetCenterEndIndex)
      ? "retiring"
      : undefined;
}

const BrunoTableCenterRowProjection = memo(function BrunoTableCenterRowProjection({
  activeEditorColumnId,
  cellEdit,
  centerWindow,
  columnIndexOffset,
  draftReviewSource,
  instanceId,
  logicalRowIndex,
  onCommittedOutsideCellPointer,
  pinnedStartCount,
  renderActiveEditor,
  rowId,
  runtime,
  tableId,
  yieldGridTabStop,
  preparedCenter,
  preparedCenterStartIndex,
}: BrunoTableCenterRowProjectionProps) {
  const { center, centerStartIndex, leftPadding, rightPadding } = centerWindow;
  const usePreparedCenter = preparedCenter !== undefined && preparedCenterStartIndex !== undefined;
  const renderedCenter = usePreparedCenter ? preparedCenter : center;
  const renderedCenterStartIndex = usePreparedCenter ? preparedCenterStartIndex : centerStartIndex;
  return (
    <>
      {center.length > 0 ? (
        <td
          aria-hidden="true"
          style={{
            padding: 0,
            width: `var(${BRUNO_TABLE_PREPARED_LEFT_PADDING_CSS_VARIABLE}, var(${BRUNO_TABLE_LIVE_LEFT_PADDING_CSS_VARIABLE}, ${String(leftPadding)}px))`,
          }}
        />
      ) : null}
      {renderedCenter.map((column, index) => {
        const absoluteCenterIndex = renderedCenterStartIndex + index;
        const preparedStage = preparedColumnStage(centerWindow, absoluteCenterIndex);
        const id =
          preparedStage === undefined
            ? cellDomId(instanceId, tableId, rowId, column.columnId)
            : preparedCellDomId(instanceId, tableId, rowId, column.columnId, preparedStage);
        const ReadOnlyCell = cellPresentationUsesRawRow(column)
          ? BrunoTableReadOnlyCell
          : BrunoTableReadOnlyValueCell;
        return column.columnId === activeEditorColumnId ? (
          <td
            key={column.columnId}
            aria-hidden="true"
            style={
              preparedStage !== undefined
                ? { display: preparedCellDisplay(preparedStage) }
                : {
                    padding: 0,
                    width: `var(${brunoTableColumnCssVariable("width", column.columnId)}, ${String(column.semantics.width)}px)`,
                  }
            }
          />
        ) : cellEdit === undefined && !draftReviewSource ? (
          <ReadOnlyCell
            key={column.columnId}
            id={id}
            runtime={runtime}
            rowId={rowId}
            instanceId={instanceId}
            tableId={tableId}
            columnIndex={columnIndexOffset + pinnedStartCount + absoluteCenterIndex}
            column={column}
            logicalRowIndex={logicalRowIndex}
            onCommittedOutsideCellPointer={onCommittedOutsideCellPointer}
            renderActiveEditor={renderActiveEditor}
            yieldGridTabStop={yieldGridTabStop}
            preparedStage={preparedStage}
          />
        ) : (
          <BrunoTableEditableCell
            key={column.columnId}
            id={id}
            runtime={runtime}
            rowId={rowId}
            instanceId={instanceId}
            tableId={tableId}
            columnIndex={columnIndexOffset + pinnedStartCount + absoluteCenterIndex}
            column={column}
            logicalRowIndex={logicalRowIndex}
            onCommittedOutsideCellPointer={onCommittedOutsideCellPointer}
            renderActiveEditor={renderActiveEditor}
            yieldGridTabStop={yieldGridTabStop}
            cellEdit={cellEdit}
            preparedStage={preparedStage}
          />
        );
      })}
      {center.length > 0 ? (
        <td
          aria-hidden="true"
          style={{
            padding: 0,
            width: `var(${BRUNO_TABLE_PREPARED_RIGHT_PADDING_CSS_VARIABLE}, var(${BRUNO_TABLE_LIVE_RIGHT_PADDING_CSS_VARIABLE}, ${String(rightPadding)}px))`,
          }}
        />
      ) : null}
    </>
  );
});

type BrunoTableContextCenterRowProjectionProps = Omit<
  BrunoTableCenterRowProjectionProps,
  "centerWindow"
> &
  Pick<
    BrunoTableRowProps,
    | "activeEditorCenterIndex"
    | "getBodyRowColumnWindowSnapshot"
    | "ownRowSelection"
    | "pinnedEnd"
    | "pinnedStart"
    | "rowSelection"
    | "subscribeBodyRowColumnWindow"
  > &
  Readonly<{ readonly rowElement: RefObject<HTMLTableRowElement | null> }>;

const BrunoTablePreparedCenterSchedulerContext = createContext<
  ((listener: () => void) => void) | undefined
>(undefined);

function BrunoTablePreparedCenterScheduler({
  children,
  subscribeFrameCommit,
}: {
  readonly children: ReactNode;
  readonly subscribeFrameCommit: (listener: () => void) => () => void;
}) {
  const batcher = useBatcher<() => void>(
    (listeners) => {
      flushSync(() => {
        for (const listener of new Set(listeners)) listener();
      });
    },
    {
      wait: 0,
      maxSize: Infinity,
      getShouldExecute: () => false,
      started: true,
      initialState: {},
      key: "",
      onItemsChange: () => {},
      onExecute: () => {},
      onUnmount: (ownedBatcher) => ownedBatcher.cancel(),
    },
  );
  useLayoutEffect(() => subscribeFrameCommit(batcher.flush), [batcher.flush, subscribeFrameCommit]);
  return (
    <BrunoTablePreparedCenterSchedulerContext value={batcher.addItem}>
      {children}
    </BrunoTablePreparedCenterSchedulerContext>
  );
}

function createPreparedCenterProjectionGetter(
  readSnapshot: () => BrunoTableBodyColumnWindowSnapshot,
): () => BrunoTableBodyColumnWindowSnapshot {
  let previous: BrunoTableBodyColumnWindowSnapshot | undefined;
  return () => {
    const next = readSnapshot();
    if (
      previous?.preparedCenter !== undefined &&
      next.preparedCenter === previous.preparedCenter &&
      next.preparedCenterStartIndex === previous.preparedCenterStartIndex &&
      next.preparedSourceCenterStartIndex === previous.preparedSourceCenterStartIndex &&
      next.preparedSourceCenterEndIndex === previous.preparedSourceCenterEndIndex &&
      next.preparedTargetCenterStartIndex === previous.preparedTargetCenterStartIndex &&
      next.preparedTargetCenterEndIndex === previous.preparedTargetCenterEndIndex
    ) {
      return previous;
    }
    previous = next;
    return next;
  };
}

const BrunoTableContextCenterRowProjection = memo(function BrunoTableContextCenterRowProjection({
  activeEditorCenterIndex,
  activeEditorColumnId,
  cellEdit,
  columnIndexOffset,
  draftReviewSource,
  getBodyRowColumnWindowSnapshot,
  instanceId,
  logicalRowIndex,
  onCommittedOutsideCellPointer,
  ownRowSelection,
  pinnedEnd,
  pinnedStart,
  pinnedStartCount,
  renderActiveEditor,
  rowElement,
  rowId,
  rowSelection,
  runtime,
  subscribeBodyRowColumnWindow,
  tableId,
  yieldGridTabStop,
}: BrunoTableContextCenterRowProjectionProps) {
  const schedulePreparedCenterListener = useContext(BrunoTablePreparedCenterSchedulerContext);
  const getPreparedCenterSnapshot = useMemo(() => {
    const readSnapshot =
      getBodyRowColumnWindowSnapshot === undefined
        ? getInactiveBodyColumnWindow
        : () => getBodyRowColumnWindowSnapshot(logicalRowIndex);
    return createPreparedCenterProjectionGetter(readSnapshot);
  }, [getBodyRowColumnWindowSnapshot, logicalRowIndex]);
  const subscribePreparedCenter = useMemo(
    () =>
      subscribeBodyRowColumnWindow === undefined
        ? subscribeInactiveBodyColumnWindow
        : (listener: () => void) => {
            let preparing = getPreparedCenterSnapshot().preparedCenter !== undefined;
            let active = true;
            const notifyIncrementalPreparation = () => {
              if (active) listener();
            };
            const unsubscribe = subscribeBodyRowColumnWindow(logicalRowIndex, () => {
              const nextPreparing = getPreparedCenterSnapshot().preparedCenter !== undefined;
              const incrementalPreparationUpdate = preparing || nextPreparing;
              preparing = nextPreparing;
              if (incrementalPreparationUpdate && schedulePreparedCenterListener !== undefined) {
                schedulePreparedCenterListener(notifyIncrementalPreparation);
              } else listener();
            });
            return () => {
              active = false;
              unsubscribe();
            };
          },
    [
      getPreparedCenterSnapshot,
      logicalRowIndex,
      schedulePreparedCenterListener,
      subscribeBodyRowColumnWindow,
    ],
  );
  const preparedCenterWindow = useSyncExternalStore(
    subscribePreparedCenter,
    getPreparedCenterSnapshot,
    getPreparedCenterSnapshot,
  );
  const ownershipCenter = preparedCenterWindow.preparedCenter ?? preparedCenterWindow.center;
  const ownershipCenterStartIndex =
    preparedCenterWindow.preparedCenterStartIndex ?? preparedCenterWindow.centerStartIndex;
  const ownershipCenterCellIds = useMemo(
    () =>
      ownershipCenter.map((column, index) => {
        const stage = preparedColumnStage(preparedCenterWindow, ownershipCenterStartIndex + index);
        return stage === undefined
          ? cellDomId(instanceId, tableId, rowId, column.columnId)
          : preparedCellDomId(instanceId, tableId, rowId, column.columnId, stage);
      }),
    [instanceId, ownershipCenter, ownershipCenterStartIndex, preparedCenterWindow, rowId, tableId],
  );
  const ownedCellIdentity = useMemo(
    () =>
      brunoTableRowOwnedCellIdentity({
        activeEditorCenterIndex,
        activeEditorColumnId,
        center: ownershipCenter,
        centerCellIds: ownershipCenterCellIds,
        centerStartIndex: ownershipCenterStartIndex,
        instanceId,
        ownRowSelection,
        pinnedEnd,
        pinnedStart,
        rowId,
        rowSelection,
        tableId,
      }),
    [
      activeEditorCenterIndex,
      activeEditorColumnId,
      instanceId,
      ownRowSelection,
      ownershipCenter,
      ownershipCenterCellIds,
      ownershipCenterStartIndex,
      pinnedEnd,
      pinnedStart,
      rowId,
      rowSelection,
      tableId,
    ],
  );
  useLayoutEffect(() => {
    const element = rowElement.current;
    if (element === null) return;
    if (ownedCellIdentity.ariaOwns === "") element.removeAttribute("aria-owns");
    else element.setAttribute("aria-owns", ownedCellIdentity.ariaOwns);
  }, [ownedCellIdentity, rowElement]);
  return (
    <BrunoTableCenterRowProjection
      activeEditorColumnId={activeEditorColumnId}
      cellEdit={cellEdit}
      centerWindow={preparedCenterWindow}
      columnIndexOffset={columnIndexOffset}
      draftReviewSource={draftReviewSource}
      instanceId={instanceId}
      logicalRowIndex={logicalRowIndex}
      onCommittedOutsideCellPointer={onCommittedOutsideCellPointer}
      pinnedStartCount={pinnedStartCount}
      preparedCenter={preparedCenterWindow.preparedCenter}
      preparedCenterStartIndex={preparedCenterWindow.preparedCenterStartIndex}
      renderActiveEditor={renderActiveEditor}
      rowId={rowId}
      runtime={runtime}
      tableId={tableId}
      yieldGridTabStop={yieldGridTabStop}
    />
  );
});

const BrunoTableRow = memo(function BrunoTableRow(props: BrunoTableRowProps) {
  const cellEdit = useContext(BrunoTableCellEditContext);
  const {
    attachBodyLayer,
    rowId,
    instanceId,
    tableId,
    centerStartIndex,
    pinnedStartCount,
    runtime,
    center,
    pinnedStart,
    pinnedEnd,
    leftPadding,
    rightPadding,
    viewportFill,
    logicalRowIndex,
    top,
    width,
    rowSelection,
    renderRowSelection = true,
    ownRowSelection = true,
    columnIndexOffset,
    renderActiveEditor = false,
    activeEditorColumnId,
    activeEditorCenterIndex,
    semanticRowIndex,
    onCommittedOutsideCellPointer,
    yieldGridTabStop,
    projectionSuppressed = false,
    useSharedCenterWindow = false,
    getBodyRowColumnWindowSnapshot,
    subscribeBodyRowColumnWindow,
  } = props;
  const resolvedSemanticRowIndex =
    semanticRowIndex === undefined ? logicalRowIndex + 2 : semanticRowIndex;
  const draftReviewSource = useMemo(
    () => isBrunoTableCellEditDraftReviewSourceRow(runtime.getRowSnapshot(rowId)),
    [runtime, rowId],
  );
  const rowElement = useRef<HTMLTableRowElement | null>(null);
  const previousRowId = useRef(rowId);
  const attachRowElement = useCallback<RefCallback<HTMLTableRowElement>>(
    (element) => {
      rowElement.current = element;
      const detach = attachBodyLayer(element);
      if (element === null) return detach;
      if (useSharedCenterWindow && getBodyRowColumnWindowSnapshot !== undefined) {
        const centerWindow = getBodyRowColumnWindowSnapshot(logicalRowIndex);
        const identity = brunoTableRowOwnedCellIdentity({
          activeEditorCenterIndex,
          activeEditorColumnId,
          center: centerWindow.center,
          centerStartIndex: centerWindow.centerStartIndex,
          instanceId,
          ownRowSelection,
          pinnedEnd,
          pinnedStart,
          rowId,
          rowSelection,
          tableId,
        });
        if (identity.ariaOwns !== "") element.setAttribute("aria-owns", identity.ariaOwns);
      }
      return () => {
        if (rowElement.current === element) rowElement.current = null;
        detach?.();
      };
    },
    [
      activeEditorCenterIndex,
      activeEditorColumnId,
      attachBodyLayer,
      getBodyRowColumnWindowSnapshot,
      instanceId,
      logicalRowIndex,
      ownRowSelection,
      pinnedEnd,
      pinnedStart,
      rowId,
      rowSelection,
      tableId,
      useSharedCenterWindow,
    ],
  );
  const initialCenterWindow = useMemo(() => {
    if (useSharedCenterWindow) return EMPTY_ACTIVE_BODY_COLUMN_WINDOW;
    return Object.freeze({ center, centerStartIndex, leftPadding, rightPadding });
  }, [center, centerStartIndex, leftPadding, rightPadding, useSharedCenterWindow]);
  useLayoutEffect(() => {
    const previous = previousRowId.current;
    previousRowId.current = rowId;
    const element = rowElement.current;
    const activeElement = element?.ownerDocument.activeElement ?? null;
    if (
      previous === rowId ||
      element === null ||
      activeElement === null ||
      !element.contains(activeElement) ||
      !isBrunoTableDocumentFocusChainActive(element.ownerDocument)
    ) {
      return;
    }
    element.closest<HTMLElement>('[role="grid"]')?.focus({ preventScroll: true });
  }, [rowId]);
  const ownedCellIdentity = useMemo(() => {
    return brunoTableRowOwnedCellIdentity({
      activeEditorCenterIndex,
      activeEditorColumnId,
      center: initialCenterWindow.center,
      centerStartIndex: initialCenterWindow.centerStartIndex,
      instanceId,
      ownRowSelection,
      pinnedEnd,
      pinnedStart,
      rowId,
      rowSelection,
      tableId,
    });
  }, [
    activeEditorCenterIndex,
    activeEditorColumnId,
    initialCenterWindow,
    instanceId,
    pinnedEnd,
    pinnedStart,
    rowId,
    rowSelection,
    ownRowSelection,
    tableId,
  ]);
  if (projectionSuppressed) {
    return (
      <tr
        ref={attachRowElement}
        role="presentation"
        aria-hidden="true"
        data-bruno-edit-row-slot={rowId}
        style={{
          display: "table",
          height: ROW_HEIGHT,
          maxHeight: ROW_HEIGHT,
          overflow: "hidden",
          position: "absolute",
          tableLayout: "fixed",
          top,
          width: rowSelectionSurfaceWidth(width, rowSelection),
        }}
      />
    );
  }
  return (
    <tr
      ref={attachRowElement}
      role="row"
      aria-rowindex={resolvedSemanticRowIndex ?? undefined}
      aria-owns={
        useSharedCenterWindow || ownedCellIdentity.ariaOwns === ""
          ? undefined
          : ownedCellIdentity.ariaOwns
      }
      style={{
        display: "table",
        height: ROW_HEIGHT,
        maxHeight: ROW_HEIGHT,
        overflow: "hidden",
        position: "absolute",
        tableLayout: "fixed",
        top,
        willChange: "transform",
        width: rowSelectionSurfaceWidth(width, rowSelection),
      }}
    >
      {__BRUNO_TABLE_TEST_DIAGNOSTICS__ ? (
        <BrunoTableRowCommitDiagnosticProbe
          commitEvidence={props}
          rowId={rowId}
          tableId={tableId}
        />
      ) : null}
      {rowSelection === undefined ? null : renderRowSelection ? (
        <BrunoTableRowSelectionCell
          id={ownedCellIdentity.rowSelectionId}
          logicalRowIndex={logicalRowIndex}
          rowId={rowId}
          selection={rowSelection}
          tableId={tableId}
        />
      ) : (
        <td aria-hidden="true" style={{ padding: 0, width: ROW_SELECTION_COLUMN_WIDTH }} />
      )}
      {pinnedStart.length > 0 ? (
        <td
          aria-hidden="true"
          style={{
            padding: 0,
            width: `var(${brunoTablePinnedWidthCssVariable("start")}, ${String(totalColumnWidth(pinnedStart))}px)`,
          }}
        />
      ) : null}
      {!useSharedCenterWindow ? (
        <BrunoTableCenterRowProjection
          activeEditorColumnId={activeEditorColumnId}
          cellEdit={cellEdit}
          centerWindow={initialCenterWindow}
          columnIndexOffset={columnIndexOffset}
          draftReviewSource={draftReviewSource}
          instanceId={instanceId}
          logicalRowIndex={logicalRowIndex}
          onCommittedOutsideCellPointer={onCommittedOutsideCellPointer}
          pinnedStartCount={pinnedStartCount}
          renderActiveEditor={renderActiveEditor}
          rowId={rowId}
          runtime={runtime}
          tableId={tableId}
          yieldGridTabStop={yieldGridTabStop}
        />
      ) : (
        <BrunoTableContextCenterRowProjection
          activeEditorCenterIndex={activeEditorCenterIndex}
          activeEditorColumnId={activeEditorColumnId}
          cellEdit={cellEdit}
          columnIndexOffset={columnIndexOffset}
          draftReviewSource={draftReviewSource}
          getBodyRowColumnWindowSnapshot={getBodyRowColumnWindowSnapshot}
          instanceId={instanceId}
          logicalRowIndex={logicalRowIndex}
          onCommittedOutsideCellPointer={onCommittedOutsideCellPointer}
          ownRowSelection={ownRowSelection}
          pinnedEnd={pinnedEnd}
          pinnedStart={pinnedStart}
          pinnedStartCount={pinnedStartCount}
          renderActiveEditor={renderActiveEditor}
          rowElement={rowElement}
          rowId={rowId}
          rowSelection={rowSelection}
          runtime={runtime}
          subscribeBodyRowColumnWindow={subscribeBodyRowColumnWindow}
          tableId={tableId}
          yieldGridTabStop={yieldGridTabStop}
        />
      )}
      {pinnedEnd.length > 0 ? (
        <td
          aria-hidden="true"
          style={{
            padding: 0,
            width: rowSelectionViewportFillWidth(viewportFill, rowSelection),
          }}
        />
      ) : null}
      {pinnedEnd.length > 0 ? (
        <td
          aria-hidden="true"
          style={{
            padding: 0,
            width: `var(${brunoTablePinnedWidthCssVariable("end")}, ${String(totalColumnWidth(pinnedEnd))}px)`,
          }}
        />
      ) : null}
    </tr>
  );
});

const BrunoTablePinnedBodyRegion = memo(function BrunoTablePinnedBodyRegion({
  attachBodyLayer,
  columns,
  getRowRangeSnapshot,
  instanceId,
  layerWidth,
  pinnedStartCount,
  precedingColumnCount = 0,
  rowSpace,
  runtime,
  side,
  tableId,
  subscribeRowRange,
  leadingUtilityWidth,
  columnIndexOffset,
  suppressedRowId,
}: {
  readonly attachBodyLayer: RefCallback<HTMLElement>;
  readonly columns: readonly CompiledColumn[];
  readonly instanceId: string;
  readonly getRowRangeSnapshot: () => BrunoTableRowRangeSnapshot;
  readonly layerWidth: number;
  readonly pinnedStartCount: number;
  readonly precedingColumnCount?: number;
  readonly rowSpace: BrunoTableLogicalRowSpace;
  readonly runtime: BrunoTableRuntimeView;
  readonly side: "start" | "end";
  readonly tableId: string;
  readonly subscribeRowRange: (listener: () => void) => () => void;
  readonly leadingUtilityWidth: number;
  readonly columnIndexOffset: number;
  readonly suppressedRowId?: string | undefined;
}) {
  const rowRange = useSyncExternalStore(
    subscribeRowRange,
    getRowRangeSnapshot,
    getRowRangeSnapshot,
  );
  const width = totalColumnWidth(columns);
  const identities = useBrunoTableRowIdentitySnapshot(rowSpace);
  return (
    <BrunoTablePinnedOverlayShell
      layerWidth={layerWidth}
      side={side}
      top={`var(${BRUNO_TABLE_HEADER_HEIGHT_CSS_VARIABLE}, ${String(ROW_HEIGHT)}px)`}
      totalHeight={rowRange.totalHeight}
      width={width}
      leadingUtilityWidth={leadingUtilityWidth}
    >
      {Array.from({ length: rowRange.rowEnd - rowRange.rowStart }, (_, offset) => {
        const logicalRowIndex = rowRange.rowStart + offset;
        const rowId = identities.getRowId(logicalRowIndex);
        return (
          <BrunoTablePinnedBodyRow
            ref={attachBodyLayer}
            key={rowId === undefined ? `slot:${String(offset)}` : `row:${rowId}`}
            columnIndexOffset={columnIndexOffset}
            columns={columns}
            instanceId={instanceId}
            logicalRowIndex={logicalRowIndex}
            pinnedStartCount={pinnedStartCount}
            precedingColumnCount={precedingColumnCount}
            rowId={rowId}
            projectionSuppressed={rowId !== undefined && rowId === suppressedRowId}
            runtime={runtime}
            side={side}
            tableId={tableId}
            top={(rowRange.segmentedRows ? offset : logicalRowIndex) * ROW_HEIGHT}
            width={width}
          />
        );
      })}
    </BrunoTablePinnedOverlayShell>
  );
});

const BrunoTablePinnedBodyRow = memo(
  forwardRef(function BrunoTablePinnedBodyRow(
    {
      columns,
      instanceId,
      logicalRowIndex,
      pinnedStartCount,
      precedingColumnCount,
      rowId,
      runtime,
      side,
      tableId,
      top,
      width,
      columnIndexOffset,
      renderActiveEditor = false,
      onCommittedOutsideCellPointer,
      yieldGridTabStop,
      activeEditorColumnId,
      projectionSuppressed = false,
    }: {
      readonly columns: readonly CompiledColumn[];
      readonly instanceId: string;
      readonly logicalRowIndex: number;
      readonly pinnedStartCount: number;
      readonly precedingColumnCount: number;
      readonly rowId: string | undefined;
      readonly runtime: BrunoTableRuntimeView;
      readonly side: "start" | "end";
      readonly tableId: string;
      readonly top: number;
      readonly width: number;
      readonly columnIndexOffset: number;
      readonly renderActiveEditor?: boolean | undefined;
      readonly onCommittedOutsideCellPointer?:
        | ((rowId: string, columnId: string) => void)
        | undefined;
      readonly yieldGridTabStop?: ((grid: HTMLElement) => void) | undefined;
      readonly activeEditorColumnId?: BrunoTableColumnId | undefined;
      readonly projectionSuppressed?: boolean | undefined;
    },
    ref: ForwardedRef<HTMLTableRowElement>,
  ) {
    const cellEdit = useContext(BrunoTableCellEditContext);
    const draftReviewSource = useMemo(
      () =>
        rowId === undefined
          ? false
          : isBrunoTableCellEditDraftReviewSourceRow(runtime.getRowSnapshot(rowId)),
      [runtime, rowId],
    );
    if (projectionSuppressed) {
      return (
        <tr
          ref={ref}
          role="presentation"
          aria-hidden="true"
          style={{
            display: "table",
            height: ROW_HEIGHT,
            maxHeight: ROW_HEIGHT,
            overflow: "hidden",
            position: "absolute",
            tableLayout: "fixed",
            top,
            width: `var(${brunoTablePinnedWidthCssVariable(side)}, ${String(width)}px)`,
          }}
        />
      );
    }
    return (
      <tr
        ref={ref}
        role="presentation"
        style={{
          display: "table",
          height: ROW_HEIGHT,
          maxHeight: ROW_HEIGHT,
          overflow: "hidden",
          position: "absolute",
          tableLayout: "fixed",
          top,
          willChange: "transform",
          width: `var(${brunoTablePinnedWidthCssVariable(side)}, ${String(width)}px)`,
        }}
      >
        {columns.map((column, index) =>
          rowId === undefined ? (
            <LoadingCell
              key={column.columnId}
              column={column}
              columnIndex={
                columnIndexOffset +
                (side === "start" ? index : pinnedStartCount + precedingColumnCount + index)
              }
              id={loadingCellDomId(instanceId, tableId, logicalRowIndex, column.columnId)}
            />
          ) : column.columnId === activeEditorColumnId ? (
            <td
              key={column.columnId}
              aria-hidden="true"
              style={{
                padding: 0,
                width: `var(${brunoTableColumnCssVariable("width", column.columnId)}, ${String(column.semantics.width)}px)`,
              }}
            />
          ) : cellEdit === undefined && !draftReviewSource ? (
            <BrunoTableReadOnlyCell
              key={column.columnId}
              column={column}
              columnIndex={
                columnIndexOffset +
                (side === "start" ? index : pinnedStartCount + precedingColumnCount + index)
              }
              instanceId={instanceId}
              rowId={rowId}
              runtime={runtime}
              tableId={tableId}
              logicalRowIndex={logicalRowIndex}
              onCommittedOutsideCellPointer={onCommittedOutsideCellPointer}
              renderActiveEditor={renderActiveEditor}
              yieldGridTabStop={yieldGridTabStop}
            />
          ) : (
            <BrunoTableEditableCell
              key={column.columnId}
              column={column}
              columnIndex={
                columnIndexOffset +
                (side === "start" ? index : pinnedStartCount + precedingColumnCount + index)
              }
              instanceId={instanceId}
              rowId={rowId}
              runtime={runtime}
              tableId={tableId}
              logicalRowIndex={logicalRowIndex}
              onCommittedOutsideCellPointer={onCommittedOutsideCellPointer}
              renderActiveEditor={renderActiveEditor}
              yieldGridTabStop={yieldGridTabStop}
              cellEdit={cellEdit}
            />
          ),
        )}
      </tr>
    );
  }),
);

const BrunoTablePinnedOverlayShell = memo(function BrunoTablePinnedOverlayShell({
  children,
  layerWidth,
  side,
  top,
  totalHeight,
  width,
  leadingUtilityWidth,
}: {
  readonly children: ReactNode;
  readonly layerWidth: number;
  readonly side: "start" | "end";
  readonly top: CSSProperties["top"];
  readonly totalHeight: number;
  readonly width: number | string;
  readonly leadingUtilityWidth: number;
}) {
  return (
    <div
      style={{
        display: "flex",
        height: totalHeight,
        insetInlineStart: 0,
        pointerEvents: "none",
        position: "absolute",
        top,
        width: surfaceWidthWithUtility(layerWidth, leadingUtilityWidth),
        zIndex: 3,
      }}
    >
      <div
        data-bruno-pinned-body-region={side}
        data-pinned-region={side}
        style={{
          background: "Canvas",
          height: totalHeight,
          insetInlineEnd: side === "end" ? 0 : undefined,
          insetInlineStart: side === "start" ? leadingUtilityWidth : undefined,
          marginInlineStart: side === "end" ? "auto" : undefined,
          pointerEvents: "auto",
          position: "sticky",
          width: `var(${brunoTablePinnedWidthCssVariable(side)}, ${String(width)}px)`,
        }}
      >
        <table
          role="presentation"
          style={{
            tableLayout: "fixed",
            width: `var(${brunoTablePinnedWidthCssVariable(side)}, ${String(width)}px)`,
          }}
        >
          <tbody
            role="presentation"
            style={{ display: "block", height: totalHeight, position: "relative" }}
          >
            {children}
          </tbody>
        </table>
      </div>
    </div>
  );
});

type BrunoTableCellProps = Readonly<{
  readonly id?: string | undefined;
  readonly runtime: BrunoTableRuntimeView;
  readonly rowId: string;
  readonly instanceId?: string;
  readonly tableId?: string;
  readonly columnIndex?: number;
  readonly column: CompiledColumn;
  readonly logicalRowIndex: number;
  readonly renderActiveEditor?: boolean;
  readonly onCommittedOutsideCellPointer?: ((rowId: string, columnId: string) => void) | undefined;
  readonly yieldGridTabStop?: ((grid: HTMLElement) => void) | undefined;
  readonly preparedStage?: "entering" | "retiring" | undefined;
}>;

function preparedCellDisplay(stage: "entering" | "retiring"): CSSProperties["display"] {
  return stage === "entering"
    ? (`var(${BRUNO_TABLE_PREPARED_ENTERING_DISPLAY_CSS_VARIABLE}, none)` as CSSProperties["display"])
    : (`var(${BRUNO_TABLE_PREPARED_RETIRING_DISPLAY_CSS_VARIABLE}, table-cell)` as CSSProperties["display"]);
}

type BrunoTableDraftReviewCellKind = "base" | "mine" | "server";

type BrunoTableDraftReviewCellProjection = Readonly<{
  readonly candidateText: string | undefined;
  readonly column: ReturnType<BrunoTableCellEditDraftReviewSourceRow["getSnapshot"]>["column"];
  readonly row: object | undefined;
  readonly unavailable: boolean;
  readonly value: unknown;
}>;

function createBrunoTableDraftReviewCellProjectionGetter(
  source: BrunoTableCellEditDraftReviewSourceRow | undefined,
  kind: BrunoTableDraftReviewCellKind | undefined,
): () => BrunoTableDraftReviewCellProjection | undefined {
  let previous: BrunoTableDraftReviewCellProjection | undefined;
  return () => {
    if (source === undefined || kind === undefined) return undefined;
    const snapshot = source.getSnapshot();
    const next =
      kind === "base"
        ? {
            candidateText: undefined,
            column: snapshot.column,
            row: snapshot.baseRow,
            unavailable: false,
            value: snapshot.base,
          }
        : kind === "server"
          ? {
              candidateText: undefined,
              column: snapshot.column,
              row: snapshot.serverRow,
              unavailable: !snapshot.serverValueAvailable,
              value: snapshot.serverNow,
            }
          : {
              candidateText: snapshot.candidateText,
              column: snapshot.column,
              row: snapshot.projectedRow,
              unavailable:
                !snapshot.projectedRowAvailable && cellPresentationUsesRawRow(snapshot.column),
              value: snapshot.mine,
            };
    if (
      previous !== undefined &&
      Object.is(previous.candidateText, next.candidateText) &&
      previous.column === next.column &&
      previous.row === next.row &&
      previous.unavailable === next.unavailable &&
      Object.is(previous.value, next.value)
    ) {
      return previous;
    }
    previous = Object.freeze(next);
    return previous;
  };
}

const BrunoTableCell = memo(function BrunoTableCell(props: BrunoTableCellProps) {
  const cellEdit = useContext(BrunoTableCellEditContext);
  const draftReviewSource = isBrunoTableCellEditDraftReviewSourceRow(
    props.runtime.getRowSnapshot(props.rowId),
  );
  return cellEdit === undefined && !draftReviewSource ? (
    <BrunoTableReadOnlyCell {...props} />
  ) : (
    <BrunoTableEditableCell {...props} cellEdit={cellEdit} />
  );
});

function cellContentMayContainInteractiveDescendant(content: ReactNode): boolean {
  return typeof content === "object" && content !== null;
}

const readOnlyCellStyles = new WeakMap<CompiledColumn, CSSProperties>();

function createReadOnlyCellStyle(
  column: CompiledColumn,
  textAlign: CSSProperties["textAlign"],
): CSSProperties {
  return Object.freeze({
    boxSizing: "border-box",
    height: ROW_HEIGHT,
    maxHeight: ROW_HEIGHT,
    overflow: "hidden",
    padding: 0,
    textAlign,
    transform: `var(${brunoTableColumnCssVariable("transform", column.columnId)}, none)`,
    width: `var(${brunoTableColumnCssVariable("width", column.columnId)}, ${String(column.semantics.width)}px)`,
  } satisfies CSSProperties);
}

function readOnlyCellStyle(
  column: CompiledColumn,
  presentationColumn: CompiledColumn | undefined,
): CSSProperties {
  if (presentationColumn !== undefined && presentationColumn !== column) {
    return createReadOnlyCellStyle(column, presentationColumn.semantics.cellAlign);
  }
  const current = readOnlyCellStyles.get(column);
  if (current !== undefined) return current;
  const next = createReadOnlyCellStyle(column, column.semantics.cellAlign);
  readOnlyCellStyles.set(column, next);
  return next;
}

type BrunoTableReadOnlyCellExternalStore = Readonly<{
  readonly columnId: string;
  readonly getSnapshot: () => BrunoTableCellSnapshot | BrunoTableRowCellSnapshot;
  readonly rowAware: boolean;
  readonly rowId: string;
  readonly runtime: BrunoTableRuntimeView;
  readonly subscribe: (listener: () => void) => () => void;
}>;

function createBrunoTableReadOnlyCellExternalStore({
  columnId,
  rowAware,
  rowId,
  runtime,
}: {
  readonly columnId: string;
  readonly rowAware: boolean;
  readonly rowId: string;
  readonly runtime: BrunoTableRuntimeView;
}): BrunoTableReadOnlyCellExternalStore {
  let initialized = false;
  let snapshot: BrunoTableCellSnapshot | BrunoTableRowCellSnapshot | undefined;
  const readFreshSnapshot = () => {
    snapshot = rowAware
      ? runtime.getRowCellSnapshot(rowId, columnId)
      : runtime.getCellSnapshot(rowId, columnId);
    initialized = true;
    return snapshot;
  };
  const getSnapshot = () =>
    initialized && snapshot !== undefined ? snapshot : readFreshSnapshot();
  return Object.freeze({
    columnId,
    getSnapshot,
    rowAware,
    rowId,
    runtime,
    subscribe: (listener) => {
      const invalidateAndNotify = () => {
        initialized = false;
        listener();
      };
      const unsubscribe = rowAware
        ? runtime.subscribeRowCell(rowId, columnId, invalidateAndNotify)
        : runtime.subscribeCell(rowId, columnId, invalidateAndNotify);
      readFreshSnapshot();
      return unsubscribe;
    },
  });
}

const BrunoTableReadOnlyCell = memo(function BrunoTableReadOnlyCell(props: BrunoTableCellProps) {
  const { runtime, rowId, instanceId, tableId, columnIndex, column, logicalRowIndex } = props;
  const rowAware = cellPresentationUsesRawRow(column);
  const externalStore = useMemo(
    () =>
      createBrunoTableReadOnlyCellExternalStore({
        columnId: column.columnId,
        rowAware,
        rowId,
        runtime,
      }),
    [column.columnId, rowAware, rowId, runtime],
  );
  const snapshot = useSyncExternalStore(
    externalStore.subscribe,
    externalStore.getSnapshot,
    externalStore.getSnapshot,
  );
  const preparedStage = props.preparedStage;
  const cellSnapshot = rowAware ? undefined : (snapshot as BrunoTableCellSnapshot);
  const rowSnapshot = rowAware ? (snapshot as BrunoTableRowCellSnapshot) : undefined;
  const presentationColumn = snapshot.column;
  const row = rowSnapshot?.row;
  const unavailable =
    presentationColumn === undefined ||
    (rowAware ? rowSnapshot?.kind === "unavailable" : cellSnapshot?.kind === "unavailable");
  const rowMissing = rowAware
    ? row === undefined
    : cellSnapshot?.kind === "available" && !cellSnapshot.rowPresent;
  const value = rowAware ? rowSnapshot?.value : cellSnapshot?.value;
  const invalid = isBrunoTableInvalidCellValue(value) ? value : undefined;
  const className =
    invalid || unavailable || rowMissing || presentationColumn === undefined
      ? undefined
      : resolveCellClassName(presentationColumn, row, value);
  const content =
    unavailable || rowMissing || presentationColumn === undefined ? null : invalid ? (
      <span role="alert">{invalidSourceDetails(invalid.invalid)}</span>
    ) : (
      resolveCellContent(presentationColumn, row, value)
    );
  const id =
    props.id ??
    (instanceId === undefined || tableId === undefined || columnIndex === undefined
      ? undefined
      : cellDomId(instanceId, tableId, rowId, column.columnId));
  return (
    <td
      ref={
        __BRUNO_TABLE_TEST_DIAGNOSTICS__
          ? createBrunoTableCellCommitDiagnosticRef({
              columnId: column.columnId,
              commitEvidence: [props, snapshot],
              rowId,
              tableId,
            })
          : undefined
      }
      id={id}
      data-bruno-column-id={column.columnId}
      data-bruno-row-id={rowId}
      data-bruno-row-index={logicalRowIndex}
      aria-colindex={columnIndex === undefined ? undefined : columnIndex + 1}
      className={className}
      role="gridcell"
      style={
        preparedStage === undefined
          ? readOnlyCellStyle(column, presentationColumn)
          : {
              ...readOnlyCellStyle(column, presentationColumn),
              display: preparedCellDisplay(preparedStage),
            }
      }
    >
      {rowMissing ||
      invalid ||
      presentationColumn?.cellRenderer === undefined ||
      !cellContentMayContainInteractiveDescendant(content) ? (
        content
      ) : (
        <div
          className="relative"
          style={{
            boxSizing: "border-box",
            height: ROW_HEIGHT,
            maxHeight: ROW_HEIGHT,
            overflow: "hidden",
            width: "100%",
          }}
        >
          <NonTabbableCellContent key={rowId}>{content}</NonTabbableCellContent>
        </div>
      )}
    </td>
  );
});

const BrunoTableReadOnlyValueCell = memo(function BrunoTableReadOnlyValueCell(
  props: BrunoTableCellProps,
) {
  const { runtime, rowId, instanceId, tableId, columnIndex, column, logicalRowIndex } = props;
  const externalStore = useMemo(
    () =>
      createBrunoTableReadOnlyCellExternalStore({
        columnId: column.columnId,
        rowAware: false,
        rowId,
        runtime,
      }),
    [column.columnId, rowId, runtime],
  );
  const snapshot = useSyncExternalStore(
    externalStore.subscribe,
    externalStore.getSnapshot,
    externalStore.getSnapshot,
  ) as BrunoTableCellSnapshot;
  const preparedStage = props.preparedStage;
  const presentationColumn = snapshot.column;
  const unavailable = presentationColumn === undefined || snapshot.kind === "unavailable";
  const rowMissing = snapshot.kind === "available" && !snapshot.rowPresent;
  const value = snapshot.value;
  const invalid = isBrunoTableInvalidCellValue(value) ? value : undefined;
  const className =
    invalid || unavailable || rowMissing || presentationColumn === undefined
      ? undefined
      : resolveCellClassName(presentationColumn, undefined, value);
  const content =
    unavailable || rowMissing || presentationColumn === undefined ? null : invalid ? (
      <span role="alert">{invalidSourceDetails(invalid.invalid)}</span>
    ) : (
      resolveCellContent(presentationColumn, undefined, value)
    );
  const id =
    props.id ??
    (instanceId === undefined || tableId === undefined || columnIndex === undefined
      ? undefined
      : cellDomId(instanceId, tableId, rowId, column.columnId));
  return (
    <td
      ref={
        __BRUNO_TABLE_TEST_DIAGNOSTICS__
          ? createBrunoTableCellCommitDiagnosticRef({
              columnId: column.columnId,
              commitEvidence: [props, snapshot],
              rowId,
              tableId,
            })
          : undefined
      }
      id={id}
      data-bruno-column-id={column.columnId}
      data-bruno-row-id={rowId}
      data-bruno-row-index={logicalRowIndex}
      aria-colindex={columnIndex === undefined ? undefined : columnIndex + 1}
      className={className}
      role="gridcell"
      style={
        preparedStage === undefined
          ? readOnlyCellStyle(column, presentationColumn)
          : {
              ...readOnlyCellStyle(column, presentationColumn),
              display: preparedCellDisplay(preparedStage),
            }
      }
    >
      {rowMissing ||
      invalid ||
      presentationColumn?.cellRenderer === undefined ||
      !cellContentMayContainInteractiveDescendant(content) ? (
        content
      ) : (
        <div
          className="relative"
          style={{
            boxSizing: "border-box",
            height: ROW_HEIGHT,
            maxHeight: ROW_HEIGHT,
            overflow: "hidden",
            width: "100%",
          }}
        >
          <NonTabbableCellContent key={rowId}>{content}</NonTabbableCellContent>
        </div>
      )}
    </td>
  );
});

const BrunoTableEditableCell = memo(function BrunoTableEditableCell(
  props: BrunoTableCellProps & { readonly cellEdit?: BrunoTableCellEditRuntime | undefined },
) {
  const editCapability = useContext(BrunoTableEditCapabilityContext);
  const {
    runtime,
    rowId,
    instanceId,
    tableId,
    columnIndex,
    column,
    logicalRowIndex,
    renderActiveEditor = false,
    onCommittedOutsideCellPointer,
    yieldGridTabStop,
    cellEdit,
  } = props;
  const preparedStage = props.preparedStage;
  const generatedEditStateDescriptionId = useId();
  const potentialCellEdit =
    cellEdit !== undefined &&
    ((column.kind === "field" && column.isEditable !== undefined && column.isEditable !== false) ||
      cellEdit.hasSaveCellProjection(rowId, column.columnId))
      ? cellEdit
      : undefined;
  const editSubscriptionActive = useRef(false);
  const editSnapshotCache = useRef<{
    cellEdit: BrunoTableCellEditRuntime | undefined;
    columnId: string;
    initialized: boolean;
    rowId: string;
    snapshot: BrunoTableCellEditProjection;
  }>({
    cellEdit: undefined,
    columnId: "",
    initialized: false,
    rowId: "",
    snapshot: NO_CELL_EDIT_PROJECTION,
  });
  const subscribeEdit = useMemo(
    () => (listener: () => void) => {
      if (potentialCellEdit === undefined) {
        editSubscriptionActive.current = false;
        return () => undefined;
      }
      editSubscriptionActive.current = true;
      const unsubscribe = potentialCellEdit.subscribeCell(rowId, column.columnId, listener);
      return () => {
        editSubscriptionActive.current = false;
        unsubscribe();
      };
    },
    [potentialCellEdit, column.columnId, rowId],
  );
  const getEditSnapshot = useMemo(
    () => () => {
      const cache = editSnapshotCache.current;
      const cacheMatches =
        cache.cellEdit === potentialCellEdit &&
        cache.columnId === column.columnId &&
        cache.rowId === rowId;
      if (!editSubscriptionActive.current && cache.initialized && cacheMatches) {
        return cache.snapshot;
      }
      const snapshot =
        potentialCellEdit === undefined
          ? NO_CELL_EDIT_PROJECTION
          : potentialCellEdit.getCellSnapshot(rowId, column.columnId);
      editSnapshotCache.current = {
        cellEdit: potentialCellEdit,
        columnId: column.columnId,
        initialized: true,
        rowId,
        snapshot,
      };
      return snapshot;
    },
    [potentialCellEdit, column.columnId, rowId],
  );
  const edit = useSyncExternalStore(subscribeEdit, getEditSnapshot, getEditSnapshot);
  const effectivePresentationColumn =
    edit.acceptedOverlayPresentationColumn ?? edit.draftPresentationColumn ?? column;
  const initialRow = runtime.getRowSnapshot(rowId);
  const initialDraftReviewSource = isBrunoTableCellEditDraftReviewSourceRow(initialRow)
    ? initialRow
    : undefined;
  const draftReviewColumnLabelSource =
    initialDraftReviewSource !== undefined &&
    effectivePresentationColumn.kind === "field" &&
    effectivePresentationColumn.field === "columnLabel"
      ? initialDraftReviewSource
      : undefined;
  const subscribeDraftReviewColumnLabel = useMemo(
    () =>
      draftReviewColumnLabelSource === undefined
        ? (_listener: () => void) => () => undefined
        : draftReviewColumnLabelSource.subscribe,
    [draftReviewColumnLabelSource],
  );
  const getDraftReviewColumnLabelSnapshot = useMemo(
    () => () => draftReviewColumnLabelSource?.getSnapshot().columnLabel,
    [draftReviewColumnLabelSource],
  );
  const draftReviewColumnLabel = useSyncExternalStore(
    subscribeDraftReviewColumnLabel,
    getDraftReviewColumnLabelSnapshot,
    getDraftReviewColumnLabelSnapshot,
  );
  // Review rows intentionally skip the grid's row-cell subscription: their reactive value and
  // presentation snapshots arrive through subscribeDraftReview, avoiding duplicate listeners.
  const rowAware =
    initialDraftReviewSource !== undefined ||
    cellPresentationUsesRawRow(effectivePresentationColumn);
  const initialRowSnapshot = rowAware
    ? runtime.getRowCellSnapshot(rowId, column.columnId)
    : undefined;
  const subscribe = useMemo(
    () => (listener: () => void) => {
      if (!rowAware) return runtime.subscribeCell(rowId, column.columnId, listener);
      return initialDraftReviewSource === undefined
        ? runtime.subscribeRowCell(rowId, column.columnId, listener)
        : () => undefined;
    },
    [column.columnId, initialDraftReviewSource, rowAware, rowId, runtime],
  );
  const getSnapshot = useMemo(
    () => () =>
      initialDraftReviewSource !== undefined && initialRowSnapshot !== undefined
        ? initialRowSnapshot
        : rowAware
          ? runtime.getRowCellSnapshot(rowId, column.columnId)
          : runtime.getCellSnapshot(rowId, column.columnId),
    [column.columnId, initialDraftReviewSource, initialRowSnapshot, rowAware, rowId, runtime],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const cellSnapshot = rowAware ? undefined : (snapshot as BrunoTableCellSnapshot);
  const rowSnapshot = rowAware ? (snapshot as BrunoTableRowCellSnapshot) : undefined;
  const presentationColumn =
    edit.acceptedOverlayPresentationColumn ?? edit.draftPresentationColumn ?? snapshot.column;
  const row = rowSnapshot?.row;
  const draftReviewSource = initialDraftReviewSource;
  const draftReviewKind: BrunoTableDraftReviewCellKind | undefined =
    draftReviewSource !== undefined &&
    presentationColumn?.kind === "field" &&
    presentationColumn.field === "baseText"
      ? "base"
      : draftReviewSource !== undefined &&
          presentationColumn?.kind === "field" &&
          presentationColumn.field === "serverText"
        ? "server"
        : draftReviewSource !== undefined &&
            presentationColumn?.kind === "field" &&
            presentationColumn.field === "mineText"
          ? "mine"
          : undefined;
  const subscribeDraftReview = useMemo(
    () =>
      draftReviewSource === undefined || draftReviewKind === undefined
        ? (_listener: () => void) => () => undefined
        : (listener: () => void) => {
            if (__BRUNO_TABLE_TEST_DIAGNOSTICS__ && tableId !== undefined) {
              recordBrunoTableReviewCellSubscription({
                tableId,
                rowId,
                columnId: column.columnId,
                source: "review-value-projection",
                phase: "subscribe",
              });
            }
            const unsubscribe = draftReviewSource.subscribe(listener);
            return () => {
              unsubscribe();
              if (__BRUNO_TABLE_TEST_DIAGNOSTICS__ && tableId !== undefined) {
                recordBrunoTableReviewCellSubscription({
                  tableId,
                  rowId,
                  columnId: column.columnId,
                  source: "review-value-projection",
                  phase: "unsubscribe",
                });
              }
            };
          },
    [column.columnId, draftReviewKind, draftReviewSource, rowId, tableId],
  );
  const getDraftReviewSnapshot = useMemo(
    () => createBrunoTableDraftReviewCellProjectionGetter(draftReviewSource, draftReviewKind),
    [draftReviewKind, draftReviewSource],
  );
  const draftReview = useSyncExternalStore(
    subscribeDraftReview,
    getDraftReviewSnapshot,
    getDraftReviewSnapshot,
  );
  const draftReviewRow = draftReview?.row;
  const draftReviewValue = draftReview?.value;
  const draftReviewValueUnavailable = draftReview?.unavailable === true;
  const draftReviewCandidateText = draftReview?.candidateText;
  const draftReviewPresentationAvailable =
    draftReview !== undefined &&
    !draftReviewValueUnavailable &&
    (draftReviewRow !== undefined || !cellPresentationUsesRawRow(draftReview.column));
  const unavailable =
    presentationColumn === undefined ||
    (rowAware ? rowSnapshot?.kind === "unavailable" : cellSnapshot?.kind === "unavailable");
  const rowMissing = rowAware
    ? row === undefined
    : cellSnapshot?.kind === "available" && !cellSnapshot.rowPresent;
  const sourceValue =
    draftReviewColumnLabel ?? (rowAware ? rowSnapshot?.value : cellSnapshot?.value);
  const value = edit.hasAcceptedOverlay
    ? edit.acceptedOverlay
    : edit.hasDraft
      ? edit.draft
      : sourceValue;
  const invalid = isBrunoTableInvalidCellValue(value) ? value : undefined;
  const className =
    draftReviewValueUnavailable || draftReviewCandidateText !== undefined
      ? undefined
      : draftReviewPresentationAvailable
        ? resolveProxyCellClassName(draftReview.column, draftReviewRow, draftReviewValue)
        : invalid || unavailable || rowMissing || presentationColumn === undefined
          ? undefined
          : resolveCellClassName(presentationColumn, row, value);
  const content =
    draftReviewCandidateText !== undefined ? (
      draftReviewCandidateText
    ) : draftReviewValueUnavailable ? (
      "Unavailable"
    ) : draftReviewPresentationAvailable ? (
      resolveCellContent(draftReview.column, draftReviewRow, draftReviewValue)
    ) : unavailable || rowMissing || presentationColumn === undefined ? null : invalid ? (
      <span role="alert">{invalidSourceDetails(invalid.invalid)}</span>
    ) : (
      resolveCellContent(presentationColumn, row, value)
    );
  const id =
    props.id ??
    (instanceId === undefined || tableId === undefined || columnIndex === undefined
      ? undefined
      : cellDomId(instanceId, tableId, rowId, column.columnId));
  const editStateDescription =
    edit.blockedReason === undefined
      ? edit.conflicted
        ? "The server value conflicts with your unsaved change."
        : undefined
      : edit.conflicted
        ? `${edit.blockedReason} The server value also conflicts with your unsaved change.`
        : edit.blockedReason;
  const editStateDescriptionId =
    editStateDescription === undefined
      ? undefined
      : `${id ?? generatedEditStateDescriptionId}-edit-state-description`;
  const cellStyle: CSSProperties = {
    boxSizing: "border-box",
    height: ROW_HEIGHT,
    maxHeight: ROW_HEIGHT,
    overflow: edit.active ? "visible" : "hidden",
    padding: 0,
    position: edit.active || edit.conflicted || edit.saveSucceeded ? "relative" : undefined,
    textAlign:
      draftReviewKind === undefined
        ? presentationColumn?.semantics.cellAlign
        : draftReview?.column.semantics.cellAlign,
    transform: `var(${brunoTableColumnCssVariable("transform", column.columnId)}, none)`,
    width: `var(${brunoTableColumnCssVariable("width", column.columnId)}, ${String(column.semantics.width)}px)`,
    zIndex: edit.active ? 10 : undefined,
  };
  const cellContent =
    edit.active && cellEdit !== undefined && renderActiveEditor && editCapability !== undefined ? (
      <editCapability.CellEditBoundary
        column={column}
        describedById={editStateDescriptionId}
        onCommittedOutsideCellPointer={onCommittedOutsideCellPointer}
        runtime={cellEdit}
        yieldGridTabStop={yieldGridTabStop}
      />
    ) : edit.active && cellEdit !== undefined ? null : (
      <div
        className="relative"
        style={{
          boxSizing: "border-box",
          height: ROW_HEIGHT,
          maxHeight: ROW_HEIGHT,
          overflow: "hidden",
          width: "100%",
        }}
      >
        {rowMissing ||
        invalid ||
        presentationColumn?.cellRenderer === undefined ||
        !cellContentMayContainInteractiveDescendant(content) ? (
          content
        ) : (
          <NonTabbableCellContent key={rowId}>{content}</NonTabbableCellContent>
        )}
        {edit.savePending ? (
          <span aria-hidden="true" className="absolute inset-y-0 end-1 flex items-center">
            <Spinner size={14} />
          </span>
        ) : edit.saveFailed ? (
          <span
            aria-hidden="true"
            className="absolute inset-y-0 end-1 flex items-center font-bold text-destructive"
          >
            !
          </span>
        ) : null}
      </div>
    );
  return (
    <td
      ref={
        __BRUNO_TABLE_TEST_DIAGNOSTICS__
          ? createBrunoTableCellCommitDiagnosticRef({
              columnId: column.columnId,
              commitEvidence: [props, snapshot, edit, draftReview, draftReviewColumnLabel],
              rowId,
              tableId,
            })
          : undefined
      }
      id={id}
      data-bruno-column-id={column.columnId}
      data-bruno-row-id={rowId}
      data-bruno-row-index={logicalRowIndex}
      aria-colindex={columnIndex === undefined ? undefined : columnIndex + 1}
      aria-describedby={editStateDescriptionId}
      aria-busy={edit.savePending || undefined}
      className={className}
      data-bruno-edit-blocked={edit.blockedReason === undefined ? undefined : ""}
      data-bruno-edit-conflicted={edit.conflicted ? "" : undefined}
      data-bruno-save-pending={edit.savePending ? "" : undefined}
      data-bruno-save-failed={edit.saveFailed ? "" : undefined}
      data-bruno-save-success={edit.saveSucceeded ? "" : undefined}
      role="gridcell"
      style={
        preparedStage !== undefined || edit.conflicted
          ? {
              ...cellStyle,
              ...(edit.conflicted ? { boxShadow: "inset 0 0 0 2px var(--destructive)" } : {}),
              ...(preparedStage === undefined
                ? {}
                : { display: preparedCellDisplay(preparedStage) }),
            }
          : cellStyle
      }
    >
      {editStateDescriptionId === undefined ? null : (
        <span aria-hidden="true" className="sr-only" id={editStateDescriptionId}>
          {editStateDescription}
        </span>
      )}
      {cellContent}
      {edit.conflicted ? (
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute inset-y-0 flex items-center text-destructive ${edit.saveFailed ? "end-6" : "end-1"}`}
          data-bruno-edit-conflict-indicator=""
          title="Conflicts with the latest server value"
        >
          <WarningDiamondIcon size={16} weight="fill" />
        </span>
      ) : null}
    </td>
  );
});

const BrunoTableEditOwnedRow = memo(function BrunoTableEditOwnedRow({
  attachPinnedEditorHost,
  adjustVerticalByLogical,
  columnIndexOffset,
  editRuntime,
  gridElement,
  getColumnWindowSnapshot,
  getRowRangeSnapshot,
  instanceId,
  logicalColumns,
  navigation,
  pinnedEnd,
  pinnedStart,
  pinnedStartCount,
  rowSelection,
  rowSpace,
  subscribeColumnWindow,
  subscribeRowRange,
  tableId,
  viewRuntime,
  viewportFill,
  width,
  yieldGridTabStop,
}: {
  readonly attachPinnedEditorHost: RefCallback<HTMLElement>;
  readonly adjustVerticalByLogical: (delta: number) => number | undefined;
  readonly columnIndexOffset: number;
  readonly editRuntime: BrunoTableCellEditRuntime;
  readonly gridElement: RefObject<HTMLDivElement | null>;
  readonly getColumnWindowSnapshot: () => BrunoTableBodyColumnWindowSnapshot;
  readonly getRowRangeSnapshot: () => BrunoTableRowRangeSnapshot;
  readonly instanceId: string;
  readonly logicalColumns: readonly CompiledColumn[];
  readonly navigation: BrunoTableNavigationRuntime;
  readonly pinnedEnd: readonly CompiledColumn[];
  readonly pinnedStart: readonly CompiledColumn[];
  readonly pinnedStartCount: number;
  readonly rowSelection?: BrunoTableRowSelectionRuntime | undefined;
  readonly rowSpace: BrunoTableLogicalRowSpace;
  readonly subscribeColumnWindow: (listener: () => void) => () => void;
  readonly subscribeRowRange: (listener: () => void) => () => void;
  readonly tableId: string;
  readonly viewRuntime: BrunoTableRuntimeView;
  readonly viewportFill: number;
  readonly width: number;
  readonly yieldGridTabStop: (grid: HTMLElement) => void;
}) {
  const editCapability = useContext(BrunoTableEditCapabilityContext);
  const session = useSyncExternalStore(
    editRuntime.subscribeSession,
    editRuntime.getSessionSnapshot,
    editRuntime.getSessionSnapshot,
  );
  const editing = session.kind === "editing";
  const liveColumnWindow = useSyncExternalStore(
    editing ? subscribeColumnWindow : subscribeInactiveBodyColumnWindow,
    editing ? getColumnWindowSnapshot : getInactiveBodyColumnWindow,
    editing ? getColumnWindowSnapshot : getInactiveBodyColumnWindow,
  );
  const liveRowRange = useSyncExternalStore(
    editing ? subscribeRowRange : subscribeInactiveBodyColumnWindow,
    editing ? getRowRangeSnapshot : getInactiveRowRange,
    editing ? getRowRangeSnapshot : getInactiveRowRange,
  );
  const { center, centerStartIndex, leftPadding, rightPadding } = liveColumnWindow;
  const { rowEnd, rowStart } = liveRowRange;
  const layer = useRef<HTMLDivElement>(null);
  const [geometry] = useState(() => {
    if (editCapability === undefined) {
      throw new TypeError("BrunoTable cell edit geometry requires the Client edit capability.");
    }
    return editCapability.createEditGeometry();
  });
  const rowIndex = session.kind === "editing" ? rowSpace.findRowIndex(session.rowId) : undefined;
  useLayoutEffect(() => {
    if (session.kind !== "editing") {
      geometry.release();
      return;
    }
    editRuntime.reconcileMovementRowIndex(rowIndex);
    editRuntime.reconcileActiveRow();
    const grid = gridElement.current;
    const container = layer.current;
    if (grid === null || container === null) return;
    if (rowIndex !== undefined) {
      navigation.activateBody(rowIndex, session.rowId, session.columnId);
    }
    geometry.reconcile({
      adjustVerticalByLogical,
      grid,
      layer: container,
      rowHeight: ROW_HEIGHT,
      rowId: session.rowId,
      rowIndex,
    });
  }, [
    geometry,
    adjustVerticalByLogical,
    center,
    gridElement,
    navigation,
    pinnedEnd,
    pinnedStart,
    rowEnd,
    rowIndex,
    rowSpace,
    rowStart,
    editRuntime,
    session,
  ]);
  useLayoutEffect(() => () => geometry.release(), [geometry]);
  const activateOutsideCell = useCallback(
    (rowId: string, columnId: string): void => {
      const nextRowIndex = rowSpace.findRowIndex(rowId);
      if (nextRowIndex !== undefined) navigation.activateBody(nextRowIndex, rowId, columnId);
    },
    [navigation, rowSpace],
  );
  if (session.kind !== "editing") return null;
  const detached = rowIndex === undefined;
  const activeColumn = logicalColumns.find((column) => column.columnId === session.columnId);
  const pinnedColumnIds = new Set([...pinnedStart, ...pinnedEnd].map((column) => column.columnId));
  const allCenter = logicalColumns.filter((column) => !pinnedColumnIds.has(column.columnId));
  const activeCenterIndex = activeColumn === undefined ? -1 : allCenter.indexOf(activeColumn);
  const activePinnedStartIndex =
    activeColumn === undefined ? -1 : pinnedStart.indexOf(activeColumn);
  const activePinnedEndIndex = activeColumn === undefined ? -1 : pinnedEnd.indexOf(activeColumn);
  const utilityWidth = rowSelection === undefined ? 0 : ROW_SELECTION_COLUMN_WIDTH;
  const activeCenterOffset =
    activeCenterIndex < 0
      ? undefined
      : utilityWidth +
        totalColumnWidth(pinnedStart) +
        totalColumnWidth(allCenter.slice(0, activeCenterIndex));
  const surfaceWidth = rowSelectionSurfaceWidth(width, rowSelection);
  const activeEditorOffset =
    activePinnedStartIndex >= 0
      ? `calc(var(${BRUNO_TABLE_VIEWPORT_LOGICAL_SCROLL_LEFT_CSS_VARIABLE}, 0px) + ${String(
          utilityWidth + totalColumnWidth(pinnedStart.slice(0, activePinnedStartIndex)),
        )}px)`
      : activePinnedEndIndex >= 0
        ? `calc(var(${BRUNO_TABLE_VIEWPORT_LOGICAL_SCROLL_LEFT_CSS_VARIABLE}, 0px) + var(${BRUNO_TABLE_VIEWPORT_INLINE_SIZE_CSS_VARIABLE}, ${String(
            surfaceWidth,
          )}) - ${String(
            totalColumnWidth(pinnedEnd) -
              totalColumnWidth(pinnedEnd.slice(0, activePinnedEndIndex)),
          )}px)`
        : activeCenterOffset;
  const activeEditorZIndex = activePinnedStartIndex >= 0 || activePinnedEndIndex >= 0 ? 3 : 2;
  const cancelAndFocus = () => {
    editRuntime.cancel();
    gridElement.current?.focus({ preventScroll: true });
  };
  return (
    <div
      ref={layer}
      data-bruno-cell-edit-surface=""
      data-bruno-edit-owned-row=""
      style={
        {
          [BRUNO_TABLE_LIVE_LEFT_PADDING_CSS_VARIABLE]: `${String(leftPadding)}px`,
          [BRUNO_TABLE_LIVE_RIGHT_PADDING_CSS_VARIABLE]: `${String(rightPadding)}px`,
          background: "Canvas",
          insetInlineStart: 0,
          position: "absolute",
          top: 0,
          width: surfaceWidth,
          zIndex: 3,
        } as CSSProperties
      }
    >
      <table role="presentation" style={{ tableLayout: "fixed", width: surfaceWidth }}>
        <tbody role="presentation" style={{ display: "block", height: ROW_HEIGHT }}>
          <BrunoTableRow
            activeEditorColumnId={
              activeCenterIndex < 0 ? undefined : (session.columnId as BrunoTableColumnId)
            }
            activeEditorCenterIndex={activeCenterIndex < 0 ? undefined : activeCenterIndex}
            attachBodyLayer={IGNORE_BODY_LAYER_REF}
            center={center}
            centerStartIndex={centerStartIndex}
            columnIndexOffset={columnIndexOffset}
            instanceId={instanceId}
            leftPadding={leftPadding}
            logicalRowIndex={rowIndex ?? 0}
            ownRowSelection={!detached}
            onCommittedOutsideCellPointer={activateOutsideCell}
            pinnedEnd={pinnedEnd}
            pinnedStart={pinnedStart}
            pinnedStartCount={pinnedStartCount}
            rightPadding={rightPadding}
            rowId={session.rowId}
            rowSelection={rowSelection}
            renderRowSelection={false}
            runtime={viewRuntime}
            semanticRowIndex={detached ? null : rowIndex + 2}
            tableId={tableId}
            top={0}
            viewportFill={viewportFill}
            width={width}
            yieldGridTabStop={yieldGridTabStop}
          />
        </tbody>
      </table>
      {rowSelection === undefined || detached ? null : (
        <div
          data-bruno-edit-owned-selection=""
          style={{
            height: ROW_HEIGHT,
            insetInlineStart: 0,
            pointerEvents: "none",
            position: "absolute",
            top: 0,
            width: surfaceWidth,
            zIndex: 5,
          }}
        >
          <table
            role="presentation"
            style={{
              insetInlineStart: 0,
              pointerEvents: "auto",
              position: "sticky",
              tableLayout: "fixed",
              width: ROW_SELECTION_COLUMN_WIDTH,
            }}
          >
            <tbody role="presentation">
              <tr
                role="presentation"
                style={{
                  display: "table",
                  tableLayout: "fixed",
                  width: ROW_SELECTION_COLUMN_WIDTH,
                }}
              >
                <BrunoTableRowSelectionCell
                  id={cellDomId(
                    instanceId,
                    tableId,
                    session.rowId,
                    BRUNO_TABLE_ROW_SELECTION_COLUMN_ID,
                  )}
                  logicalRowIndex={rowIndex ?? 0}
                  rowId={session.rowId}
                  selection={rowSelection}
                  tableId={tableId}
                />
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {activeColumn === undefined || activeEditorOffset === undefined ? null : (
        <table
          ref={
            activePinnedStartIndex >= 0 || activePinnedEndIndex >= 0
              ? attachPinnedEditorHost
              : undefined
          }
          data-bruno-active-editor=""
          role="presentation"
          style={{
            insetInlineStart: activeEditorOffset,
            pointerEvents: "auto",
            position: "absolute",
            tableLayout: "fixed",
            top: 0,
            width: `var(${brunoTableColumnCssVariable("width", activeColumn.columnId)}, ${String(activeColumn.semantics.width)}px)`,
            zIndex: activeEditorZIndex,
          }}
        >
          <tbody role="presentation">
            <tr
              role="presentation"
              style={{ display: "table", tableLayout: "fixed", width: "100%" }}
            >
              <BrunoTableCell
                column={activeColumn}
                columnIndex={
                  columnIndexOffset +
                  (activePinnedStartIndex >= 0
                    ? activePinnedStartIndex
                    : activeCenterIndex >= 0
                      ? pinnedStartCount + activeCenterIndex
                      : pinnedStartCount + allCenter.length + activePinnedEndIndex)
                }
                instanceId={instanceId}
                logicalRowIndex={rowIndex ?? 0}
                onCommittedOutsideCellPointer={activateOutsideCell}
                renderActiveEditor
                rowId={session.rowId}
                runtime={viewRuntime}
                tableId={tableId}
                yieldGridTabStop={yieldGridTabStop}
              />
            </tr>
          </tbody>
        </table>
      )}
      {pinnedStart.length === 0 ? null : (
        <BrunoTablePinnedOverlayShell
          layerWidth={width}
          leadingUtilityWidth={utilityWidth}
          side="start"
          top={0}
          totalHeight={ROW_HEIGHT}
          width={totalColumnWidth(pinnedStart)}
        >
          <BrunoTablePinnedBodyRow
            columnIndexOffset={columnIndexOffset}
            columns={pinnedStart}
            instanceId={instanceId}
            logicalRowIndex={rowIndex ?? 0}
            onCommittedOutsideCellPointer={activateOutsideCell}
            pinnedStartCount={pinnedStartCount}
            precedingColumnCount={0}
            activeEditorColumnId={
              activePinnedStartIndex < 0 ? undefined : (session.columnId as BrunoTableColumnId)
            }
            rowId={session.rowId}
            runtime={viewRuntime}
            side="start"
            tableId={tableId}
            top={0}
            width={totalColumnWidth(pinnedStart)}
            yieldGridTabStop={yieldGridTabStop}
          />
        </BrunoTablePinnedOverlayShell>
      )}
      {pinnedEnd.length === 0 ? null : (
        <BrunoTablePinnedOverlayShell
          layerWidth={width}
          leadingUtilityWidth={utilityWidth}
          side="end"
          top={0}
          totalHeight={ROW_HEIGHT}
          width={totalColumnWidth(pinnedEnd)}
        >
          <BrunoTablePinnedBodyRow
            columnIndexOffset={columnIndexOffset}
            columns={pinnedEnd}
            instanceId={instanceId}
            logicalRowIndex={rowIndex ?? 0}
            onCommittedOutsideCellPointer={activateOutsideCell}
            pinnedStartCount={pinnedStartCount}
            precedingColumnCount={allCenter.length}
            activeEditorColumnId={
              activePinnedEndIndex < 0 ? undefined : (session.columnId as BrunoTableColumnId)
            }
            rowId={session.rowId}
            runtime={viewRuntime}
            side="end"
            tableId={tableId}
            top={0}
            width={totalColumnWidth(pinnedEnd)}
            yieldGridTabStop={yieldGridTabStop}
          />
        </BrunoTablePinnedOverlayShell>
      )}
      {detached ? (
        <div
          role={session.rowMissing ? "alert" : "status"}
          style={{ background: "Canvas", border: "1px solid currentColor", padding: 4 }}
        >
          {session.rowMissing
            ? "This row was removed from the server. Changes cannot be saved."
            : "Row no longer matches current filters"}
          <button data-bruno-cell-edit-cancel="" type="button" onClick={cancelAndFocus}>
            Cancel editing
          </button>
        </div>
      ) : null}
    </div>
  );
});

const IGNORE_BODY_LAYER_REF: RefCallback<HTMLElement> = () => undefined;

const NON_TABBABLE_CELL_CONTENT_ATTRIBUTE = "data-bruno-nontabbable-cell-content";
const NON_TABBABLE_CELL_CONTENT_SELECTOR = `[${NON_TABBABLE_CELL_CONTENT_ATTRIBUTE}]`;
const NON_TABBABLE_MUTATION_ATTRIBUTES = [
  "aria-hidden",
  "class",
  "contenteditable",
  "controls",
  "disabled",
  "hidden",
  "href",
  "inert",
  "style",
  "tabindex",
] as const;

type NonTabbableCellTracking = {
  readonly originalTabIndexes: WeakMap<InteractiveDomElement, string | null>;
  readonly pendingManagedTabIndexWrites: WeakMap<InteractiveDomElement, number>;
  readonly trackedCandidates: Set<InteractiveDomElement>;
  focusedCandidate: InteractiveDomElement | null;
};

type NonTabbableGridManager = {
  readonly register: (root: HTMLSpanElement) => () => void;
};

const nonTabbableGridManagers = new WeakMap<HTMLElement, NonTabbableGridManager>();

function createNonTabbableGridManager(grid: HTMLElement): NonTabbableGridManager {
  const ownerDocument = grid.ownerDocument;
  const roots = new Map<HTMLSpanElement, NonTabbableCellTracking | undefined>();
  const trackingFor = (root: HTMLSpanElement) => {
    let tracking = roots.get(root);
    if (tracking !== undefined) return tracking;
    tracking = {
      originalTabIndexes: new WeakMap(),
      pendingManagedTabIndexWrites: new WeakMap(),
      trackedCandidates: new Set(),
      focusedCandidate: null,
    };
    roots.set(root, tracking);
    return tracking;
  };
  const restoreTabIndex = (tracking: NonTabbableCellTracking, candidate: InteractiveDomElement) => {
    const tabIndex = tracking.originalTabIndexes.get(candidate);
    if (tabIndex === null) candidate.removeAttribute("tabindex");
    else if (tabIndex !== undefined) candidate.setAttribute("tabindex", tabIndex);
  };
  const writeManagedTabIndex = (
    tracking: NonTabbableCellTracking,
    candidate: InteractiveDomElement,
  ) => {
    tracking.pendingManagedTabIndexWrites.set(
      candidate,
      (tracking.pendingManagedTabIndexWrites.get(candidate) ?? 0) + 1,
    );
    candidate.setAttribute("tabindex", "-1");
  };
  const reconcileRoot = (root: HTMLSpanElement, records: readonly MutationRecord[] = []) => {
    let tracking = roots.get(root);
    for (const record of records) {
      const target = asBrunoTableRealmInteractiveElement(grid, record.target);
      if (
        tracking === undefined ||
        record.type !== "attributes" ||
        record.attributeName !== "tabindex" ||
        target === null
      ) {
        continue;
      }
      const managedWrites = tracking.pendingManagedTabIndexWrites.get(target) ?? 0;
      if (managedWrites > 0) {
        if (managedWrites === 1) tracking.pendingManagedTabIndexWrites.delete(target);
        else tracking.pendingManagedTabIndexWrites.set(target, managedWrites - 1);
        continue;
      }
      if (tracking.trackedCandidates.has(target)) {
        tracking.originalTabIndexes.set(target, target.getAttribute("tabindex"));
      }
    }
    if (tracking !== undefined) {
      for (const candidate of tracking.trackedCandidates) {
        if (root.contains(candidate)) continue;
        const recoverGridFocus =
          candidate === tracking.focusedCandidate &&
          ownerDocument.activeElement === ownerDocument.body &&
          isBrunoTableDocumentFocusChainActive(ownerDocument);
        restoreTabIndex(tracking, candidate);
        tracking.trackedCandidates.delete(candidate);
        if (candidate === tracking.focusedCandidate) tracking.focusedCandidate = null;
        if (recoverGridFocus) grid.focus({ preventScroll: true });
      }
    }
    for (const candidate of root.querySelectorAll<InteractiveDomElement>(
      INTERACTIVE_DESCENDANT_SELECTOR,
    )) {
      tracking ??= trackingFor(root);
      if (!tracking.trackedCandidates.has(candidate)) {
        tracking.originalTabIndexes.set(candidate, candidate.getAttribute("tabindex"));
        tracking.trackedCandidates.add(candidate);
      }
      if (candidate.getAttribute("tabindex") !== "-1") writeManagedTabIndex(tracking, candidate);
    }
    if (
      tracking?.focusedCandidate !== null &&
      tracking?.focusedCandidate !== undefined &&
      root.contains(tracking.focusedCandidate) &&
      (ownerDocument.activeElement === ownerDocument.body ||
        (ownerDocument.activeElement !== null &&
          tracking.focusedCandidate.contains(ownerDocument.activeElement))) &&
      !interactiveDescendantIsUsable(tracking.focusedCandidate) &&
      isBrunoTableDocumentFocusChainActive(ownerDocument)
    ) {
      tracking.focusedCandidate = null;
      grid.focus({ preventScroll: true });
    }
  };
  const observer = new MutationObserver((records) => {
    const affectedRoots = new Map<HTMLSpanElement, MutationRecord[]>();
    for (const record of records) {
      const target = asBrunoTableRealmElement(grid, record.target);
      if (target === null) continue;
      const root = target.closest<HTMLSpanElement>(NON_TABBABLE_CELL_CONTENT_SELECTOR);
      if (root === null || !roots.has(root)) continue;
      const rootRecords = affectedRoots.get(root);
      if (rootRecords === undefined) affectedRoots.set(root, [record]);
      else rootRecords.push(record);
    }
    for (const [root, rootRecords] of affectedRoots) reconcileRoot(root, rootRecords);
  });
  observer.observe(grid, {
    attributes: true,
    attributeFilter: [...NON_TABBABLE_MUTATION_ATTRIBUTES],
    childList: true,
    subtree: true,
  });
  const trackFocusedCandidate = (event: FocusEvent) => {
    const target = asBrunoTableRealmInteractiveElement(grid, event.target);
    if (target === null) return;
    const root = target.closest<HTMLSpanElement>(NON_TABBABLE_CELL_CONTENT_SELECTOR);
    if (root === null || !roots.has(root)) return;
    trackingFor(root).focusedCandidate = target;
  };
  grid.addEventListener("focusin", trackFocusedCandidate);
  const manager: NonTabbableGridManager = {
    register: (root) => {
      roots.set(root, undefined);
      reconcileRoot(root);
      root.removeAttribute("inert");
      return () => {
        const tracking = roots.get(root);
        if (tracking !== undefined) {
          const recoverGridFocus =
            tracking.focusedCandidate !== null &&
            ownerDocument.activeElement === ownerDocument.body &&
            isBrunoTableDocumentFocusChainActive(ownerDocument);
          for (const candidate of tracking.trackedCandidates) restoreTabIndex(tracking, candidate);
          tracking.trackedCandidates.clear();
          if (
            isBrunoTableDocumentFocusChainActive(ownerDocument) &&
            (recoverGridFocus ||
              (ownerDocument.activeElement !== null && root.contains(ownerDocument.activeElement)))
          ) {
            grid.focus({ preventScroll: true });
          }
        }
        roots.delete(root);
        if (roots.size !== 0) return;
        observer.disconnect();
        grid.removeEventListener("focusin", trackFocusedCandidate);
        nonTabbableGridManagers.delete(grid);
      };
    },
  };
  return manager;
}

function NonTabbableCellContent({ children }: { readonly children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (root === null) return;
    const grid = root.closest<HTMLElement>('[role="grid"]');
    if (grid === null) return;
    let manager = nonTabbableGridManagers.get(grid);
    if (manager === undefined) {
      manager = createNonTabbableGridManager(grid);
      nonTabbableGridManagers.set(grid, manager);
    }
    return manager.register(root);
  }, []);
  return (
    <span ref={ref} inert data-bruno-nontabbable-cell-content="" style={{ display: "contents" }}>
      {children}
    </span>
  );
}

function headerSortPresentation(
  headerName: string,
  command: BrunoTableColumnCommandSnapshot,
): Readonly<{
  readonly ariaSort?: "ascending" | "descending";
  readonly direction?: "ascending" | "descending";
  readonly label: string;
}> {
  const direction =
    command.sortDirection === "asc"
      ? "ascending"
      : command.sortDirection === "desc"
        ? "descending"
        : undefined;
  return Object.freeze({
    ...(command.sortPriority === 1 && direction !== undefined ? { ariaSort: direction } : {}),
    ...(direction === undefined ? {} : { direction }),
    label:
      direction === undefined
        ? headerName
        : `${headerName}, sorted ${direction}${sortPriorityLabel(command.sortPriority)}`,
  });
}

function sortPriorityLabel(priority: number | undefined): string {
  return priority === undefined ? "" : `, priority ${String(priority)}`;
}

function columnSortAnnouncement(
  headerName: string,
  command: BrunoTableColumnCommandSnapshot,
): string {
  if (command.sortDirection === undefined) return `${headerName} sorting cleared`;
  const direction = command.sortDirection === "asc" ? "ascending" : "descending";
  return `${headerName} sorted ${direction}${sortPriorityLabel(command.sortPriority)}`;
}

function focusFirstInteractiveDescendant(cell: HTMLElement): boolean {
  for (const candidate of cell.querySelectorAll<InteractiveDomElement>(
    INTERACTIVE_DESCENDANT_SELECTOR,
  )) {
    if (candidate.matches(EMBEDDED_BROWSING_CONTEXT_SELECTOR)) continue;
    if (!interactiveDescendantIsUsable(candidate)) continue;
    candidate.focus({ preventScroll: true });
    if (candidate.ownerDocument.activeElement === candidate) return true;
  }
  return false;
}

function interactiveDescendantIsUsable(candidate: InteractiveDomElement): boolean {
  return (
    !candidate.matches(":disabled") &&
    candidate.closest("[inert]") === null &&
    candidate.closest('[aria-hidden="true"]') === null &&
    candidate.getClientRects().length > 0
  );
}

function pinnedCellStyle(
  side: "start" | "end",
  columns: readonly CompiledColumn[],
  index: number,
  leadingUtilityWidth = 0,
): CSSProperties {
  const column = columns[index];
  let offset = 0;
  if (side === "start") {
    for (let cursor = 0; cursor < index; cursor += 1) {
      offset += columns[cursor]?.semantics.width ?? 0;
    }
  } else {
    for (let cursor = index + 1; cursor < columns.length; cursor += 1) {
      offset += columns[cursor]?.semantics.width ?? 0;
    }
  }
  if (side === "start") offset += leadingUtilityWidth;
  return {
    background: "Canvas",
    minWidth:
      column === undefined
        ? undefined
        : `var(${brunoTableColumnCssVariable("width", column.columnId)}, ${String(column.semantics.width)}px)`,
    padding: 0,
    position: "sticky",
    transform:
      column === undefined
        ? undefined
        : `var(${brunoTableColumnCssVariable("transform", column.columnId)}, none)`,
    width:
      column === undefined
        ? undefined
        : `var(${brunoTableColumnCssVariable("width", column.columnId)}, ${String(column.semantics.width)}px)`,
    zIndex: 3,
    ...(column === undefined
      ? {}
      : side === "start"
        ? {
            insetInlineStart: `var(${brunoTableColumnCssVariable("pinned-start-offset", column.columnId)}, ${String(offset)}px)`,
          }
        : {
            insetInlineEnd: `var(${brunoTableColumnCssVariable("pinned-end-offset", column.columnId)}, ${String(offset)}px)`,
          }),
  };
}

const DEFAULT_LOADING_ROW_COUNT = 5;

const LoadingRows = memo(function LoadingRows({
  runtime,
  totalRows,
  ariaRowCount,
  compiledColumns,
  structuralColumns,
  focusFallback,
  focusHandoff,
  tableId,
  rowSelection,
}: {
  readonly runtime: BrunoTableRuntimeView;
  readonly totalRows: number;
  readonly ariaRowCount: number;
  readonly compiledColumns: readonly CompiledColumn[];
  readonly structuralColumns?: readonly CompiledColumn[] | undefined;
  readonly focusFallback: () => void;
  readonly focusHandoff: BrunoTableBodyFocusHandoff;
  readonly tableId: string;
  readonly rowSelection?: BrunoTableRowSelectionRuntime | undefined;
}) {
  const rowSelectionWidth = rowSelection === undefined ? 0 : ROW_SELECTION_COLUMN_WIDTH;
  return (
    <BrunoTableLoadingViewportAdapterBoundary
      key={rowSelection === undefined ? "no-leading-utility" : "row-selection-utility"}
      compiledColumns={compiledColumns}
      structuralColumns={structuralColumns}
      defaultLoadingRowCount={DEFAULT_LOADING_ROW_COUNT}
      focusFallback={focusFallback}
      focusHandoff={focusHandoff}
      runtime={runtime}
      totalRows={totalRows}
      leadingUtilityWidth={rowSelectionWidth}
    >
      {(adapter) => {
        const virtualWindow = adapter.viewportSnapshot.virtualWindow;
        const tableWidth = virtualWindow.totalWidth;
        const viewportFill =
          virtualWindow.pinnedEnd.length === 0
            ? 0
            : Math.max(0, adapter.viewportSnapshot.width - tableWidth);
        const renderedTableWidth = tableWidth + viewportFill;
        return (
          <div style={{ position: "relative" }}>
            <div
              ref={adapter.attachGrid}
              aria-busy="true"
              aria-colcount={adapter.columns.length + (rowSelection === undefined ? 0 : 1)}
              aria-label="Loading table rows"
              aria-rowcount={ariaRowCount}
              data-bruno-scroll-owner=""
              role="grid"
              tabIndex={0}
              style={{
                maxHeight: `min(var(${BRUNO_TABLE_REVIEW_VIEWPORT_MAX_HEIGHT_PROPERTY}, ${BRUNO_TABLE_DEFAULT_VIEWPORT_HEIGHT}px), ${BRUNO_TABLE_DEFAULT_VIEWPORT_HEIGHT}px)`,
                overflow: "auto",
                position: "relative",
              }}
            >
              <div
                ref={adapter.attachRowLayer}
                data-bruno-row-layer=""
                style={{
                  position: "relative",
                  width: rowSelectionSurfaceWidth(renderedTableWidth, rowSelection),
                }}
              >
                <table
                  role="presentation"
                  style={{
                    tableLayout: "fixed",
                    width: rowSelectionSurfaceWidth(renderedTableWidth, rowSelection),
                  }}
                >
                  <tbody
                    role="rowgroup"
                    style={{
                      display: "block",
                      height: virtualWindow.totalHeight,
                      position: "relative",
                      width: rowSelectionSurfaceWidth(renderedTableWidth, rowSelection),
                    }}
                  >
                    {Array.from(
                      { length: virtualWindow.rowEnd - virtualWindow.rowStart },
                      (_, offset) => (
                        <LoadingRow
                          key={`loading-slot-${String(virtualWindow.rowStart + offset)}`}
                          attachBodyLayer={adapter.attachBodyLayer}
                          center={virtualWindow.center}
                          centerStartIndex={virtualWindow.centerStartIndex}
                          instanceId={adapter.instanceId}
                          leftPadding={virtualWindow.leftPadding}
                          logicalRowIndex={virtualWindow.rowStart + offset}
                          pinnedEnd={virtualWindow.pinnedEnd}
                          pinnedStart={virtualWindow.pinnedStart}
                          rightPadding={virtualWindow.rightPadding}
                          tableId={tableId}
                          top={
                            (virtualWindow.segmentedRows
                              ? offset
                              : virtualWindow.rowStart + offset) * ROW_HEIGHT
                          }
                          viewportFill={viewportFill}
                          width={renderedTableWidth}
                          rowSelection={rowSelection}
                          columnIndexOffset={rowSelection === undefined ? 0 : 1}
                        />
                      ),
                    )}
                  </tbody>
                </table>
                {virtualWindow.pinnedStart.length > 0 ? (
                  <LoadingPinnedBodyRegion
                    attachBodyLayer={adapter.attachBodyLayer}
                    columns={virtualWindow.pinnedStart}
                    instanceId={adapter.instanceId}
                    layerWidth={renderedTableWidth}
                    pinnedStartCount={virtualWindow.pinnedStart.length}
                    rowEnd={virtualWindow.rowEnd}
                    segmentedRows={virtualWindow.segmentedRows}
                    rowStart={virtualWindow.rowStart}
                    side="start"
                    tableId={tableId}
                    totalHeight={virtualWindow.totalHeight}
                    leadingUtilityWidth={rowSelectionWidth}
                    columnIndexOffset={rowSelection === undefined ? 0 : 1}
                  />
                ) : null}
                {virtualWindow.pinnedEnd.length > 0 ? (
                  <LoadingPinnedBodyRegion
                    attachBodyLayer={adapter.attachBodyLayer}
                    columns={virtualWindow.pinnedEnd}
                    instanceId={adapter.instanceId}
                    layerWidth={renderedTableWidth}
                    pinnedStartCount={virtualWindow.pinnedStart.length}
                    precedingColumnCount={virtualWindow.centerCount}
                    rowEnd={virtualWindow.rowEnd}
                    segmentedRows={virtualWindow.segmentedRows}
                    rowStart={virtualWindow.rowStart}
                    side="end"
                    tableId={tableId}
                    totalHeight={virtualWindow.totalHeight}
                    leadingUtilityWidth={rowSelectionWidth}
                    columnIndexOffset={rowSelection === undefined ? 0 : 1}
                  />
                ) : null}
              </div>
            </div>
            <BrunoTableScrollbarOverlay attach={adapter.attachScrollbarOverlay} />
          </div>
        );
      }}
    </BrunoTableLoadingViewportAdapterBoundary>
  );
});

const LoadingPinnedBodyRegion = memo(function LoadingPinnedBodyRegion({
  attachBodyLayer,
  columns,
  instanceId,
  layerWidth,
  pinnedStartCount,
  precedingColumnCount = 0,
  rowEnd,
  segmentedRows,
  rowStart,
  side,
  tableId,
  totalHeight,
  leadingUtilityWidth,
  columnIndexOffset,
}: {
  readonly attachBodyLayer: RefCallback<HTMLElement>;
  readonly columns: readonly CompiledColumn[];
  readonly instanceId: string;
  readonly layerWidth: number;
  readonly pinnedStartCount: number;
  readonly precedingColumnCount?: number;
  readonly rowEnd: number;
  readonly segmentedRows: boolean;
  readonly rowStart: number;
  readonly side: "start" | "end";
  readonly tableId: string;
  readonly totalHeight: number;
  readonly leadingUtilityWidth: number;
  readonly columnIndexOffset: number;
}) {
  const width = totalColumnWidth(columns);
  return (
    <BrunoTablePinnedOverlayShell
      layerWidth={layerWidth}
      leadingUtilityWidth={leadingUtilityWidth}
      side={side}
      top={0}
      totalHeight={totalHeight}
      width={width}
    >
      {Array.from({ length: rowEnd - rowStart }, (_, offset) => (
        <tr
          ref={attachBodyLayer}
          key={`pinned-loading-slot-${String(rowStart + offset)}`}
          role="presentation"
          style={{
            display: "table",
            height: ROW_HEIGHT,
            maxHeight: ROW_HEIGHT,
            overflow: "hidden",
            position: "absolute",
            tableLayout: "fixed",
            top: (segmentedRows ? offset : rowStart + offset) * ROW_HEIGHT,
            willChange: "transform",
            width: `var(${BRUNO_TABLE_LIVE_TOTAL_WIDTH_CSS_VARIABLE}, ${String(width)}px)`,
          }}
        >
          {columns.map((column, index) => (
            <LoadingCell
              key={column.columnId}
              column={column}
              columnIndex={
                columnIndexOffset +
                (side === "start" ? index : pinnedStartCount + precedingColumnCount + index)
              }
              id={loadingCellDomId(instanceId, tableId, rowStart + offset, column.columnId)}
            />
          ))}
        </tr>
      ))}
    </BrunoTablePinnedOverlayShell>
  );
});

const LoadingRow = memo(function LoadingRow({
  ariaRowIndexOffset = 1,
  attachBodyLayer,
  center,
  centerStartIndex,
  instanceId,
  leftPadding,
  logicalRowIndex,
  pinnedEnd,
  pinnedStart,
  rightPadding,
  tableId,
  top,
  viewportFill,
  width,
  rowSelection,
  columnIndexOffset = 0,
}: {
  readonly ariaRowIndexOffset?: number;
  readonly attachBodyLayer: RefCallback<HTMLElement>;
  readonly center: readonly CompiledColumn[];
  readonly centerStartIndex: number;
  readonly instanceId: string;
  readonly leftPadding: number;
  readonly logicalRowIndex: number;
  readonly pinnedEnd: readonly CompiledColumn[];
  readonly pinnedStart: readonly CompiledColumn[];
  readonly rightPadding: number;
  readonly tableId: string;
  readonly top: number;
  readonly viewportFill: number;
  readonly width: number;
  readonly rowSelection?: BrunoTableRowSelectionRuntime | undefined;
  readonly columnIndexOffset?: number;
}) {
  const ownedCells = useMemo(
    () =>
      [...pinnedStart, ...center, ...pinnedEnd]
        .map((column) => loadingCellDomId(instanceId, tableId, logicalRowIndex, column.columnId))
        .join(" "),
    [center, instanceId, logicalRowIndex, pinnedEnd, pinnedStart, tableId],
  );
  return (
    <tr
      ref={attachBodyLayer}
      aria-rowindex={logicalRowIndex + ariaRowIndexOffset}
      aria-owns={ownedCells === "" ? undefined : ownedCells}
      role="row"
      style={{
        display: "table",
        height: ROW_HEIGHT,
        maxHeight: ROW_HEIGHT,
        overflow: "hidden",
        position: "absolute",
        tableLayout: "fixed",
        top,
        willChange: "transform",
        width: rowSelectionSurfaceWidth(width, rowSelection),
      }}
    >
      {rowSelection === undefined ? null : <BrunoTableRowSelectionLoadingCell />}
      {pinnedStart.length > 0 ? (
        <td
          aria-hidden="true"
          style={{
            padding: 0,
            width: `var(${brunoTablePinnedWidthCssVariable("start")}, ${String(totalColumnWidth(pinnedStart))}px)`,
          }}
        />
      ) : null}
      {center.length > 0 ? (
        <td
          aria-hidden="true"
          style={{
            padding: 0,
            width: `var(${BRUNO_TABLE_LIVE_LEFT_PADDING_CSS_VARIABLE}, ${String(leftPadding)}px)`,
          }}
        />
      ) : null}
      {center.map((column, index) => (
        <LoadingCell
          key={column.columnId}
          column={column}
          columnIndex={columnIndexOffset + pinnedStart.length + centerStartIndex + index}
          id={loadingCellDomId(instanceId, tableId, logicalRowIndex, column.columnId)}
        />
      ))}
      {center.length > 0 ? (
        <td
          aria-hidden="true"
          style={{
            padding: 0,
            width: `var(${BRUNO_TABLE_LIVE_RIGHT_PADDING_CSS_VARIABLE}, ${String(rightPadding)}px)`,
          }}
        />
      ) : null}
      {pinnedEnd.length > 0 ? (
        <td
          aria-hidden="true"
          style={{
            padding: 0,
            width: rowSelectionViewportFillWidth(viewportFill, rowSelection),
          }}
        />
      ) : null}
      {pinnedEnd.length > 0 ? (
        <td
          aria-hidden="true"
          style={{
            padding: 0,
            width: `var(${brunoTablePinnedWidthCssVariable("end")}, ${String(totalColumnWidth(pinnedEnd))}px)`,
          }}
        />
      ) : null}
    </tr>
  );
});

const LoadingCell = memo(function LoadingCell({
  column,
  columnIndex,
  id,
}: {
  readonly column: CompiledColumn;
  readonly columnIndex: number;
  readonly id: string;
}) {
  const skeletonStyle = loadingSkeletonStyle(column);
  const props = {
    id,
    "data-bruno-column-id": column.columnId,
    "aria-colindex": columnIndex + 1,
    "aria-label": `Loading ${column.headerName}`,
    role: "gridcell",
    style: {
      boxSizing: "border-box",
      height: ROW_HEIGHT,
      maxHeight: ROW_HEIGHT,
      overflow: "hidden",
      padding: 4,
      transform: `var(${brunoTableColumnCssVariable("transform", column.columnId)}, none)`,
      width: `var(${brunoTableColumnCssVariable("width", column.columnId)}, ${String(column.semantics.width)}px)`,
    } satisfies CSSProperties,
  } as const;
  const content = <Skeleton aria-hidden="true" style={skeletonStyle} />;
  return <td {...props}>{content}</td>;
});

function loadingSkeletonStyle(column: CompiledColumn): CSSProperties {
  const boolean = column.semantics.editorFamily === "boolean";
  const width = boolean ? 16 : column.semantics.editorLayout === "fullWidth" ? "100%" : "64%";
  return {
    height: boolean ? 16 : 12,
    marginBlock: boolean ? 6 : 8,
    width,
    ...(column.semantics.cellAlign === "center"
      ? { marginInline: "auto" }
      : column.semantics.cellAlign === "end"
        ? { marginInlineStart: "auto" }
        : { marginInlineEnd: "auto" }),
  };
}

function viewportPageSize(viewport: HTMLElement): number {
  const headerHeight = viewport.querySelector("thead")?.offsetHeight ?? ROW_HEIGHT;
  return Math.max(1, Math.floor(Math.max(0, viewport.clientHeight - headerHeight) / ROW_HEIGHT));
}
