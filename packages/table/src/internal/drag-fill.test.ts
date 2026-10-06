import { describe, expect, it, vi } from "vitest";

import {
  BRUNO_TABLE_DRAG_FILL_MAX_CELLS,
  createBrunoTableDragFillActor,
  formatBrunoTableDragFillRejectionReason,
  isBrunoTableDragFillCellCountAllowed,
  type BrunoTableDragFillRejectionReason,
} from "./drag-fill";

describe("BrunoTable Drag Fill bounds", () => {
  it("admits the exact transaction limit and rejects the next cell", () => {
    expect(isBrunoTableDragFillCellCountAllowed(BRUNO_TABLE_DRAG_FILL_MAX_CELLS)).toBe(true);
    expect(isBrunoTableDragFillCellCountAllowed(BRUNO_TABLE_DRAG_FILL_MAX_CELLS + 1)).toBe(false);
  });
});

const rejectionMessageByReason = {
  "structure-changed": "The fill destination changed before release.",
  "temporarily-unavailable": "Editing is temporarily unavailable.",
  "invalid-target": "The fill target is invalid.",
  "save-locked": "This destination cell is saving.",
  unavailable: "This destination cell is unavailable.",
  stale: "Resolve this cell's stale conflict before filling.",
  blocked: "Resolve this cell's blocked edit before filling.",
  "row-version": "This destination row has no usable Row Version.",
  "invalid-source": "The source value is invalid.",
  "read-only": "This destination cell is read-only.",
  "invalid-value": "A repeated value is invalid for its destination.",
  empty: "The fill target is empty.",
} as const satisfies Readonly<Record<BrunoTableDragFillRejectionReason, string>>;
const rejectionMessages = Object.entries(rejectionMessageByReason) as Array<
  [BrunoTableDragFillRejectionReason, string]
>;

describe("BrunoTable Drag Fill rejection diagnostics", () => {
  it.each(rejectionMessages)("maps %s to an exact Fill reason", (reason, message) => {
    expect(formatBrunoTableDragFillRejectionReason(reason)).toBe(message);
  });

  it("distinguishes a stale edit conflict from a structural race", () => {
    expect(formatBrunoTableDragFillRejectionReason("stale")).toContain("stale conflict");
    expect(formatBrunoTableDragFillRejectionReason("stale")).not.toContain(
      "changed before release",
    );
    expect(formatBrunoTableDragFillRejectionReason("structure-changed")).toContain(
      "changed before release",
    );
  });
});

