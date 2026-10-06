use crate::health::*;
use std::{sync::{Arc,Mutex},time::{Duration,Instant}};
fn config()->Config{serde_json::from_value(serde_json::json!({"bind":"127.0.0.1:0","readiness":{"enter_offset_distance":2,"exit_offset_distance":5,"max_sample_age_ms":1500,"enter_hold_ms":200,"exit_hold_ms":300},"sample_ms":500,"heartbeat_ms":100,"dependencies_ms":100,"change_ms":25})).unwrap()}
fn health()->Arc<Health>{Health::new(config(),"test".into(),"products".into(),"source".into(),&[0,1],vec![]).unwrap()}
fn complete(s:&mut Snapshot){s.startup_complete=true;s.authority_safe=true;s.phase=Phase::Serving;for p in &mut s.sources[0].partitions{p.assigned=true;p.bootstrap_complete=true;p.durable_next=Some("8".into());p.derived_next=Some("8".into());p.serving_next=Some("8".into());p.readable_end=Some("10".into());p.readable_sample_ms=Some(0);}}
#[test]fn all_partitions_hysteresis_stale_and_latched_startup(){let h=health();let mut s=h.snapshot();let mut l=ReadinessLatch::default();assert!(!l.evaluate(&s,0).0);complete(&mut s);assert!(!l.evaluate(&s,0).0);assert!(l.evaluate(&s,200).0);s.sources[0].partitions[1].readable_end=Some("14".into());assert!(l.evaluate(&s,201).0);assert!(!l.evaluate(&s,501).0);s.sources[0].partitions[1].readable_end=Some("10".into());assert!(!l.evaluate(&s,502).0);assert!(l.evaluate(&s,702).0);assert!(!l.evaluate(&s,1501).0);assert!(s.startup_complete);s.authority_safe=false;assert!(!l.evaluate(&s,702).0);s.authority_safe=true;s.phase=Phase::Stopping;assert!(!l.evaluate(&s,702).0);}
#[test]fn gaps_open_transactions_unknown_and_two_source_model(){let h=health();let mut s=h.snapshot();complete(&mut s);let p=&mut s.sources[0].partitions[0];p.durable_next=Some("2".into());p.derived_next=Some("2".into());p.serving_next=Some("8".into());p.high_watermark=Some("900".into());p.transaction_blocked=Some(true);assert_eq!(p.lag(),Some(2));let mut l=ReadinessLatch::default();l.evaluate(&s,0);assert!(l.evaluate(&s,200).0);let mut second=s.sources[0].clone();second.topic="model-only-second-source".into();second.partitions[0].readable_end=None;s.sources.push(second);assert!(!l.evaluate(&s,201).0);}
#[test]fn dependency_loss_is_not_owner_stall(){let h=health();h.update(complete);assert!(h.snapshot().live);h.update(|s|{s.authority_safe=false;s.sources[0].partitions[0].readable_end=None;});assert!(!h.snapshot().ready);assert!(h.snapshot().live);h.state.lock().unwrap().snapshot.owner_stall_ms=0;std::thread::sleep(Duration::from_millis(3));assert!(!h.snapshot().live);assert!(h.snapshot().startup_complete);}
#[test]fn retention_backlog_blocks_readiness_without_changing_liveness(){let h=health();h.update(|s|{complete(s);s.sources[0].retention=RetentionServingHealth{enabled:true,safe:true,pending_due:false,active_payload_rows:2,sticky_keys:3,scheduled_expiries:2,canonical_version:4,derived_version:4,maintenance_sequence:1,overdue_ms:None,next_expiry_unix_ms:Some(10),last_commit_unix_ms:None,last_expiry_delay_ms:None};});std::thread::sleep(Duration::from_millis(210));h.update(|_|{});assert!(h.snapshot().ready);h.update(|s|{s.sources[0].retention.safe=false;s.sources[0].retention.pending_due=true;s.sources[0].retention.overdue_ms=Some(1);});let pending=h.snapshot();assert!(!pending.ready);assert_eq!(pending.reason,"retention_maintenance_pending");assert!(pending.live);h.update(|s|{s.sources[0].retention.safe=true;s.sources[0].retention.pending_due=false;s.sources[0].retention.overdue_ms=None;});assert!(!h.snapshot().ready);std::thread::sleep(Duration::from_millis(210));h.update(|_|{});assert!(h.snapshot().ready);}
#[test]fn callbacks_quiet_coalesce_failure_and_bounded_shutdown(){let h=health();let t=crate::telemetry::Telemetry::new(&Default::default(),"test",Arc::downgrade(&h)).unwrap();let seen=Arc::new(Mutex::new(vec![]));let copy=seen.clone();let r=Reporter::start(h.clone(),Callbacks{on_heartbeat:Some(Box::new(move|s|{copy.lock().unwrap().push(s.phase);Err("sink failure".into())})),on_dependencies_update:None},t.clone());std::thread::sleep(Duration::from_millis(130));for _ in 0..100{h.update(|s|s.records_committed+=1);}h.update(complete);std::thread::sleep(Duration::from_millis(140));h.stop();assert!(r.shutdown(Duration::from_millis(100)));let values=seen.lock().unwrap();assert_eq!(values[0],Phase::Starting);assert_eq!(values.last(),Some(&Phase::Stopping));assert!(values.len()>=4&&values.len()<10);assert!(h.snapshot().callback_failures>=4);drop(values);
let r=Reporter::start(h.clone(),Callbacks{on_heartbeat:Some(Box::new(|_|{std::thread::sleep(Duration::from_millis(400));Ok(())})),on_dependencies_update:None},t.clone());std::thread::sleep(Duration::from_millis(30));let start=Instant::now();for _ in 0..1000{h.update(|s|s.records_committed+=1);}assert!(start.elapsed()<Duration::from_millis(100));assert!(!r.shutdown(Duration::from_millis(20)));std::thread::sleep(Duration::from_millis(800));t.shutdown();}
#[test]fn default_quiet_periods_and_early_dependency_inventory(){let mut c=config();c.heartbeat_ms=5000;c.dependencies_ms=30000;c.change_ms=300;let h=Health::new(c,"quiet".into(),"products".into(),"source".into(),&[0],vec![]).unwrap();let t=crate::telemetry::Telemetry::new(&Default::default(),"quiet",Arc::downgrade(&h)).unwrap();let events=Arc::new(Mutex::new(Vec::new()));let a=events.clone();let b=events.clone();let started=Instant::now();let r=Reporter::start(h.clone(),Callbacks{on_heartbeat:Some(Box::new(move|_|{a.lock().unwrap().push(("heartbeat",started.elapsed().as_millis()));Ok(())})),on_dependencies_update:Some(Box::new(move|_|{b.lock().unwrap().push(("inventory",started.elapsed().as_millis()));Ok(())}))},t.clone());std::thread::sleep(Duration::from_millis(30200));let before=events.lock().unwrap().clone();assert_eq!(before.iter().filter(|(k,_)|*k=="inventory").count(),2);assert!(before.iter().filter(|(k,_)|*k=="heartbeat").count()>=6);h.update(|s|s.dependencies.push(Dependency{id:"new".into(),resource_id:"test".into(),role:"model".into(),state:"unknown".into(),reason:None,attribution:"unknown".into()}));std::thread::sleep(Duration::from_millis(400));assert_eq!(events.lock().unwrap().iter().filter(|(k,_)|*k=="inventory").count(),3);assert!(r.shutdown(Duration::from_millis(100)));t.shutdown();}
#[test]fn real_http_owner_stall_and_shutdown_use_cached_state(){let mut c=config();let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();c.bind=listener.local_addr().unwrap();drop(listener);let address=c.bind;let h=Health::new(c,"http".into(),"products".into(),"source".into(),&[0],vec![]).unwrap();let t=crate::telemetry::Telemetry::new(&Default::default(),"http",Arc::downgrade(&h)).unwrap();let server=crate::management::Management::start(h.clone(),t.clone(),"token".into()).unwrap();let client=reqwest::blocking::Client::builder().timeout(Duration::from_secs(2)).build().unwrap();let get=|p:&str|client.get(format!("http://{address}{p}")).send().unwrap();assert_eq!(get("/startupz").status(),503);assert_eq!(get("/livez").status(),200);h.update(complete);std::thread::sleep(Duration::from_millis(210));h.update(|_|{});assert_eq!(get("/readyz").status(),200);h.state.lock().unwrap().snapshot.owner_stall_ms=1;std::thread::sleep(Duration::from_millis(3));assert_eq!(get("/livez").status(),503);assert_eq!(get("/startupz").status(),200);h.stop();assert_eq!(get("/readyz").status(),503);assert_eq!(get("/health").status(),401);server.shutdown();t.shutdown();}

