import type { LiveQueryViewportBaseRow } from "effect-view-server/react/viewport-base-row";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

import type { ReactNode } from "react";
import type {
  BrunoTableColumns,
  BrunoTablePersistedState,
  BrunoTableServerProps,
} from "./public-types";
import {
  BrunoTableToolbar,
  BrunoTableToolbarStore,
  BrunoTableView,
} from "./internal/bruno-table-view";
import {
  BrunoTableActiveFilters,
  BrunoTableClientFilterProvider,
  BrunoTableQuickFilter,
  renderBrunoTableServerColumnFilter,
} from "./internal/client-filter-controls";
import { compileColumns, type CompiledColumn } from "./internal/compile-columns";
import { BrunoTableGridRuntime } from "./internal/grid-runtime";
import { BrunoTableServerRowPipeline } from "./internal/server-row-pipeline";
import {
  BrunoTableServerFacetProvider,
  BrunoTableServerFacetRuntime,
} from "./internal/server-facet";
import {
  BrunoTableServerRowPipelineAdapter,
  type BrunoTableServerQueryInputs,
} from "./internal/server-source-adapter";
import { registerBrunoTableIdentity } from "./internal/table-identity-registry";
import {
  BrunoTableActiveFilterCount,
  BrunoTableActiveSortCount,
  BrunoTableFilterControl,
  BrunoTableLoadedRowCount,
  BrunoTableResultRowCount,
  BrunoTableToolbarProvider,
  BrunoTableToolbarSpacer,
} from "./internal/toolbar-capabilities";
import { recordBrunoTableToolbarLifetime } from "./internal/toolbar-instrumentation";
import { snapshotBrunoTableQuickFilterFields } from "./internal/quick-filter";
import { useBrunoTableServerFacetHookSource } from "./internal/react-compiler-adapters";
import { compileBrunoTableGroupRowsColumn } from "./internal/client-grouping-presentation";
import { BrunoTableClientGroupBy } from "./internal/client-grouping-controls";

export {
  BrunoTableActiveFilterCount,
  BrunoTableActiveSortCount,
  BrunoTableFilterControl,
  BrunoTableLoadedRowCount,
  BrunoTableQuickFilter,
  BrunoTableResultRowCount,
  BrunoTableToolbar,
  BrunoTableToolbarSpacer,
};
export type {
  BrunoTableFilterControlProps,
  BrunoTableGridFilterCommandCapability,
} from "./internal/toolbar-capabilities";

export function BrunoTableServer<
  TViewport,
  const TColumns extends BrunoTableColumns<LiveQueryViewportBaseRow<TViewport>>,
>(
  props: BrunoTableServerProps<LiveQueryViewportBaseRow<TViewport>, TColumns, TViewport>,
): ReactNode {
  const tableId = requireBrunoTableId(props.tableId);
  return <BrunoTableServerInstance key={tableId} props={props} tableId={tableId} />;
}

