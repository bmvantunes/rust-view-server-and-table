import { expect, test, vi } from "vite-plus/test";
import { detectPlatform } from "@tanstack/react-hotkeys";
import { cdp, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import type { CDPSession as PlaywrightCDPSession } from "@vitest/browser-playwright";
import { StrictMode } from "react";

import {
  BrunoTableClient,
  BrunoTableComputedColumn,
  BrunoTableQuickFilter,
  BrunoTableToolbar,
} from "./index";
import { useBrunoTableClientFilterContext } from "./internal/client-filter-context";
import { BrunoTableClientRowPipeline } from "./internal/client-row-pipeline";
import { BrunoTableClientRowPipelineAdapter } from "./internal/client-source-adapter";
import { BrunoTableCellEditRuntime } from "./internal/cell-edit";
import { createBrunoTableClientEditCapability } from "./internal/client-edit-capability";
import { BrunoTableToolbarStore, BrunoTableView } from "./internal/bruno-table-view";
import { compileColumns } from "./internal/compile-columns";
import { installBrunoTableGridCommandListener } from "./internal/grid-command-instrumentation";
import {
  BrunoTableConflictReviewResolution,
  BrunoTableEditSafetyFooter,
} from "./internal/edit-chrome";
import { BrunoTableEditMemoryRuntime } from "./internal/edit-memory";
import { BrunoTableGridRuntime } from "./internal/grid-runtime";
import type { BrunoTableColumns, BrunoTableValueType } from "./public-types";

type Row = Readonly<{
  readonly id: string;
  readonly name: string;
  readonly revision: bigint;
}>;

const columns = [
  {
    columnId: "COL_ID_NAME",
    field: "name",
    headerName: "Name",
    valueType: "text",
    isEditable: true,
  },
] satisfies BrunoTableColumns<Row>;

const rows = [{ id: "ada", name: "Ada", revision: 1n }] as const;

function scrollReviewGridToEnd(reviewGrid: { readonly element: () => Element }): void {
  const element = reviewGrid.element() as HTMLElement;
  element.scrollLeft = element.scrollWidth;
}

test("uses one tracked control subscription for each Conflict Review Resolution cell", async () => {
  let row: Row = rows[0];
  const cellEdit = new BrunoTableCellEditRuntime({
    columns: compileColumns(columns),
    getRow: () => row,
    getRowVersion: (candidate) => (candidate as Row).revision,
  });
  const editMemory = new BrunoTableEditMemoryRuntime();
  cellEdit.activate();
  editMemory.activate();
  const disconnect = editMemory.connectCellEdit(cellEdit);
  const getControlStoreCount = (): number =>
    (
      editMemory as unknown as {
        readonly conflictResolutionControlStores: ReadonlyMap<string, unknown>;
      }
    ).conflictResolutionControlStores.size;

  try {
    expect(editMemory.requestMode("batch")).toBe(true);
    expect(
      cellEdit.applyAcceptedDraftGesture([
        {
          rowId: row.id,
          columnId: "COL_ID_NAME",
          field: "name",
          baseRow: row,
          expectedVersion: row.revision,
          base: row.name,
          mine: "Augusta",
          conflict: { server: "Server", serverVersion: 2n },
        },
      ]),
    ).toBe(true);
    row = Object.freeze({ ...row, name: "Server", revision: 2n });
    cellEdit.reconcileSourceRows(new Set([row.id]));
    expect(editMemory.openConflictReview()).toBe(true);
    const reviewRow = editMemory.getConflictReviewRowsSnapshot()[0];
    expect(reviewRow).toBeDefined();
    expect(getControlStoreCount()).toBe(0);

    const resolution = await render(
      <BrunoTableConflictReviewResolution
        row={reviewRow!}
        runtime={editMemory}
        resolve={(id, choice) => {
          editMemory.resolveConflictRows([id], choice);
        }}
      />,
    );
    await vi.waitFor(() => expect(getControlStoreCount()).toBe(1), { interval: 1 });
    await expect
      .element(resolution.getByRole("group", { name: "Conflict resolution" }))
      .toBeVisible();

    await resolution.unmount();
    expect(getControlStoreCount()).toBe(0);
  } finally {
    disconnect();
    editMemory.dispose();
    cellEdit.dispose();
  }
});

test("keeps legacy edit safety chrome without exposing unavailable review commands", async () => {
  let row: Row = rows[0];
  const compiledColumns = compileColumns(columns);
  const cellEdit = new BrunoTableCellEditRuntime({
    columns: compiledColumns,
    getRow: () => row,
    getRowVersion: (candidate) => (candidate as Row).revision,
  });
  const editMemory = new BrunoTableEditMemoryRuntime();
  cellEdit.activate();
  editMemory.activate();
  const disconnect = editMemory.connectCellEdit(cellEdit);

  try {
    expect(
      cellEdit.applyAcceptedDraftGesture([
        {
          rowId: row.id,
          columnId: "COL_ID_NAME",
          field: "name",
          baseRow: row,
          expectedVersion: row.revision,
          base: "Ada",
          mine: "Augusta",
          conflict: { server: "Server", serverVersion: 2n },
        },
      ]),
    ).toBe(true);
    row = { ...row, name: "Server", revision: 2n };
    cellEdit.reconcileSourceRows(new Set([row.id]));

    const footerScreen = await render(
      <BrunoTableEditSafetyFooter
        dispatchGridCommand={() => false}
        runtime={editMemory}
        tableId="TABLE_ID_EDIT_SAFETY_CONFLICT"
        renderReview={() => null}
      />,
    );
    const footer = footerScreen.getByRole("region", { name: "Edit safety" });
    await expect.element(footer).toMatchTextContent("1 conflict");
    await expect
      .element(footerScreen.getByRole("button", { name: "1 conflict" }))
      .not.toBeInTheDocument();
    expect(editMemory.getConflictReviewSnapshot().open).toBe(false);
    await footerScreen.unmount();
  } finally {
    disconnect();
    editMemory.dispose();
    cellEdit.dispose();
  }

  const adapter = new BrunoTableClientRowPipelineAdapter(
    { rows, totalRows: rows.length, version: 1, status: "ready" },
    (candidate: Row) => candidate.id,
    compiledColumns,
    undefined,
    [{ columnId: "COL_ID_NAME", direction: "asc" }],
  );
  const gridRuntime = new BrunoTableGridRuntime(
    adapter.getPublication(),
    compiledColumns,
    adapter.getQueryConfiguration(compiledColumns),
    "TABLE_ID_LEGACY_EDIT_SAFETY",
  );
  const legacyMemory = new BrunoTableEditMemoryRuntime();
  const legacyCellEdit = new BrunoTableCellEditRuntime({
    columns: compiledColumns,
    getRow: () => row,
    getRowVersion: (candidate) => (candidate as Row).revision,
  });
  legacyMemory.activate();
  try {
    const viewScreen = await render(
      <BrunoTableView
        runtime={gridRuntime.getView()}
        tableId="TABLE_ID_LEGACY_EDIT_SAFETY"
        compiledColumns={compiledColumns}
        toolbar={new BrunoTableToolbarStore(undefined)}
        rowPipeline={BrunoTableClientRowPipeline}
        rowPipelineAdapter={adapter}
        editCapability={createBrunoTableClientEditCapability({
          cellEdit: legacyCellEdit,
          editMemory: legacyMemory,
          renderResetReview: () => null,
        })}
      />,
    );
    await expect.element(viewScreen.getByRole("region", { name: "Edit safety" })).toBeVisible();
    await expect.element(viewScreen.getByRole("button", { name: "Reset edits" })).toBeVisible();
    await expect.element(viewScreen.getByRole("button", { name: "Save" })).toBeVisible();
    await viewScreen.unmount();
  } finally {
    legacyCellEdit.dispose();
    legacyMemory.dispose();
  }
});

function ResetCommandProbe({
  onResult,
}: Readonly<{ readonly onResult: (accepted: boolean) => void }>) {
  const { runtime } = useBrunoTableClientFilterContext();
  return (
    <button
      type="button"
      onClick={() => onResult(runtime.dispatchGridCommand({ type: "edits.reset" }))}
    >
      Dispatch Reset Command
    </button>
  );
}

function HistoryCommandProbe({
  onResult,
}: Readonly<{
  readonly onResult?: (command: "undo" | "redo", accepted: boolean) => void;
}>) {
  const { runtime } = useBrunoTableClientFilterContext();
  const dispatch = (command: "undo" | "redo"): void => {
    const accepted = runtime.dispatchGridCommand({ type: `edits.${command}` });
    onResult?.(command, accepted);
  };
  return (
    <>
      <button type="button" onClick={() => dispatch("undo")}>
        Test Undo
      </button>
      <button type="button" onClick={() => dispatch("redo")}>
        Test Redo
      </button>
    </>
  );
}

function makeCanonicalTextColumns(lowercase: boolean): BrunoTableColumns<Row> {
  const decodeRuntime = (input: unknown) =>
    typeof input === "string"
      ? ({ _tag: "Success", value: lowercase ? input.toLowerCase() : input } as const)
      : ({ _tag: "Failure", message: "Expected text." } as const);
  const valueType: BrunoTableValueType<string> = {
    codecId: lowercase ? "test/browser-lowercase" : "test/browser-identity",
    codecVersion: 1,
    filterFamily: "text",
    editorFamily: "text",
    cellAlign: "start",
    editorLayout: "inline",
    defaultWidth: 120,
    decodeRuntime,
    equivalent: Object.is,
    compare: (left, right) => (left === right ? 0 : left < right ? -1 : 1),
    formatCanonicalText: String,
    parseCanonicalText: (text) => ({ _tag: "Success", value: text }) as const,
    formatDisplay: String,
    encodePersisted: String,
    decodePersisted: decodeRuntime,
  };
  return [
    {
      columnId: "COL_ID_NAME",
      field: "name",
      headerName: "Name",
      valueType,
      isEditable: true,
    },
  ] satisfies BrunoTableColumns<Row>;
}

function makeCaseSensitivityColumns(caseSensitive: boolean): BrunoTableColumns<Row> {
  const decodeRuntime = (input: unknown) =>
    typeof input === "string"
      ? ({ _tag: "Success", value: input } as const)
      : ({ _tag: "Failure", message: "Expected text." } as const);
  const valueType: BrunoTableValueType<string> = {
    codecId: "test/browser-case-sensitivity",
    codecVersion: 1,
    filterFamily: "text",
    editorFamily: "text",
    cellAlign: "start",
    editorLayout: "inline",
    defaultWidth: 120,
    decodeRuntime,
    equivalent: caseSensitive
      ? Object.is
      : (left, right) => left.toLowerCase() === right.toLowerCase(),
    compare: (left, right) => (left === right ? 0 : left < right ? -1 : 1),
    formatCanonicalText: String,
    parseCanonicalText: (text) => ({ _tag: "Success", value: text }) as const,
    formatDisplay: String,
    encodePersisted: String,
    decodePersisted: decodeRuntime,
  };
  return [
    {
      columnId: "COL_ID_NAME",
      field: "name",
      headerName: "Name",
      valueType,
      isEditable: true,
    },
  ] satisfies BrunoTableColumns<Row>;
}

test.afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

test("starts in Immediate mode with a persistent clean Edit Safety Footer", async () => {
  const screen = await render(
    <BrunoTableClient
      tableId="TABLE_ID_EDIT_MEMORY"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={vi.fn(() => Promise.resolve())}
    />,
  );

  const batchEditing = screen.getByRole("switch", { name: "Batch editing", exact: true });
  await expect.element(batchEditing).not.toBeChecked();
  await expect.element(batchEditing).toBeEnabled();
  expect(batchEditing.element()).not.toHaveAttribute("aria-describedby");
  await expect.element(screen.getByRole("region", { name: "Edit safety" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Reset edits" })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Save" })).toBeDisabled();
});

test("saves one Batch edit as one exact row-grouped change set", async () => {
  const onSaveEdits = vi.fn(() => Promise.resolve());
  const screen = await render(
    <BrunoTableClient
      tableId="TABLE_ID_BATCH_SAVE"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />,
  );

  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_BATCH_SAVE" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");

  const save = screen.getByRole("button", { name: "Save" });
  await expect.element(save).toBeEnabled();
  await userEvent.click(save);

  expect(onSaveEdits).toHaveBeenCalledOnce();
  expect(onSaveEdits).toHaveBeenCalledWith([
    {
      rowId: "ada",
      baseRow: rows[0],
      expectedVersion: 1n,
      changes: [
        {
          columnId: "COL_ID_NAME",
          field: "name",
          before: "Ada",
          after: "Augusta",
        },
      ],
    },
  ]);
});

test("keeps a resolved Batch globally locked behind an Accepted Overlay until live confirmation", async () => {
  let resolveSave!: () => void;
  const onSaveEdits = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveSave = resolve;
      }),
  );
  const renderTable = (sourceRows: readonly Row[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_BATCH_ACCEPTED_OVERLAY"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{
        rows: sourceRows,
        totalRows: sourceRows.length,
        version,
        status: "ready",
      }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />
  );
  const screen = await render(renderTable(rows, 1));

  const batchEditing = screen.getByRole("switch", { name: "Batch editing" });
  await userEvent.click(batchEditing);
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_BATCH_ACCEPTED_OVERLAY" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));

  await expect.element(batchEditing).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Reset edits" })).toBeDisabled();
  resolveSave();
  await expect
    .element(screen.getByRole("region", { name: "Edit safety" }))
    .toMatchTextContent("Batch save accepted · waiting for live confirmation · 1 row remaining");
  await expect.element(batchEditing).toBeDisabled();
  const acceptedCell = grid.getByRole("gridcell", { name: "Augusta", exact: true });
  await expect.element(acceptedCell).toBeVisible();
  await expect.element(acceptedCell).toHaveAttribute("data-bruno-save-success");
  expect(getComputedStyle(acceptedCell.element(), "::after").animationDuration).toBe("2s");

  const confirmedRows = [{ id: "ada", name: "Augusta", revision: 2n }] as const;
  await screen.rerender(renderTable(confirmedRows, 2));

  await expect.element(batchEditing).toBeEnabled();
  await expect.element(grid.getByRole("gridcell", { name: "Augusta", exact: true })).toBeVisible();
});

test("keeps the two-second success presentation visible without motion", async () => {
  const session: PlaywrightCDPSession = cdp();
  await session.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  let resolveSave!: () => void;
  try {
    const screen = await render(
      <BrunoTableClient
        tableId="TABLE_ID_REDUCED_MOTION_SAVE_SUCCESS"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        editable
        getRowVersion={(row) => row.revision}
        onSaveEdits={() =>
          new Promise<void>((resolve) => {
            resolveSave = resolve;
          })
        }
      />,
    );
    const grid = screen.getByRole("grid", {
      name: "Data for TABLE_ID_REDUCED_MOTION_SAVE_SUCCESS",
    });
    grid.element().focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
    await userEvent.keyboard("{Enter}");
    resolveSave();

    const acceptedCell = grid.getByRole("gridcell", { name: "Augusta", exact: true });
    await expect.element(acceptedCell).toHaveAttribute("data-bruno-save-success");
    const successStyle = getComputedStyle(acceptedCell.element(), "::after");
    expect(successStyle.animationName).toBe("none");
    expect(successStyle.opacity).toBe("1");
  } finally {
    await session.send("Emulation.setEmulatedMedia", { features: [] });
  }
});

test("unlocks a rejected Batch operation without discarding its drafts or history", async () => {
  let rejectSave!: (reason: Error) => void;
  const onSaveEdits = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectSave = reject;
      }),
  );
  const renderTable = (sourceRows: readonly Row[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_BATCH_REJECTION"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />
  );
  const screen = await render(renderTable(rows, 1));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_BATCH_REJECTION" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));

  await expect.element(screen.getByRole("button", { name: "Reset edits" })).toBeDisabled();
  rejectSave(new Error("Batch compare-and-set failed."));

  await expect
    .element(screen.getByRole("alert"))
    .toMatchTextContent("Open Operation details for the complete explanation.");
  await expect
    .element(screen.getByRole("region", { name: "Edit safety" }))
    .toMatchTextContent("1 unsaved change");
  await expect.element(screen.getByRole("button", { name: "Reset edits" })).toBeEnabled();
  await expect.element(screen.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  const failedCell = grid.getByRole("gridcell", { name: "Augusta", exact: true });
  await expect.element(failedCell).toHaveAttribute("data-bruno-save-failed");

  await screen.rerender(
    renderTable(
      rows.map((candidate) =>
        candidate.id === "ada"
          ? Object.freeze({ ...candidate, name: "Server", revision: 2n })
          : candidate,
      ),
      2,
    ),
  );
  await expect.element(failedCell).toHaveAttribute("data-bruno-save-failed");
  await expect.element(failedCell).toHaveAttribute("data-bruno-edit-conflicted", "");
  const rejectedConflictMarker = failedCell
    .element()
    .querySelector<HTMLElement>("[data-bruno-edit-conflict-indicator]");
  expect(rejectedConflictMarker).not.toBeNull();
  await expect.element(rejectedConflictMarker!).toBeVisible();
  await expect
    .element(rejectedConflictMarker!)
    .toHaveAttribute("title", "Conflicts with the latest server value");
});

test("starts one Immediate save operation from one accepted cell commit", async () => {
  const onSaveEdits = vi.fn(() => Promise.resolve());
  const screen = await render(
    <BrunoTableClient
      tableId="TABLE_ID_IMMEDIATE_SAVE"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />,
  );

  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_IMMEDIATE_SAVE" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");

  expect(onSaveEdits).toHaveBeenCalledOnce();
  expect(onSaveEdits).toHaveBeenCalledWith([
    {
      rowId: "ada",
      baseRow: rows[0],
      expectedVersion: 1n,
      changes: [
        {
          columnId: "COL_ID_NAME",
          field: "name",
          before: "Ada",
          after: "Augusta",
        },
      ],
    },
  ]);
});

test("retains an Immediate Accepted Overlay and operation gate through live confirmation", async () => {
  let resolveSave!: () => void;
  const onSaveEdits = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveSave = resolve;
      }),
  );
  const renderTable = (sourceRows: readonly Row[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_IMMEDIATE_ACCEPTED_OVERLAY"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{
        rows: sourceRows,
        totalRows: sourceRows.length,
        version,
        status: "ready",
      }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />
  );
  const screen = await render(renderTable(rows, 1));

  const batchEditing = screen.getByRole("switch", { name: "Batch editing" });
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_IMMEDIATE_ACCEPTED_OVERLAY" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");

  await expect.element(batchEditing).toBeDisabled();
  await expect
    .element(grid.getByRole("gridcell", { name: "Augusta", exact: true }))
    .toHaveAttribute("aria-busy", "true");
  await expect
    .element(screen.getByRole("region", { name: "Edit safety" }))
    .toMatchTextContent("1 Immediate save pending");
  resolveSave();
  await expect
    .element(screen.getByRole("region", { name: "Edit safety" }))
    .toMatchTextContent("1 Immediate save accepted · waiting for live confirmation");
  await expect.element(batchEditing).toBeDisabled();
  await expect.element(grid.getByRole("gridcell", { name: "Augusta", exact: true })).toBeVisible();

  const confirmedRows = [{ id: "ada", name: "Augusta", revision: 2n }] as const;
  await screen.rerender(renderTable(confirmedRows, 2));

  await expect.element(batchEditing).toBeEnabled();
  await expect
    .element(grid.getByRole("gridcell", { name: "Augusta", exact: true }))
    .not.toHaveAttribute("aria-busy");
  await expect
    .element(grid.getByRole("gridcell", { name: "Augusta", exact: true }))
    .toHaveAttribute("data-bruno-save-success");
});

test("keeps edit warnings visible while an Immediate save is pending", async () => {
  const warningColumns = [
    {
      columnId: "COL_ID_NAME",
      field: "name",
      headerName: "Name",
      valueType: "text",
      isEditable: true,
      validate: ({ value }: { readonly value: string }) =>
        value === "invalid" ? "Choose a valid name." : undefined,
    },
  ] satisfies BrunoTableColumns<Row>;
  const warningRows = [
    { id: "ada", name: "Ada", revision: 1n },
    { id: "grace", name: "Grace", revision: 1n },
  ] as const;
  const onSaveEdits = vi.fn(() => new Promise<void>(() => undefined));
  const screen = await render(
    <BrunoTableClient
      tableId="TABLE_ID_IMMEDIATE_SAVE_WARNINGS"
      columns={warningColumns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{
        rows: warningRows,
        totalRows: warningRows.length,
        version: 1,
        status: "ready",
      }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />,
  );
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_IMMEDIATE_SAVE_WARNINGS" });
  await userEvent.click(grid.getByRole("gridcell", { name: "Ada", exact: true }));
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  await userEvent.click(grid.getByRole("gridcell", { name: "Grace", exact: true }));
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "invalid");
  await userEvent.keyboard("{Enter}");

  await expect
    .element(screen.getByRole("region", { name: "Edit safety" }))
    .toMatchTextContent("1 Immediate save pending · 1 invalid · 2 unsaved");
  expect(onSaveEdits).toHaveBeenCalledOnce();
});

test("renders an Accepted Overlay with its submitted column presentation authority", async () => {
  let resolveSave!: () => void;
  const onSaveEdits = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveSave = resolve;
      }),
  );
  const incompatibleValueType: BrunoTableValueType<number> = {
    codecId: "test/browser-incompatible-number",
    codecVersion: 1,
    filterFamily: "numeric",
    editorFamily: "number",
    cellAlign: "end",
    editorLayout: "inline",
    defaultWidth: 120,
    decodeRuntime: (input) =>
      typeof input === "number"
        ? ({ _tag: "Success", value: input } as const)
        : ({ _tag: "Failure", message: "Expected a number." } as const),
    equivalent: Object.is,
    compare: (left, right) => (left === right ? 0 : left < right ? -1 : 1),
    formatCanonicalText: String,
    parseCanonicalText: (text) => ({ _tag: "Success", value: Number(text) }) as const,
    formatDisplay: (value) => {
      if (typeof value !== "number") throw new TypeError("Replacement formatter received text.");
      return String(value);
    },
    encodePersisted: String,
    decodePersisted: (input) =>
      typeof input === "number"
        ? ({ _tag: "Success", value: input } as const)
        : ({ _tag: "Failure", message: "Expected a number." } as const),
  };
  const incompatibleColumns = [
    {
      columnId: "COL_ID_NAME",
      field: "name",
      headerName: "Name",
      valueType: incompatibleValueType,
      isEditable: true,
    },
  ] as unknown as BrunoTableColumns<Row>;
  const renderTable = (
    activeColumns: BrunoTableColumns<Row>,
    sourceRows: readonly Row[] = rows,
    version = 1,
  ) => (
    <BrunoTableClient
      tableId="TABLE_ID_ACCEPTED_OVERLAY_PRESENTATION"
      columns={activeColumns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />
  );
  const screen = await render(renderTable(columns));
  const grid = screen.getByRole("grid", {
    name: "Data for TABLE_ID_ACCEPTED_OVERLAY_PRESENTATION",
  });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  resolveSave();
  await expect.element(grid.getByRole("gridcell", { name: "Augusta", exact: true })).toBeVisible();

  await screen.rerender(renderTable(incompatibleColumns));
  await expect.element(grid.getByRole("gridcell", { name: "Augusta", exact: true })).toBeVisible();
});

test("restores pending Batch drafts after incompatible decoder and field replacements reject", async () => {
  let rejectSave!: (reason: Error) => void;
  const onSaveEdits = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectSave = reject;
      }),
  );
  const incompatibleValueType: BrunoTableValueType<number> = {
    codecId: "test/browser-pending-batch-number",
    codecVersion: 1,
    filterFamily: "numeric",
    editorFamily: "number",
    cellAlign: "end",
    editorLayout: "inline",
    defaultWidth: 120,
    decodeRuntime: (input) =>
      typeof input === "number"
        ? ({ _tag: "Success", value: input } as const)
        : ({ _tag: "Failure", message: "Expected a number." } as const),
    equivalent: Object.is,
    compare: (left, right) => (left === right ? 0 : left < right ? -1 : 1),
    formatCanonicalText: String,
    parseCanonicalText: (text) => ({ _tag: "Success", value: Number(text) }) as const,
    formatDisplay: String,
    encodePersisted: String,
    decodePersisted: (input) =>
      typeof input === "number"
        ? ({ _tag: "Success", value: input } as const)
        : ({ _tag: "Failure", message: "Expected a number." } as const),
  };
  const incompatibleColumns = [
    {
      columnId: "COL_ID_NAME",
      field: "name",
      headerName: "Name",
      valueType: incompatibleValueType,
      isEditable: true,
    },
  ] as unknown as BrunoTableColumns<Row>;
  const reboundColumns = [
    {
      columnId: "COL_ID_NAME",
      field: "id",
      headerName: "Name",
      valueType: "text",
      isEditable: true,
    },
  ] as unknown as BrunoTableColumns<Row>;
  const restoredColumns = [
    {
      columnId: "COL_ID_NAME",
      field: "name",
      headerName: "Name",
      valueType: "text",
      isEditable: true,
      valueFormatter: ({ value }: { readonly value: string }) => `Restored ${value}`,
    },
  ] satisfies BrunoTableColumns<Row>;
  const renderTable = (
    activeColumns: BrunoTableColumns<Row>,
    sourceRows: readonly Row[] = rows,
    version = 1,
  ) => (
    <BrunoTableClient
      tableId="TABLE_ID_PENDING_BATCH_SCHEMA_REJECTION"
      columns={activeColumns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      projectEditRow={({ row, patch }) => ({ ...row, ...patch })}
      onSaveEdits={onSaveEdits}
    />
  );
  const screen = await render(renderTable(columns));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", {
    name: "Data for TABLE_ID_PENDING_BATCH_SCHEMA_REJECTION",
  });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));

  await screen.rerender(renderTable(incompatibleColumns));
  await screen.rerender(renderTable(reboundColumns));
  rejectSave(new Error("Schema changed while the save was pending."));
  const advancedRows = [{ id: "ada", name: "Countess", revision: 2n }] as const;
  await screen.rerender(renderTable(reboundColumns, advancedRows, 2));
  await expect
    .element(screen.getByRole("region", { name: "Edit safety" }))
    .toMatchTextContent("1 blocked change");
  await expect.element(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  grid.element().focus();
  await userEvent.keyboard(
    detectPlatform() === "mac" ? "{Meta>}z{/Meta}" : "{Control>}z{/Control}",
  );
  await userEvent.keyboard(
    detectPlatform() === "mac"
      ? "{Meta>}{Shift>}z{/Shift}{/Meta}"
      : "{Control>}{Shift>}z{/Shift}{/Control}",
  );
  await expect
    .element(screen.getByRole("region", { name: "Edit safety" }))
    .toMatchTextContent("1 blocked change");
  await screen.rerender(renderTable(restoredColumns, advancedRows, 3));

  await expect
    .element(grid.getByRole("gridcell", { name: "Restored Augusta", exact: true }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("region", { name: "Edit safety" }))
    .toMatchTextContent("1 conflict · 1 unsaved");
  await expect.element(screen.getByRole("button", { name: "Reset edits" })).toBeEnabled();
});

