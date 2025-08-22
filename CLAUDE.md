# Development Guidelines for Claude

## Documentation Standards

### Rust Code with NAPI-RS v3
- **ALWAYS use standard Rust documentation format (`///`) for documentation in Rust files that use NAPI-RS v3**
- Do NOT use JSDoc format (`/** */`) in NAPI-RS v3 files
- NAPI-RS v3 expects standard Rust documentation comments and converts them to proper TypeScript definitions
- Use Rust-style sections like `# Arguments`, `# Errors`, etc.

### Example of CORRECT documentation in `src/client/mod.rs`:
```rust
/// Sends a message to a specified topic.
/// 
/// @param topic The topic to send the message to
/// @param key The key of the message
/// @param payload The payload of the message
/// @returns A promise that resolves when the message has been sent
/// @throws Error if the send operation fails
```

### Example of INCORRECT documentation (do not use):
```rust
/// Sends a message to a specified topic.
///
/// # Arguments
///
/// * `topic` - The topic to send the message to
/// * `key` - The key of the message
///
/// # Errors
///
/// Returns an error if the send operation fails.
```

## Testing
- Run tests with: `npm test`
- Run linting with: `npm run lint` (if available)
- Run type checking with: `npm run typecheck` (if available)