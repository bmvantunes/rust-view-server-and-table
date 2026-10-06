//! Small deterministic corpus shared by the native and browser Worker smoke.
//! The browser-side test computes expected snapshots independently in JS.

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

use crate::common::{
    Command, LiveEngine, OracleSession, Predicate, QueryDefinition, Row, SortDirection, ViewResult,
    WindowRequest,
};

use super::{DifferentialCore, InlineDifferentialEngine, Snapshot};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Checkpoint {
    pub label: &'static str,
    pub subscriber: &'static str,
}

pub struct FixtureStep {
    pub commands: Vec<Command>,
    pub checkpoint: Option<Checkpoint>,
}

pub fn steps() -> Vec<FixtureStep> {
    let all = Predicate::All;
    let bc = Predicate::PayloadIn(BTreeSet::from(["B".to_owned(), "C".to_owned()]));
    let empty = Predicate::PayloadIn(BTreeSet::new());
    let query = |predicate, offset, limit| QueryDefinition {
        predicate,
        sort: SortDirection::Ascending,
        window: WindowRequest { offset, limit },
    };
    vec![
        FixtureStep {
            commands: vec![
                Command::Upsert(Row {
                    id: "r1".into(),
                    payload: "A".into(),
                    sort_key: "A".into(),
                }),
                Command::Upsert(Row {
                    id: "r2".into(),
                    payload: "B".into(),
                    sort_key: "B".into(),
                }),
                Command::Upsert(Row {
                    id: "r3".into(),
                    payload: "A".into(),
                    sort_key: "A".into(),
                }),
                Command::Upsert(Row {
                    id: "r4".into(),
                    payload: "C".into(),
                    sort_key: "C".into(),
                }),
            ],
            checkpoint: None,
        },
        FixtureStep {
            commands: vec![Command::Open {
                subscriber: "main".into(),
                query: query(all, 0, 2),
            }],
            checkpoint: Some(Checkpoint {
                label: "initial",
                subscriber: "main",
            }),
        },
        FixtureStep {
            commands: vec![Command::ChangePredicate {
                subscriber: "main".into(),
                predicate: bc,
            }],
            checkpoint: Some(Checkpoint {
                label: "predicate",
                subscriber: "main",
            }),
        },
        FixtureStep {
            commands: vec![Command::ChangeWindow {
                subscriber: "main".into(),
                window: WindowRequest {
                    offset: 1,
                    limit: 1,
                },
            }],
            checkpoint: Some(Checkpoint {
                label: "window",
                subscriber: "main",
            }),
        },
        FixtureStep {
            commands: vec![Command::ChangeWindow {
                subscriber: "main".into(),
                window: WindowRequest {
                    offset: 0,
                    limit: 4,
                },
            }],
            checkpoint: None,
        },
        FixtureStep {
            commands: vec![Command::ChangePredicate {
                subscriber: "main".into(),
                predicate: Predicate::All,
            }],
            checkpoint: None,
        },
        FixtureStep {
            commands: vec![Command::Upsert(Row {
                id: "r4".into(),
                payload: "0".into(),
                sort_key: "0".into(),
            })],
            checkpoint: Some(Checkpoint {
                label: "replacement",
                subscriber: "main",
            }),
        },
        FixtureStep {
            commands: vec![Command::Delete("r4".into())],
            checkpoint: Some(Checkpoint {
                label: "delete",
                subscriber: "main",
            }),
        },
        FixtureStep {
            commands: vec![Command::Open {
                subscriber: "empty".into(),
                query: query(empty, 0, 8),
            }],
            checkpoint: Some(Checkpoint {
                label: "empty",
                subscriber: "empty",
            }),
        },
        FixtureStep {
            commands: vec![Command::Open {
                subscriber: "zero".into(),
                query: query(Predicate::All, 0, 0),
            }],
            checkpoint: Some(Checkpoint {
                label: "zero-limit",
                subscriber: "zero",
            }),
        },
        FixtureStep {
            commands: vec![
                Command::Close {
                    subscriber: "main".into(),
                },
                Command::Close {
                    subscriber: "empty".into(),
                },
                Command::Close {
                    subscriber: "zero".into(),
                },
            ],
            checkpoint: None,
        },
        FixtureStep {
            commands: vec![Command::Open {
                subscriber: "reopened".into(),
                query: query(Predicate::All, 0, 8),
            }],
            checkpoint: Some(Checkpoint {
                label: "reopened",
                subscriber: "reopened",
            }),
        },
    ]
}

pub fn run() -> Result<Vec<(Checkpoint, ViewResult)>, String> {
    let mut engine = InlineDifferentialEngine::new();
    let mut oracle = OracleSession::default();
    let mut observed = Vec::new();
    for step in steps() {
        for command in step.commands {
            engine.apply(command.clone())?;
            oracle.apply_command(command)?;
        }
        engine.complete()?;
        if let Some(checkpoint) = step.checkpoint {
            let result = engine
                .result(checkpoint.subscriber)
                .ok_or_else(|| format!("missing result for {}", checkpoint.subscriber))?;
            if oracle.query(checkpoint.subscriber).as_ref() != Some(&result) {
                return Err(format!(
                    "independent oracle mismatch at {}",
                    checkpoint.label
                ));
            }
            observed.push((checkpoint, result));
        }
    }
    let stats = engine.stats();
    if stats.base_arrangement_builds != 1 || stats.base_rows != 3 {
        return Err(format!(
            "unexpected retained state: builds={}, rows={}",
            stats.base_arrangement_builds, stats.base_rows
        ));
    }
    Ok(observed)
}

