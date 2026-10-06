import { Alert, AlertDescription, AlertTitle } from "@bruno/shadcn/alert";
import { Button } from "@bruno/shadcn/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@bruno/shadcn/empty";
import { Spinner } from "@bruno/shadcn/spinner";
import { memo, useLayoutEffect, useRef, useSyncExternalStore } from "react";

import type { NamedExoticComponent, ReactElement, ReactNode } from "react";

import type { BrunoTableChromeSnapshot, BrunoTableRuntimeView } from "./grid-runtime";

type RuntimeProps = {
  readonly runtime: BrunoTableRuntimeView;
  readonly focusFallback: () => void;
};

export function SourceLifecycle({ runtime, focusFallback }: RuntimeProps): ReactElement | null {
  const chrome = useSyncExternalStore(
    runtime.subscribeChrome,
    runtime.getChromeSnapshot,
    runtime.getChromeSnapshot,
  );

  if (chrome.invalid?.kind === "row-count-mismatch" && chrome.status !== "stale") {
    return (
      <Alert variant="destructive">
        <AlertTitle>Incomplete source</AlertTitle>
        <AlertDescription>
          Expected {String(chrome.invalid.expectedRows)} rows but received{" "}
          {String(chrome.invalid.receivedRows)}.
        </AlertDescription>
      </Alert>
    );
  }

  if (chrome.status === "stale") {
    return (
      <LifecycleAlert
        title="Live data delayed"
        {...lifecycleDetails(chrome.message, chrome.statusCode, chrome.invalid)}
        focusFallback={focusFallback}
      />
    );
  }
  if (chrome.status === "closed" && chrome.hasCoherentRows) {
    return (
      <LifecycleAlert
        title="Live updates stopped"
        {...lifecycleDetails(chrome.message, chrome.statusCode, chrome.invalid)}
        {...(chrome.retry === undefined ? {} : { retry: chrome.retry })}
        onRetry={runtime.retry}
        focusFallback={focusFallback}
      />
    );
  }
  if (chrome.status === "error" && chrome.hasCoherentRows) {
    return (
      <LifecycleAlert
        title="Live data error"
        destructive
        {...lifecycleDetails(chrome.message, chrome.statusCode, chrome.invalid)}
        {...(chrome.retry === undefined ? {} : { retry: chrome.retry })}
        onRetry={runtime.retry}
        focusFallback={focusFallback}
      />
    );
  }
  if (
    (chrome.invalid?.kind === "invalid-value" || chrome.invalid?.kind === "invalid-group") &&
    chrome.status !== "closed" &&
    chrome.status !== "error"
  ) {
    return (
      <Alert variant="destructive">
        <AlertTitle>
          {chrome.invalid.kind === "invalid-group"
            ? "Invalid grouped result"
            : "Invalid source value"}
        </AlertTitle>
        <AlertDescription>{invalidSourceDetails(chrome.invalid)}</AlertDescription>
      </Alert>
    );
  }
  return null;
}

function lifecycleDetails(
  message: string | undefined,
  statusCode: string | undefined,
  invalid: BrunoTableChromeSnapshot["invalid"],
) {
  const details = [message, statusCode, invalidSourceDetails(invalid)].filter(
    (detail): detail is string => detail !== undefined && detail.length > 0,
  );
  return details.length === 0 ? {} : { message: details.join(" · ") };
}

function LifecycleAlert({
  title,
  message,
  destructive = false,
  retry,
  onRetry,
  focusFallback,
}: {
  readonly title: string;
  readonly message?: string;
  readonly destructive?: boolean;
  readonly retry?: { readonly pending: boolean };
  readonly onRetry?: () => void;
  readonly focusFallback: () => void;
}) {
  return (
    <Alert variant={destructive ? "destructive" : "default"}>
      <AlertTitle>{title}</AlertTitle>
      {message !== undefined ? <AlertDescription>{message}</AlertDescription> : null}
      {retry !== undefined && onRetry !== undefined ? (
        <FocusFallbackOnUnmount focusFallback={focusFallback}>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={retry.pending}
            focusableWhenDisabled
            onClick={onRetry}
          >
            {retry.pending ? <Spinner data-icon="inline-start" /> : null}
            Retry
          </Button>
        </FocusFallbackOnUnmount>
      ) : null}
    </Alert>
  );
}

