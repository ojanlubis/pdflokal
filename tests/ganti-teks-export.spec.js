/*
 * Ganti Teks — Rung B honest replacement (export surgery).
 * ============================================================================
 * Rung A covers the tapped run with a color-matched Tip-Ex — but the ORIGINAL
 * text was still in the exported file under the cover. This suite proves the
 * upgrade: js/core/export.js now cuts the covered run's show-text ops out of
 * the page's own content stream (js/core/redact.js) and skips drawing the
 * cover when that surgery succeeds — the true background shows through
 * instead of a sampled rectangle.
 *
 * Two levels, matching the two places this can break:
 *   1. The real UI path (undangan-cid.pdf, a CID/Identity-H font — string
 *      match is impossible here, only position-matched removal can prove
 *      WHICH of three identical lines died). Drives the actual app + the real
 *      Unduh download, never a synthetic buildPdfBytes call.
 *   2. The core adapter's failure paths (core-export.spec.js pattern): a
 *      target that matches nothing, and a cover the user dragged away from
 *      the run it was born on. Both MUST fall back to today's cover-and-keep
 *      behavior — an export must never fail or degrade because surgery had
 *      trouble.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NASTY = (name) => path.join(__dirname, 'fixtures', 'nasty', name);

// ---- UI helpers (same shape as tests/ganti-teks.spec.js) ---------------------
async function openDoc(page, fixture) {
  await page.goto('/');
  await page.setInputFiles('#file-input', fixture);
  await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
}

async function armGanti(page) {
  await page.click('[data-tool="ganti"]');
  await expect(page.locator('.pv-run-hints div').first()).toBeVisible();
}

async function tapRun(page, nth = 0) {
  const hint = page.locator('.pv-run-hints div').nth(nth);
  const box = await hint.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('.v2-text-edit')).toBeVisible();
}

// undangan-cid.pdf draws "Rapat Anggota Tahunan 2026" THREE times (PDF-space
// y0 660, 630, 600 — see tests/rung-b-lab.spec.js, which pins this same
// fixture's geometry). Run index 3 of the page's 8 extracted runs (0:title,
// 1:nomor, 2/3/4:the three repeats, 5:tempat, 6:tanggal, 7:footer) is the
// MIDDLE repeat (y0=630) — verified against a live extraction before writing
// this test, not guessed.
const MIDDLE_RUN_INDEX = 3;

// Full flow: arm → tap the middle repeat → type → commit → download via the
// REAL Unduh sheet (never a synthetic buildPdfBytes call — this is the path
// an actual user takes, wiring text-runs.js → app.js → export.js end to end).
async function replaceMiddleLineAndDownload(page) {
  await openDoc(page, NASTY('undangan-cid.pdf'));
  await armGanti(page);
  await tapRun(page, MIDDLE_RUN_INDEX);
  await expect(page.locator('.v2-text-edit')).toHaveText('Rapat Anggota Tahunan 2026');
  await page.keyboard.type('Rapat Luar Biasa');
  await page.keyboard.press('Enter');

  await page.click('#btn-download');
  await expect(page.locator('#dl-sheet')).toBeVisible();
  const dl = page.waitForEvent('download');
  await page.click('#ds-cta');
  const download = await dl;
  const chunks = [];
  for await (const c of await download.createReadStream()) chunks.push(c);
  return Buffer.concat(chunks);
}

test.describe('ganti teks export — the honest-replacement proof (real UI + real download)', () => {
  test('exported bytes: the tapped (middle) line is truly gone; the other two + the replacement survive', async ({ page }) => {
    const outBuf = await replaceMiddleLineAndDownload(page);
    expect(outBuf.subarray(0, 5).toString()).toBe('%PDF-');

    const r = await page.evaluate(async (arr) => {
      const bytes = new Uint8Array(arr);
      const out = await window.pdfjsLib.getDocument({ data: bytes }).promise;
      const p = await out.getPage(1);
      const tc = await p.getTextContent();
      const repeated = tc.items.filter((i) => i.str === 'Rapat Anggota Tahunan 2026');
      const replacement = tc.items.filter((i) => i.str.includes('Rapat Luar Biasa'));
      return {
        repeatedCount: repeated.length,
        repeatedYs: repeated.map((i) => Math.round(i.transform[5])).sort((a, b) => b - a),
        replacementFound: replacement.length > 0,
      };
    }, Array.from(outBuf));

    // 3 → 2: exactly the tapped occurrence is GONE from the file (not hidden
    // under a cover — genuinely absent from the re-parsed text layer). String
    // match could never prove WHICH one died on a CID font; position could.
    expect(r.repeatedCount).toBe(2);
    expect(r.repeatedYs).toEqual([660, 600]); // the untouched OUTER lines survive
    expect(r.replacementFound).toBe(true);
  });

  test('structural: surgery succeeded, so no cover rectangle was added to the exported page', async ({ page }) => {
    const outBuf = await replaceMiddleLineAndDownload(page);
    const origBuf = fs.readFileSync(NASTY('undangan-cid.pdf'));

    const r = await page.evaluate(async ({ origArr, outArr }) => {
      const { PDFLib } = window;
      const { tokenizeOps } = await import('/js/core/content-stream.js');
      const { PDFArray, PDFRawStream, decodePDFRawStream } = PDFLib;
      const latin1 = (u8) => Array.from(u8, (b) => String.fromCharCode(b)).join('');

      // Same read shape as core/redact.js's removeRunsFromPdfPage: Contents
      // may be one stream or an array, decode all, join, tokenize.
      //
      // WHY 'f' (fill) and not the PDF 're' (rectangle) operator: pdf-lib's
      // drawRectangle does NOT emit 're' at all — verified empirically against
      // this vendored build — it emits a filled PATH (m/l/l/l/h/f). 'f' is the
      // op that uniquely appears once per drawn cover in this content (the
      // page's own text-only content has zero fills — verified against this
      // exact fixture), so it is the operator that actually discriminates
      // "cover drawn" from "cover skipped" here.
      async function countFillOps(bytes) {
        const pdfDoc = await PDFLib.PDFDocument.load(bytes);
        const pg = pdfDoc.getPages()[0];
        const context = pdfDoc.context;
        const contents = pg.node.Contents();
        const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
        const joined = refs.map((ref) => {
          const s = context.lookup(ref);
          return latin1(s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents());
        }).join('\n');
        return tokenizeOps(joined).filter((op) => op.op === 'f').length;
      }

      const origCount = await countFillOps(new Uint8Array(origArr));
      const outCount = await countFillOps(new Uint8Array(outArr));
      return { origCount, outCount };
    }, { origArr: Array.from(origBuf), outArr: Array.from(outBuf) });

    // Computed from the ORIGINAL fixture itself (not hardcoded) — the export
    // added zero fill ops, proving the whiteout cover was skipped, not just
    // that the text happens to be gone.
    expect(r.outCount).toBe(r.origCount);
  });
});

// ---- core-level fallback proofs (core-export.spec.js pattern) ---------------
// Build a one-page source PDF with REAL text ("Hello World", fontkit-embedded
// Montserrat — pdf-lib embeds custom fonts as Type0/Identity-H with a real /W
// array, so text-walk.js can compute exact advances; a pdf-lib StandardFont
// carries no /Widths at all and would make the target self-inconsistent).
// The target geometry is DERIVED from the source's own content stream (via
// the same walkShowOps text-walk.js itself uses) rather than hand-computed —
// self-consistency was verified live before writing this test: this exact
// target, walked against this exact content, matches with matched:true.
async function buildTextSourceDoc() {
  const model = await import('/js/core/model.js');
  const ops = await import('/js/core/operations.js');
  const imp = await import('/js/core/import.js');
  const exp = await import('/js/core/export.js');
  const redact = await import('/js/core/redact.js');
  const walk = await import('/js/core/text-walk.js');
  const { PDFLib, fontkit } = window;
  const { PDFArray, PDFRawStream, decodePDFRawStream } = PDFLib;

  const src = await PDFLib.PDFDocument.create();
  src.registerFontkit(fontkit);
  const fontBytes = await (await fetch('/fonts/montserrat-regular.woff2')).arrayBuffer();
  const font = await src.embedFont(fontBytes);
  const sp = src.addPage([600, 800]);
  sp.drawText('Hello World', { x: 300, y: 400, size: 24, font, color: PDFLib.rgb(0, 0, 0) });
  const srcBytes = await src.save();

  const latin1 = (u8) => Array.from(u8, (b) => String.fromCharCode(b)).join('');
  const tempDoc = await PDFLib.PDFDocument.load(srcBytes);
  const tempPage = tempDoc.getPages()[0];
  const contents = tempPage.node.Contents();
  const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
  const contentStr = refs.map((r) => {
    const s = tempDoc.context.lookup(r);
    return latin1(s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents());
  }).join('\n');
  const fonts = redact.extractFontMetrics(tempPage, PDFLib);
  const rec = walk.walkShowOps(contentStr, fonts)[0];
  const target = { x0: rec.x, y0: rec.y, ux: rec.ux, uy: rec.uy, size: rec.size, len: rec.advanceText };

  const doc = model.createDoc();
  await imp.importPdf(doc, { name: 'hello.pdf', bytes: srcBytes });
  return { model, ops, exp, doc, target };
}

// Count fill ops on a pdf-lib-loaded page (headless-shape, run inside the
// page). WHY 'f' and not the PDF 're' (rectangle) operator: pdf-lib's
// drawRectangle emits a filled PATH (m/l/l/l/h/f), never 're' — verified
// empirically against this vendored build. 'f' is what actually appears once
// per drawn cover; the source doc here is pure text (drawText only), so its
// fill count is 0 — a clean baseline to diff a drawn-or-skipped cover against.
async function countFillOpsHelper(PDFLib, tokenizeOps, pdfDoc, pageIdx = 0) {
  const { PDFArray, PDFRawStream, decodePDFRawStream } = PDFLib;
  const latin1 = (u8) => Array.from(u8, (b) => String.fromCharCode(b)).join('');
  const pg = pdfDoc.getPages()[pageIdx];
  const contents = pg.node.Contents();
  const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
  const joined = refs.map((r) => {
    const s = pdfDoc.context.lookup(r);
    return latin1(s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents());
  }).join('\n');
  return tokenizeOps(joined).filter((op) => op.op === 'f').length;
}

test.describe('ganti teks export — surgery fallback paths (core adapter)', () => {
  test('fallback: a target that matches nothing keeps the cover, export stays intact', async ({ page }) => {
    await page.goto('/alat-gambar.html');
    await page.waitForFunction(() => !!window.pdfjsLib && !!window.PDFLib && !!window.fontkit);

    const r = await page.evaluate(`(async () => {
      ${buildTextSourceDoc}
      ${countFillOpsHelper}
      const { model, ops, exp, doc } = await buildTextSourceDoc();
      const { PDFLib } = window;
      const { tokenizeOps } = await import('/js/core/content-stream.js');
      const p0 = doc.pages[0];

      // The whiteout's own rect (birth box == its current rect, 100% overlap —
      // the guard passes; it's the TARGET geometry that's bogus, pointing at
      // empty space far from the real "Hello World" run at PDF (300,400)).
      const rect = { x: 280, y: 380, width: 200, height: 40 };
      const emptyTarget = { x0: 10, y0: 10, ux: 1, uy: 0, len: 50, size: 12 };
      ops.addAnnotation(doc, p0.id, model.createAnnotation('whiteout', {
        x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        replaceTarget: emptyTarget,
        replaceBox: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      }));

      const outBytes = await exp.buildPdfBytes(doc);

      const origDoc = await PDFLib.PDFDocument.load(doc.sources[0].bytes);
      const origCount = await countFillOpsHelper(PDFLib, tokenizeOps, origDoc);
      const outDoc = await PDFLib.PDFDocument.load(outBytes);
      const outCount = await countFillOpsHelper(PDFLib, tokenizeOps, outDoc);

      const parsed = await window.pdfjsLib.getDocument({ data: outBytes.slice() }).promise;
      const pg = await parsed.getPage(1);
      const tc = await pg.getTextContent();
      const survived = tc.items.some((i) => i.str === 'Hello World');

      return { origCount, outCount, survived };
    })()`);

    expect(r.survived).toBe(true); // the real text was never touched
    expect(r.outCount).toBe(r.origCount + 1); // the cover rectangle WAS drawn
  });

  test('moved-cover guard: a cover dragged away from its birth box gets no surgery', async ({ page }) => {
    await page.goto('/alat-gambar.html');
    await page.waitForFunction(() => !!window.pdfjsLib && !!window.PDFLib && !!window.fontkit);

    const r = await page.evaluate(`(async () => {
      ${buildTextSourceDoc}
      ${countFillOpsHelper}
      const { model, ops, exp, doc, target } = await buildTextSourceDoc();
      const { PDFLib } = window;
      const { tokenizeOps } = await import('/js/core/content-stream.js');
      const p0 = doc.pages[0];

      // replaceTarget is REAL and matchable (proven self-consistent when this
      // helper built it) — but the annotation's OWN rect has moved far from
      // replaceBox, so the cover no longer sits over the run it was born on.
      const birthBox = { x: 280, y: 380, w: 200, h: 40 };
      const movedRect = { x: 280, y: 600, width: 200, height: 40 }; // zero overlap with birthBox
      ops.addAnnotation(doc, p0.id, model.createAnnotation('whiteout', {
        x: movedRect.x, y: movedRect.y, width: movedRect.width, height: movedRect.height,
        replaceTarget: target,
        replaceBox: birthBox,
      }));

      const outBytes = await exp.buildPdfBytes(doc);

      const origDoc = await PDFLib.PDFDocument.load(doc.sources[0].bytes);
      const origCount = await countFillOpsHelper(PDFLib, tokenizeOps, origDoc);
      const outDoc = await PDFLib.PDFDocument.load(outBytes);
      const outCount = await countFillOpsHelper(PDFLib, tokenizeOps, outDoc);

      const parsed = await window.pdfjsLib.getDocument({ data: outBytes.slice() }).promise;
      const pg = await parsed.getPage(1);
      const tc = await pg.getTextContent();
      const survived = tc.items.some((i) => i.str === 'Hello World');

      return { origCount, outCount, survived };
    })()`);

    expect(r.survived).toBe(true); // the guard blocked surgery — text intact
    expect(r.outCount).toBe(r.origCount + 1); // a cover WAS drawn (at the moved position)
  });
});
