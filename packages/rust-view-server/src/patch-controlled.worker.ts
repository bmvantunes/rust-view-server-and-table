// Test-only controlled socket; imported Worker and codecs are production source.
let socket:any;
class ControlledSocket {static OPEN=1;readyState=1;bufferedAmount=0;onopen:any;onmessage:any;onerror:any;onclose:any;constructor(){socket=this;setTimeout(()=>this.onopen?.({}),0)}send(bytes:Uint8Array){self.postMessage({reviewWire:Array.from(bytes)})}close(){}}
Object.defineProperty(globalThis,'WebSocket',{value:ControlledSocket});
self.addEventListener('message',(e:MessageEvent)=>{if(e.data.reviewFrame){e.stopImmediatePropagation();socket.onmessage?.({data:new Uint8Array(e.data.reviewFrame).buffer})}});
await import('./product.remote.worker');
self.postMessage({reviewLoaded:true});
export {};
