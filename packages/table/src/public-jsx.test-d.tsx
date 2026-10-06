import { Schema } from "effect";
import { ViewServerId, defineViewServerConfig } from "effect-view-server/config";
import { createViewServerReact } from "effect-view-server/react";
import { SourceAdapter } from "effect-view-server/source-adapter";

import {
  BrunoTableClient,
  BrunoTableActiveFilterCount,
  BrunoTableActiveSortCount,
  BrunoTableComputedColumn,
  BrunoTableFilterControl,
  BrunoTableLoadedRowCount,
  BrunoTableQuickFilter,
  BrunoTableResultRowCount,
  BrunoTableServer,
  BrunoTableToolbar,
} from "./index";

import type { BrunoTableClientProps, BrunoTableColumns } from "./index";

type Row = {
  readonly id: string;
  readonly name: string;
  readonly score: number;
  readonly revision: bigint;
  readonly hiddenLabel: string;
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

function ForwardedClient(props: BrunoTableClientProps<Row, typeof columns, bigint>) {
  return <BrunoTableClient {...props} />;
}
void ForwardedClient;

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
    tableId="TABLE_ID_JSX_INVALID_WHITESPACE_IDENTITY"
    getRowId={(row) => row.id}
    // @ts-expect-error Raw Column Identity literals are validated after tuple inference.
    columns={whitespaceIdentityColumns}
    initialOrderBy={[{ columnId: "COL_ID_DISPLAY NAME", direction: "asc" }]}
    clientSource={clientSource}
  />
);
void invalidWhitespaceIdentityClient;

const validClient = (
  <BrunoTableClient
    tableId="TABLE_ID_JSX_VALID"
    getRowId={(row) => row.id}
    columns={columns}
    initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
    quickFilterFields={["name", "hiddenLabel"]}
    clientSource={clientSource}
  >
    <BrunoTableToolbar>
      <BrunoTableQuickFilter />
      <BrunoTableFilterControl<Row, typeof columns> ownership="grid">
        {(commands) => <button onClick={() => commands.clearAll()}>Clear Grid Filters</button>}
      </BrunoTableFilterControl>
      <BrunoTableResultRowCount />
      <BrunoTableLoadedRowCount />
      <BrunoTableActiveFilterCount />
      <BrunoTableActiveSortCount />
    </BrunoTableToolbar>
  </BrunoTableClient>
);
void validClient;

const validClientRowSelection = (
  <BrunoTableClient
    tableId="TABLE_ID_JSX_CLIENT_ROW_SELECTION"
    columns={columns}
    initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
    clientSource={clientSource}
    getRowId={(row) => row.id}
    rowSelection
  />
);
void validClientRowSelection;

