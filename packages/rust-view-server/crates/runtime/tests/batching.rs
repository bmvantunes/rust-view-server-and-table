#[path = "support/durable.rs"]
mod support;
use support::*;
use product_source_ingestion::coordination::*;

fn queue(records: usize, bytes: usize, events: usize) -> (BoundedQueue, Authority, Lease) {
    let authority = Authority::default();
    let lease = authority.assign(partition(0)).unwrap();
    let mut q = BoundedQueue::new(Limits { batches: 4, bytes: 65536, events }).unwrap();
    q.set_batch_limits(BatchLimits { records, bytes, latency_ms: 10 }).unwrap();
    (q, authority, lease)
}
#[test]
fn exact_record_byte_and_timer_boundaries_without_sleep() {
    let (mut q, _, l) = queue(2, 65536, 100);
    q.push_record(delivery(&l, vec![put(0,0,"a","1")]), 100).unwrap();
    assert!(q.ready(109).is_none());
    assert_eq!(q.ready(110).unwrap().records.len(),1);
    q.pop();
    q.push_record(delivery(&l, vec![put(0,1,"a","1")]), 200).unwrap();
    q.push_record(delivery(&l, vec![put(0,2,"a","2")]), 201).unwrap();
    assert_eq!(q.ready(201).unwrap().records.len(),2);
    q.push_record(delivery(&l, vec![put(0,3,"a","3")]), 202).unwrap();
    assert_eq!(q.metrics().queued_events,3);
    q.pop();
    assert!(q.ready(202).is_none());
    assert!(q.ready(212).is_some());

    let a=delivery(&l,vec![put(0,0,"a","1")]);
    let b=delivery(&l,vec![put(0,1,"a","1")]);
    let exact=a.bytes().unwrap()+b.bytes().unwrap()-1;
    for cap in [exact,exact-1] {
        let (mut q,_,l)=queue(10,cap,100);
        q.push_record(delivery(&l,a.records.clone()),0).unwrap();
        q.push_record(delivery(&l,b.records.clone()),1).unwrap();
        assert_eq!(q.ready(1).unwrap().records.len(),if cap==exact {2} else {1});
        assert!(q.metrics().queued_bytes<=65536);
    }
    let (mut q,_,l)=queue(10,a.bytes().unwrap()-1,100);
    assert!(q.push_record(delivery(&l,a.records),0).is_err());
    assert_eq!(q.metrics().queued_events,0);
}
#[test]
fn partially_built_revoke_reassign_queue_pressure_and_shutdown_discard() {
    let (mut q, authority, old)=queue(10,65536,2);
    q.push_record(delivery(&old,vec![put(0,0,"a","1")]),0).unwrap();
    authority.revoke(&partition(0));
    let new=authority.assign(partition(0)).unwrap();
    q.discard_stale(&authority);
    assert_eq!(q.metrics().queued_bytes,0);
    assert_eq!(q.metrics().building_bytes,0);
    q.push_record(delivery(&new,vec![put(0,0,"a","1")]),1).unwrap();
    q.push_record(delivery(&new,vec![put(0,1,"a","2")]),2).unwrap();
    assert!(q.full());
    assert_eq!(q.ready(2).unwrap().records.len(),2); // pressure flush before timer
    assert!(q.push_record(delivery(&new,vec![put(0,2,"a","3")]),3).is_err());
    assert_eq!(q.metrics().queued_events,2);
    authority.shutdown();
    q.discard_stale(&authority);
    assert_eq!(q.metrics().queued_events,0);
}
#[test]
fn lease_switch_seals_without_combining_partitions_and_cap_one_is_immediate() {
    let (mut q,a,l)=queue(10,65536,100);
    let p1=a.assign(partition(1)).unwrap();
    q.push_record(delivery(&l,vec![put(0,0,"a","1")]),0).unwrap();
    q.push_record(delivery(&p1,vec![put(1,0,"b","1")]),1).unwrap();
    assert_eq!(q.ready(1).unwrap().lease,l);
    q.pop();
    assert!(q.ready(1).is_none());
    assert_eq!(q.ready(11).unwrap().lease,p1);
    let (mut q,_,l)=queue(1,65536,100);
    q.push_record(delivery(&l,vec![put(0,0,"a","1")]),0).unwrap();
    assert!(q.ready(0).is_some());
    assert!(BatchLimits { records: 1025, bytes: 1, latency_ms: 1 }.validate().is_err());
    assert!(BatchLimits { records: 1, bytes: usize::MAX, latency_ms: 1 }.validate().is_err());
}

