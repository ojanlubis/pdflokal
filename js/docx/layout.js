/*
 * PDFLokal — docx/layout.js  (LAYOUT: reading order, columns, rows, paragraphs)
 * ============================================================================
 * Text lines (ctx.lines) in, Word segments and paragraphs out. Heuristic and all
 * measured by scripts/docx-gate.mjs:
 *   - reading order (recursive XY-cut: column gutters first, then row bands)
 *   - rows (lines sharing a baseline) -> tab-separated "cells"
 *   - paragraph merge (lines -> paragraphs by spacing, edge and fullness)
 *   - list markers, justified/centred/right alignment, RTL, hanging indents
 *
 *   layoutPage(ctx) -> { segments, stats }
 *       Reads ctx.lines (extract.groupLines) and ctx.tables (tables.detectTables):
 *       lines a table consumed are dropped from the flow and the table block is
 *       placed in reading order by its box. Images and shapes are NOT its business
 *       (they are Page.anchors; images.js / color.js).
 *   paragraphsOfLines(lines, ctx, zone) -> Para[]
 *       The same row/paragraph machinery without page positioning: what a table
 *       cell uses to turn its lines into paragraphs. `zone` = {left, right} page pt.
 *
 * Also exported for lanes that need to reuse a piece: xyCut, segmentsOf, classifyRow,
 * joinable, finishPara, multiCellPara.
 */

import { styledRuns } from './extract.js';
import { SPACE_GAP_FACTOR } from '../core/text-lines.js';
import { median, percentile } from './model.js';

const BULLET_RE = new RegExp('^[\\u2022\\u25CF\\u25CB\\u25E6\\u25AA\\u25A0\\u25A1\\u2023\\u2043\\u2219\\u00B7\\uF0B7\\uF0A7\\uF0D8\\uF076\\u2013\\u2014*-]\\s*');
const NUM_MARKER_RE = /^(\(?\d{1,3}([.)]\d*)*[.)]|\(?[A-Za-z][.)]|\(?[ivxIVX]{1,4}[.)])$/;
const RTL_RE = new RegExp('[\\u0590-\\u08FF\\uFB1D-\\uFDFF\\uFE70-\\uFEFE]', 'g');


// ------------------------------------------------- narrow-gutter columns ---
// A column gutter narrower than the line grouper's guard (1.5em) never splits a
// line: the grouper hands over ONE "line" holding a row of the left column and a
// row of the right, and the line-level cut above can never see the gutter (journal
// and newspaper pages, about 8-14pt between columns). So the same sweep runs one
// level down, over RUN boxes; a line the cut falls through is split into its left
// and right runs. The evidence bar is higher than for the line-level cut (it is
// only reached when that one failed): >= 5 pieces and prose-width pieces on both
// sides, and text that runs up to the gutter on both sides (flush or ragged text
// column), so a label | value list does not qualify.
const alongOf = (r) => { const a0 = r.pdf.x0 * r.pdf.ux + r.pdf.y0 * r.pdf.uy; return [a0, a0 + r.pdf.len]; };

// A Line made of a subset of another line's runs (the same fields text-lines.js fills).
export function lineOfRuns(proto, runs) {
  if (runs.length === proto.runs.length) return proto;
  let str = runs[0].str;
  for (let k = 1; k < runs.length; k += 1) {
    const gap = alongOf(runs[k])[0] - alongOf(runs[k - 1])[1];
    if (gap > SPACE_GAP_FACTOR * runs[k - 1].pdf.size && !/\s$/.test(str) && !/^\s/.test(runs[k].str)) str += ' ';
    str += runs[k].str;
  }
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  let dominant = runs[0];
  for (const r of runs) {
    minX = Math.min(minX, r.x); minY = Math.min(minY, r.y); maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
    if (r.pdf.len > dominant.pdf.len) dominant = r;
  }
  const a0 = Math.min(...runs.map((r) => alongOf(r)[0]));
  const a1 = Math.max(...runs.map((r) => alongOf(r)[1]));
  return {
    str, x: minX, y: minY, w: maxX - minX, h: maxY - minY, size: dominant.size, fontName: dominant.fontName, fontFamily: dominant.fontFamily,
    pdf: { x0: runs[0].pdf.x0, y0: runs[0].pdf.y0, ux: dominant.pdf.ux, uy: dominant.pdf.uy, len: a1 - a0, size: dominant.pdf.size },
    runs, splitReason: null,
  };
}

