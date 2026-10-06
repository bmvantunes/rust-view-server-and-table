import {
  createContext,
  memo,
  useContext,
  useMemo,
  useSyncExternalStore,
  type NamedExoticComponent,
  type ReactElement,
  type ReactNode,
} from "react";

import { createBrunoTableServerFacetSnapshot } from "./client-facet";
import { BrunoTableSetFilterView, type BrunoTableSetFilterFacetProps } from "./client-filter";
import type { CompiledColumn } from "./compile-columns";
import type { BrunoTableQuerySnapshot, BrunoTableRowPipelineRuntimeView } from "./grid-runtime";
import {
  compileBrunoTableServerFacetQuery,
  selectBrunoTableServerFacetGridFilters,
  type BrunoTableCompiledServerFacetQuery,
  type BrunoTableCompiledServerFacetQueryPlan,
} from "./server-query";
import { snapshotBrunoTableSourceMessage } from "./source-lifecycle";

type BrunoTableServerWholeResult = Readonly<{
  readonly rows: readonly unknown[];
  readonly status: "loading" | "ready" | "stale" | "closed" | "error";
  readonly message?: string | undefined;
}>;

type BrunoTableServerFacetContextValue = Readonly<{
  readonly getFacetPlan: (
    snapshot: BrunoTableServerFacetSemanticSnapshot,
    columnId: string,
  ) => BrunoTableCompiledServerFacetQueryPlan;
  readonly getSnapshot: () => BrunoTableServerFacetSemanticSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
}>;

export type BrunoTableServerFacetSemanticSnapshot = Readonly<{
  readonly externalFilters: readonly unknown[] | undefined;
  readonly quickFilterFields: readonly string[];
  readonly querySnapshot: BrunoTableQuerySnapshot;
  readonly routeBy: Readonly<Record<string, unknown>> | undefined;
  readonly runtime: BrunoTableRowPipelineRuntimeView;
  readonly source: unknown;
  readonly transportIdentity: unknown;
}>;

export class BrunoTableServerFacetRuntime {
  readonly #listeners = new Set<() => void>();
  readonly #plans = new Map<string, StableFacetPlan>();
  #snapshot: BrunoTableServerFacetSemanticSnapshot;

  public constructor(snapshot: BrunoTableServerFacetSemanticSnapshot) {
    this.#snapshot = Object.freeze(snapshot);
  }

  public readonly getSnapshot = (): BrunoTableServerFacetSemanticSnapshot => this.#snapshot;

