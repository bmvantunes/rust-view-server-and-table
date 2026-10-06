#[path = "support/durable.rs"]
mod support;
use product_source_ingestion::durable::*;
use std::{
    io::Write,
    process::{Command, Stdio},
    time::{Duration, Instant},
};
use support::*;

fn barrier(dir: &std::path::Path) -> ! {
    std::fs::write(dir.join("ready"), b"fault boundary reached").unwrap();
    loop {
        std::thread::park();
    }
}
#[test]
#[ignore = "subprocess fixture invoked by crash_matrix_sigkill; never run on a real source"]
fn crash_child() {
    let dir =
        std::path::PathBuf::from(std::env::var("V8_CRASH_DIRECTORY").expect("test fixture only"));
    let case = std::env::var("V8_CRASH_POINT").unwrap();
    let mut store = SqliteStore::open(dir.join("source.db"), identity()).unwrap();
    if case == "F" || case == "G" {
        let stop = if case == "F" {
            Point::DuringTransfer
        } else {
            Point::AfterFence
        };
        store
            .acquire_with_hook(0, "child", |p| {
                if p == stop {
                    barrier(&dir)
                }
                Ok(())
            })
            .unwrap();
        panic!("barrier missed");
    }
    let (token, _) = store.acquire(0, "child").unwrap();
    if ["A", "B", "C"].contains(&case.as_str()) {
        let stop = match case.as_str() {
            "A" => Point::BeforeTransaction,
            "B" => Point::BeforeCommit,
            _ => Point::AfterCommit,
        };
        store
            .commit_with_hook(&token, 1, &[put(0, 100, "a", "2")], |p| {
                if p == stop {
                    barrier(&dir)
                }
                Ok(())
            })
            .unwrap();
        panic!("barrier missed");
    }
    // D/E exercise the real durable coordinator and disposable evaluator before the broker boundary.
    let shared = session(store, "child-coordinator");
    let (lease, _) = shared.lock().unwrap().acquire(partition(0)).unwrap();
    let mut c = coordinator(shared);
    c.apply(&delivery(&lease, vec![put(0, 100, "a", "2")]))
        .unwrap();
    if case == "D" {
        barrier(&dir)
    }
    c.commit_offset(&lease, |next| {
        let mut f = std::fs::File::create(dir.join("broker-next")).unwrap();
        write!(f, "{next}").unwrap();
        f.sync_all().unwrap();
        Ok(())
    })
    .unwrap();
    barrier(&dir)
}
#[test]
fn crash_matrix_sigkill() {
    for case in ["A", "B", "C", "D", "E", "F", "G"] {
        let dir = Directory::new();
        let mut store = SqliteStore::create(dir.db(), identity()).unwrap();
        let (old, _) = store.acquire(0, "original").unwrap();
        store.commit(&old, 0, &[put(0, 99, "a", "1")]).unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "crash_child", "--nocapture"])
            .env("V8_CRASH_DIRECTORY", &dir.0)
            .env("V8_CRASH_POINT", case)
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        while !dir.0.join("ready").exists() {
            if let Some(status) = child.try_wait().unwrap() {
                panic!("child exited before {case}: {status}");
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("fault barrier timeout {case}");
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        child.kill().unwrap();
        let status = child.wait().unwrap();
        assert!(!status.success());
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            assert_eq!(status.signal(), Some(9));
        }
        let before = store.load().unwrap();
        let committed = ["C", "D", "E"].contains(&case);
        assert_eq!(
            before.snapshot.offsets[&0],
            if committed { 100 } else { 99 },
            "{case}"
        );
        if case == "E" {
            assert_eq!(
                std::fs::read_to_string(dir.0.join("broker-next")).unwrap(),
                "101"
            );
        } else {
            assert!(!dir.0.join("broker-next").exists());
        }
        if case == "G" {
            assert_eq!(
                store.commit(&old, 1, &[delete(0, 100, "a")]).unwrap_err(),
                Error::Fenced
            );
        }
        drop(store);
        let mut reopened = SqliteStore::open(dir.db(), identity()).unwrap();
        let (token, recovery) = reopened.acquire(0, "restarted").unwrap();
        assert_eq!(
            recovery_next(&identity(), &recovery, 0, 0, 103).unwrap(),
            if committed { 101 } else { 100 }
        );
        let replay = reopened
            .commit(
                &token,
                recovery.snapshot.last_source_batch,
                &[put(0, 100, "a", "2")],
            )
            .unwrap();
        assert_eq!(replay.batch.is_none(), committed, "{case}");
        assert_eq!(replay.after.sequence, 2);
        assert!(
            reopened
                .commit(&token, 2, &[put(0, 100, "a", "9")])
                .is_err()
        );
        reopened
            .commit(&token, 2, &[put(0, 101, "b", "3")])
            .unwrap();
        reopened.commit(&token, 3, &[delete(0, 102, "a")]).unwrap();
        let result = reopened.load().unwrap();
        assert_eq!(result.snapshot.rows.len(), 1);
        assert_eq!(result.snapshot.rows[0].id, "b");
        assert_eq!(result.snapshot.offsets[&0], 102);
        assert_eq!(result.snapshot.version, 4);
        assert_eq!(result.recent[&0].len(), 4);
        assert_eq!(reopened.authorize(&token, 4, Ok).unwrap(), 103);
        println!("SIGKILL {case}: exact final rows/offsets/version/replay verified");
    }
}
#[test]
fn transfer_and_revoke_wait_for_transaction_then_fence_staged_work() {
    use std::sync::mpsc;
    let dir = Directory::new();
    let mut store = SqliteStore::create(dir.db(), identity()).unwrap();
    let (old, _) = store.acquire(0, "A").unwrap();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let old2 = old.clone();
    let writer = std::thread::spawn(move || {
        store
            .commit_with_hook(&old2, 0, &[put(0, 0, "a", "1")], |p| {
                if p == Point::BeforeCommit {
                    entered_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                }
                Ok(())
            })
            .unwrap();
    });
    entered_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    // A WAL reader sees the previous whole prefix while a transaction is in progress.
    let mut reader = SqliteStore::open(dir.db(), identity()).unwrap();
    assert!(reader.load().unwrap().snapshot.rows.is_empty());
    let path = dir.db();
    let (attempt_tx, attempt_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();
    let transfer = std::thread::spawn(move || {
        let mut s = SqliteStore::open(path, identity()).unwrap();
        attempt_tx.send(()).unwrap();
        let (t, r) = s.acquire(0, "B").unwrap();
        done_tx.send((t, r)).unwrap();
    });
    attempt_rx.recv().unwrap();
    assert!(done_rx.try_recv().is_err());
    release_tx.send(()).unwrap();
    writer.join().unwrap();
    let (new, r) = done_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    transfer.join().unwrap();
    assert_eq!(r.snapshot.offsets[&0], 0);
    assert_eq!(
        reader.commit(&old, 1, &[delete(0, 1, "a")]).unwrap_err(),
        Error::Fenced
    );
    assert_eq!(reader.release(&old).unwrap_err(), Error::Fenced);
    reader.release(&new).unwrap();
    assert_eq!(
        reader.commit(&new, 1, &[delete(0, 1, "a")]).unwrap_err(),
        Error::Fenced
    );
    assert_eq!(reader.load().unwrap().snapshot.rows.len(), 1);
}
