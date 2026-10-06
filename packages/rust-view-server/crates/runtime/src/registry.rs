//! Known generated message routing with dynamic schema IDs, not a runtime compiler.
use serde::Deserialize;
use std::{
    collections::{BTreeMap, VecDeque},
    io::Read,
    sync::Mutex,
    time::{Duration, Instant},
};
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MessageType {
    Key,
    ProductV1,
    ProductV2,
}
#[derive(Clone, Debug, Deserialize)]
pub struct Metadata {
    #[serde(rename = "schemaType")]
    pub schema_type: String,
    pub schema: String,
    #[serde(default)]
    pub references: Vec<serde_json::Value>,
}
impl Metadata {
    pub fn route(&self) -> Result<MessageType, String> {
        if self.schema_type != "PROTOBUF" || !self.references.is_empty() {
            return Err("unsupported schema type/references".into());
        }
        // Fail closed. Schema text is the validation authority, never just a subject/name.
        for (schema, kind) in [
            (include_str!("../fixtures/key.proto"), MessageType::Key),
            (
                include_str!("../fixtures/product-v1.proto"),
                MessageType::ProductV1,
            ),
            (
                include_str!("../fixtures/product-v2.proto"),
                MessageType::ProductV2,
            ),
        ] {
            if self.schema.trim() == schema.trim() {
                return Ok(kind);
            }
        }
        Err("schema incompatible with admitted generated message layouts".into())
    }
}
pub trait Registry: Send + Sync {
    fn lookup(&self, id: u32) -> Result<Metadata, String>;
}
struct CacheState {
    entries: BTreeMap<u32, (Instant, Result<Metadata, String>)>,
    order: VecDeque<u32>,
    requests: u64,
}
pub struct CachedRegistry<R> {
    inner: R,
    capacity: usize,
    state: Mutex<CacheState>,
}
impl<R: Registry> CachedRegistry<R> {
    pub fn new(inner: R, capacity: usize) -> Result<Self, String> {
        if capacity == 0 || capacity > 1024 {
            return Err("registry cache capacity must be 1..=1024".into());
        }
        Ok(Self {
            inner,
            capacity,
            state: Mutex::new(CacheState {
                entries: BTreeMap::new(),
                order: VecDeque::new(),
                requests: 0,
            }),
        })
    }
    pub fn requests(&self) -> u64 {
        self.state.lock().expect("registry cache poisoned").requests
    }
}
impl<R: Registry> Registry for CachedRegistry<R> {
    fn lookup(&self, id: u32) -> Result<Metadata, String> {
        // One bounded blocking lookup at a time coalesces concurrent misses (including errors).
        let mut s = self.state.lock().map_err(|_| "registry cache poisoned")?;
        if let Some((at, value)) = s.entries.get(&id)
            && (value.is_ok() || at.elapsed() < Duration::from_secs(1))
        {
            return value.clone();
        }
        s.entries.remove(&id);
        s.order.retain(|v| *v != id);
        s.requests += 1;
        let value = self.inner.lookup(id).and_then(|m| {
            m.route()?;
            Ok(m)
        });
        if s.entries.len() == self.capacity
            && let Some(old) = s.order.pop_front()
        {
            s.entries.remove(&old);
        }
        s.order.push_back(id);
        s.entries.insert(id, (Instant::now(), value.clone()));
        value
    }
}
pub struct HttpRegistry {
    base: reqwest::Url,
    client: reqwest::blocking::Client,
    credentials: Option<(String, String)>,
}
impl HttpRegistry {
    pub fn new(url: &str, credentials: Option<(String, String)>) -> Result<Self, String> {
        let mut base = reqwest::Url::parse(url).map_err(|_| "invalid registry URL")?;
        let local = matches!(base.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        if (base.scheme() != "https" && !(base.scheme() == "http" && local))
            || base.password().is_some()
            || !base.username().is_empty()
            || base.query().is_some()
            || base.fragment().is_some()
        {
            return Err(
                "Registry requires HTTPS (HTTP only on loopback), credentials supplied separately"
                    .into(),
            );
        }
        // Configuration denotes a directory/root, including a percent-encoded prefix.
        // Adding an empty path segment preserves existing encoding; set_path would re-encode it.
        if !base.path().ends_with('/') {
            base.path_segments_mut()
                .map_err(|_| "Registry URL cannot be a base")?
                .push("");
        }
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "Registry client setup failed")?;
        Ok(Self {
            base,
            client,
            credentials,
        })
    }
}
impl Registry for HttpRegistry {
    fn lookup(&self, id: u32) -> Result<Metadata, String> {
        let url = self
            .base
            .join(&format!("schemas/ids/{id}"))
            .map_err(|_| "Registry URL failed")?;
        let mut request = self.client.get(url);
        if let Some((user, password)) = &self.credentials {
            request = request.basic_auth(user, Some(password));
        }
        let response = request
            .send()
            .map_err(|_| "Registry transport failed (5 second timeout; no automatic retry)")?;
        if !response.status().is_success() {
            return Err(format!(
                "Registry HTTP status {} for schema {id}",
                response.status().as_u16()
            ));
        }
        let mut bytes = Vec::new();
        response
            .take(262145)
            .read_to_end(&mut bytes)
            .map_err(|_| "Registry body read failed")?;
        if bytes.len() > 262144 {
            return Err("Registry metadata exceeds 256 KiB".into());
        }
        let document: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|_| "invalid Registry metadata")?;
        // The ID endpoint normally omits id. If supplied, it must match the requested identity.
        if document
            .get("id")
            .is_some_and(|value| value.as_u64() != Some(id as u64))
        {
            return Err("Registry returned wrong schema identity".into());
        }
        serde_json::from_value(document).map_err(|_| "invalid Registry metadata".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn registry_root_normalization_preserves_encoded_prefix() {
        for (base, expected) in [
            ("https://host", "https://host/schemas/ids/42"),
            ("https://host/", "https://host/schemas/ids/42"),
            ("https://host/prefix/", "https://host/prefix/schemas/ids/42"),
            ("https://host/prefix", "https://host/prefix/schemas/ids/42"),
            (
                "https://host/a%2Fb%20c",
                "https://host/a%2Fb%20c/schemas/ids/42",
            ),
        ] {
            assert_eq!(
                HttpRegistry::new(base, None)
                    .unwrap()
                    .base
                    .join("schemas/ids/42")
                    .unwrap()
                    .as_str(),
                expected
            );
        }
        for base in ["https://host/prefix?q=x", "https://host/prefix#fragment"] {
            assert!(HttpRegistry::new(base, None).is_err());
        }
    }
    struct Unavailable;
    impl Registry for Unavailable {
        fn lookup(&self, _: u32) -> Result<Metadata, String> {
            Err("unavailable".into())
        }
    }
    #[test]
    fn negative_cache_expires_without_failure_spin() {
        let cache = CachedRegistry::new(Unavailable, 2).unwrap();
        assert!(cache.lookup(1).is_err());
        assert!(cache.lookup(1).is_err());
        assert_eq!(cache.requests(), 1);
        cache.state.lock().unwrap().entries.get_mut(&1).unwrap().0 =
            Instant::now() - Duration::from_secs(2);
        assert!(cache.lookup(1).is_err());
        assert_eq!(cache.requests(), 2);
    }
}
