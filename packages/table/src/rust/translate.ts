import * as BigDecimal from 'effect/BigDecimal';
import {defineCatalog, validateScalar, validateQuery, validateRow, validateGroupedRow, queryFields, type Schema, type Row, type Field, type BrowserCatalog, type TopicQuery} from '@bruno/view-server-client/schema';
import type {TopicRuntimeQuery, ProductResult} from '@bruno/view-server-client/react';
import type {CompleteSelect, CompatRow, CompatResult, Query} from './types.ts';

type WirePredicate = {readonly op:'text';readonly field:string;readonly value:string;readonly match_kind:'eq'|'ne'|'contains'|'notContains'|'startsWith'|'endsWith';readonly case_sensitive?:boolean;readonly accent_sensitive?:boolean}|{readonly op:'in';readonly field:string;readonly values:readonly (string|number|boolean)[]}|{readonly op:'text_in';readonly field:string;readonly values:readonly string[];readonly case_sensitive?:boolean;readonly accent_sensitive?:boolean}|{readonly op:'eq'|'ge'|'gt'|'le'|'lt';readonly field:string;readonly value:string|number|boolean}|{readonly op:'is_value'|'is_missing'|'is_null';readonly field:string}|{readonly op:'and'|'or';readonly clauses:readonly WirePredicate[]}|{readonly op:'not';readonly clause:WirePredicate};
// Runtime records are untrusted input only. Public query and result types live in types.ts.
function record(value:unknown):value is {[key:string]:unknown}{return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function fail(reason:string):never{throw new Error(`Bruno compatibility: ${reason}`);}
function exact(value:{[key:string]:unknown},keys:readonly string[]){if(Object.keys(value).some(k=>!keys.includes(k)))fail('unsupported query property');}
// Effect format intentionally switches to scientific notation at scale 16. The wire
// requires canonical plain notation: manipulate only the exact coefficient and scale.
function decimalParts(input:BigDecimal.BigDecimal):{digits:string;scale:number;negative:boolean}{
 if(typeof input.value!=='bigint'||!Number.isSafeInteger(input.scale)||Math.abs(input.scale)>4096)fail('BigDecimal bound');
 const negative=input.value<0n,digits=(negative?-input.value:input.value).toString();if(digits.length>4096)fail('BigDecimal bound');return {digits,scale:input.scale,negative};
}
function plainDecimal(input:BigDecimal.BigDecimal):string{
 let {digits,scale,negative}=decimalParts(input);if(digits==='0')return '0';
 const trimmed=digits.replace(/0+$/,'');scale-=digits.length-trimmed.length;digits=trimmed;
 const point=digits.length-scale;
 const plain=scale<=0?digits+'0'.repeat(-scale):point<=0?'0.'+'0'.repeat(-point)+digits:digits.slice(0,point)+'.'+digits.slice(point);
 return negative?'-'+plain:plain;
}
function own(value:unknown,depth=0,budget={nodes:0}):unknown{if(++budget.nodes>8192||depth>16)fail('query snapshot bound');if(BigDecimal.isBigDecimal(value)){decimalParts(value);return Object.freeze(BigDecimal.make(value.value,value.scale));}if(Array.isArray(value))return Object.freeze(value.map(v=>own(v,depth+1,budget)));if(record(value)){const entries=Object.entries(value);if(entries.some(([k])=>['__proto__','constructor','prototype'].includes(k)))fail('unsafe property');return Object.freeze(Object.fromEntries(entries.map(([k,v])=>[k,own(v,depth+1,budget)])));}return value;}
function canonical(value:unknown):unknown{if(BigDecimal.isBigDecimal(value))return ['decimal',plainDecimal(value)];if(typeof value==='bigint')return ['bigint',value.toString()];if(Array.isArray(value))return value.map(canonical);if(record(value))return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));return value;}
export function semanticKey(value:unknown):string{return JSON.stringify(canonical(value));}
export function admitCatalog<const C extends BrowserCatalog>(input:C):C{const catalog=defineCatalog(input);for(const {schema} of Object.values(catalog)){if(schema.expansion||schema.fields.some(f=>f.name.includes('.')||f.kind==='enum'))fail('only flat materialized scalar catalogs are supported');}return catalog;}
// Sole generic assertion boundary. Calls follow either complete schema-field enumeration,
// or core row validation plus schema-directed exact scalar conversion and authoritative key checks.
function admitted<T>(value:unknown):T{return value as T;}
export function completeSelect<S extends Schema>(schema:S):CompleteSelect<S>{const fields=schema.fields.map(f=>f.name);if(!fields.length)fail('empty source schema');return admitted<CompleteSelect<S>>(Object.freeze(fields));}
export type Alias={readonly public:string;readonly native:string;readonly op:'count'|'countDistinct'|'sum'|'avg'|'min'|'max';readonly field?:Field};
export type Compiled={readonly query:TopicQuery<Schema>;readonly wire:TopicRuntimeQuery;readonly aliases:readonly Alias[];readonly selected:readonly string[];readonly key:string;readonly grouped:boolean};
function field(schema:Schema,name:unknown):Field{if(typeof name!=='string')return fail('field must be a string');const found=schema.fields.find(f=>f.name===name);return found??fail(`unknown or unsupported field ${name}`);}
function value(f:Field,input:unknown):string|number|boolean|null{if(input===null){validateScalar(f,input);return null;}let scalar:unknown=input;if(f.kind==='int64'||f.kind==='uint64'){if(typeof input!=='bigint')fail(`${f.name} requires bigint`);scalar=input.toString();}else if(f.kind==='decimal'){if(!BigDecimal.isBigDecimal(input))fail(`${f.name} requires Effect BigDecimal`);scalar=plainDecimal(input);}validateScalar(f,scalar);if(typeof scalar!=='string'&&typeof scalar!=='number'&&typeof scalar!=='boolean')return fail('unsupported scalar');return scalar;}
function falseFor(schema:Schema):WirePredicate{const f=schema.fields[0];return {op:'and',clauses:[{op:'is_value',field:f.name},{op:'not',clause:{op:'is_value',field:f.name}}]};}
function boolean(schema:Schema,op:'and'|'or',clauses:WirePredicate[]):WirePredicate{if(clauses.length){const flattened=clauses.flatMap(c=>c.op===op&&'clauses'in c?c.clauses:[c]);const keyed=new Map(flattened.map(c=>[semanticKey(c),c]));const sorted=[...keyed].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,c])=>c);return sorted.length===1?sorted[0]:{op,clauses:sorted};}const no=falseFor(schema);return op==='or'?no:{op:'not',clause:no};}
function predicate(schema:Schema,input:unknown,depth=0,budget={nodes:0}):WirePredicate{
 if(++budget.nodes>128||depth>8||!record(input))return fail('filter bound/shape');
 if(input.type==='FALSE'){exact(input,['type']);return falseFor(schema);}
 if(input.type==='AND'||input.type==='OR'){exact(input,['type','conditions']);if(!Array.isArray(input.conditions)||input.conditions.length>64)fail('Boolean condition bound');return boolean(schema,input.type==='AND'?'and':'or',input.conditions.map(v=>predicate(schema,v,depth+1,budget)));}
 if(input.type==='NOT'){exact(input,['type','condition']);return {op:'not',clause:predicate(schema,input.condition,depth+1,budget)};}
 exact(input,['field','type','filter','filterTo','caseSensitive','accentSensitive']);const f=field(schema,input.field);
 if((Object.hasOwn(input,'caseSensitive')&&typeof input.caseSensitive!=='boolean')||(Object.hasOwn(input,'accentSensitive')&&typeof input.accentSensitive!=='boolean'))fail('text options must be booleans');if(f.kind!=='string'&&(Object.hasOwn(input,'caseSensitive')||Object.hasOwn(input,'accentSensitive')))fail('text options require string');
 if(input.type==='blank'||input.type==='notBlank'){if(Object.hasOwn(input,'filter')||Object.hasOwn(input,'filterTo'))fail('blank operand');const clauses:WirePredicate[]=[];if(f.optional)clauses.push({op:'is_missing',field:f.name});if(f.nullable)clauses.push({op:'is_null',field:f.name});if(f.kind==='string')clauses.push({op:'eq',field:f.name,value:''});const blank=boolean(schema,'or',clauses);return input.type==='blank'?blank:{op:'not',clause:blank};}
 if(f.kind==='string'){
  if(input.type==='in'){
   if(!Array.isArray(input.filter)||input.filter.length>4096||Object.hasOwn(input,'filterTo'))fail('IN operand bound');
   const includesNull=input.filter.some(filter=>filter===null);if(includesNull)validateScalar(f,null);const keyed=new Map<string,string>();
   for(const filter of input.filter){if(filter===null)continue;if(typeof filter!=='string')return fail('string IN operand');validateScalar(f,filter);keyed.set(semanticKey(filter),filter);}
   const values=[...keyed].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,filter])=>filter);const clauses:WirePredicate[]=[];
   if(values.length)clauses.push({op:'text_in',field:f.name,values,...(Object.hasOwn(input,'caseSensitive')?{case_sensitive:input.caseSensitive===true}:{}),...(Object.hasOwn(input,'accentSensitive')?{accent_sensitive:input.accentSensitive===true}:{})});
   if(includesNull)clauses.push({op:'is_null',field:f.name});return boolean(schema,'or',clauses);
  }
  if((input.type==='equals'||input.type==='notEqual')&&input.filter===null){validateScalar(f,null);const eq:WirePredicate={op:'is_null',field:f.name};return input.type==='equals'?eq:{op:'not',clause:eq};}
  if(Object.hasOwn(input,'filterTo')||typeof input.filter!=='string')fail('text operand');validateScalar(f,input.filter);
  const match_kind=input.type==='equals'?'eq':input.type==='notEqual'?'ne':input.type==='contains'?'contains':input.type==='notContains'?'notContains':input.type==='startsWith'?'startsWith':input.type==='endsWith'?'endsWith':fail('unsupported text operator');
  return {op:'text',field:f.name,value:input.filter,match_kind,...(Object.hasOwn(input,'caseSensitive')?{case_sensitive:input.caseSensitive===true}:{}),...(Object.hasOwn(input,'accentSensitive')?{accent_sensitive:input.accentSensitive===true}:{})};
 }
 const equals=(operand:unknown):WirePredicate=>{const v=value(f,operand);return v===null?{op:'is_null',field:f.name}:{op:'eq',field:f.name,value:v};};
 if(input.type==='equals'||input.type==='notEqual'){if(Object.hasOwn(input,'filterTo'))fail('unexpected second operand');const eq=equals(input.filter);return input.type==='equals'?eq:{op:'not',clause:eq};}
 if(input.type==='in'){
  if(!Array.isArray(input.filter)||input.filter.length>4096||Object.hasOwn(input,'filterTo'))fail('IN operand bound');
  const includesNull=input.filter.some(filter=>filter===null);if(includesNull)value(f,null);const keyed=new Map<string,string|number|boolean>();
  for(const filter of input.filter){if(filter===null)continue;const scalar=value(f,filter);if(scalar===null)continue;keyed.set(semanticKey(scalar),scalar);}
  const values=[...keyed].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,scalar])=>scalar);const clauses:WirePredicate[]=[];
  if(values.length)clauses.push({op:'in',field:f.name,values});if(includesNull)clauses.push({op:'is_null',field:f.name});return boolean(schema,'or',clauses);
 }
 if(f.kind==='boolean')fail('Boolean ordering comparison unsupported');
 const scalar=(v:unknown)=>{const s=value(f,v);if(s===null)fail('null numeric comparison');return s;};
 if(input.type==='inRange')return {op:'and',clauses:[{op:'ge',field:f.name,value:scalar(input.filter)},{op:'lt',field:f.name,value:scalar(input.filterTo)}]};
 if(Object.hasOwn(input,'filterTo'))fail('unexpected second operand');
 const op=input.type==='greaterThan'?'gt':input.type==='greaterThanOrEqual'?'ge':input.type==='lessThan'?'lt':input.type==='lessThanOrEqual'?'le':fail('unsupported filter operator');return {op,field:f.name,value:scalar(input.filter)};
}
export function compile(schema:Schema,topic:string,fingerprint:string,input:unknown):Compiled{
 const snapshot=own(input);if(!record(snapshot))return fail('query must be an object');exact(snapshot,['select','groupBy','aggregates','where','orderBy']);
 if(!Array.isArray(snapshot.where)||snapshot.where.length>64||!Array.isArray(snapshot.orderBy)||snapshot.orderBy.length>8)fail('where/orderBy bound');
 const clauses=snapshot.where.map(v=>predicate(schema,v));const where=clauses.length?boolean(schema,'and',clauses):undefined;
 const grouped=Object.hasOwn(snapshot,'groupBy');const selected=grouped?snapshot.groupBy:snapshot.select;if(!Array.isArray(selected)||selected.length<1||selected.length>64||new Set(selected).size!==selected.length)fail('projection/groupBy bound');const names=selected.map(n=>field(schema,n).name);if(!grouped)names.sort();
 if(grouped&&Object.hasOwn(snapshot,'select')||!grouped&&Object.hasOwn(snapshot,'aggregates'))fail('mixed raw/grouped query');
 const aliases:Alias[]=[];
 if(grouped){if(!record(snapshot.aggregates)||Object.keys(snapshot.aggregates).length<1||Object.keys(snapshot.aggregates).length>32)fail('aggregate bound');for(const [publicName,a] of Object.entries(snapshot.aggregates).sort(([a],[b])=>a<b?-1:a>b?1:0)){if(!publicName||publicName.length>4096||['rowId','__proto__','constructor','prototype'].includes(publicName)||names.includes(publicName)||!record(a))fail('aggregate alias/shape');exact(a,['aggFunc','field']);const op=a.aggFunc;if(!['count','countDistinct','sum','avg','min','max'].includes(String(op)))fail('unsupported aggregate');if(op!=='count'&&op!=='countDistinct'&&op!=='sum'&&op!=='avg'&&op!=='min'&&op!=='max')fail('aggregate operation');const f=op==='count'?undefined:field(schema,a.field);if(op==='count'&&Object.hasOwn(a,'field'))fail('count field');if(f&&(op==='sum'||op==='avg')&&(!['number','decimal','int64','uint64'].includes(f.kind)||f.nullable))fail('numeric aggregate requires nonnullable numeric field');let native='compatAgg'+aliases.length;while(names.includes(native))native+='x';aliases.push(Object.freeze({public:publicName,native,op,...(f?{field:f}:{})}));}}
 const orderBy=snapshot.orderBy.map(order=>{if(!record(order)||!['asc','desc'].includes(String(order.direction)))return fail('order shape');exact(order,['field','aggregate','direction']);const direction=order.direction==='asc'?'asc' as const:'desc' as const;if(Object.hasOwn(order,'aggregate')){if(Object.hasOwn(order,'field')||!grouped)return fail('aggregate order shape');const alias=aliases.find(a=>a.public===order.aggregate);if(!alias) return fail('unknown aggregate order');return {aggregate:alias.native,direction};}const f=field(schema,order.field);if(grouped&&!names.includes(f.name))fail('sort field not grouped');return {field:f.name,direction};});
 const aggregates=Object.fromEntries(aliases.map(a=>[a.native,{aggFunc:a.op,...(a.field?{field:a.field.name}:{})}]));const q:unknown={semanticProfile:'effect-4.2.8',...(grouped?{groupBy:names,aggregates}:{select:names}),...(where?{where}:{}),orderBy};validateQuery(schema,q,{topic,fingerprint});
 return Object.freeze({query:q,wire:{topic,schema:fingerprint,semantic_profile:'effect-4.2.8' as const,...('groupBy'in q&&q.groupBy?{group_by:q.groupBy,aggregates:q.aggregates}:{select:q.select}),...(q.where?{where:q.where}:{}),order_by:q.orderBy,offset:0,limit:1024},aliases:Object.freeze(aliases),selected:Object.freeze(names),key:semanticKey([topic,fingerprint,q,aliases.map(a=>[a.native,a.public])]),grouped});
}
function converted(f:Field,v:unknown):unknown{if(v===null||v===undefined)return v;validateScalar(f,v);if(f.kind==='int64'||f.kind==='uint64'){if(typeof v!=='string')return fail('exact integer wire value');return BigInt(v);}if(f.kind==='decimal'){if(typeof v!=='string')return fail('Decimal wire value');return Object.freeze(BigDecimal.normalize(BigDecimal.fromStringUnsafe(v)));}return v;}
export function decodeRows<S extends Schema,Q extends Query<S>>(schema:S,compiled:Compiled,result:ProductResult):ReadonlyArray<CompatResult<S,Q>>{
 if(!result.keys||result.keys.length!==result.rows.length||new Set(result.keys).size!==result.keys.length)fail('authoritative row/key pairing');
 const rows=result.rows.map((input,index)=>{const row:unknown=input;if(!record(row))return fail('result row shape');if(compiled.grouped){if(!('aggregates'in compiled.query)||!compiled.query.aggregates)return fail('group result authority');validateGroupedRow(schema,compiled.query,row,queryFields(compiled.query));}else validateRow(schema,row,compiled.selected);
 const key=result.keys?.[index];if(Object.hasOwn(row,'rowId')&&row.rowId!==key)fail('row/wire identity mismatch');if(typeof key!=='string'||!key.length||key.length>512)fail('authoritative row identity');
 const fields=compiled.selected.filter(name=>Object.hasOwn(row,name)).map(name=>[name,converted(field(schema,name),row[name])] as const);
 const aggregates=compiled.aliases.map(a=>{const v=row[a.native];if(a.op==='count'||a.op==='countDistinct'||a.op==='sum'&&(a.field?.kind==='int64'||a.field?.kind==='uint64')){if(typeof v!=='string')return fail('aggregate integer wire value');return [a.public,BigInt(v)] as const;}if(a.op==='sum'||a.op==='avg'){if(typeof v!=='string')return fail('aggregate Decimal wire value');return [a.public,Object.freeze(BigDecimal.normalize(BigDecimal.fromStringUnsafe(v)))] as const;}if(!a.field)return fail('aggregate field');return [a.public,converted(a.field,v)] as const;});
 return Object.freeze(Object.fromEntries([...fields,...aggregates,['rowId',key]]));});
 return admitted<ReadonlyArray<CompatResult<S,Q>>>(Object.freeze(rows));
}

