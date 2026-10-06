import { batch, Store } from "@tanstack/store";
import { Debouncer } from "@tanstack/react-pacer";
import { assign, createActor, createMachine } from "xstate";

import type { CompiledColumn, CompiledFieldColumn } from "./compile-columns";
import { registerBrunoTableCellEditDraftReviewSource } from "./cell-edit-evidence";
import type { BrunoTableCellEditDraftReviewSourceRow } from "./cell-edit-evidence";
import {
  BrunoTableCellEditTraversalIndex,
  type BrunoTableCellEditTraversalDestination,
  type BrunoTableCellEditTraversalRange,
  type BrunoTableCellEditTraversalRowSpace,
} from "./cell-edit-traversal";

type Listener = () => void;
export type { BrunoTableCellEditDraftReviewSourceRow } from "./cell-edit-evidence";
export { isBrunoTableCellEditDraftReviewSourceRow } from "./cell-edit-evidence";

export type BrunoTableCellEditRowPatch = Readonly<Record<string, unknown>>;
/**
 * Projects presentation-only draft evidence onto the current authoritative Row. A changed source
 * or patch must return a fresh immutable Row reference; identical inputs are cached by the runtime.
 */
export type BrunoTableCellEditRowProjector = (
  input: Readonly<{
    readonly row: object;
    readonly patch: BrunoTableCellEditRowPatch;
    readonly rowVersion: unknown;
  }>,
) => unknown;

export type BrunoTableCellEditChange = Readonly<{
  readonly rowId: string;
  readonly columnId: string;
  readonly field: string;
  readonly before: unknown;
  readonly after: unknown;
}>;
export type BrunoTableCellEditChangeGesture = readonly [
  BrunoTableCellEditChange,
  ...BrunoTableCellEditChange[],
];

export type BrunoTableCellEditImmediateSaveResult =
  | "admitted"
  | "preflight-reconciled"
  | "rejected";

export type BrunoTableCellEditSaveCellChange = Readonly<{
  readonly columnId: string;
  readonly field: string;
  readonly before: unknown;
  readonly after: unknown;
}>;

export type BrunoTableCellEditSaveRowChange = Readonly<{
  readonly rowId: string;
  readonly baseRow: object;
  readonly expectedVersion: unknown;
  readonly changes: readonly [
    BrunoTableCellEditSaveCellChange,
    ...BrunoTableCellEditSaveCellChange[],
  ];
}>;

export type BrunoTableCellEditSaveChangeSet = readonly [
  BrunoTableCellEditSaveRowChange,
  ...BrunoTableCellEditSaveRowChange[],
];

export type BrunoTableCellEditRejectedOperationCell = Readonly<{
  readonly rowId: string;
  readonly columnId: string;
}>;

export type BrunoTableCellEditRejectedOperationUpdate = Readonly<{
  readonly remainingCount: number;
  readonly removedCells: readonly BrunoTableCellEditRejectedOperationCell[];
}>;

type ActiveSession = Readonly<{
  readonly rowId: string;
  readonly column: CompiledFieldColumn;
  readonly row: object;
  readonly baseRow: object;
  readonly baseValue: unknown;
  readonly before: unknown;
  readonly beforeFromDraft: boolean;
  readonly sourceValue: unknown;
  readonly sourceValueAvailable: boolean;
  readonly expectedVersion: unknown;
  readonly initialText: string;
  readonly selectInitialText: boolean;
  readonly rowMissing: boolean;
  readonly invalidMessage?: string;
  readonly permissionMessage?: string;
  readonly rowVersionMessage?: string;
}>;

export type BrunoTableCellEditDraftSnapshot = Readonly<{
  readonly rowId: string;
  readonly columnId: string;
  readonly field: string;
  readonly baseRow: object;
  readonly expectedVersion: unknown;
  readonly base: unknown;
  readonly mine: unknown;
  readonly validationMessage?: string;
  readonly conflict?: Readonly<{
    readonly server: unknown;
    readonly serverVersion: unknown;
    readonly resolution?: "mine" | "server";
  }>;
}>;

export type BrunoTableCellEditCanonicalTextGesture = readonly [
  Readonly<{ readonly rowId: string; readonly columnId: string; readonly canonicalText: string }>,
  ...Readonly<{
    readonly rowId: string;
    readonly columnId: string;
    readonly canonicalText: string;
  }>[],
];

export type BrunoTableCellEditCanonicalTextGestureRejectionReason =
  | "temporarily-unavailable"
  | "invalid-target"
  | "save-locked"
  | "unavailable"
  | "stale"
  | "blocked"
  | "row-version"
  | "invalid-source"
  | "read-only"
  | "invalid-value"
  | "empty"
  | "unchanged";

export type BrunoTableCellEditCanonicalTextGestureResult =
  | Readonly<{ readonly kind: "accepted" }>
  | Readonly<{
      readonly kind: "rejected";
      readonly reason: BrunoTableCellEditCanonicalTextGestureRejectionReason;
      readonly detail?: string;
      readonly rowId?: string;
      readonly columnId?: string;
      readonly additionalInvalidCount?: number;
    }>;

export type BrunoTableCellEditDraftReviewRow = BrunoTableCellEditDraftSnapshot &
  Readonly<{
    readonly id: string;
    readonly reviewVersion: number;
    readonly headerName: string;
    readonly columnLabel: string;
    readonly serverText: "";
    readonly mineText: "";
    readonly status: string;
    readonly column: CompiledFieldColumn;
    readonly serverRow: object | undefined;
    readonly projectedRow: object | undefined;
    readonly projectedRowAvailable: boolean;
    readonly serverNow: unknown;
    readonly serverValueAvailable: boolean;
    readonly blockedReason: string | undefined;
    readonly candidateText?: string;
    readonly candidateInvalid?: boolean;
  }>;

export type BrunoTableCellEditDraftReviewClassificationSnapshot = Readonly<{
  readonly conflictIds: ReadonlySet<string>;
  readonly blockedIds: ReadonlySet<string>;
}>;

export type BrunoTableCellEditConflictResolution = Readonly<{
  readonly id: string;
  readonly resolution: "mine" | "server";
  readonly reviewedServer: unknown;
  readonly reviewedServerVersion: unknown;
}>;

type DraftEntry = BrunoTableCellEditDraftSnapshot &
  Readonly<{
    readonly blockedReason?: string;
    readonly presentationColumn?: CompiledFieldColumn;
  }>;

type DraftReviewProjectedRow = Readonly<{
  readonly available: boolean;
  readonly row: object | undefined;
  readonly serverCandidate: unknown;
}>;

type DraftReviewProjectedRowCacheEntry = Readonly<{
  readonly historicalProjectedRows: WeakSet<object>;
  readonly patch: BrunoTableCellEditRowPatch;
  readonly projectorEpoch: number;
  readonly projectedRow: object;
  readonly sourceRevision: unknown;
  readonly sourceRow: object;
}>;

type DraftReviewProjectionMutation =
  | Readonly<{
      readonly kind: "accept";
      readonly rowId: string;
      readonly entry: DraftReviewProjectedRowCacheEntry;
      readonly projectedRow: object;
    }>
  | Readonly<{ readonly kind: "withdraw"; readonly rowId: string }>;

type DraftReviewProjectionResult = Readonly<{
  readonly projection: DraftReviewProjectedRow;
  readonly mutation?: DraftReviewProjectionMutation;
}>;

type DraftReviewProjectedRowsPlan = Readonly<{
  readonly rows: ReadonlyMap<string, DraftReviewProjectedRow>;
  readonly commit: () => void;
}>;

function sameEditRowPatch(
  left: BrunoTableCellEditRowPatch,
  right: BrunoTableCellEditRowPatch,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) => Object.hasOwn(right, key) && Object.is(left[key as string], right[key as string]),
    )
  );
}

function sameDraftReviewProjectionInput(
  entry: DraftReviewProjectedRowCacheEntry,
  sourceRow: object,
  sourceRevision: unknown,
  projectorEpoch: number,
  patch: BrunoTableCellEditRowPatch,
): boolean {
  return (
    entry.projectorEpoch === projectorEpoch &&
    entry.sourceRow === sourceRow &&
    Object.is(entry.sourceRevision, sourceRevision) &&
    sameEditRowPatch(entry.patch, patch)
  );
}

type DraftPatch =
  | Readonly<{ readonly kind: "remove"; readonly cellKey: string; readonly value: unknown }>
  | Readonly<{
      readonly kind: "set";
      readonly cellKey: string;
      readonly value: unknown;
      readonly rowId: string;
      readonly columnId: string;
      readonly field: string;
      readonly baseRow: object;
      readonly expectedVersion: unknown;
      readonly base: unknown;
      readonly validationMessage?: string;
      readonly conflict?: Readonly<{
        readonly server: unknown;
        readonly serverVersion: unknown;
        readonly resolution?: "mine" | "server";
      }>;
    }>;

type DraftHistoryCellPatch = Readonly<{
  readonly cellKey: string;
  readonly before: DraftEntry | undefined;
  readonly after: DraftEntry | undefined;
  readonly authoredValue: unknown;
}>;

const BRUNO_TABLE_DRAFT_HISTORY_PATCH_BUCKET_COUNT = 64;

function draftHistoryPatchBucket(key: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) & (BRUNO_TABLE_DRAFT_HISTORY_PATCH_BUCKET_COUNT - 1);
}

class DraftHistoryPatchMap implements ReadonlyMap<string, DraftHistoryCellPatch> {
  public static from(
    patches: Iterable<readonly [string, DraftHistoryCellPatch]>,
  ): DraftHistoryPatchMap {
    const buckets = Array.from(
      { length: BRUNO_TABLE_DRAFT_HISTORY_PATCH_BUCKET_COUNT },
      () => new Map<string, DraftHistoryCellPatch>(),
    );
    let size = 0;
    for (const [key, patch] of patches) {
      const bucket = buckets[draftHistoryPatchBucket(key)]!;
      if (!bucket.has(key)) size += 1;
      bucket.set(key, patch);
    }
    return new DraftHistoryPatchMap(Object.freeze(buckets), size);
  }

  public constructor(
    private readonly buckets: readonly ReadonlyMap<string, DraftHistoryCellPatch>[],
    public readonly size: number,
  ) {}

  public readonly get = (key: string): DraftHistoryCellPatch | undefined =>
    this.buckets[draftHistoryPatchBucket(key)]?.get(key);

  public readonly has = (key: string): boolean =>
    this.buckets[draftHistoryPatchBucket(key)]?.has(key) === true;

  public readonly with = (
    key: string,
    patch: DraftHistoryCellPatch | undefined,
  ): DraftHistoryPatchMap => {
    const bucketIndex = draftHistoryPatchBucket(key);
    const previousBucket = this.buckets[bucketIndex];
    if (previousBucket === undefined) return this;
    const previous = previousBucket.get(key);
    if (previous === patch || (previous === undefined && patch === undefined)) return this;
    const nextBucket = new Map(previousBucket);
    if (patch === undefined) nextBucket.delete(key);
    else nextBucket.set(key, patch);
    const nextBuckets = [...this.buckets];
    nextBuckets[bucketIndex] = nextBucket;
    return new DraftHistoryPatchMap(
      Object.freeze(nextBuckets),
      this.size + (previous === undefined ? 1 : patch === undefined ? -1 : 0),
    );
  };

  public *entries(): MapIterator<[string, DraftHistoryCellPatch]> {
    for (const bucket of this.buckets) yield* bucket.entries();
  }

  public *keys(): MapIterator<string> {
    for (const bucket of this.buckets) yield* bucket.keys();
  }

  public *values(): MapIterator<DraftHistoryCellPatch> {
    for (const bucket of this.buckets) yield* bucket.values();
  }

  public forEach(
    callback: (
      value: DraftHistoryCellPatch,
      key: string,
      map: ReadonlyMap<string, DraftHistoryCellPatch>,
    ) => void,
    thisArgument?: unknown,
  ): void {
    for (const [key, value] of this) callback.call(thisArgument, value, key, this);
  }

  public [Symbol.iterator](): MapIterator<[string, DraftHistoryCellPatch]> {
    return this.entries();
  }
}

class DraftHistoryPatchMapBuilder {
  private readonly buckets = Array.from(
    { length: BRUNO_TABLE_DRAFT_HISTORY_PATCH_BUCKET_COUNT },
    () => new Map<string, DraftHistoryCellPatch>(),
  );
  private size = 0;

  public readonly set = (key: string, patch: DraftHistoryCellPatch | undefined): void => {
    const bucket = this.buckets[draftHistoryPatchBucket(key)]!;
    const hadKey = bucket.has(key);
    if (patch === undefined) {
      if (hadKey) {
        bucket.delete(key);
        this.size -= 1;
      }
      return;
    }
    bucket.set(key, patch);
    if (!hadKey) this.size += 1;
  };

  public readonly addUnique = (key: string, patch: DraftHistoryCellPatch): void => {
    this.buckets[draftHistoryPatchBucket(key)]!.set(key, patch);
    this.size += 1;
  };

  public readonly build = (): DraftHistoryPatchMap =>
    new DraftHistoryPatchMap(Object.freeze(this.buckets), this.size);
}

type DraftHistoryCommand = Readonly<{
  readonly lineage: object;
  readonly patches: DraftHistoryPatchMap;
}>;

type DraftHistoryLocation = Readonly<{
  readonly stack: "undo" | "redo";
  readonly index: number;
}>;

type DraftMemoryState = Readonly<{
  readonly drafts: ReadonlyMap<string, DraftEntry>;
  readonly undoStack: readonly DraftHistoryCommand[];
  readonly redoStack: readonly DraftHistoryCommand[];
}>;

type CanonicalSourceValue =
  | Readonly<{ readonly _tag: "Success"; readonly value: unknown }>
  | Readonly<{ readonly _tag: "Failure" }>;

type SubmittedValueAuthority = Readonly<{
  readonly field: string;
  readonly presentationColumn?: CompiledFieldColumn;
  readonly decodeRuntime: (input: unknown) => CanonicalSourceValue;
  readonly equivalent: (left: unknown, right: unknown) => boolean;
}>;

type AcceptedOverlayEntry = Readonly<{
  readonly operationId: string;
  readonly rowId: string;
  readonly columnId: string;
  readonly expectedVersion: unknown;
  readonly valueAuthority: SubmittedValueAuthority;
  readonly before: unknown;
  readonly after: unknown;
}>;

type RejectedOperationEvidence = Map<string, readonly AcceptedOverlayEntry[]>;

type SavePreflightEntry = Readonly<{
  readonly draft: DraftEntry;
  readonly baseRow: object;
  readonly expectedVersion: unknown;
  readonly before: unknown;
}>;

type BrunoTableCellEditSavePreflightResult =
  | Readonly<{ readonly kind: "ready"; readonly entries: readonly SavePreflightEntry[] }>
  | Readonly<{ readonly kind: "reconciled" }>
  | Readonly<{ readonly kind: "rejected" }>;

type BrunoTableCellEditImmediateSavePreparation =
  | Readonly<{
      readonly kind: "change-set";
      readonly changeSet: BrunoTableCellEditSaveChangeSet;
    }>
  | Readonly<{ readonly kind: "reconciled" }>
  | Readonly<{ readonly kind: "rejected" }>;

function* flattenRejectedEvidence(
  evidenceByRow: RejectedOperationEvidence,
): Generator<AcceptedOverlayEntry> {
  for (const evidence of evidenceByRow.values()) yield* evidence;
}

function* iterateDraftEvidenceKeysByRowId(
  index: ReadonlyMap<string, string | ReadonlySet<string>>,
  rowIds: Iterable<string>,
): Generator<string> {
  for (const rowId of rowIds) {
    const rowKeys = index.get(rowId);
    if (rowKeys === undefined) continue;
    if (typeof rowKeys === "string") yield rowKeys;
    else yield* rowKeys;
  }
}

function readCanonicalSourceValueFromRawRow(
  row: unknown,
  column: CompiledColumn | undefined,
): CanonicalSourceValue {
  if (column?.kind !== "field" || typeof row !== "object" || row === null) {
    return Object.freeze({ _tag: "Failure" });
  }
  try {
    const raw = Reflect.get(row, column.field);
    if (raw === null || raw === undefined) {
      return Object.freeze({ _tag: "Success", value: raw });
    }
    const decoded = column.semantics.decodeRuntime(raw);
    return decoded._tag === "Success" && "value" in decoded
      ? Object.freeze({ _tag: "Success", value: decoded.value })
      : Object.freeze({ _tag: "Failure" });
  } catch {
    return Object.freeze({ _tag: "Failure" });
  }
}

type CommitEvaluation =
  | Readonly<{
      readonly kind: "invalid";
      readonly message: string;
      readonly reason?: "permission" | "rowMissing" | "rowVersion";
    }>
  | Readonly<{
      readonly kind: "accepted";
      readonly cellKey: string;
      readonly value: unknown;
      readonly removeDraft: boolean;
      readonly change?: BrunoTableCellEditChange;
    }>;

type CellEditContext = Readonly<{
  readonly session: ActiveSession | undefined;
  readonly draftPatch: DraftPatch | undefined;
  readonly affectedCellKeys: readonly string[];
  readonly evaluation: CommitEvaluation | undefined;
  readonly acceptedChange: BrunoTableCellEditChange | undefined;
}>;
type CellEditEvent =
  | Readonly<{
      readonly type: "START";
      readonly rowId: string;
      readonly column: CompiledColumn | undefined;
      readonly row: unknown;
      readonly sourceValue: CanonicalSourceValue;
      readonly expectedVersion: unknown;
      readonly hasDraft: boolean;
      readonly draftValue: unknown;
      readonly mode: "current" | "replace";
      readonly producedText: string;
    }>
  | Readonly<{
      readonly type: "COMMIT";
      readonly rawText: string;
      readonly nativeInvalid: boolean;
      readonly intent: "scalar" | "blank";
    }>
  | Readonly<{ readonly type: "RESTORE_REJECTED_COMMIT"; readonly session: ActiveSession }>
  | Readonly<{ readonly type: "CANCEL" }>
  | Readonly<{
      readonly type: "RECONCILE_ROW";
      readonly row: unknown;
      readonly sourceValue: CanonicalSourceValue;
      readonly expectedVersion: unknown;
      readonly rebaseFromConvergedDraft: boolean;
      readonly rebaseFailed: boolean;
    }>
  | Readonly<{ readonly type: "RECONCILE_COLUMN"; readonly column: CompiledFieldColumn }>;

const brunoTableCellEditMachine = createMachine({
  id: "brunoTableCellEditSession",
  initial: "idle",
  types: {} as { context: CellEditContext; events: CellEditEvent },
  context: {
    session: undefined,
    draftPatch: undefined,
    affectedCellKeys: [],
    evaluation: undefined,
    acceptedChange: undefined,
  },
  states: {
    idle: {
      on: {
        RESTORE_REJECTED_COMMIT: {
          target: "editing",
          actions: assign({
            session: ({ event }) => event.session,
            draftPatch: undefined,
            affectedCellKeys: [],
            evaluation: undefined,
            acceptedChange: undefined,
          }),
        },
        START: {
          target: "admitting",
          actions: assign({
            session: ({ event }) => prepareSession(event),
            draftPatch: undefined,
            affectedCellKeys: [],
            evaluation: undefined,
            acceptedChange: undefined,
          }),
        },
      },
    },
    admitting: {
      always: [
        { guard: ({ context }) => context.session !== undefined, target: "editing" },
        { target: "idle" },
      ],
    },
    editing: {
      on: {
        RECONCILE_COLUMN: {
          actions: assign({
            session: ({ context, event }) =>
              context.session === undefined
                ? undefined
                : reconcileSessionPermission(
                    Object.freeze({ ...context.session, column: event.column }),
                  ),
          }),
        },
        RECONCILE_ROW: {
          actions: assign({
            session: ({ context, event }) => {
              const session = context.session;
              if (session === undefined) return undefined;
              if (typeof event.row !== "object" || event.row === null) {
                return Object.freeze({ ...session, rowMissing: true });
              }
              const sourceValue =
                event.sourceValue._tag === "Success" ? event.sourceValue.value : undefined;
              const rowVersionMessage = event.rebaseFailed
                ? BRUNO_TABLE_CELL_EDIT_ROW_VERSION_MESSAGE
                : event.rebaseFromConvergedDraft
                  ? undefined
                  : session.rowVersionMessage;
              const { rowVersionMessage: _previousRowVersionMessage, ...retainedSession } = session;
              return reconcileSessionPermission(
                Object.freeze({
                  ...retainedSession,
                  row: event.row,
                  rowMissing: false,
                  sourceValue,
                  sourceValueAvailable: event.sourceValue._tag === "Success",
                  ...(rowVersionMessage === undefined ? {} : { rowVersionMessage }),
                  ...(event.rebaseFromConvergedDraft
                    ? {
                        baseRow: event.row,
                        baseValue: sourceValue,
                        before: sourceValue,
                        beforeFromDraft: false,
                        expectedVersion: event.expectedVersion,
                      }
                    : {}),
                }),
              );
            },
          }),
        },
        COMMIT: {
          target: "validating",
          actions: assign({
            evaluation: ({ context, event }) =>
              evaluateCandidate(context.session, event.rawText, event.nativeInvalid, event.intent),
            draftPatch: undefined,
            affectedCellKeys: [],
            acceptedChange: undefined,
          }),
        },
        CANCEL: {
          target: "idle",
          actions: assign({
            session: undefined,
            draftPatch: undefined,
            affectedCellKeys: [],
            evaluation: undefined,
            acceptedChange: undefined,
          }),
        },
      },
    },
    validating: {
      always: [
        {
          guard: ({ context }) => context.evaluation?.kind === "accepted",
          target: "idle",
          actions: assign({
            session: undefined,
            draftPatch: ({ context }) => createAcceptedDraftPatch(context),
            affectedCellKeys: ({ context }) =>
              Object.freeze([getAcceptedEvaluation(context).cellKey]),
            acceptedChange: ({ context }) => getAcceptedEvaluation(context).change,
            evaluation: undefined,
          }),
        },
        {
          target: "editing",
          actions: assign({
            session: ({ context }) => {
              const session = context.session;
              const evaluation = context.evaluation;
              return session === undefined || evaluation?.kind !== "invalid"
                ? session
                : evaluation.reason === "permission"
                  ? Object.freeze({ ...session, permissionMessage: evaluation.message })
                  : evaluation.reason === "rowMissing"
                    ? session
                    : evaluation.reason === "rowVersion"
                      ? session
                      : Object.freeze({ ...session, invalidMessage: evaluation.message });
            },
            affectedCellKeys: [],
            draftPatch: undefined,
            acceptedChange: undefined,
            evaluation: undefined,
          }),
        },
      ],
    },
  },
});

function prepareSession(
  event: Extract<CellEditEvent, { readonly type: "START" }>,
): ActiveSession | undefined {
  const { column, row } = event;
  if (
    event.mode === "replace" &&
    event.producedText.length > BRUNO_TABLE_CELL_EDIT_MAX_CANDIDATE_LENGTH
  ) {
    return undefined;
  }
  if (
    column?.kind !== "field" ||
    column.isEditable === undefined ||
    column.isEditable === false ||
    typeof row !== "object" ||
    row === null
  ) {
    return undefined;
  }
  if (event.sourceValue._tag === "Failure") return undefined;
  const sourceValue = event.sourceValue.value;
  const before = event.hasDraft ? event.draftValue : sourceValue;
  if (!isEditorValueRepresentable(column, before)) return undefined;
  if (typeof column.isEditable === "function") {
    try {
      if (Reflect.apply(column.isEditable, undefined, [{ row, value: before }]) !== true) {
        return undefined;
      }
    } catch {
      return undefined;
    }
  }
  try {
    return Object.freeze({
      rowId: event.rowId,
      column,
      row,
      baseRow: row,
      baseValue: sourceValue,
      before,
      beforeFromDraft: event.hasDraft,
      sourceValue,
      sourceValueAvailable: true,
      expectedVersion: event.expectedVersion,
      initialText:
        event.mode === "replace"
          ? event.producedText
          : before === null || before === undefined
            ? ""
            : column.semantics.formatCanonicalText(before),
      selectInitialText: event.mode === "current",
      rowMissing: false,
    });
  } catch {
    return undefined;
  }
}

export const BRUNO_TABLE_CELL_EDIT_MAX_CANDIDATE_LENGTH = 65_536;
const BRUNO_TABLE_CELL_EDIT_PERMISSION_MESSAGE = "This cell is no longer editable.";
const BRUNO_TABLE_CELL_EDIT_ROW_MISSING_MESSAGE =
  "This row was removed from the server. Changes cannot be saved.";
const BRUNO_TABLE_CELL_EDIT_ROW_VERSION_MESSAGE =
  "The latest Row Version is unavailable. Try again after the source updates.";
const BRUNO_TABLE_CELL_EDIT_SCHEMA_MESSAGE =
  "This cell's value type changed. Changes cannot be saved.";

function reconcileSessionPermission(session: ActiveSession): ActiveSession {
  const permissionMessage = isSessionEditable(session)
    ? undefined
    : BRUNO_TABLE_CELL_EDIT_PERMISSION_MESSAGE;
  if (session.permissionMessage === permissionMessage) return session;
  const { permissionMessage: _previousPermissionMessage, ...retained } = session;
  return Object.freeze({
    ...retained,
    ...(permissionMessage === undefined ? {} : { permissionMessage }),
  });
}

function isSessionEditable(session: ActiveSession): boolean {
  if (!session.beforeFromDraft && !session.sourceValueAvailable) return false;
  const value = session.beforeFromDraft ? session.before : session.sourceValue;
  if (!isEditorValueRepresentable(session.column, value)) return false;
  const policy = session.column.isEditable;
  if (policy === true) return true;
  if (typeof policy !== "function") return false;
  try {
    return Reflect.apply(policy, undefined, [{ row: session.row, value }]) === true;
  } catch {
    return false;
  }
}

function isDraftEditable(column: CompiledFieldColumn, row: object, value: unknown): boolean {
  if (!isEditorValueRepresentable(column, value)) return false;
  if (column.isEditable === true) return true;
  if (typeof column.isEditable !== "function") return false;
  try {
    return Reflect.apply(column.isEditable, undefined, [{ row, value }]) === true;
  } catch {
    return false;
  }
}

function evaluateCandidate(
  session: ActiveSession | undefined,
  rawText: string,
  nativeInvalid = false,
  intent: "scalar" | "blank" = "scalar",
): CommitEvaluation {
  if (session === undefined) {
    return Object.freeze({ kind: "invalid", message: "The value is invalid." });
  }
  if (session.rowMissing) {
    return Object.freeze({
      kind: "invalid",
      message: BRUNO_TABLE_CELL_EDIT_ROW_MISSING_MESSAGE,
      reason: "rowMissing",
    });
  }
  if (session.rowVersionMessage !== undefined) {
    return Object.freeze({
      kind: "invalid",
      message: session.rowVersionMessage,
      reason: "rowVersion",
    });
  }
  if (!isSessionEditable(session)) {
    return Object.freeze({
      kind: "invalid",
      message: BRUNO_TABLE_CELL_EDIT_PERMISSION_MESSAGE,
      reason: "permission",
    });
  }
  if (rawText.length > BRUNO_TABLE_CELL_EDIT_MAX_CANDIDATE_LENGTH) {
    return Object.freeze({
      kind: "invalid",
      message: `Enter at most ${String(BRUNO_TABLE_CELL_EDIT_MAX_CANDIDATE_LENGTH)} characters.`,
    });
  }
  if (nativeInvalid) {
    return Object.freeze({ kind: "invalid", message: "Enter a valid number." });
  }
  const blankIntent =
    intent === "blank" ||
    (rawText.length === 0 &&
      session.column.blankValue !== undefined &&
      session.column.semantics.editorFamily !== "select");
  if (intent === "blank" && session.column.blankValue === undefined) {
    return Object.freeze({ kind: "invalid", message: "Enter a value." });
  }
  if (
    rawText.length === 0 &&
    !blankIntent &&
    session.column.blankValue === undefined &&
    session.column.semantics.editorFamily !== "select" &&
    (session.column.semantics.editorFamily !== "text" ||
      session.column.semantics.filterFamily === "numeric")
  ) {
    return Object.freeze({ kind: "invalid", message: "Enter a value." });
  }
  let parsed: unknown;
  try {
    parsed =
      blankIntent && session.column.blankValue !== undefined
        ? { _tag: "Success", value: session.column.blankValue.value }
        : session.column.semantics.parseCanonicalText(rawText);
  } catch {
    return Object.freeze({ kind: "invalid", message: "The value is invalid." });
  }
  if (typeof parsed !== "object" || parsed === null || !("_tag" in parsed)) {
    return Object.freeze({ kind: "invalid", message: "The value is invalid." });
  }
  if (parsed._tag === "Failure") {
    return Object.freeze({
      kind: "invalid",
      message:
        "message" in parsed && typeof parsed.message === "string"
          ? boundedMessage(parsed.message)
          : "The value is invalid.",
    });
  }
  if (parsed._tag !== "Success" || !("value" in parsed)) {
    return Object.freeze({ kind: "invalid", message: "The value is invalid." });
  }
  let after = parsed.value;
  if (!blankIntent) {
    let decoded: unknown;
    try {
      decoded = session.column.semantics.decodeRuntime(after);
    } catch {
      return Object.freeze({ kind: "invalid", message: "The value is invalid." });
    }
    if (typeof decoded !== "object" || decoded === null || !("_tag" in decoded)) {
      return Object.freeze({ kind: "invalid", message: "The value is invalid." });
    }
    if (decoded._tag === "Failure") {
      return Object.freeze({
        kind: "invalid",
        message:
          "message" in decoded && typeof decoded.message === "string"
            ? boundedMessage(decoded.message)
            : "The value is invalid.",
      });
    }
    if (decoded._tag !== "Success" || !("value" in decoded)) {
      return Object.freeze({ kind: "invalid", message: "The value is invalid." });
    }
    after = decoded.value;
  }
  if (session.column.validate !== undefined) {
    let result: unknown;
    try {
      result = Reflect.apply(session.column.validate, undefined, [
        { row: session.row, value: after },
      ]);
    } catch {
      result = "The value could not be validated.";
    }
    if (result !== undefined) {
      return Object.freeze({
        kind: "invalid",
        message:
          typeof result === "string" && result.trim().length > 0
            ? boundedMessage(result)
            : "The value is invalid.",
      });
    }
  }
  if (!session.sourceValueAvailable) {
    return Object.freeze({ kind: "invalid", message: "The source value is invalid." });
  }
  const sourceValue = session.sourceValue;
  const equivalentBefore = safeEquivalentEditValue(session.column, session.before, after);
  const equivalentSource = safeEquivalentEditValue(session.column, after, sourceValue);
  if (equivalentBefore === undefined || equivalentSource === undefined) {
    return Object.freeze({ kind: "invalid", message: "The value is invalid." });
  }
  const changed = !equivalentBefore;
  const removeDraft = equivalentSource || (!session.beforeFromDraft && equivalentBefore);
  return Object.freeze({
    kind: "accepted",
    cellKey: cellKey(session.rowId, session.column.columnId),
    value: after,
    removeDraft,
    ...(changed && (!equivalentSource || session.beforeFromDraft)
      ? {
          change: Object.freeze({
            rowId: session.rowId,
            columnId: session.column.columnId,
            field: session.column.field,
            before: session.before,
            after,
          }),
        }
      : {}),
  });
}

function safeEquivalentEditValue(
  column: CompiledFieldColumn,
  left: unknown,
  right: unknown,
): boolean | undefined {
  return safeEquivalentEditValues(column.semantics.equivalent, left, right);
}

function safeEquivalentEditValues(
  equivalent: (left: unknown, right: unknown) => boolean,
  left: unknown,
  right: unknown,
): boolean | undefined {
  try {
    // Equality authorities are required to be reflexive. Preserve the exact
    // identity fast path before invoking a potentially more expensive custom
    // authority; mass source convergence commonly compares thousands of
    // already-canonical primitive values in one frame.
    if (Object.is(left, right)) return true;
    if (left === null || left === undefined || right === null || right === undefined) {
      return Object.is(left, right);
    }
    const result: unknown = equivalent(left, right);
    return typeof result === "boolean" ? result : undefined;
  } catch {
    return undefined;
  }
}

function isEditorValueRepresentable(column: CompiledFieldColumn, value: unknown): boolean {
  const booleanValues = column.semantics.booleanEditorCanonicalValues;
  if (column.semantics.editorFamily !== "boolean" || booleanValues === undefined) return true;
  if (value === null || value === undefined) {
    return column.blankValue !== undefined && Object.is(value, column.blankValue.value);
  }
  try {
    const canonicalText = column.semantics.formatCanonicalText(value);
    return canonicalText === booleanValues[0] || canonicalText === booleanValues[1];
  } catch {
    return false;
  }
}

