import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { BrunoTableResultRowCount, BrunoTableToolbar } from "./bruno-table-client";
import {
  BrunoTableServer,
  BrunoTableServerPresentationColumnsInstaller,
} from "./bruno-table-server";
import { compileColumns } from "./internal/compile-columns";
import type { BrunoTableColumns } from "./public-types";

type Row = Readonly<{ readonly desk: string; readonly price: number; readonly symbol: string }>;

const columns = [
  {
    columnId: "COL_ID_DESK",
    field: "desk",
    headerName: "Desk",
    valueType: "text",
    groupBy: true,
  },
  {
    columnId: "COL_ID_PRICE",
    field: "price",
    headerName: "Price",
    valueType: "number",
    aggFunc: "max",
  },
  {
    columnId: "COL_ID_SYMBOL",
    field: "symbol",
    headerName: "Symbol",
    valueType: "text",
  },
] as const satisfies BrunoTableColumns<Row>;

type ServerRenderTestProps = Readonly<{
  tableId: string;
  columns: readonly unknown[];
  initialOrderBy: readonly unknown[];
  initialPersistedState: unknown;
  viewportSource: unknown;
  children?: ReactNode;
}>;

const ServerRenderTestTable = BrunoTableServer as unknown as (
  props: ServerRenderTestProps,
) => ReactNode;

describe("BrunoTableServer server rendering", () => {
  it("retains installed presentation identity for repeated equal durable widths", () => {
    const compiled = compileColumns(columns);
    const layout = compiled.map((column) =>
      column.columnId === "COL_ID_PRICE"
        ? Object.freeze({
            ...column,
            semantics: Object.freeze({ ...column.semantics, width: 277 }),
          })
        : column,
    );
    const installer = new BrunoTableServerPresentationColumnsInstaller();
    const first = installer.install(compiled, layout);

    expect(installer.install(compiled, layout)).toBe(first);
    expect(first.find(({ columnId }) => columnId === "COL_ID_PRICE")?.semantics.width).toBe(277);

    const revised = compileColumns([
      columns[0],
      { ...columns[1], headerName: "Revised price" },
      columns[2],
    ]);
    const revisedInstalled = installer.install(revised, layout);
    expect(revisedInstalled).not.toBe(first);
    expect(
      revisedInstalled.find(({ columnId }) => columnId === "COL_ID_PRICE")?.semantics.width,
    ).toBe(277);
  });

  it("installs restored grouped presentation before rendering without replacing the source", () => {
    const replace = vi.fn(() => {
      throw new Error("Server rendering must not start a viewport generation.");
    });
    const tableId = "TABLE_ID_SERVER_SSR_GROUPING";
    const markup = renderToStaticMarkup(
      <ServerRenderTestTable
        tableId={tableId}
        columns={columns}
        initialOrderBy={[{ columnId: "COL_ID_DESK", direction: "asc" }]}
        initialPersistedState={{
          version: 1,
          tableId,
          filters: [],
          orderBy: [{ columnId: "COL_ID_DESK", direction: "asc" }],
          groupBy: ["COL_ID_DESK"],
          groupOrderBy: [{ columnId: "COL_ID_DESK", direction: "asc" }],
          columnOrder: ["COL_ID_SYMBOL", "COL_ID_PRICE", "COL_ID_DESK"],
          columnVisibility: {},
          columnWidths: { COL_ID_DESK: 211, COL_ID_PRICE: 277 },
          columnPinning: { start: [], end: [] },
        }}
        viewportSource={{
          viewport: {
            semanticKey: (query: unknown) => query,
            replace,
          },
          useWholeResult: () => ({
            rows: [],
            totalRows: 0,
            version: 1,
            status: "ready" as const,
          }),
          completeRawSelect: ["desk", "price", "symbol"],
          totalRows: 1_000_000,
          version: 1,
          status: "ready" as const,
        }}
      >
        <BrunoTableToolbar>
          <BrunoTableResultRowCount />
        </BrunoTableToolbar>
      </ServerRenderTestTable>,
    );

    expect(replace).not.toHaveBeenCalled();
    expect(markup).toContain('aria-label="Loading Desk"');
    expect(markup).toContain('aria-label="Loading Rows"');
    expect(markup).toContain('aria-label="Loading Price"');
    expect(markup).not.toContain('aria-label="Loading Symbol"');
    expect(markup.match(/aria-label="Loading Desk"/gu)).toHaveLength(18);
    expect(markup).toContain('aria-rowcount="-1"');
    expect(markup).not.toContain('aria-rowcount="1000001"');
    expect(markup).toContain('aria-label="Result rows"');
    expect(markup).toContain(">0 result rows</output>");
    expect(markup).toContain("--bruno-table-column-width-_43_4f_4c_5f_49_44_5f_44_45_53_4b, 211px");
    expect(markup).toContain(
      "--bruno-table-column-width-_43_4f_4c_5f_49_44_5f_50_52_49_43_45, 277px",
    );
  });
});
