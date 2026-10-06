import { describe, expect, it, vi } from "vitest";

import { BrunoTableSelectColumn } from "../column-helpers";
import type { BrunoTableColumns } from "../public-types";

import { compileColumns } from "./compile-columns";
import { registerBrunoTableIdentity } from "./table-identity-registry";

const columns = compileColumns([
  {
    columnId: "COL_ID_NAME",
    field: "name",
    headerName: "Name",
    valueType: "text",
  },
]);

describe("BrunoTable Table Identity registry", () => {
  it("diagnoses only incompatible concurrent schema reuse and unregisters idempotently", () => {
    const report = vi.fn();
    const disposeFirst = registerBrunoTableIdentity("TABLE_ID_SHARED", columns, report);
    const disposeCompatible = registerBrunoTableIdentity("TABLE_ID_SHARED", columns, report);
    expect(report).not.toHaveBeenCalled();

    const incompatibleColumns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "number",
      },
    ]);
    const disposeIncompatible = registerBrunoTableIdentity(
      "TABLE_ID_SHARED",
      incompatibleColumns,
      report,
    );
    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(
      expect.stringContaining('simultaneous use of tableId "TABLE_ID_SHARED"'),
    );

    disposeIncompatible();
    disposeCompatible();
    disposeFirst();
    disposeFirst();

    const disposeAfterUnmount = registerBrunoTableIdentity(
      "TABLE_ID_SHARED",
      incompatibleColumns,
      report,
    );
    expect(report).toHaveBeenCalledOnce();
    disposeAfterUnmount();
  });

  it("uses stable computed getter identity to diagnose incompatible computed schemas", () => {
    const report = vi.fn();
    const double = ({ row }: { readonly row: { readonly score: number } }) => row.score * 2;
    const firstColumns = compileColumns([
      {
        columnId: "COL_ID_COMPUTED",
        fields: ["score"],
        headerName: "Computed",
        valueGetter: double,
        valueType: "number",
      },
    ]);
    const compatibleColumns = compileColumns([
      {
        columnId: "COL_ID_COMPUTED",
        fields: ["score"],
        headerName: "Computed again",
        valueGetter: double,
        valueType: "number",
      },
    ]);
    const incompatibleColumns = compileColumns([
      {
        columnId: "COL_ID_COMPUTED",
        fields: ["score"],
        headerName: "Computed differently",
        valueGetter: ({ row }: { readonly row: { readonly score: number } }) => row.score * 3,
        valueType: "number",
      },
    ]);
    const disposeFirst = registerBrunoTableIdentity("TABLE_ID_COMPUTED", firstColumns, report);
    const disposeCompatible = registerBrunoTableIdentity(
      "TABLE_ID_COMPUTED",
      compatibleColumns,
      report,
    );
    expect(report).not.toHaveBeenCalled();
    const disposeIncompatible = registerBrunoTableIdentity(
      "TABLE_ID_COMPUTED",
      incompatibleColumns,
      report,
    );
    expect(report).toHaveBeenCalledOnce();

    disposeIncompatible();
    disposeCompatible();
    disposeFirst();
  });

  it("diagnoses incompatible custom value semantics", () => {
    const report = vi.fn();
    const valueType = {
      codecId: "example/code",
      codecVersion: 1,
      filterFamily: "equality" as const,
      editorFamily: "text" as const,
      cellAlign: "start" as const,
      editorLayout: "inline" as const,
      defaultWidth: 120,
      decodeRuntime: (input: unknown) =>
        typeof input === "string"
          ? ({ _tag: "Success", value: input } as const)
          : ({ _tag: "Failure", message: "Expected text." } as const),
      equivalent: (left: string, right: string) => left === right,
      compare: (left: string, right: string) => (left === right ? 0 : left < right ? -1 : 1),
      formatCanonicalText: (value: string) => value,
      parseCanonicalText: (text: string) => ({ _tag: "Success", value: text }) as const,
      formatDisplay: (value: string) => value,
      encodePersisted: (value: string) => value,
      decodePersisted: (input: unknown) =>
        typeof input === "string"
          ? ({ _tag: "Success", value: input } as const)
          : ({ _tag: "Failure", message: "Expected text." } as const),
    };
    const compile = (selection: typeof valueType) =>
      compileColumns([
        {
          columnId: "COL_ID_CODE",
          field: "code",
          headerName: "Code",
          valueType: selection,
        },
      ]);
    const disposeFirst = registerBrunoTableIdentity(
      "TABLE_ID_CUSTOM_SEMANTICS",
      compile(valueType),
      report,
    );
    const disposeCompatible = registerBrunoTableIdentity(
      "TABLE_ID_CUSTOM_SEMANTICS",
      compile(valueType),
      report,
    );
    expect(report).not.toHaveBeenCalled();
    const disposeIncompatible = registerBrunoTableIdentity(
      "TABLE_ID_CUSTOM_SEMANTICS",
      compile({
        ...valueType,
        equivalent: (left, right) => left.toLowerCase() === right.toLowerCase(),
      }),
      report,
    );
    expect(report).toHaveBeenCalledOnce();

    disposeIncompatible();
    disposeCompatible();
    disposeFirst();
  });

  it("fingerprints generated Select semantics by their exact option domain", () => {
    type SelectRow = { readonly status: "active" | "paused" };
    const compile = (options: readonly ["active", ...("active" | "paused")[]]) => {
      const definitions = [
        BrunoTableSelectColumn({
          columnId: "COL_ID_STATUS",
          field: "status",
          headerName: "Status",
          options,
        }),
      ] satisfies BrunoTableColumns<SelectRow>;
      return compileColumns(definitions);
    };
    const report = vi.fn();
    const disposeFirst = registerBrunoTableIdentity(
      "TABLE_ID_SELECT_SEMANTICS",
      compile(["active", "paused"]),
      report,
    );
    const disposeCompatible = registerBrunoTableIdentity(
      "TABLE_ID_SELECT_SEMANTICS",
      compile(["active", "paused"]),
      report,
    );
    expect(report).not.toHaveBeenCalled();

    const disposeIncompatible = registerBrunoTableIdentity(
      "TABLE_ID_SELECT_SEMANTICS",
      compile(["active"]),
      report,
    );
    expect(report).toHaveBeenCalledOnce();

    disposeIncompatible();
    disposeCompatible();
    disposeFirst();
  });
});
