#!/usr/bin/env node
/*
 * The wild-corpus sweep: 154 real documents through import -> render -> export.
 *   npx serve -l 5050 .   (in another shell)
 *   node scripts/wild-sweep.mjs
 *
 * WHY A SCRIPT AND NOT A PLAYWRIGHT TEST. Some of these documents kill the
 * BROWSER PROCESS, not just the page. Inside the test runner the browser is a
 * shared fixture, so the first crash takes the whole sweep with it and
 * `browser.newContext` then fails with "Target page, context or browser has
 * been closed" - the harness cannot even report what it had found. Owning the
 * launch means a crash costs ONE FILE and the loop continues.
 *
 * ⭐ THE HARNESS PROVES ITSELF BEFORE THE CORPUS IS TOUCHED, and it has already
 * earned that twice:
 *   - the first version called a rasterizer method that does not exist, so
 *     every document came back render/unknown. The known-GOOD control is the
 *     only reason that was caught instead of published as 154 findings.
 *   - the second version reported 47 failures, of which 45 were the page dying
 *     of accumulated memory from w110 onward. A crashed harness looks exactly
 *     like a hostile corpus, and it manufactures bugs that do not exist.
 *
 * ⚠️ PRIVACY: real client documents. Cite ids w001-w154 only, never filenames,
 * never extracted text, never producer strings.
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WILD = path.join(ROOT, 'tests/fixtures/wild');
const NASTY = path.join(ROOT, 'tests/fixtures/nasty');
const ORIGIN = process.env.SWEEP_ORIGIN || 'http://localhost:5050';
const BATCH = Number(process.env.SWEEP_BATCH || 12);

const rows = fs.readFileSync(path.join(WILD, 'MANIFEST.tsv'), 'utf8').trim().split('\n');
const head = rows[0].split('\t');
const [iId, iShape, iFile] = ['id', 'shape', 'file'].map((k) => head.indexOf(k));
const CORPUS = rows.slice(1).map((r) => {
  const c = r.split('\t');
  return { id: c[iId], shape: c[iShape], file: path.join(WILD, c[iFile]) };
}).filter((e) => e.id && fs.existsSync(e.file));

const IN_PAGE = async (src) => {
  const dec = (s) => {
    const bin = atob(s);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  };
  const { createDoc } = await import('/js/core/model.js');
  const { importPdf, createPageRasterizer } = await import('/js/core/import.js');
  const { buildPdfBytes } = await import('/js/core/export.js');
  const { failureReason } = await import('/js/core/failure-reason.js');
  const { ensurePdfLib } = await import('/js/core/vendor.js');
  const { PDFLib, fontkit } = await ensurePdfLib();

  const doc = createDoc();
  let stage = 'import';
  try {
    await importPdf(doc, { name: 'w.pdf', bytes: dec(src) });
    if (!doc.pages.length) return { ok: false, stage: 'import', reason: 'no-pages' };
    stage = 'render';
    const raster = createPageRasterizer(doc);
    const shot = await raster.rasterize(doc.pages[0], { scale: 1 });
    if (!shot || !shot.dataUrl) return { ok: false, stage: 'render', reason: 'no-raster' };
    stage = 'export';
    const out = await buildPdfBytes(doc, { PDFLib, fontkit });
    if (!out || !out.length) return { ok: false, stage: 'export', reason: 'empty-output' };
    return { ok: true, pages: doc.pages.length };
  } catch (err) {
    // Bucketed reason ONLY. An error message can quote the document.
    return { ok: false, stage, reason: failureReason(err) };
  }
};

let browser = null;
let page = null;
async function fresh() {
  if (browser) { try { await browser.close(); } catch { /* already gone */ } }
  browser = await chromium.launch();
  page = await (await browser.newContext()).newPage();
  await page.goto(ORIGIN + '/');
}
const b64 = (f) => fs.readFileSync(f).toString('base64');

async function run(file) {
  try {
    return await page.evaluate(IN_PAGE, b64(file));
  } catch {
    await fresh();
    try {
      return await page.evaluate(IN_PAGE, b64(file));
    } catch {
      await fresh();
      // Twice, alone, on a brand-new browser. That is a document that kills a
      // browser, which is a finding.
      return { ok: false, stage: 'render', reason: 'killed-the-browser' };
    }
  }
}

await fresh();

// ---- controls, before anything is believed ---------------------------------
console.log('CONTROLS');
const good = await run(path.join(NASTY, 'surat-word.pdf'));
console.log(`  surat-word.pdf  ok=${good.ok} ${good.stage || ''} ${good.reason || ''}`);
if (!good.ok) throw new Error('a known-good document failed: the harness rejects everything');
for (const n of ['terpotong.pdf', 'terkunci.pdf']) {
  const v = await run(path.join(NASTY, n));
  console.log(`  ${n.padEnd(15)} ok=${v.ok} ${v.stage} ${v.reason}`);
  if (v.ok) throw new Error(`${n} is known-broken and came back OK: the harness detects nothing`);
}

// ---- the sweep -------------------------------------------------------------
const results = [];
let since = 0;
for (const e of CORPUS) {
  if (since >= BATCH) { await fresh(); since = 0; }
  const v = await run(e.file);
  since += 1;
  results.push({ ...e, ...v });
  if (!v.ok) console.log(`  ${e.id} ${e.shape.padEnd(16)} ${v.stage}/${v.reason}`);
}
try { await browser.close(); } catch { /* done */ }

const fails = results.filter((r) => !r.ok);
const killed = fails.filter((r) => r.reason === 'killed-the-browser');
const byShape = {};
for (const r of results) {
  byShape[r.shape] = byShape[r.shape] || { n: 0, fail: 0 };
  byShape[r.shape].n += 1;
  if (!r.ok) byShape[r.shape].fail += 1;
}
console.log(`\n===== ${results.length} documents, ${fails.length} failures =====`);
for (const [k, v] of Object.entries(byShape)) console.log(`  ${k.padEnd(18)} ${String(v.n).padStart(3)} files, ${v.fail} failed`);
const grouped = {};
for (const f of fails) (grouped[`${f.stage}/${f.reason}`] ||= []).push(f.id);
console.log('');
for (const [k, ids] of Object.entries(grouped)) console.log(`  ${k.padEnd(26)} ${String(ids.length).padStart(3)}  ${ids.join(' ')}`);

fs.writeFileSync(path.join(ROOT, 'test-results/wild-sweep.json'),
  JSON.stringify({ byShape, failures: fails.map((f) => ({ id: f.id, shape: f.shape, stage: f.stage, reason: f.reason })) }, null, 1));

// The harness's own health is the last thing asserted, because every result
// after a crash is unreliable and "some files passed" is far too weak a check.
if (killed.length > 4) {
  console.log(`\n⚠️ ${killed.length} documents killed a browser. Above a handful this is the harness, not the corpus.`);
  process.exit(1);
}
console.log(`\nharness healthy: ${killed.length} browser deaths`);
