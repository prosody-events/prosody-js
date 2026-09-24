//! Native read-only views over published keyed state.

use crate::state::{
    NativeJsonDequeCursor, NativeJsonMapCursor, NativeKeyCursor, NativeKeyQuery,
    NativePositionQuery, json_text, op_context,
};
use napi::{Error, Result};
use napi_derive::napi;
use opentelemetry::propagation::TextMapCompositePropagator;
use opentelemetry::trace::FutureExt;
use prosody::codec::BinaryPayload;
use prosody::high_level::erased::{SharedDequeReader, SharedMapReader, SharedValueReader};
use std::collections::HashMap;
use std::sync::Arc;

fn read_error(error: &impl ToString) -> Error {
    Error::from_reason(error.to_string())
}

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
        let context = op_context(&self.propagator, &otel_context);
        let value = self
            .inner
            .get(key)
            .with_context(context)
            .await
            .map_err(|error| read_error(&error))?;
        value.map(json_text).transpose()
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
        let context = op_context(&self.propagator, &otel_context);
        let value = self
            .inner
            .get(key, map_key)
            .with_context(context)
            .await
            .map_err(|error| read_error(&error))?;
        value.map(json_text).transpose()
    }

    /// Reads entries aligned with the supplied map keys.
    #[napi(writable = false)]
    pub async fn get_many(
        &self,
        key: String,
        map_keys: Vec<String>,
        otel_context: HashMap<String, String>,
    ) -> Result<Vec<Option<String>>> {
        let context = op_context(&self.propagator, &otel_context);
        self.inner
            .get_many(key, map_keys)
            .with_context(context)
            .await
            .map_err(|error| read_error(&error))?
            .into_iter()
            .map(|value| value.map(json_text).transpose())
            .collect()
    }

    /// Reports whether a committed map entry exists.
    #[napi(writable = false)]
    pub async fn contains(
        &self,
        key: String,
        map_key: String,
        otel_context: HashMap<String, String>,
    ) -> Result<bool> {
        let context = op_context(&self.propagator, &otel_context);
        self.inner
            .contains_key(key, map_key)
            .with_context(context)
            .await
            .map_err(|error| read_error(&error))
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
        let context = op_context(&self.propagator, &otel_context);
        let value = self
            .inner
            .get(key, index as usize)
            .with_context(context)
            .await
            .map_err(|error| read_error(&error))?;
        value.map(json_text).transpose()
    }

    /// Returns the committed deque length.
    #[napi(writable = false)]
    pub async fn length(&self, key: String, otel_context: HashMap<String, String>) -> Result<u32> {
        let context = op_context(&self.propagator, &otel_context);
        let length = self
            .inner
            .len(key)
            .with_context(context)
            .await
            .map_err(|error| read_error(&error))?;
        u32::try_from(length).map_err(|error| read_error(&error))
    }

    /// Reports whether the committed deque is empty.
    #[napi(writable = false)]
    pub async fn is_empty(
        &self,
        key: String,
        otel_context: HashMap<String, String>,
    ) -> Result<bool> {
        let context = op_context(&self.propagator, &otel_context);
        self.inner
            .is_empty(key)
            .with_context(context)
            .await
            .map_err(|error| read_error(&error))
    }

    /// Reads the committed front element.
    #[napi(writable = false)]
    pub async fn peek_front(
        &self,
        key: String,
        otel_context: HashMap<String, String>,
    ) -> Result<Option<String>> {
        let context = op_context(&self.propagator, &otel_context);
        let value = self
            .inner
            .peek_front(key)
            .with_context(context)
            .await
            .map_err(|error| read_error(&error))?;
        value.map(json_text).transpose()
    }

    /// Reads the committed back element.
    #[napi(writable = false)]
    pub async fn peek_back(
        &self,
        key: String,
        otel_context: HashMap<String, String>,
    ) -> Result<Option<String>> {
        let context = op_context(&self.propagator, &otel_context);
        let value = self
            .inner
            .peek_back(key)
            .with_context(context)
            .await
            .map_err(|error| read_error(&error))?;
        value.map(json_text).transpose()
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
