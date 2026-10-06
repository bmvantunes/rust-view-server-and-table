//! Confluent protobuf envelope -> schema identity -> lookup -> decode -> typed mapping.
use crate::{
    coordination::Record,
    registry::{MessageType, Registry},
};
use prost::Message;
use rust_differential_product_core::{
    product::{ExactDecimal, ExactInteger, OptionalString, ProductRow},
    source::{ProductMutation, SourceMutation},
    topic::RowId,
};
use sha2::{Digest, Sha256};
pub const MAX_WIRE_BYTES: usize = 1024 * 1024;
#[derive(Clone, PartialEq, Message)]
pub struct ProductKey {
    #[prost(string, tag = "1")]
    pub id: String,
}
/// Static layout from the checked-in .proto fixtures; no protoc runtime dependency.
#[derive(Clone, PartialEq, Message)]
pub struct Product {
    #[prost(string, tag = "1")]
    pub id: String,
    #[prost(string, tag = "2")]
    pub category: String,
    #[prost(int64, tag = "3")]
    pub quantity: i64,
    #[prost(string, tag = "4")]
    pub amount: String,
    #[prost(string, optional, tag = "5")]
    pub label: Option<String>,
}
#[derive(Debug, PartialEq)]
pub struct Envelope<'a> {
    pub schema_id: u32,
    pub indexes: Vec<u32>,
    pub payload: &'a [u8],
}
fn zigzag(input: &[u8], cursor: &mut usize) -> Result<u32, String> {
    let mut value = 0u32;
    for shift in (0..35).step_by(7) {
        let b = *input.get(*cursor).ok_or("truncated message index")?;
        *cursor += 1;
        if shift == 28 && b > 15 {
            return Err("message index overflow".into());
        }
        value |= ((b & 127) as u32) << shift;
        if b & 128 == 0 {
            if value & 1 != 0 {
                return Err("negative message index/count".into());
            }
            return Ok(value >> 1);
        }
    }
    Err("invalid message index varint".into())
}
pub fn envelope(input: &[u8]) -> Result<Envelope<'_>, String> {
    if input.len() < 6 || input.len() > MAX_WIRE_BYTES || input[0] != 0 {
        return Err("invalid magic, truncated or oversized Confluent envelope".into());
    }
    let schema_id = u32::from_be_bytes(input[1..5].try_into().expect("length checked"));
    let mut cursor = 5;
    let count = zigzag(input, &mut cursor)?;
    let indexes = if count == 0 {
        vec![0]
    } else {
        if count > 16 {
            return Err("message index depth exceeds 16".into());
        }
        let mut path = Vec::new();
        for _ in 0..count {
            path.push(zigzag(input, &mut cursor)?)
        }
        path
    };
    Ok(Envelope {
        schema_id,
        indexes,
        payload: &input[cursor..],
    })
}
fn framed<'a>(bytes: &'a [u8], registry: &impl Registry, key: bool) -> Result<&'a [u8], String> {
    let e = envelope(bytes)?;
    if e.indexes != [0] {
        return Err("wrong message index path; only top-level [0] admitted".into());
    }
    let kind = registry.lookup(e.schema_id)?.route()?;
    if key != (kind == MessageType::Key) {
        return Err("wrong protobuf message type".into());
    }
    Ok(e.payload)
}
pub fn decode(
    registry: &impl Registry,
    partition: u32,
    offset: i64,
    key: Option<&[u8]>,
    value: Option<&[u8]>,
) -> Result<Record, String> {
    if offset < 0 || offset == i64::MAX {
        return Err("invalid Kafka offset".into());
    }
    let key_bytes = key.ok_or("missing canonical Kafka key")?;
    let key = ProductKey::decode(framed(key_bytes, registry, true)?)
        .map_err(|_| "protobuf key decode failure")?;
    if key.id.is_empty() || key.id.len() > 512 {
        return Err("invalid product key".into());
    }
    let mutation = match value {
        None => ProductMutation::Delete { key: RowId(key.id) },
        Some(bytes) => {
            let product = Product::decode(framed(bytes, registry, false)?)
                .map_err(|_| "protobuf value decode failure")?;
            if product.id != key.id
                || product.category.len() > 256
                || product.label.as_ref().is_some_and(|s| s.len() > 4096)
            {
                return Err("invalid product row or key/value mismatch".into());
            }
            ProductMutation::Upsert {
                row: ProductRow {
                    id: product.id,
                    category: product.category,
                    label: product
                        .label
                        .map(OptionalString::Value)
                        .unwrap_or(OptionalString::Missing),
                    quantity: ExactInteger::parse(product.quantity.to_string())?,
                    amount: ExactDecimal::parse(&product.amount)?,
                },
            }
        }
    };
    // Wire identity catches changed schema IDs and unknown protobuf fields too.
    let mut hash = Sha256::new();
    hash.update((key_bytes.len() as u64).to_be_bytes());
    hash.update(key_bytes);
    hash.update([u8::from(value.is_some())]);
    if let Some(v) = value {
        hash.update(v)
    }
    Ok(Record {
        event: SourceMutation {
            partition,
            offset: offset as u64,
            mutation,
        },
        identity: hash.finalize().into(),
    })
}
pub fn frame(schema: u32, message: &impl Message) -> Vec<u8> {
    let mut b = vec![0];
    b.extend(schema.to_be_bytes());
    b.push(0);
    message.encode(&mut b).expect("Vec encoding");
    b
}
