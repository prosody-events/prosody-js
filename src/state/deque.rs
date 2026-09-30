//! Concrete deque state handles.

use super::{
    Arc, BinaryPayload, BoxDequeState, ConsumerMessage, HashMap, Message, MessageItem,
    NativeJsonDequeCursor, NativeMessageDequeCursor, NativePositionQuery,
    TextMapCompositePropagator, json_payload, json_value, length, message_value, napi, run,
};

/// JSON deque state handle for one event.
#[napi]
pub struct NativeJsonDequeState {
    pub(crate) state: BoxDequeState<BinaryPayload>,
    /// The propagator used to re-establish the event parent per operation.
    pub(crate) propagator: Arc<TextMapCompositePropagator>,
}

#[napi]
impl NativeJsonDequeState {
    /// The number of live elements.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @returns The element count.
    /// @throws Error carrying the category on `cause` if the read fails, or if
    ///   the count exceeds the `u32` range.
    #[napi(writable = false)]
    pub async fn len(&self, otel_context: HashMap<String, String>) -> napi::Result<u32> {
        length(run(&self.propagator, &otel_context, self.state.len()).await?)
    }

    /// Whether the deque holds no live elements.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @returns True when the deque is empty.
    /// @throws Error carrying the category on `cause` if the read fails.
    #[napi(writable = false)]
    pub async fn is_empty(&self, otel_context: HashMap<String, String>) -> napi::Result<bool> {
        run(&self.propagator, &otel_context, self.state.is_empty()).await
    }

