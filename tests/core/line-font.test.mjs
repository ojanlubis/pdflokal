/*
 * core/line-font.js — ONE font decision per line (edit font design slice 1a).
 * ============================================================================
 * The founder's principle (seat decisions.md 2026-10-01): what the user sees
 * while typing is what the file will contain. decideLineFont is the single
 * function the editor, the stamp and export all ask; these tests pin it on
 * REAL font programs, not mocks, wherever coverage is the question:
 *
 *   native     — nota-subset.pdf's own Carlito subset (é present, É ABSENT —
 *                see scripts/gen-fixture-subset.mjs), read off the page the
 *                way the stamp reads it.
 *   clone      — fonts/ttf/carlito-regular.ttf, the bytes the stamp embeds.
 *   substitute — fonts/ttf/arimo-regular.ttf.
 *
 * Stub fonts appear only where the property under test is NOT coverage
 * (writability of complex scripts, the "mix" revert), and say so.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  decideLineFont, acceptLineInput, storedDecision, faceLadder, faceStyle, isWritableCodePoint,
} from '../../js/core/line-font.js';
import { extractFontProgram } from '../../js/core/doc-fonts.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};
const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');

const ttf = (name) => fontkit.create(new Uint8Array(fs.readFileSync(path.join(root, 'fonts', 'ttf', name))));

async function realCandidates() {
  const doc = await PDFLib.PDFDocument.load(fs.readFileSync(path.join(root, 'tests/fixtures/nasty/nota-subset.pdf')));
  const key = 'Carlito-Regular-7098480789';
  const got = extractFontProgram(doc.getPages()[0], PDFLib, key);
  assert.ok(got.ok, 'fixture drifted: nota-subset.pdf no longer carries this resource');
  const native = { path: 'native', key, parsed: fontkit.create(got.bytes), css: 'doc-css' };
  // The fixture's whole point, asserted so a regenerated fixture cannot turn
  // the clone cases below into decoration (tests/core memory: fixture-must-distinguish).
  assert.equal(native.parsed.hasGlyphForCodePoint(0xc9), false, 'fixture must LACK É');
  assert.equal(native.parsed.hasGlyphForCodePoint(0xe9), true, 'fixture must HAVE é');
  return [
    native,
    { path: 'clone', face: 'Carlito', parsed: ttf('carlito-regular.ttf'), css: 'clone-css', evidence: 'name' },
    { path: 'substitute', face: 'Arimo', parsed: ttf('arimo-regular.ttf'), css: 'sub-css', evidence: 'default' },
  ];
}

// A font that claims to paint every codepoint — used ONLY where the property
// under test is something other than coverage.
const paintsAll = { hasGlyphForCodePoint: () => true, glyphForCodePoint: () => ({ id: 1, path: { commands: [{}] } }) };
const paintsOnly = (chars) => ({
  hasGlyphForCodePoint: (cp) => chars.includes(String.fromCodePoint(cp)),
  glyphForCodePoint: () => ({ id: 1, path: { commands: [{}] } }),
});

test('decideLineFont: the doc font wins when it paints the WHOLE line', async () => {
  const c = await realCandidates();
  const d = decideLineFont('Kafé Andréa', c);
  assert.equal(d.path, 'native');
  assert.equal(d.key, 'Carlito-Regular-7098480789');
  assert.equal(d.css, 'doc-css');
  assert.equal(d.uncovered, 0);
});

test('decideLineFont: ONE char the subset lacks moves the WHOLE line to the clone — never per glyph', async () => {
  const c = await realCandidates();
  const d = decideLineFont('KAFÉ ANDRÉA', c);
  assert.equal(d.path, 'clone', 'É is missing from the doc subset, so the whole line goes to the clone');
  assert.equal(d.face, 'Carlito');
  assert.equal(d.key, undefined, 'a clone decision names a face, not a doc resource');
});

test('decideLineFont: order is native → clone → substitute; the first that covers wins', async () => {
  const [native, clone, sub] = await realCandidates();
  assert.equal(decideLineFont('KAFÉ', [native, sub, clone]).path, 'substitute', 'order is the CALLER\'s ladder');
  assert.equal(decideLineFont('KAFÉ', [native, sub]).path, 'substitute');
  assert.equal(decideLineFont('Kafé', [sub, native]).path, 'substitute', 'first covering candidate, not "best"');
  // A candidate whose font failed to load is skipped, not fatal.
  assert.equal(decideLineFont('Kafé', [null, { path: 'clone', parsed: null }, native]).path, 'native');
});

test('decideLineFont: a char NO candidate can write → none, naming it', async () => {
  const c = await realCandidates();
  const d = decideLineFont('Nomor Ж02', c);
  assert.equal(d.path, 'none');
  assert.deepEqual(d.blocked, ['Ж']);
  assert.equal(d.uncovered, 1);
  assert.equal(d.ladder.length, 3, 'the ladder still travels, so a re-edit can rebuild it');
  assert.equal(storedDecision(d), null, 'a none decision is never stored on an annotation');
});

test('decideLineFont: coverage is not writability — complex scripts are none even in a font that covers them', () => {
  // INFERRED rule (design B2): pdf-lib drawText does no shaping or bidi, so
  // joined Arabic would bake as isolated forms. The stub covers everything,
  // so only the writability gate can make this none.
  const all = [{ path: 'native', key: 'F1', parsed: paintsAll }];
  assert.equal(decideLineFont('Halo dunia', all).path, 'native');
  const d = decideLineFont('سلام', all);
  assert.equal(d.path, 'none');
  assert.equal(d.blocked.length, 4);
  assert.equal(isWritableCodePoint('ꦗ'.codePointAt(0)), false, 'Javanese script needs shaping too');
  assert.equal(isWritableCodePoint('é'.codePointAt(0)), true);
});

test('decideLineFont: judged on what the stamp DRAWS — a pasted thin space is a space', async () => {
  const [native] = await realCandidates();
  assert.equal(native.parsed.hasGlyphForCodePoint(0x2009), false, 'fixture lacks U+2009 itself');
  // drawTextSafe maps U+2009 → ' ' before pdf-lib sees it, so the doc font
  // (which has a space) really can write this line.
  assert.equal(decideLineFont('Kafé Andréa', [native]).path, 'native');
});

test('decideLineFont: a line break is layout, not a glyph (Rung D blocks call this on block text)', async () => {
  const [native] = await realCandidates();
  assert.equal(decideLineFont('Kafé\nAndréa', [native]).path, 'native');
});

test('acceptLineInput: a typed char nothing can write is REFUSED; the line keeps its face', async () => {
  const c = await realCandidates();
  const r = acceptLineInput('Kafé', 'KaféЖ', c);
  assert.equal(r.text, 'Kafé');
  assert.equal(r.refused, 'Ж');
  assert.equal(r.decision.path, 'native');
});

test('acceptLineInput: a paste keeps everything writable and drops only what is not', async () => {
  const c = await realCandidates();
  const r = acceptLineInput('', 'AЖBぁC', c);
  assert.equal(r.text, 'ABC');
  assert.equal(r.refused, 'Ж');
});

test('acceptLineInput: writable by SOME font but by no single one → the keystroke is undone', () => {
  // Stubs on purpose: the property is the revert, not coverage. X lives only
  // in font A, Y only in font B — no ONE font writes "XY".
  const c = [
    { path: 'native', key: 'A', parsed: paintsOnly(['X']) },
    { path: 'clone', face: 'Arimo', parsed: paintsOnly(['Y']) },
  ];
  const r = acceptLineInput('X', 'XY', c);
  assert.equal(r.text, 'X');
  assert.equal(r.refused, 'Y');
  assert.equal(r.decision.path, 'native');
});

test('acceptLineInput: with NO candidate loaded nothing is judged, so nothing is refused', () => {
  // An offline PWA on a name-only standard-14 line: no doc program, no TTF.
  // Refusing here would block every keystroke; the old ladder decides at bake.
  const r = acceptLineInput('Kaf', 'Kafe', []);
  assert.equal(r.text, 'Kafe');
  assert.equal(r.refused, null);
  assert.equal(r.decision.path, 'none');
  assert.equal(acceptLineInput('Kaf', 'Kafe', [null, { path: 'clone', parsed: null }]).refused, null);
});

test('acceptLineInput: a writable edit passes through untouched, flipping the face if it must', async () => {
  const c = await realCandidates();
  const r = acceptLineInput('Kafé', 'KAFÉ', c);
  assert.equal(r.text, 'KAFÉ');
  assert.equal(r.refused, null);
  assert.equal(r.decision.path, 'clone');
});

test('storedDecision: plain JSON that survives a round trip, no font objects', async () => {
  const c = await realCandidates();
  const s = storedDecision(decideLineFont('KAFÉ', c));
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
  assert.equal(s.v, 1);
  assert.equal(s.ladder.every((e) => !('parsed' in e)), true);
  assert.deepEqual(s.ladder.map((e) => e.path), ['native', 'clone', 'substitute']);
});

test('faceLadder: clone by name, substitute by evidence, never Helvetica', () => {
  assert.deepEqual(faceLadder({ baseFont: 'ABCDEF+Arial-BoldMT', bold: true }), [
    { path: 'clone', face: 'Arimo-Bold', evidence: 'name' },
  ], 'Arimo is both the clone and the default substitute — offered once');
  assert.deepEqual(faceLadder({ baseFont: 'CIDFont+F1', programName: 'Calibri', italic: true }), [
    { path: 'clone', face: 'Carlito-Italic', evidence: 'name' },
    { path: 'substitute', face: 'Arimo-Italic', evidence: 'default' },
  ]);
  assert.deepEqual(faceLadder({ baseFont: 'Inter_700wght', family: 'serif' }), [
    { path: 'substitute', face: 'Tinos', evidence: 'program' },
  ]);
  assert.deepEqual(faceLadder(null), [{ path: 'substitute', face: 'Arimo', evidence: 'default' }]);
  assert.deepEqual(faceStyle('Carlito-BoldItalic'), { family: 'Carlito', bold: true, italic: true });
});
