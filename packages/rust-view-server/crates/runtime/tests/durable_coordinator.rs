#[path = "support/durable.rs"]
mod support;
use product_source_ingestion::{durable::*, durable_coordinator::*};
use rust_differential_product_core::{
    engine_contract::{
        EngineCompletion, EngineStats, ProductEngine, SelectedProductEngine as Engine,
    },
    product::*,
    source::{SourceBatch, SourceCommit},
    topic::TopicSnapshot,
};
use support::*;

fn queries(c: &mut DurableCoordinator<Engine, SqliteStore>) -> Vec<serde_json::Value> {
    let mut result = Vec::new();
    for (name, q) in [
        ("all", query()),
        (
            "deep",
            Query {
                direction: Direction::Descending,
                offset: 2,
                limit: 3,
                ..query()
            },
        ),
        (
            "a",
            Query {
                where_expr: Expr::Condition(Condition::CategoryEquals("a".into())),
                ..query()
            },
        ),
        (
            "empty",
            Query {
                offset: 99,
                ..query()
            },
        ),
    ] {
        c.command(ProductCommand::Open {
            subscription: name.into(),
            query: q,
        })
        .unwrap();
        let envelope = c.read(name).unwrap().unwrap();
        assert_eq!(envelope.server_incarnation, c.incarnation());
        result.push(serde_json::to_value(envelope.result).unwrap());
    }
    result
}
fn strip_ephemeral(v: &mut serde_json::Value) {
    // Full rows/ranks/totals/sequence/aggregate included. Restart resets local result version.
    v.as_object_mut().unwrap().remove("version");
}
#[test]
fn destroy_engine_rebuild_durable_truth_and_reacquire_complete_results() {
    let dir = Directory::new();
    let store = SqliteStore::create(dir.db(), identity()).unwrap();
    let shared = session(store, "A");
    let (l0, _) = shared.lock().unwrap().acquire(partition(0)).unwrap();
    let (l1, _) = shared.lock().unwrap().acquire(partition(1)).unwrap();
    let mut c = coordinator(shared.clone());
    for i in 0..12 {
        let p = i % 2;
        let l = if p == 0 { &l0 } else { &l1 };
        c.apply(&delivery(
            l,
            vec![put(
                p,
                (i / 2) as u64,
                &format!("{}-{i}", if i % 3 == 0 { "a" } else { "b" }),
                &format!("{}.0001", i as i64 - 6),
            )],
        ))
        .unwrap();
    }
    let mut before = queries(&mut c);
    let old_incarnation = c.incarnation().to_owned();
    let checkpoint = c.checkpoint().unwrap();
    assert_eq!(checkpoint.snapshot.rows.len(), 12);
    let no_op = c
        .apply(&delivery(&l0, vec![put(0, 6, "a-0", "-6.0001")]))
        .unwrap()
        .unwrap();
    assert!(no_op.dirty_subscriptions.is_empty());
    let checkpoint = c.checkpoint().unwrap();
    drop(c);
    drop(shared); // engine and all connection/session state destroyed
    let store = SqliteStore::open(dir.db(), identity()).unwrap();
    let shared = session(store, "B");
    shared.lock().unwrap().acquire(partition(0)).unwrap();
    shared.lock().unwrap().acquire(partition(1)).unwrap();
    let mut rebuilt = coordinator(shared);
    assert_ne!(old_incarnation, rebuilt.incarnation());
    assert!(rebuilt.read("all").unwrap().is_none());
    let mut after = queries(&mut rebuilt);
    for v in &mut before {
        strip_ephemeral(v)
    }
    for v in &mut after {
        strip_ephemeral(v)
    }
    assert_eq!(before, after);
    assert_eq!(checkpoint.snapshot, rebuilt.checkpoint().unwrap().snapshot);
    assert!(
        rebuilt
            .command(ProductCommand::Delete { id: "a-0".into() })
            .is_err()
    );
}
struct FailAfterApply {
    inner: Engine,
    failed: bool,
}
impl ProductEngine for FailAfterApply {
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
        Err("injected after engine apply".into())
    }
    fn read(&mut self, s: &str) -> Option<ProductResult> {
        self.inner.read(s)
    }
    fn observe(&self, keys: &[String]) -> Result<rust_differential_product_core::topic::SourceObservation, String> {
        self.inner.observe(keys)
    }
    fn checkpoint(&self) -> Result<TopicSnapshot, String> {
        self.inner.checkpoint()
    }
    fn engine_stats(&self) -> EngineStats {
        self.inner.engine_stats()
    }
    fn failure(&self) -> Option<&str> {
        self.failed.then_some("injected")
    }
}
#[test]
fn engine_failure_keeps_durable_prefix_blocks_broker_and_requires_new_engine() {
    let dir = Directory::new();
    let shared = session(SqliteStore::create(dir.db(), identity()).unwrap(), "A");
    let (l, _) = shared.lock().unwrap().acquire(partition(0)).unwrap();
    let mut c: DurableCoordinator<FailAfterApply, SqliteStore> =
        DurableCoordinator::new(shared.clone()).unwrap();
    let d = delivery(&l, vec![put(0, 100, "a", "1")]);
    assert!(c.apply(&d).is_err());
    assert!(c.terminal());
    let mut broker_called = false;
    assert!(
        c.commit_offset(&l, |_| {
            broker_called = true;
            Ok(())
        })
        .is_err()
    );
    assert!(!broker_called);
    assert!(c.apply(&delivery(&l, vec![put(0, 101, "b", "2")])).is_err());
    assert!(c.checkpoint().is_err());
    assert!(c.read("all").is_err());
    drop(c);
    drop(shared);
    let mut stored = SqliteStore::open(dir.db(), identity()).unwrap();
    assert_eq!(stored.load().unwrap().snapshot.offsets[&0], 100);
    let shared = session(stored, "B");
    let (l, _) = shared.lock().unwrap().acquire(partition(0)).unwrap();
    let mut rebuilt = coordinator(shared);
    assert!(rebuilt.apply(&delivery(&l, d.records)).unwrap().is_none());
    assert_eq!(rebuilt.commit_offset(&l, Ok).unwrap(), 101);
    assert_eq!(rebuilt.checkpoint().unwrap().snapshot.version, 1);
}
#[test]
fn reassignment_invalidates_subscriptions_staged_work_and_old_owner_reads() {
    let dir = Directory::new();
    let shared = session(SqliteStore::create(dir.db(), identity()).unwrap(), "A");
    let (old, _) = shared.lock().unwrap().acquire(partition(0)).unwrap();
    let mut c = coordinator(shared.clone());
    c.apply(&delivery(&old, vec![put(0, 0, "a", "1")])).unwrap();
    queries(&mut c);
    let prior = c.incarnation().to_owned();
    let staged = delivery(&old, vec![put(0, 1, "a", "2")]);
    shared.lock().unwrap().release(&partition(0)).unwrap();
    let (new, _) = shared.lock().unwrap().acquire(partition(0)).unwrap();
    assert!(c.apply(&staged).is_err());
    assert_ne!(c.incarnation(), prior);
    assert!(c.read("all").unwrap().is_none());
    c.apply(&delivery(&new, staged.records)).unwrap();
    assert_eq!(c.commit_offset(&new, Ok).unwrap(), 2);
    let mut challenger = SqliteStore::open(dir.db(), identity()).unwrap();
    challenger.acquire(0, "B").unwrap();
    assert!(c.read("all").is_err());
    assert!(
        c.command(ProductCommand::Open {
            subscription: "x".into(),
            query: query()
        })
        .is_err()
    );
    assert!(c.commit_offset(&new, Ok).is_err());
    assert!(c.apply(&delivery(&new, vec![put(0, 2, "a", "3")])).is_err());
    assert!(c.terminal());
}

