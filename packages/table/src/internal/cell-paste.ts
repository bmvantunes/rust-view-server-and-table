import { Store } from "@tanstack/store";
import { assign, createActor, createMachine } from "xstate";

import type {
  BrunoTableCellCoordinate,
  BrunoTableCellRangeAxis,
  BrunoTableCellRangeStructure,
  BrunoTableClipboardTarget,
} from "./cell-range-clipboard";
import type {
  BrunoTableCellEditCanonicalTextGesture,
  BrunoTableCellEditCanonicalTextGestureResult,
} from "./cell-edit";

export type BrunoTableParsedPaste = Readonly<{
  readonly axis: BrunoTableCellRangeAxis;
  readonly canonicalTexts: readonly [string, ...string[]];
}>;

export const BRUNO_TABLE_PASTE_MAX_TEXT_CODE_UNITS = 65_536;
export const BRUNO_TABLE_PASTE_MAX_LINEAR_CELLS = 16_384;

export type BrunoTablePasteDiagnosticCode =
  | "input-budget-text"
  | "input-budget-cells"
  | "invalid-tsv"
  | "unsupported-shape"
  | "clipboard-unavailable"
  | "clipboard-read-pending"
  | "clipboard-read-rejected"
  | "no-target"
  | "structure-changed"
  | "out-of-bounds"
  | "confirmation-changed"
  | "destination-unavailable"
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

export type BrunoTablePasteDiagnostic = Readonly<{
  readonly code: BrunoTablePasteDiagnosticCode;
  readonly rowId?: string;
  readonly columnId?: string;
  readonly detail?: string;
  readonly additionalInvalidCount?: number;
}>;

const BRUNO_TABLE_PASTE_MAX_DIAGNOSTIC_DETAIL_CODE_UNITS = 256;
const BRUNO_TABLE_PASTE_MAX_DIAGNOSTIC_MESSAGE_CODE_UNITS = 512;
const BRUNO_TABLE_PASTE_MAX_COORDINATE_COMPONENT_CODE_UNITS = 128;

function boundBrunoTablePasteDiagnosticText(text: string, maximum: number): string {
  return text.length <= maximum ? text : `${text.slice(0, Math.max(0, maximum - 1))}…`;
}

export type BrunoTablePasteCoordinateEvidence = Readonly<{
  readonly columnLabel: string;
  readonly rowLabel: string;
}>;

export function createBrunoTablePasteCoordinateEvidence(
  columnLabel: string,
  rowLabel: string,
): BrunoTablePasteCoordinateEvidence {
  return Object.freeze({
    columnLabel: boundBrunoTablePasteDiagnosticText(
      columnLabel,
      BRUNO_TABLE_PASTE_MAX_COORDINATE_COMPONENT_CODE_UNITS,
    ),
    rowLabel: boundBrunoTablePasteDiagnosticText(
      rowLabel,
      BRUNO_TABLE_PASTE_MAX_COORDINATE_COMPONENT_CODE_UNITS,
    ),
  });
}

export function formatBrunoTablePasteCoordinateEvidence(
  coordinate: BrunoTablePasteCoordinateEvidence,
): string {
  return `${coordinate.columnLabel}, row ${coordinate.rowLabel}`;
}

export function createBrunoTablePasteDiagnostic(
  code: BrunoTablePasteDiagnosticCode,
  evidence: Omit<BrunoTablePasteDiagnostic, "code"> = {},
): BrunoTablePasteDiagnostic {
  return Object.freeze({
    code,
    ...(evidence.rowId === undefined ? {} : { rowId: evidence.rowId }),
    ...(evidence.columnId === undefined ? {} : { columnId: evidence.columnId }),
    ...(evidence.detail === undefined
      ? {}
      : {
          detail: boundBrunoTablePasteDiagnosticText(
            evidence.detail,
            BRUNO_TABLE_PASTE_MAX_DIAGNOSTIC_DETAIL_CODE_UNITS,
          ),
        }),
    ...(evidence.additionalInvalidCount === undefined
      ? {}
      : {
          additionalInvalidCount: Math.min(
            BRUNO_TABLE_PASTE_MAX_LINEAR_CELLS - 1,
            Math.max(0, evidence.additionalInvalidCount),
          ),
        }),
  });
}

