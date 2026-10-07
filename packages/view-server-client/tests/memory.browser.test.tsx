import {act,StrictMode} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {beforeAll,describe,it,expect,vi} from 'vite-plus/test';
import {createTestViewServer} from '@bruno/view-server-client/testing';
import {createTopicHooks,BrowserProductProvider,type ProductResult} from '@bruno/view-server-client/react';
import {catalog} from '@bruno/view-server-client/generated/demo-catalog';
import {sources} from '@bruno/view-server-client/generated/source-metadata';
import {catalog as generatedCatalog} from '@bruno/view-server-client/generated/topics';
import {uint64,int64,decimal,defineJoin} from '@bruno/view-server-client/schema';

declare const __RVS_TEST_WASM_URL__:string|undefined;
let module:WebAssembly.Module;
beforeAll(async()=>{
  const response=await fetch(__RVS_TEST_WASM_URL__??new URL('../dist/generic_engine.wasm',import.meta.url));
  expect(response.ok).toBe(true);module=await WebAssembly.compile(await response.arrayBuffer());
});
const hooks=createTopicHooks(catalog);
const input=(customer:string,n=1,note?:string|null)=>({key:{id:'same'},value:{orderId:'same',customer,open:true,units:uint64(BigInt(n)),price:decimal('0.1'),...(note===undefined?{}:{note})}});
const query={select:['customer','units','note'],orderBy:[{field:'units',direction:'asc'}]} as const;
function Grid(){const result=hooks.useLiveQuery('client_orders',query);return <output data-status={result.status}>{result.rows.map(row=>`${row.rowId}:${row.customer}:${row.units}:${Object.hasOwn(row,'note')?row.note:'missing'}`).join('|')}</output>;}
function mount(node:React.ReactNode){const container=document.createElement('div');document.body.append(container);const root=createRoot(container);act(()=>root.render(node));return{container,root};}
function unmount(value:{root:Root;container:HTMLElement}){act(()=>value.root.unmount());value.container.remove();}

