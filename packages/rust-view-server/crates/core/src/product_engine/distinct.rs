//! Isize-weighted total-order backend safeguard, verified on Differential 0.25.1.
//! No public aggregate grammar is added. Retain after upgrades until independently retested.
use differential_dataflow::{
    ExchangeData, VecCollection, hashable::Hashable, operators::ThresholdTotal,
};

// ProductCore currently has no CountDistinct path; the contract adapter and isolated
// investigation exercise this reserved backend helper without exposing a new product API.
#[allow(dead_code)]
pub(crate) fn distinct_nonzero<'scope, K: ExchangeData + Hashable>(
    input: VecCollection<'scope, u64, K, isize>,
) -> VecCollection<'scope, u64, K, isize> {
    // `count` is accumulated multiplicity, not an individual input update.
    input.threshold_total(|_, count: &isize| (*count != 0) as isize)
}
