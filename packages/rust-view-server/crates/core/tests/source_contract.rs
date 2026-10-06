use rust_differential_product_core::{
    engine_contract::{DifferentialProductEngine as Engine, ProductEngine},
    product::{
        CompareOp, Condition, Direction, ExactDecimal, ExactInteger, Expr, OptionalString,
        ProductCommand, ProductRow, Query,
    },
    source::{MAX_BATCH_MUTATIONS, ProductMutation, SnapshotHandoff, SourceBatch, SourceMutation},
    topic::{RowId, TopicStore},
};
fn row(id: &str, amount: &str) -> ProductRow {
    ProductRow {
        id: id.into(),
        category: "a".into(),
        label: OptionalString::Missing,
        quantity: ExactInteger::parse("9223372036854775807").unwrap(),
        amount: ExactDecimal::parse(amount).unwrap(),
    }
}
fn batch(sequence: u64, changes: Vec<ProductMutation>) -> SourceBatch {
    SourceBatch {
        topic: TopicStore::default().id().clone(),
        schema: "product-v1".into(),
        sequence,
        mutations: changes
            .into_iter()
            .enumerate()
            .map(|(i, mutation)| SourceMutation {
                partition: 0,
                offset: sequence * 10000 + i as u64,
                mutation,
            })
            .collect(),
    }
}
fn put(id: &str, amount: &str) -> ProductMutation {
    ProductMutation::Upsert {
        row: row(id, amount),
    }
}
fn del(id: &str) -> ProductMutation {
    ProductMutation::Delete {
        key: RowId(id.into()),
    }
}
fn engine() -> Engine {
    Engine::load(TopicStore::default().snapshot()).unwrap()
}
fn query(offset: u64) -> Query {
    Query {
        where_expr: Expr::True,
        direction: Direction::Ascending,
        offset,
        limit: 10,
    }
}
fn open(e: &mut Engine, id: &str, q: Query) {
    e.command(ProductCommand::Open {
        subscription: id.into(),
        query: q,
    })
    .unwrap();
}

#[test]
fn bounded_batches_validate_before_mutation_and_complete_atomically() {
    let mut e = engine();
    open(&mut e, "s", query(0));
    let initial = e.checkpoint().unwrap();
    let before = e.read("s").unwrap();
    for bad in [
        batch(1, vec![]),
        batch(1, vec![put("x", "1"); MAX_BATCH_MUTATIONS + 1]),
        batch(2, vec![put("x", "1")]),
        batch(1, vec![put("valid", "1"), put("", "2")]),
    ] {
        assert!(e.commit(bad).is_err());
        assert_eq!(e.checkpoint().unwrap(), initial);
        assert_eq!(e.read("s").unwrap(), before);
        assert!(e.failure().is_none());
    }
    let committed = e
        .commit(batch(1, vec![put("b", "2"), put("a", "1"), put("b", "3")]))
        .unwrap();
    assert_eq!(committed.topic_version, 1);
    assert_eq!(committed.product_version, before.version + 1);
    assert_eq!(committed.dirty_subscriptions, vec!["s"]);
    assert_eq!(
        e.read("s").unwrap().rows,
        vec![row("a", "1"), row("b", "3")]
    );
    // Net cancellation cannot expose an intermediate row or advance result version.
    let version = committed.product_version;
    let neutral = e
        .commit(batch(
            2,
            vec![
                put("a", "100"),
                put("a", "1"),
                put("temp", "4"),
                del("temp"),
            ],
        ))
        .unwrap();
    assert_eq!(neutral.topic_version, 2);
    assert_eq!(neutral.product_version, version);
    assert!(neutral.dirty_subscriptions.is_empty());
    assert!(e.commit(batch(2, vec![put("ignored-replay", "9")])).is_err());
    assert_eq!(e.topic().len(), 2); // immutable batch identity is the dedup contract
    assert!(
        e.command(ProductCommand::Delete { id: "a".into() })
            .is_err()
    );
    assert_eq!(e.checkpoint().unwrap().version, 2);
    let all = e.commit(batch(3, vec![del("a"), del("b")])).unwrap();
    assert_eq!(all.product_version, version + 1);
    assert_eq!(e.read("s").unwrap().total_rows, 0);
}

