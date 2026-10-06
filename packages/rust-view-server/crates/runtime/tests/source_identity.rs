use product_source_ingestion::generic_source::{Decoder,Descriptor,Mapping,KeyField,Identity,IdentityComponent,ComponentSource,SourcePolicy};
use rust_differential_product_core::{schema::{Schema,Kind,Scalar,encode_row_id},generic::Mutation};
use serde_json::json;
fn vi(mut n: u64) -> Vec<u8> {
    let mut out = Vec::new();
    while n > 127 { out.push((n as u8 & 127) | 128); n >>= 7; }
    out.push(n as u8); out
}
fn bytes(tag: u64, value: &[u8]) -> Vec<u8> {
    [vi(tag * 8 + 2), vi(value.len() as u64), value.to_vec()].concat()
}
fn integer(tag: u64, value: u64) -> Vec<u8> { [vi(tag * 8), vi(value)].concat() }
// name, tag, protobuf kind, explicit proto3 presence, proto2 label
fn descriptor(syntax: &str, fields: &[(&str, u64, u64, bool, u64)], id: u32) -> Descriptor {
    let mut message = bytes(1, b"PresenceRow");
    let mut oneofs = Vec::new();
    for (name, tag, kind, explicit, label) in fields {
        let mut field = [bytes(1, name.as_bytes()), integer(3, *tag), integer(4, *label), integer(5, *kind)].concat();
        if syntax == "proto3" && *explicit {
            field.extend(integer(9, oneofs.len() as u64)); field.extend(integer(17, 1));
            oneofs.push(bytes(8, &bytes(1, format!("_{name}").as_bytes())));
        }
        message.extend(bytes(2, &field));
    }
    for oneof in oneofs { message.extend(oneof); }
    let file = [bytes(4, &message), bytes(12, syntax.as_bytes())].concat();
    Descriptor{message_name:None,schema_id: id, message_index: 0, descriptor_hex: bytes(1, &file).iter().map(|b| format!("{b:02x}")).collect() }
}
fn frame(id: u32, body: &[u8]) -> Vec<u8> { [vec![0], id.to_be_bytes().to_vec(), vec![0], body.to_vec()].concat() }

