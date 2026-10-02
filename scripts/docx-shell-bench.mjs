#!/usr/bin/env node
/*
 * PDF -> DOCX in a real Chromium: wall time and PEAK MEMORY of the converter, per path.
 * A dev tool for the browser shell (js/docx/client.js); not part of the gate.
 *
 *   node scripts/docx-shell-bench.mjs --files n001,n010 --path worker|main|legacy
 *        [--throttle 1,4] [--maxpages N] [--root DIR] [--out results.json] [--corpus DIR]
 *        [--calibrate] [--limits '{"maxPages":300}'] [--jsflags=--max-old-space-size=128]
 *
 *   --path legacy   the OLD shape: convertPdfToDocx on the main thread (whole model, then one zip).
 *                   Point --root at an older checkout to measure the code as it was before the shell.
 *   --path main     convertPdfFile({ mode: 'main' }): the streaming converter on the main thread
 *   --path worker   convertPdfFile({ mode: 'worker' }): the streaming converter in the worker
 *
 * MEMORY is the OS's own number, not a JS heap guess: macOS `footprint` reports phys_footprint
 * (what the kernel and iOS jetsam count) and phys_footprint_peak (the high-water mark of the
 * process). Every run is a FRESH browser, so a renderer's peak belongs to that one conversion;
 * `baseline` is its footprint after the page loaded, `peak` the renderer's OS peak at the end,
 * `delta = peak - baseline`. `treeMaxSampled` is the largest SAMPLED sum over the whole browser
 * process tree (renderer + browser process, where finished Blobs live), every 100 ms.
 *
 * CPU THROTTLE. CDP Emulation.setCPUThrottlingRate throttles only the page's main thread: MEASURED a
 * spin loop in a worker at 55 ms under 4x while the same loop on the main thread went 54 -> 218 ms.
 * The converter and pdf.js both live in workers, so that would flatter every number. Instead the
 * renderer PROCESS is duty-cycled with SIGSTOP/SIGCONT (--duty STOP,RUN ms; default 15,4, which calibrated at ~4.2x on a spin loop, see --calibrate: 15,5 gave 2-3x and 20,5 gave 6-7x, the relation is not linear), which slows every
 * thread in it; --calibrate prints the factor it really gives on a spin loop in a worker and on
 * the main thread, and every throttled row carries that factor.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const eq = argv.find((a) => a.startsWith(`--${n}=`));
  if (eq) return eq.slice(n.length + 3);
  const i = argv.indexOf(`--${n}`);
  return i < 0 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true);
};
const ROOT = path.resolve(arg('root', path.join(HERE, '..')));
const CORPUS = arg('corpus', process.env.CORPUS || '/Users/ojanlubis/machine/fkd/pdflokal/app/tests/fixtures/wild/web');
const PATHS = String(arg('path', 'worker')).split(',');
const THROTTLES = String(arg('throttle', '1')).split(',').map(Number);
const FILES = String(arg('files', 'n001')).split(',');
const MAXPAGES = Number(arg('maxpages', 0)) || undefined;
const LIMITS = arg('limits') ? JSON.parse(arg('limits')) : undefined;
const DUTY = String(arg('duty', '15,4')).split(',').map(Number);
const OUT = arg('out', null);
const TIMEOUT_MS = Number(arg('timeout', 240)) * 1000;
const JSFLAGS = arg('jsflags', null); // e.g. '--max-old-space-size=128': a heap cap on EVERY isolate (page, converter worker, pdf.js worker)
const MB = (b) => Math.round(b / 1048576);

// ---- static server: the checkout, the corpus, and a bare bench page
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.wasm': 'application/wasm', '.json': 'application/json', '.pdf': 'application/pdf' };
const benchPage = (withLibs) => `<!doctype html><meta charset=utf-8><title>bench</title>${withLibs ? '<script src="/js/vendor/pdf.min.js"></script><script src="/js/vendor/fflate.min.js"></script><script>pdfjsLib.GlobalWorkerOptions.workerSrc="/js/vendor/pdf.worker.min.js"</script>' : ''}<body>bench`;
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/__bench.html') { res.setHeader('content-type', 'text/html'); res.end(benchPage(false)); return; }
  if (url === '/__bench-libs.html') { res.setHeader('content-type', 'text/html'); res.end(benchPage(true)); return; }
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

// ---- process tree + OS memory
const psAll = () => execSync('ps -A -o pid=,ppid=,command=', { encoding: 'utf8', maxBuffer: 1 << 26 }).trim().split('\n').map((l) => {
  const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
  return { pid: +m[1], ppid: +m[2], cmd: m[3] };
});
function treeOf(marker) {
  const all = psAll();
  const root = all.find((p) => p.cmd.includes(marker) && !/--type=/.test(p.cmd));
  if (!root) return { all: [], renderers: [] };
  const kids = new Set([root.pid]);
  for (let grew = true; grew;) { grew = false; for (const p of all) if (!kids.has(p.pid) && kids.has(p.ppid)) { kids.add(p.pid); grew = true; } }
  const tree = all.filter((p) => kids.has(p.pid));
  return { all: tree.map((p) => p.pid), renderers: tree.filter((p) => /--type=renderer/.test(p.cmd)).map((p) => p.pid), root: root.pid };
}
function footprint(pids) {
  if (!pids.length) return { now: 0, peak: 0 };
  let out = '';
  try { out = execSync(`footprint ${pids.map((p) => `-p ${p}`).join(' ')} --noCategories -f bytes 2>/dev/null`, { encoding: 'utf8' }); } catch { return { now: 0, peak: 0 }; }
  let now = 0; let peak = 0;
  for (const m of out.matchAll(/phys_footprint:\s*(\d+) B/g)) now += Number(m[1]);
  for (const m of out.matchAll(/phys_footprint_peak:\s*(\d+) B/g)) peak += Number(m[1]);
  return { now, peak };
}

// ---- CPU throttle for the whole renderer process (every thread in it)
function startThrottle(pids, [stopMs, runMs]) {
  let stop = false;
  const sig = (s) => { for (const p of pids) { try { process.kill(p, s); } catch { /* gone */ } } };
  const loop = (async () => {
    while (!stop) {
      sig('SIGSTOP');
      await new Promise((r) => setTimeout(r, stopMs));
      sig('SIGCONT');
      await new Promise((r) => setTimeout(r, runMs));
    }
    sig('SIGCONT');
  })();
  return async () => { stop = true; await loop; sig('SIGCONT'); };
}

