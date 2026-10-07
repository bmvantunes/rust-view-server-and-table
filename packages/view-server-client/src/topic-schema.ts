/** Portable flat-schema v1. These exact objects are the Rust-validated manifests. */
export type ScalarKind = 'string' | 'boolean' | 'number' | 'int64' | 'uint64' | 'decimal' | 'enum';
export type Field = { readonly name:string; readonly kind:ScalarKind; readonly optional:boolean; readonly nullable:boolean; readonly enum_domain?:string };
export type Schema = { readonly format:1|2|3; readonly id:string; readonly version:1|2|3; readonly key:string; readonly fields:readonly Field[]; readonly expansion?:Expansion };
export type Expansion = {readonly message:string;readonly parents:readonly {readonly path:string;readonly message:string;readonly required:boolean}[];readonly leaves:readonly {readonly path:string;readonly presence:'explicit'|'implicit';readonly required:boolean;readonly enum_domain?:string}[];readonly enums:Readonly<Record<string,Readonly<Record<string,number>>>>};
export type EnumValue<D extends string=string> = {readonly domain:D;readonly code:number};
export function enumValue<const D extends string>(domain:D,code:number):EnumValue<D>{if(!validPath(domain)||!Number.isInteger(code)||code< -2147483648||code>2147483647)throw Error('invalid enum value');return Object.freeze({domain,code});}
export type SchemaField<S extends Schema> = S['fields'][number] extends infer F ? F extends Field ? F & (S extends {readonly expansion:infer E extends Expansion} ? {readonly enum_domain:Extract<E['leaves'][number],{path:F['name']}> extends {readonly enum_domain:infer D extends string} ? D : never} : {}) : never : never;
type FieldScalar<F extends Field> = F['kind'] extends 'enum' ? EnumValue<Extract<F['enum_domain'],string>> : Scalar<F['kind']>;
export type Int64 = string & { readonly __int64:unique symbol };
export type Uint64 = string & { readonly __uint64:unique symbol };
export type Decimal = string & { readonly __decimal:unique symbol };
export type Scalar<K extends ScalarKind> = K extends 'enum' ? EnumValue : K extends 'boolean' ? boolean : K extends 'number' ? number : K extends 'int64' ? Int64 : K extends 'uint64' ? Uint64 : K extends 'decimal' ? Decimal : string;
type FieldValue<F extends Field> = FieldScalar<F> | (F['nullable'] extends true ? null : never);
export type Row<S extends Schema> = S extends {readonly expansion:Expansion} ? FullNested<S> : { [F in SchemaField<S> as F['optional'] extends false ? F['name'] : never]:FieldValue<F> } & { [F in SchemaField<S> as F['optional'] extends true ? F['name'] : never]?:FieldValue<F> };
export type FieldName<S extends Schema> = S['fields'][number]['name'];
type Compare<F extends Field> = (F['kind'] extends 'string' ? {readonly op:'contains'|'startsWith'|'endsWith';readonly field:F['name'];readonly value:string} : never) | {readonly op:'eq'|'ne';readonly field:F['name'];readonly value:FieldScalar<F>} | {readonly op:'in';readonly field:F['name'];readonly values:readonly FieldScalar<F>[]} | {readonly op:'is_value' | (F['optional'] extends true ? 'is_missing' : never) | (F['nullable'] extends true ? 'is_null' : never);readonly field:F['name']} | (F['kind'] extends 'boolean' ? never : {readonly op:'lt'|'le'|'gt'|'ge';readonly field:F['name'];readonly value:FieldScalar<F>});
type Comparison<S extends Schema> = SchemaField<S> extends infer F ? F extends Field ? Compare<F> : never : never;
export type SemanticProfile = 'effect-4.2.8';
type TextComparison<F extends Field> = F['kind'] extends 'string' ? {readonly op:'text';readonly field:F['name'];readonly value:string;readonly match_kind:'eq'|'ne'|'contains'|'notContains'|'startsWith'|'endsWith';readonly case_sensitive?:boolean;readonly accent_sensitive?:boolean} : never;
type TextSet<F extends Field> = F['kind'] extends 'string' ? {readonly op:'text_in';readonly field:F['name'];readonly values:readonly string[];readonly case_sensitive?:boolean;readonly accent_sensitive?:boolean} : never;
export type Predicate<S extends Schema> = Comparison<S> | (SchemaField<S> extends infer F ? F extends Field ? TextComparison<F> | TextSet<F> : never : never) | {readonly op:'and'|'or';readonly clauses:readonly Predicate<S>[]} | {readonly op:'not';readonly clause:Predicate<S>};
export type RawQuery<S extends Schema> = {readonly semanticProfile?:SemanticProfile; readonly global?:never;readonly having?:never; readonly groupBy?:never; readonly aggregates?:never; readonly select:readonly [FieldName<S>,...FieldName<S>[]]; readonly where?:Predicate<S>; readonly orderBy:readonly {readonly field:FieldName<S>;readonly direction:'asc'|'desc'}[] };
export type RowsWithRowId<T extends object> = Extract<keyof T,'rowId'> extends never ? T & {readonly rowId:string} : never;
// A union-valued element names possible fields, not fields all returned together.
// Visit only the tuple alternatives already supplied; never expand combinations.
type IncludesName<T extends readonly string[],K extends string,Depth extends unknown[]=[]> = T extends readonly [infer H extends string,...infer Rest extends readonly string[]]
 ? [H] extends [K] ? true : Depth['length'] extends 63 ? false : IncludesName<Rest,K,[...Depth,0]>
 : false;
