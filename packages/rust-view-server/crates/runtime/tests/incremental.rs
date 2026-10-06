#[path = "support/durable.rs"]
mod support;
use support::*;
use product_source_ingestion::durable::*;
use rust_differential_product_core::{engine_contract::{ProductEngine,SelectedProductEngine},source::ProductMutation};

#[test]
fn fixed_keys_do_not_scale_with_retained_rows_including_guards() {
    let mut counts=Vec::new();
    for n in [1000,10000] {
        let dir=Directory::new();
        let mut s=SqliteStore::create(dir.db(),identity()).unwrap();
        let (t,_)=s.acquire(0,"owner").unwrap();
        let mut seq=0;
        for start in (0..n).step_by(1000) {
            let batch=(start..start+1000).map(|i|put(0,i,&format!("row-{i:06}"),"1")).collect::<Vec<_>>();
            s.commit(&t,seq,&batch).unwrap();seq+=1;
        }
        // Equalize bounded histories so dataset size is the only independent variable.
        for i in 0..256 { s.commit(&t,seq,&[put(0,n+i,"row-000000","1")]).unwrap();seq+=1; }
        let mut engine=SelectedProductEngine::load(s.load().unwrap().snapshot).unwrap();
        s.reset_work();
        let c=s.commit(&t,seq,&[put(0,n+256,"row-000000","2"),delete(0,n+257,"row-000001"),put(0,n+258,"new","3"),delete(0,n+259,"new")]).unwrap();
        let keys=c.before.rows.keys().cloned().collect::<Vec<_>>();
        assert_eq!(engine.observe(&keys).unwrap(),c.before);
        engine.commit(c.batch.unwrap()).unwrap();
        assert_eq!(engine.observe(&keys).unwrap(),c.after);
        s.guard(std::slice::from_ref(&t),seq+1,||Ok(())).unwrap();
        assert_eq!(s.authorize(&t,seq+1,Ok).unwrap(),n+260);
        let work=s.work();
        assert_eq!(work.full_scans,0);
        assert_eq!(work.reconstructions,0);
        assert_eq!(work.rows_fetched,2);
        assert_eq!(work.row_lookups,3);
        assert_eq!(work.ownership_lookups,3);
        assert_eq!(work.rows_written,1);
        assert_eq!(work.rows_deleted,1);
        assert_eq!(work.ownership_written,1);
        counts.push(work);
        // Independent complete audit after measurement, including exact end state.
        assert_eq!(engine.checkpoint().unwrap(),s.load().unwrap().snapshot);
        println!("WORK n={n} {}",serde_json::to_string(&work).unwrap());
    }
    assert_eq!(counts[0].sql_operations,counts[1].sql_operations);
    // Digits in bounded offsets/sequence and JSON fingerprint bytes can differ.
    assert!(counts[1].bytes_encoded.abs_diff(counts[0].bytes_encoded)<4096);
}
#[test]
fn overwritten_invalid_input_and_sticky_conflict_are_atomic_and_net_zero_is_exact() {
    let dir=Directory::new();
    let mut s=SqliteStore::create(dir.db(),identity()).unwrap();
    let (a,_)=s.acquire(0,"a").unwrap();
    let (b,_)=s.acquire(1,"b").unwrap();
    let bad=put(0,1,"","1");
    assert!(s.commit(&a,0,&[put(0,0,"x","1"),bad,delete(0,2,"")]).is_err());
    assert_eq!(s.load().unwrap().snapshot.last_source_batch,0);
    let c=s.commit(&a,0,&[put(0,0,"x","1"),put(0,1,"x","2"),delete(0,2,"x")]).unwrap();
    assert_eq!(c.before.rows,c.after.rows);
    assert_eq!(c.after.sequence,1);
    assert!(s.commit(&b,1,&[put(1,0,"x","9"),delete(1,1,"x")]).is_err());
    assert_eq!(s.load().unwrap().snapshot.offsets.len(),1);
    let mut invalid=put(0,3,"x","1");
    if let ProductMutation::Upsert { row }=&mut invalid.event.mutation { row.category="z".repeat(1025); }
    assert!(s.commit(&a,1,&[invalid,delete(0,4,"x")]).is_err());
}
#[test]
fn migration_rollback_identity_corruption_and_frozen_fixture_continue() {
    let frozen=include_bytes!("../fixtures/durable-format-v1.db");
    for point in [Point::BeforeCommit,Point::AfterCommit] {
        let dir=Directory::new();std::fs::write(dir.db(),frozen).unwrap();
        assert!(SqliteStore::migrate_v1_with_hook(dir.db(),identity(),|p|if p==point {Err(Error::Storage("interrupted".into()))}else{Ok(())}).is_err());
        if point==Point::BeforeCommit {
            assert!(matches!(SqliteStore::open(dir.db(),identity()),Err(Error::Format(1))));
            let conn=rusqlite::Connection::open(dir.db()).unwrap();
            let tables:i64=conn.query_row("SELECT count(*) FROM sqlite_master WHERE name IN ('rows','sticky')",[],|r|r.get(0)).unwrap();assert_eq!(tables,0);
            SqliteStore::migrate_v1_offline(dir.db(),identity()).unwrap();
        }
        let mut s=SqliteStore::open(dir.db(),identity()).unwrap();
        let (t,r)=s.acquire(0,"new").unwrap();assert_eq!(r.snapshot.rows.len(),4);
        s.commit(&t,1,&[delete(0,4,"row-000000"),put(0,5,"added","0.000000000000000001")]).unwrap();
        assert_eq!(s.load().unwrap().snapshot.rows.len(),4);
        assert!(matches!(SqliteStore::migrate_v1_offline(dir.db(),identity()),Err(Error::Format(3))));
    }
    for sql in ["UPDATE canonical SET digest=x'00'", "UPDATE canonical SET format=99"] {
        let dir=Directory::new();std::fs::write(dir.db(),frozen).unwrap();
        rusqlite::Connection::open(dir.db()).unwrap().execute(sql,[]).unwrap();
        assert!(SqliteStore::migrate_v1_offline(dir.db(),identity()).is_err());
    }
    let dir=Directory::new();std::fs::write(dir.db(),frozen).unwrap();
    let mut changed=identity();changed.incarnation="other".into();
    assert_eq!(SqliteStore::migrate_v1_offline(dir.db(),changed).unwrap_err(),Error::Identity);
}

