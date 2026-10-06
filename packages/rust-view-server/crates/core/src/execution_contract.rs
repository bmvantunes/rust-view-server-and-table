//! Internal product-owned execution records. Completion certifies all submitted changes.
//! Backend time/probes must never appear here.
#[derive(Clone, Debug)]
pub(crate) struct MembershipChange {
    pub shape: u64,
    pub id: String,
    pub order: String,
    pub weight: isize,
}
pub(crate) struct Completion {
    pub changes: Vec<MembershipChange>,
}