/// Fixture driver used by the browser WASM test. Timely work is advanced in
/// bounded slices; each slice returns to the JS Worker event loop.
pub struct CooperativeFixture {
    core: DifferentialCore,
    steps: Vec<FixtureStep>,
    next_step: usize,
    active_step: bool,
    observed: Vec<(Checkpoint, ViewResult)>,
    finished: bool,
    failure: Option<String>,
}

impl CooperativeFixture {
    pub fn new() -> Self {
        Self {
            core: DifferentialCore::new(Arc::new(Mutex::new(Snapshot::default())), false, false),
            steps: steps(),
            next_step: 0,
            active_step: false,
            observed: Vec::new(),
            finished: false,
            failure: None,
        }
    }

    /// Starts the next logical command boundary. Returns false at end-of-fixture.
    pub fn begin_next(&mut self) -> Result<bool, String> {
        if let Some(error) = &self.failure {
            return Err(error.clone());
        }
        if self.active_step {
            return Err("fixture boundary is already active".to_owned());
        }
        if self.finished {
            return Ok(false);
        }
        let Some(step) = self.steps.get(self.next_step) else {
            self.finished = true;
            return Ok(false);
        };
        if let Err(error) = self.core.begin_boundary(&step.commands) {
            self.failure = Some(error.clone());
            return Err(error);
        }
        self.active_step = true;
        Ok(true)
    }

    /// Performs no more than `step_budget` Timely steps. Returns true once the
    /// current boundary's output and viewport changes are fully applied.
    pub fn poll(&mut self, step_budget: usize) -> Result<bool, String> {
        if let Some(error) = &self.failure {
            return Err(error.clone());
        }
        if !self.active_step {
            return Err("fixture has no active boundary".to_owned());
        }
        match self.core.poll_boundary(step_budget) {
            Ok(false) => Ok(false),
            Ok(true) => {
                let step = &self.steps[self.next_step];
                if let Some(checkpoint) = step.checkpoint {
                    let result = self
                        .core
                        .result(checkpoint.subscriber)
                        .ok_or_else(|| format!("missing result for {}", checkpoint.subscriber))?;
                    self.observed.push((checkpoint, result));
                }
                self.active_step = false;
                self.next_step += 1;
                if self.next_step == self.steps.len() {
                    let stats = self.core.stats();
                    if stats.base_arrangement_builds != 1 || stats.base_rows != 3 {
                        let error = format!(
                            "unexpected retained state: builds={}, rows={}",
                            stats.base_arrangement_builds, stats.base_rows
                        );
                        self.failure = Some(error.clone());
                        return Err(error);
                    }
                    self.finished = true;
                }
                Ok(true)
            }
            Err(error) => {
                self.failure = Some(error.clone());
                Err(error)
            }
        }
    }

    pub fn finished(&self) -> bool {
        self.finished
    }

    pub fn observations_json(&self) -> Result<String, String> {
        if !self.finished {
            return Err("fixture results requested before completion".to_owned());
        }
        let mut json = String::from("[");
        for (index, (checkpoint, result)) in self.observed.iter().enumerate() {
            if index > 0 {
                json.push(',');
            }
            json.push_str(&format!(
                "{{\"label\":{},\"totalRows\":{},\"rows\":[",
                quote_json(checkpoint.label),
                result.total_rows
            ));
            for (row_index, row) in result.rows.iter().enumerate() {
                if row_index > 0 {
                    json.push(',');
                }
                json.push_str(&format!(
                    "{{\"id\":{},\"payload\":{}}}",
                    quote_json(&row.id),
                    quote_json(&row.payload)
                ));
            }
            json.push_str("]}");
        }
        json.push(']');
        Ok(json)
    }
}

impl Default for CooperativeFixture {
    fn default() -> Self {
        Self::new()
    }
}

fn quote_json(value: &str) -> String {
    let mut out = String::from("\"");
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if ch < ' ' => out.push_str(&format!("\\u{:04x}", u32::from(ch))),
            ch => out.push(ch),
        }
    }
    out.push('"');
    out
}

/// Stable FNV-1a digest over the label and the exact returned values/counts.
/// The browser test independently constructs the expected observations.
pub fn digest(observations: &[(Checkpoint, ViewResult)]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    let mut write = |bytes: &[u8]| {
        for byte in bytes {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    };
    for (checkpoint, result) in observations {
        write(checkpoint.label.as_bytes());
        write(&[0]);
        write(&result.total_rows.to_le_bytes());
        write(&(result.rows.len() as u64).to_le_bytes());
        for row in &result.rows {
            write(&(row.id.len() as u64).to_le_bytes());
            write(row.id.as_bytes());
            write(&(row.payload.len() as u64).to_le_bytes());
            write(row.payload.as_bytes());
        }
    }
    hash
}
