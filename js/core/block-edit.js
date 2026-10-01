/*
 * PDFLokal — core/block-edit.js  (RUNG D — edit a whole paragraph, headless)
 * ============================================================================
 * His call (seat decisions.md 2026-10-01, malam, final): "if paragraph, edit
 * the whole paragraph; if not, the gated line split applies". A tap on a line
 * that paragraph-detect.js marked as part of a body-text block opens the WHOLE
 * block; the lines re-wrap inside the block's own box (width fixed, height may
 * grow) in its own alignment and leading. spec-rung-d-reflow.md is the parent.
 *
 * THE PRINCIPLE THIS MUST HOLD, his (2026-10-01, malam, later §2): what the
 * user sees while typing is what the file contains. Across a block that means
 * the LINE BREAKS too, not only the face. So the breaks are never re-derived
 * after the user stops typing: the editor reads the breaks it PAINTED (js/v2/
 * block-editor.js readEditorLines) and they are stored, as they are, on the
 * committed annotation (`block.lines`). Every renderer (the overlay, the stamp,
 * the export's twin) draws those exact lines; this module only decides where
 * each one goes. A wrap engine guessing the browser's breaks would agree on
 * most lines and silently disagree on a subpixel boundary or a hyphen.
 *
 * Three pure functions:
 *   planBlockEdit(block, pageLines, opts) -> { ok:true, plan } | { ok:false, reason }
 *       Tap time. Proves the block can be edited as one, or names why not; a
 *       decline falls back to today's per-line edit for that tap.
 *   placeBlockLines(block, widthOf)       -> [{ text, x, y, segments }]
 *       Draw time. Where each stored line goes in PDF user space, laid out
 *       with the font that DRAWS it (reflow.js layoutLines does the math), so
 *       a justified line lands on the box's right edge in that font.
 *   blockExtent(block)                    -> { x, y, w, h } display px
 *
 * Decline-never-guess reasons (BLOCK_DECLINE_REASONS, the `block_edit`
 * telemetry enum): rotated · mixed-sizes · columns · list · not-prose ·
 * heading · align-unknown.
 * Mixed FONTS are not a decline: his answer 1 (same day) writes a line, and so
 * a block, in ONE font while editing; a bold word un-bolds.
 *
 * Geometry is horizontal-only by construction (rotated text declines), so the
 * along axis is PDF x and the perp axis is PDF y. HEADLESS: no DOM, no vendor
 * imports, tested in tests/core/block-edit.test.mjs.
 */

import { blocksFromLines } from './paragraph-detect.js';
import { layoutLines } from './reflow.js';

export const BLOCK_DECLINE_REASONS = ['rotated', 'mixed-sizes', 'columns', 'list', 'not-prose', 'heading', 'align-unknown'];

// A list's first line starts with a marker. Reflowing a list would carry the
// markers into the middle of lines. MOVED here from text-blocks.js (the D1
// clusterer, deleted 2026-10-01 in favour of paragraph-detect.js), verbatim.
// Widened 2026-10-01 to parenthesised markers ("(3)", "(a)"), which open
// numbered clauses in Indonesian regulations.
// Multi-level numbering ("14.1", "2.3.1") too.
const LIST_MARKER_RE = /^\s*([-•*·]|\(?\d{1,3}[.)]|\d{1,3}(\.\d{1,3})+\.?|\(?[a-z][.)])\s/;

// A column of form values (": Budi Santoso" under ": Staf Administrasi") is
// laid out like prose — one left edge, regular leading — and is a list of
// entries. Two lines opening with a colon make it one.
const VALUE_COLUMN_RE = /^\s*:/;
const VALUE_COLUMN_MIN = 2;

// A marker standing ALONE: text-lines.js's soft split cuts "b." or "1)" or a
// form's ":" off the text it introduces, so the marker arrives as its own
// Line beside (or one line above) the block. Same markers as LIST_MARKER_RE,
// plus the colon, and the marker may be the whole string.
const MARKER_PIECE_RE = /^\s*([-•*·:]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)])(\s|$)/;

