/*
 * SHARED HARNESS: run index.html's real boot guard against a stubbed window.
 * ============================================================================
 * Not a *.test.mjs, so `npm run test:core` does not pick it up as a suite.
 * Used by boot-guard.test.mjs (the heal logic) and boot-failure-beacon.test.mjs
 * (what it reports). One harness, because two copies of a stub drift and the
 * one that drifts is the one nobody is reading.
 *
 * The snippet is LIFTED FROM THE PAGE and executed as written — never
 * paraphrased. Every global it touches is passed as a parameter, which shadows
 * the real one, so a bare reference cannot escape the stub.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

// The pages that load js/v2/app.js — the landing plus the 12 generated tool
// pages, which inherit index.html's head verbatim through the generator.
export const PAGES = ['index.html', ...JSON.parse(fs.readFileSync(path.join(ROOT, 'seo/pages.json'), 'utf8'))
  .pages.map((p) => `${p.slug}.html`)];

export const MARKER = 'pdflokal_boot_healed';

// ⚠️ THE SCRIPT TAG, NOT THE STRING. index.html mentions `js/v2/app.js` twice as
// PROSE inside its <style> comments, both times ABOVE the guard — an
// indexOf('js/v2/app.js') therefore reports the module as loading before the head
// script that catches it, and this harness's first draft failed a correct page for
// it. Same scar the SEO generator carries (see gen-seo-pages.js's split note):
// an anchor that also occurs as prose is not an anchor.
export const APP_SCRIPT = /<script type="module" src="js\/v2\/app\.js">/;

// Lift the snippet BODY out of a page. Deliberately not one giant regex, for the
// same reason: splitting on the tags and selecting by marker cannot pick up a
// mention of the guard in a comment, because a comment is not inside a <script>.
export function guardOf(file) {
  const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const hits = [];
  let i = 0;
  for (;;) {
    const open = html.indexOf('<script>', i);
    if (open === -1) break;
    const close = html.indexOf('</script>', open);
    if (close === -1) break;
    const body = html.slice(open + '<script>'.length, close);
    if (body.includes(MARKER)) hits.push(body);
    i = close + 1;
  }
  return hits;
}

export function runGuard({ online = true, storage = 'ok', randomUUID = true, healedAlready = false } = {}) {
  const src = guardOf('index.html')[0];
  const calls = { reloads: 0, cachesDeleted: [], unregisters: 0, beacons: [] };
  const listeners = {};
  const store = new Map();
  if (healedAlready) store.set(MARKER, '1');

  const sessionStorage = storage === 'throws'
    ? { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } }
    : { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };

  const caches = {
    keys: async () => ['pdflokal-shell-v2', 'pdflokal-shell-v3'],
    delete: async (k) => { calls.cachesDeleted.push(k); return true; },
  };
  const navigator = {
    onLine: online,
    sendBeacon: (url, blob) => { calls.beacons.push({ url, body: blob && blob.__text, type: blob && blob.type }); return true; },
    serviceWorker: {
      getRegistrations: async () => [{ unregister: async () => { calls.unregisters++; return true; } }],
    },
  };
  const window = {
    caches,
    addEventListener: (t, f) => { (listeners[t] || (listeners[t] = [])).push(f); },
    removeEventListener: (t, f) => { listeners[t] = (listeners[t] || []).filter((x) => x !== f); },
  };
  const location = { reload: () => { calls.reloads++; } };
  const document = { querySelector: () => null };
  // `randomUUID: false` is the iOS Safari < 15.4 / non-secure-context case.
  const crypto = randomUUID ? { randomUUID: () => '3f1c9a52-0b6e-4a7d-9c11-2f7e5d8a4b30' } : {};
  class Blob {
    constructor(parts, opts) { this.__text = (parts || []).join(''); this.type = opts && opts.type; }
  }

  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'navigator', 'location', 'sessionStorage', 'caches', 'crypto', 'Blob', 'fetch', src)(
    window, document, navigator, location, sessionStorage, caches, crypto, Blob,
    (url, init) => { calls.beacons.push({ url, body: init && init.body, type: 'fetch' }); return Promise.resolve(); },
  );

  assert.ok(listeners.error && listeners.error.length === 1,
    'the guard did not install exactly one window error listener');

  const settle = () => new Promise((r) => { setTimeout(r, 0); });
  return {
    calls,
    async error(message) { for (const f of listeners.error || []) f({ message }); await settle(); await settle(); },
    async load() { for (const f of listeners.load || []) f({}); await settle(); },
  };
}

// The messages this guard exists for, in the phrasings the three engines use.
// The first two are MEASURED — Sentry JAVASCRIPT-Y/Z and V/J, 2026-08-18 → 08-30,
// all of them Safari. The rest are the same two failures as Chrome and Firefox
// word them, included because the fix must not be Safari-shaped.
export const SKEW_MESSAGES = [
  "SyntaxError: Importing binding name 'ocrLinesBucket' is not found.",
  'null is not an object (evaluating "document.getElementById(\'fm-pages\').addEventListener")',
  "The requested module './telemetry-schema.js' does not provide an export named 'ocrLinesBucket'",
  "Uncaught TypeError: Cannot read properties of null (reading 'addEventListener')",
  'import not found: ocrLinesBucket',
  'document.getElementById(...) is null',
];
