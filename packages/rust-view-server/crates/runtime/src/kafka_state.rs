//! Kafka canonical format and bounded transition planner. No broker or evaluator objects.
use crate::{
    coordination::{Record, Recovery},
    durable::{Committed, Error, SourceIdentity},
};
use rust_differential_product_core::{
    product::ProductRow,
    source::{ProductMutation, SourceBatch},
    topic::{TopicId, TopicStore},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, VecDeque};

pub const HORIZON: u64 = 256;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Value {
    Row {
        id: String,
        owner: u32,
        row: Option<ProductRow>,
    },
    Progress {
        offset: u64,
        ordinal: u64,
    },
    Record {
        ordinal: u64,
        offset: u64,
        fingerprint: [u8; 32],
    },
    Batch {
        sequence: u64,
        fingerprint: [u8; 32],
    },
    Manifest {
        source: SourceIdentity,
        group: String,
        partitions: u32,
        sequence: u64,
        root: [u8; 32],
    },
    Cursor {
        next: u64,
    },
    Barrier {
        nonce: String,
    },
}
impl Value {
    pub fn key(&self) -> Vec<u8> {
        let mut k = vec![1];
        match self {
            Self::Row { id, .. } => {
                k.push(1);
                k.extend(id.as_bytes());
            }
            Self::Progress { .. } => k.push(2),
            Self::Record { ordinal, .. } => {
                k.push(3);
                k.extend(((*ordinal % HORIZON) as u16).to_be_bytes());
            }
            Self::Batch { sequence, .. } => {
                k.push(4);
                k.extend(((*sequence % HORIZON) as u16).to_be_bytes());
            }
            Self::Manifest { .. } => k.push(5),
            Self::Barrier { .. } => k.push(6),
            Self::Cursor { .. } => k.push(7),
        }
        k
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    format: u32,
    source: SourceIdentity,
    value: Value,
    digest: [u8; 32],
}
fn digest(source: &SourceIdentity, partition: u32, value: &Value) -> Result<[u8; 32], Error> {
    Ok(Sha256::digest(serde_json::to_vec(&(
        1u32,
        source,
        partition,
        value.key(),
        value,
    ))?)
    .into())
}
pub fn encode(source: &SourceIdentity, partition: u32, value: &Value) -> Result<Vec<u8>, Error> {
    Ok(serde_json::to_vec(&Envelope {
        format: 1,
        source: source.clone(),
        value: value.clone(),
        digest: digest(source, partition, value)?,
    })?)
}
pub fn decode(
    source: &SourceIdentity,
    partition: u32,
    key: &[u8],
    payload: Option<&[u8]>,
) -> Result<Value, Error> {
    let payload = payload
        .ok_or_else(|| Error::Corrupt("Kafka tombstone forbidden in canonical keyspace".into()))?;
    if payload.len() > 2 * 1024 * 1024 {
        return Err(Error::Corrupt("state record byte quota".into()));
    }
    let e: Envelope = serde_json::from_slice(payload)?;
    if e.format != 1 {
        return Err(Error::Format(e.format));
    }
    if &e.source != source && !matches!(e.value, Value::Barrier { .. }) {
        return Err(Error::Identity);
    }
    if key != e.value.key() || e.digest != digest(&e.source, partition, &e.value)? {
        return Err(Error::Corrupt("state key/partition/digest mismatch".into()));
    }
    Ok(e.value)
}
#[derive(Clone, Debug)]
pub struct Image {
    pub source: SourceIdentity,
    pub group: String,
    pub partitions: u32,
    pub sequence: u64,
    pub initialized: bool,
    pub root: [u8; 32],
    expected_root: [u8; 32],
    pub rows: BTreeMap<String, (u32, Option<ProductRow>)>,
    pub cursors: BTreeMap<u32, u64>,
    pub progress: BTreeMap<u32, (u64, u64)>, // inclusive offset, accepted ordinal
    pub records: BTreeMap<(u32, u16), (u64, u64, [u8; 32])>,
    pub batches: BTreeMap<u16, (u64, [u8; 32])>,
}
#[derive(Debug)]
pub struct Plan {
    pub committed: Committed,
    pub writes: Vec<(u32, Value)>,
}
impl Image {
    pub fn empty(source: SourceIdentity, group: String, partitions: u32) -> Result<Self, Error> {
        if source.incarnation.is_empty()
            || source.incarnation.len() > 512
            || source.schema != "product-v1"
            || group.is_empty()
            || group.len() > 256
            || partitions == 0
            || partitions > 256
        {
            return Err(Error::Identity);
        }
        TopicStore::new(TopicId(source.topic.clone())).map_err(Error::Invalid)?;
        Ok(Self {
            source,
            group,
            partitions,
            sequence: 0,
            initialized: false,
            root: [0; 32],
            expected_root: [0; 32],
            rows: BTreeMap::new(),
            cursors: BTreeMap::new(),
            progress: BTreeMap::new(),
            records: BTreeMap::new(),
            batches: BTreeMap::new(),
        })
    }
    pub fn manifest(&self, sequence: u64) -> Value {
        Value::Manifest {
            source: self.source.clone(),
            group: self.group.clone(),
            partitions: self.partitions,
            sequence,
            root: self.root,
        }
    }
    pub fn fold(&mut self, p: u32, value: Value) -> Result<(), Error> {
        if p >= self.partitions {
            return Err(Error::Corrupt("state partition".into()));
        }
        match value {
            Value::Row { id, owner, row } => {
                if owner != p
                    || id.is_empty()
                    || id.len() > 512
                    || self.rows.get(&id).is_some_and(|(old, _)| *old != p)
                {
                    return Err(Error::Corrupt("sticky ownership conflict".into()));
                }
                if let Some(r) = &row {
                    let mut validation = TopicStore::new(TopicId(self.source.topic.clone()))
                        .map_err(Error::Corrupt)?
                        .snapshot();
                    validation.rows.push(r.clone());
                    TopicStore::from_snapshot(validation).map_err(Error::Corrupt)?;
                    if r.id != id {
                        return Err(Error::Corrupt("row identity".into()));
                    }
                }
                if let Some((old_owner, old_row)) = self.rows.get(&id) {
                    xor(&mut self.root, row_digest(&id, *old_owner, old_row));
                }
                xor(&mut self.root, row_digest(&id, owner, &row));
                self.rows.insert(id, (owner, row));
            }
            Value::Progress { offset, ordinal } => {
                if ordinal == 0
                    || offset >= i64::MAX as u64
                    || self
                        .progress
                        .get(&p)
                        .is_some_and(|(o, n)| *o >= offset || *n >= ordinal)
                {
                    return Err(Error::Corrupt("nonmonotonic progress".into()));
                }
                self.progress.insert(p, (offset, ordinal));
            }
            Value::Record {
                ordinal,
                offset,
                fingerprint,
            } => {
                if ordinal == 0 || offset >= i64::MAX as u64 {
                    return Err(Error::Corrupt("record identity bounds".into()));
                }
                let slot = (ordinal % HORIZON) as u16;
                if self
                    .records
                    .get(&(p, slot))
                    .is_some_and(|(old, _, _)| *old >= ordinal)
                {
                    return Err(Error::Corrupt("history slot regression".into()));
                }
                self.records
                    .insert((p, slot), (ordinal, offset, fingerprint));
            }
            Value::Batch {
                sequence,
                fingerprint,
            } => {
                if p != 0 || sequence == 0 {
                    return Err(Error::Corrupt("batch identity partition/sequence".into()));
                }
                let slot = (sequence % HORIZON) as u16;
                if self
                    .batches
                    .get(&slot)
                    .is_some_and(|(old, _)| *old >= sequence)
                {
                    return Err(Error::Corrupt("batch slot regression".into()));
                }
                self.batches.insert(slot, (sequence, fingerprint));
            }
            Value::Manifest {
                source,
                group,
                partitions,
                sequence,
                root,
            } => {
                if p != 0
                    || source != self.source
                    || group != self.group
                    || partitions != self.partitions
                {
                    return Err(Error::Identity);
                }
                if self.initialized && sequence <= self.sequence {
                    return Err(Error::Corrupt("manifest regression".into()));
                }
                self.initialized = true;
                self.sequence = sequence;
                self.expected_root = root;
            }
            Value::Cursor { next } => {
                if next > i64::MAX as u64 || self.cursors.get(&p).is_some_and(|old| *old >= next) {
                    return Err(Error::Corrupt("source cursor regression/bounds".into()));
                }
                self.cursors.insert(p, next);
            }
            Value::Barrier { nonce } => {
                if nonce.len() != 32 {
                    return Err(Error::Corrupt("barrier nonce".into()));
                }
            }
        }
        Ok(())
    }
    pub fn recent(&self, p: u32) -> VecDeque<(u64, [u8; 32])> {
        let mut items = self
            .records
            .iter()
            .filter(|((part, _), _)| *part == p)
            .map(|(_, v)| *v)
            .collect::<Vec<_>>();
        items.sort_by_key(|v| v.0);
        items.into_iter().map(|(_, o, f)| (o, f)).collect()
    }
    fn batch_history(&self) -> VecDeque<(u64, [u8; 32])> {
        let mut items = self.batches.values().copied().collect::<Vec<_>>();
        items.sort_by_key(|v| v.0);
        items.into()
    }
    pub fn recovery(&self) -> Result<Recovery, Error> {
        let mut snap = TopicStore::new(TopicId(self.source.topic.clone()))
            .map_err(Error::Invalid)?
            .snapshot();
        snap.version = self.sequence;
        snap.last_source_batch = self.sequence;
        snap.offsets = self.progress.iter().map(|(p, (o, _))| (*p, *o)).collect();
        snap.rows = self.rows.values().filter_map(|(_, r)| r.clone()).collect();
        snap.recent_batches = self.batch_history();
        Ok(Recovery {
            snapshot: snap,
            recent: self
                .progress
                .keys()
                .map(|p| (*p, self.recent(*p)))
                .collect(),
        })
    }
    pub fn audit(&self) -> Result<(), Error> {
        if self.root != self.expected_root {
            return Err(Error::Corrupt("canonical row-set digest mismatch".into()));
        }
        if self.cursors.len() != self.partitions as usize
            || self
                .progress
                .iter()
                .any(|(p, (o, _))| self.cursors.get(p).is_none_or(|next| *next <= *o))
        {
            return Err(Error::Corrupt("missing/inconsistent source cursor".into()));
        }
        if !self.initialized {
            return Err(Error::Corrupt(
                "canonical manifest absent; explicit provision required".into(),
            ));
        }
        if (self.sequence == 0) != self.progress.is_empty()
            || self
                .rows
                .values()
                .any(|(p, _)| !self.progress.contains_key(p))
        {
            return Err(Error::Corrupt("incomplete canonical cut".into()));
        }
        let batches = self.batch_history();
        let first = self.sequence.saturating_sub(HORIZON - 1).max(1);
        if batches.iter().map(|v| v.0).collect::<Vec<_>>()
            != (first..=self.sequence).collect::<Vec<_>>()
        {
            return Err(Error::Corrupt("missing batch ring slot".into()));
        }
        if self
            .records
            .keys()
            .any(|(p, _)| !self.progress.contains_key(p))
        {
            return Err(Error::Corrupt("orphan record history".into()));
        }
        for (p, (offset, ordinal)) in &self.progress {
            let mut items = self
                .records
                .iter()
                .filter(|((part, _), _)| part == p)
                .map(|(_, v)| *v)
                .collect::<Vec<_>>();
            items.sort_by_key(|v| v.0);
            let first = ordinal.saturating_sub(HORIZON - 1).max(1);
            if items.iter().map(|v| v.0).collect::<Vec<_>>()
                != (first..=*ordinal).collect::<Vec<_>>()
                || items.last().map(|v| v.1) != Some(*offset)
                || items.windows(2).any(|w| w[0].1 >= w[1].1)
            {
                return Err(Error::Corrupt("incomplete record history/progress".into()));
            }
        }
        TopicStore::from_snapshot(self.recovery()?.snapshot).map_err(Error::Corrupt)?;
        Ok(())
    }
    pub fn plan(&self, p: u32, expected: u64, records: &[Record]) -> Result<Plan, Error> {
        if !self.initialized || expected != self.sequence {
            return Err(Error::StaleSnapshot);
        }
        if p >= self.partitions
            || records.is_empty()
            || records.len() > 1024
            || serde_json::to_vec(records)?.len() > 2 * 1024 * 1024
        {
            return Err(Error::Invalid("batch bounds".into()));
        }
        let mut keys = BTreeMap::<String, Option<ProductRow>>::new();
        for r in records {
            let id = match &r.event.mutation {
                ProductMutation::Upsert { row } => &row.id,
                ProductMutation::Delete { key } => &key.0,
            };
            keys.insert(id.clone(), self.rows.get(id).and_then(|(_, r)| r.clone()));
        }
        let mut snap = TopicStore::new(TopicId(self.source.topic.clone()))
            .map_err(Error::Invalid)?
            .snapshot();
        snap.version = self.sequence;
        snap.last_source_batch = self.sequence;
        snap.recent_batches = self.batch_history();
        snap.offsets = self.progress.iter().map(|(p, (o, _))| (*p, *o)).collect();
        snap.rows = keys.values().flatten().cloned().collect();
        let mut staged = TopicStore::from_snapshot(snap).map_err(Error::Invalid)?;
        let ids = keys.keys().cloned().collect::<Vec<_>>();
        let before = staged.observe(&ids).map_err(Error::Invalid)?;
        let mut history = self.recent(p);
        let mut last = self.progress.get(&p).map(|v| v.0);
        let mut ordinal = self.progress.get(&p).map(|v| v.1).unwrap_or(0);
        let mut events = Vec::new();
        let mut writes = Vec::new();
        for r in records {
            if r.event.partition != p || r.event.offset >= i64::MAX as u64 {
                return Err(Error::Invalid("partition/offset".into()));
            }
            let fingerprint = r.fingerprint();
            if last.is_some_and(|o| r.event.offset <= o) {
                match history.iter().find(|(o, _)| *o == r.event.offset) {
                    Some((_, f)) if *f == fingerprint => continue,
                    Some(_) => return Err(Error::Invalid("conflicting offset payload".into())),
                    None => {
                        return Err(Error::Invalid(
                            "offset outside replay horizon or unobserved gap".into(),
                        ));
                    }
                }
            }
            if self
                .cursors
                .get(&p)
                .is_none_or(|next| r.event.offset < *next)
            {
                return Err(Error::Invalid(
                    "new record inside previously proven source gap".into(),
                ));
            }
            let id = match &r.event.mutation {
                ProductMutation::Upsert { row } => &row.id,
                ProductMutation::Delete { key } => &key.0,
            };
            if self.rows.get(id).is_some_and(|(owner, _)| *owner != p) {
                return Err(Error::Invalid("row belongs to another partition".into()));
            }
            ordinal = ordinal
                .checked_add(1)
                .ok_or_else(|| Error::Invalid("record ordinal exhausted".into()))?;
            writes.push((
                p,
                Value::Record {
                    ordinal,
                    offset: r.event.offset,
                    fingerprint,
                },
            ));
            last = Some(r.event.offset);
            history.push_back((r.event.offset, fingerprint));
            if history.len() > 256 {
                history.pop_front();
            }
            events.push(r.event.clone());
        }
        let batch = if events.is_empty() {
            None
        } else {
            let sequence = self
                .sequence
                .checked_add(1)
                .ok_or_else(|| Error::Invalid("sequence exhausted".into()))?;
            let batch = SourceBatch {
                topic: TopicId(self.source.topic.clone()),
                schema: self.source.schema.clone(),
                sequence,
                mutations: events,
            };
            staged.apply_source(batch.clone()).map_err(Error::Invalid)?;
            let after = staged.observe(&ids).map_err(Error::Invalid)?;
            for (id, row) in &after.rows {
                if before.rows.get(id) != Some(row) || !self.rows.contains_key(id) {
                    writes.push((
                        p,
                        Value::Row {
                            id: id.clone(),
                            owner: p,
                            row: row.clone(),
                        },
                    ));
                }
            }
            writes.push((
                p,
                Value::Cursor {
                    next: last.unwrap() + 1,
                },
            ));
            writes.push((
                p,
                Value::Progress {
                    offset: last.unwrap(),
                    ordinal,
                },
            ));
            let fingerprint = staged.snapshot().recent_batches.back().unwrap().1;
            writes.push((
                0,
                Value::Batch {
                    sequence,
                    fingerprint,
                },
            ));
            let mut manifest = self.manifest(sequence);
            if let Value::Manifest { root, .. } = &mut manifest {
                for (_, v) in &writes {
                    if let Value::Row { id, owner, row } = v {
                        if let Some((old_owner, old_row)) = self.rows.get(id) {
                            xor(root, row_digest(id, *old_owner, old_row));
                        }
                        xor(root, row_digest(id, *owner, row));
                    }
                }
            }
            writes.push((0, manifest));
            Some(batch)
        };
        let after = staged.observe(&ids).map_err(Error::Invalid)?;
        Ok(Plan {
            committed: Committed {
                before,
                after,
                batch,
            },
            writes,
        })
    }
}

fn row_digest(id: &str, owner: u32, row: &Option<ProductRow>) -> [u8; 32] {
    Sha256::digest(serde_json::to_vec(&(id, owner, row)).expect("typed row")).into()
}
fn xor(root: &mut [u8; 32], value: [u8; 32]) {
    for (a, b) in root.iter_mut().zip(value) {
        *a ^= b;
    }
}
