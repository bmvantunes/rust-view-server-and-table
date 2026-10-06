#[path = "support/reference.rs"]
mod reference;
use rust_differential_product_core::{
    engine_contract::{DifferentialProductEngine, EngineCompletion, ProductEngine},
    product::{ProductCommand, ProductResult},
    topic::TopicStore,
};
use serde_json::Value;
use std::collections::BTreeMap;
fn corpus<E: ProductEngine>() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../../../contract-tests/engine-golden.json")).unwrap();
    let mut engine = E::load(TopicStore::default().snapshot()).unwrap();
    let mut checked = 0;
    for (index, step) in fixture["steps"].as_array().unwrap().iter().enumerate() {
        let command: ProductCommand = serde_json::from_value(step["command"].clone()).unwrap();
        let actual = engine.command(command);
        if step["error"].as_bool() == Some(true) {
            assert!(actual.is_err(), "step {index}");
        } else {
            let expected: EngineCompletion =
                serde_json::from_value(step["expected"].clone()).unwrap();
            assert_eq!(
                actual.unwrap(),
                expected,
                "completion {index}: {}",
                step["name"]
            );
        }
        let expected: BTreeMap<String, ProductResult> =
            serde_json::from_value(step["expected"]["results"].clone()).unwrap();
        for (id, result) in expected {
            assert_eq!(
                engine.read(&id),
                Some(result),
                "result {index}: {}",
                step["name"]
            );
            checked += 1;
        }
        assert!(engine.failure().is_none());
    }
    for unsupported in fixture["unsupported"].as_array().unwrap() {
        assert!(serde_json::from_value::<ProductCommand>(unsupported.clone()).is_err());
    }
    assert_eq!(engine.engine_stats().subscriptions, 0);
    assert_eq!(engine.engine_stats().retained_rows, 0);
    println!(
        "ENGINE_GOLDEN {} steps=64 completed_results={checked}",
        std::any::type_name::<E>()
    );
}
#[test]
fn differential_golden() {
    corpus::<DifferentialProductEngine>();
}
#[test]
fn reference_golden() {
    corpus::<reference::ReferenceTestEngine>();
}
