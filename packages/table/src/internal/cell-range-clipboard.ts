import { Store } from "@tanstack/store";
import { assign, createActor, createMachine } from "xstate";

import { BRUNO_TABLE_CELL_RANGE_FRAME_TIMING_DIAGNOSTIC_SENTINEL } from "./test-diagnostic-build-contract";

export type BrunoTableCellRangeAxis = "horizontal" | "vertical";

export type BrunoTableCellCoordinate = Readonly<{
  readonly rowId: string;
  readonly columnId: string;
}>;

export type BrunoTableCellRangeStructure = Readonly<{
  readonly rowIds: readonly string[];
  readonly columnIds: readonly string[];
  readonly rowIndexById: ReadonlyMap<string, number>;
  readonly columnIndexById: ReadonlyMap<string, number>;
}>;

type BrunoTableHorizontalCellRange = Readonly<{
  readonly axis: "horizontal";
  readonly rowId: string;
  readonly rowIds: readonly [string];
  readonly columnIds: readonly [string, string, ...string[]];
  readonly columnSpan: BrunoTableIdentitySpan;
  readonly anchor: BrunoTableCellCoordinate;
  readonly focus: BrunoTableCellCoordinate;
}>;

type BrunoTableVerticalCellRange = Readonly<{
  readonly axis: "vertical";
  readonly columnId: string;
  readonly rowIds: readonly [string, string, ...string[]];
  readonly rowSpan: BrunoTableIdentitySpan;
  readonly columnIds: readonly [string];
  readonly anchor: BrunoTableCellCoordinate;
  readonly focus: BrunoTableCellCoordinate;
}>;

export type BrunoTableCellRange = BrunoTableHorizontalCellRange | BrunoTableVerticalCellRange;

export type BrunoTableCellRangeSnapshot = Readonly<{
  readonly anchor?: BrunoTableCellCoordinate;
  readonly range?: BrunoTableCellRange;
}>;

type BrunoTableNonEmptyIdentitySpan = readonly [string, ...string[]];

type BrunoTableIdentitySpan = Readonly<{
  readonly identities: readonly string[];
  readonly start: number;
  readonly end: number;
  readonly tableId: string;
}>;

export type BrunoTableClipboardTarget =
  | Readonly<{
      readonly axis: "horizontal";
      readonly rowIds: readonly [string];
      readonly columnIds: BrunoTableNonEmptyIdentitySpan;
    }>
  | Readonly<{
      readonly axis: "vertical";
      readonly rowIds: BrunoTableNonEmptyIdentitySpan;
      readonly columnIds: readonly [string];
    }>;

type BrunoTableClipboardCellEvidence = Readonly<{
  readonly rowId: string;
  readonly columnId: string;
  readonly value: unknown;
  readonly formatCanonicalText: (value: unknown) => string;
}>;

export type BrunoTableClipboardSnapshot =
  | Readonly<{
      readonly axis: "horizontal";
      readonly rowIds: readonly [string];
      readonly columnIds: BrunoTableNonEmptyIdentitySpan;
      readonly canonicalTexts: readonly [string, ...string[]];
    }>
  | Readonly<{
      readonly axis: "vertical";
      readonly rowIds: BrunoTableNonEmptyIdentitySpan;
      readonly columnIds: readonly [string];
      readonly canonicalTexts: readonly [string, ...string[]];
    }>;

export type BrunoTableCellRangeHit = BrunoTableCellCoordinate &
  Readonly<{ readonly rowIndex: number }>;

const EMPTY_RANGE_SNAPSHOT: BrunoTableCellRangeSnapshot = Object.freeze({});

type BrunoTableCellRangePointerGesture = {
  readonly grid: HTMLElement;
  readonly view: Window;
  readonly bodyViewportTopInset: number;
  readonly startX: number;
  readonly startY: number;
  readonly activate: (hit: BrunoTableCellRangeHit) => void;
  readonly restoreActive: () => void;
  readonly scrollHorizontalByPhysical: (delta: number) => boolean;
  clientX: number;
  clientY: number;
  target: EventTarget | null;
  frame: number | null;
};

type BrunoTableCellRangeGestureResources = Readonly<{
  readonly acquire: () => void;
  readonly release: () => void;
}>;

type BrunoTableCellRangeGestureEvent =
  | Readonly<{
      readonly type: "START";
      readonly pointerId: number;
      readonly before: BrunoTableCellRangeSnapshot;
      readonly resources: BrunoTableCellRangeGestureResources;
    }>
  | Readonly<{ readonly type: "ACQUIRE_AXIS"; readonly axis: BrunoTableCellRangeAxis }>
  | Readonly<{ readonly type: "SANITIZE_BEFORE"; readonly before: BrunoTableCellRangeSnapshot }>
  | Readonly<{ readonly type: "COMMIT" | "CANCEL" | "INVALIDATE" }>;

type BrunoTableCellRangeGestureContext = Readonly<{
  readonly pointerId: number | undefined;
  readonly before: BrunoTableCellRangeSnapshot;
  readonly axis: BrunoTableCellRangeAxis | undefined;
  readonly resources: BrunoTableCellRangeGestureResources | undefined;
}>;

const EMPTY_GESTURE_CONTEXT: BrunoTableCellRangeGestureContext = Object.freeze({
  pointerId: undefined,
  before: EMPTY_RANGE_SNAPSHOT,
  axis: undefined,
  resources: undefined,
});

const brunoTableCellRangeGestureMachine = createMachine(
  {
    id: "brunoTableCellRangeGesture",
    initial: "idle",
    types: {} as {
      context: BrunoTableCellRangeGestureContext;
      events: BrunoTableCellRangeGestureEvent;
    },
    context: EMPTY_GESTURE_CONTEXT,
    states: {
      idle: {
        on: {
          START: {
            target: "armed",
            actions: [
              assign({
                pointerId: ({ event }) => event.pointerId,
                before: ({ event }) => event.before,
                axis: undefined,
                resources: ({ event }) => event.resources,
              }),
              "acquireGestureResources",
            ],
          },
        },
      },
      armed: {
        on: {
          ACQUIRE_AXIS: {
            target: "axisLocked",
            actions: assign({ axis: ({ event }) => event.axis }),
          },
          SANITIZE_BEFORE: { actions: assign({ before: ({ event }) => event.before }) },
          COMMIT: { target: "idle", actions: ["releaseGestureResources", "clearGestureContext"] },
          CANCEL: { target: "idle", actions: ["releaseGestureResources", "clearGestureContext"] },
          INVALIDATE: {
            target: "idle",
            actions: ["releaseGestureResources", "clearGestureContext"],
          },
        },
      },
      axisLocked: {
        on: {
          SANITIZE_BEFORE: { actions: assign({ before: ({ event }) => event.before }) },
          COMMIT: { target: "idle", actions: ["releaseGestureResources", "clearGestureContext"] },
          CANCEL: { target: "idle", actions: ["releaseGestureResources", "clearGestureContext"] },
          INVALIDATE: {
            target: "idle",
            actions: ["releaseGestureResources", "clearGestureContext"],
          },
        },
      },
    },
  },
  {
    actions: {
      acquireGestureResources: ({ context }) => context.resources?.acquire(),
      releaseGestureResources: ({ context }) => context.resources?.release(),
      clearGestureContext: assign({
        pointerId: () => undefined,
        before: () => EMPTY_RANGE_SNAPSHOT,
        axis: () => undefined,
        resources: () => undefined,
      }),
    },
  },
);

type BrunoTableCellRangeGestureProjection = Readonly<{
  readonly value: "idle" | "armed" | "axisLocked";
  readonly pointerId: number | undefined;
  readonly before: BrunoTableCellRangeSnapshot;
  readonly axis: BrunoTableCellRangeAxis | undefined;
}>;

