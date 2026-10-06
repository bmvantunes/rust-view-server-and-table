import {
  detectPlatform,
  getKeyStateTracker,
  useHotkeys,
  useKeyHold,
} from "@tanstack/react-hotkeys";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";

import type { Hotkey, RegisterableHotkey, UseHotkeyDefinition } from "@tanstack/react-hotkeys";
import type { RefCallback, RefObject } from "react";
import type { BrunoTableCellEditMovement } from "./cell-edit";
import type { BrunoTableNavigationCommand } from "./navigation";

// Supported by the manager and KeyboardEvent, but omitted from 0.10.0's
// closed Key union. Keep the compatibility assertion at this one Adapter seam.
export const BRUNO_TABLE_CONTEXT_MENU_HOTKEY = "ContextMenu" as RegisterableHotkey;

type BrunoTableHotkeyBinding = Readonly<{
  hotkey: RegisterableHotkey;
  allowInTextInput?: boolean;
  onTrigger: (event: BrunoTableHotkeyGesture) => void;
}>;

export type BrunoTableHotkeyGesture = Readonly<Pick<KeyboardEvent, "defaultPrevented" | "target">> &
  Pick<KeyboardEvent, "preventDefault">;

function brunoTableLiveHotkeyGesture(event: KeyboardEvent): BrunoTableHotkeyGesture {
  const gesture = {
    preventDefault: () => event.preventDefault(),
    target: event.target,
  } as BrunoTableHotkeyGesture;
  Object.defineProperty(gesture, "defaultPrevented", {
    configurable: false,
    enumerable: true,
    get: () => event.defaultPrevented,
  });
  return gesture;
}

export const BRUNO_TABLE_ESCAPE_HOTKEYS: readonly Hotkey[] = Object.freeze([
  "Escape",
  "Control+Escape",
  "Alt+Escape",
  "Shift+Escape",
  "Meta+Escape",
  "Control+Alt+Escape",
  "Control+Shift+Escape",
  "Control+Meta+Escape",
  "Alt+Shift+Escape",
  "Alt+Meta+Escape",
  "Shift+Meta+Escape",
  "Control+Alt+Shift+Escape",
  "Control+Alt+Meta+Escape",
  "Control+Shift+Meta+Escape",
  "Alt+Shift+Meta+Escape",
  "Control+Alt+Shift+Meta+Escape",
] satisfies readonly Hotkey[]);

export type BrunoTableGridHotkeyCommands = Readonly<{
  documentEscapeActive?: (() => boolean) | undefined;
  escape: (event: BrunoTableHotkeyGesture) => void;
  tab?: ((event: BrunoTableHotkeyGesture, direction: -1 | 1) => void) | undefined;
  shiftTab: (event: BrunoTableHotkeyGesture) => void;
  headerMenu: (event: BrunoTableHotkeyGesture) => void;
  copy: (event: BrunoTableHotkeyGesture) => void;
  paste?: ((event: BrunoTableHotkeyGesture) => void) | undefined;
  undo?: ((event: BrunoTableHotkeyGesture) => void) | undefined;
  redo?: ((event: BrunoTableHotkeyGesture) => void) | undefined;
  selectAll?: ((event: BrunoTableHotkeyGesture) => void) | undefined;
  resize: (
    event: BrunoTableHotkeyGesture,
    adjustment: "minimum" | "maximum" | -1 | 1,
    step: number,
    allowActiveHeader?: boolean,
  ) => void;
  activate: (
    event: BrunoTableHotkeyGesture,
    intent: "enter" | "f2" | "space",
    alt: boolean,
    shift: boolean,
  ) => void;
  navigate: (
    event: BrunoTableHotkeyGesture,
    command: BrunoTableNavigationCommand,
    extendCellRange?: boolean,
  ) => void;
  page: (event: BrunoTableHotkeyGesture, direction: -1 | 1, extendCellRange?: boolean) => void;
}>;

type BrunoTableDocumentEscapeRegistration = Readonly<{
  readonly owner: RefObject<HTMLElement | null>;
  readonly isActive: () => boolean;
}>;

const documentEscapeRegistrations = new WeakMap<
  Document,
  Set<BrunoTableDocumentEscapeRegistration>
>();

