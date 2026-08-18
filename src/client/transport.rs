use napi::bindgen_prelude::Either;
use napi_derive::napi;
use prosody::codec::BinaryPayload;
use prosody::requester::ResponseError;
use std::result::Result as StdResult;

/// One subsystem request.
#[napi(object)]
pub struct NativeRequest {
    /// Kafka topic.
    pub topic: String,
    /// Message key.
    pub key: String,
    /// JSON payload text.
    pub payload: String,
    /// Event metadata read before serialization.
    pub metadata: EventMetadata,
    /// Subsystems that must respond.
    pub subsystems: Vec<String>,
    /// Response deadline in milliseconds.
    pub timeout_ms: f64,
}

/// One excise subsystem request.
#[napi(object)]
pub struct NativeExciseRequest {
    /// Kafka topic.
    pub topic: String,
    /// Message key.
    pub key: String,
    /// Subsystems that must respond.
    pub subsystems: Vec<String>,
    /// Response deadline in milliseconds.
    pub timeout_ms: f64,
}

/// One response failure.
#[napi(object)]
pub struct NativeResponseError {
    /// Failure discriminator.
    pub kind: NativeResponseErrorKind,
    /// Failure text.
    pub message: String,
}

/// One subsystem and its outcome.
#[napi(object)]
pub struct NativeSubsystemOutcome {
    /// Canonical subsystem name.
    pub subsystem: String,
    /// Encoded response or failure.
    pub outcome: Either<String, NativeResponseError>,
}

/// One response failure kind.
#[derive(Clone, Copy)]
#[napi(string_enum)]
pub enum NativeResponseErrorKind {
    #[napi(value = "handler")]
    Handler,
    #[napi(value = "timeout")]
    Timeout,
    #[napi(value = "formatMismatch")]
    FormatMismatch,
    #[napi(value = "malformedResponse")]
    Malformed,
}

pub(super) fn native_outcome(
    result: StdResult<BinaryPayload, ResponseError>,
) -> Either<String, NativeResponseError> {
    match result {
        Ok(value) => match String::from_utf8(value.bytes) {
            Ok(value) => Either::A(value),
            Err(_) => Either::B(native_error(ResponseError::Malformed)),
        },
        Err(error) => Either::B(native_error(error)),
    }
}

fn native_error(error: ResponseError) -> NativeResponseError {
    let (kind, message) = match error {
        ResponseError::Handler { message } => (NativeResponseErrorKind::Handler, message),
        ResponseError::Timeout => (
            NativeResponseErrorKind::Timeout,
            ResponseError::Timeout.to_string(),
        ),
        ResponseError::FormatMismatch => (
            NativeResponseErrorKind::FormatMismatch,
            ResponseError::FormatMismatch.to_string(),
        ),
        ResponseError::Malformed => (
            NativeResponseErrorKind::Malformed,
            ResponseError::Malformed.to_string(),
        ),
    };
    NativeResponseError { kind, message }
}

/// Event metadata read off a payload before it was serialized.
///
/// It lets the send path forward the payload without another parse.
#[napi(object)]
pub struct EventMetadata {
    /// The payload's `id` field.
    pub event_id: Option<String>,
    /// The payload's `type` field.
    pub event_type: Option<String>,
}

/// Current consumer state.
#[derive(Debug)]
#[napi(string_enum)]
pub enum ConsumerState {
    /// The client is shut down.
    Shutdown,
    /// The consumer is not configured.
    Unconfigured,
    /// The consumer is configured but not active.
    Configured,
    /// The consumer is active.
    Running,
    /// The consumer configuration failed.
    ConfigurationFailed,
}
