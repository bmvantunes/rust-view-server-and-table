use serde_json::{json,Value};
thread_local!{static BASES:std::cell::RefCell<std::collections::BTreeMap<String,Value>>=Default::default();}
/// Historical socket assertions continue to inspect the complete reconstructed result.
/// This independent test applicator does not call the production diff.
pub fn reconstruct(mut frame:Value)->Value{
 if frame["type"]!="result" {return frame;}
 let id=format!("{}/{}/{}/{}",frame["incarnation"],frame["connection"],frame["subscription"],frame["acquisition"]);
 BASES.with(|bases|{let mut bases=bases.borrow_mut();let r=&frame["result"];let mut next=r.clone();
 if r["kind"]=="delta" {
  let base=bases.get(&id).expect("delta requires baseline");assert_eq!(r["fromRevision"],base["revision"]);assert_eq!(r["fromVersion"],base["contentVersion"]);
  let mut keys=base["keys"].as_array().unwrap().clone();let mut rows=base["rows"].as_array().unwrap().clone();
  for o in r["operations"].as_array().unwrap(){let index=keys.iter().position(|k|k==&o["key"]);match o["type"].as_str().unwrap(){
   "remove"=>{let i=index.unwrap();keys.remove(i);rows.remove(i);},
   "insert"=>{assert!(index.is_none());let i=o["index"].as_u64().unwrap() as usize;keys.insert(i,o["key"].clone());rows.insert(i,o["row"].clone());},
   "update"=>{let i=o["index"].as_u64().unwrap() as usize;assert_eq!(index,Some(i));rows[i]=o["row"].clone();},
   "move"=>{let i=o["fromIndex"].as_u64().unwrap() as usize;let j=o["toIndex"].as_u64().unwrap() as usize;assert_eq!(index,Some(i));let k=keys.remove(i);let v=rows.remove(i);keys.insert(j,k);rows.insert(j,v);},_=>panic!("invalid operation")}}
  next["keys"]=json!(keys);next["rows"]=json!(rows);
 }else{assert_eq!(r["kind"],"snapshot");}
 bases.insert(id,next.clone());frame["result"]=next;});frame
}
