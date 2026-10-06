import { describe, expect, it } from "vitest";

import {
  BRUNO_TABLE_BASE_HOTKEY_REGISTRATION_COUNT,
  BRUNO_TABLE_CELL_EDITOR_HOTKEY_REGISTRATION_COUNT,
  BRUNO_TABLE_EDIT_MEMORY_HOTKEY_REGISTRATION_COUNT,
  BRUNO_TABLE_ESCAPE_HOTKEYS,
  BRUNO_TABLE_FILTER_WORKFLOW_HOTKEY_REGISTRATION_COUNT,
  BRUNO_TABLE_GRID_DOCUMENT_ESCAPE_HOTKEY_REGISTRATION_COUNT,
  BRUNO_TABLE_GRID_HOTKEYS,
  BRUNO_TABLE_GRID_LOCAL_HOTKEY_REGISTRATION_COUNT,
  BRUNO_TABLE_GROUP_BY_HOTKEY_REGISTRATION_COUNT,
  BRUNO_TABLE_PASTE_HOTKEY_REGISTRATION_COUNT,
  BRUNO_TABLE_REACT_HOTKEY_REGISTRATION_COUNT,
  BRUNO_TABLE_ROW_SELECTION_HOTKEYS,
  BRUNO_TABLE_ROW_SELECTION_HOTKEY_REGISTRATION_COUNT,
  brunoTableHotkeyRegistrationBound,
} from "./hotkey-adapter";

describe("BrunoTable hotkey Adapter contract", () => {
  it("keeps one table registration set bounded independently of rendered geometry", () => {
    expect(BRUNO_TABLE_GRID_HOTKEYS).toContain("Mod+ArrowUp");
    expect(BRUNO_TABLE_GRID_HOTKEYS).toContain("Mod+ArrowDown");
    expect(BRUNO_TABLE_GRID_HOTKEYS).toContain("Escape");
    expect(BRUNO_TABLE_GRID_HOTKEYS).toContain("Mod+C");
    expect(BRUNO_TABLE_GRID_HOTKEYS).not.toContain("Mod+A");
    expect(BRUNO_TABLE_ROW_SELECTION_HOTKEYS).toEqual(["Mod+A"]);
    expect(new Set(BRUNO_TABLE_GRID_HOTKEYS).size).toBe(BRUNO_TABLE_GRID_HOTKEYS.length);
    expect(brunoTableHotkeyRegistrationBound(1, 1)).toBe(
      brunoTableHotkeyRegistrationBound(10_000, 1_000),
    );
  });

  it("does not admit a per-cell, per-row, or per-header registration dimension", () => {
    expect(BRUNO_TABLE_ESCAPE_HOTKEYS).toHaveLength(16);
    expect(BRUNO_TABLE_GRID_HOTKEYS).toHaveLength(60);
    expect(BRUNO_TABLE_GRID_LOCAL_HOTKEY_REGISTRATION_COUNT).toBe(44);
    expect(BRUNO_TABLE_GRID_DOCUMENT_ESCAPE_HOTKEY_REGISTRATION_COUNT).toBe(16);
    expect(BRUNO_TABLE_REACT_HOTKEY_REGISTRATION_COUNT).toBe(60);
    expect(BRUNO_TABLE_BASE_HOTKEY_REGISTRATION_COUNT).toBe(60);
    expect(BRUNO_TABLE_ROW_SELECTION_HOTKEY_REGISTRATION_COUNT).toBe(1);
    expect(BRUNO_TABLE_FILTER_WORKFLOW_HOTKEY_REGISTRATION_COUNT).toBe(1);
    expect(BRUNO_TABLE_GROUP_BY_HOTKEY_REGISTRATION_COUNT).toBe(2);
    expect(BRUNO_TABLE_CELL_EDITOR_HOTKEY_REGISTRATION_COUNT).toBe(5);
    expect(BRUNO_TABLE_EDIT_MEMORY_HOTKEY_REGISTRATION_COUNT).toBe(3);
    expect(BRUNO_TABLE_PASTE_HOTKEY_REGISTRATION_COUNT).toBe(1);
    expect(brunoTableHotkeyRegistrationBound(0, 0)).toBe(
      BRUNO_TABLE_BASE_HOTKEY_REGISTRATION_COUNT,
    );
    expect(brunoTableHotkeyRegistrationBound(0, 0, 1)).toBe(
      BRUNO_TABLE_BASE_HOTKEY_REGISTRATION_COUNT +
        BRUNO_TABLE_FILTER_WORKFLOW_HOTKEY_REGISTRATION_COUNT,
    );
    expect(brunoTableHotkeyRegistrationBound(0, 0, 0, true)).toBe(
      BRUNO_TABLE_BASE_HOTKEY_REGISTRATION_COUNT +
        BRUNO_TABLE_ROW_SELECTION_HOTKEY_REGISTRATION_COUNT,
    );
    expect(brunoTableHotkeyRegistrationBound(0, 0, 0, false, true)).toBe(
      BRUNO_TABLE_BASE_HOTKEY_REGISTRATION_COUNT + BRUNO_TABLE_GROUP_BY_HOTKEY_REGISTRATION_COUNT,
    );
    expect(brunoTableHotkeyRegistrationBound(0, 0, 0, false, false, true)).toBe(
      BRUNO_TABLE_BASE_HOTKEY_REGISTRATION_COUNT +
        BRUNO_TABLE_CELL_EDITOR_HOTKEY_REGISTRATION_COUNT,
    );
    expect(brunoTableHotkeyRegistrationBound(0, 0, 0, false, false, false, true)).toBe(
      BRUNO_TABLE_BASE_HOTKEY_REGISTRATION_COUNT +
        BRUNO_TABLE_EDIT_MEMORY_HOTKEY_REGISTRATION_COUNT,
    );
    expect(brunoTableHotkeyRegistrationBound(0, 0, 0, false, false, false, true, true)).toBe(
      BRUNO_TABLE_BASE_HOTKEY_REGISTRATION_COUNT +
        BRUNO_TABLE_EDIT_MEMORY_HOTKEY_REGISTRATION_COUNT +
        BRUNO_TABLE_PASTE_HOTKEY_REGISTRATION_COUNT,
    );
  });
});
