/*
 * PDFLokal — docx/tables.js  (TABLES: detection + the 'tbl' block writer)
 * ============================================================================
 * THE INTERFACE (decided by the foundation; this lane implements the body)
 *
 *   detectTables(ctx) -> TableClaim[]
 *
 *     Called once per page, AFTER extract.groupLines (ctx.lines, ctx.words exist) and
 *     after color.analyzeColor, BEFORE layout. Returns the tables found:
 *
 *       TableClaim = {
 *         x0, y0, x1, y1,         page pt, top-left origin: the table's bounding box
 *         lines: Line[],          the ctx.lines objects the table CONSUMES (layout drops exactly
 *                                 these, by identity). A line that is only PARTLY inside a table
 *                                 is replaced in ctx.lines by a residual line of its outside runs
 *                                 (the one place this module touches ctx.lines).
 *         block: Table,           the model block (model.js): colsPt, rows of Cell, rowsH, ...
 *       }
 *
 * HOW A TABLE IS FOUND (two detectors, ruled first, borderless on what is left; the borderless one
 * lives in tables-text.js and is deliberately narrow)
 *
 *   RULED   tables-rules.js reduces the operator list to straight rules and filled rectangles.
 *           Rules are snapped (Word draws every border twice, 0.01pt apart), merged along their
 *           line, and grouped into CONNECTED COMPONENTS: a rule belongs to a table only if it
 *           crosses another rule. The distinct x and y of a component are the grid; a grid edge
 *           with no rule on it merges its two cells (gridSpan across, vMerge down) when the merged
 *           region is still a rectangle. Each cell gets its borders from the rules on its four
 *           edges (width and colour), its shading from the topmost fill covering it, and its text
 *           from the runs whose centre falls inside it. A component needs >= 2 rows, >= 2 columns
 *           and text in >= 2 cells, or it is a drawing (a frame, a rule under a heading), not a table.
 *           A grid that is a DRAWING (an org chart, a slide footer, a frame with a divider) is refused by
 *           drawingReason(gridQuality()): too few ruled edges, text cut by rules, a figure under it.
 *   TEXT    tables-text.js: rows of cells that line up in columns, with or without horizontal rules (the
 *           academic table, a statement of figures, a label : value form). Narrow on purpose: it refuses
 *           lists, prose and two-column text, tables of contents, slices of a column layout, drawn art, and
 *           anything whose cells the PDF emitted column by column rather than row by row.
 *           When horizontal rules bound the rows, the places where their pieces meet are the column lines.
 *   Tables are claimed biggest first and never overlap; a table claim whose box has free text beside it is
 *   not made (Word cannot flow text around a table).
 *
 *   Cell text goes through layout.paragraphsOfLines (one paragraph merger, not two). Row heights
 *   are the rule-to-rule pitch, written as "at least" so a taller cell grows the row instead of
 *   being clipped; the claim's box height is the sum, so layout's cursor stays honest.
 *
 * The 'tbl' writer below is registered with writer.js at import.
 */

import { registerBlock } from './writer.js';
import { mergeCells, buildClaim } from './tables-build.js';
import { extractRules, mergeCollinear, BRIDGE } from './tables-rules.js';
import { detectTextTables } from './tables-text.js';

const CROSS = 2.5; // a rule whose end is within this of another rule touches it (pt)
const GRID_TOL = 2; // grid lines closer than this are one grid line (pt)
const MIN_CELL = 3; // a grid band narrower than this holds nothing (pt)

// Connected components of crossing rules.
function components(hs, vs) {
  const n = hs.length + vs.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[ra] = rb; };
  const vOrder = vs.map((v, i) => i).sort((a, b) => vs[a].p - vs[b].p);
  const vPos = vOrder.map((i) => vs[i].p);
  hs.forEach((h, hi) => {
    // first v with p >= h.a0 - CROSS
    let lo = 0; let hiIdx = vPos.length;
    while (lo < hiIdx) { const mid = (lo + hiIdx) >> 1; if (vPos[mid] < h.a0 - CROSS) lo = mid + 1; else hiIdx = mid; }
    for (let j = lo; j < vOrder.length && vPos[j] <= h.a1 + CROSS; j += 1) {
      const vi = vOrder[j];
      const v = vs[vi];
      if (h.p >= v.a0 - CROSS && h.p <= v.a1 + CROSS) union(hi, hs.length + vi);
    }
  });
  const groups = new Map();
  for (let i = 0; i < n; i += 1) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, { hs: [], vs: [] });
    if (i < hs.length) groups.get(r).hs.push(hs[i]); else groups.get(r).vs.push(vs[i - hs.length]);
  }
  return [...groups.values()];
}

