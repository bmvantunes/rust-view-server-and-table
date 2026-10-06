import {expect,it} from 'vite-plus/test';
import {catalog} from './generated/expanded-topics';
import {encodeGeneric,decodeGeneric} from './wire/msgpack.mjs';
const id='rid2:0101010000000178';
async function harness(enabled=true){
 let startupError:unknown;const w=new Worker(new URL('./patch-controlled.worker.ts',import.meta.url),{type:'module'}),messages:any[]=[];w.onmessage=e=>messages.push(e.data);w.onerror=error=>{startupError=error.message;};try{await expect.poll(()=>{if(startupError)throw Error(String(startupError));return messages.some(m=>m.reviewLoaded);},{timeout:10000}).toBe(true);}catch(error){w.terminate();throw error;}
 w.postMessage({type:'configure',options:{url:'ws://127.0.0.1:1/v15',token:'test',catalog,fieldPatches:enabled}});await expect.poll(()=>messages.some(m=>m.reviewWire)).toBe(true);
 const decoded=decodeGeneric(new Uint8Array(messages.find(m=>m.reviewWire).reviewWire));if(!decoded||typeof decoded!=='object'||Array.isArray(decoded))throw Error('hello shape');const hello=decoded as Record<string,unknown>;const envelope={v:15,nonce:hello.nonce,incarnation:'a'.repeat(32),connection:'1'};
 const frame=(v:any)=>w.postMessage({reviewFrame:Array.from(encodeGeneric({...envelope,...v}))});
 frame({type:'ready',capabilities:{generic_schemas_v1:true,grouped_aggregates_v1:true,schema_expansion_v1:true,selected_field_patches_v1:enabled},catalog:Object.fromEntries(Object.entries(catalog).map(([k,v])=>[k,v.fingerprint])),coverage:[0,1],limits:{per_client:32,total:32}});
 await expect.poll(()=>messages.some(m=>m.type==='ready')).toBe(true);return {w,messages,frame,hello};
}
function raw(){return {kind:'snapshot',subscription:'q',topic:'shit',schema:catalog.shit.fingerprint,query_generation:1,sequence:1,start_rank:0,total_rows:1,version:1,revision:1,contentVersion:1,windowId:1,effectiveEnd:1,projection:['oo.name','oo.note','oo.price'],keys:[id],rows:[{oo:{name:'old',note:'x'.repeat(1000),price:'9007199254740993.000000000000000001'}}]};}
async function open(h:any){h.w.postMessage({type:'apply',id:1,acquisition:1,traceparent:'trace-1',command:{command:'open',subscription:'q',query:{topic:'shit',schema:catalog.shit.fingerprint,offset:0,limit:10,select:raw().projection,order_by:[]}}});await expect.poll(()=>h.messages.filter((m:any)=>m.reviewWire).length).toBe(2);h.frame({type:'result',id:1,traceparent:'trace-1',subscription:'q',acquisition:1,source_sequence:'1',result:raw()});h.frame({type:'ack',id:1,traceparent:'trace-1',result_count:1});await expect.poll(()=>h.messages.some((m:any)=>m.type==='ack')).toBe(true);}
function delta(revision:number,changes:unknown[]){const {rows,keys,...b}=raw();return {...b,kind:'delta',sequence:revision,version:revision,revision,contentVersion:revision,fromRevision:revision-1,fromVersion:revision-1,toVersion:revision,operations:[{type:'patch',index:0,key:id,changes}]};}
it('production Worker applies negotiated nested patches over MessagePack and rejects final invalid operation atomically',async()=>{const h=await harness();try{
 expect(h.hello.capabilities).toContain('selected_field_patches_v1');await open(h);const old=h.messages.find(m=>m.type==='ack').results.q;const before=JSON.stringify(old);
 h.frame({type:'result',subscription:'q',acquisition:1,source_sequence:'2',result:delta(2,[{type:'set',path:'oo.price',value:null},{type:'remove',path:'oo.note'}])});await expect.poll(()=>h.messages.filter(m=>m.type==='live').length).toBe(1);expect(h.messages.find(m=>m.type==='live').results.q.rows[0]).toEqual({oo:{name:'old',price:null}});expect(JSON.stringify(old)).toBe(before);
 h.frame({type:'result',subscription:'q',acquisition:1,source_sequence:'3',result:delta(3,[{type:'remove',path:'oo'}])});await expect.poll(()=>h.messages.filter(m=>m.type==='live').length).toBe(2);expect(h.messages.filter(m=>m.type==='live')[1].results.q.rows[0]).toEqual({});
 h.frame({type:'result',subscription:'q',acquisition:1,source_sequence:'4',result:delta(4,[{type:'object',path:'oo'},{type:'set',path:'oo.name',value:''}])});await expect.poll(()=>h.messages.filter(m=>m.type==='live').length).toBe(3);expect(h.messages.filter(m=>m.type==='live')[2].results.q.rows[0]).toEqual({oo:{name:''}});
 const invalid=delta(5,[{type:'set',path:'oo.name',value:'staged'}]);invalid.operations.push({type:'patch',index:0,key:id,changes:[{type:'set',path:'oo.status',value:{domain:'example.common.Status',code:1}}]});h.frame({type:'result',subscription:'q',acquisition:1,source_sequence:'5',result:invalid});await expect.poll(()=>h.messages.some(m=>m.type==='fatal')).toBe(true);expect(h.messages.filter(m=>m.type==='live')).toHaveLength(3);expect(JSON.stringify(old)).toBe(before);
 }finally{h.w.terminate()}});
