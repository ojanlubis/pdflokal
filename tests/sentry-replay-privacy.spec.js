/*
 * SENTRY SESSION REPLAY — WHAT ACTUALLY GOES OUT THE WIRE.
 * ============================================================================
 * ⚠️ THIS PRODUCT HAS BEEN RECORDING SESSIONS SINCE LONG BEFORE MIXPANEL.
 * `js/sentry-init.js` runs `replayIntegration` at `replaysSessionSampleRate:
 * 0.10` and `replaysOnErrorSampleRate: 1.0` — live, in production, on the real
 * editor. Its block list was written by reading the DOM and reasoning about it,
 * and **nobody had ever looked at a payload.** This spec looks.
 *
 * IT EXISTS BECAUSE THE SIBLING RECORDER LEAKED. On 2026-09-10 the first run of
 * tests/mixpanel-replay-privacy.spec.js caught Mixpanel's rrweb sending the real
 * filename out of a `<input type="file">` WITH input masking turned on. Sentry's
 * replay is rrweb too. A guard placed where a bug was seen protects that place,
 * not the class (`app/CLAUDE.md`), so the class gets checked on both recorders.
 * Sentry's build came out clean; this pins it that way.
 *
 * ⚠️ NOTHING REACHES SENTRY FROM A TEST RUN. Sentry posts through the
 * same-origin `/api/sentry-tunnel`, which is intercepted and answered locally.
 *
 * ⚠️ TWO REWRITES, AND BOTH ARE ASSERTED RATHER THAN HOPED FOR. `sentry-init.js`
 * disables itself off pdflokal.id, and samples one session in ten — so a naive
 * run records NOTHING and every "the filename is absent" check below passes for
 * free. (That happened: the first probe returned a clean bill of health from a
 * 563-byte envelope containing no recording at all.) The served file is
 * rewritten to `enabled: true` and 100%, and `expect` confirms BOTH edits
 * landed. If the source strings ever drift, this test fails loudly instead of
 * silently measuring nothing.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');
const SECRET_FILENAME = 'RAHASIA-BUDISANTOSO-NIK3174-2026';
const SECRET_TYPED = 'NPWP091234567890ZZ';

// A Sentry envelope is newline-delimited: headers as JSON lines, then the
// `replay_recording` item as a raw zlib stream. The rrweb events only become
// greppable after that stream is inflated — grepping the envelope itself finds
// nothing no matter what is inside, which is its own way of passing for free.
function inflateRecordings(buffers) {
  const out = [];
  for (const buf of buffers) {
    const marker = Buffer.from('{"segment_id":');
    const at = buf.indexOf(marker);
    if (at === -1) continue;
    const nl = buf.indexOf(0x0a, at);
    if (nl === -1) continue;
    const body = buf.subarray(nl + 1);
    for (const wbits of [zlib.constants.Z_MAX_WINDOWBITS, -zlib.constants.Z_MAX_WINDOWBITS, 16 + zlib.constants.Z_MAX_WINDOWBITS]) {
      try { out.push(zlib.inflateSync(body, { windowBits: wbits }).toString('utf8')); break; } catch { /* next encoding */ }
    }
  }
  return out;
}

test('sentry replay sends no filename, no typed text and no document pixels', async ({ page }) => {
  test.setTimeout(120_000);

  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pdflokal-sn-')), `${SECRET_FILENAME}.pdf`);
  fs.copyFileSync(SOURCE, tmp);

  /** @type {Buffer[]} */
  const envelopes = [];

  await page.route('**/js/sentry-init.js', async (route) => {
    const res = await route.fetch();
    let body = await res.text();
    body = body.replace(
      "enabled: location.hostname === 'pdflokal.id' || location.hostname === 'www.pdflokal.id',",
      'enabled: true,',
    );
    body = body.replace('replaysSessionSampleRate: 0.10,', 'replaysSessionSampleRate: 1.0,');
    expect(body, 'the hostname gate in sentry-init.js moved; this test is measuring nothing').toContain('enabled: true,');
    expect(body, 'the replay sample rate line in sentry-init.js moved; 9 runs in 10 would record nothing').toContain('replaysSessionSampleRate: 1.0,');
    await route.fulfill({ status: 200, contentType: 'text/javascript', body });
  });

  await page.route('**/api/sentry-tunnel*', async (route) => {
    const buf = route.request().postDataBuffer();
    if (buf) envelopes.push(buf);
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.goto('/');
  await page.setInputFiles('#file-input', tmp);
  await expectFirstPage(page);

  await page.keyboard.press('t');
  await page.click('.pv-page >> nth=0', { position: { x: 200, y: 200 } });
  await page.keyboard.type(SECRET_TYPED);
  await page.keyboard.press('Enter');
  await expect(page.locator('.pv-anno-text')).toHaveText(SECRET_TYPED);

  await page.evaluate(() => { try { window.Sentry?.flush?.(3000); } catch { /* SDK blocked */ } });

  /** @type {string[]} */
  let recordings = [];
  await expect.poll(
    () => { recordings = inflateRecordings(envelopes); return recordings.join('').length; },
    { message: 'no replay recording was captured, so every absence below would pass for free', timeout: 45_000 },
  ).toBeGreaterThan(1000);

  const all = recordings.join('\n');

  // THE INSTRUMENT IS ALIVE AND DOING ITS JOB — checked before any absence is
  // read as safety. `rr_width` is rrweb's blocked-element placeholder and
  // asterisks are its masked text, so both features are demonstrably ON in the
  // bytes we are about to search.
  expect(all, 'no blocked-element placeholder in the payload: blocking may not be running at all').toContain('rr_width');
  expect(all, 'no masked text in the payload: masking may not be running at all').toContain('****');

  expect(all).not.toContain(SECRET_FILENAME);
  expect(all).not.toContain('BUDISANTOSO');
  expect(all, 'a file input is leaking its value, the way Mixpanel\'s rrweb did').not.toContain('fakepath');
  expect(all).not.toContain(SECRET_TYPED);
  expect(all).not.toContain('NPWP');
  // Page rasters are `data:image/png` (js/core/import.js). `blockAllMedia` plus
  // the explicit `.pv-bg` block are what keep them out.
  expect(all).not.toContain('data:image/png');
  expect(all).not.toContain('data:image/jpeg');
});
