/*
 * The live CSP (vercel.json) keeps the grants the product depends on, and no more.
 *
 * HISTORY. This file used to be csp-doc-parity: docs/security.md carried a
 * hand-copied CSP that had drifted in the dangerous direction (it claimed
 * 'unsafe-eval', which the live policy never granted), and test 1 held the copy
 * equal to vercel.json. On 2026-09-25 (a3f7cc9, his rule: point at the code,
 * never copy it) the doc stopped carrying a copy, so there is nothing left to
 * drift and that test was deleted. The two invariants below test the policy
 * itself and stay.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

function liveCsp() {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  for (const entry of cfg.headers || []) {
    for (const h of entry.headers || []) {
      if (String(h.key).toLowerCase() === 'content-security-policy') return h.value;
    }
  }
  return null;
}

// Directive name -> sorted source list, so formatting and ordering differences
// between the two files never fail the test but a real difference always does.
function parse(csp) {
  const out = new Map();
  for (const part of csp.split(';')) {
    const bits = part.trim().split(/\s+/).filter(Boolean);
    if (!bits.length) continue;
    out.set(bits[0], bits.slice(1).sort().join(' '));
  }
  return out;
}

test('1. eval() is still forbidden, and wasm is now deliberately allowed', () => {
  // 2026-07-30: 'wasm-unsafe-eval' was ADDED by ruling (Fauzan delegated the
  // security call to the PM; recorded in the seat's decisions.md). This test
  // previously asserted NEITHER token was present, and it went red on the
  // change - which is the guard working, not a problem. It is updated
  // deliberately rather than deleted.
  const script = parse(liveCsp()).get('script-src') || '';

  // Still forbidden, and the distinction is the whole point: 'wasm-unsafe-eval'
  // permits WebAssembly compilation ONLY. Full 'unsafe-eval' would re-open
  // eval()/new Function() across the entire product.
  assert.equal(
    /(^|\s)'unsafe-eval'/.test(script), false,
    "script-src grants full 'unsafe-eval'. WebAssembly does not need it - "
    + "'wasm-unsafe-eval' is the narrow grant. This would re-open eval() product-wide.",
  );
  assert.ok(
    script.includes("'wasm-unsafe-eval'"),
    "script-src lost 'wasm-unsafe-eval'. OCR cannot compile its engine without it "
    + '(scripts/ocr-demo.mjs demonstrates the failure).',
  );
});

test('2. worker-src keeps BOTH self and blob: - dropping self kills offline', () => {
  // ⚠️ THE TRAP THIS EXISTS FOR. OCR needs blob: because tesseract.js builds
  // its worker from a Blob URL. Writing `worker-src blob:` instead of
  // `worker-src 'self' blob:` still makes OCR work, so it LOOKS correct - and
  // silently kills the SERVICE WORKER, and with it offline mode, which is a
  // shipped and announced feature ("TETAP JALAN when the connection drops").
  // Nothing throws. The page looks fine. A feature stops existing.
  const worker = parse(liveCsp()).get('worker-src') || '';
  assert.ok(
    /(^|\s)'self'/.test(worker),
    `worker-src is "${worker}" and has lost 'self'. The service worker cannot register, so offline `
    + 'mode is gone with no error anywhere. Use "worker-src \'self\' blob:".',
  );
  assert.ok(
    worker.includes('blob:'),
    `worker-src is "${worker}" and has lost blob:. tesseract.js builds its worker from a Blob URL, `
    + 'so OCR fails before any wasm is compiled.',
  );
});

