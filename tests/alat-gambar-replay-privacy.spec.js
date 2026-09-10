/*
 * THE OLD WING'S SENTRY REPLAY — WHAT ACTUALLY GOES OUT THE WIRE.
 * ============================================================================
 * `alat-gambar.html` carries its OWN inline `Sentry.init(...)`, not the shared
 * `js/sentry-init.js`, and its replay block list is NARROWER: `blockAllMedia`
 * plus `canvas`, with none of v2's `.pv-bg` / `.pv-anno img` / `.pm-thumb` /
 * `#sig-preview`. Until this file existed it was the one recorder on the
 * product nobody had ever watched — the `/privasi` claim about what a
 * recording does not carry rested on MEASUREMENT for the v2 pages and on
 * REASONING for this one. This spec measures it.
 *
 * The narrower list turns out to be correct rather than lucky: the four extra
 * v2 selectors name nodes that DO NOT EXIST on this page. The old wing renders
 * every page and every thumbnail into a `<canvas>` (js/editor/page-rendering.js,
 * js/editor/sidebar.js) and every tool preview into an `<img>`, so `canvas` +
 * `blockAllMedia` (which expands to `img,image,svg,video,object,picture,embed,
 * map,audio,link[rel=icon]`) covers the same ground. Do NOT pad this page's
 * list with the v2 selectors to make the two look alike; dead selectors read
 * as protection that is not there.
 *
 * ⚠️ NOTHING REACHES SENTRY FROM A TEST RUN. Sentry posts through the
 * same-origin `/api/sentry-tunnel`, which is intercepted and answered locally.
 *
 * ⚠️ TWO REWRITES, AND BOTH ARE ASSERTED RATHER THAN HOPED FOR — the same trap
 * that gave the v2 probe a clean bill of health off a 563-byte envelope with no
 * recording in it. This page's init disables itself off pdflokal.id and samples
 * one session in ten, so a naive run records NOTHING and every absence below
 * passes for free. The init is INLINE, so the rewrite happens on the HTML
 * document, not on a `.js` file. If either source string ever drifts, this test
 * fails loudly instead of silently measuring nothing.
 *
 * ⚠️ THE THIRD CHANNEL. A DOM block list is not the only way user content
 * reaches a replay. Sentry pushes every non-`sentry.transaction` breadcrumb
 * into the recording as an rrweb custom event (`{tag:"breadcrumb"}`), where no
 * mask and no block selector can touch it. `js/lib/utils.js`'s `showToast`
 * writes a `ui.toast` breadcrumb carrying the toast's own message, and four old
 * wing call sites interpolate `file.name` into that message. So this spec drives
 * the toast path on purpose with a SECOND secret string, and checks the
 * breadcrumb channel separately from the DOM one.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');

// Two DIFFERENT secrets, so a hit names the channel it came through: the first
// only ever reaches the DOM (file input, header file menu, thumbnail badge),
// the second only ever reaches a toast message, hence a breadcrumb.
const SECRET_FILENAME = 'RAHASIA-BUDISANTOSO-NIK3174-2026';
const SECRET_REJECTED = 'RAHASIA-KARTUKELUARGA-SITIAMINAH-1982';
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

/**
 * Serve alat-gambar.html with its inline replay forced ON at 100%, and capture
 * every tunnelled envelope. Returns the array the envelopes land in.
 */
