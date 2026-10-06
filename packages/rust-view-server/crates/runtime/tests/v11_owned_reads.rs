#[path = "support/durable.rs"] mod support;
use support::*;
use product_source_ingestion::durable::*;
use rust_differential_product_core::product::*;
use sha2::{Digest,Sha256};

#[test]
fn stored_partitions_and_guarded_leases_are_independent_work_dimensions() {
 for p in [1usize,16,256] {
  let dir=Directory::new();let mut s=SqliteStore::create(dir.db(),identity()).unwrap();
  let tokens=(0..p).map(|i|s.acquire(i as u32,"owner").unwrap().0).collect::<Vec<_>>();let mut seq=0;
  for part in 0..p {
   let records=(part..1024).step_by(p).enumerate().map(|(o,i)|put(part as u32,o as u64,&format!("row-{i:06}"),&format!("{i}.0001"))).collect::<Vec<_>>();let start=records.len() as u64;
   s.commit(&tokens[part],seq,&records).unwrap();seq+=1;
   s.commit(&tokens[part],seq,&(start..start+256).map(|o|put(part as u32,o,&format!("row-{part:06}"),&format!("{part}.0001"))).collect::<Vec<_>>()).unwrap();seq+=1;
  }
  let mut off=s.load().unwrap().snapshot.offsets[&0]+1;
  for _ in 0..256 {s.commit(&tokens[0],seq,&[put(0,off,"row-000000","0.0001")]).unwrap();seq+=1;off+=1;}
  for l in [1,p/2,p].into_iter().filter(|l|*l>0) {
   s.reset_work();s.guard(&tokens[..l],seq,||Ok(())).unwrap();let w=s.work();
   assert_eq!(w.guarded_leases,l as u64);assert_eq!(w.partition_records_validated,l as u64);assert_eq!(w.global_records_validated,1);
   assert_eq!(w.partition_history_entries_decoded,256*l as u64);assert_eq!(w.global_history_entries_decoded,256);
   assert_eq!(w.partition_objects_read,l as u64);assert_eq!(w.sql_operations,l as u64+3);assert_eq!(w.full_scans+w.reconstructions+w.rows_fetched,0);
   println!("V11_GUARD P={p} L={l} H=256 {}",serde_json::to_string(&w).unwrap());
  }
  s.reset_work();s.commit(&tokens[0],seq,&[put(0,off,"row-000000","-1"),put(0,off+1,&format!("row-{:06}",p),"-2")]).unwrap();let w=s.work();
  assert_eq!(w.row_lookups,2);assert_eq!(w.partition_objects_read,1);assert_eq!(w.receipt_coordinates_copied,3*p as u64);assert_eq!(w.full_scans+w.reconstructions,0);
  assert_eq!(s.load().unwrap().snapshot.rows.len(),1024);
 }
}

