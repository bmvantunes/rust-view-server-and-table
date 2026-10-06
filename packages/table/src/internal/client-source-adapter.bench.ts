import { afterAll, beforeAll, bench, describe, expect, vi } from "vitest";

import { compileColumns } from "./compile-columns";
import {
  BrunoTableClientRowPipelineAdapter,
  type BrunoTableClientReconciliationEvent,
  installBrunoTableClientReconciliationListener,
} from "./client-source-adapter";

type Row = Readonly<{ id: string; name: string }>;

const rowCount = 1_000_000;
const changedIndex = Math.floor(rowCount / 2);
let fixtures:
  | Readonly<{
      baseRows: readonly Row[];
      replacementRows: readonly Row[];
    }>
  | undefined;
const getFixtures = () => {
  fixtures ??= (() => {
    const baseRows = Array.from({ length: rowCount }, (_unused, index) => ({
      id: `row-${String(index)}`,
      name: `Name ${String(index)}`,
    })) satisfies readonly Row[];
    return Object.freeze({
      baseRows,
      replacementRows: baseRows.with(changedIndex, {
        id: `row-${String(changedIndex)}`,
        name: "Changed",
      }),
    });
  })();
  return fixtures;
};
const columns = compileColumns([
  {
    columnId: "COL_ID_NAME",
    field: "name",
    headerName: "Name",
    valueType: "text",
  },
]);
const getRowId = vi.fn((row: Row) => row.id);
const source = (rows: readonly Row[], version: number) => ({
  rows,
  totalRows: rows.length,
  version,
  status: "ready" as const,
});
let adapter: BrunoTableClientRowPipelineAdapter<Row> | undefined;
const getAdapter = () => {
  adapter ??= new BrunoTableClientRowPipelineAdapter(
    source(getFixtures().baseRows, 1),
    getRowId,
    columns,
    undefined,
    [{ columnId: "COL_ID_NAME", direction: "asc" }],
  );
  return adapter;
};
let publishReplacement = false;
let version = 1;
let patchEvent: BrunoTableClientReconciliationEvent | undefined;
let capturePatchEvent = false;
let patchRuns = 0;
const restoreInstrumentation = installBrunoTableClientReconciliationListener((event) => {
  if (capturePatchEvent) patchEvent = event;
});

describe("BrunoTable Client Source reconciliation", () => {
  beforeAll(() => {
    getFixtures();
  });

  bench(
    "constructs one million resident rows",
    () => {
      const { baseRows } = getFixtures();
      const initial = new BrunoTableClientRowPipelineAdapter(
        source(baseRows, 1),
        (row: Row) => row.id,
        columns,
        undefined,
        [{ columnId: "COL_ID_NAME", direction: "asc" }],
      );
      if (initial.getPublication().rowSpace?.loadedRows !== rowCount) {
        throw new Error("BrunoTable benchmark did not construct the complete resident row space.");
      }
    },
    { iterations: 1, time: 0, warmupIterations: 0, warmupTime: 0 },
  );

  bench(
    "admits one million resident rows after loading",
    () => {
      const { baseRows } = getFixtures();
      const initial = new BrunoTableClientRowPipelineAdapter(
        {
          rows: baseRows,
          totalRows: rowCount,
          version: 1,
          status: "loading",
        },
        (row: Row) => row.id,
        columns,
        undefined,
        [{ columnId: "COL_ID_NAME", direction: "asc" }],
      );
      const publication = initial.publish(source(baseRows, 2));
      if (publication.rowSpace?.loadedRows !== rowCount) {
        throw new Error("BrunoTable benchmark did not admit the first complete live row space.");
      }
    },
    { iterations: 1, time: 0, warmupIterations: 0, warmupTime: 0 },
  );

  bench("patches one replacement among one million resident rows", () => {
    const { baseRows, replacementRows } = getFixtures();
    const patchAdapter = getAdapter();
    publishReplacement = !publishReplacement;
    version += 1;
    getRowId.mockClear();
    capturePatchEvent = true;
    try {
      patchAdapter.publish(source(publishReplacement ? replacementRows : baseRows, version));
      patchRuns += 1;
    } finally {
      capturePatchEvent = false;
    }
  });

  afterAll(() => {
    restoreInstrumentation();
    if (patchRuns === 0) return;
    expect(getRowId).toHaveBeenCalledOnce();
    expect(patchEvent).toEqual({
      residentRows: rowCount,
      changedRows: 1,
      resolvedRowIds: 1,
      identityPatches: 1,
      rebuiltSourceSequence: false,
      rebuiltIdentityIndex: false,
    });
  });
});
