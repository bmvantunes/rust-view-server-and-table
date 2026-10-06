use std::collections::BTreeMap;

use super::{Command, CommandError, EngineStats, LiveEngine, QueryDefinition, Row, ViewResult};

/// Independent, deliberately recomputing semantic oracle.
#[derive(Clone, Debug, Default)]
pub struct Oracle {
    rows: BTreeMap<String, Row>,
}

#[derive(Clone, Debug, Default)]
pub struct OracleSession {
    oracle: Oracle,
    subscriptions: BTreeMap<String, QueryDefinition>,
}

impl OracleSession {
    pub fn apply_command(&mut self, command: Command) -> Result<(), String> {
        match command {
            Command::Upsert(row) => {
                self.oracle.upsert(row);
            }
            Command::Delete(id) => {
                self.oracle.delete(&id);
            }
            Command::Open { subscriber, query } => {
                query.validate_window(None).map_err(|e| e.to_string())?;
                if self
                    .subscriptions
                    .insert(subscriber.clone(), query)
                    .is_some()
                {
                    return Err(format!("subscriber {subscriber} is already open"));
                }
            }
            Command::ChangePredicate {
                subscriber,
                predicate,
            } => {
                self.subscriptions
                    .get_mut(&subscriber)
                    .ok_or_else(|| format!("subscriber {subscriber} is not open"))?
                    .predicate = predicate;
            }
            Command::ChangeSort { subscriber, sort } => {
                self.subscriptions
                    .get_mut(&subscriber)
                    .ok_or_else(|| format!("subscriber {subscriber} is not open"))?
                    .sort = sort;
            }
            Command::ChangeWindow { subscriber, window } => {
                window.checked().map_err(|e: CommandError| e.to_string())?;
                self.subscriptions
                    .get_mut(&subscriber)
                    .ok_or_else(|| format!("subscriber {subscriber} is not open"))?
                    .window = window;
            }
            Command::Close { subscriber } => {
                if self.subscriptions.remove(&subscriber).is_none() {
                    return Err(format!("subscriber {subscriber} is not open"));
                }
            }
            Command::Boundary(commands) => {
                for nested in commands {
                    self.apply_command(nested)?;
                }
            }
        }
        Ok(())
    }

    pub fn query(&self, subscriber: &str) -> Option<ViewResult> {
        self.subscriptions
            .get(subscriber)
            .map(|query| self.oracle.query(query))
    }

    pub fn retained_rows(&self) -> usize {
        self.oracle.retained_rows()
    }

    pub fn active_subscribers(&self) -> usize {
        self.subscriptions.len()
    }

    pub fn subscriber_ids(&self) -> Vec<String> {
        self.subscriptions.keys().cloned().collect()
    }
}

impl LiveEngine for OracleSession {
    fn apply(&mut self, command: Command) -> Result<(), String> {
        self.apply_command(command)
    }

    fn complete(&mut self) -> Result<(), String> {
        Ok(())
    }

    fn result(&self, subscriber: &str) -> Option<ViewResult> {
        self.query(subscriber)
    }

    fn subscriber_ids(&self) -> Vec<String> {
        self.subscriber_ids()
    }

    fn stats(&self) -> EngineStats {
        let shapes: std::collections::BTreeSet<_> = self
            .subscriptions
            .values()
            .map(|query| (query.predicate.clone(), query.sort))
            .collect();
        let matching_memberships = self
            .subscriptions
            .values()
            .map(|query| {
                self.oracle
                    .rows
                    .values()
                    .filter(|row| query.matches(row))
                    .count()
            })
            .sum();
        EngineStats {
            base_rows: self.oracle.retained_rows(),
            active_query_shapes: shapes.len(),
            candidate_pairs: None,
            matching_memberships: Some(matching_memberships),
            ranked_rows: Some(matching_memberships),
            active_windows: self.subscriptions.len(),
            output_rows: self
                .subscriptions
                .keys()
                .filter_map(|subscriber| self.query(subscriber))
                .map(|result| result.rows.len())
                .sum(),
            base_arrangement_builds: 0,
            circuit_builds: 0,
        }
    }
}

impl Oracle {
    pub fn upsert(&mut self, row: Row) -> bool {
        match self.rows.get(&row.id) {
            Some(old) if old == &row => false,
            _ => {
                self.rows.insert(row.id.clone(), row);
                true
            }
        }
    }

    pub fn delete(&mut self, id: &str) -> bool {
        self.rows.remove(id).is_some()
    }

    pub fn retained_rows(&self) -> usize {
        self.rows.len()
    }

    pub fn query(&self, query: &QueryDefinition) -> ViewResult {
        let mut matching: Vec<Row> = self
            .rows
            .values()
            .filter(|row| query.matches(row))
            .cloned()
            .collect();
        matching.sort_by(|left, right| {
            let payload_order = match query.sort {
                super::SortDirection::Ascending => left.payload.cmp(&right.payload),
                super::SortDirection::Descending => right.payload.cmp(&left.payload),
            };
            payload_order.then_with(|| left.id.cmp(&right.id))
        });
        let total_rows = matching.len() as u64;
        let (offset, limit) = query
            .window
            .checked()
            .expect("invalid windows must be rejected before querying the oracle");
        let rows = matching.into_iter().skip(offset).take(limit).collect();
        ViewResult { rows, total_rows }
    }
}
