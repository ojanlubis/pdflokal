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
import { armGanti, lineBox, centerOf, tapLine } from './helpers/lines.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FX = (name) => path.join(__dirname, 'fixtures', name);
const NASTY = (name) => path.join(__dirname, 'fixtures', 'nasty', name);

async function openDoc(page, fixture) {
  await page.goto('/');
  await page.setInputFiles('#file-input', fixture);
  await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
}

test.describe('ganti teks — happy path (tame fixture)', () => {
  test('tap → prefilled selected editor, type replaces, ONE undo reverts all', async ({ page }) => {
    await openDoc(page, FX('sample-2pages.pdf'));
    await armGanti(page);
    await tapLine(page, { str: 'Test Page 1' });

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
    await tapLine(page, { str: 'Test Page 1' });
    // The tool disarmed the moment the editor opened.
    expect(await page.evaluate(() => window.v2.getTool())).toBe('select');

    await page.keyboard.type('Komit Sekali');
    await page.mouse.click(400, 300); // tap-away = commit, nothing else
    await expect(page.locator('.v2-text-edit')).toHaveCount(0);
    // No armed-tool side effects: exactly the one cover + one text.
    expect(await page.evaluate(() => window.v2.getDoc().pages[0].annotations.length)).toBe(2);
  });

  test('editing is not redefining: NO format bar during the draft NOR at commit (founder ruling)', async ({ page }) => {
    await openDoc(page, FX('sample-2pages.pdf'));
    await armGanti(page);
    await tapLine(page, { str: 'Test Page 1' });
    await expect(page.locator('#format-bar')).not.toHaveClass(/show/);
    // A genuine edit (not a no-op — an unmodified commit is now a CANCEL and
    // creates nothing, see tests/ganti-teks-fidelity.spec.js's bug 1 suite).
    await page.keyboard.type('Test Page 1 Ubah');
    // Commit does NOT auto-select (taste-judge, night 2026-07-19): the flow
    // ends bar-free. A later DELIBERATE tap selects it like any text object —
    // one grammar — and only then may the bar return.
    await page.keyboard.press('Enter');
    await expect(page.locator('#format-bar')).not.toHaveClass(/show/);
    await page.locator('.pv-anno-text').click();
    await expect(page.locator('#format-bar')).toHaveClass(/show/);
  });

  test('Escape backs out and takes the cover with it', async ({ page }) => {
    await openDoc(page, FX('sample-2pages.pdf'));
    await armGanti(page);
    await tapLine(page, { str: 'Test Page 1' });
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => window.v2.getDoc().pages[0].annotations.length)).toBe(0);
  });

  test('armed tool is an on-off switch; QUIET PAGE — no hint layer, the glow dies with disarm', async ({ page }) => {
    await openDoc(page, FX('sample-2pages.pdf'));
    await armGanti(page);
    // QUIET PAGE (founder ruling 2026-07-19, "mending opsi a"): arming paints
    // NOTHING — the hint layer does not exist. The armed affordance is the
    // toast + the hover/press glow.
    await expect(page.locator('.pv-run-hints')).toHaveCount(0);
    const c = centerOf(await lineBox(page, { str: 'Test Page 1' }));
    await page.mouse.move(c.x, c.y);
    await expect(page.locator('.pv-ganti-glow')).toBeVisible();
    await page.click('[data-tool="ganti"]'); // second tap = off
    expect(await page.evaluate(() => window.v2.getTool())).toBe('select');
    await expect(page.locator('.pv-ganti-glow')).toHaveCount(0);
  });
});

test.describe('ganti teks — the nasty fixtures (field-bug pins)', () => {
  test('deck: bold navy title gets a PAPER cover (not an ink slab) + adopts the navy ink', async ({ page }) => {
    await openDoc(page, NASTY('deck-berwarna.pdf'));
    await armGanti(page);
    // Tap the big title line specifically — found by display size through the
    // app's own line index (the hint DOM the old lookup scanned is gone —
    // quiet-page ruling).
    const title = await page.evaluate(async () => {
      const pg = window.v2.getDoc().pages[0];
      const lines = await window.v2.textRuns.getLines(pg.id);
      return lines.find((l) => l.h > 20).str; // display-size line
    });
    await tapLine(page, { str: title });
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

  test('surat: dense small serif text — prefill exact, Tinos clone routed', async ({ page }) => {
    await openDoc(page, NASTY('surat-resmi.pdf'));
    await armGanti(page);
    await tapLine(page, { index: 2 }); // a body line below the letterhead (paint order)
    const text = await page.locator('.v2-text-edit').textContent();
    expect(text.length).toBeGreaterThan(3); // real extracted words, not garbage
    // A genuine edit — an unmodified commit is now a CANCEL and creates no
    // annotation (see tests/ganti-teks-fidelity.spec.js's bug 1 suite); this
    // test is about the font-family MAPPING, not the exact prefill text.
    await page.keyboard.type('Teks pengganti Times');
    // PIN MOVED (font-fidelity tier 1, founder-ratified 2026-07-20): this
    // fixture's body text is unembedded standard-14 /Times-Roman — exactly
    // spec-font-fidelity-engine.md §3's "the /BaseFont is ALL the file
    // knows" case. The old pin was mapRunFont's 'Times-Roman' bucket guess;
    // core/font-decide.js now routes the real /BaseFont to Tinos — same
    // widths (metric-compatible by construction), real embedded outlines.
    // The clone lands asynchronously (prepareDocFont) — wait for it before
    // committing, same beat the doc-font preview tests give the same path.
    await expect.poll(async () => page.evaluate(() => {
      const ed = document.querySelector('.v2-text-edit');
      return ed ? getComputedStyle(ed).fontFamily : '';
    })).toContain('Tinos');
    await page.keyboard.press('Enter');
    const anno = await page.evaluate(() =>
      window.v2.getDoc().pages[0].annotations.find((a) => a.type === 'text'));
    expect(anno.fontFamily).toBe('Tinos'); // metric clone, routed by /BaseFont
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
    // The hint DOM this test used to measure is gone (quiet page) — the pin
    // moves to the SOURCE the hints projected: the line index's display boxes
    // must land inside the rotated page frame.
    const ok = await page.evaluate(async () => {
      const pg = window.v2.getDoc().pages[0];
      const lines = await window.v2.textRuns.getLines(pg.id);
      const view = document.querySelector(`.pv-page[data-page-id="${pg.id}"]`);
      const vw = view.offsetWidth; const vh = view.offsetHeight;
      return lines.length > 0 && lines.every((l) =>
        l.x >= -2 && l.y >= -2 && l.x + l.w <= vw + 2 && l.y + l.h <= vh + 2);
    });
    expect(ok).toBe(true);
  });
});
