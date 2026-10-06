import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@bruno/shadcn/alert-dialog";
import { Alert, AlertDescription } from "@bruno/shadcn/alert";
import { Button } from "@bruno/shadcn/button";
import { createToastManager, Toaster } from "@bruno/shadcn/toast";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";

import type { BrunoTablePasteRuntime } from "./cell-paste";
import { formatBrunoTablePasteCoordinateEvidence } from "./cell-paste";

export function BrunoTablePasteChrome({
  runtime,
}: {
  readonly runtime: BrunoTablePasteRuntime;
}): ReactElement {
  const snapshot = useSyncExternalStore(
    runtime.subscribe,
    runtime.getSnapshot,
    runtime.getSnapshot,
  );
  const notification = useSyncExternalStore(
    runtime.subscribeNotification,
    runtime.getNotificationSnapshot,
    runtime.getNotificationSnapshot,
  );
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);
  const attachPortalAnchor = useCallback((element: HTMLSpanElement | null) => {
    setPortalContainer(element?.ownerDocument.body ?? null);
  }, []);
  const [toastManager] = useState(() => createToastManager());
  const programmaticToastClose = useRef(false);
  const confirmation = snapshot.open ? snapshot.confirmation : undefined;
  useEffect(() => {
    if (notification.sequence === 0) return;
    if (notification.message.length === 0) {
      programmaticToastClose.current = true;
      toastManager.close("bruno-table-paste");
      programmaticToastClose.current = false;
      return;
    }
    toastManager.add({
      id: "bruno-table-paste",
      title: "Paste rejected",
      description: notification.message,
      type: "warning",
      timeout: 0,
      onClose: () => {
        if (programmaticToastClose.current) return;
        if (runtime.getNotificationSnapshot().message.length > 0) runtime.clearNotification();
      },
    });
  }, [notification, runtime, toastManager]);
  return (
    <>
      <span aria-hidden="true" ref={attachPortalAnchor} />
      {notification.sequence === 0 || notification.message.length === 0 ? null : (
        <Toaster portalContainer={portalContainer} toastManager={toastManager} timeout={0} />
      )}
      <AlertDialog
        open={snapshot.open}
        onOpenChange={(open) => {
          if (!open && runtime.getSnapshot().open) runtime.cancel();
        }}
      >
        <AlertDialogContent portalContainer={portalContainer}>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm paste</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmation === undefined
                ? "The clipboard shape does not match the current selection. Confirm the proposed linear destination before applying any values."
                : `The clipboard shape does not match the current selection. Copied: ${confirmation.copiedDescription}. Selected: ${confirmation.selectedDescription}. Proposed: ${confirmation.proposedDescription}. Start: ${formatBrunoTablePasteCoordinateEvidence(confirmation.startCoordinate)}. End: ${formatBrunoTablePasteCoordinateEvidence(confirmation.endCoordinate)}. Confirm the proposed linear destination before applying any values.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirmation === undefined ? null : (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs/relaxed">
              <dt>Copied</dt>
              <dd>{confirmation.copiedDescription}</dd>
              <dt>Selected</dt>
              <dd>{confirmation.selectedDescription}</dd>
              <dt>Proposed</dt>
              <dd>{confirmation.proposedDescription}</dd>
              <dt>Start</dt>
              <dd>{formatBrunoTablePasteCoordinateEvidence(confirmation.startCoordinate)}</dd>
              <dt>End</dt>
              <dd>{formatBrunoTablePasteCoordinateEvidence(confirmation.endCoordinate)}</dd>
            </dl>
          )}
          {snapshot.open && snapshot.error !== undefined ? (
            <Alert variant="destructive">
              <AlertDescription>{snapshot.error}</AlertDescription>
            </Alert>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => runtime.cancel()}>Cancel</AlertDialogCancel>
            <Button onClick={() => runtime.confirm()}>
              {confirmation === undefined
                ? "Paste"
                : `Paste ${String(confirmation.paste.canonicalTexts.length)} ${confirmation.paste.axis === "horizontal" ? "horizontally" : "vertically"}`}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
