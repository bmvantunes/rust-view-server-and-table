import {beforeEach,it,expect,vi} from 'vitest';
const state=vi.hoisted(()=>{const effects:Array<()=>void|(()=>void)>=[];const updates:unknown[]=[];return {effects,updates};});
vi.mock('react',async()=>{const actual=await vi.importActual<typeof import('react')>('react');return {...actual,useId:()=>`strict-${state.effects.length}`,useMemo:(f:()=>unknown)=>f(),useEffect:(f:()=>void|(()=>void))=>{state.effects.push(f);},useState:(v:unknown)=>[v,(next:unknown)=>{state.updates.push(next);}]};});
import {BrunoTableCreateRustHooks} from '../../src/rust/index.ts';
import {catalog} from '@bruno/view-server-client/generated/topics';
import type {ProviderPort} from '../../src/rust/controller.ts';
import type {BrowserProductProvider} from '@bruno/view-server-client/react';
beforeEach(()=>{state.effects.length=0;state.updates.length=0;});
it('effect replay preserves viewport and independent whole hook, true unmount closes both next microtask',async()=>{
 const listeners=new Map<string,Parameters<ProviderPort['watch']>[2]>();
 const provider:ProviderPort={watch(id,_q,l){listeners.set(id,l);return()=>{if(listeners.get(id)===l)listeners.delete(id);};},deliveryGuard:(id,l)=>()=>listeners.get(id)===l,connectionStatus:'connected',apply:async()=>({})};
 const source=BrunoTableCreateRustHooks({orders:catalog.orders}).useViewportSource(provider,'orders');source.useWholeResult({select:['units'],where:[],orderBy:[]});
 const first=state.effects.map(setup=>setup());for(const cleanup of first)cleanup?.();const final=state.effects.map(setup=>setup());await Promise.resolve();
 expect(()=>source.viewport.replace({query:{select:['units'],where:[],orderBy:[]},window:{firstRow:0,lastRow:0},sink:{setRowCount(){},setRowData(){}}})).not.toThrow();expect(listeners.size).toBe(2);
 for(const cleanup of final)cleanup?.();await Promise.resolve();expect(listeners.size).toBe(0);
});

it('complete-source replay owns one subscription and ignores deliveries after each cleanup',()=>{
 const deliveries:Array<()=>void>=[];
 const active=new Set<()=>void>();let stopped=0;
 const provider:Pick<BrowserProductProvider,'watchComplete'>={watchComplete(_topic,_schema,_fingerprint,listener){
  const deliver=()=>listener({status:'ready',rows:[],loaded:0});deliveries.push(deliver);active.add(deliver);
  return()=>{stopped++;active.delete(deliver);};
 }};
 BrunoTableCreateRustHooks({orders:catalog.orders}).useCompleteSource(provider,'orders');
 const setup=state.effects[0]!;
 const first=setup();deliveries[0]!();
 expect(state.updates.at(-1)).toMatchObject({owner:{provider,topic:'orders'},value:{status:'ready',rows:[],loaded:0,totalRows:0,version:1}});
 first?.();const replay=setup();expect(active.size).toBe(1);
 const before=state.updates.length;deliveries[0]!();expect(state.updates).toHaveLength(before);
 deliveries[1]!();expect(state.updates.at(-1)).toMatchObject({value:{status:'ready',version:1}});
 replay?.();expect(active.size).toBe(0);expect(stopped).toBe(2);
 const settled=state.updates.length;deliveries[1]!();expect(state.updates).toHaveLength(settled);
});

it('failed complete-source admission fences retained callbacks and returns harmless cleanup',()=>{
 const deliveries:Array<()=>void>=[];
 const provider:Pick<BrowserProductProvider,'watchComplete'>={watchComplete(_topic,_schema,_fingerprint,listener){
  deliveries.push(()=>listener({status:'ready',rows:[],loaded:0}));
  throw Error('complete admission rejected');
 }};
 BrunoTableCreateRustHooks({orders:catalog.orders}).useCompleteSource(provider,'orders');
 const setup=state.effects[0]!;
 for(let replay=0;replay<2;replay++){
  const cleanup=setup();
  expect(state.updates.at(-1)).toMatchObject({owner:{provider,topic:'orders'},value:{status:'error',rows:[],loaded:0,totalRows:0,version:0,error:'complete admission rejected'}});
  const before=state.updates.length;deliveries[replay]!();expect(state.updates).toHaveLength(before);
  expect(()=>{cleanup?.();cleanup?.();}).not.toThrow();
 }
 const settled=state.updates.length;deliveries.forEach(deliver=>deliver());expect(state.updates).toHaveLength(settled);
});