function getAcceptedEvaluation(
  context: CellEditContext,
): Extract<CommitEvaluation, { readonly kind: "accepted" }> {
  const evaluation = context.evaluation;
  if (evaluation?.kind !== "accepted") {
    throw new TypeError("BrunoTable Cell Edit accepted without evaluated candidate evidence.");
  }
  return evaluation;
}

function createAcceptedDraftPatch(context: CellEditContext): DraftPatch {
  const evaluation = getAcceptedEvaluation(context);
  const session = context.session;
  if (session === undefined) {
    throw new TypeError("BrunoTable Cell Edit accepted without session evidence.");
  }
  return evaluation.removeDraft
    ? Object.freeze({ kind: "remove", cellKey: evaluation.cellKey, value: evaluation.value })
    : Object.freeze({
        kind: "set",
        cellKey: evaluation.cellKey,
        value: evaluation.value,
        rowId: session.rowId,
        columnId: session.column.columnId,
        field: session.column.field,
        baseRow: session.baseRow,
        expectedVersion: session.expectedVersion,
        base: session.baseValue,
      });
}

function applyDraftPatch(
  drafts: ReadonlyMap<string, DraftEntry>,
  patch: DraftPatch,
  columns: ReadonlyMap<string, CompiledFieldColumn>,
): ReadonlyMap<string, DraftEntry> {
  const previous = drafts.get(patch.cellKey);
  if (patch.kind === "remove" && previous === undefined) return drafts;
  if (patch.kind === "set" && previous !== undefined) {
    const column = columns.get(patch.columnId);
    if (
      column !== undefined &&
      safeEquivalentEditValue(column, previous.mine, patch.value) === true
    ) {
      return drafts;
    }
  }
  const next = new Map(drafts);
  if (patch.kind === "remove") next.delete(patch.cellKey);
  else {
    const retained =
      previous === undefined
        ? {
            rowId: patch.rowId,
            columnId: patch.columnId,
            field: patch.field,
            baseRow: patch.baseRow,
            expectedVersion: patch.expectedVersion,
            base: patch.base,
            ...(patch.validationMessage === undefined
              ? {}
              : { validationMessage: patch.validationMessage }),
            ...(patch.conflict === undefined ? {} : { conflict: patch.conflict }),
          }
        : {
            rowId: previous.rowId,
            columnId: previous.columnId,
            field: previous.field,
            baseRow: previous.baseRow,
            expectedVersion: previous.expectedVersion,
            base: previous.base,
            ...(patch.validationMessage === undefined
              ? {}
              : { validationMessage: patch.validationMessage }),
            ...(patch.conflict === undefined
              ? previous.conflict === undefined
                ? {}
                : { conflict: previous.conflict }
              : { conflict: patch.conflict }),
          };
    next.set(
      patch.cellKey,
      Object.freeze({
        ...retained,
        mine: patch.value,
      }),
    );
  }
  return next;
}

function pruneDraftHistory(
  commands: readonly DraftHistoryCommand[],
  convergedCellKeys: ReadonlySet<string>,
): readonly DraftHistoryCommand[] {
  if (convergedCellKeys.size === 0) return commands;
  const retained: DraftHistoryCommand[] = [];
  for (const command of commands) {
    let patches = command.patches;
    for (const key of convergedCellKeys) patches = patches.with(key, undefined);
    if (patches.size === 0) continue;
    retained.push(
      patches === command.patches ? command : Object.freeze({ lineage: command.lineage, patches }),
    );
  }
  return retained;
}

function pruneDraftHistoryBulk(
  commands: readonly DraftHistoryCommand[],
  convergedCellKeys: ReadonlySet<string>,
): readonly DraftHistoryCommand[] {
  if (convergedCellKeys.size === 0) return commands;
  let changed = false;
  const retained: DraftHistoryCommand[] = [];
  for (const command of commands) {
    let commandChanged = false;
    const nextPatches = new DraftHistoryPatchMapBuilder();
    for (const [key, patch] of command.patches) {
      if (convergedCellKeys.has(key)) {
        commandChanged = true;
        continue;
      }
      nextPatches.set(key, patch);
    }
    if (!commandChanged) {
      retained.push(command);
      continue;
    }
    changed = true;
    const patches = nextPatches.build();
    if (patches.size > 0) {
      retained.push(Object.freeze({ lineage: command.lineage, patches }));
    }
  }
  return changed ? Object.freeze(retained) : commands;
}

function pruneDraftHistoryAdaptive(
  commands: readonly DraftHistoryCommand[],
  convergedCellKeys: ReadonlySet<string>,
): readonly DraftHistoryCommand[] {
  return convergedCellKeys.size <= BRUNO_TABLE_DRAFT_HISTORY_PATCH_BUCKET_COUNT / 2
    ? pruneDraftHistory(commands, convergedCellKeys)
    : pruneDraftHistoryBulk(commands, convergedCellKeys);
}

function setDraftBlockedReason(
  draft: DraftEntry | undefined,
  blockedReason: string | undefined,
): DraftEntry | undefined {
  if (draft === undefined || draft.blockedReason === blockedReason) return draft;
  const { blockedReason: _previousBlockedReason, ...retained } = draft;
  return Object.freeze({
    ...retained,
    ...(blockedReason === undefined ? {} : { blockedReason }),
  });
}

type ConflictEvidence = Readonly<{
  readonly server: unknown;
  readonly serverVersion: unknown;
  readonly column: CompiledFieldColumn;
}>;

function setDraftConflictEvidence(
  draft: DraftEntry | undefined,
  evidence: ConflictEvidence,
): DraftEntry | undefined {
  if (draft === undefined) return undefined;
  const sameServerValue =
    draft.conflict !== undefined &&
    safeEquivalentEditValue(evidence.column, draft.conflict.server, evidence.server) === true;
  const sameServerVersion =
    draft.conflict !== undefined && Object.is(draft.conflict.serverVersion, evidence.serverVersion);
  if (sameServerValue && sameServerVersion && Object.is(draft.conflict.server, evidence.server)) {
    return draft;
  }
  return Object.freeze({
    ...draft,
    conflict: Object.freeze({
      server: evidence.server,
      serverVersion: evidence.serverVersion,
      ...(sameServerValue && sameServerVersion && draft.conflict?.resolution !== undefined
        ? { resolution: draft.conflict.resolution }
        : {}),
    }),
  });
}

function clearDraftConflictEvidence(draft: DraftEntry | undefined): DraftEntry | undefined {
  if (draft?.conflict === undefined) return draft;
  const { conflict: _conflict, ...retained } = draft;
  return Object.freeze(retained);
}

function reconcileInvalidatedResolutionHistory(
  commands: readonly DraftHistoryCommand[],
  evidenceByKey: ReadonlyMap<string, ConflictEvidence>,
  resolutionLineageByKey: ReadonlyMap<string, object>,
): readonly DraftHistoryCommand[] {
  if (evidenceByKey.size === 0 && resolutionLineageByKey.size === 0) return commands;
  let changed = false;
  const nextCommands: DraftHistoryCommand[] = [];
  for (const command of commands) {
    let commandChanged = false;
    const nextPatches = new DraftHistoryPatchMapBuilder();
    for (const [key, patch] of command.patches) {
      if (resolutionLineageByKey.get(key) === command.lineage) {
        commandChanged = true;
        continue;
      }
      const evidence = evidenceByKey.get(key);
      if (evidence === undefined) {
        nextPatches.set(key, patch);
        continue;
      }
      const before = setDraftConflictEvidence(patch.before, evidence);
      const after = setDraftConflictEvidence(patch.after, evidence);
      const nextPatch =
        before === patch.before && after === patch.after
          ? patch
          : Object.freeze({ ...patch, before, after });
      commandChanged ||= nextPatch !== patch;
      nextPatches.set(key, nextPatch);
    }
    if (!commandChanged) {
      nextCommands.push(command);
      continue;
    }
    changed = true;
    const patches = nextPatches.build();
    if (patches.size > 0) {
      nextCommands.push(Object.freeze({ lineage: command.lineage, patches }));
    }
  }
  return changed ? Object.freeze(nextCommands) : commands;
}

function findDraftHistoryEntry(
  undoStack: readonly DraftHistoryCommand[],
  redoStack: readonly DraftHistoryCommand[],
  key: string,
): DraftEntry | undefined {
  for (const commands of [redoStack, undoStack]) {
    for (let index = commands.length - 1; index >= 0; index -= 1) {
      const patch = commands[index]?.patches.get(key);
      const entry = patch?.after ?? patch?.before;
      if (entry !== undefined) return entry;
    }
  }
  return undefined;
}

type DraftColumnReconciliationPlan =
  | Readonly<{ readonly kind: "drop" }>
  | Readonly<{
      readonly kind: "retain";
      readonly previousColumn: CompiledFieldColumn;
      readonly nextColumn: CompiledFieldColumn;
      readonly transformValues: boolean;
      readonly refreshPermission: boolean;
      readonly checkConvergence: boolean;
    }>;

type DraftColumnReconciliationContext = Readonly<{
  readonly plans: ReadonlyMap<string, DraftColumnReconciliationPlan>;
  readonly nextColumns: ReadonlyMap<string, CompiledFieldColumn>;
  readonly getRow: (rowId: string) => unknown;
  readonly rows: Map<string, unknown>;
  readonly migratedValues: WeakMap<DraftEntry, DraftEntry | null>;
  readonly semanticKeys: Set<string>;
  readonly protectedPresentationColumns: ReadonlyMap<string, CompiledFieldColumn>;
  readonly draftChangesRequired: boolean;
  readonly historyChangesRequired: boolean;
}>;

function createDraftColumnReconciliationContext(
  previousColumns: ReadonlyMap<string, CompiledFieldColumn>,
  nextColumns: ReadonlyMap<string, CompiledFieldColumn>,
  getRow: (rowId: string) => unknown,
  protectedPresentationColumns: ReadonlyMap<string, CompiledFieldColumn>,
  retainedPresentationWork: boolean,
): DraftColumnReconciliationContext {
  const plans = new Map<string, DraftColumnReconciliationPlan>();
  let draftChangesRequired = false;
  let historyChangesRequired = false;
  for (const [columnId, previousColumn] of previousColumns) {
    const nextColumn = nextColumns.get(columnId);
    if (nextColumn === undefined || previousColumn.field !== nextColumn.field) {
      plans.set(columnId, Object.freeze({ kind: "drop" }));
      draftChangesRequired = true;
      historyChangesRequired = true;
      continue;
    }
    const transformValues =
      !sameBlankPolicy(previousColumn, nextColumn) ||
      previousColumn.semantics.decodeRuntimeAuthority !==
        nextColumn.semantics.decodeRuntimeAuthority;
    const refreshPermission =
      transformValues || previousColumn.isEditable !== nextColumn.isEditable;
    const checkConvergence =
      transformValues ||
      previousColumn.semantics.groupedRetentionAuthority.equivalent !==
        nextColumn.semantics.groupedRetentionAuthority.equivalent;
    draftChangesRequired ||= transformValues || refreshPermission || checkConvergence;
    historyChangesRequired ||= transformValues || checkConvergence;
    plans.set(
      columnId,
      Object.freeze({
        kind: "retain",
        previousColumn,
        nextColumn,
        transformValues,
        refreshPermission,
        checkConvergence,
      }),
    );
  }
  return Object.freeze({
    plans,
    nextColumns,
    getRow,
    rows: new Map<string, unknown>(),
    migratedValues: new WeakMap<DraftEntry, DraftEntry | null>(),
    semanticKeys: new Set<string>(),
    protectedPresentationColumns,
    draftChangesRequired: draftChangesRequired || retainedPresentationWork,
    historyChangesRequired: historyChangesRequired || retainedPresentationWork,
  });
}

function reconcileDraftHistoryForColumns(
  commands: readonly DraftHistoryCommand[],
  context: DraftColumnReconciliationContext,
): Readonly<{
  readonly commands: readonly DraftHistoryCommand[];
  readonly changedKeys: ReadonlySet<string>;
}> {
  if (!context.historyChangesRequired) {
    return Object.freeze({ commands, changedKeys: new Set<string>() });
  }
  let changed = false;
  const changedKeys = new Set<string>();
  const nextCommands: DraftHistoryCommand[] = [];
  for (const command of commands) {
    const nextPatches = new DraftHistoryPatchMapBuilder();
    let commandChanged = false;
    for (const [key, patch] of command.patches) {
      const before =
        patch.before === undefined
          ? undefined
          : reconcileDraftEntryForColumns(key, patch.before, context, false);
      const after =
        patch.after === undefined
          ? undefined
          : reconcileDraftEntryForColumns(key, patch.after, context, false);
      const representative = patch.after ?? patch.before;
      const plan =
        representative === undefined ? undefined : context.plans.get(representative.columnId);
      const authored =
        after !== undefined
          ? ({ _tag: "Success", value: after.mine } as const)
          : plan?.kind === "retain" && plan.transformValues
            ? reconcileDraftValueForColumns(
                patch.authoredValue,
                plan.previousColumn,
                plan.nextColumn,
              )
            : ({ _tag: "Success", value: patch.authoredValue } as const);
      if (
        (patch.before !== undefined && before === undefined) ||
        (patch.after !== undefined && after === undefined) ||
        authored._tag === "Failure"
      ) {
        commandChanged = true;
        changedKeys.add(key);
        continue;
      }
      if (
        before !== patch.before ||
        after !== patch.after ||
        !Object.is(authored.value, patch.authoredValue)
      ) {
        commandChanged = true;
        changedKeys.add(key);
        nextPatches.set(
          key,
          Object.freeze({ cellKey: key, before, after, authoredValue: authored.value }),
        );
      } else {
        nextPatches.set(key, patch);
      }
    }
    if (!commandChanged) nextCommands.push(command);
    else {
      changed = true;
      const patches = nextPatches.build();
      if (patches.size > 0) {
        nextCommands.push(Object.freeze({ lineage: command.lineage, patches }));
      }
    }
  }
  return Object.freeze({
    commands: changed ? Object.freeze(nextCommands) : commands,
    changedKeys,
  });
}

function retainedHistoryMineConverged(
  undoStack: readonly DraftHistoryCommand[],
  redoStack: readonly DraftHistoryCommand[],
  key: string,
  column: CompiledFieldColumn,
  sourceValue: unknown,
): boolean {
  for (let index = 0; index < redoStack.length; index += 1) {
    const command = redoStack[index];
    if (command === undefined) continue;
    const patch = command.patches.get(key);
    if (patch === undefined) continue;
    return safeEquivalentEditValue(column, patch.authoredValue, sourceValue) === true;
  }
  for (let index = undoStack.length - 1; index >= 0; index -= 1) {
    const command = undoStack[index];
    if (command === undefined) continue;
    const patch = command.patches.get(key);
    if (patch === undefined) continue;
    return safeEquivalentEditValue(column, patch.authoredValue, sourceValue) === true;
  }
  return false;
}

function retainedHistoryMineMatchesBase(
  undoStack: readonly DraftHistoryCommand[],
  redoStack: readonly DraftHistoryCommand[],
  key: string,
  column: CompiledFieldColumn,
): boolean {
  for (let index = 0; index < redoStack.length; index += 1) {
    const patch = redoStack[index]?.patches.get(key);
    if (patch === undefined) continue;
    return (
      patch.after !== undefined &&
      safeEquivalentEditValue(column, patch.after.mine, patch.after.base) === true
    );
  }
  for (let index = undoStack.length - 1; index >= 0; index -= 1) {
    const patch = undoStack[index]?.patches.get(key);
    if (patch === undefined) continue;
    return (
      patch.after !== undefined &&
      safeEquivalentEditValue(column, patch.after.mine, patch.after.base) === true
    );
  }
  return false;
}

function createDraftHistoryCommand(
  first: DraftHistoryCellPatch,
  ...rest: DraftHistoryCellPatch[]
): DraftHistoryCommand {
  const patches = new Map<string, DraftHistoryCellPatch>();
  patches.set(first.cellKey, first);
  for (const patch of rest) patches.set(patch.cellKey, patch);
  return Object.freeze({
    lineage: Object.freeze({}),
    patches: DraftHistoryPatchMap.from(patches),
  });
}

function createDraftHistoryCommandFromPatches(patches: DraftHistoryPatchMap): DraftHistoryCommand {
  if (patches.size === 0) {
    throw new TypeError("BrunoTable Batch History Command requires a non-empty patch set.");
  }
  return Object.freeze({
    lineage: Object.freeze({}),
    patches,
  });
}

export type BrunoTableCellEditSessionSnapshot =
  | Readonly<{ readonly kind: "idle" }>
  | Readonly<{
      readonly kind: "editing";
      readonly rowId: string;
      readonly columnId: string;
      readonly initialText: string;
      readonly selectInitialText: boolean;
      readonly rowMissing: boolean;
      readonly invalidMessage?: string;
    }>;

export type BrunoTableCellEditProjection = Readonly<{
  readonly active: boolean;
  readonly hasDraft: boolean;
  readonly conflicted?: boolean;
  readonly blockedReason?: string;
  readonly hasAcceptedOverlay?: boolean;
  readonly savePending?: boolean;
  readonly saveFailed?: boolean;
  readonly saveSucceeded?: boolean;
  readonly draft?: unknown;
  readonly acceptedOverlay?: unknown;
  readonly acceptedOverlayPresentationColumn?: CompiledFieldColumn;
  readonly draftPresentationColumn?: CompiledFieldColumn;
}>;
export type BrunoTableCellEditMovement =
  | "enter-forward"
  | "enter-backward"
  | "tab-forward"
  | "tab-backward";
export type BrunoTableCellEditMovementOrigin = Readonly<{
  readonly rowId: string;
  readonly columnId: string;
  readonly retainedRowIndex: number;
}>;
export type BrunoTableCellEditActivitySnapshot = Readonly<{
  readonly activeEditor: boolean;
  readonly activeCandidatePending: boolean;
  readonly reviewCount: number;
  readonly draftCount: number;
  readonly undoCount: number;
  readonly redoCount: number;
  readonly blockedCount: number;
  readonly validationCount: number;
  readonly conflictCount: number;
}>;
const IDLE_SESSION: BrunoTableCellEditSessionSnapshot = Object.freeze({ kind: "idle" });
const IDLE_CELL: BrunoTableCellEditProjection = Object.freeze({ active: false, hasDraft: false });
const IDLE_ACTIVITY: BrunoTableCellEditActivitySnapshot = Object.freeze({
  activeEditor: false,
  activeCandidatePending: false,
  reviewCount: 0,
  draftCount: 0,
  undoCount: 0,
  redoCount: 0,
  blockedCount: 0,
  validationCount: 0,
  conflictCount: 0,
});
const EMPTY_DRAFT_REVIEW_CLASSIFICATION: BrunoTableCellEditDraftReviewClassificationSnapshot =
  Object.freeze({
    conflictIds: new Set<string>(),
    blockedIds: new Set<string>(),
  });
const BRUNO_TABLE_BATCH_HISTORY_LIMIT = 100;
type ActiveCandidateSnapshot =
  | Readonly<{ readonly kind: "scalar"; readonly rawText: string; readonly nativeInvalid: boolean }>
  | Readonly<{ readonly kind: "blank"; readonly rawText: ""; readonly nativeInvalid: false }>;
const EMPTY_CANDIDATE: ActiveCandidateSnapshot = Object.freeze({
  kind: "scalar",
  rawText: "",
  nativeInvalid: false,
});

export class BrunoTableCellEditRuntime {
  private columns: readonly CompiledColumn[];
  private fieldColumnsById: ReadonlyMap<string, CompiledFieldColumn>;
  private readonly getRow: (rowId: string) => unknown;
  private readonly getCanonicalValue:
    | ((rowId: string, columnId: string) => CanonicalSourceValue)
    | undefined;
  private getRowVersion: ((row: object) => unknown) | undefined;
  private projectEditRow: BrunoTableCellEditRowProjector | undefined;
  private getProjectedRowId: ((row: object) => string) | undefined;
  private editRowProjectorEpoch = 0;
  private readonly draftReviewProjectedRowsByRowId = new Map<
    string,
    DraftReviewProjectedRowCacheEntry
  >();
  private draftReviewProjectionHistoryByRowId = new Map<
    string,
    DraftReviewProjectedRowCacheEntry
  >();
  private readonly isSourceAuthoritative: () => boolean;
  private canonicalSourceValueCache = new WeakMap<
    object,
    Map<unknown, Map<string, CanonicalSourceValue>>
  >();
  private draftProjectionCache = new WeakMap<DraftEntry, BrunoTableCellEditProjection>();
  private readonly onCommit: (
    change: BrunoTableCellEditChange,
  ) => BrunoTableCellEditImmediateSaveResult | boolean | void;
  private readonly onCommitGesture: (
    changes: BrunoTableCellEditChangeGesture,
  ) => BrunoTableCellEditImmediateSaveResult | boolean | void;
  private actor = createActor(brunoTableCellEditMachine);
  private actorActive = false;
  private deferActorDraftSideEffects = false;
  private readonly sessionStore = new Store<BrunoTableCellEditSessionSnapshot>(IDLE_SESSION);
  private readonly draftMemoryStore = new Store<DraftMemoryState>(
    Object.freeze({
      drafts: new Map(),
      undoStack: Object.freeze([]),
      redoStack: Object.freeze([]),
    }),
  );
  private readonly draftStore = {
    get: (): ReadonlyMap<string, DraftEntry> => this.draftMemoryStore.get().drafts,
  };
  private readonly activityStore = new Store<BrunoTableCellEditActivitySnapshot>(IDLE_ACTIVITY);
  private readonly draftReviewStore = new Store<readonly BrunoTableCellEditDraftReviewSourceRow[]>(
    Object.freeze([]),
  );
  private readonly draftReviewClassificationStore =
    new Store<BrunoTableCellEditDraftReviewClassificationSnapshot>(
      EMPTY_DRAFT_REVIEW_CLASSIFICATION,
    );
  private readonly draftReviewConflictIds = new Set<string>();
  private readonly draftReviewBlockedIds = new Set<string>();
  private readonly retainedResolutionPublicationStore = new Store<ReadonlySet<string>>(
    new Set<string>(),
  );
  private draftReviewSubscriberCount = 0;
  private draftReviewVersion = 0;
  private draftReviewRowsById = new Map<string, BrunoTableCellEditDraftReviewSourceRow>();
  private draftReviewRowStoresById = new Map<string, Store<BrunoTableCellEditDraftReviewRow>>();
  private draftReviewEntriesById = new Map<string, DraftEntry>();
  private resolvedDraftReviewEntriesById = new Map<string, DraftEntry>();
  private readonly resolvedDraftReviewIds = new Set<string>();
  private readonly resolvedDraftReviewLineagesById = new Map<string, object>();
  private readonly resolvedDraftReviewIdsByLineage = new Map<object, string | Set<string>>();
  private readonly pendingReleasedResolutionIds = new Set<string>();
  private readonly editOwnedControls = new WeakSet<Element>();
  private readonly candidateStore = new Store<ActiveCandidateSnapshot>(EMPTY_CANDIDATE);
  private readonly cellStores = new Map<string, Store<BrunoTableCellEditProjection>>();
  private readonly cellSubscriberCounts = new Map<string, number>();
  private acceptedOverlays: ReadonlyMap<string, AcceptedOverlayEntry> = new Map();
  private readonly acceptedOverlayCountsByOperation = new Map<string, number>();
  private readonly acceptedOverlayCountsByOperationRow = new Map<string, Map<string, number>>();
  private readonly acceptedOverlayCountStoresByOperation = new Map<string, Store<number>>();
  private readonly acceptedOverlayKeysByRowId = new Map<string, Set<string>>();
  private rejectedOperations: ReadonlyMap<string, RejectedOperationEvidence> = new Map();
  private readonly rejectedOperationCellCounts = new Map<string, number>();
  private readonly rejectedOperationStores = new Map<
    string,
    Store<BrunoTableCellEditRejectedOperationUpdate>
  >();
  private readonly rejectedOperationIdsByRowId = new Map<string, Set<string>>();
  private readonly rejectedBatchOperationIds = new Set<string>();
  private readonly rejectedCellKeys = new Map<string, Set<string>>();
  private readonly rejectedCellPresentationDeadlinesByOperation = new Map<string, number>();
  private readonly successFlashOperationByKey = new Map<string, string>();
  private readonly successFlashDeadlinesByKey = new Map<string, number>();
  private readonly cellPresentationDeadlineQueue = new Debouncer(
    () => this.expireCellPresentationDeadlines(),
    {
      wait: () => this.getCellPresentationDeadlineWait(),
    },
  );
  private readonly saveLockedCellKeys = new Map<string, string>();
  private readonly saveLockedCellKeysByOperationRow = new Map<string, Map<string, Set<string>>>();
  private readonly pendingOperationIdsByRowId = new Map<string, Set<string>>();
  private readonly batchSaveOperationIds = new Set<string>();
  private readonly pendingConvergedCellKeysByOperation = new Map<string, Set<string>>();
  private readonly submittedValuesByOperation = new Map<string, ReadonlyMap<string, unknown>>();
  private readonly rowVersionExtractorsByOperation = new Map<
    string,
    ((row: object) => unknown) | undefined
  >();
  private readonly valueAuthoritiesByOperation = new Map<
    string,
    ReadonlyMap<string, SubmittedValueAuthority>
  >();
  private batchSaveLockOperationId: string | undefined;
  private readonly traversalInvalidationListeners = new Set<Listener>();
  private readonly traversalIndex: BrunoTableCellEditTraversalIndex;
  private appliedDraftPatch: DraftPatch | undefined;
  private activeCellKey: string | undefined;
  private activeCandidate:
    | Readonly<{
        readonly restoreFocus: () => void;
      }>
    | undefined;
  private movementCommand:
    | ((
        movement: BrunoTableCellEditMovement,
        origin: BrunoTableCellEditMovementOrigin | undefined,
      ) => boolean)
    | undefined;
  private retainedMovementRowIndex: number | undefined;
  private batchHistoryEnabled = false;
  private saveOperationCapacityAvailable = true;
  private readonly blockedDraftKeys = new Set<string>();
  private readonly rowVersionBlockedRowIds = new Set<string>();
  private readonly validationDraftKeys = new Set<string>();
  private readonly conflictDraftKeys = new Set<string>();
  private readonly draftEvidenceKeys = new Set<string>();
  private readonly draftKeysByRowId = new Map<string, string | Set<string>>();
  private readonly draftHistoryLocations = new Map<object, DraftHistoryLocation>();
  private readonly draftHistoryLineagesByCellKey = new Map<string, object | Set<object>>();
  private soleDraftHistoryLineage: object | undefined;
  private readonly pendingDraftHistoryEvidenceKeys = new Set<string>();
  private undoHistoryCount = 0;
  private redoHistoryCount = 0;

  private get undoStack(): readonly DraftHistoryCommand[] {
    return this.draftMemoryStore.get().undoStack;
  }

  private get redoStack(): readonly DraftHistoryCommand[] {
    return this.draftMemoryStore.get().redoStack;
  }

  public constructor(
    options: Readonly<{
      readonly columns: readonly CompiledColumn[];
      readonly getRow: (rowId: string) => unknown;
      readonly getCanonicalValue?: (rowId: string, columnId: string) => CanonicalSourceValue;
      readonly getRowVersion?: (row: object) => unknown;
      readonly getRowId?: (row: object) => string;
      readonly projectEditRow?: BrunoTableCellEditRowProjector;
      readonly isSourceAuthoritative?: () => boolean;
      readonly onCommit?: (
        change: BrunoTableCellEditChange,
      ) => BrunoTableCellEditImmediateSaveResult | boolean | void;
      readonly onCommitGesture?: (
        changes: BrunoTableCellEditChangeGesture,
      ) => BrunoTableCellEditImmediateSaveResult | boolean | void;
      readonly incrementalTraversal?: boolean;
    }>,
  ) {
    this.columns = options.columns;
    this.fieldColumnsById = indexFieldColumns(options.columns);
    this.getRow = options.getRow;
    this.getCanonicalValue = options.getCanonicalValue;
    this.getRowVersion = options.getRowVersion;
    this.getProjectedRowId = options.getRowId;
    this.projectEditRow = options.projectEditRow;
    if ((this.projectEditRow === undefined) !== (this.getProjectedRowId === undefined)) {
      throw new TypeError(
        "BrunoTable Edit Row projection requires both projectEditRow and getRowId.",
      );
    }
    this.isSourceAuthoritative = options.isSourceAuthoritative ?? (() => true);
    this.onCommit = options.onCommit ?? (() => undefined);
    this.onCommitGesture = options.onCommitGesture ?? (() => undefined);
    this.traversalIndex = new BrunoTableCellEditTraversalIndex(
      this.getRow,
      (rowId, row, column) => this.evaluateEditable(rowId, row, column),
      options.incrementalTraversal === true,
    );
  }

  public readonly activate = (): void => {
    if (this.actorActive) return;
    if (this.actor.getSnapshot().status === "stopped") {
      this.actor = createActor(brunoTableCellEditMachine);
    }
    this.actor.subscribe(() => this.publishActorDecision());
    this.actor.start();
    this.actorActive = true;
  };

  public readonly getSessionSnapshot = (): BrunoTableCellEditSessionSnapshot =>
    this.sessionStore.get();

  public readonly subscribeSession = (listener: Listener): (() => void) => {
    const subscription = this.sessionStore.subscribe(listener);
    return () => subscription.unsubscribe();
  };

  public readonly getActivitySnapshot = (): BrunoTableCellEditActivitySnapshot =>
    this.activityStore.get();

  public readonly setRowVersionExtractor = (
    getRowVersion: ((row: object) => unknown) | undefined,
  ): void => {
    this.getRowVersion = getRowVersion;
    if (!this.isSourceAuthoritative()) return;
    const rowsToReconcile = new Set([
      ...this.rowVersionBlockedRowIds,
      ...this.draftReviewProjectedRowsByRowId.keys(),
    ]);
    const drafts = this.draftStore.get();
    for (const key of this.conflictDraftKeys) {
      const draft = drafts.get(key);
      if (draft !== undefined) rowsToReconcile.add(draft.rowId);
    }
    if (rowsToReconcile.size > 0) {
      this.reconcileDraftRows(rowsToReconcile, true);
    }
    if (this.resolvedDraftReviewIds.size > 0) {
      this.retainedResolutionPublicationStore.setState(() => new Set(this.resolvedDraftReviewIds));
    }
  };

  public readonly setEditRowProjector = (
    projectEditRow: BrunoTableCellEditRowProjector | undefined,
    getRowId: ((row: object) => string) | undefined,
  ): void => {
    if ((projectEditRow === undefined) !== (getRowId === undefined)) {
      throw new TypeError(
        "BrunoTable Edit Row projection requires both projectEditRow and getRowId.",
      );
    }
    if (this.projectEditRow === projectEditRow && this.getProjectedRowId === getRowId) return;
    this.projectEditRow = projectEditRow;
    this.getProjectedRowId = getRowId;
    this.editRowProjectorEpoch += 1;
    this.draftReviewProjectedRowsByRowId.clear();
    if (this.draftReviewSubscriberCount > 0) {
      this.publishDraftReview(
        this.draftStore.get(),
        new Set([...this.draftStore.get().keys(), ...this.resolvedDraftReviewEntriesById.keys()]),
      );
    }
  };

  public readonly subscribeActivity = (listener: Listener): (() => void) => {
    const subscription = this.activityStore.subscribe(listener);
    return () => subscription.unsubscribe();
  };

  public readonly getCellSnapshot = (
    rowId: string,
    columnId: string,
  ): BrunoTableCellEditProjection => this.getCellProjection(cellKey(rowId, columnId));

  public readonly subscribeCell = (
    rowId: string,
    columnId: string,
    listener: Listener,
  ): (() => void) => {
    const key = cellKey(rowId, columnId);
    const store = this.cellStores.get(key) ?? this.installCellStore(key);
    this.cellSubscriberCounts.set(key, (this.cellSubscriberCounts.get(key) ?? 0) + 1);
    const subscription = store.subscribe(listener);
    return () => {
      subscription.unsubscribe();
      const remaining = (this.cellSubscriberCounts.get(key) ?? 1) - 1;
      if (remaining > 0) {
        this.cellSubscriberCounts.set(key, remaining);
        return;
      }
      this.cellSubscriberCounts.delete(key);
      if (this.activeCellKey !== key) this.cellStores.delete(key);
    };
  };

  public readonly getDraftSnapshot = (rowId: string, columnId: string): unknown =>
    this.draftStore.get().get(cellKey(rowId, columnId))?.mine;

  public readonly getDraftMemorySnapshot = (): ReadonlyMap<string, unknown> =>
    this.draftStore.get();