// Items (line geoms) -> the pieces on each side of x = cx. A line with runs on both sides is split.
function piecesAt(items, cx) {
  const left = []; const right = [];
  for (const it of items) {
    if (it.kind === 'line' && it.line.runs.length > 1) {
      const lr = it.line.runs.filter((r) => r.x + r.w / 2 < cx);
      const rr = it.line.runs.filter((r) => r.x + r.w / 2 >= cx);
      if (lr.length && rr.length) { left.push(lineGeom(lineOfRuns(it.line, lr))); right.push(lineGeom(lineOfRuns(it.line, rr))); continue; }
    }
    ((it.x0 + it.x1) / 2 < cx ? left : right).push(it);
  }
  return { left, right };
}

function narrowGutterCut(items, ms) {
  if (items.length < 8) return null;
  const boxes = [];
  for (const it of items) {
    if (it.kind === 'line' && it.line.runs.length > 1) for (const r of it.line.runs) boxes.push({ x0: r.x + r.size * 0.06, x1: r.x + r.w - r.size * 0.06 });
    else boxes.push({ x0: it.x0, x1: it.x1 });
  }
  boxes.sort((a, b) => a.x0 - b.x0);
  const lo = boxes[0].x0;
  const hi = Math.max(...boxes.map((b) => b.x1));
  let reach = boxes[0].x1;
  for (let k = 1; k < boxes.length; k += 1) {
    const gap = boxes[k].x0 - reach;
    const cx = (reach + boxes[k].x0) / 2;
    // central, wide enough to be a gutter and not just a wide word space
    if (gap >= Math.max(4.5, ms * 0.4) && cx > lo + (hi - lo) * 0.2 && cx < hi - (hi - lo) * 0.2) {
      const { left, right } = piecesAt(items, cx);
      if (left.length >= 5 && right.length >= 5) {
        const lw = median(left.map((g) => g.x1 - g.x0));
        const rw = median(right.map((g) => g.x1 - g.x0));
        const edgeL = percentile(left.map((g) => g.x1), 0.9);
        const edgeR = percentile(right.map((g) => g.x0), 0.1);
        const flushL = left.filter((g) => g.x1 >= edgeL - 2.5 * ms).length / left.length;
        const flushR = right.filter((g) => g.x0 <= edgeR + 2.5 * ms).length / right.length;
        if (lw >= ms * 6 && rw >= ms * 6 && flushL >= 0.3 && flushR >= 0.3 && edgeR - edgeL <= 4 * ms) return { left, right };
      }
    }
    reach = Math.max(reach, boxes[k].x1);
  }
  return null;
}

// The line-level gutter: an x-gap no item crosses, wide enough, real text on both sides.
function gutterCut(items, ms) {
  const byX = items.slice().sort((a, b) => a.x0 - b.x0);
  let reach = byX[0].x1;
  for (let k = 1; k < byX.length; k += 1) {
    if (byX[k].x0 - reach >= Math.max(9, ms * 0.9)) {
      const left = byX.slice(0, k);
      const right = byX.slice(k);
      const lw = median(left.map((it) => it.x1 - it.x0));
      const rw = median(right.map((it) => it.x1 - it.x0));
      if (left.length >= 3 && right.length >= 3 && lw >= ms * 6 && rw >= ms * 6) return { left, right };
    }
    reach = Math.max(reach, byX[k].x1);
  }
  return null;
}
const verticalSplit = (items, ms) => gutterCut(items, ms) || narrowGutterCut(items, ms);

// ---- columns that a heading cuts across ------------------------------------
// The sweep above sees the page as a whole: ONE line that spans both columns (a headline,
// a pull quote) hides the gutter from every row, and the horizontal cut then slices the
// page into rows and reads the columns row by row, the left line and the right line
// of each baseline together. So the bands are grouped first: consecutive bands that share
// a free x-gap form one RUN, and a run is cut at its gutter. A band that crosses the gap
// (the headline) ends the run and is read in place, before or after the columns.
const intersect = (A, B, minGap) => {
  const out = [];
  for (const a of A) for (const b of B) { const x0 = Math.max(a[0], b[0]); const x1 = Math.min(a[1], b[1]); if (x1 - x0 >= minGap) out.push([x0, x1]); }
  return out;
};
const boxesOf = (items) => {
  const boxes = [];
  for (const it of items) {
    if (it.kind === 'line' && it.line.runs.length > 1) for (const r of it.line.runs) boxes.push([r.x + r.size * 0.06, r.x + r.w - r.size * 0.06]);
    else boxes.push([it.x0, it.x1]);
  }
  return boxes.sort((a, b) => a[0] - b[0]);
};
const freeOf = (items, lo, hi, minGap) => {
  const out = [];
  let at = lo;
  for (const [x0, x1] of boxesOf(items)) { if (x0 - at >= minGap) out.push([at, x0]); at = Math.max(at, x1); }
  if (hi - at >= minGap) out.push([at, hi]);
  return out;
};

