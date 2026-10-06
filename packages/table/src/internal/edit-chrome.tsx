import { Button } from "@bruno/shadcn/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@bruno/shadcn/alert-dialog";
import { Switch } from "@bruno/shadcn/switch";
import { ScrollArea } from "@bruno/shadcn/scroll-area";
import { createToastManager, Toaster } from "@bruno/shadcn/toast";
import { Debouncer } from "@tanstack/react-pacer";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type NamedExoticComponent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { createRoot, type Root } from "react-dom/client";

import type { BrunoTableCellEditDraftReviewSourceRow } from "./cell-edit";
import type { BrunoTableGridCommand } from "./column-management";
import type { BrunoTableEditMemoryRuntime } from "./edit-memory";
import { recordBrunoTableReviewCellSubscription } from "./grid-subscription-instrumentation";
import { recordBrunoTableClientEditFooterRender } from "./render-instrumentation";
import { BrunoTableRowSelectionRuntime } from "./row-selection";
import { BRUNO_TABLE_REVIEW_VIEWPORT_MAX_HEIGHT_PROPERTY } from "./review-viewport";

type SaveFailureToasterOwner = object;
type SaveFailureToasterEntry = Readonly<{
  readonly manager: ReturnType<typeof createToastManager>;
  readonly owners: Set<SaveFailureToasterOwner>;
  readonly host: HTMLElement;
  readonly portalContainer: RefObject<HTMLElement | null>;
  readonly root: Root;
}>;

const saveFailureToastersByDocument = new WeakMap<Document, SaveFailureToasterEntry>();
const pendingSaveFailureToasterDisposals = new Map<Document, SaveFailureToasterEntry>();
const saveFailureToasterDisposalQueue = new Debouncer(
  () => {
    const pending = [...pendingSaveFailureToasterDisposals];
    pendingSaveFailureToasterDisposals.clear();
    for (const [ownerDocument, entry] of pending) {
      if (entry.owners.size > 0 || saveFailureToastersByDocument.get(ownerDocument) !== entry) {
        continue;
      }
      saveFailureToastersByDocument.delete(ownerDocument);
      entry.root.unmount();
      entry.host.remove();
    }
  },
  { wait: 0 },
);
let saveFailureToastIdSequence = 0;

