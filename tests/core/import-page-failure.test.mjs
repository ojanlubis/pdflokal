/*
 * A PDF WHOSE PAGE TREE BREAKS MID-IMPORT LEAVES NOTHING BEHIND.
 * ============================================================================
 * importPdf added the Source BEFORE walking the pages and destroyed the PDF.js
 * document only on success. A file whose getDocument() succeeds but whose
 * getPage(k) throws (a broken page tree) then leaked the PDF.js document (up
 * to a 50MB copy in its worker) and left a Source with no pages in the doc,
 * so the next single-file open saw `doc.sources.length > 0` and took the MERGE
 * path (app.js loadFilesInner), where a file pdf-lib cannot parse is refused.
 * Driven with a stub pdf.js: the property is about bookkeeping, not parsing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

function stubPdfJs({ failAt }) {
  const state = { destroyed: 0 };
  const pdf = {
    numPages: 3,
    getPage: async (n) => {
      if (n === failAt) throw new Error('Invalid page tree');
      return { rotate: 0, getViewport: () => ({ width: 595, height: 842 }) };
    },
    getMetadata: async () => ({ info: {} }),
    destroy: async () => { state.destroyed += 1; },
  };
  globalThis.window = { pdfjsLib: { getDocument: () => ({ promise: Promise.resolve(pdf) }) } };
  return state;
}

const { importPdf } = await import('../../js/core/import.js');
const { createDoc } = await import('../../js/core/model.js');

test('1. known-positive: a healthy file imports every page, adds one Source, and frees PDF.js', async () => {
  const state = stubPdfJs({ failAt: -1 });
  const doc = createDoc();
  const pages = await importPdf(doc, { name: 'a.pdf', bytes: new Uint8Array([1, 2, 3]) });
  assert.equal(pages.length, 3);
  assert.equal(doc.sources.length, 1);
  assert.equal(state.destroyed, 1);
});

test('2. a page that fails to load: the error surfaces, no orphan Source, PDF.js still destroyed', async () => {
  const state = stubPdfJs({ failAt: 2 });
  const doc = createDoc();
  await assert.rejects(importPdf(doc, { name: 'b.pdf', bytes: new Uint8Array([1, 2, 3]) }), /page tree/);
  assert.equal(doc.sources.length, 0, 'a Source with no pages was left in the doc');
  assert.equal(doc.pages.length, 0);
  assert.equal(state.destroyed, 1, 'the PDF.js document leaked');
});
