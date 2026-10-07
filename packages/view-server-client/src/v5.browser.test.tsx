import { commands } from "vite-plus/test/browser";
import { createElement as h, useEffect, StrictMode, version as reactVersion } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { expect, it, afterEach, vi } from 'vite-plus/test';
import { BrowserProductProvider, ProductProvider, useLiveQuery, useProductLiveQuery, useLiveQueryViewport, toProductQuery, type ProductResult, type ProductQuery } from './product-provider';

type Message = { type: string; id?: number; subscription?: string; result?: ProductResult; results?: Record<string, ProductResult>; [key: string]: unknown };
const NativeWorker = Worker;
class ControlledWorker {
  native: Worker;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: ((e: MessageEvent) => void) | null = null;
  incoming: Message[] = []; outgoing: Message[] = []; held: Message[] = [];
  blocked = false;
  constructor(url: URL, options: WorkerOptions) {
    this.native = new NativeWorker(url, options); workers.push(this);
    this.native.onmessage = e => { this.incoming.push(e.data); if (this.blocked) this.held.push(e.data); else this.onmessage?.(e); };
    this.native.onerror = e => this.onerror?.(e);
    this.native.onmessageerror = e => this.onmessageerror?.(e);
  }
  postMessage(m: Message) { this.native.postMessage(m); this.outgoing.push(structuredClone(m)); }
  terminate() { this.native.terminate(); }
  inject(m: Message) { flushSync(() => this.onmessage?.(new MessageEvent('message', { data: m }))); }
  flushOne() { const m = this.held.shift(); if(m) this.inject(m); }
  flush() { this.blocked = false; while(this.held.length) this.flushOne(); }
}
const workers: ControlledWorker[] = [];
const providers: BrowserProductProvider[] = [];
const unmounts: (() => void)[] = [];
afterEach(() => { unmounts.splice(0).forEach(f => f()); providers.splice(0).forEach(p => p.dispose()); vi.unstubAllGlobals(); });
const raw = (cat?: string) => ({ select: ['id', 'category', 'quantity'] as const, where: cat === undefined ? [] : [{ field: 'category', type: 'equals', filter: cat }] as const, orderBy: [] as const });
const query = (cat?: string) => toProductQuery(raw(cat), 0, 20);
const put = (id: string, category = 'c0', coefficient = '0') => ({ command: 'upsert', row: { id, category, quantity: '9007199254740993', amount: { coefficient, scale: 0 } } });
async function make(seed = true) {
  vi.stubGlobal('Worker', ControlledWorker);
  const p = new BrowserProductProvider(); providers.push(p);
  const w = workers.at(-1)!;
  await p.ready;
  if(seed) { await p.apply(put('p0')); await p.apply(put('p1', 'c1', '1')); }
  return {p,w};
}
function mount(p: BrowserProductProvider, child: ReturnType<typeof h>, strict = false) {
  const el = document.createElement('div'); document.body.append(el); const root = createRoot(el);
  const render = (provider: BrowserProductProvider, node: ReturnType<typeof h>) => flushSync(() => root.render(strict ? h(StrictMode, null, h(ProductProvider, {provider}, node)) : h(ProductProvider, {provider}, node)));
  render(p,child); let active = true;
  const unmount = () => {if(active) { active = false; flushSync(() => root.unmount()); el.remove(); }};
  unmounts.push(unmount); return {el, render, unmount};
}
const barrier = (p: BrowserProductProvider) => p.apply({command:'delete',id:'__barrier_missing__'});
const resultMessages = (w: ControlledWorker) => w.incoming.filter(m => m.type === 'result' || (m.type === 'ack' && Object.keys(m.results ?? {}).length > 0));

