#![cfg(feature="fault-injection")]
#[path="support/durable.rs"] mod support;
use support::*;
use product_source_ingestion::{durable::*,durable_coordinator::*};
use rust_differential_product_core::product::*;
use std::{path::Path,process::Command,time::{Instant,Duration}};
fn wait(path:&Path){let t=Instant::now();while !path.exists(){assert!(t.elapsed()<Duration::from_secs(10),"missing {}",path.display());std::thread::sleep(Duration::from_millis(1));}}
#[test]
fn fence_child(){
 let Ok(dir)=std::env::var("V121_FENCE_CHILD") else{return};let dir=Path::new(&dir);
 let s=session(SqliteStore::open(dir.join("source.db"),identity()).unwrap(),"reader");s.lock().unwrap().acquire(partition(0)).unwrap();let mut c=coordinator(s);
 c.command(ProductCommand::Open{subscription:"q".into(),query:query()}).unwrap();
 let r=c.read_many(&[ReadRequest{subscription:"q".into(),acquisition:1}],ReadBounds::default());
 if std::env::var("V121_EXPECT").unwrap()=="snapshot"{let r=r.unwrap();assert_eq!(r.source_sequence,0);assert_eq!(r.results[0].total_rows,0);assert!(matches!(c.read_many(&[ReadRequest{subscription:"q".into(),acquisition:1}],ReadBounds::default()),Err(Error::Fenced)));}
 else{assert!(matches!(r,Err(Error::Fenced)));}
}
#[test]
fn transfer_before_admission_rejects_and_after_admission_allows_owned_snapshot(){
 for (point,expected) in [("group_before_admission","fenced"),("group_after_admission","snapshot")]{
  let dir=Directory::new();SqliteStore::create(dir.db(),identity()).unwrap();std::fs::write(dir.0.join(format!("{point}.arm")),"pause").unwrap();
  let mut child=Command::new(std::env::current_exe().unwrap()).args(["--exact","fence_child","--nocapture"]).env("V121_FENCE_CHILD",&dir.0).env("V121_FAULT_DIR",&dir.0).env("V121_EXPECT",expected).spawn().unwrap();
  wait(&dir.0.join(format!("{point}.reached")));
  // This commits while the read invocation is paused, proving neither SQLite
  // transaction nor Session mutex remains held at the external test barrier.
  SqliteStore::open(dir.db(),identity()).unwrap().acquire(0,"successor").unwrap();
  std::fs::write(dir.0.join(format!("{point}.release")),"release").unwrap();assert!(child.wait().unwrap().success());
 }
}
