//! Native Differential Dataflow / Timely implementation of the live-view contract.
//!
//! One dedicated Timely worker owns one long-lived base collection and keyed arrangement.
//! Runtime predicate definitions are input data joined with that retained arrangement;
//! membership changes are taken from the Differential output stream. Ordering and windows
//! use the shared incremental index in `common::ordering`.

use differential_dataflow::{
    input::InputSession, operators::arrange::TraceAgent, trace::implementations::ValSpine,
};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{
    Arc, Mutex,
    mpsc::{self, Sender, SyncSender},
};
use std::thread::{self, JoinHandle};

use crate::common::{
    Command, EngineStats, LiveEngine, Predicate, Row, SortDirection, ViewResult, WindowRequest,
};
use crate::viewport::{
    NavigationRequest, ViewportEngine, ViewportHub, ViewportSnapshot, ViewportStats,
};

pub mod fixture;
mod runtime;
use runtime::DifferentialCore;

#[derive(Clone)]
struct Subscriber {
    predicate: u64,
    sort: SortDirection,
    window: WindowRequest,
}

#[derive(Default)]
struct Snapshot {
    viewport: ViewportHub,
    base_rows: usize,
    base_arrangement_builds: usize,
    cost: WorkerCost,
}

#[derive(Default)]
struct WorkerCost {
    boundaries: u64,
    commands: u64,
    input_session_updates: u64,
    command_processing_ns: u128,
    input_flush_probe_ns: u128,
    captured_deltas: u64,
    consolidated_deltas: u64,
    membership_index_ns: u128,
    viewport_boundary_ns: u128,
    ranked_inserts: u64,
    ranked_removes: u64,
}

enum WorkerCommand {
    Boundary(Vec<Command>, SyncSender<Result<(), String>>),
    TraceDiagnostics(SyncSender<Result<String, String>>),
    Stop,
}

type BaseTrace = TraceAgent<ValSpine<String, (String, String), u64, isize>>;
type QueryTrace = TraceAgent<ValSpine<String, u64, u64, isize>>;

pub struct DifferentialEngine {
    sender: Sender<WorkerCommand>,
    worker: Option<JoinHandle<()>>,
    pending: Vec<Command>,
    snapshot: Arc<Mutex<Snapshot>>,
    trace_diagnostics_enabled: bool,
    cost_diagnostics_enabled: bool,
}

impl DifferentialEngine {
    pub fn new() -> Self {
        let (sender, receiver) = mpsc::channel();
        let receiver = Arc::new(Mutex::new(receiver));
        let (started_tx, started_rx) = mpsc::sync_channel(1);
        let snapshot = Arc::new(Mutex::new(Snapshot::default()));
        let worker_snapshot = Arc::clone(&snapshot);
        let trace_diagnostics_enabled =
            std::env::var_os("DIFFERENTIAL_TRACE_DIAGNOSTICS").is_some();
        let cost_diagnostics_enabled = std::env::var_os("VIEW_COST_DIAGNOSTICS").is_some();
        let worker_trace_diagnostics_enabled = trace_diagnostics_enabled;
        let worker_cost_diagnostics_enabled = cost_diagnostics_enabled;
        let worker = thread::Builder::new()
            .name("differential-timely-worker".into())
            .spawn(move || {
                let mut core = DifferentialCore::new(
                    worker_snapshot,
                    worker_trace_diagnostics_enabled,
                    worker_cost_diagnostics_enabled,
                );
                let _ = started_tx.send(());
                loop {
                    let message = receiver
                        .lock()
                        .expect("worker receiver mutex poisoned")
                        .recv();
                    let Ok(message) = message else {
                        break;
                    };
                    match message {
                        WorkerCommand::Stop => break,
                        WorkerCommand::TraceDiagnostics(response) => {
                            let _ = response.send(core.trace_diagnostic_text());
                        }
                        WorkerCommand::Boundary(commands, response) => {
                            let _ = response.send(core.complete_boundary(&commands));
                        }
                    }
                }
            })
            .expect("failed to start Differential worker");
        started_rx
            .recv()
            .expect("Differential worker failed during startup");
        Self {
            sender,
            worker: Some(worker),
            pending: Vec::new(),
            snapshot,
            trace_diagnostics_enabled,
            cost_diagnostics_enabled,
        }
    }
}

impl Default for DifferentialEngine {
    fn default() -> Self {
        Self::new()
    }
}

/// Direct single-thread wrapper around the same Differential core.
/// Native conformance and browser WASM use this instead of spawning an owner
/// thread; the production native adapter continues to use `DifferentialEngine`.
pub struct InlineDifferentialEngine {
    core: DifferentialCore,
    pending: Vec<Command>,
}

