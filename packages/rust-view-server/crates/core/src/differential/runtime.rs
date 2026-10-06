//! Single-owner Differential runtime shared by native and browser wrappers.
//!
//! The runtime owns one Timely worker, the retained base arrangement, dynamic
//! predicate input, and the shared viewport hub. Platform wrappers decide who
//! drives it: a native owner thread or a browser Worker calling it directly.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use differential_dataflow::{
    input::InputSession,
    trace::{BatchReader, TraceReader},
};
use timely::communication::{Allocator, allocator::thread::Thread as ThreadAllocator};
use timely::dataflow::operators::probe::Handle as ProbeHandle;
use timely::progress::Antichain;
use timely::worker::{Config as WorkerConfig, Worker};

use crate::common::{Command, EngineStats, LiveEngine, Predicate, Row, ViewResult};
use crate::viewport::{NavigationRequest, ViewportEngine, ViewportSnapshot, ViewportStats};

use super::{BaseTrace, QueryTrace, Snapshot, Subscriber, process_command};

type CapturedDelta = (u64, String, String, isize);

struct PendingBoundary {
    target: u64,
    progress_started: Option<Instant>,
}

/// A single-thread owner for the native Differential computation.
///
/// `DifferentialCore` intentionally does not spawn threads. The native adapter
/// may place it on a dedicated host thread; WASM calls it on its browser Worker.
pub(super) struct DifferentialCore {
    worker: Worker,
    rows_input: InputSession<u64, (String, (String, String)), isize>,
    queries_input: InputSession<u64, (String, u64), isize>,
    probe: ProbeHandle<u64>,
    updates: Rc<RefCell<Vec<CapturedDelta>>>,
    base_trace: Rc<RefCell<Option<BaseTrace>>>,
    query_trace: Rc<RefCell<Option<QueryTrace>>>,
    rows: BTreeMap<String, Row>,
    predicate_ids: BTreeMap<Predicate, u64>,
    predicates: BTreeMap<u64, Predicate>,
    predicate_refs: BTreeMap<u64, usize>,
    subscribers: BTreeMap<String, Subscriber>,
    next_predicate_id: u64,
    snapshot: Arc<Mutex<Snapshot>>,
    trace_diagnostics_enabled: bool,
    cost_diagnostics_enabled: bool,
    pending_boundary: Option<PendingBoundary>,
}

impl DifferentialCore {
    pub(super) fn new(
        snapshot: Arc<Mutex<Snapshot>>,
        trace_diagnostics_enabled: bool,
        cost_diagnostics_enabled: bool,
    ) -> Self {
        let allocator = Allocator::Thread(ThreadAllocator::default());
        let mut worker = Worker::new(WorkerConfig::default(), allocator, worker_clock());
        let mut rows_input = InputSession::<u64, (String, (String, String)), isize>::new();
        let mut queries_input = InputSession::<u64, (String, u64), isize>::new();
        let updates = Rc::new(RefCell::new(Vec::<CapturedDelta>::new()));
        let base_trace = Rc::new(RefCell::new(None::<BaseTrace>));
        let query_trace = Rc::new(RefCell::new(None::<QueryTrace>));
        let base_trace_capture = Rc::clone(&base_trace);
        let query_trace_capture = Rc::clone(&query_trace);
        let captured = Rc::clone(&updates);
        let probe = ProbeHandle::new();

        worker.dataflow(|scope| {
            let rows = rows_input.to_collection(scope).arrange_by_key();
            let queries = queries_input.to_collection(scope).arrange_by_key();
            *base_trace_capture.borrow_mut() = Some(rows.trace.clone());
            *query_trace_capture.borrow_mut() = Some(queries.trace.clone());
            queries
                .join_core(rows, |_bucket, predicate, (id, payload)| {
                    vec![(*predicate, (id.clone(), payload.clone()))]
                })
                .inspect(move |(data, _time, diff)| {
                    captured
                        .borrow_mut()
                        .push((data.0, data.1.0.clone(), data.1.1.clone(), *diff))
                })
                .probe_with(&probe);
        });
        {
            let mut state = snapshot.lock().expect("snapshot mutex poisoned");
            state.base_arrangement_builds += 1;
        }

        Self {
            worker,
            rows_input,
            queries_input,
            probe,
            updates,
            base_trace,
            query_trace,
            rows: BTreeMap::new(),
            predicate_ids: BTreeMap::new(),
            predicates: BTreeMap::new(),
            predicate_refs: BTreeMap::new(),
            subscribers: BTreeMap::new(),
            next_predicate_id: 1,
            snapshot,
            trace_diagnostics_enabled,
            cost_diagnostics_enabled,
            pending_boundary: None,
        }
    }

