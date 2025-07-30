//! JavaScript logging integration for the prosody library.
//!
//! This module provides a bridge between Rust's tracing system and JavaScript logging functions.

use crate::logging::{LogArgs, Logger};
use napi::Status;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use serde_json::{Map, Value};
use std::error::Error;
use std::fmt::Debug;
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Metadata, Subscriber};
use tracing_subscriber::Layer;
use tracing_subscriber::layer::Context;

/// Maximum number of log entries that can be queued before blocking.
const LOG_QUEUE_SIZE: usize = 128;

/// Type alias for a thread-safe JavaScript logging function.
type LogFunction = ThreadsafeFunction<LogArgs, (), LogArgs, Status, false, true, LOG_QUEUE_SIZE>;

/// A logger that bridges Rust's tracing system with JavaScript logging functions.
pub struct JsLogger {
  error: LogFunction,
  warn: LogFunction,
  info: LogFunction,
  debug: LogFunction,
  trace: LogFunction,
}

impl JsLogger {
  /// Creates a new `JsLogger` instance.
  ///
  /// # Arguments
  ///
  /// * `logger` - A `Logger` instance containing JavaScript logging functions.
  ///
  /// # Errors
  ///
  /// Returns an error if creating thread-safe functions fails.
  pub fn new(logger: &Logger) -> napi::Result<Self> {
    // Create thread-safe functions for each log level
    // Try to create them as weak references to prevent keeping the process alive
    let error = logger
      .error
      .build_threadsafe_function()
      .weak()
      .max_queue_size()
      .build()?;

    let warn = logger
      .warn
      .build_threadsafe_function()
      .weak()
      .max_queue_size()
      .build()?;

    let info = logger
      .info
      .build_threadsafe_function()
      .weak()
      .max_queue_size()
      .build()?;

    let debug = logger
      .debug
      .build_threadsafe_function()
      .weak()
      .max_queue_size()
      .build()?;

    let trace = logger
      .trace
      .build_threadsafe_function()
      .weak()
      .max_queue_size()
      .build()?;

    Ok(Self {
      error,
      warn,
      info,
      debug,
      trace,
    })
  }
}

impl<S: Subscriber> Layer<S> for JsLogger {
  fn on_event(&self, event: &Event, _ctx: Context<S>) {
    // Select the appropriate logging function based on the event level
    let function = match *event.metadata().level() {
      Level::ERROR => &self.error,
      Level::WARN => &self.warn,
      Level::INFO => &self.info,
      Level::DEBUG => &self.debug,
      Level::TRACE => &self.trace,
    };

    // Collect event metadata and fields
    let mut visitor = MetadataVisitor::new(event.metadata());
    event.record(&mut visitor);

    // Call the JavaScript logging function asynchronously
    let message = visitor.maybe_message;
    let metadata = if visitor.values.is_empty() {
      None
    } else {
      Some(visitor.values.into_iter().collect())
    }
    .unwrap_or_default();

    function.call((message, metadata), ThreadsafeFunctionCallMode::NonBlocking);
  }
}

/// A visitor that collects metadata and fields from tracing events.
struct MetadataVisitor {
  maybe_message: Option<String>,
  values: Map<String, Value>,
}

impl MetadataVisitor {
  /// Creates a new `MetadataVisitor` instance.
  ///
  /// # Arguments
  ///
  /// * `metadata` - The tracing event metadata.
  fn new(metadata: &'static Metadata<'static>) -> Self {
    let mut values = Map::with_capacity(3);

    // Add standard metadata fields
    values.insert("module".into(), metadata.module_path().into());
    values.insert("line".into(), metadata.line().into());

    Self {
      maybe_message: None,
      values,
    }
  }
}

impl Visit for MetadataVisitor {
  fn record_f64(&mut self, field: &Field, value: f64) {
    self.values.insert(field.name().into(), value.into());
  }

  fn record_i64(&mut self, field: &Field, value: i64) {
    self.values.insert(field.name().into(), value.into());
  }

  fn record_u64(&mut self, field: &Field, value: u64) {
    self.values.insert(field.name().into(), value.into());
  }

  fn record_i128(&mut self, field: &Field, value: i128) {
    self
      .values
      .insert(field.name().into(), value.to_string().into());
  }

  fn record_u128(&mut self, field: &Field, value: u128) {
    self
      .values
      .insert(field.name().into(), value.to_string().into());
  }

  fn record_bool(&mut self, field: &Field, value: bool) {
    self.values.insert(field.name().into(), value.into());
  }

  fn record_str(&mut self, field: &Field, value: &str) {
    self.values.insert(field.name().into(), value.into());
  }

  fn record_error(&mut self, field: &Field, value: &(dyn Error + 'static)) {
    self
      .values
      .insert(field.name().into(), format!("{value:#}").into());
  }

  fn record_debug(&mut self, field: &Field, value: &dyn Debug) {
    if field.name() == "message" {
      self.maybe_message = Some(format!("{value:?}"));
    } else {
      self
        .values
        .insert(field.name().into(), format!("{value:?}").into());
    }
  }
}
