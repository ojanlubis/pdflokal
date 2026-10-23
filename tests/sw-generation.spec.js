/*
 * THE SERVICE WORKER NEVER HANDS A PAGE TWO DEPLOYS — and offline still opens.
 * ============================================================================
 * Sentry JAVASCRIPT-18 (2026-10-02, Chrome Mobile 154): a fresh js/v2/app.js
 * beside a pre-#165 js/core/import.js with no `pdfLibLoadError`. This file
 * REPRODUCES that in Chromium and pins the v8 rule that closes it (sw.js,
 * GENERATIONS): a page load takes all of its modules from the network or all
 * of them from one complete generation, never a cached copy chosen per file.
 *
 * WHY THIS SPEC RUNS ITS OWN SERVER instead of the config's `npx serve`:
 *   1. A deploy has to happen MID-TEST, between two loads of one browser
 *      profile. The server below holds a generation switch: A is the tree on
 *      disk; B appends `export const __genB = 1` to import.js and makes app.js
 *      import it — an export change, exactly the shape of #165.
 *   2. The headers must be production's. Vercel sends every /js/ file with
 *      `public, max-age=0, must-revalidate` and an ETag (MEASURED 2026-10-02 with
 *      curl). With heuristic freshness instead, Chromium's HTTP cache can answer
 *      a module the worker "fetched from the network", and a test of freshness
 *      would be measuring the wrong cache.
 *
 * ⚠️ HOW THE PHONE'S LINK IS DROPPED, and why not the obvious way: destroying
 * the socket server-side does NOT fail a fetch — Chromium retries a reset
 * connection on its own, and the probe for this file watched six resets in a
 * row turn into one successful response. `context.route(...).abort()` fails the
 * request inside the browser, and in Chromium it sees the worker's own fetches
 * (`route.request().serviceWorker()` is non-null) — `page.route` does not,
 * which is why tests/boot-guard-skew.spec.js can only test the guard, not the
 * worker.
 *
 * Liveness is `window.v2`, which only app.js's top level assigns. `#btn-open`
 * is static HTML and stays visible on a page whose module graph never ran —
 * the first probe for this file reported a dead editor as alive that way.
 */
import { test, expect } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = {
  '.js': 'application/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};
const IMPORT = '/js/core/import.js';

function startServer() {
  const state = { gen: 'A', staleOnce: new Set(), beacons: [] };
  const body = (file, gen) => {
    let buf = fs.readFileSync(path.join(ROOT, file));
    if (gen === 'B' && file === IMPORT) buf = Buffer.concat([buf, Buffer.from('\nexport const __genB = 1;\n')]);
    if (gen === 'B' && file === '/js/v2/app.js') buf = Buffer.concat([Buffer.from("import { __genB } from '../core/import.js';\n"), buf]);
    return buf;
  };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'POST' && u.pathname === '/api/t') {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => {
        try { for (const e of JSON.parse(b).events) if (e.event === 'boot_failure') state.beacons.push(e.props); } catch { /* not ours to judge */ }
        res.writeHead(204); res.end();
      });
      return;
    }
    // The deploy's SHA, as api/rev.js answers it: sw.js ADOPTION reads it
    // before and after its pass and keeps nothing if it moved.
    if (u.pathname === '/api/rev') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ rev: state.gen === 'A' ? 'aaaaaaa' : 'bbbbbbb' }));
      return;
    }
    if (u.pathname.startsWith('/api/')) { res.writeHead(404); res.end(); return; }
    let file = u.pathname === '/' ? '/index.html' : u.pathname;
    if (!path.extname(file)) file += '.html';
    const abs = path.join(ROOT, file);
    if (!abs.startsWith(ROOT) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { res.writeHead(404); res.end(); return; }
    // An intermediary serving one stale file: the skew the worker cannot see.
    let gen = state.gen;
    if (state.staleOnce.has(file)) { state.staleOnce.delete(file); gen = 'A'; }
    const buf = body(file, gen);
    const etag = `"${crypto.createHash('md5').update(buf).digest('hex')}"`;
    const headers = {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      etag,
      'cache-control': u.pathname === '/sw.js' ? 'no-cache' : 'public, max-age=0, must-revalidate',
    };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return; }
    res.writeHead(200, headers); res.end(buf);
  });
  return new Promise((resolve) => server.listen(0, () => resolve({
    state, base: `http://localhost:${server.address().port}`, close: () => new Promise((r) => server.close(r)),
  })));
}

