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
import { median, percentile } from './model.js';

const BULLET_RE = new RegExp('^[\\u2022\\u25CF\\u25CB\\u25E6\\u25AA\\u25A0\\u25A1\\u2023\\u2043\\u2219\\u00B7\\uF0B7\\uF0A7\\uF0D8\\uF076\\u2013\\u2014*-]\\s*');
const NUM_MARKER_RE = /^(\(?\d{1,3}([.)]\d*)*[.)]|\(?[A-Za-z][.)]|\(?[ivxIVX]{1,4}[.)])$/;
const RTL_RE = new RegExp('[\\u0590-\\u08FF\\uFB1D-\\uFDFF\\uFE70-\\uFEFE]', 'g');

// ---------------------------------------------------------- reading order --
// Recursive XY-cut over line/image boxes. A vertical cut (column gutter) starts
// a new ZONE; a horizontal cut only reorders. Returns items in reading order,
// each stamped with .zone.
export function xyCut(items, zoneRef, zoneId, out, depth) {
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
      const real = (r) => r.items.length >= 6 && r.x1 - r.x0 >= pageW * 0.25 && r.y1 - r.y0 >= pageH * 0.2;
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
  xyCut(geoms.slice(), { n: 0 }, 0, ordered, 0);
  const segs = segmentsOf(ordered, W, H);

  const pageLefts = geoms.map((g) => g.x0);
  const pageRights = geoms.map((g) => g.x1);
  const pageMarginL = pageLefts.length ? Math.max(12, Math.min(Math.min(...pageLefts), W * 0.35)) : 56;
  const pageMarginR = pageRights.length ? Math.max(12, Math.min(W - Math.max(...pageRights), W * 0.35)) : 56;

  let cursor = null; // estimated bottom (y, page pt) of the previous block
  // A footer / page number sits at the very bottom of the page; the page's own
  // bottom margin would push it onto an extra page. Pull any block up so it ends
  // inside the page (the section's bottom margin is 0 for the same reason).
  const place = (target0, height) => {
    const target = Math.min(target0, H - height - 1);
    const sb = cursor === null ? 0 : Math.max(0, target - cursor);
    cursor = (cursor === null ? target : cursor + sb) + height;
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
      const zone = { left: Math.min(...run.items.map((g) => g.x0)), right: percentile(run.items.map((g) => g.x1), 0.9) };
      const origin = seg.cols > 1 ? zone.left : marginL;
      const colRight = seg.cols > 1 ? Math.max(...run.items.map((g) => g.x1)) : W - marginR;
      const rows = rowsOf(run.items);
      const startBlock = out.blocks.length;
      assembleRows(rows, zone, origin, colRight, {
        para(p, paraRows) {
          const lineH = p.lineExact || H_OF(p.sizeMax);
          const target = paraRows[0].base - 0.8 * lineH;
          if (firstTop === null) firstTop = Math.max(0, target);
          p.spaceBefore = Math.round(place(target, lineH * paraRows.length) * 10) / 10;
          out.blocks.push(p);
        },
        multi(p, r) {
          const lineH = H_OF(p.sizeMax);
          p.lineExact = lineH;
          if (firstTop === null) firstTop = Math.max(0, r.base - 0.8 * lineH);
          p.spaceBefore = Math.round(place(r.base - 0.8 * lineH, lineH) * 10) / 10;
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
    p.indentRight = Math.max(0, Math.round((colRight - maxRight) * 10) / 10);
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

