//! Durable-first coordinator. The evaluator is disposable derived state.
use crate::{
    coordination::{Authority, Delivery, Lease, Partition, Recovery},
    durable::{DurableStore, Error, Token},
};
use rust_differential_product_core::{
    engine_contract::{EngineCompletion, ProductEngine},
    product::{ProductCommand, ProductResult},
    source::SourceCommit,
};
use std::{
    collections::BTreeMap,
    io::Read,
    sync::{Arc, Mutex},
    time::Instant,
};

pub struct Session<S: DurableStore> {
    pub(crate) store: S,
    pub(crate) tokens: BTreeMap<Partition, (Lease, Token)>,
    pub(crate) revision: u64,
    pub(crate) authority: Authority,
    owner: String,
}
impl<S: DurableStore> Session<S> {
    pub fn new(store: S, owner: String, authority: Authority) -> Self {
        Self {
            store,
            tokens: BTreeMap::new(),
            revision: 0,
            authority,
            owner,
        }
    }
    /// Called only after Kafka nominates this partition; tests use the same entry point.
    pub fn acquire(&mut self, partition: Partition) -> Result<(Lease, Recovery), Error> {
        if self.tokens.contains_key(&partition) {
            return Err(Error::Invalid("already locally owned".into()));
        }
        let revision = self
            .revision
            .checked_add(1)
            .ok_or_else(|| Error::Invalid("session revision exhausted".into()))?;
        let (token, recovery) = self.store.acquire(partition.partition, &self.owner)?;
        if token.partition() != partition {
            let _ = self.store.release(&token);
            return Err(Error::Identity);
        }
        let lease = match self.authority.assign(partition.clone()) {
            Ok(l) => l,
            Err(e) => {
                let _ = self.store.release(&token);
                return Err(Error::Invalid(e));
            }
        };
        self.tokens.insert(partition, (lease.clone(), token));
        self.revision = revision;
        Ok((lease, recovery))
    }
    pub fn release(&mut self, partition: &Partition) -> Result<(), Error> {
        // Session mutex serializes apply with callbacks; remove local authority even if disk fails.
        self.authority.revoke(partition);
        if let Some((_, token)) = self.tokens.remove(partition) {
            self.revision = self
                .revision
                .checked_add(1)
                .ok_or_else(|| Error::Invalid("session revision exhausted".into()))?;
            self.store.release(&token)?;
        }
        Ok(())
    }
    pub fn leases(&self) -> Vec<Lease> {
        self.tokens.values().map(|(l, _)| l.clone()).collect()
    }
}
pub type SharedSession<S> = Arc<Mutex<Session<S>>>;
#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct DurableMetrics {
    pub durable_transactions: u64,
    pub durable_transaction_ns: u64,
    pub engine_reconciliation_ns: u64,
    pub broker_commit_ns: u64,
    pub reconciliation_keys: u64,
    pub full_checkpoint_calls: u64,
    pub records_committed: u64,
}
fn incarnation() -> Result<String, Error> {
    let mut bytes = [0; 16];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .map_err(|e| Error::Storage(e.to_string()))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
/// Native result identity is inseparable from its fresh reconstruction lifetime.
#[derive(Clone, Debug, serde::Serialize)]
pub struct ResultEnvelope {
    pub server_incarnation: String,
    pub result: ProductResult,
}
/// One immutable admission, never reusable authority. Requests capture client lifetime
/// independently of engine query generation and navigation sequence.
#[derive(Clone, Debug, serde::Serialize)]
pub struct ReadRequest { pub subscription: String, pub acquisition: u64 }
#[derive(Clone, Debug, serde::Serialize)]
pub struct ReadGroup {
    pub server_incarnation: String,
    pub source_sequence: u64,
    pub requests: Vec<ReadRequest>,
    pub results: Vec<ProductResult>,
    pub estimated_bytes: usize,
}
#[derive(Clone, Copy, Debug)]
pub struct ReadBounds { pub requests: usize, pub rows: usize, pub bytes: usize }
impl Default for ReadBounds {
    fn default() -> Self { Self { requests: 64, rows: 4096, bytes: 4 * 1024 * 1024 } }
}
pub struct DurableCoordinator<E: ProductEngine, S: DurableStore> {
    session: SharedSession<S>,
    engine: E,
    sequence: u64,
    revision: u64,
    terminal: bool,
    incarnation: String,
    metrics: DurableMetrics,
}
impl<E: ProductEngine, S: DurableStore> DurableCoordinator<E, S> {
    pub fn new(session: SharedSession<S>) -> Result<Self, Error> {
        let mut s = session
            .lock()
            .map_err(|_| Error::Storage("session poisoned".into()))?;
        let recovery = s.store.load()?;
        let sequence = recovery.snapshot.last_source_batch;
        let engine = E::load(recovery.snapshot).map_err(Error::Invalid)?;
        let revision = s.revision;
        drop(s);
        Ok(Self {
            session,
            engine,
            sequence,
            revision,
            terminal: false,
            incarnation: incarnation()?,
            metrics: DurableMetrics::default(),
        })
    }
    /// Any assignment/revoke reconstructs the complete canonical cut and invalidates subscriptions.
    /// A terminal object is never revived. Construct a new coordinator after correcting the cause.
    pub fn recover_assignments(&mut self) -> Result<(), Error> {
        if self.terminal {
            return Err(Error::Invalid("terminal owner; rebuild required".into()));
        }
        let mut session = self
            .session
            .lock()
            .map_err(|_| Error::Storage("session poisoned".into()))?;
        if session
            .tokens
            .values()
            .any(|(l, _)| !session.authority.valid(l))
        {
            self.terminal = true;
            return Err(Error::Fenced);
        }
        if self.revision != session.revision {
            let result = (|| {
                let recovery = session.store.load()?;
                let sequence = recovery.snapshot.last_source_batch;
                let tokens: Vec<_> = session.tokens.values().map(|(_, t)| t.clone()).collect();
                let engine = if tokens.is_empty() {
                    E::load(recovery.snapshot).map_err(Error::Invalid)?
                } else {
                    session.store.guard(&tokens, sequence, || {
                        E::load(recovery.snapshot).map_err(Error::Invalid)
                    })?
                };
                self.engine = engine;
                self.sequence = sequence;
                self.revision = session.revision;
                self.incarnation = incarnation()?;
                Ok(())
            })();
            if result.is_err() {
                self.terminal = true;
            }
            return result;
        }
        Ok(())
    }
    pub fn apply(&mut self, delivery: &Delivery) -> Result<Option<SourceCommit>, Error> {
        self.recover_assignments()?;
        let mut session = self
            .session
            .lock()
            .map_err(|_| Error::Storage("session poisoned".into()))?;
        let (lease, token) = session
            .tokens
            .get(&delivery.lease.partition)
            .cloned()
            .ok_or(Error::Fenced)?;
        if lease != delivery.lease || !session.authority.valid(&lease) {
            return Err(Error::Fenced);
        }
        let started = Instant::now();
        let committed = session
            .store
            .commit(&token, self.sequence, &delivery.records);
        self.metrics.durable_transaction_ns += started.elapsed().as_nanos() as u64;
        self.metrics.durable_transactions += 1;
        // Any storage failure can have an uncertain commit outcome. Never keep processing.
        let committed = match committed {
            Ok(c) => c,
            Err(e) => {
                self.terminal = true;
                return Err(e);
            }
        };
        let started = Instant::now();
        let keys: Vec<_> = committed.before.rows.keys().cloned().collect();
        self.metrics.reconciliation_keys += 2 * keys.len() as u64;
        self.metrics.records_committed += delivery.records.len() as u64;
        let applied = (|| {
            if self.engine.observe(&keys).map_err(Error::Invalid)? != committed.before {
                return Err(Error::Corrupt("engine disagrees with transition preimage".into()));
            }
            #[cfg(all(feature="kafka-canonical",feature="fault-injection"))]
            let changed = committed.batch.is_some();
            let commit = committed
                .batch
                .map(|batch| self.engine.commit(batch))
                .transpose()
                .map_err(Error::Invalid)?;
            #[cfg(all(feature="kafka-canonical",feature="fault-injection"))]
            if changed && !crate::faults::point("kafka_engine_applied") {
                return Err(Error::Invalid("injected engine completion failure after durable commit".into()));
            }
            if self.engine.observe(&keys).map_err(Error::Invalid)? != committed.after {
                return Err(Error::Corrupt(
                    "engine disagrees with committed canonical state".into(),
                ));
            }
            self.sequence = committed.after.sequence;
            session
                .store
                .guard(std::slice::from_ref(&token), self.sequence, || Ok(()))?;
            Ok(commit)
        })();
        self.metrics.engine_reconciliation_ns += started.elapsed().as_nanos() as u64;
        if applied.is_err() {
            self.terminal = true;
        }
        applied
    }
    /// The synchronous external commit runs while durable transfer is excluded.
    pub fn commit_offset<T>(
        &mut self,
        lease: &Lease,
        action: impl FnOnce(u64) -> Result<T, Error>,
    ) -> Result<T, Error> {
        self.recover_assignments()?;
        let mut session = self
            .session
            .lock()
            .map_err(|_| Error::Storage("session poisoned".into()))?;
        let (current, token) = session
            .tokens
            .get(&lease.partition)
            .cloned()
            .ok_or(Error::Fenced)?;
        if &current != lease || !session.authority.valid(lease) {
            return Err(Error::Fenced);
        }
        let started = Instant::now();
        let result = session.store.authorize(&token, self.sequence, action);
        self.metrics.broker_commit_ns += started.elapsed().as_nanos() as u64;
        result
    }
    /// Query-only facade. No mutable evaluator/storage escape hatch; all reads are fenced.
    pub fn command(&mut self, command: ProductCommand) -> Result<EngineCompletion, Error> {
        if matches!(
            command,
            ProductCommand::Upsert { .. }
                | ProductCommand::Patch { .. }
                | ProductCommand::Delete { .. }
        ) {
            return Err(Error::Invalid(
                "durable source owns all row mutations".into(),
            ));
        }
        self.recover_assignments()?;
        let mut s = self
            .session
            .lock()
            .map_err(|_| Error::Storage("session poisoned".into()))?;
        let tokens: Vec<_> = s.tokens.values().map(|(_, t)| t.clone()).collect();
        let result = s.store.guard(&tokens, self.sequence, || {
            self.engine.command(command).map_err(Error::Invalid)
        });
        if self.engine.failure().is_some() {
            self.terminal = true;
        }
        result
    }
    pub fn command_bounded(&mut self, command: ProductCommand, rows: usize, bytes: usize) -> Result<EngineCompletion, Error> {
        self.recover_assignments()?;
        let mut s = self.session.lock().map_err(|_| Error::Storage("session poisoned".into()))?;
        let tokens: Vec<_> = s.tokens.values().map(|(_, t)| t.clone()).collect();
        let result = s.store.guard(&tokens, self.sequence, || self.engine.command_bounded(command, rows, bytes).map_err(Error::Invalid));
        if self.engine.failure().is_some() { self.terminal = true; }
        result
    }
    pub fn read(&mut self, subscription: &str) -> Result<Option<ResultEnvelope>, Error> {
        self.recover_assignments()?;
        let mut s = self
            .session
            .lock()
            .map_err(|_| Error::Storage("session poisoned".into()))?;
        let tokens: Vec<_> = s.tokens.values().map(|(_, t)| t.clone()).collect();
        s.store.guard(&tokens, self.sequence, || {
            Ok(self.engine.read(subscription).map(|result| ResultEnvelope {
                server_incarnation: self.incarnation.clone(),
                result,
            }))
        })
    }
    /// One synchronous authority proof and bounded extraction. SQLite excludes transfer
    /// during extraction; Kafka linearizes the snapshot at its committed authority
    /// barrier. No caller callback/serializer participates in this operation.
    pub fn read_many(&mut self, requests: &[ReadRequest], bounds: ReadBounds) -> Result<ReadGroup, Error> {
        if requests.is_empty() || requests.len() > bounds.requests || bounds.requests > 256 || bounds.rows > 65536 || bounds.bytes > 64 * 1024 * 1024 {
            return Err(Error::Invalid("read group bounds".into()));
        }
        let mut seen = std::collections::BTreeSet::new();
        if requests.iter().any(|r| r.subscription.len() > 256 || !seen.insert(&r.subscription)) {
            return Err(Error::Invalid("duplicate or oversized subscription identity".into()));
        }
        #[cfg(feature="fault-injection")]
        crate::faults::point("group_before_admission");
        self.recover_assignments()?;
        let mut s = self.session.lock().map_err(|_| Error::Storage("session poisoned".into()))?;
        let tokens: Vec<_> = s.tokens.values().map(|(_, t)| t.clone()).collect();
        let result = s.store.guard(&tokens, self.sequence, || {
            let mut results = Vec::with_capacity(requests.len());
            let mut rows = bounds.rows;
            let mut bytes = bounds.bytes;
            for request in requests {
                let (result, estimate) = self.engine.read_bounded(&request.subscription, rows, bytes).map_err(Error::Invalid)?;
                rows = rows.checked_sub(result.rows.len()).ok_or_else(|| Error::Invalid("row budget".into()))?;
                bytes = bytes.checked_sub(estimate).ok_or_else(|| Error::Invalid("byte budget".into()))?;
                results.push(result);
            }
            Ok(ReadGroup { server_incarnation: self.incarnation.clone(), source_sequence: self.sequence,
                requests: requests.to_vec(), results, estimated_bytes: bounds.bytes - bytes })
        });
        // Resource/query rejection is recoverable. Authority/storage/engine uncertainty
        // invalidates this grouped owner. Existing single-read semantics remain intact.
        if self.engine.failure().is_some() || matches!(&result, Err(e) if !matches!(e, Error::Invalid(_))) { self.terminal = true; }
        drop(s);
        #[cfg(feature="fault-injection")]
        crate::faults::point("group_after_admission");
        result
    }
    pub fn admit_cut(&mut self) -> Result<(), Error> {
        self.recover_assignments()?;
        let mut s = self.session.lock().map_err(|_| Error::Storage("session poisoned".into()))?;
        let tokens: Vec<_> = s.tokens.values().map(|(_,t)|t.clone()).collect();
        s.store.guard(&tokens,self.sequence,||Ok(()))
    }
    pub fn engine_stats(&self) -> rust_differential_product_core::engine_contract::EngineStats { self.engine.engine_stats() }
    pub fn covered_partitions(&self) -> Result<Vec<u32>, Error> {
        let s = self.session.lock().map_err(|_| Error::Storage("session poisoned".into()))?;
        Ok(s.tokens.keys().map(|p| p.partition).collect())
    }
    pub fn checkpoint(&mut self) -> Result<Recovery, Error> {
        self.recover_assignments()?;
        let mut s = self
            .session
            .lock()
            .map_err(|_| Error::Storage("session poisoned".into()))?;
        let tokens: Vec<_> = s.tokens.values().map(|(_, t)| t.clone()).collect();
        let recovery = s.store.load()?;
        self.metrics.full_checkpoint_calls += 1;
        s.store.guard(&tokens, self.sequence, || {
            if self.engine.checkpoint().map_err(Error::Invalid)? != recovery.snapshot {
                return Err(Error::StaleSnapshot);
            }
            Ok(recovery)
        })
    }
    #[cfg(feature = "kafka")]
    pub(crate) fn same_session(&self, other: &SharedSession<S>) -> bool {
        Arc::ptr_eq(&self.session, other)
    }
    pub fn incarnation(&self) -> &str {
        &self.incarnation
    }
    pub fn terminal(&self) -> bool {
        self.terminal
    }
    pub fn metrics(&self) -> &DurableMetrics {
        &self.metrics
    }
}

impl Session<crate::durable::SqliteStore> {
    pub fn storage_work(&self) -> crate::durable::Work { self.store.work() }
    pub fn reset_storage_work(&mut self) { self.store.reset_work(); }
}