impl InlineDifferentialEngine {
    pub fn new() -> Self {
        Self {
            core: DifferentialCore::new(Arc::new(Mutex::new(Snapshot::default())), false, false),
            pending: Vec::new(),
        }
    }
}

impl Default for InlineDifferentialEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl LiveEngine for InlineDifferentialEngine {
    fn apply(&mut self, command: Command) -> Result<(), String> {
        self.pending.push(command);
        Ok(())
    }

    fn complete(&mut self) -> Result<(), String> {
        self.core
            .complete_boundary(&std::mem::take(&mut self.pending))
    }

    fn result(&self, subscriber: &str) -> Option<ViewResult> {
        self.core.result(subscriber)
    }

    fn subscriber_ids(&self) -> Vec<String> {
        self.core.subscriber_ids()
    }

    fn stats(&self) -> EngineStats {
        self.core.stats()
    }
}

impl ViewportEngine for InlineDifferentialEngine {
    fn navigate_viewport(
        &mut self,
        subscriber: &str,
        request: NavigationRequest,
    ) -> Result<ViewportSnapshot, String> {
        self.core.navigate_viewport(subscriber, request)
    }

    fn accept_viewport_response(&mut self, response: &ViewportSnapshot) -> bool {
        self.core.accept_viewport_response(response)
    }

    fn viewport_snapshot(&self, subscriber: &str) -> Option<ViewportSnapshot> {
        self.core.viewport_snapshot(subscriber)
    }

    fn viewport_stats(&self) -> ViewportStats {
        self.core.viewport_stats()
    }
}

