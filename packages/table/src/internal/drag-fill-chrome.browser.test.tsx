import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { createBrunoTableCellRangeStructure } from "./cell-range-clipboard";
import { BrunoTableDragFillChrome } from "./drag-fill-chrome";
import { BrunoTableDragFillRuntime } from "./drag-fill";

afterEach(async () => {
  await cleanup();
  document.querySelectorAll('[data-drag-fill-chrome-fixture=""]').forEach((fixture) => {
    fixture.remove();
  });
});

describe("BrunoTable Drag Fill notification chrome", () => {
  test("preserves a persistent rejection across chrome unmount and remount", async () => {
    const runtime = new BrunoTableDragFillRuntime();
    const grid = createGridFixture();
    const structure = createBrunoTableCellRangeStructure(
      ["ROW_ID_1"],
      ["COL_ID_SOURCE", "COL_ID_TARGET"],
    );
    const sourceShapeIdentity = Object.freeze({});
    runtime.register({
      grid,
      getSourceShape: () =>
        Object.freeze({
          shapeIdentity: sourceShapeIdentity,
          axis: "horizontal" as const,
          sourceCellCount: 1,
          sourceFirstIdentity: "COL_ID_SOURCE",
          sourceLastIdentity: "COL_ID_SOURCE",
          perpendicularIdentity: "ROW_ID_1",
          rowIds: Object.freeze(["ROW_ID_1"]) as readonly [string],
          columnIds: Object.freeze(["COL_ID_SOURCE"]) as readonly [string],
          canonicalTexts: Object.freeze(["source"]) as readonly [string],
          handle: Object.freeze({ rowId: "ROW_ID_1", columnId: "COL_ID_SOURCE" }),
        }),
      getStructure: () => structure,
      apply: () =>
        Object.freeze({
          kind: "rejected" as const,
          reason: "invalid-value" as const,
          detail: "Expected a valid destination value.",
          rowId: "ROW_ID_1",
          columnId: "COL_ID_TARGET",
        }),
      scrollHorizontalByPhysical: () => false,
      describeCoordinate: () => "Row 1, Target",
    });

    try {
      const chrome = await render(<BrunoTableDragFillChrome runtime={runtime} />);
      await nextFrame();
      rejectFill(grid);

      await vi.waitFor(() => {
        expect(runtime.getNotificationSnapshot().message).toContain(
          "Expected a valid destination value.",
        );
      });
      const notifications = chrome.getByRole("region", { name: "Notifications", exact: true });
      await expect.element(notifications).toHaveTextContent("Expected a valid destination value.");
      const retainedMessage = runtime.getNotificationSnapshot().message;

      await chrome.unmount();

      expect(runtime.getNotificationSnapshot().message).toBe(retainedMessage);

      const remountedChrome = await render(<BrunoTableDragFillChrome runtime={runtime} />);
      await expect
        .element(remountedChrome.getByRole("region", { name: "Notifications", exact: true }))
        .toHaveTextContent(retainedMessage);
    } finally {
      runtime.dispose();
    }
  });

  test("replaces successive rejections and ignores a stale dismissal", async () => {
    const runtime = new BrunoTableDragFillRuntime();
    const grid = createGridFixture();
    const structure = createBrunoTableCellRangeStructure(
      ["ROW_ID_1"],
      ["COL_ID_SOURCE", "COL_ID_TARGET"],
    );
    const sourceShapeIdentity = Object.freeze({});
    const apply = vi
      .fn()
      .mockReturnValueOnce(
        Object.freeze({
          kind: "rejected" as const,
          reason: "invalid-value" as const,
          detail: "First rejection.",
        }),
      )
      .mockReturnValueOnce(
        Object.freeze({
          kind: "rejected" as const,
          reason: "blocked" as const,
          detail: "Second rejection.",
        }),
      );
    runtime.register({
      grid,
      getSourceShape: () =>
        Object.freeze({
          shapeIdentity: sourceShapeIdentity,
          axis: "horizontal" as const,
          sourceCellCount: 1,
          sourceFirstIdentity: "COL_ID_SOURCE",
          sourceLastIdentity: "COL_ID_SOURCE",
          perpendicularIdentity: "ROW_ID_1",
          rowIds: Object.freeze(["ROW_ID_1"]) as readonly [string],
          columnIds: Object.freeze(["COL_ID_SOURCE"]) as readonly [string],
          canonicalTexts: Object.freeze(["source"]) as readonly [string],
          handle: Object.freeze({ rowId: "ROW_ID_1", columnId: "COL_ID_SOURCE" }),
        }),
      getStructure: () => structure,
      apply,
      scrollHorizontalByPhysical: () => false,
    });

    try {
      const chrome = await render(<BrunoTableDragFillChrome runtime={runtime} />);
      await nextFrame();
      rejectFill(grid, 102);
      await vi.waitFor(() =>
        expect(runtime.getNotificationSnapshot().message).toContain("First rejection."),
      );
      const firstSequence = runtime.getNotificationSnapshot().sequence;
      await nextFrame();

      rejectFill(grid, 103);
      await vi.waitFor(() => {
        expect(runtime.getNotificationSnapshot().message).toContain("Second rejection.");
      });
      const notifications = chrome.getByRole("region", { name: "Notifications", exact: true });
      await expect.element(notifications).toHaveTextContent("Second rejection.");
      await expect.element(notifications).not.toHaveTextContent("First rejection.");
      expect(
        notifications.getByRole("button", { name: "Close toast", exact: true }).all(),
      ).toHaveLength(1);

      runtime.dismissNotification(firstSequence);
      expect(runtime.getNotificationSnapshot().message).toContain("Second rejection.");
      await userEvent.click(
        notifications.getByRole("button", { name: "Close toast", exact: true }),
      );
      await vi.waitFor(() => expect(runtime.getNotificationSnapshot().message).toBe(""));
    } finally {
      runtime.dispose();
    }
  });
});

function createGridFixture(): HTMLElement {
  const grid = document.createElement("div");
  grid.dataset["dragFillChromeFixture"] = "";
  grid.setAttribute("role", "grid");
  grid.style.display = "flex";
  grid.style.height = "40px";
  grid.style.width = "160px";
  for (const columnId of ["COL_ID_SOURCE", "COL_ID_TARGET"]) {
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
    cell.append(content);
    grid.append(cell);
  }
  document.body.append(grid);
  return grid;
}

function rejectFill(grid: HTMLElement, pointerId = 101): void {
  const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]");
  const target = grid.querySelector<HTMLElement>('[data-bruno-column-id="COL_ID_TARGET"]');
  if (handle === null || target === null) throw new Error("Expected mounted Drag Fill controls.");
  const start = centerOf(handle);
  const end = centerOf(target);
  handle.dispatchEvent(pointer("pointerdown", pointerId, start));
  window.dispatchEvent(pointer("pointermove", pointerId, end));
  window.dispatchEvent(pointer("pointerup", pointerId, end));
}

function centerOf(element: Element): Readonly<{ x: number; y: number }> {
  const bounds = element.getBoundingClientRect();
  return Object.freeze({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 });
}

function pointer(
  type: "pointerdown" | "pointermove" | "pointerup",
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

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}
