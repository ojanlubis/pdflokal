/*
 * PDFLokal — docx/raster.js  (the browser's rasterizer for colour.js: a region of the page as a picture)
 * ============================================================================
 *   canRasterize() -> boolean         a canvas exists (a browser, or a worker with OffscreenCanvas)
 *   rasterizeRegion({ ctx, box, why }) -> { bytes: Uint8Array, ext: 'png' } | null
 *
 * pdf.js's OWN renderer draws the region, so a soft mask, a tiling pattern or a 60,000-vertex trace
 * comes out exactly as the PDF viewer shows it. The TEXT is left out: every show-text operator of the
 * list the renderer draws from (and so is every picture images.js anchors itself, see LEAVE_OUT) is swapped for a no-op (`dependency` with no ids) for the duration of the render (see renderLists),
 * so the words stay live Word text on top instead of appearing twice. The background is transparent
 * (the region sits at its paint position in the stack, other art shows through).
 *
 * Nothing here runs in node (no canvas): the gate and the core tests inject `options.rasterize` instead,
 * and a page with no rasterizer simply does not draw those regions (colour.js counts them).
 */

/* global OffscreenCanvas */
const DPI = 110;          // a picture behind text: enough for art, small enough for Word
const MAX_PIXELS = 1.6e6; // per region

export function canRasterize() {
  return (typeof document !== 'undefined' && typeof document.createElement === 'function') || typeof OffscreenCanvas !== 'undefined';
}

function makeCanvas(w, h) {
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  return new OffscreenCanvas(w, h);
}

async function toPngBytes(canvas) {
  const blob = canvas.convertToBlob ? await canvas.convertToBlob({ type: 'image/png' }) : await new Promise((res) => canvas.toBlob(res, 'image/png'));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

// Left out of the picture: the text (it stays live Word text) and every picture images.js already anchors as its own
// picture (the same three ops it reads), or each photo would sit in the .docx twice (MEASURED on n029: 918 KB PNG, photos
// included). Stencil masks (paintImageMaskXObject) stay in: images.js skips them, so this picture is the only place they survive.
const LEAVE_OUT = (OPS) => new Set([OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText,
  OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageXObjectRepeat]);

// MEASURED 2026-10-02 (pdf.js 3.11.174, Chromium): page.getOperatorList() and page.render() do NOT share an
// operator list (the first carries the OPLIST intent flag, so its cache key differs): blanking the text ops of
// the list we read changed the render by 0 pixels. The list render() draws from lives in the page proxy's
// intent states, and persists there after a render. So: one throw-away tiny render makes pdf.js parse and keep
// it, then those lists (never ours) get their text ops blanked for the real render and are restored after.
// `_intentStates` is private API: we vendor one fixed pdf.js, and when it is not there we return null (no picture).
const warmed = new WeakSet();
async function renderLists(page, pdfjs, ops) {
  const find = () => {
    const out = [];
    const states = page && page._intentStates;
    if (!states || typeof states.values !== 'function') return out;
    for (const st of states.values()) {
      const l = st && st.operatorList;
      if (l && l !== ops && l.fnArray && l.fnArray.length) out.push(l);
    }
    return out;
  };
  if (!warmed.has(page)) {
    const c = makeCanvas(2, 2);
    const g = c.getContext('2d');
    if (!g) return [];
    await page.render({ canvasContext: g, viewport: page.getViewport({ scale: 0.01 }), background: 'rgba(0,0,0,0)' }).promise;
    warmed.add(page);
  }
  return find();
}

export async function rasterizeRegion({ ctx, box }) {
  if (!canRasterize()) return null;
  const { page, pdfjs, ops } = ctx;
  const w = box[2] - box[0];
  const h = box[3] - box[1];
  if (!(w > 1 && h > 1)) return null;
  let scale = DPI / 72;
  if (w * h * scale * scale > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / (w * h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const canvas = makeCanvas(cw, ch);
  const g = canvas.getContext('2d');
  if (!g) return null;
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale, rotation: base.rotation, offsetX: -box[0] * scale, offsetY: -box[1] * scale });
  const lists = await renderLists(page, pdfjs, ops);
  if (!lists.length) return null; // cannot take the text out: a picture with the words baked in would print them twice
  const text = LEAVE_OUT(pdfjs.OPS);
  const saved = [];
  for (const l of lists) {
    for (let i = 0; i < l.fnArray.length; i += 1) {
      if (text.has(l.fnArray[i])) { saved.push([l, i, l.fnArray[i], l.argsArray[i]]); l.fnArray[i] = pdfjs.OPS.dependency; l.argsArray[i] = []; }
    }
  }
  try {
    await page.render({ canvasContext: g, viewport, background: 'rgba(0,0,0,0)' }).promise;
  } finally {
    for (const [l, i, fn, args] of saved) { l.fnArray[i] = fn; l.argsArray[i] = args; }
  }
  const bytes = await toPngBytes(canvas);
  return bytes ? { bytes, ext: 'png' } : null;
}
