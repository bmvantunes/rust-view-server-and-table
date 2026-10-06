import { Button } from "@bruno/shadcn/button";
import { Badge } from "@bruno/shadcn/badge";
import { Checkbox } from "@bruno/shadcn/checkbox";
import { DirectionProvider } from "@bruno/shadcn/direction";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@bruno/shadcn/empty";
import { Input } from "@bruno/shadcn/input";
import { NativeSelect, NativeSelectOption } from "@bruno/shadcn/native-select";
import { Separator } from "@bruno/shadcn/separator";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@bruno/shadcn/popover";
import { FunnelIcon } from "@phosphor-icons/react";
import { useDebouncer } from "@tanstack/react-pacer";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { ComponentType, CompositionEvent, NamedExoticComponent, ReactElement } from "react";

import type { CompiledColumn } from "./compile-columns";
import { useBrunoTableFilterWorkflowEscape } from "./hotkey-adapter";
import {
  applyBrunoTableSetFilterCommand,
  createBrunoTableClientFacetStore,
  isBrunoTableSetFilterExpression,
  type BrunoTableClientFacetSnapshot,
  type BrunoTableSetFilterIntent,
} from "./client-facet";
import { useBrunoTableClientFilterContext } from "./client-filter-context";
import { isBrunoTableDocumentFocusChainActive } from "./focus-ownership";
import {
  BRUNO_TABLE_CLIENT_FILTER_MAX_DEPTH,
  BRUNO_TABLE_CLIENT_FILTER_MAX_TOTAL_NODES,
  BRUNO_TABLE_CLIENT_FILTER_MAX_TOTAL_OPERANDS,
  BRUNO_TABLE_MAX_FILTER_OPERAND_LENGTH,
  boundBrunoTableFilterOperandText,
  normalizeBrunoTableFilterText,
} from "./grid-query";
import type { BrunoTableRuntimeView } from "./grid-runtime";
import {
  recordBrunoTableClientColumnFilterRender,
  recordBrunoTableClientColumnFilterTriggerRender,
} from "./render-instrumentation";
import {
  brunoTableSetValueKey,
  createBrunoTableSetValueIndex,
  hasBrunoTableSetValue,
  type BrunoTableSetValueIndex,
} from "./set-value-identity";

export {
  BRUNO_TABLE_MAX_FILTER_OPERAND_LENGTH,
  boundBrunoTableFilterOperandText,
} from "./grid-query";

type FilterOperator =
  | "equals"
  | "notEqual"
  | "contains"
  | "notContains"
  | "startsWith"
  | "endsWith"
  | "in"
  | "greaterThan"
  | "greaterThanOrEqual"
  | "lessThan"
  | "lessThanOrEqual"
  | "inRange"
  | "blank"
  | "notBlank";

type FilterLeafDraft = Readonly<{
  readonly kind: "leaf";
  readonly operator: FilterOperator;
  readonly first: string;
  readonly firstAuthored: boolean;
  readonly second: string;
  readonly secondAuthored: boolean;
  readonly inValues: readonly string[];
  readonly inValuesAuthored: readonly boolean[];
  readonly inValuesExplicit: boolean;
  readonly selectIndex: number | undefined;
  readonly caseSensitive: boolean;
  readonly accentSensitive: boolean;
}>;

type FilterChangeMode = "continuous" | "immediate" | "clear" | "local";
type FilterDraftPathSegment = number | "not";

type FilterEditorIdentity = Readonly<{
  readonly version: number;
  readonly commandEpoch: number;
}>;

function sameFilterEditorIdentity(
  previous: FilterEditorIdentity,
  next: FilterEditorIdentity,
): boolean {
  return previous.version === next.version && previous.commandEpoch === next.commandEpoch;
}

type FilterDraft =
  | FilterLeafDraft
  | Readonly<{
      readonly kind: "compound";
      readonly operator: "AND" | "OR";
      readonly conditions: readonly [FilterDraft, ...FilterDraft[]];
    }>
  | Readonly<{
      readonly kind: "not";
      readonly condition: FilterDraft;
    }>
  | Readonly<{
      readonly kind: "opaque";
      readonly committed: Readonly<Record<string, unknown>>;
    }>;

type FilterNode = Readonly<Record<string, unknown>>;

type FilterCandidate = Readonly<{
  readonly filter: FilterNode | undefined;
  readonly error?: string;
  readonly invalidControl?: string;
}>;

type CommittedFilterCandidate = FilterCandidate &
  Readonly<{
    readonly commandEpoch: number;
  }>;

type FilterParseResult = ReturnType<CompiledColumn["semantics"]["parseCanonicalText"]>;
type FilterParseCache = Map<string, FilterParseResult>;

const FILTER_IN_VISIBLE_OPERANDS = 64;
const FILTER_SELECT_VISIBLE_OPTIONS = 64;
const FILTER_COMPOUND_VISIBLE_CONDITIONS = 64;
export const BRUNO_TABLE_FILTER_COMPOUND_VISIBLE_CONDITIONS: number =
  FILTER_COMPOUND_VISIBLE_CONDITIONS;
const FILTER_EDITOR_RENDER_NODE_LIMIT = 256;

function filterEditorBudgetMessage(column: CompiledColumn): ReactElement {
  return (
    <p className="text-sm text-muted-foreground">
      Additional conditions for {column.headerName} are hidden to keep this filter responsive. Clear
      or Reset the column filter to replace this expression.
    </p>
  );
}

function sameFilterEditorColumn(previous: CompiledColumn, next: CompiledColumn): boolean {
  if (
    previous.columnId !== next.columnId ||
    previous.kind !== next.kind ||
    previous.valueType !== next.valueType ||
    previous.semantics.codecId !== next.semantics.codecId ||
    previous.semantics.codecVersion !== next.semantics.codecVersion ||
    previous.semantics.filterFamily !== next.semantics.filterFamily ||
    previous.semantics.editorFamily !== next.semantics.editorFamily
  ) {
    return false;
  }
  if (previous.kind === "field" && next.kind === "field") {
    return previous.field === next.field && previous.selectOptions === next.selectOptions;
  }
  if (previous.kind === "computed" && next.kind === "computed") {
    return (
      previous.fields.length === next.fields.length &&
      previous.fields.every((field, index) => field === next.fields[index]) &&
      previous.valueGetter === next.valueGetter
    );
  }
  return false;
}

export type BrunoTableColumnFilterProps = {
  readonly column: CompiledColumn;
  readonly runtime: BrunoTableRuntimeView;
  readonly setFilterFacet?: BrunoTableSetFilterFacetRenderer | false;
  readonly activateHeaderCommand: (columnId: string) => void;
  readonly restoreColumnFocus: (columnId: string) => void;
  readonly registerColumnFilterOpener: (columnId: string, open: () => void) => () => void;
};

export type BrunoTableSetFilterFacetProps = Readonly<{
  readonly column: CompiledColumn;
  readonly runtime: BrunoTableRuntimeView;
}>;

export type BrunoTableSetFilterFacetRenderer = ComponentType<BrunoTableSetFilterFacetProps>;

export const BrunoTableColumnFilter: NamedExoticComponent<BrunoTableColumnFilterProps> = memo(
  function BrunoTableColumnFilter({
    column,
    runtime,
    setFilterFacet,
    activateHeaderCommand,
    restoreColumnFocus,
    registerColumnFilterOpener,
  }: BrunoTableColumnFilterProps): ReactElement {
    if (__BRUNO_TABLE_TEST_DIAGNOSTICS__) {
      recordBrunoTableClientColumnFilterTriggerRender(column.columnId);
    }
    const subscribe = useCallback(
      (listener: () => void) => runtime.subscribeColumnFilter(column.columnId, listener),
      [column.columnId, runtime],
    );
    const getFilterActive = useCallback(
      () => runtime.getColumnFilterSnapshot(column.columnId) !== undefined,
      [column.columnId, runtime],
    );
    const filterActive = useSyncExternalStore(subscribe, getFilterActive, getFilterActive);
    const [open, setOpen] = useState(false);
    const [direction, setDirection] = useState<"ltr" | "rtl">("ltr");
    const closeReasonRef = useRef<string | null>(null);
    const escapeFocusFrameRef = useRef<number | null>(null);
    const wasOpenRef = useRef(false);
    const triggerRef = useRef<HTMLButtonElement | null>(null);
    const triggerOwnerDocumentRef = useRef<Document | null>(null);
    const label = `Filter ${column.headerName}`;
    const SetFilterFacet =
      setFilterFacet === undefined
        ? BrunoTableClientSetFilterFacet
        : setFilterFacet === false
          ? undefined
          : setFilterFacet;
    const openFilter = useCallback((): void => {
      triggerOwnerDocumentRef.current = triggerRef.current?.ownerDocument ?? null;
      setDirection(readBrunoTableFilterDirection(triggerRef.current));
      activateHeaderCommand(column.columnId);
      setOpen(true);
    }, [activateHeaderCommand, column.columnId]);
    useLayoutEffect(
      () => registerColumnFilterOpener(column.columnId, openFilter),
      [column.columnId, openFilter, registerColumnFilterOpener],
    );
    useLayoutEffect(() => {
      wasOpenRef.current = open;
    }, [open]);
    useLayoutEffect(
      () => () => {
        if (escapeFocusFrameRef.current !== null) {
          cancelAnimationFrame(escapeFocusFrameRef.current);
        }
        const ownerDocument = triggerOwnerDocumentRef.current;
        if (!wasOpenRef.current || ownerDocument === null) return;
        const active = ownerDocument.activeElement;
        const OwnerHTMLElement = ownerDocument.defaultView?.HTMLElement;
        const overlay =
          OwnerHTMLElement !== undefined && active instanceof OwnerHTMLElement
            ? active.closest<HTMLElement>("[data-bruno-filter-overlay]")
            : null;
        if (
          active !== ownerDocument.body &&
          active !== triggerRef.current &&
          overlay?.dataset["brunoFilterOverlay"] !== column.columnId
        ) {
          return;
        }
        if (!isBrunoTableDocumentFocusChainActive(ownerDocument)) return;
        restoreColumnFocus(column.columnId);
      },
      [column.columnId, restoreColumnFocus],
    );
    return (
      <DirectionProvider direction={direction}>
        <Popover
          open={open}
          onOpenChange={(nextOpen, eventDetails) => {
            if (nextOpen) {
              triggerOwnerDocumentRef.current = triggerRef.current?.ownerDocument ?? null;
              if (escapeFocusFrameRef.current !== null) {
                cancelAnimationFrame(escapeFocusFrameRef.current);
                escapeFocusFrameRef.current = null;
              }
              setDirection(readBrunoTableFilterDirection(triggerRef.current));
            } else if (
              eventDetails.reason === "escape-key" ||
              eventDetails.reason === "trigger-press" ||
              closeReasonRef.current === "escape-key"
            ) {
              escapeFocusFrameRef.current = requestAnimationFrame(() => {
                escapeFocusFrameRef.current = null;
                activateHeaderCommand(column.columnId);
              });
            }
            if (!nextOpen) closeReasonRef.current = null;
            setOpen(nextOpen);
          }}
        >
          <PopoverTrigger
            render={
              <Button
                ref={triggerRef}
                aria-label={filterActive ? `${label} (active)` : label}
                size="xs"
                tabIndex={-1}
                type="button"
                variant={filterActive ? "secondary" : "ghost"}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  setDirection(readBrunoTableFilterDirection(event.currentTarget));
                  activateHeaderCommand(column.columnId);
                }}
              />
            }
          >
            <FunnelIcon aria-hidden="true" />
          </PopoverTrigger>
          {open ? (
            <BrunoTableColumnFilterContent
              column={column}
              direction={direction}
              SetFilterFacet={SetFilterFacet}
              onEscape={() => {
                closeReasonRef.current = "escape-key";
              }}
              runtime={runtime}
            />
          ) : null}
        </Popover>
      </DirectionProvider>
    );
  },
);

