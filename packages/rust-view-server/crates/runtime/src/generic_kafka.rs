//! Whole-source format-2 Kafka owners. Each owner has bounded dispatch and one
//! transaction in flight. Derived completion is acknowledged by the single query
//! runtime; browser acknowledgements never enter this module.
use crate::{generic_source::{Descriptor,Mapping,Decoder,KeyField,Identity},kafka_canonical::{KafkaContext,Membership,flush_producer,paused_poll},health::{PartitionHealth,ReadinessPolicy},retention::{RetentionPolicy,NormalizedRetention}};
use rdkafka::{ClientConfig,Message,Offset,TopicPartitionList,consumer::{BaseConsumer,Consumer},producer::{BaseProducer,BaseRecord,Producer},error::KafkaError};
use rdkafka::admin::{AdminClient,AdminOptions,ConfigSource,ResourceSpecifier};
use rust_differential_product_core::{schema::{Catalog,Schema,valid_name,strict_json},generic::Mutation};
use serde::{Deserialize,Serialize};
use serde_json::Value;
use sha2::{Digest,Sha256};
use std::{collections::{BTreeMap,BTreeSet},sync::{Arc,atomic::{AtomicBool,AtomicU64,Ordering},mpsc::{self,SyncSender,Receiver,TryRecvError}},time::{Duration,Instant},io::Read};
const CALL:Duration=Duration::from_secs(10);
fn err(e:impl std::fmt::Display)->String{e.to_string()}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceConfig {
    pub topic:String,pub schema:String,pub brokers:String,pub source_topic:String,pub source_incarnation:String,pub group:String,pub state_topic:String,
    pub initialize_empty:bool,pub partitions:Vec<u32>,pub key_descriptor:Descriptor,pub value_descriptor:Descriptor,#[serde(default)]pub key_tag:u32,pub mapping:Vec<Mapping>,pub readiness:ReadinessPolicy,
    pub max_rows:usize,
    #[serde(default,skip_serializing_if="Option::is_none")]pub evolution:Option<crate::generic_evolution::Predecessor>,
    #[serde(default)]pub key_fields:Vec<KeyField>,
    #[serde(default)]pub identity:Option<Identity>,
    #[serde(default,deserialize_with="rust_differential_product_core::generic::non_null_option",skip_serializing_if="Option::is_none")]pub retention:Option<RetentionPolicy>,
}
impl SourceConfig {
    fn normalized_retention(&self)->Result<Option<NormalizedRetention>,String>{
        self.retention.as_ref().map(|p|{
            let identity=self.identity.as_ref().ok_or("retention requires the accepted rowId identity model")?;
            p.normalize(identity.source_policy,self.max_rows)
        }).transpose()
    }
}
fn preflight_source_policy(config:&SourceConfig)->Result<(),String>{
    let Some(identity)=config.identity.as_ref() else{return Ok(())};
    let admin:AdminClient<rdkafka::client::DefaultClientContext>=ClientConfig::new().set("bootstrap.servers",&config.brokers).create().map_err(err)?;
    let spec=[ResourceSpecifier::Topic(&config.source_topic)];let options=AdminOptions::new().request_timeout(Some(CALL));
    let resources=crate::kafka_canonical::blocking(admin.describe_configs(&spec,&options)).map_err(err)?.map_err(err)?;
    let resource=resources.into_iter().next().ok_or("source configuration result missing")?.map_err(|e|format!("source configuration lookup: {e:?}"))?;
    let cleanup=resource.get("cleanup.policy").ok_or("effective source cleanup.policy unavailable")?;
    let actual=effective_config_value(cleanup.value.as_deref(),cleanup.source!=ConfigSource::Unknown).ok_or("effective source cleanup.policy unresolved")?;
    identity.source_policy.validate_actual(actual).map_err(|e|format!("source topic '{}': {e}",config.topic))?;
    let normalized=config.normalized_retention()?;
    let Some(policy)=normalized else{return Ok(())};
    let retention_ms=if policy.max_age_ms.is_some()&&identity.source_policy.has_delete(){
        let entry=resource.get("retention.ms").ok_or_else(||format!("source topic '{}' effective retention.ms unavailable; finite application retention requires a readable Kafka time-retention value",config.topic))?;
        Some(effective_config_value(entry.value.as_deref(),entry.source!=ConfigSource::Unknown).ok_or_else(||format!("source topic '{}' effective retention.ms unresolved; finite application retention requires a readable Kafka time-retention value",config.topic))?)
    }else{None};
    validate_effective_retention(config,retention_ms,policy.max_age_ms)
}
fn effective_config_value<'a>(value:Option<&'a str>,source_is_known:bool)->Option<&'a str>{if source_is_known{value}else{None}}
fn validate_effective_retention(config:&SourceConfig,retention_ms:Option<&str>,max_age_ms:Option<u64>)->Result<(),String>{
    let Some(identity)=config.identity.as_ref()else{return Err("retention requires the accepted rowId identity model".into())};
    let Some(requested)=max_age_ms.filter(|_|identity.source_policy.has_delete())else{return Ok(())};
    let retention_ms=retention_ms.ok_or_else(||format!("source topic '{}' effective retention.ms unavailable; finite application retention requires a readable Kafka time-retention value",config.topic))?;
    let broker_ms=retention_ms.parse::<i64>().map_err(|_|format!("source topic '{}' has invalid effective retention.ms",config.topic))?;
    if broker_ms < -1{return Err(format!("source topic '{}' has invalid effective retention.ms={broker_ms}",config.topic));}
    if broker_ms==-1{return Ok(())}
    if requested>broker_ms as u64 {
        let requested_label=config.retention.as_ref().and_then(|p|p.max_retention_minutes).map(|m|format!("{m}")).unwrap_or_else(||format!("{}",requested as f64/60_000.0));
        let kafka_label=crate::retention::format_duration_ms(broker_ms as u64);
        return Err(format!("Invalid retention for logical topic '{}' (Kafka topic '{}'): maxRetentionMinutes={} requests {} ({} ms), but Kafka retention.ms={} ({}). Reduce the application horizon or change Kafka retention before starting this service. No configuration was changed.",config.topic,config.source_topic,requested_label,crate::retention::format_duration_ms(requested),requested,broker_ms,kafka_label));
    }
    Ok(())
}
fn descriptor_binding(config:&SourceConfig)->Result<String,String>{
    // Preserve exact legacy binding serialization. V2 also binds identity encoding,
    // source policy, typed key mapping and ordered selectors in the same digest.
    let bytes=if config.identity.is_some(){serde_json::to_vec(&("rowId-tuple-v1",&config.key_descriptor,&config.value_descriptor,&config.mapping,&config.key_fields,&config.identity))}
        else{serde_json::to_vec(&(&config.key_descriptor,&config.value_descriptor,config.key_tag,&config.mapping))}.map_err(err)?;
    Ok(format!("{:x}",Sha256::digest(bytes)))
}

