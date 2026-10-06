//! Source-neutral durable canonical state. SQLite objects never cross the engine seam.
use crate::coordination::{MAX_PARTITIONS, Partition, RECENT_EVENTS, Record, Recovery};
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use rust_differential_product_core::{
    product::ProductRow,
    source::{MAX_BATCH_MUTATIONS, ProductMutation, SourceBatch},
    topic::{SourceObservation, TopicId, TopicStore},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path, time::Duration};

pub const FORMAT_VERSION: u32 = 3;
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceIdentity {
    /// Operator-managed identity of cluster + topic lifetime. Required, never inferred from name.
    pub incarnation: String,
    pub topic: String,
    pub schema: String,
}
impl SourceIdentity {
    fn validate(&self) -> Result<(), Error> {
        if self.incarnation.is_empty()
            || self.incarnation.len() > 512
            || self.schema != "product-v1"
        {
            return Err(Error::Identity);
        }
        TopicStore::new(TopicId(self.topic.clone())).map_err(Error::Invalid)?;
        Ok(())
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Error {
    Storage(String),
    Corrupt(String),
    Format(u32),
    Identity,
    Fenced,
    StaleSnapshot,
    Invalid(String),
    RetentionGap {
        topic: String,
        partition: u32,
        required: u64,
        earliest: u64,
        checkpoint: u64,
        incarnation: String,
    },
    SourceTruncated {
        required: u64,
        high: u64,
    },
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for Error {}
impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        Self::Storage(e.to_string())
    }
}
impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Self::Corrupt(e.to_string())
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Token {
    pub(crate) source: SourceIdentity,
    pub(crate) store_id: String,
    pub(crate) partition: u32,
    pub(crate) epoch: u64,
    pub(crate) owner: String,
}
impl Token {
    pub fn partition(&self) -> Partition {
        Partition {
            topic: self.source.topic.clone(),
            partition: self.partition,
        }
    }
    pub fn epoch(&self) -> u64 {
        self.epoch
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Ownership {
    epoch: u64,
    owner: Option<String>,
    checkpoint_label: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct State {
    format: u32,
    source: SourceIdentity,
    store_id: String,
    recovery: Recovery,
    partitions: BTreeMap<u32, Ownership>,
    /// Sticky even after deletion: moving a key across partitions requires an explicit rebuild.
    row_partitions: BTreeMap<String, u32>,
}
impl State {
    fn validate(&self, source: &SourceIdentity, complete: bool) -> Result<(), Error> {
        if self.format != FORMAT_VERSION && self.format != 1 && self.format != 2 {
            return Err(Error::Format(self.format));
        }
        if &self.source != source {
            return Err(Error::Identity);
        }
        source.validate()?;
        if self.store_id.len() != 32 || !self.store_id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(Error::Corrupt("store identity".into()));
        }
        let snap = &self.recovery.snapshot;
        if snap.topic.0 != source.topic || snap.schema != source.schema {
            return Err(Error::Identity);
        }
        TopicStore::from_snapshot(snap.clone()).map_err(Error::Corrupt)?;
        if self.partitions.len() > MAX_PARTITIONS
            || self.partitions.iter().any(|(p, o)| {
                *p > i32::MAX as u32
                    || o.epoch == 0
                    || o.owner
                        .as_ref()
                        .is_some_and(|s| s.is_empty() || s.len() > 512)
                    || o.checkpoint_label.as_ref().is_some_and(|s| s.len() > 1024)
            })
        {
            return Err(Error::Corrupt("partition ownership metadata".into()));
        }
        if self
            .row_partitions
            .iter()
            .any(|(id, p)| id.is_empty() || id.len() > 512 || !snap.offsets.contains_key(p))
            || snap
                .rows
                .iter()
                .any(|r| !self.row_partitions.contains_key(&r.id))
            || snap.rows.windows(2).any(|w| w[0].id >= w[1].id)
        {
            return Err(Error::Corrupt("row partition ownership".into()));
        }
        if self.recovery.recent.len() != snap.offsets.len() {
            return Err(Error::Corrupt("missing replay metadata".into()));
        }
        for (p, offset) in &snap.offsets {
            let history = self
                .recovery
                .recent
                .get(p)
                .ok_or_else(|| Error::Corrupt("missing replay history".into()))?;
            if !self.partitions.contains_key(p)
                || *offset >= i64::MAX as u64
                || history.is_empty()
                || history.len() > RECENT_EVENTS
                || history.back().map(|v| v.0) != Some(*offset)
                || history
                    .iter()
                    .zip(history.iter().skip(1))
                    .any(|(a, b)| a.0 >= b.0)
            {
                return Err(Error::Corrupt("invalid replay/offset metadata".into()));
            }
        }
        if (complete && (snap.last_source_batch == 0) != snap.offsets.is_empty())
            || snap.version != snap.last_source_batch
            || (snap.last_source_batch > 0
                && snap.recent_batches.back().map(|v| v.0) != Some(snap.last_source_batch))
        {
            return Err(Error::Corrupt("canonical version metadata".into()));
        }
        Ok(())
    }
    fn fence(&self, token: &Token) -> Result<(), Error> {
        if token.source != self.source
            || token.store_id != self.store_id
            || self
                .partitions
                .get(&token.partition)
                .is_none_or(|o| o.epoch != token.epoch || o.owner.as_ref() != Some(&token.owner))
        {
            return Err(Error::Fenced);
        }
        Ok(())
    }
}
#[derive(Clone, Debug)]
pub struct Committed {
    pub before: SourceObservation,
    pub after: SourceObservation,
    /// None means verified replay, with no canonical version change.
    pub batch: Option<SourceBatch>,
}
/// Atomicity covers fencing, canonical rows, sticky key ownership, inclusive offsets,
/// both replay histories and topic/source version. No engine or Kafka handles here.
pub trait DurableStore {
    fn load(&mut self) -> Result<Recovery, Error>;
    fn acquire(&mut self, partition: u32, owner: &str) -> Result<(Token, Recovery), Error>;
    fn release(&mut self, token: &Token) -> Result<(), Error>;
    fn commit(
        &mut self,
        token: &Token,
        expected_sequence: u64,
        records: &[Record],
    ) -> Result<Committed, Error>;
    fn guard<T>(
        &mut self,
        tokens: &[Token],
        coherent_sequence: u64,
        action: impl FnOnce() -> Result<T, Error>,
    ) -> Result<T, Error>;
    /// Guard an external action while transfer is excluded. Broker progress remains only a hint.
    fn authorize<T>(
        &mut self,
        token: &Token,
        coherent_sequence: u64,
        action: impl FnOnce(u64) -> Result<T, Error>,
    ) -> Result<T, Error>;
}
/// Hook API makes transaction boundaries testable without environment-controlled production faults.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Point {
    BeforeTransaction,
    BeforeCommit,
    AfterCommit,
    DuringTransfer,
    AfterFence,
}
/// Actual application work, including failed attempts; SQL counters exclude connection PRAGMAs.
/// Encoded bytes are bound key UTF-8 + JSON BLOB + SHA256 bytes; not physical SQLite IO.
#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
pub struct Work {
    pub rows_fetched: u64,
    pub row_lookups: u64,
    pub ownership_lookups: u64,
    pub rows_written: u64,
    pub rows_deleted: u64,
    pub ownership_written: u64,
    pub metadata_reads: u64,
    pub global_records_validated: u64,
    pub partition_records_validated: u64,
    pub global_history_entries_decoded: u64,
    pub partition_history_entries_decoded: u64,
    pub guarded_leases: u64,
    pub guard_validation_ns: u64,
    pub guard_action_ns: u64,
    pub receipt_coordinates_copied: u64,
    pub metadata_bytes_decoded: u64,
    pub metadata_bytes_encoded: u64,
    /// Metadata digest input bytes; row/sticky work is separately counted.
    pub digest_bytes_hashed: u64,
    pub partition_objects_read: u64,
    pub partition_objects_written: u64,
    pub partition_scans: u64,
    pub global_write_ns: u64,
    pub sqlite_commit_ns: u64,
    pub metadata_writes: u64,
    pub replay_records_checked: u64,
    pub full_scans: u64,
    pub reconstructions: u64,
    pub bytes_encoded: u64,
    pub sql_operations: u64,
    pub transactions: u64,
}
const ROW_SCHEMA: &str = "CREATE TABLE rows (id TEXT PRIMARY KEY, payload BLOB NOT NULL, digest BLOB NOT NULL) STRICT; CREATE TABLE sticky (id TEXT PRIMARY KEY, partition INTEGER NOT NULL, digest BLOB NOT NULL) STRICT;";
const PARTITION_SCHEMA: &str = "CREATE TABLE partitions (partition INTEGER PRIMARY KEY CHECK(partition>=0 AND partition<=2147483647), payload BLOB NOT NULL, digest BLOB NOT NULL) STRICT;";
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PartitionState {
    partition: u32,
    ownership: Ownership,
    offset: Option<u64>,
    recent: std::collections::VecDeque<(u64, [u8; 32])>,
}
pub struct SqliteStore {
    connection: Connection,
    source: SourceIdentity,
    work: Work,
    // Exact full offset vector loaded only at explicit reconstruction boundaries. The
    // global sequence under BEGIN IMMEDIATE proves this cache is still the same cut.
    // It preserves complete v9 receipts without reading unrelated disk partitions.
    cut: Option<(u64, BTreeMap<u32, u64>)>,
}
impl SqliteStore {
    /// Explicit creation only. Existing, empty, partially initialized or corrupt files never reset.
    pub fn create(path: impl AsRef<Path>, source: SourceIdentity) -> Result<Self, Error> {
        source.validate()?;
        let path = path.as_ref();
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|e| Error::Storage(e.to_string()))?;
        file.sync_all().map_err(|e| Error::Storage(e.to_string()))?;
        let connection = Self::connect(path)?;
        let store_id =
            connection.query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get(0))?;
        let state = State {
            format: FORMAT_VERSION,
            source: source.clone(),
            store_id,
            recovery: Recovery {
                snapshot: TopicStore::new(TopicId(source.topic.clone()))
                    .map_err(Error::Invalid)?
                    .snapshot(),
                recent: BTreeMap::new(),
            },
            partitions: BTreeMap::new(),
            row_partitions: BTreeMap::new(),
        };
        let mut store = Self {
            connection,
            source,
            work: Work::default(),
            cut: Some((0, BTreeMap::new())),
        };
        let tx = store
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute_batch("CREATE TABLE canonical (id INTEGER PRIMARY KEY CHECK(id=1), format INTEGER NOT NULL, payload BLOB NOT NULL, digest BLOB NOT NULL) STRICT;")?;
        tx.execute_batch(ROW_SCHEMA)?;
        tx.execute_batch(PARTITION_SCHEMA)?;
        let payload = serde_json::to_vec(&state)?;
        tx.execute(
            "INSERT INTO canonical VALUES (1, ?1, ?2, ?3)",
            rusqlite::params![
                FORMAT_VERSION,
                &payload,
                Sha256::digest(&payload).as_slice()
            ],
        )?;
        tx.commit()?;
        // Creation durability also needs the directory entry, beyond SQLite's file/WAL syncs.
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        std::fs::File::open(parent)
            .and_then(|f| f.sync_all())
            .map_err(|e| Error::Storage(e.to_string()))?;
        Ok(store)
    }
    pub fn open(path: impl AsRef<Path>, source: SourceIdentity) -> Result<Self, Error> {
        source.validate()?;
        let connection = Self::connect(path.as_ref())?;
        let mut store = Self {
            connection,
            source,
            work: Work::default(),
            cut: Some((0, BTreeMap::new())),
        };
        let check: String = store
            .connection
            .query_row("PRAGMA quick_check", [], |r| r.get(0))?;
        if check != "ok" {
            return Err(Error::Corrupt(check));
        }
        let tx = store.connection.transaction()?;
        let full = Self::read_full(&tx, &store.source, &mut store.work)?;
        store.cut = Some((
            full.recovery.snapshot.last_source_batch,
            full.recovery.snapshot.offsets,
        ));
        tx.commit()?;
        Ok(store)
    }
    fn connect(path: &Path) -> Result<Connection, Error> {
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON; PRAGMA wal_autocheckpoint=1000; PRAGMA trusted_schema=OFF;")?;
        let mode: String = connection.query_row("PRAGMA journal_mode", [], |r| r.get(0))?;
        let sync: u32 = connection.query_row("PRAGMA synchronous", [], |r| r.get(0))?;
        if mode != "wal" || sync != 2 {
            return Err(Error::Storage("required WAL/FULL unavailable".into()));
        }
        Ok(connection)
    }
    fn envelope(
        connection: &Connection,
        source: &SourceIdentity,
        format_expected: u32,
        work: &mut Work,
    ) -> Result<State, Error> {
        work.metadata_reads += 1;
        work.sql_operations += 1;
        let (format, payload, digest): (u32, Vec<u8>, Vec<u8>) = connection
            .query_row(
                "SELECT format, payload, digest FROM canonical WHERE id=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|e| Error::Corrupt(format!("missing/corrupt canonical metadata: {e}")))?;
        work.metadata_bytes_decoded += payload.len() as u64;
        work.digest_bytes_hashed += payload.len() as u64;
        if format != format_expected {
            return Err(Error::Format(format));
        }
        if Sha256::digest(&payload).as_slice() != digest {
            return Err(Error::Corrupt("checkpoint digest mismatch".into()));
        }
        let state: State = serde_json::from_slice(&payload)?;
        if state.format != format_expected {
            return Err(Error::Format(state.format));
        }
        work.global_history_entries_decoded += state.recovery.snapshot.recent_batches.len() as u64;
        state.validate(source, format_expected != FORMAT_VERSION)?;
        work.global_records_validated += 1;
        Ok(state)
    }
    fn read(
        connection: &Connection,
        source: &SourceIdentity,
        work: &mut Work,
    ) -> Result<State, Error> {
        let state = Self::envelope(connection, source, FORMAT_VERSION, work)?;
        if !state.recovery.snapshot.rows.is_empty()
            || !state.row_partitions.is_empty()
            || !state.partitions.is_empty()
            || !state.recovery.snapshot.offsets.is_empty()
            || !state.recovery.recent.is_empty()
        {
            return Err(Error::Corrupt(
                "format 3 global metadata contains partition/dataset state".into(),
            ));
        }
        Ok(state)
    }
    fn attach_partition(
        state: &mut State,
        p: u32,
        payload: Vec<u8>,
        digest: Vec<u8>,
        work: &mut Work,
    ) -> Result<(), Error> {
        work.metadata_reads += 1;
        work.partition_objects_read += 1;
        work.metadata_bytes_decoded += payload.len() as u64;
        work.digest_bytes_hashed += payload.len() as u64;
        if Sha256::digest(&payload).as_slice() != digest {
            return Err(Error::Corrupt("partition digest mismatch".into()));
        }
        let part: PartitionState = serde_json::from_slice(&payload)?;
        work.partition_history_entries_decoded += part.recent.len() as u64;
        if part.partition != p || (part.offset.is_none() != part.recent.is_empty()) {
            return Err(Error::Corrupt("partition key/progress mismatch".into()));
        }
        state.partitions.insert(p, part.ownership);
        if let Some(offset) = part.offset {
            state.recovery.snapshot.offsets.insert(p, offset);
            state.recovery.recent.insert(p, part.recent);
        }
        Ok(())
    }
    fn read_partition(
        connection: &Connection,
        state: &mut State,
        p: u32,
        work: &mut Work,
    ) -> Result<(), Error> {
        work.sql_operations += 1;
        let value: Option<(Vec<u8>, Vec<u8>)> = connection
            .query_row(
                "SELECT payload,digest FROM partitions WHERE partition=?1",
                [p],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((payload, digest)) = value {
            Self::attach_partition(state, p, payload, digest, work)?;
        }
        state.validate(&state.source, false)?;
        work.partition_records_validated += state.partitions.contains_key(&p) as u64;
        Ok(())
    }
    fn read_local(
        connection: &Connection,
        source: &SourceIdentity,
        p: u32,
        work: &mut Work,
    ) -> Result<State, Error> {
        let mut state = Self::read(connection, source, work)?;
        Self::read_partition(connection, &mut state, p, work)?;
        Ok(state)
    }
    fn decode_row(
        id: &str,
        payload: Vec<u8>,
        digest: Vec<u8>,
        work: &mut Work,
    ) -> Result<ProductRow, Error> {
        work.rows_fetched += 1;
        if Sha256::digest(&payload).as_slice() != digest {
            return Err(Error::Corrupt("row digest mismatch".into()));
        }
        let row: ProductRow = serde_json::from_slice(&payload)?;
        if row.id != id {
            return Err(Error::Corrupt("row key mismatch".into()));
        }
        Ok(row)
    }
    fn read_full(
        connection: &Connection,
        source: &SourceIdentity,
        work: &mut Work,
    ) -> Result<State, Error> {
        let state = Self::read(connection, source, work)?;
        Self::read_full_from(connection, source, state, work)
    }
    fn read_full_from(
        connection: &Connection,
        source: &SourceIdentity,
        mut state: State,
        work: &mut Work,
    ) -> Result<State, Error> {
        if state.format == FORMAT_VERSION {
            work.partition_scans += 1;
            work.full_scans += 1;
            work.sql_operations += 1;
            let mut parts = connection
                .prepare("SELECT partition,payload,digest FROM partitions ORDER BY partition")?;
            for item in parts.query_map([], |r| Ok((r.get::<_, u32>(0)?, r.get(1)?, r.get(2)?)))? {
                let (p, payload, digest) = item?;
                Self::attach_partition(&mut state, p, payload, digest, work)?;
            }
        }
        work.full_scans += 2;
        work.reconstructions += 1;
        work.sql_operations += 2;
        let mut rows = connection.prepare("SELECT id,payload,digest FROM rows ORDER BY id")?;
        for item in rows.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get(1)?, r.get(2)?)))? {
            let (id, payload, digest) = item?;
            state
                .recovery
                .snapshot
                .rows
                .push(Self::decode_row(&id, payload, digest, work)?);
        }
        let mut owners =
            connection.prepare("SELECT id,partition,digest FROM sticky ORDER BY id")?;
        for item in owners.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, u32>(1)?,
                r.get::<_, Vec<u8>>(2)?,
            ))
        })? {
            let (id, partition, digest) = item?;
            if Self::owner_digest(&id, partition).as_slice() != digest {
                return Err(Error::Corrupt("sticky digest mismatch".into()));
            }
            state.row_partitions.insert(id, partition);
        }
        state.validate(source, true)?;
        Ok(state)
    }
    fn write_partition(
        connection: &Connection,
        state: &State,
        p: u32,
        work: &mut Work,
    ) -> Result<(), Error> {
        state.validate(&state.source, false)?;
        let part = PartitionState {
            partition: p,
            ownership: state.partitions.get(&p).ok_or(Error::Fenced)?.clone(),
            offset: state.recovery.snapshot.offsets.get(&p).copied(),
            recent: state.recovery.recent.get(&p).cloned().unwrap_or_default(),
        };
        let bytes = serde_json::to_vec(&part)?;
        work.metadata_bytes_encoded += bytes.len() as u64;
        work.digest_bytes_hashed += bytes.len() as u64;
        work.bytes_encoded += bytes.len() as u64 + 32 + 4;
        work.metadata_writes += 1;
        work.partition_objects_written += 1;
        work.sql_operations += 1;
        connection.execute("INSERT INTO partitions VALUES (?1,?2,?3) ON CONFLICT(partition) DO UPDATE SET payload=excluded.payload,digest=excluded.digest",rusqlite::params![p,&bytes,Sha256::digest(&bytes).as_slice()])?;
        Ok(())
    }
    fn write(connection: &Connection, state: &State, work: &mut Work) -> Result<(), Error> {
        let started = std::time::Instant::now();
        if !state.recovery.snapshot.rows.is_empty() || !state.row_partitions.is_empty() {
            return Err(Error::Corrupt("attempted full metadata write".into()));
        }
        state.validate(&state.source, false)?;
        let mut global = state.clone();
        global.partitions.clear();
        global.recovery.snapshot.offsets.clear();
        global.recovery.recent.clear();
        let bytes = serde_json::to_vec(&global)?;
        work.metadata_bytes_encoded += bytes.len() as u64;
        work.digest_bytes_hashed += bytes.len() as u64;
        work.bytes_encoded += bytes.len() as u64 + 32;
        work.metadata_writes += 1;
        work.sql_operations += 1;
        if connection.execute(
            "UPDATE canonical SET format=?1,payload=?2,digest=?3 WHERE id=1",
            rusqlite::params![FORMAT_VERSION, &bytes, Sha256::digest(&bytes).as_slice()],
        )? != 1
        {
            return Err(Error::Corrupt("missing canonical row".into()));
        }
        work.global_write_ns += started.elapsed().as_nanos() as u64;
        Ok(())
    }
    fn owner_digest(id: &str, partition: u32) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(partition.to_le_bytes());
        h.update(id.as_bytes());
        h.finalize().into()
    }
    fn put_row(connection: &Connection, row: &ProductRow, work: &mut Work) -> Result<(), Error> {
        let bytes = serde_json::to_vec(row)?;
        work.bytes_encoded += row.id.len() as u64 + bytes.len() as u64 + 32;
        work.sql_operations += 1;
        work.rows_written += connection.execute("INSERT INTO rows VALUES (?1,?2,?3) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,digest=excluded.digest",
            rusqlite::params![&row.id, &bytes, Sha256::digest(&bytes).as_slice()])? as u64;
        Ok(())
    }
    /// Explicit OFFLINE operation, in place and atomic. Caller must exclude every old owner
    /// for the entire migration (including old binaries). Never called by open/create.
    /// All owners must first be released; a fresh store ID invalidates every old token.
    pub fn migrate_v1_offline(path: impl AsRef<Path>, source: SourceIdentity) -> Result<(), Error> {
        Self::migrate_v1_with_hook(path, source, |_| Ok(()))
    }
    pub fn migrate_v1_with_hook(
        path: impl AsRef<Path>,
        source: SourceIdentity,
        mut hook: impl FnMut(Point) -> Result<(), Error>,
    ) -> Result<(), Error> {
        Self::migrate_offline(path, source, 1, &mut hook)
    }
    pub fn migrate_v2_offline(path: impl AsRef<Path>, source: SourceIdentity) -> Result<(), Error> {
        Self::migrate_v2_with_hook(path, source, |_| Ok(()))
    }
    pub fn migrate_v2_with_hook(
        path: impl AsRef<Path>,
        source: SourceIdentity,
        mut hook: impl FnMut(Point) -> Result<(), Error>,
    ) -> Result<(), Error> {
        Self::migrate_offline(path, source, 2, &mut hook)
    }
    fn migrate_offline(
        path: impl AsRef<Path>,
        source: SourceIdentity,
        old_format: u32,
        hook: &mut impl FnMut(Point) -> Result<(), Error>,
    ) -> Result<(), Error> {
        source.validate()?;
        let mut connection = Self::connect(path.as_ref())?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Exclusive)?;
        let mut work = Work::default();
        let mut state = Self::envelope(&tx, &source, old_format, &mut work)?;
        if old_format == 2 {
            if !state.recovery.snapshot.rows.is_empty() || !state.row_partitions.is_empty() {
                return Err(Error::Corrupt("v2 metadata contains dataset".into()));
            }
            state = Self::read_full_from(&tx, &source, state, &mut work)?;
        }
        if state.partitions.values().any(|p| p.owner.is_some()) {
            return Err(Error::Invalid(
                "offline migration requires released owners and external exclusion".into(),
            ));
        }
        if old_format == 1 {
            tx.execute_batch(ROW_SCHEMA)?;
        }
        for row in std::mem::take(&mut state.recovery.snapshot.rows) {
            Self::put_row(&tx, &row, &mut work)?;
        }
        for (id, partition) in std::mem::take(&mut state.row_partitions) {
            tx.execute(
                "INSERT INTO sticky VALUES (?1,?2,?3) ON CONFLICT(id) DO NOTHING",
                rusqlite::params![id, partition, Self::owner_digest(&id, partition).as_slice()],
            )?;
        }
        state.format = FORMAT_VERSION;
        tx.execute_batch(PARTITION_SCHEMA)?;
        for p in state.partitions.keys() {
            Self::write_partition(&tx, &state, *p, &mut work)?;
        }
        state.store_id = tx.query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get(0))?;
        Self::write(&tx, &state, &mut work)?;
        hook(Point::BeforeCommit)?;
        tx.commit()?;
        hook(Point::AfterCommit)?;
        Ok(())
    }
    pub fn work(&self) -> Work {
        self.work
    }
    pub fn reset_work(&mut self) {
        self.work = Work::default();
    }
    pub fn acquire_with_hook(
        &mut self,
        partition: u32,
        owner: &str,
        mut hook: impl FnMut(Point) -> Result<(), Error>,
    ) -> Result<(Token, Recovery), Error> {
        if owner.is_empty() || owner.len() > 512 || partition > i32::MAX as u32 {
            return Err(Error::Invalid("owner/partition".into()));
        }
        self.work.transactions += 1;
        self.work.sql_operations += 1; // Explicit BEGIN attempt; implicit rollback is excluded.
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut state = Self::read_local(&tx, &self.source, partition, &mut self.work)?;
        self.work.sql_operations += 1;
        self.work.partition_scans += 1;
        let count: i64 = tx.query_row("SELECT count(*) FROM partitions", [], |r| r.get(0))?;
        if !state.partitions.contains_key(&partition) && count >= MAX_PARTITIONS as i64 {
            return Err(Error::Invalid("partition quota".into()));
        }
        let epoch = state
            .partitions
            .get(&partition)
            .map_or(0, |o| o.epoch)
            .checked_add(1)
            .ok_or_else(|| Error::Invalid("epoch exhausted".into()))?;
        let label = state
            .partitions
            .get(&partition)
            .and_then(|o| o.checkpoint_label.clone());
        state.partitions.insert(
            partition,
            Ownership {
                epoch,
                owner: Some(owner.into()),
                checkpoint_label: label,
            },
        );
        let token = Token {
            source: self.source.clone(),
            store_id: state.store_id.clone(),
            partition,
            epoch,
            owner: owner.into(),
        };
        Self::write_partition(&tx, &state, partition, &mut self.work)?;
        let recovery = Self::read_full(&tx, &self.source, &mut self.work)?.recovery;
        hook(Point::DuringTransfer)?;
        self.work.sql_operations += 1;
        tx.commit()?;
        hook(Point::AfterFence)?;
        self.cut = Some((
            recovery.snapshot.last_source_batch,
            recovery.snapshot.offsets.clone(),
        ));
        Ok((token, recovery))
    }
    pub fn commit_with_hook(
        &mut self,
        token: &Token,
        expected_sequence: u64,
        records: &[Record],
        mut hook: impl FnMut(Point) -> Result<(), Error>,
    ) -> Result<Committed, Error> {
        hook(Point::BeforeTransaction)?;
        self.work.transactions += 1;
        self.work.sql_operations += 1; // Explicit BEGIN attempt; implicit rollback is excluded.
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut state = Self::read_local(&tx, &self.source, token.partition, &mut self.work)?;
        state.fence(token)?;
        if state.recovery.snapshot.last_source_batch != expected_sequence
            || self
                .cut
                .as_ref()
                .is_none_or(|(sequence, _)| *sequence != expected_sequence)
        {
            return Err(Error::StaleSnapshot);
        }
        if records.is_empty() || records.len() > MAX_BATCH_MUTATIONS {
            return Err(Error::Invalid("batch quota".into()));
        }
        if serde_json::to_vec(records)?.len() > 2 * 1024 * 1024 {
            return Err(Error::Invalid("decoded batch byte quota".into()));
        }
        // Only bounded touched keys are materialized, including intermediate overwritten keys.
        let keys: std::collections::BTreeSet<String> = records
            .iter()
            .map(|r| match &r.event.mutation {
                ProductMutation::Upsert { row } => row.id.clone(),
                ProductMutation::Delete { key } => key.0.clone(),
            })
            .collect();
        let keys: Vec<_> = keys.into_iter().collect();
        let mut owners = BTreeMap::new();
        for id in &keys {
            self.work.row_lookups += 1;
            self.work.ownership_lookups += 1;
            self.work.sql_operations += 2;
            let row: Option<(Vec<u8>, Vec<u8>)> = tx
                .query_row("SELECT payload,digest FROM rows WHERE id=?1", [id], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .optional()?;
            if let Some((payload, digest)) = row {
                state.recovery.snapshot.rows.push(Self::decode_row(
                    id,
                    payload,
                    digest,
                    &mut self.work,
                )?);
            }
            let owner: Option<(u32, Vec<u8>)> = tx
                .query_row(
                    "SELECT partition,digest FROM sticky WHERE id=?1",
                    [id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            if let Some((p, digest)) = owner {
                if Self::owner_digest(id, p).as_slice() != digest {
                    return Err(Error::Corrupt("sticky digest mismatch".into()));
                }
                owners.insert(id.clone(), p);
            }
        }
        let mut canonical = TopicStore::from_snapshot(std::mem::replace(
            &mut state.recovery.snapshot,
            TopicStore::new(TopicId(self.source.topic.clone()))
                .map_err(Error::Invalid)?
                .snapshot(),
        ))
        .map_err(Error::Corrupt)?;
        let mut before = canonical.observe(&keys).map_err(Error::Invalid)?;
        before.offsets = self.cut.as_ref().ok_or(Error::StaleSnapshot)?.1.clone();
        self.work.receipt_coordinates_copied += before.offsets.len() as u64;
        // Metadata snapshot here is sparse; never reconstruct the retained dataset on commit.
        state.recovery.snapshot = canonical.snapshot();
        let p = token.partition;
        let mut last = state.recovery.snapshot.offsets.get(&p).copied();
        let mut history = state.recovery.recent.get(&p).cloned().unwrap_or_default();
        let mut mutations = Vec::new();
        for record in records {
            let event = &record.event;
            if event.partition != p || event.offset >= i64::MAX as u64 {
                return Err(Error::Invalid("partition/offset".into()));
            }
            self.work.replay_records_checked += 1;
            let fingerprint = record.fingerprint();
            if last.is_some_and(|o| event.offset <= o) {
                match history.iter().find(|(o, _)| *o == event.offset) {
                    Some((_, old)) if old == &fingerprint => continue,
                    Some(_) => return Err(Error::Invalid("conflicting offset payload".into())),
                    None => {
                        return Err(Error::Invalid(
                            "offset outside replay horizon or unobserved gap".into(),
                        ));
                    }
                }
            }
            let id = match &event.mutation {
                ProductMutation::Upsert { row } => &row.id,
                ProductMutation::Delete { key } => &key.0,
            };
            if owners.get(id).is_some_and(|old| *old != p) {
                return Err(Error::Invalid(
                    "row belongs to another partition; explicit rebuild required".into(),
                ));
            }
            owners.insert(id.clone(), p);
            last = Some(event.offset);
            history.push_back((event.offset, fingerprint));
            if history.len() > RECENT_EVENTS {
                history.pop_front();
            }
            mutations.push(event.clone());
        }
        let batch = if mutations.is_empty() {
            None
        } else {
            let sequence = expected_sequence
                .checked_add(1)
                .ok_or_else(|| Error::Invalid("sequence exhausted".into()))?;
            let batch = SourceBatch {
                topic: TopicId(self.source.topic.clone()),
                schema: self.source.schema.clone(),
                sequence,
                mutations,
            };
            canonical
                .apply_source(batch.clone())
                .map_err(Error::Invalid)?;
            let after = canonical.observe(&keys).map_err(Error::Invalid)?;
            for (id, row) in &after.rows {
                if before.rows.get(id) != Some(row) {
                    match row {
                        Some(row) => Self::put_row(&tx, row, &mut self.work)?,
                        None => {
                            self.work.sql_operations += 1;
                            self.work.bytes_encoded += id.len() as u64;
                            self.work.rows_deleted +=
                                tx.execute("DELETE FROM rows WHERE id=?1", [id])? as u64;
                        }
                    }
                }
            }
            // Every new input was checked above, even when its final transition cancels.
            for (id, partition) in &owners {
                self.work.sql_operations += 1;
                self.work.bytes_encoded += id.len() as u64 + 4 + 32;
                self.work.ownership_written += tx.execute(
                    "INSERT INTO sticky VALUES (?1,?2,?3) ON CONFLICT(id) DO NOTHING",
                    rusqlite::params![id, partition, Self::owner_digest(id, *partition).as_slice()],
                )? as u64;
            }
            state.recovery.snapshot = canonical.snapshot();
            state.recovery.snapshot.rows.clear();
            state.recovery.recent.insert(p, history);
            Self::write_partition(&tx, &state, p, &mut self.work)?;
            Self::write(&tx, &state, &mut self.work)?;
            Some(batch)
        };
        hook(Point::BeforeCommit)?;
        self.work.sql_operations += 1;
        // Invalidate before COMMIT: even a failed COMMIT can have an uncertain outcome.
        self.cut = None;
        let commit_started = std::time::Instant::now();
        tx.commit()?;
        self.work.sqlite_commit_ns += commit_started.elapsed().as_nanos() as u64;
        hook(Point::AfterCommit)?;
        let mut after = canonical.observe(&keys).map_err(Error::Invalid)?;
        self.work.receipt_coordinates_copied += before.offsets.len() as u64;
        let mut offsets = before.offsets.clone();
        offsets.extend(after.offsets);
        after.offsets = offsets;
        self.work.receipt_coordinates_copied += after.offsets.len() as u64;
        self.cut = Some((after.sequence, after.offsets.clone()));
        Ok(Committed {
            before,
            after,
            batch,
        })
    }
    /// Checkpoint-only metadata never accepts arbitrary rows, positions or replay history.
    pub fn label_checkpoint(&mut self, token: &Token, label: &str) -> Result<(), Error> {
        if label.len() > 1024 {
            return Err(Error::Invalid("checkpoint label quota".into()));
        }
        self.work.transactions += 1;
        self.work.sql_operations += 1; // Explicit BEGIN attempt; implicit rollback is excluded.
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut state = Self::read_local(&tx, &self.source, token.partition, &mut self.work)?;
        state.fence(token)?;
        state
            .partitions
            .get_mut(&token.partition)
            .unwrap()
            .checkpoint_label = Some(label.into());
        Self::write_partition(&tx, &state, token.partition, &mut self.work)?;
        self.work.sql_operations += 1;
        tx.commit()?;
        Ok(())
    }
    /// Online consistent backup; destination must not exist. Never copy the live .db alone.
    pub fn backup(&self, destination: impl AsRef<Path>) -> Result<(), Error> {
        let path = destination.as_ref();
        let f = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(path)
            .map_err(|e| Error::Storage(e.to_string()))?;
        drop(f);
        self.connection.backup(rusqlite::MAIN_DB, path, None)?;
        std::fs::File::open(path)
            .and_then(|f| f.sync_all())
            .map_err(|e| Error::Storage(e.to_string()))?;
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        std::fs::File::open(parent)
            .and_then(|f| f.sync_all())
            .map_err(|e| Error::Storage(e.to_string()))?;
        Ok(())
    }
    pub fn source(&self) -> &SourceIdentity {
        &self.source
    }
}
impl DurableStore for SqliteStore {
    fn load(&mut self) -> Result<Recovery, Error> {
        self.work.transactions += 1;
        self.work.sql_operations += 1;
        let tx = self.connection.transaction()?;
        let recovery = Self::read_full(&tx, &self.source, &mut self.work)?.recovery;
        self.work.sql_operations += 1;
        tx.commit()?;
        self.cut = Some((
            recovery.snapshot.last_source_batch,
            recovery.snapshot.offsets.clone(),
        ));
        Ok(recovery)
    }
    fn acquire(&mut self, partition: u32, owner: &str) -> Result<(Token, Recovery), Error> {
        self.acquire_with_hook(partition, owner, |_| Ok(()))
    }
    fn release(&mut self, token: &Token) -> Result<(), Error> {
        self.work.transactions += 1;
        self.work.sql_operations += 1; // Explicit BEGIN attempt; implicit rollback is excluded.
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut state = Self::read_local(&tx, &self.source, token.partition, &mut self.work)?;
        state.fence(token)?;
        state.partitions.get_mut(&token.partition).unwrap().owner = None;
        Self::write_partition(&tx, &state, token.partition, &mut self.work)?;
        self.work.sql_operations += 1;
        tx.commit()?;
        Ok(())
    }
    fn commit(
        &mut self,
        token: &Token,
        expected_sequence: u64,
        records: &[Record],
    ) -> Result<Committed, Error> {
        self.commit_with_hook(token, expected_sequence, records, |_| Ok(()))
    }
    fn guard<T>(
        &mut self,
        tokens: &[Token],
        coherent_sequence: u64,
        action: impl FnOnce() -> Result<T, Error>,
    ) -> Result<T, Error> {
        let guard_started = std::time::Instant::now();
        self.work.transactions += 1;
        self.work.sql_operations += 1; // Explicit BEGIN attempt; implicit rollback is excluded.
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut state = Self::read(&tx, &self.source, &mut self.work)?;
        if tokens.is_empty() {
            return Err(Error::Fenced);
        }
        for token in tokens {
            Self::read_partition(&tx, &mut state, token.partition, &mut self.work)?;
            state.fence(token)?;
            self.work.guarded_leases += 1;
            state.partitions.clear();
            state.recovery.snapshot.offsets.clear();
            state.recovery.recent.clear();
        }
        if state.recovery.snapshot.last_source_batch != coherent_sequence {
            return Err(Error::StaleSnapshot);
        }
        self.work.guard_validation_ns += guard_started.elapsed().as_nanos() as u64;
        let action_started = std::time::Instant::now();
        let result = action()?;
        self.work.guard_action_ns += action_started.elapsed().as_nanos() as u64;
        self.work.sql_operations += 1;
        tx.commit()?;
        Ok(result)
    }
    fn authorize<T>(
        &mut self,
        token: &Token,
        coherent_sequence: u64,
        action: impl FnOnce(u64) -> Result<T, Error>,
    ) -> Result<T, Error> {
        self.work.transactions += 1;
        self.work.sql_operations += 1; // Explicit BEGIN attempt; implicit rollback is excluded.
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let state = Self::read_local(&tx, &self.source, token.partition, &mut self.work)?;
        state.fence(token)?;
        if state.recovery.snapshot.last_source_batch != coherent_sequence {
            return Err(Error::StaleSnapshot);
        }
        let last = state
            .recovery
            .snapshot
            .offsets
            .get(&token.partition)
            .ok_or_else(|| Error::Invalid("no durable checkpoint".into()))?;
        let result = action(last + 1)?;
        self.work.sql_operations += 1;
        tx.commit()?;
        Ok(result)
    }
}
/// Broker commit never chooses the recovery position. Watermarks must be fetched on assignment.
pub fn recovery_next(
    source: &SourceIdentity,
    recovery: &Recovery,
    partition: u32,
    earliest: u64,
    high: u64,
) -> Result<u64, Error> {
    source.validate()?;
    if recovery.snapshot.topic.0 != source.topic || recovery.snapshot.schema != source.schema {
        return Err(Error::Identity);
    }
    let required = recovery
        .snapshot
        .offsets
        .get(&partition)
        .map(|last| {
            last.checked_add(1)
                .ok_or_else(|| Error::Corrupt("offset exhausted".into()))
        })
        .transpose()?
        .unwrap_or(0);
    if high > i64::MAX as u64 || required > i64::MAX as u64 || partition > i32::MAX as u32 {
        return Err(Error::Invalid("recovery coordinate out of range".into()));
    }
    if earliest > high {
        return Err(Error::Invalid("invalid Kafka watermarks".into()));
    }
    if required < earliest {
        return Err(Error::RetentionGap {
            topic: source.topic.clone(),
            partition,
            required,
            earliest,
            checkpoint: recovery.snapshot.last_source_batch,
            incarnation: source.incarnation.clone(),
        });
    }
    if required > high {
        return Err(Error::SourceTruncated { required, high });
    }
    Ok(required)
}