function activeDocumentEscapeRegistration(
  document: Document | undefined,
  eventTarget: EventTarget | null,
): BrunoTableDocumentEscapeRegistration | undefined {
  if (document === undefined) return undefined;
  const registrations = documentEscapeRegistrations.get(document) ?? [];
  const DocumentElement = document.defaultView?.Element;
  const targetBoundary =
    DocumentElement !== undefined && eventTarget instanceof DocumentElement
      ? eventTarget.closest("[data-bruno-table]")
      : null;
  if (targetBoundary !== null) {
    for (const registration of registrations) {
      if (
        registration.isActive() &&
        registration.owner.current?.closest("[data-bruno-table]") === targetBoundary
      ) {
        return registration;
      }
    }
    return undefined;
  }
  let soleActiveRegistration: BrunoTableDocumentEscapeRegistration | undefined;
  for (const registration of registrations) {
    if (!registration.isActive()) continue;
    if (soleActiveRegistration !== undefined) return undefined;
    soleActiveRegistration = registration;
  }
  return soleActiveRegistration;
}

function createBrunoTableGridHotkeyBindings(
  commands: BrunoTableGridHotkeyCommands,
): readonly BrunoTableHotkeyBinding[] {
  return [
    ...BRUNO_TABLE_ESCAPE_HOTKEYS.map((hotkey) => ({
      hotkey,
      allowInTextInput: true,
      onTrigger: commands.escape,
    })),
    {
      hotkey: "Tab",
      onTrigger: (event) => commands.tab?.(event, 1),
    },
    {
      hotkey: "Shift+Tab",
      allowInTextInput: true,
      onTrigger: (event) => {
        commands.tab?.(event, -1);
        if (!event.defaultPrevented) commands.shiftTab(event);
      },
    },
    { hotkey: "Shift+F10", onTrigger: commands.headerMenu },
    { hotkey: BRUNO_TABLE_CONTEXT_MENU_HOTKEY, onTrigger: commands.headerMenu },
    { hotkey: "Mod+C", onTrigger: commands.copy },
    ...(commands.paste === undefined
      ? []
      : ([{ hotkey: "Mod+V", allowInTextInput: false, onTrigger: commands.paste }] as const)),
    ...(commands.undo === undefined
      ? []
      : ([{ hotkey: "Mod+Z", onTrigger: commands.undo }] as const)),
    ...(commands.redo === undefined
      ? []
      : ([
          { hotkey: "Mod+Shift+Z", onTrigger: commands.redo },
          { hotkey: "Mod+Y", onTrigger: commands.redo },
        ] as const)),
    ...(commands.selectAll === undefined
      ? []
      : ([{ hotkey: "Mod+A", onTrigger: commands.selectAll }] as const)),
    {
      hotkey: "Alt+ArrowLeft",
      onTrigger: (event) => commands.resize(event, -1, 10, true),
    },
    {
      hotkey: "Alt+ArrowRight",
      onTrigger: (event) => commands.resize(event, 1, 10, true),
    },
    {
      hotkey: "Alt+Shift+ArrowLeft",
      onTrigger: (event) => commands.resize(event, -1, 50, true),
    },
    {
      hotkey: "Alt+Shift+ArrowRight",
      onTrigger: (event) => commands.resize(event, 1, 50, true),
    },
    {
      hotkey: "Enter",
      onTrigger: (event) => commands.activate(event, "enter", false, false),
    },
    {
      hotkey: "Shift+Enter",
      onTrigger: (event) => commands.activate(event, "enter", false, true),
    },
    {
      hotkey: "Alt+Enter",
      onTrigger: (event) => commands.activate(event, "enter", true, false),
    },
    {
      hotkey: "Alt+Shift+Enter",
      onTrigger: (event) => commands.activate(event, "enter", true, true),
    },
    {
      hotkey: "Space",
      onTrigger: (event) => commands.activate(event, "space", false, false),
    },
    {
      hotkey: "Shift+Space",
      onTrigger: (event) => commands.activate(event, "space", false, true),
    },
    { hotkey: "F2", onTrigger: (event) => commands.activate(event, "f2", false, false) },
    {
      hotkey: "ArrowUp",
      onTrigger: (event) => commands.navigate(event, { type: "step", direction: "up" }),
    },
    {
      hotkey: "ArrowDown",
      onTrigger: (event) => commands.navigate(event, { type: "step", direction: "down" }),
    },
    {
      hotkey: "ArrowLeft",
      onTrigger: (event) => {
        commands.resize(event, -1, 10);
        commands.navigate(event, { type: "step", direction: "left" });
      },
    },
    {
      hotkey: "ArrowRight",
      onTrigger: (event) => {
        commands.resize(event, 1, 10);
        commands.navigate(event, { type: "step", direction: "right" });
      },
    },
    {
      hotkey: "Shift+ArrowUp",
      onTrigger: (event) => commands.navigate(event, { type: "step", direction: "up" }, true),
    },
    {
      hotkey: "Shift+ArrowDown",
      onTrigger: (event) => commands.navigate(event, { type: "step", direction: "down" }, true),
    },
    {
      hotkey: "Shift+ArrowLeft",
      onTrigger: (event) => {
        commands.resize(event, -1, 50);
        commands.navigate(event, { type: "step", direction: "left" }, true);
      },
    },
    {
      hotkey: "Shift+ArrowRight",
      onTrigger: (event) => {
        commands.resize(event, 1, 50);
        commands.navigate(event, { type: "step", direction: "right" }, true);
      },
    },
    {
      hotkey: "Mod+ArrowUp",
      onTrigger: (event) => commands.navigate(event, { type: "column-edge", edge: "start" }),
    },
    {
      hotkey: "Mod+ArrowDown",
      onTrigger: (event) => commands.navigate(event, { type: "column-edge", edge: "end" }),
    },
    {
      hotkey: "Mod+ArrowLeft",
      onTrigger: (event) => {
        commands.resize(event, -1, 10);
        commands.navigate(event, { type: "row-edge", edge: "start" });
      },
    },
    {
      hotkey: "Mod+ArrowRight",
      onTrigger: (event) => {
        commands.resize(event, 1, 10);
        commands.navigate(event, { type: "row-edge", edge: "end" });
      },
    },
    {
      hotkey: "Mod+Shift+ArrowUp",
      onTrigger: (event) => commands.navigate(event, { type: "column-edge", edge: "start" }, true),
    },
    {
      hotkey: "Mod+Shift+ArrowDown",
      onTrigger: (event) => commands.navigate(event, { type: "column-edge", edge: "end" }, true),
    },
    {
      hotkey: "Mod+Shift+ArrowLeft",
      onTrigger: (event) => {
        commands.resize(event, -1, 50);
        commands.navigate(event, { type: "row-edge", edge: "start" }, true);
      },
    },
    {
      hotkey: "Mod+Shift+ArrowRight",
      onTrigger: (event) => {
        commands.resize(event, 1, 50);
        commands.navigate(event, { type: "row-edge", edge: "end" }, true);
      },
    },
    {
      hotkey: "Home",
      onTrigger: (event) => {
        commands.resize(event, "minimum", 0);
        commands.navigate(event, { type: "row-edge", edge: "start" });
      },
    },
    {
      hotkey: "End",
      onTrigger: (event) => {
        commands.resize(event, "maximum", 0);
        commands.navigate(event, { type: "row-edge", edge: "end" });
      },
    },
    {
      hotkey: "Shift+Home",
      onTrigger: (event) => {
        commands.resize(event, "minimum", 0);
        commands.navigate(event, { type: "row-edge", edge: "start" }, true);
      },
    },
    {
      hotkey: "Shift+End",
      onTrigger: (event) => {
        commands.resize(event, "maximum", 0);
        commands.navigate(event, { type: "row-edge", edge: "end" }, true);
      },
    },
    {
      hotkey: "Mod+Home",
      onTrigger: (event) => {
        commands.resize(event, "minimum", 0);
        commands.navigate(event, { type: "grid-edge", edge: "start" });
      },
    },
    {
      hotkey: "Mod+End",
      onTrigger: (event) => {
        commands.resize(event, "maximum", 0);
        commands.navigate(event, { type: "grid-edge", edge: "end" });
      },
    },
    {
      hotkey: "Mod+Shift+Home",
      onTrigger: (event) => {
        commands.resize(event, "minimum", 0);
        commands.navigate(event, { type: "grid-edge", edge: "start" }, true);
      },
    },
    {
      hotkey: "Mod+Shift+End",
      onTrigger: (event) => {
        commands.resize(event, "maximum", 0);
        commands.navigate(event, { type: "grid-edge", edge: "end" }, true);
      },
    },
    { hotkey: "PageUp", onTrigger: (event) => commands.page(event, -1) },
    { hotkey: "PageDown", onTrigger: (event) => commands.page(event, 1) },
    { hotkey: "Shift+PageUp", onTrigger: (event) => commands.page(event, -1, true) },
    { hotkey: "Shift+PageDown", onTrigger: (event) => commands.page(event, 1, true) },
  ];
}

