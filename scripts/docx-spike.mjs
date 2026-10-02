#!/usr/bin/env node
/*
 * The PDF -> DOCX spike harness (2026-10-02). Scores core/pdf-to-docx.js (or a
 * reference engine) over the wild web corpus and writes results.csv.
 *
 *   node scripts/docx-spike.mjs --out DIR [--ids n001,n002] [--maxpages 40]
 *                               [--jobs 3] [--engine ours|pdf2docx] [--no-render]
 *
 * Corpus (READ ONLY, gitignored): tests/fixtures/wild/web/ in the shared app/
 * checkout; override with CORPUS=. Real third-party public PDFs: ids only in
 * anything you share.
 *
 * Every metric is computed from the PDF and the WRITTEN .docx by code that does
 * not share the converter's logic where that is cheap (poppler for a second
 * word reference and for page-1 rendering; LibreOffice for the docx's own
 * rendering). Same-process pieces are labelled in the report.
 *
 *   child mode:  --one ID   (convert + pdf-side metrics, one file, own process,
 *                            so a hang or a crash costs one row, never the run)
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = process.env.CORPUS || '/Users/ojanlubis/machine/fkd/pdflokal/app/tests/fixtures/wild/web';
const SOFFICE = process.env.SOFFICE || '/opt/homebrew/bin/soffice';
const PY = process.env.PDF2DOCX_PY || '';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };
const OUT = arg('out', path.join(os.tmpdir(), 'docx-spike'));
const MAXPAGES = Number(arg('maxpages', 40));
const JOBS = Number(arg('jobs', 3));
const ENGINE = arg('engine', 'ours');
const ONE = arg('one', null);

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
function unzipDocx(file) {
  const fflate = loadUmd('js/vendor/fflate.min.js');
  const files = fflate.unzipSync(new Uint8Array(fs.readFileSync(file)));
  return { xml: fflate.strFromU8(files['word/document.xml']), media: Object.keys(files).filter((k) => k.startsWith('word/media/')).length };
}
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
function parseDocx(file) {
  const { xml, media } = unzipDocx(file);
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
    mediaFiles: media,
    tables: (xml.match(/<w:tbl>/g) || []).length,
    sections: (xml.match(/<w:sectPr[ >]/g) || []).length,
  };
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

// ================================================================ CHILD ====
async function childMain(id) {
  const outRaw = path.join(OUT, 'raw');
  const outDocx = path.join(OUT, 'docx');
  fs.mkdirSync(outRaw, { recursive: true });
  fs.mkdirSync(outDocx, { recursive: true });
  const pdfPath = path.join(CORPUS, `${id}.pdf`);
  const data = fs.readFileSync(pdfPath);
  globalThis.pdfjsWorker = loadUmd('js/vendor/pdf.worker.min.js');
  const pdfjs = loadUmd('js/vendor/pdf.min.js');
  const fflate = loadUmd('js/vendor/fflate.min.js');
  const row = { id, pdfBytes: data.length };

  // ---- PDF-side facts (independent of the converter's own extraction)
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

  // ---- convert (timed)
  const docxPath = path.join(outDocx, `${id}.docx`);
  const t0 = Date.now();
  try {
    if (ENGINE === 'ours') {
      const { convertPdfToDocx } = await import(path.join(ROOT, 'js/core/pdf-to-docx.js'));
      const r = await convertPdfToDocx({ pdfjs, fflate, data, maxPages: MAXPAGES });
      fs.writeFileSync(docxPath, r.docx);
      row.stats = r.stats;
    } else {
      const res = spawnSync(PY, ['-c', `from pdf2docx import Converter\nc=Converter(${JSON.stringify(pdfPath)})\nc.convert(${JSON.stringify(docxPath)}, start=0, end=${MAXPAGES})\nc.close()`], { timeout: 600000, encoding: 'utf8', maxBuffer: 1 << 26 });
      if (res.status !== 0 || !fs.existsSync(docxPath)) throw new Error((res.stderr || res.error || 'pdf2docx failed').toString().split('\n').filter(Boolean).slice(-2).join(' | '));
    }
    row.ok = true;
  } catch (e) {
    row.ok = false;
    row.error = String(e && e.message || e).slice(0, 300);
  }
  row.ms = Date.now() - t0;

  if (row.ok) {
    const d = parseDocx(docxPath);
    row.docxBytes = fs.statSync(docxPath).size;
    row.docxWords = d.words;
    row.docxParas = d.paras;
    row.docxBold = d.bold;
    row.docxItalic = d.italic;
    row.docxDrawings = d.drawings;
    row.docxMedia = d.mediaFiles;
    row.docxTables = d.tables;
    row.docxSections = d.sections;
  }
  // poppler: independent reference words + line count + image count, same page range
  const tt = spawnSync('pdftotext', ['-f', '1', '-l', String(row.pagesConverted || 1), '-enc', 'UTF-8', pdfPath, '-'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  row.popplerWords = tokens(tt.stdout || '');
  const tl = spawnSync('pdftotext', ['-layout', '-f', '1', '-l', String(row.pagesConverted || 1), '-enc', 'UTF-8', pdfPath, '-'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  row.pdfLayoutLines = (tl.stdout || '').split('\n').filter((l) => l.trim()).length;
  const pi = spawnSync('pdfimages', ['-list', '-f', '1', '-l', String(row.pagesConverted || 1), pdfPath], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const imgRows = (pi.stdout || '').split('\n').slice(2).filter((l) => l.trim());
  row.pdfImages = imgRows.filter((l) => !/\ssmask\s/.test(l) && !/\sstencil\s/.test(l)).length;
  row.pdfStencils = imgRows.filter((l) => /\sstencil\s/.test(l)).length;

  fs.writeFileSync(path.join(outRaw, `${id}.json`), JSON.stringify(row));
  process.exit(0);
}

// ============================================================ ORCHESTRATOR ==
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

async function main() {
  fs.mkdirSync(path.join(OUT, 'raw'), { recursive: true });
  const manifest = fs.readFileSync(path.join(CORPUS, 'MANIFEST.tsv'), 'utf8').trim().split('\n').slice(1).map((l) => l.split('\t'));
  const meta = new Map(manifest.map((c) => [c[0], { category: c[2], notes: c[7] || '' }]));
  let ids = fs.readdirSync(CORPUS).filter((f) => /^n\d+\.pdf$/.test(f)).map((f) => f.slice(0, -4)).sort();
  const only = arg('ids', null);
  if (only) ids = only.split(',');
  const render = !argv.includes('--no-render');

  console.log(`engine=${ENGINE} files=${ids.length} maxpages=${MAXPAGES} out=${OUT}`);
  // ---- 1. convert
  await runPool(ids, JOBS, async (id) => {
    const rawFile = path.join(OUT, 'raw', `${id}.json`);
    if (!argv.includes('--force') && fs.existsSync(rawFile)) return;
    const args = [fileURLToPath(import.meta.url), '--one', id, '--out', OUT, '--maxpages', String(MAXPAGES), '--engine', ENGINE];
    const r = await spawnAsync(process.execPath, args, { timeout: 900000, env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' } });
    if (!fs.existsSync(rawFile)) {
      fs.writeFileSync(rawFile, JSON.stringify({ id, ok: false, error: `child ${r.sig || r.code}: ${r.err.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 250)}`, refWords: [], popplerWords: [], docxWords: [] }));
    }
    process.stdout.write(`.`);
  });
  console.log('\nconverted');

  // ---- 2. render docx with LibreOffice + score
  const renderDir = path.join(OUT, 'render');
  fs.mkdirSync(renderDir, { recursive: true });
  const rows = [];
  await runPool(ids, render ? Math.max(1, Math.min(JOBS, 4)) : 1, async (id, i, slot) => {
    const row = JSON.parse(fs.readFileSync(path.join(OUT, 'raw', `${id}.json`), 'utf8'));
    Object.assign(row, meta.get(id) || {});
    const docx = path.join(OUT, 'docx', `${id}.docx`);
    const pdf = path.join(CORPUS, `${id}.pdf`);
    if (render && row.ok) {
      const t0 = Date.now();
      const prof = path.join(os.tmpdir(), `lo-profile-${process.pid}-${slot}`);
      const r = await spawnAsync(SOFFICE, [`-env:UserInstallation=file://${prof}`, '--headless', '--convert-to', 'pdf', '--outdir', renderDir, docx], { timeout: 300000 });
      row.renderMs = Date.now() - t0;
      const rpdf = path.join(renderDir, `${id}.pdf`);
      row.renderOk = fs.existsSync(rpdf);
      if (!row.renderOk) row.renderError = `soffice ${r.sig || r.code} ${r.err.slice(0, 120)}`;
      if (row.renderOk) {
        const info = spawnSync('pdfinfo', [rpdf], { encoding: 'utf8' }).stdout || '';
        row.renderPages = Number((info.match(/Pages:\s+(\d+)/) || [])[1]) || null;
        const rt = spawnSync('pdftotext', ['-enc', 'UTF-8', rpdf, '-'], { encoding: 'utf8', maxBuffer: 1 << 28 }).stdout || '';
        row.renderedWords = tokens(rt);
        const a = path.join(renderDir, `${id}_orig`);
        const b = path.join(renderDir, `${id}_docx`);
        spawnSync('pdftoppm', ['-r', '40', '-gray', '-png', '-f', '1', '-l', '1', '-singlefile', pdf, a]);
        spawnSync('pdftoppm', ['-r', '40', '-gray', '-png', '-f', '1', '-l', '1', '-singlefile', rpdf, b]);
        try {
          const GW = 40;
          const GH = 52;
          const A = pageInk(`${a}.png`, GW, GH);
          const B = pageInk(`${b}.png`, GW, GH);
          row.visGrid = pearson(A.grid, B.grid);
          row.visRows = pearson(rowProfile(A.grid, GW, GH), rowProfile(B.grid, GW, GH));
          row.inkRatio = A.total > 0 ? B.total / A.total : null;
        } catch (e) { row.visError = String(e.message).slice(0, 100); }
        // body page: locate the rendered page that carries the same first words
        if (row.bodyPage && row.bodyHead) {
          const pages = rt.split('\f');
          let q = pages.findIndex((t) => { const tk = tokens(t); for (let i = 0; i + 6 <= tk.length && i < 60; i += 1) { if (row.bodyHead.every((w, j) => tk[i + j] === w)) return true; } return false; });
          row.bodyFound = q >= 0 ? 1 : 0;
          q = q >= 0 ? q + 1 : row.bodyPage;
          row.bodyDocxPage = q;
          const a2 = path.join(renderDir, `${id}_orig_b`);
          const b2 = path.join(renderDir, `${id}_docx_b`);
          spawnSync('pdftoppm', ['-r', '40', '-gray', '-png', '-f', String(row.bodyPage), '-l', String(row.bodyPage), '-singlefile', pdf, a2]);
          spawnSync('pdftoppm', ['-r', '40', '-gray', '-png', '-f', String(q), '-l', String(q), '-singlefile', rpdf, b2]);
          try {
            const A2 = pageInk(`${a2}.png`, 40, 52);
            const B2 = pageInk(`${b2}.png`, 40, 52);
            row.visBody = pearson(A2.grid, B2.grid);
            row.inkBody = A2.total > 0 ? B2.total / A2.total : null;
          } catch { /* leave empty */ }
        }
      }
    }
    rows.push(row);
  });
  rows.sort((x, y) => x.id.localeCompare(y.id));

  // ---- 3. derive + write CSV
  const out = rows.map((r) => {
    const o = { id: r.id, category: r.category || '', notes: r.notes || '' };
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
    o.pages = r.pages || '';
    o.pagesConverted = r.pagesConverted || '';
    const tp = r.textPages || 0;
    o.columns = tp && r.colPages / tp >= 0.15 ? 'yes' : 'no';
    o.tables = tp && r.tblPages / tp >= 0.15 ? 'yes' : 'no';
    o.colPageFrac = tp ? (r.colPages / tp).toFixed(2) : '';
    o.tblPageFrac = tp ? (r.tblPages / tp).toFixed(2) : '';
    o.ok = r.ok ? 1 : 0;
    o.error = (r.error || r.pdfOpenError || '').replace(/[\t\n,]/g, ' ');
    o.ms = r.ms ?? '';
    o.msPerPage = r.ms && r.pagesConverted ? Math.round(r.ms / r.pagesConverted) : '';
    o.pdfBytes = r.pdfBytes;
    o.docxBytes = r.docxBytes ?? '';
    o.bytesRatio = r.docxBytes ? (r.docxBytes / r.pdfBytes).toFixed(3) : '';
    o.refWords = (r.refWords || []).length;
    o.docxWords = (r.docxWords || []).length;
    if (r.ok && o.refWords) {
      const a = recall(r.refWords, r.docxWords);
      o.recallBag = a.bag.toFixed(4);
      o.recallLcs = a.lcs.toFixed(4);
      const p = recall(r.popplerWords, r.docxWords);
      o.recallBagPoppler = p.bag === null ? '' : p.bag.toFixed(4);
      o.recallLcsPoppler = p.lcs === null ? '' : p.lcs.toFixed(4);
      if (r.renderedWords) {
        const q = recall(r.refWords, r.renderedWords);
        o.recallRendered = q.bag.toFixed(4);
      } else o.recallRendered = '';
      o.lcsTruncated = a.truncated ? 1 : 0;
    } else { o.recallBag = ''; o.recallLcs = ''; o.recallBagPoppler = ''; o.recallLcsPoppler = ''; o.recallRendered = ''; o.lcsTruncated = ''; }
    o.pdfLayoutLines = r.pdfLayoutLines ?? '';
    o.editorLines = st.lines ?? '';
    o.docxParas = r.docxParas ?? '';
    o.paraPerLayoutLine = r.docxParas && r.pdfLayoutLines ? (r.docxParas / r.pdfLayoutLines).toFixed(3) : '';
    o.wordsPerPara = r.docxParas ? (o.docxWords / r.docxParas).toFixed(1) : '';
    o.pdfWordsPerLine = r.pdfLayoutLines ? (o.refWords / r.pdfLayoutLines).toFixed(1) : '';
    // line-per-paragraph regression: nearly one paragraph per visual line on a prose document
    o.linePerParaFlag = r.docxParas && r.pdfLayoutLines >= 20 && r.docxParas / r.pdfLayoutLines > 0.8 && (o.docxWords / r.docxParas) < 2.2 * (o.refWords / r.pdfLayoutLines) ? 1 : 0;
    o.pdfBold = r.pdfBold ?? '';
    o.docxBold = r.docxBold ?? '';
    o.pdfItalic = r.pdfItalic ?? '';
    o.docxItalic = r.docxItalic ?? '';
    o.pdfImages = r.pdfImages ?? '';
    o.pdfStencils = r.pdfStencils ?? '';
    o.docxDrawings = r.docxDrawings ?? '';
    o.docxMedia = r.docxMedia ?? '';
    o.docxTables = r.docxTables ?? '';
    o.pageKinds = st.pageKinds ? `${kinds.text || 0}/${kinds['searchable-scan'] || 0}/${kinds.scan || 0}/${kinds.empty || 0}` : '';
    o.imagesFailed = st.imagesFailed ?? '';
    o.renderOk = r.renderOk ? 1 : (render && r.ok ? 0 : '');
    o.renderMs = r.renderMs ?? '';
    o.renderPages = r.renderPages ?? '';
    o.pageRatio = r.renderPages && r.pagesConverted ? (r.renderPages / r.pagesConverted).toFixed(2) : '';
    o.visGrid = r.visGrid == null ? '' : r.visGrid.toFixed(4);
    o.visRows = r.visRows == null ? '' : r.visRows.toFixed(4);
    o.inkRatio = r.inkRatio == null ? '' : r.inkRatio.toFixed(3);
    o.bodyPage = r.bodyPage || '';
    o.bodyFound = r.bodyFound ?? '';
    o.visBody = r.visBody == null ? '' : r.visBody.toFixed(4);
    o.inkBody = r.inkBody == null ? '' : r.inkBody.toFixed(3);
    o.columnBands = st.columnBands ?? '';
    return o;
  });
  const cols = Object.keys(out[0]);
  const csv = [cols.join(',')].concat(out.map((o) => cols.map((c) => { const v = String(o[c]); return /[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }).join(','))).join('\n');
  const csvName = ENGINE === 'ours' ? 'results.csv' : `results-${ENGINE}.csv`;
  fs.writeFileSync(path.join(OUT, csvName), `${csv}\n`);
  console.log(`wrote ${path.join(OUT, csvName)} (${out.length} rows, ${out.filter((o) => o.ok).length} ok)`);
}

export { tokens, recall, parseDocx };
if (ONE) childMain(ONE).catch((e) => { console.error(e); process.exit(2); });
else if (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then(() => process.exit(0));
