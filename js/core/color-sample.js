/*
 * PDFLokal — core/color-sample.js  (WHAT COLOUR IS THE PAPER, WHAT COLOUR IS THE INK)
 * ============================================================================
 * The arithmetic behind Tip-Ex colour matching and Edit's cover + ink colours.
 * Moved headless (2026-10-10) out of js/v2/app.js, which keeps only the DOM
 * half: decoding the page raster and reading pixels at the points named here.
 * Points are RASTER pixels; `s` is raster px per page point. Samples are
 * [r, g, b] arrays. Every number below is the one app.js shipped with.
 */

const medOf = (arr) => arr.sort((a, b) => a - b)[Math.floor(arr.length / 2)];

// Per-channel median, as #rrggbb.
export const medColor = (px) =>
  `#${[0, 1, 2].map((ch) => medOf(px.map((p) => p[ch])).toString(16).padStart(2, '0')).join('')}`;

export const lumOf = (p) => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];

// ---- Tip-Ex, decided AT STROKE START ------------------------------------------
// Two rings around the press point, 10 samples each: thin ink strokes lose the
// per-channel median to the surrounding paper, so a cream scan yields cream.
export function whiteoutRingPoints(ox, oy, s) {
  const pts = [];
  for (const radius of [6 * s, 12 * s]) {
    for (let i = 0; i < 10; i += 1) {
      const ang = (Math.PI * 2 * i) / 10;
      pts.push([ox * s + radius * Math.cos(ang), oy * s + radius * Math.sin(ang)]);
    }
  }
  return pts;
}
// The Tip-Ex colour, or null when too few samples landed on the raster.
export function whiteoutColorFrom(samples) {
  return samples.length < 8 ? null : medColor(samples);
}

// ---- Edit: cover = paper just OUTSIDE the line, ink = the line's own core -----
// Rings around the CENTER land on ink for big/bold runs (the founder's deck
// title got a dark slab, Jul 18), so paper is sampled just outside the box.
export function paperPoints(line, s) {
  const o = 3 * s;
  const pts = [];
  for (let i = 0; i <= 4; i += 1) {
    const x = (line.x + (line.w * i) / 4) * s;
    pts.push([x, line.y * s - o], [x, (line.y + line.h) * s + o]);
  }
  for (const fy of [0.25, 0.75]) {
    pts.push([line.x * s - o, (line.y + line.h * fy) * s], [(line.x + line.w) * s + o, (line.y + line.h * fy) * s]);
  }
  return pts;
}
export function inkPoints(line, s) {
  const pts = [];
  for (let ix = 1; ix <= 8; ix += 1) {
    for (let iy = 1; iy <= 3; iy += 1) pts.push([(line.x + (line.w * ix) / 9) * s, (line.y + (line.h * iy) / 4) * s]);
  }
  return pts;
}
// The cover colour, or null when too few paper samples landed on the raster.
export function coverColorFrom(paper) {
  return paper.length < 6 ? null : medColor(paper);
}

// The ink colour, or null when nothing in the box clearly separates from the
// paper (anti-aliased gray on plain paper must NOT tint the text).
//
// BUG FIX (founder phone test, 2026-07-19): solid BLACK bold text came back
// visibly GRAY. The old rule took the top luminance-distance QUARTILE and its
// median; a glyph's box is mostly background, so the samples nearest a stroke
// are its ANTI-ALIASED EDGE, and the median of a quartile full of edge pixels
// is literal gray. So: find the most ink-like sample actually seen, keep only
// samples within a tight band of THAT extreme (the ink CORE), median those.
export function inkColorFrom(inside, paper) {
  if (!inside.length || !paper.length) return null;
  const paperLum = lumOf(paper.map((p) => [p[0], p[1], p[2]])
    .reduce((a, b) => [a[0] + b[0] / paper.length, a[1] + b[1] / paper.length, a[2] + b[2] / paper.length], [0, 0, 0]));
  const dists = inside.map((p) => Math.abs(lumOf(p) - paperLum));
  const maxDist = Math.max(...dists);
  if (!(maxDist > 40)) return null;
  const CORE_BAND = 0.75; // keep samples within 25% of the extreme seen
  const core = inside.filter((_, i) => dists[i] >= maxDist * CORE_BAND);
  return medColor(core);
}
