import { installTableScopedListener } from "./listener-registry";

type ColumnCommandSubscriptionListener = (event: {
  readonly tableId: string;
  readonly columnId: string;
  readonly listenerCount: number;
}) => void;
type ColumnFilterSubscriptionListener = (event: {
  readonly tableId: string;
  readonly columnId: string;
  readonly listenerCount: number;
  readonly phase: "subscribe" | "unsubscribe" | "notify";
}) => void;
export type BrunoTableReviewCellSubscriptionEvent = Readonly<{
  readonly tableId: string;
  readonly rowId: string;
  readonly columnId: string;
  readonly source:
    | "grid-row-cell"
    | "review-value-projection"
    | "review-status"
    | "review-resolution";
  readonly phase: "subscribe" | "unsubscribe";
}>;
type ReviewCellSubscriptionListener = (event: BrunoTableReviewCellSubscriptionEvent) => void;

const columnCommandSubscriptionListenersByTableId = new Map<
  string,
  Set<ColumnCommandSubscriptionListener>
>();
const columnFilterSubscriptionListenersByTableId = new Map<
  string,
  Set<ColumnFilterSubscriptionListener>
>();
let diagnosticListenerCount = 0;
let filterDiagnosticListenerCount = 0;
const reviewCellSubscriptionListeners = new Set<ReviewCellSubscriptionListener>();

export function recordBrunoTableReviewCellSubscription(
  event: BrunoTableReviewCellSubscriptionEvent,
): void {
  if (reviewCellSubscriptionListeners.size === 0) return;
  for (const listener of reviewCellSubscriptionListeners) {
    try {
      listener(event);
    } catch {
      // Diagnostics are observational and must never alter subscription behavior.
    }
  }
}

export function installBrunoTableReviewCellSubscriptionListener(
  listener: ReviewCellSubscriptionListener,
): () => void {
  reviewCellSubscriptionListeners.add(listener);
  return () => reviewCellSubscriptionListeners.delete(listener);
}

export function recordBrunoTableColumnCommandSubscriptionNotification(
  tableId: string,
  columnId: string,
  subscribedColumnListenerCount: number,
): void {
  if (diagnosticListenerCount === 0 || subscribedColumnListenerCount === 0) return;
  const listeners = columnCommandSubscriptionListenersByTableId.get(tableId);
  if (listeners === undefined) return;
  const event = Object.freeze({
    tableId,
    columnId,
    listenerCount: subscribedColumnListenerCount,
  });
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Diagnostics are observational and must never alter notification delivery.
    }
  }
}

export function installBrunoTableColumnCommandSubscriptionListener(
  tableId: string,
  listener: ColumnCommandSubscriptionListener,
): () => void {
  return installTableScopedListener(
    columnCommandSubscriptionListenersByTableId,
    tableId,
    listener,
    () => {
      diagnosticListenerCount += 1;
    },
    () => {
      diagnosticListenerCount -= 1;
    },
  );
}

export function recordBrunoTableColumnFilterSubscriptionEvent(
  tableId: string,
  columnId: string,
  subscribedColumnListenerCount: number,
  phase: "subscribe" | "unsubscribe" | "notify",
): void {
  if (filterDiagnosticListenerCount === 0) return;
  const listeners = columnFilterSubscriptionListenersByTableId.get(tableId);
  if (listeners === undefined) return;
  const event = Object.freeze({
    tableId,
    columnId,
    listenerCount: subscribedColumnListenerCount,
    phase,
  });
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Diagnostics are observational and must never alter notification delivery.
    }
  }
}

export function installBrunoTableColumnFilterSubscriptionListener(
  tableId: string,
  listener: ColumnFilterSubscriptionListener,
): () => void {
  return installTableScopedListener(
    columnFilterSubscriptionListenersByTableId,
    tableId,
    listener,
    () => {
      filterDiagnosticListenerCount += 1;
    },
    () => {
      filterDiagnosticListenerCount -= 1;
    },
  );
}
