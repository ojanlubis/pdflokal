/*
 * Ganti Teks — Rung D: tap a paragraph, edit the whole paragraph.
 * ============================================================================
 * His call (seat decisions.md 2026-10-01, malam, final): "if paragraph, edit
 * the whole paragraph". His principle (same day): what the user sees while
 * typing is what the file contains. Across a paragraph that includes the LINE
 * BREAKS, so this spec compares the breaks the editor PAINTED with the breaks
 * the downloaded file HOLDS.
 *
 * The editor's breaks are read here by this spec's OWN Range walk, not by the
 * product's readEditorLines (js/v2/block-editor.js): the product commits the
 * breaks that function reads, so using it here would be the verified checking
 * itself. The file's breaks are read by pdf.js (the viewer the user has) from
 * the bytes the real Unduh button produced.
 *
 * Fixture: tests/fixtures/nasty/paragraf-badan.pdf (scripts/gen-fixture-
 * paragraf-badan.mjs) — a justified 4-line paragraph in Montserrat embedded
 * whole, at x=72, 11pt on 15pt leading, first baseline y=740.
 *
 * RED ON REVERT: on main before this change (fa8e329) the tap opens ONE line
 * (the prefill is "lingkungan kantor, ..."), so the first assertion fails;
 * the file's baselines/breaks assertions fail with it.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { armGanti, tapLine, marginPoint } from './helpers/lines.js';
import { expectFirstPage } from './helpers/render.js';
import { downloadBytes } from './helpers/download-bytes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NASTY = (name) => path.join(__dirname, 'fixtures', 'nasty', name);

const PARAGRAPH = 'Sehubungan dengan pelaksanaan kegiatan kerja bakti di lingkungan kantor, seluruh pegawai diminta '
  + 'hadir pada hari Sabtu pagi dengan membawa peralatan kebersihan masing masing sesuai pembagian tugas.';
const NEW = 'Seluruh pegawai kantor diminta hadir pada kerja bakti hari Sabtu pagi pukul tujuh dengan membawa '
  + 'peralatan kebersihan sendiri sesuai pembagian tugas dari panitia, dan seluruh kegiatan diharapkan '
  + 'selesai sebelum tengah hari supaya semua bisa beristirahat.';

// The lines the editor is painting: characters grouped by the top of their
// own box, spaces attached to the line they follow. Independent of the product.
async function paintedLines(page) {
  return page.evaluate(() => {
    const ed = document.querySelector('.v2-text-edit');
    const node = ed.firstChild;
    const rows = [];
    for (let i = 0; i < node.data.length; i += 1) {
      const ch = node.data[i];
      const r = document.createRange();
      r.setStart(node, i);
      r.setEnd(node, i + 1);
      const rect = r.getClientRects()[0];
      if (ch === ' ' || !rect) { if (rows.length) rows[rows.length - 1].s += ch; continue; }
      const row = rows.find((x) => Math.abs(x.top - rect.top) < rect.height / 2);
      if (row) row.s += ch;
      else rows.push({ top: rect.top, s: ch });
    }
    return rows.sort((a, b) => a.top - b.top).map((x) => x.s.trim());
  });
}

async function openFixture(page, name) {
  await page.goto('/');
  await page.setInputFiles('#file-input', NASTY(name));
  await expectFirstPage(page);
  await armGanti(page);
}

test('a tapped paragraph is edited whole, re-wraps in its own box, and the file holds the painted lines', async ({ page }) => {
  await openFixture(page, 'paragraf-badan.pdf');
  // Tap the SECOND line, mid-paragraph.
  await tapLine(page, { str: 'lingkungan kantor' });
  const ed = page.locator('.v2-text-edit');
  await expect(ed, 'the whole paragraph opens, not the tapped line').toHaveText(PARAGRAPH);
  await expect(ed).toHaveAttribute('data-block', 'justify');
  // The editor paints in the document's own font (one decided face).
  await expect(ed).toHaveAttribute('data-font-path', 'native', { timeout: 10_000 });

  // The untouched prefill re-wraps exactly as the document did: same font,
  // same box.
  expect(await paintedLines(page)).toEqual([
    'Sehubungan dengan pelaksanaan kegiatan kerja bakti di',
    'lingkungan kantor, seluruh pegawai diminta hadir pada hari',
    'Sabtu pagi dengan membawa peralatan kebersihan masing',
    'masing sesuai pembagian tugas.',
  ]);

  // Type over it (the prefill is selected, as for a line). The caret is hidden
  // so the pixel comparison below sees only letters.
  await page.addStyleTag({ content: '.v2-text-edit { caret-color: transparent !important; }' });
  await page.keyboard.type(NEW);
  await expect(ed).toHaveText(NEW);
  const painted = await paintedLines(page);
  // One line more than the original: the box grew down into the blank line
  // under it, width unchanged (two more would reach the next paragraph).
  expect(painted.length, `painted ${JSON.stringify(painted)}`).toBe(5);
  expect(painted.join(' ')).toBe(NEW);
  // pre-wrap keeps the user's real spaces: nothing for the stamp to mis-measure.
  expect(await ed.evaluate((el) => el.textContent.includes(' '))).toBe(false);

  // The editor's pixels, to compare with the baked page's below.
  const clip = await ed.boundingBox();
  const seen = await page.screenshot({ clip });

  await page.keyboard.press('Enter');
  await expect(ed).toHaveCount(0);
  // Grown into the blank line only: nothing below was reached, nothing to say.
  // (#toast keeps its last text when hidden; `show` is what shows it. Read
  // once, now: a retrying negative assertion would pass when it times out.)
  expect(await page.locator('#toast').getAttribute('class')).not.toMatch(/show/);
  const anno = await page.evaluate(() => window.v2.getDoc().pages[0].annotations.find((a) => a.type === 'text'));
  // The page re-renders from the edited FILE bytes (the commit-time bake); once
  // it has, the replacement's overlay is suppressed and the raster is the file.
  await page.waitForFunction((id) => window.v2.getDoc().pages[0].editApplied?.has(id), anno.id, { timeout: 10_000 });
  await expect(page.locator(`[data-anno-id="${anno.id}"]`)).toHaveCount(0);
  const baked = await page.screenshot({ clip });
  // Same lines at the same heights: the rows of ink in the editor and in the
  // rendered file line up (a shift would be the editor sitting off the
  // paragraph's real baselines). Compared as row-ink profiles, decoded by the
  // browser.
  const shift = await page.evaluate(async ([a, b]) => {
    const profile = async (b64) => {
      const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const rows = new Array(c.height).fill(0);
      for (let y = 0; y < c.height; y += 1) {
        for (let x = 0; x < c.width; x += 1) {
          const i = (y * c.width + x) * 4;
          if (d[i] + d[i + 1] + d[i + 2] < 3 * 128) rows[y] += 1;
        }
      }
      return rows;
    };
    const [pa, pb] = [await profile(a), await profile(b)];
    let best = { s: 0, cost: Infinity };
    for (let s = -30; s <= 30; s += 1) {
      let cost = 0;
      for (let y = 0; y < pa.length; y += 1) cost += Math.abs(pa[y] - (pb[y + s] ?? 0));
      if (cost < best.cost) best = { s, cost };
    }
    return best.s;
  }, [seen.toString('base64'), baked.toString('base64')]);
  expect(Math.abs(shift), `the editor's lines sit ${shift}px off the file's`).toBeLessThanOrEqual(1);
  expect(anno.text).toBe(NEW);
  expect(anno.block.lines.map((l) => l.text)).toEqual(painted);

  // The real download.
  await page.click('#btn-download');
  await expect(page.locator('#dl-sheet')).toBeVisible();
  const { buf } = await downloadBytes(page, () => page.click('#ds-cta'));
  expect(buf.subarray(0, 5).toString()).toBe('%PDF-');

  const file = await page.evaluate(async (arr) => {
    const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(arr) }).promise;
    const pg = await doc.getPage(1);
    const tc = await pg.getTextContent();
    const byY = new Map();
    for (const it of tc.items) {
      if (!it.str) continue;
      const y = Math.round(it.transform[5] * 100) / 100;
      if (!byY.has(y)) byY.set(y, []);
      byY.get(y).push(it);
    }
    return [...byY.entries()].sort((a, b) => b[0] - a[0]).map(([y, items]) => {
      items.sort((a, b) => a.transform[4] - b.transform[4]);
      const ink = items.filter((it) => it.str.trim());
      return {
        y,
        text: items.map((it) => it.str).join('').replace(/\s+/g, ' ').trim(),
        x0: Math.min(...ink.map((it) => it.transform[4])),
        x1: Math.max(...ink.map((it) => it.transform[4] + it.width)),
      };
    }).filter((l) => l.text);
  }, Array.from(buf));

  const body = file.filter((l) => l.y <= 740.5 && l.y >= 740 - (painted.length - 1) * 15 - 0.5);
  // Same breaks, same order: what the editor painted is what the file holds.
  expect(body.map((l) => l.text)).toEqual(painted);
  // At the paragraph's own baselines (15pt leading from y=740), inside its box.
  body.forEach((l, i) => {
    expect(Math.abs(l.y - (740 - i * 15)), `line ${i} baseline ${l.y}`).toBeLessThan(0.05);
    expect(Math.abs(l.x0 - 72), `line ${i} starts at ${l.x0}`).toBeLessThan(0.05);
    expect(l.x1, `line ${i} ends at ${l.x1}`).toBeLessThanOrEqual(72 + anno.block.width + 0.05);
  });
  // Justified: every line but the last ends on the box's right edge.
  body.slice(0, -1).forEach((l) => expect(Math.abs(l.x1 - (72 + anno.block.width))).toBeLessThan(0.1));
  // The old paragraph is gone from the file; its neighbours are not.
  const all = file.map((l) => l.text).join('\n');
  for (const gone of ['Sehubungan', 'lingkungan kantor', 'masing sesuai']) expect(all).not.toContain(gone);
  expect(all).toContain('Pemberitahuan Kegiatan');
  expect(all).toContain('Kegiatan dimulai pukul tujuh');
});

test('a block that cannot be proven (a list) falls back to the per-line edit', async ({ page }) => {
  // surat-paragraf.pdf's three "- ..." items are a paragraph-detect.js block
  // (one run per line, no gutter to see); core/block-edit.js declines it as a
  // list, so the tap edits ONE line, exactly as before Rung D.
  await openFixture(page, 'surat-paragraf.pdf');
  await tapLine(page, { str: 'Mengisi daftar hadir' });
  const ed = page.locator('.v2-text-edit');
  await expect(ed).toHaveText('- Mengisi daftar hadir');
  await expect(ed).not.toHaveAttribute('data-block', /.*/);
});

