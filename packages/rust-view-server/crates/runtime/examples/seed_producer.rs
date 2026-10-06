//! Bounded batches through one persistent native producer. Generated descriptors admit every row.
#[cfg(feature = "kafka-canonical")]
fn admit_original_row(schema: &rust_differential_product_core::schema::Schema, row: &serde_json::Value, key: &str) -> Result<(), String> {
    let mut row = row.clone();
    let fields = row.as_object_mut().ok_or("submitted row must be an object")?;
    if fields.contains_key("rowId") { return Err("rowId comes only from the generated key decoder".into()); }
    fields.insert("rowId".into(), serde_json::Value::String(key.into()));
    schema.row(&row)?;
    Ok(())
}

#[cfg(feature = "kafka-canonical")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use product_source_ingestion::{generic_kafka::SourceConfig, generic_source::Decoder};
    use rdkafka::{
        ClientConfig, ClientContext, Message,
        producer::{BaseProducer, BaseRecord, DeliveryResult, Producer, ProducerContext},
    };
    use rust_differential_product_core::schema::{Catalog, Kind, Manifest};
    use serde_json::{Value, json};
    use std::{
        io::{BufRead, Write},
        sync::{Arc, Mutex},
        time::{Duration, Instant},
    };
    #[derive(Clone)]
    struct Context(Arc<Mutex<Vec<(usize, Result<(i32, i64), String>)>>>);
    impl ClientContext for Context {}
    impl ProducerContext for Context {
        type DeliveryOpaque = usize;
        fn delivery(&self, r: &DeliveryResult, index: usize) {
            self.0.lock().unwrap().push((
                index,
                r.as_ref()
                    .map(|m| (m.partition(), m.offset()))
                    .map_err(|(e, _)| e.to_string()),
            ));
        }
    }
    fn varint(mut n: u64, v: &mut Vec<u8>) {
        while n > 127 {
            v.push((n as u8 & 127) | 128);
            n >>= 7;
        }
        v.push(n as u8);
    }
    fn string(tag: u32, s: &str, v: &mut Vec<u8>) {
        varint((tag as u64) << 3 | 2, v);
        varint(s.len() as u64, v);
        v.extend(s.as_bytes());
    }
    fn frame(id: u32, index: u32, body: Vec<u8>) -> Vec<u8> {
        let mut v = vec![0];
        v.extend(id.to_be_bytes());
        if index == 0 {
            v.push(0);
        } else {
            v.push(2);
            varint((index as u64) << 1, &mut v);
        }
        v.extend(body);
        v
    }
    fn scalar(
        tag: u32,
        kind: Kind,
        value: &Value,
        out: &mut Vec<u8>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        match kind {
            Kind::Enum => return Err("expanded producer uses raw protobuf bytes".into()),
            Kind::String | Kind::Decimal => {
                string(tag, value.as_str().ok_or("string scalar")?, out)
            }
            Kind::Boolean => {
                varint((tag as u64) << 3, out);
                out.push(u8::from(value.as_bool().ok_or("bool scalar")?));
            }
            Kind::Number => {
                varint((tag as u64) << 3 | 1, out);
                out.extend(value.as_f64().ok_or("number scalar")?.to_le_bytes());
            }
            Kind::Int64 => {
                varint((tag as u64) << 3, out);
                varint(
                    value.as_str().ok_or("int64 scalar")?.parse::<i64>()? as u64,
                    out,
                );
            }
            Kind::Uint64 => {
                varint((tag as u64) << 3, out);
                varint(value.as_str().ok_or("uint64 scalar")?.parse::<u64>()?, out);
            }
        }
        Ok(())
    }
    fn hex(raw: &str) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        if raw.len() % 2 != 0 || !raw.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("raw hex".into());
        }
        Ok((0..raw.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&raw[i..i + 2], 16))
            .collect::<Result<Vec<_>, _>>()?)
    }
    let args = std::env::args().collect::<Vec<_>>();
    let config_path = std::path::Path::new(args.get(1).ok_or("configuration path required")?);
    // Every supported native demo writer must hold the same config-scoped lock.
    // A second CLI cannot bypass the live control authority's compare-and-swap journal.
    let writer_lock = std::fs::OpenOptions::new().create(true).read(true).write(true)
        .truncate(false).open(config_path.with_extension("writer.lock"))?;
    writer_lock.try_lock().map_err(|_| "this owned run already has a live native writer")?;
    let c: Value = serde_json::from_slice(&std::fs::read(config_path)?)?;
    let configs: Vec<SourceConfig> = serde_json::from_value(c["sources"].clone())?;
    let catalog = Catalog::new(serde_json::from_value::<Manifest>(c["catalog"].clone())?)?;
    let brokers = &configs[0].brokers;
    if !brokers.starts_with("127.0.0.1:") || configs.iter().any(|s| s.brokers != *brokers) {
        return Err("qualification producer requires one loopback broker".into());
    }
    let decoders = configs
        .iter()
        .map(|source| {
            let schema = catalog.schema(&source.topic, &source.schema)?.clone();
            Decoder::new_identity(
                schema,
                &source.key_descriptor,
                &source.value_descriptor,
                source.mapping.clone(),
                source.key_fields.clone(),
                source.identity.clone().ok_or("v2 identity")?,
            )
        })
        .collect::<Result<Vec<_>, String>>()?;
    let context = Context(Arc::new(Mutex::new(Vec::new())));
    let mut cfg = ClientConfig::new();
    cfg.set("bootstrap.servers", brokers)
        .set("enable.idempotence", "true")
        .set("transactional.id", format!("owned-demo-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos()))
        .set("acks", "all")
        .set("linger.ms", "5")
        .set("batch.num.messages", "1000")
        .set("queue.buffering.max.messages", "5000")
        .set("message.timeout.ms", "20000");
    let producer: BaseProducer<Context> = cfg.create_with_context(context.clone())?;
    producer.init_transactions(Duration::from_secs(30))?;
    println!("{{\"producer_ready\":true}}");
    std::io::stdout().flush()?;
    for line in std::io::stdin().lock().lines() {
        let started = Instant::now();
        let line = line?;
        if line.len() > 4 * 1024 * 1024 {
            return Err("batch input exceeds 4 MiB".into());
        }
        let batch: Value = serde_json::from_str(&line)?;
        let rows = batch["records"].as_array().ok_or("records array")?;
        if rows.is_empty() || rows.len() > 1000 {
            return Err("batch requires 1..1000 records".into());
        }
        producer.begin_transaction()?;
        let batch_result = (|| -> Result<Value, Box<dyn std::error::Error>> {
        let mut receipts = Vec::new();
        for (index, v) in rows.iter().enumerate() {
            if v.get("raw_key_hex").is_some() || v.get("raw_value_hex").is_some() { return Err("seed batches require generated schema admission".into()); }
            let source = configs
                .iter()
                .find(|s| Some(s.topic.as_str()) == v["topic"].as_str())
                .ok_or("unknown topic")?;
            let schema = catalog.schema(&source.topic, &source.schema)?;
            let delete = v["delete"] == true;
            let mut key = if schema.definition().format >= 2 {
                String::new()
            } else if delete {
                v["key"].as_str().ok_or("delete key")?.to_owned()
            } else {
                schema.row(&v["row"])?.key
            };
            let partition = v["partition"]
                .as_u64()
                .filter(|p| source.partitions.contains(&(*p as u32)))
                .ok_or("partition")?;
            let mut key_bytes = Vec::new();
            if schema.definition().format >= 2 {
                if v.get("raw_key_hex").is_none() {
                    for f in &source.key_fields {
                        scalar(
                            f.tag,
                            f.kind,
                            v["key"].get(&f.name).ok_or("missing fixture key field")?,
                            &mut key_bytes,
                        )?;
                    }
                }
            } else {
                string(source.key_tag, &key, &mut key_bytes);
            }
            let key_bytes = if let Some(raw) = v["raw_key_hex"].as_str() {
                hex(raw)?
            } else {
                frame(
                    source.key_descriptor.schema_id,
                    source.key_descriptor.message_index,
                    key_bytes,
                )
            };
            let mut body = Vec::new();
            if !delete {
                for m in &source.mapping {
                    let f = schema.field(&m.field)?;
                    let Some(value) = v["row"].get(&m.field) else {
                        continue;
                    };
                    if value.is_null() {
                        let tag = m.null_tag.ok_or("null marker")?;
                        varint((tag as u64) << 3, &mut body);
                        body.push(1);
                        continue;
                    }
                    scalar(m.tag, f.kind, value, &mut body)?;
                }
            }
            let payload = if let Some(raw) = v["raw_value_hex"].as_str() {
                hex(raw)?
            } else {
                frame(
                    source.value_descriptor.schema_id,
                    source.value_descriptor.message_index,
                    body,
                )
            };
            if schema.definition().format >= 2 {
                if v.get("raw_key_hex").is_none() && v.get("raw_value_hex").is_none() {
                    let d = &decoders[configs
                        .iter()
                        .position(|s| s.topic == source.topic)
                        .ok_or("source decoder")?];
                    key = d
                        .decode(Some(&key_bytes), if delete { None } else { Some(&payload) })?
                        .0;
                    if !delete { admit_original_row(schema, &v["row"], &key)?; }
                } else {
                    key = "raw-unvalidated".into();
                }
            }

            let record =
                BaseRecord::<Vec<u8>, Vec<u8>, usize>::with_opaque_to(&source.source_topic, index)
                    .partition(partition as i32)
                    .key(&key_bytes);
            let record = if delete {
                record
            } else {
                record.payload(&payload)
            };
            let record = if let Some(ms) = v["timestamp_ms"].as_i64() {
                record.timestamp(ms)
            } else {
                record
            };
            producer.send(record).map_err(|(e, _)| e)?;
            receipts.push(json!({"ack":v["ack"],"topic":source.topic,"key":key,"bytes":key_bytes.len()+if delete{0}else{payload.len()}}));
        }
        producer.flush(Duration::from_secs(30))?;
        let deliveries = std::mem::take(&mut *context.0.lock().unwrap());
        if deliveries.len() != receipts.len() {
            return Err("missing producer delivery receipts".into());
        }
        for (index, result) in deliveries {
            let (partition, offset) = result?;
            receipts[index]["partition"] = json!(partition);
            receipts[index]["offset"] = json!(offset);
        }
        // A delivery callback acknowledges a send, not a transaction commit.
        // Expose receipts only after read_committed consumers can observe the whole batch.
        producer.commit_transaction(Duration::from_secs(30))?;
        Ok(json!({"receipts":receipts,"batch_us":started.elapsed().as_micros(),"transaction_committed":true}))
        })();
        let committed = match batch_result {
            Ok(value) => value,
            Err(error) => {
                let _ = producer.abort_transaction(Duration::from_secs(30));
                return Err(error);
            }
        };
        println!("{committed}");
        std::io::stdout().flush()?;
    }
    producer.flush(Duration::from_secs(10))?;
    Ok(())
}
#[cfg(not(feature = "kafka-canonical"))]
fn main() {
    panic!("requires kafka-canonical")
}

#[cfg(all(test, feature = "kafka-canonical"))]
mod tests {
    use super::admit_original_row;
    use rust_differential_product_core::schema::{Catalog, Manifest, Scalar, encode_row_id};
    #[test]
    fn original_generated_row_rejects_extra_field_and_noncanonical_decimal() {
        let manifest: Manifest = serde_json::from_str(include_str!("../../../../../fixtures/proto-topics/catalog.json")).unwrap();
        let topic = manifest.topics.iter().find(|topic| topic.topic == "orders").unwrap().clone();
        let catalog = Catalog::new(manifest).unwrap();
        let schema = catalog.schema(&topic.topic, &topic.schema).unwrap();
        let key = encode_row_id(&[Scalar::String("order-000000".into())]).unwrap();
        let mut row = serde_json::json!({"orderId":"order-000000","customer":"Café","open":true,"units":"9007199254740993","price":"0.00123456789012345678"});
        admit_original_row(schema, &row, &key).unwrap();
        row["extra"] = serde_json::json!("would disappear on protobuf encoding");
        assert!(admit_original_row(schema, &row, &key).unwrap_err().contains("unknown row field"));
        row.as_object_mut().unwrap().remove("extra");
        row["price"] = serde_json::json!("1.0");
        assert!(admit_original_row(schema, &row, &key).is_err());
    }
}
