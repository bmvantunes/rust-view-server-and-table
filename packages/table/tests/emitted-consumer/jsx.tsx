import { Schema } from "effect";
import { ViewServerId, defineViewServerConfig } from "effect-view-server/config";
import { createViewServerReact } from "effect-view-server/react";
import { SourceAdapter } from "effect-view-server/source-adapter";

import {
  BrunoTableClient,
  BrunoTableComputedColumn,
  BrunoTableQuickFilter,
  BrunoTableServer,
  BrunoTableToolbar,
} from "@bruno/table";

import type { BrunoTableClientProps, BrunoTableColumns } from "@bruno/table";

type Row = {
  readonly id: string;
  readonly name: string;
  readonly score: number;
  readonly revision: bigint;
};

const columns = [
  {
    columnId: "COL_ID_NAME",
    field: "name",
    headerName: "Name",
    valueType: "text",
    isEditable: true,
    validate: ({ row, value }) => {
      row.revision satisfies bigint;
      value satisfies string;
      return value.length > 0 ? undefined : "Name is required.";
    },
  },
  BrunoTableComputedColumn({
    columnId: "COL_ID_DOUBLE_SCORE",
    fields: ["score"],
    headerName: "Double score",
    valueType: "number",
    valueGetter: ({ row }) => row.score * 2,
  }),
] satisfies BrunoTableColumns<Row>;

const nonsortableColumns = [
  {
    columnId: "COL_ID_NAME",
    field: "name",
    headerName: "Name",
    valueType: "text",
    enableSorting: false,
  },
  {
    columnId: "COL_ID_SCORE",
    field: "score",
    headerName: "Score",
    valueType: "number",
  },
] satisfies BrunoTableColumns<Row>;

const sortFreeColumns = [
  {
    columnId: "COL_ID_NAME",
    field: "name",
    headerName: "Name",
    valueType: "text",
    enableSorting: false,
  },
] satisfies BrunoTableColumns<Row>;

const clientSource = {
  rows: [] as readonly Row[],
  totalRows: 0,
  version: 1,
  status: "ready" as const,
};

function EmittedForwardedClient(props: BrunoTableClientProps<Row, typeof columns, bigint>) {
  return <BrunoTableClient {...props} />;
}
void EmittedForwardedClient;

const whitespaceIdentityColumns = [
  {
    columnId: "COL_ID_DISPLAY NAME",
    field: "name",
    headerName: "Display name",
    valueType: "text",
  },
] satisfies BrunoTableColumns<Row>;

const invalidWhitespaceIdentityClient = (
  <BrunoTableClient
    tableId="TABLE_ID_EMITTED_JSX_INVALID_WHITESPACE_IDENTITY"
    getRowId={(row) => row.id}
    // @ts-expect-error Emitted Client declarations validate raw identities after tuple inference.
    columns={whitespaceIdentityColumns}
    initialOrderBy={[{ columnId: "COL_ID_DISPLAY NAME", direction: "asc" }]}
    clientSource={clientSource}
  />
);
void invalidWhitespaceIdentityClient;

const validClient = (
  <BrunoTableClient
    tableId="TABLE_ID_EMITTED_JSX_VALID"
    getRowId={(row) => row.id}
    columns={columns}
    initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
    clientSource={clientSource}
    rowSelection
  />
);
void validClient;

const validEmittedEditableClient = (
  <BrunoTableClient
    tableId="TABLE_ID_EMITTED_JSX_EDITABLE"
    columns={columns}
    initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
    clientSource={clientSource}
    getRowId={(row) => row.id}
    editable
    getRowVersion={(row) => row.revision}
    onSaveEdits={(changes) => {
      changes[0].expectedVersion satisfies bigint;
      changes[0].changes[0].after satisfies string;
      return Promise.resolve();
    }}
  />
);
void validEmittedEditableClient;