test("keeps Batch drafts blocked while invalid stale source rows are retained", async () => {
  const onSaveEdits = vi.fn(() => new Promise<void>(() => undefined));
  const renderTable = (version: number, status: "ready" | "stale", totalRows: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_INVALID_STALE_EDIT_AUTHORITY"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows, totalRows, version, status }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />
  );
  const screen = await render(renderTable(1, "ready", 1));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", {
    name: "Data for TABLE_ID_INVALID_STALE_EDIT_AUTHORITY",
  });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  await expect.element(screen.getByRole("button", { name: "Save" })).toBeEnabled();

  await screen.rerender(renderTable(2, "stale", 2));

  await expect.element(grid.getByRole("gridcell", { name: "Augusta", exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("region", { name: "Edit safety" }))
    .toMatchTextContent("1 unsaved change");
  await expect.element(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(onSaveEdits).not.toHaveBeenCalled();

  await screen.rerender(renderTable(3, "ready", 1));
  await expect.element(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(onSaveEdits).toHaveBeenCalledOnce();
});

test("retains a resolved save operation across a non-authoritative loading gap", async () => {
  let resolveSave!: () => void;
  const onSaveEdits = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveSave = resolve;
      }),
  );
  const renderTable = (
    sourceRows: readonly Row[],
    version: number,
    status: "loading" | "ready",
  ) => (
    <BrunoTableClient
      tableId="TABLE_ID_SAVE_LOADING_GAP"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: 1, version, status }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />
  );
  const screen = await render(renderTable(rows, 1, "ready"));
  const batchEditing = screen.getByRole("switch", { name: "Batch editing" });
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_SAVE_LOADING_GAP" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");

  await screen.rerender(renderTable([], 2, "loading"));
  await expect
    .element(screen.getByRole("region", { name: "Edit safety" }))
    .toMatchTextContent("1 Immediate save pending");
  resolveSave();
  await expect.element(batchEditing).toBeDisabled();
  await expect
    .element(screen.getByRole("region", { name: "Edit safety" }))
    .toMatchTextContent("1 Immediate save accepted · waiting for live confirmation");

  await screen.rerender(renderTable(rows, 3, "ready"));
  await expect
    .element(grid.getByRole("gridcell", { name: "Augusta", exact: true }))
    .toHaveAttribute("aria-busy", "true");
  await expect.element(batchEditing).toBeDisabled();

  const confirmedRows = [{ id: "ada", name: "Augusta", revision: 2n }] as const;
  await screen.rerender(renderTable(confirmedRows, 4, "ready"));
  await expect.element(batchEditing).toBeEnabled();
});

test("retains a resolved save operation across a terminal source publication", async () => {
  let resolveSave!: () => void;
  const onSaveEdits = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveSave = resolve;
      }),
  );
  const terminalRows = [{ id: "grace", name: "Grace", revision: 1n }] as const;
  const renderTable = (
    sourceRows: readonly Row[],
    version: number,
    status: "closed" | "ready" | "stale",
  ) => (
    <BrunoTableClient
      tableId="TABLE_ID_SAVE_TERMINAL_GAP"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />
  );
  const screen = await render(renderTable(rows, 1, "ready"));
  const batchEditing = screen.getByRole("switch", { name: "Batch editing" });
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_SAVE_TERMINAL_GAP" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");

  resolveSave();
  await expect
    .element(screen.getByRole("region", { name: "Edit safety" }))
    .toMatchTextContent("1 Immediate save accepted · waiting for live confirmation");
  await expect.element(batchEditing).toBeDisabled();

  await screen.rerender(renderTable(terminalRows, 2, "closed"));
  await expect.element(batchEditing).toBeDisabled();

  await screen.rerender(renderTable(terminalRows, 3, "stale"));
  await expect.element(batchEditing).toBeEnabled();
});

test("disables Batch Save for terminal source state and restores it for stale authority", async () => {
  const onSaveEdits = vi.fn(() => Promise.resolve());
  const renderTable = (status: "closed" | "ready" | "stale", version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_BATCH_TERMINAL_PREFLIGHT"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows, totalRows: rows.length, version, status }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />
  );
  const screen = await render(renderTable("ready", 1));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_BATCH_TERMINAL_PREFLIGHT" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  const save = screen.getByRole("button", { name: "Save", exact: true });
  await expect.element(save).toBeEnabled();

  await screen.rerender(renderTable("closed", 2));
  await expect.element(save).toBeDisabled();
  expect(onSaveEdits).not.toHaveBeenCalled();

  await screen.rerender(renderTable("stale", 3));
  await expect.element(save).toBeEnabled();
});

test("retains an Immediate candidate until save preflight becomes authoritative", async () => {
  const onSaveEdits = vi.fn(() => Promise.resolve());
  const renderTable = (
    sourceRows: readonly Row[],
    version: number,
    status: "loading" | "ready",
  ) => (
    <BrunoTableClient
      tableId="TABLE_ID_IMMEDIATE_LOADING_GAP"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: 1, version, status }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />
  );
  const screen = await render(renderTable(rows, 1, "ready"));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_IMMEDIATE_LOADING_GAP" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");

  await screen.rerender(renderTable(rows, 2, "loading"));
  expect(onSaveEdits).not.toHaveBeenCalled();
  await expect
    .element(screen.getByRole("region", { name: "Edit safety" }))
    .toMatchTextContent("1 unsaved change");
  await expect.element(screen.getByRole("button", { name: "Save" })).toBeDisabled();

  await screen.rerender(renderTable(rows, 3, "ready"));
  const restoredEditor = screen.getByRole("textbox", { name: "Edit Name" });
  await expect.element(restoredEditor).toHaveValue("Augusta");
  restoredEditor.element().focus();
  await userEvent.keyboard("{Enter}");
  expect(onSaveEdits).toHaveBeenCalledOnce();
  expect(onSaveEdits).toHaveBeenNthCalledWith(1, [
    {
      rowId: "ada",
      baseRow: rows[0],
      expectedVersion: 1n,
      changes: [
        {
          columnId: "COL_ID_NAME",
          field: "name",
          before: "Ada",
          after: "Augusta",
        },
      ],
    },
  ]);
});

test("resolves an Immediate conflict with Mine and starts one safely rebased save", async () => {
  let resolveSave!: () => void;
  const onSaveEdits = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveSave = resolve;
      }),
  );
  const renderTable = (
    sourceRows: readonly Row[],
    version: number,
    status: "loading" | "ready",
  ) => (
    <BrunoTableClient
      tableId="TABLE_ID_IMMEDIATE_CONFLICT_MINE"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: 1, version, status }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />
  );
  const screen = await render(renderTable(rows, 1, "ready"));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_IMMEDIATE_CONFLICT_MINE" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await screen.rerender(renderTable(rows, 2, "loading"));
  await userEvent.keyboard("{Enter}");
  expect(onSaveEdits).not.toHaveBeenCalled();

  const serverRows = [{ id: "ada", name: "Server", revision: 2n }] as const;
  await screen.rerender(renderTable(serverRows, 3, "ready"));
  const editor = screen.getByRole("textbox", { name: "Edit Name" });
  editor.element().focus();
  await userEvent.keyboard("{Enter}");
  expect(onSaveEdits).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "1 conflict" }));
  let review = screen.getByRole("alertdialog", { name: "Conflict Review" });
  let reviewGrid = review.getByRole("grid", { name: "Conflict Review changes" });
  expect(reviewGrid.element().getAttribute("aria-keyshortcuts")).not.toMatch(/Control\+C|Meta\+C/);
  scrollReviewGridToEnd(reviewGrid);
  await userEvent.click(
    review.getByRole("button", { name: /^Keep Mine for row ada, column Name(?:\.|$)/u }),
  );

  expect(onSaveEdits).toHaveBeenCalledOnce();
  expect(onSaveEdits).toHaveBeenCalledWith([
    {
      rowId: "ada",
      baseRow: serverRows[0],
      expectedVersion: 2n,
      changes: [
        {
          columnId: "COL_ID_NAME",
          field: "name",
          before: "Server",
          after: "Augusta",
        },
      ],
    },
  ]);
  await expect.element(review).toBeVisible();
  await expect.element(review.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await expect.element(review.getByRole("button", { name: "Saving…" })).toBeDisabled();
  resolveSave();
  await expect.element(review).not.toBeInTheDocument();
});

test.each([
  {
    label: "throws synchronously",
    tableId: "TABLE_ID_IMMEDIATE_CONFLICT_SYNC_THROW",
    message: "Compare-and-set rejected synchronously.",
    fail: (): PromiseLike<void> => {
      throw new Error("Compare-and-set rejected synchronously.");
    },
  },
  {
    label: "throws while reading then",
    tableId: "TABLE_ID_IMMEDIATE_CONFLICT_HOSTILE_THEN",
    message: "Hostile then accessor.",
    fail: (): PromiseLike<void> =>
      new Proxy(Object.create(null) as object, {
        get: (_target, property) => {
          if (property === "then") throw new Error("Hostile then accessor.");
          return undefined;
        },
      }) as PromiseLike<void>,
  },
  {
    label: "returns a non-Promise result",
    tableId: "TABLE_ID_IMMEDIATE_CONFLICT_NON_PROMISE",
    message: "BrunoTable onSaveEdits must return a PromiseLike<void>.",
    fail: () => 42 as never,
  },
])(
  "restores an Immediate Conflict Review after onSaveEdits $label",
  async ({ fail, message, tableId }) => {
    let saveAttempt = 0;
    const onSaveEdits = vi.fn(() => {
      saveAttempt += 1;
      return saveAttempt === 1 ? fail() : Promise.resolve();
    });
    const renderTable = (
      sourceRows: readonly Row[],
      version: number,
      status: "loading" | "ready",
    ) => (
      <BrunoTableClient
        tableId={tableId}
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows: sourceRows, totalRows: 1, version, status }}
        getRowId={(row) => row.id}
        editable
        getRowVersion={(row) => row.revision}
        onSaveEdits={onSaveEdits}
      />
    );
    const screen = await render(renderTable(rows, 1, "ready"));
    const grid = screen.getByRole("grid", { name: `Data for ${tableId}` });
    grid.element().focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
    await screen.rerender(renderTable(rows, 2, "loading"));
    await userEvent.keyboard("{Enter}");

    const serverRows = [{ id: "ada", name: "Server", revision: 2n }] as const;
    await screen.rerender(renderTable(serverRows, 3, "ready"));
    const editor = screen.getByRole("textbox", { name: "Edit Name" });
    editor.element().focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.click(screen.getByRole("button", { name: "1 conflict" }));
    const review = screen.getByRole("alertdialog", { name: "Conflict Review" });
    const reviewGrid = review.getByRole("grid", { name: "Conflict Review changes" });
    scrollReviewGridToEnd(reviewGrid);
    await userEvent.click(
      review.getByRole("button", { name: /^Keep Mine for row ada, column Name(?:\.|$)/u }),
    );

    expect(onSaveEdits).toHaveBeenCalledOnce();
    await expect.element(review).toBeVisible();
    await expect
      .element(review.getByRole("status"))
      .toMatchTextContent("All conflicts are current.");
    await expect.element(reviewGrid).not.toBeInTheDocument();
    await expect
      .element(review.getByRole("button", { name: /^Keep Mine for row ada, column Name(?:\.|$)/u }))
      .not.toBeInTheDocument();
    await expect.element(review.getByRole("button", { name: "Cancel" })).toBeEnabled();
    await expect.element(review.getByRole("button", { name: "Save" })).toBeDisabled();
    await expect.element(review.getByRole("button", { name: "Saving…" })).not.toBeInTheDocument();

    const alert = screen.getByRole("alert");
    await expect.element(alert).toMatchTextContent("A save operation failed.");
    await userEvent.click(review.getByRole("button", { name: "Cancel" }));
    await expect.element(review).not.toBeInTheDocument();
    await userEvent.click(
      screen
        .getByRole("region", { name: "Notifications" })
        .getByRole("button", { name: "Operation details" }),
    );
    const details = screen.getByRole("alertdialog", { name: "Save operation details" });
    await expect.element(details).toMatchTextContent(`Operation 1: ${message}`);
    await userEvent.click(details.getByRole("button", { name: "Close details" }));

    const restoredServer = grid.getByRole("gridcell", { name: "Server", exact: true });
    await userEvent.click(restoredServer);
    await userEvent.keyboard("{Enter}");
    await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta Retry");
    await userEvent.keyboard("{Enter}");

    expect(onSaveEdits).toHaveBeenCalledTimes(2);
    await expect
      .element(grid.getByRole("gridcell", { name: "Augusta Retry", exact: true }))
      .toHaveAttribute("data-bruno-save-success");
    await expect.element(alert).toBeVisible();
  },
);

test("disables Conflict Review choices across a non-authoritative source gap", async () => {
  const serverRows = [{ id: "ada", name: "Server", revision: 2n }] as const;
  const renderTable = (
    sourceRows: readonly Row[],
    version: number,
    status: "loading" | "ready",
  ) => (
    <BrunoTableClient
      tableId="TABLE_ID_CONFLICT_REVIEW_SOURCE_GAP"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: 1, version, status }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={() => Promise.resolve()}
    />
  );
  const screen = await render(renderTable(rows, 1, "ready"));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", {
    name: "Data for TABLE_ID_CONFLICT_REVIEW_SOURCE_GAP",
  });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  await screen.rerender(renderTable(serverRows, 2, "ready"));
  await userEvent.click(screen.getByRole("button", { name: "1 conflict" }));
  const review = screen.getByRole("alertdialog", { name: "Conflict Review" });
  const reviewGrid = review.getByRole("grid", { name: "Conflict Review changes" });
  await userEvent.click(review.getByRole("checkbox", { name: "Select row 1" }));
  scrollReviewGridToEnd(reviewGrid);
  await expect
    .element(review.getByRole("button", { name: /^Keep Mine for row ada, column Name/ }))
    .toBeEnabled();
  await expect
    .element(review.getByRole("button", { name: /^Apply Mine to Selected/ }))
    .toBeEnabled();

  await screen.rerender(renderTable(serverRows, 3, "loading"));

  await expect.element(review).toBeVisible();
  const sourceGapSelection = review.getByRole("checkbox", { name: "Select row 1" });
  await expect.element(sourceGapSelection).toBeChecked();
  scrollReviewGridToEnd(reviewGrid);
  await expect
    .element(
      review.getByRole("button", {
        name: /Keep Mine for row ada, column Name.*current source is ready/,
      }),
    )
    .toBeDisabled();
  await expect
    .element(
      review.getByRole("button", {
        name: /Keep Server for row ada, column Name.*current source is ready/,
      }),
    )
    .toBeDisabled();
  const sourceGapBulkMine = review.getByRole("button", { name: /^Apply Mine to Selected/ });
  await expect.element(sourceGapBulkMine).toBeDisabled();
  expect(sourceGapBulkMine.element().getAttribute("aria-label")).toContain(
    "current source is ready",
  );

  await screen.rerender(renderTable(serverRows, 4, "ready"));
  await expect
    .element(review.getByRole("button", { name: /^Keep Mine for row ada, column Name/ }))
    .toBeEnabled();
  await expect
    .element(review.getByRole("button", { name: /^Apply Mine to Selected/ }))
    .toBeEnabled();
});

test("keeps an Immediate review open while one disjoint conflict save is pending", async () => {
  let resolveSave!: () => void;
  const onSaveEdits = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveSave = resolve;
      }),
  );
  const initialRows = [
    { id: "ada", name: "Ada", revision: 1n },
    { id: "grace", name: "Grace", revision: 1n },
  ] as const;
  const firstServerRows = [
    { id: "ada", name: "A Server Ada", revision: 2n },
    initialRows[1],
  ] as const;
  const finalServerRows = [
    firstServerRows[0],
    { id: "grace", name: "Server Grace", revision: 2n },
  ] as const;
  const renderTable = (
    sourceRows: readonly Row[],
    version: number,
    status: "loading" | "ready",
  ) => (
    <BrunoTableClient
      tableId="TABLE_ID_IMMEDIATE_REVIEW_DISJOINT_SAVE"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: 2, version, status }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />
  );
  const screen = await render(renderTable(initialRows, 1, "ready"));
  const grid = screen.getByRole("grid", {
    name: "Data for TABLE_ID_IMMEDIATE_REVIEW_DISJOINT_SAVE",
  });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await screen.rerender(renderTable([], 2, "loading"));
  await userEvent.keyboard("{Enter}");
  await screen.rerender(renderTable(firstServerRows, 3, "ready"));
  screen.getByRole("textbox", { name: "Edit Name" }).element().focus();
  await userEvent.keyboard("{Enter}");

  grid.element().focus();
  await userEvent.keyboard("{ArrowDown}{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Amazing Grace");
  await screen.rerender(renderTable([], 4, "loading"));
  await userEvent.keyboard("{Enter}");
  await screen.rerender(renderTable(finalServerRows, 5, "ready"));
  screen.getByRole("textbox", { name: "Edit Name" }).element().focus();
  await userEvent.keyboard("{Enter}");

  await userEvent.click(screen.getByRole("button", { name: "2 conflicts" }));
  const review = screen.getByRole("alertdialog", { name: "Conflict Review" });
  const reviewGrid = review.getByRole("grid", { name: "Conflict Review changes" });
  scrollReviewGridToEnd(reviewGrid);
  await userEvent.click(
    review.getByRole("button", { name: /^Keep Mine for row ada, column Name(?:\.|$)/u }),
  );

  const cancel = review.getByRole("button", { name: "Cancel" });
  await expect.element(cancel).toBeDisabled();
  await userEvent.keyboard("{Escape}");
  await expect.element(review).toBeVisible();
  await expect
    .element(review.getByRole("button", { name: "Keep Server for row grace, column Name" }))
    .toBeEnabled();

  resolveSave();
  await expect.element(review).toBeVisible();
  await expect.element(cancel).toBeEnabled();
  await expect
    .element(review.getByRole("button", { name: "Keep Server for row grace, column Name" }))
    .toBeEnabled();
});

test("resolves an Immediate conflict with Server without starting a save", async () => {
  const onSaveEdits = vi.fn(() => Promise.resolve());
  const renderTable = (
    sourceRows: readonly Row[],
    version: number,
    status: "loading" | "ready",
  ) => (
    <BrunoTableClient
      tableId="TABLE_ID_IMMEDIATE_CONFLICT_SERVER"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: 1, version, status }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />
  );
  const screen = await render(renderTable(rows, 1, "ready"));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_IMMEDIATE_CONFLICT_SERVER" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await screen.rerender(renderTable(rows, 2, "loading"));
  await userEvent.keyboard("{Enter}");

  await screen.rerender(renderTable([{ id: "ada", name: "Server", revision: 2n }], 3, "ready"));
  const editor = screen.getByRole("textbox", { name: "Edit Name" });
  editor.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.click(screen.getByRole("button", { name: "1 conflict" }));
  let review = screen.getByRole("alertdialog", { name: "Conflict Review" });
  let reviewGrid = review.getByRole("grid", { name: "Conflict Review changes" });
  const reviewViewport = review
    .element()
    .querySelector<HTMLElement>("[data-bruno-review-viewport]");
  expect(reviewViewport).not.toBeNull();
  await expect
    .poll(() => reviewViewport?.style.getPropertyValue("--bruno-table-review-viewport-max-height"))
    .toBe(`${reviewViewport?.clientHeight}px`);
  expect(parseFloat(getComputedStyle(reviewGrid.element()).maxHeight)).toBeLessThanOrEqual(
    reviewViewport?.clientHeight ?? 0,
  );
  scrollReviewGridToEnd(reviewGrid);
  await userEvent.click(
    review.getByRole("button", { name: /^Keep Server for row ada, column Name(?:\.|$)/u }),
  );
  await userEvent.click(review.getByRole("button", { name: "Cancel" }));
  await expect.element(review).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "1 conflict" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "1 conflict" }));
  review = screen.getByRole("alertdialog", { name: "Conflict Review" });
  reviewGrid = review.getByRole("grid", { name: "Conflict Review changes" });
  scrollReviewGridToEnd(reviewGrid);
  await userEvent.click(
    review.getByRole("button", { name: /^Keep Server for row ada, column Name(?:\.|$)/u }),
  );
  await userEvent.click(review.getByRole("button", { name: "Save" }));

  expect(onSaveEdits).not.toHaveBeenCalled();
  await expect.element(review).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("region", { name: "Edit safety" }))
    .toMatchTextContent("No unsaved changes");

  await screen.rerender(renderTable([{ id: "ada", name: "Server", revision: 3n }], 4, "ready"));
  await expect.element(screen.getByRole("button", { name: "1 conflict" })).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("alertdialog", { name: "Conflict Review" }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("region", { name: "Edit safety" }))
    .toMatchTextContent("No unsaved changes");
});

test("keeps in-flight save evidence in its captured Row Version domain", async () => {
  let resolveSave!: () => void;
  const onSaveEdits = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveSave = resolve;
      }),
  );
  const renderTable = (
    sourceRows: readonly Row[],
    version: number,
    getRowVersion: (row: Row) => bigint,
  ) => (
    <BrunoTableClient
      tableId="TABLE_ID_IN_FLIGHT_VERSION_DOMAIN"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={getRowVersion}
      onSaveEdits={onSaveEdits}
    />
  );
  const originalExtractor = (candidate: Row) => candidate.revision;
  const replacementExtractor = (_candidate: Row) => 999n;
  const screen = await render(renderTable(rows, 1, originalExtractor));
  const batchEditing = screen.getByRole("switch", { name: "Batch editing" });
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_IN_FLIGHT_VERSION_DOMAIN" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");

  await screen.rerender(renderTable(rows, 2, replacementExtractor));
  resolveSave();
  await expect
    .element(grid.getByRole("gridcell", { name: "Augusta", exact: true }))
    .toHaveAttribute("data-bruno-save-success");
  await expect.element(batchEditing).toBeDisabled();

  const confirmedRows = [{ id: "ada", name: "Ada", revision: 2n }] as const;
  await screen.rerender(renderTable(confirmedRows, 3, replacementExtractor));
  await expect.element(batchEditing).toBeEnabled();
});

test("preserves pending and accepted save presentation when a column becomes read-only", async () => {
  let resolveSave!: () => void;
  const onSaveEdits = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveSave = resolve;
      }),
  );
  const readOnlyColumns = [
    {
      columnId: "COL_ID_NAME",
      field: "name",
      headerName: "Name",
      valueType: "text",
      isEditable: false,
    },
    {
      columnId: "COL_ID_EDITABLE_PEER",
      field: "name",
      headerName: "Editable peer",
      valueType: "text",
      isEditable: true,
    },
  ] satisfies BrunoTableColumns<Row>;
  const renderTable = (activeColumns: BrunoTableColumns<Row>, sourceRows: readonly Row[]) => (
    <BrunoTableClient
      tableId="TABLE_ID_SAVE_READ_ONLY_REPLACEMENT"
      columns={activeColumns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version: 1, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />
  );
  const screen = await render(renderTable(columns, rows));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_SAVE_READ_ONLY_REPLACEMENT" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");

  await screen.rerender(renderTable(readOnlyColumns, rows));
  const pendingCell = grid.getByRole("gridcell", { name: "Augusta", exact: true });
  await expect.element(pendingCell).toHaveAttribute("aria-busy", "true");
  resolveSave();
  await expect.element(pendingCell).toHaveAttribute("data-bruno-save-success");
  await expect.element(pendingCell).toHaveAttribute("aria-busy", "true");
});