  public readonly hasSaveCellProjection = (rowId: string, columnId: string): boolean => {
    const key = cellKey(rowId, columnId);
    return (
      this.saveLockedCellKeys.has(key) ||
      this.acceptedOverlays.has(key) ||
      this.rejectedCellKeys.has(key) ||
      this.successFlashOperationByKey.has(key)
    );
  };

  public readonly createBatchSaveChangeSet = (): BrunoTableCellEditSaveChangeSet | undefined => {
    if (!this.isSourceAuthoritative()) return undefined;
    const rowIds = new Set([...this.draftStore.get().values()].map((draft) => draft.rowId));
    if (rowIds.size === 0) return undefined;
    this.reconcileSourceRows(rowIds);
    if (this.conflictDraftKeys.size > 0 || this.blockedDraftKeys.size > 0) return undefined;
    const preflight = this.preflightSaveDrafts([...this.draftStore.get().values()]);
    if (preflight.kind !== "ready") return undefined;
    return this.groupSavePreflightEntries(preflight.entries);
  };

  public readonly createImmediateSaveChangeSet = (
    gesture: BrunoTableCellEditChangeGesture,
  ): BrunoTableCellEditImmediateSavePreparation => {
    if (!this.isSourceAuthoritative()) return Object.freeze({ kind: "rejected" });
    const rowIds = new Set(gesture.map((change) => change.rowId));
    this.reconcileSourceRows(rowIds);
    const selectedDrafts = gesture.map((change) =>
      this.draftStore.get().get(cellKey(change.rowId, change.columnId)),
    );
    if (selectedDrafts.some((draft) => draft === undefined || draft.conflict !== undefined)) {
      return Object.freeze({ kind: "reconciled" });
    }
    if (selectedDrafts.some((draft) => draft?.blockedReason !== undefined)) {
      return Object.freeze({ kind: "rejected" });
    }
    const preflight = this.preflightSaveDrafts(selectedDrafts as DraftEntry[]);
    if (preflight.kind !== "ready") return preflight;
    const changeSet = this.groupSavePreflightEntries(preflight.entries);
    return changeSet === undefined
      ? Object.freeze({ kind: "rejected" })
      : Object.freeze({ kind: "change-set", changeSet });
  };

  private readonly groupSavePreflightEntries = (
    preflight: readonly SavePreflightEntry[],
  ): BrunoTableCellEditSaveChangeSet | undefined => {
    const rows = new Map<
      string,
      {
        readonly baseRow: object;
        readonly expectedVersion: unknown;
        readonly changes: BrunoTableCellEditSaveCellChange[];
      }
    >();
    for (const { baseRow, before, draft, expectedVersion } of preflight) {
      const cellChange = Object.freeze({
        columnId: draft.columnId,
        field: draft.field,
        before,
        after: draft.mine,
      });
      const existing = rows.get(draft.rowId);
      if (existing === undefined) {
        rows.set(draft.rowId, {
          baseRow,
          expectedVersion,
          changes: [cellChange],
        });
      } else {
        existing.changes.push(cellChange);
      }
    }
    const changeSet = [...rows].map(([rowId, row]) =>
      Object.freeze({
        rowId,
        baseRow: row.baseRow,
        expectedVersion: row.expectedVersion,
        changes: Object.freeze(row.changes) as readonly [
          BrunoTableCellEditSaveCellChange,
          ...BrunoTableCellEditSaveCellChange[],
        ],
      }),
    );
    return changeSet.length === 0
      ? undefined
      : (Object.freeze(changeSet) as BrunoTableCellEditSaveChangeSet);
  };

  private readonly preflightSaveDrafts = (
    drafts: readonly DraftEntry[],
  ): BrunoTableCellEditSavePreflightResult => {
    const entries: SavePreflightEntry[] = [];
    const conflicts = new Map<string, ConflictEvidence>();
    const rows = new Map<
      string,
      Readonly<{ readonly baseRow: object; readonly expectedVersion: unknown }>
    >();
    for (const draft of drafts) {
      let row = rows.get(draft.rowId);
      if (row === undefined) {
        const baseRow = this.getRow(draft.rowId);
        if (typeof baseRow !== "object" || baseRow === null) {
          return Object.freeze({ kind: "rejected" });
        }
        let expectedVersion: unknown;
        try {
          if (this.getRowVersion === undefined) return Object.freeze({ kind: "rejected" });
          expectedVersion = this.getRowVersion(baseRow);
        } catch {
          return Object.freeze({ kind: "rejected" });
        }
        row = Object.freeze({ baseRow, expectedVersion });
        rows.set(draft.rowId, row);
      }
      const column = this.fieldColumnsById.get(draft.columnId);
      if (
        column === undefined ||
        column.field !== draft.field ||
        draft.presentationColumn !== undefined
      ) {
        return Object.freeze({ kind: "rejected" });
      }
      const source = this.readCanonicalSourceValue(draft.rowId, row.baseRow, column);
      if (source._tag !== "Success") return Object.freeze({ kind: "rejected" });
      const equivalent = safeEquivalentEditValue(column, draft.base, source.value);
      if (equivalent !== true) {
        if (equivalent === false) {
          conflicts.set(
            cellKey(draft.rowId, draft.columnId),
            Object.freeze({
              server: source.value,
              serverVersion: row.expectedVersion,
              column,
            }),
          );
        } else return Object.freeze({ kind: "rejected" });
        continue;
      }
      entries.push(
        Object.freeze({
          draft,
          baseRow: row.baseRow,
          expectedVersion: row.expectedVersion,
          before: source.value,
        }),
      );
    }
    if (conflicts.size > 0) {
      this.applyPreflightConflicts(conflicts);
      return Object.freeze({ kind: "reconciled" });
    }
    return Object.freeze({ kind: "ready", entries: Object.freeze(entries) });
  };

  private readonly applyPreflightConflicts = (
    conflicts: ReadonlyMap<string, ConflictEvidence>,
  ): void => {
    const drafts = new Map(this.draftStore.get());
    let undoStack = this.undoStack;
    let redoStack = this.redoStack;
    for (const [key, evidence] of conflicts) {
      const draft = setDraftConflictEvidence(drafts.get(key), evidence);
      if (draft !== undefined) drafts.set(key, draft);
      const history = this.transformIndexedDraftHistoryCell(undoStack, redoStack, key, (entry) =>
        setDraftConflictEvidence(entry, evidence),
      );
      undoStack = history.undoStack;
      redoStack = history.redoStack;
    }
    batch(() => {
      this.setDraftMemory(drafts, undoStack, redoStack, conflicts.keys(), true);
      for (const key of conflicts.keys()) this.syncBlockedDraftKey(key, drafts.get(key));
      this.publishDraftReview(drafts, new Set(conflicts.keys()));
      this.publishActivitySnapshot();
      for (const key of conflicts.keys()) this.publishCell(key, drafts);
    });
    this.publishTraversalInvalidation();
  };

  public readonly getAcceptedOverlayCountSnapshot = (): number => this.acceptedOverlays.size;

  public readonly getAcceptedOverlayCountForOperation = (operationId: string): number => {
    return this.acceptedOverlayCountsByOperation.get(operationId) ?? 0;
  };

  public readonly getAcceptedOverlayRowCountForOperation = (operationId: string): number =>
    this.acceptedOverlayCountsByOperationRow.get(operationId)?.size ?? 0;

  public readonly subscribeAcceptedOverlayCount = (
    operationId: string,
    listener: Listener,
  ): (() => void) => {
    const store =
      this.acceptedOverlayCountStoresByOperation.get(operationId) ??
      new Store(this.getAcceptedOverlayCountForOperation(operationId));
    this.acceptedOverlayCountStoresByOperation.set(operationId, store);
    const subscription = store.subscribe(listener);
    return () => subscription.unsubscribe();
  };

  public readonly hasRejectedOperation = (operationId: string): boolean =>
    this.rejectedOperations.has(operationId);

  public readonly subscribeRejectedOperation = (
    operationId: string,
    listener: Listener,
  ): (() => void) => {
    const store =
      this.rejectedOperationStores.get(operationId) ??
      new Store(
        Object.freeze({
          remainingCount: this.countRejectedOperationCells(operationId),
          removedCells: Object.freeze([]),
        }),
      );
    this.rejectedOperationStores.set(operationId, store);
    const subscription = store.subscribe(listener);
    return () => subscription.unsubscribe();
  };

  public readonly getRejectedOperationUpdateSnapshot = (
    operationId: string,
  ): BrunoTableCellEditRejectedOperationUpdate =>
    this.rejectedOperationStores.get(operationId)?.get() ??
    Object.freeze({
      remainingCount: this.countRejectedOperationCells(operationId),
      removedCells: Object.freeze([]),
    });

  public readonly getRejectedOperationCells = (
    operationId: string,
  ): readonly BrunoTableCellEditRejectedOperationCell[] => {
    const evidenceByRow = this.rejectedOperations.get(operationId);
    if (evidenceByRow === undefined) return Object.freeze([]);
    return Object.freeze(
      [...flattenRejectedEvidence(evidenceByRow)].map((entry) =>
        Object.freeze({ rowId: entry.rowId, columnId: entry.columnId }),
      ),
    );
  };

  private readonly publishRejectedOperation = (
    operationId: string,
    removedEvidence: Iterable<AcceptedOverlayEntry> = [],
  ): void => {
    const store = this.rejectedOperationStores.get(operationId);
    if (store === undefined) return;
    store.setState(() =>
      Object.freeze({
        remainingCount: this.countRejectedOperationCells(operationId),
        removedCells: Object.freeze(
          [...removedEvidence].map((entry) =>
            Object.freeze({ rowId: entry.rowId, columnId: entry.columnId }),
          ),
        ),
      }),
    );
  };

  private readonly countRejectedOperationCells = (operationId: string): number => {
    return this.rejectedOperationCellCounts.get(operationId) ?? 0;
  };

  private readonly removeRejectedOperationCellCount = (
    operationId: string,
    removedCount: number,
  ): void => {
    const remaining = Math.max(
      0,
      (this.rejectedOperationCellCounts.get(operationId) ?? 0) - removedCount,
    );
    if (remaining === 0) this.rejectedOperationCellCounts.delete(operationId);
    else this.rejectedOperationCellCounts.set(operationId, remaining);
  };

  public readonly beginSaveOperation = (
    operationId: string,
    changeSet: BrunoTableCellEditSaveChangeSet,
    batchOperation: boolean,
  ): boolean => {
    const keys = changeSet.flatMap((row) =>
      row.changes.map((change) => cellKey(row.rowId, change.columnId)),
    );
    if (
      this.batchSaveLockOperationId !== undefined ||
      keys.some((key) => this.saveLockedCellKeys.has(key))
    ) {
      return false;
    }
    const valueAuthorities = new Map<string, SubmittedValueAuthority>();
    const submittedValues = new Map<string, unknown>();
    for (const row of changeSet) {
      for (const change of row.changes) {
        const column = this.fieldColumnsById.get(change.columnId);
        if (column === undefined || column.field !== change.field) return false;
        valueAuthorities.set(change.columnId, this.createSubmittedValueAuthority(column));
        submittedValues.set(cellKey(row.rowId, change.columnId), change.after);
      }
    }
    if (batchOperation) {
      this.batchSaveLockOperationId = operationId;
      this.batchSaveOperationIds.add(operationId);
    }
    this.rowVersionExtractorsByOperation.set(operationId, this.getRowVersion);
    this.valueAuthoritiesByOperation.set(operationId, valueAuthorities);
    this.submittedValuesByOperation.set(operationId, submittedValues);
    this.clearSupersededRejectedOperations(keys);
    this.clearSupersededImmediateRejectedCellPresentation(keys);
    const locksByRow = new Map<string, Set<string>>();
    for (const row of changeSet) {
      const rowKeys = new Set<string>();
      for (const change of row.changes) {
        const key = cellKey(row.rowId, change.columnId);
        this.successFlashOperationByKey.delete(key);
        this.successFlashDeadlinesByKey.delete(key);
        this.saveLockedCellKeys.set(key, operationId);
        rowKeys.add(key);
      }
      locksByRow.set(row.rowId, rowKeys);
    }
    this.saveLockedCellKeysByOperationRow.set(operationId, locksByRow);
    for (const rowId of locksByRow.keys()) {
      const operationIds = this.pendingOperationIdsByRowId.get(rowId) ?? new Set<string>();
      operationIds.add(operationId);
      this.pendingOperationIdsByRowId.set(rowId, operationIds);
    }
    this.scheduleCellPresentationDeadline();
    this.publishDraftReview(this.draftStore.get(), new Set(keys), undefined, undefined, true);
    for (const key of keys) this.publishCell(key, this.draftStore.get());
    this.traversalIndex.reconcileRows(
      batchOperation ? undefined : new Set(changeSet.map((row) => row.rowId)),
    );
    this.publishTraversalInvalidation();
    return true;
  };

  public readonly completeSaveOperation = (operationId: string): void => {
    let changed = false;
    const changedKeys = new Set<string>();
    const locksByRow = this.saveLockedCellKeysByOperationRow.get(operationId);
    const batchOperation = this.batchSaveOperationIds.has(operationId);
    const rejectedEvidence = this.rejectedOperations.get(operationId);
    for (const rowKeys of locksByRow?.values() ?? []) {
      for (const key of rowKeys) {
        this.saveLockedCellKeys.delete(key);
        changedKeys.add(key);
        changed = true;
      }
    }
    if (this.batchSaveLockOperationId === operationId) {
      this.batchSaveLockOperationId = undefined;
      changed = true;
    }
    this.batchSaveOperationIds.delete(operationId);
    this.pendingConvergedCellKeysByOperation.delete(operationId);
    this.submittedValuesByOperation.delete(operationId);
    this.rowVersionExtractorsByOperation.delete(operationId);
    this.valueAuthoritiesByOperation.delete(operationId);
    this.saveLockedCellKeysByOperationRow.delete(operationId);
    this.removePendingOperationRows(operationId, locksByRow?.keys() ?? []);
    this.acceptedOverlayCountsByOperation.delete(operationId);
    this.acceptedOverlayCountsByOperationRow.delete(operationId);
    this.acceptedOverlayCountStoresByOperation.delete(operationId);
    if (!this.rejectedOperations.has(operationId)) {
      this.rejectedOperationStores.delete(operationId);
    }
    if (!changed) return;
    if (rejectedEvidence !== undefined) {
      const rejectedKeysWithStableSemantics = new Set<string>();
      for (const evidence of rejectedEvidence.values()) {
        for (const entry of evidence) {
          if (
            entry.valueAuthority.presentationColumn !== undefined &&
            hasStableDraftReconciliationSemantics(
              entry.valueAuthority.presentationColumn,
              this.fieldColumnsById.get(entry.columnId),
            )
          ) {
            rejectedKeysWithStableSemantics.add(cellKey(entry.rowId, entry.columnId));
          }
        }
      }
      if (rejectedKeysWithStableSemantics.size > 0) {
        this.reconcileDraftRows(
          undefined,
          false,
          new Set(),
          undefined,
          rejectedKeysWithStableSemantics,
        );
      }
    }
    this.publishDraftReview(this.draftStore.get(), changedKeys, undefined, undefined, true);
    for (const key of changedKeys) this.publishCell(key, this.draftStore.get());
    this.traversalIndex.reconcileRows(
      batchOperation ? undefined : new Set(locksByRow?.keys() ?? []),
    );
    this.publishTraversalInvalidation();
  };

  public readonly acceptSave = (
    operationId: string,
    changeSet: BrunoTableCellEditSaveChangeSet,
    clearBatch: boolean,
  ): void => {
    const overlays = new Map(this.acceptedOverlays);
    const submittedKeys = new Set<string>();
    let operationOverlayCount = 0;
    const operationRowCounts = new Map<string, number>();
    for (const row of changeSet) {
      operationRowCounts.set(row.rowId, row.changes.length);
      for (const change of row.changes) {
        const key = cellKey(row.rowId, change.columnId);
        submittedKeys.add(key);
        operationOverlayCount += 1;
        const rowKeys = this.acceptedOverlayKeysByRowId.get(row.rowId) ?? new Set<string>();
        rowKeys.add(key);
        this.acceptedOverlayKeysByRowId.set(row.rowId, rowKeys);
        overlays.set(
          key,
          Object.freeze({
            operationId,
            rowId: row.rowId,
            columnId: change.columnId,
            expectedVersion: row.expectedVersion,
            valueAuthority: this.getSubmittedValueAuthority(operationId, change),
            before: change.before,
            after: change.after,
          }),
        );
      }
    }
    const affectedKeys = clearBatch
      ? new Set([...this.draftEvidenceKeys, ...submittedKeys])
      : submittedKeys;
    this.acceptedOverlays = overlays;
    this.acceptedOverlayCountsByOperation.set(operationId, operationOverlayCount);
    this.acceptedOverlayCountsByOperationRow.set(operationId, operationRowCounts);
    this.startSuccessFlash(operationId, submittedKeys);
    const drafts = new Map(this.draftStore.get());
    for (const key of submittedKeys) {
      drafts.delete(key);
      this.syncBlockedDraftKey(key, undefined);
    }
    const completedKeys = new Set(submittedKeys);
    if (clearBatch) {
      for (const key of affectedKeys) {
        if (!drafts.has(key)) completedKeys.add(key);
      }
      for (const id of this.resolvedDraftReviewIds) {
        if (drafts.has(id)) continue;
        completedKeys.add(id);
        this.clearResolvedDraftReviewEvidence(id);
        this.pendingReleasedResolutionIds.add(id);
      }
    }
    const undoStack = clearBatch
      ? pruneDraftHistoryAdaptive(this.undoStack, completedKeys)
      : this.undoStack;
    const redoStack = clearBatch
      ? pruneDraftHistoryAdaptive(this.redoStack, completedKeys)
      : this.redoStack;
    batch(() => {
      this.setDraftMemory(drafts, undoStack, redoStack, affectedKeys);
      this.publishDraftReview(drafts, affectedKeys);
      this.publishActivitySnapshot();
      this.acceptedOverlayCountStoresByOperation
        .get(operationId)
        ?.setState(() => operationOverlayCount);
      for (const key of affectedKeys) this.publishCell(key, drafts);
    });
    if (affectedKeys.size > 0) this.publishTraversalInvalidation();
    this.reconcileAcceptedOverlays(new Set(changeSet.map((row) => row.rowId)));
  };

  public readonly rejectSave = (
    operationId: string,
    changeSet: BrunoTableCellEditSaveChangeSet,
    immediateOperation: boolean,
  ): void => {
    const evidenceByRow = new Map<string, readonly AcceptedOverlayEntry[]>();
    const pendingConvergedKeys = this.pendingConvergedCellKeysByOperation.get(operationId);
    for (const row of changeSet) {
      const evidence = row.changes.flatMap((change) =>
        pendingConvergedKeys?.has(cellKey(row.rowId, change.columnId)) === true
          ? []
          : [
              Object.freeze({
                operationId,
                rowId: row.rowId,
                columnId: change.columnId,
                expectedVersion: row.expectedVersion,
                valueAuthority: this.getSubmittedValueAuthority(operationId, change),
                before: change.before,
                after: change.after,
              }),
            ],
      );
      if (evidence.length > 0) evidenceByRow.set(row.rowId, Object.freeze(evidence));
    }
    const rejectedOperations = new Map(this.rejectedOperations);
    if (evidenceByRow.size > 0) {
      rejectedOperations.set(operationId, evidenceByRow);
      this.rejectedOperationCellCounts.set(
        operationId,
        [...evidenceByRow.values()].reduce((count, evidence) => count + evidence.length, 0),
      );
    }
    if (!immediateOperation && evidenceByRow.size > 0) {
      this.rejectedBatchOperationIds.add(operationId);
    }
    if (pendingConvergedKeys !== undefined) {
      this.startSuccessFlash(operationId, pendingConvergedKeys);
    }
    const affectedKeys = new Set<string>();
    const evicted = new Map<string, RejectedOperationEvidence>();
    while (rejectedOperations.size > 128) {
      const oldest = rejectedOperations.keys().next().value;
      if (oldest === undefined) break;
      const oldestEvidence = rejectedOperations.get(oldest) ?? new Map();
      this.removeRejectedOperationCellKeys(
        oldest,
        flattenRejectedEvidence(oldestEvidence),
        affectedKeys,
      );
      rejectedOperations.delete(oldest);
      this.rejectedOperationCellCounts.delete(oldest);
      evicted.set(oldest, oldestEvidence);
    }
    for (const [rowId, evidence] of evidenceByRow) {
      const rowOperations = this.rejectedOperationIdsByRowId.get(rowId) ?? new Set<string>();
      rowOperations.add(operationId);
      this.rejectedOperationIdsByRowId.set(rowId, rowOperations);
      for (const entry of evidence) {
        const key = cellKey(entry.rowId, entry.columnId);
        affectedKeys.add(key);
        const owners = this.rejectedCellKeys.get(key) ?? new Set<string>();
        owners.add(operationId);
        this.rejectedCellKeys.set(key, owners);
      }
    }
    this.rejectedOperations = rejectedOperations;
    batch(() => {
      for (const [evictedOperationId, evictedEvidence] of evicted) {
        this.removeRejectedOperationRows(evictedOperationId, evictedEvidence.keys());
        this.rejectedBatchOperationIds.delete(evictedOperationId);
        this.rejectedCellPresentationDeadlinesByOperation.delete(evictedOperationId);
        this.publishRejectedOperation(evictedOperationId, flattenRejectedEvidence(evictedEvidence));
      }
      this.publishRejectedOperation(operationId);
    });
    for (const evictedOperationId of evicted.keys()) {
      this.rejectedOperationStores.delete(evictedOperationId);
    }
    if (immediateOperation && evidenceByRow.size > 0) {
      this.rejectedCellPresentationDeadlinesByOperation.set(operationId, Date.now() + 5_000);
      this.scheduleCellPresentationDeadline();
    }
    if (!immediateOperation) {
      for (const key of affectedKeys) this.publishCell(key, this.draftStore.get());
      this.reconcileRejectedOperations(new Set(changeSet.map((row) => row.rowId)));
      for (const key of affectedKeys) this.releaseUnusedCellStore(key);
      return;
    }
    const drafts = new Map(this.draftStore.get());
    for (const row of changeSet) {
      for (const change of row.changes) {
        const key = cellKey(row.rowId, change.columnId);
        affectedKeys.add(key);
        drafts.delete(key);
        this.syncBlockedDraftKey(key, undefined);
      }
    }
    batch(() => {
      this.setDraftMemory(drafts, this.undoStack, this.redoStack, affectedKeys);
      this.publishDraftReview(drafts, affectedKeys);
      this.publishActivitySnapshot();
      for (const key of affectedKeys) this.publishCell(key, drafts);
    });
    if (affectedKeys.size > 0) this.publishTraversalInvalidation();
    this.reconcileRejectedOperations(new Set(changeSet.map((row) => row.rowId)));
    for (const key of affectedKeys) this.releaseUnusedCellStore(key);
  };

  public readonly getDraftReviewSnapshot = (): readonly BrunoTableCellEditDraftReviewRow[] =>
    this.draftReviewSubscriberCount === 0
      ? (() => {
          const drafts = this.draftStore.get();
          const projectedRowsPlan = this.createDraftReviewProjectedRows(
            drafts,
            new Set(drafts.keys()),
          );
          const rows = Object.freeze(
            [...drafts].flatMap(([id, draft]) => {
              const row = this.createDraftReviewRow(
                id,
                draft,
                projectedRowsPlan.rows.get(draft.rowId)?.serverCandidate,
                undefined,
                projectedRowsPlan.rows.get(draft.rowId),
              );
              return row === undefined ? [] : [row];
            }),
          );
          projectedRowsPlan.commit();
          return rows;
        })()
      : Object.freeze(this.draftReviewStore.get().map((row) => row.getSnapshot()));

  public readonly getDraftReviewSourceSnapshot =
    (): readonly BrunoTableCellEditDraftReviewSourceRow[] => this.draftReviewStore.get();

  public readonly getResetDraftReviewSourceSnapshot =
    (): readonly BrunoTableCellEditDraftReviewSourceRow[] => {
      const drafts = this.draftStore.get();
      const activeKey = this.hasActiveCandidateWork() ? this.activeCellKey : undefined;
      return Object.freeze(
        this.draftReviewStore.get().filter((row) => drafts.has(row.id) || row.id === activeKey),
      );
    };

  public readonly isDraftConflictEvidenceCurrent = (
    id: string,
    resolution: "mine" | "server",
    reviewedServer: unknown,
    reviewedServerVersion: unknown,
  ): boolean => {
    const activeDraft = this.draftStore.get().get(id);
    const entry =
      resolution === "mine"
        ? activeDraft?.conflict === undefined
          ? activeDraft
          : undefined
        : activeDraft === undefined
          ? this.resolvedDraftReviewEntriesById.get(id)
          : undefined;
    if (entry === undefined) return false;
    const column = entry.presentationColumn ?? this.fieldColumnsById.get(entry.columnId);
    const serverRow = this.getRow(entry.rowId);
    if (column === undefined || typeof serverRow !== "object" || serverRow === null) return false;
    const currentServer = this.readCanonicalSourceValue(entry.rowId, serverRow, column);
    if (currentServer._tag !== "Success") return false;
    let currentServerVersion: unknown;
    try {
      currentServerVersion = this.getRowVersion?.(serverRow);
    } catch {
      return false;
    }
    return (
      (this.getRowVersion === undefined ||
        Object.is(currentServerVersion, reviewedServerVersion)) &&
      safeEquivalentEditValue(column, currentServer.value, reviewedServer) === true
    );
  };

  public readonly isConflictResolutionLocallyUndone = (
    id: string,
    reviewedServer: unknown,
    reviewedServerVersion: unknown,
  ): boolean => {
    const lineage = this.resolvedDraftReviewLineagesById.get(id);
    const location = lineage === undefined ? undefined : this.draftHistoryLocations.get(lineage);
    if (
      lineage === undefined ||
      location?.stack !== "redo" ||
      this.redoStack[location.index]?.lineage !== lineage
    ) {
      return false;
    }
    const draft = this.draftStore.get().get(id);
    const column =
      draft?.presentationColumn ??
      (draft === undefined ? undefined : this.fieldColumnsById.get(draft.columnId));
    return (
      draft?.conflict !== undefined &&
      column !== undefined &&
      Object.is(draft.conflict.serverVersion, reviewedServerVersion) &&
      safeEquivalentEditValue(column, draft.conflict.server, reviewedServer) === true
    );
  };

  public readonly isConflictResolutionTemporarilyDiscarded = (id: string): boolean => {
    const lineage = this.resolvedDraftReviewLineagesById.get(id);
    const resolutionLocation =
      lineage === undefined ? undefined : this.draftHistoryLocations.get(lineage);
    if (
      lineage === undefined ||
      resolutionLocation?.stack !== "undo" ||
      this.draftStore.get().has(id)
    ) {
      return false;
    }
    for (let index = resolutionLocation.index + 1; index < this.undoStack.length; index += 1) {
      const laterPatch = this.undoStack[index]?.patches.get(id);
      if (laterPatch?.before !== undefined && laterPatch.after === undefined) return true;
    }
    return false;
  };

  public readonly reopenResolvedConflicts = (ids: readonly string[]): boolean =>
    this.reconcileResolvedConflictIds(ids).size > 0;

  public readonly hasRetainedConflictResolution = (id: string): boolean =>
    this.resolvedDraftReviewIds.has(id) &&
    (this.draftStore.get().has(id) || this.resolvedDraftReviewEntriesById.has(id));

  public readonly reconcileResolvedConflictIds = (ids: readonly string[]): ReadonlySet<string> => {
    const previousDrafts = this.draftStore.get();
    const nextDrafts = new Map(previousDrafts);
    const reopenedKeys = new Set<string>();
    const convergedKeys = new Set<string>();
    const supersededKeys = new Set<string>();
    const affectedEntries = new Map<string, DraftEntry>();
    const serverRows = new Map<string, unknown>();
    const evidenceByKey = new Map<string, ConflictEvidence>();
    const resolutionLineageByKey = new Map<string, object>();
    for (const id of ids) {
      if (!this.resolvedDraftReviewIds.has(id)) continue;
      const activeDraft = previousDrafts.get(id);
      const retainedResolved = this.resolvedDraftReviewEntriesById.get(id);
      const resolutionLineage = this.resolvedDraftReviewLineagesById.get(id);
      const resolutionLocation =
        resolutionLineage === undefined
          ? undefined
          : this.draftHistoryLocations.get(resolutionLineage);
      if (
        activeDraft !== undefined &&
        activeDraft.conflict === undefined &&
        resolutionLineage !== undefined &&
        resolutionLocation?.stack === "redo"
      ) {
        supersededKeys.add(id);
        affectedEntries.set(id, retainedResolved ?? activeDraft);
        resolutionLineageByKey.set(id, resolutionLineage);
        continue;
      }
      if (
        activeDraft !== undefined &&
        retainedResolved !== undefined &&
        resolutionLocation?.stack !== "redo"
      ) {
        supersededKeys.add(id);
        affectedEntries.set(id, retainedResolved);
        if (resolutionLineage !== undefined) resolutionLineageByKey.set(id, resolutionLineage);
        continue;
      }
      const resolved = activeDraft ?? retainedResolved;
      if (resolved === undefined) continue;
      const column = resolved.presentationColumn ?? this.fieldColumnsById.get(resolved.columnId);
      const serverRow = this.getRow(resolved.rowId);
      if (column === undefined || typeof serverRow !== "object" || serverRow === null) continue;
      const currentServer = this.readCanonicalSourceValue(resolved.rowId, serverRow, column);
      if (currentServer._tag !== "Success") continue;
      let currentServerVersion: unknown;
      try {
        currentServerVersion = this.getRowVersion?.(serverRow);
      } catch {
        continue;
      }
      affectedEntries.set(id, resolved);
      if (
        (resolutionLocation?.stack === "redo" || activeDraft?.conflict !== undefined) &&
        safeEquivalentEditValue(column, resolved.base, currentServer.value) === true
      ) {
        const cleared = clearDraftConflictEvidence(resolved) ?? resolved;
        nextDrafts.set(id, cleared);
        supersededKeys.add(id);
        serverRows.set(id, serverRow);
        if (resolutionLineage !== undefined) resolutionLineageByKey.set(id, resolutionLineage);
        continue;
      }
      if (safeEquivalentEditValue(column, resolved.mine, currentServer.value) === true) {
        nextDrafts.delete(id);
        convergedKeys.add(id);
        continue;
      }
      const evidence = Object.freeze({
        server: currentServer.value,
        serverVersion: currentServerVersion,
        column,
      });
      const reopened = setDraftConflictEvidence(resolved, evidence);
      if (reopened === undefined) continue;
      nextDrafts.set(id, reopened);
      reopenedKeys.add(id);
      serverRows.set(id, serverRow);
      evidenceByKey.set(id, evidence);
      if (resolutionLineage !== undefined) resolutionLineageByKey.set(id, resolutionLineage);
    }
    const affectedKeys = new Set([...reopenedKeys, ...convergedKeys, ...supersededKeys]);
    if (affectedKeys.size === 0) return affectedKeys;
    for (const id of affectedKeys) {
      this.clearResolvedDraftReviewEvidence(id);
      this.syncBlockedDraftKey(id, nextDrafts.get(id));
    }
    const nextUndoStack = reconcileInvalidatedResolutionHistory(
      this.undoStack,
      evidenceByKey,
      resolutionLineageByKey,
    );
    const nextRedoStack = reconcileInvalidatedResolutionHistory(
      this.redoStack,
      evidenceByKey,
      resolutionLineageByKey,
    );
    const finalUndoStack = pruneDraftHistoryAdaptive(nextUndoStack, convergedKeys);
    const finalRedoStack = pruneDraftHistoryAdaptive(nextRedoStack, convergedKeys);
    batch(() => {
      this.setDraftMemory(nextDrafts, finalUndoStack, finalRedoStack, affectedKeys);
      this.publishDraftReview(nextDrafts, affectedKeys, serverRows);
      this.publishActivitySnapshot();
      if (this.cellStores.size > 0) {
        for (const id of affectedKeys) this.publishCell(id, nextDrafts);
      }
    });
    for (const entry of affectedEntries.values()) {
      this.traversalIndex.invalidateCell(entry.rowId, entry.columnId);
    }
    this.publishTraversalInvalidation();
    return affectedKeys;
  };

