/*
 * PDFLokal — core/text-blocks.js  (PARAGRAPH BLOCK DETECTION — Rung D1, "Ubah Paragraf")
 * ============================================================================
 * D1 of the box-bounded reflow spec (spec-rung-d-reflow.md §2): the block is
 * the next editing primitive up from the LINE (text-lines.js, ruled
 * 2026-07-19) — a paragraph, not a run, not a single line, is what "Ubah
 * Paragraf" reflows inside its own box. This module groups Line[] (the
 * output of text-lines.js's groupRunsIntoLines) into Block[] by GEOMETRY
 * alone, mirroring text-lines.js's own two-pass discipline one level up:
 *
 *   A perp-sorted GREEDY pass over all lines (sorted top-to-bottom in
 *   reading order — i.e. DESCENDING perp, the opposite sort direction from
 *   text-lines.js's baseline pass, which sorts ASCENDING because a RUN's
 *   absolute position within its own line doesn't matter there; a BLOCK's
 *   lines carry real sequential order, so the sort direction here is
 *   deliberate, not copy-paste). The pass keeps MULTIPLE blocks open at once
 *   (not just one): a two-column page interleaves both columns' rows in
 *   perp order (they often share exact baselines), so a candidate line is
 *   offered to every still-open block in creation order and joins the FIRST
 *   one that accepts it, never just "whatever was open last" — otherwise
 *   two column stacks reading row-by-row would each collapse into
 *   single-line blocks instead of staying two coherent multi-line stacks
 *   (see the two-column test). Each candidate is tested against a
 *   candidate block through five gates, in order (spec §2):
 *
 *     1. direction   — dot(candidate, block) >= DIRECTION_DOT_MIN
 *     2. leading     — baseline gap <= MAX_LEADING_FACTOR * block's dominant
 *                       size, AND (once the block already has >=2 lines)
 *                       within +/-25% of the block's median leading so far
 *                       — a blank-line gap is a paragraph break, not a
 *                       generous single-spacing.
 *     3. column      — along-extent overlap >= 50% of the narrower line —
 *                       two side-by-side columns sharing a baseline (gap 0,
 *                       so gate 2 alone wouldn't catch them) never merge.
 *     4. size        — dominant sizes agree within +/-15% — a heading never
 *                       absorbs into the body text below it.
 *     5. indent       — a line whose along-start sits > 1.2 em right of the
 *                       block's running left edge starts a NEW block (the
 *                       surat-resmi first-line-indent convention), UNLESS
 *                       the block already looks centered (centered blocks
 *                       have no left margin to violate — see looksCentered).
 *
 *   Any gate failing closes the open block and starts a new one with the
 *   candidate line. Every block is then finalized into its derived facts
 *   (box, leading, align, dominant font/size, mixedFonts, text, editable)
 *   per spec §2's decline rules.
 *
 * Pure geometry in raw PDF user space (line.pdf.{x0,y0,ux,uy,len,size}),
 * exactly like text-lines.js — rotation-independent, and order-independent
 * (every line is re-sorted before use, so paint-order scrambling of the
 * input never changes the result). HEADLESS on purpose: no DOM, no vendor
 * imports, tested in tests/core/ under `node --test`.
 */

// Direction-agreement gate (spec §2 gate 1) — same 0.996 tolerance as
// text-lines.js's DIRECTION_DOT_MIN (~5 degrees): a rotated stamp, or any
// line whose baseline direction doesn't match the block's, never joins.
const DIRECTION_DOT_MIN = 0.996;

// Leading gate, absolute half (spec §2 gate 2, part 1) — a baseline gap
// wider than double the block's dominant size reads as a blank-line
// paragraph break, never ordinary single/double spacing.
const MAX_LEADING_FACTOR = 2.0;

// Leading gate, regularity half (spec §2 gate 2, part 2) — once a block has
// an established median leading (>=2 lines already in it), a THIRD line's
// gap drifting more than this fraction off that median is still a paragraph
// break even when it would pass MAX_LEADING_FACTOR alone (e.g. an optically
// tightened blank line that isn't a full double-space).
const LEADING_REGULARITY_TOLERANCE = 0.25;