#[test]fn stale_cached_ready_must_reenter_hold_and_snapshot_fits_exact_codec(){let h=health();h.update(complete);std::thread::sleep(Duration::from_millis(210));h.update(|_|{});assert!(h.snapshot().ready);std::thread::sleep(Duration::from_millis(1350));assert!(!h.snapshot().ready);h.update(|s|{for p in &mut s.sources[0].partitions{p.readable_sample_ms=Some(h.now());}});assert!(!h.snapshot().ready);std::thread::sleep(Duration::from_millis(210));h.update(|_|{});assert!(h.snapshot().ready);let value=serde_json::json!({"v":14,"type":"health","snapshot":h.snapshot()});let encoded=v13_codec_experiment::encode_mp(&v13_codec_experiment::prepare(&value).unwrap()).unwrap();assert!(encoded.len()<MAX_SNAPSHOT_BYTES);}
#[test]fn fetched_progress_never_substitutes_for_applied_or_one_behind_topic(){let h=health();let mut s=h.snapshot();complete(&mut s);let mut l=ReadinessLatch::default();s.sources[0].partitions[0].fetched_next=Some("100".into());s.sources[0].partitions[0].derived_next=Some("7".into());assert_eq!(l.evaluate(&s,0),(false,"derived_not_applied".into()));s.sources[0].partitions[0].derived_next=Some("8".into());s.sources[0].partitions[0].readable_end=Some("100".into());assert!(!l.evaluate(&s,1000).0);s.sources[0].partitions[0].readable_end=Some("10".into());l.evaluate(&s,1001);assert!(l.evaluate(&s,1201).0);for p in &mut s.sources[0].partitions{p.readable_sample_ms=Some(1000);}let mut second=s.sources[0].clone();second.topic="model-only-behind-topic".into();second.partitions[0].readable_end=Some("100".into());s.sources.push(second);assert!(l.evaluate(&s,1202).0);assert!(!l.evaluate(&s,1502).0);}

