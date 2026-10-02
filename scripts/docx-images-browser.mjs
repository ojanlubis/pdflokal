#!/usr/bin/env node
/*
 * PDF -> DOCX images in a REAL browser (Chromium via Playwright): the path that ships.
 * The gate runs in node, where images are painted through an injected @napi-rs/canvas; here the same
 * engine runs on the browser's own OffscreenCanvas, with pdf.js stepping the render the way it does
 * for a user (and the page hidden, to prove a background tab does not stall the conversion).
 *
 *   node scripts/docx-images-browser.mjs --out DIR [--ids n067,n097] [--maxpages 6] [--hidden]
 *
 * Writes DIR/<id>.docx and prints per-file stats. Compare with the node run (docx-gate.mjs) by
 * picture count and by eye: the two canvases antialias differently, so bytes will not match.
 * The page is served from a static server this script starts and stops.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = process.env.CORPUS || '/Users/ojanlubis/machine/fkd/pdflokal/app/tests/fixtures/wild/web';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };
const OUT = arg('out');
if (!OUT) { console.error('usage: docx-images-browser.mjs --out DIR [--ids n067,n097] [--maxpages 6] [--hidden]'); process.exit(2); }
const IDS = String(arg('ids', 'n067,n097,n010')).split(',');
const PAGES = Number(arg('maxpages', 6));
fs.mkdirSync(OUT, { recursive: true });

const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/__run.html') {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><meta charset=utf-8><script src="/js/vendor/pdf.min.js"></script><script src="/js/vendor/fflate.min.js"></script><body>run');
    return;
  }
  const file = url.startsWith('/__corpus/') ? path.join(CORPUS, url.slice(10)) : path.join(ROOT, url);
  if (!file.startsWith(CORPUS) && !file.startsWith(ROOT)) { res.statusCode = 403; res.end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.statusCode = 404; res.end(); return; }
    res.setHeader('content-type', MIME[path.extname(file)] || 'application/octet-stream');
    res.end(buf);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const bctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
const page = await bctx.newPage();
page.on('pageerror', (e) => console.log('pageerror', String(e).slice(0, 200)));
await page.goto(`${ORIGIN}/__run.html`);
await page.evaluate(() => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/js/vendor/pdf.worker.min.js'; });
if (argv.includes('--hidden')) {
  // a tab nobody is looking at: requestAnimationFrame never fires, so pdf.js's own render stepping would hang
  await page.evaluate(() => { window.requestAnimationFrame = () => 0; });
}

const runner = async ({ url, maxPages }) => {
  const { convertPdfToDocx } = await import('/js/docx/convert.js');
  const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const t0 = performance.now();
  const r = await convertPdfToDocx({ pdfjs: window.pdfjsLib, fflate: window.fflate, data: buf, maxPages });
  const ms = performance.now() - t0;
  let bin = '';
  for (let i = 0; i < r.docx.length; i += 0x8000) bin += String.fromCharCode.apply(null, r.docx.subarray(i, i + 0x8000));
  return { ms, stats: r.stats, bytes: r.docx.length, b64: btoa(bin) };
};

for (const id of IDS) {
  try {
    const r = await page.evaluate(runner, { url: `/__corpus/${id}.pdf`, maxPages: PAGES });
    fs.writeFileSync(path.join(OUT, `${id}.docx`), Buffer.from(r.b64, 'base64'));
    const s = r.stats;
    console.log(id, `${Math.round(r.ms)} ms`, `${r.bytes} bytes`, JSON.stringify({ plain: s.imagesPlain, painted: s.imagesPainted, paintFailed: s.imagesPaintFailed, maskSources: s.imageMaskSources, masksSkipped: s.imageMasksSkipped, failed: s.imagesFailed, anchored: s.anchored, errors: s.errors.slice(0, 3) }));
  } catch (e) {
    console.log(id, 'FAIL', String(e).slice(0, 300));
  }
}
await browser.close();
server.close();
process.exit(0);
