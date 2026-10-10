/*
 * ?buat= IS USER INPUT, AND INTENT_COPY IS A PLAIN OBJECT.
 * ============================================================================
 * app.js arms the intent at module top level, straight from the query string.
 * `INTENT_COPY[intent]` on a plain object answers for inherited keys too:
 * `?buat=__proto__` yields Object.prototype (not callable), `?buat=valueOf`
 * yields a method that throws when called with no receiver. Either one threw
 * out of app.js before it finished booting, so a shared link could hand
 * someone a dead editor. An unknown intent must be a no-op, inherited or not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { applyIntentCopy, INTENT_COPY } = await import('../../js/v2/intent-copy.js');

test('1. inherited Object.prototype names are unknown intents, not crashes', () => {
  // Known-positive first: the instrument must be able to see a key that exists,
  // or a no-op below proves nothing.
  assert.equal(typeof INTENT_COPY.gabung, 'function', 'INTENT_COPY.gabung is gone, so this test cannot tell a no-op from a skip');
  for (const name of ['__proto__', 'valueOf', 'hasOwnProperty', 'toLocaleString', 'constructor', 'isPrototypeOf']) {
    assert.doesNotThrow(() => applyIntentCopy(name), `?buat=${name} threw out of applyIntentCopy, which kills app.js at boot`);
  }
});
