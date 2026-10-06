//! Product request admission. No codec, evaluator instance, transport or lifetime state.
//! The browser and server use the SAME existing product Deserialize implementations.
use rust_differential_product_core::product::ProductCommand;
use serde_json::{Value, json};

pub const SOURCE_FRAME_BYTES: usize = 65536;
const SAFE: u64 = 9_007_199_254_740_991;

pub fn admit_projection(value: Option<&Value>) -> Result<Vec<String>, String> {
    let fields = match value {
        None => vec!["id", "category", "label", "quantity", "amount"].into_iter().map(String::from).collect(),
        Some(v) => serde_json::from_value::<Vec<String>>(v.clone()).map_err(|_| "projection fields")?,
    };
    if fields.is_empty() || fields.len() > 5 || fields.iter().any(|f| !["id","category","label","quantity","amount"].contains(&f.as_str())) || fields.iter().collect::<std::collections::BTreeSet<_>>().len() != fields.len() {
        return Err("invalid product projection".into());
    }
    Ok(fields)
}

pub fn admit_command(value: Value) -> Result<ProductCommand, String> {
    let command: ProductCommand = serde_json::from_value(value).map_err(|e| e.to_string())?;
    let (offset, limit) = match &command {
        ProductCommand::Open { query, .. } | ProductCommand::ChangeQuery { query, .. } =>
            (query.offset, 0),
        ProductCommand::ChangeWindow { offset, limit, .. } => (*offset, *limit),
        ProductCommand::Close { .. } => return Ok(command),
        // Typed source mutations are preserved for the owner to reject in order,
        // exactly as on JSON. Admission never executes them.
        _ => return Ok(command),
    };
    // Existing remote owner bounds, independent of WASM's 32-bit address space.
    if offset > SAFE || limit > 1024 {
        return Err("window resource limit; use viewport <=1024".into());
    }
    Ok(command)
}

/// JSON is a local WASM ABI only. The returned value is encoded as binary on the socket.
/// Preserve the old full-envelope JSON parser's byte and recursion limits before typing.
pub fn check_source_envelope(value: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    if bytes.len() > SOURCE_FRAME_BYTES { return Err("source frame budget".into()); }
    // Retain the existing full-envelope recursion capability for direct binary clients too.
    serde_json::from_slice::<Value>(&bytes).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn admit_envelope(bytes: &[u8]) -> Result<Value, String> {
    if bytes.len() > SOURCE_FRAME_BYTES { return Err("source frame budget".into()); }
    let mut envelope: Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    let raw = &envelope["request"];
    match admit_projection(raw.get("projection")).and_then(|_| admit_command(raw["command"].clone())) {
        Ok(command) => {
            // Do NOT simplify Expr: query structural identity affects public generations.
            let mut canonical = serde_json::to_value(command).map_err(|e| e.to_string())?;
            // The local JS ABI must not round u64 query limits through Number. Existing
            // open/change_query accepts a large requested limit when the actual result fits.
            // This canonical u64 decimal is ONLY an ABI value; both codecs emit magnitude bytes.
            if canonical["query"].is_object() {
                canonical["query"]["limit"] = Value::String(canonical["query"]["limit"].as_u64().unwrap().to_string());
            } else if canonical["command"] == "change_window" {
                canonical["limit"] = Value::String(canonical["limit"].as_u64().unwrap().to_string());
            }
            envelope["request"]["command"] = canonical;
        }
        Err(_) => {
            // A server-visible ordered no-op rejection; never roll back locally.
            // No invalid source value, spelling, or arbitrary client error text crosses the wire.
            let id = raw["id"].as_u64().filter(|id| *id <= SAFE).ok_or("request identity")?;
            let trace = raw["traceparent"].as_str().filter(|s| s.len() == 55).ok_or("trace identity")?;
            let sub = raw["command"]["subscription"].as_str().filter(|s| s.len() <= 128).ok_or("subscription identity")?;
            envelope["request"] = json!({"id":id,"traceparent":trace,"subscription":sub,"code":"invalid_query"});
            envelope["type"] = json!("command_rejected");
        }
    }
    Ok(envelope)
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::*;
    pub struct Output(Vec<u8>);
    #[unsafe(no_mangle)]
    pub extern "C" fn admission_alloc(n: usize) -> *mut u8 {
        if n == 0 || n > SOURCE_FRAME_BYTES { return std::ptr::null_mut(); }
        Box::into_raw(vec![0u8; n].into_boxed_slice()) as *mut u8
    }
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn admission_dealloc(p: *mut u8, n: usize) {
        if !p.is_null() && n > 0 && n <= SOURCE_FRAME_BYTES {
            unsafe { drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(p,n))); }
        }
    }
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn admission_run(p: *const u8, n: usize) -> *mut Output {
        if p.is_null() || n == 0 || n > SOURCE_FRAME_BYTES { return std::ptr::null_mut(); }
        let result = match admit_envelope(unsafe { std::slice::from_raw_parts(p,n) }) {
            Ok(value) => json!({"value":value}), Err(error) => json!({"terminal":error}),
        };
        Box::into_raw(Box::new(Output(serde_json::to_vec(&result).unwrap())))
    }
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn admission_ptr(p: *const Output) -> *const u8 { unsafe { (*p).0.as_ptr() } }
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn admission_len(p: *const Output) -> usize { unsafe { (*p).0.len() } }
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn admission_free(p: *mut Output) { if !p.is_null() { unsafe { drop(Box::from_raw(p)); } } }
}