const NOOP_GRID_COMMANDS: BrunoTableGridHotkeyCommands = Object.freeze({
  escape: () => undefined,
  shiftTab: () => undefined,
  headerMenu: () => undefined,
  copy: () => undefined,
  resize: () => undefined,
  activate: () => undefined,
  navigate: () => undefined,
  page: () => undefined,
});

export const BRUNO_TABLE_GRID_HOTKEYS: readonly RegisterableHotkey[] = Object.freeze(
  createBrunoTableGridHotkeyBindings(NOOP_GRID_COMMANDS).map((binding) => binding.hotkey),
);
export const BRUNO_TABLE_ROW_SELECTION_HOTKEYS: readonly RegisterableHotkey[] = Object.freeze([
  "Mod+A",
]);
export const BRUNO_TABLE_GRID_DOCUMENT_ESCAPE_HOTKEY_REGISTRATION_COUNT: number =
  BRUNO_TABLE_ESCAPE_HOTKEYS.length;
export const BRUNO_TABLE_GRID_LOCAL_HOTKEY_REGISTRATION_COUNT: number =
  BRUNO_TABLE_GRID_HOTKEYS.length - BRUNO_TABLE_GRID_DOCUMENT_ESCAPE_HOTKEY_REGISTRATION_COUNT;