fn dependency(id:&str,state:&str)->Dependency{Dependency{id:id.into(),resource_id:format!("resource-{id}"),role:"source_read".into(),state:state.into(),reason:None,attribution:"observed".into()}}
#[test]
fn keyed_report_clock_prompt_trailing_latest_and_inventory_semantics(){
    let mut schedule=DependencySchedule::new();let mut deps=vec![dependency("a","ready"),dependency("b","ready")];
    assert!(schedule.poll(&deps,0,30000));
    deps[0].state="down".into();assert!(schedule.poll(&deps,5,30000)); // first prompt
    deps[0].state="recovering".into();assert!(!schedule.poll(&deps,20,30000));
    deps[1].state="down".into();assert!(schedule.poll(&deps,30,30000)); // B never starved by A
    // B's COMPLETE inventory includes A's current recovering state, but cannot
    // consume A's pending trigger or postpone its independent deadline.
    assert!(schedule.slots[0].pending);assert_eq!(schedule.slots[0].last_trigger,Some(5));
    deps[0].state="ready".into();assert!(!schedule.poll(&deps,40,30000));
    assert!(!schedule.poll(&deps,1004,30000));assert!(schedule.poll(&deps,1005,30000));
    assert_eq!(schedule.slots[0].observed.state,"ready");assert!(!schedule.slots[0].pending);
    assert!(!schedule.poll(&deps,31004,30000));assert!(schedule.poll(&deps,31005,30000));
    assert_eq!(schedule.slots.len(),2);
}
#[test]
fn keyed_report_clock_continuous_changes_do_not_reset_deadline_or_grow_pending(){
    let mut schedule=DependencySchedule::new();let mut deps=vec![dependency("a","ready"),dependency("b","ready")];schedule.poll(&deps,0,30000);
    let mut times=vec![];
    for now in 1..=10000 {deps[0].reason=Some(now.to_string());if schedule.poll(&deps,now,30000){times.push(now);}assert_eq!(schedule.slots.len(),2);}
    assert_eq!(times,vec![1,1001,2001,3001,4001,5001,6001,7001,8001,9001]);
    assert!(schedule.poll(&deps,10001,30000));assert_eq!(schedule.slots[0].observed.reason.as_deref(),Some("10000"));
}
#[test]
fn keyed_report_clock_ignores_sample_counters_and_tracks_reason_and_attribution(){
    let h=health();let mut s=h.snapshot();s.dependencies=vec![dependency("a","ready")];let mut schedule=DependencySchedule::new();assert!(schedule.poll(&s.dependencies,0,30000));
    for now in 1..1000 {s.sequence+=1;s.records_committed+=1;s.sampled_at_unix_ms+=1;s.observed_at_ms=now;assert!(!schedule.poll(&s.dependencies,now,30000));}
    s.dependencies[0].reason=Some("new reason".into());assert!(schedule.poll(&s.dependencies,1000,30000));
    s.dependencies[0].attribution="unknown".into();assert!(!schedule.poll(&s.dependencies,1001,30000));assert!(schedule.poll(&s.dependencies,2000,30000));
}
#[test]
fn reporter_real_callbacks_reentrant_throw_isolation_and_final_recovery(){
    let mut c=config();c.dependencies_ms=30000;c.heartbeat_ms=5000;
    let h=Health::new(c,"f4".into(),"products".into(),"source".into(),&[0],vec![dependency("a","ready"),dependency("b","ready")]).unwrap();
    let t=crate::telemetry::Telemetry::new(&Default::default(),"f4",Arc::downgrade(&h)).unwrap();
    let (tx,rx)=std::sync::mpsc::channel();let reentrant=h.clone();
    let r=Reporter::start(h.clone(),Callbacks{
        on_heartbeat:Some(Box::new(|_|{std::thread::sleep(Duration::from_millis(350));Err("slow heartbeat failure".into())})),
        on_dependencies_update:Some(Box::new(move|inventory|{reentrant.update(|s|s.records_committed+=1);tx.send((Instant::now(),inventory)).unwrap();Err("dependency sink failure".into())})),
    },t.clone());
    let (_,initial)=rx.recv_timeout(Duration::from_millis(200)).unwrap();assert_eq!(initial.dependencies.len(),2);
    let changed=Instant::now();h.update(|s|{s.dependencies[0].state="down".into();s.authority_safe=false;});assert!(!h.snapshot().ready);
    let (first,inventory)=rx.recv_timeout(Duration::from_millis(200)).unwrap();assert!(first.duration_since(changed)<Duration::from_millis(200));assert_eq!(inventory.dependencies[0].state,"down");
    h.update(|s|s.dependencies[0].state="ready".into()); // final suppressed event, no more changes
    assert_eq!(h.snapshot().dependencies[0].state,"ready");
    h.update(|s|s.dependencies[1].state="down".into());
    let (_,other)=rx.recv_timeout(Duration::from_millis(200)).unwrap();assert_eq!(other.dependencies.len(),2);assert_eq!(other.dependencies[0].state,"ready");assert_eq!(other.dependencies[1].state,"down");
    let (trailing,final_inventory)=rx.recv_timeout(Duration::from_millis(1200)).unwrap();assert!(trailing.duration_since(first)>=Duration::from_millis(1000));assert_eq!(final_inventory.dependencies[0].state,"ready");
    assert!(h.snapshot().callback_failures>=4);assert!(r.shutdown(Duration::from_millis(500)));t.shutdown();
}