const emittedEditablePropsWithoutMode = {
  tableId: "TABLE_ID_EMITTED_CONSUMER_OWNED_EDIT_MODE",
  columns,
  initialOrderBy: [{ columnId: "COL_ID_NAME", direction: "asc" }],
  clientSource,
  getRowId: (row: Row) => row.id,
  editable: true,
  getRowVersion: (row: Row) => row.revision,
  onSaveEdits: () => Promise.resolve(),
} as const;
const invalidEmittedControlledEditMode = {
  ...emittedEditablePropsWithoutMode,
  // @ts-expect-error Published declarations keep Edit Mode user-owned.
  editMode: "batch",
} satisfies BrunoTableClientProps<Row, typeof columns, bigint>;
const invalidEmittedInitialEditMode = {
  ...emittedEditablePropsWithoutMode,
  // @ts-expect-error Published declarations reject an initial Edit Mode.
  initialEditMode: "batch",
} satisfies BrunoTableClientProps<Row, typeof columns, bigint>;
const invalidEmittedEditModeCallback = {
  ...emittedEditablePropsWithoutMode,
  // @ts-expect-error Published declarations reject controlled Edit Mode callbacks.
  onEditModeChange: () => undefined,
} satisfies BrunoTableClientProps<Row, typeof columns, bigint>;
void [
  invalidEmittedControlledEditMode,
  invalidEmittedInitialEditMode,
  invalidEmittedEditModeCallback,
];

const invalidEmittedEditableWithoutVersion = (
  <BrunoTableClient
    tableId="TABLE_ID_EMITTED_EDITABLE_WITHOUT_VERSION"
    columns={columns}
    initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
    clientSource={clientSource}
    getRowId={(row) => row.id}
    // @ts-expect-error Emitted editable Client Tables require a Row Version extractor.
    editable
    // @ts-expect-error Without a Row Version extractor no emitted overload admits a Save handler.
    onSaveEdits={() => Promise.resolve()}
  />
);
void invalidEmittedEditableWithoutVersion;

const invalidEmittedEditableWithoutSaveHandler = (
  <BrunoTableClient
    tableId="TABLE_ID_EMITTED_EDITABLE_WITHOUT_SAVE_HANDLER"
    columns={columns}
    initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
    clientSource={clientSource}
    getRowId={(row) => row.id}
    // @ts-expect-error Emitted editable Client Tables require onSaveEdits.
    editable
    // @ts-expect-error Without onSaveEdits there is no valid emitted editable overload.
    getRowVersion={(row: Row) => row.revision}
  />
);
void invalidEmittedEditableWithoutSaveHandler;

const invalidEmittedEditableWithoutPotentialColumn = (
  <BrunoTableClient
    tableId="TABLE_ID_EMITTED_EDITABLE_WITHOUT_POTENTIAL_COLUMN"
    columns={nonsortableColumns}
    initialOrderBy={[{ columnId: "COL_ID_SCORE", direction: "asc" }]}
    clientSource={clientSource}
    getRowId={(row) => row.id}
    // @ts-expect-error Literal columns without editability make the editable overload unavailable.
    editable
    // @ts-expect-error No emitted editable overload admits a Row Version extractor.
    getRowVersion={(row: Row) => row.revision}
    // @ts-expect-error No emitted editable overload admits a Save handler.
    onSaveEdits={() => Promise.resolve()}
  />
);
void invalidEmittedEditableWithoutPotentialColumn;

const emittedServerSource = createViewServerReact(
  defineViewServerConfig({
    topics: {
      rows: {
        schema: Schema.Struct({
          id: ViewServerId,
          name: Schema.String,
          score: Schema.Number,
          revision: Schema.BigInt,
        }),
      },
    },
  }),
).useLiveQueryViewport("rows");
const emittedLeasedJsxAdapter = SourceAdapter.make({
  identity: { name: "bruno-table-emitted-jsx-route-tests" },
  failure: Schema.Never,
  materialized: undefined,
  leased: {
    metrics: Schema.Struct({ observed: Schema.BigInt }),
    rejectionLocation: Schema.Struct({ offset: Schema.BigInt }),
    definitionOptions: SourceAdapter.definitionOptions<undefined>(),
  },
});
const emittedLeasedJsxSource = createViewServerReact(
  defineViewServerConfig({
    topics: {
      rows: {
        schema: Schema.Struct({
          id: ViewServerId,
          name: Schema.String,
          score: Schema.Number,
          revision: Schema.BigInt,
        }),
        source: emittedLeasedJsxAdapter.leasedSource(["name", "revision"], undefined),
      },
    },
  }),
).useLiveQueryViewport("rows");

