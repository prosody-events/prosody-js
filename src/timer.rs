use chrono::{DateTime, Utc};
use napi_derive::napi;
use prosody::timers::Trigger;

#[napi(object)]
pub struct Timer {
  /// The timer key.
  pub key: String,

  /// The timer trigger time
  pub time: DateTime<Utc>,
}

impl From<Trigger> for Timer {
  fn from(value: Trigger) -> Self {
    Self {
      key: value.key.to_string(),
      time: value.time.into(),
    }
  }
}
