import type {Field,Schema,SourceCleanupPolicy} from './topic-schema';
export type KeyField={readonly name:string;readonly tag:number;readonly kind:Field['kind']};
type Key<K extends readonly KeyField[]>={readonly source:'key';readonly field:K[number]['name']};
type RequiredField<S extends Schema>=S['fields'][number] extends infer F?F extends Field?F['optional'] extends false?F['nullable'] extends false?F['name']:never:never:never:never;
type Value<S extends Schema>={readonly source:'value';readonly field:RequiredField<S>};
export type IdentityPolicy=SourceCleanupPolicy;
/** Build-time selector constructor, never an executable per-record JS callback. */
export function deleteRowId<const K extends readonly KeyField[],const S extends Schema>(keyFields:K,schema:S,components:readonly [Key<K>|Value<S>,...(Key<K>|Value<S>)[]]){
 return checked('delete',keyFields,schema,components);
}
/** Compact APIs expose key selectors only, including for null tombstones. */
export function compactRowId<const K extends readonly KeyField[],const P extends 'compact'|'compact,delete'='compact'>(keyFields:K,components:readonly [Key<K>,...Key<K>[]],policy:P='compact' as P){
 return checked(policy,keyFields,undefined,components);
}
function checked<P extends IdentityPolicy>(source_policy:P,keyFields:readonly KeyField[],schema:Schema|undefined,components:readonly {readonly source:'key'|'value';readonly field:string}[]){
 if(components.length<1||components.length>16)throw Error('identity component bound');
 for(const c of components){if(!c||Object.keys(c).length!==2||typeof c.field!=='string'||(c.source==='key'?!keyFields.some(f=>f.name===c.field):c.source!=='value'||source_policy!=='delete'||!schema?.fields.some(f=>f.name===c.field&&!f.optional&&!f.nullable)))throw Error('invalid identity selector');}
 return Object.freeze({source_policy,components:Object.freeze(components.map(c=>Object.freeze({...c})))});
}
