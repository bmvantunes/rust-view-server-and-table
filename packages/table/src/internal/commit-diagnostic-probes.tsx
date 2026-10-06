import { Fragment, useLayoutEffect } from "react";

import type { ReactElement, RefCallback } from "react";

import {
  recordBrunoTableClientCellRender,
  recordBrunoTableClientGridSurfaceRender,
  recordBrunoTableClientHeaderRender,
  recordBrunoTableClientRowRender,
  recordBrunoTableClientSortPanelRender,
  recordBrunoTableClientViewRender,
} from "./render-instrumentation";
import { BRUNO_TABLE_COMMIT_PROBE_DIAGNOSTIC_SENTINEL } from "./test-diagnostic-build-contract";
import { recordBrunoTableRowSelectionRender } from "./row-selection";

export function BrunoTableViewCommitDiagnosticProbe({
  commitEvidence,
  tableId,
}: {
  readonly commitEvidence: unknown;
  readonly tableId: string;
}): ReactElement {
  void commitEvidence;
  useLayoutEffect(() => recordBrunoTableClientViewRender(tableId));
  return <Fragment key={BRUNO_TABLE_COMMIT_PROBE_DIAGNOSTIC_SENTINEL} />;
}

export function BrunoTableGridSurfaceCommitDiagnosticProbe({
  commitEvidence,
  tableId,
}: {
  readonly commitEvidence: unknown;
  readonly tableId: string;
}): ReactElement {
  void commitEvidence;
  useLayoutEffect(() => recordBrunoTableClientGridSurfaceRender(tableId));
  return <Fragment key={BRUNO_TABLE_COMMIT_PROBE_DIAGNOSTIC_SENTINEL} />;
}

export function BrunoTableHeaderCommitDiagnosticProbe({
  commitEvidence,
  tableId,
}: {
  readonly commitEvidence: unknown;
  readonly tableId: string;
}): ReactElement {
  void commitEvidence;
  useLayoutEffect(() => recordBrunoTableClientHeaderRender(tableId));
  return <Fragment key={BRUNO_TABLE_COMMIT_PROBE_DIAGNOSTIC_SENTINEL} />;
}

export function BrunoTableSortPanelCommitDiagnosticProbe({
  commitEvidence,
  tableId,
}: {
  readonly commitEvidence: unknown;
  readonly tableId: string;
}): ReactElement {
  void commitEvidence;
  useLayoutEffect(() => recordBrunoTableClientSortPanelRender(tableId));
  return <Fragment key={BRUNO_TABLE_COMMIT_PROBE_DIAGNOSTIC_SENTINEL} />;
}

export function BrunoTableRowCommitDiagnosticProbe({
  commitEvidence,
  rowId,
  tableId,
}: {
  readonly commitEvidence: unknown;
  readonly rowId: string;
  readonly tableId: string;
}): ReactElement {
  void commitEvidence;
  useLayoutEffect(() => recordBrunoTableClientRowRender(tableId, rowId));
  return <Fragment key={BRUNO_TABLE_COMMIT_PROBE_DIAGNOSTIC_SENTINEL} />;
}

export function createBrunoTableCellCommitDiagnosticRef({
  columnId,
  commitEvidence,
  rowId,
  tableId,
}: {
  readonly columnId: string;
  readonly commitEvidence: unknown;
  readonly rowId: string;
  readonly tableId: string | undefined;
}): RefCallback<HTMLTableCellElement> {
  void commitEvidence;
  return (element) => {
    if (element !== null) recordBrunoTableClientCellRender(rowId, columnId, tableId);
  };
}

export function BrunoTableRowSelectionCommitDiagnosticProbe({
  commitEvidence,
  rowId,
  tableId,
}: {
  readonly commitEvidence: unknown;
  readonly rowId?: string;
  readonly tableId: string;
}): ReactElement {
  void commitEvidence;
  useLayoutEffect(() =>
    recordBrunoTableRowSelectionRender(tableId, rowId === undefined ? "header" : "row", rowId),
  );
  return <Fragment key={BRUNO_TABLE_COMMIT_PROBE_DIAGNOSTIC_SENTINEL} />;
}