function useReviewViewportRef(): (element: HTMLDivElement | null) => (() => void) | undefined {
  return useCallback((element: HTMLDivElement | null) => {
    if (element === null) return undefined;
    const updateMaxHeight = (): void => {
      element.style.setProperty(
        BRUNO_TABLE_REVIEW_VIEWPORT_MAX_HEIGHT_PROPERTY,
        `${element.clientHeight}px`,
      );
    };
    updateMaxHeight();
    const ResizeObserverConstructor = element.ownerDocument.defaultView?.ResizeObserver;
    if (ResizeObserverConstructor === undefined) return undefined;
    const observer = new ResizeObserverConstructor(updateMaxHeight);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
}

function createSaveFailureToasterEntry(ownerDocument: Document): SaveFailureToasterEntry {
  const manager = createToastManager();
  const host = ownerDocument.createElement("div");
  host.dataset["brunoTableSaveFailureToaster"] = "";
  ownerDocument.body.append(host);
  const portalContainer = Object.freeze({ current: ownerDocument.body });
  const root = createRoot(host);
  root.render(<Toaster portalContainer={portalContainer} toastManager={manager} timeout={0} />);
  return Object.freeze({
    manager,
    owners: new Set<SaveFailureToasterOwner>(),
    host,
    portalContainer,
    root,
  });
}

function scheduleSaveFailureToasterDisposal(
  ownerDocument: Document,
  entry: SaveFailureToasterEntry,
): void {
  pendingSaveFailureToasterDisposals.set(ownerDocument, entry);
  saveFailureToasterDisposalQueue.maybeExecute();
}

function registerSaveFailureToasterOwner(
  ownerDocument: Document,
  owner: SaveFailureToasterOwner,
): Readonly<{ readonly entry: SaveFailureToasterEntry; readonly unregister: () => void }> {
  const entry =
    saveFailureToastersByDocument.get(ownerDocument) ??
    createSaveFailureToasterEntry(ownerDocument);
  saveFailureToastersByDocument.set(ownerDocument, entry);
  entry.owners.add(owner);
  return Object.freeze({
    entry,
    unregister: () => {
      entry.owners.delete(owner);
      if (entry.owners.size === 0) scheduleSaveFailureToasterDisposal(ownerDocument, entry);
    },
  });
}

type BrunoTableEditModeControlProps = Readonly<{
  readonly runtime: BrunoTableEditMemoryRuntime;
}>;

export const BrunoTableEditModeControl: NamedExoticComponent<BrunoTableEditModeControlProps> = memo(
  function BrunoTableEditModeControl({ runtime }: BrunoTableEditModeControlProps): ReactElement {
    const id = useId();
    const descriptionId = `${id}-description`;
    const snapshot = useSyncExternalStore(
      runtime.subscribeMode,
      runtime.getModeSnapshot,
      runtime.getModeSnapshot,
    );
    return (
      <div>
        <label className="flex items-center justify-between gap-2 text-xs/relaxed" htmlFor={id}>
          <span>Batch editing</span>
          <Switch
            aria-describedby={!snapshot.canChange ? descriptionId : undefined}
            id={id}
            size="sm"
            checked={snapshot.mode === "batch"}
            disabled={!snapshot.canChange}
            onCheckedChange={(checked) => {
              runtime.requestMode(checked ? "batch" : "immediate");
            }}
          />
        </label>
        <span className="sr-only" id={descriptionId}>
          Finish or reset current edit work before changing Edit Mode.
        </span>
      </div>
    );
  },
);

const BrunoTableConflictCountStatus = memo(function BrunoTableConflictCountStatus({
  interactive,
  runtime,
}: {
  readonly interactive: boolean;
  readonly runtime: BrunoTableEditMemoryRuntime;
}): ReactElement {
  const count = useSyncExternalStore(
    runtime.subscribeConflictCount,
    runtime.getConflictCountSnapshot,
    runtime.getConflictCountSnapshot,
  );
  const canOpen = useSyncExternalStore(
    runtime.subscribeCanOpenConflictReview,
    runtime.getCanOpenConflictReviewSnapshot,
    runtime.getCanOpenConflictReviewSnapshot,
  );
  const reviewControlRef = useCallback(
    (element: HTMLButtonElement | null) =>
      element === null ? undefined : runtime.registerEditOwnedControl(element),
    [runtime],
  );
  if (count === 0) return <></>;
  const label = `${String(count)} ${count === 1 ? "conflict" : "conflicts"}`;
  return (
    <>
      {interactive ? (
        <Button
          data-bruno-cell-edit-owned-control=""
          data-bruno-table-review-focus="conflict"
          disabled={!canOpen}
          ref={reviewControlRef}
          size="sm"
          title={canOpen ? undefined : "Finish editing the active cell before reviewing conflicts"}
          variant="ghost"
          onClick={(event) => runtime.openConflictReview(event.currentTarget)}
        >
          {label}
        </Button>
      ) : (
        <span>{label}</span>
      )}
      <span aria-hidden="true"> · </span>
    </>
  );
});

const BrunoTableBlockedCountStatus = memo(function BrunoTableBlockedCountStatus({
  interactive,
  runtime,
}: {
  readonly interactive: boolean;
  readonly runtime: BrunoTableEditMemoryRuntime;
}): ReactElement {
  const count = useSyncExternalStore(
    runtime.subscribeBlockedCount,
    runtime.getBlockedCountSnapshot,
    runtime.getBlockedCountSnapshot,
  );
  const reviewControlRef = useCallback(
    (element: HTMLButtonElement | null) =>
      element === null ? undefined : runtime.registerEditOwnedControl(element),
    [runtime],
  );
  if (count === 0) return <></>;
  const label = `${String(count)} blocked ${count === 1 ? "change" : "changes"}`;
  return (
    <>
      {interactive ? (
        <Button
          data-bruno-cell-edit-owned-control=""
          data-bruno-table-review-focus="blocked"
          ref={reviewControlRef}
          size="sm"
          variant="ghost"
          onClick={(event) => runtime.openBlockedReview(event.currentTarget)}
        >
          {label}
        </Button>
      ) : (
        <span>{label}</span>
      )}
      <span aria-hidden="true"> · </span>
    </>
  );
});

const BrunoTableSaveWorkStatus = memo(function BrunoTableSaveWorkStatus({
  runtime,
}: {
  readonly runtime: BrunoTableEditMemoryRuntime;
}): ReactElement {
  const saveWork = useSyncExternalStore(
    runtime.subscribeSaveWork,
    runtime.getSaveWorkSnapshot,
    runtime.getSaveWorkSnapshot,
  );
  const saveWorkParts: string[] = [];
  if (saveWork.pendingImmediateCount > 0) {
    saveWorkParts.push(
      `${String(saveWork.pendingImmediateCount)} Immediate ${saveWork.pendingImmediateCount === 1 ? "save" : "saves"} pending`,
    );
  }
  if (saveWork.awaitingImmediateCount > 0) {
    saveWorkParts.push(
      `${String(saveWork.awaitingImmediateCount)} Immediate ${saveWork.awaitingImmediateCount === 1 ? "save" : "saves"} accepted · waiting for live confirmation`,
    );
  }
  if (saveWork.pendingBatchCount > 0) saveWorkParts.push("Batch save pending");
  if (saveWork.awaitingBatchCount > 0) {
    saveWorkParts.push(
      saveWork.awaitingBatchRowCount > 0
        ? `Batch save accepted · waiting for live confirmation · ${String(saveWork.awaitingBatchRowCount)} ${saveWork.awaitingBatchRowCount === 1 ? "row" : "rows"} remaining`
        : "Batch save accepted · waiting for live confirmation",
    );
  }
  if (saveWorkParts.length === 0) return <></>;
  return (
    <>
      <span>{saveWorkParts.join(" · ")}</span>
      <span aria-hidden="true"> · </span>
    </>
  );
});

const BrunoTableEditSummaryStatus = memo(function BrunoTableEditSummaryStatus({
  runtime,
}: {
  readonly runtime: BrunoTableEditMemoryRuntime;
}): ReactElement {
  const summary = useSyncExternalStore(
    runtime.subscribeEditSummary,
    runtime.getEditSummarySnapshot,
    runtime.getEditSummarySnapshot,
  );
  if (summary.pendingCount === 0 && summary.validationCount === 0) {
    return <span>No unsaved changes</span>;
  }
  return (
    <span>
      {summary.validationCount > 0 ? `${String(summary.validationCount)} invalid · ` : undefined}
      {summary.pendingCount > 0 ? `${String(summary.pendingCount)} unsaved` : undefined}
      {summary.pendingCount > 0
        ? ` ${summary.pendingCount === 1 ? "change" : "changes"}`
        : undefined}
    </span>
  );
});

const BrunoTablePendingEditStatus = memo(function BrunoTablePendingEditStatus({
  hasBlockedReview,
  hasConflictReview,
  runtime,
}: {
  readonly hasBlockedReview: boolean;
  readonly hasConflictReview: boolean;
  readonly runtime: BrunoTableEditMemoryRuntime;
}): ReactElement {
  return (
    <div aria-live="polite" className="flex items-center gap-2">
      <BrunoTableConflictCountStatus interactive={hasConflictReview} runtime={runtime} />
      <BrunoTableBlockedCountStatus interactive={hasBlockedReview} runtime={runtime} />
      <BrunoTableSaveWorkStatus runtime={runtime} />
      <BrunoTableEditSummaryStatus runtime={runtime} />
    </div>
  );
});

export type BrunoTableConflictReviewRenderer = (
  rows: readonly BrunoTableCellEditDraftReviewSourceRow[],
  selection: BrunoTableRowSelectionRuntime,
  resolve: (id: string, resolution: "mine" | "server") => void,
) => ReactNode;

export type BrunoTableBlockedReviewRenderer = (
  rows: readonly BrunoTableCellEditDraftReviewSourceRow[],
  selection: BrunoTableRowSelectionRuntime,
) => ReactNode;

const getSelectedConflictResolutionReason = (
  runtime: BrunoTableEditMemoryRuntime,
  ids: readonly string[],
  resolution: "mine" | "server",
  availabilityVersion: number,
): string | undefined => {
  // The value is intentionally read so live source changes recompute fresh Mine/Server reasons.
  void availabilityVersion;
  return ids
    .map((id) => {
      const availability = runtime.getConflictResolutionAvailabilitySnapshot(id);
      return resolution === "mine" ? availability.mineReason : availability.serverReason;
    })
    .find((reason) => reason !== undefined);
};

const BrunoTableConflictReview = memo(function BrunoTableConflictReview({
  runtime,
  renderReview,
}: Readonly<{
  readonly runtime: BrunoTableEditMemoryRuntime;
  readonly renderReview: BrunoTableConflictReviewRenderer;
}>): ReactElement {
  const snapshot = useSyncExternalStore(
    runtime.subscribeConflictReview,
    runtime.getConflictReviewSnapshot,
    runtime.getConflictReviewSnapshot,
  );
  useEffect(() => runtime.registerConflictReviewCommand(runtime.openConflictReview), [runtime]);
  return (
    <AlertDialog
      open={snapshot.open}
      onOpenChange={(open) => {
        if (!open && !snapshot.saving) runtime.closeConflictReview();
      }}
    >
      {snapshot.open ? (
        <BrunoTableConflictReviewContent runtime={runtime} renderReview={renderReview} />
      ) : null}
    </AlertDialog>
  );
});

const BrunoTableConflictReviewContent = memo(function BrunoTableConflictReviewContent({
  runtime,
  renderReview,
}: Readonly<{
  readonly runtime: BrunoTableEditMemoryRuntime;
  readonly renderReview: BrunoTableConflictReviewRenderer;
}>): ReactElement {
  const [selection] = useState(() => new BrunoTableRowSelectionRuntime([]));
  const snapshot = useSyncExternalStore(
    runtime.subscribeConflictReview,
    runtime.getConflictReviewSnapshot,
    runtime.getConflictReviewSnapshot,
  );
  const rows = useSyncExternalStore(
    runtime.subscribeConflictReviewRows,
    runtime.getConflictReviewRowsSnapshot,
    runtime.getConflictReviewRowsSnapshot,
  );
  useEffect(() => {
    if (rows.length === 0) selection.clear();
  }, [rows, selection]);
  const canSave = useSyncExternalStore(
    runtime.subscribeCanSave,
    runtime.getCanSaveSnapshot,
    runtime.getCanSaveSnapshot,
  );
  const editSummary = useSyncExternalStore(
    runtime.subscribeEditSummary,
    runtime.getEditSummarySnapshot,
    runtime.getEditSummarySnapshot,
  );
  const selectionHeader = useSyncExternalStore(
    selection.subscribeHeader,
    selection.getHeaderSnapshot,
    selection.getHeaderSnapshot,
  );
  const availabilityVersion = useSyncExternalStore(
    runtime.subscribeConflictResolutionAvailabilityVersion,
    runtime.getConflictResolutionAvailabilityVersionSnapshot,
    runtime.getConflictResolutionAvailabilityVersionSnapshot,
  );
  const resolveOne = useCallback(
    (id: string, resolution: "mine" | "server") => runtime.resolveConflictRows([id], resolution),
    [runtime],
  );
  const activeConflictIds = new Set(
    rows.flatMap((row) => (row.getSnapshot().conflict === undefined ? [] : [row.id])),
  );
  const selectedActiveConflictIds =
    selectionHeader.selectedCount === 0
      ? []
      : selection.getSelectedRowIds().filter((id) => activeConflictIds.has(id));
  const selectedMineReason = getSelectedConflictResolutionReason(
    runtime,
    selectedActiveConflictIds,
    "mine",
    availabilityVersion,
  );
  const selectedServerReason = getSelectedConflictResolutionReason(
    runtime,
    selectedActiveConflictIds,
    "server",
    availabilityVersion,
  );
  const resolveSelected = (resolution: "mine" | "server") => {
    const [first, ...rest] = selectedActiveConflictIds;
    if (first !== undefined && runtime.resolveConflictRows([first, ...rest], resolution)) {
      selection.clear();
    }
  };
  const reviewSurfaceRef = useCallback(
    (element: HTMLDivElement | null) =>
      element === null ? undefined : runtime.registerEditOwnedControl(element),
    [runtime],
  );
  const reviewViewportRef = useReviewViewportRef();
  return (
    <AlertDialogContent
      data-bruno-cell-edit-owned-control=""
      ref={reviewSurfaceRef}
      className="max-w-5xl sm:max-w-5xl"
      style={{
        width: "min(64rem, calc(100vw - 2rem))",
        maxHeight: "calc(100vh - 2rem)",
        overflow: "hidden",
        gridTemplateRows: "auto minmax(0, 1fr) auto",
      }}
    >
      <AlertDialogHeader>
        <AlertDialogTitle>Conflict Review</AlertDialogTitle>
        <AlertDialogDescription>
          Choose Mine or Server for every conflicted cell. Live server updates invalidate an older
          choice so it can be reviewed again.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <div
        ref={reviewViewportRef}
        className="min-h-0 overflow-hidden"
        data-bruno-review-viewport=""
      >
        {renderReview(rows, selection, resolveOne)}
      </div>
      <AlertDialogFooter>
        <AlertDialogCancel disabled={snapshot.saving} onClick={runtime.closeConflictReview}>
          Cancel
        </AlertDialogCancel>
        <Button
          aria-label={`Apply Mine to Selected${selectedMineReason === undefined ? "" : `. ${selectedMineReason}`}`}
          disabled={selectedActiveConflictIds.length === 0 || selectedMineReason !== undefined}
          title={selectedMineReason}
          variant="outline"
          onClick={() => resolveSelected("mine")}
        >
          Apply Mine to Selected
        </Button>
        <Button
          aria-label={`Apply Server to Selected${selectedServerReason === undefined ? "" : `. ${selectedServerReason}`}`}
          disabled={selectedActiveConflictIds.length === 0 || selectedServerReason !== undefined}
          title={selectedServerReason}
          variant="outline"
          onClick={() => resolveSelected("server")}
        >
          Apply Server to Selected
        </Button>
        <Button
          disabled={
            snapshot.count > 0 ||
            (snapshot.resolutionCount === 0 && editSummary.pendingCount === 0) ||
            snapshot.saving ||
            (editSummary.pendingCount > 0 && !canSave)
          }
          onClick={runtime.saveConflictReview}
        >
          {snapshot.saving ? "Saving…" : "Save"}
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  );
});

type BrunoTableConflictReviewResolutionProps = Readonly<{
  readonly row: BrunoTableCellEditDraftReviewSourceRow;
  readonly runtime: BrunoTableEditMemoryRuntime;
  readonly resolve: (id: string, resolution: "mine" | "server") => void;
  readonly tableId?: string;
  readonly columnId?: string;
}>;

export const BrunoTableConflictReviewResolution: NamedExoticComponent<BrunoTableConflictReviewResolutionProps> =
  memo(function BrunoTableConflictReviewResolution({
    row,
    runtime,
    resolve,
    tableId,
    columnId,
  }: BrunoTableConflictReviewResolutionProps): ReactElement {
    const subscribe = useCallback(
      (listener: () => void) => {
        if (__BRUNO_TABLE_TEST_DIAGNOSTICS__ && tableId !== undefined && columnId !== undefined) {
          recordBrunoTableReviewCellSubscription({
            tableId,
            rowId: row.id,
            columnId,
            source: "review-resolution",
            phase: "subscribe",
          });
        }
        const unsubscribe = runtime.subscribeConflictResolutionControl(row.id, listener);
        return () => {
          unsubscribe();
          if (__BRUNO_TABLE_TEST_DIAGNOSTICS__ && tableId !== undefined && columnId !== undefined) {
            recordBrunoTableReviewCellSubscription({
              tableId,
              rowId: row.id,
              columnId,
              source: "review-resolution",
              phase: "unsubscribe",
            });
          }
        };
      },
      [columnId, row.id, runtime, tableId],
    );
    const getSnapshot = useCallback(
      () => runtime.getConflictResolutionControlSnapshot(row.id),
      [row.id, runtime],
    );
    const control = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const subscribeColumnLabel = useCallback(
      (listener: () => void) => row.subscribe(listener),
      [row],
    );
    const getColumnLabelSnapshot = useCallback(() => row.getSnapshot().columnLabel, [row]);
    const columnLabel = useSyncExternalStore(
      subscribeColumnLabel,
      getColumnLabelSnapshot,
      getColumnLabelSnapshot,
    );
    const { active, resolution } = control;
    const mineLabel = `Keep Mine for row ${row.rowId}, column ${columnLabel}`;
    const serverLabel = `Keep Server for row ${row.rowId}, column ${columnLabel}`;
    return (
      <div aria-label="Conflict resolution" className="flex items-center gap-1" role="group">
        <Button
          aria-label={`${mineLabel}${control.mineReason === undefined ? "" : `. ${control.mineReason}`}`}
          aria-pressed={resolution === "mine"}
          disabled={!active || !control.mineAvailable}
          size="sm"
          title={control.mineReason}
          variant={resolution === "mine" ? "default" : "outline"}
          onClick={() => resolve(row.id, "mine")}
          onPointerDown={(event) => event.stopPropagation()}
        >
          Mine
        </Button>
        <Button
          aria-label={`${serverLabel}${control.serverReason === undefined ? "" : `. ${control.serverReason}`}`}
          aria-pressed={resolution === "server"}
          disabled={!active || !control.serverAvailable}
          size="sm"
          title={control.serverReason}
          variant={resolution === "server" ? "default" : "outline"}
          onClick={() => resolve(row.id, "server")}
          onPointerDown={(event) => event.stopPropagation()}
        >
          Server
        </Button>
      </div>
    );
  });

const BrunoTableBlockedReview = memo(function BrunoTableBlockedReview({
  runtime,
  renderReview,
}: Readonly<{
  readonly runtime: BrunoTableEditMemoryRuntime;
  readonly renderReview: BrunoTableBlockedReviewRenderer;
}>): ReactElement {
  const snapshot = useSyncExternalStore(
    runtime.subscribeBlockedReview,
    runtime.getBlockedReviewSnapshot,
    runtime.getBlockedReviewSnapshot,
  );
  return (
    <AlertDialog
      open={snapshot.open}
      onOpenChange={(open) => {
        if (!open) runtime.closeBlockedReview();
      }}
    >
      {snapshot.open ? (
        <BrunoTableBlockedReviewContent runtime={runtime} renderReview={renderReview} />
      ) : null}
    </AlertDialog>
  );
});

const BrunoTableBlockedReviewContent = memo(function BrunoTableBlockedReviewContent({
  runtime,
  renderReview,
}: Readonly<{
  readonly runtime: BrunoTableEditMemoryRuntime;
  readonly renderReview: BrunoTableBlockedReviewRenderer;
}>): ReactElement {
  const [selection] = useState(() => new BrunoTableRowSelectionRuntime([]));
  const rows = useSyncExternalStore(
    runtime.subscribeBlockedReviewRows,
    runtime.getBlockedReviewRowsSnapshot,
    runtime.getBlockedReviewRowsSnapshot,
  );
  const saveWork = useSyncExternalStore(
    runtime.subscribeSaveWork,
    runtime.getSaveWorkSnapshot,
    runtime.getSaveWorkSnapshot,
  );
  useEffect(() => {
    if (rows.length === 0) selection.clear();
  }, [rows, selection]);
  const selectionHeader = useSyncExternalStore(
    selection.subscribeHeader,
    selection.getHeaderSnapshot,
    selection.getHeaderSnapshot,
  );
  const selectedIds = selectionHeader.selectedCount === 0 ? [] : selection.getSelectedRowIds();
  const saveWorkActive =
    saveWork.pendingBatchCount > 0 ||
    saveWork.awaitingBatchCount > 0 ||
    saveWork.pendingImmediateCount > 0 ||
    saveWork.awaitingImmediateCount > 0;
  const selectedBlockedChangesDiscardable =
    !saveWorkActive &&
    selectedIds.length > 0 &&
    selectedIds.every(runtime.isBlockedChangeDiscardable);
  const reviewSurfaceRef = useCallback(
    (element: HTMLDivElement | null) =>
      element === null ? undefined : runtime.registerEditOwnedControl(element),
    [runtime],
  );
  const reviewViewportRef = useReviewViewportRef();
  return (
    <AlertDialogContent
      data-bruno-cell-edit-owned-control=""
      ref={reviewSurfaceRef}
      className="max-w-5xl sm:max-w-5xl"
      style={{
        width: "min(64rem, calc(100vw - 2rem))",
        maxHeight: "calc(100vh - 2rem)",
        overflow: "hidden",
        gridTemplateRows: "auto minmax(0, 1fr) auto",
      }}
    >
      <AlertDialogHeader>
        <AlertDialogTitle>Blocked Changes Review</AlertDialogTitle>
        <AlertDialogDescription>
          These changes cannot currently be saved. Select only the changes you want to discard.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <div
        ref={reviewViewportRef}
        className="min-h-0 overflow-hidden"
        data-bruno-review-viewport=""
      >
        {renderReview(rows, selection)}
      </div>
      {rows.length === 0 ? <p role="status">All blocked changes are current.</p> : null}
      <AlertDialogFooter>
        {selectedIds.length > 0 && !selectedBlockedChangesDiscardable ? (
          <p role="status">
            {saveWorkActive
              ? "Wait for the current save to finish before discarding these changes."
              : "Finish or cancel the active edit before discarding it."}
          </p>
        ) : null}
        <AlertDialogCancel onClick={runtime.closeBlockedReview}>Close</AlertDialogCancel>
        <Button
          disabled={!selectedBlockedChangesDiscardable}
          variant="destructive"
          onClick={() => {
            const [first, ...rest] = selectedIds;
            if (first !== undefined && runtime.discardBlockedChanges([first, ...rest])) {
              selection.clear();
            }
          }}
        >
          Discard Selected Changes
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  );
});

const BrunoTableResetEditsButton = memo(function BrunoTableResetEditsButton({
  dispatchGridCommand,
  runtime,
}: {
  readonly dispatchGridCommand: (command: BrunoTableGridCommand) => boolean;
  readonly runtime: BrunoTableEditMemoryRuntime;
}): ReactElement {
  const canReset = useSyncExternalStore(
    runtime.subscribeCanReset,
    runtime.getCanResetSnapshot,
    runtime.getCanResetSnapshot,
  );
  const resetControlRef = useCallback(
    (element: HTMLButtonElement | null) =>
      element === null ? undefined : runtime.registerEditOwnedControl(element),
    [runtime],
  );
  return (
    <Button
      aria-label="Reset edits"
      data-bruno-cell-edit-cancel=""
      data-bruno-cell-edit-owned-control=""
      ref={resetControlRef}
      variant="outline"
      disabled={!canReset}
      onClick={() => dispatchGridCommand({ type: "edits.reset" })}
    >
      Reset
    </Button>
  );
});

const BrunoTableResetReview = memo(function BrunoTableResetReview({
  runtime,
  renderReview,
}: {
  readonly runtime: BrunoTableEditMemoryRuntime;
  readonly renderReview: (rows: readonly BrunoTableCellEditDraftReviewSourceRow[]) => ReactNode;
}): ReactElement {
  const snapshot = useSyncExternalStore(
    runtime.subscribeResetReview,
    runtime.getResetReviewSnapshot,
    runtime.getResetReviewSnapshot,
  );
  return (
    <AlertDialog
      open={snapshot.open}
      onOpenChange={(open) => {
        if (!open) runtime.closeResetReview();
      }}
    >
      {snapshot.open ? (
        <BrunoTableResetReviewContent
          runtime={runtime}
          pendingCount={snapshot.pendingCount}
          historyCount={snapshot.historyCount}
          canResetAll={snapshot.canResetAll}
          renderReview={renderReview}
        />
      ) : null}
    </AlertDialog>
  );
});

const BrunoTableResetReviewContent = memo(function BrunoTableResetReviewContent({
  runtime,
  pendingCount,
  historyCount,
  canResetAll,
  renderReview,
}: {
  readonly runtime: BrunoTableEditMemoryRuntime;
  readonly pendingCount: number;
  readonly historyCount: number;
  readonly canResetAll: boolean;
  readonly renderReview: (rows: readonly BrunoTableCellEditDraftReviewSourceRow[]) => ReactNode;
}): ReactElement {
  const descriptionId = useId();
  const rows = useSyncExternalStore(
    runtime.subscribeResetReviewRows,
    runtime.getResetReviewRowsSnapshot,
    runtime.getResetReviewRowsSnapshot,
  );
  const resetSurfaceRef = useCallback(
    (element: HTMLDivElement | null) =>
      element === null ? undefined : runtime.registerEditOwnedControl(element),
    [runtime],
  );
  const pendingLabel = `${String(pendingCount)} pending changed ${pendingCount === 1 ? "cell" : "cells"}`;
  const historyLabel = `${String(historyCount)} Batch history ${historyCount === 1 ? "command" : "commands"}`;
  return (
    <AlertDialogContent
      data-bruno-cell-edit-owned-control=""
      ref={resetSurfaceRef}
      className="max-w-4xl sm:max-w-4xl"
      style={{
        width: "min(56rem, calc(100vw - 2rem))",
        maxHeight: "calc(100vh - 2rem)",
        overflow: "auto",
      }}
    >
      <AlertDialogHeader>
        <AlertDialogTitle>Reset Review</AlertDialogTitle>
        <AlertDialogDescription id={descriptionId}>
          <span>{pendingLabel}</span>. <span>{historyLabel}</span>. Review these changes before
          discarding them.
        </AlertDialogDescription>
      </AlertDialogHeader>
      {renderReview(rows)}
      <AlertDialogFooter>
        <AlertDialogCancel onClick={runtime.closeResetReview}>Keep Editing</AlertDialogCancel>
        <AlertDialogAction
          aria-describedby={descriptionId}
          disabled={!canResetAll}
          variant="destructive"
          onClick={() => {
            runtime.confirmResetAllChanges();
          }}
        >
          Reset All Changes
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  );
});

const BrunoTableSaveEditsButton = memo(function BrunoTableSaveEditsButton({
  runtime,
}: {
  readonly runtime: BrunoTableEditMemoryRuntime;
}): ReactElement {
  const canSave = useSyncExternalStore(
    runtime.subscribeCanSave,
    runtime.getCanSaveSnapshot,
    runtime.getCanSaveSnapshot,
  );
  return (
    <Button disabled={!canSave} onClick={runtime.requestSave}>
      Save
    </Button>
  );
});

const BrunoTableSaveFailure = memo(function BrunoTableSaveFailure({
  runtime,
}: {
  readonly runtime: BrunoTableEditMemoryRuntime;
}): ReactElement | null {
  const detailsContent = useRef<HTMLDivElement>(null);
  const detailsOpenRef = useRef(false);
  const [detailsOpen, setDetailsOpenState] = useState(false);
  const setDetailsOpen = useCallback((open: boolean) => {
    detailsOpenRef.current = open;
    setDetailsOpenState(open);
  }, []);
  const subscribeFailureSummary = useCallback(
    (listener: () => void) =>
      runtime.subscribeSaveFailureSummary(() => {
        if (runtime.getSaveFailureSummarySnapshot().count === 0 && detailsOpenRef.current) {
          const content = detailsContent.current;
          const restoreGridFocus =
            content !== null && content.contains(content.ownerDocument.activeElement);
          setDetailsOpen(false);
          if (restoreGridFocus) runtime.requestGridFocus();
        }
        listener();
      }),
    [runtime, setDetailsOpen],
  );
  const failure = useSyncExternalStore(
    subscribeFailureSummary,
    runtime.getSaveFailureSummarySnapshot,
    runtime.getSaveFailureSummarySnapshot,
  );
  const [toasterOwnerToken] = useState<SaveFailureToasterOwner>(() => Object.freeze({}));
  const toasterAnchor = useRef<HTMLSpanElement>(null);
  const [toasterEntry, setToasterEntry] = useState<SaveFailureToasterEntry>();
  const [toastId] = useState(
    () => `bruno-table-save-failure-${String((saveFailureToastIdSequence += 1))}`,
  );
  const programmaticToastClose = useRef(false);
  useEffect(() => {
    const ownerDocument = toasterAnchor.current?.ownerDocument;
    if (ownerDocument === undefined) return;
    const registration = registerSaveFailureToasterOwner(ownerDocument, toasterOwnerToken);
    setToasterEntry(registration.entry);
    return registration.unregister;
  }, [toasterOwnerToken]);
  useEffect(() => {
    if (toasterEntry === undefined) return;
    if (failure.count === 0) {
      programmaticToastClose.current = true;
      toasterEntry.manager.close(toastId);
      programmaticToastClose.current = false;
      return;
    }
    toasterEntry.manager.add({
      id: toastId,
      title:
        failure.count === 1
          ? "A save operation failed."
          : `${String(failure.count)} save operations failed.`,
      description:
        failure.count === 1
          ? "Open Operation details for the complete explanation."
          : "Open Operation details for the complete explanations.",
      actionProps: {
        children: "Operation details",
        onClick: () => setDetailsOpen(true),
      },
      timeout: 0,
      priority: "high",
      type: "error",
      onClose: () => {
        if (programmaticToastClose.current) return;
        setDetailsOpen(false);
        runtime.dismissSaveFailures();
      },
    });
  }, [failure, runtime, setDetailsOpen, toastId, toasterEntry]);
  useEffect(
    () => () => {
      if (toasterEntry === undefined) return;
      programmaticToastClose.current = true;
      toasterEntry.manager.close(toastId);
      programmaticToastClose.current = false;
    },
    [toastId, toasterEntry],
  );
  return (
    <>
      <span aria-hidden="true" className="hidden" ref={toasterAnchor} />
      <AlertDialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        {detailsOpen ? (
          <BrunoTableSaveFailureDetails
            contentRef={detailsContent}
            portalContainer={toasterEntry?.portalContainer}
            runtime={runtime}
          />
        ) : null}
      </AlertDialog>
    </>
  );
});

const BrunoTableSaveFailureDetails = memo(function BrunoTableSaveFailureDetails({
  contentRef,
  portalContainer,
  runtime,
}: {
  readonly contentRef: RefObject<HTMLDivElement | null>;
  readonly portalContainer: RefObject<HTMLElement | null> | undefined;
  readonly runtime: BrunoTableEditMemoryRuntime;
}): ReactElement {
  const failure = useSyncExternalStore(
    runtime.subscribeSaveFailure,
    runtime.getSaveFailureSnapshot,
    runtime.getSaveFailureSnapshot,
  );
  return (
    <AlertDialogContent
      ref={contentRef}
      portalContainer={portalContainer}
      className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden"
    >
      <AlertDialogHeader>
        <AlertDialogTitle>Save operation details</AlertDialogTitle>
        <AlertDialogDescription>
          These saves were not confirmed. Live source convergence can still clear each result.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <ScrollArea className="min-h-0 max-h-[min(60dvh,32rem)]">
        <ul className="flex list-disc flex-col gap-1 py-1 ps-5 pe-4 text-sm">
          {failure.operations.map((operation, index) => (
            <li key={operation.operationId}>
              <p>
                Operation {String(index + 1)}: {operation.message}
              </p>
              <ul className="mt-1 flex list-[circle] flex-col gap-1 ps-5">
                {operation.rows.flatMap((row) =>
                  row.cells.map((cell) => (
                    <li key={JSON.stringify([row.rowId, cell.columnId])}>
                      Row {row.rowId}, column {cell.columnId} (field {cell.field}).
                    </li>
                  )),
                )}
              </ul>
            </li>
          ))}
        </ul>
      </ScrollArea>
      <AlertDialogFooter>
        <AlertDialogCancel>Close details</AlertDialogCancel>
      </AlertDialogFooter>
    </AlertDialogContent>
  );
});

type BrunoTableEditSafetyFooterProps = Readonly<{
  readonly dispatchGridCommand: (command: BrunoTableGridCommand) => boolean;
  readonly runtime: BrunoTableEditMemoryRuntime;
  readonly renderReview: (rows: readonly BrunoTableCellEditDraftReviewSourceRow[]) => ReactNode;
  readonly renderConflictReview?: BrunoTableConflictReviewRenderer | undefined;
  readonly renderBlockedReview?: BrunoTableBlockedReviewRenderer | undefined;
  readonly tableId: string;
}>;

export const BrunoTableEditSafetyFooter: NamedExoticComponent<BrunoTableEditSafetyFooterProps> =
  memo(function BrunoTableEditSafetyFooter({
    dispatchGridCommand,
    runtime,
    renderReview,
    renderConflictReview,
    renderBlockedReview,
    tableId,
  }: BrunoTableEditSafetyFooterProps): ReactElement {
    if (__BRUNO_TABLE_TEST_DIAGNOSTICS__) {
      recordBrunoTableClientEditFooterRender(tableId);
    }
    return (
      <footer
        aria-label="Edit safety"
        className="relative flex min-w-0 items-center justify-between gap-3 border-t bg-background px-3.5 py-2 text-xs/relaxed"
        role="region"
      >
        <BrunoTableSaveFailure runtime={runtime} />
        <BrunoTablePendingEditStatus
          hasBlockedReview={renderBlockedReview !== undefined}
          hasConflictReview={renderConflictReview !== undefined}
          runtime={runtime}
        />
        <div className="flex items-center gap-2">
          <BrunoTableResetEditsButton dispatchGridCommand={dispatchGridCommand} runtime={runtime} />
          <BrunoTableSaveEditsButton runtime={runtime} />
        </div>
        <BrunoTableResetReview runtime={runtime} renderReview={renderReview} />
        {renderConflictReview === undefined ? null : (
          <BrunoTableConflictReview runtime={runtime} renderReview={renderConflictReview} />
        )}
        {renderBlockedReview === undefined ? null : (
          <BrunoTableBlockedReview runtime={runtime} renderReview={renderBlockedReview} />
        )}
      </footer>
    );
  });
