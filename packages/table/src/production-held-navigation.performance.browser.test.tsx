import { Profiler } from "react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { cleanup, render } from "vitest-browser-react";

import { BrunoTableActiveSortCount, BrunoTableClient, BrunoTableToolbar } from "./index";
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
import { installBrunoTableColumnCommandSubscriptionListener } from "./internal/grid-subscription-instrumentation";
import {
  installBrunoTableClientCellRenderListenerForTable,
  installBrunoTableClientGridSurfaceRenderListenerForTable,
  installBrunoTableClientRowRenderListenerForTable,
  installBrunoTableClientViewRenderListenerForTable,
} from "./internal/render-instrumentation";
import { installBrunoTableToolbarSubscriptionListener } from "./internal/toolbar-instrumentation";

type HeldNavigationRow = Readonly<{
  readonly id: string;
  readonly label: string;
  readonly sequence: number;
}>;

const ROW_COUNT = 5_000;
const COLUMN_COUNT = 150;
const WARMUP_SAMPLE_COUNT = 24;
const MEASURED_SAMPLE_COUNT = 200;
const TOTAL_SAMPLE_COUNT = WARMUP_SAMPLE_COUNT + MEASURED_SAMPLE_COUNT;
const FRAME_BUDGET_MS = 8.33;
const DROPPED_FRAME_THRESHOLD_MS = 16.66;
const MAX_DROPPED_FRAME_COUNT = 2;

type RenderedFrameWorkSample = {
  callbackDurationMs: number;
  reactDurationMs: number;
};

type HeldNavigationSamples = Readonly<{
  cadence: readonly number[];
  work: readonly number[];
}>;

const rows = Object.freeze(
  Array.from(
    { length: ROW_COUNT },
    (_unused, index): HeldNavigationRow =>
      Object.freeze({
        id: `held-navigation-row-${String(index).padStart(4, "0")}`,
        label: `Held navigation row ${String(index).padStart(4, "0")}`,
        sequence: index,
      }),
  ),
);

const columns = Object.freeze(
  Array.from({ length: COLUMN_COUNT }, (_unused, index) => ({
    columnId: `COL_ID_HELD_NAVIGATION_${String(index).padStart(3, "0")}` as BrunoTableColumnId,
    field: index === 0 ? ("sequence" as const) : ("label" as const),
    headerName: `Held navigation ${String(index).padStart(3, "0")}`,
    valueType: index === 0 ? ("number" as const) : ("text" as const),
    width: 120,
    ...(index === 0 ? { pinned: "start" as const } : {}),
    ...(index === COLUMN_COUNT - 1 ? { pinned: "end" as const } : {}),
  })),
) as BrunoTableColumns<HeldNavigationRow>;

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

function activeCell(grid: HTMLElement): HTMLElement {
  const activeId = grid.getAttribute("aria-activedescendant");
  const active = activeId === null ? null : grid.ownerDocument.getElementById(activeId);
  if (active === null) throw new Error("Expected one mounted or owned Active Cell destination.");
  return active;
}

async function collectHeldNavigationSamples(
  grid: HTMLElement,
  key: "ArrowDown" | "ArrowRight",
  setFrameWorkSample: (sample: RenderedFrameWorkSample | undefined) => void,
  repeatsPerFrame = 1,
): Promise<HeldNavigationSamples> {
  const cadence: number[] = [];
  const work: number[] = [];
  for (let sample = 0; sample < TOTAL_SAMPLE_COUNT; sample += 1) {
    await nextAnimationFrameTimestamp();
    const frameWorkSample: RenderedFrameWorkSample = {
      callbackDurationMs: 0,
      reactDurationMs: 0,
    };
    setFrameWorkSample(frameWorkSample);
    const startedAt = performance.now();
    for (let repeat = 0; repeat < repeatsPerFrame; repeat += 1) {
      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key,
        repeat: repeatsPerFrame > 1 || sample > 0,
      });
      grid.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    const admissionDuration = performance.now() - startedAt;
    const renderedFrameTimestamp = await nextAnimationFrameTimestamp();
    const renderedCallbackDuration = frameWorkSample.callbackDurationMs;
    const renderedReactDuration = frameWorkSample.reactDurationMs;
    frameWorkSample.callbackDurationMs = 0;
    frameWorkSample.reactDurationMs = 0;
    const presentationFrameTimestamp = await nextAnimationFrameTimestamp();
    setFrameWorkSample(undefined);
    const presentationCallbackDuration = frameWorkSample.callbackDurationMs;
    const presentationReactDuration = frameWorkSample.reactDurationMs;
    work.push(
      combineBrunoTableBenchmarkFrameWork({
        admissionDurationMs: admissionDuration,
        presentationFrame: {
          callbackDurationMs: presentationCallbackDuration,
          reactDurationMs: presentationReactDuration,
        },
        renderedFrame: {
          callbackDurationMs: renderedCallbackDuration,
          reactDurationMs: renderedReactDuration,
        },
      }),
    );
    cadence.push(presentationFrameTimestamp - renderedFrameTimestamp);
  }
  grid.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key }));
  await settleBrunoTableBrowserFrames(3);
  return Object.freeze({ cadence: Object.freeze(cadence), work: Object.freeze(work) });
}

