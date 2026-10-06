import { createElement, Profiler } from "react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { Schema } from "effect";
import { ViewServerId, defineViewServerConfig } from "effect-view-server/config";
import { createViewServerReact } from "effect-view-server/react";

import { BrunoTableServer } from "./index";
import type { BrunoTableColumnId, BrunoTableColumns } from "./index";
import {
  captureBrunoTableReactCommitWork,
  combineBrunoTableBenchmarkFrameWork,
  finalizeBrunoTableBenchmarkEvidence,
} from "./internal/benchmark-budget";
import {
  BRUNO_TABLE_CAPABLE_HARDWARE_SAMPLE_PROTOCOL,
  getBrunoTableBenchmarkEnvironment,
} from "./internal/benchmark-profile";
import { settleBrunoTableBrowserFrames } from "./internal/browser-test-helpers";
import {
  installBrunoTableClientCellRenderListenerForTable,
  installBrunoTableClientGridSurfaceRenderListenerForTable,
  installBrunoTableClientHeaderRenderListenerForTable,
  installBrunoTableClientRowRenderListenerForTable,
  installBrunoTableClientViewRenderListenerForTable,
} from "./internal/render-instrumentation";
import { brunoTableTestSemanticQueryKey } from "./internal/server-semantic-key.test-support";

type ProductionServerRow = Readonly<{
  readonly id: string;
  readonly desk: string;
  readonly price: number;
}>;

const ROW_COUNT = 5_000;
const COLUMN_COUNT = 150;
const TABLE_ID = "TABLE_ID_PRODUCTION_SERVER_WORKLOAD";
const GROUPED_TABLE_ID = "TABLE_ID_PRODUCTION_SERVER_GROUPED_WORKLOAD";
const DELIVERY_WARMUP_SAMPLE_COUNT = BRUNO_TABLE_CAPABLE_HARDWARE_SAMPLE_PROTOCOL.warmupSampleCount;
const DELIVERY_MEASURED_SAMPLE_COUNT =
  BRUNO_TABLE_CAPABLE_HARDWARE_SAMPLE_PROTOCOL.measuredSampleCount;
const DELIVERY_SAMPLE_COUNT = DELIVERY_WARMUP_SAMPLE_COUNT + DELIVERY_MEASURED_SAMPLE_COUNT;
const TARGET_ROW_INDEX = 4_000;
const FIXED_ROW_HEIGHT = 36;

type RenderedFrameWorkSample = {
  callbackDurationMs: number;
  reactCommitCount: number;
  reactDurationMs: number;
};

const columns = Object.freeze([
  {
    columnId: "COL_ID_PRODUCTION_SERVER_DESK",
    field: "desk",
    headerName: "Server desk",
    valueType: "text",
    groupBy: true,
    width: 120,
  },
  ...Array.from({ length: COLUMN_COUNT - 1 }, (_unused, index) => ({
    columnId:
      `COL_ID_PRODUCTION_SERVER_PRICE_${String(index).padStart(3, "0")}` as BrunoTableColumnId,
    field: "price" as const,
    headerName: `Server price ${String(index).padStart(3, "0")}`,
    valueType: "number" as const,
    aggFunc: "max" as const,
    width: 120,
    ...(index === 0 ? { pinned: "start" as const } : {}),
    ...(index === COLUMN_COUNT - 2 ? { pinned: "end" as const } : {}),
  })),
]) as BrunoTableColumns<ProductionServerRow>;

const viewportConfig = defineViewServerConfig({
  topics: {
    productionServerRows: {
      schema: Schema.Struct({
        id: ViewServerId,
        desk: Schema.String,
        price: Schema.Number,
      }),
    },
  },
});
const viewportReact = createViewServerReact(viewportConfig);
type ViewportSource = ReturnType<typeof viewportReact.useLiveQueryViewport>;
type Viewport = Omit<ViewportSource["viewport"], "destroy">;
const completeRawSelect = Object.freeze([
  "id",
  "desk",
  "price",
]) as unknown as ViewportSource["completeRawSelect"];

