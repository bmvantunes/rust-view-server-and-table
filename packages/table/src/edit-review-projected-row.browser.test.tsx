import { afterEach, expect, test, vi } from "vite-plus/test";
import { userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { BrunoTableClient } from "./index";
import type { BrunoTableColumns } from "./public-types";

afterEach(async () => {
  await cleanup();
});

type ReviewRow = Readonly<{
  readonly id: string;
  readonly formatted: string;
  readonly styled: string;
  readonly rendered: string;
  readonly mineContext: string;
  readonly serverContext: string;
  readonly amount: bigint;
  readonly optional: number | undefined;
  readonly permission: "editable" | "blocked";
  readonly revision: bigint;
}>;

type ReviewEditPatch = Readonly<
  Partial<
    Pick<
      ReviewRow,
      "formatted" | "styled" | "rendered" | "mineContext" | "serverContext" | "amount" | "optional"
    >
  >
>;

type ReviewPresentation = Readonly<{
  readonly present: (kind: string, value: unknown) => string;
  readonly style: (value: unknown) => string;
}>;

type ProjectableReviewRow = ReviewRow & ReviewPresentation;

const MINE_AMOUNT = 900_719_925_474_099_312_345_678_901_234_567_891n;
const SERVER_AMOUNT = 900_719_925_474_099_312_345_678_901_234_567_899n;

function presentationText(kind: string, identity: string, row: ReviewRow, value: unknown): string {
  return [
    kind,
    identity,
    row.mineContext,
    row.serverContext,
    String(row.amount),
    row.optional === undefined ? "UNDEFINED" : String(row.optional),
    String(value),
  ].join("|");
}

function presentationClass(row: ReviewRow, value: unknown): string {
  const normalize = (input: unknown) =>
    String(input)
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-|-$/g, "");
  return [
    "projected",
    normalize(row.mineContext),
    normalize(row.serverContext),
    normalize(row.amount),
    row.optional === undefined ? "undefined" : normalize(row.optional),
    normalize(value),
  ].join("-");
}

function createColumns(isEditable?: (context: { readonly row: ProjectableReviewRow }) => boolean) {
  const editPolicy = isEditable ?? true;
  return [
    {
      columnId: "COL_ID_FORMATTED",
      field: "formatted",
      headerName: "Formatted",
      valueType: "text",
      isEditable: editPolicy,
      valueFormatter: ({
        row,
        value,
      }: {
        readonly row: ProjectableReviewRow;
        readonly value: string;
      }) => row.present("FORMAT", value),
    },
    {
      columnId: "COL_ID_STYLED",
      field: "styled",
      headerName: "Styled",
      valueType: "text",
      isEditable: editPolicy,
      cellClassName: ({
        row,
        value,
      }: {
        readonly row: ProjectableReviewRow;
        readonly value: string;
      }) => row.style(value),
    },
    {
      columnId: "COL_ID_RENDERED",
      field: "rendered",
      headerName: "Rendered",
      valueType: "text",
      isEditable: editPolicy,
      cellRenderer: ({
        row,
        value,
      }: {
        readonly row: ProjectableReviewRow;
        readonly value: string;
      }) => row.present("RENDER", value),
    },
    {
      columnId: "COL_ID_MINE_CONTEXT",
      field: "mineContext",
      headerName: "Mine context",
      valueType: "text",
      isEditable: editPolicy,
    },
    {
      columnId: "COL_ID_SERVER_CONTEXT",
      field: "serverContext",
      headerName: "Server context",
      valueType: "text",
      isEditable: editPolicy,
    },
    {
      columnId: "COL_ID_AMOUNT",
      field: "amount",
      headerName: "Amount",
      valueType: "bigint",
      isEditable: editPolicy,
    },
    {
      columnId: "COL_ID_OPTIONAL",
      field: "optional",
      headerName: "Optional",
      valueType: "number",
      blankValue: undefined,
      isEditable: editPolicy,
    },
  ] satisfies BrunoTableColumns<ProjectableReviewRow>;
}

function freezePlainRow(values: ReviewRow): ProjectableReviewRow {
  let result!: ProjectableReviewRow;
  result = Object.freeze({
    ...values,
    present(kind: string, value: unknown) {
      return presentationText(kind, "PLAIN", result, value);
    },
    style(value: unknown) {
      return presentationClass(result, value);
    },
  });
  return result;
}

