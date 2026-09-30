//! Typed state cursors.

use super::{
    Arc, BinaryPayload, ConsumerMessage, HashMap, Message, SCAN_READY_CHUNK_SIZE, StateCursor,
    TextMapCompositePropagator, json_text, napi, run,
};

macro_rules! native_cursor {
    ($name:ident, $item:ty, $output:ty, $convert:expr) => {
        /// Demand-driven cursor with one element type.
        #[napi]
        pub struct $name {
            pub(crate) cursor: StateCursor<$item>,
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
                let chunk = self.cursor.next_ready_chunk(SCAN_READY_CHUNK_SIZE);
                run(&self.propagator, &otel_context, chunk)
                    .await?
                    .map(|items| items.into_iter().map($convert).collect())
                    .transpose()
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
native_cursor!(NativeKeyCursor, String, String, Ok);