// Cluster sorted numbers; returns { pos: number[], of: (v)=>index }
function gridLines(values, tol) {
  const s = values.slice().sort((a, b) => a - b);
  const groups = [];
  for (const v of s) {
    const g = groups[groups.length - 1];
    if (g && v - g.hi <= tol) { g.hi = v; g.sum += v; g.n += 1; } else groups.push({ lo: v, hi: v, sum: v, n: 1 });
  }
  const pos = groups.map((g) => g.sum / g.n);
  const of = (v) => {
    let best = 0;
    for (let i = 1; i < pos.length; i += 1) if (Math.abs(pos[i] - v) < Math.abs(pos[best] - v)) best = i;
    return best;
  };
  return { pos, of };
}

// The union length of [a0,a1] pieces clipped to [lo,hi] (pieces within BRIDGE are bridged).
function coverage(pieces, lo, hi) {
  const iv = pieces.map((p) => [Math.max(lo, p.a0 - BRIDGE / 2), Math.min(hi, p.a1 + BRIDGE / 2)]).filter((p) => p[1] > p[0]).sort((a, b) => a[0] - b[0]);
  let covered = 0; let end = -Infinity;
  for (const [a, b] of iv) {
    if (b <= end) continue;
    covered += b - Math.max(a, end);
    end = b;
  }
  return covered;
}

// ---------------------------------------------------------- the grid -------
function buildGrid(comp) {
  const xs = gridLines(comp.vs.map((v) => v.p), GRID_TOL);
  const ys = gridLines(comp.hs.map((h) => h.p), GRID_TOL);
  if (xs.pos.length < 2 || ys.pos.length < 2) return null;
  const nc = xs.pos.length - 1;
  const nr = ys.pos.length - 1;
  // pieces per grid line
  const hAt = ys.pos.map(() => []);
  const vAt = xs.pos.map(() => []);
  for (const h of comp.hs) hAt[ys.of(h.p)].push(h);
  for (const v of comp.vs) vAt[xs.of(v.p)].push(v);
  // edge records: hEdge[j][c] = border on grid line j under column c; vEdge[i][r] = border on grid line i beside row r
  const edge = (pieces, lo, hi) => {
    const len = hi - lo;
    if (len < MIN_CELL) return { has: false };
    const cov = coverage(pieces, lo, hi);
    if (cov < len - Math.max(BRIDGE, 0.1 * len)) return { has: false };
    const touching = pieces.filter((p) => p.a1 > lo && p.a0 < hi);
    if (!touching.length) return { has: false };
    const w = Math.max(...touching.map((p) => p.w));
    const longest = touching.reduce((a, b) => (Math.min(b.a1, hi) - Math.max(b.a0, lo) > Math.min(a.a1, hi) - Math.max(a.a0, lo) ? b : a));
    return { has: true, w, c: longest.c };
  };
  const hEdge = ys.pos.map((_, j) => xs.pos.slice(0, -1).map((x, c) => edge(hAt[j], x, xs.pos[c + 1])));
  const vEdge = xs.pos.map((_, i) => ys.pos.slice(0, -1).map((y, r) => edge(vAt[i], y, ys.pos[r + 1])));
  return { xs: xs.pos, ys: ys.pos, nc, nr, hEdge, vEdge };
}

// ------------------------------------------------------- ruled detector ----
function runCentre(r) { return [r.x + r.w / 2, r.y + r.h / 2]; }

