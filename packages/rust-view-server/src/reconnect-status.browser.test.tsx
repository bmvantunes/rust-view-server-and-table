import {createElement as h,useEffect} from 'react';
import {render} from 'vitest-browser-react';
import {it,expect,vi} from 'vite-plus/test';
import {BrowserProductProvider,ProductProvider,useConnectionStatus,useViewServerHealthSummary,useSourceHealth,useLiveQuery,useLiveQueryViewport,type ProductResult} from './product-provider';
class ControlledWorker {
 static all:ControlledWorker[]=[];
 onmessage:((event:MessageEvent)=>void)|null=null;onerror:unknown;onmessageerror:unknown;sent:any[]=[];dead=false;
 constructor(){ControlledWorker.all.push(this);}
 postMessage(message:unknown){this.sent.push(message);}
 terminate(){this.dead=true;}
 receive(message:unknown){this.onmessage?.({data:message} as MessageEvent);}
 ack(request:any,version=1){const sub=request.command.subscription;const result:ProductResult={subscription:sub,query_generation:request.acquisition,sequence:version,start_rank:0,version,total_rows:0,rows:[]};this.receive({type:'ack',id:request.id,traceparent:request.traceparent,results:request.command.command==='close'?{}:{[sub]:result},acquisitions:{[sub]:request.acquisition}});}
}
it('reconciles the complete query before a nested window reaches a mounted viewport sink',async()=>{
 vi.stubGlobal('Worker',ControlledWorker);ControlledWorker.all=[];
 const p=new BrowserProductProvider({mode:'remote',url:'ws://127.0.0.1:8080/v14',token:'controlled'}),watch=p.watch.bind(p),sink:Array<unknown>=[];let armed=false,nested:Promise<unknown>|undefined;
 p.watch=(sub,q,listener)=>{const status=listener.onStatus;listener.onStatus=s=>{status?.(s);if(armed&&s==='loading'){armed=false;nested=p.apply({command:'change_window',subscription:sub,offset:8,limit:2});}};return watch(sub,q,listener);};
 function App(){const view=useLiveQueryViewport('products');useEffect(()=>{const gen=view.viewport.replace({query:{select:['id'],where:[],orderBy:[]},window:{firstRow:0,lastRow:1},sink:{setRowCount(){},setRowData(rows){sink.push(rows);}}});return()=>gen.release();},[view.viewport]);return h('output',null,view.status);}
 const screen=await render(h(ProductProvider,{provider:p,children:h(App)}));
 try{const w=ControlledWorker.all[0];w.receive({type:'ready'});await expect.poll(()=>w.sent.filter(x=>x.type==='apply').length).toBe(1);const open=w.sent.find(x=>x.type==='apply');w.ack(open);await expect.element(screen.getByRole('status')).toMatchTextContent(/ready/);armed=true;
 const old=p.apply({command:'change_query',subscription:open.command.subscription,query:{...open.command.query,where_expr:{op:'condition',args:{field:'category_equals',condition:'b'}}}}).catch(e=>e.code);expect(await old).toBe('read_superseded');
 await expect.poll(()=>w.sent.filter(x=>x.type==='apply').length).toBe(2);const req=w.sent.at(-1);expect(req.command.command).toBe('change_query');expect(req.command.query.offset).toBe(8);expect(req.command.query.where_expr.args.condition).toBe('b');
 // The response is computed from the emitted server command, not provider intent.
 const rows=Array.from({length:req.command.query.limit},(_,i)=>({id:req.command.query.where_expr.args.condition+(req.command.query.offset+i)}));
 w.receive({type:'ack',id:req.id,traceparent:req.traceparent,results:{[req.command.subscription]:{subscription:req.command.subscription,query_generation:req.acquisition,sequence:2,start_rank:req.command.query.offset,version:2,total_rows:20,rows}},acquisitions:{[req.command.subscription]:req.acquisition}});await nested;
 await expect.element(screen.getByRole('status')).toMatchTextContent(/ready/);expect(sink.at(-1)).toEqual({8:{id:'b8',rowId:'b8'},9:{id:'b9',rowId:'b9'}});expect(p.consumerErrors).toEqual([]);
 }finally{await screen.unmount();p.dispose();vi.unstubAllGlobals();}
});
it('shares mounted connection observers and distinct per-query readiness through recovery without status-only viewport resets',async()=>{
 vi.stubGlobal('Worker',ControlledWorker);ControlledWorker.all=[];
 const p=new BrowserProductProvider({mode:'remote',url:'ws://127.0.0.1:8080/v14',token:'controlled',recovery:{initialDelayMs:5,maxDelayMs:5,budgetMs:3000,maxAttempts:4,healthyMs:1000}}),calls:string[]=[],observations:string[]=[];
 function Badge(){const status=useConnectionStatus();return h('span',{'data-badge':true},status);}
 function App(){const whole=useLiveQuery('products',{select:['id'],where:[],orderBy:[]});const view=useLiveQueryViewport('products');observations.push(whole.status+':'+view.status);useEffect(()=>{const gen=view.viewport.replace({query:{select:['id'],where:[],orderBy:[]},window:{firstRow:0,lastRow:1},sink:{setRowCount(){calls.push('count');},setRowData(){calls.push('data');}}});return()=>gen.release();},[view.viewport]);return h('output',null,whole.status+':'+view.status+':'+whole.version+':'+view.version);}
 const screen=await render(h(ProductProvider,{provider:p,children:[h(Badge,{key:'a'}),h(Badge,{key:'b'}),h(App,{key:'app'})]}));
 try {
  expect(ControlledWorker.all.length).toBe(1);await expect.element(screen.getByRole('status')).toMatchTextContent(/loading:loading:0:0/);
  const first=ControlledWorker.all[0];first.receive({type:'ready'});await expect.poll(()=>first.sent.filter(x=>x.type==='apply').length).toBe(2);
  const requests=first.sent.filter(x=>x.type==='apply');first.ack(requests.find(x=>x.command.subscription.startsWith('products')));await expect.element(screen.getByRole('status')).toMatchTextContent(/ready:loading:1:0/);first.ack(requests.find(x=>x.command.subscription.startsWith('viewport')));await expect.element(screen.getByRole('status')).toMatchTextContent(/ready:ready:1:1/);expect(calls).toEqual(['count','data']);
  first.receive({type:'fatal',recoverable:true,code:'network',error:'loss'});await expect.element(screen.getByRole('status')).toMatchTextContent(/stale:stale:1:1/);expect(calls).toEqual(['count','data']);await expect.poll(()=>ControlledWorker.all.length).toBe(2);const next=ControlledWorker.all[1];next.receive({type:'ready'});await expect.poll(()=>next.sent.filter(x=>x.type==='apply').length).toBe(2);expect(p.connectionStatus).toBe('connected');await expect.element(screen.getByRole('status')).toMatchTextContent(/stale:stale:1:1/);expect(calls).toEqual(['count','data']);
  first.receive({type:'fatal',recoverable:false,error:'late'});expect(p.connectionStatus).toBe('connected');const reacquired=next.sent.filter(x=>x.type==='apply');next.ack(reacquired.find(x=>x.command.subscription.startsWith('products')),2);await expect.element(screen.getByRole('status')).toMatchTextContent(/ready:stale:2:1/);next.ack(reacquired.find(x=>x.command.subscription.startsWith('viewport')),2);await expect.element(screen.getByRole('status')).toMatchTextContent(/ready:ready:2:2/);expect(calls).toEqual(['count','data','count','data']);expect(observations).toContain('ready:loading');expect(observations).toContain('ready:stale');
  p.dispose();await expect.element(screen.getByRole('status')).toMatchTextContent(/closed:closed:2:2/);expect(p.connectionStatus).toBe('disconnected');
 }finally{await screen.unmount();p.dispose();vi.unstubAllGlobals();}
});
it('settles reentrant loading replacements truthfully through both mounted hook listeners',async()=>{
 vi.stubGlobal('Worker',ControlledWorker);ControlledWorker.all=[];
 const p=new BrowserProductProvider({mode:'remote',url:'ws://127.0.0.1:8080/v14',token:'controlled'}),original=p.watch.bind(p),nested:Promise<unknown>[]=[],events:string[]=[],sink:Array<unknown>=[];let armed=false;
 p.watch=(sub,q,listener)=>{const onStatus=listener.onStatus;listener.onStatus=status=>{onStatus?.(status);events.push(sub+':'+status);if(armed&&status==='loading'){nested.push(p.apply(sub.startsWith('viewport')?{command:'change_window',subscription:sub,offset:8,limit:2}:{command:'change_query',subscription:sub,query:{...q,where_expr:{op:'condition',args:{field:'category_equals',condition:'c'}}}}));}};return original(sub,q,listener);};
 function App(){const whole=useLiveQuery('products',{select:['id'],where:[],orderBy:[]}),view=useLiveQueryViewport('products');useEffect(()=>{const gen=view.viewport.replace({query:{select:['id'],where:[],orderBy:[]},window:{firstRow:0,lastRow:1},sink:{setRowCount(){},setRowData(rows){sink.push(rows);}}});return()=>gen.release();},[view.viewport]);return h('output',null,whole.status+':'+view.status+':'+JSON.stringify(whole.rows));}
 const screen=await render(h(ProductProvider,{provider:p,children:h(App)}));
 try{const w=ControlledWorker.all[0];w.receive({type:'ready'});await expect.poll(()=>w.sent.filter(x=>x.type==='apply').length).toBe(2);const requests=w.sent.filter(x=>x.type==='apply');requests.forEach((r:any)=>w.ack(r));await expect.element(screen.getByRole('status')).toMatchTextContent(/ready:ready/);armed=true;
 const whole=requests.find(x=>x.command.subscription.startsWith('products')),window=requests.find(x=>x.command.subscription.startsWith('viewport'));
 const outcomes=await Promise.all([p.apply({command:'change_query',subscription:whole.command.subscription,query:{...whole.command.query,where_expr:{op:'condition',args:{field:'category_equals',condition:'b'}}}}).catch(e=>e.code),p.apply({command:'change_window',subscription:window.command.subscription,offset:4,limit:2}).catch(e=>e.code)]);expect(outcomes).toEqual(['read_superseded','read_superseded']);armed=false;
 await expect.poll(()=>w.sent.filter(x=>x.type==='apply').length).toBe(4);const replacements=w.sent.filter(x=>x.type==='apply').slice(2);expect(replacements.map(x=>x.command.query?.where_expr.args.condition??x.command.offset)).toEqual(['c',8]);
 for(const req of replacements){const sub=req.command.subscription,rank=req.command.offset??0;w.receive({type:'ack',id:req.id,traceparent:req.traceparent,results:{[sub]:{subscription:sub,query_generation:req.acquisition,sequence:2,start_rank:rank,version:2,total_rows:sub.startsWith('viewport')?20:2,rows:[{id:'c0'},{id:'c1'}]}},acquisitions:{[sub]:req.acquisition}});}await Promise.all(nested);await expect.element(screen.getByRole('status')).toMatchTextContent(/ready:ready:\[\{"id":"c0","rowId":"c0"\},\{"id":"c1","rowId":"c1"\}\]/);expect(Object.keys(sink.at(-1) as object)).toEqual(['8','9']);expect(p.admission.outstanding).toBe(0);expect(p.consumerErrors).toEqual([]);
 }finally{await screen.unmount();p.dispose();vi.unstubAllGlobals();}
});

