/*
 * PDFLokal — core/pdf-to-docx.js  (SPIKE 2026-10-02: PDF -> .docx, the EXTRACTION half)
 * ============================================================================
 * pdf.js text runs + operator list  ->  the neutral model core/to-docx.js writes.
 *
 * Reuses what the app already has: groupRunsIntoLines (text-lines.js: runs ->
 * visual lines, incl. the marker/colon soft split) and pageHasVisibleText
 * (text-visibility.js: tells a real text page from a searchable scan). The run
 * extraction below MIRRORS js/v2/text-runs.js extract() (same arithmetic, minus
 * the editor model) because that function is welded to the editor's document
 * model; a v1 should lift it into a shared core function instead of keeping a
 * third copy (tests/core/block-edit.test.mjs is the second).
 *
 * New here, all heuristic and all measured by scripts/docx-spike.mjs:
 *   - reading order (recursive XY-cut: column gutters first, then row bands)
 *   - rows (lines sharing a baseline) -> tab-separated "cells"
 *   - paragraph merge (lines -> paragraphs by spacing, edge and fullness)
 *   - bold/italic/size/family per run from the font objects pdf.js resolved
 *   - images placed in reading order (inline) or behind the text (anchored)
 *
 * Headless: pdfjs and fflate are INJECTED. Nothing is uploaded, nothing is
 * network. Not wired into any UI.
 */

import { groupRunsIntoLines, SPACE_GAP_FACTOR } from './text-lines.js';
import { pageHasVisibleText } from './text-visibility.js';
import { buildDocx, encodePng } from './to-docx.js';

const BULLET_RE = new RegExp('^[\\u2022\\u25CF\\u25CB\\u25E6\\u25AA\\u25A0\\u25A1\\u2023\\u2043\\u2219\\u00B7\\uF0B7\\uF0A7\\uF0D8\\uF076\\u2013\\u2014*-]\\s*');
const NUM_MARKER_RE = /^(\(?\d{1,3}([.)]\d*)*[.)]|\(?[A-Za-z][.)]|\(?[ivxIVX]{1,4}[.)])$/;
const RTL_RE = new RegExp('[\\u0590-\\u08FF\\uFB1D-\\uFDFF\\uFE70-\\uFEFE]', 'g');

// ---------------------------------------------------------------- fonts ----
const KNOWN = [
  [/times|tinos|liberation ?serif|nimbus ?rom/i, 'Times New Roman'],
  [/arial|helvet|liberation ?sans|arimo|nimbus ?sans/i, 'Arial'],
  [/calibri|carlito/i, 'Calibri'],
  [/cambria|caladea/i, 'Cambria'],
  [/courier|cousine|consolas|monospace/i, 'Courier New'],
  [/verdana/i, 'Verdana'],
  [/tahoma/i, 'Tahoma'],
  [/georgia/i, 'Georgia'],
  [/garamond/i, 'Garamond'],
  [/palatino|book ?antiqua/i, 'Palatino Linotype'],
  [/trebuchet/i, 'Trebuchet MS'],
  [/segoe/i, 'Segoe UI'],
  [/comic/i, 'Comic Sans MS'],
  [/impact/i, 'Impact'],
  [/tw ?cen/i, 'Tw Cen MT'],
  [/century|schoolbook/i, 'Century Schoolbook'],
  [/bookman/i, 'Bookman Old Style'],
  [/montserrat/i, 'Montserrat'],
  [/open ?sans/i, 'Open Sans'],
  [/roboto/i, 'Roboto'],
  [/lato/i, 'Lato'],
  [/noto ?sans/i, 'Noto Sans'],
  [/noto ?serif/i, 'Noto Serif'],
];

