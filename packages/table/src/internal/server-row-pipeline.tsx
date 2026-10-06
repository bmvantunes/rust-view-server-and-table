import { memo, useMemo, useSyncExternalStore } from "react";

import type { NamedExoticComponent, ReactElement } from "react";
import type { BrunoTableRowPipelineProps } from "./bruno-table-view";
import type {
  BrunoTableQueryNavigationMode,
  BrunoTableRowPipelineRuntimeView,
} from "./grid-runtime";

export type BrunoTableServerRowPipelineAdapterView = Readonly<{
  readonly getStructureSnapshot: () => Readonly<{
    readonly totalRows: number;
    readonly getRowId: (index: number) => string | undefined;
    readonly findRowIndex: (rowId: string) => number | undefined;
    readonly generation: number;
    readonly navigationMode: BrunoTableQueryNavigationMode;
    readonly loading: boolean;
  }>;
  readonly subscribeStructure: (listener: () => void) => () => void;
  readonly getMetadataSnapshot: () => Readonly<{
    readonly totalRows: number;
    readonly generation: number;
    readonly navigationMode: BrunoTableQueryNavigationMode;
    readonly loading: boolean;
  }>;
  readonly subscribeMetadata: (listener: () => void) => () => void;
  readonly setRequiredRange: (start: number, end: number) => void;
}>;

export const BrunoTableServerRowPipeline: NamedExoticComponent<
  BrunoTableRowPipelineProps<
    BrunoTableRowPipelineRuntimeView,
    BrunoTableServerRowPipelineAdapterView
  >
> = memo(function BrunoTableServerRowPipeline({
  runtime,
  columns,
  rowPipelineAdapter,
  children,
}: BrunoTableRowPipelineProps<
  BrunoTableRowPipelineRuntimeView,
  BrunoTableServerRowPipelineAdapterView
>): ReactElement {
  const metadata = useSyncExternalStore(
    rowPipelineAdapter.subscribeMetadata,
    rowPipelineAdapter.getMetadataSnapshot,
    rowPipelineAdapter.getMetadataSnapshot,
  );
  const identitySource = useMemo(
    () =>
      Object.freeze({
        getSnapshot: rowPipelineAdapter.getStructureSnapshot,
        subscribe: rowPipelineAdapter.subscribeStructure,
      }),
    [rowPipelineAdapter],
  );
  const rowSpace = useMemo(() => {
    const identities = identitySource.getSnapshot();
    return Object.freeze({
      totalRows: metadata.totalRows,
      getRowId: identities.getRowId,
      findRowIndex: identities.findRowIndex,
      identitySource,
      setRequiredRange: rowPipelineAdapter.setRequiredRange,
      missingRowIdentityBehavior: "clear-conflicting-active-cell" as const,
    });
  }, [identitySource, metadata, rowPipelineAdapter]);
  return children(
    Object.freeze({
      kind: "rows" as const,
      runtime,
      columns,
      rowSpace,
      queryGeneration: metadata.generation,
      queryNavigationMode: metadata.navigationMode,
      loading: metadata.loading,
    }),
  );
});
