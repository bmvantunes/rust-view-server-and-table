use product_source_ingestion::generic_source::{Decoder,Descriptor,Mapping,KeyField,Identity};
use rust_differential_product_core::{schema::{Schema,Catalog,Manifest},generic::{Mutation,Runtime,Query}};
use serde_json::{Value,json};
fn fixtures()->Value{serde_json::from_str(include_str!("../../../../../fixtures/expanded-topics/source-bindings.json")).unwrap()}
fn schema()->Schema{Schema::new(serde_json::from_value(fixtures()["example.Shit"]["schema"].clone()).unwrap()).unwrap()}
fn decoder()->Decoder{let b=fixtures();let k=&b["example.common.Key"];let v=&b["example.Shit"];Decoder::new_identity(schema(),&serde_json::from_value::<Descriptor>(k["descriptor"].clone()).unwrap(),&serde_json::from_value::<Descriptor>(v["descriptor"].clone()).unwrap(),serde_json::from_value::<Vec<Mapping>>(v["mapping"].clone()).unwrap(),serde_json::from_value::<Vec<KeyField>>(k["key_fields"].clone()).unwrap(),serde_json::from_value::<Identity>(json!({"source_policy":"compact","components":[{"source":"key","field":"account.id"}]})).unwrap()).unwrap()}
fn frame(name:&str,bytes:&[u8])->Vec<u8>{let b=fixtures();let id=b[name]["descriptor"]["schema_id"].as_u64().unwrap()as u32;let mut out=vec![0];out.extend(id.to_be_bytes());out.push(0);out.extend(bytes);out}
fn key(id:u8)->Vec<u8>{frame("example.common.Key",&[10,3,10,1,id])}
fn row(payload:&[u8])->Value{let (_,_,m)=decoder().decode(Some(&key(b'a')),Some(&frame("example.Shit",payload))).unwrap();let Mutation::Upsert{row}=m else{panic!()};row}
#[test]fn raw_absent_empty_default_optional_and_null(){
 let a=row(&[]);assert_eq!(a.as_object().unwrap().len(),2);assert_eq!(a["label"],"");assert!(a.get("oo").is_none());
 let b=row(&[10,0]);assert_eq!(b["oo"],json!({"name":"","status":{"domain":"example.common.Status","code":0}}));
 let c=row(&[10,2,42,0]);assert_eq!(c["oo"]["note"],"");assert_ne!(b,c);
 let d=row(&[10,2,32,1]);assert_eq!(d["oo"]["price"],Value::Null);
 for bytes in [&[10,2,32,0][..],&[10,5,26,1,b'1',32,1][..],&[10,3,26,1,b'x'][..]].iter(){assert!(decoder().decode(Some(&key(b'a')),Some(&frame("example.Shit",bytes))).is_err());}
}
#[test]fn raw_merge_unknown_fields_enum_codes_and_decimal_exactness(){
 let a=row(&[10,3,10,1,b'x',10,2,16,77,120,42]);assert_eq!(a["oo"],json!({"name":"x","status":{"domain":"example.common.Status","code":77}}));
 let b=row(&[10,4,16,1,16,2]);assert_eq!(b["oo"]["status"]["code"],2);
 let text="-12345678901234567890.000000000000000001";let mut inner=vec![26,text.len()as u8];inner.extend(text.as_bytes());let mut bytes=vec![10,inner.len()as u8];bytes.extend(inner);assert_eq!(row(&bytes)["oo"]["price"],text);
 let negative=vec![10,11,16,255,255,255,255,255,255,255,255,255,1];assert_eq!(row(&negative)["oo"]["status"]["code"],-1);
}
#[test]fn nested_key_only_tombstone_and_required_key(){let d=decoder();let (id,owner,_) = d.decode(Some(&key(b'a')),Some(&frame("example.Shit",&[]))).unwrap();let (deleted,again,m)=d.decode(Some(&key(b'a')),None).unwrap();assert_eq!((id,owner),(deleted.clone(),again));assert!(matches!(m,Mutation::Delete{key}if key==deleted));assert!(d.decode(Some(&frame("example.common.Key",&[10,0])),None).is_err());}
#[test]fn projection_parent_presence_replacement_grouping_and_restore(){
 let manifest:Manifest=serde_json::from_str(include_str!("../../../../../fixtures/expanded-topics/catalog.json")).unwrap();let catalog=Catalog::new(manifest).unwrap();let fingerprint=schema().fingerprint().to_owned();let mut rt=Runtime::new(catalog,100).unwrap();
 let raw:Query=serde_json::from_value(json!({"select":["oo.note"],"order_by":[]})).unwrap();rt.open("raw","shit",&fingerprint,raw).unwrap();
 let group:Query=serde_json::from_value(json!({"group_by":["oo.note"],"aggregates":{"count":{"aggFunc":"count"},"distinct":{"aggFunc":"countDistinct","field":"oo.status"},"sum":{"aggFunc":"sum","field":"oo.price"},"avg":{"aggFunc":"avg","field":"oo.price"},"min":{"aggFunc":"min","field":"oo.status"},"max":{"aggFunc":"max","field":"oo.status"}},"order_by":[]})).unwrap();rt.open("group","shit",&fingerprint,group).unwrap();
 let mut b=row(&[10,0]);let idb=rust_differential_product_core::schema::encode_row_id(&[rust_differential_product_core::schema::Scalar::String("b".into())]).unwrap();b["rowId"]=json!(idb);
 rt.apply_committed("shit",&fingerprint,&[Mutation::Upsert{row:row(&[])},Mutation::Upsert{row:b.clone()}]).unwrap();let result=rt.read("raw",0,10,65536).unwrap();assert!(result.rows.contains(&json!({})));assert!(result.rows.contains(&json!({"oo":{}})));assert_eq!(rt.read("group",0,10,65536).unwrap().rows.len(),2);
 b.as_object_mut().unwrap().remove("oo");rt.apply_committed("shit",&fingerprint,&[Mutation::Upsert{row:b}]).unwrap();assert_eq!(rt.read("group",0,10,65536).unwrap().rows.len(),1);
 for full in rt.rows("shit",&fingerprint).unwrap(){assert_eq!(schema().full(&schema().row(&full).unwrap()),full)}
 let q=serde_json::from_value(json!({"group_by":["oo.name"],"aggregates":{"oo":{"aggFunc":"count"}},"order_by":[]})).unwrap();assert!(rt.open("bad","shit",&fingerprint,q).is_err());
 let q=serde_json::from_value(json!({"group_by":["oo.name"],"aggregates":{"x":{"aggFunc":"sum","field":"oo.status"}},"order_by":[]})).unwrap();assert!(rt.open("bad","shit",&fingerprint,q).is_err());
}
#[test]fn source_required_leaf_only_under_present_parent(){
 let mut s=schema().definition().clone();let e=s.expansion.as_mut().unwrap();let i=e.leaves.iter().position(|l|l.path=="oo.note").unwrap();e.leaves[i].required=true;let s=Schema::new(s).unwrap();let b=fixtures();let k=&b["example.common.Key"];let v=&b["example.Shit"];let d=Decoder::new_identity(s,&serde_json::from_value(k["descriptor"].clone()).unwrap(),&serde_json::from_value(v["descriptor"].clone()).unwrap(),serde_json::from_value(v["mapping"].clone()).unwrap(),serde_json::from_value(k["key_fields"].clone()).unwrap(),serde_json::from_value(json!({"source_policy":"compact","components":[{"source":"key","field":"account.id"}]})).unwrap()).unwrap();
 assert!(d.decode(Some(&key(b'a')),Some(&frame("example.Shit",&[]))).is_ok());assert!(d.decode(Some(&key(b'a')),Some(&frame("example.Shit",&[10,0]))).is_err());assert!(d.decode(Some(&key(b'a')),Some(&frame("example.Shit",&[10,2,42,0]))).is_ok());
}
