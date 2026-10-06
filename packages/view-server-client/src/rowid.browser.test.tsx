import {createElement as h,useEffect,useState} from 'react';
import {render} from 'vitest-browser-react';
import {expect,it,vi} from 'vite-plus/test';
import {BrowserProductProvider,ProductProvider,createTopicHooks} from './product-provider';
import {catalog} from './generated/topics';
class Peer{
 static all:Peer[]=[];onmessage:((event:MessageEvent)=>void)|null=null;sent:any[]=[];constructor(){Peer.all.push(this)}postMessage(v:unknown){this.sent.push(v)}terminate(){}receive(v:unknown){this.onmessage?.({data:v}as MessageEvent)}
 result(r:any,keys:string[],rows:any[],version:number){return{subscription:r.command.subscription,topic:'orders',schema:catalog.orders.fingerprint,query_generation:r.acquisition,sequence:version,start_rank:r.command.query?.offset??0,total_rows:2,version,keys,rows};}
 ack(r:any,keys:string[],rows:any[]){this.receive({type:'ack',id:r.id,traceparent:r.traceparent,acquisitions:{[r.command.subscription]:r.acquisition},results:{[r.command.subscription]:this.result(r,keys,rows,1)}})}
 live(r:any,keys:string[],rows:any[],version:number){this.receive({type:'live',acquisitions:{[r.command.subscription]:r.acquisition},results:{[r.command.subscription]:this.result(r,keys,rows,version)}})}
}
it('both hooks and whole helper expose readonly stable rowId; React state follows entities after reorder, unchanged rows retain references',async()=>{
 Peer.all=[];vi.stubGlobal('Worker',Peer);const p=new BrowserProductProvider({mode:'remote',url:'ws://127.0.0.1:12345/v15',token:'test',catalog});const hooks=createTopicHooks(catalog);let whole:any[]=[];let helper:any[]=[];let viewport:any={},keyMap:any={};
 function Row({row}:{row:{rowId:string;customer:string}}){const[local]=useState('state:'+row.customer);return h('li',{'data-id':row.rowId},row.customer+'|'+local)}
 function App(){const a=hooks.useLiveQuery('orders',{select:['customer'],orderBy:[]});whole=[...a.rows];const vp=hooks.useLiveQueryViewport('orders');const b=vp.useWholeResult({select:['customer'],orderBy:[]});helper=[...b.rows];useEffect(()=>{const g=vp.viewport.replace({window:{firstRow:5,lastRow:6},query:{select:['customer'],orderBy:[]},sink:{setRowCount(){},setRowData(rows,keys){viewport=rows;keyMap=keys}}});return()=>g.release()},[vp.viewport]);return h('ul',null,a.rows.map(row=>h(Row,{key:row.rowId,row})))}
 const screen=await render(h(ProductProvider,{provider:p,children:h(App)}));
 try{const w=Peer.all[0]!;w.receive({type:'ready'});await expect.poll(()=>w.sent.filter(x=>x.type==='apply').length).toBe(3);const requests=w.sent.filter(x=>x.type==='apply');
  for(const r of requests){const result=w.result(r,['rid2:0101010000000161','rid2:0101010000000162'],[{customer:'Alice'},{customer:'Bob'}],1);if(result.start_rank)result.total_rows=7;w.receive({type:'ack',id:r.id,traceparent:r.traceparent,acquisitions:{[r.command.subscription]:r.acquisition},results:{[r.command.subscription]:result}})}
  await expect.poll(()=>whole.length).toBe(2);await expect.poll(()=>Object.keys(viewport).length).toBe(2);expect(whole.map(r=>r.rowId)).toEqual(['rid2:0101010000000161','rid2:0101010000000162']);expect(helper.map(r=>r.rowId)).toEqual(['rid2:0101010000000161','rid2:0101010000000162']);expect(Object.keys(whole[0])).toEqual(['customer','rowId']);expect(viewport[5].rowId).toBe(keyMap[5]);expect(viewport[6].rowId).toBe(keyMap[6]);expect(Object.getOwnPropertyDescriptor(whole[0],'rowId')?.writable).toBe(false);const bob=whole[1];
  for(const r of requests){const result=w.result(r,['rid2:0101010000000162','rid2:0101010000000161'],[{customer:'Bob'},{customer:'Alice changed'}],2);if(result.start_rank)result.total_rows=7;w.receive({type:'live',acquisitions:{[r.command.subscription]:r.acquisition},results:{[r.command.subscription]:result}})}
  await expect.poll(()=>whole[0]?.rowId).toBe('rid2:0101010000000162');expect(whole[0]).toBe(bob);await expect.element(screen.getByText('Alice changed|state:Alice')).toBeVisible();await expect.element(screen.getByText('Bob|state:Bob')).toBeVisible();expect(viewport[5].rowId).toBe('rid2:0101010000000162');expect(viewport[5].rowId).toBe(keyMap[5]);expect(Peer.all.length).toBe(1);
 }finally{await screen.unmount();p.dispose();vi.unstubAllGlobals()}
});

