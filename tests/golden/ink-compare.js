/*
 * Ink-relative comparison for the golden suite.
 *
 * WHY THIS EXISTS (audit 2026-08-17, item 1): the area check in
 * render-helpers.js allows 0.5% of PAGE AREA to differ, which on a 595x842 page
 * is ~2,500 pixels. The whole INK of the three baseline pages is 1,070-1,340
 * pixels. So a page with every word missing is under the threshold and passes;
 * the suite could not fail on content. A tolerance has to be a share of what is
 * actually drawn, not of the paper.
 *
 * WHY BLOCKS, NOT PIXELS: the tolerance also has to survive a baseline made on
 * macOS being checked on Linux, where hinting/AA move many individual edge
 * pixels of every glyph. Per-pixel counts divided by ink would have to be loose
 * enough to absorb that, and loose enough to let a word through. Coverage per
 * 8x8 block is what AA drift barely moves (it redistributes edge intensity
 * inside a glyph's own block neighbourhood) and what a missing word moves by
 * tens of percent. A block "changed" when its ink coverage differs by more
 * than INK_BLOCK_DELTA; the page fails when changed blocks exceed
 * INK_CHANGED_BLOCK_RATIO of the blocks that carry ink in either image.
 *
 * Pure functions over { data, width, height } RGBA buffers, so
 * tests/core/golden-ink-compare.test.mjs can prove the property headlessly.
 */

export const INK_BLOCK = 8;
// Per-block coverage (0..1) change that counts as "this block's content changed".
export const INK_BLOCK_DELTA = 0.15;
// A block carries ink when its coverage in either image reaches this.
export const INK_BLOCK_MIN = 0.03;
// Share of ink-carrying blocks allowed to have changed.
export const INK_CHANGED_BLOCK_RATIO = 0.04;

// 0 = paper white, 1 = full ink. Alpha is composited onto white first. The
// DARKEST channel counts, not luminance, so pale-yellow or light-blue text
// (high luminance, still visible ink) is not read as paper.
function darkness(data, i) {
  const a = data[i + 3] / 255;
  const strongest = 255 - Math.min(data[i], data[i + 1], data[i + 2]);
  return (strongest * a) / 255;
}

function blockCoverage(img) {
  const bw = Math.ceil(img.width / INK_BLOCK);
  const bh = Math.ceil(img.height / INK_BLOCK);
  const cov = new Float32Array(bw * bh);
  for (let y = 0; y < img.height; y += 1) {
    const by = Math.floor(y / INK_BLOCK);
    for (let x = 0; x < img.width; x += 1) {
      cov[by * bw + Math.floor(x / INK_BLOCK)] += darkness(img.data, (y * img.width + x) * 4);
    }
  }
  for (let i = 0; i < cov.length; i += 1) cov[i] /= INK_BLOCK * INK_BLOCK;
  return cov;
}

// Returns { inkBlocks, changedBlocks, ratio, fail }. Different dimensions are
// a content change by definition.
export function compareInk(baseline, actual) {
  if (baseline.width !== actual.width || baseline.height !== actual.height) {
    return { inkBlocks: 0, changedBlocks: Infinity, ratio: 1, fail: true, dimsDiffer: true };
  }
  const a = blockCoverage(baseline);
  const b = blockCoverage(actual);
  let inkBlocks = 0;
  let changedBlocks = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] >= INK_BLOCK_MIN || b[i] >= INK_BLOCK_MIN) inkBlocks += 1;
    if (Math.abs(a[i] - b[i]) > INK_BLOCK_DELTA) changedBlocks += 1;
  }
  // A page with no ink on either side matches itself. Otherwise a changed
  // block is a changed block even when the page is nearly empty: the floor of
  // 1 keeps a one-word page from rounding its tolerance up to "anything goes".
  const allowed = Math.max(0, Math.floor(inkBlocks * INK_CHANGED_BLOCK_RATIO));
  return {
    inkBlocks,
    changedBlocks,
    ratio: inkBlocks ? changedBlocks / inkBlocks : 0,
    fail: changedBlocks > allowed,
  };
}
