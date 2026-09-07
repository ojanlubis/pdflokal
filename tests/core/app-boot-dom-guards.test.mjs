/*
 * ONE MISSING ELEMENT MUST COST ONE CONTROL, NOT THE WHOLE MODULE.
 * ============================================================================
 * `js/v2/app.js` binds its listeners at MODULE TOP LEVEL. A top-level
 * `document.getElementById('fm-pages').addEventListener(...)` throws the moment
 * that id is absent — and a throw at module top level aborts the whole graph.
 * The user gets no editor, no toolbar, and NO TELEMETRY, because
 * js/v2/telemetry.js is in the same dead graph.
 *
 * That is not hypothetical. Sentry JAVASCRIPT-V/J, 6 events, 2026-08-18 →
 * 2026-08-30: `null is not an object (evaluating
 * "document.getElementById('fm-pages').addEventListener")`, culprit
 * `module code(app)`. Every page on disk has carried that id since 2026-08-09,
 * so what those users hit was a STALE HTML served beside a fresh app.js — one
 * absent element, and the entire product died.
 *
 * THE PROPERTY: no top-level statement in app.js dereferences a DOM lookup that
 * can return null. Every top-level binding goes through the `on()` helper,
 * which declines on a missing element and returns null.
 *
 * ⚠️ TWO SHAPES, AND THE SECOND ONE IS THE ONE THAT GETS MISSED. The chained
 * `document.getElementById(...).addEventListener` is obvious. The other is a
 * top-level `const btn = document.getElementById(...)` followed later, still at
 * top level, by `btn.addEventListener(...)` — different spelling, identical
 * failure, and it was NOT in the incident's stack trace because it happened to
 * bind an element that was present. A guard placed where the bug was seen
 * protects that place, not the class.
 *
 * `document.` and `window.` bindings are deliberately NOT violations: those two
 * are never null.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APP = path.join(ROOT, 'js/v2/app.js');

const CHAINED = /^document\.(?:getElementById|querySelector)\([^)]*\)\s*\.\s*(?:addEventListener|onclick)\b/;
const BOUND = /^([A-Za-z_$][\w$]*)\s*\.\s*(?:addEventListener|onclick)\b/;

// Scans RAW lines, not comment-stripped source, so the reported line numbers are
// the real ones. Column 0 is the top-level test: this file indents everything
// inside a function or a block, and a comment line never starts with a bare
// identifier or `document.` at column 0.
function scan(src) {
  const domConsts = new Set();
  for (const m of src.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*document\.(?:getElementById|querySelector)\(/gm)) {
    domConsts.add(m[1]);
  }
  const violations = [];
  src.split('\n').forEach((line, i) => {
    if (CHAINED.test(line)) { violations.push({ line: i + 1, why: 'chained', text: line.trim().slice(0, 90) }); return; }
    const m = BOUND.exec(line);
    if (m && domConsts.has(m[1])) violations.push({ line: i + 1, why: `bound to ${m[1]}`, text: line.trim().slice(0, 90) });
  });
  return { domConsts, violations };
}

test('0. POSITIVE CONTROL — the scanner can actually see both shapes', () => {
  // Without this, a regex that stopped matching would report a clean file and
  // the assertion below would pass having proved nothing. Same class as the
  // vacuity guards in telemetry-liveness.test.mjs.
  const fake = [
    "const btn = document.getElementById('x');",
    "document.getElementById('a').addEventListener('click', f);",
    "document.getElementById('b').onclick = f;",
    "btn.addEventListener('click', f);",
    "document.addEventListener('keydown', f);", // never null — not a violation
    "window.addEventListener('error', f);", // same
    "  document.getElementById('c').addEventListener('click', f);", // indented = not top level
    "on('d', 'click', f);", // the guarded form
  ].join('\n');
  const { violations } = scan(fake);
  assert.equal(violations.length, 3, `the scanner found ${violations.length} of the 3 planted violations: ${JSON.stringify(violations)}`);
  assert.deepEqual(violations.map((v) => v.line), [2, 3, 4]);
});

test('1. no top-level DOM dereference in app.js can kill the module', () => {
  const src = fs.readFileSync(APP, 'utf8');
  const { domConsts, violations } = scan(src);

  // VACUITY: if this file stopped binding elements at top level, the assertion
  // below would pass for the wrong reason.
  assert.ok(domConsts.size >= 10, `only ${domConsts.size} top-level DOM consts found — the scanner moved`);

  assert.deepEqual(
    violations, [],
    `js/v2/app.js dereferences a DOM lookup at module top level in ${violations.length} place(s).\n`
    + 'Any one of these throws when a skewed deploy serves HTML without that id, and a throw at\n'
    + 'module top level takes the editor, the toolbar and the telemetry rail with it.\n'
    + 'Bind through on(idOrElement, type, handler) instead — it declines on a missing element.\n'
    + violations.map((v) => `  app.js:${v.line}  (${v.why})  ${v.text}`).join('\n'),
  );
});

/* ---------------------------------------------------------------------------
 * The helper's BEHAVIOUR, not its spelling. app.js cannot be imported in node
 * (it reaches for the DOM at import time, which is the whole subject here), so
 * the `on()` declaration is lifted out and run against stubs. If someone
 * "simplifies" it back into `document.getElementById(id).addEventListener(...)`
 * this goes red even though the scan above would still be clean.
 * ------------------------------------------------------------------------- */
