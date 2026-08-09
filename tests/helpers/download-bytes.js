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
 *
 * ---------------------------------------------------------------------------
 * THE IMAGE HALF (added for the Unduh sheet's gambar paths, which were the two
 * remaining filename-only downloads in tests/mobile/download-sheet.spec.js).
 *
 * A rasterised page CANNOT carry extractable text, so `text` has no equivalent
 * here and pretending otherwise would be the same mistake in a new costume.
 * What a raster CAN be asked is: are these real image bytes, do they decode,
 * are the pixel dimensions the page's own aspect ratio, and is there ink on
 * them. That is the honest ceiling for this path and it is stated out loud so
 * nobody later reads "the images are tested" as "the right page was exported".
 *
 *   expectRealJpeg  decodes with the browser's own decoder — catches 0-byte,
 *                   truncated and valid-but-blank output
 *   unzipInPage     unzips with the SAME fflate the export just used, so the
 *                   entry list is the product's, not a second implementation's
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

/**
 * Decode image bytes with the BROWSER'S own decoder and measure them. Same
 * reasoning as inspectPdf: the question is "would the user's own viewer show
 * this", so we ask a viewer rather than a second node-side implementation.
 * Mirrors tests/core-export-images.spec.js's createImageBitmap → canvas →
 * getImageData shape, which is where this repo already decodes exported images.
 */
export async function inspectImage(page, buf, mime = 'image/jpeg') {
  return page.evaluate(async ({ arr, mime: m }) => {
    const bmp = await window.createImageBitmap(new Blob([new Uint8Array(arr)], { type: m }));
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    // Paper-white first: a decoder that produced nothing then reads as blank
    // rather than as transparent-black "ink".
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let inked = 0;
    for (let j = 0; j < d.length; j += 4) {
      if (d[j] < 245 || d[j + 1] < 245 || d[j + 2] < 245) inked++;
    }
    return { width: bmp.width, height: bmp.height, inkRatio: inked / (canvas.width * canvas.height) };
  }, { arr: Array.from(buf), mime });
}

/**
 * The image-side equivalent of expectRealPdf.
 *
 * @param {object} opts
 *   aspect   expected width/height ratio (the source page's), ±`aspectTol`
 *   minInk   minimum ink ratio. Default 0.0001 — LOWER than the PDF helper's
 *            0.0005, on purpose. A uniformly white JPEG measures exactly 0, so
 *            the threshold only has to clear zero to separate "blank" from
 *            "rendered", and a full-page raster spreads a sparse page's ink
 *            over ~2 megapixels, which would drag a 0.0005 bar into false reds.
 *   minBytes floor under which the file cannot be a real page render
 */
export async function expectRealJpeg(page, buf, opts = {}) {
  const {
    aspect = null, aspectTol = 0.02, minInk = 0.0001, minBytes = 1000,
  } = opts;

  expect(buf.length, 'the image download produced ZERO bytes').toBeGreaterThan(0);
  // SOI marker. A filename ending .jpg proves only that something named it .jpg.
  expect(
    [buf[0], buf[1]],
    `not a JPEG at all (first bytes: ${JSON.stringify(buf.subarray(0, 8).toString('hex'))})`,
  ).toEqual([0xff, 0xd8]);
  // EOI marker: the one cheap check that separates a complete file from a
  // truncated one, which is exactly what the filename could never see.
  expect(
    [buf[buf.length - 2], buf[buf.length - 1]],
    'the JPEG has no end-of-image marker — the download is TRUNCATED',
  ).toEqual([0xff, 0xd9]);
  expect(buf.length, `the JPEG is ${buf.length} bytes — too small to be a rendered page`).toBeGreaterThan(minBytes);

  const info = await inspectImage(page, buf, 'image/jpeg');
  expect(info.width, 'the JPEG decoded to zero width').toBeGreaterThan(0);
  expect(info.height, 'the JPEG decoded to zero height').toBeGreaterThan(0);

  if (aspect !== null) {
    const got = info.width / info.height;
    expect(
      Math.abs(got - aspect),
      `the exported image is ${info.width}x${info.height} (ratio ${got.toFixed(3)}), `
      + `but the page it claims to be is ratio ${aspect.toFixed(3)} — this is not that page`,
    ).toBeLessThan(aspectTol);
  }

  expect(
    info.inkRatio,
    `the exported image renders BLANK (ink ratio ${info.inkRatio.toFixed(5)}). It is a valid `
    + 'JPEG of the right size that shows the user nothing.',
  ).toBeGreaterThan(minInk);

  return info;
}

/**
 * Unzip in the page with the SAME fflate the export just loaded, and hand the
 * entries back as node Buffers. Returns [{ name, buf }] sorted by name.
 *
 * WHY in-page: tests/core-export-images.spec.js already round-trips zipFiles
 * through window.fflate.unzipSync. Adding a node-side unzipper would be a
 * second implementation, and a disagreement between the two is
 * indistinguishable from an export bug.
 */
export async function unzipInPage(page, buf) {
  expect(
    buf.subarray(0, 4).toString('hex'),
    `not a ZIP at all (first bytes: ${JSON.stringify(buf.subarray(0, 8).toString('hex'))})`,
  ).toBe('504b0304'); // "PK\x03\x04" local file header
  expect(await page.evaluate(() => !!window.fflate), 'window.fflate is not loaded — the ZIP export path never ran').toBe(true);

  const entries = await page.evaluate((arr) => {
    const back = window.fflate.unzipSync(new Uint8Array(arr));
    return Object.keys(back).sort().map((name) => ({ name, bytes: Array.from(back[name]) }));
  }, Array.from(buf));

  expect(entries.length, 'the ZIP unzipped to ZERO entries, so anything asserted about it is vacuous').toBeGreaterThan(0);
  return entries.map((e) => ({ name: e.name, buf: Buffer.from(e.bytes) }));
}
