/*
 * The per-page control strip above each page in the main stage (js/v2/page-strip.js):
 * "Halaman n" + move up / move down / rotate / delete. It drives the SAME
 * pageManager mutations as the Halaman sheet, so these tests pin the behaviour
 * (one undo step per click, the model change, the disabled edges, the toast, the
 * telemetry name) and the one thing only a browser can prove: the strip renders at
 * a constant on-screen size although the stage is a scale(zoom) transform.
 * Not run by the foreground gate (nightly CI).
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');

const btn = (page, n, act) => page.locator(`.pv-strip >> nth=${n}`).locator(`[data-strip-act="${act}"]`);
const ids = (page) => page.evaluate(() => window.v2.getDoc().pages.map((p) => p.id));
const rotations = (page) => page.evaluate(() => window.v2.getDoc().pages.map((p) => p.rotation || 0));
const unavailable = async (loc) => (await loc.getAttribute('aria-disabled')) === 'true';

async function openDoc(page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expectFirstPage(page);
  await expect(page.locator('.pv-strip')).toHaveCount(2);
}

test.describe('page strip', () => {
  test('one strip per page: label, four labelled buttons, edges unavailable', async ({ page }) => {
    await openDoc(page);
    await expect(page.locator('.pv-strip-label').nth(0)).toHaveText('Halaman 1');
    await expect(page.locator('.pv-strip-label').nth(1)).toHaveText('Halaman 2');
    for (const [act, label] of [['up', 'Pindah ke atas'], ['down', 'Pindah ke bawah'], ['rotate', 'Putar'], ['delete', 'Hapus Halaman']]) {
      await expect(btn(page, 0, act)).toHaveAttribute('aria-label', label);
      await expect(btn(page, 0, act)).toHaveAttribute('title', label);
    }
    // aria-disabled, never the native attribute (same convention as the bulk bar).
    expect(await unavailable(btn(page, 0, 'up'))).toBe(true);
    expect(await btn(page, 0, 'up').evaluate((el) => el.hasAttribute('disabled'))).toBe(false);
    expect(await unavailable(btn(page, 0, 'down'))).toBe(false);
    expect(await unavailable(btn(page, 1, 'down'))).toBe(true);
    expect(await unavailable(btn(page, 1, 'up'))).toBe(false);
    expect(await unavailable(btn(page, 0, 'delete'))).toBe(false);
    // The bulk bar owns data-act (specs and its own handler select by it): the strip must not shadow it.
    expect(await page.locator('[data-act="rotate"], [data-act="delete"]').count()).toBe(2);
    // The strip is not part of the page: nothing is in the view, and it carries no data-page-id.
    expect(await page.locator('.pv-page .pv-strip').count()).toBe(0);
    expect(await page.locator('.pv-strip[data-page-id]').count()).toBe(0);
  });

  test('move down on page 1 swaps the pages as ONE undo step; labels renumber; undo restores', async ({ page }) => {
    await openDoc(page);
    const [a, b] = await ids(page);
    await btn(page, 0, 'down').click();
    expect(await ids(page)).toEqual([b, a]);
    await expect(page.locator('.pv-strip')).toHaveCount(2);
    await expect(page.locator('.pv-strip-label').nth(0)).toHaveText('Halaman 1');
    // The strip now at index 1 is the moved page's, and its down is the unavailable one.
    expect(await page.locator('.pv-strip >> nth=1').getAttribute('data-strip-for')).toBe(a);
    expect(await unavailable(btn(page, 1, 'down'))).toBe(true);
    await page.keyboard.press('Control+z');
    expect(await ids(page)).toEqual([a, b]);
    // One click was one undo step: nothing further to undo.
    await expect(page.locator('#btn-undo')).toBeDisabled();
  });

  test('the moved page stays under the eye, so the arrow can be clicked again', async ({ page }) => {
    await openDoc(page);
    const [a, b] = await ids(page);
    const stripTop = (id) => page.evaluate((x) =>
      [...document.querySelectorAll('.pv-strip')].find((s) => s.dataset.stripFor === x).getBoundingClientRect().top, id);
    const before = await stripTop(a);
    await btn(page, 0, 'down').click();
    expect(await ids(page)).toEqual([b, a]);
    expect(Math.abs((await stripTop(a)) - before), 'moved down: its strip kept its viewport position').toBeLessThan(3);
    // The clicked button keeps focus (the rebuild must not strand keyboard users).
    await expect(btn(page, 1, 'down')).toBeFocused();
    // ...and the page it moved past is now first.
    await btn(page, 1, 'up').click();
    expect(await ids(page)).toEqual([a, b]);
    expect(Math.abs((await stripTop(a)) - before)).toBeLessThan(3);
    await expect(btn(page, 0, 'up')).toBeFocused();
  });

  test('an unavailable button does nothing and records nothing', async ({ page }) => {
    await openDoc(page);
    const before = await ids(page);
    await btn(page, 0, 'up').click({ force: true });
    await btn(page, 1, 'down').click({ force: true });
    expect(await ids(page)).toEqual(before);
    await expect(page.locator('#btn-undo')).toBeDisabled();
  });

  test('rotate turns that page 90 degrees, once; the sheet thumbnail is invalidated; undo restores', async ({ page }) => {
    await openDoc(page);
    await page.click('#btn-pages'); // fill the sheet's thumb cache
    await expect.poll(() => page.evaluate(() => window.v2.pageManager.thumbCount())).toBe(2);
    await page.click('#pm-close');
    const w0 = await page.locator('.pv-page >> nth=0').evaluate((el) => el.offsetWidth);
    await btn(page, 0, 'rotate').click();
    expect(await rotations(page)).toEqual([90, 0]);
    // The sheet's cached thumbnail for THAT page is dropped (the other stays).
    expect(await page.evaluate(() => window.v2.pageManager.thumbCount())).toBe(1);
    // The rebuilt view is in the rotated frame (width and height swapped).
    const w1 = await page.locator('.pv-page >> nth=0').evaluate((el) => el.offsetWidth);
    expect(w1).not.toBe(w0);
    // The strip is as wide as its (rotated) page.
    const widths = await page.evaluate(() => {
      const s = document.querySelector('.pv-strip'); return [s.offsetWidth, s.nextElementSibling.offsetWidth];
    });
    expect(widths[0]).toBe(widths[1]);
    await page.keyboard.press('Control+z');
    expect(await rotations(page)).toEqual([0, 0]);
    await expect(page.locator('#btn-undo')).toBeDisabled();
  });

  test('delete with 2 pages leaves 1, toasts, disables delete; undo brings it back', async ({ page }) => {
    await openDoc(page);
    const [a, b] = await ids(page);
    await btn(page, 0, 'delete').click();
    expect(await ids(page)).toEqual([b]);
    await expect(page.locator('.pv-strip')).toHaveCount(1);
    await expect(page.locator('#toast')).toContainText('1 halaman dihapus');
    expect(await unavailable(btn(page, 0, 'delete'))).toBe(true);
    expect(await unavailable(btn(page, 0, 'up'))).toBe(true);
    expect(await unavailable(btn(page, 0, 'down'))).toBe(true);
    // The last page cannot be deleted (an empty doc is a dead end).
    await btn(page, 0, 'delete').click({ force: true });
    expect(await ids(page)).toEqual([b]);
    await page.keyboard.press('Control+z');
    expect(await ids(page)).toEqual([a, b]);
    await expect(page.locator('.pv-strip')).toHaveCount(2);
    await expect(page.locator('#btn-undo')).toBeDisabled();
  });

  test('same telemetry as the sheet: editor_action reorder / rotate / delete_page', async ({ page }) => {
    await openDoc(page);
    // track() leaves a Sentry breadcrumb first, before any analytics SDK: spy on it
    // (installed after load, so a late-arriving SDK cannot replace the spy).
    await page.evaluate(() => {
      window.__acts = [];
      const orig = window.Sentry?.addBreadcrumb?.bind(window.Sentry);
      window.Sentry = window.Sentry || {};
      window.Sentry.addBreadcrumb = (b) => {
        if (b.message === 'editor_action') window.__acts.push(b.data.action);
        orig?.(b);
      };
    });
    await btn(page, 0, 'down').click();
    await btn(page, 0, 'rotate').click();
    await btn(page, 0, 'delete').click();
    expect(await page.evaluate(() => window.__acts)).toEqual(['reorder', 'rotate', 'delete_page']);
  });

  test('renders at a constant on-screen size at any zoom (the stage is a scale transform)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openDoc(page);
    const size = () => page.evaluate(() => {
      const b = document.querySelector('.pv-strip button').getBoundingClientRect();
      const s = document.querySelector('.pv-strip').getBoundingClientRect();
      const p = document.querySelector('.pv-page').getBoundingClientRect();
      return { h: Math.round(b.height), strip: Math.round(s.width), page: Math.round(p.width) };
    });
    const a = await size();
    expect(a.h, 'desktop button ~36px').toBe(36);
    expect(a.strip, 'strip is as wide as the rendered page').toBe(a.page);
    await page.click('#z-out');
    await page.click('#z-out');
    const b = await size();
    expect(b.page).not.toBe(a.page); // the zoom really changed
    expect(b.h).toBe(36);
    expect(b.strip).toBe(b.page);
  });

  test('pinch-style zoom keeps the page under the anchor (strips make the stage non-linear)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openDoc(page);
    // Park page 2 mid-viewport, then ctrl+wheel (desktop pinch) over it a few steps.
    await page.evaluate(() => {
      const v = document.querySelectorAll('.pv-page')[1];
      document.getElementById('v2-scroll').scrollTop += v.getBoundingClientRect().top - 300;
    });
    const probe = () => page.evaluate(() => {
      const v = document.querySelectorAll('.pv-page')[1].getBoundingClientRect();
      return { top: v.top, w: v.width };
    });
    const anchorY = 400;
    const b0 = await probe();
    const frac0 = (anchorY - b0.top) / b0.w;
    await page.mouse.move(640, anchorY);
    for (let i = 0; i < 6; i++) {
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, -100);
      await page.keyboard.up('Control');
      await page.waitForTimeout(50);
    }
    const b1 = await probe();
    expect(b1.w).toBeGreaterThan(b0.w);
    const frac1 = (anchorY - b1.top) / b1.w;
    // The same point of the paper (as a fraction of page width) is still under the cursor.
    expect(Math.abs(frac1 - frac0)).toBeLessThan(0.005);
  });
});

test.describe('page strip on a touch screen', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('buttons are at least 44px and fit the phone width', async ({ page }) => {
    await openDoc(page);
    const m = await page.evaluate(() => {
      const s = document.querySelector('.pv-strip');
      const bs = [...s.querySelectorAll('button')].map((b) => b.getBoundingClientRect());
      return {
        n: bs.length,
        coarse: matchMedia('(pointer: coarse)').matches,
        min: Math.round(Math.min(...bs.map((r) => Math.min(r.width, r.height)))),
        right: Math.max(...bs.map((r) => r.right)),
        vw: innerWidth,
        scrollW: document.documentElement.scrollWidth,
      };
    });
    // Count guard: Math.min/max over an empty set is +/-Infinity and every bound
    // below would pass. Catches a strip that rendered with no buttons (or renamed).
    expect(m.n, 'the strip has up/down/rotate/delete').toBe(4);
    expect(m.coarse).toBe(true);
    expect(m.min).toBeGreaterThanOrEqual(44);
    expect(m.right).toBeLessThanOrEqual(m.vw);
    expect(m.scrollW).toBeLessThanOrEqual(m.vw);
  });

  test('tap on the strip does not place or select anything; tap rotates', async ({ page }) => {
    await openDoc(page);
    await btn(page, 0, 'rotate').tap();
    expect(await rotations(page)).toEqual([90, 0]);
    expect(await page.evaluate(() => window.v2.getDoc().selection.annotationId)).toBeNull();
  });
});