export function fontInfoOf(fontObj, generic) {
  const raw = String((fontObj && fontObj.name) || '');
  const name = raw.replace(/^[A-Z]{6}\+/, '').replace(/^.*\+/, '');
  const spaced = name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_,]/g, ' ');
  const bold = /bold|black|heavy|semibold|demi/i.test(name) || !!(fontObj && fontObj.bold);
  const italic = /italic|oblique/i.test(name) || !!(fontObj && fontObj.italic);
  let family = null;
  for (const [re, fam] of KNOWN) if (re.test(spaced)) { family = fam; break; }
  if (!family) {
    const base = spaced.replace(/\b(bold|italic|oblique|regular|roman|normal|mt|ps|psmt|std|pro|lt|black|light|medium|semibold|narrow|condensed)\b/gi, '').replace(/\s+/g, ' ').trim();
    // A generator placeholder ("F1", "g d0 f1", "CIDFont") teaches nothing.
    const uninformative = !base || /^(f|c|g|tt|font|cidfont|type|d|[a-z]\d*)(\s?\d+)*$/i.test(base) || base.length < 3;
    if (!uninformative) family = base;
  }
  if (!family) {
    if (fontObj && fontObj.isMonospace) family = 'Courier New';
    else if ((fontObj && fontObj.isSerifFont) || generic === 'serif') family = 'Times New Roman';
    else if (generic === 'monospace') family = 'Courier New';
    else family = 'Arial';
  }
  return { family, bold, italic };
}

// ---------------------------------------------------------------- runs -----
async function extractRuns(pdfjs, page, tc, fontInfo) {
  const vp = page.getViewport({ scale: 1 });
  const runs = [];
  for (const item of tc.items) {
    if (!item.str || !item.str.trim()) continue;
    const m = pdfjs.Util.transform(vp.transform, item.transform);
    const fh = Math.hypot(m[2], m[3]);
    if (!fh || !item.width) continue;
    const dirLen = Math.hypot(m[0], m[1]) || 1;
    const adv = [(m[0] / dirLen) * item.width, (m[1] / dirLen) * item.width];
    const pDesc = pdfjs.Util.applyTransform([0, -0.25], m);
    const pTop = pdfjs.Util.applyTransform([0, 1], m);
    const org = pdfjs.Util.applyTransform([0, 0], m);
    const cs = [pDesc, [pDesc[0] + adv[0], pDesc[1] + adv[1]], pTop, [pTop[0] + adv[0], pTop[1] + adv[1]]];
    const xs = cs.map((c) => c[0]);
    const ys = cs.map((c) => c[1]);
    const pad = fh * 0.06;
    const len = Math.hypot(item.transform[0], item.transform[1]) || 1;
    runs.push({
      str: item.str,
      x: Math.min(...xs) - pad,
      y: Math.min(...ys) - pad,
      w: Math.max(...xs) - Math.min(...xs) + pad * 2,
      h: Math.max(...ys) - Math.min(...ys) + pad * 2,
      size: fh,
      fontName: item.fontName,
      fontFamily: (tc.styles[item.fontName] || {}).fontFamily || '',
      dir: item.dir,
      org: { x: org[0], y: org[1] },
      pdf: {
        x0: item.transform[4], y0: item.transform[5], ux: item.transform[0] / len, uy: item.transform[1] / len,
        len: item.width, size: Math.hypot(item.transform[2], item.transform[3]),
      },
      style: fontInfo.get(item.fontName) || { family: 'Arial', bold: false, italic: false },
    });
  }
  return { runs, vp };
}

// A line's styled runs: same space-synthesis rule as text-lines.js assembleLine
// (so the text of the docx equals the text of the line the editor sees).
function lineRuns(line) {
  const out = [];
  let prev = null;
  let prevA1 = 0;
  const push = (text, r) => {
    const s = r.style;
    const last = out[out.length - 1];
    const sz = Math.round(r.pdf.size * 2) / 2;
    if (last && last.b === s.bold && last.i === s.italic && last.f === s.family && last.sz === sz) last.t += text;
    else out.push({ t: text, b: s.bold, i: s.italic, f: s.family, sz });
  };
  for (const r of line.runs) {
    const a0 = r.pdf.x0 * r.pdf.ux + r.pdf.y0 * r.pdf.uy;
    let text = r.str;
    if (prev) {
      const gap = a0 - prevA1;
      const prevText = out.length ? out[out.length - 1].t : '';
      if (gap > SPACE_GAP_FACTOR * prev.pdf.size && !/\s$/.test(prevText) && !/^\s/.test(text)) text = ` ${text}`;
    }
    push(text, r);
    prev = r;
    prevA1 = a0 + r.pdf.len;
  }
  return out;
}

