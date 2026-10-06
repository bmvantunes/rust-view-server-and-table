#[path="support/durable.rs"] mod support;
use support::*;
use product_source_ingestion::{durable::*,durable_coordinator::*,subscriptions::*};
use rust_differential_product_core::product::*;
fn request(id:u64,acquisition:u64,command:ProductCommand)->Request{Request{projection:None,id,acquisition,previous_acquisition:None,traceparent:"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01".into(),command}}
#[test]
fn connection_isolation_dirty_payload_totals_and_cleanup(){
 let dir=Directory::new();let s=session(SqliteStore::create(dir.db(),identity()).unwrap(),"owner");let(l,_)=s.lock().unwrap().acquire(partition(0)).unwrap();let mut o=Owner::new(coordinator(s),vec![0]).unwrap();
 o.apply(&delivery(&l,vec![put(0,0,"a","-10.01"),put(0,1,"b","-2.01")])).unwrap();
 for connection in 1..=2{let mut q=query();q.limit=1;q.offset=connection-1;let p=o.command(connection,&request(1,1,ProductCommand::Open{subscription:"same".into(),query:q})).unwrap();assert_eq!(p.len(),1);assert_eq!(p[0].group.results[0].rows[0].id,if connection==1{"a"}else{"b"});}
 assert_eq!(o.coordinator.engine_stats().query_shapes,1);assert_eq!(o.subscription_count(),2);
 let mut update=put(0,2,"a","-10.01");if let rust_differential_product_core::source::ProductMutation::Upsert{row}=&mut update.event.mutation{row.label=OptionalString::Value("changed payload".into());}
 let p=o.apply(&delivery(&l,vec![update])).unwrap();assert_eq!(p.len(),2);assert_eq!(p[0].group.results[0].rows[0].label,OptionalString::Value("changed payload".into()));
 let p=o.apply(&delivery(&l,vec![put(0,3,"c","100")])).unwrap();assert!(p.iter().all(|p|p.group.results[0].total_rows==3));
 assert!(o.apply(&delivery(&l,vec![put(0,4,"c","100")])).unwrap().is_empty());
 o.disconnect(1).unwrap();assert_eq!(o.coordinator.engine_stats().subscriptions,1);assert_eq!(o.coordinator.engine_stats().query_shapes,1);
 o.disconnect(2).unwrap();assert_eq!(o.coordinator.engine_stats().subscriptions,0);assert_eq!(o.coordinator.engine_stats().query_shapes,0);
}
#[test]
fn rejected_replacement_and_obsolete_close_preserve_successor(){
 let dir=Directory::new();let s=session(SqliteStore::create(dir.db(),identity()).unwrap(),"owner");s.lock().unwrap().acquire(partition(0)).unwrap();let mut o=Owner::new(coordinator(s),vec![0]).unwrap();
 o.command(1,&request(1,1,ProductCommand::Open{subscription:"a".into(),query:query()})).unwrap();
 let mut bad=query();bad.offset=9_007_199_254_740_992;assert!(o.command(1,&request(2,2,ProductCommand::ChangeQuery{subscription:"a".into(),query:bad})).is_err());assert_eq!(o.current(1,"a"),Some(1));
 o.command(1,&request(3,3,ProductCommand::ChangeQuery{subscription:"a".into(),query:query()})).unwrap();
 assert!(o.command(1,&request(4,1,ProductCommand::Close{subscription:"a".into()})).is_err());assert_eq!(o.current(1,"a"),Some(3));
 o.command(1,&request(5,3,ProductCommand::Close{subscription:"a".into()})).unwrap();assert_eq!(o.current(1,"a"),None);
}
#[test]
fn complete_coverage_not_nonempty_assignment(){
 for owned in [vec![],vec![0],vec![0,1,2]]{let dir=Directory::new();let s=session(SqliteStore::create(dir.db(),identity()).unwrap(),"owner");for p in owned{s.lock().unwrap().acquire(partition(p)).unwrap();}let mut o=Owner::new(coordinator(s),vec![0,1]).unwrap();assert!(o.check_coverage().is_err());}
 let dir=Directory::new();let s=session(SqliteStore::create(dir.db(),identity()).unwrap(),"owner");for p in 0..2{s.lock().unwrap().acquire(partition(p)).unwrap();}let mut o=Owner::new(coordinator(s.clone()),vec![0,1]).unwrap();o.check_coverage().unwrap();
 let before=o.coordinator.incarnation().to_owned();s.lock().unwrap().release(&partition(1)).unwrap();assert!(o.check_coverage().is_err());assert_ne!(before,o.coordinator.incarnation());
}
#[test]
fn fixed_seed_lifecycle_against_independent_row_oracle(){
 let dir=Directory::new();let s=session(SqliteStore::create(dir.db(),identity()).unwrap(),"owner");let(l,_)=s.lock().unwrap().acquire(partition(0)).unwrap();let mut o=Owner::new(coordinator(s),vec![0]).unwrap();
 let mut seed=90210u64;let mut expected=std::collections::BTreeMap::new();
 for i in 0..500u64{seed=seed.wrapping_mul(1664525).wrapping_add(1013904223);let key=format!("a-{:02}",seed%20);let amount=-((seed%1000) as i64);let record=put(0,i,&key,&amount.to_string());expected.insert(key,amount);o.apply(&delivery(&l,vec![record])).unwrap();let mut q=query();q.offset=seed%24;q.limit=seed%8;
 let connection=1+i%3;let command=if o.current(connection,"same").is_some(){ProductCommand::ChangeQuery{subscription:"same".into(),query:q.clone()}}else{ProductCommand::Open{subscription:"same".into(),query:q.clone()}};let result=o.command(connection,&request(i+1,i+1,command)).unwrap();let r=&result[0].group.results[0];let mut rows=expected.iter().collect::<Vec<_>>();rows.sort_by(|a,b|a.1.cmp(b.1).then(a.0.cmp(b.0)));assert_eq!(r.total_rows,rows.len() as u64);assert_eq!(r.rows.iter().map(|r|&r.id).collect::<Vec<_>>(),rows.into_iter().skip(q.offset as usize).take(q.limit as usize).map(|(id,_)|id).collect::<Vec<_>>());if i%7==0{o.disconnect(connection).unwrap();}}
 for c in 1..=3{o.disconnect(c).unwrap();}assert_eq!(o.coordinator.engine_stats().query_shapes,0);
}
#[test]
fn extraction_resource_rejection_preserves_publication_owner(){
 let dir=Directory::new();let s=session(SqliteStore::create(dir.db(),identity()).unwrap(),"owner");s.lock().unwrap().acquire(partition(0)).unwrap();let mut o=Owner::new(coordinator(s),vec![0]).unwrap();o.bounds=ReadBounds{requests:4,rows:4096,bytes:1};assert!(o.command(1,&request(1,1,ProductCommand::Open{subscription:"same".into(),query:query()})).is_err());assert!(!o.failed);assert_eq!(o.current(1,"same"),None);o.check_coverage().unwrap();
}

