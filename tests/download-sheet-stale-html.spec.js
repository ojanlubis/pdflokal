/*
 * STALE HTML + FRESH JS: THE UNDUH SHEET STILL DOWNLOADS.
 * ============================================================================
 * The incident (rail, 2026-09-09 → 09-21): `runtime / TypeError / undefined-prop`
 * 20-50 ms after `export_intent`, never followed by an `export`. ~20 visitors
 * in 12 days, phone + installed PWA over-represented ~10x, deterministic inside
 * a session, two written complaints that the download "cannot be tapped".
 *
 * `#ds-signed` shipped 2026-09-09 (c254ec9). It is the ONLY editor-path id
 * added since sw.js precached `/` for cache v3 on 2026-09-07, and the failure's
 * first_seen on the rail is the day it shipped. A navigation that falls back to
 * that precached HTML runs today's download-sheet.js against a DOM without the
 * node: render() threw on `null.hidden` BEFORE it reached the CTA, so the sheet
 * opened half-drawn with a dead button — and because render() runs outside
 * buildBase()'s try, the rail filed it as `runtime`, not `export`.
 *
 * Same class as tests/app-degrades-not-dies.spec.js: a missing element costs
 * one control (here, the seal note), never the download.
 *
 * It asserts on `pageerror` AND on the CTA text, because the broken sheet
 * LOOKS open — "the dialog is visible" proves nothing.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));

test('HTML missing #ds-signed: Unduh still renders its CTA and throws nothing', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.route((url) => url.pathname === '/', async (route) => {
    const res = await route.fetch();
    const html = await res.text();
    // The control for the control: if the id ever moves, this test must go red
    // rather than quietly serve an unmodified page and pass for no reason.
    expect(html).toMatch(/\sid="ds-signed"/);
    const body = html.replace(/\sid="ds-signed"/, '');
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body });
  });

  await page.goto('/');
  await page.locator('#file-input').setInputFiles(path.join(here, 'fixtures/sample-2pages.pdf'));
  await expect(page.locator('#btn-download')).toBeEnabled();
  expect(await page.locator('#ds-signed').count()).toBe(0);

  await page.locator('#btn-download').click();
  await expect(page.locator('#dl-sheet')).toBeVisible();
  // The CTA is painted AFTER the seal note in render(); reaching it IS the claim.
  await expect(page.locator('#ds-cta-main')).toContainText('Unduh PDF');
  await expect(page.locator('#ds-all-sub')).toContainText('2 halaman');
  expect(errors).toEqual([]);
});