const median = (a) => {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  const k = s.length >> 1;
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
};
const percentile = (a, p) => {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

// ---------------------------------------------------------------- images ---
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

async function extractImages(pdfjs, page, ops, vp, state) {
  const { OPS } = pdfjs;
  const found = [];
  const stats = { masks: 0, failed: 0 };
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const mul = (m, n) => pdfjs.Util.transform(m, n);
  for (let i = 0; i < ops.fnArray.length; i += 1) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) { if (stack.length) ctm = stack.pop(); }
    else if (fn === OPS.transform) ctm = mul(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (args && args[0]) ctm = mul(ctm, args[0]); }
    else if (fn === OPS.paintFormXObjectEnd) { if (stack.length) ctm = stack.pop(); }
    else if (fn === OPS.paintImageMaskXObject || fn === OPS.paintImageMaskXObjectRepeat) stats.masks += 1;
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageXObjectRepeat) {
      const m = mul(vp.transform, ctm);
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map((p) => pdfjs.Util.applyTransform(p, m));
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const box = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
      if (box.x1 - box.x0 < 4 || box.y1 - box.y0 < 4) { stats.failed += 0; continue; }
      const id = fn === OPS.paintInlineImageXObject ? null : args[0];
      const key = id && `${id}`;
      let bytes = key && state.imageCache.get(key);
      if (!bytes) {
        try {
          let img;
          if (fn === OPS.paintInlineImageXObject) img = args[0];
          else img = await new Promise((resolve, reject) => {
            const pool = String(id).startsWith('g_') ? page.commonObjs : page.objs;
            let done = false;
            pool.get(id, (o) => { done = true; resolve(o); });
            setTimeout(() => { if (!done) reject(new Error('image not resolved')); }, 4000);
          });
          const px = img && expandToPixels(img);
          if (!px) throw new Error('unreadable image');
          const maxW = Math.max(16, Math.ceil(((box.x1 - box.x0) * 150) / 72));
          const d = downscale(px, maxW);
          bytes = encodePng(state.fflate, d.w, d.h, d.ch, d.px);
          if (key) state.imageCache.set(key, bytes);
        } catch { stats.failed += 1; continue; }
      }
      found.push({ kind: 'img', bytes, ext: 'png', box });
    }
  }
  return { images: found, stats };
}

// ---------------------------------------------------------- reading order --
// Recursive XY-cut over line/image boxes. A vertical cut (column gutter) starts
// a new ZONE; a horizontal cut only reorders. Returns items in reading order,
// each stamped with .zone.
function xyCut(items, zoneRef, zoneId, out, depth) {
  if (items.length <= 1 || depth > 14) { items.forEach((it) => { it.zone = zoneId; out.push(it); }); return; }
  const ms = median(items.map((it) => it.size || 10)) || 10;

  // 1. vertical gutter: an x-gap no item crosses, wide enough, both sides real
  const byX = items.slice().sort((a, b) => a.x0 - b.x0);
  let reach = byX[0].x1;
  let cutAt = -1;
  for (let k = 1; k < byX.length; k += 1) {
    if (byX[k].x0 - reach >= Math.max(9, ms * 0.9)) {
      const left = byX.slice(0, k);
      const right = byX.slice(k);
      const lw = median(left.map((it) => it.x1 - it.x0));
      const rw = median(right.map((it) => it.x1 - it.x0));
      if (left.length >= 3 && right.length >= 3 && lw >= ms * 6 && rw >= ms * 6) { cutAt = k; break; }
    }
    reach = Math.max(reach, byX[k].x1);
  }
  if (cutAt > 0) {
    xyCut(byX.slice(0, cutAt), zoneRef, ++zoneRef.n, out, depth + 1);
    xyCut(byX.slice(cutAt), zoneRef, ++zoneRef.n, out, depth + 1);
    return;
  }
  // 2. horizontal bands
  const byY = items.slice().sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const bands = [[byY[0]]];
  let bottom = byY[0].y1;
  for (let k = 1; k < byY.length; k += 1) {
    if (byY[k].y0 >= bottom) bands.push([byY[k]]);
    else bands[bands.length - 1].push(byY[k]);
    bottom = Math.max(bottom, byY[k].y1);
  }
  if (bands.length > 1) {
    for (const b of bands) xyCut(b, zoneRef, zoneId, out, depth + 1);
    return;
  }
  items.sort((a, b) => a.base - b.base || a.x0 - b.x0).forEach((it) => { it.zone = zoneId; out.push(it); });
}