it('shares health observers, retains stale incarnation and prevents reentrant old notifications',async()=>{
 vi.stubGlobal('Worker',ControlledWorker);ControlledWorker.all=[];
 const p=new BrowserProductProvider({mode:'remote',url:'ws://127.0.0.1:8080/v14',token:'controlled',recovery:{initialDelayMs:5,maxDelayMs:5,budgetMs:3000,maxAttempts:4}});
 function Badge(){const h=useViewServerHealthSummary();useSourceHealth({topic:'products'});return h.status;}
 const screen=await render(h(ProductProvider,{provider:p,children:[h(Badge,{key:'a'}),h(Badge,{key:'b'})]}));
 try{const w=ControlledWorker.all[0];w.receive({type:'ready'});await expect.poll(()=>w.sent.filter(x=>x.type==='health_subscribe'&&x.enabled).length).toBe(1);expect(w.sent.some(x=>x.type==='apply')).toBe(false);
 const sample={version:1,instance:'old',sequence:1,sampled_at_unix_ms:1,observed_at_ms:1,ready:true,live:true,startup_complete:true,phase:'serving',sources:[],dependencies:[]};w.receive({type:'health',snapshot:sample});await expect.poll(()=>p.getHealthSnapshot().status).toBe('ready');w.receive({type:'fatal',recoverable:true,error:'network',code:'network'});expect(p.getHealthSnapshot().status).toBe('stale');expect(p.getHealthSnapshot().snapshot?.sampled_at_unix_ms).toBe(1);await expect.poll(()=>ControlledWorker.all.length).toBe(2);const next=ControlledWorker.all[1];next.receive({type:'ready'});expect(p.getHealthSnapshot().status).toBe('stale');next.receive({type:'health',snapshot:{...sample,instance:'new',sequence:0}});expect(p.getHealthSnapshot().snapshot?.instance).toBe('new');w.receive({type:'health',snapshot:{...sample,sequence:999}});expect(p.getHealthSnapshot().snapshot?.instance).toBe('new');
 let calls=0;const off=p.subscribeHealth(()=>{if(p.getHealthSnapshot().status==='ready')p.dispose();});const off2=p.subscribeHealth(()=>{calls++;});next.receive({type:'health',snapshot:{...sample,instance:'new',sequence:2}});expect(p.getHealthSnapshot().status).toBe('closed');expect(calls).toBe(1);off();off2();
 }finally{await screen.unmount();p.dispose();vi.unstubAllGlobals();}
});

