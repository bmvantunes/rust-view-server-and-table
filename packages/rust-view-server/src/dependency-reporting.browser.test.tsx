import {createElement as h} from 'react';
import {render} from 'vitest-browser-react';
import {it,expect,vi} from 'vite-plus/test';
import {BrowserProductProvider,ProductProvider,useViewServerHealthSummary,useSourceHealth} from './product-provider';

class HealthWorker {
 static all:HealthWorker[]=[];
 onmessage:((event:MessageEvent)=>void)|null=null;sent:Array<{type:string;enabled?:boolean}>=[];
 constructor(){HealthWorker.all.push(this);}
 postMessage(message:{type:string;enabled?:boolean}){this.sent.push(message);}
 terminate(){}
 receive(message:unknown){this.onmessage?.({data:message} as MessageEvent);}
}

it('mounted summary/source health stay immediate and complete through final recovery and throwing listeners',async()=>{
 vi.stubGlobal('Worker',HealthWorker);HealthWorker.all=[];
 const provider=new BrowserProductProvider({mode:'remote',url:'ws://127.0.0.1:8080/v14',token:'controlled'});
 function Badge(){const summary=useViewServerHealthSummary(),source=useSourceHealth({topic:'products'});return h('output',null,`${summary.status}:${summary.ready}:${source.source?.dependencies.join(',')}`);}
 const screen=await render(h(ProductProvider,{provider,children:h(Badge)}));
 try {
  const worker=HealthWorker.all[0];worker.receive({type:'ready'});
  await expect.poll(()=>worker.sent.filter(x=>x.type==='health_subscribe'&&x.enabled).length).toBe(1);
  const off=provider.subscribeHealth(()=>{throw Error('observer failure');});
  const dependencies=[{id:'source',resource_id:'a',role:'read',state:'ready',reason:null,attribution:'observed'},{id:'canonical',resource_id:'a',role:'write',state:'ready',reason:null,attribution:'observed'}];
  const sample={version:1,instance:'f4',sequence:1,sampled_at_unix_ms:1,observed_at_ms:1,ready:true,live:true,startup_complete:true,phase:'serving',reason:'ready',authority_safe:true,sources:[{topic:'products',source_id:'s',dependencies:['source','canonical'],policy:{max_sample_age_ms:2000},partitions:[]}],dependencies};
  worker.receive({type:'health',snapshot:sample});
  expect(provider.getHealthSnapshot().snapshot?.ready).toBe(true);
  await expect.element(screen.getByRole('status')).toMatchTextContent(/ready:true:source,canonical/);
  worker.receive({type:'health',snapshot:{...sample,sequence:2,ready:false,authority_safe:false,dependencies:[{...dependencies[0],state:'down'},dependencies[1]]}});
  expect(provider.getHealthSnapshot().snapshot?.ready).toBe(false);
  expect(provider.getHealthSnapshot().snapshot?.dependencies.length).toBe(2);
  await expect.element(screen.getByRole('status')).toMatchTextContent(/ready:false:source,canonical/);
  worker.receive({type:'health',snapshot:{...sample,sequence:3}});
  expect(provider.getHealthSnapshot().snapshot?.ready).toBe(true);
  await expect.element(screen.getByRole('status')).toMatchTextContent(/ready:true:source,canonical/);
  expect(provider.consumerErrors.length).toBe(3);off();provider.dispose();
  worker.receive({type:'health',snapshot:{...sample,sequence:4,ready:false}});
  expect(provider.getHealthSnapshot().status).toBe('closed');
  await expect.element(screen.getByRole('status')).toMatchTextContent(/closed:/);
 }finally{await screen.unmount();provider.dispose();vi.unstubAllGlobals();}
});