it('V5.A rejects every FIFO obsolete publication and makes settled query transitions loading', async () => {
  const {p,w} = await make(); const seen: Array<{cat: string; status: string; ids: string[]}> = [];
  function App({cat}: {cat: string}) {const r = useLiveQuery('products',raw(cat)); seen.push({cat,status:r.status,ids:r.rows.map(x=>x.id)}); return h('output',null,r.status+':'+r.rows.map(x=>x.id).join(','));}
  w.blocked = true;
  const m = mount(p,h(App,{cat:'c0'}));
  await expect.poll(()=>resultMessages(w).length).toBeGreaterThan(0);
  m.render(p,h(App,{cat:'c1'}));
  await expect.poll(()=>w.outgoing.filter(x=>(x.command as {command?:string})?.command==='open').length).toBe(2);
  w.flush(); await barrier(p);
  await expect.poll(()=>m.el.textContent).toBe('ready:p1');
  expect(seen.filter(x=>x.status==='ready').every(x=>x.ids.every(id=>id===(x.cat==='c0'?'p0':'p1')))).toBe(true);
  w.blocked = true; m.render(p,h(App,{cat:'c0'}));
  expect(m.el.textContent).toBe('loading:');
  w.flush(); await barrier(p);
});
it('V5.B mounted consumers observe terminal messageerror without a pending command', async () => {
  const {p,w}=await make();
  function App(){ const r=useLiveQuery('products',raw());return h('output',null,r.status+':'+(r.message??'')); }
  const m=mount(p,h(App));await expect.poll(()=>m.el.textContent).toBe('ready:');
  flushSync(()=>w.onmessageerror?.(new MessageEvent('messageerror')));
  expect(m.el.textContent).toContain('error:ProductCore Worker message');
  w.inject({type:'ready'});
  await expect(barrier(p)).rejects.toThrow();
});
it('V5.C clone rejection leaves no pending record or orphan rejection', async () => {
  const {p}=await make(false);
  await expect(p.apply({command:'delete',id:()=>0})).rejects.toThrow();
  expect((p as unknown as {pending: Map<number,unknown>}).pending.size).toBe(0);
});
it('V5.D six-row direct open crosses the Worker boundary once', async () => {
  const {p,w}=await make(false);
  for(let i=0;i<6;i++)await p.apply(put('r'+i));
  const r=await p.open('six',query());expect(r.rows.length).toBe(6); await barrier(p);
  let rows=0;for(const m of w.incoming){ if(m.result)rows+=m.result.rows.length;for(const r of Object.values(m.results??{}))rows+=r.rows.length; }
  expect(rows).toBe(6);
});

it('V5.A rapid A B A boundaries reject obsolete errors, callbacks and cleanup', async () => {
  const {p,w}=await make();const seen: string[]=[];
  function App({cat}:{cat:string}){const r=useLiveQuery('products',raw(cat));seen.push(cat+':'+r.status+':'+r.rows.map(x=>x.id));return h('output',null,seen.at(-1));}
  w.blocked=true;const m=mount(p,h(App,{cat:'c0'}));
  await expect.poll(()=>resultMessages(w).length).toBe(1);
  m.render(p,h(App,{cat:'c1'}));
  await expect.poll(()=>resultMessages(w).length).toBe(2);
  m.render(p,h(App,{cat:'c0'}));
  await expect.poll(()=>resultMessages(w).length).toBe(3);
  w.flush();await barrier(p);await expect.poll(()=>m.el.textContent).toBe('c0:ready:p0');
  expect(seen.every(s=>!s.includes('ready') || s==='c0:ready:p0' || s==='c1:ready:p1')).toBe(true);
  const errors: string[]=[];const a=Object.assign((_r:ProductResult)=>{}, {onError:(e:Error)=>errors.push(e.message)});
  const old=p.watch('same', {...query(),offset:-1},a);
  const stop=p.watch('same',query(),a);
  await barrier(p);old();await barrier(p);expect(errors).toEqual([]);
  expect(p.lastWorkerStats?.active_subscriptions).toBe(2);
  stop();
});

