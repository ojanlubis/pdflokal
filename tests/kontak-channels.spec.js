/*
 * THE FEEDBACK TAB — what replaced his five social channels.
 * ============================================================================
 * REWRITTEN 2026-09-09 on his ruling: "ilangin semua sosmed gue, gaada yang
 * peduli wkwk, ganti jadi feedback form aja". The floating tab bottom-left used
 * to be a chat glyph opening a panel of five handles. Both are gone.
 *
 * ⚠️ WHY THIS FILE WAS REWRITTEN RATHER THAN DELETED, and it is the whole
 * point. The old suite existed because a mistyped handle does not 404 — social
 * platforms hand a near-miss username to whoever actually owns it, so the
 * failure mode was a working link to a STRANGER'S account shipped under his
 * name. Removing the links removes that risk only while they stay removed. So
 * the guard inverts: it used to pin the five hrefs verbatim, and now it asserts
 * that NO social handle appears on this surface at all. Deleting the file would
 * have deleted the guard along with the thing it guarded, and an accidental
 * restore — a revert, a copy-paste from an SEO page, a "the panel used to be
 * nicer" — would have shipped silently.
 *
 * SOURCE OF TRUTH for the handles is still engine/wiki/machine/public-identity.md.
 * They are not decided here, they are simply not on this page any more.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The hosts he ships as himself, from the wiki. Present here ONLY so their
// ABSENCE can be asserted — this list must never become a list of links again
// without him saying so.
const SOCIAL_HOSTS = ['tiktok.com', 'instagram.com', 'threads.com', 'x.com', 'ojanlubis.id'];

async function openEditor(page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', path.join(__dirname, 'fixtures', 'sample-2pages.pdf'));
  await expectFirstPage(page);
}

test.describe('the feedback tab', () => {
  test('the tab SAYS what it does — no glyph anyone has to tap to decode', async ({ page }) => {
    // RULED 2026-09-09: "icon ini diganti jadi kata2 aja ya 'ada masukan?'".
    // The string is the footer's, ratified 2026-08-22 — one name for one act.
    await openEditor(page);
    expect((await page.locator('#contact-tab-btn').innerText()).trim()).toBe('Ada masukan?');
    expect(await page.locator('#contact-tab-btn svg').count()).toBe(0);
  });

  test('it stays furniture — no taller than the zoom control on the opposite corner', async ({ page }) => {
    // HIS EARLIER RULING SURVIVES THE RELABEL (2026-08-23: "chip kontak saya di
    // sini kegedean, kecilin lagi"). A labelled tab is wider than an icon by
    // construction, so WIDTH can no longer be the test — HEIGHT is what "same
    // weight as the other floating control" now means, and it is asserted
    // relative to #zoom-ctl rather than as a pixel count, so re-inflating both
    // together still goes red.
    await openEditor(page);
    const chip = await page.locator('#contact-tab-btn').boundingBox();
    const zoom = await page.locator('#zoom-ctl').boundingBox();
    expect(chip.height).toBeLessThanOrEqual(zoom.width);
  });

  test('THE GUARD: no social handle is anywhere on this surface', async ({ page }) => {
    await openEditor(page);
    const hrefs = await page.locator('a[href]').evaluateAll((els) => els.map((e) => e.href));
    // Guard the instrument before believing its verdict: a page with no links
    // at all would pass this for free. [[assertions-over-empty-sets]]
    expect(hrefs.length).toBeGreaterThan(0);
    const found = hrefs.filter((h) => SOCIAL_HOSTS.some((host) => h.includes(host)));
    expect(found, 'a social handle came back onto the editor surface').toEqual([]);
    expect(await page.locator('#contact-tab-panel').count()).toBe(0);
  });

  test('it opens the feedback dialog, and the dialog says who is asking', async ({ page }) => {
    await openEditor(page);
    await page.click('#contact-tab-btn');
    await expect(page.locator('#fb-form')).toBeVisible();

    // The byline that replaced the panel's owner row. mesindev.com is the only
    // link, and it must open away from the editor with rel=noopener — a
    // target=_blank without it hands the opened tab a live handle on this one.
    const link = page.locator('.fb-owner a');
    await expect(link).toHaveAttribute('href', 'https://mesindev.com');
    await expect(link).toHaveAttribute('target', '_blank');
    expect(await link.getAttribute('rel')).toContain('noopener');
    await expect(page.locator('.fb-owner b')).toHaveText('Ojan');
  });

  test('CONTROL: the footer link still opens the SAME dialog — two doors, one form', async ({ page }) => {
    // The tab reuses #fb-open's own handler rather than getting a parallel one.
    // If they ever diverge, one of these two paths stops working and this is
    // where it shows.
    await page.goto('/');
    await page.click('#fb-open');
    await expect(page.locator('#fb-form')).toBeVisible();
    await expect(page.locator('.fb-owner b')).toHaveText('Ojan');
  });
});
