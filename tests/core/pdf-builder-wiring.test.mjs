/*
 * Both PDF download routes must share the same browser-edge adapter. Keeping
 * PDF-lib loading and the font-fallback witness in each UI caller already made
 * the two paths drift into different import strategies.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { buildPdfArtifact } = await import('../../js/v2/pdf-builder.js');

test('buildPdfArtifact returns the bytes and whether a fallback happened', async () => {
  const depsSeen = [];
  const result = await buildPdfArtifact({ pages: ['page'] }, {
    loadPdfLib: async () => ({ PDFLib: 'pdf-lib', fontkit: 'fontkit' }),
    buildPdf: async (doc, deps) => {
      assert.deepEqual(doc.pages, ['page']);
      depsSeen.push(deps.PDFLib, deps.fontkit);
      // The glyph fallback rides through this same adapter (2026-09-06): every
      // UI route gets the browser rasteriser, or a ✓ in Helvetica kills the
      // export again for whichever route forgot it.
      assert.equal(typeof deps.rasterizeText, 'function', 'the adapter must inject rasterizeText');
      deps.onFontFallback();
      return new Uint8Array([37, 80, 68, 70]);
    },
  });

  assert.deepEqual(depsSeen, ['pdf-lib', 'fontkit']);
  assert.deepEqual([...result.bytes], [37, 80, 68, 70]);
  assert.equal(result.fontFallback, true);
});

test('buildPdfArtifact keeps a clean build distinct from a substituted one', async () => {
  const result = await buildPdfArtifact({}, {
    loadPdfLib: async () => ({ PDFLib: {}, fontkit: {} }),
    buildPdf: async () => new Uint8Array([1]),
  });
  assert.equal(result.fontFallback, false);
});

test('both UI routes use the adapter instead of rebuilding its logic', () => {
  for (const file of ['js/v2/app.js', 'js/v2/download-sheet.js']) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(source, /buildPdfArtifact\s*\(/, `${file} does not call the shared PDF builder`);
    assert.doesNotMatch(source, /buildPdfBytes\s*\(/,
      `${file} still calls the core exporter directly, so the duplicate survives`);
  }
});
