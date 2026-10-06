import { Profiler, useEffect, useState } from "react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { BrunoTableClient, BrunoTableToolbar } from "./index";
import type { BrunoTableColumnId, BrunoTableColumns } from "./index";
import {
  captureBrunoTableReactCommitWork,
  combineBrunoTableBenchmarkFrameWork,
  finalizeBrunoTableBenchmarkEvidence,
} from "./internal/benchmark-budget";
import {
  BRUNO_TABLE_CAPABLE_HARDWARE_SAMPLE_PROTOCOL,
  BRUNO_TABLE_PRESENTATION_CADENCE_PROFILE,
  getBrunoTableBenchmarkEnvironment,
} from "./internal/benchmark-profile";
import { settleBrunoTableBrowserFrames } from "./internal/browser-test-helpers";
import {
  installBrunoTableClientGridSurfaceRenderListenerForTable,
  installBrunoTableClientViewRenderListenerForTable,
} from "./internal/render-instrumentation";
import {
  installBrunoTableClientReconciliationListener,
  type BrunoTableClientReconciliationEvent,
} from "./internal/client-source-adapter";

type ProductionWorkloadRow = Readonly<{
  readonly id: string;
  readonly symbol: string;
  readonly sequence: number;
}>;

const ROW_COUNT = 5_000;
const COLUMN_COUNT = 150;
const FRAME_WARMUP_SAMPLE_COUNT = 12;
const FRAME_MEASURED_SAMPLE_COUNT = 100;
const FRAME_TOTAL_SAMPLE_COUNT = FRAME_WARMUP_SAMPLE_COUNT + FRAME_MEASURED_SAMPLE_COUNT;
const FRAME_HORIZONTAL_WARMUP_SCROLL_STEP = 72;
const MEASURED_VERTICAL_SCROLL_BOUNDARY = FRAME_WARMUP_SAMPLE_COUNT * 720 + 32;
const MEASURED_HORIZONTAL_SCROLL_BOUNDARY =
  FRAME_WARMUP_SAMPLE_COUNT * FRAME_HORIZONTAL_WARMUP_SCROLL_STEP + 32;
const MEASURED_SCROLL_START_OFFSET = -16;
const MEASURED_SCROLL_STEP = 4;
const LIVE_PUBLICATION_SAMPLE_COUNT =
  BRUNO_TABLE_CAPABLE_HARDWARE_SAMPLE_PROTOCOL.warmupSampleCount +
  BRUNO_TABLE_CAPABLE_HARDWARE_SAMPLE_PROTOCOL.measuredSampleCount;
const LIVE_PUBLICATION_INTERVAL_MS = 50;
const LIVE_PUBLICATION_SETTLING_MARGIN_MS = 5_000;
const LIVE_PUBLICATION_WAIT_TIMEOUT_MS =
  LIVE_PUBLICATION_SAMPLE_COUNT * LIVE_PUBLICATION_INTERVAL_MS +
  LIVE_PUBLICATION_SETTLING_MARGIN_MS;
const LIVE_PUBLICATION_TEST_TIMEOUT_MS =
  LIVE_PUBLICATION_WAIT_TIMEOUT_MS + LIVE_PUBLICATION_SETTLING_MARGIN_MS;
type RenderedFrameWorkSample = {
  callbackDurationMs: number;
  reactDurationMs: number;
};
const rows = Object.freeze(
  Array.from(
    { length: ROW_COUNT },
    (_unused, index): ProductionWorkloadRow =>
      Object.freeze({
        id: `row-${String(index).padStart(4, "0")}`,
        sequence: index,
        symbol: `SYMBOL-${String(index % 500).padStart(3, "0")}`,
      }),
  ),
);
const columns = [
  {
    columnId: "COL_ID_PRODUCTION_000",
    field: "sequence",
    headerName: "Production 000",
    valueType: "number",
    aggFunc: "max",
    width: 120,
    pinned: "start",
  },
  {
    columnId: "COL_ID_PRODUCTION_001",
    field: "symbol",
    headerName: "Production 001",
    valueType: "text",
    groupBy: true,
    width: 120,
  },
  ...Array.from({ length: COLUMN_COUNT - 2 }, (_unused, offset) => {
    const index = offset + 2;
    return {
      columnId: `COL_ID_PRODUCTION_${String(index).padStart(3, "0")}` as BrunoTableColumnId,
      field: "symbol" as const,
      headerName: `Production ${String(index).padStart(3, "0")}`,
      valueType: "text" as const,
      width: 120,
      ...(index === COLUMN_COUNT - 1 ? { pinned: "end" as const } : {}),
    };
  }),
] as const satisfies BrunoTableColumns<ProductionWorkloadRow>;

