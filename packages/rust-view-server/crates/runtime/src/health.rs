//! Cached, bounded operational observations. Never a serving authority token.
use serde::{Deserialize, Serialize};
use std::{sync::{Arc, Mutex, atomic::{AtomicBool, AtomicU64, Ordering}}, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};

pub const MAX_PARTITIONS: usize = 32;
pub const MAX_SNAPSHOT_BYTES: usize = 65536;
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReadinessPolicy {
    /// Offset distance, NOT user-message count or a time-lag guarantee.
    pub enter_offset_distance: u64,
    pub exit_offset_distance: u64,
    pub max_sample_age_ms: u64,
    pub enter_hold_ms: u64,
    pub exit_hold_ms: u64,
}
impl ReadinessPolicy {
    pub fn validate(&self) -> Result<(), String> {
        if self.enter_offset_distance == 0 || self.exit_offset_distance < self.enter_offset_distance ||
            self.exit_offset_distance > 1_000_000 || !(1000..=60000).contains(&self.max_sample_age_ms) ||
            self.enter_hold_ms > 30000 || self.exit_hold_ms > 30000 {
            return Err("invalid explicit readiness policy".into());
        } Ok(())
    }
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub bind: std::net::SocketAddr,
    pub readiness: ReadinessPolicy,
    #[serde(default="heartbeat_ms")] pub heartbeat_ms: u64,
    #[serde(default="dependencies_ms")] pub dependencies_ms: u64,
    #[serde(default="change_ms")] pub change_ms: u64,
    #[serde(default="sample_ms")] pub sample_ms: u64,
    #[serde(default="owner_stall_ms")] pub owner_stall_ms: u64,
    #[serde(default="startup_stall_ms")] pub startup_stall_ms: u64,
    #[serde(default)] pub stdout: bool,
    #[serde(default)] pub telemetry: crate::telemetry::Config,
}
fn heartbeat_ms()->u64{5000} fn dependencies_ms()->u64{30000} fn change_ms()->u64{300}
fn sample_ms()->u64{1000} fn owner_stall_ms()->u64{600000} fn startup_stall_ms()->u64{600000}
impl Config {
    pub fn validate(&self)->Result<(),String>{
        self.readiness.validate()?;
        if !(100..=60000).contains(&self.heartbeat_ms) || !(100..=120000).contains(&self.dependencies_ms) ||
            !(10..=5000).contains(&self.change_ms) || !(500..=5000).contains(&self.sample_ms) ||
            self.readiness.max_sample_age_ms < self.sample_ms*2 || !(30000..=600000).contains(&self.owner_stall_ms) ||
            !(120000..=3600000).contains(&self.startup_stall_ms) {return Err("invalid health cadence or owner tolerance".into());}
        self.telemetry.validate()
    }
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all="snake_case")]
pub enum Phase { Starting, Restoring, CatchingUp, Serving, Stopping, Failed }
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Dependency {
    pub id: String, pub resource_id: String, pub role: String,
    pub state: String, pub reason: Option<String>, pub attribution: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct PartitionHealth {
    pub partition: u32,
    pub assigned: bool,
    pub bootstrap_complete: bool,
    pub fetched_next: Option<String>,
    pub durable_next: Option<String>,
    pub derived_next: Option<String>,
    /// Includes proven read_committed gaps, never unapplied user records.
    pub serving_next: Option<String>,
    pub readable_end: Option<String>,
    pub readable_sample_ms: Option<u64>,
    pub high_watermark: Option<String>,
    pub fetch_queue_messages: Option<u64>,
    pub fetch_queue_bytes: Option<u64>,
    pub transaction_blocked: Option<bool>,
}
impl PartitionHealth {
    pub fn unknown(partition:u32)->Self{Self{partition,assigned:false,bootstrap_complete:false,fetched_next:None,durable_next:None,derived_next:None,serving_next:None,readable_end:None,readable_sample_ms:None,high_watermark:None,fetch_queue_messages:None,fetch_queue_bytes:None,transaction_blocked:None}}
    pub fn lag(&self)->Option<u64>{Some(self.readable_end.as_ref()?.parse::<u64>().ok()?.saturating_sub(self.serving_next.as_ref()?.parse::<u64>().ok()?))}
}
#[derive(Clone, Debug, Serialize)]
pub struct SourceHealth {
    pub topic: String, pub configured_topic: Option<String>, pub source_id: String, pub dependencies: Vec<String>,
    pub policy: ReadinessPolicy, pub partitions: Vec<PartitionHealth>, pub retention: RetentionServingHealth,
}
#[derive(Clone, Debug, Serialize)]
pub struct RetentionServingHealth {
    pub enabled:bool,pub safe:bool,pub pending_due:bool,pub active_payload_rows:u64,pub sticky_keys:u64,pub scheduled_expiries:u64,
    pub canonical_version:u64,pub derived_version:u64,pub maintenance_sequence:u64,pub overdue_ms:Option<u64>,
    pub next_expiry_unix_ms:Option<u64>,pub last_commit_unix_ms:Option<u64>,pub last_expiry_delay_ms:Option<u64>,
}
impl RetentionServingHealth {
    pub fn disabled()->Self{Self::new(false)}
    pub fn new(enabled:bool)->Self{Self{enabled,safe:!enabled,pending_due:false,active_payload_rows:0,sticky_keys:0,scheduled_expiries:0,canonical_version:0,derived_version:0,maintenance_sequence:0,overdue_ms:None,next_expiry_unix_ms:None,last_commit_unix_ms:None,last_expiry_delay_ms:None}}
}
#[derive(Clone, Debug, Serialize)]
pub struct Snapshot {
    pub version: u8, pub instance: String, pub sequence: u64, pub sampled_at_unix_ms: u64,
    pub observed_at_ms: u64, pub phase: Phase, pub startup_complete: bool,
    pub ready: bool, pub live: bool, pub reason: String,
    pub authority_safe: bool, pub sources: Vec<SourceHealth>, pub dependencies: Vec<Dependency>,
    pub owner_progress_ms: u64, pub owner_stall_ms: u64,
    pub records_committed: u64, pub maintenance_transactions:u64, pub maintenance_rows_evicted:u64, pub maintenance_ns:String,
    pub live_rows: u64, pub subscriptions: u64, pub connections: u64,
    pub output_queue_frames: u64, pub output_queue_bytes: u64,
    pub backpressured_connections:u64, pub durable_transactions:u64, pub durable_ns:String, pub derived_ns:String,
    pub source_failures: u64, pub callback_failures: u64,
}
#[derive(Default)]
pub struct ReadinessLatch { ready:bool, good_since:Option<u64>, bad_since:Option<u64> }
impl ReadinessLatch {
    pub fn evaluate(&mut self,s:&Snapshot,now:u64)->(bool,String){
        let unsafe_reason=if !s.authority_safe {Some("authority_unavailable")} else if matches!(s.phase,Phase::Stopping|Phase::Failed) {Some("not_serving")} else if !s.startup_complete {Some("bootstrap_pending")} else {None};
        let mut lagging=false;
        let mut immediate=unsafe_reason;
        if s.sources.is_empty(){immediate=Some("source_unavailable");}
        for source in &s.sources {
            if source.retention.enabled && (!source.retention.safe || source.retention.pending_due) {immediate=Some("retention_maintenance_pending");}
            if source.partitions.is_empty(){immediate=Some("partition_unavailable");}
            for p in &source.partitions {
                if !p.assigned || !p.bootstrap_complete {immediate=Some("partition_bootstrap_pending");continue;}
                if p.readable_sample_ms.is_none_or(|at|now.saturating_sub(at)>source.policy.max_sample_age_ms) || p.lag().is_none(){immediate=Some("progress_unavailable_or_stale");continue;}
                if p.durable_next.is_none() || p.derived_next != p.durable_next {immediate=Some("derived_not_applied");continue;}
                let threshold=if self.ready{source.policy.exit_offset_distance}else{source.policy.enter_offset_distance};
                lagging |= p.lag().unwrap()>threshold;
            }
        }
        if let Some(reason)=immediate{self.ready=false;self.good_since=None;self.bad_since=None;return(false,reason.into());}
        if lagging {
            self.good_since=None;let since=*self.bad_since.get_or_insert(now);
            let hold=s.sources.iter().map(|s|s.policy.exit_hold_ms).min().unwrap_or(0);
            if now.saturating_sub(since)>=hold{self.ready=false;}
            (self.ready,"catchup_tolerance_exceeded".into())
        }else{
            self.bad_since=None;let since=*self.good_since.get_or_insert(now);
            let hold=s.sources.iter().map(|s|s.policy.enter_hold_ms).max().unwrap_or(0);
            if now.saturating_sub(since)>=hold{self.ready=true;}
            (self.ready,if self.ready{"ready"}else{"catchup_hold"}.into())
        }
    }
}
struct State { snapshot:Snapshot, latch:ReadinessLatch }
pub struct Health {
    pub config: Config, started:Instant, state:Mutex<State>,
    progress:AtomicU64, sequence:AtomicU64, stopping:AtomicBool, failures:AtomicU64,
}
impl Health {
    pub fn new(config:Config,instance:String,topic:String,source_id:String,partitions:&[u32],dependencies:Vec<Dependency>)->Result<Arc<Self>,String>{
        config.validate()?;
        if partitions.is_empty()||partitions.len()>MAX_PARTITIONS||topic.len()>128||source_id.len()>128||instance.len()>128||dependencies.len()>4{return Err("health identity/cardinality bound".into());}
        let sources=vec![SourceHealth{topic,configured_topic:None,source_id,dependencies:dependencies.iter().map(|d|d.id.clone()).collect(),policy:config.readiness.clone(),partitions:partitions.iter().map(|p|PartitionHealth::unknown(*p)).collect(),retention:RetentionServingHealth::disabled()}];
        let snapshot=Snapshot{version:1,instance,sequence:0,sampled_at_unix_ms:wall_ms(),observed_at_ms:0,phase:Phase::Starting,startup_complete:false,ready:false,live:true,reason:"bootstrap_pending".into(),authority_safe:false,sources,dependencies,owner_progress_ms:0,owner_stall_ms:config.startup_stall_ms,records_committed:0,maintenance_transactions:0,maintenance_rows_evicted:0,maintenance_ns:"0".into(),live_rows:0,subscriptions:0,connections:0,output_queue_frames:0,output_queue_bytes:0,backpressured_connections:0,durable_transactions:0,durable_ns:"0".into(),derived_ns:"0".into(),source_failures:0,callback_failures:0};
        Ok(Arc::new(Self{config,started:Instant::now(),state:Mutex::new(State{snapshot,latch:ReadinessLatch::default()}),progress:AtomicU64::new(0),sequence:AtomicU64::new(0),stopping:AtomicBool::new(false),failures:AtomicU64::new(0)}))
    }
    pub fn sequence(&self)->u64{self.sequence.load(Ordering::Acquire)}
    pub fn now(&self)->u64{self.started.elapsed().as_millis() as u64}
    pub fn tick(&self){self.progress.store(self.now(),Ordering::Relaxed);}
    /// The multi-source query owner reports the oldest required owner turn.
    pub fn tick_at(&self,observed_ms:u64){self.progress.store(observed_ms.min(self.now()),Ordering::Relaxed);}
    pub fn stopping(&self)->bool{self.stopping.load(Ordering::Acquire)}
    pub fn stop(&self){self.stopping.store(true,Ordering::Release);self.update(|s|{s.phase=Phase::Stopping;s.authority_safe=false;});}
    pub fn fail(&self){self.update(|s|{s.phase=Phase::Failed;s.authority_safe=false;s.source_failures+=1;for d in &mut s.dependencies{d.state="unknown".into();d.reason=Some("terminal_runtime_failure".into());d.attribution="unknown".into();}});}
    pub fn update(&self,f:impl FnOnce(&mut Snapshot)){
        let now=self.now();let mut state=self.state.lock().unwrap();
        // Expired observations invalidate the hysteresis latch, even when no owner
        // turn occurred while HTTP correctly exposed the stale observation.
        if state.snapshot.sources.iter().any(|source|source.partitions.iter().any(|p|p.readable_sample_ms.is_none_or(|at|now.saturating_sub(at)>source.policy.max_sample_age_ms))){state.latch=ReadinessLatch::default();}
        f(&mut state.snapshot);
        let s=&mut state.snapshot;s.sequence+=1;s.sampled_at_unix_ms=wall_ms();s.observed_at_ms=now;
        s.owner_progress_ms=self.progress.load(Ordering::Relaxed);s.owner_stall_ms=if s.startup_complete{self.config.owner_stall_ms}else{self.config.startup_stall_ms};
        let copy=s.clone();let(ready,reason)=state.latch.evaluate(&copy,now);state.snapshot.ready=ready;state.snapshot.reason=reason;self.sequence.store(state.snapshot.sequence,Ordering::Release);
    }
    pub fn snapshot(&self)->Snapshot{
        let mut s=self.state.lock().unwrap().snapshot.clone();let now=self.now();
        s.owner_progress_ms=self.progress.load(Ordering::Relaxed);s.callback_failures=self.failures.load(Ordering::Relaxed);
        s.live=now.saturating_sub(s.owner_progress_ms)<=s.owner_stall_ms && s.phase!=Phase::Failed;
        // Freshness failure is immediate even if the owner or a callback is stuck.
        if !s.live || self.stopping() || s.sources.iter().any(|source|source.partitions.iter().any(|p|p.readable_sample_ms.is_none_or(|at|now.saturating_sub(at)>source.policy.max_sample_age_ms))){s.ready=false;if s.phase==Phase::Serving{s.reason="progress_unavailable_or_stale".into();}}
        if s.sources.iter().any(|source|source.retention.enabled&&(!source.retention.safe||source.retention.pending_due)){s.ready=false;if s.phase==Phase::Serving{s.reason="retention_maintenance_pending".into();}}
        s
    }
    pub fn json(&self)->Result<Vec<u8>,String>{let bytes=serde_json::to_vec(&self.snapshot()).map_err(|_|"snapshot encoding".to_string())?;if bytes.len()>MAX_SNAPSHOT_BYTES{return Err("snapshot bound".into());}Ok(bytes)}
}
pub fn wall_ms()->u64{SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64}

#[derive(Clone,Debug,Serialize)]
pub struct DependencyInventory {pub instance:String,pub sequence:u64,pub sampled_at_unix_ms:u64,pub observed_at_ms:u64,pub dependencies:Vec<Dependency>}
impl Snapshot {pub fn dependency_inventory(&self)->DependencyInventory{DependencyInventory{instance:self.instance.clone(),sequence:self.sequence,sampled_at_unix_ms:self.sampled_at_unix_ms,observed_at_ms:self.observed_at_ms,dependencies:self.dependencies.clone()}}}

/// Callbacks run on two fixed observer threads, one per callback kind. A slow
/// heartbeat cannot delay dependency reporting (or the authoritative owner).
/// Callbacks must return: Rust cannot forcibly cancel a blocking closure.
/// Shutdown uses one finite budget and never spawns replacement threads.
#[derive(Default)]
pub struct Callbacks {
    pub on_heartbeat: Option<Box<dyn FnMut(Snapshot)->Result<(),String>+Send>>,
    /// Every call is a COMPLETE inventory. The one-second per-dependency limit
    /// governs change triggers, not the visibility of each item: another
    /// dependency may trigger an inventory containing its latest state sooner.
    pub on_dependencies_update: Option<Box<dyn FnMut(DependencyInventory)->Result<(),String>+Send>>,
}

const DEPENDENCY_CHANGE_MS: u64 = 1000;
struct DependencySlot { observed:Dependency, last_trigger:Option<u64>, pending:bool }
/// One slot per currently configured dependency, never one item per event.
/// Polling a quiet snapshot still discharges the final pending change.
struct DependencySchedule { slots:Vec<DependencySlot>, last_inventory:u64, first:bool }
impl DependencySchedule {
    fn new()->Self{Self{slots:Vec::new(),last_inventory:0,first:true}}
    fn poll(&mut self,dependencies:&[Dependency],now:u64,period_ms:u64)->bool{
        let removed=self.slots.iter().any(|slot|!dependencies.iter().any(|d|d.id==slot.observed.id));
        self.slots.retain(|slot|dependencies.iter().any(|d|d.id==slot.observed.id));
        let mut changed=removed;
        for dependency in dependencies {
            let index=if let Some(index)=self.slots.iter().position(|slot|slot.observed.id==dependency.id){index}else{
                self.slots.push(DependencySlot{observed:dependency.clone(),last_trigger:None,pending:!self.first});self.slots.len()-1
            };
            let slot=&mut self.slots[index];
            if slot.observed!=*dependency {slot.observed=dependency.clone();slot.pending=true;}
            if slot.pending&&slot.last_trigger.is_none_or(|at|now.saturating_sub(at)>=DEPENDENCY_CHANGE_MS){
                slot.pending=false;slot.last_trigger=Some(now);changed=true;
            }
        }
        let emit=self.first||changed||now.saturating_sub(self.last_inventory)>=period_ms;
        if emit {self.last_inventory=now;}self.first=false;emit
    }
}

pub struct Reporter { done:std::sync::mpsc::Receiver<()>, exit:Arc<AtomicBool> }
impl Reporter {
    pub fn start(health:Arc<Health>,mut callbacks:Callbacks,telemetry:Arc<crate::telemetry::Telemetry>)->Self{
        let(done_tx,done)=std::sync::mpsc::sync_channel(2);let exit=Arc::new(AtomicBool::new(false));let startup=health.snapshot();
        {
            let health=health.clone();let telemetry=telemetry.clone();let quit=exit.clone();let done_tx=done_tx.clone();let startup=startup.clone();
            std::thread::spawn(move||{
                let mut callback=callbacks.on_heartbeat.take();
                let mut last=0;let mut previous=String::new();let mut change_at=None;let mut first=true;
                loop {
                    let s=if first{startup.clone()}else{health.snapshot()};let now=health.now();
                    // Sampling timestamps and counters are not lifecycle changes.
                    let semantic=format!("{:?}|{}|{}|{}",s.phase,s.ready,s.reason,serde_json::to_string(&s.dependencies).unwrap());
                    if semantic!=previous&&change_at.is_none(){change_at=Some(now);}
                    let changed=change_at.is_some_and(|at|now.saturating_sub(at)>=health.config.change_ms);
                    let ending=quit.load(Ordering::Acquire);
                    if first||ending||now.saturating_sub(last)>=health.config.heartbeat_ms||changed {
                        if let Some(cb)=callback.as_mut(){let start=Instant::now();let ok=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||cb(s))).is_ok_and(|v|v.is_ok());telemetry.callback("heartbeat",start.elapsed(),ok);if !ok{health.failures.fetch_add(1,Ordering::Relaxed);}}last=now;
                    }
                    if changed||first{previous=semantic;change_at=None;}first=false;if ending{break;}
                    std::thread::sleep(Duration::from_millis(25));
                }let _=done_tx.send(());
            });
        }
        {
            let quit=exit.clone();
            std::thread::spawn(move||{
                let mut callback=callbacks.on_dependencies_update.take();let mut schedule=DependencySchedule::new();let mut first=true;
                loop {
                    let s=if first{startup.clone()}else{health.snapshot()};first=false;
                    let ending=quit.load(Ordering::Acquire);
                    if schedule.poll(&s.dependencies,health.now(),health.config.dependencies_ms)||ending {
                        if let Some(cb)=callback.as_mut(){let start=Instant::now();let ok=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||cb(s.dependency_inventory()))).is_ok_and(|v|v.is_ok());telemetry.callback("dependencies",start.elapsed(),ok);if !ok{health.failures.fetch_add(1,Ordering::Relaxed);}}
                    }
                    if ending{break;}std::thread::sleep(Duration::from_millis(25));
                }let _=done_tx.send(());
            });
        }
        Self{done,exit}
    }
    pub fn shutdown(self,budget:Duration)->bool{
        self.exit.store(true,Ordering::Release);let start=Instant::now();
        (0..2).all(|_|self.done.recv_timeout(budget.saturating_sub(start.elapsed())).is_ok())
    }
}
#[cfg(test)]
#[path="health_tests.rs"]
mod tests;
