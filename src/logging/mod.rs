//! Logging module for Prosody-JS.
//!
//! This module provides functionality to initialize and manage logging in the
//! Prosody-JS library. It includes a swappable logger and JavaScript
//! integration for logging.

use crate::logging::js::JsLogger;
use crate::logging::swappable::SwappableLogger;
use napi::bindgen_prelude::Function;
use napi::bindgen_prelude::within_runtime_if_available;
use napi::{Env, Error};
use napi_derive::napi;
use prosody::tracing::{
    flush_telemetry as core_flush_telemetry, initialize_tracing,
    shutdown_telemetry as core_shutdown_telemetry,
};
use serde_json::Value;
use std::sync::{LazyLock, Once};
use tracing::error;

pub mod js;
pub mod swappable;

/// Global swappable logger instance.
static LOGGER: LazyLock<SwappableLogger> = LazyLock::new(SwappableLogger::default);

/// Type alias for the arguments passed to JavaScript logging functions.
#[napi]
pub type LogArgs = (Option<String>, Value);

/// JavaScript-compatible logger structure.
#[napi(object)]
pub struct Logger<'a> {
    /// Function for logging error messages.
    pub error: Function<'a, LogArgs, ()>,

    /// Function for logging warning messages.
    pub warn: Function<'a, LogArgs, ()>,

    /// Function for logging informational messages.
    pub info: Function<'a, LogArgs, ()>,

    /// Function for logging debug messages.
    pub debug: Function<'a, LogArgs, ()>,

    /// Function for logging trace messages.
    pub trace: Function<'a, LogArgs, ()>,
}

/// Initializes the logging system for the Prosody client.
///
/// This function sets up the tracing infrastructure and prepares the logging
/// system to accept JavaScript loggers. It should be called once during
/// application startup before any other logging operations.
#[napi]
pub fn initialize(env: Env) {
    // Only initialize once
    static INIT: Once = Once::new();

    INIT.call_once(|| {
        // Initialize tracing with the global logger
        if let Err(error) = within_runtime_if_available(|| initialize_tracing(Some(LOGGER.clone())))
        {
            error!("failed to initialize tracing: {error:#}");
        }

        // Add a cleanup hook to flush telemetry and shut down the logger when
        // the environment is destroyed.
        if let Err(error) = env.add_env_cleanup_hook((), |()| {
            // Telemetry is process-global, while Node can destroy one worker
            // environment before its siblings. Flush here without shutting
            // down their shared export pipeline.
            if let Err(error) = core_flush_telemetry() {
                error!("failed to flush telemetry: {error:#}");
            }
            LOGGER.shutdown_logger();
        }) {
            error!("failed to attach environment cleanup hook: {error:#}");
        }
    });
}

/// Exports all pending telemetry data.
///
/// # Errors
///
/// Returns an error if an exporter cannot flush its pending data.
#[napi]
pub fn flush_telemetry() -> napi::Result<()> {
    core_flush_telemetry().map_err(|error| Error::from_reason(error.to_string()))
}

/// Stops the global telemetry providers after they export pending data.
///
/// Call this function only when the Node.js process no longer needs telemetry.
///
/// # Errors
///
/// Returns an error if a provider cannot stop.
#[napi]
pub fn shutdown_telemetry() -> napi::Result<()> {
    core_shutdown_telemetry().map_err(|error| Error::from_reason(error.to_string()))
}

/// Sets a new JavaScript logger for the Prosody client.
///
/// This function configures the logging system to use the provided JavaScript
/// logger for all log output. The logger must implement all required log
/// levels.
///
/// @param logger - The JavaScript logger object with error, warn, info, debug,
/// and trace methods.
///
/// # Errors
///
/// Returns an error if the thread-safe logger functions cannot be created.
// napi passes the logger by value and copies this attribute onto its
// generated callback, where `expect` would be unfulfilled.
#[allow(clippy::needless_pass_by_value)]
#[napi]
pub fn set_logger(logger: Logger) -> napi::Result<()> {
    LOGGER.set_logger(JsLogger::new(&logger)?);
    Ok(())
}
