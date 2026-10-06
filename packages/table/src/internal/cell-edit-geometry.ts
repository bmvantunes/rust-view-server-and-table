type EditGeometryInput = Readonly<{
  readonly adjustVerticalByLogical: (delta: number) => number | undefined;
  readonly grid: HTMLElement;
  readonly layer: HTMLElement;
  readonly rowId: string;
  readonly rowIndex: number | undefined;
  readonly rowHeight: number;
}>;

/** Imperative fixed-row geometry for one active Cell Edit Session. */
export class BrunoTableCellEditGeometryController {
  private input: EditGeometryInput | undefined;
  private frame: number | undefined;
  private rowId: string | undefined;
  private appliedRowIndex: number | undefined;
  private anchorViewportTop: number | undefined;
  private observedScrollTop: number | undefined;
  private claimedProjectionRows: readonly ProjectionRowClaim[] = [];

  public readonly reconcile = (input: EditGeometryInput): void => {
    if (this.rowId !== input.rowId) {
      this.restoreProjectionRow();
      this.rowId = input.rowId;
      this.appliedRowIndex = input.rowIndex;
      this.observedScrollTop = input.grid.scrollTop;
      this.anchorViewportTop = findProjectedRow(
        input.grid,
        input.rowId,
      )?.getBoundingClientRect().top;
    } else {
      const observedScrollTop = input.grid.scrollTop;
      if (this.observedScrollTop !== undefined && this.anchorViewportTop !== undefined) {
        this.anchorViewportTop -= observedScrollTop - this.observedScrollTop;
      }
      this.observedScrollTop = observedScrollTop;
    }
    this.input = input;
    this.claimProjectionRows(input.grid, input.rowId);
    this.schedule();
  };

  public readonly release = (): void => {
    const input = this.input;
    if (this.frame !== undefined && input !== undefined) {
      input.grid.ownerDocument.defaultView?.cancelAnimationFrame(this.frame);
    }
    this.frame = undefined;
    this.input = undefined;
    this.rowId = undefined;
    this.appliedRowIndex = undefined;
    this.anchorViewportTop = undefined;
    this.observedScrollTop = undefined;
    this.restoreProjectionRow();
  };

  private readonly schedule = (): void => {
    const input = this.input;
    if (input === undefined || this.frame !== undefined) return;
    const view = input.grid.ownerDocument.defaultView;
    if (view === null) return;
    this.frame = view.requestAnimationFrame(() => {
      this.frame = undefined;
      this.flush();
    });
  };

  private readonly flush = (): void => {
    const input = this.input;
    if (input === undefined) return;
    const { grid, layer, rowId, rowIndex } = input;
    if (rowIndex !== undefined && this.appliedRowIndex !== undefined) {
      const requestedDelta = (rowIndex - this.appliedRowIndex) * input.rowHeight;
      if (requestedDelta !== 0) {
        this.observedScrollTop = input.adjustVerticalByLogical(requestedDelta) ?? grid.scrollTop;
      }
      this.appliedRowIndex = rowIndex;
    } else if (rowIndex !== undefined) {
      this.appliedRowIndex = rowIndex;
    }

    const projectedRow = findProjectedRow(grid, rowId);
    if (this.anchorViewportTop === undefined && projectedRow !== undefined) {
      this.anchorViewportTop = projectedRow.getBoundingClientRect().top;
    }
    this.claimProjectionRows(grid, rowId);

    const parent = layer.offsetParent?.getBoundingClientRect();
    const anchor = this.anchorViewportTop;
    if (parent !== undefined && anchor !== undefined) {
      layer.style.top = `${String(anchor - parent.top)}px`;
    }
  };

  private readonly restoreProjectionRow = (): void => {
    for (const claim of this.claimedProjectionRows) {
      restoreAttribute(claim.row, "aria-hidden", claim.ariaHidden);
      restoreStyleProperty(claim.row, "visibility", claim.visibility);
      for (const cell of claim.cells) restoreAttribute(cell.element, "id", cell.id);
    }
    this.claimedProjectionRows = [];
  };

  private readonly claimProjectionRows = (grid: HTMLElement, rowId: string): void => {
    this.restoreProjectionRow();
    const rows = new Map<HTMLElement, ProjectionRowClaim>();
    for (const cell of projectedCells(grid, rowId)) {
      const row = cell.closest<HTMLElement>("tr");
      if (row === null) continue;
      const existing = rows.get(row);
      const cellClaim = Object.freeze({ element: cell, id: cell.getAttribute("id") });
      if (existing !== undefined) {
        existing.cells.push(cellClaim);
        continue;
      }
      rows.set(row, {
        row,
        ariaHidden: row.getAttribute("aria-hidden"),
        visibility: row.style.getPropertyValue("visibility") || null,
        cells: [cellClaim],
      });
    }
    for (const claim of rows.values()) {
      claim.row.setAttribute("aria-hidden", "true");
      claim.row.style.setProperty("visibility", "hidden");
      for (const cell of claim.cells) cell.element.removeAttribute("id");
    }
    this.claimedProjectionRows = [...rows.values()];
  };
}

type ProjectionRowClaim = {
  readonly row: HTMLElement;
  readonly ariaHidden: string | null;
  readonly visibility: string | null;
  readonly cells: Array<Readonly<{ readonly element: HTMLElement; readonly id: string | null }>>;
};

function findProjectedRow(grid: HTMLElement, rowId: string): HTMLElement | undefined {
  const tableBoundary = grid.closest("[data-bruno-table]");
  for (const slot of grid.querySelectorAll<HTMLElement>(
    `[data-bruno-edit-row-slot="${CSS.escape(rowId)}"]`,
  )) {
    if (slot.closest("[data-bruno-table]") === tableBoundary) return slot;
  }
  for (const cell of projectedCells(grid, rowId)) {
    const row = cell.closest<HTMLElement>('[role="row"]');
    if (row !== null) return row;
  }
  return undefined;
}

function projectedCells(grid: HTMLElement, rowId: string): readonly HTMLElement[] {
  const tableBoundary = grid.closest("[data-bruno-table]");
  return [
    ...grid.querySelectorAll<HTMLElement>(
      `[role="gridcell"][data-bruno-row-id="${CSS.escape(rowId)}"]`,
    ),
  ].filter(
    (cell) =>
      cell.closest("[data-bruno-table]") === tableBoundary &&
      cell.closest("[data-bruno-edit-owned-row]") === null,
  );
}

function restoreAttribute(element: HTMLElement, name: string, value: string | null): void {
  if (value === null) element.removeAttribute(name);
  else element.setAttribute(name, value);
}

function restoreStyleProperty(element: HTMLElement, name: string, value: string | null): void {
  if (value === null) element.style.removeProperty(name);
  else element.style.setProperty(name, value);
}
