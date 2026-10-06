//! AVL order-statistic tree used by the follow-up's maintained ordering index.
//! Selection and identity-to-rank lookup are O(log n); applying a replacement
//! costs two O(log n) tree operations. This is deliberately real candidate
//! state, rather than a benchmark-only oracle shortcut.

use std::cmp::Ordering;

use super::{Row, SortDirection, ordering::compare_sort_key};

type Link = Option<Box<Node>>;

struct Node {
    row: Row,
    left: Link,
    right: Link,
    height: i16,
    size: usize,
}

impl Node {
    fn new(row: Row) -> Box<Self> {
        Box::new(Self {
            row,
            left: None,
            right: None,
            height: 1,
            size: 1,
        })
    }
}

fn height(link: &Link) -> i16 {
    link.as_ref().map_or(0, |n| n.height)
}
fn size(link: &Link) -> usize {
    link.as_ref().map_or(0, |n| n.size)
}

fn refresh(node: &mut Box<Node>) {
    node.height = 1 + height(&node.left).max(height(&node.right));
    node.size = 1 + size(&node.left) + size(&node.right);
}

fn rotate_right(mut root: Box<Node>) -> Box<Node> {
    let mut pivot = root.left.take().expect("right rotation has a left child");
    root.left = pivot.right.take();
    refresh(&mut root);
    pivot.right = Some(root);
    refresh(&mut pivot);
    pivot
}

fn rotate_left(mut root: Box<Node>) -> Box<Node> {
    let mut pivot = root.right.take().expect("left rotation has a right child");
    root.right = pivot.left.take();
    refresh(&mut root);
    pivot.left = Some(root);
    refresh(&mut pivot);
    pivot
}

fn balance(mut root: Box<Node>) -> Box<Node> {
    refresh(&mut root);
    let skew = height(&root.left) - height(&root.right);
    if skew > 1 {
        if height(&root.left.as_ref().unwrap().right) > height(&root.left.as_ref().unwrap().left) {
            root.left = root.left.take().map(rotate_left);
        }
        return rotate_right(root);
    }
    if skew < -1 {
        if height(&root.right.as_ref().unwrap().left) > height(&root.right.as_ref().unwrap().right)
        {
            root.right = root.right.take().map(rotate_right);
        }
        return rotate_left(root);
    }
    root
}

fn cmp(direction: SortDirection, left: &Row, right: &Row) -> Ordering {
    compare_sort_key(
        direction,
        &left.sort_key,
        &left.id,
        &right.sort_key,
        &right.id,
    )
}

fn insert(link: Link, row: Row, direction: SortDirection) -> (Link, bool) {
    let Some(mut root) = link else {
        return (Some(Node::new(row)), true);
    };
    let inserted = match cmp(direction, &row, &root.row) {
        Ordering::Less => {
            let (next, inserted) = insert(root.left.take(), row, direction);
            root.left = next;
            inserted
        }
        Ordering::Greater => {
            let (next, inserted) = insert(root.right.take(), row, direction);
            root.right = next;
            inserted
        }
        Ordering::Equal => return (Some(root), false),
    };
    (Some(balance(root)), inserted)
}

fn pop_min(mut root: Box<Node>) -> (Link, Box<Node>) {
    match root.left.take() {
        None => (root.right.take(), root),
        Some(left) => {
            let (next_left, min) = pop_min(left);
            root.left = next_left;
            (Some(balance(root)), min)
        }
    }
}

fn remove(link: Link, row: &Row, direction: SortDirection) -> (Link, bool) {
    let Some(mut root) = link else {
        return (None, false);
    };
    let removed = match cmp(direction, row, &root.row) {
        Ordering::Less => {
            let (next, removed) = remove(root.left.take(), row, direction);
            root.left = next;
            removed
        }
        Ordering::Greater => {
            let (next, removed) = remove(root.right.take(), row, direction);
            root.right = next;
            removed
        }
        Ordering::Equal => {
            return match (root.left.take(), root.right.take()) {
                (None, right) => (right, true),
                (left, None) => (left, true),
                (left, Some(right)) => {
                    let (new_right, mut successor) = pop_min(right);
                    successor.left = left;
                    successor.right = new_right;
                    (Some(balance(successor)), true)
                }
            };
        }
    };
    (Some(balance(root)), removed)
}

fn select(node: &Node, rank: usize) -> Option<&Row> {
    let left_size = size(&node.left);
    match rank.cmp(&left_size) {
        Ordering::Less => select(node.left.as_ref()?, rank),
        Ordering::Equal => Some(&node.row),
        Ordering::Greater => select(node.right.as_ref()?, rank - left_size - 1),
    }
}

