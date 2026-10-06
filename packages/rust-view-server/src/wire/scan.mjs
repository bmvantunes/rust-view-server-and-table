export const MAX_FRAME=4194304,MAX_VALUES=65536,MAX_COLLECTION=8192,MAX_DEPTH=128,MAX_EXACT=4154;
const utf8=new TextDecoder('utf-8',{fatal:true});
export function preflight(bytes,codec,finiteFloats=false){
 if(!(bytes instanceof Uint8Array)||bytes.length===0||bytes.length>MAX_FRAME)throw Error('frame budget');
 let p=0,count=0;
 const take=n=>{if(!Number.isSafeInteger(n)||n<0||n>bytes.length-p)throw Error('truncated length');const s=bytes.subarray(p,p+n);p+=n;return s;};
 const byte=()=>take(1)[0];const be=n=>{let v=0n;for(const b of take(n))v=v*256n+BigInt(b);return v;};
 const variable=()=>{let v=0n;for(let i=0;i<10;i++){const b=byte();if(i===9&&b>1)throw Error('varint overflow');v|=BigInt(b&127)<<BigInt(i*7);if(b<128){if(i>0&&b===0)throw Error('overlong varint');return v;}}throw Error('varint');};
 const length=()=>{const n=variable();if(n>BigInt(bytes.length-p))throw Error('declared length');return Number(n);};
 const budget=d=>{if(d>MAX_DEPTH||++count>MAX_VALUES)throw Error('depth/value budget');};
 const text=n=>utf8.decode(take(n));
 function pb(end,kind,d){
  if(kind===0)budget(d);else if(kind===3)budget(d+1);let seen=0,n=0;
  while(p<end){const tag=variable();if(tag>127n)throw Error('unknown field');const f=Number(tag>>3n),wire=Number(tag&7n);
   if(kind===0){if(f<1||f>8||seen)throw Error('unknown/conflicting variant');seen=1;
    if(f<=3){if(wire!==0)throw Error('wire type');const v=variable();if(f<=2&&v>1n)throw Error('bool');}
    else{if(wire!==2)throw Error('wire type');const len=length(),stop=p+len;if(stop>end)throw Error('submessage length');
     if(f===4)text(len);else if(f===5)take(len);else if(f===8){if(len>MAX_EXACT+1)throw Error('exact bytes');take(len);}else pb(stop,f===6?1:2,d);}
   }else if(kind===1||kind===2){if(f!==1||wire!==2||++n>MAX_COLLECTION)throw Error('repeated field/count');const len=length(),stop=p+len;if(stop>end)throw Error('submessage length');pb(stop,kind===1?0:3,kind===1?d+1:d);
   }else{if(f<1||f>2||wire!==2||(seen&(1<<f)))throw Error('entry field');seen|=1<<f;const len=length(),stop=p+len;if(stop>end)throw Error('submessage length');if(f===1)text(len);else pb(stop,0,d+1);}
   if(p>end)throw Error('submessage boundary');
  }
  if(p!==end||(kind===0&&!seen)||(kind===3&&!(seen&4)))throw Error('missing variant/value');
 }
 function mp(d,key=false){budget(d);const c=byte();if(key&&!((c>=0xa0&&c<=0xbf)||[0xd9,0xda,0xdb].includes(c)))throw Error('map key type');
  if(c<=0x7f||c>=0xe0||[0xc0,0xc2,0xc3].includes(c))return;
  if([0xcc,0xcd,0xce,0xcf,0xd0,0xd1,0xd2,0xd3].includes(c)){const signed=c>=0xd0,n=2**(c-(signed?0xd0:0xcc));const raw=be(n),v=signed&&raw>>(BigInt(n*8-1))?raw-(1n<<BigInt(n*8)):raw;
   if(signed?(v>=-32n||(n>1&&v>=-(1n<<BigInt((n/2)*8-1)))):(v<(n===1?128n:1n<<BigInt(n/2*8))))throw Error('overlong integer');if(finiteFloats&&(v< -9007199254740991n||v>9007199254740991n))throw Error('safe integer marker');return;}
  if(finiteFloats&&c===0xcb){const b=take(8);if(!Number.isFinite(new DataView(b.buffer,b.byteOffset,8).getFloat64(0)))throw Error('nonfinite number');return;}
  if(c>=0xa0&&c<=0xbf){text(c&31);return;}
  if([0xd9,0xda,0xdb,0xc4,0xc5,0xc6].includes(c)){const str=c>=0xd9,width=2**(c-(str?0xd9:0xc4)),len=Number(be(width));if((str&&width===1&&len<32)||(width>1&&len<2**(width/2*8)))throw Error('overlong length');if(str)text(len);else take(len);return;}
  if([0xc7,0xc8,0xc9,0xd4,0xd5,0xd6,0xd7,0xd8].includes(c)){const len=c>=0xd4?2**(c-0xd4):Number(be(2**(c-0xc7)));if(len>MAX_EXACT+1)throw Error('extension length');if(byte()!==42)throw Error('extension id');if(c<0xd4&&[1,2,4,8,16].includes(len))throw Error('overlong ext');if(c===0xc8&&len<256||c===0xc9&&len<65536)throw Error('overlong ext');take(len);return;}
  if(c>=0x80&&c<=0x9f||[0xdc,0xdd,0xde,0xdf].includes(c)){const map=c<=0x8f||c>=0xde,len=c<0xa0?c&15:Number(be(c===0xdc||c===0xde?2:4));if(c>=0xdc&&(len<16||([0xdd,0xdf].includes(c)&&len<65536)))throw Error('overlong collection');if(len>MAX_COLLECTION||len*(map?2:1)>bytes.length-p)throw Error('collection length');const keys=new Set();for(let i=0;i<len;i++){if(map){const start=p;mp(d+1,true);const keybytes=bytes.subarray(start,p);let off=keybytes[0]<=0xbf?1:keybytes[0]===0xd9?2:keybytes[0]===0xda?3:5;const k=utf8.decode(keybytes.subarray(off));if(keys.has(k))throw Error('duplicate key');keys.add(k);}mp(d+1);}return;}
  throw Error('unsupported marker/float');
 }
 if(codec==='protobuf')pb(bytes.length,0,0);else if(codec==='msgpack')mp(0);else throw Error('codec');if(p!==bytes.length)throw Error('trailing bytes');
}