#[test]
#[ignore="Explicitly invoked child transfers the non-target partition on an independent process"]
fn v11_transfer_child() {
 let path=std::env::var("V11_TRANSFER_DB").unwrap();let mut s=SqliteStore::open(path,identity()).unwrap();s.acquire(1,"successor-process").unwrap();
}
#[test]
fn non_target_transfer_before_topic_read_fences_complete_promise() {
 let dir=Directory::new();let shared=session(SqliteStore::create(dir.db(),identity()).unwrap(),"old");
 let leases=(0..2).map(|p|shared.lock().unwrap().acquire(partition(p)).unwrap().0).collect::<Vec<_>>();let mut c=coordinator(shared.clone());
 for p in 0..2 {c.apply(&delivery(&leases[p],vec![put(p as u32,0,&format!("a-{p}"),&format!("{p}.0001"))])).unwrap();}
 c.command(ProductCommand::Open{subscription:"all".into(),query:query()}).unwrap();assert_eq!(c.read("all").unwrap().unwrap().result.rows.len(),2);
 // The successful child exit is the barrier immediately before admission. No source commit occurs.
 let status=std::process::Command::new(std::env::current_exe().unwrap()).args(["--ignored","--exact","v11_transfer_child"]).env("V11_TRANSFER_DB",dir.db()).status().unwrap();assert!(status.success());
 assert_eq!(c.read("all").unwrap_err(),Error::Fenced);assert_eq!(c.checkpoint().unwrap_err(),Error::Fenced);
 assert_eq!(c.commit_offset(&leases[0],Ok).unwrap(),1); // unrelated valid authority survives
 assert_eq!(c.commit_offset(&leases[1],Ok).unwrap_err(),Error::Fenced);
}
#[test]
fn newer_source_cut_and_empty_authorities_fail_closed() {
 let dir=Directory::new();let mut s=SqliteStore::create(dir.db(),identity()).unwrap();let(t0,_)=s.acquire(0,"old").unwrap();let(t1,_)=s.acquire(1,"old").unwrap();
 s.commit(&t0,0,&[put(0,0,"a","1")]).unwrap();let mut other=SqliteStore::open(dir.db(),identity()).unwrap();other.commit(&t1,1,&[put(1,0,"b","2")]).unwrap();
 assert_eq!(s.guard(&[t0.clone()],1,||Ok(())).unwrap_err(),Error::StaleSnapshot);
 s.guard(&[t0],2,||Ok(())).unwrap();assert_eq!(s.guard(&[],2,||Ok(())).unwrap_err(),Error::Fenced);
}
#[test]
fn owned_payload_corruption_is_detected_on_every_guard_without_reopen() {
 for kind in ["digest","binding","offset-history","global-digest","history-order"] {
  let dir=Directory::new();let mut s=SqliteStore::create(dir.db(),identity()).unwrap();let(t0,_)=s.acquire(0,"owner").unwrap();let(t1,_)=s.acquire(1,"owner").unwrap();
  s.commit(&t0,0,&[put(0,0,"a","1")]).unwrap();s.commit(&t1,1,&[put(1,0,"b","2"),put(1,1,"c","3")]).unwrap();
  s.guard(&[t0.clone(),t1.clone()],2,||Ok(())).unwrap();let conn=rusqlite::Connection::open(dir.db()).unwrap();
  if kind=="global-digest" {conn.execute("UPDATE canonical SET digest=x'00'",[]).unwrap();}
  else if kind=="digest" {conn.execute("UPDATE partitions SET digest=x'00' WHERE partition=1",[]).unwrap();}
  else {
   let payload:Vec<u8>=conn.query_row("SELECT payload FROM partitions WHERE partition=1",[],|r|r.get(0)).unwrap();let mut v:serde_json::Value=serde_json::from_slice(&payload).unwrap();
   match kind {"binding"=>v["partition"]=0.into(),"offset-history"=>v["offset"]=99.into(),_=>v["recent"][0][0]=1.into()};
   let b=serde_json::to_vec(&v).unwrap();conn.execute("UPDATE partitions SET payload=?1,digest=?2 WHERE partition=1",rusqlite::params![&b,Sha256::digest(&b).as_slice()]).unwrap();
  }
  assert!(s.guard::<()>(&[t0,t1],2,||panic!("corrupt read admitted")).is_err(),"{kind}");assert!(s.load().is_err());
 }
}
#[test]
fn failure_between_partition_and_global_statements_rolls_back_complete_state() {
 let dir=Directory::new();let mut s=SqliteStore::create(dir.db(),identity()).unwrap();let(t,_)=s.acquire(0,"owner").unwrap();s.commit(&t,0,&[put(0,0,"a","1")]).unwrap();let before=serde_json::to_value(s.load().unwrap()).unwrap();
 let conn=rusqlite::Connection::open(dir.db()).unwrap();conn.execute_batch("CREATE TRIGGER fail_global BEFORE UPDATE ON canonical BEGIN SELECT RAISE(ABORT,'v11-between-related-statements'); END;").unwrap();
 assert!(s.commit(&t,1,&[delete(0,1,"a"),put(0,2,"new-sticky","3")]).unwrap_err().to_string().contains("v11-between-related-statements"));
 assert_eq!(serde_json::to_value(s.load().unwrap()).unwrap(),before);
 let sticky:i64=conn.query_row("SELECT count(*) FROM sticky WHERE id='new-sticky'",[],|r|r.get(0)).unwrap();assert_eq!(sticky,0);
}
#[test]
fn uncertain_commit_reacquires_and_rebuilds_exact_durable_truth() {
 let dir=Directory::new();let mut s=SqliteStore::create(dir.db(),identity()).unwrap();let(t,_)=s.acquire(0,"old").unwrap();
 assert!(s.commit_with_hook(&t,0,&[put(0,0,"a","9007199254740993.0001")],|point|if point==Point::AfterCommit {Err(Error::Storage("lost ack".into()))}else{Ok(())}).is_err());
 assert_eq!(s.commit(&t,1,&[put(0,1,"a","2")]).unwrap_err(),Error::StaleSnapshot);drop(s);
 let shared=session(SqliteStore::open(dir.db(),identity()).unwrap(),"successor");let(l,_)=shared.lock().unwrap().acquire(partition(0)).unwrap();let mut c=coordinator(shared);
 c.command(ProductCommand::Open{subscription:"all".into(),query:query()}).unwrap();let result=c.read("all").unwrap().unwrap();assert_eq!(result.result.rows[0].amount,ExactDecimal::parse("9007199254740993.0001").unwrap());assert_eq!(c.commit_offset(&l,Ok).unwrap(),1);
}
