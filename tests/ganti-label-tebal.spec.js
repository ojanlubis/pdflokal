/*
 * BOLD LABEL + REGULAR VALUE — "what font is this line?" answered two ways.
 * ============================================================================
 * Found 2026-07-28 while gating the dash-leader fix. `39e0b9f` corrected the
 * blended-target call at js/v2/app.js:1054 (smartReplace's surgery geometry);
 * the IDENTICAL shape at js/v2/app.js:798 (prepareDocFont's font learning) was
 * not touched, and nothing in the suite could see it.
 *
 * There are two selectors for "the line's font", and they disagree:
 *   - core/text-lines.js  assembleLine -> the DOMINANT run (widest by pdf.len)
 *   - core/text-walk.js   planRunRemoval's `insert` -> the FIRST run BY
 *     CONTENT-STREAM POSITION (`matches.reduce((a,b) => a.start <= b.start ...)`)
 * prepareDocFont consumes the second while everything downstream assumes the
 * first, then does `draft.bold = draft.bold || fp.bold`.
 *
 * Measured on this fixture's real geometry:
 *   dominant (text-lines.js)         -> Carlito-Regular      (len 99.5)
 *   first-by-stream (prepareDocFont) -> MontserratThin-Bold  (len 47.0), bold:true
 *   insert.mixedFonts                -> true, returned and never read by app.js
 * => draft.bold becomes true for a line that is mostly regular.
 *
 * That is `Nama : Budi` — the archetypal Indonesian form row, not an exotic
 * case — and because a genuinely mixed-font line makes the native stamp
 * DECLINE, the twin fallback renders using that wrong flag. It is a rendering
 * defect, not only a telemetry one.
 *
 * WHY THE ASSERTION IS POLICY-INDEPENDENT: the seat has not yet ruled how a
 * mixed line should be styled (decline all styling / use the dominant run /
 * split: dominant family + declined weight). All three converge on the same
 * outcome for THIS input — the replacement must not come out bold — so this
 * test pins the defect without encoding an unruled expectation. It fails today
 * and passes under whichever policy lands.
 *
 * WHY IT WAITS ON data-style-prepared: prepareDocFont is fire-and-forget. A
 * fixed timeout would be a budget, and waiting on "bold appeared" would break
 * the moment the fix lands. The flag means "finished deciding", never "decided
 * bold", so the wait is deterministic under every policy — and without it this
 * test could PASS by winning the race, which is a false green in the one place
 * we can least afford one (this same function's unawaited race is decisions.md
 * 2026-07-23).
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { armGanti, tapLine } from './helpers/lines.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NASTY = (n) => path.join(__dirname, 'fixtures', 'nasty', n);

test('bold label + regular value: the replacement must not inherit bold from the first-painted run', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('#file-input', NASTY('label-tebal.pdf'));
  await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
  await expect(page.locator('[data-tool="ganti"]')).toBeVisible();
  await armGanti(page);

  // Tap the VALUE — the regular, dominant run. Whatever the policy, a line the
  // user experiences as mostly-regular must not come back entirely bold.
  await tapLine(page, { str: 'Budi Santoso' });

  // The line really is two runs in two different font resources — assert it,
  // so a fixture that silently regenerates into a single-font page fails here
  // instead of quietly turning this whole spec into decoration.
  const shape = await page.evaluate(async () => {
    const pg = window.v2.getDoc().pages[0];
    const lines = await window.v2.textRuns.getLines(pg.id);
    const l = lines.find((x) => x.str.includes('Budi Santoso'));
    return { runs: l.runs.length, names: [...new Set(l.runs.map((r) => r.fontName))].length };
  });
  expect(shape.runs).toBe(2);
  expect(shape.names).toBe(2);

  // Deterministic: prepareDocFont has finished deciding (whatever it decided).
  await expect(page.locator('.v2-text-edit')).toHaveAttribute('data-style-prepared', '1');

  await page.locator('.v2-text-edit').evaluate((el) => { el.textContent = ''; });
  await page.keyboard.type('Nama : Siti Rahayu');
  await page.keyboard.press('Enter');
  await expect(page.locator('.v2-text-edit')).toHaveCount(0);

  const committed = await page.evaluate(() => {
    const pg = window.v2.getDoc().pages[0];
    const t = pg.annotations.filter((a) => a.type === 'text').at(-1);
    return { text: t?.text, bold: !!t?.bold, italic: !!t?.italic };
  });

  expect(committed.text).toBe('Nama : Siti Rahayu');
  // THE DEFECT: today this is true, inherited from a 47pt-wide bold label on a
  // line whose dominant run is regular and 99.5pt wide.
  expect(committed.bold).toBe(false);
});
