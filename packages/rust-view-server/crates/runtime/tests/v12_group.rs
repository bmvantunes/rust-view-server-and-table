#[path = "support/durable.rs"] mod support;
use support::*;
use product_source_ingestion::{durable::*,durable_coordinator::*};
use rust_differential_product_core::product::*;
#[test]
fn grouped_equivalence_one_validation_and_atomic_limits() {
 let dir=Directory::new();let shared=session(SqliteStore::create(dir.db(),identity()).unwrap(),"owner");
 let (l,_)=shared.lock().unwrap().acquire(partition(0)).unwrap();let mut c=coordinator(shared.clone());
 c.apply(&delivery(&l,vec![put(0,0,"a","-10.01"),put(0,1,"b","-2.01")])).unwrap();
 for id in ["a","b"] {c.command(ProductCommand::Open{subscription:id.into(),query:query()}).unwrap();}
 let separate=[c.read("a").unwrap().unwrap().result,c.read("b").unwrap().unwrap().result];
 let requests=[ReadRequest{subscription:"a".into(),acquisition:1},ReadRequest{subscription:"b".into(),acquisition:2}];
 shared.lock().unwrap().reset_storage_work();
 let group=c.read_many(&requests,ReadBounds::default()).unwrap();assert_eq!(group.results,separate);
 let work=shared.lock().unwrap().storage_work();assert_eq!(work.global_records_validated,1);assert_eq!(work.partition_records_validated,1);
 assert_eq!(group.source_sequence,1);assert_eq!(group.requests[1].acquisition,2);
 assert!(c.read_many(&requests,ReadBounds{requests:2,rows:1,bytes:100000}).is_err());
 assert!(c.read_many(&requests,ReadBounds{requests:2,rows:1000,bytes:1}).is_err());
 let missing=[requests[0].clone(),ReadRequest{subscription:"missing".into(),acquisition:2}];
 assert!(c.read_many(&missing,ReadBounds::default()).is_err());assert!(!c.terminal());
 assert!(c.read_many(&[requests[0].clone(),requests[0].clone()],ReadBounds::default()).is_err());
 assert_eq!(c.read_many(&requests,ReadBounds::default()).unwrap().results,separate);
}
#[test]
fn non_target_fence_invalidates_group_owner_and_no_partial_publication() {
 let dir=Directory::new();let shared=session(SqliteStore::create(dir.db(),identity()).unwrap(),"owner");
 for p in 0..2 {shared.lock().unwrap().acquire(partition(p)).unwrap();}
 let mut c=coordinator(shared);c.command(ProductCommand::Open{subscription:"a".into(),query:query()}).unwrap();
 SqliteStore::open(dir.db(),identity()).unwrap().acquire(1,"successor").unwrap();
 assert!(matches!(c.read_many(&[ReadRequest{subscription:"a".into(),acquisition:1}],ReadBounds::default()),Err(Error::Fenced)));assert!(c.terminal());
}