export const BRUNO_TABLE_REACT_HOTKEY_REGISTRATION_COUNT: number = BRUNO_TABLE_GRID_HOTKEYS.length;
export const BRUNO_TABLE_BASE_HOTKEY_REGISTRATION_COUNT: number = BRUNO_TABLE_GRID_HOTKEYS.length;
export const BRUNO_TABLE_ROW_SELECTION_HOTKEY_REGISTRATION_COUNT: number =
  BRUNO_TABLE_ROW_SELECTION_HOTKEYS.length;
export const BRUNO_TABLE_FILTER_WORKFLOW_HOTKEY_REGISTRATION_COUNT: number = 1;
export const BRUNO_TABLE_GROUP_BY_HOTKEY_REGISTRATION_COUNT: number = 2;
export const BRUNO_TABLE_CELL_EDITOR_HOTKEY_REGISTRATION_COUNT: number = 5;
export const BRUNO_TABLE_EDIT_MEMORY_HOTKEY_REGISTRATION_COUNT: number = 3;
export const BRUNO_TABLE_PASTE_HOTKEY_REGISTRATION_COUNT: number = 1;

const BRUNO_TABLE_WORKFLOW_ACTIONS = new WeakMap<HTMLElement, () => void>();

export function registerBrunoTableHotkeyWorkflowAction(
  owner: HTMLElement,
  action: () => void,
): () => void {
  BRUNO_TABLE_WORKFLOW_ACTIONS.set(owner, action);
  return () => {
    if (BRUNO_TABLE_WORKFLOW_ACTIONS.get(owner) === action) {
      BRUNO_TABLE_WORKFLOW_ACTIONS.delete(owner);
    }
  };
}

export function requestBrunoTableHotkeyWorkflowAction(owner: HTMLElement): boolean {
  const action = BRUNO_TABLE_WORKFLOW_ACTIONS.get(owner);
  if (action === undefined) return false;
  action();
  return true;
}

export function isBrunoTableHotkeyWorkflowOwner(owner: HTMLElement): boolean {
  return BRUNO_TABLE_WORKFLOW_ACTIONS.has(owner);
}

export function useBrunoTableHotkeyWorkflowAction(action: () => void): RefCallback<HTMLElement> {
  const cleanupRef = useRef<() => void>(() => undefined);
  const actionRef = useRef(action);
  useEffect(() => {
    actionRef.current = action;
  }, [action]);
  useEffect(() => () => cleanupRef.current(), []);
  return useCallback((owner) => {
    cleanupRef.current();
    cleanupRef.current =
      owner === null
        ? () => undefined
        : registerBrunoTableHotkeyWorkflowAction(owner, () => actionRef.current());
  }, []);
}

/**
 * The registration bound is deliberately independent of mounted geometry. The
 * arguments make that invariant directly benchmarkable without exposing the
 * private Adapter from the package root.
 */
