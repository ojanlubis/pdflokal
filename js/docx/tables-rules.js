/*
 * PDFLokal — docx/tables-rules.js  (the RULES and FILLS of a page, from its operator list)
 * ============================================================================
 * What a table's ruling looks like in a content stream varies by producer:
 *   - Word / LibreOffice draw a border as a THIN FILLED RECTANGLE (0.5-1pt wide), often twice
 *   - others stroke a moveTo/lineTo segment, or stroke a whole `re` outline
 *   - a cell background is a filled rectangle, in paint order under the text
 * This module reduces all of that to flat lists in PAGE points (top-left origin):
 *
 *   rules: [{ o:'h'|'v', p, a0, a1, w, c, z }]   a straight line at coordinate p (y for 'h',
 *                                                x for 'v') spanning a0..a1, thickness w pt,
 *                                                colour c (hex), z = operator index
 *   fills: [{ x0,y0,x1,y1, c, z }]               a solid filled rectangle (a fill that is thin
 *                                                enough to be a rule is a rule, not a fill)
 *   shapes: [{ x0,y0,x1,y1, c, z }]              the bounding box of a filled path that is NOT an upright rectangle
 *                                                (rounded card, arrow, ribbon): evidence of drawn art, never a cell
 *
 * Tracked graphics state: CTM (ops.walkOps), fill/stroke colour, line width, a rectangular clip
 * (a clip path is reduced to its bounding box), q/Q and form XObjects. NOT tracked: dashes (a dashed
 * rule reads as solid), alpha, patterns and shadings (their fills are dropped, not guessed),
 * non-rectangular fills (curves, polygons), text-as-clip. A page with more than MAX_PATH_OPS
 * constructPath ops is vector ART (a map, a chart): extraction stops and `stats.skipped` says so.
 */

import { walkOps } from './ops.js';

export const MAX_PATH_OPS = 30000;
export const SNAP = 1.2; // rules whose coordinates differ by less than this are one rule (pt)
export const BRIDGE = 2.5; // collinear rule pieces closer than this are one rule (pt)
// A filled rectangle thinner than this is a RULE, not a fill. Word draws borders 0.48-0.75 pt thick;
// 2.2 keeps a 2pt double-rule and rejects a 3pt coloured bar (which is a fill).
const THIN = 2.2;
const AXIS = 0.5; // a stroked segment this close to axis-parallel (pt over its length) is horizontal/vertical

const hex2 = (v) => (v < 16 ? '0' : '') + v.toString(16);
const hexOf = (a) => hex2(a[0] & 255) + hex2(a[1] & 255) + hex2(a[2] & 255);

