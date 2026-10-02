#!/usr/bin/env node
/*
 * The wild-corpus sweep: 154 real documents through import -> render -> export.
 *   node scripts/wild-sweep.mjs                  # forces the REBUILD path (default)
 *   node scripts/wild-sweep.mjs --passthrough    # the old no-op path: untouched docs come back as their own bytes
 *   SWEEP_WILD=/abs/path/to/corpus  SWEEP_ORIGIN=http://localhost:5067  (a lane's own port + a read-only corpus)
 *
 * Starts its own static server if one is not already up, and ALWAYS kills what
 * it started (see ensureServer/stopServer).
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
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WILD = process.env.SWEEP_WILD || path.join(ROOT, 'tests/fixtures/wild');
const NASTY = path.join(ROOT, 'tests/fixtures/nasty');
const ORIGIN = process.env.SWEEP_ORIGIN || 'http://localhost:5050';
const PORT = new URL(ORIGIN).port || '5050';
// Forcing the rebuild is the DEFAULT because the passthrough path makes the
// fidelity oracle compare a file with itself (see the note at the export stage).
const PASSTHROUGH = process.argv.includes('--passthrough');

/*
 * ⚠️ THIS SCRIPT OWNS ITS SERVER AND MUST KILL IT.
 * It used to say "run `npx serve` yourself" in the header. The servers that
 * left behind then outlived the sweep and starved the QA GATE: an isolated
 * re-run died on `Timed out waiting 60000ms from config.webServer`, and part
 * of a day's worth of "machine contention" was this script's litter. A harness
 * that degrades the instrument judging it is a bug in the harness.
 */
let server = null;
async function reachable() {
  try {
    const r = await fetch(ORIGIN + '/', { method: 'HEAD' });
    return r.ok || r.status < 500;
  } catch { return false; }
}
async function ensureServer() {
  if (await reachable()) return; // someone else's server: not ours to kill
  // detached:true puts it in its OWN PROCESS GROUP so the whole group can be
  // killed. `npx serve` spawns a CHILD; killing the npx wrapper alone leaves
  // the real server orphaned, which is exactly what happened on the first
  // attempt at this cleanup: the sweep finished, reported success, and left
  // two processes holding port 5050.
  server = spawn('npx', ['serve', '-l', PORT, '.'], { cwd: ROOT, stdio: 'ignore', detached: true });
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await reachable()) return;
  }
  throw new Error(`could not reach ${ORIGIN} after starting a server`);
}
function stopServer() {
  if (!server) return;
  const pid = server.pid;
  server = null;
  // Negative pid = the whole process group, which is the only way to take the
  // real server down with its npx wrapper.
  try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
}
// Every exit path, including Ctrl-C and an uncaught throw.
for (const sig of ['exit', 'SIGINT', 'SIGTERM', 'uncaughtException']) {
  process.on(sig, () => { stopServer(); if (sig !== 'exit') process.exit(1); });
}
const BATCH = Number(process.env.SWEEP_BATCH || 12);

const rows = fs.readFileSync(path.join(WILD, 'MANIFEST.tsv'), 'utf8').trim().split('\n');
const head = rows[0].split('\t');
// Two manifest layouts exist: wild/ (id, shape, ..., file) and wild/web/ (id,
// url, category, ... with the file named <id>.pdf).
const [iId, iShape, iFile] = ['id', 'shape', 'file'].map((k) => head.indexOf(k));
const iCategory = head.indexOf('category');
const CORPUS = rows.slice(1).map((r) => {
  const c = r.split('\t');
  return {
    id: c[iId],
    shape: iShape >= 0 ? c[iShape] : c[iCategory],
    file: path.join(WILD, iFile >= 0 ? c[iFile] : `${c[iId]}.pdf`),
  };
}).filter((e) => e.id && fs.existsSync(e.file));