it('V5.A invalid low-level acquisition recovers without retaining its error', async()=>{
  const {p,w}=await make();const seen: string[]=[];
  function App({invalid}:{invalid:boolean}){const r=useProductLiveQuery('recover',{...query(),offset:invalid?-1:0});const s=(r.error?'error':r.isLoading?'loading':'ready')+':'+(r.data?.rows.map(x=>x.id)??[]);seen.push(s);return h('output',null,s);}
  const m=mount(p,h(App,{invalid:true}));await expect.poll(()=>m.el.textContent).toBe('error:');
  const oldError=w.incoming.find(x=>x.type==='request_error')!;
  m.render(p,h(App,{invalid:false}));expect(m.el.textContent).toBe('loading:');
  await expect.poll(()=>m.el.textContent).toBe('ready:p0,p1');w.inject(oldError);
  expect(m.el.textContent).toBe('ready:p0,p1');expect(seen.at(-1)).toBe('ready:p0,p1');
});

it('V5.A unmount with pending or queued acquisition and provider replacement isolates every publication',async()=>{
  const {p,w}=await make();const second=await make();await second.p.apply({command:'delete',id:'p0'});
  const seen:string[]=[];
  function App({label}:{label:string}){const r=useLiveQuery('products',raw());seen.push(label+':'+r.status+':'+r.rows.map(x=>x.id));return h('output',null,seen.at(-1));}
  w.blocked=true;const m=mount(p,h(App,{label:'old'}));
  await expect.poll(()=>resultMessages(w).length).toBe(1);
  m.render(second.p,h(App,{label:'new'}));w.flush();await barrier(p);
  await expect.poll(()=>m.el.textContent).toBe('new:ready:p1');
  expect(seen.filter(x=>x.startsWith('new:ready')).every(x=>x==='new:ready:p1')).toBe(true);
  expect(p.lastWorkerStats?.active_subscriptions).toBe(0);
  second.w.blocked=true;const update=second.p.apply(put('extra'));const settled=update.then(()=>true);
  await expect.poll(()=>second.w.held.length).toBeGreaterThan(0);m.unmount();const before=seen.length;second.w.flush();await settled;await barrier(second.p);
  expect(seen.length).toBe(before);expect(second.p.lastWorkerStats?.active_subscriptions).toBe(0);
  const n=mount(p,h(App,{label:'pending'}));n.unmount();await barrier(p);expect(p.lastWorkerStats?.active_subscriptions).toBe(0);
});

it('V5.A root development StrictMode replay and staggered identical consumers retain one shape',async()=>{
  const {p,w}=await make();expect(p.lastWorkerWasmSha256).toBe((await (await fetch(new URL('../../../.local/wasm-build.json',import.meta.url))).json()).artifacts['product_core.wasm'].sha256);let setups=0,cleanups=0;
  function Consumer(){useEffect(()=>{setups++;return()=>{cleanups++;};},[]);const r=useLiveQuery('products',raw());return h('span',null,r.status+':'+r.totalRows);}
  const tree=(two:boolean)=>h('div',null,h(Consumer,{key:'a'}),two?h(Consumer,{key:'b'}):null);
  const m=mount(p,tree(true),true);
  await expect.poll(()=>m.el.textContent).toBe('ready:2ready:2');
  expect(setups).toBe(4);expect(cleanups).toBe(2);expect(reactVersion).toBe('19.3.0');
  expect(p.lastWorkerStats?.active_subscriptions).toBe(2);expect(p.lastWorkerStats?.active_query_shapes).toBe(1);
  m.render(p,tree(false));await barrier(p);expect(p.lastWorkerStats?.active_subscriptions).toBe(1);
  m.render(p,tree(true));await expect.poll(()=>m.el.textContent).toBe('ready:2ready:2');
  m.unmount();await barrier(p);expect(p.lastWorkerStats?.active_subscriptions).toBe(0);
  await commands.writeFile('v5-browser-runtime.json', JSON.stringify({react:reactVersion,browser:navigator.userAgent,wasmSha256:p.lastWorkerWasmSha256,setups,cleanups,opens:w.outgoing.filter(x=>(x.command as {command?:string})?.command==='open').length}));
});