function projectPlainRow({
  row,
  patch,
}: {
  readonly row: ProjectableReviewRow;
  readonly patch: ReviewEditPatch;
}): ProjectableReviewRow {
  return freezePlainRow({ ...row, ...patch });
}

const CLASS_ROW_TOKEN = Symbol("ClassReviewRow");
const classRowIdentities = new WeakMap<object, string>();

class ClassReviewRow implements ReviewRow, ReviewPresentation {
  readonly #brand: string;

  public constructor(token: typeof CLASS_ROW_TOKEN, values: ReviewRow, identity: string) {
    if (token !== CLASS_ROW_TOKEN) throw new TypeError("ClassReviewRow requires its domain token.");
    this.#brand = "PRIVATE";
    this.id = values.id;
    this.formatted = values.formatted;
    this.styled = values.styled;
    this.rendered = values.rendered;
    this.mineContext = values.mineContext;
    this.serverContext = values.serverContext;
    this.amount = values.amount;
    this.optional = values.optional;
    this.permission = values.permission;
    this.revision = values.revision;
    classRowIdentities.set(this, identity);
    Object.freeze(this);
  }

  public readonly id: string;
  public readonly formatted: string;
  public readonly styled: string;
  public readonly rendered: string;
  public readonly mineContext: string;
  public readonly serverContext: string;
  public readonly amount: bigint;
  public readonly optional: number | undefined;
  public readonly permission: "editable" | "blocked";
  public readonly revision: bigint;

  public present(kind: string, value: unknown): string {
    return presentationText(
      kind,
      `${this.#brand}:${classRowIdentities.get(this) ?? "MISSING"}`,
      this,
      value,
    );
  }

  public style(value: unknown): string {
    return presentationClass(this, value);
  }

  public withEditPatch(patch: ReviewEditPatch): ClassReviewRow {
    return new ClassReviewRow(
      CLASS_ROW_TOKEN,
      {
        id: this.id,
        formatted: this.formatted,
        styled: this.styled,
        rendered: this.rendered,
        mineContext: this.mineContext,
        serverContext: this.serverContext,
        amount: this.amount,
        optional: this.optional,
        permission: this.permission,
        revision: this.revision,
        ...patch,
      },
      classRowIdentities.get(this) ?? "MISSING",
    );
  }
}

function classRow(values: ReviewRow): ClassReviewRow {
  return new ClassReviewRow(CLASS_ROW_TOKEN, values, "WEAKMAP");
}

