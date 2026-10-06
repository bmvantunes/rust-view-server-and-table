//! TEST ONLY. Independent full recomputation; never linked into the product/WASM.
use num_bigint::BigInt;
use rust_differential_product_core::{
    engine_contract::{EngineCompletion, EngineStats, ProductEngine},
    product::{
        CompareOp, Condition, Direction, Expr, OptionalString, ProductCommand, ProductResult,
        ProductRow, Query,
    },
    source::{SourceBatch, SourceCommit},
    topic::TopicSnapshot,
};
use serde_json::Value;
use std::{cmp::Ordering, collections::BTreeMap};

pub struct ReferenceTestEngine {
    snapshot: TopicSnapshot,
    rows: BTreeMap<String, ProductRow>,
    subscriptions: BTreeMap<String, (Query, u64, u64)>,
    version: u64,
    generation: u64,
    extracted: u64,
}
fn numeric(value: &impl serde::Serialize) -> (BigInt, i32) {
    match serde_json::to_value(value).unwrap() {
        Value::String(s) => (s.parse().unwrap(), 0),
        Value::Object(v) => (
            v["coefficient"].as_str().unwrap().parse().unwrap(),
            v["scale"].as_i64().unwrap() as i32,
        ),
        _ => unreachable!(),
    }
}
fn number(a: &impl serde::Serialize, b: &impl serde::Serialize) -> Ordering {
    let (a, sa) = numeric(a);
    let (b, sb) = numeric(b);
    let scale = sa.max(sb);
    (a * BigInt::from(10u8).pow((scale - sa) as u32))
        .cmp(&(b * BigInt::from(10u8).pow((scale - sb) as u32)))
}
fn compare(op: CompareOp, order: Ordering) -> bool {
    match op {
        CompareOp::Equal => order == Ordering::Equal,
        CompareOp::GreaterThan => order == Ordering::Greater,
        CompareOp::GreaterThanOrEqual => order != Ordering::Less,
        CompareOp::LessThan => order == Ordering::Less,
        CompareOp::LessThanOrEqual => order != Ordering::Greater,
    }
}
fn empty(e: &Expr) -> bool {
    matches!(e,Expr::And(xs)|Expr::Or(xs) if xs.is_empty())
}
fn accepts(e: &Expr, r: &ProductRow) -> bool {
    match e {
        Expr::True => true,
        Expr::False => false,
        Expr::And(xs) => xs.iter().filter(|x| !empty(x)).all(|x| accepts(x, r)),
        Expr::Or(xs) => {
            let xs: Vec<_> = xs.iter().filter(|x| !empty(x)).collect();
            xs.is_empty() || xs.iter().any(|x| accepts(x, r))
        }
        Expr::Not(x) => empty(x) || !accepts(x, r),
        Expr::Condition(c) => match c {
            Condition::CategoryEquals(v) => r.category == *v,
            Condition::LabelEquals(v) => r.label == OptionalString::Value(v.clone()),
            Condition::LabelBlank => !matches!(&r.label,OptionalString::Value(v) if !v.is_empty()),
            Condition::LabelNotBlank => {
                matches!(&r.label,OptionalString::Value(v) if !v.is_empty())
            }
            Condition::Quantity { op, value } => compare(*op, number(&r.quantity, value)),
            Condition::Amount { op, value } => compare(*op, number(&r.amount, value)),
        },
    }
}
impl ProductEngine for ReferenceTestEngine {
    fn load(mut snapshot: TopicSnapshot) -> Result<Self, String> {
        let rows = std::mem::take(&mut snapshot.rows)
            .into_iter()
            .map(|r| (r.id.clone(), r))
            .collect();
        Ok(Self {
            snapshot,
            rows,
            subscriptions: BTreeMap::new(),
            version: 0,
            generation: 0,
            extracted: 0,
        })
    }
    fn command(&mut self, command: ProductCommand) -> Result<EngineCompletion, String> {
        match &command {
            ProductCommand::Open { subscription, .. }
                if self.subscriptions.contains_key(subscription) =>
            {
                return Err("already open".into());
            }
            ProductCommand::ChangeQuery { subscription, .. }
                if !self.subscriptions.contains_key(subscription) =>
            {
                return Err("missing subscription".into());
            }
            _ => {}
        }
        let mut dirty = Vec::new();
        let changed;
        match command {
            ProductCommand::Upsert { row } => {
                if row.id.is_empty() {
                    return Err("invalid ID".into());
                }
                let old = self.rows.get(&row.id);
                changed = old != Some(&row);
                if changed {
                    dirty = self
                        .subscriptions
                        .iter()
                        .filter(|(_, (q, _, _))| {
                            accepts(&q.where_expr, &row)
                                || old.is_some_and(|r| accepts(&q.where_expr, r))
                        })
                        .map(|(id, _)| id.clone())
                        .collect();
                    self.rows.insert(row.id.clone(), row);
                    self.snapshot.version += 1;
                }
            }
            ProductCommand::Delete { id } => {
                let old = self.rows.remove(&id);
                changed = old.is_some();
                if let Some(row) = old {
                    dirty = self
                        .subscriptions
                        .iter()
                        .filter(|(_, (q, _, _))| accepts(&q.where_expr, &row))
                        .map(|(id, _)| id.clone())
                        .collect();
                    self.snapshot.version += 1;
                }
            }
            ProductCommand::Open {
                subscription,
                query,
            }
            | ProductCommand::ChangeQuery {
                subscription,
                query,
            } => {
                query
                    .offset
                    .checked_add(query.limit)
                    .ok_or("window overflow")?;
                changed = self
                    .subscriptions
                    .get(&subscription)
                    .is_none_or(|(old, _, _)| old != &query);
                if changed {
                    self.generation += 1;
                    self.subscriptions
                        .insert(subscription.clone(), (query, self.generation, 0));
                    dirty.push(subscription);
                }
            }
            ProductCommand::ChangeWindow {
                subscription,
                offset,
                limit,
            } => {
                offset.checked_add(limit).ok_or("window overflow")?;
                let (q, _, seq) = self
                    .subscriptions
                    .get_mut(&subscription)
                    .ok_or("missing subscription")?;
                changed = q.offset != offset || q.limit != limit;
                if changed {
                    q.offset = offset;
                    q.limit = limit;
                    *seq += 1;
                    dirty.push(subscription);
                }
            }
            ProductCommand::Close { subscription } => {
                self.subscriptions
                    .remove(&subscription)
                    .ok_or("missing subscription")?;
                changed = true;
            }
            ProductCommand::Patch { .. } => {
                return Err("reference subset uses full typed replacements".into());
            }
        }
        if changed {
            self.version += 1;
        }
        Ok(EngineCompletion {
            product_version: self.version,
            topic_version: self.snapshot.version,
            dirty_subscriptions: dirty,
        })
    }
    fn commit(&mut self, _: SourceBatch) -> Result<SourceCommit, String> {
        Err("source protocol tested separately; reference subset is command corpus".into())
    }
    fn read(&mut self, id: &str) -> Option<ProductResult> {
        let (q, g, seq) = self.subscriptions.get(id)?;
        let mut rows: Vec<_> = self
            .rows
            .values()
            .filter(|r| accepts(&q.where_expr, r))
            .cloned()
            .collect();
        rows.sort_by(|a, b| {
            let order = number(&a.amount, &b.amount);
            let order = if q.direction == Direction::Ascending {
                order
            } else {
                order.reverse()
            };
            order.then_with(|| a.id.cmp(&b.id))
        });
        let total = rows.len();
        let rows: Vec<_> = rows
            .into_iter()
            .skip(q.offset as usize)
            .take(q.limit as usize)
            .collect();
        self.extracted += rows.len() as u64;
        Some(ProductResult {
            subscription: id.into(),
            query_generation: *g,
            sequence: *seq,
            start_rank: q.offset,
            version: self.version,
            total_rows: total as u64,
            rows,
        })
    }
    fn observe(&self, keys: &[String]) -> Result<rust_differential_product_core::topic::SourceObservation, String> {
        rust_differential_product_core::topic::TopicStore::from_snapshot(self.checkpoint()?)?.observe(keys)
    }
    fn checkpoint(&self) -> Result<TopicSnapshot, String> {
        let mut s = self.snapshot.clone();
        s.rows = self.rows.values().cloned().collect();
        Ok(s)
    }
    fn engine_stats(&self) -> EngineStats {
        EngineStats {
            retained_rows: self.rows.len() as u64,
            query_shapes: self
                .subscriptions
                .values()
                .map(|(q, _, _)| q.where_expr.canonical())
                .collect::<std::collections::BTreeSet<_>>()
                .len() as u64,
            subscriptions: self.subscriptions.len() as u64,
            result_rows_extracted: self.extracted,
        }
    }
    fn failure(&self) -> Option<&str> {
        None
    }
}