  public readonly subscribeDraftReview = (listener: Listener): (() => void) => {
    this.draftReviewSubscriberCount += 1;
    if (this.draftReviewSubscriberCount === 1) {
      const previousProjectionHistory = new Map(this.draftReviewProjectionHistoryByRowId);
      try {
        this.publishDraftReview(this.draftStore.get());
      } catch (error) {
        this.draftReviewSubscriberCount = 0;
        this.draftReviewRowsById.clear();
        this.draftReviewRowStoresById.clear();
        this.draftReviewEntriesById.clear();
        this.draftReviewProjectedRowsByRowId.clear();
        this.draftReviewProjectionHistoryByRowId = previousProjectionHistory;
        this.clearDraftReviewClassification();
        throw error;
      }
    }
    const subscription = this.draftReviewStore.subscribe(listener);
    return () => {
      subscription.unsubscribe();
      this.draftReviewSubscriberCount -= 1;
      if (this.draftReviewSubscriberCount === 0) {
        this.draftReviewStore.setState(() => Object.freeze([]));
        this.draftReviewRowsById.clear();
        this.draftReviewRowStoresById.clear();
        this.draftReviewEntriesById.clear();
        this.draftReviewProjectedRowsByRowId.clear();
        this.clearDraftReviewClassification();
      }
    };
  };

  public readonly getDraftReviewClassificationSnapshot =
    (): BrunoTableCellEditDraftReviewClassificationSnapshot =>
      this.draftReviewClassificationStore.get();

  public readonly subscribeDraftReviewClassification = (listener: Listener): (() => void) => {
    const subscription = this.draftReviewClassificationStore.subscribe(listener);
    return () => subscription.unsubscribe();
  };

  public readonly subscribeRetainedResolutionPublication = (listener: Listener): (() => void) => {
    const subscription = this.retainedResolutionPublicationStore.subscribe(listener);
    return () => subscription.unsubscribe();
  };

  public readonly getRetainedResolutionPublicationSnapshot = (): ReadonlySet<string> =>
    this.retainedResolutionPublicationStore.get();

  public readonly finalizeRetainedConflictResolutions = (ids: readonly string[]): boolean => {
    if (ids.length === 0) return false;
    const memory = this.draftMemoryStore.get();
    const uniqueIds = new Set(ids);
    if (uniqueIds.size !== ids.length) return false;
    for (const id of uniqueIds) {
      if (
        memory.drafts.has(id) ||
        !this.resolvedDraftReviewIds.has(id) ||
        !this.resolvedDraftReviewEntriesById.has(id)
      ) {
        return false;
      }
    }
    batch(() => {
      for (const id of uniqueIds) {
        this.clearResolvedDraftReviewEvidence(id);
        this.pendingReleasedResolutionIds.add(id);
        this.syncDraftEvidenceKey(id, memory);
      }
      this.flushReleasedResolutionPublications();
    });
    return true;
  };

  public readonly captureDraftCommandReader = (): ((
    rowId: string,
    columnId: string,
  ) => Readonly<{ readonly hasDraft: boolean; readonly value?: unknown }>) => {
    const drafts = this.draftStore.get();
    return (rowId, columnId) => {
      const draft = drafts.get(cellKey(rowId, columnId));
      return draft === undefined
        ? Object.freeze({ hasDraft: false })
        : Object.freeze({ hasDraft: true, value: draft.mine });
    };
  };

  public readonly captureEditValueCommandReader = (): ((
    rowId: string,
    columnId: string,
  ) =>
    | Readonly<{
        readonly hasEditValue: false;
      }>
    | Readonly<{
        readonly hasEditValue: true;
        readonly value: unknown;
        readonly presentationColumn?: CompiledFieldColumn;
      }>) => {
    const drafts = this.draftStore.get();
    const acceptedOverlays = this.acceptedOverlays;
    return (rowId, columnId) => {
      const key = cellKey(rowId, columnId);
      const acceptedOverlay = acceptedOverlays.get(key);
      if (acceptedOverlay !== undefined) {
        return Object.freeze({
          hasEditValue: true,
          value: acceptedOverlay.after,
          ...(acceptedOverlay.valueAuthority.presentationColumn === undefined
            ? {}
            : { presentationColumn: acceptedOverlay.valueAuthority.presentationColumn }),
        });
      }
      const draft = drafts.get(key);
      return draft === undefined
        ? Object.freeze({ hasEditValue: false })
        : Object.freeze({
            hasEditValue: true,
            value: draft.mine,
            ...(draft.presentationColumn === undefined
              ? {}
              : { presentationColumn: draft.presentationColumn }),
          });
    };
  };

  public readonly getActiveCandidateSnapshot = (): ActiveCandidateSnapshot =>
    this.candidateStore.get();

  private readonly hasActiveCandidateWork = (session = this.sessionStore.get()): boolean => {
    if (session.kind !== "editing") return false;
    const candidate = this.candidateStore.get();
    const retainedValidationMessage = this.actor.getSnapshot().context.session?.invalidMessage;
    return (
      retainedValidationMessage !== undefined ||
      candidate.nativeInvalid ||
      candidate.rawText !== session.initialText ||
      (candidate.kind === "blank" && session.initialText !== "")
    );
  };

  private readonly hasInvalidActiveCandidate = (): boolean => {
    const session = this.actor.getSnapshot().context.session;
    if (session === undefined || !this.hasActiveCandidateWork()) return false;
    return session.invalidMessage !== undefined || this.candidateStore.get().nativeInvalid;
  };

  public readonly updateActiveCandidate = (
    rawText: string,
    nativeInvalid: boolean,
    intent: "scalar" | "blank" = "scalar",
  ): void => {
    const boundedRawText = rawText.slice(0, BRUNO_TABLE_CELL_EDIT_MAX_CANDIDATE_LENGTH + 1);
    const next: ActiveCandidateSnapshot =
      intent === "blank"
        ? Object.freeze({ kind: "blank", rawText: "", nativeInvalid: false })
        : Object.freeze({ kind: "scalar", rawText: boundedRawText, nativeInvalid });
    const previous = this.candidateStore.get();
    if (
      previous.kind === next.kind &&
      previous.rawText === next.rawText &&
      previous.nativeInvalid === next.nativeInvalid
    )
      return;
    batch(() => {
      this.candidateStore.setState(() => next);
      this.publishActivitySnapshot();
      if (this.activeCellKey !== undefined) {
        this.publishDraftReview(this.draftStore.get(), new Set([this.activeCellKey]));
      }
    });
  };

  public readonly getRetainedCellStoreCount = (): number => this.cellStores.size;

  public readonly getRetainedDraftDependencyCellCount = (): number => this.draftEvidenceKeys.size;

  public readonly registerEditOwnedControl = (element: Element): (() => void) => {
    this.editOwnedControls.add(element);
    return () => this.editOwnedControls.delete(element);
  };

  public readonly ownsEditOwnedControl = (target: EventTarget | null): boolean => {
    if (!(target instanceof Element)) return false;
    const control = target.closest("[data-bruno-cell-edit-owned-control]");
    return control !== null && this.editOwnedControls.has(control);
  };

  public readonly setBatchHistoryEnabled = (enabled: boolean): void => {
    if (this.batchHistoryEnabled === enabled) return;
    if (!enabled && (this.undoHistoryCount > 0 || this.redoHistoryCount > 0)) return;
    this.batchHistoryEnabled = enabled;
    this.publishActivitySnapshot();
  };

  public readonly setSaveOperationCapacityAvailable = (available: boolean): void => {
    if (this.saveOperationCapacityAvailable === available) return;
    this.saveOperationCapacityAvailable = available;
    this.traversalIndex.reconcileRows(undefined);
    this.publishTraversalInvalidation();
  };

  public readonly applyCanonicalTextGesture = (
    cells: BrunoTableCellEditCanonicalTextGesture,
  ): BrunoTableCellEditCanonicalTextGestureResult => {
    if (this.batchSaveLockOperationId !== undefined) {
      const first = cells[0];
      const additionalInvalidCount = cells.length - 1;
      return Object.freeze({
        kind: "rejected",
        reason: "save-locked",
        rowId: first.rowId,
        columnId: first.columnId,
        ...(additionalInvalidCount === 0 ? {} : { additionalInvalidCount }),
      });
    }
    if (
      !this.saveOperationCapacityAvailable ||
      this.getSessionSnapshot().kind === "editing" ||
      (!this.batchHistoryEnabled && !this.isSourceAuthoritative())
    ) {
      return Object.freeze({ kind: "rejected", reason: "temporarily-unavailable" });
    }
    const drafts = this.draftStore.get();
    const prepared: BrunoTableCellEditDraftSnapshot[] = [];
    const available: Array<
      Readonly<{
        readonly cell: BrunoTableCellEditCanonicalTextGesture[number];
        readonly column: CompiledFieldColumn;
        readonly row: object;
        readonly previous: DraftEntry | undefined;
        readonly expectedVersion: unknown;
        readonly sourceValue: Extract<CanonicalSourceValue, { readonly _tag: "Success" }>;
      }>
    > = [];
    let hasMutation = false;
    const seen = new Set<string>();
    const failureState: {
      first:
        | Readonly<{
            readonly reason: BrunoTableCellEditCanonicalTextGestureRejectionReason;
            readonly detail?: string;
            readonly rowId: string;
            readonly columnId: string;
          }>
        | undefined;
      additionalCount: number;
    } = { first: undefined, additionalCount: 0 };
    const recordFailure = (
      cell: (typeof cells)[number],
      reason: BrunoTableCellEditCanonicalTextGestureRejectionReason,
      detail?: string,
    ): void => {
      if (failureState.first === undefined) {
        failureState.first = Object.freeze({
          reason,
          ...(detail === undefined ? {} : { detail }),
          rowId: cell.rowId,
          columnId: cell.columnId,
        });
      } else {
        failureState.additionalCount += 1;
      }
    };
    const rejectionFromFailures = (): BrunoTableCellEditCanonicalTextGestureResult | undefined => {
      const first = failureState.first;
      if (first === undefined) return undefined;
      return Object.freeze({
        kind: "rejected",
        reason: first.reason,
        ...(first.detail === undefined ? {} : { detail: first.detail }),
        rowId: first.rowId,
        columnId: first.columnId,
        ...(failureState.additionalCount === 0
          ? {}
          : { additionalInvalidCount: failureState.additionalCount }),
      });
    };
    for (const cell of cells) {
      const key = cellKey(cell.rowId, cell.columnId);
      if (seen.has(key)) {
        return Object.freeze({ kind: "rejected", reason: "invalid-target" });
      }
      seen.add(key);
      if (this.saveLockedCellKeys.has(key)) {
        recordFailure(cell, "save-locked");
        continue;
      }
      const column = this.fieldColumnsById.get(cell.columnId);
      const row = this.getRow(cell.rowId);
      if (column === undefined || typeof row !== "object" || row === null) {
        recordFailure(cell, "unavailable");
        continue;
      }
      const previous = drafts.get(key);
      if (
        previous?.conflict !== undefined ||
        this.conflictDraftKeys.has(key) ||
        this.rowVersionBlockedRowIds.has(cell.rowId)
      ) {
        recordFailure(cell, "stale");
        continue;
      }
      if (
        previous?.blockedReason !== undefined ||
        previous?.validationMessage !== undefined ||
        this.blockedDraftKeys.has(key) ||
        this.validationDraftKeys.has(key)
      ) {
        recordFailure(cell, "blocked");
        continue;
      }
      let expectedVersion: unknown;
      try {
        expectedVersion = this.getRowVersion?.(row);
      } catch {
        recordFailure(cell, "row-version");
        continue;
      }
      const sourceValue = this.readCanonicalSourceValue(cell.rowId, row, column);
      if (sourceValue._tag !== "Success") {
        recordFailure(cell, "invalid-source");
        continue;
      }
      if (
        !isDraftEditable(column, row, previous === undefined ? sourceValue.value : previous.mine)
      ) {
        recordFailure(cell, "read-only");
        continue;
      }
      available.push(Object.freeze({ cell, column, row, previous, expectedVersion, sourceValue }));
    }
    const availabilityRejection = rejectionFromFailures();
    if (availabilityRejection !== undefined) return availabilityRejection;
    for (const { cell, column, row, previous, expectedVersion, sourceValue } of available) {
      const session = prepareSession({
        type: "START",
        rowId: cell.rowId,
        column,
        row,
        sourceValue,
        expectedVersion,
        hasDraft: previous !== undefined,
        draftValue: previous?.mine,
        mode: "replace",
        producedText: cell.canonicalText,
      });
      const evaluation = evaluateCandidate(
        session,
        cell.canonicalText,
        false,
        cell.canonicalText.length === 0 && column.blankValue !== undefined ? "blank" : "scalar",
      );
      if (evaluation.kind === "invalid") {
        recordFailure(cell, "invalid-value", evaluation.message);
        continue;
      }
      hasMutation ||=
        evaluation.change !== undefined || (previous !== undefined && evaluation.removeDraft);
      prepared.push(
        Object.freeze({
          rowId: cell.rowId,
          columnId: cell.columnId,
          field: column.field,
          baseRow: previous === undefined ? row : previous.baseRow,
          expectedVersion: previous === undefined ? expectedVersion : previous.expectedVersion,
          base: previous === undefined ? sourceValue.value : previous.base,
          mine: evaluation.value,
          ...(previous?.conflict === undefined ? {} : { conflict: previous.conflict }),
        }),
      );
    }
    const evaluationRejection = rejectionFromFailures();
    if (evaluationRejection !== undefined) return evaluationRejection;
    if (!hasMutation) {
      const firstTarget = cells[0];
      return Object.freeze({
        kind: "rejected",
        reason: "unchanged",
        ...(firstTarget === undefined
          ? {}
          : { rowId: firstTarget.rowId, columnId: firstTarget.columnId }),
      });
    }
    const [first, ...rest] = prepared;
    if (first === undefined) {
      return Object.freeze({ kind: "rejected", reason: "empty" });
    }
    return this.applyAcceptedDraftGesture(Object.freeze([first, ...rest]))
      ? Object.freeze({ kind: "accepted" })
      : Object.freeze({ kind: "rejected", reason: "temporarily-unavailable" });
  };

  public readonly applyAcceptedDraftGesture = (
    drafts: readonly [BrunoTableCellEditDraftSnapshot, ...BrunoTableCellEditDraftSnapshot[]],
  ): boolean => {
    if (
      !this.saveOperationCapacityAvailable ||
      this.getSessionSnapshot().kind === "editing" ||
      (!this.batchHistoryEnabled && !this.isSourceAuthoritative())
    ) {
      return false;
    }
    if (
      this.batchSaveLockOperationId !== undefined ||
      (this.saveLockedCellKeys.size > 0 &&
        drafts.some((draft) => this.saveLockedCellKeys.has(cellKey(draft.rowId, draft.columnId))))
    ) {
      return false;
    }
    if (this.batchHistoryEnabled) this.compactDraftHistoryForInteraction();
    const previousDrafts = this.draftStore.get();
    const previousDraftsEmpty = previousDrafts.size === 0;
    const nextDrafts = new Map(previousDrafts);
    const historyPatchBuilder = new DraftHistoryPatchMapBuilder();
    let unchangedGestureKeys: Set<string> | undefined;
    let draftStatusEvidenceChanged =
      this.blockedDraftKeys.size > 0 ||
      this.validationDraftKeys.size > 0 ||
      this.conflictDraftKeys.size > 0;
    for (const draft of drafts) {
      const column = this.fieldColumnsById.get(draft.columnId);
      if (column?.field !== draft.field) return false;
      const key = cellKey(draft.rowId, draft.columnId);
      const existing = nextDrafts.get(key);
      const before = previousDraftsEmpty ? undefined : previousDrafts.get(key);
      if (existing !== before || unchangedGestureKeys?.has(key) === true) return false;
      const base = existing === undefined ? draft.base : existing.base;
      const equivalentToBase = safeEquivalentEditValue(column, draft.mine, base);
      if (equivalentToBase === undefined) return false;
      let after = existing;
      if (equivalentToBase) {
        nextDrafts.delete(key);
        after = undefined;
      } else if (
        existing === undefined ||
        safeEquivalentEditValue(column, existing.mine, draft.mine) !== true
      ) {
        const retained = existing ?? draft;
        after =
          existing === undefined
            ? Object.isFrozen(draft)
              ? draft
              : Object.freeze({ ...draft })
            : Object.freeze({
                rowId: retained.rowId,
                columnId: retained.columnId,
                field: retained.field,
                baseRow: retained.baseRow,
                expectedVersion: retained.expectedVersion,
                base: retained.base,
                mine: draft.mine,
                ...(draft.validationMessage === undefined
                  ? {}
                  : { validationMessage: draft.validationMessage }),
                ...(draft.conflict === undefined ? {} : { conflict: draft.conflict }),
              });
        nextDrafts.set(key, after);
      }
      draftStatusEvidenceChanged ||=
        after?.blockedReason !== undefined ||
        after?.validationMessage !== undefined ||
        after?.conflict !== undefined;
      if (before === after) {
        unchangedGestureKeys ??= new Set();
        unchangedGestureKeys.add(key);
      } else {
        historyPatchBuilder.addUnique(
          key,
          Object.freeze({ cellKey: key, before, after, authoredValue: draft.mine }),
        );
      }
    }
    const historyPatches = historyPatchBuilder.build();
    if (historyPatches.size === 0) return false;
    if (draftStatusEvidenceChanged) {
      for (const key of historyPatches.keys()) this.syncBlockedDraftKey(key, nextDrafts.get(key));
    }
    const nextUndoStack = this.batchHistoryEnabled
      ? [...this.undoStack, createDraftHistoryCommandFromPatches(historyPatches)].slice(
          -BRUNO_TABLE_BATCH_HISTORY_LIMIT,
        )
      : this.undoStack;
    const nextRedoStack = this.batchHistoryEnabled ? [] : this.redoStack;
    const historyCommand = this.batchHistoryEnabled ? nextUndoStack.at(-1) : undefined;
    if (historyCommand !== undefined) {
      this.prepareDraftHistoryPush(historyCommand, nextUndoStack);
    }
    const committedChanges = this.batchHistoryEnabled
      ? []
      : [...historyPatches.values()].flatMap((patch) =>
          patch.after === undefined
            ? []
            : [
                Object.freeze({
                  rowId: patch.after.rowId,
                  columnId: patch.after.columnId,
                  field: patch.after.field,
                  before: patch.after.base,
                  after: patch.after.mine,
                }),
              ],
        );
    const [firstCommittedChange, ...remainingCommittedChanges] = committedChanges;
    const admissionResult: {
      value: BrunoTableCellEditImmediateSaveResult | boolean | void;
    } = { value: undefined };
    batch(() => {
      this.setDraftMemory(
        nextDrafts,
        nextUndoStack,
        nextRedoStack,
        historyPatches.keys(),
        historyCommand !== undefined,
        historyCommand === undefined ? undefined : historyPatches,
      );
      if (this.draftReviewSubscriberCount > 0) {
        this.publishDraftReview(nextDrafts, new Set(historyPatches.keys()));
      }
      if (this.cellStores.size > 0) {
        for (const patch of historyPatches.values()) this.publishCell(patch.cellKey, nextDrafts);
      }
      this.publishActivitySnapshot();
      if (firstCommittedChange !== undefined) {
        try {
          admissionResult.value = this.onCommitGesture(
            Object.freeze([firstCommittedChange, ...remainingCommittedChanges]),
          );
        } catch {
          admissionResult.value = "rejected";
        }
        if (admissionResult.value === false || admissionResult.value === "rejected") {
          for (const key of historyPatches.keys()) {
            this.syncBlockedDraftKey(key, previousDrafts.get(key));
          }
          this.setDraftMemory(
            previousDrafts,
            this.undoStack,
            this.redoStack,
            historyPatches.keys(),
          );
          if (this.draftReviewSubscriberCount > 0) {
            this.publishDraftReview(previousDrafts, new Set(historyPatches.keys()));
          }
          if (this.cellStores.size > 0) {
            for (const patch of historyPatches.values())
              this.publishCell(patch.cellKey, previousDrafts);
          }
          this.publishActivitySnapshot();
          return;
        }
      }
      this.clearSupersededRejectedOperations(historyPatches.keys());
    });
    if (admissionResult.value === false || admissionResult.value === "rejected") return false;
    if (admissionResult.value !== "preflight-reconciled") {
      for (const patch of historyPatches.values()) {
        const entry = patch.after ?? patch.before;
        if (entry !== undefined) this.traversalIndex.invalidateCell(entry.rowId, entry.columnId);
      }
      this.publishTraversalInvalidation();
    }
    if (this.cellStores.size > 0) {
      for (const key of historyPatches.keys()) this.releaseUnusedCellStore(key);
    }
    return true;
  };

  public readonly resolveDraftConflicts = (
    resolutions: readonly [
      BrunoTableCellEditConflictResolution,
      ...BrunoTableCellEditConflictResolution[],
    ],
  ): boolean => {
    if (
      this.getSessionSnapshot().kind === "editing" ||
      this.batchSaveLockOperationId !== undefined
    ) {
      return false;
    }
    this.compactDraftHistoryForInteraction();
    const previousDrafts = this.draftStore.get();
    const nextDrafts = new Map(previousDrafts);
    const historyPatchBuilder = new DraftHistoryPatchMapBuilder();
    const resolvedReviewEntries = new Map<string, DraftEntry>();
    const seen = new Set<string>();
    for (const reviewed of resolutions) {
      const { id, resolution } = reviewed;
      if (seen.has(id) || !this.canResolveDraftConflict(id, resolution)) return false;
      seen.add(id);
      const before = previousDrafts.get(id);
      const conflict = before?.conflict;
      if (before === undefined || conflict === undefined) return false;
      const column = this.fieldColumnsById.get(before.columnId);
      if (
        column === undefined ||
        !Object.is(conflict.serverVersion, reviewed.reviewedServerVersion) ||
        safeEquivalentEditValue(column, conflict.server, reviewed.reviewedServer) !== true
      ) {
        return false;
      }
      const serverRow = this.getRow(before.rowId);
      if (typeof serverRow !== "object" || serverRow === null) return false;
      const currentServer = this.readCanonicalSourceValue(before.rowId, serverRow, column);
      let currentServerVersion: unknown;
      try {
        currentServerVersion = this.getRowVersion?.(serverRow);
      } catch {
        return false;
      }
      if (
        currentServer._tag !== "Success" ||
        safeEquivalentEditValue(column, currentServer.value, reviewed.reviewedServer) !== true ||
        (this.getRowVersion !== undefined &&
          !Object.is(currentServerVersion, reviewed.reviewedServerVersion))
      ) {
        return false;
      }
      const after: DraftEntry | undefined =
        resolution === "server"
          ? undefined
          : Object.freeze({
              rowId: before.rowId,
              columnId: before.columnId,
              field: before.field,
              baseRow: serverRow,
              expectedVersion: conflict.serverVersion,
              base: conflict.server,
              mine: before.mine,
              ...(before.validationMessage === undefined
                ? {}
                : { validationMessage: before.validationMessage }),
              ...(before.blockedReason === undefined
                ? {}
                : { blockedReason: before.blockedReason }),
              ...(before.presentationColumn === undefined
                ? {}
                : { presentationColumn: before.presentationColumn }),
            });
      if (resolution === "server") {
        resolvedReviewEntries.set(id, clearDraftConflictEvidence(before) ?? before);
      }
      if (after === undefined) nextDrafts.delete(id);
      else nextDrafts.set(id, after);
      historyPatchBuilder.set(
        id,
        Object.freeze({
          cellKey: id,
          before,
          after,
          authoredValue: before.mine,
        }),
      );
    }
    const historyPatches = historyPatchBuilder.build();
    return this.commitDraftReviewHistoryCommand(
      nextDrafts,
      historyPatches,
      resolvedReviewEntries,
      new Set(historyPatches.keys()),
    );
  };

  public readonly canResolveDraftConflict = (
    id: string,
    resolution: "mine" | "server" = "server",
  ): boolean => {
    if (
      !this.isSourceAuthoritative() ||
      this.getSessionSnapshot().kind === "editing" ||
      this.batchSaveLockOperationId !== undefined ||
      this.saveLockedCellKeys.has(id)
    ) {
      return false;
    }
    const draft = this.draftStore.get().get(id);
    const conflict = draft?.conflict;
    const column = draft === undefined ? undefined : this.fieldColumnsById.get(draft.columnId);
    if (
      draft === undefined ||
      conflict === undefined ||
      column === undefined ||
      (resolution === "mine" && draft.blockedReason !== undefined)
    ) {
      return false;
    }
    const serverRow = this.getRow(draft.rowId);
    if (typeof serverRow !== "object" || serverRow === null) return false;
    const currentServer = this.readCanonicalSourceValue(draft.rowId, serverRow, column);
    let currentServerVersion: unknown;
    try {
      currentServerVersion = this.getRowVersion?.(serverRow);
    } catch {
      return false;
    }
    return (
      currentServer._tag === "Success" &&
      safeEquivalentEditValue(column, currentServer.value, conflict.server) === true &&
      (this.getRowVersion === undefined || Object.is(currentServerVersion, conflict.serverVersion))
    );
  };

