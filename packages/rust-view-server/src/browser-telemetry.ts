import {ROOT_CONTEXT,context,trace,SpanStatusCode,isSpanContextValid,type Tracer,type TracerProvider} from '@opentelemetry/api';
import {W3CTraceContextPropagator} from '@opentelemetry/core';
import {BasicTracerProvider,BatchSpanProcessor,TraceIdRatioBasedSampler} from '@opentelemetry/sdk-trace-base';
import {resourceFromAttributes} from '@opentelemetry/resources';
import {OTLPTraceExporter} from '@opentelemetry/exporter-trace-otlp-proto';
import type {ClientTelemetry,TraceOperation} from './product-provider';
export type BrowserTelemetryConfig={endpoint:string;sampleRatio?:number;maxSpansPerSecond?:number;deployment?:string};
const propagator=new W3CTraceContextPropagator();
const getter={keys:(c:Record<string,string>)=>Object.keys(c),get:(c:Record<string,string>,k:string)=>c[k]};
const setter={set:(c:Record<string,string>,k:string,v:string)=>{c[k]=v;}};
/** No registration of globals or host-page auto-instrumentation. Hosts may supply their own provider. */
export function createBrowserTelemetry(config:BrowserTelemetryConfig,runtime:'browser'|'worker'='browser',hostProvider?:TracerProvider):ClientTelemetry&{shutdown:()=>Promise<void>}{
 const url=new URL(config.endpoint);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error('invalid telemetry endpoint');
 const ratio=config.sampleRatio??0.1,maximum=config.maxSpansPerSecond??200;
 if(!Number.isFinite(ratio)||ratio<0||ratio>1||!Number.isSafeInteger(maximum)||maximum<0||maximum>1000||(config.deployment?.length??0)>64)throw Error('invalid telemetry limits');
 const sdk=hostProvider?undefined:new BasicTracerProvider({resource:resourceFromAttributes({'service.name':'view-server-'+runtime,'service.version':'runtime-health-v1','service.instance.id':crypto.randomUUID(),...(config.deployment?{'deployment.environment.name':config.deployment}:{})}),sampler:new TraceIdRatioBasedSampler(ratio),spanLimits:{attributeCountLimit:8,eventCountLimit:4,linkCountLimit:4},spanProcessors:[new BatchSpanProcessor(new OTLPTraceExporter({url:url.href,timeoutMillis:2000,concurrencyLimit:1}),{maxQueueSize:256,maxExportBatchSize:64,scheduledDelayMillis:500,exportTimeoutMillis:2000})]});
 const tracer:Tracer=(hostProvider??sdk!).getTracer('view-server','1');let count=0,since=performance.now();
 const api:ClientTelemetry&{shutdown:()=>Promise<void>}={workerConfig:{...config},
  start(name,parent,links=[]):TraceOperation|undefined{
   try{const now=performance.now();if(now-since>=1000){since=now;count=0;}if(count++>=maximum)return;
    const cx=parent&&parent.length===55?propagator.extract(ROOT_CONTEXT,{'traceparent':parent},getter):ROOT_CONTEXT;
    const contexts=links.slice(0,4).filter(p=>p.length===55).map(p=>trace.getSpanContext(propagator.extract(ROOT_CONTEXT,{'traceparent':p},getter))).filter(c=>c&&isSpanContextValid(c));
    const span=tracer.startSpan(name,{attributes:{'operation':name},links:contexts.map(c=>({context:c!}))},cx);
    const carrier:Record<string,string>={};propagator.inject(trace.setSpan(cx??context.active(),span),carrier,setter);
    let ended=false;return {context:carrier.traceparent,end(outcome='ok'){if(ended)return;ended=true;try{span.setAttribute('outcome',outcome);if(outcome!=='ok')span.setStatus({code:SpanStatusCode.ERROR});span.end();}catch{}}};
   }catch{return;}
  },
  async shutdown(){if(sdk)await Promise.race([sdk.shutdown().catch(()=>{}),new Promise<void>(resolve=>setTimeout(resolve,2500))]);}
 };return api;
}