it('measures current public-row allocations against the exact supplied projection at fixed telemetry-off boundary',async()=>{
 const {project:before}=await import('../../../fixtures/rowid-before/projector.mjs');Peer.all=[];vi.stubGlobal('Worker',Peer);const p=new BrowserProductProvider({mode:'remote',url:'ws://127.0.0.1:12345/v15',token:'test',catalog});const hooks=createTopicHooks(catalog);let delivered:any[]=[];let version=0;
 function App(){const result=hooks.useLiveQuery('orders',{select:['customer'],orderBy:[]});delivered=[...result.rows];version=result.version;return h('output',null,result.version)}
 const screen=await render(h(ProductProvider,{provider:p,children:h(App)}));const oldObjects=new Set(),newObjects=new Set();const cuts:any[]=[];
 try{const w=Peer.all[0]!;w.receive({type:'ready'});await expect.poll(()=>w.sent.filter(x=>x.type==='apply').length).toBe(1);const r=w.sent.find(x=>x.type==='apply');
  const id=(i:number)=>'rid2:01010100000002'+[114,48+i].map(n=>n.toString(16).padStart(2,'0')).join('');
  const initial=Array.from({length:8},(_,i)=>({key:id(i),row:{customer:'C'+i}}));
  const schedules=[initial,initial.map(v=>structuredClone(v)),[...initial].reverse().map((v,i)=>({key:v.key,row:{customer:i===0?'changed':v.row.customer}})),[...initial].reverse().slice(0,7).map((v,i)=>({key:v.key,row:{customer:i===0?'changed':v.row.customer}}))];
  for(let i=0;i<schedules.length;i++){const cut=schedules[i]!,keys=cut.map(v=>v.key),rows=cut.map(v=>v.row),result={...w.result(r,keys,rows,i+1),total_rows:rows.length};for(const row of rows)oldObjects.add(before(row,['customer']));w.receive({type:i?'live':'ack',...(i?{}:{id:r.id,traceparent:r.traceparent}),acquisitions:{[r.command.subscription]:r.acquisition},results:{[r.command.subscription]:result}});await expect.poll(()=>version).toBe(i+1);for(const row of delivered)newObjects.add(row);cuts.push({version:i+1,rows:rows.length,oldObjects:oldObjects.size,newObjects:newObjects.size});}
  expect(oldObjects.size).toBe(31);expect(newObjects.size).toBe(9);console.log('ROWID_COPY_PROXY '+JSON.stringify({scope:'mounted controlled Worker, actual public hook vs exact supplied projection, row-object allocation proxy only',telemetry:'disabled on both paths',cuts,beforeRowObjects:oldObjects.size,afterRowObjects:newObjects.size,publicMetadataWrites:newObjects.size,rowsVisitedEachPath:31}));
 }finally{await screen.unmount();p.dispose();vi.unstubAllGlobals()}
});