impl Drop for DifferentialEngine {
    fn drop(&mut self) {
        let _ = self.sender.send(WorkerCommand::Stop);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl LiveEngine for DifferentialEngine {
    fn apply(&mut self, command: Command) -> Result<(), String> {
        self.pending.push(command);
        Ok(())
    }

    fn complete(&mut self) -> Result<(), String> {
        let (response, received) = mpsc::sync_channel(1);
        self.sender
            .send(WorkerCommand::Boundary(
                std::mem::take(&mut self.pending),
                response,
            ))
            .map_err(|_| "Differential worker stopped unexpectedly".to_owned())?;
        received
            .recv()
            .map_err(|_| "Differential worker did not return boundary result".to_owned())?
    }

    fn result(&self, subscriber: &str) -> Option<ViewResult> {
        let snapshot = self.snapshot.lock().ok()?.viewport.snapshot(subscriber)?;
        Some(ViewResult {
            rows: snapshot.rows,
            total_rows: snapshot.total_rows as u64,
        })
    }

    fn subscriber_ids(&self) -> Vec<String> {
        self.snapshot
            .lock()
            .map(|s| s.viewport.subscriber_ids())
            .unwrap_or_default()
    }

    fn stats(&self) -> EngineStats {
        let Ok(state) = self.snapshot.lock() else {
            return EngineStats::default();
        };
        let viewport = state.viewport.stats();
        EngineStats {
            base_rows: state.base_rows,
            active_query_shapes: viewport.active_query_shapes,
            candidate_pairs: None,
            matching_memberships: Some(viewport.indexed_memberships),
            ranked_rows: Some(viewport.indexed_memberships),
            active_windows: viewport.subscribers,
            output_rows: state.viewport.output_row_count(),
            base_arrangement_builds: state.base_arrangement_builds,
            circuit_builds: 0,
        }
    }

    fn cost_diagnostics(&self) -> Option<String> {
        if !self.cost_diagnostics_enabled {
            return None;
        }
        let state = self.snapshot.lock().ok()?;
        let cost = &state.cost;
        Some(format!(
            "engine=differential worker_boundaries={} worker_commands={} InputSession_update_calls={} command_processing_ns={} input_flush_probe_ns={} captured_membership_deltas={} consolidated_membership_deltas={} ranked_index_operations={} ranked_inserts={} ranked_removes={} membership_index_ns={} viewport_boundary_ns={}",
            cost.boundaries,
            cost.commands,
            cost.input_session_updates,
            cost.command_processing_ns,
            cost.input_flush_probe_ns,
            cost.captured_deltas,
            cost.consolidated_deltas,
            cost.ranked_inserts + cost.ranked_removes,
            cost.ranked_inserts,
            cost.ranked_removes,
            cost.membership_index_ns,
            cost.viewport_boundary_ns,
        ))
    }

    fn reset_cost_diagnostics(&mut self) {
        if let Ok(mut state) = self.snapshot.lock() {
            state.cost = WorkerCost::default();
        }
    }

    fn trace_diagnostics(&self) -> Option<String> {
        if !self.trace_diagnostics_enabled {
            return None;
        }
        let (response, received) = mpsc::sync_channel(1);
        self.sender
            .send(WorkerCommand::TraceDiagnostics(response))
            .ok()?;
        received.recv().ok()?.ok()
    }
}

impl ViewportEngine for DifferentialEngine {
    fn navigate_viewport(
        &mut self,
        subscriber: &str,
        request: NavigationRequest,
    ) -> Result<ViewportSnapshot, String> {
        self.snapshot
            .lock()
            .map_err(|_| "snapshot mutex poisoned".to_owned())?
            .viewport
            .navigate(subscriber, request)
    }
    fn accept_viewport_response(&mut self, response: &ViewportSnapshot) -> bool {
        self.snapshot
            .lock()
            .map(|mut state| state.viewport.accept_response(response))
            .unwrap_or(false)
    }
    fn viewport_snapshot(&self, subscriber: &str) -> Option<ViewportSnapshot> {
        self.snapshot.lock().ok()?.viewport.snapshot(subscriber)
    }
    fn viewport_stats(&self) -> ViewportStats {
        self.snapshot
            .lock()
            .map(|state| state.viewport.stats())
            .unwrap_or_default()
    }
}

fn process_command(
    command: &Command,
    rows: &mut BTreeMap<String, Row>,
    rows_input: &mut InputSession<u64, (String, (String, String)), isize>,
    queries_input: &mut InputSession<u64, (String, u64), isize>,
    predicate_ids: &mut BTreeMap<Predicate, u64>,
    predicates: &mut BTreeMap<u64, Predicate>,
    predicate_refs: &mut BTreeMap<u64, usize>,
    subscribers: &mut BTreeMap<String, Subscriber>,
    viewport: &mut ViewportHub,
    next_predicate_id: &mut u64,
    input_session_updates: &mut u64,
) -> Result<(), String> {
    match command {
        Command::Upsert(row) => {
            if rows.get(&row.id) == Some(row) {
                return Ok(());
            }
            if let Some(old) = rows.insert(row.id.clone(), row.clone()) {
                update_row(rows_input, &old, -1, input_session_updates);
            }
            update_row(rows_input, row, 1, input_session_updates);
        }
        Command::Delete(id) => {
            if let Some(old) = rows.remove(id) {
                update_row(rows_input, &old, -1, input_session_updates);
            }
        }
        Command::Open { subscriber, query } => {
            query
                .validate_window(None)
                .map_err(|error| error.to_string())?;
            if subscribers.contains_key(subscriber) {
                return Err(format!("subscriber {subscriber} is already open"));
            }
            let predicate = acquire_predicate(
                &query.predicate,
                predicate_ids,
                predicates,
                predicate_refs,
                queries_input,
                next_predicate_id,
            );
            subscribers.insert(
                subscriber.clone(),
                Subscriber {
                    predicate,
                    sort: query.sort,
                    window: query.window,
                },
            );
            let (offset, limit) = query.window.checked().map_err(|error| error.to_string())?;
            viewport.open_window(
                subscriber.clone(),
                query.predicate.clone(),
                query.sort,
                offset,
                limit,
            )?;
        }
        Command::ChangePredicate {
            subscriber,
            predicate,
        } => {
            let current = subscribers
                .get(subscriber)
                .ok_or_else(|| format!("subscriber {subscriber} is not open"))?
                .clone();
            if predicates.get(&current.predicate) != Some(predicate) {
                release_predicate(
                    current.predicate,
                    predicate_refs,
                    predicate_ids,
                    predicates,
                    queries_input,
                );
                let next = acquire_predicate(
                    predicate,
                    predicate_ids,
                    predicates,
                    predicate_refs,
                    queries_input,
                    next_predicate_id,
                );
                subscribers.insert(
                    subscriber.clone(),
                    Subscriber {
                        predicate: next,
                        ..current.clone()
                    },
                );
                let (_, limit) = current
                    .window
                    .checked()
                    .map_err(|error| error.to_string())?;
                viewport.change_query(subscriber, predicate.clone(), current.sort, limit)?;
            }
        }
        Command::ChangeSort { subscriber, sort } => {
            let current = subscribers
                .get_mut(subscriber)
                .ok_or_else(|| format!("subscriber {subscriber} is not open"))?;
            if current.sort != *sort {
                current.sort = *sort;
                let predicate = predicates
                    .get(&current.predicate)
                    .cloned()
                    .ok_or("active Differential predicate missing")?;
                let (_, limit) = current
                    .window
                    .checked()
                    .map_err(|error| error.to_string())?;
                viewport.change_query(subscriber, predicate, *sort, limit)?;
            }
        }
        Command::ChangeWindow { subscriber, window } => {
            window.checked().map_err(|error| error.to_string())?;
            let current = subscribers
                .get_mut(subscriber)
                .ok_or_else(|| format!("subscriber {subscriber} is not open"))?;
            current.window = *window;
            let (offset, limit) = window.checked().map_err(|error| error.to_string())?;
            viewport.change_window(subscriber, offset, limit)?;
        }
        Command::Close { subscriber } => {
            let old = subscribers
                .remove(subscriber)
                .ok_or_else(|| format!("subscriber {subscriber} is not open"))?;
            viewport.close(subscriber)?;
            release_predicate(
                old.predicate,
                predicate_refs,
                predicate_ids,
                predicates,
                queries_input,
            );
        }
        Command::Boundary(commands) => {
            for nested in commands {
                process_command(
                    nested,
                    rows,
                    rows_input,
                    queries_input,
                    predicate_ids,
                    predicates,
                    predicate_refs,
                    subscribers,
                    viewport,
                    next_predicate_id,
                    input_session_updates,
                )?;
            }
        }
    }
    Ok(())
}

fn update_row(
    input: &mut InputSession<u64, (String, (String, String)), isize>,
    row: &Row,
    diff: isize,
    input_session_updates: &mut u64,
) {
    let value = (row.id.clone(), row.payload.clone());
    input.update((all_bucket(), value.clone()), diff);
    input.update((payload_bucket(&row.payload), value), diff);
    *input_session_updates += 2;
}

fn all_bucket() -> String {
    "\0all".to_owned()
}
fn payload_bucket(payload: &str) -> String {
    format!("\0payload:{payload}")
}

fn acquire_predicate(
    predicate: &Predicate,
    ids: &mut BTreeMap<Predicate, u64>,
    predicates: &mut BTreeMap<u64, Predicate>,
    refs: &mut BTreeMap<u64, usize>,
    input: &mut InputSession<u64, (String, u64), isize>,
    next_id: &mut u64,
) -> u64 {
    let id = *ids.entry(predicate.clone()).or_insert_with(|| {
        let id = *next_id;
        *next_id += 1;
        predicates.insert(id, predicate.clone());
        id
    });
    let count = refs.entry(id).or_default();
    if *count == 0 {
        for bucket in predicate_buckets(predicate) {
            input.insert((bucket, id));
        }
    }
    *count += 1;
    id
}

fn release_predicate(
    id: u64,
    refs: &mut BTreeMap<u64, usize>,
    ids: &mut BTreeMap<Predicate, u64>,
    predicates: &mut BTreeMap<u64, Predicate>,
    input: &mut InputSession<u64, (String, u64), isize>,
) {
    if let Some(count) = refs.get_mut(&id) {
        *count -= 1;
        if *count == 0 {
            let predicate = predicates
                .remove(&id)
                .expect("active predicate reference has a definition");
            for bucket in predicate_buckets(&predicate) {
                input.remove((bucket, id));
            }
            refs.remove(&id);
            ids.remove(&predicate);
        }
    }
}

fn predicate_buckets(predicate: &Predicate) -> Vec<String> {
    match predicate {
        Predicate::All => vec![all_bucket()],
        Predicate::PayloadIn(values) => values
            .iter()
            .map(|value| payload_bucket(value))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn predicate_registry_is_shared_then_released_at_zero_references() {
        let predicate = Predicate::PayloadIn(BTreeSet::from(["value".to_owned()]));
        let mut ids = BTreeMap::new();
        let mut predicates = BTreeMap::new();
        let mut refs = BTreeMap::new();
        let mut input = InputSession::<u64, (String, u64), isize>::new();
        let mut next_id = 1;

        let first = acquire_predicate(
            &predicate,
            &mut ids,
            &mut predicates,
            &mut refs,
            &mut input,
            &mut next_id,
        );
        let shared = acquire_predicate(
            &predicate,
            &mut ids,
            &mut predicates,
            &mut refs,
            &mut input,
            &mut next_id,
        );
        assert_eq!(first, shared);
        assert_eq!(refs.get(&first), Some(&2));
        release_predicate(first, &mut refs, &mut ids, &mut predicates, &mut input);
        assert_eq!(ids.get(&predicate), Some(&first));
        assert_eq!(predicates.get(&first), Some(&predicate));
        release_predicate(first, &mut refs, &mut ids, &mut predicates, &mut input);
        assert!(refs.is_empty());
        assert!(ids.is_empty());
        assert!(predicates.is_empty());
    }
}
