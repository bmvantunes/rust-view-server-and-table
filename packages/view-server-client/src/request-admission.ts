// Admission-only WASM: shares native product types, never creates or runs ProductEngine.
type Admission = WebAssembly.Exports & {
  memory:WebAssembly.Memory;
  admission_alloc(n:number):number;
  admission_dealloc(p:number,n:number):void;
  admission_run(p:number,n:number):number;
  admission_ptr(p:number):number;
  admission_len(p:number):number;
  admission_free(p:number):void;
};
let admission:Admission;
export async function initializeAdmission():Promise<void>{
  const response=await fetch('/request_admission.wasm');
  if(!response.ok)throw Error('request admission unavailable');
  admission=(await WebAssembly.instantiate(await response.arrayBuffer(),{})).instance.exports as Admission;
}
export function admitEnvelope(value:unknown):unknown{
  const bytes=new TextEncoder().encode(JSON.stringify(value));
  if(bytes.length>65536)throw Error('source frame budget');
  const p=admission.admission_alloc(bytes.length);if(!p)throw Error('admission allocation failed');
  let result=0;
  try{
    new Uint8Array(admission.memory.buffer,p,bytes.length).set(bytes);
    result=admission.admission_run(p,bytes.length);if(!result)throw Error('admission failed');
    const output=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(new Uint8Array(admission.memory.buffer,admission.admission_ptr(result),admission.admission_len(result))));
    if(output.terminal)throw Error(output.terminal);
    return output.value;
  }finally{if(result)admission.admission_free(result);admission.admission_dealloc(p,bytes.length);}
}
