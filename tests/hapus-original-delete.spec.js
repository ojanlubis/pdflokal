/*
 * Hapus on the PDF's OWN text (founder ruling 2026-10-02).
 * ============================================================================
 * "itu naturally yang mereka mau, let's facilitate it": with Hapus armed, a tap
 * on a printed line DELETES it. Before this, the tap fell through interaction.js
 * to the empty-page branch and did nothing, with delete-mode still lit; the rail
 * read that as 17% (phone) / 24% (desktop) of Hapus sessions completing.
 *
 * THE PROPERTY, in the founder's edit principle's own terms: what the person SAW
 * is what the file HOLDS. So each case asserts all three of
 *   1. the SCREEN  : pixels of that line's box changed, neighbours' did not
 *   2. the FILE    : the real Unduh bytes, read by pdf.js, no longer carry it
 *   3. UNDO        : screen and file both come back
 * and the model assertion (a cover, no text) is only the explanation.
 *
 * Fixture: undangan-cid.pdf draws "Rapat Anggota Tahunan 2026" THREE times in a
 * CID/Identity-H font, so a string match could not prove WHICH line died: only
 * the pixels of that line's box and a count going 3 -> 2 can.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { armGanti, tapLine, lineBox, centerOf } from './helpers/lines.js';
import { inspectPdf } from './helpers/download-bytes.js';
import {
  NASTY, UNDANGAN, LINE, openDoc, paperPoint, tool, annos, armHapus, tapAt, crop, inkOf, unduh, countIn,
  railHapus, hapusActions,
} from './helpers/original-delete.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(process.env.HAPUS_SHOTS || path.join(__dirname, '..', 'review-shots'));

for (const pointer of ['mouse', 'touch']) {
  test.describe(`Hapus armed, tap a printed line (${pointer})`, () => {
    test.use({ hasTouch: pointer === 'touch' });

    test('the line goes from the screen and the FILE, its neighbours stay, undo brings it back', async ({ page }) => {
      test.setTimeout(60000);
      await openDoc(page);
      // Baseline: the source itself carries the line three times. Without this a
      // count of 2 below could be the fixture's doing.
      expect(countIn(await inspectPdf(page, fs.readFileSync(UNDANGAN)), LINE)).toBe(3);

      const before = [await crop(page, { str: LINE, nth: 0 }), await crop(page, { str: LINE, nth: 1 }), await crop(page, { str: LINE, nth: 2 })];
      expect(await inkOf(page, before[1].buf), 'the fixture line has no ink in its box, so the crop proves nothing').toBeGreaterThan(30);
      await armHapus(page);

      // Tap the MIDDLE repeat.
      const mid = centerOf(await lineBox(page, { str: LINE, nth: 1 }));
      await tapAt(page, pointer, mid);

      // 1. SCREEN. Poll: the cover shows at once and the bake swaps the page raster
      // a moment later; what must end up true is that this box holds no ink.
      await expect.poll(async () => inkOf(page, (await crop(page, { str: LINE, nth: 1 })).buf), { timeout: 15000 }).toBe(0);
      expect((await crop(page, { str: LINE, nth: 0 })).buf, 'the line above changed').toBe(before[0].buf);
      expect((await crop(page, { str: LINE, nth: 2 })).buf, 'the line below changed').toBe(before[2].buf);
      expect(await tool(page), 'Hapus must stay armed after a delete').toBe('delete');
      // The model, as explanation: ONE cover with surgery intent, and no text over it.
      expect(await annos(page)).toEqual([{ t: 'whiteout', text: undefined, cut: true, ocr: false }]);

      // 2. FILE, through the real Unduh sheet.
      const after = await unduh(page);
      expect(countIn(after, LINE), 'the deleted line is still in the exported file').toBe(2);

      // 3. UNDO: one step. Model, screen and file all come back.
      await page.click('#btn-undo');
      expect(await annos(page)).toEqual([]);
      await expect.poll(async () => (await crop(page, { str: LINE, nth: 1 })).buf, { timeout: 15000 }).toBe(before[1].buf);
      expect(countIn(await unduh(page), LINE)).toBe(3);
    });

    test('a second tap on the deleted spot does nothing (no second cover), and a tap on paper is the one miss', async ({ page }) => {
      test.setTimeout(60000);
      await openDoc(page);
      await armHapus(page);
      await tapAt(page, pointer, centerOf(await lineBox(page, { str: LINE, nth: 1 })));
      await expect.poll(async () => (await annos(page)).length).toBe(1);
      await expect.poll(async () => inkOf(page, (await crop(page, { str: LINE, nth: 1 })).buf), { timeout: 15000 }).toBe(0);

      // Same spot again: nothing printed there any more.
      await tapAt(page, pointer, centerOf(await lineBox(page, { str: LINE, nth: 1 })));
      // Real margin paper.
      await tapAt(page, pointer, await paperPoint(page));
      await expect.poll(async () => hapusActions(await railHapus(page)).filter((a) => a === 'original_miss').length).toBe(1);
      expect(await annos(page)).toHaveLength(1);
      expect(await tool(page)).toBe('delete');
      // arm, the one delete, the one miss (paper). The second tap on the deleted line
      // is NOT a miss (a printed line was there) and not a second delete; and nothing
      // is 'delete', which means an object of ours.
      expect(hapusActions(await railHapus(page))).toEqual(['arm', 'original_delete', 'original_miss']);
    });
  });
}

test.describe('Hapus armed: what a tap must NOT do', () => {
  test('a DOUBLE-tap deletes once: the second tap must not take the first one back', async ({ page }) => {
    test.setTimeout(60000);
    await openDoc(page);
    await armHapus(page);
    const c = centerOf(await lineBox(page, { str: LINE, nth: 1 }));
    await page.mouse.dblclick(c.x, c.y);
    await expect.poll(async () => inkOf(page, (await crop(page, { str: LINE, nth: 1 })).buf), { timeout: 15000 }).toBe(0);
    // The first tap's cover is a real DOM element until the bake lands; the second
    // tap used to hit IT and delete it, un-deleting the line and disarming Hapus.
    expect(await annos(page)).toEqual([{ t: 'whiteout', text: undefined, cut: true, ocr: false }]);
    expect(await tool(page)).toBe('delete');
    expect(countIn(await unduh(page), LINE)).toBe(2);
  });

  // A mouse has no implicit pointer capture: a press released OUTSIDE the stage
  // (dragged into the gutter or the toolbar) never sent its pointerup to
  // interaction.js, so the stale tap candidate swallowed the next press, and
  // that press's release fired the OLD tap instead.
  test('a press released outside the stage does not swallow the next tap', async ({ page }) => {
    test.setTimeout(60000);
    await openDoc(page);
    await armHapus(page);
    // Press on the margin paper of the line's row, then leave the stage.
    const paper = await paperPoint(page);
    await page.mouse.move(paper.x, paper.y);
    await page.mouse.down();
    await page.mouse.move(2, 2, { steps: 4 }); // the header: not the stage
    await page.mouse.up();
    await page.waitForTimeout(200);
    expect(await annos(page), 'a press that left the stage must delete nothing').toEqual([]);

    // Measured AFTER the release: the drag toward the header can autoscroll.
    const target = centerOf(await lineBox(page, { str: LINE, nth: 1 }));
    // Guard: the click must land beyond the 12px tap slop of the abandoned
    // press, or a stale candidate would fire AT it and this test passes broken.
    expect(Math.hypot(target.x - paper.x, target.y - paper.y)).toBeGreaterThan(40);
    await page.mouse.click(target.x, target.y);
    await expect.poll(async () => (await annos(page)).length, { timeout: 15000 }).toBe(1);
    await expect.poll(async () => inkOf(page, (await crop(page, { str: LINE, nth: 1 })).buf), { timeout: 15000 }).toBe(0);
  });

  test('a drag is the camera: nothing deleted, nothing reported', async ({ page }) => {
    await openDoc(page);
    await armHapus(page);
    const c = centerOf(await lineBox(page, { str: LINE, nth: 1 }));
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.x, c.y + 80, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    expect(await annos(page)).toEqual([]);
    expect(hapusActions(await railHapus(page))).toEqual(['arm']);
  });

  test('in Pilih mode (Hapus not armed) the same tap changes nothing', async ({ page }) => {
    await openDoc(page);
    const c = centerOf(await lineBox(page, { str: LINE, nth: 1 }));
    await page.mouse.click(c.x, c.y);
    await page.waitForTimeout(400);
    expect(await annos(page)).toEqual([]);
    // FLUSH, then read. The old `__beacons.length === 0` never flushed the queue,
    // so it could not be non-zero whatever the tap did. Known-positive: the
    // flushed rail carries this open's doc_open, so a hapus row would be there too.
    // Catches: a Pilih tap that deletes/reports as Hapus (original_delete/_miss).
    let evs = [];
    await expect.poll(async () => {
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      evs = (await page.evaluate(() => window.__beacons.slice())).flatMap((b) => b.events || []);
      return evs.some((e) => e.event === 'doc_open');
    }, { message: 'doc_open never reached the rail, so the absence below proves nothing' }).toBe(true);
    expect(hapusActions(evs)).toEqual([]);
    expect(evs.filter((e) => e.event === 'tool_use' && /^original_/.test(e.props.action))).toEqual([]);
  });

  test('a tap on an object the person ADDED still deletes it, reports delete not original_delete, and disarms', async ({ page }) => {
    await openDoc(page);
    await page.click('[data-tool="text"]');
    await page.click('.pv-page >> nth=0', { position: { x: 100, y: 40 } });
    await page.keyboard.type('punya saya');
    await page.keyboard.press('Enter');
    await expect(page.locator('.pv-anno-text')).toBeVisible();
    await page.click('.pv-page >> nth=0', { position: { x: 600, y: 500 } }); // deselect
    await armHapus(page);
    await page.click('.pv-anno-text');
    expect(await annos(page)).toEqual([]);
    expect(await tool(page)).toBe('select');
    const acts = hapusActions(await railHapus(page));
    expect(acts).toContain('delete');
    expect(acts).not.toContain('original_delete');
  });
});

test.describe('Hapus on text an edit already owns', () => {
  test('tap a REPLACEMENT with Hapus: its text goes, the line stays deleted (screen + file), undo brings the replacement back', async ({ page }) => {
    test.setTimeout(60000);
    await openDoc(page);
    await armGanti(page);
    await tapLine(page, { str: LINE, nth: 1 });
    await page.keyboard.type('Rapat Luar Biasa');
    await page.keyboard.press('Enter');
    await expect(page.locator('.v2-text-edit')).toHaveCount(0);
    // Let the commit's bake land: the replacement is then part of the page raster.
    await expect.poll(() => page.evaluate(() => window.v2.getDoc().pages[0].editApplied?.size ?? 0)).toBeGreaterThan(0);
    await expect.poll(async () => inkOf(page, (await crop(page, { str: LINE, nth: 1 })).buf)).toBeGreaterThan(300);

    await armHapus(page);
    await tapAt(page, 'mouse', centerOf(await lineBox(page, { str: LINE, nth: 1 })));
    await expect.poll(async () => (await annos(page)).filter((a) => a.t === 'text').length).toBe(0);
    await expect.poll(async () => inkOf(page, (await crop(page, { str: LINE, nth: 1 })).buf), { timeout: 15000 }).toBe(0);
    // The cover survives, so the original does not come back.
    expect((await annos(page)).filter((a) => a.t === 'whiteout' && a.cut)).toHaveLength(1);
    const info = await unduh(page);
    expect(countIn(info, LINE)).toBe(2);
    expect(countIn(info, 'Rapat Luar Biasa')).toBe(0);

    await page.click('#btn-undo');
    // The replacement is back on screen. Ink, not byte-equal pixels: the overlay
    // painted before the bake and the baked raster set the same words in different
    // fonts, and which of the two is showing is not what this property is about.
    await expect.poll(async () => inkOf(page, (await crop(page, { str: LINE, nth: 1 })).buf), { timeout: 15000 })
      .toBeGreaterThan(300);
    expect((await annos(page)).filter((a) => a.t === 'text').map((a) => a.text)).toEqual(['Rapat Luar Biasa']);
    expect(countIn(await unduh(page), 'Rapat Luar Biasa')).toBe(1);
  });

  test('tapping the replacement BEFORE its bake lands still converges: screen and file both lose it', async ({ page }) => {
    // The commit's bake is in flight and the replacement is still a DOM overlay,
    // so this tap reaches the ANNOTATION path (onDeleteTap), which used to remove
    // the text and leave the old raster up: the screen kept showing a deletion
    // the model had not made, or the reverse.
    test.setTimeout(60000);
    await openDoc(page);
    await armGanti(page);
    await tapLine(page, { str: LINE, nth: 1 });
    await page.keyboard.type('Rapat Luar Biasa');
    await page.keyboard.press('Enter');
    await armHapus(page);
    await page.click('.pv-anno-text', { timeout: 1500 }).catch(async () => {
      // The bake already landed (fast machine): the same tap through the line path.
      await tapAt(page, 'mouse', centerOf(await lineBox(page, { str: LINE, nth: 1 })));
    });
    await expect.poll(async () => (await annos(page)).filter((a) => a.t === 'text').length).toBe(0);
    await expect.poll(async () => inkOf(page, (await crop(page, { str: LINE, nth: 1 })).buf), { timeout: 15000 }).toBe(0);
    expect(countIn(await unduh(page), 'Rapat Luar Biasa')).toBe(0);
  });
});

test.describe('the unit is the LINE, not the paragraph', () => {
  test('Hapus on one line of a paragraph removes that line only', async ({ page }) => {
    test.setTimeout(60000);
    await openDoc(page, NASTY('paragraf-badan.pdf'));
    const lines = await page.evaluate(async () => {
      const pg = window.v2.getDoc().pages[0];
      return (await window.v2.textRuns.getLines(pg.id)).map((l) => ({ s: l.str, b: l.blockId }));
    });
    // Precondition the test is about: this page really has a paragraph the Edit
    // tool would open whole. Otherwise "line only" is the only thing possible.
    expect(lines.filter((l) => l.b !== null && l.b !== undefined).length).toBeGreaterThan(2);
    const target = lines.findIndex((l) => l.b !== null && l.b !== undefined);
    await armHapus(page);
    await tapAt(page, 'mouse', centerOf(await lineBox(page, { index: target + 1 })));
    await expect.poll(async () => (await annos(page)).length).toBe(1);
    // Exactly one cover, its targets cover ONE line's runs, and the file still holds the others.
    const info = await unduh(page);
    const text = info.pages[0].text;
    expect(text).not.toContain(lines[target + 1].s.trim().slice(0, 20));
    for (const [i, l] of lines.entries()) {
      if (i === target + 1 || !l.s.trim()) continue;
      expect(text, `line ${i} vanished with its neighbour`).toContain(l.s.trim().slice(0, 20));
    }
  });
});

test.describe('Edit meets a deleted line', () => {
  test('Edit on the spot of a Hapus-deleted line opens an EMPTY editor; typing writes a line there, never a second cover over the same target', async ({ page }) => {
    test.setTimeout(60000);
    await openDoc(page);
    await armHapus(page);
    await tapAt(page, 'mouse', centerOf(await lineBox(page, { str: LINE, nth: 1 })));
    await expect.poll(async () => inkOf(page, (await crop(page, { str: LINE, nth: 1 })).buf), { timeout: 15000 }).toBe(0);
    await armGanti(page);
    await tapLine(page, { str: LINE, nth: 1 });
    await expect(page.locator('.v2-text-edit')).toHaveText(''); // not the deleted words
    await page.keyboard.type('Baru');
    await page.keyboard.press('Enter');
    await expect(page.locator('.v2-text-edit')).toHaveCount(0);
    expect((await annos(page)).map((a) => a.t).sort()).toEqual(['text', 'whiteout']); // one pair, not two covers
    const info = await unduh(page);
    expect(countIn(info, LINE)).toBe(2);
    expect(countIn(info, 'Baru')).toBe(1);
  });

});

test.describe('screenshots for the founder (not assertions)', () => {
  for (const [name, vp] of [['1280x800', { width: 1280, height: 800 }], ['390x844', { width: 390, height: 844 }]]) {
    test(`before / armed / after at ${name}`, async ({ page }) => {
      test.skip(!process.env.HAPUS_SHOTS, 'only when HAPUS_SHOTS names an output directory');
      fs.mkdirSync(SHOTS, { recursive: true });
      await page.setViewportSize(vp);
      await openDoc(page);
      await lineBox(page, { str: LINE, nth: 1 });
      await page.screenshot({ path: path.join(SHOTS, `hapus-asli-${name}-1-before.png`) });
      await armHapus(page);
      await tapAt(page, 'mouse', centerOf(await lineBox(page, { str: LINE, nth: 1 })));
      await expect.poll(async () => inkOf(page, (await crop(page, { str: LINE, nth: 1 })).buf), { timeout: 15000 }).toBe(0);
      await page.screenshot({ path: path.join(SHOTS, `hapus-asli-${name}-2-after.png`) });
      await page.click('#btn-undo');
      await page.waitForTimeout(800);
      await page.screenshot({ path: path.join(SHOTS, `hapus-asli-${name}-3-undone.png`) });
    });
  }
});
