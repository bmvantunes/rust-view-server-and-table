import { Profiler } from "react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { BrunoTableClient } from "./index";
import type { BrunoTableColumnId, BrunoTableColumns } from "./index";
import {
  accumulateBrunoTableBenchmarkFrameCallbackWork,
  captureBrunoTableReactCommitWork,
  combineBrunoTableBenchmarkFrameWork,
  distributeBrunoTableReactCommitWork,
  finalizeBrunoTableBenchmarkEvidence,
  type BrunoTableReactCommitWork,
} from "./internal/benchmark-budget";
import {
  BRUNO_TABLE_CAPABLE_HARDWARE_SAMPLE_PROTOCOL,
  getBrunoTableBenchmarkEnvironment,
} from "./internal/benchmark-profile";
import { settleBrunoTableBrowserFrames } from "./internal/browser-test-helpers";
import {
  installBrunoTableClientCellRenderListenerForTable,
  installBrunoTableClientDragFillFrameListener,
  installBrunoTableClientGridSurfaceRenderListenerForTable,
  installBrunoTableClientRowRenderListenerForTable,
  installBrunoTableClientViewRenderListenerForTable,
  type BrunoTableDragFillFrame,
} from "./internal/render-instrumentation";

type PerformanceRow = Readonly<{
  readonly id: string;
  readonly value: string;
  readonly revision: bigint;
}>;

const COLUMN_COUNT = 160;
const ROW_COUNT = 10_000;
const FIRST_CENTRE_COLUMN_ID = "COL_ID_DRAG_FILL_PERF_001";
const SECOND_CENTRE_COLUMN_ID = "COL_ID_DRAG_FILL_PERF_002";
const DRAG_FILL_FRAME_WARMUP_SAMPLES =
  BRUNO_TABLE_CAPABLE_HARDWARE_SAMPLE_PROTOCOL.warmupSampleCount;
const DRAG_FILL_FRAME_MEASURED_SAMPLES =
  BRUNO_TABLE_CAPABLE_HARDWARE_SAMPLE_PROTOCOL.measuredSampleCount;
const DRAG_FILL_FRAME_TOTAL_SAMPLES =
  DRAG_FILL_FRAME_WARMUP_SAMPLES + DRAG_FILL_FRAME_MEASURED_SAMPLES;
const HORIZONTAL_MAX_ROW_RENDERS_PER_FRAME = 10;
const HORIZONTAL_MAX_CELL_RENDERS_PER_FRAME = 75;
const HORIZONTAL_MAX_GRID_SURFACE_RENDERS_PER_FRAME = 0.75;
const VERTICAL_MAX_ROW_RENDERS_PER_FRAME = 16;
const VERTICAL_MAX_CELL_RENDERS_PER_FRAME = 125;
const VERTICAL_MAX_GRID_SURFACE_RENDERS_PER_FRAME = 1;
const DRAG_FILL_FRAME_BUDGET_MS = 8.33;
const DRAG_FILL_DROPPED_FRAME_THRESHOLD_MS = 16.66;
const DRAG_FILL_MAX_DROPPED_FRAME_COUNT = 2;
const LARGE_FILL_COLUMN_COUNT = 5_001;
const LARGE_FILL_FIRST_COLUMN_ID = "COL_ID_LARGE_FILL_0000";
const LARGE_FILL_LAST_COLUMN_ID = "COL_ID_LARGE_FILL_5000";

type LargeFillField = `fill_${number}`;
type LargeFillRow = Readonly<
  Record<LargeFillField, string> & {
    readonly id: string;
    readonly revision: bigint;
  }
>;
type ObservedLargeFillChangeSet = readonly [
  Readonly<{
    readonly rowId: string;
    readonly expectedVersion: bigint;
    readonly changes: readonly unknown[];
  }>,
];

const largeFillColumns = Array.from({ length: LARGE_FILL_COLUMN_COUNT }, (_unused, index) => {
  const suffix = String(index).padStart(4, "0");
  return {
    columnId: `COL_ID_LARGE_FILL_${suffix}` as BrunoTableColumnId,
    field: `fill_${index}` as LargeFillField,
    headerName: `Large fill ${suffix}`,
    valueType: "text" as const,
    width: 80,
    isEditable: true as const,
    ...(index === 0 ? { pinned: "start" as const } : {}),
    ...(index === LARGE_FILL_COLUMN_COUNT - 1 ? { pinned: "end" as const } : {}),
  };
}) as BrunoTableColumns<LargeFillRow>;