export function brunoTablePasteDiagnosticFromCellEdit(
  rejection: Extract<BrunoTableCellEditCanonicalTextGestureResult, { readonly kind: "rejected" }>,
): BrunoTablePasteDiagnostic {
  return createBrunoTablePasteDiagnostic(rejection.reason, {
    ...(rejection.rowId === undefined ? {} : { rowId: rejection.rowId }),
    ...(rejection.columnId === undefined ? {} : { columnId: rejection.columnId }),
    ...(rejection.detail === undefined ? {} : { detail: rejection.detail }),
    ...(rejection.additionalInvalidCount === undefined
      ? {}
      : { additionalInvalidCount: rejection.additionalInvalidCount }),
  });
}

export function formatBrunoTablePasteDiagnostic(
  diagnostic: BrunoTablePasteDiagnostic,
  describeCoordinate: (
    coordinate: BrunoTableCellCoordinate,
  ) => BrunoTablePasteCoordinateEvidence = ({ rowId, columnId }) =>
    createBrunoTablePasteCoordinateEvidence(columnId, rowId),
): string {
  const base = (() => {
    switch (diagnostic.code) {
      case "input-budget-text":
        return `Copied text exceeds the ${String(BRUNO_TABLE_PASTE_MAX_TEXT_CODE_UNITS)} UTF-16 code-unit paste limit.`;
      case "input-budget-cells":
        return `Copied line exceeds the ${String(BRUNO_TABLE_PASTE_MAX_LINEAR_CELLS)}-cell paste limit.`;
      case "invalid-tsv":
        return "The clipboard contains invalid TSV.";
      case "unsupported-shape":
        return diagnostic.detail ?? "Paste supports one row or one column at a time.";
      case "clipboard-unavailable":
        return "Clipboard access is unavailable.";
      case "clipboard-read-pending":
        return "A clipboard read is already in progress.";
      case "clipboard-read-rejected":
        return "The browser rejected clipboard access.";
      case "no-target":
        return "No editable paste destination is active.";
      case "structure-changed":
        return "The paste destination changed while reading the clipboard.";
      case "out-of-bounds":
        return "The proposed destination is outside the available table.";
      case "confirmation-changed":
        return "The proposed destination changed before confirmation.";
      case "destination-unavailable":
        return "The proposed destination is no longer available.";
      case "temporarily-unavailable":
        return "Editing is temporarily unavailable.";
      case "invalid-target":
        return "The paste target is invalid.";
      case "save-locked":
        return "This destination cell is saving.";
      case "unavailable":
        return "This destination cell is unavailable.";
      case "stale":
        return "Resolve this cell's stale conflict before pasting.";
      case "blocked":
        return "Resolve this cell's blocked edit before pasting.";
      case "row-version":
        return "This destination row has no usable Row Version.";
      case "invalid-source":
        return "The source value is invalid.";
      case "read-only":
        return "This destination cell is read-only.";
      case "invalid-value":
        return diagnostic.detail ?? "The pasted value is invalid.";
      case "empty":
        return "The paste target is empty.";
      case "unchanged":
        return "The pasted values did not change the table.";
    }
  })();
  const additional =
    diagnostic.additionalInvalidCount === undefined || diagnostic.additionalInvalidCount === 0
      ? ""
      : ` ${String(diagnostic.additionalInvalidCount)} additional ${diagnostic.additionalInvalidCount === 1 ? "destination is" : "destinations are"} invalid.`;
  const body = `${base}${additional}`;
  const describedCoordinate =
    diagnostic.rowId === undefined || diagnostic.columnId === undefined
      ? undefined
      : describeCoordinate({ rowId: diagnostic.rowId, columnId: diagnostic.columnId });
  const location =
    describedCoordinate === undefined
      ? ""
      : boundBrunoTablePasteDiagnosticText(
          `${formatBrunoTablePasteCoordinateEvidence(
            createBrunoTablePasteCoordinateEvidence(
              describedCoordinate.columnLabel,
              describedCoordinate.rowLabel,
            ),
          )}: `,
          Math.max(0, BRUNO_TABLE_PASTE_MAX_DIAGNOSTIC_MESSAGE_CODE_UNITS - body.length),
        );
  return `${location}${body}`;
}