const EMPTY_GESTURE_PROJECTION: BrunoTableCellRangeGestureProjection = Object.freeze({
  value: "idle",
  pointerId: undefined,
  before: EMPTY_RANGE_SNAPSHOT,
  axis: undefined,
});

export function createBrunoTableCellRangeGestureActor(): Readonly<{
  readonly stop: () => void;
  readonly send: (event: BrunoTableCellRangeGestureEvent) => void;
  readonly getSnapshot: () => BrunoTableCellRangeGestureProjection;
}> {
  const actor = createActor(brunoTableCellRangeGestureMachine);
  const projection = new Store<BrunoTableCellRangeGestureProjection>({
    value: "idle",
    pointerId: undefined,
    before: EMPTY_RANGE_SNAPSHOT,
    axis: undefined,
  });
  const subscription = actor.subscribe((snapshot) => {
    const value =
      snapshot.value === "armed" || snapshot.value === "axisLocked" ? snapshot.value : "idle";
    const next = Object.freeze({
      value,
      pointerId: snapshot.context.pointerId,
      before: snapshot.context.before,
      axis: snapshot.context.axis,
    });
    const previous = projection.get();
    if (
      previous.value !== next.value ||
      previous.pointerId !== next.pointerId ||
      previous.before !== next.before ||
      previous.axis !== next.axis
    ) {
      projection.setState(() => next);
    }
  });
  actor.start();
  return Object.freeze({
    stop: () => {
      if (actor.getSnapshot().value !== "idle") actor.send({ type: "INVALIDATE" });
      subscription.unsubscribe();
      actor.stop();
    },
    send: (event) => actor.send(event),
    getSnapshot: () => projection.get(),
  });
}

export type BrunoTableCellRangeInstrumentationEvent =
  | Readonly<{ readonly kind: "publication"; readonly tableId: string }>
  | Readonly<{
      readonly kind: "pointer-frame";
      readonly tableId: string;
      readonly durationMs: number;
    }>
  | Readonly<{ readonly kind: "identity-span-materialization"; readonly tableId: string }>
  | Readonly<{
      readonly kind: "mounted-decoration";
      readonly tableId: string;
      readonly mountedCellCount: number;
      readonly writtenCellCount: number;
      readonly projectionCandidateCount: number;
    }>;

type BrunoTableCellRangeInstrumentationListener = (
  event: BrunoTableCellRangeInstrumentationEvent,
) => void;

const instrumentationListenersByTable = new Map<
  string,
  Set<BrunoTableCellRangeInstrumentationListener>
>();

export function installBrunoTableCellRangeInstrumentationListener(
  tableId: string,
  listener: BrunoTableCellRangeInstrumentationListener,
): () => void {
  const listeners =
    instrumentationListenersByTable.get(tableId) ??
    new Set<BrunoTableCellRangeInstrumentationListener>();
  listeners.add(listener);
  instrumentationListenersByTable.set(tableId, listeners);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    listeners.delete(listener);
    if (listeners.size === 0 && instrumentationListenersByTable.get(tableId) === listeners) {
      instrumentationListenersByTable.delete(tableId);
    }
  };
}

const BRUNO_TABLE_CELL_RANGE_DRAG_SLOP = 4;
const BRUNO_TABLE_CELL_RANGE_AUTOSCROLL_ZONE = 24;
const BRUNO_TABLE_CELL_RANGE_AUTOSCROLL_STEP = 12;

export function createBrunoTableCellRangeStructure(
  rowIds: readonly string[],
  columnIds: readonly string[],
  rowIndexById?: ReadonlyMap<string, number>,
): BrunoTableCellRangeStructure {
  return Object.freeze({
    rowIds: rowIndexById === undefined ? Object.freeze(Array.from(rowIds)) : rowIds,
    columnIds: Object.freeze(Array.from(columnIds)),
    rowIndexById: rowIndexById ?? indexIdentities(rowIds),
    columnIndexById: indexIdentities(columnIds),
  });
}

type BrunoTableCellRangeRowIdentitySpace = Readonly<{
  readonly totalRows: number;
  readonly getRowId: (index: number) => string | undefined;
  readonly identitySnapshot?:
    | Readonly<{
        readonly rowIds: readonly string[];
        readonly rowIndexById: ReadonlyMap<string, number>;
      }>
    | undefined;
}>;

export function createBrunoTableCellRangeStructureFromRowSpace(
  rowSpace: BrunoTableCellRangeRowIdentitySpace,
  columnIds: readonly string[],
): BrunoTableCellRangeStructure {
  const identitySnapshot = rowSpace.identitySnapshot;
  if (identitySnapshot !== undefined) {
    return createBrunoTableCellRangeStructure(
      identitySnapshot.rowIds,
      columnIds,
      identitySnapshot.rowIndexById,
    );
  }
  return createBrunoTableCellRangeStructure(
    Array.from({ length: rowSpace.totalRows }, (_, index) => rowSpace.getRowId(index)).filter(
      (rowId): rowId is string => rowId !== undefined,
    ),
    columnIds,
  );
}

export class BrunoTableCellRangeRuntime {
  private readonly listeners = new Set<() => void>();
  private structure: BrunoTableCellRangeStructure | undefined;
  private snapshot = EMPTY_RANGE_SNAPSHOT;
  private grid: HTMLElement | null = null;
  private observer: MutationObserver | undefined;
  private decorationFrame: number | null = null;
  private readonly mountedCellCoordinates = new Map<
    HTMLElement,
    Readonly<{ readonly rowId: string; readonly columnId: string }>
  >();
  private readonly mountedCellsByRow = new Map<string, Map<string, Set<HTMLElement>>>();
  private readonly decoratedCells = new Set<HTMLElement>();
  private readonly pendingDecorationCells = new Set<HTMLElement>();
  private pendingDecorationProjectionCandidateCount = 0;
  private pointerGesture: BrunoTableCellRangePointerGesture | undefined;
  private gestureActor: ReturnType<typeof createBrunoTableCellRangeGestureActor> | undefined;
  private structuralInvalidationPendingCopy = false;

  public constructor(private readonly tableId = "TABLE_ID_UNBOUND_CELL_RANGE") {}

  public readonly getSnapshot = (): BrunoTableCellRangeSnapshot => this.snapshot;

  public readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  public readonly getStructure = (): BrunoTableCellRangeStructure | undefined => this.structure;

  public readonly attachGrid = (grid: HTMLElement | null): void => {
    if (this.grid === grid) return;
    if (this.pointerGesture !== undefined) this.cancelPointerGesture();
    this.cancelDecorationFrame();
    this.observer?.disconnect();
    this.observer = undefined;
    this.clearDecoratedCells();
    this.mountedCellCoordinates.clear();
    this.mountedCellsByRow.clear();
    this.grid = grid;
    if (grid === null) return;
    this.registerMountedCells(grid);
    this.observer = new MutationObserver((records) => {
      let registryChanged = false;
      for (const record of records) {
        if (record.type === "attributes") {
          registryChanged = this.unregisterMountedCells(record.target) || registryChanged;
          registryChanged = this.registerMountedCells(record.target) || registryChanged;
          continue;
        }
        for (const removed of record.removedNodes) {
          registryChanged = this.unregisterMountedCells(removed) || registryChanged;
        }
        for (const added of record.addedNodes) {
          registryChanged = this.registerMountedCells(added) || registryChanged;
        }
      }
      if (registryChanged) this.scheduleDecoration();
    });
    this.observer.observe(grid, {
      attributes: true,
      attributeFilter: ["data-bruno-row-id", "data-bruno-column-id"],
      childList: true,
      subtree: true,
    });
    this.scheduleDecoration();
  };

