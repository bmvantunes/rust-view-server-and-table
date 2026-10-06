import {createElement as h, useEffect, StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {afterEach, expect, it, vi} from 'vite-plus/test';
import {BrowserProductProvider, ProductProvider, useLiveQuery, useLiveQueryViewport, toProductQuery, type ProductResult, type ProductViewportGeneration} from './product-provider';

type Envelope = {type:string; id?:number; command?:{command?:string}; results?:Record<string,ProductResult>; [key:string]:unknown};
const RealWorker=Worker;
const workers: GateWorker[]=[];
class GateWorker {
  native:Worker; onmessage:((e:MessageEvent)=>void)|null=null; onerror:((e:ErrorEvent)=>void)|null=null; onmessageerror:((e:MessageEvent)=>void)|null=null;
  held:Envelope[]=[]; incoming:Envelope[]=[]; blocked=false; terminated=false;
  constructor(url:URL,options:WorkerOptions){this.native=new RealWorker(url,options);workers.push(this);this.native.onmessage=e=>{this.incoming.push(e.data);if(this.blocked)this.held.push(e.data);else this.deliver(e.data);};this.native.onerror=e=>this.onerror?.(e);this.native.onmessageerror=e=>this.onmessageerror?.(e);}
  postMessage(m:Envelope){this.native.postMessage(m);}
  terminate(){this.terminated=true;this.native.terminate();}
  deliver(m:Envelope){flushSync(()=>this.onmessage?.(new MessageEvent('message',{data:m})));}
  flush(){this.blocked=false;while(this.held.length)this.deliver(this.held.shift()!);}
}
const cleanup:Array<()=>void>=[];
afterEach(()=>{cleanup.splice(0).reverse().forEach(f=>f());vi.unstubAllGlobals();});
const raw=(cat='c0')=>({select:['id','category'] as const,where:[{field:'category',type:'equals',filter:cat}] as const,orderBy:[] as const});
const q=(cat='c0')=>toProductQuery(raw(cat),0,20);
const put=(id:string,category='c0')=>({command:'upsert',row:{id,category,quantity:'1',amount:{coefficient:'0',scale:0}}});
const barrier=(p:BrowserProductProvider)=>p.apply({command:'delete',id:'__v51_missing_barrier__'});
const ids=(r:ProductResult)=>r.rows.map(x=>x.id);
const pending=(p:BrowserProductProvider)=>(p as unknown as {pending:Map<number,unknown>}).pending.size;
async function make(){vi.stubGlobal('Worker',GateWorker);const p=new BrowserProductProvider();cleanup.push(()=>p.dispose());await p.ready;await p.apply(put('p0'));await p.apply(put('p1','c1'));return {p,w:workers.at(-1)!};}
function mount(p:BrowserProductProvider,App:()=>ReturnType<typeof h>){const el=document.createElement('div');document.body.append(el);const root=createRoot(el);flushSync(()=>root.render(h(StrictMode,null,h(ProductProvider,{provider:p},h(App)))));cleanup.push(()=>{flushSync(()=>root.unmount());el.remove();});return el;}

for(const rejection of ['offset','direction'] as const) for(const updates of [1,2]) it(`V5.1 H1 FIFO ${rejection} rejection restores ${updates} committed updates without a mutating recovery barrier`,async()=>{
  const {p,w}=await make();const seen:ProductResult[]=[];const errors:string[]=[];
  const stop=p.watch('kept',q(),Object.assign((r:ProductResult)=>seen.push(r),{onError:(e:Error)=>errors.push(e.message)}));await barrier(p);expect(ids(seen[0])).toEqual(['p0']);
  w.blocked=true;const one=p.apply(put('p2'));await expect.poll(()=>w.held.length).toBe(1);
  const two=updates===2?p.apply(put('p3')):Promise.resolve({});await expect.poll(()=>w.held.length).toBe(updates);
  const expected=w.held[updates-1].results!.kept;
  const invalid=p.apply({command:'change_query',subscription:'kept',query:{...q(),...(rejection==='offset'?{offset:-1}:{direction:'invalid'})}}).catch(e=>e);
  await expect.poll(()=>w.held.length).toBe(updates+1);w.flush();await Promise.all([one,two]);expect(await invalid).toBeInstanceOf(Error);
  const ackCount=w.incoming.length;expect(await barrier(p)).toEqual({});expect(w.incoming.length).toBe(ackCount+1);
  expect(seen.map(r=>({ids:ids(r),total:r.total_rows,version:r.version}))).toEqual([{ids:['p0'],total:1,version:seen[0].version},{ids:updates===2?['p0','p2','p3']:['p0','p2'],total:updates+1,version:expected.version}]);
  expect(errors).toEqual([]);expect(pending(p)).toBe(0);stop();await barrier(p);expect(p.lastWorkerStats?.active_subscriptions).toBe(0);
});

for(const action of ['release','dispose'] as const) it(`V5.1 H2 baseline row-count ${action} stops old sink calls and ready publication`,async()=>{
  const {p,w}=await make();let generation:ProductViewportGeneration;let armed=false;const calls:string[]=[];const states:Array<{status:string;version:number}>=[];
  function App(){const v=useLiveQueryViewport('products');states.push({status:v.status,version:v.version});useEffect(()=>{generation=v.viewport.replace({query:raw(),window:{firstRow:0,lastRow:9},sink:{setRowCount(){calls.push('count');if(armed){armed=false;if(action==='release')generation.release();else p.dispose();calls.push('invalidated');}},setRowData(){calls.push('data');}}});return generation.release;},[v.viewport]);return h('output',null,v.status);}
  const el=mount(p,App);await expect.poll(()=>el.textContent).toBe('ready');calls.length=0;states.length=0;armed=true;
  const result=await p.apply(put('p2'));expect(result).toHaveProperty(Object.keys(result)[0]);
  expect(calls).toEqual(['count','invalidated']);expect(states.some(s=>s.status==='ready')).toBe(false);
  if(action==='dispose'){expect(el.textContent).toBe('closed');expect(w.terminated).toBe(true);}else{await barrier(p);expect(p.lastWorkerStats?.active_subscriptions).toBe(0);}
  expect(pending(p)).toBe(0);
});

it('V5.1 H3 baseline direct close pre-send failure retains still-live delivery',async()=>{
  const {p,w}=await make();const seen:ProductResult[]=[];const stop=p.watch('kept',q(),r=>seen.push(r));await barrier(p);
  const original=w.postMessage.bind(w);w.postMessage=m=>original({...m,uncloneable:()=>0});
  await expect(p.apply({command:'close',subscription:'kept'})).rejects.toThrow();expect(pending(p)).toBe(0);w.postMessage=original;
  const result=await p.apply(put('p2'));expect(p.lastWorkerStats?.active_subscriptions).toBe(1);expect(seen.map(ids)).toEqual([['p0'],['p0','p2']]);expect(seen.at(-1)?.version).toBe(result.kept.version);
  stop();await barrier(p);expect(p.lastWorkerStats?.active_subscriptions).toBe(0);
});

it('V5.1 H1 later authoritative acquisition ignores earlier rejection and never replays predecessor',async()=>{
  const {p,w}=await make();const seen:ProductResult[]=[];const stop=p.watch('kept',q(),r=>seen.push(r));await barrier(p);
  w.blocked=true;const mutation=p.apply(put('p2'));await expect.poll(()=>w.held.length).toBe(1);
  const first=p.apply({command:'change_query',subscription:'kept',query:{...q(),offset:-1}}).catch(e=>e);
  const second=p.apply({command:'change_query',subscription:'kept',query:q('c1')});
  const third=p.apply({command:'change_query',subscription:'kept',query:{...q(),direction:'bad'}}).catch(e=>e);
  await expect.poll(()=>w.held.length).toBe(4);
  const [oldAck,oldError,newAck,newError]=w.held.splice(0);
  // Deliberate delayed older response: later native success is authoritative first.
  w.deliver(newAck);w.deliver(newError);w.deliver(oldError);w.deliver(oldAck);w.flush();
  await mutation;expect(await first).toBeInstanceOf(Error);await second;expect(await third).toBeInstanceOf(Error);expect(await barrier(p)).toEqual({});
  expect(seen.map(ids)).toEqual([['p0'],['p1']]);expect(seen.at(-1)?.version).toBe(newAck.results!.kept.version);
  expect((p as unknown as {completed:Map<string,unknown>}).completed.size).toBe(1);
  stop();await barrier(p);expect(p.lastWorkerStats?.active_subscriptions).toBe(0);expect((p as unknown as {completed:Map<string,unknown>}).completed.size).toBe(0);
});
for(const cancel of ['release','dispose'] as const) for(const timing of ['before-rejection','during-rollback'] as const) it(`V5.1 H1 ${cancel} ${timing} cannot resurrect rollback delivery`,async()=>{
  const {p,w}=await make();const seen:ProductResult[]=[];let armed=false;let stop:()=>void;
  stop=p.watch('kept',q(),r=>{seen.push(r);if(armed){armed=false;if(cancel==='release')stop();else p.dispose();}});await barrier(p);
  w.blocked=true;const update=p.apply(put('p2')).catch(e=>e);await expect.poll(()=>w.held.length).toBe(1);
  const rejected=p.apply({command:'change_query',subscription:'kept',query:{...q(),offset:-1}}).catch(e=>e);await expect.poll(()=>w.held.length).toBe(2);
  if(timing==='during-rollback')armed=true;else if(cancel==='release')stop();else p.dispose();
  w.flush();await update;expect(await rejected).toBeInstanceOf(Error);
  expect(seen.map(ids)).toEqual(timing==='during-rollback'?[['p0'],['p0','p2']]:[['p0']]);
  if(cancel==='release'){await barrier(p);await expect.poll(()=>p.lastWorkerStats?.active_subscriptions).toBe(0);}else expect(w.terminated).toBe(true);
  expect(pending(p)).toBe(0);expect((p as unknown as {completed:Map<string,unknown>}).completed.size).toBe(0);
});

for(const callback of ['count','data'] as const) for(const action of ['release','replace','dispose'] as const) for(const throws of [false,true]) it(`V5.1 H2 ${callback} ${action}${throws?' then throws':''} revalidates every effect with a healthy mounted peer`,async()=>{
  const {p,w}=await make();let generation:ProductViewportGeneration;let controller:ReturnType<typeof useLiveQueryViewport>['viewport'];let armed=false;
  const calls:string[]=[];const states:Array<{status:string;version:number;peer:string;message?:string}>=[];let reporterCalls=0;
  p.onConsumerError=()=>{reporterCalls++;throw Error('reporter throws once');};
  const replacementSink={setRowCount(){calls.push('new:count');},setRowData(){calls.push('new:data');}};
  function trigger(){if(!armed)return;armed=false;if(action==='release')generation.release();else if(action==='dispose')p.dispose();else generation=controller.replace({query:raw('c1'),window:{firstRow:0,lastRow:9},sink:replacementSink});calls.push('invalidated');if(throws)throw Error('old invocation failed');}
  function App(){const v=useLiveQueryViewport('products');const peer=useLiveQuery('products',raw());controller=v.viewport;states.push({status:v.status,version:v.version,peer:peer.status,message:v.message});
    useEffect(()=>{generation=v.viewport.replace({query:raw(),window:{firstRow:0,lastRow:9},sink:{setRowCount(){calls.push('old:count');if(callback==='count')trigger();},setRowData(){calls.push('old:data');if(callback==='data')trigger();}}});return generation.release;},[v.viewport]);
    return h('output',null,v.status+':'+peer.status);}
  const el=mount(p,App);await expect.poll(()=>el.textContent).toBe('ready:ready');await barrier(p);calls.length=0;states.length=0;armed=true;
  let settlements=0;const result=await p.apply(put('p2')).then(r=>{settlements++;return r;});expect(settlements).toBe(1);
  const oldVersion=Object.values(result).find(r=>r.subscription.startsWith('viewport:'))!.version;
  const expectedPrefix=callback==='count'?['old:count','invalidated']:['old:count','old:data','invalidated'];
  expect(calls.slice(0,expectedPrefix.length)).toEqual(expectedPrefix);
  expect(calls.slice(expectedPrefix.length).every(c=>c.startsWith('new:'))).toBe(true);
  expect(states.some(s=>s.status==='ready'&&s.version===oldVersion)).toBe(false);
  if(action==='dispose'){expect(el.textContent).toBe('closed:closed');expect(w.terminated).toBe(true);expect(states.every(s=>s.status==='closed'&&s.peer==='closed')).toBe(true);await expect(barrier(p)).rejects.toThrow('disposed');}
  else {await barrier(p);if(action==='replace'){await expect.poll(()=>el.textContent).toBe('ready:ready');expect(calls).toEqual([...expectedPrefix,'new:count','new:data']);expect(states.filter(s=>s.status==='error')).toEqual([]);expect(p.lastWorkerStats?.active_subscriptions).toBe(2);}else expect(p.lastWorkerStats?.active_subscriptions).toBe(1);}
  if(throws){expect(p.consumerErrors.some(e=>e.error.message==='old invocation failed')).toBe(true);expect(p.consumerErrors.some(e=>e.error.message==='reporter throws once')).toBe(true);expect(reporterCalls).toBeLessThanOrEqual(4);}
  expect(pending(p)).toBe(0);
});

it('V5.1 H2 terminal notification with reentrant throwing peers cannot revive or strand mounted consumers',async()=>{
  const {p,w}=await make();const seen:string[]=[];let reporterCalls=0;let victimErrors=0;let stopVictim=()=>{};
  p.watch('throwing-peer',q(),Object.assign((_r:ProductResult)=>{},{onError:()=>{stopVictim();p.dispose();throw Error('peer terminal callback failed');}}));
  stopVictim=p.watch('cancelled-peer',q(),Object.assign((_r:ProductResult)=>{},{onError:()=>{victimErrors++;}}));
  function App(){const r=useLiveQuery('products',raw());seen.push(r.status);return h('output',null,r.status);}
  const el=mount(p,App);await expect.poll(()=>el.textContent).toBe('ready');await barrier(p);seen.length=0;
  p.onConsumerError=()=>{reporterCalls++;p.dispose();throw Error('terminal reporter failed');};
  w.blocked=true;let settlements=0;const operation=p.apply(put('p2')).then(()=>{settlements++;return 'success';},()=>{settlements++;return 'rejected';});await expect.poll(()=>w.held.length).toBe(1);
  flushSync(()=>w.onmessageerror?.(new MessageEvent('messageerror')));
  expect(await operation).toBe('rejected');expect(settlements).toBe(1);expect(el.textContent).toBe('error');expect(victimErrors).toBe(0);
  w.flush();expect(seen.every(s=>s==='error')).toBe(true);expect(pending(p)).toBe(0);expect(reporterCalls).toBeLessThanOrEqual(5);
  expect(p.consumerErrors.some(e=>e.error.message==='peer terminal callback failed')).toBe(true);expect(p.consumerErrors.some(e=>e.error.message==='terminal reporter failed')).toBe(true);
});

for(const race of ['replacement','release','dispose'] as const) it(`V5.1 H3 direct close transport failure racing ${race} never restores an obsolete lifetime`,async()=>{
  const {p,w}=await make();const seen:ProductResult[]=[];const stop=p.watch('kept',q(),r=>seen.push(r));await barrier(p);
  const original=w.postMessage.bind(w);let next:Promise<unknown>|undefined;let injected=false;
  w.postMessage=m=>{if(m.command?.command==='close'&&!injected){injected=true;if(race==='replacement')next=p.apply({command:'change_query',subscription:'kept',query:q('c1')});else if(race==='release')stop();else p.dispose();original({...m,uncloneable:()=>0});}else original(m);};
  let settlements=0;const error=await p.apply({command:'close',subscription:'kept'}).then(()=>{settlements++;return undefined;},e=>{settlements++;return e;});expect(error).toBeInstanceOf(Error);expect(settlements).toBe(1);w.postMessage=original;
  if(next)await next;
  if(race==='dispose'){expect(w.terminated).toBe(true);await expect(barrier(p)).rejects.toThrow('disposed');}
  else {await p.apply(put('p2',race==='replacement'?'c1':'c0'));await barrier(p);expect(seen.map(ids)).toEqual(race==='replacement'?[['p0'],['p1'],['p1','p2']]:[['p0']]);expect(p.lastWorkerStats?.active_subscriptions).toBe(race==='replacement'?1:0);}
  expect(pending(p)).toBe(0);stop();
});

it('V5.1 H3 release cleanup transport failure terminates boundedly without resurrecting cancelled delivery',async()=>{
  const {p,w}=await make();const seen:ProductResult[]=[];const stop=p.watch('kept',q(),r=>seen.push(r));await barrier(p);
  function App(){const r=useLiveQuery('products',raw());return h('output',null,r.status+':'+r.message);}
  const el=mount(p,App);await expect.poll(()=>el.textContent).toBe('ready:undefined');await barrier(p);expect(p.lastWorkerStats?.active_subscriptions).toBe(2);
  const original=w.postMessage.bind(w);w.postMessage=m=>m.command?.command==='close'?original({...m,uncloneable:()=>0}):original(m);
  stop();await expect.poll(()=>el.textContent).toContain('error:release cleanup failed; provider terminated');
  expect(w.terminated).toBe(true);expect(seen.map(ids)).toEqual([['p0']]);expect(pending(p)).toBe(0);
  expect((p as unknown as {listeners:Map<string,unknown>}).listeners.size).toBe(0);
  await expect(p.apply(put('p2'))).rejects.toThrow('release cleanup failed');stop();
  // Last native stats are historical: termination destroys the Worker/WASM instance;
  // there can be no post-termination native statistics ACK, and none is invented.
  expect(p.lastWorkerStats?.active_subscriptions).toBe(2);
});

it('V5.1 H2 callback changes low-level acquisition without changing viewport generation',async()=>{
  const {p,w}=await make();let armed=false;let replacement:Promise<unknown>|undefined;const calls:string[]=[];const states:Array<{status:string;version:number}>=[];
  function App(){const v=useLiveQueryViewport('products');states.push({status:v.status,version:v.version});useEffect(()=>{const g=v.viewport.replace({query:raw(),window:{firstRow:0,lastRow:9},sink:{setRowCount(){calls.push('count');if(armed){armed=false;const subscription=Object.keys(w.incoming.at(-1)!.results!).find(id=>id.startsWith('viewport:'))!;replacement=p.apply({command:'change_query',subscription,query:q('c1')});calls.push('changed-acquisition');}},setRowData(rows){calls.push('data:'+Object.values(rows).map(r=>r.id).join(','));}}});return g.release;},[v.viewport]);return h('output',null,v.status);}
  const el=mount(p,App);await expect.poll(()=>el.textContent).toBe('ready');calls.length=0;states.length=0;armed=true;
  const result=await p.apply(put('p2'));const oldVersion=Object.values(result)[0].version;
  await replacement;await barrier(p);expect(calls).toEqual(['count','changed-acquisition','count','data:p1']);expect(states.some(s=>s.status==='ready'&&s.version===oldVersion)).toBe(false);
});

it('V5.1 H3 a failed single predecessor-cleanup retry becomes terminal without another retry',async()=>{
  const {p,w}=await make();const seen:ProductResult[]=[];const stop=p.watch('kept',q(),r=>seen.push(r));await barrier(p);
  w.blocked=true;const rejected=p.apply({command:'change_query',subscription:'kept',query:{...q(),offset:-1}}).catch(e=>e);await expect.poll(()=>w.held.length).toBe(1);
  let closes=0;const original=w.postMessage.bind(w);w.postMessage=m=>{if(m.command?.command==='close'&&++closes===2)original({...m,uncloneable:()=>0});else original(m);};
  stop();await expect.poll(()=>w.held.length).toBe(2);w.flush();expect(await rejected).toBeInstanceOf(Error);await expect.poll(()=>w.terminated).toBe(true);
  expect(closes).toBe(2);expect(seen.map(ids)).toEqual([['p0']]);expect(pending(p)).toBe(0);await expect(barrier(p)).rejects.toThrow('release cleanup failed');
});

it('V5.1 H2 reentrant error reporter replaces the viewport before old error delivery',async()=>{
  const {p}=await make();let armed=false;let controller:ReturnType<typeof useLiveQueryViewport>['viewport'];const states:string[]=[];let reports=0;
  function App(){const v=useLiveQueryViewport('products');controller=v.viewport;states.push(v.status+':'+(v.message??''));useEffect(()=>{const g=v.viewport.replace({query:raw(),window:{firstRow:0,lastRow:9},sink:{setRowCount(){if(armed){armed=false;throw Error('old sink failed');}},setRowData(){}}});return g.release;},[v.viewport]);return h('output',null,v.status);}
  const el=mount(p,App);await expect.poll(()=>el.textContent).toBe('ready');states.length=0;
  p.onConsumerError=()=>{reports++;controller.replace({query:raw('c1'),window:{firstRow:0,lastRow:9},sink:{setRowCount(){},setRowData(){}}});throw Error('replacement reporter failed');};
  armed=true;await p.apply(put('p2'));await barrier(p);await expect.poll(()=>el.textContent).toBe('ready');
  expect(reports).toBe(1);expect(states.filter(s=>s.startsWith('error'))).toEqual([]);expect(p.consumerErrors.map(e=>e.error.message)).toEqual(['old sink failed','replacement reporter failed']);expect(pending(p)).toBe(0);expect(p.lastWorkerStats?.active_subscriptions).toBe(1);
});
