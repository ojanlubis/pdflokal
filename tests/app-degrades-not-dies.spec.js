/*
 * A MISSING ELEMENT COSTS ONE CONTROL, IN A REAL BROWSER.
 * ============================================================================
 * ⚠️ WRITTEN BUT NOT RUN by the session that added it (2026-09-07) — port 5050
 * serialises across sessions and the seat owns the single gate run.
 *
 * tests/core/app-boot-dom-guards.test.mjs proves the on() helper declines and
 * proves no top-level dereference is left in the source. Neither of those is
 * the user-facing claim, which is: with an element genuinely absent, the EDITOR
 * STILL BOOTS. Only a browser executing the real module graph can say that.
 *
 * The exact incident is reproduced — HTML without `id="fm-pages"`, served
 * beside a fresh app.js (Sentry JAVASCRIPT-V/J, 6 events, 2026-08-18 → 08-30).
 * Before the guards this took down the whole product; the assertion below is
 * that it now takes down the File-menu's "Kelola Halaman" row and nothing else.
 */
import { test, expect } from '@playwright/test';

test('HTML missing #fm-pages: the editor still boots, only that one row is dead', async ({ page }) => {
  let loads = 0;
  page.on('load', () => { loads++; });

  await page.route('http://localhost:5050/', async (route) => {
    const res = await route.fetch();
    const body = (await res.text()).replace(/\sid="fm-pages"/, '');
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body });
  });

  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.goto('/');

  // THE CLAIM: the module graph is alive. The dropzone, the File button and the
  // toolbar all exist, which they could not if app.js had died at top level.
  await expect(page.locator('#btn-open')).toBeVisible();
  await expect(page.locator('#btn-file')).toBeVisible();
  await expect(page.locator('#fm-pages')).toHaveCount(0); // genuinely absent — the fixture is real

  // Nothing threw at module top level, so nothing to heal and nothing to report.
  expect(consoleErrors.filter((e) => /addEventListener|is not an object|Cannot read properties of null/.test(e))).toEqual([]);
  await page.waitForTimeout(500);
  expect(loads).toBe(1); // the boot guard did NOT fire — there was no error to fire on

  // And the surviving siblings in the same File menu are still wired: #fm-add
  // and #fm-new were bound after #fm-pages in source order, so before the
  // guards they were collateral damage of the very same throw.
  await page.locator('#btn-file').click();
  await expect(page.locator('#fm-add')).toBeVisible();
  await expect(page.locator('#fm-new')).toBeVisible();
});
