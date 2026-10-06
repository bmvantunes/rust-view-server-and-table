//! Kafka-specific types stop here. A single caller polls, drains and checkpoints.
use crate::{
    coordination::{
        Authority, BoundedQueue, Coordinator, Delivery, Lease, Limits, Metrics, Partition,
    },
    durable::{Error as DurableError, SqliteStore, recovery_next},
    durable_coordinator::{DurableCoordinator, SharedSession},
    registry::Registry,
    wire,
};
use rdkafka::{
    ClientConfig, ClientContext, Offset, TopicPartitionList,
    consumer::{BaseConsumer, CommitMode, Consumer, ConsumerContext, RebalanceProtocol},
    message::Message,
};
use rust_differential_product_core::engine_contract::ProductEngine;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

#[derive(Clone)]
struct Context {
    authority: Authority,
    starts: Arc<Mutex<BTreeMap<Partition, u64>>>,
    error: Arc<Mutex<Option<String>>>,
    durable: Option<SharedSession<SqliteStore>>,
    recovery_error: Arc<Mutex<Option<DurableError>>>,
    recovering: Arc<Mutex<BTreeMap<Partition, (Lease, u64)>>>,
    queued_records: Arc<Mutex<u64>>,
}
impl Context {
    fn fail(&self, message: &str) {
        *self.error.lock().expect("callback error") = Some(message.into());
        self.authority.shutdown();
    }
}
impl ClientContext for Context {
    fn stats(&self, statistics: rdkafka::statistics::Statistics) {
        *self.queued_records.lock().expect("statistics") = statistics
            .topics
            .values()
            .flat_map(|t| t.partitions.values())
            .map(|p| p.fetchq_cnt.max(0) as u64)
            .sum();
    }
    // Credentials and broker error strings are deliberately not logged by this adapter.
    fn log(&self, _: rdkafka::config::RDKafkaLogLevel, _: &str, _: &str) {}
}
impl ConsumerContext for Context {
    fn rebalance(
        &self,
        consumer: &BaseConsumer<Self>,
        error: rdkafka::types::RDKafkaRespErr,
        list: &mut TopicPartitionList,
    ) {
        use rdkafka::types::RDKafkaRespErr::*;
        let cooperative = matches!(
            consumer.rebalance_protocol(),
            RebalanceProtocol::Cooperative
        );
        let partitions: Vec<_> = list
            .elements()
            .iter()
            .map(|p| (p.topic().to_owned(), p.partition()))
            .collect();
        match error {
            RD_KAFKA_RESP_ERR__ASSIGN_PARTITIONS => {
                for (topic, p) in &partitions {
                    if *p < 0 {
                        self.fail("negative partition assignment");
                        return;
                    }
                    let partition = Partition {
                        topic: topic.clone(),
                        partition: *p as u32,
                    };
                    let next = if let Some(shared) = &self.durable {
                        let recovered = (|| -> Result<u64, DurableError> {
                            let mut session = shared
                                .lock()
                                .map_err(|_| DurableError::Storage("session poisoned".into()))?;
                            let (lease, recovery) = session.acquire(partition.clone())?;
                            let (low, high) = consumer
                                .fetch_watermarks(topic, *p, Duration::from_secs(5))
                                .map_err(|_| {
                                    DurableError::Storage(
                                        "Kafka recovery watermarks unavailable".into(),
                                    )
                                })?;
                            if low < 0 || high < 0 {
                                return Err(DurableError::Invalid(
                                    "negative Kafka watermarks".into(),
                                ));
                            }
                            let next = recovery_next(
                                session.store.source(),
                                &recovery,
                                *p as u32,
                                low as u64,
                                high as u64,
                            )?;
                            self.recovering
                                .lock()
                                .expect("recovering")
                                .insert(partition.clone(), (lease, next));
                            Ok(next)
                        })();
                        match recovered {
                            Ok(next) => Some(next),
                            Err(e) => {
                                *self.recovery_error.lock().expect("recovery error") =
                                    Some(e.clone());
                                self.fail(&e.to_string());
                                return;
                            }
                        }
                    } else {
                        self.starts.lock().expect("starts").get(&partition).copied()
                    };
                    let offset = next
                        .map(|v| Offset::Offset(v as i64))
                        .unwrap_or(Offset::Beginning);
                    if list.set_partition_offset(topic, *p, offset).is_err() {
                        self.fail("assignment recovery position failed");
                        return;
                    }
                }
                let result = if cooperative {
                    consumer.incremental_assign(list)
                } else {
                    consumer.assign(list)
                };
                if result.is_err() {
                    self.fail("Kafka assignment failed");
                    return;
                }
                if self.durable.is_some() && consumer.pause(list).is_err() {
                    self.fail("pause during durable reconstruction failed");
                    return;
                }
                for (topic, p) in partitions {
                    if self.durable.is_some() {
                        continue;
                    }
                    if self
                        .authority
                        .assign(Partition {
                            topic,
                            partition: p as u32,
                        })
                        .is_err()
                    {
                        self.fail("assignment ownership failed");
                        return;
                    }
                }
            }
            RD_KAFKA_RESP_ERR__REVOKE_PARTITIONS => {
                for (topic, p) in partitions {
                    let partition = Partition {
                        topic,
                        partition: p as u32,
                    };
                    self.recovering
                        .lock()
                        .expect("recovering")
                        .remove(&partition);
                    if let Some(shared) = &self.durable {
                        let result = shared.lock().expect("session").release(&partition);
                        if let Err(e) = result {
                            self.fail(&e.to_string());
                        }
                    } else {
                        self.authority.revoke(&partition);
                    }
                }
                let result = if cooperative {
                    consumer.incremental_unassign(list)
                } else {
                    consumer.unassign()
                };
                if result.is_err() {
                    self.fail("Kafka unassignment failed");
                }
            }
            _ => {
                self.fail("consumer rebalance failed");
                let _ = consumer.unassign();
            }
        }
    }
}
/// Secret options are configuration only. No Debug implementation prints them.
pub struct Config {
    pub brokers: String,
    pub group: String,
    pub topics: Vec<String>,
    pub options: BTreeMap<String, String>,
    pub limits: Limits,
}
pub struct KafkaSource<R: Registry> {
    consumer: BaseConsumer<Context>,
    registry: R,
    context: Context,
    queue: BoundedQueue,
    pending: Option<Delivery>,
    paused: Vec<Lease>,
    stopped: bool,
    paused_since: Option<Instant>,
    clock_origin: Instant,
}
impl<R: Registry> KafkaSource<R> {
    pub fn connect(
        config: Config,
        registry: R,
        authority: Authority,
        starts: BTreeMap<Partition, u64>,
    ) -> Result<Self, String> {
        Self::connect_mode(config, registry, authority, starts, None)
    }
    pub fn connect_durable(
        config: Config,
        registry: R,
        session: SharedSession<SqliteStore>,
    ) -> Result<Self, String> {
        let guard = session.lock().map_err(|_| "session poisoned")?;
        if config.topics != vec![guard.store.source().topic.clone()] {
            return Err("one durable source/topic required".into());
        }
        let authority = guard.authority.clone();
        drop(guard);
        Self::connect_mode(config, registry, authority, BTreeMap::new(), Some(session))
    }
    fn connect_mode(
        config: Config,
        registry: R,
        authority: Authority,
        starts: BTreeMap<Partition, u64>,
        durable: Option<SharedSession<SqliteStore>>,
    ) -> Result<Self, String> {
        if config.topics.is_empty()
            || config.topics.len() > 64
            || config.group.is_empty()
            || starts.values().any(|v| *v > i64::MAX as u64)
        {
            return Err("invalid source configuration".into());
        }
        let queue = BoundedQueue::new(config.limits)?;
        let context = Context {
            authority,
            starts: Arc::new(Mutex::new(starts)),
            error: Arc::new(Mutex::new(None)),
            durable,
            recovery_error: Arc::new(Mutex::new(None)),
            recovering: Arc::new(Mutex::new(BTreeMap::new())),
            queued_records: Arc::new(Mutex::new(0)),
        };
        let mut client = ClientConfig::new();
        // Only deployment/security options may be supplied; invariants below are not overrideable.
        for (key, value) in config.options {
            if !matches!(
                key.as_str(),
                "security.protocol"
                    | "sasl.mechanism"
                    | "sasl.username"
                    | "sasl.password"
                    | "ssl.ca.location"
                    | "ssl.certificate.location"
                    | "ssl.key.location"
                    | "ssl.key.password"
                    | "group.instance.id"
            ) {
                return Err(format!("unsupported Kafka option {key}"));
            }
            client.set(key, value);
        }
        client
            .set("bootstrap.servers", config.brokers)
            .set("group.id", config.group)
            .set("statistics.interval.ms", "100")
            .set("enable.auto.commit", "false")
            .set("enable.auto.offset.store", "false")
            .set("auto.offset.reset", "error")
            .set("isolation.level", "read_committed")
            .set("partition.assignment.strategy", "cooperative-sticky")
            .set("queued.max.messages.kbytes", "8192")
            .set("queued.min.messages", "1")
            .set("fetch.message.max.bytes", "2097152")
            .set("fetch.max.bytes", "4194304")
            .set("receive.message.max.bytes", "4194816")
            .set("max.poll.interval.ms", "300000")
            .set("session.timeout.ms", "10000")
            .set("heartbeat.interval.ms", "3000");
        let consumer: BaseConsumer<Context> = client
            .create_with_context(context.clone())
            .map_err(|_| "Kafka client configuration failed")?;
        consumer
            .subscribe(&config.topics.iter().map(String::as_str).collect::<Vec<_>>())
            .map_err(|_| "Kafka subscription failed")?;
        Ok(Self {
            consumer,
            registry,
            context,
            queue,
            pending: None,
            paused: Vec::new(),
            stopped: false,
            paused_since: None,
            clock_origin: Instant::now(),
        })
    }
    /// Call before first poll. cap=1 is the compatibility default.
    pub fn set_batch_limits(&mut self, limits: crate::coordination::BatchLimits) -> Result<(), String> {
        if self.pending.is_some() { return Err("configure before polling".into()); }
        self.queue.set_batch_limits(limits)
    }
    fn now_ms(&self) -> u64 { self.clock_origin.elapsed().as_millis().try_into().unwrap_or(u64::MAX) }
    fn partition_list(leases: &[Lease]) -> TopicPartitionList {
        let mut list = TopicPartitionList::new();
        for l in leases {
            list.add_partition(&l.partition.topic, l.partition.partition as i32);
        }
        list
    }
    fn pressure(&mut self) -> Result<(), String> {
        self.queue.flush_due(self.now_ms());
        let want = if self.pending.is_some() || self.queue.full() {
            self.context.authority.leases()
        } else {
            self.context
                .recovering
                .lock()
                .expect("recovering")
                .values()
                .map(|(lease, _)| lease.clone())
                .collect()
        };
        let resume: Vec<_> = self
            .paused
            .iter()
            .filter(|l| !want.contains(l) && self.context.authority.valid(l))
            .cloned()
            .collect();
        if !resume.is_empty() {
            self.consumer
                .resume(&Self::partition_list(&resume))
                .map_err(|_| "Kafka resume failed")?;
            self.queue.metrics.resume_count += 1;
        }
        let pause: Vec<_> = want
            .iter()
            .filter(|l| !self.paused.contains(l))
            .cloned()
            .collect();
        if !pause.is_empty() {
            self.consumer
                .pause(&Self::partition_list(&pause))
                .map_err(|_| "Kafka pause failed")?;
        }
        self.queue.metrics.spill_bytes = self
            .pending
            .as_ref()
            .map(|d| d.bytes())
            .transpose()?
            .unwrap_or(0);
        self.queue.metrics.buffered_bytes = self.queue.metrics.queued_bytes.checked_add(self.queue.metrics.spill_bytes).ok_or("buffer accounting overflow")?;
        self.queue.metrics.max_buffered_bytes = self.queue.metrics.max_buffered_bytes.max(self.queue.metrics.buffered_bytes);
        // building_bytes is already INCLUDED in queued_bytes, never an unaccounted buffer.
        if want.is_empty() {
            if let Some(start) = self.paused_since.take() {
                self.queue.metrics.paused_duration_ns += start.elapsed().as_nanos() as u64;
            }
        } else if self.paused_since.is_none() {
            self.paused_since = Some(Instant::now());
        }
        self.queue.metrics.kafka_queued_records =
            *self.context.queued_records.lock().expect("statistics");
        self.paused = want;
        self.queue.metrics.paused_partitions = self.paused.len();
        Ok(())
    }
    /// Call at least once per max.poll.interval, including while downstream is blocked.
    /// Poll timeout is capped by the building batch deadline; apply only exposes sealed batches.
    pub fn poll(&mut self, timeout: Duration) -> Result<(), String> {
        if self.context.durable.is_some() {
            return Err("durable source requires poll_durable".into());
        }
        self.poll_shared(timeout)
    }
    /// Reconstruct the evaluator, seek the durable next position, then release assignment pause.
    pub fn poll_durable<E: ProductEngine>(
        &mut self,
        coordinator: &mut DurableCoordinator<E, SqliteStore>,
        timeout: Duration,
    ) -> Result<(), String> {
        let result = (|| {
            self.poll_shared(timeout)?;
            self.prepare_durable(coordinator)
        })();
        if result.is_err() {
            self.shutdown();
        }
        result
    }
    fn prepare_durable<E: ProductEngine>(
        &mut self,
        coordinator: &mut DurableCoordinator<E, SqliteStore>,
    ) -> Result<(), String> {
        let shared = self
            .context
            .durable
            .as_ref()
            .ok_or("source has no durable session")?;
        if !coordinator.same_session(shared) {
            return Err("coordinator/session mismatch".into());
        }
        coordinator
            .recover_assignments()
            .map_err(|e| e.to_string())?;
        let starts = self.context.recovering.lock().expect("recovering").clone();
        for (partition, (lease, next)) in starts {
            if !self.context.authority.valid(&lease) {
                return Err("recovery lease revoked".into());
            }
            self.consumer
                .seek(
                    &partition.topic,
                    partition.partition as i32,
                    Offset::Offset(next as i64),
                    Duration::from_secs(5),
                )
                .map_err(|_| "durable recovery seek failed")?;
            self.context
                .recovering
                .lock()
                .expect("recovering")
                .remove(&partition);
        }
        self.pressure()
    }
    fn poll_shared(&mut self, timeout: Duration) -> Result<(), String> {
        if self.stopped {
            return Err("source stopped".into());
        }
        let result = self.poll_inner(timeout.min(Duration::from_millis(100)));
        if result.is_err() {
            self.shutdown();
        }
        result
    }
    fn poll_inner(&mut self, timeout: Duration) -> Result<(), String> {
        self.queue.discard_stale(&self.context.authority);
        self.queue.flush_due(self.now_ms());
        if self
            .pending
            .as_ref()
            .is_some_and(|d| !self.context.authority.valid(&d.lease))
        {
            self.pending = None;
        }
        if let Some(d) = self.pending.take()
            && self.queue.push_record(d.clone(), self.now_ms()).is_err()
        {
            if self.queue.metrics.queue_depth == 0 {
                return Err("record cannot fit configured queue quotas".into());
            }
            self.pending = Some(d);
        }
        self.pressure()?;
        let timeout = self.queue.wait_ms(self.now_ms()).map_or(timeout, |ms| timeout.min(Duration::from_millis(ms)));
        if let Some(message) = self.consumer.poll(timeout) {
            let message = message.map_err(|_| "Kafka fetch failed; source stopped for replay")?;
            let partition = Partition {
                topic: message.topic().into(),
                partition: message
                    .partition()
                    .try_into()
                    .map_err(|_| "negative partition")?,
            };
            let lease = self
                .context
                .authority
                .lease(&partition)
                .ok_or("message has no active owner")?;
            if self
                .context
                .recovering
                .lock()
                .expect("recovering")
                .contains_key(&partition)
            {
                // Assignment is paused pending engine reconstruction. Explicit seek in
                // prepare_durable replays this racing fetched record; it is not decoded/applied.
            } else if self.pending.is_some() {
                // A message already in librdkafka's event queue raced pause. Rewind it,
                // retaining the earlier pending delivery; never drop oldest buffered work.
                self.consumer
                    .seek(
                        message.topic(),
                        message.partition(),
                        Offset::Offset(message.offset()),
                        Duration::from_secs(5),
                    )
                    .map_err(|_| "backpressure rewind failed")?;
            } else {
                let record = wire::decode(
                    &self.registry,
                    partition.partition,
                    message.offset(),
                    message.key(),
                    message.payload(),
                )?;
                let d = Delivery {
                    lease,
                    records: vec![record],
                };
                if d.bytes()? > 2 * 1024 * 1024 {
                    return Err("decoded record exceeds spill quota".into());
                }
                if self.queue.push_record(d.clone(), self.now_ms()).is_err() {
                    if self.queue.metrics.queue_depth == 0 {
                        return Err("record cannot fit configured queue quotas".into());
                    }
                    self.pending = Some(d);
                }
            }
        }
        if let Some(error) = self
            .context
            .error
            .lock()
            .map_err(|_| "callback error poisoned")?
            .clone()
        {
            return Err(error);
        }
        self.pressure()
    }
    /// Drains only after successful completed engine application. Error keeps the front.
    pub fn apply_next<E: ProductEngine>(
        &mut self,
        coordinator: &mut Coordinator<E>,
    ) -> Result<bool, String> {
        if self.context.durable.is_some() {
            return Err("durable source requires apply_next_durable".into());
        }
        self.queue.discard_stale(&self.context.authority);
        let now = self.now_ms();
        let Some(d) = self.queue.ready(now) else {
            return Ok(false);
        };
        if let Err(error) = coordinator.apply(d) {
            self.shutdown();
            return Err(error);
        }
        let p = d.lease.partition.clone();
        if let Some(next) = coordinator.applied_next(p.partition) {
            self.context.starts.lock().expect("starts").insert(p, next);
        }
        self.queue.record_completed();
        self.queue.pop();
        self.pressure()?;
        Ok(true)
    }
    pub fn apply_next_durable<E: ProductEngine>(&mut self, coordinator: &mut DurableCoordinator<E, SqliteStore>) -> Result<bool,String> {
        self.apply_next_durable_completion(coordinator).map(|(applied,_)|applied)
    }
    pub fn apply_next_durable_completion<E: ProductEngine>(
        &mut self,
        coordinator: &mut DurableCoordinator<E, SqliteStore>,
    ) -> Result<(bool, Option<rust_differential_product_core::source::SourceCommit>), String> {
        let shared = self
            .context
            .durable
            .as_ref()
            .ok_or("source has no durable session")?;
        if !coordinator.same_session(shared) {
            return Err("coordinator/session mismatch".into());
        }
        if let Err(e) = self.prepare_durable(coordinator) {
            self.shutdown();
            return Err(e);
        }
        self.queue.discard_stale(&self.context.authority);
        let now = self.now_ms();
        let Some(d) = self.queue.ready(now) else {
            return Ok((false,None));
        };
        let completion = match coordinator.apply(d) { Ok(c)=>c, Err(e)=>{self.shutdown();return Err(e.to_string());} };
        self.queue.record_completed();
        self.queue.pop();
        self.pressure()?;
        Ok((true,completion))
    }
    pub fn commit_checkpoint<E: ProductEngine>(
        &self,
        coordinator: &mut DurableCoordinator<E, SqliteStore>,
        lease: &Lease,
    ) -> Result<(), String> {
        let shared = self
            .context
            .durable
            .as_ref()
            .ok_or("source has no durable session")?;
        if !coordinator.same_session(shared) {
            return Err("coordinator/session mismatch".into());
        }
        coordinator
            .commit_offset(lease, |next| {
                let mut offsets = TopicPartitionList::new();
                offsets
                    .add_partition_offset(
                        &lease.partition.topic,
                        lease.partition.partition as i32,
                        Offset::Offset(next as i64),
                    )
                    .map_err(|_| DurableError::Invalid("commit coordinate".into()))?;
                self.consumer
                    .commit(&offsets, CommitMode::Sync)
                    .map_err(|_| DurableError::Storage("Kafka commit failed".into()))
            })
            .map_err(|e| e.to_string())
    }
    /// Typed assignment failure, preserved even after terminal shutdown.
    pub fn recovery_failure(&self) -> Option<DurableError> {
        self.context.recovery_error.lock().ok()?.clone()
    }
    pub fn next_topic(&self) -> Option<&str> {
        self.queue.front().map(|d| d.lease.partition.topic.as_str())
    }
    pub fn metrics(&self) -> &Metrics {
        &self.queue.metrics
    }
    /// Only a durable coordinator checkpoint authorizes committing NEXT offsets.
    pub fn commit_durable<E: ProductEngine>(
        &self,
        coordinator: &Coordinator<E>,
        lease: &Lease,
    ) -> Result<(), String> {
        if self.context.durable.is_some() {
            return Err("durable source requires commit_checkpoint".into());
        }
        let next = coordinator
            .committable_next(lease)?
            .ok_or("no durable checkpoint: Kafka commit forbidden")?;
        self.context
            .authority
            .fenced(std::slice::from_ref(lease), || {
                let mut offsets = TopicPartitionList::new();
                offsets
                    .add_partition_offset(
                        &lease.partition.topic,
                        lease.partition.partition as i32,
                        Offset::Offset(next.try_into().map_err(|_| "offset overflow")?),
                    )
                    .map_err(|_| "invalid commit coordinate")?;
                self.consumer
                    .commit(&offsets, CommitMode::Sync)
                    .map_err(|_| "Kafka durable commit failed".into())
            })
    }
    pub fn shutdown(&mut self) {
        if self.stopped {
            return;
        }
        self.stopped = true;
        if let Some(shared) = &self.context.durable {
            let mut session = shared.lock().expect("session");
            for lease in session.leases() {
                let _ = session.release(&lease.partition);
            }
        }
        self.context.authority.shutdown();
        self.consumer.unsubscribe();
        while self.queue.pop().is_some() {}
        self.pending = None;
        self.context.recovering.lock().expect("recovering").clear();
        self.queue.metrics.spill_bytes = 0;
        self.queue.metrics.buffered_bytes = 0;
        self.paused.clear();
        self.queue.metrics.paused_partitions = 0;
    }
}
impl<R: Registry> Drop for KafkaSource<R> {
    fn drop(&mut self) {
        self.shutdown();
    }
}