function readBrunoTableFilterDirection(element?: Element | null): "ltr" | "rtl" {
  if (typeof document === "undefined") return "ltr";
  const source = element ?? document.activeElement;
  const grid = source?.closest<HTMLElement>('[role="grid"]') ?? null;
  const ownerDocument = source?.ownerDocument ?? document;
  return getComputedStyle(grid ?? ownerDocument.documentElement).direction === "rtl"
    ? "rtl"
    : "ltr";
}

const BrunoTableColumnFilterContent = memo(function BrunoTableColumnFilterContent({
  column,
  direction,
  SetFilterFacet,
  onEscape,
  runtime,
}: {
  readonly column: CompiledColumn;
  readonly direction: "ltr" | "rtl";
  readonly SetFilterFacet: BrunoTableSetFilterFacetRenderer | undefined;
  readonly onEscape: () => void;
  readonly runtime: BrunoTableRuntimeView;
}): ReactElement {
  if (__BRUNO_TABLE_TEST_DIAGNOSTICS__) {
    recordBrunoTableClientColumnFilterRender(column.columnId);
  }
  const subscribe = useCallback(
    (listener: () => void) => runtime.subscribeColumnFilter(column.columnId, listener),
    [column.columnId, runtime],
  );
  const getVersion = useCallback(
    () => runtime.getColumnFilterVersionSnapshot(column.columnId),
    [column.columnId, runtime],
  );
  const version = useSyncExternalStore(subscribe, getVersion, getVersion);
  return (
    <BrunoTableColumnFilterEditor
      column={column}
      committed={runtime.getColumnFilterSnapshot(column.columnId)}
      direction={direction}
      SetFilterFacet={SetFilterFacet}
      onEscape={onEscape}
      runtime={runtime}
      version={version}
    />
  );
});

type LocalFilterDraftState = Readonly<{
  readonly column: CompiledColumn;
  readonly identity: FilterEditorIdentity;
  readonly draft: FilterDraft;
  readonly complexityDelta: FilterDraftComplexity;
  readonly error: string | undefined;
  readonly invalidControl: string | undefined;
}>;

type FilterDraftComplexity = Readonly<{
  readonly nodes: number;
  readonly operands: number;
}>;

const FILTER_DRAFT_COMPLEXITY = new WeakMap<FilterDraft, FilterDraftComplexity>();
const FILTER_DRAFT_CANDIDATE = new WeakMap<FilterDraft, FilterNode>();

function createLocalFilterDraftState(
  column: CompiledColumn,
  identity: FilterEditorIdentity,
  draft: FilterDraft,
  error?: string,
): LocalFilterDraftState {
  return {
    column,
    identity,
    draft,
    complexityDelta: Object.freeze({ nodes: 0, operands: 0 }),
    error,
    invalidControl: undefined,
  };
}

