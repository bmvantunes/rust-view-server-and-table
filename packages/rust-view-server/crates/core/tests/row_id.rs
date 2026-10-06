use rust_differential_product_core::{schema::{Schema,Scalar,encode_row_id,valid_row_id},product::ExactDecimal};
use serde_json::json;
fn schema()->Schema {Schema::new(serde_json::from_value(json!({"format":2,"id":"rows","version":2,"key":"rowId","fields":[{"name":"name","kind":"string","optional":false,"nullable":false},{"name":"amount","kind":"uint64","optional":false,"nullable":false},{"name":"note","kind":"string","optional":true,"nullable":true}]})).unwrap()).unwrap()}
#[test]fn typed_tuple_boundaries_unicode_and_exact_values(){
 let text=|s:&str|Scalar::String(s.into());
 assert_ne!(encode_row_id(&[text("ab"),text("c")]).unwrap(),encode_row_id(&[text("a"),text("bc")]).unwrap());
 assert_ne!(encode_row_id(&[text("é")]).unwrap(),encode_row_id(&[text("e\u{301}")]).unwrap());
 assert_ne!(encode_row_id(&[text("0")]).unwrap(),encode_row_id(&[Scalar::Uint64(0)]).unwrap());
 assert_ne!(encode_row_id(&[Scalar::Uint64(9007199254740992)]).unwrap(),encode_row_id(&[Scalar::Uint64(9007199254740993)]).unwrap());
 assert_eq!(encode_row_id(&[Scalar::Number("-0".into())]).unwrap(),encode_row_id(&[Scalar::Number("0".into())]).unwrap());
 for s in [text(""),text("雪\0🙂"),Scalar::Boolean(false),Scalar::Number("1.25".into()),Scalar::Int64(i64::MIN),Scalar::Uint64(u64::MAX),Scalar::Decimal(ExactDecimal::parse("12345678901234567890.00001").unwrap())] {assert!(valid_row_id(&encode_row_id(&[s]).unwrap()));}
 assert_eq!(encode_row_id(&[text("a")]).unwrap(),"rid2:0101010000000161");
 for v in [vec![],vec![Scalar::Missing],vec![Scalar::Null],vec![text(&"a".repeat(300))],vec![Scalar::Boolean(false);17]] {assert!(encode_row_id(&v).is_err());}
 for s in ["", "x", "rid2:","rid2:010101000000016A","rid2:0101010000000261","rid2:010101000000016100","rid2:010103000000088000000000000000"] {assert!(!valid_row_id(s),"{s}");}
}
#[test]fn public_metadata_is_required_reserved_and_not_a_business_selection(){
 let s=schema();let id=encode_row_id(&[Scalar::String("identity".into())]).unwrap();
 let value=json!({"rowId":id,"name":"n","amount":"18446744073709551615","note":null});let r=s.row(&value).unwrap();
 assert_eq!(s.full(&r),value);assert_eq!(s.project(&r,&[s.index("name").unwrap()]),json!({"name":"n"}));assert!(s.index("rowId").is_err());
 for v in [json!({"name":"n","amount":"1"}),json!({"rowId":"bad","name":"n","amount":"1"}),json!({"rowId":null,"name":"n","amount":"1"})] {assert!(s.row(&v).is_err());}
 let mut d=s.definition().clone();d.fields[0].name="rowId".into();assert!(Schema::new(d).is_err());let mut d=s.definition().clone();d.key="name".into();assert!(Schema::new(d).is_err());
}
#[test]fn repeated_id_upserts_atomic_rejection_and_projection_survive_reorder(){
 use rust_differential_product_core::{generic::{Runtime,Mutation,Query},schema::{Catalog,Manifest,Topic}};
 let s=schema();let fp=s.fingerprint().to_owned();let c=Catalog::new(Manifest{format:1,schemas:vec![s.definition().clone()],topics:vec![Topic{topic:"rows".into(),schema:fp.clone()}]}).unwrap();let mut rt=Runtime::new(c,50).unwrap();
 let a=encode_row_id(&[Scalar::String("a".into())]).unwrap();let b=encode_row_id(&[Scalar::String("b".into())]).unwrap();
 let row=|id:&str,amount:&str|Mutation::Upsert{row:json!({"rowId":id,"name":"n","amount":amount})};
 rt.apply_committed("rows",&fp,&[row(&a,"1"),row(&b,"2")]).unwrap();
 let q:Query=serde_json::from_value(json!({"select":["amount"],"order_by":[{"field":"amount","direction":"asc"}]})).unwrap();rt.open("sub","rows",&fp,q).unwrap();
 let before=rt.read("sub",0,10,1048576).unwrap();assert_eq!(before.keys,vec![a.clone(),b.clone()]);assert_eq!(before.rows,json!([{"amount":"1"},{"amount":"2"}]).as_array().unwrap().clone());
 rt.apply_committed("rows",&fp,&[row(&a,"3"),row(&a,"4")]).unwrap();assert_eq!(rt.row_count(),2);let after=rt.read("sub",0,10,1048576).unwrap();assert_eq!(after.keys,vec![b.clone(),a.clone()]);assert_eq!(after.rows[1],json!({"amount":"4"}));
 assert!(rt.apply_committed("rows",&fp,&[row(&a,"7"),Mutation::Upsert{row:json!({"rowId":b,"name":"n"})}]).is_err());assert_eq!(rt.read("sub",0,10,1048576).unwrap().rows,after.rows);
 assert!(rt.apply_committed("rows",&fp,&[Mutation::Delete{key:"bad".into()}]).is_err());
 rt.apply_committed("rows",&fp,&[Mutation::Delete{key:a}]).unwrap();assert_eq!(rt.read("sub",0,10,1048576).unwrap().keys,vec![b]);
}