  public readonly dispose = (): void => {
    this.cancelPointerGesture();
    this.gestureActor?.stop();
    this.gestureActor = undefined;
    this.observer?.disconnect();
    this.observer = undefined;
    this.cancelDecorationFrame();
    this.clearDecoratedCells();
    this.mountedCellCoordinates.clear();
    this.mountedCellsByRow.clear();
    this.grid = null;
    this.listeners.clear();
  };

  public readonly isPointerGestureActive = (): boolean => {
    const gestureActor = this.gestureActor;
    return gestureActor !== undefined && gestureActor.getSnapshot().value !== "idle";
  };

  public readonly getPointerGestureSnapshot = (): BrunoTableCellRangeGestureProjection =>
    this.gestureActor?.getSnapshot() ?? EMPTY_GESTURE_PROJECTION;

  public readonly startPointerGesture = (
    event: PointerEvent,
    hit: BrunoTableCellRangeHit,
    grid: HTMLElement,
    activate: (hit: BrunoTableCellRangeHit) => void,
    restoreActive: () => void,
    scrollHorizontalByPhysical: (delta: number) => boolean,
    currentActive?: BrunoTableCellCoordinate,
    extend = false,
  ): boolean => {
    const structure = this.structure;
    const view = grid.ownerDocument.defaultView;
    const gestureState = this.gestureActor?.getSnapshot().value;
    if (
      structure === undefined ||
      view === null ||
      event.button !== 0 ||
      (gestureState !== undefined && gestureState !== "idle") ||
      !containsCoordinate(structure, hit)
    ) {
      return false;
    }
    const gestureActor = this.ensureGestureActor();
    const before = this.snapshot;
    const gesture: BrunoTableCellRangePointerGesture = {
      grid,
      view,
      bodyViewportTopInset: captureBodyViewportTopInset(grid),
      startX: event.clientX,
      startY: event.clientY,
      activate,
      restoreActive,
      scrollHorizontalByPhysical,
      clientX: event.clientX,
      clientY: event.clientY,
      target: event.target,
      frame: null,
    };
    gestureActor.send({
      type: "START",
      pointerId: event.pointerId,
      before,
      resources: {
        acquire: () => {
          this.pointerGesture = gesture;
          try {
            grid.setPointerCapture(event.pointerId);
          } catch {
            // Synthetic browser events may not have a native active pointer.
          }
          view.addEventListener("pointermove", this.onPointerMove, true);
          view.addEventListener("pointerup", this.onPointerUp, true);
          view.addEventListener("pointercancel", this.onPointerCancel, true);
        },
        release: () => this.detachPointerGesture(gesture, event.pointerId),
      },
    });
    event.preventDefault();
    const next = extend
      ? this.snapshot.range !== undefined
        ? this.extend(hit, structure)
        : currentActive !== undefined && containsCoordinate(structure, currentActive)
          ? this.extendFromCurrent(currentActive, hit, structure)
          : this.snapshot.anchor !== undefined
            ? this.extend(hit, structure)
            : this.replace(hit, structure)
      : this.replace(hit, structure);
    if (gestureActor.getSnapshot().pointerId !== event.pointerId) return true;
    const focus = next.range?.focus ?? next.anchor;
    if (focus !== undefined) {
      const rowIndex = structure.rowIndexById.get(focus.rowId);
      if (rowIndex !== undefined) activate({ ...focus, rowIndex });
    }
    grid.focus({ preventScroll: true });
    const initialAxis = this.snapshot.range?.axis;
    if (initialAxis !== undefined) {
      gestureActor.send({ type: "ACQUIRE_AXIS", axis: initialAxis });
    }
    return true;
  };

  public readonly cancelPointerGesture = (): boolean => {
    const gesture = this.pointerGesture;
    if (gesture === undefined) return false;
    const gestureActor = this.ensureGestureActor();
    const before = gestureActor.getSnapshot().before;
    gestureActor.send({ type: "CANCEL" });
    this.publish(before);
    gesture.restoreActive();
    return true;
  };

  public readonly restore = (snapshot: BrunoTableCellRangeSnapshot): BrunoTableCellRangeSnapshot =>
    this.publish(snapshot);

  public readonly replace = (
    coordinate: BrunoTableCellCoordinate,
    structure: BrunoTableCellRangeStructure,
  ): BrunoTableCellRangeSnapshot => {
    this.structuralInvalidationPendingCopy = false;
    this.structure = structure;
    if (!containsCoordinate(structure, coordinate)) return this.publish(EMPTY_RANGE_SNAPSHOT);
    return this.publish(Object.freeze({ anchor: freezeCoordinate(coordinate) }));
  };

  public readonly extend = (
    target: BrunoTableCellCoordinate,
    structure: BrunoTableCellRangeStructure,
    axisHint?: BrunoTableCellRangeAxis,
  ): BrunoTableCellRangeSnapshot => {
    this.reconcile(structure);
    const anchor = this.snapshot.anchor;
    if (anchor === undefined || !containsCoordinate(structure, target)) return this.snapshot;
    const axis = axisHint ?? this.snapshot.range?.axis ?? chooseAxis(anchor, target, structure);
    if (axis === undefined) return this.publish(Object.freeze({ anchor }));
    const range = createRange(axis, anchor, target, structure, this.tableId);
    return this.publish(
      range === undefined ? Object.freeze({ anchor }) : Object.freeze({ anchor, range }),
    );
  };

  public readonly extendFromCurrent = (
    current: BrunoTableCellCoordinate,
    target: BrunoTableCellCoordinate,
    structure: BrunoTableCellRangeStructure,
  ): BrunoTableCellRangeSnapshot => {
    this.reconcile(structure);
    if (this.snapshot.range !== undefined) return this.extend(target, structure);
    this.structuralInvalidationPendingCopy = false;
    this.structure = structure;
    if (!containsCoordinate(structure, current) || !containsCoordinate(structure, target)) {
      return this.publish(EMPTY_RANGE_SNAPSHOT);
    }
    const anchor = freezeCoordinate(current);
    const axis = chooseAxis(anchor, target, structure);
    const range =
      axis === undefined ? undefined : createRange(axis, anchor, target, structure, this.tableId);
    return this.publish(
      range === undefined ? Object.freeze({ anchor }) : Object.freeze({ anchor, range }),
    );
  };

  public readonly reconcile = (
    structure: BrunoTableCellRangeStructure,
  ): BrunoTableCellRangeSnapshot => {
    if (this.structure === structure) return this.snapshot;
    const gesture = this.pointerGesture;
    const gestureActor = gesture === undefined ? undefined : this.ensureGestureActor();
    const before = gestureActor?.getSnapshot().before;
    const beforeMatches = before === undefined || snapshotMatchesStructure(before, structure);
    const currentMatches = snapshotMatchesStructure(this.snapshot, structure);
    if (
      gesture !== undefined &&
      (!currentMatches || (before?.range !== undefined && !beforeMatches))
    ) {
      const invalidatedRange = before?.range !== undefined || this.snapshot.range !== undefined;
      gestureActor?.send({ type: "INVALIDATE" });
      this.structure = structure;
      if (invalidatedRange) this.structuralInvalidationPendingCopy = true;
      return this.publish(EMPTY_RANGE_SNAPSHOT);
    }
    if (gestureActor !== undefined && !beforeMatches) {
      gestureActor.send({ type: "SANITIZE_BEFORE", before: EMPTY_RANGE_SNAPSHOT });
    }
    this.structure = structure;
    const anchor = this.snapshot.anchor;
    if (anchor === undefined || !containsCoordinate(structure, anchor)) {
      if (this.snapshot.range !== undefined) this.structuralInvalidationPendingCopy = true;
      return this.publish(EMPTY_RANGE_SNAPSHOT);
    }
    const range = this.snapshot.range;
    if (range === undefined) return this.snapshot;
    if (!rangeMatchesStructure(range, structure)) {
      this.structuralInvalidationPendingCopy = true;
      return this.publish(EMPTY_RANGE_SNAPSHOT);
    }
    return this.snapshot;
  };