async function nextBrowserFrame(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function revealReviewCell(
  reviewGrid: ReturnType<Awaited<ReturnType<typeof render>>["getByRole"]>,
  name: string,
): Promise<HTMLElement> {
  const grid = reviewGrid.element();
  const finalOffset = grid.scrollWidth;
  const offsets = [0];
  for (let offset = 120; offset < finalOffset; offset += 120) offsets.push(offset);
  offsets.push(finalOffset);
  for (const offset of offsets) {
    grid.scrollLeft = offset;
    grid.dispatchEvent(new Event("scroll"));
    await nextBrowserFrame();
    const cells = reviewGrid.getByRole("gridcell", { name, exact: true }).all();
    if (cells.length === 0) continue;
    await expect.element(cells[0]!).toBeVisible();
    const cell = cells[0]!.element();
    if (!(cell instanceof HTMLElement)) throw new TypeError("Review cell is not an HTMLElement.");
    return cell;
  }
  throw new Error(`Review cell was not revealed: ${name}`);
}

async function editVisibleCell(
  screen: Awaited<ReturnType<typeof render>>,
  grid: ReturnType<Awaited<ReturnType<typeof render>>["getByRole"]>,
  currentName: string,
  headerName: string,
  nextText: string,
  editorRole: "spinbutton" | "textbox" = "textbox",
): Promise<void> {
  await revealReviewCell(grid, currentName);
  const cell = grid.getByRole("gridcell", { name: currentName, exact: true }).first();
  await userEvent.click(cell);
  await userEvent.keyboard("{Enter}");
  const editor = screen.getByRole(editorRole, { name: `Edit ${headerName}` });
  await userEvent.fill(editor, nextText);
  await userEvent.keyboard("{Enter}");
}

const baseValues: ReviewRow = {
  id: "row-1",
  formatted: "Formatted base",
  styled: "Styled base",
  rendered: "Rendered base",
  mineContext: "Mine context base",
  serverContext: "Server context base",
  amount: 900_719_925_474_099_312_345_678_901_234_567_880n,
  optional: 7,
  permission: "editable",
  revision: 1n,
};

async function enterCompleteDraft(
  screen: Awaited<ReturnType<typeof render>>,
  grid: ReturnType<Awaited<ReturnType<typeof render>>["getByRole"]>,
  row: ProjectableReviewRow,
): Promise<void> {
  await editVisibleCell(
    screen,
    grid,
    row.present("FORMAT", row.formatted),
    "Formatted",
    "Formatted mine",
  );
  await editVisibleCell(screen, grid, row.styled, "Styled", "Styled mine");
  await editVisibleCell(
    screen,
    grid,
    row.present("RENDER", row.rendered),
    "Rendered",
    "Rendered mine",
  );
  await editVisibleCell(screen, grid, row.mineContext, "Mine context", "Mine context mine");
  await editVisibleCell(screen, grid, row.serverContext, "Server context", "Server context mine");
  await editVisibleCell(screen, grid, String(row.amount), "Amount", String(MINE_AMOUNT));
  await editVisibleCell(screen, grid, String(row.optional), "Optional", "", "spinbutton");
}

test("Conflict Review projects a private and WeakMap-backed row with mixed sibling resolutions", async () => {
  const columns = createColumns();
  const source = classRow(baseValues);
  const unrelated = classRow({ ...baseValues, id: "row-2", formatted: "Unrelated" });
  const projections: Array<Readonly<{ row: ClassReviewRow; patch: ReviewEditPatch }>> = [];
  const projectEditRow = vi.fn(
    ({ row, patch }: { readonly row: ClassReviewRow; readonly patch: ReviewEditPatch }) => {
      projections.push({ row, patch });
      return row.withEditPatch(patch);
    },
  );
  const renderTable = (rows: readonly ClassReviewRow[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_ADVERSARIAL_CONFLICT_PROJECTION"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_FORMATTED", direction: "asc" }]}
      clientSource={{ rows, totalRows: rows.length, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={() => Promise.resolve()}
      projectEditRow={projectEditRow}
    />
  );
  const screen = await render(renderTable([source, unrelated], 1));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", {
    name: "Data for TABLE_ID_ADVERSARIAL_CONFLICT_PROJECTION",
  });
  await enterCompleteDraft(screen, grid, source);

  const server = classRow({
    ...baseValues,
    formatted: "Formatted server",
    styled: "Styled server",
    rendered: "Rendered server",
    mineContext: "Mine context server",
    serverContext: "Server context server",
    amount: SERVER_AMOUNT,
    optional: 42,
    revision: 2n,
  });
  await screen.rerender(renderTable([server, unrelated], 2));
  await userEvent.click(screen.getByRole("button", { name: "7 conflicts" }));
  const dialog = screen.getByRole("alertdialog", { name: "Conflict Review" });
  const reviewGrid = dialog.getByRole("grid", { name: "Conflict Review changes" });
  reviewGrid.element().scrollLeft = reviewGrid.element().scrollWidth;
  reviewGrid.element().dispatchEvent(new Event("scroll"));
  await nextBrowserFrame();
  await userEvent.click(
    dialog.getByRole("button", { name: "Keep Mine for row row-1, column Mine context" }),
  );
  await userEvent.click(
    dialog.getByRole("button", { name: "Keep Server for row row-1, column Server context" }),
  );

  const expectedBase = source.present("FORMAT", source.formatted);
  const expectedServer = server.present("FORMAT", server.formatted);
  const expectedYoursRow = server.withEditPatch({
    formatted: "Formatted mine",
    styled: "Styled mine",
    rendered: "Rendered mine",
    mineContext: "Mine context mine",
    amount: MINE_AMOUNT,
    optional: undefined,
  });
  const expectedYours = expectedYoursRow.present("FORMAT", "Formatted mine");
  await revealReviewCell(reviewGrid, expectedBase);
  await revealReviewCell(reviewGrid, expectedServer);
  await revealReviewCell(reviewGrid, expectedYours);
  const expectedStyle = expectedYoursRow.style("Styled mine");
  const styledYours = await revealReviewCell(reviewGrid, "Styled mine");
  expect(styledYours.className).toContain(expectedStyle);
  await revealReviewCell(reviewGrid, expectedYoursRow.present("RENDER", "Rendered mine"));

  expect(projections.length).toBeGreaterThan(0);
  expect(projections.every(({ row }) => row.id === "row-1")).toBe(true);
  expect(
    projections.some(
      ({ patch }) =>
        patch.amount === MINE_AMOUNT && "optional" in patch && patch.optional === undefined,
    ),
  ).toBe(true);
  expect(reviewGrid.getByRole("gridcell", { name: /MISSING/ }).all()).toHaveLength(0);
  expect(
    reviewGrid
      .getByRole("gridcell", {
        name: server.present("FORMAT", "Formatted mine"),
        exact: true,
      })
      .all(),
  ).toHaveLength(0);
});

