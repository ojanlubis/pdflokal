/*
 * Ganti Teks — press→steer→release-commit on REAL touch (founder ruling,
 * dense docs, 2026-07-19). Companion to tests/ganti-steer.spec.js (desktop
 * mouse hover); this suite proves the same law survives a finger: a quick tap
 * still commits like before, but a press-drag-release now STEERS to wherever
 * the finger lifts, not wherever it landed — the whole point of the change
 * (a fat finger on a dense document couldn't aim a single printed line).
 *
 * Real pointer sequences (touch-typed PointerEvents), same driving pattern as
 * tests/mobile/whiteout-drag.spec.js's touchDrag — that file's own comment
 * explains why manual dispatch is needed for a multi-step drag (Playwright's
 * touchscreen API only has a single tap, no move).
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NASTY = (name) => path.join(__dirname, '..', 'fixtures', 'nasty', name);
const FIXTURE = NASTY('surat-fragmen.pdf');

// Same LINE index map as tests/ganti-baris.spec.js and tests/ganti-steer.spec.js.
const LINE = { A: 0, B: 1, C_KIRI: 2, C_KANAN: 3, D: 4, E: 5 };

async function openDoc(page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
}

async function armGanti(page) {
  await page.tap('[data-tool="ganti"]');
  await expect(page.locator('.pv-run-hints div').first()).toBeVisible();
}

async function hintCenter(page, nth) {
  const hint = page.locator('.pv-run-hints div').nth(nth);
  await hint.scrollIntoViewIfNeeded();
  const box = await hint.boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

// A point on the current page that overlaps NONE of the hinted lines (with
// generous padding) — real margin, not "probably empty".
async function marginPoint(page) {
  const pageBox = await page.locator('.pv-page').first().boundingBox();
  const hints = await page.locator('.pv-run-hints div').evaluateAll(
    (els) => els.map((el) => el.getBoundingClientRect())
      .map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })),
  );
  const pad = 24;
  const candidates = [
    { x: pageBox.x + 8, y: pageBox.y + 8 },
    { x: pageBox.x + pageBox.width - 8, y: pageBox.y + 8 },
    { x: pageBox.x + 8, y: pageBox.y + pageBox.height - 8 },
    { x: pageBox.x + pageBox.width - 8, y: pageBox.y + pageBox.height - 8 },
    { x: pageBox.x + pageBox.width / 2, y: pageBox.y + 8 },
  ];
  for (const c of candidates) {
    const hit = hints.some((h) => c.x >= h.x - pad && c.x <= h.x + h.width + pad
      && c.y >= h.y - pad && c.y <= h.y + h.height + pad);
    if (!hit) return c;
  }
  throw new Error('marginPoint: every candidate overlapped a hinted line — fixture geometry changed');
}

// Real touch-typed PointerEvents, dispatched via elementFromPoint at each
// coordinate — same shape as whiteout-drag.spec.js's touchDrag helper. Exposed
// on window via addInitScript (evaluate() runs in an isolated world per call,
// so a plain imported function isn't reachable there).
async function installFireHelper(page) {
  await page.addInitScript(() => {
    window.__fireTouch = (type, x, y, extra) => {
      const el = document.elementFromPoint(x, y) || document.body;
      el.dispatchEvent(new PointerEvent(type, {
        pointerId: 11, pointerType: 'touch', isPrimary: true,
        clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true,
        ...extra,
      }));
    };
  });
}
const fireTouch = (page, type, x, y, extra) => page.evaluate(
  ({ type, x, y, extra }) => window.__fireTouch(type, x, y, extra),
  { type, x, y, extra },
);

// down → N interpolated moves (rAF-paced so the throttled steer settles) → up.
async function touchDrag(page, fromX, fromY, toX, toY, steps = 6) {
  await fireTouch(page, 'pointerdown', fromX, fromY, { button: 0, buttons: 1 });
  for (let i = 1; i <= steps; i += 1) {
    const x = fromX + ((toX - fromX) * i) / steps;
    const y = fromY + ((toY - fromY) * i) / steps;
    // eslint-disable-next-line no-await-in-loop
    await fireTouch(page, 'pointermove', x, y, { button: -1, buttons: 1 });
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(20);
  }
  await fireTouch(page, 'pointerup', toX, toY, { button: -1, buttons: 0 });
}

test.describe('ganti steer — press/drag/release on real touch', () => {
  test.beforeEach(async ({ page }) => {
    await installFireHelper(page);
  });

  test('quick tap on a line still opens the editor prefilled with that line (regression)', async ({ page }) => {
    await openDoc(page);
    await armGanti(page);
    const c = await hintCenter(page, LINE.A);
    await page.touchscreen.tap(c.x, c.y);
    await expect(page.locator('.v2-text-edit')).toBeVisible();
    await expect(page.locator('.v2-text-edit')).toHaveText('Nomor: 045/SEK/VII/2026');
  });

  test('press on line A, drag to line B, release — prefill is line B, NOT line A', async ({ page }) => {
    await openDoc(page);
    await armGanti(page);
    const a = await hintCenter(page, LINE.A);
    const b = await hintCenter(page, LINE.B);

    await touchDrag(page, a.x, a.y, b.x, b.y);

    await expect(page.locator('.v2-text-edit')).toBeVisible();
    await expect(page.locator('.v2-text-edit')).toHaveText('Perihal: Undangan Rapat Anggota');
  });

  test('the glow exists mid-drag (steering is visible before commit)', async ({ page }) => {
    await openDoc(page);
    await armGanti(page);
    const a = await hintCenter(page, LINE.A);
    const b = await hintCenter(page, LINE.B);

    await fireTouch(page, 'pointerdown', a.x, a.y, { button: 0, buttons: 1 });
    await expect(page.locator('.pv-ganti-glow')).toHaveCount(1); // lit at press

    // Move ONTO line B (not the geometric midpoint — the gap between two
    // lines is a legitimate MISS, per core/text-lines.js's resolveTap: the
    // glow correctly clears there, same as it will at a real margin miss).
    // The point here is "still lit mid-drag, nothing committed yet", proven
    // by re-targeting to a second real line before any release.
    await fireTouch(page, 'pointermove', b.x, b.y, { button: -1, buttons: 1 });
    await expect(page.locator('.pv-ganti-glow')).toHaveCount(1); // still lit mid-steer, nothing committed
    await expect(page.locator('.v2-text-edit')).toHaveCount(0);

    await fireTouch(page, 'pointerup', b.x, b.y, { button: -1, buttons: 0 });
    await expect(page.locator('.v2-text-edit')).toBeVisible(); // NOW it commits, at release
  });

  test('press, drag off all text into the margin, release — no editor opens, miss-toast fires', async ({ page }) => {
    await openDoc(page);
    await armGanti(page);
    const a = await hintCenter(page, LINE.A);
    const margin = await marginPoint(page);

    await touchDrag(page, a.x, a.y, margin.x, margin.y);

    await expect(page.locator('#toast')).toContainText('kena tulisan');
    await expect(page.locator('.v2-text-edit')).toHaveCount(0);
    expect(await page.evaluate(() => window.v2.getDoc().pages[0].annotations.length)).toBe(0);
  });
});
