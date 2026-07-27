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
// this fraction of the SMALLER of (run size, group's running min size) from
// the group's running mean `p`. Scaling by the smaller participant, not the
// larger, is deliberate (founder field report 2026-07-21, lorem-testing.pdf):
// a 72pt heading sitting 25.2pt above a 10.45pt body line used to get a
// 0.35*72=25.2pt band — wide enough to reach all the way down into the body
// line's own baseline and merge "TESTING" into "Lorem ipsum...". A big run's
// size must not license a band that bridges a much smaller run's own line-
// spacing; the SMALLER participant's jitter is what actually bounds "same
// line" here. The residual cost is smaller and more defensible: a
// superscript/subscript a few points off its base line's baseline may now
// split into its own tiny Line instead of silently merging — see test 5,
// updated to match (a stray tiny fragment is far less harmful than a heading
// eating a whole paragraph).
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
//
// INVESTIGATED 2026-07-21 (founder field report, perpres-letterhead.pdf):
// pdf.js splits the letter-spaced word "PRESIDEN" into "PRES"+"IDEN", and
// this flat gap/size test can't tell that 4.09pt intra-word tracked gap (on
// 10pt text) apart from a real word boundary — it inserts a spurious space,
// "PRES IDEN". A same-line-relative fix was attempted: require a candidate
// gap to be a statistical OUTLIER above the line's own median gap (only
// meaningful with 3+ gaps) rather than merely clearing the flat threshold.
// It was REJECTED after checking it against this project's own real
// fixtures, not just the bug's own repro: perpres-letterhead.pdf's line
// "sebagaimana dimaksud pada ayat (1) paling sedikit" is 6 runs / 5 GENUINE
// word gaps (5.72/5.52/5.04/5.04/4.73pt on 13.5-16.5pt text, sizes vary
// per-run same as PRESIDEN's runs do) — every one of those real gaps sits at
// 1.69x-2.35x its own flat threshold, which fully overlaps PRESIDEN's own
// 2.27x ratio. There is no gap-magnitude or median-relative cutoff that
// keeps this line's 5 real spaces while rejecting PRESIDEN's 1 spurious one:
// any threshold that fixes PRESIDEN also silently deletes every space in
// this line (confirmed by running the diagnostic dump end-to-end, not just
// unit tests — the run-on "sebagaimanadimaksud padaayat(1)palingsedikit" is
// what a median-outlier version of this constant actually produced). Ship
// the flat threshold instead, unattended: it is the ONLY test applied,
// regardless of gap count. PRESIDEN staying "PRES IDEN" is an accepted
// residual (tests/diag-extraction.spec.js pins it) — the user edits the
// prefill anyway; a real fix needs a signal this module's pure-geometry
// input (x0/y0/ux/uy/len/size per run, no font-metrics or content-stream
// operator access) cannot provide.
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
      const tolerance = PERP_TOLERANCE_FACTOR * Math.min(size, current.minSize);
      if (dot >= DIRECTION_DOT_MIN && Math.abs(item.p - current.meanP) <= tolerance) {
        current.items.push(item);
        current.count += 1;
        // Running mean, not a sum/n division — never touches a zero count.
        current.meanP += (item.p - current.meanP) / current.count;
        current.minSize = Math.min(current.minSize, size);
        continue;
      }
    }
    current = {
      items: [item],
      dirX: ux,
      dirY: uy,
      meanP: item.p,
      minSize: size,
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

// ============================================================================
// TAP RESOLUTION — founder field report 2026-07-19: dense single-spaced text
// (a tax letter on a phone) was resolving fat-finger taps to the wrong line.
// Two bugs layered on top of the display-space Line[] geometry above:
//
//   1. Every line's hit box inflated toward MIN_HIT (the ~44px-law touch
//      target) REGARDLESS of neighbors — on dense text the inflated boxes
//      overlapped, always, no matter how tight the real line spacing was.
//   2. Overlapping candidates resolved by nearest-CENTER, which is the wrong
//      question for a line: a 500px-wide line's center is nowhere near a tap
//      at its far edge, and two stacked 12px lines fight over whose center
//      is closer even right at their shared border.
//
// Fix: inflation is clamped PER SIDE to stop at the midpoint gap to the
// nearest neighbor on that side (an isolated side keeps the full, generous
// growth — this only degrades where growth would otherwise collide), and
// resolution scores candidates by distance to their real (uninflated) box,
// falling back to center distance only to break an exact tie.
// ============================================================================

// True when two 1-D ranges overlap by a positive amount. Touching endpoints
// (gap of exactly zero) don't count as overlap — a run whose box abuts
// another's isn't fighting it for space.
function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return Math.min(aEnd, bEnd) - Math.max(aStart, bStart) > 0;
}

