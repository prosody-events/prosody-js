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
    #[napi(writable = false)]
    pub async fn contains(
        &self,
        member: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<bool> {
        run(&self.propagator, &otel_context, self.state.contains(member)).await
    }

    /// Tests several members in one read.
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
    #[napi(writable = false)]
    pub async fn is_empty(&self, otel_context: HashMap<String, String>) -> napi::Result<bool> {
        run(&self.propagator, &otel_context, self.state.is_empty()).await
    }

    /// Adds `member` to the set.
    #[napi(writable = false)]
    pub async fn insert(
        &self,
        member: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<()> {
        run(&self.propagator, &otel_context, self.state.insert(member)).await
    }

    /// Removes `member` from the set.
    #[napi(writable = false)]
    pub async fn remove(
        &self,
        member: String,
        otel_context: HashMap<String, String>,
    ) -> napi::Result<()> {
        run(&self.propagator, &otel_context, self.state.remove(member)).await
    }

    /// Removes every member.
    #[napi(writable = false)]
    pub async fn clear(&self, otel_context: HashMap<String, String>) -> napi::Result<()> {
        run(&self.propagator, &otel_context, self.state.clear()).await
    }

    /// Opens a cursor over the selected members.
    #[napi(writable = false)]
    pub fn keys(&self, query: NativeKeyQuery) -> napi::Result<NativeKeyCursor> {
        Ok(NativeKeyCursor {
            cursor: self.state.keys().with_query(query.into_query()?).stream(),
            propagator: Arc::clone(&self.propagator),
        })
    }
}
