type Listener = () => void;
type RenderListener = (surface: "header" | "row", rowId?: string) => void;

const renderListenersByTable = new Map<string, Set<RenderListener>>();

export function installBrunoTableRowSelectionRenderListener(
  tableId: string,
  listener: RenderListener,
): () => void {
  const listeners = renderListenersByTable.get(tableId) ?? new Set<RenderListener>();
  listeners.add(listener);
  renderListenersByTable.set(tableId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) renderListenersByTable.delete(tableId);
  };
}

export function recordBrunoTableRowSelectionRender(
  tableId: string,
  surface: "header" | "row",
  rowId?: string,
): void {
  const listeners = renderListenersByTable.get(tableId);
  if (listeners === undefined) return;
  for (const listener of listeners) listener(surface, rowId);
}

/** Private renderer identity; never admitted to consumer column or preference state. */
export const BRUNO_TABLE_ROW_SELECTION_COLUMN_ID = "COL_ID_BRUNO_TABLE_ROW_SELECTION";

export type BrunoTableRowSelectionHeaderSnapshot = Readonly<{
  readonly checked: boolean;
  readonly mixed: boolean;
  readonly disabled: boolean;
  readonly selectedCount: number;
  readonly rowCount: number;
}>;

type BrunoTableRowSelectionToggleResult =
  | Readonly<{ readonly kind: "ignored" }>
  | Readonly<{ readonly kind: "single"; readonly checked: boolean }>
  | Readonly<{
      readonly kind: "range";
      readonly checked: boolean;
      readonly startIndex: number;
      readonly endIndex: number;
      readonly rowCount: number;
    }>;

const ENABLED = Object.freeze({ enabled: true as const });
const DISABLED = Object.freeze({ enabled: false as const });

export class BrunoTableRowSelectionRuntime {
  private readonly headerListeners = new Set<Listener>();
  private readonly rowListeners = new Map<string, Set<Listener>>();
  private sourceRowIds: readonly string[];
  private projectedRowIds: readonly string[];
  private sourceRowIdSet: ReadonlySet<string>;
  private sourceSnapshotToken: object | undefined;
  private projectedRowIndex: ReadonlyMap<string, number>;
  private readonly selectedRowIds = new Set<string>();
  private selectedProjectedCount = 0;
  private anchorRowId: string | undefined;
  private grouped = false;
  private headerSnapshot: BrunoTableRowSelectionHeaderSnapshot;

  public constructor(rowIds: readonly string[]) {
    this.sourceRowIds = stableRowIds(rowIds);
    this.projectedRowIds = this.sourceRowIds;
    this.sourceRowIdSet = new Set(this.sourceRowIds);
    this.projectedRowIndex = indexRowIds(this.projectedRowIds);
    this.headerSnapshot = createHeaderSnapshot(this.projectedRowIds.length, 0, false);
  }

  public readonly getSelectedRowIds = (): readonly string[] =>
    Object.freeze(this.sourceRowIds.filter((rowId) => this.selectedRowIds.has(rowId)));

  public readonly getAnchorRowId = (): string | undefined => this.anchorRowId;

  public readonly getCapabilitySnapshot = (): Readonly<{ readonly enabled: boolean }> =>
    this.grouped ? DISABLED : ENABLED;

  public readonly getHeaderSnapshot = (): BrunoTableRowSelectionHeaderSnapshot =>
    this.headerSnapshot;

  public readonly getRowSnapshot = (rowId: string): boolean => this.selectedRowIds.has(rowId);

  public readonly subscribeHeader = (listener: Listener): (() => void) => {
    this.headerListeners.add(listener);
    return () => this.headerListeners.delete(listener);
  };

  public readonly subscribeRow = (rowId: string, listener: Listener): (() => void) => {
    const listeners = this.rowListeners.get(rowId) ?? new Set<Listener>();
    listeners.add(listener);
    this.rowListeners.set(rowId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.rowListeners.delete(rowId);
    };
  };

  public readonly toggleRow = (
    rowId: string,
    checked: boolean,
    shift: boolean,
  ): BrunoTableRowSelectionToggleResult => {
    if (this.grouped || !this.sourceRowIdSet.has(rowId)) return { kind: "ignored" };
    const changed = new Set<string>();
    const targetIndex = this.projectedRowIndex.get(rowId);
    const anchorIndex =
      this.anchorRowId === undefined ? undefined : this.projectedRowIndex.get(this.anchorRowId);
    let result: BrunoTableRowSelectionToggleResult = { kind: "single", checked };
    if (shift && targetIndex !== undefined && anchorIndex !== undefined) {
      const start = Math.min(anchorIndex, targetIndex);
      const end = Math.max(anchorIndex, targetIndex);
      result = {
        kind: "range",
        checked,
        startIndex: start,
        endIndex: end,
        rowCount: end - start + 1,
      };
      for (let index = start; index <= end; index += 1) {
        const candidate = this.projectedRowIds[index];
        if (candidate !== undefined) this.setSelected(candidate, checked, changed);
      }
    } else {
      this.setSelected(rowId, checked, changed);
    }
    this.anchorRowId = rowId;
    this.publishSelectionChange(changed);
    return result;
  };

  public readonly toggleAll = (checked: boolean): number => {
    if (this.grouped || this.projectedRowIds.length === 0) return 0;
    if (checked ? this.headerSnapshot.checked : this.selectedProjectedCount === 0) return 0;
    const changed = new Set<string>();
    for (const rowId of this.projectedRowIds) this.setSelected(rowId, checked, changed);
    this.anchorRowId = undefined;
    this.publishSelectionChange(changed);
    return this.projectedRowIds.length;
  };

