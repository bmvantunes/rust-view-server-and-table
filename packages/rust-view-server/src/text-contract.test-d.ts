import {createTopicHooks} from './product-provider';
import {orders} from './topic-examples';
import type {Predicate} from './topic-schema';
const hooks=createTopicHooks({orders:{schema:orders,fingerprint:'0'.repeat(64)}});
function contracts(flag:boolean){
 const op=flag?'contains':'endsWith';const field=flag?'customer':'note';
 const query={select:['price'],where:{op,field,value:'é'},orderBy:[]} as const;
 const a=hooks.useLiveQuery('orders',query);
 // @ts-expect-error filter dependencies are not selected
 a.rows[0]?.customer;
 // @ts-expect-error numeric fields do not admit text operators
 const wrong:Predicate<typeof orders>={op:'contains',field:'price',value:'1'};
 // @ts-expect-error insensitive mode not admitted
 const mode:Predicate<typeof orders>={op:'contains',field:'customer',value:'a',caseSensitive:false};
 const vp=hooks.useLiveQueryViewport('orders');vp.viewport.replace({query,window:{firstRow:0,lastRow:3},sink:{setRowCount(){},setRowData(rows){rows[0]?.price;
 // @ts-expect-error filter field remains absent from sink
 rows[0]?.note;
 }}});vp.useWholeResult(query);void [wrong,mode];
}
void contracts;
