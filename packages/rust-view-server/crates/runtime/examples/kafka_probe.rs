#[cfg(feature = "kafka-canonical")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use product_source_ingestion::{
        durable::SourceIdentity,
        kafka_canonical::Config,
        kafka_state::{Image, decode},
        wire::{Product, ProductKey},
    };
    use prost::Message as ProstMessage;
    use rdkafka::{
        ClientConfig, Message, Offset, TopicPartitionList,
        consumer::{BaseConsumer, Consumer},
        producer::{BaseProducer, BaseRecord, Producer},
    };
    use std::{
        io::Read,
        time::{Duration, Instant},
    };
    let args = std::env::args().collect::<Vec<_>>();
    let c: serde_json::Value = serde_json::from_slice(&std::fs::read(&args[2])?)?;
    let config: Config = serde_json::from_value(c["mode"]["config"].clone())?;
    let source: SourceIdentity = serde_json::from_value(c["source"].clone())?;
    let d = Duration::from_secs(10);
    if args[1] == "feed-stream" {
        use std::io::{BufRead,Write};
        let p:BaseProducer=ClientConfig::new().set("bootstrap.servers",&config.brokers).set("enable.idempotence","true").set("acks","all").create()?;
        println!("{{\"producer_ready\":true}}");std::io::stdout().flush()?;
        for line in std::io::stdin().lock().lines(){let v:serde_json::Value=serde_json::from_str(&line?)?;let id=v["id"].as_str().ok_or("id")?;let mut key=vec![0,0,0,0,1,0];key.extend(ProductKey{id:id.into()}.encode_to_vec());let mut payload=vec![0,0,0,0,2,0];payload.extend(Product{id:id.into(),category:v["category"].as_str().unwrap_or("a").into(),quantity:v["quantity"].as_str().unwrap_or("1").parse()?,amount:v["amount"].as_str().unwrap_or("1").into(),label:Some(v["label"].as_str().unwrap_or("sample").into())}.encode_to_vec());p.send(BaseRecord::to(&source.topic).partition(v["partition"].as_i64().unwrap_or(0) as i32).key(&key).payload(&payload)).map_err(|(e,_)|e)?;p.flush(d)?;println!("{}",serde_json::json!({"ack":v["quantity"]}));std::io::stdout().flush()?;}
    } else if args[1] == "feed" || args[1] == "abort" || args[1] == "hold-source" {
        let mut text = String::new();
        if args[1] == "hold-source" {
            text = std::fs::read_to_string(&args[3])?;
        } else {
            std::io::stdin().read_to_string(&mut text)?;
        }
        let mut cfg = ClientConfig::new();
        cfg.set("bootstrap.servers", &config.brokers)
            .set("enable.idempotence", "true")
            .set("acks", "all");
        if args[1] != "feed" {
            cfg.set(
                "transactional.id",
                format!("aborted-source-{}", std::process::id()),
            );
        }
        let p: BaseProducer = cfg.create()?;
        if args[1] != "feed" {
            p.init_transactions(d)?;
            p.begin_transaction()?;
        }
        for line in text.lines() {
            let v: serde_json::Value = serde_json::from_str(line)?;
            let id = v["id"].as_str().unwrap();
            let mut key = vec![0, 0, 0, 0, 1, 0];
            key.extend(ProductKey { id: id.into() }.encode_to_vec());
            let mut payload = vec![0, 0, 0, 0, 2, 0];
            payload.extend(
                Product {
                    id: id.into(),
                    category: v["category"].as_str().unwrap_or("a").into(),
                    quantity: v["quantity"]
                        .as_str()
                        .unwrap_or("9007199254740993")
                        .parse()?,
                    amount: v["amount"]
                        .as_str()
                        .unwrap_or("1.234567890123456789")
                        .into(),
                    label: Some(v["label"].as_str().unwrap_or("nul\0 日本語").into()),
                }
                .encode_to_vec(),
            );
            let record = BaseRecord::<Vec<u8>, Vec<u8>>::to(&source.topic)
                .partition(v["partition"].as_i64().unwrap_or(0) as i32)
                .key(&key);
            let record = if v["delete"] == true {
                record
            } else {
                record.payload(&payload)
            };
            p.send(record).map_err(|(e, _)| e)?;
        }
        p.flush(d)?;
        if args[1] == "abort" {
            p.abort_transaction(d)?;
        }
        if args[1] == "hold-source" {
            use std::io::Write;
            println!("prepared");
            std::io::stdout().flush()?;
            let mut action = String::new();
            std::io::stdin().read_line(&mut action)?;
            if action.trim() == "commit" {
                p.commit_transaction(d)?;
            } else {
                p.abort_transaction(d)?;
            }
        }
        println!("{{\"fed\":true}}");
    } else if args[1] == "inspect" || args[1] == "inspect-state" {
        let n = c["expected_partitions"].as_array().unwrap().len() as u32;
        let consumer: BaseConsumer = ClientConfig::new()
            .set("bootstrap.servers", &config.brokers)
            .set("group.id", format!("probe-{}", std::process::id()))
            .set("enable.auto.commit", "false")
            .set("isolation.level", "read_committed")
            .set("enable.partition.eof", "true")
            .create()?;
        let mut tpl = TopicPartitionList::new();
        for p in 0..n {
            tpl.add_partition_offset(&config.state_topic, p as i32, Offset::Beginning)?;
        }
        consumer.assign(&tpl)?;
        let mut image = Image::empty(source.clone(), config.group.clone(), n)?;
        let mut done = std::collections::BTreeSet::new();
        let start = Instant::now();
        let mut records = 0u64;
        while done.len() < n as usize {
            if start.elapsed() > d {
                return Err("inspect deadline".into());
            }
            match consumer.poll(Duration::from_millis(10)) {
                Some(Ok(m)) => {
                    let v = decode(
                        &source,
                        m.partition() as u32,
                        m.key().ok_or("no key")?,
                        m.payload(),
                    )?;
                    image.fold(m.partition() as u32, v)?;
                    records += 1;
                }
                Some(Err(rdkafka::error::KafkaError::PartitionEOF(p))) => {
                    done.insert(p);
                }
                Some(Err(e)) => return Err(e.into()),
                None => {}
            }
        }
        image.audit()?;
        let mut source_list = TopicPartitionList::new();
        for p in 0..n {
            source_list.add_partition(&source.topic, p as i32);
        }
        let gc: BaseConsumer = ClientConfig::new()
            .set("bootstrap.servers", &config.brokers)
            .set("group.id", &config.group)
            .set("enable.auto.commit", "false")
            .create()?;
        let offsets = if args[1] == "inspect-state" {
            None
        } else {
            let committed = gc.committed_offsets(source_list, d)?;
            Some(
                committed
                    .elements()
                    .iter()
                    .map(|e| (e.partition(), format!("{:?}", e.offset())))
                    .collect::<std::collections::BTreeMap<_, _>>(),
            )
        };
        println!(
            "{}",
            serde_json::json!({"recovery":image.recovery()?,"source_next":image.cursors,"sticky":image.rows.len(),"records":records,"group_offsets":offsets})
        );
    } else {
        return Err("unknown probe operation".into());
    }
    Ok(())
}
#[cfg(not(feature = "kafka-canonical"))]
fn main() {
    panic!("requires kafka-canonical");
}