  public readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  public readonly getFacetPlan = (
    snapshot: BrunoTableServerFacetSemanticSnapshot,
    columnId: string,
  ): BrunoTableCompiledServerFacetQueryPlan => {
    const filters = selectBrunoTableServerFacetGridFilters(
      snapshot.querySnapshot.filters,
      columnId,
    );
    const cached = this.#plans.get(columnId);
    if (
      cached !== undefined &&
      Object.is(cached.columns, snapshot.querySnapshot.columns) &&
      Object.is(cached.routeBy, snapshot.routeBy) &&
      Object.is(cached.externalFilters, snapshot.externalFilters) &&
      Object.is(cached.transportIdentity, snapshot.transportIdentity) &&
      cached.quickFilter === snapshot.querySnapshot.quickFilter &&
      Object.is(cached.quickFilterFields, snapshot.quickFilterFields) &&
      sameReferenceArray(cached.filters, filters)
    ) {
      return cached.plan;
    }
    const plan = compileBrunoTableServerFacetQuery(snapshot.querySnapshot.columns, columnId, {
      ...(snapshot.routeBy === undefined ? {} : { routeBy: snapshot.routeBy }),
      ...(snapshot.externalFilters === undefined
        ? {}
        : { externalFilters: snapshot.externalFilters }),
      filters,
      quickFilter: snapshot.querySnapshot.quickFilter,
      quickFilterFields: snapshot.quickFilterFields,
      orderBy: [],
    });
    this.#plans.set(
      columnId,
      Object.freeze({
        columns: snapshot.querySnapshot.columns,
        externalFilters: snapshot.externalFilters,
        filters,
        plan,
        quickFilter: snapshot.querySnapshot.quickFilter,
        quickFilterFields: snapshot.quickFilterFields,
        routeBy: snapshot.routeBy,
        transportIdentity: snapshot.transportIdentity,
      }),
    );
    return plan;
  };

  public reconcile(snapshot: BrunoTableServerFacetSemanticSnapshot): void {
    if (!Object.is(this.#snapshot.querySnapshot.columns, snapshot.querySnapshot.columns)) {
      this.#plans.clear();
    }
    if (
      sameServerFacetQuerySnapshot(this.#snapshot.querySnapshot, snapshot.querySnapshot) &&
      sameServerFacetSource(this.#snapshot.source, snapshot.source) &&
      Object.is(this.#snapshot.routeBy, snapshot.routeBy) &&
      Object.is(this.#snapshot.externalFilters, snapshot.externalFilters) &&
      Object.is(this.#snapshot.quickFilterFields, snapshot.quickFilterFields)
    ) {
      return;
    }
    this.#snapshot = Object.freeze(snapshot);
    for (const listener of this.#listeners) listener();
  }
}

function sameServerFacetSource(previous: unknown, next: unknown): boolean {
  if (Object.is(previous, next)) return true;
  if (
    typeof previous !== "object" ||
    previous === null ||
    typeof next !== "object" ||
    next === null
  ) {
    return false;
  }
  return (
    Object.is(Reflect.get(previous, "viewport"), Reflect.get(next, "viewport")) &&
    Object.is(Reflect.get(previous, "useWholeResult"), Reflect.get(next, "useWholeResult"))
  );
}

function sameServerFacetQuerySnapshot(
  previous: BrunoTableQuerySnapshot,
  next: BrunoTableQuerySnapshot,
): boolean {
  return (
    Object.is(previous.columns, next.columns) &&
    Object.is(previous.filters, next.filters) &&
    Object.is(previous.filterCollection, next.filterCollection) &&
    previous.quickFilter === next.quickFilter
  );
}

const BrunoTableServerFacetContext = createContext<BrunoTableServerFacetContextValue | null>(null);
const emptyBrunoTableServerFacetRows: readonly unknown[] = Object.freeze([]);

export function BrunoTableServerFacetProvider({
  children,
  runtime,
}: Readonly<{
  readonly children: ReactNode;
  readonly runtime: BrunoTableServerFacetRuntime;
}>): ReactElement {
  const value = useMemo(
    () => ({
      getFacetPlan: runtime.getFacetPlan,
      getSnapshot: runtime.getSnapshot,
      subscribe: runtime.subscribe,
    }),
    [runtime],
  );
  return (
    <BrunoTableServerFacetContext.Provider value={value}>
      {children}
    </BrunoTableServerFacetContext.Provider>
  );
}

export const BrunoTableServerSetFilterFacet: NamedExoticComponent<BrunoTableSetFilterFacetProps> =
  memo(function BrunoTableServerSetFilterFacet({
    column,
  }: BrunoTableSetFilterFacetProps): ReactElement | null {
    const context = useContext(BrunoTableServerFacetContext);
    if (context === null) {
      throw new TypeError("BrunoTable Server Set Filter is missing its source Adapter context.");
    }
    const semanticSnapshot = useSyncExternalStore(
      context.subscribe,
      context.getSnapshot,
      context.getSnapshot,
    );
    const { querySnapshot } = semanticSnapshot;
    const coherentColumn = querySnapshot.columns.find(
      (candidate) => candidate.columnId === column.columnId,
    );
    if (
      coherentColumn === undefined ||
      !coherentColumn.enableFilter ||
      !coherentColumn.enableSetFilter
    ) {
      return null;
    }
    return (
      <BrunoTableResolvedServerSetFilterFacet
        column={coherentColumn}
        plan={context.getFacetPlan(semanticSnapshot, coherentColumn.columnId)}
        semanticSnapshot={semanticSnapshot}
        querySnapshot={querySnapshot}
      />
    );
  });

function BrunoTableResolvedServerSetFilterFacet({
  column,
  plan,
  semanticSnapshot,
  querySnapshot,
}: Readonly<{
  readonly column: CompiledColumn;
  readonly plan: BrunoTableCompiledServerFacetQueryPlan;
  readonly semanticSnapshot: BrunoTableServerFacetSemanticSnapshot;
  readonly querySnapshot: BrunoTableQuerySnapshot;
}>): ReactElement {
  const result = useBrunoTableServerWholeResult(semanticSnapshot.source, plan.query);
  const expression = querySnapshot.filterCollection.filtersByColumn.get(column.columnId);
  const coherentRows = result.status === "loading" ? emptyBrunoTableServerFacetRows : result.rows;
  const snapshot = useMemo(
    () =>
      createBrunoTableServerFacetSnapshot({
        column,
        countAlias: plan.countAlias,
        rows: coherentRows,
        expression,
      }),
    [coherentRows, column, expression, plan.countAlias],
  );
  const lifecycle = useMemo(
    () => ({ status: result.status, message: result.message }),
    [result.message, result.status],
  );
  return (
    <BrunoTableSetFilterView
      column={column}
      lifecycle={lifecycle}
      runtime={semanticSnapshot.runtime}
      snapshot={snapshot}
    />
  );
}

type StableFacetPlan = Readonly<{
  readonly columns: readonly CompiledColumn[];
  readonly externalFilters: readonly unknown[] | undefined;
  readonly filters: readonly unknown[];
  readonly plan: BrunoTableCompiledServerFacetQueryPlan;
  readonly quickFilter: string;
  readonly quickFilterFields: readonly string[];
  readonly routeBy: Readonly<Record<string, unknown>> | undefined;
  readonly transportIdentity: unknown;
}>;

function sameReferenceArray(previous: readonly unknown[], next: readonly unknown[]): boolean {
  return (
    previous.length === next.length &&
    previous.every((value, index) => Object.is(value, next[index]))
  );
}

function useBrunoTableServerWholeResult(
  source: unknown,
  query: BrunoTableCompiledServerFacetQuery,
): BrunoTableServerWholeResult {
  "use no memo";
  if (typeof source !== "object" || source === null) {
    throw new TypeError("BrunoTable Server viewportSource must be an object.");
  }
  const hook = Reflect.get(source, "useWholeResult");
  if (typeof hook !== "function") {
    throw new TypeError("BrunoTable Server viewportSource must expose useWholeResult().");
  }
  return requireWholeResult(Reflect.apply(hook, source, [query]));
}

function requireWholeResult(candidate: unknown): BrunoTableServerWholeResult {
  if (typeof candidate !== "object" || candidate === null) {
    throw new TypeError("BrunoTable Server useWholeResult() returned no source result.");
  }
  const rows = Reflect.get(candidate, "rows");
  const status = Reflect.get(candidate, "status");
  const message = Reflect.get(candidate, "message");
  if (!Array.isArray(rows) || !isServerFacetStatus(status)) {
    throw new TypeError("BrunoTable Server useWholeResult() returned an invalid source result.");
  }
  if (message !== undefined && typeof message !== "string") {
    throw new TypeError("BrunoTable Server useWholeResult() returned an invalid message.");
  }
  return Object.freeze({
    rows,
    status,
    ...(message === undefined ? {} : { message: snapshotBrunoTableSourceMessage(message) }),
  });
}

function isServerFacetStatus(value: unknown): value is BrunoTableServerWholeResult["status"] {
  return (
    value === "loading" ||
    value === "ready" ||
    value === "stale" ||
    value === "closed" ||
    value === "error"
  );
}