export type BrunoTablePasteParseResult =
  | Readonly<{ readonly kind: "accepted"; readonly paste: BrunoTableParsedPaste }>
  | Readonly<{ readonly kind: "rejected"; readonly diagnostic: BrunoTablePasteDiagnostic }>;

export type BrunoTablePastePlan =
  | Readonly<{ readonly kind: "rejected"; readonly diagnostic: BrunoTablePasteDiagnostic }>
  | Readonly<{
      readonly kind: "direct";
      readonly gesture: BrunoTableCellEditCanonicalTextGesture;
    }>
  | Readonly<{
      readonly kind: "confirm";
      readonly paste: BrunoTableParsedPaste;
      readonly selected: BrunoTableClipboardTarget;
      readonly start: BrunoTableCellCoordinate;
      readonly proposed: BrunoTableClipboardTarget | undefined;
    }>;

export type BrunoTablePasteConfirmation = Readonly<{
  readonly paste: BrunoTableParsedPaste;
  readonly selected: BrunoTableClipboardTarget;
  readonly start: BrunoTableCellCoordinate;
  readonly proposed: BrunoTableClipboardTarget | undefined;
  readonly copiedDescription: string;
  readonly selectedDescription: string;
  readonly proposedDescription: string;
  readonly startCoordinate: BrunoTablePasteCoordinateEvidence;
  readonly endCoordinate: BrunoTablePasteCoordinateEvidence;
}>;

export type BrunoTablePasteSnapshot =
  | Readonly<{ readonly open: false }>
  | Readonly<{
      readonly open: true;
      readonly confirmation: BrunoTablePasteConfirmation;
      readonly error?: string;
    }>;

type PasteContext = Readonly<{
  readonly confirmation: BrunoTablePasteConfirmation | undefined;
  readonly error: BrunoTablePasteDiagnostic | undefined;
  readonly result: PasteAttemptResult | undefined;
}>;
type PasteAttemptResult =
  | Readonly<{ readonly kind: "accepted" }>
  | Readonly<{ readonly kind: "rejected"; readonly diagnostic: BrunoTablePasteDiagnostic }>;
type PasteEvent =
  | Readonly<{ readonly type: "OPEN"; readonly confirmation: BrunoTablePasteConfirmation }>
  | Readonly<{ readonly type: "CANCEL" }>
  | Readonly<{
      readonly type: "CONFIRM";
      readonly attempt: (confirmation: BrunoTablePasteConfirmation) => PasteAttemptResult;
    }>;

function createBrunoTablePasteMachine() {
  return createMachine({
    id: "brunoTablePaste",
    initial: "idle",
    types: {} as { context: PasteContext; events: PasteEvent },
    context: { confirmation: undefined, error: undefined, result: undefined },
    states: {
      idle: {
        on: {
          OPEN: {
            target: "confirming",
            actions: assign({
              confirmation: ({ event }) => event.confirmation,
              error: undefined,
              result: undefined,
            }),
          },
        },
      },
      confirming: {
        on: {
          OPEN: {
            actions: assign({
              confirmation: ({ event }) => event.confirmation,
              error: undefined,
              result: undefined,
            }),
          },
          CONFIRM: {
            target: "applying",
            actions: assign({
              result: ({ context, event }) =>
                context.confirmation === undefined
                  ? Object.freeze({
                      kind: "rejected" as const,
                      diagnostic: createBrunoTablePasteDiagnostic("destination-unavailable"),
                    })
                  : event.attempt(context.confirmation),
              error: undefined,
            }),
          },
          CANCEL: {
            target: "idle",
            actions: assign({ confirmation: undefined, error: undefined, result: undefined }),
          },
        },
      },
      applying: {
        always: [
          {
            guard: ({ context }) => context.result?.kind === "accepted",
            target: "applied",
            actions: assign({ confirmation: undefined, error: undefined, result: undefined }),
          },
          {
            target: "blocked",
            actions: assign({
              error: ({ context }) =>
                context.result?.kind === "rejected"
                  ? context.result.diagnostic
                  : createBrunoTablePasteDiagnostic("destination-unavailable"),
            }),
          },
        ],
      },
      blocked: {
        on: {
          CONFIRM: {
            target: "applying",
            actions: assign({
              result: ({ context, event }) =>
                context.confirmation === undefined
                  ? Object.freeze({
                      kind: "rejected" as const,
                      diagnostic: createBrunoTablePasteDiagnostic("destination-unavailable"),
                    })
                  : event.attempt(context.confirmation),
              error: undefined,
            }),
          },
          CANCEL: {
            target: "idle",
            actions: assign({ confirmation: undefined, error: undefined, result: undefined }),
          },
        },
      },
      applied: {
        on: {
          OPEN: {
            target: "confirming",
            actions: assign({
              confirmation: ({ event }) => event.confirmation,
              error: undefined,
              result: undefined,
            }),
          },
        },
      },
    },
  });
}

