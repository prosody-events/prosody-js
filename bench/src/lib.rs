//! Codec-boundary benchmark addon.
//!
//! Measures the real per-message unit of work in the JS binding: **Kafka wire
//! bytes in, usable JavaScript value out**. Two families are compared.
//!
//! - *Value* — what `prosody-js` ships today. `JsonCodec` parses the bytes into
//!   a `serde_json::Value` tree, `Message::from` deep-clones it, and napi walks
//!   the tree emitting one N-API call per node.
//! - *Binary* — what `prosody-cs` ships. `JsonBinaryCodec` copies the bytes
//!   verbatim and parses only the `id`/`type` metadata fields, then hands the
//!   bytes to JavaScript for `JSON.parse`.
//!
//! Every entry point takes the wire bytes as an argument and copies them into a
//! reusable scratch buffer, because both codecs consume their input
//! destructively (`simd_json` rewrites the buffer as a parse tape). That copy is
//! harness scaffolding charged identically to both families, so it cannot tilt
//! the comparison.
//!
//! The allocator is wrapped in a counter so each path can report **Rust-side
//! allocations per operation**. Note the asymmetry this cannot see: the binary
//! path moves object materialization into V8, whose allocations are invisible
//! here. Read the counters as "how much does Rust allocate", never as a total.

#![allow(unsafe_code, reason = "GlobalAlloc requires an unsafe impl")]

use std::alloc::{GlobalAlloc, Layout};
use std::cell::RefCell;
use std::sync::atomic::{AtomicU64, Ordering};

use napi::bindgen_prelude::Buffer;
use napi_derive::napi;
use prosody::codec::{Codec, JsonBinaryCodec, JsonCodec, serialize_to_json};
use serde_json::Value;

static ALLOC_COUNT: AtomicU64 = AtomicU64::new(0);
static ALLOC_BYTES: AtomicU64 = AtomicU64::new(0);

#[global_allocator]
static ALLOC: Counting<mimalloc::MiMalloc> = Counting(mimalloc::MiMalloc);

thread_local! {
    /// Destructive-parse scratch. Reused across calls so that, after warmup, it
    /// contributes no allocations of its own to either path's counters.
    static SCRATCH: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// Allocation-counting wrapper. Uses relaxed ordering: the counters are
/// read only between benchmark samples, never to synchronize anything.
struct Counting<A>(A);

unsafe impl<A: GlobalAlloc> GlobalAlloc for Counting<A> {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOC_COUNT.fetch_add(1, Ordering::Relaxed);
        ALLOC_BYTES.fetch_add(layout.size() as u64, Ordering::Relaxed);
        unsafe { self.0.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { self.0.dealloc(ptr, layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        ALLOC_COUNT.fetch_add(1, Ordering::Relaxed);
        ALLOC_BYTES.fetch_add(new_size as u64, Ordering::Relaxed);
        unsafe { self.0.realloc(ptr, layout, new_size) }
    }
}

/// Runs `f` over a fresh destructive-parse copy of `src`.
fn with_scratch<R>(src: &[u8], f: impl FnOnce(&mut [u8]) -> R) -> R {
    SCRATCH.with_borrow_mut(|scratch| {
        scratch.clear();
        scratch.extend_from_slice(src);
        f(scratch.as_mut_slice())
    })
}

fn to_napi_err<E: std::fmt::Display>(error: E) -> napi::Error {
    napi::Error::from_reason(error.to_string())
}

/// Current inbound path, faithful to what ships: parse to a `serde_json::Value`,
/// deep-clone it the way `Message::from(&ConsumerMessage<Value>)` does, then let
/// napi walk the clone into JavaScript.
#[napi(ts_return_type = "any")]
pub fn inbound_value_clone(wire: Buffer) -> napi::Result<Value> {
    with_scratch(&wire, |buf| {
        JsonCodec::with_cached_local(|codec| codec.deserialize(buf))
            .map(|value| value.clone())
            .map_err(to_napi_err)
    })
}

/// Current inbound path minus the deep clone. Isolates what removing the
/// `payload().clone()` in `message.rs` would buy on its own, with no codec
/// change at all.
#[napi(ts_return_type = "any")]
pub fn inbound_value_noclone(wire: Buffer) -> napi::Result<Value> {
    with_scratch(&wire, |buf| {
        JsonCodec::with_cached_local(|codec| codec.deserialize(buf)).map_err(to_napi_err)
    })
}

/// Proposed inbound path: verbatim byte copy plus the borrowed `id`/`type`
/// metadata parse, handed over as a zero-copy `Buffer` for JavaScript to
/// `JSON.parse`. The metadata parse is not optional — dedup and `allowed_events`
/// filtering need it, and the Value path gets it free off the parsed tree.
#[napi]
pub fn inbound_binary_buffer(wire: Buffer) -> napi::Result<Buffer> {
    with_scratch(&wire, |buf| {
        JsonBinaryCodec::with_cached_local(|codec| codec.deserialize(buf))
            .map(|payload| Buffer::from(payload.bytes))
            .map_err(to_napi_err)
    })
}

/// Proposed inbound path returning a JavaScript string instead of a `Buffer`,
/// so `JSON.parse` needs no `toString` step. Trades the decode in JS for a
/// UTF-8 validation in Rust.
#[napi]
pub fn inbound_binary_string(wire: Buffer) -> napi::Result<String> {
    with_scratch(&wire, |buf| {
        let payload = JsonBinaryCodec::with_cached_local(|codec| codec.deserialize(buf))
            .map_err(to_napi_err)?;
        String::from_utf8(payload.bytes).map_err(to_napi_err)
    })
}

/// Proposed inbound path where the handler never reads the body — the upper
/// bound on what a lazy `payload` getter saves. Returns only the extracted
/// event id, which is all dedup needs.
#[napi]
pub fn inbound_binary_meta(wire: Buffer) -> napi::Result<Option<String>> {
    use prosody::EventIdentity;

    with_scratch(&wire, |buf| {
        JsonBinaryCodec::with_cached_local(|codec| codec.deserialize(buf))
            .map(|payload| payload.event_id().map(ToOwned::to_owned))
            .map_err(to_napi_err)
    })
}

/// Current outbound path: napi walks the JavaScript object into a
/// `serde_json::Value`, then the JSON codec serializes it. Returns the encoded
/// length so the work cannot be optimized away.
#[napi]
pub fn outbound_value(payload: Value) -> napi::Result<u32> {
    let mut buf = Vec::new();
    if !serialize_to_json(&payload, &mut buf) {
        return Err(napi::Error::from_reason("serialization failed"));
    }
    Ok(buf.len() as u32)
}

/// Proposed outbound path: JavaScript has already run `JSON.stringify`, so the
/// bytes cross verbatim. Copies once into an owned buffer, matching what the
/// producer would hand the codec.
#[napi]
pub fn outbound_binary(payload: Buffer) -> napi::Result<u32> {
    let owned = payload.to_vec();
    Ok(owned.len() as u32)
}

/// Zeroes the allocation counters.
#[napi]
pub fn alloc_reset() {
    ALLOC_COUNT.store(0, Ordering::Relaxed);
    ALLOC_BYTES.store(0, Ordering::Relaxed);
}

/// Rust-side allocation count since the last [`alloc_reset`].
#[napi]
pub fn alloc_count() -> f64 {
    ALLOC_COUNT.load(Ordering::Relaxed) as f64
}

/// Rust-side allocated bytes since the last [`alloc_reset`].
#[napi]
pub fn alloc_bytes() -> f64 {
    ALLOC_BYTES.load(Ordering::Relaxed) as f64
}
