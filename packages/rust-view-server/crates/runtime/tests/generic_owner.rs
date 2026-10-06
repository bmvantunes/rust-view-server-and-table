use product_source_ingestion::{generic_owner::{Owner,Request},subscriptions::SubscriptionLimits};
use rust_differential_product_core::{generic::{Runtime,Mutation},schema::{Catalog,strict_json}};
use serde_json::{json,Value};
fn setup()->(Owner,Value){let value=strict_json(include_bytes!("../../../../../fixtures/topics/catalog.json"),262144).unwrap();let c=Catalog::new(serde_json::from_value(value.clone()).unwrap()).unwrap();let mut rt=Runtime::new(c,5000).unwrap();for(topic,row)in [("orders",json!({"orderId":"same","customer":"Alice","open":true,"units":"18446744073709551615","price":"1.25"})),("positions",json!({"positionId":"same","symbol":"XYZ","quantity":"-9223372036854775808","risk":1.5,"hedged":false}))]{let fp=value["topics"].as_array().unwrap().iter().find(|t|t["topic"]==topic).unwrap()["schema"].as_str().unwrap();rt.apply_committed(topic,fp,&[Mutation::Upsert{row}]).unwrap();} (Owner::new(rt,SubscriptionLimits{per_client:16,total:64}).unwrap(),value)}
fn query(manifest:&Value,topic:&str,select:Value)->Value{let fp=manifest["topics"].as_array().unwrap().iter().find(|t|t["topic"]==topic).unwrap()["schema"].clone();json!({"topic":topic,"schema":fp,"select":select,"order_by":[],"offset":0,"limit":10})}
fn req(id:u64,acq:u64,command:Value)->Request{serde_json::from_value(json!({"id":id,"acquisition":acq,"previous_acquisition":null,"traceparent":"00-11111111111111111111111111111111-1111111111111111-01","command":command})).unwrap()}
#[test]fn cross_topic_replacement_and_invalid_rollback(){let(mut o,m)=setup();let a=o.command(1,&req(1,1,json!({"command":"open","subscription":"same","query":query(&m,"orders",json!(["customer","price"]))}))).unwrap().unwrap();assert_eq!(a.topic,"orders");assert_eq!(a.result["rows"],json!([{"customer":"Alice","price":"1.25"}]));let b=o.command(1,&req(2,2,json!({"command":"change_query","subscription":"same","query":query(&m,"positions",json!(["symbol","quantity"]))}))).unwrap().unwrap();assert_eq!(b.topic,"positions");assert_eq!(b.result["kind"],"snapshot");assert!(o.command(1,&req(3,3,json!({"command":"change_query","subscription":"same","query":query(&m,"orders",json!(["symbol"]))}))).is_err());assert_eq!(o.current(1,"same"),Some(2));let c=o.command(1,&req(4,2,json!({"command":"change_window","subscription":"same","offset":0,"limit":1}))).unwrap().unwrap();assert_eq!(c.result["rows"],json!([{"symbol":"XYZ","quantity":"-9223372036854775808"}]));o.disconnect(1).unwrap();assert_eq!(o.count(),0);}
#[test]fn equal_local_subscription_and_keys_are_connection_isolated(){let(mut o,m)=setup();for(connection,topic,select)in [(1,"orders",json!(["orderId"])),(2,"positions",json!(["positionId"]))]{let p=o.command(connection,&req(1,1,json!({"command":"open","subscription":"same","query":query(&m,topic,select)}))).unwrap().unwrap();assert_eq!(p.topic,topic);}assert_eq!(o.publish_topic("orders").unwrap().len(),0);o.disconnect(1).unwrap();assert_eq!(o.current(2,"same"),Some(1));}

