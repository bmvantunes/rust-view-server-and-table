use std::cmp::Ordering;
#[cfg(all(test, feature = "differential-engine"))]
use std::collections::BTreeMap;

#[cfg(all(test, feature = "differential-engine"))]
use super::RankedRows;
use super::SortDirection;
#[cfg(all(test, feature = "differential-engine"))]
use super::{Row, ViewResult, WindowRequest};

pub(crate) fn compare_sort_key(
    direction: SortDirection,
    left_sort_key: &str,
    left_id: &str,
    right_sort_key: &str,
    right_id: &str,
) -> Ordering {
    let payload_order = match direction {
        SortDirection::Ascending => left_sort_key.cmp(right_sort_key),
        SortDirection::Descending => right_sort_key.cmp(left_sort_key),
    };
    payload_order.then_with(|| left_id.cmp(right_id))
}

#[cfg(all(test, feature = "differential-engine"))]
#[derive(Clone, Debug)]
struct Subscriber {
    predicate: u64,
    sort: SortDirection,
    window: WindowRequest,
}

#[cfg(all(test, feature = "differential-engine"))]
#[derive(Default)]
pub(crate) struct MaintainedViewIndex {
    memberships: BTreeMap<u64, BTreeMap<String, Row>>,
    orderings: BTreeMap<(u64, SortDirection), RankedRows>,
    ordering_refs: BTreeMap<(u64, SortDirection), usize>,
    subscribers: BTreeMap<String, Subscriber>,
}

#[cfg(all(test, feature = "differential-engine"))]
impl MaintainedViewIndex {
    pub(crate) fn set_subscriber(
        &mut self,
        id: String,
        predicate: u64,
        sort: SortDirection,
        window: WindowRequest,
    ) {
        if let Some(old) = self.subscribers.remove(&id) {
            self.release_ordering(old.predicate, old.sort);
        }
        let key = (predicate, sort);
        if !self.orderings.contains_key(&key) {
            let rows = self.memberships.get(&predicate);
            let mut ordered = RankedRows::default();
            for row in rows.into_iter().flat_map(|rows| rows.values()) {
                ordered.insert(row.clone(), sort);
            }
            self.orderings.insert(key, ordered);
        }
        *self.ordering_refs.entry(key).or_default() += 1;
        self.subscribers.insert(
            id,
            Subscriber {
                predicate,
                sort,
                window,
            },
        );
    }

    pub(crate) fn remove_subscriber(&mut self, id: &str) {
        if let Some(old) = self.subscribers.remove(id) {
            self.release_ordering(old.predicate, old.sort);
        }
    }

    pub(crate) fn apply_membership_delta(
        &mut self,
        predicate: u64,
        row: Row,
        diff: isize,
    ) -> Result<(), String> {
        let rows = self.memberships.entry(predicate).or_default();
        match diff {
            1 => {
                if rows.insert(row.id.clone(), row.clone()).is_some() {
                    return Err(format!(
                        "Differential emitted duplicate membership for row {}",
                        row.id
                    ));
                }
                for ((pid, direction), ordered) in &mut self.orderings {
                    if *pid == predicate {
                        if !ordered.insert(row.clone(), *direction) {
                            return Err(format!(
                                "Differential ranked index duplicate row {}",
                                row.id
                            ));
                        }
                    }
                }
            }
            -1 => {
                let old = rows.remove(&row.id).ok_or_else(|| {
                    format!(
                        "Differential retracted missing membership for row {}",
                        row.id
                    )
                })?;
                if old != row {
                    return Err(format!("Differential retracted stale row {}", row.id));
                }
                for ((pid, direction), ordered) in &mut self.orderings {
                    if *pid == predicate {
                        if !ordered.remove(&row, *direction) {
                            return Err(format!(
                                "Differential ranked index missing row {}",
                                row.id
                            ));
                        }
                    }
                }
            }
            other => return Err(format!("unexpected Differential membership weight {other}")),
        }
        Ok(())
    }

    pub(crate) fn result(&self, id: &str) -> Option<ViewResult> {
        let sub = self.subscribers.get(id)?;
        let rows = self.memberships.get(&sub.predicate);
        let total_rows = rows.map_or(0, |rows| rows.len() as u64);
        let (offset, limit) = sub.window.checked().ok()?;
        let ordered = self.orderings.get(&(sub.predicate, sub.sort));
        let selected = ordered.map_or_else(Vec::new, |ordered| ordered.window(offset, limit));
        Some(ViewResult {
            rows: selected,
            total_rows,
        })
    }

    pub(crate) fn subscriber_ids(&self) -> Vec<String> {
        self.subscribers.keys().cloned().collect()
    }
    pub(crate) fn active_windows(&self) -> usize {
        self.subscribers.len()
    }
    pub(crate) fn active_query_shapes(&self) -> usize {
        self.orderings.len()
    }
    pub(crate) fn matching_memberships(&self) -> usize {
        self.memberships.values().map(BTreeMap::len).sum()
    }
    pub(crate) fn output_rows(&self) -> usize {
        self.subscribers
            .keys()
            .filter_map(|id| self.result(id))
            .map(|r| r.rows.len())
            .sum()
    }

    pub(crate) fn prune_inactive_predicates(&mut self) {
        let active = self
            .orderings
            .keys()
            .map(|(predicate, _)| *predicate)
            .collect::<std::collections::BTreeSet<_>>();
        self.memberships
            .retain(|predicate, _| active.contains(predicate));
    }

    fn release_ordering(&mut self, predicate: u64, sort: SortDirection) {
        let key = (predicate, sort);
        if let Some(refs) = self.ordering_refs.get_mut(&key) {
            *refs -= 1;
            if *refs == 0 {
                self.ordering_refs.remove(&key);
                self.orderings.remove(&key);
            }
        }
    }
}

#[cfg(all(test, feature = "differential-engine"))]
mod tests {
    use super::*;

    #[test]
    fn closed_predicate_membership_is_pruned_after_retractions() {
        let mut index = MaintainedViewIndex::default();
        index.set_subscriber(
            "sub".into(),
            1,
            SortDirection::Ascending,
            WindowRequest {
                offset: 0,
                limit: 10,
            },
        );
        let row = Row {
            id: "row".into(),
            payload: "value".into(),
            sort_key: "value".into(),
        };
        index.apply_membership_delta(1, row.clone(), 1).unwrap();
        index.remove_subscriber("sub");
        index.apply_membership_delta(1, row, -1).unwrap();
        index.prune_inactive_predicates();
        assert!(!index.memberships.contains_key(&1));
        assert_eq!(index.active_query_shapes(), 0);
        assert_eq!(index.matching_memberships(), 0);
    }
}