fn rank_of(node: &Node, row: &Row, direction: SortDirection, base: usize) -> Option<usize> {
    match cmp(direction, row, &node.row) {
        Ordering::Less => rank_of(node.left.as_ref()?, row, direction, base),
        Ordering::Equal => Some(base + size(&node.left)),
        Ordering::Greater => rank_of(
            node.right.as_ref()?,
            row,
            direction,
            base + size(&node.left) + 1,
        ),
    }
}

fn collect_window(node: &Node, skip: usize, remaining: &mut usize, out: &mut Vec<Row>) {
    if *remaining == 0 {
        return;
    }
    let left_size = size(&node.left);
    if skip < left_size {
        if let Some(left) = &node.left {
            collect_window(left, skip, remaining, out);
        }
    }
    if *remaining == 0 {
        return;
    }
    if skip <= left_size {
        out.push(node.row.clone());
        *remaining -= 1;
    }
    let right_skip = skip.saturating_sub(left_size + 1);
    if *remaining > 0
        && let Some(right) = &node.right
    {
        collect_window(right, right_skip, remaining, out);
    }
}

#[derive(Default)]
pub struct RankedRows {
    root: Link,
    direction: Option<SortDirection>,
}

impl RankedRows {
    pub fn len(&self) -> usize {
        size(&self.root)
    }
    pub fn is_empty(&self) -> bool {
        self.root.is_none()
    }

    pub fn insert(&mut self, row: Row, direction: SortDirection) -> bool {
        assert!(
            self.direction.is_none_or(|known| known == direction),
            "cannot mix sort directions in one maintained index"
        );
        self.direction = Some(direction);
        let (root, inserted) = insert(self.root.take(), row, direction);
        self.root = root;
        inserted
    }

    pub fn remove(&mut self, row: &Row, direction: SortDirection) -> bool {
        assert!(
            self.direction.is_none_or(|known| known == direction),
            "cannot mix sort directions in one maintained index"
        );
        let (root, removed) = remove(self.root.take(), row, direction);
        self.root = root;
        if self.root.is_none() {
            self.direction = None;
        }
        removed
    }

    pub fn select(&self, rank: usize) -> Option<&Row> {
        select(self.root.as_ref()?, rank)
    }

    pub fn rank_of(&self, row: &Row, direction: SortDirection) -> Option<usize> {
        if self.direction.is_some_and(|known| known != direction) {
            return None;
        }
        rank_of(self.root.as_ref()?, row, direction, 0)
    }

    pub fn window(&self, offset: usize, limit: usize) -> Vec<Row> {
        let mut out = Vec::with_capacity(limit.min(self.len().saturating_sub(offset)));
        if limit > 0
            && let Some(root) = &self.root
        {
            collect_window(root, offset, &mut limit.clone(), &mut out);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn row(id: usize, payload: usize) -> Row {
        Row {
            id: format!("{id:06}"),
            payload: format!("{payload:03}"),
            sort_key: format!("{payload:03}"),
        }
    }

    #[test]
    fn rank_select_windows_match_sorted_reference_after_mutations() {
        for direction in [SortDirection::Ascending, SortDirection::Descending] {
            let mut actual = RankedRows::default();
            let mut expected = BTreeSet::<(String, String)>::new();
            for i in 0..4096 {
                let item = row(i, (i * 37) % 100);
                assert!(actual.insert(item.clone(), direction));
                expected.insert((item.payload, item.id));
            }
            for i in (0..4096).step_by(3) {
                let old = row(i, (i * 37) % 100);
                assert!(actual.remove(&old, direction));
                expected.remove(&(old.payload, old.id));
                let next = row(i, (i * 53 + 7) % 100);
                assert!(actual.insert(next.clone(), direction));
                expected.insert((next.payload, next.id));
            }
            let ordered: Vec<Row> = expected
                .iter()
                .map(|(payload, id)| Row {
                    id: id.clone(),
                    payload: payload.clone(),
                    sort_key: payload.clone(),
                })
                .collect();
            let ordered = if direction == SortDirection::Ascending {
                ordered
            } else {
                let mut rows = ordered;
                rows.sort_by(|a, b| cmp(direction, a, b));
                rows
            };
            assert_eq!(actual.len(), ordered.len());
            for rank in [0, 1, 63, 1000, 2047, 4000, ordered.len() - 1] {
                assert_eq!(actual.select(rank), Some(&ordered[rank]));
                assert_eq!(actual.rank_of(&ordered[rank], direction), Some(rank));
            }
            for (offset, limit) in [
                (0, 20),
                (1000, 40),
                (ordered.len() - 17, 50),
                (ordered.len(), 10),
            ] {
                assert_eq!(
                    actual.window(offset, limit),
                    ordered
                        .iter()
                        .skip(offset)
                        .take(limit)
                        .cloned()
                        .collect::<Vec<_>>()
                );
            }
        }
    }
}