const largeFillRow = Object.freeze({
  id: "large-fill-row",
  revision: 1n,
  ...Object.fromEntries(
    Array.from({ length: LARGE_FILL_COLUMN_COUNT }, (_unused, index) => [
      `fill_${index}`,
      `value-${String(index).padStart(4, "0")}`,
    ]),
  ),
}) as LargeFillRow;

type ClearableMock = Readonly<{ mockClear: () => unknown }>;

type DragFillFrameWorkSample = {
  admissionDurationMs: number;
  callbackDurationMs: number;
  frameTimestampMs: number;
};

const columns = Array.from({ length: COLUMN_COUNT }, (_unused, index) => ({
  columnId: `COL_ID_DRAG_FILL_PERF_${String(index).padStart(3, "0")}` as BrunoTableColumnId,
  field: "value" as const,
  headerName: `Performance ${String(index).padStart(3, "0")}`,
  valueType: "text" as const,
  width: 120,
  isEditable: true,
  ...(index === 0 ? { pinned: "start" as const } : {}),
  ...(index === COLUMN_COUNT - 1 ? { pinned: "end" as const } : {}),
})) as BrunoTableColumns<PerformanceRow>;

const rows = Array.from({ length: ROW_COUNT }, (_unused, index) => ({
  id: `drag-fill-performance-${String(index).padStart(5, "0")}`,
  value: `Row ${String(index).padStart(5, "0")}`,
  revision: BigInt(index + 1),
})) satisfies readonly PerformanceRow[];

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

function mountedDataCells(grid: HTMLElement, rowId?: string): HTMLElement[] {
  return [
    ...grid.querySelectorAll<HTMLElement>(
      "[role=gridcell][data-bruno-row-id][data-bruno-column-id]",
    ),
  ]
    .filter((cell) => cell.closest("[role=grid]") === grid)
    .filter((cell) => rowId === undefined || cell.dataset["brunoRowId"] === rowId);
}

function cell(grid: HTMLElement, rowId: string, columnId: string): HTMLElement {
  const target = mountedDataCells(grid, rowId).find(
    (candidate) => candidate.dataset["brunoColumnId"] === columnId,
  );
  if (target === undefined) throw new Error(`Expected mounted ${rowId}/${columnId} cell.`);
  return target;
}

function dragHandle(grid: HTMLElement): HTMLElement {
  const handle = grid.querySelector<HTMLElement>("[data-bruno-drag-fill-handle]");
  if (handle === null)
    throw new Error("Expected the selected source to expose a Drag Fill handle.");
  return handle;
}

function visibleBodyGeometry(grid: HTMLElement): Readonly<{
  readonly bottom: number;
  readonly top: number;
  readonly y: number;
}> {
  const header = grid.querySelector<HTMLElement>('thead[role="rowgroup"]');
  const body = grid.querySelector<HTMLElement>('tbody[role="rowgroup"]');
  if (header === null || body === null)
    throw new Error("Expected mounted header and body row groups for Drag Fill geometry.");
  const gridBounds = grid.getBoundingClientRect();
  const headerBounds = header.getBoundingClientRect();
  const bodyBounds = body.getBoundingClientRect();
  const top = Math.max(gridBounds.top, headerBounds.bottom, bodyBounds.top);
  const bottom = Math.min(gridBounds.bottom, bodyBounds.bottom);
  if (bottom - top < 6)
    throw new Error("Expected a visible body lane below the mounted table header.");
  return { top, bottom, y: top + Math.min(12, (bottom - top) / 2) };
}

