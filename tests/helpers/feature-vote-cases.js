/*
 * THE FEATURE VOTE, in a real browser (js/v2/feature-vote.js, founder ruling
 * 2026-10-02). One suite, registered by BOTH tests/feature-vote.spec.js (desktop,
 * chromium) and tests/mobile/feature-vote.spec.js (mobile-chrome), so the same
 * claims are made on both and neither can drift. `door` says how this project
 * reaches the menu link: the desktop nav, or the mobile burger drawer.
 *
 * NO NETWORK: /api/votes and /api/feedback are routed, and navigator.sendBeacon
 * is replaced in the page (the way tests/telemetry.spec.js does it) so the rail
 * event is read as the client built it. A test run never posts to a live table.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'sample-2pages.pdf');

// The card waits for the BERES stamp to clear (SHOW_DELAY_MS = 4400): positive
// assertions allow for it, negative ones wait past it before they count.
const SHOWS_WITHIN = 12_000;
const NOT_BY = 6_000;

const TOP = { voters: 40, counts: { 'pdf-word': 22, watermark: 14, crop: 9, lock: 4 } };

async function wire(page, { votes = TOP, pre = {} } = {}) {
  const feedback = [];
  await page.route('**/api/feedback', async (route) => {
    feedback.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({ status: 204, body: '' });
  });
  await page.route('**/api/votes', async (route) => {
    if (votes === 'fail') await route.fulfill({ status: 503, body: '' });
    else await route.fulfill({ contentType: 'application/json', body: JSON.stringify(votes) });
  });
  await page.addInitScript((seed) => {
    // Seeds run on EVERY navigation of this page object, so a seed must only
    // write a key that is still unset: a reload must not undo what the app wrote.
    for (const [k, v] of Object.entries(seed)) if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
    window.__beacons = [];
    navigator.sendBeacon = (url, blob) => {
      Promise.resolve(blob && blob.text ? blob.text() : blob)
        .then((txt) => { try { window.__beacons.push({ url: String(url), json: JSON.parse(txt) }); } catch { /* ignore */ } });
      return true;
    };
  }, pre);
  return { feedback };
}

const beacons = (page) => page.evaluate(() => (window.__beacons || []).slice());
// Flush the telemetry queue the way a real tab-hide does.
const flush = (page) => page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});
const ls = (page, k) => page.evaluate((key) => localStorage.getItem(key), k);

async function openDoc(page, url = '/') {
  await page.goto(url);
  await page.setInputFiles('#file-input', FIXTURE);
  await expectFirstPage(page);
}
async function downloadOnce(page) {
  await page.click('#btn-download');
  const dl = page.waitForEvent('download');
  await page.click('#ds-cta');
  await dl;
  // the Unduh sheet closes itself after the file is handed over
  await expect(page.locator('#dl-sheet')).toBeHidden();
}

// The menu door: desktop nav link, or burger -> drawer link.
async function openFromMenu(page, door) {
  if (door === 'drawer') {
    await page.click('#ld-burger');
    await expect(page.locator('#ld-burger-menu')).toBeVisible();
    await page.click('#ld-burger-menu [data-feature-vote-open]');
  } else {
    await page.click('.ld-nav [data-feature-vote-open]');
  }
  await expect(page.locator('#fv-form')).toBeVisible();
}
const chip = (page, id) => page.locator(`#fv-form input[value="${id}"]`);
const pick = (page, id) => page.locator(`#fv-form label.fv-chip:has(input[value="${id}"])`).click();

