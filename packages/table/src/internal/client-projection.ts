import type { CompiledColumn } from "./compile-columns";
import type {
  BrunoTableClientProjectionInvalid,
  BrunoTableQueryNavigationMode,
  BrunoTableRowPipelinePublication,
} from "./grid-runtime";
import { BRUNO_TABLE_RAW_CLIENT_PROJECTION_LAYOUT_KEY } from "./grid-runtime";
import type { BrunoTableLogicalRowSpace } from "./bruno-table-view";
import type {
  BrunoTableClientGroupedProjection,
  BrunoTableClientGroupedRow,
} from "./client-grouping";

export type BrunoTableClientProjectionKind = "raw" | "grouped" | "invalid";

type BrunoTableClientProjectionBase = Readonly<{
  readonly epoch: number;
  readonly layoutKey: string;
  readonly groupBy: readonly string[];
  readonly columns: readonly CompiledColumn[];
  readonly presentationKey: string;
  readonly rowIds: readonly string[];
  readonly rowSpace: BrunoTableLogicalRowSpace;
  readonly publication: BrunoTableRowPipelinePublication<unknown>;
  readonly queryGeneration: number;
  readonly queryNavigationMode: BrunoTableQueryNavigationMode;
}>;

export type BrunoTableClientProjectionSnapshot =
  | (BrunoTableClientProjectionBase &
      Readonly<{
        readonly kind: "raw";
      }>)
  | (BrunoTableClientProjectionBase &
      Readonly<{
        readonly kind: "grouped";
        readonly groupedRows: readonly BrunoTableClientGroupedRow[];
      }>)
  | (BrunoTableClientProjectionBase &
      Readonly<{
        readonly kind: "invalid";
        readonly invalid: BrunoTableClientProjectionInvalid;
      }>);

type WithoutEpoch<T> = T extends unknown ? Omit<T, "epoch"> : never;

export type BrunoTableClientProjectionCandidate = WithoutEpoch<BrunoTableClientProjectionSnapshot>;

export class BrunoTableClientProjectionCoordinator {
  private snapshot: BrunoTableClientProjectionSnapshot;
  private installed = false;
  private previousGroupedProjection:
    | Extract<BrunoTableClientGroupedProjection, { readonly kind: "ready" }>
    | undefined;

  public constructor(initial: BrunoTableClientProjectionCandidate) {
    this.snapshot = installEpoch(0, initial);
  }

  public readonly getSnapshot = (): BrunoTableClientProjectionSnapshot => this.snapshot;

  public readonly getPreviousGroupedProjection = ():
    | Extract<BrunoTableClientGroupedProjection, { readonly kind: "ready" }>
    | undefined => this.previousGroupedProjection;

  public readonly commit = (
    candidate: BrunoTableClientProjectionCandidate,
    installPublication: (publication: BrunoTableRowPipelinePublication<unknown>) => void,
  ): boolean => {
    const same = sameProjection(this.snapshot, candidate);
    if (this.installed && same) return false;
    const next = this.installed
      ? installEpoch(this.snapshot.epoch + 1, candidate)
      : installEpoch(this.snapshot.epoch, candidate);
    this.snapshot = next;
    this.installed = true;
    if (next.kind === "grouped") {
      this.previousGroupedProjection = Object.freeze({
        kind: "ready",
        groupBy: next.groupBy,
        rows: next.groupedRows,
        rowIds: next.rowIds,
      });
    } else if (next.groupBy.length === 0) {
      this.previousGroupedProjection = undefined;
    }

    installPublication(next.publication);
    return true;
  };
}

export function createBrunoTableRawProjectionCandidate(
  input: Readonly<{
    readonly columns: readonly CompiledColumn[];
    readonly presentationKey?: string;
    readonly rowIds: readonly string[];
    readonly publication: BrunoTableRowPipelinePublication<unknown>;
    readonly queryGeneration: number;
    readonly queryNavigationMode: BrunoTableQueryNavigationMode;
  }>,
): BrunoTableClientProjectionCandidate {
  const rowIds = freezeRowIds(input.rowIds);
  const rowSpace = createClientLogicalRowSpace(rowIds);
  return Object.freeze({
    kind: "raw" as const,
    layoutKey: projectionLayoutKey("raw", EMPTY_GROUP_BY),
    groupBy: EMPTY_GROUP_BY,
    columns: input.columns,
    presentationKey: input.presentationKey ?? `raw:${String(input.queryGeneration)}`,
    rowIds,
    rowSpace,
    publication: input.publication,
    queryGeneration: input.queryGeneration,
    queryNavigationMode: input.queryNavigationMode,
  });
}

export function createBrunoTableGroupedProjectionCandidate(
  input: Readonly<{
    readonly projection: Extract<BrunoTableClientGroupedProjection, { readonly kind: "ready" }>;
    readonly columns: readonly CompiledColumn[];
    readonly presentationKey?: string;
    readonly publication: BrunoTableRowPipelinePublication<unknown>;
    readonly queryGeneration: number;
    readonly queryNavigationMode: BrunoTableQueryNavigationMode;
  }>,
): BrunoTableClientProjectionCandidate {
  const rowIds = freezeRowIds(input.projection.rowIds);
  const rowSpace = createClientLogicalRowSpace(rowIds);
  return Object.freeze({
    kind: "grouped" as const,
    layoutKey: projectionLayoutKey("grouped", input.projection.groupBy),
    groupBy: input.projection.groupBy,
    columns: input.columns,
    presentationKey: input.presentationKey ?? `grouped:${String(input.queryGeneration)}`,
    rowIds,
    rowSpace,
    publication: input.publication,
    queryGeneration: input.queryGeneration,
    queryNavigationMode: input.queryNavigationMode,
    groupedRows: input.projection.rows,
  });
}

