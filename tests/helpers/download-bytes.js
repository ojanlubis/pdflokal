/*
 * OPEN THE BYTES. The audit's top item, and the only one that would have caught
 * the mutation at the top of docs/test-suite-audit.md.
 * ============================================================================
 * That mutation: `core/export.js` made to silently drop EVERY text annotation —
 * `teks` is 38.8% of all real tool use — and the two specs most likely to
 * notice were run. All 39 passed. The suite was also GREEN at 287 passing on
 * the day a real user made 24 edits and received no file.
 *
 * The reason is always the same shape: `download.suggestedFilename()` treated
 * as proof the export worked. A filename is produced by the code that NAMES the
 * file, never by the code that BUILDS it.
 *
 * ⚠️ AND READING THE BYTES IS NOT ENOUGH BY ITSELF. A completely blank PDF
 * still begins `%PDF-`, still parses, still has the right page count. Asserting
 * the header would have passed the mutation too — it would just have felt more
 * rigorous. So every assertion here is about CONTENT that the export had to do
 * real work to produce:
 *
 *   pageCount   catches pages lost or duplicated (extract shipping the wrong set)
 *   text        catches annotations silently dropped — THE mutation
 *   ink         catches a structurally valid document that renders blank
 *
 * Usage:
 *   const buf = await downloadBytes(page, () => page.click('#ds-cta'));
 *   await expectRealPdf(page, buf, { pages: 2, text: ['Dari desktop'] });
 */
import { expect } from '@playwright/test';

/** Trigger a download and return its bytes. Never asserts — that is the caller's job. */
export async function downloadBytes(page, trigger) {
  const pending = page.waitForEvent('download');
  await trigger();
  const download = await pending;
  const chunks = [];
  for await (const c of await download.createReadStream()) chunks.push(c);
  return { buf: Buffer.concat(chunks), filename: download.suggestedFilename() };
}

/**
 * Parse the produced bytes with the SAME pdf.js the product ships, inside the
 * page. Returns per-page extracted text and an ink measurement.
 *
 * WHY in-page rather than a node-side parser: a node-side parser is a second
 * implementation, and a disagreement between it and the product's renderer is
 * indistinguishable from a bug in the export. The question we are asking is
 * "would the user's own viewer show this content", so we ask the viewer.
 */
export async function inspectPdf(page, buf) {
  return page.evaluate(async (arr) => {
    const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(arr) }).promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const p = await doc.getPage(i);
      const tc = await p.getTextContent();
      const text = tc.items.map((it) => it.str).join('');

      // Ink: rasterise small and count pixels that are not paper-white. Cheap,
      // and it is the only check that can tell a valid-but-blank export from a
      // real one.
      const vp = p.getViewport({ scale: 0.5 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await p.render({ canvasContext: ctx, viewport: vp }).promise;
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let inked = 0;
      for (let j = 0; j < d.length; j += 4) {
        if (d[j] < 245 || d[j + 1] < 245 || d[j + 2] < 245) inked++;
      }
      pages.push({ text, inkRatio: inked / (canvas.width * canvas.height) });
    }
    return { pageCount: doc.numPages, pages };
  }, Array.from(buf));
}

/**
 * The assertion the download specs were missing.
 *
 * @param {object} opts
 *   pages   exact expected page count
 *   text    strings that MUST appear in the extracted text (any page, unless
 *           `onPage` is given). This is the annotation-survival check.
 *   absent  strings that must NOT appear (e.g. a page that was extracted away)
 *   onPage  1-based page index to scope `text`/`absent` to
 *   minInk  minimum ink ratio on every page (default 0.0005 — a blank page is
 *           0, and a page with a single short line of text is ~0.002)
 */
export async function expectRealPdf(page, buf, opts = {}) {
  const {
    pages, text = [], absent = [], onPage = null, minInk = 0.0005,
  } = opts;

  expect(buf.length, 'the download produced ZERO bytes').toBeGreaterThan(0);
  expect(
    buf.subarray(0, 5).toString(),
    `the download is not a PDF at all (first bytes: ${JSON.stringify(buf.subarray(0, 8).toString())})`,
  ).toBe('%PDF-');

  const info = await inspectPdf(page, buf);

  if (pages !== undefined) {
    expect(
      info.pageCount,
      `exported ${info.pageCount} pages, expected ${pages}. The filename would have been correct either way.`,
    ).toBe(pages);
  }

  // VACUITY GUARD: with zero pages every loop below passes trivially, which is
  // the exact shape this file exists to eliminate.
  expect(info.pageCount, 'the exported PDF has no pages, so nothing below is actually being checked').toBeGreaterThan(0);

  const scope = onPage ? [info.pages[onPage - 1]] : info.pages;
  const haystack = scope.map((p) => p.text).join('\n');

  for (const needle of text) {
    expect(
      haystack,
      `"${needle}" is MISSING from the exported PDF${onPage ? ` page ${onPage}` : ''}. The file downloaded `
      + 'with the right name and the right page count and does not contain the content the user made. '
      + 'This is the 2026-07-28 incident exactly: user types, exports, content gone.',
    ).toContain(needle);
  }

  for (const needle of absent) {
    expect(
      haystack,
      `"${needle}" is PRESENT in the exported PDF but should not be — the wrong pages were exported.`,
    ).not.toContain(needle);
  }

  for (let i = 0; i < info.pages.length; i++) {
    expect(
      info.pages[i].inkRatio,
      `page ${i + 1} of the export renders BLANK (ink ratio ${info.pages[i].inkRatio.toFixed(5)}). `
      + 'It is a structurally valid PDF with the right page count that shows the user nothing.',
    ).toBeGreaterThan(minInk);
  }

  return info;
}
