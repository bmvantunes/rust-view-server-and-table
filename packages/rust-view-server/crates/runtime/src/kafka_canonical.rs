//! Single whole-topic Kafka transaction owner. No application filesystem state.
use crate::{
    coordination::{Authority, Delivery, Partition, Record},
    durable::{Committed, DurableStore, Error, SourceIdentity, Token},
    durable_coordinator::{DurableCoordinator, Session, SharedSession},
    kafka_state::{self, Image, Value},
    registry::{Metadata, Registry},
    wire,
};
use rdkafka::{
    ClientConfig, Message, Offset, TopicPartitionList,
    admin::{AdminClient, AdminOptions, ResourceSpecifier},
    client::{ClientContext, DefaultClientContext},
    consumer::{BaseConsumer, Consumer, ConsumerContext},
    error::KafkaError,
    producer::{BaseProducer, BaseRecord, Producer},
};
use rust_differential_product_core::{engine_contract::ProductEngine, source::SourceCommit};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    task::{Context, Poll, Wake, Waker},
    time::{Duration, Instant},
};

// Service one producer event per turn, yielding between attempts. Drainage is only
// preparation: commit_transaction below still confirms the broker transaction.
pub(crate) fn flush_producer(producer: &BaseProducer, timeout: Duration) -> Result<(), KafkaError> {
    let started = Instant::now();
    loop {
        match producer.flush(Duration::ZERO) {
            Ok(()) => return Ok(()),
            Err(e @ KafkaError::Flush(rdkafka::error::RDKafkaErrorCode::OperationTimedOut)) => {
                let Some(remaining) = timeout.checked_sub(started.elapsed()) else {
                    return Err(e);
                };
                producer.poll(Duration::ZERO);
                // Avoid the pinned timed poll's sub-millisecond deadline spin.
                std::thread::sleep(remaining.min(Duration::from_millis(1)));
            }
            Err(e) => return Err(e),
        }
    }
}

