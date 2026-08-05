//! Concrete value state handles.

use super::{
    Arc, BinaryPayload, BoxValueState, ConsumerMessage, FutureExt, HashMap, Message, MessageItem,
    TextMapCompositePropagator, json_payload, json_value, message_value, napi, op_context,
    state_error,
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
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .get()
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
            .and_then(json_value)
    }

    /// Buffers a write of a JSON document.
    ///
    /// JSON null is rejected with a transient error naming `clear` as the way
    /// to delete.
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
        let context = op_context(&self.propagator, &otel_context);
        let payload = json_payload(json, "; use clear() to remove the value")?;
        self.state
            .set(payload)
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }

    /// Buffers a clear of the value.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @throws Error carrying the category on `cause` if the clear fails.
    #[napi(writable = false)]
    pub async fn clear(&self, otel_context: HashMap<String, String>) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .clear()
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
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
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .get()
            .with_context(context)
            .await
            .map(message_value)
            .map_err(|e| state_error(&e))
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
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .set(message.0)
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }

    /// Buffers a clear of the value.
    #[napi(writable = false)]
    pub async fn clear(&self, otel_context: HashMap<String, String>) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .clear()
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }
}