type GuaranteedNames<T extends readonly string[]> = {[K in T[number]]:string extends K ? never : [IncludesName<T,K>] extends [true] ? K : never}[T[number]];
type Relative<P extends string,Prefix extends string> = Prefix extends '' ? P : P extends `${Prefix}.${infer R}` ? R : never;
type Head<P extends string> = P extends `${infer H}.${string}` ? H : P;
type Join<P extends string,K extends string> = P extends '' ? K : `${P}.${K}`;
type IncludesPrefix<T extends readonly string[],P extends string,Depth extends unknown[]=[]> = T extends readonly [infer H extends string,...infer R extends readonly string[]] ? [H] extends [P|`${P}.${string}`] ? true : Depth['length'] extends 63 ? false : IncludesPrefix<R,P,[...Depth,0]> : false;
type SourceRequired<S extends Schema,P extends string> = S extends {readonly expansion:infer E extends Expansion} ? Extract<E['parents'][number]|E['leaves'][number],{path:P}>['required'] : Extract<S['fields'][number],{name:P}>['optional'] extends false ? true : false;
type FullNested<S extends Schema,P extends string=''> = {
 [K in Head<Relative<FieldName<S>,P>> as SourceRequired<S,Join<P,K>> extends true ? K : never]:Join<P,K> extends FieldName<S> ? FieldValue<Extract<SchemaField<S>,{name:Join<P,K>}>> : FullNested<S,Join<P,K>>
} & {
 [K in Head<Relative<FieldName<S>,P>> as SourceRequired<S,Join<P,K>> extends true ? never : K]?:Join<P,K> extends FieldName<S> ? FieldValue<Extract<SchemaField<S>,{name:Join<P,K>}>> : FullNested<S,Join<P,K>>
};
type NestedValue<S extends Schema,T extends readonly string[],P extends string> = P extends FieldName<S> ? FieldValue<Extract<SchemaField<S>,{name:P}>> : NestedSelected<S,T,P>;
type NestedSelected<S extends Schema,T extends readonly string[],P extends string=''> = {
 [K in Head<Relative<T[number],P>> as IncludesPrefix<T,Join<P,K>> extends true ? SourceRequired<S,Join<P,K>> extends true ? K : never : never]:NestedValue<S,T,Join<P,K>>
} & {
 [K in Head<Relative<T[number],P>> as IncludesPrefix<T,Join<P,K>> extends true ? SourceRequired<S,Join<P,K>> extends true ? never : K : K]?:NestedValue<S,T,Join<P,K>>
};
export type ProjectedFields<S extends Schema,T extends readonly string[]> = S extends {readonly expansion:Expansion} ? NestedSelected<S,T> : Pick<Row<S>,Extract<GuaranteedNames<T>,keyof Row<S>>>
 & Partial<Pick<Row<S>,Extract<Exclude<T[number],GuaranteedNames<T>>,keyof Row<S>>>>;
export type Selected<S extends Schema,Q extends RawQuery<S>> = Q extends RawQuery<S> ? RowsWithRowId<ProjectedFields<S,Q['select']>> : never;
export type AggregateCount = string & {readonly __aggregateCount:unique symbol};
export type AggregateInteger = string & {readonly __aggregateInteger256:unique symbol};
export type AggregateDecimal = string & {readonly __aggregateDecimal:unique symbol};
type NumericName<S extends Schema> = Extract<S['fields'][number],{kind:'number'|'int64'|'uint64'|'decimal'}>['name'];
export type Aggregate<S extends Schema> = {readonly aggFunc:'count';readonly field?:never} | {readonly aggFunc:'sum'|'avg';readonly field:NumericName<S>} | {readonly aggFunc:'countDistinct'|'min'|'max';readonly field:FieldName<S>};
export type GroupedQuery<S extends Schema> = {readonly semanticProfile?:SemanticProfile;readonly global?:never;readonly having?:ResultPredicate;readonly select?:never;readonly groupBy:readonly [FieldName<S>,...FieldName<S>[]];readonly aggregates:Readonly<Record<string,Aggregate<S>>>;readonly where?:Predicate<S>;readonly orderBy:readonly ({readonly field:FieldName<S>;readonly aggregate?:never;readonly direction:'asc'|'desc'}|{readonly aggregate:string;readonly field?:never;readonly direction:'asc'|'desc'})[]};
type ResultPredicate = {readonly op:'eq'|'ne'|'lt'|'le'|'gt'|'ge'|'contains'|'startsWith'|'endsWith';readonly field:string;readonly value:string|number|boolean|EnumValue}|{readonly op:'in';readonly field:string;readonly values:readonly (string|number|boolean|EnumValue)[]}|{readonly op:'is_missing'|'is_null'|'is_value';readonly field:string}|{readonly op:'and'|'or';readonly clauses:readonly ResultPredicate[]}|{readonly op:'not';readonly clause:ResultPredicate};
export type GlobalQuery<S extends Schema> = {readonly semanticProfile?:SemanticProfile;readonly global:true;readonly select?:never;readonly groupBy?:never;readonly aggregates:Readonly<Record<string,Aggregate<S>>>;readonly where?:Predicate<S>;readonly having?:ResultPredicate;readonly orderBy:readonly {readonly aggregate:string;readonly field?:never;readonly direction:'asc'|'desc'}[]};
export type AggregateQuery<S extends Schema> = GroupedQuery<S>|GlobalQuery<S>;
export type TopicQuery<S extends Schema> = RawQuery<S>|AggregateQuery<S>;
type SourceField<S extends Schema,A> = A extends {readonly field:infer F} ? Extract<SchemaField<S>,{name:F}> : never;
type MaybeNull<F extends Field> = true extends F['optional'] | F['nullable'] ? null : never;
type SumValue<K extends ScalarKind> = K extends 'number' ? number : K extends 'decimal' ? AggregateDecimal : K extends 'int64'|'uint64' ? AggregateInteger : never;
type AverageValue<K extends ScalarKind> = K extends 'number' ? number : K extends 'int64'|'uint64'|'decimal' ? AggregateDecimal : never;
// Distribute operators and source fields within each aggregate-object alternative.
// Distributing the object first preserves its operator/field correlations.
type AggregateOperationValue<Op,F extends Field,G extends boolean> = Op extends 'count'|'countDistinct' ? AggregateCount
 : F extends Field ? Op extends 'sum' ? SumValue<F['kind']>
 : Op extends 'avg' ? AverageValue<F['kind']> | MaybeNull<F> | (G extends true ? null : never)
 : Op extends 'min'|'max' ? FieldScalar<F> | MaybeNull<F> | (G extends true ? null : never)
 : never : never;
type ProfileAggregateOperationValue<Op,F extends Field,G extends boolean> = Op extends 'count'|'countDistinct' ? AggregateCount
 : F extends Field ? Op extends 'avg' ? AggregateDecimal
 : Op extends 'sum' ? F['kind'] extends 'number' ? AggregateDecimal : SumValue<F['kind']>
 : Op extends 'min'|'max' ? FieldScalar<F> | (F['nullable'] extends true ? null : never) | (F['optional'] extends true ? undefined : never) | (G extends true ? undefined : never)
 : never : never;