describe("BrunoTable Drag Fill workflow", () => {
  it("preflights and applies one release before accepting it", () => {
    const acquire = vi.fn();
    const release = vi.fn();
    const apply = vi.fn(() => ({ kind: "accepted" as const }));
    const settle = vi.fn();
    const actor = createBrunoTableDragFillActor();
    actor.start();
    actor.send({ type: "START", resources: { acquire, release } });
    actor.send({ type: "LOCK_AXIS", axis: "horizontal" });

    actor.send({
      type: "RELEASE",
      preflight: () => ({
        kind: "ready",
        cells: [{ rowId: "row-a", columnId: "score-3", canonicalText: "3" }],
      }),
      apply,
      settle,
    });

    expect(actor.getSnapshot().value).toBe("accepted");
    expect(acquire).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith([
      { rowId: "row-a", columnId: "score-3", canonicalText: "3" },
    ]);
    expect(settle).toHaveBeenCalledWith({ kind: "accepted" });
    actor.stop();
  });

  it("settles a fully unchanged release as a silent no-op", () => {
    const release = vi.fn();
    const apply = vi.fn(() => ({ kind: "unchanged" as const }));
    const settle = vi.fn();
    const actor = createBrunoTableDragFillActor();
    actor.start();
    actor.send({ type: "START", resources: { acquire: () => undefined, release } });

    actor.send({
      type: "RELEASE",
      preflight: () => ({
        kind: "ready",
        cells: [
          { rowId: "row-a", columnId: "score-3", canonicalText: "3" },
          { rowId: "row-a", columnId: "score-4", canonicalText: "4" },
        ],
      }),
      apply,
      settle,
    });

    expect(actor.getSnapshot().value).toBe("unchanged");
    expect(apply).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledWith({ kind: "unchanged" });
    expect(release).toHaveBeenCalledOnce();
    actor.stop();
  });

  it("rejects a failed release preflight without applying a valid prefix", () => {
    const release = vi.fn();
    const apply = vi.fn(() => ({ kind: "accepted" as const }));
    const settle = vi.fn();
    const actor = createBrunoTableDragFillActor();
    actor.start();
    actor.send({ type: "START", resources: { acquire: () => undefined, release } });
    actor.send({ type: "LOCK_AXIS", axis: "vertical" });

    actor.send({
      type: "RELEASE",
      preflight: () => ({
        kind: "rejected",
        rejection: { kind: "rejected", reason: "structure-changed" },
      }),
      apply,
      settle,
    });

    expect(actor.getSnapshot().value).toBe("rejected");
    expect(apply).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledWith({ kind: "rejected", reason: "structure-changed" });
    expect(release).toHaveBeenCalledOnce();
    actor.stop();
  });

  it("cancels and invalidates active gestures through one resource-release path", () => {
    const cancelRelease = vi.fn();
    const invalidateRelease = vi.fn();
    const actor = createBrunoTableDragFillActor();
    actor.start();

    actor.send({
      type: "START",
      resources: { acquire: () => undefined, release: cancelRelease },
    });
    actor.send({ type: "CANCEL" });
    expect(actor.getSnapshot().value).toBe("cancelled");
    expect(cancelRelease).toHaveBeenCalledOnce();

    actor.send({
      type: "START",
      resources: { acquire: () => undefined, release: invalidateRelease },
    });
    actor.send({ type: "INVALIDATE" });
    expect(actor.getSnapshot().value).toBe("cancelled");
    expect(invalidateRelease).toHaveBeenCalledOnce();
    actor.stop();
  });

  it("treats release without a projected extension as cancelled", () => {
    const preflight = vi.fn(() => ({ kind: "cancelled" as const }));
    const apply = vi.fn();
    const settle = vi.fn();
    const release = vi.fn();
    const actor = createBrunoTableDragFillActor();
    actor.start();
    actor.send({ type: "START", resources: { acquire: () => undefined, release } });

    actor.send({ type: "RELEASE", preflight, apply, settle });

    expect(actor.getSnapshot().value).toBe("cancelled");
    expect(preflight).toHaveBeenCalledOnce();
    expect(apply).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledWith({ kind: "cancelled" });
    expect(release).toHaveBeenCalledOnce();
    actor.stop();
  });

  it("maps an apply exception to one temporarily-unavailable rejection", () => {
    const settle = vi.fn();
    const actor = createBrunoTableDragFillActor();
    actor.start();
    actor.send({
      type: "START",
      resources: { acquire: () => undefined, release: () => undefined },
    });
    actor.send({ type: "LOCK_AXIS", axis: "horizontal" });

    actor.send({
      type: "RELEASE",
      preflight: () => ({
        kind: "ready",
        cells: [
          { rowId: "row-a", columnId: "score-3", canonicalText: "3" },
          { rowId: "row-a", columnId: "score-4", canonicalText: "4" },
        ],
      }),
      apply: () => {
        throw new Error("application boundary failed");
      },
      settle,
    });

    expect(actor.getSnapshot().value).toBe("rejected");
    expect(settle).toHaveBeenCalledWith({
      kind: "rejected",
      reason: "temporarily-unavailable",
      rowId: "row-a",
      columnId: "score-3",
      additionalInvalidCount: 1,
    });
    actor.stop();
  });

  it("maps a preflight exception to one temporarily-unavailable rejection", () => {
    const apply = vi.fn(() => ({ kind: "accepted" as const }));
    const settle = vi.fn();
    const release = vi.fn();
    const actor = createBrunoTableDragFillActor();
    actor.start();
    actor.send({ type: "START", resources: { acquire: () => undefined, release } });

    actor.send({
      type: "RELEASE",
      rejectionEvidence: {
        rowId: "row-a",
        columnId: "score-3",
        additionalInvalidCount: 1,
      },
      preflight: () => {
        throw new Error("preflight boundary failed");
      },
      apply,
      settle,
    });

    expect(actor.getSnapshot().value).toBe("rejected");
    expect(apply).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledWith({
      kind: "rejected",
      reason: "temporarily-unavailable",
      rowId: "row-a",
      columnId: "score-3",
      additionalInvalidCount: 1,
    });
    expect(release).toHaveBeenCalledOnce();
    actor.stop();
  });

  it("locks the gesture axis only once", () => {
    const actor = createBrunoTableDragFillActor();
    actor.start();
    actor.send({
      type: "START",
      resources: { acquire: () => undefined, release: () => undefined },
    });

    actor.send({ type: "LOCK_AXIS", axis: "horizontal" });
    actor.send({ type: "LOCK_AXIS", axis: "vertical" });

    expect(actor.getSnapshot().context.axis).toBe("horizontal");
    actor.send({ type: "CANCEL" });
    actor.stop();
  });
});
