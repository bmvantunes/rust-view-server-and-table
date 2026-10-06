import {createTopicHooks,type RowsWithRowId,type ProductViewportSink,useLiveQuery,useLiveQueryViewport} from './product-provider';
import {catalog,schemas,keyFields} from './generated/topics';
import {compactRowId,deleteRowId} from './row-id-selector';
const hooks=createTopicHooks(catalog);
function contracts(){
 const result=hooks.useLiveQuery('orders',{select:['customer','price'],orderBy:[{field:'price',direction:'desc'},{field:'customer',direction:'asc'}]});
 const id:string=result.rows[0]!.rowId;
 // @ts-expect-error metadata is mandatory readonly.
 result.rows[0]!.rowId='replacement';
 // @ts-expect-error identity input remains excluded from selection.
 result.rows[0]!.orderId;
 // @ts-expect-error metadata is not a selectable business field.
 hooks.useLiveQuery('orders',{select:['rowId'],orderBy:[]});
 const view=hooks.useLiveQueryViewport('positions');
 view.viewport.replace({window:{firstRow:5,lastRow:6},query:{select:['symbol'],orderBy:[]},sink:{setRowCount(){},setRowData(rows,keys){const stable:string=rows[5]!.rowId;const same:string=keys[5]!;
 // @ts-expect-error viewport metadata readonly.
 rows[5]!.rowId='change';
 // @ts-expect-error unselected field absent.
 rows[5]!.quantity;void[stable,same];}}});
 const all=view.useWholeResult({select:['risk'],orderBy:[]});const wholeId:string=all.rows[0]!.rowId;
 const legacy=useLiveQuery('products',{select:['quantity'],where:[],orderBy:[]});const legacyId:string=legacy.rows[0]!.rowId;
 const legacyView=useLiveQueryViewport('products').useWholeResult({select:['category'],where:[],orderBy:[]});const legacyWholeId:string=legacyView.rows[0]!.rowId;
 // @ts-expect-error rows cannot omit the metadata.
 const missing:RowsWithRowId<{customer:string}>={customer:'x'};
 // @ts-expect-error a payload collision cannot become an unsafe intersection.
 const collision:RowsWithRowId<{rowId:number}>={rowId:1};
 compactRowId(keyFields["PositionsKey"],[{source:'key',field:'tenant'},{source:'key',field:'account'}]);
 deleteRowId(keyFields["OrdersKey"],schemas["orders"],[{source:'key',field:'tenant'},{source:'value',field:'orderId'}]);
 // @ts-expect-error compact selectors cannot depend on value.
 compactRowId(keyFields["PositionsKey"],[{source:'value',field:'positionId'}]);
 // @ts-expect-error only generated key fields exist.
 compactRowId(keyFields["PositionsKey"],[{source:'key',field:'customer'}]);
 // @ts-expect-error optional/nullable values cannot supply mandatory identity.
 deleteRowId(keyFields["OrdersKey"],schemas["orders"],[{source:'value',field:'note'}]);
 // @ts-expect-error at least one component required.
 compactRowId(keyFields["PositionsKey"],[]);
 void [id,wholeId,legacyId,legacyWholeId,missing,collision];
}
void contracts;
