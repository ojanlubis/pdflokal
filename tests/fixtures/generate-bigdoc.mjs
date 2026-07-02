/*
 * generate-bigdoc.mjs — one-shot fixture generator for the big-doc stress test.
 * ============================================================================
 * Builds tests/fixtures/bigdoc-120.pdf: 120 A4 pages, each a distinct colored
 * panel + its page number in huge white type, so pages are visually
 * distinguishable AND non-trivially sized (real content, not blank paper).
 *
 * WHY via Playwright chromium: pdf-lib.min.js is a BROWSER build (window.PDFLib)
 * — the same lib the editor ships. Rather than add an npm pdf-lib just for the
 * fixture, we inject the vendored file into a headless page and build there, so
 * the fixture is produced by the exact code path the app uses.
 *
 * Deterministic by construction (color is a pure function of the page index, no
 * Date.now, no randomness) so the committed fixture is stable across runs.
 *
 * Run once:  node tests/fixtures/generate-bigdoc.mjs
 */
import { chromium } from '@playwright/test';
import { writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PDFLIB_PATH = path.join(__dirname, '..', '..', 'js', 'vendor', 'pdf-lib.min.js');
const OUT_PATH = path.join(__dirname, 'bigdoc-120.pdf');
const PAGE_COUNT = 120;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.addScriptTag({ path: PDFLIB_PATH });

const base64 = await page.evaluate(async (n) => {
  const { PDFDocument, StandardFonts, rgb } = window.PDFLib;

  // Deterministic HSL→RGB so each page reads as a different color. Golden-angle
  // hue step spreads adjacent pages far apart on the color wheel.
  function colorFor(i) {
    const h = ((i * 137.508) % 360) / 360, s = 0.55, l = 0.45;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hue = (t) => {
      t = (t + 1) % 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return { r: hue(h + 1 / 3), g: hue(h), b: hue(h - 1 / 3) };
  }

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = 595.28, H = 841.89;

  for (let i = 1; i <= n; i += 1) {
    const pg = pdf.addPage([W, H]);
    const c = colorFor(i);
    pg.drawRectangle({ x: 36, y: 72, width: W - 72, height: H - 144, color: rgb(c.r, c.g, c.b) });
    const label = String(i);
    const size = 220;
    const tw = font.widthOfTextAtSize(label, size);
    pg.drawText(label, { x: (W - tw) / 2, y: H / 2 - size / 2.6, size, font, color: rgb(1, 1, 1) });
    // A small caption so text extraction / thumbnails have more than one glyph.
    pg.drawText(`Halaman ${i} / ${n}`, { x: 48, y: H - 108, size: 20, font, color: rgb(1, 1, 1) });
  }

  const bytes = await pdf.save();
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}, PAGE_COUNT);

await browser.close();

const buf = Buffer.from(base64, 'base64');
writeFileSync(OUT_PATH, buf);
console.log(`Wrote ${OUT_PATH} — ${PAGE_COUNT} pages, ${(buf.length / 1024).toFixed(1)} KB`);
