/*
 * PDFLokal — docx/tables-build.js  (the part of a table that does not care how it was found)
 * ============================================================================
 * Both detectors (tables.js: ruled, tables-text.js: borderless / rule-bounded) end the same way: a GRID
 *
 *   g = { xs, ys, nr, nc, hEdge, vEdge }
 *       xs: column boundaries (nc+1, page pt), ys: row boundaries (nr+1)
 *       hEdge[j][c]  the edge on row boundary j under column c, vEdge[i][r] the edge on column boundary i
 *                    beside row r:  { has, w, c }.  `has` is STRUCTURE (an absent interior edge merges its two
 *                    cells); w > 0 makes it a drawn border of width w pt and colour c, w = 0 is "no line here".
 *
 * plus the runs that fall in each cell, and this module turns that into the model Table (merged cells, borders,
 * shading from the topmost fill, cell paragraphs through layout.paragraphsOfLines) and the TableClaim that tells
 * layout which lines the table consumed.
 *
 * What a cell needs to come out the size it went in (all MEASURED in LibreOffice 26.2 on the wild corpus):
 *   - a one-line cell's paragraph is fitted to its row (an exact 1.2 em line in a 12.5 pt row stretches every row)
 *   - the top padding is the first paragraph's space-before, never a cell margin (margins ADD to the row height)
 *   - a blank stretch inside a cell (a signature space) is the next paragraph's space-before
 *   - the cell keeps its widest line 3 pt of room, spent from the margin, so a hair-wider substitute font does not wrap it
 *   - a merged region that is not a rectangle keeps what each row can say (a heading spanning columns) and merges nothing downward
 */

import { groupRunsIntoLines } from '../core/text-lines.js';
import { paragraphsOfLines } from './layout.js';

export const isWhite = (c) => !c || /^[f][a-f0-9][f][a-f0-9][f][a-f0-9]$/i.test(c) || /^f[89a-f]f[89a-f]f[89a-f]$/i.test(c);