const validEditableClient = (
  <BrunoTableClient
    tableId="TABLE_ID_JSX_EDITABLE"
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
void validEditableClient;

const editablePropsWithoutMode = {
  tableId: "TABLE_ID_JSX_CONSUMER_OWNED_EDIT_MODE",
  columns,
  initialOrderBy: [{ columnId: "COL_ID_NAME", direction: "asc" }],
  clientSource,
  getRowId: (row: Row) => row.id,
  editable: true,
  getRowVersion: (row: Row) => row.revision,
  onSaveEdits: () => Promise.resolve(),
} as const;
const invalidControlledEditMode = {
  ...editablePropsWithoutMode,
  // @ts-expect-error Edit Mode is owned by the end user inside BrunoTable.
  editMode: "batch",
} satisfies BrunoTableClientProps<Row, typeof columns, bigint>;
const invalidInitialEditMode = {
  ...editablePropsWithoutMode,
  // @ts-expect-error Consumers cannot provide an initial Edit Mode.
  initialEditMode: "batch",
} satisfies BrunoTableClientProps<Row, typeof columns, bigint>;
const invalidEditModeCallback = {
  ...editablePropsWithoutMode,
  // @ts-expect-error Consumers cannot control Edit Mode changes.
  onEditModeChange: () => undefined,
} satisfies BrunoTableClientProps<Row, typeof columns, bigint>;
void [invalidControlledEditMode, invalidInitialEditMode, invalidEditModeCallback];

const invalidEditableWithoutVersion = (
  <BrunoTableClient
    tableId="TABLE_ID_JSX_EDITABLE_WITHOUT_VERSION"
    columns={columns}
    initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
    clientSource={clientSource}
    getRowId={(row) => row.id}
    // @ts-expect-error Editable Client Tables require getRowVersion.
    editable
    // @ts-expect-error Without getRowVersion there is no valid Save Change Set Row Version.
    onSaveEdits={() => Promise.resolve()}
  />
);
void invalidEditableWithoutVersion;

const invalidEditableWithoutSaveHandler = (
  <BrunoTableClient
    tableId="TABLE_ID_JSX_EDITABLE_WITHOUT_SAVE_HANDLER"
    columns={columns}
    initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
    clientSource={clientSource}
    getRowId={(row) => row.id}
    // @ts-expect-error Editable Client Tables require onSaveEdits.
    editable
    // @ts-expect-error Without onSaveEdits there is no valid editable overload.
    getRowVersion={(row: Row) => row.revision}
  />
);
void invalidEditableWithoutSaveHandler;

const invalidReadOnlySaveHandler = (
  <BrunoTableClient
    tableId="TABLE_ID_JSX_READ_ONLY_SAVE_HANDLER"
    columns={columns}
    initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
    clientSource={clientSource}
    getRowId={(row) => row.id}
    // @ts-expect-error Read-only Client Tables reject edit-only props.
    onSaveEdits={() => Promise.resolve()}
  />
);
void invalidReadOnlySaveHandler;

const invalidEditableWithoutPotentialColumn = (
  <BrunoTableClient
    tableId="TABLE_ID_JSX_EDITABLE_WITHOUT_POTENTIAL_COLUMN"
    columns={nonsortableColumns}
    initialOrderBy={[{ columnId: "COL_ID_SCORE", direction: "asc" }]}
    clientSource={clientSource}
    getRowId={(row) => row.id}
    // @ts-expect-error Literal columns without editability make the editable overload unavailable.
    editable
    // @ts-expect-error No editable overload admits a Row Version extractor.
    getRowVersion={(row: Row) => row.revision}
    // @ts-expect-error No editable overload admits a Save handler.
    onSaveEdits={() => Promise.resolve()}
  />
);
void invalidEditableWithoutPotentialColumn;

const serverTypeReact = createViewServerReact(
  defineViewServerConfig({
    topics: {
      rows: {
        schema: Schema.Struct({
          id: ViewServerId,
          name: Schema.String,
          score: Schema.Number,
          revision: Schema.BigInt,
          hiddenLabel: Schema.String,
        }),
      },
    },
  }),
);
const serverSource = serverTypeReact.useLiveQueryViewport("rows");
const leasedJsxAdapter = SourceAdapter.make({
  identity: { name: "bruno-table-jsx-route-tests" },
  failure: Schema.Never,
  materialized: undefined,
  leased: {
    metrics: Schema.Struct({ observed: Schema.BigInt }),
    rejectionLocation: Schema.Struct({ offset: Schema.BigInt }),
    definitionOptions: SourceAdapter.definitionOptions<undefined>(),
  },
});
const leasedJsxSource = createViewServerReact(
  defineViewServerConfig({
    topics: {
      rows: {
        schema: Schema.Struct({
          id: ViewServerId,
          name: Schema.String,
          score: Schema.Number,
          revision: Schema.BigInt,
          hiddenLabel: Schema.String,
        }),
        source: leasedJsxAdapter.leasedSource(["name", "revision"], undefined),
      },
    },
  }),
).useLiveQueryViewport("rows");

const serverComponentProps = {
  tableId: "TABLE_ID_JSX_SERVER",
  columns,
  initialOrderBy: [{ columnId: "COL_ID_NAME", direction: "asc" }] as const,
  quickFilterFields: ["name"] as const,
  viewportSource: serverSource,
};

const validServer = <BrunoTableServer {...serverComponentProps} />;
void validServer;
const validLeasedServerProps = {
  ...serverComponentProps,
  viewportSource: leasedJsxSource,
  routeBy: { name: "Ada", revision: 1n },
} as const;
void (<BrunoTableServer {...validLeasedServerProps} />);
const missingLeasedRouteProps = { ...validLeasedServerProps, routeBy: { name: "Ada" } };
// @ts-expect-error leased JSX calls require every exact Route Field.
void (<BrunoTableServer {...missingLeasedRouteProps} />);
const wrongLeasedRouteProps = {
  ...validLeasedServerProps,
  routeBy: { name: "Ada", revision: 1 },
};
// @ts-expect-error leased JSX calls preserve exact Route value domains.
void (<BrunoTableServer {...wrongLeasedRouteProps} />);
void (
  <BrunoTableServer
    {...validLeasedServerProps}
    // @ts-expect-error leased JSX calls reject extra Route Fields.
    routeBy={{ name: "Ada", revision: 1n, desk: "rates" }}
  />
);

const invalidServerClientSource = { ...serverComponentProps, clientSource };
// @ts-expect-error Server Tables reject Client Sources through composed props.
void (<BrunoTableServer {...invalidServerClientSource} />);
const validServerExternalFilters = { ...serverComponentProps, externalFilters: [] };
void (<BrunoTableServer {...validServerExternalFilters} />);
const invalidServerQuickFilterFields = { ...serverComponentProps, quickFilterFields: [42] };
// @ts-expect-error Server Quick Filter fields must be string Row fields.
void (<BrunoTableServer {...invalidServerQuickFilterFields} />);

const invalidServerIdentity = (
  <BrunoTableServer
    tableId="TABLE_ID_JSX_SERVER_IDENTITY"
    columns={columns}
    initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
    viewportSource={serverSource}
    // @ts-expect-error Server row identity is authoritative source evidence.
    getRowId={(row: Row) => row.id}
  />
);
void invalidServerIdentity;

const invalidServerSelection = (
  <BrunoTableServer
    tableId="TABLE_ID_JSX_SERVER_SELECTION"
    columns={columns}
    initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
    viewportSource={serverSource}
    // @ts-expect-error Server Tables expose no row-selection capability.
    rowSelection
  />
);
void invalidServerSelection;

for (const forbiddenCapability of [
  // @ts-expect-error Server Tables have no editing capability.
  <BrunoTableServer key="editing" {...serverComponentProps} editable />,
  // @ts-expect-error Server Tables have no Cell Range Selection capability.
  <BrunoTableServer key="range" {...serverComponentProps} rangeSelection />,
  // @ts-expect-error Server Tables have no Paste or Fill capability.
  <BrunoTableServer key="paste" {...serverComponentProps} onPaste={() => undefined} />,
  // @ts-expect-error Server Tables have no Paste or Fill capability.
  <BrunoTableServer key="fill" {...serverComponentProps} onFill={() => undefined} />,
  // @ts-expect-error Server Tables have no Undo or Redo capability.
  <BrunoTableServer key="undo" {...serverComponentProps} onUndo={() => undefined} />,
  // @ts-expect-error Server Tables have no Undo or Redo capability.
  <BrunoTableServer key="redo" {...serverComponentProps} onRedo={() => undefined} />,
]) {
  void forbiddenCapability;
}

const spreadRowSelection = { ...serverComponentProps, rowSelection: true };
// @ts-expect-error Server row selection remains forbidden through composed props.
void (<BrunoTableServer {...spreadRowSelection} />);
const spreadRangeSelection = { ...serverComponentProps, rangeSelection: true };
// @ts-expect-error Server Cell Range Selection remains forbidden through composed props.
void (<BrunoTableServer {...spreadRangeSelection} />);
const spreadPasteFill = {
  ...serverComponentProps,
  onPaste: () => undefined,
  onFill: () => undefined,
};
// @ts-expect-error Server Paste and Fill remain forbidden through composed props.
void (<BrunoTableServer {...spreadPasteFill} />);
const spreadUndoRedo = {
  ...serverComponentProps,
  onUndo: () => undefined,
  onRedo: () => undefined,
};
// @ts-expect-error Server Undo and Redo remain forbidden through composed props.
void (<BrunoTableServer {...spreadUndoRedo} />);

const serverWithoutOrderProps = {
  tableId: "TABLE_ID_JSX_SERVER_ORDER",
  columns,
  viewportSource: serverSource,
};
// @ts-expect-error Server Tables require a non-empty Initial Order By tuple.
const invalidServerWithoutOrder = <BrunoTableServer {...serverWithoutOrderProps} />;
void invalidServerWithoutOrder;

const invalidQuickFilterFields = (
  <BrunoTableClient
    tableId="TABLE_ID_JSX_INVALID_QUICK_FIELDS"
    getRowId={(row) => row.id}
    columns={columns}
    initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
    // @ts-expect-error JSX Quick Filter fields reject numeric row fields.
    quickFilterFields={["score"]}
    clientSource={clientSource}
  />
);
void invalidQuickFilterFields;

const invalidEmptyQuickFilterFields = (
  <BrunoTableClient
    tableId="TABLE_ID_JSX_EMPTY_QUICK_FIELDS"
    getRowId={(row) => row.id}
    columns={columns}
    initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
    // @ts-expect-error JSX Quick Filter fields require a non-empty tuple.
    quickFilterFields={[]}
    clientSource={clientSource}
  />
);
void invalidEmptyQuickFilterFields;

const missingOrder = (
  // @ts-expect-error JSX Client usage requires initialOrderBy.
  <BrunoTableClient
    tableId="TABLE_ID_JSX_MISSING_ORDER"
    getRowId={(row) => row.id}
    columns={columns}
    clientSource={clientSource}
  />
);
void missingOrder;

const emptyOrder = (
  <BrunoTableClient
    tableId="TABLE_ID_JSX_EMPTY_ORDER"
    getRowId={(row) => row.id}
    columns={columns}
    // @ts-expect-error JSX Client usage rejects an empty initialOrderBy.
    initialOrderBy={[]}
    clientSource={clientSource}
  />
);
void emptyOrder;

const unknownOrder = (
  <BrunoTableClient
    tableId="TABLE_ID_JSX_UNKNOWN_ORDER"
    getRowId={(row) => row.id}
    columns={columns}
    initialOrderBy={[
      // @ts-expect-error JSX inference preserves the exact sortable Column Identity union.
      { columnId: "COL_ID_UNKNOWN", direction: "asc" },
    ]}
    clientSource={clientSource}
  />
);
void unknownOrder;

const misspelledOrder = (
  <BrunoTableClient
    tableId="TABLE_ID_JSX_MISSPELLED_ORDER"
    getRowId={(row) => row.id}
    columns={columns}
    initialOrderBy={[
      // @ts-expect-error JSX inference rejects misspelled Column Identities.
      { columnId: "COL_ID_NAEM", direction: "asc" },
    ]}
    clientSource={clientSource}
  />
);
void misspelledOrder;

const invalidDirectionOrder = (
  <BrunoTableClient
    tableId="TABLE_ID_JSX_INVALID_DIRECTION"
    getRowId={(row) => row.id}
    columns={columns}
    initialOrderBy={[
      {
        columnId: "COL_ID_NAME",
        // @ts-expect-error JSX inference admits only asc and desc directions.
        direction: "ascending",
      },
    ]}
    clientSource={clientSource}
  />
);
void invalidDirectionOrder;

const computedOrder = (
  <BrunoTableClient
    tableId="TABLE_ID_JSX_COMPUTED_ORDER"
    getRowId={(row) => row.id}
    columns={columns}
    initialOrderBy={[
      // @ts-expect-error Computed columns have no automatic Client sort mapping.
      { columnId: "COL_ID_DOUBLE_SCORE", direction: "asc" },
    ]}
    clientSource={clientSource}
  />
);
void computedOrder;

const nonsortableOrder = (
  <BrunoTableClient
    tableId="TABLE_ID_JSX_NONSORTABLE_ORDER"
    getRowId={(row) => row.id}
    columns={nonsortableColumns}
    initialOrderBy={[
      // @ts-expect-error Explicitly nonsortable columns are absent from JSX ordering inference.
      { columnId: "COL_ID_NAME", direction: "asc" },
    ]}
    clientSource={clientSource}
  />
);
void nonsortableOrder;

const sortFreeClient = (
  <BrunoTableClient
    tableId="TABLE_ID_JSX_SORT_FREE"
    getRowId={(row) => row.id}
    columns={sortFreeColumns}
    // @ts-expect-error Every Client Table rejects definitions without a sortable Column Identity.
    initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
    clientSource={clientSource}
  />
);
void sortFreeClient;

const readOnlyWithEditOperations = (
  <BrunoTableClient
    tableId="TABLE_ID_JSX_READ_ONLY"
    getRowId={(row) => row.id}
    columns={columns}
    initialOrderBy={[{ columnId: "COL_ID_NAME", direction: "asc" }]}
    clientSource={clientSource}
    editable={false}
    // @ts-expect-error Read-only JSX Client usage rejects getRowVersion.
    getRowVersion={(row: Row) => row.revision}
    // @ts-expect-error Read-only JSX Client usage rejects onSaveEdits.
    onSaveEdits={() => Promise.resolve()}
  />
);
void readOnlyWithEditOperations;
