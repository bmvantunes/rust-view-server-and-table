//! Per-instance local binding of the production generic incremental engine.
//! No Kafka acknowledgement or native dependency health is implied by application.
use rust_differential_product_core::{
    generic::{Mutation, Query, Runtime},
    join::JoinDefinition,
    schema::{Catalog, Manifest, strict_json},
};
use serde::Deserialize;
use serde_json::{Value, json};

use std::collections::BTreeMap;
use rust_differential_product_core::typed_source::{SourceDefinition, TypedSource};
use rust_differential_product_core::retention::RetentionPolicy;
mod retained;
use retained::Retained;

const MAX_COMMAND_BYTES: usize = 4 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(tag = "command", rename_all = "snake_case", deny_unknown_fields)]
enum Command {
    Initialize { catalog: Manifest, max_rows: usize, #[serde(default)] sources: BTreeMap<String, SourceDefinition>, #[serde(default)] retention:BTreeMap<String,RetentionPolicy>, #[serde(default)] now_ms:u64 },
    AdvanceTime { milliseconds:u64 },
    Publish { topic: String, key: Value, value: Option<Value> },
    Apply { topic: String, schema: String, mutations: Vec<Mutation> },
    Open { subscription: String, topic: String, schema: String, query: Query, join: Option<JoinDefinition> },
    Read { subscription: String, offset: usize, limit: usize, max_bytes: usize },
    Close { subscription: String },
    Metrics,
}

#[derive(Default)]
pub struct LocalEngine { runtime: Option<Runtime>, sources: BTreeMap<String, TypedSource>, retention:BTreeMap<String,Retained>, now_ms:u64 }

impl LocalEngine {
    pub fn terminal(&self)->bool{self.runtime.as_ref().is_some_and(Runtime::terminal)}
    pub fn command(&mut self, bytes: &[u8]) -> Result<Value, String> {
        let value = strict_json(bytes, MAX_COMMAND_BYTES)?;
        let command: Command = serde_json::from_value(value).map_err(|e| e.to_string())?;
        if let Command::Initialize { catalog, max_rows, sources, retention, now_ms } = command {
            if self.runtime.is_some() { return Err("engine already initialized".into()); }
            if now_ms>9_007_199_254_740_991{return Err("clock safe integer bound".into());}
            let catalog = Catalog::new(catalog)?;
            let mut admitted = BTreeMap::new();
            let mut retained=BTreeMap::new();
            for (topic,policy) in retention {
                let source=sources.get(&topic).ok_or("retention requires configured source")?;
                let normalized=policy.normalize(source.identity.source_policy,max_rows)?;
                if let Some(age)=normalized.max_age_ms{rust_differential_product_core::retention::expiry_ms(now_ms,age)?;}
                retained.insert(topic,Retained::new(normalized));
            }
            for (topic, source) in sources {
                let schema = catalog.topics().find(|(name,_)|*name == topic).ok_or("source topic absent from catalog")?.1.clone();
                admitted.insert(topic,TypedSource::new(schema,source)?);
            }
            self.runtime = Some(Runtime::new(catalog, max_rows)?);
            self.sources = admitted;
            self.retention=retained;self.now_ms=now_ms;
            return Ok(json!({ "initialized": true }));
        }
        let runtime = self.runtime.as_mut().ok_or("engine not initialized")?;
        match command {
            Command::Publish { topic, key, value } => {
                let source = self.sources.get(&topic).ok_or("source metadata required")?;
                let mutation = source.admit(&key,value.as_ref())?;
                let fingerprint = runtime.catalog().topics().find(|(name,_)|*name == topic).ok_or("unknown source topic")?.1.fingerprint().to_owned();
                let id=match &mutation {Mutation::Delete{key}=>key.clone(),Mutation::Upsert{row}=>row["rowId"].as_str().ok_or("source rowId absent")?.to_owned()};
                let source_key=serde_json::to_string(&key).map_err(|e|e.to_string())?;
                let upsert=matches!(&mutation,Mutation::Upsert{..});
                let deleted=if upsert {self.retention.get(&topic).map(|r|r.prepare(&id,&source_key,self.now_ms)).transpose()?.unwrap_or_default()}else{vec![]};
                let mut mutations=deleted.iter().map(|key|Mutation::Delete{key:key.clone()}).collect::<Vec<_>>();mutations.push(mutation);
                let version = runtime.apply_committed(&topic,&fingerprint,&mutations)?;
                if let Some(retained)=self.retention.get_mut(&topic){for key in deleted{retained.remove(&key);}if upsert{retained.insert(id,source_key,self.now_ms);}else{retained.remove(&id);}}
                Ok(json!({ "applied_version": version.to_string() }))
            }
            Command::AdvanceTime {milliseconds} => {
                let now=self.now_ms.checked_add(milliseconds).ok_or("clock overflow")?;
                if now>9_007_199_254_740_991{return Err("clock safe integer bound".into());}
                let mut expired=0;
                for (topic,retained) in &mut self.retention {
                    let fingerprint=runtime.catalog().topics().find(|(name,_)|*name==topic).ok_or("unknown retention topic")?.1.fingerprint().to_owned();
                    loop {let due=retained.due(now);if due.is_empty(){break;}
                        runtime.apply_committed(topic,&fingerprint,&due.iter().map(|key|Mutation::Delete{key:key.clone()}).collect::<Vec<_>>())?;
                        expired+=due.len();for key in due{retained.remove(&key);}
                    }
                }
                self.now_ms=now;Ok(json!({"now_ms":now,"expired":expired}))
            }
            Command::Apply { topic, schema, mutations } => {
                if self.retention.contains_key(&topic){return Err("retained sources require typed publish".into());}
                let version = runtime.apply_committed(&topic, &schema, &mutations)?;
                Ok(json!({ "applied_version": version.to_string() }))
            }
            Command::Open { subscription, topic, schema, query, join } => {
                if let Some(join) = join {
                    runtime.open_join(&subscription, &topic, &schema, join, query)?;
                } else {
                    runtime.open(&subscription, &topic, &schema, query)?;
                }
                Ok(json!({ "opened": true }))
            }
            Command::Read { subscription, offset, limit, max_bytes } =>
                serde_json::to_value(runtime.read(&subscription, offset, limit, max_bytes)?).map_err(|e| e.to_string()),
            Command::Close { subscription } => { runtime.close(&subscription)?; Ok(json!({ "closed": true })) }
            Command::Metrics => Ok(runtime.metrics()),
            Command::Initialize { .. } => unreachable!(),
        }
    }
}

#[cfg(target_arch = "wasm32")]
mod abi;
