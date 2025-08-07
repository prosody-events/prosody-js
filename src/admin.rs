//! Provides a Node.js API wrapper for the Prosody admin client.
//!
//! This module allows for administrative operations on a Prosody cluster,
//! such as creating and deleting topics, through a JavaScript interface.

use napi::{Either, Error};
use napi_derive::napi;
use prosody::admin::ProsodyAdminClient;

/**
 * Represents a client for performing administrative operations on a Prosody cluster.
 */
#[napi]
pub struct AdminClient {
  client: ProsodyAdminClient,
}

#[napi]
impl AdminClient {
  /**
   * Creates a new `AdminClient` instance.
   *
   * @param bootstrapServers - A single server address or an array of server addresses to connect to.
   * @throws Error if the client cannot be created.
   */
  #[napi(constructor, writable = false)]
  pub fn new(bootstrap_servers: Either<String, Vec<String>>) -> napi::Result<Self> {
    let bootstrap_servers = match bootstrap_servers {
      Either::A(server) => vec![server],
      Either::B(servers) => servers,
    };

    let client =
      ProsodyAdminClient::new(&bootstrap_servers).map_err(|e| Error::from_reason(e.to_string()))?;

    Ok(Self { client })
  }

  /**
   * Creates a new topic in the Prosody cluster.
   *
   * @param name - The name of the topic to create.
   * @param partitionCount - The number of partitions for the topic.
   * @param replicationFactor - The replication factor for the topic.
   * @throws Error if the topic creation fails.
   */
  #[napi(writable = false)]
  pub async fn create_topic(
    &self,
    name: String,
    partition_count: u16,
    replication_factor: u16,
  ) -> napi::Result<()> {
    self
      .client
      .create_topic(&name, partition_count, replication_factor)
      .await
      .map_err(|e| Error::from_reason(e.to_string()))
  }

  /**
   * Deletes a topic from the Prosody cluster.
   *
   * @param name - The name of the topic to delete.
   * @throws Error if the topic deletion fails.
   */
  #[napi(writable = false)]
  pub async fn delete_topic(&self, name: String) -> napi::Result<()> {
    self
      .client
      .delete_topic(&name)
      .await
      .map_err(|e| Error::from_reason(e.to_string()))
  }
}
