//! Provides a wrapper around `MessageContext` for use in Node.js bindings.
//!
//! This module defines the `Context` struct, which encapsulates a `MessageContext`
//! from the `prosody` crate and exposes its functionality to Node.js through NAPI.

use chrono::{DateTime, Utc};
use futures::TryStreamExt;
use napi::bindgen_prelude::Function;
use napi::threadsafe_function::ThreadsafeFunction;
use napi::{Error, Status};
use napi_derive::napi;
use opentelemetry::propagation::{TextMapCompositePropagator, TextMapPropagator};
use parking_lot::Mutex;
use prosody::consumer::event_context::BoxEventContext;
use prosody::timers::datetime::CompactDateTime;
use std::collections::HashMap;
use std::sync::Arc;
use tracing::{Instrument, error, info_span};
use tracing_opentelemetry::OpenTelemetrySpanExt;

/// Type alias for the abort callback threadsafe function.
type AbortCallback = ThreadsafeFunction<String, (), String, Status, false, false, 1>;

/// Wrapper around `MessageContext` for use in Node.js bindings.
#[napi]
#[derive(Clone)]
pub struct NativeContext {
  context: BoxEventContext,
  propagator: Arc<TextMapCompositePropagator>,
  abort_fn: Arc<Mutex<Option<AbortCallback>>>,
}

#[napi]
impl NativeContext {
  /// Creates a new `NativeContext` instance.
  ///
  /// # Arguments
  ///
  /// * `context` - The `BoxEventContext` to wrap.
  /// * `propagator` - The OpenTelemetry propagator to use for context extraction.
  pub fn new(context: BoxEventContext, propagator: Arc<TextMapCompositePropagator>) -> Self {
    Self {
      context,
      propagator,
      abort_fn: Arc::new(Mutex::new(None)),
    }
  }

  /// Registers an abort function to be called when shutdown occurs.
  ///
  /// @param abortFn - A function that takes a reason string and aborts an `AbortController`
  #[allow(clippy::needless_pass_by_value)]
  #[napi]
  pub fn register_abort(&self, abort_fn: Function<String, ()>) -> napi::Result<()> {
    *self.abort_fn.lock() = Some(
      abort_fn
        .build_threadsafe_function()
        .max_queue_size()
        .build()?,
    );

    Ok(())
  }

  /// Calls the registered abort function with the given reason.
  ///
  /// This is called internally by Rust when shutdown is detected.
  pub async fn abort(&self, reason: String) {
    let Some(abort_fn) = self.abort_fn.lock().take() else {
      return;
    };

    if let Err(error) = abort_fn.call_async(reason).await {
      error!("failed to call abort function: {error:#}");
    }
  }

  /// Checks whether a shutdown has been signaled.
  ///
  /// @returns True if shutdown was requested, otherwise false.
  #[napi(getter, writable = false)]
  pub fn should_shutdown(&self) -> bool {
    self.context.should_shutdown()
  }

  /// Waits for a shutdown signal.
  ///
  /// @returns A promise that resolves when shutdown is signaled.
  #[napi(writable = false)]
  pub async fn on_shutdown(&self) {
    self.context.on_shutdown().await;
  }

  /// Schedule a timer at the given time.
  ///
  /// @param time - The UTC timestamp to schedule.
  /// @param otelContext - The OpenTelemetry context for tracing
  /// @throws Error if time conversion or scheduling fails.
  #[napi(writable = false)]
  pub async fn schedule(
    &self,
    time: DateTime<Utc>,
    otel_context: HashMap<String, String>,
  ) -> napi::Result<()> {
    let context = self.propagator.extract(&otel_context);

    let time =
      CompactDateTime::try_from(time).map_err(|error| Error::from_reason(error.to_string()))?;

    let span = info_span!("schedule", %time);
    span.set_parent(context);

    self
      .context
      .schedule(time)
      .instrument(span)
      .await
      .map_err(|error| Error::from_reason(error.to_string()))
  }

  /// Clear existing timers and schedule a new one at the given time.
  ///
  /// @param time - The UTC timestamp to schedule.
  /// @param otelContext - The OpenTelemetry context for tracing
  /// @throws Error if time conversion or scheduling fails.
  #[napi(writable = false)]
  pub async fn clear_and_schedule(
    &self,
    time: DateTime<Utc>,
    otel_context: HashMap<String, String>,
  ) -> napi::Result<()> {
    let context = self.propagator.extract(&otel_context);

    let time =
      CompactDateTime::try_from(time).map_err(|error| Error::from_reason(error.to_string()))?;

    let span = info_span!("clearAndSchedule", %time);
    span.set_parent(context);

    self
      .context
      .clear_and_schedule(time)
      .instrument(span)
      .await
      .map_err(|error| Error::from_reason(error.to_string()))
  }

  /// Unschedules the timer for the specified time.
  /// @param time - The time to unschedule.
  /// @param otelContext - The OpenTelemetry context for tracing
  /// @throws Error if unscheduling fails.
  #[napi(writable = false)]
  pub async fn unschedule(
    &self,
    time: DateTime<Utc>,
    otel_context: HashMap<String, String>,
  ) -> napi::Result<()> {
    let context = self.propagator.extract(&otel_context);

    let time =
      CompactDateTime::try_from(time).map_err(|error| Error::from_reason(error.to_string()))?;

    let span = info_span!("unschedule", %time);
    span.set_parent(context);

    self
      .context
      .unschedule(time)
      .instrument(span)
      .await
      .map_err(|error| Error::from_reason(error.to_string()))
  }

  /// Clears all scheduled timers.
  /// @param otelContext - The OpenTelemetry context for tracing
  /// @throws Error if clearing schedules fails.
  #[napi(writable = false)]
  pub async fn clear_scheduled(&self, otel_context: HashMap<String, String>) -> napi::Result<()> {
    let context = self.propagator.extract(&otel_context);
    let span = info_span!("clearScheduled");
    span.set_parent(context);

    self
      .context
      .clear_scheduled()
      .instrument(span)
      .await
      .map_err(|error| Error::from_reason(error.to_string()))
  }

  /// Retrieves all scheduled times.
  /// @param otelContext - The OpenTelemetry context for tracing
  /// @returns An array of scheduled times as Date objects.
  /// @throws Error if retrieval fails.
  #[napi(writable = false)]
  pub async fn scheduled(
    &self,
    otel_context: HashMap<String, String>,
  ) -> napi::Result<Vec<DateTime<Utc>>> {
    let context = self.propagator.extract(&otel_context);
    let span = info_span!("scheduled");
    span.set_parent(context);

    self
      .context
      .scheduled()
      .map_ok(DateTime::<Utc>::from)
      .map_err(|error| Error::from_reason(error.to_string()))
      .try_collect()
      .instrument(span)
      .await
  }
}