function parsePath(ops, coords, m, pdfjs) {
  // -> subpaths: [{ pts: [[x,y]...], closed, rect: [x0,y0,x1,y1] | null }] in page space
  const { OPS } = pdfjs;
  const subs = [];
  let cur = null;
  let k = 0;
  const pt = (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const start = (p) => { cur = { pts: [p], closed: false, rectOp: false, curved: false }; subs.push(cur); };
  for (const op of ops) {
    if (op === OPS.moveTo) { start(pt(coords[k], coords[k + 1])); k += 2; }
    else if (op === OPS.lineTo) { if (!cur) start(pt(coords[k], coords[k + 1])); else cur.pts.push(pt(coords[k], coords[k + 1])); k += 2; }
    else if (op === OPS.curveTo) { if (cur) { cur.curved = true; cur.pts.push(pt(coords[k + 4], coords[k + 5])); } k += 6; }
    else if (op === OPS.curveTo2 || op === OPS.curveTo3) { if (cur) { cur.curved = true; cur.pts.push(pt(coords[k + 2], coords[k + 3])); } k += 4; }
    else if (op === OPS.closePath) { if (cur) cur.closed = true; }
    else if (op === OPS.rectangle) {
      const x = coords[k]; const y = coords[k + 1]; const w = coords[k + 2]; const h = coords[k + 3];
      k += 4;
      cur = { pts: [pt(x, y), pt(x + w, y), pt(x + w, y + h), pt(x, y + h)], closed: true, rectOp: true, curved: false };
      subs.push(cur);
    }
  }
  for (const s of subs) {
    s.rect = null;
    const p = s.pts;
    const quad = p.length === 4 || (p.length === 5 && Math.abs(p[4][0] - p[0][0]) < 0.05 && Math.abs(p[4][1] - p[0][1]) < 0.05);
    if (!s.curved && quad && (s.closed || s.rectOp || p.length === 5)) {
      const xs = p.slice(0, 4).map((q) => q[0]);
      const ys = p.slice(0, 4).map((q) => q[1]);
      const x0 = Math.min(...xs); const x1 = Math.max(...xs); const y0 = Math.min(...ys); const y1 = Math.max(...ys);
      // axis-aligned: every edge is horizontal or vertical
      const ok = [0, 1, 2, 3].every((i) => {
        const a = p[i]; const b = p[(i + 1) % 4];
        return Math.abs(a[0] - b[0]) < 0.05 || Math.abs(a[1] - b[1]) < 0.05;
      });
      if (ok) s.rect = [x0, y0, x1, y1];
    }
  }
  return subs;
}

const intersect = (a, b) => {
  if (!a) return b;
  if (!b) return a;
  const r = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  return r[2] > r[0] && r[3] > r[1] ? r : [0, 0, 0, 0];
};

export function extractRules(ctx) {
  const { pdfjs, ops, vp } = ctx;
  const { OPS } = pdfjs;
  const stats = { pathOps: 0, skipped: false, rules: 0, fills: 0 };
  const rules = [];
  const fills = [];
  const shapes = [];
  if (!ops || !ops.fnArray) return { rules, fills, shapes, stats };
  let nPath = 0;
  for (let i = 0; i < ops.fnArray.length; i += 1) if (ops.fnArray[i] === OPS.constructPath) nPath += 1;
  stats.pathOps = nPath;
  if (!nPath) return { rules, fills, shapes, stats }; // a page of text alone: nothing to walk
  if (nPath > MAX_PATH_OPS) { stats.skipped = true; return { rules, fills, shapes, stats }; }

  const mul = (a, b) => pdfjs.Util.transform(a, b);
  let gs = { fill: '000000', stroke: '000000', lw: 1, clip: null };
  const stack = [];
  let path = null; // the last constructPath: { ops, coords, m }
  let pendingClip = null;

  const addRule = (o, p, a0, a1, w, c, z, clip) => {
    if (!c || a1 - a0 < 0.5) return;
    if (clip) {
      // clip the span (and drop a rule that lies wholly outside)
      const [cx0, cy0, cx1, cy1] = clip;
      const lo = o === 'h' ? cx0 : cy0;
      const hi = o === 'h' ? cx1 : cy1;
      const pl = o === 'h' ? cy0 : cx0;
      const ph = o === 'h' ? cy1 : cx1;
      if (p < pl - w || p > ph + w) return;
      a0 = Math.max(a0, lo);
      a1 = Math.min(a1, hi);
      if (a1 - a0 < 0.5) return;
    }
    rules.push({ o, p, a0, a1, w: Math.max(0.25, w), c, z });
  };
  const addFill = (r, c, z, clip) => {
    if (!c) return;
    const b = intersect(clip, r);
    if (b[2] - b[0] < 0.3 || b[3] - b[1] < 0.3) return;
    const w = b[2] - b[0]; const h = b[3] - b[1];
    if (Math.min(w, h) <= THIN && Math.max(w, h) >= 2 * Math.min(w, h) + 1) {
      if (w >= h) addRule('h', (b[1] + b[3]) / 2, b[0], b[2], h, c, z, null);
      else addRule('v', (b[0] + b[2]) / 2, b[1], b[3], w, c, z, null);
    } else fills.push({ x0: b[0], y0: b[1], x1: b[2], y1: b[3], c, z });
  };

  const paint = (z, doFill, doStroke, close) => {
    if (!path) return;
    const subs = parsePath(path.ops, path.coords, path.m, pdfjs);
    const scale = Math.sqrt(Math.abs(path.m[0] * path.m[3] - path.m[1] * path.m[2])) || 1;
    for (const s of subs) {
      if (doFill && gs.fill && s.rect) addFill(s.rect, gs.fill, z, gs.clip);
      else if (doFill && gs.fill && s.pts.length >= 3) {
        // a filled shape that is not an upright rectangle (a rounded card, a ribbon, an arrow): not a cell background, but
        // proof that the page around it is drawn art. Kept as a box.
        const xs = s.pts.map((q) => q[0]); const ys = s.pts.map((q) => q[1]);
        const b = intersect(gs.clip, [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
        if (b[2] - b[0] >= 6 && b[3] - b[1] >= 6) shapes.push({ x0: b[0], y0: b[1], x1: b[2], y1: b[3], c: gs.fill, z });
      }
      if (!doStroke || !gs.stroke) continue;
      const w = gs.lw * scale;
      if (s.rect) {
        const [x0, y0, x1, y1] = s.rect;
        addRule('h', y0, x0 - w / 2, x1 + w / 2, w, gs.stroke, z, gs.clip);
        addRule('h', y1, x0 - w / 2, x1 + w / 2, w, gs.stroke, z, gs.clip);
        addRule('v', x0, y0 - w / 2, y1 + w / 2, w, gs.stroke, z, gs.clip);
        addRule('v', x1, y0 - w / 2, y1 + w / 2, w, gs.stroke, z, gs.clip);
        continue;
      }
      if (s.curved) continue;
      const p = s.pts;
      for (let j = 1; j < p.length + (close || s.closed ? 1 : 0); j += 1) {
        const a = p[j - 1]; const b = p[j % p.length];
        if (Math.abs(a[1] - b[1]) <= AXIS && Math.abs(a[0] - b[0]) > AXIS) addRule('h', (a[1] + b[1]) / 2, Math.min(a[0], b[0]), Math.max(a[0], b[0]), w, gs.stroke, z, gs.clip);
        else if (Math.abs(a[0] - b[0]) <= AXIS && Math.abs(a[1] - b[1]) > AXIS) addRule('v', (a[0] + b[0]) / 2, Math.min(a[1], b[1]), Math.max(a[1], b[1]), w, gs.stroke, z, gs.clip);
      }
    }
  };
  const endPaint = () => {
    path = null;
    if (pendingClip) { gs = { ...gs, clip: intersect(gs.clip, pendingClip) }; pendingClip = null; }
  };

  for (const ev of walkOps(pdfjs, ops)) {
    const { fn, args, i } = ev;
    switch (fn) {
      case OPS.save: stack.push(gs); break;
      case OPS.restore: if (stack.length) gs = stack.pop(); break;
      case OPS.paintFormXObjectBegin: stack.push(gs); break;
      case OPS.paintFormXObjectEnd: if (stack.length) gs = stack.pop(); break;
      case OPS.setFillRGBColor: gs = { ...gs, fill: hexOf(args) }; break;
      case OPS.setStrokeRGBColor: gs = { ...gs, stroke: hexOf(args) }; break;
      case OPS.setFillColorN: case OPS.setFillColor: gs = { ...gs, fill: args && args.length === 3 && typeof args[0] === 'number' ? hexOf(args) : null }; break;
      case OPS.setStrokeColorN: case OPS.setStrokeColor: gs = { ...gs, stroke: args && args.length === 3 && typeof args[0] === 'number' ? hexOf(args) : null }; break;
      case OPS.setLineWidth: gs = { ...gs, lw: args[0] }; break;
      case OPS.setGState:
        for (const [key, val] of args[0] || []) if (key === 'LW') gs = { ...gs, lw: val };
        break;
      case OPS.constructPath: path = { ops: args[0], coords: args[1], m: mul(vp.transform, ev.ctm) }; break;
      case OPS.stroke: paint(i, false, true, false); endPaint(); break;
      case OPS.closeStroke: paint(i, false, true, true); endPaint(); break;
      case OPS.fill: case OPS.eoFill: paint(i, true, false, false); endPaint(); break;
      case OPS.fillStroke: case OPS.eoFillStroke: paint(i, true, true, false); endPaint(); break;
      case OPS.closeFillStroke: case OPS.closeEOFillStroke: paint(i, true, true, true); endPaint(); break;
      case OPS.endPath: endPaint(); break;
      case OPS.clip: case OPS.eoClip: {
        if (path) {
          const subs = parsePath(path.ops, path.coords, path.m, pdfjs);
          let b = null;
          for (const s of subs) {
            const xs = s.pts.map((q) => q[0]); const ys = s.pts.map((q) => q[1]);
            const r = s.rect || [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
            b = b ? [Math.min(b[0], r[0]), Math.min(b[1], r[1]), Math.max(b[2], r[2]), Math.max(b[3], r[3])] : r;
          }
          pendingClip = b;
        }
        break;
      }
      default:
    }
  }
  stats.rules = rules.length;
  stats.fills = fills.length;
  stats.shapes = shapes.length;
  return { rules, fills, shapes, stats };
}

// Rules on one line, in pieces (Word draws a border per cell, 0.5pt apart; some producers draw one segment per cell), become ONE
// rule per line: pieces whose coordinates differ by less than SNAP are one line, pieces closer than BRIDGE end to end are one rule.
export function mergeCollinear(rules, o) {
  const list = rules.filter((r) => r.o === o).sort((a, b) => a.p - b.p);
  const out = [];
  let k = 0;
  while (k < list.length) {
    let e = k + 1;
    while (e < list.length && list[e].p - list[e - 1].p <= SNAP) e += 1;
    const grp = list.slice(k, e).sort((a, b) => a.a0 - b.a0);
    k = e;
    let cur = null;
    const flush = () => {
      if (!cur) return;
      const longest = cur.members.reduce((a, b) => (b.a1 - b.a0 > a.a1 - a.a0 ? b : a));
      let sp = 0; let sl = 0;
      for (const m of cur.members) { sp += m.p * (m.a1 - m.a0); sl += m.a1 - m.a0; }
      // where one piece ends and the next begins: the cell boundaries of a table whose borders are drawn cell by cell
      const cuts = [];
      for (let q = 1; q < cur.members.length; q += 1) if (cur.members[q].a0 > cur.members[q - 1].a1 - 0.01 && cur.members[q].a0 - cur.members[q - 1].a1 <= BRIDGE) cuts.push((cur.members[q].a0 + cur.members[q - 1].a1) / 2);
      out.push({ o, p: sp / sl, a0: cur.a0, a1: cur.a1, w: Math.max(...cur.members.map((m) => m.w)), c: longest.c, cuts });
    };
    for (const r of grp) {
      if (cur && r.a0 <= cur.a1 + BRIDGE) { cur.a1 = Math.max(cur.a1, r.a1); cur.members.push(r); }
      else { flush(); cur = { a0: r.a0, a1: r.a1, members: [r] }; }
    }
    flush();
  }
  return out;
}
