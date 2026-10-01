/*
 * PDFLokal — core/paragraph-detect.js  (BODY-TEXT BLOCK DETECTOR — the guard)
 * ============================================================================
 * Marks which Lines belong to a body-text block: >= 3 consecutive lines with
 * the same font size, regular leading, one shared edge, and widths that are
 * similar or justified (the last line of a block may be short). Pure
 * geometry over Line[] (line.pdf.{x0,y0,ux,uy,len,size}, display x/y/w/h),
 * rotation-independent, order-independent, and not Latin-only: it reads no
 * text at all, so Indonesian, Arabic, CJK and mixed lines are judged by the
 * same arithmetic. A right-flush block (RTL, ragged on the left) is a block
 * exactly as a left-flush one is.
 *
 * WHY IT EXISTS. text-lines.js's soft split (a gap between 0.6em and the 1.5em
 * column guard, at a list marker or a colon) is right on label/value rows and
 * wrong inside prose: a justified line stretches its word gaps past 0.6em, and
 * "Berikut: ..." in a paragraph is a colon at a gap. The measurement
 * (reference/line-split-measure-2026-10-01.md) showed width alone cannot tell
 * the two apart; membership of a paragraph can. A line inside a block is never
 * split.
 *
 * WHAT IT MUST NOT CALL PROSE (measured 2026-10-01, first build of this file).
 * Geometry alone cannot tell a column of one-line list items, a TOC, or a
 * table's "No | Uraian" column from prose: same size, regular leading, one
 * left edge, similar widths. The first build marked 27% of all lines on the
 * web corpus as blocks and the guard then vetoed 714 of 8,920 splits, of which
 * a visual check of 30 found ~2 correct vetoes and ~27 correct splits killed.
 * The separator is the GUTTER: in a list or table the gap after the marker or
 * label ends at the same x on line after line (or the next line starts right
 * under it: a hanging indent), while in justified prose the first word gap
 * lands wherever the first word happens to end and every line starts at the
 * margin. A piece with either gutter signature is a list/table, not prose,
 * and is not a block. (Reads run geometry only, never run text.)
 *
 * CONSUMER NOTE. Rung D (edit a whole paragraph) wants exactly this: block
 * ids per line plus the block's bbox. `detectParagraphs` returns both.
 * text-lines.js stamps `line.blockId` on every Line it returns, and
 * `blocksFromLines(lines)` regroups by that id. This is NOT text-blocks.js
 * (the D1 reflow clusterer): that one declines or accepts a block for reflow
 * with five gates and list/mixed-font rules; this one only answers "is this
 * line inside running prose", conservatively, so a split can be vetoed.
 *
 * HEADLESS on purpose (no DOM, no vendor imports), tested in tests/core/.
 */

// A block needs at least this many consecutive lines.
export const PARAGRAPH_MIN_LINES = 3;

// Font sizes of neighbouring lines agree within +/-5%.
const SIZE_TOLERANCE = 0.05;

// Baseline-to-baseline distance, in multiples of the font size. Below the
// floor two lines are one baseline (two columns) or overlapping; above the
// ceiling it is a blank-line break, not leading.
const LEADING_MIN = 0.8;
const LEADING_MAX = 2.2;

// Leading regularity: every gap within +/-20% of the chain's median gap.
const LEADING_REGULARITY = 0.2;

// An edge "agrees" within this many em.
const EDGE_TOLERANCE_EM = 0.6;

// A first-line indent up to this many em right of the block's left edge is
// still part of the block, provided the line runs to the block's right edge.
const FIRST_LINE_INDENT_MAX_EM = 3;

// A right-flush block's left edges must be scattered: if this fraction of its
// lines share one left edge, it is a left-flush list with an outlier line.
const RAGGED_LEFT_CLUSTER_MAX = 0.6;

// Non-last lines must reach within this fraction of the block's widest
// extent: "similar or justified" widths, with the last line free to be short.
const FULL_WIDTH_SLACK = 0.3;

// Same direction gate as text-lines.js (about 5 degrees).
const DIRECTION_DOT_MIN = 0.996;

// The soft split's candidate gap (text-lines.js imports this): a gap wider
// than this many em, below the 1.5em column guard, is where a label, marker
// or cell ends. Shared so the guard and the split look at the same gaps.
export const SOFT_SPLIT_GAP_FACTOR = 0.6;

// Two lines share a gutter when their first wide gap ends within this many em
// of each other. A piece with >= GUTTER_MIN_LINES such lines is a list/table.
const GUTTER_ALIGN_EM = 0.2;
const GUTTER_MIN_LINES = 2;

