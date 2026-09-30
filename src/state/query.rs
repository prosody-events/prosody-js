//! Query options that cross from JavaScript into core queries.
//!
//! `index.js` checks the option shapes: exclusive edge pairs, a `range` of two
//! bounds without edges, a positive integer `limit`, and non-negative integer
//! positions. This module only maps the checked values onto the core builders.
//! It applies the direction first, because core reads `from`, `after`, `to`,
//! and `before` in query order. A `range` is ascending in either direction.

use super::{Direction, parse_direction, transient_error};
use napi_derive::napi;
use prosody::state::{DequeQuery, ErasedKeyQuery};
use std::num::NonZeroUsize;

/// Query options for map keys, map entries, and set members.
#[napi(object)]
pub struct NativeKeyQuery {
    /// The query order: `"forward"` or `"backward"`.
    pub direction: Option<String>,
    /// Keeps keys that start with this prefix.
    pub prefix: Option<String>,
    /// Starts at this key in query order.
    pub from: Option<String>,
    /// Starts after this key in query order.
    pub after: Option<String>,
    /// Stops at this key in query order.
    pub to: Option<String>,
    /// Stops before this key in query order.
    pub before: Option<String>,
    /// Keeps keys from the first bound up to, but not including, the second.
    pub range: Option<Vec<String>>,
    /// The maximum number of results.
    pub limit: Option<i64>,
}

/// Query options for deque values. Positions count from the front.
#[napi(object)]
pub struct NativePositionQuery {
    /// The query order: `"forward"` or `"backward"`.
    pub direction: Option<String>,
    /// Starts at this position in query order.
    pub from: Option<i64>,
    /// Starts after this position in query order.
    pub after: Option<i64>,
    /// Stops at this position in query order.
    pub to: Option<i64>,
    /// Stops before this position in query order.
    pub before: Option<i64>,
    /// Keeps positions from the first bound up to, but not including, the
    /// second.
    pub range: Option<Vec<i64>>,
    /// The maximum number of results.
    pub limit: Option<i64>,
}

impl NativeKeyQuery {
    /// Builds the core key query.
    ///
    /// @returns The core query with every option applied.
    /// @throws Error (transient) if the direction token, the range, or the
    /// limit is invalid.
    pub(crate) fn into_query(self) -> napi::Result<ErasedKeyQuery> {
        let mut query = ErasedKeyQuery::new().direction(direction(self.direction)?);
        if let Some(prefix) = self.prefix {
            query = query.prefix(prefix);
        }
        if let Some(key) = self.from {
            query = query.from(key);
        }
        if let Some(key) = self.after {
            query = query.after(key);
        }
        if let Some(key) = self.to {
            query = query.to(key);
        }
        if let Some(key) = self.before {
            query = query.before(key);
        }
        if let Some(range) = self.range {
            let [start, end] = range_bounds(range)?;
            query = query.range(start..end);
        }
        if let Some(limit) = self.limit {
            query = query.limit(limit_count(limit)?);
        }
        Ok(query)
    }
}

impl NativePositionQuery {
    /// Builds the core deque query.
    ///
    /// @returns The core query with every option applied.
    /// @throws Error (transient) if the direction token, a position, the
    ///   range, or the limit is invalid.
    pub(crate) fn into_query(self) -> napi::Result<DequeQuery> {
        let mut query = DequeQuery::new().direction(direction(self.direction)?);
        if let Some(position) = self.from {
            query = query.from(position_index(position)?);
        }
        if let Some(position) = self.after {
            query = query.after(position_index(position)?);
        }
        if let Some(position) = self.to {
            query = query.to(position_index(position)?);
        }
        if let Some(position) = self.before {
            query = query.before(position_index(position)?);
        }
        if let Some(range) = self.range {
            let [start, end] = range_bounds(range)?;
            query = query.range(position_index(start)?..position_index(end)?);
        }
        if let Some(limit) = self.limit {
            query = query.limit(limit_count(limit)?);
        }
        Ok(query)
    }
}

/// Parses an optional direction token. Forward is the default.
fn direction(token: Option<String>) -> napi::Result<Direction> {
    token.map_or(Ok(Direction::Forward), parse_direction)
}

/// Takes the two bounds of a range.
///
/// @throws Error (transient) if the range does not hold exactly two bounds.
fn range_bounds<T>(range: Vec<T>) -> napi::Result<[T; 2]> {
    let count = range.len();
    range
        .try_into()
        .map_err(|_| transient_error(format!("range must hold two bounds, got {count}")))
}

/// Converts a front-relative position.
///
/// @throws Error (transient) if the position is negative.
fn position_index(position: i64) -> napi::Result<usize> {
    usize::try_from(position)
        .map_err(|_| transient_error(format!("position must be non-negative, got {position}")))
}

/// Converts a result limit.
///
/// @throws Error (transient) if the limit is not positive.
fn limit_count(limit: i64) -> napi::Result<NonZeroUsize> {
    let invalid = || transient_error(format!("limit must be positive, got {limit}"));
    let count = usize::try_from(limit).map_err(|_| invalid())?;
    NonZeroUsize::new(count).ok_or_else(invalid)
}