for(const fault of ['messageerror','error','fatal'] as const) for(const phase of ['before-ready','ready-idle','ready-queued'] as const) {
  it(`V5.B terminal ${fault} at ${phase} notifies mounted peers and settles requests once`,async()=>{
    vi.stubGlobal('Worker',ControlledWorker);const p=new BrowserProductProvider();providers.push(p);const w=workers.at(-1)!;
    const cause=fault==='messageerror'?'ProductCore Worker message could not be decoded':'injected terminal fault';
    if(phase==='before-ready')w.blocked=true;else {await p.ready;await p.apply(put('p0'));}
    const seen:string[]=[];function App(){const a=useLiveQuery('products',raw()),b=useLiveQuery('products',raw());seen.push(a.status+':'+b.status);return h('output',null,a.status+':'+b.status+':'+(a.message??''));}
    const m=mount(p,h(App));
    let pending:Promise<unknown>|undefined;let settlements=0;
    if(phase==='before-ready'){pending=barrier(p).then(()=>{settlements++;throw Error('unexpected success');},e=>{settlements++;return e;});await expect.poll(()=>w.held.some(x=>x.type==='ready')).toBe(true);}
    else {await expect.poll(()=>m.el.textContent).toBe('ready:ready:');if(phase==='ready-queued'){w.blocked=true;pending=p.apply(put('next')).then(()=>{settlements++;throw Error('unexpected success');},e=>{settlements++;return e;});await expect.poll(()=>w.held.length).toBeGreaterThan(0);}}
    const bad=Object.assign((_r:ProductResult)=>{throw Error('subscriber exception');},{onError:()=>{throw Error('error callback exception');}});
    let healthyErrors=0;const good=Object.assign((_r:ProductResult)=>{}, {onError:()=>{healthyErrors++;}});
    p.onConsumerError=()=>{throw Error('reporter exception');};p.watch('bad',query(),bad);p.watch('good',query(),good);
    flushSync(()=>{if(fault==='messageerror')w.onmessageerror?.(new MessageEvent('messageerror'));else if(fault==='error')w.onerror?.(new ErrorEvent('error',{message:cause}));else w.inject({type:'fatal',error:cause});});
    expect(m.el.textContent).toBe('error:error:'+cause);expect(healthyErrors).toBe(1);
    expect(p.consumerErrors.some(x=>x.error.message==='reporter exception')).toBe(true);
    if(pending) {expect((await pending as Error).message).toBe(cause);expect(settlements).toBe(1);}
    expect((p as unknown as {pending:Map<number,unknown>}).pending.size).toBe(0);
    const count=seen.length;w.flush();w.inject({type:'ready'});w.inject({type:'request_error',id:1,error:'old error'});w.inject({type:'result',id:1,subscription:'bad'});w.inject({type:'ack',id:1,results:{}});
    expect(seen.length).toBe(count);await expect(barrier(p)).rejects.toThrow(cause);
    p.dispose();p.dispose();w.inject({type:'ready'});w.onerror?.(new ErrorEvent('error',{message:'after dispose'}));w.onmessageerror?.(new MessageEvent('messageerror'));w.inject({type:'fatal',error:'after dispose'});
    expect(healthyErrors).toBe(1);expect(seen.length).toBe(count);
  });
}

it('V5.C real postMessage clone failure after snapshot and pre-ready disposal settle owned promises',async()=>{
  const {p,w}=await make(false);const original=w.postMessage.bind(w);
  w.postMessage=(m)=>original({...m,uncloneable:()=>0});
  await expect(barrier(p)).rejects.toThrow();expect((p as unknown as {pending:Map<number,unknown>}).pending.size).toBe(0);
  w.postMessage=original;await barrier(p);p.dispose();
  const early=new BrowserProductProvider();providers.push(early);const ew=workers.at(-1)!;ew.blocked=true;
  const request=barrier(early);const observed=request.catch(e=>e);early.dispose();expect((await observed).message).toBe('provider is disposed');
  ew.flush();expect((early as unknown as {pending:Map<number,unknown>}).pending.size).toBe(0);
});

