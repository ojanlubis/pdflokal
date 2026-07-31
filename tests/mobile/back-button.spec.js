/*
 * Android back button: closes the open sheet, never leaves the editor.
 * (Every dialog open pushes a history entry; back pops it → dialog closes;
 * UI-initiated closes consume their own entry without side effects.)
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from '../helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'sample-2pages.pdf');

async function openDoc(page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expectFirstPage(page);
}

test.describe('back button — mobile', () => {
  test('back closes Kelola Halaman instead of leaving the page', async ({ page }) => {
    await openDoc(page);
    await page.tap('#btn-pages');
    await expect(page.locator('#pm-sheet')).toBeVisible();
    await page.goBack();
    await expect(page.locator('#pm-sheet')).toBeHidden();
    expect(new URL(page.url()).pathname).toBe('/'); // still here, not navigated away
    await expect(page.locator('.pv-page').first()).toBeVisible();
  });

  test('nested sheets: back peels one layer at a time', async ({ page }) => {
    await openDoc(page);
    await page.tap('#btn-download');
    await expect(page.locator('#dl-sheet')).toBeVisible();
    await page.tap('#ds-pages [data-v="some"]'); // Kelola Halaman on top
    await expect(page.locator('#pm-sheet')).toBeVisible();

    await page.goBack();
    await expect(page.locator('#pm-sheet')).toBeHidden();
    await expect(page.locator('#dl-sheet')).toBeVisible(); // still one layer left
    await page.waitForTimeout(250); // let traversal #1 fully settle (see rapid test below)

    await page.goBack();
    await expect(page.locator('#dl-sheet')).toBeHidden();
    expect(new URL(page.url()).pathname).toBe('/');
  });

  test('RAPID double-back (coalesced traversal) still closes everything, stays on page', async ({ page }) => {
    await openDoc(page);
    await page.tap('#btn-download');
    await page.tap('#ds-pages [data-v="some"]');
    await expect(page.locator('#pm-sheet')).toBeVisible();

    // Two backs as fast as the harness can fire them — the browser may
    // coalesce them into a single popstate. Outcome must be the same.
    await Promise.all([page.goBack(), page.goBack()]).catch(() => {});
    await expect(page.locator('#pm-sheet')).toBeHidden();
    await expect(page.locator('#dl-sheet')).toBeHidden();
    expect(new URL(page.url()).pathname).toBe('/');
    await expect(page.locator('.pv-page').first()).toBeVisible();
  });

  test('UI close (✕) leaves history clean: back after it does not reopen or exit oddly', async ({ page }) => {
    await openDoc(page);
    await page.tap('#btn-download');
    await expect(page.locator('#dl-sheet')).toBeVisible();
    await page.tap('#ds-close');
    await expect(page.locator('#dl-sheet')).toBeHidden();
    // The dialog's history entry was consumed — nothing dialog-ish left to pop.
    // (history.back() is async — poll.)
    await expect.poll(async () => page.evaluate(() => window.history.state?.v2dlg || null)).toBe(null);
  });

  // ---- the editor-active guard: back with NO sheet open must ask before leaving,
  // never leave silently. This is the bug fix — everything above this line covers
  // the pre-existing dialog-stacking behaviour, unchanged.
  test.describe('back with an open document and no sheet open', () => {
    test('shows #home-confirm and does NOT navigate away', async ({ page }) => {
      await openDoc(page);
      await page.goBack();
      // VACUITY GUARD: this is the one test in the file that goes red if the fix
      // is reverted. Before the fix, loadFiles() pushed no history entry at all,
      // so this exact goBack() popped straight out of the app — the dialog never
      // renders (toBeVisible times out) and the pathname assertion below fails
      // too, because the page has actually navigated away from '/'. A weaker
      // assertion — e.g. only checking the dialog OR only checking the URL —
      // would still catch a full revert, but checking both together also catches
      // a half-fix that shows the dialog on top of a page that already left.
      await expect(page.locator('#home-confirm')).toBeVisible();
      expect(new URL(page.url()).pathname).toBe('/');
      // The document itself is still there, underneath the dialog.
      await expect.poll(() => page.evaluate(() => document.body.classList.contains('is-empty'))).toBe(false);
    });

    test('cancel, then back again → the dialog shows again (guard entry re-established)', async ({ page }) => {
      await openDoc(page);
      await page.goBack();
      await expect(page.locator('#home-confirm')).toBeVisible();
      await page.tap('#hc-cancel');
      await expect(page.locator('#home-confirm')).toBeHidden();
      expect(new URL(page.url()).pathname).toBe('/'); // cancel does not navigate
      // Cancel's own entry-consumption is history.back() under the hood (the
      // dialog's `close` listener, shared by all four dialogs) — an async browser
      // navigation, same as the pre-existing "UI close (✕)" test above already
      // has to poll for. Firing a second real back before it lands would race our
      // own setup: manual reproduction against a live page hit exactly this if the
      // consuming back() had not yet been processed (confirmed by hand — polling
      // `state?.v2dlg` here is what makes that ordering deterministic instead of
      // load-bearing luck).
      await expect.poll(async () => page.evaluate(() => window.history.state?.v2dlg || null)).toBe(null);

      // If cancel only consumed the dialog's own entry without re-pushing the
      // editor guard beneath it, THIS back would walk straight past the guard
      // and out of the app — same failure shape as the test above.
      await page.goBack();
      await expect(page.locator('#home-confirm')).toBeVisible();
      expect(new URL(page.url()).pathname).toBe('/');
    });

    test('confirm navigates home, reusing #hc-go (no second nav path)', async ({ page }) => {
      await openDoc(page);
      await page.goBack();
      await expect(page.locator('#home-confirm')).toBeVisible();
      await page.tap('#hc-go');
      // #hc-go always did `window.location.assign('/')` — a real navigation, which
      // resets the app to its landing (is-empty) state. That state is the right
      // signal (the URL is already '/' before this tap), but it must be read with
      // a LOCATOR, not page.evaluate().
      //
      // ⚠️ WHY: an evaluate() poll races the navigation it is waiting for. The
      // old execution context is torn down mid-call and Playwright throws
      // "Execution context was destroyed" — which expect.poll does NOT retry, it
      // propagates. The gate went red here on 2026-07-31 while the failure
      // screenshot showed the landing rendered correctly: a green product and a
      // red test, caused entirely by the instrument. Locator assertions
      // re-resolve against the NEW document, so they survive the navigation.
      //
      // Not vacuous: with a document open, body does NOT carry is-empty, so this
      // can only pass after the fresh landing has actually loaded.
      await expect(page.locator('body')).toHaveClass(/\bis-empty\b/, { timeout: 10_000 });
    });

    test('a sheet open + back closes the SHEET only — editor stays open, no home dialog', async ({ page }) => {
      await openDoc(page);
      await page.tap('#btn-download');
      await expect(page.locator('#dl-sheet')).toBeVisible();

      await page.goBack();
      await expect(page.locator('#dl-sheet')).toBeHidden();
      await expect(page.locator('#home-confirm')).toBeHidden(); // NOT offered yet
      expect(new URL(page.url()).pathname).toBe('/');
      await expect.poll(() => page.evaluate(() => document.body.classList.contains('is-empty'))).toBe(false);
    });

    test('...and THAT back closed, the next back now shows the home dialog', async ({ page }) => {
      await openDoc(page);
      await page.tap('#btn-download');
      await expect(page.locator('#dl-sheet')).toBeVisible();
      await page.goBack();
      await expect(page.locator('#dl-sheet')).toBeHidden();
      await page.waitForTimeout(250); // let traversal #1 fully settle, same as the nested-sheets test above

      await page.goBack();
      await expect(page.locator('#home-confirm')).toBeVisible();
      expect(new URL(page.url()).pathname).toBe('/');
    });
  });
});