    /// Reads the element at front-relative position `index`.
    ///
    /// @param index The zero-based position from the front.
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @returns The element, or null past the end.
    /// @throws Error carrying the category on `cause` if the read fails.
    #[napi(writable = false)]
    pub async fn get(
        &self,
        index: u32,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Option<String>> {
        run(
            &self.propagator,
            &otel_context,
            self.state.get(index as usize),
        )
        .await
        .and_then(json_value)
    }

    /// Reads the front endpoint SLOT without a length round trip — exactly
    /// `get(0)`.
    ///
    /// Decodes and resolves the returned element (unlike eviction). An empty
    /// deque, or a front endpoint slot expired under a TTL, yields null even
    /// when live interior elements exist — a peek never searches inward.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @returns The front element, or null when the endpoint slot is empty.
    /// @throws Error carrying the category on `cause` if the read fails.
    #[napi(writable = false)]
    pub async fn peek_front(
        &self,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Option<String>> {
        run(&self.propagator, &otel_context, self.state.peek_front())
            .await
            .and_then(json_value)
    }

    /// Reads the back endpoint SLOT without a length round trip — exactly
    /// `get(len − 1)`.
    ///
    /// Decodes and resolves the returned element (unlike eviction). An empty
    /// deque, or a back endpoint slot expired under a TTL, yields null even
    /// when live interior elements exist — a peek never searches inward.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @returns The back element, or null when the endpoint slot is empty.
    /// @throws Error carrying the category on `cause` if the read fails.
    #[napi(writable = false)]
    pub async fn peek_back(
        &self,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Option<String>> {
        run(&self.propagator, &otel_context, self.state.peek_back())
            .await
            .and_then(json_value)
    }

    /// Appends a JSON document at the back.
    ///
    /// Prosody rejects JSON null with a permanent error.
    ///
    /// @param json The document's JSON text.
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @throws Error carrying the category on `cause` if the write fails.
    #[napi(writable = false)]
    pub async fn push_back(
        &self,
        json: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<()> {
        run(
            &self.propagator,
            &otel_context,
            self.state.push_back(json_payload(json)),
        )
        .await
    }

    /// Prepends a JSON document at the front.
    ///
    /// Prosody rejects JSON null with a permanent error.
    ///
    /// @param json The document's JSON text.
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @throws Error carrying the category on `cause` if the write fails.
    #[napi(writable = false)]
    pub async fn push_front(
        &self,
        json: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<()> {
        run(
            &self.propagator,
            &otel_context,
            self.state.push_front(json_payload(json)),
        )
        .await
    }

    /// Removes and returns the front element.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @returns The removed front element, or null when empty.
    /// @throws Error carrying the category on `cause` if the operation fails.
    #[napi(writable = false)]
    pub async fn pop_front(
        &self,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Option<String>> {
        run(&self.propagator, &otel_context, self.state.pop_front())
            .await
            .and_then(json_value)
    }

    /// Removes and returns the back element.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @returns The removed back element, or null when empty.
    /// @throws Error carrying the category on `cause` if the operation fails.
    #[napi(writable = false)]
    pub async fn pop_back(
        &self,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Option<String>> {
        run(&self.propagator, &otel_context, self.state.pop_back())
            .await
            .and_then(json_value)
    }

    /// Removes every element.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @throws Error carrying the category on `cause` if the clear fails.
    #[napi(writable = false)]
    pub async fn clear(&self, otel_context: HashMap<String, String>) -> napi::Result<()> {
        run(&self.propagator, &otel_context, self.state.clear()).await
    }

    /// Opens a demand-driven cursor over the selected elements.
    ///
    /// Synchronous — it performs no I/O. The first chunk pull starts the read
    /// under that pull's trace context.
    ///
    /// @param query The query options. Positions count from the front.
    /// @returns A cursor over the deque elements.
    /// @throws Error (transient) if an option is invalid.
    #[napi(writable = false)]
    pub fn values(&self, query: NativePositionQuery) -> napi::Result<NativeJsonDequeCursor> {
        Ok(NativeJsonDequeCursor {
            cursor: self.state.values().with_query(query.into_query()?).stream(),
            propagator: Arc::clone(&self.propagator),
        })
    }
}

/// Kafka-message deque state handle for one event.
#[napi]
pub struct NativeMessageDequeState {
    pub(crate) state: BoxDequeState<ConsumerMessage<BinaryPayload>>,
    pub(crate) propagator: Arc<TextMapCompositePropagator>,
}

#[napi]
impl NativeMessageDequeState {
    /// Returns the number of live elements.
    #[napi(writable = false)]
    pub async fn len(&self, otel_context: HashMap<String, String>) -> napi::Result<u32> {
        length(run(&self.propagator, &otel_context, self.state.len()).await?)
    }

    /// Reports whether the deque has no live elements.
    #[napi(writable = false)]
    pub async fn is_empty(&self, otel_context: HashMap<String, String>) -> napi::Result<bool> {
        run(&self.propagator, &otel_context, self.state.is_empty()).await
    }

    /// Reads one element by its position from the front.
    #[napi(writable = false)]
    pub async fn get(
        &self,
        index: u32,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Option<Message>> {
        run(
            &self.propagator,
            &otel_context,
            self.state.get(index as usize),
        )
        .await
        .map(message_value)
    }

    /// Reads the front endpoint.
    #[napi(writable = false)]
    pub async fn peek_front(
        &self,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Option<Message>> {
        run(&self.propagator, &otel_context, self.state.peek_front())
            .await
            .map(message_value)
    }

    /// Reads the back endpoint.
    #[napi(writable = false)]
    pub async fn peek_back(
        &self,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Option<Message>> {
        run(&self.propagator, &otel_context, self.state.peek_back())
            .await
            .map(message_value)
    }

    /// Appends a Kafka message.
    #[napi(
        writable = false,
        ts_args_type = "message: Message, otelContext: Record<string, string>"
    )]
    pub async fn push_back(
        &self,
        message: MessageItem,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<()> {
        run(
            &self.propagator,
            &otel_context,
            self.state.push_back(message.0),
        )
        .await
    }

    /// Prepends a Kafka message.
    #[napi(
        writable = false,
        ts_args_type = "message: Message, otelContext: Record<string, string>"
    )]
    pub async fn push_front(
        &self,
        message: MessageItem,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<()> {
        run(
            &self.propagator,
            &otel_context,
            self.state.push_front(message.0),
        )
        .await
    }

    /// Removes and returns the front element.
    #[napi(writable = false)]
    pub async fn pop_front(
        &self,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Option<Message>> {
        run(&self.propagator, &otel_context, self.state.pop_front())
            .await
            .map(message_value)
    }

    /// Removes and returns the back element.
    #[napi(writable = false)]
    pub async fn pop_back(
        &self,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Option<Message>> {
        run(&self.propagator, &otel_context, self.state.pop_back())
            .await
            .map(message_value)
    }

    /// Removes every element.
    #[napi(writable = false)]
    pub async fn clear(&self, otel_context: HashMap<String, String>) -> napi::Result<()> {
        run(&self.propagator, &otel_context, self.state.clear()).await
    }

    /// Opens a cursor over the selected elements.
    #[napi(writable = false)]
    pub fn values(&self, query: NativePositionQuery) -> napi::Result<NativeMessageDequeCursor> {
        Ok(NativeMessageDequeCursor {
            cursor: self.state.values().with_query(query.into_query()?).stream(),
            propagator: Arc::clone(&self.propagator),
        })
    }
}