#[derive(Clone,Debug)]
pub enum Event {
    Restore {topic:String,schema:String,rows:Vec<Value>,next:BTreeMap<u32,u64>,sequence:u64,content_version:u64,maintenance_sequence:u64},
    Committed {topic:String,schema:String,mutations:Vec<Mutation>,next:BTreeMap<u32,u64>,sequence:u64,content_version:u64,records:u64,retention_complete:bool,trace_context:Option<String>},
    Maintenance {topic:String,schema:String,mutations:Vec<Mutation>,next:BTreeMap<u32,u64>,sequence:u64,content_version:u64,maintenance_sequence:u64,evicted_rows:u64,retention_complete:bool,trace_context:Option<String>},
    Bootstrap {topic:String,next:BTreeMap<u32,u64>},
    Progress {topic:String,partitions:Vec<PartitionHealth>},
}
enum Control {Ack(u64),Guard(SyncSender<Result<(),String>>),Stop}
struct Handle {topic:String,control:SyncSender<Control>,events:Receiver<Result<Event,String>>,progress:Arc<AtomicU64>}
pub struct Owners {handles:Vec<Handle>,cursor:usize,stop:Arc<AtomicBool>}
impl Owners {
    pub fn launch(configs:Vec<SourceConfig>,catalog:Catalog)->Result<Self,String>{Self::launch_inner(configs,catalog,None,None)}
    pub fn launch_with_health(configs:Vec<SourceConfig>,catalog:Catalog,health:Arc<crate::health::Health>)->Result<Self,String>{Self::launch_inner(configs,catalog,Some(health),None)}
    pub fn launch_observed(configs:Vec<SourceConfig>,catalog:Catalog,health:Arc<crate::health::Health>,telemetry:Arc<crate::telemetry::Telemetry>)->Result<Self,String>{Self::launch_inner(configs,catalog,Some(health),Some(telemetry))}
    fn launch_inner(configs:Vec<SourceConfig>,catalog:Catalog,health:Option<Arc<crate::health::Health>>,telemetry:Option<Arc<crate::telemetry::Telemetry>>)->Result<Self,String>{
        if configs.len()!=catalog.topics().count(){return Err("exactly one source binding per configured topic required".into());}
        let mut topics=BTreeSet::new();let mut states=BTreeSet::new();let mut sources=BTreeSet::new();let mut groups=BTreeSet::new();
        // All local config/descriptors validate before opening any network client.
        let mut admitted=Vec::new();
        for c in configs {
            let schema=catalog.schema(&c.topic,&c.schema)?.clone();
            if !topics.insert(c.topic.clone())||!states.insert((c.brokers.clone(),c.state_topic.clone()))||!sources.insert((c.brokers.clone(),c.source_topic.clone()))||!groups.insert((c.brokers.clone(),c.group.clone())){return Err("duplicate topic/source/group/canonical namespace".into());}
            c.readiness.validate()?;if c.readiness.max_sample_age_ms<2000{return Err("readiness age must cover two one-second source sample periods".into());}
            if c.partitions.is_empty()||c.partitions.len()>32||c.partitions!=(0..c.partitions.len() as u32).collect::<Vec<_>>()||c.max_rows==0||c.max_rows>10_000_000||c.brokers.is_empty()||c.brokers.len()>1024||!valid_name(&c.topic)||c.source_incarnation.is_empty()||c.source_incarnation.len()>128||[&c.source_topic,&c.state_topic,&c.group].iter().any(|s|s.is_empty()||s.len()>128||!s.bytes().all(|b|b.is_ascii_alphanumeric()||b"._-".contains(&b)))||c.source_topic==c.state_topic {return Err("invalid source identity/resource/partition bounds".into());}
            c.normalized_retention()?;
            let decoder=match (&c.identity,c.key_fields.is_empty(),schema.definition().format) {
                (Some(identity),false,2|3)=>Decoder::new_identity(schema.clone(),&c.key_descriptor,&c.value_descriptor,c.mapping.clone(),c.key_fields.clone(),identity.clone()),
                (None,true,1)=>Decoder::new(schema.clone(),&c.key_descriptor,&c.value_descriptor,c.key_tag,c.mapping.clone()),
                _=>Err("schema v2 requires generated key_fields and explicit identity; schema v1 forbids them".into()),
            }.map_err(|e|format!("source topic '{}': {e}",c.topic))?;
            let previous=crate::generic_evolution::admit(&c,&schema)?;
            let decoder=crate::generic_evolution::SourceDecoder::new(decoder,schema.clone(),previous.as_ref().map(|(p,_,d)|(p.value_descriptor.schema_id,d.clone())));
            admitted.push((c,schema,decoder));
        }
        for (c,_,_) in &admitted {if sources.contains(&(c.brokers.clone(),c.state_topic.clone())){return Err("canonical namespace overlaps a configured source".into());}}
        // One bounded, read-only startup admission pass runs before any owner
        // subscribes, initializes a transaction producer, or writes canonical state.
        for (c,_,_) in &admitted {preflight_source_policy(c)?;}
        let stop=Arc::new(AtomicBool::new(false));let mut handles=Vec::new();
        for (config,schema,decoder) in admitted {
            let (send,events)=mpsc::sync_channel(2);let(control,commands)=mpsc::sync_channel(4);let quit=stop.clone();let topic=config.topic.clone();let clock=health.clone();let source_telemetry=telemetry.clone();let progress=Arc::new(AtomicU64::new(0));let owner_progress=progress.clone();
            std::thread::Builder::new().name(format!("topic-{}",config.topic)).spawn(move||{
                let result=Owner::connect(config,schema,decoder,quit.clone(),clock,owner_progress,source_telemetry).and_then(|mut o|o.run(&send,&commands));
                if let Err(error)=result {quit.store(true,Ordering::Release);let _=send.send(Err(error));}
            }).map_err(err)?;
            handles.push(Handle{topic,control,events,progress});
        }
        Ok(Self{handles,cursor:0,stop})
    }
    pub fn progress_ms(&self)->u64{self.handles.iter().map(|h|h.progress.load(Ordering::Relaxed)).min().unwrap_or(0)}
    pub fn try_recv(&mut self)->Result<Option<Event>,String>{
        for _ in 0..self.handles.len(){let i=self.cursor;self.cursor=(self.cursor+1)%self.handles.len();match self.handles[i].events.try_recv(){Ok(v)=>return v.map(Some),Err(TryRecvError::Empty)=>{},Err(TryRecvError::Disconnected)=>return Err(format!("source owner stopped: {}",self.handles[i].topic))}}
        if self.stop.load(Ordering::Acquire){return Err("a source owner failed or stopped".into());}Ok(None)
    }
    pub fn ack(&self,topic:&str,sequence:u64)->Result<(),String>{self.handles.iter().find(|h|h.topic==topic).ok_or("unknown owner")?.control.try_send(Control::Ack(sequence)).map_err(err)}
    /// A fresh authority transaction is required before a query acquisition.
    pub fn guard(&self)->Result<(),String>{
        if self.stop.load(Ordering::Acquire){return Err("source owners unavailable".into());}
        let mut replies=Vec::new();for h in &self.handles{let(tx,rx)=mpsc::sync_channel(1);h.control.try_send(Control::Guard(tx)).map_err(err)?;replies.push(rx);}
        let deadline=Instant::now()+Duration::from_secs(30);for rx in replies{rx.recv_timeout(deadline.saturating_duration_since(Instant::now())).map_err(err)??;}Ok(())
    }
    pub fn guard_topic(&self,topic:&str)->Result<(),String>{if self.stop.load(Ordering::Acquire){return Err("source owners unavailable".into());}let h=self.handles.iter().find(|h|h.topic==topic).ok_or("unknown configured source")?;let(tx,rx)=mpsc::sync_channel(1);h.control.try_send(Control::Guard(tx)).map_err(err)?;rx.recv_timeout(Duration::from_secs(30)).map_err(err)?}
    pub fn stop(&self){self.stop.store(true,Ordering::Release);for h in &self.handles{let _=h.control.try_send(Control::Stop);}}
}
impl Drop for Owners {fn drop(&mut self){self.stop();}}
#[derive(Clone,Debug,Eq,PartialEq,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
struct Binding {format:u32,topic:String,schema:String,source_incarnation:String,source_topic:String,state_topic:String,group:String,descriptor:String,partitions:u32,#[serde(skip_serializing_if="Option::is_none")]retention:Option<NormalizedRetention>}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(tag="kind",rename_all="snake_case",deny_unknown_fields)]
enum State {
    Row{key:String,owner:u32,key_identity:[u8;32],row:Option<Value>,#[serde(default,skip_serializing_if="Option::is_none")]age_origin_ms:Option<u64>,#[serde(default,skip_serializing_if="Option::is_none")]retention_order:Option<u64>},
    Next{next:u64},
    Manifest{sequence:u64,#[serde(deserialize_with="partition_map")]next:BTreeMap<u32,u64>,root:[u8;32],#[serde(default,skip_serializing_if="Option::is_none")]content_version:Option<u64>,#[serde(default,skip_serializing_if="Option::is_none")]maintenance_sequence:Option<u64>,#[serde(default,skip_serializing_if="Option::is_none")]next_order:Option<u64>,#[serde(default,skip_serializing_if="Option::is_none")]last_reference_time_ms:Option<u64>},
    Barrier{nonce:String},
    SchemaTransition{lineage:Lineage}
}
fn partition_map<'de,D:serde::Deserializer<'de>>(d:D)->Result<BTreeMap<u32,u64>,D::Error>{let wire=BTreeMap::<String,u64>::deserialize(d)?;let mut out=BTreeMap::new();for(k,v)in wire{let p=k.parse::<u32>().map_err(serde::de::Error::custom)?;if p.to_string()!=k{return Err(serde::de::Error::custom("noncanonical partition key"));}out.insert(p,v);}Ok(out)}
impl State {fn key(&self,format:u32)->Vec<u8>{let mut k=vec![format as u8];match self{Self::Row{key,..}=>{k.push(1);k.extend(key.as_bytes());},Self::Next{..}=>k.push(2),Self::Manifest{..}=>k.push(3),Self::Barrier{..}=>k.push(4),Self::SchemaTransition{..}=>k.push(5)}k}}
#[derive(Clone,Debug,Eq,PartialEq,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
struct Lineage {epoch:u32,predecessor:Binding,successor:Binding,#[serde(deserialize_with="partition_map")]next:BTreeMap<u32,u64>,root:[u8;32],sequence:u64,content_version:u64,maintenance_sequence:u64}
fn binding_for(config:&SourceConfig)->Result<Binding,String>{let retention=config.normalized_retention()?;Ok(Binding{format:if retention.is_some(){3}else{2},topic:config.topic.clone(),schema:config.schema.clone(),source_incarnation:config.source_incarnation.clone(),source_topic:config.source_topic.clone(),state_topic:config.state_topic.clone(),group:config.group.clone(),descriptor:descriptor_binding(config)?,partitions:config.partitions.len() as u32,retention})}
fn verify_lineage(image:&Image,binding:&Binding,previous:Option<&Binding>,successor_seen:bool,empty:bool)->Result<(),String>{
 if let Some(old)=previous{
  if empty{return Err("evolution cannot initialize empty canonical state".into())}
  if let Some(l)=&image.lineage {
   if l.predecessor!=*old||l.successor!=*binding||l.epoch!=1||l.next.len()!=image.next.len()||l.next.iter().any(|(p,n)|image.next.get(p).is_none_or(|v|v<n))||l.sequence>image.sequence||l.content_version>image.content_version||l.maintenance_sequence>image.maintenance_sequence||l.content_version==image.content_version&&(l.root!=image.root||l.next!=image.next){return Err("canonical schema lineage mismatch".into())}
  }else if successor_seen{return Err("successor canonical state without transition marker".into())}
 }else if image.lineage.is_some(){return Err("canonical schema lineage requires explicit predecessor config".into())}
 Ok(())
}
fn decode_lineage(current:&Binding,previous:Option<(&Binding,&Schema)>,p:u32,key:Option<&[u8]>,payload:Option<&[u8]>)->Result<(State,bool),String>{
 let bytes=payload.ok_or("canonical tombstone forbidden")?;
 let envelope:Envelope=serde_json::from_value(strict_json(bytes,131072)?).map_err(err)?;
 if &envelope.binding==current{return decode(current,p,key,payload).map(|v|(v,true))}
 let(old,schema)=previous.ok_or("unknown canonical predecessor binding")?;
 let state=decode(old,p,key,payload)?;
 if let State::Row{row:Some(row),..}=&state{schema.row(row)?;}
 if matches!(&state,State::SchemaTransition{..}){return Err("second schema transition unsupported".into())}
 Ok((state,false))
}
#[derive(Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {format:u32,binding:Binding,value:State,digest:[u8;32]}
fn digest(binding:&Binding,p:u32,value:&State)->[u8;32]{Sha256::digest(serde_json::to_vec(&(binding.format,binding,p,value.key(binding.format),value)).unwrap()).into()}
fn encode(binding:&Binding,p:u32,value:&State)->Vec<u8>{serde_json::to_vec(&Envelope{format:binding.format,binding:binding.clone(),value:value.clone(),digest:digest(binding,p,value)}).unwrap()}
fn decode(binding:&Binding,p:u32,key:Option<&[u8]>,payload:Option<&[u8]>)->Result<State,String>{let payload=payload.ok_or("canonical tombstone forbidden")?;let v:Envelope=serde_json::from_value(strict_json(payload,131072)?).map_err(err)?;if v.format!=binding.format||v.binding!=*binding||key!=Some(v.value.key(binding.format).as_slice())||v.digest!=digest(binding,p,&v.value){return Err("canonical format/schema/source/partition/key/digest mismatch".into());}Ok(v.value)}
fn xor(root:&mut [u8;32],v:[u8;32]){for(a,b)in root.iter_mut().zip(v){*a^=b;}}
fn row_digest(format:u32,key:&str,owner:u32,identity:&[u8;32],row:&Option<Value>,age_origin_ms:Option<u64>,retention_order:Option<u64>)->[u8;32]{
    if format>=3 {Sha256::digest(serde_json::to_vec(&(key,owner,identity,row,age_origin_ms,retention_order)).unwrap()).into()}
    else {Sha256::digest(serde_json::to_vec(&(key,owner,identity,row)).unwrap()).into()}
}
#[derive(Clone)]
struct RowImage {owner:u32,key_identity:[u8;32],row:Option<Value>,age_origin_ms:Option<u64>,retention_order:Option<u64>}
impl RowImage {fn active(&self)->bool{self.row.is_some()}}
type RecencyKey=(u64,String);
type ExpiryKey=(u64,u64,String);
#[cfg(test)]
#[derive(Clone,Copy,Debug,Default)]
struct WorkCounts {full_rows:usize,row_hashes:usize,fold_rows:usize}
#[cfg(test)]
std::thread_local!{static AUDIT_WORK:std::cell::Cell<WorkCounts>=std::cell::Cell::new(WorkCounts::default());}
#[cfg(test)]
#[path="retention_work_tests.rs"]
mod retention_work_tests;
struct Image {
    format:u32,retention:Option<NormalizedRetention>,rows:BTreeMap<String,RowImage>,active_rows:usize,
    recency:BTreeSet<RecencyKey>,per_key:BTreeMap<[u8;32],BTreeSet<RecencyKey>>,expiry:BTreeSet<ExpiryKey>,
    next:BTreeMap<u32,u64>,sequence:u64,content_version:u64,maintenance_sequence:u64,next_order:u64,last_reference_time_ms:u64,root:[u8;32],manifest:Option<(u64,BTreeMap<u32,u64>,[u8;32])>,lineage:Option<Lineage>
}
impl Image {
    fn empty(count:u32,retention:Option<NormalizedRetention>)->Self{let format=if retention.is_some(){3}else{2};Self{format,retention,rows:BTreeMap::new(),active_rows:0,recency:BTreeSet::new(),per_key:BTreeMap::new(),expiry:BTreeSet::new(),next:(0..count).map(|p|(p,0)).collect(),sequence:0,content_version:0,maintenance_sequence:0,next_order:0,last_reference_time_ms:0,root:[0;32],manifest:None,lineage:None}}
    fn row_hash(&self,key:&str,row:&RowImage)->[u8;32]{#[cfg(test)]AUDIT_WORK.with(|v|{let mut c=v.get();c.row_hashes+=1;v.set(c);});row_digest(self.format,key,row.owner,&row.key_identity,&row.row,row.age_origin_ms,row.retention_order)}
    fn expiry_key(&self,key:&str,row:&RowImage)->Result<Option<ExpiryKey>,String>{
        if !row.active(){return Ok(None)}
        let Some(max_age)=self.retention.as_ref().and_then(|p|p.max_age_ms)else{return Ok(None)};
        let origin=row.age_origin_ms.ok_or("retained row lacks age origin")?;let order=row.retention_order.ok_or("retained row lacks recency order")?;
        Ok(Some((crate::retention::expiry_ms(origin,max_age)?,order,key.to_string())))
    }
    fn remove_indexes(&mut self,key:&str,row:&RowImage)->Result<(),String>{
        if !row.active(){return Ok(())}
        self.active_rows=self.active_rows.checked_sub(1).ok_or("retained row count underflow")?;
        if self.format>=3 {
            let order=row.retention_order.ok_or("active retained row lacks order during replacement")?;let r=(order,key.to_string());
            if !self.recency.remove(&r){return Err("changed row missing from retention recency index".into());}
            let keys=self.per_key.get_mut(&row.key_identity).ok_or("changed row missing from per-key index")?;
            if !keys.remove(&r){return Err("changed row missing from per-key recency index".into());}
            if keys.is_empty(){self.per_key.remove(&row.key_identity);}
        }
        if let Some(expiry)=self.expiry_key(key,row)?{if !self.expiry.remove(&expiry){return Err("changed row missing from expiry index".into());}}
        Ok(())
    }
    fn add_indexes(&mut self,key:&str,row:&RowImage)->Result<(),String>{
        if !row.active(){return Ok(())}
        self.active_rows=self.active_rows.checked_add(1).ok_or("retained row count overflow")?;
        if let Some(order)=row.retention_order{let r=(order,key.to_string());if !self.recency.insert(r.clone())||!self.per_key.entry(row.key_identity).or_default().insert(r){return Err("duplicate retention recency order".into());}}
        if let Some(expiry)=self.expiry_key(key,row)?{if !self.expiry.insert(expiry){return Err("duplicate retention expiry entry".into());}}
        Ok(())
    }
    fn due_expiry(&self,reference_ms:u64)->Option<&ExpiryKey>{self.expiry.first().filter(|(expiry,_,_)|*expiry<=reference_ms)}
    fn due_keys(&self,reference_ms:u64,limit:usize)->Vec<ExpiryKey>{self.expiry.iter().take_while(|(expiry,_,_)|*expiry<=reference_ms).take(limit).cloned().collect()}
    fn fold(&mut self,p:u32,value:State,schema:&Schema,count:u32)->Result<(),String>{
        if p>=count{return Err("canonical partition out of bounds".into());}
        match value {
            State::Row{key,owner,key_identity,row,age_origin_ms,retention_order}=>{#[cfg(test)]AUDIT_WORK.with(|v|{let mut c=v.get();c.fold_rows+=1;v.set(c);});if owner!=p||!schema.valid_identity(&key){return Err("canonical row ownership mismatch".into());}if let Some(r)=&row{if schema.row(r)?.key!=key{return Err("canonical row ID mismatch".into());}}
                match (&self.retention,&row,age_origin_ms,retention_order){
                    (Some(policy),Some(_),age,Some(_)) if policy.max_age_ms.is_some()==age.is_some()=>{},
                    (Some(_),None,None,None)=>{},
                    (None,_,None,None)=>{},
                    _=>return Err("canonical retention row metadata mismatch".into()),
                }
                if let Some(old)=self.rows.get(&key){if old.owner!=p||old.key_identity!=key_identity{return Err("canonical row key/partition ownership changed".into());}let old_hash=self.row_hash(&key,old);xor(&mut self.root,old_hash);let old=old.clone();self.remove_indexes(&key,&old)?;}
                let next=RowImage{owner,key_identity,row,age_origin_ms,retention_order};let next_hash=self.row_hash(&key,&next);xor(&mut self.root,next_hash);self.add_indexes(&key,&next)?;self.rows.insert(key,next);},
            State::Next{next}=>{if next>i64::MAX as u64||next<self.next[&p]{return Err("canonical NEXT invalid/regressed".into());}self.next.insert(p,next);},
            State::Manifest{sequence,next,root,content_version,maintenance_sequence,next_order,last_reference_time_ms}=>{
                if p!=0||next.len()!=count as usize||next.keys().copied().ne(0..count)||self.manifest.as_ref().is_some_and(|(old,_,_)|sequence<*old){return Err("canonical manifest identity/progress mismatch".into());}
                if self.format==2 {
                    if content_version.is_some()||maintenance_sequence.is_some()||next_order.is_some()||last_reference_time_ms.is_some(){return Err("legacy canonical format contains retention metadata".into());}
                    self.content_version=sequence;self.maintenance_sequence=0;self.next_order=0;self.last_reference_time_ms=0;
                }else{
                    let content=content_version.ok_or("canonical retention content version missing")?;let maintenance=maintenance_sequence.ok_or("canonical maintenance sequence missing")?;let order=next_order.ok_or("canonical retention order missing")?;let reference=last_reference_time_ms.ok_or("canonical reference time missing")?;
                    if content!=sequence.checked_add(maintenance).ok_or("canonical version overflow")?||content<self.content_version||maintenance<self.maintenance_sequence||order<self.next_order||reference<self.last_reference_time_ms{return Err("canonical retention metadata regressed/mismatched".into());}
                    self.content_version=content;self.maintenance_sequence=maintenance;self.next_order=order;self.last_reference_time_ms=reference;
                }
                self.sequence=sequence;self.manifest=Some((sequence,next,root));},
            State::SchemaTransition{lineage}=>{if p!=0||lineage.epoch!=1||self.lineage.as_ref().is_some_and(|old|old!=&lineage){return Err("invalid/repeated canonical schema lineage".into())}self.lineage=Some(lineage);},
            State::Barrier{..}=>{}
        }Ok(())
    }
    fn apply_committed(&mut self,writes:Vec<(u32,State)>,schema:&Schema,count:u32)->Result<(),String>{
        for(p,value)in writes{self.fold(p,value,schema,count)?;}self.audit_live()
    }
    fn audit_live(&self)->Result<(),String>{
        let Some((sequence,next,root))=&self.manifest else{return Err("canonical manifest missing; explicit fresh initialization required".into())};
        if *sequence!=self.sequence||next!=&self.next||root!=&self.root{return Err("canonical final state audit failed".into());}
        if self.format==3&&self.sequence.checked_add(self.maintenance_sequence)!=Some(self.content_version){return Err("canonical content/source/maintenance versions disagree".into());}
        if self.format>=3 {
            let expected_expiries=if self.retention.as_ref().and_then(|p|p.max_age_ms).is_some(){self.active_rows}else{0};
            if self.recency.len()!=self.active_rows||self.expiry.len()!=expected_expiries||self.per_key.len()>self.active_rows||self.recency.last().is_some_and(|(order,_)|*order>self.next_order){return Err("canonical retained index cardinality/order mismatch".into());}
        }else if !self.recency.is_empty()||!self.per_key.is_empty()||!self.expiry.is_empty(){return Err("legacy canonical format contains retention indexes".into());}
        Ok(())
    }
    /// Full reconstruction audit is a restore boundary, never per live commit.
    fn audit(&self)->Result<(),String>{
        self.audit_live()?;
        let mut active=0usize;let mut root_check=[0;32];let(mut recency,mut per_key,mut expiry)=(BTreeSet::new(),BTreeMap::<[u8;32],BTreeSet<RecencyKey>>::new(),BTreeSet::new());let mut max_order=0;
        for(key,row)in &self.rows{
            #[cfg(test)]AUDIT_WORK.with(|v|{let mut c=v.get();c.full_rows+=1;v.set(c);});
            xor(&mut root_check,self.row_hash(key,row));
            if !row.active(){continue}active+=1;
            if self.format>=3{
                let order=row.retention_order.ok_or("active retained row lacks order during audit")?;max_order=max_order.max(order);let entry=(order,key.clone());
                if !recency.insert(entry.clone())||!per_key.entry(row.key_identity).or_default().insert(entry){return Err("duplicate retained admission order".into());}
                if let Some(key)=self.expiry_key(key,row)?{if !expiry.insert(key){return Err("duplicate retained expiry".into());}}
            }
        }
        if active!=self.active_rows||root_check!=self.root{return Err("canonical active payload/root audit failed".into());}
        if self.format>=3{
            if recency!=self.recency||per_key!=self.per_key||expiry!=self.expiry||max_order>self.next_order{return Err("canonical retention index/metadata audit failed".into());}
        }else if !self.recency.is_empty()||!self.per_key.is_empty()||!self.expiry.is_empty(){return Err("legacy canonical format contains retention indexes".into());}
        Ok(())
    }
}
fn manifest_state(format:u32,sequence:u64,next:BTreeMap<u32,u64>,root:[u8;32],content_version:u64,maintenance_sequence:u64,next_order:u64,last_reference_time_ms:u64)->State{
    State::Manifest{sequence,next,root,content_version:(format>=3).then_some(content_version),maintenance_sequence:(format>=3).then_some(maintenance_sequence),next_order:(format>=3).then_some(next_order),last_reference_time_ms:(format>=3).then_some(last_reference_time_ms)}
}
struct Record {partition:u32,offset:u64,key:String,identity:[u8;32],timestamp_ms:Option<u64>,mutation:Mutation}
struct Owner {config:SourceConfig,schema:Schema,decoder:crate::generic_evolution::SourceDecoder,binding:Binding,image:Image,consumer:Arc<BaseConsumer<KafkaContext>>,membership:Arc<Membership>,producer:BaseProducer,nonce:String,stop:Arc<AtomicBool>,pending:Option<Record>,eof:BTreeSet<u32>,target:BTreeMap<u32,u64>,bootstrapped:bool,derived_restored:bool,last_guard:Instant,last_sample:Instant,next_maintenance:Instant,reference_highwater_ms:AtomicU64,started:Instant,clock:Option<Arc<crate::health::Health>>,progress:Arc<AtomicU64>,telemetry:Option<Arc<crate::telemetry::Telemetry>>,_sampler:Option<Sampler>}
struct MaintenanceCommit {mutations:Vec<Mutation>,source_sequence:u64,content_version:u64,maintenance_sequence:u64,evicted_rows:u64,retention_complete:bool,trace_context:Option<String>}
fn oldest_retained(image:&Image,changes:&BTreeMap<String,RowImage>,source_key:Option<[u8;32]>)->Option<RecencyKey>{
    let indexed=match source_key{Some(key)=>image.per_key.get(&key)?,None=>&image.recency};
    let from_image=indexed.iter().find(|(_,key)|!changes.contains_key(key)).cloned();
    let from_changes=changes.iter().filter(|(_,row)|row.active()&&source_key.is_none_or(|key|row.key_identity==key)).filter_map(|(key,row)|row.retention_order.map(|order|(order,key.clone()))).min();
    match(from_image,from_changes){(Some(a),Some(b))=>Some(a.min(b)),(a,None)=>a,(None,b)=>b}
}
fn projected_count(image:&Image,changes:&BTreeMap<String,RowImage>)->Result<usize,String>{
    let mut count=image.active_rows;
    for(key,row)in changes{if image.rows.get(key).is_some_and(RowImage::active){count=count.checked_sub(1).ok_or("retained row count underflow")?;}if row.active(){count=count.checked_add(1).ok_or("retained row count overflow")?;}}
    Ok(count)
}
fn expire_candidate(changes:&mut BTreeMap<String,RowImage>,image:&Image,key:&str)->Result<(),String>{
    let current=changes.get(key).or_else(||image.rows.get(key)).ok_or("retention candidate disappeared")?;
    if !current.active(){return Err("inactive row selected for retention eviction".into());}
    changes.insert(key.to_string(),RowImage{owner:current.owner,key_identity:current.key_identity,row:None,age_origin_ms:None,retention_order:None});
    Ok(())
}
fn apply_retention(image:&Image,changes:&mut BTreeMap<String,RowImage>,policy:Option<&NormalizedRetention>,reference_ms:u64)->Result<(),String>{
    let Some(policy)=policy else{return Ok(())};
    if let Some(max_age)=policy.max_age_ms{
        let late=changes.iter().filter_map(|(key,row)|row.age_origin_ms.and_then(|origin|crate::retention::expiry_ms(origin,max_age).ok().filter(|expiry|*expiry<=reference_ms).map(|_|key.clone()))).collect::<Vec<_>>();
        for key in late{expire_candidate(changes,image,&key)?;}
    }
    if let (Some(limit),Some(scope))=(policy.max_messages,policy.count_scope){
        match scope {
            crate::retention::CountScope::WholeTopic=>{
                let mut count=projected_count(image,changes)?;
                while count>limit as usize{let (_,key)=oldest_retained(image,changes,None).ok_or("topic retention count index exhausted")?;expire_candidate(changes,image,&key)?;count-=1;}
            },
            crate::retention::CountScope::PerSourceKey=>{
                let keys=changes.values().filter(|r|r.active()).map(|r|r.key_identity).collect::<BTreeSet<_>>();
                for source_key in keys{
                    let mut count=image.per_key.get(&source_key).map_or(0,|set|set.len());
                    for(key,row)in changes.iter(){
                        if image.rows.get(key).is_some_and(|old|old.active()&&old.key_identity==source_key){count=count.checked_sub(1).ok_or("per-key retention count underflow")?;}
                        if row.active()&&row.key_identity==source_key{count=count.checked_add(1).ok_or("per-key retention count overflow")?;}
                    }
                    while count>limit as usize{let (_,key)=oldest_retained(image,changes,Some(source_key)).ok_or("per-key retention index exhausted")?;expire_candidate(changes,image,&key)?;count-=1;}
                }
            }
        }
    }
    Ok(())
}
impl Owner {
    fn tick(&self){self.progress.store(self.clock.as_ref().map_or_else(||self.started.elapsed().as_millis() as u64,|h|h.now()),Ordering::Relaxed);}
    #[cfg(feature="fault-injection")]fn fault(&self,name:&str)->bool{crate::faults::point(&format!("{}-{name}",self.config.topic))&&crate::faults::point(name)}
    fn health_progress(&self,derived:bool){if let Some(h)=&self.clock{let reference=self.reference_time();let pending=self.image.due_expiry(reference);h.update(|s|{if let Some(source)=s.sources.iter_mut().find(|s|s.topic==self.config.topic){for p in &mut source.partitions{p.assigned=true;p.bootstrap_complete=self.bootstrapped;let n=self.image.next[&p.partition].to_string();p.durable_next=Some(n.clone());if derived&&self.derived_restored{p.derived_next=Some(n.clone());p.serving_next=Some(n);}}if source.retention.enabled{source.retention.active_payload_rows=self.image.active_rows as u64;source.retention.sticky_keys=self.image.rows.len() as u64;source.retention.scheduled_expiries=self.image.expiry.len() as u64;source.retention.canonical_version=self.image.content_version;source.retention.maintenance_sequence=self.image.maintenance_sequence;source.retention.pending_due=pending.is_some();source.retention.overdue_ms=pending.map(|(expiry,_,_)|reference.saturating_sub(*expiry));source.retention.next_expiry_unix_ms=self.image.expiry.first().map(|(expiry,_,_)|*expiry);if derived&&self.derived_restored{source.retention.derived_version=self.image.content_version;source.retention.safe=pending.is_none();}else{source.retention.safe=false;}}}});}}
    fn reference_time(&self)->u64{let observed=crate::health::wall_ms().max(self.image.last_reference_time_ms);self.reference_highwater_ms.fetch_max(observed,Ordering::AcqRel).max(observed)}
    fn membership(&self)->Result<(),String>{
        if self.stop.load(Ordering::Acquire)||self.membership.lost.load(Ordering::SeqCst)||self.consumer.assignment_lost(){return Err("source owner fenced/stopped".into());}
        let a=self.consumer.assignment().map_err(err)?;if a.count()!=self.config.partitions.len()||a.elements().iter().any(|e|e.topic()!=self.config.source_topic||e.partition()<0||e.partition()>=self.config.partitions.len() as i32){return Err("whole-source assignment unavailable".into());}Ok(())
    }
    fn transaction(&self,writes:&[(u32,State)],next:&BTreeMap<u32,u64>,faults:bool)->Result<(),String>{
        self.membership()?;self.producer.begin_transaction().map_err(err)?;
        for(p,v)in writes{self.producer.send(BaseRecord::to(&self.config.state_topic).partition(*p as i32).key(&v.key(self.binding.format)).payload(&encode(&self.binding,*p,v))).map_err(|(e,_)|err(e))?;}
        let mut offsets=TopicPartitionList::new();for(p,n)in next{offsets.add_partition_offset(&self.config.source_topic,*p as i32,Offset::Offset(*n as i64)).map_err(err)?;}
        self.producer.send_offsets_to_transaction(&offsets,&self.consumer.group_metadata().ok_or("missing consumer generation")?,CALL).map_err(err)?;
        flush_producer(&self.producer,CALL).map_err(err)?;
        #[cfg(feature="fault-injection")]if faults&&!self.fault("kafka_before_commit"){return Err("fault before canonical commit".into());}
        #[cfg(not(feature="fault-injection"))]let _=faults;
        self.membership()?;self.producer.commit_transaction(CALL).map_err(err)?;
        #[cfg(feature="fault-injection")]if faults&&!self.fault("kafka_after_commit"){return Err("uncertain injected outcome after canonical commit".into());}
        self.membership()
    }
    fn guard(&mut self)->Result<(),String>{self.transaction(&[(0,State::Barrier{nonce:self.nonce.clone()})],&self.image.next,false)?;self.last_guard=Instant::now();Ok(())}
    fn connect(config:SourceConfig,schema:Schema,decoder:crate::generic_evolution::SourceDecoder,stop:Arc<AtomicBool>,clock:Option<Arc<crate::health::Health>>,progress:Arc<AtomicU64>,telemetry:Option<Arc<crate::telemetry::Telemetry>>)->Result<Self,String>{
        let started=Instant::now();let mut random=[0u8;16];std::fs::File::open("/dev/urandom").and_then(|mut f|f.read_exact(&mut random)).map_err(err)?;let nonce=random.iter().map(|b|format!("{b:02x}")).collect::<String>();
        let retention=config.normalized_retention()?;
        let binding=binding_for(&config)?;
        let previous=crate::generic_evolution::admit(&config,&schema)?.map(|(c,s,_)|binding_for(&c).map(|b|(b,s))).transpose()?;
        let mut successor_seen=false;
        let membership=Arc::new(Membership{source_topic:config.source_topic.clone(),..Default::default()});
        let consumer:Arc<BaseConsumer<KafkaContext>>=Arc::new(ClientConfig::new().set("bootstrap.servers",&config.brokers).set("group.id",&config.group).set("enable.auto.commit","false").set("enable.auto.offset.store","false").set("isolation.level","read_committed").set("auto.offset.reset","error").set("enable.partition.eof","true").set("allow.auto.create.topics","false").set("partition.assignment.strategy","range").set("statistics.interval.ms","100").set("session.timeout.ms","6000").set("max.poll.interval.ms","300000").set("queued.max.messages.kbytes","8192").set("fetch.message.max.bytes","2097152").create_with_context(KafkaContext(membership.clone())).map_err(err)?);
        let old_cfg=crate::kafka_canonical::Config{brokers:config.brokers.clone(),group:config.group.clone(),state_topic:config.state_topic.clone(),initialize_empty:false,schemas:BTreeMap::new()};let source=crate::durable::SourceIdentity{incarnation:config.source_incarnation.clone(),topic:config.source_topic.clone(),schema:config.schema.clone()};crate::kafka_canonical::validate_topics(&old_cfg,&consumer,&source,binding.partitions).map_err(err)?;
        let canonical_version=if binding.format>=3{"retention-v3"}else{"v2"};
        consumer.subscribe(&[&config.source_topic]).map_err(err)?;
        loop {match consumer.poll(Duration::from_millis(20)){Some(Err(KafkaError::MessageConsumption(rdkafka::error::RDKafkaErrorCode::AutoOffsetReset)|KafkaError::PartitionEOF(_)))=>{},Some(Err(e))=>return Err(err(e)),_=>{}}
            let a=consumer.assignment().map_err(err)?;if a.count()==config.partitions.len(){consumer.pause(&a).map_err(err)?;break;}if a.count()>0||started.elapsed()>Duration::from_secs(30)||stop.load(Ordering::Acquire){return Err("complete source assignment unavailable".into());}}
        membership.armed.store(true,Ordering::SeqCst);
        let producer:BaseProducer=ClientConfig::new().set("bootstrap.servers",&config.brokers).set("transactional.id",format!("view-canonical-{canonical_version}-{:x}",Sha256::digest(config.state_topic.as_bytes()))).set("transaction.timeout.ms","30000").set("retry.backoff.ms","10").set("message.timeout.ms","10000").set("enable.idempotence","true").set("acks","all").create().map_err(err)?;
        producer.init_transactions(CALL).map_err(err)?;paused_poll(&consumer,&membership).map_err(err)?;
        let mut image=Image::empty(binding.partitions,retention.clone());let mut state_target=BTreeMap::new();let mut empty=true;
        for p in &config.partitions{let(low,high)=consumer.fetch_watermarks(&config.state_topic,*p as i32,CALL).map_err(err)?;empty&=low==0&&high==0;state_target.insert(*p,high);}
        let restore:BaseConsumer=ClientConfig::new().set("bootstrap.servers",&config.brokers).set("group.id",format!("generic-restore-{nonce}")).set("enable.auto.commit","false").set("enable.auto.offset.store","false").set("isolation.level","read_committed").set("auto.offset.reset","error").set("allow.auto.create.topics","false").set("enable.partition.eof","true").set("queued.max.messages.kbytes","8192").create().map_err(err)?;
        if !empty {
            let mut assignment=TopicPartitionList::new();for p in &config.partitions{assignment.add_partition_offset(&config.state_topic,*p as i32,Offset::Beginning).map_err(err)?;}restore.assign(&assignment).map_err(err)?;
            let mut done=BTreeSet::new();let at=Instant::now();
            while done.len()<config.partitions.len(){paused_poll(&consumer,&membership).map_err(err)?;if at.elapsed()>Duration::from_secs(120)||stop.load(Ordering::Acquire){return Err("canonical replay deadline/stopped".into());}
                match restore.poll(Duration::from_millis(10)){Some(Ok(m))=>{let p=m.partition() as u32;if m.offset()>=state_target[&p]{return Err("canonical write beyond captured restore cut".into());}let(state,current)=decode_lineage(&binding,previous.as_ref().map(|(b,s)|(b,s)),p,m.key(),m.payload())?;successor_seen|=current;image.fold(p,state,&schema,binding.partitions)?;if image.rows.len()>config.max_rows{return Err("canonical restore retained key resource quota".into());}},Some(Err(KafkaError::PartitionEOF(p)))=>{let positions=restore.position().map_err(err)?;if positions.find_partition(&config.state_topic,p).is_some_and(|e|matches!(e.offset(),Offset::Offset(n) if n>=state_target[&(p as u32)])){done.insert(p as u32);}},Some(Err(e))=>return Err(err(e)),None=>{}}
            }
            image.audit()?;
        }else{
            if !config.initialize_empty{return Err("fresh canonical namespace requires initialize_empty".into());}
            let mut tpl=TopicPartitionList::new();for p in &config.partitions{tpl.add_partition(&config.source_topic,*p as i32);}if consumer.committed_offsets(tpl,CALL).map_err(err)?.elements().iter().any(|e|matches!(e.offset(),Offset::Offset(_))){return Err("empty canonical namespace with existing source-group progress".into());}
        }
        if image.rows.len()>config.max_rows{return Err("canonical sticky-key resource quota".into());}
        verify_lineage(&image,&binding,previous.as_ref().map(|(b,_)|b),successor_seen,empty)?;
        let initial_reference=image.last_reference_time_ms.max(crate::health::wall_ms());
        let mut owner=Self{config,schema,decoder,binding,image,consumer,membership,producer,nonce,stop,pending:None,eof:BTreeSet::new(),target:BTreeMap::new(),bootstrapped:false,derived_restored:false,last_guard:Instant::now(),last_sample:Instant::now()-Duration::from_secs(2),next_maintenance:Instant::now(),reference_highwater_ms:AtomicU64::new(initial_reference),started,clock,progress,telemetry,_sampler:None};
        if let Some((old,_))=previous {if owner.image.lineage.is_none(){
            let lineage=Lineage{epoch:1,predecessor:old,successor:owner.binding.clone(),next:owner.image.next.clone(),root:owner.image.root,sequence:owner.image.sequence,content_version:owner.image.content_version,maintenance_sequence:owner.image.maintenance_sequence};
            let writes=vec![(0,State::SchemaTransition{lineage}),(0,manifest_state(owner.binding.format,owner.image.sequence,owner.image.next.clone(),owner.image.root,owner.image.content_version,owner.image.maintenance_sequence,owner.image.next_order,owner.image.last_reference_time_ms))];
            #[cfg(feature="fault-injection")]if !owner.fault("schema_before_transition"){return Err("schema transition interrupted before commit".into())}
            owner.transaction(&writes,&owner.image.next,true)?;
            #[cfg(feature="fault-injection")]if !owner.fault("schema_after_transition"){return Err("schema transition interrupted after commit".into())}
            owner.image.apply_committed(writes,&owner.schema,owner.binding.partitions)?;
        }}
        if empty{let mut writes=owner.image.next.iter().map(|(p,n)|(*p,State::Next{next:*n})).collect::<Vec<_>>();writes.push((0,manifest_state(owner.binding.format,0,owner.image.next.clone(),owner.image.root,0,0,0,initial_reference)));owner.transaction(&writes,&owner.image.next,false)?;for(p,v)in writes{owner.image.fold(p,v,&owner.schema,owner.binding.partitions)?;}}
        // Restore and audit the committed image, then durably clear all currently
        // due payloads before dispatching any rows or declaring startup complete.
        owner.expire_due_before_ready()?;
        owner.guard()?;owner.image.audit()?;
        for p in &owner.config.partitions {let(low,high)=owner.consumer.fetch_watermarks(&owner.config.source_topic,*p as i32,CALL).map_err(err)?;let next=owner.image.next[p];if next<low as u64||next>high as u64{return Err(format!("source retention/truncation boundary: topic {} partition {p}, NEXT {next}, low {low}, high {high}",owner.config.source_topic));}owner.consumer.seek(&owner.config.source_topic,*p as i32,Offset::Offset(next as i64),CALL).map_err(err)?;owner.target.insert(*p,high as u64);}
        // The observer may use this baseline only after every seek succeeds.
        owner._sampler=Sampler::start(&owner)?;
        Ok(owner)
    }
    fn controls(&mut self,commands:&Receiver<Control>,expected:Option<u64>)->Result<bool,String>{
        let mut ack=false;self.tick();
        loop {match commands.try_recv(){
            Ok(Control::Ack(n))=>{if expected!=Some(n)||ack{return Err("unexpected derived completion acknowledgement".into());}ack=true;},
            Ok(Control::Guard(reply))=>{let result=self.guard();let _=reply.send(result.clone());result?;},
            Ok(Control::Stop)=>return Err("source owner stopping".into()),
            Err(TryRecvError::Empty)=>break,Err(TryRecvError::Disconnected)=>return Err("query owner disconnected".into())
        }}Ok(ack)
    }
    fn deliver(&mut self,send:&SyncSender<Result<Event,String>>,commands:&Receiver<Control>,event:Event,sequence:u64)->Result<(),String>{
        let mut pending=Ok(event);
        loop {match send.try_send(pending){Ok(())=>break,Err(mpsc::TrySendError::Full(v))=>{pending=v;self.controls(commands,None)?;self.membership()?;std::thread::sleep(Duration::from_millis(1));},Err(mpsc::TrySendError::Disconnected(_))=>return Err("query owner disconnected".into())}}
        let at=Instant::now();loop {if self.controls(commands,Some(sequence))?{self.health_progress(true);return Ok(());}self.membership()?;
            // Continue client callback progress while derived dispatch is bounded.
            // Consumer is paused during restore. During serving do not poll here:
            // returned user records must never be silently discarded.
            if at.elapsed()>Duration::from_secs(30){return Err("derived completion deadline".into());}std::thread::sleep(Duration::from_millis(1));}
    }
    fn poll(&mut self,timeout:Duration)->Result<Option<Record>,String>{
        self.membership()?;if let Some(r)=self.pending.take(){return Ok(Some(r));}
        let record=match self.consumer.poll(timeout){None=>None,Some(Err(KafkaError::PartitionEOF(p)))=>{self.eof.insert(p as u32);None},Some(Err(e))=>return Err(err(e)),Some(Ok(m))=>{
            if m.partition()<0||m.offset()<0||m.offset()==i64::MAX{return Err("invalid source record identity".into());}
            let(key,identity,mutation)=self.decoder.decode(m.key(),m.payload())?;
            let timestamp_ms=match m.timestamp(){rdkafka::Timestamp::CreateTime(ms)|rdkafka::Timestamp::LogAppendTime(ms) if ms>=0=>Some(ms as u64),_=>None};
            Some(Record{partition:m.partition() as u32,offset:m.offset() as u64,key,identity,timestamp_ms,mutation})
        }};self.membership()?;Ok(record)
    }
    fn commit(&mut self,records:Vec<Record>,reference_ms:u64)->Result<(Vec<Mutation>,u64,u64,bool),String>{
        if records.is_empty()||records.len()>256{return Err("source transaction record bound".into());}
        let sequence=self.image.sequence.checked_add(1).ok_or("source sequence exhausted")?;let mut next=self.image.next.clone();let mut changes=BTreeMap::new();
        let policy=self.binding.retention.clone();let mut next_order=self.image.next_order;
        if self.image.due_expiry(reference_ms).is_some(){return Err("retention became due before source batch admission".into());}
        for r in records {
            if r.partition>=self.binding.partitions||r.offset<next[&r.partition]{return Err("source progress regression/replay outside canonical NEXT".into());}
            let old=changes.get(&r.key).or_else(||self.image.rows.get(&r.key));if let Some(old)=old{if old.owner!=r.partition||old.key_identity!=r.identity{return Err("source row key/partition ownership changed".into());}}
            let order=if policy.is_some(){next_order=next_order.checked_add(1).ok_or("retention admission order exhausted")?;Some(next_order)}else{None};
            let row=match r.mutation{Mutation::Upsert{row}=>Some(row),Mutation::Delete{..}=>None};let is_upsert=row.is_some();
            let age_origin_ms=if row.is_some()&&policy.as_ref().is_some_and(|p|p.max_age_ms.is_some()){
                let origin=r.timestamp_ms.ok_or_else(||format!("source record lacks a supported Kafka timestamp for retention on topic '{}'",self.config.topic))?;
                let future_limit=reference_ms.checked_add(crate::retention::MAX_FUTURE_TIMESTAMP_SKEW_MS).ok_or("retention clock bound overflow")?;
                if origin>future_limit{return Err(format!("source record timestamp is too far in the future for retention on topic '{}'",self.config.topic));}
                Some(origin)
            }else{None};
            let row=RowImage{owner:r.partition,key_identity:r.identity,row,age_origin_ms,retention_order:if is_upsert&&policy.is_some(){order}else{None}};
            changes.insert(r.key.clone(),row);next.insert(r.partition,r.offset+1);
        }
        // Late records are admitted with their source timestamp and immediately
        // absent from the retained view when their exact expiry boundary passed.
        apply_retention(&self.image,&mut changes,policy.as_ref(),reference_ms)?;
        let sticky_after=self.image.rows.len()+changes.keys().filter(|k|!self.image.rows.contains_key(*k)).count();if sticky_after>self.config.max_rows{return Err("canonical sticky-key resource quota".into());}
        let mut root=self.image.root;let mut writes=Vec::new();let mut mutations=Vec::new();
        for (key,row) in changes {if let Some(old)=self.image.rows.get(&key){xor(&mut root,self.image.row_hash(&key,old));}xor(&mut root,self.image.row_hash(&key,&row));mutations.push(match &row.row{Some(v)=>Mutation::Upsert{row:v.clone()},None=>Mutation::Delete{key:key.clone()}});writes.push((row.owner,State::Row{key,owner:row.owner,key_identity:row.key_identity,row:row.row,age_origin_ms:row.age_origin_ms,retention_order:row.retention_order}));}
        for(p,n)in &next{if *n!=self.image.next[p]{writes.push((*p,State::Next{next:*n}));}}
        let content_version=self.image.content_version.checked_add(1).ok_or("canonical content version exhausted")?;
        writes.push((0,manifest_state(self.binding.format,sequence,next.clone(),root,content_version,self.image.maintenance_sequence,next_order,reference_ms)));
        #[cfg(feature="fault-injection")]if !self.fault("source_admitted"){return Err("fault before source admission".into());}
        let transaction_started=Instant::now();let committed=self.transaction(&writes,&next,true);if let Some(h)=&self.clock{h.update(|s|{s.durable_transactions+=1;s.durable_ns=(s.durable_ns.parse::<u128>().unwrap_or(0)+transaction_started.elapsed().as_nanos()).to_string();});}committed?;
        self.image.apply_committed(writes,&self.schema,self.binding.partitions)?;self.reference_highwater_ms.fetch_max(reference_ms,Ordering::AcqRel);self.health_progress(false);
        #[cfg(feature="fault-injection")]if !self.fault("committed_before_publication"){return Err("fault after commit before publication".into());}
        let complete=self.image.due_expiry(self.reference_time()).is_none();
        Ok((mutations,sequence,self.image.content_version,complete))
    }
    fn commit_due_chunk(&mut self,reference_ms:u64)->Result<Option<MaintenanceCommit>,String>{
        let due=self.image.due_keys(reference_ms,crate::retention::MAINTENANCE_BATCH_ROWS);
        if due.is_empty(){return Ok(None)}
        let mut changes=BTreeMap::<String,RowImage>::new();let mut oldest_expiry=u64::MAX;
        for(expiry,order,key)in due {
            let Some(current)=self.image.rows.get(&key).cloned()else{self.image.expiry.remove(&(expiry,order,key));continue};
            let generation=self.image.expiry_key(&key,&current)?;
            if !current.active()||current.retention_order!=Some(order)||generation!=Some((expiry,order,key.clone())){
                self.image.expiry.remove(&(expiry,order,key));continue;
            }
            oldest_expiry=oldest_expiry.min(expiry);
            changes.insert(key,RowImage{owner:current.owner,key_identity:current.key_identity,row:None,age_origin_ms:None,retention_order:None});
        }
        if changes.is_empty(){return Ok(None)}
        let mut root=self.image.root;let mut writes=Vec::with_capacity(changes.len()+1);let mut mutations=Vec::with_capacity(changes.len());
        for(key,row)in changes{let old=self.image.rows.get(&key).ok_or("retention row disappeared")?;if !old.active(){return Err("retention selected an inactive row".into());}xor(&mut root,self.image.row_hash(&key,old));xor(&mut root,self.image.row_hash(&key,&row));mutations.push(Mutation::Delete{key:key.clone()});writes.push((row.owner,State::Row{key,owner:row.owner,key_identity:row.key_identity,row:None,age_origin_ms:None,retention_order:None}));}
        let content_version=self.image.content_version.checked_add(1).ok_or("canonical content version exhausted")?;
        let maintenance_sequence=self.image.maintenance_sequence.checked_add(1).ok_or("maintenance sequence exhausted")?;
        writes.push((0,manifest_state(self.binding.format,self.image.sequence,self.image.next.clone(),root,content_version,maintenance_sequence,self.image.next_order,reference_ms)));
        #[cfg(feature="fault-injection")]if !self.fault("retention_before_commit"){return Err("fault before retention maintenance commit".into());}
        let started=Instant::now();self.transaction(&writes,&self.image.next,false)?;let elapsed=started.elapsed();
        #[cfg(feature="fault-injection")]if !self.fault("retention_after_commit"){return Err("uncertain injected retention maintenance outcome after commit".into());}
        self.image.apply_committed(writes,&self.schema,self.binding.partitions)?;self.reference_highwater_ms.fetch_max(reference_ms,Ordering::AcqRel);
        let wall=crate::health::wall_ms();let delay=if oldest_expiry==u64::MAX{0}else{wall.saturating_sub(oldest_expiry)};
        if let Some(h)=&self.clock{h.update(|s|{s.maintenance_transactions=s.maintenance_transactions.saturating_add(1);s.maintenance_rows_evicted=s.maintenance_rows_evicted.saturating_add(mutations.len() as u64);s.maintenance_ns=(s.maintenance_ns.parse::<u128>().unwrap_or(0)+elapsed.as_nanos()).to_string();if let Some(source)=s.sources.iter_mut().find(|s|s.topic==self.config.topic){source.retention.last_commit_unix_ms=Some(wall);source.retention.last_expiry_delay_ms=Some(delay);}});}
        let trace_context=if let Some(t)=&self.telemetry{let span=t.span_topic("retention_maintenance",None,&self.config.topic);let context=crate::telemetry::Telemetry::context(&span);t.operation("retention_maintenance",elapsed,true);t.maintenance_topic(&self.config.topic,mutations.len() as u64);drop(span);context}else{None};
        self.health_progress(false);
        #[cfg(feature="fault-injection")]if !self.fault("retention_before_publication"){return Err("fault after retention commit before publication".into());}
        let retention_complete=self.image.due_expiry(self.reference_time()).is_none();let evicted_rows=mutations.len() as u64;
        Ok(Some(MaintenanceCommit{mutations,source_sequence:self.image.sequence,content_version:self.image.content_version,maintenance_sequence:self.image.maintenance_sequence,evicted_rows,retention_complete,trace_context}))
    }
    fn expire_due_before_ready(&mut self)->Result<(),String>{
        if self.binding.retention.as_ref().and_then(|p|p.max_age_ms).is_none(){self.health_progress(false);return Ok(())}
        loop{let reference=self.reference_time();if self.image.due_expiry(reference).is_none(){break;}let before=self.image.expiry.len();if self.commit_due_chunk(reference)?.is_none()&&self.image.expiry.len()==before{return Err("retention expiry index made no bounded progress".into());}}
        self.health_progress(false);Ok(())
    }
    fn bootstrap_reached(&self)->Result<bool,String>{
        let ends=self.membership.ends.lock().map_err(err)?;
        Ok(self.target.iter().all(|(p,target)|{
            let no_pending=self.pending.as_ref().is_none_or(|r|r.partition!=*p||r.offset>=*target);
            no_pending&&(self.image.next[p]>=*target||(self.eof.contains(p)&&ends.get(p).is_some_and(|(eof,lso,queued)|*eof>=*target as i64&&*lso>=*target as i64&&*queued==0)))
        }))
    }
    fn finish_bootstrap(&mut self)->Result<(),String>{
        let mut next=self.image.next.clone();let mut writes=Vec::new();for(p,target)in &self.target{if *target>next[p]{next.insert(*p,*target);writes.push((*p,State::Next{next:*target}));}}
        if !writes.is_empty(){writes.push((0,manifest_state(self.binding.format,self.image.sequence,next.clone(),self.image.root,self.image.content_version,self.image.maintenance_sequence,self.image.next_order,self.image.last_reference_time_ms)));self.transaction(&writes,&next,false)?;self.image.apply_committed(writes,&self.schema,self.binding.partitions)?;}
        self.guard()?;self.bootstrapped=true;self.health_progress(true);Ok(())
    }
    fn publish_serving(&self)->Result<(),String>{
        let positions=self.consumer.position().map_err(err)?;
        if let Some(h)=&self.clock{h.update(|s|{if let Some(source)=s.sources.iter_mut().find(|s|s.topic==self.config.topic){for p in &mut source.partitions{let durable=self.image.next[&p.partition];let passed=positions.find_partition(&self.config.source_topic,p.partition as i32).and_then(|v|if let Offset::Offset(n)=v.offset(){u64::try_from(n).ok()}else{None});let pending=self.pending.as_ref().filter(|r|r.partition==p.partition).map(|r|r.offset).unwrap_or(u64::MAX);p.serving_next=Some(passed.unwrap_or(durable).min(pending).max(durable).to_string());}}});}Ok(())
    }
    fn run(&mut self,send:&SyncSender<Result<Event,String>>,commands:&Receiver<Control>)->Result<(),String>{
        let mut chunk=Vec::new();let mut bytes=0usize;
        // Bounded restore dispatch. Canonical table remains owner-local; only the
        // committed after-images cross the in-process derived-state channel.
        let keys=self.image.rows.keys().cloned().collect::<Vec<_>>();
        for key in keys {let Some(row)=self.image.rows[&key].row.clone()else{continue};let size=serde_json::to_vec(&row).map_err(err)?.len();if !chunk.is_empty()&&(chunk.len()>=256||bytes+size>2*1024*1024){let rows=std::mem::take(&mut chunk);self.deliver(send,commands,Event::Restore{topic:self.config.topic.clone(),schema:self.config.schema.clone(),rows,next:self.image.next.clone(),sequence:self.image.sequence,content_version:self.image.content_version,maintenance_sequence:self.image.maintenance_sequence},self.image.content_version)?;bytes=0;}bytes+=size;chunk.push(row);}
        // Only the last restore ACK certifies the complete derived relation.
        self.derived_restored=true;
        // Even an empty relation has an explicit restored cut and derived ACK.
        self.deliver(send,commands,Event::Restore{topic:self.config.topic.clone(),schema:self.config.schema.clone(),rows:chunk,next:self.image.next.clone(),sequence:self.image.sequence,content_version:self.image.content_version,maintenance_sequence:self.image.maintenance_sequence},self.image.content_version)?;
        self.consumer.resume(&self.consumer.assignment().map_err(err)?).map_err(err)?;
        let catchup_started=Instant::now();
        while !self.stop.load(Ordering::Acquire){
            self.tick();self.controls(commands,None)?;self.membership()?;
            if self.last_guard.elapsed()>=Duration::from_secs(1){self.guard()?;}
            let reference_ms=self.reference_time();
            let due=self.image.due_expiry(reference_ms).is_some();
            let maintenance_tick=self.binding.retention.as_ref().and_then(|p|p.max_age_ms).is_some()&&Instant::now()>=self.next_maintenance;
            if maintenance_tick {
                self.next_maintenance=Instant::now()+Duration::from_millis(crate::retention::MAINTENANCE_INTERVAL_MS);
                if !due{self.health_progress(true);}
            }
            if due {
                // A bounded durable chunk runs under this source's sole authority.
                // Until every due key is gone, derived results stay stale and fresh
                // query acquisitions are rejected by the service health gate.
                self.health_progress(false);
                if maintenance_tick {
                    if let Some(change)=self.commit_due_chunk(reference_ms)?{
                        self.deliver(send,commands,Event::Maintenance{topic:self.config.topic.clone(),schema:self.config.schema.clone(),mutations:change.mutations,next:self.image.next.clone(),sequence:change.source_sequence,content_version:change.content_version,maintenance_sequence:change.maintenance_sequence,evicted_rows:change.evicted_rows,retention_complete:change.retention_complete,trace_context:change.trace_context},change.content_version)?;
                    }
                }else{std::thread::sleep(Duration::from_millis(1));}
                continue;
            }
            if let Some(first)=self.poll(Duration::from_millis(1))? {
                let partition=first.partition;let mut bytes=serde_json::to_vec(&first.mutation).map_err(err)?.len();let mut records=vec![first];
                while records.len()<256{let Some(r)=self.poll(Duration::ZERO)?else{break};let size=serde_json::to_vec(&r.mutation).map_err(err)?.len();if r.partition!=partition||bytes+size>2*1024*1024{self.pending=Some(r);break;}bytes+=size;records.push(r);}
                let source_started=Instant::now();let source_span=self.telemetry.as_ref().map(|t|t.span_topic("source_apply",None,&self.config.topic));let trace_context=source_span.as_ref().and_then(crate::telemetry::Telemetry::context);let record_count=records.len() as u64;let(mutations,sequence,content_version,retention_complete)=self.commit(records,reference_ms)?;
                self.deliver(send,commands,Event::Committed{topic:self.config.topic.clone(),schema:self.config.schema.clone(),mutations,next:self.image.next.clone(),sequence,content_version,records:record_count,retention_complete,trace_context},content_version)?;if let Some(t)=&self.telemetry{t.operation("source_apply",source_started.elapsed(),true);}drop(source_span);
            }
            if !self.bootstrapped {if self.bootstrap_reached()? {self.finish_bootstrap()?;let mut event=Ok(Event::Bootstrap{topic:self.config.topic.clone(),next:self.image.next.clone()});loop{match send.try_send(event){Ok(())=>break,Err(mpsc::TrySendError::Full(v))=>{event=v;self.controls(commands,None)?;self.membership()?;std::thread::sleep(Duration::from_millis(1));},Err(mpsc::TrySendError::Disconnected(_))=>return Err("query owner disconnected".into())}};}else if catchup_started.elapsed()>Duration::from_secs(120){return Err("source bootstrap captured cut deadline".into());}}
            if self.last_sample.elapsed()>=Duration::from_millis(100){self.publish_serving()?;self.last_sample=Instant::now();}
        }
        Ok(())
    }
}

// One bounded independent observer per configured source, reusing the same
// Kafka client's cached statistics and read_committed ListOffsets machinery.
// It writes diagnostics only: owner completion exclusively controls durable,
// derived, serving, assignment and bootstrap fields. A successful seek and
// subsequently committed NEXT are proven lower bounds for the fetch cursor;
// librdkafka can report a pre-seek next_offset until its next record/stat update.
struct Sampler {quit:Arc<AtomicBool>,done:Receiver<()>}
impl Sampler {
 fn start(owner:&Owner)->Result<Option<Self>,String>{
  let Some(health)=owner.clock.clone()else{return Ok(None)};
  let consumer=owner.consumer.clone();let membership=owner.membership.clone();let source=owner.config.source_topic.clone();let topic=owner.config.topic.clone();let count=owner.binding.partitions;let seek_floor=owner.image.next.clone();let global_stop=owner.stop.clone();let quit=Arc::new(AtomicBool::new(false));let stop=quit.clone();let(tx,done)=mpsc::sync_channel(1);
  std::thread::Builder::new().name(format!("ends-{topic}")).spawn(move||{
   while !stop.load(Ordering::Acquire)&&!global_stop.load(Ordering::Acquire){
    #[cfg(feature="fault-injection")]if !crate::faults::point(&format!("{topic}-readable_sample")){continue;}
    let at=health.now();let mut request=TopicPartitionList::new();for p in 0..count{let _=request.add_partition_offset(&source,p as i32,Offset::End);}
    let ends=consumer.offsets_for_times(request,Duration::from_millis(750)).ok();
    let diagnostics=membership.diagnostics.lock().unwrap().clone();let queues=membership.ends.lock().unwrap().clone();
    health.update(|s|{if let Some(src)=s.sources.iter_mut().find(|s|s.topic==topic){for p in &mut src.partitions {
      if let Some(e)=ends.as_ref().and_then(|v|v.find_partition(&source,p.partition as i32)){if e.error().is_ok(){if let Offset::Offset(n)=e.offset(){if n>=0{p.readable_end=Some(n.to_string());p.readable_sample_ms=Some(at);}}}}
      p.fetched_next=None;p.high_watermark=None;p.fetch_queue_bytes=None;p.fetch_queue_messages=None;p.transaction_blocked=None;
      if let Some((fetched,high,bytes,observed))=diagnostics.get(&p.partition){if observed.elapsed()<Duration::from_secs(3){p.fetched_next=u64::try_from(*fetched).ok().map(|n|n.max(seek_floor[&p.partition]).max(p.durable_next.as_ref().and_then(|v|v.parse().ok()).unwrap_or(0)).to_string());p.high_watermark=u64::try_from(*high).ok().map(|n|n.to_string());p.fetch_queue_bytes=Some(*bytes);p.fetch_queue_messages=queues.get(&p.partition).and_then(|(_,_,n)|u64::try_from(*n).ok());p.transaction_blocked=p.readable_sample_ms.filter(|observed|health.now().saturating_sub(*observed)<=3000).and_then(|_|p.readable_end.as_ref().and_then(|n|n.parse::<i64>().ok())).map(|end|*high>end);}}
    }}});
    let remaining=1000u64.saturating_sub(health.now().saturating_sub(at));for _ in 0..remaining.div_ceil(25){if stop.load(Ordering::Acquire)||global_stop.load(Ordering::Acquire){break;}std::thread::sleep(Duration::from_millis(25));}
   }let _=tx.send(());
  }).map_err(err)?;Ok(Some(Self{quit,done}))
 }
}
impl Drop for Sampler {fn drop(&mut self){self.quit.store(true,Ordering::Release);let _=self.done.recv_timeout(Duration::from_millis(1500));}}

#[cfg(test)]mod tests {
    use super::*;
    use crate::generic_source::SourcePolicy;
    use rust_differential_product_core::schema::{Definition,Field,Kind};
    use serde_json::json;

    fn schema()->Schema{Schema::new(Definition{expansion:None,format:1,id:"positions".into(),version:1,key:"id".into(),fields:vec![Field{name:"id".into(),kind:Kind::String,optional:false,nullable:false},Field{name:"quantity".into(),kind:Kind::Uint64,optional:false,nullable:false}]}).unwrap()}
    fn binding()->Binding{Binding{format:2,topic:"positions".into(),schema:schema().fingerprint().into(),source_incarnation:"fixture".into(),source_topic:"source".into(),state_topic:"state".into(),group:"group".into(),descriptor:"pinned".into(),partitions:2,retention:None}}
    fn retention()->NormalizedRetention{NormalizedRetention{max_age_ms:Some(1_000),max_messages:Some(3),count_scope:Some(crate::retention::CountScope::WholeTopic)}}
    fn active(key:&str,owner:u32,identity:[u8;32],origin:Option<u64>,order:u64)->RowImage{RowImage{owner,key_identity:identity,row:Some(json!({"id":key,"quantity":"1"})),age_origin_ms:origin,retention_order:Some(order)}}
    fn source_config(policy:&str,minutes:f64)->SourceConfig{serde_json::from_value(json!({
        "topic":"orders","schema":"fingerprint","brokers":"127.0.0.1:9092","source_topic":"orders.v1","source_incarnation":"orders-v1",
        "group":"orders-owner","state_topic":"orders-v3","initialize_empty":true,"partitions":[0,1],
        "key_descriptor":{"schema_id":1,"message_index":0,"descriptor_hex":"00"},"value_descriptor":{"schema_id":2,"message_index":0,"descriptor_hex":"00"},
        "mapping":[],"readiness":{"enter_offset_distance":1,"exit_offset_distance":2,"max_sample_age_ms":2000,"enter_hold_ms":0,"exit_hold_ms":0},"max_rows":100,
        "identity":{"source_policy":policy,"components":[]},"retention":{"maxRetentionMinutes":minutes}
    })).unwrap()}
    fn row(key:&str,owner:u32,identity:[u8;32],value:Option<Value>,origin:Option<u64>,order:Option<u64>)->State{State::Row{key:key.into(),owner,key_identity:identity,row:value,age_origin_ms:origin,retention_order:order}}
    fn finish(image:&Image)->State{manifest_state(image.format,image.sequence,image.next.clone(),image.root,image.content_version,image.maintenance_sequence,image.next_order,image.last_reference_time_ms)}

    #[test]
    fn v2_canonical_encoding_omits_retention_metadata(){
        let b=binding();let v=row("same",1,[42;32],Some(json!({"id":"same","quantity":"18446744073709551615"})),None,None);let bytes=encode(&b,1,&v);
        let encoded=String::from_utf8(bytes.clone()).unwrap();assert!(!encoded.contains("age_origin_ms"));assert!(!encoded.contains("retention_order"));
        assert!(decode(&b,1,Some(&v.key(2)),Some(&bytes)).is_ok());
        let mut image=Image::empty(2,None);image.fold(1,v.clone(),&schema(),2).unwrap();image.fold(0,finish(&image),&schema(),2).unwrap();image.audit().unwrap();
        let mut wrong=b.clone();wrong.topic="orders".into();assert!(decode(&wrong,1,Some(&v.key(2)),Some(&bytes)).is_err());
        assert!(decode(&b,0,Some(&v.key(2)),Some(&bytes)).is_err());assert!(decode(&b,1,Some(&v.key(2)),None).is_err());
    }

    #[test]
    fn old_rowid_tombstone_retains_source_key_ownership(){
        use rust_differential_product_core::schema::{Scalar,encode_row_id};
        let s=Schema::new(Definition{expansion:None,format:2,id:"positions".into(),version:2,key:"rowId".into(),fields:vec![Field{name:"quantity".into(),kind:Kind::Uint64,optional:false,nullable:false}]}).unwrap();
        let id=encode_row_id(&[Scalar::String("tenant".into()),Scalar::Uint64(u64::MAX),Scalar::Int64(i64::MIN)]).unwrap();let mut b=binding();b.schema=s.fingerprint().into();b.descriptor="identity-rule-and-key-schema-v2".into();
        let mut image=Image::empty(2,None);image.fold(1,row(&id,1,[9;32],Some(json!({"rowId":id,"quantity":"4"})),None,None),&s,2).unwrap();image.fold(1,row(&id,1,[9;32],None,None,None),&s,2).unwrap();image.fold(0,finish(&image),&s,2).unwrap();image.audit().unwrap();assert!(image.rows[&id].row.is_none());
        assert!(image.fold(1,row(&id,1,[8;32],None,None,None),&s,2).is_err());
    }

    #[test]
    fn retention_format_binds_policy_and_rebuilds_exact_expiry_index(){
        let mut b=binding();b.format=3;b.retention=Some(retention());
        let mut image=Image::empty(2,b.retention.clone());
        image.fold(1,row("old",1,[1;32],Some(json!({"id":"old","quantity":"1"})),Some(100),Some(1)),&schema(),2).unwrap();
        image.fold(0,State::Next{next:5},&schema(),2).unwrap();
        image.next_order=1;image.last_reference_time_ms=100;
        image.fold(0,manifest_state(3,1,image.next.clone(),image.root,1,0,1,100),&schema(),2).unwrap();image.audit().unwrap();
        assert!(image.due_expiry(1_099).is_none());assert_eq!(image.due_keys(1_100,256),vec![(1_100,1,"old".into())]);
        let bytes=encode(&b,1,&row("old",1,[1;32],Some(json!({"id":"old","quantity":"1"})),Some(100),Some(1)));
        let mut incompatible=b.clone();incompatible.retention.as_mut().unwrap().max_age_ms=Some(2_000);
        assert!(decode(&incompatible,1,Some(&State::Row{key:"old".into(),owner:1,key_identity:[1;32],row:Some(json!({"id":"old","quantity":"1"})),age_origin_ms:Some(100),retention_order:Some(1)}.key(3)),Some(&bytes)).is_err());
        assert_eq!(b.format,3);
    }

    #[test]
    fn newer_upsert_removes_old_expiry_generation_and_keeps_one_row(){
        let mut image=Image::empty(2,Some(NormalizedRetention{max_age_ms:Some(100),max_messages:None,count_scope:None}));let s=schema();
        image.fold(1,row("same",1,[1;32],Some(json!({"id":"same","quantity":"1"})),Some(10),Some(1)),&s,2).unwrap();
        image.fold(1,row("same",1,[1;32],Some(json!({"id":"same","quantity":"2"})),Some(50),Some(2)),&s,2).unwrap();
        assert_eq!(image.rows.len(),1);assert_eq!(image.active_rows,1);assert_eq!(image.due_keys(110,256).len(),0);assert_eq!(image.due_keys(150,256),vec![(150,2,"same".into())]);
    }

    #[test]
    fn duplicate_cross_partition_source_key_conflicts_remain_fail_closed(){
        let mut image=Image::empty(2,Some(retention()));let s=schema();
        image.fold(1,row("same",1,[1;32],Some(json!({"id":"same","quantity":"1"})),Some(1),Some(1)),&s,2).unwrap();
        assert!(image.fold(0,row("same",0,[1;32],None,None,None),&s,2).is_err());
    }

    #[test]
    fn startup_rejects_application_horizon_longer_than_effective_kafka_retention(){
        let config=source_config("delete",1440.0);
        let message=validate_effective_retention(&config,Some("10800000"),Some(86_400_000)).unwrap_err();
        assert_eq!(message,"Invalid retention for logical topic 'orders' (Kafka topic 'orders.v1'): maxRetentionMinutes=1440 requests 24 hours (86400000 ms), but Kafka retention.ms=10800000 (3 hours). Reduce the application horizon or change Kafka retention before starting this service. No configuration was changed.");
        assert!(validate_effective_retention(&config,None,Some(86_400_000)).unwrap_err().contains("effective retention.ms unavailable"));
        assert!(validate_effective_retention(&config,Some("-1"),Some(86_400_000)).is_ok());
    }

    #[test]
    fn effective_broker_defaults_and_topic_overrides_are_values_but_unknown_is_not(){
        // DescribeConfigs can report either DEFAULT_CONFIG or DYNAMIC_TOPIC_CONFIG;
        // only an unknown/missing source is rejected by this filter.
        assert_eq!(effective_config_value(Some("604800000"),true),Some("604800000"));
        assert_eq!(effective_config_value(Some("10800000"),true),Some("10800000"));
        assert_eq!(effective_config_value(Some("-1"),false),None);
        let compact=source_config("compact",1440.0);
        assert!(validate_effective_retention(&compact,None,Some(86_400_000)).is_ok());
        for policy in ["delete","compact","compact,delete"] {
            let p=match policy {"delete"=>SourcePolicy::Delete,"compact"=>SourcePolicy::Compact,_=>SourcePolicy::CompactDelete};
            assert!(p.validate_actual(" delete, compact ").is_err() || policy=="compact,delete");
        }
        assert!(SourcePolicy::CompactDelete.validate_actual("delete, compact").is_ok());
        assert!(SourcePolicy::CompactDelete.validate_actual("compact,delete,delete").is_err());
        let compact_delete=source_config("compact,delete",1440.0);
        assert!(validate_effective_retention(&compact_delete,Some("10800000"),Some(86_400_000)).is_err());
    }

    #[test]
    fn global_count_cap_is_topic_wide_across_partitions_and_same_id_stays_one_row(){
        let mut image=Image::empty(2,Some(NormalizedRetention{max_age_ms:None,max_messages:Some(2),count_scope:Some(crate::retention::CountScope::WholeTopic)}));let s=schema();
        image.fold(0,row("a",0,[1;32],Some(json!({"id":"a","quantity":"1"})),None,Some(1)),&s,2).unwrap();
        image.fold(1,row("b",1,[2;32],Some(json!({"id":"b","quantity":"1"})),None,Some(2)),&s,2).unwrap();
        let mut changes=BTreeMap::from([("c".into(),active("c",0,[3;32],None,3))]);
        let policy=NormalizedRetention{max_age_ms:None,max_messages:Some(2),count_scope:Some(crate::retention::CountScope::WholeTopic)};
        apply_retention(&image,&mut changes,Some(&policy),10).unwrap();
        assert!(!changes["a"].active());assert_eq!(changes.len(),2);assert!(changes["c"].active());
        for(key,row)in &changes{image.fold(row.owner,State::Row{key:key.clone(),owner:row.owner,key_identity:row.key_identity,row:row.row.clone(),age_origin_ms:row.age_origin_ms,retention_order:row.retention_order},&s,2).unwrap();}
        let mut replacement=BTreeMap::from([("b".into(),active("b",1,[2;32],None,4))]);
        apply_retention(&image,&mut replacement,Some(&policy),10).unwrap();
        assert_eq!(replacement.len(),1);assert_eq!(projected_count(&image,&replacement).unwrap(),2);
    }

    #[test]
    fn per_key_cap_never_evicts_other_keys_or_fabricates_history(){
        let mut image=Image::empty(2,Some(NormalizedRetention{max_age_ms:None,max_messages:Some(1),count_scope:Some(crate::retention::CountScope::PerSourceKey)}));let s=schema();
        image.fold(0,row("x1",0,[1;32],Some(json!({"id":"x1","quantity":"1"})),None,Some(1)),&s,2).unwrap();
        image.fold(1,row("y1",1,[2;32],Some(json!({"id":"y1","quantity":"1"})),None,Some(2)),&s,2).unwrap();
        let mut changes=BTreeMap::from([("x2".into(),active("x2",0,[1;32],None,3)),("y2".into(),active("y2",1,[2;32],None,4))]);
        let policy=NormalizedRetention{max_age_ms:None,max_messages:Some(1),count_scope:Some(crate::retention::CountScope::PerSourceKey)};
        apply_retention(&image,&mut changes,Some(&policy),10).unwrap();
        assert_eq!(changes.len(),4);assert!(changes["x2"].active()&&changes["y2"].active());
        assert!(!changes["x1"].active());assert!(!changes["y1"].active());
        for(key,row)in &changes{image.fold(row.owner,State::Row{key:key.clone(),owner:row.owner,key_identity:row.key_identity,row:row.row.clone(),age_origin_ms:row.age_origin_ms,retention_order:row.retention_order},&s,2).unwrap();}
        // With key-only identity, a limit above one is nonbinding and replacement
        // still leaves one current row rather than retaining overwritten history.
        let nonbinding=NormalizedRetention{max_age_ms:None,max_messages:Some(2),count_scope:Some(crate::retention::CountScope::PerSourceKey)};
        let mut current=BTreeMap::from([("x2".into(),active("x2",0,[1;32],None,5))]);
        apply_retention(&image,&mut current,Some(&nonbinding),10).unwrap();
        assert_eq!(current.len(),1);assert!(current["x2"].active());
    }

    #[test]
    fn expiry_uses_exact_inclusive_boundary(){
        let policy=NormalizedRetention{max_age_ms:Some(10),max_messages:None,count_scope:None};let image=Image::empty(2,Some(policy.clone()));
        let mut before=BTreeMap::from([("before".into(),active("before",0,[1;32],Some(100),1))]);
        let mut at=BTreeMap::from([("at".into(),active("at",1,[2;32],Some(100),2))]);
        apply_retention(&image,&mut before,Some(&policy),109).unwrap();apply_retention(&image,&mut at,Some(&policy),110).unwrap();
        assert!(before["before"].active());assert!(!at["at"].active());
    }
}

#[cfg(test)]
#[path="evolution_state_tests.rs"]
mod evolution_state_tests;
