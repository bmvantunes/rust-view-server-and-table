import type { CompiledColumn } from "./compile-columns";
import { readCompiledColumnValue } from "./cell-value";
import {
  brunoTableSetValueKey,
  createBrunoTableSetValueIndex,
  hasBrunoTableSetValue,
  type BrunoTableSetValueIndex,
} from "./set-value-identity";
import { captureBrunoTablePlainRecord } from "./untrusted-input";

export type ClientOrderBy = readonly {
  readonly columnId: string;
  readonly direction: "asc" | "desc";
}[];

export type BrunoTableOrderBy = ClientOrderBy;

type CompiledFilterOperandPlan = Readonly<{
  readonly normalizedOperand?: string | undefined;
  readonly normalizedOperands?: readonly (string | undefined)[] | undefined;
  readonly membershipKeys?: ReadonlySet<string> | undefined;
  readonly exactMembershipIndex?: BrunoTableSetValueIndex | undefined;
  readonly normalizedSubstringOperand?: string | undefined;
}>;

export type BrunoTableFilterComplexity = Readonly<{
  readonly inputEntries: number;
  readonly nodes: number;
  readonly operands: number;
  readonly textLength: number;
}>;

type BrunoTableClientFilterExpression = Readonly<{
  readonly filter: Readonly<Record<string, unknown>>;
  readonly columnId: string;
  /** Bounded active-filter label compiled during admission, never rediscovered in the UI. */
  readonly activeFilterLabel: string;
  readonly signature?: string;
  readonly compiledOperandNodes: readonly object[];
  readonly filterNodes: readonly object[];
  readonly hasSharedNodes: boolean;
  readonly complexity: BrunoTableFilterComplexity;
}>;

type AdmittedFilterFragment = BrunoTableClientFilterExpression;

/**
 * The sole admitted Grid Filter representation used by the Client runtime. Raw filter snapshots
 * remain available at the Adapter seam, while commands and render projections use the retained
 * one expression per Column Identity and semantic evidence compiled during one bounded admission
 * pass.
 */
export type BrunoTableClientFilterCollection = Readonly<{
  readonly filters: readonly unknown[];
  readonly columnsById: ReadonlyMap<string, CompiledColumn>;
  readonly columnLabelsById: ReadonlyMap<string, string>;
  readonly expressions: readonly BrunoTableClientFilterExpression[];
  readonly expressionsByColumn: ReadonlyMap<string, BrunoTableClientFilterExpression>;
  readonly filtersByColumn: ReadonlyMap<string, unknown>;
  readonly activeFilterLabelsByColumn: ReadonlyMap<string, string>;
  readonly complexityByColumn: ReadonlyMap<string, BrunoTableFilterComplexity>;
  readonly columnIds: ReadonlySet<string>;
  readonly complexity: BrunoTableFilterComplexity;
  readonly compiledOperands: ReadonlyMap<object, CompiledFilterOperandPlan>;
  readonly hasSharedNodes: boolean;
}>;

export type BrunoTableFilterComparisonBudget = {
  comparisons: number;
  exhausted: boolean;
};

export function reconcileBrunoTableOrderBy(
  orderBy: unknown,
  baseline: BrunoTableOrderBy,
  columns: readonly CompiledColumn[],
): BrunoTableOrderBy {
  return reconcileClientOrderBy(orderBy, baseline, columns);
}

export function sanitizeBrunoTableOrderBy(
  orderBy: unknown,
  columns: readonly CompiledColumn[],
): BrunoTableOrderBy {
  return sanitizeClientOrderBy(orderBy, columns);
}

export function sanitizeBrunoTableFilters(
  filters: readonly unknown[] | undefined,
  columns: readonly CompiledColumn[],
): readonly unknown[] {
  return compileClientFilterCollection(filters, columns).filters;
}

/**
 * Legacy raw-input inspection kept for compatibility with low-level tests. Runtime commands use
 * BrunoTableClientFilterCollection.columnIds and never rediscover these identities.
 */
export function brunoTableFilterReferencesColumn(candidate: unknown, columnId: string): boolean {
  return filterReferencesColumn(candidate, columnId);
}

export function sanitizeClientInitialOrderBy(
  orderBy: ClientOrderBy | undefined,
  columns: readonly CompiledColumn[],
): ClientOrderBy {
  const sanitized = sanitizeClientOrderBy(orderBy, columns);
  if (sanitized.length === 0) {
    throw new TypeError(
      orderBy === undefined || isReadableEmptyArray(orderBy)
        ? "BrunoTable initialOrderBy is required."
        : hasSortableColumns(columns)
          ? "BrunoTable initialOrderBy contains no valid sortable column."
          : "BrunoTableClient requires at least one sortable column.",
    );
  }
  return sanitized;
}

export function reconcileClientOrderBy(
  orderBy: unknown,
  baseline: ClientOrderBy,
  columns: readonly CompiledColumn[],
): ClientOrderBy {
  const current = sanitizeClientOrderBy(orderBy, columns);
  if (current.length > 0 || !hasSortableColumns(columns)) return current;
  const initial = sanitizeClientOrderBy(baseline, columns);
  if (initial.length > 0) return initial;
  const firstSortable = columns.find((column) => column.enableSorting !== false);
  return firstSortable === undefined
    ? EMPTY_ORDER_BY
    : Object.freeze([
        Object.freeze({ columnId: firstSortable.columnId, direction: "asc" as const }),
      ]);
}

export function sanitizeClientOrderBy(
  orderBy: unknown,
  columns: readonly CompiledColumn[],
): ClientOrderBy {
  const candidates = snapshotInputEntries(orderBy);
  if (candidates === undefined || candidates === FILTER_ENTRIES_OVER_BUDGET) {
    return EMPTY_ORDER_BY;
  }
  const sortable = new Set<string>(
    columns.filter((column) => column.enableSorting !== false).map((column) => column.columnId),
  );
  const seen = new Set<string>();
  const sanitized: { readonly columnId: string; readonly direction: "asc" | "desc" }[] = [];
  for (const candidate of candidates) {
    try {
      const sort = captureBrunoTablePlainRecord(candidate, ["columnId", "direction"]);
      if (sort === undefined) continue;
      const direction = sort["direction"];
      const columnId = sort["columnId"];
      if (direction !== "asc" && direction !== "desc") continue;
      if (typeof columnId !== "string" || !sortable.has(columnId) || seen.has(columnId)) continue;
      seen.add(columnId);
      sanitized.push(Object.freeze({ columnId, direction }));
    } catch {
      // Ignore only this unreadable external entry so valid siblings remain usable.
    }
  }
  return Object.freeze(sanitized);
}

export function sanitizeClientInitialFilters(
  filters: readonly unknown[] | undefined,
  columns: readonly CompiledColumn[],
  options?: Readonly<{ readonly rejectOverBudget?: boolean }>,
): readonly unknown[] {
  return compileClientFilterCollection(filters, columns, options).filters;
}

/**
 * Admits the complete filter collection through one bounded pass. The returned collection is the
 * only representation the Client query/runtime path should use after this boundary. Duplicate
 * same-column public entries are canonicalized, in input order, to one AND expression. Invalid
 * restoration/command candidates are dropped by default; initial configuration can request a hard
 * failure for an over-budget candidate.
 */
export function compileClientFilterCollection(
  filters: readonly unknown[] | undefined,
  columns: readonly CompiledColumn[],
  options?: Readonly<{
    readonly rejectOverBudget?: boolean;
    readonly comparisonBudget?: BrunoTableFilterComparisonBudget;
  }>,
): BrunoTableClientFilterCollection {
  const candidates = snapshotInputEntries(filters);
  if (candidates === FILTER_ENTRIES_OVER_BUDGET) {
    if (options?.rejectOverBudget === true) {
      throw new TypeError(
        `BrunoTable initialFilters contains more than ${BRUNO_TABLE_CLIENT_FILTER_MAX_INPUT_ENTRIES} entries.`,
      );
    }
    return createEmptyClientFilterCollection(columns);
  }
  if (candidates === undefined) return createEmptyClientFilterCollection(columns);
  const columnsById = new Map(columns.map((column) => [column.columnId, column]));
  const columnLabelsById = createClientFilterColumnLabels(columns);
  const captured = new WeakMap<object, Readonly<Record<string, unknown>> | undefined>();
  const capturedArrays = new WeakMap<object, CapturedFilterArray | undefined>();
  const context = createFilterSanitizationContext({
    initial: { comparisons: options?.comparisonBudget?.comparisons ?? 0 },
    captured,
    capturedArrays,
    columnLabelsById,
    descriptionMemo: new Map(),
    comparisonBudgetExhausted: options?.comparisonBudget?.exhausted ?? false,
  });
  const fragments: AdmittedFilterFragment[] = [];
  const acceptedSanitizedEvidence = new WeakMap<object, AcceptedSanitizedFilterEvidence>();
  for (const filter of candidates) {
    // Each public entry is a transaction over the one collection-wide ledger. Its weak traversal
    // caches and operand map are discarded with an invalid candidate, so a hostile rejected entry
    // cannot retain compiled evidence or poison a later valid entry through a cached failure.
    const previous = {
      nodes: context.nodes,
      operands: context.operands,
      textLength: context.textLength,
    };
    const candidateContext = createFilterSanitizationContext({
      initial: { ...previous, comparisons: context.comparisons },
      captured,
      capturedArrays,
      acceptedSanitizedEvidence,
      compiledOperandLookup: context.compiledOperands,
      columnLabelsById,
      descriptionMemo: context.descriptionMemo,
      pendingDescriptionMemo: new Map(),
      comparisonBudgetExhausted: context.comparisonBudgetExhausted,
    });
    const next = sanitizeFilter(filter, columnsById, candidateContext, 0);
    // Retained node, operand, and text cost commits only with an accepted entry. Custom semantic
    // comparisons are admission work and remain monotonic across the complete transaction.
    context.comparisons = candidateContext.comparisons;
    context.comparisonBudgetExhausted ||= candidateContext.comparisonBudgetExhausted;
    syncFilterComparisonBudget(context, options?.comparisonBudget);
    if (candidateContext.overBudget && options?.rejectOverBudget === true) {
      throwClientFilterAdmissionBudgetError();
    }
    if (next === undefined || candidateContext.overBudget) {
      continue;
    }
    const fragment = retainClientFilterFragment(next, columnsById, candidateContext, previous);
    context.comparisons = candidateContext.comparisons;
    context.comparisonBudgetExhausted ||= candidateContext.comparisonBudgetExhausted;
    syncFilterComparisonBudget(context, options?.comparisonBudget);
    if (candidateContext.overBudget && options?.rejectOverBudget === true) {
      throwClientFilterAdmissionBudgetError();
    }
    if (fragment === undefined || candidateContext.overBudget) continue;
    context.nodes = candidateContext.nodes;
    context.operands = candidateContext.operands;
    context.textLength = candidateContext.textLength;
    mergeClientFilterDescriptionMemo(
      context.descriptionMemo,
      candidateContext.pendingDescriptionMemo,
    );
    context.hasSharedNodes ||= candidateContext.hasSharedNodes;
    for (const [node, plan] of candidateContext.compiledOperands) {
      context.compiledOperands.set(node, plan);
    }
    for (const [rawNode, evidence] of candidateContext.pendingSanitizedEvidence) {
      acceptedSanitizedEvidence.set(rawNode, evidence);
    }
    fragments.push(fragment);
  }
  const expressions = canonicalizeClientFilterFragments(fragments, context);
  syncFilterComparisonBudget(context, options?.comparisonBudget);
  if (context.overBudget) {
    if (options?.rejectOverBudget === true) throwClientFilterAdmissionBudgetError();
    return createEmptyClientFilterCollection(columns);
  }
  return createClientFilterCollection(columnsById, expressions, context, filters);
}

