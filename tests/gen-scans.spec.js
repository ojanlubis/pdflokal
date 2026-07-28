/*
 * GENERATE THE SCAN CORPUS — render, degrade, re-wrap. Opt-in.
 * ============================================================================
 *     GEN_SCANS=1 npx playwright test tests/gen-scans.spec.js --project=chromium
 *
 * WHY A SPEC AND NOT scripts/gen-fixture-*.mjs LIKE ITS SIBLINGS: every other
 * generator builds a PDF from operators, which node can do alone. This one has
 * to RENDER a page to pixels first, and that needs PDF.js in a real browser
 * with a real canvas. Skipped unless GEN_SCANS is set, so the gate never
 * regenerates fixtures underneath itself.
 *
 * WHY GENERATED RATHER THAN REAL SCANS (founder, 2026-07-29: "can you generate
 * them instead? ... can you just figure it out?"). The question we need
 * answered is a THRESHOLD: at what background uniformity does covering and
 * redrawing a line stop being invisible? A pile of real scans lands
 * uncontrolled samples all over that boundary. Generating lets us vary ONE
 * dimension and walk it — which is also the only way the fixtures span the
 * decision boundary instead of agreeing with both answers.
 *
 * ⚠️ WHAT THIS CORPUS CAN AND CANNOT SETTLE. It answers the MECHANISM: does
 * cover-and-redraw read as a repair, and where does it break. It does NOT
 * calibrate the real-world decline threshold. Our generators have been
 * systematically unlike real documents all week — every fixture that agreed
 * with both the broken and the correct implementation was one we wrote
 * ourselves. Synthetic answers the mechanism; real documents calibrate the
 * number. Do not quote a threshold measured here as a production value.
 *
 * DOGFOODING, his suggestion: the re-wrap uses our own image-to-PDF path
 * (pdf-lib embedJpg), so building the corpus exercises the shipped code.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'fixtures', 'nasty');
const NASTY = (n) => path.join(OUT, n);

// One dimension at a time, and a sweep that walks the boundary.
const VARIANTS = [
  { name: 'scan-bersih.pdf', src: 'surat-resmi.pdf', grain: 6, gradient: 0.04, rotate: 0, warm: 0, vignette: 0, quality: 0.92 },
  { name: 'scan-miring.pdf', src: 'surat-resmi.pdf', grain: 10, gradient: 0.18, rotate: 0.7, warm: 0.02, vignette: 0.05, quality: 0.85 },
  { name: 'foto-bayangan.pdf', src: 'surat-resmi.pdf', grain: 16, gradient: 0.55, rotate: 1.6, warm: 0.09, vignette: 0.34, quality: 0.42 },
  // The sweep: identical but for gradient strength, so the decline threshold
  // is measurable rather than guessed.
  { name: 'scan-gradien-1.pdf', src: 'surat-resmi.pdf', grain: 8, gradient: 0.10, rotate: 0, warm: 0.01, vignette: 0, quality: 0.88 },
  { name: 'scan-gradien-2.pdf', src: 'surat-resmi.pdf', grain: 8, gradient: 0.25, rotate: 0, warm: 0.02, vignette: 0.06, quality: 0.80 },
  { name: 'scan-gradien-3.pdf', src: 'surat-resmi.pdf', grain: 8, gradient: 0.40, rotate: 0, warm: 0.04, vignette: 0.14, quality: 0.70 },
  { name: 'scan-gradien-4.pdf', src: 'surat-resmi.pdf', grain: 8, gradient: 0.60, rotate: 0, warm: 0.06, vignette: 0.26, quality: 0.58 },
];

test.describe('generate the scan corpus', () => {
  test.skip(!process.env.GEN_SCANS, 'set GEN_SCANS=1 to regenerate the scan fixtures');

  test('render, degrade, re-wrap, and prove each one is really a scan', async ({ page }) => {
    test.setTimeout(10 * 60 * 1000);
    await page.goto('/');
    await page.evaluate(async () => {
      const { ensurePdfJs, ensurePdfLib } = await import('/js/core/vendor.js');
      await ensurePdfJs(); await ensurePdfLib();
    });

    const made = [];
    for (const v of VARIANTS) {
      const srcB64 = fs.readFileSync(NASTY(v.src)).toString('base64');
      const b64 = await page.evaluate(async ({ cfg, src }) => {
        const lib = window.pdfjsLib;
        const bin = atob(src);
        const data = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
        const pdf = await lib.getDocument({ data }).promise;
        const p1 = await pdf.getPage(1);

        // ~120 dpi: enough that text is legible, small enough to keep the
        // fixture committable.
        const scale = 120 / 72;
        const vp = p1.getViewport({ scale });
        const c = document.createElement('canvas');
        c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        await p1.render({ canvasContext: ctx, viewport: vp }).promise;
        await pdf.destroy();

        // Rotation first, on its own surface, so the page edges rotate too.
        let base = c;
        if (cfg.rotate) {
          const r = document.createElement('canvas');
          r.width = c.width; r.height = c.height;
          const rc = r.getContext('2d');
          rc.fillStyle = '#f7f4ee'; rc.fillRect(0, 0, r.width, r.height);
          rc.translate(r.width / 2, r.height / 2);
          rc.rotate((cfg.rotate * Math.PI) / 180);
          rc.drawImage(c, -c.width / 2, -c.height / 2);
          base = r;
        }

        const g = base.getContext('2d');
        const img = g.getImageData(0, 0, base.width, base.height);
        const px = img.data;
        const w = base.width; const h = base.height;
        // Light source off the top-left, the way a phone photo falls.
        const cx = w * 0.32; const cy = h * 0.18;
        const maxD = Math.hypot(w, h);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            // Linear gradient across the page.
            const ramp = 1 - cfg.gradient * (x / w) * 0.6 - cfg.gradient * (y / h) * 0.4;
            // Radial falloff from the light source.
            const d = Math.hypot(x - cx, y - cy) / maxD;
            const vig = 1 - cfg.vignette * d * 1.6;
            const k = Math.max(0, ramp * vig);
            // Paper grain.
            const n = (Math.random() - 0.5) * cfg.grain;
            px[i] = Math.min(255, Math.max(0, px[i] * k * (1 + cfg.warm) + n));
            px[i + 1] = Math.min(255, Math.max(0, px[i + 1] * k + n));
            px[i + 2] = Math.min(255, Math.max(0, px[i + 2] * k * (1 - cfg.warm * 0.8) + n));
          }
        }
        g.putImageData(img, 0, 0);

        // Re-wrap through OUR OWN image path: JPEG + pdf-lib embedJpg.
        const jpeg = base.toDataURL('image/jpeg', cfg.quality);
        const jb = atob(jpeg.split(',')[1]);
        const jbytes = new Uint8Array(jb.length);
        for (let i = 0; i < jb.length; i++) jbytes[i] = jb.charCodeAt(i);
        const doc = await window.PDFLib.PDFDocument.create();
        const embedded = await doc.embedJpg(jbytes);
        // Back to points, so the page is the same physical size as its source.
        const pw = base.width * (72 / 120); const ph = base.height * (72 / 120);
        const pageOut = doc.addPage([pw, ph]);
        pageOut.drawImage(embedded, { x: 0, y: 0, width: pw, height: ph });
        const bytes = await doc.save();
        let s = '';
        for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        return btoa(s);
      }, { cfg: v, src: srcB64 });

      const buf = Buffer.from(b64, 'base64');
      fs.writeFileSync(NASTY(v.name), buf);
      made.push({ name: v.name, kb: Math.round(buf.length / 1024) });
    }

    // PROVE EACH ONE IS ACTUALLY A SCAN. A "scan" fixture that still carries a
    // text layer would silently test nothing at all — the exact failure this
    // corpus exists to avoid.
    for (const m of made) {
      const b64 = fs.readFileSync(NASTY(m.name)).toString('base64');
      const check = await page.evaluate(async (src) => {
        const lib = window.pdfjsLib;
        const { pageHasVisibleText } = await import('/js/core/text-visibility.js');
        const bin = atob(src);
        const data = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
        const pdf = await lib.getDocument({ data }).promise;
        const p1 = await pdf.getPage(1);
        const tc = await p1.getTextContent();
        const visible = await pageHasVisibleText(p1, lib);
        const items = tc.items.filter((it) => it.str && it.str.trim()).length;
        await pdf.destroy();
        return { visible, items };
      }, b64);
      expect(check.items, `${m.name} still has text items — it is not a scan`).toBe(0);
      expect(check.visible, `${m.name} reports visible text — it is not a scan`).toBe(false);
      const raw = fs.readFileSync(NASTY(m.name)).toString('latin1');
      expect(/\/FontFile/.test(raw), `${m.name} embeds a font — it is not a scan`).toBe(false);
      console.log(`  ${m.name.padEnd(24)} ${String(m.kb).padStart(4)} KB   no text, no font — genuine scan`);
    }
    expect(made.length).toBe(VARIANTS.length);
  });
});
