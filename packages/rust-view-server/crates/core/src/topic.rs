//! Canonical retained ownership; independent of the selected evaluator.
use crate::product::{ProductRow, validate_row};
use crate::source::{MAX_BATCH_MUTATIONS, ProductMutation, SourceBatch};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, VecDeque};
use sha2::{Digest, Sha256};
pub const REPLAY_BATCHES: usize = 256;

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TopicId(pub String);
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RowId(pub String);

/// Durable checkpoint representation. Rows are serialized in canonical ID order.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TopicSnapshot {
    pub topic: TopicId,
    pub schema: String,
    pub version: u64,
    pub last_source_batch: u64,
    pub offsets: BTreeMap<u32, u64>,
    pub rows: Vec<ProductRow>,
    #[serde(default)]
    pub recent_batches: VecDeque<(u64, [u8; 32])>,
}

/// Exact bounded observation of a coherent canonical cut. Keys include absent rows.
/// It is not a full audit: untouched rows and derived query results require independent oracles.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SourceObservation {
    pub topic: TopicId,
    pub version: u64,
    pub sequence: u64,
    pub offsets: BTreeMap<u32, u64>,
    pub recent_batches: VecDeque<(u64, [u8; 32])>,
    pub rows: BTreeMap<String, Option<ProductRow>>,
}

/// The sole canonical ProductRow table. Derived indexes own only derived records.
pub struct TopicStore {
    topic: TopicId,
    pub(crate) version: u64,
    pub(crate) last_source_batch: u64,
    pub(crate) offsets: BTreeMap<u32, u64>,
    pub(crate) rows: BTreeMap<String, ProductRow>,
    pub(crate) recent_batches: VecDeque<(u64, [u8; 32])>,
}

pub(crate) struct PreparedBatch {
    pub sequence: u64,
    pub fingerprint: [u8; 32],
    pub offsets: BTreeMap<u32, u64>,
    pub rows: BTreeMap<String, Option<ProductRow>>,
}

