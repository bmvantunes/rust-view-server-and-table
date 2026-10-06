import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { createBrunoTableCellRangeStructure } from "./cell-range-clipboard";
import { BrunoTableDragFillChrome } from "./drag-fill-chrome";
import {
  BRUNO_TABLE_DRAG_FILL_MAX_CELLS,
  BrunoTableDragFillRuntime,
  addBrunoTableDragFillRejectionEvidence,
  type BrunoTableDragFillSource,
} from "./drag-fill";
import {
  type BrunoTableDragFillFrameEvent,
  installBrunoTableClientDragFillFrameListener,
} from "./render-instrumentation";

const ownedRuntimes = new Set<BrunoTableDragFillRuntime>();

afterEach(async () => {
  vi.restoreAllMocks();
  for (const runtime of ownedRuntimes) runtime.dispose();
  ownedRuntimes.clear();
  await cleanup();
  document.querySelectorAll('[data-drag-fill-runtime-fixture=""]').forEach((fixture) => {
    fixture.remove();
  });
});

function createGrid(columnIds: readonly string[], mountedColumnIds = columnIds) {
  const grid = document.createElement("div");
  grid.dataset["dragFillRuntimeFixture"] = "";
  grid.setAttribute("role", "grid");
  grid.style.display = "flex";
  grid.style.height = "40px";
  grid.style.overflow = "auto";
  grid.style.width = "240px";
  for (const columnId of mountedColumnIds) {
    const cell = document.createElement("div");
    cell.setAttribute("role", "gridcell");
    cell.dataset["brunoRowId"] = "ROW_ID_1";
    cell.dataset["brunoColumnId"] = columnId;
    cell.dataset["brunoRowIndex"] = "0";
    cell.style.flex = "0 0 80px";
    cell.style.height = "32px";
    cell.style.position = "relative";
    const content = document.createElement("div");
    content.className = "relative";
    content.style.height = "100%";
    content.textContent = columnId;
    cell.append(content);
    grid.append(cell);
  }
  document.body.append(grid);
  const structure = createBrunoTableCellRangeStructure(["ROW_ID_1"], columnIds);
  return { grid, structure };
}

const horizontalSourceSnapshots = new Map<string, BrunoTableDragFillSource>();
const verticalSourceSnapshots = new Map<string, BrunoTableDragFillSource>();
const horizontalSourceShapeIdentities = new Map<string, object>();
const verticalSourceShapeIdentities = new Map<string, object>();

function source(
  columnIds: readonly [string, ...string[]],
  canonicalTexts: readonly [string, ...string[]],
): BrunoTableDragFillSource {
  const shapeKey = columnIds.join("\u0000");
  const key = `${shapeKey}\u0001${canonicalTexts.join("\u0000")}`;
  const current = horizontalSourceSnapshots.get(key);
  if (current !== undefined) return current;
  const shapeIdentity = horizontalSourceShapeIdentities.get(shapeKey) ?? Object.freeze({});
  horizontalSourceShapeIdentities.set(shapeKey, shapeIdentity);
  const snapshot = Object.freeze({
    shapeIdentity,
    axis: "horizontal",
    sourceCellCount: columnIds.length,
    sourceFirstIdentity: columnIds[0],
    sourceLastIdentity: columnIds.at(-1)!,
    perpendicularIdentity: "ROW_ID_1",
    rowIds: Object.freeze(["ROW_ID_1"]) as readonly [string],
    columnIds: Object.freeze([...columnIds]) as readonly [string, ...string[]],
    canonicalTexts: Object.freeze([...canonicalTexts]) as readonly [string, ...string[]],
    handle: Object.freeze({ rowId: "ROW_ID_1", columnId: columnIds.at(-1)! }),
  });
  horizontalSourceSnapshots.set(key, snapshot);
  return snapshot;
}

function createVerticalGrid(rowIds: readonly string[], mountedRowIds = rowIds) {
  const grid = document.createElement("div");
  grid.dataset["dragFillRuntimeFixture"] = "";
  grid.setAttribute("role", "grid");
  grid.style.height = "72px";
  grid.style.overflow = "auto";
  grid.style.width = "100px";
  for (const [rowIndex, rowId] of rowIds.entries()) {
    if (!mountedRowIds.includes(rowId)) continue;
    const cell = document.createElement("div");
    cell.setAttribute("role", "gridcell");
    cell.dataset["brunoRowId"] = rowId;
    cell.dataset["brunoColumnId"] = "COL_ID_A";
    cell.dataset["brunoRowIndex"] = String(rowIndex);
    cell.style.height = "32px";
    cell.style.position = "relative";
    cell.style.width = "80px";
    const content = document.createElement("div");
    content.className = "relative";
    content.style.height = "100%";
    content.textContent = rowId;
    cell.append(content);
    grid.append(cell);
  }
  document.body.append(grid);
  const structure = createBrunoTableCellRangeStructure(rowIds, ["COL_ID_A"]);
  return { grid, structure };
}

function verticalSource(
  rowIds: readonly [string, ...string[]],
  canonicalTexts: readonly [string, ...string[]],
): BrunoTableDragFillSource {
  const shapeKey = rowIds.join("\u0000");
  const key = `${shapeKey}\u0001${canonicalTexts.join("\u0000")}`;
  const current = verticalSourceSnapshots.get(key);
  if (current !== undefined) return current;
  const shapeIdentity = verticalSourceShapeIdentities.get(shapeKey) ?? Object.freeze({});
  verticalSourceShapeIdentities.set(shapeKey, shapeIdentity);
  const snapshot = Object.freeze({
    shapeIdentity,
    axis: "vertical",
    sourceCellCount: rowIds.length,
    sourceFirstIdentity: rowIds[0],
    sourceLastIdentity: rowIds.at(-1)!,
    perpendicularIdentity: "COL_ID_A",
    rowIds: Object.freeze([...rowIds]) as readonly [string, ...string[]],
    columnIds: Object.freeze(["COL_ID_A"]) as readonly [string],
    canonicalTexts: Object.freeze([...canonicalTexts]) as readonly [string, ...string[]],
    handle: Object.freeze({ rowId: rowIds.at(-1)!, columnId: "COL_ID_A" }),
  });
  verticalSourceSnapshots.set(key, snapshot);
  return snapshot;
}

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function centerOf(element: Element): Readonly<{ x: number; y: number }> {
  const bounds = element.getBoundingClientRect();
  return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
}

function pointer(
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  pointerId: number,
  point: Readonly<{ x: number; y: number }>,
): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    button: 0,
    cancelable: true,
    clientX: point.x,
    clientY: point.y,
    pointerId,
  });
}