test("Reset Review applies formatter, class, and renderer to one frozen projected row", async () => {
  const columns = createColumns();
  const source = freezePlainRow(baseValues);
  const projectEditRow = vi.fn(projectPlainRow);
  const screen = await render(
    <BrunoTableClient
      tableId="TABLE_ID_ADVERSARIAL_RESET_PROJECTION"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_FORMATTED", direction: "asc" }]}
      clientSource={{ rows: [source], totalRows: 1, version: 1, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={() => Promise.resolve()}
      projectEditRow={projectEditRow}
    />,
  );
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", {
    name: "Data for TABLE_ID_ADVERSARIAL_RESET_PROJECTION",
  });
  await enterCompleteDraft(screen, grid, source);
  await userEvent.click(screen.getByRole("button", { name: "Reset edits" }));
  const reviewGrid = screen
    .getByRole("alertdialog", { name: "Reset Review" })
    .getByRole("grid", { name: "Reset Review changes" });

  const projected = projectPlainRow({
    row: source,
    patch: {
      formatted: "Formatted mine",
      styled: "Styled mine",
      rendered: "Rendered mine",
      mineContext: "Mine context mine",
      serverContext: "Server context mine",
      amount: MINE_AMOUNT,
      optional: undefined,
    },
  });
  await revealReviewCell(reviewGrid, source.present("FORMAT", source.formatted));
  await revealReviewCell(reviewGrid, projected.present("FORMAT", "Formatted mine"));
  const styledYours = await revealReviewCell(reviewGrid, "Styled mine");
  expect(styledYours.className).toContain(projected.style("Styled mine"));
  await revealReviewCell(reviewGrid, projected.present("RENDER", "Rendered mine"));
  expect(projectEditRow).toHaveBeenCalled();
  expect(reviewGrid.getByRole("gridcell", { name: "Unavailable", exact: true }).all()).toHaveLength(
    0,
  );
});

test("Reset Review stays live after a compatible header replacement", async () => {
  type HeaderReplacementRow = Readonly<{
    readonly id: string;
    readonly primary: string;
    readonly sibling: string;
    readonly revision: bigint;
  }>;
  const makeColumns = (headerName: string) =>
    [
      {
        columnId: "COL_ID_PRIMARY",
        field: "primary",
        headerName,
        valueType: "text",
        isEditable: true,
        valueFormatter: ({
          row,
          value,
        }: {
          readonly row: HeaderReplacementRow;
          readonly value: string;
        }) => `${row.sibling}: ${value}`,
      },
      {
        columnId: "COL_ID_SIBLING",
        field: "sibling",
        headerName: "Sibling",
        valueType: "text",
      },
    ] satisfies BrunoTableColumns<HeaderReplacementRow>;
  const initialRow: HeaderReplacementRow = Object.freeze({
    id: "row-1",
    primary: "Primary base",
    sibling: "Sibling base",
    revision: 1n,
  });
  const renderTable = (sourceRow: HeaderReplacementRow, version: number, headerName: string) => (
    <BrunoTableClient
      tableId="TABLE_ID_REVIEW_HEADER_REPLACEMENT"
      columns={makeColumns(headerName)}
      initialOrderBy={[{ columnId: "COL_ID_PRIMARY", direction: "asc" }]}
      clientSource={{ rows: [sourceRow], totalRows: 1, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={() => Promise.resolve()}
      projectEditRow={({ row, patch }) => Object.freeze({ ...row, ...patch })}
    />
  );
  const screen = await render(renderTable(initialRow, 1, "Before"));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", {
    name: "Data for TABLE_ID_REVIEW_HEADER_REPLACEMENT",
  });
  await userEvent.click(
    grid.getByRole("gridcell", { name: "Sibling base: Primary base", exact: true }),
  );
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Before" }), "Primary mine");
  await userEvent.keyboard("{Enter}");
  await userEvent.click(screen.getByRole("button", { name: "Reset edits" }));
  const reviewGrid = screen
    .getByRole("alertdialog", { name: "Reset Review" })
    .getByRole("grid", { name: "Reset Review changes" });
  await revealReviewCell(reviewGrid, "Sibling base: Primary mine");

  await screen.rerender(renderTable(initialRow, 2, "After"));
  await revealReviewCell(reviewGrid, "After");

  const updatedRow: HeaderReplacementRow = Object.freeze({
    id: initialRow.id,
    primary: "Primary server",
    sibling: "Sibling server",
    revision: 2n,
  });
  await screen.rerender(renderTable(updatedRow, 3, "After"));

  await revealReviewCell(reviewGrid, "Sibling server: Primary server");
  await revealReviewCell(reviewGrid, "Sibling server: Primary mine");
  expect(
    reviewGrid.getByRole("gridcell", { name: "Sibling base: Primary mine", exact: true }).all(),
  ).toHaveLength(0);
});

