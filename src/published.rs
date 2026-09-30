//! Native read-only views over published keyed state.

use crate::state::{
    NativeJsonDequeCursor, NativeJsonMapCursor, NativeKeyCursor, NativeKeyQuery,
    NativePositionQuery, json_value, length, run,
};
use napi::Result;
use napi_derive::napi;
use opentelemetry::propagation::TextMapCompositePropagator;
use prosody::codec::BinaryPayload;
use prosody::high_level::erased::{
    SharedDequeReader, SharedMapReader, SharedSetReader, SharedValueReader,
};
use std::collections::HashMap;
use std::sync::Arc;

/// A read-only published value collection.
#[napi]
pub struct NativePublishedValue {
    pub(crate) inner: SharedValueReader<BinaryPayload>,
    pub(crate) propagator: Arc<TextMapCompositePropagator>,
}

#[napi]
impl NativePublishedValue {
    /// Reads the committed value for a partition key.
    #[napi(writable = false)]
    pub async fn get(
        &self,
        key: String,
        otel_context: HashMap<String, String>,
    ) -> Result<Option<String>> {
        run(&self.propagator, &otel_context, self.inner.get(key))
            .await
            .and_then(json_value)
    }
}

/// A read-only published map collection.
#[napi]
pub struct NativePublishedMap {
    pub(crate) inner: SharedMapReader<BinaryPayload>,
    pub(crate) propagator: Arc<TextMapCompositePropagator>,
}

#[napi]
impl NativePublishedMap {
    /// Reads one committed map entry.
    #[napi(writable = false)]
    pub async fn get(
        &self,
        key: String,
        map_key: String,
        otel_context: HashMap<String, String>,
    ) -> Result<Option<String>> {
        run(
            &self.propagator,
            &otel_context,
            self.inner.get(key, map_key),
        )
        .await
        .and_then(json_value)
    }

    /// Reads entries aligned with the supplied map keys.
    #[napi(writable = false)]
    pub async fn get_many(
        &self,
        key: String,
        map_keys: Vec<String>,
        otel_context: HashMap<String, String>,
    ) -> Result<Vec<Option<String>>> {
        run(
            &self.propagator,
            &otel_context,
            self.inner.get_many(key, map_keys),
        )
        .await
        .and_then(|values| values.into_iter().map(json_value).collect())
    }

    /// Reports whether a committed map entry exists.
    #[napi(writable = false)]
    pub async fn contains(
        &self,
        key: String,
        map_key: String,
        otel_context: HashMap<String, String>,
    ) -> Result<bool> {
        run(
            &self.propagator,
            &otel_context,
            self.inner.contains_key(key, map_key),
        )
        .await
    }

    /// Tests committed presence aligned with the supplied map keys.
    #[napi(writable = false)]
    pub async fn contains_many(
        &self,
        key: String,
        map_keys: Vec<String>,
        otel_context: HashMap<String, String>,
    ) -> Result<Vec<bool>> {
        run(
            &self.propagator,
            &otel_context,
            self.inner.contains_many(key, map_keys),
        )
        .await
    }

    /// Reports whether the committed map is empty.
    #[napi(writable = false)]
    pub async fn is_empty(
        &self,
        key: String,
        otel_context: HashMap<String, String>,
    ) -> Result<bool> {
        run(&self.propagator, &otel_context, self.inner.is_empty(key)).await
    }

    /// Opens a cursor over the selected entries.
    #[napi(writable = false)]
    pub fn entries(&self, key: String, query: NativeKeyQuery) -> Result<NativeJsonMapCursor> {
        Ok(NativeJsonMapCursor {
            cursor: self
                .inner
                .entries(key)
                .with_query(query.into_query()?)
                .stream(),
            propagator: Arc::clone(&self.propagator),
        })
    }

    /// Opens a cursor over the selected keys.
    #[napi(writable = false)]
    pub fn keys(&self, key: String, query: NativeKeyQuery) -> Result<NativeKeyCursor> {
        Ok(NativeKeyCursor {
            cursor: self
                .inner
                .keys(key)
                .with_query(query.into_query()?)
                .stream(),
            propagator: Arc::clone(&self.propagator),
        })
    }
}

