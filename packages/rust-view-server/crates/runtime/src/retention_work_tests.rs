//! Exact diagnostic counts; no elapsed-time or asymptotic latency assertions.
use super::*;
use rust_differential_product_core::schema::{Definition,Field,Kind};
use serde_json::json;
fn schema()->Schema{Schema::new(Definition{expansion:None,format:1,id:"probe".into(),version:1,key:"id".into(),fields:vec![Field{name:"id".into(),kind:Kind::String,optional:false,nullable:false},Field{name:"quantity".into(),kind:Kind::Uint64,optional:false,nullable:false}]}).unwrap()}
fn fixture(n:usize,active:usize,enabled:bool)->Image{
 let mut image=Image::empty(2,enabled.then_some(NormalizedRetention{max_age_ms:Some(1000),max_messages:None,count_scope:None}));let s=schema();
 for i in 0..n{let key=format!("k{i:06}");let live=i<active;image.fold((i%2)as u32,State::Row{key:key.clone(),owner:(i%2)as u32,key_identity:[(i%251)as u8;32],row:live.then(||json!({"id":key,"quantity":"1"})),age_origin_ms:(live&&enabled).then_some(100),retention_order:(live&&enabled).then_some(i as u64+1)},&s,2).unwrap();}
 image.next_order=if enabled{n as u64}else{0};let m=manifest_state(image.format,0,image.next.clone(),image.root,0,0,image.next_order,0);image.fold(0,m,&s,2).unwrap();image
}
fn reset(){AUDIT_WORK.with(|v|v.set(WorkCounts::default()));}
fn counts()->WorkCounts{AUDIT_WORK.with(|v|v.get())}
fn commit(image:&mut Image,keys:&[String],delete:bool){
 let mut writes=Vec::new();let mut root=image.root;let mut order=image.next_order;
 for key in keys{let old=&image.rows[key];xor(&mut root,image.row_hash(key,old));order+=1;let new=RowImage{owner:old.owner,key_identity:old.key_identity,row:(!delete).then(||json!({"id":key,"quantity":"2"})),age_origin_ms:(!delete&&image.format==3).then_some(200),retention_order:(!delete&&image.format==3).then_some(order)};xor(&mut root,image.row_hash(key,&new));writes.push((new.owner,State::Row{key:key.clone(),owner:new.owner,key_identity:new.key_identity,row:new.row,age_origin_ms:new.age_origin_ms,retention_order:new.retention_order}));}
 let sequence=image.sequence+u64::from(!delete);let maintenance=image.maintenance_sequence+u64::from(delete);let content=sequence+maintenance;
 writes.push((0,manifest_state(image.format,sequence,image.next.clone(),root,content,maintenance,order,1100)));
 image.apply_committed(writes,&schema(),2).unwrap();
}
#[test]
fn live_commit_work_tracks_changed_rows_not_sticky_image(){
 let mut failures=Vec::new();
 for enabled in [false,true]{for n in [16,256,1024,4096]{for active in [4,n]{
  let mut image=fixture(n,active,enabled);reset();image.audit().unwrap();let restore=counts();
  assert_eq!(restore.full_rows,n);reset();commit(&mut image,&["k000000".into()],false);let live=counts();
  println!("WORK_COUNT {}",json!({"mode":if enabled{"on"}else{"off"},"sticky":n,"active":active,"kind":"one_row_update","restore_full_rows":restore.full_rows,"live_full_rows":live.full_rows,"live_hashes":live.row_hashes,"live_fold_rows":live.fold_rows}));
  if live.full_rows!=0||live.row_hashes>4||live.fold_rows!=1{failures.push((enabled,n,active,live));}
 }}}
 for n in [256,1024,4096]{let mut image=fixture(n,256,true);reset();image.audit().unwrap();let restore=counts();reset();let keys=image.due_keys(1100,256).into_iter().map(|(_,_,key)|key).collect::<Vec<_>>();commit(&mut image,&keys,true);let live=counts();println!("WORK_COUNT {}",json!({"mode":"on","sticky":n,"active":256,"kind":"expiry_chunk_256","restore_full_rows":restore.full_rows,"live_full_rows":live.full_rows,"live_hashes":live.row_hashes,"live_fold_rows":live.fold_rows}));if live.full_rows!=0||live.row_hashes>1024||live.fold_rows!=256{failures.push((true,n,256,live));}}
 assert!(failures.is_empty(),"unchanged canonical identities visited by live commit: {failures:?}");
}
#[test]
fn affected_index_corruption_and_manifest_mismatch_fail_closed(){
 let mut image=fixture(16,4,true);image.audit().unwrap();image.expiry.remove(&(1100,1,"k000000".into()));
 let old=image.rows["k000000"].clone();let replacement=State::Row{key:"k000000".into(),owner:0,key_identity:old.key_identity,row:old.row,age_origin_ms:Some(200),retention_order:Some(17)};
 assert!(image.fold(0,replacement,&schema(),2).unwrap_err().contains("missing from expiry index"));
 let mut image=fixture(16,4,true);let mut wrong=image.root;wrong[0]^=1;
 assert!(image.apply_committed(vec![(0,manifest_state(3,1,image.next.clone(),wrong,1,0,16,100))],&schema(),2).is_err());
 let mut image=fixture(16,4,true);
 assert!(image.apply_committed(vec![(0,manifest_state(3,1,image.next.clone(),image.root,2,0,16,100))],&schema(),2).is_err());
 let mut image=fixture(16,4,true);image.rows.get_mut("k000015").unwrap().key_identity=[9;32];assert!(image.audit().is_err());
}
