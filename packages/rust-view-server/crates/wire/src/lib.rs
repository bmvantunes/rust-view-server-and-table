//! Isolated experiment. No evaluator/SQL/Kafka types enter the codec.
use num_bigint::{BigInt,Sign};
#[cfg(feature="protobuf")]
use prost::Message;
use serde_json::{Value as J,Map};
#[cfg(feature="msgpack")]
use std::io::Cursor;
pub const MAX_FRAME:usize=4*1024*1024;
pub const MAX_VALUES:usize=65536;
pub const MAX_COLLECTION:usize=8192;
pub const MAX_DEPTH:usize=128;
pub const MAX_EXACT:usize=4154;
const SAFE:i64=9_007_199_254_740_991;
type R<T>=Result<T,String>;
#[derive(Clone,PartialEq)]
#[cfg_attr(feature="protobuf",derive(Message))]
pub struct Value {#[cfg_attr(feature="protobuf",prost(oneof="value::V",tags="1,2,3,4,5,6,7,8"))]pub value:Option<value::V>}
pub mod value {use super::*;#[derive(Clone,PartialEq)]#[cfg_attr(feature="protobuf",derive(prost::Oneof))]pub enum V {#[cfg_attr(feature="protobuf",prost(bool,tag="1"))]Nil(bool),#[cfg_attr(feature="protobuf",prost(bool,tag="2"))]Boolean(bool),#[cfg_attr(feature="protobuf",prost(sint64,tag="3"))]Integer(i64),#[cfg_attr(feature="protobuf",prost(string,tag="4"))]Text(String),#[cfg_attr(feature="protobuf",prost(bytes,tag="5"))]Binary(Vec<u8>),#[cfg_attr(feature="protobuf",prost(message,tag="6"))]Sequence(Sequence),#[cfg_attr(feature="protobuf",prost(message,tag="7"))]Object(Object),#[cfg_attr(feature="protobuf",prost(bytes,tag="8"))]Exact(Vec<u8>)}}
#[derive(Clone,PartialEq)]
#[cfg_attr(feature="protobuf",derive(Message))]pub struct Sequence {#[cfg_attr(feature="protobuf",prost(message,repeated,tag="1"))]pub items:Vec<Value>}
#[derive(Clone,PartialEq)]
#[cfg_attr(feature="protobuf",derive(Message))]pub struct Entry {#[cfg_attr(feature="protobuf",prost(string,tag="1"))]pub key:String,#[cfg_attr(feature="protobuf",prost(message,optional,tag="2"))]pub value:Option<Value>}
#[derive(Clone,PartialEq)]
#[cfg_attr(feature="protobuf",derive(Message))]pub struct Object {#[cfg_attr(feature="protobuf",prost(message,repeated,tag="1"))]pub entries:Vec<Entry>}
fn wrap(v:value::V)->Value{Value{value:Some(v)}}
pub fn exact(s:&str)->R<Vec<u8>>{
 if s.is_empty()||s.len()>10001{return Err("exact length".into())}let digits=s.strip_prefix('-').unwrap_or(s);
 if digits.is_empty() || !digits.bytes().all(|b|b.is_ascii_digit()) || (digits.starts_with('0') && s!="0") {return Err("canonical exact value required".into())}
 let n=s.parse::<BigInt>().map_err(|_|"exact parse")?;let (sign,mut b)=n.to_bytes_be();if n==BigInt::from(0){b.clear()};let mut out=vec![u8::from(sign==Sign::Minus)];out.extend(b);Ok(out)
}
pub fn exact_text(b:&[u8])->R<String>{
 if b.is_empty()||b.len()>MAX_EXACT+1||b[0]>1||b.get(1)==Some(&0)||(b[0]==1&&b.len()==1){return Err("noncanonical exact".into())}
 let n=BigInt::from_bytes_be(if b[0]==1{Sign::Minus}else{Sign::Plus},&b[1..]);let s=n.to_string();if s.len()>10001{return Err("exact domain".into())}Ok(s)
}
pub fn prepare(j:&J)->R<Value>{prepare_key(j,"",0,&mut 0)}
fn prepare_key(j:&J,key:&str,depth:usize,count:&mut usize)->R<Value>{
 budget(depth,count)?;use value::V::*;
 if key=="limit" { if let Some(n)=j.as_u64() {return Ok(wrap(Exact(exact(&n.to_string())?)))} }
 Ok(wrap(match j {
 J::Null=>Nil(true),J::Bool(v)=>Boolean(*v),J::Number(v)=>{let n=v.as_i64().ok_or("metadata integer")?;if !(-SAFE..=SAFE).contains(&n){return Err("metadata bounds".into())}Integer(n)},
 J::String(s)=>if ["quantity","coefficient","source_sequence","connection","limit"].contains(&key){if ["source_sequence","connection","limit"].contains(&key){s.parse::<u64>().map_err(|_|"u64 metadata")?;}Exact(exact(s)?)}else{Text(s.clone())},
 J::Array(a)=>{if a.len()>MAX_COLLECTION{return Err("collection".into())}Sequence(crate::Sequence{items:a.iter().map(|x|prepare_key(x,"",depth+1,count)).collect::<R<_>>()?})},
 J::Object(o)=>{if o.len()>MAX_COLLECTION{return Err("collection".into())}let mut entries=Vec::new();for(k,v)in o{budget(depth+1,count)?;let mut converted=prepare_key(v,k,depth+1,count)?;
 // The supported native quantity predicate's value is an exact integer too.
 if k=="condition"&&o.get("field").and_then(J::as_str)==Some("quantity"){if let Some(Object(obj))=converted.value.as_mut(){for e in &mut obj.entries{if e.key=="value"{e.value=Some(wrap(Exact(exact(v["value"].as_str().ok_or("predicate exact")?)?)));}}}}
 entries.push(Entry{key:k.clone(),value:Some(converted)});}Object(crate::Object{entries})}
 }))
}
pub fn adapt(v:&Value)->R<J>{adapt_at(v,0,&mut 0)}
fn adapt_at(v:&Value,d:usize,n:&mut usize)->R<J>{budget(d,n)?;use value::V::*;Ok(match v.value.as_ref().ok_or("absent variant")?{
 Nil(true)=>J::Null,Nil(false)=>return Err("nil sentinel".into()),Boolean(b)=>J::Bool(*b),Integer(i)=>{if !(-SAFE..=SAFE).contains(i){return Err("safe metadata".into())}J::from(*i)},Text(s)=>J::String(s.clone()),Exact(b)=>J::String(exact_text(b)?),Binary(_)=>return Err("binary has no product JSON adapter; use typed fixture".into()),
 Sequence(a)=>{if a.items.len()>MAX_COLLECTION{return Err("collection".into())}J::Array(a.items.iter().map(|v|adapt_at(v,d+1,n)).collect::<R<_>>()?)},
 Object(o)=>{if o.entries.len()>MAX_COLLECTION{return Err("collection".into())}let mut m=Map::new();for e in &o.entries{budget(d+1,n)?;if ["quantity","coefficient","source_sequence","connection","limit"].contains(&e.key.as_str())&&!matches!(e.value.as_ref().and_then(|v|v.value.as_ref()),Some(Exact(_))){return Err("exact variant required".into())}let mut j=adapt_at(e.value.as_ref().ok_or("missing value")?,d+1,n)?;if e.key=="limit" {j=J::from(j.as_str().ok_or("limit")?.parse::<u64>().map_err(|_|"u64 limit")?);}if m.insert(e.key.clone(),j).is_some(){return Err("duplicate key".into())}}if m.get("field").and_then(J::as_str)==Some("quantity"){if let Some(e)=o.entries.iter().find(|e|e.key=="condition"){if let Some(Object(condition))=e.value.as_ref().and_then(|v|v.value.as_ref()){if let Some(v)=condition.entries.iter().find(|e|e.key=="value"){if !matches!(v.value.as_ref().and_then(|v|v.value.as_ref()),Some(Exact(_))){return Err("predicate exact variant required".into())}}}}}if let Some(c)=m.get("coefficient"){let scale=m.get("scale").and_then(J::as_i64).ok_or("decimal scale")?;if !(-10000..=10000).contains(&scale){return Err("decimal scale".into())}let n=c.as_str().ok_or("coefficient")?.parse::<BigInt>().map_err(|_|"coefficient")?;if if n==BigInt::from(0){scale!=0}else{scale> -10000&&&n%10u8==BigInt::from(0)}{return Err("noncanonical decimal".into())}}for k in ["source_sequence","connection"]{if let Some(v)=m.get(k){v.as_str().ok_or("u64 metadata")?.parse::<u64>().map_err(|_|"u64 metadata")?;}}J::Object(m)}
 })}
fn budget(d:usize,n:&mut usize)->R<()>{*n+=1;if d>MAX_DEPTH||*n>MAX_VALUES{Err("depth/value budget".into())}else{Ok(())}}
#[cfg(feature="protobuf")]
pub fn encode_pb(v:&Value)->R<Vec<u8>>{let b=v.encode_to_vec();if b.len()>MAX_FRAME{return Err("frame budget".into())}Ok(b)}
#[cfg(feature="protobuf")]
pub fn decode_pb(b:&[u8])->R<Value>{preflight_pb(b)?;let v=Value::decode(b).map_err(|e|e.to_string())?;validate(&v)?;Ok(v)}
#[cfg(feature="msgpack")]
fn to_mp(v:&Value)->R<rmpv::Value>{use value::V::*;Ok(match v.value.as_ref().ok_or("variant")?{Nil(true)=>rmpv::Value::Nil,Nil(false)=>return Err("nil".into()),Boolean(v)=>rmpv::Value::Boolean(*v),Integer(v)=>rmpv::Value::Integer((*v).into()),Text(v)=>v.as_str().into(),Binary(v)=>rmpv::Value::Binary(v.clone()),Exact(v)=>rmpv::Value::Ext(42,v.clone()),Sequence(v)=>rmpv::Value::Array(v.items.iter().map(to_mp).collect::<R<_>>()?),Object(v)=>rmpv::Value::Map(v.entries.iter().map(|e|Ok((e.key.clone().into(),to_mp(e.value.as_ref().ok_or("value")?)?))).collect::<R<_>>()?)})}
#[cfg(feature="msgpack")]
fn from_mp(v:rmpv::Value)->R<Value>{use value::V::*;Ok(wrap(match v{rmpv::Value::Nil=>Nil(true),rmpv::Value::Boolean(b)=>Boolean(b),rmpv::Value::Integer(n)=>Integer(n.as_i64().ok_or("metadata overflow")?),rmpv::Value::String(s)=>Text(s.into_str().ok_or("UTF8")?),rmpv::Value::Binary(b)=>Binary(b),rmpv::Value::Ext(42,b)=>Exact(b),rmpv::Value::Array(a)=>Sequence(crate::Sequence{items:a.into_iter().map(from_mp).collect::<R<_>>()?}),rmpv::Value::Map(m)=>Object(crate::Object{entries:m.into_iter().map(|(k,v)|Ok(Entry{key:k.as_str().ok_or("map key")?.into(),value:Some(from_mp(v)?)})).collect::<R<_>>()?}),_=>return Err("unsupported MP value".into())}))}
#[cfg(feature="msgpack")]
pub fn encode_mp(v:&Value)->R<Vec<u8>>{let mut b=Vec::new();rmpv::encode::write_value(&mut b,&to_mp(v)?).map_err(|e|e.to_string())?;if b.len()>MAX_FRAME{return Err("frame budget".into())}Ok(b)}
#[cfg(feature="msgpack")]
pub fn decode_mp(b:&[u8])->R<Value>{preflight_mp(b)?;let mut c=Cursor::new(b);let v=from_mp(rmpv::decode::read_value_with_max_depth(&mut c,2*MAX_DEPTH+4).map_err(|e|e.to_string())?)?;if c.position()!=b.len() as u64{return Err("trailing bytes".into())}validate(&v)?;Ok(v)}
pub fn validate(v:&Value)->R<()>{fn go(v:&Value,d:usize,n:&mut usize)->R<()>{budget(d,n)?;use value::V::*;match v.value.as_ref().ok_or("variant")?{Nil(false)=>return Err("nil".into()),Integer(i) if !(-SAFE..=SAFE).contains(i)=>return Err("metadata".into()),Exact(b)=>{exact_text(b)?;},Sequence(a)=>{if a.items.len()>MAX_COLLECTION{return Err("collection".into())}for v in &a.items{go(v,d+1,n)?}},Object(o)=>{if o.entries.len()>MAX_COLLECTION{return Err("collection".into())}let mut keys=std::collections::HashSet::new();for e in &o.entries{budget(d+1,n)?;if !keys.insert(&e.key){return Err("duplicate key".into())}go(e.value.as_ref().ok_or("value")?,d+1,n)?}},_=>{}}Ok(())}go(v,0,&mut 0)}
mod scan;
pub use scan::{preflight_pb,preflight_mp};

#[cfg(feature="msgpack")]
pub mod generic;
