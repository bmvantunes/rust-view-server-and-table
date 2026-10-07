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
fn query_identity_len(fp:&str,query:&Value)->usize{let parsed:rust_differential_product_core::generic::Query=serde_json::from_value(query.clone()).unwrap();serde_json::to_vec(&("test",fp,&parsed)).unwrap().len()}
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
#[test]fn large_text_in_is_one_bounded_profile_predicate_with_null_and_missing_semantics(){
 let(mut r,fp)=runtime();rows(&mut r,&fp,vec![json!({"id":"a","text":"ÉCOLE","n":0,"group":"g"}),json!({"id":"b","text":"e\u{0301}cole","n":0,"group":"g"}),json!({"id":"c","text":"elsewhere","n":0,"group":"g"}),json!({"id":"d","text":null,"n":0,"group":"g"}),json!({"id":"e","n":0,"group":"g"})]);
 let mut values=(0..4095).map(|i|format!("facet-{i}")).collect::<Vec<_>>();values[0]="école".into();
 let broad=json!({"op":"text_in","field":"text","values":values});
 r.open("broad","test",&fp,serde_json::from_value(json!({"semantic_profile":"effect-4.2.8","select":["id"],"where":broad,"order_by":[]})).unwrap()).unwrap();
 assert_eq!(r.read("broad",0,100,65536).unwrap().keys,vec!["a","b"]);
 let with_null=json!({"op":"or","clauses":[{"op":"text_in","field":"text","values":["école"]},{"op":"is_null","field":"text"}]});
 r.open("null","test",&fp,serde_json::from_value(json!({"semantic_profile":"effect-4.2.8","select":["id"],"where":with_null,"order_by":[]})).unwrap()).unwrap();
 assert_eq!(r.read("null",0,100,65536).unwrap().keys,vec!["a","b","d"]);
 let strict=json!({"op":"text_in","field":"text","values":["école"],"case_sensitive":true,"accent_sensitive":true});
 r.open("strict","test",&fp,serde_json::from_value(json!({"semantic_profile":"effect-4.2.8","select":["id"],"where":strict,"order_by":[]})).unwrap()).unwrap();assert_eq!(r.read("strict",0,100,65536).unwrap().keys,vec!["b"]);
 assert!(r.open("empty","test",&fp,serde_json::from_value(json!({"semantic_profile":"effect-4.2.8","select":["id"],"where":{"op":"text_in","field":"text","values":[]},"order_by":[]})).unwrap()).is_err());
}
#[test]fn native_accepts_exact_query_identity_byte_limit_and_rejects_one_byte_over(){
 let(mut r,fp)=runtime();let mut values=(0..4096).map(|i|format!("facet-{i}")).collect::<Vec<_>>();
 let mut query=json!({"semantic_profile":"effect-4.2.8","select":["id"],"where":{"op":"text_in","field":"text","values":values},"order_by":[]});
 let mut last_under=0usize;
 for padding in 0..32{values=(0..4096).map(|i|format!("facet-{i}{}","界".repeat(padding))).collect();query["where"]["values"]=json!(values);let length=query_identity_len(&fp,&query);if length>65_536{break;}last_under=padding;}
 values=(0..4096).map(|i|format!("facet-{i}{}","界".repeat(last_under))).collect();query["where"]["values"]=json!(values);
 let mut remaining=65_536-query_identity_len(&fp,&query);
 for value in query["where"]["values"].as_array_mut().unwrap().iter_mut().rev(){let current=value.as_str().unwrap();let capacity=4096-current.len();let added=remaining.min(capacity);if added>0{*value=json!(format!("{}{}",current,"A".repeat(added)));remaining-=added;}if remaining==0{break;}}
 assert_eq!(remaining,0);assert_eq!(query_identity_len(&fp,&query),65_536);
 r.open("exact","test",&fp,serde_json::from_value(query.clone()).unwrap()).unwrap();
 query["where"]["values"][0]=json!(format!("{}A",query["where"]["values"][0].as_str().unwrap()));
 assert_eq!(query_identity_len(&fp,&query),65_537);
 assert_eq!(r.open("over","test",&fp,serde_json::from_value(query).unwrap()).unwrap_err(),"query byte bound");
 let mut numeric_values=(0..4091).map(|i|json!(i)).collect::<Vec<_>>();numeric_values.extend([json!(0.1),json!(1e20),json!(1e-7),json!(-0.0),json!(1.8446744073709552e19)]);
 let numeric=json!({"semantic_profile":"effect-4.2.8","select":["id"],"where":{"op":"in","field":"n","values":numeric_values},"order_by":[]});
 assert!(query_identity_len(&fp,&numeric)<65_536);r.open("numeric","test",&fp,serde_json::from_value(numeric).unwrap()).unwrap();
}
#[test]fn large_numeric_in_preserves_exact_unsigned_and_decimal_operands(){
 let definition=json!({"format":1,"id":"exact_sets","version":1,"key":"id","fields":[{"name":"id","kind":"string","optional":false,"nullable":false},{"name":"units","kind":"uint64","optional":false,"nullable":false},{"name":"price","kind":"decimal","optional":false,"nullable":false}]});
 let schema=Schema::new(serde_json::from_value(definition.clone()).unwrap()).unwrap();let fp=schema.fingerprint().to_owned();let catalog=Catalog::new(serde_json::from_value(json!({"format":1,"schemas":[definition],"topics":[{"topic":"exact_sets","schema":fp}]})).unwrap()).unwrap();let mut r=Runtime::new(catalog,10).unwrap();
 rows_exact(&mut r,&fp,vec![json!({"id":"a","units":"9007199254740993","price":"1234567890123456789.0001"}),json!({"id":"b","units":"9007199254740994","price":"1234567890123456789.0002"})]);
 let mut units=(0..4096).map(|n|json!(n.to_string())).collect::<Vec<_>>();units[0]=json!("9007199254740993");
 r.open("units","exact_sets",&fp,serde_json::from_value(json!({"semantic_profile":"effect-4.2.8","select":["id"],"where":{"op":"in","field":"units","values":units},"order_by":[]})).unwrap()).unwrap();assert_eq!(r.read("units",0,10,65536).unwrap().keys,vec!["a"]);
 let mut prices=(0..4096).map(|n|json!(format!("{n}.01"))).collect::<Vec<_>>();prices[0]=json!("1234567890123456789.0001");
 r.open("prices","exact_sets",&fp,serde_json::from_value(json!({"semantic_profile":"effect-4.2.8","select":["id"],"where":{"op":"in","field":"price","values":prices},"order_by":[]})).unwrap()).unwrap();assert_eq!(r.read("prices",0,10,65536).unwrap().keys,vec!["a"]);
}
fn rows_exact(runtime:&mut Runtime,fp:&str,input:Vec<Value>){runtime.apply_committed("exact_sets",fp,&input.into_iter().map(|row|Mutation::Upsert{row}).collect::<Vec<_>>()).unwrap();}
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