export function createBrunoTableInvalidProjectionCandidate(
  input: Readonly<{
    readonly groupBy: readonly string[];
    readonly columns: readonly CompiledColumn[];
    readonly presentationKey?: string;
    readonly publication: BrunoTableRowPipelinePublication<unknown>;
    readonly queryGeneration: number;
    readonly queryNavigationMode: BrunoTableQueryNavigationMode;
    readonly invalid: BrunoTableClientProjectionInvalid;
  }>,
): BrunoTableClientProjectionCandidate {
  return Object.freeze({
    kind: "invalid" as const,
    layoutKey: projectionLayoutKey("invalid", input.groupBy),
    groupBy: Object.freeze(Array.from(input.groupBy)),
    columns: input.columns,
    presentationKey: input.presentationKey ?? `invalid:${String(input.queryGeneration)}`,
    rowIds: EMPTY_ROW_IDS,
    rowSpace: EMPTY_ROW_SPACE,
    publication: input.publication,
    queryGeneration: input.queryGeneration,
    queryNavigationMode: input.queryNavigationMode,
    invalid: input.invalid,
  });
}

function installEpoch(
  epoch: number,
  candidate: BrunoTableClientProjectionCandidate,
): BrunoTableClientProjectionSnapshot {
  const publication = Object.freeze({
    ...candidate.publication,
    clientProjection:
      candidate.kind === "raw"
        ? null
        : Object.freeze({
            kind: candidate.kind,
            layoutKey: candidate.layoutKey,
            groupBy: candidate.groupBy,
            columns: candidate.columns,
            presentationKey: candidate.presentationKey,
            rowIds: candidate.rowIds,
            rowSpace: candidate.rowSpace,
            queryGeneration: candidate.queryGeneration,
            queryNavigationMode: candidate.queryNavigationMode,
            ...(candidate.kind === "invalid" ? { invalid: candidate.invalid } : {}),
          }),
  });
  return Object.freeze({ ...candidate, publication, epoch }) as BrunoTableClientProjectionSnapshot;
}

function sameProjection(
  installed: BrunoTableClientProjectionSnapshot,
  candidate: BrunoTableClientProjectionCandidate,
): boolean {
  if (installed.kind === "invalid" && candidate.kind === "invalid") {
    return (
      installed.layoutKey === candidate.layoutKey &&
      installed.presentationKey === candidate.presentationKey &&
      installed.queryGeneration === candidate.queryGeneration &&
      installed.queryNavigationMode === candidate.queryNavigationMode &&
      installed.publication === candidate.publication &&
      sameStrings(installed.groupBy, candidate.groupBy)
    );
  }
  if (
    installed.kind !== candidate.kind ||
    installed.layoutKey !== candidate.layoutKey ||
    installed.columns !== candidate.columns ||
    installed.presentationKey !== candidate.presentationKey ||
    installed.publication !== candidate.publication ||
    installed.queryGeneration !== candidate.queryGeneration ||
    installed.queryNavigationMode !== candidate.queryNavigationMode ||
    !sameStrings(installed.groupBy, candidate.groupBy) ||
    !sameStrings(installed.rowIds, candidate.rowIds)
  ) {
    return false;
  }
  if (installed.kind === "grouped" && candidate.kind === "grouped") {
    return installed.groupedRows === candidate.groupedRows;
  }
  return true;
}

function createClientLogicalRowSpace(rowIds: readonly string[]): BrunoTableLogicalRowSpace {
  const rowIndexById = new Map(rowIds.map((rowId, index) => [rowId, index]));
  const identitySnapshot = Object.freeze({ rowIds, rowIndexById });
  return Object.freeze({
    totalRows: rowIds.length,
    getRowId: (index: number) => rowIds[index],
    findRowIndex: (rowId: string) => rowIndexById.get(rowId),
    setRequiredRange: (_start: number, _end: number) => undefined,
    identitySnapshot,
  });
}

function freezeRowIds(rowIds: readonly string[]): readonly string[] {
  return Object.isFrozen(rowIds) ? rowIds : Object.freeze(Array.from(rowIds));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return (
    left === right ||
    (left.length === right.length && left.every((value, index) => value === right[index]))
  );
}

function projectionLayoutKey(
  kind: BrunoTableClientProjectionKind,
  groupBy: readonly string[],
): string {
  return kind === "raw" && groupBy.length === 0
    ? BRUNO_TABLE_RAW_CLIENT_PROJECTION_LAYOUT_KEY
    : JSON.stringify([kind, groupBy]);
}

const EMPTY_GROUP_BY: readonly never[] = Object.freeze([]);
const EMPTY_ROW_IDS: readonly never[] = Object.freeze([]);
const EMPTY_ROW_SPACE = createClientLogicalRowSpace(EMPTY_ROW_IDS);