// ------------------------------------------------------------- layout ------
function lineGeom(line) {
  const first = line.runs[0];
  const pad = line.size * 0.06;
  return {
    kind: 'line',
    line,
    size: line.pdf.size || line.size,
    base: first.org.y,
    x0: line.x + pad,
    x1: line.x + line.w - pad,
    y0: line.y,
    y1: line.y + line.h,
    zone: 0,
  };
}

function buildPageBlocks(lines, images, vp, kind) {
  const W = vp.width;
  const H = vp.height;
  const geoms = lines.map(lineGeom);
  // Pad the extent test a little so adjacent lines of one paragraph merge into
  // one horizontal band rather than being cut per line (their boxes touch).
  const imgItems = images.map((im) => ({ kind: 'img', im, size: 10, base: im.box.y1, x0: im.box.x0, x1: im.box.x1, y0: im.box.y0, y1: im.box.y1, zone: 0 }));

  // images that sit under text are backgrounds: anchored, not in the flow.
  const flow = [];
  const behind = [];
  for (const it of imgItems) {
    const area = (it.x1 - it.x0) * (it.y1 - it.y0);
    let under = false;
    const fullPage = area > W * H * 0.8;
    for (const g of geoms) {
      const ix = Math.max(0, Math.min(it.x1, g.x1) - Math.max(it.x0, g.x0));
      const iy = Math.max(0, Math.min(it.y1, g.y1) - Math.max(it.y0, g.y0));
      if (ix * iy > 0.5 * (g.x1 - g.x0) * (g.y1 - g.y0)) { under = true; break; }
    }
    if (kind === 'searchable-scan' && fullPage) { it.dropped = 'scan-background'; continue; }
    (under ? behind : flow).push(it);
  }

  const all = geoms.concat(flow);
  const ordered = [];
  const zoneRef = { n: 0 };
  xyCut(all, zoneRef, 0, ordered, 0);

  // page margins from the text itself
  const lefts = geoms.map((g) => g.x0);
  const rights = geoms.map((g) => g.x1);
  const marginL = lefts.length ? Math.max(12, Math.min(Math.min(...lefts), W * 0.35)) : 56;
  const marginR = rights.length ? Math.max(12, Math.min(W - Math.max(...rights), W * 0.35)) : 56;

  // zone geometry
  const zones = new Map();
  for (const g of geoms) {
    if (!zones.has(g.zone)) zones.set(g.zone, { xs: [], rs: [] });
    zones.get(g.zone).xs.push(g.x0);
    zones.get(g.zone).rs.push(g.x1);
  }
  for (const z of zones.values()) {
    z.left = percentile(z.xs, 0.05);
    z.right = percentile(z.rs, 0.9);
  }

  // rows: consecutive ordered line items in one zone whose baselines coincide
  const rows = [];
  for (const it of ordered) {
    if (it.kind === 'img') { rows.push({ img: it }); continue; }
    const last = rows[rows.length - 1];
    if (last && last.cells && last.zone === it.zone && Math.abs(last.base - it.base) <= 0.35 * Math.min(last.size, it.size)) {
      last.cells.push(it);
    } else rows.push({ cells: [it], zone: it.zone, base: it.base, size: it.size });
  }
  for (const r of rows) {
    if (r.cells) {
      r.cells.sort((a, b) => a.x0 - b.x0);
      r.left = r.cells[0].x0;
      r.right = Math.max(...r.cells.map((c) => c.x1));
      r.size = Math.max(...r.cells.map((c) => c.size));
    }
  }

  const blocks = [];
  let cursor = null; // estimated bottom (y, page pt) of the previous block
  const H_OF = (sz) => sz * 1.2;
  const place = (target, height, cap) => {
    const sb = cursor === null ? 0 : Math.max(0, target - cursor);
    cursor = (cursor === null ? target : Math.max(cursor, 0) + sb) + height;
    if (cursor === null || Number.isNaN(cursor)) cursor = target + height;
    return cap ? Math.min(sb, cap) : sb;
  };

  let para = null;
  const flush = () => {
    if (!para) return;
    const p = finishPara(para, zones.get(para.zone), marginL, W, marginR);
    const lineH = p.lineExact || H_OF(p.sizeMax);
    const nLines = para.rows.length;
    const target = para.rows[0].base - 0.8 * lineH;
    p.spaceBefore = place(target, lineH * nLines) || 0;
    p.spaceBefore = p.spaceBefore ? Math.round(p.spaceBefore * 10) / 10 : 0;
    blocks.push(p);
    para = null;
  };

  for (const r of rows) {
    if (r.img) {
      flush();
      const im = r.img;
      const w = Math.min(im.x1 - im.x0, W - marginL - marginR);
      const h = (im.y1 - im.y0) * (w / (im.x1 - im.x0));
      const sb = place(im.y0, h);
      blocks.push({ kind: 'img', bytes: im.im.bytes, ext: im.im.ext, wPt: w, hPt: h, indentLeft: Math.max(0, im.x0 - marginL), spaceBefore: sb });
      continue;
    }
    const z = zones.get(r.zone);
    const rowKind = classifyRow(r, z);
    if (rowKind.type === 'multi') {
      flush();
      const p = multiCellPara(r, marginL);
      const lineH = H_OF(p.sizeMax);
      p.lineExact = lineH;
      p.spaceBefore = place(r.base - 0.8 * lineH, lineH);
      blocks.push(p);
      continue;
    }
    const item = { row: r, base: r.base, size: r.size, left: r.left, right: r.right, runs: rowKind.runs, bullet: rowKind.bullet, marker: rowKind.marker, markerGap: rowKind.markerGap, left2: rowKind.left2, zone: r.zone };
    if (para && joinable(para, item, z)) {
      para.rows.push(item);
    } else {
      flush();
      para = { rows: [item], zone: r.zone };
    }
  }
  flush();

  const anchors = behind.map((it) => ({ kind: 'img', anchor: { x: it.x0, y: it.y0 }, bytes: it.im.bytes, ext: it.im.ext, wPt: it.x1 - it.x0, hPt: it.y1 - it.y0 }));
  const dropped = imgItems.filter((it) => it.dropped).length;
  const firstBase = rows.find((r) => r.cells || r.img);
  let top = 36;
  if (blocks.length) {
    const b0 = blocks[0];
    const lineH = b0.kind === 'img' ? 0 : (b0.lineExact || 12);
    const baseline0 = firstBase && firstBase.cells ? firstBase.base : (firstBase && firstBase.img ? firstBase.img.y0 + 0.8 * 0 : 40);
    top = firstBase && firstBase.img ? firstBase.img.y0 : baseline0 - 0.8 * lineH;
  }
  return {
    blocks: anchors.concat(blocks),
    marginPt: { top: Math.max(0, Math.min(top, H * 0.5)), right: marginR, bottom: 18, left: marginL },
    stats: { anchored: anchors.length, droppedBackground: dropped },
  };
}