export function defineFeatureVoteSuite({ door }) {
  test.describe(`feature vote (${door})`, () => {
    test('TRIGGER: not after the 1st download, yes after the 2nd (the count survives a new visit)', async ({ page }) => {
      await wire(page);
      await openDoc(page);
      await downloadOnce(page);
      expect(await ls(page, 'pdflokal_export_count')).toBe('1');
      await page.waitForTimeout(NOT_BY);
      await expect(page.locator('#fv-form')).toBeHidden();

      await openDoc(page); // a new visit: fresh page, same storage
      await downloadOnce(page);
      expect(await ls(page, 'pdflokal_export_count')).toBe('2');
      await expect(page.locator('#fv-form')).toBeVisible({ timeout: SHOWS_WITHIN });
      await expect(page.locator('#fv-form .fv-title')).toHaveText('Fitur apa yang paling kamu butuh?');
    });

    test('NEVER in the same session as the share card (share first, then a 2nd download)', async ({ page }) => {
      await wire(page);
      await openDoc(page);
      await downloadOnce(page); // 1st: the share/tip card takes the moment
      await expect(page.locator('#support-card')).toBeVisible({ timeout: 4000 });
      await page.click('#sc-close');
      await downloadOnce(page); // 2nd, SAME session: due by count, vetoed by the share card
      expect(await ls(page, 'pdflokal_export_count')).toBe('2');
      await page.waitForTimeout(NOT_BY);
      await expect(page.locator('#fv-form')).toBeHidden();
      expect(await ls(page, 'pdflokal_vote_done')).toBeNull();

      // Deferred, not lost: the next session's download is offered it.
      await openDoc(page);
      await downloadOnce(page);
      await expect(page.locator('#fv-form')).toBeVisible({ timeout: SHOWS_WITHIN });
    });

    test('when the vote takes the moment, the share card stands down for the whole session', async ({ page }) => {
      await wire(page, { pre: { pdflokal_export_count: '1' } });
      await openDoc(page);
      await downloadOnce(page);
      await expect(page.locator('#fv-form')).toBeVisible({ timeout: SHOWS_WITHIN });
      await expect(page.locator('#support-card')).toBeHidden();
      await page.keyboard.press('Escape');
      await downloadOnce(page);
      await page.waitForTimeout(2000);
      await expect(page.locator('#support-card')).toBeHidden();
    });

    test('a dismiss closes the auto door for good (but not the menu link)', async ({ page }) => {
      await wire(page, { pre: { pdflokal_export_count: '1' } });
      await openDoc(page);
      await downloadOnce(page);
      await expect(page.locator('#fv-form')).toBeVisible({ timeout: SHOWS_WITHIN });
      await page.keyboard.press('Escape');
      await expect(page.locator('#fv-form')).toBeHidden();
      expect(await ls(page, 'pdflokal_vote_done')).toBe('dismissed');

      await openDoc(page);
      await downloadOnce(page);
      await page.waitForTimeout(NOT_BY);
      await expect(page.locator('#fv-form')).toBeHidden();

      await page.goto('/');
      await openFromMenu(page, door); // the menu link is still there
    });

    test('MAX 3 is enforced in the UI: the fourth is disabled, a release frees it, the count says why', async ({ page }) => {
      await wire(page);
      await page.goto('/');
      await openFromMenu(page, door);
      await expect(page.locator('#fv-count')).toHaveText('0 dari 3 dipilih');
      await expect(page.locator('#fv-send')).toBeDisabled();
      await pick(page, 'pdf-word');
      await pick(page, 'watermark');
      await expect(page.locator('#fv-send')).toBeEnabled();
      await pick(page, 'crop');
      await expect(page.locator('#fv-count')).toHaveText('3 dari 3 dipilih');
      await expect(chip(page, 'lock')).toBeDisabled();
      await expect(chip(page, 'pdf-excel')).toBeDisabled();
      await expect(chip(page, 'crop')).toBeEnabled(); // a chosen one can always be un-chosen
      // vacuity guard: the 4th really is refused, not just styled
      await chip(page, 'lock').evaluate((el) => el.click()); // a script/assistive click on a disabled box
      await expect(chip(page, 'lock')).not.toBeChecked();
      await pick(page, 'crop');
      await expect(chip(page, 'lock')).toBeEnabled();
      await expect(page.locator('#fv-count')).toHaveText('2 dari 3 dipilih');
    });

    test('VOTE: sends feature_vote with ids only (no text), and the idea goes to feedback as feature_request', async ({ page }) => {
      const { feedback } = await wire(page);
      await page.goto('/');
      await openFromMenu(page, door);
      await pick(page, 'pdf-word');
      await pick(page, 'lock');
      await page.fill('#fv-idea', 'tolong ada OCR bahasa Jawa');
      await page.click('#fv-send');
      await expect(page.locator('#fv-form .fv-done')).toBeVisible();
      await flush(page);

      await expect.poll(async () => (await beacons(page)).filter((b) => b.url.endsWith('/api/t')).length).toBeGreaterThan(0);
      const events = (await beacons(page)).filter((b) => b.url.endsWith('/api/t')).flatMap((b) => b.json.events);
      const vote = events.find((e) => e.event === 'feature_vote');
      expect(vote?.props).toEqual({ features: ['pdf-word', 'lock'], has_text: true });
      // CONTENT-BLIND: the rail event carries ids and a bool, never the sentence.
      expect(JSON.stringify(events)).not.toContain('OCR');

      await expect.poll(async () => (await beacons(page)).filter((b) => b.url.endsWith('/api/feedback')).length).toBe(1);
      const fb = (await beacons(page)).find((b) => b.url.endsWith('/api/feedback')).json;
      expect(fb).toMatchObject({ kind: 'feature_request', features: ['pdf-word', 'lock'], note: 'tolong ada OCR bahasa Jawa', lang: 'id' });
      expect(fb.visitor_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(fb.rating).toBeUndefined();
      expect(feedback).toHaveLength(0); // it went by beacon, not by a second path
      expect(await ls(page, 'pdflokal_vote_done')).toBe('voted');
    });

    test('VOTE without text sends the rail event and NOTHING to feedback', async ({ page }) => {
      await wire(page);
      await page.goto('/');
      await openFromMenu(page, door);
      await pick(page, 'crop');
      await page.click('#fv-send');
      await expect(page.locator('#fv-form .fv-done')).toBeVisible();
      await flush(page);
      await expect.poll(async () => (await beacons(page)).filter((b) => b.url.endsWith('/api/t')).length).toBeGreaterThan(0);
      const vote = (await beacons(page)).flatMap((b) => b.json.events || []).find((e) => e.event === 'feature_vote');
      expect(vote.props).toEqual({ features: ['crop'], has_text: false });
      expect((await beacons(page)).filter((b) => b.url.endsWith('/api/feedback'))).toHaveLength(0);
    });

    test('TOP 3 renders after voting (most first), and the menu then opens on the result, not a fresh form', async ({ page }) => {
      await wire(page);
      await page.goto('/');
      await openFromMenu(page, door);
      await pick(page, 'crop');
      await page.click('#fv-send');
      await expect(page.locator('#fv-form .fv-done-head')).toHaveText('Makasih! Yang paling banyak diminta:');
      await expect(page.locator('#fv-form .fv-top li')).toHaveText(['PDF ke Word', 'Watermark', 'Potong halaman']);
      await page.keyboard.press('Escape');
      await expect(page.locator('#fv-form')).toBeHidden();

      await openFromMenu(page, door); // one browser, one ballot
      await expect(page.locator('#fv-form .fv-body')).toBeHidden();
      await expect(page.locator('#fv-form .fv-top li')).toHaveCount(3);
    });

    test('if /api/votes fails (or too few have voted) the card just says thanks', async ({ page }) => {
      for (const votes of ['fail', { voters: null, counts: null }]) {
        await wire(page, { votes });
        await page.goto('/');
        await page.evaluate(() => localStorage.removeItem('pdflokal_vote_done'));
        await openFromMenu(page, door);
        await pick(page, 'crop');
        await page.click('#fv-send');
        await expect(page.locator('#fv-form .fv-done-head')).toHaveText('Makasih!');
        await expect(page.locator('#fv-form .fv-top')).toBeHidden();
        await page.unroute('**/api/votes');
        await page.unroute('**/api/feedback');
      }
    });

    test('an idea alone is enough to send; an empty card is not', async ({ page }) => {
      await wire(page);
      await page.goto('/');
      await openFromMenu(page, door);
      await expect(page.locator('#fv-send')).toBeDisabled();
      await page.fill('#fv-idea', '   ');
      await expect(page.locator('#fv-send')).toBeDisabled();
      await page.fill('#fv-idea', 'format baru');
      await expect(page.locator('#fv-send')).toBeEnabled();
    });

    test('KEYBOARD and SCREEN READER: a named dialog, labelled groups, Space toggles, Esc closes', async ({ page }) => {
      await wire(page);
      await page.goto('/');
      await openFromMenu(page, door);
      const dlg = page.locator('#fv-form');
      await expect(dlg).toHaveAttribute('aria-labelledby', 'fv-title');
      await expect(page.getByRole('dialog', { name: 'Fitur apa yang paling kamu butuh?' })).toBeVisible();
      await expect(page.getByRole('group', { name: 'Konversi' })).toBeVisible();
      await expect(page.getByRole('group', { name: 'Alat' })).toBeVisible();
      await expect(dlg.getByRole('checkbox')).toHaveCount(14);
      await expect(page.getByLabel('Belum ada di sini? Tulis aja')).toBeVisible();
      await expect(page.locator('#fv-count')).toHaveAttribute('aria-live', 'polite');
      // keyboard only: focus the first chip, Space picks it
      await page.getByRole('checkbox', { name: 'PDF ke Word' }).focus();
      await page.keyboard.press('Space');
      await expect(chip(page, 'pdf-word')).toBeChecked();
      await expect(page.locator('#fv-count')).toHaveText('1 dari 3 dipilih');
      await page.keyboard.press('Escape');
      await expect(dlg).toBeHidden();
    });

    test('the sheet fits the screen: nothing spills sideways, and the Kirim row is reachable', async ({ page }) => {
      await wire(page);
      await page.goto('/');
      await openFromMenu(page, door);
      const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      expect(w.sw).toBeLessThanOrEqual(w.cw);
      const sheet = await page.locator('#fv-form .fv-sheet').boundingBox();
      const vp = page.viewportSize();
      expect(sheet.y).toBeGreaterThanOrEqual(0);
      expect(sheet.y + sheet.height).toBeLessThanOrEqual(vp.height);
      await expect(page.locator('#fv-send')).toBeInViewport();
      await expect(page.locator('#fv-form .fv-x')).toBeInViewport();
    });

    test('/en is the English card, end to end', async ({ page }) => {
      await wire(page);
      await page.goto('/en');
      await openFromMenu(page, door);
      await expect(page.locator('#fv-form .fv-title')).toHaveText('Which feature do you need most?');
      await expect(page.locator('#fv-form .fv-hint')).toHaveText('Pick up to 3');
      await expect(page.locator('#fv-form legend')).toHaveText(['Convert', 'Tools']);
      await expect(page.locator('#fv-form label.fv-chip')).toHaveText([
        'PDF to Word', 'PDF to Excel', 'PDF to PowerPoint', 'Word to PDF',
        'Fill PDF forms', 'Scan with phone camera', 'Put images on a page', 'Permanent redaction', 'Watermark',
        'Page numbers', 'Lock PDF with a password', 'Many files at once', 'Crop pages', 'Black and white',
      ]);
      await expect(page.getByLabel('Not listed? Write it')).toBeVisible();
      await expect(page.locator('#fv-send')).toHaveText('Send');
      await expect(page.locator('#fv-count')).toHaveText('0 of 3 picked');
      await pick(page, 'crop');
      await expect(page.locator('#fv-count')).toHaveText('1 of 3 picked');
      await page.click('#fv-send');
      await expect(page.locator('#fv-form .fv-done-head')).toHaveText('Thanks! Most requested so far:');
      await expect(page.locator('#fv-form .fv-top li')).toHaveText(['PDF to Word', 'Watermark', 'Crop pages']);
      // the stored id is the same one /: labels differ, data does not
      const vote = await (async () => { await flush(page); await expect.poll(async () => (await beacons(page)).length).toBeGreaterThan(0); return (await beacons(page)).flatMap((b) => b.json.events || []).find((e) => e.event === 'feature_vote'); })();
      expect(vote.props.features).toEqual(['crop']);
    });

    test('SCREENSHOTS (only when SHOTS is set): open, after the vote, /en', async ({ page }) => {
      test.skip(!process.env.SHOTS, 'screenshots are taken on demand');
      const dir = process.env.SHOTS;
      const tag = door === 'drawer' ? '390x844' : '1280x800';
      await page.setViewportSize(door === 'drawer' ? { width: 390, height: 844 } : { width: 1280, height: 800 });
      await wire(page);
      await page.goto('/');
      await openFromMenu(page, door);
      await pick(page, 'pdf-word');
      await pick(page, 'watermark');
      await page.fill('#fv-idea', 'Gabung PDF langsung dari galeri HP');
      await page.screenshot({ path: `${dir}/vote-open-${tag}.png` });
      await page.click('#fv-send');
      await expect(page.locator('#fv-form .fv-top li')).toHaveCount(3);
      await page.screenshot({ path: `${dir}/vote-after-${tag}.png` });
      await page.keyboard.press('Escape');
      await page.evaluate(() => localStorage.removeItem('pdflokal_vote_done'));
      await page.goto('/en');
      await openFromMenu(page, door);
      await pick(page, 'pdf-word');
      await pick(page, 'crop');
      await page.screenshot({ path: `${dir}/vote-en-${tag}.png` });
    });
  });
}