const spin = (page) => page.evaluate(async () => {
  const code = 'onmessage=()=>{const t=performance.now();let x=0;for(let i=0;i<4e8;i++){x+=i%7}postMessage({ms:performance.now()-t,x})}';
  const w = new Worker(URL.createObjectURL(new Blob([code])));
  const t = performance.now(); let x = 0; for (let i = 0; i < 4e8; i++) x += i % 7;
  const main = performance.now() - t;
  const ms = await new Promise((r) => { w.onmessage = (e) => r(e.data.ms); w.postMessage(1); });
  w.terminate();
  return { workerMs: ms, mainMs: main + (x < 0 ? 1 : 0) };
});

async function withBrowser(fn, { libs }) {
  const marker = `bm${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const browser = await chromium.launch({ args: [`--bench-marker=${marker}`, ...(JSFLAGS ? [`--js-flags=${JSFLAGS}`] : [])] });
  try {
    const page = await (await browser.newContext({ viewport: { width: 390, height: 800 } })).newPage();
    page.on('pageerror', (e) => console.error('pageerror', String(e).slice(0, 300)));
    await page.goto(`${ORIGIN}/${libs ? '__bench-libs.html' : '__bench.html'}`);
    await new Promise((r) => setTimeout(r, 400));
    return await fn({ browser, page, marker });
  } finally {
    await browser.close();
  }
}

if (argv.includes('--calibrate')) {
  for (const duty of [DUTY]) {
    await withBrowser(async ({ page, marker }) => {
      const base = await spin(page);
      const t = treeOf(marker);
      const off = startThrottle(t.renderers, duty);
      const slow = await spin(page);
      await off();
      console.log(JSON.stringify({ duty, baseline: base, throttled: slow, factorWorker: +(slow.workerMs / base.workerMs).toFixed(2), factorMain: +(slow.mainMs / base.mainMs).toFixed(2) }));
    }, { libs: false });
  }
  server.close();
  process.exit(0);
}

const runner = async ({ url, path: which, maxPages, limits }) => {
  const buf = await (await fetch(url)).arrayBuffer();
  const t0 = performance.now();
  if (which === 'legacy') {
    const { convertPdfToDocx } = await import('/js/docx/convert.js');
    const r = await convertPdfToDocx({ pdfjs: window.pdfjsLib, fflate: window.fflate, data: new Uint8Array(buf), maxPages });
    return { ms: performance.now() - t0, outBytes: r.docx.length, pages: r.model.pages.length, stats: { tables: r.stats.tables, errors: r.stats.errors.length, pageKinds: r.stats.pageKinds } };
  }
  const { convertPdfFile } = await import('/js/docx/client.js');
  const r = await convertPdfFile(buf, { mode: which, maxPages, limits, onProgress: () => {} });
  return { ms: performance.now() - t0, outBytes: r.blob.size, pages: r.writer.pages, writer: r.writer, stats: { tables: r.stats.tables, errors: r.stats.errors.length, pageKinds: r.stats.pageKinds, evictions: r.stats.imageCacheEvictions, truncated: r.stats.truncated } };
};

const rows = [];
for (const id of FILES) {
  const isPath = id.includes('/');
  const url = isPath ? `/__corpus/${path.basename(id)}` : `/__corpus/${id}.pdf`;
  for (const which of PATHS) {
    for (const rate of THROTTLES) {
      const row = await withBrowser(async ({ page, marker }) => {
        const t = treeOf(marker);
        const base = footprint(t.renderers);
        let treeMax = 0;
        let stopSampling = false;
        const sampler = (async () => {
          while (!stopSampling) {
            const cur = treeOf(marker);
            const f = footprint(cur.all);
            if (f.now > treeMax) treeMax = f.now;
            await new Promise((r) => setTimeout(r, 100));
          }
        })();
        const off = rate > 1 ? startThrottle(t.renderers, DUTY) : async () => {};
        let res; let err = null;
        const crashed = new Promise((_, rej) => { page.on('crash', () => rej(new Error('renderer crashed (out of memory?)'))); });
        const timedOut = new Promise((_, rej) => { setTimeout(() => rej(new Error(`no result in ${TIMEOUT_MS / 1000}s (hung or thrashing)`)), TIMEOUT_MS); });
        try { res = await Promise.race([page.evaluate(runner, { url, path: which, maxPages: MAXPAGES, limits: LIMITS }), crashed, timedOut]); } catch (e) { err = String(e.message || e).slice(0, 200); }
        await off();
        stopSampling = true;
        await sampler;
        const after = treeOf(marker);
        const end = footprint(after.renderers);
        const endTree = footprint(after.all);
        return { id, path: which, throttle: rate, duty: rate > 1 ? DUTY : undefined, jsflags: JSFLAGS || undefined, error: err, ...(res || {}), baselineMB: MB(base.now), peakMB: MB(end.peak), deltaMB: MB(end.peak - base.now), treeMaxSampledMB: MB(Math.max(treeMax, endTree.now)), msPerPage: res ? Math.round(res.ms / Math.max(1, res.pages)) : null };
      }, { libs: which !== 'worker' });
      row.ms = row.ms && Math.round(row.ms);
      rows.push(row);
      console.log(JSON.stringify(row));
    }
  }
}
if (OUT) fs.writeFileSync(OUT, JSON.stringify(rows, null, 1));
server.close();
process.exit(0);
