/*
 * Invisible OCR text layer (headless) — core/ocr-layer.js.
 *
 * THE POINT OF THIS FILE: a searchable scan is an image with an INVISIBLE text
 * layer painted in render mode 3 (see core/text-visibility.js's header for the
 * 2026-07-28 incident that taught us render mode is graphics state, not a text
 * property). buildInvisibleTextOps/writeInvisibleTextLayer are how WE produce
 * that layer for OCR output. Three failure classes matter more than any single
 * happy path:
 *   1. VACUITY — a writer that silently emits an empty/no-op string still
 *      "succeeds" by every naive test (no throw, valid PDF, just no text).
 *   2. VISIBILITY — if "3 Tr" is missing, mis-ordered, or leaks outside the
 *      q...Q block, the OCR text either paints on top of the scan (visible
 *      duplicate glyphs) or bleeds render-mode state into whatever the page
 *      draws next.
 *   3. STREAM CORRUPTION — one unescaped '(' or ')' in a word doesn't just
 *      mis-render that word, it shifts the literal-string boundary for
 *      everything after it in the content stream. A NaN operand does the same
 *      via a different mechanism (the number becomes the 3 literal letters
 *      "NaN", which the tokenizer reads as a bogus operator, not a number).
 *
 * So instead of regexing the operator string by hand, this file reuses the
 * SAME tokenizer the real content-stream surgery code trusts
 * (core/content-stream.js's tokenizeOps + decodeLiteralString) to read back
 * what buildInvisibleTextOps actually wrote — "read the artifact, not its
 * label," same law that governs the font work. A hand-written regex could
 * pass against a subtly-corrupt stream that a real PDF consumer chokes on;
 * the tokenizer cannot be fooled that way because it's the same parser a real
 * reader effectively runs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenizeOps } from '../../js/core/content-stream.js';
import { readPageContents } from '../../js/core/redact.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'window', 'define', 'globalThis',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports && Object.keys(module.exports).length ? module.exports : globalThis.PDFLib;
};
const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
const fixture = (n) => new Uint8Array(fs.readFileSync(path.join(root, 'tests/fixtures/nasty', n)));

// Written against the CONTRACT, not the file — ocr-layer.js may not exist yet
// when this runs. An import failure is an acceptable, honestly-reported
// outcome for this file (see the task brief); every test below still states
// what it would have protected against once the module lands.
const { buildInvisibleTextOps, writeInvisibleTextLayer } = await import('../../js/core/ocr-layer.js');

// Pull every Tj's decoded string out of a parsed op list, in stream order —
// used repeatedly below to check "which words actually got painted".
const tjTexts = (ops) => tokenizeOps(ops).filter((r) => r.op === 'Tj').flatMap((r) => r.strings);

test('1. round trip: writer loads real bytes, embeds a font, appends ops, and the page still opens with the layer actually ON it', async () => {
  const src = fixture('scan-bersih.pdf');
  const before = await PDFLib.PDFDocument.load(src);
  const pageCountBefore = before.getPageCount();

  const words = [
    { text: 'Halo', x: 72, y: 700, w: 45, h: 14 },
    { text: 'Dunia', x: 130, y: 700, w: 55, h: 14 },
    { text: 'Emoji😀', x: 200, y: 700, w: 45, h: 14 }, // must be SKIPPED, never thrown
  ];
  const { bytes, written, skipped } = await writeInvisibleTextLayer(
    src, [{ pageIndex: 0, words }], { PDFLib },
  );

  assert.equal(written, 2, 'the two well-formed, encodable words');
  assert.equal(skipped, 1, 'the emoji word — proves the writer COUNTS skips instead of silently dropping them');

  // Reload through the SAME vendored pdf-lib, not just trust the promise.
  const after = await PDFLib.PDFDocument.load(bytes);
  assert.equal(after.getPageCount(), pageCountBefore, 'writing a text layer must never add or remove pages');

  // Read the page the SAME way the real content-stream surgery code does
  // (core/redact.js's readPageContents) — proves the layer landed on the
  // actual page object, not just somewhere in the returned bytes.
  const content = readPageContents(after.getPage(0), PDFLib);
  assert.ok(content.includes('3 Tr'), 'the invisible render mode must actually be present on the page after reload');
  assert.match(content, /\bDo\b/, 'the scan image draw op must still be there — this is append, not replace');
  assert.deepEqual(tjTexts(content), ['Halo', 'Dunia'], 'exactly the two written words, byte for byte through a real save/load cycle');
});

test('2. THE INVARIANT: wrapped in q…Q, and "3 Tr" is set once, before any show-op', () => {
  const words = [
    { text: 'Satu', x: 72, y: 700, w: 40, h: 14 },
    { text: 'Dua', x: 120, y: 700, w: 35, h: 14 },
  ];
  const ops = buildInvisibleTextOps(words, { fontRes: 'F-ocr' });
  const parsed = tokenizeOps(ops);

  assert.equal(parsed[0].op, 'q', 'the whole block must open with q — an isolated graphics-state change');
  assert.equal(parsed.at(-1).op, 'Q', 'and close with Q — never leak render mode 3 into the rest of the page');

  const trOps = parsed.filter((r) => r.op === 'Tr');
  assert.equal(trOps.length, 1, '"3 Tr" must be set exactly once for the whole block, not per word');
  assert.equal(trOps[0].tokens.find((t) => t.t === 'num')?.v, 3, 'the render mode operand must literally be 3 (neither fill nor stroke)');

  const trIndex = parsed.indexOf(trOps[0]);
  const firstTjIndex = parsed.findIndex((r) => r.op === 'Tj');
  assert.ok(firstTjIndex > -1, 'sanity: there must be at least one show-op to order against');
  assert.ok(trIndex < firstTjIndex, '"3 Tr" must come BEFORE the first show-op — set it after and the words paint visibly first');
});

test('3. VACUITY GUARD: the op string is non-empty and actually contains every word passed', () => {
  const words = [
    { text: 'Baik', x: 72, y: 700, w: 40, h: 14 },
    { text: 'Sekali', x: 130, y: 700, w: 60, h: 14 },
    { text: 'Terima', x: 200, y: 700, w: 55, h: 14 },
  ];
  const ops = buildInvisibleTextOps(words, { fontRes: 'F-ocr' });
  assert.equal(typeof ops, 'string');
  assert.ok(ops.trim().length > 0, 'a writer that silently emits nothing must not pass as a success');
  // Order-sensitive: a version that drops or duplicates a word changes this.
  assert.deepEqual(tjTexts(ops), ['Baik', 'Sekali', 'Terima']);
});

test('4. escaping: parens + backslash survive a real tokenize/decode round trip', () => {
  // Deliberately balanced ( and ) plus a bare backslash — the exact triple
  // the contract calls out. An unescaped backslash before a non-escape
  // character is DROPPED by any spec-compliant reader (PDF 32000 7.3.4.2),
  // so a broken (unescaped) writer produces a DIFFERENT decoded string than
  // this one, not just a differently-formatted one — this assertion catches
  // that class of bug, not just "did it crash".
  const nasty = [{ text: 'A(b)\\c', x: 50, y: 50, w: 60, h: 12 }];
  const ops = buildInvisibleTextOps(nasty, { fontRes: 'F-ocr' });
  const parsed = tokenizeOps(ops);

  assert.equal(parsed[0].op, 'q', 'still well-formed: unescaped ) would terminate the literal string early and misparse everything after it');
  assert.equal(parsed.at(-1).op, 'Q');

  const tj = parsed.filter((r) => r.op === 'Tj');
  assert.equal(tj.length, 1, 'exactly one Tj for the one word — a mis-terminated string would fragment or swallow this');
  assert.equal(tj[0].strings.join(''), nasty[0].text, 'decoded content must equal the ORIGINAL raw text exactly — escaping undone, nothing lost, nothing extra');
});

test('5. skipping: unencodable and geometrically-broken words are dropped, never thrown, never painted with garbage geometry', () => {
  const mixed = [
    { text: 'Sehat', x: 72, y: 700, w: 45, h: 14 },        // good — must survive
    { text: 'Emoji😀', x: 130, y: 700, w: 45, h: 14 },      // unencodable in a standard font
    { text: 'ZeroW', x: 200, y: 700, w: 0, h: 14 },         // non-positive width
    { text: 'NanH', x: 260, y: 700, w: 40, h: NaN },        // non-finite height
    { text: 'InfX', x: Infinity, y: 700, w: 40, h: 14 },    // non-finite x
    { text: 'NegW', x: 320, y: 700, w: -10, h: 14 },        // negative width
  ];
  let ops;
  assert.doesNotThrow(() => { ops = buildInvisibleTextOps(mixed, { fontRes: 'F-ocr' }); },
    'a bad word in the batch must never abort the whole page\'s layer');
  assert.deepEqual(tjTexts(ops), ['Sehat'], 'only the one geometrically-sane, encodable word may reach a Tj — anything else here means a skip leaked through with garbage geometry');
});

test('5b. writer counts skips at document scale, matching what buildInvisibleTextOps actually drops', async () => {
  const words = [
    { text: 'Satu', x: 72, y: 700, w: 40, h: 14 },
    { text: 'Rusak🙂', x: 130, y: 700, w: 40, h: 14 },
    { text: 'Dua', x: 200, y: 700, w: 40, h: 14 },
    { text: 'Nol', x: 260, y: 700, w: 0, h: 14 },
  ];
  const { written, skipped } = await writeInvisibleTextLayer(
    fixture('scan-bersih.pdf'), [{ pageIndex: 0, words }], { PDFLib },
  );
  assert.equal(written, 2, 'Satu and Dua only');
  assert.equal(skipped, 2, 'the emoji word and the zero-width word — a writer that returns skipped:0 here is lying about data it never checked');
});

test('6. every number written is finite — a NaN or "undefined" silently corrupts the content stream', () => {
  const words = [
    { text: 'Kecil', x: 12.5, y: 800.25, w: 30.4, h: 0.001 }, // must clamp away from ~0, not paint the raw value
    { text: 'Normal', x: 300, y: 400, w: 66.6, h: 18 },
  ];
  const ops = buildInvisibleTextOps(words, { fontRes: 'F-ocr' });

  // Belt and suspenders: if a size/position were literally the JS value NaN
  // or undefined, String(...) would splice the LITERAL TEXT "NaN" or
  // "undefined" into the stream — which the tokenizer below would read as a
  // bogus OPERATOR, not a number, silently hiding the defect from a
  // token-shape check alone. Catch it as a raw substring first.
  assert.ok(!ops.includes('NaN'), 'no literal "NaN" may appear in the operator string');
  assert.ok(!ops.includes('undefined'), 'no literal "undefined" may appear in the operator string');

  const parsed = tokenizeOps(ops);
  let checked = 0;
  for (const rec of parsed) {
    if (!['Tf', 'Tm', 'Tz'].includes(rec.op)) continue;
    for (const tok of rec.tokens) {
      if (tok.t !== 'num') continue;
      assert.ok(Number.isFinite(tok.v), `${rec.op} operand ${tok.v} must be a finite number`);
      checked += 1;
    }
  }
  assert.ok(checked > 0, 'sanity: this test must actually have found Tf/Tm/Tz operands to check, or it proves nothing');

  const tfSizes = parsed.filter((r) => r.op === 'Tf').map((r) => r.tokens.find((t) => t.t === 'num').v);
  assert.ok(tfSizes[0] > 0.1, 'h=0.001 must be clamped to a sane minimum, not carried through near-zero — a near-zero Tf size is functionally invisible even at mode 0');
});
