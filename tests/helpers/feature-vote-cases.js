/*
 * THE FEATURE VOTE v2, in a real browser (js/v2/feature-vote.js; founder rulings
 * 2026-10-02 and 2026-10-06). One suite, registered by BOTH tests/feature-vote.spec.js
 * (desktop, chromium) and tests/mobile/feature-vote.spec.js (mobile-chrome), so the
 * same claims are made on both and neither can drift. `door` says how this project
 * reaches the menu link: the desktop nav, or the mobile burger drawer.
 *
 * NO NETWORK: /api/votes and /api/feedback are routed, and navigator.sendBeacon is
 * replaced in the page (the way tests/telemetry.spec.js does it) so the rail event is
 * read as the client built it. A test run never posts to a live table. The route
 * obeys the SERVER's rule (a second ballot is 409) so the client's handling of it is
 * what is under test; the rule itself is proven on a real SQLite in
 * tests/core/feature-vote.test.mjs.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'sample-2pages.pdf');

// The card opens THE MOMENT a whole-document download completes (his ruling
// 2026-10-06): positive assertions allow only a beat for the Unduh sheet to close
// first; negative ones wait past the share card's own 200ms and the old 4.4s stamp
// delay before they count, so a regression to the old timing cannot hide.
const SHOWS_WITHIN = 1_500;
const NOT_BY = 5_000;

const TOP = { voters: 40, counts: { 'pdf-word': 22, watermark: 14, 'save-edits': 9, 'lock-unlock': 4 } };
const IDS = ['pdf-word', 'pdf-excel', 'save-edits', 'lock-unlock', 'form-fill', 'camera-scan', 'canvas-image', 'watermark'];
const dayOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// `ballot`: how the server answers a POST: 'ok' | 'already' | 'fail' | an array consumed in order.
async function wire(page, { votes = TOP, pre = {}, ballot = 'ok' } = {}) {
  const feedback = [];
  const ballots = [];
  const answers = Array.isArray(ballot) ? [...ballot] : null;
  await page.route('**/api/feedback', async (route) => {
    feedback.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({ status: 204, body: '' });
  });
  await page.route('**/api/votes', async (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      ballots.push(JSON.parse(req.postData() || '{}'));
      const mode = answers ? (answers.shift() ?? 'ok') : ballot;
      const status = { ok: 200, already: 409, fail: 503 }[mode];
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ ok: mode === 'ok' }) });
      return;
    }
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
  return { feedback, ballots };
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
const step = (page, name) => page.locator(`#fv-form [data-fv-step="${name}"]`);
const box = (page, id) => page.locator(`#fv-form input[value="${id}"]`);
const pick = (page, id) => page.locator(`#fv-form label.fv-opt:has(input[value="${id}"])`).click();
const toStep2 = async (page) => { await page.click('#fv-form .fv-start'); await expect(step(page, 'choose')).toBeVisible(); };

