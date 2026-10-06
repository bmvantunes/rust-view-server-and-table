//! Explicit v15 finite scalar MessagePack mode. Exact i64/u64/decimals are
//! schema-validated canonical strings; no product-field-name coercion occurs.
use super::{R,J,MAX_FRAME,MAX_DEPTH,MAX_COLLECTION,SAFE,budget};
use rmpv::Value as V;
fn prepare(j:&J,d:usize,n:&mut usize)->R<V>{budget(d,n)?;Ok(match j{
 J::Null=>V::Nil,J::Bool(b)=>V::Boolean(*b),J::String(s)=>V::String(s.as_str().into()),
 J::Number(v)=>{if let Some(i)=v.as_i64().filter(|i|(-SAFE..=SAFE).contains(i)){V::Integer(i.into())}else{let f=v.as_f64().filter(|f|f.is_finite()).ok_or("finite number")?;V::F64(if f==0.0{0.0}else{f})}},
 J::Array(a)=>{if a.len()>MAX_COLLECTION{return Err("collection".into())}V::Array(a.iter().map(|x|prepare(x,d+1,n)).collect::<R<_>>()?)},
 J::Object(o)=>{if o.len()>MAX_COLLECTION{return Err("collection".into())}let mut m=Vec::new();for(k,v)in o{budget(d+1,n)?;m.push((V::String(k.as_str().into()),prepare(v,d+1,n)?));}V::Map(m)}
})}
fn adapt(v:V,d:usize,n:&mut usize)->R<J>{budget(d,n)?;Ok(match v{
 V::Nil=>J::Null,V::Boolean(b)=>J::Bool(b),V::String(s)=>J::String(s.into_str().ok_or("UTF8")?),
 V::Integer(i)=>J::from(i.as_i64().filter(|i|(-SAFE..=SAFE).contains(i)).ok_or("safe scalar integer marker required")?),
 V::F64(f)=>J::Number(serde_json::Number::from_f64(if f==0.0{0.0}else{f}).ok_or("finite number")?),
 V::Array(a)=>{if a.len()>MAX_COLLECTION{return Err("collection".into())}J::Array(a.into_iter().map(|v|adapt(v,d+1,n)).collect::<R<_>>()?)},
 V::Map(m)=>{if m.len()>MAX_COLLECTION{return Err("collection".into())}let mut o=serde_json::Map::new();for(k,v)in m{budget(d+1,n)?;let k=k.as_str().ok_or("map key")?.to_string();if o.insert(k,adapt(v,d+1,n)?).is_some(){return Err("duplicate member".into())}}J::Object(o)},
 _=>return Err("unsupported generic scalar marker".into())
})}
pub fn encode(value:&J)->R<Vec<u8>>{let mut bytes=Vec::new();rmpv::encode::write_value(&mut bytes,&prepare(value,0,&mut 0)?).map_err(|e|e.to_string())?;if bytes.len()>MAX_FRAME{return Err("frame budget".into())}Ok(bytes)}
pub fn decode(bytes:&[u8])->R<J>{super::scan::preflight_generic_mp(bytes)?;let mut c=std::io::Cursor::new(bytes);let v=rmpv::decode::read_value_with_max_depth(&mut c,2*MAX_DEPTH+4).map_err(|e|e.to_string())?;if c.position()!=bytes.len()as u64{return Err("trailing bytes".into())}adapt(v,0,&mut 0)}
#[cfg(test)]mod tests{use super::*;#[test]fn explicit_finite_mode(){let v=serde_json::json!({"quantity":"text","coefficient":"literal","number":1.5,"exact":"18446744073709551615"});let b=encode(&v).unwrap();assert_eq!(decode(&b).unwrap(),v);assert!(super::super::decode_mp(&b).is_err());}#[test]fn malformed(){assert!(decode(&[0xcb,0x7f,0xf0,0,0,0,0,0,0]).is_err());assert!(decode(&[0x82,0xa1,b'x',1,0xa1,b'x',2]).is_err());}}