type AggregateValue<S extends Schema,A,G extends boolean=false,P=undefined> = A extends {readonly aggFunc:infer Op} ? P extends SemanticProfile ? ProfileAggregateOperationValue<Op,SourceField<S,A>,G> : AggregateOperationValue<Op,SourceField<S,A>,G> : never;
export type QueryResult<S extends Schema,Q extends TopicQuery<S>> = Q extends RawQuery<S> ? Selected<S,Q> : Q extends GroupedQuery<S> ? RowsWithRowId<ProjectedFields<S,Q['groupBy']>>&{[A in keyof Q['aggregates']]-?:AggregateValue<S,Q['aggregates'][A],false,Q['semanticProfile']>} : Q extends GlobalQuery<S> ? {readonly rowId:string}&{[A in keyof Q['aggregates']]-?:AggregateValue<S,Q['aggregates'][A],true,Q['semanticProfile']>} : never;
type Unique<T extends readonly unknown[],Seen=never> = T extends readonly [infer H,...infer R] ? H extends Seen ? false : Unique<R,Seen|H> : true;
type SortName<O> = O extends {field:infer F} ? F : O extends {aggregate:infer A} ? A : never;
type SortNames<T extends readonly unknown[]> = {[I in keyof T]:SortName<T[I]>};
type Letter = 'a'|'b'|'c'|'d'|'e'|'f'|'g'|'h'|'i'|'j'|'k'|'l'|'m'|'n'|'o'|'p'|'q'|'r'|'s'|'t'|'u'|'v'|'w'|'x'|'y'|'z';
type NameTail<S extends string,N extends unknown[]=[0]> = S extends '' ? true : N['length'] extends 64 ? false : S extends `${infer H}${infer R}` ? Lowercase<H> extends Letter|'0'|'1'|'2'|'3'|'4'|'5'|'6'|'7'|'8'|'9'|'_' ? NameTail<R,[...N,0]> : false : false;
type NameOK<S extends string> = S extends 'rowId'|'constructor'|'prototype'|'__proto__' ? false : S extends `${infer H}${infer R}` ? Lowercase<H> extends Letter ? NameTail<R> : false : false;
type BadAlias<A> = {[K in keyof A]:K extends string ? NameOK<K> extends true ? never : K : K}[keyof A];
type ShapeCheck<Q> = Q extends {groupBy:infer G extends readonly string[];aggregates:infer A;orderBy:infer O extends readonly unknown[]} ? string extends keyof A ? unknown : keyof A extends never ? never : BadAlias<A> extends never ? Extract<keyof A,Head<G[number]>> extends never ? Unique<G> extends true ? Unique<SortNames<O>> extends true ? Exclude<O[number],{field:G[number];direction:'asc'|'desc'}|{aggregate:keyof A;direction:'asc'|'desc'}> extends never ? unknown : never : never : never : never : never : Q extends {global:true;aggregates:infer A;orderBy:infer O extends readonly unknown[]} ? string extends keyof A ? unknown : keyof A extends never ? never : BadAlias<A> extends never ? Unique<SortNames<O>> extends true ? Exclude<O[number],{aggregate:keyof A;direction:'asc'|'desc'}> extends never ? unknown : never : never : never : Q extends {select:infer S extends readonly string[];orderBy:infer O extends readonly unknown[]} ? Unique<S> extends true ? Unique<SortNames<O>> extends true ? unknown : never : never : never;
type ResultCompare<K,V,Text extends boolean,Optional extends boolean> = {readonly op:'eq'|'ne'|(Exclude<V,null|undefined> extends boolean ? never : 'lt'|'le'|'gt'|'ge');readonly field:K;readonly value:Exclude<V,null|undefined>}|{readonly op:'in';readonly field:K;readonly values:readonly Exclude<V,null|undefined>[]} | {readonly op:'is_value'|(null extends V ? 'is_null':never)|(Optional extends true ? 'is_missing':never);readonly field:K} | (Text extends true ? {readonly op:'contains'|'startsWith'|'endsWith';readonly field:K;readonly value:string}:never);
type AggregateHaving<S extends Schema,Q extends AggregateQuery<S>> = {[K in keyof Q['aggregates']]:ResultCompare<K,AggregateValue<S,Q['aggregates'][K],Q extends GlobalQuery<S> ? true:false,Q['semanticProfile']>,Q['aggregates'][K] extends {aggFunc:'min'|'max';field:infer F} ? Extract<SchemaField<S>,{name:F}>['kind'] extends 'string' ? true:false:false,false>}[keyof Q['aggregates']];
type HavingLeaf<S extends Schema,Q extends AggregateQuery<S>> = AggregateHaving<S,Q> | (Q extends GroupedQuery<S> ? Extract<SchemaField<S>,{name:Q['groupBy'][number]}> extends infer F ? F extends Field ? Compare<F>:never:never:never);
export type HavingPredicate<S extends Schema,Q extends AggregateQuery<S>> = HavingLeaf<S,Q>|{readonly op:'and'|'or';readonly clauses:readonly HavingPredicate<S,Q>[]} | {readonly op:'not';readonly clause:HavingPredicate<S,Q>};
export type QueryCheck<Q,S extends Schema=Schema> = ShapeCheck<Q> & (Q extends AggregateQuery<S> & {having:infer H} ? H extends HavingPredicate<S,Q> ? unknown:never:unknown);
export function queryFields(query:{readonly select?:readonly string[];readonly groupBy?:readonly string[];readonly aggregates?:Readonly<Record<string,unknown>>}):readonly string[]{return query.select??[...(query.groupBy??[]),...Object.keys(query.aggregates??{}).sort()];}
export type TopicDefinition<S extends Schema=Schema> = {readonly schema:S;readonly fingerprint:string};
export type BrowserCatalog = Readonly<Record<string,TopicDefinition>>;
export type SourceCleanupPolicy = 'delete'|'compact'|'compact,delete';
type AgeOnlyRetention = {readonly maxRetentionMinutes:number;readonly maxRetentionMessages?:never;readonly maxRetentionMessagesPerKey?:never};
type DeleteCountRetention = {readonly maxRetentionMinutes?:number;readonly maxRetentionMessages:number;readonly maxRetentionMessagesPerKey?:never};
type CompactCountRetention = {readonly maxRetentionMinutes?:number;readonly maxRetentionMessages?:never;readonly maxRetentionMessagesPerKey:number};
/** Compile-time mirror of the accepted native per-topic retention branches. */
export type RetentionPolicy<P extends SourceCleanupPolicy> = P extends 'delete'
 ? AgeOnlyRetention|DeleteCountRetention
 : AgeOnlyRetention|CompactCountRetention;
