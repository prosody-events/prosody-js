//! Provides message processing and JavaScript interaction for the Prosody
//! consumer.
//!
//! This module defines the `JsHandler` struct, which bridges between Rust's
//! Prosody consumer and JavaScript event handlers. It enables asynchronous
//! message and timer processing through thread-safe function calls to
//! JavaScript.

use crate::context::NativeContext;
use crate::message::Message;
use crate::timer::Timer;
use napi::bindgen_prelude::{FromNapiValue, Function, Object, Promise};
use napi::sys::{napi_env, napi_value};
use napi::threadsafe_function::ThreadsafeFunction;
use napi::{Error, Status};
use napi_derive::napi;
use opentelemetry::propagation::{TextMapCompositePropagator, TextMapPropagator};
use prosody::consumer::event_context::EventContext;
use prosody::consumer::message::ConsumerMessage;
use prosody::consumer::middleware::FallibleHandler;
use prosody::consumer::{DemandType, Keyed};
use prosody::error::{ClassifyError, ErrorCategory};
use prosody::propagator::new_propagator;
use prosody::timers::{TimerType, Trigger};
use std::collections::HashMap;
use std::sync::Arc;
use thiserror::Error;
use tracing::{Instrument, debug, error};
use tracing_opentelemetry::OpenTelemetrySpanExt;

/// Type alias for message handler arguments.
#[napi]
pub type MessageHandlerArgs = (NativeContext, Message, HashMap<String, String>);

/// Type alias for timer handler arguments.
#[napi]
pub type TimerHandlerArgs = (NativeContext, Timer, HashMap<String, String>);

/// Type alias for error classification arguments.
#[napi]
pub type IsPermanentArgs = (Error,);

/// Maximum number of queued handler function calls.
pub const HANDLE_QUEUE_SIZE: usize = 64;

/// Maximum number of queued error classification function calls.
pub const PERM_QUEUE_SIZE: usize = 64;

/// Represents a native handler for processing messages and timers.
///
/// This struct contains functions that handle incoming messages, timer events,
/// and error classification for the Prosody consumer.
#[napi(object)]
pub struct NativeHandler<'a> {
    /// A function to be called when a message is received.
    ///
    /// @param context - A Context object representing the message processing
    /// context @param message - A Message object containing the received
    /// Kafka message @param otelContext - A record of string key-value
    /// pairs representing the OpenTelemetry context @returns A Promise that
    /// resolves when the message has been processed
    ///
    /// Note: Error parameter is automatically added by CalleeHandled=true
    pub on_message: Function<'a, MessageHandlerArgs, Promise<()>>,

    /// A function to be called when a timer fires.
    ///
    /// @param context - A Context object representing the timer processing
    /// context @param timer - A Timer object containing the timer details
    /// @param otelContext - A record of string key-value pairs representing the
    /// OpenTelemetry context @returns A Promise that resolves when the
    /// timer has been processed
    ///
    /// Note: Error parameter is automatically added by CalleeHandled=true
    pub on_timer: Function<'a, TimerHandlerArgs, Promise<()>>,

    /// Function that determines whether an error is permanent.
    ///
    /// @param err - An Error object to classify
    /// @returns A boolean that is true when the given error is permanent and
    /// false otherwise
    pub is_permanent: Function<'a, IsPermanentArgs, bool>,
}

/// Inner structure containing the `ThreadsafeFunction` instances for JavaScript
/// callbacks.
///
/// This struct holds thread-safe JavaScript functions that can be called from
/// any thread to handle messages, timers, and error classification. It also
/// contains an OpenTelemetry propagator for distributed tracing.
struct JsHandlerInner {
    on_message: ThreadsafeFunction<
        MessageHandlerArgs,
        Promise<()>,
        MessageHandlerArgs,
        Status,
        true,
        false,
        HANDLE_QUEUE_SIZE,
    >,
    on_timer: ThreadsafeFunction<
        TimerHandlerArgs,
        Promise<()>,
        TimerHandlerArgs,
        Status,
        true,
        false,
        HANDLE_QUEUE_SIZE,
    >,
    is_permanent: ThreadsafeFunction<
        IsPermanentArgs,
        bool,
        IsPermanentArgs,
        Status,
        false,
        false,
        PERM_QUEUE_SIZE,
    >,
    propagator: Arc<TextMapCompositePropagator>,
}

