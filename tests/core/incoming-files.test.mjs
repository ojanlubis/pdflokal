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
 *   2. in app.js the check runs BEFORE resetDoc at both replace call sites.
 *      That half is static (app.js is not loadable headless); the browser half
 *      is tests/drop-choice.spec.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APP = fs.readFileSync(path.join(ROOT, 'js/v2/app.js'), 'utf8');
const { checkIncoming, SIZE_BLOCK } = await import('../../js/core/incoming-files.js');

const file = (name, type, size = 10) => ({ name, type, size });

test('a PDF (by type or by extension) and an image are usable', () => {
  const r = checkIncoming([file('a.pdf', 'application/pdf'), file('b.PDF', ''), file('c.png', 'image/png')]);
  assert.equal(r.refusal, undefined);
  assert.deepEqual(r.usable.map((f) => f.name), ['a.pdf', 'b.PDF', 'c.png']);
});

test('only unusable types refuse with pickFile', () => {
  const r = checkIncoming([file('surat.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')]);
  assert.equal(r.refusal, 'pickFile');
  assert.equal(checkIncoming([]).refusal, 'pickFile');
});

test('an unusable file next to a usable one is skipped, not a refusal', () => {
  const r = checkIncoming([file('x.docx', 'application/msword'), file('a.pdf', 'application/pdf')]);
  assert.equal(r.refusal, undefined);
  assert.deepEqual(r.usable.map((f) => f.name), ['a.pdf']);
});

test('an oversize usable file refuses with tooBig naming the first one', () => {
  const big = SIZE_BLOCK + 1;
  const r = checkIncoming([file('ok.pdf', 'application/pdf'), file('huge.pdf', 'application/pdf', big), file('huger.png', 'image/png', big)]);
  assert.equal(r.refusal, 'tooBig');
  assert.equal(r.name, 'huge.pdf');
  assert.equal(checkIncoming([file('edge.pdf', 'application/pdf', SIZE_BLOCK)]).refusal, undefined, 'exactly 100 MB is allowed');
});

test('an oversize file of an unusable type is not "too big", it is skipped', () => {
  const r = checkIncoming([file('movie.mp4', 'video/mp4', SIZE_BLOCK + 1)]);
  assert.equal(r.refusal, 'pickFile');
});

// ---- the ORDER at the two call sites -------------------------------------------------
const sliceFrom = (needle, len = 900) => {
  const i = APP.indexOf(needle);
  assert.ok(i >= 0, `anchor not found: ${needle}`);
  return APP.slice(i, i + len);
};

test('Ganti (dc-replace) checks the files before resetDoc', () => {
  const body = sliceFrom("on('dc-replace', 'click'");
  const check = body.indexOf('refuseIncoming(');
  const reset = body.indexOf('resetDoc()');
  assert.ok(check >= 0, 'dc-replace never calls refuseIncoming');
  assert.ok(reset >= 0 && check < reset, 'refuseIncoming must come BEFORE resetDoc()');
});

test('Buka Baru (the file picker change handler) checks the files before resetDoc', () => {
  const body = sliceFrom("on(fileInput, 'change'", 700);
  const check = body.indexOf('refuseIncoming(');
  const reset = body.indexOf('resetDoc()');
  assert.ok(check >= 0, 'the picker handler never calls refuseIncoming');
  assert.ok(reset >= 0 && check < reset, 'refuseIncoming must come BEFORE resetDoc()');
});

test('loadFiles itself still uses the same rule (one rule, one home)', () => {
  assert.ok(!/SIZE_BLOCK\s*=/.test(APP), 'app.js must not redefine the size limit');
  assert.match(sliceFrom('async function loadFilesInner', 800), /checkIncoming\(/);
});
