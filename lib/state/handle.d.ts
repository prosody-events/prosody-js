/**
 * The outcome that commit and rollback report on every state handle.
 * @module lib/state/handle
 */

/**
 * The effect of `commit()` or `rollback()`. `"applied"` means the call wrote or
 * discarded buffered operations. `"noOp"` means nothing was buffered.
 */
export type StoreOutcome = "applied" | "noOp";
