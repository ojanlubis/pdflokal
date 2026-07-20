/*
 * Golden-master suite.
 *
 * Each scenario loads a fixture PDF, applies a scripted set of edits, exports,
 * then asserts the rendered PNG of each page matches a committed baseline.
 *
 * Regenerate baselines: UPDATE_BASELINES=1 npm test -- --grep golden
 *
 * Baselines live in tests/golden/baselines/ and are tracked by git. When a
 * scenario goes red, the actual rendered PNGs are written to
 * tests/golden/actual/ (gitignored) for visual diffing.
 *
 * The three scenarios map to the bugs we shipped fixes for this session —
 * if the underlying bug regresses, the baseline diverges and CI goes red.
 */
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'url';
import path from 'path';
import { exportPdf, assertGoldenMatch } from './render-helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PDF = path.join(__dirname, '..', 'fixtures', 'sample-2pages.pdf');
const BASELINES_DIR = path.join(__dirname, 'baselines');
const ACTUAL_DIR = path.join(__dirname, 'actual');

async function loadSamplePdf(page) {
  // The OLD wing (this suite drives ueState/#file-input) moved to
  // /alat-gambar.html when v2 became `/` (Jul 3) — every old suite was
  // repointed then except this one, which sat broken until 2026-07-19.
  await page.goto('/alat-gambar.html');
  await page.setInputFiles('#file-input', SAMPLE_PDF);
  await page.waitForFunction(() => document.body.classList.contains('editor-active'));
  await page.waitForSelector('.ue-page-slot canvas', { state: 'attached' });
  await page.waitForFunction(() => window.ueState?.pages?.length === 2);
  await page.waitForFunction(() => window.ueState?.eventsSetup === true);
}

// Directly inserts an annotation into ueState — bypasses canvas events for
// deterministic positioning. The bugs we're guarding against happen in
// export, not in interaction, so this is the cleaner attack surface.
async function pushAnnotation(page, pageIndex, anno) {
  await page.evaluate(({ p, a }) => {
    window.ueState.annotations[p].push(a);
  }, { p: pageIndex, a: anno });
}

async function reportAndAssert(scenarioName, results) {
  // In update mode every result will be 'baseline-written' — not a regression.
  const issues = results.filter((r) => r.action === 'mismatch' || r.action === 'no-baseline');
  if (issues.length > 0) {
    console.log(`Golden mismatch in "${scenarioName}":`);
    for (const issue of issues) {
      console.log(`  page ${issue.page}: ${issue.action}`);
      if (issue.dimsDiffer) console.log('    dimensions differ');
      if (issue.diffPixels !== undefined) {
        console.log(`    diff: ${issue.diffPixels}/${issue.total} px (${(issue.ratio * 100).toFixed(3)}%)`);
      }
      if (issue.actualPath) console.log(`    saved actual: ${issue.actualPath}`);
      if (issue.diffPath) console.log(`    saved diff:   ${issue.diffPath}`);
    }
  }
  expect(issues, `${scenarioName}: ${issues.length} page(s) drifted`).toEqual([]);
}

test.describe('golden masters', () => {
  test('scenario-01: text annotation on page 0 renders consistently', async ({ page }) => {
    await loadSamplePdf(page);
    await pushAnnotation(page, 0, {
      type: 'text',
      text: 'GOLDEN',
      x: 100,
      y: 100,
      fontSize: 24,
      color: '#000000',
      fontFamily: 'Helvetica',
      bold: false,
      italic: false,
    });
    const pdfBytes = await exportPdf(page);
    const results = await assertGoldenMatch('scenario-01-text-helvetica', pdfBytes, page, BASELINES_DIR, ACTUAL_DIR);
    await reportAndAssert('scenario-01-text-helvetica', results);
  });

  test('scenario-02: rotated page + text annotation (regression #3)', async ({ page }) => {
    await loadSamplePdf(page);
    await page.evaluate(() => window.ueSelectPage(0));
    // Rotate page 0 to 90° via the SSOT helper
    await page.evaluate(() => { window.ueState.pages[0].rotation = 90; });
    await pushAnnotation(page, 0, {
      type: 'text',
      text: 'ROT',
      x: 80,
      y: 60,
      fontSize: 18,
      color: '#cc0000',
      fontFamily: 'Helvetica',
      bold: true,
      italic: false,
    });
    const pdfBytes = await exportPdf(page);
    const results = await assertGoldenMatch('scenario-02-rotated-page', pdfBytes, page, BASELINES_DIR, ACTUAL_DIR);
    await reportAndAssert('scenario-02-rotated-page', results);
  });

  test('scenario-03: custom font (Montserrat) embeds correctly', async ({ page }) => {
    await loadSamplePdf(page);
    await pushAnnotation(page, 0, {
      type: 'text',
      text: 'MNT',
      x: 100,
      y: 200,
      fontSize: 20,
      color: '#0066cc',
      fontFamily: 'Montserrat',
      bold: false,
      italic: false,
    });
    const pdfBytes = await exportPdf(page);
    const results = await assertGoldenMatch('scenario-03-montserrat', pdfBytes, page, BASELINES_DIR, ACTUAL_DIR);
    await reportAndAssert('scenario-03-montserrat', results);
  });
});
