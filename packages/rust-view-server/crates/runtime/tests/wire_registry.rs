use product_source_ingestion::{registry::*, wire::*};
use rust_differential_product_core::{product::OptionalString, source::ProductMutation};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
struct Fixture {
    requests: Arc<AtomicUsize>,
}
impl Registry for Fixture {
    fn lookup(&self, id: u32) -> Result<Metadata, String> {
        self.requests.fetch_add(1, Ordering::SeqCst);
        Ok(Metadata {
            schema_type: "PROTOBUF".into(),
            schema: match id {
                1 => include_str!("../fixtures/key.proto"),
                2 => include_str!("../fixtures/product-v1.proto"),
                3 => include_str!("../fixtures/product-v2.proto"),
                4 => "syntax = \"proto3\"; message Product { string quantity = 3; }",
                _ => return Err("unknown schema ID".into()),
            }
            .into(),
            references: vec![],
        })
    }
}
fn fixture() -> CachedRegistry<Fixture> {
    CachedRegistry::new(
        Fixture {
            requests: Arc::new(AtomicUsize::new(0)),
        },
        4,
    )
    .unwrap()
}
fn key() -> Vec<u8> {
    frame(1, &ProductKey { id: "x".into() })
}
fn value() -> Product {
    Product {
        id: "x".into(),
        category: "c".into(),
        quantity: i64::MAX,
        amount: "9007199254740993.0100".into(),
        label: None,
    }
}
#[test]
fn exact_confluent_framing_including_index_array() {
    // Independently specified bytes: magic, big endian ID 258, optimized [0], protobuf id=x.
    let b = [0, 0, 0, 1, 2, 0, 10, 1, b'x'];
    let e = envelope(&b).unwrap();
    assert_eq!(e.schema_id, 258);
    assert_eq!(e.indexes, [0]);
    assert_eq!(e.payload, [10, 1, b'x']);
    let explicit = [0, 0, 0, 0, 1, 2, 0, 10, 1, b'x'];
    assert_eq!(envelope(&explicit).unwrap().indexes, [0]);
    assert_eq!(envelope(&explicit).unwrap().payload, [10, 1, b'x']);
    let nested = [0, 0, 0, 0, 1, 4, 2, 0, 10, 1, b'x'];
    assert_eq!(envelope(&nested).unwrap().indexes, [1, 0]);
    assert!(
        decode(&fixture(), 0, 0, Some(&nested), None)
            .unwrap_err()
            .contains("index path")
    );
    for length in 0..6 {
        assert!(envelope(&b[..length]).is_err());
    }
    for b in [
        vec![1, 0, 0, 0, 1, 0],
        vec![0, 0, 0, 0, 1, 2],
        vec![0, 0, 0, 0, 1, 1],
        vec![0, 0, 0, 0, 1, 34],
        vec![0, 0, 0, 0, 1, 128, 128, 128, 128, 16],
        vec![0, 0, 0, 0, 1, 2, 1],
    ] {
        assert!(envelope(&b).is_err(), "{b:?}");
    }
}
#[test]
fn exact_int64_decimal_tombstones_and_schema_evolution() {
    let r = fixture();
    let key = key();
    let bytes = frame(2, &value());
    let record = decode(&r, 1, 10, Some(&key), Some(&bytes)).unwrap();
    let ProductMutation::Upsert { row } = record.event.mutation else {
        panic!()
    };
    assert_eq!(
        serde_json::to_value(&row.quantity).unwrap(),
        "9223372036854775807"
    );
    assert_eq!(
        serde_json::to_value(&row.amount).unwrap(),
        serde_json::json!({"coefficient":"900719925474099301","scale":2})
    );
    assert_eq!(row.label, OptionalString::Missing);
    let mut evolved = value();
    evolved.label = Some("family".into());
    evolved.quantity = i64::MIN;
    let mut bytes = frame(3, &evolved);
    bytes.extend([0xa0, 6, 123]); // unknown field 100 varint
    let ProductMutation::Upsert { row } = decode(&r, 1, 11, Some(&key), Some(&bytes))
        .unwrap()
        .event
        .mutation
    else {
        panic!()
    };
    assert_eq!(row.label, OptionalString::Value("family".into()));
    assert_eq!(
        serde_json::to_value(&row.quantity).unwrap(),
        "-9223372036854775808"
    );
    assert!(matches!(
        decode(&r, 1, 12, Some(&key), None).unwrap().event.mutation,
        ProductMutation::Delete { .. }
    ));
    assert_eq!(r.requests(), 3); // key and two schema IDs, not per record
}
#[test]
fn malformed_unknown_wrong_type_and_incompatible_schemas_fail_closed() {
    let r = fixture();
    let k = key();
    for v in [
        frame(99, &value()),
        frame(1, &value()),
        frame(4, &value()),
        vec![0, 0, 0, 0, 2, 0, 0xff],
        vec![0, 0, 0, 0, 2, 0, 26, 1, 0],
    ] {
        assert!(decode(&r, 0, 0, Some(&k), Some(&v)).is_err());
    }
    assert!(decode(&r, 0, -1, Some(&k), None).is_err());
    assert!(decode(&r, 0, 0, None, None).is_err());
    assert!(decode(&r, 0, i64::MAX, Some(&k), None).is_err());
    let mut v = value();
    v.id = "different".into();
    assert!(decode(&r, 0, 0, Some(&k), Some(&frame(2, &v))).is_err());
    v.id = "x".into();
    v.amount = "NaN".into();
    assert!(decode(&r, 0, 0, Some(&k), Some(&frame(2, &v))).is_err());
}
#[test]
fn concurrent_lookup_coalescing_eviction_and_negative_cache() {
    let count = Arc::new(AtomicUsize::new(0));
    let r = Arc::new(
        CachedRegistry::new(
            Fixture {
                requests: count.clone(),
            },
            1,
        )
        .unwrap(),
    );
    let threads: Vec<_> = (0..12)
        .map(|_| {
            let r = r.clone();
            std::thread::spawn(move || r.lookup(2).unwrap())
        })
        .collect();
    for t in threads {
        t.join().unwrap();
    }
    assert_eq!(count.load(Ordering::SeqCst), 1);
    r.lookup(3).unwrap();
    r.lookup(2).unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 3);
    for _ in 0..20 {
        assert!(r.lookup(99).is_err());
    }
    assert_eq!(count.load(Ordering::SeqCst), 4);
    assert!(CachedRegistry::new(Fixture { requests: count }, 0).is_err());
}
#[test]
fn wire_identity_detects_changed_unknown_fields() {
    let r = fixture();
    let k = key();
    let v = frame(2, &value());
    let a = decode(&r, 0, 0, Some(&k), Some(&v)).unwrap();
    let mut changed = v;
    changed.extend([0xa0, 6, 1]);
    let b = decode(&r, 0, 0, Some(&k), Some(&changed)).unwrap();
    assert_eq!(a.event, b.event);
    assert_ne!(a.identity, b.identity);
}
#[test]
fn http_registry_real_loopback_framing_and_cache() {
    use std::{
        io::{Read, Write},
        net::TcpListener,
    };
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        let mut buffer = [0; 4096];
        let n = stream.read(&mut buffer).unwrap();
        assert!(
            std::str::from_utf8(&buffer[..n])
                .unwrap()
                .starts_with("GET /schemas/ids/2 ")
        );
        let body=serde_json::json!({"schemaType":"PROTOBUF","schema":include_str!("../fixtures/product-v1.proto")}).to_string();
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .unwrap();
    });
    let r = CachedRegistry::new(HttpRegistry::new(&url, None).unwrap(), 2).unwrap();
    r.lookup(2).unwrap();
    r.lookup(2).unwrap();
    server.join().unwrap();
    assert_eq!(r.requests(), 1);
    assert!(HttpRegistry::new("http://example.com/", None).is_err());
    assert!(HttpRegistry::new("https://secret@example.com/", None).is_err());
}