  public readonly reconcileAfterCommittedNavigation = (
    structure: BrunoTableCellRangeStructure,
    activeCell?: BrunoTableCellCoordinate,
  ): BrunoTableCellRangeSnapshot => {
    const hadRange = this.snapshot.range !== undefined;
    this.reconcile(structure);
    if (hadRange || this.structuralInvalidationPendingCopy) return this.snapshot;
    if (activeCell !== undefined && containsCoordinate(structure, activeCell)) {
      return this.replace(activeCell, structure);
    }
    return this.clear();
  };

  public readonly clear = (): BrunoTableCellRangeSnapshot => {
    this.cancelPointerGesture();
    this.structuralInvalidationPendingCopy = false;
    return this.publish(EMPTY_RANGE_SNAPSHOT);
  };

  public readonly consumeStructuralInvalidation = (): boolean => {
    const invalidated = this.structuralInvalidationPendingCopy;
    this.structuralInvalidationPendingCopy = false;
    return invalidated;
  };

  public readonly isCellSelected = (rowId: string, columnId: string): boolean => {
    const range = this.snapshot.range;
    const structure = this.structure;
    if (range === undefined || structure === undefined) {
      return this.snapshot.anchor?.rowId === rowId && this.snapshot.anchor.columnId === columnId;
    }
    if (range.axis === "horizontal") {
      if (range.rowId !== rowId) return false;
      return identityFallsWithin(
        structure.columnIndexById,
        columnId,
        identitySpanFirst(range.columnSpan),
        identitySpanLast(range.columnSpan),
      );
    }
    if (range.columnId !== columnId) return false;
    return identityFallsWithin(
      structure.rowIndexById,
      rowId,
      identitySpanFirst(range.rowSpan),
      identitySpanLast(range.rowSpan),
    );
  };

  private readonly publish = (
    snapshot: BrunoTableCellRangeSnapshot,
  ): BrunoTableCellRangeSnapshot => {
    if (this.snapshot === snapshot) return snapshot;
    if (sameSnapshot(this.snapshot, snapshot)) return this.snapshot;
    const previous = this.snapshot;
    this.snapshot = snapshot;
    this.enqueueDecorationDelta(previous, snapshot);
    recordInstrumentation({ kind: "publication", tableId: this.tableId });
    for (const listener of this.listeners) listener();
    this.scheduleDecoration();
    return snapshot;
  };

  private readonly scheduleDecoration = (): void => {
    const grid = this.grid;
    if (grid === null || this.decorationFrame !== null) return;
    this.decorationFrame = requestAnimationFrame(() => {
      this.decorationFrame = null;
      if (this.grid === grid) this.decorateMountedCells();
    });
  };

  private readonly cancelDecorationFrame = (): void => {
    if (this.decorationFrame === null) return;
    cancelAnimationFrame(this.decorationFrame);
    this.decorationFrame = null;
  };

  private readonly registerMountedCells = (root: Node): boolean => {
    const grid = this.grid;
    if (grid === null) return false;
    let changed = false;
    for (const cell of ownedGridCellsWithin(root, grid)) {
      const rowId = cell.dataset["brunoRowId"];
      const columnId = cell.dataset["brunoColumnId"];
      if (rowId === undefined || columnId === undefined) continue;
      if (this.mountedCellCoordinates.has(cell)) continue;
      this.mountedCellCoordinates.set(cell, { rowId, columnId });
      changed = true;
      let columns = this.mountedCellsByRow.get(rowId);
      if (columns === undefined) {
        columns = new Map();
        this.mountedCellsByRow.set(rowId, columns);
      }
      let cells = columns.get(columnId);
      if (cells === undefined) {
        cells = new Set();
        columns.set(columnId, cells);
      }
      cells.add(cell);
      if (this.isCellSelected(rowId, columnId)) this.pendingDecorationCells.add(cell);
    }
    return changed;
  };

  private readonly unregisterMountedCells = (root: Node): boolean => {
    if (!(root instanceof HTMLElement)) return false;
    let changed = false;
    if (this.mountedCellCoordinates.has(root)) {
      this.unregisterMountedCell(root);
      changed = true;
    }
    for (const cell of root.querySelectorAll<HTMLElement>(
      '[role="gridcell"][data-bruno-row-id][data-bruno-column-id]',
    )) {
      if (!this.mountedCellCoordinates.has(cell)) continue;
      this.unregisterMountedCell(cell);
      changed = true;
    }
    return changed;
  };

  private readonly unregisterMountedCell = (cell: HTMLElement): void => {
    const coordinate = this.mountedCellCoordinates.get(cell);
    if (coordinate === undefined) return;
    this.mountedCellCoordinates.delete(cell);
    const columns = this.mountedCellsByRow.get(coordinate.rowId);
    const cells = columns?.get(coordinate.columnId);
    cells?.delete(cell);
    if (cells?.size === 0) columns?.delete(coordinate.columnId);
    if (columns?.size === 0) this.mountedCellsByRow.delete(coordinate.rowId);
    this.pendingDecorationCells.delete(cell);
    if (this.decoratedCells.delete(cell)) clearCellRangeDecoration(cell);
  };

  private readonly clearDecoratedCells = (): void => {
    for (const cell of this.decoratedCells) clearCellRangeDecoration(cell);
    this.decoratedCells.clear();
    this.pendingDecorationCells.clear();
    this.pendingDecorationProjectionCandidateCount = 0;
  };

  private readonly decorateMountedCells = (): void => {
    let inspectedCellCount = 0;
    let writtenCellCount = 0;
    const pending = [...this.pendingDecorationCells];
    this.pendingDecorationCells.clear();
    for (const cell of pending) {
      inspectedCellCount += 1;
      const coordinate = this.mountedCellCoordinates.get(cell);
      if (coordinate === undefined) continue;
      const selected = this.isCellSelected(coordinate.rowId, coordinate.columnId);
      const decorated = this.decoratedCells.has(cell);
      if (selected === decorated) continue;
      if (selected) {
        this.decoratedCells.add(cell);
        applyCellRangeDecoration(cell);
      } else {
        this.decoratedCells.delete(cell);
        clearCellRangeDecoration(cell);
      }
      writtenCellCount += 1;
    }
    recordInstrumentation({
      kind: "mounted-decoration",
      tableId: this.tableId,
      mountedCellCount: inspectedCellCount,
      writtenCellCount,
      projectionCandidateCount: this.pendingDecorationProjectionCandidateCount,
    });
    this.pendingDecorationProjectionCandidateCount = 0;
  };