    /// Apply commands and flush input without waiting for output progress. A
    /// browser Worker can then yield between bounded calls to `poll_boundary`.
    pub(super) fn begin_boundary(&mut self, commands: &[Command]) -> Result<(), String> {
        if self.pending_boundary.is_some() {
            return Err("a Differential completion boundary is already in progress".to_owned());
        }
        let mut state = self
            .snapshot
            .lock()
            .map_err(|_| "snapshot mutex poisoned".to_owned())?;
        let Snapshot { viewport, cost, .. } = &mut *state;
        let command_count = commands.len() as u64;
        let command_started = self.cost_diagnostics_enabled.then(Instant::now);
        let mut input_session_updates = 0u64;
        let outcome = commands.iter().try_for_each(|command| {
            process_command(
                command,
                &mut self.rows,
                &mut self.rows_input,
                &mut self.queries_input,
                &mut self.predicate_ids,
                &mut self.predicates,
                &mut self.predicate_refs,
                &mut self.subscribers,
                viewport,
                &mut self.next_predicate_id,
                &mut input_session_updates,
            )
        });
        if let Some(started) = command_started {
            cost.boundaries += 1;
            cost.commands += command_count;
            cost.input_session_updates += input_session_updates;
            cost.command_processing_ns += started.elapsed().as_nanos();
        }
        if let Err(error) = outcome {
            state.base_rows = self.rows.len();
            return Err(error);
        }

        let progress_started = self.cost_diagnostics_enabled.then(Instant::now);
        self.rows_input.advance_to(self.rows_input.time() + 1);
        self.queries_input.advance_to(self.queries_input.time() + 1);
        self.rows_input.flush();
        self.queries_input.flush();
        let target = *self.rows_input.time();
        self.pending_boundary = Some(PendingBoundary {
            target,
            progress_started,
        });
        Ok(())
    }

