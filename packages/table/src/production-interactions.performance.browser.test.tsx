import { Profiler } from "react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { cleanup, render } from "vitest-browser-react";

import { BrunoTableClient, BrunoTableToolbar } from "./index";
import type { BrunoTableColumnId, BrunoTableColumns } from "./index";
import {
  captureBrunoTableReactCommitWork,
  combineBrunoTableBenchmarkFrameWork,
  finalizeBrunoTableBenchmarkEvidence,
} from "./internal/benchmark-budget";
import {
  BRUNO_TABLE_PRESENTATION_CADENCE_PROFILE,
  getBrunoTableBenchmarkEnvironment,
} from "./internal/benchmark-profile";
import { settleBrunoTableBrowserFrames } from "./internal/browser-test-helpers";
import {
  installBrunoTableCellRangeInstrumentationListener,
  type BrunoTableCellRangeInstrumentationEvent,
} from "./internal/cell-range-clipboard";
import { installBrunoTableColumnCommandSubscriptionListener } from "./internal/grid-subscription-instrumentation";
import {
  installBrunoTableClientCellRenderListenerForTable,
  installBrunoTableClientColumnGestureFrameListener,
  installBrunoTableClientColumnPreviewStyleWriteListener,
  installBrunoTableClientGridSurfaceRenderListenerForTable,
  installBrunoTableClientHeaderRenderListenerForTable,
  installBrunoTableClientRowRenderListenerForTable,
  installBrunoTableClientViewRenderListenerForTable,
} from "./internal/render-instrumentation";

type InteractionRow = Readonly<{
  readonly id: string;
  readonly label: string;
  readonly sequence: number;
}>;

type ColumnGestureFrameEvent =
  | Readonly<{
      readonly phase: "scheduled" | "cancelled";
      readonly kind: "resize" | "reorder";
      readonly frameId: number;
    }>
  | Readonly<{
      readonly phase: "ran";
      readonly kind: "resize" | "reorder";
      readonly frameId: number;
      readonly durationMs: number;
    }>
  | Readonly<{
      readonly phase: "synchronous";
      readonly kind: "resize" | "reorder";
      readonly frameId?: never;
      readonly durationMs: number;
    }>;

type RenderedFrameWorkSample = {
  callbackDurationMs: number;
  reactDurationMs: number;
};

const ROW_COUNT = 5_000;
const COLUMN_COUNT = 150;
const WARMUP_SAMPLE_COUNT = 12;
const MEASURED_SAMPLE_COUNT = 100;
const TOTAL_SAMPLE_COUNT = WARMUP_SAMPLE_COUNT + MEASURED_SAMPLE_COUNT;
const MEASURED_VERTICAL_SCROLL_BOUNDARY = WARMUP_SAMPLE_COUNT * 120 + 32;
const MEASURED_HORIZONTAL_SCROLL_BOUNDARY = WARMUP_SAMPLE_COUNT * 120 + 32;
const MEASURED_SCROLL_START_OFFSET = -16;
const MEASURED_SCROLL_STEP = 4;
const RESIZE_INITIAL_WIDTH_PX = 120;
const RESIZE_POINTER_STEP_PX = 2;
const FRAME_BUDGET_MS = 8.33;
const DROPPED_FRAME_THRESHOLD_MS = 16.66;
const MAX_DROPPED_FRAME_COUNT = 2;

const rows = Object.freeze(
  Array.from(
    { length: ROW_COUNT },
    (_unused, index): InteractionRow =>
      Object.freeze({
        id: `interaction-row-${String(index).padStart(4, "0")}`,
        label: `Interaction row ${String(index).padStart(4, "0")}`,
        sequence: index,
      }),
  ),
);

const columns = Object.freeze(
  Array.from({ length: COLUMN_COUNT }, (_unused, index) => ({
    columnId: `COL_ID_INTERACTION_${String(index).padStart(3, "0")}` as BrunoTableColumnId,
    field: index === 0 ? ("sequence" as const) : ("label" as const),
    headerName: `Interaction ${String(index).padStart(3, "0")}`,
    valueType: index === 0 ? ("number" as const) : ("text" as const),
    width: RESIZE_INITIAL_WIDTH_PX,
    ...(index === 0 ? { pinned: "start" as const } : {}),
    ...(index === COLUMN_COUNT - 1 ? { pinned: "end" as const } : {}),
  })),
) as BrunoTableColumns<InteractionRow>;

