/*
 * THE EDITOR CHROME — one row when the width holds it, two when it does not.
 * ============================================================================
 * RULED 2026-09-09: "buat desktop, pindahin tools2nya ke atas. karena spacenya
 * kosong, cuma bikin dua baris navbar kalo spacenya ga cukup aja". So the
 * two-row layout is the FALLBACK; one row is the default wherever it fits.
 *
 * ⚠️ WHAT MAKES THIS A TEST AND NOT A SCREENSHOT: the toolbar is ONE element in
 * two layouts, never two elements. A duplicate tool row for desktop would drift
 * — a tool added to one and not the other, an `active` state that only clears
 * on one. The assertions below are about identity (same buttons, same count,
 * same ids) as much as about geometry.
 *
 * ⚠️ THE BREAKPOINT IS MEASURED. `.spacer { flex: 1 }` is the slack in the
 * merged row, and its width is the headroom: 152px at 1000, 52 at 900, 12 at
 * 860, ZERO at 848. 900 is the true minimum plus a stated ~50px so the row
 * never sits flush. If a tool is added or a label reworded, RE-MEASURE and move
 * this file with the CSS — a stale breakpoint ships as a cramped row, never as
 * an error, which is exactly the kind of defect nothing else here would catch.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BREAKPOINT = 900;

async function openEditor(page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', path.join(__dirname, 'fixtures', 'sample-2pages.pdf'));
  await expectFirstPage(page);
}

// Is the toolbar on its own line, or sharing the header's?
const rows = (page) => page.evaluate(() => {
  const h = document.querySelector('header').getBoundingClientRect();
  const t = document.querySelector('#toolbar').getBoundingClientRect();
  return t.top >= h.top + 40 ? 2 : 1;
});

test.describe('editor chrome — the merged row', () => {
  test('at or above the breakpoint the tools share the header row', async ({ page }) => {
    await page.setViewportSize({ width: BREAKPOINT, height: 800 });
    await openEditor(page);
    expect(await rows(page)).toBe(1);
  });

  test('one pixel below it, the toolbar takes its own row again', async ({ page }) => {
    // THE PAIR IS THE TEST. "It is one row at 1280" passes on a layout that is
    // ALWAYS one row, which would put the tools on top of each other on a
    // phone. Both sides of the same boundary, or neither proves anything.
    await page.setViewportSize({ width: BREAKPOINT - 1, height: 800 });
    await openEditor(page);
    expect(await rows(page)).toBe(2);
  });

  test('a phone is unchanged — two rows, exactly as before', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await openEditor(page);
    expect(await rows(page)).toBe(2);
  });

  test('ONE toolbar in both layouts — the same buttons, never a desktop copy', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openEditor(page);
    const wide = await page.locator('#toolbar .tool').evaluateAll((els) => els.map((e) => e.dataset.tool || e.id));
    expect(await page.locator('#toolbar').count()).toBe(1);

    await page.setViewportSize({ width: 700, height: 800 });
    await page.waitForTimeout(150);
    const narrow = await page.locator('#toolbar .tool').evaluateAll((els) => els.map((e) => e.dataset.tool || e.id));
    expect(await page.locator('#toolbar').count()).toBe(1);
    expect(narrow).toEqual(wide);
    expect(wide.length).toBeGreaterThan(3); // the list must not be empty for this to mean anything
  });

  test('nothing below the chrome is hidden underneath it', async ({ page }) => {
    // --chrome-h replaced `calc(--header-h + --toolbar-h)` at every use site,
    // because that sum stopped being true the moment the two could share a row.
    // A wrong value here does not throw: the first page just sits under the
    // bar. So it is measured, at both layouts.
    for (const w of [1280, 700]) {
      await page.setViewportSize({ width: w, height: 800 });
      await openEditor(page);
      const gap = await page.evaluate(() => {
        const h = document.querySelector('header').getBoundingClientRect();
        const p = document.querySelector('.pv-page').getBoundingClientRect();
        return Math.round(p.top - h.bottom);
      });
      expect(gap, `viewport ${w}`).toBeGreaterThanOrEqual(0);
    }
  });

  test('the tools are still reachable targets on the merged row', async ({ page }) => {
    // The label moved beside the icon to fit a 52px row; the control must not
    // have shrunk below a usable target in the process.
    await page.setViewportSize({ width: 1280, height: 800 });
    await openEditor(page);
    for (const t of await page.locator('#toolbar .tool').all()) {
      const box = await t.boundingBox();
      expect(box.height, await t.innerText()).toBeGreaterThanOrEqual(32);
      expect(box.width, await t.innerText()).toBeGreaterThanOrEqual(44);
    }
    // and they still work
    await page.click('[data-tool="whiteout"]');
    await expect(page.locator('[data-tool="whiteout"]')).toHaveAttribute('aria-pressed', 'true');
  });
});