test("Conflict Review refreshes action names after a compatible header replacement", async () => {
  type HeaderReplacementRow = Readonly<{
    readonly id: string;
    readonly primary: string;
    readonly revision: bigint;
  }>;
  const makeColumns = (headerName: string) =>
    [
      {
        columnId: "COL_ID_PRIMARY",
        field: "primary",
        headerName,
        valueType: "text",
        isEditable: true,
      },
    ] satisfies BrunoTableColumns<HeaderReplacementRow>;
  const initialRow: HeaderReplacementRow = Object.freeze({
    id: "row-1",
    primary: "Primary base",
    revision: 1n,
  });
  const serverRow: HeaderReplacementRow = Object.freeze({
    id: initialRow.id,
    primary: "Primary server",
    revision: 2n,
  });
  const renderTable = (sourceRow: HeaderReplacementRow, version: number, headerName: string) => (
    <BrunoTableClient
      tableId="TABLE_ID_CONFLICT_ACTION_HEADER_REPLACEMENT"
      columns={makeColumns(headerName)}
      initialOrderBy={[{ columnId: "COL_ID_PRIMARY", direction: "asc" }]}
      clientSource={{ rows: [sourceRow], totalRows: 1, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={() => Promise.resolve()}
    />
  );
  const screen = await render(renderTable(initialRow, 1, "Before"));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", {
    name: "Data for TABLE_ID_CONFLICT_ACTION_HEADER_REPLACEMENT",
  });
  await userEvent.click(grid.getByRole("gridcell", { name: initialRow.primary, exact: true }));
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Before" }), "Primary mine");
  await userEvent.keyboard("{Enter}");
  await screen.rerender(renderTable(serverRow, 2, "Before"));
  await userEvent.click(screen.getByRole("button", { name: "1 conflict" }));

  const review = screen.getByRole("alertdialog", { name: "Conflict Review" });
  const reviewGrid = review.getByRole("grid", { name: "Conflict Review changes" });
  reviewGrid.element().scrollLeft = reviewGrid.element().scrollWidth;
  reviewGrid.element().dispatchEvent(new Event("scroll"));
  await nextBrowserFrame();
  await expect
    .element(review.getByRole("button", { name: "Keep Mine for row row-1, column Before" }))
    .toBeVisible();
  await expect
    .element(review.getByRole("button", { name: "Keep Server for row row-1, column Before" }))
    .toBeVisible();

  await screen.rerender(renderTable(serverRow, 3, "After"));

  await expect.element(review).toBeVisible();
  await expect
    .element(review.getByRole("button", { name: "Keep Mine for row row-1, column After" }))
    .toBeVisible();
  await expect
    .element(review.getByRole("button", { name: "Keep Server for row row-1, column After" }))
    .toBeVisible();
  expect(
    review.getByRole("button", { name: "Keep Mine for row row-1, column Before" }).all(),
  ).toHaveLength(0);
  expect(
    review.getByRole("button", { name: "Keep Server for row row-1, column Before" }).all(),
  ).toHaveLength(0);
});

