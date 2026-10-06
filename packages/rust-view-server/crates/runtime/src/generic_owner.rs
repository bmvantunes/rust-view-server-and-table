//! Generic query lifetimes. The Kafka owner remains the canonical authority.
use rust_differential_product_core::{generic::{Runtime,Query},schema::valid_key};
use serde::{Deserialize,Serialize};
use serde_json::{Value,json};
use std::collections::{BTreeMap,BTreeSet};
use crate::{subscriptions::SubscriptionLimits,row_delta::{self,Baseline}};
#[derive(Clone,Debug,Deserialize,Serialize)]
#[serde(deny_unknown_fields)]
pub struct Desired {#[serde(default,skip_serializing_if="Option::is_none")]pub semantic_profile:Option<rust_differential_product_core::generic::SemanticProfile>,#[serde(default,deserialize_with="rust_differential_product_core::generic::non_null_option",skip_serializing_if="Option::is_none")]pub join:Option<rust_differential_product_core::join::JoinDefinition>,#[serde(default,deserialize_with="rust_differential_product_core::generic::non_null_option",skip_serializing_if="Option::is_none")]pub global:Option<bool>,#[serde(default,deserialize_with="rust_differential_product_core::generic::non_null_option",skip_serializing_if="Option::is_none")]pub having:Option<rust_differential_product_core::generic::Predicate>,pub topic:String,pub schema:String,#[serde(default,deserialize_with="rust_differential_product_core::generic::non_null_option",skip_serializing_if="Option::is_none")]pub select:Option<Vec<String>>,#[serde(default,deserialize_with="rust_differential_product_core::generic::non_null_option",skip_serializing_if="Option::is_none")]pub group_by:Option<Vec<String>>,#[serde(default,deserialize_with="rust_differential_product_core::generic::non_null_option",skip_serializing_if="Option::is_none")]pub aggregates:Option<BTreeMap<String,rust_differential_product_core::grouped::Aggregate>>,#[serde(default,rename="where")]pub predicate:Option<rust_differential_product_core::generic::Predicate>,pub order_by:Vec<rust_differential_product_core::generic::Order>,pub offset:usize,pub limit:usize}
impl Desired {pub fn dependencies(&self)->BTreeSet<String>{let mut d=BTreeSet::from([self.topic.clone()]);if let Some(j)=&self.join{d.insert(j.right.topic.clone());}d}fn open(&self,runtime:&mut Runtime,id:&str)->Result<(),String>{if let Some(join)=&self.join{runtime.open_join(id,&self.topic,&self.schema,join.clone(),self.query())}else{runtime.open(id,&self.topic,&self.schema,self.query())}}fn query(&self)->Query{Query{semantic_profile:self.semantic_profile,global:self.global,having:self.having.clone(),select:self.select.clone(),group_by:self.group_by.clone(),aggregates:self.aggregates.clone(),predicate:self.predicate.clone(),order_by:self.order_by.clone()}}}
#[derive(Clone,Debug,Deserialize)]
#[serde(tag="command",rename_all="snake_case",deny_unknown_fields)]
pub enum Command {Open{subscription:String,query:Desired},ChangeQuery{subscription:String,query:Desired},ChangeWindow{subscription:String,offset:usize,limit:usize},Close{subscription:String}}
impl Command {fn subscription(&self)->&str{match self{Self::Open{subscription,..}|Self::ChangeQuery{subscription,..}|Self::ChangeWindow{subscription,..}|Self::Close{subscription}=>subscription}}}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {pub id:u64,pub acquisition:u64,pub previous_acquisition:Option<u64>,pub traceparent:String,pub command:Command}
struct Subscription {connection:u64,local:String,acquisition:u64,query:Desired,generation:u64,sequence:u64,baseline:Option<Baseline>}
pub struct Publication {pub dependencies:BTreeSet<String>,pub connection:u64,pub subscription:String,pub acquisition:u64,pub topic:String,pub schema:String,pub result:Value}
pub struct Owner {pub runtime:Runtime,patch_connections:BTreeSet<u64>,subscriptions:BTreeMap<String,Subscription>,limits:SubscriptionLimits,resource_connections:BTreeSet<u64>,query_errors:Vec<(u64,String,u64,String)>}
impl Owner {
 pub fn new(runtime:Runtime,limits:SubscriptionLimits)->Result<Self,String>{limits.validate().map_err(|e|e.to_string())?;Ok(Self{runtime,patch_connections:BTreeSet::new(),subscriptions:BTreeMap::new(),limits,resource_connections:BTreeSet::new(),query_errors:vec![]})}
 pub fn allow_field_patches(&mut self,connection:u64){self.patch_connections.insert(connection);}
 pub fn current(&self,connection:u64,local:&str)->Option<u64>{self.subscriptions.get(&format!("{connection}/{local}")).map(|s|s.acquisition)}
 pub fn topic(&self,connection:u64,local:&str)->Option<&str>{self.subscriptions.get(&format!("{connection}/{local}")).map(|s|s.query.topic.as_str())}
 pub fn dependencies(&self,connection:u64,r:&Request)->BTreeSet<String>{match &r.command{Command::Open{query,..}|Command::ChangeQuery{query,..}=>query.dependencies(),_=>self.subscriptions.get(&format!("{connection}/{}",r.command.subscription())).map(|s|s.query.dependencies()).unwrap_or_default()}}
 pub fn affected_dependencies(&self,topic:&str)->BTreeSet<String>{self.subscriptions.values().filter(|s|s.query.dependencies().contains(topic)).flat_map(|s|s.query.dependencies()).chain([topic.to_owned()]).collect()}
 pub fn take_resource_connections(&mut self)->BTreeSet<u64>{std::mem::take(&mut self.resource_connections)}
 pub fn take_query_errors(&mut self)->Vec<(u64,String,u64,String)>{std::mem::take(&mut self.query_errors)}
 pub fn count(&self)->usize{self.subscriptions.len()}
 pub fn command(&mut self,connection:u64,r:&Request)->Result<Option<Publication>,String>{
  let local=r.command.subscription();let id=format!("{connection}/{local}");
  if !valid_key(local)||local.len()>128||r.id==0||r.id>9_007_199_254_740_991||r.acquisition==0||r.acquisition>9_007_199_254_740_991||r.traceparent.len()!=55{return Err("identity bounds".into())}
  let replacing=matches!(r.command,Command::Open{..}|Command::ChangeQuery{..});let prior=self.subscriptions.get(&id);
  if replacing&&prior.is_some_and(|s|r.acquisition<=s.acquisition)||!replacing&&prior.map(|s|s.acquisition)!=Some(r.acquisition){return Err("obsolete acquisition".into())}
  if replacing&&prior.is_none()&&(self.count()>=self.limits.total||self.subscriptions.values().filter(|s|s.connection==connection).count()>=self.limits.per_client){return Err("subscription quota".into())}
  if matches!(r.command,Command::Close{..}){self.runtime.close(&id)?;self.subscriptions.remove(&id);return Ok(None)}
  let desired=match &r.command {Command::Open{query,..}|Command::ChangeQuery{query,..}=>query.clone(),Command::ChangeWindow{offset,limit,..}=>{let mut q=prior.unwrap().query.clone();q.offset=*offset;q.limit=*limit;q},_=>unreachable!()};
  if desired.offset>u32::MAX as usize||desired.limit>u32::MAX as usize{return Err("window bound".into())}
  if !replacing&&desired.limit>1024{return Err("viewport window bound".into())}
  // Admit the complete replacement and output budget before retiring its predecessor.
  let temporary=format!("pending/{connection}/{}",r.id);
  if replacing{desired.open(&mut self.runtime,&temporary)?;}
  let read_id=if replacing{&temporary}else{&id};
  let checked=self.runtime.read(read_id,desired.offset,desired.limit.min(4096),4*1024*1024);
  let checked=match checked{Ok(v) if v.total_rows.saturating_sub(desired.offset).min(desired.limit)<=4096=>Ok(v),Ok(_)=>Err("result row bound; use viewport".into()),Err(e)=>Err(e)};
  if let Err(e)=checked{if replacing{self.runtime.close(&temporary)?;}return Err(e)}
  if replacing{desired.open(&mut self.runtime,&id)?;self.runtime.close(&temporary)?;let generation=prior.map_or(1,|s|s.generation+1);self.subscriptions.insert(id.clone(),Subscription{connection,local:local.into(),acquisition:r.acquisition,query:desired,generation,sequence:0,baseline:None});}
  else{self.subscriptions.get_mut(&id).unwrap().query=desired;}
  self.publish_one(&id,true).map(Some)
 }
 fn publish_one(&mut self,id:&str,force:bool)->Result<Publication,String>{
  let s=self.subscriptions.get_mut(id).ok_or("subscription absent")?;
  let rows=self.runtime.read(id,s.query.offset,s.query.limit.min(4096),4*1024*1024)?;
  if rows.total_rows.saturating_sub(s.query.offset).min(s.query.limit)>4096{return Err("result row bound; use viewport".into())}
  s.sequence=s.sequence.checked_add(1).filter(|n|*n<=9_007_199_254_740_991).ok_or("result sequence exhausted")?;
  let version=rows.version.parse::<u64>().map_err(|_|"version")?;if version>9_007_199_254_740_991{return Err("result version exhausted".into())}
  let mut result=json!({"subscription":s.local,"topic":rows.topic,"schema":rows.schema,"query_generation":s.generation,"sequence":s.sequence,"version":version,"start_rank":s.query.offset,"total_rows":rows.total_rows,"keys":rows.keys,"rows":rows.rows});
  if let Some(shape)=rows.result_shape{result["result_kind"]=json!(if s.query.join.is_some(){if s.query.global==Some(true){"join_global_v1"}else if s.query.group_by.is_some(){"join_grouped_v1"}else{"join_v1"}}else if s.query.global==Some(true){"global_v1"}else{"grouped_v1"});result["result_shape"]=json!(shape);}
  let (result,baseline)=row_delta::batch_with_patches(s.baseline.as_ref(),s.acquisition,&rows.projection,result,force,self.patch_connections.contains(&s.connection));s.baseline=Some(baseline);
  Ok(Publication{dependencies:s.query.dependencies(),connection:s.connection,subscription:s.local.clone(),acquisition:s.acquisition,topic:s.query.topic.clone(),schema:s.query.schema.clone(),result})
 }
 pub fn publish_topic(&mut self,topic:&str)->Result<Vec<Publication>,String>{let ready=self.runtime.catalog().topics().map(|(t,_)|t.to_owned()).collect();self.publish_topic_ready(topic,&ready)}
 pub fn publish_topic_ready(&mut self,topic:&str,ready:&BTreeSet<String>)->Result<Vec<Publication>,String>{
  let ids=self.subscriptions.iter().filter(|(_,s)|s.query.dependencies().contains(topic)&&s.query.dependencies().is_subset(ready)).map(|(k,_)|k.clone()).collect::<Vec<_>>();let mut out=Vec::new();
  for id in ids{
   let s=&self.subscriptions[&id];let connection=s.connection;let grouped=s.query.join.is_some()||s.query.group_by.is_some()||s.query.global==Some(true);let local=s.local.clone();let acquisition=s.acquisition;
   if self.resource_connections.contains(&connection){continue}
   let next=self.runtime.read(&id,s.query.offset,s.query.limit.min(4096),4*1024*1024);
   let publication=match next{Ok(next)=>{let changed=s.baseline.as_ref().is_none_or(|b|b.result["rows"]!=json!(next.rows)||b.result["keys"]!=json!(next.keys)||b.result["total_rows"]!=next.total_rows);if changed{self.publish_one(&id,false).map(Some)}else{Ok(None)}},Err(e)=>Err(e)};
   match publication {Ok(Some(p))=>out.push(p),Ok(None)=>{},Err(e) if grouped&&(e.starts_with("join query failed:")||e.starts_with("aggregate query failed:")||e=="projected result byte bound"||e=="result row bound; use viewport")=>{self.query_errors.push((connection,local,acquisition,e));self.runtime.close(&id)?;self.subscriptions.remove(&id);},Err(e) if e=="projected result byte bound"||e=="result row bound; use viewport"=>{self.resource_connections.insert(connection);},Err(e)=>return Err(e)}
  }
  // Resource exhaustion retires the offending connection, including any earlier
  // publications prepared for it in this cut. Authority/evaluator errors stay fatal.
  out.retain(|p|!self.resource_connections.contains(&p.connection));
  Ok(out)
 }
 pub fn disconnect(&mut self,connection:u64)->Result<(),String>{self.patch_connections.remove(&connection);let ids=self.subscriptions.iter().filter(|(_,s)|s.connection==connection).map(|(k,_)|k.clone()).collect::<Vec<_>>();for id in ids{self.runtime.close(&id)?;self.subscriptions.remove(&id);}Ok(())}
}

impl Request {pub fn requires_text(&self)->bool{match &self.command{Command::Open{query,..}|Command::ChangeQuery{query,..}=>query.predicate.as_ref().is_some_and(|p|p.requires_text())||query.having.as_ref().is_some_and(|p|p.requires_text()),_=>false}}}

impl Request {pub fn requires_global_having(&self)->bool{match &self.command{Command::Open{query,..}|Command::ChangeQuery{query,..}=>query.global.is_some()||query.having.is_some(),_=>false}}}

impl Request {pub fn requires_join(&self)->bool{matches!(&self.command,Command::Open{query,..}|Command::ChangeQuery{query,..} if query.join.is_some())}}

impl Request {pub fn join_output_within_source_limit(&self,limits:&BTreeMap<String,usize>)->bool{match &self.command{Command::Open{query,..}|Command::ChangeQuery{query,..}=>query.join.as_ref().is_none_or(|j|limits.get(&query.topic).is_some_and(|limit|j.limits.max_output_rows<=*limit)),_=>true}}}