function syncFilterComparisonBudget(
  context: Readonly<FilterSanitizationContext>,
  budget: BrunoTableFilterComparisonBudget | undefined,
): void {
  if (budget === undefined) return;
  budget.comparisons = context.comparisons;
  budget.exhausted ||= context.comparisonBudgetExhausted;
}

function createEmptyClientFilterCollection(
  columns: readonly CompiledColumn[],
): BrunoTableClientFilterCollection {
  const context = createFilterSanitizationContext({
    columnLabelsById: createClientFilterColumnLabels(columns),
  });
  return createClientFilterCollection(
    new Map(columns.map((column) => [column.columnId, column])),
    [],
    context,
  );
}

function createClientFilterColumnLabels(
  columns: readonly CompiledColumn[],
): ReadonlyMap<string, string> {
  const headerCounts = new Map<string, number>();
  for (const column of columns) {
    headerCounts.set(column.headerName, (headerCounts.get(column.headerName) ?? 0) + 1);
  }
  const labels = new Map<string, string>();
  for (const [columnIndex, column] of columns.entries()) {
    labels.set(
      column.columnId,
      headerCounts.get(column.headerName) === 1
        ? column.headerName
        : `${column.headerName} (column ${String(columnIndex + 1)})`,
    );
  }
  return labels;
}

function retainClientFilterFragment(
  next: SanitizedFilterNode,
  columnsById: ReadonlyMap<string, CompiledColumn>,
  context: FilterSanitizationContext,
  previous: Readonly<Pick<BrunoTableFilterComplexity, "nodes" | "operands" | "textLength">>,
): AdmittedFilterFragment | undefined {
  const columnId = next.columnIds.values().next().value;
  if (typeof columnId !== "string") return undefined;
  const column = columnsById.get(columnId);
  if (column === undefined) return undefined;
  const activeFilterLabel = compileClientFilterDescription(
    column,
    next.filter,
    context.columnLabelsById.get(columnId) ?? column.headerName,
    context,
  );
  if (activeFilterLabel === undefined) return undefined;
  if (!reserveFilterText(activeFilterLabel.length, context)) return undefined;
  return {
    filter: next.filter,
    columnId,
    activeFilterLabel,
    ...(next.signature === undefined ? {} : { signature: next.signature }),
    compiledOperandNodes: Object.freeze([...context.compiledOperands.keys()]),
    filterNodes: Object.freeze(context.filterNodes),
    hasSharedNodes: context.hasSharedNodes,
    complexity: {
      inputEntries: 1,
      nodes: context.nodes - previous.nodes,
      operands: context.operands - previous.operands,
      textLength: context.textLength - previous.textLength,
    },
  };
}

function canonicalizeClientFilterFragments(
  fragments: readonly AdmittedFilterFragment[],
  context: FilterSanitizationContext,
): readonly BrunoTableClientFilterExpression[] {
  const grouped = new Map<string, AdmittedFilterFragment[]>();
  for (const fragment of fragments) {
    const group = grouped.get(fragment.columnId);
    if (group === undefined) grouped.set(fragment.columnId, [fragment]);
    else group.push(fragment);
  }
  const expressions: BrunoTableClientFilterExpression[] = [];
  for (const [columnId, group] of grouped) {
    if (group.length === 1) {
      expressions.push(group[0]!);
      continue;
    }
    const textLengthBeforeWrapper = context.textLength;
    if (!reserveFilterNodes(1, context)) continue;
    const conditions = Object.freeze(group.map((fragment) => fragment.filter));
    const filter = Object.freeze({ type: "AND", conditions });
    SANITIZED_FILTER_SNAPSHOTS.add(filter);
    const signatureParts = group.map((fragment) => fragment.signature);
    const signature = signatureParts.every((part): part is string => part !== undefined)
      ? createFilterSignature(["AND", ...signatureParts], context)
      : undefined;
    const activeFilterLabel = truncateClientFilterDescription(
      group.map((fragment) => fragment.activeFilterLabel).join(" AND "),
    );
    if (!reserveFilterText(activeFilterLabel.length, context)) continue;
    const retainedFilterNodes = new Set<object>();
    let hasSharedNodes = group.some((fragment) => fragment.hasSharedNodes);
    for (const fragment of group) {
      for (const node of fragment.filterNodes) {
        if (retainedFilterNodes.has(node)) hasSharedNodes = true;
        else retainedFilterNodes.add(node);
      }
    }
    expressions.push({
      filter,
      columnId,
      activeFilterLabel,
      ...(signature === undefined ? {} : { signature }),
      compiledOperandNodes: Object.freeze(
        group.flatMap((fragment) => fragment.compiledOperandNodes),
      ),
      filterNodes: Object.freeze([...retainedFilterNodes]),
      hasSharedNodes,
      complexity: Object.freeze({
        inputEntries: 1,
        nodes: group.reduce((total, fragment) => total + fragment.complexity.nodes, 1),
        operands: group.reduce((total, fragment) => total + fragment.complexity.operands, 0),
        textLength:
          group.reduce((total, fragment) => total + fragment.complexity.textLength, 0) +
          context.textLength -
          textLengthBeforeWrapper,
      }),
    });
  }
  return expressions;
}

function createClientFilterCollection(
  columnsById: ReadonlyMap<string, CompiledColumn>,
  expressions: readonly BrunoTableClientFilterExpression[],
  context: FilterSanitizationContext,
  sourceFilters?: readonly unknown[],
): BrunoTableClientFilterCollection {
  const frozenExpressions = Object.freeze(
    expressions.map((expression) =>
      Object.isFrozen(expression)
        ? expression
        : Object.freeze({
            ...expression,
            complexity: Object.freeze({ ...expression.complexity }),
          }),
    ),
  );
  const expressionFilters = frozenExpressions.map((expression) => expression.filter);
  const compiledOperands = new Map<object, CompiledFilterOperandPlan>();
  for (const expression of frozenExpressions) {
    for (const node of expression.compiledOperandNodes) {
      const plan = context.compiledOperands.get(node) ?? context.compiledOperandLookup.get(node);
      if (plan !== undefined) compiledOperands.set(node, plan);
    }
  }
  const filters = snapshotSanitizedFilterArray(sourceFilters, expressionFilters);
  const expressionsByColumn = new Map<string, BrunoTableClientFilterExpression>();
  const filtersByColumn = new Map<string, unknown>();
  const activeFilterLabelsByColumn = new Map<string, string>();
  const complexityByColumn = new Map<string, BrunoTableFilterComplexity>();
  const columnIds = new Set<string>();
  for (const expression of frozenExpressions) {
    columnIds.add(expression.columnId);
    expressionsByColumn.set(expression.columnId, expression);
    filtersByColumn.set(expression.columnId, expression.filter);
    activeFilterLabelsByColumn.set(expression.columnId, expression.activeFilterLabel);
    complexityByColumn.set(expression.columnId, expression.complexity);
  }
  const complexity = frozenExpressions.reduce(
    (total, expression) => addFilterComplexity(total, expression.complexity),
    createEmptyFilterComplexity(),
  );
  return Object.freeze({
    filters,
    columnsById,
    columnLabelsById: context.columnLabelsById,
    expressions: frozenExpressions,
    expressionsByColumn,
    filtersByColumn,
    activeFilterLabelsByColumn,
    complexityByColumn,
    columnIds,
    complexity: Object.freeze(complexity),
    compiledOperands,
    hasSharedNodes: frozenExpressions.some((expression) => expression.hasSharedNodes),
  });
}

/** Removes one column's admitted expression without reopening or rescanning another column. */
export function removeClientFilterColumn(
  collection: BrunoTableClientFilterCollection,
  columnId: string,
): BrunoTableClientFilterCollection {
  const expressions = collection.expressions.filter(
    (expression) => expression.columnId !== columnId,
  );
  if (expressions.length === collection.expressions.length) return collection;
  return (
    createDerivedClientFilterCollection(
      collection,
      expressions,
      undefined,
      subtractFilterComplexity(collection.complexity, collection.complexityByColumn.get(columnId)),
    ) ?? collection
  );
}

/** Restores one column from the already-admitted sanitized baseline collection. */
export function restoreClientFilterColumn(
  collection: BrunoTableClientFilterCollection,
  baseline: BrunoTableClientFilterCollection,
  columnId: string,
): BrunoTableClientFilterCollection | undefined {
  if (sameBrunoTableFilterColumn(collection, baseline, columnId)) return collection;
  const expressions = [
    ...collection.expressions.filter((expression) => expression.columnId !== columnId),
    ...baseline.expressions.filter((expression) => expression.columnId === columnId),
  ];
  return createDerivedClientFilterCollection(
    collection,
    expressions,
    baseline,
    addFilterComplexity(
      subtractFilterComplexity(collection.complexity, collection.complexityByColumn.get(columnId)),
      baseline.complexityByColumn.get(columnId),
    ),
  );
}

/**
 * Admits one complete replacement expression for a column. Existing expressions retain their
 * compiled evidence; only the replacement crosses the sanitizer/compiler boundary.
 */
export function replaceClientFilterColumn(
  collection: BrunoTableClientFilterCollection,
  columnId: string,
  candidate: unknown,
): BrunoTableClientFilterCollection | undefined {
  const candidateEntries =
    candidate === undefined ? [] : Array.isArray(candidate) ? candidate : [candidate];
  const candidates = snapshotInputEntries(candidateEntries);
  if (candidates === undefined || candidates === FILTER_ENTRIES_OVER_BUDGET) return undefined;
  const retainedExpressions = collection.expressions.filter(
    (expression) => expression.columnId !== columnId,
  );
  const retainedComplexity = subtractFilterComplexity(
    collection.complexity,
    collection.complexityByColumn.get(columnId),
  );
  if (candidates.length === 0) {
    return createDerivedClientFilterCollection(
      collection,
      retainedExpressions,
      undefined,
      retainedComplexity,
    );
  }
  const candidateCollection = compileClientFilterCollection(candidates, [
    ...collection.columnsById.values(),
  ]);
  const candidateExpression = candidateCollection.expressions[0];
  if (
    candidateCollection.expressions.length !== 1 ||
    candidateExpression === undefined ||
    candidateExpression.columnId !== columnId
  ) {
    return undefined;
  }
  return createDerivedClientFilterCollection(
    collection,
    [...retainedExpressions, candidateExpression],
    candidateCollection,
    addFilterComplexity(retainedComplexity, candidateExpression.complexity),
  );
}

function createDerivedClientFilterCollection(
  collection: BrunoTableClientFilterCollection,
  expressions: readonly BrunoTableClientFilterExpression[],
  additional: BrunoTableClientFilterCollection | undefined,
  complexity: BrunoTableFilterComplexity,
): BrunoTableClientFilterCollection | undefined {
  if (!isClientFilterComplexityWithinBudget(complexity)) return undefined;
  const compiledOperands = collectCompiledOperandPlans(
    expressions,
    additional === undefined || additional === collection
      ? [collection.compiledOperands]
      : [collection.compiledOperands, additional.compiledOperands],
  );
  const context = createFilterSanitizationContext({
    initial: complexity,
    compiledOperands,
    columnLabelsById: collection.columnLabelsById,
  });
  return createClientFilterCollection(collection.columnsById, expressions, context, undefined);
}

