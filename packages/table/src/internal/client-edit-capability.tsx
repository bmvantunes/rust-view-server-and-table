import { useQueuer } from "@tanstack/react-pacer";
import { useLayoutEffect, type ComponentType, type ReactNode } from "react";

import type {
  BrunoTableCellEditDraftReviewSourceRow,
  BrunoTableCellEditRuntime,
} from "./cell-edit";
import { BrunoTableCellEditBoundary } from "./cell-edit-boundary";
import { BrunoTableCellEditGeometryController } from "./cell-edit-geometry";
import {
  BrunoTablePasteRuntime,
  brunoTablePasteDiagnosticFromCellEdit,
  createBrunoTablePasteDiagnostic,
  createBrunoTablePasteCoordinateEvidence,
  createBrunoTablePasteGesture,
  isBrunoTablePasteTargetCurrent,
  planBrunoTablePaste,
  projectBrunoTablePasteTarget,
  sameBrunoTablePasteTarget,
} from "./cell-paste";
import { BrunoTablePasteChrome } from "./cell-paste-chrome";
import { BrunoTableDragFillRuntime, addBrunoTableDragFillRejectionEvidence } from "./drag-fill";
import { BrunoTableDragFillChrome } from "./drag-fill-chrome";
import {
  BrunoTableEditSafetyFooter,
  type BrunoTableBlockedReviewRenderer,
  type BrunoTableConflictReviewRenderer,
} from "./edit-chrome";
import type { BrunoTableEditMemoryRuntime } from "./edit-memory";

/** Private Client-only dependency bundle for edit workflows in the shared renderer. */
export type BrunoTableEditCapability = Readonly<{
  readonly cellEdit?: BrunoTableCellEditRuntime | undefined;
  readonly editMemory?: BrunoTableEditMemoryRuntime | undefined;
  readonly renderResetReview: (
    rows: readonly BrunoTableCellEditDraftReviewSourceRow[],
  ) => ReactNode;
  readonly renderConflictReview?: BrunoTableConflictReviewRenderer | undefined;
  readonly renderBlockedReview?: BrunoTableBlockedReviewRenderer | undefined;
  readonly CellEditBoundary: typeof BrunoTableCellEditBoundary;
  readonly PasteChrome: typeof BrunoTablePasteChrome;
  readonly DragFillChrome: typeof BrunoTableDragFillChrome;
  readonly EditSafetyFooter: typeof BrunoTableEditSafetyFooter;
  readonly createPasteRuntime: (focusFallback: () => void) => BrunoTablePasteRuntime;
  readonly createDragFillRuntime: (tableId: string) => BrunoTableDragFillRuntime;
  readonly createEditGeometry: () => BrunoTableCellEditGeometryController;
  readonly paste: Readonly<{
    readonly fromCellEdit: typeof brunoTablePasteDiagnosticFromCellEdit;
    readonly diagnostic: typeof createBrunoTablePasteDiagnostic;
    readonly coordinateEvidence: typeof createBrunoTablePasteCoordinateEvidence;
    readonly gesture: typeof createBrunoTablePasteGesture;
    readonly isTargetCurrent: typeof isBrunoTablePasteTargetCurrent;
    readonly plan: typeof planBrunoTablePaste;
    readonly projectTarget: typeof projectBrunoTablePasteTarget;
    readonly sameTarget: typeof sameBrunoTablePasteTarget;
  }>;
  readonly addDragFillRejectionEvidence: typeof addBrunoTableDragFillRejectionEvidence;
  readonly TraversalQueueProvider: ComponentType<
    Readonly<{
      readonly callback: (version: number) => void;
      readonly onQueue: (
        queue: Readonly<{
          readonly addItem: (item: number) => boolean;
          readonly clear: () => void;
        }>,
      ) => void;
    }>
  >;
}>;

function BrunoTableTraversalQueueProvider({
  callback,
  onQueue,
}: {
  readonly callback: (version: number) => void;
  readonly onQueue: (
    queue: Readonly<{
      readonly addItem: (item: number) => boolean;
      readonly clear: () => void;
    }>,
  ) => void;
}): null {
  const queue = useQueuer<number>(callback, {
    key: "bruno-table-editable-traversal",
    maxSize: 1,
    started: true,
    wait: 1,
  });
  useLayoutEffect(() => {
    onQueue(queue);
    return () => {
      onQueue(Object.freeze({ addItem: () => false, clear: () => undefined }));
    };
  }, [onQueue, queue]);
  return null;
}

/** Construct the Client-only implementation once at the variant boundary. */
export function createBrunoTableClientEditCapability(
  props: Pick<
    BrunoTableEditCapability,
    "cellEdit" | "editMemory" | "renderResetReview" | "renderConflictReview" | "renderBlockedReview"
  >,
): BrunoTableEditCapability {
  return Object.freeze({
    ...props,
    CellEditBoundary: BrunoTableCellEditBoundary,
    PasteChrome: BrunoTablePasteChrome,
    DragFillChrome: BrunoTableDragFillChrome,
    EditSafetyFooter: BrunoTableEditSafetyFooter,
    createPasteRuntime: (focusFallback) => new BrunoTablePasteRuntime(focusFallback),
    createDragFillRuntime: (tableId) => new BrunoTableDragFillRuntime(tableId),
    createEditGeometry: () => new BrunoTableCellEditGeometryController(),
    paste: Object.freeze({
      fromCellEdit: brunoTablePasteDiagnosticFromCellEdit,
      diagnostic: createBrunoTablePasteDiagnostic,
      coordinateEvidence: createBrunoTablePasteCoordinateEvidence,
      gesture: createBrunoTablePasteGesture,
      isTargetCurrent: isBrunoTablePasteTargetCurrent,
      plan: planBrunoTablePaste,
      projectTarget: projectBrunoTablePasteTarget,
      sameTarget: sameBrunoTablePasteTarget,
    }),
    addDragFillRejectionEvidence: addBrunoTableDragFillRejectionEvidence,
    TraversalQueueProvider: BrunoTableTraversalQueueProvider,
  });
}
