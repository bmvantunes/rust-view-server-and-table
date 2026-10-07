import type { BrowserCatalog } from './topic-schema';
import type { TopicRuntimeQuery, ProductResult, ProviderOptions } from './product-provider';

type Exports = WebAssembly.Exports & {
  memory: WebAssembly.Memory;
  view_engine_new(): number;
  view_engine_free(handle: number): void;
  view_engine_alloc(length: number): number;
  view_engine_dealloc(pointer: number, length: number): void;
  view_engine_command(handle: number, pointer: number, length: number): number;
  view_engine_output_ptr(handle: number): number;
  view_engine_output_len(handle: number): number;
};
type Request = {type:'apply';id:number;command:unknown;acquisition?:number;traceparent:string};
type Configure = {type:'configure';options:Extract<ProviderOptions,{mode:'memory'}>};
type Subscription = {query:TopicRuntimeQuery; acquisition:number; generation:number; sequence:number};
const scope = self as unknown as {onmessage:((event:MessageEvent<Request|Configure|{type:'dispose'}>)=>void)|null;postMessage(message:unknown):void};
let api:Exports|undefined, handle=0, disposed=false, configured=false;
const subscriptions = new Map<string,Subscription>();
class EngineFailure extends Error {}
function command(value:unknown):unknown {
  if(disposed||!api||!handle)throw Error('engine unavailable');
  const bytes=new TextEncoder().encode(JSON.stringify(value));
  const pointer=api.view_engine_alloc(bytes.length);if(!pointer)throw Error('command byte bound');
  try {
    new Uint8Array(api.memory.buffer,pointer,bytes.length).set(bytes);
    let status:number;
    try{status=api.view_engine_command(handle,pointer,bytes.length);}catch(error){throw new EngineFailure(`engine trapped; application outcome uncertain: ${String(error)}`);}
    if(status===2||status===3)throw new EngineFailure('engine unavailable; application outcome uncertain');
    const output=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(new Uint8Array(api.memory.buffer,api.view_engine_output_ptr(handle),api.view_engine_output_len(handle)))) as {value?:unknown;error?:string};
    if(status!==0)throw Error(output.error??'engine command rejected');
    return output.value;
  }finally{api.view_engine_dealloc(pointer,bytes.length);}
}
function result(id:string,entry:Subscription):ProductResult {
  const value=command({command:'read',subscription:id,offset:entry.query.offset,limit:Math.min(entry.query.limit,4096),max_bytes:4194304}) as {total_rows:number;rows:ProductResult['rows'];keys:string[];version:string;result_shape?:string};
  if(value.total_rows-entry.query.offset>4096&&entry.query.limit>4096)throw Error('complete local result exceeds 4096 row bound');
  const version=Number(value.version);if(!Number.isSafeInteger(version))throw Error('version bound');
  return {subscription:id,query_generation:entry.generation,sequence:++entry.sequence,start_rank:entry.query.offset,version,total_rows:value.total_rows,rows:value.rows,keys:value.keys,...(value.result_shape?{result_shape:value.result_shape,result_kind:entry.query.join?(entry.query.global?'join_global_v1':entry.query.group_by?'join_grouped_v1':'join_v1'):(entry.query.global?'global_v1':'grouped_v1')}: {})};
}
function open(id:string,query:TopicRuntimeQuery):void {
  const {topic,schema,join,offset:_offset,limit:_limit,...engineQuery}=query;
  command({command:'open',subscription:id,topic,schema,join,query:engineQuery});
}
async function initialize(options:Configure['options']):Promise<void> {
  if(configured)throw Error('duplicate engine configuration');configured=true;
  const instance=await WebAssembly.instantiate(options.module,{});
  if(disposed)return;
  api=instance.exports as Exports;handle=api.view_engine_new();if(!handle)throw Error('engine initialization failed');
  const catalog:BrowserCatalog=options.catalog;
  const schemas=[...new Map(Object.values(catalog).map(v=>[v.fingerprint,v.schema])).values()];
  command({command:'initialize',catalog:{format:1,schemas,topics:Object.entries(catalog).map(([topic,v])=>({topic,schema:v.fingerprint}))},sources:options.sources,max_rows:options.maxRows??250000,retention:options.retention??{},now_ms:options.nowMs??0});
  scope.postMessage({type:'ready'});
}
function apply(request:Request):void {
  const input=request.command as {command:string;subscription?:string;query?:TopicRuntimeQuery;offset?:number;limit?:number;topic?:string};
  const id=input.subscription??'';const prior=subscriptions.get(id);
  if(!/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[0-9a-f]$/.test(request.traceparent))throw Error('invalid traceparent');
  const selected=new Set<string>();
  if(input.command==='open'||input.command==='change_query') {
    if(!request.acquisition||prior&&request.acquisition<=prior.acquisition)throw Error('obsolete acquisition');
    const query=input.query!;const candidate={query,acquisition:request.acquisition,generation:(prior?.generation??0)+1,sequence:0};
    const temporary=`candidate/${request.id}`;
    open(temporary,query);
    try{result(temporary,candidate);}finally{command({command:'close',subscription:temporary});}
    open(id,query);candidate.sequence=0;subscriptions.set(id,candidate);selected.add(id);
  }else if(input.command==='change_window') {
    if(!prior||request.acquisition!==prior.acquisition)throw Error('obsolete acquisition');
    const candidate={...prior,query:{...prior.query,offset:input.offset!,limit:input.limit!}};
    result(id,candidate);candidate.sequence=prior.sequence;subscriptions.set(id,candidate);selected.add(id);
  }else if(input.command==='close') {
    if(!prior||request.acquisition!==prior.acquisition)throw Error('obsolete acquisition');
    command({command:'close',subscription:id});subscriptions.delete(id);
  }else if(input.command==='publish') {
    command(input);
    for(const [name,entry]of subscriptions)if(entry.query.topic===input.topic||entry.query.join?.right.topic===input.topic)selected.add(name);
  }else if(input.command==='advance_time'){command(input);for(const name of subscriptions.keys())selected.add(name);
  }else if(input.command!=='flush')throw Error('unsupported memory command');
  const results:Record<string,ProductResult>={},acquisitions:Record<string,number>={};
  // A post-application extraction failure cannot be reported as a rejected write.
  try {
    for(const name of selected){const entry=subscriptions.get(name)!;results[name]=result(name,entry);acquisitions[name]=entry.acquisition;}
  }catch(error){disposed=true;scope.postMessage({type:'fatal',error:`Mutation/query applied; observer delivery failed: ${String(error)}`});return;}
  scope.postMessage({type:'ack',id:request.id,results,acquisitions,stats:{},traceparent:request.traceparent});
}
scope.onmessage=event=>{
  const message=event.data;
  if(message.type==='dispose'){disposed=true;subscriptions.clear();if(handle)api?.view_engine_free(handle);handle=0;return;}
  if(disposed)return;
  if(message.type==='configure'){void initialize(message.options).catch(error=>{if(!disposed)scope.postMessage({type:'fatal',error:String(error)});});return;}
  try{apply(message);}catch(error){if(error instanceof EngineFailure){disposed=true;scope.postMessage({type:'fatal',error:error.message});return;}scope.postMessage({type:'request_error',id:message.id,error:String(error),currentAcquisition:subscriptions.get((message.command as {subscription?:string}).subscription??'')?.acquisition,traceparent:message.traceparent});}
};
