//! Bounded read-only qualification capture; never commits offsets or canonical writes.
#[cfg(feature="kafka-canonical")]
fn main()->Result<(),Box<dyn std::error::Error>>{
 use rdkafka::{ClientConfig,Message,Offset,TopicPartitionList,consumer::{BaseConsumer,Consumer}};
 use serde_json::{Value,json};use std::{collections::{BTreeMap,BTreeSet},time::{Duration,Instant}};
 let args=std::env::args().collect::<Vec<_>>();let config:Value=serde_json::from_slice(&std::fs::read(&args[1])?)?;
 let hex=|b:&[u8]|b.iter().map(|v|format!("{v:02x}")).collect::<String>();
 for source in config["sources"].as_array().ok_or("sources")?{let brokers=source["brokers"].as_str().ok_or("brokers")?;if !brokers.starts_with("127.0.0.1:"){return Err("loopback qualification only".into());}
  for field in ["source_topic","state_topic"]{let topic=source[field].as_str().ok_or("topic")?;let consumer:BaseConsumer=ClientConfig::new().set("bootstrap.servers",brokers).set("group.id",format!("retention-snapshot-{}",std::process::id())).set("enable.auto.commit","false").set("enable.auto.offset.store","false").set("enable.partition.eof","true").set("isolation.level","read_committed").set("auto.offset.reset","error").create()?;
   let mut cuts=BTreeMap::new();let mut assignment=TopicPartitionList::new();for p in source["partitions"].as_array().ok_or("partitions")?{let p=p.as_i64().ok_or("partition")? as i32;let(low,high)=consumer.fetch_watermarks(topic,p,Duration::from_secs(10))?;cuts.insert(p,(low,high));assignment.add_partition_offset(topic,p,Offset::Offset(low))?;}consumer.assign(&assignment)?;
   let mut done=BTreeSet::new();let mut records=Vec::new();let start=Instant::now();while done.len()<cuts.len(){if start.elapsed()>Duration::from_secs(45){return Err("snapshot deadline".into());}match consumer.poll(Duration::from_millis(10)){Some(Ok(m))=>{if m.offset()>=cuts[&m.partition()].1{done.insert(m.partition());continue;}records.push(json!({"partition":m.partition(),"offset":m.offset(),"timestamp_ms":m.timestamp().to_millis(),"key_hex":m.key().map(&hex),"payload_hex":m.payload().map(&hex),"payload_utf8":if field=="state_topic"{m.payload().and_then(|b|std::str::from_utf8(b).ok())}else{None}}));},Some(Err(rdkafka::error::KafkaError::PartitionEOF(p)))=>{let pos=consumer.position()?;if pos.find_partition(topic,p).is_some_and(|v|matches!(v.offset(),Offset::Offset(n) if n>=cuts[&p].1)){done.insert(p);}},Some(Err(e))=>return Err(e.into()),None=>{}}}
   println!("{}",json!({"logical_topic":source["topic"],"kind":field,"topic":topic,"cuts":cuts,"records":records}));
  }
 }Ok(())
}
#[cfg(not(feature="kafka-canonical"))]fn main(){panic!("requires kafka-canonical")}
