import type { CompiledColumn } from "./compile-columns";
import {
  BRUNO_TABLE_LIVE_TOTAL_WIDTH_CSS_VARIABLE,
  BRUNO_TABLE_LIVE_VIEWPORT_FILL_CSS_VARIABLE,
  BRUNO_TABLE_LIVE_LEFT_PADDING_CSS_VARIABLE,
  BRUNO_TABLE_LIVE_RIGHT_PADDING_CSS_VARIABLE,
  brunoTableColumnCssVariable,
  brunoTablePinnedWidthCssVariable,
} from "./column-management";
import { recordBrunoTableClientColumnPreviewStyleWrite } from "./render-instrumentation";

export type BrunoTableViewportSnapshot = Readonly<{
  readonly width: number;
  readonly height: number;
  readonly virtualWindow: BrunoTableVirtualWindow;
}>;

export type BrunoTableVirtualWindow = Readonly<{
  readonly rowStart: number;
  readonly rowEnd: number;
  /** Whether logical row coordinates exceed the browser-safe physical scroll extent. */
  readonly segmentedRows: boolean;
  readonly pinnedStart: readonly CompiledColumn[];
  readonly center: readonly CompiledColumn[];
  readonly pinnedEnd: readonly CompiledColumn[];
  /** Whether the deterministic narrow-width policy is projecting pinned columns into centre. */
  readonly pinningSuspended: boolean;
  readonly centerStartIndex: number;
  /** Full logical centre-column count; `center` is only the mounted virtual slice. */
  readonly centerCount: number;
  readonly leftPadding: number;
  readonly rightPadding: number;
  readonly totalHeight: number;
  readonly totalWidth: number;
}>;

export type BrunoTableBodyColumnWindowSnapshot = Readonly<{
  readonly center: readonly CompiledColumn[];
  readonly centerStartIndex: number;
  readonly leftPadding: number;
  readonly rightPadding: number;
  /** Hidden, already-mounted cells retained while one shared visible window changes atomically. */
  readonly preparedCenter?: readonly CompiledColumn[] | undefined;
  readonly preparedCenterStartIndex?: number | undefined;
  readonly preparedSourceCenterStartIndex?: number | undefined;
  readonly preparedSourceCenterEndIndex?: number | undefined;
  readonly preparedTargetCenterStartIndex?: number | undefined;
  readonly preparedTargetCenterEndIndex?: number | undefined;
}>;

export type BrunoTableRowRangeSnapshot = Readonly<{
  readonly rowStart: number;
  readonly rowEnd: number;
  readonly segmentedRows: boolean;
  readonly totalHeight: number;
}>;

export type BrunoTableViewportBodyHit = Readonly<{
  readonly rowIndex: number;
  readonly columnId: string;
}>;

export type BrunoTableViewportBodyHitRequest = Readonly<{
  readonly phase?: "preview" | "release";
  readonly clientX: number;
  readonly clientY: number;
  readonly bodyTop: number;
  readonly centreLeft: number;
  readonly centreRight: number;
}>;

type Listener = () => void;
type HorizontalDirection = "ltr" | "rtl";
type RtlScrollType = "negative" | "default" | "reverse";

type HorizontalCoordinateSample = Readonly<{
  readonly logicalScrollLeft: number;
  readonly direction: HorizontalDirection;
  readonly rtlScrollType: RtlScrollType;
  readonly viewportWidth: number;
  readonly suspended: boolean;
  readonly pinnedStartWidth: number;
  readonly pinningKey: string;
}>;
type HorizontalCoordinateEnvironment = Omit<HorizontalCoordinateSample, "logicalScrollLeft">;
type ViewportDimensions = Readonly<{
  readonly clientHeight: number;
  readonly clientWidth: number;
  readonly offsetHeight: number;
  readonly offsetWidth: number;
  readonly viewportWidth: number;
}>;
type PreviewHorizontalState = Readonly<{
  readonly suspended: boolean | undefined;
  readonly pinnedStartWidth: number;
  readonly pinningKey: string;
}>;
type BodyColumnPreparation = {
  phase: "cleanup" | "prepare" | "promote";
  readonly preparedCenter: readonly CompiledColumn[];
  readonly preparedCenterStartIndex: number;
  readonly preparedRows: Set<number>;
  readonly sourceCenterStartIndex: number;
  readonly sourceCenterEndIndex: number;
  readonly target: BrunoTableBodyColumnWindowSnapshot;
};

export const BRUNO_TABLE_ROW_HEIGHT = 36;
export const BRUNO_TABLE_HEADER_HEIGHT_CSS_VARIABLE = "--bruno-table-header-height";
export const BRUNO_TABLE_DEFAULT_VIEWPORT_HEIGHT = 480;
export const BRUNO_TABLE_MAX_PHYSICAL_ROW_HEIGHT = 4_000_000;
export const BRUNO_TABLE_SCROLLBAR_TRACK_THICKNESS = 8;
export const BRUNO_TABLE_PREPARED_ENTERING_DISPLAY_CSS_VARIABLE =
  "--bruno-table-prepared-entering-display";
export const BRUNO_TABLE_PREPARED_RETIRING_DISPLAY_CSS_VARIABLE =
  "--bruno-table-prepared-retiring-display";
export const BRUNO_TABLE_PREPARED_LEFT_PADDING_CSS_VARIABLE = "--bruno-table-prepared-left-padding";
export const BRUNO_TABLE_PREPARED_RIGHT_PADDING_CSS_VARIABLE =
  "--bruno-table-prepared-right-padding";

const ROW_HEIGHT = BRUNO_TABLE_ROW_HEIGHT;
const ROW_OVERSCAN = 4;
const STEADY_SCROLL_ROW_OVERSCAN = 3;
const HORIZONTAL_REVEAL_ROW_OVERSCAN = 1;
const COLUMN_OVERSCAN = 2;
const STEADY_SCROLL_COLUMN_OVERSCAN = COLUMN_OVERSCAN;
const RETAINED_COLUMN_OVERSCAN = 2;
const HEADER_COLUMN_OVERSCAN = 12;
const CENTER_ROW_PREPARATION_BATCH_SIZE = 4;
const MIN_CENTER_VIEWPORT_WIDTH = 80;
const MIN_SCROLLBAR_THUMB_SIZE = 24;
const EMPTY_COLUMNS: readonly CompiledColumn[] = Object.freeze([]);
const EMPTY_BODY_COLUMN_WINDOW: BrunoTableBodyColumnWindowSnapshot = Object.freeze({
  center: EMPTY_COLUMNS,
  centerStartIndex: 0,
  leftPadding: 0,
  rightPadding: 0,
});
const EMPTY_ROW_RANGE: BrunoTableRowRangeSnapshot = Object.freeze({
  rowStart: 0,
  rowEnd: 0,
  segmentedRows: false,
  totalHeight: 0,
});
const RTL_SCROLL_TYPES = new WeakMap<Document, RtlScrollType>();

type ViewportLayout = Readonly<{
  readonly rowCount: number;
  readonly headerHeight: number;
  readonly columns: readonly CompiledColumn[];
  readonly pinnedStart: readonly CompiledColumn[];
  readonly center: readonly CompiledColumn[];
  readonly pinnedEnd: readonly CompiledColumn[];
  readonly centerOffsets: readonly number[];
  readonly suspendedCenter: readonly CompiledColumn[];
  readonly suspendedCenterOffsets: readonly number[];
  readonly suspendedCenterWidth: number;
  readonly pinnedStartWidth: number;
  readonly pinnedEndWidth: number;
  readonly centerWidth: number;
  readonly logicalRowHeight: number;
  readonly physicalRowHeight: number;
  readonly totalWidth: number;
}>;

type RevealTarget = Readonly<{
  readonly rowIndex: number;
  readonly rowId?: string;
  readonly columnId: string;
  readonly region: "header" | "body";
}>;

const INITIAL_VIEWPORT: BrunoTableViewportSnapshot = Object.freeze({
  width: 0,
  height: BRUNO_TABLE_DEFAULT_VIEWPORT_HEIGHT,
  virtualWindow: emptyVirtualWindow(),
});

export const BRUNO_TABLE_VIEWPORT_SCROLL_QUANTUM = 32;
export const BRUNO_TABLE_VIEWPORT_LOGICAL_SCROLL_LEFT_CSS_VARIABLE =
  "--bruno-table-viewport-logical-scroll-left";
export const BRUNO_TABLE_VIEWPORT_INLINE_SIZE_CSS_VARIABLE = "--bruno-table-viewport-inline-size";
const MAX_REVERSE_RTL_LAYOUT_DEFERRALS = 8;
const HORIZONTAL_RECONCILIATION_SETTLED = Symbol("horizontal-reconciliation-settled");
type HorizontalReconciliation = number | typeof HORIZONTAL_RECONCILIATION_SETTLED;

export class BrunoTableViewportRuntime {
  private readonly listeners = new Set<Listener>();
  private readonly environmentListeners = new Set<Listener>();
  private readonly bodyLayers = new Set<HTMLElement>();
  private readonly preparedBodyStyles = new Map<string, string>();
  private pinnedEditorHost: HTMLElement | null = null;
  private element: HTMLElement | null = null;
  private rowLayer: HTMLElement | null = null;
  private scrollbarOverlay: HTMLElement | null = null;
  private scrollbarOverlayDirection: HorizontalDirection | undefined;
  private scrollbarOverlayStructuralKey: string | undefined;
  private resizeObserver: ResizeObserver | null = null;
  private rowLayerResizeObserver: ResizeObserver | null = null;
  private headerElement: HTMLElement | null = null;
  private headerEnvironmentDirty = false;
  private directionObserver: MutationObserver | null = null;
  private stylesheetRoot: HTMLHeadElement | null = null;
  private frame: number | null = null;
  private pendingReveal: RevealTarget | undefined;
  private lastAppliedReveal: RevealTarget | undefined;
  private residentRowOverscan = ROW_OVERSCAN;
  private segmentLogicalBase = 0;
  private segmentPhysicalAnchor = 0;
  private lastPhysicalScrollTop = 0;
  private horizontalSuspended: boolean | undefined;
  private horizontalPinnedStartWidth = 0;
  private horizontalPinningKey = "";
  private horizontalDirection: HorizontalDirection = "ltr";
  private rtlScrollType: RtlScrollType = "negative";
  private directionDirty = false;
  private horizontalInputPending = false;
  private programmaticHorizontalScrollPending = false;
  private horizontalInputSample: HorizontalCoordinateSample | undefined;
  private horizontalInputNativeScrollLeft: number | undefined;
  private horizontalEventOrder = 0;
  private horizontalInputEventOrder: number | undefined;
  private horizontalEnvironmentEventOrder: number | undefined;
  private directionScrollGuard: number | undefined;
  private forceGuardedDirectionReconciliation = false;
  private horizontalViewportWidth = 0;
  private viewportDimensions: ViewportDimensions | undefined;
  private lastNativeScrollLeft = 0;
  private layoutReconciliationPending = false;
  private layoutReconciliationDeferrals = 0;
  private logicalScrollLeft = 0;
  private logicalScrollTop = 0;
  private pendingLayoutHorizontalCoordinate: HorizontalCoordinateSample | undefined;
  private rowLayerOffset = "0px";
  private layout: ViewportLayout;
  private layoutColumns: readonly CompiledColumn[] | undefined;
  private previewLayout: ViewportLayout | undefined;
  private previewPublishedSuspended: boolean | undefined;
  private previewLogicalScrollLeft: number | undefined;
  private previewHorizontalState: PreviewHorizontalState | undefined;
  private readonly previewStyleProperties = new Set<string>();
  private layoutKey = "";
  private layoutPinningKey = "";
  private snapshot: BrunoTableViewportSnapshot = INITIAL_VIEWPORT;
  private renderSnapshot: BrunoTableViewportSnapshot = INITIAL_VIEWPORT;
  private readonly renderListeners = new Set<Listener>();
  private bodyColumnWindow: BrunoTableBodyColumnWindowSnapshot = EMPTY_BODY_COLUMN_WINDOW;
  private bodyColumnWindowOverscan = COLUMN_OVERSCAN;
  private deferredBodyColumnPreparationPending = false;
  private readonly columnWindowListeners = new Set<Listener>();
  private headerColumnWindow: BrunoTableBodyColumnWindowSnapshot = EMPTY_BODY_COLUMN_WINDOW;
  private readonly headerColumnWindowListeners = new Set<Listener>();
  private readonly headerColumnElements = new Map<string, HTMLElement>();
  private rowRange: BrunoTableRowRangeSnapshot = EMPTY_ROW_RANGE;
  private readonly rowRangeListeners = new Set<Listener>();
  private readonly bodyRowColumnWindowListeners = new Map<number, Set<Listener>>();
  private readonly preparedBodyRowColumnWindows = new Map<
    number,
    BrunoTableBodyColumnWindowSnapshot
  >();
  private bodyColumnPreparation: BodyColumnPreparation | undefined;
  private readonly frameCommitListeners = new Set<() => void>();
  public readonly subscribeFrameCommit = (listener: () => void): (() => void) => {
    this.frameCommitListeners.add(listener);
    return () => {
      this.frameCommitListeners.delete(listener);
    };
  };
  private pendingColumnWindowNotification = false;
  private readonly pendingBodyRowColumnWindowNotifications = new Set<number>();
  private leadingUtilityWidth: number;

  public constructor(
    private headerHeight: number = ROW_HEIGHT,
    leadingUtilityWidth: number = 0,
  ) {
    this.leadingUtilityWidth = normalizedLeadingUtilityWidth(leadingUtilityWidth);
    this.layout = createLayout(0, [], headerHeight);
  }

  private effectiveViewportWidth(element: HTMLElement): number {
    return Math.max(element.clientWidth - this.leadingUtilityWidth, 0);
  }

  private captureViewportDimensions(element: HTMLElement): ViewportDimensions {
    const clientHeight = element.clientHeight;
    const clientWidth = element.clientWidth;
    const dimensions = {
      clientHeight,
      clientWidth,
      offsetHeight: element.offsetHeight,
      offsetWidth: element.offsetWidth,
      viewportWidth: Math.max(clientWidth - this.leadingUtilityWidth, 0),
    };
    this.viewportDimensions = dimensions;
    return dimensions;
  }

  public readonly getSnapshot = (): BrunoTableViewportSnapshot => this.snapshot;

  public readonly getRenderSnapshot = (): BrunoTableViewportSnapshot => this.renderSnapshot;

  public readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  public readonly subscribeRender = (listener: Listener): (() => void) => {
    this.renderListeners.add(listener);
    return () => this.renderListeners.delete(listener);
  };

  public readonly getColumnWindowSnapshot = (): BrunoTableBodyColumnWindowSnapshot =>
    this.bodyColumnWindow;

  public readonly getHeaderColumnWindowSnapshot = (): BrunoTableBodyColumnWindowSnapshot =>
    this.headerColumnWindow;

  public readonly subscribeHeaderColumnWindow = (listener: Listener): (() => void) => {
    this.headerColumnWindowListeners.add(listener);
    return () => this.headerColumnWindowListeners.delete(listener);
  };

  public readonly getHeaderColumnActivitySnapshot = (columnId: string): boolean =>
    this.bodyColumnWindow.center.some((column) => column.columnId === columnId);

  public readonly attachHeaderColumn = (columnId: string, element: HTMLElement | null): void => {
    if (element === null) {
      this.headerColumnElements.delete(columnId);
      return;
    }
    this.headerColumnElements.set(columnId, element);
    this.writeHeaderColumnActivity(columnId, element);
  };

  public readonly subscribeColumnWindow = (listener: Listener): (() => void) => {
    this.columnWindowListeners.add(listener);
    return () => this.columnWindowListeners.delete(listener);
  };

  public readonly getRowRangeSnapshot = (): BrunoTableRowRangeSnapshot => this.rowRange;

  public readonly subscribeRowRange = (listener: Listener): (() => void) => {
    this.rowRangeListeners.add(listener);
    return () => this.rowRangeListeners.delete(listener);
  };

  public readonly subscribeEnvironment = (listener: Listener): (() => void) => {
    this.environmentListeners.add(listener);
    return () => this.environmentListeners.delete(listener);
  };

