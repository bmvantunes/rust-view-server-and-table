/** Validate the canonical native typed-tuple identity; no per-render ID generation. */
export function validRowId(id){
 if(typeof id!=='string'||id.length>512||!/^rid2:(?:[0-9a-f]{2})+$/.test(id))return false;
 const b=Uint8Array.from(id.slice(5).match(/../g),s=>parseInt(s,16));
 if(b[0]!==1||!b[1]||b[1]>16)return false;
 const view=new DataView(b.buffer);let p=2;
 try{for(let i=0;i<b[1];i++){
  if(p+5>b.length)return false;const type=b[p++],len=view.getUint32(p);p+=4;if(p+len>b.length)return false;const start=p;p+=len;
  if(type===1){new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(b.subarray(start,p));}
  else if(type===2){if(len!==1||b[start]>1)return false;}
  else if(type===3){if(len!==8)return false;const n=view.getFloat64(start);if(!Number.isFinite(n)||Object.is(n,-0))return false;}
  else if(type===4||type===5){if(len!==8)return false;}
  else if(type===6){const s=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(b.subarray(start,p));if(s.length>256||!/^(?:0|-?(?:[1-9][0-9]*|0)(?:\.[0-9]*[1-9])?)$/.test(s)||s==='-0'||(s.split('.')[1]?.length??0)>128)return false;}
  else return false;
 }return p===b.length;}catch{return false;}
}
