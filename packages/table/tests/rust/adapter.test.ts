import {describe,it,expect} from 'vitest';
import * as BigDecimal from 'effect/BigDecimal';
import {catalog} from '@bruno/view-server-client/generated/topics';
import {compile,decodeRows,completeSelect,decodeCompleteRows,encodeCompatRow} from '../../src/rust/translate.ts';
import {createController,type ProviderPort} from '../../src/rust/controller.ts';
import type {ProductResult,ConnectionStatus} from '@bruno/view-server-client/react';
const entry=catalog.orders;
const raw={select:['units','price'],where:[],orderBy:[{field:'units',direction:'asc'}]} as const;
const c=(query:unknown)=>compile(entry.schema,'orders',entry.fingerprint,query);
function result(subscription:string,rows:readonly unknown[],keys:readonly string[],start=0,total=rows.length):ProductResult{const out:ProductResult={subscription,query_generation:1,sequence:1,start_rank:start,version:1,total_rows:total,rows:[],keys:[...keys]};Reflect.set(out,'rows',rows);return out;}
class Fake implements ProviderPort{
 connectionStatus:ConnectionStatus='connected';
 readonly listeners=new Map<string,Parameters<ProviderPort['watch']>[2]>();readonly commands:unknown[]=[];closed:string[]=[];
 watch:ProviderPort['watch']=(id,_q,listener)=>{this.listeners.set(id,listener);return()=>{if(this.listeners.get(id)===listener)this.listeners.delete(id);this.closed.push(id);listener.onStatus?.('closed');};};
 apply:ProviderPort['apply']=async command=>{this.commands.push(command);return {};};
 deliveryGuard:ProviderPort['deliveryGuard']=(id,listener)=>()=>this.listeners.get(id)===listener;
 push(id:string,r:ProductResult){this.listeners.get(id)?.(r);}
 ids(){return [...this.listeners.keys()];}
}
describe('exact admission and conversion',()=>{
 it('normalizes mathematical Decimal identity and property order without changing bigint',()=>{
  const a=c({...raw,where:[{field:'price',type:'equals',filter:BigDecimal.make(10n,1)}]});
  const b=c({where:[{type:'equals',filter:BigDecimal.make(1n,0),field:'price'}],orderBy:raw.orderBy,select:raw.select});expect(a.key).toBe(b.key);expect(a.wire.where).toEqual({op:'eq',field:'price',value:'1'});
 });
 it('uses exact bigint/Decimal rows and authoritative immutable identities',()=>{
  const compiled=c(raw),before={units:'9007199254740993',price:'1234567890123456789.0001'};const rows=decodeRows<typeof entry.schema,typeof raw>(entry.schema,compiled,result('x',[before],['rid2:authoritative']));expect(rows[0].units).toBe(9007199254740993n);expect(BigDecimal.format(rows[0].price)).toBe(before.price);expect(rows[0].rowId).toBe('rid2:authoritative');expect(Object.isFrozen(rows[0])).toBe(true);expect(before.units).toBe('9007199254740993');
 });
 it('maps actual table internal aliases without changing authoritative group IDs',()=>{
  const q={groupBy:['open'],aggregates:{__bruno_table_rows:{aggFunc:'count'},__bruno_table_aggregate_706f73:{aggFunc:'sum',field:'price'}},where:[],orderBy:[{aggregate:'__bruno_table_rows',direction:'desc'}]} as const;const compiled=c(q);expect(compiled.aliases.map(a=>a.native)).toEqual(['compatAgg0','compatAgg1']);const wireRow=Object.fromEntries([['open',true],...compiled.aliases.map(a=>[a.native,a.op==='count'?'3':'12.01'])]);const rows=decodeRows<typeof entry.schema,typeof q>(entry.schema,compiled,result('g',[wireRow],['gid1:unchanged']));expect(rows[0].rowId).toBe('gid1:unchanged');expect(rows[0].__bruno_table_rows).toBe(3n);expect(BigDecimal.format(rows[0].__bruno_table_aggregate_706f73)).toBe('12.01');
 });
 it('preserves Match None, empty IN and numeric notEqual absence semantics',()=>{
  for(const filter of [{type:'FALSE'},{field:'units',type:'in',filter:[]}]){const compiled=c({...raw,where:[filter]});expect(JSON.stringify(compiled.query.where)).toContain('"op":"not"');expect(JSON.stringify(compiled.query.where)).toContain('"op":"is_value"');}
  expect(c({...raw,where:[{field:'units',type:'notEqual',filter:1n}]}).wire.where).toEqual({op:'not',clause:{op:'eq',field:'units',value:'1'}});
  const blank=c({...raw,where:[{field:'note',type:'blank'}]});expect(JSON.stringify(blank.wire.where)).toContain('is_missing');expect(JSON.stringify(blank.wire.where)).toContain('is_null');expect(JSON.stringify(blank.wire.where)).toContain('"value":""');
 });
 it('admits verified profile text, ordering and averages and rejects malformed transport operands',()=>{
  for(const q of [{...raw,where:[{field:'customer',type:'contains',filter:'école',caseSensitive:true,accentSensitive:true}]},{...raw,orderBy:[{field:'customer',direction:'asc'}]},{...raw,orderBy:[{field:'note',direction:'asc'}]},{groupBy:['open'],aggregates:{a:{aggFunc:'avg',field:'price'}},where:[],orderBy:[]}]){expect(c(q).query.semanticProfile).toBe('effect-4.2.8');expect(c(q).wire.semantic_profile).toBe('effect-4.2.8');}
  expect(c({...raw,where:[{field:'customer',type:'contains',filter:'école',caseSensitive:true,accentSensitive:true}]}).wire.where).toEqual({op:'text',field:'customer',value:'école',match_kind:'contains',case_sensitive:true,accent_sensitive:true});
  for(const q of [{...raw,routeBy:{}},{...raw,where:[{field:'units',type:'equals',filter:9007199254740993}]},{...raw,where:[{field:'customer',type:'contains',filter:'x',caseSensitive:1}]}])expect(()=>c(q)).toThrow();
 });
 it('has complete catalog projection and validates malformed row/key pairing',()=>{expect(completeSelect(entry.schema)).toEqual(entry.schema.fields.map(f=>f.name));expect(()=>decodeRows(entry.schema,c(raw),result('x',[{units:'1',price:'2'}],[]))).toThrow();});
});
it('uses half-open bigint and Decimal ranges and canonical conjunction/IN equality',()=>{
 for(const [name,lo,hi] of [['units',1n,3n],['price',BigDecimal.fromStringUnsafe('1.1'),BigDecimal.fromStringUnsafe('3.3')]] as const){const q=c({...raw,where:[{field:name,type:'inRange',filter:lo,filterTo:hi}]});expect(q.wire.where).toMatchObject({op:'and',clauses:[{op:'ge'},{op:'lt'}]});}
 const one={field:'units',type:'equals',filter:1n},two={field:'open',type:'equals',filter:true};expect(c({...raw,where:[one,two]}).key).toBe(c({...raw,where:[{type:'AND',conditions:[two,one]}]}).key);expect(c({...raw,where:[{field:'units',type:'in',filter:[1n,2n,1n]}]}).key).toBe(c({...raw,where:[{field:'units',type:'in',filter:[2n,1n]}]}).key);
});
describe('bounded public provider ownership' ,()=>{
 it('keeps rejected replacement predecessor, swaps on acceptance and rejects stale callbacks',()=>{
  const p=new Fake(),events:unknown[]=[],chrome:unknown[]=[];const v=createController(p,'orders',entry.schema,entry.fingerprint,'one',s=>chrome.push(s));const sink={setRowCount:(n:number)=>events.push(n),setRowData:(r:unknown,k:unknown)=>events.push([r,k])};const a=v.replace({query:raw,window:{firstRow:0,lastRow:1},sink});const first=p.ids()[0],stale=p.listeners.get(first)!;p.push(first,result(first,[{units:'1',price:'7'}],['rid2:a']));
  const rejected=v.replace({query:{...raw,where:[{field:'units',type:'equals',filter:2n}]},window:{firstRow:0,lastRow:1},sink});const candidate=p.ids().find(k=>k!==first)!;p.listeners.get(candidate)?.onError?.(new Error('server admission rejected'));expect(p.ids()).toEqual([first]);expect(chrome.at(-1)).toMatchObject({status:'error'});rejected.release();expect(p.ids()).toEqual([first]);
  v.replace({query:raw,window:{firstRow:2,lastRow:3},sink});const accepted=p.ids().find(k=>k!==first)!;p.push(accepted,result(accepted,[{units:'3',price:'9'}],['rid2:c'],2,3));expect(p.ids()).toEqual([accepted]);const before=events.length;stale(result(first,[{units:'8',price:'8'}],['rid2:stale']));a.release();expect(events.length).toBe(before);expect(p.ids()).toEqual([accepted]);v.destroy();v.destroy();expect(p.ids()).toEqual([]);
 });
 it('delivers sparse row/key indices atomically and suppresses rows after reentrant count release',()=>{
  const p=new Fake(),v=createController(p,'orders',entry.schema,entry.fingerprint,'two',()=>{});let delivered=false;v.replace({query:raw,window:{firstRow:4,lastRow:5},sink:{setRowCount(){v.destroy();},setRowData(){delivered=true;}}});const id=p.ids()[0];p.push(id,result(id,[{units:'4',price:'1'}],['rid2:four'],4,6));expect(delivered).toBe(false);expect(p.ids()).toEqual([]);
 });
 it('uses independent controller subscriptions, invalidates offline windows, bounds facets and releases',()=>{
  const p=new Fake(),rows:unknown[]=[];const a=createController(p,'orders',entry.schema,entry.fingerprint,'a',()=>{}),b=createController(p,'orders',entry.schema,entry.fingerprint,'b',()=>{},true);const handle=a.replace({query:raw,window:{firstRow:0,lastRow:1},sink:{setRowCount(){},setRowData(r,k){rows.push([r,k]);}}});b.replace({query:raw,window:{firstRow:0,lastRow:1023},sink:{setRowCount(){},setRowData(){}}});expect(p.ids()).toHaveLength(2);p.connectionStatus='disconnected';handle.setWindow({firstRow:3,lastRow:4});expect(rows.at(-1)).toEqual([{},{}]);expect(p.commands).toHaveLength(1);a.destroy();expect(p.ids()).toHaveLength(1);b.destroy();expect(p.ids()).toHaveLength(0);
 });
});

