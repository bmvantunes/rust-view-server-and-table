//! Synchronous product-facing engine seam. No runtime registry or backend selection.
//! Engines include derived query evaluation/materialization, not just enqueue cost.
use crate::product::{ProductCommand, ProductResult};
use crate::source::{SourceBatch, SourceCommit};
use crate::topic::{TopicSnapshot, SourceObservation};
use serde::{Deserialize, Serialize};

pub type DifferentialProductEngine = crate::product::ProductCore;
pub type SelectedProductEngine = DifferentialProductEngine;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct EngineCompletion {
    pub product_version: u64,
    pub topic_version: u64,
    /// Invalidations require a fresh completed result, including pre-pagination totals.
    /// They are not claims that the visible rows necessarily differ.
    pub dirty_subscriptions: Vec<String>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct EngineStats {
    pub retained_rows: u64,
    pub query_shapes: u64,
    pub subscriptions: u64,
    pub result_rows_extracted: u64,
}

/// Intended for compile-time callers and the semantic harness. One production impl.
/// Validation failure leaves retained/derived state intact; an internal execution
/// failure is terminal. A failed engine must not publish or checkpoint partial state.
/// Acquisition ownership is still the transport/provider's responsibility; native
/// query_generation and navigation sequence retain their existing product semantics.
pub trait ProductEngine: Sized {
    fn load(snapshot: TopicSnapshot) -> Result<Self, String>;
    fn command(&mut self, command: ProductCommand) -> Result<EngineCompletion, String>;
    fn command_bounded(&mut self, _command: ProductCommand, _rows: usize, _bytes: usize) -> Result<EngineCompletion, String> {
        Err("bounded command unsupported".into())
    }
    fn commit(&mut self, batch: SourceBatch) -> Result<SourceCommit, String>;
    fn read(&mut self, subscription: &str) -> Option<ProductResult>;
    /// Implementations must pre-admit extraction; default refuses unsupported engines.
    fn read_bounded(&mut self, _subscription: &str, _rows: usize, _bytes: usize) -> Result<(ProductResult, usize), String> {
        Err("bounded extraction unsupported".into())
    }
    fn checkpoint(&self) -> Result<TopicSnapshot, String>;
    /// Indexed touched-key read; must not call checkpoint or traverse untouched rows.
    fn observe(&self, keys: &[String]) -> Result<SourceObservation, String>;
    fn engine_stats(&self) -> EngineStats;
    fn failure(&self) -> Option<&str>;
}
impl ProductEngine for DifferentialProductEngine {
    fn load(snapshot: TopicSnapshot) -> Result<Self, String> {
        Self::from_snapshot(snapshot)
    }
    fn command(&mut self, command: ProductCommand) -> Result<EngineCompletion, String> {
        self.apply(command)?;
        Ok(EngineCompletion {
            product_version: self.product_version(),
            topic_version: self.topic().version(),
            dirty_subscriptions: self.last_dirty_subscriptions().to_vec(),
        })
    }
    fn command_bounded(&mut self, command: ProductCommand, rows: usize, bytes: usize) -> Result<EngineCompletion, String> {
        self.preflight_query_command(&command, rows, bytes)?;
        ProductEngine::command(self, command)
    }
    fn commit(&mut self, batch: SourceBatch) -> Result<SourceCommit, String> {
        self.commit_source(batch)
    }
    fn read(&mut self, subscription: &str) -> Option<ProductResult> {
        self.result(subscription)
    }
    fn read_bounded(&mut self, subscription: &str, rows: usize, bytes: usize) -> Result<(ProductResult, usize), String> {
        self.bounded_result(subscription, rows, bytes)
    }
    fn checkpoint(&self) -> Result<TopicSnapshot, String> {
        if let Some(error) = self.terminal_failure() {
            return Err(format!("terminal engine: {error}"));
        }
        Ok(self.topic_snapshot())
    }
    fn observe(&self, keys: &[String]) -> Result<SourceObservation, String> {
        if let Some(error) = self.terminal_failure() { return Err(error.into()); }
        self.topic().observe(keys)
    }
    fn engine_stats(&self) -> EngineStats {
        let stats = self.stats();
        EngineStats {
            retained_rows: stats.retained_rows,
            query_shapes: stats.active_query_shapes,
            subscriptions: stats.active_subscriptions,
            result_rows_extracted: stats.result_rows_extracted,
        }
    }
    fn failure(&self) -> Option<&str> {
        self.terminal_failure()
    }
}