it('V5.F snapshots nested inputs before readiness and supports prototype-like identifiers',async()=>{
  const {p}=await make();
  const q={where_expr:{op:'and',args:[{op:'condition',args:{field:'category_equals',condition:'c0'}}]},direction:'ascending' as const,offset:0,limit:1};
  const opening=p.open('owned',q);q.where_expr.args[0].args.condition='c1';q.limit=0;
  expect((await opening).rows.map(x=>x.id)).toEqual(['p0']);
  let received:ProductResult|undefined;const watched=structuredClone(q);watched.where_expr.args[0].args.condition='c0';watched.limit=1;
  const stop=p.watch('watched',watched,r=>{received=r;});watched.where_expr.args[0].args.condition='c1';watched.direction='ascending';watched.offset=1;
  await barrier(p);expect(received?.rows.map(x=>x.id)).toEqual(['p0']);stop();
  const command={command:'open',subscription:'apply-owned',query:{...query('c0'),limit:1}};const applying=p.apply(command);command.query.where_expr={op:'false'};command.query.offset=1;
  expect((await applying)['apply-owned'].rows.map(x=>x.id)).toEqual(['p0']);
  for(const id of ['ordinary','','__proto__','constructor','toString']) {const r=await p.open(id,query());expect(r.subscription).toBe(id);expect(r.rows.length).toBe(2);await p.apply({command:'close',subscription:id});}
  const before=p.lastWorkerStats?.active_subscriptions;
  await expect(p.apply({command:'change_query',subscription:'owned',query:{...query(),offset:-1}})).rejects.toThrow();
  const next=await p.apply({command:'change_window',subscription:'owned',offset:0,limit:2});expect(next.owned.rows.map(x=>x.id)).toEqual(['p0']);
  expect(p.lastWorkerStats?.active_subscriptions).toBe(before);
});

it('V5.D E bounded delivery and acquisition counters match actual payloads',async()=>{
  const {p,w}=await make(false);for(let i=0;i<64;i++)await p.apply(put('r'+String(i).padStart(2,'0'),'c0',String(i)));
  await p.open('a',{...query('c0'),limit:6});const first=p.lastWorkerStats!;
  await p.open('b',{...query('c0'),offset:10,limit:3});await p.open('c',{...query('c0'),offset:20,limit:4});
  expect(p.lastWorkerStats?.query_seed_rows_scanned).toBe(64);expect(p.lastWorkerStats?.directed_index_records_cloned).toBe(0);
  expect(p.lastWorkerStats?.directed_indexes_constructed).toBe(1);
  await p.open('desc',{...query('c0'),direction:'descending',limit:2});expect(p.lastWorkerStats?.directed_index_records_transferred).toBe(64);expect(p.lastWorkerStats?.directed_index_records_cloned).toBe(128);
  await p.open('other',query('c1'));
  const before=p.lastWorkerStats!;
  await p.apply(put('no-match','c2'));await p.apply(put('no-match','c2'));expect(p.lastWorkerStats?.worker_results_built).toBe(before.worker_results_built);
  const changed=await p.apply({command:'patch',id:'r00',patch:{category:{op:'unchanged'},label:{op:'unchanged'},amount:{op:'unchanged'},quantity:{op:'set',value:'9007199254740999'}}});
  expect(Object.hasOwn(changed,'other')).toBe(false);
  expect(changed.a.rows[0].quantity).toBe('9007199254740999');expect(p.lastWorkerStats?.consolidated_deltas_emitted).toBe(before.consolidated_deltas_emitted);
  const offscreen=await p.apply(put('last','c0','1000'));expect(offscreen.a.total_rows).toBe(65);expect(offscreen.a.rows.length).toBe(6);
  await p.apply({command:'delete',id:'last'});
  const messages=w.incoming;const ackRows=messages.filter(m=>m.type==='ack').reduce((n,m)=>n+Object.values(m.results??{}).reduce((k,r)=>k+r.rows.length,0),0);
  const stats=p.lastWorkerStats!;expect(stats.worker_ack_row_occurrences).toBe(ackRows);expect(stats.worker_rows_serialized).toBe(ackRows);expect(stats.wasm_result_rows_encoded).toBe(ackRows);
  expect(stats.worker_result_message_count).toBe(0);expect(messages.filter(m=>m.type==='result').length).toBe(0);expect(stats.worker_message_count).toBe(messages.length);
  expect(first.worker_ack_row_occurrences).toBe(6);
  await commands.writeFile('v5-browser-counters.json', JSON.stringify({first,final:stats,observedAckRows:ackRows,observedMessages:messages.length}));
});