export function defineFeatureVoteSuite({ door }) {
  test.describe(`feature vote v2 (${door})`, () => {
    test('FLOW: invitation (his words, photo below, hat on it) -> choices (no photo) -> tick 3, a 4th is refused -> send -> thanks, top 3, coffee', async ({ page }) => {
      const { ballots } = await wire(page);
      await page.goto('/');
      await openFromMenu(page, door);

      // step 1: his words, verbatim; his photo BELOW them, with the top hat; two buttons
      await expect(step(page, 'invite')).toBeVisible();
      await expect(step(page, 'choose')).toBeHidden();
      await expect(page.locator('#fv-invite-title')).toHaveText('Voting Fitur PDFLokal');
      await expect(page.locator('#fv-invite-text')).toHaveText('Halo guyss. Mau bikin fitur baru tp bingung apaan. Bantu voting doong. terimakasii');
      expect(await page.locator('#fv-invite-title').evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThan(15.5); // styled as the dialog's heading
      const text = await page.locator('.fv-invite-text').boundingBox();
      const face = await page.locator('#fv-form .fv-face').boundingBox();
      const hat = await page.locator('#fv-form .fv-topi').boundingBox();
      expect(face.y).toBeGreaterThan(text.y + text.height - 1);
      expect(hat.y).toBeLessThan(face.y + face.height / 2); // the hat sits on the head, the maker card's way
      await expect(page.locator('#fv-form .fv-face')).toHaveAttribute('src', '/images/ojan.jpg');
      await expect(page.locator('#fv-form .fv-topi')).toHaveAttribute('src', '/images/topi.svg');
      await expect(page.locator('#fv-form .fv-start')).toHaveText('Pilih fitur');
      await expect(step(page, 'invite').locator('[data-fv-later]')).toHaveText('Nanti aja');
      expect(await page.locator('#fv-form .fv-face').evaluate((el) => el.complete && el.naturalWidth > 0), 'the photo really loaded').toBe(true);

      // step 2: no photo, a heading, "Pilih maksimal 3" prominent, 8 rows, a real checkbox each
      await toStep2(page);
      await expect(step(page, 'invite')).toBeHidden();
      await expect(page.locator('#fv-form .fv-face')).toBeHidden();
      await expect(page.locator('#fv-title')).toHaveText('Fitur apa yang kamu butuh?');
      await expect(page.locator('#fv-form .fv-hint')).toHaveText('Pilih maksimal 3');
      const [title, hint] = await Promise.all([
        page.locator('#fv-title').evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
        page.locator('#fv-form .fv-hint').evaluate((el) => ({ size: parseFloat(getComputedStyle(el).fontSize), weight: Number(getComputedStyle(el).fontWeight) })),
      ]);
      expect(title).toBeGreaterThan(15.5); // larger than v1's
      expect(hint.weight).toBeGreaterThanOrEqual(600); // prominent, not a grey subtitle
      expect(hint.size).toBeGreaterThanOrEqual(16);
      await expect(page.locator('#fv-form .fv-opt')).toHaveText([
        'PDF ke Word', 'PDF ke Excel', 'Simpan editan buat dilanjut nanti', 'Kunci dan buka PDF yang pakai password',
        'Isi formulir PDF', 'Scan dokumen pakai kamera HP', 'Tempel gambar atau logo', 'Tambah watermark',
      ]);
      await expect(step(page, 'choose').getByRole('checkbox')).toHaveCount(8);
      await expect(page.locator('#fv-count')).toHaveText('0 dari 3 dipilih');
      await expect(page.locator('#fv-send')).toHaveText('Kirim pilihan');
      await expect(page.locator('#fv-send')).toBeDisabled();
      await expect(page.locator('label[for="fv-idea"]')).toHaveText('Belum ada di sini? Tulis aja');

      await pick(page, 'pdf-word');
      await expect(page.locator('#fv-send')).toBeEnabled();
      await pick(page, 'save-edits');
      await pick(page, 'watermark');
      await expect(page.locator('#fv-count')).toHaveText('3 dari 3 dipilih');
      for (const id of IDS.filter((i) => !['pdf-word', 'save-edits', 'watermark'].includes(i))) await expect(box(page, id)).toBeDisabled();
      await expect(box(page, 'watermark')).toBeEnabled(); // a chosen one can always be un-chosen
      // vacuity guard: the 4th really is refused, not just styled
      await box(page, 'form-fill').evaluate((el) => el.click()); // a script/assistive click on a disabled box
      await expect(box(page, 'form-fill')).not.toBeChecked();
      expect(await page.locator('#fv-form input:checked').count()).toBe(3);

      await page.click('#fv-send');
      expect(ballots).toHaveLength(1);
      expect(ballots[0]).toMatchObject({ features: ['pdf-word', 'save-edits', 'watermark'], has_text: false, lang: 'id' });
      expect(ballots[0].visitor_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

      // step 3: his one line, the top 3 (names only, no counts), the coffee ask, Tutup
      await expect(step(page, 'done')).toBeVisible();
      await expect(page.locator('#fv-done-head')).toHaveText('Makasi votingnyaa. Kalo udah jadi nnti dikabarin di sini yaa');
      await expect(page.locator('#fv-form .fv-top-label')).toHaveText('Paling banyak dipilih:');
      await expect(page.locator('#fv-form .fv-top li')).toHaveText(['PDF ke Word', 'Tambah watermark', 'Simpan editan buat dilanjut nanti']);
      expect(await page.locator('#fv-form .fv-top').innerText()).not.toMatch(/\d/); // names only
      await expect(page.locator('#fv-form .fv-coffee .sc-sub')).toHaveText('PDFLokal gratis dan bakal terus gratis. Kalo kepakai, bantuin dikit yaa:');
      await expect(page.locator('#fv-form .fv-coffee .sc-qr')).toBeHidden();
      await page.locator('#fv-form .fv-coffee button').click(); // "Traktir kopi"
      await expect(page.locator('#fv-form .fv-coffee .sc-qr img[alt="QRIS untuk traktir kopi"]')).toBeVisible();
      await expect(step(page, 'done').locator('[data-fv-close]')).toHaveText('Tutup');
      expect(await ls(page, 'pdflokal_vote_done')).toBe('voted');
      expect(JSON.parse(await ls(page, 'pdflokal_vote_ids'))).toEqual(['pdf-word', 'save-edits', 'watermark']);
      await step(page, 'done').locator('[data-fv-close]').click();
      await expect(page.locator('#fv-form')).toBeHidden();
    });

    test('CENTRED, never the bottom-right corner (that is the maker card\'s)', async ({ page }) => {
      await wire(page);
      await page.goto('/');
      await openFromMenu(page, door);
      const vp = page.viewportSize();
      for (const which of ['invite', 'choose']) {
        if (which === 'choose') await toStep2(page);
        const b = await page.locator('#fv-form .sheet').boundingBox();
        expect(Math.abs((b.x + b.width / 2) - vp.width / 2)).toBeLessThan(2);
        expect(Math.abs((b.y + b.height / 2) - vp.height / 2)).toBeLessThan(vp.height * 0.2);
        expect(b.y + b.height).toBeLessThan(vp.height - 8); // not a bottom sheet
      }
    });

    test('ROWS: the whole row is the tap target (>= 44px), a tap on the words ticks it', async ({ page }) => {
      await wire(page);
      await page.goto('/');
      await openFromMenu(page, door);
      await toStep2(page);
      for (const row of await page.locator('#fv-form .fv-opt').all()) {
        expect((await row.boundingBox()).height).toBeGreaterThanOrEqual(44);
      }
      await page.getByText('Isi formulir PDF', { exact: true }).click();
      await expect(box(page, 'form-fill')).toBeChecked();
      await expect(page.locator('#fv-count')).toHaveText('1 dari 3 dipilih');
    });

    test('TRIGGER: the very first whole-document download offers it; "Nanti aja" quiets it for the rest of the day, and it is back tomorrow', async ({ page }) => {
      const { ballots } = await wire(page);
      await openDoc(page);
      await downloadOnce(page);
      await expect(page.locator('#fv-form')).toBeVisible({ timeout: SHOWS_WITHIN });
      await expect(step(page, 'invite')).toBeVisible();
      await step(page, 'invite').locator('[data-fv-later]').click();
      await expect(page.locator('#fv-form')).toBeHidden();
      expect(await ls(page, 'pdflokal_vote_nanti')).toBe(dayOf(new Date()));
      expect(await ls(page, 'pdflokal_vote_done')).toBeNull();

      // the same day: another download, another visit: not offered
      await openDoc(page);
      await downloadOnce(page);
      await page.waitForTimeout(NOT_BY);
      await expect(page.locator('#fv-form')).toBeHidden();

      // tomorrow (the stored day is yesterday): offered again
      await page.evaluate((d) => localStorage.setItem('pdflokal_vote_nanti', d), dayOf(new Date(Date.now() - 86_400_000)));
      await openDoc(page);
      await downloadOnce(page);
      await expect(page.locator('#fv-form')).toBeVisible({ timeout: SHOWS_WITHIN });
      expect(ballots).toHaveLength(0);
    });

    test('TRIGGER: closing it any other way from the download moment (Escape) is the same answer as "Nanti aja"', async ({ page }) => {
      await wire(page);
      await openDoc(page);
      await downloadOnce(page);
      await expect(page.locator('#fv-form')).toBeVisible({ timeout: SHOWS_WITHIN });
      await page.keyboard.press('Escape');
      await expect(page.locator('#fv-form')).toBeHidden();
      // the dialog's `close` event is queued after it hides: poll, do not read once
      await expect.poll(() => ls(page, 'pdflokal_vote_nanti')).toBe(dayOf(new Date()));
      await downloadOnce(page);
      await page.waitForTimeout(NOT_BY);
      await expect(page.locator('#fv-form')).toBeHidden();
      await page.goto('/');
      await openFromMenu(page, door); // the menu link is still there, and opens straight on step 1
      await expect(step(page, 'invite')).toBeVisible();
    });

    test('TRIGGER: never again after voting; the menu link then opens the after-vote state, not the form', async ({ page }) => {
      await wire(page, { pre: { pdflokal_vote_done: 'voted', pdflokal_vote_ids: '["pdf-word"]' } });
      await openDoc(page);
      await downloadOnce(page);
      await page.waitForTimeout(NOT_BY);
      await expect(page.locator('#fv-form')).toBeHidden();
      await page.goto('/');
      await openFromMenu(page, door);
      await expect(step(page, 'done')).toBeVisible();
      await expect(step(page, 'invite')).toBeHidden();
      await expect(step(page, 'choose')).toBeHidden();
      await expect(page.locator('#fv-form .fv-top li')).toHaveCount(3);
    });

    test('TIMING: the dialog is open within ~1s of the download event, and the share/coffee card is ABSENT for that download', async ({ page }) => {
      await wire(page);
      await openDoc(page);
      // The dialog opens the moment the download is handed over, not seconds later.
      // t0 is the app's own anchor click that triggers the file (the "download event"),
      // so the export build's time is not counted against the dialog.
      await page.evaluate(() => {
        window.__t = { dl: null, open: null };
        const click = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function (...a) { if (this.download) window.__t.dl = performance.now(); return click.apply(this, a); };
        const dlg = document.getElementById('fv-form');
        new MutationObserver((_, o) => { if (dlg.open) { o.disconnect(); window.__t.open = performance.now(); } })
          .observe(dlg, { attributes: true, attributeFilter: ['open'] });
      });
      await page.click('#btn-download');
      const dl = page.waitForEvent('download');
      await page.click('#ds-cta');
      await dl;
      await expect.poll(() => page.evaluate(() => window.__t.open), { timeout: 3000 }).not.toBeNull();
      const t = await page.evaluate(() => window.__t);
      expect(t.dl, 'the download anchor was never clicked').not.toBeNull();
      expect(t.open - t.dl).toBeLessThan(1000);
      expect(t.open - t.dl).toBeGreaterThanOrEqual(0);
      await expect(page.locator('#fv-form')).toBeVisible({ timeout: SHOWS_WITHIN });
      // and nothing else for this download: the share/coffee card is replaced outright
      await page.waitForTimeout(NOT_BY);
      await expect(page.locator('#fv-form')).toBeVisible();
      await expect(page.locator('#support-card')).toBeHidden();
      expect(await page.evaluate(() => localStorage.getItem('pdflokal-support-last'))).toBeNull(); // its daily cap was not spent
    });

    test('NO OTHER CARD pops over it: the bug-report card, the maker card and the install card wait', async ({ page }) => {
      await wire(page);
      await openDoc(page);
      await downloadOnce(page);
      await expect(page.locator('#fv-form')).toBeVisible({ timeout: SHOWS_WITHIN });
      for (const sel of ['#support-card', '#maker-card', '#install-card', '#bug-prompt.show']) {
        await expect(page.locator(sel)).toBeHidden();
      }
      await page.waitForTimeout(3000); // the bug-report card's own settle window
      await expect(page.locator('#bug-prompt.show')).toHaveCount(0);
      await expect(page.locator('#fv-form')).toBeVisible();
    });

    test('WHEN THE VOTE IS NOT OFFERED the share/coffee card behaves exactly as before (said "Nanti aja" today)', async ({ page }) => {
      await wire(page, { pre: { pdflokal_vote_nanti: dayOf(new Date()) } });
      await openDoc(page);
      await downloadOnce(page);
      await expect(page.locator('#support-card')).toBeVisible({ timeout: 4000 });
      await expect(page.locator('#fv-form')).toBeHidden();
    });

    test('WHEN THE VOTE IS NOT OFFERED: already voted, or a partial (Ekstrak/picked) download, the share card runs as before', async ({ page }) => {
      await wire(page, { pre: { pdflokal_vote_done: 'voted', pdflokal_vote_ids: '["pdf-word"]' } });
      await openDoc(page);
      await downloadOnce(page);
      await expect(page.locator('#support-card')).toBeVisible({ timeout: 4000 });
      await expect(page.locator('#fv-form')).toBeHidden();
    });

    test('A CLOSE FROM THE DOWNLOAD MOMENT counts as "Nanti aja"; the next download in the same session then gets the share card, as before', async ({ page }) => {
      await wire(page);
      await openDoc(page);
      await downloadOnce(page);
      await expect(page.locator('#fv-form')).toBeVisible({ timeout: SHOWS_WITHIN });
      await expect(page.locator('#support-card')).toBeHidden();
      await page.keyboard.press('Escape');
      await expect(page.locator('#fv-form')).toBeHidden();
      await downloadOnce(page);
      await expect(page.locator('#support-card')).toBeVisible({ timeout: 4000 });
      await expect(page.locator('#fv-form')).toBeHidden();
    });

    test('NEVER beside the share card: when it spoke first in the session, the vote waits for a later visit', async ({ page }) => {
      await wire(page, { pre: { pdflokal_vote_nanti: dayOf(new Date()) } });
      // the vote is quiet today, so the first download goes to the share card
      await openDoc(page);
      await downloadOnce(page);
      await expect(page.locator('#support-card')).toBeVisible({ timeout: 4000 });
      // now it is "due" again (set, not removed: the seed above would put today back on a reload)
      await page.evaluate((d) => localStorage.setItem('pdflokal_vote_nanti', d), dayOf(new Date(Date.now() - 86_400_000)));
      await downloadOnce(page);                                                  // same session: the share card already spoke
      await page.waitForTimeout(NOT_BY);
      await expect(page.locator('#fv-form')).toBeHidden();
      // deferred, not lost: the next session's download is offered it
      await openDoc(page);
      await downloadOnce(page);
      await expect(page.locator('#fv-form')).toBeVisible({ timeout: SHOWS_WITHIN });
    });

    test('THE MAKER CARD WAITS while the vote is open, and comes up when it closes; a shipped feature is told once', async ({ page }) => {
      await wire(page);
      await page.goto('/');
      await expect(page.locator('#maker-card')).toBeVisible({ timeout: 4000 }); // vacuity guard: it does show on this page
      await page.evaluate(() => { document.getElementById('maker-card').hidden = true; });
      // a second init, the way a fresh load would run it, with the dialog open at its moment
      await openFromMenu(page, door);
      const shown = await page.evaluate(async () => {
        const m = await import('/js/v2/maker-card.js');
        const f = await import('/js/core/features.js');
        const mem = await import('/js/v2/vote-memory.js');
        localStorage.setItem('pdflokal_vote_ids', JSON.stringify(['pdf-word', 'watermark']));
        localStorage.removeItem('pdflokal_vote_told');
        localStorage.removeItem('pdflokal_maker_seen');
        const notices = f.untoldShipped(mem.votedIds(), mem.toldIds(), ['pdf-word']); // pretend PDF ke Word shipped
        m.initMakerCard({ delay: 50, notices });
        await new Promise((r) => setTimeout(r, 400));
        return { whileOpen: !document.getElementById('maker-card').hidden, told: localStorage.getItem('pdflokal_vote_told') };
      });
      expect(shown.whileOpen).toBe(false);
      expect(shown.told).toBeNull(); // not told yet: it has not been shown
      await page.keyboard.press('Escape');
      await expect(page.locator('#maker-card')).toBeVisible({ timeout: 3000 });
      await expect(page.locator('#maker-card .mk-notice')).toHaveText('PDF ke Word udah jadi nih. Kamu salah satu yang milih ini, makasii');
      expect(await ls(page, 'pdflokal_vote_told')).toBe('["pdf-word"]');
      // once: the next load computes no notice for it
      const again = await page.evaluate(async () => {
        const f = await import('/js/core/features.js');
        const mem = await import('/js/v2/vote-memory.js');
        return f.untoldShipped(mem.votedIds(), mem.toldIds(), ['pdf-word']);
      });
      expect(again).toEqual([]);
    });

    test('BALLOT: a refused send stays on step 2 with the ticks, says so, and remembers nothing; the retry then lands', async ({ page }) => {
      const { ballots } = await wire(page, { ballot: ['fail', 'ok'] });
      await page.goto('/');
      await openFromMenu(page, door);
      await toStep2(page);
      await pick(page, 'pdf-excel');
      await page.click('#fv-send');
      await expect(page.locator('#fv-error')).toHaveText('Pilihanmu belum terkirim. Coba lagi ya.');
      await expect(step(page, 'choose')).toBeVisible();
      await expect(box(page, 'pdf-excel')).toBeChecked();
      expect(await ls(page, 'pdflokal_vote_done')).toBeNull();
      await expect(page.locator('#fv-send')).toBeEnabled();
      await page.click('#fv-send');
      await expect(step(page, 'done')).toBeVisible();
      expect(ballots).toHaveLength(2);
      expect(await ls(page, 'pdflokal_vote_done')).toBe('voted');
    });

    test('BALLOT: the server says this visitor already voted (cleared storage): the card shows the after-vote state and claims no ids', async ({ page }) => {
      await wire(page, { ballot: 'already' });
      await page.goto('/');
      await openFromMenu(page, door);
      await toStep2(page);
      await pick(page, 'pdf-excel');
      await page.click('#fv-send');
      await expect(step(page, 'done')).toBeVisible();
      expect(await ls(page, 'pdflokal_vote_done')).toBe('voted');
      expect(await ls(page, 'pdflokal_vote_ids')).toBe('[]'); // we do not know what they picked before
    });

    test('NO visitor_id (private mode): the auto door stays shut; the menu still opens it, a send files only the idea, sends no ballot and remembers no vote', async ({ page }) => {
      const { ballots } = await wire(page);
      // storage that "accepts" the write but never keeps the visitor id: exactly what readVisitorId() treats as no id
      await page.addInitScript(() => {
        const set = Storage.prototype.setItem;
        Storage.prototype.setItem = function (k, v) { if (k === 'pdflokal_visitor_id') return; return set.call(this, k, v); };
      });
      await openDoc(page);
      await downloadOnce(page);
      await page.waitForTimeout(NOT_BY);
      await expect(page.locator('#fv-form')).toBeHidden(); // vacuity guard below: the same flow with a visitor id DOES show it (TRIGGER test)
      expect(await ls(page, 'pdflokal_visitor_id')).toBeNull();

      await page.goto('/');
      await openFromMenu(page, door);
      await expect(step(page, 'invite')).toBeVisible();
      await toStep2(page);
      await pick(page, 'pdf-word');
      await page.fill('#fv-idea', 'format baru dong');
      await page.click('#fv-send');
      await expect(step(page, 'done')).toBeVisible();
      expect(ballots).toHaveLength(0);                       // no ballot without a visitor
      expect(await ls(page, 'pdflokal_vote_done')).toBeNull(); // not remembered as voted
      expect(await ls(page, 'pdflokal_vote_ids')).toBeNull();
      await expect.poll(async () => (await beacons(page)).filter((b) => b.url.endsWith('/api/feedback')).length).toBe(1);
      const fb = (await beacons(page)).find((b) => b.url.endsWith('/api/feedback')).json;
      expect(fb).toMatchObject({ kind: 'feature_request', note: 'format baru dong', visitor_id: null });
      await flush(page);
      const events = (await beacons(page)).filter((b) => b.url.endsWith('/api/t')).flatMap((b) => b.json.events || []);
      expect(events.find((e) => e.event === 'feature_vote')).toBeUndefined(); // no vote event for a vote that did not count
    });

    test('NO visitor_id: ticks without an idea send nothing at all', async ({ page }) => {
      const { ballots, feedback } = await wire(page);
      await page.addInitScript(() => {
        const set = Storage.prototype.setItem;
        Storage.prototype.setItem = function (k, v) { if (k === 'pdflokal_visitor_id') return; return set.call(this, k, v); };
      });
      await page.goto('/');
      await openFromMenu(page, door);
      await toStep2(page);
      await pick(page, 'pdf-excel');
      await page.click('#fv-send');
      await expect(step(page, 'done')).toBeVisible();
      await page.waitForTimeout(500);
      expect(ballots).toHaveLength(0);
      expect(feedback).toHaveLength(0);
      expect((await beacons(page)).filter((b) => b.url.endsWith('/api/feedback'))).toHaveLength(0);
      expect(await ls(page, 'pdflokal_vote_done')).toBeNull();
    });

    test('VOTE: the rail event carries ids only; the idea goes to feedback as feature_request, tag-free, and an idea alone is enough', async ({ page }) => {
      const { ballots } = await wire(page);
      await page.goto('/');
      await openFromMenu(page, door);
      await toStep2(page);
      await pick(page, 'pdf-word');
      await pick(page, 'lock-unlock');
      await page.fill('#fv-idea', 'tolong ada OCR bahasa Jawa');
      await page.click('#fv-send');
      await expect(step(page, 'done')).toBeVisible();
      await flush(page);
      expect(ballots[0]).toMatchObject({ features: ['pdf-word', 'lock-unlock'], has_text: true });
      expect(JSON.stringify(ballots)).not.toContain('OCR'); // the ballot has no text, ever

      await expect.poll(async () => (await beacons(page)).filter((b) => b.url.endsWith('/api/t')).length).toBeGreaterThan(0);
      const events = (await beacons(page)).filter((b) => b.url.endsWith('/api/t')).flatMap((b) => b.json.events);
      expect(events.find((e) => e.event === 'feature_vote')?.props).toEqual({ features: ['pdf-word', 'lock-unlock'], has_text: true });
      expect(JSON.stringify(events)).not.toContain('OCR'); // CONTENT-BLIND: ids and a bool, never the sentence
      await expect.poll(async () => (await beacons(page)).filter((b) => b.url.endsWith('/api/feedback')).length).toBe(1);
      const fb = (await beacons(page)).find((b) => b.url.endsWith('/api/feedback')).json;
      expect(fb).toMatchObject({ kind: 'feature_request', features: ['pdf-word', 'lock-unlock'], note: 'tolong ada OCR bahasa Jawa', lang: 'id' });
      expect(fb.rating).toBeUndefined();
    });

    test('an idea alone is enough to send; markup in it is stripped; an empty card is not sendable', async ({ page }) => {
      const { ballots } = await wire(page);
      await page.goto('/');
      await openFromMenu(page, door);
      await toStep2(page);
      await expect(page.locator('#fv-send')).toBeDisabled();
      await page.fill('#fv-idea', '   ');
      await expect(page.locator('#fv-send')).toBeDisabled();
      await page.fill('#fv-idea', '<b></b>');
      await expect(page.locator('#fv-send')).toBeDisabled(); // nothing is left of it
      await page.fill('#fv-idea', 'format <i>baru</i>');
      await expect(page.locator('#fv-send')).toBeEnabled();
      await page.click('#fv-send');
      await expect(step(page, 'done')).toBeVisible();
      expect(ballots[0]).toMatchObject({ features: [], has_text: true });
      await expect.poll(async () => (await beacons(page)).filter((b) => b.url.endsWith('/api/feedback')).length).toBe(1);
      expect((await beacons(page)).find((b) => b.url.endsWith('/api/feedback')).json.note).toBe('format baru');
    });

    test('if /api/votes fails (or too few have voted) the card still says his line, with no ranking', async ({ page }) => {
      for (const votes of ['fail', { voters: null, counts: null }]) {
        await wire(page, { votes });
        await page.goto('/');
        await page.evaluate(() => { for (const k of ['pdflokal_vote_done', 'pdflokal_vote_ids']) localStorage.removeItem(k); });
        await openFromMenu(page, door);
        await toStep2(page);
        await pick(page, 'pdf-excel');
        await page.click('#fv-send');
        await expect(page.locator('#fv-done-head')).toHaveText('Makasi votingnyaa. Kalo udah jadi nnti dikabarin di sini yaa');
        await expect(page.locator('#fv-form .fv-top-wrap')).toBeHidden();
        await page.unroute('**/api/votes');
        await page.unroute('**/api/feedback');
      }
    });

    test('KEYBOARD and SCREEN READER: a named dialog on every step, real checkboxes, Space toggles, Esc closes', async ({ page }) => {
      await wire(page);
      await page.goto('/');
      await openFromMenu(page, door);
      const dlg = page.locator('#fv-form');
      await expect(page.getByRole('dialog', { name: 'Voting Fitur PDFLokal' })).toBeVisible();
      await toStep2(page);
      await expect(page.getByRole('dialog', { name: 'Fitur apa yang kamu butuh?' })).toBeVisible();
      await expect(dlg.getByRole('checkbox')).toHaveCount(8);
      await expect(page.getByLabel('Belum ada di sini? Tulis aja')).toBeVisible();
      await expect(page.locator('#fv-count')).toHaveAttribute('aria-live', 'polite');
      await page.getByRole('checkbox', { name: 'PDF ke Word' }).focus();
      await page.keyboard.press('Space');
      await expect(box(page, 'pdf-word')).toBeChecked();
      await expect(page.locator('#fv-count')).toHaveText('1 dari 3 dipilih');
      await page.keyboard.press('Escape');
      await expect(dlg).toBeHidden();
    });

    test('the dialog fits the screen on every step: nothing spills sideways, and its buttons are reachable', async ({ page }) => {
      await wire(page);
      await page.goto('/');
      await openFromMenu(page, door);
      const fits = async () => {
        const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
        expect(w.sw).toBeLessThanOrEqual(w.cw);
        const sheet = await page.locator('#fv-form .sheet').boundingBox();
        const vp = page.viewportSize();
        expect(sheet.y).toBeGreaterThanOrEqual(0);
        expect(sheet.y + sheet.height).toBeLessThanOrEqual(vp.height);
      };
      await fits();
      await expect(page.locator('#fv-form .fv-start')).toBeInViewport();
      await expect(step(page, 'invite').locator('[data-fv-later]')).toBeInViewport();
      await toStep2(page);
      await fits();
      await expect(page.locator('#fv-send')).toBeInViewport();
      await expect(page.locator('#fv-form .fv-x')).toBeInViewport();
    });

    test('/en is the English card, end to end', async ({ page }) => {
      await wire(page);
      await page.goto('/en');
      await openFromMenu(page, door);
      await expect(page.locator('#fv-invite-title')).toHaveText('Feature vote');
      await expect(page.locator('#fv-invite-text')).toHaveText("Hey guys. I want to build a new feature but I can't decide what. Help me vote pleaseee. thankss");
      await expect(page.locator('#fv-form .fv-start')).toHaveText('Pick features');
      await expect(step(page, 'invite').locator('[data-fv-later]')).toHaveText('Maybe later');
      await toStep2(page);
      await expect(page.locator('#fv-title')).toHaveText('Which features do you need?');
      await expect(page.locator('#fv-form .fv-hint')).toHaveText('Pick up to 3');
      await expect(page.locator('#fv-form .fv-opt')).toHaveText([
        'PDF to Word', 'PDF to Excel', 'Save your edits to continue later', 'Lock and unlock password-protected PDFs',
        'Fill in PDF forms', 'Scan documents with your phone camera', 'Add an image or logo', 'Add a watermark',
      ]);
      await expect(page.getByLabel('Not here yet? Just write it')).toBeVisible();
      await expect(page.locator('#fv-send')).toHaveText('Send my picks');
      await expect(page.locator('#fv-count')).toHaveText('0 of 3 picked');
      await pick(page, 'watermark');
      await expect(page.locator('#fv-count')).toHaveText('1 of 3 picked');
      await page.click('#fv-send');
      await expect(page.locator('#fv-done-head')).toHaveText("Thanks for votingg. When it's done I'll tell you here ok");
      await expect(page.locator('#fv-form .fv-top li')).toHaveText(['PDF to Word', 'Add a watermark', 'Save your edits to continue later']);
      await expect(page.locator('#fv-form .fv-coffee .sc-sub')).toHaveText("PDFLokal is free and will stay free. If it's useful to you, help me out a little:");
      // the stored id is the same one /: labels differ, data does not
      await flush(page);
      await expect.poll(async () => (await beacons(page)).length).toBeGreaterThan(0);
      const vote = (await beacons(page)).flatMap((b) => b.json.events || []).find((e) => e.event === 'feature_vote');
      expect(vote.props.features).toEqual(['watermark']);
    });

    test('SCREENSHOTS (only when SHOTS is set): step 1, step 2 with 3 ticked, after the vote', async ({ page }) => {
      test.skip(!process.env.SHOTS, 'screenshots are taken on demand');
      const dir = process.env.SHOTS;
      const tag = door === 'drawer' ? '390x844' : '1280x800';
      await page.setViewportSize(door === 'drawer' ? { width: 390, height: 844 } : { width: 1280, height: 800 });
      await wire(page);
      await page.goto('/');
      await openFromMenu(page, door);
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${dir}/vote2-step1-${tag}.png` });
      await toStep2(page);
      await pick(page, 'pdf-word');
      await pick(page, 'save-edits');
      await pick(page, 'watermark');
      await page.screenshot({ path: `${dir}/vote2-step2-${tag}.png` });
      await page.click('#fv-send');
      await expect(page.locator('#fv-form .fv-top li')).toHaveCount(3);
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${dir}/vote2-after-${tag}.png` });
      await page.locator('#fv-form .fv-coffee button').click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${dir}/vote2-after-coffee-${tag}.png` });
    });
  });
}