  public readonly getBodyRowColumnWindowSnapshot = (
    logicalRowIndex: number,
  ): BrunoTableBodyColumnWindowSnapshot =>
    this.preparedBodyRowColumnWindows.get(logicalRowIndex) ?? this.bodyColumnWindow;

  public readonly subscribeBodyRowColumnWindow = (
    logicalRowIndex: number,
    listener: Listener,
  ): (() => void) => {
    const listeners = this.bodyRowColumnWindowListeners.get(logicalRowIndex) ?? new Set<Listener>();
    listeners.add(listener);
    this.bodyRowColumnWindowListeners.set(logicalRowIndex, listeners);
    return () => {
      listeners.delete(listener);
      if (
        listeners.size === 0 &&
        this.bodyRowColumnWindowListeners.get(logicalRowIndex) === listeners
      ) {
        this.bodyRowColumnWindowListeners.delete(logicalRowIndex);
      }
    };
  };

  public readonly scrollByLogical = (delta: number): boolean => {
    const element = this.element;
    if (element === null || !Number.isFinite(delta) || delta === 0) return false;
    const viewportWidth = this.horizontalViewportWidth;
    const maximum = horizontalScrollMaximum(this.layout, viewportWidth);
    const pendingNativeScrollLeft = this.horizontalInputNativeScrollLeft;
    const current =
      pendingNativeScrollLeft === undefined
        ? this.logicalScrollLeft
        : logicalScrollLeftFromNative(
            pendingNativeScrollLeft,
            maximum,
            this.horizontalDirection,
            this.rtlScrollType,
          );
    const next = Math.min(Math.max(current + delta, 0), maximum);
    if (next === current) return false;
    this.programmaticHorizontalScrollPending = true;
    this.setLogicalScrollLeft(element, next, viewportWidth, false);
    this.schedulePublish();
    return true;
  };

  public readonly resolveBodyHit = (
    request: BrunoTableViewportBodyHitRequest,
  ): BrunoTableViewportBodyHit | undefined => {
    const columns =
      this.horizontalSuspended === true ? this.layout.suspendedCenter : this.layout.center;
    const offsets =
      this.horizontalSuspended === true
        ? this.layout.suspendedCenterOffsets
        : this.layout.centerOffsets;
    const centerWidth = offsets.at(-1) ?? 0;
    if (
      this.layout.rowCount === 0 ||
      columns.length === 0 ||
      centerWidth <= 0 ||
      request.clientY < request.bodyTop ||
      request.clientX < request.centreLeft ||
      request.clientX > request.centreRight
    ) {
      return undefined;
    }
    const physicalInlineOffset =
      this.horizontalDirection === "rtl"
        ? request.centreRight - request.clientX
        : request.clientX - request.centreLeft;
    const logicalScrollLeft =
      this.element === null || request.phase !== "release"
        ? this.logicalScrollLeft
        : this.readLogicalScrollLeft(this.element, this.viewportDimensions?.viewportWidth);
    const logicalInlineOffset = Math.min(
      Math.max(logicalScrollLeft + physicalInlineOffset, 0),
      Math.max(centerWidth - Number.EPSILON, 0),
    );
    // Pointer release can precede the next scheduled viewport publication.
    const logicalScrollTop =
      this.element === null || request.phase !== "release"
        ? this.logicalScrollTop
        : this.readLogicalScrollTop(this.element, false, this.viewportDimensions?.clientHeight);
    const rowIndex = Math.floor(
      (logicalScrollTop + request.clientY - request.bodyTop) / ROW_HEIGHT,
    );
    if (rowIndex < 0 || rowIndex >= this.layout.rowCount) return undefined;
    const column = columns[findColumnAtOffset(offsets, logicalInlineOffset)];
    return column === undefined
      ? undefined
      : Object.freeze({ rowIndex, columnId: column.columnId });
  };

  public readonly adjustVerticalByLogical = (delta: number): number | undefined => {
    const element = this.element;
    if (element === null || !Number.isFinite(delta) || delta === 0) return element?.scrollTop;
    const current = this.readLogicalScrollTop(element, false);
    this.setLogicalScrollTop(element, current + delta);
    this.schedulePublish();
    return element.scrollTop;
  };

  public readonly scrollVerticalByLogical = (delta: number): boolean => {
    const element = this.element;
    if (element === null || !Number.isFinite(delta) || delta === 0) return false;
    const previous = this.readLogicalScrollTop(element, false);
    this.setLogicalScrollTop(element, previous + delta);
    const next = this.readLogicalScrollTop(element, false);
    if (next === previous) return false;
    this.schedulePublish();
    return true;
  };

  public readonly setLeadingUtilityWidth = (leadingUtilityWidth: number): boolean => {
    const next = normalizedLeadingUtilityWidth(leadingUtilityWidth);
    if (next === this.leadingUtilityWidth) return false;
    const element = this.element;
    const previousHorizontalCoordinate =
      element === null ? undefined : this.captureLayoutSourceCoordinate(element);
    this.leadingUtilityWidth = next;
    if (element === null) return true;
    this.reconcileHorizontalAfterLayoutSourceChange(element, previousHorizontalCoordinate);
    return true;
  };

  public readonly setLayout = (
    rowCount: number,
    columns: readonly CompiledColumn[],
    findRowIndex?: (rowId: string) => number | undefined,
  ): void => {
    this.rebasePendingReveal(findRowIndex);
    const nextLayoutKey = `${rowCount}|${columns
      .map((column) => `${column.columnId}:${column.pinned ?? "center"}:${column.semantics.width}`)
      .join(",")}`;
    if (nextLayoutKey === this.layoutKey && this.layoutColumns === columns) return;
    this.clearColumnWidthPreview(false);
    const element = this.element;
    const previousLogicalScrollTop =
      element === null ? 0 : this.readLogicalScrollTop(element, false);
    const previousHorizontalCoordinate =
      element === null ? undefined : this.captureLayoutSourceCoordinate(element);
    this.layoutKey = nextLayoutKey;
    this.layoutPinningKey = columns
      .map((column) => `${column.columnId}:${column.pinned ?? "center"}`)
      .join(",");
    this.layoutColumns = columns;
    this.layout = createLayout(rowCount, columns, this.headerHeight);
    if (element === null) {
      this.publishSnapshot(
        createViewportSnapshot(this.layout, {
          logicalScrollTop: 0,
          scrollLeft: 0,
          width: 0,
          height: BRUNO_TABLE_DEFAULT_VIEWPORT_HEIGHT,
        }),
      );
      return;
    }
    const clampedLogicalScrollTop = Math.min(
      previousLogicalScrollTop,
      logicalScrollMaximum(this.layout, element.clientHeight),
    );
    this.setLogicalScrollTop(element, clampedLogicalScrollTop);
    this.reconcileHorizontalAfterLayoutSourceChange(element, previousHorizontalCoordinate);
  };

  private readonly reconcileHorizontalAfterLayoutSourceChange = (
    element: HTMLElement,
    previousHorizontalCoordinate: HorizontalCoordinateSample | undefined,
  ): void => {
    this.layoutReconciliationPending = true;
    this.layoutReconciliationDeferrals = 0;
    this.pendingLayoutHorizontalCoordinate = previousHorizontalCoordinate;
    const projectedLogicalScrollLeft = this.projectLayoutLogicalScrollLeft(
      element,
      previousHorizontalCoordinate,
    );
    if (
      previousHorizontalCoordinate !== undefined &&
      this.shouldDeferReverseRtlLayoutWrite(element, projectedLogicalScrollLeft)
    ) {
      this.pendingLayoutHorizontalCoordinate = this.captureHorizontalCoordinate(
        element,
        projectedLogicalScrollLeft,
      );
      this.layoutReconciliationDeferrals = 1;
      this.horizontalInputPending = false;
      this.horizontalInputSample = undefined;
      this.horizontalInputNativeScrollLeft = undefined;
      this.horizontalInputEventOrder = undefined;
      this.directionDirty = false;
      this.publishCoordinates(
        element,
        this.readLogicalScrollTop(element, true),
        projectedLogicalScrollLeft,
      );
      this.schedulePublish();
      return;
    }
    this.publishFromElement();
  };

  /**
   * Updates the imperative geometry used by exact reveal and scrollbar math
   * without publishing a React snapshot. The header/body CSS variables are
   * written by the same rAF that computes the pointer preview.
   */
  public readonly previewColumnWidth = (columnId: string, width: number): void => {
    const columns = this.layoutColumns;
    if (columns === undefined) return;
    if (this.previewLayout === undefined) {
      this.previewLayout = this.layout;
      this.previewPublishedSuspended =
        this.element === null
          ? undefined
          : shouldSuspendPinning(this.layout, this.effectiveViewportWidth(this.element));
      this.previewLogicalScrollLeft =
        this.element === null ? 0 : this.readLogicalScrollLeft(this.element);
      this.previewHorizontalState = Object.freeze({
        suspended: this.horizontalSuspended,
        pinnedStartWidth: this.horizontalPinnedStartWidth,
        pinningKey: this.horizontalPinningKey,
      });
    }
    this.layout = updateColumnWidthPreviewLayout(this.layout, columnId, width);
    const element = this.element;
    const logicalScrollLeft =
      this.previewLogicalScrollLeft ?? (element === null ? 0 : this.readLogicalScrollLeft(element));
    let previewWindow: BrunoTableVirtualWindow | undefined;
    if (element !== null) {
      // Capture every DOM dimension before the first preview style write. A
      // geometry read after changing the width variable synchronously flushes
      // layout across the mounted grid and breaks the pointer-frame budget.
      const clientWidth = element.clientWidth;
      const clientHeight = element.clientHeight;
      const offsetWidth = element.offsetWidth;
      const offsetHeight = element.offsetHeight;
      const viewportWidth = Math.max(clientWidth - this.leadingUtilityWidth, 0);
      const previewScrollLeft = Math.min(
        logicalScrollLeft,
        horizontalScrollMaximum(this.layout, viewportWidth),
      );
      const logicalScrollTop = this.readLogicalScrollTop(element, false);
      const physicalScrollTop = element.scrollTop;
      const previewViewport = {
        logicalScrollTop: quantizeScroll(logicalScrollTop),
        scrollLeft: previewScrollLeft,
        width: viewportWidth,
        height: clientHeight,
      };
      previewWindow = calculateVirtualWindow(
        this.layout,
        previewViewport,
        undefined,
        ROW_OVERSCAN,
        this.bodyColumnWindowOverscan,
      );
      // Ordinary width previews keep the committed mounted window stable. A
      // preview may publish one structural viewport snapshot when the current
      // preview crosses the deterministic narrow-width policy boundary. Track
      // the last published state so an oscillating preview publishes both the
      // enter and exit transitions.
      const isSuspended = shouldSuspendPinning(this.layout, viewportWidth);
      const reuseMountedWindow =
        this.previewPublishedSuspended === isSuspended &&
        mountedWindowCoversPreviewWindow(this.snapshot.virtualWindow, previewWindow);
      if (!reuseMountedWindow) {
        const next = createViewportSnapshot(this.layout, previewViewport);
        // Seed the matching offset before subscribers mount rows from this window.
        this.writeRowWindowOffset(physicalScrollTop, logicalScrollTop, next.virtualWindow);
        this.publishSnapshot(next);
        this.previewPublishedSuspended = isSuspended;
      }
      this.writeColumnPreviewStyles(
        columnId,
        mountedWindowPreviewPadding(this.layout, this.snapshot.virtualWindow),
        viewportWidth,
      );
      // Rewriting an unchanged LTR/negative-RTL coordinate after the CSS
      // width writes forces the browser to synchronously lay out the mounted
      // grid on every pointer frame. Reverse/positive RTL coordinates depend
      // on the changing scroll maximum, so those modes still need the write.
      if (
        previewScrollLeft !== logicalScrollLeft ||
        (this.horizontalDirection === "rtl" && this.rtlScrollType !== "negative")
      ) {
        this.setLogicalScrollLeft(element, previewScrollLeft, viewportWidth, false);
      }
      this.writePinnedEditorGeometry(previewScrollLeft, clientWidth);
      this.writeScrollbarOverlay(element, logicalScrollTop, previewScrollLeft, {
        clientHeight,
        clientWidth,
        offsetHeight,
        offsetWidth,
        viewportWidth,
      });
      return;
    }
    this.writeColumnPreviewStyles(columnId, previewWindow);
  };

  public readonly clearColumnWidthPreview = (publishSnapshot = true): void => {
    if (this.previewLayout === undefined) return;
    this.layout = this.previewLayout;
    this.previewLayout = undefined;
    this.previewPublishedSuspended = undefined;
    const logicalScrollLeft = this.previewLogicalScrollLeft;
    this.previewLogicalScrollLeft = undefined;
    const previewHorizontalState = this.previewHorizontalState;
    this.previewHorizontalState = undefined;
    this.horizontalSuspended = previewHorizontalState?.suspended;
    this.horizontalPinnedStartWidth = previewHorizontalState?.pinnedStartWidth ?? 0;
    this.horizontalPinningKey = previewHorizontalState?.pinningKey ?? "";
    for (const property of this.previewStyleProperties) {
      this.element?.style.removeProperty(property);
    }
    this.previewStyleProperties.clear();
    if (this.element !== null) {
      const logicalScrollTop = this.readLogicalScrollTop(this.element, false);
      const restoredLogicalScrollLeft =
        logicalScrollLeft === undefined
          ? this.readLogicalScrollLeft(this.element)
          : Math.min(
              logicalScrollLeft,
              horizontalScrollMaximum(this.layout, this.effectiveViewportWidth(this.element)),
            );
      this.logicalScrollLeft = restoredLogicalScrollLeft;
      this.setLogicalScrollLeft(this.element, restoredLogicalScrollLeft);
      this.writePinnedEditorGeometry(restoredLogicalScrollLeft);
      this.writeScrollbarOverlay(this.element, logicalScrollTop, restoredLogicalScrollLeft);
      if (publishSnapshot) {
        const next = createViewportSnapshot(this.layout, {
          logicalScrollTop: quantizeScroll(logicalScrollTop),
          scrollLeft: restoredLogicalScrollLeft,
          width: this.effectiveViewportWidth(this.element),
          height: this.element.clientHeight,
        });
        this.writeRowWindowOffset(this.element.scrollTop, logicalScrollTop, next.virtualWindow);
        this.publishSnapshot(next);
      }
    }
  };

  private publishSnapshot(
    next: BrunoTableViewportSnapshot,
    columnOverscan = COLUMN_OVERSCAN,
    allowBodyColumnPreparation = false,
  ): void {
    const sharedVirtualWindow = shareVirtualWindowColumns(
      next.virtualWindow,
      this.snapshot.virtualWindow,
    );
    const sharedNext =
      sharedVirtualWindow === next.virtualWindow
        ? next
        : Object.freeze({ ...next, virtualWindow: sharedVirtualWindow });
    const snapshotChanged = !(
      sharedNext.width === this.snapshot.width &&
      sharedNext.height === this.snapshot.height &&
      sameVirtualWindow(sharedNext.virtualWindow, this.snapshot.virtualWindow)
    );
    const bodyColumnWindowCoversViewport = this.bodyColumnWindowCoversViewport(sharedNext);
    const canPrepareBodyColumns =
      allowBodyColumnPreparation &&
      areAdjacentCenterWindows(this.snapshot.virtualWindow, sharedNext.virtualWindow) &&
      bodyColumnWindowCoversViewport;
    if (snapshotChanged) this.snapshot = sharedNext;
    const nextRowRange = rowRangeFromVirtualWindow(sharedNext.virtualWindow);
    const rowRangeChanged = !sameRowRange(this.rowRange, nextRowRange);
    if (rowRangeChanged) {
      this.rowRange = nextRowRange;
    }
    if (
      this.reconcileBodyColumnWindow(
        sharedNext.virtualWindow,
        canPrepareBodyColumns,
        bodyColumnWindowCoversViewport,
      )
    ) {
      this.bodyColumnWindowOverscan = columnOverscan;
    }
    const headerColumnWindowChanged = this.reconcileHeaderColumnWindow(sharedNext.virtualWindow);
    const renderSnapshotChanged = !sameViewportOutsideCenterWindow(this.renderSnapshot, sharedNext);
    if (renderSnapshotChanged) this.renderSnapshot = sharedNext;
    if (snapshotChanged) {
      for (const listener of this.listeners) listener();
    }
    if (rowRangeChanged) {
      for (const listener of this.rowRangeListeners) listener();
    }
    if (renderSnapshotChanged) {
      for (const listener of this.renderListeners) listener();
    }
    if (headerColumnWindowChanged) {
      for (const listener of this.headerColumnWindowListeners) listener();
    }
    this.flushPendingColumnWindowNotifications();
  }