// Running prose has words. Measured on the public web corpus (2026-10-01):
// of 4,546 blocks paragraph-detect.js accepted, 977 carry ONE word per line —
// table columns of numbers, org-chart boxes — and 107 two. Editing one cell of
// such a column must not pour the column into a paragraph. A block whose lines
// (the last excepted) hold fewer than PROSE_MIN_WORDS words at the median, or
// whose words are mostly letterless (numbers, codes), is not prose.
const PROSE_MIN_WORDS = 3;
const PROSE_MIN_LETTERED = 0.5;
// Dot leaders and fill-in blanks: a table of contents or a form, not prose.
const LEADER_RE = /\.{4,}|…{2,}|_{4,}/;
const wordsOf = (s) => String(s || '').trim().split(/\s+/).filter(Boolean);

// A run counts as horizontal when its baseline direction is within ~0.6° of +x.
const HORIZONTAL_UY_MAX = 0.01;

// Every RUN of the block within +/-5% of the block's median size — the same
// tolerance paragraph-detect.js links lines by, applied one level down: a
// superscript footnote marker inside a line is a run, and the detector never
// sees it.
const SIZE_TOLERANCE = 0.05;

// An edge "agrees" within this many em (paragraph-detect.js's EDGE_TOLERANCE_EM).
const EDGE_TOLERANCE_EM = 0.6;

// Room added to the box width, in PDF units, so the block's own widest line
// still fits on one line in the editor: the browser lays text out in 1/64 px
// units, and a line whose width EQUALS the box can wrap its last word on a
// rounding. The stored width carries it too, so screen and file justify to the
// same edge.
const WIDTH_SLACK_PT = 0.5;

// An interword space, in em, for the wrap-evidence estimate.
const SPACE_EM = 0.25;

// How far left of the box a marker piece may start and still introduce it.
const FIRST_LINE_REACH_EM = 4;

// Below this a baseline step is not leading (degenerate input).
const MIN_LEADING_EM = 0.5;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

const decline = (reason) => ({ ok: false, reason });

const isHorizontal = (r) => r.pdf.ux > 0 && Math.abs(r.pdf.uy) <= HORIZONTAL_UY_MAX;

// Two baselines are the same line within this many em.
const BASELINE_SAME_EM = 0.1;

// A line this much smaller than the paragraph's text, inside its box, is a
// superscript/subscript (a footnote marker), not another column.
const SIZE_AGREEMENT_EM = 0.15;

// One Line from several on the same baseline, in along order.
function mergeLines(ls) {
  const sorted = [...ls].sort((a, b) => lineGeom(a).a0 - lineGeom(b).a0);
  const runs = sorted.flatMap(runsOf);
  const a0 = Math.min(...runs.map((r) => r.pdf.x0));
  const a1 = Math.max(...runs.map((r) => r.pdf.x0 + r.pdf.len));
  const box = unionBox(sorted.map((l) => ({ x: l.x, y: l.y, w: l.w, h: l.h })));
  return {
    ...sorted[0],
    str: sorted.map((l) => String(l.str || '').trim()).join(' '),
    x: box.x, y: box.y, w: box.w, h: box.h,
    pdf: { ...sorted[0].pdf, x0: a0, len: a1 - a0 },
    runs,
  };
}

function unionBox(boxes) {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return {
    x, y,
    w: Math.max(...boxes.map((b) => b.x + b.w)) - x,
    h: Math.max(...boxes.map((b) => b.y + b.h)) - y,
  };
}

function runsOf(line) {
  return line.runs && line.runs.length ? line.runs : [{ ...line, pdf: line.pdf }];
}

// Along-extent and baseline of one Line, from its runs (pdf user space).
function lineGeom(line) {
  const runs = runsOf(line);
  const a0 = Math.min(...runs.map((r) => r.pdf.x0));
  const a1 = Math.max(...runs.map((r) => r.pdf.x0 + r.pdf.len));
  return { a0, a1, p: line.pdf.y0 };
}

