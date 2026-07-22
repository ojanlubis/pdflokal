/*
 * Edit Teks Asli — regression: native re-insert under a non-identity page CTM.
 * ============================================================================
 * Founder phone-gate bug (2026-07-22, "Organization Structure PT Mandiri Utama
 * Finance" = org-structure.pdf): editing the subtitle "(Berlaku 01 Maret 2026)"
 * → "test" cut the original but the replacement VANISHED. Root cause (diagnosed
 * live): this PowerPoint/Word export carries a base `cm` that persists to end of
 * content, so the appended native-reinsert ran UNDER that residual CTM — text-
 * walk had already composed it into the absolute position, so it applied a
 * SECOND time and painted "test" at y≈207 instead of y≈517, lost in the chart.
 * Fix: text-walk exposes the page's endCTM; reinsert.js neutralizes it
 * (`q <endCTM⁻¹> cm … Q`) for the re-insert only. This pins that the replacement
 * bakes natively AT the original run's position, not transformed away.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { armGanti } from './helpers/lines.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NASTY = (n) => path.join(__dirname, 'fixtures', 'nasty', n);

test('subtitle edit under a base CTM bakes natively at the ORIGINAL position', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('#file-input', NASTY('org-structure.pdf'));
  await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
  await expect(page.locator('[data-tool="ganti"]')).toBeVisible(); // toolbar ready (heavier doc)
  await page.waitForTimeout(500);
  await armGanti(page);

  // The original subtitle's device-space Y (pdf.js-derived, via the app's own
  // line index) — the position the replacement MUST land at.
  const { origY, c } = await page.evaluate(async () => {
    const pg = window.v2.getDoc().pages[0];
    const line = (await window.v2.textRuns.getLines(pg.id)).find((l) => /Berlaku|Maret/.test(l.str));
    const view = document.querySelector(`.pv-page[data-page-id="${pg.id}"]`);
    const r = view.getBoundingClientRect();
    window.scrollTo(0, Math.max(0, r.top + window.scrollY + line.y * (r.height / view.offsetHeight) - innerHeight / 2));
    const r2 = view.getBoundingClientRect();
    return {
      origY: Math.round(line.pdf.y0),
      c: { x: r2.left + (line.x + line.w / 2) * (r2.width / view.offsetWidth), y: r2.top + (line.y + line.h / 2) * (r2.height / view.offsetHeight) },
    };
  });
  expect(origY).toBeGreaterThan(400); // subtitle is near the top of the 595-tall page

  await page.mouse.click(c.x, c.y);
  await expect(page.locator('.v2-text-edit')).toBeVisible();
  await page.locator('.v2-text-edit').evaluate((el) => { el.textContent = ''; });
  await page.keyboard.type('test');
  await page.keyboard.press('Enter');
  await expect(page.locator('.v2-text-edit')).toHaveCount(0);

  const out = await page.evaluate(async () => {
    const { ensurePdfLib } = await import('/js/core/vendor.js');
    const { buildEditedPageBytes } = await import('/js/core/page-surgery.js');
    const { PDFLib, fontkit } = await ensurePdfLib();
    const d = window.v2.getDoc(); const pg = d.pages[0];
    const srcDoc = await PDFLib.PDFDocument.load(d.sources.find((s) => s.id === pg.sourceId).bytes);
    const result = await buildEditedPageBytes(srcDoc, pg, pg.annotations, { PDFLib, fontkit });
    const parsed = await window.pdfjsLib.getDocument({ data: result.bytes.slice() }).promise;
    const tc = await (await parsed.getPage(1)).getTextContent();
    const t = tc.items.find((i) => /test/i.test(i.str));
    return { outcome: pg.editOutcomes[0], testItem: t ? { y: Math.round(t.transform[5]) } : null };
  });

  expect(out.outcome.insert).toEqual({ path: 'native', reason: 'clean' }); // doc's OWN font
  expect(out.testItem).not.toBeNull();
  expect(Math.abs(out.testItem.y - origY)).toBeLessThan(3); // AT the original position (the bug)
});
