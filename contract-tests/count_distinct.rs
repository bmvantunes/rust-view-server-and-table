//! Engine-neutral, TEST-ONLY bounded CountDistinct contract. No DD/Timely types.
//! A missing or null field each contributes its own distinct value (not SQL COUNT).
//! Groups disappear only when their last source row disappears. Counts are exact;
//! this small fixture represents them as u64, not as a production numeric restriction.
use std::collections::{BTreeMap, BTreeSet};
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum Value {
    Missing,
    Null,
    Text(String),
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Row {
    pub id: String,
    pub group: String,
    pub value: Value,
}
#[derive(Clone, Debug)]
pub enum Mutation {
    Put(Row),
    Delete(String),
}
#[derive(Debug, Eq, PartialEq)]
pub struct Completed {
    pub epoch: u64,
    pub groups: BTreeMap<String, u64>,
}
pub trait CountDistinctBackend {
    fn apply_complete(&mut self, batch: &[Mutation]) -> Completed;
}
fn put(id: &str, group: &str, value: Value) -> Mutation {
    Mutation::Put(Row {
        id: id.into(),
        group: group.into(),
        value,
    })
}
fn text(s: &str) -> Value {
    Value::Text(s.into())
}
fn del(id: &str) -> Mutation {
    Mutation::Delete(id.into())
}
pub fn check_contract(backend: &mut impl CountDistinctBackend) {
    let batches = vec![
        ("first insertion", vec![put("1", "a", text("x"))]),
        ("duplicate insertion", vec![put("2", "a", text("x"))]),
        ("remove one of several duplicates", vec![del("1")]),
        ("remove last occurrence", vec![del("2")]),
        (
            "reinsert after completed deletion",
            vec![put("1", "a", text("x")), put("2", "a", text("y"))],
        ),
        ("move value between groups", vec![put("1", "b", text("x"))]),
        ("value to null", vec![put("2", "a", Value::Null)]),
        ("duplicate null", vec![put("3", "a", Value::Null)]),
        (
            "null to value with duplicate remaining",
            vec![put("2", "a", text("z"))],
        ),
        ("remove last null", vec![del("3")]),
        (
            "missing differs from null and empty",
            vec![
                put("4", "a", Value::Missing),
                put("5", "a", Value::Null),
                put("6", "a", text("")),
            ],
        ),
        ("missing to null", vec![put("4", "a", Value::Null)]),
        (
            "cancelling changes in epoch",
            vec![put("temp", "c", text("t")), del("temp")],
        ),
        (
            "delete reinsert within epoch",
            vec![del("1"), put("1", "b", text("x"))],
        ),
        (
            "delete everything",
            vec![del("1"), del("2"), del("4"), del("5"), del("6")],
        ),
        (
            "reinsert after empty completed epoch",
            vec![put("7", "b", Value::Null)],
        ),
        ("null to missing", vec![put("7", "b", Value::Missing)]),
        ("null value and missing final deletion", vec![del("7")]),
    ];
    let mut retained = BTreeMap::new();
    for (epoch, (name, batch)) in batches.into_iter().enumerate() {
        for change in &batch {
            match change {
                Mutation::Put(row) => {
                    retained.insert(row.id.clone(), row.clone());
                }
                Mutation::Delete(id) => {
                    retained.remove(id);
                }
            }
        }
        // Independent recomputation from keyed source rows: never candidate output.
        let mut sets: BTreeMap<String, BTreeSet<Value>> = BTreeMap::new();
        for row in retained.values() {
            sets.entry(row.group.clone())
                .or_default()
                .insert(row.value.clone());
        }
        let expected = Completed {
            epoch: epoch as u64,
            groups: sets.into_iter().map(|(g, s)| (g, s.len() as u64)).collect(),
        };
        let actual = backend.apply_complete(&batch);
        println!(
            "COUNT_DISTINCT_CONTRACT case={name} input={batch:?} completed={actual:?} oracle={expected:?}"
        );
        assert_eq!(actual, expected, "completed result mismatch: {name}");
    }
}
