/*
 * PDFLokal — "Samakan lebar", attacked from the format's parameters.
 * Strategy and axes: tests/helpers/pdf-params.js (WIDTH_AXES, his ruling
 * 2026-10-10 on fixtures; the feature's rulings 2026-11-03).
 *
 * For every pairwise case of page 1 size x page 2 size x what the user did
 * (dismissed the offer, evened, evened then Kembalikan): download, read the
 * file back with pdf.js, and check the DOWNLOAD MATCHES THE SCREEN:
 *   - each page in the file has the size the editor shows (model width/height,
 *     which is what the stage lays out),
 *   - page 2's width relative to page 1's is the same in the file as on screen,
 *   - each label sits at the same fraction of its page as in the source, so
 *     the content scaled WITH its page rather than staying put.
 * The export scales a page whose width differs from the size its source
 * measured (core/export.js "MERGE WIDTH NORMALISATION"); this proves that holds
 * for a single file, where it was never exercised before.
 * Not run by the foreground gate (nightly CI).
 */
import { test, expect } from '@playwright/test';
import { downloadBytes } from './helpers/download-bytes.js';
import { WIDTH_AXES, WIDTH_LABELS, pairwise, widthCaseName, buildMixedWidthPdf } from './helpers/pdf-params.js';

async function readFile(page, buf) {
  return page.evaluate(async (arr) => {
    const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(arr) }).promise;
    const out = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const p = await doc.getPage(n);
      const vp = p.getViewport({ scale: 1 });
      const items = (await p.getTextContent()).items.filter((it) => it.str.trim());
      out.push({
        w: vp.width, h: vp.height,
        labels: items.map((it) => {
          const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
          return { str: it.str, fx: x / vp.width, fy: y / vp.height };
        }),
      });
    }
    return out;
  }, Array.from(buf));
}

for (const c of pairwise(WIDTH_AXES)) {
  test(`widths: ${widthCaseName(c)}`, async ({ page }) => {
    await page.goto('/');
    const src = await buildMixedWidthPdf(page, c);
    await page.setInputFiles('#file-input', { name: 'lebar.pdf', mimeType: 'application/pdf', buffer: src });
    const offer = page.locator('#even-offer');
    await expect(offer).toBeVisible(); // VACUITY GUARD: every case really is mixed
    if (c.state === 'untouched') {
      await page.click('#eo-later');
    } else {
      await page.click('#eo-go');
      await expect(page.locator('#toast .toast-action')).toBeVisible();
      if (c.state === 'restored') await page.click('#toast .toast-action');
    }
    await expect(offer).toBeHidden();

    const screen = await page.evaluate(() => ({
      pages: window.v2.getDoc().pages.map((p) => ({ w: p.width, h: p.height })),
      views: [...document.querySelectorAll('.pv-page')].map((v) => v.offsetWidth),
    }));
    const k = c.first[0] / c.second[0];
    const expectedP2 = c.state === 'evened' ? [c.second[0] * k, c.second[1] * k] : c.second;
    expect(screen.pages[1].w).toBeCloseTo(expectedP2[0], 1);
    expect(screen.pages[1].h).toBeCloseTo(expectedP2[1], 1);

    await page.click('#btn-download');
    const { buf } = await downloadBytes(page, () => page.click('#ds-cta'));
    const file = await readFile(page, buf);
    expect(file.length).toBe(2);
    for (let i = 0; i < 2; i++) {
      expect(file[i].w, `page ${i + 1} width, file vs screen`).toBeCloseTo(screen.pages[i].w, 0);
      expect(file[i].h, `page ${i + 1} height, file vs screen`).toBeCloseTo(screen.pages[i].h, 0);
      const label = file[i].labels.find((l) => l.str.includes(WIDTH_LABELS[i]));
      expect(label, `page ${i + 1} label is in the file`).toBeTruthy();
      expect(label.fx, `page ${i + 1} label x fraction`).toBeCloseTo(0.2, 2);
      expect(label.fy, `page ${i + 1} label y fraction`).toBeCloseTo(0.3, 2);
    }
    // The same relative width in the file as on the stage.
    expect(file[1].w / file[0].w).toBeCloseTo(screen.views[1] / screen.views[0], 2);
  });
}