test("preserves a pending Immediate value across an incompatible column replacement", async () => {
  type SchemaRow = Readonly<{
    readonly id: string;
    readonly name: string;
    readonly amount: number;
    readonly revision: bigint;
  }>;
  const schemaRows = [{ id: "ada", name: "Ada", amount: 4, revision: 1n }] as const;
  const textColumns = [
    {
      columnId: "COL_ID_VALUE",
      field: "name",
      headerName: "Value",
      valueType: "text",
      isEditable: true,
    },
  ] satisfies BrunoTableColumns<SchemaRow>;
  const numberColumns = [
    {
      columnId: "COL_ID_VALUE",
      field: "amount",
      headerName: "Value",
      valueType: "number",
      isEditable: true,
    },
  ] satisfies BrunoTableColumns<SchemaRow>;
  let resolveSave!: () => void;
  const onSaveEdits = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveSave = resolve;
      }),
  );
  const renderTable = (activeColumns: BrunoTableColumns<SchemaRow>) => (
    <BrunoTableClient
      tableId="TABLE_ID_PENDING_SCHEMA_REPLACEMENT"
      columns={activeColumns}
      initialOrderBy={[{ columnId: "COL_ID_VALUE", direction: "asc" }]}
      clientSource={{
        rows: schemaRows,
        totalRows: schemaRows.length,
        version: 1,
        status: "ready",
      }}
      getRowId={(candidate) => candidate.id}
      editable
      getRowVersion={(candidate) => candidate.revision}
      onSaveEdits={onSaveEdits}
    />
  );
  const screen = await render(renderTable(textColumns));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_PENDING_SCHEMA_REPLACEMENT" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Value" }), "Augusta");
  await userEvent.keyboard("{Enter}");

  await screen.rerender(renderTable(numberColumns));
  const pendingCell = grid.getByRole("gridcell", { name: "Augusta", exact: true });
  await expect.element(pendingCell).toHaveAttribute("aria-busy", "true");

  resolveSave();
  await expect.element(pendingCell).toHaveAttribute("data-bruno-save-success");
});

test("preserves pending and accepted presentation across a same-ID Computed Column replacement", async () => {
  const computedColumns = [
    BrunoTableComputedColumn({
      columnId: "COL_ID_NAME",
      fields: ["name"],
      headerName: "Name length",
      valueGetter: ({ row }) => row.name.length,
      valueType: "number",
    }),
    {
      columnId: "COL_ID_EDITABLE_PEER",
      field: "name",
      headerName: "Editable peer",
      valueType: "text",
      isEditable: true,
    },
  ] satisfies BrunoTableColumns<Row>;
  let resolveSave!: () => void;
  const onSaveEdits = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveSave = resolve;
      }),
  );
  const renderTable = (
    activeColumns: BrunoTableColumns<Row>,
    sourceRows: readonly Row[],
    version: number,
  ) => (
    <BrunoTableClient
      tableId="TABLE_ID_SAVE_COMPUTED_REPLACEMENT"
      columns={activeColumns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(candidate) => candidate.id}
      editable
      getRowVersion={(candidate) => candidate.revision}
      onSaveEdits={onSaveEdits}
    />
  );
  const screen = await render(renderTable(columns, rows, 1));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_SAVE_COMPUTED_REPLACEMENT" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");

  await screen.rerender(renderTable(computedColumns, rows, 1));
  const pendingCell = grid.getByRole("gridcell", { name: "Augusta", exact: true });
  await expect.element(pendingCell).toHaveAttribute("aria-busy", "true");
  resolveSave();
  await expect.element(pendingCell).toHaveAttribute("data-bruno-save-success");
  await expect.element(pendingCell).toHaveAttribute("aria-busy", "true");

  const confirmedRows = [{ id: "ada", name: "Augusta", revision: 2n }] as const;
  await screen.rerender(renderTable(computedColumns, confirmedRows, 2));
  const computedCell = grid.getByRole("gridcell", { name: "7", exact: true });
  await userEvent.click(computedCell);
  await userEvent.keyboard("{Enter}");
  await expect
    .element(screen.getByRole("textbox", { name: "Edit Name length" }))
    .not.toBeInTheDocument();
});

test("does not fabricate a conflict when a source row and same-ID column schema change together", async () => {
  const computedColumns = [
    BrunoTableComputedColumn({
      columnId: "COL_ID_NAME",
      fields: ["name"],
      headerName: "Name length",
      valueGetter: ({ row }) => row.name.length,
      valueType: "number",
    }),
    {
      columnId: "COL_ID_EDITABLE_PEER",
      field: "name",
      headerName: "Editable peer",
      valueType: "text",
      isEditable: true,
    },
  ] satisfies BrunoTableColumns<Row>;
  let rejectSave!: (reason: Error) => void;
  const onSaveEdits = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectSave = reject;
      }),
  );
  const renderTable = (
    activeColumns: BrunoTableColumns<Row>,
    sourceRows: readonly Row[],
    version: number,
  ) => (
    <BrunoTableClient
      tableId="TABLE_ID_SIMULTANEOUS_SOURCE_SCHEMA_CHANGE"
      columns={activeColumns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(candidate) => candidate.id}
      editable
      getRowVersion={(candidate) => candidate.revision}
      onSaveEdits={onSaveEdits}
    />
  );
  const screen = await render(renderTable(columns, rows, 1));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", {
    name: "Data for TABLE_ID_SIMULTANEOUS_SOURCE_SCHEMA_CHANGE",
  });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));

  const advancedRows = [{ id: "ada", name: "Ada", revision: 2n }] as const;
  await screen.rerender(renderTable(computedColumns, advancedRows, 2));
  await screen.rerender(renderTable(columns, advancedRows, 2));
  rejectSave(new Error("The save was not confirmed."));

  const editSafety = screen.getByRole("region", { name: "Edit safety" });
  await expect.element(editSafety).toMatchTextContent("1 unsaved");
  await expect.element(editSafety).not.toMatchTextContent("conflict");
  await expect.element(screen.getByRole("button", { name: "Save" })).toBeEnabled();
});

test("reports an Immediate save failure persistently and exposes an accessible Close control", async () => {
  const onSaveEdits = vi.fn(() => Promise.reject(new Error("Version changed on the server.")));
  const screen = await render(
    <BrunoTableClient
      tableId="TABLE_ID_IMMEDIATE_FAILURE"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />,
  );
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_IMMEDIATE_FAILURE" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");

  const alert = screen.getByRole("alert");
  await expect
    .element(alert)
    .toMatchTextContent("Open Operation details for the complete explanation.");
  await expect.element(alert).not.toMatchTextContent("Version changed on the server.");
  await expect
    .element(grid.getByRole("gridcell", { name: "Ada", exact: true }))
    .toHaveAttribute("data-bruno-save-failed");
  const operationDetails = screen
    .getByRole("region", { name: "Notifications" })
    .getByRole("button", { name: "Operation details" });
  await expect.element(operationDetails).toBeVisible();
  await userEvent.click(operationDetails);
  await expect
    .element(screen.getByRole("alertdialog", { name: "Save operation details" }))
    .toMatchTextContent("Operation 1: Version changed on the server.");
  await expect
    .element(screen.getByRole("alertdialog", { name: "Save operation details" }))
    .toMatchTextContent("Row ada, column COL_ID_NAME (field name).");
  await userEvent.click(screen.getByRole("button", { name: "Close details" }));
  await expect.element(alert.getByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  await expect
    .element(alert.getByRole("button", { name: "Save", exact: true }))
    .not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Close toast" }));
  await expect.element(alert).not.toBeInTheDocument();
});

test("does not let a stale Immediate failure presentation suppress a same-cell retry success", async () => {
  let saveIndex = 0;
  const onSaveEdits = vi.fn(() => {
    saveIndex += 1;
    return saveIndex === 1 ? Promise.reject(new Error("First save failed.")) : Promise.resolve();
  });
  const renderTable = (sourceRows: readonly Row[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_IMMEDIATE_FAILURE_RETRY"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />
  );
  const screen = await render(renderTable(rows, 1));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_IMMEDIATE_FAILURE_RETRY" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  await expect
    .element(grid.getByRole("gridcell", { name: "Ada", exact: true }))
    .toHaveAttribute("data-bruno-save-failed");

  await userEvent.click(grid.getByRole("gridcell", { name: "Ada", exact: true }));
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Ada Lovelace");
  await userEvent.keyboard("{Enter}");
  const retryCell = grid.getByRole("gridcell", { name: "Ada Lovelace", exact: true });
  await expect.element(retryCell).toHaveAttribute("data-bruno-save-success");
  await expect.element(retryCell).not.toHaveAttribute("data-bruno-save-failed");
  await expect.element(screen.getByRole("alert")).toMatchTextContent("A save operation failed.");

  const confirmedRows = [{ id: "ada", name: "Ada Lovelace", revision: 2n }] as const;
  await screen.rerender(renderTable(confirmedRows, 2));
  await expect.element(retryCell).not.toHaveAttribute("data-bruno-save-failed");
  await expect.element(screen.getByRole("alert")).toMatchTextContent("A save operation failed.");
});

test("clears a rejected Immediate save after its authoritative row disappears", async () => {
  const renderTable = (sourceRows: readonly Row[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_REJECTED_ROW_DISAPPEARANCE"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(candidate) => candidate.id}
      editable
      getRowVersion={(candidate) => candidate.revision}
      onSaveEdits={() => Promise.reject(new Error("The row was removed."))}
    />
  );
  const screen = await render(renderTable(rows, 1));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_REJECTED_ROW_DISAPPEARANCE" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  await expect.element(screen.getByRole("alert")).toBeInTheDocument();

  await screen.rerender(renderTable([], 2));

  await expect.poll(() => screen.getByRole("alert").all().length).toBe(0);
  await expect.element(screen.getByRole("switch", { name: "Batch editing" })).toBeEnabled();
});

test("retains one concurrent failure when another operation converges", async () => {
  const sourceRows = [
    { id: "ada", name: "Ada", revision: 1n },
    { id: "grace", name: "Grace", revision: 1n },
  ] as const;
  const rejectSave: Array<(reason: Error) => void> = [];
  const onSaveEdits = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectSave.push(reject);
      }),
  );
  const renderTable = (activeRows: readonly Row[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_CONCURRENT_FAILURE_CONVERGENCE"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: activeRows, totalRows: activeRows.length, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />
  );
  const screen = await render(renderTable(sourceRows, 1));
  const grid = screen.getByRole("grid", {
    name: "Data for TABLE_ID_CONCURRENT_FAILURE_CONVERGENCE",
  });
  for (const [before, after] of [
    ["Ada", "Augusta"],
    ["Grace", "Amazing Grace"],
  ] as const) {
    await userEvent.click(grid.getByRole("gridcell", { name: before, exact: true }));
    await userEvent.keyboard("{Enter}");
    await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), after);
    await userEvent.keyboard("{Enter}");
  }

  rejectSave[0]!(new Error("Ada save failed."));
  const alert = screen.getByRole("alert");
  await expect.element(alert).toMatchTextContent("A save operation failed.");
  await userEvent.click(screen.getByRole("button", { name: "Operation details" }));
  const details = screen.getByRole("alertdialog", { name: "Save operation details" });
  await expect.element(details).toMatchTextContent("Ada save failed.");

  rejectSave[1]!(new Error("Grace save failed."));
  await expect.element(details).toBeVisible();
  await expect.element(details).toMatchTextContent("Ada save failed.");
  await expect.element(details).toMatchTextContent("Grace save failed.");

  const partiallyConverged = [{ id: "ada", name: "Augusta", revision: 2n }, sourceRows[1]] as const;
  await screen.rerender(renderTable(partiallyConverged, 2));
  await expect.element(details).toBeVisible();
  await expect.element(details).toMatchTextContent("Grace save failed.");
  await expect.element(details).not.toMatchTextContent("Ada save failed.");
  await userEvent.click(details.getByRole("button", { name: "Close details" }));
  const remainingAlert = screen.getByRole("alert");
  await expect.element(remainingAlert).toMatchTextContent("A save operation failed.");
  await userEvent.click(screen.getByRole("button", { name: "Close toast" }));
  await expect.element(remainingAlert).not.toBeInTheDocument();
});

test("prunes converged cells from one rejected Batch operation's details", async () => {
  const sourceRows = [
    { id: "ada", name: "Ada", revision: 1n },
    { id: "grace", name: "Grace", revision: 1n },
  ] as const;
  let rejectSave!: (reason: Error) => void;
  const onSaveEdits = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectSave = reject;
      }),
  );
  const renderTable = (activeRows: readonly Row[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_PARTIAL_BATCH_FAILURE_DETAILS"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: activeRows, totalRows: activeRows.length, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />
  );
  const screen = await render(renderTable(sourceRows, 1));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", {
    name: "Data for TABLE_ID_PARTIAL_BATCH_FAILURE_DETAILS",
  });
  for (const [before, after] of [
    ["Ada", "Augusta"],
    ["Grace", "Amazing Grace"],
  ] as const) {
    await userEvent.click(grid.getByRole("gridcell", { name: before, exact: true }));
    await userEvent.keyboard("{Enter}");
    await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), after);
    await userEvent.keyboard("{Enter}");
  }
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  rejectSave(new Error("Batch compare-and-set failed."));
  await userEvent.click(screen.getByRole("button", { name: "Operation details" }));
  const details = screen.getByRole("alertdialog", { name: "Save operation details" });
  await expect.element(details).toMatchTextContent("Row ada, column COL_ID_NAME");
  await expect.element(details).toMatchTextContent("Row grace, column COL_ID_NAME");

  const partiallyConverged = [{ id: "ada", name: "Augusta", revision: 2n }, sourceRows[1]] as const;
  await screen.rerender(renderTable(partiallyConverged, 2));
  await expect.element(details).not.toMatchTextContent("Row ada, column COL_ID_NAME");
  await expect.element(details).toMatchTextContent("Row grace, column COL_ID_NAME");
});

test("shares one notification viewport across multiple editable tables", async () => {
  const renderEditableTable = (tableId: string) => (
    <BrunoTableClient
      tableId={tableId}
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={() => Promise.reject(new Error(`Failure for ${tableId}.`))}
    />
  );
  const screen = await render(
    <div>
      {renderEditableTable("TABLE_ID_FAILURE_VIEWPORT_FIRST")}
      {renderEditableTable("TABLE_ID_FAILURE_VIEWPORT_SECOND")}
    </div>,
  );

  for (const tableId of ["TABLE_ID_FAILURE_VIEWPORT_FIRST", "TABLE_ID_FAILURE_VIEWPORT_SECOND"]) {
    const grid = screen.getByRole("grid", { name: `Data for ${tableId}` });
    grid.element().focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), `${tableId}-value`);
    await userEvent.keyboard("{Enter}");
  }

  await expect.poll(() => screen.getByRole("alert").all().length).toBe(2);
  expect(screen.getByRole("region", { name: "Notifications" }).all()).toHaveLength(1);
  await expect
    .element(screen.getByRole("alert").all()[0]!)
    .toMatchTextContent("A save operation failed.");
});

test("keeps shared failure toasts distinct across separate React roots", async () => {
  const renderEditableTable = (tableId: string) => (
    <BrunoTableClient
      tableId={tableId}
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={() => Promise.reject(new Error(`Failure for ${tableId}.`))}
    />
  );
  const first = await render(renderEditableTable("TABLE_ID_FAILURE_ROOT_FIRST"));
  const second = await render(renderEditableTable("TABLE_ID_FAILURE_ROOT_SECOND"));

  for (const [screen, tableId] of [
    [first, "TABLE_ID_FAILURE_ROOT_FIRST"],
    [second, "TABLE_ID_FAILURE_ROOT_SECOND"],
  ] as const) {
    const grid = screen.getByRole("grid", { name: `Data for ${tableId}` });
    grid.element().focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), `${tableId}-value`);
    await userEvent.keyboard("{Enter}");
  }

  await expect.poll(() => second.getByRole("alert").all().length).toBe(2);
  expect(second.getByRole("region", { name: "Notifications" }).all()).toHaveLength(1);
  const detailsButtons = second.getByRole("button", { name: "Operation details" }).all();
  await userEvent.click(detailsButtons[0]!);
  const details = second.getByRole("alertdialog", { name: "Save operation details" });
  const firstToastIndex = details
    .element()
    .textContent?.includes("Failure for TABLE_ID_FAILURE_ROOT_FIRST.")
    ? 0
    : 1;
  await userEvent.click(details.getByRole("button", { name: "Close details" }));
  const survivingDetailsButton = second.getByRole("button", { name: "Operation details" }).all()[
    firstToastIndex
  ]!;
  survivingDetailsButton.element().focus();
  await expect.element(survivingDetailsButton).toHaveFocus();
  await second.unmount();
  await expect.poll(() => second.getByRole("alert").all().length).toBe(1);
  await expect.element(second.getByRole("button", { name: "Operation details" })).toHaveFocus();
});

test("hosts save failure notifications in the table's owner document", async () => {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const runtime = new BrunoTableEditMemoryRuntime();
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  let screen: Awaited<ReturnType<typeof render>> | undefined;
  try {
    const ownerDocument = frame.contentDocument;
    if (ownerDocument === null) throw new Error("Expected a same-origin iframe document.");
    const container = ownerDocument.createElement("div");
    ownerDocument.body.append(container);
    runtime.activate();
    screen = await render(
      <BrunoTableEditSafetyFooter
        dispatchGridCommand={() => false}
        runtime={runtime}
        tableId="TABLE_ID_EDIT_SAFETY_IFRAME"
        renderReview={() => null}
        renderConflictReview={() => null}
        renderBlockedReview={() => null}
      />,
      { container, baseElement: ownerDocument.body },
    );
    await expect
      .poll(() => ownerDocument.querySelector("[data-bruno-table-save-failure-toaster]"))
      .not.toBeNull();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    const OwnerError = ownerDocument.defaultView?.Error;
    if (OwnerError === undefined) throw new Error("Expected the iframe Error constructor.");
    runtime.recordSaveFailure(
      "operation-secondary-document",
      new OwnerError("Cross-document failure."),
      [
        {
          rowId: "ada",
          baseRow: rows[0],
          expectedVersion: 1n,
          changes: [
            {
              columnId: "COL_ID_NAME",
              field: "name",
              before: "Ada",
              after: "Augusta",
            },
          ],
        },
      ],
    );
    expect(runtime.getSaveFailureSnapshot().operations[0]?.message).toBe("Cross-document failure.");

    await expect
      .poll(() => {
        const ownerAlerts = ownerDocument.querySelectorAll('[role="alert"]').length;
        const mainAlerts = document.querySelectorAll('[role="alert"]').length;
        if (ownerAlerts === 0 && mainAlerts > 0) {
          throw new Error(`Toast rendered in the main document (${String(mainAlerts)} alerts).`);
        }
        return ownerAlerts;
      })
      .toBe(1);
    expect(ownerDocument.querySelector("[data-bruno-table-save-failure-toaster]")).not.toBeNull();
    expect(document.querySelector("[data-bruno-table-save-failure-toaster]")).toBeNull();

    const detailsButton = ownerDocument.querySelector<HTMLButtonElement>(
      'button[data-slot="toast-action"]',
    );
    if (detailsButton === null) throw new Error("Expected the iframe Operation details control.");
    detailsButton.focus({ focusVisible: true });
    detailsButton.click();
    await expect
      .poll(() => ({
        ownerDialog: ownerDocument.querySelector('[role="alertdialog"]') !== null,
        mainDialog: document.querySelector('[role="alertdialog"]') !== null,
        ownerText: ownerDocument.body.textContent?.includes("Save operation details") ?? false,
        mainText: document.body.textContent?.includes("Save operation details") ?? false,
      }))
      .toEqual({ ownerDialog: true, mainDialog: false, ownerText: true, mainText: false });
    const details = ownerDocument.querySelector<HTMLElement>('[role="alertdialog"]');
    if (details === null) throw new Error("Expected failure details in the iframe document.");
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(details.contains(ownerDocument.activeElement)).toBe(true);

    await screen.unmount();
    screen = undefined;
    await expect
      .poll(() => ownerDocument.querySelector("[data-bruno-table-save-failure-toaster]"))
      .toBeNull();
    expect(
      consoleError.mock.calls.some((call) =>
        call.some((value) =>
          String(value).includes(
            "Attempted to synchronously unmount a root while React was already rendering",
          ),
        ),
      ),
    ).toBe(false);
  } finally {
    await screen?.unmount();
    runtime.dispose();
    frame.remove();
    consoleError.mockRestore();
  }
});

test("does not reopen stale failure details when a later save fails", async () => {
  let failureIndex = 0;
  const onSaveEdits = vi.fn(() => {
    failureIndex += 1;
    return Promise.reject(new Error(`Failure ${String(failureIndex)}.`));
  });
  const renderTable = (sourceRows: readonly Row[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_FAILURE_DETAILS_GENERATION"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />
  );
  const screen = await render(renderTable(rows, 1));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_FAILURE_DETAILS_GENERATION" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  await expect
    .element(screen.getByRole("alert"))
    .toMatchTextContent("Open Operation details for the complete explanation.");
  await userEvent.click(screen.getByRole("button", { name: "Operation details" }));
  const details = screen.getByRole("alertdialog", { name: "Save operation details" });
  await expect.element(details).toBeVisible();

  const convergedRows = [{ id: "ada", name: "Augusta", revision: 2n }] as const;
  await screen.rerender(renderTable(convergedRows, 2));
  await expect.element(details).not.toBeInTheDocument();
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();

  await expect.element(grid).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Ada");
  await userEvent.keyboard("{Enter}");
  await expect
    .element(screen.getByRole("alert"))
    .toMatchTextContent("Open Operation details for the complete explanation.");
  await expect.element(details).not.toBeInTheDocument();
});

test("normalizes a synchronous save throw and releases Immediate locks", async () => {
  const onSaveEdits = vi.fn(() => {
    throw new Error("The save handler threw synchronously.");
  });
  const screen = await render(
    <BrunoTableClient
      tableId="TABLE_ID_SYNCHRONOUS_SAVE_THROW"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />,
  );
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_SYNCHRONOUS_SAVE_THROW" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");

  await expect
    .element(screen.getByRole("alert"))
    .toMatchTextContent("Open Operation details for the complete explanation.");
  await expect
    .element(grid.getByRole("gridcell", { name: "Ada", exact: true }))
    .not.toHaveAttribute("aria-busy");
});

test("contains a hostile rejection message and still releases Immediate locks", async () => {
  const hostile = Object.create(Error.prototype, {
    message: {
      get(): never {
        throw new Error("message getter failed");
      },
    },
  }) as Error;
  const screen = await render(
    <BrunoTableClient
      tableId="TABLE_ID_HOSTILE_SAVE_REJECTION"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={() => Promise.reject(hostile)}
    />,
  );
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_HOSTILE_SAVE_REJECTION" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");

  await expect
    .element(screen.getByRole("alert"))
    .toMatchTextContent("Open Operation details for the complete explanation.");
  await expect
    .element(grid.getByRole("gridcell", { name: "Ada", exact: true }))
    .not.toHaveAttribute("aria-busy");
});

test("clears Batch rejection presentation and notification on Reset", async () => {
  const screen = await render(
    <BrunoTableClient
      tableId="TABLE_ID_BATCH_FAILURE_RESET"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={() => Promise.reject(new Error("Batch save was not confirmed."))}
    />,
  );
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_BATCH_FAILURE_RESET" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await expect
    .element(screen.getByRole("alert"))
    .toMatchTextContent("Open Operation details for the complete explanation.");

  await userEvent.click(screen.getByRole("button", { name: "Reset edits" }));
  const resetDialog = screen.getByRole("alertdialog", { name: "Reset Review" });
  await expect.element(resetDialog).toBeVisible();
  const confirmReset = screen.getByRole("button", { name: "Reset All Changes" });
  confirmReset.element().scrollIntoView({ block: "center" });
  (confirmReset.element() as HTMLButtonElement).click();

  await expect.element(resetDialog).not.toBeInTheDocument();
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  await expect
    .element(grid.getByRole("gridcell", { name: "Ada", exact: true }))
    .not.toHaveAttribute("data-bruno-save-failed");
});

test("ignores a late save settlement after table disposal", async () => {
  let resolveSave!: () => void;
  const screen = await render(
    <BrunoTableClient
      tableId="TABLE_ID_LATE_SAVE_SETTLEMENT"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={() =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        })
      }
    />,
  );
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_LATE_SAVE_SETTLEMENT" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");

  await screen.unmount();
  const unhandled: unknown[] = [];
  const captureUnhandled = (event: PromiseRejectionEvent) => unhandled.push(event.reason);
  window.addEventListener("unhandledrejection", captureUnhandled);
  try {
    resolveSave();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(unhandled).toEqual([]);
  } finally {
    window.removeEventListener("unhandledrejection", captureUnhandled);
  }
});

