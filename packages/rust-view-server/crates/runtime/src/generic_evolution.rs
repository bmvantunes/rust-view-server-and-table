//! Explicit single-predecessor optional-leaf admission and source dispatch.
use crate::generic_source::{Descriptor,Mapping,Decoder};
use crate::generic_kafka::SourceConfig;
use rust_differential_product_core::{schema::{Definition,Schema},generic::Mutation};
use prost::Message;
use prost_types::{FileDescriptorSet,DescriptorProto};
use serde::{Serialize,Deserialize};
use std::collections::BTreeMap;
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Predecessor {pub definition:Definition,pub value_descriptor:Descriptor,pub mapping:Vec<Mapping>}
fn descriptor_graph(d:&Descriptor)->Result<BTreeMap<String,DescriptorProto>,String>{
 if d.descriptor_hex.len()>131072||d.descriptor_hex.len()%2!=0||!d.descriptor_hex.bytes().all(|b|b.is_ascii_hexdigit()){return Err("evolution descriptor hex bound".into())}
 let bytes=(0..d.descriptor_hex.len()).step_by(2).map(|i|u8::from_str_radix(&d.descriptor_hex[i..i+2],16).map_err(|e|e.to_string())).collect::<Result<Vec<_>,_>>()?;
 let set=FileDescriptorSet::decode(bytes.as_slice()).map_err(|e|e.to_string())?;let mut out=BTreeMap::new();
 fn add(out:&mut BTreeMap<String,DescriptorProto>,prefix:&str,d:DescriptorProto){let n=format!("{}{}{}",prefix,if prefix.is_empty(){""}else{"."},d.name.as_deref().unwrap_or(""));for nested in &d.nested_type{add(out,&n,nested.clone());}let mut flat=d;flat.nested_type.clear();out.insert(n,flat);}
 for f in set.file {for d in f.message_type{add(&mut out,f.package.as_deref().unwrap_or(""),d);}}Ok(out)
}
pub fn admit(config:&SourceConfig,schema:&Schema)->Result<Option<(SourceConfig,Schema,Decoder)>,String>{
 let Some(previous)=&config.evolution else{return Ok(None)};
 if config.initialize_empty{return Err("evolution requires an existing canonical namespace".into())}
 let old=Schema::new(previous.definition.clone())?;rust_differential_product_core::evolution::optional_addition(&old,schema)?;
 if previous.value_descriptor.schema_id==config.value_descriptor.schema_id||previous.value_descriptor.message_index!=config.value_descriptor.message_index||previous.value_descriptor.message_name!=config.value_descriptor.message_name{return Err("evolution requires a distinct descriptor ID and identical root/index".into())}
 if config.mapping.len()<=previous.mapping.len()||serde_json::to_value(&config.mapping[..previous.mapping.len()]).unwrap()!=serde_json::to_value(&previous.mapping).unwrap(){return Err("evolution must preserve old wire field/null-marker mappings".into())}
 let identity=config.identity.as_ref().ok_or("evolution requires rowId identity")?;
 let decoder=Decoder::new_identity(old.clone(),&config.key_descriptor,&previous.value_descriptor,previous.mapping.clone(),config.key_fields.clone(),identity.clone())?;
 let a=descriptor_graph(&previous.value_descriptor)?;let b=descriptor_graph(&config.value_descriptor)?;
 if a.len()!=b.len(){return Err("evolution cannot change descriptor message graph".into())}
 for(n,x)in &a{let y=b.get(n).ok_or("evolution descriptor message removed")?;if !y.field.starts_with(&x.field)||!y.oneof_decl.starts_with(&x.oneof_decl){return Err("evolution changed an existing descriptor field".into())}let mut y=y.clone();y.field=x.field.clone();y.oneof_decl=x.oneof_decl.clone();if &y!=x{return Err("evolution changed descriptor message metadata".into())}}
 let mut prior=config.clone();prior.evolution=None;prior.schema=old.fingerprint().into();prior.value_descriptor=previous.value_descriptor.clone();prior.mapping=previous.mapping.clone();
 Ok(Some((prior,old,decoder)))
}
#[derive(Clone)]
pub struct SourceDecoder {current:Decoder,previous:Option<(u32,Decoder)>,schema:Schema}
impl SourceDecoder {
 pub fn new(current:Decoder,schema:Schema,previous:Option<(u32,Decoder)>)->Self{Self{current,previous,schema}}
 pub fn decode(&self,key:Option<&[u8]>,value:Option<&[u8]>)->Result<(String,[u8;32],Mutation),String>{
  let old=if let Some(bytes)=value{let id=crate::wire::envelope(bytes)?.schema_id;self.previous.as_ref().filter(|(expected,_)|*expected==id)}else{None};
  let result=if let Some((_,decoder))=old{decoder.decode(key,value)}else{self.current.decode(key,value)}?;
  if old.is_some(){if let Mutation::Upsert{row}=&result.2{self.schema.row(row)?;}}Ok(result)
 }
}
