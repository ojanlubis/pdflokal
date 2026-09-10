/*
 * MIXPANEL SESSION REPLAY — WHAT ACTUALLY GOES OUT THE WIRE.
 * ============================================================================
 * The one-month UX study (seat decisions.md 2026-09-10) points a third-party
 * session recorder at an editor whose entire product promise is "filemu nggak
 * pernah ninggalin perangkatmu". Config that has not been WATCHED is not
 * verified, so this spec drives a real edit and reads every byte the recorder
 * tries to send.
 *
 * ⚠️ NOTHING REACHES MIXPANEL FROM A TEST RUN. Every api*.mixpanel.com request
 * is fulfilled locally with Mixpanel's own success shape (`{status:1}`), which
 * is deliberately not `abort()`: an aborted send makes the SDK retry, and a
 * retry storm would make the timing here meaningless. The CDN bundle IS fetched
 * for real, because a stubbed recorder would prove nothing about the recorder.
 *
 * ⚠️ THE INSTRUMENT IS PROVEN TO FIRE BEFORE ANY ABSENCE IS BELIEVED. An
 * assertion that a filename is missing from an EMPTY set of requests passes for
 * free and says nothing (`app/CLAUDE.md`, verification law). So the first
 * expectation is that a /record payload arrived at all, and the leak checks are
 * only meaningful after it.
 *
 * ⚠️ THE FIRST TWO TESTS RUN WITH NO CSP AT ALL. `npx serve` sends no headers,
 * so the policy in vercel.json is unenforced during them. THE THIRD TEST IS
 * THERE FOR EXACTLY THAT REASON: it runs the same rig tests/csp-live-policy.spec.js
 * uses (scripts/ocr-demo.mjs, which serves the real policy from a real HTTP
 * response, the mechanism already proven to ENFORCE), because a CSP that
 * refuses cdn.mxpnl.com is a dead SDK for the whole month and looks identical
 * to a working local run.
 */
import { test, expect } from '@playwright/test';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';
import { armGanti, tapLine } from './helpers/lines.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');

// Distinctive enough that a substring hit cannot be a coincidence, and shaped
// like the documents this product actually opens.
// NOT 'slip-gaji': the landing's own Template row links to
// template.pdflokal.id/slip-gaji, so that substring is IN THE PAGE and a test
// asserting its absence fails on pdflokal's own markup, not on a leak.
const SECRET_FILENAME = 'RAHASIA-BUDISANTOSO-NIK3174-2026';
const SECRET_TYPED = 'NPWP091234567890ZZ';
// Ganti Teks is a SECOND path and not a variant of the first: it pulls the
// document's own printed line into a contenteditable, and what it leaves behind
// after Enter is an ordinary DOM text node in .pv-overlay, not an input value.
// A mask that covers a field would miss it entirely.
const SECRET_REPLACED = 'GAJIPOKOK88776655GANTI';

// WITNESSES FOR THE UNMASK ALLOWLIST. Each string must occur EXACTLY ONCE in
// index.html and as a TEXT NODE — not in an attribute, not in a CSS comment
// inside <style>, not in the head's HTML comment. rrweb serialises stylesheets
// and HTML comments verbatim, so a token that also appears in either would be
// found in the payload whether or not anything was unmasked, and the assertion
// would pass for free. Verified with `grep -n` before being chosen.
const CHROME_WITNESSES = [
  'Tambah File',                  // #file-menu, inside body > header
  'Buka Baru',                    // #file-menu, inside body > header
  'Selesai, filemu udah jadi!',   // #support-card
];

function decodeBody(buf) {
  if (!buf) return '';
  for (const fn of [zlib.gunzipSync, zlib.inflateSync, zlib.inflateRawSync, zlib.brotliDecompressSync]) {
    try { return fn(buf).toString('utf8'); } catch { /* not this encoding */ }
  }
  return buf.toString('utf8');
}

