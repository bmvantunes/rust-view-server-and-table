import {encode as mpEncode,decode as mpDecode,ExtensionCodec} from '@msgpack/msgpack';
import {preflight,MAX_FRAME,MAX_EXACT,MAX_DEPTH,MAX_COLLECTION} from './scan.mjs';
import {Exact,prepare,adaptValue} from './values.mjs';
const ext=new ExtensionCodec();ext.register({type:42,encode:x=>x instanceof Exact?x.bytes:null,decode:b=>new Exact(b)});
export function encodePrepared(value){const b=mpEncode(value,{extensionCodec:ext,maxDepth:MAX_DEPTH+1,useBigInt64:false});if(b.length>MAX_FRAME)throw Error('frame budget');return b;}
export function encode(value){return encodePrepared(prepare(value));}
export function decodeNative(bytes){preflight(bytes,'msgpack');return mpDecode(bytes,{extensionCodec:ext,useBigInt64:false,maxStrLength:MAX_FRAME,maxBinLength:MAX_FRAME,maxArrayLength:MAX_COLLECTION,maxMapLength:MAX_COLLECTION,maxExtLength:MAX_EXACT+1});}
export function adapt(value){return adaptValue(value);}
export function decode(bytes){return adapt(decodeNative(bytes));}

// Explicit v15 scalar mode; v14 preparation/adaptation remains strict and unchanged.
function genericValue(value,d=0,state={n:0}){
 if(d>MAX_DEPTH||++state.n>65536)throw Error('depth/value budget');
 if(value===null||typeof value==='boolean')return value;
 if(typeof value==='number'){if(!Number.isFinite(value))throw Error('finite number');return value===0?0:value;}
 if(typeof value==='string'){if(!value.isWellFormed())throw Error('UTF-8 scalar');return value;}
 if(Array.isArray(value)){if(value.length>MAX_COLLECTION)throw Error('collection');return value.map(v=>genericValue(v,d+1,state));}
 if(value&&typeof value==='object'&&!(value instanceof Uint8Array)&&!(value instanceof Exact)){const entries=Object.entries(value);if(entries.length>MAX_COLLECTION)throw Error('collection');const result=Object.create(null);for(const[k,v]of entries){if(!k.isWellFormed()||++state.n>65536)throw Error('map key/value bound');result[k]=genericValue(v,d+1,state);}return result;}
 throw Error('unsupported generic scalar');
}
export function encodeGeneric(value){return encodePrepared(genericValue(value));}
export function decodeGeneric(bytes){preflight(bytes,'msgpack',true);return genericValue(mpDecode(bytes,{extensionCodec:ext,useBigInt64:false,maxStrLength:MAX_FRAME,maxBinLength:MAX_FRAME,maxArrayLength:MAX_COLLECTION,maxMapLength:MAX_COLLECTION,maxExtLength:MAX_EXACT+1}));}
