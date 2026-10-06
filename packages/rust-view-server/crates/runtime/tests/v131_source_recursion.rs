use prost::Message;
use product_source_ingestion::wire::ProductKey;
#[test]
fn existing_source_protobuf_recursion_boundary_is_preserved() {
    for depth in [0usize, 99, 100, 101, 120] {
        let mut bytes = vec![10, 1, b'a'];
        bytes.extend(vec![0x53; depth]); // Unknown field 10: start group.
        bytes.extend(vec![0x54; depth]); // Matching end group.
        let decoded = ProductKey::decode(bytes.as_slice());
        assert_eq!(decoded.is_ok(), depth <= 100, "source depth {depth}");
        if let Ok(key) = decoded { assert_eq!(key.id, "a"); }
    }
}