async function armRecorder(page, envelopes) {
  await page.route('**/alat-gambar*', async (route) => {
    const res = await route.fetch();
    let body = await res.text();
    body = body.replace(
      "enabled: location.hostname === 'pdflokal.id' || location.hostname === 'www.pdflokal.id',",
      'enabled: true,',
    );
    body = body.replace('replaysSessionSampleRate: 0.10,', 'replaysSessionSampleRate: 1.0,');
    expect(body, 'the hostname gate in alat-gambar.html moved; this test is measuring nothing').toContain('enabled: true,');
    expect(body, 'the replay sample rate line in alat-gambar.html moved; 9 runs in 10 would record nothing').toContain('replaysSessionSampleRate: 1.0,');
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
  });

  await page.route('**/api/sentry-tunnel*', async (route) => {
    const buf = route.request().postDataBuffer();
    if (buf) envelopes.push(buf);
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

/** Open a PDF whose FILENAME is the secret, and wait for a really-rendered page. */
async function openSecretDocument(page, pdfPath) {
  await page.goto('/alat-gambar.html');
  await page.setInputFiles('#file-input', pdfPath);
  await page.waitForFunction(() => document.body.classList.contains('editor-active'));
  await page.waitForFunction(() => window.ueState?.pages?.length === 2);
  await page.waitForFunction(() => window.ueState?.eventsSetup === true);
  // A page slot is created with a PLACEHOLDER canvas before anything is drawn
  // into it. Wait for the real render, or the document's pixels were never on
  // screen to be recorded and "no pixels in the payload" means nothing.
  await page.waitForFunction(() => window.ueState?.pageCanvases?.some(pc => pc.rendered === true));
}

/** Type the secret into a text annotation on page 1 and commit it. */
async function typeSecretAnnotation(page) {
  await page.evaluate(() => window.ueSetTool('text'));
  await page.waitForFunction(() => window.ueState?.currentTool === 'text');
  await page.evaluate(() => {
    const canvas = document.querySelectorAll('.ue-page-slot canvas')[0];
    const rect = canvas.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, clientX: rect.left + 90, clientY: rect.top + 90, button: 0 };
    canvas.dispatchEvent(new MouseEvent('mousedown', opts));
    canvas.dispatchEvent(new MouseEvent('mouseup', opts));
  });
  await page.waitForSelector('#inline-text-editor');
  await page.locator('#inline-text-editor').focus();
  await page.keyboard.type(SECRET_TYPED);
  await page.keyboard.press('Enter');
  await page.waitForSelector('#inline-text-editor', { state: 'detached' });
  // The secret must really be IN the document model, not merely typed at it —
  // otherwise "the payload does not contain it" is a statement about a string
  // that was never rendered.
  await page.waitForFunction(
    (t) => window.ueState?.annotations?.[0]?.some(a => a.text === t),
    SECRET_TYPED,
  );
}

/** Wait until a replay recording — not merely an envelope — has actually arrived. */
async function collectRecording(page, envelopes) {
  await page.evaluate(() => { try { window.Sentry?.flush?.(3000); } catch { /* SDK blocked */ } });
  /** @type {string[]} */
  let recordings = [];
  await expect.poll(
    () => { recordings = inflateRecordings(envelopes); return recordings.join('').length; },
    { message: 'no replay recording was captured, so every absence below would pass for free', timeout: 45_000 },
  ).toBeGreaterThan(1000);
  const joined = recordings.join('\n');
  // Opt-in dump for reading a payload by hand (DUMP_REPLAY=/tmp/x npx playwright
  // test …). It was written UNGUARDED while this spec was being built, which
  // threw on every run and is why the file sat untracked instead of running in
  // CI: a debugging aid left in the hot path is indistinguishable from a broken
  // test to everyone who did not write it.
  if (process.env.DUMP_REPLAY) fs.writeFileSync(process.env.DUMP_REPLAY, joined);
  return joined;
}

test('old wing replay sends no filename, no typed text and no document pixels', async ({ page }) => {
  test.setTimeout(180_000);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdflokal-ag-'));
  const pdf = path.join(dir, `${SECRET_FILENAME}.pdf`);
  fs.copyFileSync(SOURCE, pdf);

  /** @type {Buffer[]} */
  const envelopes = [];
  await armRecorder(page, envelopes);

  await openSecretDocument(page, pdf);
  await typeSecretAnnotation(page);

  const all = await collectRecording(page, envelopes);

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
  // Old wing page rasters live in <canvas> (js/editor/page-rendering.js) and
  // tool previews in <img> data URLs (js/image-tools.js).
  //
  // ⚠️ MEASURED 2026-09-10, and it corrects what this file used to claim.
  // `canvas` and `blockAllMedia` are REDUNDANT WITH EACH OTHER here, not two
  // halves of one guard. Sabotage said so plainly:
  //   block:['canvas'] removed, blockAllMedia kept  → still green
  //   blockAllMedia:false, block:['canvas'] kept    → still green
  //   BOTH off                                      → RED
  // So this assertion is not vacuous — it can go red — but the pixel channel
  // survives losing either setting alone. That is defence in depth doing its
  // job, and it also means a future session that deletes one of them will get
  // NO signal from this test. Delete one and the other becomes load-bearing
  // with nothing watching it; the pairing is the protection.
  expect(all).not.toContain('data:image/png');
  expect(all).not.toContain('data:image/jpeg');
});

test('old wing replay carries no filename through the toast breadcrumb channel', async ({ page }) => {
  test.setTimeout(180_000);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdflokal-ag-bc-'));
  const pdf = path.join(dir, `${SECRET_FILENAME}.pdf`);
  fs.copyFileSync(SOURCE, pdf);
  // A .txt is neither PDF nor image, so js/editor/file-loading.js's processFile
  // rejects it with a toast that interpolates the name. Playwright ignores the
  // input's `accept`, which is also true of a real drag-and-drop.
  const rejected = path.join(dir, `${SECRET_REJECTED}.txt`);
  fs.writeFileSync(rejected, 'bukan pdf');

  /** @type {Buffer[]} */
  const envelopes = [];
  await armRecorder(page, envelopes);

  await openSecretDocument(page, pdf);

  await page.setInputFiles('#ue-file-input', rejected);
  await expect(page.locator('#toast-container .toast')).toContainText('bukan PDF atau gambar');

  const all = await collectRecording(page, envelopes);

  expect(all, 'no blocked-element placeholder in the payload: blocking may not be running at all').toContain('rr_width');
  // The breadcrumb channel is only worth checking once we can see it is open:
  // a run with no breadcrumb custom event proves nothing about what one carries.
  expect(all, 'no breadcrumb reached the recording, so the check below measures nothing').toContain('"tag":"breadcrumb"');

  expect(all, 'a toast breadcrumb is carrying the rejected file\'s name into the replay').not.toContain(SECRET_REJECTED);
  expect(all).not.toContain('KARTUKELUARGA');
  expect(all).not.toContain(SECRET_FILENAME);
});
