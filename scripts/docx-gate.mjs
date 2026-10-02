#!/usr/bin/env node
/*
 * THE PDF -> DOCX GATE (scripts/docx-gate.mjs). Converts the wild web corpus with js/docx/,
 * scores every output, compares against a BASELINE, exits non-zero on a regression.
 * Grown from the 2026-10-02 spike harness; its metrics are unchanged so spike numbers stay comparable.
 *
 *   node scripts/docx-gate.mjs                         full corpus, first 40 pages, compare to scripts/docx-baseline.json
 *   node scripts/docx-gate.mjs --files n001,n017       a subset (fast lane loop); compared to the SAME files in the baseline
 *   node scripts/docx-gate.mjs --no-render             skip LibreOffice (recallRendered, vis*, pageRatio become n/a)
 *   node scripts/docx-gate.mjs --write-baseline        full run, then (re)write scripts/docx-baseline.json
 *   node scripts/docx-gate.mjs --baseline X.csv        compare against a spike results.csv (same column names)
 *   node scripts/docx-gate.mjs --self-test             prove the instruments and the exit code can go red
 *
 *   --pages [N]                  also render a deterministic sample of N files (default 12) with Apple Pages (osascript, serial,
 *                                steals focus) and score recall: recallPages / pagesRatio / pagesFail. See scripts/lib/pages-render.mjs.
 *   options: --no-schema (skip the XSD validation)  --maxpages N|all (40)  --jobs N (4)  --out DIR  --lane NAME (LibreOffice profiles
 *            /tmp/lo-NAME-PID-SLOT, so parallel lanes never share one)  --cache DIR  --resume
 *            (reuse an earlier convert in --out instead of reconverting)  --no-perf (time and memory
 *            are reported, not gated)  --engine pdf2docx (the reference engine, see PDF2DOCX_PY)
 *   env:     CORPUS (default tests/fixtures/wild/web), SOFFICE (default /opt/homebrew/bin/soffice)
 *   exit:    0 pass, 1 a headline metric regressed past its tolerance, 2 the harness itself is broken
 *
 * Corpus: READ ONLY and gitignored (real third-party PDFs: ids only in anything you share).
 *
 * WHAT IS MEASURED, and by what (an instrument must not share a parent with the thing it measures):
 *   recallBag / recallLcs        words of the written .docx vs pdf.js's own text (a SECOND reading by
 *                                the same pdf.js: see the Poppler columns for an independent one)
 *   recallBagPoppler / ...Lcs    the same against poppler's pdftotext (an independent extractor)
 *   recallRendered               words LibreOffice finds when it RENDERS the .docx, vs pdf.js
 *   visGrid / visBody / visRows  Pearson correlation of the ink layout, page 1 and a body page,
 *                                original (pdftoppm) vs the LibreOffice render of the .docx
 *   pageRatio                    pages in the render / pages converted (1.00 = same pagination)
 *   docxParas, bold, italic, images (w:drawing), tables (w:tbl), shapes (wps:wsp)   counted in the XML
 *   ms / rssMB                   conversion wall time and PEAK RESIDENT SET of the converting process
 *                                alone (its own child process, so metric gathering cannot inflate it);
 *                                at --maxpages 40, NOT the 766-page worst case the spike reported
 *   strictOk / xsdOk             scripts/lib/docx-validate.mjs: the Word-strict structure rules (element order in
 *                                pPr/rPr/tblPr/tcPr/sectPr, a cell ends with a paragraph, grid widths, unique drawing
 *                                ids, package and image-byte integrity) and EVERY XML part against the ECMA-376
 *                                transitional, OPC and MS-ODRAWXML (wps) schemas through xmllint. Hard failures.
 *                                --no-schema skips the XSD half (reported as n/a, never as green).
 *   xmlOk / pkgOk                every XML part well-formed (xmllint AND scripts/lib/docx-xml.mjs;
 *                                xmllint prints namespace errors but exits 0, so ANY stderr counts),
 *                                and the package's content types / rels / ids resolve
 *   child mode:  --convert ID | --ref ID   (one file, own process, so a hang or crash costs one row)
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { xmlProblems, packageProblems } from './lib/docx-xml.mjs';
import { validateDocx, structureProblems, xsdProblems, xmllintAvailable } from './lib/docx-validate.mjs';
import { ensureSchemas } from './lib/ooxml-schemas.mjs';
import { pagesAvailable, renderWithPages, quitPages } from './lib/pages-render.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = process.env.CORPUS || (fs.existsSync(path.join(ROOT, 'tests/fixtures/wild/web')) ? path.join(ROOT, 'tests/fixtures/wild/web') : '/Users/ojanlubis/machine/fkd/pdflokal/app/tests/fixtures/wild/web');
const SOFFICE = process.env.SOFFICE || '/opt/homebrew/bin/soffice';
const PY = process.env.PDF2DOCX_PY || '';
const BASELINE_DEFAULT = path.join(ROOT, 'scripts/docx-baseline.json');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };
const LANE = String(arg('lane', 'gate')).replace(/[^\w-]/g, '');
const OUT = arg('out', path.join(os.tmpdir(), `docx-gate-${LANE}`));
const MAXPAGES = arg('maxpages', '40') === 'all' ? 1e9 : Number(arg('maxpages', 40));
const JOBS = Number(arg('jobs', 4));
const ENGINE = arg('engine', 'ours');
const CACHE = arg('cache', path.join(os.tmpdir(), 'docx-gate-cache'));
const CONVERT_ONE = arg('convert', null);
const REF_ONE = arg('ref', null);

// ------------------------------------------------------------- tolerances ---
// Headline metrics and how far each may move the wrong way before the gate goes red.
// QUALITY metrics are deterministic: MEASURED 2026-10-02, three full runs of identical code, same
// corpus, same LibreOffice: 0 of 104 x ~60 cells differed (so the noise floor is 0, and these
// tolerances are POLICY, not noise: how much of one metric a lane may trade away; a lane that
// deliberately trades more updates the baseline in the same commit and says why).
// PERF metrics are machine- and load-dependent. MEASURED over the same three runs (load average ~8
// on 10 cores): corpus-level medians moved +-8% (ms/page median), +-9% (p90), +-6% (peak RSS);
// single files moved far more (median per-file spread 22%, p90 51%), so only corpus-level
// aggregates are gated, with a margin of ~3x the measured wobble. The committed baseline is THIS
// laptop at --jobs 4, cold start (library load outside the clock, JIT and the pdf.js worker cold:
// the spike's v3 ms were warm and read ~2x lower); on another machine re-record it.
// `abs` = absolute drop/rise allowed; `rel` = fraction of the baseline value.
export const HEADLINE = [
  { id: 'failures', label: 'files that failed to convert', get: (s) => s.failures, better: 'lower', abs: 0 },
  { id: 'xmlBad', label: 'files with malformed XML', get: (s) => s.xmlBad, better: 'lower', abs: 0 },
  { id: 'pkgBad', label: 'files with a broken package', get: (s) => s.pkgBad, better: 'lower', abs: 0 },
  { id: 'strictBad', label: 'files failing the Word-strict structure checks', get: (s) => s.strictBad, better: 'lower', abs: 0 },
  { id: 'xsdBad', label: 'files failing ECMA-376 / OPC / wps schema validation', get: (s) => s.xsdBad, better: 'lower', abs: 0, needs: 'schema' },
  { id: 'pagesFail', label: 'sampled files Apple Pages could not open or export', get: (s) => s.pagesFail, better: 'lower', abs: 0, needs: 'pages' },
  { id: 'recallPages.mean', label: 'recall after Apple Pages render (sample), mean', get: (s) => s.mean.recallPages, better: 'higher', abs: 0.01, needs: 'pages' },
  { id: 'renderFail', label: 'files LibreOffice could not render', get: (s) => s.renderFail, better: 'lower', abs: 0, needs: 'render' },
  { id: 'severe', label: 'files whose word recall fell > 0.05 or that now fail', get: (s) => s.severe, better: 'lower', abs: 0 },
  { id: 'recallBag.mean', label: 'recall (bag vs pdf.js), mean', get: (s) => s.mean.recallBag, better: 'higher', abs: 0.002 },
  { id: 'recallBag.p10', label: 'recall (bag vs pdf.js), p10', get: (s) => s.p10.recallBag, better: 'higher', abs: 0.005 },
  { id: 'recallLcs.mean', label: 'recall (in order, LCS vs pdf.js), mean', get: (s) => s.mean.recallLcs, better: 'higher', abs: 0.004 },
  { id: 'recallLcs.median', label: 'recall (LCS vs pdf.js), median', get: (s) => s.median.recallLcs, better: 'higher', abs: 0.004 },
  { id: 'recallLcs.p10', label: 'recall (LCS vs pdf.js), p10', get: (s) => s.p10.recallLcs, better: 'higher', abs: 0.01 },
  { id: 'recallBagPoppler.mean', label: 'recall (bag vs poppler), mean', get: (s) => s.mean.recallBagPoppler, better: 'higher', abs: 0.003 },
  { id: 'recallLcsPoppler.mean', label: 'recall (LCS vs poppler), mean', get: (s) => s.mean.recallLcsPoppler, better: 'higher', abs: 0.004 },
  { id: 'recallRendered.mean', label: 'recall after LibreOffice render, mean', get: (s) => s.mean.recallRendered, better: 'higher', abs: 0.003, needs: 'render' },
  { id: 'visGrid.mean', label: 'visual match page 1, mean', get: (s) => s.mean.visGrid, better: 'higher', abs: 0.01, needs: 'render' },
  { id: 'visBody.mean', label: 'visual match body page, mean', get: (s) => s.mean.visBody, better: 'higher', abs: 0.015, needs: 'render' },
  { id: 'pageDev.mean', label: '|pageRatio - 1|, mean (pagination drift)', get: (s) => s.mean.pageDev, better: 'lower', abs: 0.01, needs: 'render' },
  { id: 'linePerPara', label: 'prose files with ~one paragraph per line', get: (s) => s.linePerPara, better: 'lower', abs: 0 },
  { id: 'boldKept', label: 'bold words kept (docx / pdf)', get: (s) => s.boldKept, better: 'higher', abs: 0.01 },
  { id: 'italicKept', label: 'italic words kept (docx / pdf)', get: (s) => s.italicKept, better: 'higher', abs: 0.01 },
  { id: 'pictures', label: 'pictures in the .docx (total)', get: (s) => s.pictures, better: 'higher', rel: 0.03 },
  { id: 'tables', label: 'Word tables (total)', get: (s) => s.tables, better: 'higher', rel: 0.05 },
  { id: 'msPerPage.median', label: 'ms per page, median', get: (s) => s.median.msPerPage, better: 'lower', rel: 0.3, perf: true },
  { id: 'msPerPage.p90', label: 'ms per page, p90', get: (s) => s.p90.msPerPage, better: 'lower', rel: 0.4, perf: true },
  { id: 'rssMB.max', label: 'peak RSS of one conversion, max (MB)', get: (s) => s.max.rssMB, better: 'lower', rel: 0.2, perf: true },
];
// Per-file drops that are REPORTED (top offenders) but do not by themselves fail the gate.
const PER_FILE = [['recallBag', 0.01], ['recallLcs', 0.03], ['recallBagPoppler', 0.02], ['recallRendered', 0.02], ['visGrid', 0.1], ['visBody', 0.1]];
const SEVERE_DROP = 0.05;

const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global', 'define',
    fs.readFileSync(path.join(ROOT, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis, undefined);
  return module.exports;
};

// ---------------------------------------------------------------- tokens ---
const tokens = (s) => (String(s).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);

// Bit-parallel LCS length (Hyyro) over integer-coded words.
function lcsLen(a, b) {
  const n = a.length;
  if (!n || !b.length) return 0;
  const W = (n + 31) >>> 5;
  const masks = new Map();
  for (let i = 0; i < n; i += 1) {
    let m = masks.get(a[i]);
    if (!m) { m = new Uint32Array(W); masks.set(a[i], m); }
    m[i >>> 5] |= (1 << (i & 31));
  }
  const V = new Uint32Array(W).fill(0xFFFFFFFF);
  for (const sym of b) {
    const M = masks.get(sym);
    if (!M) continue;
    let carry = 0;
    for (let w = 0; w < W; w += 1) {
      const v = V[w];
      const sum = v + (v & M[w]) + carry;
      carry = sum > 0xFFFFFFFF ? 1 : 0;
      V[w] = ((sum >>> 0) | (v & ~M[w])) >>> 0;
    }
  }
  let zeros = 0;
  for (let i = 0; i < n; i += 1) if (!((V[i >>> 5] >>> (i & 31)) & 1)) zeros += 1;
  return zeros;
}
function recall(ref, got) {
  if (!ref.length) return { bag: null, lcs: null, truncated: false };
  const ids = new Map();
  const id = (w) => { let k = ids.get(w); if (k === undefined) { k = ids.size; ids.set(w, k); } return k; };
  const CAP = 60000;
  const truncated = ref.length > CAP;
  const r = (truncated ? ref.slice(0, CAP) : ref).map(id);
  const g = (truncated ? got.slice(0, Math.ceil(CAP * (got.length / ref.length) * 1.15)) : got).map(id);
  const bag = new Map();
  for (const x of g) bag.set(x, (bag.get(x) || 0) + 1);
  let hit = 0;
  for (const x of r) { const c = bag.get(x) || 0; if (c > 0) { hit += 1; bag.set(x, c - 1); } }
  return { bag: hit / r.length, lcs: lcsLen(r, g) / r.length, truncated };
}

// ------------------------------------------------------------ docx parse ---
const fflateLib = () => (fflateLib.v ||= loadUmd('js/vendor/fflate.min.js'));
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
export function parseDocxXml(xml, mediaFiles) {
  const paras = xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || [];
  let text = '';
  let nonEmpty = 0;
  let bold = 0;
  let italic = 0;
  const flag = (rpr, tag) => new RegExp(`<w:${tag}(/>| [^>]*/>)`).test(rpr) && !new RegExp(`<w:${tag} [^>]*w:val="(0|false)"`).test(rpr);
  for (const p of paras) {
    let pt = '';
    for (const r of p.match(/<w:r[ >][\s\S]*?<\/w:r>/g) || []) {
      const rpr = (r.match(/<w:rPr>[\s\S]*?<\/w:rPr>/) || [''])[0];
      let t = '';
      for (const m of r.matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)) t += m[1] !== undefined ? decode(m[1]) : ' ';
      pt += t;
      const n = tokens(t).length;
      if (flag(rpr, 'b')) bold += n;
      if (flag(rpr, 'i')) italic += n;
    }
    if (tokens(pt).length) nonEmpty += 1;
    text += `${pt} `;
  }
  return {
    words: tokens(text),
    paras: nonEmpty,
    bold,
    italic,
    drawings: (xml.match(/<w:drawing>/g) || []).length,
    shapes: (xml.match(/<wps:wsp[ >]/g) || []).length,
    mediaFiles,
    tables: (xml.match(/<w:tbl>/g) || []).length,
    sections: (xml.match(/<w:sectPr[ >]/g) || []).length,
  };
}
export function parseDocx(file) {
  const files = fflateLib().unzipSync(new Uint8Array(fs.readFileSync(file)));
  return parseDocxXml(fflateLib().strFromU8(files['word/document.xml']), Object.keys(files).filter((k) => k.startsWith('word/media/')).length);
}

// xmllint is the independent witness (libxml2). It exits 0 on a NAMESPACE error and only prints it,
// so a clean run is exit 0 AND empty stderr. Returns null when xmllint is not installed.
let xmllintPresent;
function xmllintProblems(files, scratch) {
  if (xmllintPresent === undefined) { const v = spawnSync('xmllint', ['--version'], { encoding: 'utf8' }); xmllintPresent = !v.error && v.status === 0; }
  if (!xmllintPresent) return null;
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(scratch, { recursive: true });
  const names = Object.keys(files).filter((n) => /\.(xml|rels)$/.test(n));
  const paths = names.map((n, i) => { const p = path.join(scratch, `p${i}.xml`); fs.writeFileSync(p, files[n]); return p; });
  const r = spawnSync('xmllint', ['--noout', '--huge', ...paths], { encoding: 'utf8', maxBuffer: 1 << 26 });
  fs.rmSync(scratch, { recursive: true, force: true });
  const err = String(r.stderr || '').trim();
  if (r.status === 0 && !err) return [];
  return [err.split('\n').slice(0, 2).join(' | ').replace(/\/[^ ]*\/p(\d+)\.xml/g, (m, i) => names[Number(i)]).slice(0, 240)];
}

// Everything the gate knows about a written .docx without rendering it.
let SCHEMA = null; // set by main() (null = --no-schema)
export function inspectDocx(file, scratch) {
  const bytes = new Uint8Array(fs.readFileSync(file));
  const files = fflateLib().unzipSync(bytes);
  const parsed = parseDocxXml(fflateLib().strFromU8(files['word/document.xml']), Object.keys(files).filter((k) => k.startsWith('word/media/')).length);
  const jsXml = Object.keys(files).filter((n) => /\.(xml|rels)$/.test(n)).flatMap((n) => xmlProblems(files[n]).map((m) => `${n}: ${m}`));
  const lint = xmllintProblems(files, scratch);
  const v = validateDocx(bytes, { fflate: fflateLib(), schema: SCHEMA, scratch: `${scratch}-xsd` });
  return { parsed, xmlProblems: jsXml.concat(lint || []), xmllint: lint !== null, pkgProblems: packageProblems(files), strictProblems: v.problems, xsdProblems: v.xsdProblems, xsdRan: v.xsd === 'ran', notes: v.notes };
}

// ------------------------------------------------- pdf-side layout labels --
function layoutLabels(pageItems) {
  // pageItems: [{x0,x1,y,size,str}] per page. Crude, geometry only, independent
  // of the converter.
  let colPages = 0;
  let tblPages = 0;
  let textPages = 0;
  for (const items of pageItems) {
    if (items.length < 8) continue;
    textPages += 1;
    const ms = median(items.map((i) => i.size)) || 10;
    // columns: a vertical gutter no item crosses, >= 5 distinct baselines each side
    const byX = items.slice().sort((a, b) => a.x0 - b.x0);
    let reach = byX[0].x1;
    let col = false;
    for (let k = 1; k < byX.length && !col; k += 1) {
      if (byX[k].x0 - reach >= Math.max(10, ms)) {
        const l = new Set(byX.slice(0, k).map((i) => Math.round(i.y)));
        const r = new Set(byX.slice(k).map((i) => Math.round(i.y)));
        if (l.size >= 5 && r.size >= 5) {
          const ly = byX.slice(0, k).map((i) => i.y);
          const ry = byX.slice(k).map((i) => i.y);
          const ov = Math.min(Math.max(...ly), Math.max(...ry)) - Math.max(Math.min(...ly), Math.min(...ry));
          const span = Math.min(Math.max(...ly) - Math.min(...ly), Math.max(...ry) - Math.min(...ry));
          if (span > 0 && ov / span > 0.6) col = true;
        }
      }
      reach = Math.max(reach, byX[k].x1);
    }
    if (col) colPages += 1;
    // tables: >= 3 consecutive baselines, each with >= 3 cells (gap >= 1.5em),
    // whose cell starts line up (+-4pt) with the previous row in >= 2 columns
    const rowsMap = new Map();
    for (const it of items) {
      const k = Math.round(it.y / 2);
      if (!rowsMap.has(k)) rowsMap.set(k, []);
      rowsMap.get(k).push(it);
    }
    const rows = [...rowsMap.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => {
      r.sort((a, b) => a.x0 - b.x0);
      const cells = [];
      for (const it of r) {
        const last = cells[cells.length - 1];
        if (last && it.x0 - last.x1 < 1.5 * ms) last.x1 = Math.max(last.x1, it.x1);
        else cells.push({ x0: it.x0, x1: it.x1 });
      }
      return cells;
    });
    let run = 0;
    let best = 0;
    for (let k = 0; k < rows.length; k += 1) {
      if (rows[k].length >= 3 && k > 0 && rows[k - 1].length >= 3) {
        const aligned = rows[k].filter((c) => rows[k - 1].some((d) => Math.abs(c.x0 - d.x0) <= 4)).length;
        run = aligned >= 2 ? run + 1 : 0;
      } else run = 0;
      best = Math.max(best, run);
    }
    if (best >= 2) tblPages += 1;
  }
  return { textPages, colPages, tblPages };
}
const median = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); const k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };

// ================================================================ CHILDREN ====
// Convert child: converts ONE file and does nothing else, so the peak RSS it reports is the
// converter's and the time is the converter's. (The spike gathered the PDF-side facts in the same
// process first, which inflated both.)
async function convertChild(id) {
  fs.mkdirSync(path.join(OUT, 'raw'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'docx'), { recursive: true });
  const pdfPath = path.join(CORPUS, `${id}.pdf`);
  const data = fs.readFileSync(pdfPath);
  const row = { id, pdfBytes: data.length };
  const docxPath = path.join(OUT, 'docx', `${id}.docx`);
  fs.rmSync(docxPath, { force: true });
  let pre = null;
  if (ENGINE === 'ours') {
    // Library loading is not conversion time: it is outside the clock (as in the spike's timings).
    globalThis.pdfjsWorker = loadUmd('js/vendor/pdf.worker.min.js');
    pre = { pdfjs: loadUmd('js/vendor/pdf.min.js'), fflate: loadUmd('js/vendor/fflate.min.js'), ...(await import(path.join(ROOT, 'js/docx/convert.js'))) };
  }
  const t0 = Date.now();
  try {
    if (ENGINE === 'ours') {
      const { pdfjs, fflate, convertPdfToDocx } = pre;
      const r = await convertPdfToDocx({ pdfjs, fflate, data, maxPages: MAXPAGES });
      fs.writeFileSync(docxPath, r.docx);
      row.stats = r.stats;
    } else {
      const last = Number.isFinite(MAXPAGES) && MAXPAGES < 1e9 ? MAXPAGES : 100000;
      const res = spawnSync(PY, ['-c', `from pdf2docx import Converter\nc=Converter(${JSON.stringify(pdfPath)})\nc.convert(${JSON.stringify(docxPath)}, start=0, end=${last})\nc.close()`], { timeout: 600000, encoding: 'utf8', maxBuffer: 1 << 26 });
      if (res.status !== 0 || !fs.existsSync(docxPath)) throw new Error((res.stderr || res.error || 'pdf2docx failed').toString().split('\n').filter(Boolean).slice(-2).join(' | '));
    }
    row.ok = true;
  } catch (e) {
    row.ok = false;
    row.error = String((e && e.message) || e).slice(0, 300);
  }
  row.ms = Date.now() - t0;
  // maxRSS is KILOBYTES in node on macOS and Linux alike (checked against process.memoryUsage.rss()).
  row.rssMB = Math.round(process.resourceUsage().maxRSS / 1024);
  fs.writeFileSync(path.join(OUT, 'raw', `${id}.json`), JSON.stringify(row));
  process.exit(0);
}

// Ref child: the PDF-side facts (pdf.js's own reading + poppler), independent of the converter.
// Cached by file + page limit + tool versions: they do not change between lane iterations.
const toolVersion = (() => { const v = {}; return (cmd) => (v[cmd] ||= String(spawnSync(cmd, ['-v'], { encoding: 'utf8' }).stderr || '').split('\n')[0]); })();
function refKey(id) {
  const pdfPath = path.join(CORPUS, `${id}.pdf`);
  const st = fs.statSync(pdfPath);
  return crypto.createHash('sha1').update(`r2|${id}|${st.size}|${st.mtimeMs}|${MAXPAGES}|${fs.statSync(path.join(ROOT, 'js/vendor/pdf.min.js')).size}|${toolVersion('pdftotext')}`).digest('hex').slice(0, 16);
}
async function refChild(id) {
  fs.mkdirSync(CACHE, { recursive: true });
  const pdfPath = path.join(CORPUS, `${id}.pdf`);
  const data = fs.readFileSync(pdfPath);
  globalThis.pdfjsWorker = loadUmd('js/vendor/pdf.worker.min.js');
  const pdfjs = loadUmd('js/vendor/pdf.min.js');
  const row = { id };
  const pj = await pdfjs.getDocument({ data: new Uint8Array(data), disableFontFace: true, isEvalSupported: false, verbosity: 0, fontExtraProperties: true }).promise.catch((e) => { row.pdfOpenError = String(e && e.message); return null; });
  let refText = '';
  const pageItems = [];
  const pageTokens = [];
  let pdfBold = 0;
  let pdfItalic = 0;
  if (pj) {
    row.pages = pj.numPages;
    row.pagesConverted = Math.min(pj.numPages, MAXPAGES);
    for (let i = 1; i <= row.pagesConverted; i += 1) {
      const pg = await pj.getPage(i);
      const tc = await pg.getTextContent();
      await pg.getOperatorList();
      const fmap = new Map();
      for (const n of new Set(tc.items.map((x) => x.fontName))) {
        let fo = null;
        try { fo = pg.commonObjs.get(n); } catch { /* */ }
        const nm = String((fo && fo.name) || '');
        fmap.set(n, { b: /bold|black|heavy/i.test(nm) || !!(fo && fo.bold), i: /italic|oblique/i.test(nm) || !!(fo && fo.italic) });
      }
      const items = [];
      for (const it of tc.items) {
        refText += it.str + (it.hasEOL ? ' ' : '');
        if (it.str.trim() && it.width) {
          const f = fmap.get(it.fontName) || {};
          const n = tokens(it.str).length;
          if (f.b) pdfBold += n;
          if (f.i) pdfItalic += n;
          items.push({ x0: it.transform[4], x1: it.transform[4] + it.width, y: it.transform[5], size: Math.hypot(it.transform[2], it.transform[3]), str: it.str });
        }
      }
      refText += ' ';
      pageTokens.push(tokens(tc.items.map((x) => x.str + (x.hasEOL ? ' ' : '')).join('')));
      pageItems.push(items);
      pg.cleanup();
    }
    await pj.destroy();
  }
  row.refWords = tokens(refText);
  // body page: first page in 2..6 with >= 150 words (a page of running text, not a cover)
  const bp = pageTokens.findIndex((t, i) => i >= 1 && i < 6 && t.length >= 150);
  row.bodyPage = bp >= 0 ? bp + 1 : null;
  row.bodyHead = bp >= 0 ? pageTokens[bp].slice(0, 6) : null;
  Object.assign(row, layoutLabels(pageItems));
  row.pdfBold = pdfBold;
  row.pdfItalic = pdfItalic;
  // poppler: independent reference words + line count + image count, same page range
  const last = String(row.pagesConverted || 1);
  const tt = spawnSync('pdftotext', ['-f', '1', '-l', last, '-enc', 'UTF-8', pdfPath, '-'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  row.popplerWords = tokens(tt.stdout || '');
  const tl = spawnSync('pdftotext', ['-layout', '-f', '1', '-l', last, '-enc', 'UTF-8', pdfPath, '-'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  row.pdfLayoutLines = (tl.stdout || '').split('\n').filter((l) => l.trim()).length;
  const pi = spawnSync('pdfimages', ['-list', '-f', '1', '-l', last, pdfPath], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const imgRows = (pi.stdout || '').split('\n').slice(2).filter((l) => l.trim());
  row.pdfImages = imgRows.filter((l) => !/\ssmask\s/.test(l) && !/\sstencil\s/.test(l)).length;
  row.pdfStencils = imgRows.filter((l) => /\sstencil\s/.test(l)).length;
  const file = path.join(CACHE, `${id}-${refKey(id)}.json`);
  fs.writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(row));
  fs.renameSync(`${file}.${process.pid}.tmp`, file); // atomic: two lanes may fill the cache at once
  process.exit(0);
}

// downscaled ink grid + projections for page 1
function pageInk(pngPath, gw, gh) {
  const png = PNG.sync.read(fs.readFileSync(pngPath));
  const { width, height, data } = png;
  const grid = new Float64Array(gw * gh);
  const cnt = new Float64Array(gw * gh);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const g = data[(y * width + x) * 4];
      const gx = Math.min(gw - 1, Math.floor((x / width) * gw));
      const gy = Math.min(gh - 1, Math.floor((y / height) * gh));
      grid[gy * gw + gx] += 1 - g / 255;
      cnt[gy * gw + gx] += 1;
    }
  }
  let total = 0;
  for (let i = 0; i < grid.length; i += 1) { grid[i] /= cnt[i] || 1; total += grid[i]; }
  return { grid, total: total / grid.length };
}
const pool2 = (g, gw, gh) => { const out = new Float64Array((gw >> 1) * (gh >> 1)); for (let y = 0; y < gh >> 1; y += 1) for (let x = 0; x < gw >> 1; x += 1) out[y * (gw >> 1) + x] = (g[2 * y * gw + 2 * x] + g[2 * y * gw + 2 * x + 1] + g[(2 * y + 1) * gw + 2 * x] + g[(2 * y + 1) * gw + 2 * x + 1]) / 4; return out; };
function pearson(a, b) {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i += 1) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0; let saa = 0; let sbb = 0;
  for (let i = 0; i < n; i += 1) { const x = a[i] - ma; const y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return saa > 1e-12 && sbb > 1e-12 ? sab / Math.sqrt(saa * sbb) : null;
}
const rowProfile = (g, gw, gh) => Array.from({ length: gh }, (_, y) => { let s = 0; for (let x = 0; x < gw; x += 1) s += g[y * gw + x]; return s; });
// ============================================================== SUMMARY ======
const r4 = (x) => (x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 1e4) / 1e4);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const pctl = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]; };

// rows: derived rows (numbers or null). Aggregates over exactly the rows given.
export function summarize(rows) {
  const col = (k) => rows.map((r) => r[k]).filter(isNum);
  const stat = (fn) => Object.fromEntries(['recallBag', 'recallLcs', 'recallBagPoppler', 'recallLcsPoppler', 'recallRendered', 'recallPages', 'visGrid', 'visBody', 'visRows', 'pageRatio', 'msPerPage', 'ms', 'rssMB', 'docxParas'].map((k) => [k, fn(col(k))]));
  const pageDev = rows.map((r) => (isNum(r.pageRatio) ? Math.abs(r.pageRatio - 1) : null)).filter(isNum);
  const sum = (k) => rows.reduce((a, r) => a + (isNum(r[k]) ? r[k] : 0), 0);
  const ratio = (a, b) => (sum(b) > 0 ? sum(a) / sum(b) : null);
  const s = {
    n: rows.length,
    failures: rows.filter((r) => !r.ok).length,
    xmlBad: rows.filter((r) => r.ok && r.xmlOk === 0).length,
    pkgBad: rows.filter((r) => r.ok && r.pkgOk === 0).length,
    strictBad: rows.filter((r) => r.ok && r.strictOk === 0).length,
    xsdBad: rows.filter((r) => r.ok && r.xsdOk === 0).length,
    pagesFail: rows.filter((r) => r.ok && r.pagesOk === 0).length,
    renderFail: rows.filter((r) => r.ok && r.renderOk === 0).length,
    severe: 0,
    mean: { ...stat(mean), pageDev: mean(pageDev) },
    median: stat((a) => pctl(a, 0.5)),
    p10: stat((a) => pctl(a, 0.1)),
    p90: stat((a) => pctl(a, 0.9)),
    max: stat((a) => (a.length ? Math.max(...a) : null)),
    linePerPara: rows.filter((r) => r.linePerParaFlag === 1).length,
    boldKept: ratio('docxBold', 'pdfBold'),
    italicKept: ratio('docxItalic', 'pdfItalic'),
    pictures: sum('docxDrawings') - sum('docxShapes'),
    shapes: sum('docxShapes'),
    tables: sum('docxTables'),
    words: sum('docxWords'),
  };
  return s;
}

// ============================================================== COMPARE ======
// cur / base: { id: derivedRow }. Compared on the ids both have. Returns the verdict and the evidence.
export function compareRuns(cur, base, { perf = true, render = true, schema = true, pages = true } = {}) {
  const ids = Object.keys(cur).filter((id) => base[id]).sort();
  const curRows = ids.map((id) => cur[id]);
  const baseRows = ids.map((id) => base[id]);
  const sc = summarize(curRows);
  const sb = summarize(baseRows);
  const severe = [];
  const worse = [];
  let better = 0;
  for (const id of ids) {
    const c = cur[id];
    const b = base[id];
    if (b.ok && !c.ok) severe.push({ id, metric: 'ok', base: 1, cur: 0 });
    else if (isNum(b.recallBag) && isNum(c.recallBag) && b.recallBag - c.recallBag > SEVERE_DROP) severe.push({ id, metric: 'recallBag', base: b.recallBag, cur: c.recallBag });
    for (const [m, thr] of PER_FILE) {
      if (isNum(b[m]) && isNum(c[m])) {
        if (b[m] - c[m] > thr) worse.push({ id, metric: m, base: b[m], cur: c[m], drop: b[m] - c[m] });
        else if (c[m] - b[m] > thr) better += 1;
      }
    }
  }
  sc.severe = severe.length;
  sb.severe = 0;
  const checks = HEADLINE.map((h) => {
    const bv = h.get(sb);
    const cv = h.get(sc);
    const row = { id: h.id, label: h.label, base: bv, cur: cv, better: h.better, tol: h.rel !== undefined ? (isNum(bv) ? Math.abs(bv) * h.rel : null) : h.abs, perf: !!h.perf };
    if (h.needs === 'render' && !render) return { ...row, status: 'n/a (no render)' };
    if (h.needs === 'pages' && !pages) return { ...row, status: 'n/a (no --pages)' };
    if (h.needs === 'schema' && !schema) return { ...row, status: 'n/a (--no-schema)' };
    if (!isNum(bv) || !isNum(cv)) return { ...row, status: 'n/a' };
    const delta = cv - bv;
    const bad = h.better === 'higher' ? bv - cv > row.tol + 1e-12 : cv - bv > row.tol + 1e-12;
    row.delta = delta;
    row.status = bad ? (h.perf && !perf ? 'worse (perf, not gated)' : 'RED') : 'ok';
    return row;
  });
  worse.sort((a, b) => b.drop - a.drop);
  return { ids: ids.length, checks, severe, worse, better, pass: !checks.some((c) => c.status === 'RED') };
}

const fmt = (v) => (v === null || v === undefined ? '-' : Number.isInteger(v) ? String(v) : Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(4));
export function renderCompare(cmp, label) {
  const out = [`## docx-gate vs ${label}: ${cmp.ids} files compared, ${cmp.pass ? 'PASS' : 'FAIL'}`, '',
    '| metric | baseline | now | delta | tolerance | status |', '|---|---|---|---|---|---|'];
  for (const c of cmp.checks) {
    out.push(`| ${c.label} | ${fmt(c.base)} | ${fmt(c.cur)} | ${c.delta === undefined ? '-' : (c.delta >= 0 ? '+' : '') + fmt(c.delta)} | ${c.tol === null ? '-' : `${c.better === 'higher' ? '-' : '+'}${fmt(c.tol)}`} | ${c.status} |`);
  }
  if (cmp.severe.length) out.push('', `SEVERE (word recall fell > ${SEVERE_DROP} or now fails): ${cmp.severe.map((s) => `${s.id} ${s.metric} ${fmt(s.base)}->${fmt(s.cur)}`).join(', ')}`);
  if (cmp.worse.length) {
    out.push('', `Per-file drops past their reporting threshold (${cmp.worse.length}; ${cmp.better} the other way). Worst 12:`);
    for (const w of cmp.worse.slice(0, 12)) out.push(`  ${w.id} ${w.metric} ${fmt(w.base)} -> ${fmt(w.cur)}`);
  }
  return out.join('\n');
}