export const MAX_RETENTION_MINUTES=5_256_000;
export const MAX_RETENTION_ROWS=10_000_000;
export function retentionDurationMs(minutes:number):number{
 if(!Number.isFinite(minutes)||minutes<=0||minutes>MAX_RETENTION_MINUTES)throw Error(`maxRetentionMinutes must be finite, positive, and at most ${MAX_RETENTION_MINUTES}`);
 const ms=Math.ceil(minutes*60_000);if(!Number.isSafeInteger(ms)||ms<=0)throw Error('retention duration overflow');return ms;
}
/** Validate untrusted JSON with the same policy branch, precision and owner bounds as Rust. */
export function validateRetentionPolicy(sourcePolicy:SourceCleanupPolicy,value:unknown,maxRows:number):void{
 if(!Number.isSafeInteger(maxRows)||maxRows<=0||maxRows>MAX_RETENTION_ROWS)throw Error('invalid maxRows retention budget');
 if(!object(value))throw Error('invalid retention policy object');
 const global=Object.hasOwn(value,'maxRetentionMessages'),perKey=Object.hasOwn(value,'maxRetentionMessagesPerKey'),age=Object.hasOwn(value,'maxRetentionMinutes');
 if(global&&perKey)throw Error('maxRetentionMessages and maxRetentionMessagesPerKey are mutually exclusive');
 if(global&&sourcePolicy!=='delete')throw Error('maxRetentionMessages requires source cleanupPolicy=delete');
 if(perKey&&sourcePolicy==='delete')throw Error('maxRetentionMessagesPerKey requires source cleanupPolicy=compact or compact,delete');
 const allowed=sourcePolicy==='delete'?['maxRetentionMinutes','maxRetentionMessages']:['maxRetentionMinutes','maxRetentionMessagesPerKey'];
 if(Object.keys(value).some(key=>!allowed.includes(key)))throw Error('unsupported retention policy field');
 if(!age&&!global&&!perKey)throw Error('retention policy must set at least one maximum');
 if(age)retentionDurationMs(value.maxRetentionMinutes as number);
 const count=global?value.maxRetentionMessages:perKey?value.maxRetentionMessagesPerKey:undefined;
 if(global&&sourcePolicy!=='delete')throw Error('maxRetentionMessages requires source cleanupPolicy=delete');
 if(perKey&&sourcePolicy==='delete')throw Error('maxRetentionMessagesPerKey requires source cleanupPolicy=compact or compact,delete');
 if(count!==undefined&&(!Number.isSafeInteger(count)||Number(count)<=0||Number(count)>maxRows||Number(count)>MAX_RETENTION_ROWS))throw Error(`retention count must be positive and no greater than min(maxRows, ${MAX_RETENTION_ROWS})`);
}
export function defineRetentionPolicy<const P extends SourceCleanupPolicy>(sourcePolicy:P,value:RetentionPolicy<P>,maxRows:number):RetentionPolicy<P>{
 validateRetentionPolicy(sourcePolicy,value,maxRows);return freeze(structuredClone(value));
}
const kinds:readonly string[]=['string','boolean','number','int64','uint64','decimal','enum'];
const banned=new Set(['__proto__','prototype','constructor']);
export function validName(value:unknown):value is string{return typeof value==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value)&&!banned.has(value);}
function object(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);}
function exactKeys(value:Record<string,unknown>,expected:readonly string[]):boolean{return Object.keys(value).length===expected.length&&expected.every(k=>Object.hasOwn(value,k));}
export function validPath(value:unknown):value is string{return typeof value==='string'&&value.length<=512&&value.split('.').length<=8&&value.split('.').every(v=>validName(v)&&v!=='rowId');}
export function validateSchema(value:unknown):asserts value is Schema{
 if(!object(value)||!exactKeys(value,value.format===3?['format','id','version','key','fields','expansion']:['format','id','version','key','fields'])||!((value.format===1&&value.version===1)||([2,3].includes(value.format as number)&&value.version===value.format&&value.key==='rowId'))||!validName(value.id)||!validName(value.key)||!Array.isArray(value.fields)||value.fields.length<1||value.fields.length>64)throw Error('invalid schema header');
 const names=new Set<string>();
 for(const f of value.fields){if(!object(f)||typeof f.name!=='string'||!exactKeys(f,['name','kind','optional','nullable'])||!(value.format===3?validPath(f.name):validName(f.name))||f.name==='rowId'||!kinds.includes(f.kind as string)||typeof f.optional!=='boolean'||typeof f.nullable!=='boolean'||names.has(f.name))throw Error('invalid/duplicate schema field');names.add(f.name);}
 if(value.format===3){const e=value.expansion;if(!object(e)||!exactKeys(e,['message','parents','leaves','enums'])||!validPath(e.message)||!Array.isArray(e.parents)||e.parents.length>64||!Array.isArray(e.leaves)||e.leaves.length!==value.fields.length||!object(e.enums)||Object.keys(e.enums).length>64)throw Error('expansion metadata');
  const parents=new Map<string,boolean>();for(const p of e.parents){if(!object(p)||!exactKeys(p,['path','message','required'])||!validPath(p.path)||!validPath(p.message)||typeof p.required!=='boolean'||parents.has(p.path)||names.has(p.path))throw Error('parent metadata');parents.set(p.path,p.required);}
  for(const p of parents.keys()){const ancestor=p.split('.').slice(0,-1).join('.');if(ancestor&&!parents.has(ancestor))throw Error('missing ancestor');}
  for(const [i,l]of e.leaves.entries()){const f=value.fields[i];if(!object(l)||!exactKeys(l,f.kind==='enum'?['path','presence','required','enum_domain']:['path','presence','required'])||l.path!==f.name||!['explicit','implicit'].includes(l.presence as string)||typeof l.required!=='boolean'||l.presence==='implicit'&&(!l.required||f.nullable||f.kind==='decimal'))throw Error('leaf metadata');let optional=!l.required;const parts=f.name.split('.');parts.pop();while(parts.length){const p=parts.join('.');if(!parents.has(p))throw Error('missing leaf ancestor');optional ||= !parents.get(p);parts.pop();}if(optional!==f.optional)throw Error('effective optionality');if(f.kind==='enum'&&(typeof l.enum_domain!=='string'||!Object.hasOwn(e.enums,l.enum_domain)))throw Error('enum domain');}
  for(const [domain,labels]of Object.entries(e.enums)){if(!validPath(domain)||!object(labels)||Object.keys(labels).length<1||Object.keys(labels).length>256||!Object.values(labels).includes(0)||Object.entries(labels).some(([label,code])=>!validName(label)||!Number.isInteger(code)||Number(code)< -2147483648||Number(code)>2147483647))throw Error('enum labels');}
 }else if(value.fields.some(f=>f.kind==='enum'))throw Error('enum requires v3');
 const key=value.fields.find(f=>f.name===value.key);if(value.format===1&&(!key||key.kind!=='string'||key.optional||key.nullable))throw Error('schema key must be a required non-null string');
}
function freeze<T>(v:T):T{if(v&&typeof v==='object'){for(const child of Object.values(v))freeze(child);Object.freeze(v);}return v;}
export function defineSchema<const S extends Schema>(schema:S):S{validateSchema(schema);return freeze(structuredClone(schema));}
/** Fixed property order and authored field order match Rust serde serialization. */
export function schemaBytes(schema:Schema):Uint8Array{validateSchema(schema);return new TextEncoder().encode(JSON.stringify({format:schema.format,id:schema.id,version:schema.version,key:schema.key,fields:schema.fields.map(f=>({name:f.name,kind:f.kind,optional:f.optional,nullable:f.nullable})),...(schema.expansion?{expansion:schema.expansion}:{})}));}
export async function schemaFingerprint(schema:Schema):Promise<string>{return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',schemaBytes(schema).buffer as ArrayBuffer)),b=>b.toString(16).padStart(2,'0')).join('');}
export function defineCatalog<const C extends BrowserCatalog>(catalog:C):C{
 if(!object(catalog)||Object.keys(catalog).length<1||Object.keys(catalog).length>16)throw Error('catalog topic bound');
 for(const [topic,entry]of Object.entries(catalog)){if(!validName(topic)||!object(entry)||!exactKeys(entry,['schema','fingerprint'])||typeof entry.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(entry.fingerprint))throw Error('invalid topic binding');validateSchema(entry.schema);}
 return freeze(structuredClone(catalog));
}
export async function verifyCatalog(catalog:BrowserCatalog):Promise<void>{defineCatalog(catalog);for(const entry of Object.values(catalog))if(await schemaFingerprint(entry.schema)!==entry.fingerprint)throw Error('schema fingerprint mismatch');}
export function int64(value:string|bigint):Int64{const s=String(value);validateScalar({name:'value',kind:'int64',optional:false,nullable:false},s);return s as Int64;}
export function uint64(value:string|bigint):Uint64{const s=String(value);validateScalar({name:'value',kind:'uint64',optional:false,nullable:false},s);return s as Uint64;}
export function decimal(value:string):Decimal{validateScalar({name:'value',kind:'decimal',optional:false,nullable:false},value);return value as Decimal;}
const encoder=new TextEncoder();
function wellFormed(value:string):boolean{for(let i=0;i<value.length;i++){const c=value.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const n=value.charCodeAt(++i);if(!(n>=0xdc00&&n<=0xdfff))return false;}else if(c>=0xdc00&&c<=0xdfff)return false;}return true;}
export function validateScalar(field:Field,value:unknown):void{
 if(value===null){if(field.nullable)return;throw Error('null not admitted');}
 switch(field.kind){
  case 'enum':if(!object(value)||!exactKeys(value,['domain','code'])||value.domain!==field.enum_domain||!Number.isInteger(value.code)||Number(value.code)< -2147483648||Number(value.code)>2147483647)throw Error('enum domain/code');break;
  case 'string':if(typeof value!=='string'||!wellFormed(value)||encoder.encode(value).length>4096)throw Error('invalid bounded UTF-8 string');break;
  case 'boolean':if(typeof value!=='boolean')throw Error('boolean required');break;
  case 'number':if(typeof value!=='number'||!Number.isFinite(value))throw Error('finite number required');break;
  case 'int64':case 'uint64':{if(typeof value!=='string'||value.length>20||! /^(0|-?[1-9][0-9]*)$/.test(value))throw Error('canonical exact integer required');const n=BigInt(value);if(field.kind==='int64'?n<-(1n<<63n)||n>=(1n<<63n):n<0n||n>=(1n<<64n))throw Error('integer range');break;}
  case 'decimal':if(typeof value!=='string'||value.length>256||! /^(?:0|-?(?:[1-9][0-9]*|0)(?:\.[0-9]*[1-9])?)$/.test(value)||value==='-0'||(value.split('.')[1]?.length??0)>128)throw Error('canonical decimal required');break;
 }
}
export function pathGet(row:unknown,path:string):unknown{let v=row;for(const p of path.split('.')){if(!object(v)||!Object.hasOwn(v,p))return undefined;v=v[p];}return v;}
function boundField(schema:Schema,f:Field):Field{return {...f,...(f.kind==='enum'?{enum_domain:schema.expansion?.leaves.find(l=>l.path===f.name)?.enum_domain}:{})};}
export function validateRow(schema:Schema,row:unknown,select:readonly string[]=schema.fields.map(f=>f.name)):void{
 if(!object(row)||encoder.encode(JSON.stringify(row)).length>65536)throw Error('row bound/shape');
 const fields=new Map(schema.fields.map(f=>[f.name,f]));
 function inspect(v:Record<string,unknown>,prefix:string):void{for(const [key,child]of Object.entries(v)){const p=prefix?prefix+'.'+key:key;if(select.includes(p))continue;if(schema.expansion?.parents.some(x=>x.path===p)&&select.some(s=>s.startsWith(p+'.'))&&object(child))inspect(child,p);else throw Error('extra projected field/invalid parent');}}
 inspect(row,'');
 for(const p of schema.expansion?.parents??[]){if(!select.some(s=>s.startsWith(p.path+'.')))continue;const ancestor=p.path.split('.').slice(0,-1).join('.');if(p.required&&(!ancestor||pathGet(row,ancestor)!==undefined)&&pathGet(row,p.path)===undefined)throw Error('missing required parent');}
 for(const key of select){const f=fields.get(key);if(!f)throw Error('unknown projection');const v=pathGet(row,key);const leaf=schema.expansion?.leaves.find(l=>l.path===key);const parent=key.split('.').slice(0,-1).join('.');const required=leaf?leaf.required&&(!parent||pathGet(row,parent)!==undefined):!f.optional;if(v===undefined){if(required)throw Error('missing required field');continue;}validateScalar(boundField(schema,f),v);}
 if(Object.hasOwn(row,schema.key)&&(typeof row[schema.key]!=='string'||!(row[schema.key] as string).length||encoder.encode(row[schema.key] as string).length>512||/[\u0000-\u001f\u007f-\u009f]/.test(row[schema.key] as string)))throw Error('invalid row key');
}
export function validateQuery(schema:Schema,query:unknown,identity?:{readonly topic:string;readonly fingerprint:string}):asserts query is TopicQuery<Schema>{
 if(!object(query)||!Array.isArray(query.orderBy)||query.orderBy.length>8)throw Error('invalid query shape');
 if(query.semanticProfile!==undefined&&query.semanticProfile!=='effect-4.2.8')throw Error('unknown semantic profile');const profile:SemanticProfile|undefined=query.semanticProfile;
 const global=Object.hasOwn(query,'global');if(global&&query.global!==true)throw Error('global must be true');const grouped=global||Object.hasOwn(query,'groupBy');const fields=new Map(schema.fields.map(f=>[f.name,boundField(schema,f)]));
 if(Object.keys(query).some(k=>!(grouped?[...(global?['global']:['groupBy']),'aggregates','where','having','orderBy','semanticProfile']:['select','where','orderBy','semanticProfile']).includes(k)))throw Error('query options');
 const selected=global?[]:grouped?query.groupBy:query.select;
 if(!Array.isArray(selected)||(!global&&selected.length<1)||selected.length>(grouped?8:64)||new Set(selected).size!==selected.length||selected.some(k=>typeof k!=='string'||!fields.has(k)))throw Error('selection/group fields');
 const aggregates=grouped&&object(query.aggregates)?query.aggregates:undefined;
 if(grouped){if(!aggregates||Object.keys(aggregates).length<1||Object.keys(aggregates).length>16)throw Error('aggregate bound');for(const [alias,a]of Object.entries(aggregates)){
  if(!validName(alias)||alias==='rowId'||selected.some((p:string)=>p===alias||p.startsWith(alias+'.'))||!object(a)||!['count','countDistinct','sum','avg','min','max'].includes(a.aggFunc as string))throw Error('aggregate alias/function');
  if(a.aggFunc==='count'){if(!exactKeys(a,['aggFunc']))throw Error('count has no field');}
  else{if(!exactKeys(a,['aggFunc','field'])||typeof a.field!=='string'||!fields.has(a.field))throw Error('aggregate field');if(['sum','avg'].includes(a.aggFunc as string)&&!['number','int64','uint64','decimal'].includes(fields.get(a.field)!.kind))throw Error('numeric aggregate field');if(profile&&['sum','avg'].includes(a.aggFunc as string)){const f=fields.get(a.field)!;if(f.nullable)throw Error('profile aggregate requires nonnullable numeric field');}}
 }}
 const ordered=new Set<string>();for(const o of query.orderBy){if(!object(o)||!['asc','desc'].includes(o.direction as string))throw Error('invalid order');const name=o.field??o.aggregate;
 if(typeof name!=='string'||ordered.has(name)||!(exactKeys(o,['field','direction'])&&(grouped?selected.includes(name):fields.has(name))||grouped&&exactKeys(o,['aggregate','direction'])&&aggregates&&Object.hasOwn(aggregates,name)))throw Error('invalid order');ordered.add(name);}

 let nodes=0;
 function expr(v:unknown,depth:number,domains:Map<string,Field>=fields,aggregateDomains?:Readonly<Record<string,Aggregate<Schema>>>):void{
  if(depth>32||++nodes>256||!object(v)||typeof v.op!=='string')throw Error('predicate bound/shape');
  if(v.op==='and'||v.op==='or'){if(!exactKeys(v,['op','clauses'])||!Array.isArray(v.clauses)||v.clauses.length<1||v.clauses.length>64)throw Error('boolean clauses');for(const c of v.clauses)expr(c,depth+1,domains,aggregateDomains);return;}
  if(v.op==='not'){if(!exactKeys(v,['op','clause']))throw Error('not shape');expr(v.clause,depth+1,domains,aggregateDomains);return;}
  const f=typeof v.field==='string'?domains.get(v.field):undefined;if(!f)throw Error('unknown predicate field');
  if(['is_missing','is_null','is_value'].includes(v.op)){if(!exactKeys(v,['op','field'])||v.op==='is_missing'&&!f.optional||v.op==='is_null'&&!f.nullable)throw Error('state predicate');return;}
  const scalar=(value:unknown)=>{const a=aggregateDomains?.[f.name];if(a)validateAggregateOperand(schema,a,value,profile);else validateScalar({...f,nullable:false},value);};
  if(v.op==='in'){if(!exactKeys(v,['op','field','values'])||!Array.isArray(v.values)||v.values.length<1||v.values.length>4096)throw Error('in bound');for(const x of v.values)scalar(x);return;}
  if(v.op==='text'){if(!profile||f.kind!=='string'||!['eq','ne','contains','notContains','startsWith','endsWith'].includes(String(v.match_kind))||!exactKeys(v,['op','field','value','match_kind',...(Object.hasOwn(v,'case_sensitive')?['case_sensitive']:[]),...(Object.hasOwn(v,'accent_sensitive')?['accent_sensitive']:[])])||Object.hasOwn(v,'case_sensitive')&&typeof v.case_sensitive!=='boolean'||Object.hasOwn(v,'accent_sensitive')&&typeof v.accent_sensitive!=='boolean')throw Error('profile text predicate');validateScalar({...f,nullable:false},v.value);return;}
  if(v.op==='text_in'){if(!profile||f.kind!=='string'||!exactKeys(v,['op','field','values',...(Object.hasOwn(v,'case_sensitive')?['case_sensitive']:[]),...(Object.hasOwn(v,'accent_sensitive')?['accent_sensitive']:[])])||!Array.isArray(v.values)||v.values.length<1||v.values.length>4096||Object.hasOwn(v,'case_sensitive')&&typeof v.case_sensitive!=='boolean'||Object.hasOwn(v,'accent_sensitive')&&typeof v.accent_sensitive!=='boolean')throw Error('profile text IN');for(const value of v.values)validateScalar({...f,nullable:false},value);return;}
  if(['contains','startsWith','endsWith'].includes(v.op)){if(f.kind!=='string'||!exactKeys(v,['op','field','value']))throw Error('text predicate shape/string field');validateScalar({...f,nullable:false},v.value);return;}
  if(!['eq','ne','lt','le','gt','ge'].includes(v.op)||!exactKeys(v,['op','field','value'])||f.kind==='boolean'&&!['eq','ne'].includes(v.op))throw Error('unsupported scalar operator');scalar(v.value);
 }
 if(Object.hasOwn(query,'where'))expr(query.where,0);
 if(Object.hasOwn(query,'having')){if(!aggregates)throw Error('HAVING requires aggregation');nodes=0;const domains=new Map(selected.map((name:string)=>[name,fields.get(name)!]));for(const [alias,a]of Object.entries(aggregates))domains.set(alias,aggregateField(schema,alias,a as Aggregate<Schema>,global,profile));expr(query.having,0,domains,aggregates as Readonly<Record<string,Aggregate<Schema>>>);}
 if(identity)validateQueryIdentityBytes(identity.topic,identity.fingerprint,query);
}
/** Same ordered descriptor bytes as Rust. No authored result schema. */
export function resultShape(topic:string,fingerprint:string,query:AggregateQuery<Schema>):string{return JSON.stringify([query.global?2:1,topic,fingerprint,query.global?null:query.groupBy,Object.keys(query.aggregates).sort().map(alias=>{const a=query.aggregates[alias];return [alias,a.aggFunc,a.field??null];}),...(query.semanticProfile?[query.semanticProfile]:[])]);}
export function groupId(topic:string,fingerprint:string,schema:Schema,query:AggregateQuery<Schema>,row:Record<string,unknown>):string{
 if(query.global)return 'global1:'+Array.from(encoder.encode(JSON.stringify([1,topic,fingerprint])),b=>b.toString(16).padStart(2,'0')).join('');
 const parts=query.groupBy.map(name=>{const field=schema.fields.find(f=>f.name===name)!;const v=pathGet(row,name);const state=v===undefined?0:v===null?1:2;let value=state===2?v:null;
 if(state===2&&field.kind==='enum'&&object(value))value={code:value.code,domain:value.domain};
 if(state===2&&field.kind==='number'){const bytes=new ArrayBuffer(8);new DataView(bytes).setFloat64(0,value===0?0:value as number,false);value=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');}return [name,field.kind,state,value];});
 const id='gid1:'+Array.from(encoder.encode(JSON.stringify(schema.expansion?[3,topic,fingerprint,parts,schema.expansion.parents.filter(p=>query.groupBy.some(k=>k.startsWith(p.path+'.'))).map(p=>[p.path,pathGet(row,p.path)!==undefined])]:[1,topic,fingerprint,parts])),b=>b.toString(16).padStart(2,'0')).join('');if(id.length>512)throw Error('group identity byte bound');return id;
}
export function validateGroupedRow(schema:Schema,query:AggregateQuery<Schema>,row:unknown,projection:readonly string[]):void{
 const expected=queryFields(query);if(JSON.stringify(projection)!==JSON.stringify(expected)||!object(row)||encoder.encode(JSON.stringify(row)).length>65536||Object.keys(row).some(k=>!expected.some(p=>p===k||p.startsWith(k+'.'))))throw Error('group result shape');
 const keys:Record<string,unknown>={};for(const k of new Set((query.groupBy??[]).map(p=>p.split('.')[0])))if(Object.hasOwn(row,k))keys[k]=row[k];validateRow(schema,keys,query.groupBy??[]);
 for(const [alias,a]of Object.entries(query.aggregates)){const f=a.field?schema.fields.find(f=>f.name===a.field)!:undefined;if(!Object.hasOwn(row,alias)){if(query.semanticProfile&&(a.aggFunc==='min'||a.aggFunc==='max')&&(f?.optional||query.global))continue;throw Error('missing aggregate alias');}const value=row[alias];
 if(value===null){if(query.semanticProfile?(!['min','max'].includes(a.aggFunc)||!f?.nullable):(!['avg','min','max'].includes(a.aggFunc)||!f||!query.global&&!f.optional&&!f.nullable))throw Error('aggregate nullability');continue;}
 if(a.aggFunc==='min'||a.aggFunc==='max'){validateScalar({...boundField(schema,f!),nullable:false},value);continue;}
 if(a.aggFunc==='count'||a.aggFunc==='countDistinct'){if(typeof value!=='string'||! /^(0|[1-9][0-9]*)$/.test(value)||value.length>20||BigInt(value)>=(1n<<64n))throw Error('aggregate count');continue;}
 if(f!.kind==='number'&&!query.semanticProfile){if(typeof value!=='number'||!Number.isFinite(value))throw Error('aggregate finite number');continue;}
 if(a.aggFunc==='sum'&&f!.kind!=='decimal'&&f!.kind!=='number'){if(typeof value!=='string'||! /^(0|-?[1-9][0-9]*)$/.test(value)||value.length>78||BigInt(value)<-(1n<<255n)||BigInt(value)>=(1n<<255n))throw Error('aggregate integer256');continue;}
 if(typeof value!=='string'||value.length>(query.semanticProfile?1024:514)||! /^(?:0|-?(?:[1-9][0-9]*|0)(?:\.[0-9]*[1-9])?)$/.test(value)||value==='-0'||(value.split('.')[1]?.length??0)>(query.semanticProfile?424:a.aggFunc==='avg'?18:128))throw Error('aggregate decimal');
 }
}

const MAX_QUERY_IDENTITY_BYTES=65_536;
function canonicalJsonValue(value:unknown):unknown{if(Array.isArray(value))return value.map(canonicalJsonValue);if(object(value))return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonicalJsonValue(value[key])]));return value;}
function identityPredicate(value:unknown):unknown{
 const p=value as Record<string,unknown>,op=p.op as string;
 if(op==='and'||op==='or')return {op,clauses:(p.clauses as unknown[]).map(identityPredicate)};
 if(op==='not')return {op,clause:identityPredicate(p.clause)};
 if(op==='text')return {op,field:p.field,value:p.value,match_kind:p.match_kind,case_sensitive:p.case_sensitive??false,accent_sensitive:p.accent_sensitive??false};
 if(op==='text_in')return {op,field:p.field,values:p.values,case_sensitive:p.case_sensitive??false,accent_sensitive:p.accent_sensitive??false};
 if(op==='in')return {op,field:p.field,values:(p.values as unknown[]).map(canonicalJsonValue)};
 if(op==='is_missing'||op==='is_null'||op==='is_value')return {op,field:p.field};
 return {op,field:p.field,value:canonicalJsonValue(p.value)};
}
/** Mirror serde's Query field order, omitted options, defaults, and UTF-8 JSON identity framing. */
function queryIdentityText(topic:string,fingerprint:string,query:Record<string,unknown>):string{
 const grouped=Object.hasOwn(query,'global')||Object.hasOwn(query,'groupBy');
 const aggregateInput=query.aggregates;
 const aggregates=object(aggregateInput)?Object.fromEntries(Object.keys(aggregateInput).sort().map(alias=>{const a=aggregateInput[alias] as Record<string,unknown>;return [alias,a.aggFunc==='count'?{aggFunc:a.aggFunc}:{aggFunc:a.aggFunc,field:a.field}]})):undefined;
 const identity={...(query.semanticProfile===undefined?{}:{semantic_profile:query.semanticProfile}),...(query.global===undefined?{}:{global:query.global}),...(query.having===undefined?{}:{having:identityPredicate(query.having)}),...(query.select===undefined?{}:{select:query.select}),...(query.groupBy===undefined?{}:{group_by:query.groupBy}),...(aggregates===undefined?{}:{aggregates}),where:query.where===undefined?null:identityPredicate(query.where),order_by:(query.orderBy as Record<string,unknown>[]).map(order=>({...(order.field===undefined?{}:{field:order.field}),...(grouped&&order.aggregate!==undefined?{aggregate:order.aggregate}:{}),direction:order.direction}))};
 return JSON.stringify([topic,fingerprint,identity]);
}
function numericSerializationSlack(value:unknown):number{if(typeof value==='number'){if(Number.isSafeInteger(value))return 0;const sourceBytes=encoder.encode(JSON.stringify(value)!).length;return Math.max(0,32-sourceBytes);}if(Array.isArray(value))return value.reduce<number>((count,item)=>count+numericSerializationSlack(item),0);if(object(value))return Object.values(value).reduce<number>((count,item)=>count+numericSerializationSlack(item),0);return 0;}
function validateQueryIdentityBytes(topic:string,fingerprint:string,query:unknown):void{
 if(!object(query)||!Array.isArray(query.orderBy))throw Error('invalid query shape');
 // serde_json/Ryu can spell non-safe-integer f64 values differently from
 // JSON.stringify. Reserve the remaining space up to Ryu's 32-byte finite-float
 // buffer for each such operand; safe integers retain the same JSON integer form.
 if(encoder.encode(queryIdentityText(topic,fingerprint,query)).length+numericSerializationSlack(query)>MAX_QUERY_IDENTITY_BYTES)throw Error('query byte bound');
}
/** Capability detection after bounded typed query validation. */
export function requiresTextPredicate(value:unknown):boolean {if(!object(value))return false;if(['text','text_in','contains','startsWith','endsWith'].includes(String(value.op)))return true;if(value.op==='not')return requiresTextPredicate(value.clause);return (value.op==='and'||value.op==='or')&&Array.isArray(value.clauses)&&value.clauses.some(requiresTextPredicate);}