function ruledTables(ctx, taken, rr, claims) {
  if (rr.stats.skipped || !rr.rules.length) return [];
  const hs = mergeCollinear(rr.rules, 'h').filter((r) => r.a1 - r.a0 >= 3 && r.w <= 4);
  const vs = mergeCollinear(rr.rules, 'v').filter((r) => r.a1 - r.a0 >= 3 && r.w <= 4);
  if (hs.length < 2 || vs.length < 2 || hs.length * vs.length > 4e6) return [];
  const pageArea = ctx.widthPt * ctx.heightPt;
  const comps = components(hs, vs).filter((c) => c.hs.length >= 2 && c.vs.length >= 2);
  // biggest first, so a table that contains a smaller drawing wins it
  const sized = comps.map((c) => {
    const x0 = Math.min(...c.vs.map((v) => v.p)); const x1 = Math.max(...c.vs.map((v) => v.p));
    const y0 = Math.min(...c.hs.map((h) => h.p)); const y1 = Math.max(...c.hs.map((h) => h.p));
    return { c, x0, x1, y0, y1, area: (x1 - x0) * (y1 - y0) };
  }).sort((a, b) => b.area - a.area);
  for (const comp of sized) {
    const g = buildGrid(comp.c);
    if (!g || g.nr < 1 || g.nc < 1) continue;
    const x0 = g.xs[0]; const x1 = g.xs[g.nc]; const y0 = g.ys[0]; const y1 = g.ys[g.nr];
    if (taken.some((t) => Math.min(t.x1, x1) - Math.max(t.x0, x0) > 0 && Math.min(t.y1, y1) - Math.max(t.y0, y0) > 0)) continue;
    // which runs fall in which cell
    const colOf = (x) => { for (let c = 0; c < g.nc; c += 1) if (x < g.xs[c + 1]) return x < g.xs[0] ? -1 : c; return -1; };
    const rowOf = (y) => { for (let r = 0; r < g.nr; r += 1) if (y < g.ys[r + 1]) return y < g.ys[0] ? -1 : r; return -1; };
    const inBox = [];
    for (const run of ctx.runs) {
      const [cx, cy] = runCentre(run);
      if (cx < x0 - 1 || cx > x1 + 1 || cy < y0 - 1 || cy > y1 + 1) continue;
      if (colOf(Math.min(cx, x1 - 0.01)) >= 0 && rowOf(Math.min(cy, y1 - 0.01)) >= 0) inBox.push(run);
    }
    const place = () => {
      const merged = mergeCells(g);
      const runsOf = merged.cells.map(() => []);
      for (const run of inBox) {
        const [cx, cy] = runCentre(run);
        runsOf[merged.owner[rowOf(Math.min(cy, y1 - 0.01)) * g.nc + colOf(Math.min(cx, x1 - 0.01))]].push(run);
      }
      return { cells: merged.cells, cellRuns: runsOf };
    };
    let { cells, cellRuns } = place();
    // free text beside the table (same band, outside it) cannot flow around a Word table: leave the table as text
    const inSet = new Set(inBox);
    const beside = ctx.lines.some((l) => !l.runs.every((r) => inSet.has(r)) && l.runs.some((r) => !inSet.has(r))
      && Math.min(l.y + l.h, y1) - Math.max(l.y, y0) > 0.3 * l.h && (l.x + l.w <= x0 + 1 || l.x >= x1 - 1));
    if (beside) continue;
    if (g.nr * g.nc < 4 || g.nc < 2 || g.nr < 2) continue;
    // a "table" whose cells are almost all merged into one is a box with a rule in it
    if (cells.length < 3) continue;
    const q = gridQuality(ctx, g, cells, cellRuns, { x0, y0, x1, y1 });
    const why = drawingReason(q);
    if (ctx.options && ctx.options.tableDebug) (ctx.tableDebug = ctx.tableDebug || []).push({ box: [x0, y0, x1, y1], nr: g.nr, nc: g.nc, why, ...q });
    if (why) continue;
    // a rule a line of text runs straight through is not a border there (a decorative frame, a background line): free the cells
    if (uncross(g, inBox, rowOf)) ({ cells, cellRuns } = place());
    let claim = null;
    try { claim = buildClaim(ctx, g, cells, cellRuns, inBox, { x0, y0, x1, y1 }, pageArea, rr.fills); } catch (e) { claim = null; (ctx.tableErrors = ctx.tableErrors || []).push(String(e && e.message)); } // a table that cannot be built stays text
    if (claim) { claims.push(claim); taken.push(claim); }
  }
  return claims;
}


// Text never runs through a cell border. A vertical grid edge that cuts through a run of text in some row is not a border in that
// row (calendar headings sit across the decorative double lines of the month blocks): drop it there, so the cells it separated
// merge. Returns whether anything changed.
function uncross(g, runs, rowOf) {
  let changed = false;
  for (const run of runs) {
    const m = Math.max(1.5, 0.12 * run.w);
    const r0 = rowOf(run.y + 0.2 * run.h); const r1 = rowOf(run.y + 0.8 * run.h);
    if (r0 < 0 || r1 < 0) continue;
    for (let i = 1; i < g.nc; i += 1) {
      const x = g.xs[i];
      if (x <= run.x + m || x >= run.x + run.w - m) continue;
      for (let r = r0; r <= r1; r += 1) if (g.vEdge[i][r].has) { g.vEdge[i][r] = { has: false }; changed = true; }
    }
  }
  return changed;
}