  private reconcileHeaderColumnWindow(window: BrunoTableVirtualWindow): boolean {
    const columns = window.pinningSuspended ? this.layout.suspendedCenter : this.layout.center;
    const offsets = window.pinningSuspended
      ? this.layout.suspendedCenterOffsets
      : this.layout.centerOffsets;
    const targetStart = window.centerStartIndex;
    const targetEnd = targetStart + window.center.length;
    const current = this.headerColumnWindow;
    const currentEnd = current.centerStartIndex + current.center.length;
    const currentMatchesLayout = current.center.every(
      (column, index) => columns[current.centerStartIndex + index] === column,
    );
    if (
      currentMatchesLayout &&
      current.center.length > 0 &&
      current.centerStartIndex <= targetStart &&
      currentEnd >= targetEnd
    ) {
      return false;
    }
    const maximumCount = Math.min(
      Math.max(window.center.length + HEADER_COLUMN_OVERSCAN * 2, window.center.length),
      columns.length,
    );
    let start: number;
    let end: number;
    if (
      currentMatchesLayout &&
      current.center.length > 0 &&
      targetStart < current.centerStartIndex
    ) {
      start = targetStart;
      end = Math.min(Math.max(currentEnd, targetEnd), start + maximumCount);
    } else if (currentMatchesLayout && current.center.length > 0 && targetEnd > currentEnd) {
      end = targetEnd;
      start = Math.max(Math.min(current.centerStartIndex, targetStart), end - maximumCount);
    } else {
      start = Math.max(targetStart - HEADER_COLUMN_OVERSCAN, 0);
      end = Math.min(targetEnd + HEADER_COLUMN_OVERSCAN, columns.length);
    }
    const centerWidth = offsets.at(-1) ?? 0;
    const next = Object.freeze({
      center: Object.freeze(columns.slice(start, end)),
      centerStartIndex: start,
      leftPadding: offsets[start] ?? 0,
      rightPadding: Math.max(centerWidth - (offsets[end] ?? centerWidth), 0),
    });
    if (sameBodyColumnWindow(current, next)) return false;
    this.headerColumnWindow = next;
    return true;
  }

  private bodyColumnWindowCoversViewport(next: BrunoTableViewportSnapshot): boolean {
    const suspended = next.virtualWindow.pinningSuspended;
    const centerWidth = suspended ? this.layout.suspendedCenterWidth : this.layout.centerWidth;
    const visibleWidth = Math.max(
      next.width - (suspended ? 0 : this.layout.pinnedStartWidth + this.layout.pinnedEndWidth),
      0,
    );
    const visibleStart = Math.min(Math.max(this.logicalScrollLeft, 0), centerWidth);
    const visibleEnd = Math.min(visibleStart + visibleWidth, centerWidth);
    return (
      this.bodyColumnWindow.leftPadding <= visibleStart &&
      centerWidth - this.bodyColumnWindow.rightPadding >= visibleEnd
    );
  }

  private reconcileBodyColumnWindow(
    window: BrunoTableVirtualWindow,
    allowPreparation: boolean,
    currentWindowCoversViewport: boolean,
  ): boolean {
    const target = bodyColumnWindowFromVirtualWindow(window);
    const preparation = this.bodyColumnPreparation;
    if (preparation !== undefined && sameBodyColumnWindow(preparation.target, target)) {
      if (currentWindowCoversViewport) return false;
      this.settleBodyColumnWindow(target);
      return true;
    }
    if (preparation !== undefined) {
      if (!allowPreparation || !currentWindowCoversViewport) {
        this.settleBodyColumnWindow(target);
        return true;
      }
      this.deferredBodyColumnPreparationPending = true;
      return false;
    }
    const changed = !sameBodyColumnWindow(this.bodyColumnWindow, target);
    if (!changed) return false;
    if (
      allowPreparation &&
      this.rowRange.rowEnd - this.rowRange.rowStart > CENTER_ROW_PREPARATION_BATCH_SIZE
    ) {
      this.startBodyColumnPreparation(target);
      return true;
    }
    this.settleBodyColumnWindow(target);
    return true;
  }

  private settleBodyColumnWindow(target: BrunoTableBodyColumnWindowSnapshot): void {
    const preparedRows = [...this.preparedBodyRowColumnWindows.keys()];
    const columnWindowChanged = !sameBodyColumnWindow(this.bodyColumnWindow, target);
    this.preparedBodyRowColumnWindows.clear();
    this.bodyColumnPreparation = undefined;
    this.deferredBodyColumnPreparationPending = false;
    this.resetPreparedBodyColumnDisplay();
    this.clearPreparedBodyColumnPadding();
    const previousWindow = this.bodyColumnWindow;
    this.bodyColumnWindow = target;
    if (columnWindowChanged) this.notifyHeaderColumnActivity(previousWindow, target);
    if (columnWindowChanged) this.pendingColumnWindowNotification = true;
    const affectedRows = new Set(preparedRows);
    if (columnWindowChanged) {
      for (const rowIndex of this.bodyRowColumnWindowListeners.keys()) {
        affectedRows.add(rowIndex);
      }
    }
    for (const rowIndex of affectedRows) {
      this.pendingBodyRowColumnWindowNotifications.add(rowIndex);
    }
  }

  private advanceBodyColumnPreparation(): void {
    const preparation = this.bodyColumnPreparation;
    if (preparation === undefined) return;
    if (preparation.phase === "prepare" || preparation.phase === "promote") {
      let currentRowsPrepared = true;
      for (const rowIndex of preparation.preparedRows) {
        if (rowIndex < this.rowRange.rowStart || rowIndex >= this.rowRange.rowEnd) {
          preparation.preparedRows.delete(rowIndex);
          this.preparedBodyRowColumnWindows.delete(rowIndex);
        }
      }
      for (let rowIndex = this.rowRange.rowStart; rowIndex < this.rowRange.rowEnd; rowIndex += 1) {
        if (!preparation.preparedRows.has(rowIndex)) {
          currentRowsPrepared = false;
          break;
        }
      }
      if (preparation.phase === "promote" && !currentRowsPrepared) {
        preparation.phase = "prepare";
      }
    }
    if (preparation.phase === "prepare") {
      const pendingRows: number[] = [];
      for (
        let rowIndex = this.rowRange.rowStart;
        rowIndex < this.rowRange.rowEnd && pendingRows.length < CENTER_ROW_PREPARATION_BATCH_SIZE;
        rowIndex += 1
      ) {
        if (!preparation.preparedRows.has(rowIndex)) pendingRows.push(rowIndex);
      }
      for (const rowIndex of pendingRows) {
        preparation.preparedRows.add(rowIndex);
        this.preparedBodyRowColumnWindows.set(
          rowIndex,
          Object.freeze({
            ...this.bodyColumnWindow,
            preparedCenter: preparation.preparedCenter,
            preparedCenterStartIndex: preparation.preparedCenterStartIndex,
            preparedSourceCenterStartIndex: preparation.sourceCenterStartIndex,
            preparedSourceCenterEndIndex: preparation.sourceCenterEndIndex,
            preparedTargetCenterStartIndex: preparation.target.centerStartIndex,
            preparedTargetCenterEndIndex:
              preparation.target.centerStartIndex + preparation.target.center.length,
          }),
        );
        this.pendingBodyRowColumnWindowNotifications.add(rowIndex);
      }
      let allCurrentRowsPrepared = true;
      for (let rowIndex = this.rowRange.rowStart; rowIndex < this.rowRange.rowEnd; rowIndex += 1) {
        if (!preparation.preparedRows.has(rowIndex)) {
          allCurrentRowsPrepared = false;
          break;
        }
      }
      if (allCurrentRowsPrepared) {
        preparation.phase = "promote";
      }
    } else if (preparation.phase === "promote") {
      preparation.phase = "cleanup";
      const previousWindow = this.bodyColumnWindow;
      this.bodyColumnWindow = preparation.target;
      this.notifyHeaderColumnActivity(previousWindow, preparation.target);
      for (const rowIndex of preparation.preparedRows) {
        this.preparedBodyRowColumnWindows.set(
          rowIndex,
          Object.freeze({
            ...preparation.target,
            preparedCenter: preparation.preparedCenter,
            preparedCenterStartIndex: preparation.preparedCenterStartIndex,
            preparedSourceCenterStartIndex: preparation.sourceCenterStartIndex,
            preparedSourceCenterEndIndex: preparation.sourceCenterEndIndex,
            preparedTargetCenterStartIndex: preparation.target.centerStartIndex,
            preparedTargetCenterEndIndex:
              preparation.target.centerStartIndex + preparation.target.center.length,
          }),
        );
      }
      this.writePreparedBodyColumnPadding(preparation.target);
      this.promotePreparedBodyColumnDisplay();
      this.pendingColumnWindowNotification = true;
    } else {
      const retiringRows = [...this.preparedBodyRowColumnWindows.keys()].slice(
        0,
        CENTER_ROW_PREPARATION_BATCH_SIZE,
      );
      for (const rowIndex of retiringRows) {
        this.preparedBodyRowColumnWindows.delete(rowIndex);
        this.pendingBodyRowColumnWindowNotifications.add(rowIndex);
      }
      if (this.preparedBodyRowColumnWindows.size === 0) {
        this.bodyColumnPreparation = undefined;
        this.resetPreparedBodyColumnDisplay();
        this.clearPreparedBodyColumnPadding();
        if (this.deferredBodyColumnPreparationPending) {
          this.deferredBodyColumnPreparationPending = false;
          const deferredTarget = bodyColumnWindowFromVirtualWindow(this.snapshot.virtualWindow);
          if (!sameBodyColumnWindow(this.bodyColumnWindow, deferredTarget)) {
            if (
              this.bodyColumnWindowCoversViewport(this.snapshot) &&
              this.rowRange.rowEnd - this.rowRange.rowStart > CENTER_ROW_PREPARATION_BATCH_SIZE
            ) {
              this.startBodyColumnPreparation(deferredTarget);
            } else this.settleBodyColumnWindow(deferredTarget);
          }
        }
      }
    }
    this.flushPendingColumnWindowNotifications();
  }

  private promotePreparedBodyColumnDisplay(): void {
    this.writePreparedBodyStyle(BRUNO_TABLE_PREPARED_ENTERING_DISPLAY_CSS_VARIABLE, "table-cell");
    this.writePreparedBodyStyle(BRUNO_TABLE_PREPARED_RETIRING_DISPLAY_CSS_VARIABLE, "none");
  }

  private startBodyColumnPreparation(target: BrunoTableBodyColumnWindowSnapshot): void {
    const prepared = preparedBodyColumnWindow(this.bodyColumnWindow, target);
    this.resetPreparedBodyColumnDisplay();
    this.writePreparedBodyColumnPadding(this.bodyColumnWindow);
    this.bodyColumnPreparation = {
      phase: "prepare",
      preparedCenter: prepared.center,
      preparedCenterStartIndex: prepared.centerStartIndex,
      preparedRows: new Set<number>(),
      sourceCenterStartIndex: this.bodyColumnWindow.centerStartIndex,
      sourceCenterEndIndex:
        this.bodyColumnWindow.centerStartIndex + this.bodyColumnWindow.center.length,
      target,
    };
  }

  private resetPreparedBodyColumnDisplay(): void {
    this.writePreparedBodyStyle(BRUNO_TABLE_PREPARED_ENTERING_DISPLAY_CSS_VARIABLE, "none");
    this.writePreparedBodyStyle(BRUNO_TABLE_PREPARED_RETIRING_DISPLAY_CSS_VARIABLE, "table-cell");
  }

  private writePreparedBodyColumnPadding(window: BrunoTableBodyColumnWindowSnapshot): void {
    this.writePreparedBodyStyle(
      BRUNO_TABLE_PREPARED_LEFT_PADDING_CSS_VARIABLE,
      `${String(window.leftPadding)}px`,
    );
    this.writePreparedBodyStyle(
      BRUNO_TABLE_PREPARED_RIGHT_PADDING_CSS_VARIABLE,
      `${String(window.rightPadding)}px`,
    );
  }

  private clearPreparedBodyColumnPadding(): void {
    this.removePreparedBodyStyle(BRUNO_TABLE_PREPARED_LEFT_PADDING_CSS_VARIABLE);
    this.removePreparedBodyStyle(BRUNO_TABLE_PREPARED_RIGHT_PADDING_CSS_VARIABLE);
  }

  private writePreparedBodyStyle(property: string, value: string): void {
    if (this.preparedBodyStyles.get(property) === value) return;
    this.preparedBodyStyles.set(property, value);
    for (const layer of this.bodyLayers) layer.style.setProperty(property, value);
  }

  private removePreparedBodyStyle(property: string): void {
    if (!this.preparedBodyStyles.delete(property)) return;
    for (const layer of this.bodyLayers) layer.style.removeProperty(property);
  }

  private flushPendingColumnWindowNotifications(): void {
    if (this.pendingColumnWindowNotification) {
      this.pendingColumnWindowNotification = false;
      for (const listener of this.columnWindowListeners) listener();
    }
    const rowIndexes = [...this.pendingBodyRowColumnWindowNotifications];
    this.pendingBodyRowColumnWindowNotifications.clear();
    for (const rowIndex of rowIndexes) this.notifyBodyRowColumnWindow(rowIndex);
  }

  private notifyHeaderColumnActivity(
    previous: BrunoTableBodyColumnWindowSnapshot,
    next: BrunoTableBodyColumnWindowSnapshot,
  ): void {
    const previousIds = new Set(previous.center.map((column) => column.columnId));
    const nextIds = new Set(next.center.map((column) => column.columnId));
    for (const columnId of new Set([...previousIds, ...nextIds])) {
      if (previousIds.has(columnId) === nextIds.has(columnId)) continue;
      const element = this.headerColumnElements.get(columnId);
      if (element !== undefined) this.writeHeaderColumnActivity(columnId, element);
    }
  }

  private writeHeaderColumnActivity(columnId: string, element: HTMLElement): void {
    const active = this.getHeaderColumnActivitySnapshot(columnId);
    const retainedHeaderId = element.dataset["brunoRetainedHeaderId"];
    const grid = element.closest<HTMLElement>('[role="grid"]');
    const ownsActiveDescendant =
      retainedHeaderId !== undefined &&
      grid?.getAttribute("aria-activedescendant") === retainedHeaderId;
    const currentIdOwner =
      retainedHeaderId === undefined
        ? null
        : element.ownerDocument.getElementById(retainedHeaderId);
    element.style.visibility = active ? "visible" : "hidden";
    if (active) {
      element.dataset["brunoColumnId"] = columnId;
      // An active-descendant proxy keeps the stable id until React removes it.
      // Its layout-effect cleanup transfers the id to this already-visible
      // header, so assistive technology never observes zero or two owners.
      if (!ownsActiveDescendant || currentIdOwner === element) {
        element.id = retainedHeaderId ?? "";
      }
      element.removeAttribute("aria-hidden");
    } else {
      delete element.dataset["brunoColumnId"];
      // Keep an active real header as the id owner until the proxy has mounted.
      // The proxy layout effect completes the inverse handoff atomically.
      if (!ownsActiveDescendant || currentIdOwner !== element) {
        element.removeAttribute("id");
      }
      element.setAttribute("aria-hidden", "true");
    }
    const menuTrigger = element.querySelector<HTMLElement>(
      "[data-bruno-retained-column-menu-trigger]",
    );
    if (menuTrigger === null) return;
    if (active) {
      menuTrigger.dataset["brunoColumnMenuTrigger"] = columnId;
      menuTrigger.id = menuTrigger.dataset["brunoRetainedColumnMenuTrigger"] ?? "";
    } else {
      delete menuTrigger.dataset["brunoColumnMenuTrigger"];
      menuTrigger.removeAttribute("id");
    }
  }

