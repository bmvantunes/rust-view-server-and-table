import * as React from "react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";

import {
  createToastManager,
  Toast,
  ToastAction,
  ToastClose,
  ToastContent,
  ToastDescription,
  ToastPortal,
  ToastProvider,
  ToastTitle,
  ToastViewport,
  Toaster,
  useToastManager,
} from "./toast";

afterEach(async () => {
  vi.useRealTimers();
  await cleanup();
});

function ToastHarness({
  toastManager,
  timeout,
  children,
}: {
  toastManager: ReturnType<typeof createToastManager>;
  timeout?: number;
  children?: React.ReactNode;
}) {
  return (
    <>
      {children}
      <Toaster toastManager={toastManager} timeout={timeout} />
    </>
  );
}

function addPersistentToast(
  toastManager: ReturnType<typeof createToastManager>,
  title = "Save failed",
  id?: string,
) {
  return toastManager.add({
    id,
    title,
    description: "The save was not confirmed.",
    timeout: 0,
    type: "error",
  });
}

function CompoundToastList() {
  const { toasts } = useToastManager();

  return toasts.map((toastItem) => (
    <Toast key={toastItem.id} toast={toastItem}>
      <ToastContent>
        <div>
          <ToastTitle />
          <ToastDescription />
        </div>
        <ToastAction />
        <ToastClose />
      </ToastContent>
    </Toast>
  ));
}

function CompoundToastHarness({
  toastManager,
  timeout,
}: {
  toastManager: ReturnType<typeof createToastManager>;
  timeout?: number;
}) {
  return (
    <ToastProvider toastManager={toastManager} timeout={timeout}>
      <ToastPortal>
        <ToastViewport>
          <CompoundToastList />
        </ToastViewport>
      </ToastPortal>
    </ToastProvider>
  );
}

