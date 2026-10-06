#[path = "support/durable.rs"]
mod support;
use product_source_ingestion::{coordination::RECENT_EVENTS, durable::*};
use sha2::{Digest, Sha256};
use support::*;

#[test]
fn atomic_rows_positions_replay_partition_ownership_and_backup() {
    let dir = Directory::new();
    let mut a = SqliteStore::create(dir.db(), identity()).unwrap();
    let (p0, _) = a.acquire(0, "A").unwrap();
    let (p1, empty) = a.acquire(1, "A").unwrap();
    assert!(empty.snapshot.offsets.is_empty());
    a.commit(&p0, 0, &[put(0, 0, "a", "9007199254740993.0001")])
        .unwrap();
    let before = a.load().unwrap().snapshot;
    assert!(
        a.commit(&p1, 1, &[put(1, 0, "a", "9")])
            .unwrap_err()
            .to_string()
            .contains("another partition")
    );
    assert_eq!(a.load().unwrap().snapshot, before);
    a.commit(&p0, 1, &[put(0, 1, "a", "-2.5"), put(0, 2, "b", "0")])
        .unwrap();
    a.commit(&p1, 2, &[put(1, 0, "c", "3")]).unwrap();
    a.commit(&p0, 3, &[delete(0, 3, "a")]).unwrap();
    assert!(a.commit(&p1, 4, &[delete(1, 1, "a")]).is_err()); // deleted IDs retain routing
    assert!(a.commit(&p1, 4, &[put(1, 1, "a", "8")]).is_err());
    a.release(&p0).unwrap(); // removal from assignment keeps prefix and row ownership
    assert_eq!(a.load().unwrap().snapshot.rows.len(), 2);
    assert!(a.commit(&p0, 4, &[delete(0, 4, "b")]).is_err());
    let backup = dir.0.join("backup.db");
    a.backup(&backup).unwrap();
    let mut restored = SqliteStore::open(&backup, identity()).unwrap();
    assert_eq!(
        restored.load().unwrap().snapshot,
        a.load().unwrap().snapshot
    );
    drop(a);
    let mut b = SqliteStore::open(dir.db(), identity()).unwrap();
    let (p0b, checkpoint) = b.acquire(0, "B").unwrap();
    assert!(p0b.epoch() > p0.epoch());
    assert_eq!(checkpoint.snapshot.offsets[&0], 3);
    b.commit(&p0b, 4, &[put(0, 4, "b", "123.00000000000000001")])
        .unwrap();
    let result = b.load().unwrap();
    assert_eq!(
        result.snapshot.rows[0],
        match put(0, 4, "b", "123.00000000000000001").event.mutation {
            rust_differential_product_core::source::ProductMutation::Upsert { row } => row,
            _ => unreachable!(),
        }
    );
}
#[test]
fn separate_connections_fence_all_mutation_classes_and_same_process_reacquisition() {
    let dir = Directory::new();
    let mut a = SqliteStore::create(dir.db(), identity()).unwrap();
    let (old, _) = a.acquire(0, "A").unwrap();
    a.commit(&old, 0, &[put(0, 100, "a", "1")]).unwrap();
    let mut b = SqliteStore::open(dir.db(), identity()).unwrap();
    let (new, _) = b.acquire(0, "B").unwrap();
    assert_eq!(new.epoch(), old.epoch() + 1);
    for record in [
        put(0, 101, "a", "2"),
        delete(0, 101, "a"),
        put(0, 100, "a", "1"),
        put(0, 101, "a", "1"),
    ] {
        assert_eq!(a.commit(&old, 1, &[record]).unwrap_err(), Error::Fenced);
    }
    assert_eq!(
        a.label_checkpoint(&old, "stale snapshot").unwrap_err(),
        Error::Fenced
    );
    assert_eq!(a.release(&old).unwrap_err(), Error::Fenced);
    let mut called = false;
    assert_eq!(
        a.authorize(&old, 1, |_| {
            called = true;
            Ok(())
        })
        .unwrap_err(),
        Error::Fenced
    );
    assert!(!called);
    b.label_checkpoint(&new, "checkpoint through 100").unwrap();
    b.release(&new).unwrap();
    let (same, _) = b.acquire(0, "B").unwrap();
    assert!(same.epoch() > new.epoch());
    assert_eq!(
        b.commit(&new, 1, &[put(0, 101, "x", "2")]).unwrap_err(),
        Error::Fenced
    );
    b.commit(&same, 1, &[put(0, 101, "x", "2")]).unwrap();
    // Independent partition owners never overwrite a stale topic cut.
    let (other, _) = a.acquire(1, "A").unwrap();
    assert_eq!(
        a.commit(&other, 1, &[put(1, 0, "y", "1")]).unwrap_err(),
        Error::StaleSnapshot
    );
    assert_eq!(a.load().unwrap().snapshot.rows.len(), 2);
}
#[test]
fn replay_after_crash_preserves_semantics_and_rejects_conflicts_and_old_horizon() {
    let dir = Directory::new();
    let mut a = SqliteStore::create(dir.db(), identity()).unwrap();
    let (t, _) = a.acquire(0, "A").unwrap();
    let r = put(0, 100, "a", "1");
    a.commit(&t, 0, std::slice::from_ref(&r)).unwrap();
    drop(a);
    let mut b = SqliteStore::open(dir.db(), identity()).unwrap();
    let (t, old) = b.acquire(0, "B").unwrap();
    let replay = b.commit(&t, 1, std::slice::from_ref(&r)).unwrap();
    assert!(replay.batch.is_none());
    assert_eq!(b.load().unwrap().snapshot, old.snapshot);
    assert_eq!(b.authorize(&t, 1, Ok).unwrap(), 101);
    let mut forged = r.clone();
    forged.event = put(0, 100, "a", "2").event;
    for conflicting in [forged, put(0, 100, "a", "3")] {
        assert!(
            b.commit(&t, 1, &[conflicting])
                .unwrap_err()
                .to_string()
                .contains("conflicting")
        );
    }
    for n in 0..RECENT_EVENTS as u64 {
        b.commit(&t, n + 1, &[put(0, n + 101, "a", "1")]).unwrap();
    }
    assert!(
        b.commit(&t, 257, &[r])
            .unwrap_err()
            .to_string()
            .contains("horizon")
    );
    assert_eq!(b.load().unwrap().recent[&0].len(), 256);
}
#[test]
fn recovery_uses_durable_truth_not_broker_commit_and_retention_gap_is_typed() {
    let dir = Directory::new();
    let mut a = SqliteStore::create(dir.db(), identity()).unwrap();
    let (t, empty) = a.acquire(0, "A").unwrap();
    assert_eq!(recovery_next(&identity(), &empty, 0, 0, 0).unwrap(), 0);
    assert!(matches!(
        recovery_next(&identity(), &empty, 0, 2, 2),
        Err(Error::RetentionGap { required: 0, .. })
    ));
    a.commit(&t, 0, &[put(0, 99, "a", "1")]).unwrap();
    let r = a.load().unwrap();
    for _broker_next in [0, 99, 100, 101, 500] {
        assert_eq!(recovery_next(&identity(), &r, 0, 0, 200).unwrap(), 100);
    }
    assert_eq!(
        recovery_next(&identity(), &r, 0, 101, 200).unwrap_err(),
        Error::RetentionGap {
            topic: "products".into(),
            partition: 0,
            required: 100,
            earliest: 101,
            checkpoint: 1,
            incarnation: identity().incarnation
        }
    );
    assert_eq!(
        recovery_next(&identity(), &r, 0, 0, 99).unwrap_err(),
        Error::SourceTruncated {
            required: 100,
            high: 99
        }
    );
}
fn rewrite(path: &std::path::Path, change: impl FnOnce(&mut serde_json::Value)) {
    let conn = rusqlite::Connection::open(path).unwrap();
    let payload: Vec<u8> = conn
        .query_row("SELECT payload FROM canonical", [], |r| r.get(0))
        .unwrap();
    let mut v: serde_json::Value = serde_json::from_slice(&payload).unwrap();
    change(&mut v);
    let bytes = serde_json::to_vec(&v).unwrap();
    conn.execute(
        "UPDATE canonical SET payload=?1,digest=?2",
        rusqlite::params![&bytes, Sha256::digest(&bytes).as_slice()],
    )
    .unwrap();
}
#[test]
fn strict_format_metadata_incarnation_and_corruption_admission() {
    let dir = Directory::new();
    let mut s = SqliteStore::create(dir.db(), identity()).unwrap();
    let (t, _) = s.acquire(0, "A").unwrap();
    s.commit(&t, 0, &[put(0, 0, "a", "1")]).unwrap();
    drop(s);
    let mut changed = identity();
    changed.incarnation = "new-topic-lifetime".into();
    assert!(matches!(
        SqliteStore::open(dir.db(), changed),
        Err(Error::Identity)
    ));
    let mut changed = identity();
    changed.schema = "product-v2".into();
    assert!(matches!(
        SqliteStore::open(dir.db(), changed),
        Err(Error::Identity)
    ));
    assert!(SqliteStore::create(dir.db(), identity()).is_err());
    for kind in [
        "newer",
        "missing",
        "row-owner",
        "history",
        "checkpoint",
        "bytes",
        "sql-version",
    ] {
        let target = dir.0.join(format!("{kind}.db"));
        SqliteStore::open(dir.db(), identity())
            .unwrap()
            .backup(&target)
            .unwrap();
        match kind {
            "newer" => rewrite(&target, |v| v["format"] = 99.into()),
            "missing" => rewrite(&target, |v| {
                v.as_object_mut().unwrap().remove("source");
            }),
            "row-owner" => rewrite(&target, |v| v["row_partitions"]["a"] = 9.into()),
            "history" => { rusqlite::Connection::open(&target).unwrap().execute("UPDATE partitions SET digest=x'00'", []).unwrap(); },
            "checkpoint" => rewrite(&target, |v| {
                v["recovery"]["snapshot"]["last_source_batch"] = 99.into()
            }),
            "bytes" => {
                rusqlite::Connection::open(&target)
                    .unwrap()
                    .execute("UPDATE canonical SET payload=x'00'", [])
                    .unwrap();
            }
            _ => {
                rusqlite::Connection::open(&target)
                    .unwrap()
                    .execute("UPDATE canonical SET format=99", [])
                    .unwrap();
            }
        }
        assert!(SqliteStore::open(target, identity()).is_err(), "{kind}");
    }
    let missing = dir.0.join("missing.db");
    std::fs::write(&missing, []).unwrap();
    assert!(SqliteStore::open(missing, identity()).is_err());
}
#[test]
fn validation_and_precommit_fault_leave_no_partial_prefix() {
    let dir = Directory::new();
    let mut s = SqliteStore::create(dir.db(), identity()).unwrap();
    let (t, old) = s.acquire(0, "A").unwrap();
    for bad in [
        put(0, 1, "", "2"),
        put(1, 1, "b", "2"),
        put(0, u64::MAX, "b", "2"),
    ] {
        assert!(s.commit(&t, 0, &[put(0, 0, "a", "1"), bad]).is_err());
        assert_eq!(s.load().unwrap().snapshot, old.snapshot);
    }
    for point in [Point::BeforeTransaction, Point::BeforeCommit] {
        assert!(
            s.commit_with_hook(&t, 0, &[put(0, 0, "a", "1")], |p| if p == point {
                Err(Error::Storage("fault".into()))
            } else {
                Ok(())
            })
            .is_err()
        );
        assert_eq!(s.load().unwrap().snapshot, old.snapshot);
    }
    assert!(
        s.commit_with_hook(&t, 0, &[put(0, 0, "a", "1")], |p| {
            if p == Point::AfterCommit {
                Err(Error::Storage("lost acknowledgement".into()))
            } else {
                Ok(())
            }
        })
        .is_err()
    );
    assert_eq!(s.load().unwrap().snapshot.offsets[&0], 0);
}
#[test]
fn checked_in_v1_binary_fixture_remains_readable() {
    let dir = Directory::new();
    std::fs::write(dir.db(), include_bytes!("../fixtures/durable-format-v1.db")).unwrap();
    assert!(matches!(SqliteStore::open(dir.db(), identity()), Err(Error::Format(1))));
    SqliteStore::migrate_v1_offline(dir.db(), identity()).unwrap();
    let mut store = SqliteStore::open(dir.db(), identity()).unwrap();
    let (t, recovery) = store.acquire(0, "future-reader").unwrap();
    assert_eq!(recovery.snapshot.rows.len(), 4);
    assert_eq!(recovery.snapshot.offsets[&0], 3);
    assert_eq!(recovery.snapshot.last_source_batch, 1);
    let first = &recovery.snapshot.rows[0];
    assert_eq!(first.id, "row-000000");
    assert_eq!(
        serde_json::to_value(&first.quantity).unwrap(),
        serde_json::json!("9223372036854775807")
    );
    assert_eq!(
        serde_json::to_value(&first.amount).unwrap(),
        serde_json::json!({"coefficient":"1","scale":18})
    );
    assert_eq!(store.authorize(&t, 1, Ok).unwrap(), 4);
    store.commit(&t, 1, &[delete(0, 4, "row-000000")]).unwrap();
    assert_eq!(store.load().unwrap().snapshot.rows.len(), 3);
}