class Queued extends Fake {readonly rejected:Array<(error:Error)=>void>=[];override apply:ProviderPort['apply']=command=>{this.commands.push(command);return new Promise((_resolve,reject)=>this.rejected.push(reject));};}
it('ignores an obsolete window rejection and permits retry after current rejection',async()=>{
 const p=new Queued(),statuses:string[]=[];const v=createController(p,'orders',entry.schema,entry.fingerprint,'reads',s=>statuses.push(s.status));const h=v.replace({query:raw,window:{firstRow:0,lastRow:1},sink:{setRowCount(){},setRowData(){}}});const id=p.ids()[0];p.push(id,result(id,[{units:'1',price:'1'}],['rid2:one'],0,20));h.setWindow({firstRow:2,lastRow:3});h.setWindow({firstRow:4,lastRow:5});p.push(id,result(id,[{units:'4',price:'1'}],['rid2:four'],4,20));p.rejected[0](new Error('obsolete'));await Promise.resolve();expect(statuses.at(-1)).toBe('ready');p.rejected[1](new Error('current rejected'));await Promise.resolve();expect(statuses.at(-1)).toBe('error');h.setWindow({firstRow:4,lastRow:5});expect(p.commands).toHaveLength(3);v.destroy();
});

it('formats exact Decimal operands as canonical plain notation across every admitted scale',()=>{
 const values=['0','0.123456789012345678','-0.123456789012345678','9007199254740993.123456789012345678','100000000000000000000','-100000000000000000000','0.'+'0'.repeat(127)+'1'];
 for(const expected of values){const operand=BigDecimal.fromStringUnsafe(expected);expect(c({...raw,where:[{field:'price',type:'equals',filter:operand}]}).wire.where).toEqual({op:'eq',field:'price',value:expected});}
 for(let scale=-128;scale<=128;scale++){const expected=scale<=0?'1'+'0'.repeat(-scale):'0.'+'0'.repeat(scale-1)+'1';expect(c({...raw,where:[{field:'price',type:'equals',filter:BigDecimal.make(1n,scale)}]}).wire.where).toEqual({op:'eq',field:'price',value:expected});}
 const eq=(operand:BigDecimal.BigDecimal)=>c({...raw,where:[{field:'price',type:'equals',filter:operand}]});
 expect(eq(BigDecimal.make(1234567890123456780n,19)).key).toBe(eq(BigDecimal.make(123456789012345678n,18)).key);
 expect(eq(BigDecimal.make(1000n,-18)).key).toBe(eq(BigDecimal.make(1n,-21)).key);
 expect(eq(BigDecimal.make(0n,-4096)).key).toBe(eq(BigDecimal.make(0n,4096)).key);
 const lo=BigDecimal.fromStringUnsafe('0.123456789012345678'),hi=BigDecimal.fromStringUnsafe('0.123456789012345679');
 expect(c({...raw,where:[{field:'price',type:'inRange',filter:lo,filterTo:hi}]}).wire.where).toEqual({op:'and',clauses:[{op:'ge',field:'price',value:'0.123456789012345678'},{op:'lt',field:'price',value:'0.123456789012345679'}]});
 for(const invalid of [BigDecimal.make(1n,129),BigDecimal.make(1n,-256),BigDecimal.make(1n,4097),BigDecimal.make(1n,-4097),BigDecimal.make(1n,1.5),BigDecimal.make(1n,NaN),BigDecimal.make(10n**4096n,0)])expect(()=>eq(invalid)).toThrow();
});

