/*
 * THE LIVE CSP, ENFORCED IN A REAL BROWSER, ON THE REAL PAGE.
 * ============================================================================
 * On 2026-07-30 two directives were added so OCR can run: `'wasm-unsafe-eval'`
 * in script-src, and `blob:` in worker-src. Ruled by Fauzan, security
 * assessment by the PM, recorded in the seat's decisions.md.
 *
 * ⚠️ WHY THESE TESTS INJECT THE HEADER THEMSELVES. `npx serve` — what the whole
 * Playwright suite runs against — sends NO headers at all. Every existing test
 * therefore runs with NO Content-Security-Policy, which is exactly how this
 * class of defect hid: the OCR wall was invisible locally and absolute in
 * production. A test that does not serve the policy cannot say anything about
 * the policy.
 *
 * ⚠️ AND THE POLICY IS READ FROM vercel.json, NEVER RETYPED. A copy here would
 * be a drift pair, and docs/security.md already drifted exactly that way once.
 *
 * TWO THINGS ARE PINNED, and they are the conditions the CSP change shipped
 * under:
 *
 *   1. `'wasm-unsafe-eval'` MUST NOT GRANT eval(). The directive names are
 *      similar enough to be mistaken for one another, so this is demonstrated
 *      in a real page under the real header rather than argued from the spec.
 *
 *   2. THE SERVICE WORKER MUST STILL REGISTER. `worker-src 'self' blob:` is
 *      correct; `worker-src blob:` also makes OCR work and silently kills the
 *      service worker, and with it offline mode — a shipped, announced feature
 *      ("TETAP JALAN when the connection drops"). Nothing throws. The page
 *      looks fine. A feature stops existing. That is the failure this test is
 *      here to make loud.
 */
import { test, expect } from '@playwright/test';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function livePolicy() {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  for (const entry of cfg.headers || []) {
    for (const h of entry.headers || []) {
      if (String(h.key).toLowerCase() === 'content-security-policy') return h.value;
    }
  }
  throw new Error('no Content-Security-Policy in vercel.json');
}

/*
 * ⚠️ A REAL SERVER, NOT ROUTE INTERCEPTION, AND THE REASON MATTERS.
 * The first version stamped the CSP onto responses via page.route(...fulfill).
 * The header arrived — the guard test below confirmed it — and Chromium DID NOT
 * ENFORCE IT: eval() ran happily under a policy with no 'unsafe-eval'. The same
 * page under scripts/ocr-demo.mjs, which serves the header from a real HTTP
 * response, blocks eval with an EvalError.
 *
 * So a header being present is not the same as a header being enforced, and an
 * intercepted response is not a served one. This spec runs the demo rig, which
 * is the mechanism already proven to enforce.
 */
const PORT = 5057;
const ORIGIN = `http://localhost:${PORT}`;
let rig = null;

test.beforeAll(async () => {
  rig = spawn('node', [path.join(ROOT, 'scripts/ocr-demo.mjs')], {
    cwd: ROOT, stdio: 'ignore', detached: true, env: { ...process.env, OCR_DEMO_PORT: String(PORT) },
  });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { if ((await fetch(ORIGIN + '/')).ok) return; } catch { /* not up yet */ }
  }
  throw new Error('the CSP rig never came up');
});

test.afterAll(() => {
  // Process GROUP: killing the wrapper alone orphans the server (learned the
  // hard way when a sweep left two of them holding a port and starved the gate).
  if (rig) { try { process.kill(-rig.pid, 'SIGTERM'); } catch { /* gone */ } }
});