fn schema()->Schema {Schema::new(serde_json::from_value(json!({"format":2,"id":"rows","version":2,"key":"rowId","fields":[{"name":"event","kind":"string","optional":false,"nullable":false},{"name":"amount","kind":"uint64","optional":false,"nullable":false}]})).unwrap()).unwrap()}
fn key_fields()->Vec<KeyField>{vec![KeyField{name:"tenant".into(),tag:1,kind:Kind::String},KeyField{name:"desk".into(),tag:2,kind:Kind::String},KeyField{name:"account".into(),tag:3,kind:Kind::Uint64},KeyField{name:"partitionKey".into(),tag:4,kind:Kind::Int64}]}
fn descriptors()->(Descriptor,Descriptor){(descriptor("proto3",&[("tenant",1,9,true,1),("desk",2,9,true,1),("account",3,4,true,1),("partitionKey",4,3,true,1)],1),descriptor("proto3",&[("event",1,9,true,1),("amount",2,4,true,1)],2))}
fn rule(policy:SourcePolicy,value:bool)->Identity{Identity{source_policy:policy,components:if value {vec![IdentityComponent{source:ComponentSource::Key,field:"tenant".into()},IdentityComponent{source:ComponentSource::Key,field:"desk".into()},IdentityComponent{source:ComponentSource::Value,field:"event".into()}]}else{key_fields().iter().map(|f|IdentityComponent{source:ComponentSource::Key,field:f.name.clone()}).collect()}}}
fn decoder(policy:SourcePolicy,value:bool)->Result<Decoder,String>{let(k,v)=descriptors();Decoder::new_identity(schema(),&k,&v,vec![Mapping{field:"event".into(),tag:1,null_tag:None},Mapping{field:"amount".into(),tag:2,null_tag:None}],key_fields(),rule(policy,value))}
fn key(a:&str,b:&str,account:u64,partition:i64)->Vec<u8>{frame(1,&[bytes(1,a.as_bytes()),bytes(2,b.as_bytes()),integer(3,account),integer(4,partition as u64)].concat())}
fn value(event:&str,amount:u64)->Vec<u8>{frame(2,&[bytes(1,event.as_bytes()),integer(2,amount)].concat())}
#[test]fn composite_key_tombstone_is_identical_after_new_decoder(){
 for policy in [SourcePolicy::Delete,SourcePolicy::Compact,SourcePolicy::CompactDelete] {
  let d=decoder(policy,false).unwrap();let k=key("雪","desk",u64::MAX,i64::MIN);let(id,ownership,upsert)=d.decode(Some(&k),Some(&value("",0))).unwrap();
  assert_eq!(id,encode_row_id(&[Scalar::String("雪".into()),Scalar::String("desk".into()),Scalar::Uint64(u64::MAX),Scalar::Int64(i64::MIN)]).unwrap());
  assert!(matches!(upsert,Mutation::Upsert{row} if row==json!({"rowId":id,"event":"","amount":"0"})));
  let(recovered,restored_owner,delete)=decoder(policy,false).unwrap().decode(Some(&k),None).unwrap();assert_eq!(recovered,id);assert_eq!(ownership,restored_owner);assert!(matches!(delete,Mutation::Delete{key} if key==id));
 }
}
#[test]fn delete_value_rule_is_explicit_and_does_not_invent_tombstone_mapping(){
 let d=decoder(SourcePolicy::Delete,true).unwrap();let k=key("a","b",1,0);
 let a=d.decode(Some(&k),Some(&value("event-a",0))).unwrap();let b=d.decode(Some(&k),Some(&value("event-b",0))).unwrap();assert_ne!(a.0,b.0);assert_eq!(a.1,b.1);
 assert!(d.decode(Some(&k),None).unwrap_err().contains("value-derived"));
 assert!(decoder(SourcePolicy::Compact,true).is_err());assert!(decoder(SourcePolicy::CompactDelete,true).is_err());
}
#[test]fn raw_missing_defaults_and_ambiguous_join_candidates(){
 let d=decoder(SourcePolicy::Compact,false).unwrap();
 let a=d.decode(Some(&key("ab","c",0,0)),Some(&value("",0))).unwrap();let b=d.decode(Some(&key("a","bc",0,0)),Some(&value("",0))).unwrap();assert_ne!(a.0,b.0);
 for body in [vec![],bytes(1,b"tenant"),[bytes(1,b"tenant"),bytes(2,b"desk"),integer(3,0)].concat()] {assert!(d.decode(Some(&frame(1,&body)),None).is_err());}
 let k=key("","",0,0);assert!(d.decode(Some(&k),Some(&value("",0))).is_ok());assert!(d.decode(Some(&k),Some(&frame(2,&bytes(1,b"e")))).is_err());assert!(d.decode(Some(&key(&"x".repeat(300),"",0,0)),None).is_err());
 let(kdesc,vdesc)=descriptors();let mut fields=key_fields();fields[0].kind=Kind::Boolean;assert!(Decoder::new_identity(schema(),&kdesc,&vdesc,vec![],fields,rule(SourcePolicy::Compact,false)).is_err());
 let implicit=descriptor("proto3",&[("tenant",1,9,false,1),("desk",2,9,true,1),("account",3,4,true,1),("partitionKey",4,3,true,1)],1);
 assert!(Decoder::new_identity(schema(),&implicit,&vdesc,vec![],key_fields(),rule(SourcePolicy::Compact,false)).err().unwrap().contains("SOURCE-PRESENCE"));
}
#[test]fn source_cleanup_branch_validation(){
 for (policy,ok) in [(SourcePolicy::Delete,"delete"),(SourcePolicy::Compact,"compact"),(SourcePolicy::CompactDelete,"delete,compact")] {assert!(policy.validate_actual(ok).is_ok());for bad in ["","other","compact,compact","delete,compact,delete"]{assert!(policy.validate_actual(bad).is_err());}}
 assert!(SourcePolicy::Delete.validate_actual("compact").is_err());assert!(SourcePolicy::Compact.validate_actual("compact,delete").is_err());assert!(SourcePolicy::CompactDelete.validate_actual("delete").is_err());
}
#[test]fn generated_flat_schema_descriptors_admit_without_hardcoded_types(){
 use rust_differential_product_core::schema::{Catalog,Manifest};
 let c:Manifest=serde_json::from_str(include_str!("../../../../../fixtures/proto-topics/catalog.json")).unwrap();let catalog=Catalog::new(c).unwrap();let bindings:serde_json::Value=serde_json::from_str(include_str!("../../../../../fixtures/proto-topics/source-bindings.json")).unwrap();
 for (topic,key_name,value_name) in [("orders","OrdersKey","Orders"),("positions","PositionsKey","Positions"),("wide","SimpleKey","Wide")] {
  let(_,schema)=catalog.topics().find(|(t,_)|*t==topic).unwrap();let key:Descriptor=serde_json::from_value(bindings[key_name]["descriptor"].clone()).unwrap();let value:Descriptor=serde_json::from_value(bindings[value_name]["descriptor"].clone()).unwrap();let fields:Vec<KeyField>=serde_json::from_value(bindings[key_name]["key_fields"].clone()).unwrap();let components=fields.iter().map(|f|IdentityComponent{source:ComponentSource::Key,field:f.name.clone()}).collect();
  Decoder::new_identity(schema.clone(),&key,&value,serde_json::from_value(bindings[value_name]["mapping"].clone()).unwrap(),fields,Identity{source_policy:SourcePolicy::Compact,components}).unwrap();
 }
}
