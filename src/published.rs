//! Native read-only views over published keyed state.

use crate::state::{NativeStateCursor, op_context, parse_direction};
use napi::{Error, Result};
use napi_derive::napi;
use opentelemetry::propagation::TextMapCompositePropagator;
use opentelemetry::trace::FutureExt;
use prosody::JsonCodec;
use prosody::high_level::erased::{
    ErasedDirection, SharedDequeReader, SharedMapReader, SharedValueReader,
};
use prosody::state::Direction;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

fn read_error(error: &impl ToString) -> Error {
    Error::from_reason(error.to_string())
}

/// A read-only published value collection.
#[napi]
pub struct NativePublishedValue {
    pub(crate) inner: SharedValueReader<JsonCodec>,
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
    ) -> Result<Option<Value>> {
        let context = op_context(&self.propagator, &otel_context);
        self.inner
            .get(key)
            .with_context(context)
            .await
            .map_err(|error| read_error(&error))
    }
}

/// A read-only published map collection.
#[napi]
pub struct NativePublishedMap {
    pub(crate) inner: SharedMapReader<JsonCodec>,
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
    ) -> Result<Option<Value>> {
        let context = op_context(&self.propagator, &otel_context);
        self.inner
            .get(key, map_key)
            .with_context(context)
            .await
            .map_err(|error| read_error(&error))
    }

    /// Reads entries aligned with the supplied map keys.
    #[napi(writable = false)]
    pub async fn get_many(
        &self,
        key: String,
        map_keys: Vec<String>,
        otel_context: HashMap<String, String>,
    ) -> Result<Vec<Option<Value>>> {
        let context = op_context(&self.propagator, &otel_context);
        self.inner
            .get_many(key, map_keys)
            .with_context(context)
            .await
            .map_err(|error| read_error(&error))
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

    /// Opens an ordered entry cursor.
    #[napi(writable = false)]
    pub async fn scan(
        &self,
        key: String,
        direction: String,
        otel_context: HashMap<String, String>,
    ) -> Result<NativeStateCursor> {
        let direction = match parse_direction(&direction)? {
            Direction::Forward => ErasedDirection::Forward,
            Direction::Backward => ErasedDirection::Backward,
        };
        let context = op_context(&self.propagator, &otel_context);
        let inner = self
            .inner
            .stream(key, direction)
            .with_context(context)
            .await
            .map_err(|error| read_error(&error))?;
        Ok(NativeStateCursor::published_map(
            inner,
            Arc::clone(&self.propagator),
        ))
    }

    /// Opens an ordered key cursor.
    #[napi(writable = false)]
    pub async fn keys(
        &self,
        key: String,
        direction: String,
        otel_context: HashMap<String, String>,
    ) -> Result<NativeStateCursor> {
        let direction = match parse_direction(&direction)? {
            Direction::Forward => ErasedDirection::Forward,
            Direction::Backward => ErasedDirection::Backward,
        };
        let context = op_context(&self.propagator, &otel_context);
        let inner = self
            .inner
            .keys(key, direction)
            .with_context(context)
            .await
            .map_err(|error| read_error(&error))?;
        Ok(NativeStateCursor::published_map_keys(
            inner,
            Arc::clone(&self.propagator),
        ))
    }
}

/// A read-only published deque collection.
#[napi]
pub struct NativePublishedDeque {
    pub(crate) inner: SharedDequeReader<JsonCodec>,
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
    ) -> Result<Option<Value>> {
        let context = op_context(&self.propagator, &otel_context);
        self.inner
            .get(key, index as usize)
            .with_context(context)
            .await
            .map_err(|error| read_error(&error))
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
    ) -> Result<Option<Value>> {
        let context = op_context(&self.propagator, &otel_context);
        self.inner
            .peek_front(key)
            .with_context(context)
            .await
            .map_err(|error| read_error(&error))
    }

    /// Reads the committed back element.
    #[napi(writable = false)]
    pub async fn peek_back(
        &self,
        key: String,
        otel_context: HashMap<String, String>,
    ) -> Result<Option<Value>> {
        let context = op_context(&self.propagator, &otel_context);
        self.inner
            .peek_back(key)
            .with_context(context)
            .await
            .map_err(|error| read_error(&error))
    }

    /// Opens an ordered element cursor.
    #[napi(writable = false)]
    pub async fn scan(
        &self,
        key: String,
        direction: String,
        otel_context: HashMap<String, String>,
    ) -> Result<NativeStateCursor> {
        let direction = match parse_direction(&direction)? {
            Direction::Forward => ErasedDirection::Forward,
            Direction::Backward => ErasedDirection::Backward,
        };
        let context = op_context(&self.propagator, &otel_context);
        let inner = self
            .inner
            .stream(key, direction)
            .with_context(context)
            .await
            .map_err(|error| read_error(&error))?;
        Ok(NativeStateCursor::published_deque(
            inner,
            Arc::clone(&self.propagator),
        ))
    }
}