const BrunoTableColumnFilterEditor = memo(function BrunoTableColumnFilterEditor({
  column,
  committed,
  direction,
  SetFilterFacet,
  onEscape,
  runtime,
  version,
}: {
  readonly column: CompiledColumn;
  readonly committed: unknown;
  readonly direction: "ltr" | "rtl";
  readonly SetFilterFacet: BrunoTableSetFilterFacetRenderer | undefined;
  readonly onEscape: () => void;
  readonly runtime: BrunoTableRuntimeView;
  readonly version: number;
}): ReactElement {
  const subscribeCommandEpoch = useCallback(
    (listener: () => void) => runtime.subscribeColumnFilterCommandEpoch(column.columnId, listener),
    [column.columnId, runtime],
  );
  const getCommandEpoch = useCallback(
    () => runtime.getColumnFilterCommandEpochSnapshot(column.columnId),
    [column.columnId, runtime],
  );
  const commandEpoch = useSyncExternalStore(
    subscribeCommandEpoch,
    getCommandEpoch,
    getCommandEpoch,
  );
  const editorIdentity = useMemo(
    () => Object.freeze({ version, commandEpoch }),
    [commandEpoch, version],
  );
  const [localState, setLocalState] = useState<LocalFilterDraftState>(() =>
    createLocalFilterDraftState(column, editorIdentity, draftFromCommitted(column, committed)),
  );
  const currentState =
    sameFilterEditorColumn(localState.column, column) &&
    sameFilterEditorIdentity(localState.identity, editorIdentity)
      ? localState
      : createLocalFilterDraftState(
          column,
          editorIdentity,
          draftFromCommitted(column, runtime.getColumnFilterSnapshot(column.columnId)),
        );
  const draft = currentState.draft;
  const error = currentState.error;
  const invalidControl = currentState.invalidControl;
  const draftComplexity = countFilterDraftComplexity(draft);
  const retainedComplexity = runtime.getFilterComplexitySnapshot();
  const projectedNodes = retainedComplexity.nodes + currentState.complexityDelta.nodes;
  const projectedOperands = retainedComplexity.operands + currentState.complexityDelta.operands;
  const parseCache = useMemo(
    () => createFilterParseCache(column.semantics, editorIdentity),
    [column.semantics, editorIdentity],
  );
  const inputRef = useRef<HTMLInputElement | null>(null);
  const selectRef = useRef<HTMLSelectElement | null>(null);
  const [overlayElement, setOverlayElement] = useState<HTMLDivElement | null>(null);
  const errorId = useId();
  const setExpressionActive =
    column.enableSetFilter && isBrunoTableSetFilterExpression(column, committed);
  useBrunoTableFilterWorkflowEscape(overlayElement, onEscape);

  const dispatchCandidate = useCallback(
    (candidate: CommittedFilterCandidate): void => {
      if (candidate.filter === undefined) return;
      if (runtime.getColumnFilterCommandEpochSnapshot(column.columnId) !== candidate.commandEpoch) {
        return;
      }
      let rejectionMessage = "This filter collection is too complex.";
      try {
        const accepted = runtime.dispatchGridCommand({
          type: "column.filter.replace",
          columnId: column.columnId,
          filter: candidate.filter,
        });
        if (accepted) return;
      } catch {
        rejectionMessage = "This filter could not be applied.";
      }
      // The runtime is the sole aggregate admission boundary. A rejected candidate must not
      // remain visually ahead of the committed filter, or a later stale Pacer callback could make
      // the overlay claim a state the row model never accepted.
      setLocalState(
        createLocalFilterDraftState(
          column,
          editorIdentity,
          draftFromCommitted(column, runtime.getColumnFilterSnapshot(column.columnId)),
          rejectionMessage,
        ),
      );
    },
    [column, editorIdentity, runtime],
  );
  const debouncer = useDebouncer(dispatchCandidate, { wait: 150 });
  const cancelPendingCandidate = useCallback((): void => {
    debouncer.cancel();
  }, [debouncer]);

  useLayoutEffect(() => {
    if (
      !sameFilterEditorColumn(localState.column, column) ||
      !sameFilterEditorIdentity(localState.identity, editorIdentity)
    ) {
      cancelPendingCandidate();
    }
  }, [cancelPendingCandidate, column, editorIdentity, localState.column, localState.identity]);

  useLayoutEffect(() => {
    if (!column.enableSetFilter || SetFilterFacet === undefined) {
      (inputRef.current ?? selectRef.current)?.focus({ preventScroll: true });
    }
    return () => {
      // Outside/Escape close must not manufacture a command from a local draft. Releasing the
      // overlay-owned Pacer resource intentionally discards any candidate that has not committed.
      cancelPendingCandidate();
    };
  }, [SetFilterFacet, cancelPendingCandidate, column.enableSetFilter]);

  const commitImmediately = useCallback(
    (candidate: FilterCandidate): void => {
      debouncer.cancel();
      if (candidate.filter !== undefined) {
        dispatchCandidate(Object.freeze({ ...candidate, commandEpoch }));
      }
    },
    [commandEpoch, debouncer, dispatchCandidate],
  );

  const commitContinuous = useCallback(
    (candidate: FilterCandidate): void => {
      if (candidate.filter === undefined) {
        cancelPendingCandidate();
        return;
      }
      debouncer.maybeExecute(Object.freeze({ ...candidate, commandEpoch }));
    },
    [cancelPendingCandidate, commandEpoch, debouncer],
  );

  const commitDraft = useCallback(
    (
      nextDraft: FilterDraft,
      mode: FilterChangeMode,
      badInput = false,
      changedPath?: readonly FilterDraftPathSegment[],
    ): void => {
      const nextDraftComplexity = countFilterDraftComplexity(nextDraft);
      const nextComplexityDelta = Object.freeze({
        nodes:
          currentState.complexityDelta.nodes + nextDraftComplexity.nodes - draftComplexity.nodes,
        operands:
          currentState.complexityDelta.operands +
          nextDraftComplexity.operands -
          draftComplexity.operands,
      });
      if (mode === "clear") {
        cancelPendingCandidate();
        const accepted = runtime.dispatchGridCommand({
          type: "column.filter.clear",
          columnId: column.columnId,
        });
        setLocalState({
          column,
          identity: editorIdentity,
          draft: accepted ? nextDraft : draft,
          complexityDelta: accepted ? nextComplexityDelta : currentState.complexityDelta,
          error: undefined,
          invalidControl: undefined,
        });
        return;
      }
      if (mode === "local") {
        // Composition owns the complete local draft until compositionend. Cancel the obsolete
        // whole-expression timer; the final composed draft schedules a new atomic publication.
        debouncer.cancel();
        setLocalState({
          column,
          identity: editorIdentity,
          draft: nextDraft,
          complexityDelta: nextComplexityDelta,
          error: undefined,
          invalidControl: undefined,
        });
        return;
      }
      const parsed = buildFilterCandidateForDraftChange(
        column,
        draft,
        nextDraft,
        parseCache,
        changedPath,
      );
      const candidate = badInput
        ? { ...parsed, filter: undefined, error: "Enter a valid value." }
        : parsed;
      setLocalState({
        column,
        identity: editorIdentity,
        draft: nextDraft,
        complexityDelta: nextComplexityDelta,
        error: candidate.error,
        invalidControl: candidate.invalidControl,
      });
      if (mode === "continuous") commitContinuous(candidate);
      else commitImmediately(candidate);
    },
    [
      column,
      cancelPendingCandidate,
      commitContinuous,
      commitImmediately,
      draft,
      draftComplexity,
      editorIdentity,
      parseCache,
      runtime,
      currentState.complexityDelta,
      debouncer,
    ],
  );

  return (
    <PopoverContent
      ref={setOverlayElement}
      align="start"
      aria-label={labelForContent(column)}
      className="max-h-[min(32rem,calc(100vh-1rem))] max-w-[calc(100vw-1rem)] overflow-y-auto w-80"
      dir={direction}
      role="dialog"
      data-bruno-filter-overlay={column.columnId}
    >
      <PopoverHeader>
        <PopoverTitle>{`Filter ${column.headerName}`}</PopoverTitle>
        <PopoverDescription>
          Changes apply automatically. Clear and Reset remain column commands.
        </PopoverDescription>
      </PopoverHeader>
      <div className="flex flex-col gap-3">
        {column.enableSetFilter && SetFilterFacet !== undefined ? (
          <SetFilterFacet column={column} runtime={runtime} />
        ) : null}
        {column.enableSetFilter && SetFilterFacet !== undefined ? (
          <div className="flex items-center gap-2" aria-hidden="true">
            <Separator className="flex-1" />
            <span className="text-xs text-muted-foreground">Conditions</span>
            <Separator className="flex-1" />
          </div>
        ) : null}
        {setExpressionActive ? (
          <div className="flex items-center justify-between gap-2 rounded-md border p-2">
            <p className="text-xs text-muted-foreground">
              Value selection owns this column expression.
            </p>
            <Button
              size="xs"
              type="button"
              variant="outline"
              onClick={() => {
                runtime.dispatchGridCommand({
                  type: "column.filter.clear",
                  columnId: column.columnId,
                });
              }}
            >
              Use conditions
            </Button>
          </div>
        ) : (
          <FilterExpressionEditor
            column={column}
            draft={draft}
            errorId={errorId}
            compositionIdentity={editorIdentity}
            invalidControl={invalidControl}
            inputRef={inputRef}
            canAddCondition={projectedNodes < BRUNO_TABLE_CLIENT_FILTER_MAX_TOTAL_NODES}
            canAddFilterValue={projectedOperands < BRUNO_TABLE_CLIENT_FILTER_MAX_TOTAL_OPERANDS}
            selectRef={selectRef}
            renderBudget={FILTER_EDITOR_RENDER_NODE_LIMIT}
            onChange={commitDraft}
          />
        )}
        {error === undefined ? null : (
          <p id={errorId} aria-live="polite" className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>
    </PopoverContent>
  );
});

const SET_FILTER_VISIBLE_OPTIONS = 64;

const BrunoTableClientSetFilterFacet = memo(function BrunoTableClientSetFilterFacet({
  column,
}: BrunoTableSetFilterFacetProps): ReactElement {
  const { facetRows, runtime } = useBrunoTableClientFilterContext();
  return <BrunoTableSetFilter column={column} rows={facetRows} runtime={runtime} />;
});

const BrunoTableSetFilter = memo(function BrunoTableSetFilter({
  column,
  rows,
  runtime,
}: {
  readonly column: CompiledColumn;
  readonly rows: import("./client-source-adapter").BrunoTableClientFacetRowsSource;
  readonly runtime: import("./grid-runtime").BrunoTableRowPipelineRuntimeView;
}): ReactElement {
  const store = useMemo(
    () => createBrunoTableClientFacetStore({ column, rows, runtime }),
    [column, rows, runtime],
  );
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return <BrunoTableSetFilterView column={column} runtime={runtime} snapshot={snapshot} />;
});

export type BrunoTableSetFilterViewProps = Readonly<{
  readonly column: CompiledColumn;
  readonly runtime: BrunoTableRuntimeView;
  readonly snapshot: BrunoTableClientFacetSnapshot;
  readonly lifecycle?: Readonly<{
    readonly status: "loading" | "ready" | "stale" | "closed" | "error";
    readonly message?: string | undefined;
  }>;
}>;

export const BrunoTableSetFilterView: NamedExoticComponent<BrunoTableSetFilterViewProps> = memo(
  function BrunoTableSetFilterView({
    column,
    lifecycle,
    runtime,
    snapshot,
  }: BrunoTableSetFilterViewProps): ReactElement {
    const [search, setSearch] = useState("");
    const [windowStart, setWindowStart] = useState(0);
    const searchRef = useRef<HTMLInputElement | null>(null);
    const headingId = useId();
    useLayoutEffect(() => {
      searchRef.current?.focus({ preventScroll: true });
    }, []);
    const normalizedSearch = normalizeBrunoTableFilterText(search);
    const matchingOptions = useMemo(
      () =>
        normalizedSearch.length === 0
          ? snapshot.options
          : snapshot.options.filter((option) =>
              normalizeBrunoTableFilterText(option.display).includes(normalizedSearch),
            ),
      [normalizedSearch, snapshot.options],
    );
    const maxWindowStart = Math.max(0, matchingOptions.length - SET_FILTER_VISIBLE_OPTIONS);
    const visibleWindowStart = Math.min(windowStart, maxWindowStart);
    const visibleOptions = matchingOptions.slice(
      visibleWindowStart,
      visibleWindowStart + SET_FILTER_VISIBLE_OPTIONS,
    );
    const intentValueIndex = useMemo(
      () =>
        createBrunoTableSetValueIndex(
          column,
          snapshot.intent.kind === "all" ? [] : snapshot.intent.values,
        ),
      [column, snapshot.intent],
    );
    const selectedOptions = snapshot.options.filter((option) =>
      isBrunoTableFacetOptionSelected(column, snapshot.intent, intentValueIndex, option.value),
    );
    const selectionSummary =
      snapshot.intent.kind === "all"
        ? "All selected"
        : snapshot.intent.kind === "include"
          ? `${String(snapshot.intent.values.length)} selected`
          : `All except ${String(snapshot.intent.values.length)} selected`;
    const accessibleOptionEvidence = useMemo(() => {
      const displayCounts = new Map<string, number>();
      const indexesByKey = new Map<string, number>();
      snapshot.options.forEach((option, index) => {
        const normalizedDisplay = normalizeBrunoTableFilterText(option.display);
        displayCounts.set(normalizedDisplay, (displayCounts.get(normalizedDisplay) ?? 0) + 1);
        indexesByKey.set(facetOptionKey(column, option.value), index);
      });
      return { displayCounts, indexesByKey };
    }, [column, snapshot.options]);
    const publish = (command: Parameters<typeof applyBrunoTableSetFilterCommand>[3]): void => {
      const filter = applyBrunoTableSetFilterCommand(
        column,
        snapshot.intent,
        snapshot.options.filter((option) => option.count > 0).map((option) => option.value),
        command,
      );
      runtime.dispatchGridCommand(
        filter === undefined
          ? { type: "column.filter.clear", columnId: column.columnId }
          : { type: "column.filter.replace", columnId: column.columnId, filter },
      );
    };
    const hasCoherentEmptyResult =
      lifecycle === undefined || lifecycle.status === "ready" || lifecycle.status === "stale";

    return (
      <section className="flex flex-col gap-2" aria-labelledby={headingId}>
        {lifecycle === undefined ? null : (
          <p className="text-xs text-muted-foreground" role="status">
            {lifecycle.status === "ready"
              ? ""
              : serverFacetLifecycleLabel(lifecycle.status, lifecycle.message)}
          </p>
        )}
        <div className="flex items-center justify-between gap-2">
          <h3 id={headingId} className="text-sm font-medium">
            Values
          </h3>
          <Badge aria-live="polite" role="status" variant="secondary">
            {selectionSummary}
          </Badge>
        </div>
        {selectedOptions.length === 0 ? null : (
          <div className="flex flex-wrap gap-1" aria-label="Selected values">
            {selectedOptions.slice(0, 3).map((option) => (
              <Badge key={facetOptionKey(column, option.value)} variant="outline">
                {`${option.display} · ${String(option.count)}`}
              </Badge>
            ))}
            {selectedOptions.length <= 3 ? null : (
              <Badge variant="outline">{`+${String(selectedOptions.length - 3)}`}</Badge>
            )}
          </div>
        )}
        <div className="flex gap-1">
          <Button
            size="xs"
            type="button"
            variant="outline"
            onClick={() => publish({ type: "select-all" })}
          >
            Select All
          </Button>
          <Button
            size="xs"
            type="button"
            variant="outline"
            onClick={() => publish({ type: "clear-all" })}
          >
            Clear All
          </Button>
        </div>
        <Input
          ref={searchRef}
          aria-label={`Search values for ${column.headerName}`}
          placeholder="Search values"
          type="search"
          value={search}
          onChange={(event) => {
            setSearch(event.currentTarget.value);
            setWindowStart(0);
          }}
        />
        {matchingOptions.length === 0 && hasCoherentEmptyResult ? (
          <Empty aria-label="No values found" className="min-h-24 p-3" role="status">
            <EmptyHeader>
              <EmptyTitle>No values found</EmptyTitle>
              <EmptyDescription>Try a different search.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : matchingOptions.length > 0 ? (
          <div
            className="flex max-h-56 flex-col gap-1 overflow-y-auto"
            role="group"
            aria-label="Filter values"
          >
            {visibleOptions.map((option) => {
              const selected = isBrunoTableFacetOptionSelected(
                column,
                snapshot.intent,
                intentValueIndex,
                option.value,
              );
              const label = `${option.display}, ${String(option.count)}`;
              const normalizedDisplay = normalizeBrunoTableFilterText(option.display);
              const optionIndex =
                accessibleOptionEvidence.indexesByKey.get(facetOptionKey(column, option.value)) ??
                0;
              const accessibleLabel =
                (accessibleOptionEvidence.displayCounts.get(normalizedDisplay) ?? 0) > 1
                  ? `Select ${label}, option ${String(optionIndex + 1)} of ${String(snapshot.options.length)}`
                  : `Select ${label}`;
              return (
                <label
                  key={facetOptionKey(column, option.value)}
                  className="flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-muted"
                >
                  <Checkbox
                    aria-label={accessibleLabel}
                    checked={selected}
                    onCheckedChange={(checked) =>
                      publish({ type: "toggle", value: option.value, selected: checked })
                    }
                  />
                  <span className="min-w-0 flex-1 truncate">{option.display}</span>
                  <Badge
                    variant={option.count === 0 || option.count === 0n ? "outline" : "secondary"}
                  >
                    {String(option.count)}
                  </Badge>
                </label>
              );
            })}
          </div>
        ) : null}
        {matchingOptions.length <= SET_FILTER_VISIBLE_OPTIONS ? null : (
          <div className="flex items-center justify-between gap-2">
            <Button
              disabled={visibleWindowStart === 0}
              size="xs"
              type="button"
              variant="ghost"
              onClick={() =>
                setWindowStart(Math.max(0, visibleWindowStart - SET_FILTER_VISIBLE_OPTIONS))
              }
            >
              Previous values
            </Button>
            <span className="text-xs text-muted-foreground">
              {`${String(visibleWindowStart + 1)}–${String(Math.min(matchingOptions.length, visibleWindowStart + SET_FILTER_VISIBLE_OPTIONS))} of ${String(matchingOptions.length)}`}
            </span>
            <Button
              disabled={visibleWindowStart >= maxWindowStart}
              size="xs"
              type="button"
              variant="ghost"
              onClick={() =>
                setWindowStart(
                  Math.min(maxWindowStart, visibleWindowStart + SET_FILTER_VISIBLE_OPTIONS),
                )
              }
            >
              Next values
            </Button>
          </div>
        )}
      </section>
    );
  },
);

function serverFacetLifecycleLabel(
  status: "loading" | "stale" | "closed" | "error",
  message: string | undefined,
): string {
  const label =
    status === "loading"
      ? "Loading filter values."
      : status === "stale"
        ? "Filter values may be delayed."
        : status === "closed"
          ? "Live filter values stopped."
          : "Live filter values unavailable.";
  return message === undefined || message.length === 0 ? label : `${label} ${message}`;
}

function isBrunoTableFacetOptionSelected(
  column: CompiledColumn,
  intent: BrunoTableSetFilterIntent,
  intentValueIndex: BrunoTableSetValueIndex,
  value: unknown,
): boolean {
  if (intent.kind === "all") return true;
  const present = hasBrunoTableSetValue(column, intentValueIndex, value);
  return intent.kind === "include" ? present : !present;
}

function facetOptionKey(column: CompiledColumn, value: unknown): string {
  return brunoTableSetValueKey(column, value) ?? `${typeof value}:${String(value)}`;
}

function FilterExpressionEditor({
  column,
  draft: inputDraft,
  compositionIdentity,
  errorId,
  invalidControl,
  inputRef,
  canAddCondition,
  canAddFilterValue,
  onChange,
  path = "root",
  renderBudget,
  rootSelectRef,
  selectRef,
}: {
  readonly column: CompiledColumn;
  readonly draft: FilterDraft;
  readonly compositionIdentity: FilterEditorIdentity;
  readonly errorId: string;
  readonly invalidControl: string | undefined;
  readonly inputRef?: React.RefObject<HTMLInputElement | null> | undefined;
  readonly canAddCondition: boolean;
  readonly canAddFilterValue: boolean;
  readonly onChange: (
    draft: FilterDraft,
    mode: FilterChangeMode,
    badInput?: boolean,
    changedPath?: readonly FilterDraftPathSegment[],
  ) => void;
  readonly path?: string;
  readonly renderBudget: number;
  readonly rootSelectRef?: React.RefObject<HTMLSelectElement | null> | undefined;
  readonly selectRef?: React.RefObject<HTMLSelectElement | null> | undefined;
}): ReactElement {
  const draft =
    inputDraft.kind === "opaque"
      ? draftFromNode(column, inputDraft.committed, createFilterDraftMaterializationState(), 0)
      : inputDraft;
  const expressionMode =
    draft.kind === "leaf" ? "leaf" : draft.kind === "compound" ? draft.operator : "NOT";
  const pathLabel = filterExpressionPathLabel(path);
  const labelSuffix = pathLabel === undefined ? "" : ` (${pathLabel})`;
  const modeLabel = `Filter expression for ${column.headerName}${labelSuffix}`;
  const isContinuous = !(
    isBuiltInBooleanColumn(column) ||
    (column.semantics.filterFamily === "select" && column.selectOptions !== undefined)
  );
  const operatorOptions = filterOperators(column);
  const removeConditionRefs = useRef(new Map<number, HTMLButtonElement>());
  const focusFrameRef = useRef<number | null>(null);
  const [conditionWindowStart, setConditionWindowStart] = useState(0);
  const conditionCount = draft.kind === "compound" ? draft.conditions.length : 0;
  const maxConditionWindowStart = Math.max(0, conditionCount - FILTER_COMPOUND_VISIBLE_CONDITIONS);
  const visibleConditionWindowStart = Math.min(conditionWindowStart, maxConditionWindowStart);
  const visibleConditionWindowEnd = Math.min(
    conditionCount,
    visibleConditionWindowStart + FILTER_COMPOUND_VISIBLE_CONDITIONS,
  );
  useEffect(
    () => () => {
      if (focusFrameRef.current !== null) cancelAnimationFrame(focusFrameRef.current);
    },
    [],
  );
  const scheduleFocus = (resolveTarget: () => HTMLElement | null): void => {
    if (focusFrameRef.current !== null) cancelAnimationFrame(focusFrameRef.current);
    const initiatingElement = document.activeElement;
    const owningDialog = initiatingElement?.closest('[role="dialog"]');
    const focus = () => {
      focusFrameRef.current = null;
      // A delayed structural focus move must not override the user's next action.
      // Removing the initiating control can leave focus on the body or the overlay fallback.
      if (
        document.activeElement !== initiatingElement &&
        !(
          initiatingElement?.isConnected === false &&
          (document.activeElement === document.body || document.activeElement === owningDialog)
        )
      )
        return;
      const target = resolveTarget();
      target?.focus({ preventScroll: true });
    };
    focusFrameRef.current = requestAnimationFrame(() => {
      focusFrameRef.current = requestAnimationFrame(focus);
    });
  };
  const focusAfterConditionRemoval = (nextIndex: number): void => {
    scheduleFocus(
      () =>
        (nextIndex < 0 ? undefined : removeConditionRefs.current.get(nextIndex)) ??
        rootSelectRef?.current ??
        selectRef?.current ??
        inputRef?.current ??
        null,
    );
  };
  const focusAddedControl = (controlId: string): void => {
    scheduleFocus(() => document.getElementById(controlId));
  };
  const updateLeaf = (nextLeaf: FilterLeafDraft, mode: FilterChangeMode, badInput = false) =>
    onChange(nextLeaf, mode, badInput, []);
  const canRenderThisEditor = renderBudget > 0;
  const childRenderBudget = Math.max(0, renderBudget - 1);
  const canRenderNotCondition = draft.kind === "not" && childRenderBudget > 0;
  let omittedCompoundConditionCount = 0;
  const renderedCompoundConditions: ReactElement[] = [];
  if (draft.kind === "compound") {
    const visibleConditions = draft.conditions.slice(
      visibleConditionWindowStart,
      visibleConditionWindowEnd,
    );
    let remainingChildBudget = childRenderBudget;
    for (const [offset, condition] of visibleConditions.entries()) {
      const remainingConditionCount = visibleConditions.length - offset;
      if (remainingChildBudget < remainingConditionCount) {
        omittedCompoundConditionCount = remainingConditionCount;
        break;
      }
      const conditionRenderBudget = Math.floor(remainingChildBudget / remainingConditionCount);
      if (conditionRenderBudget < 1) {
        omittedCompoundConditionCount = remainingConditionCount;
        break;
      }
      remainingChildBudget -= conditionRenderBudget;
      const index = visibleConditionWindowStart + offset;
      const conditionPath = `${path}-${String(index)}`;
      const conditionLabel = filterExpressionPathLabel(conditionPath);
      renderedCompoundConditions.push(
        <div
          key={conditionPath}
          className="flex flex-col gap-2 rounded-md border p-2"
          role="group"
          aria-label={`Filter ${conditionLabel ?? "condition"} for ${column.headerName}`}
        >
          <FilterExpressionEditor
            column={column}
            draft={condition}
            compositionIdentity={compositionIdentity}
            errorId={errorId}
            invalidControl={invalidControl}
            canAddCondition={canAddCondition}
            canAddFilterValue={canAddFilterValue}
            onChange={(nextCondition, mode, badInput, changedPath) => {
              const conditions = draft.conditions.slice() as [FilterDraft, ...FilterDraft[]];
              conditions[index] = nextCondition;
              const nextDraft = Object.freeze({
                ...draft,
                conditions: Object.freeze(conditions),
              });
              cacheFilterDraftComplexityDelta(nextDraft, draft, condition, nextCondition);
              onChange(nextDraft, mode, badInput, [index, ...(changedPath ?? [])]);
            }}
            path={conditionPath}
            renderBudget={conditionRenderBudget}
            rootSelectRef={rootSelectRef ?? selectRef}
          />
          {draft.conditions.length > 1 ? (
            <Button
              ref={(element) => {
                if (element === null) removeConditionRefs.current.delete(index);
                else removeConditionRefs.current.set(index, element);
              }}
              aria-label={`Remove condition ${String(index + 1)} for ${column.headerName}${labelSuffix}`}
              size="xs"
              type="button"
              variant="ghost"
              onClick={() => {
                const conditions = draft.conditions.filter((_, candidate) => candidate !== index);
                const nextDraft =
                  conditions.length === 1
                    ? conditions[0]!
                    : Object.freeze({
                        ...draft,
                        conditions: Object.freeze(conditions) as readonly [
                          FilterDraft,
                          ...FilterDraft[],
                        ],
                      });
                if (conditions.length !== 1) {
                  cacheFilterDraftComplexityDelta(nextDraft, draft, draft.conditions[index]);
                }
                onChange(nextDraft, "immediate", false, []);
                focusAfterConditionRemoval(
                  conditions.length === 1
                    ? -1
                    : index < draft.conditions.length - 1
                      ? index
                      : index - 1,
                );
              }}
            >
              Remove condition
            </Button>
          ) : null}
        </div>,
      );
    }
  }

  if (!canRenderThisEditor) return filterEditorBudgetMessage(column);

  return (
    <div className="flex flex-col gap-3">
      {draft.kind === "opaque" ? null : (
        <label className="flex flex-col gap-1 text-sm" htmlFor={`${errorId}-${path}-mode`}>
          Expression
          <NativeSelect
            ref={path === "root" ? selectRef : undefined}
            id={`${errorId}-${path}-mode`}
            aria-label={modeLabel}
            value={expressionMode}
            onChange={(event) => {
              onChange(
                changeExpressionMode(column, draft, event.currentTarget.value),
                "immediate",
                false,
                [],
              );
            }}
          >
            <NativeSelectOption value="leaf">Single condition</NativeSelectOption>
            <NativeSelectOption value="AND">All conditions (AND)</NativeSelectOption>
            <NativeSelectOption value="OR">Any conditions (OR)</NativeSelectOption>
            <NativeSelectOption value="NOT">Not condition (NOT)</NativeSelectOption>
          </NativeSelect>
        </label>
      )}
      {draft.kind === "opaque" ? (
        filterEditorBudgetMessage(column)
      ) : draft.kind === "leaf" ? (
        (() => {
          const leaf = draft;
          return (
            <>
              <label
                className="flex flex-col gap-1 text-sm"
                htmlFor={`${errorId}-${path}-operator`}
              >
                Operator
                <NativeSelect
                  ref={path === "root" && leaf.operator === "blank" ? selectRef : undefined}
                  id={`${errorId}-${path}-operator`}
                  aria-label={`Filter operator for ${column.headerName}${labelSuffix}`}
                  value={leaf.operator}
                  onChange={(event) => {
                    const operator = event.currentTarget.value as FilterOperator;
                    const enteringImplicitIn = operator === "in" && !leaf.inValuesExplicit;
                    updateLeaf(
                      Object.freeze({
                        ...leaf,
                        operator,
                        inValues: enteringImplicitIn
                          ? leaf.firstAuthored
                            ? Object.freeze([leaf.first])
                            : Object.freeze([])
                          : leaf.inValues,
                        inValuesAuthored: enteringImplicitIn
                          ? leaf.firstAuthored
                            ? Object.freeze([true])
                            : Object.freeze([])
                          : leaf.inValuesAuthored,
                        inValuesExplicit: operator === "in" ? leaf.inValuesExplicit : false,
                      }),
                      "immediate",
                    );
                  }}
                >
                  {operatorOptions.map((operator) => (
                    <NativeSelectOption key={operator} value={operator}>
                      {operatorLabelText(operator)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </label>
              {leaf.operator === "blank" || leaf.operator === "notBlank" ? null : (
                <FilterOperand
                  column={column}
                  draft={leaf}
                  compositionIdentity={compositionIdentity}
                  errorId={errorId}
                  invalidControl={invalidControl}
                  canAddFilterValue={canAddFilterValue}
                  inputRef={inputRef}
                  path={path}
                  selectRef={selectRef}
                  inputLabel={`Filter value for ${column.headerName}${labelSuffix}`}
                  focusAddedControl={focusAddedControl}
                  onChange={updateLeaf}
                  continuous={isContinuous}
                />
              )}
              {column.semantics.filterFamily === "text" &&
              supportsTextSensitivity(leaf.operator) ? (
                <div className="flex flex-col gap-2 text-sm">
                  <label className="flex items-center gap-2" htmlFor={`${errorId}-${path}-case`}>
                    <Checkbox
                      id={`${errorId}-${path}-case`}
                      aria-label={`Case-sensitive filter for ${column.headerName}${labelSuffix}`}
                      checked={leaf.caseSensitive}
                      onCheckedChange={(checked) =>
                        updateLeaf(
                          Object.freeze({ ...leaf, caseSensitive: checked === true }),
                          "immediate",
                        )
                      }
                    />
                    Case-sensitive
                  </label>
                  <label className="flex items-center gap-2" htmlFor={`${errorId}-${path}-accent`}>
                    <Checkbox
                      id={`${errorId}-${path}-accent`}
                      aria-label={`Accent-sensitive filter for ${column.headerName}${labelSuffix}`}
                      checked={leaf.accentSensitive}
                      onCheckedChange={(checked) =>
                        updateLeaf(
                          Object.freeze({ ...leaf, accentSensitive: checked === true }),
                          "immediate",
                        )
                      }
                    />
                    Accent-sensitive
                  </label>
                </div>
              ) : null}
            </>
          );
        })()
      ) : draft.kind === "not" ? (
        canRenderNotCondition ? (
          <FilterExpressionEditor
            column={column}
            draft={draft.condition}
            compositionIdentity={compositionIdentity}
            errorId={errorId}
            invalidControl={invalidControl}
            canAddCondition={canAddCondition}
            canAddFilterValue={canAddFilterValue}
            inputRef={inputRef}
            onChange={(condition, mode, badInput, changedPath) => {
              const nextDraft = Object.freeze({ ...draft, condition });
              cacheFilterDraftComplexityDelta(nextDraft, draft, draft.condition, condition);
              onChange(nextDraft, mode, badInput, ["not", ...(changedPath ?? [])]);
            }}
            path={`${path}-not`}
            renderBudget={childRenderBudget}
            rootSelectRef={rootSelectRef ?? selectRef}
          />
        ) : (
          filterEditorBudgetMessage(column)
        )
      ) : (
        <div className="flex flex-col gap-3">
          {conditionCount > FILTER_COMPOUND_VISIBLE_CONDITIONS ? (
            <div className="flex items-center justify-between gap-2 text-sm">
              <span aria-live="polite" role="status">
                {`Showing conditions ${String(visibleConditionWindowStart + 1)}–${String(visibleConditionWindowEnd)} of ${conditionCount.toLocaleString("en-US")}`}
              </span>
              <div className="flex gap-1">
                <Button
                  aria-label={`Previous filter conditions for ${column.headerName}`}
                  disabled={visibleConditionWindowStart === 0}
                  size="xs"
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    setConditionWindowStart(
                      Math.max(0, visibleConditionWindowStart - FILTER_COMPOUND_VISIBLE_CONDITIONS),
                    )
                  }
                >
                  Previous
                </Button>
                <Button
                  aria-label={`Next filter conditions for ${column.headerName}`}
                  disabled={visibleConditionWindowEnd === conditionCount}
                  size="xs"
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    setConditionWindowStart(
                      Math.min(
                        maxConditionWindowStart,
                        visibleConditionWindowStart + FILTER_COMPOUND_VISIBLE_CONDITIONS,
                      ),
                    )
                  }
                >
                  Next
                </Button>
              </div>
            </div>
          ) : null}
          {renderedCompoundConditions}
          {omittedCompoundConditionCount > 0 ? (
            <p role="status" className="text-sm text-muted-foreground">
              {`${String(omittedCompoundConditionCount)} additional condition${omittedCompoundConditionCount === 1 ? "" : "s"} hidden to keep this filter responsive.`}
            </p>
          ) : null}
          <Button
            aria-label={`Add condition for ${column.headerName}${labelSuffix}`}
            disabled={!canAddCondition || omittedCompoundConditionCount > 0}
            size="xs"
            type="button"
            variant="outline"
            onClick={() => {
              const nextIndex = draft.conditions.length;
              if (!canAddCondition || omittedCompoundConditionCount > 0) {
                return;
              }
              setConditionWindowStart(
                Math.max(0, nextIndex - FILTER_COMPOUND_VISIBLE_CONDITIONS + 1),
              );
              const condition = createDefaultLeaf(column);
              const nextDraft = Object.freeze({
                ...draft,
                conditions: Object.freeze([...draft.conditions, condition]) as readonly [
                  FilterDraft,
                  ...FilterDraft[],
                ],
              });
              cacheFilterDraftComplexityDelta(nextDraft, draft, undefined, condition);
              onChange(nextDraft, "immediate", false, []);
              focusAddedControl(`${errorId}-${path}-${String(nextIndex)}-mode`);
            }}
          >
            Add condition
          </Button>
        </div>
      )}
    </div>
  );
}

function createFilterParseCache(
  semantics: CompiledColumn["semantics"],
  identity: FilterEditorIdentity,
): FilterParseCache {
  void semantics;
  void identity.version;
  void identity.commandEpoch;
  return new Map();
}

function FilterOperand({
  column,
  draft,
  compositionIdentity,
  errorId,
  invalidControl,
  canAddFilterValue,
  focusAddedControl,
  inputLabel,
  inputRef,
  onChange,
  path,
  selectRef,
  continuous,
}: {
  readonly column: CompiledColumn;
  readonly draft: FilterLeafDraft;
  readonly compositionIdentity: FilterEditorIdentity;
  readonly errorId: string;
  readonly invalidControl: string | undefined;
  readonly canAddFilterValue: boolean;
  readonly inputLabel: string;
  readonly inputRef?: React.RefObject<HTMLInputElement | null> | undefined;
  readonly focusAddedControl: (controlId: string) => void;
  readonly onChange: (draft: FilterLeafDraft, mode: FilterChangeMode, badInput?: boolean) => void;
  readonly path: string;
  readonly selectRef?: React.RefObject<HTMLSelectElement | null> | undefined;
  readonly continuous: boolean;
}): ReactElement {
  const isIn = draft.operator === "in";
  const composingRef = useRef(false);
  const invalidatedCompositionSessionRef = useRef<number | null>(null);
  const compositionSessionRef = useRef(0);
  const latestDraftRef = useRef(draft);
  const values = isIn && draft.inValuesExplicit ? draft.inValues : [draft.first];
  const [operandWindowStart, setOperandWindowStart] = useState(0);
  const [selectOptionWindowStart, setSelectOptionWindowStart] = useState(0);
  const maxOperandWindowStart = Math.max(0, values.length - FILTER_IN_VISIBLE_OPERANDS);
  const visibleOperandWindowStart = Math.min(operandWindowStart, maxOperandWindowStart);
  useEffect(() => {
    latestDraftRef.current = draft;
  }, [draft]);
  useLayoutEffect(() => {
    if (composingRef.current) {
      invalidatedCompositionSessionRef.current = compositionSessionRef.current;
    }
  }, [compositionIdentity.commandEpoch, compositionIdentity.version]);
  const isCompositionInvalidated = (): boolean =>
    invalidatedCompositionSessionRef.current === compositionSessionRef.current;
  const beginComposition = (): void => {
    compositionSessionRef.current += 1;
    invalidatedCompositionSessionRef.current = null;
    composingRef.current = true;
    onChange(latestDraftRef.current, "local");
  };
  const finishComposition = (
    event: CompositionEvent<HTMLInputElement>,
    updateDraft: (current: FilterLeafDraft, value: string) => FilterLeafDraft,
  ): void => {
    const compositionSession = compositionSessionRef.current;
    if (invalidatedCompositionSessionRef.current === compositionSession) {
      invalidatedCompositionSessionRef.current = null;
      composingRef.current = false;
      return;
    }
    composingRef.current = false;
    const nextDraft = updateDraft(
      latestDraftRef.current,
      boundBrunoTableFilterOperandText(event.currentTarget.value),
    );
    latestDraftRef.current = nextDraft;
    onChange(nextDraft, continuous ? "continuous" : "immediate");
  };
  const changeMode = (): FilterChangeMode | undefined => {
    if (isCompositionInvalidated()) return undefined;
    return composingRef.current ? "local" : continuous ? "continuous" : "immediate";
  };
  const publishOperandChange = (nextDraft: FilterLeafDraft, badInput = false): void => {
    const mode = changeMode();
    if (mode !== undefined) onChange(nextDraft, mode, badInput);
  };
  const pathLabel = filterExpressionPathLabel(path);
  const labelSuffix = pathLabel === undefined ? "" : ` (${pathLabel})`;
  const isInvalidControl = (control: string): boolean => invalidControl === `${path}-${control}`;
  if (isBuiltInBooleanColumn(column)) {
    return (
      <label className="flex flex-col gap-1 text-sm" htmlFor={`${errorId}-${path}-value`}>
        Value
        <NativeSelect
          ref={selectRef}
          id={`${errorId}-${path}-value`}
          aria-label={inputLabel}
          aria-invalid={isInvalidControl("value") ? "true" : undefined}
          aria-describedby={isInvalidControl("value") ? errorId : undefined}
          value={draft.first}
          onChange={(event) =>
            onChange(
              Object.freeze({
                ...draft,
                first: event.currentTarget.value,
                firstAuthored: event.currentTarget.value.length > 0,
              }),
              "immediate",
            )
          }
        >
          <NativeSelectOption value="">Choose a value</NativeSelectOption>
          <NativeSelectOption value="true">True</NativeSelectOption>
          <NativeSelectOption value="false">False</NativeSelectOption>
        </NativeSelect>
      </label>
    );
  }

  if (column.semantics.filterFamily === "select" && column.selectOptions !== undefined) {
    const selectOptions = column.selectOptions;
    const optionCount = selectOptions.length;
    const maxOptionWindowStart = Math.max(0, optionCount - FILTER_SELECT_VISIBLE_OPTIONS);
    const optionWindowStart = Math.min(selectOptionWindowStart, maxOptionWindowStart);
    const optionWindowEnd = Math.min(
      optionCount,
      optionWindowStart + FILTER_SELECT_VISIBLE_OPTIONS,
    );
    const visibleOptionIndexes = Array.from(
      { length: optionWindowEnd - optionWindowStart },
      (_, offset) => optionWindowStart + offset,
    );
    if (
      draft.selectIndex !== undefined &&
      (draft.selectIndex < optionWindowStart || draft.selectIndex >= optionWindowEnd)
    ) {
      visibleOptionIndexes.unshift(draft.selectIndex);
    }
    return (
      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor={`${errorId}-${path}-value`}>Value</label>
        {optionCount > FILTER_SELECT_VISIBLE_OPTIONS ? (
          <div className="flex items-center justify-between gap-2 text-sm">
            <span aria-live="polite" role="status">
              {`Showing options ${String(optionWindowStart + 1)}–${String(optionWindowEnd)} of ${optionCount.toLocaleString("en-US")}`}
            </span>
            <div className="flex gap-1">
              <Button
                aria-label={`Previous filter options for ${column.headerName}${labelSuffix}`}
                disabled={optionWindowStart === 0}
                size="xs"
                type="button"
                variant="ghost"
                onClick={() =>
                  setSelectOptionWindowStart(
                    Math.max(0, optionWindowStart - FILTER_SELECT_VISIBLE_OPTIONS),
                  )
                }
              >
                Previous
              </Button>
              <Button
                aria-label={`Next filter options for ${column.headerName}${labelSuffix}`}
                disabled={optionWindowEnd === optionCount}
                size="xs"
                type="button"
                variant="ghost"
                onClick={() =>
                  setSelectOptionWindowStart(
                    Math.min(
                      maxOptionWindowStart,
                      optionWindowStart + FILTER_SELECT_VISIBLE_OPTIONS,
                    ),
                  )
                }
              >
                Next
              </Button>
            </div>
          </div>
        ) : null}
        <NativeSelect
          ref={selectRef}
          id={`${errorId}-${path}-value`}
          aria-label={inputLabel}
          aria-invalid={isInvalidControl("value") ? "true" : undefined}
          aria-describedby={isInvalidControl("value") ? errorId : undefined}
          value={draft.selectIndex === undefined ? "" : selectOptionToken(draft.selectIndex)}
          onChange={(event) => {
            const token = event.currentTarget.value;
            const index = parseSelectOptionToken(token);
            const option = index === undefined ? undefined : column.selectOptions?.[index];
            onChange(
              Object.freeze({
                ...draft,
                first:
                  option === undefined ? "" : (formatFilterEditorCanonical(column, option) ?? ""),
                firstAuthored: option !== undefined,
                selectIndex: index,
              }),
              "immediate",
            );
          }}
        >
          <NativeSelectOption value="">Choose a value</NativeSelectOption>
          {visibleOptionIndexes.map((index) => {
            return (
              <NativeSelectOption key={String(index)} value={selectOptionToken(index)}>
                {formatFilterEditorDisplay(column, selectOptions[index])}
              </NativeSelectOption>
            );
          })}
        </NativeSelect>
      </div>
    );
  }

  const isRange = draft.operator === "inRange";
  const isBigInt = column.semantics.editorFamily === "bigint";
  const isNumber = column.semantics.editorFamily === "number";
  const type = isNumber ? "number" : "text";
  const inputMode = isBigInt
    ? "numeric"
    : column.semantics.editorFamily === "bigdecimal"
      ? "decimal"
      : undefined;
  const visibleValues = values.slice(
    visibleOperandWindowStart,
    visibleOperandWindowStart + FILTER_IN_VISIBLE_OPERANDS,
  );
  return (
    <div className="flex flex-col gap-2">
      {isIn ? (
        <div
          aria-label={`Filter values for ${column.headerName}${labelSuffix}`}
          role="group"
          className="flex flex-col gap-2"
        >
          {values.length > FILTER_IN_VISIBLE_OPERANDS ? (
            <div className="flex flex-col gap-1 text-sm">
              <p aria-live="polite">
                {`Showing values ${String(visibleOperandWindowStart + 1)}-${String(
                  Math.min(values.length, visibleOperandWindowStart + FILTER_IN_VISIBLE_OPERANDS),
                )} of ${String(values.length)}`}
              </p>
              <div className="flex gap-1">
                <Button
                  aria-label={`Previous filter values for ${column.headerName}${labelSuffix}`}
                  disabled={visibleOperandWindowStart === 0}
                  size="xs"
                  type="button"
                  variant="outline"
                  onClick={() =>
                    setOperandWindowStart((current) =>
                      Math.max(0, current - FILTER_IN_VISIBLE_OPERANDS),
                    )
                  }
                >
                  Previous values
                </Button>
                <Button
                  aria-label={`Next filter values for ${column.headerName}${labelSuffix}`}
                  disabled={visibleOperandWindowStart >= maxOperandWindowStart}
                  size="xs"
                  type="button"
                  variant="outline"
                  onClick={() =>
                    setOperandWindowStart((current) =>
                      Math.min(maxOperandWindowStart, current + FILTER_IN_VISIBLE_OPERANDS),
                    )
                  }
                >
                  Next values
                </Button>
              </div>
            </div>
          ) : null}
          {visibleValues.map((value, offset) => {
            const index = visibleOperandWindowStart + offset;
            return (
              <div key={String(index)} className="flex items-end gap-1">
                <label
                  className="flex min-w-0 flex-1 flex-col gap-1 text-sm"
                  htmlFor={`${errorId}-${path}-value-${String(index)}`}
                >
                  {index === 0 ? "Value" : `Value ${String(index + 1)}`}
                  <Input
                    ref={index === 0 ? inputRef : undefined}
                    id={`${errorId}-${path}-value-${String(index)}`}
                    aria-describedby={
                      isInvalidControl(`value-${String(index)}`) ? errorId : undefined
                    }
                    aria-invalid={isInvalidControl(`value-${String(index)}`) ? "true" : undefined}
                    aria-label={
                      index === 0
                        ? inputLabel
                        : `Filter value ${String(index + 1)} for ${column.headerName}${labelSuffix}`
                    }
                    inputMode={inputMode}
                    maxLength={BRUNO_TABLE_MAX_FILTER_OPERAND_LENGTH}
                    onCompositionEnd={(event) =>
                      finishComposition(event, (current, nextValue) => {
                        const currentValues =
                          current.inValues.length > 0 ? current.inValues : [current.first];
                        const nextValues = currentValues.slice();
                        nextValues[index] = nextValue;
                        const currentValuesAuthored =
                          current.inValuesAuthored.length > 0
                            ? current.inValuesAuthored
                            : [current.firstAuthored];
                        const nextValuesAuthored = currentValuesAuthored.slice() as boolean[];
                        nextValuesAuthored[index] = true;
                        return Object.freeze({
                          ...current,
                          first: nextValues[0] ?? "",
                          firstAuthored: nextValuesAuthored[0] === true,
                          inValues: Object.freeze(nextValues),
                          inValuesAuthored: Object.freeze(nextValuesAuthored),
                          inValuesExplicit: true,
                        });
                      })
                    }
                    onCompositionStart={beginComposition}
                    step={isNumber ? "any" : undefined}
                    type={type}
                    value={value}
                    onChange={(event) => {
                      if (isCompositionInvalidated()) return;
                      const nextValues = values.slice();
                      nextValues[index] = boundBrunoTableFilterOperandText(
                        event.currentTarget.value,
                      );
                      const nextValuesAuthored = (
                        draft.inValuesAuthored.length > 0
                          ? draft.inValuesAuthored
                          : [draft.firstAuthored]
                      ).slice() as boolean[];
                      nextValuesAuthored[index] = true;
                      publishOperandChange(
                        Object.freeze({
                          ...draft,
                          first: nextValues[0] ?? "",
                          firstAuthored: nextValuesAuthored[0] === true,
                          inValues: Object.freeze(nextValues),
                          inValuesAuthored: Object.freeze(nextValuesAuthored),
                          inValuesExplicit: true,
                        }),
                        isNumber && event.currentTarget.validity.badInput,
                      );
                    }}
                  />
                </label>
                {values.length > 1 ? (
                  <Button
                    aria-label={`Remove filter value ${String(index + 1)} for ${column.headerName}${labelSuffix}`}
                    size="icon-xs"
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      const nextValues = values.filter((_, candidate) => candidate !== index);
                      const nextValuesAuthored = Object.freeze(
                        nextValues.map((_, candidate) => {
                          const sourceIndex = candidate >= index ? candidate + 1 : candidate;
                          return (
                            (draft.inValuesAuthored.length > 0
                              ? draft.inValuesAuthored
                              : [draft.firstAuthored])[sourceIndex] ?? false
                          );
                        }),
                      );
                      const nextFocusId =
                        nextValues.length === 0
                          ? `${errorId}-${path}-add-value`
                          : `${errorId}-${path}-value-${String(Math.min(index, nextValues.length - 1))}`;
                      onChange(
                        Object.freeze({
                          ...draft,
                          first: nextValues[0] ?? "",
                          firstAuthored: nextValuesAuthored[0] === true,
                          inValues: Object.freeze(nextValues),
                          inValuesExplicit: true,
                          inValuesAuthored: nextValuesAuthored,
                        }),
                        "immediate",
                      );
                      focusAddedControl(nextFocusId);
                    }}
                  >
                    ×
                  </Button>
                ) : null}
              </div>
            );
          })}
          <Button
            aria-label={`Add filter value for ${column.headerName}${labelSuffix}`}
            id={`${errorId}-${path}-add-value`}
            size="xs"
            type="button"
            variant="outline"
            disabled={!canAddFilterValue}
            onClick={() => {
              if (!canAddFilterValue) return;
              const nextIndex = values.length;
              setOperandWindowStart(Math.max(0, nextIndex - FILTER_IN_VISIBLE_OPERANDS + 1));
              onChange(
                Object.freeze({
                  ...draft,
                  inValues: Object.freeze([...values, ""]),
                  inValuesAuthored: Object.freeze([
                    ...(draft.inValuesAuthored.length > 0
                      ? draft.inValuesAuthored
                      : values.map((_, index) => index === 0 && draft.firstAuthored)),
                    false,
                  ]),
                  inValuesExplicit: true,
                }),
                "immediate",
              );
              focusAddedControl(`${errorId}-${path}-value-${String(nextIndex)}`);
            }}
          >
            Add value
          </Button>
        </div>
      ) : (
        <label className="flex flex-col gap-1 text-sm" htmlFor={`${errorId}-${path}-value`}>
          Value
          <Input
            ref={inputRef}
            id={`${errorId}-${path}-value`}
            aria-describedby={isInvalidControl("value") ? errorId : undefined}
            aria-invalid={isInvalidControl("value") ? "true" : undefined}
            aria-label={inputLabel}
            inputMode={inputMode}
            maxLength={BRUNO_TABLE_MAX_FILTER_OPERAND_LENGTH}
            onCompositionEnd={(event) =>
              finishComposition(event, (current, nextValue) =>
                Object.freeze({ ...current, first: nextValue, firstAuthored: true }),
              )
            }
            onCompositionStart={beginComposition}
            step={isNumber ? "any" : undefined}
            type={type}
            value={draft.first}
            onChange={(event) => {
              if (isCompositionInvalidated()) return;
              const value = boundBrunoTableFilterOperandText(event.currentTarget.value);
              publishOperandChange(
                Object.freeze({ ...draft, first: value, firstAuthored: true }),
                isNumber && event.currentTarget.validity.badInput,
              );
            }}
          />
        </label>
      )}
      {isRange ? (
        <label className="flex flex-col gap-1 text-sm" htmlFor={`${errorId}-${path}-value-to`}>
          Less than
          <Input
            id={`${errorId}-${path}-value-to`}
            aria-describedby={isInvalidControl("value-to") ? errorId : undefined}
            aria-invalid={isInvalidControl("value-to") ? "true" : undefined}
            aria-label={`Filter upper bound for ${column.headerName}${labelSuffix}`}
            inputMode={inputMode}
            maxLength={BRUNO_TABLE_MAX_FILTER_OPERAND_LENGTH}
            onCompositionEnd={(event) =>
              finishComposition(event, (current, nextValue) =>
                Object.freeze({ ...current, second: nextValue, secondAuthored: true }),
              )
            }
            onCompositionStart={beginComposition}
            step={isNumber ? "any" : undefined}
            type={type}
            value={draft.second}
            onChange={(event) => {
              if (isCompositionInvalidated()) return;
              const value = boundBrunoTableFilterOperandText(event.currentTarget.value);
              publishOperandChange(
                Object.freeze({ ...draft, second: value, secondAuthored: true }),
                isNumber && event.currentTarget.validity.badInput,
              );
            }}
          />
        </label>
      ) : null}
    </div>
  );
}

function filterOperators(column: CompiledColumn): readonly FilterOperator[] {
  switch (column.semantics.filterFamily) {
    case "text":
      return Object.freeze([
        "equals",
        "notEqual",
        "contains",
        "notContains",
        "startsWith",
        "endsWith",
        "in",
        "blank",
        "notBlank",
      ]);
    case "numeric":
      return Object.freeze([
        "equals",
        "notEqual",
        "in",
        "greaterThan",
        "greaterThanOrEqual",
        "lessThan",
        "lessThanOrEqual",
        "inRange",
        "blank",
        "notBlank",
      ]);
    case "boolean":
    case "select":
      return Object.freeze(["equals", "notEqual", "blank", "notBlank"]);
    case "equality":
      return Object.freeze(["equals", "notEqual", "blank", "notBlank"]);
    default:
      return Object.freeze(["equals", "notEqual"]);
  }
}

type FilterDraftMaterializationState = {
  readonly memo: WeakMap<object, FilterDraft>;
  readonly active: WeakSet<object>;
  readonly complexityMemo: WeakMap<object, FilterDraftComplexity>;
};

function draftFromCommitted(column: CompiledColumn, committed: unknown): FilterDraft {
  if (Array.isArray(committed)) {
    committed = Object.freeze({ type: "AND", conditions: Object.freeze([...committed]) });
  }
  return draftFromNode(column, asRecord(committed), createFilterDraftMaterializationState(), 0);
}

function createOpaqueFilterDraft(
  record: Readonly<Record<string, unknown>>,
  state: FilterDraftMaterializationState,
): FilterDraft {
  const draft = Object.freeze({ kind: "opaque", committed: record });
  FILTER_DRAFT_COMPLEXITY.set(
    draft,
    countCommittedFilterDraftComplexity(record, state.complexityMemo),
  );
  FILTER_DRAFT_CANDIDATE.set(draft, record);
  return draft;
}

function createFilterDraftMaterializationState(): FilterDraftMaterializationState {
  return {
    memo: new WeakMap<object, FilterDraft>(),
    active: new WeakSet<object>(),
    complexityMemo: new WeakMap<object, FilterDraftComplexity>(),
  };
}

function draftFromNode(
  column: CompiledColumn,
  record: Readonly<Record<string, unknown>>,
  state: FilterDraftMaterializationState,
  depth: number,
): FilterDraft {
  const cached = state.memo.get(record);
  if (cached !== undefined) return cached;
  if (depth > BRUNO_TABLE_CLIENT_FILTER_MAX_DEPTH || state.active.has(record)) {
    return createOpaqueFilterDraft(record, state);
  }
  state.active.add(record);
  const type = record["type"];
  try {
    if ((type === "AND" || type === "OR") && Array.isArray(record["conditions"])) {
      const conditions = record["conditions"].map((condition, index) => {
        const childRecord = asRecord(condition);
        return index < FILTER_COMPOUND_VISIBLE_CONDITIONS
          ? draftFromNode(column, childRecord, state, depth + 1)
          : createOpaqueFilterDraft(childRecord, state);
      });
      if (conditions.length >= 1) {
        const draft = Object.freeze({
          kind: "compound",
          operator: type,
          conditions: Object.freeze(conditions) as readonly [FilterDraft, ...FilterDraft[]],
        });
        state.memo.set(record, draft);
        countFilterDraftComplexity(draft);
        FILTER_DRAFT_CANDIDATE.set(draft, record);
        return draft;
      }
    }
    if (type === "NOT" && record["condition"] !== undefined) {
      const draft = Object.freeze({
        kind: "not",
        condition: draftFromNode(column, asRecord(record["condition"]), state, depth + 1),
      });
      state.memo.set(record, draft);
      countFilterDraftComplexity(draft);
      FILTER_DRAFT_CANDIDATE.set(draft, record);
      return draft;
    }
    const operator = isFilterOperator(type) ? type : defaultFilterOperator(column);
    const rawFilter = record["filter"];
    const inValues =
      operator === "in" && Array.isArray(rawFilter)
        ? Object.freeze(rawFilter.map((value) => formatOperand(column, value) ?? ""))
        : Object.freeze([]);
    const first =
      operator === "in"
        ? (inValues[0] ?? "")
        : (formatFilterDraftOperand(column, operator, rawFilter) ?? defaultOperand(column));
    const draft = Object.freeze({
      kind: "leaf",
      operator,
      first,
      firstAuthored:
        operator === "in"
          ? inValues.length > 0
          : rawFilter !== undefined &&
            formatFilterDraftOperand(column, operator, rawFilter) !== undefined,
      second: formatOperand(column, record["filterTo"]) ?? "",
      secondAuthored: record["filterTo"] !== undefined,
      inValues,
      inValuesAuthored: Object.freeze(
        operator === "in" && Array.isArray(rawFilter) ? rawFilter.map(() => true) : [],
      ),
      inValuesExplicit: operator === "in" && Array.isArray(rawFilter),
      selectIndex:
        column.semantics.filterFamily === "select"
          ? findSelectOptionIndex(
              column,
              operator === "in" && Array.isArray(rawFilter) ? rawFilter[0] : rawFilter,
            )
          : undefined,
      caseSensitive: record["caseSensitive"] === true,
      accentSensitive: record["accentSensitive"] === true,
    });
    state.memo.set(record, draft);
    countFilterDraftComplexity(draft);
    FILTER_DRAFT_CANDIDATE.set(draft, record);
    return draft;
  } finally {
    state.active.delete(record);
  }
}

function buildFilterCandidate(
  column: CompiledColumn,
  draft: FilterDraft,
  parseCache?: FilterParseCache,
  path = "root",
): FilterCandidate {
  const cached = FILTER_DRAFT_CANDIDATE.get(draft);
  if (cached !== undefined) return { filter: cached };
  if (draft.kind === "opaque") return { filter: draft.committed };
  if (draft.kind === "not") {
    const condition = buildFilterCandidate(column, draft.condition, parseCache, `${path}-not`);
    if (condition.filter === undefined) return condition;
    const filter = Object.freeze({ type: "NOT", condition: condition.filter });
    FILTER_DRAFT_CANDIDATE.set(draft, filter);
    return { filter };
  }
  if (draft.kind === "compound") {
    const conditions: FilterNode[] = [];
    for (const [index, conditionDraft] of draft.conditions.entries()) {
      const condition = buildFilterCandidate(
        column,
        conditionDraft,
        parseCache,
        `${path}-${String(index)}`,
      );
      if (condition.filter === undefined) return condition;
      conditions.push(condition.filter);
    }
    const filter = Object.freeze({
      type: draft.operator,
      conditions: Object.freeze(conditions),
    });
    FILTER_DRAFT_CANDIDATE.set(draft, filter);
    return { filter };
  }
  const candidate = buildLeafFilterCandidate(column, draft, parseCache, path);
  if (candidate.filter !== undefined) {
    FILTER_DRAFT_CANDIDATE.set(draft, candidate.filter);
  }
  return candidate;
}

function buildFilterCandidateForDraftChange(
  column: CompiledColumn,
  previous: FilterDraft,
  next: FilterDraft,
  parseCache?: FilterParseCache,
  changedPath?: readonly FilterDraftPathSegment[],
): FilterCandidate {
  if (changedPath !== undefined) {
    return buildFilterCandidateAlongPath(column, previous, next, changedPath, parseCache, "root");
  }
  return buildFilterCandidate(column, next, parseCache);
}

function buildFilterCandidateAlongPath(
  column: CompiledColumn,
  previous: FilterDraft,
  next: FilterDraft,
  path: readonly FilterDraftPathSegment[],
  parseCache: FilterParseCache | undefined,
  controlPath: string,
): FilterCandidate {
  const [segment, ...remaining] = path;
  if (segment === undefined) {
    if (
      previous.kind === "compound" &&
      next.kind === "compound" &&
      previous.conditions === next.conditions
    ) {
      const conditions = getFilterDraftCandidateConditions(previous);
      if (conditions !== undefined) {
        const filter = Object.freeze({ type: next.operator, conditions });
        FILTER_DRAFT_CANDIDATE.set(next, filter);
        return { filter };
      }
    }
    if (next.kind === "not" && next.condition === previous) {
      const condition = FILTER_DRAFT_CANDIDATE.get(previous);
      if (condition !== undefined) {
        const filter = Object.freeze({ type: "NOT", condition });
        FILTER_DRAFT_CANDIDATE.set(next, filter);
        return { filter };
      }
    }
    return buildFilterCandidate(column, next, parseCache, controlPath);
  }
  if (typeof segment === "number" && previous.kind === "compound" && next.kind === "compound") {
    const previousCondition = previous.conditions[segment];
    const nextCondition = next.conditions[segment];
    const conditions = getFilterDraftCandidateConditions(previous);
    if (
      previousCondition === undefined ||
      nextCondition === undefined ||
      conditions === undefined
    ) {
      return buildFilterCandidate(column, next, parseCache, controlPath);
    }
    const candidate = buildFilterCandidateAlongPath(
      column,
      previousCondition,
      nextCondition,
      remaining,
      parseCache,
      `${controlPath}-${String(segment)}`,
    );
    if (candidate.filter === undefined) return candidate;
    const nextConditions = conditions.slice();
    nextConditions[segment] = candidate.filter;
    const frozenConditions = Object.freeze(nextConditions);
    const filter = Object.freeze({ type: next.operator, conditions: frozenConditions });
    FILTER_DRAFT_CANDIDATE.set(next, filter);
    return { filter };
  }
  if (segment === "not" && previous.kind === "not" && next.kind === "not") {
    const candidate = buildFilterCandidateAlongPath(
      column,
      previous.condition,
      next.condition,
      remaining,
      parseCache,
      `${controlPath}-not`,
    );
    if (candidate.filter === undefined) return candidate;
    const filter = Object.freeze({ type: "NOT", condition: candidate.filter });
    FILTER_DRAFT_CANDIDATE.set(next, filter);
    return { filter };
  }
  return buildFilterCandidate(column, next, parseCache, controlPath);
}

function getFilterDraftCandidateConditions(draft: FilterDraft): readonly FilterNode[] | undefined {
  if (draft.kind !== "compound") return undefined;
  const candidate = FILTER_DRAFT_CANDIDATE.get(draft);
  if (candidate === undefined) return undefined;
  const conditions = candidate["conditions"];
  return Array.isArray(conditions) ? (conditions as readonly FilterNode[]) : undefined;
}

function parseFilterText(
  column: CompiledColumn,
  text: string,
  cache: FilterParseCache | undefined,
): FilterParseResult {
  const key = `${column.columnId}\u0000${column.semantics.codecId}\u0000${String(column.semantics.codecVersion)}\u0000${text}`;
  const cached = cache?.get(key);
  if (cached !== undefined) return cached;
  const result = column.semantics.parseCanonicalText(text);
  cache?.set(key, result);
  return result;
}

function buildLeafFilterCandidate(
  column: CompiledColumn,
  draft: FilterLeafDraft,
  parseCache?: FilterParseCache,
  path = "root",
): FilterCandidate {
  const base = {
    columnId: column.columnId,
    type: draft.operator,
    ...(column.semantics.filterFamily === "text"
      ? {
          caseSensitive: draft.caseSensitive,
          accentSensitive: draft.accentSensitive,
        }
      : {}),
  } satisfies Record<string, unknown>;
  if (draft.operator === "blank" || draft.operator === "notBlank") {
    return { filter: Object.freeze(base) };
  }
  if (isSubstringFilterOperator(draft.operator)) {
    if (!draft.firstAuthored)
      return {
        filter: undefined,
        error: "Enter one or more valid values.",
        invalidControl: `${path}-value`,
      };
    if (
      normalizeBrunoTableFilterText(draft.first, draft.caseSensitive, draft.accentSensitive)
        .length === 0
    ) {
      return {
        filter: undefined,
        error: "Enter a non-empty search value.",
        invalidControl: `${path}-value`,
      };
    }
    return { filter: Object.freeze({ ...base, filter: draft.first }) };
  }
  if (draft.operator === "in") {
    if (!draft.inValuesExplicit && !draft.firstAuthored) {
      return {
        filter: undefined,
        error: "Enter one or more valid values.",
        invalidControl: `${path}-value-0`,
      };
    }
    const authored = draft.inValuesExplicit ? draft.inValuesAuthored : [draft.firstAuthored];
    const unauthoredIndex = authored.findIndex((value) => !value);
    if (unauthoredIndex >= 0) {
      return {
        filter: undefined,
        error: "Enter one or more valid values.",
        invalidControl: `${path}-value-${String(unauthoredIndex)}`,
      };
    }
    const values = draft.inValuesExplicit ? draft.inValues : [draft.first];
    if (values.length === 0) {
      return {
        filter: undefined,
        error: "Enter one or more valid values.",
        invalidControl: `${path}-value-0`,
      };
    }
    const decoded = values.map((value) => parseFilterText(column, value, parseCache));
    const invalidIndex = decoded.findIndex((result) => result._tag === "Failure");
    const invalid = decoded[invalidIndex];
    if (invalid?._tag === "Failure") {
      return {
        filter: undefined,
        error: invalid.message,
        invalidControl: `${path}-value-${String(invalidIndex)}`,
      };
    }
    const emptyIndex =
      column.semantics.filterFamily === "text"
        ? decoded.findIndex((result) => {
            if (result._tag !== "Success") return false;
            try {
              return (
                normalizeBrunoTableFilterText(
                  formatFilterSemanticCanonical(column, result.value),
                  draft.caseSensitive,
                  draft.accentSensitive,
                ).length === 0
              );
            } catch {
              return true;
            }
          })
        : -1;
    if (emptyIndex >= 0) {
      return {
        filter: undefined,
        error: "Enter non-empty values.",
        invalidControl: `${path}-value-${String(emptyIndex)}`,
      };
    }
    return {
      filter: Object.freeze({
        ...base,
        filter: Object.freeze(
          decoded.map((result) => (result._tag === "Success" ? result.value : undefined)),
        ),
      }),
    };
  }
  if (column.semantics.filterFamily === "select" && column.selectOptions !== undefined) {
    const option =
      draft.selectIndex === undefined ? undefined : column.selectOptions?.[draft.selectIndex];
    if (option === undefined) {
      return { filter: undefined, error: "Choose a value.", invalidControl: `${path}-value` };
    }
    return { filter: Object.freeze({ ...base, filter: option }) };
  }
  if (!draft.firstAuthored) {
    return {
      filter: undefined,
      error: "Enter one or more valid values.",
      invalidControl: `${path}-value`,
    };
  }
  const first = parseFilterText(column, draft.first, parseCache);
  if (first._tag === "Failure") {
    return { filter: undefined, error: first.message, invalidControl: `${path}-value` };
  }
  if (draft.operator === "inRange") {
    if (!draft.secondAuthored) {
      return {
        filter: undefined,
        error: "Enter an upper bound.",
        invalidControl: `${path}-value-to`,
      };
    }
    const second = parseFilterText(column, draft.second, parseCache);
    if (second._tag === "Failure") {
      return { filter: undefined, error: second.message, invalidControl: `${path}-value-to` };
    }
    try {
      if (column.semantics.compare(first.value, second.value) >= 0) {
        return {
          filter: undefined,
          error: "Upper bound must be greater than the lower bound.",
          invalidControl: `${path}-value-to`,
        };
      }
    } catch {
      return {
        filter: undefined,
        error: "Enter an ordered range.",
        invalidControl: `${path}-value-to`,
      };
    }
    return {
      filter: Object.freeze({ ...base, filter: first.value, filterTo: second.value }),
    };
  }
  return { filter: Object.freeze({ ...base, filter: first.value }) };
}

function changeExpressionMode(
  column: CompiledColumn,
  draft: FilterDraft,
  mode: string,
): FilterDraft {
  if (mode === "leaf") {
    if (draft.kind === "leaf") return draft;
    return firstFilterLeaf(column, draft);
  }
  if (mode === "NOT") {
    if (draft.kind === "not") return draft;
    const next = Object.freeze({ kind: "not", condition: draft });
    const current = countFilterDraftComplexity(draft);
    cacheKnownFilterDraftComplexity(next, current.nodes + 1, current.operands);
    return next;
  }
  if (mode !== "AND" && mode !== "OR") return draft;
  if (draft.kind === "compound") {
    const next = Object.freeze({
      ...draft,
      operator: mode,
    });
    const current = countFilterDraftComplexity(draft);
    cacheKnownFilterDraftComplexity(next, current.nodes, current.operands);
    return next;
  }
  const condition = createDefaultLeaf(column);
  const next = Object.freeze({
    kind: "compound",
    operator: mode,
    conditions: Object.freeze([draft, condition]) as readonly [FilterDraft, FilterDraft],
  });
  const current = countFilterDraftComplexity(draft);
  const added = countFilterDraftComplexity(condition);
  cacheKnownFilterDraftComplexity(
    next,
    current.nodes + added.nodes + 1,
    current.operands + added.operands,
  );
  return next;
}

function firstFilterLeaf(column: CompiledColumn, draft: FilterDraft): FilterLeafDraft {
  if (draft.kind === "leaf") return draft;
  if (draft.kind === "not") return firstFilterLeaf(column, draft.condition);
  if (draft.kind === "opaque") return createDefaultLeaf(column);
  return firstFilterLeaf(column, draft.conditions[0]);
}

function createDefaultLeaf(column: CompiledColumn): FilterLeafDraft {
  const draft = Object.freeze({
    kind: "leaf",
    operator: defaultFilterOperator(column),
    first: defaultOperand(column),
    firstAuthored: false,
    second: "",
    secondAuthored: false,
    inValues: Object.freeze([]),
    inValuesAuthored: Object.freeze([]),
    inValuesExplicit: false,
    selectIndex: undefined,
    caseSensitive: false,
    accentSensitive: false,
  });
  countFilterDraftComplexity(draft);
  return draft;
}

function countCommittedFilterDraftComplexity(
  record: Readonly<Record<string, unknown>>,
  memo: WeakMap<object, FilterDraftComplexity>,
): FilterDraftComplexity {
  const cached = memo.get(record);
  if (cached !== undefined) return cached;
  const type = record["type"];
  let complexity: FilterDraftComplexity;
  if ((type === "AND" || type === "OR") && Array.isArray(record["conditions"])) {
    complexity = record["conditions"].reduce<FilterDraftComplexity>(
      (total, condition) => {
        const next = countCommittedFilterDraftComplexity(asRecord(condition), memo);
        return { nodes: total.nodes + next.nodes, operands: total.operands + next.operands };
      },
      { nodes: 1, operands: 0 },
    );
  } else if (type === "NOT" && record["condition"] !== undefined) {
    const condition = countCommittedFilterDraftComplexity(asRecord(record["condition"]), memo);
    complexity = { nodes: condition.nodes + 1, operands: condition.operands };
  } else {
    const filter = record["filter"];
    complexity = {
      nodes: 1,
      operands:
        type === "blank" || type === "notBlank" || type === "matchNone"
          ? 0
          : type === "in" && Array.isArray(filter)
            ? filter.length
            : Number(filter !== undefined) +
              Number(type === "inRange" && record["filterTo"] !== undefined),
    };
  }
  const frozen = Object.freeze(complexity);
  memo.set(record, frozen);
  return frozen;
}

function cacheFilterDraftComplexityDelta(
  next: FilterDraft,
  previous: FilterDraft,
  removed?: FilterDraft,
  added?: FilterDraft,
): void {
  const previousComplexity = countFilterDraftComplexity(previous);
  const removedComplexity =
    removed === undefined ? { nodes: 0, operands: 0 } : countFilterDraftComplexity(removed);
  const addedComplexity =
    added === undefined ? { nodes: 0, operands: 0 } : countFilterDraftComplexity(added);
  FILTER_DRAFT_COMPLEXITY.set(
    next,
    Object.freeze({
      nodes: previousComplexity.nodes - removedComplexity.nodes + addedComplexity.nodes,
      operands: previousComplexity.operands - removedComplexity.operands + addedComplexity.operands,
    }),
  );
}

function cacheKnownFilterDraftComplexity(
  draft: FilterDraft,
  nodes: number,
  operands: number,
): void {
  FILTER_DRAFT_COMPLEXITY.set(draft, Object.freeze({ nodes, operands }));
}

function countFilterDraftComplexity(draft: FilterDraft): FilterDraftComplexity {
  const cached = FILTER_DRAFT_COMPLEXITY.get(draft);
  if (cached !== undefined) return cached;
  let complexity: FilterDraftComplexity;
  if (draft.kind === "opaque") {
    complexity = { nodes: 1, operands: 0 };
  } else if (draft.kind === "not") {
    const condition = countFilterDraftComplexity(draft.condition);
    complexity = { nodes: condition.nodes + 1, operands: condition.operands };
  } else if (draft.kind === "compound") {
    complexity = draft.conditions.reduce<FilterDraftComplexity>(
      (total, condition) => {
        const next = countFilterDraftComplexity(condition);
        return { nodes: total.nodes + next.nodes, operands: total.operands + next.operands };
      },
      { nodes: 1, operands: 0 },
    );
  } else if (draft.operator === "blank" || draft.operator === "notBlank") {
    complexity = { nodes: 1, operands: 0 };
  } else if (draft.operator === "in") {
    complexity = {
      nodes: 1,
      operands: draft.inValuesExplicit ? draft.inValues.length : draft.firstAuthored ? 1 : 0,
    };
  } else {
    complexity = {
      nodes: 1,
      operands:
        Number(draft.firstAuthored) + Number(draft.operator === "inRange" && draft.secondAuthored),
    };
  }
  const frozen = Object.freeze(complexity);
  FILTER_DRAFT_COMPLEXITY.set(draft, frozen);
  return frozen;
}

function formatOperand(column: CompiledColumn, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return formatFilterEditorCanonical(column, value);
}

function formatFilterEditorCanonical(column: CompiledColumn, value: unknown): string | undefined {
  try {
    // This is the committed operand presentation, not a display label. The collection-wide
    // admission ledger already bounds retained materialized text, while the editor must preserve
    // exact long text, BigInt, and optional BigDecimal values when changing operators.
    return column.semantics.formatCanonicalText(value);
  } catch {
    return undefined;
  }
}

function formatFilterSemanticCanonical(column: CompiledColumn, value: unknown): string {
  try {
    return column.semantics.formatCanonicalText(value);
  } catch {
    return "";
  }
}

function formatFilterEditorDisplay(column: CompiledColumn, value: unknown): string {
  try {
    return boundBrunoTableFilterOperandText(column.semantics.formatDisplay(value));
  } catch {
    return "<unavailable>";
  }
}

function formatFilterDraftOperand(
  column: CompiledColumn,
  operator: FilterOperator,
  value: unknown,
): string | undefined {
  if (isSubstringFilterOperator(operator) && typeof value === "string") {
    return value;
  }
  return formatOperand(column, value);
}

function isSubstringFilterOperator(operator: FilterOperator): boolean {
  return (
    operator === "contains" ||
    operator === "notContains" ||
    operator === "startsWith" ||
    operator === "endsWith"
  );
}

function supportsTextSensitivity(operator: FilterOperator): boolean {
  return (
    operator === "equals" ||
    operator === "notEqual" ||
    operator === "in" ||
    isSubstringFilterOperator(operator)
  );
}

function findSelectOptionIndex(column: CompiledColumn, value: unknown): number | undefined {
  if (value === undefined || column.selectOptions === undefined) return undefined;
  const exactIndex = column.selectOptionIndexes?.get(value);
  if (exactIndex !== undefined && Object.is(column.selectOptions[exactIndex], value)) {
    return exactIndex;
  }
  // Committed Select snapshots have already crossed the filter admission seam and retain the
  // exact configured option object. Do not invoke custom equivalence while rendering an editor;
  // an unrecognized external value remains unselected until the next admitted command.
  return undefined;
}

function defaultFilterOperator(column: CompiledColumn): FilterOperator {
  return filterOperators(column)[0] ?? "equals";
}

function defaultOperand(_column: CompiledColumn): string {
  return "";
}

function isBuiltInBooleanColumn(column: CompiledColumn): boolean {
  return column.valueType === "boolean";
}

function isFilterOperator(value: unknown): value is FilterOperator {
  return typeof value === "string" && filterOperatorSet.has(value as FilterOperator);
}

function operatorLabelText(operator: FilterOperator): string {
  const labels: Record<FilterOperator, string> = {
    equals: "Equals",
    notEqual: "Does not equal",
    contains: "Contains",
    notContains: "Does not contain",
    startsWith: "Starts with",
    endsWith: "Ends with",
    in: "Is one of",
    greaterThan: "Greater than",
    greaterThanOrEqual: "Greater than or equal",
    lessThan: "Less than",
    lessThanOrEqual: "Less than or equal",
    inRange: "In range (upper bound exclusive)",
    blank: "Is blank",
    notBlank: "Is not blank",
  };
  return labels[operator];
}

function labelForContent(column: CompiledColumn): string {
  return `Filter ${column.headerName}`;
}

function filterExpressionPathLabel(path: string): string | undefined {
  if (path === "root") return undefined;
  return path
    .split("-")
    .slice(1)
    .map((segment) => {
      if (segment === "not") return "NOT condition";
      const index = Number(segment);
      return Number.isInteger(index) && index >= 0
        ? `condition ${String(index + 1)}`
        : "nested condition";
    })
    .join(" / ");
}

function selectOptionToken(index: number): string {
  return `bruno-select-option-${String(index)}`;
}

function parseSelectOptionToken(value: string): number | undefined {
  const prefix = "bruno-select-option-";
  if (!value.startsWith(prefix)) return undefined;
  const index = Number(value.slice(prefix.length));
  return Number.isInteger(index) && index >= 0 ? index : undefined;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

const filterOperatorSet = new Set<FilterOperator>([
  "equals",
  "notEqual",
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "in",
  "greaterThan",
  "greaterThanOrEqual",
  "lessThan",
  "lessThanOrEqual",
  "inRange",
  "blank",
  "notBlank",
]);