function BrunoTableServerInstance<TRow, const TColumns extends BrunoTableColumns<TRow>, TViewport>({
  props,
  tableId,
}: Readonly<{
  readonly props: BrunoTableServerProps<TRow, TColumns, TViewport>;
  readonly tableId: string;
}>): ReactNode {
  const compiledColumns = useMemo(() => compileColumns(props.columns), [props.columns]);
  const groupRowsColumn = useMemo(
    () => compileBrunoTableGroupRowsColumn(props.groupRowsColumn),
    [props.groupRowsColumn],
  );
  const [presentationColumnsInstaller] = useState(
    () => new BrunoTableServerPresentationColumnsInstaller(),
  );
  const [rowPipelineAdapter] = useState(
    () =>
      new BrunoTableServerRowPipelineAdapter<TRow>(
        compiledColumns,
        props.quickFilterFields,
        props.initialFilters,
        props.initialOrderBy,
        props.viewportSource.completeRawSelect,
        groupRowsColumn,
      ),
  );
  const [runtime] = useState(() => {
    rowPipelineAdapter.reconcileSource(props.viewportSource);
    const created = new BrunoTableGridRuntime(
      rowPipelineAdapter.getPublication(),
      compiledColumns,
      rowPipelineAdapter.getQueryConfiguration(),
      tableId,
      {
        initialPersistedState: props.initialPersistedState,
        grouping: true,
        groupRowsWidth: groupRowsColumn.width,
      },
    );
    const createdView = created.getView();
    const initialColumnStructure = createdView.getColumnStructureSnapshot();
    rowPipelineAdapter.stageProjection(createdView.getQuerySnapshot(), {
      routeBy: props.routeBy,
      externalFilters: props.externalFilters,
      visibleColumnIds: initialColumnStructure.visibleColumnIds,
      presentationColumns: presentationColumnsInstaller.install(
        compiledColumns,
        initialColumnStructure.allColumns,
      ),
    });
    createdView.publishRowPipeline(rowPipelineAdapter.getPublication());
    if (__BRUNO_TABLE_TEST_DIAGNOSTICS__) {
      recordBrunoTableToolbarLifetime({ tableId, kind: "runtime-create", identity: created });
    }
    return created;
  });
  const [toolbar] = useState(() => new BrunoTableToolbarStore(props.children));
  const runtimeView = runtime.getView();
  const compiledColumnsRef = useRef(compiledColumns);
  const queryInputsRef = useRef<BrunoTableServerQueryInputs>({
    routeBy: props.routeBy,
    externalFilters: props.externalFilters,
    visibleColumnIds: runtimeView.getColumnStructureSnapshot().visibleColumnIds,
    presentationColumns: presentationColumnsInstaller.install(
      compiledColumns,
      runtimeView.getColumnStructureSnapshot().allColumns,
    ),
  });
  const stagingSemanticQueryRef = useRef(false);
  const gridOwnedControls = useMemo(
    () => (
      <>
        <BrunoTableClientGroupBy columns={compiledColumns} runtime={runtimeView} />
        <BrunoTableActiveFilters />
      </>
    ),
    [compiledColumns, runtimeView],
  );
  const quickFilterFields = useMemo(
    () => snapshotBrunoTableQuickFilterFields(props.quickFilterFields),
    [props.quickFilterFields],
  );
  const facetSource = useBrunoTableServerFacetHookSource(props.viewportSource);
  const facetInputsRef = useRef({
    externalFilters: props.externalFilters,
    quickFilterFields,
    routeBy: props.routeBy,
    source: facetSource,
  });
  const [facetRuntime] = useState(
    () =>
      new BrunoTableServerFacetRuntime({
        externalFilters: props.externalFilters,
        quickFilterFields,
        querySnapshot: runtimeView.getQuerySnapshot(),
        routeBy: props.routeBy,
        runtime: runtimeView,
        source: facetSource,
        transportIdentity: props.viewportSource.viewport,
      }),
  );

  // This declaration must precede the reconciliation effect with the same semantic dependency
  // superset so React stages the query before synchronous column/runtime publications can fire.
  useLayoutEffect(() => {
    stagingSemanticQueryRef.current = true;
  }, [
    compiledColumns,
    props.externalFilters,
    props.quickFilterFields,
    props.routeBy,
    props.viewportSource.completeRawSelect,
    props.viewportSource.viewport,
    facetSource,
  ]);

  useLayoutEffect(() => {
    const unsubscribe = rowPipelineAdapter.subscribePublication(() => {
      runtimeView.publishRowPipeline(rowPipelineAdapter.getPublication());
    });
    return unsubscribe;
  }, [rowPipelineAdapter, runtimeView]);

  useLayoutEffect(() => {
    rowPipelineAdapter.reconcileSource(props.viewportSource);
  }, [props.viewportSource, rowPipelineAdapter]);

  useLayoutEffect(() => {
    compiledColumnsRef.current = compiledColumns;
    stageBrunoTableServerSemanticQuery(stagingSemanticQueryRef, () => {
      const queryConfiguration = rowPipelineAdapter.reconcileColumns(
        compiledColumns,
        props.quickFilterFields,
        groupRowsColumn,
      );
      runtime.reconcile(
        rowPipelineAdapter.getPublication(),
        compiledColumns,
        queryConfiguration,
        groupRowsColumn.width,
      );
    });
    const queryInputs = Object.freeze({
      routeBy: props.routeBy,
      externalFilters: props.externalFilters,
      visibleColumnIds: runtimeView.getColumnStructureSnapshot().visibleColumnIds,
      presentationColumns: presentationColumnsInstaller.install(
        compiledColumns,
        runtimeView.getColumnStructureSnapshot().allColumns,
      ),
    });
    queryInputsRef.current = queryInputs;
    facetInputsRef.current = {
      externalFilters: props.externalFilters,
      quickFilterFields,
      routeBy: props.routeBy,
      source: facetSource,
    };
    rowPipelineAdapter.replace(
      props.viewportSource.viewport,
      runtimeView.getQuerySnapshot(),
      queryInputs,
      true,
    );
    facetRuntime.reconcile({
      ...facetInputsRef.current,
      querySnapshot: runtimeView.getQuerySnapshot(),
      runtime: runtimeView,
      transportIdentity: props.viewportSource.viewport,
    });
  }, [
    compiledColumns,
    groupRowsColumn,
    facetSource,
    facetRuntime,
    props.externalFilters,
    props.quickFilterFields,
    props.routeBy,
    props.viewportSource.completeRawSelect,
    props.viewportSource.viewport,
    quickFilterFields,
    rowPipelineAdapter,
    presentationColumnsInstaller,
    runtime,
    runtimeView,
  ]);

  useLayoutEffect(() => {
    const replace = (resetWhenInputsChange: boolean) => {
      if (stagingSemanticQueryRef.current) return;
      const query = runtimeView.getQuerySnapshot();
      const queryInputs = Object.freeze({
        ...queryInputsRef.current,
        visibleColumnIds: runtimeView.getColumnStructureSnapshot().visibleColumnIds,
        presentationColumns: presentationColumnsInstaller.install(
          compiledColumnsRef.current,
          runtimeView.getColumnStructureSnapshot().allColumns,
        ),
      });
      queryInputsRef.current = queryInputs;
      rowPipelineAdapter.replace(
        props.viewportSource.viewport,
        query,
        queryInputs,
        resetWhenInputsChange,
      );
      facetRuntime.reconcile({
        ...facetInputsRef.current,
        querySnapshot: query,
        runtime: runtimeView,
        transportIdentity: props.viewportSource.viewport,
      });
    };
    const unsubscribeQuery = runtimeView.subscribeQuery(() => replace(false));
    const unsubscribeColumnStructure = runtimeView.subscribeColumnStructure(() => replace(true));
    return () => {
      unsubscribeQuery();
      unsubscribeColumnStructure();
      rowPipelineAdapter.release();
    };
  }, [
    facetRuntime,
    presentationColumnsInstaller,
    props.viewportSource.viewport,
    rowPipelineAdapter,
    runtimeView,
  ]);

  useLayoutEffect(() => {
    const notify = props.onPersistChange;
    runtime.setOnPersistChange(
      notify === undefined
        ? undefined
        : (state) => notify(state as BrunoTablePersistedState<TRow, TColumns, true>),
    );
  }, [props.onPersistChange, runtime]);

  useLayoutEffect(() => toolbar.publish(props.children), [props.children, toolbar]);

  useLayoutEffect(
    () =>
      __BRUNO_TABLE_DEVELOPMENT__
        ? registerBrunoTableIdentity(tableId, compiledColumns)
        : undefined,
    [compiledColumns, tableId],
  );

  return (
    <BrunoTableServerFacetProvider runtime={facetRuntime}>
      <BrunoTableClientFilterProvider runtime={runtimeView}>
        <BrunoTableToolbarProvider
          columns={compiledColumns}
          resultRows={rowPipelineAdapter}
          runtime={runtimeView}
          tableId={tableId}
        >
          <BrunoTableView
            runtime={runtimeView}
            tableId={tableId}
            compiledColumns={compiledColumns}
            toolbar={toolbar}
            rowPipeline={BrunoTableServerRowPipeline}
            rowPipelineAdapter={rowPipelineAdapter}
            renderColumnFilter={renderBrunoTableServerColumnFilter}
            enableActiveCellCopy
            gridOwnedControls={gridOwnedControls}
          />
        </BrunoTableToolbarProvider>
      </BrunoTableClientFilterProvider>
    </BrunoTableServerFacetProvider>
  );
}

