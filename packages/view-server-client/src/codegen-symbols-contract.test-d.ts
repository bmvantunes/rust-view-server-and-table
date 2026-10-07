import {createTopicHooks} from './product-provider';
import {catalog,schemas,keyFields} from '../tests/fixtures/symbol-collisions/topics';
import {compactRowId,deleteRowId} from './row-id-selector';
import type {Int64} from './topic-schema';
type Equal<A,B>=(<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2)?true:false;
type Check<T extends true>=T;
type Topics=Check<Equal<keyof typeof catalog,'catalog'|'class'|'balanceKeyFields'|'defineSchema'|'defineCatalog'|'schemas'|'keyFields'|'comparison_products'|'comparisonProducts'>>;
type AliasA=Check<Equal<typeof schemas['comparison_products']['id'],'comparison_products_v2'>>;
type AliasB=Check<Equal<typeof schemas['comparisonProducts']['id'],'comparisonProducts_v2'>>;
type KeyA=Check<Equal<typeof keyFields['BalanceKey'][number]['name'],'tenant'|'account'>>;
type KeyB=Check<Equal<typeof keyFields['balanceKey'][number]['name'],'different'>>;
const hooks=createTopicHooks(catalog);
function contracts(){
 const result=hooks.useLiveQuery('class',{select:['quantity'],where:{op:'gt',field:'risk',value:0},orderBy:[{field:'risk',direction:'desc'}]});
 type Keys=Check<Equal<keyof typeof result.rows[number],'quantity'|'rowId'>>;
 type Value=Check<Equal<typeof result.rows[number]['quantity'],Int64>>;
 // @ts-expect-error exact topic ID required.
 hooks.useLiveQuery('Class',{select:['quantity'],orderBy:[]});
 // @ts-expect-error key field is not selectable.
 hooks.useLiveQuery('class',{select:['account'],orderBy:[]});
 // @ts-expect-error rowId is readonly metadata.
 result.rows[0]!.rowId='x';
 // @ts-expect-error unselected business identity is excluded.
 result.rows[0]!.businessId;
 // @ts-expect-error filter/sort field does not leak into selection.
 result.rows[0]!.risk;
 const view=hooks.useLiveQueryViewport('balanceKeyFields');
 view.viewport.replace({window:{firstRow:0,lastRow:1},query:{select:['quantity'],where:{op:'gt',field:'risk',value:0},orderBy:[{field:'risk',direction:'desc'}]},sink:{setRowCount(){},setRowData(rows,keys){
 type Keys=Check<Equal<keyof typeof rows[number],'quantity'|'rowId'>>;
 const id:string=rows[0]!.rowId;const key:string=keys[0]!;const value:Int64=rows[0]!.quantity;
 // @ts-expect-error viewport metadata is readonly.
 rows[0]!.rowId='x';
 // @ts-expect-error unselected business identity is excluded.
 rows[0]!.businessId;
 // @ts-expect-error filter/sort field is excluded.
 rows[0]!.risk;void[id,key,value];}}});
 const whole=view.useWholeResult({select:['quantity'],where:{op:'gt',field:'risk',value:0},orderBy:[{field:'risk',direction:'desc'}]});
 type WholeKeys=Check<Equal<keyof typeof whole.rows[number],'quantity'|'rowId'>>;
 // @ts-expect-error whole helper metadata readonly.
 whole.rows[0]!.rowId='x';
 // @ts-expect-error unselected ID absent in whole helper.
 whole.rows[0]!.businessId;
 // @ts-expect-error sort-only field absent in whole helper.
 whole.rows[0]!.risk;
 compactRowId(keyFields['BalanceKey'],[{source:'key',field:'account'}]);
 compactRowId(keyFields['balanceKey'],[{source:'key',field:'different'}]);
 deleteRowId(keyFields['BalanceKey'],schemas['balanceKeyFields'],[{source:'value',field:'businessId'}]);
 // @ts-expect-error compact identity cannot use value fields.
 compactRowId(keyFields['BalanceKey'],[{source:'value',field:'businessId'}]);
 // @ts-expect-error value field is not a key field.
 compactRowId(keyFields['BalanceKey'],[{source:'key',field:'quantity'}]);
 // @ts-expect-error case-distinct key-message reference stays distinct.
 compactRowId(keyFields['balanceKey'],[{source:'key',field:'account'}]);
 // @ts-expect-error schema registry cannot supply generated key fields.
 compactRowId(schemas['balanceKeyFields'],[{source:'key',field:'account'}]);
 // @ts-expect-error key-field registry cannot supply a schema.
 deleteRowId(keyFields['BalanceKey'],keyFields['balanceKey'],[{source:'value',field:'different'}]);
}
void contracts;
