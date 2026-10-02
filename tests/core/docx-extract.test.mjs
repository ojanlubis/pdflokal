/*
 * docx/extract.js + core/text-run-geometry.js on synthetic PDFs (pdf-lib builds them, pdf.js reads them).
 *   1. The per-item geometry is pinned against numbers worked out by hand from the PDF's own
 *      coordinates (a regression in the arithmetic fails here, not three modules later).
 *   2. THE LIFT: the editor's run index (js/v2/text-runs.js) and the Word extractor produce identical
 *      runs for the same page, at rotation 0 and 90 and a non-1 scale. They share one function now
 *      (core/text-run-geometry.js); this is the test that fails if either side grows a copy again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runsFromTextContent } from '../../js/core/text-run-geometry.js';
import { readPage, groupLines, styledRuns, wordsOfLine, fontInfoOf, applyOcr } from '../../js/docx/extract.js';
import { loadLibs, makePdf } from './docx-helpers.mjs';

const { pdfjs } = loadLibs();
const open = async (bytes) => pdfjs.getDocument({ data: bytes.slice(), verbosity: 0, disableFontFace: true, fontExtraProperties: true }).promise;

const twoLines = (pages, { fonts }) => {
  pages[0].drawText('Hello world', { x: 72, y: 700, size: 12, font: fonts.reg });
  pages[0].drawText('Courier text', { x: 72, y: 650, size: 10, font: fonts.mono });
};

test('geometry: a run lands where the PDF put it (hand-computed from the content stream)', async () => {
  const pdf = await open(await makePdf(twoLines));
  const page = await pdf.getPage(1);
  const tc = await page.getTextContent();
  const vp = page.getViewport({ scale: 1 });
  const runs = runsFromTextContent({ pdfjs, tc, vp });
  assert.equal(runs.length, 2);
  const [a, b] = runs;
  // baseline origin in page space: y flips (842 - 700)
  assert.ok(Math.abs(a.org.x - 72) < 1e-6 && Math.abs(a.org.y - 142) < 1e-6, `org ${JSON.stringify(a.org)}`);
  assert.ok(Math.abs(a.size - 12) < 1e-6);
  // Helvetica AFM widths: H722 e556 l222 l222 o556 space278 w722 o556 r333 l222 d556 = 4945/1000 em = 59.34pt at 12pt;
  // the box is padded by 6% of the size each side
  const w = a.pdf.len;
  assert.ok(Math.abs(w - 59.34) < 0.05, `advance width ${w}`);
  assert.ok(Math.abs(a.x - (72 - 0.72)) < 1e-6 && Math.abs(a.w - (w + 1.44)) < 1e-6);
  // the box runs from the descender (-0.25em) to the ascender (+1em) plus the pad
  assert.ok(Math.abs(a.y - (142 - 12 - 0.72)) < 1e-6 && Math.abs(a.h - (15 + 1.44)) < 1e-6, `y ${a.y} h ${a.h}`);
  // raw content-stream frame is untouched by the viewport
  assert.deepEqual([a.pdf.x0, a.pdf.y0, a.pdf.ux, a.pdf.uy, a.pdf.size], [72, 700, 1, 0, 12]);
  assert.ok(Math.abs(b.pdf.len - 6 * 12) < 1e-6, 'Courier "Courier text" = 12 glyphs x 0.6em x 10pt');
  assert.equal(b.fontFamily.includes('Courier') || b.fontFamily === 'monospace', true, b.fontFamily);
});

test('geometry: extra() adds caller fields and cannot lose the geometry; blank items are skipped', async () => {
  const bytes = await makePdf((pages, { fonts }) => {
    pages[0].drawText('   ', { x: 50, y: 500, size: 12, font: fonts.reg });
    pages[0].drawText('Ada', { x: 50, y: 400, size: 12, font: fonts.reg });
  });
  const page = await (await open(bytes)).getPage(1);
  const runs = runsFromTextContent({ pdfjs, tc: await page.getTextContent(), vp: page.getViewport({ scale: 1 }), extra: (item) => ({ dir: item.dir, tag: 'x' }) });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].str, 'Ada');
  assert.equal(runs[0].tag, 'x');
  assert.equal(runs[0].dir, 'ltr');
});

test('THE LIFT: the editor run index and the Word extractor give identical runs (rotation 0, 90, scale 1.5)', async () => {
  const bytes = await makePdf(twoLines);
  globalThis.window = { pdfjsLib: pdfjs }; // ensurePdfJs() returns this instead of loading a script
  try {
    const { createTextRunIndex } = await import('../../js/v2/text-runs.js');
    for (const { rotation, scale } of [{ rotation: 0, scale: 1 }, { rotation: 90, scale: 1 }, { rotation: 0, scale: 1.5 }]) {
      const doc = {
        sources: [{ id: 's1', bytes }],
        pages: [{ id: 'p1', sourceId: 's1', sourcePageNum: 0, baseRotation: rotation, rotation: 0, baseWidth: 595, width: 595 * scale }],
      };
      const index = createTextRunIndex({ getDoc: () => doc });
      const editorRuns = await index.getRuns('p1');
      const pdf = await open(bytes);
      const page = await pdf.getPage(1);
      const vp = page.getViewport({ scale, rotation });
      const wordRuns = runsFromTextContent({ pdfjs, tc: await page.getTextContent(), vp });
      assert.equal(editorRuns.length, 2);
      // fontName is pdf.js's per-document loaded name (g_dN_fM), which differs between the two documents opened here
      const strip = (rs) => rs.map(({ fontName, ...rest }) => rest);
      assert.deepEqual(strip(editorRuns), strip(wordRuns), `rotation ${rotation} scale ${scale}`);
      await index.destroy();
    }
  } finally { delete globalThis.window; }
});

test('geometry: rotation 90 swaps the extents: the same line is tall instead of wide', async () => {
  const page = await (await open(await makePdf(twoLines))).getPage(1);
  const tc = await page.getTextContent();
  const flat = runsFromTextContent({ pdfjs, tc, vp: page.getViewport({ scale: 1 }) })[0];
  const turned = runsFromTextContent({ pdfjs, tc, vp: page.getViewport({ scale: 1, rotation: 90 }) })[0];
  assert.ok(flat.w > flat.h * 2);
  assert.ok(turned.h > turned.w * 2);
});

test('readPage: kind, runs, fonts and ops for a text page; a blank page is "empty"', async () => {
  const pdf = await open(await makePdf(twoLines));
  const ctx = await readPage({ pdfjs, page: await pdf.getPage(1), pageNumber: 1, shared: {}, options: {} });
  assert.equal(ctx.kind, 'text');
  assert.equal(ctx.hasTextItems, true);
  assert.equal(ctx.runs.length, 2);
  assert.deepEqual([ctx.widthPt, ctx.heightPt], [595, 842]);
  assert.ok(ctx.ops.fnArray.length > 0);
  assert.ok(ctx.runs.every((r) => r.style && typeof r.style.family === 'string' && 'dir' in r));
  const blank = await open(await makePdf(() => {}));
  const bctx = await readPage({ pdfjs, page: await blank.getPage(1), pageNumber: 1, shared: {}, options: {} });
  assert.equal(bctx.kind, 'empty');
  assert.deepEqual(bctx.runs, []);
});

test('readPage: invisible (render mode 3) text is a searchable scan, not text', async () => {
  const bytes = await makePdf((pages, { fonts, PDFLib }) => {
    pages[0].pushOperators(PDFLib.pushGraphicsState(), PDFLib.setTextRenderingMode(3));
    pages[0].drawText('hidden words', { x: 50, y: 400, size: 12, font: fonts.reg });
    pages[0].pushOperators(PDFLib.popGraphicsState());
  });
  const pdf = await open(bytes);
  const ctx = await readPage({ pdfjs, page: await pdf.getPage(1), pageNumber: 1, shared: {}, options: {} });
  assert.equal(ctx.kind, 'searchable-scan');
});

test('groupLines + words: lines come from core/text-lines.js, words are a lazy, proportional split of each run', async () => {
  const bytes = await makePdf((pages, { fonts }) => {
    pages[0].drawText('aa bbb cccc', { x: 100, y: 500, size: 10, font: fonts.mono }); // monospace: 6pt per glyph
  });
  const pdf = await open(bytes);
  const ctx = await readPage({ pdfjs, page: await pdf.getPage(1), pageNumber: 1, shared: {}, options: {} });
  groupLines(ctx);
  assert.equal(ctx.lines.length, 1);
  assert.equal(Object.keys(ctx).includes('words'), false, 'words are not an enumerable own property (not copied around)');
  const words = ctx.words;
  assert.deepEqual(words.map((w) => w.str), ['aa', 'bbb', 'cccc']);
  // monospace is the exact case: word k starts at 100 + 6 * (its index in the string)
  assert.ok(Math.abs(words[0].x0 - 100) < 0.2 && Math.abs(words[0].x1 - 112) < 0.2, JSON.stringify(words[0]));
  assert.ok(Math.abs(words[1].x0 - 118) < 0.2 && Math.abs(words[2].x0 - 142) < 0.2, JSON.stringify(words));
  assert.ok(words.every((w) => w.line === 0 && w.y1 > w.y0 && Math.abs(w.base - 342) < 1e-6));
  assert.equal(ctx.words, words, 'computed once');
  assert.deepEqual(wordsOfLine(ctx.lines[0]).map((w) => w.str), ['aa', 'bbb', 'cccc']);
});

test('styledRuns: bold/italic/size/family per run, neighbours with the same style merge, colour splits them', async () => {
  const bytes = await makePdf((pages, { fonts }) => {
    pages[0].drawText('Plain ', { x: 50, y: 500, size: 11, font: fonts.reg });
    pages[0].drawText('Bold', { x: 50 + fonts.reg.widthOfTextAtSize('Plain ', 11), y: 500, size: 11, font: fonts.bold });
  });
  const pdf = await open(bytes);
  const ctx = await readPage({ pdfjs, page: await pdf.getPage(1), pageNumber: 1, shared: {}, options: {} });
  groupLines(ctx);
  const runs = styledRuns(ctx.lines[0]);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map((r) => [r.t.trim(), r.b, r.f, r.sz]), [['Plain', false, 'Arial', 11], ['Bold', true, 'Arial', 11]]);
  assert.equal('c' in runs[0], false, 'no colour key when there is no colour');
  const coloured = styledRuns(ctx.lines[0], () => 'FF0000');
  assert.ok(coloured.every((r) => r.c === 'FF0000'));
  ctx.lines[0].runs[0].color = '00FF00'; // what the colour lane sets
  assert.equal(styledRuns(ctx.lines[0])[0].c, '00FF00');
  assert.equal(styledRuns(ctx.lines[0]).length, 2);
});

test('styledRuns: runs of the SAME style merge, and a colour change is what splits them', async () => {
  const bytes = await makePdf((pages, { fonts }) => {
    pages[0].drawText('AAA ', { x: 50, y: 500, size: 11, font: fonts.reg });
    pages[0].drawText('BBB', { x: 50 + fonts.reg.widthOfTextAtSize('AAA ', 11), y: 500, size: 11, font: fonts.reg });
  });
  const ctx = await readPage({ pdfjs, page: await (await open(bytes)).getPage(1), pageNumber: 1, shared: {}, options: {} });
  groupLines(ctx);
  assert.equal(ctx.lines[0].runs.length, 2);
  assert.equal(styledRuns(ctx.lines[0]).length, 1, 'same font, same size, no colour: one run');
  ctx.lines[0].runs[1].color = 'FF0000';
  const split = styledRuns(ctx.lines[0]);
  assert.deepEqual(split.map((r) => r.c), [undefined, 'FF0000']);
});

test('fontInfoOf: names to families, styles from the name and the flags, placeholders fall back to the generic', () => {
  assert.deepEqual(fontInfoOf({ name: 'ABCDEF+Arial-BoldMT' }), { family: 'Arial', bold: true, italic: false });
  assert.deepEqual(fontInfoOf({ name: 'TimesNewRomanPS-ItalicMT' }), { family: 'Times New Roman', bold: false, italic: true });
  assert.equal(fontInfoOf({ name: 'F1' }, 'serif').family, 'Times New Roman');
  assert.equal(fontInfoOf({ name: 'F1', isMonospace: true }).family, 'Courier New');
  assert.equal(fontInfoOf(null, undefined).family, 'Arial');
  assert.equal(fontInfoOf({ name: 'Montserrat-SemiBold' }).bold, true);
  assert.equal(fontInfoOf({ name: 'Calibri', bold: true }).bold, true);
});

test('applyOcr: OCR lines replace the runs and mark the page ocr-scan; nothing found leaves it alone', async () => {
  const pdf = await open(await makePdf(() => {}));
  const ctx = await readPage({ pdfjs, page: await pdf.getPage(1), pageNumber: 1, shared: {}, options: {} });
  ctx.kind = 'scan';
  assert.equal(await applyOcr(ctx, async () => []), false);
  assert.equal(ctx.kind, 'scan');
  const ok = await applyOcr(ctx, async ({ pageNumber }) => [{ str: `halaman ${pageNumber}`, x: 50, y: 60, w: 90, h: 14, size: 12 }]);
  assert.equal(ok, true);
  assert.equal(ctx.kind, 'ocr-scan');
  groupLines(ctx);
  assert.equal(ctx.lines.length, 1);
  assert.equal(styledRuns(ctx.lines[0])[0].t, 'halaman 1');
});
