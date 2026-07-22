/*
 * Edit (Teks Asli) BETA — rename + thumbs-feedback loop + correlated telemetry.
 * ============================================================================
 * Founder pivot 2026-07-22: ship the per-line editor as BETA, ask 👍/👎 after
 * every use, and let real usage be the oracle. This gate pins that surface:
 *   - the tool is renamed "Edit" and marked beta (title + arm-toast);
 *   - a successful commit shows the quiet pill; 👍 and 👎+note both send to
 *     /api/feedback with THIS session's id (the join key) and NEVER document text;
 *   - the ladder telemetry events (ganti_tap/ganti_commit/surgery/insert/
 *     commit_paint) fire, so a 👎 is correlatable with what the edit did;
 *   - cancel/Escape asks nothing (the pill only follows a real edit).
 *
 * Reuses the undangan-cid.pdf nasty fixture (Type0/Identity-H, "Rapat Anggota
 * Tahunan 2026" ×3) the surgery/reedit suites already pin — the MIDDLE repeat
 * (nth:1) cuts + re-inserts NATIVELY, proven in tests/core/page-surgery-edited.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { armGanti, tapLine } from './helpers/lines.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NASTY = (name) => path.join(__dirname, 'fixtures', 'nasty', name);

// In-page sendBeacon override (same seam as telemetry.spec.js — `npx serve`
// can't intercept a background beacon at the network layer), extended to record
// the URL so /api/t (telemetry) and /api/feedback (human) are distinguishable.
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
const fakeTabHidden = (page) => page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});

async function openDoc(page, fixture) {
  await page.goto('/');
  await page.setInputFiles('#file-input', fixture);
  await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
}

// Edit the middle "Rapat…" repeat and commit; resolves once the pill has shown
// (the pill is the last thing the commit's rebake .then() does, AFTER the
// telemetry is queued — so waiting on it also guarantees the events are ready).
async function editMiddleLine(page, newText) {
  await armGanti(page);
  await tapLine(page, { str: 'Rapat Anggota Tahunan 2026', nth: 1 });
  await page.keyboard.type(newText);
  await page.keyboard.press('Enter');
  await expect(page.locator('.v2-text-edit')).toHaveCount(0);
}

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

  test('a successful commit shows the quiet pill; 👍 sends rating:up (no note)', async ({ page }) => {
    await captureBeacons(page);
    await openDoc(page, NASTY('undangan-cid.pdf'));
    await editMiddleLine(page, 'Rapat Baru');

    const pill = page.locator('#edit-feedback');
    await expect(pill).toHaveClass(/show/);
    await pill.locator('[aria-label="Bagus"]').click();

    await expect.poll(async () => (await beacons(page))
      .some((b) => b.url.includes('/api/feedback') && b.body.rating === 'up')).toBe(true);
    const fb = (await beacons(page)).find((b) => b.url.includes('/api/feedback'));
    expect(fb.body).not.toHaveProperty('note');
    expect(fb.body.session_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  test('👎 opens a note; Kirim sends rating:down + the typed note, never document text', async ({ page }) => {
    await captureBeacons(page);
    await openDoc(page, NASTY('undangan-cid.pdf'));
    await editMiddleLine(page, 'Rapat Baru');

    const pill = page.locator('#edit-feedback');
    await expect(pill).toHaveClass(/show/);
    await pill.locator('[aria-label="Kurang pas"]').click();
    const note = pill.locator('.ef-note');
    await expect(note).toBeVisible();
    await note.fill('hurufnya beda dikit');
    await pill.locator('.ef-send').click();

    await expect.poll(async () => (await beacons(page))
      .find((b) => b.url.includes('/api/feedback'))?.body)
      .toEqual(expect.objectContaining({ rating: 'down', note: 'hurufnya beda dikit' }));
    // The payload must NEVER carry the edited document's text.
    const fb = (await beacons(page)).find((b) => b.url.includes('/api/feedback'));
    expect(JSON.stringify(fb.body)).not.toContain('Rapat');
  });

  test('the ladder telemetry events fire (correlated with the edit)', async ({ page }) => {
    await captureBeacons(page);
    await openDoc(page, NASTY('undangan-cid.pdf'));
    await editMiddleLine(page, 'Rapat Baru');
    await expect(page.locator('#edit-feedback')).toHaveClass(/show/); // telemetry is queued by now

    await fakeTabHidden(page); // batched (<10) — force the same flush a real tab-hide does
    const evs = (await beacons(page))
      .filter((b) => b.url.includes('/api/t'))
      .flatMap((b) => b.body.events || []);
    const names = evs.map((e) => e.event);
    expect(names).toContain('ganti_tap');
    expect(names).toContain('ganti_commit');
    expect(names).toContain('surgery');
    expect(names).toContain('commit_paint');

    expect(evs.find((e) => e.event === 'ganti_commit').props.outcome).toBe('commit');
    expect(evs.find((e) => e.event === 'surgery').props).toEqual({ matched: true, reason: 'clean' });
    // undangan-cid re-inserts natively (proven in the core suite) → path native.
    expect(evs.find((e) => e.event === 'insert').props).toEqual({ path: 'native', reason: 'clean' });
    const paint = evs.find((e) => e.event === 'commit_paint');
    expect(typeof paint.props.duration).toBe('number');
    expect(paint.props.duration % 10).toBe(0); // durationBucket invariant
  });

  test('cancel (Escape) asks nothing — the pill only follows a real edit', async ({ page }) => {
    await openDoc(page, NASTY('undangan-cid.pdf'));
    await armGanti(page);
    await tapLine(page, { str: 'Rapat Anggota Tahunan 2026', nth: 1 });
    await page.keyboard.press('Escape');
    await expect(page.locator('.v2-text-edit')).toHaveCount(0);
    await page.waitForTimeout(300); // give the commit path its async window
    await expect(page.locator('#edit-feedback')).toHaveCount(0);
  });
});