test.describe('the live CSP, enforced', () => {
  test('the header we serve really does reach the page', async ({ page }) => {
    // VACUITY GUARD, and it is not ceremony: if the route interception silently
    // failed, both tests below would run with NO policy and pass for entirely
    // the wrong reason — the precise trap this file exists to escape.
    const csp = livePolicy();
    const seen = [];
    page.on('response', (r) => {
      const h = r.headers()['content-security-policy'];
      if (h) seen.push(h);
    });
    await page.goto(ORIGIN + '/');
    expect(seen.length, 'no response carried a CSP header - the rig is not serving it').toBeGreaterThan(0);
    expect(seen[0]).toBe(csp);
    expect(csp, 'the live policy no longer grants wasm').toContain("'wasm-unsafe-eval'");
  });

  test("'wasm-unsafe-eval' does NOT grant eval()", async ({ page }) => {
    // ⚠️ THE PROBE MUST BE THE PAGE'S OWN CODE. Two earlier versions got this
    // wrong in the same direction, both reporting eval as ALLOWED under a policy
    // that has no 'unsafe-eval':
    //   - page.evaluate() runs over CDP and bypasses CSP outright
    //   - a <script> element injected FROM page.evaluate() also escaped
    //     enforcement, even served from a real HTTP response
    // The page's own module script does not escape. lab-ocr.html ships a
    // "Cek eval()" button that runs eval('1+1') from module code, which is
    // exactly the surface a real attacker-injected string would use, and it is
    // the same button Fauzan presses in the demo. Click it.
    await page.goto(`${ORIGIN}/lab-ocr.html`);
    await page.click('#check-eval');
    await expect(page.locator('#eval-result')).not.toHaveText('', { timeout: 5000 });
    const verdict = await page.locator('#eval-result').innerText();

    expect(
      verdict,
      `the page reported: "${verdict}". eval() ran under the live policy. 'wasm-unsafe-eval' is `
      + 'meant to permit WebAssembly compilation ONLY; if eval works, full unsafe-eval has been '
      + 'granted somewhere and every injection surface in the product just got wider.',
    ).toMatch(/DIBLOKIR/);
  });

  test('a real OCR run raises NO CSP violation — including inside the worker', async ({ page, context }) => {
    // FOUND IN PRODUCTION 2026-08-23, minutes after rung S2 shipped, by reading
    // the live console instead of trusting a green suite. Every recognition
    // emitted two errors:
    //
    //   Connecting to 'data:application/octet-stream;base64,AGFzbQ…' violates
    //   the following Content Security Policy directive: "connect-src 'self' …"
    //
    // tesseract's core is an emscripten SINGLE_FILE build: it carries the WASM
    // binary inline as base64 and fetches it back as a data: URI. connect-src
    // did not allow data:, the fetch was refused, and THE LIBRARY FELL BACK AND
    // OCR WORKED — right text, right boxes, green everything. That is why it
    // reached production: a fallback that succeeds is indistinguishable from a
    // path that was never blocked.
    //
    // ⚠️⚠️ WHY THIS TEST USES CDP AND NOT page.on('console'), WHICH IS THE
    // WHOLE REASON THE DEFECT SURVIVED A DAY OF LOOKING FOR IT.
    // The violation happens INSIDE THE TESSERACT WORKER. Playwright's
    // page-level console event does not carry worker messages, and neither
    // does a document-level `securitypolicyviolation` listener. Both report
    // ZERO, on a page where Chromium is logging two errors — and a first
    // attempt at this test was written, passed, and was DELETED for passing
    // that way. The behaviour was never the thing that failed to reproduce
    // locally; the INSTRUMENT was.
    //
    // CDP's Log domain sees them, tagged `source: 'worker'`. Chromium-only,
    // which this suite already is.
    //
    // 📌 THE GENERAL LESSON, worth more than this fix: every worker this
    // product runs — the Tesseract worker, pdf.js's worker, the service
    // worker — is invisible to page.on('console'). Any future "no errors"
    // claim about worker code needs this instrument, not that one.
    const violations = [];
    const client = await context.newCDPSession(page);
    await client.send('Log.enable');
    client.on('Log.entryAdded', ({ entry }) => {
      if (/Content Security Policy/i.test(entry.text || '')) {
        violations.push(`${entry.source}: ${String(entry.text).slice(0, 120)}`);
      }
    });

    await page.goto(`${ORIGIN}/lab-ocr.html`);
    const text = await page.evaluate(async () => {
      const m = await import('/js/v2/ocr-engine.js');
      const c = document.createElement('canvas');
      c.width = 800; c.height = 180;
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, 800, 180);
      g.fillStyle = '#000'; g.font = '44px serif';
      g.fillText('Surat Keterangan', 30, 120);
      const data = await m.recognizeCanvas(c);
      return (data.text || '').trim();
    });
    // Log entries are delivered out of band; give them a beat to land, or an
    // empty `violations` would mean "too early", not "none".
    await page.waitForTimeout(500);

    // POSITIVE CONTROL FIRST. "No violations" is free if the engine never ran.
    expect(text, 'the engine recognised nothing, so the violation count proves nothing')
      .toContain('Surat');

    expect(
      violations,
      "the live policy refused something during a real OCR run. tesseract's core inlines its WASM "
      + 'and fetches it as a data: URI, so connect-src must allow data:. Without it OCR still works '
      + 'via a fallback, which is exactly how this reached production unnoticed.',
    ).toEqual([]);
  });

  test('the service worker still registers, so offline mode survives', async ({ page }) => {
    await page.goto(ORIGIN + '/');

    const result = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return 'no-sw-support';
      try {
        const reg = await navigator.serviceWorker.register('/sw.js');
        return reg ? 'registered' : 'no-registration';
      } catch (err) {
        return 'FAILED:' + String(err.message).slice(0, 90);
      }
    });

    expect(
      result,
      'the service worker did NOT register under the live CSP. Check that worker-src still contains '
      + "'self' — writing \"worker-src blob:\" instead of \"worker-src 'self' blob:\" still makes OCR "
      + 'work while silently killing offline mode, with nothing thrown and the page looking normal.',
    ).toBe('registered');
  });
});
