import { describe, expect, it, vi } from "vitest";

import { createBrunoTableColumnGestureActor } from "./column-gesture";

describe("BrunoTable column gesture workflow", () => {
  it("accepts only one active lifecycle and clears its kind on completion", () => {
    const actor = createBrunoTableColumnGestureActor();
    const projectionListener = vi.fn();
    const unsubscribe = actor.subscribe(projectionListener);
    actor.start();

    expect(actor.getSnapshot().value).toBe("idle");
    expect(actor.getSnapshot().kind).toBe(undefined);
    expect(projectionListener).toHaveBeenCalledTimes(1);
    actor.send({ type: "START", kind: "reorder" });
    expect(actor.getSnapshot().value).toBe("active");
    expect(actor.getSnapshot().kind).toBe("reorder");

    actor.send({ type: "START", kind: "resize" });
    expect(actor.getSnapshot().value).toBe("active");
    expect(actor.getSnapshot().kind).toBe("reorder");
    actor.send({ type: "COMMIT" });
    expect(actor.getSnapshot().value).toBe("idle");
    expect(actor.getSnapshot().kind).toBe(undefined);

    actor.send({ type: "START", kind: "resize" });
    expect(actor.getSnapshot().kind).toBe("resize");
    actor.send({ type: "CANCEL" });
    expect(actor.getSnapshot().value).toBe("idle");
    expect(actor.getSnapshot().kind).toBe(undefined);

    actor.send({ type: "START", kind: "reorder" });
    expect(actor.getSnapshot().kind).toBe("reorder");
    actor.send({ type: "INVALIDATE" });
    expect(actor.getSnapshot().value).toBe("idle");
    expect(actor.getSnapshot().kind).toBe(undefined);

    actor.send({ type: "CANCEL" });
    expect(actor.getSnapshot().value).toBe("idle");
    expect(actor.getSnapshot().kind).toBe(undefined);
    actor.stop();
    expect(actor.getSnapshot().status).toBe("stopped");
    actor.start();
    expect(actor.getSnapshot().status).toBe("active");
    expect(actor.getSnapshot().value).toBe("idle");
    unsubscribe();
  });
});
