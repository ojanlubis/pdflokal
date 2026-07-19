/*
 * TEMPORARY — Play Store demand-validation vote (js/v2/playstore-vote.js).
 * At the download moment, during the drive, the binary vote takes the slot from
 * share/tip. Two steps: vote → tester opt-in (only for "Ya"). GA4 events +
 * gating (vote once, never re-ask; dismiss backs off for the day).
 *
 * When PLAYSTORE_CAMPAIGN flips to false in celebrate.js, retire this file with
 * the module. Until then, this suite is the guard on the drive's behavior.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'sample-2pages.pdf');

async function downloadOnce(page) {
  await page.tap('#btn-download');
  const dl = page.waitForEvent('download');
  await page.tap('#ds-cta');
  await dl;
}
async function openDoc(page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
}
// track() bails before gtag unless Vercel Analytics (window.va) is "loaded" —
// locally the insights script 404s, so stub va as a function. track() then fans
// out to the app's real inline gtag(), which pushes to window.dataLayer, where
// we read the events (our own stub would be clobbered by that inline gtag).
async function armAnalytics(page) {
  await page.addInitScript(() => { window.va = () => {}; });
}
async function events(page) {
  return page.evaluate(() => (window.dataLayer || []).map((a) => Array.from(a)));
}

test.describe('Play Store vote — mobile', () => {
  test('download shows the vote (not share/tip); "Ya" reveals tester opt-in → form', async ({ page }) => {
    await armAnalytics(page);
    await openDoc(page);
    await downloadOnce(page);

    // The vote takes the moment; the share/tip card stays hidden.
    await expect(page.locator('#vote-card')).toBeVisible({ timeout: 4000 });
    await expect(page.locator('.vc-s1 .vc-head')).toContainText('Play Store');
    await expect(page.locator('#support-card')).toBeHidden();

    // "Ya, mau" → GA4 yes vote + step 2 (tester opt-in) revealed in place.
    await page.tap('#vc-yes');
    await expect(page.locator('#vote-card .vc-s2')).toBeVisible();
    await expect(page.locator('#vote-card .vc-s1')).toBeHidden();
    await expect(page.locator('#vc-tester')).toHaveAttribute('href', /forms\.gle\//);

    const ev = await events(page);
    expect(ev.some((a) => a[1] === 'vote_playstore' && a[2]?.choice === 'yes')).toBe(true);
  });

  test('"Nggak perlu" counts the no, closes, and never re-asks (voted)', async ({ page }) => {
    await armAnalytics(page);
    await openDoc(page);
    await downloadOnce(page);
    await expect(page.locator('#vote-card')).toBeVisible({ timeout: 4000 });

    await page.tap('#vc-no');
    await expect(page.locator('#vote-card')).toBeHidden();
    const ev = await events(page);
    expect(ev.some((a) => a[1] === 'vote_playstore' && a[2]?.choice === 'no')).toBe(true);

    // Voted → the next download falls through to the normal share/tip card.
    await downloadOnce(page);
    await expect(page.locator('#support-card')).toBeVisible({ timeout: 4000 });
    await expect(page.locator('#vote-card')).toBeHidden();
  });

  test('tester_optin fires on click-through to the form', async ({ page }) => {
    await armAnalytics(page);
    await openDoc(page);
    await downloadOnce(page);
    await page.tap('#vc-yes');
    // Neutralize the real navigation (target _blank would open a popup); the
    // click still runs the module's handler that fires the event.
    await page.evaluate(() => {
      const a = document.getElementById('vc-tester');
      a.setAttribute('target', '_self');
      a.setAttribute('href', '#');
    });
    await page.tap('#vc-tester');
    const ev = await events(page);
    expect(ev.some((a) => a[1] === 'tester_optin')).toBe(true);
  });

  test('scrim tap dismisses without voting; same day stays quiet', async ({ page }) => {
    await openDoc(page);
    await downloadOnce(page);
    await expect(page.locator('#vote-card')).toBeVisible({ timeout: 4000 });

    // Tap the scrim (top-left corner, outside the inner card) → dismiss, no vote.
    await page.locator('#vote-card').click({ position: { x: 8, y: 8 } });
    await expect(page.locator('#vote-card')).toBeHidden();
    const voted = await page.evaluate(() => localStorage.getItem('pdflokal-ps-voted'));
    expect(voted).toBeNull(); // dismissed ≠ voted; the file was never held hostage

    // Same calendar day → no second ask.
    await downloadOnce(page);
    await page.waitForTimeout(1600);
    await expect(page.locator('#vote-card')).toBeHidden();
  });
});