/// A read-only published set collection.
#[napi]
pub struct NativePublishedSet {
    pub(crate) inner: SharedSetReader,
    pub(crate) propagator: Arc<TextMapCompositePropagator>,
}

#[napi]
impl NativePublishedSet {
    /// Reports whether the committed set contains a member.
    #[napi(writable = false)]
    pub async fn contains(
        &self,
        key: String,
        member: String,
        otel_context: HashMap<String, String>,
    ) -> Result<bool> {
        run(
            &self.propagator,
            &otel_context,
            self.inner.contains(key, member),
        )
        .await
    }

    /// Tests committed membership aligned with the supplied members.
    #[napi(writable = false)]
    pub async fn contains_many(
        &self,
        key: String,
        members: Vec<String>,
        otel_context: HashMap<String, String>,
    ) -> Result<Vec<bool>> {
        run(
            &self.propagator,
            &otel_context,
            self.inner.contains_many(key, members),
        )
        .await
    }

    /// Reports whether the committed set has no members.
    #[napi(writable = false)]
    pub async fn is_empty(
        &self,
        key: String,
        otel_context: HashMap<String, String>,
    ) -> Result<bool> {
        run(&self.propagator, &otel_context, self.inner.is_empty(key)).await
    }

    /// Opens a cursor over the selected members.
    #[napi(writable = false)]
    pub fn keys(&self, key: String, query: NativeKeyQuery) -> Result<NativeKeyCursor> {
        Ok(NativeKeyCursor {
            cursor: self
                .inner
                .keys(key)
                .with_query(query.into_query()?)
                .stream(),
            propagator: Arc::clone(&self.propagator),
        })
    }
}

/// A read-only published deque collection.
#[napi]
pub struct NativePublishedDeque {
    pub(crate) inner: SharedDequeReader<BinaryPayload>,
    pub(crate) propagator: Arc<TextMapCompositePropagator>,
}

#[napi]
impl NativePublishedDeque {
    /// Reads one front-relative element.
    #[napi(writable = false)]
    pub async fn get(
        &self,
        key: String,
        index: u32,
        otel_context: HashMap<String, String>,
    ) -> Result<Option<String>> {
        run(
            &self.propagator,
            &otel_context,
            self.inner.get(key, index as usize),
        )
        .await
        .and_then(json_value)
    }

    /// Returns the committed deque length.
    #[napi(writable = false)]
    pub async fn length(&self, key: String, otel_context: HashMap<String, String>) -> Result<u32> {
        length(run(&self.propagator, &otel_context, self.inner.len(key)).await?)
    }

    /// Reports whether the committed deque is empty.
    #[napi(writable = false)]
    pub async fn is_empty(
        &self,
        key: String,
        otel_context: HashMap<String, String>,
    ) -> Result<bool> {
        run(&self.propagator, &otel_context, self.inner.is_empty(key)).await
    }

    /// Reads the committed front element.
    #[napi(writable = false)]
    pub async fn peek_front(
        &self,
        key: String,
        otel_context: HashMap<String, String>,
    ) -> Result<Option<String>> {
        run(&self.propagator, &otel_context, self.inner.peek_front(key))
            .await
            .and_then(json_value)
    }

    /// Reads the committed back element.
    #[napi(writable = false)]
    pub async fn peek_back(
        &self,
        key: String,
        otel_context: HashMap<String, String>,
    ) -> Result<Option<String>> {
        run(&self.propagator, &otel_context, self.inner.peek_back(key))
            .await
            .and_then(json_value)
    }

    /// Opens a cursor over the selected elements.
    #[napi(writable = false)]
    pub fn values(&self, key: String, query: NativePositionQuery) -> Result<NativeJsonDequeCursor> {
        Ok(NativeJsonDequeCursor {
            cursor: self
                .inner
                .values(key)
                .with_query(query.into_query()?)
                .stream(),
            propagator: Arc::clone(&self.propagator),
        })
    }
}
