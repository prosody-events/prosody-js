//! Tests of the mapping from the options object onto Prosody builders.

use super::{Configuration, build_producer_config};
use napi::bindgen_prelude::Null;
use napi::{Either, Error, Result};
use prosody::producer::ProducerConfiguration;
use std::time::Duration;

/// Builds the producer configuration for one `sendTimeoutMs` value.
fn producer(send_timeout_ms: Either<f64, Null>) -> Result<ProducerConfiguration> {
    let config = Configuration {
        bootstrap_servers: Some(Either::A("localhost:9094".to_owned())),
        source_system: Some("tests".to_owned()),
        send_timeout_ms: Some(send_timeout_ms),
        ..Configuration::default()
    };
    build_producer_config(&config)?
        .build()
        .map_err(|error| Error::from_reason(error.to_string()))
}

/// `sendTimeoutMs: null` reaches Prosody as no timeout, and a number reaches
/// it as that many milliseconds.
#[test]
fn send_timeout_null_reaches_prosody_as_none() -> Result<()> {
    assert_eq!(
        producer(Either::B(Null))?.send_timeout,
        None,
        "null must mean no send timeout"
    );
    assert_eq!(
        producer(Either::A(2500.0_f64))?.send_timeout,
        Some(Duration::from_millis(2500)),
        "a number must mean that many milliseconds"
    );
    Ok(())
}
