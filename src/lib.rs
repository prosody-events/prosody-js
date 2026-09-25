#![allow(clippy::multiple_crate_versions)]
#![recursion_limit = "256"]

//! This crate provides Node.js bindings for the Prosody library, offering a
//! high-level client for interacting with Kafka-like message brokers. It
//! includes functionality for administration, client operations, message
//! handling, and logging integration.
//!
//! The crate is organized into several modules, each responsible for a specific
//! aspect of the library's functionality:

use mimalloc::MiMalloc;
use napi::bindgen_prelude::create_custom_tokio_runtime;
use napi_derive::module_init;
use std::io::{self, Write};
use std::process;
use tokio::runtime::Builder;

/// Module for handling administrative operations on a Prosody cluster.
mod admin;

/// Module for managing client-side operations and interactions with the message
/// broker.
mod client;

/// Module for providing context-related functionality for message processing.
mod context;

/// Module containing event handlers and message processing logic.
mod handler;

/// Module for managing logging operations and integration with JavaScript
/// logging.
mod logging;
pub use logging::{flush_telemetry, shutdown_telemetry};

/// Module dealing with message-related functionality and structures.
mod message;

/// Module exposing read-only published keyed state.
mod published;

/// Module exposing keyed-state collections and scan cursors to JavaScript.
mod state;

/// Module dealing with timer-related functionality and structures.
mod timer;

#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

/// Stack size of each Tokio worker thread.
///
/// Core futures are large in debug builds. A timer write that polls through
/// the Cassandra driver overflows the Tokio default of 2 MiB.
const WORKER_STACK_SIZE: usize = 8 * 1024 * 1024;

/// Replace napi-rs's default Tokio runtime with one built with 8 MiB worker
/// stacks, before any async binding call can construct the default runtime.
#[module_init]
fn init() {
    let runtime = Builder::new_multi_thread()
        .enable_all()
        .thread_stack_size(WORKER_STACK_SIZE)
        .build();

    match runtime {
        Ok(runtime) => create_custom_tokio_runtime(runtime),
        Err(error) => {
            drop(writeln!(
                io::stderr().lock(),
                "failed to create Tokio runtime: {error:#}"
            ));
            process::abort();
        }
    }
}