test('a committed paragraph reopens AS the paragraph, with its own text', async ({ page }) => {
  await openFixture(page, 'paragraf-badan.pdf');
  await tapLine(page, { str: 'lingkungan kantor' });
  const ed = page.locator('.v2-text-edit');
  await expect(ed).toHaveAttribute('data-font-path', 'native', { timeout: 10_000 });
  await page.keyboard.type(NEW);
  await page.keyboard.press('Enter');
  await expect(ed).toHaveCount(0);
  const anno = await page.evaluate(() => window.v2.getDoc().pages[0].annotations.find((a) => a.type === 'text'));
  await page.waitForFunction((id) => window.v2.getDoc().pages[0].editApplied?.has(id), anno.id, { timeout: 10_000 });

  // Tap the committed paragraph's FIFTH line — below the original box, where
  // only the grown paragraph paints.
  await armGanti(page);
  const pt = await page.evaluate((a) => {
    const pg = window.v2.getDoc().pages[0];
    const view = document.querySelector(`.pv-page[data-page-id="${pg.id}"]`);
    const r = view.getBoundingClientRect();
    const s = r.width / view.offsetWidth;
    const lead = a.block.k * a.block.leading;
    return { x: r.left + (a.x + 40) * s, y: r.top + (a.y + 4.5 * lead) * s };
  }, anno);
  await page.mouse.click(pt.x, pt.y);
  await expect(ed).toHaveText(NEW);
  await expect(ed).toHaveAttribute('data-block', 'justify');
  // Escape backs out: the edit stays exactly as committed.
  await page.keyboard.press('Escape');
  await expect(ed).toHaveCount(0);
  const after = await page.evaluate(() => window.v2.getDoc().pages[0].annotations.filter((a) => a.type === 'text'));
  expect(after.length).toBe(1);
  expect(after[0].text).toBe(NEW);
});

