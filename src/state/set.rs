//! Concrete set state handles.

use super::{
    Arc, BoxSetState, FutureExt, HashMap, NativeKeyCursor, NativeKeyQuery,
    TextMapCompositePropagator, napi, op_context, state_error,
};

/// Presence-only ordered set of string members for one event.
#[napi]
pub struct NativeSetState {
    pub(crate) state: BoxSetState,
    /// The propagator used to re-establish the event parent per operation.
    pub(crate) propagator: Arc<TextMapCompositePropagator>,
}

#[napi]
impl NativeSetState {
    /// Reports whether `member` belongs to the set.
    ///
    /// @param member The member to test.
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @returns True when the set contains `member`.
    /// @throws Error carrying the category on `cause` if the read fails.
    #[napi(writable = false)]
    pub async fn contains(
        &self,
        member: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<bool> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .contains(member)
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }

    /// Tests several members in one read.
    ///
    /// @param members The members to test, in order.
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @returns One result per member, in input order.
    /// @throws Error carrying the category on `cause` if the read fails.
    #[napi(writable = false)]
    pub async fn contains_many(
        &self,
        members: Vec<String>,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<Vec<bool>> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .contains_many(members)
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }

    /// Reports whether the set has no live members.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @returns True when the set is empty.
    /// @throws Error carrying the category on `cause` if the read fails.
    #[napi(writable = false)]
    pub async fn is_empty(&self, otel_context: HashMap<String, String>) -> napi::Result<bool> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .is_empty()
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }

    /// Adds `member` to the set.
    ///
    /// @param member The member to add.
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @throws Error carrying the category on `cause` if the write fails.
    #[napi(writable = false)]
    pub async fn insert(
        &self,
        member: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .insert(member)
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }

    /// Removes `member` from the set. An absent member is not an error.
    ///
    /// @param member The member to remove.
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @throws Error carrying the category on `cause` if the write fails.
    #[napi(writable = false)]
    pub async fn remove(
        &self,
        member: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .remove(member)
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }

    /// Removes every member.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @throws Error carrying the category on `cause` if the clear fails.
    #[napi(writable = false)]
    pub async fn clear(&self, otel_context: HashMap<String, String>) -> napi::Result<()> {
        let context = op_context(&self.propagator, &otel_context);
        self.state
            .clear()
            .with_context(context)
            .await
            .map_err(|e| state_error(&e))
    }

    /// Opens a demand-driven cursor over the selected members.
    ///
    /// Synchronous — it performs no I/O. The first chunk pull starts the read.
    ///
    /// @param query The query options.
    /// @returns A cursor over the members.
    /// @throws Error (transient) if an option is invalid.
    #[napi(writable = false)]
    pub fn keys(&self, query: NativeKeyQuery) -> napi::Result<NativeKeyCursor> {
        Ok(NativeKeyCursor {
            cursor: self.state.keys().with_query(query.into_query()?).stream(),
            propagator: Arc::clone(&self.propagator),
        })
    }
}
