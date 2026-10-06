import { BrunoTableSelectColumn, type BrunoTableColumns } from "@bruno/table";

type Row = { side: "Buy" | "Sell" | null };
const selectColumns = [
  BrunoTableSelectColumn({
    columnId: "COL_ID_SIDE",
    field: "side",
    headerName: "Side",
    options: ["Buy", "Sell"],
    groupBy: true,
    groupKeyValueFormatter: ({ value, columnId }) => {
      const exact: "Buy" | "Sell" | null = value;
      const identity: "COL_ID_SIDE" = columnId;
      // @ts-expect-error Exact Select Group Keys never become numbers or any.
      const invalid: number = value;
      void identity;
      void invalid;
      return exact ?? "No side";
    },
  }),
] as const satisfies BrunoTableColumns<Row>;
void selectColumns;

const preset = BrunoTableSelectColumn.withDefaults({
  headerName: "Side",
  options: ["Buy", "Sell"],
});
const presetColumns = [
  preset({
    columnId: "COL_ID_SIDE",
    field: "side",
    groupBy: true,
    groupKeyValueFormatter: ({ value }) => value ?? "No side",
  }),
] satisfies BrunoTableColumns<Row>;
void presetColumns;
const invalidPreset = [
  preset({
    columnId: "COL_ID_SIDE",
    // @ts-expect-error Presets retain the same unsupported aggregate capability.
    field: "side",
    aggFunc: "min",
  }),
] satisfies BrunoTableColumns<Row>;
void invalidPreset;

const rejectedcountDistinct = [
  BrunoTableSelectColumn({
    columnId: "COL_ID_SIDE",
    // @ts-expect-error Select does not declare aggregate result semantics.
    field: "side",
    headerName: "Side",
    options: ["Buy", "Sell"],
    aggFunc: "countDistinct",
  }),
] satisfies BrunoTableColumns<Row>;
void rejectedcountDistinct;

const rejectedmin = [
  BrunoTableSelectColumn({
    columnId: "COL_ID_SIDE",
    // @ts-expect-error Select does not declare aggregate result semantics.
    field: "side",
    headerName: "Side",
    options: ["Buy", "Sell"],
    aggFunc: "min",
  }),
] satisfies BrunoTableColumns<Row>;
void rejectedmin;

const rejectedmax = [
  BrunoTableSelectColumn({
    columnId: "COL_ID_SIDE",
    // @ts-expect-error Select does not declare aggregate result semantics.
    field: "side",
    headerName: "Side",
    options: ["Buy", "Sell"],
    aggFunc: "max",
  }),
] satisfies BrunoTableColumns<Row>;
void rejectedmax;

const rejectedsum = [
  BrunoTableSelectColumn({
    columnId: "COL_ID_SIDE",
    // @ts-expect-error Select does not declare aggregate result semantics.
    field: "side",
    headerName: "Side",
    options: ["Buy", "Sell"],
    aggFunc: "sum",
  }),
] satisfies BrunoTableColumns<Row>;
void rejectedsum;

const rejectedavg = [
  BrunoTableSelectColumn({
    columnId: "COL_ID_SIDE",
    // @ts-expect-error Select does not declare aggregate result semantics.
    field: "side",
    headerName: "Side",
    options: ["Buy", "Sell"],
    aggFunc: "avg",
  }),
] satisfies BrunoTableColumns<Row>;
void rejectedavg;
