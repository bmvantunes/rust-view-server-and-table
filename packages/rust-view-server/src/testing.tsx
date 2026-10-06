import {createElement,type PropsWithChildren} from 'react';
import {BrowserProductProvider,ProductProvider} from './product-provider';
import {defineCatalog,type BrowserCatalog,type Row,type Scalar,type ScalarKind} from './topic-schema';

type KeyField={readonly name:string;readonly tag:number;readonly kind:ScalarKind};
export type SourceMetadata={readonly keyFields:readonly KeyField[];readonly identity:{readonly source_policy:'delete'|'compact'|'compact,delete';readonly components:readonly {readonly source:'key'|'value';readonly field:string}[]}};
export type GeneratedKey<S extends SourceMetadata>={[F in S['keyFields'][number] as F['name']]:Scalar<F['kind']>};
export type PublishReceipt={readonly accepted:number;readonly applied:Promise<void>;readonly delivered:Promise<void>};
/** Local application and observer delivery are never Kafka durability acknowledgements. */
export async function createTestViewServer<const C extends BrowserCatalog,const S extends {[T in keyof C]:SourceMetadata}>(options:{catalog:C;sources:S;module?:WebAssembly.Module;wasmUrl?:string|URL;maxRows?:number;signal?:AbortSignal;timeoutMs?:number;clock?:{nowMs:number};retention?:Partial<Record<keyof C,{maxRetentionMinutes?:number;maxRetentionMessages?:number;maxRetentionMessagesPerKey?:number}>>}) {
  const timeoutMs=options.timeoutMs??10000;
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw Error("fixture timeout bound");
  options.signal?.throwIfAborted();
  if(options.clock&&(!Number.isSafeInteger(options.clock.nowMs)||options.clock.nowMs<0))throw Error("clock safe nonnegative integer required");
  const catalog=defineCatalog(options.catalog);
  const initialization=new AbortController();
  const abort=()=>initialization.abort(options.signal?.reason??Error("fixture initialization cancelled"));
  options.signal?.addEventListener("abort",abort,{once:true});
  const initializationTimer=setTimeout(()=>initialization.abort(Error("fixture initialization deadline")),timeoutMs);
  let module:WebAssembly.Module;
  try{module=options.module??await (async()=>{const response=await fetch(options.wasmUrl??new URL('./generic_engine.wasm',import.meta.url),{signal:initialization.signal});if(!response.ok)throw Error(`generic WASM unavailable (${response.status})`);return WebAssembly.compile(await response.arrayBuffer());})();initialization.signal.throwIfAborted();}
  catch(error){clearTimeout(initializationTimer);options.signal?.removeEventListener("abort",abort);throw error;}
  let provider:BrowserProductProvider;
  try{provider=new BrowserProductProvider({mode:'memory',catalog,sources:Object.fromEntries(Object.keys(catalog).map(topic=>[topic,options.sources[topic]])),module,maxRows:options.maxRows??250000,retention:options.retention,nowMs:options.clock?.nowMs??Date.now()});}
  catch(error){clearTimeout(initializationTimer);options.signal?.removeEventListener("abort",abort);throw error;}
  const abortProvider=()=>provider.dispose();initialization.signal.addEventListener("abort",abortProvider,{once:true});
  try{await provider.ready;initialization.signal.throwIfAborted();}catch(error){provider.dispose();throw error;}finally{clearTimeout(initializationTimer);options.signal?.removeEventListener("abort",abort);initialization.signal.removeEventListener("abort",abortProvider);}
  let disposed=false,sequence=0;
  const pending=new Set<Promise<void>>();
  let maintenance:ReturnType<typeof setTimeout>|undefined;
  let lastTick=performance.now();
  function schedule(){if(disposed||options.clock||!options.retention)return;maintenance=setTimeout(()=>{const now=performance.now();const milliseconds=Math.floor(now-lastTick);lastTick+=milliseconds;void submit({command:"advance_time",milliseconds}).delivered.then(schedule,()=>{disposed=true;provider.dispose();});},250);}
  schedule();
  function submit(command:unknown):PublishReceipt {
    if(disposed)throw Error('fixture disposed');
    const timer=setTimeout(()=>provider.dispose(),timeoutMs);
    const applied=provider.apply(command).then(()=>undefined).finally(()=>clearTimeout(timer));
    // Provider ACK publishes synchronous observers before these Promise reactions.
    const delivered=applied.then(()=>undefined);
    pending.add(delivered);void delivered.finally(()=>pending.delete(delivered)).catch(()=>{});
    return Object.freeze({accepted:++sequence,applied,delivered});
  }
  return {
    provider,
    Provider:({children}:PropsWithChildren)=>createElement(ProductProvider,{provider},children),
    publish<T extends keyof C&string>(topic:T,input:{key:GeneratedKey<S[T]>;value:Row<C[T]['schema']>}){return submit({command:'publish',topic,key:input.key,value:input.value});},
    delete<T extends keyof C&string>(topic:T,key:GeneratedKey<S[T]>){return submit({command:'publish',topic,key,value:null});},
    advanceTime(milliseconds:number){if(!options.clock)throw Error("advanceTime requires an explicit controlled clock");if(!Number.isSafeInteger(milliseconds)||milliseconds<0)throw Error("clock advance must be nonnegative safe integer");return submit({command:"advance_time",milliseconds});},
    async awaitApplied(receipt:PublishReceipt){await receipt.applied;},
    async flush(){await submit({command:'flush'}).delivered;await Promise.all([...pending]);},
    async dispose(){if(disposed)return;disposed=true;clearTimeout(maintenance);provider.dispose();await Promise.allSettled([...pending]);},
  };
}
