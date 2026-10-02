/*
 * PDFLokal — docx/tables-text.js  (tables that are not drawn as a grid: aligned columns of short cells,
 *                                  with or without horizontal rules)
 * ============================================================================
 * An academic table has three horizontal rules and no verticals; a regulation annex is columns of text with
 * no lines at all. Neither shows up as a connected set of rules (tables.js), but both are, to a reader,
 * ROWS of CELLS that line up in COLUMNS. This detector finds them from the text lines extract.groupLines made
 * (the column guard already cut a row into one Line per cell) and, when full-width horizontal rules bound or
 * divide the rows, takes those as the table's borders.
 *
 *   detectTextTables(ctx, taken, rr, claims) -> TableClaim[]   (same claim shape as tables.js; rr = extractRules(ctx); each claim
 *                                                               is also pushed to `claims` as it is made, so a later throw keeps it)
 *
 * HOW A TABLE IS FOUND
 *   rows      lines sharing a baseline. A row with >= 2 cells is a candidate; a justified prose line the column
 *             guard happened to cut at its stretched word gaps is not (equal gaps, flush right edge).
 *   blocks    runs of candidate rows no further apart than 3 line heights, with up to 2 short single-cell rows
 *             allowed between (a wrapped cell, a spanning sub-heading); a long single-cell row is a paragraph and
 *             ends the block.
 *   columns   CORRIDORS: x-ranges (>= 0.6 em wide) that at most ~12% of the block's rows cross, plus x where cells
 *             begin in many rows. A justified paragraph has none (its word gaps fall at random x); a table's column
 *             gutters line up. When horizontal rules bound the block, the places where their pieces meet are the
 *             column lines instead (a table with horizontal borders only has one piece of rule per cell).
 *   rows'     a single-cell row that sits in one column, within a line's leading of the row above, continues
 *             that row's cell; one that crosses a corridor is a spanning row (gridSpan).
 *   rules     full-width horizontal rules inside or within 14 pt of the block become cell borders at the row
 *             boundary they lie on; two or more of them make the block RULE-BOUNDED and lower the row minimum.
 *
 * WHAT IS REFUSED (each rule has a test in tests/core/docx-tables.test.mjs; the thresholds were measured on the 104-file
 * wild corpus, see the lane report)
 *   - fewer than 3 rows (2 when rule-bounded), fewer than 2 columns, mostly empty, rows that fill one column
 *   - prose: every column's typical cell is a sentence (> 30 chars), or two columns of full-width running lines
 *     (dot leaders do not count as text), or one column of long full-width lines
 *   - lists: in nearly every row everything before the last cell is a marker ("1.", "a)", "-") or blank
 *   - a table of contents: titles in front of a column of page numbers
 *   - the PDF's own reading order: text emitted column by column, or against the grain of the rows (> 20% of
 *     adjacent cells out of order, or > 10% and the columns read better)
 *   - a slice of a column layout: the text of two columns carries on above or below the block as lone lines
 *   - drawn art: cards, ribbons and panels (non-banded fills, non-rectangular filled shapes) over a fifth of the block
 *   - anything overlapping a table that was already claimed
 */

import { median } from './model.js';
import { buildClaim, mergeCells, isWhite } from './tables-build.js';
import { mergeCollinear } from './tables-rules.js';

const MIN_ROWS = 3;
const MIN_ROWS_BOUNDED = 2;
const MAX_COLS = 16;
const PROSE_CHARS = 30;
const LONG_PROSE = 40; // a column whose typical line is longer than this and runs the full column width is wrapped prose
const HEADING_CHARS = 40; // a single-cell row longer than this is a paragraph: it ends the block instead of joining it as a spanning heading
const ROW_SNAP = 0.35; // baselines within this fraction of the font size share a row
const BLOCK_GAP = 3.0; // a block ends when the next row is further than this many font sizes below
const RULE_NEAR = 14; // a full-width rule this close above/below a block belongs to it (pt)
const RULE_SPAN = 0.85; // a rule covers this much of the table's width to count as a table rule
const MARKER_RE = /^(\(?\d{1,3}([.)]\d*)*[.)]?|\(?[A-Za-z][.)]|\(?[ivxIVX]{1,4}[.)]|[•●○◦▪■–—*-])$/;


