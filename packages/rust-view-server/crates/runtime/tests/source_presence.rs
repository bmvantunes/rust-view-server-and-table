//! SOURCE-PRESENCE: independent raw descriptor/record encoder; no producer row validator.
use product_source_ingestion::generic_source::{Decoder, Descriptor, Mapping};
use rust_differential_product_core::{generic::Mutation, schema::{Kind, Schema}};
use serde_json::{json, Value};

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
fn kind_number(k: Kind) -> u64 { match k {Kind::Enum=>panic!("flat regression fixture contains enum"), Kind::String | Kind::Decimal => 9, Kind::Boolean => 8, Kind::Number => 1, Kind::Int64 => 3, Kind::Uint64 => 4 } }
const KINDS: [Kind; 6] = [Kind::String, Kind::Boolean, Kind::Number, Kind::Int64, Kind::Uint64, Kind::Decimal];
fn setup(k: Kind, optional: bool, nullable: bool, syntax: &str, explicit: bool, label: u64) -> Result<Decoder, String> {
    let schema = Schema::new(serde_json::from_value(json!({"format":1,"id":"presence","version":1,"key":"id","fields":[
        {"name":"id","kind":"string","optional":false,"nullable":false},
        {"name":"value","kind":k,"optional":optional,"nullable":nullable}
    ]})).unwrap()).unwrap();
    let key = descriptor(syntax, &[("id",1,9,true,1)], 1);
    let mut fields = vec![("id",1,9,true,1),("value",2,kind_number(k),explicit,label)];
    if nullable { fields.push(("null_value",3,8,true,1)); }
    Decoder::new(schema, &key, &descriptor(syntax,&fields,2), 1, vec![
        Mapping{field:"id".into(),tag:1,null_tag:None},
        Mapping{field:"value".into(),tag:2,null_tag:nullable.then_some(3)},
    ])
}
fn default_value(k: Kind) -> (Vec<u8>, Value) {
    match k {Kind::Enum=>panic!("flat regression fixture contains enum"),
        Kind::String => (bytes(2,b""),json!("")),
        Kind::Boolean => (integer(2,0),json!(false)),
        Kind::Number => ([vi(2*8+1),0f64.to_le_bytes().to_vec()].concat(),json!(0.0)),
        Kind::Int64 | Kind::Uint64 => (integer(2,0),json!("0")),
        Kind::Decimal => (bytes(2,b"0"),json!("0")),
    }
}
fn decode(d: &Decoder, tail: &[u8]) -> Result<Value,String> {
    let body = [bytes(1,b"key"), tail.to_vec()].concat();
    match d.decode(Some(&frame(1,&bytes(1,b"key"))),Some(&frame(2,&body)))?.2 {
        Mutation::Upsert{row} => Ok(row), _ => panic!("expected row"),
    }
}

#[test]
fn all_six_kinds_require_proto3_presence_independently_of_row_optionality() {
    for k in KINDS { for optional in [false,true] {
        let error = match setup(k,optional,false,"proto3",false,1) { Ok(_) => panic!("implicit {k:?}, optional={optional} admitted"), Err(e) => e };
        assert!(error.contains("SOURCE-PRESENCE") && error.contains("value") && error.contains("tag 2") && error.contains("proto3 optional"),"{error}");
    }}
}

#[test]
fn explicit_proto3_defaults_and_missing_required_values_are_distinct() {
    for k in KINDS { for optional in [false,true] {
        let d=setup(k,optional,false,"proto3",true,1).unwrap();
        let (wire,expected)=default_value(k); assert_eq!(decode(&d,&wire).unwrap(),json!({"id":"key","value":expected}));
        if optional { assert_eq!(decode(&d,&[]).unwrap(),json!({"id":"key"})); }
        else { assert_eq!(decode(&d,&[]).unwrap_err(),"missing required field: value"); }
    }}
}

