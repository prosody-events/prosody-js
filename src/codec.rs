//! The message codec: payload bytes verbatim, event metadata best-effort.
//!
//! Rust does not read the payload. JavaScript parses it, and JavaScript is
//! where a payload that is not JSON raises a permanent error.

use prosody::codec::{BinaryCodec, BinaryExtractor, BinaryMetadata, JsonExtractor, JsonFormat};
use std::convert::Infallible;

/// Copies payload bytes verbatim and reads `id` and `type` when they are there.
pub(crate) type MessageCodec = BinaryCodec<LenientJsonExtractor, JsonFormat>;

/// Reads the `id` and `type` a payload carries, without constraining it.
///
/// Wraps prosody's [`JsonExtractor`], which recovers both fields by
/// deserializing the payload into a two-field struct. That reports a document
/// which is not an object, and an `id` which is not a string, as parse
/// failures — the same channel it reports malformed bytes through. A codec
/// failure makes the consumer discard the message before any handler sees it,
/// so using the extractor directly would silently drop payloads for having a
/// shape it did not expect. A payload may be any JSON value.
///
/// Extraction here cannot fail: metadata is whatever could be read, and absent
/// otherwise. Deciding whether the bytes are JSON at all belongs to the side
/// that parses them, which is JavaScript.
#[derive(Default)]
pub(crate) struct LenientJsonExtractor(JsonExtractor);

impl BinaryExtractor for LenientJsonExtractor {
    type Error = Infallible;

    fn extract<'a>(&mut self, buf: &'a mut [u8]) -> Result<BinaryMetadata<'a>, Self::Error> {
        Ok(self.0.extract(buf).unwrap_or_default())
    }

    fn with_cached_local<R>(f: impl FnOnce(Self) -> (Self, R)) -> R {
        JsonExtractor::with_cached_local(|inner| {
            let (extractor, result) = f(Self(inner));
            (extractor.0, result)
        })
    }
}
