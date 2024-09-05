//! Provides a wrapper around `MessageContext` for use in Node.js bindings.
//!
//! This module defines the `Context` struct, which encapsulates a `MessageContext`
//! from the `prosody` crate and exposes its functionality to Node.js through NAPI.

use napi_derive::napi;
use prosody::consumer::message::MessageContext;

/// Wrapper around `MessageContext` for use in Node.js bindings.
#[napi]
pub struct Context {
  context: MessageContext,
}

#[napi]
impl Context {
  /// Creates a new `Context` instance.
  ///
  /// # Arguments
  ///
  /// * `context` - The `MessageContext` to wrap.
  pub fn new(context: MessageContext) -> Self {
    Self { context }
  }

  /// Signals that the context should shut down.
  ///
  /// This method is asynchronous and should be awaited.
  #[napi(writable = false)]
  pub async fn on_shutdown(&self) {
    self.context.on_shutdown().await;
  }

  /// Checks if the context should shut down.
  ///
  /// # Returns
  ///
  /// `true` if the context should shut down, `false` otherwise.
  #[napi(getter, writable = false)]
  pub fn should_shutdown(&self) -> bool {
    self.context.should_shutdown()
  }
}