// Items of consecutive bands that read as columns: a run of >= 4 bands, text on both sides of a
// gutter that is continuous prose (each side stacked at line pitch), not a label | value list.
function columnRun(bands, ms) {
  const items = bands.flat();
  if (bands.length < 4 || items.length < 8) return null;
  const sp = verticalSplit(items, ms);
  if (!sp) return null;
  for (const side of [sp.left, sp.right]) {
    if (side.length < 4) return null;
    if (median(side.map((g) => g.x1 - g.x0)) < ms * 10) return null;
    const s = side.slice().sort((a, b) => a.y0 - b.y0);
    let tight = 0;
    for (let k = 1; k < s.length; k += 1) if (s[k].y0 - s[k - 1].y1 <= 0.9 * ms) tight += 1;
    if (tight < (s.length - 1) * 0.6) return null;
  }
  return sp;
}

// A vertical gap between bands that is large next to the column gutter is a CARD / ROW boundary
// (a photo band between two rows of cards, a chart between the text above and below): read the
// rows one after the other, not the columns of the whole page.
const bigGap = (gapY, gutterW, ms) => gapY >= Math.max(3 * gutterW, 4 * ms);
function bandsOf(items) {
  const byY = items.slice().sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const bands = [[byY[0]]];
  const gaps = [];
  let bottom = byY[0].y1;
  for (let k = 1; k < byY.length; k += 1) {
    if (byY[k].y0 >= bottom) { gaps.push(byY[k].y0 - bottom); bands.push([byY[k]]); } else bands[bands.length - 1].push(byY[k]);
    bottom = Math.max(bottom, byY[k].y1);
  }
  return { bands, gaps };
}
// A big gap with real text (>= 4 lines) on both sides of it.
function splitsBands(bands, gaps, gutterW, ms) {
  let above = 0;
  const total = bands.reduce((n, b) => n + b.length, 0);
  for (let k = 0; k < gaps.length; k += 1) {
    above += bands[k].length;
    if (bigGap(gaps[k], gutterW, ms) && above >= 4 && total - above >= 4) return true;
  }
  return false;
}
// Columns across the page: 1 + the gutters found by cutting again inside each side.
function columnCount(items, ms, depth = 0) {
  if (depth > 3 || items.length < 6) return 1;
  const v = verticalSplit(items, ms);
  return v ? columnCount(v.left, ms, depth + 1) + columnCount(v.right, ms, depth + 1) : 1;
}
const gutterWidth = (sp) => Math.max(6, Math.min(...sp.right.map((g) => g.x0)) - Math.max(...sp.left.map((g) => g.x1)));

function bandRuns(bands, gaps, items, ms, grid) {
  const lo = Math.min(...items.map((i) => i.x0));
  const hi = Math.max(...items.map((i) => i.x1));
  const minGap = Math.max(4.5, ms * 0.4);
  const central = [[lo + (hi - lo) * 0.15, hi - (hi - lo) * 0.15]];
  const runs = [];
  let cur = null;
  for (let bi = 0; bi < bands.length; bi += 1) {
    const b = bands[bi];
    const free = freeOf(b, lo, hi, minGap);
    const g = cur ? intersect(cur.gap, free, minGap) : intersect(central, free, minGap);
    const wide = cur && Math.max(...cur.gap.map((x) => x[1] - x[0]));
    if (cur && g.length && !(grid && bigGap(gaps[bi - 1], wide, ms))) { cur.bands.push(b); cur.gap = g; continue; }
    cur = { bands: [b], gap: intersect(central, free, minGap) };
    runs.push(cur);
  }
  return runs;
}

// ---------------------------------------------------------- reading order --
// Recursive XY-cut over line/image boxes. A vertical cut (column gutter) starts
// a new ZONE; a horizontal cut only reorders. Returns items in reading order,
// each stamped with .zone.
export function xyCut(items, zoneRef, zoneId, out, depth) {
  if (items.length <= 1 || depth > 14) { items.forEach((it) => { it.zone = zoneId; out.push(it); }); return; }
  const ms = median(items.map((it) => it.size || 10)) || 10;

  const { bands, gaps } = bandsOf(items);
  // 1. vertical gutter: an x-gap no item crosses (line level, then inside the lines)
  const v = verticalSplit(items, ms);
  const grid = !!v && bands.length > 1 && splitsBands(bands, gaps, gutterWidth(v), ms) && columnCount(items, ms) >= 3;
  if (v && !grid) {
    xyCut(v.left, zoneRef, ++zoneRef.n, out, depth + 1);
    xyCut(v.right, zoneRef, ++zoneRef.n, out, depth + 1);
    return;
  }
  // 2. horizontal bands
  if (bands.length > 1) {
    for (const run of bandRuns(bands, gaps, items, ms, columnCount(items, ms) >= 3)) {
      const cs = run.bands.length >= 4 ? columnRun(run.bands, ms) : null;
      if (cs) {
        xyCut(cs.left, zoneRef, ++zoneRef.n, out, depth + 1);
        xyCut(cs.right, zoneRef, ++zoneRef.n, out, depth + 1);
      } else for (const b of run.bands) xyCut(b, zoneRef, zoneId, out, depth + 1);
    }
    return;
  }
  items.sort((a, b) => a.base - b.base || a.x0 - b.x0).forEach((it) => { it.zone = zoneId; out.push(it); });
}