test("clears only an ambiguous failure whose submitted values later converge", async () => {
  const onSaveEdits = vi.fn(() => Promise.reject(new Error("Save outcome is unknown.")));
  const renderTable = (sourceRows: readonly Row[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_AMBIGUOUS_FAILURE_CONVERGENCE"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />
  );
  const screen = await render(renderTable(rows, 1));
  const grid = screen.getByRole("grid", {
    name: "Data for TABLE_ID_AMBIGUOUS_FAILURE_CONVERGENCE",
  });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");

  await expect
    .element(screen.getByRole("alert"))
    .toMatchTextContent("Open Operation details for the complete explanation.");
  await expect
    .element(grid.getByRole("gridcell", { name: "Ada", exact: true }))
    .toHaveAttribute("data-bruno-save-failed");

  const convergedRows = [{ id: "ada", name: "Augusta", revision: 2n }] as const;
  await screen.rerender(renderTable(convergedRows, 2));

  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  await expect
    .element(grid.getByRole("gridcell", { name: "Augusta", exact: true }))
    .not.toHaveAttribute("data-bruno-save-failed");
  await expect
    .element(grid.getByRole("gridcell", { name: "Augusta", exact: true }))
    .toHaveAttribute("data-bruno-save-success");
});

test("remembers Immediate convergence when the source advances before rejection", async () => {
  let rejectSave!: (reason: Error) => void;
  const onSaveEdits = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectSave = reject;
      }),
  );
  const renderTable = (sourceRows: readonly Row[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_CONVERGENCE_BEFORE_REJECTION"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />
  );
  const screen = await render(renderTable(rows, 1));
  const batchEditing = screen.getByRole("switch", { name: "Batch editing" });
  const grid = screen.getByRole("grid", {
    name: "Data for TABLE_ID_CONVERGENCE_BEFORE_REJECTION",
  });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  await expect.element(batchEditing).toBeDisabled();

  const convergedRows = [{ id: "ada", name: "Augusta", revision: 2n }] as const;
  await screen.rerender(renderTable(convergedRows, 2));
  const advancedRows = [{ id: "ada", name: "Countess", revision: 3n }] as const;
  await screen.rerender(renderTable(advancedRows, 3));
  rejectSave(new Error("The application raced with the source."));

  await expect.element(batchEditing).toBeEnabled();
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  await expect
    .element(grid.getByRole("gridcell", { name: "Countess", exact: true }))
    .not.toHaveAttribute("data-bruno-save-failed");
  await expect
    .element(grid.getByRole("gridcell", { name: "Countess", exact: true }))
    .toHaveAttribute("data-bruno-save-success");
});

test("remembers and prunes pending Batch convergence through a rebound column", async () => {
  let rejectSave!: (reason: Error) => void;
  const onSaveEdits = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectSave = reject;
      }),
  );
  const reboundColumns = [
    {
      columnId: "COL_ID_NAME",
      field: "id",
      headerName: "Name",
      valueType: "text",
      isEditable: true,
    },
  ] as unknown as BrunoTableColumns<Row>;
  const renderTable = (
    sourceRows: readonly Row[],
    version: number,
    activeColumns: BrunoTableColumns<Row> = columns,
  ) => (
    <BrunoTableClient
      tableId="TABLE_ID_PENDING_BATCH_CONVERGENCE_MEMORY"
      columns={activeColumns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />
  );
  const screen = await render(renderTable(rows, 1));
  const batchEditing = screen.getByRole("switch", { name: "Batch editing" });
  await userEvent.click(batchEditing);
  const grid = screen.getByRole("grid", {
    name: "Data for TABLE_ID_PENDING_BATCH_CONVERGENCE_MEMORY",
  });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));

  const convergedRows = [{ id: "ada", name: "Augusta", revision: 2n }] as const;
  await screen.rerender(renderTable(convergedRows, 2, reboundColumns));
  const advancedRows = [{ id: "ada", name: "Countess", revision: 3n }] as const;
  await screen.rerender(renderTable(advancedRows, 3, reboundColumns));
  rejectSave(new Error("The save callback observed a later source version."));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await screen.rerender(renderTable(advancedRows, 4));

  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  await expect.element(batchEditing).toBeEnabled();
  await expect
    .element(screen.getByRole("region", { name: "Edit safety" }))
    .toMatchTextContent("No unsaved changes");
  await expect
    .element(grid.getByRole("gridcell", { name: "Countess", exact: true }))
    .toHaveAttribute("data-bruno-save-success");
});

test("prunes rejected Batch drafts when captured schema authority later converges", async () => {
  let rejectSave!: (reason: Error) => void;
  const onSaveEdits = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectSave = reject;
      }),
  );
  const reboundColumns = [
    {
      columnId: "COL_ID_NAME",
      field: "id",
      headerName: "Name",
      valueType: "text",
      isEditable: true,
    },
  ] as unknown as BrunoTableColumns<Row>;
  const renderTable = (
    sourceRows: readonly Row[],
    version: number,
    activeColumns: BrunoTableColumns<Row> = columns,
  ) => (
    <BrunoTableClient
      tableId="TABLE_ID_REJECTED_BATCH_SCHEMA_CONVERGENCE"
      columns={activeColumns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />
  );
  const screen = await render(renderTable(rows, 1));
  const batchEditing = screen.getByRole("switch", { name: "Batch editing" });
  await userEvent.click(batchEditing);
  const grid = screen.getByRole("grid", {
    name: "Data for TABLE_ID_REJECTED_BATCH_SCHEMA_CONVERGENCE",
  });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.rerender(renderTable(rows, 2, reboundColumns));
  rejectSave(new Error("The save callback rejected before source confirmation."));
  await expect.element(screen.getByRole("alert")).toBeVisible();
  await expect.element(batchEditing).toBeDisabled();

  const convergedRows = [{ id: "ada", name: "Augusta", revision: 2n }] as const;
  await screen.rerender(renderTable(convergedRows, 3, reboundColumns));

  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  await expect.element(batchEditing).toBeEnabled();
  await expect
    .element(screen.getByRole("region", { name: "Edit safety" }))
    .toMatchTextContent("No unsaved changes");
});

test("preserves a later Batch draft when an older rejected save converges", async () => {
  let rejectSave!: (reason: Error) => void;
  const onSaveEdits = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectSave = reject;
      }),
  );
  const renderTable = (sourceRows: readonly Row[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_REJECTED_BATCH_LATER_DRAFT"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />
  );
  const screen = await render(renderTable(rows, 1));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", {
    name: "Data for TABLE_ID_REJECTED_BATCH_LATER_DRAFT",
  });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  rejectSave(new Error("The first Batch save was rejected."));
  await expect.element(screen.getByRole("alert")).toBeVisible();

  await userEvent.click(grid.getByRole("gridcell", { name: "Augusta", exact: true }));
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Countess");
  await userEvent.keyboard("{Enter}");
  const oldSaveConverged = [{ id: "ada", name: "Augusta", revision: 2n }] as const;
  await screen.rerender(renderTable(oldSaveConverged, 2));

  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  await expect.element(grid.getByRole("gridcell", { name: "Countess", exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("region", { name: "Edit safety" }))
    .toMatchTextContent("1 conflict · 1 unsaved");
  await userEvent.click(screen.getByRole("button", { name: "Reset edits" }));
  const resetAllChanges = screen.getByRole("button", { name: "Reset All Changes" });
  const historyDescriptionId = resetAllChanges.element().getAttribute("aria-describedby");
  expect(document.getElementById(historyDescriptionId ?? "")?.textContent).toContain(
    "2 Batch history commands",
  );
});

test("suppresses stale success flashes while a newer save owns the cell", async () => {
  const settlements: Array<Readonly<{ reject: (reason: Error) => void }>> = [];
  const onSaveEdits = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        settlements.push({ reject });
      }),
  );
  const renderTable = (sourceRows: readonly Row[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_STALE_SUCCESS_FLASH"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />
  );
  const screen = await render(renderTable(rows, 1));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_STALE_SUCCESS_FLASH" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  settlements[0]!.reject(new Error("First attempt failed."));
  await expect.element(screen.getByRole("alert")).toBeVisible();

  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Countess");
  await userEvent.keyboard("{Enter}");
  const oldAttemptConverged = [{ id: "ada", name: "Augusta", revision: 2n }] as const;
  await screen.rerender(renderTable(oldAttemptConverged, 2));
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();

  const pendingRetry = grid.getByRole("gridcell", { name: "Countess", exact: true });
  await expect.element(pendingRetry).toHaveAttribute("aria-busy", "true");
  await expect.element(pendingRetry).not.toHaveAttribute("data-bruno-save-success");
  settlements[1]!.reject(new Error("Second attempt failed."));
});

test("clears an existing success flash when a newer save acquires the cell", async () => {
  const settlements: Array<Readonly<{ resolve: () => void }>> = [];
  const onSaveEdits = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        settlements.push({ resolve });
      }),
  );
  const renderTable = (sourceRows: readonly Row[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_SUCCESS_FLASH_SUPERSEDED"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />
  );
  const screen = await render(renderTable(rows, 1));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_SUCCESS_FLASH_SUPERSEDED" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  settlements[0]!.resolve();
  const convergedRows = [{ id: "ada", name: "Augusta", revision: 2n }] as const;
  await screen.rerender(renderTable(convergedRows, 2));
  const convergedCell = grid.getByRole("gridcell", { name: "Augusta", exact: true });
  await expect.element(convergedCell).toHaveAttribute("data-bruno-save-success");

  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Countess");
  await userEvent.keyboard("{Enter}");
  const pendingCell = grid.getByRole("gridcell", { name: "Countess", exact: true });
  await expect.element(pendingCell).toHaveAttribute("data-bruno-save-pending");
  await expect.element(pendingCell).not.toHaveAttribute("data-bruno-save-success");
});

test("keeps an in-flight save owned when the latest onSaveEdits callback changes", async () => {
  let resolveFirst!: () => void;
  const firstSave = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveFirst = resolve;
      }),
  );
  const nextSave = vi.fn(() => Promise.resolve());
  const renderTable = (
    sourceRows: readonly Row[],
    version: number,
    onSaveEdits: typeof firstSave | typeof nextSave,
  ) => (
    <BrunoTableClient
      tableId="TABLE_ID_SAVE_CALLBACK_REPLACEMENT"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />
  );
  const screen = await render(renderTable(rows, 1, firstSave));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_SAVE_CALLBACK_REPLACEMENT" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");

  await screen.rerender(renderTable(rows, 1, nextSave));
  resolveFirst();
  const confirmedRows = [{ id: "ada", name: "Augusta", revision: 2n }] as const;
  await screen.rerender(renderTable(confirmedRows, 2, nextSave));

  await expect.element(screen.getByRole("switch", { name: "Batch editing" })).toBeEnabled();
  expect(firstSave).toHaveBeenCalledOnce();
  expect(nextSave).not.toHaveBeenCalled();

  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Amazing Grace");
  await userEvent.keyboard("{Enter}");
  expect(nextSave).toHaveBeenCalledOnce();
});

test("keeps concurrent same-row Immediate operations isolated by Cell Identity", async () => {
  type ContactRow = Readonly<{
    readonly id: string;
    readonly first: string;
    readonly last: string;
    readonly revision: bigint;
  }>;
  const contactColumns = [
    {
      columnId: "COL_ID_FIRST",
      field: "first",
      headerName: "First",
      valueType: "text",
      isEditable: true,
    },
    {
      columnId: "COL_ID_LAST",
      field: "last",
      headerName: "Last",
      valueType: "text",
      isEditable: true,
    },
  ] satisfies BrunoTableColumns<ContactRow>;
  const initialRows = [{ id: "ada", first: "Ada", last: "Lovelace", revision: 1n }] as const;
  const settlements: Array<Readonly<{ resolve: () => void; reject: (reason: Error) => void }>> = [];
  const onSaveEdits = vi.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        settlements.push({ resolve, reject });
      }),
  );
  const renderTable = (sourceRows: readonly ContactRow[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_IMMEDIATE_CONCURRENCY"
      columns={contactColumns}
      initialOrderBy={[{ columnId: "COL_ID_FIRST", direction: "asc" }]}
      clientSource={{
        rows: sourceRows,
        totalRows: sourceRows.length,
        version,
        status: "ready",
      }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />
  );
  const screen = await render(renderTable(initialRows, 1));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_IMMEDIATE_CONCURRENCY" });
  const first = grid.getByRole("gridcell", { name: "Ada", exact: true });
  await userEvent.click(first);
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit First" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  const pendingFirst = grid.getByRole("gridcell", { name: "Augusta", exact: true });
  await userEvent.click(pendingFirst);
  await userEvent.keyboard("{Enter}");
  await expect.element(screen.getByRole("textbox", { name: "Edit First" })).not.toBeInTheDocument();
  const last = grid.getByRole("gridcell", { name: "Lovelace", exact: true });
  await userEvent.click(last);
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Last" }), "Byron");
  await userEvent.keyboard("{Enter}");

  expect(onSaveEdits).toHaveBeenCalledTimes(2);
  expect(onSaveEdits).toHaveBeenNthCalledWith(1, [
    {
      rowId: "ada",
      baseRow: initialRows[0],
      expectedVersion: 1n,
      changes: [{ columnId: "COL_ID_FIRST", field: "first", before: "Ada", after: "Augusta" }],
    },
  ]);
  expect(onSaveEdits).toHaveBeenNthCalledWith(2, [
    {
      rowId: "ada",
      baseRow: initialRows[0],
      expectedVersion: 1n,
      changes: [{ columnId: "COL_ID_LAST", field: "last", before: "Lovelace", after: "Byron" }],
    },
  ]);
  await expect
    .element(screen.getByRole("region", { name: "Edit safety" }))
    .toMatchTextContent("2 Immediate saves pending");

  settlements[0]!.resolve();
  await expect.element(grid.getByRole("gridcell", { name: "Augusta", exact: true })).toBeVisible();
  await expect.element(grid.getByRole("gridcell", { name: "Byron", exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("region", { name: "Edit safety" }))
    .toMatchTextContent(
      "1 Immediate save pending · 1 Immediate save accepted · waiting for live confirmation",
    );
  await expect.element(screen.getByRole("switch", { name: "Batch editing" })).toBeDisabled();

  const firstConfirmed = [{ id: "ada", first: "Augusta", last: "Lovelace", revision: 2n }] as const;
  await screen.rerender(renderTable(firstConfirmed, 2));
  await expect.element(screen.getByRole("switch", { name: "Batch editing" })).toBeDisabled();

  settlements[1]!.reject(new Error("Second save rejected"));
  await expect.element(screen.getByRole("switch", { name: "Batch editing" })).toBeDisabled();

  const bothConfirmed = [{ id: "ada", first: "Augusta", last: "Byron", revision: 3n }] as const;
  await screen.rerender(renderTable(bothConfirmed, 3));
  await expect.element(screen.getByRole("switch", { name: "Batch editing" })).toBeEnabled();
});

test("installs no edit mode or safety chrome for a read-only Client instance", async () => {
  const screen = await render(
    <BrunoTableClient
      tableId="TABLE_ID_READ_ONLY_EDIT_MEMORY"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      getRowId={(row) => row.id}
    />,
  );

  await expect
    .element(screen.getByRole("switch", { name: "Batch editing" }))
    .not.toBeInTheDocument();
  await expect.element(screen.getByRole("region", { name: "Edit safety" })).not.toBeInTheDocument();
});

test("blocks Edit Mode changes while an editor or committed draft owns work", async () => {
  const screen = await render(
    <BrunoTableClient
      tableId="TABLE_ID_EDIT_MODE_GUARD"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={vi.fn(() => Promise.resolve())}
    />,
  );
  const batchEditing = screen.getByRole("switch", { name: "Batch editing", exact: true });

  await userEvent.click(batchEditing);
  await expect.element(batchEditing).toBeChecked();

  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_EDIT_MODE_GUARD" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(screen.getByRole("textbox", { name: "Edit Name" })).toHaveFocus();
  await expect.element(batchEditing).toBeDisabled();
  const modeDescriptionId = batchEditing.element().getAttribute("aria-describedby");
  expect(modeDescriptionId).toBeTruthy();
  expect(document.getElementById(modeDescriptionId ?? "")?.textContent).toContain(
    "Finish or reset current edit work",
  );

  await userEvent.keyboard("{Escape}");
  await expect.element(batchEditing).toBeEnabled();

  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  const editor = screen.getByRole("textbox", { name: "Edit Name" });
  await userEvent.fill(editor, "Augusta");
  await userEvent.keyboard("{Enter}");

  await expect.element(batchEditing).toBeDisabled();
  expect(
    screen
      .getByRole("region", { name: "Edit safety" })
      .element()
      .querySelector('[aria-live="polite"]'),
  ).toMatchTextContent("1 unsaved change");
  await expect.element(screen.getByRole("button", { name: "Reset edits" })).toBeEnabled();
  await expect.element(screen.getByRole("button", { name: "Save" })).toBeEnabled();
});

test("reconciles current draft convergence against replacement column semantics", async () => {
  const initialColumns = makeCanonicalTextColumns(false);
  const replacementColumns = makeCanonicalTextColumns(true);
  const screen = await render(
    <BrunoTableClient
      tableId="TABLE_ID_COLUMN_DOMAIN_CURRENT"
      columns={initialColumns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={vi.fn(() => Promise.resolve())}
    />,
  );
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_COLUMN_DOMAIN_CURRENT" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "ada");
  await userEvent.keyboard("{Enter}");

  await screen.rerender(
    <BrunoTableClient
      tableId="TABLE_ID_COLUMN_DOMAIN_CURRENT"
      columns={replacementColumns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={vi.fn(() => Promise.resolve())}
    />,
  );

  await expect.element(screen.getByRole("button", { name: "Reset edits" })).toBeDisabled();
  expect(
    screen
      .getByRole("region", { name: "Edit safety" })
      .element()
      .querySelector('[aria-live="polite"]'),
  ).toMatchTextContent("No unsaved changes");
});

test("reconciles redo-only convergence against replacement column semantics", async () => {
  const initialColumns = makeCanonicalTextColumns(false);
  const replacementColumns = makeCanonicalTextColumns(true);
  const screen = await render(
    <BrunoTableClient
      tableId="TABLE_ID_COLUMN_DOMAIN_REDO"
      columns={initialColumns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={vi.fn(() => Promise.resolve())}
    />,
  );
  const batchEditing = screen.getByRole("switch", { name: "Batch editing" });
  await userEvent.click(batchEditing);
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_COLUMN_DOMAIN_REDO" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "ada");
  await userEvent.keyboard("{Enter}");
  grid.element().focus();
  await userEvent.keyboard(
    detectPlatform() === "mac" ? "{Meta>}z{/Meta}" : "{Control>}z{/Control}",
  );

  await screen.rerender(
    <BrunoTableClient
      tableId="TABLE_ID_COLUMN_DOMAIN_REDO"
      columns={replacementColumns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={vi.fn(() => Promise.resolve())}
    />,
  );

  await expect.element(batchEditing).toBeEnabled();
  expect(grid.element().getAttribute("aria-keyshortcuts")).not.toMatch(/Control\+Shift\+Z/);
});

test("keeps an open Reset Review in the replacement column value domain", async () => {
  const initialColumns = makeCanonicalTextColumns(false);
  const replacementColumns = makeCanonicalTextColumns(true);
  const save = vi.fn(() => Promise.resolve());
  const renderTable = (activeColumns: BrunoTableColumns<Row>, version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_COLUMN_DOMAIN_REVIEW"
      columns={activeColumns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows, totalRows: rows.length, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={save}
    />
  );
  const screen = await render(renderTable(initialColumns, 1));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_COLUMN_DOMAIN_REVIEW" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Mine");
  await userEvent.keyboard("{Enter}");
  await userEvent.click(screen.getByRole("button", { name: "Reset edits" }));
  const review = screen.getByRole("alertdialog", { name: "Reset Review" }).getByRole("grid");
  await expect.element(review.getByRole("gridcell", { name: "Ada", exact: true })).toBeVisible();

  await screen.rerender(renderTable(replacementColumns, 1));
  expect(
    review.element().querySelector('td[data-bruno-column-id="COL_ID_SERVER_NOW"]'),
  ).toMatchTextContent("ada");
  expect(
    review.element().querySelector('td[data-bruno-column-id="COL_ID_YOURS"]'),
  ).toMatchTextContent("mine");

  await screen.rerender(renderTable(replacementColumns, 2));
  expect(
    review.element().querySelector('td[data-bruno-column-id="COL_ID_SERVER_NOW"]'),
  ).toMatchTextContent("ada");
  expect(save).not.toHaveBeenCalled();
});

test("reconciles simultaneous source and column replacements as one coherent snapshot", async () => {
  const initialRows = [{ id: "ada", name: "base", revision: 1n }] as const;
  const driftedRows = [{ id: "ada", name: "foo", revision: 2n }] as const;
  const replacementRows = [{ id: "ada", name: "bar", revision: 3n }] as const;
  const renderTable = (
    activeColumns: BrunoTableColumns<Row>,
    sourceRows: readonly Row[],
    version: number,
  ) => (
    <BrunoTableClient
      tableId="TABLE_ID_COHERENT_SOURCE_COLUMNS"
      columns={activeColumns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={vi.fn(() => Promise.resolve())}
    />
  );
  const screen = await render(renderTable(makeCaseSensitivityColumns(true), initialRows, 1));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_COHERENT_SOURCE_COLUMNS" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "FOO");
  await userEvent.keyboard("{Enter}");

  await screen.rerender(renderTable(makeCaseSensitivityColumns(true), driftedRows, 2));
  await expect.element(grid.getByRole("gridcell", { name: "FOO", exact: true })).toBeVisible();

  await screen.rerender(renderTable(makeCaseSensitivityColumns(false), replacementRows, 3));

  await expect.element(grid.getByRole("gridcell", { name: "FOO", exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Reset edits" })).toBeEnabled();
});

test("conflicts a preserved draft when simultaneous replacement makes equality stricter", async () => {
  const initialRows = [{ id: "ada", name: "base", revision: 1n }] as const;
  const driftedRows = [{ id: "ada", name: "foo", revision: 2n }] as const;
  const renderTable = (
    activeColumns: BrunoTableColumns<Row>,
    sourceRows: readonly Row[],
    version: number,
  ) => (
    <BrunoTableClient
      tableId="TABLE_ID_STRICTER_COHERENT_SOURCE_COLUMNS"
      columns={activeColumns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={() => Promise.resolve()}
    />
  );
  const screen = await render(renderTable(makeCaseSensitivityColumns(false), initialRows, 1));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", {
    name: "Data for TABLE_ID_STRICTER_COHERENT_SOURCE_COLUMNS",
  });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "FOO");
  await userEvent.keyboard("{Enter}");

  await screen.rerender(renderTable(makeCaseSensitivityColumns(true), driftedRows, 2));

  await expect.element(grid.getByRole("gridcell", { name: "FOO", exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("region", { name: "Edit safety" }))
    .toMatchTextContent("1 conflict · 1 unsaved");
  await expect.element(screen.getByRole("button", { name: "Reset edits" })).toBeEnabled();
  grid.element().focus();
  await userEvent.keyboard(
    detectPlatform() === "mac" ? "{Meta>}z{/Meta}" : "{Control>}z{/Control}",
  );
  await expect.element(grid.getByRole("gridcell", { name: "foo", exact: true })).toBeVisible();
  await userEvent.keyboard(
    detectPlatform() === "mac"
      ? "{Meta>}{Shift>}z{/Shift}{/Meta}"
      : "{Control>}{Shift>}z{/Shift}{/Control}",
  );
  await expect.element(grid.getByRole("gridcell", { name: "FOO", exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("region", { name: "Edit safety" }))
    .toMatchTextContent("1 conflict · 1 unsaved");
});

test("uses captured equality when a pending save receives a looser replacement schema", async () => {
  const initialRows = [{ id: "ada", name: "base", revision: 1n }] as const;
  const driftedRows = [{ id: "ada", name: "foo", revision: 2n }] as const;
  let rejectSave!: (reason: Error) => void;
  const onSaveEdits = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectSave = reject;
      }),
  );
  const renderTable = (
    activeColumns: BrunoTableColumns<Row>,
    sourceRows: readonly Row[],
    version: number,
  ) => (
    <BrunoTableClient
      tableId="TABLE_ID_PENDING_LOOSER_SOURCE_COLUMNS"
      columns={activeColumns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />
  );
  const screen = await render(renderTable(makeCaseSensitivityColumns(true), initialRows, 1));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", {
    name: "Data for TABLE_ID_PENDING_LOOSER_SOURCE_COLUMNS",
  });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "FOO");
  await userEvent.keyboard("{Enter}");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));

  await screen.rerender(renderTable(makeCaseSensitivityColumns(false), driftedRows, 2));
  rejectSave(new Error("Batch compare-and-set failed."));

  await expect.element(grid.getByRole("gridcell", { name: "FOO", exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("region", { name: "Edit safety" }))
    .toMatchTextContent("1 unsaved");
  await expect.element(screen.getByRole("button", { name: "Reset edits" })).toBeEnabled();
  await expect
    .element(screen.getByRole("alert"))
    .toMatchTextContent("Open Operation details for the complete explanation.");

  const convergedRows = [{ id: "ada", name: "FOO", revision: 3n }] as const;
  await screen.rerender(renderTable(makeCaseSensitivityColumns(false), convergedRows, 3));
  await expect
    .element(screen.getByRole("region", { name: "Edit safety" }))
    .toMatchTextContent("No unsaved changes");
});

test("captures Row Version evidence through the latest extractor", async () => {
  const initialExtractor = vi.fn((_row: Row) => 1n);
  const latestExtractor = vi.fn((_row: Row) => 2n);
  const save = vi.fn(() => Promise.resolve());
  const screen = await render(
    <BrunoTableClient
      tableId="TABLE_ID_LATEST_ROW_VERSION"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={initialExtractor}
      onSaveEdits={save}
    />,
  );

  await screen.rerender(
    <BrunoTableClient
      tableId="TABLE_ID_LATEST_ROW_VERSION"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={latestExtractor}
      onSaveEdits={save}
    />,
  );

  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_LATEST_ROW_VERSION" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");

  expect(initialExtractor).not.toHaveBeenCalled();
  expect(latestExtractor).toHaveBeenCalledWith(rows[0]);
});

test("blocks Batch Save while Row Version extraction fails and recovers", async () => {
  let extractorAvailable = true;
  const getRowVersion = (candidate: Row) => {
    if (!extractorAvailable) throw new Error("Row Version unavailable.");
    return candidate.revision;
  };
  const renderTable = (version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_ROW_VERSION_RECOVERY"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows, totalRows: rows.length, version, status: "ready" }}
      getRowId={(candidate) => candidate.id}
      editable
      getRowVersion={getRowVersion}
      onSaveEdits={() => Promise.resolve()}
    />
  );
  const screen = await render(renderTable(1));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_ROW_VERSION_RECOVERY" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");

  extractorAvailable = false;
  await screen.rerender(renderTable(2));
  await expect
    .element(screen.getByRole("region", { name: "Edit safety" }))
    .toMatchTextContent("1 blocked change");
  await expect.element(screen.getByRole("button", { name: "Save" })).toBeDisabled();

  extractorAvailable = true;
  await screen.rerender(renderTable(3));
  await expect
    .element(screen.getByRole("region", { name: "Edit safety" }))
    .toMatchTextContent("1 unsaved change");
  await expect.element(screen.getByRole("button", { name: "Save" })).toBeEnabled();
});

test("reviews pending work before Reset and changes nothing until confirmation", async () => {
  const screen = await render(
    <BrunoTableClient
      tableId="TABLE_ID_RESET_REVIEW"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={vi.fn(() => Promise.resolve())}
    />,
  );

  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_RESET_REVIEW" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  await expect.element(grid.getByRole("gridcell", { name: "Augusta", exact: true })).toBeVisible();

  const reset = screen.getByRole("button", { name: "Reset edits" });
  await userEvent.click(reset);
  const reviewDialog = screen.getByRole("alertdialog", { name: "Reset Review" });
  await expect.element(reviewDialog).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Keep Editing" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Reset All Changes" })).toBeVisible();
  const resetAll = screen.getByRole("button", { name: "Reset All Changes" });
  const resetDescriptionId = resetAll.element().getAttribute("aria-describedby");
  expect(resetDescriptionId).toBeTruthy();
  expect(document.getElementById(resetDescriptionId ?? "")?.textContent).toContain(
    "1 pending changed cell",
  );
  const reviewGrid = reviewDialog.getByRole("grid");
  await expect.element(reviewGrid).toBeVisible();
  await expect
    .element(reviewGrid.getByRole("gridcell", { name: "Ada", exact: true }))
    .toBeVisible();
  await expect
    .element(reviewGrid.getByRole("gridcell", { name: "Augusta", exact: true }))
    .toBeVisible();
  await expect
    .element(reviewGrid.getByRole("gridcell", { name: "Draft", exact: true }))
    .toBeVisible();
  for (const headerName of ["Server now", "Yours", "Status"] as const) {
    await expect
      .element(reviewGrid.getByRole("button", { name: `Sort by ${headerName}` }))
      .not.toBeInTheDocument();
    await expect
      .element(reviewGrid.getByRole("button", { name: `Filter ${headerName}` }))
      .not.toBeInTheDocument();
  }

  const updatedRows = [{ id: "ada", name: "Adele", revision: 2n }] as const;
  await screen.rerender(
    <BrunoTableClient
      tableId="TABLE_ID_RESET_REVIEW"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{
        rows: updatedRows,
        totalRows: updatedRows.length,
        version: 2,
        status: "ready",
      }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={vi.fn(() => Promise.resolve())}
    />,
  );
  await expect
    .element(reviewGrid.getByRole("gridcell", { name: "Adele", exact: true }))
    .toBeVisible();

  (screen.getByRole("button", { name: "Keep Editing" }).element() as HTMLButtonElement).click();
  await expect
    .element(screen.getByRole("alertdialog", { name: "Reset Review" }))
    .not.toBeInTheDocument();
  await expect.element(grid.getByRole("gridcell", { name: "Augusta", exact: true })).toBeVisible();

  await userEvent.click(reset);
  const confirmReset = screen.getByRole("button", { name: "Reset All Changes" });
  confirmReset.element().scrollIntoView({ block: "center" });
  (confirmReset.element() as HTMLButtonElement).click();
  await expect
    .element(screen.getByRole("alertdialog", { name: "Reset Review" }))
    .not.toBeInTheDocument();
  await expect.element(grid).toHaveFocus();
  await expect.element(grid.getByRole("gridcell", { name: "Adele", exact: true })).toBeVisible();
  expect(
    screen
      .getByRole("region", { name: "Edit safety" })
      .element()
      .querySelector('[aria-live="polite"]'),
  ).toMatchTextContent("No unsaved changes");
  await expect.element(reset).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Save" })).toBeDisabled();
});

test("reviews and resets a lone invalid active candidate", async () => {
  const candidateClassName = ({ value }: { readonly value: string }) => `name-${value}`;
  const validatingColumns = [
    {
      columnId: "COL_ID_NAME",
      field: "name",
      headerName: "Name",
      valueType: "text",
      isEditable: true,
      cellClassName: candidateClassName,
      validate: ({ value }: { readonly value: string }) =>
        value === "invalid candidate" ? "Choose a valid name." : undefined,
    },
  ] satisfies BrunoTableColumns<Row>;
  const screen = await render(
    <BrunoTableClient
      tableId="TABLE_ID_RESET_ACTIVE_CANDIDATE"
      columns={validatingColumns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      projectEditRow={({ row, patch }) => ({ ...row, ...patch })}
      onSaveEdits={vi.fn(() => Promise.resolve())}
    />,
  );
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_RESET_ACTIVE_CANDIDATE" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "invalid candidate");
  await userEvent.keyboard("{Enter}");

  expect(
    screen
      .getByRole("region", { name: "Edit safety" })
      .element()
      .querySelector('[aria-live="polite"]'),
  ).toMatchTextContent("1 invalid · 1 unsaved");

  const reset = screen.getByRole("button", { name: "Reset edits" });
  await expect.element(reset).toBeEnabled();
  await userEvent.click(reset);
  const review = screen.getByRole("alertdialog", { name: "Reset Review" });
  await expect.element(review).toBeVisible();
  const reviewGrid = review.getByRole("grid");
  await expect
    .element(reviewGrid.getByRole("gridcell", { name: "invalid candidate", exact: true }))
    .toBeVisible();
  await expect
    .element(reviewGrid.getByRole("gridcell", { name: "Choose a valid name.", exact: true }))
    .toBeVisible();
  expect(
    reviewGrid
      .getByRole("gridcell", { name: "invalid candidate", exact: true })
      .element()
      .closest<HTMLElement>("[role=gridcell]")?.className,
  ).not.toContain("name-Ada");

  expect(
    review
      .element()
      .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true })),
  ).toBe(true);
  await expect.element(review).toBeVisible();

  await userEvent.keyboard("{Escape}");
  await expect.element(review).not.toBeInTheDocument();
  const retainedEditor = screen.getByRole("textbox", { name: "Edit Name" });
  await expect.element(retainedEditor).toHaveValue("invalid candidate");

  await userEvent.click(reset);
  await expect.element(screen.getByRole("alertdialog", { name: "Reset Review" })).toBeVisible();

  const confirmReset = screen.getByRole("button", { name: "Reset All Changes" });
  confirmReset.element().scrollIntoView({ block: "center" });
  (confirmReset.element() as HTMLButtonElement).click();
  await expect.element(review).not.toBeInTheDocument();
  await expect.element(screen.getByRole("textbox", { name: "Edit Name" })).not.toBeInTheDocument();
  await expect.element(reset).toBeDisabled();
  await expect.element(grid.getByRole("gridcell", { name: "Ada", exact: true })).toBeVisible();
});