  public readonly discardBlockedDrafts = (ids: readonly [string, ...string[]]): boolean => {
    if (
      !this.batchHistoryEnabled ||
      this.getSessionSnapshot().kind === "editing" ||
      this.batchSaveLockOperationId !== undefined
    ) {
      return false;
    }
    this.compactDraftHistoryForInteraction();
    const previousDrafts = this.draftStore.get();
    const nextDrafts = new Map(previousDrafts);
    const historyPatchBuilder = new DraftHistoryPatchMapBuilder();
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id) || this.saveLockedCellKeys.has(id)) return false;
      seen.add(id);
      const before = previousDrafts.get(id);
      if (before?.blockedReason === undefined) return false;
      nextDrafts.delete(id);
      historyPatchBuilder.set(
        id,
        Object.freeze({ cellKey: id, before, after: undefined, authoredValue: before.mine }),
      );
    }
    return this.commitDraftReviewHistoryCommand(nextDrafts, historyPatchBuilder.build());
  };

  public readonly isBlockedDraftDiscardable = (id: string): boolean =>
    this.batchHistoryEnabled &&
    this.getSessionSnapshot().kind !== "editing" &&
    this.batchSaveLockOperationId === undefined &&
    !this.saveLockedCellKeys.has(id) &&
    this.draftStore.get().get(id)?.blockedReason !== undefined;

  public readonly undoBatchDraft = (): boolean => {
    if (!this.batchHistoryEnabled || this.getSessionSnapshot().kind === "editing") return false;
    this.compactDraftHistoryForInteraction();
    const command = this.undoStack.at(-1);
    if (command === undefined) return false;
    this.applyHistoryCommand(command, "before", this.undoStack.slice(0, -1), [
      ...this.redoStack,
      command,
    ]);
    return true;
  };

  public readonly redoBatchDraft = (): boolean => {
    if (!this.batchHistoryEnabled || this.getSessionSnapshot().kind === "editing") return false;
    this.compactDraftHistoryForInteraction();
    const command = this.redoStack.at(-1);
    if (command === undefined) return false;
    this.applyHistoryCommand(
      command,
      "after",
      [...this.undoStack, command],
      this.redoStack.slice(0, -1),
    );
    return true;
  };

  private readonly commitDraftReviewHistoryCommand = (
    nextDrafts: ReadonlyMap<string, DraftEntry>,
    historyPatches: DraftHistoryPatchMap,
    resolvedReviewEntries?: ReadonlyMap<string, DraftEntry>,
    resolutionIds?: ReadonlySet<string>,
  ): boolean => {
    if (historyPatches.size === 0) return false;
    const previousDrafts = this.draftStore.get();
    const previousResolvedEntries = new Map<string, DraftEntry | undefined>();
    const previousResolvedLineages = new Map<string, object | undefined>();
    const previouslyResolvedIds = new Set<string>();
    const previouslyPendingReleasedIds = new Set<string>();
    if (resolutionIds !== undefined) {
      for (const id of resolutionIds) {
        previousResolvedEntries.set(id, this.resolvedDraftReviewEntriesById.get(id));
        previousResolvedLineages.set(id, this.resolvedDraftReviewLineagesById.get(id));
        if (this.resolvedDraftReviewIds.has(id)) previouslyResolvedIds.add(id);
        if (this.pendingReleasedResolutionIds.has(id)) previouslyPendingReleasedIds.add(id);
      }
    }
    for (const key of historyPatches.keys()) this.syncBlockedDraftKey(key, nextDrafts.get(key));
    const command = this.batchHistoryEnabled
      ? createDraftHistoryCommandFromPatches(historyPatches)
      : undefined;
    const nextUndoStack =
      command === undefined
        ? this.undoStack
        : [...this.undoStack, command].slice(-BRUNO_TABLE_BATCH_HISTORY_LIMIT);
    if (command !== undefined) this.prepareDraftHistoryPush(command, nextUndoStack);
    const committedChanges =
      command === undefined
        ? [...historyPatches.values()].flatMap((patch) =>
            patch.after === undefined
              ? []
              : [
                  Object.freeze({
                    rowId: patch.after.rowId,
                    columnId: patch.after.columnId,
                    field: patch.after.field,
                    before: patch.after.base,
                    after: patch.after.mine,
                  }),
                ],
          )
        : [];
    const [firstCommittedChange, ...remainingCommittedChanges] = committedChanges;
    const admissionResult: {
      value: BrunoTableCellEditImmediateSaveResult | boolean | void;
    } = { value: undefined };
    batch(() => {
      if (resolutionIds !== undefined) {
        for (const id of resolutionIds) {
          this.pendingReleasedResolutionIds.delete(id);
          this.resolvedDraftReviewIds.add(id);
          this.setResolvedDraftReviewLineage(id, command?.lineage);
        }
      }
      if (resolvedReviewEntries !== undefined) {
        for (const [id, entry] of resolvedReviewEntries) {
          this.resolvedDraftReviewEntriesById.set(id, entry);
        }
      }
      this.setDraftMemory(
        nextDrafts,
        nextUndoStack,
        command === undefined ? this.redoStack : [],
        historyPatches.keys(),
        command !== undefined,
      );
      this.publishDraftReview(nextDrafts, new Set(historyPatches.keys()));
      for (const patch of historyPatches.values()) {
        if (this.cellStores.size > 0) this.publishCell(patch.cellKey, nextDrafts);
      }
      this.publishActivitySnapshot();
      if (firstCommittedChange !== undefined) {
        try {
          admissionResult.value = this.onCommitGesture(
            Object.freeze([firstCommittedChange, ...remainingCommittedChanges]),
          );
        } catch {
          admissionResult.value = "rejected";
        }
      }
      if (admissionResult.value === false || admissionResult.value === "rejected") {
        for (const key of historyPatches.keys()) {
          this.syncBlockedDraftKey(key, previousDrafts.get(key));
        }
        if (resolutionIds !== undefined) {
          for (const id of resolutionIds) {
            const previousEntry = previousResolvedEntries.get(id);
            if (previousEntry === undefined) this.resolvedDraftReviewEntriesById.delete(id);
            else this.resolvedDraftReviewEntriesById.set(id, previousEntry);
            const previousLineage = previousResolvedLineages.get(id);
            this.setResolvedDraftReviewLineage(id, previousLineage);
            if (!previouslyResolvedIds.has(id)) this.resolvedDraftReviewIds.delete(id);
            if (previouslyPendingReleasedIds.has(id)) this.pendingReleasedResolutionIds.add(id);
            else this.pendingReleasedResolutionIds.delete(id);
          }
        }
        this.setDraftMemory(
          previousDrafts,
          this.undoStack,
          this.redoStack,
          historyPatches.keys(),
          false,
        );
        this.publishDraftReview(previousDrafts, new Set(historyPatches.keys()));
        for (const patch of historyPatches.values()) {
          if (this.cellStores.size > 0) this.publishCell(patch.cellKey, previousDrafts);
        }
        this.publishActivitySnapshot();
        return;
      }
      this.clearSupersededRejectedOperations(historyPatches.keys());
    });
    if (admissionResult.value === false || admissionResult.value === "rejected") return false;
    if (admissionResult.value !== "preflight-reconciled") {
      for (const patch of historyPatches.values()) {
        const entry = patch.after ?? patch.before;
        if (entry !== undefined) this.traversalIndex.invalidateCell(entry.rowId, entry.columnId);
      }
      this.publishTraversalInvalidation();
    }
    if (this.cellStores.size > 0) {
      for (const key of historyPatches.keys()) this.releaseUnusedCellStore(key);
    }
    return true;
  };

  public readonly registerActiveCandidate = (
    candidate: Readonly<{
      readonly restoreFocus: () => void;
    }>,
  ): (() => void) => {
    this.activeCandidate = candidate;
    return () => {
      if (this.activeCandidate === candidate) this.activeCandidate = undefined;
    };
  };

  public readonly registerMovementCommand = (
    command: (
      movement: BrunoTableCellEditMovement,
      origin: BrunoTableCellEditMovementOrigin | undefined,
    ) => boolean,
  ): (() => void) => {
    this.movementCommand = command;
    return () => {
      if (this.movementCommand === command) this.movementCommand = undefined;
    };
  };

  public readonly reconcileMovementRowIndex = (rowIndex: number | undefined): void => {
    if (rowIndex !== undefined && this.getSessionSnapshot().kind === "editing") {
      this.retainedMovementRowIndex = rowIndex;
    }
  };

  public readonly captureMovementOrigin = (): BrunoTableCellEditMovementOrigin | undefined => {
    const session = this.getSessionSnapshot();
    return session.kind === "editing" && this.retainedMovementRowIndex !== undefined
      ? Object.freeze({
          rowId: session.rowId,
          columnId: session.columnId,
          retainedRowIndex: this.retainedMovementRowIndex,
        })
      : undefined;
  };

  public readonly requestMovement = (
    movement: BrunoTableCellEditMovement,
    origin: BrunoTableCellEditMovementOrigin | undefined,
  ): boolean => this.movementCommand?.(movement, origin) === true;

  public readonly reconcileTraversal = (
    columns: readonly CompiledColumn[],
    rowSpace: BrunoTableCellEditTraversalRowSpace,
  ): boolean => {
    return this.traversalIndex.reconcile(columns, rowSpace);
  };

  public readonly buildTraversalSlice = (): boolean => this.traversalIndex.buildNextSlice();

  public readonly isTraversalReady = (): boolean => this.traversalIndex.isReady();

  public readonly reconcileTraversalRows = (
    changedRowIds: ReadonlySet<string> | undefined,
  ): void => {
    if (this.traversalIndex.reconcileRows(changedRowIds)) this.publishTraversalInvalidation();
  };

  public readonly reconcileSourceRows = (changedRowIds: ReadonlySet<string> | undefined): void => {
    if (!this.isSourceAuthoritative()) return;
    let retainedResolutionCandidates: Set<string> | undefined;
    if (changedRowIds === undefined) {
      if (this.resolvedDraftReviewIds.size > 0) {
        retainedResolutionCandidates = new Set(this.resolvedDraftReviewIds);
      }
    } else {
      for (const rowId of changedRowIds) {
        const rowKeys = this.draftKeysByRowId.get(rowId);
        if (rowKeys === undefined) continue;
        if (typeof rowKeys === "string") {
          if (this.resolvedDraftReviewIds.has(rowKeys)) {
            (retainedResolutionCandidates ??= new Set()).add(rowKeys);
          }
          continue;
        }
        for (const id of rowKeys) {
          if (this.resolvedDraftReviewIds.has(id)) {
            (retainedResolutionCandidates ??= new Set()).add(id);
          }
        }
      }
    }
    const submittedConvergedKeys = this.reconcilePendingSubmittedValues(changedRowIds);
    const draftsChanged = this.reconcileDraftRows(changedRowIds, false, submittedConvergedKeys);
    const overlaysChanged = this.reconcileAcceptedOverlays(changedRowIds);
    const rejectedChanged = this.reconcileRejectedOperations(changedRowIds);
    if (retainedResolutionCandidates !== undefined) {
      this.retainedResolutionPublicationStore.setState(() => retainedResolutionCandidates);
    }
    if (draftsChanged || overlaysChanged || rejectedChanged) this.publishTraversalInvalidation();
  };

  private readonly reconcilePendingSubmittedValues = (
    changedRowIds: ReadonlySet<string> | undefined,
  ): ReadonlySet<string> => {
    const newlyConverged = new Set<string>();
    const reconcileRow = (operationId: string, rowId: string): void => {
      // Accepted operations retain locks while awaiting source confirmation, but
      // their values now belong to Accepted Overlay reconciliation, not pre-resolution evidence.
      if (this.acceptedOverlayCountsByOperation.has(operationId)) return;
      const authorities = this.valueAuthoritiesByOperation.get(operationId);
      const submittedValues = this.submittedValuesByOperation.get(operationId);
      const locksByRow = this.saveLockedCellKeysByOperationRow.get(operationId);
      if (authorities === undefined || submittedValues === undefined || locksByRow === undefined) {
        return;
      }
      const keys = locksByRow.get(rowId);
      if (keys === undefined) return;
      const converged =
        this.pendingConvergedCellKeysByOperation.get(operationId) ?? new Set<string>();
      const row = this.getRow(rowId);
      for (const key of keys) {
        if (converged.has(key)) continue;
        const identity = parseCellKey(key);
        if (identity === undefined) continue;
        const authority = authorities.get(identity.columnId);
        if (authority === undefined || !submittedValues.has(key)) continue;
        const source = this.readSubmittedSourceValue(row, authority);
        if (
          source._tag === "Success" &&
          safeEquivalentEditValues(authority.equivalent, submittedValues.get(key), source.value) ===
            true
        ) {
          converged.add(key);
          newlyConverged.add(key);
        }
      }
      if (converged.size > 0) {
        this.pendingConvergedCellKeysByOperation.set(operationId, converged);
      }
    };
    if (changedRowIds === undefined) {
      for (const [operationId, locksByRow] of this.saveLockedCellKeysByOperationRow) {
        for (const rowId of locksByRow.keys()) reconcileRow(operationId, rowId);
      }
      return newlyConverged;
    }
    for (const rowId of changedRowIds) {
      for (const operationId of this.pendingOperationIdsByRowId.get(rowId) ?? []) {
        reconcileRow(operationId, rowId);
      }
    }
    return newlyConverged;
  };

  public readonly subscribeTraversalInvalidation = (listener: Listener): (() => void) => {
    this.traversalInvalidationListeners.add(listener);
    return () => this.traversalInvalidationListeners.delete(listener);
  };

  public readonly reconcileActiveRow = (changedRowIds?: ReadonlySet<string>): void => {
    if (!this.isSourceAuthoritative()) return;
    const session = this.actor.getSnapshot().context.session;
    if (
      session !== undefined &&
      (changedRowIds === undefined || changedRowIds.has(session.rowId))
    ) {
      const row = this.getRow(session.rowId);
      const sourceValue = this.readCanonicalSourceValue(session.rowId, row, session.column);
      const activeKey = cellKey(session.rowId, session.column.columnId);
      const convergedAdmittedDraft =
        session.beforeFromDraft &&
        !this.draftStore.get().has(activeKey) &&
        sourceValue._tag === "Success" &&
        safeEquivalentEditValue(session.column, session.before, sourceValue.value) === true;
      let expectedVersion = session.expectedVersion;
      let rebaseFromConvergedDraft = false;
      let rebaseFailed = false;
      if (convergedAdmittedDraft) {
        try {
          expectedVersion =
            typeof row === "object" && row !== null ? this.getRowVersion?.(row) : undefined;
          rebaseFromConvergedDraft = true;
        } catch {
          rebaseFromConvergedDraft = false;
          rebaseFailed = true;
        }
      }
      this.actor.send({
        type: "RECONCILE_ROW",
        row,
        sourceValue,
        expectedVersion,
        rebaseFromConvergedDraft,
        rebaseFailed,
      });
    }
  };

  public readonly reconcileTraversalRange = (
    range: BrunoTableCellEditTraversalRange | undefined,
  ): void => {
    this.traversalIndex.reconcileRange(range);
  };

  public readonly findTraversalDestination = (
    rowIndex: number,
    columnId: string,
    direction: -1 | 1,
  ): BrunoTableCellEditTraversalDestination | undefined =>
    this.traversalIndex.find(rowIndex, columnId, direction);

  public readonly findTraversalDestinationFromRowBoundary = (
    rowIndex: number,
    direction: -1 | 1,
  ): BrunoTableCellEditTraversalDestination | undefined =>
    this.traversalIndex.findFromRowBoundary(rowIndex, direction);

  public readonly findRangeTraversalDestination = (
    range: BrunoTableCellEditTraversalRange,
    rowId: string,
    columnId: string,
    direction: -1 | 1,
  ): BrunoTableCellEditTraversalDestination | undefined =>
    this.traversalIndex.findRange(range, rowId, columnId, direction);

  public readonly reconcileColumns = (
    columns: readonly CompiledColumn[],
    getRow: (rowId: string) => unknown = this.getRow,
  ): void => {
    if (this.columns === columns) return;
    const previousFieldColumns = this.fieldColumnsById;
    this.canonicalSourceValueCache = new WeakMap();
    this.draftProjectionCache = new WeakMap();
    const nextFieldColumns = indexFieldColumns(columns);
    const previousDrafts = this.draftStore.get();
    const protectedPresentationColumns = new Map<string, CompiledFieldColumn>();
    for (const [key, operationId] of this.saveLockedCellKeys) {
      const identity = parseCellKey(key);
      if (identity === undefined) continue;
      const presentationColumn = this.valueAuthoritiesByOperation
        .get(operationId)
        ?.get(identity.columnId)?.presentationColumn;
      if (presentationColumn !== undefined) {
        protectedPresentationColumns.set(key, presentationColumn);
      }
    }
    for (const operationId of this.rejectedBatchOperationIds) {
      const evidenceByRow = this.rejectedOperations.get(operationId);
      if (evidenceByRow === undefined) continue;
      for (const entry of flattenRejectedEvidence(evidenceByRow)) {
        const presentationColumn = entry.valueAuthority.presentationColumn;
        if (presentationColumn !== undefined) {
          protectedPresentationColumns.set(
            cellKey(entry.rowId, entry.columnId),
            presentationColumn,
          );
        }
      }
    }
    const reconciliation = createDraftColumnReconciliationContext(
      previousFieldColumns,
      nextFieldColumns,
      getRow,
      protectedPresentationColumns,
      protectedPresentationColumns.size > 0 ||
        [...previousDrafts.values()].some((draft) => draft.presentationColumn !== undefined) ||
        [...this.resolvedDraftReviewEntriesById.values()].some(
          (draft) => draft.presentationColumn !== undefined,
        ),
    );
    const { drafts: migratedDrafts, changedKeys: migratedDraftKeys } = reconcileDraftsForColumns(
      previousDrafts,
      reconciliation,
    );
    const previousResolvedDraftReviewEntries = this.resolvedDraftReviewEntriesById;
    const {
      drafts: migratedResolvedDraftReviewEntries,
      changedKeys: migratedResolvedDraftReviewKeys,
    } = reconcileDraftsForColumns(previousResolvedDraftReviewEntries, reconciliation, false);
    const reconciledUndo = reconcileDraftHistoryForColumns(this.undoStack, reconciliation);
    const reconciledRedo = reconcileDraftHistoryForColumns(this.redoStack, reconciliation);
    let nextDrafts = migratedDrafts;
    let nextResolvedDraftReviewEntries = migratedResolvedDraftReviewEntries;
    let nextUndoStack = reconciledUndo.commands;
    let nextRedoStack = reconciledRedo.commands;
    const convergedKeys = new Set<string>();
    const reconciledCanonicalSources = new Map<string, CanonicalSourceValue>();
    for (const key of reconciliation.semanticKeys) {
      if (this.saveLockedCellKeys.has(key)) continue;
      const draft = nextDrafts.get(key);
      const retainedResolved = nextResolvedDraftReviewEntries.get(key);
      const representative =
        draft ?? retainedResolved ?? findDraftHistoryEntry(nextUndoStack, nextRedoStack, key);
      if (representative === undefined) continue;
      const column = nextFieldColumns.get(representative.columnId);
      const row = getDraftColumnReconciliationRow(reconciliation, representative.rowId);
      const source = readCanonicalSourceValueFromRawRow(row, column);
      reconciledCanonicalSources.set(key, source);
      const mineMatchesBase =
        column !== undefined &&
        (draft !== undefined || retainedResolved !== undefined
          ? safeEquivalentEditValue(column, representative.mine, representative.base) === true
          : retainedHistoryMineMatchesBase(nextUndoStack, nextRedoStack, key, column));
      const sourceConverged =
        column !== undefined &&
        source._tag === "Success" &&
        (draft !== undefined || retainedResolved !== undefined
          ? safeEquivalentEditValue(column, representative.mine, source.value) === true
          : retainedHistoryMineConverged(nextUndoStack, nextRedoStack, key, column, source.value));
      if (mineMatchesBase || sourceConverged) {
        convergedKeys.add(key);
      }
    }
    if (convergedKeys.size > 0) {
      const prunedDrafts = new Map(nextDrafts);
      for (const key of convergedKeys) prunedDrafts.delete(key);
      nextDrafts = prunedDrafts;
      const prunedResolvedDraftReviewEntries = new Map(nextResolvedDraftReviewEntries);
      for (const key of convergedKeys) prunedResolvedDraftReviewEntries.delete(key);
      nextResolvedDraftReviewEntries = prunedResolvedDraftReviewEntries;
      nextUndoStack = pruneDraftHistoryAdaptive(nextUndoStack, convergedKeys);
      nextRedoStack = pruneDraftHistoryAdaptive(nextRedoStack, convergedKeys);
    }
    const changedDraftKeys = new Set(migratedDraftKeys);
    for (const key of convergedKeys) {
      if (migratedDrafts.has(key) || previousDrafts.has(key)) changedDraftKeys.add(key);
    }
    const changedResolvedDraftReviewKeys = new Set(migratedResolvedDraftReviewKeys);
    for (const key of convergedKeys) {
      if (
        migratedResolvedDraftReviewEntries.has(key) ||
        previousResolvedDraftReviewEntries.has(key)
      ) {
        changedResolvedDraftReviewKeys.add(key);
      }
    }
    const memoryChangedKeys = new Set([
      ...changedDraftKeys,
      ...reconciledUndo.changedKeys,
      ...reconciledRedo.changedKeys,
      ...convergedKeys,
      ...changedResolvedDraftReviewKeys,
    ]);
    const changedCellKeys = new Set([...changedDraftKeys, ...changedResolvedDraftReviewKeys]);
    const reviewKeys =
      this.draftReviewSubscriberCount === 0
        ? changedCellKeys
        : new Set([...changedCellKeys, ...this.draftReviewRowsById.keys()]);
    const activeSession = this.actor.getSnapshot().context.session;
    const nextActiveColumn =
      activeSession === undefined ? undefined : nextFieldColumns.get(activeSession.column.columnId);
    const canRebindActiveSession =
      activeSession !== undefined &&
      nextActiveColumn !== undefined &&
      isCompatibleActiveColumn(activeSession.column, nextActiveColumn);
    batch(() => {
      this.columns = columns;
      this.fieldColumnsById = nextFieldColumns;
      this.resolvedDraftReviewEntriesById = new Map(nextResolvedDraftReviewEntries);
      for (const key of changedResolvedDraftReviewKeys) {
        if (!nextResolvedDraftReviewEntries.has(key)) this.clearResolvedDraftReviewEvidence(key);
      }
      if (canRebindActiveSession) {
        this.actor.send({ type: "RECONCILE_COLUMN", column: nextActiveColumn });
      } else {
        this.cancel();
      }
      if (
        nextDrafts !== previousDrafts ||
        nextUndoStack !== this.undoStack ||
        nextRedoStack !== this.redoStack
      ) {
        this.setDraftMemory(nextDrafts, nextUndoStack, nextRedoStack, memoryChangedKeys);
      }
      for (const key of changedDraftKeys) this.syncBlockedDraftKey(key, nextDrafts.get(key));
      if (reviewKeys.size > 0) {
        this.publishDraftReview(nextDrafts, reviewKeys, undefined, reconciledCanonicalSources);
      }
      if (changedResolvedDraftReviewKeys.size > 0) {
        this.retainedResolutionPublicationStore.setState(
          () => new Set(changedResolvedDraftReviewKeys),
        );
      }
      if (memoryChangedKeys.size > 0) this.publishActivitySnapshot();
      if (changedCellKeys.size === 0) return;
      for (const key of changedCellKeys) {
        this.invalidateDraftCell(key, false);
        this.publishCell(key, nextDrafts);
        this.releaseUnusedCellStore(key);
      }
    });
    if (changedCellKeys.size > 0) this.publishTraversalInvalidation();
  };

  public readonly commitActiveCandidate = (): boolean => {
    const candidate = this.activeCandidate;
    if (candidate === undefined) return this.getSessionSnapshot().kind === "idle";
    const candidateValue = this.candidateStore.get();
    const accepted = this.commit(
      candidateValue.rawText,
      candidateValue.nativeInvalid,
      candidateValue.kind,
    );
    if (!accepted) candidate.restoreFocus();
    return accepted;
  };

  public readonly resetAllDrafts = (): number => {
    this.cancel();
    for (const operationId of this.rejectedBatchOperationIds) {
      this.clearRejectedOperation(operationId);
    }
    const previousDrafts = this.draftStore.get();
    const affectedKeys = [
      ...new Set([...this.draftEvidenceKeys, ...this.resolvedDraftReviewEntriesById.keys()]),
    ];
    const nextDrafts = new Map<string, DraftEntry>();
    this.clearAllResolvedDraftReviewEvidence();
    this.blockedDraftKeys.clear();
    this.validationDraftKeys.clear();
    this.conflictDraftKeys.clear();
    batch(() => {
      this.setDraftMemory(nextDrafts, [], [], affectedKeys);
      this.publishDraftReview(nextDrafts, new Set(affectedKeys));
      this.publishActivitySnapshot();
      for (const key of affectedKeys) {
        this.invalidateDraftCell(key, false);
        this.publishCell(key, nextDrafts);
      }
    });
    if (affectedKeys.length > 0) this.publishTraversalInvalidation();
    for (const key of affectedKeys) this.releaseUnusedCellStore(key);
    return previousDrafts.size;
  };

  public readonly isEditable = (rowId: string, columnId: string): boolean => {
    if (!this.saveOperationCapacityAvailable || this.isSaveLocked(rowId, columnId)) return false;
    const column = this.fieldColumnsById.get(columnId);
    if (column === undefined || column.isEditable === undefined || column.isEditable === false) {
      return false;
    }
    const row = this.getRow(rowId);
    if (typeof row !== "object" || row === null) return false;
    return this.evaluateEditable(rowId, row, column);
  };

  private readonly evaluateEditable = (
    rowId: string,
    row: object,
    column: CompiledFieldColumn,
  ): boolean => {
    if (!this.saveOperationCapacityAvailable || this.isSaveLocked(rowId, column.columnId)) {
      return false;
    }
    if (column.isEditable === undefined || column.isEditable === false) return false;
    const draft = this.draftStore.get().get(cellKey(rowId, column.columnId));
    let value: unknown;
    if (draft === undefined) {
      const sourceValue = this.readCanonicalSourceValue(rowId, row, column);
      if (sourceValue._tag !== "Success") return false;
      value = sourceValue.value;
    } else {
      value = draft.mine;
    }
    if (!isEditorValueRepresentable(column, value)) return false;
    if (typeof column.isEditable !== "function") return true;
    try {
      return Reflect.apply(column.isEditable, undefined, [{ row, value }]) === true;
    } catch {
      return false;
    }
  };

  public readonly start = (
    rowId: string,
    columnId: string,
    mode: "current" | "replace" = "current",
    producedText = "",
  ): boolean => {
    if (!this.saveOperationCapacityAvailable || this.getSessionSnapshot().kind !== "idle") {
      return false;
    }
    if (this.isSaveLocked(rowId, columnId)) return false;
    const column = this.fieldColumnsById.get(columnId);
    const row = this.getRow(rowId);
    const draft = this.draftStore.get().get(cellKey(rowId, columnId));
    let expectedVersion: unknown;
    try {
      expectedVersion =
        typeof row === "object" && row !== null ? this.getRowVersion?.(row) : undefined;
    } catch {
      return false;
    }
    this.actor.send({
      type: "START",
      rowId,
      column,
      row,
      sourceValue: this.readCanonicalSourceValue(rowId, row, column),
      expectedVersion,
      hasDraft: draft !== undefined,
      draftValue: draft?.mine,
      mode,
      producedText,
    });
    this.retainedMovementRowIndex = undefined;
    return this.getSessionSnapshot().kind === "editing";
  };

  private readonly readCanonicalSourceValue = (
    rowId: string,
    row: unknown,
    column: CompiledColumn | undefined,
  ): CanonicalSourceValue => {
    if (column?.kind !== "field" || typeof row !== "object" || row === null) {
      return Object.freeze({ _tag: "Failure" });
    }
    let byAuthority = this.canonicalSourceValueCache.get(row);
    if (byAuthority === undefined) {
      byAuthority = new Map();
      this.canonicalSourceValueCache.set(row, byAuthority);
    }
    const authority = column.semantics.decodeRuntimeAuthority;
    let byField = byAuthority.get(authority);
    if (byField === undefined) {
      byField = new Map();
      byAuthority.set(authority, byField);
    }
    const cached = byField.get(column.field);
    if (cached !== undefined) return cached;
    let result: CanonicalSourceValue | undefined;
    if (this.getCanonicalValue !== undefined) {
      try {
        const canonical = this.getCanonicalValue(rowId, column.columnId);
        result =
          canonical?._tag === "Success" && "value" in canonical
            ? Object.freeze({ _tag: "Success", value: canonical.value })
            : Object.freeze({ _tag: "Failure" });
      } catch {
        result = Object.freeze({ _tag: "Failure" });
      }
    } else {
      let raw: unknown;
      try {
        raw = Reflect.get(row, column.field);
      } catch {
        result = Object.freeze({ _tag: "Failure" });
      }
      if (result === undefined && (raw === null || raw === undefined)) {
        result = Object.freeze({ _tag: "Success", value: raw });
      } else if (result === undefined) {
        const decoded = column.semantics.decodeRuntime(raw);
        result =
          decoded._tag === "Success" && "value" in decoded
            ? Object.freeze({ _tag: "Success", value: decoded.value })
            : Object.freeze({ _tag: "Failure" });
      }
    }
    result ??= Object.freeze({ _tag: "Failure" });
    byField.set(column.field, result);
    return result;
  };

  private readonly isCanonicalSourceEquivalent = (
    rowId: string,
    row: object,
    column: CompiledFieldColumn,
    value: unknown,
  ): boolean => {
    let source: unknown;
    if (this.getCanonicalValue !== undefined) {
      try {
        const canonical = this.getCanonicalValue(rowId, column.columnId);
        if (canonical?._tag !== "Success" || !("value" in canonical)) return false;
        source = canonical.value;
      } catch {
        return false;
      }
    } else {
      let raw: unknown;
      try {
        raw = Reflect.get(row, column.field);
      } catch {
        return false;
      }
      if (raw === null || raw === undefined) source = raw;
      else {
        const decoded = column.semantics.decodeRuntime(raw);
        if (decoded._tag !== "Success" || !("value" in decoded)) return false;
        source = decoded.value;
      }
    }
    return Object.is(value, source) || safeEquivalentEditValue(column, value, source) === true;
  };

  private readonly createSubmittedValueAuthority = (
    column: CompiledFieldColumn,
  ): SubmittedValueAuthority =>
    Object.freeze({
      field: column.field,
      presentationColumn: column,
      decodeRuntime: (input: unknown): CanonicalSourceValue => {
        if (input === null || input === undefined) {
          return Object.freeze({ _tag: "Success", value: input });
        }
        try {
          const decoded = column.semantics.decodeRuntime(input);
          return decoded._tag === "Success" && "value" in decoded
            ? Object.freeze({ _tag: "Success", value: decoded.value })
            : Object.freeze({ _tag: "Failure" });
        } catch {
          return Object.freeze({ _tag: "Failure" });
        }
      },
      equivalent: column.semantics.equivalent,
    });

  private readonly getSubmittedValueAuthority = (
    operationId: string,
    change: BrunoTableCellEditSaveCellChange,
  ): SubmittedValueAuthority => {
    const submitted = this.valueAuthoritiesByOperation.get(operationId)?.get(change.columnId);
    if (submitted !== undefined) return submitted;
    const current = this.fieldColumnsById.get(change.columnId);
    if (current !== undefined && current.field === change.field) {
      return this.createSubmittedValueAuthority(current);
    }
    return Object.freeze({
      field: change.field,
      decodeRuntime: (input: unknown) => Object.freeze({ _tag: "Success" as const, value: input }),
      equivalent: Object.is,
    });
  };

  private readonly readSubmittedSourceValue = (
    row: unknown,
    authority: SubmittedValueAuthority,
  ): CanonicalSourceValue => {
    if (typeof row !== "object" || row === null) return Object.freeze({ _tag: "Failure" });
    let raw: unknown;
    try {
      raw = Reflect.get(row, authority.field);
    } catch {
      return Object.freeze({ _tag: "Failure" });
    }
    return authority.decodeRuntime(raw);
  };

  public readonly commit = (
    rawText: string,
    nativeInvalid = false,
    intent: "scalar" | "blank" = "scalar",
  ): boolean => {
    if (
      !this.saveOperationCapacityAvailable ||
      (!this.batchHistoryEnabled && !this.isSourceAuthoritative())
    ) {
      return false;
    }
    const actorSnapshot = this.actor.getSnapshot();
    if (actorSnapshot.value !== "editing" || actorSnapshot.context.session === undefined) {
      return false;
    }
    const admittedSession = actorSnapshot.context.session;
    const admittedCandidate = this.candidateStore.get();
    const admittedDraft = this.draftStore
      .get()
      .get(cellKey(admittedSession.rowId, admittedSession.column.columnId));
    const previousDrafts = this.draftStore.get();
    const admittedKey = cellKey(admittedSession.rowId, admittedSession.column.columnId);
    let accepted = false;
    let admissionRejected = false;
    const admissionResult: {
      value: BrunoTableCellEditImmediateSaveResult | boolean | void;
    } = { value: undefined };
    const deferImmediateSideEffects = !this.batchHistoryEnabled;
    batch(() => {
      this.deferActorDraftSideEffects = deferImmediateSideEffects;
      this.actor.send({ type: "COMMIT", rawText, nativeInvalid, intent });
      this.deferActorDraftSideEffects = false;
      const result = this.actor.getSnapshot();
      if (result.value !== "idle") return;
      accepted = true;
      if (result.context.acceptedChange !== undefined) {
        admissionResult.value = this.onCommit(result.context.acceptedChange);
        if (
          deferImmediateSideEffects &&
          (admissionResult.value === false || admissionResult.value === "rejected")
        ) {
          admissionRejected = true;
          this.syncBlockedDraftKey(admittedKey, previousDrafts.get(admittedKey));
          this.setDraftMemory(previousDrafts, this.undoStack, this.redoStack, [admittedKey]);
          this.actor.send({ type: "RESTORE_REJECTED_COMMIT", session: admittedSession });
          this.candidateStore.setState(() => admittedCandidate);
          this.publishDraftReview(previousDrafts, new Set([admittedKey]));
          this.publishCell(admittedKey, previousDrafts);
          this.publishActivitySnapshot();
          return;
        }
        if (deferImmediateSideEffects) {
          this.clearSupersededRejectedOperations([admittedKey]);
        }
      }
      const sourceChangedDuringSession =
        admittedSession.sourceValueAvailable &&
        safeEquivalentEditValue(
          admittedSession.column,
          admittedSession.baseValue,
          admittedSession.sourceValue,
        ) === false;
      if (
        this.batchHistoryEnabled &&
        (sourceChangedDuringSession || admittedDraft?.conflict !== undefined)
      ) {
        this.reconcileDraftRows(
          new Set([admittedSession.rowId]),
          false,
          new Set(),
          new Map([[admittedSession.rowId, admittedSession.row]]),
          new Set([admittedKey]),
        );
      }
    });
    this.deferActorDraftSideEffects = false;
    if (!accepted || admissionRejected) return false;
    if (deferImmediateSideEffects && admissionResult.value !== "preflight-reconciled") {
      this.traversalIndex.invalidateCell(admittedSession.rowId, admittedSession.column.columnId);
      this.publishTraversalInvalidation();
    }
    return true;
  };

  public readonly cancel = (): boolean => {
    if (this.actor.getSnapshot().value !== "editing") return false;
    this.actor.send({ type: "CANCEL" });
    this.retainedMovementRowIndex = undefined;
    return true;
  };

  public readonly dispose = (): void => {
    if (!this.actorActive) return;
    this.actor.stop();
    this.actorActive = false;
    this.sessionStore.setState(() => IDLE_SESSION);
    const affectedDraftEvidenceKeys = new Set(this.draftEvidenceKeys);
    this.clearAllResolvedDraftReviewEvidence();
    this.setDraftMemory(new Map(), [], [], affectedDraftEvidenceKeys);
    this.draftReviewStore.setState(() => Object.freeze([]));
    this.draftReviewRowsById.clear();
    this.draftReviewRowStoresById.clear();
    this.draftReviewEntriesById.clear();
    this.draftReviewProjectedRowsByRowId.clear();
    this.draftReviewProjectionHistoryByRowId.clear();
    this.clearDraftReviewClassification();
    this.draftReviewSubscriberCount = 0;
    this.activityStore.setState(() => IDLE_ACTIVITY);
    this.candidateStore.setState(() => EMPTY_CANDIDATE);
    this.cellStores.clear();
    this.cellSubscriberCounts.clear();
    this.acceptedOverlays = new Map();
    this.acceptedOverlayCountsByOperation.clear();
    this.acceptedOverlayCountsByOperationRow.clear();
    this.acceptedOverlayCountStoresByOperation.clear();
    this.acceptedOverlayKeysByRowId.clear();
    this.rejectedOperations = new Map();
    this.rejectedOperationCellCounts.clear();
    this.rejectedOperationStores.clear();
    this.rejectedOperationIdsByRowId.clear();
    this.rejectedBatchOperationIds.clear();
    this.rejectedCellKeys.clear();
    this.rejectedCellPresentationDeadlinesByOperation.clear();
    this.cellPresentationDeadlineQueue.cancel();
    this.successFlashDeadlinesByKey.clear();
    this.successFlashOperationByKey.clear();
    this.saveLockedCellKeys.clear();
    this.saveLockedCellKeysByOperationRow.clear();
    this.pendingOperationIdsByRowId.clear();
    this.batchSaveOperationIds.clear();
    this.pendingConvergedCellKeysByOperation.clear();
    this.submittedValuesByOperation.clear();
    this.rowVersionExtractorsByOperation.clear();
    this.valueAuthoritiesByOperation.clear();
    this.batchSaveLockOperationId = undefined;
    this.traversalInvalidationListeners.clear();
    this.activeCellKey = undefined;
    this.activeCandidate = undefined;
    this.blockedDraftKeys.clear();
    this.validationDraftKeys.clear();
    this.conflictDraftKeys.clear();
    this.draftKeysByRowId.clear();
  };

  private readonly publishActorDecision = (): void => {
    const previousKey = this.activeCellKey;
    const snapshot = this.actor.getSnapshot();
    const session = snapshot.value === "editing" ? snapshot.context.session : undefined;
    const invalidMessage =
      session === undefined
        ? undefined
        : session.rowMissing
          ? session.invalidMessage
          : (session.permissionMessage ?? session.rowVersionMessage ?? session.invalidMessage);
    const next =
      session === undefined
        ? IDLE_SESSION
        : Object.freeze({
            kind: "editing" as const,
            rowId: session.rowId,
            columnId: session.column.columnId,
            initialText: session.initialText,
            selectInitialText: session.selectInitialText,
            rowMissing: session.rowMissing,
            ...(invalidMessage === undefined ? {} : { invalidMessage }),
          });
    const nextKey = next.kind === "editing" ? cellKey(next.rowId, next.columnId) : undefined;
    if (previousKey === undefined && next.kind === "editing") {
      this.candidateStore.setState(() =>
        session !== undefined &&
        session.column.blankValue !== undefined &&
        (session.before === null || session.before === undefined)
          ? Object.freeze({ kind: "blank", rawText: "", nativeInvalid: false })
          : Object.freeze({ kind: "scalar", rawText: next.initialText, nativeInvalid: false }),
      );
    }
    this.activeCellKey = nextKey;
    if (nextKey !== undefined && !this.cellStores.has(nextKey)) this.installCellStore(nextKey);
    const actorContext = this.actor.getSnapshot().context;
    if (
      this.batchHistoryEnabled &&
      actorContext.draftPatch !== undefined &&
      this.appliedDraftPatch !== actorContext.draftPatch
    ) {
      this.compactDraftHistoryForInteraction();
    }
    const affectedKeys = new Set(actorContext.affectedCellKeys);
    const previousDrafts = this.draftStore.get();
    const draftPatch = actorContext.draftPatch;
    const nextDrafts =
      draftPatch === undefined || this.appliedDraftPatch === draftPatch
        ? previousDrafts
        : applyDraftPatch(previousDrafts, draftPatch, this.fieldColumnsById);
    if (draftPatch !== undefined) this.appliedDraftPatch = draftPatch;
    if (previousKey !== undefined) affectedKeys.add(previousKey);
    if (nextKey !== undefined) affectedKeys.add(nextKey);
    const historyCommand =
      nextDrafts !== previousDrafts && this.batchHistoryEnabled && draftPatch !== undefined
        ? createDraftHistoryCommand(
            Object.freeze({
              cellKey: draftPatch.cellKey,
              before: previousDrafts.get(draftPatch.cellKey),
              after: nextDrafts.get(draftPatch.cellKey),
              authoredValue: draftPatch.value,
            }),
          )
        : undefined;
    const nextUndoStack =
      historyCommand === undefined
        ? this.undoStack
        : [...this.undoStack, historyCommand].slice(-BRUNO_TABLE_BATCH_HISTORY_LIMIT);
    const nextRedoStack = historyCommand === undefined ? this.redoStack : [];
    if (historyCommand !== undefined) {
      this.prepareDraftHistoryPush(historyCommand, nextUndoStack);
    }
    if (
      nextDrafts !== previousDrafts &&
      draftPatch !== undefined &&
      !this.deferActorDraftSideEffects
    ) {
      this.clearSupersededRejectedOperations([draftPatch.cellKey]);
    }
    batch(() => {
      if (nextDrafts !== previousDrafts) {
        this.setDraftMemory(
          nextDrafts,
          nextUndoStack,
          nextRedoStack,
          actorContext.affectedCellKeys,
          historyCommand !== undefined,
        );
        if (draftPatch !== undefined) {
          this.syncBlockedDraftKey(draftPatch.cellKey, nextDrafts.get(draftPatch.cellKey));
        }
        for (const key of actorContext.affectedCellKeys) {
          this.invalidateDraftCell(key, !this.deferActorDraftSideEffects);
        }
      }
      if (!sameSessionSnapshot(this.sessionStore.get(), next)) {
        this.sessionStore.setState(() => next);
      }
      this.publishDraftReview(nextDrafts, affectedKeys);
      this.publishActivity(
        next.kind === "editing",
        this.hasActiveCandidateWork(next),
        nextDrafts.size,
        this.undoHistoryCount,
        this.redoHistoryCount,
      );
      for (const key of affectedKeys) this.publishCell(key, nextDrafts);
    });
    for (const key of affectedKeys) this.releaseUnusedCellStore(key);
  };

  private readonly publishActivity = (
    activeEditor: boolean,
    activeCandidatePending: boolean,
    draftCount: number,
    undoCount = this.undoHistoryCount,
    redoCount = this.redoHistoryCount,
    blockedCount = this.blockedDraftKeys.size,
    validationCount = this.validationDraftKeys.size,
    conflictCount = this.conflictDraftKeys.size,
  ): void => {
    const reviewCount =
      draftCount +
      (activeCandidatePending &&
      (this.activeCellKey === undefined || !this.draftStore.get().has(this.activeCellKey))
        ? 1
        : 0);
    const activeCandidateValidationCount =
      activeCandidatePending &&
      this.hasInvalidActiveCandidate() &&
      (this.activeCellKey === undefined || !this.validationDraftKeys.has(this.activeCellKey))
        ? 1
        : 0;
    validationCount += activeCandidateValidationCount;
    const session = this.actor.getSnapshot().context.session;
    const activeCandidateBlockedCount =
      activeCandidatePending &&
      session !== undefined &&
      (session.rowMissing ||
        session.permissionMessage !== undefined ||
        session.rowVersionMessage !== undefined) &&
      (this.activeCellKey === undefined || !this.blockedDraftKeys.has(this.activeCellKey))
        ? 1
        : 0;
    blockedCount += activeCandidateBlockedCount;
    const previous = this.activityStore.get();
    if (
      previous.activeEditor === activeEditor &&
      previous.activeCandidatePending === activeCandidatePending &&
      previous.reviewCount === reviewCount &&
      previous.draftCount === draftCount &&
      previous.undoCount === undoCount &&
      previous.redoCount === redoCount &&
      previous.blockedCount === blockedCount &&
      previous.validationCount === validationCount &&
      previous.conflictCount === conflictCount
    )
      return;
    this.activityStore.setState(() =>
      Object.freeze({
        activeEditor,
        activeCandidatePending,
        reviewCount,
        draftCount,
        undoCount,
        redoCount,
        blockedCount,
        validationCount,
        conflictCount,
      }),
    );
  };

  private readonly publishActivitySnapshot = (): void => {
    this.publishActivity(
      this.sessionStore.get().kind === "editing",
      this.hasActiveCandidateWork(this.sessionStore.get()),
      this.draftStore.get().size,
      this.undoHistoryCount,
      this.redoHistoryCount,
      this.blockedDraftKeys.size,
      this.validationDraftKeys.size,
      this.conflictDraftKeys.size,
    );
  };

  private readonly applyHistoryCommand = (
    command: DraftHistoryCommand,
    state: "before" | "after",
    nextUndoStack: readonly DraftHistoryCommand[],
    nextRedoStack: readonly DraftHistoryCommand[],
  ): void => {
    const nextDrafts = new Map(this.draftStore.get());
    const prunedKeys = new Set<string>();
    for (const patch of command.patches.values()) {
      const requested = patch[state];
      if (requested === undefined) {
        nextDrafts.delete(patch.cellKey);
        this.syncBlockedDraftKey(patch.cellKey, undefined);
        continue;
      }
      const { entry, prune } = this.revalidateHistoryEntry(requested);
      if (prune) prunedKeys.add(patch.cellKey);
      if (entry === undefined) nextDrafts.delete(patch.cellKey);
      else nextDrafts.set(patch.cellKey, entry);
      this.syncBlockedDraftKey(patch.cellKey, entry);
    }
    if (prunedKeys.size > 0) {
      nextUndoStack = pruneDraftHistory(nextUndoStack, prunedKeys);
      nextRedoStack = pruneDraftHistory(nextRedoStack, prunedKeys);
    }
    this.clearSupersededRejectedOperations(command.patches.keys());
    batch(() => {
      this.setDraftMemory(nextDrafts, nextUndoStack, nextRedoStack, command.patches.keys());
      if (this.draftReviewSubscriberCount > 0) {
        this.publishDraftReview(nextDrafts, new Set(command.patches.keys()));
      }
      for (const patch of command.patches.values()) {
        const entry = patch.after ?? patch.before;
        if (entry !== undefined) this.traversalIndex.invalidateCell(entry.rowId, entry.columnId);
        else this.invalidateDraftCell(patch.cellKey, false);
        if (this.cellStores.size > 0) this.publishCell(patch.cellKey, nextDrafts);
      }
      this.publishActivitySnapshot();
    });
    this.publishTraversalInvalidation();
    if (this.cellStores.size > 0) {
      for (const patch of command.patches.values()) this.releaseUnusedCellStore(patch.cellKey);
    }
  };

  private readonly registerDraftHistoryCommand = (
    command: DraftHistoryCommand,
    stack: "undo" | "redo",
    index: number,
    undoStack: readonly DraftHistoryCommand[] = this.undoStack,
    redoStack: readonly DraftHistoryCommand[] = this.redoStack,
  ): void => {
    if (command.patches.size === 0) return;
    const firstRetainedCommand = this.draftHistoryLocations.size === 0;
    if (this.soleDraftHistoryLineage !== undefined) {
      const soleLocation = this.draftHistoryLocations.get(this.soleDraftHistoryLineage);
      const soleCommand =
        soleLocation?.stack === "undo"
          ? undoStack[soleLocation.index]
          : soleLocation?.stack === "redo"
            ? redoStack[soleLocation.index]
            : undefined;
      if (soleCommand !== undefined) {
        for (const key of soleCommand.patches.keys()) {
          this.draftHistoryLineagesByCellKey.set(key, soleCommand.lineage);
        }
      }
      this.soleDraftHistoryLineage = undefined;
    }
    this.draftHistoryLocations.set(command.lineage, Object.freeze({ stack, index }));
    if (firstRetainedCommand) {
      this.soleDraftHistoryLineage = command.lineage;
    } else {
      for (const key of command.patches.keys()) {
        const lineages = this.draftHistoryLineagesByCellKey.get(key);
        if (lineages === undefined) this.draftHistoryLineagesByCellKey.set(key, command.lineage);
        else if (lineages instanceof Set) lineages.add(command.lineage);
        else if (lineages !== command.lineage) {
          this.draftHistoryLineagesByCellKey.set(key, new Set([lineages, command.lineage]));
        }
      }
    }
    if (stack === "undo") this.undoHistoryCount += 1;
    else this.redoHistoryCount += 1;
  };

  private readonly unregisterDraftHistoryCommand = (
    command: DraftHistoryCommand,
    retainActiveResolutionEvidence = false,
  ): void => {
    const location = this.draftHistoryLocations.get(command.lineage);
    if (location === undefined) return;
    const resolvedIds = this.resolvedDraftReviewIdsByLineage.get(command.lineage);
    const evictedResolutionIds = new Set<string>(
      resolvedIds === undefined
        ? []
        : typeof resolvedIds === "string"
          ? [resolvedIds]
          : resolvedIds,
    );
    const activeDrafts = this.draftStore.get();
    const releasedResolutionIds = new Set<string>();
    for (const id of evictedResolutionIds) {
      if (retainActiveResolutionEvidence && activeDrafts.has(id)) {
        this.setResolvedDraftReviewLineage(id, undefined);
      } else {
        this.clearResolvedDraftReviewEvidence(id);
        releasedResolutionIds.add(id);
      }
    }
    this.draftHistoryLocations.delete(command.lineage);
    if (this.soleDraftHistoryLineage === command.lineage) {
      this.soleDraftHistoryLineage = undefined;
    }
    for (const key of command.patches.keys()) {
      this.pendingDraftHistoryEvidenceKeys.add(key);
      const lineages = this.draftHistoryLineagesByCellKey.get(key);
      if (lineages instanceof Set) {
        lineages.delete(command.lineage);
        if (lineages.size === 0) this.draftHistoryLineagesByCellKey.delete(key);
        else if (lineages.size === 1) {
          this.draftHistoryLineagesByCellKey.set(key, lineages.values().next().value!);
        }
      } else if (lineages === command.lineage) this.draftHistoryLineagesByCellKey.delete(key);
    }
    if (location.stack === "undo") this.undoHistoryCount -= 1;
    else this.redoHistoryCount -= 1;
    for (const id of releasedResolutionIds) this.pendingReleasedResolutionIds.add(id);
  };

  private readonly rebuildDraftHistoryIndex = (
    undoStack: readonly DraftHistoryCommand[],
    redoStack: readonly DraftHistoryCommand[],
  ): void => {
    this.draftHistoryLocations.clear();
    this.draftHistoryLineagesByCellKey.clear();
    this.soleDraftHistoryLineage = undefined;
    this.undoHistoryCount = 0;
    this.redoHistoryCount = 0;
    for (let index = 0; index < undoStack.length; index += 1) {
      const command = undoStack[index];
      if (command !== undefined) {
        this.registerDraftHistoryCommand(command, "undo", index, undoStack, redoStack);
      }
    }
    for (let index = 0; index < redoStack.length; index += 1) {
      const command = redoStack[index];
      if (command !== undefined) {
        this.registerDraftHistoryCommand(command, "redo", index, undoStack, redoStack);
      }
    }
  };

  private readonly prepareDraftHistoryPush = (
    command: DraftHistoryCommand,
    nextUndoStack: readonly DraftHistoryCommand[],
  ): void => {
    for (const redoCommand of this.redoStack) this.unregisterDraftHistoryCommand(redoCommand);
    const evicted =
      this.undoStack.length >= BRUNO_TABLE_BATCH_HISTORY_LIMIT ? this.undoStack[0] : undefined;
    if (evicted !== undefined) this.unregisterDraftHistoryCommand(evicted, true);
    if (evicted !== undefined) {
      for (const [lineage, location] of this.draftHistoryLocations) {
        if (location.stack === "undo") {
          this.draftHistoryLocations.set(
            lineage,
            Object.freeze({ stack: "undo", index: location.index - 1 }),
          );
        }
      }
    }
    this.registerDraftHistoryCommand(command, "undo", nextUndoStack.length - 1);
  };

  private readonly getIndexedDraftHistoryLineages = (
    key: string,
    undoStack: readonly DraftHistoryCommand[],
    redoStack: readonly DraftHistoryCommand[],
  ): object | Set<object> | undefined => {
    if (this.soleDraftHistoryLineage !== undefined) {
      const location = this.draftHistoryLocations.get(this.soleDraftHistoryLineage);
      const command =
        location?.stack === "undo"
          ? undoStack[location.index]
          : location?.stack === "redo"
            ? redoStack[location.index]
            : undefined;
      return command?.patches.has(key) === true ? this.soleDraftHistoryLineage : undefined;
    }
    return this.draftHistoryLineagesByCellKey.get(key);
  };

  private readonly transformIndexedDraftHistoryCell = (
    undoStack: readonly DraftHistoryCommand[],
    redoStack: readonly DraftHistoryCommand[],
    key: string,
    transform: (entry: DraftEntry | undefined) => DraftEntry | undefined,
  ): Readonly<{
    readonly undoStack: readonly DraftHistoryCommand[];
    readonly redoStack: readonly DraftHistoryCommand[];
    readonly changed: boolean;
  }> => {
    const indexedLineages = this.getIndexedDraftHistoryLineages(key, undoStack, redoStack);
    if (indexedLineages === undefined) {
      return Object.freeze({ undoStack, redoStack, changed: false });
    }
    const lineages = indexedLineages instanceof Set ? indexedLineages : [indexedLineages];
    let nextUndoStack: DraftHistoryCommand[] | undefined;
    let nextRedoStack: DraftHistoryCommand[] | undefined;
    const transformedEntries = new WeakMap<DraftEntry, DraftEntry | undefined>();
    const transformEntry = (entry: DraftEntry | undefined): DraftEntry | undefined => {
      if (entry === undefined) return undefined;
      if (transformedEntries.has(entry)) return transformedEntries.get(entry);
      const transformed = transform(entry);
      transformedEntries.set(entry, transformed);
      return transformed;
    };
    for (const lineage of lineages) {
      const location = this.draftHistoryLocations.get(lineage);
      if (location === undefined) continue;
      const commands = location.stack === "undo" ? undoStack : redoStack;
      const command = commands[location.index];
      const patch = command?.patches.get(key);
      if (command === undefined || patch === undefined) continue;
      const before = transformEntry(patch.before);
      const after = transformEntry(patch.after);
      if (before === patch.before && after === patch.after) continue;
      const patches = command.patches.with(
        key,
        before === undefined && after === undefined
          ? undefined
          : Object.freeze({ ...patch, before, after }),
      );
      const nextCommand = Object.freeze({ lineage, patches });
      if (location.stack === "undo") {
        nextUndoStack ??= [...undoStack];
        nextUndoStack[location.index] = nextCommand;
      } else {
        nextRedoStack ??= [...redoStack];
        nextRedoStack[location.index] = nextCommand;
      }
      if (patches.has(key)) continue;
      if (indexedLineages instanceof Set) indexedLineages.delete(lineage);
      else if (this.soleDraftHistoryLineage !== lineage) {
        this.draftHistoryLineagesByCellKey.delete(key);
      }
      if (patches.size === 0) {
        this.draftHistoryLocations.delete(lineage);
        if (this.soleDraftHistoryLineage === lineage) this.soleDraftHistoryLineage = undefined;
        if (location.stack === "undo") this.undoHistoryCount -= 1;
        else this.redoHistoryCount -= 1;
      }
    }
    if (indexedLineages instanceof Set) {
      if (indexedLineages.size === 0) this.draftHistoryLineagesByCellKey.delete(key);
      else if (indexedLineages.size === 1) {
        this.draftHistoryLineagesByCellKey.set(key, indexedLineages.values().next().value!);
      }
    }
    return Object.freeze({
      undoStack: nextUndoStack ?? undoStack,
      redoStack: nextRedoStack ?? redoStack,
      changed: nextUndoStack !== undefined || nextRedoStack !== undefined,
    });
  };

  private readonly findIndexedDraftHistoryEntry = (key: string): DraftEntry | undefined => {
    const indexedLineages = this.getIndexedDraftHistoryLineages(
      key,
      this.undoStack,
      this.redoStack,
    );
    if (indexedLineages === undefined) return undefined;
    const lineages = indexedLineages instanceof Set ? indexedLineages : [indexedLineages];
    let redo: Readonly<{ readonly index: number; readonly entry: DraftEntry }> | undefined;
    let undo: Readonly<{ readonly index: number; readonly entry: DraftEntry }> | undefined;
    for (const lineage of lineages) {
      const location = this.draftHistoryLocations.get(lineage);
      if (location === undefined) continue;
      const command =
        location.stack === "undo" ? this.undoStack[location.index] : this.redoStack[location.index];
      const patch = command?.patches.get(key);
      const entry = patch?.after ?? patch?.before;
      if (entry === undefined) continue;
      if (location.stack === "redo") {
        if (redo === undefined || location.index > redo.index)
          redo = { index: location.index, entry };
      } else if (undo === undefined || location.index > undo.index) {
        undo = { index: location.index, entry };
      }
    }
    return redo?.entry ?? undo?.entry;
  };

  private readonly findIndexedReplayPatch = (key: string): DraftHistoryCellPatch | undefined => {
    const indexedLineages = this.getIndexedDraftHistoryLineages(
      key,
      this.undoStack,
      this.redoStack,
    );
    if (indexedLineages === undefined) return undefined;
    const lineages = indexedLineages instanceof Set ? indexedLineages : [indexedLineages];
    let redo:
      | Readonly<{ readonly index: number; readonly patch: DraftHistoryCellPatch }>
      | undefined;
    let undo:
      | Readonly<{ readonly index: number; readonly patch: DraftHistoryCellPatch }>
      | undefined;
    for (const lineage of lineages) {
      const location = this.draftHistoryLocations.get(lineage);
      if (location === undefined) continue;
      const command =
        location.stack === "undo" ? this.undoStack[location.index] : this.redoStack[location.index];
      const patch = command?.patches.get(key);
      if (patch === undefined) continue;
      if (location.stack === "redo") {
        if (redo === undefined || location.index < redo.index)
          redo = { index: location.index, patch };
      } else if (undo === undefined || location.index > undo.index) {
        undo = { index: location.index, patch };
      }
    }
    return redo?.patch ?? undo?.patch;
  };

  private readonly compactDraftHistoryForInteraction = (): void => {
    if (
      this.undoHistoryCount === this.undoStack.length &&
      this.redoHistoryCount === this.redoStack.length
    ) {
      return;
    }
    const undoStack = this.undoStack.filter((command) => command.patches.size > 0);
    const redoStack = this.redoStack.filter((command) => command.patches.size > 0);
    this.setDraftMemory(this.draftStore.get(), undoStack, redoStack, []);
  };

  private readonly setDraftMemory = (
    drafts: ReadonlyMap<string, DraftEntry>,
    undoStack: readonly DraftHistoryCommand[] = this.undoStack,
    redoStack: readonly DraftHistoryCommand[] = this.redoStack,
    affectedKeys: Iterable<string>,
    historyIndexPrepared = false,
    retainedHistoryPatches?: DraftHistoryPatchMap,
  ): void => {
    const previous = this.draftMemoryStore.get();
    const next = Object.freeze({
      drafts,
      undoStack: Object.freeze([...undoStack]),
      redoStack: Object.freeze([...redoStack]),
    });
    if (
      !historyIndexPrepared &&
      (undoStack !== previous.undoStack || redoStack !== previous.redoStack)
    ) {
      this.rebuildDraftHistoryIndex(next.undoStack, next.redoStack);
    }
    this.draftMemoryStore.setState(() => next);
    if (
      drafts.size === 0 &&
      next.undoStack.length === 0 &&
      next.redoStack.length === 0 &&
      this.resolvedDraftReviewIds.size === 0
    ) {
      this.draftEvidenceKeys.clear();
      this.draftKeysByRowId.clear();
      this.rowVersionBlockedRowIds.clear();
      this.draftHistoryLocations.clear();
      this.draftHistoryLineagesByCellKey.clear();
      this.soleDraftHistoryLineage = undefined;
      this.draftReviewProjectedRowsByRowId.clear();
      this.draftReviewProjectionHistoryByRowId.clear();
      this.pendingDraftHistoryEvidenceKeys.clear();
      this.undoHistoryCount = 0;
      this.redoHistoryCount = 0;
      this.flushReleasedResolutionPublications();
      return;
    }
    const hasResolvedDraftReviewEvidence = this.resolvedDraftReviewIds.size > 0;
    let resolvedEvidenceCandidates: Set<string> | undefined;
    if (retainedHistoryPatches === undefined) {
      for (const key of affectedKeys) {
        if (hasResolvedDraftReviewEvidence) {
          (resolvedEvidenceCandidates ??= new Set()).add(key);
        }
        this.syncDraftEvidenceKey(key, next);
      }
    } else {
      for (const patch of retainedHistoryPatches.values()) {
        if (hasResolvedDraftReviewEvidence) {
          (resolvedEvidenceCandidates ??= new Set()).add(patch.cellKey);
        }
        const entry = patch.after ?? patch.before;
        if (entry !== undefined) this.retainDraftEvidenceKey(patch.cellKey, entry.rowId);
      }
    }
    for (const key of this.pendingDraftHistoryEvidenceKeys) {
      if (hasResolvedDraftReviewEvidence) {
        (resolvedEvidenceCandidates ??= new Set()).add(key);
      }
      this.syncDraftEvidenceKey(key, next);
    }
    this.pendingDraftHistoryEvidenceKeys.clear();
    if (resolvedEvidenceCandidates !== undefined) {
      this.releaseOrphanedResolvedDraftReviewEvidence(next, resolvedEvidenceCandidates);
    }
    this.flushReleasedResolutionPublications();
  };

  private readonly revalidateHistoryEntry = (
    entry: DraftEntry | undefined,
  ): Readonly<{ readonly entry: DraftEntry | undefined; readonly prune: boolean }> => {
    if (entry === undefined) return Object.freeze({ entry: undefined, prune: false });
    if (entry.presentationColumn !== undefined) {
      return Object.freeze({
        entry: setDraftBlockedReason(entry, BRUNO_TABLE_CELL_EDIT_SCHEMA_MESSAGE),
        prune: false,
      });
    }
    const row = this.getRow(entry.rowId);
    const column = this.fieldColumnsById.get(entry.columnId);
    if (column === undefined) return Object.freeze({ entry: undefined, prune: true });
    if (typeof row !== "object" || row === null) {
      return Object.freeze({
        entry: setDraftBlockedReason(entry, BRUNO_TABLE_CELL_EDIT_ROW_MISSING_MESSAGE),
        prune: false,
      });
    }
    const source = this.readCanonicalSourceValue(entry.rowId, row, column);
    if (
      source._tag === "Success" &&
      safeEquivalentEditValue(column, entry.mine, source.value) === true
    ) {
      return Object.freeze({ entry: undefined, prune: true });
    }
    let rowVersionAvailable = true;
    let rowVersion: unknown;
    if (this.getRowVersion !== undefined) {
      try {
        rowVersion = this.getRowVersion(row);
      } catch {
        rowVersionAvailable = false;
      }
    }
    if (rowVersionAvailable) this.rowVersionBlockedRowIds.delete(entry.rowId);
    else this.rowVersionBlockedRowIds.add(entry.rowId);
    const baseEquivalent =
      source._tag === "Success"
        ? safeEquivalentEditValue(column, entry.base, source.value)
        : undefined;
    const blockedReason = !rowVersionAvailable
      ? BRUNO_TABLE_CELL_EDIT_ROW_VERSION_MESSAGE
      : source._tag !== "Success" ||
          baseEquivalent === undefined ||
          !isDraftEditable(column, row, entry.mine)
        ? BRUNO_TABLE_CELL_EDIT_PERMISSION_MESSAGE
        : undefined;
    const conflictReconciled =
      this.getRowVersion === undefined || !rowVersionAvailable
        ? entry
        : baseEquivalent === true
          ? clearDraftConflictEvidence(entry)
          : baseEquivalent === false && source._tag === "Success"
            ? setDraftConflictEvidence(
                entry,
                Object.freeze({ server: source.value, serverVersion: rowVersion, column }),
              )
            : entry;
    return Object.freeze({
      entry: setDraftBlockedReason(conflictReconciled, blockedReason),
      prune: false,
    });
  };

  private readonly publishDraftReview = (
    drafts: ReadonlyMap<string, DraftEntry>,
    changedKeys?: ReadonlySet<string>,
    serverRows?: ReadonlyMap<string, unknown>,
    canonicalSources?: ReadonlyMap<string, CanonicalSourceValue>,
    forceMembershipPublication = false,
  ): void => {
    if (this.draftReviewSubscriberCount === 0) return;
    const activeKey = this.hasActiveCandidateWork() ? this.activeCellKey : undefined;
    let projectionChangedRowIds: ReadonlySet<string> | undefined;
    const keys =
      changedKeys === undefined
        ? new Set([
            ...drafts.keys(),
            ...this.draftReviewRowsById.keys(),
            ...(activeKey === undefined ? [] : [activeKey]),
          ])
        : (() => {
            const changedRowIds = new Set<string>();
            for (const id of changedKeys) {
              const rowId =
                drafts.get(id)?.rowId ??
                this.resolvedDraftReviewEntriesById.get(id)?.rowId ??
                this.draftReviewRowsById.get(id)?.rowId ??
                parseCellKey(id)?.rowId;
              if (rowId !== undefined) changedRowIds.add(rowId);
            }
            projectionChangedRowIds = changedRowIds;
            if (changedRowIds.size === 0) return changedKeys;
            const expandedKeys = new Set(changedKeys);
            for (const id of iterateDraftEvidenceKeysByRowId(
              this.draftKeysByRowId,
              changedRowIds,
            )) {
              expandedKeys.add(id);
            }
            return expandedKeys;
          })();
    const projectedRowsPlan = this.createDraftReviewProjectedRows(drafts, keys, serverRows);
    const projectedRows = projectedRowsPlan.rows;
    let membershipChanged = forceMembershipPublication && keys.size > 0;
    let classificationChanged = false;
    for (const id of keys) {
      const draft = drafts.get(id) ?? this.resolvedDraftReviewEntriesById.get(id);
      const activeRow =
        activeKey === id
          ? this.createActiveCandidateReviewRow(id, draft, projectedRows.get(draft?.rowId ?? ""))
          : undefined;
      if (draft === undefined && activeRow === undefined) {
        classificationChanged = this.syncDraftReviewClassification(id) || classificationChanged;
        if (this.draftReviewRowsById.delete(id)) membershipChanged = true;
        this.draftReviewRowStoresById.delete(id);
        this.draftReviewEntriesById.delete(id);
        continue;
      }
      const previousSource = this.draftReviewRowsById.get(id);
      const previousStore = this.draftReviewRowStoresById.get(id);
      const previousRow = previousStore?.get();
      const nextRow =
        activeRow ??
        (draft === undefined
          ? undefined
          : this.createDraftReviewRow(
              id,
              draft,
              projectedRows.get(draft.rowId)?.serverCandidate,
              canonicalSources?.get(id),
              projectedRows.get(draft.rowId),
            ));
      if (nextRow === undefined) {
        classificationChanged = this.syncDraftReviewClassification(id) || classificationChanged;
        if (this.draftReviewRowsById.delete(id)) membershipChanged = true;
        this.draftReviewRowStoresById.delete(id);
        this.draftReviewEntriesById.delete(id);
        continue;
      }
      if (
        previousRow !== undefined &&
        activeRow === undefined &&
        projectionChangedRowIds?.has(nextRow.rowId) !== true &&
        this.draftReviewEntriesById.get(id) === draft &&
        previousRow.serverRow === nextRow.serverRow &&
        previousRow.column === nextRow.column
      ) {
        continue;
      }
      if (
        previousSource === undefined ||
        previousStore === undefined ||
        previousSource.rowId !== nextRow.rowId
      ) {
        const store = new Store(nextRow);
        const source: BrunoTableCellEditDraftReviewSourceRow = Object.freeze({
          kind: "bruno-table-cell-edit-draft-review-source",
          id,
          rowId: nextRow.rowId,
          get columnLabel() {
            return store.get().columnLabel;
          },
          baseText: "",
          selectionText: "",
          serverText: "",
          mineText: "",
          resolutionText: "",
          statusText: "",
          getSnapshot: () => store.get(),
          subscribe: (listener) => {
            const subscription = store.subscribe(listener);
            return () => subscription.unsubscribe();
          },
        });
        registerBrunoTableCellEditDraftReviewSource(source);
        this.draftReviewRowsById.set(id, source);
        this.draftReviewRowStoresById.set(id, store);
        membershipChanged = true;
      } else {
        previousStore.setState(() => nextRow);
      }
      if (draft === undefined) this.draftReviewEntriesById.delete(id);
      else this.draftReviewEntriesById.set(id, draft);
      classificationChanged =
        this.syncDraftReviewClassification(id, nextRow) || classificationChanged;
    }
    if (classificationChanged) this.publishDraftReviewClassification();
    if (membershipChanged) {
      const rows = Object.freeze(
        [
          ...drafts.keys(),
          ...[...this.resolvedDraftReviewEntriesById.keys()].filter((id) => !drafts.has(id)),
          ...(activeKey === undefined || drafts.has(activeKey) ? [] : [activeKey]),
        ].flatMap((id) => {
          const row = this.draftReviewRowsById.get(id);
          return row === undefined ? [] : [row];
        }),
      );
      this.draftReviewStore.setState(() => rows);
    }
    projectedRowsPlan.commit();
    this.releaseUnusedDraftReviewProjectedRows(drafts, projectionChangedRowIds);
  };

  private readonly syncDraftReviewClassification = (
    id: string,
    row?: BrunoTableCellEditDraftReviewRow,
  ): boolean => {
    const conflict = row?.conflict !== undefined;
    const blocked = row?.blockedReason !== undefined;
    let conflictChanged: boolean;
    if (conflict) {
      conflictChanged = !this.draftReviewConflictIds.has(id);
      if (conflictChanged) this.draftReviewConflictIds.add(id);
    } else {
      conflictChanged = this.draftReviewConflictIds.delete(id);
    }
    let blockedChanged: boolean;
    if (blocked) {
      blockedChanged = !this.draftReviewBlockedIds.has(id);
      if (blockedChanged) this.draftReviewBlockedIds.add(id);
    } else {
      blockedChanged = this.draftReviewBlockedIds.delete(id);
    }
    return conflictChanged || blockedChanged;
  };

  private readonly publishDraftReviewClassification = (): void => {
    this.draftReviewClassificationStore.setState(() =>
      Object.freeze({
        conflictIds: new Set(this.draftReviewConflictIds),
        blockedIds: new Set(this.draftReviewBlockedIds),
      }),
    );
  };

  private readonly clearDraftReviewClassification = (): void => {
    if (this.draftReviewConflictIds.size === 0 && this.draftReviewBlockedIds.size === 0) return;
    this.draftReviewConflictIds.clear();
    this.draftReviewBlockedIds.clear();
    this.draftReviewClassificationStore.setState(() => EMPTY_DRAFT_REVIEW_CLASSIFICATION);
  };

  private readonly releaseUnusedDraftReviewProjectedRows = (
    drafts: ReadonlyMap<string, DraftEntry>,
    affectedRowIds?: ReadonlySet<string>,
  ): void => {
    const rowIds =
      affectedRowIds ??
      new Set([
        ...this.draftReviewProjectionHistoryByRowId.keys(),
        ...this.draftReviewProjectedRowsByRowId.keys(),
      ]);
    for (const rowId of rowIds) {
      let retained = false;
      const rowKeys = this.draftKeysByRowId.get(rowId);
      const keys =
        rowKeys === undefined ? [] : typeof rowKeys === "string" ? [rowKeys] : rowKeys.values();
      for (const id of keys) {
        if (drafts.has(id) || this.resolvedDraftReviewEntriesById.has(id)) {
          retained = true;
          break;
        }
      }
      if (retained) continue;
      this.releaseDraftReviewProjectionHistory(rowId);
    }
  };

  private readonly releaseDraftReviewProjectionHistory = (rowId: string): void => {
    this.draftReviewProjectionHistoryByRowId.delete(rowId);
    this.draftReviewProjectedRowsByRowId.delete(rowId);
  };

  private readonly createDraftReviewProjectedRows = (
    drafts: ReadonlyMap<string, DraftEntry>,
    requestedIds?: ReadonlySet<string>,
    serverRows?: ReadonlyMap<string, unknown>,
  ): DraftReviewProjectedRowsPlan => {
    const requestedRowIds = new Set<string>();
    const entriesByRowId = new Map<string, Array<Readonly<{ id: string; entry: DraftEntry }>>>();
    const addEntry = (id: string, entry: DraftEntry): void => {
      const entries = entriesByRowId.get(entry.rowId) ?? [];
      entries.push({ id, entry });
      entriesByRowId.set(entry.rowId, entries);
    };
    if (requestedIds === undefined) {
      for (const [id, draft] of drafts) {
        requestedRowIds.add(draft.rowId);
        addEntry(id, draft);
      }
      for (const [id, entry] of this.resolvedDraftReviewEntriesById) {
        if (drafts.has(id)) continue;
        requestedRowIds.add(entry.rowId);
        addEntry(id, entry);
      }
    } else {
      for (const id of requestedIds) {
        const entry = drafts.get(id) ?? this.resolvedDraftReviewEntriesById.get(id);
        if (entry !== undefined) requestedRowIds.add(entry.rowId);
      }
      for (const rowId of requestedRowIds) {
        const indexedKeys = this.draftKeysByRowId.get(rowId);
        if (indexedKeys === undefined) continue;
        const keys = typeof indexedKeys === "string" ? [indexedKeys] : indexedKeys;
        for (const id of keys) {
          const entry = drafts.get(id) ?? this.resolvedDraftReviewEntriesById.get(id);
          if (entry !== undefined && entry.rowId === rowId) addEntry(id, entry);
        }
      }
    }
    const projectedRows = new Map<string, DraftReviewProjectedRow>();
    const mutations: DraftReviewProjectionMutation[] = [];
    for (const [rowId, entries] of entriesByRowId) {
      const authoritativeEntry = entries.find(({ id }) => serverRows?.has(id) === true);
      const serverCandidate =
        authoritativeEntry === undefined
          ? this.getRow(rowId)
          : serverRows?.get(authoritativeEntry.id);
      if (typeof serverCandidate !== "object" || serverCandidate === null) {
        projectedRows.set(
          rowId,
          Object.freeze({ available: false, row: undefined, serverCandidate }),
        );
        continue;
      }
      const sourceRow = serverCandidate;
      const patch: Record<string, unknown> = {};
      const columnsByField = new Map<string, CompiledFieldColumn>();
      let patchAvailable = true;
      for (const { id, entry } of entries) {
        const column = entry.presentationColumn ?? this.fieldColumnsById.get(entry.columnId);
        if (column === undefined) {
          patchAvailable = false;
          break;
        }
        const activeDraft = drafts.get(id);
        const value =
          activeDraft === undefined
            ? typeof serverCandidate === "object" && serverCandidate !== null
              ? this.readCanonicalSourceValue(rowId, serverCandidate, column)
              : ({ _tag: "Failure" } as const)
            : ({ _tag: "Success", value: activeDraft.mine } as const);
        if (value._tag !== "Success") {
          patchAvailable = false;
          break;
        }
        if (Object.hasOwn(patch, entry.field)) {
          const previousColumn = columnsByField.get(entry.field);
          if (
            previousColumn === undefined ||
            safeEquivalentEditValue(previousColumn, patch[entry.field], value.value) !== true ||
            safeEquivalentEditValue(column, value.value, patch[entry.field]) !== true
          ) {
            const [firstColumnId, secondColumnId] = [
              previousColumn?.columnId ?? "unknown",
              column.columnId,
            ].sort();
            throw new TypeError(
              `BrunoTable Edit Row projection cannot collate columns ${firstColumnId} and ${secondColumnId} for row ${rowId}, field ${entry.field}: exact values are not semantically equal.`,
            );
          }
          continue;
        }
        Object.defineProperty(patch, entry.field, {
          configurable: false,
          enumerable: true,
          value: value.value,
          writable: false,
        });
        columnsByField.set(entry.field, column);
      }
      if (!patchAvailable) {
        projectedRows.set(
          rowId,
          Object.freeze({ available: false, row: undefined, serverCandidate }),
        );
        continue;
      }
      const result = this.projectDraftReviewRow(
        rowId,
        sourceRow,
        Object.freeze(patch),
        serverCandidate,
      );
      projectedRows.set(rowId, result.projection);
      if (result.mutation !== undefined) mutations.push(result.mutation);
    }
    return Object.freeze({
      rows: projectedRows,
      commit: () => {
        for (const mutation of mutations) {
          if (mutation.kind === "withdraw") {
            this.draftReviewProjectedRowsByRowId.delete(mutation.rowId);
            continue;
          }
          mutation.entry.historicalProjectedRows.add(mutation.projectedRow);
          this.draftReviewProjectionHistoryByRowId.set(mutation.rowId, mutation.entry);
          if (this.draftReviewSubscriberCount > 0) {
            this.draftReviewProjectedRowsByRowId.set(mutation.rowId, mutation.entry);
          }
        }
      },
    });
  };

  private readonly projectDraftReviewRow = (
    rowId: string,
    sourceRow: object,
    patch: BrunoTableCellEditRowPatch,
    serverCandidate: unknown,
  ): DraftReviewProjectionResult => {
    const withoutMutation = (projection: DraftReviewProjectedRow): DraftReviewProjectionResult =>
      Object.freeze({ projection });
    const projector = this.projectEditRow;
    const getRowId = this.getProjectedRowId;
    if (projector === undefined || getRowId === undefined) {
      return withoutMutation(Object.freeze({ available: false, row: undefined, serverCandidate }));
    }
    let sourceRevision: unknown;
    try {
      sourceRevision = this.getRowVersion?.(sourceRow);
    } catch {
      return withoutMutation(Object.freeze({ available: false, row: undefined, serverCandidate }));
    }
    const cached = this.draftReviewProjectedRowsByRowId.get(rowId);
    if (
      cached !== undefined &&
      sameDraftReviewProjectionInput(
        cached,
        sourceRow,
        sourceRevision,
        this.editRowProjectorEpoch,
        patch,
      )
    ) {
      return withoutMutation(
        Object.freeze({ available: true, row: cached.projectedRow, serverCandidate }),
      );
    }
    const previousProjection = this.draftReviewProjectionHistoryByRowId.get(rowId);
    const inputsMatchPrevious =
      previousProjection !== undefined &&
      sameDraftReviewProjectionInput(
        previousProjection,
        sourceRow,
        sourceRevision,
        this.editRowProjectorEpoch,
        patch,
      );
    const rejectChangedProjection = (): DraftReviewProjectionResult | undefined => {
      if (previousProjection === undefined) {
        return undefined;
      }
      return Object.freeze({
        projection: Object.freeze({ available: false, row: undefined, serverCandidate }),
        mutation: Object.freeze({ kind: "withdraw", rowId }),
      });
    };
    let projected: unknown;
    try {
      projected = projector(Object.freeze({ row: sourceRow, patch, rowVersion: sourceRevision }));
    } catch (error) {
      const unavailable = rejectChangedProjection();
      if (unavailable !== undefined) return unavailable;
      throw error;
    }
    if (typeof projected !== "object" || projected === null) {
      const unavailable = rejectChangedProjection();
      if (unavailable !== undefined) return unavailable;
      throw new TypeError(
        `BrunoTable projectEditRow must return a non-null object for row ${rowId}.`,
      );
    }
    if (Reflect.ownKeys(patch).length > 0 && projected === sourceRow) {
      const unavailable = rejectChangedProjection();
      if (unavailable !== undefined) return unavailable;
      throw new TypeError(
        `BrunoTable projectEditRow must return a distinct row for non-empty patch: ${rowId}.`,
      );
    }
    // A changed source or patch must produce a fresh immutable Row reference. Reusing any result
    // from this row's retained review evidence could expose sibling data from an older source.
    if (
      previousProjection?.historicalProjectedRows.has(projected) === true &&
      !inputsMatchPrevious
    ) {
      const unavailable = rejectChangedProjection();
      if (unavailable !== undefined) return unavailable;
      throw new TypeError(
        `BrunoTable projectEditRow must return a fresh row when projection inputs change: ${rowId}.`,
      );
    }
    let projectedRowId: string;
    try {
      projectedRowId = getRowId(projected);
    } catch {
      const unavailable = rejectChangedProjection();
      if (unavailable !== undefined) return unavailable;
      throw new TypeError(`BrunoTable getRowId rejected the projected edit row: ${rowId}.`);
    }
    if (projectedRowId !== rowId) {
      const unavailable = rejectChangedProjection();
      if (unavailable !== undefined) return unavailable;
      throw new TypeError(
        `BrunoTable projectEditRow changed Row Identity from ${rowId} to ${projectedRowId}.`,
      );
    }
    const historicalProjectedRows =
      previousProjection?.historicalProjectedRows ?? new WeakSet<object>();
    const entry = Object.freeze({
      historicalProjectedRows,
      patch,
      projectorEpoch: this.editRowProjectorEpoch,
      projectedRow: projected,
      sourceRevision,
      sourceRow,
    });
    return Object.freeze({
      projection: Object.freeze({ available: true, row: projected, serverCandidate }),
      mutation: Object.freeze({ kind: "accept", rowId, entry, projectedRow: projected }),
    });
  };

  private readonly createDraftReviewRow = (
    id: string,
    draft: DraftEntry,
    serverCandidate: unknown,
    canonicalSource?: CanonicalSourceValue,
    projected?: DraftReviewProjectedRow,
  ): BrunoTableCellEditDraftReviewRow | undefined => {
    const serverRow =
      typeof serverCandidate === "object" && serverCandidate !== null ? serverCandidate : undefined;
    const column = draft.presentationColumn ?? this.fieldColumnsById.get(draft.columnId);
    if (column === undefined) return undefined;
    this.draftReviewVersion += 1;
    const reviewVersion = this.draftReviewVersion;
    const canonical =
      canonicalSource ?? this.readCanonicalSourceValue(draft.rowId, serverRow, column);
    const reviewRow: BrunoTableCellEditDraftReviewRow = Object.freeze({
      id,
      reviewVersion,
      rowId: draft.rowId,
      columnId: draft.columnId,
      field: draft.field,
      baseRow: draft.baseRow,
      expectedVersion: draft.expectedVersion,
      base: draft.base,
      mine: draft.mine,
      ...(draft.validationMessage === undefined
        ? {}
        : { validationMessage: draft.validationMessage }),
      ...(draft.conflict === undefined ? {} : { conflict: draft.conflict }),
      headerName: column.headerName,
      columnLabel: column.headerName,
      serverText: "",
      mineText: "",
      status:
        draft.blockedReason ??
        draft.validationMessage ??
        (draft.conflict === undefined ? "Draft" : "Conflict"),
      column,
      serverRow,
      projectedRow: projected?.row,
      projectedRowAvailable: projected?.available === true,
      serverNow: canonical._tag === "Success" ? canonical.value : undefined,
      serverValueAvailable: canonical._tag === "Success",
      blockedReason: draft.blockedReason,
    });
    return reviewRow;
  };

  private readonly createActiveCandidateReviewRow = (
    id: string,
    draft: DraftEntry | undefined,
    projected?: DraftReviewProjectedRow,
  ): BrunoTableCellEditDraftReviewRow | undefined => {
    const session = this.actor.getSnapshot().context.session;
    if (
      session === undefined ||
      !this.hasActiveCandidateWork() ||
      cellKey(session.rowId, session.column.columnId) !== id
    ) {
      return undefined;
    }
    const candidate = this.candidateStore.get();
    const candidateInvalid = session.invalidMessage !== undefined || candidate.nativeInvalid;
    const candidateBlockedReason = session.rowMissing
      ? BRUNO_TABLE_CELL_EDIT_ROW_MISSING_MESSAGE
      : (session.permissionMessage ?? session.rowVersionMessage);
    const candidateStatus =
      candidateBlockedReason ??
      session.invalidMessage ??
      (candidate.nativeInvalid ? "Enter a valid number." : "Active candidate");
    const activeDraft: DraftEntry = Object.freeze({
      rowId: session.rowId,
      columnId: session.column.columnId,
      field: session.column.field,
      baseRow: draft?.baseRow ?? session.baseRow,
      expectedVersion: draft?.expectedVersion ?? session.expectedVersion,
      base: draft?.base ?? session.baseValue,
      mine: draft?.mine ?? session.before,
      ...((draft?.blockedReason ?? candidateBlockedReason) === undefined
        ? {}
        : { blockedReason: draft?.blockedReason ?? candidateBlockedReason }),
    });
    const row = this.createDraftReviewRow(
      id,
      activeDraft,
      projected === undefined ? this.getRow(activeDraft.rowId) : projected.serverCandidate,
      undefined,
      projected,
    );
    if (row === undefined) return undefined;
    return Object.freeze({
      ...row,
      status: candidateStatus,
      candidateText: candidate.rawText,
      ...(candidateInvalid ? { candidateInvalid: true } : {}),
    });
  };

  private readonly reconcileDraftRows = (
    changedRowIds: ReadonlySet<string> | undefined,
    publishTraversalInvalidation: boolean,
    submittedConvergedKeys: ReadonlySet<string> = new Set<string>(),
    authoritativeRows?: ReadonlyMap<string, unknown>,
    candidateKeys?: ReadonlySet<string>,
  ): boolean => {
    const previousDrafts = this.draftStore.get();
    if (
      changedRowIds === undefined &&
      candidateKeys === undefined &&
      submittedConvergedKeys.size === 0 &&
      this.tryClearFullyConvergedDraftMemory(previousDrafts, publishTraversalInvalidation)
    ) {
      return true;
    }
    let nextDrafts: Map<string, DraftEntry> | undefined;
    let nextUndoStack = this.undoStack;
    let nextRedoStack = this.redoStack;
    const convergedKeys: string[] = [];
    const changedKeys: string[] = [];
    const reviewChangedKeys = new Set<string>();
    const reviewServerRows = new Map<string, unknown>();
    const rowVersionAvailability = new Map<string, boolean>();
    const rowVersions = new Map<string, unknown>();
    let visitedRowIds: Set<string> | undefined;
    const hasSaveLocks = this.saveLockedCellKeys.size > 0;
    const keys =
      candidateKeys !== undefined
        ? candidateKeys.values()
        : changedRowIds === undefined
          ? this.draftEvidenceKeys.values()
          : iterateDraftEvidenceKeysByRowId(this.draftKeysByRowId, changedRowIds);
    for (const key of keys) {
      const draft = previousDrafts.get(key);
      let reconciledDraft = draft;
      const representative = draft ?? this.findIndexedDraftHistoryEntry(key);
      if (representative === undefined) continue;
      if (submittedConvergedKeys.has(key)) {
        convergedKeys.push(key);
        continue;
      }
      const row = authoritativeRows?.has(representative.rowId)
        ? authoritativeRows.get(representative.rowId)
        : this.getRow(representative.rowId);
      if (this.draftReviewSubscriberCount > 0) {
        reviewServerRows.set(key, row);
        // A reported source-row publication may retain the same object reference
        // while changing its opaque Row Version. Re-evaluate the sparse review
        // projection so the row/revision cache, rather than reference identity,
        // remains authoritative.
        reviewChangedKeys.add(key);
      }
      const column = this.fieldColumnsById.get(representative.columnId);
      const saveLocked = hasSaveLocks && this.saveLockedCellKeys.has(key);
      const source =
        typeof row === "object" && row !== null && column !== undefined
          ? this.readCanonicalSourceValue(representative.rowId, row, column)
          : ({ _tag: "Failure" } as const);
      const replayPatch = draft === undefined ? this.findIndexedReplayPatch(key) : undefined;
      const currentMine = draft === undefined ? replayPatch?.authoredValue : draft.mine;
      const mineEquivalent =
        source._tag === "Success" &&
        column !== undefined &&
        (draft !== undefined || replayPatch !== undefined)
          ? Object.is(currentMine, source.value)
            ? true
            : safeEquivalentEditValue(column, currentMine, source.value)
          : undefined;
      if (typeof row === "object" && row !== null && column !== undefined) {
        if (!saveLocked && source._tag === "Success" && mineEquivalent === true) {
          convergedKeys.push(key);
          continue;
        }
        let rowVersionAvailable = rowVersionAvailability.get(representative.rowId);
        if (rowVersionAvailable === undefined) {
          rowVersionAvailable = true;
          if (this.getRowVersion !== undefined) {
            try {
              rowVersions.set(representative.rowId, this.getRowVersion(row));
            } catch {
              rowVersionAvailable = false;
            }
          }
          rowVersionAvailability.set(representative.rowId, rowVersionAvailable);
        }
      }
      (visitedRowIds ??= new Set()).add(representative.rowId);
      const reconcileEntry = (entry: DraftEntry | undefined): DraftEntry | undefined => {
        if (entry === undefined) return undefined;
        let nextEntry = entry;
        let blockedReason: string | undefined;
        if (entry.presentationColumn !== undefined) {
          blockedReason = BRUNO_TABLE_CELL_EDIT_SCHEMA_MESSAGE;
        } else if (typeof row !== "object" || row === null) {
          blockedReason = BRUNO_TABLE_CELL_EDIT_ROW_MISSING_MESSAGE;
        } else if (column === undefined) {
          blockedReason = BRUNO_TABLE_CELL_EDIT_PERMISSION_MESSAGE;
        } else {
          const baseEquivalent =
            source._tag === "Success"
              ? safeEquivalentEditValue(column, entry.base, source.value)
              : undefined;
          const rowVersionAvailable = rowVersionAvailability.get(entry.rowId) !== false;
          if (!saveLocked && baseEquivalent === true) {
            nextEntry = clearDraftConflictEvidence(entry) ?? entry;
          } else if (
            !saveLocked &&
            baseEquivalent === false &&
            source._tag === "Success" &&
            rowVersionAvailable &&
            this.getRowVersion !== undefined
          ) {
            nextEntry =
              setDraftConflictEvidence(
                entry,
                Object.freeze({
                  server: source.value,
                  serverVersion: rowVersions.get(entry.rowId),
                  column,
                }),
              ) ?? entry;
          }
          if (!rowVersionAvailable) {
            blockedReason = BRUNO_TABLE_CELL_EDIT_ROW_VERSION_MESSAGE;
          } else if (
            source._tag !== "Success" ||
            baseEquivalent === undefined ||
            !isDraftEditable(column, row, entry.mine)
          ) {
            blockedReason = BRUNO_TABLE_CELL_EDIT_PERMISSION_MESSAGE;
          }
        }
        return setDraftBlockedReason(nextEntry, blockedReason);
      };
      const nextDraft = reconcileEntry(reconciledDraft);
      const history = this.transformIndexedDraftHistoryCell(
        nextUndoStack,
        nextRedoStack,
        key,
        reconcileEntry,
      );
      nextUndoStack = history.undoStack;
      nextRedoStack = history.redoStack;
      if (nextDraft !== draft) {
        nextDrafts ??= new Map(previousDrafts);
        if (nextDraft === undefined) nextDrafts.delete(key);
        else nextDrafts.set(key, nextDraft);
        changedKeys.push(key);
      } else if (history.changed) {
        changedKeys.push(key);
      }
    }
    if (this.draftReviewSubscriberCount > 0) {
      const resolvedKeys =
        candidateKeys ??
        (changedRowIds === undefined
          ? this.resolvedDraftReviewEntriesById.keys()
          : iterateDraftEvidenceKeysByRowId(this.draftKeysByRowId, changedRowIds));
      for (const key of resolvedKeys) {
        const resolved = this.resolvedDraftReviewEntriesById.get(key);
        if (resolved === undefined) continue;
        reviewChangedKeys.add(key);
        const serverRow = authoritativeRows?.get(resolved.rowId) ?? this.getRow(resolved.rowId);
        reviewServerRows.set(key, serverRow);
      }
    }
    for (const rowId of visitedRowIds ?? []) {
      if (rowVersionAvailability.get(rowId) === false) this.rowVersionBlockedRowIds.add(rowId);
      else this.rowVersionBlockedRowIds.delete(rowId);
    }
    if (this.batchSaveOperationIds.size > 0) {
      for (const key of convergedKeys) {
        const operationId = this.saveLockedCellKeys.get(key);
        if (operationId === undefined || !this.batchSaveOperationIds.has(operationId)) continue;
        const operationKeys =
          this.pendingConvergedCellKeysByOperation.get(operationId) ?? new Set<string>();
        operationKeys.add(key);
        this.pendingConvergedCellKeysByOperation.set(operationId, operationKeys);
      }
    }
    if (
      nextDrafts === undefined &&
      nextUndoStack === this.undoStack &&
      nextRedoStack === this.redoStack &&
      convergedKeys.length === 0
    ) {
      if (reviewChangedKeys.size > 0) {
        this.publishDraftReview(previousDrafts, reviewChangedKeys, reviewServerRows);
      }
      return false;
    }
    const allRetainedEvidenceConverged =
      changedRowIds === undefined &&
      candidateKeys === undefined &&
      this.resolvedDraftReviewIds.size === 0 &&
      convergedKeys.length > 0 &&
      convergedKeys.length === this.draftEvidenceKeys.size;
    const converged = allRetainedEvidenceConverged ? undefined : new Set(convergedKeys);
    if (allRetainedEvidenceConverged) nextDrafts = new Map();
    else {
      nextDrafts ??= new Map(previousDrafts);
      for (const key of converged ?? []) nextDrafts.delete(key);
    }
    if (!allRetainedEvidenceConverged) {
      for (const key of converged ?? []) {
        const history = this.transformIndexedDraftHistoryCell(
          nextUndoStack,
          nextRedoStack,
          key,
          () => undefined,
        );
        nextUndoStack = history.undoStack;
        nextRedoStack = history.redoStack;
      }
    }
    const finalUndoStack = allRetainedEvidenceConverged ? Object.freeze([]) : nextUndoStack;
    const finalRedoStack = allRetainedEvidenceConverged ? Object.freeze([]) : nextRedoStack;
    if (allRetainedEvidenceConverged) {
      this.blockedDraftKeys.clear();
      this.validationDraftKeys.clear();
      this.conflictDraftKeys.clear();
    } else {
      for (const key of converged ?? []) this.syncBlockedDraftKey(key, undefined);
      for (const key of changedKeys) this.syncBlockedDraftKey(key, nextDrafts.get(key));
    }
    const affectedKeys =
      allRetainedEvidenceConverged || convergedKeys.length === 0
        ? changedKeys
        : [...convergedKeys, ...changedKeys];
    batch(() => {
      this.setDraftMemory(nextDrafts, finalUndoStack, finalRedoStack, affectedKeys, true);
      if (this.draftReviewSubscriberCount > 0) {
        this.publishDraftReview(
          nextDrafts,
          new Set([...affectedKeys, ...reviewChangedKeys]),
          reviewServerRows,
        );
      }
      if (allRetainedEvidenceConverged && changedRowIds === undefined) {
        this.traversalIndex.reconcileRows(undefined);
        for (const key of this.cellStores.keys()) this.publishCell(key, nextDrafts);
      } else {
        for (const key of affectedKeys) {
          this.invalidateDraftCell(key, false);
          this.publishCell(key, nextDrafts);
        }
      }
      this.publishActivitySnapshot();
    });
    if (publishTraversalInvalidation) this.publishTraversalInvalidation();
    if (allRetainedEvidenceConverged) {
      for (const key of this.cellStores.keys()) this.releaseUnusedCellStore(key);
    } else {
      for (const key of affectedKeys) this.releaseUnusedCellStore(key);
    }
    return affectedKeys.length > 0 || allRetainedEvidenceConverged;
  };

  private readonly tryClearFullyConvergedDraftMemory = (
    previousDrafts: ReadonlyMap<string, DraftEntry>,
    publishTraversalInvalidation: boolean,
  ): boolean => {
    if (
      previousDrafts.size === 0 ||
      previousDrafts.size !== this.draftEvidenceKeys.size ||
      this.resolvedDraftReviewIds.size > 0 ||
      this.draftReviewSubscriberCount > 0 ||
      this.saveLockedCellKeys.size > 0
    ) {
      return false;
    }
    for (const [key, draft] of previousDrafts) {
      if (!this.draftEvidenceKeys.has(key)) return false;
      const column = this.fieldColumnsById.get(draft.columnId);
      const row = this.getRow(draft.rowId);
      if (column === undefined || typeof row !== "object" || row === null) return false;
      if (!this.isCanonicalSourceEquivalent(draft.rowId, row, column, draft.mine)) {
        return false;
      }
    }
    const nextDrafts = new Map<string, DraftEntry>();
    this.blockedDraftKeys.clear();
    this.validationDraftKeys.clear();
    this.conflictDraftKeys.clear();
    batch(() => {
      this.setDraftMemory(nextDrafts, [], [], [], true);
      this.traversalIndex.reconcileRows(undefined);
      for (const key of this.cellStores.keys()) this.publishCell(key, nextDrafts);
      this.publishActivitySnapshot();
    });
    if (publishTraversalInvalidation) this.publishTraversalInvalidation();
    for (const key of this.cellStores.keys()) this.releaseUnusedCellStore(key);
    return true;
  };

  private readonly syncBlockedDraftKey = (key: string, draft: DraftEntry | undefined): void => {
    if (draft?.blockedReason === undefined) {
      if (this.blockedDraftKeys.size > 0) this.blockedDraftKeys.delete(key);
    } else this.blockedDraftKeys.add(key);
    if (draft?.validationMessage === undefined) {
      if (this.validationDraftKeys.size > 0) this.validationDraftKeys.delete(key);
    } else this.validationDraftKeys.add(key);
    if (draft?.conflict === undefined) {
      if (this.conflictDraftKeys.size > 0) this.conflictDraftKeys.delete(key);
    } else this.conflictDraftKeys.add(key);
  };

  private readonly setResolvedDraftReviewLineage = (
    id: string,
    lineage: object | undefined,
  ): void => {
    const previous = this.resolvedDraftReviewLineagesById.get(id);
    if (previous === lineage) return;
    if (previous !== undefined) {
      const ids = this.resolvedDraftReviewIdsByLineage.get(previous);
      if (typeof ids === "string") {
        if (ids === id) this.resolvedDraftReviewIdsByLineage.delete(previous);
      } else {
        ids?.delete(id);
        if (ids?.size === 0) this.resolvedDraftReviewIdsByLineage.delete(previous);
        else if (ids?.size === 1) {
          this.resolvedDraftReviewIdsByLineage.set(previous, ids.values().next().value!);
        }
      }
    }
    if (lineage === undefined) {
      this.resolvedDraftReviewLineagesById.delete(id);
      return;
    }
    this.resolvedDraftReviewLineagesById.set(id, lineage);
    const ids = this.resolvedDraftReviewIdsByLineage.get(lineage);
    if (ids === undefined) this.resolvedDraftReviewIdsByLineage.set(lineage, id);
    else if (typeof ids === "string") {
      if (ids !== id) this.resolvedDraftReviewIdsByLineage.set(lineage, new Set([ids, id]));
    } else ids.add(id);
  };

  private readonly clearResolvedDraftReviewEvidence = (id: string): void => {
    this.resolvedDraftReviewEntriesById.delete(id);
    this.resolvedDraftReviewIds.delete(id);
    this.setResolvedDraftReviewLineage(id, undefined);
  };

  private readonly clearAllResolvedDraftReviewEvidence = (): void => {
    this.resolvedDraftReviewEntriesById.clear();
    this.resolvedDraftReviewIds.clear();
    this.resolvedDraftReviewLineagesById.clear();
    this.resolvedDraftReviewIdsByLineage.clear();
  };

  private readonly releaseOrphanedResolvedDraftReviewEvidence = (
    memory: DraftMemoryState,
    candidateIds: Iterable<string>,
  ): void => {
    for (const id of candidateIds) {
      if (!this.resolvedDraftReviewIds.has(id)) continue;
      if (memory.drafts.has(id)) continue;
      const lineage = this.resolvedDraftReviewLineagesById.get(id);
      if (lineage === undefined && this.resolvedDraftReviewEntriesById.has(id)) continue;
      if (lineage !== undefined && this.draftHistoryLocations.has(lineage)) continue;
      this.clearResolvedDraftReviewEvidence(id);
      this.pendingReleasedResolutionIds.add(id);
      this.syncDraftEvidenceKey(id, memory);
    }
  };

  private readonly flushReleasedResolutionPublications = (): void => {
    if (this.pendingReleasedResolutionIds.size === 0) return;
    const released = new Set(this.pendingReleasedResolutionIds);
    this.pendingReleasedResolutionIds.clear();
    this.retainedResolutionPublicationStore.setState(() => released);
  };

  private readonly syncDraftEvidenceKey = (key: string, memory: DraftMemoryState): void => {
    const draft = memory.drafts.get(key);
    const retained =
      draft !== undefined ||
      this.resolvedDraftReviewIds.has(key) ||
      this.getIndexedDraftHistoryLineages(key, memory.undoStack, memory.redoStack) !== undefined;
    const wasRetained = this.draftEvidenceKeys.has(key);
    if (retained === wasRetained) return;
    const rowId = draft?.rowId ?? parseCellKey(key)?.rowId;
    if (rowId === undefined) return;
    if (retained) {
      this.draftEvidenceKeys.add(key);
      const rowKeys = this.draftKeysByRowId.get(rowId);
      if (rowKeys === undefined) this.draftKeysByRowId.set(rowId, key);
      else if (typeof rowKeys === "string") {
        if (rowKeys !== key) this.draftKeysByRowId.set(rowId, new Set([rowKeys, key]));
      } else rowKeys.add(key);
      return;
    }
    this.draftEvidenceKeys.delete(key);
    const rowKeys = this.draftKeysByRowId.get(rowId);
    if (typeof rowKeys === "string") {
      if (rowKeys === key) {
        this.draftKeysByRowId.delete(rowId);
        this.rowVersionBlockedRowIds.delete(rowId);
        this.releaseDraftReviewProjectionHistory(rowId);
      }
      return;
    }
    rowKeys?.delete(key);
    if (rowKeys?.size === 0) {
      this.draftKeysByRowId.delete(rowId);
      this.rowVersionBlockedRowIds.delete(rowId);
      this.releaseDraftReviewProjectionHistory(rowId);
    } else if (rowKeys?.size === 1) {
      const remaining = rowKeys.values().next().value;
      if (remaining !== undefined) this.draftKeysByRowId.set(rowId, remaining);
    }
  };

  private readonly retainDraftEvidenceKey = (key: string, rowId: string): void => {
    if (this.draftEvidenceKeys.has(key)) return;
    this.draftEvidenceKeys.add(key);
    const rowKeys = this.draftKeysByRowId.get(rowId);
    if (rowKeys === undefined) this.draftKeysByRowId.set(rowId, key);
    else if (typeof rowKeys === "string") {
      if (rowKeys !== key) this.draftKeysByRowId.set(rowId, new Set([rowKeys, key]));
    } else rowKeys.add(key);
  };

  private readonly getCellProjection = (key: string): BrunoTableCellEditProjection => {
    const store = this.cellStores.get(key);
    if (store !== undefined) return store.get();
    return this.createCellProjection(key);
  };

  private readonly isSaveLocked = (rowId: string, columnId: string): boolean =>
    this.batchSaveLockOperationId !== undefined ||
    this.saveLockedCellKeys.has(cellKey(rowId, columnId));

  private readonly createCellProjection = (
    key: string,
    drafts = this.draftStore.get(),
  ): BrunoTableCellEditProjection => {
    const draft = drafts.get(key);
    const acceptedOverlayEntry = this.acceptedOverlays.get(key);
    const savePending = this.saveLockedCellKeys.has(key);
    const saveFailed = this.rejectedCellKeys.has(key);
    const saveSucceeded = this.successFlashOperationByKey.has(key);
    if (this.activeCellKey !== key)
      return acceptedOverlayEntry !== undefined
        ? Object.freeze({
            active: false,
            hasDraft: false,
            hasAcceptedOverlay: true,
            ...(savePending ? { savePending: true } : {}),
            ...(saveFailed ? { saveFailed: true } : {}),
            ...(saveSucceeded ? { saveSucceeded: true } : {}),
            acceptedOverlay: acceptedOverlayEntry.after,
            ...(acceptedOverlayEntry.valueAuthority.presentationColumn === undefined
              ? {}
              : {
                  acceptedOverlayPresentationColumn:
                    acceptedOverlayEntry.valueAuthority.presentationColumn,
                }),
          })
        : draft === undefined && !savePending && !saveFailed && !saveSucceeded
          ? IDLE_CELL
          : draft === undefined
            ? Object.freeze({
                active: false,
                hasDraft: false,
                ...(savePending ? { savePending: true } : {}),
                ...(saveFailed ? { saveFailed: true } : {}),
                ...(saveSucceeded ? { saveSucceeded: true } : {}),
              })
            : savePending || saveFailed || saveSucceeded
              ? Object.freeze({
                  active: false,
                  hasDraft: true,
                  ...(draft.conflict === undefined ? {} : { conflicted: true }),
                  ...(draft.blockedReason === undefined
                    ? {}
                    : { blockedReason: draft.blockedReason }),
                  ...(savePending ? { savePending: true } : {}),
                  ...(saveFailed ? { saveFailed: true } : {}),
                  ...(saveSucceeded ? { saveSucceeded: true } : {}),
                  draft: draft.mine,
                  ...(draft.presentationColumn === undefined
                    ? {}
                    : { draftPresentationColumn: draft.presentationColumn }),
                })
              : this.getDraftProjection(draft);
    return Object.freeze({
      active: true,
      hasDraft: draft !== undefined,
      ...(draft === undefined ? {} : { draft: draft.mine }),
      ...(draft?.conflict === undefined ? {} : { conflicted: true }),
      ...(draft?.blockedReason === undefined ? {} : { blockedReason: draft.blockedReason }),
      ...(draft?.presentationColumn === undefined
        ? {}
        : { draftPresentationColumn: draft.presentationColumn }),
      ...(acceptedOverlayEntry === undefined
        ? {}
        : {
            hasAcceptedOverlay: true,
            acceptedOverlay: acceptedOverlayEntry.after,
            ...(acceptedOverlayEntry.valueAuthority.presentationColumn === undefined
              ? {}
              : {
                  acceptedOverlayPresentationColumn:
                    acceptedOverlayEntry.valueAuthority.presentationColumn,
                }),
          }),
      ...(savePending ? { savePending: true } : {}),
      ...(saveFailed ? { saveFailed: true } : {}),
      ...(saveSucceeded ? { saveSucceeded: true } : {}),
    });
  };

  private readonly getDraftProjection = (draft: DraftEntry): BrunoTableCellEditProjection => {
    const cached = this.draftProjectionCache.get(draft);
    if (cached !== undefined) return cached;
    const projection = Object.freeze({
      active: false,
      hasDraft: true,
      ...(draft.conflict === undefined ? {} : { conflicted: true }),
      ...(draft.blockedReason === undefined ? {} : { blockedReason: draft.blockedReason }),
      draft: draft.mine,
      ...(draft.presentationColumn === undefined
        ? {}
        : { draftPresentationColumn: draft.presentationColumn }),
    });
    this.draftProjectionCache.set(draft, projection);
    return projection;
  };

  private readonly installCellStore = (key: string): Store<BrunoTableCellEditProjection> => {
    const store = new Store(this.createCellProjection(key));
    this.cellStores.set(key, store);
    return store;
  };

  private readonly publishCell = (key: string, drafts: ReadonlyMap<string, DraftEntry>): void => {
    const store = this.cellStores.get(key);
    if (store === undefined) return;
    const next = this.createCellProjection(key, drafts);
    const previous = store.get();
    if (
      previous.active === next.active &&
      previous.hasDraft === next.hasDraft &&
      previous.conflicted === next.conflicted &&
      previous.blockedReason === next.blockedReason &&
      previous.hasAcceptedOverlay === next.hasAcceptedOverlay &&
      previous.savePending === next.savePending &&
      previous.saveFailed === next.saveFailed &&
      previous.saveSucceeded === next.saveSucceeded &&
      Object.is(previous.draft, next.draft) &&
      Object.is(previous.acceptedOverlay, next.acceptedOverlay) &&
      previous.acceptedOverlayPresentationColumn === next.acceptedOverlayPresentationColumn &&
      previous.draftPresentationColumn === next.draftPresentationColumn
    ) {
      return;
    }
    store.setState(() => next);
  };

  private readonly reconcileAcceptedOverlays = (
    changedRowIds: ReadonlySet<string> | undefined,
  ): boolean => {
    if (this.acceptedOverlays.size === 0 || !this.isSourceAuthoritative()) return false;
    const keysToVisit =
      changedRowIds === undefined
        ? [...this.acceptedOverlays.keys()]
        : [...changedRowIds].flatMap((rowId) => [
            ...(this.acceptedOverlayKeysByRowId.get(rowId) ?? []),
          ]);
    let next: Map<string, AcceptedOverlayEntry> | undefined;
    const changedKeys = new Set<string>();
    const changedOperations = new Set<string>();
    const removedCountsByOperation = new Map<string, number>();
    const reconciledRowsByOperation = new Map<string, Set<string>>();
    for (const key of keysToVisit) {
      const overlay = this.acceptedOverlays.get(key);
      if (overlay === undefined) continue;
      const row = this.getRow(overlay.rowId);
      let reconciled = typeof row !== "object" || row === null;
      if (typeof row === "object" && row !== null) {
        const source = this.readSubmittedSourceValue(row, overlay.valueAuthority);
        let rowVersion: unknown;
        let rowVersionAvailable = false;
        try {
          const getRowVersion = this.rowVersionExtractorsByOperation.has(overlay.operationId)
            ? this.rowVersionExtractorsByOperation.get(overlay.operationId)
            : this.getRowVersion;
          rowVersion = getRowVersion?.(row);
          rowVersionAvailable = getRowVersion !== undefined;
        } catch {
          rowVersionAvailable = false;
        }
        reconciled =
          (source._tag === "Success" &&
            safeEquivalentEditValues(
              overlay.valueAuthority.equivalent,
              overlay.after,
              source.value,
            ) === true) ||
          (rowVersionAvailable && !Object.is(rowVersion, overlay.expectedVersion));
      }
      if (!reconciled) continue;
      next ??= new Map(this.acceptedOverlays);
      next.delete(key);
      changedKeys.add(key);
      changedOperations.add(overlay.operationId);
      removedCountsByOperation.set(
        overlay.operationId,
        (removedCountsByOperation.get(overlay.operationId) ?? 0) + 1,
      );
      const rowKeys = this.acceptedOverlayKeysByRowId.get(overlay.rowId);
      rowKeys?.delete(key);
      if (rowKeys?.size === 0) this.acceptedOverlayKeysByRowId.delete(overlay.rowId);
      const operationRows = reconciledRowsByOperation.get(overlay.operationId) ?? new Set<string>();
      operationRows.add(overlay.rowId);
      reconciledRowsByOperation.set(overlay.operationId, operationRows);
      const rowCounts = this.acceptedOverlayCountsByOperationRow.get(overlay.operationId);
      const rowCount = Math.max(0, (rowCounts?.get(overlay.rowId) ?? 0) - 1);
      if (rowCount === 0) rowCounts?.delete(overlay.rowId);
      else rowCounts?.set(overlay.rowId, rowCount);
    }
    if (next === undefined) return false;
    this.acceptedOverlays = next;
    for (const operationId of changedOperations) {
      const count = Math.max(
        0,
        (this.acceptedOverlayCountsByOperation.get(operationId) ?? 0) -
          (removedCountsByOperation.get(operationId) ?? 0),
      );
      this.acceptedOverlayCountsByOperation.set(operationId, count);
    }
    const releasedImmediateRowIds = new Set<string>();
    for (const [operationId, rowIds] of reconciledRowsByOperation) {
      if (this.batchSaveOperationIds.has(operationId)) continue;
      for (const rowId of rowIds) {
        if ((this.acceptedOverlayCountsByOperationRow.get(operationId)?.get(rowId) ?? 0) > 0) {
          continue;
        }
        const locksByRow = this.saveLockedCellKeysByOperationRow.get(operationId);
        for (const key of locksByRow?.get(rowId) ?? []) {
          this.saveLockedCellKeys.delete(key);
          changedKeys.add(key);
          releasedImmediateRowIds.add(rowId);
        }
        locksByRow?.delete(rowId);
        this.removePendingOperationRows(operationId, [rowId]);
      }
    }
    batch(() => {
      for (const operationId of changedOperations) {
        const count = this.acceptedOverlayCountsByOperation.get(operationId) ?? 0;
        this.acceptedOverlayCountStoresByOperation.get(operationId)?.setState(() => count);
      }
      for (const key of changedKeys) this.publishCell(key, this.draftStore.get());
    });
    if (releasedImmediateRowIds.size > 0) {
      this.traversalIndex.reconcileRows(releasedImmediateRowIds);
      this.publishTraversalInvalidation();
    }
    for (const key of changedKeys) this.releaseUnusedCellStore(key);
    return true;
  };

  private readonly reconcileRejectedOperations = (
    changedRowIds: ReadonlySet<string> | undefined,
  ): boolean => {
    if (this.rejectedOperations.size === 0 || !this.isSourceAuthoritative()) return false;
    const next = new Map(this.rejectedOperations);
    const changedKeys = new Set<string>();
    const changedOperationIds = new Set<string>();
    const removedOperationIds = new Set<string>();
    const removedEvidenceByOperation = new Map<string, AcceptedOverlayEntry[]>();
    const convergedBatchKeys = new Set<string>();
    let changed = false;
    const changedRowsByOperation = new Map<string, Set<string>>();
    if (changedRowIds !== undefined) {
      for (const rowId of changedRowIds) {
        for (const operationId of this.rejectedOperationIdsByRowId.get(rowId) ?? []) {
          const rowIds = changedRowsByOperation.get(operationId) ?? new Set<string>();
          rowIds.add(rowId);
          changedRowsByOperation.set(operationId, rowIds);
        }
      }
    }
    const operationIds =
      changedRowIds === undefined ? this.rejectedOperations.keys() : changedRowsByOperation.keys();
    for (const operationId of operationIds) {
      const evidenceByRow = this.rejectedOperations.get(operationId);
      if (evidenceByRow === undefined) continue;
      let operationChanged = false;
      const convergedKeys = new Set<string>();
      const rowIds = changedRowsByOperation.get(operationId) ?? evidenceByRow.keys();
      for (const rowId of rowIds) {
        const evidence = evidenceByRow.get(rowId);
        if (evidence === undefined) continue;
        const remaining: AcceptedOverlayEntry[] = [];
        const reconciled: AcceptedOverlayEntry[] = [];
        const valueConverged: AcceptedOverlayEntry[] = [];
        const row = this.getRow(rowId);
        const rowMissing = typeof row !== "object" || row === null;
        for (const entry of evidence) {
          const source = this.readSubmittedSourceValue(row, entry.valueAuthority);
          const matches =
            source._tag === "Success" &&
            safeEquivalentEditValues(entry.valueAuthority.equivalent, entry.after, source.value) ===
              true;
          if (rowMissing || matches) {
            reconciled.push(entry);
            if (matches) valueConverged.push(entry);
          } else {
            remaining.push(entry);
          }
        }
        if (reconciled.length === 0) continue;
        if (remaining.length === 0) {
          evidenceByRow.delete(rowId);
          this.removeRejectedOperationRows(operationId, [rowId]);
        } else {
          evidenceByRow.set(rowId, Object.freeze(remaining));
        }
        operationChanged = true;
        this.removeRejectedOperationCellKeys(operationId, reconciled, changedKeys);
        const operationRemoved = removedEvidenceByOperation.get(operationId) ?? [];
        operationRemoved.push(...reconciled);
        removedEvidenceByOperation.set(operationId, operationRemoved);
        for (const entry of valueConverged) {
          const key = cellKey(entry.rowId, entry.columnId);
          convergedKeys.add(key);
          const currentDraft = this.draftStore.get().get(key);
          if (
            this.rejectedBatchOperationIds.has(operationId) &&
            currentDraft !== undefined &&
            safeEquivalentEditValues(
              entry.valueAuthority.equivalent,
              currentDraft.mine,
              entry.after,
            ) === true
          ) {
            convergedBatchKeys.add(key);
          }
        }
      }
      if (!operationChanged) continue;
      if (convergedKeys.size > 0) this.startSuccessFlash(operationId, convergedKeys);
      if (evidenceByRow.size === 0) {
        next.delete(operationId);
        removedOperationIds.add(operationId);
        this.rejectedBatchOperationIds.delete(operationId);
        this.rejectedCellPresentationDeadlinesByOperation.delete(operationId);
      }
      changedOperationIds.add(operationId);
      changed = true;
    }
    if (changed) {
      this.rejectedOperations = next;
      for (const [operationId, removed] of removedEvidenceByOperation) {
        this.removeRejectedOperationCellCount(operationId, removed.length);
      }
      batch(() => {
        for (const operationId of changedOperationIds) {
          this.publishRejectedOperation(
            operationId,
            removedEvidenceByOperation.get(operationId) ?? [],
          );
        }
        for (const key of changedKeys) this.publishCell(key, this.draftStore.get());
      });
      for (const operationId of removedOperationIds) {
        this.rejectedOperationStores.delete(operationId);
      }
      for (const key of changedKeys) this.releaseUnusedCellStore(key);
    }
    const draftsChanged =
      convergedBatchKeys.size > 0 &&
      this.reconcileDraftRows(changedRowIds, false, convergedBatchKeys);
    return changed || draftsChanged;
  };

  private readonly removeRejectedOperationRows = (
    operationId: string,
    rowIds: Iterable<string>,
  ): void => {
    for (const rowId of rowIds) {
      const operationIds = this.rejectedOperationIdsByRowId.get(rowId);
      operationIds?.delete(operationId);
      if (operationIds?.size === 0) this.rejectedOperationIdsByRowId.delete(rowId);
    }
  };

  private readonly removePendingOperationRows = (
    operationId: string,
    rowIds: Iterable<string>,
  ): void => {
    for (const rowId of rowIds) {
      const operationIds = this.pendingOperationIdsByRowId.get(rowId);
      operationIds?.delete(operationId);
      if (operationIds?.size === 0) this.pendingOperationIdsByRowId.delete(rowId);
    }
  };

  private readonly removeRejectedOperationCellKeys = (
    operationId: string,
    evidence: Iterable<AcceptedOverlayEntry>,
    changedKeys?: Set<string>,
  ): void => {
    for (const entry of evidence) {
      const key = cellKey(entry.rowId, entry.columnId);
      const owners = this.rejectedCellKeys.get(key);
      owners?.delete(operationId);
      if (owners?.size === 0) this.rejectedCellKeys.delete(key);
      changedKeys?.add(key);
    }
  };

  private readonly clearRejectedCellPresentation = (operationId: string): void => {
    this.rejectedCellPresentationDeadlinesByOperation.delete(operationId);
    const evidenceByRow = this.rejectedOperations.get(operationId);
    if (evidenceByRow === undefined) return;
    const changedKeys = new Set<string>();
    this.removeRejectedOperationCellKeys(
      operationId,
      flattenRejectedEvidence(evidenceByRow),
      changedKeys,
    );
    for (const key of changedKeys) {
      this.publishCell(key, this.draftStore.get());
      this.releaseUnusedCellStore(key);
    }
  };

  private readonly clearRejectedOperation = (operationId: string): void => {
    const evidenceByRow = this.rejectedOperations.get(operationId);
    if (evidenceByRow === undefined) return;
    const next = new Map(this.rejectedOperations);
    next.delete(operationId);
    this.rejectedOperations = next;
    this.rejectedOperationCellCounts.delete(operationId);
    this.rejectedBatchOperationIds.delete(operationId);
    this.removeRejectedOperationRows(operationId, evidenceByRow.keys());
    this.rejectedCellPresentationDeadlinesByOperation.delete(operationId);
    const changedKeys = new Set<string>();
    this.removeRejectedOperationCellKeys(
      operationId,
      flattenRejectedEvidence(evidenceByRow),
      changedKeys,
    );
    batch(() => {
      this.publishRejectedOperation(operationId, flattenRejectedEvidence(evidenceByRow));
      for (const key of changedKeys) this.publishCell(key, this.draftStore.get());
    });
    this.rejectedOperationStores.delete(operationId);
    for (const key of changedKeys) this.releaseUnusedCellStore(key);
  };

  private readonly clearSupersededRejectedOperations = (submittedKeys: Iterable<string>): void => {
    if (this.rejectedCellKeys.size === 0) return;
    const keys = new Set(submittedKeys);
    const operationIds = new Set<string>();
    for (const key of keys) {
      for (const operationId of this.rejectedCellKeys.get(key) ?? []) {
        if (this.rejectedBatchOperationIds.has(operationId)) operationIds.add(operationId);
      }
    }
    if (operationIds.size === 0) return;
    const next = new Map(this.rejectedOperations);
    const changedKeys = new Set<string>();
    const changedOperationIds = new Set<string>();
    const removedOperationIds = new Set<string>();
    const removedEvidenceByOperation = new Map<string, AcceptedOverlayEntry[]>();
    for (const operationId of operationIds) {
      const evidenceByRow = this.rejectedOperations.get(operationId);
      if (evidenceByRow === undefined) continue;
      const remainingByRow = new Map<string, readonly AcceptedOverlayEntry[]>();
      for (const [rowId, evidence] of evidenceByRow) {
        const removed = evidence.filter((entry) => keys.has(cellKey(entry.rowId, entry.columnId)));
        const remaining = evidence.filter(
          (entry) => !keys.has(cellKey(entry.rowId, entry.columnId)),
        );
        if (removed.length > 0) {
          this.removeRejectedOperationCellKeys(operationId, removed, changedKeys);
          const operationRemoved = removedEvidenceByOperation.get(operationId) ?? [];
          operationRemoved.push(...removed);
          removedEvidenceByOperation.set(operationId, operationRemoved);
        }
        if (remaining.length > 0) remainingByRow.set(rowId, Object.freeze(remaining));
        else this.removeRejectedOperationRows(operationId, [rowId]);
      }
      if (remainingByRow.size > 0) next.set(operationId, remainingByRow);
      else {
        next.delete(operationId);
        removedOperationIds.add(operationId);
        this.rejectedBatchOperationIds.delete(operationId);
        this.rejectedCellPresentationDeadlinesByOperation.delete(operationId);
      }
      changedOperationIds.add(operationId);
    }
    this.rejectedOperations = next;
    for (const [operationId, removed] of removedEvidenceByOperation) {
      this.removeRejectedOperationCellCount(operationId, removed.length);
    }
    batch(() => {
      for (const operationId of changedOperationIds) {
        this.publishRejectedOperation(
          operationId,
          removedEvidenceByOperation.get(operationId) ?? [],
        );
      }
      for (const key of changedKeys) this.publishCell(key, this.draftStore.get());
    });
    for (const operationId of removedOperationIds) {
      this.rejectedOperationStores.delete(operationId);
    }
    for (const key of changedKeys) this.releaseUnusedCellStore(key);
  };

  private readonly clearSupersededImmediateRejectedCellPresentation = (
    submittedKeys: Iterable<string>,
  ): void => {
    for (const key of submittedKeys) {
      const owners = this.rejectedCellKeys.get(key);
      if (owners === undefined) continue;
      for (const operationId of owners) {
        if (!this.rejectedBatchOperationIds.has(operationId)) owners.delete(operationId);
      }
      if (owners.size === 0) this.rejectedCellKeys.delete(key);
    }
  };

  private readonly getCellPresentationDeadlineWait = (): number => {
    let earliest = Number.POSITIVE_INFINITY;
    for (const deadline of this.rejectedCellPresentationDeadlinesByOperation.values()) {
      earliest = Math.min(earliest, deadline);
    }
    for (const deadline of this.successFlashDeadlinesByKey.values()) {
      earliest = Math.min(earliest, deadline);
    }
    return Number.isFinite(earliest) ? Math.max(0, earliest - Date.now()) : 0;
  };

  private readonly scheduleCellPresentationDeadline = (): void => {
    if (
      this.rejectedCellPresentationDeadlinesByOperation.size === 0 &&
      this.successFlashDeadlinesByKey.size === 0
    ) {
      this.cellPresentationDeadlineQueue.cancel();
      return;
    }
    this.cellPresentationDeadlineQueue.maybeExecute();
  };

  private readonly expireCellPresentationDeadlines = (): void => {
    const now = Date.now();
    const expiredRejectedOperations: string[] = [];
    for (const [operationId, deadline] of this.rejectedCellPresentationDeadlinesByOperation) {
      if (deadline <= now) expiredRejectedOperations.push(operationId);
    }
    for (const operationId of expiredRejectedOperations) {
      this.rejectedCellPresentationDeadlinesByOperation.delete(operationId);
      this.clearRejectedCellPresentation(operationId);
    }
    const expired: string[] = [];
    for (const [key, deadline] of this.successFlashDeadlinesByKey) {
      if (deadline <= now) expired.push(key);
    }
    batch(() => {
      for (const key of expired) {
        this.successFlashDeadlinesByKey.delete(key);
        this.successFlashOperationByKey.delete(key);
        this.publishCell(key, this.draftStore.get());
      }
    });
    for (const key of expired) this.releaseUnusedCellStore(key);
    this.scheduleCellPresentationDeadline();
  };

  private readonly startSuccessFlash = (operationId: string, keys: ReadonlySet<string>): void => {
    for (const key of keys) {
      const saveOwner = this.saveLockedCellKeys.get(key);
      if (saveOwner !== undefined && saveOwner !== operationId) continue;
      if ([...(this.rejectedCellKeys.get(key) ?? [])].some((owner) => owner !== operationId)) {
        continue;
      }
      if ((this.cellSubscriberCounts.get(key) ?? 0) === 0) continue;
      this.successFlashOperationByKey.set(key, operationId);
      this.successFlashDeadlinesByKey.set(key, Date.now() + 2_000);
    }
    this.scheduleCellPresentationDeadline();
  };

  private readonly releaseUnusedCellStore = (key: string): void => {
    if (this.activeCellKey === key || (this.cellSubscriberCounts.get(key) ?? 0) > 0) return;
    const identity = parseCellKey(key);
    if (identity !== undefined && this.hasSaveCellProjection(identity.rowId, identity.columnId)) {
      return;
    }
    this.cellStores.delete(key);
  };

  private readonly invalidateDraftCell = (key: string, publish = true): void => {
    const identity = parseCellKey(key);
    if (identity !== undefined) {
      this.traversalIndex.invalidateCell(identity.rowId, identity.columnId);
      if (publish) this.publishTraversalInvalidation();
    }
  };

  private readonly publishTraversalInvalidation = (): void => {
    for (const listener of this.traversalInvalidationListeners) listener();
  };
}

