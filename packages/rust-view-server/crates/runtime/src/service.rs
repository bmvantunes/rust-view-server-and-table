//! Bounded loopback adapter. One thread owns source, durable state, engine and sockets.
use product_source_ingestion::{coordination::*,durable::*,durable_coordinator::*,subscriptions::*};
use rust_differential_product_core::{engine_contract::SelectedProductEngine,source::SourceMutation};
use serde::Deserialize;
use serde_json::{json,Value};
use std::{collections::{BTreeMap,VecDeque},fs::File,io::{Read,Seek,SeekFrom},net::{SocketAddr,TcpListener,TcpStream},time::{Duration,Instant}};
use tungstenite::{WebSocket,Message,handshake::{MidHandshake,HandshakeError,server::{ServerHandshake,Request as HttpRequest,Response,ErrorResponse}},protocol::WebSocketConfig};
#[cfg(not(feature="kafka-canonical"))]
use std::sync::{Arc,Mutex};
fn encode_frame(v:&Value)->Result<(Vec<u8>,u64,u64),String>{let t=Instant::now();let value=v13_codec_experiment::prepare(v)?;let prep=t.elapsed().as_nanos() as u64;let t=Instant::now();let bytes=v13_codec_experiment::encode_mp(&value)?;Ok((bytes,prep,t.elapsed().as_nanos() as u64))}
fn decode_frame(b:&[u8])->Result<Value,String>{let v=v13_codec_experiment::adapt(&v13_codec_experiment::decode_mp(b)?)?;if v["type"]=="command" {product_request_admission::check_source_envelope(&v)?;}Ok(v)}
#[cfg(not(feature="kafka-canonical"))]
type Core=Owner<SelectedProductEngine,SqliteStore>;
#[cfg(feature="kafka-canonical")]
type Core=Owner<SelectedProductEngine,product_source_ingestion::kafka_canonical::KafkaStore>;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {#[serde(default)] health:Option<crate::health::Config>,#[serde(default)] run_until_shutdown:bool,bind:SocketAddr,origin:String,#[serde(default)] database:String,source:SourceIdentity,expected_partitions:Vec<u32>,mode:Mode,#[serde(default)] run_ms:u64,#[serde(default)] stop_file:String,#[serde(default)] subscription_limits:SubscriptionLimits,#[serde(default)] profile:bool}
#[derive(Deserialize)]
#[serde(tag="kind",rename_all="snake_case",deny_unknown_fields)]
#[allow(dead_code)]
enum Mode {Fixture{path:String},Kafka{brokers:String,group:String,registry:String},#[cfg(feature="kafka-canonical")] KafkaCanonical{config:product_source_ingestion::kafka_canonical::Config}}
#[derive(Clone)]
struct Admission {origin:String}
impl tungstenite::handshake::server::Callback for Admission {
 fn on_request(self,r:&HttpRequest,mut response:Response)->Result<Response,ErrorResponse>{
  if r.uri().path()!="/v14"||r.uri().query().is_some()||r.headers().get("origin").and_then(|v|v.to_str().ok())!=Some(self.origin.as_str())||r.headers().get("sec-websocket-protocol").and_then(|v|v.to_str().ok())!=Some("view-server.v14.msgpack") {
   return Err(tungstenite::http::Response::builder().status(403).body(Some("admission rejected".into())).unwrap());
  }
  response.headers_mut().insert("sec-websocket-protocol","view-server.v14.msgpack".parse().unwrap());Ok(response)
 }
}
type Handshake=MidHandshake<ServerHandshake<TcpStream,Admission>>;
enum Wire {Handshake(Option<Handshake>),Socket(WebSocket<TcpStream>)}
struct Peer {resource_bound:bool,health_allowed:bool,trace_allowed:bool,health_subscribed:bool,health_sequence:u64,health_pending:Option<Vec<u8>>,baselines:BTreeMap<String,product_source_ingestion::row_delta::Baseline>,wire:Wire,born:Instant,last:Instant,blocked:Option<Instant>,authenticated:bool,nonce:String,queue:VecDeque<Vec<u8>>,bytes:usize,dead:bool,last_id:u64,frame_limit:usize,encoded_bytes:u64,prepare_ns:u64,encode_ns:u64,encode_samples:Vec<(u64,u64,u64,u64)>,queue_peak_frames:usize,queue_peak_bytes:usize,socket_ns:u64,queue_ns:u64,queued_at:VecDeque<Instant>}
const CLIENTS:usize=16;const INPUT:usize=4*1024*1024;const OUTPUT:usize=4*1024*1024;const QUEUED:usize=8*1024*1024;
fn emit(v:Value){println!("{v}");}
fn enqueue(peer:&mut Peer,v:Value)->bool{
 let (text,prep,ns)=match encode_frame(&v){Ok(v)=>v,Err(_)=>{peer.dead=true;return false;}};peer.prepare_ns+=prep;peer.encode_ns+=ns;if peer.encode_samples.len()<16384{peer.encode_samples.push((v["source_sequence"].as_str().and_then(|v|v.parse().ok()).unwrap_or(0),prep,ns,text.len() as u64));}peer.encoded_bytes+=text.len() as u64;if text.len()>OUTPUT||peer.queue.len()>=peer.frame_limit||peer.bytes.checked_add(text.len()).is_none_or(|n|n>QUEUED){peer.resource_bound=true;peer.dead=true;return false;}
 peer.bytes+=text.len();peer.queue.push_back(text);peer.queued_at.push_back(Instant::now());peer.queue_peak_frames=peer.queue_peak_frames.max(peer.queue.len());peer.queue_peak_bytes=peer.queue_peak_bytes.max(peer.bytes);true
}
fn queue_result(peer:&mut Peer,subscription:String,baseline:product_source_ingestion::row_delta::Baseline,value:Value)->bool{
 if enqueue(peer,value){peer.baselines.insert(subscription,baseline);true}else{false}
}
fn envelope(owner:&Core,id:u64,peer:&Peer,mut v:Value)->Value{
 v["v"]=json!(14);v["incarnation"]=json!(owner.coordinator.incarnation());v["connection"]=json!(id.to_string());v["nonce"]=json!(peer.nonce);v
}
fn publications(owner:&Core,peers:&mut BTreeMap<u64,Peer>,values:Vec<Publication>,request:Option<(u64,&Request)>,trace_context:Option<&str>){
 for p in values {if let Some(peer)=peers.get_mut(&p.connection){
  if peer.dead {continue;}
  let projected=product_source_ingestion::row_delta::project(&serde_json::to_value(&p.group.results[0]).unwrap(),&p.projection);
  let (batch,baseline)=product_source_ingestion::row_delta::batch(peer.baselines.get(&p.subscription),p.acquisition,&p.projection,projected,request.is_some());
  let mut v=json!({"type":"result","subscription":p.subscription,"acquisition":p.acquisition,"result":batch,"source_sequence":p.group.source_sequence.to_string()});
  if let Some((connection,r))=request {if connection==p.connection {v["id"]=json!(r.id);v["traceparent"]=json!(r.traceparent);}}
  if peer.trace_allowed{if let Some(ctx)=trace_context{v["trace_context"]=json!(ctx);}}
  let value=envelope(owner,p.connection,peer,v);queue_result(peer,p.subscription,baseline,value);
 }}
}
fn blocked(e:&tungstenite::Error)->bool{matches!(e,tungstenite::Error::Io(e) if e.kind()==std::io::ErrorKind::WouldBlock)}
pub fn main_entry(){if let Err(e)=run(){emit(json!({"state":"terminal","error":e}));std::process::exit(1);}}
fn run()->Result<(),String>{let path=std::env::args().nth(1).ok_or("usage: view_server CONFIG.json; V12_SESSION_TOKEN required")?;run_with_callbacks(path,crate::health::Callbacks::default())}
pub fn run_with_callbacks(path:impl AsRef<std::path::Path>,mut callbacks:crate::health::Callbacks)->Result<(),String>{
 let mut config_text=String::new();File::open(path).map_err(|e|e.to_string())?.take(2097153).read_to_string(&mut config_text).map_err(|e|e.to_string())?;
 if config_text.len()>2097152{return Err("configuration too large".into());}
 let generic_config=rust_differential_product_core::schema::strict_json(config_text.as_bytes(),2097152)?;
 if generic_config.get("catalog").is_some(){
  #[cfg(feature="kafka-canonical")] return crate::generic_service::run(generic_config,callbacks);
  #[cfg(not(feature="kafka-canonical"))] return Err("generic schemas require the kafka-canonical executable and v15 protocol".into());
 }
 if config_text.len()>65536{return Err("configuration too large".into());}
 let cfg:Config=serde_json::from_str(&config_text).map_err(|e|e.to_string())?;
 if !cfg.bind.ip().is_loopback()||cfg.origin.len()>256||!cfg.origin.starts_with("http://127.0.0.1:")||(!cfg.run_until_shutdown&&(cfg.run_ms==0||cfg.run_ms>3600000))||(cfg.run_until_shutdown&&cfg.run_ms!=0){return Err("loopback origin/bind or lifetime invalid".into());}
 let limits=cfg.subscription_limits.validate().map_err(|e|e.to_string())?;
 let token=std::env::var("V12_SESSION_TOKEN").map_err(|_|"missing session token")?;if token.len()<32||token.len()>256{return Err("session token length".into());}
 let mut observability=if let Some(config)=cfg.health.clone(){
  use sha2::{Digest,Sha256};
  let resource=match &cfg.mode{Mode::Fixture{..}=>"fixture".to_string(),Mode::Kafka{brokers,..}=>format!("kafka-{:x}",Sha256::digest(brokers.as_bytes())),#[cfg(feature="kafka-canonical")]Mode::KafkaCanonical{config}=>format!("kafka-{:x}",Sha256::digest(config.brokers.as_bytes()))};
  let deps=vec![crate::health::Dependency{id:"source".into(),resource_id:resource.clone(),role:"source_read".into(),state:"starting".into(),reason:None,attribution:"unknown".into()},crate::health::Dependency{id:"canonical".into(),resource_id:if matches!(cfg.mode,Mode::Fixture{..}){"local-canonical".into()}else{resource},role:"canonical_store".into(),state:"starting".into(),reason:None,attribution:"unknown".into()}];
  let mut random=[0u8;16];File::open("/dev/urandom").and_then(|mut f|f.read_exact(&mut random)).map_err(|e|e.to_string())?;let instance=random.iter().map(|x|format!("{x:02x}")).collect::<String>();
  let h=crate::health::Health::new(config.clone(),instance.clone(),"products".into(),cfg.source.incarnation.clone(),&cfg.expected_partitions,deps)?;
  h.update(|s|s.sources[0].configured_topic=Some(cfg.source.topic.clone()));
  let t=crate::telemetry::Telemetry::new(&config.telemetry,&instance,std::sync::Arc::downgrade(&h))?;
  if config.stdout {if callbacks.on_heartbeat.is_none(){callbacks.on_heartbeat=Some(Box::new(|s|{println!("{}",json!({"state":"heartbeat","health":s}));Ok(())}));}if callbacks.on_dependencies_update.is_none(){callbacks.on_dependencies_update=Some(Box::new(|d|{println!("{}",json!({"state":"dependencies","dependencies":d}));Ok(())}));}}
  let management=crate::management::Management::start(h.clone(),t.clone(),token.clone())?;
  let reporter=crate::health::Reporter::start(h.clone(),callbacks,t.clone());
  Some(Observability{health:h,telemetry:t,management:Some(management),reporter:Some(reporter),finished:false})
 }else{None};
 if let Some(o)=&observability{o.health.tick();o.health.update(|s|s.phase=crate::health::Phase::Restoring);}
 let restore_started=Instant::now();
 let restore_span=observability.as_ref().map(|o|o.telemetry.span("restore",None));
 #[cfg(not(feature="kafka-canonical"))]
 let store=if std::path::Path::new(&cfg.database).exists(){SqliteStore::open(&cfg.database,cfg.source.clone())}else{SqliteStore::create(&cfg.database,cfg.source.clone())}.map_err(|e|e.to_string())?;
 #[cfg(not(feature="kafka-canonical"))]
 let shared=Arc::new(Mutex::new(Session::new(store,format!("v12-process-{}",std::process::id()),Authority::default())));
 #[cfg(feature="kafka-canonical")]
 let (shared,mut restore_metrics)={
  let Mode::KafkaCanonical{config}=&cfg.mode else{return Err("this binary requires kafka_canonical mode".into());};
  if !cfg.database.is_empty(){return Err("Kafka canonical mode forbids database configuration".into());}
  emit(json!({"state":"recovering","mode":"kafka_canonical"}));
  product_source_ingestion::kafka_canonical::connect(config.clone(),cfg.source.clone(),&cfg.expected_partitions).map_err(|e|e.to_string())?
 };
 let rebuild_started=Instant::now();
 if let Some(o)=&observability{o.health.tick();o.health.update(|s|s.phase=crate::health::Phase::CatchingUp);}
 let mut fixture=None;
 if let Mode::Fixture{path}=&cfg.mode {fixture=Some((File::open(path).map_err(|e|e.to_string())?,0u64,Vec::<u8>::new()));for p in &cfg.expected_partitions {shared.lock().unwrap().acquire(Partition{topic:cfg.source.topic.clone(),partition:*p}).map_err(|e|e.to_string())?;}}
 let mut coordinator=DurableCoordinator::<SelectedProductEngine,_>::new(shared.clone()).map_err(|e|e.to_string())?;
 #[cfg(all(feature="kafka",not(feature="kafka-canonical")))]
 let mut kafka=if let Mode::Kafka{brokers,group,registry}=&cfg.mode {
  use product_source_ingestion::{kafka::{KafkaSource,Config as KafkaConfig},registry::{CachedRegistry,HttpRegistry}};
  let registry=CachedRegistry::new(HttpRegistry::new(registry,None)?,64)?;
  Some(KafkaSource::connect_durable(KafkaConfig{brokers:brokers.clone(),group:group.clone(),topics:vec![cfg.source.topic.clone()],options:BTreeMap::new(),limits:Limits{batches:32,events:8192,bytes:8*1024*1024}},registry,shared.clone())?)
 }else{None};
 #[cfg(not(feature="kafka"))]
 if matches!(cfg.mode,Mode::Kafka{..}){return Err("Kafka mode requires --features kafka-tls".into());}
 #[cfg(feature="kafka-canonical")]
 {
  restore_metrics.engine_rebuild_ms=rebuild_started.elapsed().as_millis();
  product_source_ingestion::kafka_canonical::catch_up(&shared,&mut coordinator,&mut restore_metrics).map_err(|e|e.to_string())?;
  emit(json!({"state":"restore_proven","metrics":restore_metrics}));
 }
 #[cfg(not(feature="kafka-canonical"))] let _=rebuild_started;
 if let Some(o)=&observability{o.telemetry.operation("restore",restore_started.elapsed(),true);}
 drop(restore_span);
 let started=Instant::now();
 #[cfg(all(feature="kafka",not(feature="kafka-canonical")))]
 if let Some(k)=kafka.as_mut(){emit(json!({"state":"recovering","mode":"kafka"}));loop{
  k.poll_durable(&mut coordinator,Duration::from_millis(10))?;
  let mut expected=cfg.expected_partitions.clone();expected.sort_unstable();
  if coordinator.covered_partitions().map_err(|e|e.to_string())?==expected {break;}
  if started.elapsed()>Duration::from_secs(10){return Err("complete configured partition assignment unavailable".into());}
 }}
 coordinator.admit_cut().map_err(|e|e.to_string())?;
 let mut owner=Owner::new(coordinator,cfg.expected_partitions.clone()).and_then(|o|o.with_limits(limits)).map_err(|e|e.to_string())?;owner.check_coverage().map_err(|e|e.to_string())?;
 let startup_snapshot=owner.coordinator.checkpoint().map_err(|e|e.to_string())?.snapshot;let startup_sequence=startup_snapshot.last_source_batch;
 let fixture_next=startup_snapshot.offsets.into_iter().map(|(p,o)|(p,o+1)).collect::<BTreeMap<_,_>>();
 let startup_fixture_bytes=fixture.as_ref().map(|(f,_,_)|f.metadata().map(|m|m.len())).transpose().map_err(|e|e.to_string())?.unwrap_or(0);
 let mut fixture_consumed=0u64;
 let listener=TcpListener::bind(cfg.bind).map_err(|e|e.to_string())?;listener.set_nonblocking(true).map_err(|e|e.to_string())?;
 emit(json!({"state":"ready","source_sequence":startup_sequence.to_string(),"address":listener.local_addr().unwrap().to_string(),"incarnation":owner.coordinator.incarnation(),"coverage":cfg.expected_partitions,"mode":if fixture.is_some(){"deterministic-fixture"}else{"kafka"}}));
 #[cfg(feature="kafka-canonical")] let end_sampler=if let Some(o)=&observability{Some(product_source_ingestion::kafka_canonical::EndSampler::start(&shared,o.health.clone())?)}else{None};
 if let Some(o)=&observability{o.health.tick();o.health.update(|s|{s.startup_complete=startup_fixture_bytes==0;s.authority_safe=true;s.phase=crate::health::Phase::Serving;for d in &mut s.dependencies{d.state="operational".into();}});}
 let mut sampled=Instant::now()-Duration::from_secs(2);
 let mut fixture_progress=fixture_next.clone();
 let mut peers=BTreeMap::<u64,Peer>::new();let mut next=0u64;let mut last_guard=Instant::now();
 let owner_result=(||->Result<(),String>{
 #[allow(unused_labels)]
 'service: while (cfg.run_until_shutdown||started.elapsed()<Duration::from_millis(cfg.run_ms))&&!std::path::Path::new(&cfg.stop_file).exists()&&!observability.as_ref().is_some_and(|o|o.health.stopping()){
  if let Some(o)=&observability{o.health.tick();}
  if last_guard.elapsed()>=Duration::from_secs(1){owner.check_coverage().and_then(|_|owner.coordinator.admit_cut()).map_err(|e|e.to_string())?;last_guard=Instant::now();}
  // One bounded fixture record per owner turn. Appended JSONL is explicitly a local
  // operator/test feeder, never exposed by the ordinary query WebSocket.
  if let Some((file,position,buffer))=fixture.as_mut(){
   if !buffer.contains(&b'\n') {file.seek(SeekFrom::Start(*position)).map_err(|e|e.to_string())?;let mut chunk=[0u8;4096];let n=file.read(&mut chunk).map_err(|e|e.to_string())?;*position+=n as u64;buffer.extend_from_slice(&chunk[..n]);}
   if buffer.len()>2*1024*1024{return Err("fixture record exceeds byte limit".into());}
   if let Some(end)=buffer.iter().position(|b|*b==b'\n'){
    let source_started=Instant::now();
    let line=buffer.drain(..=end).collect::<Vec<_>>();let event:SourceMutation=serde_json::from_slice(&line).map_err(|e|e.to_string())?;
    fixture_consumed+=line.len() as u64;
    if fixture_consumed<=startup_fixture_bytes && event.offset<*fixture_next.get(&event.partition).unwrap_or(&0){continue;}
    let lease=shared.lock().unwrap().leases().into_iter().find(|l|l.partition.partition==event.partition).ok_or("fixture partition not promised")?;
    let offset=event.offset;let partition=event.partition;
    #[cfg(feature="fault-injection")] if !product_source_ingestion::faults::point("source_admitted"){break 'service;}
    let admitted_ns=source_started.elapsed().as_nanos() as u64;
    let previous_metrics=owner.coordinator.metrics().clone();let previous_group=owner.grouped_extraction_ns;
    owner.check_coverage().map_err(|e|e.to_string())?;
    let completion=owner.coordinator.apply(&Delivery{lease,records:vec![Record::new(event)]}).map_err(|e|e.to_string())?;
    #[cfg(feature="fault-injection")] if !product_source_ingestion::faults::point("committed_before_publication"){break 'service;}
    let publications=owner.publish_completion(completion).map_err(|e|e.to_string())?;
    fixture_progress.insert(partition,offset+1);
    if let Some(o)=&observability{o.telemetry.source(1);o.telemetry.operation("source_apply",source_started.elapsed(),true);}
    emit(json!({"state":"source_committed","offset":offset,"publications":publications.len()}));let publication_span=observability.as_ref().map(|o|o.telemetry.span("live_publish",None));let publication_context=publication_span.as_ref().and_then(crate::telemetry::Telemetry::context);publications_dispatch(&owner,&mut peers,publications,publication_context.as_deref());
    if cfg.profile{emit(json!({"state":"profile_source","offset":offset,"admission_ns":admitted_ns,"durability_ns":owner.coordinator.metrics().durable_transaction_ns-previous_metrics.durable_transaction_ns,"reconciliation_ns":owner.coordinator.metrics().engine_reconciliation_ns-previous_metrics.engine_reconciliation_ns,"grouped_extraction_ns":owner.grouped_extraction_ns-previous_group,"source_to_enqueued_ns":source_started.elapsed().as_nanos() as u64}));}
   }
  }
  #[cfg(feature="kafka-canonical")]
  {
   // A zero-time rdkafka poll may service one callback and return None even
   // with source records queued behind it. Give callbacks a bounded time slice
   // before peer commands perform synchronous authority transactions. Keep the
   // batch drain, ownership checks and commit/publication ordering unchanged.
   let (completion,source_span)=product_source_ingestion::kafka_canonical::apply_next_traced(&shared,&mut owner.coordinator,Duration::from_millis(1),observability.as_ref().map(|o|o.telemetry.as_ref())).map_err(|e|e.to_string())?;
   if completion.is_some(){
    let publications=owner.publish_completion(completion).map_err(|e|e.to_string())?;
    let publication_span=observability.as_ref().map(|o|o.telemetry.span("live_publish",source_span.as_ref().and_then(crate::telemetry::Telemetry::context).as_deref()));
    let publication_context=publication_span.as_ref().and_then(crate::telemetry::Telemetry::context);
    publications_dispatch(&owner,&mut peers,publications,publication_context.as_deref());
    emit(json!({"state":"source_committed","records_committed":owner.coordinator.metrics().records_committed}));
   }
   drop(source_span);
  }
  #[cfg(all(feature="kafka",not(feature="kafka-canonical")))]
  if let Some(k)=kafka.as_mut(){
   k.poll_durable(&mut owner.coordinator,Duration::ZERO)?;owner.check_coverage().map_err(|e|e.to_string())?;
   let(applied,completion)=k.apply_next_durable_completion(&mut owner.coordinator)?;
   if applied{let p=owner.publish_completion(completion).map_err(|e|e.to_string())?;publications_dispatch(&owner,&mut peers,p,None);let leases=shared.lock().unwrap().leases();for l in leases{k.commit_checkpoint(&mut owner.coordinator,&l)?;}}
  }
  if observability.as_ref().is_some_and(|o|o.health.stopping()){break 'service;}
  // Accept at most one connection per turn; bound even unauthenticated handshakes.
  match listener.accept(){Ok((stream,_))=>{
   if peers.len()<CLIENTS{
    stream.set_nonblocking(true).map_err(|e|e.to_string())?;stream.set_nodelay(true).map_err(|e|e.to_string())?;
    let config=WebSocketConfig::default().read_buffer_size(4096).write_buffer_size(0).max_write_buffer_size(OUTPUT+1024).max_message_size(Some(INPUT)).max_frame_size(Some(INPUT));
    let wire=match tungstenite::accept_hdr_with_config(stream,Admission{origin:cfg.origin.clone()},Some(config)){Ok(ws)=>Some(Wire::Socket(ws)),Err(HandshakeError::Interrupted(mid))=>Some(Wire::Handshake(Some(mid))),Err(_)=>None};
    if let Some(wire)=wire {next=next.checked_add(1).ok_or("connection identity exhausted")?;peers.insert(next,Peer{resource_bound:false,health_allowed:false,trace_allowed:false,health_subscribed:false,health_sequence:0,health_pending:None,baselines:BTreeMap::new(),wire,born:Instant::now(),last:Instant::now(),blocked:None,authenticated:false,nonce:String::new(),queue:VecDeque::new(),bytes:0,dead:false,last_id:0,frame_limit:limits.per_client+16,encoded_bytes:0,prepare_ns:0,encode_ns:0,encode_samples:Vec::new(),queue_peak_frames:0,queue_peak_bytes:0,socket_ns:0,queue_ns:0,queued_at:VecDeque::new()});}
   }
  },Err(e) if e.kind()==std::io::ErrorKind::WouldBlock=>{},Err(e)=>return Err(e.to_string())}
  let ids=peers.keys().copied().collect::<Vec<_>>();
  for id in ids {
   #[cfg(feature="fault-injection")] if peers.get(&id).is_some_and(|p|!p.queue.is_empty()) && !product_source_ingestion::faults::point("output_pending"){break 'service;}
   let mut request=None;
   {
    let peer=peers.get_mut(&id).unwrap();
    if (!peer.authenticated&&peer.born.elapsed()>Duration::from_secs(2))||peer.last.elapsed()>Duration::from_secs(15)||peer.blocked.is_some_and(|t|t.elapsed()>Duration::from_secs(2)){peer.dead=true;}
    if peer.dead {continue;}
    if let Wire::Handshake(mid)=&mut peer.wire {match mid.take().unwrap().handshake(){Ok(ws)=>peer.wire=Wire::Socket(ws),Err(HandshakeError::Interrupted(m))=>*mid=Some(m),Err(_)=>{peer.dead=true;continue;}}}
    if let Wire::Socket(ws)=&mut peer.wire{
     match ws.flush(){Ok(())=>peer.blocked=None,Err(e) if blocked(&e)=>{peer.blocked.get_or_insert(Instant::now());},Err(_)=>peer.dead=true}
     if peer.blocked.is_none(){if peer.queue.is_empty(){if let Some(text)=peer.health_pending.take(){match ws.send(Message::Binary(text.into())){Ok(())=>{},Err(e) if blocked(&e)=>peer.blocked=Some(Instant::now()),Err(_)=>peer.dead=true}}}if let Some(text)=peer.queue.pop_front(){peer.bytes-=text.len();peer.queue_ns+=peer.queued_at.pop_front().unwrap().elapsed().as_nanos() as u64;let sent=Instant::now();match ws.send(Message::Binary(text.into())){Ok(())=>{},Err(e) if blocked(&e)=>{peer.blocked=Some(Instant::now());},Err(_)=>peer.dead=true}peer.socket_ns+=sent.elapsed().as_nanos() as u64;}}
     match ws.read(){Ok(Message::Binary(text))=>{peer.last=Instant::now();request=Some(text.to_vec());},Ok(Message::Ping(_)|Message::Pong(_))=>peer.last=Instant::now(),Ok(Message::Close(_))=>peer.dead=true,Ok(_)=>peer.dead=true,Err(e) if blocked(&e)=>{},Err(_)=>peer.dead=true}
    }
   }
   if let Some(text)=request{
    // SIGTERM can arrive during this turn: do not admit the next received command.
    if observability.as_ref().is_some_and(|o|o.health.stopping()){break 'service;}
    let peer=peers.get_mut(&id).unwrap();let value:Value=match decode_frame(&text){Ok(v)=>v,Err(_)=>{peer.dead=true;continue;}};
    if !peer.authenticated {
     if value["type"]!="hello"||value["v"]!=14||value["token"].as_str()!=Some(&token)||value["nonce"].as_str().is_none_or(|n|n.len()!=32){peer.dead=true;continue;}
     peer.authenticated=true;peer.nonce=value["nonce"].as_str().unwrap().into();
     let mut ready=json!({"type":"ready","coverage":cfg.expected_partitions,"limits":limits});
     if let Some(caps)=value["capabilities"].as_array(){if caps.len()>2{peer.dead=true;continue;}peer.health_allowed=caps.iter().any(|c|c=="health_v1")&&observability.is_some();peer.trace_allowed=caps.iter().any(|c|c=="trace_v1")&&observability.is_some();ready["capabilities"]=json!({"health_v1":peer.health_allowed,"trace_v1":peer.trace_allowed});}
     enqueue(peer,envelope(&owner,id,peer,ready));continue;
    }
    if value["v"]!=14||value["incarnation"].as_str()!=Some(owner.coordinator.incarnation())||value["connection"]!=id.to_string()||value["nonce"]!=peer.nonce {peer.dead=true;continue;}
    if value["type"]=="health_subscribe"{if !peer.health_allowed||value["version"]!=1||!value["enabled"].is_boolean(){peer.dead=true;continue;}peer.health_subscribed=value["enabled"].as_bool().unwrap();peer.health_sequence=u64::MAX;if !peer.health_subscribed{peer.health_pending=None;}continue;}
    if value["type"]=="ping" {enqueue(peer,envelope(&owner,id,peer,json!({"type":"pong"})));continue;}
    if value["type"]=="command_rejected" {
     let raw=&value["request"];
     if raw.as_object().is_some_and(|m|m.len()==4) && raw["code"]=="invalid_query" {
      if let (Some(rid),Some(trace),Some(sub))=(raw["id"].as_u64(),raw["traceparent"].as_str(),raw["subscription"].as_str()) {
       if rid>peer.last_id && rid<=9_007_199_254_740_991 && trace.len()==55 && sub.len()<=128 {
        peer.last_id=rid;
        enqueue(peer,envelope(&owner,id,peer,json!({"type":"request_error","id":rid,"traceparent":trace,"error":"invalid typed query command","currentAcquisition":owner.current(id,sub)})));continue;
       }
      }
     }
     peer.dead=true;continue;
    }
    if value["type"]!="command"{peer.dead=true;continue;}
    let r:Request=match product_request_admission::admit_projection(value["request"].get("projection")).and_then(|_|product_request_admission::admit_command(value["request"]["command"].clone())).and_then(|command| { let mut request=value["request"].clone(); request["command"]=serde_json::to_value(command).map_err(|e|e.to_string())?; serde_json::from_value(request).map_err(|e|e.to_string()) }){Ok(r)=>r,Err(_)=>{
     let raw=&value["request"];
     if let (Some(rid),Some(trace),Some(sub))=(raw["id"].as_u64(),raw["traceparent"].as_str(),raw["command"]["subscription"].as_str()) {
      if rid>peer.last_id && rid<=9_007_199_254_740_991 && trace.len()==55 && sub.len()<=128 {
       peer.last_id=rid;
       enqueue(peer,envelope(&owner,id,peer,json!({"type":"request_error","id":rid,"traceparent":trace,"error":"invalid typed query command","currentAcquisition":owner.current(id,sub)})));continue;
      }
     }
     peer.dead=true;continue;
    }};
    if r.id<=peer.last_id{peer.dead=true;continue;}peer.last_id=r.id;
    if observability.as_ref().is_some_and(|o|o.health.stopping()){break 'service;}
    let command_started=Instant::now();
    let command_span=observability.as_ref().map(|o|o.telemetry.span("query_handle",if peer.trace_allowed{value["trace_context"].as_str().filter(|s|s.len()==55)}else{None}));
    let command_context=command_span.as_ref().and_then(crate::telemetry::Telemetry::context);
    match owner.command(id,&r){
     Ok(p)=>{
      if let Some(o)=&observability{o.telemetry.operation("query_handle",command_started.elapsed(),true);}if let Some(s)=&command_span{s.record("outcome","ok");}
      #[cfg(feature="fault-injection")] if !product_source_ingestion::faults::point("acquisition_before_output"){break 'service;}
      if let rust_differential_product_core::product::ProductCommand::Close{subscription}=&r.command{peers.get_mut(&id).unwrap().baselines.remove(subscription);}
      let count=p.len();publications(&owner,&mut peers,p,Some((id,&r)),command_context.as_deref());
      #[cfg(feature="fault-injection")] if !product_source_ingestion::faults::point("result_before_ack"){break 'service;}
      let peer=peers.get_mut(&id).unwrap();enqueue(peer,envelope(&owner,id,peer,json!({"type":"ack","id":r.id,"traceparent":r.traceparent,"result_count":count})));if cfg.profile{emit(json!({"state":"profile_command","connection":id,"id":r.id,"command":r.command,"acquisition":r.acquisition,"command_to_enqueued_ns":command_started.elapsed().as_nanos() as u64,"subscriptions":owner.subscription_count(),"shapes":owner.coordinator.engine_stats().query_shapes}));}}
     Err(e)=>{
      if let Some(o)=&observability{o.telemetry.operation("query_handle",command_started.elapsed(),false);}if let Some(s)=&command_span{s.record("outcome","error");}
      let subscription=serde_json::to_value(&r.command).unwrap()["subscription"].as_str().unwrap_or("").to_owned();
      let peer=peers.get_mut(&id).unwrap();enqueue(peer,envelope(&owner,id,peer,json!({"type":"request_error","id":r.id,"traceparent":r.traceparent,"error":e.to_string(),"currentAcquisition":owner.current(id,&subscription)})));
      if owner.coordinator.terminal()||owner.failed{return Err(e.to_string());}
     }
    }
   }
  }
  for id in owner.resource_connections.drain(..){if let Some(p)=peers.get_mut(&id){if let Wire::Socket(ws)=&mut p.wire{let _=ws.close(Some(tungstenite::protocol::CloseFrame{code:tungstenite::protocol::frame::coding::CloseCode::Size,reason:"result resource budget; use viewport".into()}));}p.resource_bound=true;p.dead=true;}emit(json!({"state":"resource_error","connection":id,"error":"result resource budget; use a smaller viewport"}));}
  let dead=peers.iter().filter(|(_,p)|p.dead).map(|(id,_)|*id).collect::<Vec<_>>();
  for id in dead {if peers.get(&id).is_some_and(|p|p.resource_bound){if let Some(o)=&observability{o.telemetry.backpressure();}}if cfg.profile{if let Some(p)=peers.get(&id){emit(peer_profile(id,p));}}peers.remove(&id);owner.disconnect(id).map_err(|e|e.to_string())?;emit(json!({"state":"client_closed","connection":id,"subscriptions":owner.subscription_count(),"shapes":owner.coordinator.engine_stats().query_shapes}));}
  if let Some(o)=&observability{if sampled.elapsed()>=Duration::from_millis(o.health.config.sample_ms){
   #[cfg(feature="kafka-canonical")] let partitions=product_source_ingestion::kafka_canonical::health_partitions(&shared,end_sampler.as_ref().unwrap(),o.health.now())?;
   #[cfg(not(feature="kafka-canonical"))] let partitions=cfg.expected_partitions.iter().map(|p|{let mut d=crate::health::PartitionHealth::unknown(*p);if let Some((file,position,buffer))=&fixture{let complete=*position==file.metadata().map(|m|m.len()).unwrap_or(u64::MAX)&&buffer.is_empty();let n=fixture_progress.get(p).copied().unwrap_or(0).to_string();d.assigned=true;d.bootstrap_complete=fixture_consumed>=startup_fixture_bytes;d.durable_next=Some(n.clone());d.derived_next=Some(n.clone());d.serving_next=Some(n.clone());if complete{d.readable_end=Some(n);d.readable_sample_ms=Some(o.health.now());}}d}).collect();
   o.health.update(|s|{s.sources[0].partitions=partitions;s.startup_complete|=fixture_consumed>=startup_fixture_bytes;s.authority_safe=!owner.failed&&!owner.coordinator.terminal();for d in &mut s.dependencies{let available=if d.role=="source_read"{s.sources[0].partitions.iter().all(|p|p.assigned&&p.readable_sample_ms.is_some_and(|at|o.health.now().saturating_sub(at)<=o.health.config.readiness.max_sample_age_ms))}else{s.authority_safe};d.state=if available{"available"}else{"unknown"}.into();d.reason=if available{None}else{Some("observation_unavailable".into())};}
   s.backpressured_connections=peers.values().filter(|p|p.blocked.is_some()).count() as u64;s.durable_transactions=owner.coordinator.metrics().durable_transactions;s.durable_ns=owner.coordinator.metrics().durable_transaction_ns.to_string();s.derived_ns=owner.coordinator.metrics().engine_reconciliation_ns.to_string();s.records_committed=owner.coordinator.metrics().records_committed;s.live_rows=owner.coordinator.engine_stats().retained_rows as u64;s.subscriptions=owner.subscription_count() as u64;s.connections=peers.len() as u64;s.output_queue_frames=peers.values().map(|p|(p.queue.len()+usize::from(p.health_pending.is_some())) as u64).sum();s.output_queue_bytes=peers.values().map(|p|(p.bytes+p.health_pending.as_ref().map_or(0,Vec::len)) as u64).sum();});sampled=Instant::now();
  }}
  if let Some(o)=observability.as_ref().filter(|o|peers.values().any(|p|p.health_subscribed&&p.health_sequence!=o.health.sequence())){let snapshot=o.health.snapshot();for (id,peer) in &mut peers{if peer.health_subscribed&&peer.health_sequence!=snapshot.sequence{let frame=envelope(&owner,*id,peer,json!({"type":"health","version":1,"snapshot":snapshot}));if let Ok((bytes,_,_))=encode_frame(&frame){if bytes.len()<=crate::health::MAX_SNAPSHOT_BYTES{peer.health_pending=Some(bytes);peer.health_sequence=snapshot.sequence;}}}}}
  std::thread::sleep(Duration::from_millis(1));
 }
 Ok(())})();
 if let Err(error)=owner_result{if let Some(o)=&mut observability{o.health.fail();o.telemetry.failure();o.finished=true;}return Err(error);}
 if let Some(o)=&observability{o.health.stop();}
 for p in peers.values_mut(){if let Wire::Socket(ws)=&mut p.wire{let _=ws.close(Some(tungstenite::protocol::CloseFrame{code:tungstenite::protocol::frame::coding::CloseCode::Away,reason:"service stopping".into()}));}}
 if cfg.profile{for (id,p) in &peers{emit(peer_profile(*id,p));}emit(json!({"state":"profile_owner","durable":owner.coordinator.metrics(),"grouped_extraction_ns":owner.grouped_extraction_ns}));}
 for id in peers.keys(){owner.disconnect(*id).map_err(|e|e.to_string())?;}peers.clear();
 #[cfg(all(feature="kafka",not(feature="kafka-canonical")))] if let Some(k)=kafka.as_mut(){k.shutdown();}
 let partitions=shared.lock().unwrap().leases().into_iter().map(|l|l.partition).collect::<Vec<_>>();for p in partitions{shared.lock().unwrap().release(&p).map_err(|e|e.to_string())?;}
 emit(json!({"state":"stopped","subscriptions":owner.subscription_count(),"shapes":owner.coordinator.engine_stats().query_shapes}));if let Some(o)=observability.as_mut(){o.finished=true;}Ok(())
}
fn publications_dispatch(owner:&Core,peers:&mut BTreeMap<u64,Peer>,p:Vec<Publication>,context:Option<&str>){publications(owner,peers,p,None,context)}

fn peer_profile(id:u64,p:&Peer)->Value{json!({"state":"profile_peer","connection":id,"encoded_bytes":p.encoded_bytes,"encode_ns":p.encode_ns,"encode_samples":p.encode_samples,"prepare_ns":p.prepare_ns,"queue_peak_frames":p.queue_peak_frames,"queue_peak_bytes":p.queue_peak_bytes,"queue_residence_sum_ns":p.queue_ns,"socket_send_call_ns":p.socket_ns,"pending_frames":p.queue.len(),"pending_bytes":p.bytes})}

#[cfg(test)] mod output_tests{
 use super::*;
 fn peer()->Peer{Peer{resource_bound:false,health_allowed:false,trace_allowed:false,health_subscribed:false,health_sequence:0,health_pending:None,baselines:BTreeMap::new(),wire:Wire::Handshake(None),born:Instant::now(),last:Instant::now(),blocked:None,authenticated:true,nonce:String::new(),queue:VecDeque::new(),bytes:0,dead:false,last_id:0,frame_limit:1,encoded_bytes:0,prepare_ns:0,encode_ns:0,encode_samples:vec![],queue_peak_frames:0,queue_peak_bytes:0,socket_ns:0,queue_ns:0,queued_at:VecDeque::new()}}
 fn baseline(revision:u64)->product_source_ingestion::row_delta::Baseline{product_source_ingestion::row_delta::Baseline{acquisition:1,projection:vec!["id".into()],revision,result:json!({})}}
 #[test] fn dependent_baseline_advances_only_after_admission(){let mut p=peer();assert!(queue_result(&mut p,"s".into(),baseline(1),json!({"ok":true})));let queued=p.queue.clone();assert!(!queue_result(&mut p,"s".into(),baseline(2),json!({"ok":true})));assert!(p.dead);assert_eq!(p.baselines["s"].revision,1);assert_eq!(p.queue,queued);}
 #[test] fn encoding_failure_preserves_baseline(){let mut p=peer();p.baselines.insert("s".into(),baseline(1));assert!(!queue_result(&mut p,"s".into(),baseline(2),json!({"invalid_metadata":9007199254740992u64})));assert!(p.dead);assert!(p.queue.is_empty());assert_eq!(p.baselines["s"].revision,1);}
}

struct Observability{health:std::sync::Arc<crate::health::Health>,telemetry:std::sync::Arc<crate::telemetry::Telemetry>,management:Option<crate::management::Management>,reporter:Option<crate::health::Reporter>,finished:bool}
impl Drop for Observability{fn drop(&mut self){if !self.finished{self.health.fail();self.telemetry.failure();}if let Some(r)=self.reporter.take(){let _=r.shutdown(Duration::from_millis(500));}if let Some(m)=self.management.take(){m.shutdown();}self.telemetry.shutdown();}}