#[test]
#[ignore = "SIGKILL subprocess helper; invoked by migration_and_multirecord_sigkill"]
fn v9_crash_child() {
    let path=std::path::PathBuf::from(std::env::var("V9_CRASH_DB").unwrap());
    let mode=std::env::var("V9_CRASH_MODE").unwrap();
    let point=if mode.ends_with("before") {Point::BeforeCommit}else{Point::AfterCommit};
    let barrier=|p| {
        if p==point {
            std::fs::write(path.with_extension("ready"),b"ready").unwrap();
            loop {std::thread::park();}
        }
        Ok(())
    };
    if mode.starts_with("migration") {SqliteStore::migrate_v1_with_hook(&path,identity(),barrier).unwrap();}
    else {
        let mut s=SqliteStore::open(&path,identity()).unwrap();
        let (t,_)=s.acquire(0,"child").unwrap();
        s.commit_with_hook(&t,0,&[put(0,0,"a","1"),put(0,1,"a","2"),put(0,2,"b","3"),delete(0,3,"b")],barrier).unwrap();
    }
}
#[test]
fn migration_and_multirecord_sigkill() {
    use std::{process::Command,time::{Duration,Instant}};
    for mode in ["migration-before","migration-after","batch-before","batch-after"] {
        let dir=Directory::new();
        if mode.starts_with("migration") {std::fs::write(dir.db(),include_bytes!("../fixtures/durable-format-v1.db")).unwrap();}
        else {SqliteStore::create(dir.db(),identity()).unwrap();}
        let mut child=Command::new(std::env::current_exe().unwrap()).args(["--ignored","--exact","v9_crash_child"])
            .env("V9_CRASH_DB",dir.db()).env("V9_CRASH_MODE",mode).spawn().unwrap();
        let deadline=Instant::now()+Duration::from_secs(15);
        while !dir.db().with_extension("ready").exists() {
            assert!(child.try_wait().unwrap().is_none());
            if Instant::now()>deadline {child.kill().unwrap();child.wait().unwrap();panic!("barrier timeout");}
            std::thread::sleep(Duration::from_millis(5));
        }
        child.kill().unwrap();
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(child.wait().unwrap().signal(),Some(9));
        if mode=="migration-before" {SqliteStore::migrate_v1_offline(dir.db(),identity()).unwrap();}
        let mut s=SqliteStore::open(dir.db(),identity()).unwrap();
        let r=s.load().unwrap();
        if mode.starts_with("migration") {assert_eq!(r.snapshot.rows.len(),4);}
        else if mode.ends_with("before") {assert_eq!(r.snapshot.last_source_batch,0);assert!(r.snapshot.rows.is_empty());}
        else {assert_eq!(r.snapshot.rows.len(),1);assert_eq!(r.snapshot.offsets[&0],3);assert_eq!(r.recent[&0].len(),4);}
        println!("SIGKILL {mode}: coherent old/new prefix");
    }
}