it('V5.A D independent viewport windows release safely and invalid replacement preserves active generation',async()=>{
  const {p,w}=await make();const emissions:string[][]=[[],[]];let a:ReturnType<typeof useLiveQueryViewport>['viewport']|undefined;let releaseA:(()=>void)|undefined;let moveB:((w:{firstRow:number;lastRow:number})=>void)|undefined;
  function App(){const left=useLiveQueryViewport('products'),right=useLiveQueryViewport('products');a=left.viewport;
    useEffect(()=>{const l=left.viewport.replace({query:raw(),window:{firstRow:0,lastRow:0},sink:{setRowCount(){},setRowData(rows){emissions[0].push(Object.entries(rows).map(([i,r])=>i+':'+r.id).join(','));}}});releaseA=l.release;return l.release;},[left.viewport]);
    useEffect(()=>{const r=right.viewport.replace({query:raw(),window:{firstRow:1,lastRow:1},sink:{setRowCount(){},setRowData(rows){emissions[1].push(Object.entries(rows).map(([i,r])=>i+':'+r.id).join(','));}}});moveB=r.setWindow;return r.release;},[right.viewport]);return h('output',null,left.status+':'+right.status);}
  const m=mount(p,h(App));await expect.poll(()=>m.el.textContent).toBe('ready:ready');expect(emissions).toEqual([['0:p0'],['1:p1']]);
  expect(()=>a!.replace({query:raw(),window:{firstRow:-1,lastRow:0},sink:{setRowCount(){},setRowData(){}}})).toThrow('invalid viewport');
  expect(()=>a!.replace({query:{...raw(),select:[]} as never,window:{firstRow:0,lastRow:0},sink:{setRowCount(){},setRowData(){}}})).toThrow('non-empty');
  await p.apply(put('early','c0','-1'));expect(emissions[0].at(-1)).toBe('0:early');
  releaseA!();await barrier(p);const leftCount=emissions[0].length;expect(p.lastWorkerStats?.active_subscriptions).toBe(1);
  w.blocked=true;moveB!({firstRow:0,lastRow:0});await expect.poll(()=>w.held.length).toBeGreaterThan(0);m.unmount();w.flush();await barrier(p);
  expect(emissions[0].length).toBe(leftCount);expect(emissions[1]).toEqual(['1:p1','1:p0']);expect(p.lastWorkerStats?.active_subscriptions).toBe(0);
});

it('V5.A same-version navigation is delivered and watched direct replacement releases the current acquisition',async()=>{
  const {p,w}=await make();const seen:ProductResult[]=[];const stop=p.watch('nav',query(),r=>seen.push(r));await barrier(p);
  const original=seen[0];w.blocked=true;const move=p.apply({command:'change_window',subscription:'nav',offset:1,limit:1});
  await expect.poll(()=>w.held.some(x=>x.type==='ack'&&!!x.results?.nav)).toBe(true);
  const msg=w.held.find(x=>x.results?.nav)!;msg.results!.nav.version=original.version;
  w.flush();await move;expect(seen.at(-1)?.rows.map(x=>x.id)).toEqual(['p1']);expect(seen.at(-1)?.version).toBe(original.version);
  await p.apply({command:'change_query',subscription:'nav',query:query('c0')});expect(seen.at(-1)?.rows.map(x=>x.id)).toEqual(['p0']);
  stop();await barrier(p);expect(p.lastWorkerStats?.active_subscriptions).toBe(0);
});

