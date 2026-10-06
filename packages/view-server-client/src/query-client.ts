import type {BrowserProductProvider} from './product-provider';
import {defineCatalog,validateQuery,type BrowserCatalog,type TopicQuery,type QueryResult,type QueryCheck} from './topic-schema';
/** Bounded one-shot queries over the production provider, inferred from its catalog. */
export function createQueryClient<const C extends BrowserCatalog>(provider:BrowserProductProvider,input:C){
 const catalog=defineCatalog(input);
 return {async query<const T extends keyof C&string,const Q extends TopicQuery<C[T]['schema']>>(topic:T,query:Q&QueryCheck<Q,C[T]['schema']>){
  const entry=catalog[topic];validateQuery(entry.schema,query);
  const subscription='once-'+crypto.randomUUID();
  const wire={topic,schema:entry.fingerprint,...(query.semanticProfile?{semantic_profile:query.semanticProfile}:{}),...(query.global?{global:true,aggregates:query.aggregates}:'groupBy'in query&&query.groupBy?{group_by:query.groupBy,aggregates:query.aggregates}:{select:query.select}),...(query.where===undefined?{}:{where:query.where}),...(query.having===undefined?{}:{having:query.having}),order_by:query.orderBy,offset:0,limit:4096};
  try{const responses=await provider.apply({command:'open',subscription,query:wire});const result=responses[subscription];
   if(!result||!result.keys||result.keys.length!==result.rows.length||result.total_rows!==result.rows.length)throw Error('Bounded complete query is incomplete');
   // The production Worker validates the generated schema/result descriptor before delivery.
   const rows=result.rows.map((payload,index)=>Object.freeze({...payload,rowId:result.keys![index]})) as QueryResult<C[T]['schema'],Q>[];
   return {rows:Object.freeze(rows),totalRows:result.total_rows,version:result.version};
  }finally{await provider.apply({command:'close',subscription});}
 }};
}