// How table-like is a ruled grid? (a drawing, an org chart or a slide footer also makes a connected set of rules)
//   edgeFrac   interior grid edges that carry a rule, of all interior edges (a table's are nearly all ruled)
//   cross      share of text runs a ruled interior edge cuts through (text never crosses a table's rules)
//   art        share of the box covered by images or by big fills that are not cell backgrounds
export function gridQuality(ctx, g, cells, cellRuns, box) {
  let have = 0; let all = 0;
  for (let j = 1; j < g.nr; j += 1) for (let c = 0; c < g.nc; c += 1) { all += 1; if (g.hEdge[j][c].has) have += 1; }
  for (let i = 1; i < g.nc; i += 1) for (let r = 0; r < g.nr; r += 1) { all += 1; if (g.vEdge[i][r].has) have += 1; }
  let runs = 0; let crossed = 0;
  for (const rs of cellRuns) {
    for (const run of rs) {
      runs += 1;
      const x0 = run.x + 0.15 * run.w; const x1 = run.x + 0.85 * run.w; const y0 = run.y + 0.2 * run.h; const y1 = run.y + 0.8 * run.h;
      let hit = false;
      for (let j = 1; j < g.nr && !hit; j += 1) {
        if (g.ys[j] <= y0 || g.ys[j] >= y1) continue;
        for (let c = 0; c < g.nc; c += 1) if (g.hEdge[j][c].has && g.xs[c] < x1 && g.xs[c + 1] > x0) { hit = true; break; }
      }
      for (let i = 1; i < g.nc && !hit; i += 1) {
        if (g.xs[i] <= x0 || g.xs[i] >= x1) continue;
        for (let r = 0; r < g.nr; r += 1) if (g.vEdge[i][r].has && g.ys[r] < y1 && g.ys[r + 1] > y0) { hit = true; break; }
      }
      if (hit) crossed += 1;
    }
  }
  const area = (box.x1 - box.x0) * (box.y1 - box.y0) || 1;
  let art = 0;
  for (const im of ctx.images || []) {
    const b = im.box; if (!b) continue;
    art += Math.max(0, Math.min(b.x1, box.x1) - Math.max(b.x0, box.x0)) * Math.max(0, Math.min(b.y1, box.y1) - Math.max(b.y0, box.y0));
  }
  return { edgeFrac: all ? have / all : 1, cross: runs ? crossed / runs : 0, art: Math.min(1, art / area), runs, textCells: cellRuns.filter((rs) => rs.length).length, cells: cells.length, grid: g.nr * g.nc };
}

// Thresholds MEASURED on the 104-file corpus (465 candidate grids, 9 hand-labelled drawings: org charts, a letter
// format, a map caption, a cover page, slide footer bars) and the true tables among them (edgeFrac 0.52..1.0).
const MIN_EDGE = 0.45; // below this, most grid edges have no rule: boxes and connectors, not a table
const SPARSE_TEXT = 5; // fewer text cells than this in a grid that is not mostly ruled is a diagram label set
const SPARSE_EDGE = 0.7;
const CROSS_MAX = 0.08; // text cut by a rule (when the grid is not nearly fully ruled) is a drawing
const ART_MAX = 0.7; // a grid laid over a figure (and not nearly fully ruled) is a figure

// Returns why the grid is NOT a table, or null.
export function drawingReason(q) {
  if (q.textCells < 3) return 'text';
  if (q.edgeFrac < MIN_EDGE) return 'edge';
  if (q.edgeFrac < SPARSE_EDGE && q.textCells < SPARSE_TEXT) return 'sparse';
  if (q.cross > CROSS_MAX && q.edgeFrac < 0.8) return 'cross';
  if (q.art > ART_MAX && q.edgeFrac < 0.9) return 'art';
  return null;
}

// A table module that throws costs the whole page (convert.js turns a throwing page into an empty one), so every stage here fails
// SOFT: what it could not do, it did not do, and the page keeps its text. The reason goes to ctx.tableErrors for the debugger.
function soft(ctx, what, fn, fallback) {
  try { return fn(); } catch (e) { (ctx.tableErrors = ctx.tableErrors || []).push(`${what}: ${String(e && e.message)}`); return fallback; }
}