// A running header / page number / footer is read before / after the body whatever its x is
// (a centred page number would otherwise land at the tail of the left column). Peeled only
// when it sits in the outer 12% of the page and a clear gap separates it from the rest.
export function peelEdges(geoms, H, W) {
  const none = { head: [], body: geoms, foot: [] };
  if (geoms.length < 4) return none;
  const ms = median(geoms.map((g) => g.size || 10)) || 10;
  const byY = geoms.slice().sort((a, b) => a.y0 - b.y0);
  let head = 0;
  let bottom = byY[0].y1;
  for (let k = 1; k < byY.length; k += 1) {
    if (byY[k].y0 - bottom >= 0.7 * ms && bottom <= H * 0.12) { head = k; break; }
    bottom = Math.max(bottom, byY[k].y1);
    if (bottom > H * 0.12) break;
  }
  // A header that sits right on the body (no gap: a journal running head over one column) is told
  // from the first line of a column by what it is not: not the column's type size, or not its line
  // pitch, and by sitting off the page's centre.
  if (head === 0 && geoms.length >= 8 && byY[0].y0 <= H * 0.08 && byY[1].y0 >= byY[0].y1 - 1.5) {
    const rest = byY.slice(1);
    const rms = median(rest.map((g) => g.size || 10)) || 10;
    const bases = rest.map((g) => g.base).sort((a, b) => a - b);
    const diffs = [];
    for (let k = 1; k < bases.length; k += 1) if (bases[k] - bases[k - 1] > 0.5 * rms) diffs.push(bases[k] - bases[k - 1]);
    const pitch = diffs.length ? median(diffs) : 0;
    const sizeOdd = Math.abs((byY[0].size || 10) - rms) > 0.15 * rms;
    const pitchOdd = pitch > 0 && Math.abs(Math.min(...rest.filter((g) => g.base > byY[0].base).map((g) => g.base)) - byY[0].base - pitch) > 0.25 * pitch;
    if (sizeOdd || pitchOdd) {
      // on a page with text in both halves (columns), off the page's centre (a centred title
      // belongs to the lines under it) and narrower than the text block
      const h = byY[0];
      const hc = (h.x0 + h.x1) / 2;
      const inLeft = rest.filter((g) => g.x1 <= 0.55 * W).length;
      const inRight = rest.filter((g) => g.x0 >= 0.45 * W).length;
      if (Math.abs(hc - W / 2) > 0.1 * W && h.x1 - h.x0 < 0.7 * W && inLeft >= 8 && inRight >= 8) head = 1;
    }
  }
  let foot = byY.length;
  let top = byY[byY.length - 1].y0;
  for (let k = byY.length - 2; k >= head; k -= 1) {
    if (top - byY[k].y1 >= 0.7 * ms && top >= H * 0.88) { foot = k + 1; break; }
    top = Math.min(top, byY[k].y0);
    if (top < H * 0.88) break;
  }
  if (head === 0 && foot === byY.length) return none;
  return { head: byY.slice(0, head), body: byY.slice(head, foot), foot: byY.slice(foot) };
}


const STOCK_FONT_RE = /^(times|arial|helvetica|courier|calibri|cambria|georgia|verdana|tahoma|trebuchet|garamond|palatino|book antiqua|bookman|century|candara|consolas|constantia|corbel|segoe|comic sans|impact|lucida|symbol|wingdings|liberation|dejavu|noto|carlito|caladea|roboto|open sans|cambria math|franklin gothic|gill sans|rockwell|tw cen|aptos|georgia)/i;
export const stockFont = (name) => STOCK_FONT_RE.test(String(name || '').trim());
// The font that sets most of a paragraph's characters.
export function dominantFont(runs) {
  const by = new Map();
  for (const r of runs) by.set(r.f, (by.get(r.f) || 0) + String(r.t).length);
  let best = ''; let n = -1;
  for (const [f, c] of by) if (c > n) { best = f; n = c; }
  return best;
}