// Counts documents in this tab and records, per document, whether a worker
// controlled it — sessionStorage survives the reloads being counted.
const PROBE = `(() => {
  const n = Number(sessionStorage.getItem('__boots') || 0) + 1;
  sessionStorage.setItem('__boots', String(n));
  sessionStorage.setItem('__ctl' + n, String(!!(navigator.serviceWorker && navigator.serviceWorker.controller)));
})();`;
const boots = (page) => page.evaluate(() => Number(sessionStorage.getItem('__boots') || 0)).catch(() => -1);
const alive = (page) => page.evaluate(() => !!window.v2).catch(() => false);
// Which deploy's import.js THIS page linked: the module map already holds it,
// so a dynamic import returns the instance the page is running, not a refetch.
const genOf = (page) => page.evaluate(() => import('/js/core/import.js').then((m) => (m.__genB ? 'B' : 'A'))).catch(() => 'dead');

// Load once so the worker installs, then once more under its control, and wait
// until that controlled load's modules are on disk. On v8 that means a
// COMPLETE generation (at least `minComplete` of them); on a per-file worker,
// any cached import.js.
async function warm(page, base, minComplete = 1) {
  await page.goto(base + '/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect.poll(() => alive(page), { timeout: 20000 }).toBe(true);
  await expect.poll(() => page.evaluate(async (min) => {
    if (!navigator.serviceWorker.controller) return false;
    const names = await caches.keys();
    const gens = names.filter((k) => k.startsWith('pdflokal-gen-'));
    if (gens.length) {
      let n = 0;
      for (const k of gens) if (await caches.match('/__sw/complete', { cacheName: k })) n += 1;
      return n >= min;
    }
    return !!(await caches.match('/js/core/import.js'));
  }, minComplete), { timeout: 20000 }).toBe(true);
}

async function goOfflineAndLaunch(page, context, base) {
  await expect.poll(() => page.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    return !!(r && r.active);
  }).catch(() => false), { timeout: 20000 }).toBe(true);
  await context.setOffline(true);
  // A cold launch from the home-screen icon is a navigation with no network.
  await page.goto(base + '/?utm_source=pwa', { waitUntil: 'commit' }).catch(() => {});
  await page.waitForLoadState('load').catch(() => {});
}

// Drop the import.js fetch `n` times (Infinity = for the rest of the load).
async function dropImport(context, n) {
  let left = n;
  await context.route(`**${IMPORT}`, async (route) => {
    if (left > 0) { left -= 1; await route.abort('internetdisconnected'); return; }
    await route.continue();
  });
}

