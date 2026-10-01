//! Provides a Node.js API wrapper for the Prosody admin client.
//!
//! This module allows for administrative operations on a Prosody cluster,
//! such as creating and deleting topics, through a JavaScript interface.

use crate::number::{milliseconds, whole};
use napi::{Either, Error};
use napi_derive::napi;
use prosody::admin::{AdminConfiguration, ProsodyAdminClient, TopicConfiguration};

/// Optional settings for a new topic.
#[napi(object)]
pub struct TopicOptions {
    /// The cleanup policy, such as `"delete"`, `"compact"`, or
    /// `"delete,compact"`.
    pub cleanup_policy: Option<String>,

    /// How long the topic keeps a message before deletion, in milliseconds.
    pub retention_ms: Option<f64>,
}

/// Represents a client for performing administrative operations on a Prosody
/// cluster.
#[napi]
pub struct AdminClient {
    client: ProsodyAdminClient,
}

#[napi]
impl AdminClient {
    /// Creates a new `AdminClient` instance.
    ///
    /// @param bootstrapServers - A single server address or an array of server
    /// addresses to connect to. @throws Error if the client cannot be
    /// created.
    #[napi(constructor, writable = false)]
    pub fn new(bootstrap_servers: Either<String, Vec<String>>) -> napi::Result<Self> {
        let bootstrap_servers = match bootstrap_servers {
            Either::A(server) => vec![server],
            Either::B(servers) => servers,
        };

        let admin_config = AdminConfiguration::new(bootstrap_servers)
            .map_err(|e| Error::from_reason(e.to_string()))?;

        let client = ProsodyAdminClient::new(&admin_config)
            .map_err(|e| Error::from_reason(e.to_string()))?;

        Ok(Self { client })
    }

    /// Creates a new topic in the Prosody cluster.
    ///
    /// @param name - The name of the topic to create.
    /// @param partitionCount - The number of partitions for the topic.
    /// @param replicationFactor - The replication factor for the topic.
    /// @param options - The cleanup policy and retention. The cluster default
    /// applies to each setting you omit.
    /// @throws Error if a number cannot convert or the topic creation fails.
    #[napi(writable = false)]
    pub async fn create_topic(
        &self,
        name: String,
        partition_count: f64,
        replication_factor: f64,
        options: Option<TopicOptions>,
    ) -> napi::Result<()> {
        let mut builder = TopicConfiguration::builder();
        builder
            .name(name)
            .partition_count(whole::<u16>(partition_count, "partitionCount")?)
            .replication_factor(whole::<u16>(replication_factor, "replicationFactor")?);
        if let Some(TopicOptions {
            cleanup_policy,
            retention_ms,
        }) = options
        {
            if let Some(policy) = cleanup_policy {
                builder.cleanup_policy(policy);
            }
            if let Some(value) = retention_ms {
                builder.retention(milliseconds(value, "retentionMs")?);
            }
        }
        let topic_config = builder
            .build()
            .map_err(|e| Error::from_reason(e.to_string()))?;

        self.client
            .create_topic(&topic_config)
            .await
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    /// Deletes a topic from the Prosody cluster.
    ///
    /// @param name - The name of the topic to delete.
    /// @throws Error if the topic deletion fails.
    #[napi(writable = false)]
    pub async fn delete_topic(&self, name: String) -> napi::Result<()> {
        self.client
            .delete_topic(&name)
            .await
            .map_err(|e| Error::from_reason(e.to_string()))
    }
}