it('V5.D whole mounted result grows past 100 with exact selected payload and clean release',async()=>{
  const {p}=await make(false);for(let i=0;i<101;i++)await p.apply(put('r'+i));
  const seen:number[]=[];function App(){const r=useLiveQuery('products',raw());if(r.status==='ready'){expect(r.rows.length).toBe(r.totalRows);seen.push(r.totalRows);}return h('output',null,r.status+':'+r.totalRows);}
  const m=mount(p,h(App));await expect.poll(()=>m.el.textContent).toBe('ready:101');await p.apply(put('growth'));await expect.poll(()=>m.el.textContent).toBe('ready:102');
  await p.apply({command:'delete',id:'growth'});await expect.poll(()=>m.el.textContent).toBe('ready:101');expect(seen).toContain(102);m.unmount();await barrier(p);expect(p.lastWorkerStats?.active_subscriptions).toBe(0);
});

it('V5.F pre-ready open snapshots nested predicate direction and window without caller aliases',async()=>{
  vi.stubGlobal('Worker',ControlledWorker);const p=new BrowserProductProvider();providers.push(p);const w=workers.at(-1)!;w.blocked=true;
  const seedA=p.apply(put('a','c0','0')),seedB=p.apply(put('b','c0','1'));
  const q:{where_expr:{op:string;args:{field:string;condition:string}};direction:'ascending'|'descending';offset:number;limit:number}={where_expr:{op:'condition',args:{field:'category_equals',condition:'c0'}},direction:'ascending',offset:0,limit:1};
  const result=p.open('pre-ready',q);q.where_expr.args.condition='c1';q.direction='descending';q.offset=1;q.limit=0;
  await expect.poll(()=>w.held.some(x=>x.type==='ready')).toBe(true);w.flush();await Promise.all([seedA,seedB]);expect((await result).rows.map(x=>x.id)).toEqual(['a']);
});

it('V5.F queued rejected replacements do not poison a later valid query or its cleanup',async()=>{
  const {p}=await make();const seen:ProductResult[]=[];const stop=p.watch('queued-replace',query('c0'),r=>seen.push(r));await barrier(p);
  const invalid=p.apply({command:'change_query',subscription:'queued-replace',query:{...query(),offset:-1}}).catch(e=>e);
  const valid=p.apply({command:'change_query',subscription:'queued-replace',query:query('c1')});
  expect(await invalid).toBeInstanceOf(Error);expect((await valid)['queued-replace'].rows.map(x=>x.id)).toEqual(['p1']);expect(seen.at(-1)?.rows.map(x=>x.id)).toEqual(['p1']);
  const one=p.apply({command:'change_query',subscription:'queued-replace',query:{...query(),offset:-1}}).catch(e=>e);
  const two=p.apply({command:'change_query',subscription:'queued-replace',query:{...query(),offset:-1}}).catch(e=>e);
  await Promise.all([one,two]);await p.apply(put('p2','c1','2'));expect(seen.at(-1)?.rows.map(x=>x.id)).toEqual(['p1','p2']);
  stop();await barrier(p);expect(p.lastWorkerStats?.active_subscriptions).toBe(0);
});

it('V5.A viewport chrome is owned by its provider even before replacement effects',async()=>{
  const first=await make(),second=await make(false);const publications:string[]=[];
  function App({label}:{label:string}){const v=useLiveQueryViewport('products');publications.push(label+':'+v.status+':'+v.totalRows);useEffect(()=>{const g=v.viewport.replace({query:raw(),window:{firstRow:0,lastRow:1},sink:{setRowCount(){},setRowData(){}}});return g.release;},[v.viewport]);return h('output',null,publications.at(-1));}
  const m=mount(first.p,h(App,{label:'old'}));await expect.poll(()=>m.el.textContent).toBe('old:ready:2');second.w.blocked=true;
  m.render(second.p,h(App,{label:'new'}));expect(m.el.textContent).toBe('new:loading:0');
  first.w.onmessageerror?.(new MessageEvent('messageerror'));second.w.flush();await barrier(second.p);await expect.poll(()=>m.el.textContent).toBe('new:ready:0');
  expect(publications.filter(x=>x.startsWith('new:')).every(x=>x==='new:loading:0'||x==='new:ready:0')).toBe(true);
});
