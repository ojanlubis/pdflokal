/*
 * PDFLokal — core/text-lines.js  (LINE CLUSTERING — Edit Teks Asli, line layer)
 * ============================================================================
 * Founder ruling 2026-07-19: the LINE is the editing primitive for "Ganti
 * Teks", not the pdf.js text RUN. A run is a painting artifact — clean
 * exporters emit one run per visual line, but Word (and friends) routinely
 * split a line into many runs at kerning pairs, font switches, or field
 * boundaries. Editing a single fragment leaves siblings behind; the user
 * sees one line and expects to replace all of it.
 *
 * This module clusters js/v2/text-runs.js's `extract()` output into Line[]
 * by GEOMETRY alone — two passes, both in raw PDF user space (pdf.x0/y0/
 * ux/uy/len/size), which is rotation-independent unlike the display x/y/w/h:
 *
 *   1. Baseline pass: sort by the perpendicular offset from the baseline
 *      direction (`p`), grow groups of runs that share a direction and sit
 *      within a size-scaled band of the group's running mean `p`.
 *   2. Along pass: within each baseline group, sort by position along the
 *      baseline (`a0`) and split wherever the gap between runs is wide
 *      enough to be a column gutter rather than a word space — the COLUMN
 *      GUARD that keeps two-column layouts from merging into one line just
 *      because they share a baseline.
 *
 * Each resulting Line carries its own `pdf` geometry — {x0,y0,ux,uy,len,size}
 * spanning every member run's along-extent — which becomes the single
 * surgery target content-stream removal aims at for the WHOLE line, robust
 * even when pdf.js's item boundaries don't match the content stream's actual
 * show-op boundaries.
 *
 * HEADLESS on purpose (no DOM, no vendor imports) — pure geometry over plain
 * objects, tested in tests/core/ under `node --test`, same as text-walk.js.
 */

// Direction-agreement gate for the baseline pass: dot(unit_a, unit_b) >= this
// is ~5° of tolerance between two baselines before we call them different
// directions (e.g. horizontal text vs. a rotated stamp sharing a `p`).
const DIRECTION_DOT_MIN = 0.996;

// Perp-offset gate: a run joins a baseline group only if its `p` sits within
// this fraction of the larger of (run size, group's running max size) from
// the group's running mean `p`. 0.35 is generous enough to swallow ordinary
// baseline jitter (subscript/superscript nudges) while still separating
// distinct lines at normal single-spacing — see test 5 for the documented
// edge case this tolerance deliberately accepts.
const PERP_TOLERANCE_FACTOR = 0.35;

// Column-guard gate for the along pass: a gap bigger than this multiple of
// the larger neighboring font size reads as a column gutter, not a word
// space within one line — split there even though the baseline matches.
const COLUMN_GAP_FACTOR = 1.5;

// Word-space inference: an along-gap bigger than this fraction of the
// PRECEDING run's size is treated as a real word boundary and gets a
// synthesized space, unless one side already carries whitespace (pdf.js
// items often already include their own leading/trailing space — doubling
// it would corrupt the reconstructed string).
const SPACE_GAP_FACTOR = 0.18;

function along(run) {
  const { x0, y0, ux, uy, len } = run.pdf;
  const a0 = x0 * ux + y0 * uy;
  return { a0, a1: a0 + len };
}

function perp(run) {
  const { x0, y0, ux, uy } = run.pdf;
  return -x0 * uy + y0 * ux;
}

// Baseline pass: sort by perp offset, grow groups by direction + perp-band
// agreement. Returns an array of groups, each `{ items: geomItem[] }` where
// geomItem is `{ run, a0, a1, p }`.
function clusterBaselines(geomItems) {
  const byP = [...geomItems].sort((a, b) => a.p - b.p);
  const groups = [];
  let current = null;

  for (const item of byP) {
    const { ux, uy, size } = item.run.pdf;
    if (current) {
      const dot = ux * current.dirX + uy * current.dirY;
      const tolerance = PERP_TOLERANCE_FACTOR * Math.max(size, current.maxSize);
      if (dot >= DIRECTION_DOT_MIN && Math.abs(item.p - current.meanP) <= tolerance) {
        current.items.push(item);
        current.count += 1;
        // Running mean, not a sum/n division — never touches a zero count.
        current.meanP += (item.p - current.meanP) / current.count;
        current.maxSize = Math.max(current.maxSize, size);
        continue;
      }
    }
    current = {
      items: [item],
      dirX: ux,
      dirY: uy,
      meanP: item.p,
      maxSize: size,
      count: 1,
    };
    groups.push(current);
  }

  return groups;
}

// Along pass: within one baseline group, sort by a0 and split on the column
// guard. Returns an array of segments (each a geomItem[] sorted by a0).
function splitAlongBaseline(items) {
  const byA0 = [...items].sort((a, b) => a.a0 - b.a0);
  const segments = [];
  let segment = [];

  for (const item of byA0) {
    if (segment.length > 0) {
      const prev = segment[segment.length - 1];
      const gap = item.a0 - prev.a1;
      const guard = COLUMN_GAP_FACTOR * Math.max(prev.run.pdf.size, item.run.pdf.size);
      if (gap > guard) {
        segments.push(segment);
        segment = [];
      }
    }
    segment.push(item);
  }
  if (segment.length > 0) segments.push(segment);

  return segments;
}

// Assemble one Line from a segment (geomItem[] already sorted by a0).
function assembleLine(segment) {
  const runs = segment.map((item) => item.run);

  let str = runs[0].str;
  for (let i = 1; i < segment.length; i += 1) {
    const prev = segment[i - 1];
    const cur = segment[i];
    const gap = cur.a0 - prev.a1;
    const threshold = SPACE_GAP_FACTOR * prev.run.pdf.size;
    const prevHasSpace = /\s$/.test(str);
    const curHasSpace = /^\s/.test(cur.run.str);
    if (gap > threshold && !prevHasSpace && !curHasSpace) str += ' ';
    str += cur.run.str;
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of runs) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }

  // Dominant run = largest pdf.len — the run most likely to carry the line's
  // real style (a 3-char bold heading fragment shouldn't out-vote 40 chars
  // of body text just because it happens to paint first).
  let dominant = runs[0];
  for (const r of runs) {
    if (r.pdf.len > dominant.pdf.len) dominant = r;
  }

  const minA0 = segment[0].a0; // segment is sorted by a0 — first is the min
  let maxA1 = -Infinity;
  for (const item of segment) maxA1 = Math.max(maxA1, item.a1);
  const first = segment[0].run;

  return {
    str,
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY,
    size: dominant.size,
    fontName: dominant.fontName,
    fontFamily: dominant.fontFamily,
    pdf: {
      x0: first.pdf.x0,
      y0: first.pdf.y0,
      ux: dominant.pdf.ux,
      uy: dominant.pdf.uy,
      len: maxA1 - minA0,
      size: dominant.pdf.size,
    },
    runs,
  };
}

// Cluster pdf.js text runs (js/v2/text-runs.js's extract() shape) into
// visual Lines. Pure geometry, order-independent (paint-order scrambling
// doesn't change the result — everything is re-sorted before use).
export function groupRunsIntoLines(runs) {
  if (!runs || runs.length === 0) return [];

  const geomItems = runs.map((run) => {
    const { a0, a1 } = along(run);
    return { run, a0, a1, p: perp(run) };
  });

  const baselineGroups = clusterBaselines(geomItems);

  const lines = [];
  for (const group of baselineGroups) {
    const segments = splitAlongBaseline(group.items);
    for (const segment of segments) lines.push(assembleLine(segment));
  }
  return lines;
}
