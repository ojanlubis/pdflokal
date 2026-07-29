/*
 * The stamp language: "cap = pernyataan status" — a stamp asserts document
 * status, never decorates (memory/design-language-2026-07.md). Five moments:
 * BERES (growth-loop.spec) · TAMPILAN BARU · TETAP JALAN · SUDAH OPTIMAL ·
 * BARU (changelog, future). These specs cover the three new ones.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from '../helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'sample-2pages.pdf');

test.describe('stamp moments — mobile', () => {
  /*
   * THE STAMP IS A PERMANENT LANDING ELEMENT — and this test carries the trail
   * of two founder rulings, because a test is a record of a decision and when
   * the decision changes the record has to say so.
   *
   *   2026-07-04  ruled: the stamp is PERMANENT, mobile and desktop, and reads
   *               "Tampilan baru". This test was written for that, and its old
   *               title said so.
   *   2026-07-29  SUPERSEDED, on the text only: "gratis replaces tampilan baru"
   *               (banked in ../decisions.md). The question that produced it was
   *               whether a second stamp-treated element could share the page —
   *               and the answer is the salience budget: ONE stamp per page. The
   *               loud currency gets spent once, so the two candidates had to
   *               become one and "Gratis!" won.
   *
   * ⚠️ WHAT SURVIVED AND WHAT DID NOT. Permanence survived — that is still the
   * Jul 4 ruling and it is still what the first two assertions guard. Only the
   * string changed. Left un-updated, this test would have gone on enforcing a
   * dead instruction and a future reader would find two founder rulings in
   * conflict with no way to tell which way it runs.
   */
  test('the stamp is a PERMANENT landing element (Jul 4, text superseded Jul 29)', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.ld-stamp')).toBeVisible();
    await expect(page.locator('.ld-stamp')).toContainText('Gratis!');
    // The salience budget, asserted: ONE per page. The motif stops meaning
    // anything the moment there are two, which is the reasoning that retired
    // "Tampilan baru" rather than adding to it.
    await expect(page.locator('.ld-stamp')).toHaveCount(1);
    // And the superseded string must be gone from the surface entirely, not
    // merely out-ranked by a second stamp somewhere further down.
    await expect(page.locator('body')).not.toContainText('Tampilan baru');

    /*
     * ⚠️ POSITION AND SIZE ARE ASSERTED BECAUSE PINNING THE TEXT ALONE IS WHAT
     * LET THE RULING GO UNSHIPPED.
     *
     * On 2026-07-30 the new string was swapped into the OLD element — 12.5px,
     * welded to the title block — instead of the ruled stamp being built at 37px
     * on the dropzone's corner. Both of the two things he explicitly said to keep
     * were the two things that changed, and THIS TEST WAS GREEN THE WHOLE TIME,
     * because the only thing it checked was the word.
     *
     * A test that pins the cheapest attribute of a ruled element gives the
     * feeling of coverage and none of it. The founder found it by looking.
     */
    const stamp = page.locator('.ld-stamp');
    await expect(stamp).toHaveCSS('font-size', '37px');

    // Sentence case: the old element uppercased its text. "GRATIS!" at 37px
    // shouts where "Gratis!" states, and text-transform is invisible in the DOM
    // text — only the computed style shows it.
    await expect(stamp).toHaveCSS('text-transform', 'none');

    // Welded to the DROPZONE, not to the headline. Measured rather than
    // asserted from the DOM tree: what matters is where it lands, and an
    // element can be a descendant of the right box and still be positioned
    // somewhere else entirely.
    /*
     * ⚠️ WAIT FOR THE THUNK TO FINISH BEFORE MEASURING ANYTHING.
     * `.ld-stamp` enters with `ld-thunk`, whose first keyframe is
     * `rotate(-16deg) scale(2)`. Measured mid-flight the bounding box is twice
     * its real size and spills well outside the dropzone — so the geometry
     * assertions below failed against a CORRECT build, and the number they
     * reported was real. Nothing was wrong with the page; the ruler was moving.
     * (`toHaveCSS` auto-retries and hid this; `evaluate` does not.)
     */
    await page.waitForFunction(
      () => document.querySelector('.ld-stamp').getAnimations().every((a) => a.playState === 'finished'),
      null, { timeout: 5000 },
    );

    const geom = await page.evaluate(() => {
      const s = document.querySelector('.ld-stamp').getBoundingClientRect();
      const d = document.querySelector('.dropzone').getBoundingClientRect();
      const h = document.querySelector('.ld h1').getBoundingClientRect();
      return {
        overhangsDropzoneTop: s.top < d.top && s.bottom > d.top,
        gapRight: Math.round(d.right - s.right),
        gapLeft: Math.round(s.left - d.left),
        withinDropzoneWidth: s.left >= d.left && s.right <= d.right,
        clearOfHeadline: s.top >= h.bottom - 4,
      };
    });
    expect(geom.overhangsDropzoneTop, 'the stamp does not straddle the dropzone\'s top edge — it is not pressed ONTO the corner').toBe(true);

    /*
     * ⚠️ RIGHT-ANCHORED, NOT "PAST THE MIDPOINT". The first version asserted
     * `s.left > d.left + d.width/2` and failed on the phone for a correct build:
     * the stamp is a fixed 37px, so on a 358px dropzone it is wide enough to
     * start before the midpoint while still being anchored to the right corner.
     * That assertion had encoded a desktop coordinate instead of the intent.
     * The intent is "pressed on the top-RIGHT corner", which is a statement
     * about which edge it is tied to — so compare the two gaps.
     */
    expect(
      geom.gapRight,
      `the stamp sits ${geom.gapRight}px from the dropzone's right edge and ${geom.gapLeft}px from `
      + 'its left. It is meant to be pressed on the top-RIGHT corner.',
    ).toBeLessThan(geom.gapLeft);
    expect(geom.gapRight, 'the stamp has drifted away from the right edge').toBeLessThan(80);

    expect(geom.withinDropzoneWidth, 'the stamp hangs outside the dropzone horizontally').toBe(true);
    expect(geom.clearOfHeadline, 'the stamp has drifted back up into the headline — that is the pre-ruling position').toBe(true);
    // Permanent means permanent: still there after a reload.
    await page.reload();
    await page.waitForTimeout(1200);
    await expect(page.locator('.ld-stamp')).toBeVisible();
  });

  test('TETAP JALAN when the connection drops mid-session — once', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('#file-input', FIXTURE);
    await expectFirstPage(page);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expect(page.locator('.v2-stamp', { hasText: 'Tetap jalan' })).toBeAttached();
    await expect(page.locator('#toast')).toContainText('jalan di HP-mu');
    // Second drop in the same session: no repeat theater.
    await page.waitForTimeout(2200);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await page.waitForTimeout(600);
    await expect(page.locator('.v2-stamp')).toHaveCount(0);
  });

  test('SUDAH OPTIMAL when compress finds nothing to save — stamped over the sheet', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('#file-input', FIXTURE);
    await expectFirstPage(page);
    await page.tap('#btn-download');
    // The tiny text-only fixture cannot shrink: the honesty guard returns the
    // original bytes and the segment says so; the stamp gives it a face.
    await page.tap('text=Compress');
    await expect(page.locator('#dl-sheet .v2-stamp', { hasText: 'Sudah optimal' }))
      .toBeAttached({ timeout: 8000 });
    await expect(page.locator('#dl-sheet')).toContainText('file sudah optimal');
  });
});
