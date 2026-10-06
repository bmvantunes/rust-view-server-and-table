use product_source_ingestion::generic_source::{Decoder,Descriptor,Mapping};
use rust_differential_product_core::schema::Schema;
use serde_json::json;
fn vi(mut n:u64)->Vec<u8>{let mut b=vec![];while n>127{b.push((n as u8&127)|128);n>>=7;}b.push(n as u8);b}
fn text(tag:u64,b:&[u8])->Vec<u8>{let mut v=vi(tag*8+2);v.extend(vi(b.len() as u64));v.extend(b);v}
fn number(tag:u64,n:u64)->Vec<u8>{let mut v=vi(tag*8);v.extend(vi(n));v}
fn descriptor(fields:&[(&str,u64,u64)],id:u32)->Descriptor{let mut msg=text(1,b"Row");for(name,tag,kind)in fields{let mut f=text(1,name.as_bytes());f.extend(number(3,*tag));f.extend(number(4,1));f.extend(number(5,*kind));msg.extend(text(2,&f));}let mut file=text(4,&msg);file.extend(text(12,b"proto3"));Descriptor{message_name:None,schema_id:id,message_index:0,descriptor_hex:text(1,&file).iter().map(|b|format!("{b:02x}")).collect()}}
fn frame(id:u32,body:Vec<u8>)->Vec<u8>{let mut b=vec![0];b.extend(id.to_be_bytes());b.push(0);b.extend(body);b}
#[test]fn omitted_required_source_value_must_not_be_defaulted(){
let schema=Schema::new(serde_json::from_value(json!({"format":1,"id":"presence","version":1,"key":"id","fields":[{"name":"id","kind":"string","optional":false,"nullable":false},{"name":"risk","kind":"number","optional":false,"nullable":false}]})).unwrap()).unwrap();
let key=descriptor(&[("id",1,9)],1);let value=descriptor(&[("id",1,9),("risk",2,1)],2);
let decoder=Decoder::new(schema,&key,&value,1,vec![Mapping{field:"id".into(),tag:1,null_tag:None},Mapping{field:"risk".into(),tag:2,null_tag:None}]);
if let Ok(d)=decoder {let result=d.decode(Some(&frame(1,text(1,b"a"))),Some(&frame(2,text(1,b"a"))));println!("OMITTED_REQUIRED_RESULT={result:?}");assert!(result.is_err(),"required risk was omitted from wire but silently defaulted");}
}