#[test]
fn many_partition_switches_single_revoke_successor_and_shutdown_replay() {
    use product_source_ingestion::durable::{SqliteStore,DurableStore};
    let dir=Directory::new();
    let shared=session(SqliteStore::create(dir.db(),identity()).unwrap(),"many");
    let leases=(0..16).map(|p|shared.lock().unwrap().acquire(partition(p)).unwrap().0).collect::<Vec<_>>();
    let mut c=coordinator(shared.clone());
    // Queue authority is the same lease source used by the production session.
    // Recreate a deterministic queue authority with exactly the session's assignment order.
    let a=Authority::default();for p in 0..16 {assert_eq!(a.assign(partition(p)).unwrap(),leases[p as usize]);}
    let mut q=BoundedQueue::new(Limits{batches:32,bytes:1024*1024,events:64}).unwrap();
    q.set_batch_limits(BatchLimits{records:4,bytes:65536,latency_ms:10}).unwrap();
    // A hot partition fills a bounded batch; rapid switches seal distinct lease tails.
    for i in 0..4 {q.push_record(delivery(&leases[0],vec![put(0,i,"hot","1")]),i).unwrap();}
    for p in 1..16 {q.push_record(delivery(&leases[p],vec![put(p as u32,0,&format!("row-{p}"),"1")]),p as u64+4).unwrap();}
    shared.lock().unwrap().release(&partition(7)).unwrap();a.revoke(&partition(7));q.discard_stale(&a);
    assert!(a.valid(&leases[0]));assert!(a.valid(&leases[15]));
    let successor=shared.lock().unwrap().acquire(partition(7)).unwrap().0;
    assert_eq!(a.assign(partition(7)).unwrap(),successor);assert_ne!(successor.epoch,leases[7].epoch);
    assert!(c.apply(&delivery(&leases[7],vec![put(7,0,"row-7","1")])).is_err());
    q.push_record(delivery(&successor,vec![put(7,0,"row-7","1")]),20).unwrap();
    while q.ready(100).is_some(){let d=q.pop().unwrap();assert!(d.records.iter().all(|r|r.event.partition==d.lease.partition.partition));c.apply(&d).unwrap();c.commit_offset(&d.lease,|next|{assert_eq!(next,if d.lease.partition.partition==0{4}else{1});Ok(())}).unwrap();}
    assert_eq!(c.checkpoint().unwrap().snapshot.rows.len(),16);
    // Shutdown discards several buffered partitions; none of these offsets are authorized.
    for p in 1..5 {q.push_record(delivery(&leases[p],vec![put(p as u32,1,&format!("row-{p}"),"2")]),200+p as u64).unwrap();}
    assert_eq!(q.metrics().queued_events,4);a.shutdown();q.discard_stale(&a);assert_eq!(q.metrics().queued_events,0);assert_eq!(q.metrics().queued_bytes,0);
    for p in 1..5 {c.commit_offset(&leases[p],|next|{assert_eq!(next,1);Ok(())}).unwrap();}
    drop(c);drop(shared);
    let mut s=SqliteStore::open(dir.db(),identity()).unwrap();assert_eq!(s.load().unwrap().snapshot.offsets[&7],0);
    let shared=session(s,"restart");let again=(0..16).map(|p|shared.lock().unwrap().acquire(partition(p)).unwrap().0).collect::<Vec<_>>();let mut c=coordinator(shared);
    for p in 1..5 {c.apply(&delivery(&again[p],vec![put(p as u32,1,&format!("row-{p}"),"2")])).unwrap();c.commit_offset(&again[p],|next|{assert_eq!(next,2);Ok(())}).unwrap();}
    assert_eq!(c.checkpoint().unwrap().snapshot.rows.len(),16);
}
