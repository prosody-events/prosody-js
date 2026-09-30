//! Concrete value state handles.

use super::{
    Arc, BinaryPayload, BoxValueState, ConsumerMessage, HashMap, Message, MessageItem,
    TextMapCompositePropagator, json_payload, json_value, message_value, napi, run,
};

/// JSON single-value state handle for one event.
#[napi]
pub struct NativeJsonValueState {
    pub(crate) state: BoxValueState<BinaryPayload>,
    /// The propagator used to re-establish the event parent per operation.
    pub(crate) propagator: Arc<TextMapCompositePropagator>,
}

#[napi]
impl NativeJsonValueState {
    /// Reads the current value.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @returns The current value, or null when absent/cleared.
    /// @throws Error carrying the category on `cause` if the read fails.
    #[napi(writable = false)]
    pub async fn get(&self, otel_context: HashMap<String, String>) -> napi::Result<Option<String>> {
        run(&self.propagator, &otel_context, self.state.get())
            .await
            .and_then(json_value)
    }

    /// Buffers a write of a JSON document.
    ///
    /// Prosody rejects JSON null with a permanent error. Use `clear` to
    /// delete.
    ///
    /// @param json The document's JSON text.
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @throws Error carrying the category on `cause` if the write fails.
    #[napi(writable = false)]
    pub async fn set(
        &self,
        json: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<()> {
        run(
            &self.propagator,
            &otel_context,
            self.state.set(json_payload(json)),
        )
        .await
    }

    /// Buffers a clear of the value.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @throws Error carrying the category on `cause` if the clear fails.
    #[napi(writable = false)]
    pub async fn clear(&self, otel_context: HashMap<String, String>) -> napi::Result<()> {
        run(&self.propagator, &otel_context, self.state.clear()).await
    }
}

/// Kafka-message single-value state handle for one event.
#[napi]
pub struct NativeMessageValueState {
    pub(crate) state: BoxValueState<ConsumerMessage<BinaryPayload>>,
    pub(crate) propagator: Arc<TextMapCompositePropagator>,
}

#[napi]
impl NativeMessageValueState {
    /// Reads the current value.
    #[napi(writable = false)]
    pub async fn get(
        &self,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Option<Message>> {
        run(&self.propagator, &otel_context, self.state.get())
            .await
            .map(message_value)
    }

    /// Buffers a write of a Kafka message.
    #[napi(
        writable = false,
        ts_args_type = "message: Message, otelContext: Record<string, string>"
    )]
    pub async fn set(
        &self,
        message: MessageItem,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<()> {
        run(&self.propagator, &otel_context, self.state.set(message.0)).await
    }

    /// Buffers a clear of the value.
    #[napi(writable = false)]
    pub async fn clear(&self, otel_context: HashMap<String, String>) -> napi::Result<()> {
        run(&self.propagator, &otel_context, self.state.clear()).await
    }
}