const validEmittedServer = (
  <BrunoTableServer
    tableId="TABLE_ID_EMITTED_JSX_SERVER"
    columns={columns}
    initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
    viewportSource={emittedServerSource}
  />
);
void validEmittedServer;
const validEmittedLeasedServerProps = {
  tableId: "TABLE_ID_EMITTED_JSX_LEASED_SERVER",
  columns,
  initialOrderBy: [{ columnId: "COL_ID_NAME", direction: "asc" }],
  viewportSource: emittedLeasedJsxSource,
  routeBy: { name: "Ada", revision: 1n },
} as const;
void (<BrunoTableServer {...validEmittedLeasedServerProps} />);
const missingEmittedLeasedRouteProps = {
  ...validEmittedLeasedServerProps,
  routeBy: { name: "Ada" },
};
// @ts-expect-error emitted leased JSX calls require every exact Route Field.
void (<BrunoTableServer {...missingEmittedLeasedRouteProps} />);
const wrongEmittedLeasedRouteProps = {
  ...validEmittedLeasedServerProps,
  routeBy: { name: "Ada", revision: 1 },
};
// @ts-expect-error emitted leased JSX calls preserve exact Route value domains.
void (<BrunoTableServer {...wrongEmittedLeasedRouteProps} />);
void (
  <BrunoTableServer
    {...validEmittedLeasedServerProps}
    // @ts-expect-error emitted leased JSX calls reject extra Route Fields.
    routeBy={{ name: "Ada", revision: 1n, desk: "rates" }}
  />
);

const invalidEmittedServerIdentity = (
  <BrunoTableServer
    tableId="TABLE_ID_EMITTED_JSX_SERVER_IDENTITY"
    columns={columns}
    initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
    viewportSource={emittedServerSource}
    // @ts-expect-error emitted Server declarations forbid consumer row identity.
    getRowId={(row: Row) => row.id}
  />
);
void invalidEmittedServerIdentity;

const invalidEmittedServerEditing = (
  <BrunoTableServer
    tableId="TABLE_ID_EMITTED_JSX_SERVER_EDITING"
    columns={columns}
    initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
    viewportSource={emittedServerSource}
    // @ts-expect-error emitted Server declarations expose no editing capability.
    editable
  />
);
void invalidEmittedServerEditing;

const invalidEmittedServerRange = (
  <BrunoTableServer
    tableId="TABLE_ID_EMITTED_JSX_SERVER_RANGE"
    columns={columns}
    initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
    viewportSource={emittedServerSource}
    // @ts-expect-error emitted Server declarations expose no range capability.
    rangeSelection
  />
);
void invalidEmittedServerRange;

