use std::alloc::{Layout, alloc, dealloc};
use std::slice;

use crate::engine_contract::SelectedProductEngine as ProductCore;

const MAX_COMMAND_BYTES: usize = 1_048_576;

pub struct WasmCore {
    core: ProductCore,
    output: Vec<u8>,
    error: Vec<u8>,
}

impl WasmCore {
    fn new() -> Self {
        Self {
            core: ProductCore::new(),
            output: Vec::new(),
            error: Vec::new(),
        }
    }

    fn set_error(&mut self, error: impl ToString) {
        self.error = error.to_string().into_bytes();
    }
}

unsafe fn input_string<'a>(pointer: *const u8, length: usize) -> Result<&'a str, String> {
    if length > MAX_COMMAND_BYTES {
        return Err("input exceeds the 1 MiB command bound".into());
    }
    if pointer.is_null() && length != 0 {
        return Err("input pointer is null".into());
    }
    let bytes = if length == 0 {
        &[]
    } else {
        // SAFETY: caller provides a valid linear-memory span for this call.
        unsafe { slice::from_raw_parts(pointer, length) }
    };
    std::str::from_utf8(bytes).map_err(|error| format!("input is not UTF-8: {error}"))
}

#[unsafe(no_mangle)]
pub extern "C" fn product_core_new() -> *mut WasmCore {
    Box::into_raw(Box::new(WasmCore::new()))
}

#[unsafe(no_mangle)]
pub extern "C" fn product_core_alloc(length: usize) -> *mut u8 {
    if length == 0 || length > MAX_COMMAND_BYTES {
        return std::ptr::null_mut();
    }
    let Ok(layout) = Layout::array::<u8>(length) else {
        return std::ptr::null_mut();
    };
    // SAFETY: the returned block is paired with product_core_dealloc using the same length.
    unsafe { alloc(layout) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn product_core_dealloc(pointer: *mut u8, length: usize) {
    if !pointer.is_null() && length > 0 && length <= MAX_COMMAND_BYTES {
        if let Ok(layout) = Layout::array::<u8>(length) {
            // SAFETY: pointer came from product_core_alloc with this length.
            unsafe { dealloc(pointer, layout) };
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn product_core_apply(
    handle: *mut WasmCore,
    pointer: *const u8,
    length: usize,
) -> i32 {
    if handle.is_null() {
        return 2;
    }
    // SAFETY: handles are created by product_core_new and remain owned by the caller.
    let state = unsafe { &mut *handle };
    state.error.clear();
    let input = match unsafe { input_string(pointer, length) } {
        Ok(input) => input,
        Err(error) => {
            state.set_error(error);
            return 1;
        }
    };
    match state.core.apply_json(input) {
        Ok(()) => 0,
        Err(error) => {
            state.set_error(error);
            1
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn product_core_result(
    handle: *mut WasmCore,
    pointer: *const u8,
    length: usize,
) -> i32 {
    if handle.is_null() {
        return 2;
    }
    // SAFETY: handles are created by product_core_new and remain owned by the caller.
    let state = unsafe { &mut *handle };
    state.error.clear();
    let subscription = match unsafe { input_string(pointer, length) } {
        Ok(subscription) => subscription,
        Err(error) => {
            state.set_error(error);
            return 1;
        }
    };
    match state.core.result(subscription) {
        Some(result) => match serde_json::to_vec(&result) {
            Ok(output) => {
                state.core.record_result_encoded(result.rows.len());
                state.output = output;
                0
            }
            Err(error) => {
                state.set_error(format!("result serialization failed: {error}"));
                1
            }
        },
        None => {
            state.set_error(format!("subscription {subscription} is not open"));
            1
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn product_core_group_count_result(
    handle: *mut WasmCore,
    pointer: *const u8,
    length: usize,
) -> i32 {
    if handle.is_null() {
        return 2;
    }
    // SAFETY: handles are created by product_core_new and remain owned by the caller.
    let state = unsafe { &mut *handle };
    state.error.clear();
    let subscription = match unsafe { input_string(pointer, length) } {
        Ok(subscription) => subscription,
        Err(error) => {
            state.set_error(error);
            return 1;
        }
    };
    match state.core.grouped_count_by_category(subscription) {
        Some(result) => match serde_json::to_vec(&result) {
            Ok(output) => {
                state.output = output;
                0
            }
            Err(error) => {
                state.set_error(format!("group serialization failed: {error}"));
                1
            }
        },
        None => {
            state.set_error(format!("subscription {subscription} is not open"));
            1
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn product_core_stats(handle: *mut WasmCore) -> i32 {
    if handle.is_null() {
        return 2;
    }
    // SAFETY: handles are created by product_core_new and remain owned by the caller.
    let state = unsafe { &mut *handle };
    state.error.clear();
    match serde_json::to_vec(&state.core.stats()) {
        Ok(output) => {
            state.output = output;
            0
        }
        Err(error) => {
            state.set_error(format!("stats serialization failed: {error}"));
            1
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn product_core_dirty_ids(handle: *mut WasmCore) -> i32 {
    if handle.is_null() {
        return 2;
    }
    // SAFETY: handles are created by product_core_new and remain owned by the caller.
    let state = unsafe { &mut *handle };
    state.error.clear();
    match serde_json::to_vec(state.core.last_dirty_subscriptions()) {
        Ok(output) => {
            state.output = output;
            0
        }
        Err(error) => {
            state.set_error(format!("dirty subscription serialization failed: {error}"));
            1
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn product_core_output_ptr(handle: *mut WasmCore) -> *const u8 {
    if handle.is_null() {
        return std::ptr::null();
    }
    // SAFETY: handles are created by product_core_new and remain owned by the caller.
    unsafe { (*handle).output.as_ptr() }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn product_core_output_len(handle: *mut WasmCore) -> usize {
    if handle.is_null() {
        return 0;
    }
    // SAFETY: handles are created by product_core_new and remain owned by the caller.
    unsafe { (*handle).output.len() }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn product_core_error_ptr(handle: *mut WasmCore) -> *const u8 {
    if handle.is_null() {
        return std::ptr::null();
    }
    // SAFETY: handles are created by product_core_new and remain owned by the caller.
    unsafe { (*handle).error.as_ptr() }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn product_core_error_len(handle: *mut WasmCore) -> usize {
    if handle.is_null() {
        return 0;
    }
    // SAFETY: handles are created by product_core_new and remain owned by the caller.
    unsafe { (*handle).error.len() }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn product_core_free(handle: *mut WasmCore) {
    if !handle.is_null() {
        // SAFETY: this consumes the unique handle returned by product_core_new.
        drop(unsafe { Box::from_raw(handle) });
    }
}
