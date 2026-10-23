/*
 * A REPLACE (Ganti / Buka Baru) MUST REFUSE AN UNUSABLE FILE WHILE THE OLD DOC IS STILL THERE.
 * ============================================================================
 * Bug: both replace paths called resetDoc() and only THEN loadFiles(), whose
 * first act is to check the type and the size. A .docx or a >100 MB file passed
 * the first line of defence (the drop handler and the picker filter nothing),
 * wiped the document and its undo history, and left a blank editor.
 *
 * Two halves, because the fix has two claims:
 *   1. the checks are ONE rule with ONE home (core/incoming-files.js) and they
 *      say what loadFiles said: pickFile when nothing is usable, tooBig first
 *      oversize usable file;
 *   2. in app.js BOTH replace call sites (Ganti, Buka Baru) ask ONE guard
 *      (refuseReplace) BEFORE resetDoc, and that guard also refuses while a
 *      load is running (loadFiles would refuse after the wipe).
 *      app.js is not loadable headless, so this half EXECUTES the real source
 *      text of the guard and of both handlers against stubs (not a text-order
 *      check: break the logic and it goes red). Browser half:
 *      tests/drop-choice.spec.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APP = fs.readFileSync(path.join(ROOT, 'js/v2/app.js'), 'utf8');
const { checkIncoming, replaceRefusal, SIZE_BLOCK } = await import('../../js/core/incoming-files.js');

const file = (name, type, size = 10) => ({ name, type, size });

test('a PDF (by type or by extension) and an image are usable', async () => {
  const r = await checkIncoming([file('a.pdf', 'application/pdf'), file('b.PDF', ''), file('c.png', 'image/png')]);
  assert.equal(r.refusal, undefined);
  assert.deepEqual(r.usable.map((f) => f.name), ['a.pdf', 'b.PDF', 'c.png']);
});

test('only unusable types refuse with pickFile', async () => {
  const r = await checkIncoming([file('surat.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')]);
  assert.equal(r.refusal, 'pickFile');
  assert.equal((await checkIncoming([])).refusal, 'pickFile');
});

test('an unusable file next to a usable one is skipped, not a refusal', async () => {
  const r = await checkIncoming([file('x.docx', 'application/msword'), file('a.pdf', 'application/pdf')]);
  assert.equal(r.refusal, undefined);
  assert.deepEqual(r.usable.map((f) => f.name), ['a.pdf']);
});

test('an oversize usable file refuses with tooBig naming the first one', async () => {
  const big = SIZE_BLOCK + 1;
  const r = await checkIncoming([file('ok.pdf', 'application/pdf'), file('huge.pdf', 'application/pdf', big), file('huger.png', 'image/png', big)]);
  assert.equal(r.refusal, 'tooBig');
  assert.equal(r.name, 'huge.pdf');
  assert.equal((await checkIncoming([file('edge.pdf', 'application/pdf', SIZE_BLOCK)])).refusal, undefined, 'exactly 100 MB is allowed');
});

test('an oversize file of an unusable type is not "too big", it is skipped', async () => {
  const r = await checkIncoming([file('movie.mp4', 'video/mp4', SIZE_BLOCK + 1)]);
  assert.equal(r.refusal, 'pickFile');
});

// ---- the guard at the two call sites ----
const sliceFrom = (needle, len = 900) => {
  const i = APP.indexOf(needle);
  assert.ok(i >= 0, `anchor not found: ${needle}`);
  return APP.slice(i, i + len);
};

test('replaceRefusal: a running load wins, then the selection is checked', async () => {
  const pdf = [file('a.pdf', 'application/pdf')];
  assert.equal(await replaceRefusal({ loading: false, files: pdf }), null);
  assert.equal((await replaceRefusal({ loading: true, files: pdf })).refusal, 'stillLoading');
  assert.equal((await replaceRefusal({ loading: true, files: [file('x.docx', 'application/msword')] })).refusal, 'stillLoading');
  assert.equal((await replaceRefusal({ loading: false, files: [file('x.docx', 'application/msword')] })).refusal, 'pickFile');
  const tooBig = await replaceRefusal({ loading: false, files: [file('h.pdf', 'application/pdf', SIZE_BLOCK + 1)] });
  assert.deepEqual([tooBig.refusal, tooBig.name], ['tooBig', 'h.pdf']);
});

// ---- the REAL app.js source, executed against stubs ----------------------------------
// Cut a statement/function out of app.js by balanced brackets from its anchor.
function cut(anchor, open, close) {
  const start = APP.indexOf(anchor);
  assert.ok(start >= 0, `anchor not found: ${anchor}`);
  let i = open === '{' ? APP.slice(start).search(/\)\s*\{/) + start : start;
  i = APP.indexOf(open, i);
  let depth = 0;
  for (; i < APP.length; i++) {
    if (APP[i] === open) depth++;
    else if (APP[i] === close && --depth === 0) return APP.slice(start, i + 1) + (open === '(' ? ';' : '');
  }
  throw new Error(`unbalanced: ${anchor}`);
}

// Fresh world per scenario: the real guard + both real handlers, stub effects.
function world({ loading = false } = {}) {
  const calls = [];
  const dropped = { files: null };
  const handlers = {};
  const src = `
    let loadingFiles = ${loading}; let pendingReplace = false;
    ${cut('function toastRefusal(', '{', '}')}
    ${cut('async function refuseReplace(', '{', '}')}
    ${cut("on(fileInput, 'change'", '(', ')')}
    ${cut("on('dc-replace', 'click'", '(', ')')}
    return { setPending(v) { pendingReplace = v; }, getPending() { return pendingReplace; } };`;
  const env = {
    replaceRefusal,
    toast: (m) => calls.push(`toast:${m}`),
    tr: (k) => k,
    on: (target, ev, fn) => { handlers[typeof target === 'string' ? target : 'fileInput'] = fn; },
    fileInput: { value: 'x', setAttribute() {} },
    DEFAULT_ACCEPT: '',
    takeDropped: () => dropped.files,
    // resetDoc is no longer called from the handlers: loadFiles({ replace }) wipes
    // only once the new file has pages (tests/core/replace-keeps-doc.test.mjs).
    resetDoc: async () => { calls.push('resetDoc'); },
    loadFiles: async (_files, opts) => { calls.push(opts?.replace ? 'loadFiles:replace' : 'loadFiles'); },
  };
  const keys = Object.keys(env);
  const api = new Function(...keys, src)(...keys.map((k) => env[k]));
  return { calls, handlers, dropped, api };
}
const GOOD = [file('a.pdf', 'application/pdf')];
const DOCX = [file('x.docx', 'application/msword')];
const HUGE = [file('h.pdf', 'application/pdf', SIZE_BLOCK + 1)];

for (const [name, run] of [
  ['Ganti (dc-replace)', (w, files) => { w.dropped.files = files; return w.handlers['dc-replace'](); }],
  ['Buka Baru (picker change handler)', (w, files) => { w.api.setPending(true); return w.handlers.fileInput({ target: { files } }); }],
]) {
  test(`${name}: a usable pick with nothing running loads as a replace, wiping nothing itself`, async () => {
    const w = world();
    await run(w, GOOD);
    assert.deepEqual(w.calls, ['loadFiles:replace']);
  });
  test(`${name}: a load already running refuses BEFORE resetDoc (doc not wiped)`, async () => {
    const w = world({ loading: true });
    await run(w, GOOD);
    assert.deepEqual(w.calls, ['toast:toast.stillLoading']);
  });
  test(`${name}: an unusable pick refuses BEFORE resetDoc (doc not wiped)`, async () => {
    const w = world();
    await run(w, DOCX);
    assert.deepEqual(w.calls, ['toast:toast.pickFile']);
  });
  test(`${name}: an oversize pick refuses BEFORE resetDoc (doc not wiped)`, async () => {
    const w = world();
    await run(w, HUGE);
    assert.deepEqual(w.calls, ['toast:toast.tooBig']);
  });
}

test('the picker still APPENDS (no reset, no guard) when no replace is pending', async () => {
  const w = world({ loading: true });
  await w.handlers.fileInput({ target: { files: GOOD } });
  assert.deepEqual(w.calls, ['loadFiles'], 'loadFiles owns its own stillLoading refusal on the append path');
});

test('a refused Buka Baru clears pendingReplace', async () => {
  const w = world();
  w.api.setPending(true);
  await w.handlers.fileInput({ target: { files: DOCX } });
  assert.equal(w.api.getPending(), false);
});

test('both replace sites ask refuseReplace, then hand the wipe to loadFiles', async () => {
  assert.ok(!/refuseIncoming/.test(APP), 'refuseIncoming is gone; refuseReplace is the one guard');
  assert.equal([...APP.matchAll(/await refuseReplace\(files\)/g)].length, 2, 'exactly the two replace call sites');
  assert.ok(!/await resetDoc\(\)/.test(APP), 'no handler wipes before the file is decoded (replace-keeps-doc.test.mjs)');
});

test('loadFiles itself still uses the same rule (one rule, one home)', async () => {
  assert.ok(!/SIZE_BLOCK\s*=/.test(APP), 'app.js must not redefine the size limit');
  assert.match(sliceFrom('async function loadFilesInner', 800), /checkIncoming\(/);
});