const emittedServerProps = {
  tableId: "TABLE_ID_EMITTED_SERVER_SPREAD",
  columns,
  initialOrderBy: [{ columnId: "COL_ID_NAME", direction: "asc" }] as const,
  quickFilterFields: ["name"] as const,
  viewportSource: emittedServerSource,
};
const emittedServerClientSource = { ...emittedServerProps, clientSource };
// @ts-expect-error emitted Server declarations reject Client Sources.
void (<BrunoTableServer {...emittedServerClientSource} />);
const emittedServerExternalFilters = { ...emittedServerProps, externalFilters: [] };
void (<BrunoTableServer {...emittedServerExternalFilters} />);
const emittedServerNumericQuickFilterFields = {
  ...emittedServerProps,
  quickFilterFields: [42],
};
// @ts-expect-error emitted Server Quick Filter fields must be string Row fields.
void (<BrunoTableServer {...emittedServerNumericQuickFilterFields} />);
const emittedSpreadRowSelection = { ...emittedServerProps, rowSelection: true };
// @ts-expect-error emitted Server row selection remains forbidden through composed props.
void (<BrunoTableServer {...emittedSpreadRowSelection} />);
const emittedSpreadRangeSelection = { ...emittedServerProps, rangeSelection: true };
// @ts-expect-error emitted Server range selection remains forbidden through composed props.
void (<BrunoTableServer {...emittedSpreadRangeSelection} />);
const emittedSpreadPasteFill = {
  ...emittedServerProps,
  onPaste: () => undefined,
  onFill: () => undefined,
};
// @ts-expect-error emitted Server Paste and Fill remain forbidden through composed props.
void (<BrunoTableServer {...emittedSpreadPasteFill} />);
const emittedSpreadUndoRedo = {
  ...emittedServerProps,
  onUndo: () => undefined,
  onRedo: () => undefined,
};
// @ts-expect-error emitted Server Undo and Redo remain forbidden through composed props.
void (<BrunoTableServer {...emittedSpreadUndoRedo} />);

const emittedServerWithoutOrderProps = {
  tableId: "TABLE_ID_EMITTED_JSX_SERVER_ORDER",
  columns,
  viewportSource: emittedServerSource,
};
// @ts-expect-error emitted Server declarations require Initial Order By.
const invalidEmittedServerWithoutOrder = <BrunoTableServer {...emittedServerWithoutOrderProps} />;
void invalidEmittedServerWithoutOrder;

const validQuickFilterClient = (
  <BrunoTableClient
    tableId="TABLE_ID_EMITTED_JSX_VALID_QUICK_FILTER"
    getRowId={(row) => row.id}
    columns={columns}
    initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
    quickFilterFields={["name"]}
    clientSource={clientSource}
  >
    <BrunoTableToolbar>
      <BrunoTableQuickFilter />
    </BrunoTableToolbar>
  </BrunoTableClient>
);
void validQuickFilterClient;

const invalidNumericQuickFilterFields = (
  <BrunoTableClient
    tableId="TABLE_ID_EMITTED_JSX_INVALID_NUMERIC_QUICK_FILTER"
    getRowId={(row) => row.id}
    columns={columns}
    initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
    // @ts-expect-error Emitted JSX Quick Filter fields reject numeric source fields.
    quickFilterFields={["score"]}
    clientSource={clientSource}
  />
);
void invalidNumericQuickFilterFields;

const invalidEmptyQuickFilterFields = (
  <BrunoTableClient
    tableId="TABLE_ID_EMITTED_JSX_EMPTY_QUICK_FILTER"
    getRowId={(row) => row.id}
    columns={columns}
    initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
    // @ts-expect-error Emitted JSX Quick Filter fields require a non-empty tuple.
    quickFilterFields={[]}
    clientSource={clientSource}
  />
);
void invalidEmptyQuickFilterFields;

const invalidColumnIdentityQuickFilterFields = (
  <BrunoTableClient
    tableId="TABLE_ID_EMITTED_JSX_COLUMN_ID_QUICK_FILTER"
    getRowId={(row) => row.id}
    columns={columns}
    initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
    // @ts-expect-error Emitted JSX Quick Filter fields accept source fields, not Column Identities.
    quickFilterFields={["COL_ID_NAME"]}
    clientSource={clientSource}
  />
);
void invalidColumnIdentityQuickFilterFields;

const invalidMisspelledQuickFilterFields = (
  <BrunoTableClient
    tableId="TABLE_ID_EMITTED_JSX_MISSPELLED_QUICK_FILTER"
    getRowId={(row) => row.id}
    columns={columns}
    initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
    // @ts-expect-error Emitted JSX Quick Filter fields reject misspelled source fields.
    quickFilterFields={["displayName"]}
    clientSource={clientSource}
  />
);
void invalidMisspelledQuickFilterFields;

