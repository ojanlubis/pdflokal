/*
 * A line Hapus deleted must not come back through Edit's paragraph prefill.
 * ============================================================================
 * THE BUG (found 2026-10-02, the day Hapus on the PDF's own text shipped): the
 * line index (textRuns, js/v2/text-runs.js) reads the PRISTINE source, so after
 * Hapus cut a line of a paragraph the index still held it, paragraph-detect.js
 * still counted it in the block, and Edit's paragraph edit (Rung D) prefilled
 * the deleted words. Committing that edit wrote them back into the file. The
 * downloaded file was right right up to that commit.
 *
 * THE PROPERTY (the edit principle): what Edit shows is what the page shows.
 * Each case asserts the three things a person can see or hold:
 *   1. the PREFILL of the editor carries none of the deleted words
 *   2. the FILE after committing the edit carries none of them either
 *   3. the lines that were NOT deleted are still editable (the paragraph, or
 *      the tapped line when the hole broke the paragraph)
 *
 * Fixture: tests/fixtures/nasty/paragraf-badan.pdf, a justified 4-line
 * paragraph (see ganti-paragraf.spec.js for its geometry). Its lines:
 *   1 "Sehubungan dengan pelaksanaan kegiatan kerja bakti di"
 *   2 "lingkungan kantor, seluruh pegawai diminta hadir pada hari"
 *   3 "Sabtu pagi dengan membawa peralatan kebersihan masing"
 *   4 "masing sesuai pembagian tugas."
 *
 * RED ON REVERT: on origin/main (4447542) the prefill is the full four-line
 * paragraph in every case below.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { armGanti, tapLine, lineBox, centerOf } from './helpers/lines.js';
import { expectFirstPage } from './helpers/render.js';
import { armHapus, tapAt, annos, unduh, countIn, tool } from './helpers/original-delete.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'nasty', 'paragraf-badan.pdf');

const L1 = 'Sehubungan dengan pelaksanaan kegiatan kerja bakti di';
const L2 = 'lingkungan kantor, seluruh pegawai diminta hadir pada hari';
const L3 = 'Sabtu pagi dengan membawa peralatan kebersihan masing';
const L4 = 'masing sesuai pembagian tugas.';

async function open(page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expectFirstPage(page);
}

// Hapus one printed line and wait until the page really is baked without it.
async function hapusLine(page, str) {
  await armHapus(page);
  await tapAt(page, 'mouse', centerOf(await lineBox(page, { str })));
  await expect.poll(async () => (await annos(page)).length).toBe(1);
  await page.waitForFunction(() => window.v2.getDoc().pages[0].editApplied?.size > 0, null, { timeout: 15000 });
  expect(await tool(page), 'Hapus stays armed after a delete').toBe('delete');
}

const prefill = (page) => page.locator('.v2-text-edit').evaluate((el) => el.textContent);

// KEEP what the editor showed and add a few words at its end: the person who
// edits a sentence of a paragraph commits the REST of it unchanged, and that
// rest is exactly what must not carry a deleted line (typing over the whole
// prefill would hide the bug, the file would hold only the new words).
async function commit(page, addition) {
  const ed = page.locator('.v2-text-edit');
  await page.keyboard.press('ArrowRight') // collapses the selected prefill to its end;
  await page.keyboard.type(addition);
  await page.keyboard.press('Enter');
  await expect(ed).toHaveCount(0);
}

test('Hapus the LAST line, then Edit the paragraph: the prefill is the three lines the page shows, and the file stays without the fourth', async ({ page }) => {
  test.setTimeout(60000);
  await open(page);
  await hapusLine(page, 'masing sesuai');

  await armGanti(page);
  await tapLine(page, { str: 'lingkungan kantor' });
  const ed = page.locator('.v2-text-edit');
  const shown = await prefill(page);
  expect(shown, 'the deleted line came back in the prefill').not.toContain('sesuai pembagian');
  expect(shown).not.toContain('tugas');
  // The paragraph is still edited whole, minus the line that is gone.
  await expect(ed).toHaveAttribute('data-block', 'justify');
  expect(shown).toBe(`${L1} ${L2} ${L3}`);

  await commit(page, ' Terima kasih.');
  const file = await unduh(page);
  // Single words: the file wraps the paragraph its own way, so a phrase can
  // straddle two of its lines.
  for (const gone of ['sesuai', 'pembagian', 'tugas']) {
    expect(countIn(file, gone), `"${gone}" (deleted line) is back in the exported file`).toBe(0);
  }
  expect(countIn(file, 'Terima kasih.'), 'the edit itself did not land').toBe(1);
  expect(countIn(file, 'Sabtu'), 'the kept lines went missing').toBe(1);
  expect(countIn(file, 'Pemberitahuan Kegiatan'), 'a neighbour went missing').toBe(1);
});

test('Hapus a MIDDLE line, then Edit a neighbour: the hole breaks the paragraph, so the edit is that one line and the deleted words stay out', async ({ page }) => {
  test.setTimeout(60000);
  await open(page);
  await hapusLine(page, 'lingkungan kantor');

  await armGanti(page);
  await tapLine(page, { str: 'Sehubungan' });
  const shown = await prefill(page);
  expect(shown, 'the deleted line came back in the prefill').not.toContain('lingkungan kantor');
  expect(shown).not.toContain('hadir pada hari');
  expect(shown).toBe(L1);

  await commit(page, ' Terima kasih.');
  const file = await unduh(page);
  for (const gone of ['lingkungan', 'pegawai', 'diminta']) {
    expect(countIn(file, gone), `"${gone}" (deleted line) is back in the exported file`).toBe(0);
  }
  expect(countIn(file, 'Terima kasih.'), 'the edit itself did not land').toBe(1);
  expect(countIn(file, 'Sehubungan')).toBe(1);
  // The lines nobody touched are still there.
  expect(countIn(file, 'Sabtu')).toBe(1);
  expect(countIn(file, 'sesuai')).toBe(1);
});
