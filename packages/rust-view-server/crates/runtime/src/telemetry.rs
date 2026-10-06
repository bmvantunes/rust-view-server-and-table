//! One application-owned OTel meter provider and trace provider. No globals.
use opentelemetry::{metrics::{MeterProvider, Counter, Histogram}, KeyValue, propagation::TextMapPropagator, trace::TracerProvider};
use opentelemetry_sdk::{Resource, metrics::{SdkMeterProvider,PeriodicReader}, trace::{SdkTracerProvider,BatchSpanProcessor,BatchConfigBuilder,Sampler}, propagation::TraceContextPropagator};
use opentelemetry_otlp::{WithExportConfig,WithHttpConfig};
use prometheus::Encoder;
use serde::Deserialize;
use std::{collections::HashMap,sync::{Arc,Mutex,Weak},time::{Duration,Instant}};
use tracing_opentelemetry::OpenTelemetrySpanExt;
use tracing_subscriber::prelude::*;
use crate::health::Health;
pub const SCOPE:&str="view-server";
pub const LATENCY_BUCKETS:&[f64]=&[0.001,0.005,0.01,0.05,0.1,0.5,1.,5.,30.,120.];
#[derive(Clone,Debug,Deserialize)]
#[serde(default,deny_unknown_fields)]
pub struct Config { pub enabled:bool,pub otlp_endpoint:Option<String>,pub trace_sample_ratio:f64,pub max_spans_per_second:u32,pub deployment:Option<String> }
impl Default for Config{fn default()->Self{Self{enabled:true,otlp_endpoint:None,trace_sample_ratio:0.1,max_spans_per_second:1000,deployment:None}}}
impl Config{pub fn validate(&self)->Result<(),String>{if !self.trace_sample_ratio.is_finite()||!(0.0..=1.0).contains(&self.trace_sample_ratio)||self.max_spans_per_second>10000||self.deployment.as_ref().is_some_and(|s|s.len()>64)||self.otlp_endpoint.as_ref().is_some_and(|s|s.len()>2048||!(s.starts_with("http://")||s.starts_with("https://"))||s.contains('@')||s.contains('?')||s.contains('#')){return Err("invalid bounded telemetry configuration".into());}Ok(())}}
pub struct Telemetry {
    pub meter_provider:SdkMeterProvider,pub trace_provider:SdkTracerProvider,
    registry:prometheus::Registry, pub dispatch:tracing::Dispatch,
    enabled:bool, tracing_enabled:bool, max_spans:u32, limiter:Mutex<(Instant,u32)>,
    backpressure:Counter<u64>, records:Counter<u64>, maintenance_transactions:Counter<u64>, maintenance_evicted:Counter<u64>, failures:Counter<u64>, operations:Counter<u64>, callbacks:Counter<u64>, callback_failures:Counter<u64>,
    latency:Histogram<f64>, callback_latency:Histogram<f64>,
}
impl Telemetry {
    pub fn new(config:&Config,instance:&str,health:Weak<Health>)->Result<Arc<Self>,String>{
        Self::build(config,instance,health,None,None)
    }
    fn build(config:&Config,instance:&str,health:Weak<Health>, metric_test:Option<opentelemetry_sdk::metrics::InMemoryMetricExporter>, trace_test:Option<opentelemetry_sdk::trace::InMemorySpanExporter>)->Result<Arc<Self>,String>{
        config.validate()?;
        let test_tracing=trace_test.is_some();
        let mut attrs=vec![KeyValue::new("service.name","view-server"),KeyValue::new("service.version",env!("CARGO_PKG_VERSION")),KeyValue::new("service.instance.id",instance.to_owned())];
        if let Some(d)=&config.deployment{attrs.push(KeyValue::new("deployment.environment.name",d.clone()));}
        let resource=Resource::builder_empty().with_attributes(attrs).build();
        let registry=prometheus::Registry::new();
        let exporter=opentelemetry_prometheus::exporter().with_registry(registry.clone()).build().map_err(|e|e.to_string())?;
        let mut metrics=SdkMeterProvider::builder().with_resource(resource.clone()).with_reader(exporter);
        let mut traces=SdkTracerProvider::builder().with_resource(resource).with_sampler(Sampler::TraceIdRatioBased(config.trace_sample_ratio)).with_max_attributes_per_span(8).with_max_events_per_span(4).with_max_links_per_span(4);
        if config.enabled {if let Some(base)=&config.otlp_endpoint {
            let retry=opentelemetry_otlp::RetryPolicy::default().with_max_retries(0);
            let metric=opentelemetry_otlp::MetricExporter::builder().with_http().with_protocol(opentelemetry_otlp::Protocol::HttpBinary).with_endpoint(format!("{}/v1/metrics",base.trim_end_matches('/'))).with_timeout(Duration::from_secs(2)).with_retry_policy(retry.clone()).build().map_err(|e|e.to_string())?;
            metrics=metrics.with_reader(PeriodicReader::builder(metric).with_interval(Duration::from_secs(5)).build());
            let trace=opentelemetry_otlp::SpanExporter::builder().with_http().with_protocol(opentelemetry_otlp::Protocol::HttpBinary).with_endpoint(format!("{}/v1/traces",base.trim_end_matches('/'))).with_timeout(Duration::from_secs(2)).with_retry_policy(retry).build().map_err(|e|e.to_string())?;
            traces=traces.with_span_processor(BatchSpanProcessor::builder(trace).with_batch_config(BatchConfigBuilder::default().with_max_queue_size(512).with_max_export_batch_size(64).with_scheduled_delay(Duration::from_millis(500)).build()).build());
        }}
        if let Some(e)=metric_test{metrics=metrics.with_reader(PeriodicReader::builder(e).with_interval(Duration::from_secs(3600)).build());}
        if let Some(e)=trace_test{traces=traces.with_simple_exporter(e);}
        let meter_provider=metrics.build();let trace_provider=traces.build();let meter=meter_provider.meter(SCOPE);
        let subscriber=tracing_subscriber::registry().with(tracing_opentelemetry::layer().with_tracer(trace_provider.tracer(SCOPE)));
        let dispatch=tracing::Dispatch::new(subscriber);
        let counter=|name,description|meter.u64_counter(name).with_description(description).build();
        let backpressure=counter("view_server.backpressure.disconnects","Connections closed on explicit output/result resource bounds");
        let records=counter("view_server.source.records","User source records durably committed (not offsets)");
        let maintenance_transactions=counter("view_server.retention.maintenance.transactions","Durable timer/source retention maintenance transactions, excluding source records");
        let maintenance_evicted=counter("view_server.retention.evicted.rows","Payload rows durably removed by retention");
        let failures=counter("view_server.source.failures","Terminal source/owner failures, unattributed");
        let operations=counter("view_server.operations","Completed bounded native operations");
        let callbacks=counter("view_server.reporting.callbacks","Observer callback invocations");
        let callback_failures=counter("view_server.reporting.callback_failures","Observer errors or panics");
        let latency=meter.f64_histogram("view_server.operation.duration").with_description("Actual operation elapsed time").with_unit("s").with_boundaries(LATENCY_BUCKETS.to_vec()).build();
        let callback_latency=meter.f64_histogram("view_server.reporting.callback.duration").with_description("Observer execution elapsed time").with_unit("s").with_boundaries(LATENCY_BUCKETS.to_vec()).build();
        // Each callback reads a coherent bounded local observation. Multiple readers
        // neither consume events nor increment anything, and cannot contact Kafka.
        if config.enabled {
        for (name,description,unit,field) in [
            ("view_server.runtime.ready","Current cached near-live readiness","",0),
            ("view_server.runtime.live","Critical owner progress within phase tolerance","",1),
            ("view_server.subscriptions","Active query subscriptions","",2),
            ("view_server.connections","Active query connections","",3),
            ("view_server.rows","Retained live rows","",4),
            ("view_server.output.queue","Queued output frames","",5),
            ("view_server.output.queue.size","Queued output payload bytes","By",6),
            ("view_server.owner.progress.age","Time since actual owner progress","s",7),
            ("view_server.observation.age","Operational sample age","s",8),
            ("view_server.backpressure.connections","Connections currently blocked writing","",9),
        ] {let h=health.clone();meter.f64_observable_gauge(name).with_description(description).with_unit(unit).with_callback(move|o|{if let Some(h)=h.upgrade(){let s=h.snapshot();let value=match field{0=>s.ready as u8 as f64,1=>s.live as u8 as f64,2=>s.subscriptions as f64,3=>s.connections as f64,4=>s.live_rows as f64,5=>s.output_queue_frames as f64,6=>s.output_queue_bytes as f64,7=>h.now().saturating_sub(s.owner_progress_ms) as f64/1000.,9=>s.backpressured_connections as f64,_=>h.now().saturating_sub(s.observed_at_ms) as f64/1000.};o.observe(value,&[]);}}).build();}
        for (name,description,field) in [
            ("view_server.retention.backlog","Topics with due retention work not yet durably applied",0),
            ("view_server.retention.overdue","Age of the oldest due retention item, in milliseconds",1),
            ("view_server.retention.payload.rows","Active payload rows held in canonical retention state",2),
            ("view_server.retention.sticky.keys","Payload plus sticky ownership keys held in canonical state",3),
            ("view_server.retention.scheduled.expiries","Active rows represented in the bounded expiry index",4),
        ]{let h=health.clone();meter.u64_observable_gauge(name).with_description(description).with_callback(move|o|{if let Some(h)=h.upgrade(){for source in h.snapshot().sources{if !source.retention.enabled{continue}let attrs=[KeyValue::new("topic",source.topic.clone())];let value=match field{0=>Some(source.retention.pending_due as u64),1=>source.retention.overdue_ms,2=>Some(source.retention.active_payload_rows),3=>Some(source.retention.sticky_keys),_=>Some(source.retention.scheduled_expiries)};if let Some(v)=value{o.observe(v,&attrs);}}}}).build();}
        {let h=health.clone();meter.f64_observable_counter("view_server.retention.maintenance.duration").with_unit("s").with_description("Cumulative timer-only retention transaction duration").with_callback(move|o|{if let Some(h)=h.upgrade(){o.observe(h.snapshot().maintenance_ns.parse::<f64>().unwrap_or(0.)/1e9,&[]);}}).build();}
        {let h=health.clone();meter.u64_observable_counter("view_server.retention.maintenance.transactions.total").with_description("Cumulative committed maintenance transactions").with_callback(move|o|{if let Some(h)=h.upgrade(){o.observe(h.snapshot().maintenance_transactions,&[]);}}).build();}
        for (name,field,unit) in [("view_server.durable.transactions",0,""),("view_server.durable.duration",1,"s"),("view_server.derived.duration",2,"s")]{let h=health.clone();meter.f64_observable_counter(name).with_unit(unit).with_description("Cumulative native operation measurement, cached once per sample").with_callback(move|o|{if let Some(h)=h.upgrade(){let s=h.snapshot();o.observe(match field{0=>s.durable_transactions as f64,1=>s.durable_ns.parse::<f64>().unwrap_or(0.)/1e9,_=>s.derived_ns.parse::<f64>().unwrap_or(0.)/1e9},&[]);}}).build();}
        for (name,description,kind) in [("view_server.source.offset_distance","Readable end minus applied serving progress (not message count)",0),("view_server.source.observation.available","Fresh valid progress observation availability",1),("view_server.source.fetch_queue","Native fetched message queue",2),("view_server.source.fetched_next","Native next fetch offset",3),("view_server.source.durable_next","Canonical next applied offset",4),("view_server.source.derived_next","Derived completion next offset",5),("view_server.source.readable_end","Fresh read_committed LSO",6)]{
            let h=health.clone();meter.u64_observable_gauge(name).with_description(description).with_callback(move|o|{if let Some(h)=h.upgrade(){for source in h.snapshot().sources{for p in source.partitions{let attrs=[KeyValue::new("topic",source.topic.clone()),KeyValue::new("partition",p.partition as i64)];let fresh=p.readable_sample_ms.is_some_and(|at|h.now().saturating_sub(at)<=source.policy.max_sample_age_ms);let value=match kind{0=>if fresh{p.lag()}else{None},1=>Some((fresh&&p.lag().is_some()) as u64),2=>p.fetch_queue_messages,3=>p.fetched_next.as_ref().and_then(|v|v.parse().ok()),4=>p.durable_next.as_ref().and_then(|v|v.parse().ok()),5=>p.derived_next.as_ref().and_then(|v|v.parse().ok()),_=>if fresh{p.readable_end.as_ref().and_then(|v|v.parse().ok())}else{None}};if let Some(v)=value{o.observe(v,&attrs);}}}}}).build();
        }
        }
        Ok(Arc::new(Self{meter_provider,trace_provider,registry,dispatch,enabled:config.enabled,tracing_enabled:config.enabled&&(test_tracing||config.otlp_endpoint.is_some())&&config.trace_sample_ratio>0.,max_spans:config.max_spans_per_second,limiter:Mutex::new((Instant::now(),0)),backpressure,records,maintenance_transactions,maintenance_evicted,failures,operations,callbacks,callback_failures,latency,callback_latency}))
    }
    pub fn operation(&self,name:&'static str,duration:Duration,ok:bool){if self.enabled{let a=[KeyValue::new("operation",name),KeyValue::new("outcome",if ok{"ok"}else{"error"})];self.operations.add(1,&a);self.latency.record(duration.as_secs_f64(),&a);}}
    pub fn source_topic(&self,topic:&str,records:u64){if self.enabled{self.records.add(records,&[KeyValue::new("topic",topic.to_owned())]);}}
    pub fn maintenance_topic(&self,topic:&str,rows:u64){if self.enabled{let a=[KeyValue::new("topic",topic.to_owned())];self.maintenance_transactions.add(1,&a);self.maintenance_evicted.add(rows,&a);}}
    pub fn span_topic(&self,name:&'static str,parent:Option<&str>,topic:&str)->tracing::Span{let span=self.span(name,parent);span.record("topic",topic);span}
    pub fn source(&self,records:u64){if self.enabled{self.records.add(records,&[]);}}
    pub fn backpressure(&self){if self.enabled{self.backpressure.add(1,&[]);}}
    pub fn failure(&self){if self.enabled{self.failures.add(1,&[]);}}
    pub fn callback(&self,kind:&'static str,duration:Duration,ok:bool){if self.enabled{let a=[KeyValue::new("kind",kind)];self.callbacks.add(1,&a);if !ok{self.callback_failures.add(1,&a);}self.callback_latency.record(duration.as_secs_f64(),&a);}}
    pub fn scrape(&self)->Result<Vec<u8>,String>{if !self.enabled{return Ok(b"# telemetry disabled\n".to_vec());}let mut out=Vec::new();prometheus::TextEncoder::new().encode(&self.registry.gather(),&mut out).map_err(|e|e.to_string())?;if out.len()>262144{return Err("metric payload bound".into());}Ok(out)}
    pub fn span(&self,name:&'static str,parent:Option<&str>)->tracing::Span{
        if !self.tracing_enabled{return tracing::Span::none();}
        let mut budget=self.limiter.lock().unwrap();if budget.0.elapsed()>=Duration::from_secs(1){*budget=(Instant::now(),0);}if budget.1>=self.max_spans{return tracing::Span::none();}budget.1+=1;drop(budget);
        let span=tracing::dispatcher::with_default(&self.dispatch,||tracing::info_span!("view_server.operation",otel.name=name,operation=name,outcome=tracing::field::Empty,topic=tracing::field::Empty));
        if let Some(value)=parent.filter(|v|v.len()==55){let map=HashMap::from([("traceparent".to_string(),value.to_string())]);let context=TraceContextPropagator::new().extract(&map);let _=span.set_parent(context);}
        span
    }
    pub fn context(span:&tracing::Span)->Option<String>{if span.is_disabled(){return None;}let mut map=HashMap::new();TraceContextPropagator::new().inject_context(&span.context(),&mut map);map.remove("traceparent")}
    pub fn shutdown(&self){let _=self.trace_provider.shutdown_with_timeout(Duration::from_secs(3));let _=self.meter_provider.shutdown_with_timeout(Duration::from_secs(3));}
}
#[cfg(test)]mod tests{
use super::*;
use opentelemetry_sdk::{metrics::{InMemoryMetricExporter,Temporality,data::{AggregatedMetrics,MetricData}},trace::InMemorySpanExporter};
fn total(e:&InMemoryMetricExporter)->u64{let all=e.get_finished_metrics().unwrap();let last=all.last().unwrap();for scope in last.scope_metrics(){for m in scope.metrics(){if m.name()=="view_server.source.records"{if let AggregatedMetrics::U64(MetricData::Sum(s))=m.data(){return s.data_points().map(|d|d.value()).sum();}}}}panic!("missing counter")}
#[test]fn same_instruments_two_readers_scrapes_never_drain_and_sampling_independent(){for ratio in [0.,1.]{let metrics=opentelemetry_sdk::metrics::InMemoryMetricExporterBuilder::new().with_temporality(Temporality::Cumulative).build();let spans=InMemorySpanExporter::default();let t=Telemetry::build(&Config{trace_sample_ratio:ratio,..Default::default()},"identity",Weak::new(),Some(metrics.clone()),Some(spans.clone())).unwrap();for _ in 0..24{t.source(1);t.operation("source_apply",Duration::from_millis(2),true);}let parent=t.span("query_acquisition",None);let cx=Telemetry::context(&parent);let child=t.span("query_handle",cx.as_deref());child.record("outcome","ok");drop(child);drop(parent);let handles=(0..8).map(|_|{let t=t.clone();std::thread::spawn(move||{for _ in 0..10{let bytes=t.scrape().unwrap();let text=String::from_utf8(bytes).unwrap();assert!(text.lines().any(|l|l.starts_with("view_server_source_records_total{")&&l.ends_with(" 24")));}})}).collect::<Vec<_>>();for h in handles{h.join().unwrap();}t.meter_provider.force_flush().unwrap();assert_eq!(total(&metrics),24);t.meter_provider.force_flush().unwrap();assert_eq!(total(&metrics),24);let exported=spans.get_finished_spans().unwrap();if ratio==0.{assert!(exported.is_empty());}else{assert_eq!(exported.len(),2);let child=exported.iter().find(|s|s.name=="query_handle").unwrap();let parent=exported.iter().find(|s|s.name=="query_acquisition").unwrap();assert_eq!(child.parent_span_id,parent.span_context.span_id());assert_eq!(child.span_context.trace_id(),parent.span_context.trace_id());assert!(child.attributes.len()<=8);}t.shutdown();}}
}