test("Blocked Changes Review keeps Server authentic and Mine projected after permission revocation", async () => {
  const editableWhilePermitted = ({ row }: { readonly row: ReviewRow }) =>
    row.permission === "editable";
  const columns = createColumns(editableWhilePermitted);
  const source = freezePlainRow(baseValues);
  const projectEditRow = vi.fn(projectPlainRow);
  const renderTable = (row: ProjectableReviewRow, version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_ADVERSARIAL_BLOCKED_PROJECTION"
      columns={columns}
      initialOrderBy={[{ columnId: "COL_ID_FORMATTED", direction: "asc" }]}
      clientSource={{ rows: [row], totalRows: 1, version, status: "ready" }}
      getRowId={(candidate) => candidate.id}
      editable
      getRowVersion={(candidate) => candidate.revision}
      onSaveEdits={() => Promise.resolve()}
      projectEditRow={projectEditRow}
    />
  );
  const screen = await render(renderTable(source, 1));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", {
    name: "Data for TABLE_ID_ADVERSARIAL_BLOCKED_PROJECTION",
  });
  await enterCompleteDraft(screen, grid, source);
  const blocked = freezePlainRow({ ...baseValues, permission: "blocked", revision: 2n });
  await screen.rerender(renderTable(blocked, 2));
  await userEvent.click(screen.getByRole("button", { name: "7 blocked changes" }));
  const reviewGrid = screen
    .getByRole("alertdialog", { name: "Blocked Changes Review" })
    .getByRole("grid", { name: "Blocked Changes Review changes" });

  const projected = projectPlainRow({
    row: blocked,
    patch: {
      formatted: "Formatted mine",
      styled: "Styled mine",
      rendered: "Rendered mine",
      mineContext: "Mine context mine",
      serverContext: "Server context mine",
      amount: MINE_AMOUNT,
      optional: undefined,
    },
  });
  await revealReviewCell(reviewGrid, blocked.present("FORMAT", blocked.formatted));
  await revealReviewCell(reviewGrid, projected.present("FORMAT", "Formatted mine"));
  const styledMine = await revealReviewCell(reviewGrid, "Styled mine");
  expect(styledMine.className).toContain(projected.style("Styled mine"));
  await revealReviewCell(reviewGrid, projected.present("RENDER", "Rendered mine"));
  expect(projectEditRow).toHaveBeenCalled();
  expect(reviewGrid.getByRole("gridcell", { name: "Unavailable", exact: true }).all()).toHaveLength(
    0,
  );
});

