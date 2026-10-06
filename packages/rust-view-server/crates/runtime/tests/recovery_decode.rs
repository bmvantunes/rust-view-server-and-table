#[path = "support/durable.rs"]
mod support;
use product_source_ingestion::{durable::*, registry::*, wire::*};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use support::*;
struct Intermittent(Arc<AtomicBool>);
impl Registry for Intermittent {
    fn lookup(&self, id: u32) -> Result<Metadata, String> {
        if self.0.load(Ordering::SeqCst) {
            return Err("temporarily unavailable".into());
        }
        Ok(Metadata {
            schema_type: "PROTOBUF".into(),
            schema: match id {
                1 => include_str!("../fixtures/key.proto"),
                2 => include_str!("../fixtures/product-v1.proto"),
                3 => "incompatible protobuf schema",
                4 => include_str!("../fixtures/key.proto"),
                _ => return Err("not cached".into()),
            }
            .into(),
            references: vec![],
        })
    }
}
#[test]
fn recovery_decode_failures_never_advance_durable_position() {
    let dir = Directory::new();
    let mut store = SqliteStore::create(dir.db(), identity()).unwrap();
    let (t, _) = store.acquire(0, "A").unwrap();
    let unavailable = Arc::new(AtomicBool::new(false));
    let cache = CachedRegistry::new(Intermittent(unavailable.clone()), 8).unwrap();
    let key = frame(1, &ProductKey { id: "a".into() });
    let value = Product {
        id: "a".into(),
        category: "a".into(),
        quantity: i64::MAX,
        amount: "9007199254740993.001".into(),
        label: None,
    };
    let bytes = frame(2, &value);
    let record = decode(&cache, 0, 100, Some(&key), Some(&bytes)).unwrap();
    store.commit(&t, 0, &[record]).unwrap();
    drop(store);
    let mut store = SqliteStore::open(dir.db(), identity()).unwrap();
    let (t, prior) = store.acquire(0, "B").unwrap();
    unavailable.store(true, Ordering::SeqCst);
    // A retained positive cache entry remains usable while the Registry is unavailable.
    let record = decode(&cache, 0, 100, Some(&key), Some(&bytes)).unwrap();
    assert!(store.commit(&t, 1, &[record]).unwrap().batch.is_none());
    let fresh = CachedRegistry::new(Intermittent(unavailable.clone()), 8).unwrap();
    assert!(decode(&fresh, 0, 101, Some(&key), Some(&bytes)).is_err());
    assert!(decode(&cache, 0, 101, Some(&key), Some(&frame(99, &value))).is_err());
    unavailable.store(false, Ordering::SeqCst);
    for payload in [
        frame(3, &value),
        frame(4, &value),
        vec![0, 0, 0, 0, 2, 0, 255],
    ] {
        assert!(decode(&cache, 0, 101, Some(&key), Some(&payload)).is_err());
        assert_eq!(store.load().unwrap().snapshot, prior.snapshot);
    }
    let recovered = CachedRegistry::new(Intermittent(unavailable), 8).unwrap();
    let record = decode(&recovered, 0, 101, Some(&key), Some(&bytes)).unwrap();
    store.commit(&t, 1, &[record]).unwrap();
    assert_eq!(store.load().unwrap().snapshot.offsets[&0], 101);
}
#[test]
fn http_registry_rejects_wrong_response_id_and_preserves_prefix() {
    use std::{
        io::{Read, Write},
        net::TcpListener,
    };
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let worker = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        let mut bytes = [0; 4096];
        let n = socket.read(&mut bytes).unwrap();
        let request = String::from_utf8_lossy(&bytes[..n]);
        assert!(
            request.starts_with("GET /a%2Fb/schemas/ids/1 "),
            "{request}"
        );
        let body=serde_json::json!({"id":2,"schemaType":"PROTOBUF","schema":include_str!("../fixtures/key.proto")}).to_string();
        write!(
            socket,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .unwrap();
    });
    let registry = HttpRegistry::new(&format!("http://{addr}/a%2Fb"), None).unwrap();
    assert!(
        registry
            .lookup(1)
            .unwrap_err()
            .contains("wrong schema identity")
    );
    worker.join().unwrap();
}
