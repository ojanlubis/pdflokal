/*
 * PDFLokal — scripts/sample-path.mjs  (THE TASTE SAMPLE: a PATH, not a page)
 * ============================================================================
 * Called by gen-seo-pages.js --sample. Renders the user's JOURNEY through an
 * intent page as ONE contact sheet, and puts it on Fauzan's desk.
 *
 * WHY A SEQUENCE (the scar, and it is filed against my own first attempt):
 *   Fauzan caught the /pisah-pdf wording gap — a page that never says "pisah" to
 *   someone who came to split a PDF. The offending word ("Ekstrak") is NOT on the
 *   landing page. It is on a button inside the Kelola Halaman sheet, which only
 *   exists AFTER a file is dropped. My first sample screenshotted the landing page
 *   and would have sailed straight past the defect that motivated building it.
 *
 *   He found it by WALKING THE PATH. Every string was correct in isolation; every
 *   screen passed review in isolation. The defect was DISTRIBUTED ACROSS FRAMES.
 *
 *   >> If a defect can hide between two frames, one frame is not a sample. <<
 *
 * THE THREE FRAMES:
 *   1. ARRIVAL      — what a person from Google sees. The h1, the sub, the dropzone.
 *   2. AFTER A FILE — the editor with the intent armed. The toolbar they now face.
 *   3. THE LANDING  — the sheet/tool the intent actually opens. Where "Ekstrak" hid.
 *
 * Composed into ONE image on purpose: his desk protocol is one reading, one action.
 * Three separate files would be three readings.
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const [slug, port, out] = process.argv.slice(2);
const FIXTURE = 'tests/fixtures/sample-2pages.pdf';
const W = 390; // a PHONE. ~95% of paid acquisition is mobile, and that is who lands here.
const H = 780;

if (!existsSync(FIXTURE)) {
  console.error(`  ✖ ${FIXTURE} missing — the path sample must actually drop a file.`);
  process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const shots = [];
const snap = async (label) => {
  const buf = await page.screenshot();
  shots.push({ label, b64: buf.toString('base64') });
};

await page.goto(`http://localhost:${port}/${slug}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(900); // let the JS-applied intent copy land
await snap('1 · ARRIVAL — from Google');

await page.setInputFiles('#file-input', FIXTURE);
await page.waitForSelector('.pv-bg', { timeout: 20000 });
await page.waitForTimeout(1800); // the intent fires here: a sheet may open by itself
await snap('2 · AFTER THE FILE — intent armed');

// Frame 3: THE VERB. Go one interaction deeper, to the button that names the job.
//
// I got this wrong TWICE. First I sampled only the landing page. Then I sampled
// three frames — and the word "Pisah" was STILL invisible, because the bulk bar
// carrying it only appears once a page is SELECTED. The defect hid one interaction
// below where I was looking, a second time.
//
// So the last frame must reach the VERB — the control the user finally presses.
// That is where "Ekstrak" sat, silently failing someone who came to *pisah*.
const openDialog = await page.$('dialog[open]');
if (!openDialog) {
  const pm = await page.$('#btn-pages, [data-tool="halaman"], #tb-halaman');
  if (pm) { await pm.click().catch(() => {}); await page.waitForTimeout(1000); }
}
// Select something, so the action bar (and its verbs) actually renders.
const tile = await page.$('.pm-thumb, .pm-grid > *');
if (tile) { await tile.click().catch(() => {}); await page.waitForTimeout(800); }
await snap('3 · THE VERB — the button they press');

// Contact sheet: three frames side by side, labelled. Rendered as HTML and shot in
// one pass — no image library, no dependency.
const sheet = `<style>
  body{margin:0;background:#f6f4f1;font:600 13px/1.4 -apple-system,system-ui,sans-serif;color:#57504a}
  .row{display:flex;gap:14px;padding:14px}
  figure{margin:0}
  figcaption{padding:0 0 8px;letter-spacing:.02em}
  img{display:block;width:${W}px;border:1px solid #e0dbd4;border-radius:10px;background:#fff}
</style>
<div class="row">${shots.map((s) => `<figure><figcaption>${s.label}</figcaption><img src="data:image/png;base64,${s.b64}"></figure>`).join('')}</div>`;

const tmp = join(dirname(out), `.${slug}.sheet.html`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(tmp, sheet);

const composer = await browser.newPage({ viewport: { width: W * 3 + 70, height: 400 } });
await composer.goto(`file://${tmp}`);
await composer.waitForTimeout(400);
await composer.screenshot({ path: out, fullPage: true });
await browser.close();

console.log(`  path sample: ${shots.length} frames → ${out}`);