  private notifyBodyRowColumnWindow(logicalRowIndex: number): void {
    for (const listener of this.bodyRowColumnWindowListeners.get(logicalRowIndex) ?? []) listener();
  }

  public readonly revealCell = (
    rowIndex: number,
    columnId: string,
    region: "header" | "body" = "body",
    rowId?: string,
  ): void => {
    if (this.element === null) return;
    this.pendingReveal = Object.freeze({
      rowIndex,
      columnId,
      region,
      ...(rowId === undefined ? {} : { rowId }),
    });
    this.schedulePublish();
  };

  public rebasePendingReveal = (
    findRowIndex: ((rowId: string) => number | undefined) | undefined,
  ): void => {
    const pending = this.pendingReveal;
    if (
      pending === undefined ||
      pending.region === "header" ||
      pending.rowId === undefined ||
      findRowIndex === undefined
    ) {
      return;
    }
    const rowIndex = findRowIndex(pending.rowId);
    this.pendingReveal =
      rowIndex === undefined ? undefined : Object.freeze({ ...pending, rowIndex });
  };

  private applyReveal(target: RevealTarget): HorizontalReconciliation | undefined {
    const element = this.element;
    const column = this.layout.columns.find((candidate) => candidate.columnId === target.columnId);
    if (element === null || column === undefined) return undefined;
    const deferredLogicalScrollLeft = this.reconcileHorizontalEnvironment(element, true);
    if (target.region === "body") {
      const logicalScrollTop = this.readLogicalScrollTop(element, false);
      const rowTop = this.layout.headerHeight + target.rowIndex * ROW_HEIGHT;
      const rowBottom = rowTop + ROW_HEIGHT;
      const visibleTop = logicalScrollTop + this.layout.headerHeight;
      const visibleBottom = logicalScrollTop + element.clientHeight;
      let nextLogicalScrollTop = logicalScrollTop;
      if (rowTop < visibleTop) {
        nextLogicalScrollTop = Math.max(rowTop - this.layout.headerHeight, 0);
      } else if (rowBottom > visibleBottom) {
        nextLogicalScrollTop = Math.max(rowBottom - element.clientHeight, 0);
      }
      this.setLogicalScrollTop(element, nextLogicalScrollTop);
    }
    if (typeof deferredLogicalScrollLeft === "number") {
      this.pendingReveal = target;
      return deferredLogicalScrollLeft;
    }
    const viewportWidth = this.effectiveViewportWidth(element);
    const suspendPinning = shouldSuspendPinning(this.layout, viewportWidth);
    if (!suspendPinning && column.pinned !== undefined) return HORIZONTAL_RECONCILIATION_SETTLED;
    const center = suspendPinning ? this.layout.suspendedCenter : this.layout.center;
    const centerOffsets = suspendPinning
      ? this.layout.suspendedCenterOffsets
      : this.layout.centerOffsets;
    const centerIndex = center.findIndex((candidate) => candidate.columnId === target.columnId);
    const centerOffset = centerOffsets[centerIndex] ?? 0;
    const centerEnd = centerOffset + column.semantics.width;
    // The semantic table keeps pinned columns in the scrollable inline layout and makes
    // them sticky. The normalized logical scroll coordinate therefore identifies the
    // centre-content origin; subtracting the pinned-start inset would double-count it.
    const centerScrollLeft = this.readLogicalScrollLeft(element);
    const centerViewportWidth = Math.max(
      viewportWidth -
        (suspendPinning ? 0 : this.layout.pinnedStartWidth + this.layout.pinnedEndWidth),
      0,
    );
    const columnWidth = centerEnd - centerOffset;
    if (columnWidth > centerViewportWidth) {
      const viewportEnd = centerScrollLeft + centerViewportWidth;
      if (centerEnd <= centerScrollLeft) {
        this.setLogicalScrollLeft(element, Math.max(centerEnd - centerViewportWidth, 0));
      } else if (centerOffset >= viewportEnd) {
        this.setLogicalScrollLeft(element, centerOffset);
      }
    } else if (centerOffset < centerScrollLeft) {
      this.setLogicalScrollLeft(element, centerOffset);
    } else if (centerEnd > centerScrollLeft + centerViewportWidth) {
      this.setLogicalScrollLeft(element, centerEnd - centerViewportWidth);
    }
    return HORIZONTAL_RECONCILIATION_SETTLED;
  }

  public readonly resetVertical = (): void => {
    if (this.element === null) return;
    this.resolveDirectionAndDetectPendingNativeInput(this.element, true);
    this.pendingReveal = undefined;
    this.segmentLogicalBase = 0;
    this.segmentPhysicalAnchor = 0;
    this.lastPhysicalScrollTop = 0;
    setNativeScrollTop(this.element, 0);
    if (this.directionDirty) this.refreshHorizontalDirection(this.element);
    const pendingHorizontalCoordinate =
      this.horizontalInputSample ?? this.pendingLayoutHorizontalCoordinate;
    const projectedLogicalScrollLeft =
      pendingHorizontalCoordinate === undefined
        ? undefined
        : this.projectLayoutLogicalScrollLeft(this.element, pendingHorizontalCoordinate);
    if (
      this.layoutReconciliationPending &&
      projectedLogicalScrollLeft !== undefined &&
      this.layoutReconciliationDeferrals < MAX_REVERSE_RTL_LAYOUT_DEFERRALS &&
      this.shouldDeferReverseRtlLayoutWrite(this.element, projectedLogicalScrollLeft)
    ) {
      this.pendingLayoutHorizontalCoordinate = this.captureHorizontalCoordinate(
        this.element,
        projectedLogicalScrollLeft,
      );
      this.layoutReconciliationDeferrals += 1;
      this.horizontalInputPending = false;
      this.horizontalInputSample = undefined;
      this.horizontalInputNativeScrollLeft = undefined;
      this.horizontalInputEventOrder = undefined;
      this.publishCoordinates(this.element, 0, projectedLogicalScrollLeft);
      this.schedulePublish();
      return;
    }
    this.publishFromElement();
  };

  public readonly attach = (element: HTMLElement | null): void => {
    if (this.element === element) return;
    this.clearColumnWidthPreview(false);
    this.element?.removeEventListener("scroll", this.handleScroll);
    this.element?.removeEventListener("focusin", this.handleDirectionMutation);
    this.element?.removeEventListener("focusout", this.handleDirectionMutation);
    this.stylesheetRoot?.removeEventListener("load", this.handleDirectionMutation, true);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.directionObserver?.disconnect();
    this.directionObserver = null;
    this.element = element;
    this.stylesheetRoot = element?.ownerDocument?.head ?? null;
    this.residentRowOverscan = ROW_OVERSCAN;
    this.segmentLogicalBase = 0;
    this.segmentPhysicalAnchor = 0;
    this.lastPhysicalScrollTop = element?.scrollTop ?? 0;
    this.horizontalSuspended = undefined;
    this.horizontalPinnedStartWidth = 0;
    this.horizontalPinningKey = "";
    this.horizontalDirection = element === null ? "ltr" : readHorizontalDirection(element);
    this.rtlScrollType =
      this.horizontalDirection === "rtl" ? rtlScrollType(element?.ownerDocument) : "negative";
    this.directionDirty = false;
    this.horizontalInputPending = false;
    this.programmaticHorizontalScrollPending = false;
    this.horizontalInputSample = undefined;
    this.horizontalInputNativeScrollLeft = undefined;
    this.horizontalEventOrder = 0;
    this.horizontalInputEventOrder = undefined;
    this.horizontalEnvironmentEventOrder = undefined;
    this.directionScrollGuard = undefined;
    this.forceGuardedDirectionReconciliation = false;
    this.horizontalViewportWidth = element === null ? 0 : this.effectiveViewportWidth(element);
    this.viewportDimensions = undefined;
    this.lastNativeScrollLeft = element?.scrollLeft ?? 0;
    this.layoutReconciliationPending = false;
    this.layoutReconciliationDeferrals = 0;
    this.logicalScrollLeft = 0;
    this.pendingLayoutHorizontalCoordinate = undefined;
    this.preparedBodyRowColumnWindows.clear();
    this.bodyColumnPreparation = undefined;
    this.deferredBodyColumnPreparationPending = false;
    this.element?.addEventListener("scroll", this.handleScroll, { passive: true });
    this.element?.addEventListener("focusin", this.handleDirectionMutation, { passive: true });
    this.element?.addEventListener("focusout", this.handleDirectionMutation, { passive: true });
    this.stylesheetRoot?.addEventListener("load", this.handleDirectionMutation, true);
    if (this.element !== null && typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(this.handleResize);
      this.resizeObserver.observe(this.element);
      if (this.headerElement !== null) {
        this.resizeObserver.observe(this.headerElement, { box: "border-box" });
      }
    }
    if (this.element !== null && typeof MutationObserver !== "undefined") {
      this.directionObserver = new MutationObserver(this.handleDirectionMutation);
      for (
        let directionOwner: HTMLElement | null = this.element;
        directionOwner !== null;
        directionOwner = directionOwner.parentElement
      ) {
        this.directionObserver.observe(directionOwner, {
          attributes: true,
          attributeFilter: ["class", "dir", "style"],
        });
      }
      if (this.stylesheetRoot !== null) {
        this.directionObserver.observe(this.stylesheetRoot, {
          attributes: true,
          attributeFilter: ["disabled", "href", "media"],
          childList: true,
          characterData: true,
          subtree: true,
        });
      }
    }
    this.publishFromElement();
  };

  public readonly attachHeader = (element: HTMLElement | null): void => {
    if (this.headerElement === element) return;
    if (this.headerElement !== null) this.resizeObserver?.unobserve(this.headerElement);
    this.headerElement = element;
    if (element === null) return;
    this.measureHeader();
    this.resizeObserver?.observe(element, { box: "border-box" });
  };

  private readonly measureHeader = (height = this.headerElement?.offsetHeight): void => {
    if (height === undefined || height <= 0 || height === this.headerHeight) return;
    this.headerHeight = height;
    this.layout = Object.freeze({ ...this.layout, headerHeight: height });
    if (this.previewLayout !== undefined) {
      this.previewLayout = Object.freeze({ ...this.previewLayout, headerHeight: height });
    }
    this.rowLayer?.style.setProperty(BRUNO_TABLE_HEADER_HEIGHT_CSS_VARIABLE, `${height}px`);
    this.headerEnvironmentDirty = true;
    this.schedulePublish();
  };

  public readonly attachRowLayer = (element: HTMLElement | null): void => {
    if (this.rowLayer === element) return;
    this.rowLayer?.style.removeProperty(BRUNO_TABLE_HEADER_HEIGHT_CSS_VARIABLE);
    this.rowLayerResizeObserver?.disconnect();
    this.rowLayerResizeObserver = null;
    this.rowLayer = element;
    if (element !== null) {
      element.style.setProperty(BRUNO_TABLE_HEADER_HEIGHT_CSS_VARIABLE, `${this.headerHeight}px`);
      if (typeof ResizeObserver !== "undefined") {
        this.rowLayerResizeObserver = new ResizeObserver(this.handleRowLayerResize);
        this.rowLayerResizeObserver.observe(element);
      }
    }
  };

  public readonly attachBodyLayer = (element: HTMLElement | null): (() => void) | undefined => {
    if (element === null) return;
    this.bodyLayers.add(element);
    element.style.setProperty("transform", rowLayerTransform(this.rowLayerOffset));
    for (const [property, value] of this.preparedBodyStyles) {
      element.style.setProperty(property, value);
    }
    return () => {
      this.bodyLayers.delete(element);
      for (const property of this.preparedBodyStyles.keys()) element.style.removeProperty(property);
    };
  };

  public readonly attachPinnedEditorHost = (element: HTMLElement | null): void => {
    if (this.pinnedEditorHost === element) return;
    this.clearPinnedEditorGeometry(this.pinnedEditorHost);
    this.pinnedEditorHost = element;
    this.writePinnedEditorGeometry(this.logicalScrollLeft);
  };

  public readonly attachScrollbarOverlay = (element: HTMLElement | null): void => {
    if (this.scrollbarOverlay === element) return;
    this.scrollbarOverlay = element;
    this.scrollbarOverlayDirection = undefined;
    this.scrollbarOverlayStructuralKey = undefined;
    this.publishFromElement();
  };

  public readonly dispose = (): void => {
    this.clearColumnWidthPreview();
    this.element?.removeEventListener("scroll", this.handleScroll);
    this.element?.removeEventListener("focusin", this.handleDirectionMutation);
    this.element?.removeEventListener("focusout", this.handleDirectionMutation);
    this.stylesheetRoot?.removeEventListener("load", this.handleDirectionMutation, true);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.rowLayerResizeObserver?.disconnect();
    this.rowLayerResizeObserver = null;
    this.headerElement = null;
    this.directionObserver?.disconnect();
    this.directionObserver = null;
    this.stylesheetRoot = null;
    this.element = null;
    this.rowLayer?.style.removeProperty(BRUNO_TABLE_HEADER_HEIGHT_CSS_VARIABLE);
    this.rowLayer = null;
    for (const property of this.preparedBodyStyles.keys()) this.removePreparedBodyStyle(property);
    this.bodyLayers.clear();
    this.clearPinnedEditorGeometry(this.pinnedEditorHost);
    this.pinnedEditorHost = null;
    this.scrollbarOverlay = null;
    this.scrollbarOverlayDirection = undefined;
    this.scrollbarOverlayStructuralKey = undefined;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.pendingReveal = undefined;
    this.lastAppliedReveal = undefined;
    this.residentRowOverscan = ROW_OVERSCAN;
    this.segmentLogicalBase = 0;
    this.segmentPhysicalAnchor = 0;
    this.lastPhysicalScrollTop = 0;
    this.horizontalSuspended = undefined;
    this.horizontalPinnedStartWidth = 0;
    this.horizontalPinningKey = "";
    this.horizontalDirection = "ltr";
    this.rtlScrollType = "negative";
    this.directionDirty = false;
    this.horizontalInputPending = false;
    this.horizontalInputSample = undefined;
    this.horizontalInputNativeScrollLeft = undefined;
    this.horizontalEventOrder = 0;
    this.horizontalInputEventOrder = undefined;
    this.horizontalEnvironmentEventOrder = undefined;
    this.directionScrollGuard = undefined;
    this.forceGuardedDirectionReconciliation = false;
    this.horizontalViewportWidth = 0;
    this.viewportDimensions = undefined;
    this.lastNativeScrollLeft = 0;
    this.layoutReconciliationPending = false;
    this.layoutReconciliationDeferrals = 0;
    this.logicalScrollLeft = 0;
    this.pendingLayoutHorizontalCoordinate = undefined;
    this.rowLayerOffset = "0px";
    this.preparedBodyRowColumnWindows.clear();
    this.bodyColumnPreparation = undefined;
    this.deferredBodyColumnPreparationPending = false;
    this.pendingBodyRowColumnWindowNotifications.clear();
    this.pendingColumnWindowNotification = false;
    this.bodyRowColumnWindowListeners.clear();
    this.columnWindowListeners.clear();
    this.headerColumnWindowListeners.clear();
    this.headerColumnElements.clear();
    this.listeners.clear();
    this.renderListeners.clear();
    this.rowRangeListeners.clear();
    this.frameCommitListeners.clear();
  };

  private readonly handleScroll = (): void => {
    const element = this.element;
    if (element !== null) {
      if (this.directionScrollGuard !== undefined && element.scrollLeft === 0) {
        this.forceGuardedDirectionReconciliation = true;
        this.horizontalInputPending = false;
        this.horizontalInputNativeScrollLeft = undefined;
        this.horizontalInputSample = undefined;
        this.schedulePublish();
        return;
      }
      this.directionScrollGuard = undefined;
      if (
        !this.directionDirty &&
        element.scrollTop === this.lastPhysicalScrollTop &&
        element.scrollLeft === this.lastNativeScrollLeft
      ) {
        return;
      }
      this.recordPendingNativeInput(element);
    }
    this.schedulePublish();
  };
  private readonly handleResize = (entries: readonly ResizeObserverEntry[]): void => {
    const headerEntry = entries.find((entry) => entry.target === this.headerElement);
    if (headerEntry !== undefined) this.measureHeader(headerEntry.borderBoxSize[0]?.blockSize);
    const element = this.element;
    if (element !== null) {
      if (this.directionDirty) this.recordPendingNativeInput(element);
      this.horizontalEventOrder += 1;
      this.horizontalEnvironmentEventOrder ??= this.horizontalEventOrder;
      this.directionDirty = true;
    }
    this.schedulePublish();
  };
  private readonly handleDirectionMutation = (): void => {
    const element = this.element;
    if (element === null) return;
    if (this.directionDirty) this.recordPendingNativeInput(element);
    this.horizontalEventOrder += 1;
    this.horizontalEnvironmentEventOrder ??= this.horizontalEventOrder;
    this.directionDirty = true;
    this.schedulePublish();
  };
  private readonly handleRowLayerResize = (): void => {
    if (!this.layoutReconciliationPending) return;
    this.layoutReconciliationDeferrals = 0;
    this.schedulePublish();
  };