test("Blocked Changes Review keeps row-aware Mine unavailable after its source row disappears", async () => {
  type MissingReviewRow = Readonly<{
    readonly id: string;
    readonly primary: string;
    readonly context: string;
    readonly revision: bigint;
  }>;
  const missingReviewColumns = [
    {
      columnId: "COL_ID_PRIMARY",
      field: "primary",
      headerName: "Primary",
      valueType: "text",
      isEditable: true,
      valueFormatter: ({
        row,
        value,
      }: {
        readonly row: MissingReviewRow;
        readonly value: string;
      }) => `${row.context}: ${value}`,
    },
    {
      columnId: "COL_ID_CONTEXT",
      field: "context",
      headerName: "Context",
      valueType: "text",
      isEditable: true,
    },
  ] satisfies BrunoTableColumns<MissingReviewRow>;
  const source = {
    id: "row-1",
    primary: "Primary base",
    context: "Context base",
    revision: 1n,
  } as const satisfies MissingReviewRow;
  const renderTable = (sourceRows: readonly MissingReviewRow[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_MISSING_ROW_PROJECTION"
      columns={missingReviewColumns}
      initialOrderBy={[{ columnId: "COL_ID_PRIMARY", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={() => Promise.resolve()}
      projectEditRow={({ row, patch }) => ({ ...row, ...patch })}
    />
  );
  const screen = await render(renderTable([source], 1));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_MISSING_ROW_PROJECTION" });
  await userEvent.click(
    grid.getByRole("gridcell", { name: "Context base: Primary base", exact: true }),
  );
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Primary" }), "Primary mine");
  await userEvent.keyboard("{Enter}");

  await screen.rerender(renderTable([], 2));
  await userEvent.click(screen.getByRole("button", { name: "1 blocked change" }));
  const reviewGrid = screen
    .getByRole("alertdialog", { name: "Blocked Changes Review" })
    .getByRole("grid", { name: "Blocked Changes Review changes" });
  reviewGrid.element().scrollLeft = reviewGrid.element().scrollWidth;
  reviewGrid.element().dispatchEvent(new Event("scroll"));
  await nextBrowserFrame();

  const mineHeader = reviewGrid.getByRole("columnheader", { name: /Mine/ });
  await expect.element(mineHeader).toBeVisible();
  const mineColumnIndex = mineHeader.element().getAttribute("aria-colindex");
  const mineUnavailable = reviewGrid
    .getByRole("gridcell", { name: "Unavailable", exact: true })
    .all()
    .find((cell) => cell.element().getAttribute("aria-colindex") === mineColumnIndex);
  expect(mineUnavailable).toBeDefined();
  await expect.element(mineUnavailable!).toBeVisible();
  expect(
    reviewGrid.getByRole("gridcell", { name: "Context base: Primary mine", exact: true }).all(),
  ).toHaveLength(0);
  await expect
    .element(
      reviewGrid.getByRole("gridcell", {
        name: "This row was removed from the server. Changes cannot be saved.",
        exact: true,
      }),
    )
    .toBeVisible();
});

test("Conflict Review accepts an identical memoized projection after close and reopen", async () => {
  type MemoizedProjectionRow = Readonly<{
    readonly id: string;
    readonly primary: string;
    readonly context: string;
    readonly revision: bigint;
  }>;
  const memoizedProjectionColumns = [
    {
      columnId: "COL_ID_PRIMARY",
      field: "primary",
      headerName: "Primary",
      valueType: "text",
      isEditable: true,
      valueFormatter: ({
        row,
        value,
      }: {
        readonly row: MemoizedProjectionRow;
        readonly value: string;
      }) => `${row.context}: ${value}`,
    },
    {
      columnId: "COL_ID_CONTEXT",
      field: "context",
      headerName: "Context",
      valueType: "text",
    },
  ] satisfies BrunoTableColumns<MemoizedProjectionRow>;
  const source: MemoizedProjectionRow = Object.freeze({
    id: "row-1",
    primary: "Primary base",
    context: "Context base",
    revision: 1n,
  });
  type MemoizedProjection = Readonly<{
    readonly source: MemoizedProjectionRow;
    readonly primary: string | undefined;
    readonly row: MemoizedProjectionRow;
  }>;
  let memoized: MemoizedProjection | undefined;
  let memoHitCount = 0;
  const projectEditRow = vi.fn(
    ({
      row,
      patch,
    }: {
      readonly row: MemoizedProjectionRow;
      readonly patch: Readonly<Partial<Pick<MemoizedProjectionRow, "primary">>>;
    }): MemoizedProjectionRow => {
      if (memoized !== undefined && memoized.source === row && memoized.primary === patch.primary) {
        memoHitCount += 1;
        return memoized.row;
      }
      const projected = Object.freeze({ ...row, ...patch });
      memoized = Object.freeze({ source: row, primary: patch.primary, row: projected });
      return projected;
    },
  );
  const renderTable = (sourceRows: readonly MemoizedProjectionRow[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_MEMOIZED_ROW_PROJECTION"
      columns={memoizedProjectionColumns}
      initialOrderBy={[{ columnId: "COL_ID_PRIMARY", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={() => Promise.resolve()}
      projectEditRow={projectEditRow}
    />
  );
  const screen = await render(renderTable([source], 1));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_MEMOIZED_ROW_PROJECTION" });
  await userEvent.click(
    grid.getByRole("gridcell", { name: "Context base: Primary base", exact: true }),
  );
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Primary" }), "Primary mine");
  await userEvent.keyboard("{Enter}");

  const server: MemoizedProjectionRow = Object.freeze({
    id: "row-1",
    primary: "Primary server",
    context: "Context server",
    revision: 2n,
  });
  await screen.rerender(renderTable([server], 2));
  const conflictButton = screen.getByRole("button", { name: "1 conflict" });
  await userEvent.click(conflictButton);
  const firstDialog = screen.getByRole("alertdialog", { name: "Conflict Review" });
  await revealReviewCell(
    firstDialog.getByRole("grid", { name: "Conflict Review changes" }),
    "Context server: Primary mine",
  );
  await userEvent.click(firstDialog.getByRole("button", { name: "Cancel" }));
  await expect.element(firstDialog).not.toBeInTheDocument();
  await expect.element(conflictButton).toHaveFocus();

  await userEvent.click(conflictButton);
  const reopenedDialog = screen.getByRole("alertdialog", { name: "Conflict Review" });
  const reopenedGrid = reopenedDialog.getByRole("grid", { name: "Conflict Review changes" });
  await revealReviewCell(reopenedGrid, "Context server: Primary mine");
  expect(
    reopenedGrid.getByRole("gridcell", { name: "Unavailable", exact: true }).all(),
  ).toHaveLength(0);
  expect(memoHitCount).toBeGreaterThan(0);
});

test("Conflict Review never publishes stale row-aware Yours when a projector reuses its object", async () => {
  type ReusedProjectionRow = Readonly<{
    readonly id: string;
    readonly primary: string;
    readonly context: string;
    readonly revision: bigint;
  }>;
  const reusedProjectionColumns = [
    {
      columnId: "COL_ID_PRIMARY",
      field: "primary",
      headerName: "Primary",
      valueType: "text",
      isEditable: true,
      valueFormatter: ({
        row,
        value,
      }: {
        readonly row: ReusedProjectionRow;
        readonly value: string;
      }) => `${row.context}: ${value}`,
    },
    {
      columnId: "COL_ID_CONTEXT",
      field: "context",
      headerName: "Context",
      valueType: "text",
      isEditable: true,
    },
  ] satisfies BrunoTableColumns<ReusedProjectionRow>;
  const source: ReusedProjectionRow = {
    id: "row-1",
    primary: "Primary base",
    context: "Context base",
    revision: 1n,
  };
  const reusedProjection: {
    id: string;
    primary: string;
    context: string;
    revision: bigint;
  } = { ...source };
  const projectEditRow = vi.fn(
    ({
      row,
      patch,
    }: {
      readonly row: ReusedProjectionRow;
      readonly patch: Partial<ReusedProjectionRow>;
    }) => {
      Object.assign(reusedProjection, row, patch);
      return reusedProjection;
    },
  );
  const renderTable = (sourceRows: readonly ReusedProjectionRow[], version: number) => (
    <BrunoTableClient
      tableId="TABLE_ID_REUSED_ROW_PROJECTION"
      columns={reusedProjectionColumns}
      initialOrderBy={[{ columnId: "COL_ID_PRIMARY", direction: "asc" }]}
      clientSource={{ rows: sourceRows, totalRows: sourceRows.length, version, status: "ready" }}
      getRowId={(row) => row.id}
      editable
      getRowVersion={(row) => row.revision}
      onSaveEdits={() => Promise.resolve()}
      projectEditRow={projectEditRow}
    />
  );
  const screen = await render(renderTable([source], 1));
  await userEvent.click(screen.getByRole("switch", { name: "Batch editing" }));
  const grid = screen.getByRole("grid", { name: "Data for TABLE_ID_REUSED_ROW_PROJECTION" });
  await userEvent.click(
    grid.getByRole("gridcell", { name: "Context base: Primary base", exact: true }),
  );
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Primary" }), "Primary mine");
  await userEvent.keyboard("{Enter}{ArrowRight}{Enter}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Edit Context" }), "Context mine");
  await userEvent.keyboard("{Enter}");

  await screen.rerender(
    renderTable(
      [
        {
          id: "row-1",
          primary: "Primary server",
          context: "Context server",
          revision: 2n,
        },
      ],
      2,
    ),
  );
  await userEvent.click(screen.getByRole("button", { name: "2 conflicts" }));
  const dialog = screen.getByRole("alertdialog", { name: "Conflict Review" });
  const reviewGrid = dialog.getByRole("grid", { name: "Conflict Review changes" });
  reviewGrid.element().scrollLeft = reviewGrid.element().scrollWidth;
  reviewGrid.element().dispatchEvent(new Event("scroll"));
  await nextBrowserFrame();
  await expect
    .element(
      reviewGrid.getByRole("gridcell", {
        name: "Context mine: Primary mine",
        exact: true,
      }),
    )
    .toBeVisible();

  await userEvent.click(
    dialog.getByRole("button", { name: "Keep Server for row row-1, column Context" }),
  );
  await vi.waitFor(() => {
    expect(
      reviewGrid.getByRole("gridcell", { name: "Context mine: Primary mine", exact: true }).all(),
    ).toHaveLength(0);
    const freshProjectionCount = reviewGrid
      .getByRole("gridcell", { name: "Context server: Primary mine", exact: true })
      .all().length;
    const unavailableCount = reviewGrid
      .getByRole("gridcell", { name: "Unavailable", exact: true })
      .all().length;
    expect(freshProjectionCount).toBe(0);
    expect(unavailableCount).toBeGreaterThan(0);
  });
});