const MAX_INVERSION = 0.2; // of adjacent cells in table reading order, the share the PDF emitted the other way round
const NUMBER_RE = /^[\divxlcIVXLC.,]{1,6}$/;

// What the stream order says about a block: null, or why it is not a table. A table is emitted row by row (a few cells out of
// order is fine); text emitted against the grain of the rows is columns of text, and so is text that reads better column by column.
export function orderRefusal({ inv, colInv }) {
  if (inv > MAX_INVERSION) return `order ${inv.toFixed(2)}`;
  if (inv > 0.1 && colInv < inv) return `column-major ${colInv.toFixed(2)}<${inv.toFixed(2)}`;
  return null;
}

// How far the table's reading order runs against the order the PDF emitted its text in: row by row (inv, how a table reads) and
// column by column (colInv, how columns of flowing text read). A table emitted row by row has inv ~ 0 and a large colInv; two
// columns of prose emitted column by column are the other way round. Each is the share of adjacent cells that run backwards.
export function streamOrder(ctx, trows) {
  const idx = ctx._streamIdx || (ctx._streamIdx = new Map(ctx.runs.map((r, i) => [r, i])));
  const cells = [];
  trows.forEach((tr, ri) => tr.cells.forEach((c) => cells.push({ c: c.c0, ri, runs: c.runs.slice().sort((a, b) => a.y - b.y || a.x - b.x) })));
  const inversions = (list) => {
    const seq = [];
    for (const cell of list) for (const r of cell.runs) if (idx.has(r)) seq.push(idx.get(r));
    let inv = 0;
    for (let i = 1; i < seq.length; i += 1) if (seq[i] < seq[i - 1]) inv += 1;
    return seq.length > 1 ? inv / (seq.length - 1) : 0;
  };
  const rowMajor = cells.slice().sort((a, b) => a.ri - b.ri || a.c - b.c);
  const colMajor = cells.slice().sort((a, b) => a.c - b.c || a.ri - b.ri);
  return { inv: inversions(rowMajor), colInv: inversions(colMajor) };
}

// Columns of flowing text: a column where >= 70% of the lines are nearly as wide as the widest one and that holds
// real sentences (median > 15 characters). Returns a score: 1 per such column, 2 for a column of long lines.
function fullWidthColumns(trows, nc, textOfCell) {
  const widths = Array.from({ length: nc }, () => []);
  const lens = Array.from({ length: nc }, () => []);
  for (const tr of trows) {
    if (tr.single) continue;
    for (const c of tr.cells) {
      if (c.c0 !== c.c1 || !c.runs.length) continue;
      const t = textOfCell(c);
      if (!wordy(t)) continue; // dot leaders, rules of underscores: filler, not sentences
      widths[c.c0].push(Math.max(...c.runs.map((x) => x.x + x.w)) - Math.min(...c.runs.map((x) => x.x)));
      lens[c.c0].push(t.length);
    }
  }
  let n = 0;
  widths.forEach((ws, i) => {
    if (ws.length < 3) return;
    const typ = median(lens[i]);
    if (typ <= 15) return;
    const W = Math.max(...ws);
    // a column of long running lines counts double: one such column is already text that wraps, which a row cannot hold
    if (ws.filter((w) => w >= 0.85 * W).length >= 0.7 * ws.length) n += typ > LONG_PROSE ? 2 : 1;
  });
  return n;
}

// Letters and digits make up most of it (not a dot leader or a rule of underscores).
const wordy = (t) => t.length > 0 && (t.match(/[\p{L}\p{N}]/gu) || []).length >= 0.6 * t.length;