  private readonly schedulePublish = (): void => {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      // Retire the consumed frame before fallible synchronous renderer work.
      this.frame = null;
      let failed = false;
      let firstFailure: unknown;
      const notifyFrameCommit = (): void => {
        for (const listener of this.frameCommitListeners) {
          try {
            listener();
          } catch (error) {
            if (!failed) firstFailure = error;
            failed = true;
          }
        }
      };
      let prePublishFailed = false;
      try {
        notifyFrameCommit();
        prePublishFailed = failed;
        if (failed) throw firstFailure;
        const publishFrame = (): void => {
          if (
            this.bodyColumnPreparation !== undefined &&
            this.pendingReveal === undefined &&
            !this.horizontalInputPending &&
            !this.programmaticHorizontalScrollPending &&
            !this.directionDirty &&
            !this.layoutReconciliationPending &&
            (this.element === null || this.element.scrollTop === this.lastPhysicalScrollTop)
          ) {
            this.advanceBodyColumnPreparation();
            if (this.bodyColumnPreparation !== undefined) this.schedulePublish();
            return;
          }
          const reveal = this.pendingReveal;
          this.pendingReveal = undefined;
          const logicalScrollTopBeforeReveal =
            reveal === undefined || this.element === null
              ? undefined
              : this.readLogicalScrollTop(this.element, false);
          const previousReveal = this.lastAppliedReveal;
          const horizontalReconciliation =
            reveal === undefined ? undefined : this.applyReveal(reveal);
          if (reveal !== undefined) this.lastAppliedReveal = reveal;
          const repeatedBodyRowReveal =
            reveal !== undefined &&
            this.element !== null &&
            this.readLogicalScrollTop(this.element, false) === logicalScrollTopBeforeReveal &&
            reveal.region === "body" &&
            previousReveal?.region === "body" &&
            previousReveal.rowIndex === reveal.rowIndex;
          const nativeScrollPending =
            reveal === undefined &&
            this.element !== null &&
            (this.horizontalInputPending ||
              this.programmaticHorizontalScrollPending ||
              this.element.scrollTop !== this.lastPhysicalScrollTop);
          const rowOverscan = repeatedBodyRowReveal
            ? HORIZONTAL_REVEAL_ROW_OVERSCAN
            : nativeScrollPending
              ? STEADY_SCROLL_ROW_OVERSCAN
              : this.residentRowOverscan;
          const programmaticHorizontalScrollPending = this.programmaticHorizontalScrollPending;
          this.publishFromElement(
            horizontalReconciliation,
            rowOverscan,
            nativeScrollPending ? STEADY_SCROLL_COLUMN_OVERSCAN : COLUMN_OVERSCAN,
            nativeScrollPending,
          );
          if (programmaticHorizontalScrollPending && this.bodyColumnPreparation !== undefined) {
            this.advanceBodyColumnPreparation();
          }
          if (this.bodyColumnPreparation !== undefined) this.schedulePublish();
          if (
            this.pendingReveal !== undefined &&
            this.layoutReconciliationDeferrals < MAX_REVERSE_RTL_LAYOUT_DEFERRALS
          ) {
            this.schedulePublish();
          }
        };
        publishFrame();
      } catch (error) {
        if (!failed) firstFailure = error;
        failed = true;
      }
      if (!prePublishFailed) notifyFrameCommit();
      if (failed) throw firstFailure;
    });
  };

  private readLogicalScrollTop(
    element: HTMLElement,
    rebase: boolean,
    clientHeight = element.clientHeight,
  ): number {
    const physicalMaximum = physicalScrollMaximum(this.layout, clientHeight);
    const logicalMaximum = logicalScrollMaximum(this.layout, clientHeight);
    if (logicalMaximum <= physicalMaximum || physicalMaximum === 0) {
      this.segmentLogicalBase = 0;
      this.segmentPhysicalAnchor = 0;
      const logicalScrollTop = Math.min(Math.max(element.scrollTop, 0), logicalMaximum);
      this.lastPhysicalScrollTop = element.scrollTop;
      return logicalScrollTop;
    }
    if (rebase && element.scrollTop <= 0) {
      this.setLogicalScrollTop(element, 0, clientHeight);
      return 0;
    }
    if (rebase && element.scrollTop >= physicalMaximum - 1) {
      this.setLogicalScrollTop(element, logicalMaximum, clientHeight);
      return logicalMaximum;
    }
    if (
      rebase &&
      Math.abs(element.scrollTop - this.lastPhysicalScrollTop) >
        Math.max(clientHeight * 4, ROW_HEIGHT * 20)
    ) {
      const proportionalLogicalScrollTop = (element.scrollTop / physicalMaximum) * logicalMaximum;
      this.setLogicalScrollTop(element, proportionalLogicalScrollTop, clientHeight);
      return proportionalLogicalScrollTop;
    }
    const logicalScrollTop = Math.min(
      Math.max(this.segmentLogicalBase + element.scrollTop - this.segmentPhysicalAnchor, 0),
      logicalMaximum,
    );
    if (
      rebase &&
      (element.scrollTop <= physicalMaximum * 0.2 || element.scrollTop >= physicalMaximum * 0.8)
    ) {
      this.setLogicalScrollTop(element, logicalScrollTop, clientHeight);
    } else {
      this.lastPhysicalScrollTop = element.scrollTop;
    }
    return logicalScrollTop;
  }

  private setLogicalScrollTop(
    element: HTMLElement,
    requestedLogicalScrollTop: number,
    clientHeight = element.clientHeight,
  ): void {
    const physicalMaximum = physicalScrollMaximum(this.layout, clientHeight);
    const logicalMaximum = logicalScrollMaximum(this.layout, clientHeight);
    const logicalScrollTop = Math.min(Math.max(requestedLogicalScrollTop, 0), logicalMaximum);
    let physicalScrollTop: number;
    if (logicalMaximum <= physicalMaximum || physicalMaximum === 0) {
      this.segmentLogicalBase = 0;
      this.segmentPhysicalAnchor = 0;
      physicalScrollTop = logicalScrollTop;
    } else {
      const edgeSpan = physicalMaximum * 0.75;
      if (logicalScrollTop <= edgeSpan) {
        this.segmentLogicalBase = 0;
        this.segmentPhysicalAnchor = 0;
        physicalScrollTop = logicalScrollTop;
      } else if (logicalScrollTop >= logicalMaximum - edgeSpan) {
        this.segmentLogicalBase = logicalMaximum - physicalMaximum;
        this.segmentPhysicalAnchor = 0;
        physicalScrollTop = logicalScrollTop - this.segmentLogicalBase;
      } else {
        const physicalAnchor = physicalMaximum / 2;
        this.segmentLogicalBase = logicalScrollTop;
        this.segmentPhysicalAnchor = physicalAnchor;
        physicalScrollTop = physicalAnchor;
      }
    }
    setNativeScrollTop(element, physicalScrollTop);
    this.logicalScrollTop = logicalScrollTop;
    this.lastPhysicalScrollTop = physicalScrollTop;
  }

  private readonly publishFromElement = (
    horizontalReconciliation?: HorizontalReconciliation,
    rowOverscan = this.residentRowOverscan,
    columnOverscan = COLUMN_OVERSCAN,
    allowBodyColumnPreparation = false,
  ): void => {
    const element = this.element;
    if (element === null) return;
    const previousDirection = this.horizontalDirection;
    const previousViewportWidth = this.horizontalViewportWidth;
    const previousSuspended = this.horizontalSuspended;
    const previousPinnedStartWidth = this.horizontalPinnedStartWidth;
    const previousPinningKey = this.horizontalPinningKey;
    const observedNativeScrollPending =
      this.resizeObserver !== null &&
      (this.horizontalInputPending || element.scrollTop !== this.lastPhysicalScrollTop);
    const dimensions =
      (this.programmaticHorizontalScrollPending || observedNativeScrollPending) &&
      !this.directionDirty &&
      !this.layoutReconciliationPending &&
      this.viewportDimensions !== undefined
        ? this.viewportDimensions
        : this.captureViewportDimensions(element);
    const viewportWidth = dimensions.viewportWidth;
    const reconciliation =
      horizontalReconciliation ?? this.reconcileHorizontalEnvironment(element, false, dimensions);
    const environmentChanged =
      previousDirection !== this.horizontalDirection ||
      previousViewportWidth !== viewportWidth ||
      previousSuspended !== this.horizontalSuspended ||
      previousPinnedStartWidth !== this.horizontalPinnedStartWidth ||
      previousPinningKey !== this.horizontalPinningKey;
    const externalEnvironmentChanged =
      this.headerEnvironmentDirty ||
      previousDirection !== this.horizontalDirection ||
      previousViewportWidth !== viewportWidth ||
      (this.previewLayout === undefined && environmentChanged);
    if (externalEnvironmentChanged) {
      this.headerEnvironmentDirty = false;
      for (const listener of this.environmentListeners) listener();
    }
    const deferredLogicalScrollLeft =
      typeof reconciliation === "number" ? reconciliation : undefined;
    const logicalScrollTop = this.readLogicalScrollTop(element, true, dimensions.clientHeight);
    const logicalScrollLeft =
      deferredLogicalScrollLeft ??
      logicalScrollLeftFromNative(
        this.lastNativeScrollLeft,
        horizontalScrollMaximum(this.layout, dimensions.viewportWidth),
        this.horizontalDirection,
        this.rtlScrollType,
      );
    this.publishCoordinates(
      element,
      logicalScrollTop,
      logicalScrollLeft,
      dimensions,
      rowOverscan,
      columnOverscan,
      allowBodyColumnPreparation && !environmentChanged && !this.layoutReconciliationPending,
    );
    this.directionDirty = false;
    this.horizontalInputPending = false;
    this.programmaticHorizontalScrollPending = false;
    this.horizontalInputSample = undefined;
    this.horizontalInputNativeScrollLeft = undefined;
    this.horizontalInputEventOrder = undefined;
    this.horizontalEnvironmentEventOrder = undefined;
    this.horizontalViewportWidth = viewportWidth;
    if (
      deferredLogicalScrollLeft !== undefined &&
      this.layoutReconciliationDeferrals < MAX_REVERSE_RTL_LAYOUT_DEFERRALS
    ) {
      this.schedulePublish();
    }
    if (this.directionScrollGuard !== undefined) this.schedulePublish();
  };

  private publishCoordinates(
    element: HTMLElement,
    logicalScrollTop: number,
    logicalScrollLeft: number,
    capturedDimensions?: ViewportDimensions,
    rowOverscan = this.residentRowOverscan,
    columnOverscan = COLUMN_OVERSCAN,
    allowBodyColumnPreparation = false,
  ): void {
    const dimensions = capturedDimensions ?? this.captureViewportDimensions(element);
    this.logicalScrollLeft = logicalScrollLeft;
    this.logicalScrollTop = logicalScrollTop;
    this.writePinnedEditorGeometry(logicalScrollLeft, dimensions.clientWidth);
    const structuralLogicalScrollTop = quantizeScroll(logicalScrollTop);
    const structuralLogicalScrollLeft = quantizeScroll(logicalScrollLeft);
    const viewport = {
      logicalScrollTop: structuralLogicalScrollTop,
      scrollLeft: structuralLogicalScrollLeft,
      width: dimensions.viewportWidth,
      height: dimensions.clientHeight,
    };
    let baseline: BrunoTableViewportSnapshot | undefined;
    if (rowOverscan === STEADY_SCROLL_ROW_OVERSCAN && this.residentRowOverscan === ROW_OVERSCAN) {
      baseline = createViewportSnapshot(
        this.layout,
        viewport,
        this.snapshot.virtualWindow,
        ROW_OVERSCAN,
        columnOverscan,
      );
      if (
        !sameRowRange(
          rowRangeFromVirtualWindow(baseline.virtualWindow),
          rowRangeFromVirtualWindow(this.snapshot.virtualWindow),
        )
      ) {
        this.residentRowOverscan = STEADY_SCROLL_ROW_OVERSCAN;
      } else {
        rowOverscan = ROW_OVERSCAN;
      }
    }
    const next =
      baseline !== undefined && rowOverscan === ROW_OVERSCAN
        ? baseline
        : createViewportSnapshot(
            this.layout,
            viewport,
            this.snapshot.virtualWindow,
            rowOverscan,
            columnOverscan,
          );
    this.writeScrollbarOverlay(element, logicalScrollTop, logicalScrollLeft, dimensions);
    // Preview frames retain the mounted window even when scrolling computes another one.
    this.writeRowWindowOffset(
      element.scrollTop,
      logicalScrollTop,
      this.previewLayout === undefined ? next.virtualWindow : this.snapshot.virtualWindow,
    );
    if (this.previewLayout === undefined) {
      this.publishSnapshot(next, columnOverscan, allowBodyColumnPreparation);
    }
  }

  private writePinnedEditorGeometry(logicalScrollLeft: number, inlineSize?: number): void {
    const host = this.pinnedEditorHost;
    const element = this.element;
    if (host === null || element === null) return;
    host.style.setProperty(
      BRUNO_TABLE_VIEWPORT_LOGICAL_SCROLL_LEFT_CSS_VARIABLE,
      `${logicalScrollLeft}px`,
    );
    host.style.setProperty(
      BRUNO_TABLE_VIEWPORT_INLINE_SIZE_CSS_VARIABLE,
      `${inlineSize ?? element.clientWidth}px`,
    );
  }

  private clearPinnedEditorGeometry(host: HTMLElement | null): void {
    if (host === null) return;
    host.style.removeProperty(BRUNO_TABLE_VIEWPORT_LOGICAL_SCROLL_LEFT_CSS_VARIABLE);
    host.style.removeProperty(BRUNO_TABLE_VIEWPORT_INLINE_SIZE_CSS_VARIABLE);
  }

  private writeRowWindowOffset(
    physicalScrollTop: number,
    logicalScrollTop: number,
    window: BrunoTableVirtualWindow,
  ): void {
    this.writeBodyLayerOffset(
      `${
        physicalScrollTop +
        (window.segmentedRows ? window.rowStart * ROW_HEIGHT : 0) -
        logicalScrollTop
      }px`,
    );
  }

  private writeBodyLayerOffset(nextOffset: string): void {
    if (nextOffset === this.rowLayerOffset) return;
    this.rowLayerOffset = nextOffset;
    const transform = rowLayerTransform(nextOffset);
    for (const layer of this.bodyLayers) {
      layer.style.setProperty("transform", transform);
    }
  }

  private writeColumnPreviewStyles(
    columnId: string,
    previewWindow?: Pick<BrunoTableVirtualWindow, "leftPadding" | "rightPadding">,
    capturedViewportWidth?: number,
  ): void {
    const element = this.element;
    if (element === null) return;
    const set = (property: string, value: string): void => {
      element.style.setProperty(property, value);
      if (__BRUNO_TABLE_TEST_DIAGNOSTICS__) {
        recordBrunoTableClientColumnPreviewStyleWrite(property);
      }
      this.previewStyleProperties.add(property);
    };
    const column = this.layout.columns.find((candidate) => candidate.columnId === columnId);
    if (column === undefined) return;
    set(brunoTableColumnCssVariable("width", columnId), `${column.semantics.width}px`);
    if (column.pinned === "start") {
      const columnIndex = this.layout.pinnedStart.findIndex(
        (candidate) => candidate.columnId === columnId,
      );
      let offset = this.leadingUtilityWidth;
      for (const [index, candidate] of this.layout.pinnedStart.entries()) {
        if (index >= columnIndex) {
          set(
            brunoTableColumnCssVariable("pinned-start-offset", candidate.columnId),
            `${offset}px`,
          );
        }
        offset += candidate.semantics.width;
      }
      set(brunoTablePinnedWidthCssVariable("start"), `${this.layout.pinnedStartWidth}px`);
    } else if (column.pinned === "end") {
      const columnIndex = this.layout.pinnedEnd.findIndex(
        (candidate) => candidate.columnId === columnId,
      );
      let offset = 0;
      for (let index = this.layout.pinnedEnd.length - 1; index >= 0; index -= 1) {
        const candidate = this.layout.pinnedEnd[index]!;
        if (index <= columnIndex) {
          set(brunoTableColumnCssVariable("pinned-end-offset", candidate.columnId), `${offset}px`);
        }
        offset += candidate.semantics.width;
      }
      set(brunoTablePinnedWidthCssVariable("end"), `${this.layout.pinnedEndWidth}px`);
    }
    const viewportWidth = capturedViewportWidth ?? this.effectiveViewportWidth(element);
    const viewportFill =
      this.layout.pinnedEnd.length === 0 ? 0 : Math.max(0, viewportWidth - this.layout.totalWidth);
    set(BRUNO_TABLE_LIVE_VIEWPORT_FILL_CSS_VARIABLE, `${viewportFill}px`);
    const nextWindow =
      previewWindow ??
      calculateVirtualWindow(this.layout, {
        logicalScrollTop: this.readLogicalScrollTop(element, false),
        scrollLeft: this.readLogicalScrollLeft(element),
        width: viewportWidth,
        height: element.clientHeight,
      });
    set(BRUNO_TABLE_LIVE_LEFT_PADDING_CSS_VARIABLE, `${nextWindow.leftPadding}px`);
    set(BRUNO_TABLE_LIVE_RIGHT_PADDING_CSS_VARIABLE, `${nextWindow.rightPadding}px`);
    set(BRUNO_TABLE_LIVE_TOTAL_WIDTH_CSS_VARIABLE, `${this.layout.totalWidth + viewportFill}px`);
  }

  private projectLayoutLogicalScrollLeft(
    element: HTMLElement,
    sampledCoordinate: HorizontalCoordinateSample | undefined,
  ): number {
    const requestedLogicalScrollLeft =
      sampledCoordinate?.logicalScrollLeft ?? this.logicalScrollLeft;
    const sourceInset = sampledCoordinate?.suspended ? sampledCoordinate.pinnedStartWidth : 0;
    const viewportWidth = this.effectiveViewportWidth(element);
    const nextInset = shouldSuspendPinning(this.layout, viewportWidth)
      ? this.layout.pinnedStartWidth
      : 0;
    const convertedLogicalScrollLeft =
      sampledCoordinate?.pinningKey === this.layoutPinningKey && sourceInset !== nextInset
        ? requestedLogicalScrollLeft - sourceInset + nextInset
        : requestedLogicalScrollLeft;
    const maximum = horizontalScrollMaximum(this.layout, viewportWidth);
    return Math.min(Math.max(convertedLogicalScrollLeft, 0), maximum);
  }

  private captureLayoutSourceCoordinate(element: HTMLElement): HorizontalCoordinateSample {
    this.resolveDirectionAndDetectPendingNativeInput(element, true);
    const sampledCoordinate = this.horizontalInputSample ?? this.pendingLayoutHorizontalCoordinate;
    if (this.directionDirty) {
      const publishedCoordinate =
        sampledCoordinate ?? this.capturePublishedHorizontalCoordinate(this.logicalScrollLeft);
      this.refreshHorizontalDirection(element);
      return publishedCoordinate;
    }
    if (sampledCoordinate !== undefined) return sampledCoordinate;
    if (this.effectiveViewportWidth(element) !== this.horizontalViewportWidth) {
      return this.capturePublishedHorizontalCoordinate(this.logicalScrollLeft);
    }
    return this.captureHorizontalCoordinate(element, this.readLogicalScrollLeft(element));
  }

  private refreshHorizontalDirection(element: HTMLElement): void {
    const nextDirection = readHorizontalDirection(element);
    if (nextDirection !== this.horizontalDirection) {
      this.horizontalDirection = nextDirection;
      this.rtlScrollType =
        nextDirection === "rtl" ? rtlScrollType(element.ownerDocument) : "negative";
    }
    this.directionDirty = false;
  }

  private shouldDeferReverseRtlLayoutWrite(
    element: HTMLElement,
    logicalScrollLeft: number,
  ): boolean {
    if (
      this.horizontalDirection !== "rtl" ||
      this.rtlScrollType !== "reverse" ||
      !Number.isFinite(element.scrollWidth)
    ) {
      return false;
    }
    const committedMaximum = Math.max(element.scrollWidth - element.clientWidth, 0);
    const nextMaximum = horizontalScrollMaximum(this.layout, this.effectiveViewportWidth(element));
    const requestedNativeScrollLeft = nextMaximum - logicalScrollLeft;
    return requestedNativeScrollLeft > committedMaximum;
  }

  private recordPendingNativeInput(element: HTMLElement): void {
    const comparisonScrollLeft = this.horizontalInputNativeScrollLeft ?? this.lastNativeScrollLeft;
    if (element.scrollLeft === comparisonScrollLeft) return;
    this.horizontalEventOrder += 1;
    this.horizontalInputEventOrder = this.horizontalEventOrder;
    this.horizontalInputNativeScrollLeft = element.scrollLeft;
    this.horizontalInputPending = true;
  }

  private resolveDirectionAndDetectPendingNativeInput(
    element: HTMLElement,
    forceDirectionRefresh = false,
    capturedViewportWidth?: number,
  ): HorizontalDirection {
    const nativeInputScrollLeft = this.horizontalInputNativeScrollLeft;
    const nativeInputRequiresDirectionRefresh =
      nativeInputScrollLeft !== undefined &&
      ((this.horizontalDirection === "ltr" && nativeInputScrollLeft < 0) ||
        (this.horizontalDirection === "rtl" &&
          ((this.rtlScrollType === "negative" && nativeInputScrollLeft > 0) ||
            (this.rtlScrollType !== "negative" && nativeInputScrollLeft < 0))));
    const nextDirection =
      forceDirectionRefresh ||
      this.directionDirty ||
      this.layoutReconciliationPending ||
      this.horizontalSuspended === undefined ||
      nativeInputRequiresDirectionRefresh
        ? readHorizontalDirection(element)
        : this.horizontalDirection;
    const directionChanged = nextDirection !== this.horizontalDirection;
    if (directionChanged && !this.directionDirty) this.directionDirty = true;
    if (nativeInputScrollLeft === undefined) return nextDirection;
    this.horizontalInputNativeScrollLeft = undefined;
    this.lastNativeScrollLeft = nativeInputScrollLeft;
    const inputFollowsObservedEnvironmentChange =
      this.horizontalInputEventOrder !== undefined &&
      this.horizontalEnvironmentEventOrder !== undefined &&
      this.horizontalInputEventOrder > this.horizontalEnvironmentEventOrder;
    if (
      directionChanged &&
      inputFollowsObservedEnvironmentChange &&
      nativeInputScrollLeft === 0 &&
      this.logicalScrollLeft > 0
    ) {
      this.horizontalInputPending = false;
      this.horizontalInputSample = undefined;
      return nextDirection;
    }
    if (directionChanged && this.horizontalEnvironmentEventOrder === undefined) {
      const nextRtlScrollType =
        nextDirection === "rtl" ? rtlScrollType(element.ownerDocument) : "negative";
      const viewportWidth = capturedViewportWidth ?? this.effectiveViewportWidth(element);
      const maximum = horizontalScrollMaximum(this.layout, viewportWidth);
      const expectedNativeScrollLeft = nativeScrollLeftFromLogical(
        this.logicalScrollLeft,
        maximum,
        nextDirection,
        nextRtlScrollType,
      );
      if (Math.abs(nativeInputScrollLeft - expectedNativeScrollLeft) > 0.5) {
        this.lastNativeScrollLeft = nativeInputScrollLeft;
        this.horizontalInputPending = true;
        this.horizontalInputSample = this.createHorizontalCoordinateSample(
          logicalScrollLeftFromNative(
            nativeInputScrollLeft,
            maximum,
            nextDirection,
            nextRtlScrollType,
          ),
          {
            direction: nextDirection,
            rtlScrollType: nextRtlScrollType,
            viewportWidth,
            suspended: shouldSuspendPinning(this.layout, viewportWidth),
            pinnedStartWidth: this.layout.pinnedStartWidth,
            pinningKey: this.layoutPinningKey,
          },
        );
      } else {
        this.horizontalInputPending = false;
        this.horizontalInputSample = undefined;
      }
    } else {
      const inputPrecedesObservedEnvironmentChange =
        this.horizontalInputEventOrder !== undefined &&
        this.horizontalEnvironmentEventOrder !== undefined &&
        this.horizontalInputEventOrder < this.horizontalEnvironmentEventOrder;
      const sampleViewportWidth = inputPrecedesObservedEnvironmentChange
        ? this.horizontalViewportWidth
        : (capturedViewportWidth ?? this.effectiveViewportWidth(element));
      const sampleDirection = inputPrecedesObservedEnvironmentChange
        ? this.horizontalDirection
        : nextDirection;
      const sampleRtlScrollType = inputPrecedesObservedEnvironmentChange
        ? this.rtlScrollType
        : nextDirection === "rtl"
          ? rtlScrollType(element.ownerDocument)
          : "negative";
      this.horizontalInputPending = true;
      this.horizontalInputSample = this.createHorizontalCoordinateSample(
        logicalScrollLeftFromNative(
          nativeInputScrollLeft,
          horizontalScrollMaximum(this.layout, sampleViewportWidth),
          sampleDirection,
          sampleRtlScrollType,
        ),
        {
          direction: sampleDirection,
          rtlScrollType: sampleRtlScrollType,
          viewportWidth: sampleViewportWidth,
          suspended: inputPrecedesObservedEnvironmentChange
            ? (this.horizontalSuspended ??
              shouldSuspendPinning(this.layout, this.horizontalViewportWidth))
            : shouldSuspendPinning(this.layout, sampleViewportWidth),
          pinnedStartWidth: inputPrecedesObservedEnvironmentChange
            ? this.horizontalPinnedStartWidth
            : this.layout.pinnedStartWidth,
          pinningKey: inputPrecedesObservedEnvironmentChange
            ? this.horizontalPinningKey
            : this.layoutPinningKey,
        },
      );
    }
    return nextDirection;
  }

  private reconcileHorizontalEnvironment(
    element: HTMLElement,
    forceDirectionRefresh = false,
    dimensions?: ViewportDimensions,
  ): HorizontalReconciliation {
    const nextDirection = this.resolveDirectionAndDetectPendingNativeInput(
      element,
      forceDirectionRefresh,
      dimensions?.viewportWidth,
    );
    const directionChanged = nextDirection !== this.horizontalDirection;
    const viewportWidth = dimensions?.viewportWidth ?? this.effectiveViewportWidth(element);
    const viewportWidthChanged = viewportWidth !== this.horizontalViewportWidth;
    if (directionChanged) {
      this.horizontalDirection = nextDirection;
      this.rtlScrollType =
        nextDirection === "rtl" ? rtlScrollType(element.ownerDocument) : "negative";
    }
    const nextSuspended = shouldSuspendPinning(this.layout, viewportWidth);
    const previousSuspended = this.horizontalSuspended;
    const previousPinnedStartWidth = this.horizontalPinnedStartWidth;
    const previousPinningKey = this.horizontalPinningKey;
    this.horizontalSuspended = nextSuspended;
    this.horizontalPinnedStartWidth = this.layout.pinnedStartWidth;
    this.horizontalPinningKey = this.layoutPinningKey;
    const samePinningStructure = previousPinningKey === this.layoutPinningKey;
    const previousInset = previousSuspended === true ? previousPinnedStartWidth : 0;
    const nextInset = nextSuspended ? this.layout.pinnedStartWidth : 0;
    const suspensionCoordinateChanged =
      previousSuspended !== undefined && samePinningStructure && previousInset !== nextInset;
    const sampledCoordinate = this.horizontalInputSample ?? this.pendingLayoutHorizontalCoordinate;
    const guardedLogicalScrollLeft = this.forceGuardedDirectionReconciliation
      ? this.directionScrollGuard
      : undefined;
    const requestedLogicalScrollLeft =
      guardedLogicalScrollLeft ??
      sampledCoordinate?.logicalScrollLeft ??
      (this.horizontalInputPending
        ? this.readLogicalScrollLeft(element, viewportWidth)
        : this.logicalScrollLeft);
    const sourceInset =
      sampledCoordinate === undefined
        ? this.horizontalInputPending
          ? nextInset
          : previousInset
        : sampledCoordinate.suspended
          ? sampledCoordinate.pinnedStartWidth
          : 0;
    const sourcePinningKey = sampledCoordinate?.pinningKey ?? previousPinningKey;
    const sampledEnvironmentChanged =
      sampledCoordinate !== undefined &&
      (sampledCoordinate.viewportWidth !== viewportWidth ||
        sampledCoordinate.direction !== this.horizontalDirection ||
        sampledCoordinate.rtlScrollType !== this.rtlScrollType);
    const sampledSuspensionCoordinateChanged =
      sourcePinningKey === this.layoutPinningKey && sourceInset !== nextInset;
    if (
      this.layoutReconciliationPending ||
      directionChanged ||
      this.forceGuardedDirectionReconciliation ||
      sampledEnvironmentChanged ||
      sampledSuspensionCoordinateChanged ||
      (!this.horizontalInputPending && (viewportWidthChanged || suspensionCoordinateChanged))
    ) {
      const convertedLogicalScrollLeft = sampledSuspensionCoordinateChanged
        ? requestedLogicalScrollLeft - sourceInset + nextInset
        : requestedLogicalScrollLeft;
      const reconciledLogicalScrollLeft = Math.min(
        Math.max(convertedLogicalScrollLeft, 0),
        horizontalScrollMaximum(this.layout, viewportWidth),
      );
      if (
        this.layoutReconciliationPending &&
        this.shouldDeferReverseRtlLayoutWrite(element, reconciledLogicalScrollLeft)
      ) {
        this.pendingLayoutHorizontalCoordinate = this.captureHorizontalCoordinate(
          element,
          reconciledLogicalScrollLeft,
        );
        if (this.layoutReconciliationDeferrals < MAX_REVERSE_RTL_LAYOUT_DEFERRALS) {
          this.layoutReconciliationDeferrals += 1;
        }
        this.directionDirty = false;
        this.horizontalViewportWidth = viewportWidth;
        return reconciledLogicalScrollLeft;
      }
      this.setLogicalScrollLeft(element, reconciledLogicalScrollLeft);
      if (directionChanged && reconciledLogicalScrollLeft > 0) {
        this.directionScrollGuard = reconciledLogicalScrollLeft;
      }
    }
    this.layoutReconciliationPending = false;
    this.layoutReconciliationDeferrals = 0;
    this.pendingLayoutHorizontalCoordinate = undefined;
    this.directionDirty = false;
    this.horizontalViewportWidth = viewportWidth;
    if (!directionChanged) {
      this.directionScrollGuard = undefined;
      this.forceGuardedDirectionReconciliation = false;
    }
    return HORIZONTAL_RECONCILIATION_SETTLED;
  }

  private captureHorizontalCoordinate(
    element: HTMLElement,
    logicalScrollLeft: number,
  ): HorizontalCoordinateSample {
    const viewportWidth = this.effectiveViewportWidth(element);
    return this.createHorizontalCoordinateSample(logicalScrollLeft, {
      direction: this.horizontalDirection,
      rtlScrollType: this.rtlScrollType,
      viewportWidth,
      suspended: shouldSuspendPinning(this.layout, viewportWidth),
      pinnedStartWidth: this.layout.pinnedStartWidth,
      pinningKey: this.layoutPinningKey,
    });
  }

  private capturePublishedHorizontalCoordinate(
    logicalScrollLeft: number,
  ): HorizontalCoordinateSample {
    return this.createHorizontalCoordinateSample(logicalScrollLeft, {
      direction: this.horizontalDirection,
      rtlScrollType: this.rtlScrollType,
      viewportWidth: this.horizontalViewportWidth,
      suspended:
        this.horizontalSuspended ?? shouldSuspendPinning(this.layout, this.horizontalViewportWidth),
      pinnedStartWidth: this.horizontalPinnedStartWidth,
      pinningKey: this.horizontalPinningKey,
    });
  }

  private createHorizontalCoordinateSample(
    logicalScrollLeft: number,
    environment: HorizontalCoordinateEnvironment,
  ): HorizontalCoordinateSample {
    return Object.freeze({ logicalScrollLeft, ...environment });
  }

  private readLogicalScrollLeft(
    element: HTMLElement,
    viewportWidth = this.effectiveViewportWidth(element),
  ): number {
    const maximum = horizontalScrollMaximum(this.layout, viewportWidth);
    const nativeScrollLeft = Number.isFinite(element.scrollLeft) ? element.scrollLeft : 0;
    return logicalScrollLeftFromNative(
      nativeScrollLeft,
      maximum,
      this.horizontalDirection,
      this.rtlScrollType,
    );
  }

  private setLogicalScrollLeft(
    element: HTMLElement,
    requestedLogicalScrollLeft: number,
    capturedViewportWidth?: number,
    readBack = true,
  ): void {
    const maximum = horizontalScrollMaximum(
      this.layout,
      capturedViewportWidth ?? this.effectiveViewportWidth(element),
    );
    const logicalScrollLeft = Math.min(Math.max(requestedLogicalScrollLeft, 0), maximum);
    const nativeScrollLeft = nativeScrollLeftFromLogical(
      logicalScrollLeft,
      maximum,
      this.horizontalDirection,
      this.rtlScrollType,
    );
    setNativeScrollLeft(element, nativeScrollLeft);
    this.logicalScrollLeft = logicalScrollLeft;
    this.lastNativeScrollLeft = readBack ? element.scrollLeft : nativeScrollLeft;
  }

  private writeScrollbarOverlay(
    element: HTMLElement,
    logicalScrollTop: number,
    logicalScrollLeft: number,
    capturedDimensions?: ViewportDimensions,
  ): void {
    const overlay = this.scrollbarOverlay;
    if (overlay === null) return;
    const directionChanged = this.scrollbarOverlayDirection !== this.horizontalDirection;
    const clientWidth = capturedDimensions?.clientWidth ?? element.clientWidth;
    const clientHeight = capturedDimensions?.clientHeight ?? element.clientHeight;
    const offsetWidth = capturedDimensions?.offsetWidth ?? element.offsetWidth;
    const offsetHeight = capturedDimensions?.offsetHeight ?? element.offsetHeight;
    const horizontal = horizontalMetrics(
      this.layout,
      capturedDimensions?.viewportWidth ?? this.effectiveViewportWidth(element),
    );
    const suspendPinning = horizontal.suspendPinning;
    const pinnedStartWidth = suspendPinning ? 0 : this.layout.pinnedStartWidth;
    const pinnedEndWidth = suspendPinning ? 0 : this.layout.pinnedEndWidth;
    const centerContentWidth = horizontal.contentWidth;
    const centerViewportWidth = horizontal.viewportWidth;
    const horizontalMaximum = horizontal.maximum;
    const nativeVerticalWidth = Math.max(
      finiteDimension(offsetWidth, clientWidth) - clientWidth,
      0,
    );
    const horizontalTrackWidth = centerViewportWidth;
    const horizontalVisible =
      horizontalMaximum > 0 && centerViewportWidth > 0 && horizontalTrackWidth > 0;
    const horizontalThumbWidth = scrollbarThumbSize(
      horizontalTrackWidth,
      centerViewportWidth,
      centerContentWidth,
    );
    const horizontalThumbOffset = scrollbarThumbOffset(
      logicalScrollLeft,
      horizontalMaximum,
      horizontalTrackWidth - horizontalThumbWidth,
    );
    const horizontalThumbTransform =
      this.horizontalDirection === "rtl" ? -horizontalThumbOffset : horizontalThumbOffset;
    const bodyViewportHeight = Math.max(clientHeight - this.layout.headerHeight, 0);
    const verticalMaximum = logicalScrollMaximum(this.layout, clientHeight);
    const verticalTrackHeight = Math.max(
      bodyViewportHeight - (horizontalVisible ? BRUNO_TABLE_SCROLLBAR_TRACK_THICKNESS : 0),
      0,
    );
    const verticalThumbHeight = scrollbarThumbSize(
      verticalTrackHeight,
      bodyViewportHeight,
      this.layout.logicalRowHeight,
    );
    const verticalThumbOffset = scrollbarThumbOffset(
      logicalScrollTop,
      verticalMaximum,
      verticalTrackHeight - verticalThumbHeight,
    );
    const nativeHorizontalWidth = Math.max(
      finiteDimension(offsetHeight, clientHeight) - clientHeight,
      0,
    );
    const style = overlay.style;
    if (directionChanged) {
      style.setProperty("direction", this.horizontalDirection);
      this.scrollbarOverlayDirection = this.horizontalDirection;
    }
    const horizontalDisplay = horizontalVisible ? "block" : "none";
    const horizontalStart = `${this.leadingUtilityWidth + pinnedStartWidth}px`;
    const horizontalEnd = `${pinnedEndWidth + nativeVerticalWidth}px`;
    const horizontalBottom = `${nativeHorizontalWidth}px`;
    const horizontalThumbWidthValue = `${horizontalThumbWidth}px`;
    const verticalDisplay = verticalMaximum > 0 && verticalTrackHeight > 0 ? "block" : "none";
    const verticalTop = `${this.layout.headerHeight}px`;
    const verticalRight = `${nativeVerticalWidth}px`;
    const verticalBottom = `${
      nativeHorizontalWidth + (horizontalVisible ? BRUNO_TABLE_SCROLLBAR_TRACK_THICKNESS : 0)
    }px`;
    const verticalThumbHeightValue = `${verticalThumbHeight}px`;
    const structuralKey = [
      horizontalDisplay,
      horizontalStart,
      horizontalEnd,
      horizontalBottom,
      horizontalThumbWidthValue,
      verticalDisplay,
      verticalTop,
      verticalRight,
      verticalBottom,
      verticalThumbHeightValue,
    ].join("|");
    if (structuralKey !== this.scrollbarOverlayStructuralKey) {
      style.setProperty("--bruno-table-scrollbar-horizontal-display", horizontalDisplay);
      style.setProperty("--bruno-table-scrollbar-horizontal-start", horizontalStart);
      style.setProperty("--bruno-table-scrollbar-horizontal-end", horizontalEnd);
      style.setProperty("--bruno-table-scrollbar-horizontal-bottom", horizontalBottom);
      style.setProperty(
        "--bruno-table-scrollbar-horizontal-thumb-width",
        horizontalThumbWidthValue,
      );
      style.setProperty("--bruno-table-scrollbar-vertical-display", verticalDisplay);
      style.setProperty("--bruno-table-scrollbar-vertical-top", verticalTop);
      style.setProperty("--bruno-table-scrollbar-vertical-right", verticalRight);
      style.setProperty("--bruno-table-scrollbar-vertical-bottom", verticalBottom);
      style.setProperty("--bruno-table-scrollbar-vertical-thumb-height", verticalThumbHeightValue);
      this.scrollbarOverlayStructuralKey = structuralKey;
    }
    style.setProperty(
      "--bruno-table-scrollbar-horizontal-thumb-offset",
      `${horizontalThumbTransform}px`,
    );
    style.setProperty("--bruno-table-scrollbar-vertical-thumb-offset", `${verticalThumbOffset}px`);
  }
}

