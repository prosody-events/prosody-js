/**
 * Adapts a chunked native scan cursor to a JavaScript async iterator.
 * @module lib/state/iterator
 * @private
 */

const { injectedCarrier, toStateError } = require("./bridge");

/**
 * Adapts a chunked native scan cursor to the item-oriented JS async-iterator
 * protocol. A fresh carrier is propagated per native chunk without recording
 * a span, while individual `next()` calls drain the retained chunk without
 * crossing N-API.
 * Native `null` (exhausted) maps to `{ done: true }`. Early exit from a `for await` loop
 * (`break`/`return`/`throw`) invokes `return()`, which awaits the native
 * `close()`; exhaustion and a pull error also close the cursor. Once finished,
 * the cursor is never touched again. A pull error is never masked by the
 * cleanup close (that close is best-effort). A close failure on the exhaustion
 * or early-exit path is normalized through `toStateError`, so every keyed-state
 * failure a caller can observe is a `PermanentStateError`/`TransientStateError`.
 *
 * Owned cursors remain attempt-fenced. Published cursors remain valid with
 * their standalone reader.
 * @param {object|(() => object)} source - The native scan cursor, or a lazy
 *   cursor opener.
 * @param {(item: *) => *} transform - Maps each raw item to the yielded value.
 * @returns {AsyncIterableIterator<*>} The async iterator.
 * @private
 */
function stateIterator(source, transform) {
  let cursor;
  let finished = false;
  let chunk = [];
  let offset = 0;
  let queue = Promise.resolve();
  const openCursor = async () => {
    if (cursor === undefined) {
      cursor = typeof source === "function" ? source() : source;
    }
    return cursor;
  };
  // Serialize the complete iterator protocol, not just native pulls. Without
  // this queue, concurrent next() continuations can both reset `offset` after
  // awaiting the same chunk and yield the same first item. return() shares the
  // queue so it cannot close the cursor underneath an active next().
  const enqueue = (operation) => {
    const result = queue.then(operation, operation);
    // A rejected operation must not poison later cleanup or done checks.
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  // Best-effort close used after a pull or transform failure: it must never
  // mask the primary error. `try/catch` (not `.catch()`) so a synchronous throw
  // from `close()` is swallowed too.
  const closeQuietly = async () => {
    if (cursor === undefined) return;
    try {
      await cursor.close();
    } catch {
      /* the primary error is already propagating */
    }
  };
  // Close on clean exhaustion / early exit, where there is no primary error to
  // mask: a close failure surfaces through the state-error model.
  const closeOrThrow = async () => {
    if (cursor === undefined) return;
    try {
      await cursor.close();
    } catch (error) {
      throw toStateError(error);
    }
  };
  return {
    next() {
      return enqueue(async () => {
        if (finished) return { value: undefined, done: true };
        while (offset >= chunk.length) {
          chunk = [];
          offset = 0;
          try {
            chunk = await (await openCursor()).nextChunk(injectedCarrier());
          } catch (error) {
            finished = true;
            await closeQuietly();
            throw toStateError(error);
          }
          if (chunk === null) {
            chunk = [];
            finished = true;
            await closeOrThrow();
            return { value: undefined, done: true };
          }
        }
        const item = chunk[offset];
        // Release consumed values even while the rest of a large chunk remains.
        chunk[offset] = undefined;
        offset += 1;
        try {
          return { value: transform(item), done: false };
        } catch (error) {
          // A transform failure is a binding defect, not a store error; close the
          // cursor and mark the iterator done rather than leaving it live.
          finished = true;
          await closeQuietly();
          throw error;
        }
      });
    },
    return(value) {
      return enqueue(async () => {
        if (!finished) {
          finished = true;
          chunk = [];
          offset = 0;
          await closeOrThrow();
        }
        return { value, done: true };
      });
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

module.exports = {
  stateIterator,
};