// Merge cells across absent interior edges; a merged region must be a rectangle or it stays split.
export function mergeCells(g) {
  const { nc, nr, hEdge, vEdge } = g;
  const id = (r, c) => r * nc + c;
  const parent = Array.from({ length: nr * nc }, (_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[ra] = rb; };
  for (let r = 0; r < nr; r += 1) {
    for (let c = 0; c < nc; c += 1) {
      if (c + 1 < nc && !vEdge[c + 1][r].has) union(id(r, c), id(r, c + 1));
      if (r + 1 < nr && !hEdge[r + 1][c].has) union(id(r, c), id(r + 1, c));
    }
  }
  const regions = new Map();
  for (let r = 0; r < nr; r += 1) {
    for (let c = 0; c < nc; c += 1) {
      const k = find(id(r, c));
      if (!regions.has(k)) regions.set(k, { r0: r, r1: r, c0: c, c1: c, n: 0, members: [] });
      const reg = regions.get(k);
      reg.r0 = Math.min(reg.r0, r); reg.r1 = Math.max(reg.r1, r); reg.c0 = Math.min(reg.c0, c); reg.c1 = Math.max(reg.c1, c); reg.n += 1;
      reg.members.push([r, c]);
    }
  }
  const cells = [];
  for (const reg of regions.values()) {
    if (reg.n === (reg.r1 - reg.r0 + 1) * (reg.c1 - reg.c0 + 1)) cells.push({ r0: reg.r0, r1: reg.r1, c0: reg.c0, c1: reg.c1 });
    else {
      // not a rectangle (Word cannot say it): keep what a row can say. Within each row the neighbours the region joins stay one
      // cell (a heading across a month block), but nothing merges downward.
      const byRow = new Map();
      for (const [r, c] of reg.members) { if (!byRow.has(r)) byRow.set(r, []); byRow.get(r).push(c); }
      for (const [r, cs] of byRow) {
        cs.sort((a, b) => a - b);
        let from = cs[0];
        for (let k = 1; k <= cs.length; k += 1) {
          if (k === cs.length || cs[k] !== cs[k - 1] + 1 || vEdge[cs[k]][r].has) { cells.push({ r0: r, r1: r, c0: from, c1: cs[k - 1] }); from = cs[k]; }
        }
      }
    }
  }
  const owner = new Array(nr * nc);
  cells.forEach((cell, i) => { for (let r = cell.r0; r <= cell.r1; r += 1) for (let c = cell.c0; c <= cell.c1; c += 1) owner[id(r, c)] = i; });
  return { cells, owner };
}

// --------------------------------------------------------- cell content ----
const pad = (n) => Math.round(n * 10) / 10;
const BLANK_GAP = 0.8; // a baseline gap this many em beyond the line height is a blank stretch inside a cell
const WRAP_SAFETY = 3; // pt of free width a cell keeps beyond its widest line

function topFill(fills, box, pageArea) {
  const area = (box.x1 - box.x0) * (box.y1 - box.y0);
  let best = null;
  for (const f of fills) {
    const ix = Math.min(f.x1, box.x1) - Math.max(f.x0, box.x0);
    const iy = Math.min(f.y1, box.y1) - Math.max(f.y0, box.y0);
    if (ix <= 0 || iy <= 0) continue;
    if (ix * iy < 0.8 * area) continue;
    if ((f.x1 - f.x0) * (f.y1 - f.y0) > 0.8 * pageArea) continue;
    if (!best || f.z > best.z) best = f;
  }
  return best && !isWhite(best.c) ? best.c.toUpperCase() : null;
}

function borderOf(e) {
  if (!e.has || !e.w || isWhite(e.c)) return null;
  return { sz: Math.max(2, Math.min(96, Math.round(e.w * 8))), c: e.c.toUpperCase() };
}


// A cell's lines in vertical groups: a new group starts where the gap between baselines leaves room for a blank line or more.
// Returns [{ lines, gap }] (gap = baseline distance from the previous group's last row, 0 for the first).
function verticalGroups(lines) {
  const rows = [];
  for (const l of lines.slice().sort((a, b) => a.runs[0].org.y - b.runs[0].org.y || a.x - b.x)) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.base - l.runs[0].org.y) <= 0.35 * Math.min(last.size, l.size)) last.lines.push(l);
    else rows.push({ base: l.runs[0].org.y, size: l.size, lines: [l] });
  }
  const groups = [];
  rows.forEach((r, k) => {
    const gap = k ? r.base - rows[k - 1].base : 0;
    if (k && gap - 1.2 * r.size > BLANK_GAP * r.size) groups.push({ lines: [...r.lines], gap });
    else if (groups.length) groups[groups.length - 1].lines.push(...r.lines);
    else groups.push({ lines: [...r.lines], gap: 0 });
  });
  return groups;
}

