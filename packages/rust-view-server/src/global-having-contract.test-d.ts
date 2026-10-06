import {createTopicHooks} from './product-provider';
import {orders,positions} from './topic-examples';
import {aggregateCount,aggregateInteger,aggregateDecimal,type AggregateCount,type AggregateInteger,type AggregateDecimal,type Uint64} from './topic-schema';
const hooks=createTopicHooks({orders:{schema:orders,fingerprint:'0'.repeat(64)},positions:{schema:positions,fingerprint:'0'.repeat(64)}});
type Equal<A,B>=(<T>()=>T extends A?1:2)extends(<T>()=>T extends B?1:2)?true:false;type Assert<T extends true>=T;
function contracts(flag:boolean){
 const query={global:true,aggregates:{n:{aggFunc:'count'},s:{aggFunc:'sum',field:'units'},a:{aggFunc:'avg',field:'units'},lo:{aggFunc:'min',field:'units'}},having:{op:'gt',field:'n',value:aggregateCount(0n)},orderBy:[]} as const;
 const result=hooks.useLiveQuery('orders',query);type Count=Assert<Equal<typeof result.rows[number]['n'],AggregateCount>>;type Avg=Assert<Equal<typeof result.rows[number]['a'],AggregateDecimal|null>>;type Min=Assert<Equal<typeof result.rows[number]['lo'],Uint64|null>>;type Sum=Assert<Equal<typeof result.rows[number]['s'],AggregateInteger>>;
 // @ts-expect-error global has no source fields
 result.rows[0]?.customer;
 // @ts-expect-error rowId always readonly
 result.rows[0]!.rowId='x';
 // @ts-expect-error HAVING cannot use ungrouped source field
 hooks.useLiveQuery('orders',{...query,having:{op:'eq',field:'customer',value:'x'}});
 // @ts-expect-error count operand must retain exact count type
 hooks.useLiveQuery('orders',{...query,having:{op:'gt',field:'n',value:3}});
 // @ts-expect-error text operator on exact sum forbidden
 hooks.useLiveQuery('orders',{...query,having:{op:'contains',field:'s',value:'1'}});
 // @ts-expect-error non-null count cannot test null
 hooks.useLiveQuery('orders',{...query,having:{op:'is_null',field:'n'}});
 // @ts-expect-error global and grouped exclusive
 hooks.useLiveQuery('orders',{...query,groupBy:['customer']});
 const vp=hooks.useLiveQueryViewport('orders');vp.viewport.replace({query,window:{firstRow:0,lastRow:3},sink:{setRowCount(){},setRowData(rows){const a:AggregateDecimal|null=rows[0]!.a;void a;
 // @ts-expect-error sink exact selection excludes source fields
 rows[0]?.units;
 }}});vp.useWholeResult(query);
 const field=flag?'risk':'quantity';const aggFunc=flag?'avg':'sum';const dynamic={global:true,aggregates:{value:{aggFunc,field}},orderBy:[]} as const;const d=hooks.useLiveQuery('positions',dynamic);type Dynamic=Assert<Equal<typeof d.rows[number]['value'],number|AggregateInteger|AggregateDecimal|null>>;
 hooks.useLiveQuery('orders',{groupBy:['customer'],aggregates:{n:{aggFunc:'count'}},having:{op:'and',clauses:[{op:'startsWith',field:'customer',value:'A'},{op:'gt',field:'n',value:aggregateCount('0')}]},orderBy:[]});
 void [aggregateInteger('12'),aggregateDecimal('1.2')];
}
void contracts;
