/*
 * wheel-zoom-rate.spec.js — a gentle trackpad pinch is a gentle zoom.
 * ============================================================================
 * Chrome and Firefox deliver a trackpad pinch as MANY ctrl+wheel events with
 * small deltaY. The handler multiplied zoom by 1.1 per EVENT whatever its
 * delta, so ~25 events crossed the whole 0.3–3 range: a light pinch on a Mac
 * or Windows trackpad snapped to a clamp. Round-3 hunt, 2026-10-10.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const appliedZoom = (page) => page.evaluate(() => {
  const t = getComputedStyle(document.getElementById('v2-stage')).transform;
  if (!t || t === 'none') return 1;
  return Number(t.slice(t.indexOf('(') + 1).split(',')[0]);
});

async function ctrlWheel(page, deltaY, times) {
  await page.mouse.move(640, 400);
  await page.keyboard.down('Control');
  for (let i = 0; i < times; i += 1) await page.mouse.wheel(0, deltaY);
  await page.keyboard.up('Control');
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await page.setInputFiles('#file-input', path.join(__dirname, 'fixtures', 'sample-2pages.pdf'));
  await expectFirstPage(page);
});

test('twenty small pinch deltas zoom a little, not to the clamp', async ({ page }) => {
  const z0 = await appliedZoom(page);
  await ctrlWheel(page, -2, 20);
  await expect.poll(() => appliedZoom(page), { message: 'VACUITY GUARD: the pinch zoomed at all' }).toBeGreaterThan(z0);
  const z1 = await appliedZoom(page);
  expect(z1 / z0, `20 tiny deltas took zoom from ${z0} to ${z1}`).toBeLessThan(1.25);
});

test('KNOWN-POSITIVE: a mouse-wheel notch (deltaY 100) is still a real step', async ({ page }) => {
  const z0 = await appliedZoom(page);
  await ctrlWheel(page, -100, 1);
  await expect.poll(() => appliedZoom(page)).toBeGreaterThan(z0 * 1.05);
});

test('a ctrl+horizontal swipe (deltaY 0) does not zoom out', async ({ page }) => {
  const z0 = await appliedZoom(page);
  await page.mouse.move(640, 400);
  await page.keyboard.down('Control');
  for (let i = 0; i < 5; i += 1) await page.mouse.wheel(40, 0);
  await page.keyboard.up('Control');
  await page.waitForTimeout(300);
  expect(await appliedZoom(page)).toBe(z0);
});
