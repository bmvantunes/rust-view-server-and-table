import {createTopicHooks} from './product-provider';
import {catalog} from './generated/topics';
const hooks=createTopicHooks(catalog);
type Equal<A,B>=(<T>()=>T extends A?1:2)extends(<T>()=>T extends B?1:2)?true:false;
type Assert<T extends true>=T;
type IsAny<T>=0 extends (1&T)?true:false;

export function groupedField(flag:boolean){
 const field=flag?'symbol':'hedged';
 const query={groupBy:[field],aggregates:{total:{aggFunc:'sum',field:'risk'},mean:{aggFunc:'avg',field:'risk'}},orderBy:[]} as const;
 const result=hooks.useLiveQuery('positions',query);
 const viewport=hooks.useLiveQueryViewport('positions');const whole=viewport.useWholeResult(query);
 type R=typeof result.rows[number];
 type NotAny=Assert<Equal<IsAny<R|R['total']>,false>>;
 type SameHelper=Assert<Equal<typeof whole.rows[number],R>>;
 for(const row of result.rows){
  // @ts-expect-error A2_EXPECT: symbol is not present when grouping by hedged.
  row.symbol.toUpperCase();
  const countCheck:number=row.total; const identity:string=row.rowId;
 }
 for(const row of whole.rows){
  // @ts-expect-error A2_EXPECT: helper has the same false presence guarantee.
  row.symbol.toUpperCase();
 }
 viewport.viewport.replace({query,window:{firstRow:0,lastRow:9},sink:{setRowCount(){},setRowData(rows){
  type SameSink=Assert<Equal<typeof rows[number],R>>;
  for(const row of Object.values(rows)){
   // @ts-expect-error A2_EXPECT: sink cannot assume the unchosen group key exists.
   row.symbol.toUpperCase();
  }
 }}});
 return result;
}

export function groupedTuple(flag:boolean){
 const groupBy=flag?['symbol'] as const:['hedged'] as const;
 const result=hooks.useLiveQuery('positions',{groupBy,aggregates:{count:{aggFunc:'count'}},orderBy:[]});
 for(const row of result.rows){
  // @ts-expect-error A2_EXPECT: a union of complete tuples also promises both group keys.
  row.symbol.toUpperCase();
 }
 return result;
}

export function selectedField(flag:boolean){
 const field=flag?'symbol':'quantity';
 const query={select:[field],orderBy:[]} as const;
 const result=hooks.useLiveQuery('positions',query);
 const viewport=hooks.useLiveQueryViewport('positions');const whole=viewport.useWholeResult(query);
 type R=typeof result.rows[number];type NotAny=Assert<Equal<IsAny<R>,false>>;
 for(const row of result.rows){
  // @ts-expect-error A2_EXPECT: symbol is absent when only quantity is selected.
  row.symbol.toUpperCase();
 }
 for(const row of whole.rows){
  // @ts-expect-error A2_EXPECT: helper must not promise unselected symbol.
  row.symbol.toUpperCase();
 }
 viewport.viewport.replace({query,window:{firstRow:0,lastRow:9},sink:{setRowCount(){},setRowData(rows){
  type SameSink=Assert<Equal<typeof rows[number],R>>;
  for(const row of Object.values(rows)){
   // @ts-expect-error A2_EXPECT: sink has the same dynamic projection bug.
   row.symbol.toUpperCase();
  }
 }}});
 return result;
}

export function selectedTuple(flag:boolean){
 const select=flag?['symbol'] as const:['quantity'] as const;
 const result=hooks.useLiveQuery('positions',{select,orderBy:[]});
 for(const row of result.rows){
  // @ts-expect-error A2_EXPECT: union-valued select does not select both fields.
  row.symbol.toUpperCase();
 }
 return result;
}

// Literal controls are already correct, demonstrating that the fields are not
// secretly injected into every result. These directives must remain used.
const grouped=hooks.useLiveQuery('positions',{groupBy:['hedged'],aggregates:{total:{aggFunc:'sum',field:'risk'}},orderBy:[]});
// @ts-expect-error symbol is not a group key in this literal query.
grouped.rows[0]!.symbol;
const raw=hooks.useLiveQuery('positions',{select:['quantity'],orderBy:[]});
// @ts-expect-error symbol is not selected in this literal query.
raw.rows[0]!.symbol;

