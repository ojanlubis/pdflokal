/*
 * PDFLokal — the "leave site?" prompt for edits nobody has downloaded.
 * Dirty/clean is core/history.js (tests/core/history.test.mjs holds the serial
 * rules); this proves the browser really is asked, and only when it should be.
 *
 * HOW A PROMPT IS SEEN: page.reload() runs the page's beforeunload handlers and
 * Playwright surfaces the result as a 'dialog' of type 'beforeunload'. Chromium
 * only shows that prompt to a page the user has interacted with, so every case
 * touches the page first (a click on empty chrome mutates nothing) — otherwise a
 * "no prompt" assertion would pass for free, with or without the guard.
 * Not run by the foreground gate (nightly CI).
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';
import { downloadBytes } from './helpers/download-bytes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');

// Records every dialog the page raises and accepts it (leaving). Returns a reader.
function watchDialogs(page) {
  const seen = [];
  page.on('dialog', (d) => { seen.push(d.type()); d.accept(); });
  return {
    // Reload the way a user would after poking the page; report what was asked.
    async reload() {
      seen.length = 0;
      await page.mouse.click(5, 5); // user activation, no mutation
      await page.reload();
      return [...seen];
    },
    seen,
  };
}

async function open(page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expectFirstPage(page);
}

async function addText(page, text = 'Halo') {
  await page.keyboard.press('t');
  await page.click('.pv-page >> nth=0', { position: { x: 200, y: 200 } });
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await expect(page.locator('.pv-anno-text').last()).toHaveText(text);
}

// Closing a sheet pops its history entry with history.back(), asynchronously; a
// reload fired inside that window is aborted by the pending traversal. Wait it out.
async function closePages(page) {
  await page.click('#pm-close');
  await expect(page.locator('#pm-sheet')).not.toBeVisible();
  await expect.poll(() => page.evaluate(() => window.history.state?.v2dlg ?? null)).toBeNull();
}

async function downloadAll(page) {
  await page.click('#btn-download');
  const { buf } = await downloadBytes(page, () => page.click('#ds-cta'));
  expect(buf.length).toBeGreaterThan(500);
  await expect(page.locator('#dl-sheet')).not.toBeVisible();
}

// WHY SEEDED: every whole-document download can raise an ask over the page: the
// feature-vote dialog (js/v2/feature-vote.js, a modal that makes everything behind
// it inert) and the bug-report and share/tip cards. These cases download and then
// click .pv-page again, so whether that click lands depended on which ask had
// already closed: it passed on main by timing luck and timed out on a branch that
// shifted the timing. The asks are not under test here (feature-vote.spec.js,
// bug-report tests and growth-loop.spec.js own them), so mark each as already seen
// today, in the keys the app itself reads, before the page loads.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const today = new Date().toDateString();
    localStorage.setItem('pdflokal_vote_done', 'voted');
    localStorage.setItem('pdflokal_bugreport_last', today);
    localStorage.setItem('pdflokal-support-last', today);
  });
});

test.describe('leave guard', () => {
  test('landing with no document: no prompt', async ({ page }) => {
    const d = watchDialogs(page);
    await page.goto('/');
    expect(await d.reload()).toEqual([]);
  });

  test('just opening a file is not a change: no prompt', async ({ page }) => {
    const d = watchDialogs(page);
    await open(page);
    expect(await d.reload()).toEqual([]);
  });

  test('prompt after adding text; none once downloaded; again after a further edit', async ({ page }) => {
    const d = watchDialogs(page);
    await open(page);
    await addText(page, 'Satu');
    expect(await d.reload(), 'edited, not downloaded').toEqual(['beforeunload']);

    await open(page);
    await addText(page, 'Dua');
    await downloadAll(page);
    await page.mouse.click(5, 5);
    expect(await d.reload(), 'downloaded').toEqual([]);

    await open(page);
    await addText(page, 'Tiga');
    await downloadAll(page);
    await addText(page, 'Empat');
    expect(await d.reload(), 'edited again after the download').toEqual(['beforeunload']);
  });

  test('undo back to exactly the downloaded state is clean; redo is dirty again', async ({ page }) => {
    const d = watchDialogs(page);
    await open(page);
    await addText(page, 'Satu');
    await downloadAll(page);
    await addText(page, 'Dua');
    await page.keyboard.press('Escape');
    const armed = () => page.evaluate(() => window.v2.history.current !== window.v2.history.cleanId);
    expect(await armed()).toBe(true);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    expect(await armed()).toBe(false);
    expect(await d.reload()).toEqual([]);
  });

  test('page operations (Halaman: rotate) count as a change', async ({ page }) => {
    const d = watchDialogs(page);
    await open(page);
    await page.click('#btn-pages');
    await expect(page.locator('#pm-sheet')).toBeVisible();
    await page.click('.pm-tile:not(.pm-add) >> nth=0');
    await page.click('[data-act="rotate"]');
    await closePages(page);
    expect(await d.reload()).toEqual(['beforeunload']);
  });

  test('extracting a subset of pages is NOT "downloaded": edits stay guarded', async ({ page }) => {
    const d = watchDialogs(page);
    await open(page);
    await addText(page, 'Satu');
    await page.click('#btn-pages');
    await expect(page.locator('#pm-sheet')).toBeVisible();
    await page.click('.pm-tile:not(.pm-add) >> nth=0');
    await downloadBytes(page, () => page.click('[data-act="extract"]'));
    await closePages(page);
    expect(await d.reload()).toEqual(['beforeunload']);
  });

  test('Buka Baru (start over) takes the guard down: nothing left to lose', async ({ page }) => {
    const d = watchDialogs(page);
    await open(page);
    await addText(page, 'Satu');
    await page.click('#btn-file');
    await page.click('#fm-new');
    await page.click('#nc-go'); // edits not downloaded -> #new-confirm asks first
    await page.setInputFiles('#file-input', FIXTURE);
    await expectFirstPage(page);
    expect(await d.reload()).toEqual([]);
  });

  test('the wordmark home confirm asks once, in the app: no second browser prompt', async ({ page }) => {
    const d = watchDialogs(page);
    await open(page);
    await addText(page, 'Satu');
    await page.mouse.click(5, 5);
    d.seen.length = 0;
    await page.click('#btn-home');
    await expect(page.locator('#home-confirm')).toBeVisible();
    await Promise.all([page.waitForNavigation(), page.click('#hc-go')]);
    expect(d.seen).toEqual([]);
  });
});