function measuredEvidence(scenario: string, samples: readonly number[]) {
  return finalizeBrunoTableBenchmarkEvidence(samples, {
    budgetMs: FRAME_BUDGET_MS,
    droppedFrameThresholdMs: DROPPED_FRAME_THRESHOLD_MS,
    environment: getBrunoTableBenchmarkEnvironment(),
    maxDroppedFrameCount: MAX_DROPPED_FRAME_COUNT,
    measuredSampleCount: MEASURED_SAMPLE_COUNT,
    profile: "chromium-capable-hardware-v1",
    scenario,
    warmupSampleCount: WARMUP_SAMPLE_COUNT,
  });
}

function mountedBodyRows(grid: HTMLElement): readonly HTMLElement[] {
  return [...grid.querySelectorAll<HTMLElement>('tbody[role="rowgroup"] > tr[role="row"]')];
}

function mountedColumnHeaders(grid: HTMLElement): readonly HTMLElement[] {
  return [...grid.querySelectorAll<HTMLElement>("thead th[data-bruno-column-id]")];
}

function mountedDataCells(grid: HTMLElement): readonly HTMLElement[] {
  return [
    ...grid.querySelectorAll<HTMLElement>(
      '[role="gridcell"][data-bruno-row-id][data-bruno-column-id]',
    ),
  ];
}

function ToolbarProbe({ onRender }: { readonly onRender: () => void }) {
  onRender();
  return <button type="button">Stable interaction command</button>;
}

function pointer(
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  options: PointerEventInit,
) {
  return new PointerEvent(type, {
    bubbles: true,
    button: 0,
    cancelable: true,
    ...options,
  });
}

const nativeAnimationFrame = window.requestAnimationFrame.bind(window);

function nextAnimationFrameTimestamp(): Promise<number> {
  return new Promise((resolve) => nativeAnimationFrame(resolve));
}

function cadenceEvidence(scenario: string, samples: readonly number[]) {
  return finalizeBrunoTableBenchmarkEvidence(samples, {
    budgetMs: 20,
    droppedFrameThresholdMs: 20,
    environment: getBrunoTableBenchmarkEnvironment(),
    maxDroppedFrameCount: MAX_DROPPED_FRAME_COUNT,
    measuredSampleCount: MEASURED_SAMPLE_COUNT,
    profile: BRUNO_TABLE_PRESENTATION_CADENCE_PROFILE,
    scenario,
    warmupSampleCount: WARMUP_SAMPLE_COUNT,
  });
}

afterEach(async () => {
  await cleanup();
});

