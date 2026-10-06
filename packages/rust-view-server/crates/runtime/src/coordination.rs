//! Leases serialize commit with revocation. Kafka generations never enter engine APIs.
use rust_differential_product_core::{
    engine_contract::ProductEngine,
    source::{MAX_BATCH_MUTATIONS, SourceBatch, SourceCommit, SourceMutation},
    topic::{TopicId, TopicSnapshot},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{Arc, Mutex},
};

pub const RECENT_EVENTS: usize = 256;
pub const MAX_PARTITIONS: usize = 4096;
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
pub struct Partition {
    pub topic: String,
    pub partition: u32,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Lease {
    pub partition: Partition,
    pub epoch: u64,
}
#[derive(Default)]
struct Ownership {
    next: u64,
    owners: BTreeMap<Partition, u64>,
    stopped: bool,
}
#[derive(Clone, Default)]
pub struct Authority(Arc<Mutex<Ownership>>);
impl Authority {
    pub fn assign(&self, partition: Partition) -> Result<Lease, String> {
        let mut s = self.0.lock().map_err(|_| "ownership poisoned")?;
        if s.stopped || s.owners.contains_key(&partition) || s.owners.len() >= MAX_PARTITIONS {
            return Err("assignment rejected: stopped, already owned, or partition quota".into());
        }
        s.next = s.next.checked_add(1).ok_or("lease epoch exhausted")?;
        let epoch = s.next;
        s.owners.insert(partition.clone(), epoch);
        Ok(Lease { partition, epoch })
    }
    /// Linearization point: waits for an in-flight completed commit, fences all later work.
    pub fn revoke(&self, partition: &Partition) {
        self.0
            .lock()
            .expect("ownership poisoned")
            .owners
            .remove(partition);
    }
    pub fn shutdown(&self) {
        let mut s = self.0.lock().expect("ownership poisoned");
        s.stopped = true;
        s.owners.clear();
    }
    pub fn lease(&self, partition: &Partition) -> Option<Lease> {
        self.0
            .lock()
            .ok()?
            .owners
            .get(partition)
            .map(|epoch| Lease {
                partition: partition.clone(),
                epoch: *epoch,
            })
    }
    pub fn valid(&self, lease: &Lease) -> bool {
        self.lease(&lease.partition).as_ref() == Some(lease)
    }
    pub fn leases(&self) -> Vec<Lease> {
        self.0
            .lock()
            .expect("ownership poisoned")
            .owners
            .iter()
            .map(|(partition, epoch)| Lease {
                partition: partition.clone(),
                epoch: *epoch,
            })
            .collect()
    }
    pub(crate) fn fenced<T>(
        &self,
        leases: &[Lease],
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let s = self.0.lock().map_err(|_| "ownership poisoned")?;
        if s.stopped
            || leases
                .iter()
                .any(|l| s.owners.get(&l.partition) != Some(&l.epoch))
        {
            return Err("revoked/stale source lease".into());
        }
        operation()
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Record {
    pub event: SourceMutation,
    pub identity: [u8; 32],
}
impl Record {
    pub(crate) fn fingerprint(&self) -> [u8; 32] {
        // Bind the advertised wire identity to the actual typed mutation too.
        Sha256::digest(serde_json::to_vec(self).expect("typed record serializes")).into()
    }
    pub fn new(event: SourceMutation) -> Self {
        let identity =
            Sha256::digest(serde_json::to_vec(&event).expect("typed mutation serializes")).into();
        Self { event, identity }
    }
}
#[derive(Clone, Debug)]
pub struct Delivery {
    pub lease: Lease,
    pub records: Vec<Record>,
}
impl Delivery {
    pub fn bytes(&self) -> Result<usize, String> {
        // Exact serialized decoded representation, not allocator RSS. Includes identity.
        serde_json::to_vec(&self.records)
            .map(|v| v.len())
            .map_err(|e| e.to_string())
    }
}
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub batches: usize,
    pub bytes: usize,
    pub events: usize,
}
impl Limits {
    pub fn validate(self) -> Result<Self, String> {
        if self.batches == 0 || self.batches > 4096 || self.bytes == 0 || self.events == 0 {
            Err("invalid queue quotas".into())
        } else {
            Ok(self)
        }
    }
}
/// Decoded bytes use Delivery::bytes (JSON including identity), not allocator RSS.
#[derive(Clone, Copy, Debug)]
pub struct BatchLimits {
    pub records: usize,
    pub bytes: usize,
    pub latency_ms: u64,
}
impl Default for BatchLimits {
    fn default() -> Self { Self { records: 1, bytes: 2 * 1024 * 1024, latency_ms: 0 } }
}
impl BatchLimits {
    pub fn validate(self) -> Result<Self, String> {
        if self.records == 0 || self.records > MAX_BATCH_MUTATIONS || self.bytes == 0 || self.bytes > 2 * 1024 * 1024 || self.latency_ms > 60_000 {
            return Err("invalid batch bounds".into());
        }
        Ok(self)
    }
}
#[derive(Clone, Debug, Default, Serialize)]
pub struct Metrics {
    pub queue_depth: usize,
    pub queued_bytes: usize,
    pub queued_events: usize,
    pub spill_bytes: usize,
    pub paused_partitions: usize,
    pub resume_count: u64,
    pub overflow_restarts: u64,
    pub kafka_queued_records: u64,
    pub paused_duration_ns: u64,
    pub building_bytes: usize,
    pub buffered_bytes: usize,
    pub max_buffered_bytes: usize,
    pub completed_batches: u64,
    pub completed_records: u64,
    pub batching_wait_ms: u64,
    pub queue_records_serialized: u64,

}
pub struct BoundedQueue {
    limits: Limits,
    batch_limits: BatchLimits,
    building_since: Option<u64>,
    queue: VecDeque<Delivery>,
    pub(crate) metrics: Metrics,
}
impl BoundedQueue {
    pub fn new(limits: Limits) -> Result<Self, String> {
        Ok(Self {
            limits: limits.validate()?,
            batch_limits: BatchLimits::default(),
            building_since: None,
            queue: VecDeque::new(),
            metrics: Metrics::default(),
        })
    }
    /// Configure before ingestion; a building batch occupies the queue budget itself.
    pub fn set_batch_limits(&mut self, limits: BatchLimits) -> Result<(), String> {
        if !self.queue.is_empty() { return Err("configure batching before polling".into()); }
        self.batch_limits = limits.validate()?;
        Ok(())
    }
    fn seal(&mut self, now_ms: u64) {
        if let Some(start) = self.building_since.take() {
            self.metrics.batching_wait_ms += now_ms.saturating_sub(start);
        }
        self.metrics.building_bytes = 0;
    }
    pub fn flush_due(&mut self, now_ms: u64) {
        if self.building_since.is_some_and(|start| now_ms.saturating_sub(start) >= self.batch_limits.latency_ms) || self.full() {
            self.seal(now_ms);
        }
    }
    pub fn wait_ms(&self, now_ms: u64) -> Option<u64> {
        self.building_since.map(|start| self.batch_limits.latency_ms.saturating_sub(now_ms.saturating_sub(start)))
    }
    pub fn ready(&mut self, now_ms: u64) -> Option<&Delivery> {
        self.flush_due(now_ms);
        if self.queue.len() == 1 && self.building_since.is_some() { None } else { self.queue.front() }
    }
    /// Caller retains a failed one-record delivery as the bounded spill. Only the tail is
    /// open; partition/lease changes seal it. No cross-partition ordering is introduced.
    pub fn push_record(&mut self, delivery: Delivery, now_ms: u64) -> Result<(), String> {
        if delivery.records.len() != 1 { return Err("one decoded input required".into()); }
        self.metrics.queue_records_serialized += delivery.records.len() as u64;
        let bytes = delivery.bytes()?;
        if bytes > self.batch_limits.bytes { return Err("record exceeds configured batch bytes".into()); }
        self.flush_due(now_ms);
        if self.building_since.is_some() {
            let tail = self.queue.back().expect("building tail");
            // The sole building tail is private and every append records its exact JSON
            // array length. Reuse that count instead of serializing its prefix again.
            let tail_bytes = self.metrics.building_bytes;
            let combined = tail_bytes.checked_add(bytes).and_then(|n| n.checked_sub(1)).ok_or("batch byte overflow")?;
            let total = self.metrics.queued_bytes.checked_add(bytes - 1).ok_or("queue byte overflow")?;
            let count = self.metrics.queued_events.checked_add(1).ok_or("queue event overflow")?;
            if tail.lease == delivery.lease && tail.records.len() < self.batch_limits.records && combined <= self.batch_limits.bytes && total <= self.limits.bytes && count <= self.limits.events {
                let tail = self.queue.back_mut().expect("building tail");
                tail.records.extend(delivery.records);
                let complete = tail.records.len() == self.batch_limits.records || combined == self.batch_limits.bytes;
                self.metrics.queued_bytes = total;
                self.metrics.queued_events = count;
                self.metrics.building_bytes = combined;
                if complete || self.full() { self.seal(now_ms); }
                return Ok(());
            }
            self.seal(now_ms);
        }
        self.push(delivery)?;
        self.building_since = Some(now_ms);
        self.metrics.building_bytes = bytes;
        if self.batch_limits.records == 1 || bytes == self.batch_limits.bytes { self.seal(now_ms); }
        self.flush_due(now_ms);
        Ok(())
    }
    pub fn record_completed(&mut self) {
        if let Some(front) = self.front() {
            self.metrics.completed_records += front.records.len() as u64;
            self.metrics.completed_batches += 1;
        }
    }
    pub fn push(&mut self, delivery: Delivery) -> Result<(), String> {
        self.metrics.queue_records_serialized += delivery.records.len() as u64;
        let bytes = delivery.bytes()?;
        let m = &self.metrics;
        let events = m
            .queued_events
            .checked_add(delivery.records.len())
            .ok_or("event accounting overflow")?;
        let total = m
            .queued_bytes
            .checked_add(bytes)
            .ok_or("byte accounting overflow")?;
        if delivery.records.is_empty()
            || delivery.records.len() > MAX_BATCH_MUTATIONS
            || self.queue.len() >= self.limits.batches
            || events > self.limits.events
            || total > self.limits.bytes
        {
            return Err("queue quota exceeded; caller must retain or replay delivery".into());
        }
        self.queue.push_back(delivery);
        // Legacy whole-delivery admission can be mixed with push_record. If a
        // tail is building, its identity has now changed to this new private tail.
        if self.building_since.is_some() { self.metrics.building_bytes = bytes; }
        self.metrics.queue_depth = self.queue.len();
        self.metrics.queued_events = events;
        self.metrics.queued_bytes = total;
        Ok(())
    }
    pub fn pop(&mut self) -> Option<Delivery> {
        let d = self.queue.pop_front()?;
        if self.queue.is_empty() { self.building_since = None; self.metrics.building_bytes = 0; }
        self.metrics.queue_depth = self.queue.len();
        self.metrics.queued_events -= d.records.len();
        self.metrics.queue_records_serialized += d.records.len() as u64;
        self.metrics.queued_bytes -= d.bytes().expect("previously measured");
        Some(d)
    }
    pub fn metrics(&self) -> &Metrics {
        &self.metrics
    }
    pub fn front(&self) -> Option<&Delivery> {
        self.queue.front()
    }
    pub fn full(&self) -> bool {
        self.metrics.queue_depth >= self.limits.batches
            || self.metrics.queued_events >= self.limits.events
            || self.metrics.queued_bytes >= self.limits.bytes
    }
    pub fn discard_stale(&mut self, authority: &Authority) {
        if self.queue.back().is_some_and(|d| !authority.valid(&d.lease)) {
            self.building_since = None;
            self.metrics.building_bytes = 0;
        }
        let metrics = &mut self.metrics;
        self.queue.retain(|d| {
            if authority.valid(&d.lease) { true } else {
                metrics.queue_records_serialized += d.records.len() as u64;
                metrics.queued_bytes -= d.bytes().expect("measured");
                metrics.queued_events -= d.records.len();
                false
            }
        });
        self.metrics.queue_depth = self.queue.len();
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Recovery {
    pub snapshot: TopicSnapshot,
    /// Last applied offsets, inclusive. Missing partition means no event applied.
    pub recent: BTreeMap<u32, VecDeque<(u64, [u8; 32])>>,
}
/// Implementations must atomically persist rows, positions AND replay identities before returning.
/// The checkpoint must remain available across process and machine failure in the deployment model.
pub trait DurableStore {
    fn persist(&mut self, checkpoint: &Recovery) -> Result<(), String>;
}
pub struct Coordinator<E: ProductEngine> {
    engine: E,
    topic: TopicId,
    sequence: u64,
    applied: BTreeMap<u32, u64>,
    recent: BTreeMap<u32, VecDeque<(u64, [u8; 32])>>,
    durable: BTreeMap<u32, u64>,
    terminal: bool,
    authority: Authority,
}
impl<E: ProductEngine> Coordinator<E> {
    pub fn restore(recovery: Recovery, authority: Authority) -> Result<Self, String> {
        if recovery.snapshot.offsets.len() > MAX_PARTITIONS
            || recovery.recent.len() > MAX_PARTITIONS
        {
            return Err("partition quota".into());
        }
        for (p, history) in &recovery.recent {
            let mut previous = None;
            if history.len() > RECENT_EVENTS {
                return Err("replay history quota".into());
            }
            for (offset, _) in history {
                if previous.is_some_and(|v| *offset <= v)
                    || recovery.snapshot.offsets.get(p).is_none_or(|v| offset > v)
                {
                    return Err("invalid replay history".into());
                }
                previous = Some(*offset);
            }
        }
        let topic = recovery.snapshot.topic.clone();
        let sequence = recovery.snapshot.last_source_batch;
        let applied = recovery.snapshot.offsets.clone();
        Ok(Self {
            engine: E::load(recovery.snapshot)?,
            topic,
            sequence,
            applied,
            recent: recovery.recent,
            durable: BTreeMap::new(),
            terminal: false,
            authority,
        })
    }
    pub fn apply(&mut self, delivery: &Delivery) -> Result<Option<SourceCommit>, String> {
        let authority = self.authority.clone();
        authority.fenced(std::slice::from_ref(&delivery.lease), || {
            self.apply_owned(delivery)
        })
    }
    fn apply_owned(&mut self, delivery: &Delivery) -> Result<Option<SourceCommit>, String> {
        if self.terminal {
            return Err(
                "source owner terminal; reconstruct from durable checkpoint or full source replay"
                    .into(),
            );
        }
        if delivery.lease.partition.topic != self.topic.0
            || delivery.records.is_empty()
            || delivery.records.len() > MAX_BATCH_MUTATIONS
        {
            return Err("invalid topic/batch".into());
        }
        let p = delivery.lease.partition.partition;
        if !self.applied.contains_key(&p) && self.applied.len() >= MAX_PARTITIONS {
            return Err("partition quota".into());
        }
        let mut last = self.applied.get(&p).copied();
        let mut history = self.recent.get(&p).cloned().unwrap_or_default();
        let mut mutations = Vec::new();
        for record in &delivery.records {
            let event = &record.event;
            let fingerprint = record.fingerprint();
            if event.partition != p || event.offset > i64::MAX as u64 - 1 {
                return Err("invalid partition/offset".into());
            }
            if last.is_some_and(|v| event.offset <= v) {
                match history.iter().find(|(o, _)| *o == event.offset) {
                    Some((_, id)) if *id == fingerprint => continue,
                    Some(_) => return Err("conflicting offset payload".into()),
                    None => {
                        return Err("old offset outside replay horizon or unobserved gap".into());
                    }
                }
            }
            last = Some(event.offset);
            history.push_back((event.offset, fingerprint));
            if history.len() > RECENT_EVENTS {
                history.pop_front();
            }
            mutations.push(event.clone());
        }
        if mutations.is_empty() {
            return Ok(None);
        }
        let sequence = self
            .sequence
            .checked_add(1)
            .ok_or("source sequence exhausted")?;
        let batch = SourceBatch {
            topic: self.topic.clone(),
            schema: "product-v1".into(),
            sequence,
            mutations,
        };
        match self.engine.commit(batch) {
            Ok(commit) => {
                self.sequence = sequence;
                self.applied.insert(p, last.expect("nonempty"));
                self.recent.insert(p, history);
                Ok(Some(commit))
            }
            Err(error) => {
                if self.engine.failure().is_some() {
                    self.terminal = true;
                }
                Err(error)
            }
        }
    }
    pub fn checkpoint(&self) -> Result<Recovery, String> {
        if self.terminal {
            return Err("terminal source".into());
        }
        Ok(Recovery {
            snapshot: self.engine.checkpoint()?,
            recent: self.recent.clone(),
        })
    }
    pub fn persist(&mut self, store: &mut impl DurableStore) -> Result<(), String> {
        let checkpoint = self.checkpoint()?;
        store.persist(&checkpoint)?;
        self.durable = checkpoint.snapshot.offsets;
        Ok(())
    }
    /// Kafka's commit coordinate is NEXT to consume, never last applied.
    pub fn committable_next(&self, lease: &Lease) -> Result<Option<u64>, String> {
        self.authority.fenced(std::slice::from_ref(lease), || {
            if self.terminal || lease.partition.topic != self.topic.0 {
                return Err("terminal or mismatched owner".into());
            }
            self.durable
                .get(&lease.partition.partition)
                .map(|last| last.checked_add(1).ok_or_else(|| "offset exhausted".into()))
                .transpose()
        })
    }
    pub fn applied_next(&self, partition: u32) -> Option<u64> {
        self.applied.get(&partition).and_then(|v| v.checked_add(1))
    }
}
/// A detached per-partition cut, plus bounded tail. Any ownership change aborts it.
pub struct Capture {
    initial: Recovery,
    leases: Vec<Lease>,
    authority: Authority,
    tail: BoundedQueue,
    failed: bool,
}
impl Capture {
    pub fn begin<E: ProductEngine>(
        coordinator: &Coordinator<E>,
        limits: Limits,
    ) -> Result<Self, String> {
        let authority = coordinator.authority.clone();
        let leases = authority.leases();
        let initial = authority.fenced(&leases, || coordinator.checkpoint())?;
        Ok(Self {
            initial,
            leases,
            authority,
            tail: BoundedQueue::new(limits)?,
            failed: false,
        })
    }
    fn unchanged(&self) -> bool {
        self.authority.leases() == self.leases
    }
    pub fn push(&mut self, delivery: Delivery) -> Result<(), String> {
        if self.failed || !self.unchanged() || !self.leases.contains(&delivery.lease) {
            self.failed = true;
            return Err("capture ownership changed; restart".into());
        }
        if let Err(e) = self.tail.push(delivery) {
            self.failed = true;
            self.tail.metrics.overflow_restarts += 1;
            return Err(e);
        }
        Ok(())
    }
    pub fn metrics(&self) -> &Metrics {
        &self.tail.metrics
    }
    pub fn finish<E: ProductEngine>(mut self) -> Result<Coordinator<E>, String> {
        if self.failed || !self.unchanged() {
            return Err("capture aborted; restart".into());
        }
        let mut result = Coordinator::restore(self.initial.clone(), self.authority.clone())?;
        while let Some(d) = self.tail.pop() {
            result.apply(&d)?;
        }
        if !self.unchanged() {
            return Err("capture ownership changed; restart".into());
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_differential_product_core::{source::ProductMutation, topic::RowId};
    #[test]
    fn checked_accounting_and_epoch_exhaustion() {
        let authority = Authority::default();
        let partition = Partition {
            topic: "products".into(),
            partition: 0,
        };
        let lease = authority.assign(partition.clone()).unwrap();
        let delivery = Delivery {
            lease,
            records: vec![Record::new(SourceMutation {
                partition: 0,
                offset: 0,
                mutation: ProductMutation::Delete {
                    key: RowId("x".into()),
                },
            })],
        };
        let mut queue = BoundedQueue::new(Limits {
            batches: 1,
            bytes: usize::MAX,
            events: usize::MAX,
        })
        .unwrap();
        queue.metrics.queued_bytes = usize::MAX;
        assert!(
            queue
                .push(delivery.clone())
                .unwrap_err()
                .contains("overflow")
        );
        assert!(queue.queue.is_empty());
        queue.metrics.queued_bytes = 0;
        queue.metrics.queued_events = usize::MAX;
        assert!(queue.push(delivery).unwrap_err().contains("overflow"));
        assert!(queue.queue.is_empty());
        authority.revoke(&partition);
        authority.0.lock().unwrap().next = u64::MAX;
        assert!(
            authority
                .assign(partition)
                .unwrap_err()
                .contains("exhausted")
        );
    }
}