// A justified line is stretched until the column guard (1.5em) splits it into
// cells: small gaps, ends flush with the text block's right edge. Not a table row.
function isStretchedLine(r, z) {
  const cells = r.cells;
  if (cells.length < 2 || !z) return false;
  let maxGap = 0;
  for (let k = 1; k < cells.length; k += 1) maxGap = Math.max(maxGap, cells[k].x0 - cells[k - 1].x1);
  return maxGap <= 3.2 * r.size && r.right >= z.right - 1.5 * r.size && cells.every((c) => c.line.splitReason === null || c.line.splitReason === undefined);
}

function classifyRow(r, z) {
  if (isStretchedLine(r, z)) {
    const runs = [];
    r.cells.forEach((c, k) => {
      const lr = lineRuns(c.line);
      if (k > 0 && runs.length) runs[runs.length - 1] = { ...runs[runs.length - 1], t: `${runs[runs.length - 1].t} ` };
      runs.push(...lr);
    });
    return { type: 'single', runs };
  }
  const cells = r.cells;
  if (cells.length === 1) {
    const runs = lineRuns(cells[0].line);
    const text = runs.map((x) => x.t).join('');
    const bm = BULLET_RE.exec(text);
    if (bm && bm[0].trim() && text.trim().length > bm[0].length) {
      // drop the marker from the first run(s)
      let cut = bm[0].length;
      const rr = [];
      for (const run of runs) {
        if (cut >= run.t.length) { cut -= run.t.length; continue; }
        rr.push({ ...run, t: run.t.slice(cut) });
        cut = 0;
      }
      return { type: 'single', runs: rr, bullet: true };
    }
    return { type: 'single', runs };
  }
  // a split-off list marker followed by its text: "a)" | text
  const c0 = cells[0].line;
  const t0 = c0.str.trim();
  if (cells.length === 2 && (c0.splitReason === 'marker' || NUM_MARKER_RE.test(t0) || BULLET_RE.test(t0 + ' ')) && t0.length <= 6) {
    const bulletOnly = BULLET_RE.test(t0 + ' ') && !/[\p{L}\p{N}]/u.test(t0);
    const runs = lineRuns(cells[1].line);
    if (bulletOnly) return { type: 'single', runs, bullet: true, markerGap: cells[1].x0 - cells[0].x0 };
    return { type: 'single', runs: [{ ...runs[0], t: `${t0}\t${runs[0].t}`, tabbed: true }].concat(runs.slice(1)), marker: t0, markerGap: cells[1].x0 - cells[0].x0, left2: cells[1].x0 };
  }
  return { type: 'multi' };
}