it('H1 disposal from a mounted health-hook notification keeps both query hooks closed beyond retry deadlines',async()=>{
 vi.stubGlobal('Worker',ControlledWorker);ControlledWorker.all=[];
 const p=new BrowserProductProvider({mode:'remote',url:'ws://127.0.0.1:8080/v14',token:'controlled',recovery:{initialDelayMs:5,maxDelayMs:5,budgetMs:80,maxAttempts:4}}),subscribe=p.subscribeHealth,sink:string[]=[];let armed=false,hookNotifications=0;
 // Wrap the actual useSyncExternalStore listener, distinct from a direct observer probe.
 vi.spyOn(p,'subscribeHealth').mockImplementation(listener=>subscribe(()=>{listener();hookNotifications++;if(armed&&p.getHealthSnapshot().status==='stale'){armed=false;p.dispose();}}));
 function Badge(){const health=useViewServerHealthSummary();useSourceHealth({topic:'products'});return h('span',null,health.status);}
 function App(){const connection=useConnectionStatus(),whole=useLiveQuery('products',{select:['id'],where:[],orderBy:[]}),view=useLiveQueryViewport('products');useEffect(()=>{const handle=view.viewport.replace({query:{select:['id'],where:[],orderBy:[]},window:{firstRow:0,lastRow:1},sink:{setRowCount(){sink.push('count');},setRowData(){sink.push('data');}}});return()=>handle.release();},[view.viewport]);return h('output',null,connection+':'+whole.status+':'+view.status);}
 const screen=await render(h(ProductProvider,{provider:p,children:[h(App,{key:'app'}),h(Badge,{key:'a'}),h(Badge,{key:'b'})]}));
 try{const old=ControlledWorker.all[0];old.receive({type:'ready'});await expect.poll(()=>old.sent.filter(x=>x.type==='apply').length).toBe(2);old.sent.filter(x=>x.type==='apply').forEach(r=>old.ack(r));await expect.element(screen.getByRole('status')).toMatchTextContent(/connected:ready:ready/);
 expect(old.sent.filter(x=>x.type==='health_subscribe'&&x.enabled).length).toBe(1);const sample={version:1,instance:'h1',sequence:1,sampled_at_unix_ms:1,observed_at_ms:1,ready:true,live:true,startup_complete:true,phase:'serving',sources:[],dependencies:[]};old.receive({type:'health',snapshot:sample});await expect.poll(()=>hookNotifications).toBeGreaterThan(0);const before=sink.slice(),ready=p.ready;armed=true;
 old.receive({type:'fatal',recoverable:true,error:'network',code:'network'});await expect.element(screen.getByRole('status')).toMatchTextContent(/disconnected:closed:closed/);expect(p.ready).toBe(ready);await ready;expect(p.getHealthSnapshot().status).toBe('closed');expect(sink).toEqual(before);expect(p.admission.outstanding).toBe(0);
 await new Promise(r=>setTimeout(r,150));old.receive({type:'ready'});old.receive({type:'health',snapshot:{...sample,sequence:100}});expect(ControlledWorker.all.length).toBe(1);expect(old.dead).toBe(true);expect(p.connectionDiagnostics.terminalCode).toBe('disposed');expect(p.connectionStatus).toBe('disconnected');expect(p.getHealthSnapshot().status).toBe('closed');
 }finally{await screen.unmount();p.dispose();vi.unstubAllGlobals();}expect(p.getHealthSnapshot().status).toBe('closed');
});

