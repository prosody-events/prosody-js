//! Logging module for Prosody-JS.
//!
//! This module provides functionality to initialize and manage logging in the Prosody-JS library.
//! It includes a swappable logger and JavaScript integration for logging.

use crate::logging::js::JsLogger;
use crate::logging::swappable::SwappableLogger;
use napi::Env;
use napi::bindgen_prelude::Function;
use napi::bindgen_prelude::within_runtime_if_available;
use napi_derive::napi;
use prosody::tracing::initialize_tracing;
use serde_json::Value;
use std::sync::{LazyLock, Once};
use tracing::error;

pub mod js;
pub mod swappable;

/// Type alias for the arguments passed to JavaScript logging functions.
#[napi]
pub type LogArgs = (Option<String>, Value);

/// Global swappable logger instance.
static LOGGER: LazyLock<SwappableLogger> = LazyLock::new(SwappableLogger::default);

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
/// This function sets up the tracing infrastructure and prepares the logging system
/// to accept JavaScript loggers. It should be called once during application startup
/// before any other logging operations.
#[allow(clippy::needless_pass_by_value)]
#[napi]
pub fn initialize(env: Env) {
  // Only initialize once
  static INIT: Once = Once::new();

  INIT.call_once(|| {
    // Initialize tracing with the global logger
    if let Err(error) = within_runtime_if_available(|| initialize_tracing(Some(LOGGER.clone()))) {
      error!("failed to initialize tracing: {error:#}");
    }

    // Add a cleanup hook to shutdown the logger when the environment is destroyed
    if let Err(error) = env.add_env_cleanup_hook((), |()| {
      LOGGER.shutdown_logger();
    }) {
      error!("failed to attach environment cleanup hook: {error:#}");
    }
  });
}

/// Checks if a logger has been set in the logging system.
///
/// @returns True if a logger is currently configured, false otherwise.
#[napi]
pub fn logger_is_set() -> bool {
  LOGGER.is_set()
}

/// Sets a new JavaScript logger for the Prosody client.
///
/// This function configures the logging system to use the provided JavaScript logger
/// for all log output. The logger must implement all required log levels.
///
/// @param logger - The JavaScript logger object with error, warn, info, debug, and trace methods.
/// @throws Error if creating the new JavaScript logger fails.
#[allow(clippy::needless_pass_by_value)]
#[napi]
pub fn set_logger(logger: Logger) -> napi::Result<()> {
  LOGGER.set_logger(JsLogger::new(&logger)?);
  Ok(())
}

/// Sets a JavaScript logger only if no logger is currently configured.
///
/// This function is useful for providing a default logger without overriding
/// an existing one that may have been set earlier.
///
/// @param logger - The JavaScript logger object with error, warn, info, debug, and trace methods.
/// @returns True if the logger was set (no previous logger existed), false if a logger was already configured.
/// @throws Error if creating the new JavaScript logger fails.
#[allow(clippy::needless_pass_by_value)]
#[napi]
pub fn set_logger_if_unset(logger: Logger) -> napi::Result<bool> {
  Ok(LOGGER.set_logger_if_unset(JsLogger::new(&logger)?))
}

/// Internal function to shut down the current logger and clean up all resources.
///
/// This function should be called when the Node.js process is shutting down
/// to ensure `ThreadsafeFunction` instances are properly cleaned up and prevent
/// potential memory leaks or hanging processes.
///
/// Note: This function is not exposed to JavaScript as it's handled internally
/// by the environment cleanup hook.
#[allow(dead_code)]
fn shutdown_logger() {
  LOGGER.shutdown_logger();
}
