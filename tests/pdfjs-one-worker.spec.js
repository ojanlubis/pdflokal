/*
 * ONE PDF.js WORKER FOR THE WHOLE SESSION, EDITED PAGES INCLUDED.
 * ============================================================================
 * pdf.js 3.x spawns a new Web Worker for every getDocument() not handed one.
 * Opening a file used three (import, the text-layer probe, the rasterizer's
 * source), Ganti added one for the text-run index, and every edited page added
 * one more that stayed alive for the session. js/core/pdfjs-open.js now hands
 * all of them one shared worker. tests/core/pdfjs-shared-worker.test.mjs
 * proves the call sites headlessly; this proves the real browser spawns ONE.
 *
 * Instrument: the init script counts `new Worker(...pdf.worker...)` and every
 * GetDocRequest message posted to any worker (pdf.js's "open this document").
 * The second is the vacuity guard: it proves the edited page really opened a
 * document AFTER the commit, so "still one worker" is not read too early.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { armGanti, tapLine } from './helpers/lines.js';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FX = (name) => path.join(__dirname, 'fixtures', name);

test('opening, Ganti and an edited page all run on one pdf.js worker', async ({ page }) => {
  await page.addInitScript(() => {
    const stats = { workers: 0, docOpens: 0 };
    window.__pdfjsWorkerStats = stats;
    const Native = window.Worker;
    const nativePost = Native.prototype.postMessage;
    Native.prototype.postMessage = function (msg, ...rest) {
      if (msg && msg.action === 'GetDocRequest') stats.docOpens += 1;
      return nativePost.call(this, msg, ...rest);
    };
    window.Worker = class extends Native {
      constructor(url, opts) {
        if (String(url).includes('pdf.worker')) stats.workers += 1;
        super(url, opts);
      }
    };
  });
  const stats = () => page.evaluate(() => ({ ...window.__pdfjsWorkerStats }));

  await page.goto('/');
  await page.setInputFiles('#file-input', FX('sample-2pages.pdf'));
  await expectFirstPage(page);

  await armGanti(page);
  await tapLine(page, { str: 'Test Page 1' });
  await page.keyboard.type('Surat Baru');
  const before = (await stats()).docOpens;
  await page.keyboard.press('Enter');

  // VACUITY GUARD: the edited page's own document was opened after the commit
  // (and the open itself went through a REAL worker, not pdf.js's fake one).
  await expect.poll(async () => (await stats()).docOpens,
    { message: 'the edited page never opened a document, so the worker count proves nothing' })
    .toBeGreaterThan(before);
  const s = await stats();
  expect(s.docOpens, 'KNOWN-POSITIVE: several documents were opened this session').toBeGreaterThanOrEqual(3);
  expect(s.workers, 'each document spawned its own pdf.js worker').toBe(1);
});