function mountedCentreLane(grid: HTMLElement): Readonly<{
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly y: number;
}> {
  const start = grid.querySelector<HTMLElement>('[data-bruno-pinned-body-region="start"]');
  const end = grid.querySelector<HTMLElement>('[data-bruno-pinned-body-region="end"]');
  if (start === null || end === null)
    throw new Error("Expected mounted start and end pinned body regions.");
  if (
    start.querySelector('[role="gridcell"][data-bruno-row-id]') === null ||
    end.querySelector('[role="gridcell"][data-bruno-row-id]') === null
  ) {
    throw new Error("Expected mounted data cells in both pinned body regions.");
  }
  const body = visibleBodyGeometry(grid);
  const startBounds = start.getBoundingClientRect();
  const endBounds = end.getBoundingClientRect();
  const [leftPinnedBounds, rightPinnedBounds] = [startBounds, endBounds].toSorted(
    (left, right) => left.left - right.left,
  );
  if (leftPinnedBounds === undefined || rightPinnedBounds === undefined)
    throw new Error("Expected both pinned regions to have geometry.");
  const left = leftPinnedBounds.right;
  const right = rightPinnedBounds.left;
  if (right - left < 6)
    throw new Error("Expected a visible centre lane between mounted pinned body regions.");
  return { ...body, left, right };
}

function physicalRightCentreEdge(
  grid: HTMLElement,
  rowId: string,
): Readonly<{ cell: HTMLElement; point: Readonly<{ x: number; y: number }> }> {
  const lane = mountedCentreLane(grid);
  const point = {
    x: lane.right - 3,
    y: lane.y,
  };
  const hit = document.elementFromPoint(point.x, point.y);
  const cell = mountedDataCells(grid, rowId).find(
    (candidate) =>
      candidate.closest("[data-bruno-pinned-body-region]") === null && candidate.contains(hit),
  );
  if (cell === undefined)
    throw new Error("Expected a topmost cell at the physical right centre edge.");
  return { cell, point };
}

function physicalLeftCentreEdge(
  grid: HTMLElement,
  rowId: string,
): Readonly<{ cell: HTMLElement; point: Readonly<{ x: number; y: number }> }> {
  const lane = mountedCentreLane(grid);
  const point = {
    x: lane.left + 3,
    y: lane.y,
  };
  const hit = document.elementFromPoint(point.x, point.y);
  const cell = mountedDataCells(grid, rowId).find(
    (candidate) =>
      candidate.closest("[data-bruno-pinned-body-region]") === null && candidate.contains(hit),
  );
  if (cell === undefined)
    throw new Error("Expected a topmost cell at the physical left centre edge.");
  return { cell, point };
}

function physicalBottomCentreCell(
  grid: HTMLElement,
  columnId: string,
): Readonly<{ cell: HTMLElement; point: Readonly<{ x: number; y: number }> }> {
  const lane = mountedCentreLane(grid);
  const candidates = mountedDataCells(grid)
    .filter(
      (candidate) =>
        candidate.dataset["brunoColumnId"] === columnId &&
        candidate.closest("[data-bruno-pinned-body-region]") === null,
    )
    .toSorted(
      (left, right) => right.getBoundingClientRect().bottom - left.getBoundingClientRect().bottom,
    );
  const target = candidates.find((candidate) => {
    const bounds = candidate.getBoundingClientRect();
    const point = {
      x: Math.min(lane.right - 3, Math.max(lane.left + 3, bounds.left + bounds.width / 2)),
      y: lane.bottom - 3,
    };
    const hit = document.elementFromPoint(point.x, point.y);
    return (
      point.y >= bounds.top && point.y < bounds.bottom && hit !== null && candidate.contains(hit)
    );
  });
  if (target === undefined)
    throw new Error("Expected a topmost cell at the physical bottom centre edge.");
  const bounds = target.getBoundingClientRect();
  return {
    cell: target,
    point: {
      x: Math.min(lane.right - 3, Math.max(lane.left + 3, bounds.left + bounds.width / 2)),
      y: lane.bottom - 3,
    },
  };
}

function mountedRowIds(grid: HTMLElement): readonly string[] {
  return [
    ...new Set(
      mountedDataCells(grid)
        .map((candidate) => candidate.dataset["brunoRowId"])
        .filter((rowId): rowId is string => rowId !== undefined),
    ),
  ];
}

