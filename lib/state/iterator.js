/**
 * Adapts a chunked native scan cursor to a JavaScript async iterator.
 * @module lib/state/iterator
 * @private
 */

const { injectedCarrier, toStateError } = require("./bridge");

/**
 * Adapts a chunked native scan cursor to the JS async iterator protocol.
 * Each native pull gets a fresh trace carrier and records no span. Each
 * `next()` call takes the next item of the held chunk without an N-API call.
 * A native `null` means the scan is done.
 *
 * `return()` runs on an early exit from a `for await` loop and awaits the
 * native `close()`. The end of the scan and a pull error also close the
 * cursor, and a finished cursor is never used again. The close after a pull
 * error is best effort and never hides that error. Any other close failure
 * goes through `toStateError`, so every failure a caller sees is a state
 * error.
 *
 * Owned cursors stay fenced to their attempt. Published cursors stay valid
 * with their reader.
 * @param {object} cursor - The native scan cursor.
 * @param {(item: *) => *} transform - Maps each raw item to the yielded value.
 * @returns {AsyncIterableIterator<*>} The async iterator.
 * @private
 */
function stateIterator(cursor, transform) {
  let finished = false;
  let chunk = [];
  let offset = 0;
  let queue = Promise.resolve();
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
    try {
      await cursor.close();
    } catch {
      /* the primary error is already propagating */
    }
  };
  // Close on clean exhaustion / early exit, where there is no primary error to
  // mask: a close failure surfaces through the state-error model.
  const closeOrThrow = async () => {
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
            chunk = await cursor.nextChunk(injectedCarrier());
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
          // The transform fails for a stored value that cannot be decoded,
          // which raises a PermanentStateError. Close the cursor and finish.
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