#[test]
fn snapshot_tail_replay_handoff_and_restart_are_coherent() {
    let mut live = engine();
    let b1 = batch(1, vec![put("a", "1"), put("b", "2")]);
    live.commit(b1.clone()).unwrap();
    let at_n = live.checkpoint().unwrap();
    let encoded = serde_json::to_vec(&at_n).unwrap();
    // Capture is registered at exactly the snapshot boundary. Mutations arrive
    // while that detached snapshot is being transferred, before a consumer exists.
    let mut capture = SnapshotHandoff::new(at_n.clone(), 8).unwrap();
    capture.push(b1).unwrap();
    let b2 = batch(2, vec![del("a"), put("c", "-1.21")]);
    let b3 = batch(3, vec![put("b", "-1.2")]);
    for b in [b2.clone(), b3.clone()] {
        live.commit(b.clone()).unwrap();
        capture.push(b).unwrap();
    }
    capture.push(b3).unwrap();
    assert_eq!(serde_json::to_vec(&at_n).unwrap(), encoded); // detached coherent snapshot
    let mut recovered: Engine = capture.finish().unwrap();
    assert_eq!(live.checkpoint().unwrap(), recovered.checkpoint().unwrap());
    open(&mut live, "s", query(0));
    open(&mut recovered, "s", query(0));
    let result = recovered.read("s").unwrap();
    assert_eq!(result.rows, vec![row("c", "-1.21"), row("b", "-1.2")]);
    assert_eq!(result.total_rows, 2);
    let checkpoint = recovered.checkpoint().unwrap();
    let mut restarted =
        Engine::load(serde_json::from_slice(&serde_json::to_vec(&checkpoint).unwrap()).unwrap())
            .unwrap();
    open(&mut restarted, "s", query(0));
    assert_eq!(restarted.read("s").unwrap().rows, result.rows);
    let b4 = batch(4, vec![put("d", "9007199254740993.01")]);
    for e in [&mut live, &mut recovered, &mut restarted] {
        e.commit(b4.clone()).unwrap();
        assert_eq!(e.read("s").unwrap().total_rows, 3);
    }
    assert_eq!(live.checkpoint().unwrap(), restarted.checkpoint().unwrap());
    println!("SOURCE_HANDOFF snapshot=1 tail=2,3 replay=1,3 live=4 restart=3 exact_rows=3");
}

#[test]
fn handoff_rejects_loss_and_source_metadata_violations() {
    let mut capture = SnapshotHandoff::new(TopicStore::default().snapshot(), 1).unwrap();
    capture.push(batch(1, vec![put("a", "1")])).unwrap();
    assert!(capture.push(batch(2, vec![put("b", "2")])).is_err());
    assert!(capture.finish::<Engine>().is_err());
    let mut gap = SnapshotHandoff::new(TopicStore::default().snapshot(), 3).unwrap();
    gap.push(batch(2, vec![put("a", "1")])).unwrap();
    assert!(gap.finish::<Engine>().is_err());
    let mut e = engine();
    e.commit(batch(1, vec![put("a", "1")])).unwrap();
    let before = e.checkpoint().unwrap();
    let mut wrong_offset = batch(2, vec![put("a", "2")]);
    wrong_offset.mutations[0].offset = 10000;
    let mut wrong_schema = batch(2, vec![put("a", "2")]);
    wrong_schema.schema = "unknown".into();
    let mut wrong_topic = batch(2, vec![put("a", "2")]);
    wrong_topic.topic.0 = "other".into();
    for b in [wrong_offset, wrong_schema, wrong_topic] {
        assert!(e.commit(b).is_err());
        assert_eq!(e.checkpoint().unwrap(), before);
    }
    // Different partitions can have independent/gapped offsets. The coordinator orders batches.
    let mut partition = batch(2, vec![put("b", "2"), put("c", "3")]);
    partition.mutations[0].partition = 1;
    partition.mutations[0].offset = 0;
    partition.mutations[1].offset = 50000;
    e.commit(partition).unwrap();
    let mut duplicate_snapshot = e.checkpoint().unwrap();
    duplicate_snapshot
        .rows
        .push(duplicate_snapshot.rows[0].clone());
    assert!(Engine::load(duplicate_snapshot).is_err());
    let mut wrong_checkpoint = e.checkpoint().unwrap();
    wrong_checkpoint.last_source_batch = 99;
    assert!(Engine::load(wrong_checkpoint).is_err());
}

