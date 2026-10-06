//! Opt-in infrastructure proof; never part of Kafka-free fast tests.
#[cfg(feature = "kafka")]
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    use rdkafka::{
        ClientConfig, Message, Offset, TopicPartitionList,
        admin::{AdminClient, AdminOptions, NewTopic, TopicReplication},
        client::DefaultClientContext,
        consumer::{BaseConsumer, Consumer},
        error::KafkaError,
        producer::{BaseProducer, BaseRecord, Producer},
    };
    use std::{
        collections::BTreeSet,
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };
    let bootstrap = std::env::args()
        .nth(1)
        .ok_or("usage: orbstack_probe 127.0.0.1:PORT")?;
    let port: u16 = bootstrap
        .strip_prefix("127.0.0.1:")
        .ok_or("probe requires loopback broker")?
        .parse()?;
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let topic = format!("infra_native_probe_{}_{}", std::process::id(), nonce);
    let timeout = Duration::from_secs(20);
    let admin: AdminClient<DefaultClientContext> = ClientConfig::new()
        .set("bootstrap.servers", &bootstrap)
        .create()?;
    let options = AdminOptions::new().operation_timeout(Some(timeout));
    for result in admin
        .create_topics(
            &[NewTopic::new(&topic, 2, TopicReplication::Fixed(1)).set("retention.ms", "3600000")],
            &options,
        )
        .await?
    {
        result.map_err(|(_, code)| format!("create topic: {code:?}"))?;
    }
    let producer: BaseProducer = ClientConfig::new()
        .set("bootstrap.servers", &bootstrap)
        .set("transactional.id", format!("{topic}_writer"))
        .set("enable.idempotence", "true")
        .set("acks", "all")
        .set("message.timeout.ms", "15000")
        .create()?;
    producer.init_transactions(timeout)?;
    let metadata = producer.client().fetch_metadata(Some(&topic), timeout)?;
    if metadata.brokers().len() != 1
        || metadata.brokers()[0].host() != "127.0.0.1"
        || metadata.brokers()[0].port() != i32::from(port)
        || metadata.topics().len() != 1
        || metadata.topics()[0].partitions().len() != 2
    {
        return Err(format!("unexpected advertised metadata: {metadata:?}").into());
    }
    for (payload, commit) in [("aborted", false), ("committed", true)] {
        producer.begin_transaction()?;
        for partition in 0..2 {
            producer
                .send(
                    BaseRecord::to(&topic)
                        .partition(partition)
                        .key("same-key")
                        .payload(payload),
                )
                .map_err(|(error, _)| error)?;
        }
        producer.flush(timeout)?;
        if commit {
            producer.commit_transaction(timeout)?;
        } else {
            producer.abort_transaction(timeout)?;
        }
    }
    let mut proofs = serde_json::Map::new();
    for isolation in ["read_committed", "read_uncommitted"] {
        let consumer: BaseConsumer = ClientConfig::new()
            .set("bootstrap.servers", &bootstrap)
            .set("group.id", format!("{topic}_{isolation}"))
            .set("enable.auto.commit", "false")
            .set("enable.partition.eof", "true")
            .set("isolation.level", isolation)
            .create()?;
        let mut partitions = TopicPartitionList::new();
        for partition in 0..2 {
            partitions.add_partition_offset(&topic, partition, Offset::Beginning)?;
        }
        consumer.assign(&partitions)?;
        let deadline = Instant::now() + timeout;
        let mut done = BTreeSet::new();
        let mut records = Vec::new();
        while done.len() < 2 {
            if Instant::now() >= deadline {
                return Err(format!("{isolation} deadline expired").into());
            }
            match consumer.poll(Duration::from_millis(50)) {
                Some(Ok(message)) => {
                    records.push((
                        message.partition(),
                        message.offset(),
                        std::str::from_utf8(message.payload().ok_or("missing payload")?)?
                            .to_owned(),
                    ));
                }
                Some(Err(KafkaError::PartitionEOF(partition))) => {
                    done.insert(partition);
                }
                Some(Err(error)) => return Err(error.into()),
                None => (),
            }
        }
        records.sort();
        let values: Vec<_> = records
            .iter()
            .map(|(partition, _, value)| (*partition, value.as_str()))
            .collect();
        let expected = if isolation == "read_committed" {
            vec![(0, "committed"), (1, "committed")]
        } else {
            vec![
                (0, "aborted"),
                (0, "committed"),
                (1, "aborted"),
                (1, "committed"),
            ]
        };
        if values != expected {
            return Err(format!("{isolation} mismatch: {values:?}").into());
        }
        proofs.insert(isolation.into(), serde_json::to_value(&records)?);
    }
    println!(
        "{}",
        serde_json::json!({"nativeTransactionalProbe":"passed", "bootstrap":bootstrap,
        "advertisedHost":metadata.brokers()[0].host(), "advertisedPort":metadata.brokers()[0].port(),
        "topic":topic, "partitions":2, "records":proofs})
    );
    for result in admin.delete_topics(&[&topic], &options).await? {
        result.map_err(|(_, code)| format!("delete probe topic: {code:?}"))?;
    }
    Ok(())
}

#[cfg(not(feature = "kafka"))]
fn main() {
    eprintln!("The explicit infrastructure probe requires --features kafka");
    std::process::exit(2);
}