test("keeps Reset Review outside consumer Table Identity registration", async () => {
  const identityErrors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const otherColumns = [
    {
      columnId: "COL_ID_ID",
      field: "id",
      headerName: "Identity",
      valueType: "text",
    },
  ] satisfies BrunoTableColumns<Row>;
  const screen = await render(
    <>
      <BrunoTableClient
        tableId="TABLE_ID_IDENTITY_OWNER"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        editable
        getRowVersion={(row) => row.revision}
        onSaveEdits={vi.fn(() => Promise.resolve())}
      />
      <BrunoTableClient
        tableId="TABLE_ID_IDENTITY_OWNER:reset-review"
        columns={otherColumns}
        initialOrderBy={[{ columnId: "COL_ID_ID", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
      />
    </>,
  );

  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", {
    name: "Data for TABLE_ID_IDENTITY_OWNER",
    exact: true,
  });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  await userEvent.click(screen.getByRole("button", { name: "Reset edits" }));
  const review = screen.getByRole("alertdialog", { name: "Reset Review" });
  await expect.element(review).toBeVisible();
  await expect.element(review.getByRole("grid", { name: "Reset Review changes" })).toBeVisible();

  expect(identityErrors).not.toHaveBeenCalledWith(
    expect.stringContaining('simultaneous use of tableId "TABLE_ID_IDENTITY_OWNER:reset-review"'),
  );
});

test("Reset preserves the owning table's sorting and Row Selection state", async () => {
  const preferenceRows = [
    { id: "ada", name: "Ada", revision: 1n },
    { id: "grace", name: "Grace", revision: 1n },
  ] as const;
  const screen = await render(
    <BrunoTableClient
      tableId="TABLE_ID_RESET_PREFERENCES"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{
        rows: preferenceRows,
        totalRows: preferenceRows.length,
        version: 1,
        status: "ready",
      }}
      getRowId={(row) => row.id}
      rowSelection
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={vi.fn(() => Promise.resolve())}
    />,
  );

  await userEvent.click(
    screen.getByRole("button", {
      name: "Sort by Name, currently ascending, priority 1",
    }),
  );
  const selectedRow = screen.getByRole("checkbox", { name: "Select row 1" });
  await userEvent.click(selectedRow);
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  await userEvent.click(
    screen
      .getByRole("grid", { name: "Data for TABLE_ID_RESET_PREFERENCES" })
      .getByRole("gridcell", { name: "Grace", exact: true }),
  );
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Amazing Grace");
  await userEvent.keyboard("{Enter}");

  await userEvent.click(screen.getByRole("button", { name: "Reset edits" }));
  const resetAllChanges = screen.getByRole("button", { name: "Reset All Changes" });
  await expect.element(resetAllChanges).toBeEnabled();
  resetAllChanges.element().scrollIntoView({ block: "center" });
  (resetAllChanges.element() as HTMLButtonElement).click();
  await expect
    .element(screen.getByRole("alertdialog", { name: "Reset Review" }))
    .not.toBeInTheDocument();

  await expect.element(screen.getByRole("checkbox", { name: "Select row 1" })).toBeChecked();
  await expect
    .element(screen.getByRole("columnheader", { name: /Name, sorted descending/ }))
    .toHaveAttribute("aria-sort", "descending");
});

test("Reset Review preserves authentic Server presentation and contains synthetic Yours", async () => {
  class PrototypeRow {
    public readonly prefix = "Rendered";

    public constructor(
      public readonly id: string,
      public readonly name: string,
      public readonly revision: bigint,
    ) {}

    public render(value: string): string {
      return `${this.prefix} ${value}`;
    }

    public className(value: string): string {
      return `${this.prefix.toLowerCase()}-${value}`;
    }

    public withEditPatch(patch: Readonly<Partial<Pick<PrototypeRow, "name">>>): PrototypeRow {
      return new PrototypeRow(this.id, patch.name ?? this.name, this.revision);
    }
  }
  const formattedColumns = [
    {
      columnId: "COL_ID_NAME",
      field: "name",
      headerName: "Name",
      valueType: "text",
      cellAlign: "end",
      isEditable: true,
      cellRenderer: ({ row, value }: { readonly row: PrototypeRow; readonly value: string }) =>
        row.render(value),
      cellClassName: ({ row, value }: { readonly row: PrototypeRow; readonly value: string }) =>
        row.className(value),
    },
  ] satisfies BrunoTableColumns<PrototypeRow>;
  const prototypeRows = [new PrototypeRow("ada", "Ada", 1n)] as const;
  const screen = await render(
    <BrunoTableClient
      tableId="TABLE_ID_RESET_PRESENTATION"
      columns={formattedColumns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{
        rows: prototypeRows,
        totalRows: prototypeRows.length,
        version: 1,
        status: "ready",
      }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      projectEditRow={({ row, patch }) => row.withEditPatch(patch)}
      onSaveEdits={vi.fn(() => Promise.resolve())}
    />,
  );

  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_RESET_PRESENTATION" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  await userEvent.click(screen.getByRole("button", { name: "Reset edits" }));

  const review = screen
    .getByRole("alertdialog", { name: "Reset Review" })
    .getByRole("grid", { name: "Reset Review changes" });
  await expect
    .element(review.getByRole("gridcell", { name: "Rendered Ada", exact: true }))
    .toBeVisible();
  const serverValue = review
    .getByRole("gridcell", { name: "Rendered Ada", exact: true })
    .element()
    .closest<HTMLElement>("[role=gridcell]");
  expect(serverValue).not.toBeNull();
  expect(serverValue?.className).toContain("rendered-Ada");
  expect(serverValue?.className).toContain("text-end");
  expect(getComputedStyle(serverValue!).textAlign).toBe("end");
  scrollReviewGridToEnd(review);
  await expect
    .element(review.getByRole("gridcell", { name: "Rendered Augusta", exact: true }))
    .toBeVisible();
});

test("Reset Review contains row-aware Yours while preserving authentic Server formatting", async () => {
  const formatterColumns = [
    {
      columnId: "COL_ID_NAME",
      field: "name",
      headerName: "Name",
      valueType: "text",
      isEditable: true,
      valueFormatter: ({ row, value }: { readonly row: Row; readonly value: string }) =>
        `Formatted ${value} for ${row.id}`,
    },
  ] satisfies BrunoTableColumns<Row>;
  const screen = await render(
    <BrunoTableClient
      tableId="TABLE_ID_RESET_FORMATTER"
      columns={formatterColumns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      projectEditRow={({ row, patch }) => ({ ...row, ...patch })}
      onSaveEdits={vi.fn(() => Promise.resolve())}
    />,
  );

  await userEvent.click(screen.getByRole("switch", { name: "Batch editing", exact: true }));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_RESET_FORMATTER" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  await userEvent.click(screen.getByRole("button", { name: "Reset edits" }));

  const review = screen.getByRole("alertdialog", { name: "Reset Review" }).getByRole("grid");
  await expect
    .element(review.getByRole("gridcell", { name: "Formatted Ada for ada", exact: true }))
    .toBeVisible();
  await expect
    .element(review.getByRole("gridcell", { name: "Formatted Augusta for ada", exact: true }))
    .toBeVisible();
});

test("Reset Review contains unavailable Server values before typed presentation callbacks", async () => {
  type DecodedRow = Readonly<{
    readonly id: string;
    readonly value: string;
    readonly revision: bigint;
  }>;
  const decodeRuntime = (input: unknown) =>
    input === "unavailable"
      ? ({ _tag: "Failure", message: "Unavailable source value." } as const)
      : typeof input === "string"
        ? ({ _tag: "Success", value: input } as const)
        : ({ _tag: "Failure", message: "Expected text." } as const);
  const valueType: BrunoTableValueType<string, "text", "text"> = {
    codecId: "test/reset-review-unavailable",
    codecVersion: 1,
    filterFamily: "text",
    editorFamily: "text",
    cellAlign: "start",
    editorLayout: "inline",
    defaultWidth: 120,
    decodeRuntime,
    equivalent: Object.is,
    compare: (left, right) => (left === right ? 0 : left < right ? -1 : 1),
    formatCanonicalText: String,
    parseCanonicalText: (text) => ({ _tag: "Success", value: text }),
    formatDisplay: String,
    encodePersisted: String,
    decodePersisted: decodeRuntime,
  };
  const valueFormatter = vi.fn(({ value }: { readonly value: string }) => {
    if (value === undefined) throw new Error("typed formatter received unavailable evidence");
    return `Formatted ${value}`;
  });
  const cellClassName = vi.fn(({ value }: { readonly value: string }) => {
    if (value === undefined) throw new Error("typed class callback received unavailable evidence");
    return `value-${value}`;
  });
  const decodedColumns = [
    {
      columnId: "COL_ID_VALUE",
      field: "value",
      headerName: "Value",
      valueType,
      isEditable: true,
      valueFormatter,
      cellClassName,
    },
  ] as const satisfies BrunoTableColumns<DecodedRow>;
  const initialRows: readonly DecodedRow[] = [{ id: "row", value: "server", revision: 1n }];
  const screen = await render(
    <BrunoTableClient
      tableId="TABLE_ID_RESET_UNAVAILABLE"
      columns={decodedColumns}
      initialOrderBy={[{ columnId: "COL_ID_VALUE", direction: "asc" }]}
      clientSource={{ rows: initialRows, totalRows: 1, version: 1, status: "ready" }}
      getRowId={(candidate) => candidate.id}
      editable
      getRowVersion={(candidate) => candidate.revision}
      projectEditRow={({ row, patch }) => ({ ...row, ...patch })}
      onSaveEdits={vi.fn(() => Promise.resolve())}
    />,
  );
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_RESET_UNAVAILABLE" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Value" }), "mine");
  await userEvent.keyboard("{Enter}");

  const unavailableRows: readonly DecodedRow[] = [
    { id: "row", value: "unavailable", revision: 2n },
  ];
  await screen.rerender(
    <BrunoTableClient
      tableId="TABLE_ID_RESET_UNAVAILABLE"
      columns={decodedColumns}
      initialOrderBy={[{ columnId: "COL_ID_VALUE", direction: "asc" }]}
      clientSource={{ rows: unavailableRows, totalRows: 1, version: 2, status: "ready" }}
      getRowId={(candidate) => candidate.id}
      editable
      getRowVersion={(candidate) => candidate.revision}
      projectEditRow={({ row, patch }) => ({ ...row, ...patch })}
      onSaveEdits={vi.fn(() => Promise.resolve())}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Reset edits" }));

  const review = screen.getByRole("alertdialog", { name: "Reset Review" }).getByRole("grid");
  await expect.element(review).toBeVisible();
  await expect.element(review.getByRole("gridcell", { name: "row", exact: true })).toBeVisible();
  scrollReviewGridToEnd(review);
  expect(review.getByRole("gridcell", { name: "Unavailable", exact: true }).all()).toHaveLength(1);
  await expect
    .element(review.getByRole("gridcell", { name: "Formatted mine", exact: true }))
    .toBeVisible();
  expect(valueFormatter.mock.calls.some(([context]) => context.value === undefined)).toBe(false);
  expect(cellClassName.mock.calls.some(([context]) => context.value === undefined)).toBe(false);
});

test("keeps consumer serverText and mineText fields on their configured presentation path", async () => {
  type CollisionRow = Readonly<{
    readonly id: string;
    readonly serverText: string;
    readonly mineText: string;
  }>;
  const collisionColumns = [
    {
      columnId: "COL_ID_SERVER_TEXT",
      field: "serverText",
      headerName: "Consumer Server Text",
      valueType: "text",
      cellAlign: "end",
      cellClassName: "consumer-field",
    },
    {
      columnId: "COL_ID_MINE_TEXT",
      field: "mineText",
      headerName: "Consumer Mine Text",
      valueType: "text",
      cellAlign: "end",
      cellClassName: "consumer-field",
    },
  ] satisfies BrunoTableColumns<CollisionRow>;
  const collisionRows = [
    { id: "row", serverText: "server value", mineText: "mine value" },
  ] as const;
  const screen = await render(
    <BrunoTableClient
      tableId="TABLE_ID_CONSUMER_REVIEW_FIELD_NAMES"
      columns={collisionColumns}
      initialOrderBy={[{ columnId: "COL_ID_SERVER_TEXT", direction: "asc" }]}
      clientSource={{ rows: collisionRows, totalRows: 1, version: 1, status: "ready" }}
      getRowId={(row) => row.id}
    />,
  );

  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_CONSUMER_REVIEW_FIELD_NAMES" });
  for (const value of ["server value", "mine value"] as const) {
    const cell = grid.getByRole("gridcell", { name: value, exact: true }).element();
    expect(cell.className).toContain("consumer-field");
    expect(getComputedStyle(cell).textAlign).toBe("end");
  }
});

test("keeps Reset Review modal focus contained and restores the opener in StrictMode", async () => {
  const screen = await render(
    <StrictMode>
      <BrunoTableClient
        tableId="TABLE_ID_RESET_FOCUS"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
        getRowId={(row) => row.id}
        editable
        getRowVersion={(row) => row.revision}
        onSaveEdits={vi.fn(() => Promise.resolve())}
      />
    </StrictMode>,
  );
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_RESET_FOCUS" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  const reset = screen.getByRole("button", { name: "Reset edits" });
  await userEvent.click(reset);
  const dialog = screen.getByRole("alertdialog", { name: "Reset Review" });
  expect(dialog.element().contains(document.activeElement)).toBe(true);
  await userEvent.keyboard("{Tab}{Tab}{Shift>}{Tab}{/Shift}");
  expect(dialog.element().contains(document.activeElement)).toBe(true);
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(reset).toHaveFocus();
  await expect.element(grid.getByRole("gridcell", { name: "Augusta", exact: true })).toBeVisible();
});

test("restores focus to the owning grid instead of an earlier toolbar grid", async () => {
  const screen = await render(
    <BrunoTableClient
      tableId="TABLE_ID_RESET_OWNED_GRID_FOCUS"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      getRowId={(candidate) => candidate.id}
      editable
      getRowVersion={(candidate) => candidate.revision}
      onSaveEdits={vi.fn(() => Promise.resolve())}
    >
      <BrunoTableToolbar>
        <div aria-label="Consumer toolbar grid" role="grid" tabIndex={0} />
      </BrunoTableToolbar>
    </BrunoTableClient>,
  );
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_RESET_OWNED_GRID_FOCUS" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  await userEvent.click(screen.getByRole("button", { name: "Reset edits" }));
  const confirmReset = screen.getByRole("button", { name: "Reset All Changes" });
  confirmReset.element().scrollIntoView({ block: "center" });
  (confirmReset.element() as HTMLButtonElement).click();

  await expect.element(grid).toHaveFocus();
  await expect
    .element(screen.getByRole("grid", { name: "Consumer toolbar grid" }))
    .not.toHaveFocus();
});

test("restores owning table focus after Reset when an empty body has no grid", async () => {
  const screen = await render(
    <BrunoTableClient
      tableId="TABLE_ID_RESET_EMPTY_FOCUS"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      getRowId={(candidate) => candidate.id}
      editable
      getRowVersion={(candidate) => candidate.revision}
      onSaveEdits={vi.fn(() => Promise.resolve())}
    >
      <BrunoTableToolbar>
        <div aria-label="Consumer toolbar grid" role="grid" tabIndex={0} />
      </BrunoTableToolbar>
    </BrunoTableClient>,
  );
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_RESET_EMPTY_FOCUS" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");

  await screen.rerender(
    <BrunoTableClient
      tableId="TABLE_ID_RESET_EMPTY_FOCUS"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: [] as readonly Row[], totalRows: 0, version: 2, status: "ready" }}
      getRowId={(candidate) => candidate.id}
      editable
      getRowVersion={(candidate) => candidate.revision}
      onSaveEdits={vi.fn(() => Promise.resolve())}
    >
      <BrunoTableToolbar>
        <div aria-label="Consumer toolbar grid" role="grid" tabIndex={0} />
      </BrunoTableToolbar>
    </BrunoTableClient>,
  );
  await expect.element(grid).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Reset edits" }));
  const confirmReset = screen.getByRole("button", { name: "Reset All Changes" });
  confirmReset.element().scrollIntoView({ block: "center" });
  (confirmReset.element() as HTMLButtonElement).click();

  await expect
    .element(screen.getByRole("region", { name: "TABLE_ID_RESET_EMPTY_FOCUS" }))
    .toHaveFocus();
  await expect
    .element(screen.getByRole("grid", { name: "Consumer toolbar grid" }))
    .not.toHaveFocus();
});

