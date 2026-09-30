//! Concrete set state handles.

use super::{
    Arc, BoxSetState, HashMap, NativeKeyCursor, NativeKeyQuery, TextMapCompositePropagator, napi,
    run,
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
        run(&self.propagator, &otel_context, self.state.contains(member)).await
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
        run(
            &self.propagator,
            &otel_context,
            self.state.contains_many(members),
        )
        .await
    }

    /// Reports whether the set has no live members.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @returns True when the set is empty.
    /// @throws Error carrying the category on `cause` if the read fails.
    #[napi(writable = false)]
    pub async fn is_empty(&self, otel_context: HashMap<String, String>) -> napi::Result<bool> {
        run(&self.propagator, &otel_context, self.state.is_empty()).await
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
        run(&self.propagator, &otel_context, self.state.insert(member)).await
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
        run(&self.propagator, &otel_context, self.state.remove(member)).await
    }

    /// Removes every member.
    ///
    /// @param otelContext The OpenTelemetry context for tracing.
    /// @throws Error carrying the category on `cause` if the clear fails.
    #[napi(writable = false)]
    pub async fn clear(&self, otel_context: HashMap<String, String>) -> napi::Result<()> {
        run(&self.propagator, &otel_context, self.state.clear()).await
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