type Window = Readonly<{ readonly firstRow: number; readonly lastRow: number }>;
type Sink = Readonly<{
  readonly setRowCount: (count: number, keepRenderedRows?: boolean) => void;
  readonly setRowData: (
    rowsByIndex: Readonly<Record<number, Partial<ProductionServerRow>>>,
    rowKeysByIndex: Readonly<Record<number, string>>,
  ) => void;
}>;
type Request = Readonly<{
  readonly window: Window;
  readonly query: unknown;
  readonly sink: Sink;
}>;

function useWholeResult() {
  return { rows: [], totalRows: 0, version: 1, status: "ready" as const };
}

function createSparseViewport() {
  const requests: Request[] = [];
  const windows: Window[] = [];
  const releases = vi.fn();
  const viewport = {
    semanticKey: brunoTableTestSemanticQueryKey,
    replace(request: Request) {
      requests.push(request);
      windows.push(request.window);
      request.sink.setRowCount(ROW_COUNT, true);
      return {
        setWindow(window: Window) {
          windows.push(window);
        },
        release: releases,
      };
    },
  } as unknown as Viewport;
  return { releases, requests, viewport, windows };
}

function rawRowAt(index: number, price = index): ProductionServerRow {
  return Object.freeze({
    id: `row-${String(index).padStart(4, "0")}`,
    desk: `Desk ${String(index).padStart(4, "0")}`,
    price,
  });
}

function publishRawWindow(request: Request, window: Window, retainedWindow?: Window): void {
  const rows: Record<number, ProductionServerRow> = {};
  const keys: Record<number, string> = {};
  for (let index = window.firstRow; index <= Math.min(window.lastRow, ROW_COUNT - 1); index += 1) {
    if (
      retainedWindow !== undefined &&
      index >= retainedWindow.firstRow &&
      index <= retainedWindow.lastRow
    )
      continue;
    const row = rawRowAt(index);
    rows[index] = row;
    keys[index] = row.id;
  }
  if (Object.keys(rows).length > 0) request.sink.setRowData(rows, keys);
}

function groupedAliases(query: unknown): Readonly<{
  readonly aggregateAliases: readonly string[];
  readonly rowsAlias: string;
}> {
  const groupedQuery = query as Readonly<{
    readonly aggregates: Readonly<Record<string, Readonly<{ readonly aggFunc: string }>>>;
    readonly groupBy: readonly string[];
  }>;
  expect(groupedQuery.groupBy).toEqual(["desk"]);
  const entries = Object.entries(groupedQuery.aggregates);
  const rowsAlias = entries.find(([, aggregate]) => aggregate.aggFunc === "count")?.[0];
  expect.assert(rowsAlias);
  return Object.freeze({
    aggregateAliases: Object.freeze(
      entries.filter(([, aggregate]) => aggregate.aggFunc === "max").map(([alias]) => alias),
    ),
    rowsAlias,
  });
}

function publishGroupedWindow(request: Request, window: Window): void {
  const aliases = groupedAliases(request.query);
  expect(aliases.aggregateAliases).toHaveLength(COLUMN_COUNT - 1);
  const rows: Record<number, Record<string, unknown>> = {};
  const keys: Record<number, string> = {};
  for (let index = window.firstRow; index <= Math.min(window.lastRow, ROW_COUNT - 1); index += 1) {
    const row: Record<string, unknown> = {
      desk: `Desk ${String(index).padStart(4, "0")}`,
      [aliases.rowsAlias]: 1n,
    };
    for (const alias of aliases.aggregateAliases) row[alias] = index;
    rows[index] = row;
    keys[index] = `group-${String(index).padStart(4, "0")}`;
  }
  request.sink.setRowData(rows, keys);
}

function mountedBodyRows(grid: HTMLElement): readonly HTMLElement[] {
  return [...grid.querySelectorAll<HTMLElement>('tbody[role="rowgroup"] > tr[role="row"]')];
}