// `corrupt` is the CONTROL path: it deliberately paints over the exported page
// before re-importing it. An oracle that has never disagreed with anything is
// decoration, so the comparison must be shown to go red on demand.
const IN_PAGE = async ({ src, corrupt, passthrough }) => {
  const dec = (s) => {
    const bin = atob(s);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  };
  const { createDoc } = await import('/js/core/model.js');
  const { importPdf, createPageRasterizer } = await import('/js/core/import.js');
  const { buildPdfBytes, passThroughSource } = await import('/js/core/export.js');
  const { createSource } = await import('/js/core/model.js');
  const { failureReason } = await import('/js/core/failure-reason.js');
  const { compareRegions } = await import('/js/core/visual-oracle.js');
  const { ensurePdfLib } = await import('/js/core/vendor.js');
  const { PDFLib, fontkit } = await ensurePdfLib();

  // dataUrl -> ImageData, so the oracle sees pixels rather than a string.
  const toImageData = (dataUrl, w, h) => new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0, w, h);
      res(g.getImageData(0, 0, w, h));
    };
    img.onerror = () => rej(new Error('raster decode failed'));
    img.src = dataUrl;
  });

  const shoot = async (bytes) => {
    const d = createDoc();
    await importPdf(d, { name: 'w.pdf', bytes });
    if (!d.pages.length) return null;
    const r = createPageRasterizer(d);
    const shot = await r.rasterize(d.pages[0], { scale: 1 });
    if (!shot || !shot.dataUrl) return null;
    return { pages: d.pages.length, img: await toImageData(shot.dataUrl, shot.width, shot.height) };
  };

  const doc = createDoc();
  let stage = 'import';
  try {
    await importPdf(doc, { name: 'w.pdf', bytes: dec(src) });
    if (!doc.pages.length) return { ok: false, stage: 'import', reason: 'no-pages' };
    const pagesIn = doc.pages.length;

    stage = 'render';
    const raster = createPageRasterizer(doc);
    const before = await raster.rasterize(doc.pages[0], { scale: 1 });
    if (!before || !before.dataUrl) return { ok: false, stage: 'render', reason: 'no-raster' };
    const imgBefore = await toImageData(before.dataUrl, before.width, before.height);

    stage = 'export';
    // ⚠️ THE REBUILD PATH IS FORCED HERE, and that is the point of this stage.
    // core/export.js passThroughSource hands an untouched single-source doc
    // straight back as its ORIGINAL BYTES (so an e-meterai survives a
    // download). Since 2026-09-09 that made this sweep half blind: for a no-op
    // run the fidelity oracle compared the file with ITSELF, and
    // copyPages/save were never exercised on a wild document. To sweep the real
    // save path we make the doc ineligible without changing one pixel of it:
    // a second, unused Source (passThroughSource requires exactly ONE). Pages,
    // annotations and rotation are untouched, so what is compared is still
    // "does a rebuild of this document look like the document", through the
    // very copyPages + save a subset/merge/rotate export takes.
    // `--passthrough` keeps the old no-op behaviour for comparison.
    if (!passthrough) {
      doc.sources.push(createSource({ name: 'unused.pdf', bytes: new Uint8Array([37, 80, 68, 70]), numPages: 1 }));
      // A forcing step that cannot be seen to fire is decoration (assertion
      // forces the check): prove the doc is no longer pass-through eligible.
      if (passThroughSource(doc)) return { ok: false, stage: 'export', reason: 'harness-rebuild-not-forced' };
    }
    const srcBytes = doc.sources[0].bytes;
    let out = await buildPdfBytes(doc, { PDFLib, fontkit });
    const rebuilt = !(out && out.length === srcBytes.length && out.every((b, i) => b === srcBytes[i]));
    if (!passthrough && !rebuilt) return { ok: false, stage: 'export', reason: 'harness-output-is-source-bytes' };
    if (!out || !out.length) return { ok: false, stage: 'export', reason: 'empty-output' };

    if (corrupt) {
      // Paint a black bar across the middle. A no-op export must not look like
      // this, so the oracle has to notice.
      const cd = await PDFLib.PDFDocument.load(out);
      const cp = cd.getPages()[0];
      const { width, height } = cp.getSize();
      cp.drawRectangle({ x: 0, y: height / 2 - height * 0.08, width, height: height * 0.16, color: PDFLib.rgb(0, 0, 0) });
      out = await cd.save();
    }

    // ---- FIDELITY, not just liveness -------------------------------------
    stage = 'roundtrip';
    const after = await shoot(out);
    if (!after) return { ok: false, stage: 'roundtrip', reason: 'reimport-failed' };

    // 1. STRUCTURAL: a no-op export must not lose or invent pages.
    if (after.pages !== pagesIn) {
      return { ok: false, stage: 'roundtrip', reason: 'page-count-changed', pagesIn, pagesOut: after.pages };
    }

    // 2. VISUAL: a no-op export must look like its input. This is the check
    // that would have caught the 2026-07-27 searchable-scan corruption on a
    // REAL file, instead of only on a fixture we wrote ourselves.
    const cmp = compareRegions(imgBefore, after.img);
    if (!cmp) return { ok: true, rebuilt, pages: pagesIn, cmp: null }; // blank page: no ink to compare, not a failure
    return { ok: true, rebuilt, pages: pagesIn, cmp: { ink: cmp.inkRatio, weight: cmp.weightRatio, height: cmp.heightRatio } };
  } catch (err) {
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

async function run(file, opts = {}) {
  try {
    return await page.evaluate(IN_PAGE, { src: b64(file), corrupt: opts.corrupt, passthrough: opts.passthrough ?? PASSTHROUGH });
  } catch {
    await fresh();
    try {
      return await page.evaluate(IN_PAGE, { src: b64(file), corrupt: opts.corrupt, passthrough: opts.passthrough ?? PASSTHROUGH });
    } catch {
      await fresh();
      // Twice, alone, on a brand-new browser. That is a document that kills a
      // browser, which is a finding.
      return { ok: false, stage: 'render', reason: 'killed-the-browser' };
    }
  }
}

await ensureServer();
await fresh();

// ---- controls, before anything is believed ---------------------------------
console.log('CONTROLS');
const good = await run(path.join(NASTY, 'surat-word.pdf'));
console.log(`  surat-word.pdf  ok=${good.ok} ${good.stage || ''} ${good.reason || ''}`);
if (!good.ok) throw new Error('a known-good document failed: the harness rejects everything');
// THE FORCING MUST BE SEEN TO DIFFER FROM THE BYPASS. The same known-good file,
// both ways: pass-through hands back its own bytes (rebuilt=false), the forced
// run must come back as a genuinely different file (rebuilt=true). If the two
// agree, this sweep is blind to copyPages/save again and says so before it
// touches the corpus.
{
  const bypass = await run(path.join(NASTY, 'surat-word.pdf'), { passthrough: true });
  const forced = await run(path.join(NASTY, 'surat-word.pdf'), { passthrough: false });
  console.log(`  rebuild control: passthrough rebuilt=${bypass.rebuilt}, forced rebuilt=${forced.rebuilt}`);
  if (bypass.rebuilt !== false) throw new Error('the pass-through control did not hand back the original bytes: the rebuilt flag cannot be trusted');
  if (forced.rebuilt !== true) throw new Error('the forced run did not rebuild the document: the sweep is blind to copyPages/save');
}
// terkunci.pdf is encrypted: pdf-lib cannot load it, so a REBUILD must fail it.
// Under --passthrough the untouched file is handed back as its own bytes and
// legitimately "succeeds" (export.js passThroughSource, SIDE BENEFIT), so the
// control is only known-broken on the rebuild path. The pre-2026-10-02 script
// asserted it broken unconditionally and would have died at this line.
const KNOWN_BROKEN = PASSTHROUGH ? ['terpotong.pdf'] : ['terpotong.pdf', 'terkunci.pdf'];
for (const n of KNOWN_BROKEN) {
  const v = await run(path.join(NASTY, n));
  console.log(`  ${n.padEnd(15)} ok=${v.ok} ${v.stage} ${v.reason}`);
  if (v.ok) throw new Error(`${n} is known-broken and came back OK: the harness detects nothing`);
}

// ---- THE ORACLE MUST BE ABLE TO DISAGREE -----------------------------------
// A visual comparison that has never objected to anything is decoration. Run a
// known-good document twice: once clean, once with a black bar painted across
// the exported page before re-import. The clean pass sets the noise floor; the
// corrupted one must fall clearly outside it, or the comparison cannot see a
// change the size of a black bar and has no business judging 154 documents.
const clean = await run(path.join(NASTY, 'surat-word.pdf'));
const dirty = await run(path.join(NASTY, 'surat-word.pdf'), { corrupt: true });
const fmt = (c) => (c ? `ink=${c.ink.toFixed(3)} weight=${c.weight.toFixed(3)} height=${c.height.toFixed(3)}` : 'null');
console.log(`\nORACLE CONTROL\n  clean      ${fmt(clean.cmp)}\n  corrupted  ${fmt(dirty.cmp)}`);
if (!clean.cmp) throw new Error('the oracle returned null on a clean round trip: it cannot measure anything');
if (!dirty.cmp) throw new Error('the oracle returned null on a corrupted export: it cannot measure anything');
if (Math.abs(dirty.cmp.ink - 1) <= Math.abs(clean.cmp.ink - 1) * 3 + 0.05) {
  throw new Error(
    `the oracle barely noticed a black bar across the page (clean ink=${clean.cmp.ink.toFixed(3)}, `
    + `corrupted ink=${dirty.cmp.ink.toFixed(3)}). It cannot distinguish a corrupted export from a `
    + 'faithful one, so every "ok" below would be meaningless.',
  );
}
// The clean pass also defines the tolerance: a no-op export is re-encoded, so
// exact equality is not the bar. Anything outside this band is a real change.
const INK_TOLERANCE = Math.max(0.05, Math.abs(clean.cmp.ink - 1) * 4);
console.log(`  -> tolerance: ink within ${INK_TOLERANCE.toFixed(3)} of 1.000`);

// ---- the sweep -------------------------------------------------------------
const results = [];
let since = 0;
for (const e of CORPUS) {
  if (since >= BATCH) { await fresh(); since = 0; }
  let v = await run(e.file);
  // Liveness passed; now judge FIDELITY against the measured tolerance.
  if (v.ok && v.cmp && Math.abs(v.cmp.ink - 1) > INK_TOLERANCE) {
    v = { ...v, ok: false, stage: 'roundtrip', reason: 'visual-drift' };
  }
  since += 1;
  results.push({ ...e, ...v });
  if (!v.ok) {
    const extra = v.cmp ? ` ink=${v.cmp.ink.toFixed(3)}` : '';
    console.log(`  ${e.id} ${e.shape.padEnd(16)} ${v.stage}/${v.reason}${extra}`);
  }
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
const rebuiltN = results.filter((r) => r.rebuilt).length;
console.log(`\n===== ${results.length} documents, ${fails.length} failures, ${rebuiltN} went through copyPages/save (${PASSTHROUGH ? 'PASSTHROUGH mode' : 'forced rebuild'}) =====`);
for (const [k, v] of Object.entries(byShape)) console.log(`  ${k.padEnd(18)} ${String(v.n).padStart(3)} files, ${v.fail} failed`);
const grouped = {};
for (const f of fails) (grouped[`${f.stage}/${f.reason}`] ||= []).push(f.id);
console.log('');
for (const [k, ids] of Object.entries(grouped)) console.log(`  ${k.padEnd(26)} ${String(ids.length).padStart(3)}  ${ids.join(' ')}`);

fs.mkdirSync(path.join(ROOT, 'test-results'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'test-results/wild-sweep.json'),
  JSON.stringify({ byShape, failures: fails.map((f) => ({ id: f.id, shape: f.shape, stage: f.stage, reason: f.reason })) }, null, 1));

// The harness's own health is the last thing asserted, because every result
// after a crash is unreliable and "some files passed" is far too weak a check.
if (killed.length > 4) {
  console.log(`\n⚠️ ${killed.length} documents killed a browser. Above a handful this is the harness, not the corpus.`);
  process.exit(1);
}
console.log(`\nharness healthy: ${killed.length} browser deaths`);