type BrunoTablePasteState = "idle" | "confirming" | "applying" | "blocked" | "applied";

type BrunoTablePasteActorSnapshot = Readonly<{
  readonly context: PasteContext;
  readonly matches: (state: BrunoTablePasteState) => boolean;
}>;

type BrunoTablePasteActor = Readonly<{
  start: () => void;
  stop: () => void;
  send: (event: PasteEvent) => void;
  getSnapshot: () => BrunoTablePasteActorSnapshot;
  subscribe: (
    observer: (snapshot: BrunoTablePasteActorSnapshot) => void,
  ) => Readonly<{ unsubscribe: () => void }>;
}>;

export function createBrunoTablePasteActor(): BrunoTablePasteActor {
  return createActor(createBrunoTablePasteMachine());
}

const CLOSED_PASTE_SNAPSHOT: BrunoTablePasteSnapshot = Object.freeze({ open: false });
type PasteNotification = Readonly<{ readonly sequence: number; readonly message: string }>;
const EMPTY_PASTE_NOTIFICATION: PasteNotification = Object.freeze({ sequence: 0, message: "" });
const describeFallbackPasteCoordinate = ({
  rowId,
  columnId,
}: BrunoTableCellCoordinate): BrunoTablePasteCoordinateEvidence =>
  createBrunoTablePasteCoordinateEvidence(columnId, rowId);

export class BrunoTablePasteRuntime {
  private readonly actor = createBrunoTablePasteActor();
  private readonly store = new Store<BrunoTablePasteSnapshot>(CLOSED_PASTE_SNAPSHOT);
  private readonly notificationStore = new Store<PasteNotification>(EMPTY_PASTE_NOTIFICATION);
  private clipboardReadSequence = 0;
  private clipboardReadPending = false;
  private attempt:
    | ((
        confirmation: BrunoTablePasteConfirmation,
      ) =>
        | Readonly<{ readonly kind: "accepted" }>
        | Readonly<{ readonly kind: "rejected"; readonly diagnostic: BrunoTablePasteDiagnostic }>)
    | undefined;
  private restoreFocus: () => void;
  private describeCoordinate: (
    coordinate: BrunoTableCellCoordinate,
  ) => BrunoTablePasteCoordinateEvidence = describeFallbackPasteCoordinate;
  private readonly fallbackFocus: () => void;

  public constructor(fallbackFocus: () => void = () => undefined) {
    this.fallbackFocus = fallbackFocus;
    this.restoreFocus = fallbackFocus;
    this.actor.subscribe((snapshot) => {
      const confirmation = snapshot.context.confirmation;
      this.store.setState(() =>
        (snapshot.matches("confirming") ||
          snapshot.matches("blocked") ||
          snapshot.matches("applying")) &&
        confirmation !== undefined
          ? Object.freeze({
              open: true,
              confirmation,
              ...(snapshot.context.error === undefined
                ? {}
                : {
                    error: formatBrunoTablePasteDiagnostic(
                      snapshot.context.error,
                      this.describeCoordinate,
                    ),
                  }),
            })
          : CLOSED_PASTE_SNAPSHOT,
      );
    });
    this.actor.start();
  }

