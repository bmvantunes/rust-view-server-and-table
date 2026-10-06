import {joinSchema,joinResultShape,validateJoinRow,type JoinWire} from './join-schema';
import {requiresTextPredicate,verifyCatalog,validateRow,validateQuery,resultShape,groupId,queryFields,validateGroupedRow,type AggregateQuery,type Schema,type BrowserCatalog} from './topic-schema';
import {createBrowserTelemetry,type BrowserTelemetryConfig} from './browser-telemetry';
import type {ClientTelemetry} from './product-provider';
import {reconstruct} from './row-delta.mjs';
import {encode,decodeNative,adapt,encodeGeneric,decodeGeneric} from './wire/msgpack.mjs';
import {initializeAdmission,admitEnvelope} from './request-admission';
const codec='msgpack';
import type { TopicRuntimeQuery, ProductResult } from './product-provider';
type Apply = { type:'apply';id:number;command:{command:string;subscription?:string};acquisition?:number;previousAcquisition?:number;traceparent:string;traceContext?:string };
type Options={url:string;token:string;subscriptions?:number;catalog?:BrowserCatalog;fieldPatches?:boolean;schemaEvolution?:boolean};
type Pending={request:Apply;result?:ProductResult;timer:ReturnType<typeof setTimeout>};
const scope=self as unknown as {onmessage:((e:MessageEvent<Apply|{type:'configure';options:Options;telemetry?:BrowserTelemetryConfig}|{type:'health_subscribe';enabled:boolean}|{type:'complete_open';acquisition:string;topic:string;schema:string}|{type:'complete_next';acquisition:string;acknowledged:number}|{type:'complete_cancel';acquisition:string}|{type:'dispose'}>)=>void)|null;postMessage(v:unknown):void};
let telemetry:ClientTelemetry|undefined,healthAllowed=false,traceAllowed=false;
let socket:WebSocket|undefined, incarnation='',connection='',nonce='',done=false,configured=false;
let heartbeat:ReturnType<typeof setInterval>|undefined;
let last=performance.now();
let joinAllowed=false;let effectSemanticsAllowed=false;
let catalog:BrowserCatalog|undefined;let version=14;let fieldPatches=false;let globalHavingAllowed=false,textAllowed=false,groupedAllowed=false;const activeQueries=new Map<string,{acquisition:number;query:TopicRuntimeQuery}>();
const pending=new Map<number,Pending>();const acquisitions=new Map<string,number>();const bases=new Map<string,{acquisition:number;result:ProductResult}>();
const post=(v:unknown)=>{const t=performance.now();scope.postMessage(v);const ns=Math.round((performance.now()-t)*1e6);scope.postMessage({type:'v13_metrics',postCallNs:ns,workerTimeOrigin:performance.timeOrigin,workerEndNs:Math.round(performance.now()*1e6)});};
function fatal(message:string,recoverable=false,code="protocol"):void{if(done)return;done=true;for(const p of pending.values())clearTimeout(p.timer);pending.clear();acquisitions.clear();bases.clear();clearInterval(heartbeat);socket?.close();post({type:'fatal',error:message+'; pending completion uncertain',recoverable,code});}
const integer=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
function record(v:unknown):v is Record<string,unknown>{return typeof v==='object'&&v!==null&&!Array.isArray(v);}
function send(v:unknown):void{if(!socket||socket.readyState!==WebSocket.OPEN)throw Error('remote socket unavailable');const text=catalog?encodeGeneric(v):encode(v,codec);const bytes=text.byteLength;if(bytes>4194304||socket.bufferedAmount+bytes>8388608)throw Error('remote send budget exceeded');socket.send(text);}
function envelope(v:Record<string,unknown>):Record<string,unknown>{return {...v,v:version,incarnation,connection,nonce};}
scope.onmessage=async e=>{
 const m=e.data;if(done)return;if(m.type==='dispose'){fatal('provider disposed');return;}
 if(m.type==='complete_open'||m.type==='complete_next'||m.type==='complete_cancel'){
  try {if(!catalog||!incarnation)throw Error('complete source unavailable');
   if(m.type==='complete_open'&&catalog[m.topic]?.fingerprint!==m.schema)throw Error('complete source schema mismatch');
   const request=m.type==='complete_open'?{op:'open',acquisition:m.acquisition,topic:m.topic,schema:m.schema}:m.type==='complete_next'?{op:'next',acquisition:m.acquisition,acknowledged:m.acknowledged}:{op:'cancel',acquisition:m.acquisition};
   send(envelope({type:'complete',request}));
  }catch(error){post({type:'complete_error',acquisition:m.acquisition,error:String(error)});}return;
 }
 if(m.type==='configure'){
  if(configured){fatal('duplicate configuration');return;}configured=true;
  if(m.telemetry)try{telemetry=createBrowserTelemetry(m.telemetry,'worker');}catch{}
  let url:URL;try{url=new URL(m.options.url);}catch{fatal('invalid remote URL');return;}if(url.protocol!=='ws:'||url.hostname!=='127.0.0.1'||url.pathname!==(m.options.catalog?'/v15':'/v14')||url.search||url.username||url.password){fatal('remote mode requires an explicit matching loopback protocol URL');return;}
  nonce=Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
  try{if(m.options.catalog){await verifyCatalog(m.options.catalog);catalog=m.options.catalog;version=15;}else await initializeAdmission();}catch(e){fatal(String(e));return;}if(done)return;
  socket=new WebSocket(url,`view-server.v${version}.msgpack`);socket.binaryType='arraybuffer';socket.onopen=()=>{try{send({type:'hello',v:version,token:m.options.token,nonce,...(catalog?{catalog:Object.fromEntries(Object.entries(catalog).map(([t,s])=>[t,s.fingerprint]))}:{}),capabilities:[...(catalog?['generic_schemas_v1','grouped_aggregates_v1',...(m.options.fieldPatches?['selected_field_patches_v1']:[]),'text_predicates_v1','global_having_v1','bounded_joins_v1',...(Object.values(catalog).some(e=>e.schema.format===3)?['schema_expansion_v1']:[])]:[]),'health_v1',...(m.options.schemaEvolution?['schema_evolution_v1']:[]),...(telemetry?['trace_v1']:[])]});}catch(e){fatal(String(e));}};
  socket.onerror=()=>fatal('remote connection error',true,'network');socket.onclose=e=>fatal('remote connection closed',![1002,1007,1008,1009].includes(e.code),'close-'+e.code);
  heartbeat=setInterval(()=>{if(performance.now()-last>10000){fatal('remote heartbeat/readiness timeout',true,'heartbeat-timeout');return;}if(incarnation)try{send(envelope({type:'ping'}));}catch(e){fatal(String(e),true,'heartbeat-send');}},2000);
  socket.onmessage=e=>{
   if(done)return;if(!(e.data instanceof ArrayBuffer)){fatal('binary frame required');return;}
   if(e.data.byteLength>4*1024*1024){fatal('remote frame budget');return;}
   let v:unknown;let decodeNs=0,adaptNs=0;try{const t=performance.now();const native=catalog?decodeGeneric(new Uint8Array(e.data)):decodeNative(new Uint8Array(e.data),codec);decodeNs=Math.round((performance.now()-t)*1e6);const a=performance.now();v=catalog?native:adapt(native,codec);adaptNs=Math.round((performance.now()-a)*1e6);}catch{fatal('malformed binary frame');return;}finally{scope.postMessage({type:'v13_metrics',receivedBinaryBytes:e.data.byteLength,receivedFrameType:record(v)&&typeof v.type==='string'?v.type:'invalid'});}
   if(!record(v)||v.v!==version){fatal('incompatible binary envelope version');return;}
   if(!record(v)||v.v!==version||v.nonce!==nonce||typeof v.incarnation!=='string'||typeof v.connection!=='string'||!/^[0-9a-f]{32}$/.test(v.incarnation)||!/^\d{1,20}$/.test(v.connection))return;
   if(v.type==='ready'){
    if(m.options.schemaEvolution&&(!record(v.capabilities)||v.capabilities.schema_evolution_v1!==true)){fatal('schema evolution capability unavailable');return;}
    if(catalog&&(!record(v.capabilities)||v.capabilities.generic_schemas_v1!==true||Object.values(catalog).some(e=>e.schema.format===3)&&v.capabilities.schema_expansion_v1!==true||!record(v.catalog)||Object.keys(v.catalog).length!==Object.keys(catalog).length||Object.entries(catalog).some(([t,s])=>(v.catalog as Record<string,unknown>)[t]!==s.fingerprint))){fatal('catalog capability mismatch');return;}
    if(incarnation||!Array.isArray(v.coverage)||v.coverage.length===0||!v.coverage.every(integer))return;
    if(!record(v.limits)||!integer(v.limits.per_client)||!integer(v.limits.total)||(m.options.subscriptions??16)>v.limits.per_client){fatal('remote subscription capability unavailable');return;}
    effectSemanticsAllowed=record(v.capabilities)&&v.capabilities.effect_semantics_v1===true;
    globalHavingAllowed=record(v.capabilities)&&v.capabilities.global_having_v1===true;joinAllowed=record(v.capabilities)&&v.capabilities.bounded_joins_v1===true;textAllowed=record(v.capabilities)&&v.capabilities.text_predicates_v1===true;fieldPatches=m.options.fieldPatches===true&&record(v.capabilities)&&v.capabilities.selected_field_patches_v1===true;groupedAllowed=record(v.capabilities)&&v.capabilities.grouped_aggregates_v1===true;healthAllowed=record(v.capabilities)&&v.capabilities.health_v1===true;traceAllowed=record(v.capabilities)&&v.capabilities.trace_v1===true;
    incarnation=v.incarnation;connection=v.connection;last=performance.now();post({type:'ready',serverIncarnation:incarnation});return;
   }
   if(v.incarnation!==incarnation||v.connection!==connection||!incarnation)return;
   if(v.type==='complete'||v.type==='complete_error'){
    if(typeof v.acquisition!=='string'||!/^[a-f0-9]{32}$/.test(v.acquisition)){fatal('complete identity malformed');return;}
    if(v.type==='complete_error'){if(typeof v.error!=='string'){fatal('complete error malformed');return;}post(v);return;}
    if(v.kind==='cancelled'){post(v);return;}
    if(!catalog||typeof v.topic!=='string'||!catalog[v.topic]||!integer(v.sequence)||!['snapshot','tail','complete','idle'].includes(String(v.kind))||!Array.isArray(v.rows)||v.rows.length>512||!Array.isArray(v.mutations)||v.mutations.length>512||!record(v.cut)){fatal('complete chunk malformed');return;}
    try {for(const row of v.rows){if(!record(row)||typeof row.rowId!=="string")throw Error("rowId");const {rowId,...payload}=row;validateRow(catalog[v.topic].schema,payload);}
     for(const mutation of v.mutations){if(!record(mutation))throw Error('mutation');if(mutation.kind==='upsert'){if(!record(mutation.row)||typeof mutation.row.rowId!=='string')throw Error('rowId');const {rowId,...payload}=mutation.row;validateRow(catalog[v.topic].schema,payload);}else if(mutation.kind!=='delete'||typeof mutation.key!=='string')throw Error('mutation kind');}
    }catch(error){fatal('complete row malformed: '+String(error));return;}
    post(v);return;
   }
   if(v.type==='pong'){last=performance.now();return;}
   if(v.type==='health'){
    const h=v.snapshot;
    if(!healthAllowed||v.version!==1||e.data.byteLength>65536||!record(h)||h.version!==1||typeof h.instance!=='string'||h.instance.length>128||!integer(h.sequence)||!integer(h.sampled_at_unix_ms)||typeof h.ready!=='boolean'||typeof h.live!=='boolean'||!Array.isArray(h.sources)||h.sources.length>(catalog?16:1)||!h.sources.every(s=>record(s)&&typeof s.topic==='string'&&s.topic.length<=128&&Array.isArray(s.partitions)&&s.partitions.length<=32)||!Array.isArray(h.dependencies)||h.dependencies.length>(catalog?64:4)){post({type:'health_unavailable'});return;}
    post({type:'health',snapshot:h});return;
   }
   if(v.type==='query_error'){
    if(!groupedAllowed||typeof v.subscription!=='string'||!integer(v.acquisition)||typeof v.error!=='string'){fatal('malformed query failure');return;}
    if(acquisitions.get(v.subscription)===v.acquisition){acquisitions.delete(v.subscription);bases.delete(v.subscription);activeQueries.delete(v.subscription);post(v);}return;
   }
   if(v.type==='result'){
    if(typeof v.subscription!=='string'||!integer(v.acquisition)||!record(v.result)||v.result.subscription!==v.subscription){fatal('malformed result identity');return;}
    if(v.id!==undefined){if(!integer(v.id)){fatal('invalid result request');return;}const p=pending.get(v.id);if(!p||p.result||v.traceparent!==p.request.traceparent||v.subscription!==p.request.command.subscription||v.acquisition!==p.request.acquisition){fatal('unexpected command result');return;}}
    else if(acquisitions.get(v.subscription)!==v.acquisition&&!Array.from(pending.values()).some(p=>p.request.command.subscription===v.subscription&&p.request.acquisition===v.acquisition&&p.result))return;
    const prior=bases.get(v.subscription);
    const reconstruction=telemetry?.start('worker_reconstruct',traceAllowed&&typeof v.trace_context==='string'&&v.trace_context.length===55?v.trace_context:undefined,v.id===undefined?Array.from(pending.values()).filter(p=>p.request.command.subscription===v.subscription&&p.request.acquisition===v.acquisition&&p.result?.traceContext).map(p=>p.result!.traceContext!).slice(0,4):[]);
    const applyStarted=performance.now();const batch=v.result;let reconstructed:ProductResult;try{const b=v.result;const entry=catalog&&typeof b.topic==='string'?catalog[b.topic]:undefined;
      if(catalog&&(!entry||b.schema!==entry.fingerprint))throw Error('result schema/topic');
      if(catalog&&v.id!==undefined){const desired=(pending.get(v.id as number)?.request.command as unknown as {query?:{topic?:string;schema?:string}})?.query;if(desired&&(desired.topic!==b.topic||desired.schema!==b.schema))throw Error('result desired dataset mismatch');}
      const candidate=Array.from(pending.values()).find(p=>p.request.command.subscription===v.subscription&&p.request.acquisition===v.acquisition&&(p.request.command as {query?:unknown}).query);
      const desired=(candidate?.request.command as {query?:TopicRuntimeQuery}|undefined)?.query??(activeQueries.get(v.subscription as string)?.acquisition===v.acquisition?activeQueries.get(v.subscription as string)?.query:undefined);
      if(catalog&&!desired)throw Error('result has no admitted query');
      const grouped=desired?.global||desired?.group_by?{...(desired.semantic_profile?{semanticProfile:desired.semantic_profile}:{}),...(desired.global?{global:true}:{groupBy:desired.group_by}),aggregates:desired.aggregates,orderBy:desired.order_by,...(desired.where===undefined?{}:{where:desired.where}),...(desired.having===undefined?{}:{having:desired.having})}:undefined;
      if(desired?.join&&entry&&catalog){
       if(!joinAllowed)throw Error('join capability unavailable');const join=desired.join,derived=joinSchema(catalog,desired.topic,join),q={...(grouped??{select:desired.select,orderBy:desired.order_by,...(desired.where===undefined?{}:{where:desired.where})})};validateQuery(derived.schema,q);
       const kind=desired.global?'join_global_v1':desired.group_by?'join_grouped_v1':'join_v1';if(b.result_kind!==kind||b.result_shape!==joinResultShape(derived,q))throw Error('join result descriptor');
       const dependencies=[desired.topic,join.right.topic].sort();if(!record(v.source_cuts)||Object.keys(v.source_cuts).sort().join('|')!==dependencies.join('|'))throw Error('join source cut inventory');
       for(const topic of dependencies){const cut=v.source_cuts[topic];if(!record(cut)||cut.schema!==catalog[topic].fingerprint||typeof cut.source_sequence!=='string'||!/^\d{1,20}$/.test(cut.source_sequence)||typeof cut.content_version!=='string'||!/^\d{1,20}$/.test(cut.content_version)||!record(cut.next)||Object.keys(cut.next).length<1||Object.keys(cut.next).length>32||Object.entries(cut.next).some(([p,n])=>!/^\d{1,10}$/.test(p)||typeof n!=='string'||!/^\d{1,20}$/.test(n)))throw Error('join source cut');}
       reconstructed=reconstruct(prior?.acquisition===v.acquisition?prior.result:undefined,b,{fieldPatches,topic:desired.topic,schema:entry.fingerprint,fields:queryFields(q),key:'rowId',validate:(row,select)=>{if(JSON.stringify(select)!==JSON.stringify(queryFields(q)))throw Error('join projection');if(grouped)validateGroupedRow(derived.schema,q as AggregateQuery<Schema>,row,select);else validateJoinRow(catalog!,desired.topic,join,row,select);},validateKeys:(keys,rows)=>{if(grouped){if(keys.some((k,i)=>k!==groupId(derived.internalTopic,derived.internalFingerprint,derived.schema,q as AggregateQuery<Schema>,rows[i])))throw Error('join group identity');}else if(keys.some(k=>!/^jid1:[0-9a-f]{64}$/.test(k)))throw Error('join raw identity');}});
      }else if(grouped&&entry){validateQuery(entry.schema,grouped);const q=grouped as AggregateQuery<Schema>;if((q.global?!globalHavingAllowed:!groupedAllowed)||b.result_kind!==(q.global?'global_v1':'grouped_v1')||b.result_shape!==resultShape(b.topic as string,entry.fingerprint,q))throw Error('group result descriptor');
       reconstructed=reconstruct(prior?.acquisition===v.acquisition?prior.result:undefined,b,{fieldPatches,topic:b.topic as string,schema:entry.fingerprint,fields:queryFields(q),key:'rowId',validate:(row,select)=>validateGroupedRow(entry.schema,q,row,select),validateKeys:(keys,rows)=>{if(keys.some((k,i)=>k!==groupId(b.topic as string,entry.fingerprint,entry.schema,q,rows[i])))throw Error('group identity mismatch');}});
      }else{if(b.result_kind!==undefined||b.result_shape!==undefined)throw Error('unexpected result kind');reconstructed=reconstruct(prior?.acquisition===v.acquisition?prior.result:undefined,b,entry?{fieldPatches,topic:b.topic as string,schema:entry.fingerprint,fields:entry.schema.fields.map(f=>f.name),key:entry.schema.key,validate:(row,select)=>{if(desired&&JSON.stringify(select)!==JSON.stringify(desired.select))throw Error('raw result projection');validateRow(entry.schema,row,select);}}:undefined);}
      }catch(e){reconstruction?.end('error');fatal(String(e)+'; acquire a new provider snapshot');return;}
    reconstructed.traceContext=reconstruction?.context;reconstruction?.end('ok');
    bases.set(v.subscription,{acquisition:v.acquisition,result:reconstructed});v.result=reconstructed;
    if(typeof v.source_sequence!=='string'||!/^\d{1,20}$/.test(v.source_sequence)){fatal('invalid source cut');return;}
    reconstructed.remote={...(v.source_cuts?{sourceCuts:v.source_cuts}:{}),sourceSequence:v.source_sequence,incarnation,connection,acquisition:v.acquisition,requestId:integer(v.id)?v.id:undefined,batchKind:batch.kind,operationCount:Array.isArray(batch.operations)?batch.operations.length:0,payloadRows:batch.kind==='snapshot'?reconstructed.rows.length:Array.isArray(batch.operations)?batch.operations.filter((o:unknown)=>record(o)&&o.row!==undefined).length:0,applyNs:Math.round((performance.now()-applyStarted)*1e6),receivedNs:Math.round(performance.now()*1e6),encodedBytes:e.data.byteLength,decodeNs,adaptNs,workerTimeOrigin:performance.timeOrigin,workerPostNs:Math.round(performance.now()*1e6)} as ProductResult['remote'];
    if(v.id!==undefined){
     if(!integer(v.id))return;const p=pending.get(v.id);if(!p||p.result||v.traceparent!==p.request.traceparent||v.subscription!==p.request.command.subscription||v.acquisition!==p.request.acquisition)return;
     p.result=reconstructed;
    }else if(Array.from(pending.values()).some(p=>{if(p.request.command.subscription===v.subscription&&p.request.acquisition===v.acquisition&&p.result){p.result=reconstructed;return true;}return false;})){/* staged until admission */}else if(acquisitions.get(v.subscription)===v.acquisition){post({type:'live',results:{[v.subscription]:reconstructed},acquisitions:{[v.subscription]:v.acquisition}});}
    return;
   }
   if(!integer(v.id))return;const p=pending.get(v.id);if(!p||v.traceparent!==p.request.traceparent)return;
   const sub=p.request.command.subscription;
   if(v.type==='request_error'){
    if(typeof v.error!=='string'||(v.currentAcquisition!==null&&v.currentAcquisition!==undefined&&!integer(v.currentAcquisition)))return;
    pending.delete(v.id);clearTimeout(p.timer);post({type:'request_error',id:v.id,error:v.error,...(v.code==='source_not_ready'?{code:'source_not_ready'}:{}),currentAcquisition:v.currentAcquisition??undefined,traceparent:v.traceparent});return;
   }
   if(v.type!=='ack'||v.result_count!==(p.request.command.command==='close'?0:1)||((v.result_count===1)!==!!p.result))return;
   pending.delete(v.id);clearTimeout(p.timer);
   if(sub){if(p.request.command.command==='close'){if(acquisitions.get(sub)===p.request.acquisition){acquisitions.delete(sub);bases.delete(sub);activeQueries.delete(sub);}}else if(p.request.acquisition!==undefined&&p.request.acquisition>=(acquisitions.get(sub)??0)){acquisitions.set(sub,p.request.acquisition);const query=(p.request.command as {query?:TopicRuntimeQuery}).query;if(query)activeQueries.set(sub,{acquisition:p.request.acquisition,query});}}
   post({type:'ack',id:v.id,traceparent:v.traceparent,results:p.result&&sub?{[sub]:p.result}:{},acquisitions:sub?{[sub]:p.request.acquisition}:{}});
  };return;
 }
 if(m.type==='health_subscribe'){if(!incarnation)return;if(!healthAllowed){if(m.enabled)post({type:'health_unavailable'});return;}try{send(envelope({type:'health_subscribe',version:1,enabled:m.enabled}));}catch{post({type:'health_unavailable'});}return;}
 if(pending.size>=64){fatal('remote commands in flight exceeded');return;}
 if(!incarnation){fatal('remote command before readiness');return;}
 const query=(m.command as {query?:TopicRuntimeQuery}).query;if(query?.join&&!joinAllowed){post({type:'request_error',id:m.id,error:'join capability unavailable',currentAcquisition:acquisitions.get(m.command.subscription??''),traceparent:m.traceparent});return;}if((query?.global||query?.having)&&!globalHavingAllowed){post({type:'request_error',id:m.id,error:'global/HAVING capability unavailable',currentAcquisition:acquisitions.get(m.command.subscription??''),traceparent:m.traceparent});return;}if((requiresTextPredicate(query?.where)||requiresTextPredicate(query?.having))&&!textAllowed){post({type:'request_error',id:m.id,error:'text predicate capability unavailable',currentAcquisition:acquisitions.get(m.command.subscription??''),traceparent:m.traceparent});return;}if(query?.group_by&&!groupedAllowed){post({type:'request_error',id:m.id,error:'grouped capability unavailable',currentAcquisition:acquisitions.get(m.command.subscription??''),traceparent:m.traceparent});return;}
 if(catalog&&(m.command as {query?:TopicRuntimeQuery}).query?.semantic_profile&&!effectSemanticsAllowed){post({type:'request_error',id:m.id,error:'Effect semantic profile capability unavailable',currentAcquisition:acquisitions.get(m.command.subscription??''),traceparent:m.traceparent});return;}
 const timer=setTimeout(()=>fatal('remote request timeout; completion uncertain',true,'request-timeout'),10000);pending.set(m.id,{request:m,timer});
 const forwarding=telemetry?.start('worker_command',m.traceContext);
 let outgoing:unknown;
 try{if(catalog){outgoing=envelope({type:'command',...(traceAllowed&&forwarding?.context?{trace_context:forwarding.context}:{}),request:{id:m.id,acquisition:m.acquisition??0,previous_acquisition:m.previousAcquisition??null,traceparent:m.traceparent,command:structuredClone(m.command)}});}else{const command=structuredClone(m.command) as Apply['command'] & {query?:{projection?:string[]}};const projection=command.query?.projection;if(command.query)delete command.query.projection;outgoing=admitEnvelope(envelope({type:'command',...(traceAllowed&&forwarding?.context?{trace_context:forwarding.context}:{}),request:{projection,id:m.id,acquisition:m.acquisition??0,previous_acquisition:m.previousAcquisition??null,traceparent:m.traceparent,command}}));}}catch(e){fatal(`remote admission failed: ${String(e)}`,false,"admission");return;}
 try{send(outgoing);forwarding?.end('ok');}catch(e){forwarding?.end('error');fatal(`remote send failed; completion uncertain: ${String(e)}`,true,"send");}
};
