//! Converts JavaScript numbers into the integer and duration types that
//! Prosody takes.
//!
//! JavaScript has one number type. A conversion rejects a number that has no
//! exact form in the target type: a negative, fractional, non-finite, or too
//! large number. It never wraps, truncates, or saturates. Prosody validates
//! the converted value, so this module checks no other rule.

use napi::{Error, Result};
use std::time::Duration;

/// The first power of two above `usize::MAX` on the 64-bit targets this addon
/// builds for. Every whole number below it fits in a `usize`.
const USIZE_LIMIT: f64 = 18_446_744_073_709_551_616.0;

/// Converts a JavaScript number into an integer type, such as `u16` or
/// `NonZeroUsize`.
///
/// @param value The JavaScript number.
/// @param field The option name for the error message.
/// @returns The same number in the target type.
/// @throws Error if the number is not a non-negative whole number that fits.
pub(crate) fn whole<T: TryFrom<usize>>(value: f64, field: &str) -> Result<T> {
    // The range test also rejects NaN and both infinities.
    if (0.0_f64..USIZE_LIMIT).contains(&value)
        && value.fract() == 0.0_f64
        && let Ok(converted) = T::try_from(value as usize)
    {
        return Ok(converted);
    }
    Err(Error::from_reason(format!(
        "{field}: must be a whole number in the range of the option, got {value}"
    )))
}

/// Converts a JavaScript number of milliseconds into a duration.
///
/// @param value The number of milliseconds.
/// @param field The option name for the error message.
/// @returns The duration.
/// @throws Error if the number is negative, not finite, or too large.
pub(crate) fn milliseconds(value: f64, field: &str) -> Result<Duration> {
    seconds(value / 1_000.0, field)
}

/// Converts a JavaScript number of seconds into a duration.
///
/// @param value The number of seconds.
/// @param field The option name for the error message.
/// @returns The duration.
/// @throws Error if the number is negative, not finite, or too large.
pub(crate) fn seconds(value: f64, field: &str) -> Result<Duration> {
    Duration::try_from_secs_f64(value)
        .map_err(|error| Error::from_reason(format!("{field}: {error}")))
}
