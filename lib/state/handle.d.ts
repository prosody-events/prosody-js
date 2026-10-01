/**
 * The commit and rollback methods of every state handle, and their outcome.
 * @module lib/state/handle
 */

/**
 * The effect of `commit()` or `rollback()`. `"applied"` means the call wrote or
 * discarded buffered operations. `"noOp"` means nothing was buffered.
 */
export type StoreOutcome = "applied" | "noOp";

/** The commit and rollback methods of every state handle. */
export interface StateTransaction {
  /**
   * Durably commits the buffered operations mid-handler (at-least-once). The
   * committed changes survive a later rollback or a failed event. Resolves to
   * `"applied"` when it wrote buffered operations, or `"noOp"`.
   */
  commit(): Promise<StoreOutcome>;
  /**
   * Discards buffered uncommitted operations back to the committed floor.
   * Resolves to `"applied"` when it discarded buffered operations, or `"noOp"`.
   */
  rollback(): Promise<StoreOutcome>;
}