test("keeps bounded Batch undo and redo local to the current unsaved session", async () => {
  const screen = await render(
    <BrunoTableClient
      tableId="TABLE_ID_BATCH_HISTORY"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={vi.fn(() => Promise.resolve())}
    />,
  );
  const batchEditing = screen.getByRole("switch", { name: "Batch editing" });
  await userEvent.click(batchEditing);
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_BATCH_HISTORY" });
  expect(grid.element().getAttribute("aria-keyshortcuts")).not.toMatch(/Control\+Z|Meta\+Z/);
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  await expect.element(grid.getByRole("gridcell", { name: "Augusta", exact: true })).toBeVisible();
  expect(grid.element().getAttribute("aria-keyshortcuts")).toMatch(/Control\+Z Meta\+Z/);
  expect(grid.element().getAttribute("aria-keyshortcuts")).not.toMatch(/Control\+Shift\+Z/);

  grid.element().focus();
  await userEvent.keyboard(
    detectPlatform() === "mac" ? "{Meta>}z{/Meta}" : "{Control>}z{/Control}",
  );
  await expect.element(grid.getByRole("gridcell", { name: "Ada", exact: true })).toBeVisible();
  expect(
    screen
      .getByRole("region", { name: "Edit safety" })
      .element()
      .querySelector('[aria-live="polite"]'),
  ).toMatchTextContent("No unsaved changes");
  await expect.element(batchEditing).toBeDisabled();
  expect(grid.element().getAttribute("aria-keyshortcuts")).not.toMatch(/Control\+Z Meta\+Z/);
  expect(grid.element().getAttribute("aria-keyshortcuts")).toMatch(/Control\+Shift\+Z/);
  await screen.rerender(
    <BrunoTableClient
      tableId="TABLE_ID_BATCH_HISTORY"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows, totalRows: rows.length, version: 2, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={vi.fn(() => Promise.resolve())}
    />,
  );
  expect(grid.element().getAttribute("aria-keyshortcuts")).not.toMatch(/Control\+Z Meta\+Z/);
  expect(grid.element().getAttribute("aria-keyshortcuts")).toMatch(/Control\+Shift\+Z/);

  await userEvent.keyboard(
    detectPlatform() === "mac"
      ? "{Meta>}{Shift>}z{/Shift}{/Meta}"
      : "{Control>}{Shift>}z{/Shift}{/Control}",
  );
  await expect.element(grid.getByRole("gridcell", { name: "Augusta", exact: true })).toBeVisible();
  expect(
    screen
      .getByRole("region", { name: "Edit safety" })
      .element()
      .querySelector('[aria-live="polite"]'),
  ).toMatchTextContent("1 unsaved change");

  await userEvent.keyboard(
    detectPlatform() === "mac" ? "{Meta>}z{/Meta}" : "{Control>}z{/Control}",
  );
  await userEvent.click(screen.getByRole("button", { name: "Reset edits" }));
  expect(screen.getByRole("button", { name: "Reset All Changes" }).element()).toHaveAttribute(
    "aria-describedby",
  );
  const historyDescriptionId = screen
    .getByRole("button", { name: "Reset All Changes" })
    .element()
    .getAttribute("aria-describedby");
  expect(document.getElementById(historyDescriptionId ?? "")?.textContent).toContain(
    "1 Batch history command",
  );
  (screen.getByRole("button", { name: "Keep Editing" }).element() as HTMLButtonElement).click();
  await expect
    .element(screen.getByRole("alertdialog", { name: "Reset Review" }))
    .not.toBeInTheDocument();
  grid.element().focus();
  await userEvent.keyboard(
    detectPlatform() === "mac"
      ? "{Meta>}{Shift>}z{/Shift}{/Meta}"
      : "{Control>}{Shift>}z{/Shift}{/Control}",
  );
  await expect.element(grid.getByRole("gridcell", { name: "Augusta", exact: true })).toBeVisible();
  await userEvent.keyboard(
    detectPlatform() === "mac" ? "{Meta>}z{/Meta}" : "{Control>}z{/Control}",
  );
  await userEvent.click(screen.getByRole("button", { name: "Reset edits" }));
  const confirmReset = screen.getByRole("button", { name: "Reset All Changes" });
  confirmReset.element().scrollIntoView({ block: "center" });
  (confirmReset.element() as HTMLButtonElement).click();
  await expect.element(batchEditing).toBeEnabled();
});

test("dispatches Reset and Batch history hotkeys through typed Grid Commands", async () => {
  const commandTypes: string[] = [];
  const resetResults: boolean[] = [];
  const removeListener = installBrunoTableGridCommandListener("TABLE_ID_EDIT_COMMANDS", (command) =>
    commandTypes.push(command.type),
  );
  const screen = await render(
    <BrunoTableClient
      tableId="TABLE_ID_EDIT_COMMANDS"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      getRowId={(candidate) => candidate.id}
      editable
      getRowVersion={(candidate) => candidate.revision}
      onSaveEdits={vi.fn(() => Promise.resolve())}
    >
      <BrunoTableToolbar>
        <ResetCommandProbe onResult={(accepted) => resetResults.push(accepted)} />
      </BrunoTableToolbar>
    </BrunoTableClient>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Dispatch Reset Command" }));
  expect(resetResults).toEqual([false]);
  await expect
    .element(screen.getByRole("alertdialog", { name: "Reset Review" }))
    .not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_EDIT_COMMANDS" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  grid.element().focus();
  await userEvent.keyboard(
    detectPlatform() === "mac" ? "{Meta>}z{/Meta}" : "{Control>}z{/Control}",
  );
  await userEvent.keyboard(
    detectPlatform() === "mac"
      ? "{Meta>}{Shift>}z{/Shift}{/Meta}"
      : "{Control>}{Shift>}z{/Shift}{/Control}",
  );
  await userEvent.click(screen.getByRole("button", { name: "Dispatch Reset Command" }));

  expect(resetResults).toEqual([false, true]);
  await expect.element(screen.getByRole("alertdialog", { name: "Reset Review" })).toBeVisible();
  expect(commandTypes).toEqual(expect.arrayContaining(["edits.undo", "edits.redo", "edits.reset"]));
  removeListener();
});

test("reconciles hidden drafts while filtering leaves the row projection empty", async () => {
  const renderTable = (sourceRows: readonly Row[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_HIDDEN_EDIT_RECONCILIATION"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(candidate) => candidate.id}
      quickFilterFields={["name"]}
      editable
      getRowVersion={(candidate) => candidate.revision}
      onSaveEdits={vi.fn(() => Promise.resolve())}
    >
      <BrunoTableToolbar>
        <BrunoTableQuickFilter />
      </BrunoTableToolbar>
    </BrunoTableClient>
  );
  const screen = await render(renderTable(rows, 1));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_HIDDEN_EDIT_RECONCILIATION" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("searchbox", { name: "Quick Filter" }), "missing");
  await expect
    .element(grid.getByRole("gridcell", { name: "Augusta", exact: true }))
    .not.toBeInTheDocument();

  const convergedRows = [{ id: "ada", name: "Augusta", revision: 2n }] as const;
  await screen.rerender(renderTable(convergedRows, 2));

  await expect
    .element(grid.getByRole("gridcell", { name: "Augusta", exact: true }))
    .not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Reset edits" })).toBeDisabled();
  expect(
    screen
      .getByRole("region", { name: "Edit safety" })
      .element()
      .querySelector('[aria-live="polite"]'),
  ).toMatchTextContent("No unsaved changes");
});

test("does not rescan retained Batch edit evidence for a query-only transition", async () => {
  const getRowVersion = vi.fn((candidate: Row) => candidate.revision);
  const screen = await render(
    <BrunoTableClient
      tableId="TABLE_ID_QUERY_ONLY_EDIT_RECONCILIATION"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      getRowId={(candidate) => candidate.id}
      quickFilterFields={["name"]}
      editable
      getRowVersion={getRowVersion}
      onSaveEdits={vi.fn(() => Promise.resolve())}
    >
      <BrunoTableToolbar>
        <BrunoTableQuickFilter />
      </BrunoTableToolbar>
    </BrunoTableClient>,
  );
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", {
    name: "Data for TABLE_ID_QUERY_ONLY_EDIT_RECONCILIATION",
  });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  getRowVersion.mockClear();

  await userEvent.fill(screen.getByRole("searchbox", { name: "Quick Filter" }), "missing");
  await expect
    .element(grid.getByRole("gridcell", { name: "Augusta", exact: true }))
    .not.toBeInTheDocument();

  expect(getRowVersion).not.toHaveBeenCalled();
});

test("does not treat a filtered in-flight row as authoritative disappearance", async () => {
  let resolveSave!: () => void;
  const onSaveEdits = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveSave = resolve;
      }),
  );
  const renderTable = (sourceRows: readonly Row[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_FILTERED_ACCEPTED_SAVE"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(candidate) => candidate.id}
      quickFilterFields={["name"]}
      editable
      getRowVersion={(candidate) => candidate.revision}
      onSaveEdits={onSaveEdits}
    >
      <BrunoTableToolbar>
        <BrunoTableQuickFilter />
      </BrunoTableToolbar>
    </BrunoTableClient>
  );
  const screen = await render(renderTable(rows, 1));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_FILTERED_ACCEPTED_SAVE" });
  const batchEditing = screen.getByRole("switch", { name: "Batch editing" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("searchbox", { name: "Quick Filter" }), "missing");
  await expect
    .element(grid.getByRole("gridcell", { name: "Augusta", exact: true }))
    .not.toBeInTheDocument();

  resolveSave();
  await expect
    .element(screen.getByRole("region", { name: "Edit safety" }))
    .toMatchTextContent("Immediate save accepted · waiting for live confirmation");
  await expect.element(batchEditing).toBeDisabled();

  const confirmedRows = [{ id: "ada", name: "Augusta", revision: 2n }] as const;
  await screen.rerender(renderTable(confirmedRows, 2));
  await expect.element(batchEditing).toBeEnabled();
  await expect
    .element(grid.getByRole("gridcell", { name: "Augusta", exact: true }))
    .not.toBeInTheDocument();
});

test("retains a filtered rejected save until the raw source converges", async () => {
  const renderTable = (sourceRows: readonly Row[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_FILTERED_REJECTED_SAVE"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(candidate) => candidate.id}
      quickFilterFields={["name"]}
      editable
      getRowVersion={(candidate) => candidate.revision}
      onSaveEdits={() => Promise.reject(new Error("Filtered save failed."))}
    >
      <BrunoTableToolbar>
        <BrunoTableQuickFilter />
      </BrunoTableToolbar>
    </BrunoTableClient>
  );
  const screen = await render(renderTable(rows, 1));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_FILTERED_REJECTED_SAVE" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  await expect.element(screen.getByRole("alert")).toMatchTextContent("A save operation failed.");

  await userEvent.fill(screen.getByRole("searchbox", { name: "Quick Filter" }), "missing");
  await expect.element(screen.getByRole("alert")).toMatchTextContent("A save operation failed.");

  const convergedRows = [{ id: "ada", name: "Augusta", revision: 2n }] as const;
  await screen.rerender(renderTable(convergedRows, 2));
  await expect.poll(() => screen.getByRole("alert").all().length).toBe(0);
});

test("leaves native undo and redo owned by interactive cell content", async () => {
  const interactiveColumns = [
    {
      columnId: "COL_ID_NAME",
      field: "name",
      headerName: "Name",
      valueType: "text",
      isEditable: true,
      cellRenderer: ({ value }: { readonly value: string }) => (
        <input aria-label="Consumer editor" defaultValue={value} />
      ),
    },
  ] satisfies BrunoTableColumns<Row>;
  const screen = await render(
    <BrunoTableClient
      tableId="TABLE_ID_NATIVE_UNDO"
      columns={interactiveColumns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      projectEditRow={({ row, patch }) => ({ ...row, ...patch })}
      onSaveEdits={vi.fn(() => Promise.resolve())}
    />,
  );
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_NATIVE_UNDO" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  const consumerEditor = screen.getByRole("textbox", { name: "Consumer editor" });
  await userEvent.click(consumerEditor);
  await userEvent.keyboard(
    detectPlatform() === "mac" ? "{Meta>}z{/Meta}" : "{Control>}z{/Control}",
  );
  await expect.element(consumerEditor).toHaveFocus();
  expect(
    screen
      .getByRole("region", { name: "Edit safety" })
      .element()
      .querySelector('[aria-live="polite"]'),
  ).toMatchTextContent("1 unsaved change");
  await userEvent.keyboard(
    detectPlatform() === "mac"
      ? "{Meta>}{Shift>}z{/Shift}{/Meta}"
      : "{Control>}{Shift>}z{/Shift}{/Control}",
  );
  await userEvent.keyboard(
    detectPlatform() === "mac" ? "{Meta>}y{/Meta}" : "{Control>}y{/Control}",
  );
  await expect.element(consumerEditor).toHaveFocus();
  expect(
    screen
      .getByRole("region", { name: "Edit safety" })
      .element()
      .querySelector('[aria-live="polite"]'),
  ).toMatchTextContent("1 unsaved change");
});

test("keeps Reset Review stable while live source convergence prunes drafts and history", async () => {
  const screen = await render(
    <BrunoTableClient
      tableId="TABLE_ID_RESET_CONVERGENCE"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={vi.fn(() => Promise.resolve())}
    />,
  );
  const batchEditing = screen.getByRole("switch", { name: "Batch editing" });
  await userEvent.click(batchEditing);
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_RESET_CONVERGENCE" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  await userEvent.click(screen.getByRole("button", { name: "Reset edits" }));

  const convergedRows = [{ id: "ada", name: "Augusta", revision: 2n }] as const;
  await screen.rerender(
    <BrunoTableClient
      tableId="TABLE_ID_RESET_CONVERGENCE"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{
        rows: convergedRows,
        totalRows: convergedRows.length,
        version: 2,
        status: "ready",
      }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={vi.fn(() => Promise.resolve())}
    />,
  );

  await expect.element(screen.getByRole("alertdialog", { name: "Reset Review" })).toBeVisible();
  await expect
    .element(screen.getByRole("alertdialog", { name: "Reset Review" }).getByRole("status"))
    .toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Reset All Changes" })).toBeDisabled();
  expect(
    screen
      .getByRole("region", { name: "Edit safety" })
      .element()
      .querySelector('[aria-live="polite"]'),
  ).toMatchTextContent("No unsaved changes");
  (screen.getByRole("button", { name: "Keep Editing" }).element() as HTMLButtonElement).click();
  await expect.element(grid).toHaveFocus();
  await expect.element(batchEditing).toBeEnabled();
});

test("reconciles a Batch draft after an invalid query candidate restores fallback rows", async () => {
  type QueryFallbackRow = Readonly<{
    readonly id: string;
    readonly name: string;
    readonly score: number;
    readonly revision: bigint;
  }>;
  const queryFallbackColumns = [
    {
      columnId: "COL_ID_NAME",
      field: "name",
      headerName: "Name",
      valueType: "text",
      isEditable: true,
    },
    {
      columnId: "COL_ID_SCORE",
      field: "score",
      headerName: "Score",
      valueType: "number",
    },
  ] satisfies BrunoTableColumns<QueryFallbackRow>;
  const onSaveEdits = vi.fn(() => Promise.resolve());
  const fallbackRows = [
    { id: "ada", name: "Ada", score: 1, revision: 1n },
    { id: "grace", name: "Grace", score: 2, revision: 1n },
  ] as const;
  const renderTable = (
    sourceRows: readonly QueryFallbackRow[],
    version: number,
    status: "ready" | "stale",
  ) => (
    <BrunoTableClient
      tableId="TABLE_ID_BATCH_QUERY_FALLBACK"
      columns={queryFallbackColumns}
      initialOrderBy={[{ columnId: "COL_ID_SCORE", direction: "asc" }]}
      clientSource={{
        rows: sourceRows,
        totalRows: sourceRows.length,
        version,
        status,
        ...(status === "stale" ? { message: "Waiting for a valid projection" } : {}),
      }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />
  );
  const screen = await render(renderTable(fallbackRows, 1, "ready"));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_BATCH_QUERY_FALLBACK" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");

  const invalidCandidateRows = [
    { id: "ada", name: "Augusta", score: "invalid", revision: 2n },
    fallbackRows[1],
  ] as unknown as readonly QueryFallbackRow[];
  await screen.rerender(renderTable(invalidCandidateRows, 2, "stale"));

  await expect
    .element(grid.getByRole("gridcell", { name: "Augusta", exact: true }))
    .toBeInTheDocument();
  await vi.waitFor(() =>
    expect(
      screen
        .getByRole("region", { name: "Edit safety" })
        .element()
        .querySelector('[aria-live="polite"]'),
    ).toMatchTextContent("1 unsaved change"),
  );
  const save = screen.getByRole("button", { name: "Save" });
  await expect.element(save).toBeEnabled();
  await userEvent.click(save);
  expect(onSaveEdits).toHaveBeenCalledWith([
    {
      rowId: "ada",
      baseRow: fallbackRows[0],
      expectedVersion: 1n,
      changes: [
        {
          columnId: "COL_ID_NAME",
          field: "name",
          before: "Ada",
          after: "Augusta",
        },
      ],
    },
  ]);
});

test("reconciles an active editor after an invalid query candidate restores its fallback row", async () => {
  const fallbackRows = [
    { id: "ada", name: "Ada", revision: 1n },
    { id: "grace", name: "Grace", revision: 1n },
  ] as const;
  const renderTable = (sourceRows: readonly Row[], version: number, status: "ready" | "stale") => (
    <BrunoTableClient
      tableId="TABLE_ID_ACTIVE_EDITOR_QUERY_FALLBACK"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{
        rows: sourceRows,
        totalRows: sourceRows.length,
        version,
        status,
        ...(status === "stale" ? { message: "Waiting for a valid projection" } : {}),
      }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={vi.fn(() => Promise.resolve())}
    />
  );
  const screen = await render(renderTable(fallbackRows, 1, "ready"));
  const grid = screen.getByRole("grid", {
    name: "Data for TABLE_ID_ACTIVE_EDITOR_QUERY_FALLBACK",
  });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  const editor = screen.getByRole("textbox", { name: "Edit Name" });
  await userEvent.fill(editor, "Augusta");

  const invalidCandidateRows = [
    { id: "grace", name: 42, revision: 2n },
    { id: "hopper", name: "Hopper", revision: 1n },
  ] as unknown as readonly Row[];
  await screen.rerender(renderTable(invalidCandidateRows, 2, "stale"));

  await expect.element(editor).toBeVisible();
  await expect.element(editor).toHaveValue("Augusta");
  await userEvent.click(editor);
  await userEvent.keyboard("{Enter}");
  await expect
    .element(grid.getByRole("gridcell", { name: "Augusta", exact: true }))
    .toBeInTheDocument();
});

test("preserves missing-row drafts as blocked work and reconnects the same Row Identity", async () => {
  const onSaveEdits = vi.fn(() => Promise.resolve());
  const screen = await render(
    <BrunoTableClient
      tableId="TABLE_ID_BLOCKED_DRAFT"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />,
  );
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_BLOCKED_DRAFT" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");

  await screen.rerender(
    <BrunoTableClient
      tableId="TABLE_ID_BLOCKED_DRAFT"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: [] as readonly Row[], totalRows: 0, version: 2, status: "loading" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />,
  );
  expect(
    screen
      .getByRole("region", { name: "Edit safety" })
      .element()
      .querySelector('[aria-live="polite"]'),
  ).toMatchTextContent("1 unsaved change");
  await expect.element(screen.getByRole("button", { name: "Save" })).toBeDisabled();

  await screen.rerender(
    <BrunoTableClient
      tableId="TABLE_ID_BLOCKED_DRAFT"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: [] as readonly Row[], totalRows: 0, version: 3, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />,
  );
  expect(
    screen
      .getByRole("region", { name: "Edit safety" })
      .element()
      .querySelector('[aria-live="polite"]'),
  ).toMatchTextContent("1 blocked change · 1 unsaved");
  await expect.element(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Reset edits" }));
  await expect
    .element(
      screen
        .getByRole("alertdialog", { name: "Reset Review" })
        .getByRole("grid")
        .getByRole("gridcell", {
          name: "This row was removed from the server. Changes cannot be saved.",
        }),
    )
    .toBeVisible();
  (screen.getByRole("button", { name: "Keep Editing" }).element() as HTMLButtonElement).click();
  await expect
    .element(screen.getByRole("alertdialog", { name: "Reset Review" }))
    .not.toBeInTheDocument();

  const returnedRows = [{ id: "ada", name: "Ada", revision: 3n }] as const;
  await screen.rerender(
    <BrunoTableClient
      tableId="TABLE_ID_BLOCKED_DRAFT"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{
        rows: returnedRows,
        totalRows: returnedRows.length,
        version: 4,
        status: "ready",
      }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />,
  );
  expect(
    screen
      .getByRole("region", { name: "Edit safety" })
      .element()
      .querySelector('[aria-live="polite"]'),
  ).toMatchTextContent("1 unsaved change");
  await expect.element(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  await expect.element(grid.getByRole("gridcell", { name: "Augusta", exact: true })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(onSaveEdits).toHaveBeenCalledOnce();
  expect(onSaveEdits).toHaveBeenNthCalledWith(1, [
    {
      rowId: "ada",
      baseRow: returnedRows[0],
      expectedVersion: 3n,
      changes: [
        {
          columnId: "COL_ID_NAME",
          field: "name",
          before: "Ada",
          after: "Augusta",
        },
      ],
    },
  ]);
});

test("exposes live conflict and permission-block evidence without replacing Yours", async () => {
  const permissionColumns = [
    {
      columnId: "COL_ID_NAME",
      field: "name",
      headerName: "Name",
      valueType: "text",
      isEditable: ({ row: candidate }: { readonly row: Row }) => candidate.name !== "Locked",
    },
  ] satisfies BrunoTableColumns<Row>;
  const onSaveEdits = vi.fn(() => Promise.resolve());
  const renderTable = (sourceRows: readonly Row[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_LIVE_CONFLICT_PERMISSION"
      columns={permissionColumns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{
        rows: sourceRows,
        totalRows: sourceRows.length,
        version,
        status: "ready",
      }}
      getRowId={(candidate) => candidate.id}
      editable
      getRowVersion={(candidate) => candidate.revision}
      onSaveEdits={onSaveEdits}
    />
  );
  const screen = await render(renderTable(rows, 1));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", {
    name: "Data for TABLE_ID_LIVE_CONFLICT_PERMISSION",
  });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");

  await screen.rerender(renderTable([{ id: "ada", name: "Locked", revision: 2n }] as const, 2));

  const conflictedCell = grid.getByRole("gridcell", { name: "Augusta", exact: true });
  await expect.element(conflictedCell).toHaveAttribute("data-bruno-edit-conflicted", "");
  const conflictMarker = conflictedCell
    .element()
    .querySelector<HTMLElement>("[data-bruno-edit-conflict-indicator]");
  expect(conflictMarker).not.toBeNull();
  await expect.element(conflictMarker!).toBeVisible();
  await expect
    .element(conflictMarker!)
    .toHaveAttribute("title", "Conflicts with the latest server value");
  await expect.element(conflictedCell).toHaveAttribute("data-bruno-edit-blocked", "");
  const editStateDescriptionId = conflictedCell.element().getAttribute("aria-describedby");
  expect(editStateDescriptionId).not.toBeNull();
  const editStateDescription = document.getElementById(editStateDescriptionId!);
  expect(editStateDescription).not.toBeNull();
  await expect.element(editStateDescription!).toHaveClass("sr-only");
  await expect
    .element(editStateDescription!)
    .toMatchTextContent(
      "This cell is no longer editable. The server value also conflicts with your unsaved change.",
    );
  await expect
    .element(conflictedCell)
    .toHaveAccessibleDescription(
      "This cell is no longer editable. The server value also conflicts with your unsaved change.",
    );
  await expect
    .element(screen.getByRole("region", { name: "Edit safety" }))
    .toMatchTextContent("1 conflict · 1 blocked change · 1 unsaved");
  await expect.element(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(onSaveEdits).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole("button", { name: "1 conflict" }));
  const blockedConflictReview = screen.getByRole("alertdialog", { name: "Conflict Review" });
  blockedConflictReview
    .getByRole("grid", { name: "Conflict Review changes" })
    .element().scrollLeft = blockedConflictReview
    .getByRole("grid", { name: "Conflict Review changes" })
    .element().scrollWidth;
  const blockedMine = blockedConflictReview.getByRole("button", {
    name: /Keep Mine for row ada, column Name.*blocked/,
  });
  await expect.element(blockedMine).toBeDisabled();
  await expect
    .element(blockedMine)
    .toHaveAttribute("title", "Keep Mine is unavailable while this change is blocked.");
  await expect
    .element(
      blockedConflictReview.getByRole("button", {
        name: /^Keep Server for row ada, column Name(?:\.|$)/u,
      }),
    )
    .toBeEnabled();
  await expect.element(blockedConflictReview.getByRole("button", { name: "Save" })).toBeDisabled();
  await userEvent.click(blockedConflictReview.getByRole("button", { name: "Cancel" }));
  await expect.element(blockedConflictReview).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "1 conflict" })).toHaveFocus();

  await screen.rerender(renderTable([{ id: "ada", name: "Locked", revision: 3n }] as const, 3));
  await expect.element(screen.getByRole("button", { name: "1 conflict" })).toBeVisible();

  await screen.rerender(renderTable([{ id: "ada", name: "Server", revision: 1n }] as const, 4));
  await expect.element(conflictedCell).toHaveAttribute("data-bruno-edit-conflicted", "");
  await expect.element(conflictedCell).not.toHaveAttribute("data-bruno-edit-blocked");
  await expect
    .element(screen.getByRole("region", { name: "Edit safety" }))
    .toMatchTextContent("1 conflict · 1 unsaved");

  await userEvent.click(grid.getByRole("gridcell", { name: "Augusta", exact: true }));
  await userEvent.keyboard("{F2}");
  const conflictEditor = screen.getByRole("textbox", { name: "Edit Name" });
  await expect
    .element(conflictEditor)
    .toHaveAccessibleDescription("The server value conflicts with your unsaved change.");
  const activeConflictControl = screen.getByRole("button", { name: "1 conflict" });
  await expect.element(activeConflictControl).toBeDisabled();
  await expect
    .element(activeConflictControl)
    .toHaveAttribute("title", "Finish editing the active cell before reviewing conflicts");
  await expect
    .element(screen.getByRole("alertdialog", { name: "Conflict Review" }))
    .not.toBeInTheDocument();
  const activeConflictMarker = conflictedCell
    .element()
    .querySelector<HTMLElement>("[data-bruno-edit-conflict-indicator]");
  expect(activeConflictMarker).not.toBeNull();
  await expect.element(activeConflictMarker!).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(activeConflictControl).toBeEnabled();

  await screen.rerender(renderTable([{ id: "ada", name: "Augusta", revision: 0n }] as const, 5));
  const convergedCell = grid.getByRole("gridcell", { name: "Augusta", exact: true });
  await expect.element(convergedCell).not.toHaveAttribute("data-bruno-edit-conflicted");
  await expect.element(convergedCell).not.toHaveAttribute("data-bruno-edit-blocked");
  await expect
    .element(screen.getByRole("region", { name: "Edit safety" }))
    .toMatchTextContent("No unsaved changes");
});