describe("BrunoTable Drag Fill browser runtime", () => {
  test("stops post-scroll hit testing when a synchronous scroll callback cancels the gesture", async () => {
    const { grid, structure } = createGrid(["COL_ID_A", "COL_ID_B", "COL_ID_C"]);
    const editableOwner = document.createElement("div");
    editableOwner.dataset["dragFillRuntimeFixture"] = "";
    editableOwner.setAttribute("contenteditable", "plaintext-only");
    editableOwner.append(grid);
    document.body.append(editableOwner);
    grid.removeAttribute("contenteditable");
    expect(grid.isContentEditable).toBe(true);
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    const resolvePointerHit = vi.fn(() => ({ rowId: "ROW_ID_1", columnId: "COL_ID_C" }));
    const scrollHorizontalByPhysical = vi.fn(() => {
      runtime.cancel();
      return true;
    });
    const gridBounds = grid.getBoundingClientRect();
    runtime.register({
      grid,
      getSourceShape: () => source(["COL_ID_A"], ["stable"]),
      getStructure: () => structure,
      resolvePointerHit,
      interactionGeometry: () => ({
        bodyTop: gridBounds.top,
        bodyBottom: gridBounds.bottom,
        centreLeft: gridBounds.left,
        centreRight: gridBounds.right,
      }),
      scrollHorizontalByPhysical,
      apply: () => Object.freeze({ kind: "accepted" as const }),
    });
    await nextFrame();

    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    const y = centerOf(handle).y;
    handle.dispatchEvent(pointer("pointerdown", 191, centerOf(handle)));
    expect(grid.getAttribute("contenteditable")).toBe("false");
    grid.dispatchEvent(pointer("pointermove", 191, { x: gridBounds.right - 1, y }));
    await nextFrame();

    expect(scrollHorizontalByPhysical).toHaveBeenCalledOnce();
    expect(resolvePointerHit).not.toHaveBeenCalled();
    expect(grid.querySelectorAll("[data-bruno-drag-fill-preview]")).toHaveLength(0);
    expect(grid.getAttribute("contenteditable")).toBeNull();
    expect(grid.isContentEditable).toBe(true);
  });

  test("cancels an iframe fill when an owner-realm ancestor scrolls", async () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    try {
      const ownerDocument = frame.contentDocument!;
      const ownerView = ownerDocument.defaultView!;
      const ownerFrame = () =>
        new Promise<void>((resolve) => ownerView.requestAnimationFrame(() => resolve()));
      const fixture = createGrid(["COL_ID_A", "COL_ID_B", "COL_ID_C"]);
      const grid = ownerDocument.importNode(fixture.grid, true);
      fixture.grid.remove();
      const ancestor = ownerDocument.createElement("div");
      ancestor.append(grid);
      ownerDocument.body.append(ancestor);
      const apply = vi.fn(() => Object.freeze({ kind: "accepted" as const }));
      runtime.register({
        grid,
        getSourceShape: () => source(["COL_ID_A"], ["stable"]),
        getStructure: () => fixture.structure,
        apply,
        scrollHorizontalByPhysical: () => false,
        describeCoordinate: ({ rowId, columnId }) => `${rowId}/${columnId}`,
      });
      await ownerFrame();
      await ownerFrame();
      const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
      const target = grid.querySelector<HTMLElement>('[data-bruno-column-id="COL_ID_C"]')!;
      handle.dispatchEvent(pointer("pointerdown", 190, centerOf(handle)));
      target.dispatchEvent(pointer("pointermove", 190, centerOf(target)));
      await ownerFrame();
      expect(grid.querySelectorAll("[data-bruno-drag-fill-preview]").length).toBeGreaterThan(0);
      ancestor.dispatchEvent(new Event("scroll"));
      expect(grid.querySelectorAll("[data-bruno-drag-fill-preview]")).toHaveLength(0);
      ownerView.dispatchEvent(pointer("pointerup", 190, centerOf(target)));
      expect(apply).not.toHaveBeenCalled();
    } finally {
      runtime.dispose();
      frame.remove();
    }
  });

  test("previews only mounted cells and materializes a virtualized extension once on release", async () => {
    const columns = ["COL_ID_A", "COL_ID_B", "COL_ID_C", "COL_ID_D"];
    const { grid, structure } = createGrid(columns, ["COL_ID_A", "COL_ID_D"]);
    const apply = vi.fn(() => Object.freeze({ kind: "accepted" as const }));
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => source(["COL_ID_A"], ["stable"]),
      getStructure: () => structure,
      apply,
      scrollHorizontalByPhysical: () => false,
    });
    await nextFrame();

    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    const target = grid.querySelector<HTMLElement>('[data-bruno-column-id="COL_ID_D"]')!;
    handle.dispatchEvent(pointer("pointerdown", 41, centerOf(handle)));
    window.dispatchEvent(pointer("pointermove", 41, centerOf(target)));
    await nextFrame();

    expect(grid.querySelectorAll("[data-bruno-drag-fill-preview]")).toHaveLength(1);
    expect(target).toHaveAttribute("data-bruno-drag-fill-preview", "");
    window.dispatchEvent(pointer("pointerup", 41, centerOf(target)));

    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith([
      { rowId: "ROW_ID_1", columnId: "COL_ID_B", canonicalText: "stable" },
      { rowId: "ROW_ID_1", columnId: "COL_ID_C", canonicalText: "stable" },
      { rowId: "ROW_ID_1", columnId: "COL_ID_D", canonicalText: "stable" },
    ]);
    expect(grid.querySelectorAll("[data-bruno-drag-fill-preview]")).toHaveLength(0);
  });

  test("adds the first coordinate and affected count to a global rejection", async () => {
    const columns = ["COL_ID_A", "COL_ID_B", "COL_ID_C"];
    const { grid, structure } = createGrid(columns);
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => source(["COL_ID_A"], ["stable"]),
      getStructure: () => structure,
      apply: (cells) =>
        addBrunoTableDragFillRejectionEvidence(
          cells,
          Object.freeze({ kind: "rejected" as const, reason: "temporarily-unavailable" as const }),
        ),
      scrollHorizontalByPhysical: () => false,
      describeCoordinate: ({ rowId, columnId }) => `${rowId}/${columnId}`,
    });
    await nextFrame();

    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    const target = grid.querySelector<HTMLElement>('[data-bruno-column-id="COL_ID_C"]')!;
    handle.dispatchEvent(pointer("pointerdown", 165, centerOf(handle)));
    window.dispatchEvent(pointer("pointermove", 165, centerOf(target)));
    await nextFrame();
    window.dispatchEvent(pointer("pointerup", 165, centerOf(target)));

    expect(runtime.getNotificationSnapshot().message).toContain("ROW_ID_1/COL_ID_B:");
    expect(runtime.getNotificationSnapshot().message).toContain("(+1 more)");
    expect(runtime.getNotificationSnapshot().message).toContain("Nothing was applied");
  });

  test("retains destination evidence when application throws", async () => {
    const columns = ["COL_ID_A", "COL_ID_B", "COL_ID_C"];
    const { grid, structure } = createGrid(columns);
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => source(["COL_ID_A"], ["stable"]),
      getStructure: () => structure,
      apply: () => {
        throw new Error("application boundary failed");
      },
      scrollHorizontalByPhysical: () => false,
      describeCoordinate: ({ rowId, columnId }) => `${rowId}/${columnId}`,
    });
    await nextFrame();

    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    const target = grid.querySelector<HTMLElement>('[data-bruno-column-id="COL_ID_C"]')!;
    handle.dispatchEvent(pointer("pointerdown", 166, centerOf(handle)));
    window.dispatchEvent(pointer("pointermove", 166, centerOf(target)));
    await nextFrame();
    window.dispatchEvent(pointer("pointerup", 166, centerOf(target)));

    expect(runtime.getNotificationSnapshot().message).toContain("ROW_ID_1/COL_ID_B:");
    expect(runtime.getNotificationSnapshot().message).toContain("(+1 more)");
    expect(runtime.getNotificationSnapshot().message).toContain("Nothing was applied");
  });

  test("retains destination evidence when release preflight throws", async () => {
    const columns = ["COL_ID_A", "COL_ID_B", "COL_ID_C"];
    const { grid, structure } = createGrid(columns);
    const apply = vi.fn(() => Object.freeze({ kind: "accepted" as const }));
    let throwOnRelease = false;
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => {
        if (throwOnRelease) throw new Error("source boundary failed");
        return source(["COL_ID_A"], ["stable"]);
      },
      getStructure: () => structure,
      apply,
      scrollHorizontalByPhysical: () => false,
      describeCoordinate: ({ rowId, columnId }) => `${rowId}/${columnId}`,
    });
    await nextFrame();

    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    const target = grid.querySelector<HTMLElement>('[data-bruno-column-id="COL_ID_C"]')!;
    handle.dispatchEvent(pointer("pointerdown", 167, centerOf(handle)));
    window.dispatchEvent(pointer("pointermove", 167, centerOf(target)));
    await nextFrame();
    throwOnRelease = true;
    window.dispatchEvent(pointer("pointerup", 167, centerOf(target)));

    expect(apply).not.toHaveBeenCalled();
    expect(runtime.getNotificationSnapshot().message).toContain("ROW_ID_1/COL_ID_B:");
    expect(runtime.getNotificationSnapshot().message).toContain("(+1 more)");
    expect(runtime.getNotificationSnapshot().message).toContain("Nothing was applied");
  });

  test("keeps an 8-pixel visual handle inside a 24-pixel pointer target", async () => {
    const { grid, structure } = createGrid(["COL_ID_A", "COL_ID_B"]);
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => source(["COL_ID_A"], ["stable"]),
      getStructure: () => structure,
      apply: () => Object.freeze({ kind: "accepted" as const }),
      scrollHorizontalByPhysical: () => false,
    });
    await nextFrame();

    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    const visual = handle.firstElementChild as HTMLElement | null;
    expect(handle.style.inlineSize).toBe("24px");
    expect(handle.style.blockSize).toBe("24px");
    expect(visual?.style.inlineSize).toBe("8px");
    expect(visual?.style.blockSize).toBe("8px");
  });

  test("preserves non-aligned reverse cyclic phase across a pinned source", async () => {
    const columns = ["COL_ID_A", "COL_ID_B", "COL_ID_C", "COL_ID_D", "COL_ID_E", "COL_ID_F"];
    const { grid, structure } = createGrid(columns);
    grid
      .querySelector<HTMLElement>('[data-bruno-column-id="COL_ID_F"]')!
      .setAttribute("data-pinned-region", "end");
    const apply = vi.fn(() => Object.freeze({ kind: "accepted" as const }));
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () =>
        source(["COL_ID_D", "COL_ID_E", "COL_ID_F"], ["alpha", "beta", "gamma"]),
      getStructure: () => structure,
      apply,
      scrollHorizontalByPhysical: () => false,
    });
    await nextFrame();

    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    const target = grid.querySelector<HTMLElement>('[data-bruno-column-id="COL_ID_B"]')!;
    handle.dispatchEvent(pointer("pointerdown", 42, centerOf(handle)));
    window.dispatchEvent(pointer("pointermove", 42, centerOf(target)));
    await nextFrame();
    window.dispatchEvent(pointer("pointerup", 42, centerOf(target)));

    expect(apply).toHaveBeenCalledWith([
      { rowId: "ROW_ID_1", columnId: "COL_ID_B", canonicalText: "beta" },
      { rowId: "ROW_ID_1", columnId: "COL_ID_C", canonicalText: "gamma" },
    ]);
  });

  test("hosts the handle on a pinned duplicate instead of the covered centre copy", async () => {
    const { grid, structure } = createGrid(["COL_ID_A", "COL_ID_B"]);
    const pinnedRegion = document.createElement("div");
    pinnedRegion.dataset["brunoPinnedBodyRegion"] = "end";
    const pinnedCell = document.createElement("div");
    pinnedCell.setAttribute("role", "gridcell");
    pinnedCell.dataset["brunoRowId"] = "ROW_ID_1";
    pinnedCell.dataset["brunoColumnId"] = "COL_ID_A";
    const pinnedContent = document.createElement("div");
    pinnedContent.className = "relative";
    pinnedCell.append(pinnedContent);
    pinnedRegion.append(pinnedCell);
    grid.append(pinnedRegion);
    vi.spyOn(document, "elementFromPoint").mockReturnValue(pinnedCell);
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => source(["COL_ID_A"], ["stable"]),
      getStructure: () => structure,
      apply: () => Object.freeze({ kind: "accepted" as const }),
      scrollHorizontalByPhysical: () => false,
    });
    await nextFrame();

    expect(pinnedContent.querySelector("[data-bruno-drag-fill-handle]")).not.toBeNull();
    expect(
      grid
        .querySelector<HTMLElement>('[data-bruno-column-id="COL_ID_A"] > div.relative')!
        .querySelector("[data-bruno-drag-fill-handle]"),
    ).toBeNull();
  });

  test("cancels without applying on pointer cancellation or structural invalidation", async () => {
    const columns = ["COL_ID_A", "COL_ID_B", "COL_ID_C"];
    const { grid, structure } = createGrid(columns);
    let currentStructure = structure;
    const apply = vi.fn(() => Object.freeze({ kind: "accepted" as const }));
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => source(["COL_ID_A"], ["stable"]),
      getStructure: () => currentStructure,
      apply,
      scrollHorizontalByPhysical: () => false,
    });
    await nextFrame();
    const target = grid.querySelector<HTMLElement>('[data-bruno-column-id="COL_ID_C"]')!;

    let handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    handle.dispatchEvent(pointer("pointerdown", 43, centerOf(handle)));
    window.dispatchEvent(pointer("pointermove", 43, centerOf(target)));
    await nextFrame();
    window.dispatchEvent(pointer("pointercancel", 43, centerOf(target)));
    expect(apply).not.toHaveBeenCalled();

    await nextFrame();
    handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    handle.dispatchEvent(pointer("pointerdown", 44, centerOf(handle)));
    window.dispatchEvent(pointer("pointermove", 44, centerOf(target)));
    await nextFrame();
    currentStructure = createBrunoTableCellRangeStructure(
      ["ROW_ID_1"],
      ["COL_ID_A", "COL_ID_C", "COL_ID_B"],
    );
    runtime.reconcile();
    window.dispatchEvent(pointer("pointerup", 44, centerOf(target)));

    expect(apply).not.toHaveBeenCalled();
    expect(runtime.getSnapshot().active).toBe(false);
  });

  test("revalidates both structure axes at release without an earlier reconciliation", async () => {
    const columns = ["COL_ID_A", "COL_ID_B", "COL_ID_C"];
    const { grid, structure } = createGrid(columns);
    let currentStructure = structure;
    const apply = vi.fn(() => Object.freeze({ kind: "accepted" as const }));
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => source(["COL_ID_A"], ["stable"]),
      getStructure: () => currentStructure,
      apply,
      scrollHorizontalByPhysical: () => false,
    });
    await nextFrame();
    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    const target = grid.querySelector<HTMLElement>('[data-bruno-column-id="COL_ID_C"]')!;
    handle.dispatchEvent(pointer("pointerdown", 50, centerOf(handle)));
    window.dispatchEvent(pointer("pointermove", 50, centerOf(target)));
    await nextFrame();

    currentStructure = createBrunoTableCellRangeStructure(["ROW_ID_REPLACED"], columns);
    window.dispatchEvent(pointer("pointerup", 50, centerOf(target)));

    expect(apply).not.toHaveBeenCalled();
    expect(runtime.getNotificationSnapshot().message).toContain(
      "The fill destination changed before release.",
    );
  });

  test("reports captured destination evidence when the affected identity span changes at release", async () => {
    const columns = ["COL_ID_A", "COL_ID_B", "COL_ID_C", "COL_ID_D"];
    const { grid, structure } = createGrid(columns);
    grid.style.width = "320px";
    let currentStructure = structure;
    const apply = vi.fn(() => Object.freeze({ kind: "accepted" as const }));
    const describeCoordinate = vi.fn(
      ({ rowId, columnId }: Readonly<{ readonly rowId: string; readonly columnId: string }>) =>
        `${rowId}/${columnId}`,
    );
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => source(["COL_ID_A"], ["stable"]),
      getStructure: () => currentStructure,
      apply,
      scrollHorizontalByPhysical: () => false,
      describeCoordinate,
    });
    await nextFrame();
    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    const target = grid.querySelector<HTMLElement>('[data-bruno-column-id="COL_ID_D"]')!;
    handle.dispatchEvent(pointer("pointerdown", 151, centerOf(handle)));
    window.dispatchEvent(pointer("pointermove", 151, centerOf(target)));
    await nextFrame();

    currentStructure = createBrunoTableCellRangeStructure(
      ["ROW_ID_1"],
      ["COL_ID_A", "COL_ID_REPLACED", "COL_ID_C", "COL_ID_D"],
    );
    window.dispatchEvent(pointer("pointerup", 151, centerOf(target)));

    expect(apply).not.toHaveBeenCalled();
    expect(describeCoordinate).toHaveBeenCalledWith({
      rowId: "ROW_ID_1",
      columnId: "COL_ID_B",
    });
    expect(runtime.getNotificationSnapshot().message).toBe(
      "ROW_ID_1/COL_ID_B: The fill destination changed before release. (+2 more) Nothing was applied.",
    );
  });

  test("preserves a fill when a structure change is outside the affected span", async () => {
    const columns = ["COL_ID_A", "COL_ID_B", "COL_ID_C"];
    const { grid, structure } = createGrid(columns);
    let currentStructure = structure;
    const apply = vi.fn(() => Object.freeze({ kind: "accepted" as const }));
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => source(["COL_ID_A"], ["stable"]),
      getStructure: () => currentStructure,
      apply,
      scrollHorizontalByPhysical: () => false,
    });
    await nextFrame();
    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    const target = grid.querySelector<HTMLElement>('[data-bruno-column-id="COL_ID_C"]')!;
    handle.dispatchEvent(pointer("pointerdown", 64, centerOf(handle)));
    window.dispatchEvent(pointer("pointermove", 64, centerOf(target)));
    await nextFrame();

    currentStructure = createBrunoTableCellRangeStructure(
      ["ROW_ID_1"],
      [...columns, "COL_ID_UNRELATED"],
    );
    runtime.reconcile();
    expect(runtime.getSnapshot().active).toBe(true);
    window.dispatchEvent(pointer("pointerup", 64, centerOf(target)));

    expect(apply).toHaveBeenCalledWith([
      { rowId: "ROW_ID_1", columnId: "COL_ID_B", canonicalText: "stable" },
      { rowId: "ROW_ID_1", columnId: "COL_ID_C", canonicalText: "stable" },
    ]);
  });

  test("rebases an active fill so an appended identity can become its destination", async () => {
    const initialColumns = ["COL_ID_A", "COL_ID_B", "COL_ID_C"];
    const { grid, structure } = createGrid(initialColumns, [...initialColumns, "COL_ID_D"]);
    grid.style.width = "320px";
    let currentStructure = structure;
    const apply = vi.fn(() => Object.freeze({ kind: "accepted" as const }));
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => source(["COL_ID_A"], ["stable"]),
      getStructure: () => currentStructure,
      apply,
      scrollHorizontalByPhysical: () => false,
    });
    await nextFrame();

    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    const firstTarget = grid.querySelector<HTMLElement>('[data-bruno-column-id="COL_ID_C"]')!;
    const appendedTarget = grid.querySelector<HTMLElement>('[data-bruno-column-id="COL_ID_D"]')!;
    handle.dispatchEvent(pointer("pointerdown", 164, centerOf(handle)));
    window.dispatchEvent(pointer("pointermove", 164, centerOf(firstTarget)));
    await nextFrame();

    currentStructure = createBrunoTableCellRangeStructure(
      ["ROW_ID_1"],
      [...initialColumns, "COL_ID_D"],
    );
    runtime.reconcile();
    window.dispatchEvent(pointer("pointermove", 164, centerOf(appendedTarget)));
    await nextFrame();
    window.dispatchEvent(pointer("pointerup", 164, centerOf(appendedTarget)));

    expect(apply).toHaveBeenCalledWith([
      { rowId: "ROW_ID_1", columnId: "COL_ID_B", canonicalText: "stable" },
      { rowId: "ROW_ID_1", columnId: "COL_ID_C", canonicalText: "stable" },
      { rowId: "ROW_ID_1", columnId: "COL_ID_D", canonicalText: "stable" },
    ]);
  });

  test("revalidates the source shape identity at release without an earlier reconciliation", async () => {
    const columns = ["COL_ID_A", "COL_ID_B", "COL_ID_C"];
    const { grid, structure } = createGrid(columns);
    let currentSource = source(["COL_ID_A"], ["stable"]);
    const apply = vi.fn(() => Object.freeze({ kind: "accepted" as const }));
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => currentSource,
      getStructure: () => structure,
      apply,
      scrollHorizontalByPhysical: () => false,
    });
    await nextFrame();
    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    const target = grid.querySelector<HTMLElement>('[data-bruno-column-id="COL_ID_C"]')!;
    handle.dispatchEvent(pointer("pointerdown", 54, centerOf(handle)));
    window.dispatchEvent(pointer("pointermove", 54, centerOf(target)));
    await nextFrame();

    currentSource = source(["COL_ID_A", "COL_ID_B"], ["stable", "other"]);
    window.dispatchEvent(pointer("pointerup", 54, centerOf(target)));

    expect(apply).not.toHaveBeenCalled();
    expect(runtime.getNotificationSnapshot().message).toContain(
      "The fill destination changed before release.",
    );
  });

  test("keeps the captured canonical source when only values publish during a gesture", async () => {
    const columns = ["COL_ID_A", "COL_ID_B", "COL_ID_C"];
    const { grid, structure } = createGrid(columns);
    let currentSource = source(["COL_ID_A"], ["captured"]);
    const apply = vi.fn(() => Object.freeze({ kind: "accepted" as const }));
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => currentSource,
      getStructure: () => structure,
      apply,
      scrollHorizontalByPhysical: () => false,
    });
    await nextFrame();
    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    const target = grid.querySelector<HTMLElement>('[data-bruno-column-id="COL_ID_C"]')!;
    handle.dispatchEvent(pointer("pointerdown", 55, centerOf(handle)));
    window.dispatchEvent(pointer("pointermove", 55, centerOf(target)));
    await nextFrame();

    currentSource = source(["COL_ID_A"], ["published later"]);
    runtime.reconcile();
    window.dispatchEvent(pointer("pointerup", 55, centerOf(target)));

    expect(apply).toHaveBeenCalledWith([
      { rowId: "ROW_ID_1", columnId: "COL_ID_B", canonicalText: "captured" },
      { rowId: "ROW_ID_1", columnId: "COL_ID_C", canonicalText: "captured" },
    ]);
  });

  test("replaces one persistent Fill rejected notification and exposes accessible Close", async () => {
    const columns = ["COL_ID_A", "COL_ID_B"];
    const { grid, structure } = createGrid(columns);
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => source(["COL_ID_A"], ["stable"]),
      getStructure: () => structure,
      apply: () =>
        Object.freeze({
          kind: "rejected" as const,
          reason: "invalid-value",
          detail: "Expected a positive value",
          rowId: "ROW_ID_1",
          columnId: "COL_ID_B",
          additionalInvalidCount: 2,
        }),
      scrollHorizontalByPhysical: () => false,
      describeCoordinate: () => "Row 1, Amount",
    });
    const chrome = await render(<BrunoTableDragFillChrome runtime={runtime} />);
    await nextFrame();
    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    const target = grid.querySelector<HTMLElement>('[data-bruno-column-id="COL_ID_B"]')!;
    handle.dispatchEvent(pointer("pointerdown", 45, centerOf(handle)));
    window.dispatchEvent(pointer("pointermove", 45, centerOf(target)));
    await nextFrame();
    window.dispatchEvent(pointer("pointerup", 45, centerOf(target)));

    const notifications = chrome.getByRole("region", { name: "Notifications", exact: true });
    await expect
      .element(notifications)
      .toMatchTextContent(
        "Row 1, Amount: Expected a positive value. (+2 more) Nothing was applied.",
      );
    await userEvent.click(notifications.getByRole("button", { name: "Close toast", exact: true }));
    await vi.waitFor(() => expect(runtime.getNotificationSnapshot().message).toBe(""));
  });

  test("preserves a persistent rejection after a fully unchanged fill", async () => {
    const columns = ["COL_ID_A", "COL_ID_B"];
    const { grid, structure } = createGrid(columns);
    const apply = vi
      .fn()
      .mockReturnValueOnce(
        Object.freeze({ kind: "rejected" as const, reason: "invalid-value" as const }),
      )
      .mockReturnValueOnce(Object.freeze({ kind: "unchanged" as const }));
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => source(["COL_ID_A"], ["stable"]),
      getStructure: () => structure,
      apply,
      scrollHorizontalByPhysical: () => false,
    });
    await nextFrame();
    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    const target = grid.querySelector<HTMLElement>('[data-bruno-column-id="COL_ID_B"]')!;

    handle.dispatchEvent(pointer("pointerdown", 145, centerOf(handle)));
    window.dispatchEvent(pointer("pointermove", 145, centerOf(target)));
    await nextFrame();
    window.dispatchEvent(pointer("pointerup", 145, centerOf(target)));
    const rejection = runtime.getNotificationSnapshot();
    await nextFrame();

    const nextHandle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    nextHandle.dispatchEvent(pointer("pointerdown", 146, centerOf(nextHandle)));
    window.dispatchEvent(pointer("pointermove", 146, centerOf(target)));
    await nextFrame();
    window.dispatchEvent(pointer("pointerup", 146, centerOf(target)));

    expect(apply).toHaveBeenCalledTimes(2);
    expect(runtime.getNotificationSnapshot()).toBe(rejection);
  });

  test("queues continuing autoscroll before the viewport publication it triggers", async () => {
    const { grid, structure } = createGrid(["COL_ID_A", "COL_ID_B", "COL_ID_C"]);
    const order: string[] = [];
    let publication: number | undefined;
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => source(["COL_ID_A"], ["stable"]),
      getStructure: () => structure,
      apply: () => Object.freeze({ kind: "accepted" as const }),
      scrollHorizontalByPhysical: () => {
        order.push("scroll");
        if (order.length > 1) return false;
        publication = requestAnimationFrame(() => order.push("publish"));
        return true;
      },
    });
    await nextFrame();
    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    const bounds = grid.getBoundingClientRect();
    const edge = { x: bounds.right - 1, y: bounds.top + bounds.height / 2 };
    try {
      handle.dispatchEvent(pointer("pointerdown", 168, centerOf(handle)));
      window.dispatchEvent(pointer("pointermove", 168, edge));
      await nextFrame();
      await nextFrame();
      expect(order).toEqual(["scroll", "scroll", "publish"]);
      await nextFrame();
      expect(order).toHaveLength(3);
    } finally {
      window.dispatchEvent(pointer("pointercancel", 168, edge));
      if (publication !== undefined) cancelAnimationFrame(publication);
    }
  });

  test("keeps preview motion-free and autoscroll parallel-only", async () => {
    const columns = ["COL_ID_A", "COL_ID_B", "COL_ID_C"];
    const { grid, structure } = createGrid(columns);
    const scrollHorizontalByPhysical = vi.fn(() => true);
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => source(["COL_ID_A"], ["stable"]),
      getStructure: () => structure,
      apply: () => Object.freeze({ kind: "accepted" as const }),
      scrollHorizontalByPhysical,
    });
    await nextFrame();
    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    const bounds = grid.getBoundingClientRect();
    handle.dispatchEvent(pointer("pointerdown", 46, centerOf(handle)));
    window.dispatchEvent(
      pointer("pointermove", 46, { x: bounds.right - 1, y: bounds.top + bounds.height / 2 }),
    );
    await nextFrame();

    expect(scrollHorizontalByPhysical).toHaveBeenCalled();
    expect(grid.scrollTop).toBe(0);
    for (const preview of grid.querySelectorAll<HTMLElement>("[data-bruno-drag-fill-preview]")) {
      expect(preview.style.transition).toBe("");
      expect(preview.style.animation).toBe("");
    }
    window.dispatchEvent(pointer("pointercancel", 46, centerOf(handle)));
  });

  test("clears a stale preview when the pointer returns to the source", async () => {
    const columns = ["COL_ID_A", "COL_ID_B", "COL_ID_C"];
    const { grid, structure } = createGrid(columns);
    const apply = vi.fn(() => Object.freeze({ kind: "accepted" as const }));
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => source(["COL_ID_A"], ["stable"]),
      getStructure: () => structure,
      apply,
      scrollHorizontalByPhysical: () => false,
    });
    await nextFrame();
    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    const sourceCell = grid.querySelector<HTMLElement>('[data-bruno-column-id="COL_ID_A"]')!;
    const target = grid.querySelector<HTMLElement>('[data-bruno-column-id="COL_ID_C"]')!;
    handle.dispatchEvent(pointer("pointerdown", 47, centerOf(handle)));
    window.dispatchEvent(pointer("pointermove", 47, centerOf(target)));
    await nextFrame();
    expect(grid.querySelectorAll("[data-bruno-drag-fill-preview]")).toHaveLength(2);

    window.dispatchEvent(pointer("pointermove", 47, centerOf(sourceCell)));
    await nextFrame();
    expect(grid.querySelectorAll("[data-bruno-drag-fill-preview]")).toHaveLength(0);
    window.dispatchEvent(pointer("pointerup", 47, centerOf(sourceCell)));

    expect(apply).not.toHaveBeenCalled();
    expect(runtime.getNotificationSnapshot()).toEqual({ sequence: 0, message: "" });
  });

  test("releases the last valid projection after the pointer leaves the grid", async () => {
    const columns = ["COL_ID_A", "COL_ID_B", "COL_ID_C"];
    const { grid, structure } = createGrid(columns);
    const apply = vi.fn(() => Object.freeze({ kind: "accepted" as const }));
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => source(["COL_ID_A"], ["stable"]),
      getStructure: () => structure,
      apply,
      scrollHorizontalByPhysical: () => false,
    });
    await nextFrame();
    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    const target = grid.querySelector<HTMLElement>('[data-bruno-column-id="COL_ID_C"]')!;
    const targetCenter = centerOf(target);
    const gridBounds = grid.getBoundingClientRect();
    const outsideGrid = { x: gridBounds.right + 32, y: targetCenter.y };
    handle.dispatchEvent(pointer("pointerdown", 56, centerOf(handle)));
    window.dispatchEvent(pointer("pointermove", 56, targetCenter));
    await nextFrame();
    expect(grid.querySelectorAll("[data-bruno-drag-fill-preview]")).toHaveLength(2);

    window.dispatchEvent(pointer("pointermove", 56, outsideGrid));
    await nextFrame();
    expect(grid.querySelectorAll("[data-bruno-drag-fill-preview]")).toHaveLength(2);
    window.dispatchEvent(pointer("pointerup", 56, outsideGrid));

    expect(apply).toHaveBeenCalledWith([
      { rowId: "ROW_ID_1", columnId: "COL_ID_B", canonicalText: "stable" },
      { rowId: "ROW_ID_1", columnId: "COL_ID_C", canonicalText: "stable" },
    ]);
    expect(runtime.getNotificationSnapshot().message).toBe("");
  });

  test("silently cancels a no-hit release when no projection was ever acquired", async () => {
    const columns = ["COL_ID_A", "COL_ID_B", "COL_ID_C"];
    const { grid, structure } = createGrid(columns);
    const apply = vi.fn(() => Object.freeze({ kind: "accepted" as const }));
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => source(["COL_ID_A"], ["stable"]),
      getStructure: () => structure,
      apply,
      scrollHorizontalByPhysical: () => false,
    });
    await nextFrame();
    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    const bounds = grid.getBoundingClientRect();
    const outsideGrid = { x: bounds.right + 32, y: bounds.top + bounds.height / 2 };
    handle.dispatchEvent(pointer("pointerdown", 61, centerOf(handle)));
    window.dispatchEvent(pointer("pointerup", 61, outsideGrid));

    expect(apply).not.toHaveBeenCalled();
    expect(runtime.getNotificationSnapshot()).toEqual({ sequence: 0, message: "" });
  });

  test("projects an initial diagonal horizontal drag through the owned cell column", async () => {
    const columns = ["COL_ID_A", "COL_ID_B", "COL_ID_C"];
    const { grid } = createGrid(columns);
    grid.style.flexWrap = "wrap";
    grid.style.height = "80px";
    for (const columnId of columns) {
      const sourceCell = grid.querySelector<HTMLElement>(
        `[data-bruno-row-id="ROW_ID_1"][data-bruno-column-id="${columnId}"]`,
      );
      if (sourceCell === null) throw new Error("Expected the source-row cell fixture.");
      const cell = sourceCell.cloneNode(true) as HTMLElement;
      cell.dataset["brunoRowId"] = "ROW_ID_2";
      cell.dataset["brunoRowIndex"] = "1";
      grid.append(cell);
    }
    const structure = createBrunoTableCellRangeStructure(["ROW_ID_1", "ROW_ID_2"], columns);
    const apply = vi.fn(() => Object.freeze({ kind: "accepted" as const }));
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => source(["COL_ID_A"], ["stable"]),
      getStructure: () => structure,
      apply,
      scrollHorizontalByPhysical: () => false,
    });
    await nextFrame();
    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    const offRow = grid.querySelector<HTMLElement>(
      '[data-bruno-row-id="ROW_ID_2"][data-bruno-column-id="COL_ID_C"]',
    )!;
    handle.dispatchEvent(pointer("pointerdown", 59, centerOf(handle)));
    window.dispatchEvent(pointer("pointermove", 59, centerOf(offRow)));
    await nextFrame();
    expect(grid.querySelectorAll("[data-bruno-drag-fill-preview]")).toHaveLength(2);
    window.dispatchEvent(pointer("pointerup", 59, centerOf(offRow)));

    expect(apply).toHaveBeenCalledWith([
      { rowId: "ROW_ID_1", columnId: "COL_ID_B", canonicalText: "stable" },
      { rowId: "ROW_ID_1", columnId: "COL_ID_C", canonicalText: "stable" },
    ]);
    expect(grid.querySelectorAll("[data-bruno-drag-fill-preview]")).toHaveLength(0);
    expect(runtime.getNotificationSnapshot().message).toBe("");
  });

  test("projects a horizontal drag by column after locking despite row drift", async () => {
    const columns = ["COL_ID_A", "COL_ID_B", "COL_ID_C"];
    const { grid } = createGrid(columns);
    grid.style.flexWrap = "wrap";
    grid.style.height = "80px";
    for (const columnId of columns) {
      const sourceCell = grid.querySelector<HTMLElement>(
        `[data-bruno-row-id="ROW_ID_1"][data-bruno-column-id="${columnId}"]`,
      );
      if (sourceCell === null) throw new Error("Expected the source-row cell fixture.");
      const cell = sourceCell.cloneNode(true) as HTMLElement;
      cell.dataset["brunoRowId"] = "ROW_ID_2";
      cell.dataset["brunoRowIndex"] = "1";
      grid.append(cell);
    }
    const structure = createBrunoTableCellRangeStructure(["ROW_ID_1", "ROW_ID_2"], columns);
    const apply = vi.fn(() => Object.freeze({ kind: "accepted" as const }));
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => source(["COL_ID_A"], ["stable"]),
      getStructure: () => structure,
      apply,
      scrollHorizontalByPhysical: () => false,
    });
    await nextFrame();
    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    const target = grid.querySelector<HTMLElement>(
      '[data-bruno-row-id="ROW_ID_1"][data-bruno-column-id="COL_ID_C"]',
    )!;
    const drift = grid.querySelector<HTMLElement>(
      '[data-bruno-row-id="ROW_ID_2"][data-bruno-column-id="COL_ID_C"]',
    )!;
    handle.dispatchEvent(pointer("pointerdown", 62, centerOf(handle)));
    window.dispatchEvent(pointer("pointermove", 62, centerOf(target)));
    await nextFrame();
    window.dispatchEvent(pointer("pointermove", 62, centerOf(drift)));
    await nextFrame();
    expect(grid.querySelectorAll("[data-bruno-drag-fill-preview]")).toHaveLength(2);
    window.dispatchEvent(pointer("pointerup", 62, centerOf(drift)));

    expect(apply).toHaveBeenCalledWith([
      { rowId: "ROW_ID_1", columnId: "COL_ID_B", canonicalText: "stable" },
      { rowId: "ROW_ID_1", columnId: "COL_ID_C", canonicalText: "stable" },
    ]);
  });

  test("projects an initial diagonal vertical drag through the owned cell row", async () => {
    const rows = ["ROW_ID_1", "ROW_ID_2", "ROW_ID_3"];
    const { grid } = createVerticalGrid(rows);
    grid.style.height = "104px";
    grid.style.position = "relative";
    const offColumn = document.createElement("div");
    offColumn.setAttribute("role", "gridcell");
    offColumn.dataset["brunoRowId"] = "ROW_ID_3";
    offColumn.dataset["brunoColumnId"] = "COL_ID_B";
    offColumn.dataset["brunoRowIndex"] = "2";
    Object.assign(offColumn.style, {
      height: "32px",
      left: "48px",
      position: "absolute",
      top: "64px",
      width: "48px",
      zIndex: "2",
    });
    grid.append(offColumn);
    const structure = createBrunoTableCellRangeStructure(rows, ["COL_ID_A", "COL_ID_B"]);
    const apply = vi.fn(() => Object.freeze({ kind: "accepted" as const }));
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => verticalSource(["ROW_ID_1"], ["stable"]),
      getStructure: () => structure,
      apply,
      scrollHorizontalByPhysical: () => false,
    });
    await nextFrame();
    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    handle.dispatchEvent(pointer("pointerdown", 60, centerOf(handle)));
    window.dispatchEvent(pointer("pointermove", 60, centerOf(offColumn)));
    await nextFrame();
    expect(grid.querySelectorAll("[data-bruno-drag-fill-preview]")).toHaveLength(2);
    window.dispatchEvent(pointer("pointerup", 60, centerOf(offColumn)));

    expect(apply).toHaveBeenCalledWith([
      { rowId: "ROW_ID_2", columnId: "COL_ID_A", canonicalText: "stable" },
      { rowId: "ROW_ID_3", columnId: "COL_ID_A", canonicalText: "stable" },
    ]);
    expect(grid.querySelectorAll("[data-bruno-drag-fill-preview]")).toHaveLength(0);
    expect(runtime.getNotificationSnapshot().message).toBe("");
  });

  test("projects a vertical drag by row after locking despite column drift", async () => {
    const rows = ["ROW_ID_1", "ROW_ID_2", "ROW_ID_3"];
    const { grid } = createVerticalGrid(rows);
    grid.style.height = "104px";
    grid.style.position = "relative";
    const offColumn = document.createElement("div");
    offColumn.setAttribute("role", "gridcell");
    offColumn.dataset["brunoRowId"] = "ROW_ID_3";
    offColumn.dataset["brunoColumnId"] = "COL_ID_B";
    offColumn.dataset["brunoRowIndex"] = "2";
    Object.assign(offColumn.style, {
      height: "32px",
      left: "48px",
      position: "absolute",
      top: "64px",
      width: "48px",
      zIndex: "2",
    });
    grid.append(offColumn);
    const structure = createBrunoTableCellRangeStructure(rows, ["COL_ID_A", "COL_ID_B"]);
    const apply = vi.fn(() => Object.freeze({ kind: "accepted" as const }));
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => verticalSource(["ROW_ID_1"], ["stable"]),
      getStructure: () => structure,
      apply,
      scrollHorizontalByPhysical: () => false,
    });
    await nextFrame();
    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    const target = grid.querySelector<HTMLElement>(
      '[data-bruno-row-id="ROW_ID_3"][data-bruno-column-id="COL_ID_A"]',
    )!;
    handle.dispatchEvent(pointer("pointerdown", 63, centerOf(handle)));
    window.dispatchEvent(pointer("pointermove", 63, centerOf(target)));
    await nextFrame();
    window.dispatchEvent(pointer("pointermove", 63, centerOf(offColumn)));
    await nextFrame();
    expect(grid.querySelectorAll("[data-bruno-drag-fill-preview]")).toHaveLength(2);
    window.dispatchEvent(pointer("pointerup", 63, centerOf(offColumn)));

    expect(apply).toHaveBeenCalledWith([
      { rowId: "ROW_ID_2", columnId: "COL_ID_A", canonicalText: "stable" },
      { rowId: "ROW_ID_3", columnId: "COL_ID_A", canonicalText: "stable" },
    ]);
  });

  test("recovers the same valid endpoint after crossing a non-cell gap", async () => {
    const columns = ["COL_ID_A", "COL_ID_B", "COL_ID_C"];
    const { grid, structure } = createGrid(columns);
    const apply = vi.fn(() => Object.freeze({ kind: "accepted" as const }));
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => source(["COL_ID_A"], ["stable"]),
      getStructure: () => structure,
      apply,
      scrollHorizontalByPhysical: () => false,
    });
    await nextFrame();
    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    const target = grid.querySelector<HTMLElement>('[data-bruno-column-id="COL_ID_C"]')!;
    const targetCenter = centerOf(target);
    const gridBounds = grid.getBoundingClientRect();
    const noCell = { x: targetCenter.x, y: gridBounds.bottom - 1 };
    handle.dispatchEvent(pointer("pointerdown", 57, centerOf(handle)));
    window.dispatchEvent(pointer("pointermove", 57, targetCenter));
    await nextFrame();
    window.dispatchEvent(pointer("pointermove", 57, noCell));
    await nextFrame();

    window.dispatchEvent(pointer("pointermove", 57, targetCenter));
    await nextFrame();
    expect(grid.querySelectorAll("[data-bruno-drag-fill-preview]")).toHaveLength(2);
    window.dispatchEvent(pointer("pointerup", 57, targetCenter));

    expect(apply).toHaveBeenCalledOnce();
    expect(runtime.getNotificationSnapshot().message).toBe("");
  });

  test("publishes a repeated endpoint only once while pointer frames stay outside React", async () => {
    const columns = ["COL_ID_A", "COL_ID_B", "COL_ID_C"];
    const { grid, structure } = createGrid(columns);
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => source(["COL_ID_A"], ["stable"]),
      getStructure: () => structure,
      apply: () => Object.freeze({ kind: "accepted" as const }),
      scrollHorizontalByPhysical: () => false,
    });
    let publications = 0;
    runtime.subscribe(() => {
      publications += 1;
    });
    await nextFrame();
    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    const target = grid.querySelector<HTMLElement>('[data-bruno-column-id="COL_ID_C"]')!;
    handle.dispatchEvent(pointer("pointerdown", 48, centerOf(handle)));
    window.dispatchEvent(pointer("pointermove", 48, centerOf(target)));
    await nextFrame();
    const afterFirstEndpoint = publications;
    await nextFrame();
    const mountedCellQueries = vi.spyOn(grid, "querySelectorAll");
    window.dispatchEvent(pointer("pointermove", 48, centerOf(target)));
    await nextFrame();

    expect(afterFirstEndpoint).toBe(2);
    expect(publications).toBe(afterFirstEndpoint);
    expect(mountedCellQueries).not.toHaveBeenCalled();
    window.dispatchEvent(pointer("pointercancel", 48, centerOf(target)));
  });

  test("moves between valid endpoints without publishing after the axis lock", async () => {
    const columns = ["COL_ID_A", "COL_ID_B", "COL_ID_C"];
    const { grid, structure } = createGrid(columns);
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => source(["COL_ID_A"], ["stable"]),
      getStructure: () => structure,
      apply: () => Object.freeze({ kind: "accepted" as const }),
      scrollHorizontalByPhysical: () => false,
    });
    let publications = 0;
    runtime.subscribe(() => {
      publications += 1;
    });
    await nextFrame();
    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    const middle = grid.querySelector<HTMLElement>('[data-bruno-column-id="COL_ID_B"]')!;
    const end = grid.querySelector<HTMLElement>('[data-bruno-column-id="COL_ID_C"]')!;
    handle.dispatchEvent(pointer("pointerdown", 58, centerOf(handle)));
    window.dispatchEvent(pointer("pointermove", 58, centerOf(middle)));
    await nextFrame();
    const afterAxisLock = publications;

    window.dispatchEvent(pointer("pointermove", 58, centerOf(end)));
    await nextFrame();

    expect(afterAxisLock).toBe(2);
    expect(publications).toBe(afterAxisLock);
    window.dispatchEvent(pointer("pointercancel", 58, centerOf(end)));
  });

  test("does not scan the complete immutable structure during active DOM reconciliation", async () => {
    const columns = ["COL_ID_A", "COL_ID_B"];
    const { grid, structure: baseStructure } = createGrid(columns);
    const logicalRowIds = Object.freeze(
      Array.from({ length: 10_000 }, (_unused, index) => `ROW_ID_${String(index + 1)}`),
    );
    let rowIdentityReads = 0;
    const rowIds = new Proxy(logicalRowIds, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) rowIdentityReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const structure = Object.freeze({
      ...baseStructure,
      rowIds,
      rowIndexById: new Map(logicalRowIds.map((rowId, index) => [rowId, index] as const)),
    });
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => source(["COL_ID_A"], ["stable"]),
      getStructure: () => structure,
      apply: () => Object.freeze({ kind: "accepted" as const }),
      scrollHorizontalByPhysical: () => false,
    });
    await nextFrame();
    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    handle.dispatchEvent(pointer("pointerdown", 52, centerOf(handle)));
    rowIdentityReads = 0;

    runtime.reconcile();

    expect(rowIdentityReads).toBe(0);
    window.dispatchEvent(pointer("pointercancel", 52, centerOf(handle)));
  });

  test("does not rescan a long immutable source during active DOM reconciliation", async () => {
    const logicalRowIds = Object.freeze(
      Array.from({ length: 10_000 }, (_unused, index) => `ROW_ID_${String(index + 1)}`),
    );
    const { grid, structure } = createVerticalGrid(logicalRowIds, [
      logicalRowIds[0]!,
      logicalRowIds.at(-1)!,
    ]);
    let sourceIdentityReads = 0;
    const sourceRowIds = new Proxy(logicalRowIds, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) sourceIdentityReads += 1;
        return Reflect.get(target, property, receiver);
      },
    }) as readonly [string, ...string[]];
    const sourceSnapshot: BrunoTableDragFillSource = Object.freeze({
      shapeIdentity: Object.freeze({}),
      axis: "vertical",
      sourceCellCount: sourceRowIds.length,
      sourceFirstIdentity: sourceRowIds[0],
      sourceLastIdentity: sourceRowIds.at(-1)!,
      perpendicularIdentity: "COL_ID_A",
      rowIds: sourceRowIds,
      columnIds: Object.freeze(["COL_ID_A"]) as readonly [string],
      canonicalTexts: Object.freeze(
        logicalRowIds.map((_rowId, index) => String(index)),
      ) as readonly [string, ...string[]],
      handle: Object.freeze({
        rowId: logicalRowIds.at(-1)!,
        columnId: "COL_ID_A",
      }),
    });
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => sourceSnapshot,
      getStructure: () => structure,
      apply: () => Object.freeze({ kind: "accepted" as const }),
      scrollHorizontalByPhysical: () => false,
    });
    await nextFrame();
    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    handle.dispatchEvent(pointer("pointerdown", 53, centerOf(handle)));
    sourceIdentityReads = 0;

    runtime.reconcile();

    expect(sourceIdentityReads).toBe(0);
    window.dispatchEvent(pointer("pointercancel", 53, centerOf(handle)));
  });

  test("captures a 10k canonical source once at pointerdown, never during reconciliation", async () => {
    const sourceLength = 10_000;
    const rowIds = Object.freeze(
      Array.from({ length: sourceLength + 1 }, (_unused, index) => `ROW_ID_${String(index + 1)}`),
    );
    const { grid, structure } = createVerticalGrid(rowIds, [rowIds.at(-2)!, rowIds.at(-1)!]);
    const sourceShape = Object.freeze({
      shapeIdentity: Object.freeze({}),
      axis: "vertical" as const,
      sourceCellCount: sourceLength,
      sourceFirstIdentity: rowIds[0]!,
      sourceLastIdentity: rowIds[sourceLength - 1]!,
      perpendicularIdentity: "COL_ID_A",
      rowIds: Object.freeze(rowIds.slice(0, sourceLength)) as readonly [string, ...string[]],
      columnIds: Object.freeze(["COL_ID_A"]) as readonly [string],
      handle: Object.freeze({ rowId: rowIds.at(-2)!, columnId: "COL_ID_A" }),
    });
    let scannedCells = 0;
    const captureSource = vi.fn(() => {
      const canonicalTexts = sourceShape.rowIds.map((_rowId, index) => {
        scannedCells += 1;
        return String(index);
      });
      return Object.freeze({
        ...sourceShape,
        canonicalTexts: Object.freeze(canonicalTexts) as readonly [string, ...string[]],
      });
    });
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => sourceShape,
      captureSource,
      getStructure: () => structure,
      apply: () => Object.freeze({ kind: "accepted" as const }),
      scrollHorizontalByPhysical: () => false,
    });
    await nextFrame();
    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    handle.dispatchEvent(pointer("pointerdown", 54, centerOf(handle)));

    for (let index = 0; index < 3; index += 1) runtime.reconcile();

    expect(captureSource).toHaveBeenCalledOnce();
    expect(scannedCells).toBe(sourceLength);
    window.dispatchEvent(pointer("pointercancel", 54, centerOf(handle)));
  });

  test("contains a canonical source capture exception as an unavailable source", async () => {
    const { grid, structure } = createGrid(["COL_ID_A", "COL_ID_B"]);
    const apply = vi.fn(() => Object.freeze({ kind: "accepted" as const }));
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => source(["COL_ID_A"], ["stable"]),
      captureSource: () => {
        throw new Error("canonical formatter failed");
      },
      getStructure: () => structure,
      apply,
      scrollHorizontalByPhysical: () => false,
    });
    await nextFrame();
    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    const target = grid.querySelector<HTMLElement>('[data-bruno-column-id="COL_ID_B"]')!;
    const bubbledPointerDown = vi.fn();
    grid.addEventListener("pointerdown", bubbledPointerDown);
    const down = pointer("pointerdown", 55, centerOf(handle));

    expect(() => handle.dispatchEvent(down)).not.toThrow();
    window.dispatchEvent(pointer("pointermove", 55, centerOf(target)));
    window.dispatchEvent(pointer("pointerup", 55, centerOf(target)));

    expect(down.defaultPrevented).toBe(true);
    expect(bubbledPointerDown).not.toHaveBeenCalled();
    expect(runtime.getSnapshot().active).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  test("does not capture a canonical source for an inadmissible pointerdown", async () => {
    const { grid, structure } = createGrid(["COL_ID_A", "COL_ID_B"]);
    const captureSource = vi.fn(() => source(["COL_ID_A"], ["stable"]));
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => source(["COL_ID_A"], ["stable"]),
      captureSource,
      getStructure: () => structure,
      apply: () => Object.freeze({ kind: "accepted" as const }),
      scrollHorizontalByPhysical: () => false,
    });
    await nextFrame();
    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    const secondary = new PointerEvent("pointerdown", {
      bubbles: true,
      button: 1,
      cancelable: true,
      clientX: centerOf(handle).x,
      clientY: centerOf(handle).y,
      pointerId: 56,
    });

    handle.dispatchEvent(secondary);

    expect(captureSource).not.toHaveBeenCalled();
    expect(secondary.defaultPrevented).toBe(false);
    expect(runtime.getSnapshot().active).toBe(false);

    handle.dispatchEvent(pointer("pointerdown", 57, centerOf(handle)));
    expect(captureSource).toHaveBeenCalledOnce();
    expect(runtime.getSnapshot().active).toBe(true);
    const competingPrimary = pointer("pointerdown", 58, centerOf(handle));
    const bubbledPointerDown = vi.fn();
    grid.addEventListener("pointerdown", bubbledPointerDown);
    handle.dispatchEvent(competingPrimary);
    expect(captureSource).toHaveBeenCalledOnce();
    expect(competingPrimary.defaultPrevented).toBe(true);
    expect(bubbledPointerDown).not.toHaveBeenCalled();
    expect(runtime.getSnapshot().active).toBe(true);
    window.dispatchEvent(pointer("pointercancel", 57, centerOf(handle)));
  });

  test("rejects an oversized source before canonical capture", async () => {
    const { grid, structure } = createGrid(["COL_ID_A", "COL_ID_B"]);
    const stable = source(["COL_ID_A"], ["stable"]);
    const oversizedShape = Object.freeze({
      ...stable,
      sourceCellCount: BRUNO_TABLE_DRAG_FILL_MAX_CELLS + 1,
    });
    const captureSource = vi.fn(() => stable);
    const apply = vi.fn(() => Object.freeze({ kind: "accepted" as const }));
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => oversizedShape,
      captureSource,
      getStructure: () => structure,
      apply,
      scrollHorizontalByPhysical: () => false,
    });
    await nextFrame();
    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;

    handle.dispatchEvent(pointer("pointerdown", 65, centerOf(handle)));

    expect(captureSource).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(runtime.getNotificationSnapshot().message).toContain("at most 16384 cells.");
  });

  test("rejects an oversized destination before candidate materialization", async () => {
    const columnIds = Object.freeze(
      Array.from(
        { length: BRUNO_TABLE_DRAG_FILL_MAX_CELLS + 2 },
        (_unused, index) => `COL_ID_${String(index)}`,
      ),
    );
    const { grid, structure } = createGrid(columnIds, [columnIds[0]!, columnIds.at(-1)!]);
    const apply = vi.fn(() => Object.freeze({ kind: "accepted" as const }));
    const getStructure = vi.fn(() => structure);
    const describeCoordinate = vi.fn(
      ({ rowId, columnId }: Readonly<{ readonly rowId: string; readonly columnId: string }>) =>
        `${rowId}/${columnId}`,
    );
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => source([columnIds[0]!], ["stable"]),
      getStructure,
      apply,
      scrollHorizontalByPhysical: () => false,
      describeCoordinate,
    });
    await nextFrame();
    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    const target = grid.querySelector<HTMLElement>(
      `[data-bruno-column-id="${columnIds.at(-1)!}"]`,
    )!;
    handle.dispatchEvent(pointer("pointerdown", 66, centerOf(handle)));
    window.dispatchEvent(pointer("pointermove", 66, centerOf(target)));
    await nextFrame();
    getStructure.mockClear();
    window.dispatchEvent(pointer("pointerup", 66, centerOf(target)));

    expect(apply).not.toHaveBeenCalled();
    expect(getStructure).not.toHaveBeenCalled();
    expect(describeCoordinate).toHaveBeenCalledWith({
      rowId: "ROW_ID_1",
      columnId: "COL_ID_1",
    });
    expect(runtime.getNotificationSnapshot().message).toBe(
      "ROW_ID_1/COL_ID_1: Fill destinations may contain at most 16384 cells. (+16384 more) Nothing was applied.",
    );
  });

  test("reconciles unchanged preview cells without redundant DOM writes", async () => {
    const { grid, structure } = createGrid(["COL_ID_A", "COL_ID_B", "COL_ID_C"]);
    const second = grid.querySelector<HTMLElement>('[data-bruno-column-id="COL_ID_B"]')!;
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => source(["COL_ID_A"], ["stable"]),
      getStructure: () => structure,
      apply: () => Object.freeze({ kind: "accepted" as const }),
      scrollHorizontalByPhysical: () => false,
    });
    await nextFrame();
    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    handle.dispatchEvent(pointer("pointerdown", 167, centerOf(handle)));
    second.dispatchEvent(pointer("pointermove", 167, centerOf(second)));
    await nextFrame();
    expect(second).toHaveAttribute("data-bruno-drag-fill-preview", "");
    const observer = new MutationObserver(() => {});
    observer.observe(grid, { attributes: true, subtree: true });
    try {
      runtime.reconcile();
      runtime.reconcile();
      expect(observer.takeRecords()).toHaveLength(0);
    } finally {
      observer.disconnect();
    }
    const replacement = document.createElement("div");
    replacement.setAttribute("role", "gridcell");
    replacement.dataset["brunoRowId"] = "ROW_ID_1";
    replacement.dataset["brunoColumnId"] = "COL_ID_B";
    replacement.dataset["brunoRowIndex"] = "0";
    second.replaceWith(replacement);
    runtime.reconcile();
    expect(replacement).toHaveAttribute("data-bruno-drag-fill-preview", "");
    expect(second).not.toHaveAttribute("data-bruno-drag-fill-preview");
    expect(second.style.outline).toBe("");
    window.dispatchEvent(pointer("pointercancel", 167, centerOf(replacement)));
    expect(replacement).not.toHaveAttribute("data-bruno-drag-fill-preview");
    expect(replacement.style.outline).toBe("");
  });

  test("extends a stationary in-bounds pointer preview as autoscroll reveals cells", async () => {
    const { grid, structure } = createGrid(["COL_ID_A", "COL_ID_B", "COL_ID_C"]);
    grid.style.width = "160px";
    const second = grid.querySelector<HTMLElement>('[data-bruno-column-id="COL_ID_B"]')!;
    const third = grid.querySelector<HTMLElement>('[data-bruno-column-id="COL_ID_C"]')!;
    let sampledColumn = "COL_ID_B";
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => source(["COL_ID_A"], ["stable"]),
      getStructure: () => structure,
      apply: () => Object.freeze({ kind: "accepted" as const }),
      resolvePointerHit: () => ({ rowId: "ROW_ID_1", columnId: sampledColumn }),
      scrollHorizontalByPhysical: () => {
        if (sampledColumn === "COL_ID_C") return false;
        sampledColumn = "COL_ID_C";
        return true;
      },
    });
    await nextFrame();
    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    const bounds = grid.getBoundingClientRect();
    const edge = { x: bounds.right - 4, y: centerOf(second).y };
    handle.dispatchEvent(pointer("pointerdown", 67, centerOf(handle)));
    second.dispatchEvent(pointer("pointermove", 67, edge));
    await nextFrame();
    await nextFrame();
    expect(third).toHaveAttribute("data-bruno-drag-fill-preview", "");
    window.dispatchEvent(pointer("pointercancel", 67, edge));
  });

  test("extends the preview through cells revealed by outside-grid autoscroll", async () => {
    const { grid, structure } = createGrid(["COL_ID_A", "COL_ID_B", "COL_ID_C"]);
    const second = grid.querySelector<HTMLElement>('[data-bruno-column-id="COL_ID_B"]')!;
    const third = grid.querySelector<HTMLElement>('[data-bruno-column-id="COL_ID_C"]')!;
    let sampledTarget = second;
    vi.spyOn(document, "elementFromPoint").mockImplementation(() => sampledTarget);
    const scrollHorizontalByPhysical = vi.fn(() => {
      if (sampledTarget === second) {
        sampledTarget = third;
        return true;
      }
      return false;
    });
    const apply = vi.fn(() => Object.freeze({ kind: "accepted" as const }));
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => source(["COL_ID_A"], ["stable"]),
      getStructure: () => structure,
      apply,
      scrollHorizontalByPhysical,
    });
    await nextFrame();
    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    const bounds = grid.getBoundingClientRect();
    const outside = { x: bounds.right + 20, y: centerOf(second).y };
    handle.dispatchEvent(pointer("pointerdown", 57, centerOf(handle)));
    window.dispatchEvent(pointer("pointermove", 57, outside));
    await nextFrame();
    await nextFrame();
    window.dispatchEvent(pointer("pointerup", 57, outside));

    expect(scrollHorizontalByPhysical).toHaveBeenCalled();
    expect(apply).toHaveBeenCalledWith([
      { rowId: "ROW_ID_1", columnId: "COL_ID_B", canonicalText: "stable" },
      { rowId: "ROW_ID_1", columnId: "COL_ID_C", canonicalText: "stable" },
    ]);
  });

  test("does not scan a multi-cell source span in the first axis-acquisition frame", async () => {
    const sourceLength = 10_000;
    const logicalRowIds = Object.freeze(
      Array.from({ length: sourceLength + 1 }, (_unused, index) => `ROW_ID_${String(index + 1)}`),
    );
    const sourceRowIds = Object.freeze(logicalRowIds.slice(0, sourceLength)) as readonly [
      string,
      ...string[],
    ];
    const targetRowId = logicalRowIds.at(-1)!;
    const { grid, structure: baseStructure } = createVerticalGrid(logicalRowIds, [
      sourceRowIds.at(-1)!,
      targetRowId,
    ]);
    let sourceSpanReads = 0;
    const rowIds = new Proxy(logicalRowIds, {
      get(target, property, receiver) {
        if (
          typeof property === "string" &&
          /^\d+$/.test(property) &&
          Number(property) < sourceLength
        ) {
          sourceSpanReads += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const structure = Object.freeze({
      ...baseStructure,
      rowIds,
      rowIndexById: new Map(logicalRowIds.map((rowId, index) => [rowId, index] as const)),
    });
    const sourceSnapshot: BrunoTableDragFillSource = Object.freeze({
      shapeIdentity: Object.freeze({}),
      axis: "vertical",
      sourceCellCount: sourceRowIds.length,
      sourceFirstIdentity: sourceRowIds[0],
      sourceLastIdentity: sourceRowIds.at(-1)!,
      perpendicularIdentity: "COL_ID_A",
      rowIds: sourceRowIds,
      columnIds: Object.freeze(["COL_ID_A"]) as readonly [string],
      canonicalTexts: Object.freeze(
        sourceRowIds.map((_rowId, index) => String(index)),
      ) as readonly [string, ...string[]],
      handle: Object.freeze({ rowId: sourceRowIds.at(-1)!, columnId: "COL_ID_A" }),
    });
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => sourceSnapshot,
      getStructure: () => structure,
      apply: () => Object.freeze({ kind: "accepted" as const }),
      scrollHorizontalByPhysical: () => false,
    });
    await nextFrame();
    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    const target = grid.querySelector<HTMLElement>(`[data-bruno-row-id="${targetRowId}"]`)!;
    const targetPoint = { x: centerOf(handle).x, y: centerOf(target).y };
    handle.dispatchEvent(pointer("pointerdown", 61, centerOf(handle)));
    sourceSpanReads = 0;

    window.dispatchEvent(pointer("pointermove", 61, targetPoint));
    await nextFrame();

    expect(sourceSpanReads).toBe(0);
    window.dispatchEvent(pointer("pointercancel", 61, targetPoint));
  });

  test("replacement registration owns cleanup and ignores a late prior pointer release", async () => {
    const columns = ["COL_ID_A", "COL_ID_B"];
    const first = createGrid(columns);
    const second = createGrid(columns);
    const firstApply = vi.fn(() => Object.freeze({ kind: "accepted" as const }));
    const secondApply = vi.fn(() => Object.freeze({ kind: "accepted" as const }));
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    const unregisterFirst = runtime.register({
      grid: first.grid,
      getSourceShape: () => source(["COL_ID_A"], ["first"]),
      getStructure: () => first.structure,
      apply: firstApply,
      scrollHorizontalByPhysical: () => false,
    });
    await nextFrame();
    const firstHandle = first.grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    const firstTarget = first.grid.querySelector<HTMLElement>('[data-bruno-column-id="COL_ID_B"]')!;
    firstHandle.dispatchEvent(pointer("pointerdown", 62, centerOf(firstHandle)));
    window.dispatchEvent(pointer("pointermove", 62, centerOf(firstTarget)));
    await nextFrame();

    runtime.register({
      grid: second.grid,
      getSourceShape: () => source(["COL_ID_A"], ["second"]),
      getStructure: () => second.structure,
      apply: secondApply,
      scrollHorizontalByPhysical: () => false,
    });
    unregisterFirst();
    window.dispatchEvent(pointer("pointerup", 62, centerOf(firstTarget)));
    await nextFrame();

    expect(firstApply).not.toHaveBeenCalled();
    expect(secondApply).not.toHaveBeenCalled();
    const secondHandle = second.grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    const secondTarget = second.grid.querySelector<HTMLElement>(
      '[data-bruno-column-id="COL_ID_B"]',
    )!;
    secondHandle.dispatchEvent(pointer("pointerdown", 63, centerOf(secondHandle)));
    window.dispatchEvent(pointer("pointermove", 63, centerOf(secondTarget)));
    await nextFrame();
    window.dispatchEvent(pointer("pointerup", 63, centerOf(secondTarget)));

    expect(firstApply).not.toHaveBeenCalled();
    expect(secondApply).toHaveBeenCalledOnce();
  });

  test("fills vertically through virtual identities and scrolls only the row viewport", async () => {
    const rows = ["ROW_ID_1", "ROW_ID_2", "ROW_ID_3", "ROW_ID_4"];
    const { grid, structure } = createVerticalGrid(rows);
    grid.style.height = "160px";
    const horizontalScroll = vi.fn(() => true);
    const apply = vi.fn(() => Object.freeze({ kind: "accepted" as const }));
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => verticalSource(["ROW_ID_1", "ROW_ID_2"], ["alpha", "beta"]),
      getStructure: () => structure,
      apply,
      scrollHorizontalByPhysical: horizontalScroll,
    });
    await nextFrame();
    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    const target = grid.querySelector<HTMLElement>('[data-bruno-row-id="ROW_ID_4"]')!;
    handle.dispatchEvent(pointer("pointerdown", 49, centerOf(handle)));
    window.dispatchEvent(pointer("pointermove", 49, centerOf(target)));
    await nextFrame();
    window.dispatchEvent(pointer("pointerup", 49, centerOf(target)));

    expect(horizontalScroll).not.toHaveBeenCalled();
    expect(grid.scrollTop).toBe(0);
    expect(apply).toHaveBeenCalledWith([
      { rowId: "ROW_ID_3", columnId: "COL_ID_A", canonicalText: "alpha" },
      { rowId: "ROW_ID_4", columnId: "COL_ID_A", canonicalText: "beta" },
    ]);
  });

  test("autoscrolls vertically near the row viewport edge without horizontal work", async () => {
    const rows = ["ROW_ID_1", "ROW_ID_2", "ROW_ID_3", "ROW_ID_4", "ROW_ID_5", "ROW_ID_6"];
    const { grid, structure } = createVerticalGrid(rows);
    const horizontalScroll = vi.fn(() => true);
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => verticalSource(["ROW_ID_1"], ["stable"]),
      getStructure: () => structure,
      apply: () => Object.freeze({ kind: "accepted" as const }),
      scrollHorizontalByPhysical: horizontalScroll,
      scrollVerticalByLogical: (delta) => {
        const before = grid.scrollTop;
        grid.scrollTop += delta;
        return grid.scrollTop !== before;
      },
    });
    await nextFrame();
    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    const bounds = grid.getBoundingClientRect();
    handle.dispatchEvent(pointer("pointerdown", 51, centerOf(handle)));
    window.dispatchEvent(
      pointer("pointermove", 51, {
        x: bounds.left + bounds.width / 2,
        y: bounds.bottom - 1,
      }),
    );
    await nextFrame();

    expect(grid.scrollTop).toBeGreaterThan(0);
    expect(horizontalScroll).not.toHaveBeenCalled();
    window.dispatchEvent(pointer("pointercancel", 51, centerOf(handle)));
  });

  test("continues outside-grid autoscroll without activating in excluded overlays", async () => {
    const { grid, structure } = createGrid(["COL_ID_A", "COL_ID_B", "COL_ID_C"]);
    grid.style.height = "120px";
    const bounds = grid.getBoundingClientRect();
    const geometry = {
      bodyTop: bounds.top + 8,
      bodyBottom: bounds.bottom - 8,
      centreLeft: bounds.left + 20,
      centreRight: bounds.right - 20,
    };
    const horizontalScroll = vi.fn(() => false);
    const verticalScroll = vi.fn(() => false);
    const runtime = new BrunoTableDragFillRuntime();
    ownedRuntimes.add(runtime);
    runtime.register({
      grid,
      getSourceShape: () => source(["COL_ID_A"], ["stable"]),
      getStructure: () => structure,
      apply: () => Object.freeze({ kind: "accepted" as const }),
      interactionGeometry: () => geometry,
      scrollHorizontalByPhysical: horizontalScroll,
      scrollVerticalByLogical: verticalScroll,
    });
    await nextFrame();
    const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    handle.dispatchEvent(pointer("pointerdown", 52, centerOf(handle)));

    window.dispatchEvent(
      pointer("pointermove", 52, {
        x: (geometry.centreLeft + geometry.centreRight) / 2,
        y: bounds.top + 4,
      }),
    );
    await nextFrame();
    expect(horizontalScroll).not.toHaveBeenCalled();
    expect(verticalScroll).not.toHaveBeenCalled();

    window.dispatchEvent(pointer("pointermove", 52, { x: bounds.left + 4, y: bounds.top + 4 }));
    await nextFrame();
    expect(horizontalScroll).not.toHaveBeenCalled();
    expect(verticalScroll).not.toHaveBeenCalled();

    window.dispatchEvent(pointer("pointermove", 52, { x: bounds.left - 4, y: bounds.top + 4 }));
    await nextFrame();
    expect(horizontalScroll).toHaveBeenCalledWith(-12);
    expect(verticalScroll).not.toHaveBeenCalled();

    horizontalScroll.mockClear();
    window.dispatchEvent(pointer("pointermove", 52, { x: bounds.right - 4, y: bounds.top + 4 }));
    await nextFrame();
    expect(horizontalScroll).not.toHaveBeenCalled();

    window.dispatchEvent(pointer("pointermove", 52, { x: bounds.right + 4, y: bounds.top + 4 }));
    await nextFrame();
    expect(horizontalScroll).toHaveBeenCalledWith(12);
    window.dispatchEvent(pointer("pointercancel", 52, centerOf(handle)));
    await nextFrame();

    const verticalHandle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
    const verticalStart = centerOf(verticalHandle);
    verticalHandle.dispatchEvent(pointer("pointerdown", 54, verticalStart));

    window.dispatchEvent(
      pointer("pointermove", 54, {
        x: verticalStart.x,
        y: (geometry.bodyTop + geometry.bodyBottom) / 2,
      }),
    );
    await nextFrame();
    expect(verticalScroll).not.toHaveBeenCalled();

    window.dispatchEvent(pointer("pointermove", 54, { x: verticalStart.x, y: bounds.top + 4 }));
    await nextFrame();
    expect(verticalScroll).not.toHaveBeenCalled();

    window.dispatchEvent(pointer("pointermove", 54, { x: verticalStart.x, y: bounds.top - 4 }));
    await nextFrame();
    expect(verticalScroll).toHaveBeenCalledWith(-12);

    verticalScroll.mockClear();
    window.dispatchEvent(pointer("pointermove", 54, { x: verticalStart.x, y: bounds.bottom - 4 }));
    await nextFrame();
    expect(verticalScroll).not.toHaveBeenCalled();

    window.dispatchEvent(pointer("pointermove", 54, { x: verticalStart.x, y: bounds.bottom + 4 }));
    await nextFrame();
    expect(verticalScroll).toHaveBeenCalledWith(12);
    window.dispatchEvent(pointer("pointercancel", 54, centerOf(verticalHandle)));
  });

  test("records scheduled, ran, and cancelled Drag Fill frames only for its table", async () => {
    const { grid, structure } = createGrid(["COL_ID_A", "COL_ID_B"]);
    const frames: BrunoTableDragFillFrameEvent[] = [];
    const disposeDiagnostics = installBrunoTableClientDragFillFrameListener("orders", (event) => {
      frames.push(event);
    });
    try {
      const runtime = new BrunoTableDragFillRuntime("orders");
      ownedRuntimes.add(runtime);
      runtime.register({
        grid,
        getSourceShape: () => source(["COL_ID_A"], ["stable"]),
        getStructure: () => structure,
        apply: () => Object.freeze({ kind: "accepted" as const }),
        scrollHorizontalByPhysical: () => false,
      });
      await nextFrame();
      const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]")!;
      const target = grid.querySelector<HTMLElement>('[data-bruno-column-id="COL_ID_B"]')!;
      handle.dispatchEvent(pointer("pointerdown", 53, centerOf(handle)));
      window.dispatchEvent(pointer("pointermove", 53, centerOf(target)));
      await nextFrame();
      window.dispatchEvent(pointer("pointermove", 53, centerOf(target)));
      window.dispatchEvent(pointer("pointercancel", 53, centerOf(target)));

      expect(frames.map((frame) => frame.phase)).toEqual([
        "scheduled",
        "ran",
        "scheduled",
        "cancelled",
      ]);
    } finally {
      disposeDiagnostics();
    }
  });
});
