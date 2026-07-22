/*
 * Edit (Teks Asli) BETA — rename + beta badge + first-commit feedback + telemetry.
 * ============================================================================
 * Founder pivot 2026-07-22, WHEN-to-ask settled after three tries: not per-commit
 * (naggy), not in the download sheet ("wrong place"), not a debounced idle-timer
 * ("bollocks, buggy") → SIMPLEST: ask ONCE, on the FIRST successful commit of a
 * document. This gate pins:
 *   - the tool is renamed "Edit", carries a VISIBLE beta badge + arm-toast;
 *   - the pill appears on the first commit; not before a commit; once per doc;
 *   - 👍 / 👎+note both send to /api/feedback (session-correlated, no doc text),
 *     and the 👎 placeholder ASKS for detail;
 *   - the ladder telemetry (ganti_tap/ganti_commit/surgery/insert/commit_paint)
 *     fires, so a 👎 is correlatable with what the edit did.
 *
 * Fixture: undangan-cid.pdf ("Rapat Anggota Tahunan 2026" ×3), middle repeat.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { armGanti, tapLine } from './helpers/lines.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NASTY = (name) => path.join(__dirname, 'fixtures', 'nasty', name);

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

test.describe('edit beta: rename + first-commit feedback', () => {
  test('the tool is renamed Edit with a VISIBLE beta badge + beta arm-toast', async ({ page }) => {
    await openDoc(page, NASTY('undangan-cid.pdf'));
    const btn = page.locator('[data-tool="ganti"]');
    await expect(btn).toContainText('Edit');
    await expect(btn).not.toContainText('Ganti');
    const badge = btn.locator('.beta-tag');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText(/beta/i);
    await armGanti(page);
    await expect(page.locator('#toast')).toContainText(/beta/i);
  });

  test('the pill appears on the first commit; 👍 sends rating:up (no note)', async ({ page }) => {
    await captureBeacons(page);
    await openDoc(page, NASTY('undangan-cid.pdf'));
    await editMiddleLine(page, 'Rapat Baru');

    const pill = page.locator('#edit-feedback');
    await expect(pill).toHaveClass(/show/);
    await pill.locator('[aria-label="Bagus"]').click();

    await expect.poll(async () => (await feedbackBodies(page)).some((b) => b.rating === 'up')).toBe(true);
    const fb = (await feedbackBodies(page)).find((b) => b.rating === 'up');
    expect(fb).not.toHaveProperty('note');
    expect(fb.session_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  test('👎 opens a note whose placeholder asks for detail; Kirim sends it, never doc text', async ({ page }) => {
    await captureBeacons(page);
    await openDoc(page, NASTY('undangan-cid.pdf'));
    await editMiddleLine(page, 'Rapat Baru');

    const pill = page.locator('#edit-feedback');
    await expect(pill).toHaveClass(/show/);
    await pill.locator('[aria-label="Kurang pas"]').click();
    const note = pill.locator('.ef-note');
    await expect(note).toBeVisible();
    await expect(note).toHaveAttribute('placeholder', /improve/i);
    await note.fill('hurufnya beda dikit');
    await pill.locator('.ef-send').click();

    await expect.poll(async () => (await feedbackBodies(page))[0])
      .toEqual(expect.objectContaining({ rating: 'down', note: 'hurufnya beda dikit' }));
    expect(JSON.stringify((await feedbackBodies(page))[0])).not.toContain('Rapat');
  });

  test('never asks before a commit (arm + cancel shows no pill)', async ({ page }) => {
    await openDoc(page, NASTY('undangan-cid.pdf'));
    await armGanti(page);
    await tapLine(page, { str: 'Rapat Anggota Tahunan 2026', nth: 1 });
    await page.keyboard.press('Escape');
    await expect(page.locator('.v2-text-edit')).toHaveCount(0);
    await page.waitForTimeout(300);
    await expect(page.locator('#edit-feedback')).toHaveCount(0);
  });

  test('asks only ONCE — a second commit does not re-open the pill', async ({ page }) => {
    await openDoc(page, NASTY('undangan-cid.pdf'));
    await editMiddleLine(page, 'Rapat Baru');
    await expect(page.locator('#edit-feedback')).toHaveClass(/show/);
    // answer + let it fade, then edit again
    await page.locator('#edit-feedback [aria-label="Bagus"]').click();
    await page.waitForTimeout(300);
    await editMiddleLine(page, 'Rapat Lagi');
    await page.waitForTimeout(300);
    await expect(page.locator('#edit-feedback')).not.toHaveClass(/show/);
  });

  test('the ladder telemetry events fire (correlated with the edit)', async ({ page }) => {
    await captureBeacons(page);
    await openDoc(page, NASTY('undangan-cid.pdf'));
    await editMiddleLine(page, 'Rapat Baru');

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
    expect(evs.find((e) => e.event === 'insert').props).toEqual({ path: 'native', reason: 'clean' });
  });
});
