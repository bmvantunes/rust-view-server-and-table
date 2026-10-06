//! Handles and output belong exclusively to the calling WebAssembly.Instance.
use super::{LocalEngine, MAX_COMMAND_BYTES};
use std::alloc::{Layout, alloc, dealloc};
use serde_json::json;

pub struct Handle { engine: LocalEngine, output: Vec<u8> }
#[unsafe(no_mangle)]
pub extern "C" fn view_engine_new() -> *mut Handle {
    Box::into_raw(Box::new(Handle { engine: LocalEngine::default(), output: Vec::new() }))
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn view_engine_free(handle: *mut Handle) {
    if !handle.is_null() { unsafe { drop(Box::from_raw(handle)); } }
}
#[unsafe(no_mangle)]
pub extern "C" fn view_engine_alloc(length: usize) -> *mut u8 {
    if length == 0 || length > MAX_COMMAND_BYTES { return std::ptr::null_mut(); }
    let Ok(layout) = Layout::array::<u8>(length) else { return std::ptr::null_mut(); };
    unsafe { alloc(layout) }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn view_engine_dealloc(pointer: *mut u8, length: usize) {
    if !pointer.is_null() && length > 0 && length <= MAX_COMMAND_BYTES {
        if let Ok(layout) = Layout::array::<u8>(length) { unsafe { dealloc(pointer, layout); } }
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn view_engine_command(handle: *mut Handle, pointer: *const u8, length: usize) -> i32 {
    if handle.is_null() || pointer.is_null() || length == 0 || length > MAX_COMMAND_BYTES { return 2; }
    let handle = unsafe { &mut *handle };
    let bytes = unsafe { std::slice::from_raw_parts(pointer, length) };
    let (status, output) = match handle.engine.command(bytes) {
        Ok(value) => (0, json!({ "value": value })),
        Err(error) => (if handle.engine.terminal(){3}else{1}, json!({ "error": error })),
    };
    handle.output = serde_json::to_vec(&output).expect("JSON envelope is serializable");
    status
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn view_engine_output_ptr(handle: *const Handle) -> *const u8 {
    if handle.is_null() { return std::ptr::null(); }
    unsafe { (*handle).output.as_ptr() }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn view_engine_output_len(handle: *const Handle) -> usize {
    if handle.is_null() { return 0; }
    unsafe { (*handle).output.len() }
}
