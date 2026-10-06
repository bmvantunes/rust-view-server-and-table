import {validateRow, type Schema, type Row} from './topic-schema';
import {validRowId} from './row-id.mjs';
export type CompleteSnapshot<S extends Schema>={readonly status:'loading'|'ready'|'error';readonly rows:readonly (Row<S>&{readonly rowId:string})[];readonly loaded:number;readonly cut?:unknown;readonly error?:string};
export class CompleteClient<S extends Schema>{
 private retries=0;private acquisition='';private sequence=0;private complete=false;private stopped=false;private timer?:ReturnType<typeof setTimeout>;private deadline?:ReturnType<typeof setTimeout>;
 private bytes=0;private sizes=new Map<string,number>();
 private rows=new Map<string,Row<S>&{readonly rowId:string}>();
 constructor(private topic:string,private schema:S,private fingerprint:string,private send:(message:unknown)=>void,private notify:(snapshot:CompleteSnapshot<S>)=>void){}
 private emit(status:CompleteSnapshot<S>['status'],cut?:unknown,error?:string){try{this.notify({status,rows:status==='ready'?Object.freeze([...this.rows.values()]):[],loaded:this.rows.size,cut,error});}catch{/* Observer exceptions cannot strand credits or corrupt the stream. */}}
 start(){if(this.stopped)return;clearTimeout(this.timer);clearTimeout(this.deadline);this.rows.clear();this.sizes.clear();this.bytes=0;this.sequence=0;this.complete=false;this.acquisition=crypto.randomUUID().replaceAll('-','');this.emit('loading');this.request({type:'complete_open',acquisition:this.acquisition,topic:this.topic,schema:this.fingerprint});}
 private request(message:unknown){if(this.stopped)return;try{this.send(message);this.deadline=setTimeout(()=>this.error('Complete acquisition deadline; retry required'),10000);}catch(error){this.error(String(error));}}
 lost(){clearTimeout(this.timer);clearTimeout(this.deadline);this.acquisition='';this.rows.clear();this.sizes.clear();this.bytes=0;this.complete=false;this.emit('loading');}
 error(error:string){clearTimeout(this.timer);clearTimeout(this.deadline);const acquisition=this.acquisition;this.acquisition='';this.complete=false;if(acquisition)try{this.send({type:'complete_cancel',acquisition});}catch{}this.emit('error',undefined,error);if(!this.stopped&&this.retries++<3)this.timer=setTimeout(()=>this.start(),500);}
 receive(message:unknown):boolean{
  if(typeof message!=='object'||message===null||!('type'in message)||!['complete','complete_error'].includes(String(message.type)))return false;
  const m=message as Record<string,unknown>;if(m.acquisition!==this.acquisition||this.stopped)return true;clearTimeout(this.deadline);
  if(m.type==='complete_error'){this.error(String(m.error));return true;}if(m.kind==='cancelled')return true;
  try{if(m.topic!==this.topic||m.sequence!==this.sequence+1||!Array.isArray(m.rows)||!Array.isArray(m.mutations))throw Error('Complete stream sequence/shape');this.sequence++;
   for(const row of m.rows)this.upsert(row,true);
   for(const mutation of m.mutations){if(typeof mutation!=='object'||!mutation)throw Error('Complete mutation');if(mutation.kind==='upsert')this.upsert(mutation.row,false);else if(mutation.kind==='delete'&&typeof mutation.key==='string'&&validRowId(mutation.key)){this.rows.delete(mutation.key);this.bytes-=this.sizes.get(mutation.key)??0;this.sizes.delete(mutation.key);}else throw Error('Complete mutation kind');}
   if(m.kind==='tail')this.complete=false;
   if(m.kind==='complete'){this.complete=true;this.retries=0;}
   if(m.kind==='snapshot'||m.kind==='complete')this.emit(this.complete?'ready':'loading',m.cut);
   if(this.stopped||m.acquisition!==this.acquisition)return true;
   this.timer=setTimeout(()=>this.request({type:'complete_next',acquisition:this.acquisition,acknowledged:this.sequence}),m.kind==='idle'?100:0);
  }catch(error){this.error(String(error));}return true;
 }
 private upsert(value:unknown,snapshot:boolean){if(typeof value!=='object'||value===null||!('rowId'in value)||typeof value.rowId!=='string'||!validRowId(value.rowId))throw Error('Complete row identity');
  const {rowId,...payload}=value;validateRow(this.schema,payload);
  if(snapshot&&this.rows.has(rowId))throw Error('Duplicate snapshot row');if(!this.rows.has(rowId)&&this.rows.size>=250000)throw Error('Complete client row budget');
  const size=new TextEncoder().encode(JSON.stringify(value)).length;this.bytes+=size-(this.sizes.get(rowId)??0);if(this.bytes>128*1024*1024)throw Error("Complete client byte budget");this.sizes.set(rowId,size);
  const row=structuredClone(payload);Object.defineProperty(row,'rowId',{value:rowId,enumerable:true,writable:false,configurable:false});this.rows.set(rowId,Object.freeze(row) as Row<S>&{readonly rowId:string});
 }
 dispose(){if(this.stopped)return;this.stopped=true;clearTimeout(this.timer);clearTimeout(this.deadline);if(this.acquisition)try{this.send({type:'complete_cancel',acquisition:this.acquisition});}catch{}this.rows.clear();this.sizes.clear();this.bytes=0;}
}
