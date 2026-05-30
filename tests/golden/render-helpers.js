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

    const actualHash = sha256(pngs[i]);
    const baselineHash = sha256(baseline);
    if (actualHash !== baselineHash) {
      await fs.writeFile(actualPath, pngs[i]);
      results.push({
        page: pageNum,
        action: 'mismatch',
        actualHash,
        baselineHash,
        actualPath,
      });
    } else {
      results.push({ page: pageNum, action: 'match' });
    }
  }
  return results;
}