function mountedHeaders(grid: HTMLElement): readonly HTMLElement[] {
  return [...grid.querySelectorAll<HTMLElement>("thead th[data-bruno-column-id]")];
}

const nativeAnimationFrame = window.requestAnimationFrame.bind(window);

function nextAnimationFrameTimestamp(): Promise<number> {
  return new Promise((resolve) => nativeAnimationFrame(resolve));
}

afterEach(async () => {
  await cleanup();
});

describe("BrunoTable Server production-semantics performance Browser harness", () => {
  test("uses production React with enabled render profiling", async () => {
    expect(Object.isFrozen(createElement("span", null, "production probe"))).toBe(false);
    expect(import.meta.env.PROD).toBe(true);
    const onRender = vi.fn();
    const screen = await render(
      <Profiler id="production-runtime-probe" onRender={onRender}>
        <output aria-label="Production runtime probe">Production profiling is enabled</output>
      </Profiler>,
    );
    await expect
      .element(screen.getByRole("status", { name: "Production runtime probe" }))
      .toBeVisible();
    expect(onRender).toHaveBeenCalled();
  });

  test("replaces sparse semantic generations for real filter, sort, and Group By commands", async () => {
    const tableId = "TABLE_ID_PRODUCTION_SERVER_COMMAND_TRANSITIONS";
    const transport = createSparseViewport();
    const screen = await render(
      <div style={{ height: 500, width: 1_200 }}>
        <BrunoTableServer
          tableId={tableId}
          columns={columns}
          initialOrderBy={[{ columnId: "COL_ID_PRODUCTION_SERVER_DESK", direction: "asc" }]}
          viewportSource={{
            viewport: transport.viewport,
            useWholeResult,
            completeRawSelect,
            totalRows: ROW_COUNT,
            version: 1,
            status: "ready",
          }}
        />
      </div>,
    );
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1));
    const initialRequest = transport.requests[0]!;
    publishRawWindow(initialRequest, transport.windows.at(-1)!);
    await expect.element(screen.getByRole("gridcell", { name: "Desk 0000" })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Sort by Server price 000" }));
    await vi.waitFor(() => expect(transport.requests).toHaveLength(2));
    expect(transport.releases).toHaveBeenCalledTimes(1);
    expect(transport.requests[1]!.query).toMatchObject({
      orderBy: [{ field: "price", direction: "asc" }],
    });
    initialRequest.sink.setRowData(
      { 0: { ...rawRowAt(0), desk: "STALE SORT GENERATION" } },
      { 0: "stale-sort-generation" },
    );
    await settleBrunoTableBrowserFrames(2);
    await expect
      .element(screen.getByRole("gridcell", { name: "STALE SORT GENERATION" }))
      .not.toBeInTheDocument();
    const sortedRequest = transport.requests[1]!;
    publishRawWindow(sortedRequest, transport.windows.at(-1)!);
    await expect.element(screen.getByRole("gridcell", { name: "Desk 0000" })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Filter Server desk" }));
    await userEvent.fill(
      screen
        .getByRole("dialog", { name: "Filter Server desk" })
        .getByRole("textbox", { name: "Filter value for Server desk" }),
      "Desk 0042",
    );
    await vi.waitFor(() => expect(transport.requests).toHaveLength(3));
    expect(transport.releases).toHaveBeenCalledTimes(2);
    sortedRequest.sink.setRowData(
      { 0: { ...rawRowAt(0), desk: "STALE FILTER GENERATION" } },
      { 0: "stale-filter-generation" },
    );
    await settleBrunoTableBrowserFrames(2);
    await expect
      .element(screen.getByRole("gridcell", { name: "STALE FILTER GENERATION" }))
      .not.toBeInTheDocument();
    const filteredRequest = transport.requests[2]!;
    filteredRequest.sink.setRowCount(1, true);
    filteredRequest.sink.setRowData({ 0: rawRowAt(42) }, { 0: "row-0042" });
    await expect.element(screen.getByRole("gridcell", { name: "Desk 0042" })).toBeVisible();
    await userEvent.keyboard("{Escape}");

    const groupRegion = screen.getByRole("region", { name: "Group By" });
    await userEvent.click(groupRegion.getByRole("combobox", { name: "Add Group" }));
    await userEvent.click(screen.getByRole("option", { name: "Server desk", exact: true }));
    await vi.waitFor(() => expect(transport.requests).toHaveLength(4));
    expect(transport.releases).toHaveBeenCalledTimes(3);
    const groupedRequest = transport.requests[3]!;
    expect(groupedRequest.query).toMatchObject({ groupBy: ["desk"] });
    groupedRequest.sink.setRowCount(1, true);
    publishGroupedWindow(groupedRequest, { firstRow: 0, lastRow: 0 });
    await expect.element(screen.getByRole("gridcell", { name: "Desk 0000" })).toBeVisible();

    await userEvent.click(
      groupRegion.getByRole("button", { name: "Remove Server desk from Group By" }),
    );
    await vi.waitFor(() => expect(transport.requests).toHaveLength(5));
    expect(transport.releases).toHaveBeenCalledTimes(4);
    expect(transport.requests[4]!.query).not.toHaveProperty("groupBy");
    expect(transport.requests[4]!.query).toMatchObject({
      orderBy: [{ field: "price", direction: "asc" }],
    });
  });

  test("keeps sparse raw 5,000x150 pinned delivery and notifications bounded", async () => {
    expect(import.meta.env.MODE).toBe("production");
    expect(__BRUNO_TABLE_DEVELOPMENT__).toBe(false);
    expect(__BRUNO_TABLE_TEST_DIAGNOSTICS__).toBe(true);

    const transport = createSparseViewport();
    let pendingFrameWorkSample: RenderedFrameWorkSample | undefined;
    let schedulingFrameWorkSample: RenderedFrameWorkSample | undefined;
    let restoreFrameProbe: (() => void) | undefined;
    const screen = await render(
      <Profiler
        id="production-server-sparse-delivery"
        onRender={(_id, _phase, actualDuration, _baseDuration, startTime, commitTime) => {
          if (pendingFrameWorkSample !== undefined) {
            pendingFrameWorkSample.reactCommitCount += 1;
            pendingFrameWorkSample.reactDurationMs += captureBrunoTableReactCommitWork({
              actualDurationMs: actualDuration,
              commitTimeMs: commitTime,
              observedAtMs: performance.now(),
              startTimeMs: startTime,
            }).durationMs;
          }
        }}
      >
        <div style={{ height: 500, width: 1_200 }}>
          <BrunoTableServer
            tableId={TABLE_ID}
            columns={columns}
            initialOrderBy={[{ columnId: "COL_ID_PRODUCTION_SERVER_DESK", direction: "asc" }]}
            viewportSource={{
              viewport: transport.viewport,
              useWholeResult,
              completeRawSelect,
              totalRows: ROW_COUNT,
              version: 1,
              status: "ready",
            }}
          />
        </div>
      </Profiler>,
    );
    await expect.element(screen.getByRole("grid", { name: `Data for ${TABLE_ID}` })).toBeVisible();
    const grid = screen.getByRole("grid", { name: `Data for ${TABLE_ID}` }).element();
    expect.assert(grid instanceof HTMLElement);
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]!.query).not.toHaveProperty("groupBy");
    publishRawWindow(transport.requests[0]!, transport.windows.at(-1)!);
    await expect.element(screen.getByRole("gridcell", { name: "Desk 0000" })).toBeVisible();

    expect(grid.getAttribute("aria-rowcount")).toBe(String(ROW_COUNT + 1));
    expect(mountedBodyRows(grid).length).toBeGreaterThan(0);
    expect(mountedBodyRows(grid).length).toBeLessThanOrEqual(24);
    expect(mountedHeaders(grid).length).toBeGreaterThanOrEqual(3);
    expect(mountedHeaders(grid).length).toBeLessThanOrEqual(24);
    expect(grid.querySelector('[data-bruno-pinned-body-region="start"]')).not.toBeNull();
    expect(grid.querySelector('[data-bruno-pinned-body-region="end"]')).not.toBeNull();

    grid.scrollTop = TARGET_ROW_INDEX * FIXED_ROW_HEIGHT;
    grid.scrollLeft = 7_200;
    grid.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() =>
      expect(transport.windows.at(-1)?.lastRow).toBeGreaterThanOrEqual(TARGET_ROW_INDEX),
    );
    const rawTargetWindow = transport.windows.at(-1)!;
    publishRawWindow(transport.requests[0]!, rawTargetWindow);
    await expect
      .element(screen.getByRole("gridcell", { name: String(TARGET_ROW_INDEX) }).first())
      .toBeVisible();

    const viewRenders = vi.fn();
    const surfaceRenders = vi.fn();
    const headerRenders = vi.fn();
    const rowRenders = vi.fn();
    const cellRenders = vi.fn();
    const removeListeners = [
      installBrunoTableClientViewRenderListenerForTable(TABLE_ID, viewRenders),
      installBrunoTableClientGridSurfaceRenderListenerForTable(TABLE_ID, surfaceRenders),
      installBrunoTableClientHeaderRenderListenerForTable(TABLE_ID, headerRenders),
      installBrunoTableClientRowRenderListenerForTable(TABLE_ID, rowRenders),
      installBrunoTableClientCellRenderListenerForTable(TABLE_ID, cellRenders),
    ];
    const deliveryDurations: number[] = [];
    try {
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

      for (let sample = 0; sample < DELIVERY_SAMPLE_COUNT; sample += 1) {
        await nextAnimationFrameTimestamp();
        const frameWorkSample: RenderedFrameWorkSample = {
          callbackDurationMs: 0,
          reactCommitCount: 0,
          reactDurationMs: 0,
        };
        pendingFrameWorkSample = frameWorkSample;
        schedulingFrameWorkSample = frameWorkSample;
        const startedAt = performance.now();
        transport.requests[0]!.sink.setRowData(
          { [TARGET_ROW_INDEX]: rawRowAt(TARGET_ROW_INDEX, ROW_COUNT + sample) },
          { [TARGET_ROW_INDEX]: `row-${String(TARGET_ROW_INDEX).padStart(4, "0")}` },
        );
        const admissionDurationMs = performance.now() - startedAt;
        await nextAnimationFrameTimestamp();
        const renderedFrame = {
          callbackDurationMs: frameWorkSample.callbackDurationMs,
          reactDurationMs: frameWorkSample.reactDurationMs,
        };
        frameWorkSample.callbackDurationMs = 0;
        frameWorkSample.reactDurationMs = 0;
        await nextAnimationFrameTimestamp();
        schedulingFrameWorkSample = undefined;
        deliveryDurations.push(
          combineBrunoTableBenchmarkFrameWork({
            admissionDurationMs,
            renderedFrame,
            presentationFrame: {
              callbackDurationMs: frameWorkSample.callbackDurationMs,
              reactDurationMs: frameWorkSample.reactDurationMs,
            },
          }),
        );
        pendingFrameWorkSample = undefined;
        expect(frameWorkSample.reactCommitCount).toBeGreaterThan(0);
      }
    } finally {
      pendingFrameWorkSample = undefined;
      schedulingFrameWorkSample = undefined;
      restoreFrameProbe?.();
      for (const remove of removeListeners) remove();
    }
    const evidence = finalizeBrunoTableBenchmarkEvidence(deliveryDurations, {
      scenario: "server-sparse-raw-delivery-5k-rows-150-columns-pinned-two-axis",
      profile: "chromium-capable-hardware-v1",
      environment: getBrunoTableBenchmarkEnvironment(),
      warmupSampleCount: DELIVERY_WARMUP_SAMPLE_COUNT,
      measuredSampleCount: DELIVERY_MEASURED_SAMPLE_COUNT,
      budgetMs: 8.33,
      droppedFrameThresholdMs: 16.66,
      maxDroppedFrameCount: 0,
    });
    expect(evidence.summary.p99).toBeLessThanOrEqual(8.33);
    expect(evidence.droppedFrames.count).toBe(0);
    expect(viewRenders).not.toHaveBeenCalled();
    expect(surfaceRenders).not.toHaveBeenCalled();
    expect(headerRenders).not.toHaveBeenCalled();
    expect(rowRenders).not.toHaveBeenCalled();
    expect(cellRenders.mock.calls.length).toBeLessThanOrEqual(
      mountedHeaders(grid).length * DELIVERY_SAMPLE_COUNT,
    );
  });

  test("budgets sustained sparse Server scrolling through requests, loading, and delivery", async () => {
    const tableId = "TABLE_ID_PRODUCTION_SERVER_SCROLL";
    const transport = createSparseViewport();
    let activeSample: RenderedFrameWorkSample | undefined;
    const nativeFrame = window.requestAnimationFrame.bind(window);
    let restoreFrames: (() => void) | undefined;
    const durations: number[] = [];
    const enteredRows = new Set<string>();
    const enteredColumns = new Set<string>();
    let loadingFrames = 0;
    let renderingSamples = 0;
    const screen = await render(
      <Profiler
        id="server-scroll"
        onRender={(_id, _phase, actualDuration, _baseDuration, startTime, commitTime) => {
          if (activeSample === undefined) return;
          activeSample.reactCommitCount += 1;
          activeSample.reactDurationMs += captureBrunoTableReactCommitWork({
            actualDurationMs: actualDuration,
            commitTimeMs: commitTime,
            startTimeMs: startTime,
            observedAtMs: performance.now(),
          }).durationMs;
        }}
      >
        <div style={{ height: 500, width: 1_200 }}>
          <BrunoTableServer
            tableId={tableId}
            columns={columns}
            initialOrderBy={[{ columnId: "COL_ID_PRODUCTION_SERVER_DESK", direction: "asc" }]}
            viewportSource={{
              viewport: transport.viewport,
              useWholeResult,
              completeRawSelect,
              totalRows: ROW_COUNT,
              version: 1,
              status: "ready",
            }}
          />
        </div>
      </Profiler>,
    );
    await expect.element(screen.getByRole("grid", { name: `Data for ${tableId}` })).toBeVisible();
    const grid = screen.getByRole("grid", { name: `Data for ${tableId}` }).element();
    expect.assert(grid instanceof HTMLElement);
    expect(transport.requests).toHaveLength(1);
    const request = transport.requests[0]!;
    publishRawWindow(request, transport.windows.at(-1)!);
    await settleBrunoTableBrowserFrames(3);
    const initialWindowCount = transport.windows.length;
    let deliveredWindow = transport.windows.at(-1)!;
    const initialColumns = new Set(
      mountedHeaders(grid).map((header) => header.dataset["brunoColumnId"]),
    );
    const surfaceRenders = vi.fn();
    const removeSurfaceListener = installBrunoTableClientGridSurfaceRenderListenerForTable(
      tableId,
      surfaceRenders,
    );
    try {
      const probe = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) =>
        nativeFrame((timestamp) => {
          const sample = activeSample;
          const startedAt = performance.now();
          try {
            callback(timestamp);
          } finally {
            if (sample !== undefined) sample.callbackDurationMs += performance.now() - startedAt;
          }
        }),
      );
      restoreFrames = () => probe.mockRestore();
      for (let index = 0; index < DELIVERY_SAMPLE_COUNT; index += 1) {
        const sample: RenderedFrameWorkSample = {
          callbackDurationMs: 0,
          reactDurationMs: 0,
          reactCommitCount: 0,
        };
        activeSample = sample;
        const startedAt = performance.now();
        grid.scrollTop = (index + 1) * FIXED_ROW_HEIGHT;
        grid.scrollLeft = (index + 1) * 4;
        grid.dispatchEvent(new Event("scroll"));
        let admissionDurationMs = performance.now() - startedAt;
        await new Promise<number>((resolve) => nativeFrame(resolve));
        const renderedFrame = {
          callbackDurationMs: sample.callbackDurationMs,
          reactDurationMs: sample.reactDurationMs,
        };
        sample.callbackDurationMs = 0;
        sample.reactDurationMs = 0;
        if (grid.querySelector('[role="gridcell"][aria-label^="Loading "]') !== null)
          loadingFrames += 1;
        const window = transport.windows.at(-1)!;
        expect(window.lastRow).toBeGreaterThanOrEqual(index + 1);
        const deliveryStartedAt = performance.now();
        publishRawWindow(request, window, deliveredWindow);
        deliveredWindow = window;
        admissionDurationMs += performance.now() - deliveryStartedAt;
        await new Promise<number>((resolve) => nativeFrame(resolve));
        if (sample.reactCommitCount > 0) renderingSamples += 1;
        expect(transport.requests).toHaveLength(1);
        expect(transport.releases).not.toHaveBeenCalled();
        expect(mountedBodyRows(grid).length).toBeLessThanOrEqual(24);
        expect(mountedHeaders(grid).length).toBeLessThanOrEqual(24);
        expect(grid.querySelector('[data-bruno-pinned-body-region="start"]')).not.toBeNull();
        expect(grid.querySelector('[data-bruno-pinned-body-region="end"]')).not.toBeNull();
        const cells = grid.querySelectorAll<HTMLElement>(
          '[role="gridcell"][data-bruno-row-id][data-bruno-column-id]',
        );
        expect(cells.length).toBeLessThanOrEqual(576);
        for (const cell of cells) {
          const rowId = cell.dataset["brunoRowId"]!;
          const rowIndex = Number(rowId.slice("row-".length));
          expect(rowIndex).toBeGreaterThanOrEqual(window.firstRow);
          expect(rowIndex).toBeLessThanOrEqual(window.lastRow);
          enteredRows.add(rowId);
          const columnId = cell.dataset["brunoColumnId"]!;
          if (!initialColumns.has(columnId)) enteredColumns.add(columnId);
          expect(cell.textContent).toBe(
            columnId === "COL_ID_PRODUCTION_SERVER_DESK"
              ? `Desk ${String(rowIndex).padStart(4, "0")}`
              : String(rowIndex),
          );
        }
        // A resolved rAF resumes before paint. Admit the next scroll only after
        // a rendering opportunity, retaining attribution for any intervening work.
        await new Promise<number>((resolve) => nativeFrame(resolve));
        durations.push(
          combineBrunoTableBenchmarkFrameWork({
            admissionDurationMs,
            renderedFrame,
            presentationFrame: {
              callbackDurationMs: sample.callbackDurationMs,
              reactDurationMs: sample.reactDurationMs,
            },
          }),
        );
        activeSample = undefined;
      }
      expect(transport.windows.length - initialWindowCount).toBeGreaterThan(50);
      expect(loadingFrames).toBeGreaterThan(50);
      expect(renderingSamples).toBeGreaterThan(50);
      expect(enteredRows.size).toBeGreaterThan(100);
      expect(enteredColumns.size).toBeGreaterThan(0);
      expect(surfaceRenders).not.toHaveBeenCalled();
      const evidence = finalizeBrunoTableBenchmarkEvidence(durations, {
        scenario: "server-sustained-scroll-request-loading-delivery-5000x150-pinned",
        profile: "chromium-capable-hardware-v1",
        environment: getBrunoTableBenchmarkEnvironment(),
        warmupSampleCount: DELIVERY_WARMUP_SAMPLE_COUNT,
        measuredSampleCount: DELIVERY_MEASURED_SAMPLE_COUNT,
        budgetMs: 8.33,
        droppedFrameThresholdMs: 16.66,
        maxDroppedFrameCount: 2,
      });
      expect(evidence.summary.p99).toBeLessThanOrEqual(8.33);
    } finally {
      activeSample = undefined;
      restoreFrames?.();
      removeSurfaceListener();
    }
  });

  test("keeps a persisted sparse grouped 5,000x150 generation unpinned and bounded", async () => {
    expect(import.meta.env.MODE).toBe("production");
    expect(__BRUNO_TABLE_DEVELOPMENT__).toBe(false);
    expect(__BRUNO_TABLE_TEST_DIAGNOSTICS__).toBe(true);

    const transport = createSparseViewport();
    const firstAggregateColumnId = columns[1]!.columnId;
    const lastAggregateColumnId = columns[columns.length - 1]!.columnId;
    const screen = await render(
      <div style={{ height: 500, width: 1_200 }}>
        <BrunoTableServer
          tableId={GROUPED_TABLE_ID}
          columns={columns}
          initialOrderBy={[{ columnId: "COL_ID_PRODUCTION_SERVER_DESK", direction: "asc" }]}
          initialPersistedState={{
            version: 1,
            tableId: GROUPED_TABLE_ID,
            filters: [],
            orderBy: [{ columnId: "COL_ID_PRODUCTION_SERVER_DESK", direction: "asc" }],
            groupBy: ["COL_ID_PRODUCTION_SERVER_DESK"],
            groupOrderBy: [{ columnId: "COL_ID_PRODUCTION_SERVER_DESK", direction: "asc" }],
            columnOrder: columns.map((column) => column.columnId),
            columnVisibility: {},
            columnWidths: {},
            columnPinning: {
              start: [firstAggregateColumnId],
              end: [lastAggregateColumnId],
            },
          }}
          viewportSource={{
            viewport: transport.viewport,
            useWholeResult,
            completeRawSelect,
            totalRows: ROW_COUNT,
            version: 1,
            status: "ready",
          }}
        />
      </div>,
    );
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1));
    const groupedRequest = transport.requests[0]!;
    groupedRequest.sink.setRowCount(ROW_COUNT, true);
    publishGroupedWindow(groupedRequest, transport.windows.at(-1)!);
    await expect.element(screen.getByRole("gridcell", { name: "Desk 0000" })).toBeVisible();
    await settleBrunoTableBrowserFrames(2);
    const groupedGrid = screen
      .getByRole("grid", { name: `Data for ${GROUPED_TABLE_ID}` })
      .element();
    expect.assert(groupedGrid instanceof HTMLElement);

    groupedGrid.scrollTop = TARGET_ROW_INDEX * FIXED_ROW_HEIGHT;
    groupedGrid.scrollLeft = 7_200;
    groupedGrid.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() =>
      expect(transport.windows.at(-1)?.lastRow).toBeGreaterThanOrEqual(TARGET_ROW_INDEX),
    );
    const groupedTargetWindow = transport.windows.at(-1)!;
    publishGroupedWindow(groupedRequest, groupedTargetWindow);
    await expect
      .element(screen.getByRole("gridcell", { name: String(TARGET_ROW_INDEX) }).first())
      .toBeVisible();

    expect(groupedGrid.getAttribute("aria-rowcount")).toBe(String(ROW_COUNT + 1));
    expect(mountedBodyRows(groupedGrid).length).toBeGreaterThan(0);
    expect(mountedBodyRows(groupedGrid).length).toBeLessThanOrEqual(24);
    expect(mountedHeaders(groupedGrid).length).toBeGreaterThanOrEqual(3);
    expect(mountedHeaders(groupedGrid).length).toBeLessThanOrEqual(24);
    expect(
      mountedHeaders(groupedGrid).every(
        (header) => header.getAttribute("data-pinned-region") === null,
      ),
    ).toBe(true);
    expect(groupedGrid.querySelector("[data-bruno-pinned-body-region]")).toBeNull();
  });
});