#[test]
fn nullable_markers_preserve_presence_and_reject_conflicts() {
    for k in KINDS { for optional in [false,true] {
        let d=setup(k,optional,true,"proto3",true,1).unwrap();
        assert_eq!(decode(&d,&integer(3,1)).unwrap(),json!({"id":"key","value":null}));
        let (wire,expected)=default_value(k); assert_eq!(decode(&d,&wire).unwrap()["value"],expected);
        assert!(decode(&d,&[wire,integer(3,1)].concat()).is_err());
        assert!(decode(&d,&integer(3,0)).is_err());
        if optional { assert_eq!(decode(&d,&[]).unwrap(),json!({"id":"key"})); }
        else { assert!(decode(&d,&[]).is_err()); }
        assert!(setup(k,optional,true,"proto3",false,1).is_err());
    }}
}

#[test]
fn proto2_optional_and_required_wire_presence_stay_supported() {
    for k in KINDS { for optional in [false,true] { for label in [1,2] {
        let d=setup(k,optional,false,"proto2",false,label).unwrap();
        let (wire,expected)=default_value(k); assert_eq!(decode(&d,&wire).unwrap()["value"],expected);
        if optional && label==1 { assert_eq!(decode(&d,&[]).unwrap(),json!({"id":"key"})); }
        else { assert!(decode(&d,&[]).is_err()); }
        // No new proto2 nullable-marker support is introduced.
        assert!(setup(k,optional,true,"proto2",false,label).is_err());
    }}}
}

#[test]
fn explicit_keys_tombstones_and_invalid_empty_keys() {
    for syntax in ["proto2","proto3"] {
        let d=setup(Kind::String,false,false,syntax,true,1).unwrap();
        let key=frame(1,&bytes(1,b"key"));
        assert!(matches!(d.decode(Some(&key),None).unwrap().2,Mutation::Delete{key} if key=="key"));
        for bad in [frame(1,&[]),frame(1,&bytes(1,b""))] {
            assert!(d.decode(Some(&bad),None).is_err());
            assert!(d.decode(Some(&bad),Some(&frame(2,&[bytes(1,b"key"),bytes(2,b"")].concat()))).is_err());
        }
        assert!(d.decode(None,None).is_err());
        assert!(d.decode(Some(&key),Some(&frame(2,&[bytes(1,b"other"),bytes(2,b"")].concat()))).is_err());
        assert!(d.decode(Some(&key),Some(&frame(2,&bytes(2,b"")))).is_err());
    }
}

#[test]
fn implicit_proto3_key_binding_is_rejected() {
    let schema=Schema::new(serde_json::from_value(json!({"format":1,"id":"keys","version":1,"key":"id","fields":[{"name":"id","kind":"string","optional":false,"nullable":false}]})).unwrap()).unwrap();
    let result=Decoder::new(schema,&descriptor("proto3",&[("id",1,9,false,1)],1),&descriptor("proto3",&[("id",1,9,true,1)],2),1,vec![Mapping{field:"id".into(),tag:1,null_tag:None}]);
    let error=match result {Ok(_)=>panic!("implicit key admitted"),Err(e)=>e};
    assert!(error.contains("SOURCE-PRESENCE") && error.contains("key") && error.contains("tag 1"));
}

#[test]
fn implicit_null_marker_reports_its_field_and_tag() {
    let schema=Schema::new(serde_json::from_value(json!({"format":1,"id":"markers","version":1,"key":"id","fields":[{"name":"id","kind":"string","optional":false,"nullable":false},{"name":"value","kind":"number","optional":false,"nullable":true}]})).unwrap()).unwrap();
    let result=Decoder::new(schema,&descriptor("proto3",&[("id",1,9,true,1)],1),&descriptor("proto3",&[("id",1,9,true,1),("value",2,1,true,1),("null_value",3,8,false,1)],2),1,vec![Mapping{field:"id".into(),tag:1,null_tag:None},Mapping{field:"value".into(),tag:2,null_tag:Some(3)}]);
    let error=match result {Ok(_)=>panic!("implicit marker admitted"),Err(e)=>e};
    assert!(error.contains("SOURCE-PRESENCE") && error.contains("null marker") && error.contains("value") && error.contains("tag 3") && error.contains("proto3 optional"));
}
