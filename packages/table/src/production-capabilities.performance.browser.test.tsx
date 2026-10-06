import { detectPlatform } from "@tanstack/react-hotkeys";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { BrunoTableClient } from "./index";
import type { BrunoTableColumnId, BrunoTableColumns } from "./public-types";
import { settleBrunoTableBrowserFrames } from "./internal/browser-test-helpers";
import { installBrunoTableClientEditFooterRenderListenerForTable } from "./internal/render-instrumentation";

type CapabilityField = `value_${string}`;
type CapabilityRow = Readonly<{
  readonly id: string;
  readonly revision: bigint;
}> &
  Readonly<Record<CapabilityField, string>>;

const ROW_COUNT = 5_000;
const COLUMN_COUNT = 150;
const CAPABILITY_TRANSITION_WAIT_TIMEOUT_MS = 10_000;
const capabilityRows = Object.freeze(
  Array.from({ length: ROW_COUNT }, (_unused, index): CapabilityRow => {
    const suffix = String(index).padStart(4, "0");
    const values = Object.fromEntries(
      Array.from({ length: COLUMN_COUNT }, (_columnUnused, columnIndex) => {
        const columnSuffix = String(columnIndex).padStart(3, "0");
        return [`value_${columnSuffix}`, `value-${columnSuffix}-${suffix}`] as const;
      }),
    ) as Readonly<Record<CapabilityField, string>>;
    return Object.freeze({
      ...values,
      id: `capability-row-${String(index).padStart(4, "0")}`,
      revision: 1n,
    });
  }),
);
const capabilityColumns = Object.freeze(
  Array.from(
    { length: COLUMN_COUNT },
    (_unused, index): BrunoTableColumns<CapabilityRow>[number] => {
      const field = `value_${String(index).padStart(3, "0")}` as CapabilityField;
      return Object.freeze({
        columnId: `COL_ID_CAPABILITY_${String(index).padStart(3, "0")}` as BrunoTableColumnId,
        field,
        headerName: `Capability ${String(index).padStart(3, "0")}`,
        valueType: "text" as const,
        width: 120,
        isEditable: true as const,
        ...(index === 0 ? { pinned: "start" as const } : {}),
        ...(index === COLUMN_COUNT - 1 ? { pinned: "end" as const } : {}),
      });
    },
  ),
);

function pasteGesture(): string {
  return detectPlatform() === "mac" ? "{Meta>}v{/Meta}" : "{Control>}v{/Control}";
}

function installClipboard(text: string): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { readText: vi.fn(async () => text) },
  });
  return () => {
    if (descriptor === undefined) delete (navigator as { clipboard?: Clipboard }).clipboard;
    else Object.defineProperty(navigator, "clipboard", descriptor);
  };
}

function centerOf(element: Element): Readonly<{ readonly x: number; readonly y: number }> {
  const bounds = element.getBoundingClientRect();
  return Object.freeze({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 });
}

