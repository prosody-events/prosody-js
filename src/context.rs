//! Provides a wrapper around `MessageContext` for use in Node.js bindings.
//!
//! This module defines the `Context` struct, which encapsulates a
//! `MessageContext` from the `prosody` crate and exposes its functionality to
//! Node.js through NAPI.

use crate::state::{
    DequeStateVariant, MapStateVariant, NativeDequeState, NativeMapState, NativeValueState,
    ValueStateVariant, state_error,
};
use chrono::{DateTime, Utc};
use napi::Error;
use napi_derive::napi;
use opentelemetry::propagation::{TextMapCompositePropagator, TextMapPropagator};
use prosody::consumer::event_context::BoxEventContext;
use prosody::timers::TimerType;
use prosody::timers::datetime::CompactDateTime;
use std::collections::HashMap;
use std::sync::Arc;
use tracing::{Instrument, debug, info_span};
use tracing_opentelemetry::OpenTelemetrySpanExt;

/// Wrapper around `MessageContext` for use in Node.js bindings.
#[napi]
pub struct NativeContext {
    context: BoxEventContext<serde_json::Value>,
    propagator: Arc<TextMapCompositePropagator>,
}

#[napi]
impl NativeContext {
    /// Creates a new `NativeContext` instance.
    ///
    /// @param context The `BoxEventContext` to wrap.
    /// @param propagator The OpenTelemetry propagator to use for context
    ///   extraction.
    pub fn new(
        context: BoxEventContext<serde_json::Value>,
        propagator: Arc<TextMapCompositePropagator>,
    ) -> Self {
        Self {
            context,
            propagator,
        }
    }

    /// Checks whether cancellation has been signaled.
    ///
    /// Cancellation includes message-level cancellation (e.g., timeout) and
    /// partition shutdown. During shutdown, cancellation is delayed until near
    /// the end of the shutdown timeout to allow in-flight work to complete.
    ///
    /// @returns True if cancellation was requested, otherwise false.
    #[napi(getter, writable = false)]
    pub fn should_cancel(&self) -> bool {
        self.context.should_cancel()
    }

    /// Waits for a cancellation signal.
    ///
    /// Cancellation includes message-level cancellation (e.g., timeout) and
    /// partition shutdown. During shutdown, cancellation is delayed until near
    /// the end of the shutdown timeout to allow in-flight work to complete.
    ///
    /// @returns A promise that resolves when cancellation is signaled.
    #[napi(writable = false)]
    pub async fn on_cancel(&self) {
        self.context.on_cancel().await;
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

        let time = CompactDateTime::try_from(time)
            .map_err(|error| Error::from_reason(error.to_string()))?;

        let span = info_span!("schedule", %time);
        if let Err(err) = span.set_parent(context) {
            debug!("failed to set parent span: {err:#}");
        }

        self.context
            .schedule(time, TimerType::Application)
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

        let time = CompactDateTime::try_from(time)
            .map_err(|error| Error::from_reason(error.to_string()))?;

        let span = info_span!("clearAndSchedule", %time);
        if let Err(err) = span.set_parent(context) {
            debug!("failed to set parent span: {err:#}");
        }

        self.context
            .clear_and_schedule(time, TimerType::Application)
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

        let time = CompactDateTime::try_from(time)
            .map_err(|error| Error::from_reason(error.to_string()))?;

        let span = info_span!("unschedule", %time);
        if let Err(err) = span.set_parent(context) {
            debug!("failed to set parent span: {err:#}");
        }

        self.context
            .unschedule(time, TimerType::Application)
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
        if let Err(err) = span.set_parent(context) {
            debug!("failed to set parent span: {err:#}");
        }

        self.context
            .clear_scheduled(TimerType::Application)
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
        if let Err(err) = span.set_parent(context) {
            debug!("failed to set parent span: {err:#}");
        }

        self.context
            .scheduled(TimerType::Application)
            .instrument(span)
            .await
            .map(|times| times.into_iter().map(DateTime::<Utc>::from).collect())
            .map_err(|error| Error::from_reason(error.to_string()))
    }