// Column gate (spec §2 gate 3) — two side-by-side column stacks can share an
// exact baseline (leading-gate gap of 0, which passes trivially), so a
// separate along-extent overlap check is required: the candidate's overlap
// with the block's last line must be at least this fraction of the
// NARROWER line's own extent, or they're different columns, not one stack.
const COLUMN_OVERLAP_MIN_FRACTION = 0.5;

// Size gate (spec §2 gate 4) — a heading's larger point size must never
// quietly absorb into the body paragraph directly below it.
const SIZE_AGREEMENT_TOLERANCE = 0.15;

// Indent-split gate (spec §2 gate 5) — the surat-resmi typewriter
// convention: a line starting more than ~1 character's width past the
// block's established left margin is the FIRST line of a NEW paragraph,
// not a continuation of this one.
const INDENT_SPLIT_EM_FACTOR = 1.2;

// Alignment-edge agreement (spec §2 "per-block derived facts"): left/right/
// center edges "agree" across a block's lines when their standard deviation
// stays under half an em. Reused (same tolerance) for the in-progress
// "does this block already look centered" check gate 5 needs — a centered
// block's left edges are deliberately ragged, so the indent gate would
// misfire without this escape hatch.
const ALIGN_EDGE_AGREEMENT_EM = 0.5;

// Decline: bullet/numbered lists (spec §2) — reflowing would eat the
// markers, so a block whose first line looks like one declines to line
// mode rather than guessing how to preserve them across a rewrap.
const LIST_MARKER_RE = /^\s*([-•*·]|\d{1,3}[.)]|[a-z][.)])\s/;

// Along/perp projection for a LINE (mirrors text-lines.js's along()/perp()
// for a RUN, but reads geometry off Line.pdf instead of Run.pdf — same
// formulas, one level up).
function lineGeom(line) {
  const { x0, y0, ux, uy, len, size } = line.pdf;
  return {
    line,
    a0: x0 * ux + y0 * uy,
    a1: x0 * ux + y0 * uy + len,
    p: -x0 * uy + y0 * ux,
    ux,
    uy,
    size,
  };
}

