import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { detectPlatform } from "@tanstack/react-hotkeys";

import { BrunoTableClient, BrunoTableToolbar } from "./index";
import type { BrunoTableColumnId, BrunoTableColumns } from "./index";
import {
  BRUNO_TABLE_LIVE_RIGHT_PADDING_CSS_VARIABLE,
  brunoTableColumnCssVariable,
} from "./internal/column-management";
import type { BrunoTableGridCommand } from "./internal/column-management";
import { installBrunoTableGridCommandListener } from "./internal/grid-command-instrumentation";
import { installBrunoTableColumnCommandSubscriptionListener } from "./internal/grid-subscription-instrumentation";
import {
  installBrunoTableClientColumnGestureFrameListener,
  installBrunoTableClientColumnGestureListener,
  installBrunoTableClientCellRenderListener,
  installBrunoTableClientGridSurfaceRenderListener,
  installBrunoTableClientColumnReorderFrameListener,
  installBrunoTableClientColumnPreviewStyleWriteListener,
  installBrunoTableClientColumnResizeFrameListener,
  installBrunoTableClientHeaderRenderListener,
  installBrunoTableClientRowOrderPlanningListener,
  installBrunoTableClientCellRenderListenerForTable,
  installBrunoTableClientGridSurfaceRenderListenerForTable,
  installBrunoTableClientRowOrderPlanningListenerForTable,
  installBrunoTableClientRowRenderListenerForTable,
  installBrunoTableClientViewRenderListener,
  installBrunoTableClientViewRenderListenerForTable,
} from "./internal/render-instrumentation";
import {
  BRUNO_TABLE_DEFAULT_VIEWPORT_HEIGHT,
  BRUNO_TABLE_ROW_HEIGHT,
} from "./internal/virtual-viewport";

type Row = Readonly<{
  id: string;
  name: string;
  score: number;
  status: string;
}>;

const columns = [
  {
    columnId: "COL_ID_NAME",
    field: "name",
    headerName: "Name",
    valueType: "text",
    width: 160,
  },
  {
    columnId: "COL_ID_SCORE",
    field: "score",
    headerName: "Score",
    valueType: "number",
    width: 96,
  },
  {
    columnId: "COL_ID_STATUS",
    field: "status",
    headerName: "Status",
    valueType: "text",
    width: 140,
  },
] as const;

const rows: readonly Row[] = [
  { id: "ada", name: "Ada", score: 4, status: "Ready" },
  { id: "grace", name: "Grace", score: 2, status: "Queued" },
];

const source = {
  rows,
  totalRows: rows.length,
  version: 1,
  status: "ready" as const,
};

const tableProps = {
  tableId: "TABLE_ID_COLUMN_MANAGEMENT",
  getRowId: (row: Row) => row.id,
  columns,
  initialOrderBy: [{ columnId: "COL_ID_SCORE", direction: "asc" }],
  clientSource: source,
} as const;

const manyColumns = [
  ...columns,
  {
    columnId: "COL_ID_EXTRA_1",
    field: "name",
    headerName: "Extra 1",
    valueType: "text",
    width: 160,
  },
  {
    columnId: "COL_ID_EXTRA_2",
    field: "name",
    headerName: "Extra 2",
    valueType: "text",
    width: 160,
  },
  {
    columnId: "COL_ID_EXTRA_3",
    field: "name",
    headerName: "Extra 3",
    valueType: "text",
    width: 160,
  },
  {
    columnId: "COL_ID_EXTRA_4",
    field: "name",
    headerName: "Extra 4",
    valueType: "text",
    width: 160,
  },
  {
    columnId: "COL_ID_EXTRA_5",
    field: "name",
    headerName: "Extra 5",
    valueType: "text",
    width: 160,
  },
] as const;

const revealColumns = [
  {
    ...columns[0],
    columnId: "COL_ID_REVEAL_START",
    headerName: "Reveal start",
    pinned: "start" as const,
    width: 120,
  },
  ...manyColumns,
  {
    ...columns[2],
    columnId: "COL_ID_REVEAL_END",
    headerName: "Reveal end",
    pinned: "end" as const,
    width: 120,
  },
] as const;

const interleavedColumns = [
  columns[0]!,
  { ...columns[2]!, pinned: "end" as const },
  { ...columns[1]!, pinned: "start" as const },
] as const;

const pinnedNameColumns = [
  { ...columns[0]!, pinned: "start" as const },
  columns[1]!,
  columns[2]!,
] as const;

const pinnedBoundaryColumns = [
  { ...columns[0]!, pinned: "start" as const },
  columns[1]!,
  { ...columns[2]!, pinned: "end" as const },
] as const;

const narrowAllPinnedColumns = [
  {
    ...columns[0],
    columnId: "COL_ID_NARROW_PIN_START_A",
    headerName: "Narrow pinned start A",
    pinned: "start" as const,
    width: 120,
  },
  {
    ...columns[1],
    columnId: "COL_ID_NARROW_PIN_START_B",
    headerName: "Narrow pinned start B",
    pinned: "start" as const,
    width: 120,
  },
  {
    ...columns[2],
    columnId: "COL_ID_NARROW_PIN_END",
    headerName: "Narrow pinned end",
    pinned: "end" as const,
    width: 120,
  },
] as const;

const fittingAllPinnedColumns = [
  {
    ...columns[0]!,
    columnId: "COL_ID_FITTING_PIN_START",
    headerName: "Fitting pinned start",
    pinned: "start" as const,
    width: 120,
  },
  {
    ...columns[2]!,
    columnId: "COL_ID_FITTING_PIN_END",
    headerName: "Fitting pinned end",
    pinned: "end" as const,
    width: 120,
  },
] as const;

const nameFilter = [{ columnId: "COL_ID_NAME", type: "equals", filter: "Ada" }] as const;
const filteredTableProps = { ...tableProps, initialFilters: nameFilter } as const;

const performanceColumns = [
  {
    ...columns[0],
    columnId: "COL_ID_PERF_PIN_START",
    headerName: "Pinned start",
    pinned: "start" as const,
    width: 96,
  },
  ...columns,
  ...Array.from({ length: 155 }, (_unused, index) => ({
    columnId: `COL_ID_PERF_${String(index + 1).padStart(3, "0")}` as BrunoTableColumnId,
    field: "name" as const,
    headerName: `Perf ${String(index + 1)}`,
    valueType: "text" as const,
    width: 120,
  })),
  {
    ...columns[2],
    columnId: "COL_ID_PERF_PIN_END",
    headerName: "Pinned end",
    pinned: "end" as const,
    width: 96,
  },
] as const;

const performanceRows: readonly Row[] = Array.from({ length: 100 }, (_unused, index) => ({
  id: `performance-${String(index)}`,
  name: `Row ${String(index)}`,
  score: index,
  status: index % 2 === 0 ? "Ready" : "Queued",
}));

const performanceSource = {
  rows: performanceRows,
  totalRows: performanceRows.length,
  version: 1,
  status: "ready" as const,
};

const wideFirstPreviewColumns = [
  {
    ...columns[0]!,
    columnId: "COL_ID_WIDE_FIRST_PREVIEW",
    headerName: "Wide first preview",
    width: 800,
  },
  ...Array.from({ length: 20 }, (_unused, index) => ({
    columnId: `COL_ID_WIDE_EXPOSED_${String(index)}` as BrunoTableColumnId,
    field: "name" as const,
    headerName: `Wide exposed ${String(index)}`,
    valueType: "text" as const,
    width: 100,
  })),
] as const;

const retainedFirstPreviewColumns = [
  {
    ...columns[0]!,
    columnId: "COL_ID_RETAINED_FIRST_PREVIEW",
    headerName: "Retained first preview",
    width: 100,
  },
  ...Array.from({ length: 20 }, (_unused, index) => ({
    columnId: `COL_ID_RETAINED_EXPOSED_${String(index)}` as BrunoTableColumnId,
    field: "name" as const,
    headerName: `Retained exposed ${String(index)}`,
    valueType: "text" as const,
    width: 100,
  })),
] as const;

type BrowserScreen = Awaited<ReturnType<typeof render>>;
type ColumnGestureFrameEvent =
  | Readonly<{
      readonly tableId: string;
      readonly phase: "scheduled" | "cancelled";
      readonly kind: "resize" | "reorder";
      readonly frameId: number;
    }>
  | Readonly<{
      readonly tableId: string;
      readonly phase: "ran";
      readonly kind: "resize" | "reorder";
      readonly frameId: number;
      readonly durationMs: number;
    }>
  | Readonly<{
      readonly tableId: string;
      readonly phase: "synchronous";
      readonly kind: "resize" | "reorder";
      readonly frameId?: never;
      readonly durationMs: number;
    }>;
type ColumnGestureListenerEvent = Readonly<{
  readonly tableId: string;
  readonly phase: "attach" | "detach";
  readonly event: "pointermove" | "pointerup" | "pointercancel";
}>;
type ColumnCommandSubscriptionEvent = Readonly<{
  readonly tableId: string;
  readonly columnId: string;
  readonly listenerCount: number;
}>;

function ColumnManagementToolbarProbe({ onRender }: { readonly onRender: () => void }) {
  onRender();
  return <button type="button">Toolbar probe</button>;
}

async function openColumnMenu(screen: BrowserScreen, columnName = "Name") {
  const grid = screen.getByRole("grid").element();
  const trigger = screen.getByRole("button", { name: `Column menu for ${columnName}` });
  const targetColumnId = columnName === "Name" ? "COL_ID_NAME" : "COL_ID_SCORE";
  grid.focus();
  await userEvent.keyboard(
    detectPlatform() === "mac" ? "{Meta>}{Home}{/Meta}" : "{Control>}{Home}{/Control}",
  );
  const targetIndex = columnOrder(grid).indexOf(targetColumnId);
  if (targetIndex < 0) throw new Error(`Column ${targetColumnId} is not mounted`);
  for (let index = 0; index < targetIndex; index += 1) {
    await userEvent.keyboard("{ArrowRight}");
  }
  await userEvent.keyboard("{Shift>}{F10}{/Shift}");
  await expect.element(screen.getByRole("menu")).toBeInTheDocument();
  return trigger;
}

type MenuItemRole = "menuitem" | "menuitemcheckbox" | "menuitemradio";

async function reachMenuItem(
  screen: BrowserScreen,
  role: MenuItemRole,
  name: string,
): Promise<void> {
  const item = screen.getByRole(role, { name, exact: true });
  for (let step = 0; step < 64; step += 1) {
    if (document.activeElement === item.element()) return;
    await userEvent.keyboard("{ArrowDown}");
  }
  throw new Error(`Keyboard navigation did not reach ${role} ${name}`);
}

async function openColumnSubmenu(screen: BrowserScreen, submenuName: string): Promise<void> {
  await reachMenuItem(screen, "menuitem", submenuName);
  await userEvent.keyboard("{ArrowRight}");
}

async function activateMenuItem(screen: BrowserScreen, name: string): Promise<void> {
  await reachMenuItem(screen, "menuitem", name);
  await userEvent.keyboard("{Enter}");
}

async function activateMenuRadio(screen: BrowserScreen, name: string): Promise<void> {
  await reachMenuItem(screen, "menuitemradio", name);
  await userEvent.keyboard("{Enter}");
}

async function activateMenuCheckbox(screen: BrowserScreen, name: string): Promise<void> {
  await reachMenuItem(screen, "menuitemcheckbox", name);
  await userEvent.keyboard("{Enter}");
}

async function waitForAnimationFrames(count = 2): Promise<void> {
  for (let frame = 0; frame < count; frame += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

async function closeColumnMenus(screen: BrowserScreen): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (screen.getByRole("menu").all().length === 0) break;
    await userEvent.keyboard("{Escape}");
  }
  await expect.element(screen.getByRole("menu", { includeHidden: true })).not.toBeInTheDocument();
}

function columnOrder(grid: Element): readonly string[] {
  return [...grid.querySelectorAll<HTMLElement>("th[data-bruno-column-id]")].map(
    (header) => header.dataset["brunoColumnId"] ?? "",
  );
}

type MountedColumnExpectation = Readonly<{
  readonly columnId: string;
  readonly columnIndex: number;
  readonly region: "start" | "center" | "end";
}>;

function mountedColumnExpectationsFromLogicalOrder(
  logicalColumnIds: readonly string[],
  pinnedStartIds: readonly string[] = [],
  pinnedEndIds: readonly string[] = [],
  mountedColumnIds: readonly string[] = logicalColumnIds,
): readonly MountedColumnExpectation[] {
  const pinnedStart = new Set(pinnedStartIds);
  const pinnedEnd = new Set(pinnedEndIds);
  return mountedColumnIds.map((columnId) => {
    const columnIndex = logicalColumnIds.indexOf(columnId);
    if (columnIndex < 0) throw new Error(`Unexpected mounted column ${columnId}`);
    return {
      columnId,
      columnIndex: columnIndex + 1,
      region: pinnedStart.has(columnId) ? "start" : pinnedEnd.has(columnId) ? "end" : "center",
    };
  });
}

function expectedMatrixLayout(matrixCase: ColumnManagementMatrixCase): Readonly<{
  readonly logicalColumnIds: readonly string[];
  readonly pinnedStartIds: readonly string[];
  readonly pinnedEndIds: readonly string[];
}> {
  const base = ["COL_ID_NAME", "COL_ID_SCORE", "COL_ID_STATUS"] as const;
  switch (matrixCase.action) {
    case "pin-start":
      return { logicalColumnIds: base, pinnedStartIds: ["COL_ID_NAME"], pinnedEndIds: [] };
    case "pin-end":
      return {
        logicalColumnIds: ["COL_ID_SCORE", "COL_ID_STATUS", "COL_ID_NAME"],
        pinnedStartIds: [],
        pinnedEndIds: ["COL_ID_NAME"],
      };
    case "hide-column":
      return {
        logicalColumnIds: ["COL_ID_NAME", "COL_ID_STATUS"],
        pinnedStartIds: [],
        pinnedEndIds: [],
      };
    case "move-start":
    case "move-end":
      return {
        logicalColumnIds: ["COL_ID_SCORE", "COL_ID_NAME", "COL_ID_STATUS"],
        pinnedStartIds: [],
        pinnedEndIds: [],
      };
    case "unpin":
    case "reset-order":
    case "reset-widths":
    case "reset-visibility":
    case "reset-pinning":
    case "reset-layout":
    case "sort":
    case "filter-clear":
    case "filter-reset":
    case "decrease-width":
    case "increase-width":
    case "show-column":
      return { logicalColumnIds: base, pinnedStartIds: [], pinnedEndIds: [] };
  }
}

function assertMountedColumnGeometry(
  grid: Element,
  expected: readonly MountedColumnExpectation[],
  mountedColumnIds?: readonly string[],
): void {
  const expectedById = new Map(expected.map((column) => [column.columnId, column]));
  const headers = [...grid.querySelectorAll<HTMLElement>("thead th[data-bruno-column-id]")];
  const headerIds = headers.map((header) => header.dataset["brunoColumnId"] ?? "");
  expect(new Set(headerIds).size).toBe(headerIds.length);
  if (mountedColumnIds !== undefined) expect(headerIds).toEqual(mountedColumnIds);
  const pinningIsMounted = headers.some(
    (header) =>
      header.dataset["pinnedRegion"] === "start" || header.dataset["pinnedRegion"] === "end",
  );
  const headerById = new Map(
    headers.map((header) => [header.dataset["brunoColumnId"] ?? "", header]),
  );
  for (const header of headers) {
    const columnId = header.dataset["brunoColumnId"] ?? "";
    const column = expectedById.get(columnId);
    expect(column).toBeDefined();
    expect(header).toHaveAttribute("aria-colindex", String(column?.columnIndex));
    expect(header.dataset["pinnedRegion"] ?? "center").toBe(
      pinningIsMounted ? column?.region : "center",
    );
    expect(header.getBoundingClientRect().width).toBeGreaterThan(0);
  }
  const cells = [
    ...grid.querySelectorAll<HTMLElement>('td[role="gridcell"][data-bruno-column-id]'),
  ];
  const cellIds = [...new Set(cells.map((cell) => cell.dataset["brunoColumnId"] ?? ""))];
  expect(new Set(cellIds)).toEqual(new Set(headerIds));
  for (const cell of cells) {
    const columnId = cell.dataset["brunoColumnId"] ?? "";
    const column = expectedById.get(columnId);
    const header = headerById.get(columnId);
    expect(column).toBeDefined();
    expect(header).not.toBeUndefined();
    expect(cell).toHaveAttribute("aria-colindex", String(column?.columnIndex));
    const bodyRegion =
      cell.closest<HTMLElement>("[data-bruno-pinned-body-region]")?.dataset[
        "brunoPinnedBodyRegion"
      ] ?? "center";
    expect(bodyRegion).toBe(pinningIsMounted ? column?.region : "center");
    const cellRect = cell.getBoundingClientRect();
    const headerRect = header?.getBoundingClientRect();
    expect(cellRect.width).toBeGreaterThan(0);
    expect(Math.abs(cellRect.width - (headerRect?.width ?? 0))).toBeLessThanOrEqual(1);
    expect(Math.abs(cellRect.left - (headerRect?.left ?? 0))).toBeLessThanOrEqual(1);
  }
}