    /// Vends the state handle for the named JSON value collection.
    ///
    /// Vending verifies the collection's registration (core-side); no span is
    /// opened here — vended handles outlive the call, and every operation opens
    /// its own span.
    ///
    /// @param name The registered collection name.
    /// @returns The value-state handle for this event's transaction.
    /// @throws Error (permanent) if the name is unregistered or its registered
    ///   identity mismatches.
    #[napi(writable = false)]
    pub fn value_state(&self, name: String) -> napi::Result<NativeValueState> {
        let handle = self
            .context
            .value_state(&name)
            .map_err(|e| state_error(&e))?;
        Ok(NativeValueState {
            state: ValueStateVariant::Json(handle),
            name,
            propagator: Arc::clone(&self.propagator),
        })
    }

    /// Vends the state handle for the named JSON map collection.
    ///
    /// Vending verifies the collection's registration (core-side); no span is
    /// opened here — vended handles outlive the call, and every operation opens
    /// its own span.
    ///
    /// @param name The registered collection name.
    /// @returns The map-state handle for this event's transaction.
    /// @throws Error (permanent) if the name is unregistered or its registered
    ///   identity mismatches.
    #[napi(writable = false)]
    pub fn map_state(&self, name: String) -> napi::Result<NativeMapState> {
        let handle = self.context.map_state(&name).map_err(|e| state_error(&e))?;
        Ok(NativeMapState {
            state: MapStateVariant::Json(handle),
            name,
            propagator: Arc::clone(&self.propagator),
        })
    }

    /// Vends the state handle for the named JSON deque collection.
    ///
    /// Vending verifies the collection's registration (core-side); no span is
    /// opened here — vended handles outlive the call, and every operation opens
    /// its own span.
    ///
    /// @param name The registered collection name.
    /// @returns The deque-state handle for this event's transaction.
    /// @throws Error (permanent) if the name is unregistered or its registered
    ///   identity mismatches.
    #[napi(writable = false)]
    pub fn deque_state(&self, name: String) -> napi::Result<NativeDequeState> {
        let handle = self
            .context
            .deque_state(&name)
            .map_err(|e| state_error(&e))?;
        Ok(NativeDequeState {
            state: DequeStateVariant::Json(handle),
            name,
            propagator: Arc::clone(&self.propagator),
        })
    }

    /// Vends the state handle for the named Kafka-message value collection.
    ///
    /// Items are the full `Message` the handler received, loader-resolved on
    /// read. Vending verifies registration (core-side); no span is opened here.
    ///
    /// @param name The registered collection name.
    /// @returns The message value-state handle for this event's transaction.
    /// @throws Error (permanent) if the name is unregistered or its registered
    ///   identity mismatches.
    #[napi(writable = false)]
    pub fn message_value_state(&self, name: String) -> napi::Result<NativeValueState> {
        let handle = self
            .context
            .message_value_state(&name)
            .map_err(|e| state_error(&e))?;
        Ok(NativeValueState {
            state: ValueStateVariant::Message(handle),
            name,
            propagator: Arc::clone(&self.propagator),
        })
    }

    /// Vends the state handle for the named Kafka-message map collection.
    ///
    /// Items are the full `Message` the handler received, loader-resolved on
    /// read. Vending verifies registration (core-side); no span is opened here.
    ///
    /// @param name The registered collection name.
    /// @returns The message map-state handle for this event's transaction.
    /// @throws Error (permanent) if the name is unregistered or its registered
    ///   identity mismatches.
    #[napi(writable = false)]
    pub fn message_map_state(&self, name: String) -> napi::Result<NativeMapState> {
        let handle = self
            .context
            .message_map_state(&name)
            .map_err(|e| state_error(&e))?;
        Ok(NativeMapState {
            state: MapStateVariant::Message(handle),
            name,
            propagator: Arc::clone(&self.propagator),
        })
    }

    /// Vends the state handle for the named Kafka-message deque collection.
    ///
    /// Items are the full `Message` the handler received, loader-resolved on
    /// read. Vending verifies registration (core-side); no span is opened here.
    ///
    /// @param name The registered collection name.
    /// @returns The message deque-state handle for this event's transaction.
    /// @throws Error (permanent) if the name is unregistered or its registered
    ///   identity mismatches.
    #[napi(writable = false)]
    pub fn message_deque_state(&self, name: String) -> napi::Result<NativeDequeState> {
        let handle = self
            .context
            .message_deque_state(&name)
            .map_err(|e| state_error(&e))?;
        Ok(NativeDequeState {
            state: DequeStateVariant::Message(handle),
            name,
            propagator: Arc::clone(&self.propagator),
        })
    }
}
