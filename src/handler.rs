//! This module handles message processing and JavaScript interaction for the Prosody consumer.

use crate::context::Context;
use crate::message::Message;
use crate::timer::Timer;
use napi::Error;
use napi::bindgen_prelude::{FromNapiValue, Function, Object, Promise};
use napi::threadsafe_function::ThreadsafeFunction;
use napi_derive::napi;
use opentelemetry::propagation::{TextMapCompositePropagator, TextMapPropagator};
use prosody::consumer::event_context::EventContext;
use prosody::consumer::failure::{ClassifyError, ErrorCategory, FallibleHandler};
use prosody::consumer::message::ConsumerMessage;
use prosody::propagator::new_propagator;
use prosody::timers::Trigger;
use std::collections::HashMap;
use std::sync::Arc;
use thiserror::Error;
use tracing_opentelemetry::OpenTelemetrySpanExt;

/**
 * Represents a native handler for processing messages.
 */
#[napi(object)]
pub struct NativeHandler<'a> {
  /**
   * A function to be called when a message is received.
   *
   * @param context - A Context object representing the message processing context
   * @param message - A Message object containing the received Kafka message
   * @param otelContext - A record of string key-value pairs representing the OpenTelemetry context
   * @returns A Promise that resolves when the message has been processed
   *
   * Note: Error parameter is automatically added by CalleeHandled=true
   */
  pub on_message: Function<'a, (Context, Message, HashMap<String, String>), Promise<()>>,

  /**
   * A function to be called when a timer fires.
   *
   * @param context - A Context object representing the timer processing context
   * @param timer - A Timer object containing the timer details
   * @param otelContext - A record of string key-value pairs representing the OpenTelemetry context
   * @returns A Promise that resolves when the timer has been processed
   *
   * Note: Error parameter is automatically added by CalleeHandled=true
   */
  pub on_timer: Function<'a, (Context, Timer, HashMap<String, String>), Promise<()>>,

  /**
   * Function that determines whether an error is permanent.
   *
   * @param err - An Error object to classify
   * @returns A boolean that is true when the given error is permanent and false otherwise
   */
  pub is_permanent: Function<'a, (Error,), bool>,
}

/// Inner structure containing the `ThreadsafeFunction` instances.
struct JsHandlerInner {
  on_message: ThreadsafeFunction<(Context, Message, HashMap<String, String>), Promise<()>>,
  on_timer: ThreadsafeFunction<(Context, Timer, HashMap<String, String>), Promise<()>>,
  is_permanent: ThreadsafeFunction<(Error,), bool>,
  propagator: TextMapCompositePropagator,
}

/// Handles the interaction between Rust and JavaScript for message processing.
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
  /// # Arguments
  ///
  /// * `event_handler` - A reference to a `NativeHandler` containing the JavaScript callback.
  ///
  /// # Errors
  ///
  /// Returns a `napi::Error` if the threadsafe function creation fails.
  pub fn new(event_handler: &NativeHandler) -> napi::Result<Self> {
    let on_message = event_handler
      .on_message
      .build_threadsafe_function()
      .callee_handled::<true>()
      .build()?;

    let on_timer = event_handler
      .on_timer
      .build_threadsafe_function()
      .callee_handled::<true>()
      .build()?;

    let is_permanent = event_handler
      .is_permanent
      .build_threadsafe_function()
      .callee_handled::<true>()
      .build()?;

    Ok(Self {
      inner: Arc::new(JsHandlerInner {
        on_message,
        on_timer,
        is_permanent,
        propagator: new_propagator(),
      }),
    })
  }

  /// Categorizes an error as permanent or transient by calling the JavaScript `is_permanent` function.
  ///
  /// # Arguments
  ///
  /// * `error` - The error to categorize.
  /// 
  /// # Returns
  ///
  /// A `JsHandlerError` indicating whether the error is permanent or transient.
  async fn categorize_error(&self, error: Error) -> napi::Result<JsHandlerError> {
    let is_permanent = self.inner.is_permanent.call_async(Ok((error,))).await?;
    Ok(if is_permanent {
      JsHandlerError::Permanent(Error::from_reason("Permanent error"))
    } else {
      JsHandlerError::Js(Error::from_reason("Transient error"))
    })
  }
}

