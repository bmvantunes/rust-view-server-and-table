use rust_differential_product_core::{generic::{Mutation,Runtime},schema::{Catalog,Manifest,Schema,Topic},retention::{RetentionPolicy,expiry_ms},typed_source::{TypedSource,SourceDefinition}};
use view_server_generic_wasm::LocalEngine;
use serde_json::{json,Value};
use std::collections::BTreeMap;
fn call(local:&mut LocalEngine,command:&Value)->Value{local.command(&serde_json::to_vec(command).unwrap()).unwrap()}
#[test]
fn generated_typed_source_and_controlled_cuts_match_native_local_and_browser_corpus(){
 let manifest:Manifest=serde_json::from_str(include_str!("../../../../../fixtures/proto-topics/catalog.json")).unwrap();
 let definition=manifest.schemas.into_iter().find(|s|s.id=="orders_v2").unwrap();let schema=Schema::new(definition.clone()).unwrap();let fp=schema.fingerprint().to_owned();
 let bindings:Value=serde_json::from_str(include_str!("../../../../../fixtures/proto-topics/source-bindings.json")).unwrap();
 let metadata=json!({"keyFields":bindings["SimpleKey"]["key_fields"],"identity":{"source_policy":"compact","components":[{"source":"key","field":"id"}]}});
 let source:SourceDefinition=serde_json::from_value(metadata.clone()).unwrap();let source=TypedSource::new(schema,source).unwrap();
 let manifest=Manifest{format:1,schemas:vec![definition],topics:vec![Topic{topic:"client_orders".into(),schema:fp.clone()}]};
 let mut native=Runtime::new(Catalog::new(manifest.clone()).unwrap(),32).unwrap();let mut local=LocalEngine::default();
 let policy:RetentionPolicy=serde_json::from_value(json!({"maxRetentionMinutes":0.00002})).unwrap();let age=policy.normalize(rust_differential_product_core::typed_source::SourcePolicy::Compact,32).unwrap().max_age_ms.unwrap();
 call(&mut local,&json!({"command":"initialize","catalog":manifest,"max_rows":32,"sources":{"client_orders":metadata},"retention":{"client_orders":policy},"now_ms":0}));
 let corpus:Value=serde_json::from_str(include_str!("../../../../../fixtures/native-wasm-parity.json")).unwrap();
 for (name,query) in corpus["queries"].as_object().unwrap(){native.open(name,"client_orders",&fp,serde_json::from_value(query.clone()).unwrap()).unwrap();call(&mut local,&json!({"command":"open","subscription":name,"topic":"client_orders","schema":fp,"query":query}));}
 let mut now=0;let mut expiry=BTreeMap::<String,u64>::new();
 for (cut,step) in corpus["actions"].as_array().unwrap().iter().enumerate(){let command=&step["command"];
  match command["command"].as_str().unwrap(){
   "publish"=>{let mutation=source.admit(&command["key"],Some(&command["value"])).unwrap();let Mutation::Upsert{row}= &mutation else{panic!("corpus upsert")};expiry.insert(row["rowId"].as_str().unwrap().to_owned(),expiry_ms(now,age).unwrap());native.apply_committed("client_orders",&fp,&[mutation]).unwrap();},
   "advance_time"=>{now+=command["milliseconds"].as_u64().unwrap();let due=expiry.iter().filter(|(_,at)|**at<=now).map(|(id,_)|id.clone()).collect::<Vec<_>>();if !due.is_empty(){native.apply_committed("client_orders",&fp,&due.iter().map(|key|Mutation::Delete{key:key.clone()}).collect::<Vec<_>>()).unwrap();for key in due{expiry.remove(&key);}}},_=>panic!("corpus command")
  }
  call(&mut local,command);
  for name in ["raw","groups"]{let expected=serde_json::to_value(native.read(name,0,32,65536).unwrap()).unwrap();let actual=call(&mut local,&json!({"command":"read","subscription":name,"offset":0,"limit":32,"max_bytes":65536}));assert_eq!(actual,expected,"native vs local cut {cut} {name}");assert_eq!(actual["rows"],step[name],"shared browser corpus cut {cut} {name}");}
 }
}
