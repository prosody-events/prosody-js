//! Concrete map state handles.

use super::{
    Arc, BinaryPayload, BoxMapState, ConsumerMessage, FutureExt, HashMap, Message, MessageItem,
    NativeJsonMapCursor, NativeMapKeyCursor, NativeMessageMapCursor, TextMapCompositePropagator,
    json_payload, json_value, message_value, napi, op_context, parse_direction, state_error,
};

/// JSON ordered-map state handle for one event.
#[napi]
pub struct NativeJsonMapState {
    pub(crate) state: BoxMapState<BinaryPayload>,
    /// The propagator used to re-establish the event parent per operation.
    pub(crate) propagator: Arc<TextMapCompositePropagator>,
}

#[napi]
impl NativeJsonMapState {
    /// Reads the value for `key`.
    ///
    /// @param key The map key.
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @returns The value, or null when the key is absent.
    /// @throws Error carrying the category on `cause` if the read fails.
    #[napi(writable = false)]
    pub async fn get(
        &self,
        key: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Option<String>> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .get(key)
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
            .and_then(json_value)
    }

    /// Reads several keys in a single call.
    ///
    /// Returns one entry per key, in the same order requested: the entry at
    /// index `i` is the value for `keys[i]`. A key that isn't there reads as
    /// null, and a key listed more than once is answered at each of its spots.
    /// The whole read happens as one step, so no other change to this event's
    /// state can slip in partway through.
    ///
    /// @param keys The keys to read, in order.
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @returns One result per input key; null for a key that is absent.
    /// @throws Error carrying the category on `cause` if the read fails.
    #[napi(writable = false)]
    pub async fn get_many(
        &self,
        keys: Vec<String>,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Vec<Option<String>>> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .get_many(keys)
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
            .and_then(|items| items.into_iter().map(json_value).collect())
    }

    /// Reports whether a stored cell exists for `key`.
    ///
    /// Reads the event's dirty overlay (read-your-writes) and answers presence
    /// WITHOUT decoding the value or running the resolver — a message-backed
    /// map answers with zero Kafka fetches and can report `true` for a
    /// message that can no longer be fetched. This is NOT "no I/O": a cache
    /// miss can still reach Cassandra, so it is async and fallible exactly
    /// like `get`.
    ///
    /// @param key The map key.
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @returns True when a stored cell exists for `key`.
    /// @throws Error carrying the category on `cause` if the read fails.
    #[napi(writable = false)]
    pub async fn contains(
        &self,
        key: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<bool> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .contains_key(key)
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }

    /// Inserts or overwrites `key` with a JSON document.
    ///
    /// JSON null is rejected with a transient error naming `delete` as the way
    /// to remove an entry.
    ///
    /// @param key The map key.
    /// @param json The document's JSON text.
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @throws Error carrying the category on `cause` if the write fails.
    #[napi(writable = false)]
    pub async fn set(
        &self,
        key: String,
        json: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        let payload = json_payload(json, "; use delete(key) to remove the entry")?;
        self.state
            .set(key, payload)
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }

    /// Removes `key`.
    ///
    /// @param key The map key.
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @throws Error carrying the category on `cause` if the removal fails.
    #[napi(writable = false)]
    pub async fn remove(
        &self,
        key: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .remove(key)
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }

    /// Removes every entry.
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