it('admits a complete 2048-row facet while keeping viewport transport bounded',()=>{
 const p=new Fake(),seen:number[]=[];const v=createController(p,'orders',entry.schema,entry.fingerprint,'facet',()=>{},true);
 v.replace({query:raw,window:{firstRow:0,lastRow:4095},sink:{setRowCount(n){seen.push(n);},setRowData(r){seen.push(Object.keys(r).length);}}});
 const id=p.ids()[0];p.push(id,result(id,Array.from({length:2048},(_,i)=>({units:String(i),price:'1'})),Array.from({length:2048},(_,i)=>'rid2:'+i)));expect(seen).toEqual([2048,2048]);v.destroy();
 const bounded=createController(p,'orders',entry.schema,entry.fingerprint,'viewport',()=>{});expect(()=>bounded.replace({query:raw,window:{firstRow:0,lastRow:2047},sink:{setRowCount(){},setRowData(){}}})).toThrow('window bound');bounded.destroy();
});
it('converts complete-source exact scalars once per immutable input object',()=>{
 const cache=new WeakMap();const input={rowId:'rid2:complete',orderId:'o',customer:'ÉCOLE',units:'9007199254740993',price:'0.123456789012345678',open:true};
 const first=decodeCompleteRows(entry.schema,[input],cache);const second=decodeCompleteRows(entry.schema,[input],cache);
 expect(first[0]).toBe(second[0]);expect(first[0].units).toBe(9007199254740993n);expect(first[0].price.value).toBe(123456789012345678n);expect(first[0].price.scale).toBe(18);expect(Object.hasOwn(first[0],'note')).toBe(false);
 const changed=decodeCompleteRows(entry.schema,[{...input,note:null}],cache);expect(changed[0]).not.toBe(first[0]);expect(changed[0].note).toBeNull();expect(Object.isFrozen(changed[0])).toBe(true);
});

