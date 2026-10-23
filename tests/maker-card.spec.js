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

// The close button drew a vertical oval (32 wide, 36 tall: the global
// `button { min-height: 36px }` beat its height). Equal sides and a round radius.
test('close button is a true circle (fine pointer)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mock(page);
  await page.goto('/');
  const x = page.locator('#maker-card .mk-close');
  await expect(x).toBeVisible();
  const b = await x.boundingBox();
  expect(b.width).toBeCloseTo(b.height, 1);
  expect(await x.evaluate((e) => getComputedStyle(e).borderRadius)).toBe('50%');
});

test.describe('close button, coarse pointer', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('is a true circle with a 44px touch target', async ({ page }) => {
    await mock(page);
    await page.goto('/');
    const x = page.locator('#maker-card .mk-close');
    await expect(x).toBeVisible();
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'the context really is coarse').toBe(true);
    const b = await x.boundingBox();
    expect(b.width).toBeCloseTo(b.height, 1);
    expect(b.width).toBeGreaterThanOrEqual(44);
    // the visible disc stays 32px
    const disc = await x.evaluate((e) => parseFloat(getComputedStyle(e, '::before').width));
    expect(disc).toBe(32);
  });
});

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

// Homepage: ONE centred line under the dropzone, above the install chip, at every
// width (his ruling 2026-10-06). It used to sit in the header beside the wordmark
// at >=1100px only, so a phone never saw it.
for (const [name, viewport] of [['phone', { width: 390, height: 844 }], ['desktop', { width: 1280, height: 800 }]]) {
  test(`homepage count (${name}): one centred line under the dropzone, above the install chip`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mock(page);
    await page.goto('/');
    const c = page.locator('.vc-wrap .visitor-count');
    await expect(c).toBeVisible();
    await expect(c).toHaveText('184 visitor hari ini');
    await expect(c.locator('.vc-pulse')).toBeVisible();
    const box = await c.boundingBox();
    const dz = await page.locator('#btn-open').boundingBox();
    const chip = await page.locator('.ip-chip-wrap').boundingBox();
    expect(box.y, 'below the dropzone').toBeGreaterThanOrEqual(dz.y + dz.height);
    expect(box.y + box.height, 'above the install chip').toBeLessThanOrEqual(chip.y + 1);
    // one line: no taller than a 14px text line plus slack
    expect(box.height).toBeLessThan(26);
    // centred on the page, not on the dropzone's own left edge
    expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThan(8);
    // and it is no longer in the header
    await expect(page.locator('.ld-hd .visitor-count')).toHaveCount(0);
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/vc2-home-${viewport.width}.png` });
  });
}

test('homepage count: hidden, and takes no room, when the API has none', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mock(page, { visitors: null });
  await page.goto('/');
  await page.waitForTimeout(800);
  await expect(page.locator('.vc-wrap .visitor-count')).toBeHidden();
  await expect(page.locator('.vc-wrap')).toBeHidden();
});

test('editor count (phone): hidden, and the header gets no extra row for it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const toolbarTop = async (visitors) => {
    const p = await page.context().newPage();
    await p.setViewportSize({ width: 390, height: 844 });
    await mock(p, { visitors });
    await p.goto('/');
    await p.setInputFiles('#file-input', path.join(__dirname, 'fixtures', 'sample-2pages.pdf'));
    await expectFirstPage(p);
    // the API answer arrives well before a document has rendered; wait anyway
    await p.waitForTimeout(500);
    const top = (await p.locator('#toolbar').boundingBox()).y;
    const shown = await p.locator('header > .visitor-count').isVisible();
    if (visitors && process.env.SHOTS) await p.screenshot({ path: `${process.env.SHOTS}/vc2-editor-390.png` });
    await p.close();
    return { top, shown };
  };
  const without = await toolbarTop(null);
  const withCount = await toolbarTop(184);
  expect(withCount.shown, 'the count is hidden in the editor at phone width').toBe(false);
  expect(withCount.top, 'tool row top is unchanged by the count').toBe(without.top);
});

test('editor count (desktop 1280): visible beside File on the header row', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mock(page);
  await page.goto('/');
  await page.setInputFiles('#file-input', path.join(__dirname, 'fixtures', 'sample-2pages.pdf'));
  await expectFirstPage(page);
  const c = page.locator('header > .visitor-count');
  await expect(c).toBeVisible();
  const file = await page.locator('#btn-file').boundingBox();
  const box = await c.boundingBox();
  expect(box.x).toBeGreaterThan(file.x + file.width);
  expect(Math.abs((box.y + box.height / 2) - (file.y + file.height / 2)), 'same row as File').toBeLessThan(12);
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