    /// Opens a demand-driven cursor over the live entries in key order.
    ///
    /// Synchronous — it performs no I/O. The extracted JavaScript context is
    /// active while core constructs its semantic stream span; chunk pulls do
    /// not create binding spans. Entries are yielded as `(key, value)` pairs.
    ///
    /// @param direction The scan direction (`"forward"` or `"backward"`).
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @returns A cursor over the map entries.
    /// @throws Error if the direction token is invalid.
    #[napi(writable = false)]
    #[allow(clippy::needless_pass_by_value)] // required by NAPI
    pub fn scan(
        &self,
        direction: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<NativeJsonMapCursor> {
        let dir = parse_direction(&direction)?;
        let _guard = op_context(&self.propagator, &otel_context).attach();
        Ok(NativeJsonMapCursor {
            cursor: self.state.scan(dir),
            propagator: Arc::clone(&self.propagator),
        })
    }

    /// Opens a demand-driven cursor over the live KEYS in key order.
    ///
    /// Skips the value codec and the resolver (no value decode, no Kafka
    /// fetch), so a message-backed map enumerates keys with zero Kafka
    /// fetches — but it still reads presence, so it is not zero-I/O.
    /// Synchronous like `scan`: the extracted JavaScript context is active
    /// while core constructs its semantic stream span. Yields bare keys.
    ///
    /// @param direction The scan direction (`"forward"` or `"backward"`).
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @returns A cursor over the map keys.
    /// @throws Error if the direction token is invalid.
    #[napi(writable = false)]
    #[allow(clippy::needless_pass_by_value)] // required by NAPI
    pub fn keys(
        &self,
        direction: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<NativeMapKeyCursor> {
        let dir = parse_direction(&direction)?;
        let _guard = op_context(&self.propagator, &otel_context).attach();
        Ok(NativeMapKeyCursor {
            cursor: self.state.keys(dir),
            propagator: Arc::clone(&self.propagator),
        })
    }
}

/// Kafka-message ordered-map state handle for one event.
#[napi]
pub struct NativeMessageMapState {
    pub(crate) state: BoxMapState<ConsumerMessage<BinaryPayload>>,
    pub(crate) propagator: Arc<TextMapCompositePropagator>,
}

#[napi]
impl NativeMessageMapState {
    /// Reads the value for `key`.
    #[napi(writable = false)]
    pub async fn get(
        &self,
        key: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Option<Message>> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .get(key)
            .with_context(context)
            .await
            .map(message_value)
            .map_err(|e| state_error(&e))
    }

    /// Reads several keys in one operation.
    #[napi(writable = false)]
    pub async fn get_many(
        &self,
        keys: Vec<String>,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Vec<Option<Message>>> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .get_many(keys)
            .with_context(context)
            .await
            .map(|items| items.into_iter().map(message_value).collect())
            .map_err(|e| state_error(&e))
    }

    /// Reports whether `key` has a stored cell.
    #[napi(writable = false)]
    pub async fn contains(
        &self,
        key: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<bool> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .contains_key(key)
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }

    /// Inserts or overwrites `key` with a Kafka message.
    #[napi(
        writable = false,
        ts_args_type = "key: string, message: Message, otelContext: Record<string, string>"
    )]
    pub async fn set(
        &self,
        key: String,
        message: MessageItem,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .set(key, message.0)
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }

    /// Removes `key`.
    #[napi(writable = false)]
    pub async fn remove(
        &self,
        key: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .remove(key)
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }

    /// Removes every entry.
    #[napi(writable = false)]
    pub async fn clear(&self, otel_context: HashMap<String, String>) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .clear()
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }

    /// Opens a cursor over entries in key order.
    #[napi(writable = false)]
    #[allow(clippy::needless_pass_by_value)] // required by NAPI
    pub fn scan(
        &self,
        direction: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<NativeMessageMapCursor> {
        let dir = parse_direction(&direction)?;
        let _guard = op_context(&self.propagator, &otel_context).attach();
        Ok(NativeMessageMapCursor {
            cursor: self.state.scan(dir),
            propagator: Arc::clone(&self.propagator),
        })
    }

    /// Opens a cursor over keys in key order.
    #[napi(writable = false)]
    #[allow(clippy::needless_pass_by_value)] // required by NAPI
    pub fn keys(
        &self,
        direction: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<NativeMapKeyCursor> {
        let dir = parse_direction(&direction)?;
        let _guard = op_context(&self.propagator, &otel_context).attach();
        Ok(NativeMapKeyCursor {
            cursor: self.state.keys(dir),
            propagator: Arc::clone(&self.propagator),
        })
    }
}