// Population standard deviation — 0 for a single value (trivially "agrees"
// with itself), which is intentional: a 1-line sample never fails an
// agreement gate on its own.
function stddev(values) {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Gate 5's escape hatch: a block already "looks centered" when its lines'
// centers agree tightly but their left edges are ragged. Evaluated on the
// TENTATIVE set (block's items so far PLUS the candidate `g`), not the
// established items alone — a centered paragraph's very first two lines
// routinely differ in a0 by more than 1.2em (that's exactly what centering
// looks like), so checking only already-established lines would still let
// gate 5 misfire on the 2nd line, before there are ever >=2 established
// lines to detect centering from. Needs >=2 points (established + this
// candidate) to mean anything; a still-empty block has shown nothing yet,
// so the indent gate simply can't fire on the very first line anyway (it
// only ever compares a SUBSEQUENT candidate against the running left edge).
function looksCentered(block, g) {
  const items = [...block.items, g];
  if (items.length < 2) return false;
  const em = block.dominantSize;
  const lefts = items.map((it) => it.a0);
  const centers = items.map((it) => (it.a0 + it.a1) / 2);
  const leftAgree = stddev(lefts) < ALIGN_EDGE_AGREEMENT_EM * em;
  const centerAgree = stddev(centers) < ALIGN_EDGE_AGREEMENT_EM * em;
  return centerAgree && !leftAgree;
}

// The five gates (spec §2), checked in order against the block's LAST
// added item and its running stats. Any failure means "close this block,
// start a new one" — see groupLinesIntoBlocks.
function canAppend(block, g) {
  const prev = block.items[block.items.length - 1];

  // 1. direction — fixed at block creation, never updated (mirrors
  // text-lines.js's clusterBaselines snapshotting dirX/dirY once).
  const dot = g.ux * block.dirX + g.uy * block.dirY;
  if (dot < DIRECTION_DOT_MIN) return false;

  // 2. leading
  const gap = Math.abs(prev.p - g.p);
  if (gap > MAX_LEADING_FACTOR * block.dominantSize) return false;
  if (block.items.length >= 2) {
    const med = median(block.leadings);
    if (med > 0) {
      const lo = med * (1 - LEADING_REGULARITY_TOLERANCE);
      const hi = med * (1 + LEADING_REGULARITY_TOLERANCE);
      if (gap < lo || gap > hi) return false;
    }
  }

  // 3. column — overlap against the block's LAST line (the same "previous
  // line" frame of reference the leading gate uses), not the whole block's
  // cumulative range: two columns interleaved by sort order must fail this
  // check at the very first candidate from the wrong column, before any
  // cumulative range could paper over the mismatch.
  const overlap = Math.max(0, Math.min(prev.a1, g.a1) - Math.max(prev.a0, g.a0));
  const narrower = Math.min(prev.a1 - prev.a0, g.a1 - g.a0);
  if (narrower <= 0 || overlap / narrower < COLUMN_OVERLAP_MIN_FRACTION) return false;

  // 4. size — against the block's dominant size, fixed at creation (like
  // direction), so a slow drift across many lines can never sneak a
  // heading-sized line into a body block one small step at a time.
  if (Math.abs(g.size - block.dominantSize) / block.dominantSize > SIZE_AGREEMENT_TOLERANCE) {
    return false;
  }

  // 5. indent split — against the block's RUNNING left edge (min a0 seen so
  // far), which is what lets a first-line-indent paragraph's own 2nd/3rd
  // (flush) lines re-establish the true margin before the NEXT paragraph's
  // indented first line is compared against it.
  const em = block.dominantSize;
  if (g.a0 > block.leftEdge + INDENT_SPLIT_EM_FACTOR * em && !looksCentered(block, g)) {
    return false;
  }

  return true;
}

function startBlock(g) {
  return {
    dirX: g.ux,
    dirY: g.uy,
    dominantSize: g.size,
    leftEdge: g.a0,
    leadings: [],
    items: [g],
  };
}

function appendToBlock(block, g) {
  const prev = block.items[block.items.length - 1];
  block.leadings.push(Math.abs(prev.p - g.p));
  block.leftEdge = Math.min(block.leftEdge, g.a0);
  block.items.push(g);
}

// Alignment classification (spec §2): left edges (a0), right edges (a1),
// and centers ((a0+a1)/2) each "agree" when their stddev stays under
// ALIGN_EDGE_AGREEMENT_EM. The right-edge test for JUSTIFY exempts the
// last line (a justified paragraph's last line is habitually short and
// ragged — that's not a broken layout, it's how justification always
// looks). Priority mirrors spec §2's listed order: both agree -> justify;
// left alone -> left; centers agree -> center; right alone -> right;
// nothing -> unknown (decline to line mode, never guess a layout).
function classifyAlign(items, em) {
  const lefts = items.map((it) => it.a0);
  const rights = items.map((it) => it.a1);
  const rightsExceptLast = rights.slice(0, -1);
  const centers = items.map((it) => (it.a0 + it.a1) / 2);

  const leftAgree = stddev(lefts) < ALIGN_EDGE_AGREEMENT_EM * em;
  const rightAgreeAll = stddev(rights) < ALIGN_EDGE_AGREEMENT_EM * em;
  const rightAgreeExceptLast = rightsExceptLast.length === 0
    || stddev(rightsExceptLast) < ALIGN_EDGE_AGREEMENT_EM * em;
  const centerAgree = stddev(centers) < ALIGN_EDGE_AGREEMENT_EM * em;

  if (leftAgree && rightAgreeExceptLast) return 'justify';
  if (leftAgree) return 'left';
  if (centerAgree) return 'center';
  if (rightAgreeAll) return 'right';
  return 'unknown';
}

// Turn one raw (items-only) block into the public Block shape, computing
// every per-block derived fact spec §2 asks for, plus the editable/reason
// decline verdict.
function finalizeBlock(raw) {
  const items = raw.items;
  const lines = items.map((it) => it.line); // already perp-ordered (reading order)

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const line of lines) {
    minX = Math.min(minX, line.x);
    minY = Math.min(minY, line.y);
    maxX = Math.max(maxX, line.x + line.w);
    maxY = Math.max(maxY, line.y + line.h);
  }

  let a0 = Infinity;
  let a1 = -Infinity;
  let p0 = Infinity;
  let p1 = -Infinity;
  for (const it of items) {
    a0 = Math.min(a0, it.a0);
    a1 = Math.max(a1, it.a1);
    p0 = Math.min(p0, it.p);
    p1 = Math.max(p1, it.p);
  }

  const box = {
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY,
    pdf: { a0, a1, p0, p1, ux: raw.dirX, uy: raw.dirY },
  };

  // width = the reflow boundary (spec §2) — a1 - a0, carried on box.pdf.

  const leading = raw.leadings.length > 0 ? median(raw.leadings) : 0;

  // Dominant line = largest pdf.len, same rule text-lines.js uses to pick a
  // line's dominant run — the longest line is likeliest to carry the
  // block's real style, not a short fragment that happens to sort first.
  let dominant = lines[0];
  for (const line of lines) {
    if (line.pdf.len > dominant.pdf.len) dominant = line;
  }
  const fontName = dominant.fontName;
  const size = dominant.size;
  const mixedFonts = lines.some((l) => l.fontName !== fontName);

  const align = classifyAlign(items, size);

  const text = lines.map((l) => l.str).join('\n');

  let editable = true;
  let reason = null;
  if (lines.length === 1) {
    editable = false;
    reason = 'single-line';
  } else if (align === 'unknown') {
    editable = false;
    reason = 'align-unknown';
  } else if (mixedFonts) {
    editable = false;
    reason = 'mixed-fonts';
  } else if (LIST_MARKER_RE.test(lines[0].str)) {
    editable = false;
    reason = 'list';
  }

  return {
    lines, box, leading, align, fontName, size, mixedFonts, text, editable, reason,
  };
}