test.describe('mixpanel session replay — privacy of the wire', () => {
  test('a real edit sends no filename, no typed text and no document pixels', async ({ page }) => {
    test.setTimeout(120_000);

    // A copy under a name that would be a real leak if it ever showed up.
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pdflokal-mp-')), `${SECRET_FILENAME}.pdf`);
    fs.copyFileSync(SOURCE, tmp);

    /** @type {{url:string, body:string}[]} */
    const sent = [];
    await page.route('**://*.mixpanel.com/**', async (route) => {
      const req = route.request();
      sent.push({ url: req.url(), body: decodeBody(req.postDataBuffer()) });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: '{"status":1}',
      });
    });

    // The head snippet refuses to init off the production hostname; this is the
    // seam it leaves open, and it is the only way to watch the recorder locally.
    await page.addInitScript(() => { window.__PDFLOKAL_MP_FORCE = true; });

    await page.goto('/');
    await page.setInputFiles('#file-input', tmp);
    await expectFirstPage(page);

    // Place text and type the secret, the way a user editing a payslip would.
    await page.keyboard.press('t');
    await page.click('.pv-page >> nth=0', { position: { x: 200, y: 200 } });
    await page.keyboard.type(SECRET_TYPED);
    await page.keyboard.press('Enter');
    await expect(page.locator('.pv-anno-text').filter({ hasText: SECRET_TYPED })).toHaveCount(1);

    // GANTI TEKS, the second and nastier path: tap a printed line, which
    // pre-seeds the DOCUMENT'S OWN text into a contenteditable, replace it, and
    // commit. After Enter the replacement is a plain text node in .pv-overlay —
    // no longer anything a field-shaped rule would recognise.
    await armGanti(page);
    await tapLine(page, { str: 'Test Page 1' });
    await expect(page.locator('.v2-text-edit')).toHaveText('Test Page 1');
    await page.keyboard.type(SECRET_REPLACED);
    await page.keyboard.press('Enter');
    await expect(page.locator('.pv-anno-text').filter({ hasText: SECRET_REPLACED })).toHaveCount(1);

    // OPEN THE DOWNLOAD SHEET, AND THIS IS NOT DECORATION. #ds-meta is where
    // the filename is PAINTED AS ORDINARY TEXT (download-sheet.js render():
    // `${getBaseName()}.pdf · N hal`), and it is empty until the sheet opens.
    // Without this click the filename assertion below never had a filename to
    // find and passed for free — the exact vacuity this file's header warns
    // about, sitting inside the file that warns about it.
    await page.click('#btn-download');
    await expect(
      page.locator('#ds-meta'),
      'the sheet never painted the filename, so the leak check below is vacuous',
    ).toContainText(SECRET_FILENAME);

    // Force a flush rather than waiting out the recorder's own batch interval.
    await page.waitForTimeout(3000);
    await page.evaluate(() => {
      try { window.mixpanel?.stop_session_recording?.(); } catch { /* stub or unloaded */ }
    });
    await expect.poll(
      () => sent.filter((r) => /\/record/.test(r.url)).length,
      {
        message: 'the recorder never sent a /record payload — every absence below would pass for free',
        timeout: 45_000,
      },
    ).toBeGreaterThan(0);

    const all = sent.map((r) => r.body).join('\n');

    // 1. The filename. THIS ONE HAS ALREADY FIRED IN ANGER (2026-09-10, the
    //    first run of this spec): with record_mask_all_inputs:true and no block
    //    selector for it, rrweb emitted an incremental input event carrying
    //    `C:\\fakepath\\<the real filename>.pdf` the instant a document was
    //    opened. Masking inputs does not cover a file input's value. The fix is
    //    `input[type="file"]` in record_block_selector; this assertion is what
    //    stops it coming back.
    expect(all).not.toContain(SECRET_FILENAME);
    expect(all).not.toContain('BUDISANTOSO');
    expect(all, 'the file input is leaking its value again').not.toContain('fakepath');

    // 2. What the user typed. record_mask_all_text is what stops this, and the
    //    unmask allowlist must never reach either surface: SECRET_TYPED is a
    //    Teks annotation, SECRET_REPLACED came out of Ganti Teks and is a plain
    //    text node by the time it is committed.
    expect(all).not.toContain(SECRET_TYPED);
    expect(all).not.toContain('NPWP');
    expect(all, 'a committed Ganti Teks replacement is in the recording').not.toContain(SECRET_REPLACED);
    expect(all).not.toContain('GAJIPOKOK');

    // 3. The document's pixels. Every rendered page is an img whose src is a
    //    `data:image/png` URL (js/core/import.js rasterises with
    //    toDataURL('image/png')), so a recorder that serialised img attributes
    //    would ship the whole document. record_block_selector's `img` is what
    //    stops it.
    //    ⚠️ THE TOKEN IS `data:image/png`, NOT `data:image`. The landing's own
    //    stylesheet uses `mask-image: url("data:image/svg+xml,...")` for the
    //    "Gratis!" stamp and rrweb serialises stylesheets, so the broader token
    //    fails on pdflokal's own CSS and would get "fixed" by deleting the check.
    expect(all).not.toContain('data:image/png');
    expect(all).not.toContain('data:image/jpeg');

    // 4. AND THE OTHER DIRECTION, which is the point of the allowlist: PDFLokal's
    //    OWN CHROME MUST BE READABLE. Ruled 2026-09-10 (later) after Fauzan
    //    watched the first real replays and found every label asterisked, so the
    //    recording said where someone tapped but never what they were looking
    //    at. These three assertions are as load-bearing as the four above: a
    //    future session that "fixes" a leak by widening the mask back over the
    //    chrome breaks the study, and this is what tells them.
    for (const witness of CHROME_WITNESSES) {
      expect(
        all,
        `"${witness}" is masked — the unmask allowlist is not reaching pdflokal's own chrome`,
      ).toContain(witness);
    }

    // 5. THE STRUCTURAL CHECK, and it does not depend on which batch we caught.
    //    It re-runs the recorder's own decision (mixpanel-recorder `Yw()`:
    //    while maskAll is true a node is masked unless closest(unmask) hits) on
    //    the live DOM, so an over-broad allowlist entry is caught even when the
    //    captured payload happens not to contain that node.
    //    ⚠️ closest() walks ANCESTORS, so unmasking is inherited by a whole
    //    subtree and record_mask_text_selector cannot claw any of it back.
    const reach = await page.evaluate(() => {
      const sel = window.mixpanel.get_config('record_unmask_text_selector');
      const asOne = (Array.isArray(sel) ? sel : [sel]).join(',');
      const probe = (q) => {
        const el = document.querySelector(q);
        return el ? { found: true, unmasked: !!el.closest(asOne) } : { found: false, unmasked: false };
      };
      return {
        selector: asOne,
        mustStayMasked: {
          '#ds-meta': probe('#ds-meta'),                    // the filename, as text
          '.pv-anno-text': probe('.pv-anno-text'),          // typed + Ganti Teks output
          '.pv-overlay': probe('.pv-overlay'),              // everything drawn on a page
          '#v2-stage': probe('#v2-stage'),                  // the document itself
          '#ds-all-sub': probe('#ds-all-sub'),              // a page count is not static chrome
          '#pm-pick-ok': probe('#pm-pick-ok'),              // nor is a selection count
          '#v2-pill': probe('#v2-pill'),                    // nor the page indicator
          '#ds-cta-main': probe('#ds-cta-main'),            // nor the CTA's size/page text
        },
        mustBeReadable: {
          '#toolbar': probe('#toolbar'),
          '#file-menu': probe('#file-menu'),
          '#empty': probe('#empty'),
          '#dl-sheet .ds-label': probe('#dl-sheet .ds-label'),
        },
      };
    });
    expect(reach.selector, 'no unmask allowlist is configured at all').toContain('#empty');
    for (const [q, r] of Object.entries(reach.mustStayMasked)) {
      expect(r.found, `${q} is not in the DOM, so its masking was never tested`).toBe(true);
      expect(r.unmasked, `${q} is reachable from the unmask allowlist — an entry is too broad`).toBe(false);
    }
    for (const [q, r] of Object.entries(reach.mustBeReadable)) {
      expect(r.found, `${q} is not in the DOM`).toBe(true);
      expect(r.unmasked, `${q} is not reachable from the unmask allowlist`).toBe(true);
    }

    // 6. And the config really is the one we think it is.
    const cfg = await page.evaluate(() => {
      try {
        return {
          replay: window.mixpanel?.get_config?.('record_sessions_percent'),
          maskText: window.mixpanel?.get_config?.('record_mask_all_text'),
          maskInputs: window.mixpanel?.get_config?.('record_mask_all_inputs'),
          canvas: window.mixpanel?.get_config?.('record_canvas'),
          block: window.mixpanel?.get_config?.('record_block_selector'),
          unmask: window.mixpanel?.get_config?.('record_unmask_text_selector'),
          unmaskInputs: window.mixpanel?.get_config?.('record_unmask_input_selector'),
          persistence: window.mixpanel?.get_config?.('disable_persistence'),
          crossSub: window.mixpanel?.get_config?.('cross_subdomain_cookie'),
          autocapture: window.mixpanel?.get_config?.('autocapture'),
          ip: window.mixpanel?.get_config?.('ip'),
        };
      } catch { return null; }
    });
    expect(cfg, 'the SDK never finished loading, so nothing above was measured').not.toBeNull();
    expect(cfg.replay).toBe(100);
    // DENY-BY-DEFAULT MUST SURVIVE THE ALLOWLIST. The whole posture is "mask
    // everything, then name the exceptions"; flipping either of these to false
    // and enumerating what to hide is the allow-by-default shape that let a real
    // filename out of a file input on this very build.
    expect(cfg.maskText, 'masking is no longer deny-by-default').toBe(true);
    expect(cfg.maskInputs).toBe(true);
    // Inputs get NO allowlist. Every text field on this product holds something
    // the visitor put there, so there is nothing to carve out.
    expect(cfg.unmaskInputs, 'an input was unmasked — no input on this product is safe to read').toBeUndefined();
    // The allowlist reaches the chrome and nothing wider. `body`, `html`, `main`
    // or `*` would unmask the document surface along with everything else, and
    // the closest() rule means no nested selector could take it back.
    const unmaskList = Array.isArray(cfg.unmask) ? cfg.unmask : [cfg.unmask];
    for (const entry of unmaskList) {
      expect(
        String(entry).trim(),
        'an unmask entry is broad enough to swallow the document surface',
      ).not.toMatch(/^(\*|body|html|main|#v2-scroll|#v2-stage|#v2-sizer)$/);
    }
    expect(cfg.canvas).toBe(false);
    expect(cfg.block).toContain('img');
    expect(cfg.block).toContain('input[type="file"]');
    expect(cfg.block).toContain('#toast');
    expect(cfg.persistence).toBe(true);
    expect(cfg.crossSub).toBe(false);
    expect(cfg.autocapture).toBe(false);
    expect(cfg.ip, 'geolocation is back on, and privasi.html claims no location data').toBe(false);

    // 8. No Mixpanel cookie on the document, in either direction. The default
    //    is a cross-subdomain cookie on .pdflokal.id, which would reach
    //    template.pdflokal.id, a different product in a different repo.
    const cookies = await page.evaluate(() => document.cookie);
    expect(cookies).not.toContain('mp_');
  });

  test('the recorder does not run on a non-production hostname', async ({ page }) => {
    /** @type {string[]} */
    const hits = [];
    await page.route('**://*.mxpnl.com/**', async (route) => { hits.push(route.request().url()); await route.abort(); });
    await page.route('**://*.mixpanel.com/**', async (route) => { hits.push(route.request().url()); await route.abort(); });

    await page.goto('/');
    await page.setInputFiles('#file-input', SOURCE);
    await expectFirstPage(page);
    await page.waitForTimeout(3000);

    expect(hits, `localhost must never spend the free tier's replay quota: ${hits.join(', ')}`).toEqual([]);
    expect(await page.evaluate(() => typeof window.mixpanel)).toBe('undefined');
  });
});

