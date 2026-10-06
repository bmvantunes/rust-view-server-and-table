import {BrunoTableCreateRustHooks,type BrunoTableRustCompatRow,type BrunoTableRustCompleteSelect,type BrunoTableRustCompatResult} from '@bruno/table/rust';
import {catalog} from '@bruno/rust-view-server/generated/topics';
import type {BrowserProductProvider} from '@bruno/rust-view-server/react';
import {BrunoTableServer,type BrunoTableColumns} from '@bruno/table';
import type {LiveQueryViewportBaseRow,LiveQueryViewportQueryAuthority,LiveQueryViewportRouteBy} from 'effect-view-server/react/viewport-base-row';
import type * as BigDecimal from 'effect/BigDecimal';
const hooks=BrunoTableCreateRustHooks({orders:catalog.orders});
type Row=BrunoTableRustCompatRow<typeof catalog.orders.schema>;
const columns=[{columnId:'COL_ID_UNITS',field:'units',headerName:'Units',valueType:'bigint'}] as const satisfies BrunoTableColumns<Row>;
function Consumer({provider}:{provider:BrowserProductProvider}){
 const source=hooks.useViewportSource(provider,'orders');
 const row=source.useWholeResult({select:['units','price'],where:[],orderBy:[]}).rows[0];
 if(row){const n:bigint=row.units;const d:BigDecimal.BigDecimal=row.price;
 // @ts-expect-error omitted fields remain omitted
 row.customer;
 // @ts-expect-error authoritative identity readonly
 row.rowId='x';
 // @ts-expect-error integer output is exact bigint
 const numeric:number=row.units;void[n,d,numeric];}
 const all=source.useWholeResult({select:source.completeRawSelect,where:[],orderBy:[]}).rows[0];if(all){const customer:string=all.customer;void customer;}
 const grouped=source.useWholeResult({groupBy:['open'],aggregates:{n:{aggFunc:'count'},sum:{aggFunc:'sum',field:'price'}},where:[],orderBy:[]}).rows[0];if(grouped){const n:bigint=grouped.n;const sum:BigDecimal.BigDecimal=grouped.sum;void[n,sum];}
 source.useWholeResult({groupBy:['open'],aggregates:{avg:{aggFunc:'avg',field:'price'}},where:[],orderBy:[]});
 source.useWholeResult({select:['customer'],where:[],orderBy:[{field:'customer',direction:'asc'}]});
 // @ts-expect-error exact integer operands require bigint
 source.useWholeResult({select:['units'],where:[{field:'units',type:'equals',filter:1}],orderBy:[]});
 return <BrunoTableServer tableId="rust-compat" columns={columns} initialOrderBy={[{columnId:'COL_ID_UNITS',direction:'asc'}]} viewportSource={source}/>;
}
type Source=ReturnType<typeof hooks.useViewportSource<'orders'>>;type V=Source['viewport'];
type Equal<A,B>=(<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2)?true:false;
const rowWitness:Equal<LiveQueryViewportBaseRow<V>,Row>=true;
const materialized:Equal<LiveQueryViewportRouteBy<V>,never>=true;
const authorityPresent:LiveQueryViewportQueryAuthority<V> extends never?false:true=true;
void[Consumer,rowWitness,materialized,authorityPresent];

// @ts-expect-error a narrow tuple cannot forge the complete-projection witness
const forged:BrunoTableRustCompleteSelect<typeof catalog.orders.schema>=['units'];
void forged;

// Dynamic aggregate fields preserve every possible result domain.
declare const aggregateField:'units'|'price';
const unionSum={groupBy:['open'],aggregates:{total:{aggFunc:'sum',field:aggregateField}},where:[],orderBy:[]} as const;
declare const unionSumRow:BrunoTableRustCompatResult<typeof catalog.orders.schema,typeof unionSum>;
const unionSumValue:bigint|BigDecimal.BigDecimal=unionSumRow.total;
// @ts-expect-error a dynamic Decimal/integer field cannot promise bigint alone
const falselyOnlyInteger:bigint=unionSumRow.total;
const unionMin={groupBy:['open'],aggregates:{low:{aggFunc:'min',field:aggregateField}},where:[],orderBy:[]} as const;
declare const unionMinRow:BrunoTableRustCompatResult<typeof catalog.orders.schema,typeof unionMin>;
const unionMinValue:bigint|BigDecimal.BigDecimal=unionMinRow.low;
// @ts-expect-error a dynamic minimum cannot collapse to never and permit string
const falselyString:string=unionMinRow.low;
void[unionSumValue,unionMinValue,falselyOnlyInteger,falselyString];

// The SDK profile preserves every aggregate domain when a field is chosen dynamically.
import {defineSchema,type QueryResult,type AggregateDecimal,type AggregateInteger} from '@bruno/rust-view-server/schema';
const profileSchema=defineSchema({format:2,id:'profileTypes',version:2,key:'rowId',fields:[{name:'g',kind:'string',optional:false,nullable:false},{name:'n',kind:'number',optional:true,nullable:false},{name:'i',kind:'int64',optional:false,nullable:false}]} as const);
declare const profileField:'n'|'i';
const profileQuery={semanticProfile:'effect-4.2.8',groupBy:['g'],aggregates:{total:{aggFunc:'sum',field:profileField},mean:{aggFunc:'avg',field:'n'},minimum:{aggFunc:'min',field:'n'}},orderBy:[]} as const;
declare const profileRow:QueryResult<typeof profileSchema,typeof profileQuery>;
const profileTotal:AggregateDecimal|AggregateInteger=profileRow.total;
const profileMean:AggregateDecimal=profileRow.mean;
const profileMinimum:number|undefined=profileRow.minimum;
// @ts-expect-error profile Number sum does not return floating point Number
const lossyProfileTotal:number=profileRow.total;
// @ts-expect-error optional nonnullable minimum never manufactures null
const absentAsNull:null=profileRow.minimum;
void[profileTotal,profileMean,profileMinimum,lossyProfileTotal,absentAsNull];

declare const optionalMinField:'note'|'customer';
const optionalMin={groupBy:['open'],aggregates:{low:{aggFunc:'min',field:optionalMinField}},where:[],orderBy:[]} as const;
declare const optionalMinRow:BrunoTableRustCompatResult<typeof catalog.orders.schema,typeof optionalMin>;
const optionalMinValue:string|null|undefined=optionalMinRow.low;
// @ts-expect-error dynamic optional field cannot promise presence
const falselyPresent:string|null=optionalMinRow.low;
void[optionalMinValue,falselyPresent];
