import { Store } from "@tanstack/store";
import { assign, createActor, createMachine } from "xstate";

import {
  brunoTableCellRangePointerHit,
  type BrunoTableCellCoordinate,
  type BrunoTableCellRangeAxis,
  type BrunoTableCellRangeStructure,
} from "./cell-range-clipboard";
import {
  captureBrunoTableDragFillGesture,
  isBrunoTableDragFillGestureCoherent,
  materializeBrunoTableDragFillCandidates,
  projectBrunoTableDragFillPreview,
  resolveBrunoTableDragFillAxis,
  type BrunoTableDragFillGesture,
  type BrunoTableDragFillPreview,
} from "./drag-fill-planner";
import {
  hasBrunoTableClientDragFillFrameListener,
  recordBrunoTableClientDragFillFrame,
} from "./render-instrumentation";

const DRAG_FILL_SLOP = 4;
const DRAG_FILL_AUTOSCROLL_ZONE = 24;
const DRAG_FILL_AUTOSCROLL_STEP = 12;
export const BRUNO_TABLE_DRAG_FILL_MAX_CELLS = 16_384;

export function isBrunoTableDragFillCellCountAllowed(cellCount: number): boolean {
  return (
    Number.isSafeInteger(cellCount) &&
    cellCount >= 1 &&
    cellCount <= BRUNO_TABLE_DRAG_FILL_MAX_CELLS
  );
}

type NonEmptyStrings = readonly [string, ...string[]];

export type BrunoTableDragFillSourceShape = Readonly<{
  /** Stable opaque identity for the ordered source shape, excluding canonical value publications. */
  readonly shapeIdentity: object;
  readonly axis: BrunoTableCellRangeAxis;
  readonly sourceCellCount: number;
  readonly sourceFirstIdentity: string;
  readonly sourceLastIdentity: string;
  readonly perpendicularIdentity: string;
  readonly handle: BrunoTableCellCoordinate;
}>;

export type BrunoTableDragFillSource = BrunoTableDragFillSourceShape &
  Readonly<{
    readonly rowIds: NonEmptyStrings;
    readonly columnIds: NonEmptyStrings;
    readonly canonicalTexts: NonEmptyStrings;
  }>;

export type BrunoTableDragFillCell = Readonly<{
  readonly rowId: string;
  readonly columnId: string;
  readonly canonicalText: string;
}>;

export type BrunoTableDragFillRejectionReason =
  | "structure-changed"
  | "temporarily-unavailable"
  | "invalid-target"
  | "save-locked"
  | "unavailable"
  | "stale"
  | "blocked"
  | "row-version"
  | "invalid-source"
  | "read-only"
  | "invalid-value"
  | "empty";

export type BrunoTableDragFillApplyResult =
  | Readonly<{ readonly kind: "accepted" }>
  | Readonly<{ readonly kind: "unchanged" }>
  | Readonly<{
      readonly kind: "rejected";
      readonly reason: BrunoTableDragFillRejectionReason;
      readonly detail?: string;
      readonly rowId?: string;
      readonly columnId?: string;
      readonly additionalInvalidCount?: number;
    }>;

export function addBrunoTableDragFillRejectionEvidence(
  cells: readonly [BrunoTableDragFillCell, ...BrunoTableDragFillCell[]],
  rejection: Extract<BrunoTableDragFillApplyResult, { readonly kind: "rejected" }>,
): Extract<BrunoTableDragFillApplyResult, { readonly kind: "rejected" }> {
  if (rejection.rowId !== undefined && rejection.columnId !== undefined) return rejection;
  const first = cells[0];
  return Object.freeze({
    ...rejection,
    rowId: first.rowId,
    columnId: first.columnId,
    additionalInvalidCount: cells.length - 1,
  });
}

export type BrunoTableDragFillNotification = Readonly<{
  readonly sequence: number;
  readonly message: string;
}>;

export type BrunoTableDragFillProjection = Readonly<{
  readonly active: boolean;
  readonly axis?: BrunoTableCellRangeAxis;
}>;

/** The physical interaction lane supplied by the production grid surface. */
export type BrunoTableDragFillInteractionGeometry = Readonly<{
  readonly bodyTop: number;
  readonly bodyBottom: number;
  readonly centreLeft: number;
  readonly centreRight: number;
}>;

type DragFillResources = Readonly<{ readonly acquire: () => void; readonly release: () => void }>;
type DragFillReleasePreflight =
  | Readonly<{ readonly kind: "cancelled" }>
  | Readonly<{
      readonly kind: "ready";
      readonly cells: readonly [BrunoTableDragFillCell, ...BrunoTableDragFillCell[]];
    }>
  | Readonly<{
      readonly kind: "rejected";
      readonly rejection: Extract<BrunoTableDragFillApplyResult, { readonly kind: "rejected" }>;
    }>;
type DragFillReleaseOutcome =
  | BrunoTableDragFillApplyResult
  | Readonly<{ readonly kind: "cancelled" }>;
type DragFillRejectionEvidence = Readonly<{
  readonly rowId: string;
  readonly columnId: string;
  readonly additionalInvalidCount?: number;
}>;
type DragFillReleaseOperation = Readonly<{
  readonly rejectionEvidence?: DragFillRejectionEvidence;
  readonly preflight: () => DragFillReleasePreflight;
  readonly apply: (
    cells: readonly [BrunoTableDragFillCell, ...BrunoTableDragFillCell[]],
  ) => BrunoTableDragFillApplyResult;
  readonly settle: (outcome: DragFillReleaseOutcome) => void;
}>;
type DragFillContext = Readonly<{
  readonly axis: BrunoTableCellRangeAxis | undefined;
  readonly resources: DragFillResources | undefined;
  readonly release: DragFillReleaseOperation | undefined;
  readonly preflight: DragFillReleasePreflight | undefined;
  readonly outcome: DragFillReleaseOutcome | undefined;
}>;
type DragFillEvent =
  | Readonly<{ readonly type: "START"; readonly resources: DragFillResources }>
  | Readonly<{ readonly type: "LOCK_AXIS"; readonly axis: BrunoTableCellRangeAxis }>
  | (Readonly<{ readonly type: "RELEASE" }> & DragFillReleaseOperation)
  | Readonly<{ readonly type: "CANCEL" | "INVALIDATE" }>;

