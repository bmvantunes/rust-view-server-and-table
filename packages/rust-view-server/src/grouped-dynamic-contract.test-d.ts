import {createTopicHooks} from './product-provider';
import {catalog} from './generated/topics';
import {catalog as optionalCatalog} from '../tests/fixtures/grouped/topics';
import type {AggregateCount,AggregateInteger,AggregateDecimal,Int64,Uint64,Decimal} from './topic-schema';
type Equal<A,B>=(<T>()=>T extends A?1:2)extends(<T>()=>T extends B?1:2)?true:false;
type Assert<T extends true>=T;
type IsAny<T>=0 extends (1&T)?true:false;
const hooks=createTopicHooks(catalog),optionalHooks=createTopicHooks(optionalCatalog);

export function numericChoices(flag:boolean){
 const field=flag?'risk':'quantity';
 const query={groupBy:['hedged'],aggregates:{total:{aggFunc:'sum',field},mean:{aggFunc:'avg',field}},orderBy:[]} as const;
 const result=hooks.useLiveQuery('positions',query);
 const viewport=hooks.useLiveQueryViewport('positions');
 const whole=viewport.useWholeResult(query);
 type R=typeof result.rows[number];
 type Sum=Assert<Equal<R['total'],number|AggregateInteger>>;
 type Avg=Assert<Equal<R['mean'],number|AggregateDecimal>>;
 type NotAny=Assert<Equal<IsAny<R|R['total']|R['mean']>,false>>;
 type Whole=Assert<Equal<typeof whole.rows[number],R>>;
 type Keys=Assert<Equal<keyof R,'hedged'|'total'|'mean'|'rowId'>>;
 viewport.viewport.replace({query,window:{firstRow:0,lastRow:2},sink:{setRowCount(){},setRowData(rows){
  type Sink=Assert<Equal<typeof rows[number],R>>;
  for(const row of Object.values(rows)){
   // @ts-expect-error dynamic number|string result needs narrowing in the sink
   row.total.toUpperCase();
   if(typeof row.total==='number')row.total.toFixed(2);else row.total.toUpperCase();
  }
 }}});
 for(const row of result.rows){
  // @ts-expect-error numeric branch cannot use a string method
  row.total.toUpperCase();
  // @ts-expect-error numeric average branch cannot use a string method
  row.mean.toUpperCase();
  // @ts-expect-error metadata remains readonly
  row.rowId='replacement';
  // @ts-expect-error ungrouped source field stays excluded
  row.quantity;
  if(typeof row.total==='number')row.total.toFixed(2);else row.total.toUpperCase();
  if(typeof row.mean==='number')row.mean.toFixed(2);else row.mean.toUpperCase();
 }
 return result;
}
export function presenceChoices(flag:boolean){
 const field=flag?'note':'customer';
 const result=hooks.useLiveQuery('orders',{groupBy:['open'],aggregates:{lo:{aggFunc:'min',field},hi:{aggFunc:'max',field}},orderBy:[]});
 type Value=Assert<Equal<typeof result.rows[number]['lo'|'hi'],string|null>>;
 for(const row of result.rows){
  // @ts-expect-error no contributors can produce null
  row.lo.toUpperCase();
  if(row.lo!==null)row.lo.toUpperCase();
 }
 // Optional-only (not nullable) source field still permits zero contributors.
 const optionalField=flag?'label':'category';
 const optional=hooks.useLiveQuery('comparison_products',{groupBy:['category'],aggregates:{lo:{aggFunc:'min',field:optionalField}},orderBy:[]});
 type Optional=Assert<Equal<typeof optional.rows[number]['lo'],string|null>>;
 return result;
}
export function operationChoices(flag:boolean){
 const aggFunc=flag?'avg':'sum';
 const query={groupBy:['open'],aggregates:{value:{aggFunc,field:'units'}},orderBy:[]} as const;
 const result=hooks.useLiveQuery('orders',query);
 const viewport=hooks.useLiveQueryViewport('orders');const whole=viewport.useWholeResult(query);
 type R=typeof result.rows[number];
 type Value=Assert<Equal<R['value'],AggregateInteger|AggregateDecimal>>;
 type Whole=Assert<Equal<typeof whole.rows[number],R>>;
 viewport.viewport.replace({query,window:{firstRow:0,lastRow:2},sink:{setRowCount(){},setRowData(rows){type Sink=Assert<Equal<typeof rows[number],R>>;}}});
 for(const row of result.rows){
  // @ts-expect-error neither wider sum nor average has the source uint64 brand
  const source:Uint64=row.value;
  row.value.toUpperCase();
 }
 const op=flag?'min':'max';
 const extrema=hooks.useLiveQuery('orders',{groupBy:['open'],aggregates:{value:{aggFunc:op,field:'price'}},orderBy:[]});
 type Extrema=Assert<Equal<typeof extrema.rows[number]['value'],Decimal>>;
 const distinctOrMin=flag?'countDistinct':'min';
 const mixed=hooks.useLiveQuery('positions',{groupBy:['hedged'],aggregates:{value:{aggFunc:distinctOrMin,field:'risk'}},orderBy:[]});
 type Mixed=Assert<Equal<typeof mixed.rows[number]['value'],AggregateCount|number>>;
 return result;
}
export function optionalNumericChoices(flag:boolean){
 const numberDecimal=flag?'number':'decimal',integerFields=flag?'signed':'unsigned';
 const query={groupBy:['group'],aggregates:{
  sum:{aggFunc:'sum',field:numberDecimal},avg:{aggFunc:'avg',field:numberDecimal},
  lo:{aggFunc:'min',field:numberDecimal},hi:{aggFunc:'max',field:numberDecimal},
  integer:{aggFunc:'sum',field:integerFields},integerAvg:{aggFunc:'avg',field:integerFields},
  integerMin:{aggFunc:'min',field:integerFields},count:{aggFunc:'count'},distinct:{aggFunc:'countDistinct',field:numberDecimal}
 },orderBy:[]} as const;
 const result=optionalHooks.useLiveQuery('grouped_fixture',query);
 const viewport=optionalHooks.useLiveQueryViewport('grouped_fixture');const whole=viewport.useWholeResult(query);
 type R=typeof result.rows[number];
 type Sum=Assert<Equal<R['sum'],number|AggregateDecimal>>;
 type Avg=Assert<Equal<R['avg'],number|AggregateDecimal|null>>;
 type Extrema=Assert<Equal<R['lo'|'hi'],number|Decimal|null>>;
 type Integer=Assert<Equal<R['integer'],AggregateInteger>>;
 type IntegerAvg=Assert<Equal<R['integerAvg'],AggregateDecimal|null>>;
 type IntegerMin=Assert<Equal<R['integerMin'],Int64|Uint64|null>>;
 type Counts=Assert<Equal<R['count'|'distinct'],AggregateCount>>;
 type Group=Assert<Equal<R['group'],string|null|undefined>>;
 type RequiredAlias=Assert<Equal<{} extends Pick<R,'avg'>?true:false,false>>;
 type Whole=Assert<Equal<typeof whole.rows[number],R>>;
 type NotAny=Assert<Equal<IsAny<R|R['sum']|R['avg']|R['integer']>,false>>;
 viewport.viewport.replace({query,window:{firstRow:0,lastRow:2},sink:{setRowCount(){},setRowData(rows){type Sink=Assert<Equal<typeof rows[number],R>>;}}});
 for(const row of whole.rows){
  // @ts-expect-error helper result may be number or null
  row.avg.toUpperCase();
  if(row.avg!==null){if(typeof row.avg==='number')row.avg.toFixed();else row.avg.toUpperCase();}
 }
 const aggFunc=flag?'sum':'avg';
 const operations=optionalHooks.useLiveQuery('grouped_fixture',{groupBy:['group'],aggregates:{value:{aggFunc,field:integerFields}},orderBy:[]});
 type Operations=Assert<Equal<typeof operations.rows[number]['value'],AggregateInteger|AggregateDecimal|null>>;
 return result;
}
export function correlatedChoices(flag:boolean){
 // A cross-product would spuriously introduce Int64 and/or AggregateDecimal.
 const value=flag?{aggFunc:'min',field:'risk'} as const:{aggFunc:'sum',field:'quantity'} as const;
 const other=flag?{aggFunc:'avg',field:'risk'} as const:{aggFunc:'min',field:'quantity'} as const;
 const countOrMax=flag?{aggFunc:'count'} as const:{aggFunc:'max',field:'risk'} as const;
 const query={groupBy:['hedged'],aggregates:{value,other,countOrMax},orderBy:[]} as const;
 const result=hooks.useLiveQuery('positions',query);const viewport=hooks.useLiveQueryViewport('positions');const whole=viewport.useWholeResult(query);
 type R=typeof result.rows[number];
 type Value=Assert<Equal<R['value'],number|AggregateInteger>>;
 type Other=Assert<Equal<R['other'],number|Int64>>;
 type CountOrMax=Assert<Equal<R['countOrMax'],AggregateCount|number>>;
 type Whole=Assert<Equal<typeof whole.rows[number],R>>;
 viewport.viewport.replace({query,window:{firstRow:0,lastRow:2},sink:{setRowCount(){},setRowData(rows){type Sink=Assert<Equal<typeof rows[number],R>>;}}});
 return result;
}

