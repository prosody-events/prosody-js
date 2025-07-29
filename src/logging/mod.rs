//! Logging module for Prosody-JS.
//!
//! This module provides functionality to initialize and manage logging in the Prosody-JS library.
//! It includes a swappable logger and JavaScript integration for logging.

use crate::logging::js::JsLogger;
use crate::logging::swappable::SwappableLogger;
use napi::Env;
use napi::bindgen_prelude::Function;
use napi_derive::napi;
use prosody::tracing::initialize_tracing;
use serde_json::Value;
use std::collections::HashMap;
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
pub struct Logger<'a> {
  /// Function for logging error messages.
  pub error: Function<'a, (String, Option<HashMap<String, Value>>), ()>,

  /// Function for logging warning messages.
  pub warn: Function<'a, (String, Option<HashMap<String, Value>>), ()>,

  /// Function for logging informational messages.
  pub info: Function<'a, (String, Option<HashMap<String, Value>>), ()>,

  /// Function for logging debug messages.
  pub debug: Function<'a, (String, Option<HashMap<String, Value>>), ()>,

  /// Function for logging trace messages.
  pub trace: Function<'a, (String, Option<HashMap<String, Value>>), ()>,
}

/**
 * Initializes the logging system with a JavaScript logger.
 *
 * @param env - The NAPI environment.
 * @param logger - The JavaScript logger to use.
 */
#[napi]
pub fn initialize(env: Env, logger: Logger) {
  // Only initialize once
  static INIT: Once = Once::new();

  INIT.call_once(|| {
    // Set up the JavaScript logger
    match JsLogger::new(logger) {
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
pub fn set_logger(logger: Logger) -> napi::Result<()> {
  LOGGER.set_logger(JsLogger::new(logger)?);
  Ok(())
}