// The paragraphs of one cell, plus the geometry the alignment/margin logic needs.
export function cellParagraphs(ctx, runs, box) {
  if (!runs.length) return { blocks: [], mar: null, vAlign: undefined };
  const lines = groupRunsIntoLines(runs, { softSplit: false });
  const lx0 = Math.min(...lines.map((l) => l.x));
  const lx1 = Math.max(...lines.map((l) => l.x + l.w));
  const paras = [];
  for (const g of verticalGroups(lines)) {
    const ps = paragraphsOfLines(g.lines, ctx, { left: lx0, right: lx1 });
    if (paras.length && ps.length && g.gap > 0) {
      // a blank stretch inside the cell (a signature space, a picture's room) is the next paragraph's space-before
      const prevL = paras[paras.length - 1].lineExact || 12;
      const sb = g.gap - 0.2 * prevL - 0.8 * (ps[0].lineExact || 12);
      if (sb > 0.5) ps[0].spaceBefore = pad(sb);
    }
    paras.push(...ps);
  }
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  const lg = lx0 - box.x0;
  const rg = box.x1 - lx1;
  // alignment of the block as a whole, from where the text sits in the cell
  let align = 'left';
  if (Math.abs(lg - rg) <= Math.max(2, 0.05 * w) && lg > 4 && lx1 - lx0 < w - 6) align = 'center';
  else if (lg - rg > Math.max(6, 0.1 * w)) align = 'right';
  const rows = lines.length;
  if (paras.length === 1) {
    const p = paras[0];
    if (p.align !== 'both') {
      p.align = align;
      if (align !== 'left') { p.indentLeft = 0; p.indentFirst = 0; p.indentRight = 0; }
    }
  } else if (paras.length === rows && align !== 'left') {
    // one paragraph per line: align each line by its own position
    const ordered = lines.slice().sort((a, b) => a.runs[0].org.y - b.runs[0].org.y || a.x - b.x);
    paras.forEach((p, k) => {
      const l = ordered[k];
      if (!l || p.align === 'both') return;
      const a = l.x - box.x0; const b = box.x1 - (l.x + l.w);
      if (Math.abs(a - b) <= Math.max(2, 0.05 * w) && a > 4) { p.align = 'center'; p.indentLeft = 0; p.indentFirst = 0; p.indentRight = 0; }
      else if (a - b > Math.max(6, 0.1 * w)) { p.align = 'right'; p.indentLeft = 0; p.indentFirst = 0; p.indentRight = 0; }
    });
  }
  // vertical placement
  const bases = lines.map((l) => l.runs[0].org.y);
  const first = Math.min(...bases);
  const last = Math.max(...bases);
  // A one-line cell must not out-grow its row: the paragraph's exact line (1.2 em) is taller than a tight PDF pitch, and
  // every such row would stretch by the difference (MEASURED on a form: a 9-row table 8 pt too tall). Fit it to the row.
  if (lines.length === 1 && paras.length === 1 && paras[0].lineExact) {
    const sz = lines[0].size;
    paras[0].lineExact = Math.max(sz, Math.min(paras[0].lineExact, h - 0.5));
  }
  const L0 = paras[0].lineExact || 12;
  const Ln = paras[paras.length - 1].lineExact || L0;
  const top = first - 0.8 * L0;
  const bottom = last + 0.2 * Ln;
  const gapT = top - box.y0;
  const gapB = box.y1 - bottom;
  const contentH = Math.max(0, bottom - top);
  let vAlign;
  let mt = 0;
  if (Math.abs(gapT - gapB) <= 1.5 + 0.06 * h && gapT > 2.5) vAlign = 'center';
  else if (gapB + 3 < gapT && gapB < 0.25 * h) vAlign = 'bottom';
  else mt = Math.min(Math.max(0, gapT), Math.max(0, h - contentH - 1));
  // Top padding is the first paragraph's space-before, NOT a cell margin: LibreOffice adds cell top/bottom margins
  // ON TOP of the row height (MEASURED: row pitch = trHeight + margins + border), so a margin would stretch every row.
  if (mt > 0.3) paras[0].spaceBefore = pad(mt);
  const mar = { t: 0, b: 0, l: 0, r: 0 };
  if (align === 'left') { mar.l = pad(Math.min(Math.max(0, lg), 0.4 * w)); mar.r = 1; }
  else if (align === 'right') { mar.r = pad(Math.min(Math.max(0, rg), 0.4 * w)); mar.l = 1; }
  else { const m = Math.min(lg, rg); mar.l = pad(Math.max(0, Math.min(m, 0.4 * w))); mar.r = mar.l; }
  // Safety: the cell must hold its widest line with room to spare, or a font that is a hair wider than the PDF's
  // (every substitute is) wraps the line and the row doubles in height. Spend the margin, not the text.
  const room = w - mar.l - mar.r;
  const need = lx1 - lx0 + WRAP_SAFETY;
  if (need > room) {
    let cut = need - room;
    const take = (k) => { const d = Math.min(mar[k], cut); mar[k] = pad(mar[k] - d); cut -= d; };
    if (align === 'right') { take('r'); take('l'); } else { take('l'); take('r'); }
  }
  return { blocks: paras, mar, vAlign };
}

