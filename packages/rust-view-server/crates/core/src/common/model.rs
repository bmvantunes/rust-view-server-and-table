use std::collections::BTreeSet;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct Row {
    pub id: String,
    pub payload: String,
    /// Primary sort field, compared independently from payload and identity.
    pub sort_key: String,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum Predicate {
    All,
    PayloadIn(BTreeSet<String>),
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum SortDirection {
    Ascending,
    Descending,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct WindowRequest {
    pub offset: i64,
    pub limit: i64,
}

impl WindowRequest {
    pub fn checked(self) -> Result<(usize, usize), CommandError> {
        let offset = usize::try_from(self.offset).map_err(|_| CommandError::NegativeOffset)?;
        let limit = usize::try_from(self.limit).map_err(|_| CommandError::NegativeLimit)?;
        Ok((offset, limit))
    }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct QueryDefinition {
    pub predicate: Predicate,
    pub sort: SortDirection,
    pub window: WindowRequest,
}

impl QueryDefinition {
    pub fn validate_window(&self, max_prefix: Option<usize>) -> Result<(), CommandError> {
        let (offset, limit) = self.window.checked()?;
        let end = offset
            .checked_add(limit)
            .ok_or(CommandError::WindowOverflow)?;
        if let Some(maximum) = max_prefix
            && end > maximum
        {
            return Err(CommandError::WindowExceedsMaximum { end, maximum });
        }
        Ok(())
    }

    pub fn matches(&self, row: &Row) -> bool {
        match &self.predicate {
            Predicate::All => true,
            Predicate::PayloadIn(values) => values.contains(&row.payload),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ViewResult {
    pub rows: Vec<Row>,
    pub total_rows: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Command {
    Upsert(Row),
    Delete(String),
    Open {
        subscriber: String,
        query: QueryDefinition,
    },
    ChangePredicate {
        subscriber: String,
        predicate: Predicate,
    },
    ChangeSort {
        subscriber: String,
        sort: SortDirection,
    },
    ChangeWindow {
        subscriber: String,
        window: WindowRequest,
    },
    Close {
        subscriber: String,
    },
    /// Apply all nested changes as one logical input boundary.
    Boundary(Vec<Command>),
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct EngineStats {
    pub base_rows: usize,
    pub active_query_shapes: usize,
    pub candidate_pairs: Option<u64>,
    pub matching_memberships: Option<usize>,
    pub ranked_rows: Option<usize>,
    pub active_windows: usize,
    pub output_rows: usize,
    /// Number of times the retained native base arrangement was constructed.
    pub base_arrangement_builds: usize,
    /// Number of times the fixed native circuit was constructed.
    pub circuit_builds: usize,
}

pub trait LiveEngine {
    fn apply(&mut self, command: Command) -> Result<(), String>;
    fn complete(&mut self) -> Result<(), String>;
    fn result(&self, subscriber: &str) -> Option<ViewResult>;
    fn subscriber_ids(&self) -> Vec<String>;
    fn stats(&self) -> EngineStats;
    /// Coarse engine-internal timings collected only when VIEW_COST_DIAGNOSTICS=1.
    /// The default keeps normal benchmark runs free of per-boundary reporting work.
    fn cost_diagnostics(&self) -> Option<String> {
        None
    }
    fn reset_cost_diagnostics(&mut self) {}
    /// Optional engine-specific diagnostic state; excluded unless explicitly enabled.
    fn trace_diagnostics(&self) -> Option<String> {
        None
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandError {
    NegativeOffset,
    NegativeLimit,
    WindowOverflow,
    WindowExceedsMaximum { end: usize, maximum: usize },
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NegativeOffset => f.write_str("negative offset is not defined by the contract"),
            Self::NegativeLimit => f.write_str("negative limit is not defined by the contract"),
            Self::WindowOverflow => f.write_str("offset + limit overflows addressable range"),
            Self::WindowExceedsMaximum { end, maximum } => {
                write!(f, "window end {end} exceeds maximum prefix {maximum}")
            }
        }
    }
}

impl std::error::Error for CommandError {}

/// Returns `local:0:k` followed by unpadded base64url of the serialized Kafka key.
pub fn canonical_row_id(serialized_key: &[u8]) -> String {
    format!("local:0:k{}", URL_SAFE_NO_PAD.encode(serialized_key))
}
