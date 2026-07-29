/*
 * PASTE A SIGNATURE IMAGE (Ctrl/Cmd+V) — v2, the code users actually run.
 * ============================================================================
 * ⚠️ THIS COVERS A PROMISE THE PRODUCT WAS BREAKING. The changelog tells users:
 * "Pas jendela tanda tangan kebuka, tinggal tempel (Ctrl/Cmd+V), langsung masuk
 * tanpa perlu simpan file dulu." v2 shipped with NO ClipboardEvent handling
 * anywhere in js/v2/ — the feature did not exist on the live product.
 *
 * ⚠️ AND THERE WAS A SPEC THAT LOOKED LIKE IT COVERED THIS. `signature-paste.spec.js`
 * drives /alat-gambar.html — the dead old wing — through window.ueState. Anyone
 * answering "is signature paste tested?" by filename got the wrong answer.
 * docs/test-suite-audit.md, Class 3, called it the sharpest instance.
 *
 * ⚠️ THE FIXTURE IS DELIBERATELY NOT THE 1x1 RED PIXEL the sibling spec uses.
 * The audit's Class 1 note: that fixture "has no background to remove", so a
 * test using it passes whether or not background removal and ink-trimming
 * exist at all. This one is a WHITE canvas with a small dark mark off-centre,
 * which means the two things the pipeline is supposed to do — trim to the ink,
 * and knock out the white — both have something to bite on and can be measured.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');

const SRC_W = 300;
const SRC_H = 200;

/**
 * Build the image IN THE PAGE and paste it via a real ClipboardEvent carrying a
 * real File — the same shape the browser delivers when a user copies an image
 * from another app. Returns what the preview looked like afterwards.
 */
async function pasteSignature(page, { removeBg }) {
  return page.evaluate(async ({ w, h, removeBg: rb }) => {
    // A white card with a dark stroke in the middle third.
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#101010';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(w * 0.35, h * 0.55);
    ctx.lineTo(w * 0.5, h * 0.4);
    ctx.lineTo(w * 0.65, h * 0.6);
    ctx.stroke();

    const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
    const file = new File([blob], 'ttd.png', { type: 'image/png' });

    document.getElementById('sig-removebg').checked = rb;

    const dt = new DataTransfer();
    dt.items.add(file);
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));

    // The image decodes asynchronously before the preview is drawn.
    const preview = document.getElementById('sig-preview');
    for (let i = 0; i < 60; i++) {
      if (preview.querySelector('canvas')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const out = preview.querySelector('canvas');
    if (!out) return { drawn: false };

    const octx = out.getContext('2d', { willReadFrequently: true });
    const d = octx.getImageData(0, 0, out.width, out.height).data;
    let opaqueWhite = 0; let transparent = 0; let dark = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 16) transparent++;
      else if (d[i] > 240 && d[i + 1] > 240 && d[i + 2] > 240) opaqueWhite++;
      else if (d[i] < 80) dark++;
    }
    const total = out.width * out.height;
    return {
      drawn: true,
      w: out.width,
      h: out.height,
      activeTab: document.querySelector('.sig-tab.on')?.dataset.tab
        || document.querySelector('.sig-tab[aria-selected="true"]')?.dataset.tab || null,
      transparentRatio: transparent / total,
      opaqueWhiteRatio: opaqueWhite / total,
      darkRatio: dark / total,
    };
  }, { w: SRC_W, h: SRC_H, removeBg });
}

async function openSignatureSheet(page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expectFirstPage(page);
  await page.click('[data-tool="signature"]');
  await expect(page.locator('#sig-modal')).toBeVisible();
}

