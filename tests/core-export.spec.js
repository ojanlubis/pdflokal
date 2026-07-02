/*
 * PDFLokal — core export adapter (browser-tested, because it uses vendored pdf-lib).
 *
 * Verifies js/core/export.js `buildPdfBytes`: a Doc built purely through core
 * modules round-trips to real PDF bytes that PDF.js can re-render, with
 * annotations landing at the right PIXELS (not just "didn't throw"). Source
 * PDFs are generated in-browser with pdf-lib so no fixture drift is possible —
 * we know exactly which regions are dark/blue/white.
 *
 * Geometry cheat-sheet (600×800pt page, top-left page-space points):
 *   dark block   x 50..250,  y 100..200   (drawn in the source PDF)
 *   whiteout     x 60..140,  y 110..170   (over part of the dark block)
 *   text 'XXXXX' x 300..,    y 400..      (36pt bold on white background)
 *   signature    x 400..500, y 600..700   (solid red PNG)
 */
import { test, expect } from '@playwright/test';

// Build the shared 2-page source Doc inside the browser and return core handles.
// Page 1: 600×800 with a black block; Page 2: 600×800 with a blue square at
// PDF coords x 100..200, y 100..200 (bottom-left frame).
async function buildSourceDoc() {
  const model = await import('/js/core/model.js');
  const ops = await import('/js/core/operations.js');
  const imp = await import('/js/core/import.js');
  const exp = await import('/js/core/export.js');
  const { PDFLib } = window;

  const src = await PDFLib.PDFDocument.create();
  const sp1 = src.addPage([600, 800]);
  // top-left frame: x 50..250, y 100..200
  sp1.drawRectangle({ x: 50, y: 600, width: 200, height: 100, color: PDFLib.rgb(0, 0, 0) });
  const sp2 = src.addPage([600, 800]);
  sp2.drawRectangle({ x: 100, y: 100, width: 100, height: 100, color: PDFLib.rgb(0, 0, 1) });
  const srcBytes = await src.save();

  const doc = model.createDoc();
  await imp.importPdf(doc, { name: 'generated.pdf', bytes: srcBytes });
  return { model, ops, exp, doc };
}

// Render page `pageNum` (1-based) of `pdfBytes` with PDF.js at `scale` and
// return a sampler over the resulting canvas (same round-trip strategy as the
// golden suite — rendered pixels are what the user actually sees).
async function renderPage(pdfBytes, pageNum, scale) {
  const out = await window.pdfjsLib.getDocument({ data: pdfBytes.slice() }).promise;
  const pdfPage = await out.getPage(pageNum);
  const vp = pdfPage.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  await pdfPage.render({ canvasContext: ctx, viewport: vp }).promise;

  return {
    numPages: out.numPages,
    rotate: pdfPage.rotate,
    vpWidth: Math.round(vp.width / scale),
    vpHeight: Math.round(vp.height / scale),
    // 1×1 sample at page-space point (x, y) → [r, g, b]
    px(x, y) {
      const d = ctx.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data;
      return [d[0], d[1], d[2]];
    },
    // darkest luma inside a page-space rect — "is there ink here?"
    regionMinLuma(x0, y0, x1, y1) {
      const d = ctx.getImageData(
        Math.round(x0 * scale), Math.round(y0 * scale),
        Math.round((x1 - x0) * scale), Math.round((y1 - y0) * scale),
      ).data;
      let min = 255;
      for (let i = 0; i < d.length; i += 4) {
        const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        if (l < min) min = l;
      }
      return min;
    },
  };
}

