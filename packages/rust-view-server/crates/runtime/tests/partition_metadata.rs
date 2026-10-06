#[path = "support/durable.rs"]
mod support;
use product_source_ingestion::{
    coordination::{Record, Recovery},
    durable::*,
};
use rust_differential_product_core::{
    engine_contract::{ProductEngine, SelectedProductEngine},
    product::*,
    source::*,
    topic::RowId,
};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    process::Command,
    time::{Duration, Instant},
};
use support::*;

fn frozen(p: u32, i: u64) -> Record {
    Record::new(SourceMutation {
        partition: p,
        offset: i,
        mutation: if i == 255 {
            ProductMutation::Delete {
                key: RowId(format!("p{p}-0")),
            }
        } else {
            ProductMutation::Upsert {
                row: ProductRow {
                    id: format!("p{p}-{i}"),
                    category: if i % 2 == 0 { "a" } else { "b" }.into(),
                    label: OptionalString::Value("exact\0日本語".into()),
                    quantity: ExactInteger::parse("9223372036854775807").unwrap(),
                    amount: ExactDecimal::parse(&format!("{i}.000000000000000001")).unwrap(),
                },
            }
        },
    })
}
fn values(path: &std::path::Path, table: &str) -> Vec<(String, Vec<u8>, Vec<u8>)> {
    let c = rusqlite::Connection::open(path).unwrap();
    let sql = if table == "sticky" {
        "SELECT id,CAST(partition AS BLOB),digest FROM sticky ORDER BY id"
    } else {
        "SELECT id,payload,digest FROM rows ORDER BY id"
    };
    c.prepare(sql)
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}
fn canonical(path: &std::path::Path) -> serde_json::Value {
    let c = rusqlite::Connection::open(path).unwrap();
    let b: Vec<u8> = c
        .query_row("SELECT payload FROM canonical", [], |r| r.get(0))
        .unwrap();
    serde_json::from_slice(&b).unwrap()
}
fn partition_blobs(path: &std::path::Path) -> BTreeMap<u32, Vec<u8>> {
    let c = rusqlite::Connection::open(path).unwrap();
    c.prepare("SELECT partition,payload FROM partitions")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}
