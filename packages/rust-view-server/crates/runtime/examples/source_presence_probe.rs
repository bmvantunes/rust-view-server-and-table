//! SOURCE-PRESENCE qualification: read-only canonical capture and committed source cuts.
use product_source_ingestion::generic_kafka::SourceConfig;
use rdkafka::{ClientConfig, Message, Offset, TopicPartitionList, consumer::{BaseConsumer, Consumer}, error::KafkaError};
use serde_json::{json, Value};
use std::{collections::{BTreeMap, BTreeSet}, time::{Duration, Instant}};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config: Value = serde_json::from_slice(&std::fs::read(std::env::args().nth(1).ok_or("config required")?)?)?;
    let sources: Vec<SourceConfig> = serde_json::from_value(config["sources"].clone())?;
    let mut result = BTreeMap::new();
    for source in sources {
        if !source.brokers.starts_with("127.0.0.1:") { return Err("private loopback qualification only".into()); }
        let reader: BaseConsumer = ClientConfig::new().set("bootstrap.servers", &source.brokers)
            .set("group.id", &source.group).set("enable.auto.commit", "false").set("enable.auto.offset.store", "false")
            .set("isolation.level", "read_committed").set("allow.auto.create.topics", "false")
            .set("enable.partition.eof", "true").create()?;
        let mut cuts = BTreeMap::new(); let mut assignment = TopicPartitionList::new();
        let mut source_partitions = TopicPartitionList::new();
        for p in &source.partitions {
            let (low,high)=reader.fetch_watermarks(&source.state_topic,*p as i32,Duration::from_secs(10))?;
            cuts.insert(*p,json!({"low":low,"high":high}));
            assignment.add_partition_offset(&source.state_topic,*p as i32,Offset::Beginning)?;
            source_partitions.add_partition(&source.source_topic,*p as i32);
        }
        let committed=reader.committed_offsets(source_partitions,Duration::from_secs(10))?.elements().iter()
            .map(|p|(p.partition().to_string(),format!("{:?}",p.offset()))).collect::<BTreeMap<_,_>>();
        reader.assign(&assignment)?;
        // A captured empty partition has no record to consume; some clients keep
        // its position at Invalid even after emitting its empty EOF.
        let mut done=cuts.iter().filter(|(_,cut)|cut["low"]==0&&cut["high"]==0).map(|(p,_)|*p).collect::<BTreeSet<_>>();
        let mut records=Vec::new(); let began=Instant::now();
        while done.len()<source.partitions.len() {
            if began.elapsed()>Duration::from_secs(20) { return Err("read-only canonical capture deadline".into()); }
            match reader.poll(Duration::from_millis(20)) {
                Some(Ok(m)) => { let p=m.partition() as u32;
                    if m.offset()<cuts[&p]["high"].as_i64().unwrap() {
                        records.push(json!({"partition":p,"offset":m.offset(),"key_hex":m.key().unwrap_or_default().iter().map(|b|format!("{b:02x}")).collect::<String>(),"envelope":serde_json::from_slice::<Value>(m.payload().ok_or("unexpected canonical tombstone")?)?}));
                    }
                    if m.offset()+1>=cuts[&p]["high"].as_i64().unwrap() { done.insert(p); }
                },
                Some(Err(KafkaError::PartitionEOF(p))) => { let pos=reader.position()?;
                    if pos.find_partition(&source.state_topic,p).is_some_and(|v|matches!(v.offset(),Offset::Offset(n) if n>=cuts[&(p as u32)]["high"].as_i64().unwrap())) { done.insert(p as u32); }
                },
                Some(Err(e)) => return Err(e.into()), None=>{},
            }
        }
        result.insert(source.topic,json!({"canonical_partition_cuts":cuts,"source_group_committed":committed,"records":records}));
    }
    println!("{}",serde_json::to_string(&result)?); Ok(())
}
