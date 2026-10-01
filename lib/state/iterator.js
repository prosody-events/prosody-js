/**
 * Adapts a chunked native scan cursor to a JavaScript async iterator.
 * @module lib/state/iterator
 * @private
 */

const { injectedCarrier, toStateError } = require("./bridge");

/**
 * Adapts a chunked native scan cursor to an async generator. Each native pull
 * gets a fresh trace carrier and records no span. Each `next()` call takes the
 * next item of the held chunk without an N-API call. A native `null` means
 * the scan is done. The generator queues concurrent `next()` and `return()`
 * calls, so no item is yielded twice and no close runs during a pull.
 *
 * The end of the scan, an early exit from a `for await` loop, and a pull or
 * decode error all close the cursor. Every failure a caller sees goes through
 * `toStateError`.
 *
 * Owned cursors stay fenced to their attempt. Published cursors stay valid
 * with their reader.
 * @param {object} cursor - The native scan cursor.
 * @param {(item: *) => *} transform - Maps each raw item to the yielded value.
 * @returns {AsyncGenerator<*>} The async iterator.
 * @private
 */
async function* stateIterator(cursor, transform) {
  let failed = false;
  try {
    for (;;) {
      const chunk = await cursor.nextChunk(injectedCarrier());
      if (chunk === null) return;
      for (let index = 0; index < chunk.length; index += 1) {
        const item = chunk[index];
        // Release consumed values even while the rest of a large chunk remains.
        chunk[index] = undefined;
        yield transform(item);
      }
    }
  } catch (error) {
    failed = true;
    throw toStateError(error);
  } finally {
    await close(cursor, failed);
  }
}

/**
 * Closes a native scan cursor. After a failure the close is best effort and
 * never hides that error.
 * @param {object} cursor - The native scan cursor.
 * @param {boolean} quietly - Whether to ignore a close failure.
 * @returns {Promise<void>} Resolves when the cursor is closed.
 * @private
 */
async function close(cursor, quietly) {
  try {
    await cursor.close();
  } catch (error) {
    if (!quietly) throw toStateError(error);
  }
}

module.exports = {
  stateIterator,
};
