import { describe, it, expect, vi } from 'vite-plus/test';
import { CompleteClient } from './complete-client';
const schema={format:2,id:'test_v2',version:2,key:'rowId',fields:[{name:'value',kind:'string',optional:false,nullable:false}]} as const;
const rowId='rid2:0101010000000161';
describe('complete acquisition',()=>{
 it('keeps partial bootstrap hidden and incorporates a concurrent replacement before ready',()=>{
  vi.useFakeTimers();const sent:any[]=[];const seen:any[]=[];const client=new CompleteClient('same',schema,'fp',m=>sent.push(m),m=>seen.push(m));
  client.start();const acquisition=sent[0].acquisition;
  const frame=(sequence:number,kind:string,rows:any[]=[],mutations:any[]=[])=>({type:'complete',acquisition,topic:'same',sequence,kind,rows,mutations,cut:{source_sequence:String(sequence)}});
  client.receive(frame(1,'snapshot',[{rowId,value:'before'}]));expect(seen.at(-1).status).toBe('loading');expect(seen.at(-1).rows).toEqual([]);
  vi.advanceTimersByTime(0);expect(sent.at(-1).acknowledged).toBe(1);
  client.receive(frame(2,'tail',[],[{kind:'upsert',row:{rowId,value:'after'}}]));vi.advanceTimersByTime(0);
  client.receive(frame(3,'complete'));expect(seen.at(-1).rows).toEqual([{rowId,value:'after'}]);expect(seen.at(-1).status).toBe('ready');
  client.dispose();expect(vi.getTimerCount()).toBe(0);vi.useRealTimers();
 });
 it('rejects duplicate chunks and cancels the acquisition',()=>{
  vi.useFakeTimers();const sent:any[]=[];const seen:any[]=[];const client=new CompleteClient('same',schema,'fp',m=>sent.push(m),m=>seen.push(m));client.start();
  client.receive({type:'complete',acquisition:sent[0].acquisition,topic:'same',sequence:2,kind:'snapshot',rows:[],mutations:[]});
  expect(seen.at(-1).status).toBe('error');expect(sent.at(-1).type).toBe('complete_cancel');client.dispose();expect(vi.getTimerCount()).toBe(0);vi.useRealTimers();
 });
 it('invalidates old callbacks across reacquisition',()=>{
  vi.useFakeTimers();const sent:any[]=[];const seen:any[]=[];const client=new CompleteClient('same',schema,'fp',m=>sent.push(m),m=>seen.push(m));client.start();const old=sent[0].acquisition;client.lost();client.start();
  client.receive({type:'complete',acquisition:old,topic:'same',sequence:1,kind:'complete',rows:[],mutations:[]});expect(seen.at(-1).status).toBe('loading');client.dispose();expect(vi.getTimerCount()).toBe(0);vi.useRealTimers();
 });
 it('cancels expired acquisitions, ignores late frames, and exhausts bounded retries',()=>{
  vi.useFakeTimers();const sent:any[]=[];const seen:any[]=[];const client=new CompleteClient('same',schema,'fp',m=>sent.push(m),m=>seen.push(m));client.start();const first=sent[0].acquisition;
  vi.advanceTimersByTime(10000);expect(seen.at(-1).status).toBe('error');expect(sent.at(-1)).toMatchObject({type:'complete_cancel',acquisition:first});
  const late={type:'complete',acquisition:first,topic:'same',sequence:1,kind:'complete',rows:[],mutations:[]};client.receive(late);expect(seen.at(-1).status).toBe('error');
  vi.advanceTimersByTime(500);expect(sent.at(-1).type).toBe('complete_open');expect(sent.at(-1).acquisition).not.toBe(first);client.receive(late);expect(seen.at(-1).status).toBe('loading');
  vi.advanceTimersByTime(10000+500+10000+500+10000);expect(seen.at(-1).status).toBe('error');expect(sent.filter(m=>m.type==='complete_open')).toHaveLength(4);expect(vi.getTimerCount()).toBe(0);client.dispose();vi.useRealTimers();
 });

 it('observer disposal cannot schedule a later credit',()=>{
  vi.useFakeTimers();const sent:any[]=[];let client:CompleteClient<typeof schema>;client=new CompleteClient('same',schema,'fp',m=>sent.push(m),snapshot=>{if(snapshot.status==='ready')client.dispose();});client.start();
  client.receive({type:'complete',acquisition:sent[0].acquisition,topic:'same',sequence:1,kind:'complete',rows:[],mutations:[]});expect(vi.getTimerCount()).toBe(0);vi.useRealTimers();
 });

});
