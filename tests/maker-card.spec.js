/*
 * The maker card and the visitor count (js/v2/maker-card.js, 2026-09-23).
 *
 * js/updates.js entries stay approved:false until Fauzan approves them; one
 * test serves an all-unapproved copy and asserts the card never appears. The
 * rest serve an all-approved copy, so the card's behaviour is tested without
 * depending on which entries he has approved today.
 * /api/visitors is a Vercel function the local static server does not run;
 * it is mocked the same way.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_UPDATES = fs.readFileSync(path.join(__dirname, '..', 'js', 'updates.js'), 'utf8');
// Fauzan approved the first three entries 2026-09-24; this still forces
// every entry approved so the tests do not depend on what is approved today.
const approved = (src) => src.replaceAll('approved: false', 'approved: true');

async function mock(page, { visitors = 184, updates = approved(REAL_UPDATES) } = {}) {
  await page.route('**/api/visitors', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ visitors }) }));
  if (updates !== null) {
    await page.route('**/js/updates.js', (r) => r.fulfill({ contentType: 'text/javascript', body: updates }));
  }
}

// The service worker serves our own modules after the first load, and
// page.route never sees a request the SW makes; without this a reload would
// quietly test the REAL (unapproved) updates.js.
test.use({ serviceWorkers: 'block' });

const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

// '/kompres-pdf' too: the SEO pages copy the landing, and they are where most
// first visits arrive from Google.
for (const url of ['/', '/kompres-pdf'])
for (const [name, viewport] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 375, height: 667 }]]) {
  test(`${url} ${name}: first visit shows the card, and Buka File stays uncovered`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mock(page);
    await page.goto(url);
    const card = page.locator('#maker-card');
    await expect(card).toBeVisible();
    await expect(card.locator('.mk-list li')).toHaveCount(3);
    const cardBox = await card.boundingBox();
    const buka = await page.locator('.dz-buka').boundingBox();
    expect(overlap(cardBox, buka), 'the card must not cover Buka File').toBe(false);
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/home${url.replace(/\//g, '-')}-${name}.png` });
  });
}

test('closing it keeps it closed; a NEW approved update brings it back', async ({ page }) => {
  await mock(page);
  await page.goto('/');
  await page.locator('#maker-card .mk-close').click();
  await expect(page.locator('#maker-card')).toBeHidden();
  await page.reload();
  await page.waitForTimeout(1500);
  await expect(page.locator('#maker-card')).toBeHidden();

  await page.unroute('**/js/updates.js');
  const withNew = approved(REAL_UPDATES).replace('export const UPDATES = [',
    "export const UPDATES = [\n  { id: 'test-newer', date: '2099-01-01', text: 'baru', approved: true },");
  await page.route('**/js/updates.js', (r) => r.fulfill({ contentType: 'text/javascript', body: withNew }));
  await page.reload();
  await expect(page.locator('#maker-card')).toBeVisible();
});

test('with nothing approved, the card never appears', async ({ page }) => {
  await mock(page, { updates: REAL_UPDATES.replaceAll('approved: true', 'approved: false') });
  await page.goto('/');
  await page.waitForTimeout(1500);
  await expect(page.locator('#maker-card')).toBeHidden();
});

test('the card leaves with the landing when a document opens', async ({ page }) => {
  await mock(page);
  await page.goto('/');
  await expect(page.locator('#maker-card')).toBeVisible();
  await page.setInputFiles('#file-input', path.join(__dirname, 'fixtures', 'sample-2pages.pdf'));
  await expectFirstPage(page);
  await expect(page.locator('#maker-card')).toBeHidden();
});

test('homepage count: shown with a number, hidden when the API has none', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mock(page);
  await page.goto('/');
  const c = page.locator('.ld-hd .visitor-count');
  await expect(c).toBeVisible();
  await expect(c).toHaveText('184 visitor hari ini');
  await expect(c.locator('.vc-pulse')).toBeVisible();
  // never collides with the centred nav
  expect(overlap(await c.boundingBox(), await page.locator('.ld-nav').boundingBox())).toBe(false);

  const p2 = await page.context().newPage();
  await p2.setViewportSize({ width: 1280, height: 800 });
  await mock(p2, { visitors: null });
  await p2.goto('/');
  await p2.waitForTimeout(800);
  await expect(p2.locator('.ld-hd .visitor-count')).toBeHidden();
});

test('editor count: between File and the tools when wide, first to go when narrow', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await mock(page);
  await page.goto('/');
  await page.setInputFiles('#file-input', path.join(__dirname, 'fixtures', 'sample-2pages.pdf'));
  await expectFirstPage(page);
  const c = page.locator('header > .visitor-count');
  await expect(c).toBeVisible();
  const file = await page.locator('#btn-file').boundingBox();
  const firstTool = await page.locator('#toolbar .tool').first().boundingBox();
  const box = await c.boundingBox();
  expect(box.x).toBeGreaterThan(file.x + file.width);
  expect(box.x + box.width).toBeLessThan(firstTool.x);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/editor-1440.png`, clip: { x: 0, y: 0, width: 1440, height: 70 } });

  await page.setViewportSize({ width: 900, height: 800 });
  await expect(c).toBeHidden();
  // and the tools did not lose anything to it
  expect(await page.locator('#toolbar').evaluate((t) => t.scrollWidth <= t.clientWidth + 1)).toBe(true);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/editor-900.png`, clip: { x: 0, y: 0, width: 900, height: 70 } });

  await page.setViewportSize({ width: 1440, height: 800 });
  await expect(c).toBeVisible();
});

test('"Lihat selengkapnya" opens the full work log on /dukung', async ({ page }) => {
  await mock(page);
  await page.goto('/');
  await page.locator('#maker-card .mk-more').click();
  await expect(page).toHaveURL(/\/dukung#development$/);
  await expect(page.locator('#rw-drawer')).toBeVisible();
  await expect(page.locator('#rw-drawer .rw-log li').first()).toBeVisible();
  // and it counted as answering the card: back home, it does not greet again
  await page.goto('/');
  await page.waitForTimeout(1500);
  await expect(page.locator('#maker-card')).toBeHidden();
});
