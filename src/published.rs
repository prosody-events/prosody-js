//! Native read-only views over published keyed state.

use napi::{Error, Result};
use napi_derive::napi;
use prosody::JsonCodec;
use prosody::high_level::erased::{
    ErasedDirection, SharedDequeReader, SharedMapReader, SharedStateStream, SharedValueReader,
};
use serde_json::Value;

fn read_error(error: &impl ToString) -> Error {
    Error::from_reason(error.to_string())
}

fn direction(backward: bool) -> ErasedDirection {
    if backward {
        ErasedDirection::Backward
    } else {
        ErasedDirection::Forward
    }
}

/// A read-only published value collection.
#[napi]
pub struct NativePublishedValue {
    pub(crate) inner: SharedValueReader<JsonCodec>,
}

#[napi]
impl NativePublishedValue {
    /// Reads the committed value for a partition key.
    #[napi(writable = false)]
    pub async fn get(&self, key: String) -> Result<Option<Value>> {
        self.inner
            .get(key)
            .await
            .map_err(|error| read_error(&error))
    }
}

/// A read-only published map collection.
#[napi]
pub struct NativePublishedMap {
    pub(crate) inner: SharedMapReader<JsonCodec>,
}

#[napi]
impl NativePublishedMap {
    /// Reads one committed map entry.
    #[napi(writable = false)]
    pub async fn get(&self, key: String, map_key: String) -> Result<Option<Value>> {
        self.inner
            .get(key, map_key)
            .await
            .map_err(|error| read_error(&error))
    }

    /// Reads entries aligned with the supplied map keys.
    #[napi(writable = false)]
    pub async fn get_many(&self, key: String, map_keys: Vec<String>) -> Result<Vec<Option<Value>>> {
        self.inner
            .get_many(key, map_keys)
            .await
            .map_err(|error| read_error(&error))
    }

    /// Opens an ordered entry cursor.
    #[napi(writable = false)]
    pub async fn scan(
        &self,
        key: String,
        backward: Option<bool>,
    ) -> Result<NativePublishedMapScan> {
        let inner = self
            .inner
            .stream(key, direction(backward.unwrap_or(false)))
            .await
            .map_err(|error| read_error(&error))?;
        Ok(NativePublishedMapScan { inner })
    }
}

/// One published map entry.
#[napi(object)]
pub struct PublishedMapEntry {
    /// The map key.
    pub key: String,
    /// The JSON value.
    pub value: Value,
}

/// Pull cursor for a published map.
#[napi]
pub struct NativePublishedMapScan {
    inner: SharedStateStream<(String, Value)>,
}

#[napi]
impl NativePublishedMapScan {
    /// Pulls the next ordered entry.
    #[napi(writable = false)]
    pub async fn next(&self) -> Result<Option<PublishedMapEntry>> {
        self.inner
            .next()
            .await
            .transpose()
            .map(|entry| entry.map(|(key, value)| PublishedMapEntry { key, value }))
            .map_err(|error| read_error(&error))
    }
}

/// A read-only published deque collection.
#[napi]
pub struct NativePublishedDeque {
    pub(crate) inner: SharedDequeReader<JsonCodec>,
}

#[napi]
impl NativePublishedDeque {
    /// Reads one front-relative element.
    #[napi(writable = false)]
    pub async fn get(&self, key: String, index: u32) -> Result<Option<Value>> {
        self.inner
            .get(key, index as usize)
            .await
            .map_err(|error| read_error(&error))
    }

    /// Returns the committed deque length.
    #[napi(writable = false)]
    pub async fn length(&self, key: String) -> Result<u32> {
        let length = self
            .inner
            .len(key)
            .await
            .map_err(|error| read_error(&error))?;
        u32::try_from(length).map_err(|error| read_error(&error))
    }

    /// Opens an ordered element cursor.
    #[napi(writable = false)]
    pub async fn scan(
        &self,
        key: String,
        backward: Option<bool>,
    ) -> Result<NativePublishedDequeScan> {
        let inner = self
            .inner
            .stream(key, direction(backward.unwrap_or(false)))
            .await
            .map_err(|error| read_error(&error))?;
        Ok(NativePublishedDequeScan { inner })
    }
}

/// Pull cursor for a published deque.
#[napi]
pub struct NativePublishedDequeScan {
    inner: SharedStateStream<Value>,
}

#[napi]
impl NativePublishedDequeScan {
    /// Pulls the next ordered element.
    #[napi(writable = false)]
    pub async fn next(&self) -> Result<Option<Value>> {
        self.inner
            .next()
            .await
            .transpose()
            .map_err(|error| read_error(&error))
    }
}