it('supports normalized text set filters including strict flags, null and Match None',()=>{
 const q=c({...raw,where:[{field:'note',type:'in',filter:['école',null],caseSensitive:true,accentSensitive:true}]});
 expect(q.wire.where).toMatchObject({op:'or'});expect(JSON.stringify(q.wire.where)).toContain('"op":"is_null"');expect(JSON.stringify(q.wire.where)).toContain('"case_sensitive":true');
 expect(c({...raw,where:[{field:'customer',type:'in',filter:[]}]}).wire.where).toMatchObject({op:'and'});
});

it('round trips complete rows through library exact write codecs without leaking rowId',()=>{
 const input={rowId:'rid2:write',orderId:'order-000000',customer:'École',units:'9007199254740993',price:'0.123456789012345678',open:true};const row=decodeCompleteRows(entry.schema,[input],new WeakMap())[0]!;
 const encoded=encodeCompatRow(entry.schema,row);expect(encoded).toEqual({orderId:input.orderId,customer:input.customer,units:input.units,price:input.price,open:true});expect(Object.hasOwn(encoded,'rowId')).toBe(false);
 expect(encodeCompatRow(entry.schema,{...row,note:undefined})).toEqual(encoded);expect(encodeCompatRow(entry.schema,{...row,note:null})).toEqual({...encoded,note:null});
});
