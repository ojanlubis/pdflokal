/*
 * Edit (Teks Asli) BETA — rename + thumbs-feedback loop + correlated telemetry.
 * ============================================================================
 * Founder pivot 2026-07-22: ship the per-line editor as BETA, and — refined the
 * same day — ask 👍/👎 at the DOWNLOAD moment ("before they choose output
 * format"), NOT after every commit (too naggy for a 20-line session). This gate
 * pins that surface:
 *   - the tool is renamed "Edit" and marked beta (title + arm-toast);
 *   - opening the Unduh sheet AFTER an edit shows the feedback strip at the top;
 *     opening it with NO edit shows nothing;
 *   - 👍 and 👎+note both send to /api/feedback with THIS session's id (the join
 *     key) and NEVER document text; an abandoned 👎 is recorded on sheet-close;
 *   - the ladder telemetry (ganti_tap/ganti_commit/surgery/insert/commit_paint)
 *     fires, so a 👎 is correlatable with what the edit did.
 *
 * Fixture: undangan-cid.pdf (Type0/Identity-H, "Rapat Anggota Tahunan 2026" ×3)
 * the surgery/reedit suites already pin — the MIDDLE repeat (nth:1) cuts +
 * re-inserts NATIVELY (proven in tests/core/page-surgery-edited).
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { armGanti, tapLine } from './helpers/lines.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NASTY = (name) => path.join(__dirname, 'fixtures', 'nasty', name);

// In-page sendBeacon override (same seam as telemetry.spec.js), extended to
// record the URL so /api/t (telemetry) and /api/feedback (human) split apart.
async function captureBeacons(page) {
  await page.addInitScript(() => {
    window.__beacons = [];
    navigator.sendBeacon = (url, blob) => {
      Promise.resolve(blob && blob.text ? blob.text() : blob)
        .then((txt) => { try { window.__beacons.push({ url: String(url), body: JSON.parse(txt) }); } catch { /* non-JSON */ } });
      return true;
    };
  });
}
const beacons = (page) => page.evaluate(() => (window.__beacons || []).slice());
const feedbackBodies = async (page) => (await beacons(page)).filter((b) => b.url.includes('/api/feedback')).map((b) => b.body);
const fakeTabHidden = (page) => page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});

async function openDoc(page, fixture) {
  await page.goto('/');
  await page.setInputFiles('#file-input', fixture);
  await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
}

async function editMiddleLine(page, newText) {
  await armGanti(page);
  await tapLine(page, { str: 'Rapat Anggota Tahunan 2026', nth: 1 });
  await page.keyboard.type(newText);
  await page.keyboard.press('Enter');
  await expect(page.locator('.v2-text-edit')).toHaveCount(0);
}

const openSheet = (page) => page.locator('#btn-download').click();