// ============================================================ BASELINE I/O ===
// Ids and numbers only: no words from the PDFs, no notes, no filenames.
const BASE_COLS = ['ok', 'class', 'columns', 'tables', 'pages', 'pagesConverted', 'recallBag', 'recallLcs', 'recallBagPoppler', 'recallLcsPoppler', 'recallRendered',
  'visGrid', 'visCoarse', 'visRows', 'visBody', 'visBodyCoarse', 'inkRatio', 'inkBody', 'pageRatio', 'refWords', 'docxWords', 'docxParas', 'linePerParaFlag',
  'pdfBold', 'docxBold', 'pdfItalic', 'docxItalic', 'pdfImages', 'docxDrawings', 'docxShapes', 'docxMedia', 'docxTables', 'columnBands', 'ms', 'msPerPage', 'rssMB',
  'docxBytes', 'xmlOk', 'pkgOk', 'strictOk', 'xsdOk', 'renderOk', 'pagesOk', 'recallPages'];

function parseCsv(text) {
  const [head, ...lines] = text.trim().split('\n');
  const cols = head.split(',');
  const parse = (l) => { const out = []; let cur = ''; let q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };
  return lines.map((l) => Object.fromEntries(parse(l).map((v, i) => [cols[i], v === '' ? null : (/^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v)])));
}
export function loadBaseline(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.csv')) return { meta: { source: path.basename(file) }, rows: Object.fromEntries(parseCsv(text).map((r) => [r.id, r])) };
  const j = JSON.parse(text);
  return { meta: j.meta, rows: j.rows };
}

