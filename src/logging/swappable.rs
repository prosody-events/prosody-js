//! This module provides a swappable logging mechanism for the application.

use crate::logging::js::JsLogger;
use arc_swap::ArcSwapOption;
use educe::Educe;
use std::sync::Arc;
use tracing::{Event, Subscriber};
use tracing_subscriber::Layer;
use tracing_subscriber::layer::Context;

/// A thread-safe, swappable logger that can be dynamically changed at runtime.
///
/// This logger wraps a `JsLogger` and allows it to be safely swapped or cleared
/// across multiple threads.
#[derive(Default, Clone, Educe)]
#[educe(Debug)]
pub struct SwappableLogger {
    #[educe(Debug(ignore))]
    inner: Arc<ArcSwapOption<JsLogger>>,
}

impl SwappableLogger {
    #[allow(dead_code)]
    pub fn is_set(&self) -> bool {
        self.inner.load().is_some()
    }

    #[allow(dead_code)]
    pub fn set_logger_if_unset(&self, logger: JsLogger) -> bool {
        self.inner
            .compare_and_swap(&None::<Arc<_>>, Some(Arc::new(logger)))
            .is_none()
    }

    /// Sets the current logger to the provided `JsLogger`.
    ///
    /// # Arguments
    ///
    /// * `logger` - The `JsLogger` to be set as the current logger.
    #[allow(dead_code)]
    pub fn set_logger(&self, logger: JsLogger) {
        self.inner.store(Some(Arc::new(logger)));
    }

    /// Shuts down the current logger and cleans up resources.
    /// This should be called when Node.js is shutting down.
    pub fn shutdown_logger(&self) {
        self.inner.store(None);
    }
}

impl<S: Subscriber> Layer<S> for SwappableLogger {
    /// Handles a log event if a logger is set.
    ///
    /// This method forwards the event to the current `JsLogger` if one is set.
    /// If no logger is set, the event is silently ignored.
    ///
    /// # Arguments
    ///
    /// * `event` - The log event to be processed.
    /// * `ctx` - The context for the subscriber.
    fn on_event(&self, event: &Event, ctx: Context<S>) {
        if let Some(logger) = self.inner.load().as_ref() {
            logger.on_event(event, ctx);
        }
    }
}