/// Handles the interaction between Rust and JavaScript for message processing.
///
/// This struct manages thread-safe JavaScript function calls for processing
/// Kafka messages and timer events. It implements the `FallibleHandler` trait
/// to integrate with the Prosody consumer framework.
pub struct JsHandler {
    inner: Arc<JsHandlerInner>,
}

impl Clone for JsHandler {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

impl JsHandler {
    /// Creates a new `JsHandler` instance.
    ///
    /// Builds thread-safe functions from the provided JavaScript callbacks
    /// and initializes an OpenTelemetry propagator for distributed tracing.
    ///
    /// # Arguments
    ///
    /// * `event_handler` - A reference to a `NativeHandler` containing the
    ///   JavaScript callbacks.
    ///
    /// # Errors
    ///
    /// Returns a `napi::Error` if thread-safe function creation fails.
    pub fn new(event_handler: &NativeHandler) -> napi::Result<Self> {
        let on_message = event_handler
            .on_message
            .build_threadsafe_function()
            .callee_handled()
            .max_queue_size()
            .build()?;

        let on_timer = event_handler
            .on_timer
            .build_threadsafe_function()
            .callee_handled()
            .max_queue_size()
            .build()?;

        let is_permanent = event_handler
            .is_permanent
            .build_threadsafe_function()
            .max_queue_size()
            .build()?;

        Ok(Self {
            inner: Arc::new(JsHandlerInner {
                on_message,
                on_timer,
                is_permanent,
                propagator: Arc::new(new_propagator()),
            }),
        })
    }

    /// Categorizes an error as permanent or transient by calling the JavaScript
    /// `is_permanent` function.
    ///
    /// This method allows JavaScript code to determine whether an error should
    /// trigger retries (transient) or be treated as unrecoverable
    /// (permanent).
    ///
    /// # Arguments
    ///
    /// * `error` - The error to categorize.
    ///
    /// # Returns
    ///
    /// A `JsHandlerError` indicating whether the error is permanent or
    /// transient.
    ///
    /// # Errors
    ///
    /// Returns a `napi::Result<JsHandlerError>` if the JavaScript function call
    /// fails.
    async fn categorize_error(&self, error: Error) -> napi::Result<JsHandlerError> {
        let is_permanent = self.inner.is_permanent.call_async((error,)).await?;
        Ok(if is_permanent {
            JsHandlerError::Permanent(Error::from_reason("Permanent error"))
        } else {
            JsHandlerError::Js(Error::from_reason("Transient error"))
        })
    }
}

impl FromNapiValue for JsHandler {
    // SAFETY: This implementation is safe because:
    // 1. We validate the input by calling JsObject::from_napi_value, which performs
    //    proper type checking and will return an error if the napi_value is not a
    //    valid JavaScript object
    // 2. The napi_env and napi_value parameters are guaranteed to be valid by the
    //    N-API runtime when this method is called through the NAPI-RS framework
    // 3. We only access object properties using safe NAPI-RS methods
    //    (get_named_property) which validate property existence and types
    // 4. The conversion to NativeHandler is temporary and only used to create the
    //    thread-safe JsHandler
    // 5. All JavaScript function references are immediately converted to
    //    ThreadsafeFunction objects which are safe to use across threads
    // 6. No raw pointers or memory are directly manipulated - all operations go
    //    through validated NAPI-RS APIs
    #[allow(unsafe_code)]
    unsafe fn from_napi_value(env: napi_env, napi_val: napi_value) -> napi::Result<Self> {
        let obj = Object::from_raw(env, napi_val);
        let on_message = obj
            .get("onMessage")?
            .ok_or_else(|| Error::from_reason("onMessage property missing"))?;

        let on_timer = obj
            .get("onTimer")?
            .ok_or_else(|| Error::from_reason("onTimer property missing"))?;

        let is_permanent = obj
            .get("isPermanent")?
            .ok_or_else(|| Error::from_reason("isPermanent property missing"))?;

        let native_handler = NativeHandler {
            on_message,
            on_timer,
            is_permanent,
        };

        Self::new(&native_handler)
    }
}

impl FallibleHandler for JsHandler {
    type Error = JsHandlerError;

