//! Test binary only. Never called under the SQLite guard or a session lock.
//! The ordinary service does not compile this module. No socket controls these gates.
use std::{path::PathBuf,time::{Duration,Instant}};
pub fn point(name:&str)->bool {
 let Some(directory)=std::env::var_os("V121_FAULT_DIR") else{return true};
 let dir=PathBuf::from(directory);let arm=dir.join(format!("{name}.arm"));
 let Ok(action)=std::fs::read_to_string(&arm) else{return true};
 std::fs::remove_file(&arm).expect("consume test barrier");
 std::fs::write(dir.join(format!("{name}.reached")),name).expect("test barrier marker");
 if action.trim()=="fail"{return false;}
 if action.trim()=="crash"{std::process::exit(86);}
 let started=Instant::now();
 while !dir.join(format!("{name}.release")).exists(){
  if dir.join("shutdown").exists(){return false;}
  assert!(started.elapsed()<Duration::from_secs(15),"test barrier timeout: {name}");
  std::thread::sleep(Duration::from_millis(1));
 }
 true
}
