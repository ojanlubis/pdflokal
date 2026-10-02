/*
 * PDFLokal — docx/color.js  (COLOUR: text colour, highlights, fills, backgrounds, vector shapes)
 * ============================================================================
 * THE INTERFACE (decided by the foundation; this file is the body)
 *
 *   analyzeColor(ctx) -> ColorInfo        (async: it resolves gradient patterns)
 *
 *     Called once per page after extract.readPage / images / OCR (so ctx.runs is final)
 *     and BEFORE groupLines, tables and layout. pdf.js gives no colour on a text item and
 *     no operator index: getTextContent() items carry only str/transform/font. So this
 *     module REPLAYS the operator list (ops.walkOps tracks the CTM; the graphics state,
 *     the clip, the path and the text matrix are tracked here) and matches what it saw
 *     to ctx.runs BY GEOMETRY (run.pdf.x0/y0 are item.transform[4..5], content-stream frame).
 *
 *     It does three things:
 *       1. Sets `run.color = 'RRGGBB' | null` (null = Word's default; plain black stays null)
 *          and `run.bg` for a tight highlight. A run pdf.js merged across a colour change is
 *          SPLIT in two so each half keeps its own colour.
 *       2. Returns `fillAt(x0, y0, x1, y1) -> 'RRGGBB' | null`: the solid fill painted behind
 *          that page rectangle (alpha composited over what is beneath; tables use it for cell
 *          shading). null = nothing, or plain white page.
 *       3. Returns `anchors: Anchor[]` (kind 'shape', see shapeXml below): page backgrounds,
 *          filled rectangles and polygons, rounded rects, gradients, rules and lines, all
 *          BEHIND the text, each with z = its operator index so convert.js interleaves them
 *          with pictures in paint order. `anchors` is a GETTER evaluated after detectTables, so
 *          a rule that the table lane already draws as a Word border is not drawn twice.
 *
 *     ColorInfo = { fillAt, anchors, background: 'RRGGBB'|null, stats }
 *
 * THE RULE (the spike's finding): colour and background travel together or not at all.
 *   White text whose dark background we did not draw would vanish: such a run falls back to
 *   the default colour. And a run whose colour we could not resolve, on a dark background we
 *   DID draw, becomes white. See `contrastGuard`.
 *
 * WHAT IS DRAWN NATIVELY (DrawingML, no raster): rectangles, any polygon or Bezier path
 *   (a:custGeom), axis-aligned rules (as thin filled rectangles: the one form every renderer
 *   draws exactly), other strokes (a:ln with dash/join), constant alpha, and axial/radial
 *   gradients (a:gradFill) with the stops re-mapped to the shape's extent.
 * WHAT IS NOT (counted in stats, never faked): inside a soft-mask group or under an SMask
 *   (a mask is not expressible: painting it unmasked would be wrong), tiling-pattern fills
 *   (n029's repeated picture lives in a nested operator list), mesh shadings.
 *   A raster fallback for such regions would need a canvas; there is none in node, so the
 *   hook is `ctx.options.rasterize` (see rasterRegions at the bottom): absent = those
 *   regions are simply not drawn.
 */

import { registerAnchor } from './writer.js';
import { walkOps } from './ops.js';
import { canRasterize, rasterizeRegion } from './raster.js';