impl FromNapiValue for JsHandler {
  // SAFETY: This implementation is safe because:
  // 1. We validate the input by calling JsObject::from_napi_value, which performs proper type checking
  //    and will return an error if the napi_value is not a valid JavaScript object
  // 2. The napi_env and napi_value parameters are guaranteed to be valid by the N-API runtime when
  //    this method is called through the NAPI-RS framework
  // 3. We only access object properties using safe NAPI-RS methods (get_named_property) which
  //    validate property existence and types
  // 4. The conversion to NativeHandler is temporary and only used to create the thread-safe JsHandler
  // 5. All JavaScript function references are immediately converted to ThreadsafeFunction objects
  //    which are safe to use across threads
  // 6. No raw pointers or memory are directly manipulated - all operations go through validated NAPI-RS APIs
  #[allow(unsafe_code)]
  unsafe fn from_napi_value(
    env: napi::sys::napi_env,
    napi_val: napi::sys::napi_value,
  ) -> napi::Result<Self> {
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
  /// # Arguments
  ///
  /// * `context` - The message context.
  /// * `message` - The consumer message.
  ///
  /// # Errors
  ///
  /// Returns a `JsHandlerError` if the JavaScript callback execution fails.
  async fn on_message<C>(&self, context: C, message: ConsumerMessage) -> Result<(), Self::Error>
  where
    C: EventContext,
  {
    let context = Context::new(context.boxed());
    let message = message.into_value();
    let mut carrier = HashMap::with_capacity(2);

    self
      .inner
      .propagator
      .inject_context(&message.span.context(), &mut carrier);

    let message = Message {
      topic: message.topic.to_string(),
      partition: message.partition,
      offset: message.offset,
      timestamp: message.timestamp,
      key: message.key.to_string(),
      payload: message.payload,
    };

    let Err(error) = self
      .inner
      .on_message
      .call_async(Ok((context, message, carrier)))
      .await?
      .await
    else {
      return Ok(());
    };

    Err(self.categorize_error(error).await?)
  }

  async fn on_timer<C>(&self, context: C, trigger: Trigger) -> Result<(), Self::Error>
  where
    C: EventContext,
  {
    let mut carrier = HashMap::with_capacity(2);
    self
      .inner
      .propagator
      .inject_context(&trigger.span.context(), &mut carrier);

    let context = Context::new(context.boxed());
    let timer: Timer = trigger.into();

    let Err(error) = self
      .inner
      .on_timer
      .call_async(Ok((context, timer, carrier)))
      .await?
      .await
    else {
      return Ok(());
    };

    Err(self.categorize_error(error).await?)
  }
}

/// Represents errors that can occur during JavaScript handler execution.
#[derive(Debug, Error)]
pub enum JsHandlerError {
  /// Wraps an `napi::Error` that occurred during JavaScript execution.
  #[error(transparent)]
  Js(#[from] napi::Error),

  /// Wraps an `napi::Error` that is marked as permanent.
  #[error(transparent)]
  Permanent(napi::Error),
}

impl ClassifyError for JsHandlerError {
  /// Classifies the error as transient or permanent.
  ///
  /// # Returns
  ///
  /// Returns `ErrorCategory::Transient` for `Js` errors and `ErrorCategory::Permanent` for `Permanent` errors.
  fn classify_error(&self) -> ErrorCategory {
    match self {
      JsHandlerError::Js(_) => ErrorCategory::Transient,
      JsHandlerError::Permanent(_) => ErrorCategory::Permanent,
    }
  }
}
