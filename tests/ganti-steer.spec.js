/*
 * Ganti Teks — press→steer→release-commit (founder ruling, dense docs,
 * 2026-07-19).
 * ============================================================================
 * Founder field report: on a dense document a fat finger/cursor couldn't aim
 * a single printed line among tight neighbors, and pointer-DOWN commit gave
 * no chance to correct before the editor opened on the WRONG line. Fix is the
 * house camera-first law applied to Ganti Teks: press lights the line under
 * the pointer (nothing committed), move re-targets live (steering), release
 * commits at the release point via the existing smartReplace path. A quick
 * click (press+release in place) reduces to today's outcome — this suite
 * proves that reduction alongside the new fine-pointer hover preview.
 *
 * Fixture: nasty/surat-fragmen.pdf (also used by tests/ganti-baris.spec.js) —
 * multiple distinct, well-separated LINEs with known text, so "moved to a
 * DIFFERENT line" is a real geometric assertion, not a guess.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { armGanti, lineBox } from './helpers/lines.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NASTY = (name) => path.join(__dirname, 'fixtures', 'nasty', name);
const FIXTURE = NASTY('surat-fragmen.pdf');

// Same LINE index map as tests/ganti-baris.spec.js (paint-order, verified
// there against a live extraction — not guessed here either).
const LINE = { A: 0, B: 1, C_KIRI: 2, C_KANAN: 3, D: 4, E: 5 };

async function openDoc(page, fixture) {
  await page.goto('/');
  await page.setInputFiles('#file-input', fixture);
  await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
}


// Fraction of the smaller box's area that the two boxes share — 1 = exact
// overlap. The glow is styled from the SAME line.x/y/w/h 
// helpers/lines.js's lineBox measures, in the same page-space overlay, so a
// hover over a line should produce near-total overlap, not just "somewhere nearby".
function overlapFraction(a, b) {
  const left = Math.max(a.x, b.x);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const top = Math.max(a.y, b.y);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return 0;
  const inter = (right - left) * (bottom - top);
  const minArea = Math.min(a.width * a.height, b.width * b.height);
  return inter / minArea;
}

test.describe('ganti steer — hover preview + release-commit (desktop mouse)', () => {
  test('hover lights the glow over the hovered line, re-targets on move, and never commits by itself', async ({ page }) => {
    await openDoc(page, FIXTURE);
    await armGanti(page);

    const boxA = await lineBox(page, { index: LINE.A });
    await page.mouse.move(boxA.x + boxA.width / 2, boxA.y + boxA.height / 2);
    await expect(page.locator('.pv-ganti-glow')).toBeVisible();
    const glowA = await page.locator('.pv-ganti-glow').boundingBox();
    expect(overlapFraction(glowA, boxA)).toBeGreaterThan(0.9);
    // Hover alone must never open the editor — nothing is committed until release.
    await expect(page.locator('.v2-text-edit')).toHaveCount(0);

    const boxB = await lineBox(page, { index: LINE.B });
    await page.mouse.move(boxB.x + boxB.width / 2, boxB.y + boxB.height / 2);
    await expect(async () => {
      const glowB = await page.locator('.pv-ganti-glow').boundingBox();
      expect(overlapFraction(glowB, boxB)).toBeGreaterThan(0.9);
    }).toPass();
    // It actually moved — not the same box as line A's.
    const glowB = await page.locator('.pv-ganti-glow').boundingBox();
    expect(overlapFraction(glowB, boxA)).toBeLessThan(0.5);
  });

  test('disarming the tool clears the glow', async ({ page }) => {
    await openDoc(page, FIXTURE);
    await armGanti(page);
    const boxA = await lineBox(page, { index: LINE.A });
    await page.mouse.move(boxA.x + boxA.width / 2, boxA.y + boxA.height / 2);
    await expect(page.locator('.pv-ganti-glow')).toBeVisible();

    await page.click('[data-tool="ganti"]'); // on-off toggle, founder ruling
    await expect(page.locator('.pv-ganti-glow')).toHaveCount(0);
  });

  test('no glow when Ganti is not armed, even while hovering a line', async ({ page }) => {
    await openDoc(page, FIXTURE);
    // Deliberately never arm the tool.
    await page.mouse.move(300, 300);
    await page.mouse.move(320, 260);
    await expect(page.locator('.pv-ganti-glow')).toHaveCount(0);
  });

  test('a click still commits — quick press+release in place opens the editor prefilled with that line (unchanged outcome)', async ({ page }) => {
    await openDoc(page, FIXTURE);
    await armGanti(page);
    const boxB = await lineBox(page, { index: LINE.B });
    await page.mouse.click(boxB.x + boxB.width / 2, boxB.y + boxB.height / 2);
    await expect(page.locator('.v2-text-edit')).toBeVisible();
    await expect(page.locator('.v2-text-edit')).toHaveText('Perihal: Undangan Rapat Anggota');
    // The glow belongs to the ARMED tool's steering, not to a committed draft.
    await expect(page.locator('.pv-ganti-glow')).toHaveCount(0);
  });
});
