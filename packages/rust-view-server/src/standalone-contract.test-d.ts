import {createTopicHooks} from './product-provider';
import {catalog,keyFields} from '../tests/fixtures/standalone/topics';
import {compactRowId} from './row-id-selector';
import type {Int64} from './topic-schema';
type Equal<A,B>=(<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2)?true:false;
type Check<T extends true>=T;
const hooks=createTopicHooks(catalog);
function contracts(){
 const result=hooks.useLiveQuery('balances',{select:['quantity','risk'],orderBy:[{field:'risk',direction:'desc'}]});
 type Keys=Check<Equal<keyof typeof result.rows[number],'quantity'|'risk'|'rowId'>>;
 type Quantity=Check<Equal<typeof result.rows[number]['quantity'],Int64>>;
 type Risk=Check<Equal<typeof result.rows[number]['risk'],number>>;
 const id:string=result.rows[0]!.rowId;
 // @ts-expect-error metadata remains readonly.
 result.rows[0]!.rowId='x';
 // @ts-expect-error key component is not a selectable business field.
 hooks.useLiveQuery('balances',{select:['tenant'],orderBy:[]});
 // @ts-expect-error no fake business ID exists.
 result.rows[0]!.id;
 const view=hooks.useLiveQueryViewport('balances');
 view.viewport.replace({window:{firstRow:0,lastRow:1},query:{select:['risk'],orderBy:[]},sink:{setRowCount(){},setRowData(rows){
 const rowId:string=rows[0]!.rowId;const risk:number=rows[0]!.risk;
 // @ts-expect-error unselected exact field stays absent.
 rows[0]!.quantity;
 // @ts-expect-error viewport metadata readonly.
 rows[0]!.rowId='x';void[rowId,risk];}}});
 compactRowId(keyFields["BalanceKey"],[{source:'key',field:'tenant'},{source:'key',field:'account'}]);
 // @ts-expect-error generated key fields only.
 compactRowId(keyFields["BalanceKey"],[{source:'key',field:'quantity'}]);
 void id;
}
void contracts;