export function brunoTableHotkeyRegistrationBound(
  _mountedRows: number,
  _mountedColumns: number,
  activeFilterWorkflows = 0,
  rowSelection = false,
  grouping = false,
  activeEditor = false,
  editMemory = false,
  paste = false,
): number {
  return (
    BRUNO_TABLE_BASE_HOTKEY_REGISTRATION_COUNT +
    activeFilterWorkflows * BRUNO_TABLE_FILTER_WORKFLOW_HOTKEY_REGISTRATION_COUNT +
    (rowSelection ? BRUNO_TABLE_ROW_SELECTION_HOTKEY_REGISTRATION_COUNT : 0) +
    (grouping ? BRUNO_TABLE_GROUP_BY_HOTKEY_REGISTRATION_COUNT : 0) +
    (activeEditor ? BRUNO_TABLE_CELL_EDITOR_HOTKEY_REGISTRATION_COUNT : 0) +
    (editMemory ? BRUNO_TABLE_EDIT_MEMORY_HOTKEY_REGISTRATION_COUNT : 0) +
    (paste ? BRUNO_TABLE_PASTE_HOTKEY_REGISTRATION_COUNT : 0)
  );
}

/** Initializes TanStack's shared held-key lifecycle without per-cell subscriptions. */
export function BrunoTableHeldShiftHotkeyAdapter(): null {
  useKeyHold("Shift");
  return null;
}

/** Reads TanStack's shared held-key state synchronously for a pointer command. */
export function isBrunoTableHotkeyHeld(key: "Shift"): boolean {
  return getKeyStateTracker().isKeyHeld(key);
}

/**
 * React boundary for every BrunoTable-owned shortcut. TanStack owns matching,
 * Mod normalization, repeat delivery, registration lifecycle, and listeners;
 * command callbacks own table/workflow eligibility and event effects.
 */
function useBrunoTableHotkeys(
  target: RefObject<HTMLElement | null> | Document | Window | null,
  bindings: readonly BrunoTableHotkeyBinding[],
  conflictBehavior: "allow" | "error",
): void {
  const definitions: UseHotkeyDefinition[] = bindings.map((binding) => ({
    hotkey: binding.hotkey,
    callback: (event) => {
      if (event.isComposing) return;
      binding.onTrigger(brunoTableLiveHotkeyGesture(event));
    },
    options: { ignoreInputs: binding.allowInTextInput !== true },
  }));

  useHotkeys(definitions, {
    conflictBehavior,
    enabled: true,
    eventType: "keydown",
    platform: detectPlatform(),
    preventDefault: false,
    requireReset: false,
    stopPropagation: false,
    target,
  });
}

function ownsBrunoTableHotkeyTarget(owner: HTMLElement | null, eventTarget: EventTarget | null) {
  const OwnerElement = owner?.ownerDocument.defaultView?.Element;
  const ownerBoundary = owner?.closest("[data-bruno-table]");
  return (
    owner !== null &&
    OwnerElement !== undefined &&
    eventTarget instanceof OwnerElement &&
    ownerBoundary !== null &&
    eventTarget.closest("[data-bruno-table]") === ownerBoundary
  );
}

