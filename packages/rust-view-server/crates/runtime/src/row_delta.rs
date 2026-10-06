//! Transport-only, bounded sequential window comparison; canonical rows remain full.
use serde_json::{json, Value};
#[derive(Clone, Debug)]
pub struct Baseline { pub acquisition:u64, pub projection:Vec<String>, pub revision:u64, pub result:Value }
pub fn project(result:&Value, fields:&[String])->Value {
 let mut next=result.clone();
 let rows=result["rows"].as_array().expect("admitted native result");
 next["keys"]=json!(rows.iter().map(|r|r["id"].clone()).collect::<Vec<_>>());
 next["rows"]=json!(rows.iter().map(|r|fields.iter().map(|f|(f.clone(),r[f].clone())).collect::<serde_json::Map<_,_>>()).collect::<Vec<_>>());next
}
/// Indices always address the current working order. Move destination is post-removal.
pub fn operations(prior:&Value,next:&Value)->Vec<Value> {
 let mut keys=prior["keys"].as_array().unwrap().clone();
 let mut rows=prior["rows"].as_array().unwrap().clone();
 let target=next["keys"].as_array().unwrap();let payload=next["rows"].as_array().unwrap();let mut ops=vec![];
 let wanted=target.iter().map(|k|k.as_str().unwrap()).collect::<std::collections::BTreeSet<_>>();
 for i in (0..keys.len()).rev(){if !wanted.contains(keys[i].as_str().unwrap()){ops.push(json!({"type":"remove","key":keys[i]}));keys.remove(i);rows.remove(i);}}
 for (i,key) in target.iter().enumerate(){
  match keys.iter().position(|k|k==key){
   None=>{ops.push(json!({"type":"insert","key":key,"row":payload[i],"index":i}));keys.insert(i,key.clone());rows.insert(i,payload[i].clone());},
   Some(j)=>{
    if j!=i {ops.push(json!({"type":"move","key":key,"fromIndex":j,"toIndex":i}));let k=keys.remove(j);let r=rows.remove(j);keys.insert(i,k);rows.insert(i,r);}
    if rows[i]!=payload[i]{ops.push(json!({"type":"update","key":key,"row":payload[i],"index":i}));rows[i]=payload[i].clone();}
   }
  }
 }
 ops
}
pub fn batch(prior:Option<&Baseline>,acquisition:u64,projection:&[String],result:Value,force:bool)->(Value,Baseline) { batch_with_patches(prior,acquisition,projection,result,force,false) }
pub fn batch_with_patches(prior:Option<&Baseline>,acquisition:u64,projection:&[String],mut result:Value,force:bool,patches:bool)->(Value,Baseline) {
 let revision=prior.filter(|p|p.acquisition==acquisition).map_or(1,|p|p.revision+1);
 let content_version=prior.filter(|p|p.acquisition==acquisition).map_or(1,|p|p.result["contentVersion"].as_u64().unwrap()+u64::from(p.result["keys"]!=result["keys"]||p.result["rows"]!=result["rows"]||p.result["total_rows"]!=result["total_rows"]));
 result["contentVersion"]=json!(content_version);
 result["windowId"]=json!(prior.filter(|p|!force&&p.acquisition==acquisition&&p.projection==projection&&p.result["query_generation"]==result["query_generation"]&&p.result["start_rank"]==result["start_rank"]&&["topic","schema","result_kind","result_shape"].iter().all(|k|p.result[*k]==result[*k])).map_or(revision,|p|p.result["windowId"].as_u64().unwrap()));
 result["effectiveEnd"]=json!(result["start_rank"].as_u64().unwrap()+result["rows"].as_array().unwrap().len() as u64);
 let mut frame=result.clone();frame.as_object_mut().unwrap().remove("rows");frame.as_object_mut().unwrap().remove("keys");
 frame["revision"]=json!(revision);frame["projection"]=json!(projection);
 let compatible=prior.filter(|p|!force&&p.acquisition==acquisition&&p.projection==projection&&p.result["query_generation"]==result["query_generation"]&&p.result["start_rank"]==result["start_rank"]&&["topic","schema","result_kind","result_shape"].iter().all(|k|p.result[*k]==result[*k]));
 let ops=compatible.map(|p|{let mut ops=operations(&p.result,&result);if patches{select_patches(&p.result,projection,&mut ops);}ops});
 let payloads=ops.as_ref().map_or(0,|o|o.iter().filter(|v|v.get("row").is_some()||v.get("changes").is_some()).count());
 if let (Some(p),Some(ops))=(compatible,ops.filter(|o|o.len()<=4096&& (payloads<=8||payloads*2<result["rows"].as_array().unwrap().len().max(1)))) {
  frame["kind"]=json!("delta");frame["fromRevision"]=json!(p.revision);frame["fromVersion"]=p.result["contentVersion"].clone();frame["toVersion"]=result["contentVersion"].clone();frame["operations"]=json!(ops);
 }else{frame["kind"]=json!("snapshot");frame["rows"]=result["rows"].clone();frame["keys"]=result["keys"].clone();}
 (frame,Baseline{acquisition,projection:projection.to_vec(),revision,result})
}

/// A bounded projection trie is implicit in the admitted <=64 selected paths.
fn leaf_changes(old:Option<&Value>,new:Option<&Value>,prefix:&str,projection:&[String],out:&mut Vec<Value>)->bool {
 let fields=projection.iter().filter_map(|p|p.strip_prefix(prefix)).map(|p|p.split('.').next().unwrap()).collect::<std::collections::BTreeSet<_>>();
 for field in fields {
  let path=format!("{prefix}{field}");let a=old.and_then(|v|v.get(field));let b=new.and_then(|v|v.get(field));
  if a==b {continue}
  if projection.contains(&path) {out.push(match b {Some(v)=>json!({"type":"set","path":path,"value":v}),None=>json!({"type":"remove","path":path})});}
  else if a.is_some_and(Value::is_null)||b.is_some_and(Value::is_null){return false;}
  else if b.is_none(){out.push(json!({"type":"remove","path":path}));}
  else {if a.is_none(){out.push(json!({"type":"object","path":path}));}if !leaf_changes(a,b,&format!("{path}."),projection,out){return false;}}
 }
 true
}
fn select_patches(prior:&Value,projection:&[String],ops:&mut [Value]) {
 let keys=prior["keys"].as_array().unwrap();let rows=prior["rows"].as_array().unwrap();
 for op in ops {
  if op["type"]!="update" {continue}
  let Some(i)=keys.iter().position(|k|*k==op["key"]) else {continue};
  let mut changes=Vec::new();if !leaf_changes(Some(&rows[i]),Some(&op["row"]),"",projection,&mut changes){continue;}
  if changes.is_empty()||changes.len()>512 {continue}
  let patch=json!({"type":"patch","key":op["key"],"index":op["index"],"changes":changes});
  if let (Ok(full),Ok(small))=(v13_codec_experiment::generic::encode(op),v13_codec_experiment::generic::encode(&patch)) {
   if small.len()+16<=full.len()&&small.len()*10<=full.len()*9 {*op=patch;}
  }
 }
}