// Per-side desired growth for one line, clamped against every OTHER line
// that shares an x-range (a vertical neighbor — above or below) or a
// y-range (a column neighbor — left or right). Each side clamps
// independently: a line can keep full growth on top while its bottom is
// squeezed by a close neighbor below, in the same call. A neighbor whose
// box already overlaps this line's (negative gap) clamps that side to zero
// growth, never negative — inflation never eats into an already-touching
// box.
function clampedGrowth(line, lines, minHit) {
  const growX = Math.max(0, (minHit - line.w) / 2);
  const growY = Math.max(0, (minHit - line.h) / 2);
  let top = growY;
  let bottom = growY;
  let left = growX;
  let right = growX;

  const lx0 = line.x;
  const lx1 = line.x + line.w;
  const ly0 = line.y;
  const ly1 = line.y + line.h;

  for (const m of lines) {
    if (m === line) continue;
    const mx0 = m.x;
    const mx1 = m.x + m.w;
    const my0 = m.y;
    const my1 = m.y + m.h;

    // Vertical neighbor: x-ranges overlap, so a tap in the gap between this
    // line and M is genuinely ambiguous — cap growth at the midpoint.
    if (rangesOverlap(lx0, lx1, mx0, mx1)) {
      if (my1 <= ly0) top = Math.min(top, Math.max(0, (ly0 - my1) / 2));
      else if (my0 >= ly1) bottom = Math.min(bottom, Math.max(0, (my0 - ly1) / 2));
    }

    // Column neighbor: y-ranges overlap — same clamp, horizontal axis.
    if (rangesOverlap(ly0, ly1, my0, my1)) {
      if (mx1 <= lx0) left = Math.min(left, Math.max(0, (lx0 - mx1) / 2));
      else if (mx0 >= lx1) right = Math.min(right, Math.max(0, (mx0 - lx1) / 2));
    }
  }

  return { top, bottom, left, right };
}

// Euclidean distance from (x, y) to the nearest point of a box — 0 when
// (x, y) already sits inside it.
function distanceToBox(x, y, bx, by, bw, bh) {
  const cx = Math.min(Math.max(x, bx), bx + bw);
  const cy = Math.min(Math.max(y, by), by + bh);
  return Math.hypot(x - cx, y - cy);
}

// Tap → line. `lines` carry display-space { x, y, w, h } top-left boxes in
// the same frame as the tap point (x, y) — js/v2/text-runs.js's Line[], or
// any plain objects shaped like one (tests build these directly). `minHit`
// is the finger-sized hit-box target each line's box grows toward, per side,
// clamped against neighbors (see clampedGrowth above). Returns the resolved
// line, or null when no line's (clamped, inflated) box contains the tap.
export function resolveTap(lines, x, y, minHit) {
  if (!lines || lines.length === 0) return null;

  let best = null;
  let bestDist = Infinity;
  let bestCenterDist = Infinity;

  for (const line of lines) {
    const grow = clampedGrowth(line, lines, minHit);
    const bx0 = line.x - grow.left;
    const bx1 = line.x + line.w + grow.right;
    const by0 = line.y - grow.top;
    const by1 = line.y + line.h + grow.bottom;
    if (x < bx0 || x > bx1 || y < by0 || y > by1) continue;

    // Primary score: distance to the REAL (uninflated) box — "which box am
    // I inside / nearest to" is the honest question; nearest-CENTER
    // penalizes long lines at their ends and misresolves stacked dense
    // lines fighting over a shared border. Tie-break: distance to center.
    const dist = distanceToBox(x, y, line.x, line.y, line.w, line.h);
    const centerDist = Math.hypot(x - (line.x + line.w / 2), y - (line.y + line.h / 2));

    if (dist < bestDist || (dist === bestDist && centerDist < bestCenterDist)) {
      best = line;
      bestDist = dist;
      bestCenterDist = centerDist;
    }
  }

  return best;
}