const CALL: Duration = Duration::from_secs(10);
fn storage(e: impl std::fmt::Display) -> Error {
    Error::Storage(e.to_string())
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub brokers: String,
    pub group: String,
    pub state_topic: String,
    /// Explicit provisioning, admitted only for a completely empty canonical log.
    #[serde(default)]
    pub initialize_empty: bool,
    /// Configuration-pinned validated metadata; no durable registry cache required.
    pub schemas: BTreeMap<String, Metadata>,
}
impl Registry for Config {
    fn lookup(&self, id: u32) -> Result<Metadata, String> {
        self.schemas
            .get(&id.to_string())
            .cloned()
            .ok_or_else(|| "schema ID absent from pinned configuration".into())
    }
}
#[derive(Default)]
pub(crate) struct Membership {
    pub(crate) source_topic:String,
    pub(crate) armed: AtomicBool,
    pub(crate) lost: AtomicBool,
    pub(crate) ends: Mutex<BTreeMap<u32, (i64, i64, i64)>>,
    pub(crate) diagnostics: Mutex<BTreeMap<u32, (i64,i64,u64,Instant)>>,
}
#[derive(Clone)]
pub(crate) struct KafkaContext(pub(crate) Arc<Membership>);
impl ClientContext for KafkaContext {
    fn stats(&self, s: rdkafka::statistics::Statistics) {
        let mut ends = self.0.ends.lock().expect("statistics lock");
        for topic in s.topics.values().filter(|topic|topic.topic==self.0.source_topic) {
            for (p, part) in &topic.partitions {
                if *p >= 0 {
                    self.0.diagnostics.lock().unwrap().insert(*p as u32,(part.next_offset,part.hi_offset,part.fetchq_size,Instant::now()));
                    ends.insert(
                        *p as u32,
                        (part.eof_offset, part.ls_offset, part.fetchq_cnt),
                    );
                }
            }
        }
    }
}
impl ConsumerContext for KafkaContext {
    fn rebalance(
        &self,
        consumer: &BaseConsumer<Self>,
        err: rdkafka::types::RDKafkaRespErr,
        tpl: &mut TopicPartitionList,
    ) {
        if self.0.armed.load(Ordering::SeqCst) {
            self.0.lost.store(true, Ordering::SeqCst);
        }
        let result = if err == rdkafka::types::RDKafkaRespErr::RD_KAFKA_RESP_ERR__ASSIGN_PARTITIONS
        {
            // Only the eager range assignor is configured. Initial fetch position is
            // explicit and never trusted: discard/pause, restore, then seek canonical NEXT.
            for mut e in tpl.elements() {
                e.set_offset(Offset::Beginning).expect("Beginning offset");
            }
            consumer.assign(tpl)
        } else {
            consumer.unassign()
        };
        if result.is_err() {
            self.0.lost.store(true, Ordering::SeqCst);
        }
    }
}
struct WakeThread(std::thread::Thread);
impl Wake for WakeThread {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }
    fn wake_by_ref(self: &Arc<Self>) {
        self.0.unpark();
    }
}
pub(crate) fn blocking<F: Future>(f: F) -> Result<F::Output, Error> {
    let mut f = std::pin::pin!(f);
    let w = Waker::from(Arc::new(WakeThread(std::thread::current())));
    let mut cx = Context::from_waker(&w);
    let start = Instant::now();
    loop {
        match f.as_mut().poll(&mut cx) {
            Poll::Ready(v) => return Ok(v),
            Poll::Pending => {
                if start.elapsed() > CALL {
                    return Err(storage("admin deadline"));
                }
                std::thread::park_timeout(Duration::from_millis(10));
            }
        }
    }
}
#[derive(Default, Clone, Serialize)]
pub struct RestoreMetrics {
    pub restored_sequence: u64,
    pub restored_rows: usize,
    pub restored_offsets: BTreeMap<u32, u64>,
    pub restored_next: BTreeMap<u32, u64>,
    pub records: u64,
    pub bytes: u64,
    pub superseded: u64,
    pub replay_ms: u128,
    pub engine_rebuild_ms: u128,
    pub catchup_ms: u128,
    pub start_to_cut_ms: u128,
    pub state_barriers: BTreeMap<u32, i64>,
    pub source_target: BTreeMap<u32, i64>,
}
pub struct KafkaStore {
    config: Config,
    image: Image,
    consumer: Arc<BaseConsumer<KafkaContext>>,
    membership: Arc<Membership>,
    producer: BaseProducer,
    local_id: String,
    leases: BTreeMap<u32, String>,
    failed: bool,
    pending: Option<Record>,
    eof: BTreeSet<u32>,
}
impl KafkaStore {
    fn membership(&self) -> Result<(), Error> {
        if self.failed
            || self.membership.lost.load(Ordering::SeqCst)
            || self.consumer.assignment_lost()
        {
            return Err(Error::Fenced);
        }
        let assignment = self.consumer.assignment().map_err(storage)?;
        if assignment.count() != self.image.partitions as usize
            || assignment.elements().iter().any(|e| {
                e.topic() != self.image.source.topic
                    || e.partition() < 0
                    || e.partition() >= self.image.partitions as i32
            })
        {
            return Err(Error::Fenced);
        }
        Ok(())
    }
    fn check(&self, tokens: &[Token], sequence: u64) -> Result<(), Error> {
        self.membership()?;
        if sequence != self.image.sequence {
            return Err(Error::StaleSnapshot);
        }
        if tokens.iter().any(|t| {
            t.source != self.image.source
                || t.store_id != self.local_id
                || t.epoch != 1
                || self.leases.get(&t.partition) != Some(&t.owner)
        }) {
            return Err(Error::Fenced);
        }
        Ok(())
    }
    fn offsets(
        &self,
        override_progress: Option<&BTreeMap<u32, u64>>,
    ) -> Result<TopicPartitionList, Error> {
        let mut tpl = TopicPartitionList::new();
        for p in 0..self.image.partitions {
            let next = override_progress
                .and_then(|m| m.get(&p).map(|o| o + 1))
                .unwrap_or(0)
                .max(*self.image.cursors.get(&p).unwrap_or(&0));
            tpl.add_partition_offset(
                &self.image.source.topic,
                p as i32,
                Offset::Offset(next as i64),
            )
            .map_err(storage)?;
        }
        Ok(tpl)
    }
    fn transaction(
        &mut self,
        writes: &[(u32, Value)],
        progress: Option<&BTreeMap<u32, u64>>,
        faults: bool,
    ) -> Result<(), Error> {
        let result = (|| {
            self.membership()?;
            self.producer.begin_transaction().map_err(storage)?;
            for (p, v) in writes {
                let key = v.key();
                let payload = kafka_state::encode(&self.image.source, *p, v)?;
                self.producer
                    .send(
                        BaseRecord::to(&self.config.state_topic)
                            .partition(*p as i32)
                            .key(&key)
                            .payload(&payload),
                    )
                    .map_err(|(e, _)| storage(e))?;
            }
            let metadata = self.consumer.group_metadata().ok_or(Error::Fenced)?;
            self.producer
                .send_offsets_to_transaction(&self.offsets(progress)?, &metadata, CALL)
                .map_err(storage)?;
            #[cfg(feature = "fault-injection")]
            if faults {
                flush_producer(&self.producer, CALL).map_err(storage)?;
                crate::faults::point("kafka_before_commit");
            }
            #[cfg(not(feature = "fault-injection"))]
            let _ = faults;
            self.membership()?;
            flush_producer(&self.producer, CALL).map_err(storage)?;
            self.producer.commit_transaction(CALL).map_err(storage)?;
            #[cfg(feature = "fault-injection")]
            if faults {
                crate::faults::point("kafka_after_commit");
            }
            self.membership()?;
            Ok(())
        })();
        if result.is_err() {
            self.failed = true;
        }
        result
    }
    fn barrier(&mut self) -> Result<(), Error> {
        self.transaction(
            &[(
                0,
                Value::Barrier {
                    nonce: self.local_id.clone(),
                },
            )],
            None,
            false,
        )
    }
    fn poll(&mut self, timeout: Duration) -> Result<Option<Record>, Error> {
        self.membership()?;
        if let Some(r) = self.pending.take() {
            return Ok(Some(r));
        }
        let record = match self.consumer.poll(timeout) {
            None => None,
            Some(Err(KafkaError::PartitionEOF(p))) => {
                self.eof.insert(p as u32);
                None
            }
            Some(Err(e)) => return Err(storage(e)),
            Some(Ok(m)) => Some(
                wire::decode(
                    &self.config,
                    m.partition() as u32,
                    m.offset(),
                    m.key(),
                    m.payload(),
                )
                .map_err(Error::Invalid)?,
            ),
        };
        self.membership()?;
        Ok(record)
    }
}
impl DurableStore for KafkaStore {
    fn load(&mut self) -> Result<crate::coordination::Recovery, Error> {
        self.membership()?;
        self.image.recovery()
    }
    fn acquire(
        &mut self,
        p: u32,
        owner: &str,
    ) -> Result<(Token, crate::coordination::Recovery), Error> {
        self.membership()?;
        if p >= self.image.partitions || self.leases.contains_key(&p) {
            return Err(Error::Fenced);
        }
        self.leases.insert(p, owner.into());
        Ok((
            Token {
                source: self.image.source.clone(),
                store_id: self.local_id.clone(),
                partition: p,
                epoch: 1,
                owner: owner.into(),
            },
            self.image.recovery()?,
        ))
    }
    fn release(&mut self, t: &Token) -> Result<(), Error> {
        if t.store_id != self.local_id || self.leases.get(&t.partition) != Some(&t.owner) {
            return Err(Error::Fenced);
        }
        self.leases.remove(&t.partition);
        Ok(())
    }
    fn commit(&mut self, t: &Token, expected: u64, records: &[Record]) -> Result<Committed, Error> {
        self.check(std::slice::from_ref(t), expected)?;
        let plan = self.image.plan(t.partition, expected, records)?;
        if plan.writes.is_empty() {
            self.barrier()?;
        } else {
            self.transaction(&plan.writes, Some(&plan.committed.after.offsets), true)?;
            for (p, v) in plan.writes {
                if let Err(e) = self.image.fold(p, v) {
                    self.failed = true;
                    return Err(e);
                }
            }
        }
        Ok(plan.committed)
    }
    fn guard<T>(
        &mut self,
        tokens: &[Token],
        sequence: u64,
        action: impl FnOnce() -> Result<T, Error>,
    ) -> Result<T, Error> {
        self.check(tokens, sequence)?;
        self.barrier()?;
        action()
    }
    fn authorize<T>(
        &mut self,
        _: &Token,
        _: u64,
        _: impl FnOnce(u64) -> Result<T, Error>,
    ) -> Result<T, Error> {
        Err(Error::Invalid(
            "separate offset commit forbidden: offsets belong to canonical transaction".into(),
        ))
    }
}
fn nonce() -> Result<String, Error> {
    use std::io::Read;
    let mut b = [0; 16];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut b))
        .map_err(storage)?;
    Ok(b.iter().map(|b| format!("{b:02x}")).collect())
}
pub(crate) fn paused_poll(
    consumer: &BaseConsumer<KafkaContext>,
    membership: &Membership,
) -> Result<(), Error> {
    if let Some(Err(e)) = consumer.poll(Duration::ZERO) {
        if !matches!(
            e,
            KafkaError::PartitionEOF(_)
                | KafkaError::MessageConsumption(rdkafka::error::RDKafkaErrorCode::AutoOffsetReset)
        ) {
            return Err(storage(e));
        }
    }
    if membership.lost.load(Ordering::SeqCst) || consumer.assignment_lost() {
        return Err(Error::Fenced);
    }
    Ok(())
}
pub(crate) fn validate_topics(
    config: &Config,
    consumer: &BaseConsumer<KafkaContext>,
    source: &SourceIdentity,
    partitions: u32,
) -> Result<(), Error> {
    if config.state_topic == source.topic || config.state_topic.is_empty() {
        return Err(Error::Identity);
    }
    for topic in [&source.topic, &config.state_topic] {
        let md = consumer
            .fetch_metadata(Some(topic), CALL)
            .map_err(storage)?;
        let t = md
            .topics()
            .iter()
            .find(|t| t.name() == topic)
            .ok_or(Error::Identity)?;
        if t.error().is_some()
            || t.partitions().len() != partitions as usize
            || t.partitions()
                .iter()
                .enumerate()
                .any(|(i, p)| p.id() != i as i32 || p.error().is_some())
        {
            return Err(Error::Invalid(
                "source/state topology differs from full assignment".into(),
            ));
        }
    }
    let admin: AdminClient<DefaultClientContext> = ClientConfig::new()
        .set("bootstrap.servers", &config.brokers)
        .create()
        .map_err(storage)?;
    let spec = [ResourceSpecifier::Topic(&config.state_topic)];
    let options = AdminOptions::new().request_timeout(Some(CALL));
    let results = blocking(admin.describe_configs(&spec, &options))?.map_err(storage)?;
    let resource = results
        .into_iter()
        .next()
        .ok_or(Error::Identity)?
        .map_err(|e| storage(format!("{e:?}")))?;
    if resource
        .get("cleanup.policy")
        .and_then(|e| e.value.as_deref())
        != Some("compact")
    {
        return Err(Error::Invalid(
            "canonical cleanup.policy must be exactly compact".into(),
        ));
    }
    Ok(())
}
pub fn connect(
    config: Config,
    source: SourceIdentity,
    expected: &[u32],
) -> Result<(SharedSession<KafkaStore>, RestoreMetrics), Error> {
    let started = Instant::now();
    if expected != (0..expected.len() as u32).collect::<Vec<_>>() {
        return Err(Error::Invalid(
            "full contiguous partition vector required".into(),
        ));
    }
    let mut image = Image::empty(source.clone(), config.group.clone(), expected.len() as u32)?;
    if config.schemas.is_empty() || config.schemas.len() > 64 {
        return Err(Error::Invalid("pinned schema map bounds".into()));
    }
    for (id, m) in &config.schemas {
        let parsed = id.parse::<u32>().map_err(storage)?;
        if parsed.to_string() != *id {
            return Err(Error::Identity);
        }
        m.route().map_err(Error::Invalid)?;
    }
    let membership = Arc::new(Membership{source_topic:source.topic.clone(),..Default::default()});
    let consumer: Arc<BaseConsumer<KafkaContext>> = Arc::new(
        ClientConfig::new()
            .set("bootstrap.servers", &config.brokers)
            .set("group.id", &config.group)
            .set("enable.auto.commit", "false")
            .set("enable.auto.offset.store", "false")
            .set("isolation.level", "read_committed")
            .set("auto.offset.reset", "error")
            .set("enable.partition.eof", "true")
            .set("allow.auto.create.topics", "false")
            .set("partition.assignment.strategy", "range")
            .set("statistics.interval.ms", "100")
            .set("session.timeout.ms", "6000")
            .set("max.poll.interval.ms", "300000")
            .set("queued.max.messages.kbytes", "8192")
            .set("fetch.message.max.bytes", "2097152")
            .create_with_context(KafkaContext(membership.clone()))
            .map_err(storage)?,
    );
    validate_topics(&config, &consumer, &source, image.partitions)?;
    consumer.subscribe(&[&source.topic]).map_err(storage)?;
    loop {
        match consumer.poll(Duration::from_millis(20)) {
            Some(Err(KafkaError::MessageConsumption(
                rdkafka::error::RDKafkaErrorCode::AutoOffsetReset,
            ))) => {}
            Some(Err(KafkaError::PartitionEOF(_))) => {}
            Some(Err(e)) => return Err(storage(e)),
            _ => {}
        }
        let a = consumer.assignment().map_err(storage)?;
        if a.count() == expected.len() {
            consumer.pause(&a).map_err(storage)?;
            break;
        }
        if a.count() > 0 {
            return Err(Error::Invalid(
                "partial assignment cannot serve whole-topic view".into(),
            ));
        }
        if started.elapsed() > Duration::from_secs(30) {
            return Err(storage("full assignment deadline"));
        }
    }
    phase("assigned");
    membership.armed.store(true, Ordering::SeqCst);
    let id = nonce()?;
    let transactional_id = format!(
        "view-canonical-v1-{:x}",
        Sha256::digest(config.state_topic.as_bytes())
    );
    let producer: BaseProducer = ClientConfig::new()
        .set("bootstrap.servers", &config.brokers)
        .set("transactional.id", transactional_id)
        .set("transaction.timeout.ms", "30000")
        // Bound initial retry waiting after transient coordinator contention;
        // exponential backoff cap and transaction/call deadlines stay intact.
        .set("retry.backoff.ms", "10")
        .set("message.timeout.ms", "10000")
        .set("enable.idempotence", "true")
        .set("acks", "all")
        .create()
        .map_err(storage)?;
    producer.init_transactions(CALL).map_err(storage)?;
    phase("producer_fenced");
    paused_poll(&consumer, &membership)?;
    let mut was_empty = true;
    for p in expected {
        let (low, high) = consumer
            .fetch_watermarks(&config.state_topic, *p as i32, CALL)
            .map_err(storage)?;
        was_empty &= low == 0 && high == 0;
    }
    if was_empty && config.initialize_empty {
        let mut offsets = TopicPartitionList::new();
        for p in expected {
            offsets.add_partition(&source.topic, *p as i32);
        }
        let committed = consumer.committed_offsets(offsets, CALL).map_err(storage)?;
        if committed
            .elements()
            .iter()
            .any(|e| matches!(e.offset(), Offset::Offset(_)))
        {
            return Err(Error::Corrupt(
                "empty canonical topic with existing group progress; explicit rebuild required"
                    .into(),
            ));
        }
    }
    producer.begin_transaction().map_err(storage)?;
    if was_empty && config.initialize_empty {
        let v = image.manifest(0);
        let key = v.key();
        let payload = kafka_state::encode(&source, 0, &v)?;
        producer
            .send(
                BaseRecord::to(&config.state_topic)
                    .partition(0)
                    .key(&key)
                    .payload(&payload),
            )
            .map_err(|(e, _)| storage(e))?;
    }
    if was_empty && config.initialize_empty {
        for p in expected {
            let v = Value::Cursor { next: 0 };
            let key = v.key();
            let payload = kafka_state::encode(&source, *p, &v)?;
            producer
                .send(
                    BaseRecord::to(&config.state_topic)
                        .partition(*p as i32)
                        .key(&key)
                        .payload(&payload),
                )
                .map_err(|(e, _)| storage(e))?;
        }
    }
    for p in expected {
        let v = Value::Barrier { nonce: id.clone() };
        let key = v.key();
        let payload = kafka_state::encode(&source, *p, &v)?;
        producer
            .send(
                BaseRecord::to(&config.state_topic)
                    .partition(*p as i32)
                    .key(&key)
                    .payload(&payload),
            )
            .map_err(|(e, _)| storage(e))?;
    }
    producer.commit_transaction(CALL).map_err(storage)?;
    phase("restore_barriers_committed");
    let restore: BaseConsumer = ClientConfig::new()
        .set("bootstrap.servers", &config.brokers)
        .set("group.id", format!("restore-{id}"))
        .set("enable.auto.commit", "false")
        .set("enable.auto.offset.store", "false")
        .set("isolation.level", "read_committed")
        .set("auto.offset.reset", "error")
        .set("allow.auto.create.topics", "false")
        .set("queued.max.messages.kbytes", "8192")
        .create()
        .map_err(storage)?;
    let mut assignment = TopicPartitionList::new();
    for p in expected {
        assignment
            .add_partition_offset(&config.state_topic, *p as i32, Offset::Beginning)
            .map_err(storage)?;
    }
    restore.assign(&assignment).map_err(storage)?;
    let mut metrics = RestoreMetrics::default();
    let mut seen = BTreeSet::new();
    let mut done = BTreeSet::new();
    let replay = Instant::now();
    while done.len() < expected.len() {
        paused_poll(&consumer, &membership)?;
        if replay.elapsed() > Duration::from_secs(120) {
            return Err(storage("canonical restore deadline"));
        }
        if let Some(msg) = restore.poll(Duration::from_millis(10)) {
            let msg = msg.map_err(storage)?;
            let p = msg.partition() as u32;
            if done.contains(&p) {
                return Err(Error::Corrupt(
                    "write beyond frozen bootstrap barrier".into(),
                ));
            }
            let key = msg
                .key()
                .ok_or_else(|| Error::Corrupt("missing state key".into()))?;
            let v = kafka_state::decode(&source, p, key, msg.payload())?;
            metrics.records += 1;
            metrics.bytes += (key.len() + msg.payload().map_or(0, |b| b.len())) as u64;
            if !seen.insert((p, key.to_vec())) {
                metrics.superseded += 1;
            }
            if matches!(&v,Value::Barrier{nonce} if nonce==&id) {
                done.insert(p);
                metrics.state_barriers.insert(p, msg.offset());
            }
            image.fold(p, v)?;
        }
    }
    image.audit()?;
    phase("canonical_audited");
    #[cfg(feature = "fault-injection")]
    if !crate::faults::point("kafka_restore_audited") {
        return Err(Error::Invalid("restore interrupted".into()));
    }
    metrics.restored_next = image.cursors.clone();
    metrics.restored_sequence = image.sequence;
    metrics.restored_rows = image.rows.values().filter(|(_, r)| r.is_some()).count();
    metrics.restored_offsets = image.progress.iter().map(|(p, (o, _))| (*p, *o)).collect();
    metrics.replay_ms = replay.elapsed().as_millis();
    let store = KafkaStore {
        config,
        image,
        consumer,
        membership,
        producer,
        local_id: id.clone(),
        leases: BTreeMap::new(),
        failed: false,
        pending: None,
        eof: BTreeSet::new(),
    };
    store.membership()?;
    let shared = Arc::new(Mutex::new(Session::new(
        store,
        format!("kafka-{id}"),
        Authority::default(),
    )));
    for p in expected {
        shared.lock().map_err(storage)?.acquire(Partition {
            topic: source.topic.clone(),
            partition: *p,
        })?;
    }
    metrics.start_to_cut_ms = started.elapsed().as_millis();
    Ok((shared, metrics))
}
pub fn apply_next<E: ProductEngine>(shared:&SharedSession<KafkaStore>,coordinator:&mut DurableCoordinator<E,KafkaStore>,timeout:Duration)->Result<Option<SourceCommit>,Error>{
    apply_next_traced(shared,coordinator,timeout,None).map(|(completion,_)|completion)
}
pub fn apply_next_traced<E: ProductEngine>(
    shared: &SharedSession<KafkaStore>,
    coordinator: &mut DurableCoordinator<E, KafkaStore>,
    timeout: Duration,
    telemetry:Option<&crate::telemetry::Telemetry>,
) -> Result<(Option<SourceCommit>,Option<tracing::Span>), Error> {
    let delivery = {
        let mut s = shared.lock().map_err(storage)?;
        let record = s.store.poll(timeout)?;
        match record {
            None => None,
            Some(record) => {
                let lease = s
                    .leases()
                    .into_iter()
                    .find(|l| l.partition.partition == record.event.partition)
                    .ok_or(Error::Fenced)?;
                let mut records = vec![record];
                let mut bytes = serde_json::to_vec(&records)?.len();
                while records.len() < 256 {
                    let Some(next) = s.store.poll(Duration::ZERO)? else {
                        break;
                    };
                    let size = serde_json::to_vec(&next)?.len() + 1;
                    if next.event.partition != lease.partition.partition
                        || bytes + size > 2 * 1024 * 1024
                    {
                        s.store.pending = Some(next);
                        break;
                    }
                    bytes += size;
                    records.push(next);
                }
                Some(Delivery { lease, records })
            }
        }
    };
    match delivery {
        None => Ok((None,None)),
        Some(d) => {
            let span=telemetry.map(|t|t.span("source_apply",None));
            let start=Instant::now();let before=coordinator.metrics().records_committed;
            let applied=coordinator.apply(&d);
            if let Some(t)=telemetry{t.operation("source_apply",start.elapsed(),applied.is_ok());t.source(coordinator.metrics().records_committed-before);}
            if let Some(s)=&span{s.record("outcome",if applied.is_ok(){"ok"}else{"error"});}
            applied.map(|completion|(completion,span))
        },
    }
}
pub fn catch_up<E: ProductEngine>(
    shared: &SharedSession<KafkaStore>,
    coordinator: &mut DurableCoordinator<E, KafkaStore>,
    metrics: &mut RestoreMetrics,
) -> Result<(), Error> {
    let start = Instant::now();
    phase("source_catchup");
    {
        let mut s = shared.lock().map_err(storage)?;
        let store = &mut s.store;
        store.membership()?;
        for p in 0..store.image.partitions {
            let (low, high) = store
                .consumer
                .fetch_watermarks(&store.image.source.topic, p as i32, CALL)
                .map_err(storage)?;
            let required = store.image.cursors[&p];
            if required < low as u64 {
                return Err(Error::RetentionGap {
                    topic: store.image.source.topic.clone(),
                    partition: p,
                    required,
                    earliest: low as u64,
                    checkpoint: store.image.sequence,
                    incarnation: store.image.source.incarnation.clone(),
                });
            }
            if required > high as u64 {
                return Err(Error::SourceTruncated {
                    required,
                    high: high as u64,
                });
            }
            store
                .consumer
                .seek(
                    &store.image.source.topic,
                    p as i32,
                    Offset::Offset(required as i64),
                    CALL,
                )
                .map_err(storage)?;
            metrics.source_target.insert(p, high);
        }
        store.eof.clear();
        store.membership.ends.lock().map_err(storage)?.clear();
        store
            .consumer
            .resume(&store.consumer.assignment().map_err(storage)?)
            .map_err(storage)?;
    }
    loop {
        apply_next(shared, coordinator, Duration::from_millis(10))?;
        let reached = {
            let s = shared.lock().map_err(storage)?;
            s.store.membership()?;
            let ends = s.store.membership.ends.lock().map_err(storage)?;
            metrics.source_target.iter().all(|(p, target)| {
                let durable_next = s.store.image.cursors[p];
                let no_pending =
                    s.store.pending.as_ref().is_none_or(|r| {
                        r.event.partition != *p || r.event.offset >= *target as u64
                    });
                no_pending
                    && (durable_next >= *target as u64
                        || (s.store.eof.contains(p)
                            && ends.get(p).is_some_and(|(eof, lso, queued)| {
                                *eof >= *target && *lso >= *target && *queued == 0
                            })))
            })
        };
        if reached {
            break;
        }
        if start.elapsed() > Duration::from_secs(120) {
            return Err(storage(
                "source catch-up deadline (including unresolved transactions)",
            ));
        }
    }
    // The read_committed EOF proof may include only aborted/control records.
    // Persist that NEXT independently of the last product mutation, atomically with
    // group offsets; do not invent a ProductEngine mutation or a source batch version.
    {
        let mut s = shared.lock().map_err(storage)?;
        let mut advances = BTreeMap::new();
        let mut writes = vec![];
        for (p, target) in &metrics.source_target {
            if *target as u64 > s.store.image.cursors[p] {
                advances.insert(*p, *target as u64 - 1);
                writes.push((
                    *p,
                    Value::Cursor {
                        next: *target as u64,
                    },
                ));
            }
        }
        if !writes.is_empty() {
            s.store.transaction(&writes, Some(&advances), false)?;
            for (p, v) in writes {
                s.store.image.fold(p, v)?;
            }
        }
    }
    coordinator.admit_cut()?;
    metrics.catchup_ms = start.elapsed().as_millis();
    metrics.start_to_cut_ms += metrics.engine_rebuild_ms + metrics.catchup_ms;
    Ok(())
}

