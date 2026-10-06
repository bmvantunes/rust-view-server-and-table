//! Future sources supply immutable ordered batches. No Kafka SDK types here.
use crate::engine_contract::ProductEngine;
use crate::product::ProductRow;
use crate::topic::{RowId, TopicId, TopicSnapshot};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

pub const MAX_BATCH_MUTATIONS: usize = 1024;
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProductMutation {
    Upsert { row: ProductRow },
    Delete { key: RowId },
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceMutation {
    pub partition: u32,
    pub offset: u64,
    pub mutation: ProductMutation,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceBatch {
    pub topic: TopicId,
    pub schema: String,
    /// Contiguous, immutable per-topic batch identity assigned by the source coordinator.
    /// Partition offsets may have gaps; this sequence may not.
    pub sequence: u64,
    pub mutations: Vec<SourceMutation>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SourceCommit {
    pub duplicate: bool,
    pub topic_version: u64,
    pub product_version: u64,
    pub dirty_subscriptions: Vec<String>,
}

/// Bounded snapshot+tail capture. Construct the snapshot and register this queue
/// under the source's same serialization point; do not expose the engine until finish.
/// Overflow is explicit; callers must restart capture rather than silently lose events.
#[derive(Clone, Copy, Debug)]
pub struct CaptureLimits { pub batches: usize, pub decoded_bytes: usize, pub events: usize }
#[derive(Clone, Copy, Debug, Default)]
pub struct CaptureUsage { pub batches: usize, pub decoded_bytes: usize, pub events: usize, pub overflow_restarts: u64 }
pub struct SnapshotHandoff {
    snapshot: TopicSnapshot,
    tail: VecDeque<SourceBatch>,
    limits: CaptureLimits,
    usage: CaptureUsage,
    failed: bool,
}
impl SnapshotHandoff {
    pub fn new(snapshot: TopicSnapshot, capacity: usize) -> Result<Self, String> {
        Self::with_limits(snapshot, CaptureLimits { batches: capacity, decoded_bytes: 64 * 1024 * 1024, events: 65536 })
    }
    pub fn with_limits(snapshot: TopicSnapshot, limits: CaptureLimits) -> Result<Self, String> {
        if limits.batches == 0 || limits.batches > 4096 || limits.decoded_bytes == 0 || limits.events == 0 {
            return Err("handoff capacity must be 1..=4096 batches".into());
        }
        Ok(Self {
            snapshot,
            tail: VecDeque::new(),
            limits,
            usage: CaptureUsage::default(),
            failed: false,
        })
    }
    pub fn push(&mut self, batch: SourceBatch) -> Result<(), String> {
        if self.failed {
            return Err("handoff capture failed; restart required".into());
        }
        let bytes = serde_json::to_vec(&batch).map_err(|e| e.to_string())?.len();
        let decoded_bytes = self.usage.decoded_bytes.checked_add(bytes);
        let events = self.usage.events.checked_add(batch.mutations.len());
        if batch.mutations.is_empty()
            || batch.mutations.len() > MAX_BATCH_MUTATIONS
            || self.tail.len() == self.limits.batches
            || decoded_bytes.is_none_or(|v| v > self.limits.decoded_bytes)
            || events.is_none_or(|v| v > self.limits.events)
        {
            self.failed = true;
            self.usage.overflow_restarts += 1;
            return Err(
                "handoff bounded buffer exhausted or invalid batch size; restart required".into(),
            );
        }
        self.usage.batches += 1;
        self.usage.decoded_bytes = decoded_bytes.expect("checked");
        self.usage.events = events.expect("checked");
        self.tail.push_back(batch);
        Ok(())
    }
    pub fn usage(&self) -> CaptureUsage { self.usage }
    /// Synchronous handoff: drain ordered captured tail before permitting live reads.
    /// Source must serialize the transition to direct live delivery after this returns.
    pub fn finish<E: ProductEngine>(self) -> Result<E, String> {
        if self.failed {
            return Err("handoff capture failed; restart required".into());
        }
        let mut engine = E::load(self.snapshot)?;
        for batch in self.tail {
            engine.commit(batch)?;
        }
        Ok(engine)
    }
}