import type {AggregateCount,AggregateInteger,AggregateDecimal,Int64,Uint64} from './topic-schema';
type RequiredKeys<T>={[K in keyof T]-?:{} extends Pick<T,K>?never:K}[keyof T];
type UnionKeys<T>=T extends object?keyof T:never;
type GF=ReturnType<typeof groupedField>['rows'][number];
type SF=ReturnType<typeof selectedField>['rows'][number];
type GroupPossibleKeys=Assert<Equal<keyof GF,'symbol'|'hedged'|'total'|'mean'|'rowId'>>;
type GroupGuaranteed=Assert<Equal<RequiredKeys<GF>,'total'|'mean'|'rowId'>>;
type GroupSymbol=Assert<Equal<GF['symbol'],string|undefined>>;
type GroupHedged=Assert<Equal<GF['hedged'],boolean|undefined>>;
type GroupAggregate=Assert<Equal<GF['total'|'mean'],number>>;
type SelectPossibleKeys=Assert<Equal<keyof SF,'symbol'|'quantity'|'rowId'>>;
type SelectGuaranteed=Assert<Equal<RequiredKeys<SF>,'rowId'>>;
type SelectQuantity=Assert<Equal<SF['quantity'],Int64|undefined>>;
type TupleGroup=ReturnType<typeof groupedTuple>['rows'][number];
type TupleSelect=ReturnType<typeof selectedTuple>['rows'][number];
type TupleGroupKeys=Assert<Equal<RequiredKeys<TupleGroup>,'count'|'rowId'>>;
type TupleCount=Assert<Equal<TupleGroup['count'],AggregateCount>>;
type TupleSelectKeys=Assert<Equal<RequiredKeys<TupleSelect>,'rowId'>>;
function safeConsumers(group:GF,selected:SF){
 if(typeof group.symbol==='string')group.symbol.toUpperCase();
 if(group.hedged!==undefined){const value:boolean=group.hedged;}
 if('symbol' in selected && selected.symbol!==undefined)selected.symbol.toUpperCase();
 if(selected.quantity!==undefined)selected.quantity.toUpperCase();
 const identity:string=group.rowId;
 // @ts-expect-error metadata remains readonly for uncertain shapes
 group.rowId='x';
 // @ts-expect-error excluded source column is not added by the fallback
 group.positionId;
}

export function fixedAndDynamic(flag:boolean){
 const chosen=flag?'symbol':'quantity';
 const query={select:['risk',chosen],orderBy:[]} as const;
 const raw=hooks.useLiveQuery('positions',query),vp=hooks.useLiveQueryViewport('positions');const whole=vp.useWholeResult(query);
 type R=typeof raw.rows[number];
 type Keys=Assert<Equal<keyof R,'risk'|'symbol'|'quantity'|'rowId'>>;
 type Required=Assert<Equal<RequiredKeys<R>,'risk'|'rowId'>>;
 type Risk=Assert<Equal<R['risk'],number>>;
 type Whole=Assert<Equal<typeof whole.rows[number],R>>;
 vp.viewport.replace({query,window:{firstRow:0,lastRow:2},sink:{setRowCount(){},setRowData(rows){
  type Sink=Assert<Equal<typeof rows[number],R>>;
  for(const row of Object.values(rows)){row.risk.toFixed();if(row.symbol!==undefined)row.symbol.toUpperCase();}
 }}});
 const groupBy=flag?['symbol','hedged'] as const:['hedged','risk'] as const;
 const groupedQuery={groupBy,aggregates:{count:{aggFunc:'count'}},orderBy:[]} as const;
 const grouped=hooks.useLiveQuery('positions',groupedQuery);const groupedWhole=vp.useWholeResult(groupedQuery);
 type G=typeof grouped.rows[number];
 type GroupRequired=Assert<Equal<RequiredKeys<G>,'hedged'|'count'|'rowId'>>;
 type Hedged=Assert<Equal<G['hedged'],boolean>>;
 type Possible=Assert<Equal<keyof G,'symbol'|'risk'|'hedged'|'count'|'rowId'>>;
 type GroupWhole=Assert<Equal<typeof groupedWhole.rows[number],G>>;
 vp.viewport.replace({query:groupedQuery,window:{firstRow:0,lastRow:2},sink:{setRowCount(){},setRowData(rows){type Sink=Assert<Equal<typeof rows[number],G>>;}}});
 // A common field remains required even when it moves between tuple positions.
 const select=flag?['symbol','risk'] as const:['quantity','symbol'] as const;
 const common=hooks.useLiveQuery('positions',{select,orderBy:[]});
 type Common=typeof common.rows[number];
 type Guaranteed=Assert<Equal<RequiredKeys<Common>,'symbol'|'rowId'>>;
 for(const row of common.rows){row.symbol.toUpperCase();if(row.risk!==undefined)row.risk.toFixed();}
 return raw;
}

