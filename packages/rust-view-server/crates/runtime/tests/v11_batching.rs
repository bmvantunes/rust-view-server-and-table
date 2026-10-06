#[path="support/durable.rs"] mod support;
use support::*;
use product_source_ingestion::{coordination::*,durable::{SqliteStore,DurableStore}};
use rust_differential_product_core::{source::ProductMutation,product::OptionalString};
fn queued(a:&Authority,cap:usize)->BoundedQueue {let _=a;let mut q=BoundedQueue::new(Limits{batches:8,bytes:4*1024*1024,events:2048}).unwrap();q.set_batch_limits(BatchLimits{records:cap,bytes:2*1024*1024,latency_ms:10}).unwrap();q}
#[test]
fn growing_batches_size_each_record_once_and_match_actual_bytes() {
 for cap in [1,32,256,1024] {
  let a=Authority::default();let l=a.assign(partition(0)).unwrap();let mut q=queued(&a,cap);let mut records=Vec::new();
  for i in 0..cap {let mut r=put(0,i as u64,&format!("a-{i}"),"1");if let ProductMutation::Upsert{row}=&mut r.event.mutation {row.label=OptionalString::Value("quote\" slash\\ nul\0 日本語".repeat(i%7));}records.push(r.clone());q.push_record(delivery(&l,vec![r]),0).unwrap();assert_eq!(q.metrics().queued_bytes,delivery(&l,records.clone()).bytes().unwrap());}
  assert_eq!(q.ready(0).unwrap().records.len(),cap);assert_eq!(q.metrics().queue_records_serialized,cap as u64+1); // first record sized by both push_record and legacy push
  q.record_completed();q.pop();assert_eq!(q.metrics().queue_records_serialized,2*cap as u64+1);assert_eq!(q.metrics().queued_bytes+q.metrics().building_bytes,0);assert_eq!(q.metrics().completed_records,cap as u64);assert_eq!(q.metrics().completed_batches,1);
 }
}
fn byte_batch(l:&Lease,size:usize)->Delivery {
 let mut records=(0..600).map(|i|{let mut r=put(0,i,&format!("a-{i}"),"1");if let ProductMutation::Upsert{row}=&mut r.event.mutation{row.label=OptionalString::Value(String::new());}r}).collect::<Vec<_>>();
 let base=delivery(l,records.clone()).bytes().unwrap();let extra=size-base;
 for (i,r) in records.iter_mut().enumerate(){if let ProductMutation::Upsert{row}=&mut r.event.mutation{let len=extra/600+usize::from(i<extra%600);assert!(len<4096);row.label=OptionalString::Value("x".repeat(len));}}
 let d=delivery(l,records);assert_eq!(d.bytes().unwrap(),size);d
}
#[test]
fn actual_two_mib_boundary_and_plus_one_preserve_atomicity() {
 let dir=Directory::new();let mut store=SqliteStore::create(dir.db(),identity()).unwrap();let(t,_)=store.acquire(0,"owner").unwrap();let a=Authority::default();let l=a.assign(partition(0)).unwrap();
 for extra in [0,1] {let mut q=queued(&a,1024);let d=byte_batch(&l,2*1024*1024+extra);
  for r in &d.records{q.push_record(delivery(&l,vec![r.clone()]),0).unwrap();}
  assert!(q.metrics().queued_bytes<=4*1024*1024);assert_eq!(q.ready(0).unwrap().records.len(),if extra==0{600}else{599});
  if extra==1 {assert!(store.commit(&t,0,&d.records).unwrap_err().to_string().contains("byte quota"));assert!(store.load().unwrap().snapshot.rows.is_empty());}
 }
 let d=byte_batch(&l,2*1024*1024);store.commit(&t,0,&d.records).unwrap();assert_eq!(store.load().unwrap().snapshot.rows.len(),600);
}
#[test]
fn slow_hot_partition_partial_revoke_successor_spill_and_deadline_are_bounded() {
 let dir=Directory::new();let a=Authority::default();let shared=std::sync::Arc::new(std::sync::Mutex::new(product_source_ingestion::durable_coordinator::Session::new(SqliteStore::create(dir.db(),identity()).unwrap(),"owner".into(),a.clone())));
 let leases=(0..3).map(|p|shared.lock().unwrap().acquire(partition(p)).unwrap().0).collect::<Vec<_>>();let mut c=coordinator(shared.clone());
 let mut q=BoundedQueue::new(Limits{batches:3,bytes:1024*1024,events:258}).unwrap();q.set_batch_limits(BatchLimits{records:256,bytes:2*1024*1024,latency_ms:10}).unwrap();
 for i in 0..256 {q.push_record(delivery(&leases[0],vec![put(0,i,"hot","1")]),0).unwrap();}
 q.push_record(delivery(&leases[1],vec![put(1,0,"slow","2")]),1).unwrap();q.push_record(delivery(&leases[2],vec![put(2,0,"other","3")]),2).unwrap();
 let spill=delivery(&leases[0],vec![put(0,256,"hot","4")]);assert!(q.push_record(spill.clone(),3).is_err());let buffered=q.metrics().queued_bytes+spill.bytes().unwrap();assert!(buffered<=1024*1024+2*1024*1024);
 // Deterministic simulated IO stall: advancing the caller clock changes readiness, never acknowledgments.
 assert_eq!(q.metrics().completed_records,0);q.flush_due(1000);assert_eq!(q.metrics().completed_records,0);
 shared.lock().unwrap().release(&partition(1)).unwrap();q.discard_stale(&a);assert_eq!(q.metrics().queued_events,257);
 while q.ready(1000).is_some(){let d=q.front().unwrap().clone();c.apply(&d).unwrap();q.record_completed();q.pop();}
 assert_eq!(c.commit_offset(&leases[0],Ok).unwrap(),256);assert_eq!(c.commit_offset(&leases[2],Ok).unwrap(),1);
 let(new,_)=shared.lock().unwrap().acquire(partition(1)).unwrap();q.push_record(delivery(&new,vec![put(1,0,"slow","2")]),1001).unwrap();assert!(q.ready(1010).is_none());assert!(q.ready(1011).is_some());
 let d=q.front().unwrap().clone();c.apply(&d).unwrap();q.record_completed();q.pop();assert_eq!(c.commit_offset(&new,Ok).unwrap(),1);
 q.push_record(spill,1012).unwrap();a.shutdown();q.discard_stale(&a);assert_eq!(q.metrics().queued_bytes,0);assert_eq!(q.metrics().completed_records,258); // discarded spill never completed
}

#[test]
fn mixed_legacy_admission_updates_the_private_building_tail_size() {
 let a=Authority::default();let l=a.assign(partition(0)).unwrap();let mut q=queued(&a,32);
 q.push_record(delivery(&l,vec![put(0,0,"a","1")]),0).unwrap();
 let mut large=put(0,1,"b","2");if let ProductMutation::Upsert{row}=&mut large.event.mutation {row.label=OptionalString::Value("z".repeat(4096));}
 let first=q.metrics().queued_bytes;let second=delivery(&l,vec![large]);let second_bytes=second.bytes().unwrap();q.push(second).unwrap();
 let third=delivery(&l,vec![put(0,2,"c","3")]);let third_bytes=third.bytes().unwrap();q.push_record(third,1).unwrap();
 assert_eq!(q.metrics().queued_bytes,first+second_bytes+third_bytes-1);assert_eq!(q.metrics().building_bytes,second_bytes+third_bytes-1);
 q.pop();assert_eq!(q.metrics().queued_bytes,q.front().unwrap().bytes().unwrap());q.flush_due(10);q.pop();assert_eq!(q.metrics().queued_bytes,0);
}
