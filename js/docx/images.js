/*
 * PDFLokal — docx/images.js  (IMAGES: decode, encode, placement)   [the current image path; lane owns this file]
 * ============================================================================
 * THE INTERFACE
 *
 *   extractImages(ctx) -> { images, stats }                       (async)
 *       Walks ctx.ops (ops.walkOps), decodes each painted raster image, downsamples
 *       to <= 150 dpi at its placed size and encodes it (canvas JPEG/PNG in a browser,
 *       the headless PNG encoder in node). Cached per image id in ctx.shared.imageCache
 *       so a logo repeated on every page is encoded once. Returns
 *         images: [{ kind:'img', bytes, ext:'png'|'jpeg', box:{x0,y0,x1,y1} (page pt), z: op index }]
 *         stats:  { masks, failed }   masks = stencil/image-mask paints we skip (the spike's
 *                                     known gap: masked images lose their mask -> black boxes)
 *       convert.js stores `images` on ctx.images.
 *
 *   imageAnchors(ctx) -> { anchors, dropped }
 *       The placement POLICY: which ctx.images become Page.anchors (absolute, behind
 *       the text, clipped to the page) and which are dropped (a searchable scan's
 *       full-page picture would double its own words). Each anchor carries `z` so
 *       convert.js can interleave them with colour shapes in paint order.
 */

import { encodePng } from './png.js';
import { walkOps } from './ops.js';

function expandToPixels(img) {
  const { width, height, data, kind } = img;
  if (!data || !width || !height) return null;
  if (kind === 2) return { w: width, h: height, ch: 3, px: data };
  if (kind === 3) return { w: width, h: height, ch: 4, px: data };
  if (kind === 1) {
    const px = new Uint8Array(width * height);
    const rowBytes = (width + 7) >> 3;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) px[y * width + x] = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
    }
    return { w: width, h: height, ch: 1, px };
  }
  // pdf.js sometimes hands back a plain RGB/RGBA buffer without `kind`.
  if (data.length === width * height * 4) return { w: width, h: height, ch: 4, px: data };
  if (data.length === width * height * 3) return { w: width, h: height, ch: 3, px: data };
  if (data.length === width * height) return { w: width, h: height, ch: 1, px: data };
  return null;
}

// Box-average down to at most maxW pixels wide (integer factor), so a 600 dpi
// scan does not become a 40 MB inline picture.
function downscale(p, maxW) {
  const f = Math.floor(p.w / maxW);
  if (f < 2) return p;
  const nw = Math.floor(p.w / f);
  const nh = Math.floor(p.h / f);
  const out = new Uint8Array(nw * nh * p.ch);
  const div = f * f;
  for (let y = 0; y < nh; y += 1) {
    for (let x = 0; x < nw; x += 1) {
      for (let c = 0; c < p.ch; c += 1) {
        let sum = 0;
        for (let dy = 0; dy < f; dy += 1) for (let dx = 0; dx < f; dx += 1) sum += p.px[((y * f + dy) * p.w + (x * f + dx)) * p.ch + c];
        out[(y * nw + x) * p.ch + c] = sum / div;
      }
    }
  }
  return { w: nw, h: nh, ch: p.ch, px: out };
}

// In a real browser pdf.js hands images over as an ImageBitmap (decoded off the
// main thread), not as a pixel buffer. Draw it at the size it is placed (150 dpi
// cap) and let the canvas encoder do the work: JPEG when it is opaque (a photo or
// a scan: ~10x smaller than PNG), PNG when it carries transparency.
async function encodeBitmap(bitmap, maxW) {
  const scale = Math.min(1, maxW / bitmap.width);
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new globalThis.OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  let alpha = false;
  for (let i = 3; i < px.length; i += 4) if (px[i] < 250) { alpha = true; break; }
  const blob = await canvas.convertToBlob(alpha ? { type: 'image/png' } : { type: 'image/jpeg', quality: 0.85 });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), ext: alpha ? 'png' : 'jpeg' };
}

