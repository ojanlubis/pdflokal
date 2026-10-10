/*
 * A BAKE THAT LANDS WHILE THE EDITOR IS OPEN NEVER TEARS THE EDITOR OUT.
 * ============================================================================
 * Every bake ends in syncPage, and syncOverlay empties the page overlay. Hapus
 * a printed line, tap Edit on the next line before that bake lands, and the
 * open editor vanished mid-word: the typed words were gone, and the following
 * keystrokes went to the tool keys (an "s" opened the signature sheet). This
 * was the nightly hapus-then-edit-paragraph flake: real, timing-dependent.
 * Made deterministic by holding the rasterizer until the editor is open.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { armGanti, tapLine, lineBox, centerOf } from './helpers/lines.js';
import { expectFirstPage } from './helpers/render.js';
import { armHapus, tapAt, annos } from './helpers/original-delete.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'nasty', 'paragraf-badan.pdf');

test('Hapus, then type in Edit while the Hapus bake lands: the editor and its words survive', async ({ page }) => {
  test.setTimeout(60000);
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expectFirstPage(page);
  // Hold every rasterize (the bake's last step) until we say so.
  await page.evaluate(() => {
    const r = window.v2.getRasterizer();
    const orig = r.rasterize.bind(r);
    window.__held = 0;
    window.__gate = new Promise((res) => { window.__release = res; });
    r.rasterize = async (...args) => { window.__held += 1; await window.__gate; return orig(...args); };
  });

  await armHapus(page);
  await tapAt(page, 'mouse', centerOf(await lineBox(page, { str: 'masing sesuai' })));
  await expect.poll(async () => (await annos(page)).length).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__held), { message: 'known-positive: the Hapus bake must be held' }).toBeGreaterThan(0);

  await armGanti(page);
  await tapLine(page, { str: 'lingkungan kantor' });
  const ed = page.locator('.v2-text-edit');
  await expect(ed).toHaveCount(1);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.type(' satu');
  await page.evaluate(() => window.__release()); // the bake lands NOW, editor open
  await page.waitForTimeout(800);
  await page.keyboard.type(' sesi');

  await expect(ed, 'the bake tore the open editor out').toHaveCount(1);
  await expect(page.locator('#sig-modal'), 'keystrokes fell through to the tool keys').not.toHaveAttribute('open', '');
  expect(await ed.evaluate((el) => el.textContent)).toMatch(/ satu sesi$/);
});