export const EmptySourceBody: NamedExoticComponent<RuntimeProps> = memo(function EmptySourceBody({
  runtime,
  focusFallback,
}: RuntimeProps): ReactElement {
  const chrome = useSyncExternalStore(
    runtime.subscribeChrome,
    runtime.getChromeSnapshot,
    runtime.getChromeSnapshot,
  );
  const title = emptyTitle(chrome.status);
  const announcement =
    chrome.status === "closed" ? "status" : chrome.status === "error" ? "alert" : "region";
  const retry = chrome.status === "closed" || chrome.status === "error" ? chrome.retry : undefined;
  return (
    <Empty
      aria-label={announcement === "region" ? title : undefined}
      className={announcement === "alert" ? "border-destructive text-destructive" : undefined}
      role={announcement}
    >
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>
          {emptyDescription(chrome) ?? "No rows are available for this table."}
        </EmptyDescription>
      </EmptyHeader>
      {retry !== undefined ? (
        <EmptyContent>
          <FocusFallbackOnUnmount focusFallback={focusFallback}>
            <Button
              type="button"
              variant="outline"
              disabled={retry.pending}
              focusableWhenDisabled
              onClick={runtime.retry}
            >
              {retry.pending ? <Spinner data-icon="inline-start" /> : null}
              Retry
            </Button>
          </FocusFallbackOnUnmount>
        </EmptyContent>
      ) : null}
    </Empty>
  );
});

function emptyTitle(status: BrunoTableChromeSnapshot["status"]): string {
  if (status === "closed") return "Live updates stopped";
  if (status === "error") return "Live data error";
  return "No rows";
}

function emptyDescription(chrome: BrunoTableChromeSnapshot): string | undefined {
  const details = [chrome.message, chrome.statusCode, invalidSourceDetails(chrome.invalid)].filter(
    (detail): detail is string => detail !== undefined && detail.length > 0,
  );
  return details.length === 0 ? undefined : details.join(" · ");
}

export function invalidSourceDetails(
  invalid: BrunoTableChromeSnapshot["invalid"],
): string | undefined {
  if (invalid?.kind === "invalid-value") {
    return `Source row ${String(invalid.rowIndex + 1)}, column ${invalid.columnId}: ${invalid.message}`;
  }
  if (invalid?.kind === "invalid-group") {
    return `Grouped result, column ${invalid.columnId}: ${invalid.message}`;
  }
  return invalid?.kind === "invalid-status"
    ? `Unsupported source status: ${invalid.receivedStatus}.`
    : invalid?.kind === "invalid-lifecycle"
      ? `Unreadable Client Source lifecycle field: ${invalid.field}.`
      : invalid?.kind === "invalid-rows"
        ? `Invalid Client Source rows: ${invalid.receivedRows}.`
        : invalid?.kind === "row-count-mismatch"
          ? `Expected ${String(invalid.expectedRows)} rows but received ${String(invalid.receivedRows)}.`
          : undefined;
}

function FocusFallbackOnUnmount({
  children,
  focusFallback,
}: {
  readonly children: ReactNode;
  readonly focusFallback: () => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    return () => {
      const activeElement = root?.ownerDocument.activeElement;
      if (
        root !== null &&
        activeElement !== undefined &&
        activeElement !== null &&
        root.contains(activeElement)
      ) {
        focusFallback();
      }
    };
  }, [focusFallback]);
  return (
    <span ref={ref} style={{ display: "contents" }}>
      {children}
    </span>
  );
}