  public readonly getSnapshot = (): BrunoTablePasteSnapshot => this.store.get();
  public readonly subscribe = (listener: () => void): (() => void) => {
    const subscription = this.store.subscribe(listener);
    return () => subscription.unsubscribe();
  };
  public readonly getNotificationSnapshot = (): Readonly<{
    readonly sequence: number;
    readonly message: string;
  }> => this.notificationStore.get();
  public readonly subscribeNotification = (listener: () => void): (() => void) => {
    const subscription = this.notificationStore.subscribe(listener);
    return () => subscription.unsubscribe();
  };
  public readonly notify = (diagnostic: BrunoTablePasteDiagnostic): void =>
    this.notificationStore.setState((previous) =>
      Object.freeze({
        sequence: previous.sequence + 1,
        message: `${formatBrunoTablePasteDiagnostic(diagnostic, this.describeCoordinate)} Nothing was applied.`,
      }),
    );
  public readonly clearNotification = (): void =>
    this.notificationStore.setState((previous) =>
      Object.freeze({ sequence: previous.sequence + 1, message: "" }),
    );
  public readonly isClipboardReadPending = (): boolean => this.clipboardReadPending;
  public readonly beginClipboardRead = (): number | undefined => {
    if (this.clipboardReadPending) return undefined;
    this.clipboardReadPending = true;
    this.clipboardReadSequence += 1;
    return this.clipboardReadSequence;
  };
  public readonly finishClipboardRead = (sequence: number): boolean => {
    if (!this.clipboardReadPending || sequence !== this.clipboardReadSequence) return false;
    this.clipboardReadPending = false;
    return true;
  };
  public readonly register = (
    attempt: NonNullable<BrunoTablePasteRuntime["attempt"]>,
    restoreFocus: () => void,
    describeCoordinate: (coordinate: BrunoTableCellCoordinate) => BrunoTablePasteCoordinateEvidence,
  ): (() => void) => {
    this.attempt = attempt;
    this.restoreFocus = restoreFocus;
    this.describeCoordinate = describeCoordinate;
    return () => {
      if (this.attempt === attempt) this.attempt = undefined;
      if (this.restoreFocus === restoreFocus) this.restoreFocus = this.fallbackFocus;
      if (this.describeCoordinate === describeCoordinate) {
        this.describeCoordinate = describeFallbackPasteCoordinate;
      }
    };
  };
  public readonly open = (confirmation: BrunoTablePasteConfirmation): void =>
    this.actor.send({ type: "OPEN", confirmation });
  public readonly cancel = (): void => {
    this.actor.send({ type: "CANCEL" });
    this.restoreFocus();
  };
  public readonly confirm = (): void => {
    const snapshot = this.store.get();
    if (!snapshot.open) return;
    this.actor.send({
      type: "CONFIRM",
      attempt:
        this.attempt ??
        (() =>
          Object.freeze({
            kind: "rejected" as const,
            diagnostic: createBrunoTablePasteDiagnostic("destination-unavailable"),
          })),
    });
    if (!this.actor.getSnapshot().matches("applied")) return;
    this.clearNotification();
    this.restoreFocus();
  };
  public readonly dispose = (): void => {
    this.clipboardReadSequence += 1;
    this.clipboardReadPending = false;
    this.actor.stop();
    this.attempt = undefined;
    this.restoreFocus = this.fallbackFocus;
    this.describeCoordinate = describeFallbackPasteCoordinate;
  };
}