function liftOn() {
  const src = fs.readFileSync(APP, 'utf8');
  const start = src.search(/^function on\(/m);
  assert.ok(start !== -1, 'js/v2/app.js no longer declares `function on(` at top level');
  // Balance braces from the first `{` after the signature.
  const open = src.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end !== -1, 'could not find the end of on() — the extractor is broken');
  const body = src.slice(start, end);
  assert.ok(body.length > 60 && body.length < 900, `lifted on() is ${body.length} chars — that is not the helper`);
  return body;
}

function makeOn(present) {
  const bound = [];
  const els = new Map();
  for (const id of present) {
    els.set(id, { id, addEventListener: (t, h, o) => bound.push({ id, t, h, o }) });
  }
  const document = { getElementById: (id) => els.get(id) || null };
  // eslint-disable-next-line no-new-func
  const fn = new Function('document', `${liftOn()}\nreturn on;`)(document);
  return { on: fn, bound, els };
}

test('2. on() binds when the element is there', () => {
  const { on, bound, els } = makeOn(['btn-pages']);
  const noop = () => {};
  const ret = on('btn-pages', 'click', noop);
  assert.equal(bound.length, 1);
  assert.deepEqual({ id: bound[0].id, t: bound[0].t }, { id: 'btn-pages', t: 'click' });
  assert.equal(bound[0].h, noop, 'on() did not pass the handler through');
  assert.equal(ret, els.get('btn-pages'), 'on() should hand back the element it bound');
});

test('3. on() DECLINES on a missing element — it does not throw, and it does not bind', () => {
  const { on, bound } = makeOn(['btn-pages']);
  let ret;
  assert.doesNotThrow(() => { ret = on('fm-pages', 'click', () => {}); },
    'on() threw for a missing element. That is the original defect: this call is at module top '
    + 'level, so the throw aborts the entire module graph — editor, toolbar and telemetry at once.');
  assert.equal(ret, null, 'on() must return null for a missing element, never undefined-by-accident');
  assert.equal(bound.length, 0, 'on() bound a listener to nothing');
});

test('4. on() accepts an already-resolved element, not only an id', () => {
  const { on, bound, els } = makeOn(['v2-scroll']);
  const el = els.get('v2-scroll');
  on(el, 'wheel', () => {});
  assert.equal(bound.length, 1, 'on() did not bind when handed the element directly');
  // ...and a null const (the same skew, one line earlier) still declines.
  assert.doesNotThrow(() => on(null, 'wheel', () => {}));
  assert.equal(bound.length, 1, 'on(null, …) bound something');
});

test('5. on() forwards listener options — a guard that silently drops {passive:false} changes behaviour', () => {
  const { on, bound } = makeOn(['v2-scroll']);
  on('v2-scroll', 'touchmove', () => {}, { passive: false });
  assert.deepEqual(bound[0].o, { passive: false },
    'on() dropped the listener options. js/v2/app.js binds non-passive touch handlers to be able to '
    + 'preventDefault() during a pinch; swallowing the flag makes the gesture stop working and no '
    + 'test that only counts bindings would notice.');
});
