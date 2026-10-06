use product_source_ingestion::generic_source::{Decoder,Descriptor,Mapping};
use rust_differential_product_core::{schema::{Catalog,Manifest,Kind},generic::Mutation};
use serde_json::{Value,json};
fn varint(mut n:u64,v:&mut Vec<u8>){while n>127{v.push((n as u8&127)|128);n>>=7;}v.push(n as u8);}
fn text(tag:u32,s:&str,v:&mut Vec<u8>){varint((tag as u64)<<3|2,v);varint(s.len()as u64,v);v.extend(s.as_bytes());}
fn frame(id:u32,body:Vec<u8>)->Vec<u8>{let mut v=vec![0];v.extend(id.to_be_bytes());v.push(0);v.extend(body);v}
#[test]
fn authored_catalog_pinned_descriptors_decode_all_three_shapes(){
 let manifest:Manifest=serde_json::from_str(include_str!("../../../../../fixtures/topics/catalog.json")).unwrap();let catalog=Catalog::new(manifest).unwrap();let sources:Vec<Value>=serde_json::from_str(include_str!("../../../../../fixtures/topics/source-bindings.json")).unwrap();
 assert_eq!(sources.len(),3);
 for source in sources {
  let schema=catalog.schema(source["topic"].as_str().unwrap(),source["schema"].as_str().unwrap()).unwrap();let key:Descriptor=serde_json::from_value(source["key_descriptor"].clone()).unwrap();let value:Descriptor=serde_json::from_value(source["value_descriptor"].clone()).unwrap();let mapping:Vec<Mapping>=serde_json::from_value(source["mapping"].clone()).unwrap();let decoder=Decoder::new(schema.clone(),&key,&value,1,mapping.clone()).unwrap();
  let mut expected=serde_json::Map::new();let mut body=Vec::new();
  for m in &mapping {let f=schema.field(&m.field).unwrap();let scalar=if f.name==schema.definition().key {json!("same")}else{match f.kind{Kind::Enum=>panic!("flat regression fixture contains enum"),Kind::String=>json!("UTF8-東京"),Kind::Boolean=>json!(false),Kind::Number=>json!(-123.125),Kind::Int64=>json!(i64::MIN.to_string()),Kind::Uint64=>json!(u64::MAX.to_string()),Kind::Decimal=>json!("-12345678901234567890.0001")}};
   if let Some(null)=m.null_tag{varint((null as u64)<<3,&mut body);body.push(1);expected.insert(m.field.clone(),Value::Null);continue;}
   match f.kind{Kind::Enum=>panic!("flat regression fixture contains enum"),Kind::String|Kind::Decimal=>text(m.tag,scalar.as_str().unwrap(),&mut body),Kind::Boolean=>{varint((m.tag as u64)<<3,&mut body);body.push(0);},Kind::Number=>{varint((m.tag as u64)<<3|1,&mut body);body.extend((-123.125f64).to_le_bytes());},Kind::Int64=>{varint((m.tag as u64)<<3,&mut body);varint(i64::MIN as u64,&mut body);},Kind::Uint64=>{varint((m.tag as u64)<<3,&mut body);varint(u64::MAX,&mut body);}}
   expected.insert(m.field.clone(),scalar);
  }
  let mut key_body=Vec::new();text(1,"same",&mut key_body);let(_,_,decoded)=decoder.decode(Some(&frame(key.schema_id,key_body)),Some(&frame(value.schema_id,body))).unwrap();assert!(matches!(decoded,Mutation::Upsert{row} if row==Value::Object(expected)));
 }
}
