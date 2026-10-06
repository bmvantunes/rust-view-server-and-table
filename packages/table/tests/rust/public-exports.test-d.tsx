import {
  BrunoTableCreateRustHooks,
  BrunoTableRustEncodeCompatRow,
  type BrunoTableRustCompatRow,
  type BrunoTableRustCompatResult,
  type BrunoTableRustCompleteSelect,
  type BrunoTableRustFilter,
  type BrunoTableRustGroupedQuery,
  type BrunoTableRustQuery,
  type BrunoTableRustRawQuery,
  type BrunoTableRustViewport,
  type BrunoTableRustWhere,
} from "@bruno/table/rust";
import { catalog } from "@bruno/view-server-client/generated/topics";

// @ts-expect-error public Rust adapter exports carry the BrunoTable brand
import type { CompatRow } from "@bruno/table/rust";
// @ts-expect-error public Rust adapter exports carry the BrunoTable brand
import type { CompatResult } from "@bruno/table/rust";
// @ts-expect-error public Rust adapter exports carry the BrunoTable brand
import { createBrunoTableHooks } from "@bruno/table/rust";
// @ts-expect-error public Rust adapter exports carry the BrunoTable brand
import { encodeCompatRow } from "@bruno/table/rust";

const hooks = BrunoTableCreateRustHooks({ orders: catalog.orders });
type Schema = typeof catalog.orders.schema;
type Row = BrunoTableRustCompatRow<Schema>;
type Query = BrunoTableRustQuery<Schema>;
type RawQuery = BrunoTableRustRawQuery<Schema>;
type GroupedQuery = BrunoTableRustGroupedQuery<Schema>;
type Filter = BrunoTableRustFilter<Schema>;
type Where = BrunoTableRustWhere<Schema>;
type CompleteSelect = BrunoTableRustCompleteSelect<Schema>;
type Viewport = BrunoTableRustViewport<Schema>;
type Result = BrunoTableRustCompatResult<
  Schema,
  Extract<Query, { readonly select: readonly string[] }>
>;
const query: RawQuery = { select: ["units"], where: [], orderBy: [] };
const filter: Filter = { field: "units", type: "equals", filter: 1n };
const where: Where = [filter];
const grouped: GroupedQuery = {
  groupBy: ["open"],
  aggregates: { rows: { aggFunc: "count" } },
  where: [],
  orderBy: [],
};
declare const row: Row;
declare const selected: Result;
declare const complete: CompleteSelect;
declare const viewport: Viewport;
const hooksValue = hooks.useViewportSource;
const encodeValue = BrunoTableRustEncodeCompatRow;
void [query, where, grouped, row, selected, complete, viewport, hooksValue, encodeValue];
