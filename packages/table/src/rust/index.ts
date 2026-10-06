import {useEffect,useId,useMemo,useState} from 'react';
import type {BrowserProductProvider} from '@bruno/view-server-client/react';
import type {BrowserCatalog,Schema} from '@bruno/view-server-client/schema';
import {admitCatalog,completeSelect,compile,decodeCompleteRows} from './translate.ts';
import {createController,type ProviderPort} from './controller.ts';
import type {Chrome,CompatRow,CompatResult,Query,WholeResult} from './types.ts';
export {encodeCompatRow} from './translate.ts';
export type {CompatRow,CompatResult,Query,RawQuery,GroupedQuery,Filter,Where,Viewport,CompleteSelect} from './types.ts';
const initial:Chrome=Object.freeze({totalRows:0,version:0,status:'loading'});
// One microtask of deferred disposal distinguishes React StrictMode effect replay
// from an actual unmount. Replay setup advances the epoch synchronously; true
// unmount still closes every watch at the next microtask, without timers/history.
function createOwnedLifetime(controller:{destroy():void}) {
 let epoch=0;
 return {setup(){const current=++epoch;return()=>queueMicrotask(()=>{if(epoch===current)controller.destroy();});}};
}
function useOwnedCleanup(controller:{destroy():void}){
 const lifetime=useMemo(()=>createOwnedLifetime(controller),[controller]);
 useEffect(()=>lifetime.setup(),[lifetime]);
}
function createWholeResultHook<S extends Schema>(provider:ProviderPort,topic:string,entry:{schema:S;fingerprint:string},owner:object){return function useWholeResult<const Q extends Query<S>>(query:Q):WholeResult<CompatResult<S,Q>>{
   const wholeId=useId(),compiled=compile(entry.schema,topic,entry.fingerprint,query);
   const [value,setValue]=useState<{owner:typeof owner;key:string;rows:readonly CompatResult<S,Q>[];chrome:Chrome}>({owner,key:compiled.key,rows:[],chrome:initial});
   const controller=useMemo(()=>createController<S>(provider,topic,entry.schema,entry.fingerprint,wholeId,chrome=>setValue(previous=>({...previous,chrome})),true),[owner,provider,topic,entry.schema,entry.fingerprint,wholeId]);
   useOwnedCleanup(controller);
   useEffect(()=>{setValue({owner,key:compiled.key,rows:[],chrome:initial});controller.replace({query,window:{firstRow:0,lastRow:4095},sink:{setRowCount(){},setRowData(rows){setValue(previous=>({...previous,owner,key:compiled.key,rows:Object.freeze(Object.values(rows))}));}}});},[controller,compiled.key]);
   return value.owner===owner&&value.key===compiled.key?{...value.chrome,rows:value.rows}:{...initial,rows:[]};
  };}
type CompleteState<S extends Schema>={readonly status:'loading'|'ready'|'error';readonly rows:readonly CompatRow<S>[];readonly loaded:number;readonly totalRows:number;readonly version:number;readonly error?:string};
function subscribeComplete<S extends Schema>(provider:Pick<BrowserProductProvider,'watchComplete'>,topic:string,entry:{schema:S;fingerprint:string},changed:(value:CompleteState<S>)=>void){
 let live=true,version=0;const cache=new WeakMap<object,CompatRow<S>>();
 const stop=provider.watchComplete(topic,entry.schema,entry.fingerprint,snapshot=>{
  if(!live)return;
  try{const rows=snapshot.status==='ready'?decodeCompleteRows<S>(entry.schema,snapshot.rows,cache):[];if(snapshot.status==='ready')version+=1;changed({status:snapshot.status,loaded:snapshot.loaded,totalRows:rows.length,version:snapshot.status==='ready'?version:0,rows,...(snapshot.error?{error:snapshot.error}:{})});}
  catch(error){changed({status:'error',loaded:snapshot.loaded,totalRows:0,version:0,rows:[],error:error instanceof Error?error.message:String(error)});}
 });return()=>{live=false;stop();};
}
export function createBrunoTableHooks<const C extends BrowserCatalog>(input:C){
 const catalog=admitCatalog(input);
 function useViewportSource<const T extends keyof C&string>(provider:ProviderPort,topic:T){
  const entry=catalog[topic],id=useId();
  const owner=useMemo(()=>({provider,topic}),[provider,topic]);
  const [state,setState]=useState({owner,chrome:initial});
  const viewport=useMemo(()=>createController<C[T]['schema']>(provider,topic,entry.schema,entry.fingerprint,id,chrome=>setState({owner,chrome})),[owner,provider,topic,entry.schema,entry.fingerprint,id]);
  useOwnedCleanup(viewport);
  const completeRawSelect=useMemo(()=>completeSelect<C[T]['schema']>(entry.schema),[entry]);
  const useWholeResult=useMemo(()=>createWholeResultHook<C[T]['schema']>(provider,topic,entry,owner),[owner,provider,topic,entry]);
  return {viewport,completeRawSelect,useWholeResult,...(state.owner===owner?state.chrome:initial)};
 }
 function useCompleteSource<const T extends keyof C&string>(provider:Pick<BrowserProductProvider,'watchComplete'>,topic:T) {
  const owner=useMemo(()=>({provider,topic}),[provider,topic]);
  type State={readonly status:'loading'|'ready'|'error';readonly rows:readonly CompatRow<C[T]['schema']>[];readonly loaded:number;readonly totalRows:number;readonly version:number;readonly error?:string};
  const [current,setCurrent]=useState<{readonly owner:typeof owner;readonly value:State}>({owner,value:{status:'loading',rows:[],loaded:0,totalRows:0,version:0}});
  useEffect(()=>subscribeComplete<C[T]['schema']>(provider,topic,catalog[topic],value=>setCurrent({owner,value})),[owner,provider,topic]);
  return current.owner===owner?current.value:{status:'loading' as const,rows:[],loaded:0,totalRows:0,version:0};
 }
 return {catalog,useViewportSource,useCompleteSource};
}