  public readonly clear = (): number => {
    if (this.selectedRowIds.size === 0) {
      this.anchorRowId = undefined;
      return 0;
    }
    const changed = new Set(this.selectedRowIds);
    const count = this.selectedRowIds.size;
    this.selectedRowIds.clear();
    this.selectedProjectedCount = 0;
    this.anchorRowId = undefined;
    this.publishSelectionChange(changed);
    return count;
  };

  public readonly reconcile = (
    sourceRowIds: readonly string[],
    projectedRowIds: readonly string[],
    sourceSnapshotToken?: object,
  ): void => {
    if (this.grouped) return;
    const nextSource =
      sourceSnapshotToken !== undefined && sourceSnapshotToken === this.sourceSnapshotToken
        ? this.sourceRowIds
        : stableRowIds(sourceRowIds, this.sourceRowIds);
    const nextProjection = stableRowIds(projectedRowIds, this.projectedRowIds);
    this.sourceSnapshotToken = sourceSnapshotToken;
    if (nextSource === this.sourceRowIds && nextProjection === this.projectedRowIds) return;

    const nextSourceSet = new Set(nextSource);
    const changed = new Set<string>();
    for (const rowId of this.selectedRowIds) {
      if (!nextSourceSet.has(rowId)) {
        this.selectedRowIds.delete(rowId);
        changed.add(rowId);
      }
    }
    this.sourceRowIds = nextSource;
    this.projectedRowIds = nextProjection;
    this.sourceRowIdSet = nextSourceSet;
    this.projectedRowIndex = indexRowIds(nextProjection);
    this.selectedProjectedCount = countSelected(nextProjection, this.selectedRowIds);
    if (this.anchorRowId !== undefined && !nextSourceSet.has(this.anchorRowId)) {
      this.anchorRowId = undefined;
    }
    this.publishSelectionChange(changed);
  };

  public readonly enterGroupedProjection = (): void => {
    if (this.grouped) return;
    const changed = new Set(this.selectedRowIds);
    this.selectedRowIds.clear();
    this.selectedProjectedCount = 0;
    this.anchorRowId = undefined;
    this.grouped = true;
    this.publishSelectionChange(changed);
  };

  public readonly leaveGroupedProjection = (rowIds: readonly string[]): void => {
    if (!this.grouped) return;
    this.grouped = false;
    this.sourceRowIds = stableRowIds(rowIds);
    this.projectedRowIds = this.sourceRowIds;
    this.sourceRowIdSet = new Set(this.sourceRowIds);
    this.sourceSnapshotToken = undefined;
    this.projectedRowIndex = indexRowIds(this.projectedRowIds);
    this.selectedProjectedCount = 0;
    this.anchorRowId = undefined;
    this.publishSelectionChange(new Set());
  };

  private setSelected(rowId: string, checked: boolean, changed: Set<string>): void {
    const selected = this.selectedRowIds.has(rowId);
    if (selected === checked) return;
    if (checked) this.selectedRowIds.add(rowId);
    else this.selectedRowIds.delete(rowId);
    if (this.projectedRowIndex.has(rowId)) {
      this.selectedProjectedCount += checked ? 1 : -1;
    }
    changed.add(rowId);
  }

  private publishSelectionChange(changed: ReadonlySet<string>): void {
    const nextHeader = createHeaderSnapshot(
      this.projectedRowIds.length,
      this.selectedProjectedCount,
      this.grouped,
    );
    const headerChanged = !sameHeaderSnapshot(this.headerSnapshot, nextHeader);
    if (!headerChanged && changed.size === 0) return;
    this.headerSnapshot = headerChanged ? nextHeader : this.headerSnapshot;
    const listeners: Listener[] = [];
    if (headerChanged) listeners.push(...this.headerListeners);
    for (const rowId of changed) {
      const rowListeners = this.rowListeners.get(rowId);
      if (rowListeners !== undefined) listeners.push(...rowListeners);
    }
    notify(listeners);
  }
}

function stableRowIds(
  candidate: readonly string[],
  previous?: readonly string[],
): readonly string[] {
  if (
    previous !== undefined &&
    candidate.length === previous.length &&
    candidate.every((rowId, index) => rowId === previous[index])
  ) {
    return previous;
  }
  return Object.freeze(Array.from(candidate));
}

function indexRowIds(rowIds: readonly string[]): ReadonlyMap<string, number> {
  return new Map(rowIds.map((rowId, index) => [rowId, index]));
}

function createHeaderSnapshot(
  rowCountCandidate: number,
  selectedCountCandidate: number,
  grouped: boolean,
): BrunoTableRowSelectionHeaderSnapshot {
  const selectedCount = grouped ? 0 : selectedCountCandidate;
  const rowCount = grouped ? 0 : rowCountCandidate;
  return Object.freeze({
    checked: rowCount > 0 && selectedCount === rowCount,
    mixed: selectedCount > 0 && selectedCount < rowCount,
    disabled: grouped || rowCount === 0,
    selectedCount,
    rowCount,
  });
}

function countSelected(rowIds: readonly string[], selected: ReadonlySet<string>): number {
  let count = 0;
  for (const rowId of rowIds) if (selected.has(rowId)) count += 1;
  return count;
}

function sameHeaderSnapshot(
  previous: BrunoTableRowSelectionHeaderSnapshot,
  next: BrunoTableRowSelectionHeaderSnapshot,
): boolean {
  return (
    previous.checked === next.checked &&
    previous.mixed === next.mixed &&
    previous.disabled === next.disabled &&
    previous.selectedCount === next.selectedCount &&
    previous.rowCount === next.rowCount
  );
}

function notify(listeners: readonly Listener[]): void {
  let firstError: unknown;
  let failed = false;
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      if (!failed) firstError = error;
      failed = true;
    }
  }
  if (failed) throw firstError;
}
