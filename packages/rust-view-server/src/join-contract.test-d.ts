import {createTopicHooks,defineJoin} from './product-provider';
import {orders,positions} from './topic-examples';
import {aggregateCount,type Decimal,type Int64} from './topic-schema';
const catalog={orders:{schema:orders,fingerprint:'0'.repeat(64)},positions:{schema:positions,fingerprint:'1'.repeat(64)}};
const spec={left:{topic:'orders',as:'o'},right:{topic:'positions',as:'p'},kind:'left',cardinality:'many_to_one',on:{left:'customer',right:'symbol'},limits:{maxLeftRowsPerKey:4,maxOutputRows:100}} as const;
const joined=defineJoin(catalog,spec),hooks=createTopicHooks(catalog);
function contracts(flag:boolean){
 const q={select:['o.price','p.quantity'],where:{op:'contains',field:'o.customer',value:'é'},orderBy:[]} as const;
 const a=hooks.useLiveQuery(joined,q);if(a.rows[0]){const price:Decimal=a.rows[0].o.price;const quantity:Int64|undefined=a.rows[0].p?.quantity;
 // @ts-expect-error left join right alias can be null
 a.rows[0].p.quantity;
 // @ts-expect-error filter-only field is not projected
 a.rows[0].o.customer;
 // @ts-expect-error rowId readonly
 a.rows[0].rowId='x';void [price,quantity];}
 const viewport=hooks.useLiveQueryViewport(joined);viewport.viewport.replace({query:q,window:{firstRow:0,lastRow:4},sink:{setRowCount(){},setRowData(rows){if(rows[0]){const price:Decimal=rows[0].o.price;const quantity:Int64|undefined=rows[0].p?.quantity;void[price,quantity];
 // @ts-expect-error sink identity readonly
 rows[0].rowId='x';}}}});viewport.useWholeResult(q);
 const which=flag?'o.price':'p.quantity';const dynamic=hooks.useLiveQuery(joined,{select:[which],orderBy:[]});if(dynamic.rows[0]){
 // @ts-expect-error possible left alias is not guaranteed
 dynamic.rows[0].o.price;
 const maybe=dynamic.rows[0].o?.price;void maybe;}
 hooks.useLiveQuery(joined,{global:true,aggregates:{count:{aggFunc:'count'},sum:{aggFunc:'sum',field:'o.price'}},having:{op:'gt',field:'count',value:aggregateCount('0')},orderBy:[]});
 // @ts-expect-error unqualified selected path
 hooks.useLiveQuery(joined,{select:['price'],orderBy:[]});
 // @ts-expect-error wrong text domain
 hooks.useLiveQuery(joined,{select:['o.price'],where:{op:'contains',field:'o.price',value:'1'},orderBy:[]});
 // @ts-expect-error aggregate alias collides with source alias
 hooks.useLiveQuery(joined,{global:true,aggregates:{o:{aggFunc:'count'}},orderBy:[]});
}
// @ts-expect-error incompatible exact join key domains
 defineJoin(catalog,{...spec,on:{left:'price',right:'symbol'}});
const inner=defineJoin(catalog,{...spec,kind:'inner'});function innerType(){const v=hooks.useLiveQuery(inner,{select:['p.quantity'],orderBy:[]});if(v.rows[0]){const x:Int64=v.rows[0].p.quantity;void x;}}
void [contracts,innerType];

function dynamicKind(flag:boolean){const kind=flag?'left':'inner';const dynamic=defineJoin(catalog,{...spec,kind});const v=hooks.useLiveQuery(dynamic,{select:['p.quantity'],orderBy:[]});if(v.rows[0]){
 // @ts-expect-error LEFT is possible for dynamic kind, so the right root can be null
 const wrong:Int64=v.rows[0].p.quantity;const safe:Int64|undefined=v.rows[0].p?.quantity;void [wrong,safe];}}
void dynamicKind;