test.describe('edit beta: rename + feedback loop', () => {
  test('the tool is renamed Edit and marked beta (title + arm-toast)', async ({ page }) => {
    await openDoc(page, NASTY('undangan-cid.pdf'));
    const btn = page.locator('[data-tool="ganti"]');
    await expect(btn).toContainText('Edit');
    await expect(btn).not.toContainText('Ganti');
    await expect(btn).toHaveAttribute('title', /beta/i);
    await armGanti(page);
    await expect(page.locator('#toast')).toContainText(/beta/i);
  });

  test('the Unduh sheet asks feedback ONLY after an edit; a no-edit download stays quiet', async ({ page }) => {
    await openDoc(page, NASTY('undangan-cid.pdf'));
    // No edit yet → the strip is hidden.
    await openSheet(page);
    await expect(page.locator('#ds-feedback')).toBeHidden();
    await page.locator('#ds-close').click();
    // Now edit, reopen → the strip shows, above the Format control.
    await editMiddleLine(page, 'Rapat Baru');
    await openSheet(page);
    await expect(page.locator('#ds-feedback')).toBeVisible();
    await expect(page.locator('#ds-feedback')).toContainText(/hasil editnya/i);
  });

  test('👍 in the sheet sends rating:up (no note), carrying this session id', async ({ page }) => {
    await captureBeacons(page);
    await openDoc(page, NASTY('undangan-cid.pdf'));
    await editMiddleLine(page, 'Rapat Baru');
    await openSheet(page);

    const strip = page.locator('#ds-feedback');
    await expect(strip).toBeVisible();
    await strip.locator('[aria-label="Bagus"]').click();

    await expect.poll(async () => (await feedbackBodies(page)).some((b) => b.rating === 'up')).toBe(true);
    const fb = (await feedbackBodies(page)).find((b) => b.rating === 'up');
    expect(fb).not.toHaveProperty('note');
    expect(fb.session_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  test('👎 opens a note; Kirim sends rating:down + the typed note, never document text', async ({ page }) => {
    await captureBeacons(page);
    await openDoc(page, NASTY('undangan-cid.pdf'));
    await editMiddleLine(page, 'Rapat Baru');
    await openSheet(page);

    const strip = page.locator('#ds-feedback');
    await strip.locator('[aria-label="Kurang pas"]').click();
    const note = strip.locator('.ef-note');
    await expect(note).toBeVisible();
    await note.fill('hurufnya beda dikit');
    await strip.locator('.ef-send').click();

    await expect.poll(async () => (await feedbackBodies(page))[0])
      .toEqual(expect.objectContaining({ rating: 'down', note: 'hurufnya beda dikit' }));
    const fb = (await feedbackBodies(page))[0];
    expect(JSON.stringify(fb)).not.toContain('Rapat'); // never the document's text
  });

  test('an abandoned 👎 (note opened, sheet closed) is still recorded note-less', async ({ page }) => {
    await captureBeacons(page);
    await openDoc(page, NASTY('undangan-cid.pdf'));
    await editMiddleLine(page, 'Rapat Baru');
    await openSheet(page);

    await page.locator('#ds-feedback [aria-label="Kurang pas"]').click();
    await expect(page.locator('#ds-feedback .ef-note')).toBeVisible();
    await page.locator('#ds-close').click(); // walk away without Kirim

    await expect.poll(async () => (await feedbackBodies(page)).length).toBe(1);
    const fb = (await feedbackBodies(page))[0];
    expect(fb.rating).toBe('down');
    expect(fb).not.toHaveProperty('note'); // abandoned → recorded note-less
  });

  test('the ladder telemetry events fire (correlated with the edit)', async ({ page }) => {
    await captureBeacons(page);
    await openDoc(page, NASTY('undangan-cid.pdf'));
    await editMiddleLine(page, 'Rapat Baru');

    // The commit-path events land in the rebake .then() (async). Flush on each
    // poll iteration until commit_paint (the last one) has arrived.
    const evNames = async () => {
      await fakeTabHidden(page);
      return (await beacons(page)).filter((b) => b.url.includes('/api/t')).flatMap((b) => (b.body.events || []).map((e) => e.event));
    };
    await expect.poll(evNames).toContain('commit_paint');

    const evs = (await beacons(page)).filter((b) => b.url.includes('/api/t')).flatMap((b) => b.body.events || []);
    const names = evs.map((e) => e.event);
    expect(names).toContain('ganti_tap');
    expect(names).toContain('ganti_commit');
    expect(names).toContain('surgery');

    expect(evs.find((e) => e.event === 'ganti_commit').props.outcome).toBe('commit');
    expect(evs.find((e) => e.event === 'surgery').props).toEqual({ matched: true, reason: 'clean' });
    // undangan-cid re-inserts natively (proven in the core suite) → path native.
    expect(evs.find((e) => e.event === 'insert').props).toEqual({ path: 'native', reason: 'clean' });
    const paint = evs.find((e) => e.event === 'commit_paint');
    expect(typeof paint.props.duration).toBe('number');
    expect(paint.props.duration % 10).toBe(0); // durationBucket invariant
  });
});