const EMPTY_DRAG_FILL_CONTEXT: DragFillContext = Object.freeze({
  axis: undefined,
  resources: undefined,
  release: undefined,
  preflight: undefined,
  outcome: undefined,
});

const dragFillMachine = createMachine(
  {
    id: "brunoTableDragFill",
    initial: "idle",
    types: {} as { context: DragFillContext; events: DragFillEvent },
    context: EMPTY_DRAG_FILL_CONTEXT,
    states: {
      idle: {
        on: {
          START: {
            target: "armed",
            actions: [assign({ resources: ({ event }) => event.resources }), "acquireResources"],
          },
        },
      },
      armed: {
        on: {
          LOCK_AXIS: {
            actions: assign({
              axis: ({ context, event }) => context.axis ?? event.axis,
            }),
          },
          RELEASE: { target: "preflighting", actions: "storeRelease" },
          CANCEL: { target: "cancelled" },
          INVALIDATE: { target: "cancelled" },
        },
      },
      preflighting: {
        entry: "runPreflight",
        always: [
          {
            guard: "preflightCancelled",
            target: "cancelled",
            actions: assign({
              outcome: () => Object.freeze({ kind: "cancelled" as const }),
            }),
          },
          { guard: "preflightReady", target: "applying" },
          {
            target: "rejected",
            actions: assign({
              outcome: ({ context }) =>
                context.preflight?.kind === "rejected"
                  ? context.preflight.rejection
                  : Object.freeze({
                      kind: "rejected" as const,
                      reason: "temporarily-unavailable" as const,
                    }),
            }),
          },
        ],
      },
      applying: {
        entry: "runApply",
        always: [
          { guard: "applyAccepted", target: "accepted" },
          { guard: "applyUnchanged", target: "unchanged" },
          { target: "rejected" },
        ],
      },
      accepted: {
        entry: ["releaseResources", "settle", "clear"],
        on: {
          START: {
            target: "armed",
            actions: [assign({ resources: ({ event }) => event.resources }), "acquireResources"],
          },
        },
      },
      unchanged: {
        entry: ["releaseResources", "settle", "clear"],
        on: {
          START: {
            target: "armed",
            actions: [assign({ resources: ({ event }) => event.resources }), "acquireResources"],
          },
        },
      },
      rejected: {
        entry: ["releaseResources", "settle", "clear"],
        on: {
          START: {
            target: "armed",
            actions: [assign({ resources: ({ event }) => event.resources }), "acquireResources"],
          },
        },
      },
      cancelled: {
        entry: ["releaseResources", "settle", "clear"],
        on: {
          START: {
            target: "armed",
            actions: [assign({ resources: ({ event }) => event.resources }), "acquireResources"],
          },
        },
      },
    },
  },
  {
    actions: {
      acquireResources: ({ context }) => context.resources?.acquire(),
      releaseResources: ({ context }) => context.resources?.release(),
      storeRelease: assign({
        release: ({ event }) =>
          event.type === "RELEASE"
            ? Object.freeze({
                ...(event.rejectionEvidence === undefined
                  ? {}
                  : { rejectionEvidence: event.rejectionEvidence }),
                preflight: event.preflight,
                apply: event.apply,
                settle: event.settle,
              })
            : undefined,
      }),
      runPreflight: assign({
        preflight: ({ context }) => {
          if (context.release === undefined) {
            return Object.freeze({
              kind: "rejected" as const,
              rejection: Object.freeze({
                kind: "rejected" as const,
                reason: "temporarily-unavailable" as const,
              }),
            });
          }
          try {
            return context.release.preflight();
          } catch {
            return Object.freeze({
              kind: "rejected" as const,
              rejection: Object.freeze({
                kind: "rejected" as const,
                reason: "temporarily-unavailable" as const,
                ...context.release.rejectionEvidence,
              }),
            });
          }
        },
      }),
      runApply: assign({
        outcome: ({ context }) => {
          if (context.preflight?.kind !== "ready" || context.release === undefined) {
            return Object.freeze({
              kind: "rejected" as const,
              reason: "temporarily-unavailable" as const,
              ...context.release?.rejectionEvidence,
            });
          }
          try {
            return context.release.apply(context.preflight.cells);
          } catch {
            return addBrunoTableDragFillRejectionEvidence(
              context.preflight.cells,
              Object.freeze({
                kind: "rejected" as const,
                reason: "temporarily-unavailable" as const,
              }),
            );
          }
        },
      }),
      settle: ({ context }) => {
        if (context.release !== undefined && context.outcome !== undefined) {
          context.release.settle(context.outcome);
        }
      },
      clear: assign({
        axis: () => undefined,
        resources: () => undefined,
        release: () => undefined,
        preflight: () => undefined,
        outcome: () => undefined,
      }),
    },
    guards: {
      preflightCancelled: ({ context }) => context.preflight?.kind === "cancelled",
      preflightReady: ({ context }) => context.preflight?.kind === "ready",
      applyAccepted: ({ context }) => context.outcome?.kind === "accepted",
      applyUnchanged: ({ context }) => context.outcome?.kind === "unchanged",
    },
  },
);

type DragFillState =
  | "idle"
  | "armed"
  | "preflighting"
  | "applying"
  | "accepted"
  | "unchanged"
  | "rejected"
  | "cancelled";

type DragFillActorSnapshot = Readonly<{
  readonly value: DragFillState;
  readonly context: DragFillContext;
  readonly status: "active" | "done" | "error" | "stopped";
}>;

type DragFillActor = Readonly<{
  start: () => void;
  stop: () => void;
  send: (event: DragFillEvent) => void;
  getSnapshot: () => DragFillActorSnapshot;
  subscribe: (
    observer: (snapshot: DragFillActorSnapshot) => void,
  ) => Readonly<{ unsubscribe: () => void }>;
}>;

export function createBrunoTableDragFillActor(): DragFillActor {
  const actor = createActor(dragFillMachine);
  const projectSnapshot = (): DragFillActorSnapshot => {
    const snapshot = actor.getSnapshot();
    const value = snapshot.value;
    if (
      value !== "idle" &&
      value !== "armed" &&
      value !== "preflighting" &&
      value !== "applying" &&
      value !== "accepted" &&
      value !== "unchanged" &&
      value !== "rejected" &&
      value !== "cancelled"
    ) {
      throw new Error("Unexpected Drag Fill workflow state");
    }
    return Object.freeze({ value, context: snapshot.context, status: snapshot.status });
  };
  return Object.freeze({
    start: () => {
      actor.start();
    },
    stop: () => {
      actor.stop();
    },
    send: (event: DragFillEvent) => {
      actor.send(event);
    },
    getSnapshot: projectSnapshot,
    subscribe: (observer: (snapshot: DragFillActorSnapshot) => void) => {
      const subscription = actor.subscribe(() => observer(projectSnapshot()));
      return Object.freeze({ unsubscribe: () => subscription.unsubscribe() });
    },
  });
}

