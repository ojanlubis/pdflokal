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

// Per-channel median as [r, g, b], and as #rrggbb.
const medRgb = (px) => [0, 1, 2].map((ch) => medOf(px.map((p) => p[ch])));
const hexOf = (rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
export const medColor = (px) => hexOf(medRgb(px));

export const lumOf = (p) => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];

// The luminance distance at which two reads stop being "the same paper": the
// same 40 that separates ink from anti-aliasing in inkColorFrom.
const SEPARATE = 40;

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
// The line's whole box as an integer raster rect, clamped to a w x h raster, or
// null when none of it lands there. The ink is read from EVERY pixel in it (see
// inkColorFrom): a 24-point grid mostly misses the stems of regular-weight text.
export function inkBoxRect(line, s, w, h) {
  const x0 = Math.max(0, Math.floor(line.x * s));
  const y0 = Math.max(0, Math.floor(line.y * s));
  const x1 = Math.min(w, Math.ceil((line.x + line.w) * s));
  const y1 = Math.min(h, Math.ceil((line.y + line.h) * s));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}
// Every pixel of an RGBA buffer (getImageData's .data) as [r, g, b] samples,
// strided down to at most ~maxSamples so a poster-sized line stays cheap.
export function rgbaSamples(data, maxSamples = 60000) {
  const n = data.length >> 2;
  const step = Math.max(1, Math.ceil(n / maxSamples));
  const out = [];
  for (let i = 0; i < n; i += step) out.push([data[i * 4], data[i * 4 + 1], data[i * 4 + 2]]);
  return out;
}
// ---- the line box's own ground -------------------------------------------------
// WHY (feedback 100493, "kok ilang", 2026-10-23: an edited "Rp7.000,00" turned
// to blank paper): the paper read just OUTSIDE the box is a guess about what
// surrounds the line, and on a tight table row it lands on the row's own rules.
// Between black rules above and below, 10 of the 14 outside points are rule,
// their median is black, the cover became a black slab, and the ink, read as
// "the pixel furthest from that black paper", became the WHITE paper inside the
// box: the replacement was stamped white on white. (tests/core/color-sample
// .test.mjs builds that row.) The box itself is a better witness of its own
// ground: most of a line's box is paper, between and above and below the
// glyphs (a bold heading's ink is well under a third of its box), so its
// per-channel median IS the paper the words sit on.

// The cover colour, or null when too few paper samples landed on the raster.
// `inside` (the box's own pixels, inkBoxRect + rgbaSamples) settles a
// disagreement: when the outside read and the box's ground are not the same
// paper, the outside read landed on something else (a table rule, a border)
// and the box's ground is the cover. Agreeing, the outside read stands as it
// always has (it never sees the glyphs, so it is the cleaner of the two).
export function coverColorFrom(paper, inside = null) {
  if (paper.length < 6) return null;
  const outside = medRgb(paper);
  if (inside && inside.length) {
    const ground = medRgb(inside);
    if (Math.abs(lumOf(outside) - lumOf(ground)) > SEPARATE) return hexOf(ground);
  }
  return hexOf(outside);
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
//
// SECOND FIX (2026-10-23, feedback 100356 "ngga hitam, abu2", 100108 "warna
// font"): the 24-point grid was the other half of the same gray. Regular-weight
// 8-12pt text has stems ~1.5 raster px wide, so the grid often never lands on a
// core pixel and the "extreme seen" is already an edge blend. Measured on pure
// black Helvetica, 200 random box placements per size: the gray came back as
// #1b-#6b typical, up to #d4 worst case. Callers now pass EVERY pixel of the
// box (inkBoxRect + rgbaSamples), where the extreme is the true core, and the
// band is 10%, not 25%, so a few dark edge blends cannot drag the median.
//
// THIRD FIX (2026-11-03, feedback 100493): the distance is measured from the
// box's OWN ground, not from the paper read outside it (see "the line box's own
// ground" above). Measured from a black misread, the furthest pixel in the box
// was its white paper, and the stamp went on white.
export function inkColorFrom(inside) {
  if (!inside.length) return null;
  const groundLum = lumOf(medRgb(inside));
  const dists = inside.map((p) => Math.abs(lumOf(p) - groundLum));
  let maxDist = 0;
  for (const d of dists) if (d > maxDist) maxDist = d; // not Math.max(...): box samples run to tens of thousands
  if (!(maxDist > SEPARATE)) return null;
  const CORE_BAND = 0.9; // keep samples within 10% of the extreme seen
  const core = inside.filter((_, i) => dists[i] >= maxDist * CORE_BAND);
  return medColor(core);
}
