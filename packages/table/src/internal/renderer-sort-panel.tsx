import { Button } from "@bruno/shadcn/button";
import { NativeSelect, NativeSelectOption } from "@bruno/shadcn/native-select";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@bruno/shadcn/popover";
import { memo, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import type { NamedExoticComponent, ReactElement } from "react";

import type { CompiledColumn } from "./compile-columns";
import type { BrunoTableRuntimeView } from "./grid-runtime";
import { BrunoTableSortPanelCommitDiagnosticProbe } from "./commit-diagnostic-probes";

type BrunoTableSortPanelProps = Readonly<{
  readonly columns: readonly CompiledColumn[];
  readonly reserveEndSpace: boolean;
  readonly runtime: BrunoTableRuntimeView;
  readonly tableId: string;
}>;

const BrunoTableSortPanel: NamedExoticComponent<BrunoTableSortPanelProps> = memo(
  function BrunoTableSortPanel({
    columns,
    reserveEndSpace,
    runtime,
    tableId,
  }: BrunoTableSortPanelProps): ReactElement | null {
    const orderBy = useSyncExternalStore(
      runtime.subscribeSorting,
      runtime.getSortingSnapshot,
      runtime.getSortingSnapshot,
    );
    const groupBy = useSyncExternalStore(
      runtime.subscribeGroupBy,
      runtime.getGroupBySnapshot,
      runtime.getGroupBySnapshot,
    );
    const columnLayout = useSyncExternalStore(
      runtime.subscribeColumnStructure,
      runtime.getColumnStructureSnapshot,
      runtime.getColumnStructureSnapshot,
    );
    const rowsHeaderName = useSyncExternalStore(
      runtime.subscribeInstalledRowsPresentation,
      runtime.getInstalledRowsHeaderNameSnapshot,
      runtime.getInstalledRowsHeaderNameSnapshot,
    );
    const [open, setOpen] = useState(false);
    const sortPanelRootRef = useRef<HTMLDivElement>(null);
    const sortPanelControlRefs = useRef(new Map<string, HTMLButtonElement>());
    const pendingSortPanelFocus = useRef<
      | Readonly<{
          readonly focusKey: string;
          readonly initiator: HTMLButtonElement;
        }>
      | undefined
    >(undefined);
    useLayoutEffect(() => {
      const focusRequest = pendingSortPanelFocus.current;
      if (focusRequest === undefined) return;
      let followupFrameId: number | undefined;
      const frameId = requestAnimationFrame(() => {
        followupFrameId = requestAnimationFrame(() => {
          if (pendingSortPanelFocus.current !== focusRequest) return;
          const activeElement = document.activeElement;
          const shouldRecoverFocus =
            !focusRequest.initiator.isConnected &&
            (activeElement === null ||
              activeElement === document.body ||
              activeElement === sortPanelRootRef.current);
          pendingSortPanelFocus.current = undefined;
          if (activeElement === focusRequest.initiator || !shouldRecoverFocus) return;
          const control = sortPanelControlRefs.current.get(focusRequest.focusKey);
          if (control === undefined) return;
          control.focus({ preventScroll: true });
        });
      });
      return () => {
        cancelAnimationFrame(frameId);
        if (followupFrameId !== undefined) cancelAnimationFrame(followupFrameId);
      };
    });
    const visible = new Set(columnLayout.visibleColumnIds);
    const activeGroups = new Set(groupBy);
    const sortableColumns = columns.filter(
      (column) =>
        (groupBy.length === 0 && column.enableSorting !== false) ||
        (groupBy.length > 0 &&
          (activeGroups.has(column.columnId) ||
            (column.kind === "field" &&
              column.aggFunc !== undefined &&
              visible.has(column.columnId)))),
    );
    if (sortableColumns.length === 0) return null;
    const activeIds = new Set(orderBy.map((sort) => sort.columnId));
    const eligibleColumns = [
      ...sortableColumns.filter((column) => !activeIds.has(column.columnId)),
      ...(groupBy.length > 0 && !activeIds.has("COL_ID_BRUNO_TABLE_ROWS")
        ? [{ columnId: "COL_ID_BRUNO_TABLE_ROWS", headerName: rowsHeaderName }]
        : []),
    ];
    const headerName = (columnId: string): string =>
      columnId === "COL_ID_BRUNO_TABLE_ROWS"
        ? rowsHeaderName
        : (sortableColumns.find((column) => column.columnId === columnId)?.headerName ?? columnId);
    const directionLabel = (direction: "asc" | "desc"): "ascending" | "descending" =>
      direction === "asc" ? "ascending" : "descending";

    return (
      <div
        aria-label="Sorting controls"
        className={reserveEndSpace ? "flex items-center py-1 pe-28" : "flex items-center py-1"}
        role="region"
      >
        {__BRUNO_TABLE_TEST_DIAGNOSTICS__ ? (
          <BrunoTableSortPanelCommitDiagnosticProbe commitEvidence={orderBy} tableId={tableId} />
        ) : null}
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={
              <Button
                aria-label={`Sort rows, ${String(orderBy.length)} active`}
                size="sm"
                type="button"
                variant="outline"
              />
            }
          >
            Sort
            <span aria-hidden="true">{String(orderBy.length)}</span>
          </PopoverTrigger>
          {open ? (
            <PopoverContent
              ref={sortPanelRootRef}
              align="start"
              aria-label="Sort rows"
              role="dialog"
            >
              <PopoverHeader>
                <PopoverTitle>Sort rows</PopoverTitle>
                <PopoverDescription>
                  Change direction and priority. At least one sort always remains active.
                </PopoverDescription>
              </PopoverHeader>
              <ol aria-label="Active sorts" className="flex flex-col gap-2" role="list">
                {orderBy.map((sort, index) => {
                  const name = headerName(sort.columnId);
                  const direction = directionLabel(sort.direction);
                  return (
                    <li
                      key={sort.columnId}
                      aria-label={`Priority ${String(index + 1)}, ${name}, ${direction}`}
                      className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto_auto] items-center gap-1 rounded-md border border-border p-1.5"
                    >
                      <span className="min-w-0 truncate">
                        <span aria-hidden="true">{String(index + 1)}. </span>
                        {name}
                      </span>
                      <Button
                        ref={(control) => {
                          const focusKey = `direction:${sort.columnId}`;
                          if (control === null) sortPanelControlRefs.current.delete(focusKey);
                          else sortPanelControlRefs.current.set(focusKey, control);
                        }}
                        aria-label={`Toggle ${name} direction, currently ${direction}`}
                        size="xs"
                        type="button"
                        variant="outline"
                        onClick={() =>
                          runtime.dispatchGridCommand({
                            type: "column.sort.toggle",
                            columnId: sort.columnId,
                            multi: true,
                          })
                        }
                      >
                        {sort.direction === "asc" ? "Ascending" : "Descending"}
                      </Button>
                      <Button
                        ref={(control) => {
                          const focusKey = `earlier:${sort.columnId}`;
                          if (control === null) sortPanelControlRefs.current.delete(focusKey);
                          else sortPanelControlRefs.current.set(focusKey, control);
                        }}
                        aria-label={`Move ${name} earlier`}
                        aria-disabled={index === 0}
                        size="icon-xs"
                        type="button"
                        variant="ghost"
                        onClick={(event) => {
                          if (index === 0) return;
                          pendingSortPanelFocus.current = Object.freeze({
                            focusKey: `earlier:${sort.columnId}`,
                            initiator: event.currentTarget,
                          });
                          runtime.dispatchGridCommand({
                            type: "sorting.move",
                            columnId: sort.columnId,
                            targetIndex: index - 1,
                          });
                        }}
                      >
                        <span aria-hidden="true">↑</span>
                      </Button>
                      <Button
                        ref={(control) => {
                          const focusKey = `later:${sort.columnId}`;
                          if (control === null) sortPanelControlRefs.current.delete(focusKey);
                          else sortPanelControlRefs.current.set(focusKey, control);
                        }}
                        aria-label={`Move ${name} later`}
                        aria-disabled={index === orderBy.length - 1}
                        size="icon-xs"
                        type="button"
                        variant="ghost"
                        onClick={(event) => {
                          if (index === orderBy.length - 1) return;
                          pendingSortPanelFocus.current = Object.freeze({
                            focusKey: `later:${sort.columnId}`,
                            initiator: event.currentTarget,
                          });
                          runtime.dispatchGridCommand({
                            type: "sorting.move",
                            columnId: sort.columnId,
                            targetIndex: index + 1,
                          });
                        }}
                      >
                        <span aria-hidden="true">↓</span>
                      </Button>
                      <Button
                        aria-label={`Remove ${name}`}
                        disabled={orderBy.length === 1}
                        size="xs"
                        type="button"
                        variant="ghost"
                        onClick={(event) => {
                          const survivor = orderBy[index + 1] ?? orderBy[index - 1];
                          if (survivor !== undefined) {
                            pendingSortPanelFocus.current = Object.freeze({
                              focusKey: `direction:${survivor.columnId}`,
                              initiator: event.currentTarget,
                            });
                          }
                          runtime.dispatchGridCommand({
                            type: "sorting.remove",
                            columnId: sort.columnId,
                          });
                        }}
                      >
                        Remove
                      </Button>
                    </li>
                  );
                })}
              </ol>
              <div className="flex items-center justify-between gap-2">
                <NativeSelect
                  aria-label="Add sort column"
                  disabled={eligibleColumns.length === 0}
                  size="sm"
                  value=""
                  onChange={(event) => {
                    const columnId = event.currentTarget.value;
                    if (columnId.length === 0) return;
                    runtime.dispatchGridCommand({ type: "sorting.add", columnId });
                  }}
                >
                  <NativeSelectOption value="">Add sort</NativeSelectOption>
                  {eligibleColumns.map((column) => (
                    <NativeSelectOption key={column.columnId} value={column.columnId}>
                      {column.headerName}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <Button
                  aria-label="Reset sorting"
                  size="sm"
                  type="button"
                  variant="outline"
                  onClick={() => runtime.dispatchGridCommand({ type: "sorting.reset" })}
                >
                  Reset
                </Button>
              </div>
            </PopoverContent>
          ) : null}
        </Popover>
      </div>
    );
  },
);

export { BrunoTableSortPanel };
