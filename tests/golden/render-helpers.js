/*
 * Golden-master test helpers.
 *
 * Strategy: round-trip the EXPORTED PDF back through PDF.js (already loaded by
 * PDFLokal) to render each page to a PNG, then hash. Catches the bugs we care
 * about — positional drift, glyph mistakes, page reordering — without
 * depending on pdf-lib's bit-stability (see memory/pdf-lib-bitstability.md).
 *
 * Why rendered comparison rather than byte/normalized hash:
 *  - pdf-lib's compressed streams differ across processes
 *  - rendered output is what the user actually sees
 *  - already-loaded PDF.js means zero new dependencies
 */
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

// WHY pixel-diff tolerance instead of exact hash: PDF.js text rendering is
// stable per platform but differs across platforms (macOS vs Linux font
// hinting + AA). An exact hash compares baselines made on a dev laptop
// against actuals rendered on the CI Linux runner — guaranteed false
// positives. Pixelmatch with a small tolerance absorbs the AA drift while
// still failing if an annotation shifts position or a glyph swaps.
const ALLOWED_DIFF_RATIO = 0.005; // 0.5% of pixels may legitimately differ
const PIXELMATCH_THRESHOLD = 0.1; // per-pixel YIQ tolerance; 0.1 = default

// WHY 1.0 scale: PDF.js render is deterministic at any scale, but 1.0 matches
// the PDF user space coordinates 1:1, so a 612x792pt page produces a 612x792px
// PNG. Bigger = more sensitive to anti-alias drift, smaller = misses subpixel
// regressions. 1.0 is the sweet spot.
const RENDER_SCALE = 1.0;

export async function exportPdf(page) {
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#ue-download-btn').click();
  const dl = await downloadPromise;
  const stream = await dl.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Render each page of `pdfBytes` to a PNG inside the browser (using the
// already-loaded PDF.js) and return an array of Node Buffers.
export async function renderPagesAsPngs(page, pdfBytes) {
  const pngArrays = await page.evaluate(async (bytesArray) => {
    const bytes = new Uint8Array(bytesArray);
    const doc = await window.pdfjsLib.getDocument({ data: bytes }).promise;
    const pngs = [];
    for (let i = 1; i <= doc.numPages; i += 1) {
      const pdfPage = await doc.getPage(i);
      const viewport = pdfPage.getViewport({ scale: 1.0 });
      const canvas = new OffscreenCanvas(viewport.width, viewport.height);
      const ctx = canvas.getContext('2d');
      await pdfPage.render({ canvasContext: ctx, viewport }).promise;
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const ab = await blob.arrayBuffer();
      pngs.push(Array.from(new Uint8Array(ab)));
    }
    return pngs;
  }, Array.from(pdfBytes));

  return pngArrays.map((arr) => Buffer.from(arr));
}

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Compare two PNG buffers. Returns { diffPixels, total, ratio, diffPng? }.
// Different dimensions short-circuit to a 100% mismatch.
function comparePngBuffers(baselineBuf, actualBuf) {
  const baseline = PNG.sync.read(baselineBuf);
  const actual = PNG.sync.read(actualBuf);
  if (baseline.width !== actual.width || baseline.height !== actual.height) {
    return { diffPixels: Infinity, total: 0, ratio: 1, dimsDiffer: true };
  }
  const { width, height } = baseline;
  const total = width * height;
  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(
    baseline.data,
    actual.data,
    diff.data,
    width,
    height,
    { threshold: PIXELMATCH_THRESHOLD }
  );
  return {
    diffPixels,
    total,
    ratio: diffPixels / total,
    diffPng: PNG.sync.write(diff),
  };
}

// Compare the exported PDF's rendered pages against the committed baselines.
// On mismatch, writes the actual PNGs to tests/golden/actual/ so the
// developer can diff visually.
//
// Run with UPDATE_BASELINES=1 to regenerate baselines (commit them after).
export async function assertGoldenMatch(scenarioName, pdfBytes, page, baselinesDir, actualDir) {
  const pngs = await renderPagesAsPngs(page, pdfBytes);
  const update = process.env.UPDATE_BASELINES === '1';

  await fs.mkdir(baselinesDir, { recursive: true });
  if (!update) await fs.mkdir(actualDir, { recursive: true });

  const results = [];
  for (let i = 0; i < pngs.length; i += 1) {
    const pageNum = i + 1;
    const baselinePath = path.join(baselinesDir, `${scenarioName}-page-${pageNum}.png`);
    const actualPath = path.join(actualDir, `${scenarioName}-page-${pageNum}.png`);

    if (update) {
      await fs.writeFile(baselinePath, pngs[i]);
      results.push({ page: pageNum, action: 'baseline-written' });
      continue;
    }

    let baseline;
    try {
      baseline = await fs.readFile(baselinePath);
    } catch {
      // No baseline yet — write actual as proposed baseline.
      await fs.writeFile(actualPath, pngs[i]);
      results.push({ page: pageNum, action: 'no-baseline', actualPath });
      continue;
    }

    const { diffPixels, total, ratio, diffPng, dimsDiffer } = comparePngBuffers(baseline, pngs[i]);
    if (ratio > ALLOWED_DIFF_RATIO) {
      const diffPath = path.join(actualDir, `${scenarioName}-page-${pageNum}-diff.png`);
      await fs.writeFile(actualPath, pngs[i]);
      if (diffPng) await fs.writeFile(diffPath, diffPng);
      results.push({
        page: pageNum,
        action: 'mismatch',
        diffPixels,
        total,
        ratio,
        dimsDiffer: !!dimsDiffer,
        actualPath,
        diffPath: diffPng ? diffPath : undefined,
      });
    } else {
      results.push({ page: pageNum, action: 'match', diffPixels, ratio });
    }
  }
  return results;
}