// The draft's prefill: the block's lines as ONE text, soft breaks as spaces,
// so the editor re-wraps them. NOT spec §2's "\n-joined" draft: a hard break
// never re-wraps, which would defeat the rung. A line ending in a hyphen joins
// the next with no space ("sehari-" + "hari"); a soft hyphen (U+00AD) is a
// break the producer inserted, and is dropped.
export function prefillText(lines) {
  let out = '';
  for (const line of lines) {
    const s = String(line.str || '').replace(/\s+/g, ' ').trim();
    if (!s) continue;
    if (!out) { out = s; continue; }
    if (out.endsWith('\u00AD')) out = out.slice(0, -1) + s;
    else if (out.endsWith('-')) out += s;
    else out += ` ${s}`;
  }
  return out;
}

// The block (paragraph-detect.js blocksFromLines shape) a tapped line sits in,
// or null when the line is not in one.
export function blockOfLine(pageLines, line) {
  if (!line || line.blockId === null || line.blockId === undefined) return null;
  return blocksFromLines(pageLines).find((b) => b.id === line.blockId) || null;
}

// Decide whether `block` can be edited as one paragraph. `pageLines` is every
// Line on the page (for the columns check); `opts.rotation` the page's total
// rotation (display mapping assumes an unrotated page).
//
// plan (all JSON; it becomes the committed annotation's `block` minus lines):
//   align      'left' | 'justify' | 'right'
//   indent     first-line indent, pdf units (left/justify only, else 0)
//   width      box width, pdf units (the reflow boundary, slack included)
//   leading    median baseline step, pdf units
//   size       font size, pdf units (median of every run)
//   origin     {x, y} pdf user space: the box's left edge on the first baseline
//   k          display px per pdf unit
//   disp       {x, y} display px of `origin`
//   srcLines   the block's own line count
//   srcWords   words per original line (for `reflowed`, content-blind)
//   below      display y of the nearest other line under the block that
//              shares its columns, or null (the grow-down collision check)
// plus, NOT stored: text (prefill), targets (one surgery target per run),
// runs (for the font decision), box (display bbox, the cover).
export function planBlockEdit(block, pageLines, opts = {}) {
  const src = block && block.lines;
  if (!src || src.length < 2) return decline('align-unknown');
  const others = (pageLines || []).filter((l) => l && l.pdf && !src.includes(l));

  if ((((opts.rotation || 0) % 360) + 360) % 360 !== 0) return decline('rotated');
  if (src.flatMap(runsOf).some((r) => !isHorizontal(r))) return decline('rotated');
  const size = median(src.flatMap(runsOf).map((r) => r.pdf.size));
  if (!(size > 0)) return decline('mixed-sizes');
  const tol = EDGE_TOLERANCE_EM * size;

  // ---- absorb the paragraph's own fragments ---------------------------------
  // text-lines.js cuts a line at a gap wider than 1.5em (its column guard); a
  // justified line stretched that far arrives as two Lines, and paragraph-
  // detect.js holds only the piece that fits the block's edges. A piece on the
  // SAME baseline as a block line, at the same size, inside the block's along
  // range, is that line's own text: it joins the line (its runs become targets
  // too). Measured on the web corpus 2026-10-01: 13 of the first 40 'columns'
  // declines were exactly this.
  const g0 = src.map(lineGeom);
  const left0 = Math.min(...g0.map((g) => g.a0));
  const right0 = Math.max(...g0.map((g) => g.a1));
  const parts = src.map((l) => [l]);
  const absorbed = new Set();
  for (const o of others) {
    if (!runsOf(o).every(isHorizontal)) continue;
    if (Math.abs(o.pdf.size - size) / size > SIZE_TOLERANCE) continue;
    const h = lineGeom(o);
    if (h.a0 < left0 - tol || h.a1 > right0 + tol) continue;
    const i = g0.findIndex((g) => Math.abs(g.p - h.p) <= BASELINE_SAME_EM * size);
    if (i < 0) continue;
    parts[i].push(o);
    absorbed.add(o);
  }
  const lines = parts.map((ps) => (ps.length === 1 ? ps[0] : mergeLines(ps)));
  const runs = lines.flatMap(runsOf);
  const rest = others.filter((o) => !absorbed.has(o));

  if (runs.some((r) => Math.abs(r.pdf.size - size) / size > SIZE_TOLERANCE)) return decline('mixed-sizes');

  if (LIST_MARKER_RE.test(lines[0].str || '')) return decline('list');
  if (lines.filter((l) => VALUE_COLUMN_RE.test(l.str || '')).length >= VALUE_COLUMN_MIN) return decline('list');

  const medWords = median(lines.slice(0, -1).map((l) => wordsOf(l.str).length));
  const tokens = lines.flatMap((l) => wordsOf(l.str));
  const lettered = tokens.filter((t) => /\p{L}/u.test(t)).length;
  if (medWords < PROSE_MIN_WORDS || lettered < PROSE_MIN_LETTERED * tokens.length) return decline('not-prose');
  if (lines.some((l) => LEADER_RE.test(l.str || ''))) return decline('not-prose');

  // A heading the detector stacked on top of its body (same size, its own
  // face): the first line's font is not the one every other line shares.
  // Editing them as one would pour the heading into the paragraph.
  const bodyFonts = new Set(lines.slice(1).map((l) => l.fontName));
  if (lines[0].fontName && bodyFonts.size === 1 && !bodyFonts.has(lines[0].fontName)) return decline('heading');

  // ---- alignment, from the lines' own edges --------------------------------
  const geoms = lines.map(lineGeom);
  const last = geoms.length - 1;
  const left = median(geoms.slice(1).map((g) => g.a0));
  const right = Math.max(...geoms.map((g) => g.a1));
  const firstIndent = geoms[0].a0 - left;
  const indented = firstIndent > tol;
  const leftOk = geoms.every((g, i) => (i === 0 && indented) || Math.abs(g.a0 - left) <= tol);
  const rightOkExLast = geoms.every((g, i) => i === last || Math.abs(g.a1 - right) <= tol);
  const rightOkAll = geoms.every((g) => Math.abs(g.a1 - right) <= tol);

  let align;
  if (leftOk && rightOkExLast) align = 'justify';
  else if (leftOk) align = 'left';
  else if (rightOkAll && !indented) align = 'right';
  else return decline('align-unknown');

  const boxLeft = align === 'right' ? Math.min(...geoms.map((g) => g.a0)) : left;
  const width = right - boxLeft + WIDTH_SLACK_PT;

  const steps = [];
  for (let i = 1; i < geoms.length; i += 1) steps.push(geoms[i - 1].p - geoms[i].p);
  const leading = median(steps);
  if (!(leading > MIN_LEADING_EM * size)) return decline('align-unknown');

  // ---- wrapped prose, not stacked entries ------------------------------------
  // A paragraph's line ends because the next word did not fit. A stack of
  // labels ("Warga Negara Indonesia / Warga Negara Asing / ...") has one left
  // edge and regular leading too, but its lines end where the entry ends, with
  // room to spare. Every line but the last must show that the next line's
  // first word would have overflowed the box (with half an em of slack: the
  // word's width is estimated from its share of its line's characters).
  for (let i = 0; i < last; i += 1) {
    const next = lines[i + 1];
    const first = wordsOf(next.str)[0] || '';
    const chars = String(next.str || '').trim().length || 1;
    const wFirst = (geoms[i + 1].a1 - geoms[i + 1].a0) * (first.length / chars);
    const need = wFirst + SPACE_EM * size;
    const fits = align === 'right'
      ? geoms[i].a0 - need >= boxLeft + 0.5 * size
      : geoms[i].a1 + need <= right - 0.5 * size;
    if (fits) return decline('not-prose');
  }

  // ---- nothing else may sit inside the box ----------------------------------
  // A line outside the block whose baseline falls inside the block's band and
  // overlaps its along-range would be covered and written over. Smaller than
  // the paragraph's text, it is a superscript or footnote marker INSIDE the
  // paragraph (mixed sizes); otherwise another column or a table cell.
  const pTop = geoms[0].p;
  const pBottom = geoms[last].p;
  for (const other of rest) {
    const g = lineGeom(other);
    const inBand = g.p <= pTop + 0.8 * size && g.p >= pBottom - 0.3 * size;
    if (!inBand) continue;
    const small = other.pdf.size < (1 - SIZE_AGREEMENT_EM) * size;
    // A marker hangs just past the last word of a full line, so for a small
    // line the box counts an edge tolerance wider on each side.
    const pad = small ? tol : 0;
    if (Math.min(g.a1, right + pad) - Math.max(g.a0, boxLeft - pad) <= 0) continue;
    return decline(small ? 'mixed-sizes' : 'columns');
  }

  // A list marker or form colon that introduces this block, cut off by the
  // soft split: a Line on the first line's baseline, or one leading above,
  // that starts left of the box and is (or starts with) a marker. The block
  // would be the item's tail: "(3) Peraturan ..." at the margin, its wrapped
  // lines under the text. Measured on the web corpus 2026-10-01: the most
  // common wrong open before this check.
  for (const other of rest) {
    const g = lineGeom(other);
    const up = g.p - pTop;
    const sameLine = Math.abs(up) <= BASELINE_SAME_EM * size;
    // Exactly one leading: a hanging item's own first line. A numbered
    // HEADING sits further above its paragraph and is not this case.
    const lineAbove = up >= 0.85 * leading && up <= 1.15 * leading;
    if (!sameLine && !lineAbove) continue;
    if (g.a0 >= boxLeft - tol || g.a1 < boxLeft - FIRST_LINE_REACH_EM * size) continue;
    if (Math.abs(other.pdf.size - size) / size > SIZE_TOLERANCE) continue;
    if (MARKER_PIECE_RE.test(other.str || '')) return decline('list');
  }

  // ---- display mapping ---------------------------------------------------------
  // js/v2/text-runs.js carries each run's display-space baseline origin
  // (`org`); with an unrotated page the map is a scale + a translation, read off
  // one run. k = display em / pdf em for that same run.
  const anchor = runs.find((r) => r.org && Number.isFinite(r.org.x) && Number.isFinite(r.org.y) && r.size > 0);
  if (!anchor) return decline('rotated'); // a run text-runs.js could not project
  const k = anchor.size / anchor.pdf.size;
  const toDisp = (X, Y) => ({ x: anchor.org.x + k * (X - anchor.pdf.x0), y: anchor.org.y - k * (Y - anchor.pdf.y0) });

  // The nearest other line BELOW the block that shares its columns: where a
  // grown block starts writing over something (spec §6's collision toast).
  let below = null;
  for (const other of rest) {
    const g = lineGeom(other);
    if (g.p >= pBottom - 0.3 * size) continue;
    if (Math.min(g.a1, right) - Math.max(g.a0, boxLeft) <= 0) continue;
    if (below === null || other.y < below) below = other.y;
  }

  const plan = {
    align,
    indent: indented && align !== 'right' ? firstIndent : 0,
    width,
    leading,
    size,
    origin: { x: boxLeft, y: pTop },
    k,
    disp: toDisp(boxLeft, pTop),
    srcLines: lines.length,
    srcWords: sourceWordCounts(lines),
    below,
    text: prefillText(lines),
    targets: runs.map((r) => r.pdf),
    runs,
    box: unionBox([block.bbox, ...[...absorbed].map((l) => ({ x: l.x, y: l.y, w: l.w, h: l.h }))]),
  };
  return { ok: true, plan };
}