/*
 * THE POLICY, ENFORCED. A separate describe because it needs its own server:
 * `npx serve` (what the rest of the suite runs against) sends no headers at all,
 * and a test that does not serve the policy cannot say anything about the policy.
 * Port 5058 so it never collides with csp-live-policy.spec.js's 5057.
 */
const CSP_PORT = 5058;
const CSP_ORIGIN = `http://localhost:${CSP_PORT}`;
const ROOT = path.join(__dirname, '..');
let rig = null;

test.describe('mixpanel under the REAL Content-Security-Policy', () => {
  test.beforeAll(async () => {
    rig = spawn('node', [path.join(ROOT, 'scripts/ocr-demo.mjs')], {
      cwd: ROOT, stdio: 'ignore', detached: true, env: { ...process.env, OCR_DEMO_PORT: String(CSP_PORT) },
    });
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => { setTimeout(r, 250); });
      try { if ((await fetch(`${CSP_ORIGIN}/`)).ok) return; } catch { /* not up yet */ }
    }
    throw new Error('the CSP rig never came up');
  });

  // Process GROUP, not the wrapper: killing the wrapper alone orphans the
  // server and it holds the port for the next sweep.
  test.afterAll(() => {
    if (rig) { try { process.kill(-rig.pid, 'SIGTERM'); } catch { /* already gone */ } }
  });

  test('the live policy admits the SDK and its ingest host', async ({ page, context }) => {
    test.setTimeout(120_000);

    // The hosts are READ FROM vercel.json, never retyped. A copy here would be a
    // drift pair, and docs/security.md already drifted from that file once.
    const policy = (() => {
      const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
      for (const entry of cfg.headers || []) {
        for (const h of entry.headers || []) {
          if (String(h.key).toLowerCase() === 'content-security-policy') return h.value;
        }
      }
      throw new Error('no Content-Security-Policy in vercel.json');
    })();

    // VACUITY GUARD. If the rig were serving no header, every check below would
    // pass under no policy at all, which is the precise trap this file escapes.
    const seenHeaders = [];
    page.on('response', (r) => {
      const h = r.headers()['content-security-policy'];
      if (h) seenHeaders.push(h);
    });

    // CSP violations happen where page.on('console') cannot see them; the repo's
    // own instrument law says use CDP's Log domain.
    const violations = [];
    const client = await context.newCDPSession(page);
    await client.send('Log.enable');
    client.on('Log.entryAdded', ({ entry }) => {
      const text = entry.text || '';
      if (/Content Security Policy/i.test(text) && /mxpnl|mixpanel/i.test(text)) violations.push(text);
    });

    // A request that CSP refuses is killed in the renderer and NEVER reaches the
    // network layer, so it never reaches page.route. Arriving here IS the proof.
    const reached = [];
    await page.route('**://*.mixpanel.com/**', async (route) => {
      reached.push(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: '{"status":1}',
      });
    });

    await page.addInitScript(() => { window.__PDFLOKAL_MP_FORCE = true; });
    await page.goto(`${CSP_ORIGIN}/`);
    expect(seenHeaders.length, 'no response carried a CSP header — the rig is not serving it').toBeGreaterThan(0);
    expect(seenHeaders[0]).toBe(policy);

    // script-src: if cdn.mxpnl.com were refused, `mixpanel` would stay the
    // loader snippet's ARRAY stub forever and get_config would not exist.
    await expect
      .poll(() => page.evaluate(() => typeof window.mixpanel?.get_config), {
        message: 'the SDK bundle never executed — script-src is probably refusing cdn.mxpnl.com',
        timeout: 30_000,
      })
      .toBe('function');

    // connect-src: something actually left for Mixpanel.
    await expect
      .poll(() => reached.length, {
        message: 'nothing ever reached the Mixpanel host — connect-src is probably refusing it',
        timeout: 45_000,
      })
      .toBeGreaterThan(0);

    // And the host it really used is one the policy actually names. Derived
    // from the observed URL against the file, not from either being retyped.
    const host = new URL(reached[0]).origin;
    expect(policy, `the SDK is talking to ${host}, which connect-src does not list`).toContain(host);

    expect(violations, `CSP refused Mixpanel: ${violations.join(' | ')}`).toEqual([]);
  });
});
