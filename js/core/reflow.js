/*
 * PDFLokal — core/reflow.js  (RUNG D — paragraph wrap + alignment, headless)
 * ============================================================================
 * D2 of the box-bounded reflow spec (spec-rung-d-reflow.md §3): the ENGINE
 * that turns a paragraph's plain-text draft into pre-broken, pre-aligned
 * lines a box can render or export without ever re-measuring on its own.
 *
 * Metrics authority stays with the CALLER — this module never touches a
 * font, fontkit, or the DOM. `widthOf(str)` is injected so the SAME
 * measurer used at commit (native fontkit `advanceWidth`, or the pdf-lib
 * twin's `widthOfTextAtSize`) is the one that decided the breaks; render and
 * export then draw those exact breaks (spec §3 "Commit-time authority") —
 * no engine disagreement, no reflow-on-every-frame.
 *
 * Two pure functions:
 *   wrapText(text, { widthOf, maxWidth })   -> greedy word wrap, honors '\n'
 *   layoutLines(wrapped, { align, ... })    -> per-line dx + justify extras
 * plus `reflow()`, a convenience composition of the two.
 *
 * HEADLESS on purpose (no DOM, no vendor imports) — pure geometry/string
 * math over plain objects, tested in tests/core/ under `node --test`, same
 * discipline as text-lines.js and text-walk.js.
 */

// Runs of whitespace collapse to a single space when a paragraph is
// re-wrapped — spec §3 doesn't ask for anything fancier (no tabs-as-columns,
// no non-breaking-space preservation): a paragraph draft is plain text.
const WHITESPACE_RUN = /\s+/;

// Split one hard-break segment (already '\n'-free) into words. `.trim()`
// first so a segment that's pure whitespace collapses to '' rather than an
// array holding one empty string.
function wordsOf(segment) {
  const trimmed = segment.trim();
  if (trimmed === '') return [];
  return trimmed.split(WHITESPACE_RUN);
}

// Greedy-pack one segment's words into lines against maxWidth. A word that
// doesn't fit even alone gets its own line and keeps its true (overflowing)
// width — spec §3: "never broken mid-word, never scaled". An empty word
// list (blank segment) yields exactly one empty line, per spec's "an empty
// segment between two \n yields an empty line entry {text:'', width:0}" —
// generalized here to every blank segment, including a lone blank paragraph
// with no neighboring '\n' (see wrapText's top-level '' short-circuit for
// the one case that yields NO lines at all: a literally empty draft).
function packWords(words, widthOf, maxWidth) {
  if (words.length === 0) return [{ text: '', width: 0 }];

  const lines = [];
  let current = '';

  for (const word of words) {
    if (current === '') {
      if (widthOf(word) <= maxWidth) {
        current = word;
      } else {
        lines.push({ text: word, width: widthOf(word) }); // overflow word, own line
      }
      continue;
    }

    const candidate = `${current} ${word}`;
    if (widthOf(candidate) <= maxWidth) {
      current = candidate;
    } else {
      lines.push({ text: current, width: widthOf(current) });
      if (widthOf(word) <= maxWidth) {
        current = word;
      } else {
        lines.push({ text: word, width: widthOf(word) }); // overflow word, own line
        current = '';
      }
    }
  }
  if (current !== '') lines.push({ text: current, width: widthOf(current) });

  return lines;
}

// Greedy word wrap inside a fixed-width box. `widthOf(str)` is the injected
// measurer (see module header) — this function never measures anything
// itself, only compares whatever `widthOf` returns against `maxWidth`.
//
// '\n' always breaks a line (a user-typed paragraph break survives reflow
// verbatim); the resulting wrapped line that sits immediately before each
// '\n' is marked `hardBreak: true` so layoutLines can exempt it from
// justification (spec §3: "Last line of the block: left" generalizes to
// "last line of any hard-broken segment: left").
//
// A literally empty string ('') is the one input that yields NO lines —
// "nothing typed" is different from "typed only whitespace", which still
// produces one blank line (see packWords). This is the documented choice
// for the empty-vs-whitespace-only ambiguity the spec leaves open.
export function wrapText(text, { widthOf, maxWidth }) {
  if (typeof text !== 'string' || text === '') return [];

  const segments = text.split('\n');
  const lines = [];

  segments.forEach((segment, segIndex) => {
    const isLastSegment = segIndex === segments.length - 1;
    const segLines = packWords(wordsOf(segment), widthOf, maxWidth);

    segLines.forEach((line, lineIndex) => {
      const isLastLineOfSegment = lineIndex === segLines.length - 1;
      lines.push({
        text: line.text,
        width: line.width,
        hardBreak: !isLastSegment && isLastLineOfSegment,
      });
    });
  });

  return lines;
}

// Number of single-space word gaps in an already-collapsed line's text —
// wrapText only ever joins words with exactly one space, so this is just a
// character count, not a re-split. Zero for an empty line or a lone word.
function gapCount(text) {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) if (text[i] === ' ') count += 1;
  return count;
}

// Per-line placement inside the box: `dx` is the along-offset from the
// box's left edge, `wordGapExtra` is the extra width justify pushes into
// EACH inter-word gap (0 for every other align, and 0 for justify's own
// exempt lines below).
//
// `spaceWidthOf` is accepted per the D2 interface (a future caller — the
// native TJ writer — needs a per-space measurement to turn `wordGapExtra`
// into a glyph-space adjustment) but the dx/extra MATH here is purely
// width-based and doesn't need it; kept in the signature rather than
// dropped so callers can pass it through uniformly. See spec §3's native
// path: "a −(extra/gaps)·1000/size TJ adjustment after each inter-word
// space" — that conversion happens downstream of this module, in D3.
//
// Justify exemptions (spec §3 "Last line of the block: left", generalized):
// the LAST line of the whole layout, any line with zero gaps (nothing to
// justify into, incl. a lone word — whether or not it overflows), and any
// hard-break-terminated line (a typed paragraph break shouldn't stretch to
// fill the box) are all laid out as if align were 'left' for THAT line —
// dx stays 0 (justify's dx is already 0 for every line, so there is no
// visible dx change) and wordGapExtra is forced to 0.
export function layoutLines(wrapped, { align, maxWidth, spaceWidthOf: _spaceWidthOf }) {
  const lastIndex = wrapped.length - 1;

  return wrapped.map((line, index) => {
    const { text, width, hardBreak } = line;

    let dx;
    if (align === 'right') dx = maxWidth - width;
    else if (align === 'center') dx = (maxWidth - width) / 2;
    else dx = 0; // left and justify both start at the box's left edge

    let wordGapExtra = 0;
    if (align === 'justify') {
      const gaps = gapCount(text);
      const isLastLine = index === lastIndex;
      const exempt = isLastLine || gaps === 0 || hardBreak === true;
      if (!exempt) wordGapExtra = (maxWidth - width) / gaps;
    }

    return { text, width, dx, wordGapExtra };
  });
}

// Convenience composition: wrap, then lay out, in one call.
export function reflow(text, { widthOf, maxWidth, align }) {
  const wrapped = wrapText(text, { widthOf, maxWidth });
  return layoutLines(wrapped, { align, maxWidth, spaceWidthOf: undefined });
}