export function detectTables(ctx) {
  if (!ctx.lines || !ctx.lines.length) return [];
  const taken = [];
  const rr = soft(ctx, 'rules', () => extractRules(ctx), { rules: [], fills: [], shapes: [], stats: { skipped: true } });
  // claims are collected into these as they are made: a claim has already taken its lines out of ctx.lines, so it must survive a later throw
  const ruled = [];
  const text = [];
  soft(ctx, 'ruled', () => ruledTables(ctx, taken, rr, ruled), null);
  soft(ctx, 'text', () => detectTextTables(ctx, taken, rr, text), null);
  return ruled.concat(text);
}

// ------------------------------------------------------------- writer ------
const sideXml = (name, b) => (b ? `<w:${name} w:val="single" w:sz="${b.sz}" w:space="0" w:color="${b.c}"/>` : '');

export function tableXml(t, w) {
  const border = t.border
    ? '<w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="808080"/>`).join('') + '</w:tblBorders>'
    : '';
  // A table has no space-before of its own: a spacer paragraph of exactly that height stands in.
  let x = t.spaceBefore > 0 ? w.paraXml({ kind: 'p', runs: [], lineExact: Math.max(1, t.spaceBefore) }) : '';
  const total = t.colsPt.reduce((a, b) => a + b, 0);
  x += `<w:tbl><w:tblPr><w:tblW w:w="${w.twip(total)}" w:type="dxa"/>${t.indentLeft > 0 ? `<w:tblInd w:w="${w.twip(t.indentLeft)}" w:type="dxa"/>` : ''}${border}<w:tblLayout w:type="fixed"/>`
    + '<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="40" w:type="dxa"/></w:tblCellMar></w:tblPr>';
  x += `<w:tblGrid>${t.colsPt.map((c) => `<w:gridCol w:w="${w.twip(c)}"/>`).join('')}</w:tblGrid>`;
  t.rows.forEach((row, ri) => {
    // MEASURED (LibreOffice 26.2): the row pitch it lays out is trHeight + the border between rows, so the
    // border is taken off the height written; a PDF row of rowsH[ri] then comes out rowsH[ri] tall.
    const bw = Math.max(0, ...row.map((c) => (c.borders && c.borders.bottom ? c.borders.bottom.sz / 8 : 0)));
    const rowH = t.rowsH && t.rowsH[ri] > 0 ? Math.max(1, t.rowsH[ri] - bw) : 0;
    x += `<w:tr>${rowH ? `<w:trPr><w:trHeight w:val="${w.twip(rowH)}" w:hRule="atLeast"/></w:trPr>` : ''}`;
    let col = 0;
    row.forEach((cell) => {
      const span = cell.span > 1 ? cell.span : 1;
      const width = t.colsPt.slice(col, col + span).reduce((a, b) => a + b, 0);
      col += span;
      // an empty cell still holds one paragraph; make it too short to prop the row open
      const paras = cell.blocks && cell.blocks.length ? cell.blocks : [{ kind: 'p', runs: [], lineExact: 1 }];
      const shd = cell.fill && /^[0-9a-f]{6}$/i.test(cell.fill) ? `<w:shd w:val="clear" w:color="auto" w:fill="${cell.fill}"/>` : '';
      const b = cell.borders;
      const borders = b ? `<w:tcBorders>${sideXml('top', b.top)}${sideXml('left', b.left)}${sideXml('bottom', b.bottom)}${sideXml('right', b.right)}</w:tcBorders>` : '';
      const m = cell.mar;
      const mar = m ? `<w:tcMar><w:top w:w="${w.twip(m.t)}" w:type="dxa"/><w:left w:w="${w.twip(m.l)}" w:type="dxa"/><w:bottom w:w="${w.twip(m.b)}" w:type="dxa"/><w:right w:w="${w.twip(m.r)}" w:type="dxa"/></w:tcMar>` : '';
      const vm = cell.vmerge === 'restart' ? '<w:vMerge w:val="restart"/>' : cell.vmerge === 'continue' ? '<w:vMerge/>' : '';
      const va = cell.vAlign && cell.vAlign !== 'top' ? `<w:vAlign w:val="${cell.vAlign}"/>` : '';
      x += `<w:tc><w:tcPr><w:tcW w:w="${w.twip(width)}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ''}${vm}${borders}${shd}${mar}${va}</w:tcPr>${paras.map((p) => w.paraXml(p)).join('')}</w:tc>`;
    });
    x += '</w:tr>';
  });
  return `${x}</w:tbl>`;
}

registerBlock('tbl', tableXml);
