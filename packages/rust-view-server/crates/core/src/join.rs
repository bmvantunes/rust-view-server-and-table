//! Bounded many-to-one enrichment feeding the existing incremental evaluator.
use crate::{generic::{Runtime,Mutation,Query,ResultRows},schema::{self,Catalog,Definition,Expansion,Field,Leaf,Parent,Manifest,Topic,Schema,Row,Scalar}};
use serde::{Deserialize,Serialize};
use serde_json::{json,Value,Map};
use sha2::{Digest,Sha256};
use std::collections::{BTreeMap,BTreeSet};
const MAX_PENDING:usize=65_536;
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JoinRight {pub topic:String,pub schema:String,pub alias:String}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JoinOn {pub left:String,pub right:String}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JoinLimits {pub max_left_rows_per_key:usize,pub max_output_rows:usize}
#[derive(Clone,Debug,Serialize,Deserialize,PartialEq)]
#[serde(rename_all="snake_case")]
pub enum JoinKind {Inner,Left}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JoinDefinition {pub version:u8,pub left_alias:String,pub right:JoinRight,pub kind:JoinKind,pub cardinality:String,pub on:JoinOn,pub limits:JoinLimits}
fn failure(s:&str)->String{format!("join query failed: {s}")}
fn key(row:&Row,index:usize)->Option<String>{match &row.cells[index]{Scalar::Missing|Scalar::Null=>None,v=>Some(v.sort_token())}}
fn insert_index(index:&mut BTreeMap<String,BTreeSet<String>>,key:&str,id:&str){index.entry(key.into()).or_default().insert(id.into());}
fn remove_index(index:&mut BTreeMap<String,BTreeSet<String>>,key:&str,id:&str){if let Some(set)=index.get_mut(key){set.remove(id);if set.is_empty(){index.remove(key);}}}
pub(crate) struct JoinState {
 pub left:String,pub definition:JoinDefinition,pub references:usize,pub error:Option<String>,pub touched:u64,pub seed_rows:u64,
 left_schema:Schema,right_schema:Schema,left_field:usize,right_field:usize,
 left_index:BTreeMap<String,BTreeSet<String>>,right_index:BTreeMap<String,BTreeSet<String>>,
 left_keys:BTreeMap<String,Option<String>>,right_keys:BTreeMap<String,Option<String>>,
 inner:Box<Runtime>,topic:String,fingerprint:String,signature:String,
 public_keys:BTreeMap<String,String>,unmatched:BTreeSet<String>,
}
impl JoinState {
 pub fn signature(left:&str,fingerprint:&str,d:&JoinDefinition)->String{serde_json::to_string(&json!([1,left,fingerprint,d])).unwrap()}
 pub fn new(left:&str,ls:&Schema,rs:&Schema,d:JoinDefinition,left_rows:&BTreeMap<String,Row>,right_rows:&BTreeMap<String,Row>,left_bound:usize)->Result<Self,String>{
  if d.version!=1||d.cardinality!="many_to_one"||left==d.right.topic||!schema::valid_name(&d.left_alias)||!schema::valid_name(&d.right.alias)||d.left_alias=="rowId"||d.right.alias=="rowId"||d.left_alias==d.right.alias||d.limits.max_left_rows_per_key==0||d.limits.max_left_rows_per_key>1024||d.limits.max_output_rows==0||d.limits.max_output_rows>100000||d.limits.max_output_rows>left_bound{return Err("join definition/cardinality/limit bound".into())}
  let li=ls.index(&d.on.left)?;let ri=rs.index(&d.on.right)?;let ld=ls.definition();let rd=rs.definition();
  if ld.fields[li].kind!=rd.fields[ri].kind{return Err("join key scalar domain mismatch".into())}
  let domain=|s:&Schema,i:usize|s.definition().expansion.as_ref().and_then(|e|e.leaves[i].enum_domain.clone());
  if domain(ls,li)!=domain(rs,ri){return Err("join key enum domain mismatch".into())}
  let signature=Self::signature(left,ls.fingerprint(),&d);let hash=format!("{:x}",Sha256::digest(signature.as_bytes()));let topic=format!("j{}",&hash[..16]);
  let mut fields=vec![];let mut leaves=vec![];let mut parents=vec![];let mut enums=BTreeMap::new();
  for (s,alias,right) in [(ls,d.left_alias.as_str(),false),(rs,d.right.alias.as_str(),true)]{
   parents.push(Parent{path:alias.into(),message:"JoinSource".into(),required:true});
   if let Some(e)=&s.definition().expansion {for p in &e.parents{parents.push(Parent{path:format!("{alias}.{}",p.path),message:p.message.clone(),required:p.required});}for (name,labels) in &e.enums{if enums.get(name).is_some_and(|old|old!=labels){return Err("conflicting enum domain definitions".into())}enums.insert(name.clone(),labels.clone());}}
   for (i,f) in s.definition().fields.iter().enumerate(){let name=format!("{alias}.{}",f.name);let source_leaf=s.definition().expansion.as_ref().map(|e|&e.leaves[i]);fields.push(Field{name:name.clone(),kind:f.kind,optional:f.optional,nullable:f.nullable||right&&d.kind==JoinKind::Left});leaves.push(Leaf{path:name,presence:"explicit".into(),required:source_leaf.map_or(!f.optional,|l|l.required),enum_domain:source_leaf.and_then(|l|l.enum_domain.clone())});}
  }
  let schema=Schema::new(Definition{format:3,version:3,id:topic.clone(),key:"rowId".into(),fields,expansion:Some(Expansion{message:"JoinResult".into(),parents,leaves,enums})})?;let fingerprint=schema.fingerprint().to_string();
  let catalog=Catalog::new(Manifest{format:1,schemas:vec![schema.definition().clone()],topics:vec![Topic{topic:topic.clone(),schema:fingerprint.clone()}]})?;
  let mut state=Self{left:left.into(),definition:d,references:0,error:None,touched:0,seed_rows:(left_rows.len()+right_rows.len())as u64,left_schema:ls.clone(),right_schema:rs.clone(),left_field:li,right_field:ri,left_index:BTreeMap::new(),right_index:BTreeMap::new(),left_keys:BTreeMap::new(),right_keys:BTreeMap::new(),inner:Box::new(Runtime::new(catalog,left_bound.min(100000))?),topic,fingerprint,signature,public_keys:BTreeMap::new(),unmatched:BTreeSet::new()};
  for (id,row)in left_rows{let k=key(row,li);if let Some(k)=&k{insert_index(&mut state.left_index,k,id)}state.left_keys.insert(id.clone(),k);}
  for (id,row)in right_rows{let k=key(row,ri);if let Some(k)=&k{insert_index(&mut state.right_index,k,id)}state.right_keys.insert(id.clone(),k);}
  state.check_indexes()?;
  // Seed in bounded chunks; no query consumes an incomplete initial relation.
  for ids in left_rows.keys().cloned().collect::<Vec<_>>().chunks(1024){state.materialize(ids.iter().cloned(),left_rows,right_rows)?;}Ok(state)
 }
 fn check_indexes(&self)->Result<(),String>{if self.right_index.values().any(|v|v.len()>1){return Err(failure("right join key is not unique"))}if self.left_index.values().any(|v|v.len()>self.definition.limits.max_left_rows_per_key){return Err(failure("left key fanout exceeded"))}Ok(())}
 fn identities(&self,id:&str)->(String,String){let d=&self.definition;let value=json!([1,self.left,self.left_schema.fingerprint(),d.right.topic,d.right.schema,d.left_alias,d.right.alias,d.on.left,d.on.right,d.kind,"many_to_one",id]);let public=format!("jid1:{:x}",Sha256::digest(serde_json::to_vec(&value).unwrap()));let internal=schema::encode_row_id(&[Scalar::String(public.clone())]).expect("bounded join hash");(internal,public)}
 fn materialize(&mut self,ids:impl IntoIterator<Item=String>,left_rows:&BTreeMap<String,Row>,right_rows:&BTreeMap<String,Row>)->Result<(),String>{
  let mut changes=Vec::new();
  for id in ids {self.touched+=1;let(internal,public)=self.identities(&id);let left=left_rows.get(&id);let right=left.and_then(|r|key(r,self.left_field)).and_then(|k|self.right_index.get(&k)).and_then(|set|set.first()).and_then(|r|right_rows.get(r));
   if let Some(left)=left.filter(|_|right.is_some()||self.definition.kind==JoinKind::Left){let mut row=Map::new();row.insert("rowId".into(),json!(internal));let mut value=self.left_schema.full(left);value.as_object_mut().unwrap().remove("rowId");row.insert(self.definition.left_alias.clone(),value);
    let value=if let Some(right)=right {let mut value=self.right_schema.full(right);value.as_object_mut().unwrap().remove("rowId");self.unmatched.remove(&internal);value}else{self.unmatched.insert(internal.clone());let mut v=Map::new();for field in &self.right_schema.definition().fields{schema::path_insert(&mut v,&field.name,Value::Null)}Value::Object(v)};
    row.insert(self.definition.right.alias.clone(),value);self.public_keys.insert(internal.clone(),public);changes.push(Mutation::Upsert{row:Value::Object(row)});
   }else{self.unmatched.remove(&internal);if self.public_keys.remove(&internal).is_some(){changes.push(Mutation::Delete{key:internal});}}
  }
  if self.public_keys.len()>self.definition.limits.max_output_rows{return Err(failure("join output row quota"))}
  for chunk in changes.chunks(1024){self.inner.apply_committed(&self.topic,&self.fingerprint,chunk).map_err(|e|failure(&e))?;}Ok(())
 }
 pub fn update(&mut self,topic:&str,changed:&[String],left_rows:&BTreeMap<String,Row>,right_rows:&BTreeMap<String,Row>)->Result<(),String>{
  let mut affected=BTreeSet::new();let mut keys=BTreeSet::new();
  if topic==self.left{
   for id in changed{affected.insert(id.clone());if let Some(Some(k))=self.left_keys.remove(id){remove_index(&mut self.left_index,&k,id);keys.insert(k);}}
   for id in changed{if let Some(row)=left_rows.get(id){let k=key(row,self.left_field);if let Some(k)=&k{insert_index(&mut self.left_index,k,id);keys.insert(k.clone());}self.left_keys.insert(id.clone(),k);}}
  }else{
   for id in changed{if let Some(Some(k))=self.right_keys.remove(id){remove_index(&mut self.right_index,&k,id);keys.insert(k);}}
   for id in changed{if let Some(row)=right_rows.get(id){let k=key(row,self.right_field);if let Some(k)=&k{insert_index(&mut self.right_index,k,id);keys.insert(k.clone());}self.right_keys.insert(id.clone(),k);}}
   for k in &keys{if let Some(ids)=self.left_index.get(k){for id in ids{if affected.len()>=MAX_PENDING&&!affected.contains(id){return Err(failure("pending contribution quota"))}affected.insert(id.clone());}}}
  }
  for k in keys{if self.right_index.get(&k).is_some_and(|v|v.len()>1){return Err(failure("right join key is not unique"))}if self.left_index.get(&k).is_some_and(|v|v.len()>self.definition.limits.max_left_rows_per_key){return Err(failure("left key fanout exceeded"))}}self.materialize(affected,left_rows,right_rows)
 }
 pub fn open(&mut self,id:&str,query:Query)->Result<(),String>{if let Some(e)=&self.error{return Err(e.clone())}if query.aggregates.as_ref().is_some_and(|a|a.contains_key(&self.definition.left_alias)||a.contains_key(&self.definition.right.alias)){return Err("aggregate alias collides with join alias".into())}self.inner.open(id,&self.topic,&self.fingerprint,query)}
 pub fn close(&mut self,id:&str)->Result<(),String>{self.inner.close(id)}
 pub fn read(&self,id:&str,offset:usize,limit:usize,bytes:usize)->Result<ResultRows,String>{if let Some(e)=&self.error{return Err(e.clone())}let mut result=self.inner.read(id,offset,limit,bytes)?;let grouped=result.result_shape.is_some();if !grouped {for (key,row)in result.keys.iter_mut().zip(&mut result.rows){if self.unmatched.contains(key)&&row.get(&self.definition.right.alias).is_some(){row[&self.definition.right.alias]=Value::Null;}*key=self.public_keys[key].clone();}}
  result.result_shape=Some(serde_json::to_string(&json!(["join_v1",self.signature,result.result_shape,result.projection])).unwrap());result.topic=self.left.clone();result.schema=self.left_schema.fingerprint().into();if serde_json::to_vec(&result).unwrap().len()>bytes{return Err("projected result byte bound".into())}Ok(result)
 }
}