describe("persistent toast accessibility", () => {
  test("supports a portal container in another document", async () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    let screen: Awaited<ReturnType<typeof render>> | undefined;
    try {
      const ownerDocument = frame.contentDocument;
      if (ownerDocument === null) throw new Error("Expected a same-origin iframe document.");
      const toastManager = createToastManager();
      screen = await render(
        <Toaster
          portalContainer={{ current: ownerDocument.body }}
          toastManager={toastManager}
          timeout={0}
        />,
      );

      toastManager.add({
        title: "Secondary document failure",
        description: "The save was not confirmed.",
        timeout: 0,
        type: "error",
        priority: "high",
      });

      await expect
        .poll(() => ownerDocument.body.textContent?.includes("Secondary document failure"))
        .toBe(true);
      expect(document.body.textContent).not.toContain("Secondary document failure");
      const close = ownerDocument.querySelector<HTMLButtonElement>(
        'button[aria-label="Close toast"]',
      );
      if (close === null) throw new Error("Expected the secondary-document Close control.");
      const toastRoot = close.closest<HTMLElement>('[data-slot="toast"]');
      if (toastRoot === null) throw new Error("Expected the secondary-document toast root.");
      close.focus({ focusVisible: true });
      expect(close.matches(":focus-visible")).toBe(true);
      await expect.poll(() => toastRoot.getAttribute("role")).toBe("alertdialog");
      await expect.poll(() => ownerDocument.activeElement).toBe(close);
      ownerDocument.body.tabIndex = -1;
      ownerDocument.body.focus();
      await expect.poll(() => toastRoot.getAttribute("role")).toBe("presentation");
    } finally {
      await screen?.unmount();
      frame.remove();
    }
  });

  test("keeps the public compound Close control accessible", async () => {
    const toastManager = createToastManager();
    const screen = await render(<CompoundToastHarness toastManager={toastManager} />);

    toastManager.add({
      title: "Compound failure",
      description: "The compound save was not confirmed.",
      timeout: 0,
      type: "error",
      actionProps: { children: "View details" },
    });

    const toast = screen.getByRole("dialog", { name: "Compound failure" });
    await expect.element(toast.getByRole("button", { name: "View details" })).toBeInTheDocument();
    await expect
      .element(toast.getByRole("button", { name: "Close toast" }))
      .toHaveAttribute("aria-hidden", "false");
  });

  test("keeps timeout-zero failures until explicit dismissal or replacement", async () => {
    const toastManager = createToastManager();
    const screen = await render(<ToastHarness toastManager={toastManager} />);

    vi.useFakeTimers();
    addPersistentToast(toastManager, "Save failed", "save-failure");
    const failure = screen.getByRole("dialog", { name: "Save failed" });
    await expect.element(failure).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(6000);
    await expect.element(failure).toBeInTheDocument();
    vi.useRealTimers();

    toastManager.add({
      id: "save-failure",
      title: "Save recovered",
      description: "The owning workflow replaced the failure.",
      timeout: 0,
      type: "success",
    });

    await expect
      .element(screen.getByRole("dialog", { name: "Save recovered" }))
      .toBeInTheDocument();
    await expect
      .element(screen.getByRole("dialog", { name: "Save failed" }))
      .not.toBeInTheDocument();
  });

  test("keeps timeout-enabled collapsed Close controls under Base UI ownership", async () => {
    const toastManager = createToastManager();
    const screen = await render(<ToastHarness toastManager={toastManager} />);

    toastManager.add({
      title: "Saved",
      description: "The save completed.",
      timeout: 5000,
      type: "success",
    });

    const toast = screen.getByRole("dialog", { name: "Saved" });
    await expect.element(toast).toBeInTheDocument();
    await expect
      .element(toast.getByRole("button", { name: "Close toast", includeHidden: true }))
      .toHaveAttribute("aria-hidden", "true");
  });

  test("keeps workflow-persistent loading Close controls accessible", async () => {
    const toastManager = createToastManager();
    const screen = await render(<ToastHarness toastManager={toastManager} />);

    toastManager.add({
      title: "Saving",
      description: "The save is still running.",
      timeout: 5000,
      type: "loading",
    });

    const toast = screen.getByRole("dialog", { name: "Saving" });
    await expect.element(toast).toBeInTheDocument();
    await expect
      .element(toast.getByRole("button", { name: "Close toast", includeHidden: true }))
      .toHaveAttribute("aria-hidden", "false");
  });

  test("preserves generic persistent toast actions without coupling them to Close", async () => {
    const toastManager = createToastManager();
    const action = vi.fn();
    const screen = await render(<ToastHarness toastManager={toastManager} />);

    toastManager.add({
      title: "Save failed",
      description: "The save was not confirmed.",
      timeout: 0,
      type: "error",
      actionProps: { children: "View details", onClick: action },
    });
    const toast = screen.getByRole("dialog", { name: "Save failed" });
    await expect.element(toast.getByRole("button", { name: "View details" })).toBeInTheDocument();
    await toast.getByRole("button", { name: "Close toast" }).click();
    expect(action).not.toHaveBeenCalled();
  });

  test("keeps inherited timeout-zero and loading Close controls accessible", async () => {
    const toastManager = createToastManager();
    const screen = await render(<ToastHarness toastManager={toastManager} timeout={0} />);

    toastManager.add({
      title: "Inherited failure",
      description: "The provider made this toast persistent.",
      type: "error",
    });
    toastManager.add({
      title: "Saving",
      description: "The save is still running.",
      type: "loading",
    });

    for (const title of ["Inherited failure", "Saving"]) {
      const toast = screen.getByRole("dialog", { name: title });
      await expect.element(toast).toBeInTheDocument();
      await expect
        .element(toast.getByRole("button", { name: "Close toast" }))
        .toHaveAttribute("aria-hidden", "false");
    }
  });

  test("keeps a high-priority persistent Close control accessible with one alert announcement", async () => {
    const toastManager = createToastManager();
    const screen = await render(<ToastHarness toastManager={toastManager} />);

    toastManager.add({
      title: "Save failed",
      description: "The save was not confirmed.",
      timeout: 0,
      type: "error",
      priority: "high",
    });

    const close = screen.getByRole("button", { name: "Close toast" });
    await expect.element(close).toBeInTheDocument();
    const root = close.element().parentElement?.parentElement;
    expect(root?.getAttribute("role")).toBe("presentation");
    expect(root?.getAttribute("tabindex")).toBe("-1");
    expect(root?.getAttribute("aria-hidden")).toBe("false");
    expect(root?.getAttribute("aria-live")).toBe("off");
    const alert = screen.getByRole("alert");
    expect(alert.length).toBe(1);
    await expect.element(alert).toHaveTextContent("Save failed");
    await expect.element(alert).toHaveTextContent("The save was not confirmed.");
    await expect
      .element(screen.getByRole("dialog", { name: "Save failed" }))
      .not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("alertdialog", { name: "Save failed" }))
      .not.toBeInTheDocument();
  });

  test("scopes high-priority alert-dialog semantics to the focused toast", async () => {
    const toastManager = createToastManager();
    const screen = await render(<ToastHarness toastManager={toastManager} />);
    toastManager.add({
      title: "First save failed",
      description: "The first save was not confirmed.",
      timeout: 0,
      type: "error",
      priority: "high",
    });
    toastManager.add({
      title: "Second save failed",
      description: "The second save was not confirmed.",
      timeout: 0,
      type: "error",
      priority: "high",
    });

    await expect
      .element(screen.getByRole("heading", { name: "First save failed" }))
      .toBeInTheDocument();
    await expect
      .element(screen.getByRole("heading", { name: "Second save failed" }))
      .toBeInTheDocument();

    const focusedRoot = screen
      .getByRole("heading", { name: "First save failed" })
      .element()
      .closest<HTMLElement>('[data-slot="toast"]');
    const otherRoot = screen
      .getByRole("heading", { name: "Second save failed" })
      .element()
      .closest<HTMLElement>('[data-slot="toast"]');
    if (focusedRoot === null || otherRoot === null) throw new Error("Expected both toast roots.");
    const close = focusedRoot.querySelector<HTMLButtonElement>('button[aria-label="Close toast"]');
    if (close === null) throw new Error("Expected the focused toast Close control.");
    close.focus({ focusVisible: true });

    await expect.poll(() => focusedRoot.getAttribute("role")).toBe("alertdialog");
    expect(otherRoot.getAttribute("role")).toBe("presentation");
    await expect
      .element(screen.getByRole("alertdialog"))
      .toHaveAccessibleDescription("The first save was not confirmed.");
    expect(screen.getByRole("alertdialog").all()).toHaveLength(1);
    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  });

  test.each(["pointer", "Enter", "Space"] as const)(
    "dismisses a persistent toast with %s without invoking its action",
    async (method) => {
      const toastManager = createToastManager();
      const retry = vi.fn();
      const screen = await render(<ToastHarness toastManager={toastManager} />);
      toastManager.add({
        title: "Save failed",
        description: "The save was not confirmed.",
        timeout: 0,
        type: "error",
        actionProps: { children: "Retry", onClick: retry },
      });

      const close = screen.getByRole("button", { name: "Close toast" });
      await expect.element(close).toBeInTheDocument();
      await expect.element(close).toHaveAttribute("aria-hidden", "false");
      close.element().focus();
      await expect.element(close).toHaveFocus();
      if (method === "pointer") {
        await close.click();
      } else {
        close.element().focus();
        await userEvent.keyboard(`{${method}}`);
      }

      await expect
        .element(screen.getByRole("dialog", { name: "Save failed" }))
        .not.toBeInTheDocument();
      expect(retry).not.toHaveBeenCalled();
    },
  );

  test("dismisses a persistent toast with the documented Escape interaction", async () => {
    const toastManager = createToastManager();
    const retry = vi.fn();
    const screen = await render(<ToastHarness toastManager={toastManager} />);

    toastManager.add({
      title: "Save failed",
      description: "The save was not confirmed.",
      timeout: 0,
      type: "error",
      actionProps: { children: "Retry", onClick: retry },
    });
    const failure = screen.getByRole("dialog", { name: "Save failed" });
    await expect.element(failure).toBeInTheDocument();
    failure.element().focus();
    await userEvent.keyboard("{Escape}");

    await expect.element(failure).not.toBeInTheDocument();
    expect(retry).not.toHaveBeenCalled();
  });

  test("announces an error title and explanation once without an alert duplicate", async () => {
    const toastManager = createToastManager();
    const screen = await render(<ToastHarness toastManager={toastManager} />);

    addPersistentToast(toastManager);
    const failure = screen.getByRole("dialog", { name: "Save failed" });
    await expect.element(failure).toBeInTheDocument();
    await expect.element(failure).toHaveAccessibleDescription("The save was not confirmed.");
    await expect.element(failure).toHaveAttribute("aria-labelledby");
    await expect.element(failure).toHaveAttribute("aria-describedby");
    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();

    const viewport = screen.getByRole("region", { name: "Notifications" });
    await expect.element(viewport).toHaveAttribute("aria-live", "polite");
    await expect.element(viewport).toHaveAttribute("aria-atomic", "false");
    await expect.element(viewport).toHaveAttribute("aria-relevant", "additions text");
  });

  test("keeps one accessible Close control for every persistent toast in collapsed and expanded stacks", async () => {
    const toastManager = createToastManager();
    const screen = await render(<ToastHarness toastManager={toastManager} />);

    for (const title of ["First failure", "Second failure", "Third failure"]) {
      addPersistentToast(toastManager, title);
    }

    const viewport = screen.getByRole("region", { name: "Notifications" });
    for (const title of ["First failure", "Second failure", "Third failure"]) {
      const toast = screen.getByRole("dialog", { name: title });
      await expect.element(toast).toBeInTheDocument();
      await expect.element(toast.getByRole("button", { name: "Close toast" })).toBeInTheDocument();
    }
    const frontmostToast = screen.getByRole("dialog", { name: "Third failure" });
    await expect.element(frontmostToast).not.toHaveAttribute("data-expanded", "");
    let closeButtons = viewport.getByRole("button", { name: "Close toast" });
    expect(closeButtons.length).toBe(3);
    for (const button of closeButtons.all()) {
      await expect.element(button).toHaveAttribute("aria-hidden", "false");
    }

    await frontmostToast.hover();
    await expect.element(frontmostToast).toHaveAttribute("data-expanded", "");
    closeButtons = viewport.getByRole("button", { name: "Close toast" });
    expect(closeButtons.length).toBe(3);
    for (const button of closeButtons.all()) {
      await expect.element(button).toHaveAttribute("aria-hidden", "false");
    }
  });

  test("dismisses each Close control in an expanded persistent stack independently", async () => {
    const toastManager = createToastManager();
    const screen = await render(<ToastHarness toastManager={toastManager} />);
    const titles = ["First failure", "Second failure", "Third failure"];
    const expandedTitles = [...titles].reverse();

    for (const title of titles) {
      addPersistentToast(toastManager, title);
    }

    await screen.getByRole("dialog", { name: "Third failure" }).hover();
    for (const [index, title] of expandedTitles.entries()) {
      const toast = screen.getByRole("dialog", { name: title });
      await toast.getByRole("button", { name: "Close toast" }).click();
      await expect.element(toast).not.toBeInTheDocument();

      for (const remainingTitle of expandedTitles.slice(index + 1)) {
        await expect
          .element(screen.getByRole("dialog", { name: remainingTitle }))
          .toBeInTheDocument();
      }
    }
  });
});