fn phase(name: &str) {
    println!(
        "{}",
        serde_json::json!({"state":"kafka_phase","phase":name})
    );
}

// Independent bounded end sampling. It shares the client's network machinery,
// but never holds the canonical mutex during a broker request. HTTP, callbacks,
// metric readers and browser observers only read the completed observation.
pub struct EndSampler {
    latest:Arc<Mutex<BTreeMap<u32,(u64,u64)>>>, stop:Arc<AtomicBool>, done:std::sync::mpsc::Receiver<()>,
}
impl EndSampler {
    pub fn start(shared:&SharedSession<KafkaStore>,health:Arc<crate::health::Health>)->Result<Self,String>{
        let store=shared.lock().map_err(|_|"owner lock")?;
        let consumer=store.store.consumer.clone();let topic=store.store.image.source.topic.clone();let count=store.store.image.partitions;drop(store);
        let latest=Arc::new(Mutex::new(BTreeMap::new()));let values=latest.clone();let stop=Arc::new(AtomicBool::new(false));let quit=stop.clone();let(tx,done)=std::sync::mpsc::sync_channel(1);
        std::thread::spawn(move||{
            while !quit.load(Ordering::Acquire){
                let at=health.now();let mut request=TopicPartitionList::new();
                for p in 0..count{let _=request.add_partition_offset(&topic,p as i32,Offset::End);}
                // Pinned librdkafka ListOffsets uses the consumer isolation.level.
                // Latest (-1) with read_committed returns LSO, not high watermark.
                if let Ok(result)=consumer.offsets_for_times(request,Duration::from_millis(750)){
                    let mut sample=BTreeMap::new();
                    for p in result.elements(){if p.error().is_ok(){if let Offset::Offset(end)=p.offset(){if end>=0{sample.insert(p.partition() as u32,(end as u64,at));}}}}
                    *values.lock().unwrap()=sample;
                }
                let remaining=health.config.sample_ms.saturating_sub(health.now().saturating_sub(at));
                for _ in 0..remaining.div_ceil(25){if quit.load(Ordering::Acquire){break;}std::thread::sleep(Duration::from_millis(25));}
            }let _=tx.send(());
        });Ok(Self{latest,stop,done})
    }
}
impl Drop for EndSampler{fn drop(&mut self){self.stop.store(true,Ordering::Release);let _=self.done.recv_timeout(Duration::from_millis(1500));}}
pub fn health_partitions(shared:&SharedSession<KafkaStore>,sampler:&EndSampler,now:u64)->Result<Vec<crate::health::PartitionHealth>,String>{
    let s=shared.lock().map_err(|_|"owner lock")?;let store=&s.store;
    // These are cached client state checks, not new authority transactions.
    let assigned=store.membership().is_ok();
    let position=store.consumer.position().ok();
    let ends=sampler.latest.lock().map_err(|_|"end sample lock")?;
    let queues=store.membership.ends.lock().map_err(|_|"statistics lock")?;
    let stats=store.membership.diagnostics.lock().map_err(|_|"statistics lock")?;
    let mut result=Vec::new();
    for p in 0..store.image.partitions{
        let mut d=crate::health::PartitionHealth::unknown(p);let durable=store.image.cursors[&p];
        d.assigned=assigned;d.bootstrap_complete=true;d.durable_next=Some(durable.to_string());d.derived_next=Some(durable.to_string());
        let passed=position.as_ref().and_then(|positions|positions.find_partition(&store.image.source.topic,p as i32)).and_then(|v|if let Offset::Offset(n)=v.offset(){u64::try_from(n).ok()}else{None});
        // All returned user records are now durably applied and derived except
        // the one bounded lookahead record. Never count that record as applied.
        let pending=store.pending.as_ref().filter(|r|r.event.partition==p).map(|r|r.event.offset);
        let serving=passed.unwrap_or(durable).min(pending.unwrap_or(u64::MAX)).max(durable);
        d.serving_next=Some(serving.to_string());
        if let Some((end,at))=ends.get(&p){d.readable_end=Some(end.to_string());d.readable_sample_ms=Some(*at);}
        if let Some((next,high,bytes,at))=stats.get(&p){if at.elapsed()<Duration::from_secs(3){d.fetched_next=u64::try_from(*next).ok().map(|v|v.to_string());d.high_watermark=u64::try_from(*high).ok().map(|v|v.to_string());d.fetch_queue_bytes=u64::try_from(*bytes).ok();d.fetch_queue_messages=queues.get(&p).and_then(|(_,_,n)|u64::try_from(*n).ok());d.transaction_blocked=ends.get(&p).filter(|(_,at)|now.saturating_sub(*at)<=3000).and_then(|(end,_)|u64::try_from(*high).ok().map(|high|high>*end));}}
        result.push(d);
    }Ok(result)
}

#[cfg(test)]mod health_stats_tests{
 use super::*;
 #[test]fn canonical_metadata_never_overwrites_source_partition_statistics(){
  let membership=Arc::new(Membership{source_topic:"source".into(),..Default::default()});let context=KafkaContext(membership.clone());
  let mut stats=rdkafka::statistics::Statistics::default();
  for (name,next,high) in [("source",40,43),("canonical",0,-1)]{let mut topic=rdkafka::statistics::Topic{topic:name.into(),..Default::default()};topic.partitions.insert(0,rdkafka::statistics::Partition{next_offset:next,hi_offset:high,ls_offset:42,eof_offset:42,..Default::default()});stats.topics.insert(name.into(),topic);}
  context.stats(stats);assert_eq!(membership.diagnostics.lock().unwrap()[&0].0,40);assert_eq!(membership.diagnostics.lock().unwrap()[&0].1,43);assert_eq!(membership.ends.lock().unwrap()[&0].1,42);
 }
}