const missingOrder = (
  // @ts-expect-error Emitted JSX Client usage requires initialOrderBy.
  <BrunoTableClient
    tableId="TABLE_ID_EMITTED_JSX_MISSING_ORDER"
    getRowId={(row) => row.id}
    columns={columns}
    clientSource={clientSource}
  />
);
void missingOrder;

const emptyOrder = (
  <BrunoTableClient
    tableId="TABLE_ID_EMITTED_JSX_EMPTY_ORDER"
    getRowId={(row) => row.id}
    columns={columns}
    // @ts-expect-error Emitted JSX Client usage rejects an empty initialOrderBy.
    initialOrderBy={[]}
    clientSource={clientSource}
  />
);
void emptyOrder;

const unknownOrder = (
  <BrunoTableClient
    tableId="TABLE_ID_EMITTED_JSX_UNKNOWN_ORDER"
    getRowId={(row) => row.id}
    columns={columns}
    initialOrderBy={[
      // @ts-expect-error Emitted JSX preserves the exact sortable Column Identity union.
      { columnId: "COL_ID_UNKNOWN", direction: "asc" },
    ]}
    clientSource={clientSource}
  />
);
void unknownOrder;

const misspelledOrder = (
  <BrunoTableClient
    tableId="TABLE_ID_EMITTED_JSX_MISSPELLED_ORDER"
    getRowId={(row) => row.id}
    columns={columns}
    initialOrderBy={[
      // @ts-expect-error Emitted JSX rejects misspelled Column Identities.
      { columnId: "COL_ID_NAEM", direction: "asc" },
    ]}
    clientSource={clientSource}
  />
);
void misspelledOrder;

const invalidDirectionOrder = (
  <BrunoTableClient
    tableId="TABLE_ID_EMITTED_JSX_INVALID_DIRECTION"
    getRowId={(row) => row.id}
    columns={columns}
    initialOrderBy={[
      {
        columnId: "COL_ID_NAME",
        // @ts-expect-error Emitted JSX admits only asc and desc directions.
        direction: "ascending",
      },
    ]}
    clientSource={clientSource}
  />
);
void invalidDirectionOrder;

const computedOrder = (
  <BrunoTableClient
    tableId="TABLE_ID_EMITTED_JSX_COMPUTED_ORDER"
    getRowId={(row) => row.id}
    columns={columns}
    initialOrderBy={[
      // @ts-expect-error Emitted computed columns have no automatic Client sort mapping.
      { columnId: "COL_ID_DOUBLE_SCORE", direction: "asc" },
    ]}
    clientSource={clientSource}
  />
);
void computedOrder;

const nonsortableOrder = (
  <BrunoTableClient
    tableId="TABLE_ID_EMITTED_JSX_NONSORTABLE_ORDER"
    getRowId={(row) => row.id}
    columns={nonsortableColumns}
    initialOrderBy={[
      // @ts-expect-error Emitted explicitly nonsortable columns are absent from ordering inference.
      { columnId: "COL_ID_NAME", direction: "asc" },
    ]}
    clientSource={clientSource}
  />
);
void nonsortableOrder;

const sortFreeClient = (
  <BrunoTableClient
    tableId="TABLE_ID_EMITTED_JSX_SORT_FREE"
    getRowId={(row) => row.id}
    columns={sortFreeColumns}
    // @ts-expect-error Every emitted Client Table rejects definitions without a sortable Column Identity.
    initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
    clientSource={clientSource}
  />
);
void sortFreeClient;

const readOnlyWithEditOperations = (
  <BrunoTableClient
    tableId="TABLE_ID_EMITTED_JSX_READ_ONLY"
    getRowId={(row) => row.id}
    columns={columns}
    initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
    clientSource={clientSource}
    editable={false}
    // @ts-expect-error Read-only emitted JSX Client usage rejects getRowVersion.
    getRowVersion={(row: Row) => row.revision}
    // @ts-expect-error Read-only emitted JSX Client usage rejects onSaveEdits.
    onSaveEdits={() => Promise.resolve()}
  />
);
void readOnlyWithEditOperations;
