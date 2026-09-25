//! Concrete map state handles.

use super::{
    Arc, BinaryPayload, BoxMapState, ConsumerMessage, FutureExt, HashMap, Message, MessageItem,
    NativeJsonMapCursor, NativeKeyCursor, NativeKeyQuery, NativeMessageMapCursor,
    TextMapCompositePropagator, json_payload, json_value, message_value, napi, op_context,
    state_error,
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

    /// Tests several keys for presence in one read.
    ///
    /// Returns one result per key, in input order. Like `contains`, it skips
    /// the value decode and the resolver.
    ///
    /// @param keys The keys to test, in order.
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @returns One presence result per input key.
    /// @throws Error carrying the category on `cause` if the read fails.
    #[napi(writable = false)]
    pub async fn contains_many(
        &self,
        keys: Vec<String>,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Vec<bool>> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .contains_many(keys)
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }

    /// Reports whether the map holds no live entries.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @returns True when the map is empty.
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

    /// Opens a demand-driven cursor over the selected entries.
    ///
    /// Synchronous — it performs no I/O. The first chunk pull starts the read
    /// under that pull's trace context. Entries are yielded as `(key, value)`
    /// pairs.
    ///
    /// @param query The query options.
    /// @returns A cursor over the map entries.
    /// @throws Error (transient) if an option is invalid.
    #[napi(writable = false)]
    pub fn entries(&self, query: NativeKeyQuery) -> napi::Result<NativeJsonMapCursor> {
        Ok(NativeJsonMapCursor {
            cursor: self
                .state
                .entries()
                .with_query(query.into_query()?)
                .stream(),
            propagator: Arc::clone(&self.propagator),
        })
    }

    /// Opens a demand-driven cursor over the selected KEYS.
    ///
    /// Skips the value codec and the resolver (no value decode, no Kafka
    /// fetch), so a message-backed map enumerates keys with zero Kafka
    /// fetches — but it still reads presence, so it is not zero-I/O.
    /// Synchronous like `entries`: the first chunk pull starts the read.
    /// Yields bare keys.
    ///
    /// @param query The query options.
    /// @returns A cursor over the map keys.
    /// @throws Error (transient) if an option is invalid.
    #[napi(writable = false)]
    pub fn keys(&self, query: NativeKeyQuery) -> napi::Result<NativeKeyCursor> {
        Ok(NativeKeyCursor {
            cursor: self.state.keys().with_query(query.into_query()?).stream(),
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

    /// Tests several keys for presence in one read.
    #[napi(writable = false)]
    pub async fn contains_many(
        &self,
        keys: Vec<String>,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Vec<bool>> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .contains_many(keys)
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }

    /// Reports whether the map has no live entries.
    #[napi(writable = false)]
    pub async fn is_empty(&self, otel_context: HashMap<String, String>) -> napi::Result<bool> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .is_empty()
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

    /// Opens a cursor over the selected entries.
    #[napi(writable = false)]
    pub fn entries(&self, query: NativeKeyQuery) -> napi::Result<NativeMessageMapCursor> {
        Ok(NativeMessageMapCursor {
            cursor: self
                .state
                .entries()
                .with_query(query.into_query()?)
                .stream(),
            propagator: Arc::clone(&self.propagator),
        })
    }

    /// Opens a cursor over the selected keys.
    #[napi(writable = false)]
    pub fn keys(&self, query: NativeKeyQuery) -> napi::Result<NativeKeyCursor> {
        Ok(NativeKeyCursor {
            cursor: self.state.keys().with_query(query.into_query()?).stream(),
            propagator: Arc::clone(&self.propagator),
        })
    }
}