// ---------------------------------------------- a word broken at the line end ---
// How the last line's text and the next line's text meet:
//   'soft'  a typesetter's hyphenation (pro- | gram): the hyphen becomes a SOFT hyphen, which Word
//           shows only where it breaks a line, so the word is one word again in the text
//   'keep'  a real hyphen (sehari- | hari, Covid- | 19, non- | aktif): glued, hyphen kept
//   'space' no hyphen at the end: an ordinary line wrap
// Soft only when both halves are lowercase letters (>= 2 of them), the word is not a reduplication
// (Indonesian "sehari-hari": the next part repeats the end of the first), and the first half is not
// a prefix that is written with a hyphen.
const SOFT_HYPHEN = '\u00AD';
const HYPHEN_PREFIX = new Set(['non', 'anti', 'pasca', 'pra', 'semi', 'sub', 'inter', 'intra', 'ex', 'pre', 'post', 'co', 'mid', 'self', 'all', 'ke', 'se', 'ber', 'yang']);
export function wrapJoin(prevAll, nextText) {
  if (prevAll.endsWith(SOFT_HYPHEN)) return 'keep';
  if (!/[-\u2010]$/.test(prevAll)) return 'space';
  const next = String(nextText || '').replace(/^\s+/, '');
  if (/^[\p{Lu}\p{N}]/u.test(next)) return /[\p{L}\p{N}][-\u2010]$/u.test(prevAll) ? 'keep' : 'space';
  const wm = /(\p{Ll}+)[-\u2010]$/u.exec(prevAll);
  const nm = /^(\p{Ll}+)/u.exec(next);
  if (!wm || !nm || wm[1].length < 2 || nm[1].length < 2) return 'keep';
  const w = wm[1];
  const nw = nm[1];
  if (HYPHEN_PREFIX.has(w) || w.endsWith(nw) || nw.endsWith(w) || nw.startsWith(w)) return 'keep';
  return 'soft';
}