function finiteDimension(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function scrollbarThumbSize(trackSize: number, viewportSize: number, contentSize: number): number {
  if (trackSize <= 0 || viewportSize <= 0 || contentSize <= viewportSize) return trackSize;
  return Math.min(
    Math.max((trackSize * viewportSize) / contentSize, MIN_SCROLLBAR_THUMB_SIZE),
    trackSize,
  );
}

function scrollbarThumbOffset(position: number, maximum: number, travel: number): number {
  if (maximum <= 0 || travel <= 0) return 0;
  return (Math.min(Math.max(position, 0), maximum) / maximum) * travel;
}

function createViewportSnapshot(
  layout: ViewportLayout,
  viewport: Readonly<{
    readonly logicalScrollTop: number;
    readonly scrollLeft: number;
    readonly width: number;
    readonly height: number;
  }>,
  previous?: BrunoTableVirtualWindow,
  rowOverscan = ROW_OVERSCAN,
  columnOverscan = COLUMN_OVERSCAN,
): BrunoTableViewportSnapshot {
  return Object.freeze({
    width: viewport.width,
    height: viewport.height,
    virtualWindow: calculateVirtualWindow(layout, viewport, previous, rowOverscan, columnOverscan),
  });
}

function calculateVirtualWindow(
  layout: ViewportLayout,
  viewport: Readonly<{
    readonly logicalScrollTop: number;
    readonly scrollLeft: number;
    readonly width: number;
    readonly height: number;
  }>,
  previous?: BrunoTableVirtualWindow,
  rowOverscan = ROW_OVERSCAN,
  columnOverscan = COLUMN_OVERSCAN,
): BrunoTableVirtualWindow {
  const rowViewportHeight =
    viewport.height > 0 ? viewport.height : BRUNO_TABLE_DEFAULT_VIEWPORT_HEIGHT;
  const rowStart = Math.max(Math.floor(viewport.logicalScrollTop / ROW_HEIGHT) - rowOverscan, 0);
  const rowEnd = Math.min(
    layout.rowCount,
    Math.ceil((viewport.logicalScrollTop + rowViewportHeight) / ROW_HEIGHT) + rowOverscan,
  );
  const suspendPinning = shouldSuspendPinning(layout, viewport.width);
  const pinnedStart = suspendPinning ? EMPTY_COLUMNS : layout.pinnedStart;
  const pinnedEnd = suspendPinning ? EMPTY_COLUMNS : layout.pinnedEnd;
  const center = suspendPinning ? layout.suspendedCenter : layout.center;
  const centerOffsets = suspendPinning ? layout.suspendedCenterOffsets : layout.centerOffsets;
  const centerWidth = suspendPinning ? layout.suspendedCenterWidth : layout.centerWidth;
  // Pinned columns occupy their original table slots while their visual regions are sticky.
  // The native offset consequently maps directly to the centre-column offset.
  const centerScrollLeft = viewport.scrollLeft;
  const centerViewportWidth = Math.max(
    viewport.width - (suspendPinning ? 0 : layout.pinnedStartWidth + layout.pinnedEndWidth),
    0,
  );
  const firstVisible = findColumnAtOffset(
    centerOffsets,
    Math.max(centerScrollLeft - BRUNO_TABLE_VIEWPORT_SCROLL_QUANTUM, 0),
  );
  const lastVisible = findColumnAtOffset(
    centerOffsets,
    centerScrollLeft + centerViewportWidth + BRUNO_TABLE_VIEWPORT_SCROLL_QUANTUM,
  );
  let columnStart = Math.max(firstVisible - columnOverscan, 0);
  let columnEnd = Math.min(center.length, lastVisible + columnOverscan + 1);
  const previousMatchesLayout =
    previous !== undefined &&
    previous.pinningSuspended === suspendPinning &&
    previous.centerCount === center.length &&
    previous.pinnedStart === pinnedStart &&
    previous.pinnedEnd === pinnedEnd &&
    previous.center.every((column, index) => column === center[previous.centerStartIndex + index]);
  if (
    previousMatchesLayout &&
    firstVisible >= previous.centerStartIndex + RETAINED_COLUMN_OVERSCAN &&
    lastVisible + RETAINED_COLUMN_OVERSCAN < previous.centerStartIndex + previous.center.length
  ) {
    columnStart = previous.centerStartIndex;
    columnEnd = previous.centerStartIndex + previous.center.length;
  } else if (previousMatchesLayout) {
    const previousEnd = previous.centerStartIndex + previous.center.length;
    if (
      columnStart > previous.centerStartIndex &&
      previousEnd < center.length &&
      firstVisible >= previous.centerStartIndex + 1 &&
      lastVisible < previousEnd + 1
    ) {
      columnStart = previous.centerStartIndex + 1;
      columnEnd = previousEnd + 1;
    } else if (
      columnStart < previous.centerStartIndex &&
      previous.centerStartIndex > 0 &&
      firstVisible >= previous.centerStartIndex - 1 &&
      lastVisible < previousEnd - 1
    ) {
      columnStart = previous.centerStartIndex - 1;
      columnEnd = previousEnd - 1;
    }
  }
  const leftPadding = centerOffsets[columnStart] ?? 0;
  const visibleWidth = (centerOffsets[columnEnd] ?? centerWidth) - leftPadding;
  return Object.freeze({
    rowStart,
    rowEnd,
    segmentedRows: layout.logicalRowHeight > layout.physicalRowHeight,
    pinnedStart,
    center: Object.freeze(center.slice(columnStart, columnEnd)),
    pinnedEnd,
    pinningSuspended: suspendPinning,
    centerStartIndex: columnStart,
    centerCount: center.length,
    leftPadding,
    rightPadding: Math.max(centerWidth - leftPadding - visibleWidth, 0),
    totalHeight: layout.physicalRowHeight,
    totalWidth: layout.totalWidth,
  });
}

function bodyColumnWindowFromVirtualWindow(
  window: BrunoTableVirtualWindow,
): BrunoTableBodyColumnWindowSnapshot {
  return Object.freeze({
    center: window.center,
    centerStartIndex: window.centerStartIndex,
    leftPadding: window.leftPadding,
    rightPadding: window.rightPadding,
  });
}

function sameBodyColumnWindow(
  left: BrunoTableBodyColumnWindowSnapshot,
  right: BrunoTableBodyColumnWindowSnapshot,
): boolean {
  return (
    left.centerStartIndex === right.centerStartIndex &&
    left.leftPadding === right.leftPadding &&
    left.rightPadding === right.rightPadding &&
    sameColumns(left.center, right.center)
  );
}

function rowRangeFromVirtualWindow(window: BrunoTableVirtualWindow): BrunoTableRowRangeSnapshot {
  return Object.freeze({
    rowStart: window.rowStart,
    rowEnd: window.rowEnd,
    segmentedRows: window.segmentedRows,
    totalHeight: window.totalHeight,
  });
}

function sameRowRange(
  left: BrunoTableRowRangeSnapshot,
  right: BrunoTableRowRangeSnapshot,
): boolean {
  return (
    left.rowStart === right.rowStart &&
    left.rowEnd === right.rowEnd &&
    left.segmentedRows === right.segmentedRows &&
    left.totalHeight === right.totalHeight
  );
}

function preparedBodyColumnWindow(
  current: BrunoTableBodyColumnWindowSnapshot,
  target: BrunoTableBodyColumnWindowSnapshot,
): Readonly<{ center: readonly CompiledColumn[]; centerStartIndex: number }> {
  const centerStartIndex = Math.min(current.centerStartIndex, target.centerStartIndex);
  const centerEndIndex = Math.max(
    current.centerStartIndex + current.center.length,
    target.centerStartIndex + target.center.length,
  );
  const center = Array.from<CompiledColumn>({ length: centerEndIndex - centerStartIndex });
  for (const window of [current, target]) {
    for (const [index, column] of window.center.entries()) {
      center[window.centerStartIndex - centerStartIndex + index] = column;
    }
  }
  return Object.freeze({ center: Object.freeze(center), centerStartIndex });
}

function areAdjacentCenterWindows(
  previous: BrunoTableVirtualWindow,
  next: BrunoTableVirtualWindow,
): boolean {
  const previousEnd = previous.centerStartIndex + previous.center.length;
  const nextEnd = next.centerStartIndex + next.center.length;
  const startDelta = next.centerStartIndex - previous.centerStartIndex;
  const endDelta = nextEnd - previousEnd;
  return (
    Math.abs(startDelta) <= 1 &&
    Math.abs(endDelta) <= 1 &&
    (startDelta !== 0 || endDelta !== 0) &&
    previous.pinningSuspended === next.pinningSuspended &&
    previous.centerCount === next.centerCount &&
    previous.totalWidth === next.totalWidth &&
    sameColumns(previous.pinnedStart, next.pinnedStart) &&
    sameColumns(previous.pinnedEnd, next.pinnedEnd)
  );
}

function sameVirtualWindow(left: BrunoTableVirtualWindow, right: BrunoTableVirtualWindow): boolean {
  return (
    left.rowStart === right.rowStart &&
    left.rowEnd === right.rowEnd &&
    left.segmentedRows === right.segmentedRows &&
    left.pinningSuspended === right.pinningSuspended &&
    left.centerStartIndex === right.centerStartIndex &&
    left.centerCount === right.centerCount &&
    left.leftPadding === right.leftPadding &&
    left.rightPadding === right.rightPadding &&
    left.totalHeight === right.totalHeight &&
    left.totalWidth === right.totalWidth &&
    sameColumns(left.pinnedStart, right.pinnedStart) &&
    sameColumns(left.center, right.center) &&
    sameColumns(left.pinnedEnd, right.pinnedEnd)
  );
}

function sameViewportOutsideCenterWindow(
  left: BrunoTableViewportSnapshot,
  right: BrunoTableViewportSnapshot,
): boolean {
  const leftWindow = left.virtualWindow;
  const rightWindow = right.virtualWindow;
  return (
    left.width === right.width &&
    left.height === right.height &&
    leftWindow.pinningSuspended === rightWindow.pinningSuspended &&
    leftWindow.centerCount === rightWindow.centerCount &&
    leftWindow.totalHeight === rightWindow.totalHeight &&
    leftWindow.totalWidth === rightWindow.totalWidth &&
    sameColumns(leftWindow.pinnedStart, rightWindow.pinnedStart) &&
    sameColumns(leftWindow.pinnedEnd, rightWindow.pinnedEnd)
  );
}

function mountedWindowCoversPreviewWindow(
  mounted: BrunoTableVirtualWindow,
  preview: BrunoTableVirtualWindow,
): boolean {
  const mountedEnd = mounted.centerStartIndex + mounted.center.length;
  const previewEnd = preview.centerStartIndex + preview.center.length;
  return (
    mounted.pinningSuspended === preview.pinningSuspended &&
    mounted.centerCount === preview.centerCount &&
    mounted.pinnedStart.length === preview.pinnedStart.length &&
    mounted.pinnedEnd.length === preview.pinnedEnd.length &&
    preview.centerStartIndex >= mounted.centerStartIndex &&
    previewEnd <= mountedEnd
  );
}

function mountedWindowPreviewPadding(
  layout: ViewportLayout,
  mounted: BrunoTableVirtualWindow,
): Pick<BrunoTableVirtualWindow, "leftPadding" | "rightPadding"> {
  const centerOffsets = mounted.pinningSuspended
    ? layout.suspendedCenterOffsets
    : layout.centerOffsets;
  const centerWidth = mounted.pinningSuspended ? layout.suspendedCenterWidth : layout.centerWidth;
  const leftPadding = centerOffsets[mounted.centerStartIndex] ?? 0;
  const mountedEnd = mounted.centerStartIndex + mounted.center.length;
  const mountedWidth = (centerOffsets[mountedEnd] ?? centerWidth) - leftPadding;
  return {
    leftPadding,
    rightPadding: Math.max(centerWidth - leftPadding - mountedWidth, 0),
  };
}

function shareVirtualWindowColumns(
  next: BrunoTableVirtualWindow,
  previous: BrunoTableVirtualWindow,
): BrunoTableVirtualWindow {
  const pinnedStart = sameColumns(next.pinnedStart, previous.pinnedStart)
    ? previous.pinnedStart
    : next.pinnedStart;
  const center = sameColumns(next.center, previous.center) ? previous.center : next.center;
  const pinnedEnd = sameColumns(next.pinnedEnd, previous.pinnedEnd)
    ? previous.pinnedEnd
    : next.pinnedEnd;
  if (pinnedStart === next.pinnedStart && center === next.center && pinnedEnd === next.pinnedEnd) {
    return next;
  }
  return Object.freeze({ ...next, pinnedStart, center, pinnedEnd });
}

function sameColumns(left: readonly CompiledColumn[], right: readonly CompiledColumn[]): boolean {
  return left.length === right.length && left.every((column, index) => column === right[index]);
}

function updateColumnWidthPreviewLayout(
  layout: ViewportLayout,
  columnId: string,
  width: number,
): ViewportLayout {
  const pinnedStartIndex = layout.pinnedStart.findIndex((column) => column.columnId === columnId);
  const centerIndex = layout.center.findIndex((column) => column.columnId === columnId);
  const pinnedEndIndex = layout.pinnedEnd.findIndex((column) => column.columnId === columnId);
  const region =
    pinnedStartIndex >= 0
      ? "start"
      : centerIndex >= 0
        ? "center"
        : pinnedEndIndex >= 0
          ? "end"
          : undefined;
  if (region === undefined) return layout;
  const regionIndex =
    region === "start" ? pinnedStartIndex : region === "center" ? centerIndex : pinnedEndIndex;
  const currentColumn =
    region === "start"
      ? layout.pinnedStart[regionIndex]
      : region === "center"
        ? layout.center[regionIndex]
        : layout.pinnedEnd[regionIndex];
  if (currentColumn === undefined || currentColumn.semantics.width === width) return layout;
  const nextColumn = Object.freeze({
    ...currentColumn,
    semantics: Object.freeze({ ...currentColumn.semantics, width }),
  });
  const pinnedStart =
    region === "start"
      ? replaceColumnAt(layout.pinnedStart, regionIndex, nextColumn)
      : layout.pinnedStart;
  const center =
    region === "center" ? replaceColumnAt(layout.center, regionIndex, nextColumn) : layout.center;
  const pinnedEnd =
    region === "end"
      ? replaceColumnAt(layout.pinnedEnd, regionIndex, nextColumn)
      : layout.pinnedEnd;
  const delta = width - currentColumn.semantics.width;
  const centerOffsets =
    region === "center"
      ? applyColumnOffsetDelta(layout.centerOffsets, regionIndex, delta)
      : layout.centerOffsets;
  const suspendedIndex =
    region === "start"
      ? regionIndex
      : region === "center"
        ? layout.pinnedStart.length + regionIndex
        : layout.pinnedStart.length + layout.center.length + regionIndex;
  const suspendedCenter = replaceColumnAt(layout.suspendedCenter, suspendedIndex, nextColumn);
  const suspendedCenterOffsets = applyColumnOffsetDelta(
    layout.suspendedCenterOffsets,
    suspendedIndex,
    delta,
  );
  const columns = replaceColumnAt(
    layout.columns,
    layout.columns.findIndex((column) => column.columnId === columnId),
    nextColumn,
  );
  const pinnedStartWidth = layout.pinnedStartWidth + (region === "start" ? delta : 0);
  const pinnedEndWidth = layout.pinnedEndWidth + (region === "end" ? delta : 0);
  const centerWidth = layout.centerWidth + (region === "center" ? delta : 0);
  const suspendedCenterWidth = layout.suspendedCenterWidth + delta;
  return Object.freeze({
    ...layout,
    columns,
    pinnedStart,
    center,
    pinnedEnd,
    centerOffsets,
    suspendedCenter,
    suspendedCenterOffsets,
    suspendedCenterWidth,
    pinnedStartWidth,
    pinnedEndWidth,
    centerWidth,
    totalWidth: layout.totalWidth + delta,
  });
}

function replaceColumnAt(
  columns: readonly CompiledColumn[],
  index: number,
  column: CompiledColumn,
): readonly CompiledColumn[] {
  if (index < 0 || index >= columns.length) return columns;
  const next = [...columns];
  next[index] = column;
  return Object.freeze(next);
}

function applyColumnOffsetDelta(
  offsets: readonly number[],
  index: number,
  delta: number,
): readonly number[] {
  if (delta === 0 || index < 0 || index + 1 >= offsets.length) return offsets;
  const next = [...offsets];
  for (let offsetIndex = index + 1; offsetIndex < next.length; offsetIndex += 1) {
    next[offsetIndex] = next[offsetIndex]! + delta;
  }
  return Object.freeze(next);
}

function createLayout(
  rowCount: number,
  columns: readonly CompiledColumn[],
  headerHeight: number,
): ViewportLayout {
  const normalizedColumns = Object.freeze(Array.from(columns));
  const pinnedStart = Object.freeze(
    normalizedColumns.filter((column) => column.pinned === "start"),
  );
  const center = Object.freeze(normalizedColumns.filter((column) => column.pinned === undefined));
  const pinnedEnd = Object.freeze(normalizedColumns.filter((column) => column.pinned === "end"));
  const centerOffsets = columnOffsets(center);
  const suspendedCenter = Object.freeze([...pinnedStart, ...center, ...pinnedEnd]);
  const suspendedCenterOffsets = columnOffsets(suspendedCenter);
  const pinnedStartWidth = totalColumnWidth(pinnedStart);
  const pinnedEndWidth = totalColumnWidth(pinnedEnd);
  const centerWidth = centerOffsets.at(-1) ?? 0;
  const suspendedCenterWidth = suspendedCenterOffsets.at(-1) ?? 0;
  const logicalRowHeight = rowCount * ROW_HEIGHT;
  const physicalRowHeight = Math.min(logicalRowHeight, BRUNO_TABLE_MAX_PHYSICAL_ROW_HEIGHT);
  return Object.freeze({
    rowCount,
    headerHeight,
    columns: normalizedColumns,
    pinnedStart,
    center,
    pinnedEnd,
    centerOffsets,
    suspendedCenter,
    suspendedCenterOffsets,
    suspendedCenterWidth,
    pinnedStartWidth,
    pinnedEndWidth,
    centerWidth,
    logicalRowHeight,
    physicalRowHeight,
    totalWidth: pinnedStartWidth + centerWidth + pinnedEndWidth,
  });
}

function columnOffsets(columns: readonly CompiledColumn[]): readonly number[] {
  const offsets = [0];
  for (const column of columns) offsets.push(offsets.at(-1)! + column.semantics.width);
  return Object.freeze(offsets);
}

function shouldSuspendPinning(layout: ViewportLayout, viewportWidth: number): boolean {
  const hasPinnedColumns = layout.pinnedStart.length > 0 || layout.pinnedEnd.length > 0;
  if (!hasPinnedColumns) return false;
  if (viewportWidth <= 0) return true;
  if (layout.center.length === 0) {
    return layout.pinnedStartWidth + layout.pinnedEndWidth > viewportWidth;
  }
  const reservedCenterWidth = Math.min(MIN_CENTER_VIEWPORT_WIDTH, viewportWidth);
  return layout.pinnedStartWidth + layout.pinnedEndWidth > viewportWidth - reservedCenterWidth;
}

function emptyVirtualWindow(): BrunoTableVirtualWindow {
  return Object.freeze({
    rowStart: 0,
    rowEnd: 0,
    segmentedRows: false,
    pinnedStart: EMPTY_COLUMNS,
    center: EMPTY_COLUMNS,
    pinnedEnd: EMPTY_COLUMNS,
    pinningSuspended: false,
    centerStartIndex: 0,
    centerCount: 0,
    leftPadding: 0,
    rightPadding: 0,
    totalHeight: 0,
    totalWidth: 0,
  });
}

function physicalScrollMaximum(layout: ViewportLayout, viewportHeight: number): number {
  return Math.max(layout.physicalRowHeight + layout.headerHeight - viewportHeight, 0);
}

function horizontalMetrics(
  layout: ViewportLayout,
  viewportWidth: number,
): Readonly<{
  suspendPinning: boolean;
  contentWidth: number;
  viewportWidth: number;
  maximum: number;
}> {
  const suspendPinning = shouldSuspendPinning(layout, viewportWidth);
  const contentWidth = suspendPinning ? layout.suspendedCenterWidth : layout.centerWidth;
  const viewport = suspendPinning
    ? viewportWidth
    : Math.max(viewportWidth - layout.pinnedStartWidth - layout.pinnedEndWidth, 0);
  return {
    suspendPinning,
    contentWidth,
    viewportWidth: viewport,
    maximum: Math.max(contentWidth - viewport, 0),
  };
}

function horizontalScrollMaximum(layout: ViewportLayout, viewportWidth: number): number {
  return horizontalMetrics(layout, viewportWidth).maximum;
}

function logicalScrollMaximum(layout: ViewportLayout, viewportHeight: number): number {
  return Math.max(layout.logicalRowHeight + layout.headerHeight - viewportHeight, 0);
}

function totalColumnWidth(columns: readonly CompiledColumn[]): number {
  return columns.reduce((total, column) => total + column.semantics.width, 0);
}

function findColumnAtOffset(widths: readonly number[], offset: number): number {
  let low = 0;
  let high = Math.max(widths.length - 1, 0);
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((widths[middle] ?? 0) > offset) high = middle;
    else low = middle + 1;
  }
  return Math.max(low - 1, 0);
}