it('retries explicit source readiness without disturbing a healthy peer acquisition',async()=>{
 vi.stubGlobal('Worker',ControlledWorker);ControlledWorker.all=[];
 const p=new BrowserProductProvider({mode:'remote',url:'ws://127.0.0.1:8080/v14',token:'controlled'});
 try{
  const w=ControlledWorker.all[0];w.receive({type:'ready'});await p.ready;
  const query={projection:['id'] as const,where_expr:{op:'and',args:[]},direction:'ascending' as const,offset:0,limit:2};
  const a:ProductResult[]=[],b:ProductResult[]=[];
  const offA=p.watch('busy',query,value=>a.push(value)),offB=p.watch('peer',query,value=>b.push(value));
  await expect.poll(()=>w.sent.filter(x=>x.type==='apply').length).toBe(2);
  const first=w.sent.find(x=>x.command?.subscription==='busy'),peer=w.sent.find(x=>x.command?.subscription==='peer');w.ack(peer);
  w.receive({type:'request_error',id:first.id,traceparent:first.traceparent,error:'retention maintenance pending',code:'source_not_ready'});
  await expect.poll(()=>w.sent.filter(x=>x.command?.subscription==='busy').length).toBe(2);
  const retry=w.sent.at(-1);expect(retry.id).toBeGreaterThan(peer.id);expect(retry.acquisition).toBe(first.acquisition);expect(retry.command).toEqual(first.command);w.ack(retry);
  await expect.poll(()=>a.length).toBe(1);expect(b.length).toBe(1);expect(ControlledWorker.all.length).toBe(1);expect(p.connectionStatus).toBe('connected');expect(p.consumerErrors).toEqual([]);
  offA();offB();
 }finally{p.dispose();vi.unstubAllGlobals();}
});
it('does not retry permanent rejection or replay a released readiness request',async()=>{
 vi.stubGlobal('Worker',ControlledWorker);ControlledWorker.all=[];
 const p=new BrowserProductProvider({mode:'remote',url:'ws://127.0.0.1:8080/v14',token:'controlled'});
 try{
  const w=ControlledWorker.all[0];w.receive({type:'ready'});await p.ready;
  const query={projection:['id'] as const,where_expr:{op:'and',args:[]},direction:'ascending' as const,offset:0,limit:2};
  const off=p.watch('cancel',query,()=>{});await expect.poll(()=>w.sent.some(x=>x.command?.subscription==='cancel')).toBe(true);
  const first=w.sent.at(-1);w.receive({type:'request_error',id:first.id,traceparent:first.traceparent,error:'retention maintenance pending',code:'source_not_ready'});off();
  const invalid=p.open('bad',query).catch(error=>error.message);await expect.poll(()=>w.sent.some(x=>x.command?.subscription==='bad')).toBe(true);
  const bad=w.sent.find(x=>x.command?.subscription==='bad');w.receive({type:'request_error',id:bad.id,traceparent:bad.traceparent,error:'invalid query'});expect(await invalid).toBe('invalid query');
  await new Promise(resolve=>setTimeout(resolve,160));expect(w.sent.filter(x=>x.command?.command==='open'&&x.command?.subscription==='cancel').length).toBe(1);expect(w.sent.filter(x=>x.command?.subscription==='bad').length).toBe(1);
 }finally{p.dispose();vi.unstubAllGlobals();}
});
it('bounds readiness retries and settles disposal while a retry timer is pending',async()=>{
 vi.stubGlobal('Worker',ControlledWorker);ControlledWorker.all=[];
 const p=new BrowserProductProvider({mode:'remote',url:'ws://127.0.0.1:8080/v14',token:'controlled'});
 try{
  const w=ControlledWorker.all[0];w.receive({type:'ready'});await p.ready;
  const query={projection:['id'] as const,where_expr:{op:'and',args:[]},direction:'ascending' as const,offset:0,limit:2};
  const expired=p.open('expired',query).catch(error=>error.message);await expect.poll(()=>w.sent.some(x=>x.command?.subscription==='expired')).toBe(true);
  const first=w.sent.at(-1),now=performance.now();const clock=vi.spyOn(performance,'now').mockReturnValue(now+10001);
  w.receive({type:'request_error',id:first.id,traceparent:first.traceparent,error:'retention maintenance pending',code:'source_not_ready'});expect(await expired).toContain('readiness retry deadline');clock.mockRestore();
  const cancelled=p.open('pending',query).catch(error=>error.message);await expect.poll(()=>w.sent.some(x=>x.command?.subscription==='pending')).toBe(true);
  const next=w.sent.at(-1);w.receive({type:'request_error',id:next.id,traceparent:next.traceparent,error:'retention maintenance pending',code:'source_not_ready'});p.dispose();expect(await cancelled).toContain('disposed');
  await new Promise(resolve=>setTimeout(resolve,160));expect(w.sent.filter(x=>x.command?.subscription==='pending').length).toBe(1);expect(p.admission.outstanding).toBe(0);expect(p.admission.inFlight).toBe(0);
 }finally{p.dispose();vi.restoreAllMocks();vi.unstubAllGlobals();}
});
it('keeps wire request IDs increasing when a readiness retry overtakes queued commands',async()=>{
 vi.stubGlobal('Worker',ControlledWorker);ControlledWorker.all=[];
 const p=new BrowserProductProvider({mode:'remote',url:'ws://127.0.0.1:8080/v14',token:'controlled'});
 try{
  const w=ControlledWorker.all[0];w.receive({type:'ready'});await p.ready;
  const query={projection:['id'] as const,where_expr:{op:'and',args:[]},direction:'ascending' as const,offset:0,limit:2};
  const promises=Array.from({length:5},(_,i)=>p.open(`queued-${i}`,query).catch(error=>error));
  await expect.poll(()=>w.sent.filter(x=>x.type==='apply').length).toBe(4);
  const first=w.sent.find(x=>x.type==='apply');w.receive({type:'request_error',id:first.id,traceparent:first.traceparent,error:'retention maintenance pending',code:'source_not_ready'});
  await expect.poll(()=>w.sent.filter(x=>x.type==='apply').length).toBe(5);
  const requests=w.sent.filter(x=>x.type==='apply');w.ack(requests[1]);
  await expect.poll(()=>w.sent.filter(x=>x.type==='apply').length).toBe(6);
  const sent=w.sent.filter(x=>x.type==='apply');expect(sent.map(x=>x.id)).toEqual([1,2,3,4,5,6]);
  for(const index of [2,3,4,5])w.ack(sent[index]);await Promise.all(promises);expect(p.admission.outstanding).toBe(0);
 }finally{p.dispose();vi.unstubAllGlobals();}
});
it('never replays an older same-acquisition window after a newer window succeeds',async()=>{
 vi.stubGlobal('Worker',ControlledWorker);ControlledWorker.all=[];
 const p=new BrowserProductProvider({mode:'remote',url:'ws://127.0.0.1:8080/v14',token:'controlled'});
 try{
  const w=ControlledWorker.all[0];w.receive({type:'ready'});await p.ready;
  const query={projection:['id'] as const,where_expr:{op:'and',args:[]},direction:'ascending' as const,offset:0,limit:2};
  p.watch('window',query,()=>{});await expect.poll(()=>w.sent.some(x=>x.type==='apply')).toBe(true);w.ack(w.sent.at(-1));await expect.poll(()=>p.admission.outstanding).toBe(0);
  const older=p.apply({command:'change_window',subscription:'window',offset:10,limit:2}).catch(error=>error.code);
  await expect.poll(()=>w.sent.filter(x=>x.type==='apply').length).toBe(2);const old=w.sent.at(-1);w.receive({type:'request_error',id:old.id,traceparent:old.traceparent,error:'retention maintenance pending',code:'source_not_ready'});
  const newer=p.apply({command:'change_window',subscription:'window',offset:20,limit:2});await expect.poll(()=>w.sent.filter(x=>x.type==='apply').length).toBe(3);const current=w.sent.at(-1);expect(current.acquisition).toBe(old.acquisition);w.ack(current);await newer;
  expect(await older).toBe('read_superseded');expect(w.sent.filter(x=>x.type==='apply').length).toBe(3);expect(p.admission.outstanding).toBe(0);
 }finally{p.dispose();vi.unstubAllGlobals();}
});
it('supersedes readiness retries for direct commands without a watch registration',async()=>{
 vi.stubGlobal('Worker',ControlledWorker);ControlledWorker.all=[];
 const p=new BrowserProductProvider({mode:'remote',url:'ws://127.0.0.1:8080/v14',token:'controlled'});
 try{
  const w=ControlledWorker.all[0];w.receive({type:'ready'});await p.ready;
  const query={projection:['id'] as const,where_expr:{op:'and',args:[]},direction:'ascending' as const,offset:0,limit:2};
  const opened=p.open('direct',query);await expect.poll(()=>w.sent.some(x=>x.type==='apply')).toBe(true);w.ack(w.sent.at(-1));await opened;
  const older=p.apply({command:'change_window',subscription:'direct',offset:10,limit:2}).catch(error=>error.code);await expect.poll(()=>w.sent.filter(x=>x.type==='apply').length).toBe(2);const old=w.sent.at(-1);w.receive({type:'request_error',id:old.id,traceparent:old.traceparent,error:'retention maintenance pending',code:'source_not_ready'});
  const newer=p.apply({command:'change_window',subscription:'direct',offset:20,limit:2});await expect.poll(()=>w.sent.filter(x=>x.type==='apply').length).toBe(3);w.ack(w.sent.at(-1));await newer;
  expect(await older).toBe('read_superseded');expect(w.sent.filter(x=>x.type==='apply').length).toBe(3);expect(p.admission.outstanding).toBe(0);
 }finally{p.dispose();vi.unstubAllGlobals();}
});
