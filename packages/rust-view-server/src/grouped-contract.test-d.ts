import {createTopicHooks} from './product-provider';
import {catalog} from './generated/topics';
import type {AggregateCount,AggregateInteger,AggregateDecimal,Decimal,Uint64} from './topic-schema';
const hooks=createTopicHooks(catalog);
const query={groupBy:['note'],aggregates:{n:{aggFunc:'count'},d:{aggFunc:'countDistinct',field:'note'},s:{aggFunc:'sum',field:'units'},a:{aggFunc:'avg',field:'price'},lo:{aggFunc:'min',field:'price'},hi:{aggFunc:'max',field:'units'}},orderBy:[{aggregate:'s',direction:'desc'}]} as const;
const result=hooks.useLiveQuery('orders',query);
type Equal<A,B>=(<T>()=>T extends A?1:2)extends(<T>()=>T extends B?1:2)?true:false;
type Assert<T extends true>=T;
type Keys=Assert<Equal<keyof typeof result.rows[number],'rowId'|'note'|'n'|'d'|'s'|'a'|'lo'|'hi'>>;
const check=(r:typeof result.rows[number])=>{const n:AggregateCount=r.n;const d:AggregateCount=r.d;const s:AggregateInteger=r.s;const a:AggregateDecimal=r.a;const lo:Decimal=r.lo;const hi:Uint64=r.hi;const note:string|null|undefined=r.note;
 // @ts-expect-error readonly metadata
 r.rowId='x';
 // @ts-expect-error source field excluded
 r.customer;
 // @ts-expect-error widened integer is not uint64
 const wrong:Uint64=r.s;
 return [n,d,s,a,lo,hi,note,wrong];};
const viewport=hooks.useLiveQueryViewport('orders');const whole=viewport.useWholeResult(query);type Whole=Assert<Equal<typeof whole.rows[number],typeof result.rows[number]>>;
viewport.viewport.replace({window:{firstRow:0,lastRow:5},query,sink:{setRowCount(){},setRowData(rows){type SinkKeys=Assert<Equal<keyof typeof rows[number],keyof typeof result.rows[number]>>;for(const r of Object.values(rows))check(r);}}});
const nullable=hooks.useLiveQuery('orders',{groupBy:['customer'],aggregates:{lo:{aggFunc:'min',field:'note'},hi:{aggFunc:'max',field:'note'}},orderBy:[]});type Null=Assert<Equal<typeof nullable.rows[number]['lo'],string|null>>;
const numbers=hooks.useLiveQuery('positions',{groupBy:['hedged'],aggregates:{sum:{aggFunc:'sum',field:'risk'},avg:{aggFunc:'avg',field:'risk'},lo:{aggFunc:'min',field:'risk'},hi:{aggFunc:'max',field:'risk'}},orderBy:[{field:'hedged',direction:'asc'}]});type Numbers=Assert<Equal<typeof numbers.rows[number]['sum'|'avg'|'lo'|'hi'],number>>;
// @ts-expect-error grouped selection forbidden
hooks.useLiveQuery('orders',{...query,select:['units']});
// @ts-expect-error count field forbidden
hooks.useLiveQuery('orders',{...query,aggregates:{n:{aggFunc:'count',field:'units'}}});
// @ts-expect-error numeric input required
hooks.useLiveQuery('orders',{...query,aggregates:{n:{aggFunc:'sum',field:'note'}}});
// @ts-expect-error raw aggregate sort forbidden
hooks.useLiveQuery('orders',{select:['units'],orderBy:[{aggregate:'s',direction:'asc'}]});
// @ts-expect-error ungrouped sort forbidden
hooks.useLiveQuery('orders',{...query,orderBy:[{field:'customer',direction:'asc'}]});
// @ts-expect-error undeclared alias sort
hooks.useLiveQuery('orders',{...query,orderBy:[{aggregate:'unknown',direction:'asc'}]});
// @ts-expect-error alias collision
hooks.useLiveQuery('orders',{...query,aggregates:{note:{aggFunc:'count'}}});
// @ts-expect-error prototype alias
hooks.useLiveQuery('orders',{...query,aggregates:{constructor:{aggFunc:'count'}}});
// @ts-expect-error metadata alias
hooks.useLiveQuery('orders',{...query,aggregates:{rowId:{aggFunc:'count'}}});
// @ts-expect-error duplicate group
hooks.useLiveQuery('orders',{...query,groupBy:['note','note']});
// @ts-expect-error empty aggregates
hooks.useLiveQuery('orders',{...query,aggregates:{}});
// @ts-expect-error empty group
hooks.useLiveQuery('orders',{...query,groupBy:[]});
// @ts-expect-error bad numeric field through viewport helper
viewport.useWholeResult({...query,aggregates:{x:{aggFunc:'avg',field:'open'}}});
// @ts-expect-error duplicate selection remains invalid
hooks.useLiveQuery('orders',{select:['units','units'],orderBy:[]});
import {catalog as fixtureCatalog} from '../tests/fixtures/grouped/topics';
import type {Int64} from './topic-schema';
const fixture=createTopicHooks(fixtureCatalog);
const optional=fixture.useLiveQuery('grouped_fixture',{groupBy:['group'],aggregates:{n:{aggFunc:'count'},distinct:{aggFunc:'countDistinct',field:'number'},ns:{aggFunc:'sum',field:'number'},na:{aggFunc:'avg',field:'number'},ia:{aggFunc:'avg',field:'signed'},us:{aggFunc:'sum',field:'unsigned'},ds:{aggFunc:'sum',field:'decimal'},lo:{aggFunc:'min',field:'signed'},hi:{aggFunc:'max',field:'boolean'}},orderBy:[]});
type OptionalNumber=Assert<Equal<typeof optional.rows[number]['na'],number|null>>;
type OptionalAverage=Assert<Equal<typeof optional.rows[number]['ia'],AggregateDecimal|null>>;
type OptionalMin=Assert<Equal<typeof optional.rows[number]['lo'],Int64|null>>;
type OptionalMax=Assert<Equal<typeof optional.rows[number]['hi'],boolean|null>>;
type SumNumber=Assert<Equal<typeof optional.rows[number]['ns'],number>>;
type SumUnsigned=Assert<Equal<typeof optional.rows[number]['us'],AggregateInteger>>;
type SumDecimal=Assert<Equal<typeof optional.rows[number]['ds'],AggregateDecimal>>;