test("reviews every conflict explicitly and safely rebases Mine before Batch Save", async () => {
  let resolveSave!: () => void;
  const onSaveEdits = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveSave = resolve;
      }),
  );
  const renderTable = (sourceRows: readonly Row[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_CONFLICT_REVIEW"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{
        rows: sourceRows,
        totalRows: sourceRows.length,
        version,
        status: "ready",
      }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />
  );
  const screen = await render(renderTable(rows, 1));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_CONFLICT_REVIEW" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");

  const latestRows = [{ id: "ada", name: "Server", revision: 2n }] as const;
  await screen.rerender(renderTable(latestRows, 2));
  const conflictControl = screen.getByRole("button", { name: "1 conflict" });
  await expect.element(conflictControl).toBeVisible();
  await userEvent.click(conflictControl);

  let review = screen.getByRole("alertdialog", { name: "Conflict Review" });
  const reviewGrid = review.getByRole("grid", { name: "Conflict Review changes" });
  await expect
    .element(reviewGrid.getByRole("gridcell", { name: "Ada", exact: true }))
    .toBeVisible();
  await userEvent.click(review.getByRole("button", { name: "Cancel" }));
  await expect.element(conflictControl).toHaveFocus();

  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  review = screen.getByRole("alertdialog", { name: "Conflict Review" });
  const reopenedGrid = review.getByRole("grid", { name: "Conflict Review changes" });
  scrollReviewGridToEnd(reopenedGrid);
  await expect
    .element(reopenedGrid.getByRole("gridcell", { name: "Server", exact: true }))
    .toBeVisible();
  await expect
    .element(reopenedGrid.getByRole("gridcell", { name: "Augusta", exact: true }))
    .toBeVisible();
  await expect.element(review.getByRole("button", { name: "Save" })).toBeDisabled();
  const mineChoice = review.getByRole("button", {
    name: /^Keep Mine for row ada, column Name(?:\.|$)/u,
  });
  await userEvent.click(mineChoice);
  await expect.element(mineChoice).toHaveAttribute("aria-pressed", "true");
  await expect.element(review.getByRole("button", { name: "Save" })).toBeEnabled();
  const sameVersionRows = [{ id: "ada", name: "Same Version Server", revision: 2n }] as const;
  await screen.rerender(renderTable(sameVersionRows, 3));
  scrollReviewGridToEnd(reopenedGrid);
  await expect
    .element(reopenedGrid.getByRole("gridcell", { name: "Same Version Server", exact: true }))
    .toBeVisible();
  await expect.element(review.getByRole("button", { name: "Save" })).toBeDisabled();
  const sameVersionMineChoice = review.getByRole("button", {
    name: /^Keep Mine for row ada, column Name(?:\.|$)/u,
  });
  await expect.element(sameVersionMineChoice).toHaveAttribute("aria-pressed", "false");
  await expect.element(sameVersionMineChoice).toBeEnabled();
  await userEvent.click(sameVersionMineChoice);
  await expect.element(sameVersionMineChoice).toHaveAttribute("aria-pressed", "true");
  await expect.element(review.getByRole("button", { name: "Save" })).toBeEnabled();
  const newestRows = [{ id: "ada", name: "Newer Server", revision: 3n }] as const;
  await screen.rerender(renderTable(newestRows, 4));
  scrollReviewGridToEnd(reopenedGrid);
  await expect.element(review.getByRole("button", { name: "Save" })).toBeDisabled();
  const refreshedMineChoice = review.getByRole("button", {
    name: /^Keep Mine for row ada, column Name(?:\.|$)/u,
  });
  await expect.element(refreshedMineChoice).toHaveAttribute("aria-pressed", "false");
  await userEvent.click(refreshedMineChoice);
  await expect.element(review.getByRole("button", { name: "Save" })).toBeEnabled();
  const versionOnlyRows = [{ id: "ada", name: "Newer Server", revision: 4n }] as const;
  await screen.rerender(renderTable(versionOnlyRows, 5));
  await expect.element(refreshedMineChoice).toHaveAttribute("aria-pressed", "false");
  await expect.element(refreshedMineChoice).toBeEnabled();
  await expect.element(review.getByRole("button", { name: "Save" })).toBeDisabled();
  await userEvent.click(refreshedMineChoice);
  await userEvent.click(review.getByRole("button", { name: "Save" }));
  expect(onSaveEdits).toHaveBeenCalledOnce();
  await expect.element(review).toBeVisible();
  await expect.element(review.getByRole("button", { name: "Cancel" })).toBeDisabled();
  expect(onSaveEdits).toHaveBeenCalledWith([
    {
      rowId: "ada",
      baseRow: versionOnlyRows[0],
      expectedVersion: 4n,
      changes: [
        {
          columnId: "COL_ID_NAME",
          field: "name",
          before: "Newer Server",
          after: "Augusta",
        },
      ],
    },
  ]);
  resolveSave();
  await expect.element(review).not.toBeInTheDocument();
});

test("discards one conflict with Server as one reversible local command", async () => {
  const onSaveEdits = vi.fn(() => Promise.resolve());
  const onHistoryResult = vi.fn();
  const renderTable = (sourceRows: readonly Row[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_CONFLICT_REVIEW_SERVER"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    >
      <BrunoTableToolbar>
        <HistoryCommandProbe onResult={onHistoryResult} />
      </BrunoTableToolbar>
    </BrunoTableClient>
  );
  const screen = await render(renderTable(rows, 1));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_CONFLICT_REVIEW_SERVER" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  await screen.rerender(renderTable([{ id: "ada", name: "Server", revision: 2n }] as const, 2));
  await userEvent.click(screen.getByRole("button", { name: "1 conflict" }));
  let review = screen.getByRole("alertdialog", { name: "Conflict Review" });
  let reviewGrid = review.getByRole("grid", { name: "Conflict Review changes" });
  scrollReviewGridToEnd(reviewGrid);
  let serverChoice = review.getByRole("button", {
    name: /^Keep Server for row ada, column Name(?:\.|$)/u,
  });
  await userEvent.click(serverChoice);

  await expect.element(serverChoice).toHaveAttribute("aria-pressed", "true");
  await expect.element(serverChoice).toBeDisabled();
  await expect
    .element(review.getByRole("button", { name: /^Keep Mine for row ada, column Name(?:\.|$)/u }))
    .toBeDisabled();
  await userEvent.click(review.getByRole("button", { name: "Save" }));
  await expect.element(review).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("region", { name: "Edit safety" }))
    .toMatchTextContent("No unsaved changes");
  expect(onSaveEdits).not.toHaveBeenCalled();
  await screen.rerender(renderTable([{ id: "ada", name: "Server", revision: 3n }] as const, 3));
  await expect.element(screen.getByRole("button", { name: "1 conflict" })).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Test Undo" }));
  const restoredConflict = screen.getByRole("button", { name: "1 conflict" });
  await expect.element(restoredConflict).toBeVisible();
  await userEvent.click(restoredConflict);
  const restoredReview = screen.getByRole("alertdialog", { name: "Conflict Review" });
  restoredReview.getByRole("grid", { name: "Conflict Review changes" }).element().scrollLeft =
    restoredReview.getByRole("grid", { name: "Conflict Review changes" }).element().scrollWidth;
  await expect
    .element(
      restoredReview.getByRole("button", { name: /^Keep Mine for row ada, column Name(?:\.|$)/u }),
    )
    .toBeEnabled();
  await expect
    .element(
      restoredReview.getByRole("button", {
        name: /^Keep Server for row ada, column Name(?:\.|$)/u,
      }),
    )
    .toBeEnabled();
  await userEvent.click(restoredReview.getByRole("button", { name: "Cancel" }));
  await userEvent.click(screen.getByRole("button", { name: "Test Redo" }));
  await expect.element(screen.getByRole("button", { name: "1 conflict" })).not.toBeInTheDocument();
  await screen.rerender(
    renderTable([{ id: "ada", name: "After Redo Server", revision: 5n }] as const, 5),
  );
  await userEvent.click(screen.getByRole("button", { name: "Test Undo" }));
  const latestConflict = screen.getByRole("button", { name: "1 conflict" });
  await expect.element(latestConflict).toBeVisible();
  await userEvent.click(latestConflict);
  const latestReview = screen.getByRole("alertdialog", { name: "Conflict Review" });
  const latestReviewGrid = latestReview.getByRole("grid", { name: "Conflict Review changes" });
  scrollReviewGridToEnd(latestReviewGrid);
  await expect
    .poll(() =>
      latestReviewGrid
        .getByRole("gridcell")
        .all()
        .map((cell) => cell.element().textContent),
    )
    .toEqual(expect.arrayContaining(["After Redo Server", "Augusta"]));
  await userEvent.click(latestReview.getByRole("button", { name: "Cancel" }));
  await screen.rerender(
    renderTable([{ id: "ada", name: "After Undo Server", revision: 6n }] as const, 6),
  );
  await userEvent.click(screen.getByRole("button", { name: "Test Redo" }));
  expect(onHistoryResult).toHaveBeenLastCalledWith("redo", true);
  await expect.element(screen.getByRole("button", { name: "1 conflict" })).not.toBeInTheDocument();
});

test.each(["mine", "server"] as const)(
  "keeps a safely rebased draft conflict-free after undoing a %s resolution",
  async (resolution) => {
    const tableId = `TABLE_ID_SAFE_REBASE_${resolution.toUpperCase()}`;
    const onHistoryResult = vi.fn();
    const renderTable = (sourceRows: readonly Row[], version: number) => (
      <BrunoTableClient
        tableId={tableId}
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
        getRowId={(row) => row.id}
        editable
        getRowVersion={(row) => row.revision}
        onSaveEdits={() => Promise.resolve()}
      >
        <BrunoTableToolbar>
          <HistoryCommandProbe onResult={onHistoryResult} />
        </BrunoTableToolbar>
      </BrunoTableClient>
    );
    const screen = await render(renderTable(rows, 1));
    await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
    const grid = screen.getByRole("grid", { name: `Data for ${tableId}` });
    grid.element().focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
    await userEvent.keyboard("{Enter}");
    await screen.rerender(renderTable([{ id: "ada", name: "Server", revision: 2n }] as const, 2));
    await userEvent.click(screen.getByRole("button", { name: "1 conflict" }));
    const review = screen.getByRole("alertdialog", { name: "Conflict Review" });
    const reviewGrid = review.getByRole("grid", { name: "Conflict Review changes" });
    scrollReviewGridToEnd(reviewGrid);
    await userEvent.click(
      review.getByRole("button", {
        name: `${resolution === "mine" ? "Keep Mine" : "Keep Server"} for row ada, column Name`,
      }),
    );
    await userEvent.click(review.getByRole("button", { name: "Cancel" }));
    await userEvent.click(screen.getByRole("button", { name: "Test Undo" }));
    await expect.element(screen.getByRole("button", { name: "1 conflict" })).toBeVisible();

    await screen.rerender(renderTable([{ id: "ada", name: "Ada", revision: 3n }] as const, 3));
    await expect
      .element(screen.getByRole("button", { name: "1 conflict" }))
      .not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("region", { name: "Edit safety" }))
      .toMatchTextContent("1 unsaved change");
    await userEvent.click(screen.getByRole("button", { name: "Test Redo" }));
    expect(onHistoryResult).toHaveBeenLastCalledWith("redo", false);
    await userEvent.click(screen.getByRole("button", { name: "Test Undo" }));
    await expect
      .element(screen.getByRole("region", { name: "Edit safety" }))
      .toMatchTextContent("No unsaved changes");
  },
);

test("keeps Conflict Review open when its Save is rejected", async () => {
  let rejectSave!: (reason: Error) => void;
  const onSaveEdits = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectSave = reject;
      }),
  );
  const renderTable = (sourceRows: readonly Row[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_CONFLICT_REVIEW_REJECTION"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />
  );
  const screen = await render(renderTable(rows, 1));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_CONFLICT_REVIEW_REJECTION" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  await screen.rerender(renderTable([{ id: "ada", name: "Server", revision: 2n }] as const, 2));
  await userEvent.click(screen.getByRole("button", { name: "1 conflict" }));
  const review = screen.getByRole("alertdialog", { name: "Conflict Review" });
  const reviewGrid = review.getByRole("grid", { name: "Conflict Review changes" });
  scrollReviewGridToEnd(reviewGrid);
  await userEvent.click(
    review.getByRole("button", { name: /^Keep Mine for row ada, column Name(?:\.|$)/u }),
  );
  await userEvent.click(review.getByRole("button", { name: "Save" }));
  expect(onSaveEdits).toHaveBeenCalledOnce();
  rejectSave(new Error("Compare-and-set rejected the save."));
  await expect.element(review).toBeVisible();
  await expect
    .element(reviewGrid.getByRole("gridcell", { name: "Augusta", exact: true }))
    .toBeVisible();
  await expect
    .element(review.getByRole("button", { name: /^Keep Mine for row ada, column Name(?:\.|$)/u }))
    .toHaveAttribute("aria-pressed", "true");
});

test("keeps Conflict Review closed when a conflict-free footer Save is rejected", async () => {
  let rejectSave!: (reason: Error) => void;
  const screen = await render(
    <BrunoTableClient
      tableId="TABLE_ID_CONFLICT_FREE_REJECTION"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows, totalRows: rows.length, version: 1, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={() =>
        new Promise<void>((_resolve, reject) => {
          rejectSave = reject;
        })
      }
    />,
  );
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_CONFLICT_FREE_REJECTION" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  rejectSave(new Error("Rejected without a conflict."));

  await expect
    .element(screen.getByRole("alertdialog", { name: "Conflict Review" }))
    .not.toBeInTheDocument();
});

test("clears a canceled Conflict Review choice after a successful footer Save", async () => {
  let resolveSave!: () => void;
  const onSaveEdits = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveSave = resolve;
      }),
  );
  const renderTable = (sourceRows: readonly Row[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_CONFLICT_FOOTER_SUCCESS"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />
  );
  const screen = await render(renderTable(rows, 1));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_CONFLICT_FOOTER_SUCCESS" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  await screen.rerender(renderTable([{ id: "ada", name: "Server", revision: 2n }] as const, 2));
  await userEvent.click(screen.getByRole("button", { name: "1 conflict" }));
  let review = screen.getByRole("alertdialog", { name: "Conflict Review" });
  review.getByRole("grid", { name: "Conflict Review changes" }).element().scrollLeft = review
    .getByRole("grid", { name: "Conflict Review changes" })
    .element().scrollWidth;
  await userEvent.click(
    review.getByRole("button", { name: /^Keep Mine for row ada, column Name(?:\.|$)/u }),
  );
  await userEvent.click(review.getByRole("button", { name: "Cancel" }));

  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(onSaveEdits).toHaveBeenCalledOnce();
  resolveSave();
  await expect
    .element(screen.getByRole("region", { name: "Edit safety" }))
    .toMatchTextContent("No unsaved changes");
  await screen.rerender(renderTable([{ id: "ada", name: "Augusta", revision: 3n }] as const, 3));

  grid.element().focus();
  await userEvent.keyboard("{F2}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Next");
  await userEvent.keyboard("{Enter}");
  await screen.rerender(renderTable([{ id: "ada", name: "Remote", revision: 4n }] as const, 4));
  await userEvent.click(screen.getByRole("button", { name: "1 conflict" }));
  review = screen.getByRole("alertdialog", { name: "Conflict Review" });
  review.getByRole("grid", { name: "Conflict Review changes" }).element().scrollLeft = review
    .getByRole("grid", { name: "Conflict Review changes" })
    .element().scrollWidth;
  const mine = review.getByRole("button", { name: /^Keep Mine for row ada, column Name(?:\.|$)/u });
  const server = review.getByRole("button", {
    name: /^Keep Server for row ada, column Name(?:\.|$)/u,
  });
  await expect.element(mine).toHaveAttribute("aria-pressed", "false");
  await expect.element(server).toHaveAttribute("aria-pressed", "false");
  await expect.element(mine).toBeEnabled();
  await expect.element(server).toBeEnabled();
});

test("refuses conflict resolution atomically when current Row Version extraction fails", async () => {
  let failVersionExtraction = false;
  const renderTable = (sourceRows: readonly Row[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_CONFLICT_REVIEW_VERSION_FAILURE"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => {
        if (failVersionExtraction) throw new Error("Version unavailable.");
        return row.revision;
      }}
      onSaveEdits={() => Promise.resolve()}
    />
  );
  const screen = await render(renderTable(rows, 1));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", {
    name: "Data for TABLE_ID_CONFLICT_REVIEW_VERSION_FAILURE",
  });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  const serverRows = [{ id: "ada", name: "Server", revision: 2n }] as const;
  await screen.rerender(renderTable(serverRows, 2));
  await userEvent.click(screen.getByRole("button", { name: "1 conflict" }));
  const review = screen.getByRole("alertdialog", { name: "Conflict Review" });
  const reviewGrid = review.getByRole("grid", { name: "Conflict Review changes" });
  scrollReviewGridToEnd(reviewGrid);
  failVersionExtraction = true;
  await screen.rerender(renderTable(serverRows, 3));

  const mine = review.getByRole("button", {
    name: /Keep Mine for row ada, column Name.*latest source evidence is ready/,
  });
  await expect.element(mine).toBeDisabled();
  await expect
    .element(mine)
    .toHaveAttribute(
      "title",
      "Conflict choices are unavailable until the latest source evidence is ready.",
    );
  await expect.element(mine).toHaveAttribute("aria-pressed", "false");
  await expect.element(review.getByRole("button", { name: "Save" })).toBeDisabled();
});

test("keeps an open Conflict Review stable when every conflict converges externally", async () => {
  const renderTable = (sourceRows: readonly Row[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_CONFLICT_REVIEW_CONVERGENCE"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={() => Promise.resolve()}
    />
  );
  const screen = await render(renderTable(rows, 1));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", {
    name: "Data for TABLE_ID_CONFLICT_REVIEW_CONVERGENCE",
  });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  await screen.rerender(renderTable([{ id: "ada", name: "Server", revision: 2n }], 2));
  await userEvent.click(screen.getByRole("button", { name: "1 conflict" }));
  const review = screen.getByRole("alertdialog", { name: "Conflict Review" });
  await userEvent.click(review.getByRole("checkbox", { name: "Select row 1" }));
  await expect
    .element(review.getByRole("button", { name: "Apply Mine to Selected" }))
    .toBeEnabled();
  const convergingReviewGrid = review.getByRole("grid", { name: "Conflict Review changes" });
  scrollReviewGridToEnd(convergingReviewGrid);
  await userEvent.click(
    review.getByRole("button", { name: /^Keep Mine for row ada, column Name(?:\.|$)/u }),
  );

  await screen.rerender(renderTable([{ id: "ada", name: "Augusta", revision: 3n }], 3));

  await expect.element(review).toBeVisible();
  await expect.element(review.getByRole("status")).toMatchTextContent("All conflicts are current.");
  await expect
    .element(review.getByRole("grid", { name: "Conflict Review changes" }))
    .not.toBeInTheDocument();
  await expect
    .element(review.getByRole("button", { name: "Apply Mine to Selected" }))
    .toBeDisabled();
  await expect
    .element(review.getByRole("button", { name: "Apply Server to Selected" }))
    .toBeDisabled();
  await expect.element(review.getByRole("button", { name: "Save" })).toBeDisabled();
  await expect
    .element(screen.getByRole("region", { name: "Edit safety" }))
    .toMatchTextContent("No unsaved changes");
  await userEvent.click(review.getByRole("button", { name: "Cancel" }));
  await expect.element(review).not.toBeInTheDocument();
});

test("saves remaining Batch work when an open Conflict Review becomes all-current", async () => {
  const initialRows = [
    { id: "ada", name: "Ada", revision: 1n },
    { id: "grace", name: "Grace", revision: 1n },
  ] as const;
  let resolveSave!: () => void;
  const onSaveEdits = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveSave = resolve;
      }),
  );
  const renderTable = (sourceRows: readonly Row[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_ALL_CURRENT_REVIEW_SAVE"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    />
  );
  const screen = await render(renderTable(initialRows, 1));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_ALL_CURRENT_REVIEW_SAVE" });
  await userEvent.click(grid.getByRole("gridcell", { name: "Ada", exact: true }));
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  await userEvent.click(grid.getByRole("gridcell", { name: "Grace", exact: true }));
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Amazing Grace");
  await userEvent.keyboard("{Enter}");

  const conflictedRows = [{ id: "ada", name: "Server", revision: 2n }, initialRows[1]] as const;
  await screen.rerender(renderTable(conflictedRows, 2));
  await userEvent.click(screen.getByRole("button", { name: "1 conflict" }));
  const review = screen.getByRole("alertdialog", { name: "Conflict Review" });

  const convergedRows = [{ id: "ada", name: "Augusta", revision: 3n }, initialRows[1]] as const;
  await screen.rerender(renderTable(convergedRows, 3));
  await expect.element(review).toBeVisible();
  await expect.element(review.getByRole("status")).toMatchTextContent("All conflicts are current.");
  const save = review.getByRole("button", { name: "Save" });
  await expect.element(save).toBeEnabled();

  await userEvent.click(save);
  expect(onSaveEdits).toHaveBeenCalledWith([
    {
      rowId: "grace",
      baseRow: initialRows[1],
      expectedVersion: 1n,
      changes: [
        {
          columnId: "COL_ID_NAME",
          field: "name",
          before: "Grace",
          after: "Amazing Grace",
        },
      ],
    },
  ]);
  await expect.element(review).toBeVisible();
  resolveSave();
  await expect.element(review).not.toBeInTheDocument();
});

test("disables bulk conflict actions after the selected conflict is resolved with Server", async () => {
  const renderTable = (sourceRows: readonly Row[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_CONFLICT_REVIEW_RESOLVED_SELECTION"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={() => Promise.resolve()}
    />
  );
  const screen = await render(renderTable(rows, 1));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", {
    name: "Data for TABLE_ID_CONFLICT_REVIEW_RESOLVED_SELECTION",
  });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  await screen.rerender(renderTable([{ id: "ada", name: "Server", revision: 2n }], 2));
  await userEvent.click(screen.getByRole("button", { name: "1 conflict" }));
  const review = screen.getByRole("alertdialog", { name: "Conflict Review" });
  await userEvent.click(review.getByRole("checkbox", { name: "Select row 1" }));
  await expect
    .element(review.getByRole("button", { name: "Apply Mine to Selected" }))
    .toBeEnabled();
  const reviewGrid = review.getByRole("grid", { name: "Conflict Review changes" });
  scrollReviewGridToEnd(reviewGrid);
  await userEvent.click(
    review.getByRole("button", { name: /^Keep Server for row ada, column Name(?:\.|$)/u }),
  );
  await expect
    .element(review.getByRole("button", { name: "Apply Mine to Selected" }))
    .toBeDisabled();
  await expect
    .element(review.getByRole("button", { name: "Apply Server to Selected" }))
    .toBeDisabled();
  await screen.rerender(renderTable([{ id: "ada", name: "Augusta", revision: 3n }], 3));
  await expect.element(review).toBeVisible();
  await expect.element(review.getByRole("status")).toMatchTextContent("All conflicts are current.");
  await expect
    .element(review.getByRole("grid", { name: "Conflict Review changes" }))
    .not.toBeInTheDocument();
  await expect.element(review.getByRole("button", { name: "Save" })).toBeDisabled();
});

