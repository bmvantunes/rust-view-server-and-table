import {MAX_FRAME,MAX_EXACT,MAX_DEPTH,MAX_VALUES,MAX_COLLECTION} from './scan.mjs';
const SAFE=9007199254740991n,U64=18446744073709551615n;
const exactKeys=new Set(['quantity','coefficient','source_sequence','connection','limit']);
function validString(s){for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const n=s.charCodeAt(++i);if(!(n>=0xdc00&&n<=0xdfff))throw Error('unpaired surrogate');}else if(c>=0xdc00&&c<=0xdfff)throw Error('unpaired surrogate');}return s;}
export function exactBytes(input){
 if(typeof input!=='string'||input.length===0||input.length>10001||!(/^(0|-?[1-9][0-9]*)$/).test(input))throw Error('canonical exact value required');
 let n=BigInt(input),negative=n<0n;if(negative)n=-n;const bytes=[];while(n){bytes.push(Number(n&255n));n>>=8n;}return Uint8Array.from([negative?1:0,...bytes.reverse()]);
}
export function exactBigInt(b){if(!(b instanceof Uint8Array)||b.length===0||b.length>MAX_EXACT+1||b[0]>1||b[1]===0||(b[0]===1&&b.length===1))throw Error('noncanonical exact');let n=0n;for(let i=1;i<b.length;i++)n=(n<<8n)|BigInt(b[i]);if(b[0])n=-n;if(n.toString().length>10001)throw Error('exact domain');return n;}
export class Exact{constructor(b){this.bytes=b;}}
function budget(d,state){if(d>MAX_DEPTH||++state.n>MAX_VALUES)throw Error('depth/value budget');}
export function prepare(input){
 const state={n:0};function go(v,key,d,parent){budget(d,state);if(v===null||typeof v==='boolean')return v;
 if(typeof v==='number'){if(!Number.isSafeInteger(v))throw Error('metadata safe integer');return v;}
 if(typeof v==='string'){validString(v);if(exactKeys.has(key)||(key==='value'&&parent==='quantity')){const b=exactBytes(v);if(['connection','source_sequence'].includes(key)){const n=exactBigInt(b);if(n<0n||n>U64)throw Error('u64 metadata');}return new Exact(b);}return v;}
 if(v instanceof Uint8Array)return v;
 if(Array.isArray(v)){if(v.length>MAX_COLLECTION)throw Error('collection');return v.map(x=>go(x,'',d+1,''));}
 if(v&&typeof v==='object'){const entries=Object.entries(v);if(entries.length>MAX_COLLECTION)throw Error('collection');const out=Object.create(null);for(const[k,x]of entries){budget(d+1,state);validString(k);out[k]=go(x,k,d+1,k==='condition'?v.field:parent);}return out;}
 throw Error('unsupported value');}return go(input,'',0,'');
}
export function adaptValue(v){const state={n:0};
 function go(x,key,d,parent){budget(d,state);if(exactKeys.has(key)||(key==='value'&&parent==='quantity')){if(!(x instanceof Exact))throw Error('exact variant required');}
 if(x instanceof Exact){const n=exactBigInt(x.bytes);if(['connection','source_sequence'].includes(key)&&(n<0n||n>U64))throw Error('u64 metadata');return n.toString();}
 if(x instanceof Uint8Array)return new Uint8Array(x.buffer,x.byteOffset,x.byteLength);
 if(typeof x==='number'){if(!Number.isSafeInteger(x))throw Error('metadata bounds');return x;}
 if(typeof x==='string')return validString(x);if(x===null||typeof x==='boolean')return x;
 if(Array.isArray(x)){if(x.length>MAX_COLLECTION)throw Error('collection');return x.map(y=>go(y,'',d+1,''));}
 if(x&&typeof x==='object'){const entries=Object.entries(x);if(entries.length>MAX_COLLECTION)throw Error('collection');const o={};for(const[k,y]of entries){budget(d+1,state);Object.defineProperty(o,k,{value:go(y,k,d+1,k==='condition'?x.field:parent),enumerable:true,writable:true,configurable:true});}
 if(Object.hasOwn(o,'coefficient')){if(!Number.isInteger(o.scale)||Math.abs(o.scale)>10000)throw Error('decimal scale');const n=BigInt(o.coefficient);if(n===0n?o.scale!==0:o.scale>-10000&&n%10n===0n)throw Error('noncanonical decimal');}return o;}
 throw Error('unsupported value');
 }return go(v,'',0,'');
}
