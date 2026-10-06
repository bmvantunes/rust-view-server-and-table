use rust_differential_product_core::{generic::{Runtime,Mutation},schema::{Schema,Catalog}};
use serde_json::{json,Value};
fn runtime()->(Runtime,String){
 let schema=Schema::new(serde_json::from_value(json!({"format":1,"id":"test","version":1,"key":"id","fields":[
 {"name":"id","kind":"string","optional":false,"nullable":false},
 {"name":"text","kind":"string","optional":true,"nullable":true},
 {"name":"n","kind":"number","optional":false,"nullable":false},
 {"name":"group","kind":"string","optional":false,"nullable":false}
 ]})).unwrap()).unwrap();let fp=schema.fingerprint().to_owned();
 let catalog=Catalog::new(serde_json::from_value(json!({"format":1,"schemas":[schema.definition()],"topics":[{"topic":"test","schema":fp}]})).unwrap()).unwrap();
 (Runtime::new(catalog,100).unwrap(),fp)
}
fn rows(runtime:&mut Runtime,fp:&str,input:Vec<Value>){runtime.apply_committed("test",fp,&input.into_iter().map(|row|Mutation::Upsert{row}).collect::<Vec<_>>()).unwrap();}
fn query(runtime:&mut Runtime,fp:&str,mut query:Value)->Value{
 query["semantic_profile"]=json!("effect-4.2.8");
 runtime.open("profile","test",fp,serde_json::from_value(query).unwrap()).unwrap();
 serde_json::to_value(runtime.read("profile",0,100,65536).unwrap()).unwrap()
}
#[test]fn unicode_text_flags_absence_and_utf16_order_match_pinned_reference_vectors(){
 let(mut r,fp)=runtime();
 rows(&mut r,&fp,vec![json!({"id":"a","text":"ÉCOLE","n":0,"group":"g"}),json!({"id":"b","text":"e\u{0301}cole","n":0,"group":"g"}),json!({"id":"c","text":"\u{e000}","n":0,"group":"g"}),json!({"id":"d","text":"\u{10000}","n":0,"group":"g"}),json!({"id":"e","text":null,"n":0,"group":"g"}),json!({"id":"f","n":0,"group":"g"})]);
 let sorted=query(&mut r,&fp,json!({"select":["id"],"order_by":[{"field":"text","direction":"asc"}]}));
 assert_eq!(sorted["keys"],json!(["e","f","b","a","d","c"]));
 let filtered=query(&mut r,&fp,json!({"select":["id"],"where":{"op":"text","match_kind":"eq","field":"text","value":"école"},"order_by":[]}));assert_eq!(filtered["keys"],json!(["a","b"]));
 let strict=query(&mut r,&fp,json!({"select":["id"],"where":{"op":"text","match_kind":"eq","field":"text","value":"école","case_sensitive":true,"accent_sensitive":true},"order_by":[]}));assert_eq!(strict["keys"],json!(["b"]));
 let negative=query(&mut r,&fp,json!({"select":["id"],"where":{"op":"text","match_kind":"notContains","field":"text","value":"école"},"order_by":[]}));assert_eq!(negative["keys"],json!(["c","d","e","f"]));
 let groups=query(&mut r,&fp,json!({"group_by":["group"],"aggregates":{"min":{"aggFunc":"min","field":"text"},"max":{"aggFunc":"max","field":"text"},"distinct":{"aggFunc":"countDistinct","field":"text"}},"order_by":[]}));
 assert_eq!(groups["rows"],json!([{"group":"g","max":"\u{e000}","distinct":"6"}]));
 // The profile is a query identity dimension; legacy literal behavior survives.
 r.open("native","test",&fp,serde_json::from_value(json!({"select":["id"],"where":{"op":"eq","field":"text","value":"école"},"order_by":[]})).unwrap()).unwrap();assert_eq!(r.read("native",0,100,65536).unwrap().total_rows,0);
}
#[test]fn number_sum_is_decimal_before_accumulation_and_average_has_100_significant_digits(){
 let(mut r,fp)=runtime();rows(&mut r,&fp,vec![json!({"id":"a","n":0.1,"group":"g"}),json!({"id":"b","n":0.2,"group":"g"})]);
 let q=json!({"global":true,"aggregates":{"sum":{"aggFunc":"sum","field":"n"},"avg":{"aggFunc":"avg","field":"n"}},"order_by":[]});
 assert_eq!(query(&mut r,&fp,q.clone())["rows"],json!([{"sum":"0.3","avg":"0.15"}]));
 rows(&mut r,&fp,vec![json!({"id":"a","n":1,"group":"g"}),json!({"id":"b","n":0,"group":"g"}),json!({"id":"c","n":0,"group":"g"})]);
 assert_eq!(query(&mut r,&fp,q.clone())["rows"],json!([{"sum":"1","avg":format!("0.{}","3".repeat(100))}]));
 rows(&mut r,&fp,vec![json!({"id":"a","n":-1,"group":"g"})]);
 assert_eq!(query(&mut r,&fp,q)["rows"][0]["avg"],format!("-0.{}","3".repeat(100)));
}
#[test]fn decimal_number_conversion_preserves_subnormal_and_large_cancellation(){
 let(mut r,fp)=runtime();let q=json!({"global":true,"aggregates":{"sum":{"aggFunc":"sum","field":"n"}},"order_by":[]});
 rows(&mut r,&fp,vec![json!({"id":"a","n":f64::from_bits(1),"group":"g"})]);
 assert_eq!(query(&mut r,&fp,q.clone())["rows"][0]["sum"],format!("0.{}5","0".repeat(323)));
 rows(&mut r,&fp,vec![json!({"id":"a","n":1e20,"group":"g"}),json!({"id":"b","n":0.1,"group":"g"}),json!({"id":"c","n":-1e20,"group":"g"})]);
 assert_eq!(query(&mut r,&fp,q)["rows"][0]["sum"],"0.1");
}

#[test]fn optional_numeric_all_missing_average_matches_zero_and_present_values_ignore_missing(){
 let definition=json!({"format":1,"id":"optional","version":1,"key":"id","fields":[{"name":"id","kind":"string","optional":false,"nullable":false},{"name":"group","kind":"string","optional":false,"nullable":false},{"name":"n","kind":"number","optional":true,"nullable":false}]});
 let schema=rust_differential_product_core::schema::Schema::new(serde_json::from_value(definition.clone()).unwrap()).unwrap();let fp=schema.fingerprint().to_owned();
 let catalog=Catalog::new(serde_json::from_value(json!({"format":1,"schemas":[definition],"topics":[{"topic":"test","schema":fp}]})).unwrap()).unwrap();let mut r=Runtime::new(catalog,10).unwrap();
 rows(&mut r,&fp,vec![json!({"id":"a","group":"g"}),json!({"id":"b","group":"g"})]);
 let q=json!({"group_by":["group"],"aggregates":{"sum":{"aggFunc":"sum","field":"n"},"avg":{"aggFunc":"avg","field":"n"},"min":{"aggFunc":"min","field":"n"},"max":{"aggFunc":"max","field":"n"}},"order_by":[]});
 assert_eq!(query(&mut r,&fp,q.clone())["rows"],json!([{"group":"g","sum":"0","avg":"0"}]));
 rows(&mut r,&fp,vec![json!({"id":"a","group":"g","n":1})]);assert_eq!(query(&mut r,&fp,q)["rows"],json!([{"group":"g","sum":"1","avg":"1","max":1.0}]));
}