describe('production Provider with isolated generic WASM',()=>{
 it('publishes before mount, isolates identical topic/key names, updates and deletes without transport',async()=>{
  const socket=vi.spyOn(globalThis,'WebSocket');const http=vi.spyOn(globalThis,'fetch');
  const left=await createTestViewServer({catalog,sources,module});
  const right=await createTestViewServer({catalog,sources,module});
  let l:ReturnType<typeof mount>|undefined,r:ReturnType<typeof mount>|undefined;
  try{
   await left.publish('client_orders',input('left',1,null)).delivered;
   await right.publish('client_orders',input('right',2)).delivered;
   l=mount(<StrictMode><left.Provider><Grid/></left.Provider></StrictMode>);
   r=mount(<right.Provider><Grid/></right.Provider>);
   await vi.waitFor(()=>{expect(l!.container.textContent).toContain(':left:1:null');expect(r!.container.textContent).toContain(':right:2:missing');});
   await act(async()=>{await left.publish('client_orders',input('changed',0,'')).delivered;});
   await vi.waitFor(()=>expect(l!.container.textContent).toContain(':changed:0:'));
   expect(r.container.textContent).toContain(':right:2:missing');
   await act(async()=>{await left.delete('client_orders',{id:'same'}).delivered;});
   await vi.waitFor(()=>expect(l!.container.textContent).toBe(''));
   expect(r.container.textContent).toContain('right');
   expect(socket).not.toHaveBeenCalled();expect(http).not.toHaveBeenCalled();
  }finally{if(l)unmount(l);if(r)unmount(r);await left.dispose();await right.dispose();socket.mockRestore();http.mockRestore();}
  expect(left.provider.admission.subscriptions).toBe(0);expect(right.provider.admission.outstanding).toBe(0);
 });
 it('executes profile filtering, grouped exact aggregates, and rejected replacement rollback',async()=>{
  const fixture=await createTestViewServer({catalog,sources,module});
  const fp=catalog.client_orders.fingerprint;let latest:unknown;const errors:Error[]=[];
  const base={topic:'client_orders',schema:fp,semantic_profile:'effect-4.2.8' as const,select:['customer'],where:{op:'text',field:'customer',match_kind:'contains',value:'ecole'},order_by:[],offset:0,limit:100};
  const release=fixture.provider.watch('same',base,Object.assign((value:ProductResult)=>{latest=value;},{onError:(error:Error)=>errors.push(error)}));
  try{
   await fixture.publish('client_orders',input('ÉCOLE',3)).delivered;
   await fixture.flush();await vi.waitFor(()=>expect(latest).toMatchObject({total_rows:1,rows:[{customer:'ÉCOLE'}]}));
   await expect(fixture.provider.apply({command:'change_query',subscription:'same',query:{...base,select:['absent']}})).rejects.toThrow();
   await fixture.publish('client_orders',input('école next',4)).delivered;
   await vi.waitFor(()=>expect(latest).toMatchObject({rows:[{customer:'école next'}]}));
   const grouped=await fixture.provider.open('group',{topic:'client_orders',schema:fp,semantic_profile:'effect-4.2.8',global:true,aggregates:{total:{aggFunc:'sum',field:'units'},average:{aggFunc:'avg',field:'units'}},order_by:[],offset:0,limit:100});
   expect(grouped.rows).toEqual([{total:'4',average:'4'}]);
   await fixture.provider.apply({command:'close',subscription:'group'});
   expect(errors).toEqual([]);
  }finally{release();await fixture.dispose();}
 });
 it('rejects source-owned identity forgery and invalid exact values without changing rows',async()=>{
  const fixture=await createTestViewServer({catalog,sources,module});
  try{
   await fixture.publish('client_orders',input('original')).applied;
   await expect(fixture.provider.apply({command:'publish',topic:'client_orders',key:{id:'same'},value:{...input('forged').value,rowId:'forged'}})).rejects.toThrow('rowId');
   await expect(fixture.provider.apply({command:'publish',topic:'client_orders',key:{id:'same'},value:{...input('bad').value,units:'-1'}})).rejects.toThrow();
   const result=await fixture.provider.open('q',{topic:'client_orders',schema:catalog.client_orders.fingerprint,select:['customer'],order_by:[],offset:0,limit:10});expect(result.rows).toEqual([{customer:'original'}]);
  }finally{await fixture.dispose();}
 });
 it('uses independently controlled clocks and shared native retention admission, refresh and silent expiry',async()=>{
  const config={catalog,sources,module,clock:{nowMs:1000},retention:{client_orders:{maxRetentionMinutes:0.00002}}};
  const left=await createTestViewServer(config),right=await createTestViewServer(config);
  const q={topic:'client_orders',schema:catalog.client_orders.fingerprint,select:['customer'],order_by:[],offset:0,limit:100};
  let latest:ProductResult|undefined;const release=left.provider.watch('expiry',q,value=>{latest=value;});
  try {
   await left.publish('client_orders',input('left')).delivered;await right.publish('client_orders',input('right')).delivered;
   await left.advanceTime(0).delivered;expect(latest?.total_rows).toBe(1);
   await left.advanceTime(2).delivered;expect(latest?.total_rows).toBe(0);
   expect((await right.provider.open('right',q)).total_rows).toBe(1);
   await right.advanceTime(1).delivered;
   await right.publish('client_orders',input('refreshed')).delivered;
   await right.advanceTime(1).delivered;expect((await right.provider.open('right',q)).total_rows).toBe(1);
   await right.advanceTime(1).delivered;expect((await right.provider.open('right',q)).total_rows).toBe(0);
   expect(()=>left.advanceTime(-1)).toThrow();
  }finally{release();await left.dispose();await right.dispose();}
  await expect(createTestViewServer({catalog,sources,module,retention:{client_orders:{maxRetentionMessages:2}}})).rejects.toThrow('requires source');
 });
 it('propagates left join changes, preserves row identities and delivers grouped HAVING retractions',async()=>{
  const fixture=await createTestViewServer({catalog,sources,module});
  const join=defineJoin(catalog,{left:{topic:'client_orders',as:'l'},right:{topic:'server_orders',as:'r'},kind:'left',cardinality:'many_to_one',on:{left:'customer',right:'customer'},limits:{maxLeftRowsPerKey:10,maxOutputRows:100}});
  const q={topic:join.topic,schema:join.fingerprint,join:join.wire,select:['l.units','r.units'],order_by:[],offset:0,limit:10};
  let latest:ProductResult|undefined;const release=fixture.provider.watch('joined',q,result=>{latest=result;});
  try {
   await fixture.publish('client_orders',input('matching',2)).delivered;expect(latest?.rows).toEqual([{l:{units:'2'},r:null}]);const keys=latest?.keys;
   await fixture.publish('server_orders',input('matching',3)).delivered;expect(latest?.rows).toEqual([{l:{units:'2'},r:{units:'3'}}]);expect(latest?.keys).toEqual(keys);
   const grouped={topic:'client_orders',schema:catalog.client_orders.fingerprint,group_by:['customer'],aggregates:{total:{aggFunc:'sum' as const,field:'units'}},having:{op:'gt',field:'total',value:'1'},order_by:[],offset:0,limit:10};
   expect((await fixture.provider.open('having',grouped)).rows).toEqual([{customer:'matching',total:'2'}]);
   await fixture.publish('client_orders',input('matching',0)).delivered;expect((await fixture.provider.open('having',grouped)).rows).toEqual([]);
   await fixture.delete('server_orders',{id:'same'}).delivered;expect(latest?.rows).toEqual([{l:{units:'0'},r:null}]);expect(latest?.keys).toEqual(keys);
  }finally{release();await fixture.dispose();}
 });
 it('isolates observer exceptions, releases shared queries and ignores late deliveries after disposal',async()=>{
  const fixture=await createTestViewServer({catalog,sources,module});
  const q={topic:'client_orders',schema:catalog.client_orders.fingerprint,select:['customer'],order_by:[],offset:0,limit:10};
  let calls=0;
  const bad=fixture.provider.watch('throws',q,()=>{throw Error('observer failure');});
  const good=fixture.provider.watch('healthy',q,()=>{calls++;});
  try {
   await fixture.publish('client_orders',input('works')).delivered;expect(calls).toBeGreaterThan(0);
   bad();await fixture.publish('client_orders',input('still works')).delivered;
   good();await fixture.flush();expect(fixture.provider.admission.subscriptions).toBe(0);
   const before=calls;const receipt=fixture.publish('client_orders',input('in flight'));const settled=Promise.allSettled([receipt.applied,receipt.delivered]);await fixture.dispose();await settled;expect(calls).toBe(before);expect(fixture.provider.admission.outstanding).toBe(0);
   expect(()=>fixture.publish('client_orders',input('late'))).toThrow('disposed');
   expect(()=>fixture.provider.watchComplete('client_orders',catalog.client_orders.schema,catalog.client_orders.fingerprint,()=>{})).toThrow();
  }finally{bad();good();await fixture.dispose();}
 });
 it('settles pending initialization cancellation and rejects use after terminal disposal',async()=>{
  const controller=new AbortController();
  const initialization=createTestViewServer({catalog,sources,module,signal:controller.signal});controller.abort(Error('cancel initialization'));
  await expect(initialization).rejects.toThrow();
  const provider=new BrowserProductProvider({mode:'memory',catalog,sources,module});const ready=provider.ready;provider.dispose();await expect(ready).rejects.toThrow();
  expect(provider.admission.outstanding).toBe(0);expect(provider.admission.subscriptions).toBe(0);
 });

 it('reorders mounted React results after typed source mutations and cleans up unmounted consumers',async()=>{
  const fixture=await createTestViewServer({catalog,sources,module});let mounted:ReturnType<typeof mount>|undefined;
  const put=(id:string,n:number)=>fixture.publish('client_orders',{key:{id},value:{...input(id,n).value,orderId:id}}).delivered;
  try {
   await put('a',1);await put('b',2);mounted=mount(<fixture.Provider><Grid/></fixture.Provider>);
   await vi.waitFor(()=>expect(mounted!.container.textContent!.indexOf(':a:1:')).toBeLessThan(mounted!.container.textContent!.indexOf(':b:2:')));
   await act(async()=>{await put('a',3);});
   await vi.waitFor(()=>expect(mounted!.container.textContent!.indexOf(':b:2:')).toBeLessThan(mounted!.container.textContent!.indexOf(':a:3:')));
   unmount(mounted);mounted=undefined;await fixture.flush();expect(fixture.provider.admission.subscriptions).toBe(0);
  }finally{if(mounted)unmount(mounted);await fixture.dispose();}
 });
 it('enforces delete-source whole-topic count retention atomically at the retained-row quota',async()=>{
  const fixture=await createTestViewServer({catalog:{orders:generatedCatalog.orders},sources,module,maxRows:2,clock:{nowMs:0},retention:{orders:{maxRetentionMessages:2}}});
  const key={tenant:'tenant',desk:'desk',account:uint64(1n),partitionKey:int64(0n)};
  const put=(id:string)=>fixture.publish('orders',{key,value:{...input(id).value,orderId:id}}).delivered;
  const q={topic:'orders',schema:generatedCatalog.orders.fingerprint,select:['orderId'],order_by:[{field:'orderId',direction:'asc' as const}],offset:0,limit:10};
  try {
   await put('a');await put('b');await put('a');await put('c');
   expect((await fixture.provider.open('retained',q)).rows).toEqual([{orderId:'a'},{orderId:'c'}]);
   await expect(fixture.delete('orders',key).applied).rejects.toThrow('value-derived');
   expect((await fixture.provider.open('retained',q)).rows).toEqual([{orderId:'a'},{orderId:'c'}]);
  }finally{await fixture.dispose();}
 });

 it('matches native generated-source raw and grouped cuts for the shared controlled-time corpus',async()=>{
  const response=await fetch(new URL('../../../fixtures/native-wasm-parity.json',import.meta.url));expect(response.ok).toBe(true);
  const corpus=await response.json();const fixture=await createTestViewServer({catalog,sources,module,clock:{nowMs:0},retention:{client_orders:{maxRetentionMinutes:0.00002}}});
  const latest:Record<string,ProductResult>={};const release=Object.entries<Record<string,unknown>>(corpus.queries).map(([name,query])=>fixture.provider.watch(name,{topic:'client_orders',schema:catalog.client_orders.fingerprint,order_by:[],...query,offset:0,limit:32},value=>{latest[name]=value;}));
  try{await fixture.flush();for(const step of corpus.actions){await fixture.provider.apply(step.command);for(const name of ['raw','groups'])expect(latest[name].rows).toEqual(step[name]);}}
  finally{release.forEach(stop=>stop());await fixture.dispose();}
 });

 it('fails bounded initialization for an unavailable static WASM asset and explicitly retries a valid asset',async()=>{
  const missing=new URL('./fixtures/unavailable-generic-engine.wasm',import.meta.url);
  const response=await fetch(missing);expect(response.status).toBe(404);
  const worker=vi.spyOn(globalThis,'Worker');let fixture:Awaited<ReturnType<typeof createTestViewServer<typeof catalog,typeof sources>>>|undefined;
  try {
   await expect(createTestViewServer({catalog,sources,wasmUrl:missing,timeoutMs:1000})).rejects.toThrow('generic WASM unavailable (404)');
   expect(worker).not.toHaveBeenCalled();
   fixture=await createTestViewServer({catalog,sources,wasmUrl:new URL('../dist/generic_engine.wasm',import.meta.url)});
   await fixture.publish('client_orders',input('asset retry')).delivered;
   const result=await fixture.provider.open('retry',{topic:'client_orders',schema:catalog.client_orders.fingerprint,select:['customer'],order_by:[],offset:0,limit:10});
   expect(result.rows).toEqual([{customer:'asset retry'}]);expect(worker).toHaveBeenCalledTimes(1);
  }finally{await fixture?.dispose();worker.mockRestore();}
 });

 it('owns real-clock maintenance and cancels it immediately when the exposed Provider is disposed',async()=>{
  const fixture=await createTestViewServer({catalog,sources,module,retention:{client_orders:{maxRetentionMinutes:0.00002}}});
  let latest:ProductResult|undefined;const release=fixture.provider.watch('real-clock',{topic:'client_orders',schema:catalog.client_orders.fingerprint,select:['customer'],order_by:[],offset:0,limit:10},value=>{latest=value;});
  try {
   await fixture.publish('client_orders',input('expires')).delivered;expect(latest?.total_rows).toBe(1);
   expect(fixture.diagnostics.maintenanceScheduled).toBe(true);
   await vi.waitFor(()=>expect(latest?.total_rows).toBe(0));
   fixture.provider.dispose();expect(fixture.diagnostics.maintenanceScheduled).toBe(false);expect(fixture.diagnostics.disposed).toBe(true);
   await fixture.dispose();expect(fixture.diagnostics.pending).toBe(0);
  }finally{release();await fixture.dispose();}
 });

});