// ------------------------------------------------------------- layout ------
export function lineGeom(line) {
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

// Split the reading-ordered items into SEGMENTS: runs of items in one zone are
// single-column text; consecutive runs in different zones whose x-ranges are
// disjoint, similar in width and overlapping in y are ONE multi-column band
// (Word columns, continuous section). Anything stranger stays single-flow.
export function segmentsOf(ordered, pageW, pageH) {
  const runs = [];
  for (const it of ordered) {
    const last = runs[runs.length - 1];
    if (last && last.zone === it.zone) last.items.push(it);
    else runs.push({ zone: it.zone, items: [it] });
  }
  for (const r of runs) {
    r.x0 = Math.min(...r.items.map((i) => i.x0));
    r.x1 = Math.max(...r.items.map((i) => i.x1));
    r.y0 = Math.min(...r.items.map((i) => i.y0));
    r.y1 = Math.max(...r.items.map((i) => i.y1));
  }
  const segs = [];
  let k = 0;
  while (k < runs.length) {
    const group = [runs[k]];
    while (k + group.length < runs.length) {
      const nxt = runs[k + group.length];
      const prev = group[group.length - 1];
      const ov = Math.min(prev.y1, nxt.y1) - Math.max(prev.y0, nxt.y0);
      const span = Math.min(prev.y1 - prev.y0, nxt.y1 - nxt.y0);
      const wide = Math.max(nxt.x1 - nxt.x0, prev.x1 - prev.x0);
      const narrow = Math.min(nxt.x1 - nxt.x0, prev.x1 - prev.x0);
      // a block of a page's columns: big, or short but made of prose-width lines (a label | value
      // block is short and narrow: its labels must not be joined into one paragraph)
      const real = (r) => (r.items.length >= 6 && r.x1 - r.x0 >= pageW * 0.25 && r.y1 - r.y0 >= pageH * 0.2)
        || (r.items.length >= 3 && r.x1 - r.x0 >= pageW * 0.15 && r.y1 - r.y0 >= pageH * 0.03
          && median(r.items.map((i) => i.x1 - i.x0)) >= 12 * median(r.items.map((i) => i.size || 10)));
      if (nxt.x0 >= prev.x1 && nxt.zone !== prev.zone && span > 0 && ov > 0.5 * span && narrow >= 0.7 * wide && group.length < 3
        && real(prev) && real(nxt) && !group.some((g) => g.zone === nxt.zone)) group.push(nxt);
      else break;
    }
    if (group.length >= 2) segs.push({ cols: group.length, runs: group });
    else segs.push({ cols: 1, runs: group });
    k += group.length;
  }
  return segs;
}

const H_OF = (sz) => sz * 1.2;

// Lines sharing a baseline form a row (a table item is always a row of its own).
function rowsOf(items) {
  const rows = [];
  for (const it of items) {
    const last = rows[rows.length - 1];
    if (it.kind !== 'tbl' && last && !last.tbl && Math.abs(last.base - it.base) <= 0.35 * Math.min(last.size, it.size)) last.cells.push(it);
    else rows.push({ cells: [it], base: it.base, size: it.size, tbl: it.kind === 'tbl' ? it : null });
  }
  for (const r of rows) {
    r.cells.sort((a, b) => a.x0 - b.x0);
    r.left = r.cells[0].x0;
    r.right = Math.max(...r.cells.map((c) => c.x1));
    r.size = Math.max(...r.cells.map((c) => c.size));
  }
  return rows;
}

// Rows -> paragraphs. `sink` receives what comes out, in order:
//   sink.para(p, paraRows)  a merged paragraph and the rows it came from
//   sink.multi(p, row)      a tab-separated multi-cell row as one paragraph
//   sink.table(item, row)   a table item (from ctx.tables) standing where it falls
function assembleRows(rows, zone, origin, colRight, sink) {
  let para = null;
  const flush = () => {
    if (!para) return;
    sink.para(finishPara(para, zone, origin, colRight), para.rows);
    para = null;
  };
  for (const r of rows) {
    if (r.tbl) { flush(); sink.table(r.tbl, r); continue; }
    const rk = classifyRow(r, zone);
    if (rk.type === 'multi') {
      flush();
      sink.multi(multiCellPara(r, origin), r);
      continue;
    }
    const item = { row: r, base: r.base, size: r.size, left: r.left, right: r.right, runs: rk.runs, bullet: rk.bullet, marker: rk.marker, markerGap: rk.markerGap, left2: rk.left2 };
    if (para && joinable(para, item, zone)) para.rows.push(item);
    else { flush(); para = { rows: [item] }; }
  }
  flush();
}

export function layoutPage(ctx) {
  const W = ctx.widthPt;
  const H = ctx.heightPt;
  const claims = ctx.tables || [];
  const consumed = new Set();
  for (const c of claims) for (const l of c.lines || []) consumed.add(l);
  const geoms = ctx.lines.filter((l) => !consumed.has(l)).map(lineGeom);
  for (const c of claims) {
    const hs = (c.lines || []).map((l) => l.pdf.size || l.size);
    geoms.push({ kind: 'tbl', claim: c, size: hs.length ? median(hs) : 10, base: c.y0, x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1, zone: 0 });
  }

  const ordered = [];
  const { head, body, foot } = peelEdges(geoms, H, W);
  const zref = { n: 0 };
  // Only a footer that sits at the page's very foot (its bottom within 7% of the page's) gets the
  // cushion: the last heading of a page, 80pt up, sits where it sits.
  for (const g of foot) if (H - g.y1 <= 0.07 * H) g.edge = 'foot';
  for (const part of [head, body, foot]) if (part.length) xyCut(part.slice(), zref, ++zref.n, ordered, 0);
  const segs = segmentsOf(ordered, W, H);

  const pageLefts = geoms.map((g) => g.x0);
  const pageRights = geoms.map((g) => g.x1);
  const pageMarginL = pageLefts.length ? Math.max(12, Math.min(Math.min(...pageLefts), W * 0.35)) : 56;
  const pageMarginR = pageRights.length ? Math.max(12, Math.min(W - Math.max(...pageRights), W * 0.35)) : 56;

  let cursor = null; // estimated bottom (y, page pt) of the previous block
  // A footer / page number sits at the very bottom of the page; the page's own
  // bottom margin would push it onto an extra page. Pull any block up so it ends
  // inside the page (the section's bottom margin is 0 for the same reason).
  // Word wraps a few paragraphs onto one line more than the PDF did and the estimate above never
  // sees it: the body drifts down and the footer lands on a page of its own (MEASURED: a 12-page
  // journal grew to 20 pages, each extra page holding only the footer). So the first footer block
  // is pulled up by a cushion (<= 6 lines, <= 90% of its gap): the footer sits a little higher and
  // the drift is absorbed instead of spilling. The cursor still advances as if it had not moved.
  let footSeen = false;
  const place = (target0, height, edge, lineH) => {
    const target = Math.min(target0, H - height - 1);
    let sb = cursor === null ? 0 : Math.max(0, target - cursor);
    let cushion = 0;
    if (edge === 'foot' && !footSeen && cursor !== null) {
      footSeen = true;
      cushion = Math.min(0.9 * sb, 6 * lineH);
      sb -= cushion;
    }
    cursor = (cursor === null ? target : cursor + sb + cushion) + height;
    return sb;
  };

  const segments = [];
  let firstTop = null;
  let tablesPlaced = 0;
  for (const seg of segs) {
    const segItems = seg.runs.flatMap((r) => r.items);
    // Single-column segments share the PAGE margins; only a column band gets its own.
    const marginL = seg.cols > 1 ? Math.max(12, Math.min(Math.min(...segItems.map((g) => g.x0)), W * 0.4)) : pageMarginL;
    const marginR = seg.cols > 1 ? Math.max(12, Math.min(W - Math.max(...segItems.map((g) => g.x1)), W * 0.4)) : pageMarginR;
    const out = { cols: seg.cols, space: 0, marginPt: { top: 0, right: marginR, bottom: 0, left: marginL }, blocks: [] };
    if (seg.cols > 1) {
      const gaps = [];
      for (let k = 1; k < seg.runs.length; k += 1) gaps.push(seg.runs[k].x0 - seg.runs[k - 1].x1);
      out.space = Math.max(6, Math.min(...gaps));
    }
    const bandTop = cursor;
    let bandEnd = cursor;
    seg.runs.forEach((run, ri) => {
      if (ri > 0) cursor = bandTop;
      const zone = { left: Math.min(...run.items.map((g) => g.x0)), right: percentile(run.items.map((g) => g.x1), 0.9), axis: seg.cols > 1 ? null : W / 2 };
      const origin = seg.cols > 1 ? zone.left : marginL;
      const colRight = seg.cols > 1 ? Math.max(...run.items.map((g) => g.x1)) : W - marginR;
      const rows = rowsOf(run.items);
      const startBlock = out.blocks.length;
      assembleRows(rows, zone, origin, colRight, {
        para(p, paraRows) {
          const lineH = p.lineExact || H_OF(p.sizeMax);
          const target = paraRows[0].base - 0.8 * lineH;
          if (firstTop === null) firstTop = Math.max(0, target);
          p.spaceBefore = Math.round(place(target, lineH * paraRows.length, paraRows[0].row.cells[0].edge, lineH) * 10) / 10;
          out.blocks.push(p);
        },
        multi(p, r) {
          const lineH = H_OF(p.sizeMax);
          p.lineExact = lineH;
          if (firstTop === null) firstTop = Math.max(0, r.base - 0.8 * lineH);
          p.spaceBefore = Math.round(place(r.base - 0.8 * lineH, lineH, r.cells[0].edge, lineH) * 10) / 10;
          out.blocks.push(p);
        },
        table(item) {
          const t = item.claim;
          const h = Math.max(1, t.y1 - t.y0);
          if (firstTop === null) firstTop = Math.max(0, t.y0);
          const spaceBefore = Math.round(place(t.y0, h) * 10) / 10;
          out.blocks.push({ ...t.block, spaceBefore, indentLeft: Math.max(0, Math.round((t.x0 - origin) * 10) / 10) });
          tablesPlaced += 1;
        },
      });
      bandEnd = Math.max(bandEnd === null ? 0 : bandEnd, cursor === null ? 0 : cursor);
      // a column break closes every column of a band but the last
      if (seg.cols > 1 && ri < seg.runs.length - 1 && out.blocks.length > startBlock) out.blocks[out.blocks.length - 1].colBreakAfter = true;
    });
    if (seg.cols > 1) cursor = bandEnd;
    segments.push(out);
  }
  if (!segments.length) segments.push({ cols: 1, space: 0, marginPt: { top: 36, right: pageMarginR, bottom: 0, left: pageMarginL }, blocks: [] });
  segments[0].marginPt.top = Math.max(0, Math.min(firstTop === null ? 36 : firstTop, H * 0.5));
  for (let k = 1; k < segments.length; k += 1) segments[k].marginPt.top = segments[0].marginPt.top;
  return { segments, stats: { columnBands: segments.filter((s) => s.cols > 1).length, tables: tablesPlaced } };
}

// Lines -> paragraphs, no page positioning: what a table cell does with its lines.
export function paragraphsOfLines(lines, ctx, zone) {
  const items = lines.map(lineGeom).sort((a, b) => a.base - b.base || a.x0 - b.x0);
  const rows = rowsOf(items);
  const paras = [];
  const left = zone ? zone.left : Math.min(...items.map((g) => g.x0));
  const right = zone ? zone.right : Math.max(...items.map((g) => g.x1));
  const z = { left, right };
  assembleRows(rows, z, left, right, {
    para(p) { delete p.sizeMax; paras.push(p); },
    multi(p) { p.lineExact = H_OF(p.sizeMax); delete p.sizeMax; paras.push(p); },
    table() { /* a table inside a cell is not modelled */ },
  });
  return paras;
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

export function classifyRow(r, z) {
  if (isStretchedLine(r, z)) {
    const runs = [];
    r.cells.forEach((c, k) => {
      const lr = styledRuns(c.line);
      if (k > 0 && runs.length) runs[runs.length - 1] = { ...runs[runs.length - 1], t: `${runs[runs.length - 1].t} ` };
      runs.push(...lr);
    });
    return { type: 'single', runs };
  }
  const cells = r.cells;
  if (cells.length === 1) {
    const runs = styledRuns(cells[0].line);
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
    const runs = styledRuns(cells[1].line);
    if (bulletOnly) return { type: 'single', runs, bullet: true, markerGap: cells[1].x0 - cells[0].x0 };
    return { type: 'single', runs: [{ ...runs[0], t: `${t0}\t${runs[0].t}`, tabbed: true }].concat(runs.slice(1)), marker: t0, markerGap: cells[1].x0 - cells[0].x0, left2: cells[1].x0 };
  }
  return { type: 'multi' };
}

export function multiCellPara(r, marginL) {
  const runs = [];
  const tabs = [];
  r.cells.forEach((c, k) => {
    if (k > 0) {
      runs.push({ t: '\t', f: 'Arial', sz: 8 });
      tabs.push(Math.round((c.x0 - r.left) * 10) / 10);
    }
    runs.push(...styledRuns(c.line));
  });
  const sizes = r.cells.map((c) => c.size);
  return { kind: 'p', runs, tabs, indentLeft: Math.max(0, r.left - marginL), sizeMax: Math.max(...sizes) };
}

export function joinable(para, item, z) {
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
  // so are two lines that share a centre but not an edge (a centred title set in several lines,
  // whatever the zone's own centre): a wrapped paragraph shares an edge, not a centre
  if (para.rows.length === 1 && Math.abs((last.left + last.right) / 2 - (item.left + item.right) / 2) < 0.4 * size && Math.abs(last.left - item.left) > 0.8 * size
    && Math.abs(last.right - item.right) > 0.8 * size) return false;
  // bold-only line vs regular line: different paragraphs
  const allBold = (it) => it.runs.every((x) => x.b || !x.t.trim());
  if (allBold(last) !== allBold(item)) return false;
  return true;
}

export function finishPara(para, z, marginL, colRight) {
  const rows = para.rows;
  const n = rows.length;
  const first = rows[0];
  const sizeMax = Math.max(...rows.map((r) => r.size));
  // runs: join rows with a space; a word hyphenated at the wrap joins without one (see wrapJoin)
  const runs = [];
  rows.forEach((r, k) => {
    if (k > 0 && runs.length) {
      const prevText = runs[runs.length - 1].t;
      const how = wrapJoin(runs.map((x) => x.t).join(''), r.runs[0] ? r.runs[0].t : '');
      if (how === 'soft') runs[runs.length - 1] = { ...runs[runs.length - 1], t: `${prevText.replace(/-$/, '')}${SOFT_HYPHEN}` };
      else if (how === 'space') runs[runs.length - 1] = { ...runs[runs.length - 1], t: `${prevText} ` };
    }
    for (const x of r.runs) {
      const last = runs[runs.length - 1];
      if (last && last.b === x.b && last.i === x.i && last.f === x.f && last.sz === x.sz && (last.c || null) === (x.c || null) && (last.bg || null) === (x.bg || null)) last.t += x.t;
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
    if ((Math.abs(c - centre) <= 0.7 * first.size || (z.axis && Math.abs(c - z.axis) <= 0.7 * first.size)) && first.left - z.left > 2 * first.size && z.right - first.right > 2 * first.size) align = 'center';
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
  if (align === 'right' && n === 1) {
    // right-aligned text hugs the right edge whatever the box: the box is the whole column, so a
    // wider fallback font does not wrap the one line ("01" became "0" over "1")
    p.indentLeft = 0;
  }
  if (align === 'center') {
    // centred text is centred in its box: the box is symmetric about the line's own centre, so a
    // line indented from the left margin is not pushed a second time by its own indent
    const c = (first.left + first.right) / 2;
    const half = Math.max(1, Math.min(c - marginL, colRight - c));
    p.indentLeft = Math.max(0, Math.round((c - marginL - half) * 10) / 10);
    p.indentRight = Math.max(0, Math.round((colRight - c - half) * 10) / 10);
    delete p.indentFirst;
  } else if (n >= 2) {
    const maxRight = Math.max(...rows.map((r) => r.right));
    // A font Word may not have falls back to a wider one and wraps a line earlier than the PDF did,
    // one extra line per paragraph that adds up to a page of its own. So a paragraph set in a font
    // outside the stock Office/metric-compatible set gets a hair of slack on the right (<= 4pt).
    // For a stock font the widths are exact and the slack would only move the breaks (MEASURED on
    // a Times thesis: page-body match 0.96 -> 0.58), so it gets none.
    const slack = stockFont(dominantFont(runs)) ? 0 : Math.min(4, 0.015 * (colRight - marginL));
    p.indentRight = Math.max(0, Math.round((colRight - maxRight - slack) * 10) / 10);
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

