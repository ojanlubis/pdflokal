/*
 * THE CONTRACT THAT MATTERS: a written OCR layer must be SEARCHABLE and INVISIBLE.
 * ============================================================================
 * tests/core/ocr-layer.test.mjs proves the operator STRING is well formed. That
 * is necessary and it is not the contract. The contract is what PDF.js and our
 * own router say about the finished document, and only a browser can answer it:
 *
 *   1. pageHasVisibleText() must return FALSE. If it returns true, Edit stops
 *      declining the document and starts cutting show-ops that were never
 *      visible, stamping replacements over an untouched scan image. That is the
 *      2026-07-28 production incident, and writing our own OCR layers would
 *      MANUFACTURE it at scale, on every document we had just "helped".
 *   2. getTextContent() must return the words. Otherwise we changed nothing and
 *      shipped a no-op that looks like a feature.
 *
 * BOTH HALVES OR NOTHING. Searchable-but-visible corrupts documents;
 * invisible-but-empty is decoration. A test asserting only one of them passes
 * for a broken writer in the other direction.
 *
 * WHY THERE IS A CONTROL AT ALL: an "is it invisible" assertion passes for free
 * against a writer that emits nothing, and against a probe that can only ever
 * say false. The control demands the probe say TRUE for a real document with
 * visible text. Without it, the FALSE above distinguishes nothing.
 *
 * (The first control flipped "3 Tr" to "0 Tr" inside the finished PDF to make
 * the same words visible. It returned NO TEXT: the latin1 re-encode mangled the
 * stream. A control that fails for its own reasons is worse than none, because
 * it looks like the finding. Replaced, not deleted.)
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NASTY = (n) => path.join(__dirname, 'fixtures', 'nasty', n);

// Real Indonesian words, at plausible letter geometry on an A4 page.
const WORDS = [
  { text: 'Pondok', x: 72, y: 700, w: 46, h: 11 },
  { text: 'Sapi', x: 122, y: 700, w: 28, h: 11 },
  { text: 'Cibeber', x: 72, y: 676, w: 50, h: 11 },
];

async function boot(page) {
  await page.goto('/');
  await page.evaluate(async () => {
    const { ensurePdfJs, ensurePdfLib } = await import('/js/core/vendor.js');
    await ensurePdfJs();
    await ensurePdfLib();
  });
}

// Write a layer, then ask PDF.js what it thinks of the result.
async function writeAndProbe(page, srcB64) {
  return page.evaluate(async ({ src }) => {
    const { writeInvisibleTextLayer, buildInvisibleTextOps } = await import('/js/core/ocr-layer.js');
    const { pageHasVisibleText } = await import('/js/core/text-visibility.js');
    const lib = window.pdfjsLib;

    const dec = (b64) => {
      const bin = atob(b64);
      const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return u;
    };
    const words = [
      { text: 'Pondok', x: 72, y: 700, w: 46, h: 11 },
      { text: 'Sapi', x: 122, y: 700, w: 28, h: 11 },
      { text: 'Cibeber', x: 72, y: 676, w: 50, h: 11 },
    ];

    let out = await writeInvisibleTextLayer(dec(src), [{ pageIndex: 0, words }], { PDFLib: window.PDFLib });
    let bytes = out.bytes;

    const pdf = await lib.getDocument({ data: bytes.slice() }).promise;
    const p1 = await pdf.getPage(1);
    const visible = await pageHasVisibleText(p1, lib);
    const tc = await p1.getTextContent();
    const text = tc.items.map((i) => i.str).join(' ');
    await pdf.destroy();

    return {
      visible,
      text,
      written: out.written,
      skipped: out.skipped,
      opsHasTr3: /3 Tr/.test(buildInvisibleTextOps(words, { fontRes: 'F-ocr' })),
    };
  }, { src: srcB64 });
}

test.describe('OCR invisible text layer, written into a real scan', () => {
  test('the layer is SEARCHABLE and INVISIBLE, and Edit keeps declining the document', async ({ page }) => {
    await boot(page);
    const src = fs.readFileSync(NASTY('scan-bersih.pdf')).toString('base64');

    // The source really is a scan: no text at all before we touch it. Without
    // this, "the words are findable" could be true of the original document.
    const before = await page.evaluate(async (b64) => {
      const lib = window.pdfjsLib;
      const bin = atob(b64);
      const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const pdf = await lib.getDocument({ data: u }).promise;
      const tc = await (await pdf.getPage(1)).getTextContent();
      const n = tc.items.filter((i) => i.str && i.str.trim()).length;
      await pdf.destroy();
      return n;
    }, src);
    expect(before, 'scan-bersih.pdf already had text, so this proves nothing').toBe(0);

    const r = await writeAndProbe(page, src);
    expect(r.written, 'no words were written').toBe(WORDS.length);
    expect(r.skipped).toBe(0);
    expect(r.opsHasTr3, 'the writer stopped emitting render mode 3').toBe(true);

    // HALF ONE: searchable. The words must be extractable.
    for (const w of WORDS) {
      expect(r.text, `"${w.text}" is not findable, the layer is a no-op`).toContain(w.text);
    }

    // HALF TWO: invisible. This is the half that protects users' documents.
    expect(
      r.visible,
      'the written layer reads as VISIBLE text. Edit would stop declining this scan and start '
      + 'cutting show-ops nobody can see, stamping replacements over an untouched image, which is '
      + 'the 2026-07-28 incident manufactured deliberately.',
    ).toBe(false);
  });

  test('CONTROL: the probe still returns TRUE for a document with visible text', async ({ page }) => {
    // WHY THIS SHAPE, AND WHAT IT REPLACED. The first control rewrote the "3 Tr"
    // operand to "0 Tr" inside the finished PDF to flip the same words visible.
    // It came back with NO TEXT AT ALL: the latin1 decode/re-encode mangled the
    // stream. That is a broken instrument, not a finding, and a control that
    // fails for its own reasons tells you nothing about the thing it guards.
    //
    // So the control is now the cheapest true positive available: a real
    // born-digital document. If the probe used in the test above cannot say
    // TRUE here, its FALSE up there means nothing.
    await boot(page);
    const src = fs.readFileSync(NASTY('surat-word.pdf')).toString('base64');
    const r = await page.evaluate(async (b64) => {
      const { pageHasVisibleText } = await import('/js/core/text-visibility.js');
      const lib = window.pdfjsLib;
      const bin = atob(b64);
      const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const pdf = await lib.getDocument({ data: u }).promise;
      const p1 = await pdf.getPage(1);
      const visible = await pageHasVisibleText(p1, lib);
      const tc = await p1.getTextContent();
      const n = tc.items.filter((i) => i.str && i.str.trim()).length;
      await pdf.destroy();
      return { visible, n };
    }, src);
    expect(r.n, 'the control document has no text, so it cannot prove the probe says true').toBeGreaterThan(0);
    expect(
      r.visible,
      'pageHasVisibleText returned FALSE for ordinary visible text, so its FALSE on our written '
      + 'layer distinguishes nothing',
    ).toBe(true);
  });
});
