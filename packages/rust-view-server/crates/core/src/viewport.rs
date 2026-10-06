//! Shared arbitrary-rank viewport state for the separately labelled follow-up.
//! Candidate engines feed this hub only from their native membership deltas.

use std::collections::{BTreeMap, BTreeSet};

use crate::common::{Predicate, RankedRows, Row, SortDirection};

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct QueryKey {
    predicate: Predicate,
    sort: SortDirection,
}

#[derive(Default)]
struct QueryIndex {
    rows_by_id: BTreeMap<String, Row>,
    ranked: RankedRows,
    subscribers: BTreeSet<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NavigationMode {
    FollowStart,
    FollowEnd,
    /// Raw fixed-rank window semantics used by the product adapter.
    FixedRank { start_rank: usize },
    AnchorRow { row_id: String, screen_slot: usize },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NavigationAction {
    FollowStart,
    FollowEnd,
    /// Move the first visible rank. Interior movement anchors that row at slot 0.
    ScrollToRank {
        first_rank: usize,
    },
    /// Put the exact selected rank in a consistent visible window.
    SeekToRank {
        rank: usize,
    },
    AnchorRow {
        row_id: String,
        screen_slot: usize,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NavigationRequest {
    pub query_generation: u64,
    pub completed_version: u64,
    pub sequence: u64,
    pub action: NavigationAction,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ViewportSnapshot {
    pub subscriber: String,
    pub query_generation: u64,
    pub completed_version: u64,
    pub sequence: u64,
    pub mode: NavigationMode,
    pub start_rank: usize,
    pub total_rows: usize,
    pub rows: Vec<Row>,
}

struct Client {
    query: QueryKey,
    generation: u64,
    limit: usize,
    mode: NavigationMode,
    last_request_sequence: u64,
    last_applied_sequence: u64,
    last_applied_version: u64,
    pending_fallback: Option<(usize, usize)>,
    pending_action: Option<NavigationAction>,
}

/// One instance is shared by all subscribers on an engine. Identical query
/// shapes share one membership map and one order-statistic tree.
#[derive(Default)]
pub struct ViewportHub {
    queries: BTreeMap<Predicate, BTreeMap<SortDirection, QueryIndex>>,
    clients: BTreeMap<String, Client>,
    completed_version: u64,
    has_anchors: bool,
    next_generation: u64,
    pub directed_index_records_traversed: u64,
    pub directed_index_records_cloned: u64,
    pub directed_index_records_transferred: u64,
    pub directed_indexes_constructed: u64,
}

pub trait ViewportEngine {
    fn navigate_viewport(
        &mut self,
        subscriber: &str,
        request: NavigationRequest,
    ) -> Result<ViewportSnapshot, String>;
    fn accept_viewport_response(&mut self, response: &ViewportSnapshot) -> bool;
    fn viewport_snapshot(&self, subscriber: &str) -> Option<ViewportSnapshot>;
    fn viewport_stats(&self) -> ViewportStats;
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ViewportStats {
    pub completed_version: u64,
    pub active_query_shapes: usize,
    pub indexed_memberships: usize,
    pub subscribers: usize,
}

impl ViewportHub {
    pub fn completed_version(&self) -> u64 {
        self.completed_version
    }

    pub fn open(
        &mut self,
        subscriber: impl Into<String>,
        predicate: Predicate,
        sort: SortDirection,
        limit: usize,
    ) -> Result<u64, String> {
        self.open_window(subscriber, predicate, sort, 0, limit)
    }

    pub fn open_window(
        &mut self,
        subscriber: impl Into<String>,
        predicate: Predicate,
        sort: SortDirection,
        offset: usize,
        limit: usize,
    ) -> Result<u64, String> {
        offset.checked_add(limit).ok_or("viewport window overflow")?;
        let subscriber = subscriber.into();
        if self.clients.contains_key(&subscriber) {
            return Err(format!("viewport subscriber {subscriber} is already open"));
        }
        let query = QueryKey { predicate, sort };
        // Presence owns initialization, including an existing empty index.
        let missing = self.queries.get(&query.predicate)
            .is_none_or(|sorts| !sorts.contains_key(&query.sort));
        let generation = self.next_generation.checked_add(1).ok_or("query generation overflow")?;
        self.next_generation = generation;
        if missing {
            let transfer_rows = self.queries.get(&query.predicate)
                .and_then(|sorts| sorts.values().next())
                .map(|index| index.rows_by_id.values().cloned().collect::<Vec<_>>())
                .unwrap_or_default();
            self.directed_indexes_constructed += 1;
            self.directed_index_records_traversed += transfer_rows.len() as u64;
            self.directed_index_records_cloned += 2 * transfer_rows.len() as u64;
            self.directed_index_records_transferred += transfer_rows.len() as u64;
            let mut index = QueryIndex::default();
            for row in transfer_rows {
                index.ranked.insert(row.clone(), query.sort);
                index.rows_by_id.insert(row.id.clone(), row);
            }
            self.queries.entry(query.predicate.clone()).or_default().insert(query.sort, index);
        }
        let query_index = self.queries.get_mut(&query.predicate).unwrap().get_mut(&query.sort).unwrap();
        query_index.subscribers.insert(subscriber.clone());
        self.clients.insert(
            subscriber,
            Client {
                query,
                generation,
                limit,
                mode: NavigationMode::FixedRank { start_rank: offset },
                last_request_sequence: 0,
                last_applied_sequence: 0,
                last_applied_version: 0,
                pending_fallback: None,
                pending_action: None,
            },
        );
        Ok(generation)
    }

    /// Query-shape changes invalidate old navigation responses. The previous
    /// row anchor is carried into the new predicate/sort when it still matches;
    /// otherwise the nearest surviving rank is used at the next completion.
    pub fn change_query(
        &mut self,
        subscriber: &str,
        predicate: Predicate,
        sort: SortDirection,
        limit: usize,
    ) -> Result<u64, String> {
        self.change_query_with_window(subscriber, predicate, sort, 0, limit)
    }

    pub fn change_query_with_window(
        &mut self,
        subscriber: &str,
        predicate: Predicate,
        sort: SortDirection,
        offset: usize,
        limit: usize,
    ) -> Result<u64, String> {
        offset.checked_add(limit).ok_or("viewport window overflow")?;
        let next_generation = self.next_generation.checked_add(1).ok_or("query generation overflow")?;
        let old = self
            .clients
            .get(subscriber)
            .ok_or_else(|| format!("viewport subscriber {subscriber} is not open"))?;
        let mut fallback = old.pending_fallback;
        if let NavigationMode::AnchorRow {
            row_id,
            screen_slot,
        } = &old.mode
        {
            if let Some(index) = self
                .queries
                .get(&old.query.predicate)
                .and_then(|sorts| sorts.get(&old.query.sort))
            {
                if let Some(row) = index.rows_by_id.get(row_id) {
                    fallback = Some((
                        index.ranked.rank_of(row, old.query.sort).unwrap_or(0),
                        *screen_slot,
                    ));
                }
            }
        }
        let next_query = QueryKey { predicate, sort };
        let transfer_rows = if old.query.predicate == next_query.predicate
            && old.query.sort != next_query.sort
            && self
                .queries
                .get(&next_query.predicate)
                .is_none_or(|sorts| !sorts.contains_key(&next_query.sort))
        {
            self.queries
                .get(&old.query.predicate)
                .and_then(|sorts| sorts.get(&old.query.sort))
                .map(|index| index.rows_by_id.values().cloned().collect::<Vec<_>>())
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        self.next_generation = next_generation;
        if old.query != next_query {
            if self.query_index(&next_query).is_none() { self.directed_indexes_constructed += 1; }
            self.directed_index_records_traversed += transfer_rows.len() as u64;
            self.directed_index_records_cloned += 2 * transfer_rows.len() as u64;
            self.directed_index_records_transferred += transfer_rows.len() as u64;
            if let Some(old_index) = self
                .queries
                .get_mut(&old.query.predicate)
                .and_then(|sorts| sorts.get_mut(&old.query.sort))
            {
                old_index.subscribers.remove(subscriber);
            }
            let next_index = self
                .queries
                .entry(next_query.predicate.clone())
                .or_default()
                .entry(next_query.sort)
                .or_default();
            for row in transfer_rows {
                next_index.ranked.insert(row.clone(), next_query.sort);
                next_index.rows_by_id.insert(row.id.clone(), row);
            }
            next_index.subscribers.insert(subscriber.to_owned());
        }
        let client = self.clients.get_mut(subscriber).unwrap();
        client.query = next_query;
        client.generation = next_generation;
        client.limit = limit;
        client.mode = NavigationMode::FixedRank { start_rank: offset };
        client.pending_fallback = fallback;
        client.pending_action = None;
        if let NavigationMode::AnchorRow {
            row_id,
            screen_slot,
        } = &client.mode
        {
            client.mode = NavigationMode::AnchorRow {
                row_id: row_id.clone(),
                screen_slot: *screen_slot,
            };
        }
        let generation = client.generation;
        self.prune_empty_queries();
        Ok(generation)
    }

    pub fn change_window(
        &mut self,
        subscriber: &str,
        offset: usize,
        limit: usize,
    ) -> Result<(), String> {
        offset.checked_add(limit).ok_or("viewport window overflow")?;
        let client = self
            .clients
            .get_mut(subscriber)
            .ok_or_else(|| format!("viewport subscriber {subscriber} is not open"))?;
        let next_sequence = client.last_request_sequence.checked_add(1).ok_or("navigation sequence overflow")?;
        client.limit = limit;
        client.mode = NavigationMode::FixedRank { start_rank: offset };
        client.pending_action = None;
        client.last_request_sequence = next_sequence;
        Ok(())
    }

    pub fn close(&mut self, subscriber: &str) -> Result<(), String> {
        let client = self
            .clients
            .remove(subscriber)
            .ok_or_else(|| format!("viewport subscriber {subscriber} is not open"))?;
        if let Some(query) = self.query_index_mut(&client.query) {
            query.subscribers.remove(subscriber);
        }
        self.prune_empty_queries();
        Ok(())
    }

    /// Apply an actual candidate membership delta. Retractions are expected
    /// before insertions for a replacement within one completion boundary.
    pub fn apply_membership_delta(
        &mut self,
        predicate: &Predicate,
        sort: SortDirection,
        row: Row,
        diff: isize,
    ) -> Result<(), String> {
        let Some(index) = self
            .queries
            .get_mut(predicate)
            .and_then(|sorts| sorts.get_mut(&sort))
        else {
            return Ok(());
        };
        match diff {
            -1 => {
                let old_rank = index
                    .rows_by_id
                    .get(&row.id)
                    .and_then(|old| index.ranked.rank_of(old, sort));
                let old = index
                    .rows_by_id
                    .remove(&row.id)
                    .ok_or_else(|| format!("viewport index retracted missing row {}", row.id))?;
                if old != row {
                    return Err(format!("viewport index retracted stale row {}", row.id));
                }
                if !index.ranked.remove(&row, sort) {
                    return Err(format!("ranked index retracted missing row {}", row.id));
                }
                if self.has_anchors {
                    for client in self.clients.values_mut() {
                        if client.query.predicate != *predicate || client.query.sort != sort {
                            continue;
                        }
                        if let NavigationMode::AnchorRow {
                            row_id,
                            screen_slot,
                        } = &client.mode
                            && row_id == &row.id
                        {
                            let rank = old_rank.unwrap_or_else(|| index.ranked.len());
                            client.pending_fallback = Some((rank, *screen_slot));
                        }
                    }
                }
            }
            1 => {
                if let Some(old) = index.rows_by_id.insert(row.id.clone(), row.clone()) {
                    return Err(format!(
                        "viewport index inserted duplicate row {} (old={old:?})",
                        row.id
                    ));
                }
                if !index.ranked.insert(row.clone(), sort) {
                    return Err(format!("ranked index inserted duplicate row {}", row.id));
                }
            }
            other => return Err(format!("unexpected viewport membership weight {other}")),
        }
        Ok(())
    }

    pub fn apply_predicate_membership_delta(
        &mut self,
        predicate: &Predicate,
        row: Row,
        diff: isize,
    ) -> Result<usize, String> {
        let mut updates = 0;
        for sort in [SortDirection::Ascending, SortDirection::Descending] {
            if self
                .queries
                .get(predicate)
                .is_some_and(|sorts| sorts.contains_key(&sort))
            {
                self.apply_membership_delta(predicate, sort, row.clone(), diff)?;
                updates += 1;
            }
        }
        Ok(updates)
    }

    /// Commit one native engine completion boundary. Follow modes remain modes;
    /// they are never converted into anchors to whichever row happened to be
    /// at the edge when the request was made.
    pub fn complete_boundary(&mut self) -> Result<u64, String> {
        self.completed_version = self
            .completed_version
            .checked_add(1)
            .ok_or("version overflow")?;
        for client in self.clients.values_mut() {
            if !matches!(client.mode, NavigationMode::AnchorRow { .. }) {
                continue;
            }
            let Some(index) = self
                .queries
                .get(&client.query.predicate)
                .and_then(|sorts| sorts.get(&client.query.sort))
            else {
                continue;
            };
            let NavigationMode::AnchorRow {
                row_id,
                screen_slot,
            } = &client.mode
            else {
                unreachable!()
            };
            if let Some(row) = index.rows_by_id.get(row_id) {
                let rank = index.ranked.rank_of(row, client.query.sort).unwrap_or(0);
                if rank < *screen_slot {
                    client.mode = NavigationMode::AnchorRow {
                        row_id: row_id.clone(),
                        screen_slot: rank,
                    };
                }
                client.pending_fallback = None;
            } else if let Some((old_rank, old_slot)) = client.pending_fallback.take() {
                if index.ranked.is_empty() {
                    client.mode = NavigationMode::FollowStart;
                } else {
                    let chosen_rank = old_rank.min(index.ranked.len() - 1);
                    let row = index
                        .ranked
                        .select(chosen_rank)
                        .expect("selected fallback rank");
                    let slot = old_slot
                        .min(client.limit.saturating_sub(1))
                        .min(chosen_rank);
                    client.mode = NavigationMode::AnchorRow {
                        row_id: row.id.clone(),
                        screen_slot: slot,
                    };
                }
            } else {
                let _ = screen_slot;
            }
        }
        let mut pending = Vec::new();
        for (subscriber, client) in &self.clients {
            if let Some(action) = &client.pending_action {
                let sequence = client
                    .last_request_sequence
                    .checked_add(1)
                    .ok_or("navigation sequence overflow")?;
                pending.push((
                    subscriber.clone(),
                    client.generation,
                    sequence,
                    action.clone(),
                ));
            }
        }
        for (subscriber, generation, sequence, action) in pending {
            self.navigate(
                &subscriber,
                NavigationRequest {
                    query_generation: generation,
                    completed_version: self.completed_version,
                    sequence,
                    action,
                },
            )?;
            self.clients.get_mut(&subscriber).unwrap().pending_action = None;
        }
        self.has_anchors = self
            .clients
            .values()
            .any(|client| matches!(client.mode, NavigationMode::AnchorRow { .. }));
        Ok(self.completed_version)
    }

    pub fn navigate(
        &mut self,
        subscriber: &str,
        request: NavigationRequest,
    ) -> Result<ViewportSnapshot, String> {
        if request.completed_version != self.completed_version {
            return Err(format!(
                "stale viewport version: requested {}, current {}",
                request.completed_version, self.completed_version
            ));
        }
        let client = self
            .clients
            .get_mut(subscriber)
            .ok_or_else(|| format!("viewport subscriber {subscriber} is not open"))?;
        if request.query_generation != client.generation {
            return Err(format!(
                "stale viewport generation: requested {}, current {}",
                request.query_generation, client.generation
            ));
        }
        if request.sequence <= client.last_request_sequence {
            return Err(format!("stale navigation sequence {}", request.sequence));
        }
        let index = self
            .queries
            .get(&client.query.predicate)
            .and_then(|sorts| sorts.get(&client.query.sort))
            .expect("open subscriber query index");
        let total = index.ranked.len();
        let max_start = total.saturating_sub(client.limit);
        match request.action {
            NavigationAction::FollowStart => client.mode = NavigationMode::FollowStart,
            NavigationAction::FollowEnd => client.mode = NavigationMode::FollowEnd,
            NavigationAction::ScrollToRank { first_rank } => {
                if client.limit == 0 {
                    return Err("cannot scroll a zero-row viewport".into());
                }
                let start = first_rank.min(max_start);
                if start == 0 {
                    client.mode = NavigationMode::FollowStart;
                } else if start == max_start {
                    client.mode = NavigationMode::FollowEnd;
                } else {
                    let row = index
                        .ranked
                        .select(start)
                        .ok_or("scroll rank is outside the result")?;
                    client.mode = NavigationMode::AnchorRow {
                        row_id: row.id.clone(),
                        screen_slot: 0,
                    };
                }
            }
            NavigationAction::SeekToRank { rank } => {
                if client.limit == 0 {
                    return Err("cannot seek with a zero-row viewport".into());
                }
                if rank >= total {
                    return Err(format!("rank {rank} is outside result of {total} rows"));
                }
                if rank == 0 {
                    client.mode = NavigationMode::FollowStart;
                } else if rank >= max_start {
                    client.mode = NavigationMode::FollowEnd;
                } else {
                    let row = index.ranked.select(rank).expect("validated rank");
                    client.mode = NavigationMode::AnchorRow {
                        row_id: row.id.clone(),
                        screen_slot: 0,
                    };
                }
            }
            NavigationAction::AnchorRow {
                row_id,
                screen_slot,
            } => {
                if client.limit == 0 {
                    return Err("cannot anchor a zero-row viewport".into());
                }
                let row = index
                    .rows_by_id
                    .get(&row_id)
                    .ok_or_else(|| format!("anchor row {row_id} is not in this query"))?;
                let rank = index
                    .ranked
                    .rank_of(row, client.query.sort)
                    .ok_or("anchor missing from ranked index")?;
                if screen_slot >= client.limit {
                    return Err("anchor screen slot is outside viewport".into());
                }
                if rank < screen_slot {
                    return Err("anchor rank cannot fit requested screen slot".into());
                }
                client.mode = NavigationMode::AnchorRow {
                    row_id,
                    screen_slot,
                };
            }
        }
        client.last_request_sequence = request.sequence;
        let snapshot = snapshot_for(
            subscriber,
            client,
            index,
            self.completed_version,
            request.sequence,
        );
        self.has_anchors = self
            .clients
            .values()
            .any(|client| matches!(client.mode, NavigationMode::AnchorRow { .. }));
        Ok(snapshot)
    }

    /// An asynchronous result may be published only if it still matches the
    /// client's newest request and current query generation/version.
    pub fn accept_response(&mut self, response: &ViewportSnapshot) -> bool {
        if self.completed_version != response.completed_version {
            return false;
        }
        let Some(client) = self.clients.get_mut(&response.subscriber) else {
            return false;
        };
        if response.query_generation != client.generation
            || response.sequence != client.last_request_sequence
            || response.sequence < client.last_applied_sequence
            || response.completed_version < client.last_applied_version
        {
            return false;
        }
        client.last_applied_sequence = response.sequence;
        client.last_applied_version = response.completed_version;
        true
    }

    pub fn snapshot(&self, subscriber: &str) -> Option<ViewportSnapshot> {
        let client = self.clients.get(subscriber)?;
        let index = self.query_index(&client.query)?;
        Some(snapshot_for(
            subscriber,
            client,
            index,
            self.completed_version,
            client.last_request_sequence,
        ))
    }

    pub fn snapshot_bounded(&self, subscriber: &str, max_rows: usize) -> Result<ViewportSnapshot, String> {
        let client = self.clients.get(subscriber).ok_or("missing subscription")?;
        let index = self.query_index(&client.query).ok_or("missing query index")?;
        let start = snapshot_start(client, index).0;
        if index.ranked.len().saturating_sub(start).min(client.limit) > max_rows {
            return Err("result row budget; use a viewport".into());
        }
        Ok(snapshot_for(subscriber, client, index, self.completed_version, client.last_request_sequence))
    }

    pub fn active_query_shapes(&self) -> usize {
        self.queries.values().map(BTreeMap::len).sum()
    }
    pub fn membership_rows(&self) -> usize {
        self.queries
            .values()
            .flat_map(BTreeMap::values)
            .map(|q| q.rows_by_id.len())
            .sum()
    }
    pub fn subscriber_count(&self) -> usize {
        self.clients.len()
    }
    pub fn subscriber_ids(&self) -> Vec<String> {
        self.clients.keys().cloned().collect()
    }
    pub fn output_row_count(&self) -> usize {
        self.clients
            .keys()
            .filter_map(|subscriber| self.snapshot(subscriber))
            .map(|snapshot| snapshot.rows.len())
            .sum()
    }

    pub fn stats(&self) -> ViewportStats {
        ViewportStats {
            completed_version: self.completed_version,
            active_query_shapes: self.active_query_shapes(),
            indexed_memberships: self.membership_rows(),
            subscribers: self.subscriber_count(),
        }
    }

    fn prune_empty_queries(&mut self) {
        self.queries.retain(|_, sorts| {
            sorts.retain(|_, query| !query.subscribers.is_empty());
            !sorts.is_empty()
        });
    }

    fn query_index(&self, query: &QueryKey) -> Option<&QueryIndex> {
        self.queries.get(&query.predicate)?.get(&query.sort)
    }

    fn query_index_mut(&mut self, query: &QueryKey) -> Option<&mut QueryIndex> {
        self.queries.get_mut(&query.predicate)?.get_mut(&query.sort)
    }
}

fn snapshot_start(client: &Client, index: &QueryIndex) -> (usize, NavigationMode) {
    let total = index.ranked.len();
    let (start, mode) = match &client.mode {
        NavigationMode::FollowStart => (0, client.mode.clone()),
        NavigationMode::FollowEnd => (total.saturating_sub(client.limit), client.mode.clone()),
        NavigationMode::FixedRank { start_rank } => (*start_rank, client.mode.clone()),
        NavigationMode::AnchorRow {
            row_id,
            screen_slot,
        } => {
            let rank = index
                .rows_by_id
                .get(row_id)
                .and_then(|row| index.ranked.rank_of(row, client.query.sort))
                .unwrap_or(0);
            (rank.saturating_sub(*screen_slot), client.mode.clone())
        }
    };
    (start, mode)
}

fn snapshot_for(
    subscriber: &str,
    client: &Client,
    index: &QueryIndex,
    version: u64,
    sequence: u64,
) -> ViewportSnapshot {
    let total = index.ranked.len();
    let (start, mode) = snapshot_start(client, index);
    ViewportSnapshot {
        subscriber: subscriber.to_owned(),
        query_generation: client.generation,
        completed_version: version,
        sequence,
        mode,
        start_rank: start,
        total_rows: total,
        rows: index.ranked.window(start, client.limit),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(v: &str) -> Predicate {
        Predicate::PayloadIn(BTreeSet::from([v.to_owned()]))
    }
    fn row(id: usize, bucket: usize) -> Row {
        Row {
            id: format!("{id:06}"),
            payload: format!("{bucket:03}"),
            sort_key: format!("{bucket:03}"),
        }
    }

    fn seed(hub: &mut ViewportHub, predicate: &Predicate, sort: SortDirection, n: usize) {
        for id in 0..n {
            hub.apply_membership_delta(predicate, sort, row(id, id % 100), 1)
                .unwrap();
        }
        hub.complete_boundary().unwrap();
    }

    fn request(
        hub: &mut ViewportHub,
        id: &str,
        sequence: u64,
        action: NavigationAction,
    ) -> ViewportSnapshot {
        let current = hub.snapshot(id).unwrap();
        hub.navigate(
            id,
            NavigationRequest {
                query_generation: current.query_generation,
                completed_version: hub.completed_version(),
                sequence,
                action,
            },
        )
        .unwrap()
    }

    #[test]
    fn follow_modes_remain_edges_and_middle_navigation_anchors_identity() {
        let mut hub = ViewportHub::default();
        let all = Predicate::All;
        hub.open("a", all.clone(), SortDirection::Ascending, 8)
            .unwrap();
        seed(&mut hub, &all, SortDirection::Ascending, 1000);
        assert_eq!(
            request(&mut hub, "a", 1, NavigationAction::FollowEnd).start_rank,
            992
        );
        let first = hub.snapshot("a").unwrap();
        let inserted = row(1001, 0);
        hub.apply_membership_delta(&all, SortDirection::Ascending, inserted.clone(), 1)
            .unwrap();
        hub.complete_boundary().unwrap();
        assert_eq!(hub.snapshot("a").unwrap().start_rank, 993);
        assert_eq!(hub.snapshot("a").unwrap().mode, NavigationMode::FollowEnd);
        let middle = request(
            &mut hub,
            "a",
            2,
            NavigationAction::ScrollToRank { first_rank: 500 },
        );
        assert!(matches!(middle.mode, NavigationMode::AnchorRow { .. }));
        let anchor_id = match &middle.mode {
            NavigationMode::AnchorRow { row_id, .. } => row_id.clone(),
            _ => unreachable!(),
        };
        let old = row(500, 500 % 100);
        hub.apply_membership_delta(&all, SortDirection::Ascending, old.clone(), -1)
            .unwrap();
        let changed = Row {
            id: anchor_id.clone(),
            payload: "999".into(),
            sort_key: "999".into(),
        };
        if old.id == anchor_id {
            hub.apply_membership_delta(&all, SortDirection::Ascending, changed.clone(), 1)
                .unwrap();
        } else {
            let anchored = hub
                .queries
                .get(&all)
                .and_then(|sorts| sorts.get(&SortDirection::Ascending))
                .unwrap()
                .rows_by_id
                .get(&anchor_id)
                .unwrap()
                .clone();
            hub.apply_membership_delta(&all, SortDirection::Ascending, anchored.clone(), -1)
                .unwrap();
            hub.apply_membership_delta(&all, SortDirection::Ascending, changed, 1)
                .unwrap();
        }
        hub.complete_boundary().unwrap();
        let moved = hub.snapshot("a").unwrap();
        assert!(moved.rows.iter().any(|r| r.id == anchor_id));
        assert!(matches!(moved.mode, NavigationMode::AnchorRow { .. }));
        let _ = first;
    }

    #[test]
    fn seek_rank_and_stale_navigation_responses_are_exact() {
        let mut hub = ViewportHub::default();
        let all = Predicate::All;
        hub.open("client", all.clone(), SortDirection::Ascending, 10)
            .unwrap();
        seed(&mut hub, &all, SortDirection::Ascending, 1_000_000);
        let deep = request(
            &mut hub,
            "client",
            1,
            NavigationAction::SeekToRank { rank: 900_123 },
        );
        assert_eq!(deep.total_rows, 1_000_000);
        assert_eq!(deep.rows[0], row(12_390, 90));
        assert_eq!(deep.start_rank, 900_123);
        let newer = request(&mut hub, "client", 2, NavigationAction::FollowStart);
        assert!(!hub.accept_response(&deep));
        assert!(hub.accept_response(&newer));
        assert_eq!(hub.snapshot("client").unwrap().rows[0], row(0, 0));
    }

    #[test]
    fn deleting_or_filtering_anchor_falls_back_to_nearest_surviving_rank() {
        let mut hub = ViewportHub::default();
        let all = Predicate::All;
        hub.open("client", all.clone(), SortDirection::Ascending, 10)
            .unwrap();
        seed(&mut hub, &all, SortDirection::Ascending, 100);
        let selected = request(
            &mut hub,
            "client",
            1,
            NavigationAction::SeekToRank { rank: 50 },
        );
        let anchor = selected.rows[0].clone();
        hub.apply_membership_delta(&all, SortDirection::Ascending, anchor.clone(), -1)
            .unwrap();
        hub.complete_boundary().unwrap();
        let fallback = hub.snapshot("client").unwrap();
        assert!(matches!(fallback.mode, NavigationMode::AnchorRow { .. }));
        assert_eq!(fallback.rows[0].id, "000051");

        let generation = hub
            .change_query("client", p("999"), SortDirection::Ascending, 10)
            .unwrap();
        let stale = NavigationRequest {
            query_generation: generation - 1,
            completed_version: hub.completed_version(),
            sequence: 2,
            action: NavigationAction::FollowStart,
        };
        assert!(
            hub.navigate("client", stale)
                .unwrap_err()
                .contains("stale viewport generation")
        );
        // The native query operator emits its matching snapshot through deltas.
        for id in 0..100 {
            hub.apply_membership_delta(&p("999"), SortDirection::Ascending, row(id, 999), 1)
                .unwrap();
        }
        hub.complete_boundary().unwrap();
        let changed_filter = hub.snapshot("client").unwrap();
        assert_eq!(changed_filter.total_rows, 100);
        assert_eq!(changed_filter.rows.len(), 10);
        assert_eq!(changed_filter.query_generation, generation);
    }

    #[test]
    fn identical_subscribers_share_one_ranked_index_and_zero_limit_is_empty() {
        let mut hub = ViewportHub::default();
        for id in ["a", "b"] {
            hub.open(id, Predicate::All, SortDirection::Ascending, 0)
                .unwrap();
        }
        seed(&mut hub, &Predicate::All, SortDirection::Ascending, 20);
        assert_eq!(hub.active_query_shapes(), 1);
        assert_eq!(hub.membership_rows(), 20);
        let end = request(&mut hub, "b", 1, NavigationAction::FollowEnd);
        assert!(end.rows.is_empty());
        assert_eq!(end.total_rows, 20);
    }
}
