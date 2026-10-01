//! Concrete map state handles.

use super::{
    Arc, BinaryPayload, BoxMapState, ConsumerMessage, HashMap, Message, MessageItem,
    NativeJsonMapCursor, NativeKeyCursor, NativeKeyQuery, NativeMessageMapCursor,
    TextMapCompositePropagator, json_payload, json_value, message_value, napi, run,
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
    #[napi(writable = false)]
    pub async fn get(
        &self,
        key: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Option<String>> {
        run(&self.propagator, &otel_context, self.state.get(key))
            .await
            .and_then(json_value)
    }

    /// Reads several keys in one operation.
    #[napi(writable = false)]
    pub async fn get_many(
        &self,
        keys: Vec<String>,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Vec<Option<String>>> {
        run(&self.propagator, &otel_context, self.state.get_many(keys))
            .await
            .and_then(|items| items.into_iter().map(json_value).collect())
    }

    /// Reports whether the map holds an entry for `key`.
    #[napi(writable = false)]
    pub async fn contains(
        &self,
        key: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<bool> {
        run(
            &self.propagator,
            &otel_context,
            self.state.contains_key(key),
        )
        .await
    }

    /// Tests several keys for presence in one read.
    #[napi(writable = false)]
    pub async fn contains_many(
        &self,
        keys: Vec<String>,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Vec<bool>> {
        run(
            &self.propagator,
            &otel_context,
            self.state.contains_many(keys),
        )
        .await
    }

    /// Reports whether the map has no live entries.
    #[napi(writable = false)]
    pub async fn is_empty(&self, otel_context: HashMap<String, String>) -> napi::Result<bool> {
        run(&self.propagator, &otel_context, self.state.is_empty()).await
    }

    /// Inserts or overwrites `key` with a JSON document.
    #[napi(writable = false)]
    pub async fn set(
        &self,
        key: String,
        json: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<()> {
        run(
            &self.propagator,
            &otel_context,
            self.state.set(key, json_payload(json)),
        )
        .await
    }

    /// Removes `key`.
    #[napi(writable = false)]
    pub async fn remove(
        &self,
        key: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<()> {
        run(&self.propagator, &otel_context, self.state.remove(key)).await
    }

    /// Removes every entry.
    #[napi(writable = false)]
    pub async fn clear(&self, otel_context: HashMap<String, String>) -> napi::Result<()> {
        run(&self.propagator, &otel_context, self.state.clear()).await
    }

    /// Opens a cursor over the selected entries.
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

    /// Opens a cursor over the selected keys.
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
        run(&self.propagator, &otel_context, self.state.get(key))
            .await
            .map(message_value)
    }

    /// Reads several keys in one operation.
    #[napi(writable = false)]
    pub async fn get_many(
        &self,
        keys: Vec<String>,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Vec<Option<Message>>> {
        run(&self.propagator, &otel_context, self.state.get_many(keys))
            .await
            .map(|items| items.into_iter().map(message_value).collect())
    }

    /// Reports whether the map holds an entry for `key`.
    #[napi(writable = false)]
    pub async fn contains(
        &self,
        key: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<bool> {
        run(
            &self.propagator,
            &otel_context,
            self.state.contains_key(key),
        )
        .await
    }

    /// Tests several keys for presence in one read.
    #[napi(writable = false)]
    pub async fn contains_many(
        &self,
        keys: Vec<String>,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Vec<bool>> {
        run(
            &self.propagator,
            &otel_context,
            self.state.contains_many(keys),
        )
        .await
    }

    /// Reports whether the map has no live entries.
    #[napi(writable = false)]
    pub async fn is_empty(&self, otel_context: HashMap<String, String>) -> napi::Result<bool> {
        run(&self.propagator, &otel_context, self.state.is_empty()).await
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
        run(
            &self.propagator,
            &otel_context,
            self.state.set(key, message.0),
        )
        .await
    }

    /// Removes `key`.
    #[napi(writable = false)]
    pub async fn remove(
        &self,
        key: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<()> {
        run(&self.propagator, &otel_context, self.state.remove(key)).await
    }

    /// Removes every entry.
    #[napi(writable = false)]
    pub async fn clear(&self, otel_context: HashMap<String, String>) -> napi::Result<()> {
        run(&self.propagator, &otel_context, self.state.clear()).await
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