// A list: in nearly every row everything in front of the last cell is a marker ("1.", "a)", "-") or blank, and a good part
// of the rows carry a marker. Numbered clauses, nested outlines and bullet lists are laid out as columns of markers
// and indents; they are paragraphs with a hanging indent, not rows of data.
function outlineList(trows, textOfCell) {
  const rows = trows.filter((r) => !r.single || r.cells.length > 1);
  if (rows.length < 2) return false;
  let listy = 0; let marked = 0;
  for (const r of rows) {
    const lead = r.cells.slice(0, -1).map(textOfCell);
    if (!lead.every((t) => t === '' || MARKER_RE.test(t))) continue;
    listy += 1;
    if (lead.some((t) => t !== '')) marked += 1;
  }
  return listy >= 0.8 * rows.length && marked >= 0.4 * rows.length;
}

function tocLike(trows, nc, textOfCell) {
  const rows = trows.filter((r) => !r.single);
  if (rows.length < 3) return false;
  const last = rows.map((r) => r.cells[r.cells.length - 1]).filter((c) => c.c0 === nc - 1);
  if (last.length < 0.8 * rows.length) return false;
  const pages = last.filter((c) => NUMBER_RE.test(textOfCell(c))).length;
  if (pages < 0.8 * last.length) return false;
  const first = rows.map((r) => textOfCell(r.cells[0])).filter(Boolean);
  return first.length >= 0.8 * rows.length && first.filter((t) => t.length > 12).length >= 0.6 * first.length;
}


// Column boundaries read off the rules themselves: a table with only horizontal borders has one piece of rule per cell, so
// the places where the pieces meet are its column lines. A boundary counts when about half of the table's rules break there.
function ruleCuts(rules) {
  const all = rules.flatMap((r) => r.cuts.map((x) => ({ x, r })));
  all.sort((a, b) => a.x - b.x);
  const out = [];
  let k = 0;
  while (k < all.length) {
    let e = k + 1;
    while (e < all.length && all[e].x - all[e - 1].x <= 1.5) e += 1;
    const grp = all.slice(k, e);
    k = e;
    const n = new Set(grp.map((g) => g.r)).size;
    if (n >= Math.max(2, 0.5 * rules.length)) out.push(grp.reduce((a, g) => a + g.x, 0) / grp.length);
  }
  return out;
}


// Does the text of at least two of the block's columns carry on, in the same column, just above or just below it (as lone lines,
// not as the rows of the next form down)? Then the "rows" are lines of a column layout that happen to sit side by side, and the
// block is a slice of it.
function columnSlice(ctx, trows, nc, top, bottom, size) {
  const own = new Set();
  const spans = Array.from({ length: nc }, () => ({ left: [], right: [] }));
  for (const tr of trows) {
    if (tr.single) continue;
    for (const c of tr.cells) {
      for (const r of c.runs) own.add(r);
      if (c.c0 !== c.c1 || !c.runs.length) continue;
      spans[c.c0].left.push(Math.min(...c.runs.map((x) => x.x)));
      spans[c.c0].right.push(Math.max(...c.runs.map((x) => x.x + x.w)));
    }
  }
  let carried = 0;
  for (const sp of spans) {
    if (sp.left.length < 3) continue;
    const left = median(sp.left);
    const right = Math.max(...sp.right);
    const near = ctx.lines.some((l) => {
      if (own.has(l.runs[0]) || l.x < left - 4 || l.x + l.w > right + 6 || l.w < 0.5 * (right - left)) return false;
      if (Math.abs(l.x - left) > 4 && Math.abs(l.x + l.w - right) > 4) return false;
      const above = top - (l.y + l.h);
      const below = l.y - bottom;
      if (!((above >= -2 && above <= 2.5 * size) || (below >= -2 && below <= 2.5 * size))) return false;
      // a line of a column of text stands alone on its baseline; a line with partners beside it is a row of another table
      const b = baseOf(l);
      return !ctx.lines.some((o) => o !== l && Math.abs(baseOf(o) - b) <= 0.35 * Math.min(o.size, l.size));
    });
    if (near) carried += 1;
  }
  return carried >= 2;
}