function collectCompiledOperandPlans(
  expressions: readonly BrunoTableClientFilterExpression[],
  sources: readonly ReadonlyMap<object, CompiledFilterOperandPlan>[],
): Map<object, CompiledFilterOperandPlan> {
  const compiledOperands = new Map<object, CompiledFilterOperandPlan>();
  for (const expression of expressions) {
    for (const node of expression.compiledOperandNodes) {
      for (const source of sources) {
        const plan = source.get(node);
        if (plan !== undefined) {
          compiledOperands.set(node, plan);
          break;
        }
      }
    }
  }
  return compiledOperands;
}

function addFilterComplexity(
  left: BrunoTableFilterComplexity | undefined,
  right: BrunoTableFilterComplexity | undefined,
): BrunoTableFilterComplexity {
  return {
    inputEntries: (left?.inputEntries ?? 0) + (right?.inputEntries ?? 0),
    nodes: (left?.nodes ?? 0) + (right?.nodes ?? 0),
    operands: (left?.operands ?? 0) + (right?.operands ?? 0),
    textLength: (left?.textLength ?? 0) + (right?.textLength ?? 0),
  };
}

function createEmptyFilterComplexity(): BrunoTableFilterComplexity {
  return { inputEntries: 0, nodes: 0, operands: 0, textLength: 0 };
}

function subtractFilterComplexity(
  total: BrunoTableFilterComplexity,
  removed: BrunoTableFilterComplexity | undefined,
): BrunoTableFilterComplexity {
  return {
    inputEntries: Math.max(0, total.inputEntries - (removed?.inputEntries ?? 0)),
    nodes: Math.max(0, total.nodes - (removed?.nodes ?? 0)),
    operands: Math.max(0, total.operands - (removed?.operands ?? 0)),
    textLength: Math.max(0, total.textLength - (removed?.textLength ?? 0)),
  };
}

function isClientFilterComplexityWithinBudget(complexity: BrunoTableFilterComplexity): boolean {
  return (
    complexity.inputEntries <= BRUNO_TABLE_CLIENT_FILTER_MAX_INPUT_ENTRIES &&
    complexity.nodes <= BRUNO_TABLE_CLIENT_FILTER_MAX_TOTAL_NODES &&
    complexity.operands <= BRUNO_TABLE_CLIENT_FILTER_MAX_TOTAL_OPERANDS &&
    complexity.textLength <= BRUNO_TABLE_CLIENT_FILTER_MAX_TOTAL_TEXT_LENGTH
  );
}

function throwClientFilterAdmissionBudgetError(): never {
  throw new TypeError(
    `BrunoTable initialFilters may contain at most ${BRUNO_TABLE_CLIENT_FILTER_MAX_TOTAL_NODES} nodes, ${BRUNO_TABLE_CLIENT_FILTER_MAX_TOTAL_OPERANDS} operands, ${BRUNO_TABLE_CLIENT_FILTER_MAX_TOTAL_TEXT_LENGTH} UTF-16 text units, ${BRUNO_TABLE_CLIENT_FILTER_MAX_TOTAL_COMPARISONS} semantic comparisons, and nesting depth ${BRUNO_TABLE_CLIENT_FILTER_MAX_DEPTH}.`,
  );
}

export function filterClientRows<TRow>(
  rows: readonly TRow[],
  columns: readonly CompiledColumn[],
  filters: readonly unknown[] | undefined,
): readonly TRow[] {
  const predicate = createClientFilterPredicate(columns, filters);
  return predicate === undefined ? rows : rows.filter(predicate);
}

export type ClientFilterPlan = BrunoTableClientFilterCollection;

/**
 * Compiles immutable filter evidence once for the query consumers that use different row
 * adapters. The plan deliberately contains no row reader, so it can be shared by TanStack's
 * row model and the source row-order detector without crossing either adapter seam.
 */
export function compileClientFilterPlan(
  columns: readonly CompiledColumn[],
  filters: readonly unknown[] | undefined,
  collection?: BrunoTableClientFilterCollection,
): ClientFilterPlan | undefined {
  const plan = collection ?? compileClientFilterCollection(filters, columns);
  return plan.expressions.length === 0 ? undefined : plan;
}

export function createClientFilterPredicate<TRow>(
  columns: readonly CompiledColumn[],
  filters: readonly unknown[] | undefined,
  readValue: (column: CompiledColumn, row: TRow) => unknown = readCompiledColumnValue,
  filterPlan?: ClientFilterPlan,
): ((row: TRow) => boolean) | undefined {
  const plan = filterPlan ?? compileClientFilterPlan(columns, filters);
  if (plan === undefined) return undefined;
  const columnsById = plan.columnsById;
  const readUnknown = (column: CompiledColumn, row: unknown) => readValue(column, row as TRow);
  return (row) => {
    const completed = plan.hasSharedNodes ? new WeakMap<object, boolean>() : undefined;
    return plan.expressions.every((expression) =>
      evaluateFilter(
        expression.filter,
        row,
        columnsById,
        readUnknown,
        plan.compiledOperands,
        completed,
      ),
    );
  };
}

export function normalizeBrunoTableFilterText(
  value: string,
  caseSensitive = false,
  accentSensitive = false,
): string {
  const normalized = value.normalize("NFD");
  const comparable = accentSensitive ? normalized : normalized.replace(/\p{Mark}/gu, "");
  return caseSensitive ? comparable : comparable.toLowerCase();
}

/** UI draft bound only; admitted filters use the collection-wide text ledger below. */
export const BRUNO_TABLE_MAX_FILTER_OPERAND_LENGTH = 1_024;
const BRUNO_TABLE_MAX_FILTER_OPERAND_OBJECTS = 64;
const BRUNO_TABLE_MAX_FILTER_OPERAND_PROPERTIES = 256;
const BRUNO_TABLE_MAX_FILTER_OPERAND_DEPTH = 16;

export function boundBrunoTableFilterOperandText(text: string): string {
  return text.length <= BRUNO_TABLE_MAX_FILTER_OPERAND_LENGTH
    ? text
    : text.slice(0, BRUNO_TABLE_MAX_FILTER_OPERAND_LENGTH);
}

export function filterReferencesColumn(candidate: unknown, columnId: string): boolean {
  const columnIds = new Set<string>();
  collectClientFilterColumnIds(candidate, columnIds);
  return columnIds.has(columnId);
}

export function collectClientFilterColumnIds(candidate: unknown, target: Set<string>): void {
  collectFilterColumnIds(candidate, target, new WeakSet<object>());
}

function collectFilterColumnIds(
  candidate: unknown,
  target: Set<string>,
  visited: WeakSet<object>,
): void {
  if (typeof candidate !== "object" || candidate === null || visited.has(candidate)) return;
  visited.add(candidate);
  const filter = asRecord(candidate);
  if (typeof filter["columnId"] === "string") target.add(filter["columnId"]);
  if (Array.isArray(filter["conditions"])) {
    for (const condition of filter["conditions"])
      collectFilterColumnIds(condition, target, visited);
  }
  if (filter["condition"] !== undefined) {
    collectFilterColumnIds(filter["condition"], target, visited);
  }
}

function sanitizeFilter(
  candidate: unknown,
  columnsById: ReadonlyMap<string, CompiledColumn>,
  context: FilterSanitizationContext,
  depth: number,
  precharged = false,
): SanitizedFilterNode | undefined {
  if (depth > BRUNO_TABLE_CLIENT_FILTER_MAX_DEPTH) {
    context.overBudget = true;
    return undefined;
  }
  if (typeof candidate !== "object" || candidate === null || context.visited.has(candidate)) {
    return undefined;
  }
  if (context.admittedNodes.has(candidate)) context.hasSharedNodes = true;
  else context.admittedNodes.add(candidate);
  if (!precharged) {
    if (!reserveFilterNodes(1, context)) {
      context.overBudget = true;
      return undefined;
    }
  }
  const accepted = context.acceptedSanitizedEvidence.get(candidate);
  if (accepted !== undefined) {
    if (depth + accepted.height > BRUNO_TABLE_CLIENT_FILTER_MAX_DEPTH) {
      context.overBudget = true;
      return undefined;
    }
    return replayAcceptedSanitizedFilter(candidate, depth, accepted, context);
  }
  const completedAtDepth = context.completed.get(candidate);
  if (completedAtDepth?.has(depth) === true) return completedAtDepth.get(depth);
  const subtreeStart = {
    filterNodeIndex: context.filterNodes.length,
    nodes: context.nodes,
    operands: context.operands,
    textLength: context.textLength,
  };
  context.visited.add(candidate);
  let captured: Readonly<Record<string, unknown>> | undefined;
  try {
    captured = context.captured.get(candidate);
    if (!context.captured.has(candidate)) {
      captured = captureFilterRecord(asRecord(candidate));
      context.captured.set(candidate, captured);
    }
  } catch {
    context.captured.set(candidate, undefined);
    context.visited.delete(candidate);
    return memoizeSanitizedFilter(candidate, depth, undefined, context, completedAtDepth);
  }
  let sanitized: SanitizedFilterNode | undefined;
  try {
    sanitized =
      captured === undefined
        ? undefined
        : sanitizeFilterRecord(captured, columnsById, context, depth);
  } finally {
    context.visited.delete(candidate);
  }
  const retained = memoizeSanitizedFilter(candidate, depth, sanitized, context, completedAtDepth);
  if (retained !== undefined) {
    const filterNodes = context.filterNodes.slice(subtreeStart.filterNodeIndex);
    context.pendingSanitizedEvidence.push([
      candidate,
      {
        node: retained,
        height: retained.height,
        descendantNodes: context.nodes - subtreeStart.nodes,
        operands: context.operands - subtreeStart.operands,
        textLength: context.textLength - subtreeStart.textLength,
        filterNodes,
        compiledOperands: filterNodes.flatMap((filterNode) => {
          const plan = context.compiledOperands.get(filterNode);
          return plan === undefined ? [] : ([[filterNode, plan]] as const);
        }),
      },
    ]);
  }
  return retained;
}

function replayAcceptedSanitizedFilter(
  candidate: object,
  depth: number,
  evidence: AcceptedSanitizedFilterEvidence,
  context: FilterSanitizationContext,
): SanitizedFilterNode | undefined {
  if (
    !reserveFilterNodes(evidence.descendantNodes, context) ||
    !reserveFilterOperands(evidence.operands, context) ||
    !reserveFilterText(evidence.textLength, context)
  ) {
    return undefined;
  }
  context.hasSharedNodes = true;
  for (const filterNode of evidence.filterNodes) {
    if (!context.retainedFilterNodes.has(filterNode)) {
      context.retainedFilterNodes.add(filterNode);
      context.filterNodes.push(filterNode);
    }
  }
  for (const [filterNode, plan] of evidence.compiledOperands) {
    context.compiledOperands.set(filterNode, plan);
  }
  const completedAtDepth = context.completed.get(candidate);
  const memo = completedAtDepth ?? new Map<number, SanitizedFilterNode | undefined>();
  memo.set(depth, evidence.node);
  if (completedAtDepth === undefined) context.completed.set(candidate, memo);
  return evidence.node;
}

