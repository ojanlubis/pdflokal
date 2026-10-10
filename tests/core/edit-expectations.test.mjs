/*
 * edit-expectations.test.mjs — the pure rules behind the Edit tool's "this is a
 * limit" messages (js/v2/edit-expectations.js). The words live in the locales
 * and are held by i18n.test.mjs; this file holds WHEN they are said.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  toastDurationMs, firstTimeForDoc, alreadyShownForDoc, armEditNoticeKey, lineOutgrew, coveredNoteShows,
} from '../../js/v2/edit-expectations.js';
import { buildPdfArtifact } from '../../js/v2/pdf-builder.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const words = (n) => Array.from({ length: n }, (_, i) => `kata${i}`).join(' ');

// ---- toast duration ---------------------------------------------------------------
test('short text keeps 2600 ms; longer text scales at 900 + 330 per word', () => {
  assert.equal(toastDurationMs(''), 2600);
  assert.equal(toastDurationMs('Tap tulisan yang mau diubah'), 2600); // 5 words = 2550 -> floor
  assert.equal(toastDurationMs(words(5)), 2600);
  assert.equal(toastDurationMs(words(6)), 2880);
  assert.equal(toastDurationMs(words(12)), 4860);
  assert.equal(toastDurationMs('  banyak   spasi   di   sini  '), 2600); // words, not characters
  assert.equal(toastDurationMs(undefined), 2600);
});

test('the real app toast() uses the duration function, not a literal', () => {
  const src = fs.readFileSync(path.join(ROOT, 'js/v2/app.js'), 'utf8');
  const fn = src.match(/function toast\(msg\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(fn, /toastDurationMs\(msg\)/);
  assert.doesNotMatch(fn, /\b2600\b/);
});

// ---- once per document -------------------------------------------------------------
test('firstTimeForDoc is true once per doc and key; a new doc starts fresh', () => {
  const a = {}; const b = {};
  assert.equal(alreadyShownForDoc(a, 'k'), false);
  assert.equal(firstTimeForDoc(a, 'k'), true);
  assert.equal(firstTimeForDoc(a, 'k'), false);
  assert.equal(alreadyShownForDoc(a, 'k'), true);
  assert.equal(firstTimeForDoc(a, 'other'), true);
  assert.equal(firstTimeForDoc(b, 'k'), true, 'a fresh document (Buka Baru) says it again');
  assert.equal(firstTimeForDoc(null, 'k'), false);
});

// ---- arming Edit -------------------------------------------------------------------
test('arming Edit: locked first, then signed, each once per document; later arms are normal', () => {
  const plain = { sources: [{}] };
  assert.equal(armEditNoticeKey(plain), null);
  assert.equal(armEditNoticeKey(plain), null);

  const locked = { sources: [{ encrypted: true }] };
  assert.equal(armEditNoticeKey(locked), 'armEditLocked');
  assert.equal(armEditNoticeKey(locked), null);

  const signed = { sources: [{ signed: true }] };
  assert.equal(armEditNoticeKey(signed), 'armEditSigned');
  assert.equal(armEditNoticeKey(signed), null);
});

test('arming Edit: encrypted wins over signed, and a merge counts any source', () => {
  const both = { sources: [{ signed: true, encrypted: true }] };
  assert.equal(armEditNoticeKey(both), 'armEditLocked');
  assert.equal(armEditNoticeKey(both), null, 'the signed line does not follow it');
  const merged = { sources: [{}, { signed: true }] };
  assert.equal(armEditNoticeKey(merged), 'armEditSigned');
  assert.equal(armEditNoticeKey({}), null);
  assert.equal(armEditNoticeKey(null), null);
});

// ---- single-line edit --------------------------------------------------------------
test('lineOutgrew: wider than the original by more than 2% only', () => {
  assert.equal(lineOutgrew(200, 200), false);
  assert.equal(lineOutgrew(203.9, 200), false); // inside tolerance
  assert.equal(lineOutgrew(204.1, 200), true);
  assert.equal(lineOutgrew(120, 200), false);   // shorter
});

test('lineOutgrew: the editor min-width (40) is not mistaken for growth; bad input is false', () => {
  assert.equal(lineOutgrew(40, 12), false);
  assert.equal(lineOutgrew(40.5, 12), false);
  assert.equal(lineOutgrew(41, 12), true);
  assert.equal(lineOutgrew(0, 200), false);
  assert.equal(lineOutgrew(NaN, 200), false);
  assert.equal(lineOutgrew(300, 0), false);
  assert.equal(lineOutgrew(300, undefined), false);
});

// ---- the Unduh covered note --------------------------------------------------------
test('coveredNoteShows: PDF with painted covers shows; Gambar and zero covers hide', () => {
  assert.equal(coveredNoteShows({ format: 'pdf', size: 'asli', covered: 1 }), true);
  assert.equal(coveredNoteShows({ format: 'pdf', size: 'asli', covered: 7 }), true);
  assert.equal(coveredNoteShows({ format: 'img', size: 'sedang', covered: 3 }), false);
  assert.equal(coveredNoteShows({ format: 'pdf', size: 'asli', covered: 0 }), false);
  assert.equal(coveredNoteShows({ format: 'pdf', size: 'asli', covered: undefined }), false); // build not done yet
  assert.equal(coveredNoteShows({ format: 'pdf', size: 'asli' }), false);
});

test('coveredNoteShows: Compress rasterises the text away, unless it returned the file unchanged', () => {
  assert.equal(coveredNoteShows({ format: 'pdf', size: 'kompres', covered: 2 }), false);
  assert.equal(coveredNoteShows({ format: 'pdf', size: 'kompres', covered: 2, compressedUnchanged: true }), true);
});

test('buildPdfArtifact hands the sheet the painted-cover count', async () => {
  const r = await buildPdfArtifact({}, {
    loadPdfLib: async () => ({ PDFLib: {}, fontkit: {} }),
    buildPdf: async (_doc, deps) => { deps.onCoverDrawn({}); deps.onCoverDrawn({}); return new Uint8Array([1]); },
  });
  assert.equal(r.covered, 2);
  const clean = await buildPdfArtifact({}, {
    loadPdfLib: async () => ({ PDFLib: {}, fontkit: {} }),
    buildPdf: async () => new Uint8Array([1]),
  });
  assert.equal(clean.covered, 0);
});

test('the sheet renders the note from the build\'s count, in the PDF format only', () => {
  const src = fs.readFileSync(path.join(ROOT, 'js/v2/download-sheet.js'), 'utf8');
  assert.match(src, /state\.base = \{[^}]*covered[^}]*\}/);
  assert.match(src, /coveredNoteShows\(\{[\s\S]*?format: state\.format/);
  // The note must read the BUILD's count. The two checks above stayed green
  // with the call hard-wired to `covered: 0` (the note never shows): pin every
  // field of the call's argument to the state it must come from.
  const call = src.match(/coveredNoteShows\(\{([\s\S]*?)\}\);/);
  assert.ok(call, 'VACUITY: download-sheet.js no longer calls coveredNoteShows({ ... }); repoint this test');
  assert.match(call[1], /(^|[\s,])covered: state\.base\?\.covered\s*,/, 'covered comes from state.base, the build\'s count');
  assert.match(call[1], /(^|[\s,])format: state\.format\s*,/);
  assert.match(call[1], /(^|[\s,])size: state\.size\s*,/);
  assert.match(call[1], /(^|[\s,])compressedUnchanged: !!state\.compressed\?\.unchanged\s*,/);
});
