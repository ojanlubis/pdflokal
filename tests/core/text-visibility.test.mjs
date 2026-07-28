/*
 * Render-mode reading (headless) — core/text-visibility.js.
 *
 * The browser fixture pair (tests/ocr-layer.spec.js, scan-ocr.pdf vs
 * scan-ocr-terlihat.pdf) proves the SIMPLE case: a whole page invisible, or a
 * whole page visible. It cannot reach the case that actually makes this walker
 * non-trivial — render mode is graphics state, so `q`/`Q` save and restore it.
 * A document that sets mode 3 inside a q…Q block and paints real text after the
 * Q is an ordinary editable file, and a walker that ignored the stack would
 * call it a scan and send it to the scan offer. That is a REGRESSION the
 * fixtures would pass in silence, so it is pinned here.
 *
 * Synthetic operator lists, no vendor imports: `pdfjsLib` is an OPS table and
 * `pdfPage` is an object with getOperatorList(). That is the entire contract
 * this module has with pdf.js, which is what makes it testable headlessly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageHasVisibleText, INVISIBLE_RENDER_MODES } from '../../js/core/text-visibility.js';

// Same numbering as pdf.js; only the identities matter, not the values.
const OPS = {
  save: 10, restore: 11, setTextRenderingMode: 20, showText: 44, showSpacedText: 45, fill: 60,
};
const lib = { OPS };

const glyphs = (s) => [...s].map((c) => ({ unicode: c }));
const page = (...ops) => ({
  getOperatorList: async () => ({
    fnArray: ops.map((o) => o[0]),
    argsArray: ops.map((o) => o[1] ?? null),
  }),
});

const SHOW = (s) => [OPS.showText, [glyphs(s)]];
const TR = (m) => [OPS.setTextRenderingMode, [m]];
const Q = [OPS.save];
const QQ = [OPS.restore];

test('1. ordinary text (no Tr at all) is visible — default mode is fill', async () => {
  assert.equal(await pageHasVisibleText(page(SHOW('Pondok Sapi')), lib), true);
});

test('2. a whole-page invisible layer (3 Tr) is NOT visible text', async () => {
  assert.equal(await pageHasVisibleText(page(TR(3), SHOW('Pondok Sapi')), lib), false);
});

test('3. mode 7 (clip only, paints nothing) is invisible too', async () => {
  assert.equal(await pageHasVisibleText(page(TR(7), SHOW('Pondok Sapi')), lib), false);
});

test('4. modes that fill or stroke are visible, even when they also clip', async () => {
  for (const m of [0, 1, 2, 4, 5, 6]) {
    assert.equal(await pageHasVisibleText(page(TR(m), SHOW('x')), lib), true, `mode ${m}`);
  }
  for (const m of INVISIBLE_RENDER_MODES) {
    assert.equal(await pageHasVisibleText(page(TR(m), SHOW('x')), lib), false, `mode ${m}`);
  }
});

test('5. THE STACK: mode 3 inside q…Q must not leak past the Q', async () => {
  // An ordinary document that happens to use an invisible run somewhere.
  // Getting this wrong routes a perfectly editable file to the scan offer.
  const p = page(Q, TR(3), SHOW('watermark'), QQ, SHOW('Surat Undangan'));
  assert.equal(await pageHasVisibleText(p, lib), true);
});

test('6. THE STACK, other direction: mode 3 set OUTSIDE survives an inner q…Q', async () => {
  const p = page(TR(3), Q, SHOW('a'), QQ, SHOW('b'));
  assert.equal(await pageHasVisibleText(p, lib), false);
});

test('7. an unbalanced Q does not throw or reset the mode', async () => {
  // Malformed content streams are ordinary in the wild; popping an empty stack
  // must leave the mode alone rather than silently reverting it to 0/visible.
  assert.equal(await pageHasVisibleText(page(TR(3), QQ, SHOW('a')), lib), false);
});

test('8. whitespace-only glyphs are not "visible text"', async () => {
  assert.equal(await pageHasVisibleText(page(SHOW('   ')), lib), false);
  assert.equal(await pageHasVisibleText(page(SHOW('  ')), lib), false);
});

test('9. showSpacedText counts — TJ is how justified text is usually painted', async () => {
  const p = page(TR(3), [OPS.showSpacedText, [[...glyphs('Pon'), -120, ...glyphs('dok')]]]);
  assert.equal(await pageHasVisibleText(p, lib), false);
  const q = page([OPS.showSpacedText, [[...glyphs('Pon'), -120, ...glyphs('dok')]]]);
  assert.equal(await pageHasVisibleText(q, lib), true);
});

test('10. a page with no text ops at all (a bare scan) is not visible text', async () => {
  assert.equal(await pageHasVisibleText(page([OPS.fill]), lib), false);
});

test('11. one visible run among many invisible ones is enough', async () => {
  const p = page(TR(3), SHOW('ocr'), SHOW('ocr'), TR(0), SHOW('real'), TR(3), SHOW('ocr'));
  assert.equal(await pageHasVisibleText(p, lib), true);
});
