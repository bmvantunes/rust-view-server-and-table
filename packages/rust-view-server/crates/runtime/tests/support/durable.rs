#![allow(dead_code)]
use product_source_ingestion::{
    coordination::*,
    durable::{SourceIdentity, SqliteStore},
    durable_coordinator::*,
};
use rust_differential_product_core::{
    engine_contract::SelectedProductEngine, product::*, source::*, topic::RowId,
};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
pub fn identity() -> SourceIdentity {
    SourceIdentity {
        incarnation: "fixture-cluster/products-lifetime-1".into(),
        topic: "products".into(),
        schema: "product-v1".into(),
    }
}
pub struct Directory(pub PathBuf);
impl Directory {
    pub fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "v8-test-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    pub fn db(&self) -> PathBuf {
        self.0.join("source.db")
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
pub fn partition(p: u32) -> Partition {
    Partition {
        topic: "products".into(),
        partition: p,
    }
}
pub fn put(p: u32, offset: u64, id: &str, value: &str) -> Record {
    Record::new(SourceMutation {
        partition: p,
        offset,
        mutation: ProductMutation::Upsert {
            row: ProductRow {
                id: id.into(),
                category: if id.starts_with('a') {
                    "a".into()
                } else {
                    "b".into()
                },
                label: OptionalString::Value("nul\0 / percent% / 日本語".into()),
                quantity: ExactInteger::parse("9223372036854775807").unwrap(),
                amount: ExactDecimal::parse(value).unwrap(),
            },
        },
    })
}
pub fn delete(p: u32, offset: u64, id: &str) -> Record {
    Record::new(SourceMutation {
        partition: p,
        offset,
        mutation: ProductMutation::Delete {
            key: RowId(id.into()),
        },
    })
}
pub fn session(store: SqliteStore, owner: &str) -> SharedSession<SqliteStore> {
    Arc::new(Mutex::new(Session::new(
        store,
        owner.into(),
        Authority::default(),
    )))
}
pub fn coordinator(
    s: SharedSession<SqliteStore>,
) -> DurableCoordinator<SelectedProductEngine, SqliteStore> {
    DurableCoordinator::new(s).unwrap()
}
pub fn delivery(l: &Lease, records: Vec<Record>) -> Delivery {
    Delivery {
        lease: l.clone(),
        records,
    }
}
pub fn query() -> Query {
    Query {
        where_expr: Expr::True,
        direction: Direction::Ascending,
        offset: 0,
        limit: 100,
    }
}