#[test]fn live_resource_growth_scopes_failure_to_connection_and_keeps_derived_cut_safe(){
 for byte_growth in [false,true]{
  let(mut o,m)=setup();let fp=query(&m,"orders",json!(["customer"]))["schema"].as_str().unwrap().to_owned();
  let count=if byte_growth{1100}else{4095};
  let rows=(0..count).map(|i|Mutation::Upsert{row:json!({"orderId":format!("row{i:04}"),"customer":"small","open":true,"units":"1","price":"1"})}).collect::<Vec<_>>();
  for chunk in rows.chunks(1024){o.runtime.apply_committed("orders",&fp,chunk).unwrap();}
  let mut all=query(&m,"orders",json!(["customer"]));all["limit"]=json!(u32::MAX);
  o.command(1,&req(1,1,json!({"command":"open","subscription":"oversized","query":all}))).unwrap();
  o.command(2,&req(1,1,json!({"command":"open","subscription":"healthy","query":query(&m,"positions",json!(["risk"]))}))).unwrap();
  // Source data remains valid. Only the selected result grows beyond its budget.
  let updates=if byte_growth{(0..count).map(|i|Mutation::Upsert{row:json!({"orderId":format!("row{i:04}"),"customer":"x".repeat(4096),"open":true,"units":"1","price":"1"})}).collect::<Vec<_>>()}else{vec![Mutation::Upsert{row:json!({"orderId":"row4096","customer":"small","open":true,"units":"1","price":"1"})}]};
  for chunk in updates.chunks(1024){o.runtime.apply_committed("orders",&fp,chunk).unwrap();}
  assert!(o.publish_topic("orders").unwrap().is_empty());
  assert_eq!(o.take_resource_connections().into_iter().collect::<Vec<_>>(),vec![1]);
  assert!(!o.runtime.terminal());o.disconnect(1).unwrap();assert_eq!(o.count(),1);
  let pp=query(&m,"positions",json!(["risk"]))["schema"].as_str().unwrap().to_owned();
  o.runtime.apply_committed("positions",&pp,&[Mutation::Upsert{row:json!({"positionId":"same","symbol":"XYZ","quantity":"-1","risk":2.5,"hedged":false})}]).unwrap();
  let publications=o.publish_topic("positions").unwrap();assert_eq!(publications.len(),1);assert_eq!(publications[0].connection,2);assert!(!o.runtime.terminal());assert!(o.take_resource_connections().is_empty());
 }
}

#[test]fn grouped_replacement_delta_and_query_failure_leave_raw_alive(){
 let(mut o,m)=setup();let mut grouped=query(&m,"positions",json!(["risk"]));grouped.as_object_mut().unwrap().remove("select");grouped["group_by"]=json!(["symbol"]);grouped["aggregates"]=json!({"n":{"aggFunc":"count"},"sum":{"aggFunc":"sum","field":"risk"}});grouped["order_by"]=json!([{"aggregate":"sum","direction":"desc"}]);
 let raw=query(&m,"positions",json!(["risk"]));o.command(1,&req(1,1,json!({"command":"open","subscription":"raw","query":raw}))).unwrap();
 let first=o.command(1,&req(2,2,json!({"command":"open","subscription":"group","query":grouped}))).unwrap().unwrap();assert_eq!(first.result["result_kind"],"grouped_v1");assert_eq!(first.result["rows"],json!([{"symbol":"XYZ","n":"1","sum":1.5}]));let id=first.result["keys"][0].clone();
 let mut invalid=grouped.clone();invalid["select"]=json!(["risk"]);assert!(o.command(1,&req(3,3,json!({"command":"change_query","subscription":"group","query":invalid}))).is_err());assert_eq!(o.current(1,"group"),Some(2));
 let fp=grouped["schema"].as_str().unwrap();o.runtime.apply_committed("positions",fp,&[Mutation::Upsert{row:json!({"positionId":"same","symbol":"XYZ","quantity":"0","risk":2.5,"hedged":false})}]).unwrap();let published=o.publish_topic("positions").unwrap();let g=published.iter().find(|p|p.subscription=="group").unwrap();assert_eq!(g.result["kind"],"delta");assert_eq!(g.result["operations"][0]["key"],id);assert_eq!(g.result["operations"][0]["row"]["sum"],2.5);
 o.runtime.apply_committed("positions",fp,&[Mutation::Upsert{row:json!({"positionId":"same","symbol":"XYZ","quantity":"0","risk":f64::MAX,"hedged":false})},Mutation::Upsert{row:json!({"positionId":"second","symbol":"XYZ","quantity":"0","risk":f64::MAX,"hedged":false})}]).unwrap();let p=o.publish_topic("positions").unwrap();assert_eq!(p.len(),1);assert_eq!(p[0].subscription,"raw");assert_eq!(o.take_query_errors().len(),1);assert!(o.take_resource_connections().is_empty());assert_eq!(o.current(1,"raw"),Some(1));assert!(!o.runtime.terminal());
 let raw_again=o.command(1,&req(4,4,json!({"command":"open","subscription":"group","query":raw}))).unwrap().unwrap();assert!(raw_again.result.get("result_kind").is_none());assert_eq!(raw_again.result["kind"],"snapshot");
}