export function correlatedQueries(flag:boolean){
 const query=flag?{groupBy:['symbol'],aggregates:{total:{aggFunc:'sum',field:'risk'}},orderBy:[]} as const
 :{groupBy:['hedged'],aggregates:{total:{aggFunc:'sum',field:'quantity'}},orderBy:[]} as const;
 const result=hooks.useLiveQuery('positions',query),vp=hooks.useLiveQueryViewport('positions');const whole=vp.useWholeResult(query);
 type R=typeof result.rows[number];
 type NumberBranch=Assert<Equal<Extract<R,{symbol:string}>['total'],number>>;
 type ExactBranch=Assert<Equal<Extract<R,{hedged:boolean}>['total'],AggregateInteger>>;
 type Keys=Assert<Equal<UnionKeys<R>,'symbol'|'hedged'|'total'|'rowId'>>;
 type Shared=Assert<Equal<keyof R,'total'|'rowId'>>;
 type Same=Assert<Equal<typeof whole.rows[number],R>>;
 type NotAny=Assert<Equal<IsAny<R|R['total']>,false>>;
 vp.viewport.replace({query,window:{firstRow:0,lastRow:2},sink:{setRowCount(){},setRowData(rows){type Sink=Assert<Equal<typeof rows[number],R>>;}}});
 for(const row of result.rows){if('symbol' in row){row.symbol.toUpperCase();row.total.toFixed();}else{const b:boolean=row.hedged;row.total.toUpperCase();}}
 const rawQuery=flag?{select:['symbol'],orderBy:[]} as const:{select:['quantity'],orderBy:[]} as const;
 const raw=hooks.useLiveQuery('positions',rawQuery);const rawWhole=vp.useWholeResult(rawQuery);
 type Raw=typeof raw.rows[number];
 type RawSame=Assert<Equal<typeof rawWhole.rows[number],Raw>>;
 type RawKeys=Assert<Equal<UnionKeys<Raw>,'rowId'|'symbol'|'quantity'>>;
 vp.viewport.replace({query:rawQuery,window:{firstRow:0,lastRow:2},sink:{setRowCount(){},setRowData(rows){type Sink=Assert<Equal<typeof rows[number],Raw>>;}}});
 for(const row of raw.rows){if('symbol' in row)row.symbol.toUpperCase();else{const q:Int64=row.quantity;}}
 return result;
}

export function presenceAndValues(flag:boolean,other:boolean){
 const field=flag?'note':'customer';
 const query={groupBy:['open',field],aggregates:{n:{aggFunc:'count'},lowest:{aggFunc:'min',field}},orderBy:[]} as const;
 const result=hooks.useLiveQuery('orders',query),vp=hooks.useLiveQueryViewport('orders');const whole=vp.useWholeResult(query);
 type R=typeof result.rows[number];
 type Keys=Assert<Equal<keyof R,'rowId'|'open'|'note'|'customer'|'n'|'lowest'>>;
 type Required=Assert<Equal<RequiredKeys<R>,'rowId'|'open'|'n'|'lowest'>>;
 type Note=Assert<Equal<R['note'],string|null|undefined>>;
 type Customer=Assert<Equal<R['customer'],string|undefined>>;
 type Lowest=Assert<Equal<R['lowest'],string|null>>;
 type Whole=Assert<Equal<typeof whole.rows[number],R>>;
 vp.viewport.replace({query,window:{firstRow:0,lastRow:2},sink:{setRowCount(){},setRowData(rows){type Sink=Assert<Equal<typeof rows[number],R>>;}}});
 for(const row of result.rows){if(row.note!==null&&row.note!==undefined)row.note.toUpperCase();if(typeof row.customer==='string')row.customer.toUpperCase();}
 const raw=hooks.useLiveQuery('orders',{select:['units',field],orderBy:[]});
 type Raw=typeof raw.rows[number];
 type RawRequired=Assert<Equal<RequiredKeys<Raw>,'units'|'rowId'>>;
 type Units=Assert<Equal<Raw['units'],Uint64>>;
 type RawNote=Assert<Equal<Raw['note'],string|null|undefined>>;
 const optionalField=flag?'label':'category';
 const optional=hooks.useLiveQuery('comparison_products',{select:['quantity',optionalField],orderBy:[]});
 type OptionalLabel=Assert<Equal<typeof optional.rows[number]['label'],string|undefined>>;
 const group=flag?'symbol':'hedged',numeric=other?'risk':'quantity',aggFunc=flag?'avg':'sum';
 const combined=hooks.useLiveQuery('positions',{groupBy:[group],aggregates:{value:{aggFunc,field:numeric}},orderBy:[]});
 type C=typeof combined.rows[number];
 type Value=Assert<Equal<C['value'],number|AggregateInteger|AggregateDecimal>>;
 type RequiredCombined=Assert<Equal<RequiredKeys<C>,'rowId'|'value'>>;
 type CombinedKeys=Assert<Equal<keyof C,'symbol'|'hedged'|'rowId'|'value'>>;
 const correlated=other?{aggFunc:'avg',field:'risk'} as const:{aggFunc:'min',field:'quantity'} as const;
 const mixed=hooks.useLiveQuery('positions',{groupBy:[group],aggregates:{value:correlated},orderBy:[]});
 type CorrelatedValue=Assert<Equal<typeof mixed.rows[number]['value'],number|Int64>>;
 return result;
}