type DragFillRegistration = Readonly<{
  readonly grid: HTMLElement;
  readonly canStart?: (() => boolean) | undefined;
  /** Cheap shape-only read used by DOM reconciliation and release invalidation. */
  readonly getSourceShape: () => BrunoTableDragFillSourceShape | undefined;
  /** One immutable canonical capture, invoked only for an admitted pointerdown. */
  readonly captureSource?: (() => BrunoTableDragFillSource | undefined) | undefined;
  /** Immutable snapshot; its reference may change while the runtime reconciles the affected span. */
  readonly getStructure: () => BrunoTableCellRangeStructure | undefined;
  readonly apply: (
    cells: readonly [BrunoTableDragFillCell, ...BrunoTableDragFillCell[]],
  ) => BrunoTableDragFillApplyResult;
  /** Excludes sticky headers, pinned overlays, and the row-selection utility from auto-scroll. */
  readonly interactionGeometry?: (() => BrunoTableDragFillInteractionGeometry) | undefined;
  /** Cached logical hit testing supplied by the viewport; avoids forced layout in hot frames. */
  readonly resolvePointerHit?:
    | ((
        clientX: number,
        clientY: number,
        phase: "preview" | "release",
      ) => BrunoTableCellCoordinate | undefined)
    | undefined;
  readonly scrollHorizontalByPhysical: (delta: number) => boolean;
  readonly scrollVerticalByLogical?: ((delta: number) => boolean) | undefined;
  readonly describeCoordinate?: (coordinate: BrunoTableCellCoordinate) => string;
}>;

type PointerGesture = Readonly<{
  readonly pointerId: number;
  readonly grid: HTMLElement;
  readonly view: Window;
  readonly sourceShapeIdentity: object;
  readonly source: BrunoTableDragFillSource;
  readonly contentEditableBeforeGesture: Readonly<{ readonly value: string | null }> | undefined;
  readonly gridBounds: DOMRectReadOnly;
  readonly gridDirection: string;
  readonly interactionGeometry: BrunoTableDragFillInteractionGeometry;
  readonly startX: number;
  readonly startY: number;
  readonly registration: DragFillRegistration;
}> & {
  clientX: number;
  clientY: number;
  eventTarget: EventTarget | null;
  frame: number | null;
  gesture: BrunoTableDragFillGesture | undefined;
  preview: BrunoTableDragFillPreview | undefined;
  projectedAxis: BrunoTableCellRangeAxis | undefined;
  projectedTargetIdentity: string | undefined;
  structure: BrunoTableCellRangeStructure;
};

const EMPTY_PROJECTION: BrunoTableDragFillProjection = Object.freeze({ active: false });
const EMPTY_NOTIFICATION: BrunoTableDragFillNotification = Object.freeze({
  sequence: 0,
  message: "",
});

export class BrunoTableDragFillRuntime {
  private actor = createBrunoTableDragFillActor();
  private actorActive = false;
  private readonly projectionStore = new Store<BrunoTableDragFillProjection>(EMPTY_PROJECTION);
  private readonly notificationStore = new Store<BrunoTableDragFillNotification>(
    EMPTY_NOTIFICATION,
  );
  private registration: DragFillRegistration | undefined;
  private pointer: PointerGesture | undefined;
  private handle: HTMLElement | undefined;
  private handleHost: HTMLElement | undefined;
  private observer: MutationObserver | undefined;
  private reconcileFrame: number | null = null;
  private readonly previewCells = new Set<HTMLElement>();

  public constructor(private readonly tableId?: string) {
    this.activateActor();
  }

  private readonly activateActor = (): void => {
    if (this.actorActive) return;
    if (this.actor.getSnapshot().status === "stopped") {
      this.actor = createBrunoTableDragFillActor();
    }
    this.actor.subscribe((snapshot) => {
      const active = snapshot.value === "armed";
      const next = active
        ? Object.freeze({
            active: true,
            ...(snapshot.context.axis === undefined ? {} : { axis: snapshot.context.axis }),
          })
        : EMPTY_PROJECTION;
      if (!sameProjection(this.projectionStore.get(), next)) {
        this.projectionStore.setState(() => next);
      }
    });
    this.actor.start();
    this.actorActive = true;
  };

  public readonly getSnapshot = (): BrunoTableDragFillProjection => this.projectionStore.get();
  public readonly subscribe = (listener: () => void): (() => void) => {
    const subscription = this.projectionStore.subscribe(listener);
    return () => subscription.unsubscribe();
  };
  public readonly getNotificationSnapshot = (): BrunoTableDragFillNotification =>
    this.notificationStore.get();
  public readonly subscribeNotification = (listener: () => void): (() => void) => {
    const subscription = this.notificationStore.subscribe(listener);
    return () => subscription.unsubscribe();
  };

  public readonly register = (registration: DragFillRegistration): (() => void) => {
    this.activateActor();
    this.unregister();
    this.registration = registration;
    this.observer = new MutationObserver(() => this.scheduleReconcile());
    this.observer.observe(registration.grid, { childList: true, subtree: true });
    this.scheduleReconcile();
    return () => {
      if (this.registration === registration) this.unregister();
    };
  };

  public readonly reconcile = (): void => {
    const registration = this.registration;
    if (registration === undefined) return;
    const source = registration.getSourceShape();
    const structure = registration.getStructure();
    if (
      this.pointer !== undefined &&
      (source === undefined ||
        structure === undefined ||
        !this.reconcilePointerStructure(this.pointer, structure) ||
        this.pointer.sourceShapeIdentity !== source.shapeIdentity)
    ) {
      this.invalidate();
    }
    this.placeHandle(source);
    if (this.pointer !== undefined) this.decoratePreview(this.pointer.preview);
  };

  public readonly cancel = (): boolean => {
    if (this.pointer === undefined) return false;
    this.actor.send({ type: "CANCEL" });
    this.clearPreview();
    this.scheduleReconcile();
    return true;
  };

