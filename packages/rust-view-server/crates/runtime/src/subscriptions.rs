//! Single-owner query lifetime and publication policy. No sockets or engine internals.
use crate::{coordination::Delivery,durable::{DurableStore,Error},durable_coordinator::*};
use rust_differential_product_core::{engine_contract::ProductEngine,product::ProductCommand,source::SourceCommit};
use serde::{Deserialize,Serialize};
use std::collections::BTreeMap;
#[derive(Clone,Debug,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
 pub id:u64,pub acquisition:u64,pub previous_acquisition:Option<u64>,pub traceparent:String,
 pub command:ProductCommand,
 #[serde(default)] pub projection:Option<Vec<String>>,
}
#[derive(Clone,Debug,Serialize)]
pub struct Publication {pub connection:u64,pub subscription:String,pub acquisition:u64,pub projection:Vec<String>,pub group:ReadGroup}
#[derive(Clone,Copy,Debug,Deserialize,Serialize)]
#[serde(deny_unknown_fields)]
pub struct SubscriptionLimits {pub per_client:usize,pub total:usize}
impl Default for SubscriptionLimits {fn default()->Self{Self{per_client:16,total:64}}}
impl SubscriptionLimits {
 pub fn validate(self)->Result<Self,Error>{if self.per_client==0||self.per_client>128||self.total<self.per_client||self.total>256{return Err(Error::Invalid("subscription limits: per_client 1..128, total per_client..256".into()));}Ok(self)}
}
#[derive(Clone)]
struct Subscription {connection:u64,local:String,acquisition:u64,projection:Vec<String>}
pub struct Owner<E:ProductEngine,S:DurableStore> {
 pub coordinator:DurableCoordinator<E,S>,expected:Vec<u32>,incarnation:String,
 subscriptions:BTreeMap<String,Subscription>,pub failed:bool,pub resource_connections:Vec<u64>,pub bounds:ReadBounds,limits:SubscriptionLimits,pub grouped_extraction_ns:u64,
}
impl<E:ProductEngine,S:DurableStore> Owner<E,S> {
 pub fn new(coordinator:DurableCoordinator<E,S>,mut expected:Vec<u32>)->Result<Self,Error>{
  expected.sort_unstable();if expected.is_empty()||expected.len()>256||expected.windows(2).any(|p|p[0]==p[1]){return Err(Error::Invalid("expected partitions".into()));}
  let incarnation=coordinator.incarnation().to_owned();Ok(Self{coordinator,expected,incarnation,subscriptions:BTreeMap::new(),failed:false,resource_connections:vec![],bounds:ReadBounds::default(),limits:SubscriptionLimits::default(),grouped_extraction_ns:0})
 }
 pub fn with_limits(mut self,limits:SubscriptionLimits)->Result<Self,Error>{self.limits=limits.validate()?;Ok(self)}
 pub fn check_coverage(&mut self)->Result<(),Error>{
  if self.failed{return Err(Error::Invalid("publication owner failed".into()));}
  self.coordinator.recover_assignments()?;
  if self.coordinator.incarnation()!=self.incarnation || self.coordinator.covered_partitions()?!=self.expected {return Err(Error::Fenced);}
  Ok(())
 }
 pub fn current(&self,connection:u64,local:&str)->Option<u64>{self.subscriptions.get(&format!("{connection}/{local}")).map(|s|s.acquisition)}
 pub fn command(&mut self,connection:u64,request:&Request)->Result<Vec<Publication>,Error>{
  self.check_coverage()?;
  let projection=product_request_admission::admit_projection(request.projection.as_ref().map(|v|serde_json::to_value(v).unwrap()).as_ref()).map_err(Error::Invalid)?;
  let mut command=request.command.clone();
  let (local,replacing,closing)=match &command {
   ProductCommand::Open{subscription,..}|ProductCommand::ChangeQuery{subscription,..}=>(subscription.clone(),true,false),
   ProductCommand::ChangeWindow{subscription,..}=>(subscription.clone(),false,false),
   ProductCommand::Close{subscription}=>(subscription.clone(),false,true),
   _=>return Err(Error::Invalid("query socket cannot mutate source".into())),
  };
  if local.is_empty()||local.len()>128||request.acquisition==0||request.acquisition>9_007_199_254_740_991||request.id>9_007_199_254_740_991||request.traceparent.len()!=55 {return Err(Error::Invalid("identity bounds".into()));}
  let id=format!("{connection}/{local}");let prior=self.subscriptions.get(&id);
  if !replacing && prior.map(|s|s.acquisition)!=Some(request.acquisition){return Err(Error::Invalid("obsolete acquisition".into()));}
  if replacing && prior.is_some_and(|s|request.acquisition<=s.acquisition){return Err(Error::Invalid("non-increasing acquisition".into()));}
  if replacing && prior.is_none() && (self.subscriptions.values().filter(|s|s.connection==connection).count()>=self.limits.per_client||self.subscriptions.len()>=self.limits.total){return Err(Error::Invalid("subscription/shape budget".into()));}
  match &mut command {
   ProductCommand::Open{subscription,query}|ProductCommand::ChangeQuery{subscription,query}=>{if query.offset>9_007_199_254_740_991{return Err(Error::Invalid("window resource limit; use viewport <=1024".into()));}*subscription=id.clone();}
   ProductCommand::ChangeWindow{subscription,offset,limit}=>{if *limit>1024||*offset>9_007_199_254_740_991{return Err(Error::Invalid("window resource limit".into()));}*subscription=id.clone();}
   ProductCommand::Close{subscription}=>*subscription=id.clone(),_=>unreachable!(),
  }
  self.coordinator.command_bounded(command,1024,self.bounds.bytes / 4)?;
  if closing {self.subscriptions.remove(&id);return Ok(vec![]);}
  if replacing {self.subscriptions.insert(id.clone(),Subscription{connection,local,acquisition:request.acquisition,projection});}
  // Every successful query command returns a completed snapshot, including no-op
  // replacement/navigation. The ACK itself never duplicates rows.
  let output=self.publish(&[id]);if output.is_err(){self.failed=true;}output
 }
 pub fn apply(&mut self,delivery:&Delivery)->Result<Vec<Publication>,Error>{
  self.check_coverage()?;let completion=self.coordinator.apply(delivery)?;self.publish_completion(completion)
 }
 pub fn publish_completion(&mut self,completion:Option<SourceCommit>)->Result<Vec<Publication>,Error>{
  self.check_coverage()?;match completion {Some(c)=>self.publish(&c.dirty_subscriptions),None=>Ok(vec![])}
 }
 pub fn publish(&mut self,ids:&[String])->Result<Vec<Publication>,Error>{
  self.check_coverage()?;
  let selected=ids.iter().filter_map(|id|self.subscriptions.get(id).map(|s|(id.clone(),s.clone()))).collect::<Vec<_>>();
  let started=std::time::Instant::now();
  let mut output=vec![];
  // Four windows of at most 1024 rows per distinct atomic group. Never imply
  // that split groups are one transaction, even when their source cut is equal.
  for chunk in selected.chunks(4){
   let requests=chunk.iter().map(|(id,s)|ReadRequest{subscription:id.clone(),acquisition:s.acquisition}).collect::<Vec<_>>();
   let group=match self.coordinator.read_many(&requests,self.bounds) {
    Ok(g)=>g,
    Err(Error::Invalid(e)) if e.contains("budget") && !self.coordinator.terminal()=>{
     // Retry as distinct singleton admissions to identify only affected clients.
     for (id,s) in chunk {
      match self.coordinator.read_many(&[ReadRequest{subscription:id.clone(),acquisition:s.acquisition}],ReadBounds{requests:1,rows:1024,bytes:self.bounds.bytes/4}) {
       Ok(mut g)=>{g.results[0].subscription=s.local.clone();output.push(Publication{connection:s.connection,subscription:s.local.clone(),acquisition:s.acquisition,projection:s.projection.clone(),group:g});}
       Err(Error::Invalid(e)) if e.contains("budget")=>{self.resource_connections.push(s.connection);}
       Err(e)=>return Err(e),
      }
     }
     continue;
    }
    Err(e)=>return Err(e),
   };
   for (i,(_,s)) in chunk.iter().enumerate(){
    if group.results[i].rows.len()>1024 {self.resource_connections.push(s.connection);continue;}
    let mut result=group.results[i].clone();result.subscription=s.local.clone();
    output.push(Publication{connection:s.connection,subscription:s.local.clone(),acquisition:s.acquisition,projection:s.projection.clone(),
      group:ReadGroup{server_incarnation:group.server_incarnation.clone(),source_sequence:group.source_sequence,
       requests:vec![ReadRequest{subscription:s.local.clone(),acquisition:s.acquisition}],results:vec![result],estimated_bytes:group.estimated_bytes}});
   }
  }
  self.grouped_extraction_ns+=started.elapsed().as_nanos() as u64;
  Ok(output)
 }
 pub fn disconnect(&mut self,connection:u64)->Result<(),Error>{
  let ids=self.subscriptions.iter().filter(|(_,s)|s.connection==connection).map(|(id,_)|id.clone()).collect::<Vec<_>>();
  for id in ids {self.subscriptions.remove(&id);self.coordinator.command(ProductCommand::Close{subscription:id})?;}
  Ok(())
 }
 pub fn subscription_count(&self)->usize{self.subscriptions.len()}
}