// Bounded conservative fallback for a variadic tail keeps the fixed prefix.
export function variadicProjection(extras:readonly ('symbol'|'quantity')[]){
 const result=hooks.useLiveQuery('positions',{select:['risk',...extras],orderBy:[]});
 type R=typeof result.rows[number];
 type Required=Assert<Equal<RequiredKeys<R>,'risk'|'rowId'>>;
 type Keys=Assert<Equal<keyof R,'risk'|'symbol'|'quantity'|'rowId'>>;
 type Symbol=Assert<Equal<R['symbol'],string|undefined>>;
 return result;
}
const exactRaw=hooks.useLiveQuery('orders',{select:['customer','note'],orderBy:[]});
type ExactRaw=typeof exactRaw.rows[number];
type ExactRawKeys=Assert<Equal<keyof ExactRaw,'rowId'|'customer'|'note'>>;
type ExactRawRequired=Assert<Equal<RequiredKeys<ExactRaw>,'rowId'|'customer'>>;
type ExactCustomer=Assert<Equal<ExactRaw['customer'],string>>;
type ExactNote=Assert<Equal<ExactRaw['note'],string|null|undefined>>;
const exactGrouped=hooks.useLiveQuery('orders',{groupBy:['customer','note'],aggregates:{sum:{aggFunc:'sum',field:'units'}},orderBy:[]});
type ExactGrouped=typeof exactGrouped.rows[number];
type ExactGroupKeys=Assert<Equal<keyof ExactGrouped,'rowId'|'customer'|'note'|'sum'>>;
type ExactGroupRequired=Assert<Equal<RequiredKeys<ExactGrouped>,'rowId'|'customer'|'sum'>>;
type ExactSum=Assert<Equal<ExactGrouped['sum'],AggregateInteger>>;

// Independent finite choices stay conservative without expanding their cross-product.
export function independentElements(a:boolean,b:boolean){
 const first=a?'symbol':'positionId',second=b?'risk':'quantity';
 const result=hooks.useLiveQuery('positions',{groupBy:[first,second],aggregates:{count:{aggFunc:'count'}},orderBy:[]});
 type R=typeof result.rows[number];
 type Required=Assert<Equal<RequiredKeys<R>,'count'|'rowId'>>;
 type Keys=Assert<Equal<keyof R,'symbol'|'positionId'|'risk'|'quantity'|'count'|'rowId'>>;
 return result;
}

// A wide literal retains the guaranteed field at the end of its tuple.
const wide=hooks.useLiveQuery('wide',{select:["recordId", "field01", "field02", "field03", "field04", "field05", "field06", "field07", "field08", "field09", "field10", "field11", "field12", "field13", "field14", "field15", "field16", "field17", "field18", "field19", "field20", "field21", "field22", "field23", "field24", "field25", "field26", "field27", "field28", "field29", "field30", "field31", "field32", "field33", "field34", "field35"],orderBy:[]});
type WideRequired=Assert<Equal<RequiredKeys<typeof wide.rows[number]>,'recordId'|'field01'|'field02'|'field03'|'field04'|'field05'|'field06'|'field07'|'field08'|'field09'|'field10'|'field11'|'field12'|'field13'|'field14'|'field15'|'field16'|'field17'|'field18'|'field19'|'field20'|'field21'|'field22'|'field23'|'field24'|'field25'|'field26'|'field27'|'field28'|'field29'|'field30'|'field31'|'field32'|'field33'|'field34'|'field35'|'rowId'>>;