// ================================================================ MAIN =======
function runPool(items, jobs, fn) {
  let k = 0;
  return Promise.all(Array.from({ length: jobs }, async (_, slot) => { while (k < items.length) { const i = k; k += 1; await fn(items[i], i, slot); } }));
}
function spawnAsync(cmd, args, opts) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.stdout.on('data', () => {});
    const timer = opts && opts.timeout ? setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* */ } }, opts.timeout) : null;
    p.on('close', (code, sig) => { if (timer) clearTimeout(timer); resolve({ code, sig, err }); });
    p.on('error', (e) => { if (timer) clearTimeout(timer); resolve({ code: -1, err: String(e) }); });
  });
}

async function main() {
  if (argv.includes('--self-test')) return selfTest();
  const render = !argv.includes('--no-render');
  const problems = [];
  if (!fs.existsSync(CORPUS)) problems.push(`corpus not found: ${CORPUS} (set CORPUS=)`);
  if (render && !fs.existsSync(SOFFICE)) problems.push(`LibreOffice not found: ${SOFFICE} (set SOFFICE=, or --no-render)`);
  if (spawnSync('pdftotext', ['-v']).error) problems.push('poppler (pdftotext, pdftoppm, pdfimages, pdfinfo) not on PATH');
  const noSchema = argv.includes('--no-schema');
  if (!noSchema) {
    if (!xmllintAvailable()) problems.push('xmllint (libxml2) not on PATH: the schema validation cannot run (install it, or pass --no-schema and accept an n/a, not a green)');
    else {
      try { SCHEMA = await ensureSchemas({ log: (m) => console.log(m) }); } catch (e) { problems.push(`OOXML schemas unavailable: ${String(e.message).split('\n')[0]} (run node scripts/lib/ooxml-schemas.mjs, or pass --no-schema)`); }
    }
  }
  if (problems.length) { console.error(problems.join('\n')); process.exit(2); }

  fs.mkdirSync(path.join(OUT, 'raw'), { recursive: true });
  fs.mkdirSync(CACHE, { recursive: true });
  const manifest = fs.readFileSync(path.join(CORPUS, 'MANIFEST.tsv'), 'utf8').trim().split('\n').slice(1).map((l) => l.split('\t'));
  const meta = new Map(manifest.map((c) => [c[0], { category: c[2], notes: c[7] || '' }]));
  const allIds = fs.readdirSync(CORPUS).filter((f) => /^n\d+\.pdf$/.test(f)).map((f) => f.slice(0, -4)).sort();
  const only = arg('files', arg('ids', null));
  const ids = only ? String(only).split(',').filter((id) => allIds.includes(id)) : allIds;
  if (!ids.length) { console.error('no files selected'); process.exit(2); }
  const subset = ids.length < allIds.length;
  const resume = argv.includes('--resume');
  console.log(`engine=${ENGINE} files=${ids.length}${subset ? ` of ${allIds.length}` : ''} maxpages=${MAXPAGES >= 1e9 ? 'all' : MAXPAGES} jobs=${JOBS} render=${render} schema=${SCHEMA ? 'ECMA-376 transitional + OPC + wps' : 'OFF'} out=${OUT}`);

  // ---- 1. convert (own process each; timing and RSS are the converter's alone)
  const self = fileURLToPath(import.meta.url);
  const childArgs = ['--out', OUT, '--maxpages', String(MAXPAGES >= 1e9 ? 'all' : MAXPAGES), '--engine', ENGINE, '--cache', CACHE];
  await runPool(ids, JOBS, async (id) => {
    const rawFile = path.join(OUT, 'raw', `${id}.json`);
    if (resume && fs.existsSync(rawFile)) return;
    fs.rmSync(rawFile, { force: true });
    const r = await spawnAsync(process.execPath, [self, '--convert', id, ...childArgs], { timeout: 900000, env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' } });
    if (!fs.existsSync(rawFile)) {
      fs.writeFileSync(rawFile, JSON.stringify({ id, ok: false, error: `child ${r.sig || r.code}: ${r.err.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 250)}` }));
    }
    process.stdout.write('.');
  });
  console.log('\nconverted');

  // ---- 1b. PDF-side facts (cached across runs)
  let refsBuilt = 0;
  await runPool(ids, JOBS, async (id) => {
    if (fs.existsSync(path.join(CACHE, `${id}-${refKey(id)}.json`))) return;
    await spawnAsync(process.execPath, [self, '--ref', id, ...childArgs], { timeout: 900000, env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' } });
    refsBuilt += 1;
  });
  if (refsBuilt) console.log(`reference facts built for ${refsBuilt} files (the rest came from ${CACHE})`);

  // ---- 2. inspect, render with LibreOffice, score
  const renderDir = path.join(OUT, 'render');
  fs.mkdirSync(renderDir, { recursive: true });
  const rows = [];
  const profiles = [];
  const nSlots = render ? Math.max(1, Math.min(JOBS, 4)) : 1;
  await runPool(ids, nSlots, async (id, i, slot) => {
    const row = JSON.parse(fs.readFileSync(path.join(OUT, 'raw', `${id}.json`), 'utf8'));
    const refFile = path.join(CACHE, `${id}-${refKey(id)}.json`);
    const ref = fs.existsSync(refFile) ? JSON.parse(fs.readFileSync(refFile, 'utf8')) : { refWords: [], popplerWords: [], refMissing: true };
    Object.assign(row, ref, { ok: row.ok, error: row.error, id }, meta.get(id) || {});
    const docx = path.join(OUT, 'docx', `${id}.docx`);
    const pdf = path.join(CORPUS, `${id}.pdf`);
    if (row.ok) {
      try {
        const insp = inspectDocx(docx, path.join(os.tmpdir(), `docx-gate-xml-${LANE}-${process.pid}-${slot}`));
        const d = insp.parsed;
        row.docxBytes = fs.statSync(docx).size;
        Object.assign(row, { docxWords: d.words, docxParas: d.paras, docxBold: d.bold, docxItalic: d.italic, docxDrawings: d.drawings, docxShapes: d.shapes, docxMedia: d.mediaFiles, docxTables: d.tables, docxSections: d.sections });
        row.xmlOk = insp.xmlProblems.length ? 0 : 1;
        row.pkgOk = insp.pkgProblems.length ? 0 : 1;
        row.xmlNote = insp.xmlProblems.concat(insp.pkgProblems).slice(0, 2).join(' | ').replace(/[\t\n,]/g, ' ').slice(0, 200);
        row.xmllint = insp.xmllint;
        row.strictOk = insp.strictProblems.length ? 0 : 1;
        row.xsdOk = insp.xsdRan ? (insp.xsdProblems.length ? 0 : 1) : null;
        row.strictNotes = insp.notes.length;
        row.strictNote = insp.strictProblems.slice(0, 2).join(' | ').replace(/[\t\n,]/g, ' ').slice(0, 240);
        row.xsdNote = insp.xsdProblems.slice(0, 2).join(' | ').replace(/[\t\n,]/g, ' ').slice(0, 300);
      } catch (e) { row.ok = false; row.error = `unreadable docx: ${String(e.message).slice(0, 150)}`; }
    }
    if (render && row.ok) {
      const t0 = Date.now();
      const prof = `/tmp/lo-${LANE}-${process.pid}-${slot}`;
      if (!profiles.includes(prof)) profiles.push(prof);
      const rpdf = path.join(renderDir, `${id}.pdf`);
      fs.rmSync(rpdf, { force: true }); // a stale render from an earlier run must never count as this run's
      const r = await spawnAsync(SOFFICE, [`-env:UserInstallation=file://${prof}`, '--headless', '--convert-to', 'pdf', '--outdir', renderDir, docx], { timeout: 300000 });
      row.renderMs = Date.now() - t0;
      row.renderOk = fs.existsSync(rpdf);
      if (!row.renderOk) row.renderError = `soffice ${r.sig || r.code} ${r.err.slice(0, 120)}`;
      if (row.renderOk) {
        const info = spawnSync('pdfinfo', [rpdf], { encoding: 'utf8' }).stdout || '';
        row.renderPages = Number((info.match(/Pages:\s+(\d+)/) || [])[1]) || null;
        const rt = spawnSync('pdftotext', ['-enc', 'UTF-8', rpdf, '-'], { encoding: 'utf8', maxBuffer: 1 << 28 }).stdout || '';
        row.renderedWords = tokens(rt);
        const key = refKey(id);
        const origPng = (tag, page) => {
          const base = path.join(CACHE, `${id}-${key}-${tag}`);
          if (!fs.existsSync(`${base}.png`)) { spawnSync('pdftoppm', ['-r', '40', '-gray', '-png', '-f', String(page), '-l', String(page), '-singlefile', pdf, `${base}.${process.pid}`]); try { fs.renameSync(`${base}.${process.pid}.png`, `${base}.png`); } catch { /* another lane got there first */ } }
          return `${base}.png`;
        };
        const b = path.join(renderDir, `${id}_docx`);
        spawnSync('pdftoppm', ['-r', '40', '-gray', '-png', '-f', '1', '-l', '1', '-singlefile', rpdf, b]);
        try {
          const GW = 40;
          const GH = 52;
          const A = pageInk(origPng('p1', 1), GW, GH);
          const B = pageInk(`${b}.png`, GW, GH);
          row.visGrid = pearson(A.grid, B.grid);
          row.visCoarse = pearson(pool2(A.grid, GW, GH), pool2(B.grid, GW, GH));
          row.visRows = pearson(rowProfile(A.grid, GW, GH), rowProfile(B.grid, GW, GH));
          row.inkRatio = A.total > 0 ? B.total / A.total : null;
        } catch (e) { row.visError = String(e.message).slice(0, 100); }
        // body page: locate the rendered page that carries the same first words
        if (row.bodyPage && row.bodyHead) {
          const pages = rt.split('\f');
          let q = pages.findIndex((t) => { const tk = tokens(t); for (let k = 0; k + 6 <= tk.length && k < 60; k += 1) { if (row.bodyHead.every((w, j) => tk[k + j] === w)) return true; } return false; });
          row.bodyFound = q >= 0 ? 1 : 0;
          q = q >= 0 ? q + 1 : row.bodyPage;
          row.bodyDocxPage = q;
          const b2 = path.join(renderDir, `${id}_docx_b`);
          spawnSync('pdftoppm', ['-r', '40', '-gray', '-png', '-f', String(q), '-l', String(q), '-singlefile', rpdf, b2]);
          try {
            const A2 = pageInk(origPng('body', row.bodyPage), 40, 52);
            const B2 = pageInk(`${b2}.png`, 40, 52);
            row.visBody = pearson(A2.grid, B2.grid);
            row.visBodyCoarse = pearson(pool2(A2.grid, 40, 52), pool2(B2.grid, 40, 52));
            row.inkBody = A2.total > 0 ? B2.total / A2.total : null;
          } catch { /* leave empty */ }
        }
      }
    }
    rows.push(row);
    process.stdout.write('.');
  });
  console.log('\nscored');
  for (const p of profiles) if (p.startsWith('/tmp/lo-')) fs.rmSync(p, { recursive: true, force: true });
  rows.sort((x, y) => x.id.localeCompare(y.id));

  // ---- 2b. Apple Pages (opt-in): a second consumer on a deterministic sample, serial
  const pagesArg = arg('pages', null);
  let pagesRan = false;
  if (pagesArg) {
    if (!pagesAvailable()) console.error('--pages: Apple Pages is not available on this machine; skipped (reported n/a, not green)');
    else {
      pagesRan = true;
      const want = Math.max(1, Number(pagesArg === true ? 12 : pagesArg) || 12);
      const okRows = rows.filter((r) => r.ok);
      const step = Math.max(1, Math.ceil(okRows.length / want));
      const sample = okRows.filter((_, i) => i % step === 0).slice(0, want);
      const pdir = path.join(OUT, 'pages');
      fs.mkdirSync(pdir, { recursive: true });
      console.log(`rendering ${sample.length} files with Apple Pages (serial, ~10-30 s each)...`);
      for (const row of sample) {
        const out = path.join(pdir, `${row.id}.pdf`);
        const res = renderWithPages(path.join(OUT, 'docx', `${row.id}.docx`), out, { timeout: 120000 });
        row.pagesOk = res.ok ? 1 : 0;
        row.pagesMs = res.ms;
        if (!res.ok) row.pagesError = res.error;
        else {
          row.pagesPages = Number((String(spawnSync('pdfinfo', [out], { encoding: 'utf8' }).stdout || '').match(/Pages:\s+(\d+)/) || [])[1]) || null;
          row.pagesWords = tokens(spawnSync('pdftotext', ['-enc', 'UTF-8', out, '-'], { encoding: 'utf8', maxBuffer: 1 << 28 }).stdout || '');
        }
        process.stdout.write(res.ok ? '.' : 'x');
        if (res.stuck) { console.log(`\nPages is stuck behind a dialog in a session it did not launch: the rest of the sample is skipped (pagesOk stays n/a), not retried`); break; }
      }
      quitPages();
      console.log('\nPages done');
    }
  }

  // ---- 3. derive
  const derived = rows.map((r) => deriveRow(r, render));
  const cols = Object.keys(derived[0]);
  const csv = [cols.join(',')].concat(derived.map((o) => cols.map((c) => { const v = o[c] === null || o[c] === undefined ? '' : String(o[c]); return /[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }).join(','))).join('\n');
  const csvName = ENGINE === 'ours' ? 'results.csv' : `results-${ENGINE}.csv`;
  fs.writeFileSync(path.join(OUT, csvName), `${csv}\n`);
  const byId = Object.fromEntries(derived.map((o) => [o.id, o]));
  const lost = derived.filter((o) => !o.ok && /^child /.test(o.error || '')).length;
  const env = { node: process.version, platform: `${process.platform}-${process.arch}`, ncpu: os.cpus().length, jobs: JOBS, maxpages: MAXPAGES >= 1e9 ? 'all' : MAXPAGES, soffice: render ? String(spawnSync(SOFFICE, ['--version'], { encoding: 'utf8' }).stdout || '').trim().slice(0, 60) : null, xmllint: rows.some((r) => r.xmllint), xsd: !!SCHEMA };
  console.log(`wrote ${path.join(OUT, csvName)} (${derived.length} rows, ${derived.filter((o) => o.ok).length} ok)`);

  // ---- 4. baseline
  if (argv.includes('--write-baseline')) {
    if (subset) { console.error('refusing to write a baseline from a subset run'); process.exit(2); }
    if (derived.some((o) => !o.ok)) console.error(`note: ${derived.filter((o) => !o.ok).length} files failed; the baseline records that`);
    if (!render) { console.error('refusing to write a baseline without LibreOffice (recallRendered/vis*/pageRatio would be empty)'); process.exit(2); }
    const dest = typeof arg('write-baseline', null) === 'string' ? arg('write-baseline') : BASELINE_DEFAULT;
    const commit = spawnSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const out = { schema: 1, meta: { ...env, commit, written: new Date().toISOString().slice(0, 10), files: derived.length, note: 'ids and numbers only; times and RSS are this machine at this --jobs' }, summary: summarize(derived), rows: Object.fromEntries(derived.map((o) => [o.id, Object.fromEntries(BASE_COLS.map((k) => [k, o[k] === undefined ? null : o[k]]))])) };
    fs.writeFileSync(dest, `${JSON.stringify(out, null, 1)}\n`);
    console.log(`baseline written: ${dest}`);
  }

  // ---- 5. compare
  const baseFile = arg('baseline', BASELINE_DEFAULT);
  if (!fs.existsSync(baseFile)) { console.log(`\nno baseline at ${baseFile}: nothing to compare (run with --write-baseline on a full run)`); process.exit(lost > derived.length * 0.05 ? 2 : 0); }
  const base = loadBaseline(baseFile);
  if (base.meta && base.meta.maxpages !== undefined && String(base.meta.maxpages) !== String(env.maxpages)) console.log(`\nWARNING: baseline was made with maxpages=${base.meta.maxpages}, this run is ${env.maxpages}: quality numbers are not comparable`);
  if (base.meta && base.meta.platform && base.meta.platform !== env.platform) console.log(`\nWARNING: baseline machine ${base.meta.platform}, this one ${env.platform}: times and RSS are not comparable`);
  const cmp = compareRuns(byId, base.rows, { perf: !argv.includes('--no-perf'), render, schema: !!SCHEMA, pages: pagesRan });
  const md = renderCompare(cmp, path.relative(ROOT, baseFile) || baseFile);
  fs.writeFileSync(path.join(OUT, 'compare.md'), `${md}\n`);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ env, summary: summarize(derived), compare: cmp, rows: byId }));
  console.log(`\n${md}`);
  if (lost > derived.length * 0.05) { console.error(`\nHARNESS: ${lost} converter processes died without a result (> 5%)`); process.exit(2); }
  process.exit(cmp.pass ? 0 : 1);
}

function deriveRow(r, render) {
  const o = { id: r.id, category: r.category || '', notes: '' };
  const st = r.stats || {};
  const kinds = st.pageKinds || {};
  const np = (kinds.text || 0) + (kinds['searchable-scan'] || 0) + (kinds.scan || 0) + (kinds.empty || 0);
  let cls = 'text-born';
  if (np) {
    if ((kinds.scan || 0) + (kinds.empty || 0) >= np * 0.5) cls = 'scan';
    else if ((kinds['searchable-scan'] || 0) >= np * 0.5) cls = 'searchable-scan';
  } else if ((r.refWords || []).length === 0) cls = 'scan';
  if (ENGINE !== 'ours') cls = (r.refWords || []).length < 20 * (r.pagesConverted || 1) * 0.1 ? 'scan' : 'text-born';
  o.class = cls;
  o.pages = r.pages ?? null;
  o.pagesConverted = r.pagesConverted ?? null;
  const tp = r.textPages || 0;
  o.columns = tp && r.colPages / tp >= 0.15 ? 'yes' : 'no';
  o.tables = tp && r.tblPages / tp >= 0.15 ? 'yes' : 'no';
  o.colPageFrac = tp ? r4(r.colPages / tp) : null;
  o.tblPageFrac = tp ? r4(r.tblPages / tp) : null;
  o.ok = r.ok ? 1 : 0;
  o.error = (r.error || r.pdfOpenError || '').replace(/[\t\n,]/g, ' ');
  o.ms = r.ms ?? null;
  o.msPerPage = r.ms && r.pagesConverted ? Math.round(r.ms / r.pagesConverted) : null;
  o.rssMB = r.rssMB ?? null;
  o.pdfBytes = r.pdfBytes ?? null;
  o.docxBytes = r.docxBytes ?? null;
  o.bytesRatio = r.docxBytes ? r4(r.docxBytes / r.pdfBytes) : null;
  o.refWords = (r.refWords || []).length;
  const dw = r.docxWords || [];
  o.docxWords = dw.length;
  o.recallBag = null; o.recallLcs = null; o.recallBagPoppler = null; o.recallLcsPoppler = null; o.recallRendered = null; o.lcsTruncated = null;
  if (r.ok && o.refWords) {
    const a = recall(r.refWords, dw);
    o.recallBag = r4(a.bag);
    o.recallLcs = r4(a.lcs);
    const p = recall(r.popplerWords || [], dw);
    o.recallBagPoppler = r4(p.bag);
    o.recallLcsPoppler = r4(p.lcs);
    if (r.renderedWords) o.recallRendered = r4(recall(r.refWords, r.renderedWords).bag);
    o.lcsTruncated = a.truncated ? 1 : 0;
  }
  o.pdfLayoutLines = r.pdfLayoutLines ?? null;
  o.editorLines = st.lines ?? null;
  o.docxParas = r.docxParas ?? null;
  o.paraPerLayoutLine = r.docxParas && r.pdfLayoutLines ? r4(r.docxParas / r.pdfLayoutLines) : null;
  o.wordsPerPara = r.docxParas ? Math.round((o.docxWords / r.docxParas) * 10) / 10 : null;
  o.pdfWordsPerLine = r.pdfLayoutLines ? Math.round((o.refWords / r.pdfLayoutLines) * 10) / 10 : null;
  // line-per-paragraph regression: nearly one paragraph per visual line on a prose document
  o.linePerParaFlag = r.docxParas && r.pdfLayoutLines >= 20 && r.docxParas / r.pdfLayoutLines > 0.8 && o.refWords / r.pdfLayoutLines >= 8 ? 1 : 0;
  o.pdfBold = r.pdfBold ?? null;
  o.docxBold = r.docxBold ?? null;
  o.pdfItalic = r.pdfItalic ?? null;
  o.docxItalic = r.docxItalic ?? null;
  o.pdfImages = r.pdfImages ?? null;
  o.pdfStencils = r.pdfStencils ?? null;
  o.docxDrawings = r.docxDrawings ?? null;
  o.docxShapes = r.docxShapes ?? null;
  o.docxMedia = r.docxMedia ?? null;
  o.docxTables = r.docxTables ?? null;
  o.docxSections = r.docxSections ?? null;
  o.pageKinds = st.pageKinds ? `${kinds.text || 0}/${kinds['searchable-scan'] || 0}/${kinds.scan || 0}/${kinds.empty || 0}` : '';
  o.imagesFailed = st.imagesFailed ?? null;
  o.xmlOk = r.xmlOk ?? null;
  o.pkgOk = r.pkgOk ?? null;
  o.strictOk = r.strictOk ?? null;
  o.xsdOk = r.xsdOk ?? null;
  o.strictNotes = r.strictNotes ?? null;
  o.strictNote = r.strictNote || '';
  o.xsdNote = r.xsdNote || '';
  o.pagesOk = r.pagesOk ?? null;
  o.pagesMs = r.pagesMs ?? null;
  o.pagesError = (r.pagesError || '').replace(/[\t\n,]/g, ' ');
  o.pagesRatio = r.pagesPages && r.pagesConverted ? Number((r.pagesPages / r.pagesConverted).toFixed(2)) : null;
  o.recallPages = r.pagesWords && o.refWords ? r4(recall(r.refWords, r.pagesWords).bag) : null;
  o.xmlNote = r.xmlNote || '';
  o.renderOk = r.renderOk ? 1 : (render && r.ok ? 0 : null);
  o.renderMs = r.renderMs ?? null;
  o.renderPages = r.renderPages ?? null;
  o.pageRatio = r.renderPages && r.pagesConverted ? Number((r.renderPages / r.pagesConverted).toFixed(2)) : null;
  o.visGrid = r4(r.visGrid);
  o.visRows = r4(r.visRows);
  o.inkRatio = r4(r.inkRatio);
  o.bodyPage = r.bodyPage || null;
  o.bodyFound = r.bodyFound ?? null;
  o.visBody = r4(r.visBody);
  o.visCoarse = r4(r.visCoarse);
  o.visBodyCoarse = r4(r.visBodyCoarse);
  o.inkBody = r4(r.inkBody);
  o.columnBands = st.columnBands ?? null;
  o.tablesBuilt = st.tables ?? null;
  return o;
}

// ============================================================ SELF TEST ======
// Proves the instruments can go red. A gate that cannot is decoration.
async function selfTest() {
  const fails = [];
  const expect = (cond, what) => { if (!cond) fails.push(what); console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); };
  // recall: known positives
  const w = tokens('alpha beta gamma delta epsilon zeta eta theta');
  expect(recall(w, w).lcs === 1 && recall(w, w).bag === 1, 'recall: identical text scores 1/1');
  const rev = w.slice().reverse();
  expect(recall(w, rev).bag === 1 && recall(w, rev).lcs < 0.5, 'recall: reversed text keeps every word (bag 1) but loses its order (LCS < 0.5)');
  expect(recall(w, tokens('nothing in common here')).bag === 0, 'recall: disjoint text scores 0');
  // xml instruments
  expect(xmlProblems('<a><b></a>').length > 0, 'xmlProblems flags mismatched tags');
  expect(xmlProblems('<w:p/>').length > 0, 'xmlProblems flags an undeclared namespace prefix');
  expect(xmlProblems('<a xmlns:w="u"><w:p/></a>').length === 0, 'xmlProblems passes a good document');
  if (spawnSync('xmllint', ['--version']).error) console.log('skip xmllint checks: not installed');
  else {
    const scratch = path.join(os.tmpdir(), `docx-gate-self-${process.pid}`);
    expect((xmllintProblems({ 'x.xml': new TextEncoder().encode('<a><b></a>') }, scratch) || []).length > 0, 'xmllint witness flags mismatched tags');
    expect((xmllintProblems({ 'x.xml': new TextEncoder().encode('<w:p/>') }, scratch) || []).length > 0, 'xmllint witness flags a namespace error although it exits 0');
    expect((xmllintProblems({ 'x.xml': new TextEncoder().encode('<a xmlns:w="u"><w:p/></a>') }, scratch) || ['x']).length === 0, 'xmllint witness passes a good document');
  }
  // strict + schema instruments: a known-good package passes, and each class of break goes red in the layer that owns it
  {
    const { buildFixtureDocx } = await import('./lib/docx-validate.mjs');
    const fx = fflateLib();
    const good = fx.unzipSync(await buildFixtureDocx(fx));
    const enc = (t) => fx.strToU8(t);
    const doc = fx.strFromU8(good['word/document.xml']);
    const broken = (from, to) => { const f = { ...good }; if (!doc.includes(from)) throw new Error(`self-test fixture changed: ${from}`); f['word/document.xml'] = enc(doc.replace(from, to)); return f; };
    const rprSwapped = broken('<w:rPr><w:b/><w:bCs/><w:color w:val="C00000"/>', '<w:rPr><w:color w:val="C00000"/><w:b/><w:bCs/>');
    const pprSwapped = broken('<w:spacing w:before="120" w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/>', '<w:jc w:val="center"/><w:spacing w:before="120" w:after="0" w:line="240" w:lineRule="auto"/>');
    const cellEndsInTable = broken('Gabungan</w:t></w:r></w:p></w:tc>', 'Gabungan</w:t></w:r></w:p><w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="100"/></w:tblGrid><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl></w:tc>');
    const gridWrong = broken('<w:gridSpan w:val="2"/>', '<w:gridSpan w:val="3"/>');
    expect(structureProblems(good).problems.length === 0, 'strict: a known-good package passes');
    expect(structureProblems(rprSwapped).problems.length > 0, 'strict: goes red on a mis-ordered w:rPr (the schema cannot see this one)');
    expect(structureProblems(pprSwapped).problems.length > 0, 'strict: goes red on a mis-ordered w:pPr');
    expect(structureProblems(cellEndsInTable).problems.length > 0, 'strict: goes red on a cell that ends with a table');
    expect(structureProblems(gridWrong).problems.length > 0, 'strict: goes red on a row wider than its grid');
    const noMedia = { ...good }; delete noMedia['word/media/image1.png'];
    expect(structureProblems(noMedia).problems.length > 0, 'strict: goes red on a relationship whose target is gone');
    let schema = null;
    if (!xmllintAvailable()) console.log('skip schema checks: xmllint not installed');
    else {
      try { schema = await ensureSchemas(); } catch (e) { console.log(`skip schema checks: ${String(e.message).split('\n')[0]}`); }
    }
    if (!schema && (process.env.DOCX_REQUIRE_XSD || process.env.CI)) { fails.push('schema checks required (CI / DOCX_REQUIRE_XSD) but unavailable'); console.log('FAIL schema checks required but unavailable'); }
    if (schema) {
      const scratch = path.join(os.tmpdir(), `docx-gate-xsd-self-${process.pid}`);
      expect(xsdProblems(good, schema, scratch).length === 0, 'schema: a known-good package validates');
      expect(xsdProblems(pprSwapped, schema, scratch).length > 0, 'schema: goes red on a mis-ordered w:pPr');
      expect(xsdProblems(broken('<w:body>', '<w:body><w:bogus/>'), schema, scratch).length > 0, 'schema: goes red on a stray element in w:body');
      expect(xsdProblems(broken('<wps:bodyPr/>', ''), schema, scratch).length > 0, 'schema: goes red inside the Microsoft wps shape (the schema is wired, not just present)');
      expect(xsdProblems(rprSwapped, schema, scratch).length === 0, 'schema: does NOT see a swapped w:rPr (documents why the strict layer exists)');
    }
  }
  // compare: identical passes; each doctored variant goes red
  const base = { n1: { id: 'n1', ok: 1, recallBag: 0.99, recallLcs: 0.95, recallBagPoppler: 0.99, recallLcsPoppler: 0.95, recallRendered: 0.99, visGrid: 0.8, visBody: 0.7, pageRatio: 1, docxBold: 10, pdfBold: 10, docxItalic: 5, pdfItalic: 5, docxDrawings: 4, docxShapes: 0, docxTables: 2, xmlOk: 1, pkgOk: 1, renderOk: 1, msPerPage: 20, rssMB: 300, linePerParaFlag: 0 },
    n2: { id: 'n2', ok: 1, recallBag: 1, recallLcs: 1, recallBagPoppler: 1, recallLcsPoppler: 1, recallRendered: 1, visGrid: 0.9, visBody: 0.9, pageRatio: 1, docxBold: 0, pdfBold: 0, docxItalic: 0, pdfItalic: 0, docxDrawings: 0, docxShapes: 0, docxTables: 0, xmlOk: 1, pkgOk: 1, renderOk: 1, msPerPage: 20, rssMB: 300, linePerParaFlag: 0 } };
  const clone = () => JSON.parse(JSON.stringify(base));
  expect(compareRuns(clone(), base).pass, 'compare: an identical run passes');
  const cases = [
    ['a file stops converting', (c) => { c.n1.ok = 0; }],
    ['malformed XML appears', (c) => { c.n1.xmlOk = 0; }],
    ['a file fails the strict checks', (c) => { c.n1.strictOk = 0; }],
    ['a file fails schema validation', (c) => { c.n2.xsdOk = 0; }],
    ['Apple Pages cannot open a sampled file', (c) => { c.n1.pagesOk = 0; }],
    ['a package breaks', (c) => { c.n2.pkgOk = 0; }],
    ['word recall collapses on one file', (c) => { c.n1.recallBag = 0.5; }],
    ['recall drifts down on every file', (c) => { c.n1.recallLcs = 0.9; c.n2.recallLcs = 0.95; }],
    ['pictures disappear', (c) => { c.n1.docxDrawings = 0; }],
    ['tables disappear', (c) => { c.n1.docxTables = 0; }],
    ['bold is lost', (c) => { c.n1.docxBold = 0; }],
    ['pagination doubles', (c) => { c.n1.pageRatio = 2; c.n2.pageRatio = 2; }],
    ['conversion gets 3x slower', (c) => { c.n1.msPerPage = 60; c.n2.msPerPage = 60; }],
    ['memory doubles', (c) => { c.n1.rssMB = 700; }],
  ];
  for (const [what, mutate] of cases) { const c = clone(); mutate(c); expect(!compareRuns(c, base).pass, `compare goes red when ${what}`); }
  const xsdRed = clone(); xsdRed.n1.xsdOk = 0;
  expect(compareRuns(xsdRed, base, { schema: false }).pass, 'compare: --no-schema reports the schema metric as n/a, not red');
  const slowOk = clone(); slowOk.n1.msPerPage = 60; slowOk.n2.msPerPage = 60;
  expect(compareRuns(slowOk, base, { perf: false }).pass, 'compare: --no-perf reports a slowdown without failing');
  const better = clone(); better.n1.docxTables = 9; better.n1.recallLcs = 0.99;
  expect(compareRuns(better, base).pass, 'compare: an improvement passes');
  console.log(fails.length ? `\nSELF-TEST FAILED (${fails.length})` : '\nself-test passed: the gate can go red');
  process.exit(fails.length ? 1 : 0);
}

export { tokens, recall };
if (CONVERT_ONE) convertChild(CONVERT_ONE).catch((e) => { console.error(e); process.exit(2); });
else if (REF_ONE) refChild(REF_ONE).catch((e) => { console.error(e); process.exit(2); });
else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e); process.exit(2); });