// Cards and panels behind the text make a designed layout, not a table: more than a fifth of the block covered by shapes or
// by fills that are not a band across the whole block (shading of a row). Pictures do not count: they are as often a page
// background as a figure, and the text beside a figure is not what this is asking about.
function designed(rr, x0, y0, x1, y1) {
  const area = (x1 - x0) * (y1 - y0) || 1;
  const ov = (b) => Math.max(0, Math.min(b.x1, x1) - Math.max(b.x0, x0)) * Math.max(0, Math.min(b.y1, y1) - Math.max(b.y0, y0));
  let art = 0;
  for (const f of (rr.fills || []).concat(rr.shapes || [])) if (f.x1 - f.x0 < 0.85 * (x1 - x0) && !isWhite(f.c)) art += ov(f);
  return art > 0.2 * area;
}

const baseOf = (l) => l.runs[0].org.y;

function rowsOf(lines) {
  const sorted = lines.slice().sort((a, b) => baseOf(a) - baseOf(b) || a.x - b.x);
  const rows = [];
  for (const l of sorted) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.base - baseOf(l)) <= ROW_SNAP * Math.min(last.size, l.size)) {
      last.cells.push(l);
      last.size = Math.max(last.size, l.size);
    } else rows.push({ cells: [l], base: baseOf(l), size: l.size });
  }
  for (const r of rows) {
    r.cells.sort((a, b) => a.x - b.x);
    r.x0 = r.cells[0].x;
    r.x1 = Math.max(...r.cells.map((c) => c.x + c.w));
    r.top = Math.min(...r.cells.map((c) => c.y));
    r.bottom = Math.max(...r.cells.map((c) => c.y + c.h));
  }
  return rows;
}

// A justified line cut at its (equal, narrow) word gaps is not a row of cells.
function stretched(r) {
  const c = r.cells;
  if (c.length < 3) return false;
  const gaps = [];
  for (let k = 1; k < c.length; k += 1) gaps.push(c[k].x - (c[k - 1].x + c[k - 1].w));
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  if (Math.max(...gaps) > 3.2 * r.size) return false;
  const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
  return sd < 0.3 * Math.max(mean, 1);
}

// Merge full-width horizontal rules (Word draws a border twice) into one list.
function tableRules(rr, x0, x1, y0, y1) {
  const out = [];
  // a border drawn cell by cell is still one rule across the table
  if (!rr.hMerged) rr.hMerged = mergeCollinear(rr.rules || [], 'h');
  const hs = rr.hMerged.filter((r) => r.p > y0 - RULE_NEAR && r.p < y1 + RULE_NEAR && r.w <= 4);
  hs.sort((a, b) => a.p - b.p);
  const w = x1 - x0;
  for (const r of hs) {
    const cover = Math.min(r.a1, x1 + 6) - Math.max(r.a0, x0 - 6);
    if (cover < RULE_SPAN * w) continue;
    const last = out[out.length - 1];
    if (last && r.p - last.p <= 1.5) { last.w = Math.max(last.w, r.w); last.cuts = last.cuts.concat(r.cuts || []); continue; }
    out.push({ p: r.p, a0: Math.min(r.a0, x0), a1: Math.max(r.a1, x1), w: r.w, c: r.c, cuts: r.cuts || [] });
  }
  return out;
}

