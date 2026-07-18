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