it('production Worker refuses patches without negotiation',async()=>{const h=await harness(false);try{expect(h.hello.capabilities).not.toContain('selected_field_patches_v1');await open(h);h.frame({type:'result',subscription:'q',acquisition:1,source_sequence:'2',result:delta(2,[{type:'set',path:'oo.name',value:'new'}])});await expect.poll(()=>h.messages.some(m=>m.type==='fatal')).toBe(true);expect(h.messages.some(m=>m.type==='live')).toBe(false);}finally{h.w.terminate()}});
it('production generic Worker admits 2048 complete rows and rejects the 4096-row ceiling overflow',async()=>{
 const h=await harness();try{
  const request={type:'apply',id:1,acquisition:1,traceparent:'trace-1',command:{command:'open',subscription:'q',query:{topic:'shit',schema:catalog.shit.fingerprint,offset:0,limit:4096,select:raw().projection,order_by:[]}}};
  h.w.postMessage(request);await expect.poll(()=>h.messages.filter(m=>m.reviewWire).length).toBe(2);
  const keys=Array.from({length:2048},(_,i)=>'rid2:01010100000004'+Array.from(new TextEncoder().encode(String(i).padStart(4,'0')),byte=>byte.toString(16).padStart(2,'0')).join(''));
  const batch={...raw(),total_rows:2048,effectiveEnd:2048,keys,rows:keys.map((_,i)=>({oo:{name:`facet-${i}`,price:'0'}}))};
  h.frame({type:'result',id:1,traceparent:'trace-1',subscription:'q',acquisition:1,source_sequence:'1',result:batch});h.frame({type:'ack',id:1,traceparent:'trace-1',result_count:1});
  await expect.poll(()=>h.messages.some(m=>m.type==='ack'||m.type==='fatal')).toBe(true);expect(h.messages.find(m=>m.type==='fatal')).toBeUndefined();expect(h.messages.find(m=>m.type==='ack').results.q.rows).toHaveLength(2048);
  const overflowKeys=Array.from({length:4097},(_,i)=>'rid2:01010100000004'+Array.from(new TextEncoder().encode(String(i).padStart(4,'0')),byte=>byte.toString(16).padStart(2,'0')).join(''));
  h.frame({type:'result',subscription:'q',acquisition:1,source_sequence:'2',result:{...batch,version:2,revision:2,sequence:2,contentVersion:2,total_rows:4097,effectiveEnd:4097,keys:overflowKeys,rows:overflowKeys.map(()=>({oo:{name:'overflow',price:'0'}}))}});
  await expect.poll(()=>h.messages.some(m=>m.type==='fatal')).toBe(true);expect(h.messages.some(m=>m.type==='live')).toBe(false);
 }finally{h.w.terminate();}
});
