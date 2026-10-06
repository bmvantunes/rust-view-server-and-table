import { detectPlatform, getHotkeyManager } from "@tanstack/react-hotkeys";
import { StrictMode } from "react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { BrunoTableClient, BrunoTableQuickFilter, BrunoTableToolbar } from "./index";
import { settleBrunoTableBrowserFrames } from "./internal/browser-test-helpers";
import {
  installBrunoTableCellRangeInstrumentationListener,
  type BrunoTableCellRangeInstrumentationEvent,
} from "./internal/cell-range-clipboard";
import type { BrunoTableClientSource, BrunoTableColumnId, BrunoTableColumns } from "./public-types";

type Row = Readonly<{
  readonly id: string;
  readonly name: string;
  readonly score: number;
  readonly quantity: bigint;
}>;

const columns = [
  {
    columnId: "COL_ID_NAME",
    field: "name",
    headerName: "Name",
    valueType: "text",
    width: 180,
  },
  {
    columnId: "COL_ID_SCORE",
    field: "score",
    headerName: "Score",
    valueType: "number",
    width: 180,
  },
  {
    columnId: "COL_ID_QUANTITY",
    field: "quantity",
    headerName: "Quantity",
    valueType: "bigint",
    width: 240,
    valueFormatter: ({ value }) => `${value.toString()} displayed`,
  },
] satisfies BrunoTableColumns<Row>;

const rows = [
  { id: "ada", name: "Ada", score: 4, quantity: 9_007_199_254_740_993n },
  { id: "babbage", name: "Babbage", score: 2, quantity: 9_007_199_254_740_995n },
  { id: "curie", name: "Curie", score: 3, quantity: 9_007_199_254_740_997n },
] satisfies readonly Row[];

function source(nextRows: readonly Row[] = rows, version = 1) {
  return {
    rows: nextRows,
    totalRows: nextRows.length,
    version,
    status: "ready" as const,
  };
}

function table(tableId: string, nextRows: readonly Row[] = rows, version = 1) {
  return tableWithSource(tableId, source(nextRows, version));
}

function tableWithSource(tableId: string, clientSource: BrunoTableClientSource<Row>) {
  return (
    <BrunoTableClient
      tableId={tableId}
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={clientSource}
      getRowId={(row) => row.id}
    />
  );
}

function copyGesture(): string {
  return detectPlatform() === "mac" ? "{Meta>}c{/Meta}" : "{Control>}c{/Control}";
}

function installClipboard(writeText: (text: string) => Promise<void>): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(writeText) },
  });
  return () => {
    if (descriptor === undefined) delete (navigator as { clipboard?: Clipboard }).clipboard;
    else Object.defineProperty(navigator, "clipboard", descriptor);
  };
}

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