  private readonly enqueueDecorationDelta = (
    previous: BrunoTableCellRangeSnapshot,
    next: BrunoTableCellRangeSnapshot,
  ): void => {
    const structure = this.structure;
    if (previous.range === undefined && next.range === undefined) {
      if (previous.anchor !== undefined) {
        this.pendingDecorationProjectionCandidateCount += 1;
        this.enqueueMountedCoordinate(previous.anchor.rowId, previous.anchor.columnId);
      }
      if (next.anchor !== undefined) {
        this.pendingDecorationProjectionCandidateCount += 1;
        this.enqueueMountedCoordinate(next.anchor.rowId, next.anchor.columnId);
      }
      return;
    }
    const previousHorizontal = horizontalSelectionInterval(previous);
    const nextHorizontal = horizontalSelectionInterval(next);
    if (
      structure !== undefined &&
      previousHorizontal !== undefined &&
      nextHorizontal !== undefined &&
      previousHorizontal.identity === nextHorizontal.identity
    ) {
      const columns = this.mountedCellsByRow.get(previousHorizontal.identity);
      if (columns !== undefined) {
        for (const [columnId, cells] of columns) {
          this.pendingDecorationProjectionCandidateCount += 1;
          if (
            identityFallsWithin(
              structure.columnIndexById,
              columnId,
              previousHorizontal.first,
              previousHorizontal.last,
            ) ===
            identityFallsWithin(
              structure.columnIndexById,
              columnId,
              nextHorizontal.first,
              nextHorizontal.last,
            )
          ) {
            continue;
          }
          for (const cell of cells) this.pendingDecorationCells.add(cell);
        }
      }
      return;
    }
    const previousVertical = verticalSelectionInterval(previous);
    const nextVertical = verticalSelectionInterval(next);
    if (
      structure !== undefined &&
      previousVertical !== undefined &&
      nextVertical !== undefined &&
      previousVertical.identity === nextVertical.identity
    ) {
      const deltaSize = identityIntervalDeltaSize(
        structure.rowIndexById,
        previousVertical.first,
        previousVertical.last,
        nextVertical.first,
        nextVertical.last,
      );
      if (deltaSize === undefined || deltaSize > this.mountedCellsByRow.size) {
        for (const [rowId, columns] of this.mountedCellsByRow) {
          const cells = columns.get(previousVertical.identity);
          if (cells === undefined) continue;
          this.pendingDecorationProjectionCandidateCount += 1;
          if (
            identityFallsWithin(
              structure.rowIndexById,
              rowId,
              previousVertical.first,
              previousVertical.last,
            ) ===
            identityFallsWithin(
              structure.rowIndexById,
              rowId,
              nextVertical.first,
              nextVertical.last,
            )
          ) {
            continue;
          }
          for (const cell of cells) this.pendingDecorationCells.add(cell);
        }
        return;
      }
      this.enqueueIdentityIntervalDelta(
        structure.rowIds,
        structure.rowIndexById,
        previousVertical.first,
        previousVertical.last,
        nextVertical.first,
        nextVertical.last,
        (rowId) => {
          this.pendingDecorationProjectionCandidateCount += 1;
          this.enqueueMountedCoordinate(rowId, previousVertical.identity);
        },
      );
      return;
    }
    for (const cell of this.decoratedCells) this.pendingDecorationCells.add(cell);
    this.enqueueMountedSelectionProjection(next, structure);
  };

  private readonly enqueueMountedSelectionProjection = (
    snapshot: BrunoTableCellRangeSnapshot,
    structure: BrunoTableCellRangeStructure | undefined,
  ): void => {
    const anchor = snapshot.anchor;
    if (anchor === undefined) return;
    const range = snapshot.range;
    if (range === undefined) {
      this.pendingDecorationProjectionCandidateCount += 1;
      this.enqueueMountedCoordinate(anchor.rowId, anchor.columnId);
      return;
    }
    if (range.axis === "horizontal") {
      const columns = this.mountedCellsByRow.get(range.rowId);
      if (columns === undefined) return;
      for (const [columnId, cells] of columns) {
        this.pendingDecorationProjectionCandidateCount += 1;
        if (
          structure !== undefined &&
          !identityFallsWithin(
            structure.columnIndexById,
            columnId,
            identitySpanFirst(range.columnSpan),
            identitySpanLast(range.columnSpan),
          )
        ) {
          continue;
        }
        for (const cell of cells) this.pendingDecorationCells.add(cell);
      }
      return;
    }
    if (identitySpanLength(range.rowSpan) <= this.mountedCellsByRow.size) {
      forEachIdentitySpan(range.rowSpan, (rowId) => {
        this.pendingDecorationProjectionCandidateCount += 1;
        this.enqueueMountedCoordinate(rowId, range.columnId);
      });
      return;
    }
    for (const [rowId, columns] of this.mountedCellsByRow) {
      const cells = columns.get(range.columnId);
      if (cells === undefined) continue;
      this.pendingDecorationProjectionCandidateCount += 1;
      if (
        structure !== undefined &&
        !identityFallsWithin(
          structure.rowIndexById,
          rowId,
          identitySpanFirst(range.rowSpan),
          identitySpanLast(range.rowSpan),
        )
      ) {
        continue;
      }
      for (const cell of cells) this.pendingDecorationCells.add(cell);
    }
  };

  private readonly enqueueIdentityIntervalDelta = (
    identities: readonly string[],
    indexById: ReadonlyMap<string, number>,
    previousFirst: string,
    previousLast: string | undefined,
    nextFirst: string,
    nextLast: string | undefined,
    enqueue: (identity: string) => void,
  ): void => {
    const previousStart = indexById.get(previousFirst);
    const previousEnd = previousLast === undefined ? undefined : indexById.get(previousLast);
    const nextStart = indexById.get(nextFirst);
    const nextEnd = nextLast === undefined ? undefined : indexById.get(nextLast);
    if (
      previousStart === undefined ||
      previousEnd === undefined ||
      nextStart === undefined ||
      nextEnd === undefined
    ) {
      for (const cell of this.mountedCellCoordinates.keys()) this.pendingDecorationCells.add(cell);
      return;
    }
    const previousLow = Math.min(previousStart, previousEnd);
    const previousHigh = Math.max(previousStart, previousEnd);
    const nextLow = Math.min(nextStart, nextEnd);
    const nextHigh = Math.max(nextStart, nextEnd);
    if (previousHigh < nextLow || nextHigh < previousLow) {
      for (let index = previousLow; index <= previousHigh; index += 1) enqueue(identities[index]!);
      for (let index = nextLow; index <= nextHigh; index += 1) enqueue(identities[index]!);
      return;
    }
    for (
      let index = Math.min(previousLow, nextLow);
      index < Math.max(previousLow, nextLow);
      index += 1
    ) {
      enqueue(identities[index]!);
    }
    for (
      let index = Math.min(previousHigh, nextHigh) + 1;
      index <= Math.max(previousHigh, nextHigh);
      index += 1
    ) {
      enqueue(identities[index]!);
    }
  };

  private readonly enqueueMountedCoordinate = (rowId: string, columnId: string): void => {
    const cells = this.mountedCellsByRow.get(rowId)?.get(columnId);
    if (cells === undefined) return;
    for (const cell of cells) this.pendingDecorationCells.add(cell);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const gesture = this.pointerGesture;
    if (
      gesture === undefined ||
      event.pointerId !== this.ensureGestureActor().getSnapshot().pointerId
    )
      return;
    event.preventDefault();
    gesture.clientX = event.clientX;
    gesture.clientY = event.clientY;
    gesture.target = event.target;
    this.schedulePointerFrame(gesture);
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    const gesture = this.pointerGesture;
    if (
      gesture === undefined ||
      event.pointerId !== this.ensureGestureActor().getSnapshot().pointerId
    )
      return;
    gesture.clientX = event.clientX;
    gesture.clientY = event.clientY;
    gesture.target = event.target;
    this.applyPointerFrame(gesture, false);
    this.ensureGestureActor().send({ type: "COMMIT" });
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    if (event.pointerId !== this.gestureActor?.getSnapshot().pointerId) return;
    this.cancelPointerGesture();
  };

  private readonly schedulePointerFrame = (gesture: BrunoTableCellRangePointerGesture): void => {
    if (gesture.frame !== null) return;
    gesture.frame = gesture.view.requestAnimationFrame(() => {
      gesture.frame = null;
      if (this.pointerGesture !== gesture) return;
      const autoscrolled = this.applyPointerFrame(gesture);
      if (autoscrolled) this.schedulePointerFrame(gesture);
    });
  };