// ------------------------------------------------------------- small maths ---
const HEX6 = /^[0-9a-f]{6}$/i;
const toHex2 = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
const rgbHex = (a) => `${toHex2(a[0])}${toHex2(a[1])}${toHex2(a[2])}`.toUpperCase();
const lum = (hex) => {
  const c = [0, 2, 4].map((k) => parseInt(hex.slice(k, k + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => { const la = lum(a); const lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
const isWhite = (hex) => hex && lum(hex) > 0.93; // F8F8F8 and lighter
const mixHex = (top, under, a) => {
  const t = [0, 2, 4].map((k) => parseInt(top.slice(k, k + 2), 16));
  const u = [0, 2, 4].map((k) => parseInt(under.slice(k, k + 2), 16));
  return rgbHex(t.map((v, k) => v * a + u[k] * (1 - a)));
};
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

const EMPTY_BOX = [Infinity, Infinity, -Infinity, -Infinity];
const grow = (b, x, y) => { if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y; };
const inter = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
const empty = (b) => !(b[2] > b[0] && b[3] > b[1]);
const area = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const within = (inner, outer, tol) => inner[0] >= outer[0] - tol && inner[1] >= outer[1] - tol && inner[2] <= outer[2] + tol && inner[3] <= outer[3] + tol;

// ----------------------------------------------------------------- paths ----
// A path is cmds in PAGE points: ['M',x,y] ['L',x,y] ['C',x1,y1,x2,y2,x,y] ['Z'].
function pathBox(cmds) {
  const b = EMPTY_BOX.slice();
  for (const c of cmds) for (let k = 1; k < c.length; k += 2) grow(b, c[k], c[k + 1]);
  return b;
}

// Is this path exactly one axis-aligned rectangle (after the page transform)?
function rectOf(cmds) {
  const pts = [];
  for (const c of cmds) {
    if (c[0] === 'C') return null;
    if (c[0] === 'Z') continue;
    if (c[0] === 'M' && pts.length) return null;
    pts.push([c[1], c[2]]);
  }
  if (pts.length === 5 && Math.abs(pts[4][0] - pts[0][0]) < 1e-3 && Math.abs(pts[4][1] - pts[0][1]) < 1e-3) pts.pop();
  if (pts.length !== 4) return null;
  const e = 1e-3;
  const hv = Math.abs(pts[0][1] - pts[1][1]) < e && Math.abs(pts[1][0] - pts[2][0]) < e && Math.abs(pts[2][1] - pts[3][1]) < e && Math.abs(pts[3][0] - pts[0][0]) < e;
  const vh = Math.abs(pts[0][0] - pts[1][0]) < e && Math.abs(pts[1][1] - pts[2][1]) < e && Math.abs(pts[2][0] - pts[3][0]) < e && Math.abs(pts[3][1] - pts[0][1]) < e;
  if (!hv && !vh) return null;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

const rectCmds = (b) => [['M', b[0], b[1]], ['L', b[2], b[1]], ['L', b[2], b[3]], ['L', b[0], b[3]], ['Z']];

// Curves -> short polylines, as FLAT subpaths [x0,y0,x1,y1,...] (one number array per M..., not an array per point:
// MEASURED 2026-10-02 on n057, the pair-per-vertex form allocated 2.8 GB in clip/flatten/simplify alone and put the
// converter's peak RSS 300 MB over the baseline). Only used where a path must be clipped or point-tested.
function polysOf(cmds, n = 8) {
  const subs = [];
  let cur = null;
  let cx = 0; let cy = 0; let sx = 0; let sy = 0;
  for (const c of cmds) {
    if (c[0] === 'M') { cur = [c[1], c[2]]; subs.push(cur); cx = sx = c[1]; cy = sy = c[2]; }
    else if (c[0] === 'L') { if (cur) cur.push(c[1], c[2]); cx = c[1]; cy = c[2]; }
    else if (c[0] === 'C') {
      for (let k = 1; k <= n; k += 1) {
        const t = k / n; const u = 1 - t;
        const x = u * u * u * cx + 3 * u * u * t * c[1] + 3 * u * t * t * c[3] + t * t * t * c[5];
        const y = u * u * u * cy + 3 * u * u * t * c[2] + 3 * u * t * t * c[4] + t * t * t * c[6];
        if (cur) cur.push(x, y);
      }
      cx = c[5]; cy = c[6];
    } else { cx = sx; cy = sy; }
  }
  return subs;
}

// Sutherland-Hodgman against an axis-aligned box, per closed subpath. -> cmds ([] = nothing left).
function clipPolys(cmds, box) {
  const out = [];
  const emit = (poly) => { for (let i = 0; i < poly.length; i += 2) out.push([i ? 'L' : 'M', poly[i], poly[i + 1]]); out.push(['Z']); };
  for (let poly of polysOf(cmds)) {
    let inside = true;
    for (let i = 0; i < poly.length && inside; i += 2) if (poly[i] < box[0] || poly[i] > box[2] || poly[i + 1] < box[1] || poly[i + 1] > box[3]) inside = false;
    if (inside) { if (poly.length >= 6) emit(poly); continue; }
    for (let e = 0; e < 4; e += 1) {
      const next = [];
      const len = poly.length;
      const dist = (x, y) => (e === 0 ? x - box[0] : e === 1 ? box[2] - x : e === 2 ? y - box[1] : box[3] - y);
      for (let i = 0; i < len; i += 2) {
        const ax = poly[i]; const ay = poly[i + 1];
        const j = i + 2 < len ? i + 2 : 0;
        const bx = poly[j]; const by = poly[j + 1];
        const da = dist(ax, ay); const db = dist(bx, by);
        if (da >= 0) next.push(ax, ay);
        if ((da >= 0) !== (db >= 0)) { const t = da / (da - db); next.push(ax + (bx - ax) * t, ay + (by - ay) * t); }
      }
      poly = next;
      if (!poly.length) break;
    }
    if (poly.length >= 6) emit(poly);
  }
  return out;
}

function pointInCmds(cmds, px, py) { // even-odd over the flattened outline
  let inside = false;
  for (const poly of polysOf(cmds, 4)) {
    const len = poly.length;
    for (let i = 0; i < len; i += 2) {
      const j = i + 2 < len ? i + 2 : 0;
      const ax = poly[i]; const ay = poly[i + 1]; const bx = poly[j]; const by = poly[j + 1];
      if ((ay > py) !== (by > py) && px < ((bx - ax) * (py - ay)) / (by - ay) + ax) inside = !inside;
    }
  }
  return inside;
}

// Runs of straight segments lose every vertex within `tol` pt of the line between the run's kept ends
// (Douglas-Peucker, iterative: a map outline has 60,000 of them). Curves, closes and moves are kept as they are.
function simplify(cmds, tol = 0.25) {
  const out = [];
  let k = 0;
  while (k < cmds.length) {
    if (cmds[k][0] !== 'L') { out.push(cmds[k]); k += 1; continue; }
    // the run of L's, with the point that precedes it
    const prev = out[out.length - 1];
    const hasPrev = !!prev && prev[0] !== 'Z';
    let e = k;
    while (e < cmds.length && cmds[e][0] === 'L') e += 1;
    const m = e - k + (hasPrev ? 1 : 0);
    const pts = new Float64Array(m * 2);
    let w = 0;
    if (hasPrev) { pts[0] = prev[prev.length - 2]; pts[1] = prev[prev.length - 1]; w = 2; }
    for (let q = k; q < e; q += 1) { pts[w] = cmds[q][1]; pts[w + 1] = cmds[q][2]; w += 2; }
    const keep = new Uint8Array(m);
    keep[0] = 1; keep[m - 1] = 1;
    const stack = [0, m - 1];
    while (stack.length) {
      const b = stack.pop(); const a = stack.pop();
      if (b - a < 2) continue;
      const dx = pts[2 * b] - pts[2 * a]; const dy = pts[2 * b + 1] - pts[2 * a + 1];
      const L = Math.hypot(dx, dy);
      let far = -1; let fd = tol;
      for (let q = a + 1; q < b; q += 1) {
        const d = L < 1e-9 ? Math.hypot(pts[2 * q] - pts[2 * a], pts[2 * q + 1] - pts[2 * a + 1]) : Math.abs((pts[2 * q] - pts[2 * a]) * dy - (pts[2 * q + 1] - pts[2 * a + 1]) * dx) / L;
        if (d > fd) { fd = d; far = q; }
      }
      if (far >= 0) { keep[far] = 1; stack.push(a, far, far, b); }
    }
    for (let q = hasPrev ? 1 : 0; q < m; q += 1) if (keep[q]) out.push(['L', pts[2 * q], pts[2 * q + 1]]);
    k = e;
  }
  return out;
}

// ------------------------------------------------------------ gradients -----
const hexIn = (s) => String(s).replace('#', '').toUpperCase();
function colourAt(stops, t) {
  if (t <= stops[0][0]) return hexIn(stops[0][1]);
  const last = stops[stops.length - 1];
  if (t >= last[0]) return hexIn(last[1]);
  for (let k = 1; k < stops.length; k += 1) {
    if (t <= stops[k][0]) {
      const a = stops[k - 1]; const b = stops[k];
      const f = b[0] === a[0] ? 1 : (t - a[0]) / (b[0] - a[0]);
      return mixHex(hexIn(b[1]), hexIn(a[1]), f);
    }
  }
  return hexIn(last[1]);
}

// pdf.js RadialAxial IR + the matrix that takes its space to PAGE points + the shape's page box
// -> { kind:'linear', ang, stops } | { kind:'radial', cx, cy, stops } | { solid } (all positions 0..100000)
function gradientFor(ir, M, box) {
  const [, type, , rawStops, p0, p1, r0, r1] = ir;
  const stops = (rawStops || []).filter((s) => s && typeof s[1] === 'string' && HEX6.test(hexIn(s[1])));
  if (!stops.length) return null;
  const mid = colourAt(stops, 0.5);
  if (stops.length === 1) return { solid: hexIn(stops[0][1]) };
  const thin = (arr, keep) => {
    if (arr.length <= keep) return arr;
    return Array.from({ length: keep }, (_, k) => arr[Math.round((k * (arr.length - 1)) / (keep - 1))]);
  };
  if (type === 'axial') {
    const P0 = apply(M, p0[0], p0[1]);
    const P1 = apply(M, p1[0], p1[1]);
    const dx = P1[0] - P0[0]; const dy = P1[1] - P0[1];
    const L2 = dx * dx + dy * dy;
    if (L2 < 1e-6) return { solid: mid };
    const corners = [[box[0], box[1]], [box[2], box[1]], [box[0], box[3]], [box[2], box[3]]];
    const ts = corners.map((c) => ((c[0] - P0[0]) * dx + (c[1] - P0[1]) * dy) / L2);
    const tmin = Math.min(...ts); const tmax = Math.max(...ts);
    if (tmax - tmin < 1e-6) return { solid: colourAt(stops, tmin) };
    const pts = [[tmin, colourAt(stops, tmin)]];
    for (const s of stops) if (s[0] > tmin && s[0] < tmax) pts.push([s[0], hexIn(s[1])]);
    pts.push([tmax, colourAt(stops, tmax)]);
    const use = thin(pts, 12).map(([t, c]) => ({ pos: Math.round(((t - tmin) / (tmax - tmin)) * 100000), c }));
    let ang = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (ang < 0) ang += 360;
    return { kind: 'linear', ang: Math.round(ang * 60000), stops: use };
  }
  // radial: the OUTER circle (p1, r1) sets the centre and the reach
  const C = apply(M, p1[0], p1[1]);
  const scale = Math.hypot(M[0], M[1]) || 1;
  const reach = Math.max(1e-6, (r1 || 0) * scale);
  const far = Math.max(...[[box[0], box[1]], [box[2], box[1]], [box[0], box[3]], [box[2], box[3]]].map((c) => Math.hypot(c[0] - C[0], c[1] - C[1])));
  const inner = (r0 || 0) / (r1 || 1);
  const use = thin(stops.map((s) => [inner + (1 - inner) * s[0], hexIn(s[1])]), 12).map(([t, c]) => ({ pos: Math.max(0, Math.min(100000, Math.round(((t * reach) / Math.max(far, reach)) * 100000))), c }));
  if (reach < far) use.push({ pos: 100000, c: use[use.length - 1].c });
  return { kind: 'radial', cx: C[0], cy: C[1], stops: use };
}

// ------------------------------------------------------------ the replay ----
const CLAMP_CELL = 24;

function newState(page) {
  return {
    fill: '000000', fillPat: null, stroke: '000000', strokePat: null, fa: 1, sa: 1, lw: 1, dash: null, join: 0, smaskGroup: 0, maskOn: false, mask: null, grpMask: null,
    clip: [0, 0, page.widthPt, page.heightPt], clipPath: null,
    font: null, size: 0, cs: 0, ws: 0, hs: 1, lead: 0, rise: 0, mode: 0,
  };
}

// Replays ctx.ops. Returns { fills, events, stats }:
//   fills:  paint items {z, cmds, box, rect, eo, fill:{c,a,grad}|null, stroke:{c,w,a,dash,join}|null}
//   events: one per text show {z, ox, oy, ux, uy, str, color|null, hidden}
async function replay(ctx) {
  const { pdfjs, ops, vp } = ctx;
  const { OPS } = pdfjs;
  const mul = (a, b) => pdfjs.Util.transform(a, b);
  const stats = { fills: 0, strokes: 0, gradients: 0, smaskSkipped: 0, tilingSkipped: 0, patternMissing: 0, complexDropped: 0 };
  const items = [];
  const events = [];
  const lost = []; // what we could not draw natively: { z, box (page pt), why }  (the raster hook's work list)
  // gradient objects are resolved asynchronously by name
  const names = new Set();
  const nOps = ops.fnArray.length;
  for (let i = 0; i < nOps; i += 1) {
    const fn = ops.fnArray[i];
    if (fn === OPS.shadingFill) names.add(ops.argsArray[i][0]);
    else if (fn === OPS.setFillColorN && ops.argsArray[i][0] === 'Shading') names.add(ops.argsArray[i][1]);
  }
  const shadings = new Map();
  await Promise.all([...names].map((name) => new Promise((resolve) => {
    let done = false;
    const pool = String(name).startsWith('g_') ? ctx.page.commonObjs : ctx.page.objs;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(); } }, 3000);
    try { pool.get(name, (o) => { if (!done) { done = true; clearTimeout(timer); shadings.set(name, o); resolve(); } }); } catch { clearTimeout(timer); resolve(); }
  })));

  let st = newState(ctx);
  const stack = [];
  const push = () => stack.push({ ...st });
  const pop = () => { if (stack.length) st = stack.pop(); };
  let cur = null; // the path under construction: { cmds (page pt), box }
  let defMask = null; // the luminosity gradient a soft-mask group defines, waiting for `SMask true`
  let pendingClip = false;
  let tm = [1, 0, 0, 1, 0, 0];
  let tlm = [1, 0, 0, 1, 0, 0];
  const fontScale = new Map();
  const fm0 = (name) => {
    if (!fontScale.has(name)) {
      let s = 0.001;
      try { const fo = ctx.page.commonObjs.has(name) ? ctx.page.commonObjs.get(name) : null; if (fo && fo.fontMatrix && fo.fontMatrix[0]) s = fo.fontMatrix[0]; } catch { /* default */ }
      fontScale.set(name, s);
    }
    return fontScale.get(name);
  };
  const colourOfText = () => {
    const m = st.mode & 3;
    if (m === 3) return null;
    if (m === 1) return st.strokePat ? undefined : st.stroke;
    return st.fillPat ? undefined : st.fill; // undefined = a pattern we cannot name
  };

  const showGlyphs = (ev, glyphs) => {
    if (!Array.isArray(glyphs)) return;
    const startTm = tm;
    const o = apply(ev.ctm, ...apply(tm, 0, st.rise));
    let str = '';
    let adv = 0;
    for (const g of glyphs) {
      if (typeof g === 'number') { adv += (-g / 1000) * st.size * st.hs; continue; }
      if (!g || typeof g !== 'object') continue;
      const w0 = (g.width || 0) * fm0(st.font) * st.size; // glyph.width is in glyph units (1/1000 em)
      const w = (w0 + st.cs + (g.isSpace ? st.ws : 0)) * st.hs;
      str += typeof g.unicode === 'string' ? g.unicode : (g.fontChar || '');
      adv += w;
    }
    const d = mul(ev.ctm, startTm);
    const dl = Math.hypot(d[0], d[1]) || 1;
    events.push({ z: ev.i, ox: o[0], oy: o[1], ux: d[0] / dl, uy: d[1] / dl, str, color: colourOfText(), mode: st.mode & 3, adv: adv * dl });
    tm = mul(tm, [1, 0, 0, 1, adv, 0]);
  };
  const moveText = (tx, ty) => { tlm = mul(tlm, [1, 0, 0, 1, tx, ty]); tm = tlm.slice(); };

  const toPage = (ctm) => mul(vp.transform, ctm);

  const buildPath = (ev) => {
    const [codes, co] = ev.args;
    const P = toPage(ev.ctm);
    const cmds = [];
    let k = 0; let cx = 0; let cy = 0; let sx = 0; let sy = 0;
    const pt = (x, y) => apply(P, x, y);
    for (const code of codes) {
      if (code === OPS.moveTo) { const p = pt(co[k], co[k + 1]); cmds.push(['M', p[0], p[1]]); cx = co[k]; cy = co[k + 1]; sx = cx; sy = cy; k += 2; }
      else if (code === OPS.lineTo) { const p = pt(co[k], co[k + 1]); cmds.push(['L', p[0], p[1]]); cx = co[k]; cy = co[k + 1]; k += 2; }
      else if (code === OPS.curveTo) { const a = pt(co[k], co[k + 1]); const b = pt(co[k + 2], co[k + 3]); const c = pt(co[k + 4], co[k + 5]); cmds.push(['C', a[0], a[1], b[0], b[1], c[0], c[1]]); cx = co[k + 4]; cy = co[k + 5]; k += 6; }
      else if (code === OPS.curveTo2) { const a = pt(cx, cy); const b = pt(co[k], co[k + 1]); const c = pt(co[k + 2], co[k + 3]); cmds.push(['C', a[0], a[1], b[0], b[1], c[0], c[1]]); cx = co[k + 2]; cy = co[k + 3]; k += 4; }
      else if (code === OPS.curveTo3) { const a = pt(co[k], co[k + 1]); const c = pt(co[k + 2], co[k + 3]); cmds.push(['C', a[0], a[1], c[0], c[1], c[0], c[1]]); cx = co[k + 2]; cy = co[k + 3]; k += 4; }
      else if (code === OPS.closePath) { cmds.push(['Z']); cx = sx; cy = sy; }
      else if (code === OPS.rectangle) {
        const x = co[k]; const y = co[k + 1]; const w = co[k + 2]; const h = co[k + 3]; k += 4;
        const a = pt(x, y); const b = pt(x + w, y); const c = pt(x + w, y + h); const d = pt(x, y + h);
        cmds.push(['M', a[0], a[1]], ['L', b[0], b[1]], ['L', c[0], c[1]], ['L', d[0], d[1]], ['Z']);
        cx = x; cy = y; sx = x; sy = y;
      }
    }
    // a moveTo straight after a moveTo (pdf-lib and others emit `0 0 m x y m`) replaces it; a trailing lone moveTo paints nothing
    for (let q = cmds.length - 1; q > 0; q -= 1) if (cmds[q][0] === 'M' && cmds[q - 1][0] === 'M') cmds.splice(q - 1, 1);
    while (cmds.length && cmds[cmds.length - 1][0] === 'M') cmds.pop();
    // a trace with tens of thousands of vertices (a map) is the same shape with a few hundred: simplify BEFORE anything clips it
    const out = cmds.length > 40 ? simplify(cmds) : cmds;
    return out.length ? { cmds: out, box: pathBox(out) } : null;
  };

  const applyClip = () => {
    if (!cur) return;
    const nb = inter(st.clip, cur.box);
    const isRect = rectOf(cur.cmds);
    if (isRect) { st.clipPath = null; }
    else if (within(cur.box, st.clip, 0.01)) st.clipPath = cur.cmds;
    else { const cl = clipPolys(cur.cmds, st.clip); st.clipPath = cl.length ? cl : null; }
    st.clip = empty(nb) ? [0, 0, 0, 0] : nb;
    if (isRect && !within(nb, isRect, 0.01)) st.clipPath = null;
  };

  // The geometry that a paint of `cmds` really leaves visible under the current clip.
  const visibleGeometry = (cmds, box, rect) => {
    const clip = st.clip;
    if (empty(clip)) return null;
    if (st.clipPath && rect && within(clip, rect, 0.5)) {
      // a rectangle that covers its clip entirely paints exactly the clip shape (rounded corners, curves)
      return { cmds: st.clipPath, box: pathBox(st.clipPath), rect: null };
    }
    if (within(box, clip, 0.01)) return { cmds, box, rect };
    if (rect) { const r = inter(rect, clip); return empty(r) ? null : { cmds: rectCmds(r), box: r, rect: r }; }
    const cl = clipPolys(cmds, clip);
    return cl.length ? { cmds: cl, box: pathBox(cl), rect: null } : null;
  };

  const solidOf = (colour, pat) => {
    if (pat === 'tiling') { stats.tilingSkipped += 1; return null; }
    if (pat && pat.shade) {
      const ir = shadings.get(pat.shade);
      if (!ir || ir[0] !== 'RadialAxial') { stats.patternMissing += 1; return null; }
      return { grad: ir, M: vp.transform };
    }
    return colour ? { c: colour } : null;
  };

  const paint = (ev, doFill, doStroke, eo, close) => {
    const path = cur;
    if (!path) return;
    if (close) path.cmds.push(['Z']);
    if (st.smaskGroup) return; // the inside of a mask DEFINITION is never painted
    const mask = st.maskOn ? st.mask : st.grpMask;
    const lose = (why) => { if (doFill && !empty(st.clip)) { const b = inter(st.clip, path.box); if (!empty(b)) lost.push({ z: ev.i, box: b, why }); } };
    if ((st.maskOn || st.grpMask) && !(mask && mask.ir)) { stats.smaskSkipped += 1; lose('mask'); return; }
    let fillSpec = null;
    let strokeSpec = null;
    if (doFill) fillSpec = solidOf(st.fill, st.fillPat);
    if (mask && fillSpec && fillSpec.grad) { stats.smaskSkipped += 1; lose('mask'); return; } // a gradient under a gradient mask
    if (doFill && st.fillPat === 'tiling') lose('pattern');
    if (doStroke && !mask && st.strokePat !== 'tiling' && !(st.strokePat && st.strokePat.shade)) strokeSpec = st.stroke ? { c: st.stroke } : null;
    if (!fillSpec && !strokeSpec) return;
    const rect = rectOf(path.cmds);
    if (!rect && path.cmds.length > MAX_SHAPE_CMDS) { // too complex to draw: never clipped (that is the cost), it is the raster hook's work
      stats.complexDropped += 1;
      lose('complex');
      return;
    }
    const P = toPage(ev.ctm);
    let g;
    if (fillSpec) g = visibleGeometry(path.cmds, path.box, rect);
    else if (empty(st.clip)) g = null;
    else { // an outline is never closed by clipping: keep it whole when any of it shows, rules are trimmed later
      const probe = inter(st.clip, path.box.map((v, k) => (k < 2 ? v - 1 : v + 1)));
      g = empty(probe) ? null : { cmds: path.cmds, box: path.box, rect: null };
    }
    if (!g) return;
    const lw = Math.max(0.05, st.lw * Math.sqrt(Math.abs(P[0] * P[3] - P[1] * P[2])));
    const item = { z: ev.i, cmds: g.cmds, box: g.box.slice(), rect: g.rect, eo, fill: null, stroke: null, clip: st.clip.slice() };
    if (fillSpec) {
      item.fill = fillSpec.grad ? { grad: fillSpec.grad, M: fillSpec.M, a: st.fa } : { c: fillSpec.c, a: st.fa };
      if (mask && !fillSpec.grad) item.fill.mask = mask;
    }
    if (strokeSpec) {
      item.stroke = { c: strokeSpec.c, w: lw, a: st.sa, dash: st.dash, join: st.join };
      // the stroke is centred on the outline: widen the box for the "is it on the page" tests
      if (g.cmds === path.cmds) { item.box = [g.box[0] - lw / 2, g.box[1] - lw / 2, g.box[2] + lw / 2, g.box[3] + lw / 2]; }
    }
    if (item.fill) stats.fills += 1;
    if (item.stroke) stats.strokes += 1;
    if (item.fill && item.fill.grad) stats.gradients += 1;
    items.push(item);
  };

  for (const ev of walkOps(pdfjs, ops)) {
    const { fn, args } = ev;
    switch (fn) {
      case OPS.save: push(); break;
      case OPS.restore: pop(); break;
      case OPS.paintFormXObjectBegin: {
        push();
        if (args && args[1]) {
          const M = toPage(args[0] ? mul(ev.ctm, args[0]) : ev.ctm);
          const bb = EMPTY_BOX.slice();
          for (const [x, y] of [[args[1][0], args[1][1]], [args[1][2], args[1][1]], [args[1][0], args[1][3]], [args[1][2], args[1][3]]]) { const p = apply(M, x, y); grow(bb, p[0], p[1]); }
          st.clip = inter(st.clip, bb); if (empty(st.clip)) st.clip = [0, 0, 0, 0];
          st.clipPath = null;
        }
        break;
      }
      case OPS.paintFormXObjectEnd: pop(); break;
      case OPS.beginGroup:
        push();
        if (args && args[0] && args[0].smask) { st.smaskGroup += 1; defMask = null; }
        if (st.maskOn) { st.grpMask = st.mask; st.maskOn = false; st.mask = null; } // the mask binds to the whole group
        break;
      case OPS.endGroup: pop(); break;
      case OPS.setGState:
        for (const [k, v] of args[0]) {
          if (k === 'ca') st.fa = v; else if (k === 'CA') st.sa = v; else if (k === 'LW') st.lw = v;
          else if (k === 'D') st.dash = v && v[0] && v[0].length ? v[0] : null;
          else if (k === 'SMask') { st.maskOn = !!v; st.mask = v ? (defMask || 'unknown') : null; }
        }
        break;
      case OPS.setFillRGBColor: st.fill = rgbHex(args); st.fillPat = null; break;
      case OPS.setStrokeRGBColor: st.stroke = rgbHex(args); st.strokePat = null; break;
      case OPS.setFillColorN: st.fill = null; st.fillPat = args[0] === 'Shading' ? { shade: args[1] } : 'tiling'; break;
      case OPS.setStrokeColorN: st.stroke = null; st.strokePat = args[0] === 'Shading' ? { shade: args[1] } : 'tiling'; break;
      case OPS.setLineWidth: st.lw = args[0]; break;
      case OPS.setLineJoin: st.join = args[0]; break;
      case OPS.setDash: st.dash = args[0] && args[0].length ? args[0] : null; break;
      case OPS.constructPath: cur = buildPath(ev); break;
      case OPS.clip: case OPS.eoClip: pendingClip = true; break;
      case OPS.endPath: if (pendingClip) applyClip(); pendingClip = false; cur = null; break;
      case OPS.fill: paint(ev, true, false, false, false); if (pendingClip) applyClip(); pendingClip = false; cur = null; break;
      case OPS.eoFill: paint(ev, true, false, true, false); if (pendingClip) applyClip(); pendingClip = false; cur = null; break;
      case OPS.stroke: paint(ev, false, true, false, false); if (pendingClip) applyClip(); pendingClip = false; cur = null; break;
      case OPS.closeStroke: paint(ev, false, true, false, true); if (pendingClip) applyClip(); pendingClip = false; cur = null; break;
      case OPS.fillStroke: paint(ev, true, true, false, false); if (pendingClip) applyClip(); pendingClip = false; cur = null; break;
      case OPS.eoFillStroke: paint(ev, true, true, true, false); if (pendingClip) applyClip(); pendingClip = false; cur = null; break;
      case OPS.closeFillStroke: paint(ev, true, true, false, true); if (pendingClip) applyClip(); pendingClip = false; cur = null; break;
      case OPS.closeEOFillStroke: paint(ev, true, true, true, true); if (pendingClip) applyClip(); pendingClip = false; cur = null; break;
      case OPS.paintSolidColorImageMask: {
        const sv = cur; const ps = pendingClip;
        cur = buildPath({ args: [[OPS.rectangle], [0, 0, 1, 1]], ctm: ev.ctm });
        paint(ev, true, false, false, false);
        cur = sv; pendingClip = ps;
        break;
      }
      case OPS.shadingFill: {
        const ir = shadings.get(args[0]);
        if (st.smaskGroup) { if (ir && ir[0] === 'RadialAxial' && !defMask) defMask = { ir, M: toPage(ev.ctm) }; break; }
        if (st.maskOn || st.grpMask) { stats.smaskSkipped += 1; if (!empty(st.clip)) lost.push({ z: ev.i, box: st.clip.slice(), why: 'mask' }); break; }
        if (!ir || ir[0] !== 'RadialAxial' || empty(st.clip)) { stats.patternMissing += 1; if (!empty(st.clip)) lost.push({ z: ev.i, box: st.clip.slice(), why: 'shading' }); break; }
        const cmds = st.clipPath || rectCmds(st.clip);
        items.push({ z: ev.i, cmds, box: pathBox(cmds), rect: st.clipPath ? null : st.clip.slice(), eo: false, fill: { grad: ir, M: toPage(ev.ctm), a: st.fa }, stroke: null, clip: st.clip.slice() });
        stats.fills += 1; stats.gradients += 1;
        break;
      }
      // ---- text state
      case OPS.beginText: tm = [1, 0, 0, 1, 0, 0]; tlm = [1, 0, 0, 1, 0, 0]; break;
      case OPS.setFont: st.font = args[0]; st.size = args[1]; break;
      case OPS.setCharSpacing: st.cs = args[0]; break;
      case OPS.setWordSpacing: st.ws = args[0]; break;
      case OPS.setHScale: st.hs = args[0] / 100; break;
      case OPS.setLeading: st.lead = args[0]; break;
      case OPS.setTextRise: st.rise = args[0]; break;
      case OPS.setTextRenderingMode: st.mode = args[0]; break;
      case OPS.setTextMatrix: tm = args.slice(); tlm = args.slice(); break;
      case OPS.moveText: moveText(args[0], args[1]); break;
      case OPS.setLeadingMoveText: st.lead = -args[1]; moveText(args[0], args[1]); break;
      case OPS.nextLine: moveText(0, -st.lead); break;
      case OPS.showText: case OPS.showSpacedText: showGlyphs(ev, args[0]); break;
      case OPS.nextLineShowText: moveText(0, -st.lead); showGlyphs(ev, args[0]); break;
      case OPS.nextLineSetSpacingShowText: st.ws = args[0]; st.cs = args[1]; moveText(0, -st.lead); showGlyphs(ev, args[2]); break;
      default: break;
    }
  }
  return { items, events, stats, lost };
}

// --------------------------------------------------- text colour matching ---
// A text SHOW (one showText op) and a pdf.js text ITEM are different units: pdf.js splits a show
// at big TJ gaps and word spaces (several items per show), and merges neighbouring shows of one
// font (several shows per item). So a show is matched to an item by OVERLAP along the baseline,
// not by origin: the show covers [start, start + advance] on the item's own axis.
function matchText(ctx, events, stats) {
  const grid = new Map();
  const key = (gx, gy) => `${gx},${gy}`;
  for (const e of events) {
    if (e.mode === 3 || !e.str.trim()) continue; // invisible text (an OCR layer) / a bare space: no colour to carry
    const n = Math.max(0, Math.ceil(Math.abs(e.adv) / CLAMP_CELL));
    const seen = new Set();
    for (let k = 0; k <= n; k += 1) {
      const t = n ? (k / n) * e.adv : 0;
      const k2 = key(Math.floor((e.ox + e.ux * t) / CLAMP_CELL), Math.floor((e.oy + e.uy * t) / CLAMP_CELL));
      if (seen.has(k2)) continue;
      seen.add(k2);
      if (!grid.has(k2)) grid.set(k2, []);
      grid.get(k2).push(e);
    }
  }
  const resolved = new WeakSet();
  const out = [];
  const m = ctx.vp.transform;
  const horizontalPage = Math.abs(m[1]) < 1e-6 && Math.abs(m[2]) < 1e-6; // unrotated page: a user-space run is horizontal on the page
  for (const r of ctx.runs) {
    const { x0, y0, ux, uy, len, size } = r.pdf;
    const x1 = x0 + ux * len; const y1 = y0 + uy * len;
    const cx0 = Math.floor((Math.min(x0, x1) - size) / CLAMP_CELL); const cx1 = Math.floor((Math.max(x0, x1) + size) / CLAMP_CELL);
    const cy0 = Math.floor((Math.min(y0, y1) - size) / CLAMP_CELL); const cy1 = Math.floor((Math.max(y0, y1) + size) / CLAMP_CELL);
    const cand = new Set();
    for (let gx = cx0; gx <= cx1; gx += 1) for (let gy = cy0; gy <= cy1; gy += 1) for (const e of grid.get(key(gx, gy)) || []) cand.add(e);
    const hits = [];
    for (const e of cand) {
      if (Math.abs(e.ux * ux + e.uy * uy) < 0.98) continue;
      const dx = e.ox - x0; const dy = e.oy - y0;
      const s = dx * ux + dy * uy;
      const p = Math.abs(dx * uy - dy * ux);
      if (p > Math.max(1.5, 0.35 * size)) continue;
      const ov = Math.min(s + e.adv, len) - Math.max(s, 0);
      if (ov > Math.min(0.25 * size, 0.5 * len)) hits.push({ e, s: Math.max(0, s), end: Math.min(len, s + e.adv) });
    }
    hits.sort((a, b) => a.s - b.s);
    if (!hits.length) { stats.textUnmatched += 1; out.push([r]); continue; }
    stats.textMatched += 1;
    // Paint order along the run: at every stretch the LATEST show covering it wins (a drop shadow or a fake
    // bold draws the same word twice; alternating the two colours would scramble the word). Gaps (spaces
    // are not shows we track) take the colour before them; equal neighbours merge.
    const xs = [...new Set([0, len, ...hits.flatMap((h) => [h.s, h.end])])].sort((p, q) => p - q);
    let segs = [];
    for (let k = 0; k + 1 < xs.length; k += 1) {
      const lo = xs[k]; const hi = xs[k + 1];
      if (hi - lo < 1e-6) continue;
      const mid = (lo + hi) / 2;
      let top = null;
      for (const h of hits) if (h.s <= mid && mid <= h.end && (!top || h.e.z > top.e.z)) top = h;
      const gap = !top;
      const c = gap ? (segs.length ? segs[segs.length - 1].c : undefined) : (top.e.color === undefined ? null : top.e.color);
      if (top && top.e.color === undefined) r.colorUnresolved = true;
      const last = segs[segs.length - 1];
      if (last && (last.c === c || c === undefined)) { last.end = hi; if (top) last.z = Math.max(last.z, top.e.z); }
      else segs.push({ c: c === undefined ? null : c, s: lo, end: hi, z: top ? top.e.z : 0 });
    }
    // a sliver is an artefact of rounding, not a colour change: it joins the longer neighbour
    while (segs.length > 1) {
      const k = segs.findIndex((g) => g.end - g.s < Math.min(0.3 * size, 0.2 * len));
      if (k < 0) break;
      const nb = k === 0 ? 1 : (k === segs.length - 1 ? k - 1 : (segs[k - 1].end - segs[k - 1].s >= segs[k + 1].end - segs[k + 1].s ? k - 1 : k + 1));
      const into = segs[nb];
      into.s = Math.min(into.s, segs[k].s); into.end = Math.max(into.end, segs[k].end); into.z = Math.max(into.z, segs[k].z);
      segs.splice(k, 1);
      for (let q = segs.length - 1; q > 0; q -= 1) if (segs[q].c === segs[q - 1].c) { segs[q - 1].end = segs[q].end; segs[q - 1].z = Math.max(segs[q - 1].z, segs[q].z); segs.splice(q, 1); }
    }
    segs[0].s = 0; segs[segs.length - 1].end = len;
    const paint = (target, sg) => { target.color = sg.c && sg.c !== '000000' ? sg.c : null; target.colorZ = sg.z; resolved.add(target); };
    if (segs.length === 1 || !horizontalPage || Math.abs(uy) > 1e-3 || ux < 0) {
      paint(r, segs.reduce((x, y) => (y.end - y.s > x.end - x.s ? y : x))); // cannot split: the colour that covers most of it
      out.push([r]);
      continue;
    }
    // split the run where the colour changes; a cut lands ON whitespace (within a few characters) or not at all:
    // a colour that changes inside a word never splits the word
    const L = r.str.length;
    const cuts = [0];
    const kept = [segs[0]];
    for (let k = 1; k < segs.length; k += 1) {
      const c0 = Math.round((segs[k].s / len) * L);
      let c = -1;
      for (let d = 0; d <= 4 && c < 0; d += 1) {
        if (c0 - d > 0 && /\s/.test(r.str[c0 - d - 1] || '')) c = c0 - d;
        else if (c0 + d < L && c0 + d > 0 && /\s/.test(r.str[c0 + d - 1] || '')) c = c0 + d;
      }
      if (c <= cuts[cuts.length - 1] || c >= L) { // no word boundary here: the stretch belongs to the part before it, unless it is the longer
        const prev = kept[kept.length - 1];
        if (segs[k].end - segs[k].s > prev.end - prev.s) kept[kept.length - 1] = { ...segs[k], s: prev.s };
        else prev.end = segs[k].end;
        continue;
      }
      cuts.push(c); kept.push(segs[k]);
    }
    segs = kept;
    cuts.push(L);
    const parts = [];
    for (let k = 0; k < segs.length; k += 1) {
      const a = cuts[k]; const b = cuts[k + 1];
      if (b <= a) continue;
      const f0 = a / L; const f1 = b / L;
      const n = { ...r, str: r.str.slice(a, b), x: r.x + f0 * r.w, w: (f1 - f0) * r.w,
        org: { x: r.org.x + f0 * r.w, y: r.org.y },
        pdf: { ...r.pdf, x0: r.pdf.x0 + ux * len * f0, y0: r.pdf.y0 + uy * len * f0, len: len * (f1 - f0) } };
      paint(n, segs[k]);
      parts.push(n);
    }
    if (parts.length > 1) stats.runsSplit += 1;
    out.push(parts.length ? parts : [r]);
  }
  ctx.runs = out.flat();
  return resolved;
}

// ------------------------------------------------------------- the pages ----
const MAX_SHAPES = 400; // per page: a map or a chart with thousands of marks must not stall Word
const MAX_SHAPE_CMDS = 1200; // vertices in one shape, after simplification
const MAX_PAGE_CMDS = 8000; // vertices on one page, after simplification

export async function analyzeColor(ctx) {
  const stats = { shapes: 0, fills: 0, strokes: 0, gradients: 0, smaskSkipped: 0, tilingSkipped: 0, patternMissing: 0,
    textMatched: 0, textUnmatched: 0, runsSplit: 0, highlights: 0, guardDropped: 0, guardWhitened: 0, capped: 0, complexDropped: 0, rasterised: 0, whiteDropped: 0, tiny: 0 };
  let rep;
  try { rep = await replay(ctx); } catch (e) { stats.error = String(e && e.message); return { fillAt: () => null, anchors: [], background: null, stats }; }
  Object.assign(stats, { complexDropped: rep.stats.complexDropped, fills: rep.stats.fills, strokes: rep.stats.strokes, gradients: rep.stats.gradients, smaskSkipped: rep.stats.smaskSkipped, tilingSkipped: rep.stats.tilingSkipped, patternMissing: rep.stats.patternMissing });
  const W = ctx.widthPt; const H = ctx.heightPt;
  const pageBox = [0, 0, W, H];

  // -- resolve gradients into drawable specs now that the shape boxes are final
  const grey = (hex) => (0.3 * parseInt(hex.slice(0, 2), 16) + 0.59 * parseInt(hex.slice(2, 4), 16) + 0.11 * parseInt(hex.slice(4, 6), 16)) / 255;
  for (const it of rep.items) {
    if (it.fill && it.fill.mask) {
      // a flat fill under a luminosity soft mask that is one gradient: the same gradient in the fill's own
      // colour, with the mask's luminosity as its alpha (the fade-out every cover design uses)
      const m = it.fill.mask;
      const g = gradientFor(m.ir, m.M, it.box);
      const a = it.fill.a ?? 1;
      if (!g) it.fill = null;
      else if (g.solid) it.fill = grey(g.solid) * a < 0.03 ? null : { c: it.fill.c, a: grey(g.solid) * a };
      else {
        const stops = g.stops.map((st2) => ({ pos: st2.pos, c: it.fill.c, al: grey(st2.c) * a }));
        it.fill = stops.every((st2) => st2.al < 0.03) ? null : { c: it.fill.c, a: 1, g: { ...g, stops } };
      }
      continue;
    }
    if (it.fill && it.fill.grad) {
      const g = gradientFor(it.fill.grad, it.fill.M, it.box);
      if (!g) it.fill = null;
      else if (g.solid) it.fill = { c: g.solid, a: it.fill.a };
      else it.fill = { g, c: g.stops[Math.floor(g.stops.length / 2)].c, a: it.fill.a };
    }
  }
  const items = rep.items.filter((it) => (it.fill || it.stroke) && it.box[2] >= 0 && it.box[3] >= 0 && it.box[0] <= W && it.box[1] <= H);
  const lostRegions = rep.lost.filter((l) => l.box[2] > 0 && l.box[3] > 0 && l.box[0] < W && l.box[1] < H);
  // a path with tens of thousands of vertices (a map) is the same shape with a few hundred: Word must open it
  for (const it of items) if (!it.rect && it.cmds.length > 40) it.cmds = simplify(it.cmds);

  // -- classify: drop noise, normalise lines into rects
  const drawables = [];
  for (const it of items) {
    const w = it.box[2] - it.box[0]; const h = it.box[3] - it.box[1];
    if (it.stroke && !it.fill) {
      // a straight axis-aligned undashed segment is a thin filled rect: exact in every renderer
      const segs = it.cmds.filter((c) => c[0] !== 'Z');
      if (segs.length === 2 && segs[0][0] === 'M' && segs[1][0] === 'L' && !it.stroke.dash) {
        const a = segs[0]; const b = segs[1];
        const lw = it.stroke.w;
        let box = null;
        if (Math.abs(a[2] - b[2]) < 0.05) box = [Math.min(a[1], b[1]), a[2] - lw / 2, Math.max(a[1], b[1]), a[2] + lw / 2];
        else if (Math.abs(a[1] - b[1]) < 0.05) box = [a[1] - lw / 2, Math.min(a[2], b[2]), a[1] + lw / 2, Math.max(a[2], b[2])];
        if (box) {
          box = inter(inter(box, pageBox), it.clip);
          if (empty(box)) continue;
          drawables.push({ ...it, cmds: rectCmds(box), box, rect: box, fill: { c: it.stroke.c, a: it.stroke.a }, stroke: null, rule: true });
          continue;
        }
      }
    }
    if (it.fill && !it.stroke && w * h < 6 && Math.max(w, h) < 6) { stats.tiny += 1; continue; }
    drawables.push(it);
  }

  // -- white (or near-white) paint matters only on top of something: otherwise it is the page
  const keep = [];
  const coveredBefore = (it) => {
    const px = (it.box[0] + it.box[2]) / 2; const py = (it.box[1] + it.box[3]) / 2;
    for (const o of keep) {
      if (o.z >= it.z) break;
      if (o.fill && !isWhite(o.fill.c) && (o.fill.a ?? 1) > 0.3 && px >= o.box[0] && px <= o.box[2] && py >= o.box[1] && py <= o.box[3]) return true;
    }
    return (ctx.images || []).some((im) => im.z < it.z && px >= im.box.x0 && px <= im.box.x1 && py >= im.box.y0 && py <= im.box.y1);
  };
  for (const it of drawables) {
    if (it.fill && !it.stroke && !it.fill.g && isWhite(it.fill.c) && (it.fill.a ?? 1) > 0.5 && !coveredBefore(it)) { stats.whiteDropped += 1; continue; }
    if (it.stroke && !it.fill && isWhite(it.stroke.c) && !coveredBefore(it)) { stats.whiteDropped += 1; continue; }
    if (it.fill && (it.fill.a ?? 1) < 0.02) continue;
    keep.push(it);
  }

  // -- text colour (and the page background it must travel with)
  const resolved = matchText(ctx, rep.events, stats);

  // -- highlight: a tight filled rect behind a single line of text becomes character shading,
  //    so it travels with the words when Word reflows them
  const hlFor = (it) => {
    if (!it.rect || !it.fill || it.fill.g || it.stroke || (it.fill.a ?? 1) < 0.9 || isWhite(it.fill.c)) return null;
    const b = it.box; const bh = b[3] - b[1]; const bw = b[2] - b[0];
    if (bh > 40 || bw < 6) return null;
    const inside = ctx.runs.filter((r) => { const cx = r.x + r.w / 2; const cy = r.y + r.h / 2; return cx >= b[0] && cx <= b[2] && cy >= b[1] && cy <= b[3] && (r.colorZ ?? 1e12) > it.z; });
    if (!inside.length) return null;
    const base = inside[0].org.y;
    const size = Math.max(...inside.map((r) => r.size));
    if (inside.some((r) => Math.abs(r.org.y - base) > 0.3 * size)) return null;
    if (bh > 1.9 * Math.max(...inside.map((r) => r.h))) return null;
    const left = Math.min(...inside.map((r) => r.x)); const right = Math.max(...inside.map((r) => r.x + r.w));
    if (b[0] < left - 0.6 * size || b[2] > right + 0.6 * size) return null;
    if (inside.reduce((a, r) => a + r.w, 0) < 0.6 * bw) return null;
    return inside;
  };
  const shapes = [];
  const highlighted = new Set();
  for (const it of keep) {
    const hits = hlFor(it);
    if (hits) { for (const r of hits) r.bg = it.fill.c; stats.highlights += 1; highlighted.add(it); continue; }
    shapes.push(it);
  }

  // -- budgets. Word opens what it can lay out: a shape with thousands of vertices is not drawn (it is a map or
  //    a trace, and becomes a picture where a rasterizer exists), and the page as a whole gets a vertex budget.
  //    Counted, never faked: a bounding box in its place would paint a block over the page.
  const weight = (it) => (it.fill ? area(it.box) : (it.stroke.w * Math.hypot(it.box[2] - it.box[0], it.box[3] - it.box[1])));
  let drawn = [];
  for (const it of shapes) {
    if (it.cmds.length > MAX_SHAPE_CMDS) { stats.complexDropped += 1; if (it.fill) lostRegions.push({ z: it.z, box: inter(it.box, pageBox), why: 'complex' }); } else drawn.push(it);
  }
  if (drawn.length > MAX_SHAPES) {
    drawn = drawn.slice().sort((a, b) => weight(b) - weight(a)).slice(0, MAX_SHAPES).sort((a, b) => a.z - b.z);
    stats.capped = shapes.length - drawn.length - stats.complexDropped;
  }
  let cmdTotal = drawn.reduce((a, it) => a + it.cmds.length, 0);
  if (cmdTotal > MAX_PAGE_CMDS) {
    const byWeight = drawn.slice().sort((a, b) => weight(a) - weight(b)); // smallest first: they go first
    const gone = new Set();
    for (const it of byWeight) { if (cmdTotal <= MAX_PAGE_CMDS) break; if (it.cmds.length > 12) { gone.add(it); cmdTotal -= it.cmds.length; stats.complexDropped += 1; if (it.fill) lostRegions.push({ z: it.z, box: inter(it.box, pageBox), why: 'complex' }); } }
    drawn = drawn.filter((it) => !gone.has(it));
  }

  // -- fillAt: the solid colour behind a page rectangle (composited over what is beneath)
  // Only paint that REACHES the page counts: a fill we did not draw (capped, too complex, masked) must not
  // vouch for light text sitting on it. Highlights count: they travel with the words as run shading.
  const solids = [];
  for (const it of drawn) if (it.fill) solids.push(it);
  for (const it of keep) if (it.fill && !it.stroke && highlighted.has(it)) solids.push(it);
  solids.sort((a, b) => a.z - b.z);
  const fillAt = (x0, y0, x1, y1) => {
    const q = [x0, y0, x1, y1];
    const qa = area(q);
    const cx = (x0 + x1) / 2; const cy = (y0 + y1) / 2;
    let colour = null;
    let coloured = false;
    for (const it of solids) {
      const b = it.box; // the overlap by hand: this runs once per text run x shape, and an array per pair was the page's garbage
      const ox = Math.min(b[2], x1) - Math.max(b[0], x0);
      const oy = Math.min(b[3], y1) - Math.max(b[1], y0);
      const ia = ox > 0 && oy > 0 ? ox * oy : 0;
      if (!(qa > 0 ? ia >= 0.8 * qa : ia > 0)) continue;
      if (!it.rect && !pointInCmds(it.cmds, cx, cy)) continue;
      const a = it.fill.a ?? 1;
      colour = a >= 0.98 ? it.fill.c : mixHex(it.fill.c, colour || 'FFFFFF', a);
      if (!isWhite(colour)) coloured = true;
    }
    return colour && (coloured || !isWhite(colour)) ? colour : null; // a white page is "nothing"; white ON colour is a fill
  };

  // page background: the topmost fill that covers (almost) the whole page
  let background = null;
  for (const it of solids) if (area(it.box) >= 0.9 * W * H && !isWhite(it.fill.c) && (it.fill.a ?? 1) >= 0.9) background = it.fill.c;

  // -- what we could not draw natively, as pictures where a rasterizer exists (browser: raster.js; tests: ctx.options.rasterize)
  const pictures = await rasterRegions(ctx, lostRegions, stats);

  // -- the rule: colour and background travel together
  contrastGuard(ctx, resolved, fillAt, stats, pictures);

  const info = { fillAt, background, stats };
  let cached = null;
  Object.defineProperty(info, 'anchors', {
    enumerable: true,
    get() {
      if (cached) return cached;
      const claims = ctx.tables || [];
      const inTable = (b) => claims.some((t) => b[0] >= t.x0 - 3 && b[1] >= t.y0 - 3 && b[2] <= t.x1 + 3 && b[3] <= t.y1 + 3);
      cached = [];
      for (const it of drawn) {
        const thin = Math.min(it.box[2] - it.box[0], it.box[3] - it.box[1]) <= 2.5;
        if ((it.rule || (it.stroke && !it.fill) || (it.rect && thin)) && inTable(it.box)) continue;
        cached.push(toShape(it));
      }
      stats.shapes = cached.length;
      for (const pic of pictures) cached.push(pic);
      cached.sort((a, b) => a.z - b.z);
      return cached;
    },
  });
  return info;
}

// Light text needs a backdrop we drew (or a picture); text we could not colour, over a dark
// backdrop we drew, becomes white. Both directions of "travel together".
function contrastGuard(ctx, resolved, fillAt, stats, pictures) {
  const imgs = [...pictures.map((p) => ({ z: p.z, box: { x0: p.anchor.x, y0: p.anchor.y, x1: p.anchor.x + p.wPt, y1: p.anchor.y + p.hPt } })), ...(ctx.images || [])].filter((im) => {
    const a = (im.box.x1 - im.box.x0) * (im.box.y1 - im.box.y0);
    return !((ctx.kind === 'searchable-scan' || ctx.kind === 'ocr-scan') && a > ctx.widthPt * ctx.heightPt * 0.8);
  });
  for (const r of ctx.runs) {
    const cx = r.x + r.w / 2; const cy = r.y + r.h / 2;
    const under = fillAt(r.x + r.w * 0.25, r.y + r.h * 0.3, r.x + r.w * 0.75, r.y + r.h * 0.7);
    const z = r.colorZ ?? 1e12;
    const pic = imgs.some((im) => im.z < z && cx >= im.box.x0 && cx <= im.box.x1 && cy >= im.box.y0 && cy <= im.box.y1);
    if (r.color) {
      if (lum(r.color) > 0.55 && !under && !pic && !r.bg) { r.color = null; stats.guardDropped += 1; }
      else if (under && contrast(r.color, under) < 1.4 && !pic) { r.color = lum(under) < 0.35 ? 'FFFFFF' : null; stats.guardDropped += 1; }
    } else if (under && lum(under) < 0.2 && !pic && (!resolved.has(r) || r.colorUnresolved)) {
      // unresolved or black text on a dark fill we drew: black on dark is the illegible direction
      r.color = 'FFFFFF'; stats.guardWhitened += 1;
    }
  }
}

// ---------------------------------------------------------- the raster hook ---
// The regions we could not draw natively (a soft-masked fill, a tiling pattern, a vertex-heavy trace) become
// pictures of the page there, with the TEXT left out (it stays live Word text). Who rasterizes:
//   ctx.options.rasterize({ ctx, box, why }) -> { bytes, ext } | null     (tests, other hosts)
//   else raster.js in a browser (canvas + pdf.js's own renderer)           else nothing: counted, not faked.
const MAX_REGIONS = 4;
const MAX_RASTER_BYTES = 12 * 1024 * 1024; // per document
async function rasterRegions(ctx, regions, stats) {
  const out = [];
  const W = ctx.widthPt; const H = ctx.heightPt;
  const hook = ctx.options && typeof ctx.options.rasterize === 'function' ? ctx.options.rasterize : defaultRasterizer();
  if (!hook || !regions.length) return out;
  const shared = ctx.shared || {};
  const wanted = regions
    .map((r) => ({ ...r, box: inter(r.box, [0, 0, W, H]) }))
    .filter((r) => !empty(r.box) && area(r.box) >= 0.01 * W * H)
    .sort((a, b) => area(b.box) - area(a.box));
  const picked = [];
  for (const r of wanted) if (!picked.some((q) => within(r.box, q.box, 2))) picked.push(r);
  for (const r of picked.slice(0, MAX_REGIONS)) {
    if ((shared.rasterBytes || 0) > MAX_RASTER_BYTES) break;
    let pic = null;
    try { pic = await hook({ ctx, box: r.box.slice(), why: r.why }); } catch { pic = null; }
    if (!pic || !pic.bytes || !pic.bytes.length) continue;
    shared.rasterBytes = (shared.rasterBytes || 0) + pic.bytes.length;
    const b = r.box;
    out.push({ kind: 'img', anchor: { x: b[0], y: b[1] }, bytes: pic.bytes, ext: pic.ext || 'png', wPt: b[2] - b[0], hPt: b[3] - b[1], z: r.z, crop: null });
    stats.rasterised += 1;
  }
  return out;
}

const defaultRasterizer = () => (canRasterize() ? rasterizeRegion : null);

// ----------------------------------------------------------- the model ------
function toShape(it) {
  const b = it.box;
  const s = { kind: 'shape', x: b[0], y: b[1], wPt: Math.max(b[2] - b[0], 0.01), hPt: Math.max(b[3] - b[1], 0.01), z: it.z };
  if (it.fill) { s.fill = it.fill.c; if (it.fill.a !== undefined && it.fill.a < 0.999) s.alpha = it.fill.a; if (it.fill.g) s.grad = it.fill.g; }
  if (it.stroke) s.stroke = { c: it.stroke.c, wPt: it.stroke.w, ...(it.stroke.a < 0.999 ? { alpha: it.stroke.a } : {}), ...(it.stroke.dash ? { dash: it.stroke.dash } : {}), ...(it.stroke.join === 1 ? { join: 'round' } : {}) };
  if (!it.rect || it.stroke) {
    // path points relative to the shape's own box (a stroke widens `box`, so measure from the path itself)
    const pb = pathBox(it.cmds);
    s.x = pb[0]; s.y = pb[1]; s.wPt = Math.max(pb[2] - pb[0], 0.01); s.hPt = Math.max(pb[3] - pb[1], 0.01);
    s.path = it.cmds.map((c) => c.map((v, k) => (k === 0 ? v : (k % 2 === 1 ? v - pb[0] : v - pb[1]))));
    s.evenOdd = !!it.eo;
  }
  return s;
}

// --------------------------------------------------------------- writer -----
// A DrawingML shape anchored to the page, behind the text.
// relativeHeight is 251658240 + the drawing id: ids rise in document order, so a later shape
// or picture stacks above an earlier one (small bare values stack erratically in LibreOffice).
const E = (pt) => Math.round(pt * 12700);

function clr(hex, alpha) {
  return alpha !== undefined && alpha < 0.999
    ? `<a:srgbClr val="${hex}"><a:alpha val="${Math.max(0, Math.round(alpha * 100000))}"/></a:srgbClr>`
    : `<a:srgbClr val="${hex}"/>`;
}

function fillXml(s) {
  if (s.grad && s.grad.stops) {
    const gs = s.grad.stops.map((g) => `<a:gs pos="${g.pos}">${clr(g.c, g.al !== undefined ? g.al : s.alpha)}</a:gs>`).join('');
    if (s.grad.kind === 'radial') {
      const w = s.wPt; const h = s.hPt;
      const l = Math.round(Math.max(0, Math.min(1, (s.grad.cx - s.x) / w)) * 100000);
      const t = Math.round(Math.max(0, Math.min(1, (s.grad.cy - s.y) / h)) * 100000);
      return `<a:gradFill rotWithShape="1"><a:gsLst>${gs}</a:gsLst><a:path path="circle"><a:fillToRect l="${l}" t="${t}" r="${100000 - l}" b="${100000 - t}"/></a:path></a:gradFill>`;
    }
    return `<a:gradFill rotWithShape="1"><a:gsLst>${gs}</a:gsLst><a:lin ang="${s.grad.ang}" scaled="0"/></a:gradFill>`;
  }
  return s.fill && HEX6.test(s.fill) ? `<a:solidFill>${clr(s.fill, s.alpha)}</a:solidFill>` : '<a:noFill/>';
}

function lineXml(s) {
  if (!(s.stroke && HEX6.test(s.stroke.c))) return '<a:ln><a:noFill/></a:ln>';
  const dash = s.stroke.dash ? `<a:prstDash val="${s.stroke.dash[0] <= 2 * (s.stroke.wPt || 1) ? 'sysDash' : 'dash'}"/>` : '';
  const join = s.stroke.join === 'round' ? '<a:round/>' : '<a:miter lim="800000"/>';
  return `<a:ln w="${Math.max(1, E(s.stroke.wPt || 0.5))}"><a:solidFill>${clr(s.stroke.c, s.stroke.alpha)}</a:solidFill>${dash}${join}</a:ln>`;
}

function geomXml(s, cx, cy) {
  if (!s.path) return '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';
  const p = (x, y) => `<a:pt x="${E(x)}" y="${E(y)}"/>`;
  let d = '';
  for (const c of s.path) {
    if (c[0] === 'M') d += `<a:moveTo>${p(c[1], c[2])}</a:moveTo>`;
    else if (c[0] === 'L') d += `<a:lnTo>${p(c[1], c[2])}</a:lnTo>`;
    else if (c[0] === 'C') d += `<a:cubicBezTo>${p(c[1], c[2])}${p(c[3], c[4])}${p(c[5], c[6])}</a:cubicBezTo>`;
    else d += '<a:close/>';
  }
  const noFill = !s.fill && !s.grad;
  return `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="${cx}" h="${cy}"${noFill ? ' fill="none"' : ''}>${d}</a:path></a:pathLst></a:custGeom>`;
}

function shapeXml(s, w) {
  w.useNamespace('wps', 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape');
  const id = w.nextId();
  const cx = Math.max(1, E(s.wPt));
  const cy = Math.max(1, E(s.hPt));
  return `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${251658240 + id}" behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1">`
    + '<wp:simplePos x="0" y="0"/>'
    + `<wp:positionH relativeFrom="page"><wp:posOffset>${E(s.x)}</wp:posOffset></wp:positionH>`
    + `<wp:positionV relativeFrom="page"><wp:posOffset>${E(s.y)}</wp:posOffset></wp:positionV>`
    + `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>`
    + `<wp:docPr id="${id}" name="Shape ${id}"/><wp:cNvGraphicFramePr/>`
    + '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr/>'
    + `<wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>${geomXml(s, cx, cy)}${fillXml(s)}${lineXml(s)}</wps:spPr>`
    + '<wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>';
}

registerAnchor('shape', shapeXml);
