/*
 * PDFLokal — tests/spike/live-surgery-timing.spec.js  (MEASUREMENT SPIKE)
 * ============================================================================
 * Architecture-decision input (2026-07-19): the founder ruled the editor
 * must re-render the edited page from a surgically-modified PDF at COMMIT
 * time ("live surgery") instead of overlaying cover+text annotations. Before
 * building it, measure whether the commit-time pipeline (pdf-lib load ->
 * surgery -> save -> pdf.js re-render) is fast enough. Numbers are the
 * deliverable, not features — this spec asserts nothing about thresholds,
 * it collects and prints.
 *
 * Drives tests/spike/live-surgery-timing.html, which imports the REAL
 * production modules (js/core/vendor.js, js/core/redact.js — the exact
 * removeRunsFromPdfPage() that core/export.js's runSurgery() calls at real
 * export time) — never a reimplementation.
 *
 * NOT part of the default sweep. `npx playwright test` / `npm run verify`
 * will find this file (testDir is './tests', nothing excludes tests/spike/**
 * in playwright.config.js) but every test below self-skips unless SPIKE=1 is
 * set, so the default sweep sees them as SKIPPED, never failed.
 *
 * Invocation:
 *   SPIKE=1 npx playwright test tests/spike/live-surgery-timing.spec.js --project=chromium
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'nasty');
const RUN = process.env.SPIKE === '1';

const FIXTURES = ['undangan-cid.pdf', 'surat-fragmen.pdf', 'surat-paragraf.pdf'];

function readFixtureBytes(name) {
  const buf = fs.readFileSync(path.join(FIXTURES_DIR, name));
  return Array.from(buf); // structured-cloneable for page.evaluate()
}

function fmt(n) {
  return `${n.toFixed(2)}ms`;
}

// Renders one fixture's Result into the flat rows the final report table
// prints — kept separate from collection so the printer can also handle the
// synthetic 30-page doc under the same shape.
function rowsFor(label, r) {
  return [
    `${label} — bytes:${r.fixtureBytes} candidates:${r.candidateCount}`,
    `  load        cold=${fmt(r.load.cold)}  median=${fmt(r.load.median)}  all=[${r.load.all.map(fmt).join(', ')}]  (warm reuse ~= ${r.load.warmReuseMs}ms)`,
    `  surgery     cold=${fmt(r.surgery.cold)}  median=${fmt(r.surgery.median)}  all=[${r.surgery.all.map(fmt).join(', ')}]  matched="${r.surgery.targetStr}"`,
    `  --- Variant A: whole-doc save ---`,
    `  save(A)     cold=${fmt(r.saveWholeDoc.cold)}  median=${fmt(r.saveWholeDoc.median)}  all=[${r.saveWholeDoc.all.map(fmt).join(', ')}]  outBytes=${r.savedBytesA_length}`,
    `  render(A)   cold=${fmt(r.renderA.cold)}  median=${fmt(r.renderA.median)}  all=[${r.renderA.all.map(fmt).join(', ')}]`,
    `  TOTAL A     cold=${fmt(r.totalA.cold)}  median=${fmt(r.totalA.median)}`,
    `  --- Variant B: page-scoped copyPages() + save ---`,
    `  save(B)     cold=${fmt(r.savePageScoped.cold)}  median=${fmt(r.savePageScoped.median)}  all=[${r.savePageScoped.all.map(fmt).join(', ')}]  outBytes=${r.savedBytesB_length}`,
    `  render(B)   cold=${fmt(r.renderB.cold)}  median=${fmt(r.renderB.median)}  all=[${r.renderB.all.map(fmt).join(', ')}]`,
    `  TOTAL B     cold=${fmt(r.totalB.cold)}  median=${fmt(r.totalB.median)}`,
    `  A vs B (median): save ${r.saveWholeDoc.median > r.savePageScoped.median ? 'A slower by' : 'B slower by'} ${fmt(Math.abs(r.saveWholeDoc.median - r.savePageScoped.median))} | total ${r.totalA.median > r.totalB.median ? 'A slower by' : 'B slower by'} ${fmt(Math.abs(r.totalA.median - r.totalB.median))}`,
  ];
}

test.describe('live-surgery commit timing (SPIKE — data collection, no threshold assertions)', () => {
  const allRows = [];

  for (const fixture of FIXTURES) {
    test(`measure: ${fixture}`, async ({ page }) => {
      test.skip(!RUN, 'spike-only: run with SPIKE=1 npx playwright test tests/spike/live-surgery-timing.spec.js');
      test.setTimeout(60_000);

      await page.goto('/tests/spike/live-surgery-timing.html');
      const bytesArray = readFixtureBytes(fixture);
      const result = await page.evaluate((b) => window.spikeMeasure(b), bytesArray);

      const rows = rowsFor(fixture, result);
      console.log(rows.join('\n'));
      allRows.push(rows);

      // Sanity only — never a threshold/perf assertion (founder's brief:
      // "assert nothing about thresholds, collect and print"). This just
      // proves the pipeline actually ran the real surgery, not a no-op.
      expect(result.surgery.matched, `surgery should match a real line in ${fixture}`).toBe(true);
      expect(result.load.cold).toBeGreaterThan(0);
      expect(result.saveWholeDoc.cold).toBeGreaterThan(0);
      expect(result.renderA.cold).toBeGreaterThan(0);
    });
  }

  test('measure: synthetic 30-page doc (surat-paragraf x30) — where architectures diverge', async ({ page }) => {
    test.skip(!RUN, 'spike-only: run with SPIKE=1 npx playwright test tests/spike/live-surgery-timing.spec.js');
    test.setTimeout(60_000);

    await page.goto('/tests/spike/live-surgery-timing.html');
    const baseBytes = readFixtureBytes('surat-paragraf.pdf');
    const largeBytesArray = await page.evaluate(
      (b) => window.spikeBuildLargeDoc(b, 30),
      baseBytes,
    );
    console.log(`\nsynthetic 30-page doc built: ${largeBytesArray.length} bytes (source surat-paragraf.pdf x30 via pdf-lib copyPages)`);

    const result = await page.evaluate((b) => window.spikeMeasure(b), largeBytesArray);
    const rows = rowsFor('surat-paragraf.pdf x30 (30 pages)', result);
    console.log(rows.join('\n'));
    allRows.push(rows);

    expect(result.surgery.matched).toBe(true);
  });

  test.afterAll(() => {
    if (!RUN || allRows.length === 0) return;
    console.log('\n\n========== LIVE-SURGERY TIMING SPIKE — FULL REPORT ==========\n');
    for (const rows of allRows) console.log(`${rows.join('\n')}\n`);
    console.log('===============================================================\n');
  });
});