function multiCellPara(r, marginL) {
  const runs = [];
  const tabs = [];
  r.cells.forEach((c, k) => {
    if (k > 0) {
      runs.push({ t: '\t', f: 'Arial', sz: 8 });
      tabs.push(Math.round((c.x0 - r.left) * 10) / 10);
    }
    runs.push(...lineRuns(c.line));
  });
  const sizes = r.cells.map((c) => c.size);
  return { kind: 'p', runs, tabs, indentLeft: Math.max(0, r.left - marginL), sizeMax: Math.max(...sizes) };
}

function joinable(para, item, z) {
  const last = para.rows[para.rows.length - 1];
  if (item.bullet || item.marker) return false;
  const size = para.rows[0].size;
  if (Math.abs(item.size - size) > 0.12 * size) return false;
  const dy = item.base - last.base;
  if (dy <= 0.3 * size || dy > 1.9 * size) return false;
  if (para.rows.length >= 2) {
    const pitch = (last.base - para.rows[0].base) / (para.rows.length - 1);
    if (Math.abs(dy - pitch) > 0.3 * pitch) return false;
  }
  // bodyLeft: where wrapped lines start
  const bodyLeft = para.rows.length >= 2 ? para.rows[1].left : (para.rows[0].bullet || para.rows[0].marker ? para.rows[0].left2 || para.rows[0].left : null);
  if (bodyLeft !== null && bodyLeft !== undefined) {
    if (Math.abs(item.left - bodyLeft) > 0.8 * size) return false;
  } else if (Math.abs(item.left - last.left) > 3 * size) return false;
  // previous line must run to the right edge of the text block (else paragraph ended)
  const slack = Math.max(4.5 * size, 0.08 * (z.right - z.left));
  if (last.right < z.right - slack) return false;
  // a centred line is its own paragraph
  const centre = (z.left + z.right) / 2;
  if (Math.abs((last.left + last.right) / 2 - centre) < 0.6 * size && last.left - z.left > 2 * size) return false;
  // bold-only line vs regular line: different paragraphs
  const allBold = (it) => it.runs.every((x) => x.b || !x.t.trim());
  if (allBold(last) !== allBold(item)) return false;
  return true;
}