function quantizeScroll(value: number): number {
  return (
    Math.floor(value / BRUNO_TABLE_VIEWPORT_SCROLL_QUANTUM) * BRUNO_TABLE_VIEWPORT_SCROLL_QUANTUM
  );
}

function normalizedLeadingUtilityWidth(value: number): number {
  return Number.isFinite(value) ? Math.max(value, 0) : 0;
}

function rowLayerTransform(offset: string): string {
  return `translate3d(0, ${offset}, 0)`;
}

function setNativeScrollTop(element: HTMLElement, top: number): void {
  if (element.scrollTop === top) return;
  if (typeof element.scrollTo === "function") {
    element.scrollTo({ behavior: "instant", top });
    return;
  }
  element.scrollTop = top;
}

function setNativeScrollLeft(element: HTMLElement, left: number): void {
  if (typeof element.scrollTo === "function") {
    element.scrollTo({ behavior: "instant", left });
    return;
  }
  element.scrollLeft = left;
}

function logicalScrollLeftFromNative(
  nativeScrollLeft: number,
  maximum: number,
  direction: HorizontalDirection,
  rtlType: RtlScrollType,
): number {
  const logicalScrollLeft =
    direction === "ltr"
      ? nativeScrollLeft
      : rtlType === "negative"
        ? -nativeScrollLeft
        : rtlType === "reverse"
          ? maximum - nativeScrollLeft
          : nativeScrollLeft;
  return Math.min(Math.max(logicalScrollLeft, 0), maximum);
}

