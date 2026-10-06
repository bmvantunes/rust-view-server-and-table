import {createTopicHooks} from './product-provider';
import {catalog,enums} from './generated/expanded-topics';
import {enumValue,type EnumValue,type AggregateDecimal,type AggregateInteger} from './topic-schema';
const hooks=createTopicHooks(catalog);
type Equal<A,B>=(<T>()=>T extends A?1:2)extends(<T>()=>T extends B?1:2)?true:false;
type Assert<T extends true>=T;
export function literal(){
 const query={select:['oo.name','oo.status'],orderBy:[{field:'oo.name',direction:'asc'}]} as const;
 const result=hooks.useLiveQuery('shit',query);
 const view=hooks.useLiveQueryViewport('shit');const helper=view.useWholeResult(query);
 type R=typeof result.rows[number];type Keys=Assert<Equal<keyof R,'oo'|'rowId'>>;
 type Child=Assert<Equal<keyof NonNullable<R['oo']>,'name'|'status'>>;
 type Domain=Assert<Equal<NonNullable<R['oo']>['status'],EnumValue<'example.common.Status'>>>;
 type Helper=Assert<Equal<typeof helper.rows[number],R>>;
 for(const row of result.rows){row.oo?.name.toUpperCase();
  // @ts-expect-error absent parent
  row.oo.name;
  // @ts-expect-error unselected sibling
  row.oo?.price;
  // @ts-expect-error readonly identity
  row.rowId='other';
 }
 view.viewport.replace({query,window:{firstRow:0,lastRow:3},sink:{setRowCount(){},setRowData(rows){type Sink=Assert<Equal<typeof rows[number],R>>;for(const row of Object.values(rows)){
  row.oo?.name.toUpperCase();
  // @ts-expect-error missing sibling in sink
  row.oo?.quantity;
 }}}});
 hooks.useLiveQuery('shit',{select:['oo.status'],where:{op:'eq',field:'oo.status',value:enums['example.common.Status'].OPEN},orderBy:[]});
 hooks.useLiveQuery('shit',{select:['oo.status'],where:{op:'in',field:'oo.status',values:[enumValue('example.common.Status',777)]},orderBy:[]});
 // @ts-expect-error overlapping numeric codes do not equate enum domains
 hooks.useLiveQuery('shit',{select:['oo.status'],where:{op:'eq',field:'oo.status',value:enums['other.Status'].OPEN},orderBy:[]});
 // @ts-expect-error enum arithmetic forbidden
 hooks.useLiveQuery('shit',{groupBy:['oo.name'],aggregates:{sum:{aggFunc:'sum',field:'oo.status'}},orderBy:[]});
 // @ts-expect-error alias ancestor collision
 hooks.useLiveQuery('shit',{groupBy:['oo.name'],aggregates:{oo:{aggFunc:'count'}},orderBy:[]});
}
export function dynamic(flag:boolean){
 const field=flag?'oo.name':'alternate.name';
 const query={select:[field,'label'],orderBy:[]} as const;
 const result=hooks.useLiveQuery('shit',query);
 for(const row of result.rows){row.label.toUpperCase();row.oo?.name?.toUpperCase();
  // @ts-expect-error dynamic choice does not promise this parent
  row.oo.name;
  // @ts-expect-error dynamic choice does not promise this leaf
  row.oo?.name.toUpperCase();
 }
 const leaf=flag?'oo.name':'oo.status';const selected=hooks.useLiveQuery('shit',{select:[leaf],orderBy:[]});
 for(const row of selected.rows){row.oo?.name?.toUpperCase();
  // @ts-expect-error dynamic leaf cannot promise name
  row.oo?.name.toUpperCase();
 }
 const numeric=flag?'oo.price':'oo.quantity';const grouped=hooks.useLiveQuery('shit',{groupBy:['oo.status'],aggregates:{total:{aggFunc:'sum',field:numeric},minimum:{aggFunc:'min',field:'oo.status'}},orderBy:[]});
 type Total=Assert<Equal<typeof grouped.rows[number]['total'],AggregateDecimal|AggregateInteger>>;
 type Minimum=Assert<Equal<typeof grouped.rows[number]['minimum'],EnumValue<'example.common.Status'>|null>>;
 return grouped;
}