function assertMountedColumnWindow(
  grid: Element,
  logicalColumnIds: readonly string[],
  options: Readonly<{
    readonly pinnedStartIds?: readonly string[];
    readonly pinnedEndIds?: readonly string[];
    readonly requiredColumnIds?: readonly string[];
    readonly maxMountedColumnCount?: number;
  }>,
): void {
  const headers = [...grid.querySelectorAll<HTMLElement>("thead th[data-bruno-column-id]")];
  const mountedColumnIds = headers.map((header) => header.dataset["brunoColumnId"] ?? "");
  const pinnedStartIds = options.pinnedStartIds ?? [];
  const pinnedEndIds = options.pinnedEndIds ?? [];
  const pinnedStart = new Set(pinnedStartIds);
  const pinnedEnd = new Set(pinnedEndIds);
  const logicalIds = new Set(logicalColumnIds);

  if (options.maxMountedColumnCount !== undefined) {
    expect(mountedColumnIds.length).toBeLessThanOrEqual(options.maxMountedColumnCount);
  }
  expect(mountedColumnIds.every((columnId) => logicalIds.has(columnId))).toBe(true);
  for (const columnId of options.requiredColumnIds ?? []) {
    expect(mountedColumnIds).toContain(columnId);
  }

  const mountedStartIds = headers
    .filter((header) => header.dataset["pinnedRegion"] === "start")
    .map((header) => header.dataset["brunoColumnId"] ?? "");
  const mountedEndIds = headers
    .filter((header) => header.dataset["pinnedRegion"] === "end")
    .map((header) => header.dataset["brunoColumnId"] ?? "");
  const pinningIsMounted = mountedStartIds.length > 0 || mountedEndIds.length > 0;
  if (pinningIsMounted) {
    expect(mountedStartIds).toEqual(pinnedStartIds);
    expect(mountedEndIds).toEqual(pinnedEndIds);
  } else {
    expect(mountedStartIds).toHaveLength(0);
    expect(mountedEndIds).toHaveLength(0);
  }

  const mountedCenterIds = headers
    .filter((header) => header.dataset["pinnedRegion"] === undefined)
    .map((header) => header.dataset["brunoColumnId"] ?? "");
  const centerLogicalIds = pinningIsMounted
    ? logicalColumnIds.filter((columnId) => !pinnedStart.has(columnId) && !pinnedEnd.has(columnId))
    : logicalColumnIds;
  const centerIndexes = mountedCenterIds.map((columnId) => centerLogicalIds.indexOf(columnId));
  expect(centerIndexes.every((index) => index >= 0)).toBe(true);
  expect(
    centerIndexes.every(
      (index, position) => position === 0 || index === centerIndexes[position - 1]! + 1,
    ),
  ).toBe(true);
}

