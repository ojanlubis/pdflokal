/*
 * A DROPPED SCRIPT IS NOT A VERDICT: core/vendor.js tries a vendor script twice.
 * ============================================================================
 * Rail 2026-09-18..09-30: five export sessions, `export/unknown`, cause
 * Error/glyph (the fontkit script) or Error/none (the pdf-lib script). Three of
 * them had no edit at all — a photo or an untouched PDF — which is the one
 * thing they share: pdf-lib + fontkit (~1.2 MB) are fetched for the first time
 * at the moment of Unduh, on whatever network the phone has then. One refused
 * request failed the whole build, and the user retried against a stored error.
 *
 * The DOM is faked, because the loader's only dependency is `document`: an
 * attempt is a <script> element, success is its onload and failure its onerror.
 * The browser-level proof (a real route abort, a real download) is
 * tests/export-vendor-load.spec.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

function fakeDom(outcomes) {
  const created = [];
  const queue = [...outcomes];
  globalThis.window = {};
  globalThis.document = {
    createElement() {
      const el = { removed: false, remove() { this.removed = true; } };
      created.push(el);
      return el;
    },
    head: {
      appendChild(el) {
        const ok = queue.length ? queue.shift() : true;
        queueMicrotask(() => (ok ? el.onload() : el.onerror()));
      },
    },
  };
  return created;
}

// A fresh module instance per test: `inflight` is module state.
let n = 0;
const load = () => import(`../../js/core/vendor.js?t=${n++}`);

test('1. one refused request is retried and the load succeeds', async () => {
  const created = fakeDom([false, true]);
  const { ensureFontkit } = await load();
  await ensureFontkit();
  assert.equal(created.length, 2, 'a second <script> was attempted');
  assert.equal(created[0].removed, true, 'the dead tag of the failed attempt is removed');
  assert.equal(created[1].removed, false);
});

test('2. when every attempt fails the error is flagged, and a later call tries again', async () => {
  const { LOAD_ATTEMPTS, ensureFontkit } = await load();
  const created = fakeDom(Array(LOAD_ATTEMPTS).fill(false));
  await assert.rejects(ensureFontkit(), (err) => {
    assert.equal(err.vendorLoadFailed, true);
    assert.match(err.message, /fontkit\.umd\.min\.js/);
    return true;
  });
  assert.equal(created.length, LOAD_ATTEMPTS);
  // The rejection is not cached: the user's next tap gets a fresh load, which now succeeds.
  await ensureFontkit();
  assert.equal(created.length, LOAD_ATTEMPTS + 1);
});

test('3. concurrent callers share one load, retries included', async () => {
  const created = fakeDom([false, true]);
  const { ensureFontkit } = await load();
  await Promise.all([ensureFontkit(), ensureFontkit(), ensureFontkit()]);
  assert.equal(created.length, 2);
});
