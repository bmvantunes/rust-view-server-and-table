export type BrunoTableToolbarProjection =
  | "result-row-count"
  | "loaded-row-count"
  | "active-filter-count"
  | "active-sort-count";

export type BrunoTableToolbarSubscriptionEvent = Readonly<{
  readonly tableId: string;
  readonly projection: BrunoTableToolbarProjection;
  readonly phase: "subscribe" | "unsubscribe" | "notify";
}>;

const subscriptionListeners = new Set<(event: BrunoTableToolbarSubscriptionEvent) => void>();
export type BrunoTableToolbarLifetimeEvent = Readonly<{
  readonly tableId: string;
  readonly kind:
    | "runtime-create"
    | "row-pipeline-subscribe"
    | "row-pipeline-unsubscribe"
    | "result-row-count-initialize"
    | "result-row-count-project";
  readonly identity: object;
}>;

const lifetimeListeners = new Set<(event: BrunoTableToolbarLifetimeEvent) => void>();

export function installBrunoTableToolbarSubscriptionListener(
  next: (event: BrunoTableToolbarSubscriptionEvent) => void,
): () => void {
  subscriptionListeners.add(next);
  return () => subscriptionListeners.delete(next);
}

export function installBrunoTableToolbarLifetimeListener(
  next: (event: BrunoTableToolbarLifetimeEvent) => void,
): () => void {
  lifetimeListeners.add(next);
  return () => lifetimeListeners.delete(next);
}

export function recordBrunoTableToolbarSubscription(
  event: BrunoTableToolbarSubscriptionEvent,
): void {
  for (const listener of subscriptionListeners) listener(event);
}

export function recordBrunoTableToolbarLifetime(event: BrunoTableToolbarLifetimeEvent): void {
  for (const listener of lifetimeListeners) listener(event);
}