function finishPara(para, z, marginL, pageW, marginR) {
  const rows = para.rows;
  const n = rows.length;
  const first = rows[0];
  const sizeMax = Math.max(...rows.map((r) => r.size));
  // runs: join rows with a space; a hyphen at a wrap joins without one
  const runs = [];
  rows.forEach((r, k) => {
    if (k > 0) {
      const prevText = runs.length ? runs[runs.length - 1].t : '';
      if (!/[-­]$/.test(prevText) || /^[A-Z0-9]/.test(r.runs[0] ? r.runs[0].t : '')) {
        if (runs.length) runs[runs.length - 1] = { ...runs[runs.length - 1], t: `${prevText} ` };
      }
    }
    for (const x of r.runs) {
      const last = runs[runs.length - 1];
      if (last && last.b === x.b && last.i === x.i && last.f === x.f && last.sz === x.sz) last.t += x.t;
      else runs.push({ ...x });
    }
  });
  // trim edges
  if (runs.length) { runs[0].t = runs[0].t.replace(/^\s+/, ''); runs[runs.length - 1].t = runs[runs.length - 1].t.replace(/\s+$/, ''); }

  const centre = (z.left + z.right) / 2;
  let align = 'left';
  const bodyLeft = n >= 2 ? rows[1].left : first.left;
  if (n >= 2) {
    const inner = rows.slice(0, -1);
    const flush = inner.filter((r) => Math.abs(r.right - z.right) <= Math.max(2.5, 0.3 * first.size)).length;
    if (flush >= Math.max(2, Math.ceil(inner.length * 0.7))) align = 'both';
  } else {
    const c = (first.left + first.right) / 2;
    if (Math.abs(c - centre) <= 0.7 * first.size && first.left - z.left > 2 * first.size && z.right - first.right > 2 * first.size) align = 'center';
    else if (Math.abs(first.right - z.right) <= 1.5 && first.left - z.left > 6 * first.size) align = 'right';
  }

  const pitchArr = [];
  for (let k = 1; k < n; k += 1) pitchArr.push(rows[k].base - rows[k - 1].base);
  const pitch = n >= 2 ? median(pitchArr) : 0;
  const p = {
    kind: 'p',
    runs,
    align,
    sizeMax,
    zone: para.zone,
    lineExact: n >= 2 && pitch >= sizeMax * 0.9 && pitch <= sizeMax * 2.2 ? Math.round(pitch * 10) / 10 : Math.round(sizeMax * 1.2 * 10) / 10,
  };
  if (first.bullet) {
    p.list = 'bullet';
    p.indentLeft = Math.max(0, (n >= 2 ? rows[1].left : first.left) - marginL);
    p.indentFirst = -Math.min(18, Math.max(6, first.markerGap || 14));
  } else if (first.marker) {
    p.indentLeft = Math.max(0, (first.left2 || bodyLeft) - marginL);
    p.indentFirst = -Math.max(6, (first.left2 || bodyLeft) - first.left);
    p.tabs = [Math.round((first.left2 || bodyLeft) - marginL)];
  } else {
    p.indentLeft = Math.max(0, bodyLeft - marginL);
    if (n >= 2 && first.left - rows[1].left > 0.5 * first.size) p.indentFirst = first.left - rows[1].left;
    else if (n >= 2 && rows[1].left - first.left > 0.5 * first.size) p.indentFirst = -(rows[1].left - first.left);
  }
  if (n >= 2) {
    const maxRight = Math.max(...rows.map((r) => r.right));
    p.indentRight = Math.max(0, Math.round((pageW - marginR - maxRight) * 10) / 10);
  }
  // right-to-left paragraph
  const text = runs.map((x) => x.t).join('');
  const rtl = (text.match(RTL_RE) || []).length;
  if (rtl > text.replace(/\s/g, '').length * 0.5) {
    p.rtl = true;
    p.runs = runs.map((x) => ({ ...x, rtl: true }));
    if (p.align === 'left') p.align = 'right';
    else if (p.align === 'right') p.align = 'left';
  }
  return p;
}

