#![cfg(feature = "kafka")]
use product_source_ingestion::{
    coordination::*,
    kafka::{Config, KafkaSource},
    registry::*,
    wire::*,
};
use rdkafka::{
    ClientConfig, Offset,
    consumer::{BaseConsumer, Consumer},
    mocking::MockCluster,
    producer::{BaseProducer, BaseRecord, Producer},
};
use rust_differential_product_core::{
    engine_contract::SelectedProductEngine as Engine,
    topic::{TopicId, TopicStore},
};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};
struct Fixture;
impl Registry for Fixture {
    fn lookup(&self, id: u32) -> Result<Metadata, String> {
        Ok(Metadata {
            schema_type: "PROTOBUF".into(),
            schema: match id {
                1 => include_str!("../fixtures/key.proto"),
                2 => include_str!("../fixtures/product-v2.proto"),
                _ => return Err("unknown".into()),
            }
            .into(),
            references: vec![],
        })
    }
}
fn run(brokers: &str, topic: &str, model_durability: bool) {
    let producer: BaseProducer = ClientConfig::new()
        .set("bootstrap.servers", brokers)
        .create()
        .unwrap();
    for p in 0..2 {
        for i in 0..4 {
            let id = format!("p{p}-{i}");
            let k = frame(1, &ProductKey { id: id.clone() });
            let v = frame(
                2,
                &Product {
                    id,
                    category: "c".into(),
                    quantity: i64::MAX,
                    amount: "1.001".into(),
                    label: None,
                },
            );
            producer
                .send(BaseRecord::to(topic).partition(p).key(&k).payload(&v))
                .unwrap();
        }
    }
    let k = frame(1, &ProductKey { id: "p0-0".into() });
    producer
        .send(
            BaseRecord::<Vec<u8>, Vec<u8>>::to(topic)
                .partition(0)
                .key(&k),
        )
        .unwrap();
    producer.flush(Duration::from_secs(10)).unwrap();
    let group = format!("v7-{}", std::process::id());
    let a = Authority::default();
    let mut coordinator: Coordinator<Engine> = Coordinator::restore(
        Recovery {
            snapshot: TopicStore::new(TopicId(topic.into())).unwrap().snapshot(),
            recent: BTreeMap::new(),
        },
        a.clone(),
    )
    .unwrap();
    let make_config = || Config {
        brokers: brokers.into(),
        group: group.clone(),
        topics: vec![topic.into()],
        options: BTreeMap::new(),
        limits: Limits {
            batches: 2,
            bytes: 65536,
            events: 2,
        },
    };
    let mut source = KafkaSource::connect(
        make_config(),
        CachedRegistry::new(Fixture, 4).unwrap(),
        a.clone(),
        BTreeMap::new(),
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while source.metrics().queue_depth < 2 && Instant::now() < deadline {
        source.poll(Duration::from_millis(100)).unwrap();
    }
    assert_eq!(source.metrics().queue_depth, 2);
    assert!(source.metrics().paused_partitions > 0);
    // Deliberately blocked downstream while callbacks/heartbeats continue to be polled.
    for _ in 0..10 {
        source.poll(Duration::from_millis(10)).unwrap();
        assert!(source.metrics().queue_depth <= 2);
    }
    while coordinator.applied_next(0) != Some(5) || coordinator.applied_next(1) != Some(4) {
        assert!(
            Instant::now() < deadline,
            "consume deadline: {:?}",
            source.metrics()
        );
        while source.apply_next(&mut coordinator).unwrap() {}
        source.poll(Duration::from_millis(50)).unwrap();
    }
    assert_eq!(coordinator.checkpoint().unwrap().snapshot.rows.len(), 7);
    assert!(source.metrics().resume_count > 0);
    for lease in a.leases() {
        assert!(
            source
                .commit_durable(&coordinator, &lease)
                .unwrap_err()
                .contains("no durable")
        );
    }
    let inspector: BaseConsumer = ClientConfig::new()
        .set("bootstrap.servers", brokers)
        .set("group.id", &group)
        .create()
        .unwrap();
    let mut list = rdkafka::TopicPartitionList::new();
    list.add_partition(topic, 0);
    list.add_partition(topic, 1);
    let committed = inspector
        .committed_offsets(list, Duration::from_secs(5))
        .unwrap();
    assert!(
        committed
            .elements()
            .iter()
            .all(|p| p.offset() == Offset::Invalid)
    );
    if model_durability {
        struct PersistenceModel;
        impl DurableStore for PersistenceModel {
            fn persist(&mut self, _: &Recovery) -> Result<(), String> {
                Ok(())
            }
        }
        // Simulation only: this provider must never be used by a real source owner.
        coordinator.persist(&mut PersistenceModel).unwrap();
        for lease in a.leases() {
            source.commit_durable(&coordinator, &lease).unwrap();
        }
        let mut list = rdkafka::TopicPartitionList::new();
        list.add_partition(topic, 0);
        list.add_partition(topic, 1);
        let committed = inspector
            .committed_offsets(list, Duration::from_secs(5))
            .unwrap();
        assert_eq!(
            committed.find_partition(topic, 0).unwrap().offset(),
            Offset::Offset(5)
        );
        assert_eq!(
            committed.find_partition(topic, 1).unwrap().offset(),
            Offset::Offset(4)
        );
    }
    let recovery = coordinator.checkpoint().unwrap();
    let starts = recovery
        .snapshot
        .offsets
        .iter()
        .map(|(p, o)| {
            (
                Partition {
                    topic: topic.into(),
                    partition: *p,
                },
                o + 1,
            )
        })
        .collect();
    source.shutdown();
    drop(source);
    let a = Authority::default();
    let mut restored: Coordinator<Engine> = Coordinator::restore(recovery, a.clone()).unwrap();
    let mut source = KafkaSource::connect(
        make_config(),
        CachedRegistry::new(Fixture, 4).unwrap(),
        a.clone(),
        starts,
    )
    .unwrap();
    let k = frame(1, &ProductKey { id: "after".into() });
    let v = frame(
        2,
        &Product {
            id: "after".into(),
            category: "c".into(),
            quantity: 1,
            amount: "2".into(),
            label: None,
        },
    );
    producer
        .send(BaseRecord::to(topic).partition(0).key(&k).payload(&v))
        .unwrap();
    producer.flush(Duration::from_secs(5)).unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while restored.applied_next(0) != Some(6) {
        assert!(
            Instant::now() < deadline,
            "restart deadline offsets={:?} leases={:?} metrics={:?}",
            restored.checkpoint().unwrap().snapshot.offsets,
            a.leases(),
            source.metrics()
        );
        source.poll(Duration::from_millis(100)).unwrap();
        while source.apply_next(&mut restored).unwrap() {}
    }
    assert_eq!(restored.checkpoint().unwrap().snapshot.rows.len(), 8);
    source.shutdown();
}
#[test]
fn librdkafka_mock_protocol_source_pressure_tombstone_restart() {
    let cluster = MockCluster::new(1).unwrap();
    cluster.create_topic("v7-products", 2, 1).unwrap();
    run(&cluster.bootstrap_servers(), "v7-products", true);
    println!("LIBRDKAFKA MOCK protocol exercised; this is NOT real Kafka integration");
}
#[test]
#[ignore = "Requires explicitly supplied isolated V7_KAFKA_BROKERS and empty two-partition V7_KAFKA_TOPIC"]
fn real_isolated_kafka() {
    run(
        &std::env::var("V7_KAFKA_BROKERS").expect("isolated broker only"),
        &std::env::var("V7_KAFKA_TOPIC").expect("empty isolated fixture topic"),
        false,
    );
}