function nativeScrollLeftFromLogical(
  logicalScrollLeft: number,
  maximum: number,
  direction: HorizontalDirection,
  rtlType: RtlScrollType,
): number {
  const clampedLogicalScrollLeft = Math.min(Math.max(logicalScrollLeft, 0), maximum);
  return direction === "ltr"
    ? clampedLogicalScrollLeft
    : rtlType === "negative"
      ? -clampedLogicalScrollLeft
      : rtlType === "reverse"
        ? maximum - clampedLogicalScrollLeft
        : clampedLogicalScrollLeft;
}

function readHorizontalDirection(element: HTMLElement): HorizontalDirection {
  const computedDirection =
    element.ownerDocument?.defaultView?.getComputedStyle?.(element)?.direction;
  if (computedDirection === "rtl") return "rtl";
  return element.getAttribute?.("dir")?.toLowerCase() === "rtl" ? "rtl" : "ltr";
}

function rtlScrollType(ownerDocument: Document | undefined): RtlScrollType {
  if (ownerDocument === undefined) return "negative";
  const cached = RTL_SCROLL_TYPES.get(ownerDocument);
  if (cached !== undefined) return cached;
  const outer = ownerDocument.createElement("div");
  const inner = ownerDocument.createElement("div");
  outer.dir = "rtl";
  outer.style.cssText =
    "position:absolute;visibility:hidden;overflow:scroll;width:4px;height:1px;top:-9999px;";
  inner.style.cssText = "width:8px;height:1px;";
  outer.appendChild(inner);
  (ownerDocument.body ?? ownerDocument.documentElement).appendChild(outer);
  let type: RtlScrollType;
  if (outer.scrollLeft > 0) type = "reverse";
  else {
    outer.scrollLeft = 1;
    type = outer.scrollLeft === 0 ? "negative" : "default";
  }
  outer.parentNode?.removeChild(outer);
  RTL_SCROLL_TYPES.set(ownerDocument, type);
  return type;
}
