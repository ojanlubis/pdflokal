/*
 * PDFLokal — core compress adapter (browser-tested, uses vendored pdf-lib +
 * PDF.js, so it runs under Playwright, not the headless node core suite).
 *
 * Verifies js/core/compress.js `compressPdfBytes`: the real re-rasterizing
 * compressor that replaced the placebo pdf-lib save(). Everything is built
 * in-page with pdf-lib so there's no fixture drift — we control exactly which
 * page is a big noisy image (JPEG re-encode WINS) vs a tiny text page (it
 * can't win, and the honesty guard must return the input untouched).
 */
import { test, expect } from '@playwright/test';

// Build an image-heavy PDF entirely in the browser: `numPages` pages, each a
// 600×800pt page filled edge-to-edge with a `dim`×`dim` PNG of RGB noise. Noise
// is incompressible for PNG (huge file) but crushes under JPEG — exactly the
// scan-like input where compression should win. Returns Uint8Array PDF bytes.
async function buildNoisyPdf(numPages, dim) {
  const { PDFLib } = window;
  const doc = await PDFLib.PDFDocument.create();
  for (let i = 0; i < numPages; i += 1) {
    const c = document.createElement('canvas');
    c.width = dim;
    c.height = dim;
    const ctx = c.getContext('2d');
    const imgData = ctx.createImageData(dim, dim);
    const d = imgData.data;
    for (let j = 0; j < d.length; j += 4) {
      d[j] = Math.random() * 256;
      d[j + 1] = Math.random() * 256;
      d[j + 2] = Math.random() * 256;
      d[j + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
    const img = await doc.embedPng(c.toDataURL('image/png'));
    const page = doc.addPage([600, 800]);
    page.drawImage(img, { x: 0, y: 0, width: 600, height: 800 });
  }
  return doc.save();
}

// Render page `pageNum` (1-based) of `pdfBytes` with PDF.js at `scale` and
// return a sampler — same round-trip strategy as the export suite.
async function renderPage(pdfBytes, pageNum, scale) {
  const out = await window.pdfjsLib.getDocument({ data: pdfBytes.slice() }).promise;
  const pdfPage = await out.getPage(pageNum);
  const vp = pdfPage.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  await pdfPage.render({ canvasContext: ctx, viewport: vp }).promise;

  return {
    numPages: out.numPages,
    vpWidth: Math.round(vp.width / scale),
    vpHeight: Math.round(vp.height / scale),
    // darkest luma inside a page-space rect — "is there ink here?"
    regionMinLuma(x0, y0, x1, y1) {
      const d = ctx.getImageData(
        Math.round(x0 * scale), Math.round(y0 * scale),
        Math.round((x1 - x0) * scale), Math.round((y1 - y0) * scale),
      ).data;
      let min = 255;
      for (let i = 0; i < d.length; i += 4) {
        const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        if (l < min) min = l;
      }
      return min;
    },
  };
}

test.describe('core compress adapter', () => {
  test('image-heavy PDF: shrinks, stays 3 pages at the same point dims, keeps pixels', async ({ page }) => {
    await page.goto('/alat-gambar.html');
    await page.waitForFunction(() => !!window.pdfjsLib && !!window.PDFLib);

    const r = await page.evaluate(`(async () => {
      ${buildNoisyPdf}
      ${renderPage}
      const cmp = await import('/js/core/compress.js');

      const srcBytes = await buildNoisyPdf(3, 1200);
      const res = await cmp.compressPdfBytes(srcBytes); // deps default to window globals

      const s = await renderPage(res.bytes, 1, 1);
      return {
        originalSize: res.originalSize,
        size: res.size,
        unchanged: res.unchanged,
        numPages: s.numPages,
        vpWidth: s.vpWidth,
        vpHeight: s.vpHeight,
        inkMinLuma: s.regionMinLuma(100, 100, 500, 700), // noise → dark pixels present
      };
    })()`);

    // Real saving happened and it's honest about it.
    expect(r.unchanged).toBe(false);
    expect(r.size).toBeLessThan(r.originalSize);

    // Structure preserved: 3 pages, each at the original point dims (±1).
    expect(r.numPages).toBe(3);
    expect(Math.abs(r.vpWidth - 600)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.vpHeight - 800)).toBeLessThanOrEqual(1);

    // The page body still carries visible pixel content, not blank white.
    expect(r.inkMinLuma).toBeLessThan(200);
  });

  test('tiny text PDF: cannot win, returns input untouched with unchanged=true', async ({ page }) => {
    await page.goto('/alat-gambar.html');
    await page.waitForFunction(() => !!window.pdfjsLib && !!window.PDFLib);

    const r = await page.evaluate(`(async () => {
      const cmp = await import('/js/core/compress.js');
      const { PDFLib } = window;

      const doc = await PDFLib.PDFDocument.create();
      const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
      const p = doc.addPage([300, 400]);
      p.drawText('Halo dunia', { x: 20, y: 200, size: 12, font });
      const srcBytes = await doc.save();

      const res = await cmp.compressPdfBytes(srcBytes);
      return {
        unchanged: res.unchanged,
        size: res.size,
        originalSize: res.originalSize,
        inputLen: srcBytes.length,
        outLen: res.bytes.length,
      };
    })()`);

    // A rasterized page of text is bigger than the vector original → the guard
    // must decline and hand back the exact input bytes.
    expect(r.unchanged).toBe(true);
    expect(r.size).toBe(r.originalSize);
    expect(r.outLen).toBe(r.inputLen);
  });

  test('onProgress fires exactly once per page, in order', async ({ page }) => {
    await page.goto('/alat-gambar.html');
    await page.waitForFunction(() => !!window.pdfjsLib && !!window.PDFLib);

    const r = await page.evaluate(`(async () => {
      ${buildNoisyPdf}
      const cmp = await import('/js/core/compress.js');

      const srcBytes = await buildNoisyPdf(3, 800);
      const calls = [];
      await cmp.compressPdfBytes(srcBytes, {
        onProgress: (done, total) => calls.push([done, total]),
      });
      return { calls };
    })()`);

    // One call per page, done counting up 1..3, total constant at 3.
    expect(r.calls).toEqual([[1, 3], [2, 3], [3, 3]]);
  });
  // COMPRESS x /Rotate (audit 2026-08-17, item 7). compress.js rebuilds every
  // page as an upright JPEG on a page that "carries NO /Rotate — the pixels are
  // already upright". That is only true if the rasteriser really did honour the
  // source's /Rotate, and no test ever gave compress a rotated page: a regression
  // that rendered at rotation 0 would hand back sideways pages, with the right
  // page count and a smaller file, and every assertion above would stay green.
  //
  // The oracle is what PDF.js SHOWS of the source, not a formula of ours: we
  // render the rotated source and the compressed output side by side and require
  // the same displayed size and the same corner carrying ink. The marker sits at
  // the MediaBox top-left and /Rotate moves it (PDF 32000 §7.7.3.3, clockwise:
  // 90 -> top-right, 180 -> bottom-right, 270 -> bottom-left), so a page that
  // came back unrotated, or rotated twice, puts the marker in the wrong corner.
  for (const [rot, corner] of [[90, 'TR'], [180, 'BR'], [270, 'BL']]) {
    test(`a source page with /Rotate ${rot} comes out upright: same displayed size, marker in the ${corner} corner`, async ({ page }) => {
      await page.goto('/alat-gambar.html');
      await page.waitForFunction(() => !!window.pdfjsLib && !!window.PDFLib);

      const r = await page.evaluate(`(async () => {
        ${renderPage}
        const cmp = await import('/js/core/compress.js');
        const { PDFLib } = window;

        // A 600x800 MediaBox (NOT square, so a missed rotation shows as a size
        // change) with a noise block in the middle, so the JPEG rebuild really
        // wins, and a black 60x60 marker at the MediaBox top-left.
        const doc = await PDFLib.PDFDocument.create();
        const c = document.createElement('canvas');
        c.width = 1200; c.height = 1200;
        const ctx = c.getContext('2d');
        const id = ctx.createImageData(1200, 1200);
        for (let j = 0; j < id.data.length; j += 4) {
          id.data[j] = Math.random() * 256; id.data[j + 1] = Math.random() * 256; id.data[j + 2] = Math.random() * 256; id.data[j + 3] = 255;
        }
        ctx.putImageData(id, 0, 0);
        const img = await doc.embedPng(c.toDataURL('image/png'));
        const p = doc.addPage([600, 800]);
        p.drawImage(img, { x: 150, y: 250, width: 300, height: 300 });
        p.drawRectangle({ x: 0, y: 740, width: 60, height: 60, color: PDFLib.rgb(0, 0, 0) });
        p.setRotation(PDFLib.degrees(${rot}));
        const srcBytes = await doc.save();

        const res = await cmp.compressPdfBytes(srcBytes);
        const outRot = (await PDFLib.PDFDocument.load(res.bytes)).getPages()[0].getRotation().angle;

        const corners = (s) => {
          const W = s.vpWidth; const H = s.vpHeight;
          return {
            TL: s.regionMinLuma(5, 5, 45, 45),
            TR: s.regionMinLuma(W - 45, 5, W - 5, 45),
            BL: s.regionMinLuma(5, H - 45, 45, H - 5),
            BR: s.regionMinLuma(W - 45, H - 45, W - 5, H - 5),
          };
        };
        const src = await renderPage(srcBytes, 1, 1);
        const out = await renderPage(res.bytes, 1, 1);
        return {
          unchanged: res.unchanged, outRot,
          srcW: src.vpWidth, srcH: src.vpHeight, outW: out.vpWidth, outH: out.vpHeight,
          srcCorners: corners(src), outCorners: corners(out),
        };
      })()`);

      // Precondition: the source really displays rotated, and compress took the
      // rebuild path (an unchanged return would hand back the input and prove
      // nothing about the rasteriser).
      expect(r.unchanged).toBe(false);
      expect({ w: r.srcW, h: r.srcH }).toEqual(rot === 180 ? { w: 600, h: 800 } : { w: 800, h: 600 });

      // The output is upright on its own terms: no /Rotate to double-apply, and
      // the displayed size is the source's displayed size.
      expect(r.outRot).toBe(0);
      expect(Math.abs(r.outW - r.srcW)).toBeLessThanOrEqual(1);
      expect(Math.abs(r.outH - r.srcH)).toBeLessThanOrEqual(1);

      // The marker is dark in exactly the expected corner of the SOURCE render
      // (so the check is not vacuous) and in the same corner of the output.
      for (const [label, corners] of [['source', r.srcCorners], ['compressed', r.outCorners]]) {
        for (const k of ['TL', 'TR', 'BL', 'BR']) {
          if (k === corner) expect(corners[k], `${label} ${k} should hold the marker`).toBeLessThan(60);
          else expect(corners[k], `${label} ${k} should be paper`).toBeGreaterThan(235);
        }
      }
    });
  }
});