  private readonly applyPointerFrame = (
    gesture: BrunoTableCellRangePointerGesture,
    allowAutoscroll = true,
  ): boolean => {
    const shouldRecordFrame =
      __BRUNO_TABLE_TEST_DIAGNOSTICS__ && instrumentationListenersByTable.has(this.tableId);
    const startedAt = shouldRecordFrame ? performance.now() : 0;
    try {
      const structure = this.structure;
      if (structure === undefined) return false;
      const gestureActor = this.ensureGestureActor();
      let axis = gestureActor.getSnapshot().axis;
      if (axis === undefined) {
        const horizontal = Math.abs(gesture.clientX - gesture.startX);
        const vertical = Math.abs(gesture.clientY - gesture.startY);
        if (
          Math.max(horizontal, vertical) <= BRUNO_TABLE_CELL_RANGE_DRAG_SLOP ||
          horizontal === vertical
        ) {
          return false;
        }
        axis = horizontal > vertical ? "horizontal" : "vertical";
        gestureActor.send({ type: "ACQUIRE_AXIS", axis });
      }
      const bounds = gesture.grid.getBoundingClientRect();
      const hit = resolvePointerHit(gesture, bounds);
      if (hit !== undefined) {
        const next = this.extend(hit, structure, axis);
        const focus = next.range?.focus ?? next.anchor;
        if (focus !== undefined) {
          const rowIndex = structure.rowIndexById.get(focus.rowId);
          if (rowIndex !== undefined) gesture.activate({ ...focus, rowIndex });
        }
      }
      if (!allowAutoscroll) return false;
      if (axis === "horizontal") {
        const delta =
          gesture.clientX < bounds.left + BRUNO_TABLE_CELL_RANGE_AUTOSCROLL_ZONE
            ? -BRUNO_TABLE_CELL_RANGE_AUTOSCROLL_STEP
            : gesture.clientX > bounds.right - BRUNO_TABLE_CELL_RANGE_AUTOSCROLL_ZONE
              ? BRUNO_TABLE_CELL_RANGE_AUTOSCROLL_STEP
              : 0;
        return delta !== 0 && gesture.scrollHorizontalByPhysical(delta);
      }
      const delta =
        gesture.clientY < bounds.top + BRUNO_TABLE_CELL_RANGE_AUTOSCROLL_ZONE
          ? -BRUNO_TABLE_CELL_RANGE_AUTOSCROLL_STEP
          : gesture.clientY > bounds.bottom - BRUNO_TABLE_CELL_RANGE_AUTOSCROLL_ZONE
            ? BRUNO_TABLE_CELL_RANGE_AUTOSCROLL_STEP
            : 0;
      if (delta === 0) return false;
      const before = gesture.grid.scrollTop;
      gesture.grid.scrollTop += delta;
      return gesture.grid.scrollTop !== before;
    } finally {
      if (shouldRecordFrame) {
        void BRUNO_TABLE_CELL_RANGE_FRAME_TIMING_DIAGNOSTIC_SENTINEL;
        recordInstrumentation({
          durationMs: performance.now() - startedAt,
          kind: "pointer-frame",
          tableId: this.tableId,
        });
      }
    }
  };

  private readonly detachPointerGesture = (
    gesture: BrunoTableCellRangePointerGesture,
    pointerId: number,
  ): void => {
    if (gesture.frame !== null) gesture.view.cancelAnimationFrame(gesture.frame);
    gesture.view.removeEventListener("pointermove", this.onPointerMove, true);
    gesture.view.removeEventListener("pointerup", this.onPointerUp, true);
    gesture.view.removeEventListener("pointercancel", this.onPointerCancel, true);
    try {
      if (gesture.grid.hasPointerCapture(pointerId)) {
        gesture.grid.releasePointerCapture(pointerId);
      }
    } catch {
      // Synthetic browser events may not have a native active pointer.
    }
    this.pointerGesture = undefined;
  };

  private readonly ensureGestureActor = (): ReturnType<
    typeof createBrunoTableCellRangeGestureActor
  > => {
    this.gestureActor ??= createBrunoTableCellRangeGestureActor();
    return this.gestureActor;
  };
}

function recordInstrumentation(event: BrunoTableCellRangeInstrumentationEvent): void {
  const listeners = instrumentationListenersByTable.get(event.tableId);
  if (listeners === undefined) return;
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Diagnostics must never alter the interaction they observe.
    }
  }
}

function ownedGridCellsWithin(root: Node, grid: HTMLElement): readonly HTMLElement[] {
  if (!(root instanceof HTMLElement)) return [];
  const candidates = [
    ...(root.matches('[role="gridcell"][data-bruno-row-id][data-bruno-column-id]')
      ? [root as HTMLElement]
      : []),
    ...root.querySelectorAll<HTMLElement>(
      '[role="gridcell"][data-bruno-row-id][data-bruno-column-id]',
    ),
  ];
  return candidates.filter((cell) => cell.closest('[role="grid"]') === grid);
}

function applyCellRangeDecoration(cell: HTMLElement): void {
  cell.setAttribute("aria-selected", "true");
  cell.setAttribute("data-bruno-cell-range-selected", "");
  cell.style.boxShadow = "inset 0 0 0 2px Highlight";
}

function clearCellRangeDecoration(cell: HTMLElement): void {
  cell.removeAttribute("aria-selected");
  cell.removeAttribute("data-bruno-cell-range-selected");
  cell.style.removeProperty("box-shadow");
}

export function captureBrunoTableClipboardSnapshot(
  target: BrunoTableClipboardTarget,
  read: (cell: BrunoTableCellCoordinate) =>
    | Readonly<{
        readonly value: unknown;
        readonly formatCanonicalText: (value: unknown) => string;
      }>
    | undefined,
): BrunoTableClipboardSnapshot | undefined {
  const coordinates =
    target.axis === "horizontal"
      ? target.columnIds.map((columnId) => ({ rowId: target.rowIds[0], columnId }))
      : target.rowIds.map((rowId) => ({ rowId, columnId: target.columnIds[0] }));
  const evidence: BrunoTableClipboardCellEvidence[] = [];
  for (const cell of coordinates) {
    const cellEvidence = read(cell);
    if (cellEvidence === undefined) return undefined;
    evidence.push(
      Object.freeze({
        rowId: cell.rowId,
        columnId: cell.columnId,
        value: cellEvidence.value,
        formatCanonicalText: cellEvidence.formatCanonicalText,
      }),
    );
  }
  const canonicalTexts = evidence.map((cell) =>
    cell.value === null || cell.value === undefined ? "" : cell.formatCanonicalText(cell.value),
  );
  if (!hasNonEmptyIdentitySpan(canonicalTexts)) return undefined;
  return target.axis === "horizontal"
    ? Object.freeze({
        axis: target.axis,
        rowIds: target.rowIds,
        columnIds: target.columnIds,
        canonicalTexts: Object.freeze(canonicalTexts),
      })
    : Object.freeze({
        axis: target.axis,
        rowIds: target.rowIds,
        columnIds: target.columnIds,
        canonicalTexts: Object.freeze(canonicalTexts),
      });
}

export function serializeBrunoTableClipboardSnapshot(
  snapshot: BrunoTableClipboardSnapshot,
): string {
  const separator = snapshot.axis === "horizontal" ? "\t" : "\n";
  return snapshot.canonicalTexts
    .map((value, index) =>
      escapeTsvCell(
        value,
        // A final vertical blank would otherwise look like an implicit terminal row.
        // Horizontal TSV preserves a trailing blank after its final tab without quoting.
        snapshot.axis === "vertical" &&
          index === snapshot.canonicalTexts.length - 1 &&
          value.length === 0,
      ),
    )
    .join(separator);
}