    /// Processes a message by calling the JavaScript callback.
    ///
    /// Converts the Prosody message into JavaScript-compatible types,
    /// injects OpenTelemetry context for distributed tracing, and calls
    /// the JavaScript `onMessage` function asynchronously.
    ///
    /// # Arguments
    ///
    /// * `context` - The event context providing shutdown signaling and other
    ///   utilities.
    /// * `message` - The consumer message to process.
    /// * `_demand_type` - Whether this is normal processing or failure retry.
    ///
    /// # Errors
    ///
    /// Returns a `JsHandlerError` if the JavaScript callback execution fails
    /// or if error categorization fails.
    async fn on_message<C>(
        &self,
        context: C,
        message: ConsumerMessage,
        _demand_type: DemandType,
    ) -> Result<(), Self::Error>
    where
        C: EventContext,
    {
        let span = message.span();
        let native_context =
            NativeContext::new(context.boxed(), Arc::clone(&self.inner.propagator));
        let mut carrier = HashMap::with_capacity(2);

        self.inner
            .propagator
            .inject_context(&span.context(), &mut carrier);

        let message = Message {
            topic: message.topic().to_string(),
            partition: message.partition(),
            offset: message.offset(),
            timestamp: *message.timestamp(),
            key: message.key().to_string(),
            payload: message.payload().clone(),
        };

        debug!("processing message");

        let result = self
            .inner
            .on_message
            .call_async(Ok((native_context, message, carrier)))
            .instrument(span.clone())
            .await?
            .await;

        match result {
            Ok(()) => {
                debug!("message processed successfully");
                Ok(())
            }
            Err(error) => {
                error!(error = %error, "message handler error");
                Err(self.categorize_error(error).await?)
            }
        }
    }

    /// Processes a timer trigger by calling the JavaScript callback.
    ///
    /// Converts the Prosody timer trigger into JavaScript-compatible types,
    /// injects OpenTelemetry context for distributed tracing, and calls
    /// the JavaScript `onTimer` function asynchronously.
    ///
    /// # Arguments
    ///
    /// * `context` - The event context providing shutdown signaling and other
    ///   utilities.
    /// * `trigger` - The timer trigger to process.
    /// * `_demand_type` - Whether this is normal processing or failure retry.
    ///
    /// # Errors
    ///
    /// Returns a `JsHandlerError` if the JavaScript callback execution fails
    /// or if error categorization fails.
    async fn on_timer<C>(
        &self,
        context: C,
        trigger: Trigger,
        _demand_type: DemandType,
    ) -> Result<(), Self::Error>
    where
        C: EventContext,
    {
        // Only process application timers; internal timers are handled by middleware
        if trigger.timer_type != TimerType::Application {
            return Ok(());
        }

        let span = trigger.span();
        let mut carrier = HashMap::with_capacity(2);
        self.inner
            .propagator
            .inject_context(&span.context(), &mut carrier);

        let native_context =
            NativeContext::new(context.boxed(), Arc::clone(&self.inner.propagator));
        let timer: Timer = trigger.into();

        debug!("processing timer");

        let result = self
            .inner
            .on_timer
            .call_async(Ok((native_context, timer, carrier)))
            .instrument(span.clone())
            .await?
            .await;

        match result {
            Ok(()) => {
                debug!("timer processed successfully");
                Ok(())
            }
            Err(error) => {
                error!(error = %error, "timer handler error");
                Err(self.categorize_error(error).await?)
            }
        }
    }

    /// Shuts down the handler.
    ///
    /// This is a no-op for the JavaScript handler since resources are managed
    /// by the JavaScript runtime through garbage collection.
    async fn shutdown(self) {
        // No cleanup required - JavaScript handles resource cleanup via GC
    }
}

/// Represents errors that can occur during JavaScript handler execution.
///
/// This enum distinguishes between transient errors (which may be retried)
/// and permanent errors (which should not be retried) to support Prosody's
/// error handling and retry logic.
#[derive(Debug, Error)]
pub enum JsHandlerError {
    /// Wraps an `napi::Error` that occurred during JavaScript execution
    /// (transient).
    #[error(transparent)]
    Js(#[from] napi::Error),

    /// Wraps an `napi::Error` that is marked as permanent by JavaScript code.
    #[error(transparent)]
    Permanent(napi::Error),
}

impl ClassifyError for JsHandlerError {
    /// Classifies the error as transient or permanent for Prosody's retry
    /// logic.
    fn classify_error(&self) -> ErrorCategory {
        match self {
            JsHandlerError::Js(_) => ErrorCategory::Transient,
            JsHandlerError::Permanent(_) => ErrorCategory::Permanent,
        }
    }
}