#[test]
fn unrelated_partitions_have_constant_actual_work_and_unchanged_blobs() {
    let mut measured = Vec::new();
    for count in [1, 16, 256] {
        let dir = Directory::new();
        let mut s = SqliteStore::create(dir.db(), identity()).unwrap();
        let tokens = (0..count)
            .map(|p| s.acquire(p, "owner").unwrap().0)
            .collect::<Vec<_>>();
        let mut seq = 0;
        s.commit(
            &tokens[0],
            seq,
            &(0..1000)
                .map(|i| put(0, i, &format!("row-{i:06}"), "1"))
                .collect::<Vec<_>>(),
        )
        .unwrap();
        seq += 1;
        for p in 0..count {
            let base = if p == 0 { 1000 } else { 0 };
            s.commit(
                &tokens[p as usize],
                seq,
                &(base..base + 256)
                    .map(|i| delete(p, i, &format!("warm-{p}")))
                    .collect::<Vec<_>>(),
            )
            .unwrap();
            seq += 1;
        }
        for i in 1256..1512 {
            s.commit(&tokens[0], seq, &[delete(0, i, "warm-0")])
                .unwrap();
            seq += 1;
        }
        // Replay boundaries remain exact even with 256 unrelated full histories.
        for offset in [1256, 1511] {
            assert!(
                s.commit(&tokens[0], seq, &[delete(0, offset, "warm-0")])
                    .unwrap()
                    .batch
                    .is_none()
            );
        }
        assert!(
            s.commit(&tokens[0], seq, &[delete(0, 1256, "conflict")])
                .unwrap_err()
                .to_string()
                .contains("conflicting")
        );
        assert!(
            s.commit(&tokens[0], seq, &[delete(0, 1255, "warm-0")])
                .unwrap_err()
                .to_string()
                .contains("horizon")
        );
        let blobs = partition_blobs(&dir.db());
        let mut engine = SelectedProductEngine::load(s.load().unwrap().snapshot).unwrap();
        let conn = rusqlite::Connection::open(dir.db()).unwrap();
        conn.execute_batch("CREATE TRIGGER forbid_unrelated BEFORE UPDATE ON partitions WHEN old.partition!=0 BEGIN SELECT RAISE(ABORT,'unrelated partition write'); END;").unwrap();
        s.reset_work();
        let c = s
            .commit(
                &tokens[0],
                seq,
                &[
                    put(0, 1512, "row-000000", "2"),
                    delete(0, 1513, "row-000001"),
                ],
            )
            .unwrap();
        let commit = s.work();
        let keys = c.before.rows.keys().cloned().collect::<Vec<_>>();
        assert_eq!(engine.observe(&keys).unwrap(), c.before);
        engine.commit(c.batch.unwrap()).unwrap();
        assert_eq!(engine.observe(&keys).unwrap(), c.after);
        s.reset_work();
        s.guard(&tokens[0..1], seq + 1, || Ok(())).unwrap();
        let guard = s.work();
        s.reset_work();
        assert_eq!(s.authorize(&tokens[0], seq + 1, Ok).unwrap(), 1514);
        let broker = s.work();
        for w in [commit, guard, broker] {
            assert_eq!(w.partition_scans, 0);
            assert_eq!(w.full_scans, 0);
            assert_eq!(w.reconstructions, 0);
            assert_eq!(w.partition_objects_read, 1);
            assert_eq!(w.metadata_reads, 2);
        }
        assert_eq!(commit.metadata_writes, 2);
        assert_eq!(commit.partition_objects_written, 1);
        assert_eq!(commit.row_lookups, 2);
        assert_eq!(commit.replay_records_checked, 2);
        assert_eq!(guard.rows_fetched + broker.rows_fetched, 0);
        assert_eq!(guard.bytes_encoded + broker.bytes_encoded, 0);
        let after = partition_blobs(&dir.db());
        for p in 1..count {
            assert_eq!(blobs[&p], after[&p]);
        }
        assert_eq!(engine.checkpoint().unwrap(), s.load().unwrap().snapshot);
        println!(
            "PARTITION_WORK P={count} {}",
            serde_json::json!({"commit":commit,"guard":guard,"broker":broker})
        );
        measured.push((commit, guard, broker));
    }
    for pair in measured.windows(2) {
        for (a, b) in [
            (pair[0].0, pair[1].0),
            (pair[0].1, pair[1].1),
            (pair[0].2, pair[1].2),
        ] {
            assert_eq!(a.sql_operations, b.sql_operations);
            assert_eq!(a.metadata_reads, b.metadata_reads);
            assert_eq!(a.metadata_writes, b.metadata_writes);
            assert!(a.metadata_bytes_encoded.abs_diff(b.metadata_bytes_encoded) < 4096);
            assert!(a.metadata_bytes_decoded.abs_diff(b.metadata_bytes_decoded) < 4096);
        }
    }
}
#[test]
fn v2_migration_exact_audit_replay_restart_and_many_partition_results() {
    let dir = Directory::new();
    std::fs::write(dir.db(), include_bytes!("../fixtures/durable-format-v2.db")).unwrap();
    let old = canonical(&dir.db());
    let rows = values(&dir.db(), "rows");
    let sticky = values(&dir.db(), "sticky");
    assert!(matches!(
        SqliteStore::open(dir.db(), identity()),
        Err(Error::Format(2))
    ));
    SqliteStore::migrate_v2_offline(dir.db(), identity()).unwrap();
    assert_eq!(values(&dir.db(), "rows"), rows);
    assert_eq!(values(&dir.db(), "sticky"), sticky);
    let global = canonical(&dir.db());
    assert_ne!(old["store_id"], global["store_id"]);
    assert_eq!(old["source"], global["source"]);
    for (p, b) in partition_blobs(&dir.db()) {
        let v: serde_json::Value = serde_json::from_slice(&b).unwrap();
        assert_eq!(v["ownership"], old["partitions"][p.to_string()]);
        assert_eq!(v["recent"], old["recovery"]["recent"][p.to_string()]);
    }
    let expected: Recovery =
        serde_json::from_str(include_str!("../fixtures/durable-format-v2-recovery.json")).unwrap();
    let mut s = SqliteStore::open(dir.db(), identity()).unwrap();
    assert_eq!(
        serde_json::to_value(s.load().unwrap()).unwrap(),
        serde_json::to_value(&expected).unwrap()
    );
    let (t, _) = s.acquire(0, "new").unwrap();
    for i in [0, 255] {
        assert!(s.commit(&t, 16, &[frozen(0, i)]).unwrap().batch.is_none());
    }
    assert!(
        s.commit(&t, 16, &[delete(0, 0, "conflict")])
            .unwrap_err()
            .to_string()
            .contains("conflicting")
    );
    s.commit(&t, 16, &[delete(0, 256, "missing")]).unwrap();
    assert!(
        s.commit(&t, 17, &[frozen(0, 0)])
            .unwrap_err()
            .to_string()
            .contains("horizon")
    );
    let recovery = s.load().unwrap();
    drop(s);
    let mut s = SqliteStore::open(dir.db(), identity()).unwrap();
    let (successor, _) = s.acquire(0, "successor").unwrap();
    assert_eq!(
        s.commit(&t, 17, &[delete(0, 257, "new")]).unwrap_err(),
        Error::Fenced
    );
    assert!(
        s.commit(&successor, 17, &[frozen(0, 1)])
            .unwrap()
            .batch
            .is_none()
    );
    let mut e = SelectedProductEngine::load(recovery.snapshot.clone()).unwrap();
    assert!(
        !recovery
            .snapshot
            .rows
            .iter()
            .any(|r| r.id == "p0-0" || r.id == "missing")
    );
    for (j, (filter, desc, start, limit)) in [
        (false, false, 0, 10000),
        (false, true, 0, 10000),
        (true, false, 1000, 32),
        (true, true, 1000, 32),
        (false, true, 3900, 100),
        (false, false, 10000, 5),
    ]
    .into_iter()
    .enumerate()
    {
        let mut rows = recovery
            .snapshot
            .rows
            .iter()
            .filter(|r| !filter || r.category == "a")
            .cloned()
            .collect::<Vec<_>>();
        rows.sort_by(|a, b| {
            let order = a.amount.cmp(&b.amount);
            (if desc { order.reverse() } else { order }).then(a.id.cmp(&b.id))
        });
        e.command(ProductCommand::Open {
            subscription: j.to_string(),
            query: Query {
                where_expr: if filter {
                    Expr::Condition(Condition::CategoryEquals("a".into()))
                } else {
                    Expr::True
                },
                direction: if desc {
                    Direction::Descending
                } else {
                    Direction::Ascending
                },
                offset: start,
                limit,
            },
        })
        .unwrap();
        let got = e.read(&j.to_string()).unwrap();
        assert_eq!(got.total_rows, rows.len() as u64);
        assert_eq!(got.start_rank, start);
        assert_eq!(
            got.rows,
            rows.into_iter()
                .skip(start as usize)
                .take(limit as usize)
                .collect::<Vec<_>>()
        );
    }
}
fn rewrite(path: &std::path::Path, table: &str, change: impl FnOnce(&mut serde_json::Value)) {
    let c = rusqlite::Connection::open(path).unwrap();
    let sql = format!("SELECT payload FROM {table} LIMIT 1");
    let bytes: Vec<u8> = c.query_row(&sql, [], |r| r.get(0)).unwrap();
    let mut v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    change(&mut v);
    let b = serde_json::to_vec(&v).unwrap();
    c.execute(&format!("UPDATE {table} SET payload=?1,digest=?2 WHERE rowid=(SELECT rowid FROM {table} LIMIT 1)"),rusqlite::params![&b,Sha256::digest(&b).as_slice()]).unwrap();
}
#[test]
fn migration_and_complete_audit_reject_corrupt_metadata_rows_owners_and_newer_formats() {
    for kind in [
        "owner", "history", "offset", "sequence", "row", "sticky", "newer",
    ] {
        let dir = Directory::new();
        std::fs::write(dir.db(), include_bytes!("../fixtures/durable-format-v2.db")).unwrap();
        match kind {
            "owner" => rewrite(&dir.db(), "canonical", |v| {
                v["partitions"]["0"]["owner"] = "active".into()
            }),
            "history" => rewrite(&dir.db(), "canonical", |v| {
                v["recovery"]["recent"]["0"] = serde_json::json!([])
            }),
            "offset" => rewrite(&dir.db(), "canonical", |v| {
                v["recovery"]["snapshot"]["offsets"]["0"] = 999.into()
            }),
            "sequence" => rewrite(&dir.db(), "canonical", |v| {
                v["recovery"]["snapshot"]["last_source_batch"] = 999.into()
            }),
            "newer" => {
                rusqlite::Connection::open(dir.db())
                    .unwrap()
                    .execute("UPDATE canonical SET format=999", [])
                    .unwrap();
            }
            table => {
                rusqlite::Connection::open(dir.db())
                    .unwrap()
                    .execute(
                        &format!(
                            "UPDATE {} SET digest=x'00'",
                            if table == "row" { "rows" } else { "sticky" }
                        ),
                        [],
                    )
                    .unwrap();
            }
        }
        assert!(
            SqliteStore::migrate_v2_offline(dir.db(), identity()).is_err(),
            "{kind}"
        );
        assert_eq!(
            rusqlite::Connection::open(dir.db())
                .unwrap()
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE name='partitions'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }
    for kind in [
        "key",
        "history",
        "epoch",
        "label",
        "offset",
        "global",
        "row",
        "sticky",
        "deleted-partition",
    ] {
        let dir = Directory::new();
        std::fs::write(dir.db(), include_bytes!("../fixtures/durable-format-v2.db")).unwrap();
        SqliteStore::migrate_v2_offline(dir.db(), identity()).unwrap();
        match kind {
            "key" => rewrite(&dir.db(), "partitions", |v| v["partition"] = 999.into()),
            "history" => rewrite(&dir.db(), "partitions", |v| {
                v["recent"] = serde_json::json!([])
            }),
            "epoch" => rewrite(&dir.db(), "partitions", |v| {
                v["ownership"]["epoch"] = 0.into()
            }),
            "label" => rewrite(&dir.db(), "partitions", |v| {
                v["ownership"]["checkpoint_label"] = "x".repeat(1025).into()
            }),
            "offset" => rewrite(&dir.db(), "partitions", |v| v["offset"] = 999.into()),
            "global" => rewrite(&dir.db(), "canonical", |v| {
                v["recovery"]["snapshot"]["version"] = 999.into()
            }),
            "deleted-partition" => {
                rusqlite::Connection::open(dir.db())
                    .unwrap()
                    .execute("DELETE FROM partitions WHERE partition=0", [])
                    .unwrap();
            }
            table => {
                rusqlite::Connection::open(dir.db())
                    .unwrap()
                    .execute(
                        &format!(
                            "UPDATE {} SET digest=x'00'",
                            if table == "row" { "rows" } else { "sticky" }
                        ),
                        [],
                    )
                    .unwrap();
            }
        }
        assert!(SqliteStore::open(dir.db(), identity()).is_err(), "{kind}");
    }
}
#[test]
#[ignore = "SIGKILL migration subprocess invoked by v2_migration_sigkill"]
fn v10_migration_child() {
    let path = std::path::PathBuf::from(std::env::var("V10_DB").unwrap());
    let after = std::env::var("V10_AFTER").unwrap() == "true";
    SqliteStore::migrate_v2_with_hook(&path, identity(), |p| {
        if p == if after {
            Point::AfterCommit
        } else {
            Point::BeforeCommit
        } {
            std::fs::write(path.with_extension("ready"), b"ready").unwrap();
            loop {
                std::thread::park();
            }
        }
        Ok(())
    })
    .unwrap();
}
#[test]
fn v2_migration_sigkill() {
    for after in [false, true] {
        let dir = Directory::new();
        std::fs::write(dir.db(), include_bytes!("../fixtures/durable-format-v2.db")).unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "v10_migration_child"])
            .env("V10_DB", dir.db())
            .env("V10_AFTER", after.to_string())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        while !dir.db().with_extension("ready").exists() {
            assert!(child.try_wait().unwrap().is_none());
            if Instant::now() > deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("barrier timeout");
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        child.kill().unwrap();
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(child.wait().unwrap().signal(), Some(9));
        if !after {
            assert!(matches!(
                SqliteStore::open(dir.db(), identity()),
                Err(Error::Format(2))
            ));
            SqliteStore::migrate_v2_offline(dir.db(), identity()).unwrap();
        }
        let mut s = SqliteStore::open(dir.db(), identity()).unwrap();
        let expected: Recovery =
            serde_json::from_str(include_str!("../fixtures/durable-format-v2-recovery.json"))
                .unwrap();
        assert_eq!(
            serde_json::to_value(s.load().unwrap()).unwrap(),
            serde_json::to_value(expected).unwrap()
        );
        println!("SIGKILL v2->v3 after_commit={after}: exact full state");
    }
}
#[test]
fn staged_old_connection_cannot_write_any_metadata_after_successor_fence() {
    use std::sync::mpsc;
    let dir = Directory::new();
    let mut old = SqliteStore::create(dir.db(), identity()).unwrap();
    let (token, _) = old.acquire(0, "old").unwrap();
    let (other, _) = old.acquire(1, "other").unwrap();
    old.commit(&token, 0, &[put(0, 0, "a", "1")]).unwrap();
    let (ready_tx, ready_rx) = mpsc::channel();
    let (go_tx, go_rx) = mpsc::channel();
    let stale = token.clone();
    let writer = std::thread::spawn(move || {
        let err = old
            .commit_with_hook(
                &stale,
                1,
                &[put(0, 1, "new-sticky", "2"), delete(0, 2, "a")],
                |p| {
                    if p == Point::BeforeTransaction {
                        ready_tx.send(()).unwrap();
                        go_rx.recv().unwrap();
                    }
                    Ok(())
                },
            )
            .unwrap_err();
        assert_eq!(err, Error::Fenced);
        old
    });
    ready_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    let mut next = SqliteStore::open(dir.db(), identity()).unwrap();
    let (successor, _) = next.acquire(0, "next").unwrap();
    next.label_checkpoint(&successor, "new label").unwrap();
    let blobs = partition_blobs(&dir.db());
    let rows = values(&dir.db(), "rows");
    let sticky = values(&dir.db(), "sticky");
    let global = canonical(&dir.db());
    go_tx.send(()).unwrap();
    let mut old = writer.join().unwrap();
    for records in [
        vec![put(0, 1, "a", "1")],
        vec![delete(0, 1, "missing")],
        vec![put(0, 0, "a", "1")],
    ] {
        assert_eq!(old.commit(&token, 1, &records).unwrap_err(), Error::Fenced);
    }
    assert_eq!(
        old.label_checkpoint(&token, "stale").unwrap_err(),
        Error::Fenced
    );
    assert_eq!(old.release(&token).unwrap_err(), Error::Fenced);
    assert_eq!(
        old.authorize::<()>(&token, 1, |_| panic!("old broker callback"))
            .unwrap_err(),
        Error::Fenced
    );
    assert_eq!(
        old.guard::<()>(&[token], 1, || panic!("old query"))
            .unwrap_err(),
        Error::Fenced
    );
    assert_eq!(partition_blobs(&dir.db()), blobs);
    assert_eq!(values(&dir.db(), "rows"), rows);
    assert_eq!(values(&dir.db(), "sticky"), sticky);
    assert_eq!(canonical(&dir.db()), global);
    // Another partition's token is unchanged and remains live at the coherent cut.
    old.commit(&other, 1, &[put(1, 0, "other", "3")]).unwrap();
    assert_eq!(old.authorize(&other, 2, Ok).unwrap(), 1);
    // A connection with an older cached complete vector must explicitly reconstruct.
    assert_eq!(
        next.commit(&successor, 2, &[put(0, 1, "a", "2")])
            .unwrap_err(),
        Error::StaleSnapshot
    );
    next.load().unwrap();
    next.commit(&successor, 2, &[put(0, 1, "a", "2")]).unwrap();
}
