/*
 * A COMMIT-TIME BAKE THROW IS REPORTED — rail failure/commit + Sentry, scrubbed.
 * ============================================================================
 * LIVE (2026-09-24..29, Turso): 4 phone sessions, 2 visitors, 33 export
 * RangeErrors, zero files. Every one of those sessions had already broken at
 * COMMIT: buildEditedPageBytes threw, the edited-page provider swallowed it and
 * repainted the untouched source, and the rail saw `commit_paint` + a
 * near-parity `visual_oracle` (the page compared with itself) and no error at
 * all. Sentry saw nothing either: nothing in js/ ever called captureException.
 *
 * These drive the REAL provider (js/v2/edited-page-provider.js) with a build
 * that throws. Against the pre-fix catch — swallow, warn, return null — the
 * first test is red: no failure event, no capture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createEditedPageProvider } from '../../js/v2/edited-page-provider.js';
import { createBakeFailureReporter, scrubbedError, safeErrorMessage, BAKE_FAILURE_CAP } from '../../js/v2/bake-failure.js';
import { validateEvent } from '../../js/core/telemetry-schema.js';

// A page carrying one committed Ganti pair — the same shape page-surgery.js's
// pageEdits filter counts as an edit, so editSignature(page) is non-empty and
// the provider actually reaches the build.
function editedPage(id = 'p1', text = 'Rapat Baru') {
  return {
    id,
    sourceId: 's1',
    sourcePageNum: 0,
    annotations: [
      { id: `${id}-c`, type: 'whiteout', x: 0, y: 0, width: 10, height: 10,
        replaceTargets: [{ x0: 1, y0: 2, ux: 1, uy: 0, size: 12, len: 50 }], replaceBox: { x: 0, y: 0, w: 10, h: 10 } },
      { id: `${id}-t`, type: 'text', text, replaceCoverId: `${id}-c` },
    ],
  };
}

function harness(build) {
  const events = [];
  const captures = [];
  const processors = [];
  const sentry = {
    withScope(fn) { fn({ addEventProcessor: (p) => processors.push(p) }); },
    captureException(err, ctx) { captures.push({ err, ctx }); },
  };
  const report = createBakeFailureReporter({ tel: (name, props) => events.push([name, props]), getSentry: () => sentry });
  const provider = createEditedPageProvider({
    getSource: () => ({ id: 's1', bytes: new Uint8Array([1]) }),
    loadPdfLib: async () => ({ PDFLib: {}, fontkit: {} }),
    getSrcDoc: async () => ({}),
    build,
    // Same key app.js uses: page id + edit signature.
    onBakeFailure: (err, page) => report(err, `${page.id}:${JSON.stringify(page.annotations.map((a) => a.text ?? null))}`),
  });
  return { events, captures, processors, provider };
}

// The document's own words, as a thrown message might quote them.
const SECRET = 'Budi Rahasia';

test('a bake that throws reports failure/commit + failure_cause to the rail, enums only', async () => {
  const thrown = new RangeError('Offset is outside the bounds of the DataView');
  const { events, provider } = harness(async () => { throw thrown; });
  const page = editedPage();

  const out = await provider(page);
  assert.equal(out, null, 'the fallback is unchanged: plain source render');
  assert.equal(page.editOutcomes, null);

  assert.deepEqual(events, [
    ['failure', { stage: 'commit', reason: 'unknown', class: 'none', blocked: false }],
    ['failure_cause', { stage: 'commit', name: 'RangeError', hint: 'none' }],
  ]);
  // api/t.js runs this same validator and drops off-schema events silently.
  for (const [name, props] of events) assert.equal(validateEvent(name, props).ok, true, `${name} must pass the shared schema`);
});

test('the same bake throw reaches Sentry, scrubbed, tagged, with no breadcrumbs', async () => {
  const thrown = new Error(`WinAnsi cannot encode "${SECRET}" (0x2009)`);
  const { events, captures, processors, provider } = harness(async () => { throw thrown; });
  await provider(editedPage());

  assert.equal(captures.length, 1, 'captureException must be called once');
  const { err, ctx } = captures[0];
  assert.notEqual(err, thrown, 'the original error object must never be handed to Sentry');
  assert.deepEqual(ctx, { tags: { stage: 'commit-bake' } });
  assert.equal(err.message, '[scrubbed]');
  assert.ok(!String(err.stack).includes(SECRET), 'the stack must not carry the message');
  assert.match(String(err.stack), /\n\s+at /, 'stack frames are kept — they are the point');

  // Breadcrumbs: this event goes out with none.
  assert.equal(processors.length, 1);
  const ev = processors[0]({ breadcrumbs: [{ message: `console: ${SECRET}` }] });
  assert.deepEqual(ev.breadcrumbs, []);

  // And nothing on the rail carries a string.
  assert.ok(!JSON.stringify(events).includes(SECRET));
  // A `cannot encode` throw is failureReason's 'unsupported' — but commit/
  // unsupported already MEANS "an unencodable character was committed"
  // (js/v2/app.js). It must not be redefined (EXCLUDE 4).
  assert.equal(events[0][1].reason, 'unknown');
  assert.deepEqual(events[1][1], { stage: 'commit', name: 'Error', hint: 'encode' });
});

test('one report per edit state, capped per session; a successful bake reports nothing', async () => {
  let fail = true;
  const { events, captures, provider } = harness(async () => {
    if (fail) throw new RangeError('Invalid array length');
    return { bytes: new Uint8Array([1]), applied: new Set(), outcomes: [] };
  });
  const page = editedPage('p1');
  await provider(page);
  await provider(page); // a re-render of the SAME broken state (zoom, scroll back)
  assert.equal(captures.length, 1);
  assert.equal(events.filter(([n]) => n === 'failure').length, 1);

  for (let i = 0; i < BAKE_FAILURE_CAP + 3; i += 1) await provider(editedPage('p1', `ganti ${i}`));
  assert.equal(captures.length, BAKE_FAILURE_CAP, 'capped per session');

  fail = false;
  const before = events.length;
  await provider(editedPage('p2', 'ok'));
  assert.equal(events.length, before, 'a successful bake fires nothing from the provider');
});

test('a reporter that throws never breaks the fallback', async () => {
  const provider = createEditedPageProvider({
    getSource: () => ({ id: 's1' }),
    loadPdfLib: async () => ({ PDFLib: {}, fontkit: {} }),
    getSrcDoc: async () => ({}),
    build: async () => { throw new RangeError('x'); },
    onBakeFailure: createBakeFailureReporter({ tel: () => { throw new Error('rail down'); } }),
  });
  assert.equal(await provider(editedPage()), null);
});

test('safeErrorMessage keeps only allowlisted engine wordings, digits collapsed', () => {
  assert.equal(safeErrorMessage(new RangeError('Offset is outside the bounds of the DataView')), 'Offset is outside the bounds of the DataView');
  assert.equal(safeErrorMessage(new RangeError('Invalid typed array length: 4294967296')), 'Invalid typed array length: #');
  assert.equal(safeErrorMessage(new RangeError('Out of bounds access')), 'Out of bounds access');
  assert.equal(safeErrorMessage(new TypeError("Cannot read properties of undefined (reading 'italicAngle')")),
    "Cannot read properties of undefined (reading 'italicAngle')");
  // Anything that can carry the document is refused, never trimmed.
  for (const m of [
    `WinAnsi cannot encode "${SECRET}" (0x0041)`,
    '0x1F600 is not a valid UTF-8 or UTF-16 codepoint.',
    `No glyph for ${SECRET}`,
    `Unrecognized stream type: /${SECRET}`,
    "Cannot read properties of undefined (reading 'Budi Rahasia')",
    'Invalid code point 66',
  ]) {
    assert.equal(safeErrorMessage(new Error(m)), '[scrubbed]', m);
  }
});

test('scrubbedError keeps JavaScriptCore/SpiderMonkey frames and drops everything else', () => {
  const err = new RangeError(SECRET);
  err.stack = 'save@https://www.pdflokal.id/js/vendor/pdf-lib.min.js:1:2345\ncopyPages@https://www.pdflokal.id/js/vendor/pdf-lib.min.js:1:999';
  const s = scrubbedError(err);
  assert.equal(s.name, 'RangeError');
  assert.equal(s.message, '[scrubbed]');
  assert.equal(s.stack.split('\n').length, 2);
  // V8: message lines are dropped, `at` lines kept.
  const v8 = new RangeError(`line one ${SECRET}\nline two ${SECRET}`);
  const sv = scrubbedError(v8);
  assert.ok(!sv.stack.includes(SECRET));
  assert.match(sv.stack, /^RangeError: \[scrubbed\]\n\s+at /);
});

test('scrubbedError keeps an identifier-shaped constructor name, never a message-shaped one', () => {
  const lib = new Error('x');
  lib.name = 'UnexpectedObjectTypeError';
  assert.equal(scrubbedError(lib).name, 'UnexpectedObjectTypeError');
  const odd = new Error('x');
  odd.name = `${SECRET} Error`;
  assert.equal(scrubbedError(odd).name, 'Error');
});

// The provider is driven above; this pins that app.js actually HANDS it the
// reporter. Same source-scan precedent as pdf-builder-wiring.test.mjs: the
// wiring lives in a module that cannot load under node.
test('app.js wires the bake-failure reporter into the edited-page provider', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../js/v2/app.js', import.meta.url), 'utf8');
  const call = src.slice(src.indexOf('createEditedPageProvider({'));
  const body = call.slice(0, call.indexOf('});'));
  assert.match(body, /onBakeFailure:/, 'createEditedPageProvider must receive onBakeFailure');
  assert.match(body, /reportBakeFailure\(err,/, 'onBakeFailure must call the reporter');
  assert.match(src, /createPageRasterizer\(doc, \{ editedPageProvider \}\)/, 'the rasterizer must use this provider');
});
