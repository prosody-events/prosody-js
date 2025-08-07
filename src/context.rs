//! Provides a wrapper around `MessageContext` for use in Node.js bindings.
//!
//! This module defines the `Context` struct, which encapsulates a `MessageContext`
//! from the `prosody` crate and exposes its functionality to Node.js through NAPI.

use chrono::{DateTime, Utc};
use futures::TryStreamExt;
use napi::Error;
use napi_derive::napi;
use prosody::consumer::event_context::BoxEventContext;
use prosody::timers::datetime::CompactDateTime;

/// Wrapper around `MessageContext` for use in Node.js bindings.
#[napi]
pub struct Context {
  context: BoxEventContext,
}

#[napi]
impl Context {
  /// Creates a new `Context` instance.
  ///
  /// # Arguments
  ///
  /// * `context` - The `BoxEventContext` to wrap.
  pub fn new(context: BoxEventContext) -> Self {
    Self { context }
  }

  /**
   * Checks whether a shutdown has been signaled.
   *
   * @returns {boolean} True if shutdown was requested, otherwise false.
   */
  #[napi(getter, writable = false)]
  pub fn should_shutdown(&self) -> bool {
    self.context.should_shutdown()
  }

  /**
   * Waits for a shutdown signal.
   *
   * @returns {Promise<void>} Resolves when shutdown is signaled.
   */
  #[napi(writable = false)]
  pub async fn on_shutdown(&self) {
    self.context.on_shutdown().await;
  }

  /**
   * Schedule a timer at the given time.
   *
   * @param time {Date} The UTC timestamp to schedule.
   * @throws {Error} If time conversion or scheduling fails.
   */
  #[napi(writable = false)]
  pub async fn schedule(&self, time: DateTime<Utc>) -> napi::Result<()> {
    let time =
      CompactDateTime::try_from(time).map_err(|error| Error::from_reason(error.to_string()))?;

    self
      .context
      .schedule(time)
      .await
      .map_err(|error| Error::from_reason(error.to_string()))?;

    Ok(())
  }

  /**
   * Clear existing timers and schedule a new one at the given time.
   *
   * @param time {Date} The UTC timestamp to schedule.
   * @throws {Error} If time conversion or scheduling fails.
   */
  #[napi(writable = false)]
  pub async fn clear_and_schedule(&self, time: DateTime<Utc>) -> napi::Result<()> {
    let time =
      CompactDateTime::try_from(time).map_err(|error| Error::from_reason(error.to_string()))?;

    self
      .context
      .clear_and_schedule(time)
      .await
      .map_err(|error| Error::from_reason(error.to_string()))?;

    Ok(())
  }

  /**
   * Unschedules the timer for the specified time.
   * @param time - The time to unschedule.
   * @throws Error if unscheduling fails.
   */
  #[napi(writable = false)]
  pub async fn unschedule(&self, time: DateTime<Utc>) -> napi::Result<()> {
    let time =
      CompactDateTime::try_from(time).map_err(|error| Error::from_reason(error.to_string()))?;

    self
      .context
      .unschedule(time)
      .await
      .map_err(|error| Error::from_reason(error.to_string()))?;

    Ok(())
  }

  /**
   * Clears all scheduled timers.
   * @throws Error if clearing schedules fails.
   */
  #[napi(writable = false)]
  pub async fn clear_scheduled(&self) -> napi::Result<()> {
    self
      .context
      .clear_scheduled()
      .await
      .map_err(|error| Error::from_reason(error.to_string()))?;

    Ok(())
  }

  /**
   * Retrieves all scheduled times.
   * @returns An array of scheduled times as Date objects.
   * @throws Error if retrieval fails.
   */
  #[napi(writable = false)]
  pub async fn scheduled(&self) -> napi::Result<Vec<DateTime<Utc>>> {
    self
      .context
      .scheduled()
      .map_ok(DateTime::<Utc>::from)
      .map_err(|error| Error::from_reason(error.to_string()))
      .try_collect()
      .await
  }
}