function indexFieldColumns(
  columns: readonly CompiledColumn[],
): ReadonlyMap<string, CompiledFieldColumn> {
  const indexed = new Map<string, CompiledFieldColumn>();
  for (const column of columns) {
    if (column.kind === "field") indexed.set(column.columnId, column);
  }
  return indexed;
}

function reconcileDraftsForColumns(
  drafts: ReadonlyMap<string, DraftEntry>,
  context: DraftColumnReconciliationContext,
  refreshPermission = true,
): Readonly<{ readonly drafts: ReadonlyMap<string, DraftEntry>; readonly changedKeys: string[] }> {
  if (!context.draftChangesRequired) {
    return Object.freeze({ drafts, changedKeys: [] });
  }
  let nextDrafts: Map<string, DraftEntry> | undefined;
  const changedKeys: string[] = [];
  for (const [key, draft] of drafts) {
    const nextDraft = reconcileDraftEntryForColumns(key, draft, context, refreshPermission);
    if (nextDraft === undefined) {
      nextDrafts ??= new Map(drafts);
      nextDrafts.delete(key);
      changedKeys.push(key);
      continue;
    }
    if (nextDraft === draft) continue;
    nextDrafts ??= new Map(drafts);
    nextDrafts.set(key, nextDraft);
    changedKeys.push(key);
  }
  return Object.freeze({ drafts: nextDrafts ?? drafts, changedKeys });
}

