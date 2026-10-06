import {
  memo,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { NamedExoticComponent, ReactElement } from "react";

import type { CompiledColumn } from "./compile-columns";
import { brunoTableCellRangePointerHit } from "./cell-range-clipboard";
import type { BrunoTableCellEditMovement } from "./cell-edit";
import { BRUNO_TABLE_CELL_EDIT_MAX_CANDIDATE_LENGTH, BrunoTableCellEditRuntime } from "./cell-edit";
import { isBrunoTableHotkeyHeld, useBrunoTableCellEditorHotkeys } from "./hotkey-adapter";

const BLANK_EDITOR_OPTION = "blank";
const MINIMUM_VALIDATION_EXPLANATION_HEIGHT = 24;
const scalarEditorOption = (index: number): string => `scalar:${String(index)}`;

type BrunoTableCellEditBoundaryProps = Readonly<{
  readonly column: CompiledColumn;
  readonly runtime: BrunoTableCellEditRuntime;
  readonly describedById?: string | undefined;
  readonly onCommittedOutsideCellPointer?: ((rowId: string, columnId: string) => void) | undefined;
  readonly yieldGridTabStop?: ((grid: HTMLElement) => void) | undefined;
}>;

export const BrunoTableCellEditBoundary: NamedExoticComponent<BrunoTableCellEditBoundaryProps> =
  memo(function BrunoTableCellEditBoundary({
    column,
    runtime,
    describedById,
    onCommittedOutsideCellPointer,
    yieldGridTabStop,
  }: BrunoTableCellEditBoundaryProps): ReactElement | null {
    const control = useRef<HTMLElement>(null);
    const error = useRef<HTMLDivElement>(null);
    const attachControl = useCallback((element: HTMLElement | null) => {
      control.current = element;
    }, []);
    const generatedErrorId = useId();
    const session = useSyncExternalStore(
      runtime.subscribeSession,
      runtime.getSessionSnapshot,
      runtime.getSessionSnapshot,
    );
    const invalidMessage = session.kind === "editing" ? session.invalidMessage : undefined;
    const candidate = runtime.getActiveCandidateSnapshot();
    const errorId = invalidMessage === undefined ? undefined : generatedErrorId;
    const controlDescriptionIds = [describedById, errorId].filter(
      (id): id is string => id !== undefined,
    );
    const controlDescription =
      controlDescriptionIds.length === 0 ? undefined : controlDescriptionIds.join(" ");
    const selectInitialTextOnMount = useRef(
      session.kind === "editing" && session.selectInitialText,
    );
    const initialRawNumberSeed =
      session.kind === "editing" &&
      column.semantics.editorFamily === "number" &&
      candidate.rawText.length > 0
        ? candidate.rawText
        : undefined;
    const rawNumberSeed = useRef(initialRawNumberSeed);
    const [rawNumberDisplay, setRawNumberDisplay] = useState(initialRawNumberSeed);
    const cancel = useCallback(() => {
      const grid = control.current?.closest<HTMLElement>('[role="grid"]') ?? null;
      runtime.cancel();
      grid?.focus({ preventScroll: true });
    }, [runtime]);
    const commit = useCallback(
      (movement: BrunoTableCellEditMovement): boolean => {
        const grid = control.current?.closest<HTMLElement>('[role="grid"]') ?? null;
        if (session.kind === "editing" && session.rowMissing) {
          return movement !== "tab-forward";
        }
        if (!runtime.isTraversalReady()) return true;
        const origin = runtime.captureMovementOrigin();
        if (!runtime.commitActiveCandidate()) return true;
        const moved = runtime.requestMovement(movement, origin);
        if (moved || movement.startsWith("enter")) {
          grid?.focus({ preventScroll: true });
          return true;
        }
        if (grid !== null) {
          grid.focus({ preventScroll: true });
          yieldGridTabStop?.(grid);
        }
        return false;
      },
      [runtime, session, yieldGridTabStop],
    );
    useBrunoTableCellEditorHotkeys(control, { cancel, commit });
    useLayoutEffect(() => {
      const element = control.current;
      if (element === null) return;
      const unregister = runtime.registerActiveCandidate({
        restoreFocus: () => element.focus({ preventScroll: true }),
      });
      if (
        element instanceof HTMLInputElement &&
        rawNumberSeed.current !== undefined &&
        numberCandidateCanUseNativeControl(element, rawNumberSeed.current)
      ) {
        rawNumberSeed.current = undefined;
        setRawNumberDisplay(undefined);
      }
      element.focus({ preventScroll: true });
      if (
        selectInitialTextOnMount.current &&
        element instanceof HTMLInputElement &&
        element.type !== "checkbox"
      ) {
        selectInitialTextOnMount.current = false;
        element.select();
      }
      const handleInput = () => {
        if (element instanceof HTMLSelectElement) return;
        if (
          element instanceof HTMLInputElement &&
          column.semantics.editorFamily === "number" &&
          rawNumberSeed.current !== undefined
        ) {
          const rawText = element.value.slice(0, BRUNO_TABLE_CELL_EDIT_MAX_CANDIDATE_LENGTH + 1);
          rawNumberSeed.current = rawText;
          if (numberCandidateCanUseNativeControl(element, rawText)) {
            rawNumberSeed.current = undefined;
            setRawNumberDisplay(undefined);
          } else {
            setRawNumberDisplay(rawText);
          }
        }
        const rawText =
          element instanceof HTMLInputElement && element.type === "checkbox"
            ? column.semantics.booleanEditorCanonicalValues![element.checked ? 1 : 0]
            : column.semantics.editorFamily === "number" && rawNumberSeed.current !== undefined
              ? rawNumberSeed.current
              : String(Reflect.get(element, "value"));
        runtime.updateActiveCandidate(
          rawText,
          column.semantics.editorFamily === "number" &&
            rawNumberSeed.current === undefined &&
            element instanceof HTMLInputElement &&
            element.type === "number" &&
            element.validity.badInput &&
            element.value.length === 0,
        );
      };
      element.addEventListener("input", handleInput);
      return () => {
        element.removeEventListener("input", handleInput);
        unregister();
      };
    }, [column, runtime]);
    useLayoutEffect(() => {
      const editor = control.current?.closest<HTMLElement>("[data-bruno-cell-editor]") ?? null;
      const document = editor?.ownerDocument;
      if (editor === null || document === undefined) return;
      const editSurface = editor.closest<HTMLElement>("[data-bruno-cell-edit-surface]");
      const tableBoundary = editor.closest<HTMLElement>("[data-bruno-table]");
      const blockedPointers = new Map<
        number,
        Readonly<{ readonly button: number; readonly downTarget: EventTarget | null }>
      >();
      const blockedClicks: Array<
        Readonly<{
          readonly button: number;
          readonly downTarget: EventTarget | null;
          readonly pointerId: number;
          readonly upTarget: EventTarget | null;
        }>
      > = [];
      const commitOutsidePointer = (event: PointerEvent) => {
        blockedClicks.length = 0;
        if (
          event.target instanceof Node &&
          (editor.contains(event.target) ||
            runtime.ownsEditOwnedControl(event.target) ||
            (event.target instanceof Element &&
              event.target
                .closest("[data-bruno-cell-edit-cancel]")
                ?.closest("[data-bruno-cell-edit-surface]") === editSurface))
        ) {
          return;
        }
        const grid = editor.closest<HTMLElement>('[role="grid"]');
        const rangeOwnsPointer =
          grid !== null &&
          isBrunoTableHotkeyHeld("Shift") &&
          brunoTableCellRangePointerHit(event.target, grid) !== undefined;
        if (!runtime.commitActiveCandidate()) {
          blockedPointers.set(event.pointerId, { button: event.button, downTarget: event.target });
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        if (!rangeOwnsPointer && event.target instanceof Element) {
          const cell = event.target.closest<HTMLElement>(
            '[role="gridcell"][data-bruno-row-id][data-bruno-column-id]',
          );
          const rowId = cell?.dataset["brunoRowId"];
          const columnId = cell?.dataset["brunoColumnId"];
          if (
            rowId !== undefined &&
            columnId !== undefined &&
            cell?.closest("[data-bruno-table]") === tableBoundary
          ) {
            onCommittedOutsideCellPointer?.(rowId, columnId);
          }
        }
      };
      const suppressRejectedPointerUp = (event: PointerEvent) => {
        const blockedPointer = blockedPointers.get(event.pointerId);
        if (blockedPointer === undefined) return;
        blockedPointers.delete(event.pointerId);
        blockedClicks.push({
          ...blockedPointer,
          pointerId: event.pointerId,
          upTarget: event.target,
        });
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      const clearRejectedPointer = (event: PointerEvent) => {
        blockedPointers.delete(event.pointerId);
      };
      const suppressRejectedAction = (
        event: MouseEvent,
        completedMatch: "common-ancestor" | "pointer-or-endpoint",
      ) => {
        const ownsTarget = (candidate: EventTarget | null) =>
          event.target === candidate ||
          (event.target instanceof Node &&
            candidate instanceof Node &&
            event.target.contains(candidate));
        const blockedClickIndex = blockedClicks.findIndex(
          ({ button, downTarget, pointerId, upTarget }) =>
            button === event.button &&
            (completedMatch === "common-ancestor"
              ? ownsTarget(downTarget) && ownsTarget(upTarget)
              : (event instanceof PointerEvent && event.pointerId === pointerId) ||
                ownsTarget(downTarget) ||
                ownsTarget(upTarget)),
        );
        if (blockedClickIndex === -1) {
          let activeRejectedTarget = false;
          for (const entry of blockedPointers) {
            const pointerId = entry[0];
            const { button, downTarget } = entry[1];
            if (
              button !== event.button ||
              ((!(event instanceof PointerEvent) || event.pointerId !== pointerId) &&
                !ownsTarget(downTarget))
            ) {
              continue;
            }
            activeRejectedTarget = true;
            break;
          }
          if (!activeRejectedTarget) return;
        } else if (completedMatch === "common-ancestor") blockedClicks.splice(blockedClickIndex, 1);
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      const suppressRejectedClick = (event: MouseEvent) =>
        suppressRejectedAction(event, "common-ancestor");
      const suppressRejectedContextMenu = (event: MouseEvent) =>
        suppressRejectedAction(event, "pointer-or-endpoint");
      document.addEventListener("pointerdown", commitOutsidePointer, true);
      document.addEventListener("pointerup", suppressRejectedPointerUp, true);
      document.addEventListener("pointercancel", clearRejectedPointer, true);
      document.addEventListener("click", suppressRejectedClick, true);
      document.addEventListener("auxclick", suppressRejectedClick, true);
      document.addEventListener("contextmenu", suppressRejectedContextMenu, true);
      return () => {
        document.removeEventListener("pointerdown", commitOutsidePointer, true);
        document.removeEventListener("pointerup", suppressRejectedPointerUp, true);
        document.removeEventListener("pointercancel", clearRejectedPointer, true);
        document.removeEventListener("click", suppressRejectedClick, true);
        document.removeEventListener("auxclick", suppressRejectedClick, true);
        document.removeEventListener("contextmenu", suppressRejectedContextMenu, true);
      };
    }, [onCommittedOutsideCellPointer, runtime]);
    useLayoutEffect(() => {
      const errorElement = error.current;
      const editor = control.current?.closest<HTMLElement>("[data-bruno-cell-editor]") ?? null;
      const grid = editor?.closest<HTMLElement>('[role="grid"]') ?? null;
      const view = grid?.ownerDocument.defaultView;
      if (
        errorElement === null ||
        editor === null ||
        grid === null ||
        view === null ||
        view === undefined
      )
        return;
      let frame: number | undefined;
      const position = () => {
        frame = undefined;
        positionValidationExplanation(errorElement, editor, grid);
      };
      const schedule = () => {
        if (frame !== undefined) return;
        frame = view.requestAnimationFrame(position);
      };
      position();
      grid.addEventListener("scroll", schedule, { passive: true });
      const resizeObserver = new view.ResizeObserver(schedule);
      resizeObserver.observe(grid);
      resizeObserver.observe(editor);
      return () => {
        grid.removeEventListener("scroll", schedule);
        resizeObserver.disconnect();
        if (frame !== undefined) view.cancelAnimationFrame(frame);
      };
    }, [invalidMessage]);
    if (session.kind !== "editing") return null;
    const blankValue = column.kind === "field" ? column.blankValue : undefined;
    const booleanEditorValues = column.semantics.booleanEditorCanonicalValues;
    const renderBooleanSelect =
      column.semantics.editorFamily === "boolean" && blankValue !== undefined;
    return (
      <div data-bruno-cell-editor="" style={{ height: "100%", position: "relative" }}>
        {column.semantics.editorFamily === "boolean" && !renderBooleanSelect ? (
          <input
            ref={attachControl}
            aria-describedby={controlDescription}
            aria-invalid={invalidMessage === undefined ? undefined : true}
            aria-label={`Edit ${column.headerName}`}
            defaultChecked={candidate.rawText === booleanEditorValues?.[1]}
            onChange={(event) =>
              runtime.updateActiveCandidate(
                booleanEditorValues![event.currentTarget.checked ? 1 : 0],
                false,
              )
            }
            type="checkbox"
          />
        ) : renderBooleanSelect ? (
          <select
            ref={attachControl}
            aria-describedby={controlDescription}
            aria-invalid={invalidMessage === undefined ? undefined : true}
            aria-label={`Edit ${column.headerName}`}
            defaultValue={
              candidate.kind === "blank"
                ? BLANK_EDITOR_OPTION
                : candidate.rawText === booleanEditorValues?.[1]
                  ? scalarEditorOption(1)
                  : scalarEditorOption(0)
            }
            onChange={(event) => {
              const selected = event.currentTarget.value;
              runtime.updateActiveCandidate(
                booleanEditorValues![selected === scalarEditorOption(1) ? 1 : 0],
                false,
                selected === BLANK_EDITOR_OPTION ? "blank" : "scalar",
              );
            }}
            style={{ boxSizing: "border-box", height: "100%", width: "100%" }}
          >
            <option value={BLANK_EDITOR_OPTION}>
              {blankValue?.value === null ? "Blank (null)" : "Blank (undefined)"}
            </option>
            <option value={scalarEditorOption(0)}>False</option>
            <option value={scalarEditorOption(1)}>True</option>
          </select>
        ) : column.semantics.editorFamily === "select" &&
          column.semantics.selectCanonicalOptions !== undefined ? (
          <select
            ref={attachControl}
            aria-describedby={controlDescription}
            aria-invalid={invalidMessage === undefined ? undefined : true}
            aria-label={`Edit ${column.headerName}`}
            defaultValue={
              candidate.kind === "blank"
                ? BLANK_EDITOR_OPTION
                : scalarEditorOption(
                    column.selectOptionCanonicalIndexes?.get(candidate.rawText) ?? 0,
                  )
            }
            onChange={(event) => {
              const selected = event.currentTarget.value;
              if (selected === BLANK_EDITOR_OPTION) {
                runtime.updateActiveCandidate("", false, "blank");
                return;
              }
              const optionIndex = Number(selected.slice("scalar:".length));
              runtime.updateActiveCandidate(
                column.semantics.selectCanonicalOptions?.[optionIndex] ?? "",
                false,
              );
            }}
            style={{ boxSizing: "border-box", height: "100%", width: "100%" }}
          >
            {blankValue === undefined ? null : (
              <option value={BLANK_EDITOR_OPTION}>
                {blankValue.value === null ? "Blank (null)" : "Blank (undefined)"}
              </option>
            )}
            {column.semantics.selectCanonicalOptions.map((option, index) => (
              <option key={scalarEditorOption(index)} value={scalarEditorOption(index)}>
                {option === "" ? "Empty string" : option}
              </option>
            ))}
          </select>
        ) : (
          <input
            ref={attachControl}
            aria-describedby={controlDescription}
            aria-invalid={invalidMessage === undefined ? undefined : true}
            aria-label={`Edit ${column.headerName}`}
            defaultValue={candidate.rawText}
            maxLength={BRUNO_TABLE_CELL_EDIT_MAX_CANDIDATE_LENGTH}
            inputMode={
              column.semantics.editorFamily === "number" ||
              column.semantics.editorFamily === "bigint" ||
              column.semantics.editorFamily === "bigdecimal"
                ? "decimal"
                : undefined
            }
            step={
              column.semantics.editorFamily === "number" && rawNumberDisplay === undefined
                ? "any"
                : undefined
            }
            style={{ boxSizing: "border-box", height: "100%", width: "100%" }}
            type={
              column.semantics.editorFamily === "number" && rawNumberDisplay === undefined
                ? "number"
                : "text"
            }
          />
        )}
        {invalidMessage === undefined ? null : (
          <div
            ref={error}
            id={errorId}
            role="alert"
            style={{
              background: "Canvas",
              border: "1px solid currentColor",
              boxSizing: "border-box",
              insetInlineStart: 0,
              maxWidth: 320,
              overflowY: "auto",
              padding: 4,
              position: "absolute",
              top: "100%",
              whiteSpace: "normal",
              zIndex: 9,
            }}
          >
            {invalidMessage}
          </div>
        )}
      </div>
    );
  });

function positionValidationExplanation(
  error: HTMLDivElement,
  editor: HTMLElement,
  grid: HTMLElement,
): void {
  error.style.removeProperty("bottom");
  error.style.setProperty("top", "100%");
  error.style.removeProperty("max-height");
  error.style.removeProperty("transform");
  const gridRect = grid.getBoundingClientRect();
  const editorRect = editor.getBoundingClientRect();
  const contentHeight = error.scrollHeight;
  const spaceBelow = Math.max(0, gridRect.bottom - editorRect.bottom);
  const spaceAbove = Math.max(0, editorRect.top - gridRect.top);
  const placeAbove = spaceBelow < contentHeight && spaceAbove > spaceBelow;
  const preferredSpace = placeAbove ? spaceAbove : spaceBelow;
  const gridHeight = Math.max(0, Math.floor(gridRect.height));
  const minimumVisibleHeight = Math.min(MINIMUM_VALIDATION_EXPLANATION_HEIGHT, gridHeight);
  const availableHeight = Math.min(
    gridHeight,
    Math.max(minimumVisibleHeight, Math.floor(preferredSpace)),
  );
  if (preferredSpace < minimumVisibleHeight) {
    const desiredTop = Math.min(
      Math.max(gridRect.top, editorRect.top - availableHeight),
      gridRect.bottom - availableHeight,
    );
    error.style.setProperty("top", `${String(desiredTop - editorRect.top)}px`);
  } else if (placeAbove) {
    error.style.removeProperty("top");
    error.style.setProperty("bottom", "100%");
  }
  error.style.setProperty("max-height", `${String(availableHeight)}px`);

  const errorRect = error.getBoundingClientRect();
  const horizontalOffset =
    errorRect.left < gridRect.left
      ? gridRect.left - errorRect.left
      : errorRect.right > gridRect.right
        ? gridRect.right - errorRect.right
        : 0;
  if (horizontalOffset !== 0) {
    error.style.setProperty("transform", `translateX(${String(horizontalOffset)}px)`);
  }
}

function numberCandidateCanUseNativeControl(input: HTMLInputElement, rawText: string): boolean {
  if (rawText.length === 0) return true;
  const probe = input.ownerDocument.createElement("input");
  probe.type = "number";
  probe.value = rawText;
  return probe.value === rawText;
}