#[test]fn grouped_dense_fallback_is_bounded_and_same_version_window_is_snapshot(){
 let(mut o,m)=setup();let mut q=query(&m,"orders",json!(["customer"]));q.as_object_mut().unwrap().remove("select");q["group_by"]=json!(["customer"]);q["aggregates"]=json!({"n":{"aggFunc":"count"},"s":{"aggFunc":"sum","field":"units"}});q["order_by"]=json!([{"aggregate":"s","direction":"desc"}]);q["limit"]=json!(40);let fp=q["schema"].as_str().unwrap().to_string();
 let rows=|shift:u64|(0..30).map(|i|Mutation::Upsert{row:json!({"orderId":format!("r{i}"),"customer":format!("C{i}"),"open":true,"units":(i+shift).to_string(),"price":"0"})}).collect::<Vec<_>>();o.runtime.apply_committed("orders",&fp,&rows(1)).unwrap();let first=o.command(1,&req(1,1,json!({"command":"open","subscription":"groups","query":q}))).unwrap().unwrap();let ids=first.result["keys"].clone();o.runtime.apply_committed("orders",&fp,&rows(100)).unwrap();let changed=o.publish_topic("orders").unwrap();assert_eq!(changed[0].result["kind"],"snapshot");assert_eq!(changed[0].result["keys"],ids);assert_eq!(changed[0].result["rows"].as_array().unwrap().len(),31);
 let before=changed[0].result["version"].clone();let window=o.command(1,&req(2,1,json!({"command":"change_window","subscription":"groups","offset":20,"limit":2}))).unwrap().unwrap();assert_eq!(window.result["version"],before);assert_eq!(window.result["kind"],"snapshot");assert_eq!(window.result["start_rank"],20);assert_eq!(window.result["total_rows"],31);assert_eq!(window.result["rows"].as_array().unwrap().len(),2);
}

#[test]fn cleanup_keeps_peer_shapes_and_rejects_obsolete_acquisitions(){
 let(mut o,m)=setup();let qa=query(&m,"orders",json!(["customer"]));let qb=query(&m,"positions",json!(["symbol"]));
 o.command(1,&req(1,1,json!({"command":"open","subscription":"a","query":qa}))).unwrap();
 o.command(1,&req(2,2,json!({"command":"open","subscription":"b","query":qb}))).unwrap();
 assert_eq!(o.count(),2);assert_eq!(o.runtime.metrics()["shapes"],2);
 o.command(1,&req(3,3,json!({"command":"change_query","subscription":"a","query":qa}))).unwrap();
 assert!(o.command(1,&req(4,1,json!({"command":"close","subscription":"a"}))).err().unwrap().contains("obsolete"));
 assert_eq!(o.count(),2);assert_eq!(o.runtime.metrics()["shapes"],2);assert_eq!(o.current(1,"a"),Some(3));
 assert!(o.command(1,&req(5,3,json!({"command":"close","subscription":"a"}))).unwrap().is_none());
 assert_eq!(o.count(),1);assert_eq!(o.runtime.metrics()["shapes"],1);assert_eq!(o.current(1,"b"),Some(2));
 o.disconnect(1).unwrap();assert_eq!(o.count(),0);assert_eq!(o.runtime.metrics()["shapes"],0);
}
#[test]fn global_having_wire_shape_and_replacement_rollback(){let(mut o,m)=setup();let mut q=query(&m,"orders",json!(["customer"]));q.as_object_mut().unwrap().remove("select");q["global"]=json!(true);q["aggregates"]=json!({"n":{"aggFunc":"count"},"sum":{"aggFunc":"sum","field":"price"}});q["order_by"]=json!([]);q["having"]=json!({"op":"ge","field":"n","value":"1"});let a=o.command(1,&req(1,1,json!({"command":"open","subscription":"global","query":q}))).unwrap().unwrap();assert_eq!(a.result["result_kind"],"global_v1");assert_eq!(a.result["total_rows"],1);assert!(a.result["keys"][0].as_str().unwrap().starts_with("global1:"));let mut bad=q.clone();bad["having"]=json!({"op":"eq","field":"customer","value":"Alice"});assert!(o.command(1,&req(2,2,json!({"command":"change_query","subscription":"global","query":bad}))).is_err());assert_eq!(o.current(1,"global"),Some(1));let mut empty=q;empty["having"]=json!({"op":"gt","field":"n","value":"99"});let b=o.command(1,&req(3,3,json!({"command":"change_query","subscription":"global","query":empty}))).unwrap().unwrap();assert_eq!(b.result["total_rows"],0);assert_eq!(b.result["kind"],"snapshot");}

#[test]
fn join_output_admission_uses_left_source_ceiling() {
    use std::collections::BTreeMap;
    let request: product_source_ingestion::generic_owner::Request = serde_json::from_value(serde_json::json!({"id":1,"acquisition":1,"previous_acquisition":null,"traceparent":"0000000000000000000000000000000000000000000000000000000","command":{"command":"open","subscription":"bound","query":{"topic":"left","schema":"unused","join":{"version":1,"left_alias":"l","right":{"topic":"right","schema":"unused","alias":"r"},"kind":"left","cardinality":"many_to_one","on":{"left":"key","right":"key"},"limits":{"max_left_rows_per_key":4,"max_output_rows":101}},"select":["l.key"],"order_by":[],"offset":0,"limit":10}}})).unwrap();
    let limits=BTreeMap::from([("left".into(),100),("right".into(),10000)]);
    assert!(!request.join_output_within_source_limit(&limits));
    assert!(request.join_output_within_source_limit(&BTreeMap::from([("left".into(),101)])));
    assert!(!request.join_output_within_source_limit(&BTreeMap::new()));
}
