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

// doesNotThrow above is satisfied by a no-op: an applyIntentCopy that returned
// at once (the early-return mutation) passed it while every ?buat= link lost its
// words. Stub the DOM and assert the BEHAVIOUR: a known intent writes the
// dropzone title, an inherited name writes nothing.
test('2. a known intent re-words the page; an inherited name writes nothing', () => {
  const written = new Map();
  const realDocument = globalThis.document;
  globalThis.document = {
    querySelector: (sel) => {
      const el = {};
      Object.defineProperty(el, 'textContent', { set(v) { written.set(sel, v); }, get() { return written.get(sel); } });
      return el;
    },
  };
  try {
    for (const name of ['__proto__', 'valueOf', 'constructor']) applyIntentCopy(name);
    assert.deepEqual([...written.keys()], [], 'an inherited key must write nothing');

    applyIntentCopy('gabung');
    const title = written.get('.dz-title');
    assert.equal(typeof title, 'string', '?buat=gabung must write the dropzone title');
    assert.ok(title.length > 0, 'the written title is not empty');
    assert.equal(title, INTENT_COPY.gabung().dzTitle, 'it writes gabung\'s own title');
    assert.equal(written.get('.dz-hint'), INTENT_COPY.gabung().dzHint);
  } finally {
    if (realDocument === undefined) delete globalThis.document; else globalThis.document = realDocument;
  }
});
