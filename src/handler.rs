//! This module handles message processing and JavaScript interaction for the Prosody consumer.

use crate::context::Context;
use crate::message::Message;
use crate::timer::Timer;
use napi::bindgen_prelude::{Either3, FromNapiValue, Promise};
use napi::threadsafe_function::ThreadsafeFunction;
use napi::threadsafe_function::{ErrorStrategy, ThreadSafeCallContext};
use napi::{Error, JsFunction, JsObject};
use napi_derive::napi;
use opentelemetry::propagation::{TextMapCompositePropagator, TextMapPropagator};
use prosody::consumer::event_context::EventContext;
use prosody::consumer::failure::{ClassifyError, ErrorCategory, FallibleHandler};
use prosody::consumer::message::ConsumerMessage;
use prosody::propagator::new_propagator;
use prosody::timers::Trigger;
use std::collections::HashMap;
use thiserror::Error;
use tracing_opentelemetry::OpenTelemetrySpanExt;

/**
 * Represents a native handler for processing messages.
 */
#[napi(object)]
pub struct NativeHandler {
  /**
   * A function to be called when a message is received.
   *
   * @param err - An Error object if an error occurred, or null otherwise
   * @param context - A Context object representing the message processing context
   * @param message - A Message object containing the received Kafka message
   * @param otelContext - A record of string key-value pairs representing the OpenTelemetry context
   * @returns A Promise that resolves when the message has been processed
   */
  #[napi(
    ts_type = "(err: null | Error, context: Context, message: Message, otelContext: Record<string, string>) => Promise<void>"
  )]
  pub on_message: JsFunction,

  #[napi(
    ts_type = "(err: null | Error, context: Context, message: Timer, otelContext: Record<string, string>) => Promise<void>"
  )]
  pub on_timer: JsFunction,

  /**
   * Function that determines whether an error is permanent.
   *
   * @param err - An Error object to classify
   * @returns A boolean that is true when the given error is permanent and false otherwise
   */
  #[napi(ts_type = "(err: Error) => boolean")]
  pub is_permanent: JsFunction,
}

/// Handles the interaction between Rust and JavaScript for message processing.
pub struct JsHandler {
  on_message: ThreadsafeFunction<(Context, Message, HashMap<String, String>)>,
  on_timer: ThreadsafeFunction<(Context, Timer, HashMap<String, String>)>, //todo: fix
  is_permanent: ThreadsafeFunction<napi::Error, ErrorStrategy::Fatal>,
  propagator: TextMapCompositePropagator,
}

impl Clone for JsHandler {
  fn clone(&self) -> Self {
    Self {
      on_message: self.on_message.clone(),
      on_timer: self.on_timer.clone(),
      is_permanent: self.is_permanent.clone(),
      propagator: new_propagator(),
    }
  }
}

impl JsHandler {
  /// Creates a new `JsHandler` instance.
  ///
  /// # Arguments
  ///
  /// * `event_handler` - A reference to a `NativeHandler` containing the JavaScript callback.
  /// * `max_queue_size` - The maximum number of items that can be queued for processing.
  ///
  /// # Errors
  ///
  /// Returns a `napi::Error` if the threadsafe function creation fails.
  pub fn new(event_handler: &NativeHandler, max_queue_size: usize) -> napi::Result<Self> {
    let on_message = event_handler
      .on_message
      .create_threadsafe_function(max_queue_size, build_on_message_args)?;

    let on_timer = event_handler
      .on_timer
      .create_threadsafe_function(max_queue_size, build_on_timer_args)?;

    let is_permanent = event_handler
      .is_permanent
      .create_threadsafe_function(max_queue_size, build_is_permanent_args)?;

    Ok(Self {
      on_message,
      on_timer,
      is_permanent,
      propagator: new_propagator(),
    })
  }

  async fn categorize_error(&self, error: Error) -> napi::Result<JsHandlerError> {
    Ok(
      if self.is_permanent.call_async::<bool>(error.clone()).await? {
        JsHandlerError::Permanent(error)
      } else {
        JsHandlerError::Js(error)
      },
    )
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
    let js_object = unsafe { JsObject::from_napi_value(env, napi_val)? };
    let on_message: JsFunction = js_object.get_named_property("onMessage")?;
    let on_timer: JsFunction = js_object.get_named_property("onTimer")?;
    let is_permanent: JsFunction = js_object.get_named_property("isPermanent")?;

    let native_handler = NativeHandler {
      on_message,
      on_timer,
      is_permanent,
    };

    Self::new(&native_handler, 8)
  }
}

type OnMessageArgs = Vec<Either3<Context, Message, HashMap<String, String>>>;
type OnTimerArgs = Vec<Either3<Context, Timer, HashMap<String, String>>>;
type IsPermanentArgs = Vec<napi::Error>;

/// Builds the arguments for the message JavaScript callback.
///
/// # Arguments
///
/// * `ctx` - The thread-safe call context containing the message context, consumer message, and OpenTelemetry context.
///
/// # Returns
///
/// A `Result` containing a vector of arguments for the JavaScript callback.
#[allow(clippy::unnecessary_wraps)] // required for create_threadsafe_function signature
fn build_on_message_args(
  ctx: ThreadSafeCallContext<(Context, Message, HashMap<String, String>)>,
) -> napi::Result<OnMessageArgs> {
  let (context, message, otel_context) = ctx.value;

  Ok(vec![
    Either3::A(context),
    Either3::B(message),
    Either3::C(otel_context),
  ])
}

#[allow(clippy::unnecessary_wraps)] // required for create_threadsafe_function signature
fn build_on_timer_args(
  ctx: ThreadSafeCallContext<(Context, Timer, HashMap<String, String>)>,
) -> napi::Result<OnTimerArgs> {
  let (context, timer, otel_context) = ctx.value;
  Ok(vec![
    Either3::A(context),
    Either3::B(timer),
    Either3::C(otel_context),
  ])
}

/// Builds the arguments for a JavaScript function to determine whether an error is permanent.
///
/// # Arguments
///
/// * `ctx` - The thread-safe call context containing the error to classify.
///
/// # Returns
///
/// A `Result` containing a vector of arguments for the JavaScript function.
#[allow(clippy::unnecessary_wraps)] // required for create_threadsafe_function signature
fn build_is_permanent_args(
  ctx: ThreadSafeCallContext<napi::Error>,
) -> napi::Result<IsPermanentArgs> {
  Ok(vec![ctx.value])
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
      .propagator
      .inject_context(&message.span.context(), &mut carrier);

    let message = Message {
      topic: message.topic.as_ref(),
      partition: message.partition,
      offset: message.offset,
      timestamp: message.timestamp,
      key: message.key.to_string(),
      payload: message.payload,
    };

    let Err(error) = self
      .on_message
      .call_async::<Promise<()>>(Ok((context, message, carrier)))
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
      .propagator
      .inject_context(&trigger.span.context(), &mut carrier);

    let context = Context::new(context.boxed());
    let timer: Timer = trigger.into();

    let Err(error) = self
      .on_timer
      .call_async::<Promise<()>>(Ok((context, timer, carrier)))
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
  /// Returns `ErrorCategory::Transient` for all JavaScript errors.
  fn classify_error(&self) -> ErrorCategory {
    match self {
      JsHandlerError::Js(_) => ErrorCategory::Transient,
      JsHandlerError::Permanent(_) => ErrorCategory::Permanent,
    }
  }
}
