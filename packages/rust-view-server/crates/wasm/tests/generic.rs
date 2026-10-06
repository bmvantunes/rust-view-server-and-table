use view_server_generic_wasm::LocalEngine;
use rust_differential_product_core::{schema::{Catalog, Manifest},generic::{Runtime, Mutation}};
use serde_json::{json, Value};

fn catalog() -> Manifest {
    let definition = json!({"format":1,"id":"orders","version":1,"key":"id","fields":[
        {"name":"id","kind":"string","optional":false,"nullable":false},
        {"name":"label","kind":"string","optional":true,"nullable":true},
        {"name":"units","kind":"uint64","optional":false,"nullable":false}
    ]});
    let schema = rust_differential_product_core::schema::Schema::new(serde_json::from_value(definition.clone()).unwrap()).unwrap();
    serde_json::from_value(json!({"format":1,"schemas":[definition],"topics":[{"topic":"orders","schema":schema.fingerprint()}]})).unwrap()
}
fn call(engine: &mut LocalEngine, value: Value) -> Result<Value, String> {
    engine.command(&serde_json::to_vec(&value).unwrap())
}
fn initialized() -> (LocalEngine, String) {
    let catalog = catalog();
    let fp = Catalog::new(catalog.clone()).unwrap().topics().next().unwrap().1.fingerprint().to_owned();
    let mut engine = LocalEngine::default();
    call(&mut engine, json!({"command":"initialize","catalog":catalog,"max_rows":32})).unwrap();
    (engine, fp)
}
fn publish(engine: &mut LocalEngine, fp: &str, units: &str) {
    call(engine,json!({"command":"apply","topic":"orders","schema":fp,"mutations":[{"kind":"upsert","row":{"id":"same","label":null,"units":units}}]})).unwrap();
}
fn open(engine: &mut LocalEngine, fp: &str, query: Value) {
    call(engine,json!({"command":"open","subscription":"same","topic":"orders","schema":fp,"query":query})).unwrap();
}
fn read(engine: &mut LocalEngine) -> Value {
    call(engine,json!({"command":"read","subscription":"same","offset":0,"limit":32,"max_bytes":65536})).unwrap()
}

#[test]
fn same_names_live_instances_are_isolated_and_match_native_generic_engine() {
    let (mut left, fp) = initialized();
    let (mut right, _) = initialized();
    publish(&mut left, &fp, "18446744073709551615");
    publish(&mut right, &fp, "2");
    let query = json!({"select":["units","label"],"order_by":[]});
    open(&mut left, &fp, query.clone());
    open(&mut right, &fp, query.clone());
    assert_eq!(read(&mut left)["rows"],json!([{"units":"18446744073709551615","label":null}]));
    assert_eq!(read(&mut right)["rows"],json!([{"units":"2","label":null}]));
    let mut native = Runtime::new(Catalog::new(catalog()).unwrap(),32).unwrap();
    native.apply_committed("orders",&fp,&[Mutation::Upsert{row:json!({"id":"same","label":null,"units":"18446744073709551615"})}]).unwrap();
    native.open("same","orders",&fp,serde_json::from_value(query).unwrap()).unwrap();
    assert_eq!(read(&mut left),serde_json::to_value(native.read("same",0,32,65536).unwrap()).unwrap());
    call(&mut left,json!({"command":"apply","topic":"orders","schema":fp,"mutations":[{"kind":"delete","key":"same"}]})).unwrap();
    assert_eq!(read(&mut left)["total_rows"],0);
    assert_eq!(read(&mut right)["rows"][0]["units"],"2");
}

#[test]
fn rejected_mutation_and_query_preserve_predecessor_then_global_having_executes() {
    let (mut engine, fp) = initialized();
    publish(&mut engine,&fp,"3");
    open(&mut engine,&fp,json!({"select":["units"],"order_by":[]}));
    let before = read(&mut engine);
    assert!(call(&mut engine,json!({"command":"apply","topic":"orders","schema":fp,"mutations":[{"kind":"upsert","row":{"id":"same","units":"-1"}}]})).is_err());
    assert!(call(&mut engine,json!({"command":"open","subscription":"same","topic":"orders","schema":fp,"query":{"select":["absent"],"order_by":[]}})).is_err());
    assert_eq!(read(&mut engine),before);
    open(&mut engine,&fp,json!({"global":true,"aggregates":{"sum":{"aggFunc":"sum","field":"units"}},"having":{"op":"gt","field":"sum","value":"2"},"order_by":[]}));
    assert_eq!(read(&mut engine)["rows"],json!([{"sum":"3"}]));
}