export function buildClaim(ctx, g, cells, cellRuns, inBox, box, pageArea, fills) {
  const cellBox = (cell) => ({ x0: g.xs[cell.c0], x1: g.xs[cell.c1 + 1], y0: g.ys[cell.r0], y1: g.ys[cell.r1 + 1] });
  const model = cells.map((cell, k) => {
    const cb = cellBox(cell);
    const content = cellParagraphs(ctx, cellRuns[k], cb);
    const b = {
      top: borderOf(mixEdge(g.hEdge[cell.r0], cell.c0, cell.c1)),
      bottom: borderOf(mixEdge(g.hEdge[cell.r1 + 1], cell.c0, cell.c1)),
      left: borderOf(mixEdgeV(g.vEdge[cell.c0], cell.r0, cell.r1)),
      right: borderOf(mixEdgeV(g.vEdge[cell.c1 + 1], cell.r0, cell.r1)),
    };
    const out = { blocks: content.blocks };
    if (cell.c1 > cell.c0) out.span = cell.c1 - cell.c0 + 1;
    const fill = topFill(fills, cb, pageArea);
    if (fill) out.fill = fill;
    if (b.top || b.bottom || b.left || b.right) out.borders = Object.fromEntries(Object.entries(b).filter(([, v]) => v));
    if (content.mar) out.mar = content.mar;
    if (content.vAlign) out.vAlign = content.vAlign;
    return out;
  });
  const colsPt = g.xs.slice(1).map((x, i) => pad(x - g.xs[i]));
  const rowsH = g.ys.slice(1).map((y, i) => pad(y - g.ys[i]));
  const rows = [];
  for (let r = 0; r < g.nr; r += 1) {
    const row = [];
    let c = 0;
    while (c < g.nc) {
      const k = cells.findIndex((cell) => cell.r0 <= r && r <= cell.r1 && cell.c0 <= c && c <= cell.c1);
      const cell = cells[k];
      const span = cell.c1 - cell.c0 + 1;
      if (cell.r0 === r) {
        const m = { ...model[k] };
        if (cell.r1 > cell.r0) m.vmerge = 'restart';
        row.push(m);
      } else {
        // the continuation slot of a vertically merged cell keeps the same borders on the sides
        const m = { blocks: [], vmerge: 'continue' };
        if (span > 1) m.span = span;
        const src = model[k];
        if (src.borders) m.borders = Object.fromEntries(Object.entries(src.borders).filter(([side]) => side === 'left' || side === 'right' || (side === 'bottom' && r === cell.r1)));
        if (src.fill) m.fill = src.fill;
        row.push(m);
      }
      c += span;
    }
    rows.push(row);
  }
  const lines = takeLines(ctx, inBox);
  return { x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1, lines, block: { kind: 'tbl', src: 'ruled', colsPt, rowsH, rows } };
}

function mixEdge(row, c0, c1) {
  // a cell's top/bottom border: the edge under its columns; if they disagree, the first that exists
  const parts = row.slice(c0, c1 + 1);
  const have = parts.filter((e) => e.has);
  if (!have.length || have.length * 2 < parts.length) return { has: false };
  return have.reduce((a, b) => (b.w > a.w ? b : a));
}
function mixEdgeV(col, r0, r1) {
  const parts = col.slice(r0, r1 + 1);
  const have = parts.filter((e) => e.has);
  if (!have.length || have.length * 2 < parts.length) return { has: false };
  return have.reduce((a, b) => (b.w > a.w ? b : a));
}

// Lines wholly inside the table are consumed. A line with runs both inside and outside is split:
// it is replaced in ctx.lines by residual lines of the outside runs.
export function takeLines(ctx, inBox) {
  const inSet = new Set(inBox);
  const consumed = [];
  const next = [];
  for (const line of ctx.lines) {
    const inside = line.runs.filter((r) => inSet.has(r));
    if (!inside.length) { next.push(line); continue; }
    if (inside.length === line.runs.length) { consumed.push(line); continue; }
    consumed.push(line);
    const outside = line.runs.filter((r) => !inSet.has(r));
    for (const l of groupRunsIntoLines(outside, { softSplit: false })) next.push(l);
  }
  ctx.lines = next;
  return consumed;
}