const nativeAnimationFrame = window.requestAnimationFrame.bind(window);

function nextAnimationFrameTimestamp(): Promise<number> {
  return new Promise((resolve) => nativeAnimationFrame(resolve));
}

afterEach(async () => {
  await cleanup();
});
describe("BrunoTable production-semantics performance Browser harness", () => {
  test("runs Compiler-enabled diagnostics with production branches over 5,000x150 pinned data", async () => {
    expect(import.meta.env.MODE).toBe("production");
    expect(__BRUNO_TABLE_DEVELOPMENT__).toBe(false);
    expect(__BRUNO_TABLE_TEST_DIAGNOSTICS__).toBe(true);

    const screen = await render(
      <div style={{ height: 360, width: 1_024 }}>
        <BrunoTableClient
          tableId="TABLE_ID_PRODUCTION_WORKLOAD"
          getRowId={(row: ProductionWorkloadRow) => row.id}
          columns={columns}
          initialFilters={[
            {
              columnId: "COL_ID_PRODUCTION_001",
              type: "contains",
              filter: "SYMBOL-",
            },
          ]}
          initialOrderBy={[{ columnId: "COL_ID_PRODUCTION_000", direction: "asc" }]}
          clientSource={{
            rows,
            totalRows: rows.length,
            version: 1,
            status: "ready",
          }}
        />
      </div>,
    );

    const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_PRODUCTION_WORKLOAD" });
    await expect.element(grid).toHaveAttribute("aria-rowcount", String(ROW_COUNT + 1));
    await expect
      .element(screen.getByRole("columnheader", { name: "Production 000" }))
      .toBeInTheDocument();
    await expect
      .element(screen.getByRole("columnheader", { name: "Production 149" }))
      .toBeInTheDocument();
    expect(screen.getByRole("columnheader").all().length).toBeLessThan(20);
    expect(screen.getByRole("gridcell").all().length).toBeLessThan(250);
  }, 30_000);

  test("keeps real filter, sort, and Group By commands coherent with pinned live publications", async () => {
    const tableId = "TABLE_ID_PRODUCTION_COMMAND_TRANSITIONS";
    const renderTable = (activeRows: readonly ProductionWorkloadRow[], version: number) => (
      <div style={{ height: 500, width: 1_024 }}>
        <BrunoTableClient
          tableId={tableId}
          getRowId={(row: ProductionWorkloadRow) => row.id}
          columns={columns}
          initialOrderBy={[{ columnId: "COL_ID_PRODUCTION_000", direction: "asc" }]}
          clientSource={{
            rows: activeRows,
            totalRows: activeRows.length,
            version,
            status: "ready",
          }}
        />
      </div>
    );
    const screen = await render(renderTable(rows, 1));
    const grid = screen.getByRole("grid", { name: `Data for ${tableId}` });
    await expect.element(grid).toBeVisible();
    const gridElement = grid.element();
    expect.assert(gridElement instanceof HTMLElement);
    expect(gridElement.querySelector('[data-bruno-pinned-body-region="start"]')).not.toBeNull();
    expect(gridElement.querySelector('[data-bruno-pinned-body-region="end"]')).not.toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Sort by Production 000" }));
    await expect.element(screen.getByRole("gridcell", { name: "4999" }).first()).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Filter Production 001" }));
    await userEvent.fill(
      screen
        .getByRole("dialog", { name: "Filter Production 001" })
        .getByRole("textbox", { name: "Filter value for Production 001" }),
      "SYMBOL-007",
    );
    await expect.element(grid).toHaveAttribute("aria-rowcount", "11");
    await userEvent.keyboard("{Escape}");
    await expect.element(screen.getByRole("gridcell", { name: "4507" }).first()).toBeVisible();

    const groupRegion = screen.getByRole("region", { name: "Group By" });
    await userEvent.click(groupRegion.getByRole("combobox", { name: "Add Group" }));
    await userEvent.click(screen.getByRole("option", { name: "Production 001", exact: true }));
    await expect.element(grid).toHaveAttribute("aria-rowcount", "2");
    await expect
      .element(screen.getByRole("gridcell", { name: "SYMBOL-007", exact: true }))
      .toBeVisible();
    await expect.element(screen.getByRole("gridcell", { name: "4507", exact: true })).toBeVisible();

    const changedRows = Object.freeze(
      rows.with(4_507, Object.freeze({ ...rows[4_507]!, symbol: "SYMBOL-999" })),
    );
    await screen.rerender(renderTable(changedRows, 2));
    await expect.element(screen.getByRole("gridcell", { name: "4007", exact: true })).toBeVisible();
    await expect
      .element(screen.getByRole("gridcell", { name: "4507", exact: true }))
      .not.toBeInTheDocument();

    await userEvent.click(
      groupRegion.getByRole("button", { name: "Remove Production 001 from Group By" }),
    );
    await expect.element(grid).toHaveAttribute("aria-rowcount", "10");
    await vi.waitFor(() =>
      expect(gridElement.querySelector('[data-bruno-pinned-body-region="start"]')).not.toBeNull(),
    );
    expect(gridElement.querySelector('[data-bruno-pinned-body-region="end"]')).not.toBeNull();
  }, 30_000);

  test(
    "keeps 20 Hz publications bounded and isolated with stable row references",
    async () => {
      const tableId = "TABLE_ID_PRODUCTION_20_HZ";
      const reconciliationEvents: BrunoTableClientReconciliationEvent[] = [];
      const viewRenders = vi.fn();
      const gridSurfaceRenders = vi.fn();
      const toolbarCommits = vi.fn();
      const cellRenderCounts = new Map<string, number>();
      type PublicationSample = {
        readonly index: number;
        admissionDurationMs: number;
        readonly rendered: RenderedFrameWorkSample;
        readonly presentation: RenderedFrameWorkSample;
        phase: "rendered" | "presentation";
        reactCommits: number;
        observedText?: string | null;
        complete: boolean;
      };
      const publicationSamples: PublicationSample[] = [];
      let activePublication: PublicationSample | undefined;
      let startPublications: (() => void) | undefined;
      let observedCell: Element | undefined;
      let overlappingPublications = 0;
      let unownedReactCommits = 0;
      let recordingPublications = false;
      const nativeRequestFrame = window.requestAnimationFrame.bind(window);
      let restoreFrameProbe: (() => void) | undefined;
      const removeReconciliation = installBrunoTableClientReconciliationListener((event) => {
        if (recordingPublications) reconciliationEvents.push(event);
      });
      const removeView = installBrunoTableClientViewRenderListenerForTable(tableId, viewRenders);
      const removeGrid = installBrunoTableClientGridSurfaceRenderListenerForTable(
        tableId,
        gridSurfaceRenders,
      );
      const instrumentedColumns = columns.map((column, index) =>
        index === 0
          ? {
              ...column,
              cellRenderer: ({ row }: { readonly row: ProductionWorkloadRow }) => {
                cellRenderCounts.set(row.id, (cellRenderCounts.get(row.id) ?? 0) + 1);
                return row.symbol;
              },
            }
          : column,
      ) as BrunoTableColumns<ProductionWorkloadRow>;
      function ToolbarProbe() {
        useEffect(() => {
          toolbarCommits();
        });
        return <button type="button">Stable production command</button>;
      }
      const unchangedRow = rows[0]!;
      let referenceViolations = 0;
      function SustainedPublicationHarness() {
        const [publication, setPublication] = useState(
          Object.freeze({ rows, version: 1 }) as Readonly<{
            readonly rows: readonly ProductionWorkloadRow[];
            readonly version: number;
          }>,
        );
        useEffect(() => {
          let nextPublication = 1;
          let timer: ReturnType<typeof setInterval> | undefined;
          startPublications = () => {
            recordingPublications = true;
            timer = setInterval(() => {
              const publicationIndex = nextPublication;
              if (activePublication !== undefined) overlappingPublications += 1;
              const sample: PublicationSample = {
                index: publicationIndex,
                admissionDurationMs: 0,
                rendered: { callbackDurationMs: 0, reactDurationMs: 0 },
                presentation: { callbackDurationMs: 0, reactDurationMs: 0 },
                phase: "rendered",
                reactCommits: 0,
                complete: false,
              };
              publicationSamples.push(sample);
              activePublication = sample;
              const admissionStartedAt = performance.now();
              setPublication((current) => {
                const nextRows = Object.freeze(
                  current.rows.with(
                    1,
                    Object.freeze({
                      ...current.rows[1]!,
                      symbol: `SYMBOL-LIVE-${String(publicationIndex).padStart(3, "0")}`,
                    }),
                  ),
                );
                if (current.rows[0] !== unchangedRow || nextRows[0] !== unchangedRow) {
                  referenceViolations += 1;
                }
                return Object.freeze({ rows: nextRows, version: current.version + 1 });
              });
              sample.admissionDurationMs = performance.now() - admissionStartedAt;
              // These observer callbacks are harness work, not grid callbacks. Keep
              // the source timer at 20 Hz regardless of how quickly rendering settles.
              nativeRequestFrame(() => {
                sample.phase = "presentation";
                nativeRequestFrame(() => {
                  sample.observedText = observedCell?.textContent ?? null;
                  sample.complete = true;
                  if (activePublication === sample) activePublication = undefined;
                });
              });
              if (nextPublication === LIVE_PUBLICATION_SAMPLE_COUNT) clearInterval(timer);
              nextPublication += 1;
            }, LIVE_PUBLICATION_INTERVAL_MS);
          };
          return () => {
            clearInterval(timer);
            startPublications = undefined;
          };
        }, []);
        return (
          <BrunoTableClient
            tableId={tableId}
            getRowId={(row: ProductionWorkloadRow) => row.id}
            columns={instrumentedColumns}
            initialOrderBy={[{ columnId: "COL_ID_PRODUCTION_000", direction: "asc" }]}
            clientSource={{
              rows: publication.rows,
              totalRows: publication.rows.length,
              version: publication.version,
              status: "ready",
            }}
          >
            <BrunoTableToolbar>
              <ToolbarProbe />
            </BrunoTableToolbar>
          </BrunoTableClient>
        );
      }

      try {
        const screen = await render(
          <Profiler
            id="production-live-publication"
            onRender={(_id, _phase, actualDuration, _baseDuration, startTime, commitTime) => {
              if (!recordingPublications) return;
              if (activePublication === undefined) {
                unownedReactCommits += 1;
                return;
              }
              activePublication.reactCommits += 1;
              activePublication[activePublication.phase].reactDurationMs +=
                captureBrunoTableReactCommitWork({
                  actualDurationMs: actualDuration,
                  commitTimeMs: commitTime,
                  observedAtMs: performance.now(),
                  startTimeMs: startTime,
                }).durationMs;
            }}
          >
            <SustainedPublicationHarness />
          </Profiler>,
        );
        await expect
          .element(screen.getByRole("button", { name: "Stable production command" }))
          .toBeInTheDocument();
        await settleBrunoTableBrowserFrames(2);
        observedCell =
          screen
            .getByRole("grid")
            .element()
            .querySelector(
              '[data-bruno-row-id="row-0001"][data-bruno-column-id="COL_ID_PRODUCTION_000"]',
            ) ?? undefined;
        expect(observedCell).toBeDefined();
        const initialViewRenders = viewRenders.mock.calls.length;
        const initialGridRenders = gridSurfaceRenders.mock.calls.length;
        const initialUnchangedCellRenders = cellRenderCounts.get(unchangedRow.id);
        const initialChangedCellRenders = cellRenderCounts.get(rows[1]!.id);
        reconciliationEvents.length = 0;
        const frameProbe = vi
          .spyOn(window, "requestAnimationFrame")
          .mockImplementation((callback) =>
            nativeRequestFrame((timestamp) => {
              const sample = activePublication;
              const phase = sample?.phase;
              const startedAt = performance.now();
              try {
                callback(timestamp);
              } finally {
                if (sample !== undefined && phase !== undefined) {
                  sample[phase].callbackDurationMs += performance.now() - startedAt;
                }
              }
            }),
          );
        restoreFrameProbe = () => frameProbe.mockRestore();
        expect(startPublications).toBeDefined();
        startPublications!();

        await vi.waitFor(
          () => {
            expect(reconciliationEvents).toHaveLength(LIVE_PUBLICATION_SAMPLE_COUNT);
            expect(publicationSamples).toHaveLength(LIVE_PUBLICATION_SAMPLE_COUNT);
            expect(publicationSamples.every((sample) => sample.complete)).toBe(true);
          },
          { timeout: LIVE_PUBLICATION_WAIT_TIMEOUT_MS },
        );
        expect(
          screen
            .getByRole("gridcell", {
              name: `SYMBOL-LIVE-${String(LIVE_PUBLICATION_SAMPLE_COUNT).padStart(3, "0")}`,
            })
            .all().length,
        ).toBeGreaterThan(0);
        expect(referenceViolations).toBe(0);
        expect(overlappingPublications).toBe(0);
        expect(unownedReactCommits).toBe(0);
        for (const sample of publicationSamples) {
          expect(sample.reactCommits).toBeGreaterThan(0);
          expect(sample.observedText).toBe(`SYMBOL-LIVE-${String(sample.index).padStart(3, "0")}`);
        }
        for (const event of reconciliationEvents) {
          expect(event).toMatchObject({
            changedRows: 1,
            identityPatches: 1,
            rebuiltIdentityIndex: false,
            rebuiltSourceSequence: false,
            residentRows: ROW_COUNT,
            resolvedRowIds: 1,
          });
        }
        const evidence = finalizeBrunoTableBenchmarkEvidence(
          publicationSamples.map((sample) =>
            combineBrunoTableBenchmarkFrameWork({
              admissionDurationMs: sample.admissionDurationMs,
              renderedFrame: sample.rendered,
              presentationFrame: sample.presentation,
            }),
          ),
          {
            budgetMs: 8.33,
            droppedFrameThresholdMs: 16.66,
            environment: getBrunoTableBenchmarkEnvironment(),
            maxDroppedFrameCount: 2,
            measuredSampleCount: BRUNO_TABLE_CAPABLE_HARDWARE_SAMPLE_PROTOCOL.measuredSampleCount,
            profile: "chromium-capable-hardware-v1",
            scenario: "client-live-publication-5000x150-20hz",
            warmupSampleCount: BRUNO_TABLE_CAPABLE_HARDWARE_SAMPLE_PROTOCOL.warmupSampleCount,
          },
        );
        expect(evidence.summary.sampleCount).toBe(
          BRUNO_TABLE_CAPABLE_HARDWARE_SAMPLE_PROTOCOL.measuredSampleCount,
        );
        expect(viewRenders).toHaveBeenCalledTimes(initialViewRenders);
        expect(gridSurfaceRenders).toHaveBeenCalledTimes(initialGridRenders);
        expect(toolbarCommits).toHaveBeenCalledOnce();
        expect(cellRenderCounts.get(unchangedRow.id)).toBe(initialUnchangedCellRenders);
        expect(cellRenderCounts.get(rows[1]!.id)).toBe(
          (initialChangedCellRenders ?? 0) + LIVE_PUBLICATION_SAMPLE_COUNT,
        );
      } finally {
        recordingPublications = false;
        restoreFrameProbe?.();
        removeGrid();
        removeView();
        removeReconciliation();
      }
    },
    LIVE_PUBLICATION_TEST_TIMEOUT_MS,
  );

  test("keeps custom-renderer window infrastructure grid-owned and mount churn bounded", async () => {
    const tableId = "TABLE_ID_PRODUCTION_CUSTOM_RENDERER";
    const NativeResizeObserver = globalThis.ResizeObserver;
    const observedTargets: Element[] = [];
    let observerAllocations = 0;
    class CountingResizeObserver implements ResizeObserver {
      private readonly delegate: ResizeObserver;

      public constructor(callback: ResizeObserverCallback) {
        observerAllocations += 1;
        this.delegate = new NativeResizeObserver(callback);
      }

      public readonly disconnect = (): void => this.delegate.disconnect();
      public readonly observe = (target: Element, options?: ResizeObserverOptions): void => {
        observedTargets.push(target);
        this.delegate.observe(target, options);
      };
      public readonly unobserve = (target: Element): void => this.delegate.unobserve(target);
    }
    vi.stubGlobal("ResizeObserver", CountingResizeObserver);
    const nativeListenerRegistrations = vi.spyOn(EventTarget.prototype, "addEventListener");
    const customRenderer = vi.fn(({ row }: { readonly row: ProductionWorkloadRow }) => row.symbol);
    let pendingFrameWorkSample: RenderedFrameWorkSample | undefined;
    let schedulingFrameWorkSample: RenderedFrameWorkSample | undefined;
    let restoreFrameProbe: (() => void) | undefined;
    const removeGridSurface = installBrunoTableClientGridSurfaceRenderListenerForTable(
      tableId,
      () => {},
    );
    const customColumns = columns.map((column, index) =>
      index === 0 ? { ...column, cellRenderer: customRenderer } : column,
    ) as BrunoTableColumns<ProductionWorkloadRow>;

    try {
      const screen = await render(
        <Profiler
          id="production-custom-renderer"
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
              getRowId={(row: ProductionWorkloadRow) => row.id}
              columns={customColumns}
              initialOrderBy={[{ columnId: "COL_ID_PRODUCTION_000", direction: "asc" }]}
              clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
            />
          </div>
        </Profiler>,
      );
      await expect
        .element(screen.getByRole("grid", { name: "Data for TABLE_ID_PRODUCTION_CUSTOM_RENDERER" }))
        .toBeVisible();
      const grid = screen
        .getByRole("grid", { name: "Data for TABLE_ID_PRODUCTION_CUSTOM_RENDERER" })
        .element();
      await settleBrunoTableBrowserFrames(2);
      const initialCustomRenders = customRenderer.mock.calls.length;
      const initialMountedRows = grid.querySelectorAll(
        'tbody[role="rowgroup"] > tr[role="row"]',
      ).length;
      expect(initialCustomRenders).toBeGreaterThan(0);
      expect(initialMountedRows).toBeLessThanOrEqual(32);
      expect(initialCustomRenders).toBeLessThanOrEqual(initialMountedRows * 2);

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

      const frameWorkDurations: number[] = [];
      const frameCadence: number[] = [];
      const measuredMountedRowWindows = new Set<string>();
      const measuredMountedColumnWindows = new Set<string>();
      let customRenderCountBeforeMeasuredPhase: number | undefined;
      for (let sample = 0; sample < FRAME_TOTAL_SAMPLE_COUNT; sample += 1) {
        await nextAnimationFrameTimestamp();
        const frameWorkSample: RenderedFrameWorkSample = {
          callbackDurationMs: 0,
          reactDurationMs: 0,
        };
        pendingFrameWorkSample = frameWorkSample;
        schedulingFrameWorkSample = frameWorkSample;
        const isWarmup = sample < FRAME_WARMUP_SAMPLE_COUNT;
        if (sample === FRAME_WARMUP_SAMPLE_COUNT) {
          customRenderCountBeforeMeasuredPhase = customRenderer.mock.calls.length;
        }
        const measuredSample = sample - FRAME_WARMUP_SAMPLE_COUNT;
        grid.scrollTop = isWarmup
          ? sample === FRAME_WARMUP_SAMPLE_COUNT - 1
            ? MEASURED_VERTICAL_SCROLL_BOUNDARY + MEASURED_SCROLL_START_OFFSET
            : (sample + 1) * 720
          : MEASURED_VERTICAL_SCROLL_BOUNDARY +
            MEASURED_SCROLL_START_OFFSET +
            measuredSample * MEASURED_SCROLL_STEP;
        grid.scrollLeft = isWarmup
          ? sample === FRAME_WARMUP_SAMPLE_COUNT - 1
            ? MEASURED_HORIZONTAL_SCROLL_BOUNDARY + MEASURED_SCROLL_START_OFFSET
            : (sample + 1) * FRAME_HORIZONTAL_WARMUP_SCROLL_STEP
          : MEASURED_HORIZONTAL_SCROLL_BOUNDARY +
            MEASURED_SCROLL_START_OFFSET +
            measuredSample * MEASURED_SCROLL_STEP;
        const startedAt = performance.now();
        grid.dispatchEvent(new Event("scroll"));
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
        frameCadence.push(presentationFrameTimestamp - renderedFrameTimestamp);
        if (!isWarmup) {
          measuredMountedRowWindows.add(
            [
              ...new Set(
                [...grid.querySelectorAll<HTMLElement>('[role="gridcell"][data-bruno-row-id]')].map(
                  (cell) => cell.dataset["brunoRowId"],
                ),
              ),
            ].join("|"),
          );
          measuredMountedColumnWindows.add(
            [...grid.querySelectorAll<HTMLElement>("thead th[data-bruno-column-id]")]
              .map((header) => header.dataset["brunoColumnId"])
              .join("|"),
          );
        }
      }
      await settleBrunoTableBrowserFrames(2);

      const workEvidence = finalizeBrunoTableBenchmarkEvidence(frameWorkDurations, {
        budgetMs: 8.33,
        droppedFrameThresholdMs: 16.66,
        environment: getBrunoTableBenchmarkEnvironment(),
        maxDroppedFrameCount: 2,
        measuredSampleCount: FRAME_MEASURED_SAMPLE_COUNT,
        profile: "chromium-capable-hardware-v1",
        scenario: "client-custom-renderer-input-through-render-work-5000x150-pinned",
        warmupSampleCount: FRAME_WARMUP_SAMPLE_COUNT,
      });
      const cadenceEvidence = finalizeBrunoTableBenchmarkEvidence(frameCadence, {
        budgetMs: 20,
        droppedFrameThresholdMs: 20,
        environment: getBrunoTableBenchmarkEnvironment(),
        maxDroppedFrameCount: 2,
        measuredSampleCount: FRAME_MEASURED_SAMPLE_COUNT,
        profile: BRUNO_TABLE_PRESENTATION_CADENCE_PROFILE,
        scenario: "client-custom-renderer-presentation-frame-cadence-5000x150-pinned",
        warmupSampleCount: FRAME_WARMUP_SAMPLE_COUNT,
      });
      expect(workEvidence.summary.sampleCount).toBe(FRAME_MEASURED_SAMPLE_COUNT);
      expect(cadenceEvidence.summary.sampleCount).toBe(FRAME_MEASURED_SAMPLE_COUNT);
      expect(measuredMountedRowWindows.size).toBeGreaterThan(5);
      expect(measuredMountedColumnWindows.size).toBeGreaterThan(2);
      if (customRenderCountBeforeMeasuredPhase === undefined) {
        throw new Error("The measured phase did not capture the custom renderer baseline.");
      }
      expect(customRenderer.mock.calls.length).toBeGreaterThan(
        customRenderCountBeforeMeasuredPhase,
      );

      const cellListenerRegistrations = nativeListenerRegistrations.mock.contexts.filter(
        (target) => target instanceof HTMLElement && target.matches('[role="gridcell"]'),
      );
      expect(cellListenerRegistrations).toHaveLength(0);
      expect(
        observedTargets.filter(
          (target) => target instanceof HTMLElement && target.matches('[role="gridcell"]'),
        ),
      ).toHaveLength(0);
      expect(observerAllocations).toBeLessThanOrEqual(2);
      const finalMountedRows = grid.querySelectorAll(
        'tbody[role="rowgroup"] > tr[role="row"]',
      ).length;
      expect(finalMountedRows).toBeLessThanOrEqual(32);
      expect(customRenderer.mock.calls.length).toBeLessThanOrEqual(
        (initialMountedRows + FRAME_TOTAL_SAMPLE_COUNT * finalMountedRows) * 2,
      );
      expect(grid.querySelectorAll("thead th[data-bruno-column-id]").length).toBeLessThanOrEqual(
        24,
      );
      console.info(
        JSON.stringify({
          benchmark: "BrunoTable production custom renderer evidence",
          evidence: [workEvidence, cadenceEvidence],
        }),
      );
    } finally {
      restoreFrameProbe?.();
      removeGridSurface();
      nativeListenerRegistrations.mockRestore();
      vi.unstubAllGlobals();
    }
  }, 60_000);
});