export async function extractImages(ctx) {
  const { pdfjs, page, ops, vp } = ctx;
  const state = ctx.shared;
  const { OPS } = pdfjs;
  const found = [];
  const stats = { masks: 0, failed: 0 };
  const mul = (m, n) => pdfjs.Util.transform(m, n);
  for (const ev of walkOps(pdfjs, ops)) {
    const { fn, args } = ev;
    if (fn === OPS.paintImageMaskXObject || fn === OPS.paintImageMaskXObjectRepeat) stats.masks += 1;
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageXObjectRepeat) {
      const m = mul(vp.transform, ev.ctm);
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map((p) => pdfjs.Util.applyTransform(p, m));
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const box = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
      if (box.x1 - box.x0 < 4 || box.y1 - box.y0 < 4) { stats.failed += 0; continue; }
      const id = fn === OPS.paintInlineImageXObject ? null : args[0];
      const key = id && `${id}`;
      let enc = key && state.imageCache.get(key);
      if (!enc) {
        try {
          let img;
          if (fn === OPS.paintInlineImageXObject) img = args[0];
          else img = await new Promise((resolve, reject) => {
            const pool = String(id).startsWith('g_') ? page.commonObjs : page.objs;
            let done = false;
            pool.get(id, (o) => { done = true; resolve(o); });
            setTimeout(() => { if (!done) reject(new Error('image not resolved')); }, 4000);
          });
          const maxW = Math.max(16, Math.ceil(((box.x1 - box.x0) * 150) / 72));
          if (img && img.bitmap && typeof globalThis.OffscreenCanvas !== 'undefined') {
            enc = await encodeBitmap(img.bitmap, maxW);
          } else {
            const px = img && expandToPixels(img);
            if (!px) throw new Error('unreadable image');
            const d = downscale(px, maxW);
            enc = { bytes: encodePng(state.fflate, d.w, d.h, d.ch, d.px), ext: 'png' };
          }
          if (key) state.imageCache.set(key, enc);
        } catch { stats.failed += 1; continue; }
      }
      found.push({ kind: 'img', bytes: enc.bytes, ext: enc.ext, box, z: ev.i });
    }
  }
  return { images: found, stats };
}

// Images are anchored absolutely on the page (behind the text); they cost the
// text flow nothing. A searchable scan's full-page picture is dropped: its
// words are the content, and the picture would double them.
export function imageAnchors(ctx) {
  const W = ctx.widthPt;
  const H = ctx.heightPt;
  const kind = ctx.kind;
  const anchors = [];
  let dropped = 0;
  for (const im of ctx.images || []) {
    const b = im.box;
    const area = (b.x1 - b.x0) * (b.y1 - b.y0);
    if ((kind === 'searchable-scan' || kind === 'ocr-scan') && area > W * H * 0.8) { dropped += 1; continue; }
    // clip to the page: art that spills far off the page is cropped, not shipped whole
    const vx0 = Math.max(0, b.x0); const vy0 = Math.max(0, b.y0);
    const vx1 = Math.min(W, b.x1); const vy1 = Math.min(H, b.y1);
    if (vx1 - vx0 < 2 || vy1 - vy0 < 2) { dropped += 1; continue; }
    const w = b.x1 - b.x0; const h = b.y1 - b.y0;
    anchors.push({
      kind: 'img', anchor: { x: vx0, y: vy0 }, bytes: im.bytes, ext: im.ext, wPt: vx1 - vx0, hPt: vy1 - vy0, z: im.z,
      crop: vx0 !== b.x0 || vy0 !== b.y0 || vx1 !== b.x1 || vy1 !== b.y1 ? { l: (vx0 - b.x0) / w, t: (vy0 - b.y0) / h, r: (b.x1 - vx1) / w, b: (b.y1 - vy1) / h } : null,
    });
  }
  return { anchors, dropped };
}