#[test]
fn grouped_multi_sort_window_and_live_reranking_preserve_requested_order() {
    let (mut r, fp) = runtime();
    rows(&mut r, &fp, vec![
        json!({"id":"by","group":"B","text":"Y","n":1}),
        json!({"id":"ax1","group":"A","text":"X","n":2}),
        json!({"id":"ay","group":"A","text":"Y","n":9}),
        json!({"id":"bx","group":"B","text":"X","n":9}),
        json!({"id":"ax2","group":"A","text":"X","n":3}),
    ]);
    let base = json!({"group_by":["text","group"],"aggregates":{"total":{"aggFunc":"sum","field":"n"},"mean":{"aggFunc":"avg","field":"n"}},"order_by":[{"aggregate":"total","direction":"desc"},{"field":"group","direction":"desc"}]});
    let labels = |rows: &[Value]| rows.iter().map(|row| format!("{}/{}:{}", row["group"].as_str().unwrap(), row["text"].as_str().unwrap(), row["total"].as_str().unwrap())).collect::<Vec<_>>();
    let initial = query(&mut r, &fp, base.clone());
    assert_eq!(labels(initial["rows"].as_array().unwrap()), ["B/X:9", "A/Y:9", "A/X:5", "B/Y:1"]);
    assert_eq!(labels(&r.read("profile", 1, 2, 65536).unwrap().rows), ["A/Y:9", "A/X:5"]);
    let mut ascending = base.clone();
    ascending["order_by"] = json!([{"aggregate":"total","direction":"asc"},{"field":"group","direction":"asc"}]);
    let asc = query(&mut r, &fp, ascending);
    assert_eq!(labels(asc["rows"].as_array().unwrap()), ["B/Y:1", "A/X:5", "A/Y:9", "B/X:9"]);
    assert_eq!(asc["keys"].as_array().unwrap(), &initial["keys"].as_array().unwrap().iter().rev().cloned().collect::<Vec<_>>());
    let mut fields = base.clone();
    fields["order_by"] = json!([{"field":"group","direction":"desc"},{"field":"text","direction":"asc"}]);
    assert_eq!(labels(query(&mut r, &fp, fields)["rows"].as_array().unwrap()), ["B/X:9", "B/Y:1", "A/X:5", "A/Y:9"]);
    query(&mut r, &fp, base.clone());
    rows(&mut r, &fp, vec![json!({"id":"by","group":"B","text":"Y","n":12})]);
    assert_eq!(labels(&r.read("profile", 0, 10, 65536).unwrap().rows), ["B/Y:12", "B/X:9", "A/Y:9", "A/X:5"]);
    r.apply_committed("test", &fp, &[Mutation::Delete{key:"by".into()}]).unwrap();
    assert_eq!(labels(&r.read("profile", 0, 10, 65536).unwrap().rows), ["B/X:9", "A/Y:9", "A/X:5"]);
    let previous = r.read("profile", 0, 10, 65536).unwrap().keys;
    let mut regrouped = base;
    regrouped["group_by"] = json!(["group","text"]);
    let regrouped = query(&mut r, &fp, regrouped);
    assert_eq!(labels(regrouped["rows"].as_array().unwrap()), ["B/X:9", "A/Y:9", "A/X:5"]);
    assert_ne!(regrouped["keys"], json!(previous));
}
