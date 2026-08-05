//! Typed state cursors.

use super::{
    Arc, BinaryPayload, BoxStateCursor, ConsumerMessage, FutureExt, HashMap, Message,
    SCAN_READY_CHUNK_SIZE, TextMapCompositePropagator, json_text, napi, op_context, state_error,
};

macro_rules! native_cursor {
    ($name:ident, $item:ty, $output:ty, $convert:expr) => {
        /// Demand-driven cursor with one element type.
        #[napi]
        pub struct $name {
            pub(crate) cursor: BoxStateCursor<$item>,
            pub(crate) propagator: Arc<TextMapCompositePropagator>,
        }

        #[napi]
        impl $name {
            /// Pulls the next ready chunk.
            #[napi(writable = false)]
            pub async fn next_chunk(
                &self,
                otel_context: HashMap<String, String>,
            ) -> napi::Result<Option<Vec<$output>>> {
                let context = op_context(&self.propagator, &otel_context);
                pull(&self.cursor, context, $convert).await
            }

            /// Closes the cursor.
            #[napi(writable = false)]
            pub async fn close(&self) {
                self.cursor.close().await;
            }
        }
    };
}

native_cursor!(NativeJsonDequeCursor, BinaryPayload, String, json_text);
native_cursor!(
    NativeJsonMapCursor,
    (String, BinaryPayload),
    (String, String),
    |(key, payload)| Ok((key, json_text(payload)?))
);
native_cursor!(
    NativeMessageDequeCursor,
    ConsumerMessage<BinaryPayload>,
    Message,
    |message| Ok(Message::new(message))
);
native_cursor!(
    NativeMessageMapCursor,
    (String, ConsumerMessage<BinaryPayload>),
    (String, Message),
    |(key, message)| Ok((key, Message::new(message)))
);
native_cursor!(NativeMapKeyCursor, String, String, Ok);

/// Pulls one ready chunk from a cursor and converts its items.
///
/// Preserves the exhausted sentinel: `None` in, `None` out. A store failure
/// becomes a category-tagged error before any item is converted.
///
/// @param cursor The erased cursor to pull from.
/// @param context The OpenTelemetry context to activate for the pull.
/// @param convert Maps one scanned item to the value handed to JavaScript.
/// @returns The converted chunk, or `None` when the scan is exhausted.
/// @throws Error carrying the category on `cause` if the pull fails.
async fn pull<T, U>(
    cursor: &BoxStateCursor<T>,
    context: opentelemetry::Context,
    convert: impl Fn(T) -> napi::Result<U>,
) -> napi::Result<Option<Vec<U>>> {
    cursor
        .next_ready_chunk(SCAN_READY_CHUNK_SIZE)
        .with_context(context)
        .await
        .map_err(|error| state_error(&error))?
        .map(|items| items.into_iter().map(convert).collect())
        .transpose()
}