struct Disagree { inner: Engine, changed: bool }
impl ProductEngine for Disagree {
    fn load(s:TopicSnapshot)->Result<Self,String>{Ok(Self{inner:Engine::load(s)?,changed:false})}
    fn command(&mut self,c:ProductCommand)->Result<EngineCompletion,String>{self.inner.command(c)}
    fn commit(&mut self,b:SourceBatch)->Result<SourceCommit,String>{let c=self.inner.commit(b)?;self.changed=true;Ok(c)}
    fn read(&mut self,s:&str)->Option<ProductResult>{self.inner.read(s)}
    fn checkpoint(&self)->Result<TopicSnapshot,String>{panic!("ordinary reconciliation called full checkpoint")}
    fn observe(&self,k:&[String])->Result<rust_differential_product_core::topic::SourceObservation,String>{
        let mut o=self.inner.observe(k)?;
        if self.changed {for r in o.rows.values_mut(){*r=None;}}
        Ok(o)
    }
    fn engine_stats(&self)->EngineStats{self.inner.engine_stats()}
    fn failure(&self)->Option<&str>{None}
}
#[test]
fn successful_but_wrong_engine_completion_stops_owner_and_retains_durable_batch() {
    let dir=Directory::new();
    let shared=session(SqliteStore::create(dir.db(),identity()).unwrap(),"A");
    let(l,_)=shared.lock().unwrap().acquire(partition(0)).unwrap();
    let mut c:DurableCoordinator<Disagree,SqliteStore>=DurableCoordinator::new(shared.clone()).unwrap();
    assert!(c.apply(&delivery(&l,vec![put(0,0,"a","1"),put(0,1,"b","2")])).is_err());
    assert!(c.terminal());
    assert!(c.commit_offset::<()>(&l,|_|panic!("forbidden broker authorization")).is_err());
    assert!(c.read("all").is_err());
    drop(c);drop(shared);
    let mut s=SqliteStore::open(dir.db(),identity()).unwrap();
    assert_eq!(s.load().unwrap().snapshot.rows.len(),2);
    let shared=session(s,"B");shared.lock().unwrap().acquire(partition(0)).unwrap();
    let mut c=coordinator(shared);assert_eq!(c.checkpoint().unwrap().snapshot.rows.len(),2);
}