// Cluster text-lines.js's Line[] into paragraph Block[]. Pure geometry,
// order-independent (every line is re-sorted by reading position before
// the greedy pass runs, so paint-order/array-order scrambling of the input
// never changes the result), rotation-safe (direction comes off each
// line's own pdf.ux/uy, never assumed horizontal).
export function groupLinesIntoBlocks(lines) {
  if (!lines || lines.length === 0) return [];

  const geoms = lines.map(lineGeom);

  // Top-to-bottom reading order = DESCENDING perp for ordinary horizontal
  // text (PDF y grows upward, so the top of the page is the larger p) —
  // deliberately the opposite sort direction from text-lines.js's baseline
  // pass (see header comment). Tiebreak by ascending along-start so lines
  // that share an exact baseline (e.g. two columns) still sort
  // deterministically regardless of input order.
  geoms.sort((a, b) => (b.p !== a.p ? b.p - a.p : a.a0 - b.a0));

  // Multiple blocks stay open simultaneously (see header comment) — a
  // candidate joins the first open block (in creation order) that accepts
  // it; only when NONE does does it start a new block. Nothing is ever
  // explicitly "closed": a block that can no longer accept lines simply
  // never matches again and sits inert for the rest of the pass.
  const openBlocks = [];
  for (const g of geoms) {
    let target = null;
    for (const block of openBlocks) {
      if (canAppend(block, g)) {
        target = block;
        break;
      }
    }
    if (target) {
      appendToBlock(target, g);
    } else {
      openBlocks.push(startBlock(g));
    }
  }

  return openBlocks.map(finalizeBlock);
}
