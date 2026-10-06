import type { BrunoTableCellEditDraftReviewRow } from "./cell-edit";

const brunoTableCellEditDraftReviewSources = new WeakSet<object>();

export type BrunoTableCellEditDraftReviewSourceRow = Readonly<{
  readonly kind: "bruno-table-cell-edit-draft-review-source";
  readonly id: string;
  readonly rowId: string;
  readonly columnLabel: string;
  readonly baseText: "";
  readonly selectionText: "";
  readonly serverText: "";
  readonly mineText: "";
  readonly resolutionText: "";
  readonly statusText: "";
  readonly getSnapshot: () => BrunoTableCellEditDraftReviewRow;
  readonly subscribe: (listener: () => void) => () => void;
}>;

export function registerBrunoTableCellEditDraftReviewSource(source: object): void {
  brunoTableCellEditDraftReviewSources.add(source);
}

export function isBrunoTableCellEditDraftReviewSourceRow(
  value: unknown,
): value is BrunoTableCellEditDraftReviewSourceRow {
  return (
    typeof value === "object" && value !== null && brunoTableCellEditDraftReviewSources.has(value)
  );
}
