import { describe, expect, it } from "vitest";
import { installTableScopedListener } from "./listener-registry";

describe("installTableScopedListener", () => {
  it("keeps duplicate registrations alive until every disposer runs", () => {
    const listenersByTableId = new Map<string, Set<() => void>>();
    const listener = () => undefined;
    let installs = 0;
    let removals = 0;

    const disposeFirst = installTableScopedListener(
      listenersByTableId,
      "table",
      listener,
      () => {
        installs += 1;
      },
      () => {
        removals += 1;
      },
    );
    const disposeSecond = installTableScopedListener(
      listenersByTableId,
      "table",
      listener,
      () => {
        installs += 1;
      },
      () => {
        removals += 1;
      },
    );

    expect(installs).toBe(2);
    expect(listenersByTableId.get("table")?.has(listener)).toBe(true);

    disposeFirst();
    expect(removals).toBe(1);
    expect(listenersByTableId.get("table")?.has(listener)).toBe(true);

    disposeFirst();
    expect(removals).toBe(1);
    expect(listenersByTableId.get("table")?.has(listener)).toBe(true);

    disposeSecond();
    expect(removals).toBe(2);
    expect(listenersByTableId.has("table")).toBe(false);

    disposeSecond();
    expect(removals).toBe(2);
  });
});
