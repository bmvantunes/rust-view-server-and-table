//! Raw full-source acquisition: immutable bounded snapshot, credit-driven chunks,
//! then a bounded ordered live tail. Source commits remain the only authority.
use rust_differential_product_core::generic::{Mutation, Runtime};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};
const ROWS: usize = 250_000;
const BYTES: usize = 128 * 1024 * 1024;
const TAIL_BYTES: usize = 16 * 1024 * 1024;
const CHUNK_BYTES: usize = 512 * 1024;
const CHUNK_ROWS: usize = 512;
#[derive(Deserialize)]
#[serde(tag="op", rename_all="snake_case", deny_unknown_fields)]
pub enum Request { Open { acquisition:String, topic:String, schema:String }, Next { acquisition:String, acknowledged:u64 }, Cancel { acquisition:String } }
struct Acquisition { id:String, topic:String, snapshot:VecDeque<Vec<Value>>, tail:VecDeque<Value>, tail_bytes:usize, cut:Value, snapshot_cut:Value, epoch:Option<(usize,Value)>, delivered_cut:Value, sequence:u64, complete:bool, failed:bool }
#[derive(Default)]
pub struct Complete { entries:BTreeMap<u64,Acquisition> }
impl Complete {
 pub fn topic(&self, connection:u64, request:&Request)->Option<String>{ match request { Request::Open{topic,..}=>Some(topic.clone()), _=>self.entries.get(&connection).map(|a|a.topic.clone()) } }
 pub fn open(&mut self,connection:u64,id:String,topic:String,schema:&str,runtime:&mut Runtime,cut:Value)->Result<Value,String>{
  if id.len()!=32||!id.bytes().all(|b|b.is_ascii_hexdigit()){return Err("complete acquisition identity".into())}
  if !self.entries.contains_key(&connection)&&self.entries.len()>=2{return Err("complete acquisition quota".into())}
  let query_id=format!("complete/{connection}/{id}");
  let definition=runtime.catalog().schema(&topic,schema)?.definition();
  if definition.format<2{return Err("complete source requires authoritative rowId schema".into())}
  let fields=definition.fields.iter().map(|field|field.name.clone()).collect::<Vec<_>>();
  let query=serde_json::from_value(json!({"select":fields,"order_by":[]})).map_err(|e|format!("{e}"))?;
  runtime.open(&query_id,&topic,schema,query)?;
  let captured=(||{
   let mut chunks=VecDeque::new();let mut chunk=Vec::new();let mut chunk_bytes=0usize;let mut bytes=0usize;let mut offset=0;
   loop {let read=runtime.read(&query_id,offset,CHUNK_ROWS,1024*1024)?;
    if read.total_rows>ROWS{return Err("complete snapshot row budget".to_string())}
    for (key,mut row) in read.keys.into_iter().zip(read.rows) {row.as_object_mut().ok_or("complete row object")?.insert("rowId".into(),json!(key));let size=serde_json::to_vec(&row).map_err(|e|e.to_string())?.len();if size>CHUNK_BYTES{return Err("complete row byte budget".into())}bytes+=size;if bytes>BYTES{return Err("complete snapshot byte budget".into())}
     if !chunk.is_empty()&&(chunk.len()>=CHUNK_ROWS||chunk_bytes+size>CHUNK_BYTES){chunks.push_back(std::mem::take(&mut chunk));chunk_bytes=0;}
     chunk.push(row);chunk_bytes+=size;
    }
    offset+=CHUNK_ROWS;if offset>=read.total_rows{break}
   }
   if !chunk.is_empty(){chunks.push_back(chunk)}Ok(chunks)
  })();
  runtime.close(&query_id)?;let snapshot=captured?;
  self.entries.insert(connection,Acquisition{id:id.clone(),topic,snapshot,tail:VecDeque::new(),tail_bytes:0,snapshot_cut:cut.clone(),delivered_cut:cut.clone(),epoch:None,cut,sequence:0,complete:false,failed:false});
  self.next(connection,&id,0)
 }
 pub fn committed(&mut self,topic:&str,mutations:&[Mutation],cut:&Value){
  for a in self.entries.values_mut().filter(|a|a.topic==topic){
   a.cut=cut.clone();if a.failed{continue}
   // Source batches are atomic; coalesce repeated identities and apply final
   // deletes before upserts so a replacement at maxRows never transiently overflows.
   let mut final_changes=BTreeMap::new();
   for m in mutations {let key=match m{Mutation::Delete{key}=>key.clone(),Mutation::Upsert{row}=>row["rowId"].as_str().unwrap_or("").to_owned()};final_changes.insert(key,m);}
   let ordered=final_changes.values().filter(|m|matches!(m,Mutation::Delete{..})).chain(final_changes.values().filter(|m|matches!(m,Mutation::Upsert{..})));
   for mutation in ordered {let v=serde_json::to_value(mutation).expect("mutation serialization");let size=serde_json::to_vec(&v).expect("mutation serialization").len();
    if size>CHUNK_BYTES||a.tail_bytes+size>TAIL_BYTES {a.failed=true;a.snapshot.clear();a.tail.clear();a.tail_bytes=0;break}
    a.tail_bytes+=size;a.tail.push_back(v);
   }
  }
 }
 pub fn next(&mut self,connection:u64,id:&str,acknowledged:u64)->Result<Value,String>{
  let a=self.entries.get_mut(&connection).ok_or("complete acquisition absent")?;
  if a.id!=id||a.sequence!=acknowledged{return Err("complete acquisition sequence".into())}
  if a.failed{self.entries.remove(&connection);return Err("complete tail overflow; reacquire".into())}
  a.sequence+=1;
  let (kind,rows,mutations,response_cut)=if let Some(rows)=a.snapshot.pop_front(){("snapshot",rows,vec![],a.snapshot_cut.clone())}else{
   // Freeze a finite commit boundary. Later arrivals belong to the next epoch;
   // they cannot postpone completion of this epoch under continuous traffic.
   if a.epoch.is_none()&&(!a.tail.is_empty()||!a.complete){a.epoch=Some((a.tail.len(),a.cut.clone()));}
   if a.epoch.as_ref().is_some_and(|(remaining,_)|*remaining==0){
    let (_,cut)=a.epoch.take().unwrap();a.delivered_cut=cut.clone();a.complete=true;("complete",vec![],vec![],cut)
   }else if let Some((remaining,_))=&mut a.epoch{
    let mut out=vec![];let mut bytes=0;
    while *remaining>0 {let v=a.tail.front().ok_or("complete tail invariant")?;let size=serde_json::to_vec(v).expect("mutation serialization").len();if !out.is_empty()&&(out.len()>=CHUNK_ROWS||bytes+size>CHUNK_BYTES){break}bytes+=size;a.tail_bytes-=size;out.push(a.tail.pop_front().unwrap());*remaining-=1;}
    ("tail",vec![],out,a.delivered_cut.clone())
   }else{("idle",vec![],vec![],a.delivered_cut.clone())}
  };
  Ok(json!({"type":"complete","acquisition":a.id,"topic":a.topic,"sequence":a.sequence,"kind":kind,"rows":rows,"mutations":mutations,"cut":response_cut}))
 }
 pub fn cancel(&mut self,connection:u64,id:&str)->Result<Value,String>{if self.entries.get(&connection).is_some_and(|a|a.id!=id){return Err("obsolete complete cancellation".into())}self.entries.remove(&connection);Ok(json!({"type":"complete","acquisition":id,"kind":"cancelled"}))}
 pub fn disconnect(&mut self,connection:u64){self.entries.remove(&connection);}
}
#[cfg(test)] mod tests {
 use super::*;
 #[test] fn opens_real_engine_snapshot_with_all_schema_fields_and_releases_query(){
  use rust_differential_product_core::schema::Catalog;
  let mut manifest=json!({"format":1,"schemas":[{"format":2,"id":"rows","version":2,"key":"rowId","fields":[{"name":"id","kind":"string","optional":false,"nullable":false},{"name":"value","kind":"uint64","optional":false,"nullable":false},{"name":"note","kind":"string","optional":true,"nullable":true}]}],"topics":[{"topic":"same","schema":"rows"}]});
  let definition=serde_json::from_value(manifest["schemas"][0].clone()).unwrap();
  manifest["topics"][0]["schema"]=json!(rust_differential_product_core::schema::Schema::new(definition).unwrap().fingerprint());
  let catalog=Catalog::new(serde_json::from_value(manifest).unwrap()).unwrap();
  let fingerprint=catalog.topics().next().unwrap().1.fingerprint().to_owned();
  let mut runtime=Runtime::new(catalog,1000).unwrap();
  let a=rust_differential_product_core::schema::encode_row_id(&[rust_differential_product_core::schema::Scalar::String("a".into())]).unwrap();
  let b=rust_differential_product_core::schema::encode_row_id(&[rust_differential_product_core::schema::Scalar::String("b".into())]).unwrap();
  runtime.apply_committed("same",&fingerprint,&[Mutation::Upsert{row:json!({"rowId":a,"id":"a","value":"9007199254740993","note":null})},Mutation::Upsert{row:json!({"rowId":b,"id":"b","value":"0"})}]).unwrap();
  let mut complete=Complete::default();let id="0123456789abcdef0123456789abcdef";
  let snapshot=complete.open(1,id.into(),"same".into(),&fingerprint,&mut runtime,json!({"offset":2})).unwrap();
  assert_eq!(snapshot["kind"],"snapshot");assert_eq!(snapshot["rows"].as_array().unwrap().len(),2);
  assert_eq!(snapshot["rows"][0],json!({"rowId":a,"id":"a","value":"9007199254740993","note":null}));
  assert_eq!(snapshot["rows"][1],json!({"rowId":b,"id":"b","value":"0"}));
  assert_eq!(runtime.metrics()["shapes"],0);assert_eq!(complete.next(1,id,1).unwrap()["kind"],"complete");
  complete.committed("same",&[Mutation::Upsert{row:json!({"rowId":a,"id":"a","value":"2"})},Mutation::Upsert{row:json!({"rowId":b,"id":"b","value":"3"})}],&json!({"offset":4}));
  let tail=complete.next(1,id,2).unwrap();assert_eq!(tail["mutations"].as_array().unwrap().len(),2);assert_ne!(tail["mutations"][0]["row"]["rowId"],tail["mutations"][1]["row"]["rowId"]);
  let mut legacy=runtime.catalog().manifest().clone();legacy.schemas[0].format=1;legacy.schemas[0].version=1;legacy.schemas[0].key="id".into();
  legacy.topics[0].schema=rust_differential_product_core::schema::Schema::new(legacy.schemas[0].clone()).unwrap().fingerprint().into();
  let legacy_fingerprint=legacy.topics[0].schema.clone();let mut legacy_runtime=Runtime::new(Catalog::new(legacy).unwrap(),1000).unwrap();
  assert!(complete.open(2,id.into(),"same".into(),&legacy_fingerprint,&mut legacy_runtime,json!({})).unwrap_err().contains("authoritative rowId"));
 }
 #[test] fn immutable_snapshot_then_live_tail_credit_and_completion(){
  let mut c=Complete::default();c.entries.insert(1,Acquisition{id:"x".into(),topic:"same".into(),snapshot:VecDeque::from([vec![json!({"rowId":"a","value":1})]]),tail:VecDeque::new(),tail_bytes:0,cut:json!({"source_sequence":"1"}),snapshot_cut:json!({"source_sequence":"1"}),delivered_cut:json!({"source_sequence":"1"}),epoch:None,sequence:0,complete:false,failed:false});
  c.committed("same",&[Mutation::Upsert{row:json!({"rowId":"a","value":2})},Mutation::Delete{key:"b".into()}],&json!({"source_sequence":"2"}));
  assert_eq!(c.next(1,"x",0).unwrap()["rows"][0]["value"],1);assert!(c.next(1,"x",0).is_err());
  let tail=c.next(1,"x",1).unwrap();assert_eq!(tail["mutations"][1]["row"]["value"],2);assert_eq!(tail["mutations"][0]["key"],"b");
  c.committed("same",&[Mutation::Upsert{row:json!({"rowId":"c","value":3})}],&json!({"source_sequence":"3"}));
  let barrier=c.next(1,"x",2).unwrap();assert_eq!(barrier["kind"],"complete");assert_eq!(barrier["cut"]["source_sequence"],"2");
  assert_eq!(c.next(1,"x",3).unwrap()["kind"],"tail");
  c.committed("same",&[Mutation::Upsert{row:json!({"rowId":"d","value":4})}],&json!({"source_sequence":"4"}));
  let barrier=c.next(1,"x",4).unwrap();assert_eq!(barrier["kind"],"complete");assert_eq!(barrier["cut"]["source_sequence"],"3");
  assert_eq!(c.next(1,"x",5).unwrap()["kind"],"tail");assert_eq!(c.next(1,"x",6).unwrap()["kind"],"complete");assert_eq!(c.next(1,"x",7).unwrap()["kind"],"idle");c.disconnect(1);assert!(c.next(1,"x",8).is_err());
 }
}