function reconcileDraftEntryForColumns(
  key: string,
  draft: DraftEntry,
  context: DraftColumnReconciliationContext,
  refreshPermission: boolean,
): DraftEntry | undefined {
  let plan = context.plans.get(draft.columnId);
  let syntheticReconnect = false;
  const retainedPresentationColumn =
    draft.presentationColumn ?? context.protectedPresentationColumns.get(key);
  if (plan === undefined || plan.kind === "drop") {
    if (retainedPresentationColumn === undefined) return undefined;
    const nextColumn = context.nextColumns.get(draft.columnId);
    if (nextColumn === undefined || nextColumn.field !== retainedPresentationColumn.field) {
      return Object.freeze({
        ...draft,
        presentationColumn: retainedPresentationColumn,
        blockedReason: BRUNO_TABLE_CELL_EDIT_SCHEMA_MESSAGE,
      });
    }
    const transformValues =
      !sameBlankPolicy(retainedPresentationColumn, nextColumn) ||
      retainedPresentationColumn.semantics.decodeRuntimeAuthority !==
        nextColumn.semantics.decodeRuntimeAuthority;
    plan = Object.freeze({
      kind: "retain",
      previousColumn: retainedPresentationColumn,
      nextColumn,
      transformValues,
      refreshPermission: true,
      checkConvergence: true,
    });
    syntheticReconnect = true;
  }
  if (plan.checkConvergence) context.semanticKeys.add(key);
  let decodedDraft = draft;
  if (!plan.transformValues && syntheticReconnect && draft.presentationColumn !== undefined) {
    const { presentationColumn: _presentationColumn, ...currentDraft } = draft;
    decodedDraft = Object.freeze(currentDraft);
  }
  if (plan.transformValues) {
    const cached = context.migratedValues.get(draft);
    if (cached === null) return undefined;
    if (cached !== undefined) decodedDraft = cached;
    else {
      const { nextColumn } = plan;
      const previousColumn = draft.presentationColumn ?? plan.previousColumn;
      const decodedBase = reconcileDraftValueForColumns(draft.base, previousColumn, nextColumn);
      const decodedMine = reconcileDraftValueForColumns(draft.mine, previousColumn, nextColumn);
      const decodedConflict =
        draft.conflict === undefined
          ? undefined
          : reconcileDraftValueForColumns(draft.conflict.server, previousColumn, nextColumn);
      if (
        decodedBase._tag === "Failure" ||
        decodedMine._tag === "Failure" ||
        decodedConflict?._tag === "Failure"
      ) {
        const presentationColumn =
          draft.presentationColumn ?? context.protectedPresentationColumns.get(key);
        if (presentationColumn === undefined) {
          context.migratedValues.set(draft, null);
          return undefined;
        }
        const retained = Object.freeze({
          ...draft,
          presentationColumn,
          blockedReason: BRUNO_TABLE_CELL_EDIT_SCHEMA_MESSAGE,
        });
        context.migratedValues.set(draft, retained);
        return retained;
      }
      const nextConflict =
        draft.conflict === undefined || decodedConflict === undefined
          ? draft.conflict
          : Object.is(decodedConflict.value, draft.conflict.server)
            ? draft.conflict
            : Object.freeze({ ...draft.conflict, server: decodedConflict.value });
      const { presentationColumn: _presentationColumn, ...draftWithoutPresentationColumn } = draft;
      decodedDraft =
        Object.is(decodedBase.value, draft.base) &&
        Object.is(decodedMine.value, draft.mine) &&
        nextConflict === draft.conflict &&
        draft.presentationColumn === undefined
          ? draft
          : Object.freeze({
              ...draftWithoutPresentationColumn,
              base: decodedBase.value,
              mine: decodedMine.value,
              ...(nextConflict === undefined ? {} : { conflict: nextConflict }),
            });
      context.migratedValues.set(draft, decodedDraft);
    }
  }
  if (!refreshPermission || !plan.refreshPermission) return decodedDraft;
  const { nextColumn } = plan;
  const row = getDraftColumnReconciliationRow(context, draft.rowId);
  const blockedReason =
    typeof row !== "object" || row === null
      ? BRUNO_TABLE_CELL_EDIT_ROW_MISSING_MESSAGE
      : isDraftEditable(nextColumn, row, decodedDraft.mine)
        ? undefined
        : BRUNO_TABLE_CELL_EDIT_PERMISSION_MESSAGE;
  return setDraftBlockedReason(decodedDraft, blockedReason);
}