function captureFilterRecord(
  filter: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
  if (SANITIZED_FILTER_SNAPSHOTS.has(filter)) return filter;
  if (!Object.hasOwn(filter, "type")) return undefined;
  const type = filter["type"];
  const keys = filterCaptureKeys(type);
  if (keys === undefined) return undefined;
  const captured: Record<string, unknown> = { type };
  for (const key of keys) {
    if (!Object.hasOwn(filter, key)) continue;
    captured[key] = filter[key];
  }
  return Object.freeze(captured);
}

function captureDenseFilterArray(
  value: unknown,
  context: FilterSanitizationContext,
  reserveConditions: boolean,
  reserveOperands = false,
): readonly unknown[] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (SANITIZED_FILTER_SNAPSHOTS.has(value) && Array.isArray(value)) {
    if (!admitFilterArrayLength(value.length, context, reserveConditions)) return undefined;
    if (reserveOperands && !hasFilterOperandCapacity(value.length, context)) return undefined;
    if (reserveOperands && !reserveFilterOperands(value.length, context)) return undefined;
    return value;
  }
  let captured = context.capturedArrays.get(value);
  if (!context.capturedArrays.has(value)) {
    captured = captureFilterArrayLength(value);
    context.capturedArrays.set(value, captured);
  }
  if (captured === undefined) return undefined;
  if (!admitFilterArrayLength(captured.length, context, reserveConditions)) return undefined;
  if (reserveOperands && !hasFilterOperandCapacity(captured.length, context)) return undefined;
  if (!captured.attempted) {
    captured.attempted = true;
    const snapshot = snapshotDenseArray(value, captured.length);
    captured.snapshot = snapshot === undefined ? undefined : Object.freeze(snapshot);
    if (captured.snapshot !== undefined) SANITIZED_FILTER_SNAPSHOTS.add(captured.snapshot);
  }
  if (captured.snapshot === undefined) return undefined;
  if (reserveOperands && !reserveFilterOperands(captured.length, context)) return undefined;
  return captured.snapshot;
}

function admitFilterArrayLength(
  length: number,
  context: FilterSanitizationContext,
  reserveConditions: boolean,
): boolean {
  if (reserveConditions) return reserveConditionEntries(length, context);
  return true;
}

function captureFilterArrayLength(value: object): CapturedFilterArray | undefined {
  try {
    if (!Array.isArray(value)) return undefined;
    const length = value.length;
    return Number.isSafeInteger(length) && length >= 0
      ? { attempted: false, length, snapshot: undefined }
      : undefined;
  } catch {
    return undefined;
  }
}

function reserveConditionEntries(length: number, context: FilterSanitizationContext): boolean {
  return reserveFilterNodes(length, context);
}

function reserveFilterNodes(length: number, context: FilterSanitizationContext): boolean {
  if (length < 0 || context.nodes > BRUNO_TABLE_CLIENT_FILTER_MAX_TOTAL_NODES - length) {
    context.overBudget = true;
    return false;
  }
  context.nodes += length;
  return true;
}

function reserveFilterOperands(length: number, context: FilterSanitizationContext): boolean {
  if (!hasFilterOperandCapacity(length, context)) return false;
  context.operands += length;
  return true;
}

function hasFilterOperandCapacity(length: number, context: FilterSanitizationContext): boolean {
  if (length < 0 || context.operands > BRUNO_TABLE_CLIENT_FILTER_MAX_TOTAL_OPERANDS - length) {
    context.overBudget = true;
    return false;
  }
  return true;
}

function reserveFilterText(length: number, context: FilterSanitizationContext): boolean {
  if (length < 0 || context.textLength > BRUNO_TABLE_CLIENT_FILTER_MAX_TOTAL_TEXT_LENGTH - length) {
    context.overBudget = true;
    return false;
  }
  context.textLength += length;
  return true;
}

function reserveFilterComparison(context: FilterSanitizationContext): boolean {
  if (
    context.comparisonBudgetExhausted ||
    context.comparisons >= BRUNO_TABLE_CLIENT_FILTER_MAX_TOTAL_COMPARISONS
  ) {
    context.comparisonBudgetExhausted = true;
    context.overBudget = true;
    return false;
  }
  context.comparisons += 1;
  return true;
}

function reserveFilterNodeText(
  type: string,
  columnId: string | undefined,
  context: FilterSanitizationContext,
): boolean {
  return (
    reserveFilterText(type.length, context) &&
    (columnId === undefined || reserveFilterText(columnId.length, context))
  );
}

function memoizeSanitizedFilter(
  candidate: object,
  depth: number,
  sanitized: SanitizedFilterNode | undefined,
  context: FilterSanitizationContext,
  completedAtDepth: Map<number, SanitizedFilterNode | undefined> | undefined,
): SanitizedFilterNode | undefined {
  const memo = completedAtDepth ?? new Map<number, SanitizedFilterNode | undefined>();
  memo.set(depth, sanitized);
  if (completedAtDepth === undefined) context.completed.set(candidate, memo);
  if (sanitized !== undefined && !context.retainedFilterNodes.has(sanitized.filter)) {
    context.retainedFilterNodes.add(sanitized.filter);
    context.filterNodes.push(sanitized.filter);
  }
  return sanitized;
}

function filterCaptureKeys(type: unknown): readonly string[] | undefined {
  if (type === "AND" || type === "OR") return ["conditions"];
  if (type === "NOT") return ["condition"];
  if (type === "blank" || type === "notBlank" || type === "matchNone") return ["columnId"];
  if (type === "inRange") return ["columnId", "filter", "filterTo"];
  if (
    type === "in" ||
    type === "equals" ||
    type === "notEqual" ||
    type === "contains" ||
    type === "notContains" ||
    type === "startsWith" ||
    type === "endsWith"
  ) {
    return ["columnId", "filter", "caseSensitive", "accentSensitive"];
  }
  if (
    type === "greaterThan" ||
    type === "greaterThanOrEqual" ||
    type === "lessThan" ||
    type === "lessThanOrEqual"
  ) {
    return ["columnId", "filter"];
  }
  return undefined;
}

function sanitizeFilterRecord(
  filter: Readonly<Record<string, unknown>>,
  columnsById: ReadonlyMap<string, CompiledColumn>,
  context: FilterSanitizationContext,
  depth: number,
): SanitizedFilterNode | undefined {
  const type = filter["type"];
  if (type === "AND" || type === "OR") {
    if (!reserveFilterNodeText(type, undefined, context)) return undefined;
    const candidates = captureDenseFilterArray(filter["conditions"], context, true);
    if (candidates === undefined || candidates.length === 0) return undefined;
    const conditions: Readonly<Record<string, unknown>>[] = [];
    const conditionNodes: SanitizedFilterNode[] = [];
    const columnIds = new Set<string>();
    for (const candidate of candidates) {
      const condition = sanitizeFilter(candidate, columnsById, context, depth + 1, true);
      if (condition === undefined) return undefined;
      conditions.push(condition.filter);
      conditionNodes.push(condition);
      for (const columnId of condition.columnIds) columnIds.add(columnId);
    }
    if (columnIds.size > 1) return undefined;
    const sanitizedConditions = snapshotSanitizedFilterArray(candidates, conditions);
    const conditionSignatures = conditionNodes.map((condition) => condition.signature);
    const signature = conditionSignatures.every((value): value is string => value !== undefined)
      ? createFilterSignature([type, ...conditionSignatures.sort(compareStringValues)], context)
      : undefined;
    if (context.overBudget) return undefined;
    return {
      columnIds,
      filter: snapshotFilter(filter, ["type", "conditions"], {
        conditions: sanitizedConditions,
      }),
      height: 1 + Math.max(...conditionNodes.map((condition) => condition.height)),
      ...(signature === undefined ? {} : { signature }),
    };
  }
  if (type === "NOT") {
    if (!reserveFilterNodeText(type, undefined, context)) return undefined;
    const condition = sanitizeFilter(filter["condition"], columnsById, context, depth + 1);
    if (condition === undefined) return undefined;
    const sanitized = snapshotFilter(filter, ["type", "condition"], {
      condition: condition.filter,
    });
    const signature =
      condition.signature === undefined
        ? undefined
        : createFilterSignature(["NOT", condition.signature], context);
    if (context.overBudget) return undefined;
    return {
      columnIds: condition.columnIds,
      filter: sanitized,
      height: condition.height + 1,
      ...(signature === undefined ? {} : { signature }),
    };
  }
  const columnId = filter["columnId"];
  if (typeof columnId !== "string") return undefined;
  const column = columnsById.get(columnId);
  if (column === undefined || column.enableFilter === false || column.kind !== "field") {
    return undefined;
  }
  if (typeof type !== "string" || !reserveFilterNodeText(type, columnId, context)) {
    return undefined;
  }
  const node = (
    sanitizedFilter: Readonly<Record<string, unknown>>,
  ): SanitizedFilterNode | undefined => {
    const plan = compileFilterOperandPlan(column, sanitizedFilter, context);
    if (
      plan === undefined &&
      (type === "contains" ||
        type === "notContains" ||
        type === "startsWith" ||
        type === "endsWith" ||
        (type === "in" && column.semantics.filterFamily === "text"))
    ) {
      return undefined;
    }
    if (plan !== undefined) context.compiledOperands.set(sanitizedFilter, plan);
    const signature = createLeafFilterSignature(column, sanitizedFilter, plan, context);
    if (context.overBudget) return undefined;
    return {
      columnIds: new Set([columnId]),
      filter: sanitizedFilter,
      height: 0,
      ...(signature === undefined ? {} : { signature }),
    };
  };
  const operand = filter["filter"];
  const decode = (value: unknown) => {
    try {
      const decoded = column.semantics.decodeRuntime(value);
      if (
        decoded._tag === "Success" &&
        !Object.is(decoded.value, value) &&
        !isBoundedFilterOperand(decoded.value, context)
      ) {
        return { _tag: "Failure" as const, message: "Decoded value is not safely readable." };
      }
      return decoded;
    } catch {
      return { _tag: "Failure" as const, message: "Value decoding failed." };
    }
  };
  if (type === "matchNone") {
    return column.enableSetFilter ? node(snapshotFilter(filter, ["columnId", "type"])) : undefined;
  }
  if (type === "blank" || type === "notBlank") {
    return node(snapshotFilter(filter, ["columnId", "type"]));
  }
  if (type === "in") {
    if (
      column.semantics.filterFamily !== "text" &&
      column.semantics.filterFamily !== "numeric" &&
      column.semantics.filterFamily !== "boolean" &&
      column.semantics.filterFamily !== "select" &&
      !(column.semantics.filterFamily === "equality" && column.enableSetFilter)
    ) {
      return undefined;
    }
    const captured = captureDenseFilterArray(operand, context, false, true);
    if (
      captured === undefined ||
      captured.length === 0 ||
      !hasValidTextSensitivity(filter, column.semantics.filterFamily === "text")
    ) {
      return undefined;
    }
    if (!captured.every((value) => isBoundedFilterOperand(value, context))) return undefined;
    const decoded = captured.map(decode);
    const decodedValues = decoded.map((result) =>
      result._tag === "Success" ? result.value : undefined,
    );
    const sanitizedValues = snapshotSanitizedFilterArray(operand, decodedValues);
    return decoded.every((result) => result._tag === "Success")
      ? node(
          snapshotFilter(
            filter,
            ["columnId", "type", "filter", "caseSensitive", "accentSensitive"],
            { filter: sanitizedValues },
          ),
        )
      : undefined;
  }
  if (type === "inRange") {
    if (column.semantics.filterFamily !== "numeric") return undefined;
    if (
      !isBoundedFilterOperand(operand, context) ||
      !isBoundedFilterOperand(filter["filterTo"], context) ||
      !reserveFilterOperands(2, context)
    ) {
      return undefined;
    }
    const from = decode(operand);
    const to = decode(filter["filterTo"]);
    if (from._tag !== "Success" || to._tag !== "Success") return undefined;
    try {
      if (column.semantics.compare(from.value, to.value) >= 0) return undefined;
    } catch {
      return undefined;
    }
    return node(
      snapshotFilter(filter, ["columnId", "type", "filter", "filterTo"], {
        filter: from.value,
        filterTo: to.value,
      }),
    );
  }
  if (
    type === "equals" ||
    type === "notEqual" ||
    type === "greaterThan" ||
    type === "greaterThanOrEqual" ||
    type === "lessThan" ||
    type === "lessThanOrEqual"
  ) {
    if (
      (type === "greaterThan" ||
        type === "greaterThanOrEqual" ||
        type === "lessThan" ||
        type === "lessThanOrEqual") &&
      column.semantics.filterFamily !== "numeric"
    ) {
      return undefined;
    }
    let configuredSelectValue: unknown;
    let isConfiguredSelectValue = false;
    if (column.semantics.filterFamily === "select" && column.selectOptions !== undefined) {
      const configured = resolveConfiguredSelectValue(column, operand, context);
      if (configured === undefined) return undefined;
      configuredSelectValue = configured;
      isConfiguredSelectValue = true;
    }
    if (!isConfiguredSelectValue && !isBoundedFilterOperand(operand, context)) return undefined;
    if (!reserveFilterOperands(1, context)) return undefined;
    // Compiled Select options are already canonical. Reuse the admitted option
    // so a long trusted option never re-enters a consumer decoder.
    const result = isConfiguredSelectValue
      ? ({ _tag: "Success", value: configuredSelectValue } as const)
      : decode(operand);
    if (result._tag !== "Success") return undefined;
    if (
      (type === "equals" || type === "notEqual") &&
      !hasValidTextSensitivity(filter, column.semantics.filterFamily === "text")
    ) {
      return undefined;
    }
    return node(
      snapshotFilter(
        filter,
        type === "equals" || type === "notEqual"
          ? ["columnId", "type", "filter", "caseSensitive", "accentSensitive"]
          : ["columnId", "type", "filter"],
        { filter: result.value },
      ),
    );
  }
  if (
    type === "contains" ||
    type === "notContains" ||
    type === "startsWith" ||
    type === "endsWith"
  ) {
    const validSensitivity = hasValidTextSensitivity(filter, true);
    const textOperand = typeof operand === "string" ? operand : undefined;
    return column.semantics.filterFamily === "text" &&
      textOperand !== undefined &&
      isBoundedFilterOperand(textOperand, context) &&
      reserveFilterOperands(1, context) &&
      validSensitivity
      ? node(
          snapshotFilter(
            filter,
            ["columnId", "type", "filter", "caseSensitive", "accentSensitive"],
            { filter: textOperand },
          ),
        )
      : undefined;
  }
  return undefined;
}

