import { describe, expect, it, vi } from "vitest";

import {
  installBrunoTableColumnCommandSubscriptionListener,
  recordBrunoTableColumnCommandSubscriptionNotification,
} from "./grid-subscription-instrumentation";

describe("column command subscription instrumentation", () => {
  it("keeps duplicate registrations active until every disposer runs", () => {
    const listener = vi.fn();
    const tableId = "TABLE_ID_DUPLICATE_COLUMN_SUBSCRIPTION";
    const disposeFirst = installBrunoTableColumnCommandSubscriptionListener(tableId, listener);
    const disposeSecond = installBrunoTableColumnCommandSubscriptionListener(tableId, listener);

    disposeFirst();
    recordBrunoTableColumnCommandSubscriptionNotification(tableId, "COL_ID_NAME", 1);
    expect(listener).toHaveBeenCalledTimes(1);

    disposeFirst();
    recordBrunoTableColumnCommandSubscriptionNotification(tableId, "COL_ID_NAME", 1);
    expect(listener).toHaveBeenCalledTimes(2);

    disposeSecond();
    recordBrunoTableColumnCommandSubscriptionNotification(tableId, "COL_ID_NAME", 1);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