export function useBrunoTableGridHotkeys(
  target: RefObject<HTMLElement | null>,
  commands: BrunoTableGridHotkeyCommands,
): void {
  const commandsRef = useRef(commands);
  const documentEscapeRegistrationRef = useRef<BrunoTableDocumentEscapeRegistration>({
    owner: target,
    isActive: () => commandsRef.current.documentEscapeActive?.() === true,
  });
  const reactDocumentTargetRef = useRef<Document | null>(null);
  useLayoutEffect(() => {
    commandsRef.current = commands;
  }, [commands]);
  useLayoutEffect(() => {
    const ownerDocument = target.current?.ownerDocument ?? null;
    const defaultWindow = typeof window === "undefined" ? undefined : window;
    reactDocumentTargetRef.current =
      ownerDocument?.defaultView === defaultWindow
        ? ownerDocument
        : null;
    const registration = documentEscapeRegistrationRef.current;
    if (ownerDocument === null || registration === undefined) return;
    let registrations = documentEscapeRegistrations.get(ownerDocument);
    if (registrations === undefined) {
      registrations = new Set();
      documentEscapeRegistrations.set(ownerDocument, registrations);
    }
    registrations.add(registration);
    return () => {
      registrations?.delete(registration);
      if (registrations?.size === 0) documentEscapeRegistrations.delete(ownerDocument);
    };
  }, [target]);
  const bindings = createBrunoTableGridHotkeyBindings(commands);
  const ownerScopedBindings = bindings.map((binding, index) => ({
    ...binding,
    allowInTextInput: binding.allowInTextInput ?? true,
    onTrigger: (event: BrunoTableHotkeyGesture) => {
      if (event.defaultPrevented) return;
      const ownsTarget = ownsBrunoTableHotkeyTarget(target.current, event.target);
      if (index < BRUNO_TABLE_ESCAPE_HOTKEYS.length) {
        const registration = documentEscapeRegistrationRef.current;
        const activeRegistration = activeDocumentEscapeRegistration(
          target.current?.ownerDocument,
          event.target,
        );
        if (activeRegistration !== undefined) {
          if (activeRegistration !== registration) return;
        } else if (!ownsTarget) return;
      } else if (!ownsTarget) return;
      binding.onTrigger(event);
    },
  }));
  const escapeBindings = ownerScopedBindings.slice(0, BRUNO_TABLE_ESCAPE_HOTKEYS.length);
  useBrunoTableHotkeys(
    target,
    ownerScopedBindings.slice(BRUNO_TABLE_ESCAPE_HOTKEYS.length),
    "error",
  );
  // React Hotkeys accepts Documents directly but types refs as element-only.
  // The ref is resolved after this hook's layout effect and before its effect.
  useBrunoTableHotkeys(
    reactDocumentTargetRef as unknown as RefObject<HTMLElement | null>,
    escapeBindings,
    "allow",
  );
}

export function useBrunoTableCellEditorHotkeys(
  target: RefObject<HTMLElement | null>,
  commands: Readonly<{
    readonly cancel: () => void;
    readonly commit: (movement: BrunoTableCellEditMovement) => boolean;
  }>,
): void {
  const commandsRef = useRef(commands);
  useLayoutEffect(() => {
    commandsRef.current = commands;
  }, [commands]);
  useBrunoTableHotkeys(
    target,
    [
      {
        hotkey: "Escape",
        allowInTextInput: true,
        onTrigger: (event) => {
          if (event.defaultPrevented) return;
          event.preventDefault();
          commandsRef.current.cancel();
        },
      },
      {
        hotkey: "Enter",
        allowInTextInput: true,
        onTrigger: (event) => {
          if (event.defaultPrevented) return;
          if (commandsRef.current.commit("enter-forward")) event.preventDefault();
        },
      },
      {
        hotkey: "Shift+Enter",
        allowInTextInput: true,
        onTrigger: (event) => {
          if (event.defaultPrevented) return;
          if (commandsRef.current.commit("enter-backward")) event.preventDefault();
        },
      },
      {
        hotkey: "Tab",
        allowInTextInput: true,
        onTrigger: (event) => {
          if (event.defaultPrevented) return;
          if (commandsRef.current.commit("tab-forward")) event.preventDefault();
        },
      },
      {
        hotkey: "Shift+Tab",
        allowInTextInput: true,
        onTrigger: (event) => {
          if (event.defaultPrevented) return;
          if (commandsRef.current.commit("tab-backward")) event.preventDefault();
        },
      },
    ],
    "allow",
  );
}

/** Scoped Group By Region shortcuts translated into one semantic move command. */
export function useBrunoTableGroupByHotkeys(
  target: RefObject<HTMLElement | null>,
  move: (direction: -1 | 1) => boolean,
): void {
  const moveRef = useRef(move);
  useLayoutEffect(() => {
    moveRef.current = move;
  }, [move]);
  useBrunoTableHotkeys(
    target,
    [
      {
        hotkey: "Alt+ArrowLeft",
        onTrigger: (event) => {
          if (moveRef.current(-1)) event.preventDefault();
        },
      },
      {
        hotkey: "Alt+ArrowRight",
        onTrigger: (event) => {
          if (moveRef.current(1)) event.preventDefault();
        },
      },
    ],
    "allow",
  );
}

export function useBrunoTableFilterWorkflowEscape(
  target: HTMLElement | null,
  onTrigger: (event: BrunoTableHotkeyGesture) => void,
): void {
  const targetRef = useMemo(() => ({ current: target }), [target]);
  useBrunoTableHotkeys(
    targetRef,
    [{ hotkey: "Escape", allowInTextInput: true, onTrigger }],
    "error",
  );
}