  public readonly invalidate = (): boolean => {
    if (this.pointer === undefined) return false;
    this.actor.send({ type: "INVALIDATE" });
    this.clearPreview();
    this.scheduleReconcile();
    return true;
  };

  public readonly clearNotification = (): void =>
    this.notificationStore.setState((previous) =>
      Object.freeze({ sequence: previous.sequence + 1, message: "" }),
    );

  public readonly dismissNotification = (sequence: number): void =>
    this.notificationStore.setState((previous) =>
      previous.sequence !== sequence || previous.message.length === 0
        ? previous
        : Object.freeze({ sequence: previous.sequence + 1, message: "" }),
    );

  public readonly dispose = (): void => {
    this.unregister();
    if (!this.actorActive) return;
    this.actor.stop();
    this.actorActive = false;
  };

  private readonly start = (event: PointerEvent): void => {
    const registration = this.registration;
    if (registration === undefined || registration.canStart?.() === false) return;
    const sourceShape = registration.getSourceShape();
    const structure = registration.getStructure();
    const view = registration.grid.ownerDocument.defaultView;
    if (
      sourceShape === undefined ||
      structure === undefined ||
      view === null ||
      event.button !== 0
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (this.pointer !== undefined) return;
    if (!isBrunoTableDragFillCellCountAllowed(sourceShape.sourceCellCount)) {
      this.notify({
        kind: "rejected",
        reason: "invalid-source",
        detail: `Fill sources may contain at most ${String(BRUNO_TABLE_DRAG_FILL_MAX_CELLS)} cells`,
      });
      return;
    }
    let source: BrunoTableDragFillSource | undefined;
    try {
      source =
        registration.captureSource?.() ??
        (isBrunoTableDragFillSource(sourceShape) ? sourceShape : undefined);
    } catch {
      source = undefined;
    }
    if (source === undefined || source.shapeIdentity !== sourceShape.shapeIdentity) {
      return;
    }
    const capturedCellCount =
      source.axis === "horizontal" ? source.columnIds.length : source.rowIds.length;
    const parallelIdentities = source.axis === "horizontal" ? source.columnIds : source.rowIds;
    const perpendicularIdentities = source.axis === "horizontal" ? source.rowIds : source.columnIds;
    if (
      capturedCellCount !== sourceShape.sourceCellCount ||
      source.canonicalTexts.length !== sourceShape.sourceCellCount ||
      parallelIdentities[0] !== sourceShape.sourceFirstIdentity ||
      parallelIdentities.at(-1) !== sourceShape.sourceLastIdentity ||
      perpendicularIdentities.length !== 1 ||
      perpendicularIdentities[0] !== sourceShape.perpendicularIdentity
    ) {
      this.notify({ kind: "rejected", reason: "invalid-source" });
      return;
    }
    const capturedSource = freezeSource(source);
    const gridBounds = registration.grid.getBoundingClientRect();
    const interactionGeometry = readInteractionGeometry(registration, gridBounds);
    const sourceAxis = capturedSource.canonicalTexts.length > 1 ? capturedSource.axis : undefined;
    const gesture =
      sourceAxis === undefined ? undefined : captureGesture(capturedSource, structure, sourceAxis);
    if (sourceAxis !== undefined && gesture === undefined) return;
    const pointer: PointerGesture = {
      pointerId: event.pointerId,
      grid: registration.grid,
      view,
      sourceShapeIdentity: source.shapeIdentity,
      source: capturedSource,
      contentEditableBeforeGesture: registration.grid.isContentEditable
        ? Object.freeze({ value: registration.grid.getAttribute("contenteditable") })
        : undefined,
      gridBounds,
      gridDirection: view.getComputedStyle(registration.grid).direction,
      interactionGeometry,
      structure,
      startX: event.clientX,
      startY: event.clientY,
      registration,
      clientX: event.clientX,
      clientY: event.clientY,
      eventTarget: event.target,
      frame: null,
      gesture,
      preview: undefined,
      projectedAxis: undefined,
      projectedTargetIdentity: undefined,
    };
    this.actor.send({
      type: "START",
      resources: {
        acquire: () => {
          this.pointer = pointer;
          if (pointer.contentEditableBeforeGesture !== undefined) {
            registration.grid.setAttribute("contenteditable", "false");
          }
          try {
            registration.grid.setPointerCapture(pointer.pointerId);
          } catch {
            // Synthetic pointer input may not have a native active pointer.
          }
          view.addEventListener("pointermove", this.onPointerMove, true);
          view.addEventListener("pointerup", this.onPointerUp, true);
          view.addEventListener("pointercancel", this.onPointerCancel, true);
          view.addEventListener("scroll", this.onAncestorScroll, true);
          view.addEventListener("resize", this.onEnvironmentResize);
        },
        release: () => this.releasePointer(pointer),
      },
    });
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const pointer = this.pointer;
    if (pointer === undefined || event.pointerId !== pointer.pointerId) return;
    event.preventDefault();
    pointer.clientX = event.clientX;
    pointer.clientY = event.clientY;
    pointer.eventTarget = event.target;
    this.schedulePointerFrame(pointer);
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    const pointer = this.pointer;
    if (pointer === undefined || event.pointerId !== pointer.pointerId) return;
    // A layout move can occur before its observer is delivered. Never commit using
    // the admission geometry after it has moved; this read is release-only.
    const currentBounds = pointer.grid.getBoundingClientRect();
    if (
      currentBounds.left !== pointer.gridBounds.left ||
      currentBounds.right !== pointer.gridBounds.right ||
      currentBounds.top !== pointer.gridBounds.top ||
      currentBounds.bottom !== pointer.gridBounds.bottom ||
      pointer.view.getComputedStyle(pointer.grid).direction !== pointer.gridDirection
    ) {
      this.cancel();
      return;
    }
    pointer.clientX = event.clientX;
    pointer.clientY = event.clientY;
    pointer.eventTarget = event.target;
    this.applyPointerFrame(pointer, false);
    const preview = pointer.preview;
    const rejectionEvidence =
      preview === undefined
        ? undefined
        : Object.freeze({
            ...(preview.axis === "horizontal"
              ? {
                  rowId: pointer.source.rowIds[0]!,
                  columnId: preview.extension.firstIdentity,
                }
              : {
                  rowId: preview.extension.firstIdentity,
                  columnId: pointer.source.columnIds[0]!,
                }),
            ...(preview.extension.length === 1
              ? {}
              : { additionalInvalidCount: preview.extension.length - 1 }),
          });
    this.actor.send({
      type: "RELEASE",
      ...(rejectionEvidence === undefined ? {} : { rejectionEvidence }),
      preflight: (): DragFillReleasePreflight => {
        if (preview === undefined) return Object.freeze({ kind: "cancelled" as const });
        if (!isBrunoTableDragFillCellCountAllowed(preview.extension.length)) {
          return Object.freeze({
            kind: "rejected" as const,
            rejection: Object.freeze({
              kind: "rejected" as const,
              reason: "invalid-target" as const,
              detail: `Fill destinations may contain at most ${String(BRUNO_TABLE_DRAG_FILL_MAX_CELLS)} cells`,
              ...rejectionEvidence,
            }),
          });
        }
        const gesture = pointer.gesture;
        const currentSource = pointer.registration.getSourceShape();
        const sourceCurrent = currentSource?.shapeIdentity === pointer.sourceShapeIdentity;
        const current = pointer.registration.getStructure();
        const perpendicularIdentity =
          preview.axis === "horizontal" ? pointer.source.rowIds[0] : pointer.source.columnIds[0];
        const perpendicularCurrent =
          current !== undefined &&
          perpendicularIdentity !== undefined &&
          (preview.axis === "horizontal"
            ? current.rowIndexById.has(perpendicularIdentity)
            : current.columnIndexById.has(perpendicularIdentity));
        const identities =
          current === undefined ? undefined : identitiesForAxis(current, preview.axis);
        const indexById = current === undefined ? undefined : indexForAxis(current, preview.axis);
        const candidates =
          !sourceCurrent ||
          !perpendicularCurrent ||
          gesture === undefined ||
          identities === undefined ||
          indexById === undefined
            ? undefined
            : materializeBrunoTableDragFillCandidates({
                gesture,
                preview,
                identities,
                indexById,
              });
        if (candidates === undefined) {
          return Object.freeze({
            kind: "rejected" as const,
            rejection: Object.freeze({
              kind: "rejected" as const,
              reason: "structure-changed" as const,
              ...rejectionEvidence,
            }),
          });
        }
        const cells = candidates.map(({ canonicalText, identity }) =>
          Object.freeze(
            preview.axis === "horizontal"
              ? { rowId: pointer.source.rowIds[0]!, columnId: identity, canonicalText }
              : { rowId: identity, columnId: pointer.source.columnIds[0]!, canonicalText },
          ),
        );
        const [first, ...rest] = cells;
        return first === undefined
          ? Object.freeze({
              kind: "rejected" as const,
              rejection: Object.freeze({ kind: "rejected" as const, reason: "empty" as const }),
            })
          : Object.freeze({
              kind: "ready" as const,
              cells: Object.freeze([first, ...rest]) as readonly [
                BrunoTableDragFillCell,
                ...BrunoTableDragFillCell[],
              ],
            });
      },
      apply: pointer.registration.apply,
      settle: (outcome) => {
        this.clearPreview();
        if (outcome.kind === "accepted") {
          this.clearNotification();
        } else if (outcome.kind === "rejected") {
          this.notify(outcome, pointer.registration.describeCoordinate);
        }
        this.scheduleReconcile();
      },
    });
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    if (event.pointerId === this.pointer?.pointerId) this.cancel();
  };

  private readonly onAncestorScroll = (event: Event): void => {
    const pointer = this.pointer;
    if (pointer === undefined || event.target === pointer.grid) return;
    const OwnerElement = pointer.grid.ownerDocument.defaultView?.Element;
    if (
      event.target === pointer.view ||
      event.target === pointer.grid.ownerDocument ||
      (OwnerElement !== undefined &&
        event.target instanceof OwnerElement &&
        event.target.contains(pointer.grid))
    )
      this.cancel();
  };

  private readonly onEnvironmentResize = (): void => {
    this.cancel();
  };

  private readonly schedulePointerFrame = (pointer: PointerGesture): void => {
    if (pointer.frame !== null) return;
    const shouldRecordFrame =
      __BRUNO_TABLE_TEST_DIAGNOSTICS__ &&
      this.tableId !== undefined &&
      hasBrunoTableClientDragFillFrameListener(this.tableId);
    const frame = pointer.view.requestAnimationFrame(() => {
      pointer.frame = null;
      if (this.pointer !== pointer) return;
      const startedAt = shouldRecordFrame ? performance.now() : 0;
      this.applyPointerFrame(pointer, true);
      if (shouldRecordFrame) {
        recordBrunoTableClientDragFillFrame(this.tableId!, {
          phase: "ran",
          frameId: frame,
          durationMs: performance.now() - startedAt,
        });
      }
    });
    pointer.frame = frame;
    if (shouldRecordFrame) {
      recordBrunoTableClientDragFillFrame(this.tableId!, { phase: "scheduled", frameId: frame });
    }
  };

  private readonly applyPointerFrame = (
    pointer: PointerGesture,
    allowAutoscroll: boolean,
  ): boolean => {
    const sourceAxis = pointer.source.canonicalTexts.length > 1 ? pointer.source.axis : undefined;
    const lockedAxis = this.actor.getSnapshot().context.axis;
    const axis = resolveBrunoTableDragFillAxis({
      dragSlop: DRAG_FILL_SLOP,
      horizontalDisplacement: pointer.clientX - pointer.startX,
      verticalDisplacement: pointer.clientY - pointer.startY,
      ...(lockedAxis === undefined ? {} : { lockedAxis }),
      ...(sourceAxis === undefined ? {} : { sourceAxis }),
    });
    if (axis === undefined) return false;
    pointer.gesture ??= captureGesture(pointer.source, pointer.structure, axis);
    if (pointer.gesture === undefined) return false;
    if (lockedAxis === undefined) this.actor.send({ type: "LOCK_AXIS", axis });
    const gridBounds = pointer.gridBounds;
    const geometry = allowAutoscroll ? pointer.interactionGeometry : undefined;
    let autoscrolled = false;
    if (geometry !== undefined) {
      const delta =
        axis === "horizontal"
          ? edgeDelta(
              pointer.clientX,
              geometry.centreLeft,
              geometry.centreRight,
              gridBounds.left,
              gridBounds.right,
            )
          : edgeDelta(
              pointer.clientY,
              geometry.bodyTop,
              geometry.bodyBottom,
              gridBounds.top,
              gridBounds.bottom,
            );
      if (delta !== 0) {
        // Queue the next pointer frame before native scrolling queues viewport publication.
        // This keeps the continuation ahead of DOM work for the newly visible window.
        this.schedulePointerFrame(pointer);
        try {
          autoscrolled =
            axis === "horizontal"
              ? pointer.registration.scrollHorizontalByPhysical(delta)
              : pointer.registration.scrollVerticalByLogical?.(delta) === true;
        } finally {
          if (!autoscrolled) this.cancelPointerFrame(pointer);
        }
      }
    }
    // A synchronous scroll publication may invalidate or dispose this gesture.
    if (this.pointer !== pointer) return autoscrolled;
    // Native scroll writes can flush pending styles. Hit-test and decorate only after
    // scrolling so preview work does not add layout cost to the synchronous scroll lane.
    const hit = hitAtPointer(
      pointer,
      gridBounds,
      allowAutoscroll ? "preview" : "release",
      geometry,
    );
    if (hit !== undefined) {
      const targetIdentity = axis === "horizontal" ? hit.columnId : hit.rowId;
      if (pointer.projectedAxis !== axis || pointer.projectedTargetIdentity !== targetIdentity) {
        pointer.projectedAxis = axis;
        pointer.projectedTargetIdentity = targetIdentity;
        pointer.preview = projectBrunoTableDragFillPreview({
          gesture: pointer.gesture,
          targetIdentity,
        });
        this.decoratePreview(pointer.preview);
      }
    } else if (pointer.preview === undefined) {
      pointer.projectedAxis = undefined;
      pointer.projectedTargetIdentity = undefined;
      this.clearPreview();
    }
    return autoscrolled;
  };

  private readonly placeHandle = (source: BrunoTableDragFillSourceShape | undefined): void => {
    const registration = this.registration;
    if (registration === undefined || source === undefined || this.pointer !== undefined) {
      this.removeHandle();
      return;
    }
    const cell = findMountedCell(registration.grid, source.handle);
    const host = cell?.querySelector<HTMLElement>(":scope > div.relative") ?? cell ?? undefined;
    if (host === undefined) {
      this.removeHandle();
      return;
    }
    if (this.handleHost === host && this.handle !== undefined) return;
    this.removeHandle();
    const handle = registration.grid.ownerDocument.createElement("span");
    const visual = registration.grid.ownerDocument.createElement("span");
    handle.dataset["brunoDragFillHandle"] = "";
    handle.setAttribute("aria-hidden", "true");
    Object.assign(handle.style, {
      blockSize: "24px",
      cursor: "crosshair",
      insetBlockEnd: "0",
      insetInlineEnd: "0",
      inlineSize: "24px",
      position: "absolute",
      touchAction: "none",
      zIndex: "12",
    });
    Object.assign(visual.style, {
      background: "Highlight",
      blockSize: "8px",
      border: "1px solid Canvas",
      boxSizing: "border-box",
      insetBlockEnd: "0",
      insetInlineEnd: "0",
      inlineSize: "8px",
      pointerEvents: "none",
      position: "absolute",
    });
    handle.append(visual);
    handle.addEventListener("pointerdown", this.start);
    host.append(handle);
    this.handle = handle;
    this.handleHost = host;
  };

  private readonly decoratePreview = (preview: BrunoTableDragFillPreview | undefined): void => {
    const pointer = this.pointer;
    if (pointer === undefined || preview === undefined) {
      this.clearPreview();
      return;
    }
    const perpendicularSource =
      preview.axis === "horizontal" ? pointer.source.rowIds[0] : pointer.source.columnIds[0];
    if (perpendicularSource === undefined) {
      this.clearPreview();
      return;
    }
    const nextCells = new Set<HTMLElement>();
    for (const cell of ownedMountedPreviewLaneCells(
      pointer.grid,
      preview.axis,
      perpendicularSource,
    )) {
      const rowId = cell.dataset["brunoRowId"];
      const columnId = cell.dataset["brunoColumnId"];
      if (rowId === undefined || columnId === undefined) continue;
      const parallelIdentity = preview.axis === "horizontal" ? columnId : rowId;
      const perpendicularIdentity = preview.axis === "horizontal" ? rowId : columnId;
      const index = pointer.gesture?.indexById.get(parallelIdentity);
      if (
        perpendicularIdentity !== perpendicularSource ||
        index === undefined ||
        index < preview.extension.startIndex ||
        index > preview.extension.endIndex
      ) {
        continue;
      }
      nextCells.add(cell);
      if (!this.previewCells.has(cell)) {
        cell.dataset["brunoDragFillPreview"] = "";
        cell.style.outline = "2px dashed Highlight";
        cell.style.outlineOffset = "-3px";
      }
    }
    for (const cell of this.previewCells) {
      if (nextCells.has(cell)) continue;
      delete cell.dataset["brunoDragFillPreview"];
      cell.style.removeProperty("outline");
      cell.style.removeProperty("outline-offset");
    }
    this.previewCells.clear();
    for (const cell of nextCells) this.previewCells.add(cell);
  };

  private readonly clearPreview = (): void => {
    for (const cell of this.previewCells) {
      delete cell.dataset["brunoDragFillPreview"];
      cell.style.removeProperty("outline");
      cell.style.removeProperty("outline-offset");
    }
    this.previewCells.clear();
  };

  private readonly notify = (
    rejection: Extract<BrunoTableDragFillApplyResult, { readonly kind: "rejected" }>,
    describeCoordinate?: (coordinate: BrunoTableCellCoordinate) => string,
  ): void => {
    const coordinate =
      rejection.rowId === undefined || rejection.columnId === undefined
        ? undefined
        : describeCoordinate?.({ rowId: rejection.rowId, columnId: rejection.columnId });
    const boundedCoordinate =
      coordinate === undefined ? undefined : boundDiagnosticText(coordinate, 160);
    const reason = boundDiagnosticText(
      rejection.detail ?? formatBrunoTableDragFillRejectionReason(rejection.reason),
      240,
    );
    const additional = rejection.additionalInvalidCount ?? 0;
    const terminatedReason = /[.!?…]$/u.test(reason) ? reason : `${reason}.`;
    const message = `${boundedCoordinate === undefined ? "" : `${boundedCoordinate}: `}${terminatedReason}${
      additional === 0 ? "" : ` (+${String(additional)} more)`
    } Nothing was applied.`;
    this.notificationStore.setState((previous) =>
      Object.freeze({ sequence: previous.sequence + 1, message }),
    );
  };

  private readonly scheduleReconcile = (): void => {
    const view = this.registration?.grid.ownerDocument.defaultView;
    if (view === null || view === undefined || this.reconcileFrame !== null) return;
    this.reconcileFrame = view.requestAnimationFrame(() => {
      this.reconcileFrame = null;
      this.reconcile();
    });
  };

  private readonly reconcilePointerStructure = (
    pointer: PointerGesture,
    structure: BrunoTableCellRangeStructure,
  ): boolean => {
    if (pointer.structure === structure) return true;
    const gesture = pointer.gesture;
    if (gesture === undefined) {
      if (
        !structure.rowIndexById.has(pointer.source.rowIds[0]!) ||
        !structure.columnIndexById.has(pointer.source.columnIds[0]!)
      ) {
        return false;
      }
      pointer.structure = structure;
      return true;
    }
    const perpendicularIdentity =
      gesture.axis === "horizontal" ? pointer.source.rowIds[0] : pointer.source.columnIds[0];
    const perpendicularCurrent =
      perpendicularIdentity !== undefined &&
      (gesture.axis === "horizontal"
        ? structure.rowIndexById.has(perpendicularIdentity)
        : structure.columnIndexById.has(perpendicularIdentity));
    if (!perpendicularCurrent) return false;
    const coherent = isBrunoTableDragFillGestureCoherent({
      gesture,
      preview: pointer.preview,
      identities: identitiesForAxis(structure, gesture.axis),
      indexById: indexForAxis(structure, gesture.axis),
    });
    if (coherent) {
      const rebasedGesture = captureGesture(pointer.source, structure, gesture.axis);
      if (rebasedGesture === undefined) return false;
      pointer.gesture = rebasedGesture;
      pointer.preview =
        pointer.projectedTargetIdentity === undefined
          ? undefined
          : projectBrunoTableDragFillPreview({
              gesture: rebasedGesture,
              targetIdentity: pointer.projectedTargetIdentity,
            });
      pointer.structure = structure;
    }
    return coherent;
  };

  private readonly cancelPointerFrame = (pointer: PointerGesture): void => {
    if (pointer.frame !== null) {
      pointer.view.cancelAnimationFrame(pointer.frame);
      if (
        __BRUNO_TABLE_TEST_DIAGNOSTICS__ &&
        this.tableId !== undefined &&
        hasBrunoTableClientDragFillFrameListener(this.tableId)
      ) {
        recordBrunoTableClientDragFillFrame(this.tableId, {
          phase: "cancelled",
          frameId: pointer.frame,
        });
      }
      pointer.frame = null;
    }
  };

  private readonly releasePointer = (pointer: PointerGesture): void => {
    try {
      this.cancelPointerFrame(pointer);
      pointer.view.removeEventListener("pointermove", this.onPointerMove, true);
      pointer.view.removeEventListener("pointerup", this.onPointerUp, true);
      pointer.view.removeEventListener("pointercancel", this.onPointerCancel, true);
      pointer.view.removeEventListener("scroll", this.onAncestorScroll, true);
      pointer.view.removeEventListener("resize", this.onEnvironmentResize);
      try {
        if (pointer.grid.hasPointerCapture(pointer.pointerId)) {
          pointer.grid.releasePointerCapture(pointer.pointerId);
        }
      } catch {
        // Synthetic pointer input may not own native pointer capture.
      }
    } finally {
      if (pointer.contentEditableBeforeGesture !== undefined) {
        const prior = pointer.contentEditableBeforeGesture.value;
        if (prior === null) pointer.grid.removeAttribute("contenteditable");
        else pointer.grid.setAttribute("contenteditable", prior);
      }
      if (this.pointer === pointer) this.pointer = undefined;
    }
  };

  private readonly removeHandle = (): void => {
    this.handle?.removeEventListener("pointerdown", this.start);
    this.handle?.remove();
    this.handle = undefined;
    this.handleHost = undefined;
  };

  private readonly unregister = (): void => {
    this.invalidate();
    this.observer?.disconnect();
    this.observer = undefined;
    const view = this.registration?.grid.ownerDocument.defaultView;
    if (this.reconcileFrame !== null && view !== null && view !== undefined) {
      view.cancelAnimationFrame(this.reconcileFrame);
    }
    this.reconcileFrame = null;
    this.clearPreview();
    this.removeHandle();
    this.registration = undefined;
  };
}

function captureGesture(
  source: BrunoTableDragFillSource,
  structure: BrunoTableCellRangeStructure,
  axis: BrunoTableCellRangeAxis,
): BrunoTableDragFillGesture | undefined {
  const identities = identitiesForAxis(structure, axis);
  const indexById = indexForAxis(structure, axis);
  const sourceIdentities = axis === "horizontal" ? source.columnIds : source.rowIds;
  return captureBrunoTableDragFillGesture({
    axis,
    identities,
    indexById,
    sourceCanonicalTexts: source.canonicalTexts,
    sourceFirstIdentity: sourceIdentities[0]!,
    sourceLastIdentity: sourceIdentities.at(-1)!,
  });
}

function identitiesForAxis(
  structure: BrunoTableCellRangeStructure,
  axis: BrunoTableCellRangeAxis,
): readonly string[] {
  return axis === "horizontal" ? structure.columnIds : structure.rowIds;
}

function indexForAxis(
  structure: BrunoTableCellRangeStructure,
  axis: BrunoTableCellRangeAxis,
): ReadonlyMap<string, number> {
  return axis === "horizontal" ? structure.columnIndexById : structure.rowIndexById;
}

function freezeSource(source: BrunoTableDragFillSource): BrunoTableDragFillSource {
  return Object.freeze({
    shapeIdentity: source.shapeIdentity,
    axis: source.axis,
    sourceCellCount: source.sourceCellCount,
    sourceFirstIdentity: source.sourceFirstIdentity,
    sourceLastIdentity: source.sourceLastIdentity,
    perpendicularIdentity: source.perpendicularIdentity,
    rowIds: Object.freeze([...source.rowIds]) as NonEmptyStrings,
    columnIds: Object.freeze([...source.columnIds]) as NonEmptyStrings,
    canonicalTexts: Object.freeze([...source.canonicalTexts]) as NonEmptyStrings,
    handle: Object.freeze({ ...source.handle }),
  });
}

function isBrunoTableDragFillSource(
  source: BrunoTableDragFillSourceShape | undefined,
): source is BrunoTableDragFillSource {
  return source !== undefined && "canonicalTexts" in source;
}

function sameProjection(
  left: BrunoTableDragFillProjection,
  right: BrunoTableDragFillProjection,
): boolean {
  return left.active === right.active && left.axis === right.axis;
}

function hitAtPointer(
  pointer: PointerGesture,
  bounds: DOMRectReadOnly,
  phase: "preview" | "release",
  outsideSamplingGeometry?: BrunoTableDragFillInteractionGeometry,
) {
  const outside =
    pointer.clientX < bounds.left ||
    pointer.clientX > bounds.right ||
    pointer.clientY < bounds.top ||
    pointer.clientY > bounds.bottom;
  let clientX = pointer.clientX;
  let clientY = pointer.clientY;
  if (outside) {
    if (outsideSamplingGeometry === undefined) return undefined;
    clientX = clampInside(
      pointer.clientX,
      outsideSamplingGeometry.centreLeft,
      outsideSamplingGeometry.centreRight,
    );
    clientY = clampInside(
      pointer.clientY,
      outsideSamplingGeometry.bodyTop,
      outsideSamplingGeometry.bodyBottom,
    );
  }
  const logicalHit = pointer.registration.resolvePointerHit?.(clientX, clientY, phase);
  if (logicalHit !== undefined) return logicalHit;
  const target =
    pointer.grid.ownerDocument.elementFromPoint?.(clientX, clientY) ??
    (pointer.eventTarget instanceof Element ? pointer.eventTarget : null);
  const hit = brunoTableCellRangePointerHit(target, pointer.grid);
  if (hit !== undefined) pointer.eventTarget = target;
  return hit;
}

function clampInside(value: number, start: number, end: number): number {
  if (end - start <= 2) return start + (end - start) / 2;
  return Math.max(start + 1, Math.min(value, end - 1));
}

function edgeDelta(
  position: number,
  start: number,
  end: number,
  outerStart: number,
  outerEnd: number,
): number {
  if (end <= start) return 0;
  if (position < start) return position < outerStart ? -DRAG_FILL_AUTOSCROLL_STEP : 0;
  if (position > end) return position > outerEnd ? DRAG_FILL_AUTOSCROLL_STEP : 0;
  return position < start + DRAG_FILL_AUTOSCROLL_ZONE
    ? -DRAG_FILL_AUTOSCROLL_STEP
    : position > end - DRAG_FILL_AUTOSCROLL_ZONE
      ? DRAG_FILL_AUTOSCROLL_STEP
      : 0;
}

function readInteractionGeometry(
  registration: DragFillRegistration,
  fallback: DOMRectReadOnly,
): BrunoTableDragFillInteractionGeometry {
  const geometry = registration.interactionGeometry?.();
  if (
    geometry !== undefined &&
    Number.isFinite(geometry.bodyTop) &&
    Number.isFinite(geometry.bodyBottom) &&
    Number.isFinite(geometry.centreLeft) &&
    Number.isFinite(geometry.centreRight) &&
    geometry.bodyBottom > geometry.bodyTop &&
    geometry.centreRight >= geometry.centreLeft
  ) {
    return geometry;
  }
  return Object.freeze({
    bodyTop: fallback.top,
    bodyBottom: fallback.bottom,
    centreLeft: fallback.left,
    centreRight: fallback.right,
  });
}

function ownedMountedCells(grid: HTMLElement): readonly HTMLElement[] {
  return [
    ...grid.querySelectorAll<HTMLElement>(
      '[role="gridcell"][data-bruno-row-id][data-bruno-column-id]',
    ),
  ].filter((cell) => cell.closest('[role="grid"]') === grid);
}

function ownedMountedPreviewLaneCells(
  grid: HTMLElement,
  axis: BrunoTableCellRangeAxis,
  perpendicularIdentity: string,
): readonly HTMLElement[] {
  const cssEscape = grid.ownerDocument.defaultView?.CSS.escape;
  if (cssEscape === undefined) return ownedMountedCells(grid);
  const attribute = axis === "horizontal" ? "data-bruno-row-id" : "data-bruno-column-id";
  return [
    ...grid.querySelectorAll<HTMLElement>(
      `[role="gridcell"][${attribute}="${cssEscape(perpendicularIdentity)}"]`,
    ),
  ].filter((cell) => cell.closest('[role="grid"]') === grid);
}

function findMountedCell(
  grid: HTMLElement,
  coordinate: BrunoTableCellCoordinate,
): HTMLElement | undefined {
  const matches = ownedMountedCells(grid).filter(
    (cell) =>
      cell.dataset["brunoRowId"] === coordinate.rowId &&
      cell.dataset["brunoColumnId"] === coordinate.columnId,
  );
  const topmost = matches.find((cell) => isTopmostMountedCell(grid, cell));
  if (topmost !== undefined) return topmost;
  return (
    matches.find((cell) => cell.closest("[data-bruno-pinned-body-region]") !== null) ?? matches[0]
  );
}

function isTopmostMountedCell(grid: HTMLElement, cell: HTMLElement): boolean {
  const rect = cell.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const target = grid.ownerDocument.elementFromPoint?.(x, y);
  return target !== null && target !== undefined && cell.contains(target);
}

export function formatBrunoTableDragFillRejectionReason(
  reason: BrunoTableDragFillRejectionReason,
): string {
  switch (reason) {
    case "structure-changed":
      return "The fill destination changed before release.";
    case "temporarily-unavailable":
      return "Editing is temporarily unavailable.";
    case "invalid-target":
      return "The fill target is invalid.";
    case "save-locked":
      return "This destination cell is saving.";
    case "unavailable":
      return "This destination cell is unavailable.";
    case "stale":
      return "Resolve this cell's stale conflict before filling.";
    case "blocked":
      return "Resolve this cell's blocked edit before filling.";
    case "row-version":
      return "This destination row has no usable Row Version.";
    case "invalid-source":
      return "The source value is invalid.";
    case "read-only":
      return "This destination cell is read-only.";
    case "invalid-value":
      return "A repeated value is invalid for its destination.";
    case "empty":
      return "The fill target is empty.";
  }
}

function boundDiagnosticText(text: string, maximum: number): string {
  const normalized = text.trim().replaceAll(/\s+/g, " ");
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`;
}
