#!/usr/bin/env node
/*
 * PDF -> DOCX colour lane in a REAL browser (Chromium via Playwright): the one thing node cannot show,
 * raster.js (the regions colour.js cannot draw natively, painted by pdf.js's own renderer with the text left out).
 *
 *   node scripts/docx-color-browser.mjs --out DIR [--ids n029,n095] [--maxpages 6]
 *
 * Per file: convert twice in-page (raster off via options.rasterize = () => null, then the default raster.js),
 * save both .docx, report stats.rasterised, bytes, and word recall of each against pdf.js text (a picture with
 * the TEXT baked in would show as extra words in a render, not in recall: the render check is by eye or by
 * counting text in the picture, see --png which renders both through LibreOffice in colour).
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { parseDocx } from './docx-gate.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = process.env.CORPUS || '/Users/ojanlubis/machine/fkd/pdflokal/app/tests/fixtures/wild/web';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
const OUT = arg('out');
const IDS = String(arg('ids', 'n029,n095')).split(',');
const PAGES = Number(arg('maxpages', 6));
fs.mkdirSync(OUT, { recursive: true });

const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/__t.html') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><meta charset=utf-8><script src="/js/vendor/pdf.min.js"></script><script src="/js/vendor/fflate.min.js"></script><body>t'); return; }
  const file = url.startsWith('/__corpus/') ? path.join(CORPUS, url.slice(10)) : path.join(ROOT, url);
  fs.readFile(file, (err, buf) => { if (err) { res.statusCode = 404; res.end(); return; } res.setHeader('content-type', MIME[path.extname(file)] || 'application/octet-stream'); res.end(buf); });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
page.on('pageerror', (e) => console.log('pageerror', String(e).slice(0, 300)));
await page.goto(`http://127.0.0.1:${server.address().port}/__t.html`);
await page.evaluate(() => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/js/vendor/pdf.worker.min.js'; });

const runner = async ({ url, maxPages, raster }) => {
  const { convertPdfToDocx } = await import('/js/docx/convert.js');
  const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const t0 = performance.now();
  const r = await convertPdfToDocx({ pdfjs: window.pdfjsLib, fflate: window.fflate, data: buf, maxPages, options: raster ? {} : { rasterize: () => null } });
  const ms = performance.now() - t0;
  let bin = '';
  for (let i = 0; i < r.docx.length; i += 0x8000) bin += String.fromCharCode.apply(null, r.docx.subarray(i, i + 0x8000));
  return { ms, stats: r.stats, bytes: r.docx.length, b64: btoa(bin) };
};
for (const id of IDS) {
  for (const raster of [false, true]) {
    const r = await page.evaluate(runner, { url: `/__corpus/${id}.pdf`, maxPages: PAGES, raster });
    const f = path.join(OUT, `${id}-${raster ? 'raster' : 'plain'}.docx`);
    fs.writeFileSync(f, Buffer.from(r.b64, 'base64'));
    const d = parseDocx(f);
    console.log(`${id} raster=${raster} ${Math.round(r.ms)}ms bytes=${r.bytes} words=${d.words.length} shapes=${r.stats.shapes} errors=${JSON.stringify(r.stats.errors)}`);
  }
}
await browser.close();
server.close();
process.exit(0);
