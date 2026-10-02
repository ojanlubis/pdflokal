/*
 * PDFLokal — docx/images.js  (IMAGES: find, paint as the page shows them, encode, place)   [lane owns this file]
 * ============================================================================
 * THE INTERFACE
 *
 *   extractImages(ctx) -> { images, stats }                       (async)
 *       Finds every raster paint on the page (ops.walkOps) and returns it as the pixels the
 *       page SHOWS, not the raw stream:
 *         images: [{ kind:'img', bytes, ext:'png'|'jpeg', box:{x0,y0,x1,y1} (page pt), z: op index,
 *                    clip?: {x0,y0,x1,y1} an upright rectangle the PDF clipped the picture with (plain only),
 *                    painted?: true }]
 *         stats:  { masks, failed, plain, painted, paintedFailed, maskSources, hidden }
 *       Two paths, chosen per paint by planPaint():
 *         PLAIN    an opaque raster placed upright, un-clipped or clipped by an upright rectangle (a cut
 *                  becomes a Word crop, so the picture stays exact), with no soft mask, alpha, or blend mode in force: decode the pdf.js
 *                  image, box-average it down to <= 150 dpi at its placed size, encode (canvas JPEG when
 *                  opaque / PNG when it carries alpha in a browser; the headless PNG encoder in node
 *                  without a canvas). Cached per image id across pages.
 *         PAINTED  everything else (stencil masks, a soft mask / gstate alpha / blend, a clip that
 *                  is not an upright rectangle, rotation or a flip, repeated placements):
 *                  pdf.js itself paints it. The page's operator list is rendered onto a transparent
 *                  canvas of just the visible region with every other painting operator blanked
 *                  (renderPainted), so the clip, SMask, stencil colour, alpha and transform are pdf.js's
 *                  own, and nothing else (text, vector art, the picture next to it) is baked in. The
 *                  result is JPEG when every pixel is opaque (PNG when it is flat artwork), PNG when any
 *                  pixel is not, trimmed to the pixels that were painted.
 *       Soft-mask SOURCE images (the greyscale stream a soft mask reads) paint nothing themselves:
 *       they are skipped, which is what removed the black boxes. Painting needs a canvas
 *       (canvaskit.js); without one PLAIN still runs, painted-only content is skipped (stats.masks).
 *
 *   imageAnchors(ctx) -> { anchors, dropped }
 *       The placement POLICY: which ctx.images become Page.anchors (absolute, behind
 *       the text, clipped to the page) and which are dropped (a searchable scan's
 *       full-page picture would double its own words). Each anchor carries `z` so
 *       convert.js can interleave them with colour shapes in paint order.
 *
 *   scanPaints(pdfjs, ops, vp) -> Paint[]      pure, canvas-free; exported for the tests and the survey
 *   planPaint(paint, W, H) -> 'plain'|'painted'|'skip'
 *
 * WHY THE RENDER IS FILTERED IN PLACE (pdf.js 3.11, the vendored build): page.render() has no operation
 * filter, and it renders from its OWN operator list (not the one getOperatorList() returns). renderPainted
 * lets render() start, holds execution on `optionalContentConfigPromise` (a public param) until the
 * list has fully arrived, rewrites that list's fnArray in place from a pristine copy, then releases it.
 * The only private access is `page._intentStates`; if it or the list's shape is not as expected the
 * paint is reported as failed and the plain path takes over. That cost is one extra parse of the page,
 * paid only by pages that have a painted image.
 */

import { encodePng } from './png.js';
import { walkOps } from './ops.js';
import { defaultKit } from './canvaskit.js';

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

