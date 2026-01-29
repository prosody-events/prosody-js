#![allow(clippy::multiple_crate_versions)]

//! This crate provides Node.js bindings for the Prosody library, offering a
//! high-level client for interacting with Kafka-like message brokers. It
//! includes functionality for administration, client operations, message
//! handling, and logging integration.
//!
//! The crate is organized into several modules, each responsible for a specific
//! aspect of the library's functionality:

/// Module for handling administrative operations on a Prosody cluster.
mod admin;

/// Module for managing client-side operations and interactions with the message
/// broker.
mod client;

/// Module for providing context-related functionality for message processing.
mod context;

/// Module containing event handlers and message processing logic.
mod handler;

/// Module for managing logging operations and integration with JavaScript
/// logging.
mod logging;

/// Module dealing with message-related functionality and structures.
mod message;

/// Module dealing with timer-related functionality and structures.
mod timer;