// The paragraph's text as ONE string, from its painted lines: each line plus
// the exact characters the break consumed (`brk`: the spaces a soft break hung,
// '' after a hyphen the browser broke at, '\n' for a typed break). SINGLE
// SOURCE OF TRUTH for a committed block's `text`, so the re-edit prefill and
// the stamped lines are one fact, never two that can drift.
export function logicalTextOf(lines) {
  return lines.map((l) => l.text + (l.brk ?? (l.hard ? '\n' : ' '))).join('').replace(/\s+$/, '');
}

// The stored (JSON) half of a plan, plus the painted lines: what rides the
// committed text annotation as `block`. `lines` = [{ text, brk }] exactly as
// the editor painted them (js/v2/block-editor.js readEditorLines); `hard` is
// derived from `brk` (the line ended at a typed line break).
export function blockAnnotation(plan, lines) {
  const words = (s) => String(s).trim().split(/\s+/).filter(Boolean).length;
  const src = plan.srcWords || null;
  return {
    v: 1,
    align: plan.align,
    indent: plan.indent,
    width: plan.width,
    leading: plan.leading,
    size: plan.size,
    origin: { ...plan.origin },
    k: plan.k,
    disp: { ...plan.disp },
    srcLines: plan.srcLines,
    srcWords: src ? [...src] : null,
    below: plan.below ?? null,
    lines: lines.map((l) => {
      const brk = l.brk ?? (l.hard ? '\n' : ' ');
      return { text: l.text, brk, hard: brk.includes('\n') };
    }),
    // Did the line breaks MOVE? (telemetry `insert.reflowed`, content-blind):
    // a different line count, or any line holding a different number of words
    // than the original line in that slot.
    reflowed: !src || src.length !== lines.length || lines.some((l, i) => words(l.text) !== src[i]),
  };
}