test.describe('core export adapter', () => {
  test('buildPdfBytes: whiteout, text, signature land at the right pixels', async ({ page }) => {
    await page.goto('/alat-gambar.html');
    await page.waitForFunction(() => !!window.pdfjsLib && !!window.PDFLib);

    const r = await page.evaluate(`(async () => {
      ${buildSourceDoc}
      ${renderPage}
      const { model, ops, exp, doc } = await buildSourceDoc();
      const p0 = doc.pages[0];

      // Whiteout covering part of the dark block.
      ops.addAnnotation(doc, p0.id, model.createAnnotation('whiteout', {
        x: 60, y: 110, width: 80, height: 60,
      }));
      // Bold black text on the white area below the block.
      ops.addAnnotation(doc, p0.id, model.createAnnotation('text', {
        text: 'XXXXX', x: 300, y: 400, fontSize: 36,
        color: '#000000', fontFamily: 'Helvetica', bold: true, italic: false,
      }));
      // Signature: solid red PNG generated on the fly.
      const sc = document.createElement('canvas');
      sc.width = 20; sc.height = 20;
      const sctx = sc.getContext('2d');
      sctx.fillStyle = '#ff0000';
      sctx.fillRect(0, 0, 20, 20);
      ops.addAnnotation(doc, p0.id, model.createAnnotation('signature', {
        image: sc.toDataURL('image/png'), x: 400, y: 600, width: 100, height: 100,
      }));

      const outBytes = await exp.buildPdfBytes(doc); // deps default to window globals
      const s = await renderPage(outBytes, 1, 2);
      return {
        numPages: s.numPages,
        whiteoutPx: s.px(100, 140),                       // inside whiteout, over dark block
        darkPx: s.px(200, 150),                           // dark block, outside whiteout
        textMinLuma: s.regionMinLuma(295, 398, 420, 445), // text bbox must contain ink
        aboveTextMinLuma: s.regionMinLuma(295, 340, 420, 380), // must stay blank
        sigPx: s.px(450, 650),                            // signature centre
      };
    })()`);

    expect(r.numPages).toBe(2);

    // Whiteout region is white even though the source page is black there.
    for (const c of r.whiteoutPx) expect(c).toBeGreaterThan(245);
    // The rest of the dark block survived.
    for (const c of r.darkPx) expect(c).toBeLessThan(60);

    // Text region contains dark glyph pixels; the area above it stays blank.
    expect(r.textMinLuma).toBeLessThan(100);
    expect(r.aboveTextMinLuma).toBeGreaterThan(240);

    // Signature centre is solid red.
    expect(r.sigPx[0]).toBeGreaterThan(200);
    expect(r.sigPx[1]).toBeLessThan(80);
    expect(r.sigPx[2]).toBeLessThan(80);
  });

  test('rotated page: /Rotate lands in output and annotations follow the rotated frame', async ({ page }) => {
    await page.goto('/alat-gambar.html');
    await page.waitForFunction(() => !!window.pdfjsLib && !!window.PDFLib);

    const r = await page.evaluate(`(async () => {
      ${buildSourceDoc}
      ${renderPage}
      const { model, ops, exp, doc } = await buildSourceDoc();
      const p1 = doc.pages[1];
      ops.rotatePage(doc, p1.id, 90);

      // In the rotated (90° cw) view the page is 800 wide × 600 tall and the
      // blue square appears at view coords x 100..200, y 100..200. Cover its
      // LEFT half (view x 100..150) with a whiteout — in the unrotated PDF
      // frame that must become the BOTTOM half of the square.
      ops.addAnnotation(doc, p1.id, model.createAnnotation('whiteout', {
        x: 100, y: 100, width: 50, height: 100,
      }));

      const outBytes = await exp.buildPdfBytes(doc);
      // PDF.js applies /Rotate in its default viewport → samples below are in
      // the ROTATED view frame, i.e. exactly what the user placed against.
      const s = await renderPage(outBytes, 2, 2);
      return {
        rotate: s.rotate,
        vpWidth: s.vpWidth,
        vpHeight: s.vpHeight,
        whitedPx: s.px(125, 150), // inside the whiteout half
        bluePx: s.px(175, 150),   // remaining half of the blue square
      };
    })()`);

    // Rotation is real metadata in the output, and the viewport swaps dims.
    expect(r.rotate).toBe(90);
    expect(r.vpWidth).toBe(800);
    expect(r.vpHeight).toBe(600);

    // Whiteout landed on the intended half of the square in the ROTATED view.
    for (const c of r.whitedPx) expect(c).toBeGreaterThan(245);
    expect(r.bluePx[2]).toBeGreaterThan(200); // still blue
    expect(r.bluePx[0]).toBeLessThan(80);
  });

  test('custom fonts: Montserrat + Carlito-Bold embed from /fonts and render ink', async ({ page }) => {
    await page.goto('/alat-gambar.html');
    await page.waitForFunction(() => !!window.pdfjsLib && !!window.PDFLib && !!window.fontkit);

    const r = await page.evaluate(`(async () => {
      ${buildSourceDoc}
      ${renderPage}
      const { model, ops, exp, doc } = await buildSourceDoc();
      const p0 = doc.pages[0];

      // Montserrat regular on the white area below the dark block.
      ops.addAnnotation(doc, p0.id, model.createAnnotation('text', {
        text: 'MMMMM', x: 300, y: 400, fontSize: 36,
        color: '#000000', fontFamily: 'Montserrat', bold: false, italic: false,
      }));
      // Carlito bold, lower down on the same white area.
      ops.addAnnotation(doc, p0.id, model.createAnnotation('text', {
        text: 'CCCCC', x: 300, y: 500, fontSize: 36,
        color: '#000000', fontFamily: 'Carlito', bold: true, italic: false,
      }));

      const outBytes = await exp.buildPdfBytes(doc); // deps default to window globals
      const s = await renderPage(outBytes, 1, 2);
      return {
        montserratMinLuma: s.regionMinLuma(295, 398, 460, 445), // Montserrat text bbox
        carlitoMinLuma: s.regionMinLuma(295, 498, 460, 545),    // Carlito-Bold text bbox
        betweenMinLuma: s.regionMinLuma(295, 452, 460, 490),    // gap between lines stays blank
      };
    })()`);

    // Both custom-font lines put real glyph ink on the page (fonts fetched and
    // embedded via fontkit — not the Helvetica fallback, which would still be
    // ink; this asserts embedding didn't throw and text rendered).
    expect(r.montserratMinLuma).toBeLessThan(100);
    expect(r.carlitoMinLuma).toBeLessThan(100);
    // The gap between the two lines is untouched white.
    expect(r.betweenMinLuma).toBeGreaterThan(240);
  });

  test('watermark: tilted text renders semi-transparent ink near page centre', async ({ page }) => {
    await page.goto('/alat-gambar.html');
    await page.waitForFunction(() => !!window.pdfjsLib && !!window.PDFLib);

    const r = await page.evaluate(`(async () => {
      ${buildSourceDoc}
      ${renderPage}
      const { model, ops, exp, doc } = await buildSourceDoc();
      const p0 = doc.pages[0];

      // Watermark centred at (300, 400) — well below the dark block (y 100..200).
      ops.addAnnotation(doc, p0.id, model.createAnnotation('watermark', {
        text: 'RAHASIA', x: 300, y: 400, fontSize: 48,
        color: '#000000', opacity: 0.5, rotation: 45,
      }));

      const outBytes = await exp.buildPdfBytes(doc);
      const s = await renderPage(outBytes, 1, 2);
      return {
        centreMinLuma: s.regionMinLuma(150, 300, 450, 500), // generous box around centre
        cornerMinLuma: s.regionMinLuma(40, 640, 240, 760),  // far corner stays blank
      };
    })()`);

    // Some ink landed near the centre. opacity 0.5 over white → mid-grey, so the
    // threshold is generous (not near-black like solid text).
    expect(r.centreMinLuma).toBeLessThan(220);
    // A corner far from the watermark stays white.
    expect(r.cornerMinLuma).toBeGreaterThan(240);
  });

  test('pageNumber: label renders ink at its position (old exporter dropped this)', async ({ page }) => {
    await page.goto('/alat-gambar.html');
    await page.waitForFunction(() => !!window.pdfjsLib && !!window.PDFLib);

    const r = await page.evaluate(`(async () => {
      ${buildSourceDoc}
      ${renderPage}
      const { model, ops, exp, doc } = await buildSourceDoc();
      const p0 = doc.pages[0];

      // Page-number label on the white area. Larger than the 12pt default so the
      // thin '1' glyph is reliably sampled at scale 2.
      ops.addAnnotation(doc, p0.id, model.createAnnotation('pageNumber', {
        text: '1', x: 300, y: 400, fontSize: 24, color: '#000000',
      }));

      const outBytes = await exp.buildPdfBytes(doc);
      const s = await renderPage(outBytes, 1, 2);
      return {
        labelMinLuma: s.regionMinLuma(296, 398, 330, 430), // '1' glyph bbox
        besideMinLuma: s.regionMinLuma(360, 398, 460, 430), // to the right stays blank
      };
    })()`);

    // The label put ink on the page — guards the fix for the old exporter, which
    // had no pageNumber branch and silently dropped these.
    expect(r.labelMinLuma).toBeLessThan(120);
    // Space beside the single digit stays white.
    expect(r.besideMinLuma).toBeGreaterThan(240);
  });

  test('rotated page: text annotation lands in the correct region of the rotated view', async ({ page }) => {
    await page.goto('/alat-gambar.html');
    await page.waitForFunction(() => !!window.pdfjsLib && !!window.PDFLib);

    const r = await page.evaluate(`(async () => {
      ${buildSourceDoc}
      ${renderPage}
      const { model, ops, exp, doc } = await buildSourceDoc();
      const p1 = doc.pages[1];
      ops.rotatePage(doc, p1.id, 90);

      // In the rotated (90° cw) view the page is 800 wide × 600 tall. Place text
      // at view coords (300, 300) — clear of the blue square (view x 100..200,
      // y 100..200). It must render there in the rotated output view.
      ops.addAnnotation(doc, p1.id, model.createAnnotation('text', {
        text: 'ROT', x: 300, y: 300, fontSize: 40,
        color: '#000000', fontFamily: 'Helvetica', bold: true, italic: false,
      }));

      const outBytes = await exp.buildPdfBytes(doc);
      // PDF.js applies /Rotate in its default viewport → samples are in the
      // ROTATED view frame, exactly where the user placed the text.
      const s = await renderPage(outBytes, 2, 2);
      return {
        rotate: s.rotate,
        vpWidth: s.vpWidth,
        vpHeight: s.vpHeight,
        textMinLuma: s.regionMinLuma(295, 300, 420, 350), // text bbox in rotated view
        aboveMinLuma: s.regionMinLuma(295, 240, 420, 285), // above the text stays blank
      };
    })()`);

    // Rotation is real metadata and the viewport swaps dims.
    expect(r.rotate).toBe(90);
    expect(r.vpWidth).toBe(800);
    expect(r.vpHeight).toBe(600);

    // Text ink landed in the rotated-view region; the area above it stays blank.
    expect(r.textMinLuma).toBeLessThan(100);
    expect(r.aboveMinLuma).toBeGreaterThan(240);
  });

  test('isFromImage page: raw image source becomes a full-page image', async ({ page }) => {
    await page.goto('/alat-gambar.html');
    await page.waitForFunction(() => !!window.pdfjsLib && !!window.PDFLib);

    const r = await page.evaluate(`(async () => {
      ${renderPage}
      const model = await import('/js/core/model.js');
      const ops = await import('/js/core/operations.js');
      const exp = await import('/js/core/export.js');

      // A solid red 300×200 PNG as RAW FILE BYTES (what an image source holds).
      const c = document.createElement('canvas');
      c.width = 300; c.height = 200;
      const cctx = c.getContext('2d');
      cctx.fillStyle = '#ff0000';
      cctx.fillRect(0, 0, 300, 200);
      const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
      const bytes = new Uint8Array(await blob.arrayBuffer());

      const doc = model.createDoc();
      const source = ops.addSource(doc, model.createSource({ name: 'foto.png', bytes, numPages: 1 }));
      ops.addPages(doc, [model.createPage({
        source, sourcePageNum: 0, width: 300, height: 200, isFromImage: true,
      })]);

      const outBytes = await exp.buildPdfBytes(doc);
      const s = await renderPage(outBytes, 1, 2);
      return {
        numPages: s.numPages,
        vpWidth: s.vpWidth,
        vpHeight: s.vpHeight,
        centerPx: s.px(150, 100),
      };
    })()`);

    expect(r.numPages).toBe(1);
    expect(r.vpWidth).toBe(300);
    expect(r.vpHeight).toBe(200);
    expect(r.centerPx[0]).toBeGreaterThan(200); // full-bleed red
    expect(r.centerPx[1]).toBeLessThan(80);
    expect(r.centerPx[2]).toBeLessThan(80);
  });
});
