//! First product-shaped exact-value layer over a real Differential membership stream.
//! The query subset is intentionally explicit; this is not the full reference grammar.

use std::collections::{BTreeMap, BTreeSet};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use num_bigint::BigInt;
use num_traits::{Signed, Zero};
use serde::{Deserialize, Serialize};

use crate::common::{Predicate, Row as ViewRow, SortDirection};
use crate::execution_contract::MembershipChange;
use crate::product_engine::MembershipEngine;
use crate::topic::{TopicStore, TopicSnapshot};
use crate::source::{SourceBatch, SourceCommit};
use crate::viewport::{ViewportHub, ViewportSnapshot};

const MAX_INTEGER_DIGITS: usize = 10_000;
const MAX_ABS_SCALE: i32 = 10_000;

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize)]
#[serde(transparent)]
pub struct ExactInteger(String);

impl ExactInteger {
    pub fn parse(input: impl AsRef<str>) -> Result<Self, String> {
        let input = input.as_ref();
        if input.is_empty() || input.len() > MAX_INTEGER_DIGITS + 1 {
            return Err("integer length is outside the supported bound".into());
        }
        let parsed = input
            .parse::<BigInt>()
            .map_err(|_| "invalid exact integer".to_owned())?;
        if parsed.to_string().len() > MAX_INTEGER_DIGITS + 1 {
            return Err("integer length is outside the supported bound".into());
        }
        Ok(Self(parsed.to_string()))
    }

    fn value(&self) -> BigInt {
        self.0.parse().expect("ExactInteger is canonical")
    }
}

impl<'de> Deserialize<'de> for ExactInteger {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(value).map_err(serde::de::Error::custom)
    }
}

impl Ord for ExactInteger {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.value().cmp(&other.value())
    }
}

impl PartialOrd for ExactInteger {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize)]
pub struct ExactDecimal {
    /// Exact base-ten coefficient; value = coefficient * 10^(-scale).
    coefficient: ExactInteger,
    scale: i32,
}

impl<'de> Deserialize<'de> for ExactDecimal {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Wire {
            coefficient: ExactInteger,
            scale: i32,
        }

        let wire = Wire::deserialize(deserializer)?;
        Self::new(wire.coefficient, wire.scale).map_err(serde::de::Error::custom)
    }
}

impl ExactDecimal {
    pub fn new(coefficient: ExactInteger, scale: i32) -> Result<Self, String> {
        if scale.unsigned_abs() > MAX_ABS_SCALE as u32 {
            return Err("decimal scale is outside the supported bound".into());
        }
        let mut value = coefficient.value();
        let mut normalized_scale = if value.is_zero() { 0 } else { scale };
        while normalized_scale > -MAX_ABS_SCALE && !value.is_zero() && (&value % 10u8).is_zero() {
            value /= 10u8;
            normalized_scale -= 1;
        }
        let coefficient = ExactInteger::parse(value.to_string())?;
        Ok(Self {
            coefficient,
            scale: normalized_scale,
        })
    }

    pub fn parse(input: &str) -> Result<Self, String> {
        let (mantissa, exponent) = match input.find(['e', 'E']) {
            Some(index) => {
                let exponent = input[index + 1..]
                    .parse::<i32>()
                    .map_err(|_| "invalid decimal exponent".to_owned())?;
                (&input[..index], exponent)
            }
            None => (input, 0),
        };
        let negative = mantissa.starts_with('-');
        let unsigned = mantissa.strip_prefix(['-', '+']).unwrap_or(mantissa);
        let mut parts = unsigned.split('.');
        let whole = parts.next().unwrap_or_default();
        let fraction = parts.next().unwrap_or_default();
        if parts.next().is_some()
            || (whole.is_empty() && fraction.is_empty())
            || !whole.bytes().all(|byte| byte.is_ascii_digit())
            || !fraction.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err("invalid decimal".into());
        }
        let digits = format!("{whole}{fraction}");
        if digits.len() > MAX_INTEGER_DIGITS {
            return Err("decimal coefficient exceeds the supported bound".into());
        }
        let signed = if negative {
            format!("-{digits}")
        } else {
            digits
        };
        let scale = i32::try_from(fraction.len())
            .map_err(|_| "decimal scale is outside the supported bound".to_owned())?
            .checked_sub(exponent)
            .ok_or_else(|| "decimal scale overflow".to_owned())?;
        Self::new(ExactInteger::parse(signed)?, scale)
    }

    pub fn to_string_exact(&self) -> String {
        let coefficient = self.coefficient.0.as_str();
        let negative = coefficient.starts_with('-');
        let digits = coefficient.strip_prefix('-').unwrap_or(coefficient);
        if digits == "0" {
            return "0".into();
        }
        let (whole, fraction) = if self.scale <= 0 {
            let zeros = usize::try_from(-self.scale).unwrap_or(0);
            (format!("{digits}{}", "0".repeat(zeros)), String::new())
        } else {
            let scale = self.scale as usize;
            if digits.len() > scale {
                let split = digits.len() - scale;
                (digits[..split].to_owned(), digits[split..].to_owned())
            } else {
                (
                    "0".to_owned(),
                    format!("{}{}", "0".repeat(scale - digits.len()), digits),
                )
            }
        };
        let decimal = if fraction.is_empty() {
            whole
        } else {
            format!("{whole}.{fraction}")
        };
        if negative {
            format!("-{decimal}")
        } else {
            decimal
        }
    }

    pub fn sum(values: &[Self]) -> Result<Self, String> {
        if values.is_empty() {
            return Self::new(ExactInteger::parse("0")?, 0);
        }
        let scale = values.iter().map(|value| value.scale).max().unwrap_or(0);
        let total = values
            .iter()
            .fold(BigInt::zero(), |total, value| total + value.aligned(scale));
        Self::new(ExactInteger::parse(total.to_string())?, scale)
    }

    /// Mirrors the frozen Effect BigDecimal divideUnsafe default of 100
    /// significant digits with terminal half-up rounding.
    pub fn average(values: &[Self]) -> Result<Self, String> {
        if values.is_empty() {
            return Self::new(ExactInteger::parse("0")?, 0);
        }
        let total = Self::sum(values)?;
        let signed_total = total.coefficient_value();
        let mut numerator = signed_total.abs();
        if numerator.is_zero() {
            return Self::new(ExactInteger::parse("0")?, 0);
        }
        let denominator = BigInt::from(values.len());
        let mut scale = total.scale;
        while numerator < denominator {
            numerator *= 10u8;
            scale += 1;
        }
        let mut quotient = &numerator / &denominator;
        let mut remainder = (&numerator % &denominator) * 10u8;
        let mut digits = quotient.to_string().len();
        while !remainder.is_zero() && digits < 100 {
            let next = &remainder / &denominator;
            remainder = (&remainder % &denominator) * 10u8;
            quotient = quotient * 10u8 + next;
            digits += 1;
            scale += 1;
        }
        if !remainder.is_zero() && &remainder / &denominator >= BigInt::from(5u8) {
            quotient += 1u8;
        }
        if signed_total.is_negative() {
            quotient = -quotient;
        }
        Self::new(ExactInteger::parse(quotient.to_string())?, scale)
    }

    fn coefficient_value(&self) -> BigInt {
        self.coefficient.value()
    }

    fn aligned(&self, scale: i32) -> BigInt {
        let shift = u32::try_from(scale - self.scale).expect("aligned scale is not smaller");
        self.coefficient_value() * BigInt::from(10u8).pow(shift)
    }

    pub(crate) fn sortable_token(&self) -> String {
        let coefficient = self.coefficient_value();
        if coefficient.is_zero() {
            return "1".to_owned();
        }
        let negative = coefficient.is_negative();
        let digits = coefficient.abs().to_string();
        let exponent = digits.len() as i32 - self.scale;
        let biased = (exponent + 20_000) as u32;
        if negative {
            let magnitude: String = format!("{biased:05}{digits}")
                .bytes()
                .map(|digit| char::from(b'9' - (digit - b'0')))
                .collect();
            format!("0{magnitude}:")
        } else {
            format!("2{biased:05}{digits}0")
        }
    }
}

impl Ord for ExactDecimal {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        let scale = self.scale.max(other.scale);
        self.aligned(scale).cmp(&other.aligned(scale))
    }
}