// Word count per original line, for blockAnnotation's `reflowed`.
export function sourceWordCounts(blockLines) {
  return blockLines.map((l) => String(l.str || '').trim().split(/\s+/).filter(Boolean).length);
}

// Where each stored line goes, in PDF user space, measured with the font that
// draws it. `widthOf(str)` is that font's advance width at `block.size`.
// Returns [{ text, x, y, segments:[{ text, x }] }]: a justified line is split
// into words (each carrying its following space) placed at their justified x —
// pdf-lib's drawText has no word spacing, and `Tw` would not apply to the
// two-byte fonts a custom embed produces. Every other line is one segment.
export function placeBlockLines(block, widthOf) {
  const wrapped = block.lines.map((l) => ({ text: l.text, width: widthOf(l.text), hardBreak: !!l.hard }));
  const laid = layoutLines(wrapped, { align: block.align, maxWidth: block.width, firstIndent: block.indent || 0 });
  return laid.map((l, i) => {
    const y = block.origin.y - i * block.leading;
    const x = block.origin.x + l.dx;
    // A line the drawing font measures wider than the box (a font other than
    // the one the editor painted) is not squeezed: it keeps natural spacing.
    const extra = Math.max(0, l.wordGapExtra || 0);
    if (!extra) return { text: l.text, x, y, segments: l.text ? [{ text: l.text, x }] : [] };
    const parts = l.text.split(' ');
    const segments = [];
    let cx = x;
    parts.forEach((word, j) => {
      const lastPart = j === parts.length - 1;
      const piece = lastPart ? word : `${word} `;
      if (word) segments.push({ text: piece, x: cx });
      cx += widthOf(piece) + (lastPart ? 0 : extra);
    });
    return { text: l.text, x, y, segments };
  });
}

// The block's painted extent in display px (page space): the box width, and
// one leading per stored line from the first line's top. For hit-testing a
// committed block after its overlay is gone (baked).
export function blockExtent(block, top) {
  const lead = block.k * block.leading;
  return {
    x: block.disp.x,
    y: top,
    w: block.k * block.width,
    h: Math.max(1, block.lines.length) * lead,
  };
}
