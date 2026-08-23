/*
 * RUNG S2 — tap a word on a SCAN and replace it.
 * ============================================================================
 * The scan ladder's second rung (seat spec-edit-dokumen-foto.md §3): recognise
 * the page, tap a recognised line, cover it, retype. This suite drives the
 * REAL engine over a REAL scan — the 5 MB Tesseract build against
 * `scan-bersih.pdf`, an Indonesian official letter rendered to pixels and
 * degraded by tests/gen-scans.spec.js. Nothing here is mocked, because the two
 * things that can go wrong (does it recognise anything, does the cover land on
 * the words) are exactly the two a mock would answer for free.
 *
 * ⚠️ WHAT A GREEN HERE DOES AND DOES NOT MEAN. It means the mechanism works
 * end to end: engine loads under the CSP, boxes land on the ink, the cover
 * erases, the editor opens prefilled, and the export path is not involved. It
 * does NOT mean the result looks right — the replacement is set in an
 * ESTIMATED font beside photographed letterforms, and no assertion can rule on
 * that. That is Fauzan's call from the render, which is why test 5 writes the
 * crops out instead of asserting on them.
 *
 * ⚠️ SLOW BY CONSTRUCTION. Recognition is seconds, and the first test also
 * pays for the engine fetch. The timeout is generous on purpose: a flaky
 * timeout here would train someone to re-run rather than to look.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NASTY = (n) => path.join(__dirname, 'fixtures', 'nasty', n);
const SHOTS = path.join(__dirname, '..', 'review-shots');

test.describe.configure({ mode: 'serial' });

async function openScan(page, file = 'scan-bersih.pdf') {
  await page.goto('/');
  await page.setInputFiles('#file-input', NASTY(file));
  await expectFirstPage(page);
}

// IDEMPOTENT ON PURPOSE. Recognition ends by arming Ganti itself (app.js's
// armOcrTap), so a blind click here would TOGGLE the tool back off and then
// wait forever for a state the click just undid — which is exactly how this
// suite first "hung". The product behaviour it documents is worth keeping in
// view: after OCR, the user does not have to arm anything.
async function armGanti(page) {
  if (await page.evaluate(() => window.v2?.getTool() === 'ganti')) return;
  await page.click('[data-tool="ganti"]');
  await page.waitForFunction(() => window.v2?.getTool() === 'ganti');
}

// Recognise page 1 through the app's own entry point and wait for the boxes.
async function recognise(page) {
  const pageId = await page.evaluate(() => window.v2.getDoc().pages[0].id);
  await page.evaluate((id) => window.v2.runOcrOnPage(id), pageId);
  await page.waitForFunction(
    (id) => window.v2.ocrIndex.hasLines(id),
    pageId,
    { timeout: 90000 },
  );
  return pageId;
}

// Viewport box of a recognised line, addressed by its WORDS. Same shape as
// tests/helpers/lines.js's lineBox, over the OCR index instead of textRuns —
// addressing by text rather than by a pixel guess is what keeps this a test of
// the product rather than a test of our own assumptions about the fixture.
async function ocrLineBox(page, pageId, match) {
  const box = await page.evaluate(({ id, m }) => {
    const lines = window.v2.ocrIndex.getLines(id);
    const line = m ? lines.find((l) => l.str.toLowerCase().includes(m.toLowerCase())) : lines[0];
    if (!line) return null;
    const view = document.querySelector(`.pv-page[data-page-id="${id}"]`);
    const r = view.getBoundingClientRect();
    const sx = r.width / view.offsetWidth;
    const sy = r.height / view.offsetHeight;
    return { x: r.left + line.x * sx, y: r.top + line.y * sy, width: line.w * sx, height: line.h * sy, str: line.str };
  }, { id: pageId, m: match });
  if (!box) throw new Error(`ocrLineBox: no recognised line matching ${JSON.stringify(match)}`);
  return box;
}

// Per-test, not describe-scope: test.setTimeout() is only legal inside a test
// body, and calling it in the describe callback takes the whole file down in a
// way that reads as a hang rather than as an error.
const OCR_TIMEOUT = 120000;

test.describe('rung S2 — tap-to-edit on a scan', () => {
  test('1 · the scan sheet offers OCR, and taking it recognises the page', async ({ page }) => {
    test.setTimeout(OCR_TIMEOUT);
    await openScan(page);
    await armGanti(page);
    // Tap anywhere on the page: a scan has no text runs, so this routes to the
    // sheet no matter where it lands.
    const view = page.locator('.pv-page').first();
    const box = await view.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    const sheet = page.locator('#scan-offer');
    await expect(sheet).toBeVisible();
    // The payload disclosure is a CONDITION of the WASM ruling, not a nicety:
    // a heavy engine is sanctioned only if the user is told before it starts.
    // Asserted by behaviour — a visible notice next to the button — rather
    // than by its exact words, which are Fauzan's to change without breaking
    // this test.
    await expect(page.locator('#so-ocr')).toBeVisible();
    await expect(page.locator('#scan-offer .so-note')).toBeVisible();

    await page.click('#so-ocr');
    await expect(sheet).toBeHidden();

    const pageId = await page.evaluate(() => window.v2.getDoc().pages[0].id);
    await page.waitForFunction((id) => window.v2.ocrIndex.hasLines(id), pageId, { timeout: 90000 });
    const lines = await page.evaluate((id) => window.v2.ocrIndex.getLines(id), pageId);
    // A clean scan of a full letter must yield real lines. The number is a
    // floor, not a pin — the point is "this scan is readable at all", which is
    // the outcome the whole rung stands on.
    expect(lines.length).toBeGreaterThan(5);
    for (const l of lines) {
      expect(Number.isFinite(l.x) && Number.isFinite(l.y)).toBe(true);
      expect(l.w).toBeGreaterThan(0);
      expect(l.h).toBeGreaterThan(0);
    }
  });

  test('2 · recognised boxes land ON the page, in the top-left frame', async ({ page }) => {
    test.setTimeout(OCR_TIMEOUT);
    await openScan(page);
    const pageId = await recognise(page);
    const { lines, w, h } = await page.evaluate((id) => {
      const p = window.v2.getDoc().pages.find((x) => x.id === id);
      return { lines: window.v2.ocrIndex.getLines(id), w: p.width, h: p.height };
    }, pageId);

    // Every box inside the page. This is the assertion that catches a y-flip
    // in the LIVE frame rather than in arithmetic (tests/core/ocr-lines.test.mjs
    // catches it there) — a flipped layer on a page with a top-heavy letterhead
    // still lands "inside the page", so the real proof is the next assertion.
    for (const l of lines) {
      expect(l.x).toBeGreaterThan(-5);
      expect(l.y).toBeGreaterThan(-5);
      expect(l.x + l.w).toBeLessThan(w + 5);
      expect(l.y + l.h).toBeLessThan(h + 5);
    }

    // ORDER IS THE FLIP DETECTOR. ocrIndex returns lines in the engine's own
    // reading order, top of the page first. If y were flipped, the first line
    // read would sit BELOW the last one on screen. Compares the first and last
    // recognised lines, which is the widest available lever.
    expect(lines.length).toBeGreaterThan(2);
    expect(lines[0].y).toBeLessThan(lines[lines.length - 1].y);
  });

  test('3 · tapping a recognised line covers it and opens it prefilled', async ({ page }) => {
    test.setTimeout(OCR_TIMEOUT);
    await openScan(page);
    const pageId = await recognise(page);
    await armGanti(page);

    const target = await ocrLineBox(page, pageId);
    await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);

    const editor = page.locator('.v2-text-edit');
    await expect(editor).toBeVisible();
    // Prefilled with what the engine read, not with an empty box: the whole
    // difference between rung S2 and the Teks tool that already existed.
    expect((await editor.textContent()).trim().length).toBeGreaterThan(0);

    // A cover was placed, and it carries the S2 field — NOT the surgery
    // fields. This is the assertion that keeps rung S2 off the export path:
    // core/page-surgery.js and core/export.js both filter on
    // `replaceTargets?.length && replaceBox`, so a scan cover that grew those
    // fields would aim the content-stream cutter at a page whose words are
    // pixels.
    const cover = await page.evaluate((id) => {
      const p = window.v2.getDoc().pages.find((x) => x.id === id);
      const c = p.annotations.find((a) => a.type === 'whiteout' && a.ocrBox);
      return c ? { hasOcrBox: true, replaceTargets: c.replaceTargets ?? null, replaceBox: c.replaceBox ?? null } : null;
    }, pageId);
    expect(cover).not.toBeNull();
    expect(cover.replaceTargets).toBeNull();
    expect(cover.replaceBox).toBeNull();
  });

  test('4 · a second tap RE-EDITS instead of stacking a second replacement', async ({ page }) => {
    test.setTimeout(OCR_TIMEOUT);
    await openScan(page);
    const pageId = await recognise(page);
    await armGanti(page);

    const target = await ocrLineBox(page, pageId);
    const cx = target.x + target.width / 2;
    const cy = target.y + target.height / 2;

    await page.mouse.click(cx, cy);
    await expect(page.locator('.v2-text-edit')).toBeVisible();
    // The prefill arrives SELECTED (openTextEditor's draft path), so typing
    // replaces it — and Enter COMMITS. Escape is the backout, which would take
    // the cover with it: that is the behaviour, not a way to save.
    await page.keyboard.type('DIUBAH SATU');
    await page.keyboard.press('Enter');
    await expect(page.locator('.v2-text-edit')).toBeHidden();

    const afterFirst = await page.evaluate((id) => {
      const p = window.v2.getDoc().pages.find((x) => x.id === id);
      return {
        covers: p.annotations.filter((a) => a.type === 'whiteout' && a.ocrBox).length,
        texts: p.annotations.filter((a) => a.type === 'text' && a.ocrCoverId).length,
      };
    }, pageId);
    expect(afterFirst).toEqual({ covers: 1, texts: 1 });

    // OCR reads the PRISTINE pixels, so the covered word still recognises as
    // its ORIGINAL text. Without the re-edit guard this second tap would build
    // a second cover and a second text object on top of the first — two
    // replacements painted over each other, and the user's own words lost
    // under the engine's.
    await armGanti(page);
    await page.mouse.click(cx, cy);
    const editor = page.locator('.v2-text-edit');
    await expect(editor).toBeVisible();
    expect((await editor.textContent()).trim()).toBe('DIUBAH SATU');
    await page.keyboard.type('DIUBAH DUA');
    await page.keyboard.press('Enter');
    await expect(editor).toBeHidden();

    const afterSecond = await page.evaluate((id) => {
      const p = window.v2.getDoc().pages.find((x) => x.id === id);
      return {
        covers: p.annotations.filter((a) => a.type === 'whiteout' && a.ocrBox).length,
        texts: p.annotations.filter((a) => a.type === 'text' && a.ocrCoverId).map((a) => a.text),
      };
    }, pageId);
    expect(afterSecond.covers).toBe(1);
    expect(afterSecond.texts).toEqual(['DIUBAH DUA']);
  });

  test('6 · a recognition run raises ZERO uncaught page errors', async ({ page }) => {
    test.setTimeout(OCR_TIMEOUT);
    // THE DEFECT THIS PINS, and it was invisible from every other angle: the
    // first build of js/v2/ocr-engine.js passed `logger: undefined` into
    // tesseract.js's options. That does not mean "no logger" — it overwrites
    // the library's own no-op default with undefined, and every progress
    // message the worker posts then throws out of its onmessage handler.
    // EIGHT uncaught TypeErrors per page recognised, from a feature that was
    // otherwise working perfectly: correct text, correct boxes, green tests.
    //
    // js/v2/app.js's global error capture would have forwarded every one to
    // the rail and to Sentry. Nothing a user could see, nothing a functional
    // assertion could fail on — which is exactly why the check has to be
    // "did anything throw", not "did it produce the right answer".
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openScan(page);
    await recognise(page);
    expect(errors).toEqual([]);
  });

  test('7 · clearing an S2 replacement and committing REMOVES it — the scan returns', async ({ page }) => {
    test.setTimeout(OCR_TIMEOUT);
    // The mirror of ganti-teks-reedit.spec.js's own empty-commit test, and it
    // exists because rung S2 shipped with exactly the gap that one was written
    // to close: `ocrReEdit` fell through every branch of commit(), so a user
    // who cleared the text and pressed Enter watched the old replacement stay
    // where it was, with no way to reach the pair again except undo.
    await openScan(page);
    const pageId = await recognise(page);
    await armGanti(page);

    const target = await ocrLineBox(page, pageId);
    const cx = target.x + target.width / 2;
    const cy = target.y + target.height / 2;

    await page.mouse.click(cx, cy);
    await expect(page.locator('.v2-text-edit')).toBeVisible();
    await page.keyboard.type('SEMENTARA');
    await page.keyboard.press('Enter');
    await expect(page.locator('.v2-text-edit')).toBeHidden();

    // Re-open and clear it. Backspace, not a select-all: the prefill arrives
    // selected, so one Backspace empties it — the same gesture the
    // born-digital suite uses for its own empty commit.
    await armGanti(page);
    await page.mouse.click(cx, cy);
    await expect(page.locator('.v2-text-edit')).toBeVisible();
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Enter');
    await expect(page.locator('.v2-text-edit')).toBeHidden();

    const left = await page.evaluate((id) => {
      const p = window.v2.getDoc().pages.find((x) => x.id === id);
      return {
        covers: p.annotations.filter((a) => a.type === 'whiteout' && a.ocrBox).length,
        texts: p.annotations.filter((a) => a.type === 'text' && a.ocrCoverId).length,
      };
    }, pageId);
    // Both halves gone: the cover is what was hiding the original pixels, so
    // leaving it behind would erase the word without replacing it.
    expect(left).toEqual({ covers: 0, texts: 0 });
  });

  test('8 · Escape on an S2 re-edit backs OUT — it must not read as a delete', async ({ page }) => {
    test.setTimeout(OCR_TIMEOUT);
    // The trap that arrives WITH test 7's fix rather than before it. Escape
    // restores the prefill and blurs; if the restore hands back '' for an S2
    // re-edit, that empty text now means DELETE, and the safest key on the
    // keyboard silently destroys the user's edit.
    await openScan(page);
    const pageId = await recognise(page);
    await armGanti(page);

    const target = await ocrLineBox(page, pageId);
    const cx = target.x + target.width / 2;
    const cy = target.y + target.height / 2;

    await page.mouse.click(cx, cy);
    await page.keyboard.type('HARUS BERTAHAN');
    await page.keyboard.press('Enter');
    await expect(page.locator('.v2-text-edit')).toBeHidden();

    await armGanti(page);
    await page.mouse.click(cx, cy);
    await expect(page.locator('.v2-text-edit')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.v2-text-edit')).toBeHidden();

    const after = await page.evaluate((id) => {
      const p = window.v2.getDoc().pages.find((x) => x.id === id);
      return {
        covers: p.annotations.filter((a) => a.type === 'whiteout' && a.ocrBox).length,
        texts: p.annotations.filter((a) => a.type === 'text' && a.ocrCoverId).map((a) => a.text),
      };
    }, pageId);
    expect(after).toEqual({ covers: 1, texts: ['HARUS BERTAHAN'] });
  });

  test('5 · ARTIFACT: before/after crops of the same region, for his eye', async ({ page }) => {
    // Not an assertion about fidelity — there isn't one that could be honest.
    // This writes the two crops Fauzan rules from, at the same coordinates, so
    // the only difference in the pair is the edit itself.
    test.setTimeout(OCR_TIMEOUT);
    fs.mkdirSync(SHOTS, { recursive: true });
    await openScan(page);
    const pageId = await recognise(page);

    const target = await ocrLineBox(page, pageId);
    const clip = {
      x: Math.max(0, target.x - 20),
      y: Math.max(0, target.y - 30),
      width: Math.min(900, target.width + 40),
      height: target.height + 60,
    };
    await page.screenshot({ path: path.join(SHOTS, 's2-sebelum.png'), clip });

    await armGanti(page);
    await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);
    await expect(page.locator('.v2-text-edit')).toBeVisible();
    await page.keyboard.type('Diganti lewat OCR');
    await page.keyboard.press('Enter');
    await expect(page.locator('.v2-text-edit')).toBeHidden();

    await page.screenshot({ path: path.join(SHOTS, 's2-sesudah.png'), clip });
    await page.screenshot({ path: path.join(SHOTS, 's2-halaman-penuh.png'), fullPage: false });

    for (const f of ['s2-sebelum.png', 's2-sesudah.png']) {
      expect(fs.existsSync(path.join(SHOTS, f))).toBe(true);
    }
  });
});
