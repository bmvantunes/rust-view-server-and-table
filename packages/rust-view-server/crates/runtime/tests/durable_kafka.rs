#![cfg(feature = "kafka")]
#[path = "support/durable.rs"]
mod support;
use product_source_ingestion::{
    coordination::Limits,
    durable::*,
    kafka::{Config, KafkaSource},
    registry::*,
    wire::*,
};
use rdkafka::{
    ClientConfig, Offset, TopicPartitionList,
    consumer::{BaseConsumer, CommitMode, Consumer},
    mocking::MockCluster,
    producer::{BaseProducer, BaseRecord, Producer},
};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};
use support::*;
struct Fixture;
impl Registry for Fixture {
    fn lookup(&self, id: u32) -> Result<Metadata, String> {
        Ok(Metadata {
            schema_type: "PROTOBUF".into(),
            schema: match id {
                1 => include_str!("../fixtures/key.proto"),
                2 => include_str!("../fixtures/product-v2.proto"),
                _ => return Err("unknown ID".into()),
            }
            .into(),
            references: vec![],
        })
    }
}
fn offsets(inspector: &BaseConsumer) -> TopicPartitionList {
    let mut list = TopicPartitionList::new();
    list.add_partition("products", 0);
    list.add_partition("products", 1);
    inspector
        .committed_offsets(list, Duration::from_secs(5))
        .unwrap()
}
#[test]
fn sqlite_kafka_pressure_commit_authority_broker_ahead_and_restart() {
    let cluster = MockCluster::new(1).unwrap();
    cluster.create_topic("products", 2, 1).unwrap();
    let brokers = cluster.bootstrap_servers();
    let producer: BaseProducer = ClientConfig::new()
        .set("bootstrap.servers", &brokers)
        .create()
        .unwrap();
    for p in 0..2 {
        for i in 0..4 {
            let id = format!("p{p}-{i}");
            let key = frame(1, &ProductKey { id: id.clone() });
            let value = frame(
                2,
                &Product {
                    id,
                    category: "a".into(),
                    quantity: i64::MAX,
                    amount: format!("{i}.001"),
                    label: None,
                },
            );
            producer
                .send(
                    BaseRecord::to("products")
                        .partition(p)
                        .key(&key)
                        .payload(&value),
                )
                .unwrap();
        }
    }
    let key = frame(1, &ProductKey { id: "p0-0".into() });
    producer
        .send(
            BaseRecord::<Vec<u8>, Vec<u8>>::to("products")
                .partition(0)
                .key(&key),
        )
        .unwrap();
    producer.flush(Duration::from_secs(10)).unwrap();
    let dir = Directory::new();
    let shared = session(SqliteStore::create(dir.db(), identity()).unwrap(), "A");
    let mut c = coordinator(shared.clone());
    let group = format!("v8-{}", std::process::id());
    let config = || Config {
        brokers: brokers.clone(),
        group: group.clone(),
        topics: vec!["products".into()],
        options: BTreeMap::new(),
        limits: Limits {
            batches: 2,
            bytes: 65536,
            events: 2,
        },
    };
    let inspector: BaseConsumer = ClientConfig::new()
        .set("bootstrap.servers", &brokers)
        .set("group.id", &group)
        .set("partition.assignment.strategy", "cooperative-sticky")
        .set("session.timeout.ms", "10000")
        .set("enable.auto.commit", "false")
        .set("enable.auto.offset.store", "false")
        .create()
        .unwrap();
    let mut source = KafkaSource::connect_durable(
        config(),
        CachedRegistry::new(Fixture, 4).unwrap(),
        shared.clone(),
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while source.metrics().queue_depth < 2 {
        assert!(Instant::now() < deadline);
        source
            .poll_durable(&mut c, Duration::from_millis(50))
            .unwrap();
    }
    assert!(source.metrics().paused_partitions > 0);
    for _ in 0..10 {
        source
            .poll_durable(&mut c, Duration::from_millis(10))
            .unwrap();
        assert!(source.metrics().queue_depth <= 2);
        assert!(source.metrics().queued_bytes <= 65536);
    }
    let initial_leases = shared.lock().unwrap().leases();
    for l in initial_leases {
        assert!(source.commit_checkpoint(&mut c, &l).is_err());
    }
    assert!(
        offsets(&inspector)
            .elements()
            .iter()
            .all(|p| p.offset() == Offset::Invalid)
    );
    // Deliberate storage lock latency. Kafka background fetch remains capped; no decoded growth.
    // A channel proves the lock exists before apply, so timing is not used to order correctness.
    let path = dir.db();
    let (tx, rx) = std::sync::mpsc::channel();
    let slow = std::thread::spawn(move || {
        let conn = rusqlite::Connection::open(path).unwrap();
        conn.execute_batch("BEGIN IMMEDIATE").unwrap();
        tx.send(()).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        conn.execute_batch("COMMIT").unwrap();
    });
    rx.recv().unwrap();
    assert!(source.apply_next_durable(&mut c).unwrap());
    slow.join().unwrap();
    assert!(c.metrics().durable_transaction_ns >= 100_000_000);
    assert!(source.metrics().queue_depth <= 2);
    // Even after durable+engine completion, the broker is untouched until explicitly authorized.
    assert!(
        offsets(&inspector)
            .elements()
            .iter()
            .all(|p| p.offset() == Offset::Invalid)
    );
    let prefix = c.checkpoint().unwrap();
    assert_eq!(prefix.snapshot.last_source_batch, 1);
    let (&p, &last) = prefix.snapshot.offsets.iter().next().unwrap();
    assert_eq!(last, 0);
    let l = shared
        .lock()
        .unwrap()
        .leases()
        .into_iter()
        .find(|l| l.partition.partition == p)
        .unwrap();
    source.commit_checkpoint(&mut c, &l).unwrap();
    assert_eq!(
        offsets(&inspector)
            .find_partition("products", p as i32)
            .unwrap()
            .offset(),
        Offset::Offset(1)
    );
    assert!(source.metrics().resume_count > 0);
    // An external actor creates an impossible-under-our-protocol broker-ahead condition.

    println!(
        "DURABLE_IO_METRICS {}",
        serde_json::to_string(c.metrics()).unwrap()
    );
    println!(
        "KAFKA_PRESSURE_METRICS {}",
        serde_json::to_string(source.metrics()).unwrap()
    );
    source.shutdown();
    drop(source);
    drop(c);
    drop(shared);
    inspector.subscribe(&["products"]).unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    while inspector.assignment().unwrap().count() == 0 {
        assert!(Instant::now() < deadline);
        let _ = inspector.poll(Duration::from_millis(50));
    }
    let mut ahead = TopicPartitionList::new();
    ahead
        .add_partition_offset("products", p as i32, Offset::Offset(4))
        .unwrap();
    inspector.commit(&ahead, CommitMode::Sync).unwrap();
    inspector.unsubscribe();
    drop(inspector);
    let inspector: BaseConsumer = ClientConfig::new()
        .set("bootstrap.servers", &brokers)
        .set("group.id", &group)
        .set("partition.assignment.strategy", "cooperative-sticky")
        .set("session.timeout.ms", "10000")
        .set("enable.auto.commit", "false")
        .set("enable.auto.offset.store", "false")
        .create()
        .unwrap();
    let shared = session(SqliteStore::open(dir.db(), identity()).unwrap(), "B");
    let mut c = coordinator(shared.clone());
    let mut source = KafkaSource::connect_durable(
        config(),
        CachedRegistry::new(Fixture, 4).unwrap(),
        shared.clone(),
    )
    .unwrap();
    let mut inspector_store = SqliteStore::open(dir.db(), identity()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while inspector_store.load().unwrap().snapshot.offsets != BTreeMap::from([(0, 4), (1, 3)]) {
        assert!(
            Instant::now() < deadline,
            "restart deadline offsets={:?} leases={:?} metrics={:?}",
            inspector_store.load().unwrap().snapshot.offsets,
            shared.lock().unwrap().leases(),
            source.metrics()
        );
        source
            .poll_durable(&mut c, Duration::from_millis(50))
            .unwrap();
        while source.apply_next_durable(&mut c).unwrap() {}
    }
    let result = c.checkpoint().unwrap();
    assert_eq!(result.snapshot.rows.len(), 7);
    assert_eq!(result.snapshot.version, 9);
    assert!(!result.snapshot.rows.iter().any(|r| r.id == "p0-0"));
    let leases = shared.lock().unwrap().leases();
    for l in leases {
        source.commit_checkpoint(&mut c, &l).unwrap();
    }
    let broker = offsets(&inspector);
    assert_eq!(
        broker.find_partition("products", 0).unwrap().offset(),
        Offset::Offset(5)
    );
    assert_eq!(
        broker.find_partition("products", 1).unwrap().offset(),
        Offset::Offset(4)
    );
    source.shutdown();
    println!(
        "SQLite + librdkafka MOCK protocol recovery verified; NOT real broker/power loss qualification"
    );
}

#[test]
fn mock_sdk_batches_real_decoded_records_and_flushes_final_partial_batch() {
    use product_source_ingestion::coordination::BatchLimits;
    let cluster=MockCluster::new(1).unwrap();cluster.create_topic("products",1,1).unwrap();
    let producer:BaseProducer=ClientConfig::new().set("bootstrap.servers",cluster.bootstrap_servers()).create().unwrap();
    for i in 0..7 {
        let id=format!("batch-{i}");let key=frame(1,&ProductKey{id:id.clone()});
        let value=frame(2,&Product{id,category:"a".into(),quantity:i64::MAX,amount:format!("{i}.0001"),label:None});
        producer.send(BaseRecord::to("products").partition(0).key(&key).payload(&value)).unwrap();
    }
    producer.flush(Duration::from_secs(10)).unwrap();
    let dir=Directory::new();let shared=session(SqliteStore::create(dir.db(),identity()).unwrap(),"batch-owner");
    let mut c=coordinator(shared.clone());
    let mut source=KafkaSource::connect_durable(Config{brokers:cluster.bootstrap_servers(),group:format!("v9-batch-{}",std::process::id()),topics:vec!["products".into()],options:BTreeMap::new(),limits:Limits{batches:4,bytes:65536,events:16}},CachedRegistry::new(Fixture,4).unwrap(),shared.clone()).unwrap();
    source.set_batch_limits(BatchLimits{records:3,bytes:65536,latency_ms:250}).unwrap();
    let deadline=Instant::now()+Duration::from_secs(30);
    while source.metrics().completed_records<7 {
        assert!(Instant::now()<deadline,"mock batch deadline {:?}",source.metrics());
        source.poll_durable(&mut c,Duration::from_millis(20)).unwrap();
        while source.apply_next_durable(&mut c).unwrap() {}
        assert!(source.metrics().buffered_bytes<=65536+2*1024*1024);
        assert!(source.metrics().building_bytes<=source.metrics().queued_bytes);
    }
    assert!(source.metrics().completed_batches<7,"SDK must exercise multi-record path");
    let r=c.checkpoint().unwrap();assert_eq!(r.snapshot.rows.len(),7);assert_eq!(r.snapshot.offsets[&0],6);
    let leases=shared.lock().unwrap().leases();
    for lease in leases {source.commit_checkpoint(&mut c,&lease).unwrap();}
    // Release mutex before shutdown (the loop temporary is already dropped).
    source.shutdown();assert_eq!(source.metrics().buffered_bytes,0);
}

#[test]
fn mock_many_partition_batches_tombstones_and_exact_authorized_offsets() {
    use product_source_ingestion::coordination::BatchLimits;
    let cluster=MockCluster::new(1).unwrap();cluster.create_topic("products",16,1).unwrap();
    let producer:BaseProducer=ClientConfig::new().set("bootstrap.servers",cluster.bootstrap_servers()).create().unwrap();
    for p in 0..16 {
    for i in 0..7 {
        let id=format!("batch-{p}-{i}");let key=frame(1,&ProductKey{id:id.clone()});
        let value=frame(2,&Product{id,category:"a".into(),quantity:i64::MAX,amount:format!("{i}.0001"),label:None});
        producer.send(BaseRecord::to("products").partition(p).key(&key).payload(&value)).unwrap();
    }
    let key=frame(1,&ProductKey{id:format!("batch-{p}-0")});
    producer.send(BaseRecord::<Vec<u8>,Vec<u8>>::to("products").partition(p).key(&key)).unwrap();
    }
    producer.flush(Duration::from_secs(10)).unwrap();
    let dir=Directory::new();let shared=session(SqliteStore::create(dir.db(),identity()).unwrap(),"batch-owner");
    let mut c=coordinator(shared.clone());
    let mut source=KafkaSource::connect_durable(Config{brokers:cluster.bootstrap_servers(),group:format!("v10-many-{}",std::process::id()),topics:vec!["products".into()],options:BTreeMap::new(),limits:Limits{batches:4,bytes:65536,events:16}},CachedRegistry::new(Fixture,4).unwrap(),shared.clone()).unwrap();
    source.set_batch_limits(BatchLimits{records:3,bytes:65536,latency_ms:250}).unwrap();
    let deadline=Instant::now()+Duration::from_secs(30);
    while source.metrics().completed_records<128 {
        assert!(Instant::now()<deadline,"mock batch deadline {:?}",source.metrics());
        source.poll_durable(&mut c,Duration::from_millis(20)).unwrap();
        while source.apply_next_durable(&mut c).unwrap() {}
        assert!(source.metrics().buffered_bytes<=65536+2*1024*1024);
        assert!(source.metrics().building_bytes<=source.metrics().queued_bytes);
    }
    assert!(source.metrics().completed_batches<128,"SDK must exercise multi-record path");
    let r=c.checkpoint().unwrap();assert_eq!(r.snapshot.rows.len(),96);for p in 0..16{assert_eq!(r.snapshot.offsets[&p],7);assert!(!r.snapshot.rows.iter().any(|r|r.id==format!("batch-{p}-0")));}
    let leases=shared.lock().unwrap().leases();
    for lease in leases {source.commit_checkpoint(&mut c,&lease).unwrap();}
    // Release mutex before shutdown (the loop temporary is already dropped).
    source.shutdown();assert_eq!(source.metrics().buffered_bytes,0);
}