function assertDragFillFrameBudget(
  name: string,
  samples: readonly DragFillFrameWorkSample[],
  reactCommits: readonly BrunoTableReactCommitWork[],
  callbackDurationsByTimestamp: ReadonlyMap<number, number>,
): void {
  const reactDurations = distributeBrunoTableReactCommitWork(
    samples.map((sample) => sample.frameTimestampMs),
    reactCommits,
  );
  const durations = samples.map((sample, index) =>
    combineBrunoTableBenchmarkFrameWork({
      admissionDurationMs: sample.admissionDurationMs,
      renderedFrame: {
        callbackDurationMs:
          callbackDurationsByTimestamp.get(sample.frameTimestampMs) ?? Number.POSITIVE_INFINITY,
        reactDurationMs: reactDurations[index] ?? Number.POSITIVE_INFINITY,
      },
      presentationFrame: { callbackDurationMs: 0, reactDurationMs: 0 },
    }),
  );
  expect(durations).toHaveLength(DRAG_FILL_FRAME_TOTAL_SAMPLES);
  const evidence = finalizeBrunoTableBenchmarkEvidence(durations, {
    scenario: name,
    profile: "chromium-capable-hardware-v1",
    warmupSampleCount: DRAG_FILL_FRAME_WARMUP_SAMPLES,
    measuredSampleCount: DRAG_FILL_FRAME_MEASURED_SAMPLES,
    budgetMs: DRAG_FILL_FRAME_BUDGET_MS,
    droppedFrameThresholdMs: DRAG_FILL_DROPPED_FRAME_THRESHOLD_MS,
    environment: getBrunoTableBenchmarkEnvironment(),
    maxDroppedFrameCount: DRAG_FILL_MAX_DROPPED_FRAME_COUNT,
  });
  expect(evidence.summary.sampleCount).toBe(DRAG_FILL_FRAME_MEASURED_SAMPLES);
  expect(evidence.droppedFrames.comparison).toBe("measured sample > thresholdMs");
}

function resetDragFillInstrumentation(
  frames: BrunoTableDragFillFrame[],
  frameWorkSamples: DragFillFrameWorkSample[],
  reactCommits: BrunoTableReactCommitWork[],
  ...renderMocks: readonly ClearableMock[]
): void {
  frames.length = 0;
  frameWorkSamples.length = 0;
  reactCommits.length = 0;
  for (const renderMock of renderMocks) renderMock.mockClear();
}

async function assertNoAutoscrollFramesAfterCancel(
  frames: readonly BrunoTableDragFillFrame[],
  snapshot: readonly BrunoTableDragFillFrame[],
): Promise<void> {
  await settleBrunoTableBrowserFrames(3);
  const laterFrames = frames.slice(snapshot.length);
  expect(
    laterFrames.filter((frame) => frame.phase === "scheduled" || frame.phase === "ran"),
  ).toEqual([]);
}

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