// A hanging indent: another line starts within GUTTER_HANG_EM of where this
// line's first wide gap ended, and at least GUTTER_HANG_MIN_EM right of where
// this line itself starts.
const GUTTER_HANG_EM = 0.4;
const GUTTER_HANG_MIN_EM = 0.5;

function geomOf(line, index) {
  const { x0, y0, ux, uy, len, size } = line.pdf;
  const a0 = x0 * ux + y0 * uy;
  return { index, a0, a1: a0 + len, p: -x0 * uy + y0 * ux, ux, uy, size };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Link each line to the nearest line below it that could continue the same
// paragraph: same direction, same size, a leading-sized step down, and a
// shared left OR right edge. Each line has at most one successor and one
// predecessor, so columns that share baselines cannot braid together.
function linkSuccessors(geoms) {
  const order = [...geoms].sort((a, b) => (b.p !== a.p ? b.p - a.p : a.a0 - b.a0));
  const next = new Map();
  const hasPrev = new Set();
  for (let i = 0; i < order.length; i += 1) {
    const g = order[i];
    let best = null;
    for (let j = i + 1; j < order.length; j += 1) {
      const h = order[j];
      const gap = g.p - h.p;
      if (gap > LEADING_MAX * g.size) break; // sorted descending: only farther from here
      if (gap < LEADING_MIN * g.size) continue;
      if (g.ux * h.ux + g.uy * h.uy < DIRECTION_DOT_MIN) continue;
      if (Math.abs(h.size - g.size) / g.size > SIZE_TOLERANCE) continue;
      if (hasPrev.has(h.index)) continue;
      const tol = EDGE_TOLERANCE_EM * g.size;
      const dLeft = Math.abs(h.a0 - g.a0);
      const dRight = Math.abs(h.a1 - g.a1);
      // A first-line indent: g starts indented but ends where h ends.
      const indented = h.a0 < g.a0 && g.a0 - h.a0 <= FIRST_LINE_INDENT_MAX_EM * g.size && dRight <= tol;
      if (dLeft > tol && dRight > tol && !indented) continue;
      const score = gap + Math.min(dLeft, dRight) * 0.01;
      if (!best || score < best.score) best = { h, score };
    }
    if (best) {
      next.set(g.index, best.h);
      hasPrev.add(best.h.index);
    }
  }
  const heads = order.filter((g) => !hasPrev.has(g.index));
  const chains = [];
  for (const head of heads) {
    const chain = [head];
    let cur = head;
    while (next.has(cur.index)) {
      cur = next.get(cur.index);
      chain.push(cur);
    }
    chains.push(chain);
  }
  return chains;
}

// Cut a chain wherever the step between two lines leaves the regular band
// around the chain's own median leading (a paragraph break inside a chain of
// two paragraphs one blank line apart).
function cutIrregular(chain) {
  if (chain.length < 2) return [chain];
  const gaps = [];
  for (let i = 1; i < chain.length; i += 1) gaps.push(chain[i - 1].p - chain[i].p);
  const med = median(gaps);
  const pieces = [];
  let cur = [chain[0]];
  for (let i = 1; i < chain.length; i += 1) {
    const g = gaps[i - 1];
    if (g < med * (1 - LEADING_REGULARITY) || g > med * (1 + LEADING_REGULARITY)) {
      pieces.push(cur);
      cur = [];
    }
    cur.push(chain[i]);
  }
  pieces.push(cur);
  return pieces;
}

// One regular piece is a block when its lines share ONE edge (left, or right
// for a right-flush script) and every line but the last runs nearly to the
// widest extent. Returns the alignment ('left' | 'right') or null.
function blockAlignment(piece) {
  if (piece.length < PARAGRAPH_MIN_LINES) return null;
  const size = median(piece.map((g) => g.size));
  const tol = EDGE_TOLERANCE_EM * size;
  const last = piece.length - 1;

  const medA0 = median(piece.map((g) => g.a0));
  const medA1 = median(piece.map((g) => g.a1));
  const minA0 = Math.min(...piece.map((g) => g.a0));
  const maxA1 = Math.max(...piece.map((g) => g.a1));
  const width = maxA1 - minA0;
  if (!(width > 0)) return null;

  // Left-flush: every line starts at the left edge, except the first, which
  // may be indented if it still reaches the right edge.
  const leftOk = piece.every((g, i) => {
    if (Math.abs(g.a0 - medA0) <= tol) return true;
    return i === 0 && g.a0 > medA0 && g.a0 - medA0 <= FIRST_LINE_INDENT_MAX_EM * size
      && Math.abs(g.a1 - medA1) <= tol;
  });
  const leftFull = piece.every((g, i) => i === last || g.a1 >= maxA1 - FULL_WIDTH_SLACK * width);
  if (leftOk && leftFull) return 'left';

  // Right-flush: every line ends at the right edge (first-line indent in a
  // right-flush script is the mirror image: the first line may stop short).
  const rightOk = piece.every((g, i) => {
    if (Math.abs(g.a1 - medA1) <= tol) return true;
    return i === 0 && g.a1 < medA1 && medA1 - g.a1 <= FIRST_LINE_INDENT_MAX_EM * size
      && Math.abs(g.a0 - medA0) <= tol;
  });
  const rightFull = piece.every((g, i) => i === last || g.a0 <= minA0 + FULL_WIDTH_SLACK * width);
  // Ragged-left means the left edges are scattered. When most lines DO share a
  // left edge, the piece is left-flush with an outlier (a justified list: the
  // marker line out at the margin, its wrapped lines under the text), and
  // the right-flush reading would wave it through as prose.
  const leftCluster = Math.max(...piece.map((g) => piece.filter((h) => Math.abs(h.a0 - g.a0) <= tol).length));
  if (rightOk && rightFull && leftCluster < RAGGED_LEFT_CLUSTER_MAX * piece.length) return 'right';

  return null;
}

// Where does the first wide gap of this line END along the baseline? null when
// the line has no wide gap (one run, or word gaps all narrower than the soft
// split threshold) or carries no runs (synthetic lines in the detector tests).
function firstGutterEnd(line) {
  const runs = line.runs;
  if (!runs || runs.length < 2) return null;
  const items = runs.map((r) => {
    const a0 = r.pdf.x0 * r.pdf.ux + r.pdf.y0 * r.pdf.uy;
    return { a0, a1: a0 + r.pdf.len, size: r.pdf.size };
  }).sort((a, b) => a.a0 - b.a0);
  for (let i = 1; i < items.length; i += 1) {
    const em = Math.max(items[i - 1].size, items[i].size);
    if (items[i].a0 - items[i - 1].a1 > SOFT_SPLIT_GAP_FACTOR * em) return { a: items[i].a0, em };
  }
  return null;
}

// A list or table, by either of two gutter signatures:
//   aligned gutter — at least GUTTER_MIN_LINES lines have their first wide gap
//     ending at the same x (a "No | Uraian" column, one-line list items);
//   hanging indent — some line starts exactly where ANOTHER line's first wide
//     gap ended, indented past that line's own start (an item's marker at the
//     margin, its wrapped lines under the text). Justified items pass every
//     other test, because the right edge is flush and the leading regular.
function hasGutterSignature(pieceLines) {
  const ends = [];
  pieceLines.forEach((line, i) => {
    const e = firstGutterEnd(line);
    if (e) ends.push({ ...e, i, start: geomOf(line, i).a0 });
  });
  for (let i = 0; i < ends.length; i += 1) {
    let n = 1;
    for (let j = i + 1; j < ends.length; j += 1) {
      if (Math.abs(ends[j].a - ends[i].a) <= GUTTER_ALIGN_EM * ends[i].em) n += 1;
    }
    if (n >= GUTTER_MIN_LINES) return true;
    for (let k = 0; k < pieceLines.length; k += 1) {
      if (k === ends[i].i) continue;
      const a0 = geomOf(pieceLines[k], k).a0;
      if (a0 > ends[i].start + GUTTER_HANG_MIN_EM * ends[i].em && Math.abs(a0 - ends[i].a) <= GUTTER_HANG_EM * ends[i].em) return true;
    }
  }
  return false;
}

// The last line of a block is allowed to be short because it is not justified,
// which is also why a wide gap in it is NOT justification stretch: a short
// last line that still has a wide gap is a list item or a label sitting under
// a lead-in sentence ("... sebagai berikut:" then "a. Presiden ..."), not the
// end of the paragraph. Returns the piece without such a tail line.
function trimGutterTail(piece, lines, align) {
  if (piece.length < PARAGRAPH_MIN_LINES) return piece;
  const last = piece[piece.length - 1];
  const size = last.size;
  const tol = EDGE_TOLERANCE_EM * size;
  const short = align === 'right'
    ? last.a0 > Math.min(...piece.map((g) => g.a0)) + tol
    : last.a1 < Math.max(...piece.map((g) => g.a1)) - tol;
  return short && firstGutterEnd(lines[last.index]) ? piece.slice(0, -1) : piece;
}

// Detect body-text blocks over Line[].
//
// Returns { blocks, blockOf }:
//   blockOf[i]  block id of lines[i], or -1 when line i is not in a block
//   blocks[k]   { id, lineIdx: number[] (reading order), align, bbox, pdf }
//               bbox = {x,y,w,h} in the Lines' own display frame; pdf =
//               {a0,a1,p0,p1,ux,uy} in raw PDF user space.
export function detectParagraphs(lines) {
  const blockOf = new Array(lines ? lines.length : 0).fill(-1);
  if (!lines || lines.length < PARAGRAPH_MIN_LINES) return { blocks: [], blockOf };

  const geoms = lines.map(geomOf);
  const found = [];
  // Accept a piece as a block, or (when its alignment fails) retry the runs of
  // consecutive lines that DO share a left edge: the chain linker joins lines
  // by left OR right edge, so a justified list ("1." items at the margin,
  // wrapped lines under the text) arrives as one chain whose left edges jump,
  // and the paragraph inside it would be thrown out with its markers.
  const consider = (piece, retry) => {
    let kept = piece;
    let align = blockAlignment(kept);
    if (!align) {
      if (!retry) return;
      const subs = [[kept[0]]];
      for (let i = 1; i < kept.length; i += 1) {
        const tol = EDGE_TOLERANCE_EM * kept[i].size;
        if (Math.abs(kept[i].a0 - kept[i - 1].a0) <= tol) subs[subs.length - 1].push(kept[i]);
        else subs.push([kept[i]]);
      }
      if (subs.length > 1) subs.filter((sub) => sub.length >= PARAGRAPH_MIN_LINES).forEach((sub) => consider(sub, false));
      return;
    }
    const trimmed = trimGutterTail(kept, lines, align);
    if (trimmed !== kept) {
      kept = trimmed;
      align = blockAlignment(kept);
    }
    if (align && !hasGutterSignature(kept.map((g) => lines[g.index]))) found.push({ piece: kept, align });
  };
  for (const chain of linkSuccessors(geoms)) {
    for (const piece of cutIrregular(chain)) consider(piece, true);
  }
  // Number blocks in reading order of their first line (top of page first).
  found.sort((a, b) => (b.piece[0].p !== a.piece[0].p ? b.piece[0].p - a.piece[0].p : a.piece[0].a0 - b.piece[0].a0));

  const blocks = found.map(({ piece, align }, id) => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const g of piece) {
      const l = lines[g.index];
      blockOf[g.index] = id;
      minX = Math.min(minX, l.x);
      minY = Math.min(minY, l.y);
      maxX = Math.max(maxX, l.x + l.w);
      maxY = Math.max(maxY, l.y + l.h);
    }
    return {
      id,
      lineIdx: piece.map((g) => g.index),
      align,
      bbox: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
      pdf: {
        a0: Math.min(...piece.map((g) => g.a0)),
        a1: Math.max(...piece.map((g) => g.a1)),
        p0: Math.min(...piece.map((g) => g.p)),
        p1: Math.max(...piece.map((g) => g.p)),
        ux: piece[0].ux,
        uy: piece[0].uy,
      },
    };
  });
  return { blocks, blockOf };
}

// Regroup Lines that text-lines.js stamped with `blockId` into blocks, in
// reading order, with each block's bbox. Lines with blockId null are skipped.
export function blocksFromLines(lines) {
  const byId = new Map();
  for (const line of lines || []) {
    if (line.blockId === null || line.blockId === undefined) continue;
    if (!byId.has(line.blockId)) byId.set(line.blockId, []);
    byId.get(line.blockId).push(line);
  }
  return [...byId.entries()].sort((a, b) => a[0] - b[0]).map(([id, ls]) => {
    const g = ls.map(geomOf);
    g.sort((a, b) => b.p - a.p);
    const ordered = g.map((x) => ls[x.index]);
    const x = Math.min(...ordered.map((l) => l.x));
    const y = Math.min(...ordered.map((l) => l.y));
    return {
      id,
      lines: ordered,
      bbox: {
        x,
        y,
        w: Math.max(...ordered.map((l) => l.x + l.w)) - x,
        h: Math.max(...ordered.map((l) => l.y + l.h)) - y,
      },
    };
  });
}