test("returns review focus to the owning grid when another table has the same opener", async () => {
  const firstRows = [{ id: "ada", name: "Ada", revision: 1n }] as const;
  const secondRows = [{ id: "grace", name: "Grace", revision: 1n }] as const;
  const renderTables = (
    firstSource: readonly Row[],
    secondSource: readonly Row[],
    version: number,
  ) => (
    <>
      <BrunoTableClient
        tableId="TABLE_ID_FIRST_CONFLICT_FOCUS"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{
          rows: firstSource,
          totalRows: firstSource.length,
          version,
          status: "ready",
        }}
        getRowId={(row) => row.id}
        editable
        getRowVersion={(row) => row.revision}
        onSaveEdits={() => Promise.resolve()}
      />
      <BrunoTableClient
        tableId="TABLE_ID_SECOND_CONFLICT_FOCUS"
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
        clientSource={{
          rows: secondSource,
          totalRows: secondSource.length,
          version,
          status: "ready",
        }}
        getRowId={(row) => row.id}
        editable
        getRowVersion={(row) => row.revision}
        onSaveEdits={() => Promise.resolve()}
      />
    </>
  );
  const screen = await render(renderTables(firstRows, secondRows, 1));
  const switches = screen.getByRole("switch", { name: "Batch editing" }).all();
  await userEvent.click(switches[0]!);
  await userEvent.click(switches[1]!);
  const firstGrid = screen.getByRole("grid", { name: "Data for TABLE_ID_FIRST_CONFLICT_FOCUS" });
  const secondGrid = screen.getByRole("grid", { name: "Data for TABLE_ID_SECOND_CONFLICT_FOCUS" });
  firstGrid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  secondGrid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Amazing Grace");
  await userEvent.keyboard("{Enter}");
  const secondServerRows = [{ id: "grace", name: "Server Grace", revision: 2n }] as const;
  await screen.rerender(
    renderTables([{ id: "ada", name: "Server Ada", revision: 2n }], secondServerRows, 2),
  );
  const conflictOpeners = screen.getByRole("button", { name: "1 conflict" }).all();
  await userEvent.click(conflictOpeners[0]!);
  const review = screen.getByRole("alertdialog", { name: "Conflict Review" });
  await screen.rerender(
    renderTables([{ id: "ada", name: "Augusta", revision: 3n }], secondServerRows, 3),
  );
  await userEvent.click(review.getByRole("button", { name: "Cancel" }));
  await expect.element(firstGrid).toHaveFocus();
  await expect.element(screen.getByRole("button", { name: "1 conflict" })).not.toHaveFocus();
});

test("uses projected review order for Shift range selection", async () => {
  const initialRows = [
    { id: "alpha", name: "Alpha", revision: 1n },
    { id: "mike", name: "Mike", revision: 1n },
    { id: "zeta", name: "Zeta", revision: 1n },
  ] as const;
  const renderTable = (sourceRows: readonly Row[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_CONFLICT_REVIEW_SHIFT_ORDER"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={() => Promise.resolve()}
    />
  );
  const screen = await render(renderTable(initialRows, 1));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_CONFLICT_REVIEW_SHIFT_ORDER" });
  for (const [source, draft] of [
    ["Alpha", "Draft Alpha"],
    ["Zeta", "Draft Zeta"],
    ["Mike", "Draft Mike"],
  ] as const) {
    await userEvent.click(grid.getByRole("gridcell", { name: source, exact: true }));
    await userEvent.keyboard("{Enter}");
    await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), draft);
    await userEvent.keyboard("{Enter}");
  }
  await screen.rerender(
    renderTable(
      [
        { id: "alpha", name: "Server Alpha", revision: 2n },
        { id: "mike", name: "Server Mike", revision: 2n },
        { id: "zeta", name: "Server Zeta", revision: 2n },
      ],
      2,
    ),
  );
  await userEvent.click(screen.getByRole("button", { name: "3 conflicts" }));
  const review = screen.getByRole("alertdialog", { name: "Conflict Review" });
  const first = review.getByRole("checkbox", { name: "Select row 1" });
  const second = review.getByRole("checkbox", { name: "Select row 2" });
  const third = review.getByRole("checkbox", { name: "Select row 3" });
  await userEvent.click(first);
  await userEvent.keyboard("{Shift>}");
  second.element().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  await userEvent.keyboard("{/Shift}");
  await expect.element(first).toBeChecked();
  await expect.element(second).toBeChecked();
  await expect.element(third).not.toBeChecked();
});

test("refreshes an open Conflict Review when conflict membership swaps at the same count", async () => {
  const initialRows = [
    { id: "ada", name: "Ada", revision: 1n },
    { id: "grace", name: "Grace", revision: 1n },
  ] as const;
  const renderTable = (sourceRows: readonly Row[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_CONFLICT_REVIEW_MEMBERSHIP_SWAP"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={() => Promise.resolve()}
    />
  );
  const screen = await render(renderTable(initialRows, 1));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", {
    name: "Data for TABLE_ID_CONFLICT_REVIEW_MEMBERSHIP_SWAP",
  });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}{ArrowDown}{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Amazing Grace");
  await userEvent.keyboard("{Enter}");

  await screen.rerender(
    renderTable(
      [
        { id: "ada", name: "Server Ada", revision: 2n },
        { id: "grace", name: "Grace", revision: 2n },
      ],
      2,
    ),
  );
  await userEvent.click(screen.getByRole("button", { name: "1 conflict" }));
  const review = screen.getByRole("alertdialog", { name: "Conflict Review" });
  const reviewGrid = review.getByRole("grid", { name: "Conflict Review changes" });
  await expect
    .element(reviewGrid.getByRole("gridcell", { name: "Ada", exact: true }))
    .toBeVisible();

  await screen.rerender(
    renderTable(
      [
        { id: "ada", name: "Ada", revision: 3n },
        { id: "grace", name: "Server Grace", revision: 3n },
      ],
      3,
    ),
  );
  await expect
    .element(reviewGrid.getByRole("gridcell", { name: "Grace", exact: true }))
    .toBeVisible();
  await expect
    .element(reviewGrid.getByRole("gridcell", { name: "Ada", exact: true }))
    .not.toBeInTheDocument();
});

test("contains row-aware Yours instead of fabricating a sibling-draft projection", async () => {
  type PresentationRow = Readonly<{
    readonly id: string;
    readonly name: string;
    readonly context: string;
    readonly revision: bigint;
  }>;
  const presentationColumns = [
    {
      columnId: "COL_ID_NAME",
      field: "name",
      headerName: "Name",
      valueType: "text",
      isEditable: true,
      valueFormatter: ({ row, value }: { readonly row: PresentationRow; readonly value: string }) =>
        `${row.context}: ${value}`,
    },
    {
      columnId: "COL_ID_CONTEXT",
      field: "context",
      headerName: "Context",
      valueType: "text",
      isEditable: true,
    },
  ] satisfies BrunoTableColumns<PresentationRow>;
  const initialRows = [{ id: "ada", name: "Ada", context: "Base context", revision: 1n }] as const;
  const renderTable = (sourceRows: readonly PresentationRow[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_CONFLICT_REVIEW_PROJECTED_SIBLINGS"
      columns={presentationColumns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      projectEditRow={({ row, patch }) => ({ ...row, ...patch })}
      onSaveEdits={() => Promise.resolve()}
    />
  );
  const screen = await render(renderTable(initialRows, 1));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", {
    name: "Data for TABLE_ID_CONFLICT_REVIEW_PROJECTED_SIBLINGS",
  });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}{ArrowRight}{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Context" }), "Local context");
  await userEvent.keyboard("{Enter}");

  await screen.rerender(
    renderTable([{ id: "ada", name: "Server", context: "Base context", revision: 2n }], 2),
  );
  await userEvent.click(screen.getByRole("button", { name: "1 conflict" }));
  const reviewGrid = screen
    .getByRole("alertdialog", { name: "Conflict Review" })
    .getByRole("grid", { name: "Conflict Review changes" });
  scrollReviewGridToEnd(reviewGrid);
  await expect
    .element(reviewGrid.getByRole("gridcell", { name: "Local context: Augusta", exact: true }))
    .toBeVisible();
});

test("Conflict Review preserves authentic Base and Server presentation and contains Yours", async () => {
  class PrototypeConflictRow {
    public readonly prefix = "Rendered";

    public constructor(
      public readonly id: string,
      public readonly name: string,
      public readonly revision: bigint,
    ) {}

    public render(value: string): string {
      return `${this.prefix} ${value}`;
    }

    public className(value: string): string {
      return `conflict-${value.replaceAll(" ", "-")}`;
    }

    public withEditPatch(
      patch: Readonly<Partial<Pick<PrototypeConflictRow, "name">>>,
    ): PrototypeConflictRow {
      return new PrototypeConflictRow(this.id, patch.name ?? this.name, this.revision);
    }
  }
  const conflictColumns = [
    {
      columnId: "COL_ID_NAME",
      field: "name",
      headerName: "Name",
      valueType: "text",
      cellAlign: "end",
      isEditable: true,
      cellRenderer: ({
        row,
        value,
      }: {
        readonly row: PrototypeConflictRow;
        readonly value: string;
      }) => row.render(value),
      cellClassName: ({
        row,
        value,
      }: {
        readonly row: PrototypeConflictRow;
        readonly value: string;
      }) => row.className(value),
    },
  ] satisfies BrunoTableColumns<PrototypeConflictRow>;
  const renderTable = (sourceRows: readonly PrototypeConflictRow[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_CONFLICT_REVIEW_PRESENTATION"
      columns={conflictColumns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      projectEditRow={({ row, patch }) => row.withEditPatch(patch)}
      onSaveEdits={() => Promise.resolve()}
    />
  );
  const screen = await render(renderTable([new PrototypeConflictRow("ada", "Ada", 1n)], 1));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", {
    name: "Data for TABLE_ID_CONFLICT_REVIEW_PRESENTATION",
  });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  await screen.rerender(renderTable([new PrototypeConflictRow("ada", "Server", 2n)], 2));
  await userEvent.click(screen.getByRole("button", { name: "1 conflict" }));
  const reviewGrid = screen
    .getByRole("alertdialog", { name: "Conflict Review" })
    .getByRole("grid", { name: "Conflict Review changes" });
  const rendered = new Map<string, HTMLElement>();
  for (let offset = 0; offset <= reviewGrid.element().scrollWidth; offset += 120) {
    reviewGrid.element().scrollLeft = offset;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    for (const cell of reviewGrid.getByRole("gridcell").all()) {
      const element = cell.element();
      if (element instanceof HTMLElement && element.textContent?.startsWith("Rendered ")) {
        rendered.set(element.textContent, element);
      }
    }
  }
  scrollReviewGridToEnd(reviewGrid);
  for (const cell of reviewGrid.getByRole("gridcell").all()) {
    const element = cell.element();
    if (element instanceof HTMLElement && element.textContent?.startsWith("Rendered ")) {
      rendered.set(element.textContent, element);
    }
  }
  for (const label of ["Rendered Ada", "Rendered Server", "Rendered Augusta"] as const) {
    const cell = rendered.get(label);
    expect(cell, label).toBeDefined();
    expect(cell?.className).toContain(`conflict-${label.replace("Rendered ", "")}`);
    expect(cell?.className).toContain("text-end");
    expect(getComputedStyle(cell!).textAlign).toBe("end");
  }
});

test("resolves an explicit selected conflict set as one reversible Batch command", async () => {
  const onSaveEdits = vi.fn(() => Promise.resolve());
  const initialRows = [
    { id: "ada", name: "Ada", revision: 1n },
    { id: "grace", name: "Grace", revision: 1n },
  ] as const;
  const renderTable = (sourceRows: readonly Row[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_CONFLICT_REVIEW_SELECTED_SET"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    >
      <BrunoTableToolbar>
        <HistoryCommandProbe />
      </BrunoTableToolbar>
    </BrunoTableClient>
  );
  const screen = await render(renderTable(initialRows, 1));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", {
    name: "Data for TABLE_ID_CONFLICT_REVIEW_SELECTED_SET",
  });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}{ArrowDown}{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Amazing Grace");
  await userEvent.keyboard("{Enter}");
  await screen.rerender(
    renderTable(
      [
        { id: "ada", name: "Server Ada", revision: 2n },
        { id: "grace", name: "Server Grace", revision: 2n },
      ],
      2,
    ),
  );

  const conflictOpener = screen.getByRole("button", { name: "2 conflicts" });
  await userEvent.click(conflictOpener);
  const review = screen.getByRole("alertdialog", { name: "Conflict Review" });
  const reviewGrid = review.getByRole("grid", { name: "Conflict Review changes" });
  reviewGrid.element().focus();
  await userEvent.keyboard("{Space}{ArrowDown}{Shift>}{Space}{/Shift}");
  const applyMine = review.getByRole("button", { name: "Apply Mine to Selected" });
  await expect.element(applyMine).toBeEnabled();
  applyMine.element().focus();
  await userEvent.keyboard("{Enter}");
  expect(onSaveEdits).not.toHaveBeenCalled();
  await userEvent.click(review.getByRole("button", { name: "Cancel" }));
  await expect.element(grid).toHaveFocus();

  await userEvent.click(screen.getByRole("button", { name: "Test Undo" }));
  const restoredConflicts = screen.getByRole("button", { name: "2 conflicts" });
  await expect.element(restoredConflicts).toBeVisible();
  await userEvent.click(restoredConflicts);
  const restoredReview = screen.getByRole("alertdialog", { name: "Conflict Review" });
  restoredReview.getByRole("grid", { name: "Conflict Review changes" }).element().scrollLeft =
    restoredReview.getByRole("grid", { name: "Conflict Review changes" }).element().scrollWidth;
  await expect
    .element(
      restoredReview.getByRole("button", { name: /^Keep Mine for row ada, column Name(?:\.|$)/u }),
    )
    .toBeEnabled();
  await expect
    .element(
      restoredReview.getByRole("button", {
        name: /^Keep Server for row ada, column Name(?:\.|$)/u,
      }),
    )
    .toBeEnabled();
  await userEvent.click(restoredReview.getByRole("button", { name: "Cancel" }));
  await userEvent.click(screen.getByRole("button", { name: "Test Redo" }));
  await expect.element(screen.getByRole("button", { name: "2 conflicts" })).not.toBeInTheDocument();
  await screen.rerender(
    renderTable(
      [
        { id: "ada", name: "Latest Ada", revision: 3n },
        { id: "grace", name: "Latest Grace", revision: 3n },
      ],
      3,
    ),
  );
  await expect.element(screen.getByRole("button", { name: "2 conflicts" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Test Undo" }));
  await expect.element(screen.getByRole("button", { name: "1 conflict" })).toBeVisible();
  expect(onSaveEdits).not.toHaveBeenCalled();
});

test("discards only selected blocked changes as one undoable Batch command", async () => {
  const onSaveEdits = vi.fn(() => Promise.resolve());
  const initialRows = [
    { id: "ada", name: "Ada", revision: 1n },
    { id: "grace", name: "Grace", revision: 1n },
  ] as const;
  const permissionColumns = [
    {
      columnId: "COL_ID_NAME",
      field: "name",
      headerName: "Name",
      valueType: "text",
      isEditable: ({ row }: { readonly row: Row }) => row.name !== "Locked",
    },
  ] satisfies BrunoTableColumns<Row>;
  const renderTable = (sourceRows: readonly Row[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_BLOCKED_REVIEW"
      columns={permissionColumns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={onSaveEdits}
    >
      <BrunoTableToolbar>
        <HistoryCommandProbe />
      </BrunoTableToolbar>
    </BrunoTableClient>
  );
  const screen = await render(renderTable(initialRows, 1));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_BLOCKED_REVIEW" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}{ArrowDown}{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Amazing Grace");
  await userEvent.keyboard("{Enter}");
  const lockedRows = [
    { id: "ada", name: "Locked", revision: 2n },
    { id: "grace", name: "Locked", revision: 2n },
  ] as const;
  await screen.rerender(renderTable(lockedRows, 2));

  const blockedOpener = screen.getByRole("button", { name: "2 blocked changes" });
  await userEvent.click(blockedOpener);
  const review = screen.getByRole("alertdialog", { name: "Blocked Changes Review" });
  const reviewGrid = review.getByRole("grid", { name: "Blocked Changes Review changes" });
  await expect
    .element(reviewGrid.getByRole("gridcell", { name: "Locked", exact: true }).first())
    .toBeVisible();
  const discard = review.getByRole("button", { name: "Discard Selected Changes" });
  await expect.element(discard).toBeDisabled();
  await userEvent.click(review.getByRole("checkbox", { name: "Select row 1" }));
  await userEvent.click(review.getByRole("checkbox", { name: "Select row 2" }));
  await expect.element(discard).toBeEnabled();
  await userEvent.click(discard);
  await expect
    .element(review.getByRole("status"))
    .toMatchTextContent("All blocked changes are current.");
  expect(onSaveEdits).not.toHaveBeenCalled();
  await userEvent.click(review.getByRole("button", { name: "Close" }));
  await expect.element(grid).toHaveFocus();

  await userEvent.click(screen.getByRole("button", { name: "Test Undo" }));
  await expect.element(screen.getByRole("button", { name: "2 blocked changes" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Test Redo" }));
  await expect
    .element(screen.getByRole("button", { name: "2 blocked changes" }))
    .not.toBeInTheDocument();
  expect(onSaveEdits).not.toHaveBeenCalled();
});

test("does not offer targeted discard for a blocked active candidate", async () => {
  const permissionColumns = [
    {
      columnId: "COL_ID_NAME",
      field: "name",
      headerName: "Name",
      valueType: "text",
      isEditable: ({ row: candidate }: { readonly row: Row }) => candidate.name !== "Locked",
    },
  ] satisfies BrunoTableColumns<Row>;
  const renderTable = (sourceRows: readonly Row[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_BLOCKED_ACTIVE_CANDIDATE_REVIEW"
      columns={permissionColumns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={() => Promise.resolve()}
    />
  );
  const screen = await render(renderTable(rows, 1));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", {
    name: "Data for TABLE_ID_BLOCKED_ACTIVE_CANDIDATE_REVIEW",
  });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");

  await screen.rerender(renderTable([{ id: "ada", name: "Locked", revision: 2n }], 2));
  const blockedReviewButton = screen.getByRole("button", { name: "1 blocked change" });
  await userEvent.click(blockedReviewButton);
  const review = screen.getByRole("alertdialog", { name: "Blocked Changes Review" });
  await expect.element(review).toBeVisible();
  expect(
    review
      .getByRole("grid", { name: "Blocked Changes Review changes" })
      .element()
      .getAttribute("aria-keyshortcuts"),
  ).not.toMatch(/Control\+C|Meta\+C/);
  const blockedRowCheckbox = review.getByRole("checkbox", { name: "Select row 1" });
  await userEvent.click(blockedRowCheckbox);
  await expect.element(blockedRowCheckbox).toBeChecked();
  await expect
    .element(review.getByRole("button", { name: "Discard Selected Changes" }))
    .toBeDisabled();
  await expect
    .element(review.getByRole("status"))
    .toMatchTextContent("Finish or cancel the active edit before discarding it.");
  await userEvent.click(review.getByRole("button", { name: "Close" }));
  blockedReviewButton.element().focus();
  await userEvent.keyboard("{Enter}");
  await expect
    .element(screen.getByRole("alertdialog", { name: "Blocked Changes Review" }))
    .toBeVisible();
});

test("refreshes selected blocked discardability when a Batch save lock releases", async () => {
  let rejectSave!: (reason: Error) => void;
  const permissionColumns = [
    {
      columnId: "COL_ID_NAME",
      field: "name",
      headerName: "Name",
      valueType: "text",
      isEditable: ({ row: candidate }: { readonly row: Row }) => candidate.revision === 1n,
    },
  ] satisfies BrunoTableColumns<Row>;
  const renderTable = (sourceRows: readonly Row[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_BLOCKED_SAVE_LOCK_REVIEW"
      columns={permissionColumns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(candidate) => candidate.id}
      editable
      getRowVersion={(candidate) => candidate.revision}
      onSaveEdits={() =>
        new Promise<void>((_resolve, reject) => {
          rejectSave = reject;
        })
      }
    />
  );
  const screen = await render(renderTable(rows, 1));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_BLOCKED_SAVE_LOCK_REVIEW" });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));

  await screen.rerender(renderTable([{ id: "ada", name: "Ada", revision: 2n }], 2));
  await userEvent.click(screen.getByRole("button", { name: "1 blocked change" }));
  const review = screen.getByRole("alertdialog", { name: "Blocked Changes Review" });
  await userEvent.click(review.getByRole("checkbox", { name: "Select row 1" }));
  const discard = review.getByRole("button", { name: "Discard Selected Changes" });
  await expect.element(discard).toBeDisabled();
  await expect
    .element(review.getByRole("status"))
    .toMatchTextContent("Wait for the current save to finish before discarding these changes.");
  await expect
    .element(review.getByRole("status"))
    .not.toMatchTextContent("Finish or cancel the active edit");

  rejectSave(new Error("The save lost its compare-and-set race."));
  await expect.element(review.getByRole("checkbox", { name: "Select row 1" })).toBeChecked();
  await expect.element(discard).toBeEnabled();
});

test("keeps Blocked Changes Review stable when every row converges externally", async () => {
  const permissionColumns = [
    {
      columnId: "COL_ID_NAME",
      field: "name",
      headerName: "Name",
      valueType: "text",
      isEditable: ({ row }: { readonly row: Row }) => row.name !== "Locked",
    },
  ] satisfies BrunoTableColumns<Row>;
  const renderTable = (sourceRows: readonly Row[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_BLOCKED_REVIEW_CONVERGENCE"
      columns={permissionColumns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={() => Promise.resolve()}
    />
  );
  const screen = await render(renderTable(rows, 1));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", {
    name: "Data for TABLE_ID_BLOCKED_REVIEW_CONVERGENCE",
  });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}");
  await screen.rerender(renderTable([{ id: "ada", name: "Locked", revision: 2n }], 2));
  await userEvent.click(screen.getByRole("button", { name: "1 blocked change" }));
  const review = screen.getByRole("alertdialog", { name: "Blocked Changes Review" });
  await userEvent.click(review.getByRole("checkbox", { name: "Select row 1" }));
  await expect
    .element(review.getByRole("button", { name: "Discard Selected Changes" }))
    .toBeEnabled();

  await screen.rerender(renderTable([{ id: "ada", name: "Augusta", revision: 3n }], 3));
  await expect.element(review).toBeVisible();
  await expect
    .element(review.getByRole("status"))
    .toMatchTextContent("All blocked changes are current.");
  await expect
    .element(review.getByRole("button", { name: "Discard Selected Changes" }))
    .toBeDisabled();
  await expect
    .element(review.getByRole("grid", { name: "Blocked Changes Review changes" }))
    .not.toBeInTheDocument();
});

test("refreshes an open Blocked Changes Review when blocked membership swaps at the same count", async () => {
  const initialRows = [
    { id: "ada", name: "Ada", revision: 1n },
    { id: "grace", name: "Grace", revision: 1n },
  ] as const;
  const permissionColumns = [
    {
      columnId: "COL_ID_NAME",
      field: "name",
      headerName: "Name",
      valueType: "text",
      isEditable: ({ row }: { readonly row: Row }) => row.name !== "Locked",
    },
  ] satisfies BrunoTableColumns<Row>;
  const renderTable = (sourceRows: readonly Row[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_BLOCKED_REVIEW_MEMBERSHIP_SWAP"
      columns={permissionColumns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={() => Promise.resolve()}
    />
  );
  const screen = await render(renderTable(initialRows, 1));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", {
    name: "Data for TABLE_ID_BLOCKED_REVIEW_MEMBERSHIP_SWAP",
  });
  grid.element().focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Augusta");
  await userEvent.keyboard("{Enter}{ArrowDown}{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Name" }), "Amazing Grace");
  await userEvent.keyboard("{Enter}");

  await screen.rerender(
    renderTable(
      [
        { id: "ada", name: "Locked", revision: 2n },
        { id: "grace", name: "Grace", revision: 2n },
      ],
      2,
    ),
  );
  await userEvent.click(screen.getByRole("button", { name: "1 blocked change" }));
  const review = screen.getByRole("alertdialog", { name: "Blocked Changes Review" });
  const reviewGrid = review.getByRole("grid", { name: "Blocked Changes Review changes" });
  await expect
    .element(reviewGrid.getByRole("gridcell", { name: "ada", exact: true }))
    .toBeVisible();

  await screen.rerender(
    renderTable(
      [
        { id: "ada", name: "Ada", revision: 3n },
        { id: "grace", name: "Locked", revision: 3n },
      ],
      3,
    ),
  );
  await expect
    .element(reviewGrid.getByRole("gridcell", { name: "grace", exact: true }))
    .toBeVisible();
  await expect
    .element(reviewGrid.getByRole("gridcell", { name: "ada", exact: true }))
    .not.toBeInTheDocument();
});

test("publishes ordinary live row updates without creating edit-owned evidence", async () => {
  const renderTable = (sourceRows: readonly Row[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_ORDINARY_LIVE_EDIT_UPDATE"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
      clientSource={{
        rows: sourceRows,
        totalRows: sourceRows.length,
        version,
        status: "ready",
      }}
      getRowId={(candidate) => candidate.id}
      editable
      getRowVersion={(candidate) => candidate.revision}
      onSaveEdits={() => Promise.resolve()}
    />
  );
  const screen = await render(renderTable(rows, 1));
  const grid = screen.getByRole("grid", {
    name: "Data for TABLE_ID_ORDINARY_LIVE_EDIT_UPDATE",
  });

  await screen.rerender(renderTable([{ id: "ada", name: "Augusta", revision: 0n }] as const, 2));

  const cell = grid.getByRole("gridcell", { name: "Augusta", exact: true });
  await expect.element(cell).toBeVisible();
  await expect.element(cell).not.toHaveAttribute("data-bruno-edit-conflicted");
  await expect.element(cell).not.toHaveAttribute("data-bruno-edit-blocked");
  await expect
    .element(screen.getByRole("region", { name: "Edit safety" }))
    .toMatchTextContent("No unsaved changes");
});