impl PartialOrd for ExactDecimal {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(tag = "state", content = "value", rename_all = "snake_case")]
pub enum OptionalString {
    Missing,
    Null,
    Value(String),
}

impl Default for OptionalString {
    fn default() -> Self {
        Self::Missing
    }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
pub struct ProductRow {
    pub id: String,
    pub category: String,
    #[serde(default)]
    pub label: OptionalString,
    pub quantity: ExactInteger,
    pub amount: ExactDecimal,
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompareOp {
    Equal,
    GreaterThan,
    GreaterThanOrEqual,
    LessThan,
    LessThanOrEqual,
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(tag = "field", content = "condition", rename_all = "snake_case")]
pub enum Condition {
    CategoryEquals(String),
    LabelEquals(String),
    LabelBlank,
    LabelNotBlank,
    Quantity { op: CompareOp, value: ExactInteger },
    Amount { op: CompareOp, value: ExactDecimal },
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(tag = "op", content = "args", rename_all = "snake_case")]
pub enum Expr {
    True,
    False,
    Condition(Condition),
    And(Vec<Expr>),
    Or(Vec<Expr>),
    Not(Box<Expr>),
}

impl Expr {
    /// Canonical supported predicate identity; not general Boolean equivalence solving.
    pub fn canonical(&self) -> Self {
        match self {
            Self::And(items) | Self::Or(items) => {
                let is_and = matches!(self, Self::And(_));
                let mut normalized = Vec::new();
                for item in items.iter().filter(|item| !item.is_empty_group()) {
                    let item = item.canonical();
                    match item {
                        Self::And(children) if is_and => normalized.extend(children),
                        Self::Or(children) if !is_and => normalized.extend(children),
                        other => normalized.push(other),
                    }
                }
                // Empty OR means unfiltered in the accepted grammar.
                if normalized.is_empty() { return Self::True; }
                if is_and && normalized.contains(&Self::False) { return Self::False; }
                if !is_and && normalized.contains(&Self::True) { return Self::True; }
                normalized.retain(|item| if is_and { item != &Self::True } else { item != &Self::False });
                normalized.sort(); normalized.dedup();
                if normalized.is_empty() { return if is_and { Self::True } else { Self::False }; }
                if normalized.len() == 1 { return normalized.pop().unwrap(); }
                if is_and { Self::And(normalized) } else { Self::Or(normalized) }
            }
            Self::Not(item) if item.is_empty_group() => Self::True,
            Self::Not(item) => match item.canonical() {
                Self::True => Self::False,
                Self::False => Self::True,
                Self::Not(inner) => *inner,
                other => Self::Not(Box::new(other)),
            },
            other => other.clone(),
        }
    }

    fn matches(&self, row: &ProductRow) -> bool {
        match self {
            Self::True => true,
            Self::False => false,
            Self::Condition(condition) => match condition {
                Condition::CategoryEquals(expected) => row.category == *expected,
                Condition::LabelEquals(expected) => {
                    row.label == OptionalString::Value(expected.clone())
                }
                Condition::LabelBlank => match &row.label {
                    OptionalString::Missing | OptionalString::Null => true,
                    OptionalString::Value(value) => value.is_empty(),
                },
                Condition::LabelNotBlank => match &row.label {
                    OptionalString::Missing | OptionalString::Null => false,
                    OptionalString::Value(value) => !value.is_empty(),
                },
                Condition::Quantity { op, value } => compare(*op, row.quantity.cmp(value)),
                Condition::Amount { op, value } => compare(*op, row.amount.cmp(value)),
            },
            // The frozen reference normalizes empty AND/OR subgroups away.
            Self::And(expressions) => expressions
                .iter()
                .filter(|expr| !expr.is_empty_group())
                .all(|expr| expr.matches(row)),
            Self::Or(expressions) => {
                let conditions = expressions
                    .iter()
                    .filter(|expr| !expr.is_empty_group())
                    .collect::<Vec<_>>();
                conditions.is_empty() || conditions.iter().any(|expr| expr.matches(row))
            }
            Self::Not(expression) if expression.is_empty_group() => true,
            Self::Not(expression) => !expression.matches(row),
        }
    }

