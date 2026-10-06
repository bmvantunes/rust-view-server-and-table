import type {BrowserProductProvider, ProductViewportWindow} from '@bruno/rust-view-server/react';
import type {Schema} from '@bruno/rust-view-server/schema';
import {compile,decodeRows} from './translate.ts';
import type {Chrome,CompatResult,Query,Viewport} from './types.ts';
export type ProviderPort=Pick<BrowserProductProvider,'watch'|'apply'|'deliveryGuard'|'connectionStatus'>;
type Listener=Parameters<ProviderPort['watch']>[2];
type Slot={closed:boolean;accepted:boolean;stop:()=>void;chrome:Chrome};
const loading:Chrome=Object.freeze({status:'loading',totalRows:0,version:0});
function windowCopy(w:ProductViewportWindow,whole=false):ProductViewportWindow{if(!Number.isSafeInteger(w.firstRow)||!Number.isSafeInteger(w.lastRow)||w.firstRow<0||w.lastRow<w.firstRow||w.lastRow-w.firstRow>=(whole?4096:1024)||w.lastRow>0xffff_ffff)throw Error('Bruno compatibility: viewport window bound');return Object.freeze({firstRow:w.firstRow,lastRow:w.lastRow});}
function message(error:unknown):string{return error instanceof Error?error.message:String(error);}
export function createController<S extends Schema>(provider:ProviderPort,topic:string,schema:S,fingerprint:string,id:string,changed:(value:Chrome)=>void,whole=false):Viewport<S>{
 let active:Slot|undefined,pending:Slot|undefined,sequence=0,destroyed=false;
 function close(slot:Slot|undefined){if(!slot||slot.closed)return;slot.closed=true;slot.stop();}
 return {
  semanticKey(query){return compile(schema,topic,fingerprint,query).key;},
  destroy(){if(destroyed)return;destroyed=true;const a=active,p=pending;active=pending=undefined;close(a);close(p);changed({...loading,status:'closed'});},
  replace<const Q extends Query<S>>(input:{query:Q;window:ProductViewportWindow;sink:{setRowCount(count:number,keepRenderedRows?:boolean):void;setRowData(rows:Readonly<{[index:number]:CompatResult<S,Q>}>,keys:Readonly<{[index:number]:string}>):void}}){
   if(destroyed)throw Error('Bruno compatibility: viewport destroyed');
   const compiled=compile(schema,topic,fingerprint,input.query);const initialWindow=windowCopy(input.window,whole);let requested:ProductViewportWindow|undefined=initialWindow;let windowRevision=0;
   const previousPending=pending;const slot:Slot={closed:false,accepted:false,stop(){},chrome:loading};pending=slot;close(previousPending);
   const subscription=`bruno:${id}:${++sequence}`;
   const valid=()=>!destroyed&&!slot.closed&&(active===slot||pending===slot);
   const reject=(error:unknown)=>{if(!valid()||error instanceof Error&&'code' in error&&(error.code==='transport_uncertain'||error.code==='read_superseded'))return;const prior=active?.chrome??loading;if(pending===slot){pending=undefined;close(slot);}changed({...prior,status:'error',message:message(error)});};
   const listener:Listener=(result)=>{
    const owns=provider.deliveryGuard(subscription,listener);if(!valid()||!owns())return;
    try{
     if(result.subscription!==subscription||!Number.isSafeInteger(result.start_rank)||!Number.isSafeInteger(result.total_rows)||result.start_rank<0||result.total_rows<0||result.rows.length>(whole?4096:1024)||result.start_rank+result.rows.length>Math.max(result.start_rank,result.total_rows))throw Error('Bruno compatibility: result window bounds');
     if(whole&&(result.start_rank!==0||result.rows.length!==result.total_rows))throw Error('Bruno compatibility: whole-result/facet exceeds bounded 4096 rows');
     const decoded=decodeRows<S,Q>(schema,compiled,result);const rows:{[index:number]:CompatResult<S,Q>}={},keys:{[index:number]:string}={};
     decoded.forEach((row,index)=>{rows[result.start_rank+index]=row;keys[result.start_rank+index]=row.rowId;});
     if(!valid()||!owns())return;
     if(pending===slot){const old=active;active=slot;pending=undefined;slot.accepted=true;close(old);}
     if(!valid()||!owns())return;
     input.sink.setRowCount(result.total_rows);
     if(!valid()||!owns())return;
     input.sink.setRowData(Object.freeze(rows),Object.freeze(keys));
     if(!valid()||!owns())return;
     slot.chrome=Object.freeze({status:'ready',totalRows:result.total_rows,version:result.version});changed(slot.chrome);
    }catch(error){reject(error);}
   };
   listener.onError=reject;
   listener.onStatus=status=>{if(!valid())return;slot.chrome=Object.freeze({...slot.chrome,status});if(active===slot&&!pending||pending===slot)changed(slot.chrome);};
   changed(loading);
   if(valid())try{const stop=provider.watch(subscription,{...compiled.wire,offset:initialWindow.firstRow,limit:initialWindow.lastRow-initialWindow.firstRow+1},listener);slot.stop=stop;if(slot.closed)stop();}catch(error){reject(error);}
   return {
    setWindow(next){if(!valid())return;const w=windowCopy(next,whole);if(w.firstRow===requested?.firstRow&&w.lastRow===requested?.lastRow)return;requested=w;const revision=++windowRevision;const owns=provider.deliveryGuard(subscription,listener,false);if(provider.connectionStatus!=='connected')input.sink.setRowData(Object.freeze({}),Object.freeze({}));if(!valid()||!owns()||revision!==windowRevision)return;void provider.apply({command:'change_window',subscription,offset:w.firstRow,limit:w.lastRow-w.firstRow+1}).catch(error=>{if(!valid()||!provider.deliveryGuard(subscription,listener,false)()||revision!==windowRevision||pending&&pending!==slot)return;if(error instanceof Error&&'code'in error&&(error.code==='transport_uncertain'||error.code==='read_superseded'))return;requested=undefined;reject(error);});},
    release(){if(slot.closed)return;const wasActive=active===slot,wasPending=pending===slot;if(wasActive)active=undefined;if(wasPending)pending=undefined;close(slot);if(!destroyed&&!active&&!pending)changed({...slot.chrome,status:'closed'});},
   };
  },
 };
}
