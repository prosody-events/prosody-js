//! Query options that cross from JavaScript into core queries.
//!
//! `lib/state/query.js` checks the option shapes: exclusive edge pairs, a
//! `range` of two bounds, a positive integer `limit`, and non-negative integer
//! positions. This module only converts the checked values onto the core
//! builders. It applies the direction first, because core reads `from`,
//! `after`, `to`, and `before` in query order. A `range` is ascending in either
//! direction, and a `null` bound leaves its end open. Core narrows the query by
//! the edges and the range, so a query that sets both keeps their overlap.

use crate::number::whole;
use napi_derive::napi;
use prosody::state::{DequeQuery, Direction, ErasedKeyQuery};
use std::ops::Bound;

/// The order of a scan.
#[napi(string_enum = "lowercase")]
pub enum NativeDirection {
    /// Ascending order.
    Forward,
    /// Descending order.
    Backward,
}

/// Query options for map keys, map entries, and set members.
#[napi(object)]
pub struct NativeKeyQuery {
    /// The query order.
    pub direction: Option<NativeDirection>,
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
    /// A `null` bound leaves its end open.
    pub range: Option<(Option<String>, Option<String>)>,
    /// The maximum number of results.
    pub limit: Option<f64>,
}

/// Query options for deque values. Positions count from the front.
#[napi(object)]
pub struct NativePositionQuery {
    /// The query order.
    pub direction: Option<NativeDirection>,
    /// Starts at this position in query order.
    pub from: Option<f64>,
    /// Starts after this position in query order.
    pub after: Option<f64>,
    /// Stops at this position in query order.
    pub to: Option<f64>,
    /// Stops before this position in query order.
    pub before: Option<f64>,
    /// Keeps positions from the first bound up to, but not including, the
    /// second. A `null` bound leaves its end open.
    pub range: Option<(Option<f64>, Option<f64>)>,
    /// The maximum number of results.
    pub limit: Option<f64>,
}

impl From<NativeDirection> for Direction {
    fn from(direction: NativeDirection) -> Self {
        match direction {
            NativeDirection::Forward => Self::Forward,
            NativeDirection::Backward => Self::Backward,
        }
    }
}

impl NativeKeyQuery {
    /// Builds the core key query.
    ///
    /// @returns The core query with every option applied.
    /// @throws Error if the limit does not convert.
    pub(crate) fn into_query(self) -> napi::Result<ErasedKeyQuery> {
        let direction = self.direction.map_or(Direction::Forward, Direction::from);
        let mut query = ErasedKeyQuery::new().direction(direction);
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
            query = query.range(half_open(range));
        }
        if let Some(limit) = self.limit {
            query = query.limit(whole(limit, "limit")?);
        }
        Ok(query)
    }
}

impl NativePositionQuery {
    /// Builds the core deque query.
    ///
    /// @returns The core query with every option applied.
    /// @throws Error if a position or the limit does not convert.
    pub(crate) fn into_query(self) -> napi::Result<DequeQuery> {
        let direction = self.direction.map_or(Direction::Forward, Direction::from);
        let mut query = DequeQuery::new().direction(direction);
        if let Some(position) = self.from {
            query = query.from(whole(position, "from")?);
        }
        if let Some(position) = self.after {
            query = query.after(whole(position, "after")?);
        }
        if let Some(position) = self.to {
            query = query.to(whole(position, "to")?);
        }
        if let Some(position) = self.before {
            query = query.before(whole(position, "before")?);
        }
        if let Some((start, end)) = self.range {
            let position =
                |bound: Option<f64>| bound.map(|p| whole::<usize>(p, "range")).transpose();
            query = query.range(half_open((position(start)?, position(end)?)));
        }
        if let Some(limit) = self.limit {
            query = query.limit(whole(limit, "limit")?);
        }
        Ok(query)
    }
}

/// Converts `(start, end)` into half-open bounds. A `None` bound is open.
fn half_open<T>((start, end): (Option<T>, Option<T>)) -> (Bound<T>, Bound<T>) {
    (
        start.map_or(Bound::Unbounded, Bound::Included),
        end.map_or(Bound::Unbounded, Bound::Excluded),
    )
}