// Literal results remain exact; union support does not widen every query.
const literals=hooks.useLiveQuery('orders',{groupBy:['note'],aggregates:{
 count:{aggFunc:'count'},distinct:{aggFunc:'countDistinct',field:'note'},
 sum:{aggFunc:'sum',field:'units'},avg:{aggFunc:'avg',field:'price'},
 min:{aggFunc:'min',field:'price'},max:{aggFunc:'max',field:'units'}
},orderBy:[]});
type Literal=typeof literals.rows[number];
type LiteralCount=Assert<Equal<Literal['count'],AggregateCount>>;
type LiteralDistinct=Assert<Equal<Literal['distinct'],AggregateCount>>;
type LiteralSum=Assert<Equal<Literal['sum'],AggregateInteger>>;
type LiteralAverage=Assert<Equal<Literal['avg'],AggregateDecimal>>;
type LiteralMinimum=Assert<Equal<Literal['min'],Decimal>>;
type LiteralMaximum=Assert<Equal<Literal['max'],Uint64>>;
type LiteralKeys=Assert<Equal<keyof Literal,'rowId'|'note'|'count'|'distinct'|'sum'|'avg'|'min'|'max'>>;
type LiteralGroup=Assert<Equal<Literal['note'],string|null|undefined>>;
type LiteralNotAny=Assert<Equal<IsAny<Literal>,false>>;
const raw=hooks.useLiveQuery('orders',{select:['units','note'],orderBy:[]});
type RawKeys=Assert<Equal<keyof typeof raw.rows[number],'rowId'|'units'|'note'>>;
type RawUnits=Assert<Equal<typeof raw.rows[number]['units'],Uint64>>;
