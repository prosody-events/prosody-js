//! Concrete deque state handles.

use super::{
    Arc, BinaryPayload, BoxDequeState, ConsumerMessage, FutureExt, HashMap, Message, MessageItem,
    NativeJsonDequeCursor, NativeMessageDequeCursor, TextMapCompositePropagator, json_payload,
    json_value, message_value, napi, op_context, parse_direction, state_error, transient_error,
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
        let context = op_context(&self.propagator, &otel_context);
        let len = self
            .state
            .len()
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))?;
        u32::try_from(len).map_err(|_| {
            transient_error(format!(
                "deque length {len} exceeds the u32 range representable to JavaScript"
            ))
        })
    }

    /// Whether the deque holds no live elements.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @returns True when the deque is empty.
    /// @throws Error carrying the category on `cause` if the read fails.
    #[napi(writable = false)]
    pub async fn is_empty(&self, otel_context: HashMap<String, String>) -> napi::Result<bool> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .is_empty()
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
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
        let context = op_context(&self.propagator, &otel_context);
        let index = index as usize;
        self.state
            .get(index)
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
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
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .peek_front()
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
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
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .peek_back()
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
            .and_then(json_value)
    }

    /// Appends a JSON document at the back.
    ///
    /// JSON null is not a storable element and is rejected with a transient
    /// error.
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
        let context = op_context(&self.propagator, &otel_context);
        let payload = json_payload(json, " in a deque")?;
        self.state
            .push_back(payload)
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }

    /// Prepends a JSON document at the front.
    ///
    /// JSON null is not a storable element and is rejected with a transient
    /// error.
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
        let context = op_context(&self.propagator, &otel_context);
        let payload = json_payload(json, " in a deque")?;
        self.state
            .push_front(payload)
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
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
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .pop_front()
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
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
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .pop_back()
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
            .and_then(json_value)
    }

    /// Removes every element.
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

    /// Opens a demand-driven cursor over the live elements in index order.
    ///
    /// Synchronous — it performs no I/O. The extracted JavaScript context is
    /// active while core constructs its semantic stream span; chunk pulls do
    /// not create binding spans.
    ///
    /// @param direction The scan direction (`"forward"` or `"backward"`).
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @returns A cursor over the deque elements.
    /// @throws Error if the direction token is invalid.
    #[napi(writable = false)]
    #[allow(clippy::needless_pass_by_value)] // required by NAPI
    pub fn scan(
        &self,
        direction: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<NativeJsonDequeCursor> {
        let dir = parse_direction(&direction)?;
        let _guard = op_context(&self.propagator, &otel_context).attach();
        Ok(NativeJsonDequeCursor {
            cursor: self.state.scan(dir),
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
        let context = op_context(&self.propagator, &otel_context);
        let len = self
            .state
            .len()
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))?;
        u32::try_from(len).map_err(|_| {
            transient_error(format!(
                "deque length {len} exceeds the u32 range representable to JavaScript"
            ))
        })
    }

    /// Reports whether the deque has no live elements.
    #[napi(writable = false)]
    pub async fn is_empty(&self, otel_context: HashMap<String, String>) -> napi::Result<bool> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .is_empty()
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }

    /// Reads one element by its position from the front.
    #[napi(writable = false)]
    pub async fn get(
        &self,
        index: u32,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Option<Message>> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .get(index as usize)
            .with_context(context)
            .await
            .map(message_value)
            .map_err(|e| state_error(&e))
    }

    /// Reads the front endpoint.
    #[napi(writable = false)]
    pub async fn peek_front(
        &self,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Option<Message>> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .peek_front()
            .with_context(context)
            .await
            .map(message_value)
            .map_err(|e| state_error(&e))
    }

    /// Reads the back endpoint.
    #[napi(writable = false)]
    pub async fn peek_back(
        &self,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Option<Message>> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .peek_back()
            .with_context(context)
            .await
            .map(message_value)
            .map_err(|e| state_error(&e))
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
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .push_back(message.0)
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
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
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .push_front(message.0)
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }

    /// Removes and returns the front element.
    #[napi(writable = false)]
    pub async fn pop_front(
        &self,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Option<Message>> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .pop_front()
            .with_context(context)
            .await
            .map(message_value)
            .map_err(|e| state_error(&e))
    }

    /// Removes and returns the back element.
    #[napi(writable = false)]
    pub async fn pop_back(
        &self,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Option<Message>> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .pop_back()
            .with_context(context)
            .await
            .map(message_value)
            .map_err(|e| state_error(&e))
    }

    /// Removes every element.
    #[napi(writable = false)]
    pub async fn clear(&self, otel_context: HashMap<String, String>) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .clear()
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }

    /// Opens a cursor over the live elements.
    #[napi(writable = false)]
    #[allow(clippy::needless_pass_by_value)] // required by NAPI
    pub fn scan(
        &self,
        direction: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<NativeMessageDequeCursor> {
        let dir = parse_direction(&direction)?;
        let _guard = op_context(&self.propagator, &otel_context).attach();
        Ok(NativeMessageDequeCursor {
            cursor: self.state.scan(dir),
            propagator: Arc::clone(&self.propagator),
        })
    }
}
