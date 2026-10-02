#!/usr/bin/env node
/*
 * PDF -> DOCX in a REAL browser (Chromium via Playwright): the two things node
 * cannot show.
 *   1. PHONE-ish timing: the converter run in-page with CDP CPU throttling
 *      (1x, 4x, 6x) on a spread of corpus files.
 *   2. SCANS: the in-browser OCR (the app's own Tesseract engine) feeding the
 *      same layout pipeline. Real scan n083 + SYNTHETIC scans (pages of
 *      text-born corpus files rasterised at 150 dpi into image-only PDFs, so
 *      the true text is known).
 *
 *   node scripts/docx-spike-browser.mjs --out DIR [--ids n001,n012,...] [--throttle 1,4,6] [--ocr]
 *
 * The page is served from a static server this script starts and stops. No
 * CSP headers (the production CSP already grants OCR; see ocr-demo.mjs).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { tokens, recall, parseDocx } from './docx-gate.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = process.env.CORPUS || '/Users/ojanlubis/machine/fkd/pdflokal/app/tests/fixtures/wild/web';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };
const OUT = arg('out');
const IDS = String(arg('ids', 'n001,n003,n005,n012,n034,n040,n052,n067')).split(',');
const THROTTLE = String(arg('throttle', '1,4,6')).split(',').map(Number);
const DO_OCR = argv.includes('--ocr');
const PAGES = Number(arg('maxpages', 10));
const SYN = path.join(OUT, 'synthetic');
fs.mkdirSync(SYN, { recursive: true });

// ---- synthetic scans: rasterise page 1..2 of a text-born file into an image-only PDF
function makeScan(id, pages) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syn-'));
  spawnSync('pdftoppm', ['-r', '150', '-jpeg', '-jpegopt', 'quality=80', '-f', '1', '-l', String(pages), path.join(CORPUS, `${id}.pdf`), path.join(dir, 'p')]);
  const jpgs = fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort();
  const loadUmd = (p) => { const module = { exports: {} }; new Function('module', 'exports', 'self', 'window', 'global', 'define', fs.readFileSync(path.join(ROOT, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis, undefined); return module.exports; };
  const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
  return (async () => {
    const doc = await PDFLib.PDFDocument.create();
    const srcInfo = spawnSync('pdfinfo', [path.join(CORPUS, `${id}.pdf`)], { encoding: 'utf8' }).stdout;
    const m = /Page size:\s+([\d.]+) x ([\d.]+)/.exec(srcInfo);
    const w = m ? Number(m[1]) : 595;
    const h = m ? Number(m[2]) : 842;
    for (const j of jpgs) {
      const img = await doc.embedJpg(fs.readFileSync(path.join(dir, j)));
      const pg = doc.addPage([w, h]);
      pg.drawImage(img, { x: 0, y: 0, width: w, height: h });
    }
    const file = path.join(SYN, `${id}-scan.pdf`);
    fs.writeFileSync(file, await doc.save());
    const ref = spawnSync('pdftotext', ['-f', '1', '-l', String(pages), '-enc', 'UTF-8', path.join(CORPUS, `${id}.pdf`), '-'], { encoding: 'utf8', maxBuffer: 1 << 26 }).stdout;
    return { file, ref: tokens(ref) };
  })();
}

// ---- static server
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.wasm': 'application/wasm', '.json': 'application/json', '.traineddata': 'application/octet-stream' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/__spike.html') {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><meta charset=utf-8><script src="/js/vendor/pdf.min.js"></script><script src="/js/vendor/fflate.min.js"></script><body>spike');
    return;
  }
  let file;
  if (url.startsWith('/__corpus/')) file = path.join(CORPUS, url.slice(10));
  else if (url.startsWith('/__syn/')) file = path.join(SYN, url.slice(7));
  else file = path.join(ROOT, url);
  if (!file.startsWith(CORPUS) && !file.startsWith(SYN) && !file.startsWith(ROOT)) { res.statusCode = 403; res.end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.statusCode = 404; res.end(); return; }
    res.setHeader('content-type', MIME[path.extname(file)] || 'application/octet-stream');
    res.end(buf);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('pageerror', String(e).slice(0, 200)));
await page.goto(`${ORIGIN}/__spike.html`);
await page.evaluate(() => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/js/vendor/pdf.worker.min.js'; });
const cdp = await ctx.newCDPSession(page);

// in-page runner: fetch pdf, convert, return stats + docx base64
const runner = async ({ url, maxPages, useOcr }) => {
  const { convertPdfToDocx } = await import('/js/docx/convert.js');
  const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
  let ocr = null;
  if (useOcr) {
    const { recognizeCanvas } = await import('/js/v2/ocr-engine.js');
    const { ocrLinesToPageLines, ocrScaleFor } = await import('/js/core/ocr-lines.js');
    ocr = async ({ page: pg, viewport }) => {
      const scale = ocrScaleFor(viewport.width);
      const vp = pg.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      await pg.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      const data = await recognizeCanvas(canvas);
      return ocrLinesToPageLines(data, scale);
    };
  }
  const t0 = performance.now();
  const r = await convertPdfToDocx({ pdfjs: window.pdfjsLib, fflate: window.fflate, data: buf, maxPages, ocr });
  const ms = performance.now() - t0;
  let bin = '';
  for (let i = 0; i < r.docx.length; i += 0x8000) bin += String.fromCharCode.apply(null, r.docx.subarray(i, i + 0x8000));
  return { ms, stats: r.stats, bytes: r.docx.length, b64: btoa(bin), heap: performance.memory ? performance.memory.usedJSHeapSize : null, heapLimit: performance.memory ? performance.memory.jsHeapSizeLimit : null };
};

const results = { timing: [], ocr: [] };
// ---- 1. timing under CPU throttle
for (const id of IDS) {
  const info = spawnSync('pdfinfo', [path.join(CORPUS, `${id}.pdf`)], { encoding: 'utf8' }).stdout;
  const pages = Number((/Pages:\s+(\d+)/.exec(info) || [])[1]) || 0;
  const n = Math.min(PAGES, pages);
  for (const rate of THROTTLE) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    const r = await page.evaluate(runner, { url: `/__corpus/${id}.pdf`, maxPages: n, useOcr: false });
    if (rate === 1 && argv.includes('--save')) {
      fs.mkdirSync(path.join(OUT, 'docx-browser'), { recursive: true });
      fs.writeFileSync(path.join(OUT, 'docx-browser', `${id}.docx`), Buffer.from(r.b64, 'base64'));
    }
    results.timing.push({ id, pages: n, throttle: rate, ms: Math.round(r.ms), msPerPage: Math.round(r.ms / n), docxBytes: r.bytes, heapMB: r.heap ? Math.round(r.heap / 1e6) : null });
    console.log(`timing ${id} ${n}p x${rate}: ${Math.round(r.ms)} ms (${Math.round(r.ms / n)} ms/page), heap ${r.heap ? Math.round(r.heap / 1e6) : '?'} MB`);
  }
}
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

// ---- 2. OCR on scans
if (DO_OCR) {
  const cases = [{ id: 'n083', url: '/__corpus/n083.pdf', ref: null, pages: 3 }];
  for (const id of (arg('synids', 'n001,n003,n012,n005') + '').split(',')) {
    const s = await makeScan(id, 2);
    cases.push({ id: `${id}-scan`, url: `/__syn/${path.basename(s.file)}`, ref: s.ref, pages: 2 });
  }
  for (const c of cases) {
    try {
      const r = await page.evaluate(runner, { url: c.url, maxPages: c.pages, useOcr: true });
      const docxPath = path.join(OUT, `ocr-${c.id}.docx`);
      fs.writeFileSync(docxPath, Buffer.from(r.b64, 'base64'));
      const d = parseDocx(docxPath);
      const rec = c.ref ? recall(c.ref, d.words) : null;
      results.ocr.push({ id: c.id, pages: c.pages, ms: Math.round(r.ms), ocrMs: r.stats.ocrMs, kinds: r.stats.pageKinds, docxWords: d.words.length, refWords: c.ref ? c.ref.length : null, recallLcs: rec ? +rec.lcs.toFixed(3) : null, recallBag: rec ? +rec.bag.toFixed(3) : null, paras: d.paras });
      console.log('ocr', JSON.stringify(results.ocr[results.ocr.length - 1]));
    } catch (e) {
      results.ocr.push({ id: c.id, error: String(e).slice(0, 200) });
      console.log('ocr FAIL', c.id, String(e).slice(0, 200));
    }
  }
}
fs.writeFileSync(path.join(OUT, 'browser-results.json'), JSON.stringify(results, null, 1));
await browser.close();
server.close();
process.exit(0);