// Decoded pixels (no bitmap: node, or a pdf.js that hands back a buffer) through the kit's canvas: JPEG when opaque,
// PNG when any pixel is translucent. Keeps the node gate's picture bytes in step with what a browser ships.
async function encodePixels(kit, d) {
  const { canvas, context } = kit.create(d.w, d.h);
  const im = context.createImageData(d.w, d.h);
  const o = im.data;
  let alpha = false;
  for (let i = 0, n = d.w * d.h; i < n; i += 1) {
    if (d.ch === 4) { o[i * 4] = d.px[i * 4]; o[i * 4 + 1] = d.px[i * 4 + 1]; o[i * 4 + 2] = d.px[i * 4 + 2]; o[i * 4 + 3] = d.px[i * 4 + 3]; if (d.px[i * 4 + 3] < 250) alpha = true; } else if (d.ch === 3) { o[i * 4] = d.px[i * 3]; o[i * 4 + 1] = d.px[i * 3 + 1]; o[i * 4 + 2] = d.px[i * 3 + 2]; o[i * 4 + 3] = 255; } else { o[i * 4] = o[i * 4 + 1] = o[i * 4 + 2] = d.px[i]; o[i * 4 + 3] = 255; }
  }
  context.putImageData(im, 0, 0);
  const bytes = await kit.encode(canvas, alpha ? 'png' : 'jpeg', 0.85);
  canvas.width = 0;
  return { bytes, ext: alpha ? 'png' : 'jpeg' };
}

// ===================================================================== SCAN ====
// One walk of the operator list: every raster paint with the graphics state it is painted under.
// Pure (no canvas, no objects), so tests and the corpus survey can run it on a synthetic list.

const IDENT = [1, 0, 0, 1, 0, 0];