export function parseBrunoTablePaste(text: string): BrunoTablePasteParseResult {
  if (text.length > BRUNO_TABLE_PASTE_MAX_TEXT_CODE_UNITS) {
    return Object.freeze({
      kind: "rejected",
      diagnostic: createBrunoTablePasteDiagnostic("input-budget-text"),
    });
  }
  const rows: string[][] = [[]];
  let cell = "";
  let quoted = false;
  let afterQuote = false;
  let explicitlyQuoted = false;
  let cellCount = 0;
  const cellBudgetRejection = (): BrunoTablePasteParseResult =>
    Object.freeze({
      kind: "rejected",
      diagnostic: createBrunoTablePasteDiagnostic("input-budget-cells"),
    });
  const finishCell = (): boolean => {
    if (cellCount >= BRUNO_TABLE_PASTE_MAX_LINEAR_CELLS) return false;
    rows.at(-1)!.push(cell);
    cellCount += 1;
    cell = "";
    afterQuote = false;
    explicitlyQuoted = false;
    return true;
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"' && cell.length === 0 && !afterQuote) {
      quoted = true;
      explicitlyQuoted = true;
      continue;
    }
    if (character === "\t") {
      if (!finishCell()) return cellBudgetRejection();
      continue;
    }
    if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      if (!finishCell()) return cellBudgetRejection();
      rows.push([]);
      continue;
    }
    if (afterQuote) {
      return Object.freeze({
        kind: "rejected",
        diagnostic: createBrunoTablePasteDiagnostic("invalid-tsv"),
      });
    }
    cell += character;
  }
  if (quoted) {
    return Object.freeze({
      kind: "rejected",
      diagnostic: createBrunoTablePasteDiagnostic("invalid-tsv"),
    });
  }
  const hasImplicitTerminalRow =
    rows.length > 1 &&
    rows.at(-1)?.length === 0 &&
    cell.length === 0 &&
    explicitlyQuoted === false &&
    afterQuote === false;
  if (hasImplicitTerminalRow) {
    rows.pop();
  } else if (!finishCell()) {
    return cellBudgetRejection();
  }
  const width = rows[0]?.length ?? 0;
  if (width === 0 || rows.some((row) => row.length !== width)) {
    return Object.freeze({
      kind: "rejected",
      diagnostic: createBrunoTablePasteDiagnostic("invalid-tsv"),
    });
  }
  if (rows.length > 1 && width > 1) {
    return Object.freeze({
      kind: "rejected",
      diagnostic: createBrunoTablePasteDiagnostic("unsupported-shape", {
        detail: `Copied ${String(rows.length)}×${String(width)}. BrunoTable accepts only one row or one column.`,
      }),
    });
  }
  const canonicalTexts = (rows.length === 1 ? [...rows[0]!] : rows.map((row) => row[0]!)) as [
    string,
    ...string[],
  ];
  return Object.freeze({
    kind: "accepted",
    paste: Object.freeze({
      axis: rows.length > 1 ? "vertical" : "horizontal",
      canonicalTexts: Object.freeze(canonicalTexts),
    }),
  });
}

export function planBrunoTablePaste(
  text: string,
  selected: BrunoTableClipboardTarget,
  structure: BrunoTableCellRangeStructure,
): BrunoTablePastePlan {
  const parsed = parseBrunoTablePaste(text);
  if (parsed.kind === "rejected") return parsed;
  const gesture = createBrunoTablePasteGesture(parsed.paste, selected, structure);
  if (gesture !== undefined) return Object.freeze({ kind: "direct", gesture });
  const start = Object.freeze({ rowId: selected.rowIds[0], columnId: selected.columnIds[0] });
  return Object.freeze({
    kind: "confirm",
    paste: parsed.paste,
    selected,
    start,
    proposed: projectBrunoTablePasteTarget(parsed.paste, start, structure),
  });
}