const matrix=fixture.useLiveQuery('grouped_fixture',{groupBy:['group'],aggregates:{slo:{aggFunc:'min',field:'group'},shi:{aggFunc:'max',field:'group'},nlo:{aggFunc:'min',field:'number'},nhi:{aggFunc:'max',field:'number'},ilo:{aggFunc:'min',field:'signed'},ihi:{aggFunc:'max',field:'signed'},ulo:{aggFunc:'min',field:'unsigned'},uhi:{aggFunc:'max',field:'unsigned'},dlo:{aggFunc:'min',field:'decimal'},dhi:{aggFunc:'max',field:'decimal'},blo:{aggFunc:'min',field:'boolean'},bhi:{aggFunc:'max',field:'boolean'}},orderBy:[]});
type MatrixString=Assert<Equal<typeof matrix.rows[number]['slo'|'shi'],string|null>>;
type MatrixNumber=Assert<Equal<typeof matrix.rows[number]['nlo'|'nhi'],number|null>>;
type MatrixSigned=Assert<Equal<typeof matrix.rows[number]['ilo'|'ihi'],Int64|null>>;
type MatrixUnsigned=Assert<Equal<typeof matrix.rows[number]['ulo'|'uhi'],Uint64|null>>;
type MatrixDecimal=Assert<Equal<typeof matrix.rows[number]['dlo'|'dhi'],Decimal|null>>;
type MatrixBoolean=Assert<Equal<typeof matrix.rows[number]['blo'|'bhi'],boolean|null>>;
// @ts-expect-error duplicate aggregate sort
hooks.useLiveQuery('orders',{...query,orderBy:[{aggregate:'s',direction:'asc'},{aggregate:'s',direction:'desc'}]});
// @ts-expect-error invalid alias grammar
hooks.useLiveQuery('orders',{...query,aggregates:{'bad-name':{aggFunc:'count'}}});
// @ts-expect-error unsupported aggregate
hooks.useLiveQuery('orders',{...query,aggregates:{x:{aggFunc:'median',field:'units'}}});