test.describe('sw.js generations', () => {
  test.setTimeout(120_000);
  let srv;
  test.beforeEach(async () => { srv = await startServer(); });
  test.afterEach(async () => { await srv.close(); });

  test('JAVASCRIPT-18, reproduced: a module dropped twice after a deploy is never replaced by the cached copy of the last one', async ({ page, context }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(PROBE);
    await warm(page, srv.base);

    // THE DEPLOY, then the phone's link drops import.js on both of the
    // worker's attempts. Everything else arrives fresh.
    srv.state.gen = 'B';
    errors.length = 0;
    await dropImport(context, 2);
    await page.goto(srv.base + '/', { waitUntil: 'commit' }).catch(() => {});

    await expect.poll(() => alive(page), { timeout: 30000 }).toBe(true);
    await page.waitForLoadState('load');

    // The editor runs deploy B, whole. On v7 the worker handed app.js (B) the
    // cached import.js (A): "does not provide an export named '__genB'".
    expect(errors.filter((m) => /export named|Importing binding|import not found/.test(m))).toEqual([]);
    expect(srv.state.beacons).toEqual([]);
    expect(await genOf(page)).toBe('B');
  });

  test('a heal reloads with no worker in control, revalidates, and keeps the offline copy', async ({ page, context }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(PROBE);
    await warm(page, srv.base);
    await page.evaluate(() => sessionStorage.clear());

    // A skew the WORKER cannot see: the server side hands this load a stale
    // import.js exactly once (an intermediary cache, a stale edge). The boot
    // guard is the only thing that can recover this, so it must heal.
    srv.state.gen = 'B';
    srv.state.staleOnce.add(IMPORT);
    errors.length = 0;
    await page.goto(srv.base + '/', { waitUntil: 'commit' }).catch(() => {});

    await expect.poll(() => boots(page), { timeout: 30000 }).toBe(2);
    await expect.poll(() => alive(page), { timeout: 30000 }).toBe(true);

    // The heal healed: one skew, one 'heal', no 'repeat', and the reloaded
    // document was NOT served by the worker it had just unregistered.
    expect(srv.state.beacons).toEqual([{ kind: 'missing-export', action: 'heal' }]);
    expect(errors).toHaveLength(1);
    expect(await page.evaluate(() => sessionStorage.getItem('__ctl2'))).toBe('false');
    expect(await genOf(page)).toBe('B');

    // And the user still has an offline app. Until v8 the heal emptied every
    // cache, so the next launch without a network opened a shell with no
    // modules behind it — no editor at all.
    errors.length = 0;
    await goOfflineAndLaunch(page, context, srv.base);
    await expect.poll(() => alive(page), { timeout: 20000 }).toBe(true);
    expect(errors).toEqual([]);
  });

  test('a broken online load never poisons the offline copy: offline opens the last COMPLETE generation, whole', async ({ page, context }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(PROBE);
    await warm(page, srv.base);
    await page.evaluate(() => sessionStorage.clear());

    // Deploy B, and import.js never arrives during this visit. Every sibling
    // does — and on a per-file cache every sibling is now B beside A's import.js.
    srv.state.gen = 'B';
    await dropImport(context, Infinity);
    await page.goto(srv.base + '/', { waitUntil: 'commit' }).catch(() => {});
    await page.waitForTimeout(8000);
    await context.unroute(`**${IMPORT}`);

    errors.length = 0;
    await goOfflineAndLaunch(page, context, srv.base);
    await expect.poll(() => alive(page), { timeout: 20000 }).toBe(true);
    expect(errors).toEqual([]);
    // Deploy A, whole: the B load never booted, so it never became servable.
    expect(await genOf(page)).toBe('A');
  });

  // A first visit is never seen by the worker (no controller yet), so before
  // ADOPTION an install made on that visit launched offline into the install-day
  // shell with every module refused: buttons on screen, no editor behind them.
  test('the FIRST visit alone is enough: offline, the installed app opens a live editor', async ({ page, context }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(srv.base + '/');
    await expect.poll(() => alive(page), { timeout: 20000 }).toBe(true);
    // No reload: the worker takes control of THIS document and adopts it.
    await expect.poll(() => page.evaluate(async () => {
      if (!navigator.serviceWorker.controller) return false;
      for (const k of await caches.keys()) {
        if (k.startsWith('pdflokal-gen-') && await caches.match('/__sw/complete', { cacheName: k })) return true;
      }
      return false;
    }), { timeout: 20000, message: 'the first visit never became a complete generation' }).toBe(true);

    errors.length = 0;
    await goOfflineAndLaunch(page, context, srv.base);
    await expect.poll(() => alive(page), { timeout: 20000 }).toBe(true);
    expect(errors).toEqual([]);
  });

  test('CONTROL: offline cold launch opens the newest complete generation', async ({ page, context }) => {
    // Green before and after v8: the falsifier for the two offline tests above,
    // and the guard on the pruning — the newest booted deploy is the one served.
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await warm(page, srv.base);
    srv.state.gen = 'B';
    await warm(page, srv.base, 2);
    expect(await genOf(page)).toBe('B');
    // Counting complete generations no longer proves B committed: the first
    // visit's ADOPTED generation is a complete A of its own, so "two complete"
    // can be reached before B's load posts 'booted'. Wait for the NEWEST complete
    // generation to be B's, which is the state the offline launch reads.
    await expect.poll(() => page.evaluate(async () => {
      let best = null;
      for (const k of await caches.keys()) {
        if (!k.startsWith('pdflokal-gen-')) continue;
        const mark = await caches.match('/__sw/complete', { cacheName: k });
        if (!mark) continue;
        const at = (await mark.json()).at || 0;
        if (!best || at > best.at) best = { k, at };
      }
      const imp = best && await caches.match('/js/core/import.js', { cacheName: best.k });
      return imp ? (await imp.text()).includes('__genB') : false;
    }), { timeout: 20000, message: "deploy B's load never became the newest complete generation" }).toBe(true);

    errors.length = 0;
    const fromWorker = [];
    page.on('response', (r) => { if (/\/js\/(core|v2)\//.test(r.url())) fromWorker.push(r.fromServiceWorker()); });
    await goOfflineAndLaunch(page, context, srv.base);
    await expect.poll(() => alive(page), { timeout: 20000 }).toBe(true);
    expect(errors).toEqual([]);
    expect(await genOf(page)).toBe('B');
    expect(fromWorker.length).toBeGreaterThan(10);
    expect(fromWorker.every(Boolean)).toBe(true);
  });
});