export function clipboardTargetFromRange(range: BrunoTableCellRange): BrunoTableClipboardTarget {
  return range.axis === "horizontal"
    ? Object.freeze({
        axis: range.axis,
        rowIds: range.rowIds,
        columnIds: materializeIdentitySpan(range.columnSpan),
      })
    : Object.freeze({
        axis: range.axis,
        rowIds: materializeIdentitySpan(range.rowSpan),
        columnIds: range.columnIds,
      });
}

export function clipboardTargetFromSelection(
  snapshot: BrunoTableCellRangeSnapshot,
  activeCell: BrunoTableCellCoordinate | undefined,
): BrunoTableClipboardTarget | undefined {
  if (snapshot.range !== undefined) return clipboardTargetFromRange(snapshot.range);
  const cell = activeCell ?? snapshot.anchor;
  if (cell === undefined) return undefined;
  const rowIds: readonly [string] = Object.freeze([cell.rowId]);
  const columnIds: BrunoTableNonEmptyIdentitySpan = Object.freeze([cell.columnId]);
  return Object.freeze({ axis: "horizontal", rowIds, columnIds });
}

function freezeCoordinate(coordinate: BrunoTableCellCoordinate): BrunoTableCellCoordinate {
  return Object.freeze({ rowId: coordinate.rowId, columnId: coordinate.columnId });
}

function containsCoordinate(
  structure: BrunoTableCellRangeStructure,
  coordinate: BrunoTableCellCoordinate,
): boolean {
  return (
    structure.rowIndexById.has(coordinate.rowId) &&
    structure.columnIndexById.has(coordinate.columnId)
  );
}

function chooseAxis(
  anchor: BrunoTableCellCoordinate,
  target: BrunoTableCellCoordinate,
  structure: BrunoTableCellRangeStructure,
): BrunoTableCellRangeAxis | undefined {
  const anchorRow = structure.rowIndexById.get(anchor.rowId);
  const targetRow = structure.rowIndexById.get(target.rowId);
  const anchorColumn = structure.columnIndexById.get(anchor.columnId);
  const targetColumn = structure.columnIndexById.get(target.columnId);
  if (
    anchorRow === undefined ||
    targetRow === undefined ||
    anchorColumn === undefined ||
    targetColumn === undefined
  ) {
    return undefined;
  }
  const rowDistance = Math.abs(targetRow - anchorRow);
  const columnDistance = Math.abs(targetColumn - anchorColumn);
  if (rowDistance === 0 && columnDistance === 0) return undefined;
  if (rowDistance === columnDistance) return undefined;
  return columnDistance > rowDistance ? "horizontal" : "vertical";
}

function createRange(
  axis: BrunoTableCellRangeAxis,
  anchor: BrunoTableCellCoordinate,
  target: BrunoTableCellCoordinate,
  structure: BrunoTableCellRangeStructure,
  tableId: string,
): BrunoTableCellRange | undefined {
  if (axis === "horizontal") {
    const columnSpan = createIdentitySpan(
      structure.columnIds,
      structure.columnIndexById,
      anchor.columnId,
      target.columnId,
      tableId,
    );
    if (columnSpan === undefined) return undefined;
    const rowIds: readonly [string] = Object.freeze([anchor.rowId]);
    const columnIds = lazyMaterializeIdentitySpan(columnSpan);
    return Object.freeze({
      axis,
      rowId: anchor.rowId,
      rowIds,
      get columnIds() {
        return columnIds();
      },
      columnSpan,
      anchor,
      focus: Object.freeze({ rowId: anchor.rowId, columnId: target.columnId }),
    });
  }
  const rowSpan = createIdentitySpan(
    structure.rowIds,
    structure.rowIndexById,
    anchor.rowId,
    target.rowId,
    tableId,
  );
  if (rowSpan === undefined) return undefined;
  const rowIds = lazyMaterializeIdentitySpan(rowSpan);
  const columnIds: readonly [string] = Object.freeze([anchor.columnId]);
  return Object.freeze({
    axis,
    columnId: anchor.columnId,
    get rowIds() {
      return rowIds();
    },
    rowSpan,
    columnIds,
    anchor,
    focus: Object.freeze({ rowId: target.rowId, columnId: anchor.columnId }),
  });
}

function createIdentitySpan(
  identities: readonly string[],
  indexById: ReadonlyMap<string, number>,
  firstIdentity: string,
  secondIdentity: string,
  tableId: string,
): BrunoTableIdentitySpan | undefined {
  const first = indexById.get(firstIdentity);
  const second = indexById.get(secondIdentity);
  if (first === undefined || second === undefined || first === second) return undefined;
  const start = Math.min(first, second);
  const end = Math.max(first, second);
  return Object.freeze({ identities, start, end, tableId });
}

function identitySpanLength(span: BrunoTableIdentitySpan): number {
  return span.end - span.start + 1;
}

function identitySpanFirst(span: BrunoTableIdentitySpan): string {
  return span.identities[span.start]!;
}

function identitySpanLast(span: BrunoTableIdentitySpan): string {
  return span.identities[span.end]!;
}

function materializeIdentitySpan(
  span: BrunoTableIdentitySpan,
): readonly [string, string, ...string[]] {
  recordInstrumentation({ kind: "identity-span-materialization", tableId: span.tableId });
  return Object.freeze(span.identities.slice(span.start, span.end + 1)) as readonly [
    string,
    string,
    ...string[],
  ];
}

function lazyMaterializeIdentitySpan(
  span: BrunoTableIdentitySpan,
): () => readonly [string, string, ...string[]] {
  let materialized: readonly [string, string, ...string[]] | undefined;
  return () => (materialized ??= materializeIdentitySpan(span));
}

function forEachIdentitySpan(
  span: BrunoTableIdentitySpan,
  visit: (identity: string) => void,
): void {
  for (let index = span.start; index <= span.end; index += 1) visit(span.identities[index]!);
}

function hasNonEmptyIdentitySpan(
  identities: readonly string[],
): identities is BrunoTableNonEmptyIdentitySpan {
  return identities.length >= 1;
}

function rangeMatchesStructure(
  range: BrunoTableCellRange,
  structure: BrunoTableCellRangeStructure,
): boolean {
  if (range.axis === "horizontal") {
    if (!structure.rowIndexById.has(range.rowId)) return false;
    return identitySpanMatchesStructure(
      range.columnSpan,
      structure.columnIds,
      structure.columnIndexById,
    );
  }
  if (!structure.columnIndexById.has(range.columnId)) return false;
  return identitySpanMatchesStructure(range.rowSpan, structure.rowIds, structure.rowIndexById);
}

function identitySpanMatchesStructure(
  span: BrunoTableIdentitySpan,
  identities: readonly string[],
  indexById: ReadonlyMap<string, number>,
): boolean {
  const first = indexById.get(identitySpanFirst(span));
  const last = indexById.get(identitySpanLast(span));
  if (first === undefined || last === undefined) return false;
  const start = Math.min(first, last);
  const end = Math.max(first, last);
  if (end - start !== span.end - span.start) return false;
  if (identities === span.identities && start === span.start && end === span.end) return true;
  for (let offset = 0; offset <= end - start; offset += 1) {
    if (identities[start + offset] !== span.identities[span.start + offset]) return false;
  }
  return true;
}

function snapshotMatchesStructure(
  snapshot: BrunoTableCellRangeSnapshot,
  structure: BrunoTableCellRangeStructure,
): boolean {
  if (snapshot.anchor === undefined) return snapshot.range === undefined;
  if (!containsCoordinate(structure, snapshot.anchor)) return false;
  return snapshot.range === undefined || rangeMatchesStructure(snapshot.range, structure);
}

