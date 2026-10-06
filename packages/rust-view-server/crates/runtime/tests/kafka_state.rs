#[path = "support/durable.rs"]
mod support;
use product_source_ingestion::{coordination::Record, kafka_state::*};
use std::collections::BTreeMap;
use support::*;
fn image() -> Image {
    let mut i = Image::empty(identity(), "test-group".into(), 2).unwrap();
    i.fold(0, i.manifest(0)).unwrap();
    for p in 0..2 {
        i.fold(p, Value::Cursor { next: 0 }).unwrap();
    }
    i
}
fn apply(i: &mut Image, p: u32, records: &[Record]) -> Vec<(u32, Value)> {
    let plan = i.plan(p, i.sequence, records).unwrap();
    for (p, v) in &plan.writes {
        i.fold(*p, v.clone()).unwrap();
    }
    i.audit().unwrap();
    plan.writes
}
#[test]
fn replay_conflict_sticky_tombstone_and_net_zero() {
    let mut i = image();
    let a = put(0, 4, "a", "9007199254740993.0001");
    apply(&mut i, 0, &[a.clone()]);
    assert!(i.plan(0, 1, &[a]).unwrap().writes.is_empty());
    assert!(
        i.plan(0, 1, &[put(0, 4, "a", "7")])
            .unwrap_err()
            .to_string()
            .contains("conflicting")
    );
    assert!(i.plan(0, 1, &[put(0, 3, "b", "7")]).is_err());
    apply(&mut i, 0, &[delete(0, 8, "a")]);
    assert!(i.rows["a"].1.is_none());
    assert!(i.plan(1, 2, &[put(1, 0, "a", "7")]).is_err());
    assert!(i.plan(1, 2, &[delete(1, 0, "a")]).is_err());
    apply(&mut i, 0, &[put(0, 9, "b", "7"), delete(0, 10, "b")]);
    assert!(i.rows["b"].1.is_none());
    assert_eq!(i.sequence, 3);
    assert_eq!(i.progress[&0].0, 10);
}
#[test]
fn uncompacted_and_compacted_replay_identical_with_gapped_offsets_and_ring_wrap() {
    let mut i = image();
    let mut log = vec![
        (0, i.manifest(0)),
        (0, Value::Cursor { next: 0 }),
        (1, Value::Cursor { next: 0 }),
    ];
    for n in 0..600 {
        let r = if n % 3 == 0 {
            delete(0, n * 256, "a")
        } else {
            put(0, n * 256, "a", "4.123")
        };
        log.extend(apply(&mut i, 0, &[r]));
    }
    let mut raw = Image::empty(identity(), "test-group".into(), 2).unwrap();
    for (p, v) in &log {
        raw.fold(*p, v.clone()).unwrap();
    }
    raw.audit().unwrap();
    let mut latest = BTreeMap::new();
    for (n, (p, v)) in log.iter().enumerate() {
        latest.insert((*p, v.key()), (n, *p, v.clone()));
    }
    let mut retained = latest.into_values().collect::<Vec<_>>();
    retained.sort_by_key(|v| v.0);
    let mut compact = Image::empty(identity(), "test-group".into(), 2).unwrap();
    for (_, p, v) in retained {
        compact.fold(p, v).unwrap();
    }
    compact.audit().unwrap();
    assert_eq!(
        serde_json::to_value(i.recovery().unwrap()).unwrap(),
        serde_json::to_value(compact.recovery().unwrap()).unwrap()
    );
    assert_eq!(raw.root, compact.root);
    assert_eq!(compact.records.len(), 256);
    assert_eq!(compact.batches.len(), 256);
    assert!(compact.plan(0, 600, &[put(0, 0, "a", "4.123")]).is_err());
}
#[test]
fn corrupt_missing_unknown_null_and_mispartitioned_fail_closed() {
    let mut i = image();
    let writes = apply(&mut i, 0, &[put(0, 0, "a", "1")]);
    for (p, v) in &writes {
        let bytes = encode(&identity(), *p, v).unwrap();
        assert_eq!(decode(&identity(), *p, &v.key(), Some(&bytes)).unwrap(), *v);
        assert!(decode(&identity(), 1, &v.key(), Some(&bytes)).is_err());
        assert!(decode(&identity(), *p, &v.key(), None).is_err());
        let mut j: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        j["format"] = serde_json::json!(99);
        assert!(
            decode(
                &identity(),
                *p,
                &v.key(),
                Some(&serde_json::to_vec(&j).unwrap())
            )
            .is_err()
        );
    }
    let mut missing = Image::empty(identity(), "test-group".into(), 2).unwrap();
    for (p, v) in writes {
        if !matches!(v, Value::Row { .. }) {
            missing.fold(p, v).unwrap();
        }
    }
    assert!(missing.audit().is_err());
    let mut missing = i.clone();
    missing.records.clear();
    assert!(missing.audit().is_err());
    let mut missing = i.clone();
    missing.batches.clear();
    assert!(missing.audit().is_err());
}
#[test]
fn failed_batch_has_no_staged_side_effects() {
    let i = image();
    let before = i.recovery().unwrap();
    assert!(
        i.plan(0, 0, &[put(0, 0, "a", "1"), put(1, 1, "b", "2")])
            .is_err()
    );
    assert_eq!(
        serde_json::to_value(before).unwrap(),
        serde_json::to_value(i.recovery().unwrap()).unwrap()
    );
}
#[test]
fn durable_control_gap_cursor_does_not_invent_a_product_version() {
    let mut i = image();
    let r = put(0, 0, "a", "7");
    apply(&mut i, 0, &[r.clone()]);
    let before = i.recovery().unwrap();
    i.fold(0, Value::Cursor { next: 10 }).unwrap();
    i.audit().unwrap();
    assert_eq!(
        serde_json::to_value(&before).unwrap(),
        serde_json::to_value(i.recovery().unwrap()).unwrap()
    );
    assert!(i.plan(0, 1, &[r]).unwrap().writes.is_empty());
    assert!(i.plan(0, 1, &[put(0, 5, "b", "2")]).is_err());
    apply(&mut i, 0, &[put(0, 10, "b", "2")]);
    assert_eq!(i.cursors[&0], 11);
}
