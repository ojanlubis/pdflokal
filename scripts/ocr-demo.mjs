#!/usr/bin/env node
/*
 * OCR DEMO RIG — serve the app under the REAL production CSP.
 *
 *   node scripts/ocr-demo.mjs                 # exactly what pdflokal.id sends today
 *   node scripts/ocr-demo.mjs --allow-wasm    # the same, plus 'wasm-unsafe-eval'
 *
 * Then open http://localhost:5055/lab-ocr.html and press "Jalankan OCR".
 *
 * ⚠️ WHY THIS RIG EXISTS AT ALL. `npx serve` sends NO headers, so OCR works
 * locally no matter what the production CSP says. A local test that passes
 * therefore tells you nothing about production — which is the exact trap that
 * makes this whole question hard to see. This server sends the real policy, so
 * what you get here is what the live site does.
 *
 * ⚠️ THE POLICY IS READ FROM vercel.json, NEVER RETYPED. A hand-copied CSP in a
 * demo would be one more drift pair, and docs/security.md already drifted this
 * way once: it claimed 'unsafe-eval' was granted when the live policy has never
 * had it. If this rig disagreed with production it would be worse than useless,
 * because it would be convincing.
 *
 * WHAT THE PAIR SHOWS
 *   default        the OCR press FAILS. The first wall is worker-src refusing a
 *                  blob: worker; behind it waits the WebAssembly CompileError.
 *                  Seen rather than described.
 *   --allow-wasm   same page, same press, it works. Grants BOTH
 *                  script-src 'wasm-unsafe-eval' and worker-src blob:, which
 *                  together are the minimum OCR needs.
 *
 * AND THE CONTROL, because the directive names are confusingly similar:
 * `'wasm-unsafe-eval'` does NOT grant `eval()`. The lab page has a "Cek eval()"
 * button that runs `eval('1+1')` and reports what the browser did. Under
 * --allow-wasm it must STILL be blocked. Granting wasm is not granting eval,
 * and that is worth seeing rather than being told.
 *
 * This rig DEMONSTRATES. It never edits vercel.json. The ruling is Fauzan's.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.OCR_DEMO_PORT || 5055);
const ALLOW_WASM = process.argv.includes('--allow-wasm');

function livePolicy() {
  const cfg = JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  for (const entry of cfg.headers || []) {
    for (const h of entry.headers || []) {
      if (String(h.key).toLowerCase() === 'content-security-policy') return h.value;
    }
  }
  throw new Error('no Content-Security-Policy found in vercel.json');
}
const BASE = livePolicy();
// Add the directive the same way a real change would: into script-src, not by
// appending a new one, because a second script-src is ignored by the browser.
// ⚠️ TWO DIRECTIVES, NOT ONE, AND THE SECOND WAS A LATE DISCOVERY.
// An isolated probe of WebAssembly.instantiate() said the only blocker was
// script-src's missing 'wasm-unsafe-eval'. True in isolation, and INCOMPLETE:
// the real engine hits a different wall FIRST. tesseract.js builds its worker
// from a Blob URL, and `worker-src 'self'` forbids blob:, so the page fails at
// "Creating a worker from 'blob:...' violates the following Content Security
// Policy" before any wasm is compiled. Only running the actual page under the
// actual header showed that; the synthetic probe could not.
const CSP = ALLOW_WASM
  ? BASE
    .replace(/script-src /, "script-src 'wasm-unsafe-eval' ")
    .replace(/worker-src 'self'/, "worker-src 'self' blob:")
  : BASE;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
  '.pdf': 'application/pdf', '.traineddata': 'application/octet-stream',
  '.webmanifest': 'application/manifest+json',
};

createServer(async (req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  let file = path.join(ROOT, url === '/' ? 'index.html' : url);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('no'); return; }
  try {
    const s = await stat(file);
    if (s.isDirectory()) file = path.join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      // THE POINT OF THE WHOLE RIG.
      'Content-Security-Policy': CSP,
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404');
  }
}).listen(PORT, () => {
  console.log('');
  console.log(`  OCR demo rig  ->  http://localhost:${PORT}/lab-ocr.html`);
  console.log('');
  console.log(`  CSP: ${ALLOW_WASM ? "PRODUCTION + 'wasm-unsafe-eval'" : 'EXACTLY PRODUCTION (read from vercel.json)'}`);
  console.log(`  script-src: ${(CSP.match(/script-src[^;]*/) || ['?'])[0]}`);
  console.log(`  worker-src: ${(CSP.match(/worker-src[^;]*/) || ['?'])[0]}`);
  console.log('');
  console.log(ALLOW_WASM
    ? '  Expect: "Jalankan OCR" WORKS. "Cek eval()" is still BLOCKED.'
    : '  Expect: "Jalankan OCR" FAILS with a WebAssembly CompileError. That is the wall.');
  console.log('');
  console.log('  Ctrl-C to stop.');
});