function getDraftColumnReconciliationRow(
  context: DraftColumnReconciliationContext,
  rowId: string,
): unknown {
  if (context.rows.has(rowId)) return context.rows.get(rowId);
  const row = context.getRow(rowId);
  context.rows.set(rowId, row);
  return row;
}

function reconcileDraftValueForColumns(
  value: unknown,
  previousColumn: CompiledFieldColumn,
  nextColumn: CompiledFieldColumn,
): CanonicalSourceValue {
  if (
    previousColumn.blankValue !== undefined &&
    Object.is(value, previousColumn.blankValue.value)
  ) {
    return nextColumn.blankValue !== undefined &&
      Object.is(previousColumn.blankValue.value, nextColumn.blankValue.value)
      ? Object.freeze({ _tag: "Success", value })
      : Object.freeze({ _tag: "Failure" });
  }
  if (
    previousColumn.semantics.decodeRuntimeAuthority === nextColumn.semantics.decodeRuntimeAuthority
  ) {
    return Object.freeze({ _tag: "Success", value });
  }
  try {
    const decoded = nextColumn.semantics.decodeRuntime(value);
    return decoded._tag === "Success"
      ? Object.freeze({ _tag: "Success", value: decoded.value })
      : Object.freeze({ _tag: "Failure" });
  } catch {
    return Object.freeze({ _tag: "Failure" });
  }
}

function isCompatibleActiveColumn(
  previousColumn: CompiledFieldColumn,
  nextColumn: CompiledFieldColumn,
): boolean {
  return (
    previousColumn.field === nextColumn.field &&
    hasEquivalentEditSemantics(previousColumn, nextColumn) &&
    sameBlankPolicy(previousColumn, nextColumn) &&
    nextColumn.isEditable !== undefined &&
    nextColumn.isEditable !== false
  );
}

function hasStableDraftReconciliationSemantics(
  previousColumn: CompiledFieldColumn,
  nextColumn: CompiledFieldColumn | undefined,
): boolean {
  return (
    nextColumn !== undefined &&
    previousColumn.field === nextColumn.field &&
    sameBlankPolicy(previousColumn, nextColumn) &&
    previousColumn.semantics.decodeRuntimeAuthority ===
      nextColumn.semantics.decodeRuntimeAuthority &&
    previousColumn.semantics.groupedRetentionAuthority.equivalent ===
      nextColumn.semantics.groupedRetentionAuthority.equivalent
  );
}

function hasEquivalentEditSemantics(
  previousColumn: CompiledFieldColumn,
  nextColumn: CompiledFieldColumn,
): boolean {
  const previousSelectAuthority = previousColumn.semantics.selectEditAuthority;
  const nextSelectAuthority = nextColumn.semantics.selectEditAuthority;
  if (previousSelectAuthority !== undefined || nextSelectAuthority !== undefined) {
    return sameStringSequence(previousSelectAuthority, nextSelectAuthority);
  }
  return (
    sameStringSequence(
      previousColumn.semantics.booleanEditorCanonicalValues,
      nextColumn.semantics.booleanEditorCanonicalValues,
    ) &&
    previousColumn.semantics.decodeRuntimeAuthority ===
      nextColumn.semantics.decodeRuntimeAuthority &&
    previousColumn.semantics.editorFamily === nextColumn.semantics.editorFamily &&
    previousColumn.semantics.editSessionAuthority.formatCanonicalText ===
      nextColumn.semantics.editSessionAuthority.formatCanonicalText &&
    previousColumn.semantics.editSessionAuthority.parseCanonicalText ===
      nextColumn.semantics.editSessionAuthority.parseCanonicalText
  );
}

function sameBlankPolicy(
  previousColumn: CompiledFieldColumn,
  nextColumn: CompiledFieldColumn,
): boolean {
  return (
    (previousColumn.blankValue === undefined) === (nextColumn.blankValue === undefined) &&
    Object.is(previousColumn.blankValue?.value, nextColumn.blankValue?.value)
  );
}

function sameStringSequence(
  previousOptions: readonly string[] | undefined,
  nextOptions: readonly string[] | undefined,
): boolean {
  if (previousOptions === nextOptions) return true;
  if (previousOptions === undefined || nextOptions === undefined) return false;
  return (
    previousOptions.length === nextOptions.length &&
    previousOptions.every((option, index) => option === nextOptions[index])
  );
}

function cellKey(rowId: string, columnId: string): string {
  return `${rowId.length}:${rowId}${columnId}`;
}

function parseCellKey(
  key: string,
): Readonly<{ readonly rowId: string; readonly columnId: string }> | undefined {
  const separator = key.indexOf(":");
  if (separator <= 0) return undefined;
  const rowIdLength = Number(key.slice(0, separator));
  if (!Number.isSafeInteger(rowIdLength) || rowIdLength < 0) return undefined;
  const rowStart = separator + 1;
  const columnStart = rowStart + rowIdLength;
  if (columnStart > key.length) return undefined;
  return { rowId: key.slice(rowStart, columnStart), columnId: key.slice(columnStart) };
}

function boundedMessage(message: string): string {
  const normalized = message.trim();
  const present = normalized.length === 0 ? "The value is invalid." : normalized;
  return present.length <= 512 ? present : `${present.slice(0, 511)}…`;
}

function sameSessionSnapshot(
  previous: BrunoTableCellEditSessionSnapshot,
  next: BrunoTableCellEditSessionSnapshot,
): boolean {
  if (previous.kind !== next.kind) return false;
  if (previous.kind === "idle" || next.kind === "idle") return true;
  return (
    previous.rowId === next.rowId &&
    previous.columnId === next.columnId &&
    previous.initialText === next.initialText &&
    previous.selectInitialText === next.selectInitialText &&
    previous.rowMissing === next.rowMissing &&
    previous.invalidMessage === next.invalidMessage
  );
}