function assertPinnedBoundaryGeometry(
  grid: Element,
  expectedWidths: Readonly<{
    readonly start: number;
    readonly center: number;
    readonly end: number;
  }>,
): void {
  const getColumnElements = (columnId: string): readonly [HTMLElement, HTMLElement] => {
    const header = grid.querySelector<HTMLElement>(`thead th[data-bruno-column-id="${columnId}"]`);
    const cell = grid.querySelector<HTMLElement>(
      `td[role="gridcell"][data-bruno-column-id="${columnId}"]`,
    );
    expect(header).not.toBeNull();
    expect(cell).not.toBeNull();
    return [header!, cell!];
  };
  const [startHeader, startCell] = getColumnElements("COL_ID_NAME");
  const [centerHeader, centerCell] = getColumnElements("COL_ID_SCORE");
  const [endHeader, endCell] = getColumnElements("COL_ID_STATUS");
  const startHeaderRect = startHeader.getBoundingClientRect();
  const centerHeaderRect = centerHeader.getBoundingClientRect();
  const endHeaderRect = endHeader.getBoundingClientRect();
  const gridRect = grid.getBoundingClientRect();

  expect(Math.abs(startHeaderRect.width - expectedWidths.start)).toBeLessThanOrEqual(1);
  expect(Math.abs(centerHeaderRect.width - expectedWidths.center)).toBeLessThanOrEqual(1);
  expect(Math.abs(endHeaderRect.width - expectedWidths.end)).toBeLessThanOrEqual(1);
  expect(Math.abs(startHeaderRect.left - gridRect.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(endHeaderRect.right - gridRect.right)).toBeLessThanOrEqual(1);
  expect(Math.abs(centerHeaderRect.left - startHeaderRect.right)).toBeLessThanOrEqual(1);
  expect(endHeaderRect.left).toBeGreaterThanOrEqual(centerHeaderRect.right - 1);

  const bodyRects = [
    [startCell, startHeaderRect, expectedWidths.start],
    [centerCell, centerHeaderRect, expectedWidths.center],
    [endCell, endHeaderRect, expectedWidths.end],
  ] as const;
  for (const [cell, headerRect, expectedWidth] of bodyRects) {
    const cellRect = cell.getBoundingClientRect();
    expect(Math.abs(cellRect.width - expectedWidth)).toBeLessThanOrEqual(1);
    expect(Math.abs(cellRect.width - headerRect.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(cellRect.left - headerRect.left)).toBeLessThanOrEqual(1);
  }
}

async function expectColumnMenuFocus(screen: BrowserScreen, columnName = "Name"): Promise<void> {
  const trigger = screen.getByRole("button", { name: `Column menu for ${columnName}` });
  await vi.waitFor(() => expect(document.activeElement).toBe(trigger.element()));
}

async function expectAnnouncement(screen: BrowserScreen, message: string): Promise<void> {
  await vi.waitFor(() => {
    const announcement = screen
      .getByRole("grid")
      .element()
      .querySelector<HTMLElement>('[aria-live="polite"]');
    expect(announcement).not.toBeNull();
    expect(announcement?.textContent).toBe(message);
  });
}

function expectTypedCommand(
  command: BrunoTableGridCommand | undefined,
  expected: BrunoTableGridCommand,
): void {
  expect(command).toBeDefined();
  expect(command).toEqual(expected);
  expect(command).not.toHaveProperty("table");
  expect(command).not.toHaveProperty("column");
  expect(command).not.toHaveProperty("columnDef");
}

type ColumnManagementMatrixCase = Readonly<{
  readonly name: string;
  readonly action:
    | "sort"
    | "filter-clear"
    | "filter-reset"
    | "decrease-width"
    | "increase-width"
    | "pin-start"
    | "pin-end"
    | "unpin"
    | "move-start"
    | "move-end"
    | "hide-column"
    | "show-column"
    | "reset-order"
    | "reset-widths"
    | "reset-visibility"
    | "reset-pinning"
    | "reset-layout";
  readonly targetColumn: "Name" | "Score";
  readonly filtered?: boolean;
  readonly pinnedName?: boolean;
  readonly setup?:
    | "clear-filter"
    | "move-name-end"
    | "resize-name"
    | "hide-score"
    | "pin-name"
    | "layout";
  readonly expectedCommand: BrunoTableGridCommand;
  readonly announcement: string;
}>;

const columnManagementMatrix: readonly ColumnManagementMatrixCase[] = [
  {
    name: "Sort by Name",
    action: "sort",
    targetColumn: "Name",
    expectedCommand: { type: "column.sort.toggle", columnId: "COL_ID_NAME", multi: false },
    announcement: "Name sorted ascending, priority 1",
  },
  {
    name: "Clear filter",
    action: "filter-clear",
    targetColumn: "Name",
    filtered: true,
    expectedCommand: { type: "column.filter.clear", columnId: "COL_ID_NAME" },
    announcement: "Name filter cleared",
  },
  {
    name: "Reset filter",
    action: "filter-reset",
    targetColumn: "Name",
    filtered: true,
    setup: "clear-filter",
    expectedCommand: { type: "column.filter.reset", columnId: "COL_ID_NAME" },
    announcement: "Name filter reset",
  },
  {
    name: "Decrease width",
    action: "decrease-width",
    targetColumn: "Name",
    expectedCommand: { type: "column.resize.commit", columnId: "COL_ID_NAME", width: 150 },
    announcement: "Name width 150 pixels",
  },
  {
    name: "Increase width",
    action: "increase-width",
    targetColumn: "Name",
    expectedCommand: { type: "column.resize.commit", columnId: "COL_ID_NAME", width: 170 },
    announcement: "Name width 170 pixels",
  },
  {
    name: "Pin to logical start",
    action: "pin-start",
    targetColumn: "Name",
    expectedCommand: { type: "column.pin.commit", columnId: "COL_ID_NAME", pinned: "start" },
    announcement: "Name pinned to logical start",
  },
  {
    name: "Pin to logical end",
    action: "pin-end",
    targetColumn: "Name",
    expectedCommand: { type: "column.pin.commit", columnId: "COL_ID_NAME", pinned: "end" },
    announcement: "Name pinned to logical end",
  },
  {
    name: "Unpin",
    action: "unpin",
    targetColumn: "Name",
    pinnedName: true,
    expectedCommand: { type: "column.pin.commit", columnId: "COL_ID_NAME", pinned: undefined },
    announcement: "Name unpinned",
  },
  {
    name: "Move toward logical start",
    action: "move-start",
    targetColumn: "Score",
    expectedCommand: {
      type: "column.reorder.commit",
      columnId: "COL_ID_SCORE",
      targetIndex: 0,
      pinned: undefined,
    },
    announcement: "Score position 1 of 3",
  },
  {
    name: "Move toward logical end",
    action: "move-end",
    targetColumn: "Name",
    expectedCommand: {
      type: "column.reorder.commit",
      columnId: "COL_ID_NAME",
      targetIndex: 1,
      pinned: undefined,
    },
    announcement: "Name position 2 of 3",
  },
  {
    name: "Hide Score",
    action: "hide-column",
    targetColumn: "Name",
    expectedCommand: { type: "column.visibility.commit", columnId: "COL_ID_SCORE", visible: false },
    announcement: "Score hidden",
  },
  {
    name: "Show Score",
    action: "show-column",
    targetColumn: "Name",
    setup: "hide-score",
    expectedCommand: { type: "column.visibility.commit", columnId: "COL_ID_SCORE", visible: true },
    announcement: "Score shown",
  },
  {
    name: "Reset order",
    action: "reset-order",
    targetColumn: "Name",
    setup: "move-name-end",
    expectedCommand: { type: "column.reset.order" },
    announcement: "Column order reset",
  },
  {
    name: "Reset widths",
    action: "reset-widths",
    targetColumn: "Name",
    setup: "resize-name",
    expectedCommand: { type: "column.reset.widths" },
    announcement: "Column widths reset",
  },
  {
    name: "Reset visibility",
    action: "reset-visibility",
    targetColumn: "Name",
    setup: "hide-score",
    expectedCommand: { type: "column.reset.visibility" },
    announcement: "Column visibility reset",
  },
  {
    name: "Reset pinning",
    action: "reset-pinning",
    targetColumn: "Name",
    setup: "pin-name",
    expectedCommand: { type: "column.reset.pinning" },
    announcement: "Column pinning reset",
  },
  {
    name: "Reset complete layout",
    action: "reset-layout",
    targetColumn: "Name",
    setup: "layout",
    expectedCommand: { type: "column.reset.layout" },
    announcement: "Complete column layout reset",
  },
];

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

describe("BrunoTable column management browser surface", () => {
  test("does not reclaim focus after the user leaves a closing column menu", async () => {
    const screen = await render(
      <>
        <button type="button">Next action</button>
        <BrunoTableClient {...tableProps} />
      </>,
    );
    await openColumnMenu(screen);
    const menu = screen.getByRole("menu").element();
    menu.style.animationDuration = "400ms";
    await userEvent.keyboard("{Escape}");
    const nextAction = screen.getByRole("button", { name: "Next action" });
    nextAction.element().focus();
    await expect.element(nextAction).toHaveFocus();
    await vi.waitFor(() => expect(menu.isConnected).toBe(false));
    await expect.element(nextAction).toHaveFocus();
  });

  test("counts header commits when its column menu opens and closes", async () => {
    const headerRenders = vi.fn();
    const removeHeader = installBrunoTableClientHeaderRenderListener(headerRenders);
    try {
      const screen = await render(<BrunoTableClient {...tableProps} />);
      headerRenders.mockClear();
      await screen.getByRole("button", { name: "Column menu for Name" }).click();
      await expect.element(screen.getByRole("menu")).toBeVisible();
      expect(headerRenders).toHaveBeenCalled();
      headerRenders.mockClear();
      await userEvent.keyboard("{Escape}");
      await expect.element(screen.getByRole("menu")).not.toBeInTheDocument();
      expect(headerRenders).toHaveBeenCalled();
    } finally {
      removeHeader();
    }
  });

  test.each(columnManagementMatrix)(
    "keyboard reaches and dispatches the $name column-menu command",
    async (matrixCase) => {
      const tableId = `TABLE_ID_COLUMN_MANAGEMENT_MATRIX_${matrixCase.action}`;
      const commands: BrunoTableGridCommand[] = [];
      const viewRenders = vi.fn();
      const gridSurfaceRenders = vi.fn();
      const headerRenders = vi.fn();
      const cellRenders = vi.fn();
      const rowOrderPlans = vi.fn();
      const removeCommand = installBrunoTableGridCommandListener(tableId, (command) => {
        commands.push(command);
      });
      const removeView = installBrunoTableClientViewRenderListener(viewRenders);
      const removeGridSurface =
        installBrunoTableClientGridSurfaceRenderListener(gridSurfaceRenders);
      const removeHeader = installBrunoTableClientHeaderRenderListener(headerRenders);
      const removeCells = installBrunoTableClientCellRenderListener(cellRenders);
      const removeRowOrderPlans = installBrunoTableClientRowOrderPlanningListener(rowOrderPlans);

      try {
        const screen = await render(
          <BrunoTableClient<Row, typeof columns>
            {...(matrixCase.filtered ? filteredTableProps : tableProps)}
            columns={matrixCase.pinnedName ? pinnedNameColumns : columns}
            tableId={tableId}
          />,
        );

        if (matrixCase.setup === "clear-filter") {
          await openColumnMenu(screen);
          await activateMenuItem(screen, "Clear filter");
          await expect
            .element(screen.getByRole("gridcell", { name: "Grace", exact: true }))
            .toBeInTheDocument();
        } else if (matrixCase.setup === "move-name-end") {
          await openColumnMenu(screen);
          await openColumnSubmenu(screen, "Move");
          await activateMenuItem(screen, "Move toward logical end");
          await vi.waitFor(() =>
            expect(columnOrder(screen.getByRole("grid").element())).toEqual([
              "COL_ID_SCORE",
              "COL_ID_NAME",
              "COL_ID_STATUS",
            ]),
          );
        } else if (matrixCase.setup === "resize-name") {
          const resizeHandle = screen.getByRole("separator", { name: "Resize Name" });
          resizeHandle.element().focus();
          await userEvent.keyboard("{ArrowRight}");
          await expect.element(resizeHandle).toHaveAttribute("aria-valuenow", "170");
        } else if (matrixCase.setup === "layout") {
          const resizeHandle = screen.getByRole("separator", { name: "Resize Name" });
          resizeHandle.element().focus();
          await userEvent.keyboard("{ArrowRight}");
          await expect.element(resizeHandle).toHaveAttribute("aria-valuenow", "170");
          await openColumnMenu(screen);
          await activateMenuRadio(screen, "Pin to logical start");
          await openColumnMenu(screen);
          await openColumnSubmenu(screen, "Visibility");
          await activateMenuCheckbox(screen, "Score");
          await expect.element(screen.getByRole("grid")).toHaveAttribute("aria-colcount", "2");
          await closeColumnMenus(screen);
        } else if (matrixCase.setup === "hide-score") {
          await openColumnMenu(screen);
          await openColumnSubmenu(screen, "Visibility");
          await activateMenuCheckbox(screen, "Score");
          await expect.element(screen.getByRole("grid")).toHaveAttribute("aria-colcount", "2");
          await closeColumnMenus(screen);
        } else if (matrixCase.setup === "pin-name") {
          await openColumnMenu(screen);
          await activateMenuRadio(screen, "Pin to logical start");
          await expect
            .element(screen.getByRole("columnheader", { name: /Name, width 160 pixels/u }))
            .toHaveAttribute("data-pinned-region", "start");
        }

        // Finish fixture setup, including the menu's exit and viewport commit,
        // before charging the next complete command to its render bounds.
        await closeColumnMenus(screen);
        await waitForAnimationFrames();
        commands.splice(0);
        viewRenders.mockClear();
        gridSurfaceRenders.mockClear();
        headerRenders.mockClear();
        cellRenders.mockClear();
        rowOrderPlans.mockClear();

        await openColumnMenu(screen, matrixCase.targetColumn);
        switch (matrixCase.action) {
          case "sort":
            await activateMenuItem(screen, "Sort by Name");
            break;
          case "filter-clear":
          case "filter-reset":
            await activateMenuItem(
              screen,
              matrixCase.action === "filter-clear" ? "Clear filter" : "Reset filter",
            );
            break;
          case "decrease-width":
            await activateMenuItem(screen, "Decrease width");
            break;
          case "increase-width":
            await activateMenuItem(screen, "Increase width");
            break;
          case "pin-start":
            await activateMenuRadio(screen, "Pin to logical start");
            break;
          case "pin-end":
            await activateMenuRadio(screen, "Pin to logical end");
            break;
          case "unpin":
            await activateMenuRadio(screen, "Unpin");
            break;
          case "move-start":
            await openColumnSubmenu(screen, "Move");
            await activateMenuItem(screen, "Move toward logical start");
            break;
          case "move-end":
            await openColumnSubmenu(screen, "Move");
            await activateMenuItem(screen, "Move toward logical end");
            break;
          case "hide-column":
          case "show-column":
            await openColumnSubmenu(screen, "Visibility");
            await activateMenuCheckbox(screen, "Score");
            await closeColumnMenus(screen);
            break;
          case "reset-order":
          case "reset-widths":
          case "reset-visibility":
          case "reset-pinning":
          case "reset-layout":
            await openColumnSubmenu(screen, "Reset");
            await activateMenuItem(
              screen,
              {
                "reset-order": "Reset order",
                "reset-widths": "Reset widths",
                "reset-visibility": "Reset visibility",
                "reset-pinning": "Reset pinning",
                "reset-layout": "Reset complete layout",
              }[matrixCase.action],
            );
            break;
        }

        await vi.waitFor(() => expect(commands).toHaveLength(1));
        expectTypedCommand(commands[0], matrixCase.expectedCommand);
        await expectAnnouncement(screen, matrixCase.announcement);
        await expectColumnMenuFocus(screen, matrixCase.targetColumn);

        const grid = screen.getByRole("grid").element();
        switch (matrixCase.action) {
          case "sort":
            await expect
              .element(screen.getByRole("columnheader", { name: /Name/u }))
              .toHaveAttribute("aria-sort", "ascending");
            break;
          case "filter-clear":
            await expect
              .element(screen.getByRole("gridcell", { name: "Grace", exact: true }))
              .toBeInTheDocument();
            break;
          case "filter-reset":
            await expect
              .element(screen.getByRole("gridcell", { name: "Grace", exact: true }))
              .not.toBeInTheDocument();
            break;
          case "decrease-width":
            await expect
              .element(screen.getByRole("separator", { name: "Resize Name" }))
              .toHaveAttribute("aria-valuenow", "150");
            break;
          case "increase-width":
            await expect
              .element(screen.getByRole("separator", { name: "Resize Name" }))
              .toHaveAttribute("aria-valuenow", "170");
            break;
          case "pin-start":
          case "pin-end":
            await expect
              .element(screen.getByRole("columnheader", { name: /Name, width 160 pixels/u }))
              .toHaveAttribute(
                "data-pinned-region",
                matrixCase.action === "pin-start" ? "start" : "end",
              );
            break;
          case "unpin":
          case "reset-pinning":
            await expect
              .element(screen.getByRole("columnheader", { name: /Name, width 160 pixels/u }))
              .not.toHaveAttribute("data-pinned-region", "start");
            break;
          case "move-start":
            expect(columnOrder(grid)).toEqual(["COL_ID_SCORE", "COL_ID_NAME", "COL_ID_STATUS"]);
            break;
          case "move-end":
          case "reset-order":
            expect(columnOrder(grid)).toEqual(
              matrixCase.action === "move-end"
                ? ["COL_ID_SCORE", "COL_ID_NAME", "COL_ID_STATUS"]
                : ["COL_ID_NAME", "COL_ID_SCORE", "COL_ID_STATUS"],
            );
            break;
          case "hide-column":
            await expect.element(grid).toHaveAttribute("aria-colcount", "2");
            break;
          case "show-column":
          case "reset-visibility":
            await expect.element(grid).toHaveAttribute("aria-colcount", "3");
            break;
          case "reset-widths":
            await expect
              .element(screen.getByRole("separator", { name: "Resize Name" }))
              .toHaveAttribute("aria-valuenow", "160");
            break;
          case "reset-layout":
            expect(columnOrder(grid)).toEqual(["COL_ID_NAME", "COL_ID_SCORE", "COL_ID_STATUS"]);
            await expect.element(grid).toHaveAttribute("aria-colcount", "3");
            await expect
              .element(screen.getByRole("separator", { name: "Resize Name" }))
              .toHaveAttribute("aria-valuenow", "160");
            await expect
              .element(screen.getByRole("columnheader", { name: /Name, width 160 pixels/u }))
              .not.toHaveAttribute("data-pinned-region", "start");
            break;
        }
        const expectedMatrix = expectedMatrixLayout(matrixCase);
        assertMountedColumnGeometry(
          grid,
          mountedColumnExpectationsFromLogicalOrder(
            expectedMatrix.logicalColumnIds,
            expectedMatrix.pinnedStartIds,
            expectedMatrix.pinnedEndIds,
          ),
        );

        await closeColumnMenus(screen);
        // Bound the complete command separately from the verification-only reopening below.
        expect(headerRenders.mock.calls.length).toBeLessThanOrEqual(4);
        const headerCommitsBeforeVerification = headerRenders.mock.calls.length;
        if (
          matrixCase.action === "pin-start" ||
          matrixCase.action === "pin-end" ||
          matrixCase.action === "unpin"
        ) {
          await openColumnMenu(screen, matrixCase.targetColumn);
          const radio = screen.getByRole("menuitemradio", {
            name:
              matrixCase.action === "pin-start"
                ? "Pin to logical start"
                : matrixCase.action === "pin-end"
                  ? "Pin to logical end"
                  : "Unpin",
          });
          await expect.element(radio).toHaveAttribute("aria-checked", "true");
          await userEvent.keyboard("{Escape}");
        }
        if (matrixCase.action === "hide-column" || matrixCase.action === "show-column") {
          await openColumnMenu(screen);
          await openColumnSubmenu(screen, "Visibility");
          await expect
            .element(screen.getByRole("menuitemcheckbox", { name: "Score" }))
            .toHaveAttribute(
              "aria-checked",
              matrixCase.action === "hide-column" ? "false" : "true",
            );
          await userEvent.keyboard("{Escape}");
        }

        await closeColumnMenus(screen);
        expect(
          headerRenders.mock.calls.length - headerCommitsBeforeVerification,
        ).toBeLessThanOrEqual(3);
        expect(viewRenders.mock.calls.length).toBeLessThanOrEqual(3);
        expect(gridSurfaceRenders.mock.calls.length).toBeLessThanOrEqual(3);
        expect(rowOrderPlans.mock.calls.length).toBeLessThanOrEqual(2);
        expect(cellRenders.mock.calls.length).toBeLessThanOrEqual(rows.length * columns.length * 2);
      } finally {
        removeCommand();
        removeView();
        removeGridSurface();
        removeHeader();
        removeCells();
        removeRowOrderPlans();
      }
    },
  );

  test("exposes semantic disabled cues for width and movement boundaries", async () => {
    const screen = await render(<BrunoTableClient<Row, typeof columns> {...tableProps} />);

    await openColumnMenu(screen);
    await expect
      .element(screen.getByRole("menuitem", { name: "Decrease width" }))
      .not.toHaveAttribute("aria-disabled", "true");
    await expect
      .element(screen.getByRole("menuitem", { name: "Increase width" }))
      .not.toHaveAttribute("aria-disabled", "true");
    await openColumnSubmenu(screen, "Move");
    await expect
      .element(screen.getByRole("menuitem", { name: "Move toward logical start" }))
      .toHaveAttribute("aria-disabled", "true");
    await expect
      .element(screen.getByRole("menuitem", { name: "Move toward logical end" }))
      .not.toHaveAttribute("aria-disabled", "true");
    await closeColumnMenus(screen);

    const resizeHandle = screen.getByRole("separator", { name: "Resize Name" });
    resizeHandle.element().focus();
    await userEvent.keyboard("{Home}");
    await openColumnMenu(screen);
    await expect
      .element(screen.getByRole("menuitem", { name: "Decrease width" }))
      .toHaveAttribute("aria-disabled", "true");
    await expect
      .element(screen.getByRole("menuitem", { name: "Increase width" }))
      .not.toHaveAttribute("aria-disabled", "true");
  });

  test("exposes the current sort direction and priority in the menu", async () => {
    const screen = await render(<BrunoTableClient<Row, typeof columns> {...tableProps} />);

    await openColumnMenu(screen, "Score");
    await expect
      .element(
        screen.getByRole("menuitem", {
          name: "Sort by Score, currently ascending, priority 1",
        }),
      )
      .toBeInTheDocument();
  });

  test("announces direct header sort and filter commands for pointer and keyboard users", async () => {
    const commands: BrunoTableGridCommand[] = [];
    const removeCommand = installBrunoTableGridCommandListener(
      "TABLE_ID_COLUMN_MANAGEMENT_DIRECT_COMMANDS",
      (command) => {
        commands.push(command);
      },
    );

    try {
      const screen = await render(
        <BrunoTableClient<Row, typeof columns>
          {...filteredTableProps}
          tableId="TABLE_ID_COLUMN_MANAGEMENT_DIRECT_COMMANDS"
        />,
      );
      const grid = screen.getByRole("grid").element();
      const sortButton = screen.getByRole("button", { name: "Sort by Name" });
      await userEvent.click(sortButton);
      expect(commands[0]).toEqual({
        type: "column.sort.toggle",
        columnId: "COL_ID_NAME",
        multi: false,
      });
      await expectAnnouncement(screen, "Name sorted ascending, priority 1");
      expect(document.activeElement).toBe(grid);

      const filterButton = screen.getByRole("button", { name: "Clear filter for Name" });
      filterButton.element().focus();
      await userEvent.keyboard("{Enter}");
      expect(commands[1]).toEqual({
        type: "column.filter.clear",
        columnId: "COL_ID_NAME",
      });
      await expect
        .element(screen.getByRole("gridcell", { name: "Grace", exact: true }))
        .toBeInTheDocument();
      await expectAnnouncement(screen, "Name filter cleared");
      await vi.waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByRole("button", { name: "Reset filter for Name" }).element(),
        ),
      );
    } finally {
      removeCommand();
    }
  });

  test("moves focus to the filter trigger when Clear removes its own header control", async () => {
    const screen = await render(<BrunoTableClient<Row, typeof columns> {...tableProps} />);
    await userEvent.click(screen.getByRole("button", { name: "Filter Name" }));
    await userEvent.fill(
      screen
        .getByRole("dialog", { name: "Filter Name" })
        .getByRole("textbox", { name: "Filter value for Name" }),
      "Ada",
    );
    await expect
      .element(screen.getByRole("gridcell", { name: "Grace", exact: true }))
      .not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    const clear = screen.getByRole("button", { name: "Clear filter for Name" });
    clear.element().focus();
    await userEvent.keyboard("{Enter}");

    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Filter Name" }).element(),
      ),
    );
  });

  test("preserves the typed multi-sort command payload", async () => {
    const commands: BrunoTableGridCommand[] = [];
    const tableId = "TABLE_ID_COLUMN_MANAGEMENT_MULTI_SORT";
    const removeCommand = installBrunoTableGridCommandListener(tableId, (command) => {
      commands.push(command);
    });

    try {
      const screen = await render(
        <BrunoTableClient<Row, typeof columns> {...tableProps} tableId={tableId} />,
      );
      await userEvent.click(screen.getByRole("button", { name: "Sort by Name" }), {
        modifiers: ["Shift"],
      });
      await vi.waitFor(() => expect(commands).toHaveLength(1));
      expectTypedCommand(commands[0], {
        type: "column.sort.toggle",
        columnId: "COL_ID_NAME",
        multi: true,
      });
    } finally {
      removeCommand();
    }
  });

  test("opens the column menu from the trigger keyboard shortcut", async () => {
    const screen = await render(<BrunoTableClient<Row, typeof columns> {...tableProps} />);
    const trigger = screen.getByRole("button", { name: "Column menu for Name" });
    await expect.element(trigger).toHaveAttribute("aria-keyshortcuts", "Shift+F10 ContextMenu");
    await expect.element(trigger).toHaveAttribute("data-bruno-column-menu-trigger", "COL_ID_NAME");
    trigger.element().focus();
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    await expect.element(screen.getByRole("menu")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger.element()));
  });

  test("exposes the visible column menu trigger and named popup relationship", async () => {
    const screen = await render(<BrunoTableClient<Row, typeof columns> {...tableProps} />);
    const trigger = screen.getByRole("button", { name: "Column menu for Name" });
    await expect.element(trigger).toHaveAttribute("aria-haspopup", "menu");
    await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(trigger);
    const menu = screen.getByRole("menu", { name: "Column menu for Name", exact: true });
    await expect.element(menu).toBeInTheDocument();
    await expect.element(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger.element().getAttribute("aria-controls")).toBe(menu.element().id);
    await userEvent.keyboard("{Escape}");
    await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
    const otherTrigger = screen.getByRole("button", { name: "Column menu for Score" });
    await userEvent.click(otherTrigger);
    const otherMenu = screen.getByRole("menu", { name: "Column menu for Score", exact: true });
    await expect.element(otherMenu).toBeInTheDocument();
    await expect.element(otherTrigger).toHaveAttribute("aria-expanded", "true");
    await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
    expect(otherTrigger.element().getAttribute("aria-controls")).toBe(otherMenu.element().id);
  });

  test("opens header menus by keyboard without synthesizing clicks", async () => {
    const screen = await render(<BrunoTableClient<Row, typeof columns> {...tableProps} />);
    const trigger = screen.getByRole("button", { name: "Column menu for Name" });
    const clicked = vi.fn();
    trigger.element().addEventListener("click", clicked);
    try {
      trigger.element().focus();
      await userEvent.keyboard("{Shift>}{F10}{/Shift}");
      await expect.element(screen.getByRole("menu")).toBeInTheDocument();
      expect(clicked).not.toHaveBeenCalled();
    } finally {
      trigger.element().removeEventListener("click", clicked);
    }
  });

  test("opens column menus inside a form without submitting it", async () => {
    const submit = vi.fn();
    const screen = await render(
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <BrunoTableClient<Row, typeof columns> {...tableProps} />
      </form>,
    );
    const trigger = screen.getByRole("button", { name: "Column menu for Name" });
    await userEvent.click(trigger);
    await expect.element(screen.getByRole("menu")).toBeInTheDocument();
    expect(submit).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    trigger.element().focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(screen.getByRole("menu")).toBeInTheDocument();
    expect(submit).not.toHaveBeenCalled();
  });

  test("keeps one supported Base UI trigger for the shared mounted-header menu", async () => {
    const screen = await render(<BrunoTableClient<Row, typeof columns> {...tableProps} />);
    const grid = screen.getByRole("grid").element();
    const headerRow = grid.querySelector("thead");
    expect(headerRow).not.toBeNull();
    expect(headerRow?.querySelectorAll('[data-slot="dropdown-menu-trigger"]')).toHaveLength(0);

    const visibleTriggers = screen.getByRole("button", { name: /^Column menu for /u }).all();
    expect(visibleTriggers).toHaveLength(3);
    for (const trigger of visibleTriggers) {
      expect(trigger.element()).not.toHaveAttribute("data-slot", "dropdown-menu-trigger");
    }

    await userEvent.click(screen.getByRole("button", { name: "Column menu for Name" }));
    await expect.element(screen.getByRole("menu")).toBeInTheDocument();
    expect(headerRow?.querySelectorAll('[data-slot="dropdown-menu-trigger"]')).toHaveLength(1);
    expect(
      headerRow?.querySelector('[data-slot="dropdown-menu-trigger"]')?.getAttribute("style"),
    ).toContain("position: absolute");
  });

  test("opens the column menu from the semantic ContextMenu key", async () => {
    const screen = await render(<BrunoTableClient<Row, typeof columns> {...tableProps} />);
    const trigger = screen.getByRole("button", { name: "Column menu for Name" });
    trigger.element().focus();
    await userEvent.keyboard("{ContextMenu}");
    await expect.element(screen.getByRole("menu")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger.element()));
  });

  test("leaves lookalike custom controls outside the column-menu workflow", async () => {
    const customClick = vi.fn();
    const customColumns = [
      {
        ...columns[0],
        cellRenderer: ({ row }: { readonly row: Row }) => (
          <button
            aria-label={`Column menu for custom ${row.name}`}
            data-bruno-column-menu-trigger="COL_ID_NAME"
            onClick={customClick}
            type="button"
          >
            Custom action
          </button>
        ),
      },
      columns[1],
      columns[2],
    ] as const satisfies BrunoTableColumns<Row>;
    const screen = await render(
      <BrunoTableClient<Row, typeof customColumns>
        {...tableProps}
        columns={customColumns}
        tableId="TABLE_ID_COLUMN_MENU_LOOKALIKE"
      />,
    );
    const customAction = screen.getByRole("button", { name: "Column menu for custom Ada" });
    customAction.element().focus();
    const shortcut = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "F10",
      shiftKey: true,
    });
    customAction.element().dispatchEvent(shortcut);

    await new Promise(requestAnimationFrame);
    expect(shortcut.defaultPrevented).toBe(false);
    expect(customClick).not.toHaveBeenCalled();
    await expect.element(screen.getByRole("menu")).not.toBeInTheDocument();
    await expect.element(customAction).toHaveFocus();
  });

  test("opens the typed filter editor from a column menu without an initial baseline", async () => {
    const screen = await render(<BrunoTableClient<Row, typeof columns> {...tableProps} />);
    await userEvent.click(screen.getByRole("button", { name: "Column menu for Name" }));
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Open filter for Name", exact: true }),
    );
    const dialog = screen.getByRole("dialog", { name: "Filter Name" });
    await expect.element(dialog).toBeInTheDocument();
    await expect
      .element(dialog.getByRole("combobox", { name: "Filter expression for Name" }))
      .toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect
      .element(screen.getByRole("grid", { name: "Data for TABLE_ID_COLUMN_MANAGEMENT" }))
      .toHaveFocus();
  });

  test("provides grouped layout menus for pinning, moving, visibility, and reset", async () => {
    const screen = await render(<BrunoTableClient<Row, typeof columns> {...tableProps} />);
    const menuTrigger = screen.getByRole("button", { name: "Column menu for Name" });

    screen
      .getByRole("button", { name: "Sort by Name" })
      .element()
      .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    await expect.element(screen.getByRole("menuitem", { name: "Move" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(menuTrigger);
    await expect
      .element(screen.getByRole("menuitem", { name: "Sort by Name" }))
      .toBeInTheDocument();
    await expect.element(screen.getByRole("menuitem", { name: "Move" })).toBeInTheDocument();
    await expect.element(screen.getByRole("menuitem", { name: "Visibility" })).toBeInTheDocument();
    await expect.element(screen.getByRole("menuitem", { name: "Reset" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("menuitemradio", { name: "Pin to logical start" }));
    await vi.waitFor(() =>
      expect(
        screen.getByRole("columnheader", { name: /Name, width 160 pixels, pinned start/u }),
      ).toBeInTheDocument(),
    );
    await expect
      .element(screen.getByRole("columnheader", { name: /Name, width 160 pixels, pinned start/u }))
      .toHaveAttribute("data-pinned-region", "start");

    await userEvent.click(screen.getByRole("button", { name: "Column menu for Name" }));
    await userEvent.hover(screen.getByRole("menuitem", { name: "Visibility" }));
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "Score" }));
    await vi.waitFor(() =>
      expect(screen.getByRole("grid").element().getAttribute("aria-colcount")).toBe("2"),
    );
    await expect.element(screen.getByRole("columnheader", { name: /Name/u })).toBeInTheDocument();
    await expect.element(screen.getByRole("columnheader", { name: /Status/u })).toBeInTheDocument();
    await expect
      .element(screen.getByRole("columnheader", { name: /Score/u }))
      .not.toBeInTheDocument();
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Column menu for Name" }).element(),
      ),
    );
  });

  test("keeps logical menu commands correct in RTL and cancels an active pointer gesture", async () => {
    const screen = await render(
      <div dir="rtl">
        <BrunoTableClient<Row, typeof columns>
          {...tableProps}
          tableId="TABLE_ID_COLUMN_MANAGEMENT_RTL"
        />
      </div>,
    );
    const grid = screen.getByRole("grid").element();
    const nameMenu = screen.getByRole("button", { name: "Column menu for Name" });
    await userEvent.click(nameMenu);
    await userEvent.hover(screen.getByRole("menuitem", { name: "Move" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Move toward logical end" }));
    await vi.waitFor(() =>
      expect(
        [...grid.querySelectorAll<HTMLElement>("th[data-bruno-column-id]")].map(
          (header) => header.dataset["brunoColumnId"],
        ),
      ).toEqual(["COL_ID_SCORE", "COL_ID_NAME", "COL_ID_STATUS"]),
    );

    await userEvent.click(screen.getByRole("button", { name: "Column menu for Name" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Pin to logical end" }));
    await vi.waitFor(() =>
      expect(screen.getByRole("columnheader", { name: /Name/u })).toHaveAttribute(
        "data-pinned-region",
        "end",
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "Column menu for Name" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Unpin" }));
    await vi.waitFor(() =>
      expect(
        screen.getByRole("columnheader", { name: /Name, width 160 pixels/u }),
      ).not.toHaveAttribute("data-pinned-region", "end"),
    );

    const resizeHandle = screen.getByRole("separator", { name: "Resize Name" }).element();
    resizeHandle.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 100,
        pointerId: 12,
      }),
    );
    window.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, clientX: 180, pointerId: 12 }),
    );
    window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    await vi.waitFor(() =>
      expect(screen.getByRole("separator", { name: "Resize Name" })).toHaveAttribute(
        "aria-valuenow",
        "160",
      ),
    );
    const secondResizeHandle = screen.getByRole("separator", { name: "Resize Name" }).element();
    secondResizeHandle.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 100,
        pointerId: 13,
      }),
    );
    window.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, clientX: 180, pointerId: 13 }),
    );
    window.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 13 }));
    await vi.waitFor(() =>
      expect(screen.getByRole("separator", { name: "Resize Name" })).toHaveAttribute(
        "aria-valuenow",
        "160",
      ),
    );
    await screen.rerender(<></>);
  });

  test.each([
    ...[100_000, 120_000].flatMap((rowCount) =>
      [1000, 1010].flatMap((scrollOffset) =>
        ["cancel", "no-op"].map((ending) => ({ rowCount, scrollOffset, ending })),
      ),
    ),
    { rowCount: 120_000, scrollOffset: 1000, ending: "scroll-cancel" },
  ])(
    "keeps $rowCount rows aligned during resize and $ending at offset $scrollOffset",
    async ({ rowCount, scrollOffset, ending }) => {
      const resizeColumns = [
        { ...columns[0], width: 800 },
        ...Array.from({ length: 12 }, (_, index) => ({
          columnId: `COL_ID_EXTRA_${index}` as BrunoTableColumnId,
          field: "score" as const,
          headerName: `Extra ${index}`,
          valueType: "number" as const,
          width: 100,
        })),
      ] satisfies BrunoTableColumns<Row>;
      const residentRows: readonly Row[] = Array.from({ length: rowCount }, (_, index) => ({
        id: `row-${index}`,
        name: `Row ${String(index).padStart(6, "0")}`,
        score: index,
        status: "Ready",
      }));
      const screen = await render(
        <div style={{ width: 240, height: 480 }}>
          <BrunoTableClient<Row, typeof resizeColumns>
            {...tableProps}
            columns={resizeColumns}
            initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
            tableId="TABLE_ID_RESIZE_PREVIEW_ROW_ALIGNMENT"
            clientSource={{
              rows: residentRows,
              totalRows: residentRows.length,
              version: 1,
              status: "ready",
            }}
          />
        </div>,
      );
      const grid = screen.getByRole("grid").element();
      await vi.waitFor(() => expect(grid.scrollHeight).toBeGreaterThan(1010));
      expect(grid.clientWidth).toBe(240);
      if (rowCount === 120_000) expect(grid.scrollHeight).toBeGreaterThanOrEqual(4_000_000);
      grid.scrollTop = scrollOffset;
      grid.dispatchEvent(new Event("scroll"));
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      const firstBodyRow = () =>
        screen
          .getByRole("row")
          .all()
          .find((row) => Number(row.element().getAttribute("aria-rowindex")) > 1)!
          .element();
      await vi.waitFor(() =>
        expect(Number(firstBodyRow().getAttribute("aria-rowindex"))).toBeGreaterThan(2),
      );
      const firstIndex = firstBodyRow().getAttribute("aria-rowindex");
      const firstTop = firstBodyRow().getBoundingClientRect().top;
      let verticalDelta = 0;
      const assertRowsAligned = () => {
        for (const row of screen.getByRole("row").all()) {
          const rowIndex = Number(row.element().getAttribute("aria-rowindex"));
          if (rowIndex <= 1) continue;
          expect(row.element().getBoundingClientRect().top, `row ${rowIndex} position`).toBeCloseTo(
            firstTop + (rowIndex - Number(firstIndex)) * 36 - verticalDelta,
            1,
          );
        }
      };
      const initialScrollTop = grid.scrollTop;
      if (scrollOffset === 1010) {
        expect(Math.floor(initialScrollTop / 36)).not.toBe(
          Math.floor((Math.floor(initialScrollTop / 32) * 32) / 36),
        );
      }
      const handle = screen.getByRole("separator", { name: "Resize Name" }).element();
      handle.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 100, pointerId: 53 }),
      );
      expect(grid.scrollTop, "after pointer admission").toBe(initialScrollTop);
      window.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, clientX: -600, pointerId: 53 }),
      );
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      await vi.waitFor(() =>
        expect(
          screen.getByRole("columnheader", { name: /Name/u }).element().getBoundingClientRect()
            .width,
        ).toBe(100),
      );
      expect(grid.scrollTop, "during preview").toBe(initialScrollTop);
      assertRowsAligned();
      if (ending === "scroll-cancel") {
        const mountedIndexes = () =>
          screen
            .getByRole("row")
            .all()
            .map((row) => row.element().getAttribute("aria-rowindex"));
        const previewIndexes = mountedIndexes();
        verticalDelta = 108;
        grid.scrollTop = initialScrollTop + verticalDelta;
        grid.dispatchEvent(new Event("scroll"));
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        expect(grid.scrollTop).toBe(initialScrollTop + verticalDelta);
        expect(mountedIndexes()).toEqual(previewIndexes);
        assertRowsAligned();
      }
      if (ending === "no-op") {
        window.dispatchEvent(
          new PointerEvent("pointermove", { bubbles: true, clientX: 100, pointerId: 53 }),
        );
        await vi.waitFor(() =>
          expect(
            screen.getByRole("columnheader", { name: /Name/u }).element().getBoundingClientRect()
              .width,
          ).toBe(800),
        );
        assertRowsAligned();
        window.dispatchEvent(
          new PointerEvent("pointerup", { bubbles: true, clientX: 100, pointerId: 53 }),
        );
      } else {
        window.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 53 }));
      }
      await vi.waitFor(() => {
        expect(grid.scrollTop).toBe(initialScrollTop + verticalDelta);
        expect(
          screen.getByRole("columnheader", { name: /Name/u }).element().getBoundingClientRect()
            .width,
        ).toBe(800);
        assertRowsAligned();
      });
      expect(grid.scrollTop).toBe(initialScrollTop + verticalDelta);
    },
  );

  test("uses RTL direction for keyboard submenu navigation", async () => {
    const screen = await render(
      <div dir="rtl">
        <BrunoTableClient<Row, typeof columns>
          {...tableProps}
          tableId="TABLE_ID_COLUMN_MANAGEMENT_RTL_MENU_KEYBOARD"
        />
      </div>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Column menu for Name" }));
    const move = screen.getByRole("menuitem", { name: "Move" });
    move.element().focus();
    await userEvent.keyboard("{ArrowLeft}");

    await expect
      .element(screen.getByRole("menuitem", { name: "Move toward logical start" }))
      .toBeInTheDocument();
  });

  test("pointer reorder crosses into a pinned region atomically", async () => {
    const screen = await render(
      <BrunoTableClient<Row, typeof interleavedColumns>
        tableId="TABLE_ID_COLUMN_MANAGEMENT_POINTER_PIN"
        getRowId={(row: Row) => row.id}
        columns={interleavedColumns}
        initialOrderBy={tableProps.initialOrderBy}
        clientSource={source}
      />,
    );
    const grid = screen.getByRole("grid").element();
    const nameHandle = screen.getByRole("button", { name: "Reorder Name" }).element();
    const statusHeader = screen.getByRole("columnheader", { name: /Status/u }).element();
    const startX = nameHandle.getBoundingClientRect().left + 1;
    const dropX = statusHeader.getBoundingClientRect().right + 24;

    nameHandle.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: startX,
        pointerId: 21,
      }),
    );
    window.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        clientX: dropX,
        pointerId: 21,
      }),
    );
    window.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        clientX: dropX,
        pointerId: 21,
      }),
    );

    await vi.waitFor(() => {
      expect(
        [...grid.querySelectorAll<HTMLElement>("th[data-bruno-column-id]")].map(
          (header) => header.dataset["brunoColumnId"],
        ),
      ).toEqual(["COL_ID_SCORE", "COL_ID_STATUS", "COL_ID_NAME"]);
      expect(
        screen.getByRole("columnheader", { name: /Name, width 160 pixels, pinned end/u }),
      ).toHaveAttribute("data-pinned-region", "end");
    });
  });

  test("pointer reorder unpins through the centre gap when all pinned columns fit", async () => {
    const tableId = "TABLE_ID_COLUMN_MANAGEMENT_FITTING_ALL_PINNED_UNPIN";
    const commands: BrunoTableGridCommand[] = [];
    const removeCommand = installBrunoTableGridCommandListener(tableId, (command) => {
      commands.push(command);
    });

    try {
      const screen = await render(
        <div style={{ width: 800 }}>
          <BrunoTableClient<Row, typeof fittingAllPinnedColumns>
            tableId={tableId}
            getRowId={(row: Row) => row.id}
            columns={fittingAllPinnedColumns}
            initialOrderBy={[{ columnId: "COL_ID_FITTING_PIN_START", direction: "asc" }]}
            clientSource={source}
          />
        </div>,
      );
      const grid = screen.getByRole("grid", { name: `Data for ${tableId}` }).element();
      const startHeader = screen
        .getByRole("columnheader", { name: /Fitting pinned start/u })
        .element();
      const endHeader = screen.getByRole("columnheader", { name: /Fitting pinned end/u }).element();
      const startReorder = screen
        .getByRole("button", { name: "Reorder Fitting pinned start" })
        .element();
      const startRect = startHeader.getBoundingClientRect();
      const endRect = endHeader.getBoundingClientRect();
      const dropX = (startRect.right + endRect.left) / 2;

      expect(dropX).toBeGreaterThan(startRect.right);
      expect(dropX).toBeLessThan(endRect.left);
      startReorder.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: startReorder.getBoundingClientRect().left + 1,
          pointerId: 51,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, clientX: dropX, pointerId: 51 }),
      );
      await new Promise((resolve) => requestAnimationFrame(resolve));
      window.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, clientX: dropX, pointerId: 51 }),
      );

      await vi.waitFor(() => expect(commands).toHaveLength(1));
      expectTypedCommand(commands[0], {
        type: "column.reorder.commit",
        columnId: "COL_ID_FITTING_PIN_START",
        targetIndex: 0,
        pinned: undefined,
      });
      await vi.waitFor(() =>
        expect(
          screen.getByRole("columnheader", { name: /Fitting pinned start/u }),
        ).not.toHaveAttribute("data-pinned-region", "start"),
      );
      expect(grid.querySelector('[data-bruno-pinned-body-region="start"]')).toBeNull();
      expect(grid.querySelector('[data-bruno-pinned-body-region="end"]')).not.toBeNull();
    } finally {
      removeCommand();
    }
  });

  test("bounds React publication when a resize exposes an unmounted centre slice", async () => {
    const tableId = "TABLE_ID_COLUMN_MANAGEMENT_WIDE_PREVIEW_PUBLICATION";
    const gridSurfaceRenders = vi.fn();
    const rowRenders = vi.fn();
    const removeGridSurface = installBrunoTableClientGridSurfaceRenderListenerForTable(
      tableId,
      gridSurfaceRenders,
    );
    const removeRows = installBrunoTableClientRowRenderListenerForTable(tableId, rowRenders);

    try {
      const screen = await render(
        <div style={{ width: 240 }}>
          <BrunoTableClient<Row, typeof wideFirstPreviewColumns>
            tableId={tableId}
            getRowId={(row: Row) => row.id}
            columns={wideFirstPreviewColumns}
            initialOrderBy={[{ columnId: "COL_ID_WIDE_FIRST_PREVIEW", direction: "asc" }]}
            clientSource={source}
          />
        </div>,
      );
      const grid = screen.getByRole("grid", { name: `Data for ${tableId}` }).element();
      expect(columnOrder(grid)).not.toContain("COL_ID_WIDE_EXPOSED_3");
      gridSurfaceRenders.mockClear();
      rowRenders.mockClear();

      const resizeHandle = screen.getByRole("separator", { name: "Resize Wide first preview" });
      const startX = resizeHandle.element().getBoundingClientRect().right - 1;
      resizeHandle.element().dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: startX,
          pointerId: 52,
        }),
      );
      for (const width of [100, 90, 80, 70, 60]) {
        window.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            clientX: startX - (800 - width),
            pointerId: 52,
          }),
        );
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await vi.waitFor(() =>
          expect(resizeHandle).toHaveAttribute("aria-valuenow", String(width)),
        );
      }

      await vi.waitFor(() => expect(columnOrder(grid)).toContain("COL_ID_WIDE_EXPOSED_3"));
      expect(gridSurfaceRenders.mock.calls.length).toBe(2);
      expect(rowRenders.mock.calls.length).toBeLessThanOrEqual(32);

      window.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          clientX: startX - 700,
          pointerId: 52,
        }),
      );
    } finally {
      removeGridSurface();
      removeRows();
    }
  });

  test("keeps retained resize padding correct without publishing a render cascade", async () => {
    const tableId = "TABLE_ID_COLUMN_MANAGEMENT_RETAINED_PREVIEW";
    const gridSurfaceRenders = vi.fn();
    const rowRenders = vi.fn();
    const removeGridSurface = installBrunoTableClientGridSurfaceRenderListenerForTable(
      tableId,
      gridSurfaceRenders,
    );
    const removeRows = installBrunoTableClientRowRenderListenerForTable(tableId, rowRenders);

    try {
      const screen = await render(
        <div style={{ width: 240 }}>
          <BrunoTableClient<Row, typeof retainedFirstPreviewColumns>
            tableId={tableId}
            getRowId={(row: Row) => row.id}
            columns={retainedFirstPreviewColumns}
            initialOrderBy={[{ columnId: "COL_ID_RETAINED_FIRST_PREVIEW", direction: "asc" }]}
            clientSource={source}
          />
        </div>,
      );
      const grid = screen.getByRole("grid", { name: `Data for ${tableId}` }).element();
      const initialMountedColumns = columnOrder(grid);
      expect(initialMountedColumns).toContain("COL_ID_RETAINED_EXPOSED_3");
      gridSurfaceRenders.mockClear();
      rowRenders.mockClear();

      const resizeHandle = screen.getByRole("separator", {
        name: "Resize Retained first preview",
      });
      const startX = resizeHandle.element().getBoundingClientRect().right - 1;
      resizeHandle.element().dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: startX,
          pointerId: 53,
        }),
      );
      for (const width of [200, 400, 600, 800]) {
        window.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            clientX: startX + (width - 100),
            pointerId: 53,
          }),
        );
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await vi.waitFor(() =>
          expect(resizeHandle).toHaveAttribute("aria-valuenow", String(width)),
        );
      }

      expect(columnOrder(grid)).toEqual(initialMountedColumns);
      expect(gridSurfaceRenders).not.toHaveBeenCalled();
      expect(rowRenders).not.toHaveBeenCalled();
      expect(grid.style.getPropertyValue(BRUNO_TABLE_LIVE_RIGHT_PADDING_CSS_VARIABLE)).toBe(
        "1600px",
      );

      window.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          clientX: startX + 700,
          pointerId: 53,
        }),
      );
    } finally {
      removeGridSurface();
      removeRows();
    }
  });

  test("keeps pointer reorder boundaries logical in RTL", async () => {
    const screen = await render(
      <div dir="rtl">
        <BrunoTableClient<Row, typeof columns>
          {...tableProps}
          tableId="TABLE_ID_COLUMN_MANAGEMENT_RTL_POINTER"
        />
      </div>,
    );
    const grid = screen.getByRole("grid").element();
    const columnOrder = () =>
      [...grid.querySelectorAll<HTMLElement>("th[data-bruno-column-id]")].map(
        (header) => header.dataset["brunoColumnId"],
      );
    const nameHandle = screen.getByRole("button", { name: "Reorder Name" }).element();
    const gridRect = grid.getBoundingClientRect();
    const handleRect = nameHandle.getBoundingClientRect();
    nameHandle.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: handleRect.left + handleRect.width / 2,
        pointerId: 14,
      }),
    );
    window.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        clientX: gridRect.left - 20,
        pointerId: 14,
      }),
    );
    window.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        clientX: gridRect.left - 20,
        pointerId: 14,
      }),
    );
    await vi.waitFor(() =>
      expect(columnOrder()).toEqual(["COL_ID_SCORE", "COL_ID_STATUS", "COL_ID_NAME"]),
    );
  });

  test("keeps simultaneous pinned regions and visibility in one logical order", async () => {
    const screen = await render(
      <BrunoTableClient<Row, typeof interleavedColumns>
        tableId="TABLE_ID_COLUMN_MANAGEMENT_PINNED"
        getRowId={(row: Row) => row.id}
        columns={interleavedColumns}
        initialOrderBy={tableProps.initialOrderBy}
        clientSource={source}
      />,
    );
    const grid = screen.getByRole("grid").element();
    const columnOrder = () =>
      [...grid.querySelectorAll<HTMLElement>("th[data-bruno-column-id]")].map(
        (header) => header.dataset["brunoColumnId"],
      );

    expect(columnOrder()).toEqual(["COL_ID_SCORE", "COL_ID_NAME", "COL_ID_STATUS"]);
    await expect
      .element(screen.getByRole("columnheader", { name: /Score/u }))
      .toHaveAttribute("data-pinned-region", "start");
    await expect
      .element(screen.getByRole("columnheader", { name: /Status/u }))
      .toHaveAttribute("data-pinned-region", "end");

    await userEvent.click(screen.getByRole("button", { name: "Column menu for Name" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Pin to logical start" }));
    await vi.waitFor(() =>
      expect(columnOrder()).toEqual(["COL_ID_NAME", "COL_ID_SCORE", "COL_ID_STATUS"]),
    );
    await expect
      .element(screen.getByRole("columnheader", { name: /Name, width 160 pixels, pinned start/u }))
      .toHaveAttribute("data-pinned-region", "start");

    await userEvent.click(screen.getByRole("button", { name: "Column menu for Score" }));
    await userEvent.hover(screen.getByRole("menuitem", { name: "Visibility" }));
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "Score" }));
    await vi.waitFor(() => expect(grid.getAttribute("aria-colcount")).toBe("2"));
    expect(columnOrder()).toEqual(["COL_ID_NAME", "COL_ID_STATUS"]);
    await vi.waitFor(() =>
      expect(grid.getAttribute("aria-activedescendant")).toBe(
        screen.getByRole("columnheader", { name: /Status, width 140 pixels/u }).element().id,
      ),
    );
    await expect
      .element(screen.getByRole("columnheader", { name: /Score/u }))
      .not.toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Sort" })).not.toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole("button", { name: "Column menu for Name" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Unpin" }));
    await vi.waitFor(() =>
      expect(
        screen.getByRole("columnheader", { name: /Name, width 160 pixels/u }),
      ).not.toHaveAttribute("data-pinned-region", "start"),
    );
    await expect
      .element(screen.getByRole("columnheader", { name: /Status, width 140 pixels, pinned end/u }))
      .toHaveAttribute("data-pinned-region", "end");
  });

  test("supports keyboard resize and rejects hiding the final visible column", async () => {
    const screen = await render(<BrunoTableClient<Row, typeof columns> {...tableProps} />);
    const resizeHandle = screen.getByRole("separator", { name: "Resize Name" });
    resizeHandle.element().focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect
      .element(screen.getByRole("separator", { name: "Resize Name" }))
      .toHaveAttribute("aria-valuenow", "170");
    await userEvent.keyboard("{Home}");
    await expect
      .element(screen.getByRole("separator", { name: "Resize Name" }))
      .toHaveAttribute("aria-valuenow", "32");
    await userEvent.keyboard("{End}");
    await expect
      .element(screen.getByRole("separator", { name: "Resize Name" }))
      .toHaveAttribute("aria-valuenow", "1000");
    await userEvent.keyboard("{ArrowRight}");
    await expect
      .element(screen.getByRole("separator", { name: "Resize Name" }))
      .toHaveAttribute("aria-valuenow", "1000");

    const nameMenu = screen.getByRole("button", { name: "Column menu for Name" });
    await userEvent.click(nameMenu);
    await userEvent.hover(screen.getByRole("menuitem", { name: "Visibility" }));
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "Score" }));
    await userEvent.hover(screen.getByRole("menuitem", { name: "Visibility" }));
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "Status" }));

    await expect
      .element(screen.getByRole("menuitemcheckbox", { name: "Name" }))
      .toHaveAttribute("aria-disabled", "true");
    await expect.element(screen.getByRole("grid")).toHaveAttribute("aria-colcount", "1");
  });

  test("resizes by logical direction in RTL for the handle and grid shortcut", async () => {
    const screen = await render(
      <div dir="rtl">
        <BrunoTableClient<Row, typeof columns>
          {...tableProps}
          tableId="TABLE_ID_COLUMN_MANAGEMENT_RTL_RESIZE"
        />
      </div>,
    );
    const resizeHandle = screen.getByRole("separator", { name: "Resize Name" });
    resizeHandle.element().focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(resizeHandle).toHaveAttribute("aria-valuenow", "150");
    await userEvent.keyboard("{ArrowLeft}");
    await expect.element(resizeHandle).toHaveAttribute("aria-valuenow", "160");

    const grid = screen.getByRole("grid").element();
    grid.focus();
    grid.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" }));
    grid.dispatchEvent(
      new KeyboardEvent("keydown", { altKey: true, bubbles: true, key: "ArrowRight" }),
    );
    await expect.element(resizeHandle).toHaveAttribute("aria-valuenow", "150");
  });

  test("exposes the active header resize handle as a keyboard tab stop", async () => {
    const screen = await render(<BrunoTableClient<Row, typeof columns> {...tableProps} />);
    const grid = screen.getByRole("grid").element();
    grid.focus();
    grid.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" }));
    const resizeHandle = screen.getByRole("separator", { name: "Resize Name" });
    await vi.waitFor(() => expect(resizeHandle.element().tabIndex).toBe(0));
    expect(resizeHandle.element().getAttribute("aria-keyshortcuts")).toBe(
      "ArrowLeft ArrowRight Home End",
    );
  });

  test("resets the complete layout atomically without changing sorting", async () => {
    const screen = await render(<BrunoTableClient<Row, typeof columns> {...tableProps} />);
    const grid = screen.getByRole("grid").element();
    const columnOrder = () =>
      [...grid.querySelectorAll<HTMLElement>("th[data-bruno-column-id]")].map(
        (header) => header.dataset["brunoColumnId"],
      );

    const resizeHandle = screen.getByRole("separator", { name: "Resize Name" }).element();
    resizeHandle.focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(resizeHandle).toHaveAttribute("aria-valuenow", "170");

    await userEvent.click(screen.getByRole("button", { name: "Column menu for Name" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Pin to logical start" }));
    await userEvent.click(screen.getByRole("button", { name: "Column menu for Name" }));
    await userEvent.hover(screen.getByRole("menuitem", { name: "Visibility" }));
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "Score" }));

    await vi.waitFor(() => expect(grid.getAttribute("aria-colcount")).toBe("2"));
    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Sort" })).not.toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole("button", { name: "Column menu for Name" }));
    await vi.waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Reset" })).toBeInTheDocument(),
    );
    await userEvent.hover(screen.getByRole("menuitem", { name: "Reset" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Reset complete layout" }));

    await vi.waitFor(() =>
      expect(columnOrder()).toEqual(["COL_ID_NAME", "COL_ID_SCORE", "COL_ID_STATUS"]),
    );
    await expect.element(grid).toHaveAttribute("aria-colcount", "3");
    await expect
      .element(screen.getByRole("separator", { name: "Resize Name" }))
      .toHaveAttribute("aria-valuenow", "160");
    await expect
      .element(screen.getByRole("columnheader", { name: /Name, width 160 pixels/u }))
      .not.toHaveAttribute("data-pinned-region", "start");
    await expect
      .element(
        screen.getByRole("button", { name: "Sort by Score, currently ascending, priority 1" }),
      )
      .toBeInTheDocument();
  });

  test("reconciles and reveals a body active cell across keyboard layout commands", async () => {
    const tableId = "TABLE_ID_COLUMN_MANAGEMENT_ACTIVE_REVEAL";
    const commands: BrunoTableGridCommand[] = [];
    const removeCommand = installBrunoTableGridCommandListener(tableId, (command) => {
      commands.push(command);
    });
    try {
      const screen = await render(
        <BrunoTableClient<Row, typeof revealColumns>
          tableId={tableId}
          getRowId={(row: Row) => row.id}
          columns={revealColumns}
          initialOrderBy={[{ columnId: "COL_ID_SCORE", direction: "asc" }]}
          clientSource={source}
        />,
      );
      const grid = screen.getByRole("grid", { name: `Data for ${tableId}` }).element();
      grid.focus();
      for (let index = 0; index < 7; index += 1) {
        grid.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
      }

      await vi.waitFor(() => {
        const activeId = grid.getAttribute("aria-activedescendant");
        const activeCell =
          activeId === null ? null : document.querySelector<HTMLElement>(`#${activeId}`);
        expect(activeCell?.getAttribute("data-bruno-column-id")).toBe("COL_ID_EXTRA_4");
        expect(activeCell).not.toHaveAttribute("data-bruno-active-proxy");
      });
      const activeBefore = grid.getAttribute("aria-activedescendant");
      expect(activeBefore).not.toBeNull();
      expect(grid.querySelector('[data-bruno-pinned-body-region="start"]')).not.toBeNull();
      expect(grid.querySelector('[data-bruno-pinned-body-region="end"]')).not.toBeNull();
      await expect.element(grid).toHaveAttribute("aria-colcount", String(revealColumns.length));
      await expect
        .element(screen.getByRole("columnheader", { name: /Reveal end/u }))
        .toHaveAttribute("aria-colindex", String(revealColumns.length));

      const openMenuByKeyboard = async (columnName: string) => {
        const trigger = screen.getByRole("button", { name: `Column menu for ${columnName}` });
        trigger.element().focus();
        await userEvent.keyboard("{Enter}");
        await expect.element(screen.getByRole("menu")).toBeInTheDocument();
        return trigger;
      };
      const openNameMenu = async () => {
        await closeColumnMenus(screen);
        grid.scrollLeft = 0;
        grid.dispatchEvent(new Event("scroll", { bubbles: true }));
        await waitForAnimationFrames(2);
        await expect
          .element(screen.getByRole("button", { name: "Column menu for Name" }))
          .toBeInTheDocument();
        await vi.waitFor(() => {
          const header = grid.querySelector<HTMLElement>('th[data-bruno-column-id="COL_ID_NAME"]');
          expect(header?.querySelector('button[aria-label="Column menu for Name"]')).not.toBeNull();
        });
        return openMenuByKeyboard("Name");
      };
      const assertActiveCell = async () => {
        await vi.waitFor(() => {
          expect(grid.getAttribute("aria-activedescendant")).toBe(activeBefore);
          const activeId = grid.getAttribute("aria-activedescendant");
          const activeCells =
            activeId === null
              ? []
              : [...document.querySelectorAll<HTMLElement>('[role="gridcell"]')].filter(
                  (cell) => cell.id === activeId,
                );
          const activeCell = activeCells.find(
            (cell) => !cell.hasAttribute("data-bruno-active-proxy"),
          );
          expect(activeCell).not.toBeUndefined();
          expect(activeCell?.getAttribute("data-bruno-column-id")).toBe("COL_ID_EXTRA_4");
          expect(activeCell?.getBoundingClientRect().right).toBeGreaterThan(
            grid.getBoundingClientRect().left,
          );
          expect(activeCell?.getBoundingClientRect().left).toBeLessThan(
            grid.getBoundingClientRect().right,
          );
          expect(grid.scrollLeft).toBeGreaterThan(0);
        });
      };

      await openNameMenu();
      await openColumnSubmenu(screen, "Move");
      await activateMenuItem(screen, "Move toward logical end");
      await vi.waitFor(() => expect(commands).toHaveLength(1));
      expectTypedCommand(commands[0], {
        type: "column.reorder.commit",
        columnId: "COL_ID_NAME",
        targetIndex: 2,
        pinned: undefined,
      });
      assertMountedColumnGeometry(
        grid,
        mountedColumnExpectationsFromLogicalOrder(
          [
            "COL_ID_REVEAL_START",
            "COL_ID_SCORE",
            "COL_ID_NAME",
            "COL_ID_STATUS",
            "COL_ID_EXTRA_1",
            "COL_ID_EXTRA_2",
            "COL_ID_EXTRA_3",
            "COL_ID_EXTRA_4",
            "COL_ID_EXTRA_5",
            "COL_ID_REVEAL_END",
          ],
          ["COL_ID_REVEAL_START"],
          ["COL_ID_REVEAL_END"],
        ),
      );
      assertMountedColumnWindow(
        grid,
        [
          "COL_ID_REVEAL_START",
          "COL_ID_SCORE",
          "COL_ID_NAME",
          "COL_ID_STATUS",
          "COL_ID_EXTRA_1",
          "COL_ID_EXTRA_2",
          "COL_ID_EXTRA_3",
          "COL_ID_EXTRA_4",
          "COL_ID_EXTRA_5",
          "COL_ID_REVEAL_END",
        ],
        {
          pinnedStartIds: ["COL_ID_REVEAL_START"],
          pinnedEndIds: ["COL_ID_REVEAL_END"],
          requiredColumnIds: ["COL_ID_EXTRA_4"],
        },
      );
      await assertActiveCell();

      await openNameMenu();
      await openColumnSubmenu(screen, "Visibility");
      await activateMenuCheckbox(screen, "Score");
      await vi.waitFor(() => expect(commands).toHaveLength(2));
      expectTypedCommand(commands[1], {
        type: "column.visibility.commit",
        columnId: "COL_ID_SCORE",
        visible: false,
      });
      assertMountedColumnGeometry(
        grid,
        mountedColumnExpectationsFromLogicalOrder(
          [
            "COL_ID_REVEAL_START",
            "COL_ID_NAME",
            "COL_ID_STATUS",
            "COL_ID_EXTRA_1",
            "COL_ID_EXTRA_2",
            "COL_ID_EXTRA_3",
            "COL_ID_EXTRA_4",
            "COL_ID_EXTRA_5",
            "COL_ID_REVEAL_END",
          ],
          ["COL_ID_REVEAL_START"],
          ["COL_ID_REVEAL_END"],
        ),
      );
      assertMountedColumnWindow(
        grid,
        [
          "COL_ID_REVEAL_START",
          "COL_ID_NAME",
          "COL_ID_STATUS",
          "COL_ID_EXTRA_1",
          "COL_ID_EXTRA_2",
          "COL_ID_EXTRA_3",
          "COL_ID_EXTRA_4",
          "COL_ID_EXTRA_5",
          "COL_ID_REVEAL_END",
        ],
        {
          pinnedStartIds: ["COL_ID_REVEAL_START"],
          pinnedEndIds: ["COL_ID_REVEAL_END"],
          requiredColumnIds: ["COL_ID_EXTRA_4"],
        },
      );
      await assertActiveCell();

      await openNameMenu();
      await activateMenuRadio(screen, "Pin to logical end");
      await vi.waitFor(() => expect(commands).toHaveLength(3));
      expectTypedCommand(commands[2], {
        type: "column.pin.commit",
        columnId: "COL_ID_NAME",
        pinned: "end",
      });
      assertMountedColumnGeometry(
        grid,
        mountedColumnExpectationsFromLogicalOrder(
          [
            "COL_ID_REVEAL_START",
            "COL_ID_STATUS",
            "COL_ID_EXTRA_1",
            "COL_ID_EXTRA_2",
            "COL_ID_EXTRA_3",
            "COL_ID_EXTRA_4",
            "COL_ID_EXTRA_5",
            "COL_ID_NAME",
            "COL_ID_REVEAL_END",
          ],
          ["COL_ID_REVEAL_START"],
          ["COL_ID_NAME", "COL_ID_REVEAL_END"],
        ),
      );
      assertMountedColumnWindow(
        grid,
        [
          "COL_ID_REVEAL_START",
          "COL_ID_STATUS",
          "COL_ID_EXTRA_1",
          "COL_ID_EXTRA_2",
          "COL_ID_EXTRA_3",
          "COL_ID_EXTRA_4",
          "COL_ID_EXTRA_5",
          "COL_ID_NAME",
          "COL_ID_REVEAL_END",
        ],
        {
          pinnedStartIds: ["COL_ID_REVEAL_START"],
          pinnedEndIds: ["COL_ID_NAME", "COL_ID_REVEAL_END"],
          requiredColumnIds: ["COL_ID_EXTRA_4"],
        },
      );
      await assertActiveCell();
    } finally {
      removeCommand();
    }
  });

  test("preserves pinning when pointer reorder occurs in narrow centreless overflow", async () => {
    const tableId = "TABLE_ID_COLUMN_MANAGEMENT_NARROW_PINNED_REORDER";
    const commands: BrunoTableGridCommand[] = [];
    const removeCommand = installBrunoTableGridCommandListener(tableId, (command) => {
      commands.push(command);
    });

    try {
      const screen = await render(
        <div style={{ width: 240 }}>
          <BrunoTableClient<Row, typeof narrowAllPinnedColumns>
            tableId={tableId}
            getRowId={(row: Row) => row.id}
            columns={narrowAllPinnedColumns}
            initialOrderBy={[{ columnId: "COL_ID_NARROW_PIN_START_A", direction: "asc" }]}
            clientSource={source}
          />
        </div>,
      );
      const grid = screen.getByRole("grid", { name: `Data for ${tableId}` }).element();
      const reorderHandle = screen
        .getByRole("button", { name: "Reorder Narrow pinned start A" })
        .element();
      const secondHeader = screen
        .getByRole("columnheader", { name: /Narrow pinned start B/u })
        .element();
      const secondRect = secondHeader.getBoundingClientRect();
      reorderHandle.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: reorderHandle.getBoundingClientRect().left + 1,
          pointerId: 50,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: secondRect.left + secondRect.width - 1,
          pointerId: 50,
        }),
      );
      await new Promise((resolve) => requestAnimationFrame(resolve));
      window.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          clientX: secondRect.left + secondRect.width - 1,
          pointerId: 50,
        }),
      );
      await vi.waitFor(() => expect(commands).toHaveLength(1));
      expectTypedCommand(commands[0], {
        type: "column.reorder.commit",
        columnId: "COL_ID_NARROW_PIN_START_A",
        targetIndex: 2,
        pinned: "start",
      });
      expect(grid.querySelector('[data-bruno-pinned-body-region="start"]')).toBeNull();
      expect(grid.querySelector('[data-bruno-pinned-body-region="end"]')).toBeNull();
    } finally {
      removeCommand();
    }
  });

  test("previews and commits resize for both pinned boundary regions", async () => {
    const tableId = "TABLE_ID_COLUMN_MANAGEMENT_PINNED_RESIZE";
    const commands: BrunoTableGridCommand[] = [];
    const removeCommand = installBrunoTableGridCommandListener(tableId, (command) => {
      commands.push(command);
    });

    try {
      const screen = await render(
        <div style={{ width: 1024 }}>
          <BrunoTableClient<Row, typeof pinnedBoundaryColumns>
            tableId={tableId}
            getRowId={(row: Row) => row.id}
            columns={pinnedBoundaryColumns}
            initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
            clientSource={source}
          />
        </div>,
      );
      const grid = screen.getByRole("grid", { name: `Data for ${tableId}` }).element();
      const expectedColumns = mountedColumnExpectationsFromLogicalOrder(
        ["COL_ID_NAME", "COL_ID_SCORE", "COL_ID_STATUS"],
        ["COL_ID_NAME"],
        ["COL_ID_STATUS"],
      );
      await expect.element(grid).toHaveAttribute("aria-colcount", "3");
      assertMountedColumnGeometry(grid, expectedColumns);
      assertPinnedBoundaryGeometry(grid, { start: 160, center: 96, end: 140 });

      const startResize = screen.getByRole("separator", { name: "Resize Name" }).element();
      const setStartPointerCapture = vi
        .spyOn(startResize, "setPointerCapture")
        .mockImplementation(() => undefined);
      const hasStartPointerCapture = vi
        .spyOn(startResize, "hasPointerCapture")
        .mockReturnValue(true);
      const releaseStartPointerCapture = vi
        .spyOn(startResize, "releasePointerCapture")
        .mockImplementation(() => undefined);
      startResize.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: 100,
          pointerId: 61,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, clientX: 140, pointerId: 61 }),
      );
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(commands).toHaveLength(0);
      expect(setStartPointerCapture).toHaveBeenCalledWith(61);
      await expect.element(startResize).toHaveAttribute("aria-valuenow", "200");
      assertMountedColumnGeometry(grid, expectedColumns);
      assertPinnedBoundaryGeometry(grid, { start: 200, center: 96, end: 140 });

      window.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, clientX: 140, pointerId: 61 }),
      );
      await vi.waitFor(() => expect(commands).toHaveLength(1));
      expectTypedCommand(commands[0], {
        type: "column.resize.commit",
        columnId: "COL_ID_NAME",
        width: 200,
      });
      expect(hasStartPointerCapture).toHaveBeenCalledWith(61);
      expect(releaseStartPointerCapture).toHaveBeenCalledWith(61);
      expect(document.activeElement).toBe(startResize);
      await expectAnnouncement(screen, "Name width 200 pixels");
      assertPinnedBoundaryGeometry(grid, { start: 200, center: 96, end: 140 });

      const endResize = screen.getByRole("separator", { name: "Resize Status" }).element();
      const setEndPointerCapture = vi
        .spyOn(endResize, "setPointerCapture")
        .mockImplementation(() => undefined);
      const hasEndPointerCapture = vi.spyOn(endResize, "hasPointerCapture").mockReturnValue(true);
      const releaseEndPointerCapture = vi
        .spyOn(endResize, "releasePointerCapture")
        .mockImplementation(() => undefined);
      endResize.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: 100,
          pointerId: 62,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, clientX: 130, pointerId: 62 }),
      );
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(commands).toHaveLength(1);
      expect(setEndPointerCapture).toHaveBeenCalledWith(62);
      await expect.element(endResize).toHaveAttribute("aria-valuenow", "170");
      assertMountedColumnGeometry(grid, expectedColumns);
      assertPinnedBoundaryGeometry(grid, { start: 200, center: 96, end: 170 });

      window.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, clientX: 130, pointerId: 62 }),
      );
      await vi.waitFor(() => expect(commands).toHaveLength(2));
      expectTypedCommand(commands[1], {
        type: "column.resize.commit",
        columnId: "COL_ID_STATUS",
        width: 170,
      });
      expect(hasEndPointerCapture).toHaveBeenCalledWith(62);
      expect(releaseEndPointerCapture).toHaveBeenCalledWith(62);
      expect(document.activeElement).toBe(endResize);
      await expectAnnouncement(screen, "Status width 170 pixels");
      assertMountedColumnGeometry(grid, expectedColumns);
      assertPinnedBoundaryGeometry(grid, { start: 200, center: 96, end: 170 });
    } finally {
      removeCommand();
    }
  });

  test("commits one pointer resize and one pointer reorder after rAF previews", async () => {
    const commands: BrunoTableGridCommand[] = [];
    const resizeFrames = vi.fn();
    const reorderFrames = vi.fn();
    const previewStyleWrites = vi.fn();
    const viewRenders = vi.fn();
    const gridSurfaceRenders = vi.fn();
    const headerRenders = vi.fn();
    const cellRenders = vi.fn();
    const rowOrderPlans = vi.fn();
    const removeCommand = installBrunoTableGridCommandListener(tableProps.tableId, (command) => {
      commands.push(command);
    });
    const removeResize = installBrunoTableClientColumnResizeFrameListener(resizeFrames);
    const removeReorder = installBrunoTableClientColumnReorderFrameListener(reorderFrames);
    const removePreviewStyleWrites =
      installBrunoTableClientColumnPreviewStyleWriteListener(previewStyleWrites);
    const removeView = installBrunoTableClientViewRenderListener(viewRenders);
    const removeGridSurface = installBrunoTableClientGridSurfaceRenderListener(gridSurfaceRenders);
    const removeHeader = installBrunoTableClientHeaderRenderListener(headerRenders);
    const removeRowOrderPlans = installBrunoTableClientRowOrderPlanningListener(rowOrderPlans);
    const removeCells = installBrunoTableClientCellRenderListener(cellRenders);
    try {
      const screen = await render(<BrunoTableClient<Row, typeof columns> {...tableProps} />);
      const grid = screen.getByRole("grid").element();
      const viewRendersBeforeGesture = viewRenders.mock.calls.length;
      const gridSurfaceRendersBeforeGesture = gridSurfaceRenders.mock.calls.length;
      const headerRendersBeforeGesture = headerRenders.mock.calls.length;
      const cellRendersBeforeGesture = cellRenders.mock.calls.length;
      const rowOrderPlansBeforeGesture = rowOrderPlans.mock.calls.length;
      const resizeHandle = screen.getByRole("separator", { name: "Resize Name" }).element();
      resizeHandle.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: 100,
          pointerId: 7,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: 120,
          pointerId: 7,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: 140,
          pointerId: 7,
        }),
      );
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(viewRenders.mock.calls.length).toBe(viewRendersBeforeGesture);
      expect(gridSurfaceRenders.mock.calls.length).toBe(gridSurfaceRendersBeforeGesture);
      expect(headerRenders.mock.calls.length).toBe(headerRendersBeforeGesture);
      expect(cellRenders.mock.calls.length).toBe(cellRendersBeforeGesture);
      expect(previewStyleWrites).toHaveBeenCalled();
      window.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          clientX: 140,
          pointerId: 7,
        }),
      );
      await expect
        .element(screen.getByRole("separator", { name: "Resize Name" }))
        .toHaveAttribute("aria-valuenow", "200");
      await vi.waitFor(() => expect(commands).toHaveLength(1));
      expectTypedCommand(commands[0], {
        type: "column.resize.commit",
        columnId: "COL_ID_NAME",
        width: 200,
      });
      expect(resizeFrames).toHaveBeenCalledTimes(1);
      expect(rowOrderPlans.mock.calls.length).toBe(rowOrderPlansBeforeGesture);

      const reorderHandle = screen.getByRole("button", { name: "Reorder Status" }).element();
      reorderHandle.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: 100,
          pointerId: 8,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: 0,
          pointerId: 8,
        }),
      );
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const reorderTarget = grid.querySelector<HTMLElement>("[data-bruno-reorder-target]");
      expect(reorderTarget).not.toBeNull();
      expect(reorderTarget?.style.outline).toContain("dashed");
      window.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          clientX: 0,
          pointerId: 8,
        }),
      );
      await vi.waitFor(() => expect(reorderFrames).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(commands).toHaveLength(2));
      expectTypedCommand(commands[1], {
        type: "column.reorder.commit",
        columnId: "COL_ID_STATUS",
        targetIndex: 0,
        pinned: undefined,
      });
    } finally {
      removeCommand();
      removeResize();
      removeReorder();
      removePreviewStyleWrites();
      removeView();
      removeGridSurface();
      removeHeader();
      removeRowOrderPlans();
      removeCells();
    }
  });

  test("bounds pointer work and reports frame evidence on a realistic many-column grid", async () => {
    const commands: BrunoTableGridCommand[] = [];
    const gestureFrames: ColumnGestureFrameEvent[] = [];
    const columnCommandNotifications: ColumnCommandSubscriptionEvent[] = [];
    const viewRenders = vi.fn();
    const gridSurfaceRenders = vi.fn();
    const rowOrderPlans = vi.fn();
    const rowRenders = vi.fn();
    const toolbarRenders = vi.fn();
    const cellRenders = vi.fn();
    let previewStyleWriteCount = 0;
    const previewStyleWrites = vi.fn((_property: string) => {
      previewStyleWriteCount += 1;
    });
    const removeCommand = installBrunoTableGridCommandListener(
      "TABLE_ID_COLUMN_MANAGEMENT_PERFORMANCE",
      (command) => {
        commands.push(command);
      },
    );
    const removeFrames = installBrunoTableClientColumnGestureFrameListener(
      "TABLE_ID_COLUMN_MANAGEMENT_PERFORMANCE",
      (event) => {
        gestureFrames.push(event);
      },
    );
    const removeColumnCommandNotifications = installBrunoTableColumnCommandSubscriptionListener(
      "TABLE_ID_COLUMN_MANAGEMENT_PERFORMANCE",
      (event) => {
        columnCommandNotifications.push(event);
      },
    );
    const removeView = installBrunoTableClientViewRenderListenerForTable(
      "TABLE_ID_COLUMN_MANAGEMENT_PERFORMANCE",
      viewRenders,
    );
    const removeGridSurface = installBrunoTableClientGridSurfaceRenderListenerForTable(
      "TABLE_ID_COLUMN_MANAGEMENT_PERFORMANCE",
      gridSurfaceRenders,
    );
    const removeRowOrderPlans = installBrunoTableClientRowOrderPlanningListenerForTable(
      "TABLE_ID_COLUMN_MANAGEMENT_PERFORMANCE",
      rowOrderPlans,
    );
    const removeRows = installBrunoTableClientRowRenderListenerForTable(
      "TABLE_ID_COLUMN_MANAGEMENT_PERFORMANCE",
      rowRenders,
    );
    const removeCells = installBrunoTableClientCellRenderListenerForTable(
      "TABLE_ID_COLUMN_MANAGEMENT_PERFORMANCE",
      cellRenders,
    );
    const removePreviewStyleWrites =
      installBrunoTableClientColumnPreviewStyleWriteListener(previewStyleWrites);

    try {
      const screen = await render(
        <div style={{ width: 1024 }}>
          <BrunoTableClient<Row, typeof performanceColumns>
            tableId="TABLE_ID_COLUMN_MANAGEMENT_PERFORMANCE"
            getRowId={(row: Row) => row.id}
            columns={performanceColumns}
            initialOrderBy={tableProps.initialOrderBy}
            clientSource={performanceSource}
          >
            <BrunoTableToolbar>
              <ColumnManagementToolbarProbe onRender={toolbarRenders} />
            </BrunoTableToolbar>
          </BrunoTableClient>
        </div>,
      );
      const grid = screen.getByRole("grid").element();
      viewRenders.mockClear();
      gridSurfaceRenders.mockClear();
      rowOrderPlans.mockClear();
      rowRenders.mockClear();
      toolbarRenders.mockClear();
      cellRenders.mockClear();
      columnCommandNotifications.splice(0);
      previewStyleWrites.mockClear();

      const flushGestureFrame = async (
        maxStyleWrites: number,
        expectedCommandCount = 0,
      ): Promise<void> => {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        expect(commands).toHaveLength(expectedCommandCount);
        expect(rowRenders).not.toHaveBeenCalled();
        expect(toolbarRenders).not.toHaveBeenCalled();
        expect(previewStyleWrites.mock.calls.length).toBeGreaterThan(0);
        expect(previewStyleWrites.mock.calls.length).toBeLessThanOrEqual(maxStyleWrites);
        previewStyleWrites.mockClear();
      };

      const resizeHandle = screen.getByRole("separator", { name: "Resize Name" }).element();
      resizeHandle.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: 100,
          pointerId: 31,
        }),
      );
      previewStyleWrites.mockClear();
      for (const clientX of [110, 120, 130, 140]) {
        window.dispatchEvent(
          new PointerEvent("pointermove", { bubbles: true, clientX, pointerId: 31 }),
        );
        await flushGestureFrame(6);
      }
      expect(commands).toHaveLength(0);
      window.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, clientX: 140, pointerId: 31 }),
      );
      await vi.waitFor(() => expect(commands).toHaveLength(1));
      expectTypedCommand(commands[0], {
        type: "column.resize.commit",
        columnId: "COL_ID_NAME",
        width: 200,
      });
      await expect
        .element(screen.getByRole("separator", { name: "Resize Name" }))
        .toHaveAttribute("aria-valuenow", "200");
      expect(previewStyleWriteCount).toBeGreaterThan(0);
      await waitForAnimationFrames();
      rowRenders.mockClear();
      toolbarRenders.mockClear();

      previewStyleWrites.mockClear();
      const reorderHandle = screen.getByRole("button", { name: "Reorder Status" }).element();
      reorderHandle.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: 100,
          pointerId: 32,
        }),
      );
      previewStyleWrites.mockClear();
      for (const clientX of [105, 110, 115]) {
        window.dispatchEvent(
          new PointerEvent("pointermove", { bubbles: true, clientX, pointerId: 32 }),
        );
        await flushGestureFrame(24, 1);
      }
      expect(commands).toHaveLength(1);
      previewStyleWrites.mockClear();
      window.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, clientX: 100, pointerId: 32 }),
      );
      expect(previewStyleWrites.mock.calls.length).toBeGreaterThan(0);
      expect(previewStyleWrites.mock.calls.length).toBeLessThanOrEqual(24);
      await vi.waitFor(() => expect(commands).toHaveLength(2));
      expectTypedCommand(commands[1], {
        type: "column.reorder.commit",
        columnId: "COL_ID_STATUS",
        targetIndex: 1,
        pinned: undefined,
      });
      await vi.waitFor(() =>
        expect(columnOrder(grid).slice(0, 3)).toEqual([
          "COL_ID_PERF_PIN_START",
          "COL_ID_STATUS",
          "COL_ID_NAME",
        ]),
      );
      await waitForAnimationFrames();

      const frameDurations = gestureFrames.flatMap((event) =>
        event.phase === "ran" && event.durationMs !== undefined ? [event.durationMs] : [],
      );
      expect(frameDurations).toHaveLength(7);
      expect(frameDurations.every((duration) => Number.isFinite(duration) && duration >= 0)).toBe(
        true,
      );
      const synchronousDurations = gestureFrames.flatMap((event) =>
        event.phase === "synchronous" && event.durationMs !== undefined ? [event.durationMs] : [],
      );
      expect(synchronousDurations).toHaveLength(1);
      expect(
        synchronousDurations.every((duration) => Number.isFinite(duration) && duration >= 0),
      ).toBe(true);
      expect(gestureFrames.find((event) => event.phase === "synchronous")?.frameId).toBeUndefined();
      const observedDurations = [...frameDurations, ...synchronousDurations];
      const observedMax = Math.max(...observedDurations);
      console.info(
        JSON.stringify({
          benchmark: "BrunoTable many-column pointer gestures",
          columns: performanceColumns.length,
          referenceFrameBudgetMs: 8.33,
          observedFrameDurationsMs: frameDurations,
          observedSynchronousDurationsMs: synchronousDurations,
          observedMaxMs: observedMax,
        }),
      );

      for (const [kind, expectedFrames] of [
        ["resize", 4],
        ["reorder", 3],
      ] as const) {
        expect(
          gestureFrames.filter((event) => event.phase === "scheduled" && event.kind === kind)
            .length,
        ).toBe(expectedFrames);
        expect(
          gestureFrames.filter((event) => event.phase === "ran" && event.kind === kind).length,
        ).toBe(expectedFrames);
      }
      expect(previewStyleWriteCount).toBeGreaterThan(0);
      const mountedBodyRowElements = [
        ...grid.querySelectorAll<HTMLElement>('tbody[role="rowgroup"] > tr[role="row"]'),
      ];
      const mountedBodyRows = mountedBodyRowElements.length;
      const mountedColumnCount = grid.querySelectorAll("thead th[data-bruno-column-id]").length;
      const expectedMountedRows = Math.min(
        performanceRows.length,
        Math.ceil(BRUNO_TABLE_DEFAULT_VIEWPORT_HEIGHT / BRUNO_TABLE_ROW_HEIGHT) + 4,
      );
      const expectedRowIndexes = Array.from({ length: expectedMountedRows }, (_unused, index) =>
        String(index + 2),
      );
      expect(mountedBodyRows).toBe(expectedMountedRows);
      expect(mountedBodyRowElements.map((row) => row.getAttribute("aria-rowindex"))).toEqual(
        expectedRowIndexes,
      );
      expect(mountedColumnCount).toBeGreaterThanOrEqual(columns.length);
      expect(mountedColumnCount).toBeLessThanOrEqual(24);
      expect(grid.querySelector('[data-bruno-pinned-body-region="start"]')).not.toBeNull();
      expect(grid.querySelector('[data-bruno-pinned-body-region="end"]')).not.toBeNull();
      await expect
        .element(grid)
        .toHaveAttribute("aria-colcount", String(performanceColumns.length));
      const expectedPerformanceColumns = [
        performanceColumns[0]!,
        performanceColumns[3]!,
        performanceColumns[1]!,
        performanceColumns[2]!,
        ...performanceColumns.slice(4),
      ];
      assertMountedColumnGeometry(
        grid,
        expectedPerformanceColumns.map((column, index) => ({
          columnId: column.columnId,
          columnIndex: index + 1,
          region: "pinned" in column && column.pinned !== undefined ? column.pinned : "center",
        })),
      );
      assertMountedColumnWindow(
        grid,
        expectedPerformanceColumns.map((column) => column.columnId),
        {
          pinnedStartIds: ["COL_ID_PERF_PIN_START"],
          pinnedEndIds: ["COL_ID_PERF_PIN_END"],
          requiredColumnIds: ["COL_ID_STATUS", "COL_ID_NAME"],
          maxMountedColumnCount: 24,
        },
      );
      expect(columnCommandNotifications).toHaveLength(1);
      expect(columnCommandNotifications[0]?.columnId).toBe("COL_ID_NAME");
      expect(columnCommandNotifications.every((event) => event.listenerCount <= 4)).toBe(true);
      expect(viewRenders.mock.calls.length).toBeLessThanOrEqual(4);
      expect(gridSurfaceRenders.mock.calls.length).toBeLessThanOrEqual(4);
      expect(rowOrderPlans.mock.calls.length).toBeLessThanOrEqual(4);
      expect(rowRenders.mock.calls.length).toBeLessThanOrEqual(expectedMountedRows * 4);
      expect(toolbarRenders).not.toHaveBeenCalled();
      expect(cellRenders.mock.calls.length).toBeLessThanOrEqual(expectedMountedRows * 24 * 8);
    } finally {
      removeCommand();
      removeFrames();
      removeColumnCommandNotifications();
      removeView();
      removeGridSurface();
      removeRowOrderPlans();
      removeRows();
      removeCells();
      removePreviewStyleWrites();
    }
  });

  test("refreshes reorder geometry after edge autoscroll crosses a centre window", async () => {
    const tableId = "TABLE_ID_COLUMN_REORDER_AUTOSCROLL_WINDOW";
    const gridSurfaceRenders = vi.fn();
    const rowOrderPlans = vi.fn();
    const rowRenders = vi.fn();
    const previewStyleWrites = vi.fn();
    const removeGridSurface = installBrunoTableClientGridSurfaceRenderListenerForTable(
      tableId,
      gridSurfaceRenders,
    );
    const removeRowOrderPlans = installBrunoTableClientRowOrderPlanningListenerForTable(
      tableId,
      rowOrderPlans,
    );
    const removeRows = installBrunoTableClientRowRenderListenerForTable(tableId, rowRenders);
    const removePreviewStyleWrites =
      installBrunoTableClientColumnPreviewStyleWriteListener(previewStyleWrites);
    try {
      const screen = await render(
        <div style={{ width: 480 }}>
          <BrunoTableClient<Row, typeof performanceColumns>
            tableId={tableId}
            getRowId={(row: Row) => row.id}
            columns={performanceColumns}
            initialOrderBy={tableProps.initialOrderBy}
            clientSource={performanceSource}
          />
        </div>,
      );
      const grid = screen.getByRole("grid", { name: `Data for ${tableId}` }).element();
      const mountedCenterHeaders = () =>
        [
          ...grid.querySelectorAll<HTMLElement>(
            "thead th[data-bruno-column-id]:not([data-pinned-region])",
          ),
        ].filter((header) => header.dataset["brunoColumnId"] !== undefined);
      const initialMountedIds = new Set(
        mountedCenterHeaders().map((header) => header.dataset["brunoColumnId"]!),
      );
      const reorderHandle = screen.getByRole("button", { name: "Reorder Name" }).element();
      const pinnedEndHeader = grid.querySelector<HTMLElement>('thead th[data-pinned-region="end"]');
      expect(pinnedEndHeader).not.toBeNull();
      const startX = reorderHandle.getBoundingClientRect().left + 2;
      reorderHandle.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: startX,
          pointerId: 39,
        }),
      );
      gridSurfaceRenders.mockClear();
      rowOrderPlans.mockClear();
      rowRenders.mockClear();
      previewStyleWrites.mockClear();
      window.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: pinnedEndHeader!.getBoundingClientRect().left - 2,
          pointerId: 39,
        }),
      );

      let enteringHeader: HTMLElement | undefined;
      for (let frame = 0; frame < 30 && enteringHeader === undefined; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        enteringHeader = mountedCenterHeaders().find(
          (header) => !initialMountedIds.has(header.dataset["brunoColumnId"]!),
        );
      }
      expect(grid.scrollLeft).toBeGreaterThan(0);
      expect(enteringHeader).not.toBeUndefined();
      const enteringId = enteringHeader!.dataset["brunoColumnId"]!;
      const enteringRect = enteringHeader!.getBoundingClientRect();
      window.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: enteringRect.left + enteringRect.width / 4,
          pointerId: 39,
        }),
      );

      await vi.waitFor(() => {
        expect(previewStyleWrites).toHaveBeenCalledWith(
          brunoTableColumnCssVariable("transform", enteringId),
        );
      });
      expect(gridSurfaceRenders).not.toHaveBeenCalled();
      expect(rowOrderPlans).not.toHaveBeenCalled();
      expect(rowRenders).not.toHaveBeenCalled();

      window.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 39 }));
      await vi.waitFor(() => expect(grid.querySelector("[data-bruno-reorder-target]")).toBeNull());
    } finally {
      removePreviewStyleWrites();
      removeRows();
      removeRowOrderPlans();
      removeGridSurface();
    }
  });

  test("commits the final rightward reorder before the next frame and cancels on Escape", async () => {
    const reorderFrames = vi.fn();
    const removeReorder = installBrunoTableClientColumnReorderFrameListener(reorderFrames);
    try {
      const screen = await render(<BrunoTableClient<Row, typeof columns> {...tableProps} />);
      const grid = screen.getByRole("grid").element();
      const columnOrder = () =>
        [...grid.querySelectorAll<HTMLElement>("th[data-bruno-column-id]")].map(
          (header) => header.dataset["brunoColumnId"],
        );
      const nameHandle = screen.getByRole("button", { name: "Reorder Name" }).element();
      const scoreHeader = screen.getByRole("columnheader", { name: /Score/u }).element();
      const scoreRect = scoreHeader.getBoundingClientRect();
      const startX = nameHandle.getBoundingClientRect().left + 1;
      const dropX = Math.max(scoreRect.right + 40, startX + 240);

      nameHandle.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: startX,
          pointerId: 9,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: dropX,
          pointerId: 9,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          clientX: dropX,
          pointerId: 9,
        }),
      );
      await vi.waitFor(() =>
        expect(columnOrder()).toEqual(["COL_ID_SCORE", "COL_ID_STATUS", "COL_ID_NAME"]),
      );
      expect(reorderFrames).toHaveBeenCalledTimes(1);

      const statusHandle = screen.getByRole("button", { name: "Reorder Status" }).element();
      statusHandle.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: 100,
          pointerId: 10,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: 0,
          pointerId: 10,
        }),
      );
      grid.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(columnOrder()).toEqual(["COL_ID_SCORE", "COL_ID_STATUS", "COL_ID_NAME"]);
      expect(grid.querySelector("[data-bruno-reorder-target]")).toBeNull();
    } finally {
      removeReorder();
    }
  });

  test("cancels an active column gesture for every modified grid Escape", async () => {
    const screen = await render(<BrunoTableClient<Row, typeof columns> {...tableProps} />);
    const statusHandle = screen.getByRole("button", { name: "Reorder Status" }).element();
    const grid = screen.getByRole("grid").element();
    const statusHeader = screen.getByRole("columnheader", { name: /Status/u }).element();

    for (let modifiers = 0; modifiers < 16; modifiers += 1) {
      const pointerId = 20 + modifiers;
      statusHandle.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: 100,
          pointerId,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: 0,
          pointerId,
        }),
      );
      grid.focus();
      const escape = new KeyboardEvent("keydown", {
        altKey: (modifiers & 1) !== 0,
        bubbles: true,
        cancelable: true,
        ctrlKey: (modifiers & 2) !== 0,
        key: "Escape",
        metaKey: (modifiers & 4) !== 0,
        shiftKey: (modifiers & 8) !== 0,
      });
      grid.dispatchEvent(escape);
      window.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          clientX: 0,
          pointerId,
        }),
      );

      await new Promise(requestAnimationFrame);
      expect(escape.defaultPrevented).toBe(true);
      expect(statusHeader).toHaveAttribute("aria-colindex", "3");
    }
  });

  test("cancels only the active table gesture when two tables share the document target", async () => {
    const ownerTableId = "TABLE_ID_COLUMN_GESTURE_CAPTURE_OWNER";
    const inactiveTableId = "TABLE_ID_COLUMN_GESTURE_CAPTURE_INACTIVE";
    const ownerEvents: ColumnGestureListenerEvent[] = [];
    const inactiveEvents: ColumnGestureListenerEvent[] = [];
    const removeOwnerListener = installBrunoTableClientColumnGestureListener(
      ownerTableId,
      (event) => ownerEvents.push(event),
    );
    const removeInactiveListener = installBrunoTableClientColumnGestureListener(
      inactiveTableId,
      (event) => inactiveEvents.push(event),
    );
    try {
      const screen = await render(
        <>
          <BrunoTableClient<Row, typeof columns> {...tableProps} tableId={ownerTableId} />
          <BrunoTableClient<Row, typeof columns> {...tableProps} tableId={inactiveTableId} />
          <input aria-label="Outside gesture focus destination" />
        </>,
      );
      const ownerRegion = screen.getByRole("region", { name: ownerTableId, exact: true });
      const inactiveRegion = screen.getByRole("region", { name: inactiveTableId, exact: true });
      const ownerHandle = ownerRegion.getByRole("button", { name: "Reorder Status" }).element();
      const ownerHeader = ownerRegion.getByRole("columnheader", { name: /Status/u }).element();
      const ownerGrid = ownerRegion.getByRole("grid").element();
      const focusGrid = vi.spyOn(ownerGrid, "focus");
      const inactiveHeader = inactiveRegion
        .getByRole("columnheader", { name: /Status/u })
        .element();
      const destination = screen
        .getByRole("textbox", { name: "Outside gesture focus destination" })
        .element();

      ownerHandle.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: 100,
          pointerId: 79,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: 0,
          pointerId: 79,
        }),
      );
      destination.focus();
      focusGrid.mockClear();
      const escape = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        key: "Escape",
        shiftKey: true,
      });
      destination.dispatchEvent(escape);
      window.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, clientX: 0, pointerId: 79 }),
      );

      await new Promise(requestAnimationFrame);
      expect(escape.defaultPrevented).toBe(true);
      expect(focusGrid).not.toHaveBeenCalled();
      expect(ownerHeader).toHaveAttribute("aria-colindex", "3");
      expect(inactiveHeader).toHaveAttribute("aria-colindex", "3");
      expect(ownerEvents.filter((event) => event.phase === "attach")).toHaveLength(3);
      expect(ownerEvents.filter((event) => event.phase === "detach")).toHaveLength(3);
      expect(inactiveEvents).toEqual([]);
    } finally {
      removeOwnerListener();
      removeInactiveListener();
    }
  });

  test("detaches global gesture listeners after repeated committed gestures", async () => {
    const tableId = "TABLE_ID_COLUMN_MANAGEMENT_GESTURE_CYCLES";
    const commands: BrunoTableGridCommand[] = [];
    const gestureListeners: ColumnGestureListenerEvent[] = [];
    const removeCommand = installBrunoTableGridCommandListener(tableId, (command) => {
      commands.push(command);
    });
    const removeListeners = installBrunoTableClientColumnGestureListener(tableId, (event) => {
      gestureListeners.push(event);
    });

    try {
      const screen = await render(
        <BrunoTableClient<Row, typeof columns> {...tableProps} tableId={tableId} />,
      );
      const resizeHandle = screen.getByRole("separator", { name: "Resize Name" }).element();
      resizeHandle.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: 100,
          pointerId: 40,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, clientX: 120, pointerId: 40 }),
      );
      await new Promise((resolve) => requestAnimationFrame(resolve));
      window.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, clientX: 120, pointerId: 40 }),
      );
      await vi.waitFor(() => expect(commands).toHaveLength(1));

      const reorderHandle = screen.getByRole("button", { name: "Reorder Status" }).element();
      reorderHandle.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: 100,
          pointerId: 41,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, clientX: 0, pointerId: 41 }),
      );
      await new Promise((resolve) => requestAnimationFrame(resolve));
      window.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, clientX: 0, pointerId: 41 }),
      );
      await vi.waitFor(() => expect(commands).toHaveLength(2));

      for (const event of ["pointermove", "pointerup", "pointercancel"] as const) {
        expect(
          gestureListeners.filter((entry) => entry.phase === "attach" && entry.event === event),
        ).toHaveLength(2);
        expect(
          gestureListeners.filter((entry) => entry.phase === "detach" && entry.event === event),
        ).toHaveLength(2);
      }
      window.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, clientX: 300, pointerId: 40 }),
      );
      window.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, clientX: 300, pointerId: 41 }),
      );
      expect(commands).toHaveLength(2);
    } finally {
      removeCommand();
      removeListeners();
    }
  });

  test("keeps a column gesture alive across same-shape live row publication", async () => {
    const screen = await render(<BrunoTableClient<Row, typeof columns> {...tableProps} />);
    const grid = screen.getByRole("grid").element();
    const statusHandle = screen.getByRole("button", { name: "Reorder Status" }).element();
    statusHandle.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 100,
        pointerId: 11,
      }),
    );
    window.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        clientX: 0,
        pointerId: 11,
      }),
    );
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(grid.querySelector("[data-bruno-reorder-target]")).not.toBeNull();

    await screen.rerender(
      <BrunoTableClient<Row, typeof columns>
        {...tableProps}
        clientSource={{ ...source, version: 2, rows: [...rows] }}
      />,
    );
    expect(grid.querySelector("[data-bruno-reorder-target]")).not.toBeNull();
    window.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        clientX: 0,
        pointerId: 11,
      }),
    );
    await vi.waitFor(() =>
      expect(
        [...grid.querySelectorAll<HTMLElement>("th[data-bruno-column-id]")].map(
          (header) => header.dataset["brunoColumnId"],
        ),
      ).toEqual(["COL_ID_STATUS", "COL_ID_NAME", "COL_ID_SCORE"]),
    );
  });

  test("opens the keyboard menu for an active header that scrolled out of the mounted window", async () => {
    const screen = await render(
      <div style={{ width: 480 }}>
        <BrunoTableClient<Row, typeof manyColumns>
          tableId="TABLE_ID_COLUMN_MANAGEMENT_OFFSCREEN"
          getRowId={(row: Row) => row.id}
          columns={manyColumns}
          initialOrderBy={[{ columnId: "COL_ID_SCORE", direction: "asc" }]}
          clientSource={source}
        />
      </div>,
    );
    const grid = screen
      .getByRole("grid", { name: "Data for TABLE_ID_COLUMN_MANAGEMENT_OFFSCREEN" })
      .element();
    const sortButton = screen.getByRole("button", { name: "Sort by Name" }).element();
    sortButton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
    );
    grid.scrollLeft = 1_000;
    grid.dispatchEvent(new Event("scroll", { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    await expect.element(screen.getByRole("menuitem", { name: "Move" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => {
      const activeElement = document.activeElement;
      const activeHeaderMenuTrigger = grid.querySelector<HTMLButtonElement>(
        '[data-bruno-active-header-menu-trigger=""]',
      );
      if (activeElement !== activeHeaderMenuTrigger) {
        throw new Error(
          `Unexpected active element: ${activeElement?.outerHTML ?? "none"}; proxy=${activeHeaderMenuTrigger?.outerHTML ?? "none"}`,
        );
      }
    });
  });

  test("restores focus to the reordered column after its header virtualizes out", async () => {
    const screen = await render(
      <BrunoTableClient<Row, typeof manyColumns>
        tableId="TABLE_ID_COLUMN_MANAGEMENT_REORDER_FOCUS"
        getRowId={(row: Row) => row.id}
        columns={manyColumns}
        initialOrderBy={[{ columnId: "COL_ID_SCORE", direction: "asc" }]}
        clientSource={source}
      />,
    );
    const grid = screen.getByRole("grid").element();
    const reorderHandle = screen.getByRole("button", { name: "Reorder Name" }).element();
    const startX = reorderHandle.getBoundingClientRect().left + 1;
    reorderHandle.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: startX,
        pointerId: 22,
      }),
    );
    grid.scrollLeft = 1_000;
    grid.dispatchEvent(new Event("scroll", { bubbles: true }));
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
    );
    window.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        clientX: grid.getBoundingClientRect().right - 2,
        pointerId: 22,
      }),
    );

    await vi.waitFor(() =>
      expect(document.activeElement?.getAttribute("aria-label")).toBe("Column menu for Name"),
    );
    expect(grid.contains(document.activeElement)).toBe(true);
  });

  test("bounds reordered-column focus retries when the committed header stays unmounted", async () => {
    const screen = await render(
      <BrunoTableClient<Row, typeof manyColumns>
        tableId="TABLE_ID_COLUMN_MANAGEMENT_REORDER_FOCUS_BUDGET"
        getRowId={(row: Row) => row.id}
        columns={manyColumns}
        initialOrderBy={[{ columnId: "COL_ID_SCORE", direction: "asc" }]}
        clientSource={source}
      />,
    );
    const grid = screen.getByRole("grid").element();
    const reorderHandle = screen.getByRole("button", { name: "Reorder Name" }).element();
    const startX = reorderHandle.getBoundingClientRect().left + 1;
    const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    const nativeQuerySelectorAll = grid.querySelectorAll.bind(grid);
    let hideReorderedHeader = false;
    let scheduledAfterCommit = 0;
    const querySelectorAll = vi.spyOn(grid, "querySelectorAll").mockImplementation((selectors) => {
      if (hideReorderedHeader && selectors === "th[data-bruno-column-id]") {
        return [] as unknown as NodeListOf<Element>;
      }
      return nativeQuerySelectorAll(selectors);
    });
    const requestAnimationFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        if (hideReorderedHeader) scheduledAfterCommit += 1;
        return nativeRequestAnimationFrame(callback);
      });

    try {
      reorderHandle.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: startX,
          pointerId: 23,
        }),
      );
      grid.scrollLeft = 1_000;
      grid.dispatchEvent(new Event("scroll", { bubbles: true }));
      await new Promise<void>((resolve) =>
        nativeRequestAnimationFrame(() =>
          nativeRequestAnimationFrame(() => nativeRequestAnimationFrame(() => resolve())),
        ),
      );
      window.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          clientX: grid.getBoundingClientRect().right - 2,
          pointerId: 23,
        }),
      );
      hideReorderedHeader = true;

      for (let frame = 0; frame < 8; frame += 1) {
        await new Promise<void>((resolve) => nativeRequestAnimationFrame(() => resolve()));
      }
      const settledRequestCount = scheduledAfterCommit;
      for (let frame = 0; frame < 3; frame += 1) {
        await new Promise<void>((resolve) => nativeRequestAnimationFrame(() => resolve()));
      }

      expect(document.activeElement).toBe(grid);
      expect(scheduledAfterCommit).toBe(settledRequestCount);
    } finally {
      requestAnimationFrame.mockRestore();
      querySelectorAll.mockRestore();
    }
  });

  test("does not steal external focus while a reordered header remains unmounted", async () => {
    const screen = await render(
      <BrunoTableClient<Row, typeof manyColumns>
        tableId="TABLE_ID_COLUMN_MANAGEMENT_REORDER_EXTERNAL_FOCUS"
        getRowId={(row: Row) => row.id}
        columns={manyColumns}
        initialOrderBy={[{ columnId: "COL_ID_SCORE", direction: "asc" }]}
        clientSource={source}
      />,
    );
    const grid = screen.getByRole("grid").element();
    const reorderHandle = screen.getByRole("button", { name: "Reorder Name" }).element();
    const external = document.createElement("button");
    external.type = "button";
    external.textContent = "External focus destination";
    document.body.append(external);
    const startX = reorderHandle.getBoundingClientRect().left + 1;
    const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    const nativeQuerySelectorAll = grid.querySelectorAll.bind(grid);
    let hideReorderedHeader = false;
    let scheduledAfterCommit = 0;
    const querySelectorAll = vi.spyOn(grid, "querySelectorAll").mockImplementation((selectors) => {
      if (hideReorderedHeader && selectors === "th[data-bruno-column-id]") {
        return [] as unknown as NodeListOf<Element>;
      }
      return nativeQuerySelectorAll(selectors);
    });
    const requestAnimationFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        if (hideReorderedHeader) scheduledAfterCommit += 1;
        return nativeRequestAnimationFrame(callback);
      });

    try {
      reorderHandle.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: startX,
          pointerId: 24,
        }),
      );
      grid.scrollLeft = 1_000;
      grid.dispatchEvent(new Event("scroll", { bubbles: true }));
      await new Promise<void>((resolve) =>
        nativeRequestAnimationFrame(() =>
          nativeRequestAnimationFrame(() => nativeRequestAnimationFrame(() => resolve())),
        ),
      );
      window.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          clientX: grid.getBoundingClientRect().right - 2,
          pointerId: 24,
        }),
      );
      hideReorderedHeader = true;
      external.focus();

      for (let frame = 0; frame < 8; frame += 1) {
        await new Promise<void>((resolve) => nativeRequestAnimationFrame(() => resolve()));
      }
      const settledRequestCount = scheduledAfterCommit;
      for (let frame = 0; frame < 3; frame += 1) {
        await new Promise<void>((resolve) => nativeRequestAnimationFrame(() => resolve()));
      }

      expect(document.activeElement).toBe(external);
      expect(scheduledAfterCommit).toBe(settledRequestCount);
    } finally {
      requestAnimationFrame.mockRestore();
      querySelectorAll.mockRestore();
      external.remove();
    }
  });

  test("cancels a reorder on pointercancel without committing or leaving a preview", async () => {
    const commands: BrunoTableGridCommand[] = [];
    const gestureFrames: ColumnGestureFrameEvent[] = [];
    const removeCommand = installBrunoTableGridCommandListener(tableProps.tableId, (command) => {
      commands.push(command);
    });
    const removeFrames = installBrunoTableClientColumnGestureFrameListener(
      tableProps.tableId,
      (event) => {
        gestureFrames.push(event);
      },
    );

    try {
      const screen = await render(<BrunoTableClient<Row, typeof columns> {...tableProps} />);
      const grid = screen.getByRole("grid").element();
      const initialOrder = columnOrder(grid);
      const reorderHandle = screen.getByRole("button", { name: "Reorder Status" }).element();
      reorderHandle.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: 100,
          pointerId: 17,
        }),
      );
      for (const clientX of [80, 40, 0]) {
        window.dispatchEvent(
          new PointerEvent("pointermove", { bubbles: true, clientX, pointerId: 17 }),
        );
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(grid.querySelector("[data-bruno-reorder-target]")).not.toBeNull();

      window.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 17 }));
      await vi.waitFor(() => expect(columnOrder(grid)).toEqual(initialOrder));
      expect(commands).toHaveLength(0);
      expect(grid.querySelector("[data-bruno-reorder-target]")).toBeNull();
      expect(
        gestureFrames.filter((event) => event.phase === "scheduled" && event.kind === "reorder"),
      ).toHaveLength(1);
      expect(
        gestureFrames.filter((event) => event.phase === "ran" && event.kind === "reorder"),
      ).toHaveLength(1);
    } finally {
      removeCommand();
      removeFrames();
    }
  });

  test("proves pointer resize teardown cancels frames, detaches listeners, and commits nothing", async () => {
    const commands: BrunoTableGridCommand[] = [];
    const gestureFrames: ColumnGestureFrameEvent[] = [];
    const gestureListeners: ColumnGestureListenerEvent[] = [];
    const removeCommand = installBrunoTableGridCommandListener(tableProps.tableId, (command) => {
      commands.push(command);
    });
    const removeFrames = installBrunoTableClientColumnGestureFrameListener(
      tableProps.tableId,
      (event) => {
        gestureFrames.push(event);
      },
    );
    const removeListeners = installBrunoTableClientColumnGestureListener(
      tableProps.tableId,
      (event) => {
        gestureListeners.push(event);
      },
    );
    const pendingFrames = new Set<number>();
    let nextFrameId = 10_000;

    try {
      const screen = await render(<BrunoTableClient<Row, typeof columns> {...tableProps} />);
      const addListener = vi.spyOn(window, "addEventListener");
      const removeListener = vi.spyOn(window, "removeEventListener");
      const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => {
        const frameId = nextFrameId++;
        pendingFrames.add(frameId);
        return frameId;
      });
      const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frameId) => {
        pendingFrames.delete(frameId);
      });
      const resizeHandle = screen.getByRole("separator", { name: "Resize Name" }).element();
      resizeHandle.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: 100,
          pointerId: 18,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, clientX: 180, pointerId: 18 }),
      );

      expect(requestFrame).toHaveBeenCalled();
      const scheduled = gestureFrames.filter(
        (event) => event.phase === "scheduled" && event.kind === "resize",
      );
      expect(scheduled).toHaveLength(1);
      expect(pendingFrames).toHaveProperty("size", 1);

      await screen.rerender(<></>);
      expect(pendingFrames).toHaveProperty("size", 0);
      expect(
        gestureFrames.filter((event) => event.phase === "cancelled" && event.kind === "resize"),
      ).toHaveLength(1);
      expect(gestureFrames.filter((event) => event.phase === "ran")).toHaveLength(0);
      expect(cancelFrame).toHaveBeenCalled();

      const events = ["pointermove", "pointerup", "pointercancel"] as const;
      const relevantAdds = addListener.mock.calls.filter(
        ([event, _handler, options]) =>
          events.includes(event as (typeof events)[number]) && options === true,
      );
      expect(relevantAdds).toHaveLength(events.length);
      const attachedHandlers = new Map(
        relevantAdds.map(([event, handler]) => [event as string, handler]),
      );
      for (const event of events) {
        expect(relevantAdds.filter(([addedEvent]) => addedEvent === event)).toHaveLength(1);
        expect(
          gestureListeners.filter((entry) => entry.phase === "attach" && entry.event === event),
        ).toHaveLength(1);
        expect(
          gestureListeners.filter((entry) => entry.phase === "detach" && entry.event === event),
        ).toHaveLength(1);
        const matchingRemovals = removeListener.mock.calls.filter(
          ([removedEvent, removedHandler, options]) =>
            removedEvent === event &&
            removedHandler === attachedHandlers.get(event) &&
            options === true,
        );
        expect(matchingRemovals).toHaveLength(1);
      }
      expect(
        removeListener.mock.calls.filter(
          ([event, _handler, options]) =>
            events.includes(event as (typeof events)[number]) && options === true,
        ),
      ).toHaveLength(events.length);

      window.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, clientX: 180, pointerId: 18 }),
      );
      await Promise.resolve();
      expect(commands).toHaveLength(0);
      expect(document.querySelector('[role="grid"]')).toBeNull();
    } finally {
      removeCommand();
      removeFrames();
      removeListeners();
    }
  });

  test("proves pointer reorder teardown cancels frames, detaches listeners, and commits nothing", async () => {
    const commands: BrunoTableGridCommand[] = [];
    const gestureFrames: ColumnGestureFrameEvent[] = [];
    const gestureListeners: ColumnGestureListenerEvent[] = [];
    const removeCommand = installBrunoTableGridCommandListener(tableProps.tableId, (command) => {
      commands.push(command);
    });
    const removeFrames = installBrunoTableClientColumnGestureFrameListener(
      tableProps.tableId,
      (event) => {
        gestureFrames.push(event);
      },
    );
    const removeListeners = installBrunoTableClientColumnGestureListener(
      tableProps.tableId,
      (event) => {
        gestureListeners.push(event);
      },
    );
    const pendingFrames = new Set<number>();
    let nextFrameId = 20_000;

    try {
      const screen = await render(<BrunoTableClient<Row, typeof columns> {...tableProps} />);
      const addListener = vi.spyOn(window, "addEventListener");
      const removeListener = vi.spyOn(window, "removeEventListener");
      const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => {
        const frameId = nextFrameId++;
        pendingFrames.add(frameId);
        return frameId;
      });
      const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frameId) => {
        pendingFrames.delete(frameId);
      });
      const reorderHandle = screen.getByRole("button", { name: "Reorder Status" }).element();
      reorderHandle.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: 100,
          pointerId: 20,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, clientX: 0, pointerId: 20 }),
      );

      expect(requestFrame).toHaveBeenCalled();
      expect(
        gestureFrames.filter((event) => event.phase === "scheduled" && event.kind === "reorder"),
      ).toHaveLength(1);
      expect(pendingFrames).toHaveProperty("size", 1);

      await screen.rerender(<></>);
      expect(pendingFrames).toHaveProperty("size", 0);
      expect(
        gestureFrames.filter((event) => event.phase === "cancelled" && event.kind === "reorder"),
      ).toHaveLength(1);
      expect(gestureFrames.filter((event) => event.phase === "ran")).toHaveLength(0);
      expect(cancelFrame).toHaveBeenCalled();

      const events = ["pointermove", "pointerup", "pointercancel"] as const;
      const relevantAdds = addListener.mock.calls.filter(
        ([event, _handler, options]) =>
          events.includes(event as (typeof events)[number]) && options === true,
      );
      expect(relevantAdds).toHaveLength(events.length);
      const attachedHandlers = new Map(
        relevantAdds.map(([event, handler]) => [event as string, handler]),
      );
      for (const event of events) {
        expect(relevantAdds.filter(([addedEvent]) => addedEvent === event)).toHaveLength(1);
        expect(
          gestureListeners.filter((entry) => entry.phase === "attach" && entry.event === event),
        ).toHaveLength(1);
        expect(
          gestureListeners.filter((entry) => entry.phase === "detach" && entry.event === event),
        ).toHaveLength(1);
        const matchingRemovals = removeListener.mock.calls.filter(
          ([removedEvent, removedHandler, options]) =>
            removedEvent === event &&
            removedHandler === attachedHandlers.get(event) &&
            options === true,
        );
        expect(matchingRemovals).toHaveLength(1);
      }
      expect(
        removeListener.mock.calls.filter(
          ([event, _handler, options]) =>
            events.includes(event as (typeof events)[number]) && options === true,
        ),
      ).toHaveLength(events.length);

      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 20 }));
      await Promise.resolve();
      expect(commands).toHaveLength(0);
      expect(document.querySelector('[role="grid"]')).toBeNull();
    } finally {
      removeCommand();
      removeFrames();
      removeListeners();
    }
  });
});