// Column boundaries. Two kinds of evidence, both from the RUNS of the block's multi-cell rows:
//   corridors  x-ranges (>= 0.6 em) that at most ~12% of the rows cross: the gutters of a table with air between its
//              columns. A justified paragraph has none (its word gaps fall at random x).
//   starts     x where cells BEGIN in several rows: catches a column whose widest cell runs right up to the next one
//              (a corridor the text closes), which a table with no rules is full of.
function columnBounds(multi, X0, X1, size) {
  const n = multi.length;
  const allow = Math.floor(0.12 * n);
  const W = Math.ceil(X1 - X0) + 1;
  const count = new Array(W).fill(0);
  for (const r of multi) {
    const cov = new Uint8Array(W);
    for (const run of r.runs) {
      const a = Math.max(0, Math.floor(run.x - X0));
      const b = Math.min(W - 1, Math.ceil(run.x + run.w - X0));
      for (let i = a; i <= b; i += 1) cov[i] = 1;
    }
    for (let i = 0; i < W; i += 1) count[i] += cov[i];
  }
  const minW = Math.max(4, 0.6 * size);
  const bounds = [];
  let i = 0;
  while (i < W) {
    if (count[i] <= allow) {
      let j = i;
      while (j + 1 < W && count[j + 1] <= allow) j += 1;
      if (i > 0 && j < W - 1 && j - i + 1 >= minW) bounds.push({ at: X0 + (i + j + 1) / 2, lo: X0 + i, hi: X0 + j + 1 });
      i = j + 1;
    } else i += 1;
  }
  // cell starts that are not already the right edge of a corridor
  const starts = [];
  multi.forEach((r, ri) => { for (const l of r.cells) starts.push({ x: l.x, ri }); });
  starts.sort((a, b) => a.x - b.x);
  let g = 0;
  while (g < starts.length) {
    let e = g + 1;
    while (e < starts.length && starts[e].x - starts[e - 1].x <= 2) e += 1;
    const grp = starts.slice(g, e);
    g = e;
    const rowsHit = new Set(grp.map((s2) => s2.ri)).size;
    const x = grp.reduce((a, b) => a + b.x, 0) / grp.length;
    if (rowsHit < Math.max(3, 0.3 * n) || x - X0 < 3 * size) continue;
    if (bounds.some((b) => x >= b.lo - 2 && x <= b.hi + 3)) continue;
    bounds.push({ at: x - 1.5, lo: x - 1.5, hi: x });
  }
  bounds.sort((a, b) => a.at - b.at);
  return bounds.map((b) => b.at);
}

export function detectTextTables(ctx, taken, rr, claims = []) {
  const lines = (ctx.lines || []).filter((l) => l.runs && l.runs.length && l.pdf && Math.abs(l.pdf.uy) < 0.02 && l.pdf.ux > 0
    && !taken.some((t) => l.x < t.x1 && l.x + l.w > t.x0 && l.y < t.y1 && l.y + l.h > t.y0));
  if (lines.length < 6) return [];
  const rows = rowsOf(lines);
  const isMulti = (r) => r.cells.length >= 2 && !stretched(r);
  let k = 0;
  while (k < rows.length) {
    if (!isMulti(rows[k])) { k += 1; continue; }
    // grow a block
    const block = [rows[k]];
    let j = k + 1;
    let pendingSingles = 0;
    while (j < rows.length) {
      const r = rows[j];
      const prev = block[block.length - 1];
      const size = Math.max(prev.size, r.size);
      if (r.base - prev.base > BLOCK_GAP * size) break;
      if (isMulti(r)) { block.push(r); pendingSingles = 0; } else if (r.cells.length === 1 && pendingSingles < 2 && String(r.cells[0].str || '').length <= HEADING_CHARS) { block.push(r); pendingSingles += 1; } else break;
      j += 1;
    }
    while (block.length && !isMulti(block[block.length - 1])) block.pop();
    const next = k + Math.max(1, block.length);
    const claim = block.length >= MIN_ROWS_BOUNDED ? tryBlock(ctx, block, rr, taken) : null;
    if (claim) claims.push(claim);
    taken.push(...(claim ? [claim] : []));
    k = next; // a refused block is refused whole: its tail must not be retried as a smaller table
  }
  return claims;
}

function refuse(ctx, block, why) {
  if (ctx.options && ctx.options.tableDebug) (ctx.textRefused = ctx.textRefused || []).push({ why, y: Math.round(block[0].top), rows: block.length, text: block[0].cells.map((c) => String(c.str || '').slice(0, 12)).join('|') });
  return null;
}

// One row's runs -> cells over the column bounds `bx`. Runs in one column (or one column span) are one cell; a
// run crossing a boundary spans; cells that would claim the same column merge.
function cellsOfRow(row, bx, nc) {
  const colOf = (x) => { let c = 0; while (c < nc - 1 && x >= bx[c + 1]) c += 1; return c; };
  const cells = [];
  for (const run of row.runs) {
    const c0 = colOf(run.x + 0.1);
    const c1 = Math.max(c0, colOf(run.x + run.w - 0.1));
    const last = cells[cells.length - 1];
    if (last && c0 <= last.c1) { last.c1 = Math.max(last.c1, c1); last.runs.push(run); } else cells.push({ c0, c1, runs: [run] });
  }
  return cells;
}

