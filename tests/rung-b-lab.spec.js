/*
 * Rung B lab — end-to-end proof that content-stream removal WORKS on real
 * PDFs: drive lab-edit.html, pick a printed run, remove it from the stream,
 * and assert the text is GONE from the output file's text layer (the lab page
 * itself re-parses the result with pdf.js and reports ✓/✗).
 *
 * This is the difference between Tip-Ex and honest redaction: the fixture
 * still LOOKS the same minus one line, but the string no longer exists in
 * the file at all.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function removeFirstRun(page, fixture) {
  await page.goto('/lab-edit.html');
  await page.setInputFiles('#file', path.join(__dirname, 'fixtures', fixture));
  await page.locator('.run').first().waitFor({ timeout: 15_000 });
  await page.locator('.run').first().click();
  await page.click('#btn-remove-run');
  await expect(page.locator('#rm-result')).toContainText(/[✓✗]/, { timeout: 15_000 });
  return page.locator('#rm-result').textContent();
}

test('sample: "Test Page 1" is removed from the stream — gone from the text layer', async ({ page }) => {
  const result = await removeFirstRun(page, 'sample-2pages.pdf');
  expect(result).toContain('✓');
  expect(result).toContain('HILANG');
});

test('surat: a dense Times letter line is removed cleanly', async ({ page }) => {
  const result = await removeFirstRun(page, path.join('nasty', 'surat-resmi.pdf'));
  expect(result).toContain('✓');
});

test('deck: a bold navy display run is removed cleanly', async ({ page }) => {
  const result = await removeFirstRun(page, path.join('nasty', 'deck-berwarna.pdf'));
  expect(result).toContain('✓');
});

// ---- CID/subset font: position-matched removal ------------------------------
// undangan-cid.pdf draws "Rapat Anggota Tahunan 2026" THREE times (y=660, 630,
// 600 in PDF space) with a fontkit-embedded Type0/Identity-H font — the
// content stream shows hex GLYPH IDS, never the string. String-match removal
// (the old fase-2 lab seed) is blind here; only position-matched removal
// (text-walk.js via core/redact.js) can pick the MIDDLE occurrence specifically
// and leave the other two untouched.
async function removeMiddleRapatLine(page) {
  await page.goto('/lab-edit.html');
  await page.setInputFiles('#file', path.join(__dirname, 'fixtures', 'nasty', 'undangan-cid.pdf'));
  await page.locator('.run').first().waitFor({ timeout: 15_000 });

  // Each .run box carries the source item's exact string in data-run-text
  // (added for exactly this: picking a SPECIFIC occurrence of a repeated
  // line, which plain DOM order can't disambiguate from content alone).
  const repeated = page.locator('.run[data-run-text="Rapat Anggota Tahunan 2026"]');
  await expect(repeated).toHaveCount(3);
  await repeated.nth(1).click(); // the MIDDLE line (y≈630, between 660 and 600)
  await page.click('#btn-remove-run');
  await expect(page.locator('#rm-result')).toContainText(/[✓✗]/, { timeout: 15_000 });
  const result = await page.locator('#rm-result').textContent();

  // Independent proof: re-parse the PRODUCED bytes with pdf.js in-page (not
  // the panel's own self-report) and count survivors of both the repeated
  // line and a nearby distinct line.
  const counts = await page.evaluate(async () => {
    const pdfjs = window.pdfjsLib;
    const doc = await pdfjs.getDocument({ data: window.__labLastOutput.slice() }).promise;
    const p = await doc.getPage(1);
    const tc = await p.getTextContent();
    const repeatedItems = tc.items.filter((i) => i.str === 'Rapat Anggota Tahunan 2026');
    return {
      repeated: repeatedItems.length,
      // Baselines of the survivors — proves WHICH line died, not just how many.
      repeatedYs: repeatedItems.map((i) => Math.round(i.transform[5])).sort((a, b) => b - a),
      neighbor: tc.items.filter((i) => i.str === 'Tempat: Balai Warga RW 05, Jakarta Selatan').length,
    };
  });

  return { result, counts };
}

test('undangan (CID): removing the middle of 3 identical lines leaves exactly the other 2 — string-match could never prove this', async ({ page }) => {
  const { result, counts } = await removeMiddleRapatLine(page);
  expect(result).toContain('✓');
  expect(result).toContain('HILANG');
  expect(counts.repeated).toBe(2); // 3 → 2: exactly the clicked one is gone, not all 3
  expect(counts.repeatedYs).toEqual([660, 600]); // survivors are the OUTER lines — the middle (630) died
});

test('undangan (CID): a nearby distinct line is untouched by the removal', async ({ page }) => {
  const { counts } = await removeMiddleRapatLine(page);
  expect(counts.neighbor).toBe(1); // "Tempat: Balai Warga RW 05, Jakarta Selatan" survives intact
});
