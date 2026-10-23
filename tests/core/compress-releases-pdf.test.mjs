/*
 * A COMPRESSION THAT FAILS MID-DOCUMENT STILL RELEASES ITS PDF.js DOCUMENT.
 * ============================================================================
 * compressOnce called pdf.destroy() only after the page loop, so a page that
 * threw (a corrupt page, an out-of-memory canvas on a phone) left the whole
 * PDF.js document and its worker-side copy resident. The compress ladder runs
 * several rungs per Unduh, so one bad page could strand it several times.
 * Round-3 hunt, 2026-10-10.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { compressPdfBytes } = await import('../../js/core/compress.js');

function fakePdfjs({ failOnPage }) {
  const state = { destroyed: 0, pagesRead: 0 };
  const pdfjsLib = {
    getDocument: () => ({ promise: Promise.resolve({
      numPages: 3,
      getPage: async (n) => {
        state.pagesRead += 1;
        if (n === failOnPage) throw new Error('page is corrupt');
        return { getViewport: () => ({ width: 10, height: 10 }), render: () => ({ promise: Promise.resolve() }), cleanup() {} };
      },
      destroy: async () => { state.destroyed += 1; },
    }) }),
  };
  return { pdfjsLib, state };
}

test('a page that throws still destroys the PDF.js document', async () => {
  const { pdfjsLib, state } = fakePdfjs({ failOnPage: 1 });
  await assert.rejects(compressPdfBytes(new Uint8Array(100), { PDFLib: { PDFDocument: { create: async () => ({}) } }, pdfjsLib }), /corrupt/);
  assert.equal(state.pagesRead, 1, 'VACUITY GUARD: the failure happened inside the page loop');
  assert.equal(state.destroyed, 1, 'the PDF.js document was stranded');
});
