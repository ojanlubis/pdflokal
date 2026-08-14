/*
 * Play Store demand-validation drive — ENDED.
 * ============================================================================
 * Founder call 2026-07-19 scoped the drive to two weeks; it expired 2 Aug.
 * PM ruling (bench brief 2026-08-14): flip js/v2/celebrate.js's
 * PLAYSTORE_CAMPAIGN to false. The download moment's vote card (#vote-card)
 * must never take the slot from share/tip again — tests/mobile/playstore-
 * vote.spec.js (the drive's own guard suite, whose header literally says
 * "When PLAYSTORE_CAMPAIGN flips to false in celebrate.js, retire this file
 * with the module") is retired alongside this change; this file is its
 * replacement, proving the OFF state rather than the drive's behaviour.
 *
 * The module itself (js/v2/playstore-vote.js) is left in place — celebrate.js
 * still imports createPlaystoreVote, and PLAYSTORE_CAMPAIGN's short-circuit
 * (`if (PLAYSTORE_CAMPAIGN && vote.maybeShow()) return;`) means it is never
 * even invoked. Removing the module itself is a separate, larger change than
 * "one line" and out of scope here.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');

async function downloadOnce(page) {
  await page.click('#btn-download');
  const dl = page.waitForEvent('download');
  await page.click('#ds-cta');
  await dl;
}

test.describe('Play Store vote card — campaign ended', () => {
  test('a download never shows the vote card; share/tip takes the moment as normal', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('#file-input', FIXTURE);
    await expectFirstPage(page);
    await downloadOnce(page);

    // Give the card its normal appearance window, then assert it never came.
    await page.waitForTimeout(1500);
    await expect(page.locator('#vote-card')).toBeHidden();
    await expect(page.locator('#vote-card')).not.toHaveClass(/show/);

    // The moment falls through to the ordinary share/tip card — the vote never
    // "wins" the slot now that the drive is off, same as a voted/opted-out user.
    await expect(page.locator('#support-card')).toBeVisible({ timeout: 4000 });
  });

  test('no vote is ever recorded — the module is unreachable, not merely quiet', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('#file-input', FIXTURE);
    await expectFirstPage(page);
    await downloadOnce(page);
    await page.waitForTimeout(1500);

    const voted = await page.evaluate(() => localStorage.getItem('pdflokal-ps-voted'));
    expect(voted).toBeNull();
  });
});
