//! Logging module for Prosody-JS.
//!
//! This module provides functionality to initialize and manage logging in the Prosody-JS library.
//! It includes a swappable logger and JavaScript integration for logging.

use crate::logging::js::JsLogger;
use crate::logging::swappable::SwappableLogger;
use napi::{Env, JsFunction};
use napi_derive::napi;
use prosody::tracing::initialize_tracing;
use std::sync::{LazyLock, Once};
use tracing::error;

pub mod js;
pub mod swappable;

/// Global swappable logger instance.
static LOGGER: LazyLock<SwappableLogger> = LazyLock::new(SwappableLogger::default);

/**
 * JavaScript-compatible logger structure.
 */
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

/**
 * Initializes the logging system with a JavaScript logger.
 *
 * @param logger - The JavaScript logger to use.
 */
#[napi]
pub fn initialize(mut env: Env, logger: Logger) {
  // Only initialize once
  static INIT: Once = Once::new();

  INIT.call_once(|| {
    // Set up the JavaScript logger
    match JsLogger::new(env, logger) {
      Ok(logger) => LOGGER.set_logger(logger),
      Err(error) => {
        error!("failed to initialize logger: {error:#}");
      }
    }

    // Initialize tracing with the global logger
    if let Err(error) = initialize_tracing(Some(LOGGER.clone())) {
      error!("failed to initialize tracing: {error:#}");
    }

    // Add a cleanup hook to clear the logger when the environment is destroyed
    if let Err(error) = env.add_env_cleanup_hook((), |()| {
      LOGGER.clear_logger();
    }) {
      error!("failed to attach environment cleanup hook: {error:#}");
    }
  });
}

/**
 * Sets a new JavaScript logger.
 *
 * @param logger - The new JavaScript logger to set.
 * @throws Error if creating the new JavaScript logger fails.
 */
#[napi]
pub fn set_logger(env: Env, logger: Logger) -> napi::Result<()> {
  LOGGER.set_logger(JsLogger::new(env, logger)?);
  Ok(())
}