test('a keystroke that would push the paragraph off the page is undone and said', async ({ page }) => {
  await openFixture(page, 'paragraf-badan.pdf');
  await tapLine(page, { str: 'lingkungan kantor' });
  const ed = page.locator('.v2-text-edit');
  await expect(ed).toHaveText(PARAGRAPH);
  // One paste far longer than the page can hold under this paragraph.
  await page.keyboard.insertText(`${NEW} `.repeat(40));
  // Refused whole: the editor holds what it held before the paste.
  await expect(ed).toHaveText(PARAGRAPH);
  await expect(page.locator('#toast')).toHaveClass(/show/);
  await expect(page.locator('#toast')).toHaveText('Teksnya udah sampai ujung halaman');
  const bottom = await ed.evaluate((el) => el.offsetTop + el.offsetHeight);
  const pageH = await page.evaluate(() => window.v2.getDoc().pages[0].height);
  expect(bottom).toBeLessThanOrEqual(pageH);
});

test('a paragraph that grows into the text below says so once, and keeps its width', async ({ page }) => {
  await openFixture(page, 'paragraf-badan.pdf');
  await tapLine(page, { str: 'lingkungan kantor' });
  const ed = page.locator('.v2-text-edit');
  await expect(ed).toHaveText(PARAGRAPH);
  await page.keyboard.insertText(`${NEW} ${NEW}`);
  await page.keyboard.press('Enter');
  await expect(ed).toHaveCount(0);
  await expect(page.locator('#toast')).toHaveClass(/show/);
  await expect(page.locator('#toast')).toHaveText('Teksnya jadi lebih panjang dari paragraf asli');
  const anno = await page.evaluate(() => window.v2.getDoc().pages[0].annotations.find((a) => a.type === 'text'));
  expect(anno.block.lines.length).toBeGreaterThan(6);
  expect(anno.block.width).toBeLessThan(338.2); // the box's own width, not grown sideways
});

test('tap a paragraph, change nothing, tap away: nothing happens (no cover, no replacement)', async ({ page }) => {
  // The 2026-07-19 bug class, one level up: the commit compares the text READ
  // BACK off the painted lines with the prefill. If that read did not
  // round-trip the prefill exactly, an untouched paragraph would be re-written.
  await openFixture(page, 'paragraf-badan.pdf');
  await tapLine(page, { str: 'lingkungan kantor' });
  const ed = page.locator('.v2-text-edit');
  await expect(ed).toHaveAttribute('data-font-path', 'native', { timeout: 10_000 });
  const pt = await marginPoint(page);
  await page.mouse.click(pt.x, pt.y);
  await expect(ed).toHaveCount(0);
  const annos = await page.evaluate(() => window.v2.getDoc().pages[0].annotations.length);
  expect(annos).toBe(0);
});