const boxOfPoints = (pts) => {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return { x0, y0, x1, y1 };
};
const intersectBox = (a, b) => ({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
const unionBox = (a, b) => (a ? { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) } : b);
// A matrix that keeps rectangles rectangles (no rotation or skew; a quarter turn is fine).
const keepsRects = (m) => (Math.abs(m[1]) < 1e-3 && Math.abs(m[2]) < 1e-3) || (Math.abs(m[0]) < 1e-3 && Math.abs(m[3]) < 1e-3);

function boxOfMatrix(pdfjs, m) {
  return boxOfPoints([[0, 0], [1, 0], [0, 1], [1, 1]].map((p) => pdfjs.Util.applyTransform(p, m)));
}

// Every coordinate pair a constructPath draws through (rectangle: its two corners; curves: control points too), or null
// when an opcode is not understood. Control points make the box a safe overestimate for a curve.
function pathPoints(OPS, pops, pargs) {
  const pts = [];
  let k = 0;
  for (const op of pops) {
    if (op === OPS.moveTo || op === OPS.lineTo) { pts.push([pargs[k], pargs[k + 1]]); k += 2; } else if (op === OPS.curveTo) { for (let j = 0; j < 6; j += 2) pts.push([pargs[k + j], pargs[k + j + 1]]); k += 6; } else if (op === OPS.curveTo2 || op === OPS.curveTo3) { for (let j = 0; j < 4; j += 2) pts.push([pargs[k + j], pargs[k + j + 1]]); k += 4; } else if (op === OPS.rectangle) {
      pts.push([pargs[k], pargs[k + 1]], [pargs[k] + pargs[k + 2], pargs[k + 1] + pargs[k + 3]]);
      k += 4;
    } else if (op !== OPS.closePath) return null;
  }
  return pts.length ? pts : null;
}

// constructPath arguments are [opcodes, coordinates, [minX, maxX, minY, maxY]].
function isRectPath(OPS, pops, pargs) {
  if (pops.length === 1 && pops[0] === OPS.rectangle) return true;
  const pts = [];
  let k = 0;
  for (const op of pops) {
    if (op === OPS.moveTo || op === OPS.lineTo) { pts.push([pargs[k], pargs[k + 1]]); k += 2; } else if (op === OPS.closePath) { /* implicit edge back to the start */ } else return false;
  }
  if (pts.length === 5 && pts[4][0] === pts[0][0] && pts[4][1] === pts[0][1]) pts.pop();
  if (pts.length !== 4) return false;
  for (let i = 0; i < 4; i += 1) {
    const a = pts[i]; const b = pts[(i + 1) % 4];
    if (a[0] !== b[0] && a[1] !== b[1]) return false;
  }
  return true;
}

// The operator-list shape of every raster paint variant -> the page-space matrices it paints with.
function placementMatrices(pdfjs, OPS, fn, args, m) {
  const mul = (a, b) => pdfjs.Util.transform(a, b);
  if (fn === OPS.paintImageXObjectRepeat) {
    const out = [];
    for (let k = 0; k + 1 < args[3].length; k += 2) out.push(mul(m, [args[1], 0, 0, args[2], args[3][k], args[3][k + 1]]));
    return out;
  }
  if (fn === OPS.paintImageMaskXObjectRepeat) {
    const out = [];
    for (let k = 0; k + 1 < args[5].length; k += 2) out.push(mul(m, [args[1], args[2], args[3], args[4], args[5][k], args[5][k + 1]]));
    return out;
  }
  if (fn === OPS.paintImageMaskXObjectGroup) return (args[0] || []).map((im) => mul(m, im.transform || IDENT));
  if (fn === OPS.paintInlineImageXObjectGroup) return (args[1] || []).map((e) => mul(m, e.transform || IDENT));
  return [m];
}

export function scanPaints(pdfjs, ops, vp) {
  const { OPS } = pdfjs;
  const mul = (a, b) => pdfjs.Util.transform(a, b);
  const paints = [];
  const n = ops.fnArray.length;
  const maskOps = new Uint8Array(n); // 1 = this op is inside a soft-mask definition group
  const root = { ca: 1, sm: false, bm: false, gEff: false, clip: null, exact: true, mask: false };
  const frames = [root];
  const top = () => frames[frames.length - 1];
  const push = (over) => frames.push({ ...top(), ...over });
  const pop = () => { if (frames.length > 1) frames.pop(); };
  const eff = (f) => f.gEff || f.sm || f.bm || f.ca < 0.999;
  const clipTo = (f, box, exactRect) => { f.clip = f.clip ? intersectBox(f.clip, box) : box; f.exact = f.exact && exactRect; };
  let path = null;
  for (const ev of walkOps(pdfjs, ops)) {
    const { fn, args } = ev;
    const f = top();
    if (f.mask) maskOps[ev.i] = 1;
    if (fn === OPS.save) push({});
    else if (fn === OPS.restore) pop();
    else if (fn === OPS.paintFormXObjectBegin) {
      push({});
      if (args && args[1]) {
        const m2 = mul(vp.transform, mul(ev.ctm, args[0] || IDENT));
        const b = args[1];
        clipTo(top(), boxOfPoints([[b[0], b[1]], [b[2], b[1]], [b[0], b[3]], [b[2], b[3]]].map((p) => pdfjs.Util.applyTransform(p, m2))), keepsRects(m2));
      }
    } else if (fn === OPS.paintFormXObjectEnd) pop();
    else if (fn === OPS.beginGroup) {
      const g = args && args[0];
      push({ gEff: eff(f), ca: 1, sm: false, bm: false, mask: f.mask || !!(g && g.smask) });
    } else if (fn === OPS.endGroup) pop();
    else if (fn === OPS.constructPath) {
      const m = mul(vp.transform, ev.ctm);
      // pdf.js's own min/max (args[2]) is only the start point for a path made of curves (measured on n084: a circle
      // clip came back as one point), so the box is taken from the coordinates themselves, control points included.
      const pts = pathPoints(OPS, args[0], args[1]);
      path = pts
        ? { box: boxOfPoints(pts.map((p) => pdfjs.Util.applyTransform(p, m))), rect: keepsRects(m) && isRectPath(OPS, args[0], args[1]) }
        : { box: null, rect: false };
    } else if (fn === OPS.clip || fn === OPS.eoClip) {
      if (path && path.box) clipTo(f, path.box, path.rect); else f.exact = false;
    } else if (fn === OPS.endPath || fn === OPS.fill || fn === OPS.eoFill || fn === OPS.stroke || fn === OPS.closeStroke
      || fn === OPS.fillStroke || fn === OPS.eoFillStroke || fn === OPS.closeFillStroke || fn === OPS.closeEOFillStroke) path = null;
    else if (fn === OPS.setGState) {
      for (const [k, v] of args[0] || []) {
        if (k === 'ca') f.ca = Number(v);
        else if (k === 'SMask') f.sm = !!v;
        else if (k === 'BM') { const bm = Array.isArray(v) ? v[0] : v; f.bm = !!bm && !/^(source-over|normal|compatible)$/i.test(String(bm)); }
      }
    } else {
      let kind = null;
      if (fn === OPS.paintImageXObject) kind = 'xobj';
      else if (fn === OPS.paintInlineImageXObject) kind = 'inline';
      else if (fn === OPS.paintImageMaskXObject) kind = 'mask';
      else if (fn === OPS.paintImageXObjectRepeat || fn === OPS.paintImageMaskXObjectRepeat || fn === OPS.paintImageMaskXObjectGroup || fn === OPS.paintInlineImageXObjectGroup) kind = 'multi';
      if (kind) {
        const m = mul(vp.transform, ev.ctm);
        let box = null;
        for (const pm of placementMatrices(pdfjs, OPS, fn, args, m)) box = unionBox(box, boxOfMatrix(pdfjs, pm));
        if (box) {
          const src = kind === 'xobj' ? { w: args[1], h: args[2] } : kind === 'inline' || kind === 'mask' ? { w: args[0] && args[0].width, h: args[0] && args[0].height } : {};
          paints.push({ i: ev.i, fn, kind, args, m, box, srcW: src.w, srcH: src.h, clip: f.clip ? { ...f.clip } : null, exact: f.exact, effect: eff(f), ca: f.ca, hardFx: f.sm || f.bm || f.gEff, inMask: f.mask });
        }
      }
    }
  }
  paints.maskOps = maskOps;
  return paints;
}

// What to do with one paint on a W x H page.
export function visibleBox(p, W, H) {
  let v = intersectBox(p.box, { x0: 0, y0: 0, x1: W, y1: H });
  if (p.clip) v = intersectBox(v, p.clip);
  return v.x1 > v.x0 && v.y1 > v.y0 ? v : null;
}

export function planPaint(p, W, H) {
  if (p.inMask) return 'skip'; // a soft mask's source: it paints nothing on its own
  const vis = visibleBox(p, W, H);
  if (!vis) return 'skip';
  const plainShape = p.kind === 'xobj' || p.kind === 'inline';
  if (plainShape && (p.box.x1 - p.box.x0 < 4 || p.box.y1 - p.box.y0 < 4)) return 'skip';
  if (!plainShape) return vis.x1 - vis.x0 < 3 || vis.y1 - vis.y0 < 3 ? 'skip' : 'painted';
  if (p.effect) return 'painted';
  const m = p.m;
  if (!(m[0] > 0 && m[3] < 0 && Math.abs(m[1]) < 0.5 && Math.abs(m[2]) < 0.5)) return 'painted'; // rotated or flipped
  if (p.clip && !p.exact) return 'painted'; // a round or ragged clip
  return 'plain'; // an upright rectangular clip that cuts the picture is a crop (imageAnchors applies it), not a render
}

// ================================================================== PAINTED ====

const PATH_PAINTERS = (OPS) => new Set([OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
const OTHER_PAINTERS = (OPS) => new Set([
  OPS.shadingFill, OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText, OPS.setFont,
  OPS.paintImageMaskXObject, OPS.paintImageMaskXObjectGroup, OPS.paintImageMaskXObjectRepeat, OPS.paintImageXObject, OPS.paintImageXObjectRepeat,
  OPS.paintInlineImageXObject, OPS.paintInlineImageXObjectGroup, OPS.paintSolidColorImageMask, OPS.paintXObject]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PRISTINE = new WeakMap(); // render-intent operator list -> { fn, args, ok }

// pdf.js steps a render through requestAnimationFrame on the main thread, which a background tab
// never fires: a conversion would stall until the user came back. Offscreen painting does not need vsync.
async function withTimerFrames(fn) {
  const w = globalThis.window;
  if (!w || typeof w.requestAnimationFrame !== 'function') return fn();
  const raf = w.requestAnimationFrame;
  w.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  try { return await fn(); } finally { w.requestAnimationFrame = raf; }
}

function renderIntentState(page) {
  const states = page && page._intentStates;
  if (!states || typeof states.values !== 'function') return null;
  for (const st of states.values()) if (st && st.displayReadyCapability && st.operatorList) return st;
  return null;
}

// Put the page's render list back as pdf.js built it, so a later render of the same page (nothing in the engine does
// one today) paints everything again.
function restoreList(page) {
  const st = renderIntentState(page);
  const orig = st && PRISTINE.get(st.operatorList);
  if (!orig || !orig.ok) return;
  for (let i = 0; i < orig.fn.length; i += 1) { st.operatorList.fnArray[i] = orig.fn[i]; st.operatorList.argsArray[i] = orig.args[i]; }
}

// Rewrite pdf.js's render-intent operator list so that only `target` (and any soft-mask definition) paints.
function filterList(OPS, list, orig, maskOps, target) {
  const pathPainters = PATH_PAINTERS(OPS);
  const otherPainters = OTHER_PAINTERS(OPS);
  const targetId = orig.args[target] && typeof orig.args[target][0] === 'string' ? orig.args[target][0] : null;
  const n = orig.fn.length;
  for (let i = 0; i < n; i += 1) {
    const f = orig.fn[i];
    if (i === target || maskOps[i]) { list.fnArray[i] = f; list.argsArray[i] = orig.args[i]; continue; }
    if (f === OPS.dependency) {
      // the one that waits for the target's own pixels stays; the rest would only block on images nobody paints
      const keep = targetId && Array.isArray(orig.args[i]) && orig.args[i].includes(targetId);
      list.fnArray[i] = f; list.argsArray[i] = keep ? orig.args[i] : [];
    } else if (pathPainters.has(f)) { list.fnArray[i] = OPS.endPath; list.argsArray[i] = null; } // consumes the path and any pending clip, paints nothing
    else if (otherPainters.has(f)) { list.fnArray[i] = OPS.dependency; list.argsArray[i] = []; } else if (f === OPS.setGState) {
      list.fnArray[i] = f;
      list.argsArray[i] = [(orig.args[i][0] || []).filter((e) => e[0] !== 'Font')]; // a /Font entry would demand a font nobody loaded
    } else { list.fnArray[i] = f; list.argsArray[i] = orig.args[i]; }
  }
}

const FLAT_SAMPLES = 1500;
const FLAT_COLOURS = 24;

// Render paint `p`, alone, into a transparent canvas covering `region`; trim, encode. null = nothing visible.
async function renderPainted(ctx, kit, paints, p, region, s) {
  const { page, pdfjs, shared } = ctx;
  const { OPS } = pdfjs;
  const pdf = shared && shared.pdf;
  if (!pdf || typeof pdf.getOptionalContentConfig !== 'function') throw new Error('no document handle for painting');
  const w = Math.max(1, Math.ceil((region.x1 - region.x0) * s));
  const h = Math.max(1, Math.ceil((region.y1 - region.y0) * s));
  const cc = kit.create(w, h);
  let release;
  const gate = new Promise((r) => { release = r; });
  const occ = pdf.getOptionalContentConfig();
  const task = page.render({
    canvasContext: cc.context,
    viewport: page.getViewport({ scale: s }),
    transform: [1, 0, 0, 1, -region.x0 * s, -region.y0 * s],
    background: 'rgba(0,0,0,0)',
    annotationMode: pdfjs.AnnotationMode.DISABLE,
    optionalContentConfigPromise: gate,
  });
  const done = task.promise.then(() => null, (e) => e || new Error('render failed'));
  try {
    const st = renderIntentState(page);
    if (!st) throw new Error('render state not found');
    const list = st.operatorList;
    const deadline = Date.now() + 20000;
    while (!list.lastChunk) {
      if (Date.now() > deadline) throw new Error('operator list never completed');
      await sleep(0);
    }
    let orig = PRISTINE.get(list);
    if (!orig) {
      orig = { fn: list.fnArray.slice(), args: list.argsArray.slice(), ok: false };
      // The render list must be the page's own list op for op, or a paint's index means something else.
      const mine = ctx.ops.fnArray;
      orig.ok = orig.fn.length <= mine.length && orig.fn.every((f, i) => f === mine[i]);
      PRISTINE.set(list, orig);
    }
    if (!orig.ok) throw new Error('render list differs from the page list');
    filterList(OPS, list, orig, paints.maskOps, p.i);
    release(occ);
    let timer;
    const timeout = new Promise((r) => { timer = setTimeout(() => r(new Error('render timed out')), 20000); });
    const err = await withTimerFrames(() => Promise.race([done, timeout])).finally(() => clearTimeout(timer)); // a live timer would hold a node process open
    if (err) { try { task.cancel(); } catch { /* already done */ } throw err; }
  } catch (e) {
    release(occ);
    try { task.cancel(); } catch { /* already done */ }
    cc.canvas.width = 0;
    throw e;
  }
  return finishCanvas(kit, cc, w, h, region, s);
}

async function finishCanvas(kit, cc, w, h, region, s) {
  const d = cc.context.getImageData(0, 0, w, h).data;
  let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
  for (let y = 0; y < h; y += 1) {
    let row = y * w * 4 + 3;
    for (let x = 0; x < w; x += 1, row += 4) {
      if (d[row] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  if (x1 < 0) { cc.canvas.width = 0; return null; } // painted nothing
  x1 += 1; y1 += 1;
  const bw = x1 - x0; const bh = y1 - y0;
  let alpha = false;
  const seen = new Set();
  const stride = Math.max(1, Math.floor((bw * bh) / FLAT_SAMPLES));
  for (let y = y0; y < y1 && !alpha; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const o = (y * w + x) * 4;
      if (d[o + 3] < 250) { alpha = true; break; }
      if (((y - y0) * bw + (x - x0)) % stride === 0 && seen.size <= FLAT_COLOURS) seen.add(((d[o] >> 4) << 8) | ((d[o + 1] >> 4) << 4) | (d[o + 2] >> 4));
    }
  }
  let canvas = cc.canvas;
  let trimmed = null;
  if (bw < w * 0.9 || bh < h * 0.9) {
    trimmed = kit.create(bw, bh);
    trimmed.context.drawImage(cc.canvas, x0, y0, bw, bh, 0, 0, bw, bh);
    canvas = trimmed.canvas;
  }
  // opaque photos and scans -> JPEG; transparency or flat artwork (a logo, a screenshot) -> PNG
  const png = alpha || seen.size <= FLAT_COLOURS;
  const bytes = await kit.encode(canvas, png ? 'png' : 'jpeg', 0.85);
  cc.canvas.width = 0;
  if (trimmed) trimmed.canvas.width = 0;
  const box = {
    x0: region.x0 + x0 / s, y0: region.y0 + y0 / s,
    x1: Math.min(region.x1, region.x0 + x1 / s), y1: Math.min(region.y1, region.y0 + y1 / s),
  };
  return { bytes, ext: png ? 'png' : 'jpeg', box };
}

function paintScale(p, vis) {
  const placedW = Math.hypot(p.m[0], p.m[1]);
  const perPt = p.srcW && placedW > 0 ? p.srcW / placedW : 150 / 72;
  let s = Math.min(150 / 72, Math.max(1, perPt));
  const px = (vis.x1 - vis.x0) * (vis.y1 - vis.y0) * s * s;
  if (px > 16e6) s *= Math.sqrt(16e6 / px);
  return s;
}

// ================================================================== EXTRACT ====

export async function extractImages(ctx) {
  const { pdfjs, page, ops, vp } = ctx;
  const state = ctx.shared;
  const { OPS } = pdfjs;
  const kit = defaultKit(ctx.options);
  const found = [];
  const stats = { masks: 0, failed: 0, plain: 0, painted: 0, paintedFailed: 0, maskSources: 0, hidden: 0 };
  const paints = scanPaints(pdfjs, ops, vp);
  for (const p of paints) {
    const plan = planPaint(p, ctx.widthPt, ctx.heightPt);
    if (plan === 'skip') { if (p.inMask) stats.maskSources += 1; else stats.hidden += 1; continue; }
    if (plan === 'painted') {
      if (kit) {
        const vis = visibleBox(p, ctx.widthPt, ctx.heightPt);
        // The same picture placed the same way (a footer, a logo, a page ornament) paints the same pixels on every
        // page: render once. Only when nothing but opacity varies (a soft mask or blend is not part of the key).
        const r2 = (n) => Math.round(n * 100) / 100;
        const pkey = p.fn === OPS.paintImageXObject && !p.hardFx && typeof p.args[0] === 'string'
          ? `P|${p.args[0]}|${p.m.map(r2)}|${vis.x0},${vis.y0},${vis.x1},${vis.y1}|${ctx.widthPt}x${ctx.heightPt}|${p.ca}|${p.clip ? `${p.exact}` : ''}` : null;
        try {
          let r = pkey ? state.imageCache.get(pkey) : undefined;
          if (r === undefined) {
            r = await renderPainted(ctx, kit, paints, p, vis, paintScale(p, vis));
            if (pkey) state.imageCache.set(pkey, r);
          }
          if (!r) stats.hidden += 1;
          else { found.push({ kind: 'img', bytes: r.bytes, ext: r.ext, box: r.box, z: p.i, painted: true }); stats.painted += 1; }
          continue;
        } catch { stats.paintedFailed += 1; }
      }
      // no canvas, or the render failed: a plain picture is still better than none; a stencil or a repeat has nothing to fall back on
      if (p.kind !== 'xobj' && p.kind !== 'inline') { stats.masks += 1; continue; }
    }
    const { fn, args } = p;
    const box = p.box;
    const id = fn === OPS.paintInlineImageXObject ? null : args[0];
    const key = id && `${ctx.pageNumber}:${id}`;
    const gkey = id && String(id).startsWith('g_') ? String(id) : null;
    let enc = (gkey && state.imageCache.get(gkey)) || (key && state.imageCache.get(key));
    if (!enc) {
      try {
        let img;
        if (fn === OPS.paintInlineImageXObject) img = args[0];
        else img = await new Promise((resolve, reject) => {
          const pool = String(id).startsWith('g_') ? page.commonObjs : page.objs;
          const timer = setTimeout(() => reject(new Error('image not resolved')), 4000);
          pool.get(id, (o) => { clearTimeout(timer); resolve(o); });
        });
        const maxW = Math.max(16, Math.ceil(((box.x1 - box.x0) * 150) / 72));
        if (img && img.bitmap && typeof globalThis.OffscreenCanvas !== 'undefined') {
          enc = await encodeBitmap(img.bitmap, maxW);
        } else {
          const px = img && expandToPixels(img);
          if (!px) throw new Error('unreadable image');
          const d = downscale(px, maxW);
          // a 1-bit image (kind 1) is line art: PNG stays exact and tiny; photos and scans take the canvas JPEG
          enc = kit && d.ch !== 1 ? await encodePixels(kit, d) : { bytes: encodePng(state.fflate, d.w, d.h, d.ch, d.px), ext: 'png' };
        }
        const ck = gkey || key;
        if (ck) state.imageCache.set(ck, enc);
      } catch { stats.failed += 1; continue; }
    }
    stats.plain += 1;
    found.push({ kind: 'img', bytes: enc.bytes, ext: enc.ext, box, z: p.i, clip: p.clip && p.exact ? { ...p.clip } : null });
  }
  if (stats.painted || stats.paintedFailed) restoreList(page);
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
    // clip to the page (art that spills far off the page is cropped, not shipped whole) and to the rectangle
    // the PDF clipped the picture with, when it did (`clip`: a plain picture; painted ones are already cut)
    const c = im.clip;
    const vx0 = Math.max(0, b.x0, c ? c.x0 : -Infinity); const vy0 = Math.max(0, b.y0, c ? c.y0 : -Infinity);
    const vx1 = Math.min(W, b.x1, c ? c.x1 : Infinity); const vy1 = Math.min(H, b.y1, c ? c.y1 : Infinity);
    if (vx1 - vx0 < 2 || vy1 - vy0 < 2) { dropped += 1; continue; }
    const w = b.x1 - b.x0; const h = b.y1 - b.y0;
    anchors.push({
      kind: 'img', anchor: { x: vx0, y: vy0 }, bytes: im.bytes, ext: im.ext, wPt: vx1 - vx0, hPt: vy1 - vy0, z: im.z,
      crop: vx0 !== b.x0 || vy0 !== b.y0 || vx1 !== b.x1 || vy1 !== b.y1 ? { l: (vx0 - b.x0) / w, t: (vy0 - b.y0) / h, r: (b.x1 - vx1) / w, b: (b.y1 - vy1) / h } : null,
    });
  }
  return { anchors, dropped };
}
