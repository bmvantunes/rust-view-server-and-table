use product_source_ingestion::row_delta::{batch_with_patches,Baseline};
use serde_json::{json,Value};
fn result(row:Value)->Value {json!({"subscription":"p","topic":"nested","schema":"fingerprint","query_generation":1,"sequence":1,"version":1,"start_rank":0,"total_rows":1,"keys":["key"],"rows":[row]})}
fn seed()->(Vec<String>,Baseline) {let fields=vec!["details.note".into(),"details.extra".into(),"wide".into()];let (_,base)=batch_with_patches(None,1,&fields,result(json!({"details":{"note":"before"},"wide":"x".repeat(2048)})),true,true);(fields,base)}
#[test]fn projected_patches_and_actual_msgpack_savings(){
 let(fields,base)=seed();let next=result(json!({"details":{"note":null,"extra":false},"wide":"x".repeat(2048)}));
 let(full,_)=batch_with_patches(Some(&base),1,&fields,next.clone(),false,false);let(small,_)=batch_with_patches(Some(&base),1,&fields,next,false,true);
 assert_eq!(full["operations"][0]["type"],"update");assert_eq!(small["operations"][0]["type"],"patch");assert_eq!(small["operations"][0]["changes"],json!([{"type":"set","path":"details.extra","value":false},{"type":"set","path":"details.note","value":null}]));
 assert!(v13_codec_experiment::generic::encode(&small).unwrap().len()<v13_codec_experiment::generic::encode(&full).unwrap().len()/2);
 println!("VECTOR:{}",json!({"projection":fields,"snapshot":batch_with_patches(None,1,&fields,base.result.clone(),true,true).0,"delta":small,"full":full}));
}
#[test]fn parent_presence_recovery_and_shape_binding(){
 let(fields,base)=seed();let(next,absent)=batch_with_patches(Some(&base),1,&fields,result(json!({"wide":"x".repeat(2048)})),false,true);assert_eq!(next["operations"][0]["changes"],json!([{"type":"remove","path":"details"}]));
 let(next,empty)=batch_with_patches(Some(&absent),1,&fields,result(json!({"details":{},"wide":"x".repeat(2048)})),false,true);assert_eq!(next["operations"][0]["changes"],json!([{"type":"object","path":"details"}]));
 let mut value=empty.result.clone();value["schema"]=json!("new");assert_eq!(batch_with_patches(Some(&empty),1,&fields,value,false,true).0["kind"],"snapshot");
 assert_eq!(batch_with_patches(Some(&empty),2,&fields,empty.result.clone(),false,true).0["kind"],"snapshot");
}
#[test]fn small_and_dense_fallback(){
 let projection=vec!["n".into()];let (_,base)=batch_with_patches(None,1,&projection,result(json!({"n":0})),true,true);let (next,_)=batch_with_patches(Some(&base),1,&projection,result(json!({"n":1})),false,true);assert_eq!(next["operations"][0]["type"],"update");
 let mut a=result(json!({"n":0}));a["keys"]=json!((0..20).map(|i|i.to_string()).collect::<Vec<_>>());a["rows"]=json!((0..20).map(|_|json!({"n":0})).collect::<Vec<_>>());a["total_rows"]=json!(20);let (_,b)=batch_with_patches(None,1,&projection,a.clone(),true,true);a["rows"]=json!((0..20).map(|_|json!({"n":1})).collect::<Vec<_>>());assert_eq!(batch_with_patches(Some(&b),1,&projection,a,false,true).0["kind"],"snapshot");
}

#[test]fn nullable_relation_parent_transitions_use_full_row_fallback(){
 let(fields,base)=seed();let null=result(json!({"details":null,"wide":"x".repeat(2048)}));
 let(frame,null_base)=batch_with_patches(Some(&base),1,&fields,null,false,true);assert_eq!(frame["operations"][0]["type"],"update");assert!(frame["operations"][0]["row"]["details"].is_null());
 let(frame,matched)=batch_with_patches(Some(&null_base),1,&fields,result(json!({"details":{"note":"matched"},"wide":"x".repeat(2048)})),false,true);assert_eq!(frame["operations"][0]["type"],"update");
 let(frame,_)=batch_with_patches(Some(&matched),1,&fields,result(json!({"details":{"note":"changed"},"wide":"x".repeat(2048)})),false,true);assert_eq!(frame["operations"][0]["type"],"patch");
}
