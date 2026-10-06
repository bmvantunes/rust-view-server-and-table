use product_source_ingestion::coordination::*;
use rust_differential_product_core::{
    engine_contract::{
        EngineCompletion, EngineStats, ProductEngine, SelectedProductEngine as Engine,
    },
    product::{
        ExactDecimal, ExactInteger, OptionalString, ProductCommand, ProductResult, ProductRow,
    },
    source::{ProductMutation, SourceBatch, SourceCommit, SourceMutation},
    topic::{RowId, TopicSnapshot, TopicStore},
};
use std::collections::BTreeMap;
fn authority() -> Authority {
    Authority::default()
}
fn partition(p: u32) -> Partition {
    Partition {
        topic: "products".into(),
        partition: p,
    }
}
fn empty() -> Recovery {
    Recovery {
        snapshot: TopicStore::default().snapshot(),
        recent: BTreeMap::new(),
    }
}
fn coordinator(a: &Authority) -> Coordinator<Engine> {
    Coordinator::restore(empty(), a.clone()).unwrap()
}
fn event(p: u32, o: u64, id: &str, value: &str) -> Record {
    Record::new(SourceMutation {
        partition: p,
        offset: o,
        mutation: ProductMutation::Upsert {
            row: ProductRow {
                id: id.into(),
                category: "c".into(),
                label: OptionalString::Missing,
                quantity: ExactInteger::parse("9223372036854775807").unwrap(),
                amount: ExactDecimal::parse(value).unwrap(),
            },
        },
    })
}
fn delivery(l: &Lease, o: u64, id: &str) -> Delivery {
    Delivery {
        lease: l.clone(),
        records: vec![event(l.partition.partition, o, id, "9007199254740993.01")],
    }
}
fn limits() -> Limits {
    Limits {
        batches: 8,
        bytes: 100000,
        events: 100,
    }
}
#[test]
fn revocation_fences_idle_decoded_pending_reassignment_and_shutdown() {
    let a = authority();
    let mut c = coordinator(&a);
    let l = a.assign(partition(0)).unwrap();
    assert!(a.assign(partition(0)).is_err());
    let decoded = delivery(&l, 0, "a");
    let mut q = BoundedQueue::new(limits()).unwrap();
    q.push(decoded.clone()).unwrap();
    let other = a.assign(partition(1)).unwrap();
    q.push(delivery(&other, 0, "b")).unwrap();
    a.revoke(&partition(0));
    assert!(c.apply(&decoded).is_err());
    q.discard_stale(&a);
    assert_eq!(q.metrics().queue_depth, 1);
    c.apply(&q.pop().unwrap()).unwrap();
    let new = a.assign(partition(0)).unwrap();
    assert_ne!(new.epoch, l.epoch);
    assert!(c.apply(&decoded).is_err());
    c.apply(&delivery(&new, 0, "a")).unwrap();
    a.revoke(&partition(0));
    a.shutdown();
    assert!(a.assign(partition(0)).is_err());
    assert!(c.apply(&delivery(&other, 1, "x")).is_err());
    assert_eq!(c.checkpoint().unwrap().snapshot.rows.len(), 2);
}
#[test]
fn replay_is_exact_bounded_survives_restart_and_new_equal_values_do_not_dirty() {
    let a = authority();
    let l = a.assign(partition(0)).unwrap();
    let mut c = coordinator(&a);
    let d = delivery(&l, 10, "a");
    let first = c.apply(&d).unwrap().unwrap();
    assert!(c.apply(&d).unwrap().is_none());
    assert_eq!(c.checkpoint().unwrap().snapshot.version, 1);
    let mut conflict = d.clone();
    conflict.records[0] = event(0, 10, "a", "5");
    assert!(c.apply(&conflict).unwrap_err().contains("conflicting"));
    let mut forged = d.clone();
    forged.records[0].event = event(0, 10, "a", "99").event; // retain original advertised wire identity
    assert!(c.apply(&forged).unwrap_err().contains("conflicting"));
    assert!(c.apply(&delivery(&l, 9, "a")).is_err()); // never-observed old position
    let new = c.apply(&delivery(&l, 15, "a")).unwrap().unwrap();
    assert_eq!(new.product_version, first.product_version);
    assert!(new.dirty_subscriptions.is_empty());
    assert_eq!(new.topic_version, 2);
    let encoded = serde_json::to_vec(&c.checkpoint().unwrap()).unwrap();
    let mut restored: Coordinator<Engine> =
        Coordinator::restore(serde_json::from_slice(&encoded).unwrap(), a.clone()).unwrap();
    assert!(restored.apply(&d).unwrap().is_none());
    assert!(restored.apply(&conflict).is_err());
    for o in 16..16 + RECENT_EVENTS as u64 {
        restored.apply(&delivery(&l, o, "a")).unwrap();
    }
    assert_eq!(
        restored.checkpoint().unwrap().recent[&0].len(),
        RECENT_EVENTS
    );
    assert!(restored.apply(&d).unwrap_err().contains("horizon"));
}
#[test]
fn full_batch_validation_and_net_cancellation() {
    let a = authority();
    let l = a.assign(partition(0)).unwrap();
    let mut c = coordinator(&a);
    let initial = c.checkpoint().unwrap().snapshot;
    for bad in [
        event(0, u64::MAX, "bad", "1"),
        event(1, 1, "bad", "1"),
        event(0, 1, "", "1"),
    ] {
        let d = Delivery {
            lease: l.clone(),
            records: vec![event(0, 0, "valid", "1"), bad],
        };
        assert!(c.apply(&d).is_err());
        assert_eq!(c.checkpoint().unwrap().snapshot, initial);
    }
    let d = Delivery {
        lease: l.clone(),
        records: vec![
            event(0, 0, "a", "1"),
            event(0, 1, "a", "2"),
            Record::new(SourceMutation {
                partition: 0,
                offset: 2,
                mutation: ProductMutation::Delete {
                    key: RowId("a".into()),
                },
            }),
        ],
    };
    let commit = c.apply(&d).unwrap().unwrap();
    assert_eq!(commit.product_version, 0);
    assert_eq!(commit.topic_version, 1);
    assert_eq!(c.applied_next(0), Some(3));
    assert!(c.checkpoint().unwrap().snapshot.rows.is_empty());
}
#[test]
fn quota_exact_boundary_plus_one_and_bounded_pressure() {
    let a = authority();
    let l = a.assign(partition(0)).unwrap();
    let d = delivery(&l, 0, "a");
    let bytes = d.bytes().unwrap();
    for quota in [
        Limits {
            batches: 1,
            bytes: bytes * 2,
            events: 2,
        },
        Limits {
            batches: 2,
            bytes,
            events: 2,
        },
        Limits {
            batches: 2,
            bytes: bytes * 2,
            events: 1,
        },
    ] {
        let mut q = BoundedQueue::new(quota).unwrap();
        q.push(d.clone()).unwrap();
        assert!(q.full());
        assert!(q.push(delivery(&l, 1, "b")).is_err());
        assert_eq!(q.metrics().queue_depth, 1);
        assert_eq!(q.metrics().queued_bytes, bytes);
        q.pop();
        assert!(!q.full());
        q.push(d.clone()).unwrap();
        assert_eq!(q.pop().unwrap().records[0].event.offset, 0);
    }
    let mut q = BoundedQueue::new(Limits {
        batches: 1,
        bytes: bytes - 1,
        events: 1,
    })
    .unwrap();
    assert!(q.push(d).is_err());
    assert_eq!(q.metrics().queued_bytes, 0);
}
#[test]
fn vector_snapshot_fast_slow_empty_new_revoked_overflow_restart() {
    let a = authority();
    let l0 = a.assign(partition(0)).unwrap();
    let l1 = a.assign(partition(1)).unwrap();
    let _empty = a.assign(partition(2)).unwrap();
    let mut c = coordinator(&a);
    c.apply(&delivery(&l0, 5, "p0")).unwrap();
    c.apply(&delivery(&l1, 99, "p1")).unwrap();
    let initial = c.checkpoint().unwrap();
    assert_eq!(initial.snapshot.offsets, BTreeMap::from([(0, 5), (1, 99)]));
    let mut capture = Capture::begin(&c, limits()).unwrap();
    for d in [
        delivery(&l0, 5, "p0"),
        delivery(&l0, 6, "p0-6"),
        delivery(&l0, 20, "p0-20"),
        delivery(&l1, 100, "p1-100"),
    ] {
        c.apply(&d).unwrap();
        capture.push(d).unwrap();
    }
    let recovered: Coordinator<Engine> = capture.finish().unwrap();
    assert_eq!(
        recovered.checkpoint().unwrap().snapshot,
        c.checkpoint().unwrap().snapshot
    );
    let mut overflow = Capture::begin(
        &c,
        Limits {
            batches: 1,
            bytes: 10000,
            events: 1,
        },
    )
    .unwrap();
    c.apply(&delivery(&l0, 21, "x")).unwrap();
    overflow.push(delivery(&l0, 21, "x")).unwrap();
    c.apply(&delivery(&l0, 22, "y")).unwrap();
    assert!(overflow.push(delivery(&l0, 22, "y")).is_err());
    assert_eq!(overflow.metrics().overflow_restarts, 1);
    assert!(overflow.finish::<Engine>().is_err());
    let restarted = Capture::begin(&c, limits())
        .unwrap()
        .finish::<Engine>()
        .unwrap();
    assert_eq!(
        restarted.checkpoint().unwrap().snapshot,
        c.checkpoint().unwrap().snapshot
    );
    assert_eq!(restarted.applied_next(0), Some(23));
    let revoked = Capture::begin(&c, limits()).unwrap();
    a.revoke(&partition(1));
    assert!(revoked.finish::<Engine>().is_err());
    let added = Capture::begin(&c, limits()).unwrap();
    a.assign(partition(3)).unwrap();
    assert!(added.finish::<Engine>().is_err());
}
struct DiskModel {
    checkpoint: Option<Recovery>,
    fail: bool,
}
impl DurableStore for DiskModel {
    fn persist(&mut self, c: &Recovery) -> Result<(), String> {
        if self.fail {
            return Err("injected atomic persistence failure".into());
        }
        self.checkpoint = Some(c.clone());
        Ok(())
    }
}
#[test]
fn crash_windows_never_commit_fetch_decode_or_volatile_completion() {
    let a = authority();
    let l = a.assign(partition(0)).unwrap();
    let mut c = coordinator(&a);
    let d = delivery(&l, 0, "a");
    assert_eq!(c.committable_next(&l).unwrap(), None);
    c.apply(&d).unwrap();
    assert_eq!(c.committable_next(&l).unwrap(), None);
    let mut disk = DiskModel {
        checkpoint: None,
        fail: true,
    };
    assert!(c.persist(&mut disk).is_err());
    assert_eq!(c.committable_next(&l).unwrap(), None);
    // A/D/E: no persistence means fresh reconstruction must replay, not use broker position.
    let mut restart = coordinator(&a);
    restart.apply(&d).unwrap();
    assert_eq!(
        restart.checkpoint().unwrap().snapshot,
        c.checkpoint().unwrap().snapshot
    );
    disk.fail = false;
    c.persist(&mut disk).unwrap();
    assert_eq!(c.committable_next(&l).unwrap(), Some(1));
    let mut restored: Coordinator<Engine> =
        Coordinator::restore(disk.checkpoint.unwrap(), a.clone()).unwrap();
    assert!(restored.apply(&d).unwrap().is_none()); // A after durable write
    a.revoke(&partition(0));
    assert!(c.committable_next(&l).is_err());
}
struct Failing {
    inner: Engine,
    failed: bool,
}
impl ProductEngine for Failing {
    fn load(s: TopicSnapshot) -> Result<Self, String> {
        Ok(Self {
            inner: Engine::load(s)?,
            failed: false,
        })
    }
    fn command(&mut self, c: ProductCommand) -> Result<EngineCompletion, String> {
        self.inner.command(c)
    }
    fn commit(&mut self, b: SourceBatch) -> Result<SourceCommit, String> {
        self.inner.commit(b)?;
        self.failed = true;
        Err("injected terminal engine completion failure".into())
    }
    fn read(&mut self, _: &str) -> Option<ProductResult> {
        None
    }
    fn observe(&self, keys: &[String]) -> Result<rust_differential_product_core::topic::SourceObservation, String> {
        rust_differential_product_core::topic::TopicStore::from_snapshot(self.checkpoint()?)?.observe(keys)
    }
    fn checkpoint(&self) -> Result<TopicSnapshot, String> {
        if self.failed {
            Err("terminal".into())
        } else {
            self.inner.checkpoint()
        }
    }
    fn engine_stats(&self) -> EngineStats {
        self.inner.engine_stats()
    }
    fn failure(&self) -> Option<&str> {
        self.failed.then_some("injected terminal failure")
    }
}
#[test]
fn terminal_engine_failure_fences_checkpoint_and_offsets() {
    let a = authority();
    let l = a.assign(partition(0)).unwrap();
    let mut c: Coordinator<Failing> = Coordinator::restore(empty(), a).unwrap();
    assert!(c.apply(&delivery(&l, 0, "a")).is_err());
    assert!(c.checkpoint().is_err());
    assert!(c.committable_next(&l).is_err());
    assert!(c.apply(&delivery(&l, 1, "b")).is_err());
    assert_eq!(c.applied_next(0), None);
}
#[test]
fn revoke_waits_for_inflight_commit_linearization() {
    use std::sync::{Arc, Mutex, mpsc};
    // Exercise Authority's same mutex through a deliberately blocked engine, without sleeps.
    struct Blocking {
        inner: Engine,
    }
    static CHANNELS: Mutex<Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>> = Mutex::new(None);
    impl ProductEngine for Blocking {
        fn load(s: TopicSnapshot) -> Result<Self, String> {
            Ok(Self {
                inner: Engine::load(s)?,
            })
        }
        fn command(&mut self, c: ProductCommand) -> Result<EngineCompletion, String> {
            self.inner.command(c)
        }
        fn commit(&mut self, b: SourceBatch) -> Result<SourceCommit, String> {
            let guard = CHANNELS.lock().unwrap();
            let (entered, release) = guard.as_ref().unwrap();
            entered.send(()).unwrap();
            release.recv().unwrap();
            self.inner.commit(b)
        }
        fn read(&mut self, s: &str) -> Option<ProductResult> {
            self.inner.read(s)
        }
        fn observe(&self, keys: &[String]) -> Result<rust_differential_product_core::topic::SourceObservation, String> {
        rust_differential_product_core::topic::TopicStore::from_snapshot(self.checkpoint()?)?.observe(keys)
    }
    fn checkpoint(&self) -> Result<TopicSnapshot, String> {
            self.inner.checkpoint()
        }
        fn engine_stats(&self) -> EngineStats {
            self.inner.engine_stats()
        }
        fn failure(&self) -> Option<&str> {
            None
        }
    }
    let a = authority();
    let l = a.assign(partition(0)).unwrap();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    *CHANNELS.lock().unwrap() = Some((entered_tx, release_rx));
    let a2 = a.clone();
    let d = delivery(&l, 0, "a");
    let worker = std::thread::spawn(move || {
        let mut c: Coordinator<Blocking> = Coordinator::restore(empty(), a2).unwrap();
        c.apply(&d).unwrap();
        c.checkpoint().unwrap()
    });
    entered_rx.recv().unwrap();
    let revoked = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = revoked.clone();
    let a3 = a.clone();
    let revoker = std::thread::spawn(move || {
        a3.revoke(&partition(0));
        flag.store(true, std::sync::atomic::Ordering::SeqCst);
    });
    assert!(!revoked.load(std::sync::atomic::Ordering::SeqCst));
    release_tx.send(()).unwrap();
    let recovery = worker.join().unwrap();
    revoker.join().unwrap();
    let mut c: Coordinator<Engine> = Coordinator::restore(recovery, a).unwrap();
    assert!(c.apply(&delivery(&l, 1, "b")).is_err());
}
