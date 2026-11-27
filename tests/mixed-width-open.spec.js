/*
 * PDFLokal: a document whose pages are not all one width opens with EVERY page
 * on screen.
 *
 * WHY this exists (reproduced 2026-11-03 on main 4a892d1): a PDF whose page 1 is
 * an A5 (420pt) and whose later pages are A4 (595pt) opened fitted to PAGE 1.
 * On a 375px phone the A4 pages were 509px wide inside a 375px scroller and page
 * 1 sat off-centre; on a 1280px desktop the A4 pages ran to 1677px. Founder
 * ruling 2026-11-03: the view fits the WIDEST page, so every page is visible and
 * centred and the narrower pages are simply narrower. View only: the document
 * keeps its page sizes (that is a separate, later feature).
 *
 * The PDF is built in the page with the vendored pdf-lib, so the fixture is the
 * parameter (two page widths) and not a file that could drift.
 */
import { test, expect } from '@playwright/test';

const A5 = [420, 595];
const A4 = [595, 842];

async function openMixedWidth(page) {
  await page.goto('/');
  await page.evaluate(async ([a5, a4]) => {
    const { ensurePdfLib } = await import('/js/core/vendor.js');
    const { PDFLib } = await ensurePdfLib();
    const d = await PDFLib.PDFDocument.create();
    d.addPage(a5);
    d.addPage(a4);
    d.addPage(a4);
    const bytes = await d.save();
    await window.v2.loadFiles([new File([bytes], 'campur.pdf', { type: 'application/pdf' })]);
  }, [A5, A4]);
  await expect(page.locator('.pv-page')).toHaveCount(3);
}

const zoomOf = (page) => page.evaluate(() =>
  parseFloat(document.getElementById('v2-stage').style.getPropertyValue('--zoom')));

function expectAllInside(m) {
  expect(m.pages.length).toBe(3);
  for (const p of m.pages) expect(p.width).toBeGreaterThan(50);
  expect(m.scrollWidth).toBeLessThanOrEqual(m.clientWidth);
  for (const p of m.pages) {
    expect(p.left).toBeGreaterThanOrEqual(-0.5);
    expect(p.right).toBeLessThanOrEqual(m.clientWidth + 0.5);
  }
}

// Where every page sits, in on-screen px relative to the scroller's visible box.
function measure(page) {
  return page.evaluate(() => {
    const sc = document.getElementById('v2-scroll');
    const box = sc.getBoundingClientRect();
    const pages = [...document.querySelectorAll('.pv-page')].map((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left - box.left, right: r.right - box.left, width: r.width };
    });
    return {
      scrollWidth: sc.scrollWidth,
      clientWidth: sc.clientWidth,
      pages,
      modelWidths: window.v2.getDoc().pages.map((p) => p.width),
    };
  });
}

for (const vp of [{ width: 375, height: 812 }, { width: 1280, height: 800 }]) {
  test(`mixed page widths open with every page inside the view at ${vp.width}px`, async ({ page }) => {
    await page.setViewportSize(vp);
    await openMixedWidth(page);
    const m = await measure(page);

    // VACUITY GUARDS: the document really is mixed-width (a single file is not
    // normalised), and the pages really were measured.
    expect(m.modelWidths).toEqual([A5[0], A4[0], A4[0]]);
    expectAllInside(m);

    // The widest page is centred: equal gutters left and right.
    const widest = m.pages.reduce((a, b) => (b.width > a.width ? b : a));
    expect(Math.abs(widest.left - (m.clientWidth - widest.right))).toBeLessThanOrEqual(2);
  });
}

test('Ctrl/Cmd + 0 on a mixed-width document lands on the opening fit, every page inside', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openMixedWidth(page);
  // A mixed-width open offers Samakan lebar (#198) in a dialog, and zoom keys
  // stand down while any dialog is open. Decline it first, or the keys below
  // never reach the zoom (red every night 2026-11-04..11-12, read 11-12).
  await expect(page.locator('#even-offer')).toBeVisible();
  await page.click('#eo-later');
  await expect(page.locator('#even-offer')).toBeHidden();
  const z0 = await zoomOf(page);
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${mod}+Equal`);
  await page.keyboard.press(`${mod}+Equal`);
  expect(await zoomOf(page)).not.toBeCloseTo(z0, 2); // VACUITY GUARD: the keys did zoom
  await page.keyboard.press(`${mod}+0`);
  expect(await zoomOf(page)).toBeCloseTo(z0, 3);
  expectAllInside(await measure(page));
});
