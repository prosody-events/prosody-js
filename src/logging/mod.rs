//! Logging module for Prosody-JS.
//!
//! This module provides functionality to initialize and manage logging in the Prosody-JS library.
//! It includes a swappable logger and JavaScript integration for logging.

use crate::logging::js::JsLogger;
use crate::logging::swappable::SwappableLogger;
use napi::{Env, JsFunction};
use napi_derive::napi;
use prosody::tracing::initialize_tracing;
use std::sync::LazyLock;

pub mod js;
pub mod swappable;

/// Global swappable logger instance.
static LOGGER: LazyLock<SwappableLogger> = LazyLock::new(SwappableLogger::default);

/// JavaScript-compatible logger structure.
#[napi(object)]
pub struct Logger {
  /// Function for logging error messages.
  #[napi(ts_type = "(message: string, metadata?: Record<string, any>) => void")]
  pub error: JsFunction,

  /// Function for logging warning messages.
  #[napi(ts_type = "(message: string, metadata?: Record<string, any>) => void")]
  pub warn: JsFunction,

  /// Function for logging informational messages.
  #[napi(ts_type = "(message: string, metadata?: Record<string, any>) => void")]
  pub info: JsFunction,

  /// Function for logging debug messages.
  #[napi(ts_type = "(message: string, metadata?: Record<string, any>) => void")]
  pub debug: JsFunction,

  /// Function for logging trace messages.
  #[napi(ts_type = "(message: string, metadata?: Record<string, any>) => void")]
  pub trace: JsFunction,
}

/// Initializes the logging system with a JavaScript logger.
///
/// # Arguments
///
/// * `env` - The Node-API environment.
/// * `logger` - The JavaScript logger to use.
///
/// # Errors
///
/// Returns an error if the logger initialization or tracing setup fails.
#[napi]
pub fn initialize(mut env: Env, logger: Logger) -> napi::Result<()> {
  // Set up the JavaScript logger
  LOGGER.set_logger(JsLogger::new(env, logger)?);

  // Initialize tracing with the global logger
  initialize_tracing(Some(LOGGER.clone())).map_err(|e| napi::Error::from_reason(e.to_string()))?;

  // Add a cleanup hook to clear the logger when the environment is destroyed
  env.add_env_cleanup_hook((), |()| {
    LOGGER.clear_logger();
  })?;

  Ok(())
}

/// Sets a new JavaScript logger.
///
/// # Arguments
///
/// * `env` - The Node-API environment.
/// * `logger` - The new JavaScript logger to set.
///
/// # Errors
///
/// Returns an error if creating the new JavaScript logger fails.
#[napi]
pub fn set_logger(env: Env, logger: Logger) -> napi::Result<()> {
  LOGGER.set_logger(JsLogger::new(env, logger)?);
  Ok(())
}