impl Default for TopicStore {
    fn default() -> Self {
        Self::new(TopicId("products".into())).expect("static topic")
    }
}
impl TopicStore {
    pub fn new(topic: TopicId) -> Result<Self, String> {
        if topic.0.is_empty() || topic.0.len() > 256 {
            return Err("invalid topic identity".into());
        }
        Ok(Self {
            topic,
            version: 0,
            last_source_batch: 0,
            offsets: BTreeMap::new(),
            rows: BTreeMap::new(),
            recent_batches: VecDeque::new(),
        })
    }
    pub fn id(&self) -> &TopicId {
        &self.topic
    }
    pub fn version(&self) -> u64 {
        self.version
    }
    pub fn len(&self) -> usize {
        self.rows.len()
    }
    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }
    pub fn get(&self, id: &RowId) -> Option<&ProductRow> {
        self.rows.get(&id.0)
    }
    pub fn observe(&self, keys: &[String]) -> Result<SourceObservation, String> {
        if keys.len() > MAX_BATCH_MUTATIONS { return Err("observation key quota".into()); }
        Ok(SourceObservation {
            topic: self.topic.clone(), version: self.version, sequence: self.last_source_batch,
            offsets: self.offsets.clone(), recent_batches: self.recent_batches.clone(),
            rows: keys.iter().map(|id| (id.clone(), self.rows.get(id).cloned())).collect(),
        })
    }
    pub fn snapshot(&self) -> TopicSnapshot {
        TopicSnapshot {
            topic: self.topic.clone(),
            schema: "product-v1".into(),
            version: self.version,
            last_source_batch: self.last_source_batch,
            offsets: self.offsets.clone(),
            rows: self.rows.values().cloned().collect(),
            recent_batches: self.recent_batches.clone(),
        }
    }
    pub fn from_snapshot(snapshot: TopicSnapshot) -> Result<Self, String> {
        if snapshot.schema != "product-v1" {
            return Err("unsupported snapshot schema".into());
        }
        if snapshot.last_source_batch > snapshot.version {
            return Err("invalid snapshot version/checkpoint".into());
        }
        let mut store = Self::new(snapshot.topic)?;
        for row in snapshot.rows {
            validate_row(&row)?;
            let id = row.id.clone();
            if store.rows.insert(id, row).is_some() {
                return Err("duplicate snapshot row ID".into());
            }
        }
        store.version = snapshot.version;
        store.last_source_batch = snapshot.last_source_batch;
        store.offsets = snapshot.offsets;
        if snapshot.recent_batches.len() > REPLAY_BATCHES || snapshot.recent_batches.iter().any(|(n, _)| *n == 0 || *n > store.last_source_batch) || snapshot.recent_batches.iter().zip(snapshot.recent_batches.iter().skip(1)).any(|(a,b)| a.0 >= b.0) {
            return Err("invalid replay history".into());
        }
        store.recent_batches = snapshot.recent_batches;
        Ok(store)
    }
    /// Apply a validated source transition to canonical truth without constructing an evaluator.
    /// Durable providers stage this on an unexposed store inside their atomic transaction.
    pub fn apply_source(&mut self, batch: SourceBatch) -> Result<bool, String> {
        let Some(prepared) = self.prepare(batch)? else { return Ok(false) };
        for (id, row) in prepared.rows {
            match row {
                Some(row) => { self.rows.insert(id, row); }
                None => { self.rows.remove(&id); }
            }
        }
        self.version += 1; // prepare checked overflow before any change
        self.last_source_batch = prepared.sequence;
        self.offsets = prepared.offsets;
        self.recent_batches.push_back((prepared.sequence, prepared.fingerprint));
        if self.recent_batches.len() > REPLAY_BATCHES { self.recent_batches.pop_front(); }
        Ok(true)
    }
    /// Allocate at most one staged row per touched key, not a clone of the table.
    pub(crate) fn prepare(&self, batch: SourceBatch) -> Result<Option<PreparedBatch>, String> {
        if batch.topic != self.topic {
            return Err("source topic mismatch".into());
        }
        if batch.schema != "product-v1" {
            return Err("unsupported source schema".into());
        }
        if batch.mutations.is_empty() || batch.mutations.len() > MAX_BATCH_MUTATIONS {
            return Err("source batch must contain 1..=1024 mutations".into());
        }
        if batch.sequence == 0 {
            return Err("source sequence starts at one".into());
        }
        let fingerprint: [u8; 32] = Sha256::digest(serde_json::to_vec(&batch).map_err(|e| e.to_string())?).into();
        if batch.sequence <= self.last_source_batch {
            return match self.recent_batches.iter().find(|(n, _)| *n == batch.sequence) {
                Some((_, old)) if *old == fingerprint => Ok(None),
                Some(_) => Err("conflicting source sequence replay".into()),
                None => Err("source replay outside identity horizon; recover a coherent checkpoint".into()),
            };
        }
        if batch.sequence
            != self
                .last_source_batch
                .checked_add(1)
                .ok_or("source sequence exhausted")?
        {
            return Err("source sequence gap/out-of-order delivery".into());
        }
        self.version
            .checked_add(1)
            .ok_or("topic version exhausted")?;
        let mut offsets = self.offsets.clone();
        let mut rows = BTreeMap::new();
        for event in batch.mutations {
            if offsets
                .get(&event.partition)
                .is_some_and(|old| event.offset <= *old)
            {
                return Err("partition offsets must strictly increase in new batches".into());
            }
            offsets.insert(event.partition, event.offset);
            match event.mutation {
                ProductMutation::Upsert { row } => {
                    validate_row(&row)?;
                    rows.insert(row.id.clone(), Some(row));
                }
                ProductMutation::Delete { key } => {
                    if key.0.is_empty() || key.0.len() > 512 {
                        return Err("invalid delete key".into());
                    }
                    rows.insert(key.0, None);
                }
            }
        }
        Ok(Some(PreparedBatch {
            sequence: batch.sequence,
            fingerprint,
            offsets,
            rows,
        }))
    }
}