describe("BrunoTableClient one-axis Cell Range and atomic Copy", () => {
  test("shares one anchor across click and Shift keyboard extensions without creating a rectangle", async () => {
    const writes: string[] = [];
    const restoreClipboard = installClipboard(async (text) => {
      writes.push(text);
    });
    try {
      await render(table("TABLE_ID_CELL_RANGE_KEYBOARD"));
      const grid = page.getByRole("grid", { name: "Data for TABLE_ID_CELL_RANGE_KEYBOARD" });
      await expect.element(grid).toHaveAttribute("aria-multiselectable", "true");
      grid.element().focus();

      const activeBeforeUnanchoredGridEdge = grid.element().getAttribute("aria-activedescendant");
      await userEvent.keyboard(
        detectPlatform() === "mac"
          ? "{Meta>}{Shift>}{Home}{/Shift}{/Meta}"
          : "{Control>}{Shift>}{Home}{/Shift}{/Control}",
      );
      expect(grid.element().getAttribute("aria-activedescendant")).toBe(
        activeBeforeUnanchoredGridEdge,
      );
      await expect
        .element(page.getByRole("gridcell", { name: "Ada" }))
        .not.toHaveAttribute("aria-selected");

      await userEvent.keyboard("{Shift>}{ArrowRight}{ArrowRight}{/Shift}");
      await settleBrunoTableBrowserFrames();
      const activeBeforePerpendicularPage = grid.element().getAttribute("aria-activedescendant");
      const perpendicularPagePublications: MutationRecord[] = [];
      const perpendicularPageObserver = new MutationObserver((records) =>
        perpendicularPagePublications.push(...records),
      );
      perpendicularPageObserver.observe(grid.element(), {
        attributes: true,
        attributeFilter: ["aria-activedescendant"],
      });
      await userEvent.keyboard("{Shift>}{PageDown}{/Shift}");
      await settleBrunoTableBrowserFrames();
      perpendicularPageObserver.disconnect();
      expect(perpendicularPagePublications).toHaveLength(0);
      expect(grid.element().getAttribute("aria-activedescendant")).toBe(
        activeBeforePerpendicularPage,
      );
      await expect
        .element(page.getByRole("gridcell", { name: "Ada" }))
        .toHaveAttribute("aria-selected", "true");
      await expect
        .element(page.getByRole("gridcell", { name: "4", exact: true }))
        .toHaveAttribute("aria-selected", "true");
      await expect
        .element(page.getByRole("gridcell", { name: "9007199254740993 displayed", exact: true }))
        .toHaveAttribute("aria-selected", "true");
      await expect
        .element(page.getByRole("gridcell", { name: "Babbage" }))
        .not.toHaveAttribute("aria-selected");

      await userEvent.keyboard(copyGesture());
      await vi.waitFor(() => expect(writes).toEqual(["Ada\t4\t9007199254740993"]));
      await userEvent.keyboard("{Escape}");
      await settleBrunoTableBrowserFrames();
      await expect
        .element(page.getByRole("gridcell", { name: "Ada" }))
        .not.toHaveAttribute("aria-selected");
      await expect
        .element(page.getByRole("gridcell", { name: "9007199254740993 displayed", exact: true }))
        .toHaveAttribute("aria-selected", "true");

      await userEvent.click(page.getByRole("gridcell", { name: "Ada" }));
      const curie = page.getByRole("gridcell", { name: "Curie" });
      await userEvent.keyboard("{Shift>}");
      curie.element().dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          pointerId: 11,
          shiftKey: false,
        }),
      );
      curie.element().dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          cancelable: true,
          pointerId: 11,
          shiftKey: false,
        }),
      );
      await userEvent.keyboard("{/Shift}");
      await settleBrunoTableBrowserFrames();
      await userEvent.keyboard(copyGesture());
      await vi.waitFor(() => expect(writes.at(-1)).toBe("Ada\nBabbage\nCurie"));

      await userEvent.click(page.getByRole("gridcell", { name: "Babbage" }));
      await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
      await settleBrunoTableBrowserFrames();
      await userEvent.keyboard(copyGesture());
      await vi.waitFor(() => expect(writes.at(-1)).toBe("Babbage\nCurie"));
      const activeBeforePerpendicularEdge = grid.element().getAttribute("aria-activedescendant");
      const perpendicularEdgePublications: MutationRecord[] = [];
      const perpendicularEdgeObserver = new MutationObserver((records) =>
        perpendicularEdgePublications.push(...records),
      );
      perpendicularEdgeObserver.observe(grid.element(), {
        attributes: true,
        attributeFilter: ["aria-activedescendant"],
      });
      await userEvent.keyboard("{Shift>}{End}{/Shift}");
      await settleBrunoTableBrowserFrames();
      perpendicularEdgeObserver.disconnect();
      expect(perpendicularEdgePublications).toHaveLength(0);
      expect(grid.element().getAttribute("aria-activedescendant")).toBe(
        activeBeforePerpendicularEdge,
      );
      await expect
        .element(page.getByRole("gridcell", { name: "2", exact: true }))
        .not.toHaveAttribute("aria-selected");

      await userEvent.click(page.getByRole("gridcell", { name: "Babbage" }));
      await userEvent.keyboard("{Shift>}{ArrowUp}{/Shift}");
      await settleBrunoTableBrowserFrames();
      await expect
        .element(page.getByRole("gridcell", { name: "Ada" }))
        .toHaveAttribute("aria-selected", "true");
      await userEvent.keyboard("{Shift>}{ArrowUp}{/Shift}");
      await settleBrunoTableBrowserFrames();
      await expect
        .element(page.getByRole("gridcell", { name: "Ada" }))
        .toHaveAttribute("aria-selected", "true");
      await expect
        .element(page.getByRole("gridcell", { name: "Babbage" }))
        .toHaveAttribute("aria-selected", "true");

      await userEvent.click(page.getByRole("gridcell", { name: "Curie" }));
      await userEvent.keyboard(
        detectPlatform() === "mac"
          ? "{Meta>}{Shift>}{ArrowUp}{/Shift}{/Meta}"
          : "{Control>}{Shift>}{ArrowUp}{/Shift}{/Control}",
      );
      await settleBrunoTableBrowserFrames();
      const ada = page.getByRole("gridcell", { name: "Ada" });
      expect(grid.element().getAttribute("aria-activedescendant")).toBe(ada.element().id);
      await expect.element(ada).toHaveAttribute("aria-selected", "true");
      await expect
        .element(page.getByRole("gridcell", { name: "Babbage" }))
        .toHaveAttribute("aria-selected", "true");
      await expect
        .element(page.getByRole("gridcell", { name: "Curie" }))
        .toHaveAttribute("aria-selected", "true");
    } finally {
      restoreClipboard();
    }
  });

  test.each(["keyboard", "pointer"] as const)(
    "reseeds a surviving anchor from the reset Active Cell before the first Shift %s extension",
    async (interaction) => {
      const tableId = `TABLE_ID_CELL_RANGE_QUERY_RESET_ANCHOR_${interaction.toUpperCase()}`;
      const writes: string[] = [];
      const events: BrunoTableCellRangeInstrumentationEvent[] = [];
      const restoreClipboard = installClipboard(async (text) => {
        writes.push(text);
      });
      const removeInstrumentation = installBrunoTableCellRangeInstrumentationListener(
        tableId,
        (event) => events.push(event),
      );
      try {
        await render(
          <BrunoTableClient
            tableId={tableId}
            columns={columns}
            initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
            clientSource={source()}
            getRowId={(row) => row.id}
            quickFilterFields={["name"]}
          >
            <BrunoTableToolbar>
              <BrunoTableQuickFilter />
            </BrunoTableToolbar>
          </BrunoTableClient>,
        );
        await userEvent.click(page.getByRole("gridcell", { name: "Babbage" }));
        await userEvent.fill(page.getByRole("searchbox", { name: "Quick Filter" }), "a");
        const grid = page.getByRole("grid", { name: `Data for ${tableId}` });
        await vi.waitFor(() =>
          expect(grid.element().getAttribute("aria-activedescendant")).toBe(
            page.getByRole("gridcell", { name: "Ada" }).element().id,
          ),
        );
        await settleBrunoTableBrowserFrames();
        await expect
          .element(page.getByRole("gridcell", { name: "Ada" }))
          .toHaveAttribute("aria-selected", "true");
        await expect
          .element(page.getByRole("gridcell", { name: "Babbage" }))
          .not.toHaveAttribute("aria-selected");
        grid.element().focus();
        await userEvent.keyboard(copyGesture());
        await vi.waitFor(() => expect(writes).toEqual(["Ada"]));
        writes.length = 0;
        events.length = 0;
        if (interaction === "keyboard") {
          grid.element().focus();
          await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
        } else {
          await userEvent.click(page.getByRole("gridcell", { name: "Babbage" }), {
            modifiers: ["Shift"],
          });
        }
        await settleBrunoTableBrowserFrames();

        await expect
          .element(page.getByRole("gridcell", { name: "Ada" }))
          .toHaveAttribute("aria-selected", "true");
        await expect
          .element(page.getByRole("gridcell", { name: "Babbage" }))
          .toHaveAttribute("aria-selected", "true");
        expect(events.filter((event) => event.kind === "publication")).toHaveLength(1);
        await userEvent.keyboard(copyGesture());
        await vi.waitFor(() => expect(writes).toEqual(["Ada\nBabbage"]));
      } finally {
        removeInstrumentation();
        restoreClipboard();
      }
    },
  );

  test("resumes a retained range from its exact focus after Active Cell resets inside the span", async () => {
    const tableId = "TABLE_ID_CELL_RANGE_RETAINED_FOCUS";
    const writes: string[] = [];
    const events: BrunoTableCellRangeInstrumentationEvent[] = [];
    const restoreClipboard = installClipboard(async (text) => {
      writes.push(text);
    });
    const removeInstrumentation = installBrunoTableCellRangeInstrumentationListener(
      tableId,
      (event) => events.push(event),
    );
    try {
      await render(
        <BrunoTableClient
          tableId={tableId}
          columns={columns}
          initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
          clientSource={source()}
          getRowId={(row) => row.id}
          quickFilterFields={["name"]}
        >
          <BrunoTableToolbar>
            <BrunoTableQuickFilter />
          </BrunoTableToolbar>
        </BrunoTableClient>,
      );
      const grid = page.getByRole("grid", { name: `Data for ${tableId}` });
      grid.element().focus();
      await userEvent.keyboard("{Shift>}{ArrowRight}{ArrowRight}{/Shift}");
      await userEvent.fill(page.getByRole("searchbox", { name: "Quick Filter" }), "a");
      await vi.waitFor(() =>
        expect(grid.element().getAttribute("aria-activedescendant")).toBe(
          page.getByRole("gridcell", { name: "Ada" }).element().id,
        ),
      );
      events.length = 0;

      grid.element().focus();
      await userEvent.keyboard("{Shift>}{ArrowLeft}{/Shift}");
      await settleBrunoTableBrowserFrames();

      expect(grid.element().getAttribute("aria-activedescendant")).toBe(
        page.getByRole("gridcell", { name: "4", exact: true }).element().id,
      );
      await expect
        .element(page.getByRole("gridcell", { name: "Ada" }))
        .toHaveAttribute("aria-selected", "true");
      await expect
        .element(page.getByRole("gridcell", { name: "4", exact: true }))
        .toHaveAttribute("aria-selected", "true");
      await expect
        .element(page.getByRole("gridcell", { name: "9007199254740993 displayed", exact: true }))
        .not.toHaveAttribute("aria-selected");
      expect(events.filter((event) => event.kind === "publication")).toHaveLength(1);
      await userEvent.keyboard(copyGesture());
      await vi.waitFor(() => expect(writes).toEqual(["Ada\t4"]));
    } finally {
      removeInstrumentation();
      restoreClipboard();
    }
  });

  test("copies a retained range after committed sorting clears the body Active Cell", async () => {
    const writes: string[] = [];
    const restoreClipboard = installClipboard(async (text) => {
      writes.push(text);
    });
    try {
      await render(table("TABLE_ID_CELL_RANGE_COPY_WITHOUT_ACTIVE_BODY"));
      const grid = page.getByRole("grid", {
        name: "Data for TABLE_ID_CELL_RANGE_COPY_WITHOUT_ACTIVE_BODY",
      });
      grid.element().focus();
      await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
      await userEvent.click(page.getByRole("button", { name: "Sort by Score" }));
      await settleBrunoTableBrowserFrames();
      expect(grid.element().getAttribute("aria-activedescendant")).toBe(
        page.getByRole("columnheader", { name: "Score" }).element().id,
      );

      grid.element().focus();
      await userEvent.keyboard(copyGesture());
      await vi.waitFor(() => expect(writes).toEqual(["Ada\t4"]));
      await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
      await userEvent.keyboard(copyGesture());
      await vi.waitFor(() => expect(writes.at(-1)).toBe("Ada\t4\t9007199254740993"));
      await userEvent.keyboard("{Escape}");
      await settleBrunoTableBrowserFrames();
      await expect
        .element(page.getByRole("gridcell", { name: "Ada" }))
        .not.toHaveAttribute("aria-selected");
      await expect
        .element(page.getByRole("gridcell", { name: "4", exact: true }))
        .not.toHaveAttribute("aria-selected");

      await userEvent.click(page.getByRole("gridcell", { name: "Ada" }));
      await userEvent.click(page.getByRole("button", { name: "Sort by Name" }));
      grid.element().focus();
      await userEvent.keyboard(copyGesture());
      await settleBrunoTableBrowserFrames();
      expect(writes).toEqual(["Ada\t4", "Ada\t4\t9007199254740993"]);
    } finally {
      restoreClipboard();
    }
  });

  test("locks pointer drag to the dominant axis after slop and batches mounted work by frame", async () => {
    const events: BrunoTableCellRangeInstrumentationEvent[] = [];
    const removeInstrumentation = installBrunoTableCellRangeInstrumentationListener(
      "TABLE_ID_CELL_RANGE_POINTER",
      (event) => events.push(event),
    );
    try {
      await render(table("TABLE_ID_CELL_RANGE_POINTER"));
      await settleBrunoTableBrowserFrames();
      events.length = 0;
      const ada = page.getByRole("gridcell", { name: "Ada" });
      const curieQuantity = page.getByRole("gridcell", {
        name: "9007199254740997 displayed",
        exact: true,
      });
      ada.element().dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: 10,
          clientY: 10,
          pointerId: 19,
        }),
      );
      curieQuantity.element().dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          cancelable: true,
          clientX: 13,
          clientY: 13,
          pointerId: 19,
        }),
      );
      await settleBrunoTableBrowserFrames();
      await expect
        .element(page.getByRole("gridcell", { name: "4", exact: true }))
        .not.toHaveAttribute("aria-selected");

      for (let index = 0; index < 8; index += 1) {
        curieQuantity.element().dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            cancelable: true,
            clientX: 30 + index,
            clientY: 17,
            pointerId: 19,
          }),
        );
      }
      await settleBrunoTableBrowserFrames();
      curieQuantity.element().dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          cancelable: true,
          clientX: 37,
          clientY: 17,
          pointerId: 19,
        }),
      );
      await settleBrunoTableBrowserFrames();

      await expect
        .element(page.getByRole("gridcell", { name: "9007199254740993 displayed", exact: true }))
        .toHaveAttribute("aria-selected", "true");
      await expect
        .element(page.getByRole("gridcell", { name: "9007199254740997 displayed", exact: true }))
        .not.toHaveAttribute("aria-selected");
      const pointerFrames = events.filter((event) => event.kind === "pointer-frame");
      expect(pointerFrames.length).toBeLessThanOrEqual(3);
      const decorations = events.filter(
        (
          event,
        ): event is Extract<
          BrunoTableCellRangeInstrumentationEvent,
          { readonly kind: "mounted-decoration" }
        > => event.kind === "mounted-decoration",
      );
      expect(decorations.length).toBeGreaterThan(0);
      expect(Math.max(...decorations.map((event) => event.mountedCellCount))).toBeLessThanOrEqual(
        9,
      );

      const grid = page.getByRole("grid", { name: "Data for TABLE_ID_CELL_RANGE_POINTER" });
      const activeBeforeCancel = grid.element().getAttribute("aria-activedescendant");
      const babbage = page.getByRole("gridcell", { name: "Babbage" });
      babbage.element().dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: 10,
          clientY: 10,
          pointerId: 20,
        }),
      );
      curieQuantity.element().dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          cancelable: true,
          clientX: 17,
          clientY: 30,
          pointerId: 20,
        }),
      );
      await settleBrunoTableBrowserFrames();
      curieQuantity.element().dispatchEvent(
        new PointerEvent("pointercancel", {
          bubbles: true,
          cancelable: true,
          pointerId: 20,
        }),
      );
      await settleBrunoTableBrowserFrames();
      expect(grid.element().getAttribute("aria-activedescendant")).toBe(activeBeforeCancel);
      await expect
        .element(page.getByRole("gridcell", { name: "9007199254740993 displayed", exact: true }))
        .toHaveAttribute("aria-selected", "true");
    } finally {
      removeInstrumentation();
    }
  });

  test("rejects keyboard navigation while a pointer range workflow owns the anchor", async () => {
    const tableId = "TABLE_ID_CELL_RANGE_POINTER_KEYBOARD_OWNERSHIP";
    const events: BrunoTableCellRangeInstrumentationEvent[] = [];
    const writes: string[] = [];
    const removeInstrumentation = installBrunoTableCellRangeInstrumentationListener(
      tableId,
      (event) => events.push(event),
    );
    const restoreClipboard = installClipboard(async (text) => {
      writes.push(text);
    });
    try {
      await render(table(tableId));
      await settleBrunoTableBrowserFrames();
      const grid = page.getByRole("grid", { name: `Data for ${tableId}` });
      const ada = page.getByRole("gridcell", { name: "Ada", exact: true });
      const quantity = page.getByRole("gridcell", {
        name: "9007199254740993 displayed",
        exact: true,
      });
      const adaBounds = ada.element().getBoundingClientRect();
      const quantityBounds = quantity.element().getBoundingClientRect();
      ada.element().dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: adaBounds.left + adaBounds.width / 2,
          clientY: adaBounds.top + adaBounds.height / 2,
          pointerId: 58,
        }),
      );
      quantity.element().dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          cancelable: true,
          clientX: quantityBounds.left + quantityBounds.width / 2,
          clientY: quantityBounds.top + quantityBounds.height / 2,
          pointerId: 58,
        }),
      );
      await settleBrunoTableBrowserFrames();
      await expect.element(ada).toHaveAttribute("aria-selected", "true");
      await expect.element(quantity).toHaveAttribute("aria-selected", "true");
      const activeBeforeNavigation = grid.element().getAttribute("aria-activedescendant");
      const publicationsBeforeNavigation = events.filter(
        (event) => event.kind === "publication",
      ).length;

      grid.element().focus();
      const navigation = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "ArrowLeft",
      });
      grid.element().dispatchEvent(navigation);
      await settleBrunoTableBrowserFrames();
      expect(navigation.defaultPrevented).toBe(true);
      expect(grid.element().getAttribute("aria-activedescendant")).toBe(activeBeforeNavigation);
      expect(events.filter((event) => event.kind === "publication")).toHaveLength(
        publicationsBeforeNavigation,
      );

      quantity.element().dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          cancelable: true,
          clientX: quantityBounds.left + quantityBounds.width / 2,
          clientY: quantityBounds.top + quantityBounds.height / 2,
          pointerId: 58,
        }),
      );
      await settleBrunoTableBrowserFrames();
      await userEvent.keyboard(copyGesture());
      await vi.waitFor(() => expect(writes).toEqual(["Ada\t4\t9007199254740993"]));
    } finally {
      restoreClipboard();
      removeInstrumentation();
    }
  });

  test("completes a vertical-dominant diagonal drag by projecting onto the anchor column", async () => {
    const writes: string[] = [];
    const restoreClipboard = installClipboard(async (text) => {
      writes.push(text);
    });
    try {
      await render(table("TABLE_ID_CELL_RANGE_VERTICAL_POINTER"));
      const adaScore = page.getByRole("gridcell", { name: "4", exact: true });
      const curieQuantity = page.getByRole("gridcell", {
        name: "9007199254740997 displayed",
        exact: true,
      });
      adaScore.element().dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: 10,
          clientY: 10,
          pointerId: 21,
        }),
      );
      curieQuantity.element().dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          cancelable: true,
          clientX: 17,
          clientY: 30,
          pointerId: 21,
        }),
      );
      await settleBrunoTableBrowserFrames();
      curieQuantity.element().dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          cancelable: true,
          clientX: 17,
          clientY: 30,
          pointerId: 21,
        }),
      );
      await settleBrunoTableBrowserFrames();

      await expect.element(adaScore).toHaveAttribute("aria-selected", "true");
      await expect
        .element(page.getByRole("gridcell", { name: "2", exact: true }))
        .toHaveAttribute("aria-selected", "true");
      await expect
        .element(page.getByRole("gridcell", { name: "3", exact: true }))
        .toHaveAttribute("aria-selected", "true");
      await expect.element(curieQuantity).not.toHaveAttribute("aria-selected");
      await userEvent.keyboard(copyGesture());
      await vi.waitFor(() => expect(writes.at(-1)).toBe("4\n2\n3"));
    } finally {
      restoreClipboard();
    }
  });

  test("projects a distinct release hit without scrolling or scheduling later work", async () => {
    const tableId = "TABLE_ID_CELL_RANGE_POINTER_UP_PROJECTION";
    const writes: string[] = [];
    const events: BrunoTableCellRangeInstrumentationEvent[] = [];
    const restoreClipboard = installClipboard(async (text) => {
      writes.push(text);
    });
    const removeInstrumentation = installBrunoTableCellRangeInstrumentationListener(
      tableId,
      (event) => events.push(event),
    );
    try {
      await render(table(tableId));
      const grid = page.getByRole("grid", { name: `Data for ${tableId}` });
      const adaScore = page.getByRole("gridcell", { name: "4", exact: true });
      const babbageScore = page.getByRole("gridcell", { name: "2", exact: true });
      const curieScore = page.getByRole("gridcell", { name: "3", exact: true });
      const adaBounds = adaScore.element().getBoundingClientRect();
      const babbageBounds = babbageScore.element().getBoundingClientRect();
      const curieBounds = curieScore.element().getBoundingClientRect();
      const center = (bounds: DOMRect) => ({
        clientX: bounds.left + bounds.width / 2,
        clientY: bounds.top + bounds.height / 2,
      });

      adaScore.element().dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          pointerId: 48,
          ...center(adaBounds),
        }),
      );
      babbageScore.element().dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          cancelable: true,
          pointerId: 48,
          ...center(babbageBounds),
        }),
      );
      await settleBrunoTableBrowserFrames();
      expect(grid.element().getAttribute("aria-activedescendant")).toBe(babbageScore.element().id);
      const scrollTopBeforeRelease = grid.element().scrollTop;
      const scrollLeftBeforeRelease = grid.element().scrollLeft;

      curieScore.element().dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          cancelable: true,
          pointerId: 48,
          ...center(curieBounds),
        }),
      );
      expect(grid.element().scrollTop).toBe(scrollTopBeforeRelease);
      expect(grid.element().scrollLeft).toBe(scrollLeftBeforeRelease);
      expect(grid.element().getAttribute("aria-activedescendant")).toBe(curieScore.element().id);
      await expect.element(adaScore).toHaveAttribute("aria-selected", "true");
      await expect.element(babbageScore).toHaveAttribute("aria-selected", "true");
      await expect.element(curieScore).toHaveAttribute("aria-selected", "true");
      const workAfterRelease = events.filter(
        (event) => event.kind === "pointer-frame" || event.kind === "publication",
      ).length;
      await settleBrunoTableBrowserFrames(3);
      expect(
        events.filter((event) => event.kind === "pointer-frame" || event.kind === "publication"),
      ).toHaveLength(workAfterRelease);

      await userEvent.keyboard(copyGesture());
      await vi.waitFor(() => expect(writes).toEqual(["4\n2\n3"]));
    } finally {
      removeInstrumentation();
      restoreClipboard();
    }
  });

  test("retains a valid drag across unrelated structure movement and restores by Row Identity", async () => {
    const screen = await render(table("TABLE_ID_CELL_RANGE_GESTURE_RECONCILE"));
    const grid = page.getByRole("grid", { name: "Data for TABLE_ID_CELL_RANGE_GESTURE_RECONCILE" });
    const adaScore = page.getByRole("gridcell", { name: "4", exact: true });
    await userEvent.click(adaScore);
    const initialAdaCellId = adaScore.element().id;
    expect(grid.element().getAttribute("aria-activedescendant")).toBe(initialAdaCellId);

    adaScore.element().dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 10,
        clientY: 10,
        pointerId: 27,
      }),
    );
    page
      .getByRole("gridcell", { name: "2", exact: true })
      .element()
      .dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          cancelable: true,
          clientX: 17,
          clientY: 30,
          pointerId: 27,
        }),
      );
    await settleBrunoTableBrowserFrames();
    await screen.rerender(
      table(
        "TABLE_ID_CELL_RANGE_GESTURE_RECONCILE",
        rows.map((row) => (row.id === "curie" ? { ...row, name: "Aaron" } : row)),
        2,
      ),
    );
    await settleBrunoTableBrowserFrames();
    await expect
      .element(page.getByRole("gridcell", { name: "4", exact: true }))
      .toHaveAttribute("aria-selected", "true");
    await expect
      .element(page.getByRole("gridcell", { name: "2", exact: true }))
      .toHaveAttribute("aria-selected", "true");

    grid.element().dispatchEvent(
      new PointerEvent("pointercancel", {
        bubbles: true,
        cancelable: true,
        pointerId: 27,
      }),
    );
    await settleBrunoTableBrowserFrames();
    const movedAdaScore = page.getByRole("gridcell", { name: "4", exact: true });
    expect(grid.element().getAttribute("aria-activedescendant")).toBe(movedAdaScore.element().id);
    await expect.element(movedAdaScore).toHaveAttribute("aria-selected", "true");
    await expect
      .element(page.getByRole("gridcell", { name: "2", exact: true }))
      .not.toHaveAttribute("aria-selected");
  });

  test("keeps a tied diagonal Shift-click on its visible one-cell anchor", async () => {
    await render(table("TABLE_ID_CELL_RANGE_TIED_SHIFT_POINTER"));
    const grid = page.getByRole("grid", {
      name: "Data for TABLE_ID_CELL_RANGE_TIED_SHIFT_POINTER",
    });
    const babbageScore = page.getByRole("gridcell", { name: "2", exact: true });
    await userEvent.click(babbageScore);
    const curieQuantity = page.getByRole("gridcell", {
      name: "9007199254740997 displayed",
      exact: true,
    });
    await userEvent.keyboard("{Shift>}");
    curieQuantity.element().dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerId: 28,
        shiftKey: false,
      }),
    );
    curieQuantity.element().dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        cancelable: true,
        pointerId: 28,
        shiftKey: false,
      }),
    );
    await userEvent.keyboard("{/Shift}");
    await settleBrunoTableBrowserFrames();
    expect(grid.element().getAttribute("aria-activedescendant")).toBe(babbageScore.element().id);
    await expect.element(babbageScore).toHaveAttribute("aria-selected", "true");
    await expect.element(curieQuantity).not.toHaveAttribute("aria-selected");
  });

  test("keeps native label interaction outside Cell Range ownership", async () => {
    const changed = vi.fn();
    const labelColumns = [
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
        width: 180,
        cellRenderer: ({ row }: { readonly row: Row }) => (
          <label>
            <input
              aria-label={`Toggle ${row.name}`}
              type="checkbox"
              onChange={() => changed(row.id)}
            />
            <span role="note" aria-label={`Toggle ${row.name} label`}>
              Toggle {row.name}
            </span>
          </label>
        ),
      },
      columns[1]!,
      columns[2]!,
    ] satisfies BrunoTableColumns<Row>;
    await render(
      <BrunoTableClient
        tableId="TABLE_ID_CELL_RANGE_NATIVE_LABEL"
        columns={labelColumns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={source()}
        getRowId={(row) => row.id}
      />,
    );
    const checkbox = page.getByRole("checkbox", { name: "Toggle Ada" });
    await userEvent.click(page.getByRole("note", { name: "Toggle Ada label" }));
    await settleBrunoTableBrowserFrames();
    expect(changed).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledWith("ada");
    expect(document.activeElement).toBe(checkbox.element());
    const selectedCells = page.getByRole("gridcell", { selected: true }).all();
    expect(selectedCells).toHaveLength(0);

    const grid = page.getByRole("grid", { name: "Data for TABLE_ID_CELL_RANGE_NATIVE_LABEL" });
    grid.element().focus();
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(document.activeElement).toBe(checkbox.element()));
  });

  test("does not start a range gesture from focusable custom cell content", async () => {
    const interactiveColumns = [
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
        width: 180,
        cellRenderer: ({ row }: { readonly row: Row }) => (
          <article aria-label={`Focusable ${row.name}`} tabIndex={0}>
            {row.name}
          </article>
        ),
      },
      {
        columnId: "COL_ID_SCORE",
        field: "score",
        headerName: "Score",
        valueType: "number",
        width: 180,
      },
      {
        columnId: "COL_ID_QUANTITY",
        field: "quantity",
        headerName: "Quantity",
        valueType: "bigint",
        width: 240,
      },
    ] satisfies BrunoTableColumns<Row>;
    await render(
      <BrunoTableClient
        tableId="TABLE_ID_CELL_RANGE_INTERACTIVE"
        columns={interactiveColumns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={source()}
        getRowId={(row) => row.id}
      />,
    );
    const score = page.getByRole("gridcell", { name: "4", exact: true });
    await userEvent.click(score);
    await settleBrunoTableBrowserFrames();
    const focusable = page.getByRole("article", { name: "Focusable Babbage" });
    focusable.element().dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 10,
        clientY: 10,
        pointerId: 25,
      }),
    );
    page
      .getByRole("gridcell", { name: "3", exact: true })
      .element()
      .dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          cancelable: true,
          clientX: 30,
          clientY: 10,
          pointerId: 25,
        }),
      );
    await settleBrunoTableBrowserFrames();
    await expect.element(score).toHaveAttribute("aria-selected", "true");
    await expect
      .element(page.getByRole("gridcell", { name: "3", exact: true }))
      .not.toHaveAttribute("aria-selected");

    score.element().dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 10,
        clientY: 10,
        pointerId: 26,
      }),
    );
    const curieScore = page.getByRole("gridcell", { name: "3", exact: true });
    curieScore.element().dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        cancelable: true,
        clientX: 17,
        clientY: 30,
        pointerId: 26,
      }),
    );
    await settleBrunoTableBrowserFrames();
    curieScore.element().dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        cancelable: true,
        clientX: 17,
        clientY: 30,
        pointerId: 26,
      }),
    );
    await settleBrunoTableBrowserFrames();
    await expect.element(score).toHaveAttribute("aria-selected", "true");
    await expect.element(curieScore).toHaveAttribute("aria-selected", "true");
  });

  test("keeps pointer range gestures active after Strict Mode effect replay", async () => {
    const tableId = "TABLE_ID_CELL_RANGE_STRICT_MODE_POINTER";
    const events: BrunoTableCellRangeInstrumentationEvent[] = [];
    const removeInstrumentation = installBrunoTableCellRangeInstrumentationListener(
      tableId,
      (event) => events.push(event),
    );
    const writes: string[] = [];
    const restoreClipboard = installClipboard(async (text) => {
      writes.push(text);
    });
    try {
      await render(<StrictMode>{table(tableId)}</StrictMode>);
      const grid = page.getByRole("grid", { name: `Data for ${tableId}` });
      const anchor = page.getByRole("gridcell", { name: "4", exact: true });
      const target = page.getByRole("gridcell", { name: "3", exact: true });
      const anchorBounds = anchor.element().getBoundingClientRect();
      const targetBounds = target.element().getBoundingClientRect();
      anchor.element().dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: anchorBounds.left + anchorBounds.width / 2,
          clientY: anchorBounds.top + anchorBounds.height / 2,
          pointerId: 40,
        }),
      );
      target.element().dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          cancelable: true,
          clientX: targetBounds.left + targetBounds.width / 2,
          clientY: targetBounds.top + targetBounds.height / 2,
          pointerId: 40,
        }),
      );
      await settleBrunoTableBrowserFrames();
      target.element().dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          cancelable: true,
          clientX: targetBounds.left + targetBounds.width / 2,
          clientY: targetBounds.top + targetBounds.height / 2,
          pointerId: 40,
        }),
      );
      await settleBrunoTableBrowserFrames();
      await expect.element(anchor).toHaveAttribute("aria-selected", "true");
      await expect.element(target).toHaveAttribute("aria-selected", "true");
      await userEvent.keyboard(copyGesture());
      await vi.waitFor(() => expect(writes).toEqual(["4\n2\n3"]));

      const workAfterCommit = events.filter(
        (event) => event.kind === "pointer-frame" || event.kind === "publication",
      ).length;
      target
        .element()
        .dispatchEvent(
          new PointerEvent("pointermove", { bubbles: true, cancelable: true, pointerId: 40 }),
        );
      target
        .element()
        .dispatchEvent(
          new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 40 }),
        );
      await settleBrunoTableBrowserFrames();
      expect(
        events.filter((event) => event.kind === "pointer-frame" || event.kind === "publication"),
      ).toHaveLength(workAfterCommit);

      const secondAnchor = page.getByRole("gridcell", { name: "Ada", exact: true });
      const secondTarget = page.getByRole("gridcell", { name: "Curie", exact: true });
      const secondAnchorBounds = secondAnchor.element().getBoundingClientRect();
      const secondTargetBounds = secondTarget.element().getBoundingClientRect();
      secondAnchor.element().dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: secondAnchorBounds.left + secondAnchorBounds.width / 2,
          clientY: secondAnchorBounds.top + secondAnchorBounds.height / 2,
          pointerId: 44,
        }),
      );
      secondTarget.element().dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          cancelable: true,
          clientX: secondTargetBounds.left + secondTargetBounds.width / 2,
          clientY: secondTargetBounds.top + secondTargetBounds.height / 2,
          pointerId: 44,
        }),
      );
      await settleBrunoTableBrowserFrames();
      secondTarget
        .element()
        .dispatchEvent(
          new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 44 }),
        );
      await settleBrunoTableBrowserFrames();
      await expect.element(secondAnchor).toHaveAttribute("aria-selected", "true");
      await expect.element(secondTarget).toHaveAttribute("aria-selected", "true");
      expect(grid.element().getAttribute("aria-activedescendant")).toBe(secondTarget.element().id);
    } finally {
      restoreClipboard();
      removeInstrumentation();
    }
  });

  test("cancels an active range gesture from document Escape after focus leaves the grid", async () => {
    const tableId = "TABLE_ID_CELL_RANGE_OUTSIDE_ESCAPE";
    const events: BrunoTableCellRangeInstrumentationEvent[] = [];
    const removeInstrumentation = installBrunoTableCellRangeInstrumentationListener(
      tableId,
      (event) => events.push(event),
    );
    try {
      await render(
        <>
          <input aria-label="Outside range focus" />
          {table(tableId)}
        </>,
      );
      const ada = page.getByRole("gridcell", { name: "Ada", exact: true });
      const babbage = page.getByRole("gridcell", { name: "Babbage", exact: true });
      const curie = page.getByRole("gridcell", { name: "Curie", exact: true });
      await userEvent.click(ada);
      const babbageBounds = babbage.element().getBoundingClientRect();
      const curieBounds = curie.element().getBoundingClientRect();
      babbage.element().dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: babbageBounds.left + babbageBounds.width / 2,
          clientY: babbageBounds.top + babbageBounds.height / 2,
          pointerId: 46,
        }),
      );
      curie.element().dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          cancelable: true,
          clientX: curieBounds.left + curieBounds.width / 2,
          clientY: curieBounds.top + curieBounds.height / 2,
          pointerId: 46,
        }),
      );
      await settleBrunoTableBrowserFrames();
      await expect.element(babbage).toHaveAttribute("aria-selected", "true");
      await expect.element(curie).toHaveAttribute("aria-selected", "true");

      const outside = page.getByRole("textbox", { name: "Outside range focus" });
      outside.element().focus();
      const escape = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      });
      outside.element().dispatchEvent(escape);
      await settleBrunoTableBrowserFrames();

      expect(escape.defaultPrevented).toBe(true);
      await expect.element(outside).toHaveFocus();
      await expect.element(ada).toHaveAttribute("aria-selected", "true");
      await expect.element(babbage).not.toHaveAttribute("aria-selected");
      await expect.element(curie).not.toHaveAttribute("aria-selected");
      const workAfterEscape = events.filter(
        (event) => event.kind === "pointer-frame" || event.kind === "publication",
      ).length;
      curie
        .element()
        .dispatchEvent(
          new PointerEvent("pointermove", { bubbles: true, cancelable: true, pointerId: 46 }),
        );
      curie
        .element()
        .dispatchEvent(
          new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 46 }),
        );
      await settleBrunoTableBrowserFrames();
      expect(
        events.filter((event) => event.kind === "pointer-frame" || event.kind === "publication"),
      ).toHaveLength(workAfterEscape);
    } finally {
      removeInstrumentation();
    }
  });

  test("routes document Escape only to the sibling table with an active range gesture", async () => {
    await render(
      <>
        {table("TABLE_ID_CELL_RANGE_ESCAPE_ACTIVE")}
        {table("TABLE_ID_CELL_RANGE_ESCAPE_FOCUSED")}
      </>,
    );
    const activeGrid = page.getByRole("grid", {
      name: "Data for TABLE_ID_CELL_RANGE_ESCAPE_ACTIVE",
    });
    const focusedGrid = page.getByRole("grid", {
      name: "Data for TABLE_ID_CELL_RANGE_ESCAPE_FOCUSED",
    });
    const activeAda = activeGrid.getByRole("gridcell", { name: "Ada", exact: true });
    const activeBabbage = activeGrid.getByRole("gridcell", { name: "Babbage", exact: true });
    const activeCurie = activeGrid.getByRole("gridcell", { name: "Curie", exact: true });
    const focusedAda = focusedGrid.getByRole("gridcell", { name: "Ada", exact: true });
    const focusedScore = focusedGrid.getByRole("gridcell", { name: "4", exact: true });

    focusedGrid.element().focus();
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    await settleBrunoTableBrowserFrames();
    await expect.element(focusedAda).toHaveAttribute("aria-selected", "true");
    await expect.element(focusedScore).toHaveAttribute("aria-selected", "true");

    await userEvent.click(activeAda);
    const babbageBounds = activeBabbage.element().getBoundingClientRect();
    const curieBounds = activeCurie.element().getBoundingClientRect();
    activeBabbage.element().dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: babbageBounds.left + babbageBounds.width / 2,
        clientY: babbageBounds.top + babbageBounds.height / 2,
        pointerId: 59,
      }),
    );
    activeCurie.element().dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        cancelable: true,
        clientX: curieBounds.left + curieBounds.width / 2,
        clientY: curieBounds.top + curieBounds.height / 2,
        pointerId: 59,
      }),
    );
    await settleBrunoTableBrowserFrames();
    await expect.element(activeBabbage).toHaveAttribute("aria-selected", "true");
    await expect.element(activeCurie).toHaveAttribute("aria-selected", "true");

    focusedGrid.element().focus();
    const firstEscape = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    });
    focusedGrid.element().dispatchEvent(firstEscape);
    await settleBrunoTableBrowserFrames();
    expect(firstEscape.defaultPrevented).toBe(true);
    await expect.element(activeBabbage).toHaveAttribute("aria-selected", "true");
    await expect.element(activeCurie).toHaveAttribute("aria-selected", "true");
    await expect.element(focusedAda).not.toHaveAttribute("aria-selected");
    await expect.element(focusedScore).toHaveAttribute("aria-selected", "true");

    const outsideEscape = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    });
    document.body.dispatchEvent(outsideEscape);
    await settleBrunoTableBrowserFrames();
    expect(outsideEscape.defaultPrevented).toBe(true);
    await expect.element(activeAda).toHaveAttribute("aria-selected", "true");
    await expect.element(activeBabbage).not.toHaveAttribute("aria-selected");
    await expect.element(activeCurie).not.toHaveAttribute("aria-selected");
    await expect.element(focusedAda).not.toHaveAttribute("aria-selected");
    await expect.element(focusedScore).toHaveAttribute("aria-selected", "true");
  });

  test("cancels an armed drag before replacing its grid owner", async () => {
    const tableId = "TABLE_ID_CELL_RANGE_GRID_REPLACEMENT";
    const events: BrunoTableCellRangeInstrumentationEvent[] = [];
    const removeInstrumentation = installBrunoTableCellRangeInstrumentationListener(
      tableId,
      (event) => events.push(event),
    );
    const renderTable = (rowSelection: true | undefined) => (
      <BrunoTableClient
        tableId={tableId}
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={source()}
        getRowId={(row) => row.id}
        {...(rowSelection === true ? { rowSelection } : {})}
      />
    );
    try {
      const screen = await render(renderTable(undefined));
      const originalGrid = page.getByRole("grid", { name: `Data for ${tableId}` });
      const originalGridElement = originalGrid.element();
      originalGrid.element().focus();
      await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
      await settleBrunoTableBrowserFrames();
      expect(originalGrid.element().getAttribute("aria-activedescendant")).toBe(
        page.getByRole("gridcell", { name: "4", exact: true }).element().id,
      );
      const originalAnchor = page.getByRole("gridcell", { name: "Babbage", exact: true });
      const originalBounds = originalAnchor.element().getBoundingClientRect();
      originalAnchor.element().dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: originalBounds.left + originalBounds.width / 2,
          clientY: originalBounds.top + originalBounds.height / 2,
          pointerId: 41,
        }),
      );

      await screen.rerender(renderTable(true));
      await settleBrunoTableBrowserFrames();
      const replacementGrid = page.getByRole("grid", { name: `Data for ${tableId}` });
      expect(replacementGrid.element()).not.toBe(originalGridElement);
      expect(replacementGrid.element().getAttribute("aria-activedescendant")).toBe(
        page.getByRole("gridcell", { name: "4", exact: true }).element().id,
      );
      await expect
        .element(page.getByRole("gridcell", { name: "Ada", exact: true }))
        .toHaveAttribute("aria-selected", "true");
      await expect
        .element(page.getByRole("gridcell", { name: "4", exact: true }))
        .toHaveAttribute("aria-selected", "true");
      await expect
        .element(page.getByRole("gridcell", { name: "Babbage", exact: true }))
        .not.toHaveAttribute("aria-selected");
      events.length = 0;
      replacementGrid
        .element()
        .dispatchEvent(
          new PointerEvent("pointermove", { bubbles: true, cancelable: true, pointerId: 41 }),
        );
      replacementGrid
        .element()
        .dispatchEvent(
          new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 41 }),
        );
      await settleBrunoTableBrowserFrames();
      expect(
        events.filter((event) => event.kind === "pointer-frame" || event.kind === "publication"),
      ).toHaveLength(0);
      const anchor = page.getByRole("gridcell", { name: "4", exact: true });
      const target = page.getByRole("gridcell", { name: "3", exact: true });
      const anchorBounds = anchor.element().getBoundingClientRect();
      const targetBounds = target.element().getBoundingClientRect();
      anchor.element().dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: anchorBounds.left + anchorBounds.width / 2,
          clientY: anchorBounds.top + anchorBounds.height / 2,
          pointerId: 43,
        }),
      );
      target.element().dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          cancelable: true,
          clientX: targetBounds.left + targetBounds.width / 2,
          clientY: targetBounds.top + targetBounds.height / 2,
          pointerId: 43,
        }),
      );
      await settleBrunoTableBrowserFrames();
      target.element().dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          cancelable: true,
          clientX: targetBounds.left + targetBounds.width / 2,
          clientY: targetBounds.top + targetBounds.height / 2,
          pointerId: 43,
        }),
      );
      await settleBrunoTableBrowserFrames();

      await expect.element(anchor).toHaveAttribute("aria-selected", "true");
      await expect.element(target).toHaveAttribute("aria-selected", "true");
    } finally {
      removeInstrumentation();
    }
  });

  test("keeps nested grid range decoration owned by the nearest grid", async () => {
    const innerRows = [
      { id: "inner", name: "Inner", score: 1, quantity: 9_007_199_254_740_999n },
    ] satisfies readonly Row[];
    const innerColumns = [columns[0]!] satisfies BrunoTableColumns<Row>;
    const outerColumns = [
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
        width: 260,
        cellRenderer: ({ row }: { readonly row: Row }) =>
          row.id === "ada" ? (
            <BrunoTableClient
              tableId="TABLE_ID_NESTED_RANGE_INNER"
              columns={innerColumns}
              initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
              clientSource={source(innerRows)}
              getRowId={(innerRow) => innerRow.id}
            />
          ) : (
            row.name
          ),
      },
      columns[1]!,
    ] satisfies BrunoTableColumns<Row>;
    await render(
      <BrunoTableClient
        tableId="TABLE_ID_NESTED_RANGE_OUTER"
        columns={outerColumns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={source()}
        getRowId={(row) => row.id}
      />,
    );
    const innerGrid = page.getByRole("grid", { name: "Data for TABLE_ID_NESTED_RANGE_INNER" });
    const innerCell = innerGrid.getByRole("gridcell", { name: "Inner", exact: true });
    await userEvent.click(innerCell);
    await settleBrunoTableBrowserFrames();
    await expect.element(innerCell).toHaveAttribute("aria-selected", "true");

    const outerScore = page.getByRole("gridcell", { name: "4", exact: true });
    await userEvent.click(outerScore);
    await settleBrunoTableBrowserFrames();
    await expect.element(outerScore).toHaveAttribute("aria-selected", "true");
    await expect.element(innerCell).toHaveAttribute("aria-selected", "true");
  });

  test("bounds edge autoscroll publications and mounted decoration work by animation frame", async () => {
    const tableId = "TABLE_ID_CELL_RANGE_AUTOSCROLL";
    const writes: string[] = [];
    const restoreClipboard = installClipboard(async (text) => {
      writes.push(text);
    });
    const events: BrunoTableCellRangeInstrumentationEvent[] = [];
    const removeInstrumentation = installBrunoTableCellRangeInstrumentationListener(
      tableId,
      (event) => events.push(event),
    );
    const manyRows = Array.from({ length: 100 }, (_, index) => ({
      id: `row-${String(index).padStart(3, "0")}`,
      name: `Row ${String(index).padStart(3, "0")}`,
      score: index,
      quantity: BigInt(index),
    }));
    try {
      await render(<div style={{ width: 480 }}>{table(tableId, manyRows)}</div>);
      await settleBrunoTableBrowserFrames();
      events.length = 0;
      const grid = page.getByRole("grid", { name: `Data for ${tableId}` });
      const anchor = page.getByRole("gridcell", { name: "Row 000", exact: true }).first();
      const bounds = grid.element().getBoundingClientRect();
      const start = anchor.element().getBoundingClientRect();
      const startX = start.left + start.width / 2;
      const startY = start.top + start.height / 2;
      const initialScrollLeft = grid.element().scrollLeft;
      const initialScrollTop = grid.element().scrollTop;

      anchor.element().dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: startX,
          clientY: startY,
          pointerId: 22,
        }),
      );
      const scrollbarY = bounds.bottom - 1;
      const ownerDocument = grid.element().ownerDocument;
      const originalElementFromPoint = ownerDocument.elementFromPoint.bind(ownerDocument);
      const elementFromPoint = vi
        .spyOn(ownerDocument, "elementFromPoint")
        .mockImplementation((x, y) =>
          y === scrollbarY ? grid.element() : originalElementFromPoint(x, y),
        );
      grid.element().dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          cancelable: true,
          clientX: startX + 5,
          clientY: scrollbarY,
          pointerId: 22,
        }),
      );
      await settleBrunoTableBrowserFrames(4);

      expect(grid.element().scrollTop).toBeGreaterThan(initialScrollTop);
      expect(grid.element().scrollLeft).toBe(initialScrollLeft);
      const activeCellId = grid.element().getAttribute("aria-activedescendant");
      expect(activeCellId).not.toBe(anchor.element().id);
      const newlyRevealedName =
        page
          .getByRole("gridcell")
          .all()
          .find((cell) => cell.element().id === activeCellId)
          ?.element().textContent ?? "";
      expect(newlyRevealedName).toMatch(/^Row 0\d\d$/);
      expect(
        page
          .getByRole("gridcell")
          .all()
          .filter((cell) => cell.element().getAttribute("aria-selected") === "true").length,
      ).toBeGreaterThan(1);
      elementFromPoint.mockRestore();
      const pointerFrames = events.filter((event) => event.kind === "pointer-frame");
      const publications = events.filter((event) => event.kind === "publication");
      const decorations = events.filter(
        (
          event,
        ): event is Extract<
          BrunoTableCellRangeInstrumentationEvent,
          { readonly kind: "mounted-decoration" }
        > => event.kind === "mounted-decoration",
      );
      expect(pointerFrames.length).toBeGreaterThan(0);
      expect(pointerFrames.length).toBeLessThanOrEqual(5);
      expect(publications.length).toBeLessThanOrEqual(pointerFrames.length + 1);
      expect(decorations.length).toBeGreaterThan(0);
      expect(Math.max(...decorations.map((event) => event.mountedCellCount))).toBeLessThanOrEqual(
        60,
      );

      grid.element().scrollTop = grid.element().scrollHeight;
      await settleBrunoTableBrowserFrames(3);
      const framesAtVerticalClamp = events.filter((event) => event.kind === "pointer-frame").length;
      await settleBrunoTableBrowserFrames(3);
      expect(events.filter((event) => event.kind === "pointer-frame")).toHaveLength(
        framesAtVerticalClamp,
      );

      grid.element().dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          cancelable: true,
          clientX: startX + 5,
          clientY: scrollbarY,
          pointerId: 22,
        }),
      );
      const framesAfterRelease = events.filter((event) => event.kind === "pointer-frame").length;
      await settleBrunoTableBrowserFrames(3);
      expect(events.filter((event) => event.kind === "pointer-frame")).toHaveLength(
        framesAfterRelease,
      );
      await userEvent.keyboard(copyGesture());
      await vi.waitFor(() => expect(writes).toHaveLength(1));
      expect(writes[0]?.split("\n")).toContain(newlyRevealedName);
    } finally {
      restoreClipboard();
      removeInstrumentation();
    }
  });

  test("decorates only the one-axis mounted delta for one-cell endpoint steps", async () => {
    const tableId = "TABLE_ID_CELL_RANGE_DECORATION_DELTA";
    const events: BrunoTableCellRangeInstrumentationEvent[] = [];
    const removeInstrumentation = installBrunoTableCellRangeInstrumentationListener(
      tableId,
      (event) => events.push(event),
    );
    try {
      await render(table(tableId));
      await settleBrunoTableBrowserFrames();
      const grid = page.getByRole("grid", { name: `Data for ${tableId}` });
      grid.element().focus();
      await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
      await settleBrunoTableBrowserFrames();

      events.length = 0;
      await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
      await settleBrunoTableBrowserFrames();
      const horizontal = events.filter(
        (
          event,
        ): event is Extract<
          BrunoTableCellRangeInstrumentationEvent,
          { readonly kind: "mounted-decoration" }
        > => event.kind === "mounted-decoration",
      );
      expect(horizontal.at(-1)?.writtenCellCount).toBe(1);
      expect(horizontal.at(-1)?.mountedCellCount).toBeLessThanOrEqual(5);

      await userEvent.keyboard("{Escape}");
      await userEvent.click(page.getByRole("gridcell", { name: "Ada", exact: true }));
      await settleBrunoTableBrowserFrames();
      grid.element().focus();
      await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
      await settleBrunoTableBrowserFrames();
      events.length = 0;
      grid.element().focus();
      await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
      await settleBrunoTableBrowserFrames();
      const vertical = events.filter(
        (
          event,
        ): event is Extract<
          BrunoTableCellRangeInstrumentationEvent,
          { readonly kind: "mounted-decoration" }
        > => event.kind === "mounted-decoration",
      );
      expect(vertical.at(-1)?.writtenCellCount).toBe(1);
      expect(vertical.at(-1)?.mountedCellCount).toBeLessThanOrEqual(5);
    } finally {
      removeInstrumentation();
    }
  });

  test("bounds a vertical endpoint decoration to the changed row across a long mounted span", async () => {
    const tableId = "TABLE_ID_CELL_RANGE_LONG_VERTICAL_DECORATION_DELTA";
    const events: BrunoTableCellRangeInstrumentationEvent[] = [];
    const removeInstrumentation = installBrunoTableCellRangeInstrumentationListener(
      tableId,
      (event) => events.push(event),
    );
    const manyRows = Array.from({ length: 100 }, (_, index) => ({
      id: `row-${String(index).padStart(3, "0")}`,
      name: `Row ${String(index).padStart(3, "0")}`,
      score: index,
      quantity: BigInt(index),
    }));
    try {
      await render(
        <BrunoTableClient
          tableId={tableId}
          columns={[columns[0]!]}
          initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
          clientSource={source(manyRows)}
          getRowId={(row) => row.id}
        />,
      );
      const grid = page.getByRole("grid", { name: `Data for ${tableId}` });
      await userEvent.click(page.getByRole("gridcell", { name: "Row 000", exact: true }));
      grid.element().focus();
      await userEvent.keyboard(
        detectPlatform() === "mac"
          ? "{Meta>}{Shift>}{ArrowDown}{/Shift}{/Meta}"
          : "{Control>}{Shift>}{ArrowDown}{/Shift}{/Control}",
      );
      await settleBrunoTableBrowserFrames();
      expect(
        page
          .getByRole("gridcell")
          .all()
          .filter((cell) => cell.element().getAttribute("aria-selected") === "true").length,
      ).toBeGreaterThan(5);

      events.length = 0;
      grid.element().focus();
      await userEvent.keyboard("{Shift>}{ArrowUp}{/Shift}");
      await settleBrunoTableBrowserFrames();
      const decorations = events.filter(
        (
          event,
        ): event is Extract<
          BrunoTableCellRangeInstrumentationEvent,
          { readonly kind: "mounted-decoration" }
        > => event.kind === "mounted-decoration",
      );
      expect(decorations.at(-1)?.mountedCellCount).toBe(1);
      expect(decorations.at(-1)?.writtenCellCount).toBe(1);
    } finally {
      removeInstrumentation();
    }
  });

  test("projects an ordinary anchor move through only its old and new mounted cells", async () => {
    const tableId = "TABLE_ID_CELL_RANGE_ANCHOR_DECORATION_DELTA";
    const events: BrunoTableCellRangeInstrumentationEvent[] = [];
    const removeInstrumentation = installBrunoTableCellRangeInstrumentationListener(
      tableId,
      (event) => events.push(event),
    );
    const manyRows = Array.from({ length: 100 }, (_, index) => ({
      id: `row-${String(index).padStart(3, "0")}`,
      name: `Row ${String(index).padStart(3, "0")}`,
      score: index,
      quantity: BigInt(index),
    }));
    try {
      await render(table(tableId, manyRows));
      const first = page.getByRole("gridcell", { name: "Row 000", exact: true });
      const second = page.getByRole("gridcell", { name: "Row 001", exact: true });
      await userEvent.click(first);
      await settleBrunoTableBrowserFrames();
      expect(page.getByRole("gridcell").all().length).toBeGreaterThan(10);
      events.length = 0;

      await userEvent.click(second);
      await settleBrunoTableBrowserFrames();
      const decorations = events.filter(
        (
          event,
        ): event is Extract<
          BrunoTableCellRangeInstrumentationEvent,
          { readonly kind: "mounted-decoration" }
        > => event.kind === "mounted-decoration",
      );
      expect(decorations.at(-1)?.projectionCandidateCount).toBe(2);
      expect(decorations.at(-1)?.mountedCellCount).toBe(2);
      expect(decorations.at(-1)?.writtenCellCount).toBe(2);
      await expect.element(first).not.toHaveAttribute("aria-selected");
      await expect.element(second).toHaveAttribute("aria-selected", "true");
    } finally {
      removeInstrumentation();
    }
  });

  test("bounds a wide horizontal projection to the affected mounted row", async () => {
    const tableId = "TABLE_ID_CELL_RANGE_WIDE_HORIZONTAL_DECORATION_DELTA";
    const events: BrunoTableCellRangeInstrumentationEvent[] = [];
    const removeInstrumentation = installBrunoTableCellRangeInstrumentationListener(
      tableId,
      (event) => events.push(event),
    );
    const manyColumns = Array.from({ length: 100 }, (_, index) => ({
      columnId: `COL_ID_WIDE_${String(index).padStart(3, "0")}` as BrunoTableColumnId,
      field: "name" as const,
      headerName: `Wide ${index}`,
      valueType: "text" as const,
      width: 180,
    })) satisfies BrunoTableColumns<Row>;
    try {
      await render(
        <div style={{ width: 480 }}>
          <BrunoTableClient
            tableId={tableId}
            columns={manyColumns}
            initialOrderBy={[{ columnId: "COL_ID_WIDE_000", direction: "asc" }]}
            clientSource={source([rows[0]!])}
            getRowId={(row) => row.id}
          />
        </div>,
      );
      const grid = page.getByRole("grid", { name: `Data for ${tableId}` });
      const firstCell = page.getByRole("gridcell", { name: "Ada", exact: true }).first();
      await userEvent.click(firstCell);
      await settleBrunoTableBrowserFrames();
      events.length = 0;

      grid.element().focus();
      await userEvent.keyboard("{Shift>}{End}{/Shift}");
      await settleBrunoTableBrowserFrames();
      const decorations = events.filter(
        (
          event,
        ): event is Extract<
          BrunoTableCellRangeInstrumentationEvent,
          { readonly kind: "mounted-decoration" }
        > => event.kind === "mounted-decoration",
      );
      const mountedBodyCellCount = page.getByRole("gridcell").all().length;
      expect(mountedBodyCellCount).toBeLessThan(manyColumns.length);
      expect(decorations.at(-1)?.projectionCandidateCount).toBeLessThanOrEqual(
        mountedBodyCellCount,
      );
      expect(decorations.at(-1)?.projectionCandidateCount).toBeLessThan(20);
    } finally {
      removeInstrumentation();
    }
  });

  test.each(["ltr", "rtl"] as const)(
    "routes %s horizontal edge autoscroll through the pinned logical viewport",
    async (direction) => {
      const wideNameColumn = {
        field: "name",
        valueType: "text",
        width: 320,
      } as const;
      const wideColumns = [
        { ...wideNameColumn, columnId: "COL_ID_WIDE_1", headerName: "Wide 1", pinned: "start" },
        { ...wideNameColumn, columnId: "COL_ID_WIDE_2", headerName: "Wide 2" },
        { ...wideNameColumn, columnId: "COL_ID_WIDE_3", headerName: "Wide 3" },
        { ...wideNameColumn, columnId: "COL_ID_WIDE_4", headerName: "Wide 4" },
        { ...wideNameColumn, columnId: "COL_ID_WIDE_5", headerName: "Wide 5" },
        { ...wideNameColumn, columnId: "COL_ID_WIDE_6", headerName: "Wide 6" },
        { ...wideNameColumn, columnId: "COL_ID_WIDE_7", headerName: "Wide 7" },
        { ...wideNameColumn, columnId: "COL_ID_WIDE_8", headerName: "Wide 8", pinned: "end" },
      ] satisfies BrunoTableColumns<Row>;

      const tableId = `TABLE_ID_CELL_RANGE_HORIZONTAL_${direction.toUpperCase()}`;
      const events: BrunoTableCellRangeInstrumentationEvent[] = [];
      const removeInstrumentation = installBrunoTableCellRangeInstrumentationListener(
        tableId,
        (event) => events.push(event),
      );
      const screen = await render(
        <div dir={direction} style={{ width: 1_024 }}>
          <BrunoTableClient
            tableId={tableId}
            columns={wideColumns}
            initialOrderBy={[{ columnId: "COL_ID_WIDE_1", direction: "asc" }]}
            clientSource={source([rows[0]!])}
            getRowId={(row) => row.id}
          />
        </div>,
      );
      try {
        await settleBrunoTableBrowserFrames();
        events.length = 0;
        const grid = page.getByRole("grid", { name: `Data for ${tableId}` });
        expect(
          grid.element().querySelector('[data-bruno-pinned-body-region="start"]'),
        ).not.toBeNull();
        expect(
          grid.element().querySelector('[data-bruno-pinned-body-region="end"]'),
        ).not.toBeNull();
        const cells = page.getByRole("gridcell", { name: "Ada", exact: true });
        const anchor = cells.first();
        const target = cells.last();
        const initialHeaders = new Set(
          page
            .getByRole("columnheader")
            .all()
            .map((header) => header.element().textContent),
        );
        const bounds = grid.element().getBoundingClientRect();
        const anchorBounds = anchor.element().getBoundingClientRect();
        const startX = anchorBounds.left + anchorBounds.width / 2;
        const startY = anchorBounds.top + anchorBounds.height / 2;
        const edgeX = direction === "rtl" ? bounds.left + 1 : bounds.right - 1;
        const initialScrollLeft = grid.element().scrollLeft;
        const initialScrollTop = grid.element().scrollTop;

        anchor.element().dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientX: startX,
            clientY: startY,
            pointerId: direction === "rtl" ? 24 : 23,
          }),
        );
        target.element().dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            cancelable: true,
            clientX: edgeX,
            clientY: startY + 1,
            pointerId: direction === "rtl" ? 24 : 23,
          }),
        );
        await settleBrunoTableBrowserFrames(50);

        const scrollLeftBeforeRelease = grid.element().scrollLeft;
        target.element().dispatchEvent(
          new PointerEvent("pointerup", {
            bubbles: true,
            cancelable: true,
            clientX: edgeX,
            clientY: startY + 1,
            pointerId: direction === "rtl" ? 24 : 23,
          }),
        );
        await settleBrunoTableBrowserFrames(2);
        expect(grid.element().scrollLeft).toBe(scrollLeftBeforeRelease);
        expect(grid.element().scrollLeft).not.toBe(initialScrollLeft);
        expect(grid.element().scrollTop).toBe(initialScrollTop);
        const currentHeaders = new Set(
          page
            .getByRole("columnheader")
            .all()
            .map((header) => header.element().textContent),
        );
        expect(currentHeaders).not.toEqual(initialHeaders);
        await expect
          .element(page.getByRole("columnheader", { name: "Wide 1" }))
          .toBeInTheDocument();
        await expect
          .element(page.getByRole("columnheader", { name: "Wide 8" }))
          .toBeInTheDocument();

        const framesAfterRelease = events.filter((event) => event.kind === "pointer-frame").length;
        expect(framesAfterRelease).toBeGreaterThan(0);
        expect(framesAfterRelease).toBeLessThanOrEqual(110);
        expect(events.filter((event) => event.kind === "publication").length).toBeLessThanOrEqual(
          framesAfterRelease + 1,
        );
        await settleBrunoTableBrowserFrames(3);
        expect(events.filter((event) => event.kind === "pointer-frame")).toHaveLength(
          framesAfterRelease,
        );
      } finally {
        removeInstrumentation();
        await screen.unmount();
      }
    },
  );

  test("preserves an exact identity span across value publications and rejects changed interiors", async () => {
    const writes: string[] = [];
    const restoreClipboard = installClipboard(async (text) => {
      writes.push(text);
    });
    try {
      const screen = await render(table("TABLE_ID_CELL_RANGE_IDENTITIES"));
      const grid = page.getByRole("grid", { name: "Data for TABLE_ID_CELL_RANGE_IDENTITIES" });
      grid.element().focus();
      await userEvent.keyboard("{Shift>}{ArrowDown}{ArrowDown}{/Shift}");
      await settleBrunoTableBrowserFrames();

      const valuePublication = rows.map((row) =>
        row.id === "babbage" ? { ...row, score: 200 } : row,
      );
      await screen.rerender(table("TABLE_ID_CELL_RANGE_IDENTITIES", valuePublication, 2));
      await settleBrunoTableBrowserFrames();
      await expect
        .element(page.getByRole("gridcell", { name: "Babbage" }))
        .toHaveAttribute("aria-selected", "true");
      await userEvent.keyboard(copyGesture());
      await vi.waitFor(() => expect(writes.at(-1)).toBe("Ada\nBabbage\nCurie"));

      const inserted = [
        { id: "ada", name: "Ada", score: 4, quantity: 9_007_199_254_740_993n },
        { id: "boole", name: "Boole", score: 5, quantity: 11n },
        { id: "babbage", name: "Babbage", score: 2, quantity: 9_007_199_254_740_995n },
        { id: "curie", name: "Curie", score: 3, quantity: 9_007_199_254_740_997n },
      ] satisfies readonly Row[];
      await screen.rerender(table("TABLE_ID_CELL_RANGE_IDENTITIES", inserted, 3));
      await settleBrunoTableBrowserFrames();
      await expect
        .element(page.getByRole("gridcell", { name: "Babbage" }))
        .not.toHaveAttribute("aria-selected");
      await userEvent.keyboard(copyGesture());
      await vi.waitFor(() => expect(writes).toHaveLength(1));
      await expect
        .element(page.getByRole("log", { name: "Table interaction status" }))
        .toHaveTextContent("Copy failed: the selected cells are no longer available");

      await userEvent.keyboard("{Shift>}{ArrowUp}{/Shift}");
      await settleBrunoTableBrowserFrames();
      await userEvent.keyboard(copyGesture());
      await vi.waitFor(() => expect(writes.at(-1)).toBe("Boole\nCurie"));
    } finally {
      restoreClipboard();
    }
  });

  test("rejects Copy once when a pre-gesture range invalidates after a transient shrink", async () => {
    const tableId = "TABLE_ID_CELL_RANGE_PRE_GESTURE_INVALIDATION";
    const writes: string[] = [];
    const events: BrunoTableCellRangeInstrumentationEvent[] = [];
    const restoreClipboard = installClipboard(async (text) => {
      writes.push(text);
    });
    const removeInstrumentation = installBrunoTableCellRangeInstrumentationListener(
      tableId,
      (event) => events.push(event),
    );
    try {
      const screen = await render(table(tableId));
      const grid = page.getByRole("grid", { name: `Data for ${tableId}` });
      grid.element().focus();
      await userEvent.keyboard("{Shift>}{ArrowDown}{ArrowDown}{/Shift}");
      const babbage = page.getByRole("gridcell", { name: "Babbage" });
      const bounds = babbage.element().getBoundingClientRect();
      await userEvent.keyboard("{Shift>}");
      babbage.element().dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: bounds.left + bounds.width / 2,
          clientY: bounds.top + bounds.height / 2,
          pointerId: 47,
          shiftKey: false,
        }),
      );
      await userEvent.keyboard("{/Shift}");

      await screen.rerender(
        table(
          tableId,
          rows.filter((row) => row.id !== "curie"),
          2,
        ),
      );
      await settleBrunoTableBrowserFrames();
      await expect
        .element(page.getByRole("gridcell", { name: "Ada" }))
        .not.toHaveAttribute("aria-selected");
      await expect.element(babbage).not.toHaveAttribute("aria-selected");
      const workAfterInvalidation = events.filter(
        (event) => event.kind === "pointer-frame" || event.kind === "publication",
      ).length;
      window.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, pointerId: 47, clientY: bounds.bottom }),
      );
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 47 }));
      await settleBrunoTableBrowserFrames(3);
      expect(
        events.filter((event) => event.kind === "pointer-frame" || event.kind === "publication"),
      ).toHaveLength(workAfterInvalidation);

      grid.element().focus();
      await userEvent.keyboard(copyGesture());
      await vi.waitFor(() =>
        expect(
          page.getByRole("log", { name: "Table interaction status" }).element().textContent,
        ).toBe("Copy failed: the selected cells are no longer available"),
      );
      expect(writes).toHaveLength(0);
    } finally {
      removeInstrumentation();
      restoreClipboard();
    }
  });

  test("keeps a new drag when only its obsolete pre-gesture anchor disappears", async () => {
    const tableId = "TABLE_ID_CELL_RANGE_OBSOLETE_PRE_GESTURE_ANCHOR";
    const writes: string[] = [];
    const restoreClipboard = installClipboard(async (text) => {
      writes.push(text);
    });
    try {
      const screen = await render(table(tableId));
      await userEvent.click(page.getByRole("gridcell", { name: "Ada" }));
      const babbage = page.getByRole("gridcell", { name: "Babbage" });
      const curie = page.getByRole("gridcell", { name: "Curie" });
      const start = babbage.element().getBoundingClientRect();
      const end = curie.element().getBoundingClientRect();
      babbage.element().dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: start.left + start.width / 2,
          clientY: start.top + start.height / 2,
          pointerId: 48,
        }),
      );
      curie.element().dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          cancelable: true,
          clientX: end.left + end.width / 2,
          clientY: end.top + end.height / 2,
          pointerId: 48,
        }),
      );
      await settleBrunoTableBrowserFrames();
      await expect.element(babbage).toHaveAttribute("aria-selected", "true");
      await expect.element(curie).toHaveAttribute("aria-selected", "true");

      await screen.rerender(
        table(
          tableId,
          rows.filter((row) => row.id !== "ada"),
          2,
        ),
      );
      await settleBrunoTableBrowserFrames();
      curie.element().dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          cancelable: true,
          clientX: end.left + end.width / 2,
          clientY: end.top + end.height / 2,
          pointerId: 48,
        }),
      );
      await settleBrunoTableBrowserFrames();
      await expect.element(babbage).toHaveAttribute("aria-selected", "true");
      await expect.element(curie).toHaveAttribute("aria-selected", "true");
      await userEvent.keyboard(copyGesture());
      await vi.waitFor(() => expect(writes).toEqual(["Babbage\nCurie"]));
    } finally {
      restoreClipboard();
    }
  });

  test("does not resurrect a range after empty, loading, or invalid Client bodies", async () => {
    const tableId = "TABLE_ID_CELL_RANGE_BODY_RESET";
    const transitions = [
      { rows: [], totalRows: 0, version: 2, status: "ready" },
      { rows: [], totalRows: rows.length, version: 4, status: "loading" },
      { rows: [], totalRows: rows.length, version: 6, status: "ready" },
    ] satisfies readonly BrunoTableClientSource<Row>[];
    const screen = await render(table(tableId));
    for (const [index, transition] of transitions.entries()) {
      const grid = page.getByRole("grid", { name: `Data for ${tableId}` });
      grid.element().focus();
      await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
      await settleBrunoTableBrowserFrames();
      await expect
        .element(page.getByRole("gridcell", { name: "Babbage" }))
        .toHaveAttribute("aria-selected", "true");

      await screen.rerender(tableWithSource(tableId, transition));
      await settleBrunoTableBrowserFrames();
      await screen.rerender(table(tableId, rows, index * 2 + 3));
      await settleBrunoTableBrowserFrames();
      await expect
        .element(page.getByRole("gridcell", { name: "Ada" }))
        .not.toHaveAttribute("aria-selected");
      await expect
        .element(page.getByRole("gridcell", { name: "Babbage" }))
        .not.toHaveAttribute("aria-selected");
    }
  });

  test("copies the reconciled Active Cell after a vanished single anchor", async () => {
    const writes: string[] = [];
    const restoreClipboard = installClipboard(async (text) => {
      writes.push(text);
    });
    try {
      const screen = await render(table("TABLE_ID_CELL_RANGE_ANCHOR_FALLBACK"));
      await userEvent.click(page.getByRole("gridcell", { name: "Babbage" }));
      await screen.rerender(
        table(
          "TABLE_ID_CELL_RANGE_ANCHOR_FALLBACK",
          rows.filter((row) => row.id !== "babbage"),
          2,
        ),
      );
      await settleBrunoTableBrowserFrames();
      const grid = page.getByRole("grid", { name: "Data for TABLE_ID_CELL_RANGE_ANCHOR_FALLBACK" });
      grid.element().focus();
      await userEvent.keyboard(copyGesture());
      await vi.waitFor(() => expect(writes).toEqual(["Curie"]));
    } finally {
      restoreClipboard();
    }
  });

  test("uses one immutable payload while a live publication races the asynchronous write", async () => {
    let resolveWrite: (() => void) | undefined;
    const writes: string[] = [];
    const restoreClipboard = installClipboard(
      (text) =>
        new Promise<void>((resolve) => {
          writes.push(text);
          resolveWrite = resolve;
        }),
    );
    try {
      const screen = await render(table("TABLE_ID_CELL_RANGE_ATOMIC"));
      const grid = page.getByRole("grid", { name: "Data for TABLE_ID_CELL_RANGE_ATOMIC" });
      grid.element().focus();
      await userEvent.keyboard("{Shift>}{ArrowRight}{ArrowRight}{/Shift}");
      await userEvent.keyboard(copyGesture());
      await vi.waitFor(() => expect(writes).toEqual(["Ada\t4\t9007199254740993"]));
      expect(
        page.getByRole("log", { name: "Table interaction status" }).element().textContent,
      ).toBe("");

      await screen.rerender(
        table(
          "TABLE_ID_CELL_RANGE_ATOMIC",
          rows.map((row) =>
            row.id === "ada" ? { ...row, score: 400, quantity: 9_007_199_254_741_111n } : row,
          ),
          2,
        ),
      );
      await settleBrunoTableBrowserFrames();
      expect(writes).toEqual(["Ada\t4\t9007199254740993"]);
      resolveWrite?.();
      await expect
        .element(page.getByRole("log", { name: "Table interaction status" }))
        .toHaveTextContent("3 cells copied");
    } finally {
      restoreClipboard();
    }
  });

  test.each([
    ["resolves", "latest-first"],
    ["rejects", "latest-first"],
    ["resolves", "stale-first"],
    ["rejects", "stale-first"],
  ] as const)(
    "announces only the latest overlapping Copy completion when it %s and settles %s",
    async (latestOutcome, settlementOrder) => {
      const operations: Array<{
        readonly text: string;
        readonly resolve: () => void;
        readonly reject: () => void;
      }> = [];
      const restoreClipboard = installClipboard(
        (text) =>
          new Promise<void>((resolve, reject) => {
            operations.push({
              text,
              resolve,
              reject: () => reject(new Error("copy rejected")),
            });
          }),
      );
      try {
        await render(table("TABLE_ID_CELL_RANGE_OVERLAPPING_COPY"));
        const grid = page.getByRole("grid", {
          name: "Data for TABLE_ID_CELL_RANGE_OVERLAPPING_COPY",
        });
        grid.element().focus();
        await userEvent.keyboard("{Shift>}{ArrowRight}{ArrowRight}{/Shift}");
        await userEvent.keyboard(copyGesture());
        await vi.waitFor(() => expect(operations).toHaveLength(1));
        expect(operations[0]?.text).toBe("Ada\t4\t9007199254740993");

        await userEvent.click(page.getByRole("gridcell", { name: "Babbage" }));
        await userEvent.keyboard(copyGesture());
        await vi.waitFor(() => expect(operations).toHaveLength(2));
        expect(operations[1]?.text).toBe("Babbage");
        const expectedAnnouncement =
          latestOutcome === "resolves"
            ? "1 cell copied"
            : "Copy failed: the browser rejected the clipboard write";
        const status = page.getByRole("log", { name: "Table interaction status" });
        if (settlementOrder === "stale-first") {
          if (latestOutcome === "resolves") operations[0]?.reject();
          else operations[0]?.resolve();
          await settleBrunoTableBrowserFrames();
          expect(status.element().textContent).toBe("");
        }
        if (latestOutcome === "resolves") operations[1]?.resolve();
        else operations[1]?.reject();
        await expect.element(status).toHaveTextContent(expectedAnnouncement);
        if (settlementOrder === "latest-first") {
          if (latestOutcome === "resolves") operations[0]?.reject();
          else operations[0]?.resolve();
        }
        await settleBrunoTableBrowserFrames();
        await expect.element(status).toHaveTextContent(expectedAnnouncement);
      } finally {
        restoreClipboard();
      }
    },
  );

  test("reports clipboard rejection only after failure and preserves the valid range", async () => {
    const restoreClipboard = installClipboard(async () => {
      throw new Error("denied");
    });
    try {
      await render(table("TABLE_ID_CELL_RANGE_FAILURE"));
      const grid = page.getByRole("grid", { name: "Data for TABLE_ID_CELL_RANGE_FAILURE" });
      grid.element().focus();
      await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
      const copyEvent = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "c",
        code: "KeyC",
        ctrlKey: detectPlatform() !== "mac",
        metaKey: detectPlatform() === "mac",
      });
      expect(grid.element().dispatchEvent(copyEvent)).toBe(false);
      await expect
        .element(page.getByRole("log", { name: "Table interaction status" }))
        .toHaveTextContent("Copy failed: the browser rejected the clipboard write");
      await expect
        .element(page.getByRole("gridcell", { name: "Ada" }))
        .toHaveAttribute("aria-selected", "true");
      await expect
        .element(page.getByRole("gridcell", { name: "4", exact: true }))
        .toHaveAttribute("aria-selected", "true");
    } finally {
      restoreClipboard();
    }
  });

  test("owns Client range Copy before an unavailable clipboard can fall back natively", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    try {
      await render(table("TABLE_ID_CELL_RANGE_UNAVAILABLE_CLIPBOARD"));
      const grid = page.getByRole("grid", {
        name: "Data for TABLE_ID_CELL_RANGE_UNAVAILABLE_CLIPBOARD",
      });
      grid.element().focus();
      await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
      const copyEvent = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "c",
        code: "KeyC",
        ctrlKey: detectPlatform() !== "mac",
        metaKey: detectPlatform() === "mac",
      });
      expect(grid.element().dispatchEvent(copyEvent)).toBe(false);
      expect(copyEvent.defaultPrevented).toBe(true);
      await expect
        .element(page.getByRole("log", { name: "Table interaction status" }))
        .toHaveTextContent("Copy failed: clipboard access is unavailable");
    } finally {
      if (descriptor === undefined) delete (navigator as { clipboard?: Clipboard }).clipboard;
      else Object.defineProperty(navigator, "clipboard", descriptor);
    }
  });

  test("captures exact pinned and two-axis virtualized identity spans beyond mounted cells", async () => {
    const wideNameColumn = {
      field: "name",
      valueType: "text",
      width: 320,
    } as const;
    const virtualColumns = [
      { ...wideNameColumn, columnId: "COL_ID_WIDE_1", headerName: "Wide 1", pinned: "start" },
      { ...wideNameColumn, columnId: "COL_ID_WIDE_2", headerName: "Wide 2" },
      { ...wideNameColumn, columnId: "COL_ID_WIDE_3", headerName: "Wide 3" },
      { ...wideNameColumn, columnId: "COL_ID_WIDE_4", headerName: "Wide 4" },
      { ...wideNameColumn, columnId: "COL_ID_WIDE_5", headerName: "Wide 5" },
      { ...wideNameColumn, columnId: "COL_ID_WIDE_6", headerName: "Wide 6" },
      { ...wideNameColumn, columnId: "COL_ID_WIDE_7", headerName: "Wide 7" },
      { ...wideNameColumn, columnId: "COL_ID_WIDE_8", headerName: "Wide 8", pinned: "end" },
    ] satisfies BrunoTableColumns<Row>;
    const virtualRows = Array.from({ length: 100 }, (_, index) => ({
      id: `row-${String(index).padStart(3, "0")}`,
      name: `Row ${String(index).padStart(3, "0")}`,
      score: index,
      quantity: BigInt(index),
    }));
    const writes: string[] = [];
    const restoreClipboard = installClipboard(async (text) => {
      writes.push(text);
    });
    try {
      await render(
        <BrunoTableClient
          tableId="TABLE_ID_CELL_RANGE_VIRTUAL"
          columns={virtualColumns}
          initialOrderBy={[{ columnId: "COL_ID_WIDE_1", direction: "asc" }]}
          clientSource={source(virtualRows)}
          getRowId={(row) => row.id}
        />,
      );
      const grid = page.getByRole("grid", { name: "Data for TABLE_ID_CELL_RANGE_VIRTUAL" });
      grid.element().focus();
      await userEvent.keyboard("{Shift>}{End}{/Shift}");
      await settleBrunoTableBrowserFrames();
      await userEvent.keyboard(copyGesture());
      await vi.waitFor(() =>
        expect(writes.at(-1)).toBe(Array.from({ length: 8 }, () => "Row 000").join("\t")),
      );
      await userEvent.keyboard("{Home}");
      await userEvent.keyboard(
        detectPlatform() === "mac"
          ? "{Meta>}{Shift>}{ArrowDown}{/Shift}{/Meta}"
          : "{Control>}{Shift>}{ArrowDown}{/Shift}{/Control}",
      );
      await settleBrunoTableBrowserFrames();
      await userEvent.keyboard(copyGesture());
      await vi.waitFor(() =>
        expect(writes.at(-1)).toBe(virtualRows.map((row) => row.name).join("\n")),
      );
      await expect
        .element(page.getByRole("gridcell", { name: "Row 099", exact: true }).first())
        .toHaveAttribute("aria-selected", "true");
    } finally {
      restoreClipboard();
    }
  });

  test("preserves selected state on a virtual Active Cell proxy", async () => {
    const tableId = "TABLE_ID_CELL_RANGE_SELECTED_ACTIVE_PROXY";
    const virtualRows = Array.from({ length: 100 }, (_, index) => ({
      id: `row-${String(index).padStart(3, "0")}`,
      name: `Row ${String(index).padStart(3, "0")}`,
      score: index,
      quantity: BigInt(index),
    }));
    const proxyTable = (nextRows: readonly Row[], version: number) => (
      <BrunoTableClient
        tableId={tableId}
        columns={[columns[0]!]}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={source(nextRows, version)}
        getRowId={(row) => row.id}
      />
    );
    const screen = await render(proxyTable(virtualRows, 1));
    const grid = page.getByRole("grid", { name: `Data for ${tableId}` });
    grid.element().focus();
    await userEvent.keyboard(
      detectPlatform() === "mac"
        ? "{Meta>}{Shift>}{ArrowDown}{/Shift}{/Meta}"
        : "{Control>}{Shift>}{ArrowDown}{/Shift}{/Control}",
    );
    await settleBrunoTableBrowserFrames();
    await expect
      .element(page.getByRole("gridcell", { name: "Row 099", exact: true }))
      .toHaveAttribute("aria-selected", "true");

    grid.element().scrollTop = 0;
    grid.element().dispatchEvent(new Event("scroll", { bubbles: true }));
    await settleBrunoTableBrowserFrames();
    const activeProxy = page.getByRole("gridcell", { name: "Row 099", exact: true });
    expect(activeProxy.element().hasAttribute("data-bruno-active-proxy")).toBe(true);
    expect(grid.element().getAttribute("aria-activedescendant")).toBe(activeProxy.element().id);
    await expect.element(activeProxy).toHaveAttribute("aria-selected", "true");

    await screen.rerender(proxyTable(virtualRows.slice(1), 2));
    await settleBrunoTableBrowserFrames();
    expect(grid.element().getAttribute("aria-activedescendant")).toBe(activeProxy.element().id);
    await expect.element(activeProxy).not.toHaveAttribute("aria-selected");
  });

  test("registers scoped Mod+C through the shared adapter and removes it on cleanup", async () => {
    const manager = getHotkeyManager();
    const registrationsFor = (grid: HTMLElement | SVGElement) =>
      [...manager.registrations.state.values()].filter(
        (registration) => registration.target === grid && registration.hotkey === "Mod+C",
      );
    const screen = await render(table("TABLE_ID_CELL_RANGE_HOTKEY"));
    const grid = page.getByRole("grid", { name: "Data for TABLE_ID_CELL_RANGE_HOTKEY" }).element();
    expect(registrationsFor(grid)).toHaveLength(1);
    await screen.unmount();
    expect(registrationsFor(grid)).toHaveLength(0);
  });
});