    /// Drive at most `step_budget` Timely steps. Returns true only after the
    /// relevant output probe reached the flushed input version and all
    /// membership/window state for that boundary has been applied.
    pub(super) fn poll_boundary(&mut self, step_budget: usize) -> Result<bool, String> {
        let target = self
            .pending_boundary
            .as_ref()
            .map(|pending| pending.target)
            .ok_or_else(|| "no Differential completion boundary is in progress".to_owned())?;
        for _ in 0..step_budget.max(1) {
            if !self.probe.less_than(&target) {
                break;
            }
            self.worker.step();
        }
        if self.probe.less_than(&target) {
            return Ok(false);
        }

        let pending = self.pending_boundary.take().expect("boundary was present");
        let frontier = Antichain::from_elem(*self.rows_input.time());
        if let Some(trace) = self.base_trace.borrow_mut().as_mut() {
            trace.set_logical_compaction(frontier.borrow());
            trace.set_physical_compaction(frontier.borrow());
        }
        if let Some(trace) = self.query_trace.borrow_mut().as_mut() {
            trace.set_logical_compaction(frontier.borrow());
            trace.set_physical_compaction(frontier.borrow());
        }
        if self.trace_diagnostics_enabled {
            for _ in 0..32 {
                if !self.worker.step() {
                    break;
                }
            }
        } else {
            self.worker.step();
        }
        if let Some(started) = pending.progress_started {
            let mut state = self
                .snapshot
                .lock()
                .map_err(|_| "snapshot mutex poisoned".to_owned())?;
            let Snapshot { cost, .. } = &mut *state;
            cost.input_flush_probe_ns += started.elapsed().as_nanos();
        }

        let mut state = self
            .snapshot
            .lock()
            .map_err(|_| "snapshot mutex poisoned".to_owned())?;
        let Snapshot { viewport, cost, .. } = &mut *state;
        let index_started = self.cost_diagnostics_enabled.then(Instant::now);
        let mut grouped = BTreeMap::<(u64, Row), isize>::new();
        let captured = std::mem::take(&mut *self.updates.borrow_mut());
        if self.cost_diagnostics_enabled {
            cost.captured_deltas += captured.len() as u64;
        }
        for (predicate, id, payload, diff) in captured {
            *grouped.entry((predicate, Row { id, sort_key: payload.clone(), payload })).or_default() += diff;
        }
        let mut drained = grouped
            .into_iter()
            .filter(|(_, diff)| *diff != 0)
            .collect::<Vec<_>>();
        drained.sort_by_key(|(_, diff)| *diff > 0);
        if self.cost_diagnostics_enabled {
            cost.consolidated_deltas += drained.len() as u64;
            for (_, diff) in &drained {
                let operations = diff.unsigned_abs() as u64;
                if *diff > 0 {
                    cost.ranked_inserts += operations;
                } else {
                    cost.ranked_removes += operations;
                }
            }
        }
        let mut delta_error = None;
        for ((predicate, row), diff) in drained {
            if let Some(query) = self.predicates.get(&predicate) {
                if let Err(error) = viewport.apply_predicate_membership_delta(query, row, diff) {
                    delta_error = Some(error.to_string());
                    break;
                }
            }
        }
        if let Some(started) = index_started {
            cost.membership_index_ns += started.elapsed().as_nanos();
        }
        let viewport_started = self.cost_diagnostics_enabled.then(Instant::now);
        viewport
            .complete_boundary()
            .expect("viewport completion version");
        if let Some(started) = viewport_started {
            cost.viewport_boundary_ns += started.elapsed().as_nanos();
        }
        state.base_rows = self.rows.len();
        if let Some(error) = delta_error {
            return Err(error);
        }
        Ok(true)
    }

    /// Synchronous convenience used by the existing native adapter.
    pub(super) fn complete_boundary(&mut self, commands: &[Command]) -> Result<(), String> {
        self.begin_boundary(commands)?;
        while !self.poll_boundary(64)? {}
        Ok(())
    }

    pub(super) fn trace_diagnostic_text(&mut self) -> Result<String, String> {
        if !self.trace_diagnostics_enabled {
            return Err("trace diagnostics are disabled".to_owned());
        }
        Ok(format_trace_diagnostics(
            &mut self.base_trace.borrow_mut(),
            &mut self.query_trace.borrow_mut(),
        ))
    }
}

fn worker_clock() -> Option<Instant> {
    #[cfg(target_arch = "wasm32")]
    {
        None
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        Some(Instant::now())
    }
}

fn format_trace_diagnostics(
    base_trace: &mut Option<BaseTrace>,
    query_trace: &mut Option<QueryTrace>,
) -> String {
    fn trace_summary<Tr>(trace: &mut Tr) -> String
    where
        Tr: TraceReader,
        Tr::Batch: BatchReader,
    {
        let mut batches = 0usize;
        let mut records = 0usize;
        trace.map_batches(|batch| {
            batches += 1;
            records += batch.len();
        });
        let logical = format!("{:?}", trace.get_logical_compaction());
        let physical = format!("{:?}", trace.get_physical_compaction());
        format!("batches={batches},records={records},logical={logical},physical={physical}")
    }

    let base = base_trace
        .as_mut()
        .map(trace_summary)
        .unwrap_or_else(|| "unavailable".to_owned());
    let query = query_trace
        .as_mut()
        .map(trace_summary)
        .unwrap_or_else(|| "unavailable".to_owned());
    format!("base[{base}] query[{query}]")
}

impl LiveEngine for DifferentialCore {
    fn apply(&mut self, command: Command) -> Result<(), String> {
        self.complete_boundary(&[command])
    }

    fn complete(&mut self) -> Result<(), String> {
        self.complete_boundary(&[])
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
            .map(|state| state.viewport.subscriber_ids())
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
}

impl ViewportEngine for DifferentialCore {
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
