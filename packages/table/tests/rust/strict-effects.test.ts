import {it,expect,vi} from 'vitest';
const state=vi.hoisted(()=>{const effects:Array<()=>void|(()=>void)>=[];return {effects};});
vi.mock('react',async()=>{const actual=await vi.importActual<typeof import('react')>('react');return {...actual,useId:()=>`strict-${state.effects.length}`,useMemo:(f:()=>unknown)=>f(),useEffect:(f:()=>void|(()=>void))=>{state.effects.push(f);},useState:(v:unknown)=>[v,()=>{}]};});
import {createBrunoTableHooks} from '../../src/rust/index.ts';
import {catalog} from '@bruno/view-server-client/generated/topics';
import type {ProviderPort} from '../../src/rust/controller.ts';
it('effect replay preserves viewport and independent whole hook, true unmount closes both next microtask',async()=>{
 const listeners=new Map<string,Parameters<ProviderPort['watch']>[2]>();
 const provider:ProviderPort={watch(id,_q,l){listeners.set(id,l);return()=>{if(listeners.get(id)===l)listeners.delete(id);};},deliveryGuard:(id,l)=>()=>listeners.get(id)===l,connectionStatus:'connected',apply:async()=>({})};
 const source=createBrunoTableHooks({orders:catalog.orders}).useViewportSource(provider,'orders');source.useWholeResult({select:['units'],where:[],orderBy:[]});
 const first=state.effects.map(setup=>setup());for(const cleanup of first)cleanup?.();const final=state.effects.map(setup=>setup());await Promise.resolve();
 expect(()=>source.viewport.replace({query:{select:['units'],where:[],orderBy:[]},window:{firstRow:0,lastRow:0},sink:{setRowCount(){},setRowData(){}}})).not.toThrow();expect(listeners.size).toBe(2);
 for(const cleanup of final)cleanup?.();await Promise.resolve();expect(listeners.size).toBe(0);
});