export function createBrunoTablePasteGesture(
  paste: BrunoTableParsedPaste,
  selected: BrunoTableClipboardTarget,
  structure: BrunoTableCellRangeStructure,
): BrunoTableCellEditCanonicalTextGesture | undefined {
  const length = paste.canonicalTexts.length;
  const isBroadcast = length === 1;
  const selectedLength =
    selected.axis === "horizontal" ? selected.columnIds.length : selected.rowIds.length;
  if (!isBroadcast && (selected.axis !== paste.axis || selectedLength !== length)) return undefined;
  const { rowIds, columnIds } = selected;
  const cells: Array<{ rowId: string; columnId: string; canonicalText: string }> = [];
  if (isBroadcast) {
    if (selected.axis === "horizontal") {
      for (const columnId of columnIds) {
        cells.push({ rowId: rowIds[0]!, columnId, canonicalText: paste.canonicalTexts[0]! });
      }
    } else {
      for (const rowId of rowIds) {
        cells.push({ rowId, columnId: columnIds[0]!, canonicalText: paste.canonicalTexts[0]! });
      }
    }
  } else if (paste.axis === "horizontal") {
    for (let index = 0; index < length; index += 1) {
      cells.push({
        rowId: rowIds[0]!,
        columnId: columnIds[index]!,
        canonicalText: paste.canonicalTexts[index]!,
      });
    }
  } else {
    for (let index = 0; index < length; index += 1) {
      cells.push({
        rowId: rowIds[index]!,
        columnId: columnIds[0]!,
        canonicalText: paste.canonicalTexts[index]!,
      });
    }
  }
  if (
    cells.length === 0 ||
    cells.some(
      ({ rowId, columnId }) =>
        !structure.rowIndexById.has(rowId) || !structure.columnIndexById.has(columnId),
    )
  ) {
    return undefined;
  }
  const [first, ...rest] = cells;
  return first === undefined
    ? undefined
    : Object.freeze([Object.freeze(first), ...rest.map((entry) => Object.freeze(entry))]);
}

export function projectBrunoTablePasteTarget(
  paste: BrunoTableParsedPaste,
  start: BrunoTableCellCoordinate,
  structure: BrunoTableCellRangeStructure,
): BrunoTableClipboardTarget | undefined {
  const length = paste.canonicalTexts.length;
  const rowIndex = structure.rowIndexById.get(start.rowId);
  const columnIndex = structure.columnIndexById.get(start.columnId);
  if (rowIndex === undefined || columnIndex === undefined) return undefined;
  if (paste.axis === "horizontal") {
    const columnIds = structure.columnIds.slice(columnIndex, columnIndex + length);
    if (columnIds.length !== length || columnIds[0] === undefined) return undefined;
    return Object.freeze({
      axis: "horizontal",
      rowIds: Object.freeze([start.rowId]) as readonly [string],
      columnIds: Object.freeze(columnIds) as readonly [string, ...string[]],
    });
  }
  const rowIds = structure.rowIds.slice(rowIndex, rowIndex + length);
  if (rowIds.length !== length || rowIds[0] === undefined) return undefined;
  return Object.freeze({
    axis: "vertical",
    rowIds: Object.freeze(rowIds) as readonly [string, ...string[]],
    columnIds: Object.freeze([start.columnId]) as readonly [string],
  });
}

export function sameBrunoTablePasteTarget(
  left: BrunoTableClipboardTarget,
  right: BrunoTableClipboardTarget,
): boolean {
  return (
    left.axis === right.axis &&
    left.rowIds.length === right.rowIds.length &&
    left.columnIds.length === right.columnIds.length &&
    left.rowIds.every((rowId, index) => rowId === right.rowIds[index]) &&
    left.columnIds.every((columnId, index) => columnId === right.columnIds[index])
  );
}

export function isBrunoTablePasteTargetCurrent(
  target: BrunoTableClipboardTarget,
  structure: BrunoTableCellRangeStructure,
): boolean {
  if (target.axis === "horizontal") {
    if (target.rowIds.length !== 1 || !structure.rowIndexById.has(target.rowIds[0])) return false;
    const start = structure.columnIndexById.get(target.columnIds[0]);
    return (
      start !== undefined &&
      target.columnIds.every((columnId, index) => structure.columnIds[start + index] === columnId)
    );
  }
  if (target.columnIds.length !== 1 || !structure.columnIndexById.has(target.columnIds[0])) {
    return false;
  }
  const start = structure.rowIndexById.get(target.rowIds[0]);
  return (
    start !== undefined &&
    target.rowIds.every((rowId, index) => structure.rowIds[start + index] === rowId)
  );
}