/** Admit complete-source rows at the same catalog and exact-scalar boundary. */
export function decodeCompleteRows<S extends Schema>(schema:S,rows:readonly object[],cache:WeakMap<object,CompatRow<S>>):readonly CompatRow<S>[] {
 return Object.freeze(rows.map(input=>{
  const previous=cache.get(input);if(previous)return previous;
  if(!record(input)||typeof input.rowId!=='string'||!input.rowId.length||input.rowId.length>512)fail('complete source identity');
  const {rowId,...payload}=input;validateRow(schema,payload);
  const values=schema.fields.filter(f=>Object.hasOwn(payload,f.name)).map(f=>[f.name,converted(f,payload[f.name])]);
  const row=admitted<CompatRow<S>>(Object.freeze(Object.fromEntries([...values,['rowId',rowId]])));
  cache.set(input,row);return row;
 }));
}

/** Serialize authentic generated rows through the library's exact scalar codecs. */
export function encodeCompatRow<S extends Schema>(schema:S,input:CompatRow<S>):Row<S>{
 const source:unknown=input;if(!record(source))return fail('source row shape');
 const fields=schema.fields.filter(f=>!f.optional||Object.hasOwn(source,f.name)&&source[f.name]!==undefined).map(f=>[f.name,value(f,source[f.name])]);
 const row=Object.fromEntries(fields);validateRow(schema,row);return admitted<Row<S>>(Object.freeze(row));
}
