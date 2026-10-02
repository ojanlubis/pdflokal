/*
 * SHARED HARNESS: run the real sw.js against a stub of the worker global.
 * ============================================================================
 * Not a *.test.mjs, so `npm run test:core` does not pick it up as a suite.
 * Used by sw-shell-refresh.test.mjs and sw-generations.test.mjs. One harness,
 * because two copies of a stub drift and the one that drifts is the one nobody
 * is reading (same reason as boot-guard-harness.mjs).
 *
 * The stub models what sw.js v8 depends on and nothing else: NAMED caches (a
 * generation is a cache of its own, so a single shared Map would hide exactly
 * the mixing this worker exists to prevent), `caches.match` with and without
 * `cacheName`, and window clients with ids and navigate(). A stored Response is
 * cloned on every read, so a test can read the same entry twice.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SW_SRC = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
export const ORIGIN = 'https://www.pdflokal.id';

function constOf(name) {
  const m = new RegExp(`^const ${name} = '([^']+)';$`, 'm').exec(SW_SRC);
  assert.ok(m, `sw.js no longer declares \`const ${name} = '…';\` at the top level — the harness cannot name its caches`);
  return m[1];
}
export const CACHE = constOf('CACHE');
export const GEN_PREFIX = constOf('GEN_PREFIX');
export const COMPLETE = constOf('COMPLETE');

// A 200 same-origin response the handler will agree to cache. Node's Response
// reports type 'default'; the worker's `cacheable()` asks for 'basic', which
// is what a same-origin fetch reports in a browser.
export function basic(body) {
  const res = new Response(body, { status: 200 });
  Object.defineProperty(res, 'type', { value: 'basic' });
  return res;
}
export const key = (req) => new URL(typeof req === 'string' ? req : req.url, ORIGIN).href;
export const text = async (res) => (res ? res.text() : null);

// Load sw.js into a fresh worker-shaped global. `fetchImpl` is the network.
export function loadWorker(fetchImpl, { online = true, failAdd = [] } = {}) {
  const listeners = {};
  const named = new Map();
  const live = new Map();
  const navigations = [];
  const storeOf = (name) => {
    if (!named.has(name)) named.set(name, new Map());
    return named.get(name);
  };
  const cacheObj = (name) => {
    const store = storeOf(name);
    return {
      put: async (req, res) => { store.set(key(req), res); },
      match: async (req) => { const r = store.get(key(req)); return r ? r.clone() : undefined; },
      keys: async () => [...store.keys()].map((url) => ({ url })),
      delete: async (req) => store.delete(key(req)),
      addAll: async (urls) => { for (const u of urls) store.set(key(u), basic(`precached ${u}`)); },
      // add() rejects for the URLs in `failAdd`: a /en that 404s or redirects at install.
      add: async (u) => {
        if (failAdd.includes(u)) throw new TypeError('bad response');
        store.set(key(u), basic(`precached ${u}`));
      },
    };
  };
  const caches = {
    open: async (name) => cacheObj(name),
    has: async (name) => named.has(name),
    keys: async () => [...named.keys()],
    delete: async (name) => named.delete(name),
    match: async (req, opts = {}) => {
      if (opts.cacheName) return named.has(opts.cacheName) ? cacheObj(opts.cacheName).match(req) : undefined;
      for (const name of named.keys()) {
        const hit = await cacheObj(name).match(req);
        if (hit) return hit;
      }
      return undefined;
    },
  };
  const client = (id) => ({ id, url: live.get(id), navigate: async (u) => { navigations.push({ id, url: u }); } });
  const self = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    location: new URL(ORIGIN + '/sw.js'),
    navigator: { onLine: online },
    clients: {
      claim: async () => {},
      get: async (id) => (live.has(id) ? client(id) : undefined),
      matchAll: async () => [...live.keys()].map(client),
    },
    skipWaiting: async () => {},
  };
  const ctx = vm.createContext({ self, caches, fetch: fetchImpl, Response, URL, console, setTimeout, navigator: self.navigator });
  vm.runInContext(SW_SRC, ctx, { filename: 'sw.js' });
  assert.equal(typeof listeners.fetch, 'function', 'sw.js registered no fetch listener — the harness is not seeing the handler');
  return {
    listeners,
    named,
    navigations,
    caches,
    // A tab: the window client a navigation creates. Live until close().
    open: (id, url) => live.set(id, ORIGIN + url),
    close: (id) => live.delete(id),
    seed: (url, body, cacheName = CACHE) => storeOf(cacheName).set(key(url), basic(body)),
    read: async (url, cacheName = CACHE) => text(named.has(cacheName) ? await cacheObj(cacheName).match(url) : undefined),
    gens: () => [...named.keys()].filter((k) => k.startsWith(GEN_PREFIX)),
  };
}

// Dispatch one fetch event and return what respondWith() was handed, after
// every waitUntil() promise the handler started has settled.
export async function dispatch(worker, request, { clientId = '', resultingClientId = '' } = {}) {
  let responded = null;
  const waits = [];
  worker.listeners.fetch({
    request, clientId, resultingClientId,
    respondWith: (p) => { responded = p; },
    waitUntil: (p) => { waits.push(p); },
  });
  const res = responded ? await responded : null;
  // waitUntil can be called from inside the respondWith promise, so settle twice.
  await Promise.allSettled(waits);
  await Promise.allSettled(waits);
  return res;
}

export async function message(worker, data, sourceId) {
  const waits = [];
  worker.listeners.message({ data, source: { id: sourceId }, waitUntil: (p) => waits.push(p) });
  await Promise.allSettled(waits);
}

export async function install(worker) {
  let done = null;
  worker.listeners.install({ waitUntil: (p) => { done = p; } });
  await done;
}

export async function activate(worker) {
  let done = null;
  worker.listeners.activate({ waitUntil: (p) => { done = p; } });
  await done;
}

export const navigate = (url) => ({ url: ORIGIN + url, method: 'GET', mode: 'navigate' });
export const moduleReq = (url) => ({ url: ORIGIN + url, method: 'GET', mode: 'cors' });

// A network that fails the first `failures` calls, then serves `body`.
export function flaky(failures, body) {
  let calls = 0;
  const impl = async () => {
    calls += 1;
    if (calls <= failures) throw new TypeError('Failed to fetch');
    return basic(typeof body === 'function' ? body() : body);
  };
  impl.calls = () => calls;
  return impl;
}

// A network that serves `routes[pathname]`, or fails for anything missing —
// the shape of "deploy B is live, except this one file never arrives".
export function network(routes) {
  return async (req) => {
    const p = new URL(typeof req === 'string' ? req : req.url, ORIGIN).pathname;
    if (!(p in routes) || routes[p] === null) throw new TypeError('Failed to fetch');
    return basic(routes[p]);
  };
}