#[test]
fn oversized_replacement_keeps_predecessor_and_other_client() {
 let dir=Directory::new();let s=session(SqliteStore::create(dir.db(),identity()).unwrap(),"owner");let(l,_)=s.lock().unwrap().acquire(partition(0)).unwrap();let mut o=Owner::new(coordinator(s),vec![0]).unwrap();
 let records=(0..64).map(|i|{let mut event=put(0,i,&format!("a-{i:03}"),"1").event;if let rust_differential_product_core::source::ProductMutation::Upsert{row}=&mut event.mutation{row.label=OptionalString::Value("x".repeat(4096));}product_source_ingestion::coordination::Record::new(event)}).collect();o.apply(&delivery(&l,records)).unwrap();
 let mut small=query();small.limit=1;
 for c in 1..=2{o.command(c,&request(1,1,ProductCommand::Open{subscription:"same".into(),query:small.clone()})).unwrap();}
 let before=o.coordinator.read("1/same").unwrap().unwrap().result;
 assert!(o.command(1,&request(2,2,ProductCommand::ChangeQuery{subscription:"same".into(),query:query()})).is_err());assert_eq!(o.current(1,"same"),Some(1));assert_eq!(o.coordinator.read("1/same").unwrap().unwrap().result,before);assert!(!o.failed);assert_eq!(o.coordinator.engine_stats().subscriptions,2);assert_eq!(o.coordinator.engine_stats().query_shapes,1);
}

#[test]
fn explicit_seventy_quota_boundary_cleanup_and_peer() {
 let dir=Directory::new();let s=session(SqliteStore::create(dir.db(),identity()).unwrap(),"owner");s.lock().unwrap().acquire(partition(0)).unwrap();
 let mut o=Owner::new(coordinator(s),vec![0]).unwrap().with_limits(SubscriptionLimits{per_client:70,total:80}).unwrap();
 let mut q=query();q.limit=2;
 for i in 0..70{o.command(1,&request(i+1,i+1,ProductCommand::Open{subscription:format!("s{i}"),query:q.clone()})).unwrap();}
 assert_eq!(o.subscription_count(),70);assert_eq!(o.coordinator.engine_stats().query_shapes,1);
 let overflow=request(71,71,ProductCommand::Open{subscription:"overflow".into(),query:q.clone()});
 assert!(o.command(1,&overflow).unwrap_err().to_string().contains("budget"));assert_eq!(o.current(1,"overflow"),None);
 o.command(2,&request(1,1,ProductCommand::Open{subscription:"s0".into(),query:q.clone()})).unwrap();
 o.command(1,&request(72,1,ProductCommand::Close{subscription:"s0".into()})).unwrap();o.command(1,&overflow).unwrap();
 o.disconnect(1).unwrap();assert_eq!(o.subscription_count(),1);assert_eq!(o.coordinator.engine_stats().query_shapes,1);
 o.disconnect(2).unwrap();assert_eq!(o.subscription_count(),0);assert_eq!(o.coordinator.engine_stats().query_shapes,0);
}
