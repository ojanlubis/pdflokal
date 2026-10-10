/*
 * PDFLokal — Edit on printed text, attacked from the format's parameters.
 * Strategy and axes: tests/helpers/pdf-params.js (his ruling 2026-10-10).
 *
 * For every pairwise case of font kind x size x Tz x Tc x MediaBox origin:
 * Edit one printed line, download, and read the file back with pdf.js:
 *   - the new words are there and the old ones are gone,
 *   - the new line starts where the old one did,
 *   - the line nobody touched is still there.
 * A failing case prints its parameters in its name; that is the whole repro.
 * Not run by the foreground gate (nightly CI).
 */
import { test, expect } from '@playwright/test';
import { expectFirstPage } from './helpers/render.js';
import { downloadBytes } from './helpers/download-bytes.js';
import { armGanti, tapLine } from './helpers/lines.js';
import { TEXT_AXES, TEXT_BYSTANDER, pairwise, textCaseName, buildTextPdf } from './helpers/pdf-params.js';

const NEW_TEXT = 'Halo Rina Wati';

// Page 1's printed LINES, each with its baseline start as fractions of the page.
// pdf.js may split one shown string into many items (it does under Tc), so
// items are grouped by baseline and joined; `key` drops spaces for matching.
async function readText(page, buf) {
  return page.evaluate(async (arr) => {
    const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(arr) }).promise;
    const p = await doc.getPage(1);
    const vp = p.getViewport({ scale: 1 });
    const items = (await p.getTextContent()).items.filter((it) => it.str.trim()).map((it) => {
      const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
      return { str: it.str, fx: x / vp.width, fy: y / vp.height };
    }).sort((m, n) => m.fy - n.fy || m.fx - n.fx);
    const lines = [];
    for (const it of items) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.fy - it.fy) < 0.006) { last.parts.push(it); continue; }
      lines.push({ fy: it.fy, parts: [it] });
    }
    return lines.map((l) => {
      l.parts.sort((m, n) => m.fx - n.fx);
      const str = l.parts.map((q) => q.str).join(' ');
      return { str, key: str.replace(/\s+/g, ''), fx: l.parts[0].fx, fy: l.fy };
    });
  }, Array.from(buf));
}

// KNOWN RESIDUAL, pinned so a fix announces itself: letter spacing of about a
// tenth of the font size or more makes pdf.js itself return the line as
// "H a l o B u d i S a n t o s o" (fake spaces between letters, the real word
// spaces merged into them), measured 2026-10-10: Tc 1.5 on 14pt splits, on
// 28pt does not. Edit can't find "Budi" and the prefill shows the spaced
// letters. js/core/text-lines.js (SPACE_GAP_FACTOR) explains why geometry
// alone can't undo it. When this is fixed these cases go red: drop the mark.
const letterSpaced = (c) => (c.charSpacing * c.squeeze / 100) / c.size >= 0.1;

for (const c of pairwise(TEXT_AXES)) {
  test(`edit: ${textCaseName(c)}`, async ({ page }) => {
    test.fail(letterSpaced(c), 'known residual: pdf.js splits letter-spaced text into single letters');
    await page.goto('/');
    const src = await buildTextPdf(page, c);
    await page.setInputFiles('#file-input', { name: 'teks.pdf', mimeType: 'application/pdf', buffer: src });
    await expectFirstPage(page); // also loads pdf.js, which readText needs
    const was = (await readText(page, src)).find((t) => t.key.includes('Budi'));
    expect(was, 'the fixture printed the subject line').toBeTruthy();
    await armGanti(page);
    await tapLine(page, { str: 'Budi' });
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type(NEW_TEXT);
    await page.keyboard.press('Enter');
    await expect(page.locator('.v2-text-edit')).toHaveCount(0);

    await page.click('#btn-download');
    const { buf } = await downloadBytes(page, () => page.click('#ds-cta'));
    const after = await readText(page, buf);
    const all = after.map((t) => t.str).join(' | ');
    const keys = after.map((t) => t.key).join('|');
    const now = after.find((t) => t.key.includes('Rina'));

    expect(now, `the new words are in the file (file text: ${all})`).toBeTruthy();
    expect(keys, `the old words are gone (file text: ${all})`).not.toContain('Budi');
    expect(keys, `the untouched line survives (file text: ${all})`).toContain(TEXT_BYSTANDER.replace(/\s+/g, ''));
    expect(Math.abs(now.fy - was.fy), `baseline: source ${was.fy.toFixed(3)} vs file ${now.fy.toFixed(3)}`).toBeLessThan(0.03);
    expect(Math.abs(now.fx - was.fx), `start: source ${was.fx.toFixed(3)} vs file ${now.fx.toFixed(3)}`).toBeLessThan(0.03);
  });
}