/**
 * Builds the active-filter label while a sanitized entry is admitted. The input graph has already
 * crossed the collection-wide node/operand/text boundary, and the bounded summary only retains
 * the first few visible children. Ordinary active-filter renders consume the retained string and
 * never walk this graph again.
 */
function compileClientFilterDescription(
  column: CompiledColumn,
  value: Readonly<Record<string, unknown>>,
  columnLabel: string,
  context: FilterSanitizationContext,
): string | undefined {
  const active = new WeakSet<object>();
  const describe = (candidate: unknown): string | undefined => {
    if (typeof candidate !== "object" || candidate === null) return columnLabel;
    if (context.descriptionMemo.has(candidate)) return context.descriptionMemo.get(candidate);
    if (context.pendingDescriptionMemo.has(candidate)) {
      return context.pendingDescriptionMemo.get(candidate);
    }
    if (active.has(candidate)) return "…";
    active.add(candidate);
    let description: string | undefined;
    if (Array.isArray(candidate)) {
      description = joinClientFilterDescriptions(candidate, " AND ", describe, context);
      active.delete(candidate);
      context.pendingDescriptionMemo.set(candidate, description);
      return description;
    }
    const record = candidate as Readonly<Record<string, unknown>>;
    const type = typeof record["type"] === "string" ? record["type"] : "filter";
    if ((type === "AND" || type === "OR") && Array.isArray(record["conditions"])) {
      const joiner = type === "AND" ? " AND " : " OR ";
      const conditions = joinClientFilterDescriptions(
        record["conditions"],
        joiner,
        describe,
        context,
      );
      description =
        conditions === undefined
          ? undefined
          : meterAndTruncateClientFilterDescription(`${columnLabel}: (${conditions})`, context);
    } else if (type === "NOT" && record["condition"] !== undefined) {
      const condition = describe(record["condition"]);
      description =
        condition === undefined
          ? undefined
          : meterAndTruncateClientFilterDescription(`${columnLabel}: NOT (${condition})`, context);
    } else {
      const operand = record["filter"];
      if (type === "blank" || type === "notBlank" || type === "matchNone") {
        description = meterAndTruncateClientFilterDescription(`${columnLabel}: ${type}`, context);
      } else if (type === "inRange") {
        const from = formatClientFilterOperand(column, operand, type, context);
        const to = formatClientFilterOperand(column, record["filterTo"], type, context);
        description =
          from === undefined || to === undefined
            ? undefined
            : meterAndTruncateClientFilterDescription(
                `${columnLabel}: inRange ${from} ≤ value < ${to} (upper bound exclusive)`,
                context,
              );
      } else {
        const formattedOperand = formatClientFilterOperand(column, operand, type, context);
        if (formattedOperand === undefined) {
          description = undefined;
        } else {
          const sensitivity = [
            record["caseSensitive"] === true ? "case-sensitive" : undefined,
            record["accentSensitive"] === true ? "accent-sensitive" : undefined,
          ].filter((entry): entry is string => entry !== undefined);
          const sensitivityLabel = sensitivity.length > 0 ? ` (${sensitivity.join(", ")})` : "";
          description = meterAndTruncateClientFilterDescription(
            `${columnLabel}: ${type}${sensitivityLabel} ${formattedOperand}`,
            context,
          );
        }
      }
    }
    active.delete(candidate);
    context.pendingDescriptionMemo.set(candidate, description);
    return description;
  };
  return describe(value);
}

function formatClientFilterOperand(
  column: CompiledColumn,
  value: unknown,
  operator: unknown,
  context: FilterSanitizationContext,
): string | undefined {
  if (operator === "in" && Array.isArray(value)) {
    const joined = joinClientFilterDescriptions(
      value,
      ", ",
      (item) => formatClientFilterOperand(column, item, "equals", context),
      context,
    );
    return joined === undefined
      ? undefined
      : meterClientFilterDescriptionText(`[${joined}]`, context);
  }
  if (
    operator === "contains" ||
    operator === "notContains" ||
    operator === "startsWith" ||
    operator === "endsWith"
  ) {
    return meterClientFilterDescriptionText(
      typeof value === "string" ? JSON.stringify(value) : safeClientFilterString(value),
      context,
    );
  }
  try {
    const display = column.semantics.formatDisplay(value);
    return meterClientFilterDescriptionText(
      typeof value === "string" ? JSON.stringify(display) : safeClientFilterString(display),
      context,
    );
  } catch {
    return meterClientFilterDescriptionText(safeClientFilterString(value), context);
  }
}

const CLIENT_FILTER_DESCRIPTION_ITEM_LIMIT = 8;
const CLIENT_FILTER_DESCRIPTION_LENGTH_LIMIT = 512;

function joinClientFilterDescriptions(
  values: readonly unknown[],
  separator: string,
  render: (value: unknown) => string | undefined,
  context: FilterSanitizationContext,
): string | undefined {
  const visible: string[] = [];
  for (const value of values.slice(0, CLIENT_FILTER_DESCRIPTION_ITEM_LIMIT)) {
    const rendered = render(value);
    if (rendered === undefined) return undefined;
    visible.push(rendered);
  }
  const omitted = values.length - visible.length;
  if (omitted > 0) visible.push(`… ${String(omitted)} more`);
  return meterAndTruncateClientFilterDescription(visible.join(separator), context);
}

function meterClientFilterDescriptionText(
  value: string,
  context: FilterSanitizationContext,
): string | undefined {
  return reserveFilterText(value.length, context) ? value : undefined;
}

function meterAndTruncateClientFilterDescription(
  value: string,
  context: FilterSanitizationContext,
): string | undefined {
  const metered = meterClientFilterDescriptionText(value, context);
  return metered === undefined ? undefined : truncateClientFilterDescription(metered);
}

function truncateClientFilterDescription(value: string): string {
  return value.length <= CLIENT_FILTER_DESCRIPTION_LENGTH_LIMIT
    ? value
    : `${value.slice(0, CLIENT_FILTER_DESCRIPTION_LENGTH_LIMIT - 1)}…`;
}

function safeClientFilterString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "<unavailable>";
  }
}

function resolveConfiguredSelectValue(
  column: CompiledColumn,
  operand: unknown,
  context: FilterSanitizationContext,
): unknown {
  const selectOptions = column.selectOptions;
  if (selectOptions === undefined) return undefined;
  // Even an exact compiled-option hit is still an admitted filter operand. Meter its raw shape
  // and materialized text before taking the indexed fast path so repeated long Select values
  // cannot bypass the collection-wide ledger.
  if (!isBoundedFilterOperand(operand, context)) return undefined;
  let canonical: string | undefined;
  try {
    canonical = column.semantics.formatCanonicalText(operand);
  } catch {
    canonical = undefined;
  }
  if (canonical !== undefined && !reserveFilterText(canonical.length, context)) return undefined;
  const exactOptionIndex = column.selectOptionIndexes?.get(operand);
  if (exactOptionIndex !== undefined && Object.is(selectOptions[exactOptionIndex], operand)) {
    return selectOptions[exactOptionIndex];
  }
  const canonicalOptionIndex =
    canonical === undefined ? undefined : column.selectOptionCanonicalIndexes?.get(canonical);
  let comparedCanonicalOptionIndex: number | undefined;
  if (canonicalOptionIndex !== undefined) {
    if (!reserveFilterComparison(context)) return undefined;
    comparedCanonicalOptionIndex = canonicalOptionIndex;
    try {
      if (column.semantics.equivalent(selectOptions[canonicalOptionIndex], operand)) {
        return selectOptions[canonicalOptionIndex];
      }
    } catch {
      // Continue to the bounded fallback below.
    }
  }
  // Custom equivalence cannot be indexed generically. The configured option domain is validated
  // and indexed once during column compilation; each unavoidable comparison consumes the one
  // collection-wide admission allowance. The allowance is deliberately not local to this scan.
  for (const [optionIndex, option] of selectOptions.entries()) {
    if (optionIndex === comparedCanonicalOptionIndex) continue;
    if (!reserveFilterComparison(context)) return undefined;
    try {
      if (column.semantics.equivalent(option, operand)) return option;
    } catch {
      // Ignore one unreadable custom operand and continue within the bounded option domain.
    }
  }
  return undefined;
}