function aggregateField(schema:Schema,alias:string,a:Aggregate<Schema>,global:boolean,profile?:SemanticProfile):Field{
 const f=a.field?schema.fields.find(f=>f.name===a.field)!:undefined;
 const kind=a.aggFunc==='count'||a.aggFunc==='countDistinct'?'decimal':a.aggFunc==='sum'||a.aggFunc==='avg'?f!.kind==='number'&&!profile?'number':'decimal':f!.kind;
 return {name:alias,kind,optional:!!profile&&['min','max'].includes(a.aggFunc)&&(global||!!f?.optional),nullable:profile?['min','max'].includes(a.aggFunc)&&!!f?.nullable:['avg','min','max'].includes(a.aggFunc)&&(global||!!f?.optional||!!f?.nullable),...(kind==='enum'?{enum_domain:schema.expansion?.leaves.find(l=>l.path===a.field)?.enum_domain}:{})};
}
function validateAggregateOperand(schema:Schema,a:Aggregate<Schema>,value:unknown,semanticProfile?:SemanticProfile):void{
 if(value===null||value===undefined)throw Error('non-null HAVING operand required');
 validateGroupedRow(schema,{global:true,aggregates:{value:a},orderBy:[],...(semanticProfile?{semanticProfile}:{})},{value},['value']);
}
export function aggregateCount(value:string|bigint):AggregateCount{const s=String(value);if(!/^(0|[1-9][0-9]*)$/.test(s)||s.length>20||BigInt(s)>=(1n<<64n))throw Error('aggregate count');return s as AggregateCount;}
export function aggregateInteger(value:string|bigint):AggregateInteger{const s=String(value);if(!/^(0|-?[1-9][0-9]*)$/.test(s)||s.length>78||BigInt(s)<-(1n<<255n)||BigInt(s)>=(1n<<255n))throw Error('aggregate integer');return s as AggregateInteger;}
export function aggregateDecimal(value:string,semanticProfile?:SemanticProfile):AggregateDecimal{if(value.length>(semanticProfile?1024:514)||!/^(?:0|-?(?:[1-9][0-9]*|0)(?:\.[0-9]*[1-9])?)$/.test(value)||value==='-0'||(value.split('.')[1]?.length??0)>(semanticProfile?424:128))throw Error('aggregate decimal');return value as AggregateDecimal;}