function indexIdentities(identities: readonly string[]): ReadonlyMap<string, number> {
  return new Map(identities.map((identity, index) => [identity, index]));
}

function identityFallsWithin(
  indexById: ReadonlyMap<string, number>,
  candidateIdentity: string,
  firstIdentity: string,
  lastIdentity: string | undefined,
): boolean {
  if (lastIdentity === undefined) return false;
  const candidate = indexById.get(candidateIdentity);
  const first = indexById.get(firstIdentity);
  const last = indexById.get(lastIdentity);
  return (
    candidate !== undefined &&
    first !== undefined &&
    last !== undefined &&
    candidate >= Math.min(first, last) &&
    candidate <= Math.max(first, last)
  );
}

type BrunoTableCellRangeSelectionInterval = Readonly<{
  readonly identity: string;
  readonly first: string;
  readonly last: string;
}>;

function horizontalSelectionInterval(
  snapshot: BrunoTableCellRangeSnapshot,
): BrunoTableCellRangeSelectionInterval | undefined {
  const range = snapshot.range;
  if (range?.axis === "horizontal") {
    return {
      identity: range.rowId,
      first: identitySpanFirst(range.columnSpan),
      last: identitySpanLast(range.columnSpan),
    };
  }
  if (range !== undefined || snapshot.anchor === undefined) return undefined;
  return {
    identity: snapshot.anchor.rowId,
    first: snapshot.anchor.columnId,
    last: snapshot.anchor.columnId,
  };
}

function verticalSelectionInterval(
  snapshot: BrunoTableCellRangeSnapshot,
): BrunoTableCellRangeSelectionInterval | undefined {
  const range = snapshot.range;
  if (range?.axis === "vertical") {
    return {
      identity: range.columnId,
      first: identitySpanFirst(range.rowSpan),
      last: identitySpanLast(range.rowSpan),
    };
  }
  if (range !== undefined || snapshot.anchor === undefined) return undefined;
  return {
    identity: snapshot.anchor.columnId,
    first: snapshot.anchor.rowId,
    last: snapshot.anchor.rowId,
  };
}

function identityIntervalDeltaSize(
  indexById: ReadonlyMap<string, number>,
  previousFirst: string,
  previousLast: string,
  nextFirst: string,
  nextLast: string,
): number | undefined {
  const previousStart = indexById.get(previousFirst);
  const previousEnd = indexById.get(previousLast);
  const nextStart = indexById.get(nextFirst);
  const nextEnd = indexById.get(nextLast);
  if (
    previousStart === undefined ||
    previousEnd === undefined ||
    nextStart === undefined ||
    nextEnd === undefined
  ) {
    return undefined;
  }
  const previousLow = Math.min(previousStart, previousEnd);
  const previousHigh = Math.max(previousStart, previousEnd);
  const nextLow = Math.min(nextStart, nextEnd);
  const nextHigh = Math.max(nextStart, nextEnd);
  if (previousHigh < nextLow || nextHigh < previousLow) {
    return previousHigh - previousLow + 1 + (nextHigh - nextLow + 1);
  }
  return Math.abs(previousLow - nextLow) + Math.abs(previousHigh - nextHigh);
}

function sameSnapshot(
  left: BrunoTableCellRangeSnapshot,
  right: BrunoTableCellRangeSnapshot,
): boolean {
  if (
    left.anchor?.rowId !== right.anchor?.rowId ||
    left.anchor?.columnId !== right.anchor?.columnId ||
    left.range?.axis !== right.range?.axis
  ) {
    return false;
  }
  if (left.range === undefined || right.range === undefined) {
    return left.range === right.range;
  }
  return (
    left.range.focus.rowId === right.range.focus.rowId &&
    left.range.focus.columnId === right.range.focus.columnId
  );
}

function escapeTsvCell(value: string, forceQuote = false): string {
  return forceQuote || /[\t\r\n"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function resolvePointerHit(
  gesture: BrunoTableCellRangePointerGesture,
  bounds: DOMRect,
): BrunoTableCellRangeHit | undefined {
  const direct = closestCellHit(gesture.target, gesture.grid);
  if (direct !== undefined) return direct;
  const contentLeft = bounds.left + gesture.grid.clientLeft;
  const contentTop = bounds.top + gesture.grid.clientTop;
  const bodyRight = contentLeft + gesture.grid.clientWidth;
  const bodyTop = contentTop + gesture.bodyViewportTopInset;
  const bodyBottom = contentTop + gesture.grid.clientHeight;
  if (bodyRight - contentLeft <= 2 || bodyBottom - bodyTop <= 2) return undefined;
  const projectedX = Math.min(Math.max(gesture.clientX, contentLeft + 1), bodyRight - 2);
  const projectedY = Math.min(Math.max(gesture.clientY, bodyTop + 1), bodyBottom - 2);
  return closestCellHit(
    gesture.grid.ownerDocument.elementFromPoint(projectedX, projectedY),
    gesture.grid,
  );
}

function captureBodyViewportTopInset(grid: HTMLElement): number {
  const contentTop = grid.getBoundingClientRect().top + grid.clientTop;
  const header = grid.querySelector<HTMLElement>("thead");
  if (header === null || header.closest('[role="grid"]') !== grid) return 0;
  return Math.min(
    grid.clientHeight,
    Math.max(0, header.getBoundingClientRect().bottom - contentTop),
  );
}

const CELL_RANGE_POINTER_EXCLUSION_SELECTOR =
  'label,a[href],area[href],button,input,select,summary,textarea,iframe,object,embed,audio[controls],video[controls],[contenteditable]:not([contenteditable="false"]),[tabindex],[role="button"],[role="link"],[role="checkbox"],[role="textbox"],[role="combobox"],[role="slider"],[role="switch"],[role="radio"],[role="spinbutton"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="tab"],[role="treeitem"]';

export function brunoTableCellRangePointerHit(
  target: EventTarget | null,
  grid: HTMLElement,
): BrunoTableCellRangeHit | undefined {
  const hit = closestCellHit(target, grid);
  if (hit === undefined) return undefined;
  const ElementConstructor = grid.ownerDocument.defaultView?.Element;
  if (ElementConstructor === undefined || !(target instanceof ElementConstructor)) return undefined;
  const hitCell = target.closest<HTMLElement>(
    '[role="gridcell"][data-bruno-row-id][data-bruno-row-index][data-bruno-column-id]',
  );
  const excludedDescendant = target.closest<HTMLElement>(CELL_RANGE_POINTER_EXCLUSION_SELECTOR);
  return hitCell !== null &&
    excludedDescendant !== null &&
    excludedDescendant !== hitCell &&
    hitCell.contains(excludedDescendant)
    ? undefined
    : hit;
}

function closestCellHit(
  target: EventTarget | null,
  grid: HTMLElement,
): BrunoTableCellRangeHit | undefined {
  const ElementConstructor = grid.ownerDocument.defaultView?.Element;
  if (ElementConstructor === undefined || !(target instanceof ElementConstructor)) return undefined;
  const cell = target.closest<HTMLElement>(
    '[role="gridcell"][data-bruno-row-id][data-bruno-row-index][data-bruno-column-id]',
  );
  if (cell === null || cell.closest('[role="grid"]') !== grid) return undefined;
  const rowId = cell.dataset["brunoRowId"];
  const columnId = cell.dataset["brunoColumnId"];
  const rowIndexText = cell.dataset["brunoRowIndex"];
  if (rowId === undefined || columnId === undefined || rowIndexText === undefined) return undefined;
  const rowIndex = Number(rowIndexText);
  if (!Number.isSafeInteger(rowIndex) || rowIndex < 0) return undefined;
  return Object.freeze({ rowId, columnId, rowIndex });
}