describe("BrunoTable Drag Fill performance acceptance", () => {
  test("fills five thousand virtualized cells through a pinned destination as one bounded Immediate gesture", async () => {
    const tableId = "TABLE_ID_DRAG_FILL_LARGE_ATOMIC";
    const onSaveEdits = vi.fn((_changes: unknown) => Promise.resolve());
    const frames: BrunoTableDragFillFrame[] = [];
    const viewRenders = vi.fn();
    const gridSurfaceRenders = vi.fn();
    const rowRenders = vi.fn();
    const cellRenders = vi.fn();
    const removeFrames = installBrunoTableClientDragFillFrameListener(tableId, (event) => {
      frames.push(event);
    });
    const removeView = installBrunoTableClientViewRenderListenerForTable(tableId, viewRenders);
    const removeGridSurface = installBrunoTableClientGridSurfaceRenderListenerForTable(
      tableId,
      gridSurfaceRenders,
    );
    const removeRows = installBrunoTableClientRowRenderListenerForTable(tableId, rowRenders);
    const removeCells = installBrunoTableClientCellRenderListenerForTable(tableId, cellRenders);

    try {
      await render(
        <div style={{ width: 320 }}>
          <BrunoTableClient
            tableId={tableId}
            columns={largeFillColumns}
            initialOrderBy={[{ columnId: LARGE_FILL_FIRST_COLUMN_ID, direction: "asc" }]}
            clientSource={{
              rows: [largeFillRow],
              totalRows: 1,
              version: 1,
              status: "ready",
            }}
            getRowId={(row: LargeFillRow) => row.id}
            editable
            getRowVersion={(row: LargeFillRow) => row.revision}
            onSaveEdits={onSaveEdits}
          />
        </div>,
      );
      await expect.element(page.getByRole("grid", { name: `Data for ${tableId}` })).toBeVisible();
      const grid = page.getByRole("grid", { name: `Data for ${tableId}` }).element() as HTMLElement;
      await settleBrunoTableBrowserFrames();
      const source = cell(grid, largeFillRow.id, LARGE_FILL_FIRST_COLUMN_ID);
      await userEvent.click(source);
      await settleBrunoTableBrowserFrames();
      const sourceHandle = dragHandle(grid);
      const destination = cell(grid, largeFillRow.id, LARGE_FILL_LAST_COLUMN_ID);
      expect(destination.closest('[data-bruno-pinned-body-region="end"]')).not.toBeNull();
      expect(mountedDataCells(grid).length).toBeLessThan(100);
      expect(
        mountedDataCells(grid).some(
          (candidate) => candidate.dataset["brunoColumnId"] === "COL_ID_LARGE_FILL_2500",
        ),
      ).toBe(false);

      resetDragFillInstrumentation(
        frames,
        [],
        [],
        viewRenders,
        gridSurfaceRenders,
        rowRenders,
        cellRenders,
      );
      await userEvent.dragAndDrop(sourceHandle, destination, { steps: 24 });
      await settleBrunoTableBrowserFrames();

      await vi.waitFor(() => expect(onSaveEdits).toHaveBeenCalledOnce());
      const changeSet = (
        onSaveEdits.mock.calls as unknown as readonly [readonly [ObservedLargeFillChangeSet]]
      )[0][0];
      expect(changeSet).toHaveLength(1);
      expect(changeSet[0]).toMatchObject({ rowId: largeFillRow.id, expectedVersion: 1n });
      expect(changeSet[0].changes).toHaveLength(5_000);
      expect(changeSet[0].changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            columnId: "COL_ID_LARGE_FILL_2500",
            field: "fill_2500",
            before: "value-2500",
            after: "value-0000",
          }),
          expect.objectContaining({
            columnId: LARGE_FILL_LAST_COLUMN_ID,
            field: "fill_5000",
            before: "value-5000",
            after: "value-0000",
          }),
        ]),
      );
      expect(frames.length).toBeLessThanOrEqual(64);
      expect(viewRenders.mock.calls.length).toBeLessThanOrEqual(2);
      expect(gridSurfaceRenders.mock.calls.length).toBeLessThanOrEqual(2);
      expect(rowRenders.mock.calls.length).toBeLessThanOrEqual(4);
      expect(cellRenders.mock.calls.length).toBeLessThan(100);
      expect(mountedDataCells(grid).length).toBeLessThan(100);
    } finally {
      removeCells();
      removeRows();
      removeGridSurface();
      removeView();
      removeFrames();
    }
  }, 30_000);

  test("reads the current computed direction for horizontal edge autoscroll", async () => {
    const tableId = "TABLE_ID_DRAG_FILL_DIRECTION_AFTER_MOUNT";
    const screen = await render(
      <div dir="ltr" style={{ width: 320 }}>
        <BrunoTableClient
          tableId={tableId}
          columns={columns}
          initialOrderBy={[{ columnId: FIRST_CENTRE_COLUMN_ID, direction: "asc" }]}
          clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
          getRowId={(row) => row.id}
          editable
          getRowVersion={(row) => row.revision}
          onSaveEdits={() => Promise.resolve()}
        />
      </div>,
    );
    await expect.element(page.getByRole("grid", { name: `Data for ${tableId}` })).toBeVisible();
    const grid = page.getByRole("grid", { name: `Data for ${tableId}` }).element() as HTMLElement;
    await settleBrunoTableBrowserFrames();
    grid.focus();
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    await settleBrunoTableBrowserFrames();

    await screen.rerender(
      <div dir="rtl" style={{ width: 320 }}>
        <BrunoTableClient
          tableId={tableId}
          columns={columns}
          initialOrderBy={[{ columnId: FIRST_CENTRE_COLUMN_ID, direction: "asc" }]}
          clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
          getRowId={(row) => row.id}
          editable
          getRowVersion={(row) => row.revision}
          onSaveEdits={() => Promise.resolve()}
        />
      </div>,
    );
    await settleBrunoTableBrowserFrames();

    const handle = dragHandle(grid);
    const sourceRowId = handle.closest<HTMLElement>("[data-bruno-row-id]")?.dataset["brunoRowId"];
    if (sourceRowId === undefined)
      throw new Error("Expected the handle to have an owning source row.");
    const physicalLeftEdge = physicalLeftCentreEdge(grid, sourceRowId);
    const initialScrollLeft = grid.scrollLeft;
    handle.dispatchEvent(pointer("pointerdown", 703, centerOf(handle)));
    physicalLeftEdge.cell.dispatchEvent(pointer("pointermove", 703, physicalLeftEdge.point));
    await settleBrunoTableBrowserFrames(2);

    expect(grid.scrollLeft).not.toBe(initialScrollLeft);
    window.dispatchEvent(pointer("pointercancel", 703, physicalLeftEdge.point));
  });

  test.each(["ltr", "rtl"] as const)(
    "keeps %s stationary preview off React and bounds virtual work during physical edge autoscroll",
    async (direction) => {
      const tableId = `TABLE_ID_DRAG_FILL_PERFORMANCE_${direction.toUpperCase()}`;
      const frames: BrunoTableDragFillFrame[] = [];
      const frameWorkSamples: DragFillFrameWorkSample[] = [];
      const reactCommits: BrunoTableReactCommitWork[] = [];
      const callbackDurationsByTimestamp = new Map<number, number>();
      let pendingAdmissionDurationMs = 0;
      let currentAnimationFrameTimestamp: number | undefined;
      let collectFrameWork = false;
      let restoreFrameProbe = () => {};
      const viewRenders = vi.fn();
      const gridSurfaceRenders = vi.fn();
      const rowRenders = vi.fn();
      const cellRenders = vi.fn();
      const removeFrames = installBrunoTableClientDragFillFrameListener(tableId, (event) => {
        frames.push(event);
        if (event.phase === "ran" && collectFrameWork) {
          if (currentAnimationFrameTimestamp === undefined) {
            throw new Error("Expected Drag Fill work to run inside an animation frame.");
          }
          frameWorkSamples.push({
            admissionDurationMs: pendingAdmissionDurationMs,
            callbackDurationMs: event.durationMs,
            frameTimestampMs: currentAnimationFrameTimestamp,
          });
          pendingAdmissionDurationMs = 0;
        }
      });
      const removeView = installBrunoTableClientViewRenderListenerForTable(tableId, viewRenders);
      const removeGridSurface = installBrunoTableClientGridSurfaceRenderListenerForTable(
        tableId,
        gridSurfaceRenders,
      );
      const removeRows = installBrunoTableClientRowRenderListenerForTable(tableId, rowRenders);
      const removeCells = installBrunoTableClientCellRenderListenerForTable(tableId, cellRenders);

      try {
        await render(
          <Profiler
            id={`drag-fill-performance-${direction}`}
            onRender={(_id, _phase, actualDuration, _baseDuration, startTime, commitTime) => {
              reactCommits.push(
                captureBrunoTableReactCommitWork({
                  actualDurationMs: actualDuration,
                  commitTimeMs: commitTime,
                  observedAtMs: performance.now(),
                  startTimeMs: startTime,
                }),
              );
            }}
          >
            <div dir={direction} style={{ width: 320 }}>
              <BrunoTableClient
                tableId={tableId}
                columns={columns}
                initialOrderBy={[{ columnId: FIRST_CENTRE_COLUMN_ID, direction: "asc" }]}
                clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
                getRowId={(row) => row.id}
                editable
                getRowVersion={(row) => row.revision}
                onSaveEdits={() => Promise.resolve()}
              />
            </div>
          </Profiler>,
        );
        await expect.element(page.getByRole("grid", { name: `Data for ${tableId}` })).toBeVisible();
        const grid = page
          .getByRole("grid", { name: `Data for ${tableId}` })
          .element() as HTMLElement;
        await expect.element(grid).toHaveAttribute("aria-rowcount", String(ROW_COUNT + 1));
        await settleBrunoTableBrowserFrames();
        expect(mountedDataCells(grid).length).toBeLessThan(250);
        mountedCentreLane(grid);

        const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
        const requestAnimationFrameProbe = vi
          .spyOn(window, "requestAnimationFrame")
          .mockImplementation((callback) =>
            nativeRequestAnimationFrame((timestamp) => {
              const startedAt = performance.now();
              currentAnimationFrameTimestamp = timestamp;
              try {
                callback(timestamp);
              } finally {
                currentAnimationFrameTimestamp = undefined;
                if (collectFrameWork) {
                  accumulateBrunoTableBenchmarkFrameCallbackWork(
                    callbackDurationsByTimestamp,
                    timestamp,
                    performance.now() - startedAt,
                  );
                }
              }
            }),
          );
        restoreFrameProbe = () => requestAnimationFrameProbe.mockRestore();

        grid.focus();
        await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
        await settleBrunoTableBrowserFrames();
        const handle = dragHandle(grid);
        const sourceRowId =
          handle.closest<HTMLElement>("[data-bruno-row-id]")?.dataset["brunoRowId"];
        if (sourceRowId === undefined)
          throw new Error("Expected the handle to have an owning source row.");
        const stationaryTarget = cell(grid, sourceRowId, SECOND_CENTRE_COLUMN_ID);

        resetDragFillInstrumentation(
          frames,
          frameWorkSamples,
          reactCommits,
          viewRenders,
          gridSurfaceRenders,
          rowRenders,
          cellRenders,
        );
        handle.dispatchEvent(pointer("pointerdown", 701, centerOf(handle)));
        stationaryTarget.dispatchEvent(pointer("pointermove", 701, centerOf(stationaryTarget)));
        await settleBrunoTableBrowserFrames();

        expect(frames.map((frame) => frame.phase)).toEqual(["scheduled", "ran"]);
        expect(viewRenders).not.toHaveBeenCalled();
        expect(gridSurfaceRenders).not.toHaveBeenCalled();
        expect(rowRenders).not.toHaveBeenCalled();
        expect(cellRenders).not.toHaveBeenCalled();

        const physicalCentreEdge =
          direction === "ltr"
            ? physicalRightCentreEdge(grid, sourceRowId)
            : physicalLeftCentreEdge(grid, sourceRowId);
        const initialScrollLeft = grid.scrollLeft;
        resetDragFillInstrumentation(
          frames,
          frameWorkSamples,
          reactCommits,
          viewRenders,
          gridSurfaceRenders,
          rowRenders,
          cellRenders,
        );
        callbackDurationsByTimestamp.clear();
        collectFrameWork = true;
        const horizontalAdmissionStartedAt = performance.now();
        physicalCentreEdge.cell.dispatchEvent(
          pointer("pointermove", 701, physicalCentreEdge.point),
        );
        pendingAdmissionDurationMs = performance.now() - horizontalAdmissionStartedAt;
        await settleBrunoTableBrowserFrames(
          DRAG_FILL_FRAME_TOTAL_SAMPLES,
          nativeRequestAnimationFrame,
        );
        collectFrameWork = false;
        expect(grid.scrollLeft).not.toBe(initialScrollLeft);
        expect(frames.some((frame) => frame.phase === "scheduled")).toBe(true);
        expect(frames.some((frame) => frame.phase === "ran")).toBe(true);
        assertDragFillFrameBudget(
          `${direction} horizontal Drag Fill input-through-render work`,
          frameWorkSamples,
          reactCommits,
          callbackDurationsByTimestamp,
        );
        expect(viewRenders.mock.calls.length).toBeLessThanOrEqual(8);
        expect(gridSurfaceRenders.mock.calls.length).toBeLessThan(
          DRAG_FILL_FRAME_TOTAL_SAMPLES * HORIZONTAL_MAX_GRID_SURFACE_RENDERS_PER_FRAME,
        );
        expect(rowRenders.mock.calls.length).toBeLessThan(
          DRAG_FILL_FRAME_TOTAL_SAMPLES * HORIZONTAL_MAX_ROW_RENDERS_PER_FRAME,
        );
        expect(cellRenders.mock.calls.length).toBeLessThan(
          DRAG_FILL_FRAME_TOTAL_SAMPLES * HORIZONTAL_MAX_CELL_RENDERS_PER_FRAME,
        );
        expect(mountedDataCells(grid).length).toBeLessThan(250);

        const horizontalFrameCountBeforeCancel = frames.length;
        window.dispatchEvent(pointer("pointercancel", 701, physicalCentreEdge.point));
        const horizontalCancelSnapshot = [...frames];
        expect(
          horizontalCancelSnapshot
            .slice(horizontalFrameCountBeforeCancel)
            .every((frame) => frame.phase === "cancelled"),
        ).toBe(true);
        await assertNoAutoscrollFramesAfterCancel(frames, horizontalCancelSnapshot);

        grid.scrollLeft = initialScrollLeft;
        grid.dispatchEvent(new Event("scroll"));
        await settleBrunoTableBrowserFrames(2);

        const verticalSource = cell(grid, sourceRowId, FIRST_CENTRE_COLUMN_ID);
        await userEvent.click(verticalSource);
        await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
        await settleBrunoTableBrowserFrames();
        const verticalHandle = dragHandle(grid);
        const verticalColumnId =
          verticalHandle.closest<HTMLElement>("[data-bruno-column-id]")?.dataset["brunoColumnId"];
        if (verticalColumnId === undefined)
          throw new Error("Expected the vertical handle to own a column.");
        const physicalBottomEdge = physicalBottomCentreCell(grid, verticalColumnId);
        const initialScrollTop = grid.scrollTop;
        const mountedRowsBeforeVerticalAutoscroll = mountedRowIds(grid);
        resetDragFillInstrumentation(
          frames,
          frameWorkSamples,
          reactCommits,
          viewRenders,
          gridSurfaceRenders,
          rowRenders,
          cellRenders,
        );
        callbackDurationsByTimestamp.clear();
        verticalHandle.dispatchEvent(pointer("pointerdown", 702, centerOf(verticalHandle)));
        collectFrameWork = true;
        const verticalAdmissionStartedAt = performance.now();
        physicalBottomEdge.cell.dispatchEvent(
          pointer("pointermove", 702, physicalBottomEdge.point),
        );
        pendingAdmissionDurationMs = performance.now() - verticalAdmissionStartedAt;
        await settleBrunoTableBrowserFrames(
          DRAG_FILL_FRAME_TOTAL_SAMPLES,
          nativeRequestAnimationFrame,
        );
        collectFrameWork = false;

        expect(grid.scrollTop).toBeGreaterThan(initialScrollTop);
        expect(frames.some((frame) => frame.phase === "scheduled")).toBe(true);
        expect(frames.some((frame) => frame.phase === "ran")).toBe(true);
        assertDragFillFrameBudget(
          `${direction} vertical Drag Fill input-through-render work`,
          frameWorkSamples,
          reactCommits,
          callbackDurationsByTimestamp,
        );
        expect(viewRenders.mock.calls.length).toBeLessThanOrEqual(12);
        expect(gridSurfaceRenders.mock.calls.length).toBeLessThan(
          DRAG_FILL_FRAME_TOTAL_SAMPLES * VERTICAL_MAX_GRID_SURFACE_RENDERS_PER_FRAME,
        );
        expect(rowRenders.mock.calls.length).toBeLessThan(
          DRAG_FILL_FRAME_TOTAL_SAMPLES * VERTICAL_MAX_ROW_RENDERS_PER_FRAME,
        );
        expect(cellRenders.mock.calls.length).toBeLessThan(
          DRAG_FILL_FRAME_TOTAL_SAMPLES * VERTICAL_MAX_CELL_RENDERS_PER_FRAME,
        );
        expect(mountedDataCells(grid).length).toBeLessThan(250);
        const mountedRowsAfterVerticalAutoscroll = mountedRowIds(grid);
        expect(
          mountedRowsAfterVerticalAutoscroll.some(
            (rowId) => !mountedRowsBeforeVerticalAutoscroll.includes(rowId),
          ),
        ).toBe(true);

        const verticalFrameCountBeforeCancel = frames.length;
        window.dispatchEvent(pointer("pointercancel", 702, physicalBottomEdge.point));
        const verticalCancelSnapshot = [...frames];
        expect(
          verticalCancelSnapshot
            .slice(verticalFrameCountBeforeCancel)
            .every((frame) => frame.phase === "cancelled"),
        ).toBe(true);
        await assertNoAutoscrollFramesAfterCancel(frames, verticalCancelSnapshot);
      } finally {
        collectFrameWork = false;
        restoreFrameProbe();
        removeCells();
        removeRows();
        removeGridSurface();
        removeView();
        removeFrames();
      }
    },
    30_000,
  );
});