test.describe('signature paste — v2', () => {
  test('pasting an image lands it in the sheet, trimmed to the ink', async ({ page }) => {
    await openSignatureSheet(page);

    // The preview must be EMPTY first, or "a canvas exists" proves nothing.
    expect(await page.locator('#sig-preview canvas').count()).toBe(0);

    const r = await pasteSignature(page, { removeBg: false });

    expect(r.drawn, 'nothing was drawn into the preview — the paste never reached the sheet').toBe(true);
    expect(r.activeTab, 'paste did not switch to the upload tab, so the user pastes and sees nothing').toBe('upload');

    // It must contain the actual mark, not be a blank canvas.
    expect(r.darkRatio, 'the preview has no dark pixels — the pasted image did not make it through').toBeGreaterThan(0.01);

    // ⚠️ WITH BACKGROUND REMOVAL OFF, THE PREVIEW IS THE FULL SOURCE SIZE, and
    // that is correct, not a bug. trimToInk crops to the ALPHA bounding box; an
    // opaque white card has no transparent margin, so there is nothing to trim.
    // The first version of this test asserted a crop here and failed a working
    // product. The trim is exercised in the next test, where it can actually
    // bite — and asserting it there is also the only place it discriminates.
    expect(r.w).toBe(SRC_W);
    expect(r.h).toBe(SRC_H);
  });

  test('with "hapus background" on, the white ground really is knocked out', async ({ page }) => {
    await openSignatureSheet(page);
    const off = await pasteSignature(page, { removeBg: false });
    expect(off.drawn).toBe(true);

    await page.reload();
    await page.setInputFiles('#file-input', FIXTURE);
    await expectFirstPage(page);
    await page.click('[data-tool="signature"]');
    await expect(page.locator('#sig-modal')).toBeVisible();
    const on = await pasteSignature(page, { removeBg: true });
    expect(on.drawn).toBe(true);

    // ⚠️ THE COMPARISON IS THE TEST. Asserting "some pixels are transparent"
    // alone would pass on a PNG that merely has transparent corners from the
    // trim. The discriminating fact is that turning the checkbox ON converts
    // opaque white INTO transparent, and turning it off does not.
    expect(
      off.opaqueWhiteRatio,
      'with background removal OFF the white ground should still be opaque — if it is already '
      + 'transparent here, the next assertion cannot tell the feature from the fixture',
    ).toBeGreaterThan(0.2);

    expect(
      on.transparentRatio,
      `background removal ON left only ${(on.transparentRatio * 100).toFixed(1)}% transparent `
      + `(OFF was ${(off.transparentRatio * 100).toFixed(1)}%). The white box around the signature `
      + 'will print as a white box over the document.',
    ).toBeGreaterThan(off.transparentRatio + 0.2);

    // The ink must survive the knockout — this is the failure mode where a too
    // aggressive threshold erases the signature along with its background.
    expect(on.darkRatio, 'background removal erased the signature itself').toBeGreaterThan(0.01);

    // AND NOW THE TRIM BITES. Knocking out the white leaves a transparent
    // margin, so trimToInk can crop to the mark. The mark occupies roughly the
    // middle 30% x 20% of the 300x200 source; a preview still at source size
    // means the signature places with a large invisible margin around it and
    // lands nowhere near where the user drops it.
    expect(
      on.w, `preview is ${on.w}x${on.h} after background removal; the source was ${SRC_W}x${SRC_H} `
      + 'and was never trimmed to its ink',
    ).toBeLessThan(SRC_W * 0.75);
    expect(on.h).toBeLessThan(SRC_H * 0.75);
    expect(off.w, 'sanity: with removal OFF nothing should have been trimmed').toBe(SRC_W);
  });

  test('pasting text while the sheet is open is not an error and changes nothing', async ({ page }) => {
    await openSignatureSheet(page);
    const defaultPrevented = await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'bukan gambar');
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      document.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    expect(defaultPrevented, 'a text paste was swallowed by the signature handler').toBe(false);
    expect(await page.locator('#sig-preview canvas').count()).toBe(0);
    await expect(page.locator('#sig-modal')).toBeVisible();
  });

  test('paste does NOT hijack the clipboard when the sheet is closed', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('#file-input', FIXTURE);
    await expectFirstPage(page);
    // Sheet never opened.
    const r = await page.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = 40; c.height = 40;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 40, 40);
      const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'x.png', { type: 'image/png' }));
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      document.dispatchEvent(ev);
      await new Promise((r2) => setTimeout(r2, 300));
      return {
        prevented: ev.defaultPrevented,
        previewCanvases: document.getElementById('sig-preview').querySelectorAll('canvas').length,
        sheetOpen: document.getElementById('sig-modal').open,
      };
    });
    expect(r.prevented, 'the signature sheet consumed a paste while closed').toBe(false);
    expect(r.previewCanvases).toBe(0);
    expect(r.sheetOpen).toBe(false);
  });
});
