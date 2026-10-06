import { createToastManager, Toaster } from "@bruno/shadcn/toast";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";

import type { BrunoTableDragFillRuntime } from "./drag-fill";

export function BrunoTableDragFillChrome({
  runtime,
}: {
  readonly runtime: BrunoTableDragFillRuntime;
}): ReactElement {
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
  const programmaticClose = useRef(false);

  useEffect(() => {
    if (notification.sequence === 0) return;
    if (notification.message.length === 0) {
      programmaticClose.current = true;
      toastManager.close("bruno-table-drag-fill");
      programmaticClose.current = false;
      return;
    }
    toastManager.add({
      id: "bruno-table-drag-fill",
      title: "Fill rejected",
      description: notification.message,
      type: "error",
      timeout: 0,
      onClose: () => {
        if (programmaticClose.current) return;
        runtime.dismissNotification(notification.sequence);
      },
    });
  }, [notification, runtime, toastManager]);

  return (
    <>
      <span aria-hidden="true" ref={attachPortalAnchor} />
      {notification.sequence === 0 || notification.message.length === 0 ? null : (
        <Toaster portalContainer={portalContainer} toastManager={toastManager} timeout={0} />
      )}
    </>
  );
}