function stageBrunoTableServerSemanticQuery(
  staging: { current: boolean },
  reconcile: () => void,
): void {
  staging.current = true;
  try {
    reconcile();
  } finally {
    staging.current = false;
  }
}

export class BrunoTableServerPresentationColumnsInstaller {
  private sourceColumns: readonly CompiledColumn[] | undefined;
  private widths: readonly (number | undefined)[] | undefined;
  private installed: readonly CompiledColumn[] | undefined;

  public install(
    columns: readonly CompiledColumn[],
    layoutColumns: readonly CompiledColumn[],
  ): readonly CompiledColumn[] {
    const layoutById = new Map(layoutColumns.map((column) => [column.columnId, column]));
    const widths = columns.map((column) => layoutById.get(column.columnId)?.semantics.width);
    if (
      this.sourceColumns === columns &&
      this.widths?.length === widths.length &&
      widths.every((width, index) => Object.is(width, this.widths?.[index]))
    ) {
      return this.installed!;
    }
    let changed = false;
    const installed = columns.map((column, index) => {
      const width = widths[index];
      if (width === undefined || width === column.semantics.width) return column;
      changed = true;
      return Object.freeze({
        ...column,
        semantics: Object.freeze({ ...column.semantics, width }),
      });
    });
    this.sourceColumns = columns;
    this.widths = Object.freeze(widths);
    this.installed = changed ? Object.freeze(installed) : columns;
    return this.installed;
  }
}

function requireBrunoTableId(tableId: unknown): string {
  if (typeof tableId !== "string" || tableId.trim().length === 0) {
    throw new TypeError("BrunoTable tableId must be a non-empty string.");
  }
  return tableId;
}