describe("BrunoTable production interaction performance", () => {
  test("keeps frame-paced two-axis scroll, resize, and reorder bounded at 5,000x150 with pinning", async () => {
    expect(import.meta.env.MODE).toBe("production");
    expect(__BRUNO_TABLE_DEVELOPMENT__).toBe(false);
    expect(__BRUNO_TABLE_TEST_DIAGNOSTICS__).toBe(true);

    const tableId = "TABLE_ID_PRODUCTION_INTERACTIONS";
    const gestureFrames: ColumnGestureFrameEvent[] = [];
    const columnCommandNotifications: Array<{
      readonly columnId: string;
      readonly listenerCount: number;
    }> = [];
    let viewRenderCount = 0;
    let gridSurfaceRenderCount = 0;
    let pendingFrameWorkSample: RenderedFrameWorkSample | undefined;
    let schedulingFrameWorkSample: RenderedFrameWorkSample | undefined;
    let restoreFrameProbe: (() => void) | undefined;
    let rowRenderCount = 0;
    let cellRenderCount = 0;
    let headerRenderCount = 0;
    const toolbarRenders = vi.fn();
    const previewStyleWrites = vi.fn();
    const removeFrames = installBrunoTableClientColumnGestureFrameListener(tableId, (event) => {
      gestureFrames.push(event);
    });
    const removeNotifications = installBrunoTableColumnCommandSubscriptionListener(
      tableId,
      (event) => {
        columnCommandNotifications.push(event);
      },
    );
    const removeView = installBrunoTableClientViewRenderListenerForTable(tableId, () => {
      viewRenderCount += 1;
    });
    const removeGridSurface = installBrunoTableClientGridSurfaceRenderListenerForTable(
      tableId,
      () => {
        gridSurfaceRenderCount += 1;
      },
    );
    const removeRows = installBrunoTableClientRowRenderListenerForTable(tableId, () => {
      rowRenderCount += 1;
    });
    const removeCells = installBrunoTableClientCellRenderListenerForTable(tableId, () => {
      cellRenderCount += 1;
    });
    const removeHeaders = installBrunoTableClientHeaderRenderListenerForTable(tableId, () => {
      headerRenderCount += 1;
    });
    const removeStyleWrites =
      installBrunoTableClientColumnPreviewStyleWriteListener(previewStyleWrites);

    try {
      const screen = await render(
        <Profiler
          id="production-interactions"
          onRender={(_id, _phase, actualDuration, _baseDuration, startTime, commitTime) => {
            if (pendingFrameWorkSample !== undefined) {
              pendingFrameWorkSample.reactDurationMs += captureBrunoTableReactCommitWork({
                actualDurationMs: actualDuration,
                commitTimeMs: commitTime,
                observedAtMs: performance.now(),
                startTimeMs: startTime,
              }).durationMs;
            }
          }}
        >
          <div style={{ height: 360, width: 1_024 }}>
            <BrunoTableClient
              tableId={tableId}
              getRowId={(row: InteractionRow) => row.id}
              columns={columns}
              initialOrderBy={[{ columnId: "COL_ID_INTERACTION_000", direction: "asc" }]}
              clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
            >
              <BrunoTableToolbar>
                <ToolbarProbe onRender={toolbarRenders} />
              </BrunoTableToolbar>
            </BrunoTableClient>
          </div>
        </Profiler>,
      );
      await expect.element(screen.getByRole("grid", { name: `Data for ${tableId}` })).toBeVisible();
      const grid = screen
        .getByRole("grid", { name: `Data for ${tableId}` })
        .element() as HTMLElement;
      await settleBrunoTableBrowserFrames(3);

      expect(grid.getAttribute("aria-rowcount")).toBe(String(ROW_COUNT + 1));
      expect(grid.getAttribute("aria-colcount")).toBe(String(COLUMN_COUNT));
      expect(grid.querySelector('[data-bruno-pinned-body-region="start"]')).not.toBeNull();
      expect(grid.querySelector('[data-bruno-pinned-body-region="end"]')).not.toBeNull();
      const initialMountedRowIds = mountedDataCells(grid).map((cell) => cell.dataset["brunoRowId"]);
      const initialMountedColumnIds = mountedColumnHeaders(grid).map(
        (header) => header.dataset["brunoColumnId"],
      );
      expect(mountedBodyRows(grid).length).toBeLessThanOrEqual(32);
      expect(mountedColumnHeaders(grid).length).toBeLessThanOrEqual(24);
      expect(mountedDataCells(grid).length).toBeLessThanOrEqual(768);

      const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
      const requestAnimationFrameProbe = vi
        .spyOn(window, "requestAnimationFrame")
        .mockImplementation((callback) => {
          return nativeRequestAnimationFrame((timestamp) => {
            const startedAt = performance.now();
            callback(timestamp);
            const sample = schedulingFrameWorkSample;
            if (sample !== undefined) {
              sample.callbackDurationMs += performance.now() - startedAt;
            }
          });
        });
      restoreFrameProbe = () => requestAnimationFrameProbe.mockRestore();

      viewRenderCount = 0;
      gridSurfaceRenderCount = 0;
      rowRenderCount = 0;
      cellRenderCount = 0;
      headerRenderCount = 0;
      toolbarRenders.mockClear();
      const scrollFrameWorkDurations: number[] = [];
      const scrollFrameCadence: number[] = [];
      const measuredMountedRowWindows = new Set<string>();
      const measuredMountedColumnWindows = new Set<string>();
      for (let sample = 0; sample < TOTAL_SAMPLE_COUNT; sample += 1) {
        await nextAnimationFrameTimestamp();
        const frameWorkSample: RenderedFrameWorkSample = {
          callbackDurationMs: 0,
          reactDurationMs: 0,
        };
        pendingFrameWorkSample = frameWorkSample;
        schedulingFrameWorkSample = frameWorkSample;
        const isWarmup = sample < WARMUP_SAMPLE_COUNT;
        const measuredSample = sample - WARMUP_SAMPLE_COUNT;
        grid.scrollTop = isWarmup
          ? sample === WARMUP_SAMPLE_COUNT - 1
            ? MEASURED_VERTICAL_SCROLL_BOUNDARY + MEASURED_SCROLL_START_OFFSET
            : (sample + 1) * 120
          : MEASURED_VERTICAL_SCROLL_BOUNDARY +
            MEASURED_SCROLL_START_OFFSET +
            measuredSample * MEASURED_SCROLL_STEP;
        grid.scrollLeft = isWarmup
          ? sample === WARMUP_SAMPLE_COUNT - 1
            ? MEASURED_HORIZONTAL_SCROLL_BOUNDARY + MEASURED_SCROLL_START_OFFSET
            : (sample + 1) * 80
          : MEASURED_HORIZONTAL_SCROLL_BOUNDARY +
            MEASURED_SCROLL_START_OFFSET +
            measuredSample * MEASURED_SCROLL_STEP;
        const startedAt = performance.now();
        grid.dispatchEvent(new Event("scroll", { bubbles: true }));
        const admissionDuration = performance.now() - startedAt;
        const renderedFrameTimestamp = await nextAnimationFrameTimestamp();
        const renderedCallbackDuration = frameWorkSample.callbackDurationMs;
        const renderedReactDuration = frameWorkSample.reactDurationMs;
        frameWorkSample.callbackDurationMs = 0;
        frameWorkSample.reactDurationMs = 0;
        const presentationFrameTimestamp = await nextAnimationFrameTimestamp();
        schedulingFrameWorkSample = undefined;
        scrollFrameWorkDurations.push(
          combineBrunoTableBenchmarkFrameWork({
            admissionDurationMs: admissionDuration,
            presentationFrame: {
              callbackDurationMs: frameWorkSample.callbackDurationMs,
              reactDurationMs: frameWorkSample.reactDurationMs,
            },
            renderedFrame: {
              callbackDurationMs: renderedCallbackDuration,
              reactDurationMs: renderedReactDuration,
            },
          }),
        );
        pendingFrameWorkSample = undefined;
        scrollFrameCadence.push(presentationFrameTimestamp - renderedFrameTimestamp);
        if (!isWarmup) {
          measuredMountedRowWindows.add(
            [...new Set(mountedDataCells(grid).map((cell) => cell.dataset["brunoRowId"]))].join(
              "|",
            ),
          );
          measuredMountedColumnWindows.add(
            mountedColumnHeaders(grid)
              .map((header) => header.dataset["brunoColumnId"])
              .join("|"),
          );
        }
      }
      await settleBrunoTableBrowserFrames(3);

      const scrollEvidence = measuredEvidence(
        "client-two-axis-scroll-input-through-render-work-5000x150-pinned",
        scrollFrameWorkDurations,
      );
      const scrollCadenceEvidence = cadenceEvidence(
        "client-two-axis-scroll-presentation-frame-cadence-5000x150-pinned",
        scrollFrameCadence,
      );
      expect(scrollEvidence.summary.sampleCount).toBe(MEASURED_SAMPLE_COUNT);
      expect(scrollEvidence.droppedFrames.comparison).toBe("measured sample > thresholdMs");
      expect(scrollCadenceEvidence.summary.sampleCount).toBe(MEASURED_SAMPLE_COUNT);
      expect(measuredMountedRowWindows.size).toBeGreaterThan(5);
      expect(measuredMountedColumnWindows.size).toBeGreaterThan(2);
      expect(grid.scrollTop).toBeGreaterThan(0);
      expect(grid.scrollLeft).toBeGreaterThan(0);
      expect(
        mountedDataCells(grid).some(
          (cell) => !initialMountedRowIds.includes(cell.dataset["brunoRowId"]),
        ),
      ).toBe(true);
      expect(
        mountedColumnHeaders(grid).some(
          (header) => !initialMountedColumnIds.includes(header.dataset["brunoColumnId"]),
        ),
      ).toBe(true);
      expect(mountedBodyRows(grid).length).toBeLessThanOrEqual(32);
      expect(mountedColumnHeaders(grid).length).toBeLessThanOrEqual(24);
      expect(mountedDataCells(grid).length).toBeLessThanOrEqual(768);
      const scrollbarOverlay = grid.parentElement?.querySelector<HTMLElement>(
        "[data-bruno-scrollbar-overlay]",
      );
      if (scrollbarOverlay === undefined || scrollbarOverlay === null) {
        throw new Error("The production workload must mount its decorative scrollbar overlay.");
      }
      for (const property of [
        "--bruno-table-scrollbar-horizontal-thumb-offset",
        "--bruno-table-scrollbar-vertical-thumb-offset",
      ]) {
        expect(scrollbarOverlay.style.getPropertyValue(property)).not.toBe("");
        expect(grid.style.getPropertyValue(property)).toBe("");
      }
      expect(viewRenderCount).toBe(0);
      expect(gridSurfaceRenderCount).toBeLessThanOrEqual(TOTAL_SAMPLE_COUNT + 3);
      expect(rowRenderCount).toBeLessThanOrEqual(TOTAL_SAMPLE_COUNT * 32);
      expect(cellRenderCount).toBeLessThanOrEqual(TOTAL_SAMPLE_COUNT * 768);
      expect(toolbarRenders).not.toHaveBeenCalled();
      expect(columnCommandNotifications).toHaveLength(0);

      grid.scrollTop = 0;
      grid.scrollLeft = 0;
      grid.dispatchEvent(new Event("scroll", { bubbles: true }));
      await settleBrunoTableBrowserFrames(3);

      gestureFrames.length = 0;
      previewStyleWrites.mockClear();
      columnCommandNotifications.length = 0;
      viewRenderCount = 0;
      gridSurfaceRenderCount = 0;
      rowRenderCount = 0;
      cellRenderCount = 0;
      headerRenderCount = 0;
      toolbarRenders.mockClear();
      const resizeHandle = screen
        .getByRole("separator", { name: "Resize Interaction 001" })
        .element();
      const resizeStartX = resizeHandle.getBoundingClientRect().right - 1;
      resizeHandle.dispatchEvent(pointer("pointerdown", { clientX: resizeStartX, pointerId: 901 }));
      previewStyleWrites.mockClear();
      const resizeAdmissionDurations: number[] = [];
      for (let sample = 0; sample < TOTAL_SAMPLE_COUNT; sample += 1) {
        const startedAt = performance.now();
        window.dispatchEvent(
          pointer("pointermove", {
            clientX: resizeStartX + (sample + 1) * RESIZE_POINTER_STEP_PX,
            pointerId: 901,
          }),
        );
        resizeAdmissionDurations.push(performance.now() - startedAt);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const activeResizeRowRenders = rowRenderCount;
      const activeResizeHeaderRenders = headerRenderCount;
      const activeResizeToolbarRenders = toolbarRenders.mock.calls.length;
      window.dispatchEvent(
        pointer("pointerup", {
          clientX: resizeStartX + TOTAL_SAMPLE_COUNT * RESIZE_POINTER_STEP_PX,
          pointerId: 901,
        }),
      );
      await settleBrunoTableBrowserFrames(2);

      const resizeCallbackDurations = gestureFrames.flatMap((event) =>
        event.phase === "ran" && event.kind === "resize" ? [event.durationMs] : [],
      );
      expect(resizeCallbackDurations).toHaveLength(TOTAL_SAMPLE_COUNT);
      const resizeDurations = resizeCallbackDurations.map(
        (callbackDuration, index) =>
          (resizeAdmissionDurations[index] ?? Number.POSITIVE_INFINITY) + callbackDuration,
      );
      const resizeEvidence = measuredEvidence(
        "client-column-resize-input-through-preview-work-5000x150-pinned",
        resizeDurations,
      );
      expect(resizeEvidence.summary.sampleCount).toBe(MEASURED_SAMPLE_COUNT);
      expect(activeResizeRowRenders).toBe(0);
      expect(activeResizeHeaderRenders).toBe(0);
      expect(activeResizeToolbarRenders).toBe(0);
      expect(previewStyleWrites.mock.calls.length).toBeGreaterThanOrEqual(TOTAL_SAMPLE_COUNT);
      expect(previewStyleWrites.mock.calls.length).toBeLessThanOrEqual(TOTAL_SAMPLE_COUNT * 6 + 6);
      expect(resizeHandle.getAttribute("aria-valuenow")).toBe(
        String(RESIZE_INITIAL_WIDTH_PX + TOTAL_SAMPLE_COUNT * RESIZE_POINTER_STEP_PX),
      );
      expect(columnCommandNotifications).toHaveLength(1);
      expect(columnCommandNotifications[0]?.columnId).toBe("COL_ID_INTERACTION_001");
      expect(columnCommandNotifications[0]?.listenerCount).toBeLessThanOrEqual(4);
      expect(viewRenderCount).toBeLessThanOrEqual(2);
      expect(gridSurfaceRenderCount).toBeLessThanOrEqual(2);
      expect(rowRenderCount).toBeLessThanOrEqual(64);
      expect(cellRenderCount).toBeLessThanOrEqual(1_536);
      expect(headerRenderCount).toBeLessThanOrEqual(24);

      gestureFrames.length = 0;
      previewStyleWrites.mockClear();
      columnCommandNotifications.length = 0;
      viewRenderCount = 0;
      gridSurfaceRenderCount = 0;
      rowRenderCount = 0;
      cellRenderCount = 0;
      headerRenderCount = 0;
      toolbarRenders.mockClear();
      const reorderHandle = screen
        .getByRole("button", { name: "Reorder Interaction 002" })
        .element();
      const targetHeader = screen.getByRole("columnheader", { name: /Interaction 004/u }).element();
      const reorderStartX = reorderHandle.getBoundingClientRect().left + 2;
      const reorderTargetX = targetHeader.getBoundingClientRect().right + 2;
      const columnOrderBeforeReorder = mountedColumnHeaders(grid).map(
        (header) => header.dataset["brunoColumnId"],
      );
      expect(columnOrderBeforeReorder.indexOf("COL_ID_INTERACTION_002")).toBeLessThan(
        columnOrderBeforeReorder.indexOf("COL_ID_INTERACTION_004"),
      );
      reorderHandle.dispatchEvent(
        pointer("pointerdown", { clientX: reorderStartX, pointerId: 902 }),
      );
      previewStyleWrites.mockClear();
      const reorderAdmissionDurations: number[] = [];
      for (let sample = 0; sample < TOTAL_SAMPLE_COUNT; sample += 1) {
        const progress = (sample + 1) / TOTAL_SAMPLE_COUNT;
        const startedAt = performance.now();
        window.dispatchEvent(
          pointer("pointermove", {
            clientX: reorderStartX + (reorderTargetX - reorderStartX) * progress,
            pointerId: 902,
          }),
        );
        reorderAdmissionDurations.push(performance.now() - startedAt);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const activeReorderRowRenders = rowRenderCount;
      const activeReorderHeaderRenders = headerRenderCount;
      const activeReorderToolbarRenders = toolbarRenders.mock.calls.length;
      window.dispatchEvent(pointer("pointerup", { clientX: reorderTargetX, pointerId: 902 }));
      await settleBrunoTableBrowserFrames(3);

      const reorderCallbackDurations = gestureFrames.flatMap((event) =>
        event.phase === "ran" && event.kind === "reorder" ? [event.durationMs] : [],
      );
      expect(reorderCallbackDurations).toHaveLength(TOTAL_SAMPLE_COUNT);
      const reorderDurations = reorderCallbackDurations.map(
        (callbackDuration, index) =>
          (reorderAdmissionDurations[index] ?? Number.POSITIVE_INFINITY) + callbackDuration,
      );
      const reorderEvidence = measuredEvidence(
        "client-column-reorder-input-through-preview-work-5000x150-pinned",
        reorderDurations,
      );
      expect(reorderEvidence.summary.sampleCount).toBe(MEASURED_SAMPLE_COUNT);
      expect(activeReorderRowRenders).toBe(0);
      expect(activeReorderHeaderRenders).toBe(0);
      expect(activeReorderToolbarRenders).toBe(0);
      expect(previewStyleWrites.mock.calls.length).toBeGreaterThanOrEqual(TOTAL_SAMPLE_COUNT);
      expect(previewStyleWrites.mock.calls.length).toBeLessThanOrEqual(
        TOTAL_SAMPLE_COUNT * 24 + 24,
      );
      const columnOrderAfterReorder = mountedColumnHeaders(grid).map(
        (header) => header.dataset["brunoColumnId"],
      );
      expect(columnOrderAfterReorder.indexOf("COL_ID_INTERACTION_002")).toBeGreaterThan(
        columnOrderAfterReorder.indexOf("COL_ID_INTERACTION_004"),
      );
      expect(columnCommandNotifications).toHaveLength(0);
      expect(viewRenderCount).toBeLessThanOrEqual(4);
      expect(gridSurfaceRenderCount).toBeLessThanOrEqual(4);
      expect(rowRenderCount).toBeLessThanOrEqual(128);
      expect(cellRenderCount).toBeLessThanOrEqual(3_072);
      expect(headerRenderCount).toBeLessThanOrEqual(48);
      expect(toolbarRenders).not.toHaveBeenCalled();
      expect(mountedBodyRows(grid).length).toBeLessThanOrEqual(32);
      expect(mountedColumnHeaders(grid).length).toBeLessThanOrEqual(24);
      expect(mountedDataCells(grid).length).toBeLessThanOrEqual(768);
      expect(grid.querySelector('[data-bruno-pinned-body-region="start"]')).not.toBeNull();
      expect(grid.querySelector('[data-bruno-pinned-body-region="end"]')).not.toBeNull();
      console.info(
        JSON.stringify({
          benchmark: "BrunoTable production interaction evidence",
          evidence: [scrollEvidence, scrollCadenceEvidence, resizeEvidence, reorderEvidence],
        }),
      );
    } finally {
      restoreFrameProbe?.();
      removeStyleWrites();
      removeHeaders();
      removeCells();
      removeRows();
      removeGridSurface();
      removeView();
      removeNotifications();
      removeFrames();
    }
  }, 60_000);

  test.each(["mounted", "autoscroll"] as const)(
    "keeps production pointer Cell Range %s preview within one measured frame",
    async (mode) => {
      const tableId = "TABLE_ID_PRODUCTION_POINTER_RANGE";
      const events: BrunoTableCellRangeInstrumentationEvent[] = [];
      let pendingFrameWorkSample: RenderedFrameWorkSample | undefined;
      let schedulingFrameWorkSample: RenderedFrameWorkSample | undefined;
      let restoreFrameProbe: (() => void) | undefined;
      const removeInstrumentation = installBrunoTableCellRangeInstrumentationListener(
        tableId,
        (event) => events.push(event),
      );
      try {
        const screen = await render(
          <Profiler
            id="production-pointer-cell-range"
            onRender={(_id, _phase, actualDuration, _baseDuration, startTime, commitTime) => {
              if (pendingFrameWorkSample !== undefined) {
                pendingFrameWorkSample.reactDurationMs += captureBrunoTableReactCommitWork({
                  actualDurationMs: actualDuration,
                  commitTimeMs: commitTime,
                  observedAtMs: performance.now(),
                  startTimeMs: startTime,
                }).durationMs;
              }
            }}
          >
            <div style={{ width: 1_024 }}>
              <BrunoTableClient
                tableId={tableId}
                getRowId={(row: InteractionRow) => row.id}
                columns={columns}
                initialOrderBy={[{ columnId: "COL_ID_INTERACTION_000", direction: "asc" }]}
                clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
              />
            </div>
          </Profiler>,
        );
        await expect
          .element(screen.getByRole("grid", { name: `Data for ${tableId}` }))
          .toBeVisible();
        const grid = screen
          .getByRole("grid", { name: `Data for ${tableId}` })
          .element() as HTMLElement;
        await settleBrunoTableBrowserFrames(3);
        const anchor = grid.querySelector<HTMLElement>(
          '[role="gridcell"][data-bruno-row-id="interaction-row-0000"][data-bruno-column-id="COL_ID_INTERACTION_001"]',
        );
        const targetA = grid.querySelector<HTMLElement>(
          '[role="gridcell"][data-bruno-row-id="interaction-row-0000"][data-bruno-column-id="COL_ID_INTERACTION_002"]',
        );
        const targetB = grid.querySelector<HTMLElement>(
          '[role="gridcell"][data-bruno-row-id="interaction-row-0000"][data-bruno-column-id="COL_ID_INTERACTION_003"]',
        );
        if (anchor === null || targetA === null || targetB === null) {
          throw new Error(
            "Expected three mounted production cells for pointer Cell Range evidence.",
          );
        }
        const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
        const requestAnimationFrameProbe = vi
          .spyOn(window, "requestAnimationFrame")
          .mockImplementation((callback) => {
            return nativeRequestAnimationFrame((timestamp) => {
              const startedAt = performance.now();
              callback(timestamp);
              const sample = schedulingFrameWorkSample;
              if (sample !== undefined) {
                sample.callbackDurationMs += performance.now() - startedAt;
              }
            });
          });
        restoreFrameProbe = () => requestAnimationFrameProbe.mockRestore();
        const center = (element: HTMLElement) => {
          const bounds = element.getBoundingClientRect();
          return {
            clientX: bounds.left + bounds.width / 2,
            clientY: bounds.top + bounds.height / 2,
          };
        };
        const initialRows = new Set(
          mountedDataCells(grid).map((cell) => cell.dataset["brunoRowId"]),
        );
        const enteringSelectedRows = new Set<string>();
        const gridBounds = grid.getBoundingClientRect();
        const edgePoint = { clientX: center(anchor).clientX, clientY: gridBounds.bottom - 2 };
        anchor.dispatchEvent(pointer("pointerdown", { ...center(anchor), pointerId: 903 }));
        events.length = 0;
        const cadence: number[] = [];
        const frameWorkDurations: number[] = [];
        for (let sample = 0; sample < TOTAL_SAMPLE_COUNT; sample += 1) {
          if (mode === "mounted") await nextAnimationFrameTimestamp();
          const frameWorkSample: RenderedFrameWorkSample = {
            callbackDurationMs: 0,
            reactDurationMs: 0,
          };
          pendingFrameWorkSample = frameWorkSample;
          schedulingFrameWorkSample = frameWorkSample;
          const target = mode === "autoscroll" ? grid : sample % 2 === 0 ? targetA : targetB;
          const startedAt = performance.now();
          target.dispatchEvent(
            pointer("pointermove", {
              ...(mode === "autoscroll" ? edgePoint : center(target)),
              pointerId: 903,
            }),
          );
          const admissionDuration = performance.now() - startedAt;
          const renderedFrameTimestamp = await nextAnimationFrameTimestamp();
          const renderedCallbackDuration = frameWorkSample.callbackDurationMs;
          const renderedReactDuration = frameWorkSample.reactDurationMs;
          frameWorkSample.callbackDurationMs = 0;
          frameWorkSample.reactDurationMs = 0;
          const presentationFrameTimestamp = await nextAnimationFrameTimestamp();
          schedulingFrameWorkSample = undefined;
          frameWorkDurations.push(
            combineBrunoTableBenchmarkFrameWork({
              admissionDurationMs: admissionDuration,
              presentationFrame: {
                callbackDurationMs: frameWorkSample.callbackDurationMs,
                reactDurationMs: frameWorkSample.reactDurationMs,
              },
              renderedFrame: {
                callbackDurationMs: renderedCallbackDuration,
                reactDurationMs: renderedReactDuration,
              },
            }),
          );
          pendingFrameWorkSample = undefined;
          cadence.push(presentationFrameTimestamp - renderedFrameTimestamp);
          if (mode === "autoscroll") {
            for (const cell of mountedDataCells(grid)) {
              const rowId = cell.dataset["brunoRowId"];
              if (
                rowId !== undefined &&
                !initialRows.has(rowId) &&
                cell.getAttribute("aria-selected") === "true"
              ) {
                expect(cell.dataset["brunoColumnId"]).toBe("COL_ID_INTERACTION_001");
                enteringSelectedRows.add(rowId);
              }
            }
            expect(mountedBodyRows(grid).length).toBeLessThanOrEqual(32);
            expect(mountedColumnHeaders(grid).length).toBeLessThanOrEqual(24);
            expect(mountedDataCells(grid).length).toBeLessThanOrEqual(768);
          }
        }
        const pointerFrameDurations = events.flatMap((event) =>
          event.kind === "pointer-frame" ? [event.durationMs] : [],
        );
        if (mode === "autoscroll") {
          expect(grid.scrollTop).toBeGreaterThan(grid.clientHeight);
          expect(enteringSelectedRows.size).toBeGreaterThan(32);
          grid.dispatchEvent(pointer("pointercancel", { ...edgePoint, pointerId: 903 }));
        } else {
          targetB.dispatchEvent(pointer("pointerup", { ...center(targetB), pointerId: 903 }));
        }
        await settleBrunoTableBrowserFrames(2);
        if (mode === "autoscroll") {
          const stoppedScrollTop = grid.scrollTop;
          await settleBrunoTableBrowserFrames(3);
          expect(grid.scrollTop).toBe(stoppedScrollTop);
        }

        if (mode === "mounted") expect(pointerFrameDurations).toHaveLength(TOTAL_SAMPLE_COUNT);
        else expect(pointerFrameDurations.length).toBeGreaterThanOrEqual(TOTAL_SAMPLE_COUNT);
        expect(frameWorkDurations).toHaveLength(TOTAL_SAMPLE_COUNT);
        const workEvidence = measuredEvidence(
          `client-pointer-cell-range-${mode}-input-through-render-work-5000x150-pinned`,
          frameWorkDurations,
        );
        const frameCadenceEvidence = cadenceEvidence(
          `client-pointer-cell-range-${mode}-presentation-frame-cadence-5000x150-pinned`,
          cadence,
        );
        expect(workEvidence.summary.sampleCount).toBe(MEASURED_SAMPLE_COUNT);
        expect(frameCadenceEvidence.summary.sampleCount).toBe(MEASURED_SAMPLE_COUNT);
        if (mode === "mounted") {
          expect(anchor).toHaveAttribute("aria-selected", "true");
          expect(targetB).toHaveAttribute("aria-selected", "true");
        }
        expect(mountedBodyRows(grid).length).toBeLessThanOrEqual(32);
        expect(mountedColumnHeaders(grid).length).toBeLessThanOrEqual(24);
        console.info(
          JSON.stringify({
            benchmark: "BrunoTable production pointer Cell Range evidence",
            evidence: [workEvidence, frameCadenceEvidence],
          }),
        );
      } finally {
        restoreFrameProbe?.();
        removeInstrumentation();
      }
    },
    30_000,
  );
});