// -------------------------------------------------------------- driver -----
export async function pdfToDocModel({ pdfjs, fflate, data, onProgress, maxPages }) {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(data), disableFontFace: true, isEvalSupported: false, verbosity: 0, fontExtraProperties: true }).promise;
  const state = { fflate, imageCache: new Map() };
  const pages = [];
  const stats = { pages: pdf.numPages, pageKinds: { text: 0, 'searchable-scan': 0, scan: 0, empty: 0 }, imageMasksSkipped: 0, imagesFailed: 0, anchored: 0, droppedBackground: 0, errors: [], lines: 0 };
  const limit = maxPages ? Math.min(maxPages, pdf.numPages) : pdf.numPages;
  for (let i = 1; i <= limit; i += 1) {
    const page = await pdf.getPage(i);
    try {
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const ops = await page.getOperatorList();
      const fontInfo = new Map();
      for (const name of new Set(tc.items.map((it) => it.fontName))) {
        let fo = null;
        try { fo = page.commonObjs.get(name); } catch { /* font not resolved */ }
        fontInfo.set(name, fontInfoOf(fo, (tc.styles[name] || {}).fontFamily));
      }
      const hasTextItems = tc.items.some((it) => it.str && it.str.trim());
      let kind = 'empty';
      if (hasTextItems) kind = (await pageHasVisibleText(page, pdfjs)) ? 'text' : 'searchable-scan';
      const { runs } = hasTextItems ? await extractRuns(pdfjs, page, tc, fontInfo) : { runs: [] };
      const lines = groupRunsIntoLines(runs);
      stats.lines += lines.length;
      const { images, stats: istats } = await extractImages(pdfjs, page, ops, vp, state);
      if (!hasTextItems && images.length) kind = 'scan';
      stats.pageKinds[kind] += 1;
      stats.imageMasksSkipped += istats.masks;
      stats.imagesFailed += istats.failed;
      const built = buildPageBlocks(lines, images, vp, kind);
      stats.anchored += built.stats.anchored;
      stats.droppedBackground += built.stats.droppedBackground;
      pages.push({ widthPt: vp.width, heightPt: vp.height, marginPt: built.marginPt, blocks: built.blocks, kind });
    } catch (e) {
      stats.errors.push(`p${i}: ${e && e.message}`);
      pages.push({ widthPt: 595, heightPt: 842, marginPt: { top: 36, right: 36, bottom: 18, left: 36 }, blocks: [], kind: 'error' });
    }
    page.cleanup();
    if (onProgress) onProgress(i, limit);
  }
  await pdf.destroy();
  return { model: { pages }, stats };
}

export async function convertPdfToDocx({ pdfjs, fflate, data, onProgress, maxPages }) {
  const { model, stats } = await pdfToDocModel({ pdfjs, fflate, data, onProgress, maxPages });
  return { docx: buildDocx(model, { fflate }), stats, model };
}