function pointer(
  type: "pointerdown" | "pointermove" | "pointerup",
  pointerId: number,
  point: Readonly<{ readonly x: number; readonly y: number }>,
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

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

describe("BrunoTable production capability matrix", () => {
  test("keeps Batch paste, fill, and conflict evidence accessible in the 5,000x150 fixture", async () => {
    const restoreClipboard = installClipboard("paste-first\tpaste-second");
    const onSaveEdits = vi.fn(() => Promise.resolve());
    const renderTable = (rows: readonly CapabilityRow[], version: number) => (
      <div style={{ height: 480, width: 1_024 }}>
        <BrunoTableClient
          tableId="TABLE_ID_PRODUCTION_CAPABILITIES"
          getRowId={(row: CapabilityRow) => row.id}
          columns={capabilityColumns}
          initialOrderBy={[{ columnId: "COL_ID_CAPABILITY_000", direction: "asc" }]}
          clientSource={{ rows, totalRows: rows.length, version, status: "ready" }}
          editable
          getRowVersion={(row) => row.revision}
          onSaveEdits={onSaveEdits}
        />
      </div>
    );
    try {
      const screen = await render(renderTable(capabilityRows, 1));
      await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
      const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_PRODUCTION_CAPABILITIES" });
      grid.element().focus();
      await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
      await userEvent.keyboard(pasteGesture());
      await vi.waitFor(
        () => {
          expect(
            grid.getByRole("gridcell", { name: "paste-first", exact: true }).all(),
          ).toHaveLength(1);
          expect(
            grid.getByRole("gridcell", { name: "paste-second", exact: true }).all(),
          ).toHaveLength(1);
        },
        { timeout: CAPABILITY_TRANSITION_WAIT_TIMEOUT_MS },
      );

      const handle = grid.element().querySelector<HTMLElement>("[data-bruno-drag-fill-handle]");
      const target = grid
        .element()
        .querySelector<HTMLElement>(
          '[data-bruno-row-id="capability-row-0000"][data-bruno-column-id="COL_ID_CAPABILITY_003"]',
        );
      if (handle === null) throw new Error("The selected production range must expose Drag Fill.");
      if (target === null) throw new Error("The production Drag Fill destination must be mounted.");
      handle.dispatchEvent(pointer("pointerdown", 29, centerOf(handle)));
      target.dispatchEvent(pointer("pointermove", 29, centerOf(target)));
      await settleBrunoTableBrowserFrames();
      target.dispatchEvent(pointer("pointerup", 29, centerOf(target)));
      await vi.waitFor(
        () => {
          expect(
            grid
              .element()
              .querySelector<HTMLElement>(
                '[data-bruno-row-id="capability-row-0000"][data-bruno-column-id="COL_ID_CAPABILITY_002"]',
              )?.textContent,
          ).toBe("paste-first");
          expect(
            grid
              .element()
              .querySelector<HTMLElement>(
                '[data-bruno-row-id="capability-row-0000"][data-bruno-column-id="COL_ID_CAPABILITY_003"]',
              )?.textContent,
          ).toBe("paste-second");
        },
        { timeout: CAPABILITY_TRANSITION_WAIT_TIMEOUT_MS },
      );
      expect(onSaveEdits).not.toHaveBeenCalled();

      const conflictedRows = capabilityRows.with(
        0,
        Object.freeze({ ...capabilityRows[0]!, value_000: "0-server-first", revision: 2n }),
      );
      await screen.rerender(renderTable(conflictedRows, 2));
      const conflictControl = screen.getByRole("button", { name: "1 conflict" });
      await expect.element(conflictControl).toBeVisible();
      const conflictedCell = grid
        .element()
        .querySelector<HTMLElement>(
          '[data-bruno-row-id="capability-row-0000"][data-bruno-column-id="COL_ID_CAPABILITY_000"]',
        );
      if (conflictedCell === null)
        throw new Error("The conflicted production cell must be mounted.");
      expect(conflictedCell.getAttribute("data-bruno-edit-conflicted")).toBe("");
      const conflictIndicator = conflictedCell.querySelector<HTMLElement>(
        "[data-bruno-edit-conflict-indicator]",
      );
      if (conflictIndicator === null)
        throw new Error("The conflicted production cell must expose its conflict indicator.");
      expect(conflictIndicator.getAttribute("title")).toBe(
        "Conflicts with the latest server value",
      );
      conflictControl.element().focus();
      await userEvent.keyboard("{Enter}");
      await expect
        .element(screen.getByRole("alertdialog", { name: "Conflict review" }))
        .toBeVisible();
      await userEvent.keyboard("{Escape}");
      await expect.element(conflictControl).toHaveFocus();
      expect(screen.getByRole("columnheader").all().length).toBeLessThan(20);
      expect(screen.getByRole("gridcell").all().length).toBeLessThan(250);
    } finally {
      restoreClipboard();
    }
  }, 30_000);

  test("does not wake the stable Edit Safety Footer during 20 Hz live publications", async () => {
    const tableId = "TABLE_ID_PRODUCTION_EDIT_FOOTER_20_HZ";
    const footerRenders = vi.fn();
    const removeFooterListener = installBrunoTableClientEditFooterRenderListenerForTable(
      tableId,
      footerRenders,
    );
    const onSaveEdits = vi.fn(() => Promise.resolve());
    const renderTable = (sourceRows: readonly CapabilityRow[], version: number) => (
      <div style={{ height: 480, width: 1_024 }}>
        <BrunoTableClient
          tableId={tableId}
          getRowId={(row: CapabilityRow) => row.id}
          columns={capabilityColumns}
          initialOrderBy={[{ columnId: "COL_ID_CAPABILITY_000", direction: "asc" }]}
          clientSource={{
            rows: sourceRows,
            totalRows: sourceRows.length,
            version,
            status: "ready",
          }}
          editable
          getRowVersion={(row) => row.revision}
          onSaveEdits={onSaveEdits}
        />
      </div>
    );
    try {
      const screen = await render(renderTable(capabilityRows, 1));
      await expect.element(screen.getByRole("region", { name: "Edit safety" })).toBeVisible();
      const grid = screen.getByRole("grid", { name: `Data for ${tableId}` });
      await vi.waitFor(
        () => {
          const mountedCellCount = grid.getByRole("gridcell").all().length;
          expect(mountedCellCount).toBeGreaterThan(0);
          expect(mountedCellCount).toBeLessThan(250);
        },
        { timeout: CAPABILITY_TRANSITION_WAIT_TIMEOUT_MS },
      );
      footerRenders.mockClear();
      let liveRows = capabilityRows;
      for (let publication = 1; publication <= 20; publication += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        liveRows = Object.freeze(
          liveRows.with(
            1,
            Object.freeze({
              ...liveRows[1]!,
              revision: BigInt(publication + 1),
              value_149: `live-${String(publication).padStart(2, "0")}`,
            }),
          ),
        );
        await screen.rerender(renderTable(liveRows, publication + 1));
      }
      await settleBrunoTableBrowserFrames(2);
      await expect
        .element(grid.getByRole("gridcell", { name: "live-20", exact: true }))
        .toBeInTheDocument();
      expect(footerRenders).not.toHaveBeenCalled();
      expect(onSaveEdits).not.toHaveBeenCalled();
    } finally {
      removeFooterListener();
    }
  }, 30_000);
});