#[test]
fn canonical_shapes_share_work_but_not_windows_or_ownership() {
    let mut e = engine();
    e.commit(batch(1, vec![put("a", "1"), put("b", "2")]))
        .unwrap();
    let a = Expr::Condition(Condition::CategoryEquals("a".into()));
    let amount = |v| {
        Expr::Condition(Condition::Amount {
            op: CompareOp::GreaterThanOrEqual,
            value: ExactDecimal::parse(v).unwrap(),
        })
    };
    let mut q = query(0);
    q.where_expr = Expr::And(vec![a.clone(), amount("1.00")]);
    let mut equivalent = query(1);
    equivalent.direction = Direction::Descending;
    equivalent.where_expr = Expr::And(vec![amount("1.0"), a.clone(), a.clone(), Expr::True]);
    assert_eq!(q.where_expr.canonical(), equivalent.where_expr.canonical());
    open(&mut e, "first", q);
    let scans = e.stats().query_seed_rows_scanned;
    open(&mut e, "second", equivalent);
    assert_eq!(e.engine_stats().query_shapes, 1);
    assert_eq!(e.stats().query_seed_rows_scanned, scans);
    assert_ne!(
        e.read("first").unwrap().query_generation,
        e.read("second").unwrap().query_generation
    );
    let mut different = query(0);
    different.where_expr = amount("2");
    open(&mut e, "third", different);
    assert_eq!(e.engine_stats().query_shapes, 2);
    e.command(ProductCommand::Close {
        subscription: "first".into(),
    })
    .unwrap();
    assert_eq!(e.engine_stats().query_shapes, 2);
    e.commit(batch(2, vec![put("b", "0")])).unwrap();
    assert_eq!(e.read("second").unwrap().total_rows, 1);
    for s in ["second", "third"] {
        e.command(ProductCommand::Close {
            subscription: s.into(),
        })
        .unwrap();
    }
    assert_eq!(e.engine_stats().query_shapes, 0);
    assert_eq!(e.engine_stats().subscriptions, 0);
    assert_ne!(a.canonical(), amount("1").canonical());
}

#[test]
fn v7_batch_identity_survives_snapshot_and_capture_byte_event_quotas() {
    use rust_differential_product_core::source::CaptureLimits;
    let mut e = engine();
    let b = batch(1, vec![put("a", "1")]);
    e.commit(b.clone()).unwrap();
    let mut restored = Engine::load(e.checkpoint().unwrap()).unwrap();
    assert!(restored.commit(b.clone()).unwrap().duplicate);
    assert!(restored.commit(batch(1, vec![put("a", "2")])).is_err());
    let bytes = serde_json::to_vec(&b).unwrap().len();
    for limits in [
        CaptureLimits { batches: 2, decoded_bytes: bytes, events: 2 },
        CaptureLimits { batches: 2, decoded_bytes: bytes * 2, events: 1 },
    ] {
        let mut capture = SnapshotHandoff::with_limits(TopicStore::default().snapshot(), limits).unwrap();
        capture.push(b.clone()).unwrap();
        assert_eq!(capture.usage().decoded_bytes, bytes);
        assert!(capture.push(b.clone()).is_err());
        assert_eq!(capture.usage().overflow_restarts, 1);
        assert!(capture.finish::<Engine>().is_err());
    }
    let mut snapshot = e.checkpoint().unwrap();
    snapshot.version = u64::MAX;
    let mut exhausted = Engine::load(snapshot).unwrap();
    assert!(exhausted.commit(batch(2, vec![put("b", "1")])).is_err());
    assert_eq!(exhausted.topic().len(), 1);
}
