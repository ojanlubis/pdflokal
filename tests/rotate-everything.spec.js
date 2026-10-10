/*
 * TURN A PAGE AND EVERYTHING ON IT TURNS WITH IT: ON SCREEN, IN THE FILE, AND
 * STILL AN OBJECT YOU CAN GRAB.
 * ============================================================================
 * Founder ruling 2026-10-11 ("semua harus ngikut rotasi"): text and
 * signatures turn with the page like ink on paper. Until then they stayed
 * upright and only followed their spot.
 *
 * The headless half lives in tests/core/rotate-annotations.test.mjs (model),
 * tests/core/export-turn.test.mjs (file) and tests/core/render-turn.test.mjs
 * (overlay, resize, re-edit hit). This spec proves what only a browser can:
 * the CSS turn really paints the object where the file puts it, the rotated
 * element is still hit-tested, dragged, re-edited and deleted, and the
 * downloaded word reads down the page at the spot the screen showed.
 * Not run by the foreground gate (nightly CI).
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';
import { downloadBytes } from './helpers/download-bytes.js';
import { armGanti, tapLine } from './helpers/lines.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');
const WORD = 'Putarku';

const annos = (page) => page.evaluate(() => window.v2.getDoc().pages[0].annotations
  .map((a) => ({ id: a.id, type: a.type, x: a.x, y: a.y, turn: a.turn || 0, text: a.text })));

async function placeTextAndSignature(page) {
  // Fractions of the page box, so the spots are on the page at any fit zoom.
  const pg = await page.locator('.pv-page').first().boundingBox();
  await page.keyboard.press('t');
  await page.click('.pv-page >> nth=0', { position: { x: pg.width * 0.2, y: pg.height * 0.2 } });
  await page.keyboard.insertText(WORD);
  await page.keyboard.press('Enter');
  await expect(page.locator('.pv-anno-text')).toHaveText(WORD);

  await page.click('[data-tool="signature"]');
  await expect(page.locator('#sig-modal')).toBeVisible();
  const pad = await page.locator('#sig-canvas').boundingBox();
  await page.mouse.move(pad.x + 40, pad.y + 60);
  await page.mouse.down();
  await page.mouse.move(pad.x + 180, pad.y + 90, { steps: 6 });
  await page.mouse.up();
  await page.click('#sig-use');
  await page.click('.pv-page >> nth=0', { position: { x: pg.width * 0.45, y: pg.height * 0.5 } });
  await expect(page.locator('.pv-anno-signature')).toHaveCount(1);
  // Deselect: the signature's action bar sits over the strip's Putar button.
  await page.keyboard.press('Escape');
  await expect(page.locator('#sig-bar')).not.toHaveClass(/show/);
}

async function turnFirstPage(page) {
  await page.locator('.pv-strip >> nth=0').locator('[data-strip-act="rotate"]').click();
  await expect.poll(() => page.evaluate(() => window.v2.getDoc().pages[0].rotation)).toBe(90);
}

const centre = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

test('a turned page turns its text and signature, and both stay objects', async ({ page }) => {
  test.setTimeout(60000);
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expectFirstPage(page);
  await placeTextAndSignature(page);

  const before = await page.locator('.pv-anno-text').boundingBox();
  expect(before.width, 'VACUITY GUARD: upright text is wider than tall').toBeGreaterThan(before.height);

  await turnFirstPage(page);

  // The model and the DOM both carry the turn.
  const model = await annos(page);
  expect(model.filter((a) => a.type !== 'whiteout').map((a) => a.turn)).toEqual([90, 90]);
  await expect(page.locator('.pv-anno-text')).toHaveAttribute('data-turn', '90');
  await expect(page.locator('.pv-anno-signature')).toHaveAttribute('data-turn', '90');
  // A turned portrait page is wider than the viewport: bring the word in, as
  // the user would by scrolling.
  await page.locator('.pv-anno-text').scrollIntoViewIfNeeded();
  // And it is really painted turned: the word now reads down the page.
  const turned = await page.locator('.pv-anno-text').boundingBox();
  expect(turned.height, 'the text did not turn on screen').toBeGreaterThan(turned.width);

  // Still a working object: a click on the turned word selects it, a drag moves it.
  const c = centre(turned);
  await page.mouse.click(c.x, c.y);
  await expect(page.locator('.pv-anno-text.pv-selected')).toHaveCount(1);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x - 40, c.y + 30, { steps: 5 });
  await page.mouse.up();
  const moved = (await annos(page)).find((a) => a.type === 'text');
  const was = model.find((a) => a.type === 'text');
  expect(moved.x).toBeLessThan(was.x);
  expect(moved.y).toBeGreaterThan(was.y);
  expect(moved.turn, 'a drag keeps the turn').toBe(90);

  // Re-edit: a second click on the selected word opens the editor TURNED.
  const again = centre(await page.locator('.pv-anno-text').boundingBox());
  await page.mouse.click(again.x, again.y);
  await expect(page.locator('.v2-text-edit')).toHaveAttribute('data-turn', '90');
  await page.keyboard.press('End');
  await page.keyboard.insertText('X');
  await page.keyboard.press('Enter');
  await expect(page.locator('.v2-text-edit')).toHaveCount(0);
  const edited = (await annos(page)).find((a) => a.type === 'text');
  expect(edited.text).toBe(`${WORD}X`);
  expect([edited.x, edited.y, edited.turn], 'a re-edit keeps the spot and the turn').toEqual([moved.x, moved.y, 90]);

  // The signature, selected through its rotated box, deletes.
  await page.locator('.pv-anno-signature').scrollIntoViewIfNeeded();
  const sig = centre(await page.locator('.pv-anno-signature').boundingBox());
  await page.mouse.click(sig.x, sig.y);
  await expect(page.locator('.pv-anno-signature.pv-selected')).toHaveCount(1);
  await page.keyboard.press('Delete');
  await expect(page.locator('.pv-anno-signature')).toHaveCount(0);
});

test('the downloaded word reads down the turned page, where the screen showed it', async ({ page }) => {
  test.setTimeout(60000);
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expectFirstPage(page);
  await placeTextAndSignature(page);
  await turnFirstPage(page);

  const pv = await page.locator('.pv-page').first().boundingBox();
  const tb = await page.locator('.pv-anno-text').boundingBox();
  const screen = {
    x0: (tb.x - pv.x) / pv.width, x1: (tb.x + tb.width - pv.x) / pv.width,
    y0: (tb.y - pv.y) / pv.height, y1: (tb.y + tb.height - pv.y) / pv.height,
  };

  await page.click('#btn-download');
  const { buf } = await downloadBytes(page, () => page.click('#ds-cta'));
  const file = await page.evaluate(async ({ arr, word }) => {
    const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(arr) }).promise;
    const p = await doc.getPage(1);
    const vp = p.getViewport({ scale: 1 });
    const item = (await p.getTextContent()).items.find((it) => it.str.includes(word));
    if (!item) return null;
    const m = window.pdfjsLib.Util.transform(vp.transform, item.transform);
    return { fx: m[4] / vp.width, fy: m[5] / vp.height, dir: [m[0], m[1]], landscape: vp.width > vp.height };
  }, { arr: Array.from(buf), word: WORD });

  expect(file, 'the word is in the downloaded file').not.toBeNull();
  expect(file.landscape, 'VACUITY GUARD: the file\'s page is turned').toBe(true);
  // Viewport is y-down: reading down the page is direction (0, +size).
  expect(Math.abs(file.dir[0]), `the word reads sideways, direction ${file.dir}`).toBeLessThan(0.01);
  expect(file.dir[1]).toBeGreaterThan(0);
  // Its baseline start lies inside the box the screen painted (2% slack).
  const s = 0.02;
  expect(file.fx).toBeGreaterThan(screen.x0 - s);
  expect(file.fx).toBeLessThan(screen.x1 + s);
  expect(file.fy).toBeGreaterThan(screen.y0 - s);
  expect(file.fy).toBeLessThan(screen.y1 + s);
});

// Review of this branch: block-editor.js reads a paragraph's wraps and
// baseline from viewport rects, which a CSS rotate scrambles, so a turned
// paragraph re-edits UPRIGHT and the commit keeps the turn. RED when
// openTextEditor turns the paragraph editor: the lines split every few
// characters (90) and the anchor shifts by the baseline.
test('a turned paragraph re-edits upright and keeps its lines, spot and turn', async ({ page }) => {
  test.setTimeout(60000);
  await page.goto('/');
  await page.setInputFiles('#file-input', path.join(__dirname, 'fixtures', 'nasty', 'paragraf-badan.pdf'));
  await expectFirstPage(page);
  await armGanti(page);
  await tapLine(page, { str: 'lingkungan kantor' });
  const ed = page.locator('.v2-text-edit');
  await expect(ed).toHaveAttribute('data-font-path', 'native', { timeout: 10_000 });
  // The editor opens with the paragraph selected: typing replaces it.
  await page.keyboard.insertText('Seluruh pegawai kantor diminta hadir pada kerja bakti hari Sabtu pagi pukul tujuh '
    + 'dengan membawa peralatan kebersihan sendiri sesuai pembagian tugas dari panitia.');
  await page.keyboard.press('Enter');
  await expect(ed).toHaveCount(0);
  const read = () => page.evaluate(() => {
    const a = window.v2.getDoc().pages[0].annotations.find((x) => x.type === 'text' && x.block);
    return a && { id: a.id, text: a.text, lines: a.block.lines.length, turn: a.turn || 0,
      dx: a.block.disp ? a.block.disp.x - a.x : null, dy: a.block.disp ? a.block.disp.y - a.y : null };
  });
  const before = await read();
  expect(before, 'VACUITY GUARD: the paragraph committed as a block').toBeTruthy();
  expect(before.lines).toBeGreaterThan(1);

  await page.keyboard.press('Escape');
  await turnFirstPage(page);
  const turned = await read();
  expect(turned.turn).toBe(90);

  // A baked paragraph has no overlay element (the page raster shows it), so
  // tap it with Ganti armed, the way ganti-paragraf.spec.js reopens one. At
  // 90 the origin is the first line's top-left on the paper: the words run
  // DOWN from it and the lines stack to its LEFT.
  const c = await page.evaluate(() => {
    const pg = window.v2.getDoc().pages[0];
    const a = pg.annotations.find((x) => x.type === 'text' && x.block);
    const view = document.querySelector(`.pv-page[data-page-id="${pg.id}"]`);
    view.scrollIntoView({ block: 'center', inline: 'center' });
    const r = view.getBoundingClientRect();
    const k = r.width / view.offsetWidth;
    const lead = a.block.k * a.block.leading;
    return { x: r.left + (a.x - 1.5 * lead) * k, y: r.top + (a.y + 60) * k };
  });
  await armGanti(page);
  await page.mouse.click(c.x, c.y);
  await expect(ed).toHaveCount(1);
  await expect(ed).not.toHaveAttribute('data-turn', /.+/);
  await expect(ed).toHaveText(turned.text);
  // It reopens selected: retype it with one more word at the end.
  await page.keyboard.insertText(`${turned.text} X`);
  await page.keyboard.press('Enter');
  await expect(ed).toHaveCount(0);

  const after = await read();
  expect(after.text.endsWith('X')).toBe(true);
  expect(after.turn, 'the commit keeps the turn').toBe(90);
  expect(Math.abs(after.lines - before.lines), 'the wraps read true').toBeLessThanOrEqual(1);
  if (before.dx !== null) {
    expect(Math.abs(after.dx - turned.dx), 'the anchor did not move by a baseline').toBeLessThan(0.5);
    expect(Math.abs(after.dy - turned.dy)).toBeLessThan(0.5);
  }
});