    fn is_empty_group(&self) -> bool {
        matches!(self, Self::And(expressions) | Self::Or(expressions) if expressions.is_empty())
    }
}

fn compare(op: CompareOp, ordering: std::cmp::Ordering) -> bool {
    use std::cmp::Ordering::{Equal, Greater, Less};
    match op {
        CompareOp::Equal => ordering == Equal,
        CompareOp::GreaterThan => ordering == Greater,
        CompareOp::GreaterThanOrEqual => ordering != Less,
        CompareOp::LessThan => ordering == Less,
        CompareOp::LessThanOrEqual => ordering != Greater,
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    Ascending,
    Descending,
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Query {
    pub where_expr: Expr,
    pub direction: Direction,
    pub offset: u64,
    pub limit: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Patch<T> {
    Unchanged,
    Set { value: T },
    SetNull,
    Clear,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ProductPatch {
    pub category: Patch<String>,
    pub label: Patch<String>,
    pub quantity: Patch<ExactInteger>,
    pub amount: Patch<ExactDecimal>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case")]
pub enum ProductCommand {
    Upsert { row: ProductRow },
    Patch { id: String, patch: ProductPatch },
    Delete { id: String },
    Open { subscription: String, query: Query },
    ChangeQuery { subscription: String, query: Query },
    ChangeWindow { subscription: String, offset: u64, limit: u64 },
    Close { subscription: String },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ProductResult {
    pub subscription: String,
    pub query_generation: u64,
    pub sequence: u64,
    pub start_rank: u64,
    pub version: u64,
    pub total_rows: u64,
    pub rows: Vec<ProductRow>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
pub struct ProductCoreStats {
    pub upsert_predicate_checks: u64,
    pub delete_predicate_checks: u64,
    pub query_seed_rows_scanned: u64,
    pub final_close_rows_scanned: u64,
    pub differential_input_insertions: u64,
    pub differential_input_retractions: u64,
    pub differential_output_updates_observed: u64,
    pub consolidation_input_records: u64,
    pub consolidated_deltas_emitted: u64,
    pub shape_id_lookups: u64,
    pub ranked_index_insertions: u64,
    pub ranked_index_retractions: u64,
    pub directed_index_records_traversed: u64,
    pub directed_index_records_cloned: u64,
    pub directed_index_records_transferred: u64,
    pub directed_indexes_constructed: u64,
    pub wasm_result_rows_encoded: u64,
    pub result_calls: u64,
    pub result_rows_extracted: u64,
    pub active_subscriptions: u64,
    pub active_query_shapes: u64,
    pub retained_rows: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct GroupCountRow {
    pub category: String,
    pub count: ExactInteger,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct GroupCountResult {
    pub version: u64,
    pub total_rows: u64,
    pub groups: Vec<GroupCountRow>,
}

#[derive(Clone)]
struct QueryShape {
    id: u64,
    references: usize,
    predicate: Predicate,
    category_counts: BTreeMap<String, BigInt>,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct QueryShapeKey {
    where_expr: Expr,
}

impl From<&Query> for QueryShapeKey {
    fn from(query: &Query) -> Self {
        Self { where_expr: query.where_expr.canonical() }
    }
}


/// Single-threaded DD owner used by both the native adapter and WASM wrapper.
/// Updates evaluate each distinct active query once, then DD processes only
/// query-membership changes. Opening a new query seeds it with one bounded scan.
pub struct ProductCore {
    engine: MembershipEngine,
    topic: TopicStore,
    shapes: BTreeMap<QueryShapeKey, QueryShape>,
    shape_keys_by_id: BTreeMap<u64, QueryShapeKey>,
    subscriptions: BTreeMap<String, Query>,
    last_dirty_subscriptions: Vec<String>,
    next_shape_id: u64,
    viewport: ViewportHub,
    version: u64,
    stats: ProductCoreStats,
    terminal_failure: Option<String>,
}

impl Default for ProductCore {
    fn default() -> Self {
        Self::new()
    }
}

impl ProductCore {
    pub fn new() -> Self {
        Self {
            engine: MembershipEngine::new(),
            topic: TopicStore::default(),
            shapes: BTreeMap::new(),
            shape_keys_by_id: BTreeMap::new(),
            subscriptions: BTreeMap::new(),
            last_dirty_subscriptions: Vec::new(),
            next_shape_id: 1,
            viewport: ViewportHub::default(),
            version: 0,
            stats: ProductCoreStats::default(),
            terminal_failure: None,
        }
    }

    pub fn apply(&mut self, command: ProductCommand) -> Result<(), String> {
        if let Some(error) = &self.terminal_failure {
            return Err(format!("ProductCore is terminal after an internal failure: {error}"));
        }
        self.last_dirty_subscriptions.clear();
        self.validate_command(&command)?;
        if self.version == u64::MAX {
            return Err("ProductCore version exhausted".into());
        }
        let data_command = matches!(&command, ProductCommand::Upsert {..} | ProductCommand::Patch {..} | ProductCommand::Delete {..});
        if data_command {
            if self.topic.last_source_batch != 0 { return Err("direct data commands are disabled after source ingestion starts".into()); }
            self.topic.version.checked_add(1).ok_or("topic version exhausted")?;
        }
        let before = self.version;
        match self.apply_validated(command) {
            Ok(()) => {
                if data_command && self.version != before { self.topic.version += 1; }
                Ok(())
            },
            Err(error) => {
                self.terminal_failure = Some(error.clone());
                Err(format!("ProductCore entered terminal failure after an internal error: {error}"))
            }
        }
    }

    fn validate_command(&self, command: &ProductCommand) -> Result<(), String> {
        match command {
            ProductCommand::Upsert { row } => validate_row(row),
            ProductCommand::Patch { id, patch } => {
                if let Some(mut row) = self.topic.rows.get(id).cloned() {
                    apply_patch(&mut row, patch.clone())?;
                }
                Ok(())
            }
            ProductCommand::Delete { .. } => Ok(()),
            ProductCommand::Open { subscription, query } => {
                validate_query(query)?;
                if self.subscriptions.contains_key(subscription) {
                    return Err(format!("subscription {subscription} is already open"));
                }
                let key = QueryShapeKey::from(query);
                if !self.shapes.contains_key(&key) {
                    self.next_shape_id.checked_add(1).ok_or("query identity overflow")?;
                }
                Ok(())
            }
            ProductCommand::ChangeQuery { subscription, query } => {
                validate_query(query)?;
                if !self.subscriptions.contains_key(subscription) {
                    return Err(format!("subscription {subscription} is not open"));
                }
                let key = QueryShapeKey::from(query);
                if !self.shapes.contains_key(&key) {
                    self.next_shape_id.checked_add(1).ok_or("query identity overflow")?;
                }
                Ok(())
            }
            ProductCommand::ChangeWindow { subscription, offset, limit } => {
                let _ = checked_window(*offset, *limit)?;
                if !self.subscriptions.contains_key(subscription) {
                    return Err(format!("subscription {subscription} is not open"));
                }
                Ok(())
            }
            ProductCommand::Close { subscription } => {
                if !self.subscriptions.contains_key(subscription) {
                    return Err(format!("subscription {subscription} is not open"));
                }
                Ok(())
            }
        }
    }

    fn apply_validated(&mut self, command: ProductCommand) -> Result<(), String> {
        let mut changed = false;
        let mut dirty_shapes = BTreeSet::new();
        let mut dirty_subscriptions = BTreeSet::new();
        self.last_dirty_subscriptions.clear();
        match command {
            ProductCommand::Upsert { row } => {
                let (did_change, dirty) = self.upsert(row)?;
                changed = did_change;
                dirty_shapes.extend(dirty);
            }
            ProductCommand::Patch { id, patch } => {
                if let Some(mut row) = self.topic.rows.get(&id).cloned() {
                    apply_patch(&mut row, patch)?;
                    let (did_change, dirty) = self.upsert(row)?;
                    changed = did_change;
                    dirty_shapes.extend(dirty);
                }
            }
            ProductCommand::Delete { id } => {
                let (did_change, dirty) = self.delete(&id)?;
                changed = did_change;
                dirty_shapes.extend(dirty);
            }
            ProductCommand::Open {
                subscription,
                query,
            } => {
                self.open(subscription.clone(), query)?;
                dirty_subscriptions.insert(subscription);
                changed = true;
            }
            ProductCommand::ChangeQuery {
                subscription,
                query,
            } => {
                validate_query(&query)?;
                let current = self
                    .subscriptions
                    .get(&subscription)
                    .ok_or_else(|| format!("subscription {subscription} is not open"))?;
                if current != &query {
                    let key = QueryShapeKey::from(&query);
                    if !self.shapes.contains_key(&key) {
                        self.next_shape_id.checked_add(1).ok_or("query identity overflow")?;
                    }
                    self.close(&subscription)?;
                    self.open(subscription.clone(), query)?;
                    dirty_subscriptions.insert(subscription);
                    changed = true;
                }
            }
            ProductCommand::ChangeWindow { subscription, offset, limit } => {
                let (offset, limit) = checked_window(offset, limit)?;
                let current = self.subscriptions.get(&subscription)
                    .ok_or_else(|| format!("subscription {subscription} is not open"))?;
                if current.offset == offset as u64 && current.limit == limit as u64 {
                    return Ok(());
                }
                self.viewport.change_window(&subscription, offset, limit)?;
                if let Some(query) = self.subscriptions.get_mut(&subscription) {
                    query.offset = offset as u64;
                    query.limit = limit as u64;
                }
                dirty_subscriptions.insert(subscription);
                changed = true;
            }
            ProductCommand::Close { subscription } => {
                self.close(&subscription)?;
                changed = true;
            }
        }
        if changed {
            if let Err(error) = self.complete_boundary() {
                self.terminal_failure = Some(error.clone());
                return Err(format!("ProductCore entered terminal failure during completion: {error}"));
            }
            self.version = self.version.checked_add(1).ok_or("version overflow")?;
            for (subscription, query) in &self.subscriptions {
                if dirty_shapes.contains(&QueryShapeKey::from(query)) {
                    dirty_subscriptions.insert(subscription.clone());
                }
            }
            self.last_dirty_subscriptions = dirty_subscriptions.into_iter().collect();
        }
        Ok(())
    }

    /// Load canonical retained truth before acquiring derived query state.
    pub fn from_snapshot(snapshot: TopicSnapshot) -> Result<Self, String> {
        let topic = TopicStore::from_snapshot(snapshot)?;
        let mut core = Self::new();
        core.topic = topic;
        Ok(core)
    }

    pub fn topic_snapshot(&self) -> TopicSnapshot { self.topic.snapshot() }
    pub fn topic(&self) -> &TopicStore { &self.topic }
    pub fn product_version(&self) -> u64 { self.version }

    /// Validate the entire bounded source batch before touching either owner.
    /// One accepted source batch publishes at most one completed product boundary.
    pub fn commit_source(&mut self, batch: SourceBatch) -> Result<SourceCommit, String> {
        if self.terminal_failure.is_some() { return Err("ProductCore is terminal".into()); }
        self.last_dirty_subscriptions.clear();
        let Some(prepared) = self.topic.prepare(batch)? else {
            return Ok(SourceCommit { duplicate: true, topic_version: self.topic.version, product_version: self.version, dirty_subscriptions: Vec::new() });
        };
        self.version.checked_add(1).ok_or("product version exhausted")?;
        let mut dirty = BTreeSet::new();
        let mut changed = false;
        let execution = (|| -> Result<(), String> {
            for (id, row) in prepared.rows {
                let (did_change, affected) = match row {
                    Some(row) => self.upsert(row)?,
                    None => self.delete(&id)?,
                };
                changed |= did_change;
                dirty.extend(affected);
            }
            if changed { self.complete_boundary()?; }
            Ok(())
        })();
        if let Err(error) = execution {
            self.terminal_failure = Some(error.clone());
            return Err(format!("terminal source commit: {error}"));
        }
        self.topic.version += 1;
        self.topic.last_source_batch = prepared.sequence;
        self.topic.offsets = prepared.offsets;
        self.topic.recent_batches.push_back((prepared.sequence, prepared.fingerprint));
        if self.topic.recent_batches.len() > crate::topic::REPLAY_BATCHES { self.topic.recent_batches.pop_front(); }
        if changed {
            self.version += 1;
            self.last_dirty_subscriptions = self.subscriptions.iter()
                .filter(|(_, query)| dirty.contains(&QueryShapeKey::from(*query)))
                .map(|(id, _)| id.clone()).collect();
        }
        Ok(SourceCommit { duplicate: false, topic_version: self.topic.version, product_version: self.version,
            dirty_subscriptions: self.last_dirty_subscriptions.clone() })
    }

    pub fn apply_json(&mut self, input: &str) -> Result<(), String> {
        let command: ProductCommand = serde_json::from_str(input)
            .map_err(|error| format!("invalid typed command: {error}"))?;
        self.apply(command)
    }

    pub fn result(&mut self, subscription: &str) -> Option<ProductResult> {
        if self.terminal_failure.is_some() { return None; }
        let snapshot: ViewportSnapshot = self.viewport.snapshot(subscription)?;
        let rows = snapshot
            .rows
            .iter()
            .filter_map(|view_row| self.topic.rows.get(&view_row.id).cloned())
            .collect::<Vec<_>>();
        self.stats.result_calls += 1;
        self.stats.result_rows_extracted += rows.len() as u64;
        Some(ProductResult {
            subscription: snapshot.subscriber,
            query_generation: snapshot.query_generation,
            sequence: snapshot.sequence,
            start_rank: snapshot.start_rank as u64,
            version: self.version,
            total_rows: snapshot.total_rows as u64,
            rows,
        })
    }

    /// Bounded owned extraction. Reject before cloning any product row. The estimate
    /// includes worst-case JSON escaping (six bytes per input byte), and fixed fields.
    pub fn bounded_result(&mut self, subscription: &str, max_rows: usize, max_bytes: usize) -> Result<(ProductResult, usize), String> {
        if let Some(e) = &self.terminal_failure { return Err(e.clone()); }
        let snapshot = self.viewport.snapshot_bounded(subscription, max_rows)?;
        let mut bytes = subscription.len().checked_mul(6).and_then(|n| n.checked_add(512)).ok_or("result size overflow")?;
        for view_row in &snapshot.rows {
            let row = self.topic.rows.get(&view_row.id).ok_or("missing canonical row")?;
            let label = match &row.label { OptionalString::Value(s) => s.len(), _ => 0 };
            let strings = [row.id.len(), row.category.len(), label, row.quantity.0.len(), row.amount.coefficient.0.len()];
            for n in strings { bytes = bytes.checked_add(n.checked_mul(6).ok_or("result size overflow")?).ok_or("result size overflow")?; }
            bytes = bytes.checked_add(256).ok_or("result size overflow")?;
            if bytes > max_bytes { return Err("result byte budget; use a viewport".into()); }
        }
        if bytes > max_bytes { return Err("result byte budget; use a viewport".into()); }
        let rows = snapshot.rows.iter().map(|r| self.topic.rows[&r.id].clone()).collect::<Vec<_>>();
        self.stats.result_calls += 1;
        self.stats.result_rows_extracted += rows.len() as u64;
        Ok((ProductResult { subscription: snapshot.subscriber, query_generation: snapshot.query_generation,
            sequence: snapshot.sequence, start_rank: snapshot.start_rank as u64, version: self.version,
            total_rows: snapshot.total_rows as u64, rows }, bytes))
    }

    /// Evaluate a temporary native subscription before committing the caller's query
    /// lifetime. Rejected resource admission leaves the prior visible query, version,
    /// generation and acquisition unchanged. Internal shape/generation counters may advance.
    pub fn preflight_query_command(&mut self, command: &ProductCommand, rows: usize, bytes: usize) -> Result<(), String> {
        let query = match command {
            ProductCommand::Open { subscription, query } => {
                if self.subscriptions.contains_key(subscription) { return Err("subscription already open".into()); }
                query.clone()
            }
            ProductCommand::ChangeQuery { subscription, query } => {
                if !self.subscriptions.contains_key(subscription) { return Err("missing subscription".into()); }
                query.clone()
            }
            ProductCommand::ChangeWindow { subscription, offset, limit } => {
                let mut q = self.subscriptions.get(subscription).ok_or("missing subscription")?.clone();
                q.offset = *offset; q.limit = *limit; q
            }
            ProductCommand::Close { .. } => return Ok(()),
            _ => return Err("query command required".into()),
        };
        let temporary = "\0native-budget-preflight";
        self.open(temporary.into(), query)?;
        if let Err(e) = self.complete_boundary() { self.terminal_failure = Some(e.clone()); return Err(e); }
        let admitted = self.bounded_result(temporary, rows, bytes).map(|_| ());
        if let Err(e) = self.close(temporary).and_then(|_| self.complete_boundary()) { self.terminal_failure = Some(e.clone()); return Err(e); }
        admitted
    }

    pub fn stats(&self) -> ProductCoreStats {
        let mut stats = self.stats.clone();
        stats.active_subscriptions = self.subscriptions.len() as u64;
        stats.active_query_shapes = self.shapes.len() as u64;
        stats.retained_rows = self.topic.rows.len() as u64;
        stats.directed_index_records_traversed = self.viewport.directed_index_records_traversed;
        stats.directed_index_records_cloned = self.viewport.directed_index_records_cloned;
        stats.directed_index_records_transferred = self.viewport.directed_index_records_transferred;
        stats.directed_indexes_constructed = self.viewport.directed_indexes_constructed;
        stats
    }

    pub fn record_result_encoded(&mut self, rows: usize) {
        self.stats.wasm_result_rows_encoded += rows as u64;
    }

    pub fn last_dirty_subscriptions(&self) -> &[String] {
        &self.last_dirty_subscriptions
    }

    pub fn terminal_failure(&self) -> Option<&str> {
        self.terminal_failure.as_deref()
    }

    /// One grouped aggregate path: filtered rows grouped by category with
    /// exact bigint counts, maintained from Differential membership deltas.
    pub fn grouped_count_by_category(&self, subscription: &str) -> Option<GroupCountResult> {
        let query = self.subscriptions.get(subscription)?;
        let shape = self.shapes.get(&QueryShapeKey::from(query))?;
        let groups = shape
            .category_counts
            .iter()
            .filter(|(_, count)| !count.is_zero())
            .map(|(category, count)| {
                Ok(GroupCountRow {
                    category: category.clone(),
                    count: ExactInteger::parse(count.to_string())?,
                })
            })
            .collect::<Result<Vec<_>, String>>()
            .ok()?;
        Some(GroupCountResult {
            version: self.version,
            total_rows: groups.len() as u64,
            groups,
        })
    }

    pub fn retained_rows(&self) -> usize {
        self.topic.rows.len()
    }

    fn upsert(&mut self, row: ProductRow) -> Result<(bool, BTreeSet<QueryShapeKey>), String> {
        validate_row(&row)?;
        if self.topic.rows.get(&row.id) == Some(&row) {
            return Ok((false, BTreeSet::new()));
        }
        let old = self.topic.rows.get(&row.id).cloned();
        let mut dirty = BTreeSet::new();
        let shape_ids = self
            .shapes
            .iter()
            .map(|(query, shape)| (query.clone(), shape.id))
            .collect::<Vec<_>>();
        for (shape_key, shape_id) in &shape_ids {
            let old_matches = old.as_ref().map(|row| shape_key.where_expr.matches(row)).unwrap_or(false);
            let new_matches = shape_key.where_expr.matches(&row);
            self.stats.upsert_predicate_checks += u64::from(old.is_some()) + 1;
            if old_matches || new_matches {
                dirty.insert(shape_key.clone());
            }
            if old_matches {
                let old_row = old.as_ref().unwrap();
                self.push_membership(*shape_id, old_row, -1)?;
            }
            if new_matches {
                self.push_membership(*shape_id, &row, 1)?;
            }
        }
        self.topic.rows.insert(row.id.clone(), row);
        Ok((true, dirty))
    }

    fn delete(&mut self, id: &str) -> Result<(bool, BTreeSet<QueryShapeKey>), String> {
        let Some(old) = self.topic.rows.get(id).cloned() else {
            return Ok((false, BTreeSet::new()));
        };
        let mut dirty = BTreeSet::new();
        let shapes = self
            .shapes
            .iter()
            .map(|(query, shape)| (query.clone(), shape.id))
            .collect::<Vec<_>>();
        for (shape_key, shape_id) in shapes {
            self.stats.delete_predicate_checks += 1;
            if shape_key.where_expr.matches(&old) {
                self.push_membership(shape_id, &old, -1)?;
                dirty.insert(shape_key);
            }
        }
        self.topic.rows.remove(id);
        Ok((true, dirty))
    }

    fn open(&mut self, subscription: String, query: Query) -> Result<(), String> {
        validate_query(&query)?;
        if self.subscriptions.contains_key(&subscription) {
            return Err(format!("subscription {subscription} is already open"));
        }
        let shape_key = QueryShapeKey::from(&query);
        let (shape, is_new) = if let Some(shape) = self.shapes.get_mut(&shape_key) {
            shape.references += 1;
            (shape.clone(), false)
        } else {
            let id = self.next_shape_id;
            self.next_shape_id = self
                .next_shape_id
                .checked_add(1)
                .ok_or("query identity overflow")?;
            let predicate = shape_predicate(id);
            let shape = QueryShape {
                id,
                references: 1,
                predicate,
                category_counts: BTreeMap::new(),
            };
            self.shape_keys_by_id.insert(id, shape_key.clone());
            self.shapes.insert(shape_key, shape.clone());
            (shape, true)
        };
        let (offset, limit) = checked_window(query.offset, query.limit)?;
        self.viewport.open_window(
            subscription.clone(),
            shape.predicate.clone(),
            match query.direction {
                Direction::Ascending => SortDirection::Ascending,
                Direction::Descending => SortDirection::Descending,
            },
            offset,
            limit,
        )?;
        self.subscriptions.insert(subscription, query.clone());
        if is_new {
            // Query acquisition builds current membership once; steady updates do not rescan.
            self.stats.query_seed_rows_scanned += self.topic.rows.len() as u64;
            let rows = self
                .topic.rows
                .values()
                .filter(|row| query.where_expr.matches(row))
                .cloned()
                .collect::<Vec<_>>();
            for row in rows {
                self.push_membership(shape.id, &row, 1)?;
            }
        }
        Ok(())
    }

    fn close(&mut self, subscription: &str) -> Result<(), String> {
        let query = self
            .subscriptions
            .get(subscription)
            .cloned()
            .ok_or_else(|| format!("subscription {subscription} is not open"))?;
        self.viewport.close(subscription)?;
        self.subscriptions.remove(subscription);
        let key = QueryShapeKey::from(&query);
        let shape = self.shapes.get(&key).cloned();
        if let Some(shape) = shape {
            if shape.references == 1 {
                self.stats.final_close_rows_scanned += self.topic.rows.len() as u64;
                let matched = self.topic.rows.values().filter(|row| query.where_expr.matches(row)).cloned().collect::<Vec<_>>();
                for row in &matched {
                    self.push_membership(shape.id, row, -1)?;
                }
                self.shapes.remove(&key);
                self.shape_keys_by_id.remove(&shape.id);
            } else if let Some(shape) = self.shapes.get_mut(&key) {
                shape.references -= 1;
            }
        }
        Ok(())
    }

    fn push_membership(&mut self, shape: u64, row: &ProductRow, diff: isize) -> Result<(), String> {
        let order = view_payload(row);
        self.engine.apply_batch([MembershipChange { shape, id: row.id.clone(), order, weight: diff }]);
        if diff > 0 {
            self.stats.differential_input_insertions += 1;
        } else {
            self.stats.differential_input_retractions += 1;
        }
        Ok(())
    }

    fn complete_boundary(&mut self) -> Result<(), String> {
        let completion = self.engine.complete()?;
        let completed = completion.changes;
        self.stats.differential_output_updates_observed += completed.len() as u64;
        self.stats.consolidation_input_records += completed.len() as u64;
        let mut consolidated = BTreeMap::<(u64, String, String), isize>::new();
        for MembershipChange { shape, id, order, weight: diff } in completed {
            *consolidated.entry((shape, id, order)).or_default() += diff;
        }
        let mut deltas = consolidated.into_iter().collect::<Vec<_>>();
        self.stats.consolidated_deltas_emitted += deltas.iter().filter(|(_, diff)| *diff != 0).count() as u64;
        // Retractions precede insertions so a replacement with the same ID is atomic
        // with respect to the shared order-statistic index.
        deltas.sort_by_key(|(_, diff)| *diff > 0);
        for ((shape_id, id, order), diff) in deltas {
            if diff == 0 {
                continue;
            }
            self.stats.shape_id_lookups += 1;
            if let Some(shape_key) = self.shape_keys_by_id.get(&shape_id)
                && let Some(shape) = self.shapes.get_mut(shape_key)
            {
                let category = payload_category(&order)?;
                let count = shape.category_counts.entry(category.clone()).or_default();
                *count += diff;
                if count.is_zero() {
                    shape.category_counts.remove(&category);
                }
                let rank_updates = self.viewport.apply_predicate_membership_delta(
                    &shape.predicate,
                    ViewRow {
                        id,
                        sort_key: order.split('\0').next().unwrap_or_default().to_owned(),
                        payload: order,
                    },
                    diff,
                )?;
                if diff > 0 {
                    self.stats.ranked_index_insertions += rank_updates as u64;
                } else {
                    self.stats.ranked_index_retractions += rank_updates as u64;
                }
            }
        }
        self.viewport.complete_boundary()?;
        Ok(())
    }
}

fn shape_predicate(id: u64) -> Predicate {
    Predicate::PayloadIn(BTreeSet::from([format!("shape:{id}")]))
}

fn view_payload(row: &ProductRow) -> String {
    format!("{}\0{}", row.amount.sortable_token(), URL_SAFE_NO_PAD.encode(row.category.as_bytes()))
}

fn payload_category(payload: &str) -> Result<String, String> {
    let encoded = payload
        .rsplit_once('\0')
        .map(|(_, value)| value)
        .ok_or_else(|| "Differential membership is missing its group key".to_owned())?;
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| "Differential membership has an invalid group key".to_owned())?;
    String::from_utf8(bytes).map_err(|_| "Differential group key is not valid UTF-8".into())
}

fn checked_window(offset: u64, limit: u64) -> Result<(usize, usize), String> {
    let offset = usize::try_from(offset).map_err(|_| "offset exceeds addressable range")?;
    let limit = usize::try_from(limit).map_err(|_| "limit exceeds addressable range")?;
    offset.checked_add(limit).ok_or("query window overflow")?;
    Ok((offset, limit))
}

fn validate_query(query: &Query) -> Result<(), String> {
    checked_window(query.offset, query.limit)?;
    Ok(())
}

pub(crate) fn validate_row(row: &ProductRow) -> Result<(), String> {
    if row.id.is_empty() {
        return Err("canonical row ID must not be empty".into());
    }
    if row.id.len() > 512
        || row.category.len() > 256
        || matches!(&row.label, OptionalString::Value(value) if value.len() > 4096)
    {
        return Err("row string field exceeds its supported bound".into());
    }
    Ok(())
}

fn apply_patch(row: &mut ProductRow, patch: ProductPatch) -> Result<(), String> {
    match patch.category {
        Patch::Unchanged => {}
        Patch::Set { value } => row.category = value,
        Patch::SetNull => return Err("required category cannot be null".into()),
        Patch::Clear => return Err("required category cannot be cleared".into()),
    }
    match patch.label {
        Patch::Unchanged => {}
        Patch::Set { value } => row.label = OptionalString::Value(value),
        Patch::SetNull => row.label = OptionalString::Null,
        Patch::Clear => row.label = OptionalString::Missing,
    }
    match patch.quantity {
        Patch::Unchanged => {}
        Patch::Set { value } => row.quantity = value,
        Patch::SetNull => return Err("required quantity cannot be null".into()),
        Patch::Clear => return Err("required quantity cannot be cleared".into()),
    }
    match patch.amount {
        Patch::Unchanged => {}
        Patch::Set { value } => row.amount = value,
        Patch::SetNull => return Err("required amount cannot be null".into()),
        Patch::Clear => return Err("required amount cannot be cleared".into()),
    }
    validate_row(row)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(
        id: &str,
        category: &str,
        quantity: &str,
        amount: &str,
        label: Option<&str>,
    ) -> ProductRow {
        ProductRow {
            id: id.into(),
            category: category.into(),
            label: label.map_or(OptionalString::Missing, |value| {
                OptionalString::Value(value.to_owned())
            }),
            quantity: ExactInteger::parse(quantity).unwrap(),
            amount: ExactDecimal::parse(amount).unwrap(),
        }
    }

    #[test]
    fn canonical_boolean_forms_preserve_empty_group_semantics() {
        let atoms = vec![Expr::True, Expr::False, Expr::And(vec![]), Expr::Or(vec![]),
            Expr::Condition(Condition::CategoryEquals("a".into()))];
        let mut forms = atoms.clone();
        for a in &atoms { for b in &atoms {
            forms.push(Expr::And(vec![a.clone(),b.clone()]));
            forms.push(Expr::Or(vec![a.clone(),b.clone()]));
        }}
        let samples = [row("a","a","1","-1.21",None),row("b","b","2","0",Some(""))];
        for a in &forms { for b in &atoms {
            for expr in [Expr::And(vec![a.clone(),b.clone()]), Expr::Or(vec![a.clone(),b.clone()]), Expr::Not(Box::new(a.clone()))] {
                let canonical = expr.canonical();
                assert_eq!(canonical.canonical(),canonical);
                for row in &samples { assert_eq!(expr.matches(row),canonical.matches(row),"{expr:?} -> {canonical:?}"); }
            }
        }}
    }

    #[derive(Clone)]
    struct OracleDecimal { coefficient: BigInt, scale: i32 }

    fn oracle_decimal(input: &str) -> OracleDecimal {
        let negative = input.starts_with('-');
        let unsigned = input.trim_start_matches(['-', '+']);
        let mut parts = unsigned.split('.');
        let whole = parts.next().unwrap();
        let fraction = parts.next().unwrap_or_default();
        assert!(parts.next().is_none());
        let digits = format!("{whole}{fraction}");
        let coefficient = digits.parse::<BigInt>().unwrap();
        OracleDecimal {
            coefficient: if negative { -coefficient } else { coefficient },
            scale: fraction.len() as i32,
        }
    }

    fn oracle_decimal_cmp(left: &OracleDecimal, right: &OracleDecimal) -> std::cmp::Ordering {
        let scale = left.scale.max(right.scale);
        let lhs = &left.coefficient * BigInt::from(10u8).pow((scale - left.scale) as u32);
        let rhs = &right.coefficient * BigInt::from(10u8).pow((scale - right.scale) as u32);
        lhs.cmp(&rhs)
    }

    fn query(where_expr: Expr, offset: u64, limit: u64) -> Query {
        Query {
            where_expr,
            direction: Direction::Ascending,
            offset,
            limit,
        }
    }

    #[test]
    fn exact_values_canonicalize_and_compare_without_float_conversion() {
        let lower = ExactInteger::parse("9007199254740992").unwrap();
        let upper = ExactInteger::parse("9007199254740993").unwrap();
        assert!(lower < upper);
        assert_eq!(ExactInteger::parse("+00042").unwrap().0, "42");
        assert!(serde_json::from_str::<ExactInteger>("\"1.5\"").is_err());
        assert!(
            serde_json::from_str::<ExactDecimal>(r#"{"coefficient":"1","scale":10001}"#).is_err()
        );
        assert_eq!(
            ExactDecimal::parse("0.10").unwrap(),
            ExactDecimal::parse("1e-1").unwrap()
        );
        assert!(
            ExactDecimal::parse("9007199254740992.6").unwrap()
                > ExactDecimal::parse("9007199254740992.5").unwrap()
        );
        assert!(ExactDecimal::parse("-0.02").unwrap() < ExactDecimal::parse("-0.01").unwrap());
        let decimals = [
            ExactDecimal::parse("0.1").unwrap(),
            ExactDecimal::parse("0.2").unwrap(),
        ];
        assert_eq!(
            ExactDecimal::sum(&decimals).unwrap().to_string_exact(),
            "0.3"
        );
        assert_eq!(
            ExactDecimal::average(&decimals).unwrap().to_string_exact(),
            "0.15"
        );
        let third = ExactDecimal::average(&[
            ExactDecimal::parse("1").unwrap(),
            ExactDecimal::parse("0").unwrap(),
            ExactDecimal::parse("0").unwrap(),
        ])
        .unwrap();
        assert_eq!(third.to_string_exact().len(), 102);
        assert!(third.to_string_exact().starts_with("0.3333333333"));
    }

    #[test]
    fn actual_ranked_results_match_independent_exact_sort_oracle_in_both_directions() {
        let values = [
            ("negative-one", "-1"),
            ("negative-one-point-zero", "-1.0"),
            ("negative-one-point-zero-one", "-1.01"),
            ("negative-one-point-zero-zero-one", "-1.001"),
            ("negative-zero", "-0.000"),
            ("zero", "0"),
            ("positive-one", "1"),
            ("positive-one-point-zero", "1.0"),
            ("positive-one-point-zero-zero", "1.00"),
            ("positive-one-point-zero-one", "1.01"),
            ("large-low", "9007199254740992.5"),
            ("large-high", "9007199254740992.6"),
            ("tiny", "0.0000000000000000000001"),
            ("negative-tiny", "-0.0000000000000000000001"),
        ];
        let mut core = ProductCore::new();
        for (id, amount) in values {
            core.apply(ProductCommand::Upsert { row: row(id, "x", "1", amount, None) }).unwrap();
        }
        for direction in [Direction::Ascending, Direction::Descending] {
            let sub = format!("sort-{direction:?}");
            let mut q = query(Expr::True, 0, 100);
            q.direction = direction;
            core.apply(ProductCommand::Open { subscription: sub.clone(), query: q }).unwrap();
            let expected = {
                let mut items = values.map(|(id, amount)| (id, oracle_decimal(amount))).to_vec();
                items.sort_by(|(left_id, left), (right_id, right)| {
                    let amount = oracle_decimal_cmp(left, right);
                    let directed = if direction == Direction::Ascending { amount } else { amount.reverse() };
                    directed.then_with(|| left_id.cmp(right_id))
                });
                items.into_iter().map(|(id, _)| id).collect::<Vec<_>>()
            };
            let actual = core.result(&sub).unwrap().rows.into_iter().map(|row| row.id).collect::<Vec<_>>();
            assert_eq!(actual, expected, "ranked result for {direction:?}");
        }

        let token = |value: &str| ExactDecimal::parse(value).unwrap().sortable_token();
        for left in values.map(|(_, amount)| amount) {
            for right in values.map(|(_, amount)| amount) {
                let expected = oracle_decimal_cmp(&oracle_decimal(left), &oracle_decimal(right));
                assert_eq!(token(left).cmp(&token(right)), expected, "token order: {left} vs {right}");
                assert_eq!(token(left).cmp(&token(right)), token(right).cmp(&token(left)).reverse());
            }
        }
        for a in values.map(|(_, amount)| amount) {
            for b in values.map(|(_, amount)| amount) {
                for c in values.map(|(_, amount)| amount) {
                    if oracle_decimal_cmp(&oracle_decimal(a), &oracle_decimal(b)) != std::cmp::Ordering::Greater
                        && oracle_decimal_cmp(&oracle_decimal(b), &oracle_decimal(c)) != std::cmp::Ordering::Greater
                    {
                        assert_ne!(token(a).cmp(&token(c)), std::cmp::Ordering::Greater, "transitivity {a} <= {b} <= {c}");
                    }
                }
            }
        }
        assert_eq!(token("1"), token("1.0"));
        assert_eq!(token("1.0"), token("1.00"));
        let boundary_small = ExactDecimal::new(ExactInteger::parse("1").unwrap(), 10_000).unwrap();
        let boundary_large = ExactDecimal::new(ExactInteger::parse("1").unwrap(), -10_000).unwrap();
        assert!(boundary_small.sortable_token() < token("0.0000000000000000000001"));
        assert!(boundary_large.sortable_token() > token("9007199254740992.6"));

        core.apply(ProductCommand::Close { subscription: "sort-Ascending".into() }).unwrap();
        core.apply(ProductCommand::Close { subscription: "sort-Descending".into() }).unwrap();
        core.apply(ProductCommand::Upsert { row: row("positive-one", "x", "1", "100", None) }).unwrap();
        core.apply(ProductCommand::Delete { id: "positive-one".into() }).unwrap();
        core.apply(ProductCommand::Upsert { row: row("positive-one", "x", "1", "1.00", None) }).unwrap();
        core.apply(ProductCommand::Open { subscription: "reinsert".into(), query: query(Expr::True, 0, 100) }).unwrap();
        let actual = core.result("reinsert").unwrap().rows.into_iter().map(|row| row.id).collect::<Vec<_>>();
        let mut expected = values.iter().map(|(id, _)| (*id).to_owned()).collect::<Vec<_>>();
        expected.sort_by(|left, right| {
            let a = values.iter().find(|(id, _)| *id == left).unwrap().1;
            let b = values.iter().find(|(id, _)| *id == right).unwrap().1;
            oracle_decimal_cmp(&oracle_decimal(a), &oracle_decimal(b)).then_with(|| left.cmp(right))
        });
        assert_eq!(actual, expected);
    }

    #[test]
    fn missing_null_blank_and_noop_commands_remain_distinct() {
        let mut core = ProductCore::new();
        let rows = [
            row("missing", "tools", "1", "1", None),
            ProductRow {
                id: "null".into(),
                category: "tools".into(),
                label: OptionalString::Null,
                quantity: ExactInteger::parse("1").unwrap(),
                amount: ExactDecimal::parse("1").unwrap(),
            },
            row("blank", "tools", "1", "1", Some("")),
            row("value", "tools", "1", "1", Some("present")),
        ];
        for row in rows {
            core.apply(ProductCommand::Upsert { row }).unwrap();
        }
        let version = core.version;
        core.apply(ProductCommand::Upsert {
            row: core.topic.rows.get("missing").unwrap().clone(),
        })
        .unwrap();
        core.apply(ProductCommand::Delete {
            id: "absent".into(),
        })
        .unwrap();
        assert_eq!(core.version, version);
        core.apply(ProductCommand::Open {
            subscription: "blank".into(),
            query: query(Expr::Condition(Condition::LabelBlank), 0, 10),
        })
        .unwrap();
        assert_eq!(core.result("blank").unwrap().total_rows, 3);
        core.apply(ProductCommand::ChangeQuery {
            subscription: "blank".into(),
            query: query(Expr::Not(Box::new(Expr::Or(Vec::new()))), 0, 10),
        })
        .unwrap();
        assert_eq!(core.result("blank").unwrap().total_rows, 4);
    }

    #[test]
    fn differential_core_filters_orders_patches_and_deletes_exact_rows() {
        let mut core = ProductCore::new();
        let rows = [
            row(
                "id-b",
                "tools",
                "9007199254740993",
                "9007199254740992.6",
                Some("B"),
            ),
            row(
                "id-a",
                "tools",
                "9007199254740992",
                "9007199254740992.5",
                Some("A"),
            ),
            row("id-c", "food", "3", "0.1", None),
        ];
        for row in rows {
            core.apply(ProductCommand::Upsert { row }).unwrap();
        }
        let filter = Expr::And(vec![
            Expr::Condition(Condition::CategoryEquals("tools".into())),
            Expr::Condition(Condition::Quantity {
                op: CompareOp::GreaterThan,
                value: ExactInteger::parse("9007199254740992").unwrap(),
            }),
        ]);
        core.apply(ProductCommand::Open {
            subscription: "exact-filter".into(),
            query: query(filter, 0, 10),
        })
        .unwrap();
        let initial = core.result("exact-filter").unwrap();
        assert_eq!(initial.total_rows, 1);
        assert_eq!(
            initial.rows,
            vec![row(
                "id-b",
                "tools",
                "9007199254740993",
                "9007199254740992.6",
                Some("B")
            )]
        );
        assert_eq!(
            core.grouped_count_by_category("exact-filter")
                .unwrap()
                .groups,
            vec![GroupCountRow {
                category: "tools".into(),
                count: ExactInteger::parse("1").unwrap(),
            }]
        );

        let patch = ProductPatch {
            category: Patch::Unchanged,
            label: Patch::Clear,
            quantity: Patch::Set {
                value: ExactInteger::parse("9007199254740991").unwrap(),
            },
            amount: Patch::Unchanged,
        };
        core.apply(ProductCommand::Patch {
            id: "id-b".into(),
            patch,
        })
        .unwrap();
        assert_eq!(core.result("exact-filter").unwrap().total_rows, 0);
        assert!(
            core.grouped_count_by_category("exact-filter")
                .unwrap()
                .groups
                .is_empty()
        );
        assert_eq!(
            core.topic.rows.get("id-b").unwrap().label,
            OptionalString::Missing
        );
        core.apply(ProductCommand::Delete {
            id: "absent".into(),
        })
        .unwrap();
        assert_eq!(core.result("exact-filter").unwrap().total_rows, 0);
    }

    #[test]
    fn decimal_order_is_stable_and_total_rows_precede_windowing() {
        let mut core = ProductCore::new();
        core.apply(ProductCommand::Upsert {
            row: row("b", "tools", "1", "0.2", None),
        })
        .unwrap();
        core.apply(ProductCommand::Upsert {
            row: row("a", "tools", "2", "0.20", None),
        })
        .unwrap();
        core.apply(ProductCommand::Upsert {
            row: row("c", "tools", "3", "0.1", None),
        })
        .unwrap();
        core.apply(ProductCommand::Open {
            subscription: "window".into(),
            query: query(Expr::True, 1, 1),
        })
        .unwrap();
        let result = core.result("window").unwrap();
        assert_eq!(result.total_rows, 3);
        assert_eq!(
            result
                .rows
                .iter()
                .map(|row| row.id.as_str())
                .collect::<Vec<_>>(),
            vec!["a"]
        );
    }

    #[test]
    fn mutation_path_checks_active_shapes_without_scanning_retained_rows() {
        let mut core = ProductCore::new();
        for index in 0..5 {
            core.apply(ProductCommand::Upsert {
                row: row(&format!("seed-{index}"), if index % 2 == 0 { "tools" } else { "food" }, "1", &format!("{index}.5"), None),
            }).unwrap();
        }
        let query = query(Expr::Condition(Condition::CategoryEquals("tools".into())), 0, 3);
        core.apply(ProductCommand::Open { subscription: "first".into(), query: query.clone() }).unwrap();
        assert_eq!(core.stats().query_seed_rows_scanned, 5);
        core.apply(ProductCommand::Open { subscription: "shared".into(), query }).unwrap();
        assert_eq!(core.stats().query_seed_rows_scanned, 5, "a shared query shape does not reseed retained rows");

        let checks = core.stats().upsert_predicate_checks;
        let inputs = core.stats().differential_input_insertions + core.stats().differential_input_retractions;
        core.apply(ProductCommand::Upsert { row: row("new-food", "food", "2", "6", None) }).unwrap();
        assert_eq!(core.stats().upsert_predicate_checks - checks, 1);
        assert_eq!(core.stats().differential_input_insertions + core.stats().differential_input_retractions, inputs);
        let output = core.stats().differential_output_updates_observed;
        let ranked = core.stats().ranked_index_insertions + core.stats().ranked_index_retractions;
        let shape_lookups = core.stats().shape_id_lookups;
        core.apply(ProductCommand::Upsert { row: row("new-tool", "tools", "2", "7", None) }).unwrap();
        assert_eq!(core.stats().upsert_predicate_checks - checks, 2);
        assert_eq!(core.stats().differential_input_insertions + core.stats().differential_input_retractions - inputs, 1);
        assert_eq!(core.stats().differential_output_updates_observed - output, 1);
        assert_eq!(core.stats().ranked_index_insertions + core.stats().ranked_index_retractions - ranked, 1);
        assert_eq!(core.stats().shape_id_lookups - shape_lookups, 1);
        core.apply(ProductCommand::Close { subscription: "first".into() }).unwrap();
        assert_eq!(core.stats().final_close_rows_scanned, 0, "shared shape survives its first subscriber close");
        core.apply(ProductCommand::Close { subscription: "shared".into() }).unwrap();
        assert_eq!(core.stats().final_close_rows_scanned, 7, "final shape close scans retained rows exactly once");
        assert_eq!(core.stats().active_query_shapes, 0);
        assert_eq!(core.stats().active_subscriptions, 0);
    }

    #[test]
    fn window_changes_and_validation_failures_are_atomic_and_recoverable() {
        let mut core = ProductCore::new();
        for index in 0..10 {
            core.apply(ProductCommand::Upsert { row: row(&format!("p{index}"), "x", "1", &index.to_string(), None) }).unwrap();
        }
        let original = query(Expr::True, 0, 3);
        core.apply(ProductCommand::Open { subscription: "window".into(), query: original.clone() }).unwrap();
        let opened = core.result("window").unwrap();
        assert_eq!(opened.rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["p0", "p1", "p2"]);

        core.apply(ProductCommand::ChangeWindow { subscription: "window".into(), offset: 0, limit: 0 }).unwrap();
        let empty = core.result("window").unwrap();
        assert_eq!(empty.rows.len(), 0);
        assert_eq!(empty.total_rows, 10);
        assert_eq!(empty.start_rank, 0);
        assert!(empty.sequence > opened.sequence);
        core.apply(ProductCommand::Upsert { row: row("p10", "x", "1", "10", None) }).unwrap();
        assert_eq!(core.result("window").unwrap().total_rows, 11);

        core.apply(ProductCommand::ChangeWindow { subscription: "window".into(), offset: 5, limit: 3 }).unwrap();
        core.apply(ProductCommand::ChangeQuery { subscription: "window".into(), query: original }).unwrap();
        let reset = core.result("window").unwrap();
        assert_eq!(reset.start_rank, 0);
        assert_eq!(reset.rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["p0", "p1", "p2"]);

        let before = core.result("window").unwrap();
        let retained = core.retained_rows();
        let rejected = core.apply(ProductCommand::ChangeWindow { subscription: "window".into(), offset: u64::MAX, limit: 1 });
        assert!(rejected.is_err());
        assert_eq!(core.result("window").unwrap(), before);
        assert_eq!(core.retained_rows(), retained);
        let rejected_patch = core.apply(ProductCommand::Patch { id: "p0".into(), patch: ProductPatch {
            category: Patch::SetNull, label: Patch::Unchanged, quantity: Patch::Unchanged, amount: Patch::Unchanged,
        }});
        assert!(rejected_patch.is_err());
        assert_eq!(core.result("window").unwrap(), before);
        assert_eq!(core.topic.rows.get("p0").unwrap().category, "x");
        core.apply(ProductCommand::Upsert { row: row("recovery", "x", "1", "11", None) }).unwrap();
        assert_eq!(core.result("window").unwrap().total_rows, 12);

        let beyond = query(Expr::True, 99, 3);
        core.apply(ProductCommand::ChangeQuery { subscription: "window".into(), query: beyond }).unwrap();
        let out_of_range = core.result("window").unwrap();
        assert_eq!(out_of_range.start_rank, 99);
        assert!(out_of_range.rows.is_empty());
        assert_eq!(out_of_range.total_rows, 12);
    }

    #[test]
    fn command_json_is_typed_and_patch_distinguishes_unchanged_from_clear() {
        let command = ProductCommand::Patch {
            id: "id".into(),
            patch: ProductPatch {
                category: Patch::Unchanged,
                label: Patch::Clear,
                quantity: Patch::Unchanged,
                amount: Patch::Unchanged,
            },
        };
        let json = serde_json::to_string(&command).unwrap();
        let decoded: ProductCommand = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, command);
    }

    #[test]
    fn shared_hundred_row_corpus_runs_through_the_native_command_api() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../../../fixtures/product-core-100.json")).unwrap();
        let mut core = ProductCore::new();
        for (index, command) in fixture["commands"].as_array().unwrap().iter().enumerate() {
            core.apply_json(&serde_json::to_string(command).unwrap())
                .unwrap_or_else(|error| panic!("fixture command {index} failed: {error}"));
        }

        for subscription in ["all", "c0"] {
            let result = core.result(subscription).unwrap();
            let expected = &fixture["expect"][subscription];
            assert_eq!(result.version, expected["version"].as_u64().unwrap());
            assert_eq!(result.total_rows, expected["total_rows"].as_u64().unwrap());
            assert_eq!(
                result
                    .rows
                    .iter()
                    .map(|row| row.id.as_str())
                    .collect::<Vec<_>>(),
                expected["ids"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|id| id.as_str().unwrap())
                    .collect::<Vec<_>>()
            );
        }
        let groups = core.grouped_count_by_category("c0").unwrap();
        assert_eq!(
            groups.groups[0].count.0,
            fixture["expect"]["c0"]["groups"][0]["count"]
                .as_str()
                .unwrap()
        );
        assert_eq!(
            core.topic.rows["p-050"].amount.to_string_exact(),
            fixture["expect"]["patched_amount"].as_str().unwrap()
        );
    }

    #[test]
    fn v5_shared_acquisition_counts_only_missing_direction_construction() {
        let mut core = ProductCore::new();
        for i in 0..64 { core.apply(ProductCommand::Upsert { row: row(&format!("r{i:02}"), "c0", "1", &i.to_string(), None) }).unwrap(); }
        let q = query(Expr::True, 0, 6);
        core.apply(ProductCommand::Open { subscription: "a".into(), query: q.clone() }).unwrap();
        assert_eq!(core.stats().query_seed_rows_scanned, 64);
        assert_eq!(core.stats().directed_indexes_constructed, 1);
        for i in 0..3 {
            core.apply(ProductCommand::Open { subscription: format!("b{i}"), query: query(Expr::True, 10 * i, 3) }).unwrap();
        }
        assert_eq!(core.stats().directed_index_records_traversed, 0);
        assert_eq!(core.stats().directed_index_records_cloned, 0);
        assert_eq!(core.stats().directed_indexes_constructed, 1);
        assert_eq!(core.result("b2").unwrap().rows[0].id, "r20");
        let mut desc = q.clone(); desc.direction = Direction::Descending;
        core.apply(ProductCommand::Open { subscription: "desc".into(), query: desc }).unwrap();
        assert_eq!(core.stats().directed_index_records_traversed, 64);
        assert_eq!(core.stats().directed_index_records_cloned, 128);
        assert_eq!(core.stats().directed_index_records_transferred, 64);
        assert_eq!(core.stats().directed_indexes_constructed, 2);
        assert_eq!(core.result("desc").unwrap().rows[0].id, "r63");
        for id in ["a", "b0", "b1", "b2"] { core.apply(ProductCommand::Close { subscription: id.into() }).unwrap(); }
        assert_eq!(core.stats().active_query_shapes, 1);
        core.apply(ProductCommand::Close { subscription: "desc".into() }).unwrap();
        assert_eq!(core.stats().active_subscriptions, 0);
        assert_eq!(core.stats().active_query_shapes, 0);
        assert_eq!(core.stats().final_close_rows_scanned, 64);
        println!("V5_NATIVE_SMOKE {}", serde_json::to_string(&core.stats()).unwrap());
    }

    #[test]
    fn v5_empty_index_is_shared_and_generations_survive_replacements() {
        let mut core = ProductCore::new();
        let q = query(Expr::True, 0, 6);
        core.apply(ProductCommand::Open { subscription: "a".into(), query: q.clone() }).unwrap();
        core.apply(ProductCommand::Open { subscription: "b".into(), query: q.clone() }).unwrap();
        assert_eq!(core.stats().directed_indexes_constructed, 1);
        let before = core.result("a").unwrap();
        let mut invalid = q.clone(); invalid.offset = u64::MAX;
        assert!(core.apply(ProductCommand::ChangeQuery { subscription: "a".into(), query: invalid }).is_err());
        assert_eq!(core.result("a").unwrap(), before);
        let mut changed = q.clone(); changed.direction = Direction::Descending;
        core.apply(ProductCommand::ChangeQuery { subscription: "a".into(), query: changed }).unwrap();
        assert!(core.result("a").unwrap().query_generation > before.query_generation);
        core.apply(ProductCommand::Upsert { row: row("x", "c0", "1", "0", None) }).unwrap();
        assert_eq!(core.result("a").unwrap().rows.len(), 1);
        assert_eq!(core.result("b").unwrap().rows.len(), 1);
        for id in ["a", "b"] { core.apply(ProductCommand::Close { subscription: id.into() }).unwrap(); }
        core.apply(ProductCommand::Open { subscription: "a".into(), query: q }).unwrap();
        assert!(core.result("a").unwrap().query_generation > before.query_generation);
    }
}
