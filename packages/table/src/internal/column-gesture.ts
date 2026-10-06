import { Store } from "@tanstack/store";
import { assign, createActor, createMachine } from "xstate";

export type BrunoTableColumnGestureKind = "resize" | "reorder";

type BrunoTableColumnGestureEvent =
  | Readonly<{
      readonly type: "START";
      readonly kind: BrunoTableColumnGestureKind;
    }>
  | Readonly<{ readonly type: "COMMIT" }>
  | Readonly<{ readonly type: "CANCEL" }>
  | Readonly<{ readonly type: "INVALIDATE" }>;

type BrunoTableColumnGestureContext = Readonly<{
  readonly kind: BrunoTableColumnGestureKind | undefined;
}>;

const brunoTableColumnGestureMachine = createMachine({
  id: "brunoTableColumnGesture",
  initial: "idle",
  types: {} as {
    context: BrunoTableColumnGestureContext;
    events: BrunoTableColumnGestureEvent;
  },
  context: { kind: undefined },
  states: {
    idle: {
      on: {
        START: {
          target: "active",
          actions: assign({ kind: ({ event }) => event.kind }),
        },
      },
    },
    active: {
      on: {
        COMMIT: { target: "idle", actions: assign({ kind: undefined }) },
        CANCEL: { target: "idle", actions: assign({ kind: undefined }) },
        INVALIDATE: { target: "idle", actions: assign({ kind: undefined }) },
      },
    },
  },
});

export type BrunoTableColumnGestureSnapshot = Readonly<{
  readonly value: "idle" | "active";
  readonly status: "active" | "done" | "error" | "stopped";
  readonly kind: BrunoTableColumnGestureKind | undefined;
}>;

export type BrunoTableColumnGestureActor = Readonly<{
  readonly start: () => void;
  readonly stop: () => void;
  readonly send: (event: BrunoTableColumnGestureEvent) => void;
  readonly getSnapshot: () => BrunoTableColumnGestureSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
}>;

export function createBrunoTableColumnGestureActor(): BrunoTableColumnGestureActor {
  let actor = createActor(brunoTableColumnGestureMachine);
  const initialSnapshot = Object.freeze({
    value: "idle" as const,
    status: "stopped" as const,
    kind: undefined,
  });
  const projection = new Store<BrunoTableColumnGestureSnapshot>(initialSnapshot);
  let started = false;
  let stopped = false;
  const readProjection = (): BrunoTableColumnGestureSnapshot => {
    const snapshot = actor.getSnapshot();
    return Object.freeze({
      value: snapshot.value === "active" ? "active" : "idle",
      status: snapshot.status,
      kind: snapshot.context.kind,
    });
  };
  const publishProjection = (): void => {
    const next = readProjection();
    const previous = projection.get();
    if (
      previous.value === next.value &&
      previous.status === next.status &&
      previous.kind === next.kind
    ) {
      return;
    }
    projection.setState(() => next);
  };
  let actorSubscription = actor.subscribe(publishProjection);
  return Object.freeze({
    start: () => {
      if (!started) {
        if (stopped) {
          actorSubscription.unsubscribe();
          actor = createActor(brunoTableColumnGestureMachine);
          actorSubscription = actor.subscribe(publishProjection);
          stopped = false;
        }
        started = true;
        actor.start();
      }
      publishProjection();
    },
    stop: () => {
      if (started) {
        started = false;
        stopped = true;
        actor.stop();
      }
      publishProjection();
    },
    send: (event: BrunoTableColumnGestureEvent) => {
      if (!started) return;
      actor.send(event);
      publishProjection();
    },
    getSnapshot: () => {
      return projection.get();
    },
    subscribe: (listener) => {
      const subscription = projection.subscribe(listener);
      return () => subscription.unsubscribe();
    },
  });
}
