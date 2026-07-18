/*
 * Ganti Teks (Edit Teks Asli, Rung A) — the machine QA gate.
 *
 * WHY this file exists (founder + PM, Jul 18 night): the feature shipped and
 * the founder's phone caught three machine-catchable defects in one session —
 * a cover that matched INK on a bold title, an armed tool firing during the
 * commit tap, and a format bar misreading edit-intent. Each is pinned here
 * against the NASTY fixtures (tests/fixtures/nasty/) so no future change can
 * quietly regress them. The tame fixture proves the happy path; the nasty ones
 * prove the field.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FX = (name) => path.join(__dirname, 'fixtures', name);
const NASTY = (name) => path.join(__dirname, 'fixtures', 'nasty', name);

async function openDoc(page, fixture) {
  await page.goto('/');
  await page.setInputFiles('#file-input', fixture);
  await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
}

// Arm Ganti Teks and wait for the run hints (they appear after extraction).
async function armGanti(page) {
  await page.click('[data-tool="ganti"]');
  await expect(page.locator('.pv-run-hints div').first()).toBeVisible();
}

// Tap the Nth hinted run and wait for the prefilled inline editor.
async function tapRun(page, nth = 0) {
  const hint = page.locator('.pv-run-hints div').nth(nth);
  const box = await hint.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('.v2-text-edit')).toBeVisible();
}

test.describe('ganti teks — happy path (tame fixture)', () => {
  test('tap → prefilled selected editor, type replaces, ONE undo reverts all', async ({ page }) => {
    await openDoc(page, FX('sample-2pages.pdf'));
    await armGanti(page);
    await tapRun(page);

    // Prefill is the printed run, pre-selected: typing replaces wholesale.
    await expect(page.locator('.v2-text-edit')).toHaveText('Test Page 1');
    await page.keyboard.type('Surat Baru');
    await page.keyboard.press('Enter');

    const annos = await page.evaluate(() =>
      window.v2.getDoc().pages[0].annotations.map((a) => ({ t: a.type, text: a.text, size: a.fontSize })));
    expect(annos).toHaveLength(2);
    expect(annos[0].t).toBe('whiteout');
    expect(annos[1]).toMatchObject({ t: 'text', text: 'Surat Baru', size: 24 }); // matched pt size

    // One gesture, ONE undo step — cover and text leave together.
    await page.click('#btn-undo');
    expect(await page.evaluate(() => window.v2.getDoc().pages[0].annotations.length)).toBe(0);
  });

  test('the commit tap commits ONLY — no second replace fires (founder ruling)', async ({ page }) => {
    await openDoc(page, FX('sample-2pages.pdf'));
    await armGanti(page);
    await tapRun(page);
    // The tool disarmed the moment the editor opened.
    expect(await page.evaluate(() => window.v2.getTool())).toBe('select');

    await page.keyboard.type('Komit Sekali');
    await page.mouse.click(400, 300); // tap-away = commit, nothing else
    await expect(page.locator('.v2-text-edit')).toHaveCount(0);
    // No armed-tool side effects: exactly the one cover + one text.
    expect(await page.evaluate(() => window.v2.getDoc().pages[0].annotations.length)).toBe(2);
  });

  test('editing is not redefining: NO format bar during the replace draft (founder ruling)', async ({ page }) => {
    await openDoc(page, FX('sample-2pages.pdf'));
    await armGanti(page);
    await tapRun(page);
    await expect(page.locator('#format-bar')).not.toHaveClass(/show/);
    // After commit the object is selected — object-selected grammar brings it back.
    await page.keyboard.press('Enter');
    await expect(page.locator('#format-bar')).toHaveClass(/show/);
  });

  test('Escape backs out and takes the cover with it', async ({ page }) => {
    await openDoc(page, FX('sample-2pages.pdf'));
    await armGanti(page);
    await tapRun(page);
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => window.v2.getDoc().pages[0].annotations.length)).toBe(0);
  });

  test('armed tool is an on-off switch; hints die with it (founder ruling)', async ({ page }) => {
    await openDoc(page, FX('sample-2pages.pdf'));
    await armGanti(page);
    await page.click('[data-tool="ganti"]'); // second tap = off
    expect(await page.evaluate(() => window.v2.getTool())).toBe('select');
    await expect(page.locator('.pv-run-hints')).toHaveCount(0);
  });
});

test.describe('ganti teks — the nasty fixtures (field-bug pins)', () => {
  test('deck: bold navy title gets a PAPER cover (not an ink slab) + adopts the navy ink', async ({ page }) => {
    await openDoc(page, NASTY('deck-berwarna.pdf'));
    await armGanti(page);
    // Tap the big title run specifically (the one whose text starts with "Optimalisasi").
    const idx = await page.evaluate(() => {
      const hints = [...document.querySelectorAll('.pv-run-hints div')];
      return hints.findIndex((h) => parseFloat(h.style.height) > 20); // display-size run
    });
    await tapRun(page, idx);
    // The async color sampling lands on the open editor — wait for it.
    await page.waitForTimeout(400);

    const state = await page.evaluate(() => {
      const cover = window.v2.getDoc().pages[0].annotations.find((a) => a.type === 'whiteout');
      const ed = document.querySelector('.v2-text-edit');
      return { cover: cover.color, ink: getComputedStyle(ed).color };
    });
    // Paper, not ink: the founder's dark-slab bug (Jul 18) stays dead.
    const lum = (hex) => {
      const n = parseInt(hex.slice(1), 16);
      return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
    };
    expect(lum(state.cover)).toBeGreaterThan(200);
    // Ink adopted: navy — blue clearly above red for this title.
    const m = state.ink.match(/rgb\((\d+), (\d+), (\d+)\)/);
    expect(Number(m[3])).toBeGreaterThan(Number(m[1]));
  });

  test('surat: dense small serif text — prefill exact, Times mapped', async ({ page }) => {
    await openDoc(page, NASTY('surat-resmi.pdf'));
    await armGanti(page);
    await tapRun(page, 2); // a body run below the letterhead
    const text = await page.locator('.v2-text-edit').textContent();
    expect(text.length).toBeGreaterThan(3); // real extracted words, not garbage
    await page.keyboard.press('Enter');
    const anno = await page.evaluate(() =>
      window.v2.getDoc().pages[0].annotations.find((a) => a.type === 'text'));
    expect(anno.fontFamily).toBe('Times-Roman'); // metric-twin family guess
  });

  test('scan: the router declines honestly — no cover, no editor, the toast says why', async ({ page }) => {
    await openDoc(page, NASTY('mirip-scan.pdf'));
    await page.click('[data-tool="ganti"]');
    await page.click('.pv-page >> nth=0', { position: { x: 200, y: 300 } });
    await expect(page.locator('#toast')).toContainText('scan/foto');
    expect(await page.evaluate(() => window.v2.getDoc().pages[0].annotations.length)).toBe(0);
    await expect(page.locator('.v2-text-edit')).toHaveCount(0);
  });

  test('rotated page (/Rotate 90): runs land inside the displayed frame', async ({ page }) => {
    await openDoc(page, NASTY('halaman-miring.pdf'));
    await armGanti(page);
    const ok = await page.evaluate(() => {
      const view = document.querySelector('.pv-page');
      const vw = view.offsetWidth; const vh = view.offsetHeight;
      return [...document.querySelectorAll('.pv-run-hints div')].every((h) => {
        const x = parseFloat(h.style.left); const y = parseFloat(h.style.top);
        const w = parseFloat(h.style.width); const hh = parseFloat(h.style.height);
        return x >= -2 && y >= -2 && x + w <= vw + 2 && y + hh <= vh + 2;
      });
    });
    expect(ok).toBe(true);
  });
});