function snapshotFilter(
  filter: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  replacements: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  const snapshot: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.hasOwn(replacements, key)) snapshot[key] = replacements[key];
    else if (Object.hasOwn(filter, key)) snapshot[key] = filter[key];
  }
  if (
    SANITIZED_FILTER_SNAPSHOTS.has(filter) &&
    Reflect.ownKeys(filter).length === Reflect.ownKeys(snapshot).length &&
    Reflect.ownKeys(snapshot).every((key) =>
      Object.is(filter[key as string], snapshot[key as string]),
    )
  ) {
    return filter;
  }
  const frozen = Object.freeze(snapshot);
  SANITIZED_FILTER_SNAPSHOTS.add(frozen);
  return frozen;
}

function snapshotSanitizedFilterArray<T>(input: unknown, values: readonly T[]): readonly T[] {
  if (
    typeof input === "object" &&
    input !== null &&
    SANITIZED_FILTER_SNAPSHOTS.has(input) &&
    Array.isArray(input) &&
    sameReferences(input, values)
  ) {
    return input as readonly T[];
  }
  const snapshot = Object.freeze(Array.from(values));
  SANITIZED_FILTER_SNAPSHOTS.add(snapshot);
  return snapshot;
}

function sameReferences(previous: readonly unknown[], next: readonly unknown[]): boolean {
  return previous.length === next.length && previous.every((value, index) => value === next[index]);
}

function compileFilterOperandPlan(
  column: CompiledColumn,
  filter: Readonly<Record<string, unknown>>,
  context: FilterSanitizationContext,
): CompiledFilterOperandPlan | undefined {
  const retained = context.compiledOperandLookup.get(filter);
  if (retained !== undefined) {
    context.compiledOperands.set(filter, retained);
    return retained;
  }
  const type = filter["type"];
  const caseSensitive = filter["caseSensitive"] === true;
  const accentSensitive = filter["accentSensitive"] === true;
  const operand = filter["filter"];
  if (column.semantics.filterFamily === "text") {
    if ((type === "equals" || type === "notEqual") && operand !== undefined) {
      return {
        normalizedOperand: normalizeCanonicalTextOperand(
          column,
          operand,
          caseSensitive,
          accentSensitive,
          context,
        ),
      };
    }
    if (type === "in" && Array.isArray(operand)) {
      if (isExactTextSetMembership(column, filter)) {
        const membershipKeys = compileExactSetMembershipKeys(column, operand, context);
        return membershipKeys === undefined
          ? undefined
          : {
              membershipKeys,
              exactMembershipIndex: createBrunoTableSetValueIndex(column, operand),
            };
      }
      const normalizedOperands = operand.map((item) =>
        normalizeCanonicalTextOperand(column, item, caseSensitive, accentSensitive, context),
      );
      if (normalizedOperands.some((value) => value === undefined || value.length === 0)) {
        return undefined;
      }
      const membershipKeys = compileFilterMembershipKeys(
        column,
        operand,
        normalizedOperands,
        context,
      );
      return {
        normalizedOperands: Object.freeze(normalizedOperands),
        ...(membershipKeys === undefined ? {} : { membershipKeys }),
      };
    }
    if (
      (type === "contains" ||
        type === "notContains" ||
        type === "startsWith" ||
        type === "endsWith") &&
      typeof operand === "string"
    ) {
      const normalizedSubstringOperand = normalizeFilterTextOperand(
        operand,
        caseSensitive,
        accentSensitive,
        context,
      );
      return normalizedSubstringOperand === undefined ? undefined : { normalizedSubstringOperand };
    }
  } else if (type === "in" && Array.isArray(operand)) {
    const membershipKeys = compileFilterMembershipKeys(column, operand, [], context);
    if (membershipKeys !== undefined) return { membershipKeys };
    const exactMembershipKeys = compileExactSetMembershipKeys(column, operand, context);
    if (exactMembershipKeys !== undefined) {
      return {
        membershipKeys: exactMembershipKeys,
        exactMembershipIndex: createBrunoTableSetValueIndex(column, operand),
      };
    }
  }
  return undefined;
}

function compileExactSetMembershipKeys(
  column: CompiledColumn,
  operands: readonly unknown[],
  context?: FilterSanitizationContext,
): ReadonlySet<string> | undefined {
  const keys = new Set<string>();
  for (const operand of operands) {
    const key = brunoTableSetValueKey(column, operand);
    if (key === undefined) return undefined;
    if (context !== undefined && !reserveFilterText(key.length, context)) return undefined;
    keys.add(key);
  }
  return keys;
}

function normalizeCanonicalTextOperand(
  column: CompiledColumn,
  operand: unknown,
  caseSensitive: boolean,
  accentSensitive: boolean,
  context?: FilterSanitizationContext,
): string | undefined {
  try {
    const canonical = column.semantics.formatCanonicalText(operand);
    if (context !== undefined && !reserveFilterText(canonical.length, context)) return undefined;
    const normalized = normalizeBrunoTableFilterText(canonical, caseSensitive, accentSensitive);
    if (context !== undefined && !reserveFilterText(normalized.length, context)) return undefined;
    return normalized;
  } catch {
    return undefined;
  }
}

function normalizeFilterTextOperand(
  operand: string,
  caseSensitive: boolean,
  accentSensitive: boolean,
  context: FilterSanitizationContext,
): string | undefined {
  if (!reserveFilterText(operand.length, context)) return undefined;
  const normalized = normalizeBrunoTableFilterText(operand, caseSensitive, accentSensitive);
  if (!reserveFilterText(normalized.length, context)) return undefined;
  if (normalized.length === 0) return undefined;
  return normalized;
}

function compileFilterMembershipKeys(
  column: CompiledColumn,
  operands: readonly unknown[],
  normalizedOperands: readonly (string | undefined)[],
  context?: FilterSanitizationContext,
): ReadonlySet<string> | undefined {
  const keys = new Set<string>();
  for (let index = 0; index < operands.length; index += 1) {
    const key = filterMembershipKey(column, operands[index], normalizedOperands[index]);
    if (key === undefined) return undefined;
    if (context !== undefined && !reserveFilterText(key.length, context)) return undefined;
    keys.add(key);
  }
  return keys;
}

function filterMembershipKey(
  column: CompiledColumn,
  value: unknown,
  normalizedText?: string,
): string | undefined {
  if (column.semantics.filterFamily === "text") {
    return normalizedText === undefined ? undefined : `text:${normalizedText}`;
  }
  if (column.valueType === "number") {
    return typeof value === "number" && Number.isFinite(value)
      ? `number:${String(value)}`
      : undefined;
  }
  if (column.valueType === "bigint") {
    return typeof value === "bigint" ? `bigint:${value.toString(10)}` : undefined;
  }
  if (column.semantics.filterFamily === "boolean") {
    return typeof value === "boolean" ? `boolean:${String(value)}` : undefined;
  }
  if (column.semantics.filterFamily === "select") {
    const index = column.selectOptionIndexes?.get(value);
    return index === undefined || !Object.is(column.selectOptions?.[index], value)
      ? undefined
      : `select:${String(index)}`;
  }
  return undefined;
}

function createLeafFilterSignature(
  column: CompiledColumn,
  filter: Readonly<Record<string, unknown>>,
  plan: CompiledFilterOperandPlan | undefined,
  context: FilterSanitizationContext,
): string | undefined {
  const type = filter["type"];
  const parts = ["leaf", column.columnId, typeof type === "string" ? type : "unknown"];
  if (filter["caseSensitive"] === true) parts.push("caseSensitive");
  if (filter["accentSensitive"] === true) parts.push("accentSensitive");
  if (type === "blank" || type === "notBlank" || type === "matchNone") {
    return createFilterSignature(parts, context);
  }
  if (type === "in") {
    if (plan?.membershipKeys === undefined) return undefined;
    parts.push(...Array.from(plan.membershipKeys).sort(compareStringValues));
    return createFilterSignature(parts, context);
  }
  if (
    type === "contains" ||
    type === "notContains" ||
    type === "startsWith" ||
    type === "endsWith"
  ) {
    const normalized = plan?.normalizedSubstringOperand;
    return normalized === undefined
      ? undefined
      : createFilterSignature([...parts, normalized], context);
  }
  if (type === "inRange") {
    const from = filterOperandSignature(column, filter["filter"], context);
    const to = filterOperandSignature(column, filter["filterTo"], context);
    return from === undefined || to === undefined
      ? undefined
      : createFilterSignature([...parts, from, to], context);
  }
  if (type === "equals" || type === "notEqual") {
    if (column.semantics.filterFamily === "text") {
      const normalized = plan?.normalizedOperand;
      return normalized === undefined
        ? undefined
        : createFilterSignature([...parts, normalized], context);
    }
  }
  const operand = filterOperandSignature(column, filter["filter"], context);
  return operand === undefined ? undefined : createFilterSignature([...parts, operand], context);
}

function filterOperandSignature(
  column: CompiledColumn,
  value: unknown,
  context: FilterSanitizationContext,
): string | undefined {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (column.semantics.filterFamily === "select") {
    const index = column.selectOptionIndexes?.get(value);
    return index === undefined || !Object.is(column.selectOptions?.[index], value)
      ? undefined
      : `select:${String(index)}`;
  }
  if (column.semantics.filterFamily === "boolean") {
    return typeof value === "boolean" ? `boolean:${String(value)}` : undefined;
  }
  if (column.valueType === "number") {
    return typeof value === "number" && Number.isFinite(value)
      ? `number:${String(value)}`
      : undefined;
  }
  if (column.valueType === "bigint") {
    if (typeof value !== "bigint") return undefined;
    const decimal = value.toString(10);
    return reserveFilterText(decimal.length, context) ? `bigint:${decimal}` : undefined;
  }
  return undefined;
}

function createFilterSignature(
  parts: readonly string[],
  context: FilterSanitizationContext,
): string | undefined {
  // Length-delimited tokens are collision-free without JSON serialization. The final key is
  // charged once against the shared retained-text ledger before it is retained in the index. If a
  // A compound key that would exceed the remaining collection text budget stays opaque rather than
  // allocating an unbounded transient string. Leaf representations that can themselves be large
  // (notably BigInt decimal text) are charged before reaching this bounded signature assembly.
  const length = parts.reduce(
    (total, part) => total + part.length + String(part.length).length + 1,
    0,
  );
  if (length > BRUNO_TABLE_CLIENT_FILTER_MAX_TOTAL_TEXT_LENGTH - context.textLength)
    return undefined;
  const signature = parts.map((part) => `${part.length}:${part}`).join("|");
  return reserveFilterText(signature.length, context) ? signature : undefined;
}

