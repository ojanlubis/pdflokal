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

// The provider is driven above; this pins that the app actually HANDS it the
// reporter. Same source-scan precedent as pdf-builder-wiring.test.mjs: the
// wiring lives in modules that cannot load under node. Since 2026-10-10 the
// provider is built in js/v2/edit-bake.js and app.js hands its instance to the
// rasterizer; both halves are pinned, and the VACUITY guard below fails loudly
// if the provider call moves again rather than letting a slice of '' pass.
test('the bake-failure reporter is wired into the edited-page provider the rasterizer uses', async () => {
  const fs = await import('node:fs');
  const bake = fs.readFileSync(new URL('../../js/v2/edit-bake.js', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../../js/v2/app.js', import.meta.url), 'utf8');
  const at = bake.indexOf('createEditedPageProvider({');
  assert.ok(at >= 0, 'VACUITY: js/v2/edit-bake.js no longer builds the provider; repoint this test');
  const call = bake.slice(at);
  const body = call.slice(0, call.indexOf('});'));
  assert.match(body, /onBakeFailure:/, 'createEditedPageProvider must receive onBakeFailure');
  assert.match(body, /reportBakeFailure\(err,/, 'onBakeFailure must call the reporter');
  assert.match(app, /const \{ editedPageProvider[^}]*\} = editBake;/, 'app.js must take the provider from edit-bake.js');
  assert.match(app, /createPageRasterizer\(doc, \{ editedPageProvider \}\)/, 'the rasterizer must use this provider');
});

// Seat ruling 2026-10-01: a commit-bake capture must NOT trigger the on-error
// replay upload; every other error keeps it. In the vendored 10.55.0 bundle,
// replayIntegration calls beforeErrorSampling from its afterSendEvent handler
// with the SENT event, where captureException's tags sit at event.tags —
// probed against the bundle, with a normal error as control. This pins the
// predicate as written in js/sentry-init.js (read from the file, not retyped)
// against the tag the reporter actually sends.
test('sentry-init: a commit-bake error never uploads a replay; any other error still does', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../js/sentry-init.js', import.meta.url), 'utf8');
  const m = /beforeErrorSampling:\s*(\(event\)\s*=>[^\n]*?),\s*\n/.exec(src);
  assert.ok(m, 'replayIntegration must declare beforeErrorSampling');
  // eslint-disable-next-line no-eval
  const predicate = (0, eval)(m[1]);

  let sentTags;
  const report = createBakeFailureReporter({
    tel: () => {},
    getSentry: () => ({ withScope: (fn) => fn({ addEventProcessor() {} }), captureException: (e, ctx) => { sentTags = ctx.tags; } }),
  });
  report(new RangeError('x'), 'k');
  assert.equal(predicate({ tags: { ...sentTags, replayId: 'r' } }), false, 'commit-bake must not upload a replay');
  assert.equal(predicate({ tags: { replayId: 'r' } }), true, 'an ordinary error still uploads');
  assert.equal(predicate({}), true, 'an untagged error still uploads');
  // The rest of the replay config is untouched.
  assert.match(src, /replaysSessionSampleRate: 0\.10,/);
  assert.match(src, /replaysOnErrorSampleRate: 1\.0,/);
});

// Seat review 2026-10-01: the report used to run UNGUARDED and BEFORE the
// state reset. A throwing onBakeFailure (e.g. a key computation that trips on
// the same malformed page that broke the build) then rejected the provider and
// left the previous bake's editApplied/editOutcomes standing — rasterization
// broken by its own error witness.
test('a build throw AND a throwing onBakeFailure still resolve to null with state reset', async () => {
  const provider = createEditedPageProvider({
    getSource: () => ({ id: 's1' }),
    loadPdfLib: async () => ({ PDFLib: {}, fontkit: {} }),
    getSrcDoc: async () => ({}),
    build: async () => { throw new RangeError('bake'); },
    onBakeFailure: () => { throw new TypeError('reporter'); },
  });
  const page = editedPage();
  page.editApplied = new Set(['stale']);
  page.editOutcomes = [{ coverId: 'stale' }];
  assert.equal(await provider(page), null);
  assert.equal(page.editApplied, null, 'stale applied set must not survive a failed bake');
  assert.equal(page.editOutcomes, null, 'stale outcomes must not survive a failed bake');
});

// Privasi 2026-10-01: Sentry's default console integration records
// console.warn/error ARGUMENTS as breadcrumbs. export.js and page-surgery.js
// warn raw errors, and pdf-lib's WinAnsi encoder error quotes the character the
// user typed — so a later error event could carry document text. Pins the
// beforeBreadcrumb predicate as written in js/sentry-init.js (read from the
// file) and checks the alat-gambar.html copy declares the same one.
test('sentry-init: a console breadcrumb leaves the device content-free; other breadcrumbs are untouched', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../js/sentry-init.js', import.meta.url), 'utf8');
  const m = /beforeBreadcrumb:\s*(\(b\)\s*=>[^\n]*?),\s*\n/.exec(src);
  assert.ok(m, 'Sentry.init must declare beforeBreadcrumb');
  // eslint-disable-next-line no-eval
  const hook = (0, eval)(m[1]);

  const consoleCrumb = {
    category: 'console', level: 'warning', timestamp: 1,
    message: 'WinAnsi cannot encode "é" (0x00e9)',
    data: { arguments: ['WinAnsi cannot encode "é" (0x00e9)'], logger: 'console' },
  };
  const out = hook(consoleCrumb);
  assert.ok(out, 'the breadcrumb itself is kept');
  assert.equal(out.category, 'console');
  assert.equal(out.level, 'warning');
  assert.equal(out.timestamp, 1);
  assert.ok(!JSON.stringify(out).includes('é'), 'no typed character survives anywhere in the breadcrumb');
  assert.ok(!('arguments' in (out.data || {})), 'the raw arguments are dropped');

  const click = { category: 'ui.click', message: 'body > button#go', data: { x: 1 } };
  assert.deepEqual(hook(click), click, 'a non-console breadcrumb is untouched');

  const html = fs.readFileSync(new URL('../../alat-gambar.html', import.meta.url), 'utf8');
  assert.match(html, /beforeBreadcrumb:\s*\(b\)\s*=>[^\n]*category === 'console'/, 'the old wing carries the same hook');
});
