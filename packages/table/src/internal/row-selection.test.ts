import { describe, expect, it, vi } from "vitest";

import { BrunoTableRowSelectionRuntime } from "./row-selection";

describe("BrunoTableRowSelectionRuntime", () => {
  it("selects ordinary rows by stable identity and applies inclusive Shift ranges", () => {
    const selection = new BrunoTableRowSelectionRuntime(["a", "b", "c", "d"]);

    expect(selection.toggleRow("b", true, false)).toEqual({ kind: "single", checked: true });
    expect(selection.toggleRow("d", true, true)).toEqual({
      kind: "range",
      checked: true,
      startIndex: 1,
      endIndex: 3,
      rowCount: 3,
    });

    expect(selection.getSelectedRowIds()).toEqual(["b", "c", "d"]);
    expect(selection.getAnchorRowId()).toBe("d");

    expect(selection.toggleRow("b", false, true)).toEqual({
      kind: "range",
      checked: false,
      startIndex: 1,
      endIndex: 3,
      rowCount: 3,
    });
    expect(selection.getSelectedRowIds()).toEqual([]);
    expect(selection.getAnchorRowId()).toBe("b");
  });

  it("clears a retained Shift anchor when selection is already empty", () => {
    const selection = new BrunoTableRowSelectionRuntime(["a", "b", "c"]);
    selection.toggleRow("b", true, false);
    selection.toggleRow("b", false, false);
    expect(selection.getSelectedRowIds()).toEqual([]);
    expect(selection.getAnchorRowId()).toBe("b");

    expect(selection.clear()).toBe(0);

    expect(selection.getAnchorRowId()).toBeUndefined();
    expect(selection.toggleRow("c", true, true)).toEqual({ kind: "single", checked: true });
  });

  it("keeps hidden selected identities while Select All follows the current projection", () => {
    const selection = new BrunoTableRowSelectionRuntime(["a", "b", "c"]);
    selection.toggleRow("b", true, false);
    selection.reconcile(["a", "b", "c"], ["a", "c"]);

    expect(selection.getSelectedRowIds()).toEqual(["b"]);
    expect(selection.getHeaderSnapshot()).toMatchObject({
      checked: false,
      mixed: false,
      disabled: false,
    });

    selection.toggleAll(true);
    expect(selection.getSelectedRowIds()).toEqual(["a", "b", "c"]);
    expect(selection.getHeaderSnapshot()).toMatchObject({ checked: true, mixed: false });

    selection.toggleAll(false);
    expect(selection.getSelectedRowIds()).toEqual(["b"]);
  });

  it("prunes deleted identities, clears a missing anchor, and does not revive reappearing rows", () => {
    const selection = new BrunoTableRowSelectionRuntime(["a", "b", "c"]);
    selection.toggleRow("b", true, false);

    selection.reconcile(["a", "c"], ["a", "c"]);
    expect(selection.getSelectedRowIds()).toEqual([]);
    expect(selection.getAnchorRowId()).toBeUndefined();

    selection.reconcile(["a", "b", "c"], ["a", "b", "c"]);
    expect(selection.getRowSnapshot("b")).toBe(false);
  });

  it("retains a filtered stable anchor and reuses it after the row returns", () => {
    const selection = new BrunoTableRowSelectionRuntime(["a", "b", "c"]);
    selection.toggleRow("a", true, false);
    selection.reconcile(["a", "b", "c"], ["b", "c"]);

    expect(selection.getAnchorRowId()).toBe("a");
    selection.reconcile(["a", "b", "c"], ["c", "b", "a"]);
    selection.toggleRow("c", true, true);

    expect(selection.getSelectedRowIds()).toEqual(["a", "b", "c"]);
  });

  it("falls back deterministically when the stable anchor is outside the projection", () => {
    const selection = new BrunoTableRowSelectionRuntime(["a", "b", "c"]);
    selection.toggleRow("a", true, false);
    selection.reconcile(["a", "b", "c"], ["b", "c"]);

    expect(selection.toggleRow("c", true, true)).toEqual({ kind: "single", checked: true });

    expect(selection.getSelectedRowIds()).toEqual(["a", "c"]);
    expect(selection.getAnchorRowId()).toBe("c");
  });

  it("publishes only the narrow row and header surfaces whose snapshots change", () => {
    const selection = new BrunoTableRowSelectionRuntime(["a", "b"]);
    const header = vi.fn();
    const rowA = vi.fn();
    const rowB = vi.fn();
    selection.subscribeHeader(header);
    selection.subscribeRow("a", rowA);
    selection.subscribeRow("b", rowB);

    selection.reconcile(["a", "b"], ["a", "b"]);
    expect(header).not.toHaveBeenCalled();
    expect(rowA).not.toHaveBeenCalled();
    expect(rowB).not.toHaveBeenCalled();

    for (let publication = 0; publication < 20; publication += 1) {
      selection.reconcile(Array.from(["a", "b"]), Array.from(["a", "b"]));
    }
    expect(header).not.toHaveBeenCalled();
    expect(rowA).not.toHaveBeenCalled();
    expect(rowB).not.toHaveBeenCalled();

    selection.toggleRow("a", true, false);
    expect(header).toHaveBeenCalledTimes(1);
    expect(rowA).toHaveBeenCalledTimes(1);
    expect(rowB).not.toHaveBeenCalled();
  });

  it("uses a stable private source token to bypass unchanged source identity enumeration", () => {
    const rowIds = ["a", "b", "c"];
    const selection = new BrunoTableRowSelectionRuntime(rowIds);
    const sourceToken = Object.freeze({});
    let sourceVisits = 0;
    const instrumentedSource = new Proxy(rowIds, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^(0|[1-9]\d*)$/u.test(property)) sourceVisits += 1;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    selection.reconcile(instrumentedSource, rowIds, sourceToken);
    expect(sourceVisits).toBeGreaterThan(0);
    sourceVisits = 0;

    selection.reconcile(instrumentedSource, Array.from(rowIds), sourceToken);

    expect(sourceVisits).toBe(0);
  });

  it("does zero projected work for an already-satisfied Select All command", () => {
    const selection = new BrunoTableRowSelectionRuntime(["a", "b", "c"]);
    const header = vi.fn();
    const row = vi.fn();
    selection.subscribeHeader(header);
    selection.subscribeRow("a", row);

    expect(selection.toggleAll(true)).toBe(3);
    header.mockClear();
    row.mockClear();

    expect(selection.toggleAll(true)).toBe(0);
    expect(header).not.toHaveBeenCalled();
    expect(row).not.toHaveBeenCalled();

    expect(selection.toggleAll(false)).toBe(3);
    header.mockClear();
    row.mockClear();

    expect(selection.toggleAll(false)).toBe(0);
    expect(header).not.toHaveBeenCalled();
    expect(row).not.toHaveBeenCalled();
  });

  it("clears selection and its anchor before a future grouped projection and restores empty", () => {
    const selection = new BrunoTableRowSelectionRuntime(["a", "b"]);
    selection.toggleRow("a", true, false);

    selection.enterGroupedProjection();
    expect(selection.getSelectedRowIds()).toEqual([]);
    expect(selection.getAnchorRowId()).toBeUndefined();
    expect(selection.getCapabilitySnapshot()).toEqual({ enabled: false });

    selection.toggleRow("a", true, false);
    selection.toggleAll(true);
    selection.reconcile(["a", "b", "c"], ["a", "b", "c"]);
    expect(selection.getSelectedRowIds()).toEqual([]);
    expect(selection.getAnchorRowId()).toBeUndefined();
    expect(selection.getHeaderSnapshot()).toMatchObject({ disabled: true, rowCount: 0 });

    selection.leaveGroupedProjection(["a", "b"]);
    expect(selection.getCapabilitySnapshot()).toEqual({ enabled: true });
    expect(selection.getSelectedRowIds()).toEqual([]);
  });

  it("disables Select All for an empty projection", () => {
    const selection = new BrunoTableRowSelectionRuntime([]);
    expect(selection.getHeaderSnapshot()).toEqual({
      checked: false,
      mixed: false,
      disabled: true,
      selectedCount: 0,
      rowCount: 0,
    });
  });
});