function compareStringValues(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function evaluateFilter(
  candidate: unknown,
  row: unknown,
  columnsById: ReadonlyMap<string, CompiledColumn>,
  readValue: (column: CompiledColumn, row: unknown) => unknown,
  compiledOperands: ReadonlyMap<object, CompiledFilterOperandPlan>,
  completed: WeakMap<object, boolean> | undefined,
): boolean {
  if (completed === undefined) {
    return evaluateFilterRecord(
      candidate,
      row,
      columnsById,
      readValue,
      compiledOperands,
      undefined,
    );
  }
  const candidateObject =
    typeof candidate === "object" && candidate !== null ? candidate : undefined;
  if (candidateObject !== undefined && completed.has(candidateObject)) {
    return completed.get(candidateObject) ?? false;
  }
  const result = evaluateFilterRecord(
    candidate,
    row,
    columnsById,
    readValue,
    compiledOperands,
    completed,
  );
  if (candidateObject !== undefined) completed.set(candidateObject, result);
  return result;
}

function evaluateFilterRecord(
  candidate: unknown,
  row: unknown,
  columnsById: ReadonlyMap<string, CompiledColumn>,
  readValue: (column: CompiledColumn, row: unknown) => unknown,
  compiledOperands: ReadonlyMap<object, CompiledFilterOperandPlan>,
  completed: WeakMap<object, boolean> | undefined,
): boolean {
  const filter = asRecord(candidate);
  const type = filter["type"];
  if (type === "AND" || type === "OR") {
    const conditions = Array.isArray(filter["conditions"]) ? filter["conditions"] : [];
    return type === "AND"
      ? conditions.every((condition) =>
          evaluateFilter(condition, row, columnsById, readValue, compiledOperands, completed),
        )
      : conditions.some((condition) =>
          evaluateFilter(condition, row, columnsById, readValue, compiledOperands, completed),
        );
  }
  if (type === "NOT") {
    return !evaluateFilter(
      filter["condition"],
      row,
      columnsById,
      readValue,
      compiledOperands,
      completed,
    );
  }
  const columnId = filter["columnId"];
  const column = typeof columnId === "string" ? columnsById.get(columnId) : undefined;
  if (column === undefined || column.enableFilter === false || column.kind !== "field") {
    return false;
  }

  if (filter["type"] === "matchNone") return false;
  const value = readValue(column, row);
  const operand = filter["filter"];
  const caseSensitive = filter["caseSensitive"] === true;
  const accentSensitive = filter["accentSensitive"] === true;
  const plan =
    typeof candidate === "object" && candidate !== null
      ? compiledOperands.get(candidate)
      : undefined;
  if (filter["type"] === "blank") return value === null || value === undefined || value === "";
  if (filter["type"] === "notBlank") return value !== null && value !== undefined && value !== "";
  if (filter["type"] === "equals") {
    return compareEquality(
      column,
      value,
      operand,
      caseSensitive,
      accentSensitive,
      plan?.normalizedOperand,
    );
  }
  if (filter["type"] === "notEqual") {
    return !compareEquality(
      column,
      value,
      operand,
      caseSensitive,
      accentSensitive,
      plan?.normalizedOperand,
    );
  }
  if (filter["type"] === "in") {
    if (isExactTextSetMembership(column, filter)) {
      return (
        plan?.exactMembershipIndex !== undefined &&
        hasBrunoTableSetValue(column, plan.exactMembershipIndex, value)
      );
    }
    if (plan?.exactMembershipIndex !== undefined) {
      return hasBrunoTableSetValue(column, plan.exactMembershipIndex, value);
    }
    if (plan?.membershipKeys !== undefined) {
      const key = filterMembershipKey(
        column,
        value,
        column.semantics.filterFamily === "text"
          ? normalizeCanonicalTextOperand(column, value, caseSensitive, accentSensitive)
          : undefined,
      );
      if (key !== undefined) return plan.membershipKeys.has(key);
    }
    return (
      Array.isArray(operand) &&
      operand.some((item, index) =>
        compareEquality(
          column,
          value,
          item,
          caseSensitive,
          accentSensitive,
          plan?.normalizedOperands?.[index],
        ),
      )
    );
  }
  if (
    (filter["type"] === "greaterThan" ||
      filter["type"] === "greaterThanOrEqual" ||
      filter["type"] === "lessThan" ||
      filter["type"] === "lessThanOrEqual" ||
      filter["type"] === "inRange") &&
    (value === null || value === undefined)
  ) {
    return false;
  }
  if (filter["type"] === "greaterThan") return column.semantics.compare(value, operand) > 0;
  if (filter["type"] === "greaterThanOrEqual") return column.semantics.compare(value, operand) >= 0;
  if (filter["type"] === "lessThan") return column.semantics.compare(value, operand) < 0;
  if (filter["type"] === "lessThanOrEqual") return column.semantics.compare(value, operand) <= 0;
  if (filter["type"] === "inRange") {
    return (
      column.semantics.compare(operand, value) <= 0 &&
      column.semantics.compare(value, filter["filterTo"]) < 0
    );
  }
  if (typeof operand !== "string") return filter["type"] === "notContains";
  if (value === null || value === undefined) return filter["type"] === "notContains";
  const left = normalizeBrunoTableFilterText(
    column.semantics.formatCanonicalText(value),
    caseSensitive,
    accentSensitive,
  );
  const right =
    plan?.normalizedSubstringOperand ??
    normalizeBrunoTableFilterText(operand, caseSensitive, accentSensitive);
  if (filter["type"] === "contains") return left.includes(right);
  if (filter["type"] === "notContains") return !left.includes(right);
  if (filter["type"] === "startsWith") return left.startsWith(right);
  if (filter["type"] === "endsWith") return left.endsWith(right);
  return false;
}

function isExactTextSetMembership(
  column: CompiledColumn,
  filter: Readonly<Record<string, unknown>>,
): boolean {
  return (
    column.enableSetFilter &&
    column.semantics.filterFamily === "text" &&
    filter["type"] === "in" &&
    filter["caseSensitive"] === true &&
    filter["accentSensitive"] === true
  );
}

function compareEquality(
  column: CompiledColumn,
  value: unknown,
  operand: unknown,
  caseSensitive: boolean,
  accentSensitive: boolean,
  normalizedOperand?: string,
): boolean {
  if (value === null || value === undefined || operand === null || operand === undefined) {
    return value === operand;
  }
  if (column.semantics.filterFamily === "text") {
    return (
      normalizeBrunoTableFilterText(
        column.semantics.formatCanonicalText(value),
        caseSensitive,
        accentSensitive,
      ) ===
      (normalizedOperand ??
        normalizeBrunoTableFilterText(
          column.semantics.formatCanonicalText(operand),
          caseSensitive,
          accentSensitive,
        ))
    );
  }
  return column.semantics.equivalent(value, operand);
}

export function sameBrunoTableFilterCollection(
  previous: readonly unknown[],
  next: readonly unknown[],
  columnsById: ReadonlyMap<string, CompiledColumn>,
  unordered = true,
): boolean {
  const columns = Array.from(columnsById.values());
  return sameCompiledFilterCollections(
    compileClientFilterCollection(previous, columns),
    compileClientFilterCollection(next, columns),
    unordered,
  );
}

export function sameBrunoTableFilterValue(
  previous: unknown,
  next: unknown,
  columnsById: ReadonlyMap<string, CompiledColumn>,
  column?: CompiledColumn,
  seen: WeakMap<object, object> = new WeakMap(),
): boolean {
  if (column !== undefined) return sameFilterSemanticValue(column, previous, next);
  return sameFilterValueStructure(previous, next, columnsById, seen);
}

function sameFilterSemanticValue(
  column: CompiledColumn,
  previous: unknown,
  next: unknown,
): boolean {
  if (Object.is(previous, next)) return true;
  if (previous === null || previous === undefined || next === null || next === undefined) {
    return previous === next;
  }
  try {
    if (column.semantics.filterFamily === "text") {
      return (
        normalizeBrunoTableFilterText(column.semantics.formatCanonicalText(previous)) ===
        normalizeBrunoTableFilterText(column.semantics.formatCanonicalText(next))
      );
    }
    return column.semantics.equivalent(previous, next);
  } catch {
    return false;
  }
}

function sameFilterValueStructure(
  previous: unknown,
  next: unknown,
  columnsById: ReadonlyMap<string, CompiledColumn>,
  seen: WeakMap<object, object>,
): boolean {
  if (Object.is(previous, next)) return true;
  if (typeof previous !== typeof next || previous === null || next === null) return false;
  if (typeof previous !== "object" || typeof next !== "object") return false;
  const previousObject = previous as object;
  const nextObject = next as object;
  const matched = seen.get(previousObject);
  if (matched !== undefined) return matched === nextObject;
  seen.set(previousObject, nextObject);
  try {
    if (Array.isArray(previous) || Array.isArray(next)) {
      if (!Array.isArray(previous) || !Array.isArray(next) || previous.length !== next.length) {
        return false;
      }
      return previous.every((value, index) =>
        sameFilterValueStructure(value, next[index], columnsById, seen),
      );
    }
    const previousKeys = Reflect.ownKeys(previous);
    const nextKeys = Reflect.ownKeys(next);
    if (previousKeys.length !== nextKeys.length) return false;
    const nextKeySet = new Set(nextKeys);
    if (!previousKeys.every((key) => nextKeySet.has(key))) return false;
    const previousColumnId = readDataProperty(previous, "columnId");
    const nextColumnId = readDataProperty(next, "columnId");
    const column =
      typeof previousColumnId === "string" && previousColumnId === nextColumnId
        ? columnsById.get(previousColumnId)
        : undefined;
    const type = readDataProperty(previous, "type");
    for (const key of previousKeys) {
      const previousDescriptor = Object.getOwnPropertyDescriptor(previous, key);
      const nextDescriptor = Object.getOwnPropertyDescriptor(next, key);
      if (
        previousDescriptor === undefined ||
        nextDescriptor === undefined ||
        !Object.hasOwn(previousDescriptor, "value") ||
        !Object.hasOwn(nextDescriptor, "value")
      ) {
        return false;
      }
      const leftValue = previousDescriptor.value;
      const rightValue = nextDescriptor.value;
      if (column !== undefined && (key === "filter" || key === "filterTo")) {
        if (type === "in" && key === "filter" && Array.isArray(leftValue)) {
          if (!Array.isArray(rightValue) || leftValue.length !== rightValue.length) return false;
          const matchedValues = new Set<number>();
          if (
            !leftValue.every((value) => {
              const index = rightValue.findIndex(
                (candidate, candidateIndex) =>
                  !matchedValues.has(candidateIndex) &&
                  sameFilterSemanticValue(column, value, candidate),
              );
              if (index < 0) return false;
              matchedValues.add(index);
              return true;
            })
          ) {
            return false;
          }
        } else if (!sameFilterSemanticValue(column, leftValue, rightValue)) {
          return false;
        }
      } else if (!sameFilterValueStructure(leftValue, rightValue, columnsById, seen)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function readDataProperty(value: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && Object.hasOwn(descriptor, "value")
    ? descriptor.value
    : undefined;
}

function sameCompiledFilterCollections(
  previous: BrunoTableClientFilterCollection,
  next: BrunoTableClientFilterCollection,
  unordered: boolean,
): boolean {
  if (previous === next) return true;
  if (previous.expressions.length !== next.expressions.length) return false;
  if (!unordered) {
    return previous.expressions.every(
      (expression, index) =>
        expression.signature !== undefined &&
        expression.signature === next.expressions[index]?.signature,
    );
  }
  const columnIds = new Set<string>([
    ...previous.expressionsByColumn.keys(),
    ...next.expressionsByColumn.keys(),
  ]);
  return [...columnIds].every((columnId) => {
    const left = previous.expressionsByColumn.get(columnId)?.signature;
    const right = next.expressionsByColumn.get(columnId)?.signature;
    return left !== undefined && left === right;
  });
}

export function sameBrunoTableFilterCollections(
  previous: BrunoTableClientFilterCollection,
  next: BrunoTableClientFilterCollection,
  unordered = true,
): boolean {
  return sameCompiledFilterCollections(previous, next, unordered);
}

export function sameBrunoTableFilterColumn(
  previous: BrunoTableClientFilterCollection,
  next: BrunoTableClientFilterCollection,
  columnId: string,
): boolean {
  const left = previous.expressionsByColumn.get(columnId);
  const right = next.expressionsByColumn.get(columnId);
  if (left === right) return true;
  return left?.signature !== undefined && left.signature === right?.signature;
}

function hasValidTextSensitivity(
  filter: Readonly<Record<string, unknown>>,
  supported: boolean,
): boolean {
  return ["caseSensitive", "accentSensitive"].every(
    (key) => !Object.hasOwn(filter, key) || (supported && typeof filter[key] === "boolean"),
  );
}

function snapshotDenseArray(values: unknown, length: number): readonly unknown[] | undefined {
  try {
    if (!Array.isArray(values)) return undefined;
    const snapshot: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      if (!Object.hasOwn(values, index)) return undefined;
      snapshot.push(values[index]);
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

function snapshotInputEntries(
  values: unknown,
): readonly unknown[] | undefined | typeof FILTER_ENTRIES_OVER_BUDGET {
  try {
    if (!Array.isArray(values)) return undefined;
    const length = values.length;
    if (!Number.isSafeInteger(length) || length < 0) return undefined;
    const snapshot: unknown[] = [];
    const probeLength = Math.min(length, BRUNO_TABLE_CLIENT_FILTER_MAX_INPUT_ENTRIES + 1);
    for (let index = 0; index < probeLength; index += 1) {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(values, index);
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
          continue;
        }
        if (snapshot.length >= BRUNO_TABLE_CLIENT_FILTER_MAX_INPUT_ENTRIES) {
          return FILTER_ENTRIES_OVER_BUDGET;
        }
        snapshot.push(descriptor.value);
      } catch {
        // Ignore only this unreadable external entry so valid siblings remain usable.
      }
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

function isReadableEmptyArray(value: unknown): boolean {
  try {
    return Array.isArray(value) && value.length === 0;
  } catch {
    return false;
  }
}

function hasSortableColumns(columns: readonly CompiledColumn[]): boolean {
  return columns.some((column) => column.enableSorting !== false);
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Readonly<Record<string, unknown>>;
}

const EMPTY_ORDER_BY: ClientOrderBy = Object.freeze([]);
export const BRUNO_TABLE_CLIENT_FILTER_MAX_DEPTH = 64;
export const BRUNO_TABLE_CLIENT_FILTER_MAX_TOTAL_NODES = 16_384;
export const BRUNO_TABLE_CLIENT_FILTER_MAX_TOTAL_OPERANDS = 16_384;
export const BRUNO_TABLE_CLIENT_FILTER_MAX_TOTAL_TEXT_LENGTH = 1_048_576;
/** One shared admission allowance for custom Select semantic-equivalence calls. */
export const BRUNO_TABLE_CLIENT_FILTER_MAX_TOTAL_COMPARISONS = 16_384;
// Compatibility names for internal tests and diagnostics. These are aggregate limits, not
// per-expression budgets.
export const BRUNO_TABLE_CLIENT_FILTER_MAX_NODES: number =
  BRUNO_TABLE_CLIENT_FILTER_MAX_TOTAL_NODES;
export const BRUNO_TABLE_CLIENT_FILTER_MAX_OPERANDS: number =
  BRUNO_TABLE_CLIENT_FILTER_MAX_TOTAL_OPERANDS;
export const BRUNO_TABLE_CLIENT_FILTER_MAX_INPUT_ENTRIES = 16_384;
const FILTER_ENTRIES_OVER_BUDGET = Symbol("BrunoTable filter entries over budget");
const SANITIZED_FILTER_SNAPSHOTS = new WeakSet<object>();

type FilterSanitizationContext = {
  readonly captured: WeakMap<object, Readonly<Record<string, unknown>> | undefined>;
  readonly capturedArrays: WeakMap<object, CapturedFilterArray | undefined>;
  readonly completed: WeakMap<object, Map<number, SanitizedFilterNode | undefined>>;
  readonly visited: WeakSet<object>;
  readonly admittedNodes: WeakSet<object>;
  readonly acceptedSanitizedEvidence: WeakMap<object, AcceptedSanitizedFilterEvidence>;
  readonly pendingSanitizedEvidence: Array<readonly [object, AcceptedSanitizedFilterEvidence]>;
  readonly retainedFilterNodes: WeakSet<object>;
  readonly filterNodes: object[];
  /** Raw operand objects already traversed during this entry admission transaction. */
  readonly meteredOperandObjects: WeakSet<object>;
  readonly compiledOperands: Map<object, CompiledFilterOperandPlan>;
  readonly compiledOperandLookup: ReadonlyMap<object, CompiledFilterOperandPlan>;
  readonly columnLabelsById: ReadonlyMap<string, string>;
  /** Descriptions committed by earlier accepted entries in this collection admission. */
  readonly descriptionMemo: Map<object, string | undefined>;
  /** Candidate-local descriptions; merged only after the candidate entry is accepted. */
  readonly pendingDescriptionMemo: Map<object, string | undefined>;
  hasSharedNodes: boolean;
  nodes: number;
  operands: number;
  textLength: number;
  /** Monotonic admission work counter; rejected entries cannot reopen consumed comparisons. */
  comparisons: number;
  comparisonBudgetExhausted: boolean;
  overBudget: boolean;
};

type FilterSanitizationContextInitial = Readonly<{
  readonly nodes?: number;
  readonly operands?: number;
  readonly textLength?: number;
  readonly comparisons?: number;
}>;

type AcceptedSanitizedFilterEvidence = Readonly<{
  readonly node: SanitizedFilterNode;
  readonly height: number;
  readonly descendantNodes: number;
  readonly operands: number;
  readonly textLength: number;
  readonly filterNodes: readonly object[];
  readonly compiledOperands: readonly (readonly [object, CompiledFilterOperandPlan])[];
}>;

type FilterSanitizationContextOptions = Readonly<{
  readonly initial?: FilterSanitizationContextInitial;
  readonly compiledOperands?: Map<object, CompiledFilterOperandPlan>;
  readonly captured?: WeakMap<object, Readonly<Record<string, unknown>> | undefined>;
  readonly capturedArrays?: WeakMap<object, CapturedFilterArray | undefined>;
  readonly acceptedSanitizedEvidence?: WeakMap<object, AcceptedSanitizedFilterEvidence>;
  readonly compiledOperandLookup?: ReadonlyMap<object, CompiledFilterOperandPlan>;
  readonly columnLabelsById?: ReadonlyMap<string, string>;
  readonly descriptionMemo?: Map<object, string | undefined>;
  readonly pendingDescriptionMemo?: Map<object, string | undefined>;
  readonly comparisonBudgetExhausted?: boolean;
}>;

function createFilterSanitizationContext(
  options: FilterSanitizationContextOptions = {},
): FilterSanitizationContext {
  const compiledOperands = options.compiledOperands ?? new Map();
  return {
    captured: options.captured ?? new WeakMap(),
    capturedArrays: options.capturedArrays ?? new WeakMap(),
    completed: new WeakMap(),
    visited: new WeakSet(),
    admittedNodes: new WeakSet(),
    acceptedSanitizedEvidence: options.acceptedSanitizedEvidence ?? new WeakMap(),
    pendingSanitizedEvidence: [],
    retainedFilterNodes: new WeakSet(),
    filterNodes: [],
    meteredOperandObjects: new WeakSet(),
    compiledOperands,
    compiledOperandLookup: options.compiledOperandLookup ?? compiledOperands,
    columnLabelsById: options.columnLabelsById ?? new Map(),
    descriptionMemo: options.descriptionMemo ?? new Map(),
    pendingDescriptionMemo: options.pendingDescriptionMemo ?? new Map(),
    hasSharedNodes: false,
    nodes: options.initial?.nodes ?? 0,
    operands: options.initial?.operands ?? 0,
    textLength: options.initial?.textLength ?? 0,
    comparisons: options.initial?.comparisons ?? 0,
    comparisonBudgetExhausted: options.comparisonBudgetExhausted === true,
    overBudget: false,
  };
}

function mergeClientFilterDescriptionMemo(
  target: Map<object, string | undefined>,
  source: ReadonlyMap<object, string | undefined>,
): void {
  for (const [node, description] of source) target.set(node, description);
}

function isBoundedFilterOperand(value: unknown, context: FilterSanitizationContext): boolean {
  // These per-operand object/property/depth checks are structural readability guards. They stop
  // an accessor-backed or cyclic value before decoding; they are deliberately not complexity
  // budgets and never replace or reset the collection-wide node/operand/text ledger below.
  const visited = new WeakSet<object>();
  const discoveredObjects: object[] = [];
  const discoveredStrings: string[] = [];
  let objectCount = 0;
  let propertyCount = 0;

  const visit = (candidate: unknown, depth: number): boolean => {
    if (typeof candidate === "string") {
      discoveredStrings.push(candidate);
      return true;
    }
    if (
      candidate === null ||
      candidate === undefined ||
      typeof candidate === "boolean" ||
      typeof candidate === "number" ||
      typeof candidate === "bigint" ||
      typeof candidate === "symbol"
    ) {
      return true;
    }
    if (typeof candidate !== "object" || depth > BRUNO_TABLE_MAX_FILTER_OPERAND_DEPTH) {
      if (depth > BRUNO_TABLE_MAX_FILTER_OPERAND_DEPTH) context.overBudget = true;
      return false;
    }
    if (context.meteredOperandObjects.has(candidate)) return true;
    if (visited.has(candidate)) return true;
    visited.add(candidate);
    discoveredObjects.push(candidate);
    objectCount += 1;
    if (objectCount > BRUNO_TABLE_MAX_FILTER_OPERAND_OBJECTS) {
      context.overBudget = true;
      return false;
    }
    let keys: readonly PropertyKey[];
    try {
      keys = Reflect.ownKeys(candidate);
    } catch {
      return false;
    }
    propertyCount += keys.length;
    if (propertyCount > BRUNO_TABLE_MAX_FILTER_OPERAND_PROPERTIES) {
      context.overBudget = true;
      return false;
    }
    for (const key of keys) {
      if (typeof key === "string") discoveredStrings.push(key);
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      } catch {
        return false;
      }
      if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return false;
      if (!visit(descriptor.value, depth + 1)) return false;
    }
    return true;
  };

  if (!visit(value, 0)) return false;
  let textLength = 0;
  for (const text of discoveredStrings) textLength += text.length;
  if (!reserveFilterText(textLength, context)) return false;
  for (const object of discoveredObjects) context.meteredOperandObjects.add(object);
  return true;
}

type CapturedFilterArray = {
  attempted: boolean;
  readonly length: number;
  snapshot: readonly unknown[] | undefined;
};

type SanitizedFilterNode = {
  readonly columnIds: ReadonlySet<string>;
  readonly filter: Readonly<Record<string, unknown>>;
  readonly height: number;
  readonly signature?: string;
};
