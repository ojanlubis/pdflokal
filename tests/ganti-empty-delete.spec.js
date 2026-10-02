/*
 * Edit (Ganti Teks): clearing a line's words and committing DELETES the line
 * (founder ruling 2026-10-02, with Hapus on the PDF's own text).
 * ============================================================================
 * Today (before this): the empty commit was the BACKOUT. onCancel took the cover
 * back and the original stayed, so a person who deleted the text watched it not
 * be deleted. Now the cover stays and no replacement is written: a pure deletion,
 * the same pair Hapus makes.
 *
 * The three outcomes of leaving the editor must stay distinct, so each is pinned:
 *   clear + commit  -> the line is deleted        (screen + file; undo restores)
 *   Escape          -> backed out, nothing changes (Escape used to share the empty
 *                      commit with "cleared"; it now says so with a flag)
 *   words unchanged -> a no-op
 * and clearing a whole PARAGRAPH deletes the paragraph and nothing else.
 */
import { test, expect } from '@playwright/test';
import { armGanti, tapLine, lineBox, centerOf } from './helpers/lines.js';
import {
  NASTY, LINE, openDoc, paperPoint, annos, crop, inkOf, unduh, countIn, railHapus,
} from './helpers/original-delete.js';

test.describe('Edit (Ganti Teks): clear the line and commit', () => {
  test('Backspace + Enter DELETES the line (screen + file); undo brings it back', async ({ page }) => {
    test.setTimeout(60000);
    await openDoc(page);
    const before = await crop(page, { str: LINE, nth: 1 });
    await armGanti(page);
    await tapLine(page, { str: LINE, nth: 1 });
    await page.keyboard.press('Backspace'); // the prefill arrives selected
    await expect(page.locator('.v2-text-edit')).toHaveText('');
    await page.keyboard.press('Enter');
    await expect(page.locator('.v2-text-edit')).toHaveCount(0);

    expect(await annos(page)).toEqual([{ t: 'whiteout', text: undefined, cut: true, ocr: false }]);
    await expect.poll(async () => inkOf(page, (await crop(page, { str: LINE, nth: 1 })).buf), { timeout: 15000 }).toBe(0);
    expect(countIn(await unduh(page), LINE)).toBe(2);

    const evs = await railHapus(page);
    expect(evs.filter((e) => e.event === 'ganti_commit').map((e) => e.props.outcome)).toEqual(['delete']);

    await page.click('#btn-undo');
    expect(await annos(page)).toEqual([]);
    await expect.poll(async () => (await crop(page, { str: LINE, nth: 1 })).buf, { timeout: 15000 }).toBe(before.buf);
  });

  test('Escape still BACKS OUT: the cleared line is kept, nothing deleted', async ({ page }) => {
    await openDoc(page);
    await armGanti(page);
    await tapLine(page, { str: LINE, nth: 1 });
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Escape');
    await expect(page.locator('.v2-text-edit')).toHaveCount(0);
    expect(await annos(page)).toEqual([]);
    const evs = await railHapus(page);
    expect(evs.filter((e) => e.event === 'ganti_commit').map((e) => e.props.outcome)).toEqual(['cancel']);
  });

  test('tap-away with the words UNCHANGED is still a no-op (no cover, no deletion)', async ({ page }) => {
    await openDoc(page);
    await armGanti(page);
    await tapLine(page, { str: LINE, nth: 1 });
    const pt = await paperPoint(page);
    await page.mouse.click(pt.x, pt.y);
    await expect(page.locator('.v2-text-edit')).toHaveCount(0);
    expect(await annos(page)).toEqual([]);
  });
});


test.describe('Edit: clearing a paragraph', () => {
  test('clearing a whole PARAGRAPH in Edit and committing deletes the paragraph (and only it)', async ({ page }) => {
    test.setTimeout(60000);
    await openDoc(page, NASTY('paragraf-badan.pdf'));
    const lines = await page.evaluate(async () => {
      const pg = window.v2.getDoc().pages[0];
      return (await window.v2.textRuns.getLines(pg.id)).map((l) => ({ s: l.str, b: l.blockId }));
    });
    const first = lines.findIndex((l) => l.b === 0);
    expect(first).toBeGreaterThan(-1);
    await armGanti(page);
    const c = centerOf(await lineBox(page, { index: first }));
    await page.mouse.click(c.x, c.y);
    await expect(page.locator('.v2-text-edit')).toBeVisible();
    expect((await page.locator('.v2-text-edit').textContent()).length, 'the tap did not open the whole paragraph').toBeGreaterThan(150);
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Enter');
    await expect(page.locator('.v2-text-edit')).toHaveCount(0);
    expect(await annos(page)).toEqual([{ t: 'whiteout', text: undefined, cut: true, ocr: false }]);
    const text = (await unduh(page)).pages[0].text;
    for (const l of lines) {
      const probe = l.s.trim().slice(0, 20);
      if (!probe) continue;
      if (l.b === 0) expect(text, `paragraph line survived: ${probe}`).not.toContain(probe);
      else expect(text, `a line outside the paragraph went too: ${probe}`).toContain(probe);
    }
  });
});