function tryBlock(ctx, block, rr, taken) {
  for (const r of block) r.runs = r.cells.flatMap((l) => l.runs).sort((a, b) => a.x - b.x);
  const multi = block.filter((r) => r.cells.length >= 2 && !stretched(r));
  const size = median(block.map((r) => r.size));
  const X0 = Math.min(...block.map((r) => r.x0));
  const X1 = Math.max(...block.map((r) => r.x1));
  const top = Math.min(...block.map((r) => r.top));
  const bottom = Math.max(...block.map((r) => r.bottom));
  if (taken.some((t) => Math.min(t.x1, X1) > Math.max(t.x0, X0) && Math.min(t.y1, bottom) > Math.max(t.y0, top))) return refuse(ctx, block, 'overlap');
  if (designed(rr, X0, top, X1, bottom)) return refuse(ctx, block, 'designed');
  const rules = tableRules(rr, X0, X1, top, bottom);
  const bounded = rules.length >= 2;
  if (multi.length < (bounded ? MIN_ROWS_BOUNDED : MIN_ROWS)) return refuse(ctx, block, 'rows');

  const cut = bounded ? ruleCuts(rules) : [];
  const inner = cut.length ? cut.filter((x) => x > X0 + 2 && x < X1 - 2) : columnBounds(multi, X0, X1, size);
  if (!inner.length || inner.length + 1 > MAX_COLS) return refuse(ctx, block, 'columns');
  const nc = inner.length + 1;
  const bx = [X0, ...inner, X1];

  // ---- table rows: a row with >= 2 cells starts one; a one-cell row continues the row above (a wrapped cell)
  // when it sits in one column right under it, else stands alone (a spanning heading)
  const trows = [];
  for (const r of block) {
    const cells = cellsOfRow(r, bx, nc);
    const prev = trows[trows.length - 1];
    if (cells.length >= 2 || !prev) { trows.push({ base: r.base, size: r.size, top: r.top, bottom: r.bottom, cells, single: cells.length < 2 }); continue; }
    const cell = cells[0];
    const host = cell.c0 === cell.c1 && cell.c0 > 0 && !prev.single ? prev.cells.find((c) => c.c0 <= cell.c0 && cell.c0 <= c.c1) : null;
    if (host && r.base - prev.base <= 1.7 * r.size) {
      host.runs.push(...cell.runs);
      prev.base = Math.max(prev.base, r.base);
      prev.bottom = Math.max(prev.bottom, r.bottom);
    } else trows.push({ base: r.base, size: r.size, top: r.top, bottom: r.bottom, cells, single: true });
  }

  // ---- refuse prose, lists, sparse blocks
  const colTexts = Array.from({ length: nc }, () => []);
  let thin = 0;
  const textOfCell = (c) => c.runs.map((x) => String(x.str || '')).join(' ').replace(/\s+/g, ' ').trim();
  for (const tr of trows) {
    if (tr.single) continue;
    for (const c of tr.cells) {
      const t = textOfCell(c);
      if (t && c.c0 === c.c1) colTexts[c.c0].push(t);
    }
    if (tr.cells.length < 2) thin += 1;
  }
  const mrows = trows.filter((r) => !r.single).length;
  if (mrows < (bounded ? MIN_ROWS_BOUNDED : MIN_ROWS)) return refuse(ctx, block, 'rows');
  if (thin > 0.2 * mrows) return refuse(ctx, block, 'thin-rows');
  const typical = colTexts.map((a) => (a.length ? median(a.map((s) => s.length)) : 0));
  const used = typical.filter((_, i) => colTexts[i].length >= 0.3 * mrows);
  if (used.length < 2) return refuse(ctx, block, 'few-columns');
  if (used.every((t) => t > PROSE_CHARS)) return refuse(ctx, block, 'prose');
  const col0 = colTexts[0];
  if (col0.length >= 0.6 * mrows && col0.filter((t) => MARKER_RE.test(t)).length >= 0.8 * col0.length && typical.slice(1).some((t) => t > 25)) return refuse(ctx, block, 'list');
  // list: a column of markers in front of ONE text column is a (numbered) list, whatever the text length
  if (outlineList(trows, textOfCell)) return refuse(ctx, block, 'list');
  // the producer's own reading order: text emitted column by column is columns of flowing text, not rows of data
  const seq = streamOrder(ctx, trows);
  const order = orderRefusal(seq);
  if (order) return refuse(ctx, block, order);
  // two or more columns whose lines all run the full column width are columns of prose
  const proseCols = fullWidthColumns(trows, nc, textOfCell);
  if (proseCols >= 2) return refuse(ctx, block, 'text-columns');
  // a slice of a page set in columns: the text of each column carries on above or below the block, in the same column
  if (!bounded && columnSlice(ctx, trows, nc, top, bottom, size)) return refuse(ctx, block, 'column-slice');
  // a table of contents: titles in front of a column of page numbers
  if (tocLike(trows, nc, textOfCell)) return refuse(ctx, block, 'toc');
  const cellsAll = trows.reduce((a, tr) => a + tr.cells.length, 0);
  if (cellsAll < 0.5 * trows.length * nc) return refuse(ctx, block, 'sparse');

  // ---- the grid
  const nr = trows.length;
  const first = trows[0];
  const lastRow = trows[nr - 1];
  const topRule = rules.find((r) => r.p <= first.top + 2 && first.top - r.p <= RULE_NEAR);
  const botRule = rules.slice().reverse().find((r) => r.p >= lastRow.bottom - 2 && r.p - lastRow.bottom <= RULE_NEAR);
  // The table's top is a little above its first baseline, never as high as the line above (layout orders a table among
  // the lines by this y, and line boxes overlap by a few pt).
  const ys = [topRule ? topRule.p : first.base - 0.75 * first.size];
  for (let i = 1; i < nr; i += 1) {
    const a = trows[i - 1];
    const b = trows[i];
    const between = rules.find((r) => r.p >= a.bottom - 1.5 && r.p <= b.top + 1.5);
    ys.push(between ? between.p : (a.bottom + b.top) / 2);
  }
  ys.push(botRule ? botRule.p : lastRow.bottom + 0.1 * lastRow.size);
  for (let i = 1; i < ys.length; i += 1) if (!(ys[i] > ys[i - 1])) return refuse(ctx, block, 'row-order');
  const xs = bx.slice();
  xs[nc] += Math.max(3, size); // the last column has nothing to its right to borrow slack from: give it an em, or its widest line wraps
  if (bounded) { xs[0] = Math.min(X0, ...rules.map((r) => r.a0)); xs[nc] = Math.max(X1, ...rules.map((r) => r.a1)); }

  const none = { has: true, w: 0, c: null };
  const hEdge = ys.map((y) => {
    const rule = rules.find((r) => Math.abs(r.p - y) <= 0.6);
    return xs.slice(0, -1).map((x, c) => (rule && Math.min(rule.a1, xs[c + 1]) - Math.max(rule.a0, x) >= 0.8 * (xs[c + 1] - x) ? { has: true, w: rule.w, c: rule.c } : none));
  });
  const vEdge = xs.map((_, i) => trows.map((tr) => (i > 0 && i < nc && tr.cells.some((c) => c.c0 < i && c.c1 >= i) ? { has: false } : none)));
  const g = { xs, ys, nr, nc, hEdge, vEdge };
  const { cells, owner } = mergeCells(g);
  const cellRuns = cells.map(() => []);
  const inBox = [];
  trows.forEach((tr, r) => {
    for (const c of tr.cells) {
      const o = owner[r * nc + c.c0];
      for (const run of c.runs) { cellRuns[o].push(run); inBox.push(run); }
    }
  });
  const box = { x0: xs[0], y0: ys[0], x1: xs[nc], y1: ys[nr] };
  let claim = null;
  try { claim = buildClaim(ctx, g, cells, cellRuns, inBox, box, ctx.widthPt * ctx.heightPt, rr.fills || []); } catch (e) { (ctx.tableErrors = ctx.tableErrors || []).push(String(e && e.message)); }
  if (claim) claim.block.src = bounded ? 'rules-h' : 'text';
  return claim;
}