const nativeAnimationFrame = window.requestAnimationFrame.bind(window);

function nextAnimationFrameTimestamp(): Promise<number> {
  return new Promise((resolve) => nativeAnimationFrame(resolve));
}

function finalizeHeldNavigationEvidence(scenario: string, samples: readonly number[]) {
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

function finalizeHeldNavigationCadenceEvidence(scenario: string, samples: readonly number[]) {
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

function ToolbarProbe({ onRender }: { readonly onRender: () => void }) {
  onRender();
  return <BrunoTableActiveSortCount />;
}

afterEach(async () => {
  await cleanup();
});

describe("BrunoTable production held-key navigation performance", () => {
  test("keeps real TanStack Hotkeys repeat delivery bounded across both virtual axes", async () => {
    expect(import.meta.env.MODE).toBe("production");
    expect(__BRUNO_TABLE_DEVELOPMENT__).toBe(false);
    expect(__BRUNO_TABLE_TEST_DIAGNOSTICS__).toBe(true);

    const tableId = "TABLE_ID_PRODUCTION_HELD_NAVIGATION";
    let viewRenderCount = 0;
    let gridSurfaceRenderCount = 0;
    let rowRenderCount = 0;
    let cellRenderCount = 0;
    let toolbarRenderCount = 0;
    let toolbarNotificationCount = 0;
    let columnCommandNotificationCount = 0;
    let pendingFrameWorkSample: RenderedFrameWorkSample | undefined;
    let schedulingFrameWorkSample: RenderedFrameWorkSample | undefined;
    let restoreFrameProbe: (() => void) | undefined;
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
    const removeToolbarSubscriptions = installBrunoTableToolbarSubscriptionListener((event) => {
      if (event.tableId === tableId && event.phase === "notify") toolbarNotificationCount += 1;
    });
    const removeColumnCommandSubscriptions = installBrunoTableColumnCommandSubscriptionListener(
      tableId,
      () => {
        columnCommandNotificationCount += 1;
      },
    );

    try {
      const screen = await render(
        <Profiler
          id="production-held-navigation"
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
              getRowId={(row: HeldNavigationRow) => row.id}
              columns={columns}
              initialOrderBy={[{ columnId: "COL_ID_HELD_NAVIGATION_000", direction: "asc" }]}
              clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
            >
              <BrunoTableToolbar>
                <ToolbarProbe
                  onRender={() => {
                    toolbarRenderCount += 1;
                  }}
                />
              </BrunoTableToolbar>
            </BrunoTableClient>
          </div>
        </Profiler>,
      );
      await expect.element(screen.getByRole("grid", { name: `Data for ${tableId}` })).toBeVisible();
      const grid = screen
        .getByRole("grid", { name: `Data for ${tableId}` })
        .element() as HTMLElement;
      grid.focus();
      await vi.waitFor(() => expect(grid.getAttribute("aria-activedescendant")).not.toBeNull());
      await settleBrunoTableBrowserFrames(3);

      expect(grid.getAttribute("aria-rowcount")).toBe(String(ROW_COUNT + 1));
      expect(grid.getAttribute("aria-colcount")).toBe(String(COLUMN_COUNT));
      expect(grid.querySelector('[data-bruno-pinned-body-region="start"]')).not.toBeNull();
      expect(grid.querySelector('[data-bruno-pinned-body-region="end"]')).not.toBeNull();
      expect(mountedBodyRows(grid).length).toBeLessThanOrEqual(32);
      expect(mountedColumnHeaders(grid).length).toBeLessThanOrEqual(24);
      expect(mountedDataCells(grid).length).toBeLessThanOrEqual(768);

      const originalRequestAnimationFrame = window.requestAnimationFrame;
      const nativeRequestAnimationFrame = originalRequestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) =>
        nativeRequestAnimationFrame((timestamp) => {
          const startedAt = performance.now();
          callback(timestamp);
          const activeSample = schedulingFrameWorkSample;
          if (activeSample !== undefined) {
            activeSample.callbackDurationMs += performance.now() - startedAt;
          }
        });
      restoreFrameProbe = () => {
        window.requestAnimationFrame = originalRequestAnimationFrame;
      };

      viewRenderCount = 0;
      gridSurfaceRenderCount = 0;
      rowRenderCount = 0;
      cellRenderCount = 0;
      toolbarRenderCount = 0;
      toolbarNotificationCount = 0;
      columnCommandNotificationCount = 0;

      const setFrameWorkSample = (sample: RenderedFrameWorkSample | undefined) => {
        pendingFrameWorkSample = sample;
        schedulingFrameWorkSample = sample;
      };
      const verticalSamples = await collectHeldNavigationSamples(
        grid,
        "ArrowDown",
        setFrameWorkSample,
      );
      const verticalEvidence = finalizeHeldNavigationEvidence(
        "client-held-arrow-down-input-through-render-work-5000x150-pinned",
        verticalSamples.work,
      );
      const verticalCadenceEvidence = finalizeHeldNavigationCadenceEvidence(
        "client-held-arrow-down-presentation-frame-cadence-5000x150-pinned",
        verticalSamples.cadence,
      );
      expect(verticalEvidence.summary.sampleCount).toBe(MEASURED_SAMPLE_COUNT);
      expect(verticalEvidence.summary.budget).toBe(FRAME_BUDGET_MS);
      expect(verticalEvidence.droppedFrames).toMatchObject({
        comparison: "measured sample > thresholdMs",
        maxCount: MAX_DROPPED_FRAME_COUNT,
        thresholdMs: DROPPED_FRAME_THRESHOLD_MS,
      });
      expect(verticalCadenceEvidence.summary.sampleCount).toBe(MEASURED_SAMPLE_COUNT);
      expect(activeCell(grid).textContent).toBe("224");
      expect(mountedBodyRows(grid).length).toBeLessThanOrEqual(32);
      expect(mountedColumnHeaders(grid).length).toBeLessThanOrEqual(24);
      expect(mountedDataCells(grid).length).toBeLessThanOrEqual(768);
      expect(viewRenderCount).toBe(0);
      expect(gridSurfaceRenderCount).toBeLessThanOrEqual(TOTAL_SAMPLE_COUNT + 3);
      expect(rowRenderCount).toBeLessThanOrEqual(TOTAL_SAMPLE_COUNT + 3);
      expect(cellRenderCount).toBeLessThanOrEqual((TOTAL_SAMPLE_COUNT + 3) * 24);
      expect(toolbarRenderCount).toBe(0);
      expect(toolbarNotificationCount).toBe(0);
      expect(columnCommandNotificationCount).toBe(0);

      const gridSurfaceRendersBeforeSustained = gridSurfaceRenderCount;
      const rowRendersBeforeSustained = rowRenderCount;
      const cellRendersBeforeSustained = cellRenderCount;
      const sustainedSamples = await collectHeldNavigationSamples(
        grid,
        "ArrowDown",
        setFrameWorkSample,
        2,
      );
      const sustainedEvidence = finalizeHeldNavigationEvidence(
        "client-held-arrow-down-two-repeats-per-frame-work-5000x150-pinned",
        sustainedSamples.work,
      );
      const sustainedCadenceEvidence = finalizeHeldNavigationCadenceEvidence(
        "client-held-arrow-down-two-repeats-per-presentation-frame-cadence-5000x150-pinned",
        sustainedSamples.cadence,
      );
      expect(sustainedEvidence.summary.sampleCount).toBe(MEASURED_SAMPLE_COUNT);
      expect(sustainedEvidence.summary.budget).toBe(FRAME_BUDGET_MS);
      expect(sustainedCadenceEvidence.summary.sampleCount).toBe(MEASURED_SAMPLE_COUNT);
      expect(activeCell(grid).textContent).toBe("672");
      expect(gridSurfaceRenderCount - gridSurfaceRendersBeforeSustained).toBeLessThanOrEqual(
        TOTAL_SAMPLE_COUNT + 3,
      );
      expect(rowRenderCount - rowRendersBeforeSustained).toBeLessThanOrEqual(
        TOTAL_SAMPLE_COUNT * 2 + 3,
      );
      expect(cellRenderCount - cellRendersBeforeSustained).toBeLessThanOrEqual(
        (TOTAL_SAMPLE_COUNT * 2 + 3) * 24,
      );
      expect(toolbarRenderCount).toBe(0);
      expect(toolbarNotificationCount).toBe(0);
      expect(columnCommandNotificationCount).toBe(0);

      const gridSurfaceRendersAfterVertical = gridSurfaceRenderCount;
      const rowRendersAfterVertical = rowRenderCount;
      const cellRendersAfterVertical = cellRenderCount;
      const horizontalSamples = await collectHeldNavigationSamples(
        grid,
        "ArrowRight",
        setFrameWorkSample,
      );
      const horizontalEvidence = finalizeHeldNavigationEvidence(
        "client-held-arrow-right-input-through-render-work-5000x150-pinned",
        horizontalSamples.work,
      );
      const horizontalCadenceEvidence = finalizeHeldNavigationCadenceEvidence(
        "client-held-arrow-right-presentation-frame-cadence-5000x150-pinned",
        horizontalSamples.cadence,
      );
      expect(horizontalEvidence.summary.sampleCount).toBe(MEASURED_SAMPLE_COUNT);
      expect(horizontalEvidence.summary.budget).toBe(FRAME_BUDGET_MS);
      expect(horizontalEvidence.droppedFrames).toMatchObject({
        comparison: "measured sample > thresholdMs",
        maxCount: MAX_DROPPED_FRAME_COUNT,
        thresholdMs: DROPPED_FRAME_THRESHOLD_MS,
      });
      expect(horizontalCadenceEvidence.summary.sampleCount).toBe(MEASURED_SAMPLE_COUNT);
      expect(activeCell(grid).textContent).toBe("Held navigation row 0672");
      expect(activeCell(grid).getAttribute("aria-colindex")).toBe("150");
      expect(document.activeElement).toBe(grid);
      expect(mountedBodyRows(grid).length).toBeLessThanOrEqual(32);
      expect(mountedColumnHeaders(grid).length).toBeLessThanOrEqual(24);
      expect(mountedDataCells(grid).length).toBeLessThanOrEqual(768);
      expect(viewRenderCount).toBe(0);
      expect(gridSurfaceRenderCount - gridSurfaceRendersAfterVertical).toBeLessThanOrEqual(
        TOTAL_SAMPLE_COUNT + 3,
      );
      expect(rowRenderCount - rowRendersAfterVertical).toBeLessThanOrEqual(
        (TOTAL_SAMPLE_COUNT + 3) * 32,
      );
      expect(cellRenderCount - cellRendersAfterVertical).toBeLessThanOrEqual(
        (TOTAL_SAMPLE_COUNT + 3) * 768,
      );
      expect(toolbarRenderCount).toBe(0);
      expect(toolbarNotificationCount).toBe(0);
      expect(columnCommandNotificationCount).toBe(0);
      console.info(
        JSON.stringify({
          benchmark: "BrunoTable production held-key navigation evidence",
          evidence: [
            verticalEvidence,
            verticalCadenceEvidence,
            horizontalEvidence,
            horizontalCadenceEvidence,
            sustainedEvidence,
            sustainedCadenceEvidence,
          ],
          samples: {
            measured: MEASURED_SAMPLE_COUNT,
            warmup: WARMUP_SAMPLE_COUNT,
          },
        }),
      );
    } finally {
      restoreFrameProbe?.();
      removeColumnCommandSubscriptions();
      removeToolbarSubscriptions();
      removeCells();
      removeRows();
      removeGridSurface();
      removeView();
    }
  }, 90_000);
});
