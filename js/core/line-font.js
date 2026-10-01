/*
 * PDFLokal — core/line-font.js  (ONE font decision per line, made live)
 * ============================================================================
 * THE FOUNDER'S EDIT PRINCIPLE (seat decisions.md 2026-10-01, malam, later §2):
 * what the user sees while typing must equal what the file will contain. No
 * per-glyph fallback while typing — "one letter in another font" reads as a
 * bug. His answers on the design (same file, malam, last): a line with a bold
 * word is written in ONE font while editing (the word un-bolds); a character
 * no font can write is REFUSED at input with a short note.
 *
 * So this module answers exactly one question, for a WHOLE string: which ONE
 * font can draw every character of it? `decideLineFont` walks an ordered
 * candidate list (the line's own embedded font → its metric clone → an
 * evidence-based substitute) and returns the FIRST candidate whose parsed
 * program paints every character — or `path:'none'` naming the characters
 * nothing can write.
 *
 * The SAME function runs in three places on the SAME font bytes, which is the
 * whole guarantee:
 *   - the editor, on every input (js/v2/line-font-live.js) — the editor then
 *     renders exactly that ONE face, never a CSS fallback stack;
 *   - the stamp, at bake time, as a VERIFIER (core/stamp.js) — it embeds the
 *     decided font only after re-checking this function says yes;
 *   - export, for an edit whose surgery declined (core/export.js) — it draws
 *     the decided font instead of whole-line Helvetica.
 *
 * Rung D (whole-paragraph edit) calls the same function on a block's text:
 * '\n' is a line break, not a glyph, so it never fails coverage here (the
 * stamp's own `multiline` guard is a separate, layout-level decline).
 *
 * Pure: no DOM, no vendor imports. Candidates carry an already-parsed fontkit
 * program (`parsed`) — the caller owns loading. ~6-8 µs on a 50-char line
 * (reference/edit-font-design-2026-10-01.md B7), so no debounce is needed.
 */

import { toStandardFontSafe } from './text-encode.js';
import { cloneFamilyFor } from './font-decide.js';
import { CLONE_FONT_VARIANTS } from './clone-fonts.js';
import { FAMILY_BUCKET_TO_CLONE } from './font-fingerprint.js';

// ---- coverage: does a parsed program PAINT a codepoint -----------------------
// MOVED here verbatim from core/stamp.js (which re-exports textCoveredBy and
// countMissingGlyphs, so every existing importer is untouched). WHY moved:
// stamp.js now calls decideLineFont as its verifier, and decideLineFont needs
// this coverage test — keeping it in stamp.js would make the two modules
// import each other. One home for "does this font paint this char".
//
// Does `cp` map to a glyph that will ACTUALLY PAINT in this program? Mirrors
// reinsert.js's glyphPaints EXACTLY (module header's "keep the glyphPaints
// lesson: cmap presence lies" — a subset font's cmap can claim a codepoint
// whose outline the subsetter dropped or re-indexed, resolving to .notdef or
// an empty contour, which bakes as INVISIBLE text). Space (cp 32) is exempt
// from the contour check — a space glyph legitimately has none — but NOT
// from the hasGlyphForCodePoint check itself: if the subset has no space
// entry at all, pdf-lib has nothing to encode that codepoint with, so this
// still declines (spec §3 rung 1's own space carve-out, stated the same way).
// WHY hasGlyphForCodePoint IS INSIDE THE try (Sentry JAVASCRIPT-S, Aug 2026):
// fontkit parses LAZILY — a wild font whose tables only fault when a cmap is
// first consulted threw from INSIDE this call, straight past a catch that only
// covered the two lines below. Declining (false) is the correct answer to a
// fault: a font we cannot interrogate is by definition one we cannot PROVE is
// right.
export function glyphPaints(font, cp) {
  try {
    if (!font.hasGlyphForCodePoint(cp)) return false;
    if (cp === 32) return true;
    const g = font.glyphForCodePoint(cp);
    if (!g || g.id === 0) return false; // .notdef
    const cmds = g.path && g.path.commands;
    return Array.isArray(cmds) && cmds.length > 0;
  } catch {
    return false;
  }
}

// Does `parsedFont` (a fontkit-parsed program) cover EVERY char of `text`?
// Same NFC normalize as always (a user typing e + combining-acute means é —
// judge coverage on the composed form, one char at a time).
export function textCoveredBy(parsedFont, text) {
  for (const ch of text.normalize('NFC')) {
    if (!glyphPaints(parsedFont, ch.codePointAt(0))) return false;
  }
  return true;
}

// The `insert` telemetry event's glyph-shortfall count — "how many chars did
// the doc's OWN subset lack". Deliberately a SEPARATE pass from textCoveredBy
// so the common, fully-covered case never pays for a count.
export function countMissingGlyphs(parsedFont, text) {
  let n = 0;
  for (const ch of text.normalize('NFC')) {
    if (!glyphPaints(parsedFont, ch.codePointAt(0))) n += 1;
  }
  return n;
}

// ---- writability: coverage is not writability --------------------------------
// pdf-lib's drawText does no shaping and no bidi. A font that COVERS Arabic,
// Devanagari or Thai still draws it wrong: isolated, unjoined, unreordered
// forms. So a character from a script that needs shaping/reordering is
// unwritable whatever font is offered. INFERRED, not yet measured
// (reference/edit-font-design-2026-10-01.md B2 "none") — the bench test that
// would disprove it is one drawText('سلام') read back for joined glyph ids.
// Until then, refuse rather than bake a broken word.
//
// Combining marks are here for the same reason: after NFC, a mark that did
// not compose has nothing to attach to in a shaping-free drawText.
const UNWRITABLE_RANGES = [
  [0x0300, 0x036f], // combining diacritics (left over after NFC)
  [0x0590, 0x08ff], // Hebrew, Arabic, Syriac, Thaana, NKo, Samaritan, Mandaic, Arabic ext.
  [0x0900, 0x0dff], // Devanagari … Sinhala (Indic)
  [0x0e00, 0x0fff], // Thai, Lao, Tibetan
  [0x1000, 0x109f], // Myanmar
  [0x1780, 0x17ff], // Khmer
  [0x1a00, 0x1aff], // Buginese, Tai Tham, combining ext.
  [0x1b00, 0x1bff], // Balinese, Sundanese, Batak
  [0x1dc0, 0x1dff], // combining diacritics supplement
  [0x20d0, 0x20ff], // combining marks for symbols
  [0xa980, 0xa9df], // Javanese
  [0xfb1d, 0xfdff], // Hebrew + Arabic presentation forms A
  [0xfe20, 0xfe2f], // combining half marks
  [0xfe70, 0xfeff], // Arabic presentation forms B
];
export function isWritableCodePoint(cp) {
  for (const [lo, hi] of UNWRITABLE_RANGES) {
    if (cp >= lo && cp <= hi) return false;
  }
  return true;
}

// The string the stamp will actually DRAW, in the form coverage is judged on.
// drawTextSafe (core/text-encode.js) maps pasted lookalikes (thin space, ZWSP,
// NB-hyphen …) before pdf-lib sees them, so judging the raw string would let
// the editor and the file disagree on exactly the pasted-from-Word characters.
export function drawnForm(text) {
  return toStandardFontSafe(String(text ?? '')).normalize('NFC');
}

// A line break is layout, not a glyph (Rung D blocks carry them).
const isBreak = (ch) => ch === '\n' || ch === '\r';

// ---- the decision ---------------------------------------------------------------
//
// candidates: ordered array of
//   { path:'native'|'clone'|'substitute', parsed /* fontkit font */,
//     key? /* page /Font resource name, native only */,
//     face? /* pdf-lib font name of a bundled TTF, e.g. 'Carlito-Bold' */,
//     css? /* the CSS family the editor registered from THOSE bytes */,
//     evidence? }
// Entries that are null/undefined or lack `parsed` are skipped (a candidate
// whose font failed to load simply is not offered).
//
// Returns the decision — plain JSON, it rides the committed annotation:
//   { v:1, path, key, face, css, evidence, uncovered:0, ladder }
// or, when nothing can write the whole string:
//   { v:1, path:'none', uncovered:<n chars>, blocked:[unique chars no candidate
//     can write at all], ladder }
// `ladder` is every candidate's identity (no font object) so a re-edit can
// rebuild the same candidates without re-deriving them from the page.
export function describeCandidate(c) {
  const out = { path: c.path };
  if (c.key != null) out.key = c.key;
  if (c.face != null) out.face = c.face;
  if (c.css != null) out.css = c.css;
  if (c.evidence != null) out.evidence = c.evidence;
  // The weight/style the face was REGISTERED with in the browser, so CSS can
  // ask for exactly that face (never a synthesised bold of a regular one).
  if (c.bold) out.bold = true;
  if (c.italic) out.italic = true;
  return out;
}

export function decideLineFont(text, candidates) {
  const s = drawnForm(text);
  const live = (candidates || []).filter((c) => c && c.parsed);
  const ladder = live.map(describeCandidate);
  const chars = [...s].filter((ch) => !isBreak(ch));
  const allWritable = chars.every((ch) => isWritableCodePoint(ch.codePointAt(0)));

  if (allWritable) {
    for (const c of live) {
      if (chars.every((ch) => glyphPaints(c.parsed, ch.codePointAt(0)))) {
        return { v: 1, ...describeCandidate(c), uncovered: 0, ladder };
      }
    }
  }

  // Nothing writes the whole string. Name the characters NO candidate can
  // write at all — those are what the editor refuses. When every char is
  // writable by SOME candidate but no single one takes them all (a mix), the
  // list is empty and the editor reverts the keystroke that caused it.
  const blocked = [];
  let uncovered = 0;
  for (const ch of chars) {
    const cp = ch.codePointAt(0);
    const writable = isWritableCodePoint(cp) && live.some((c) => glyphPaints(c.parsed, cp));
    if (writable) continue;
    uncovered += 1;
    if (!blocked.includes(ch)) blocked.push(ch);
  }
  return { v: 1, path: 'none', uncovered, blocked, ladder };
}

// The stored form of a decision: what rides the annotation and the edit
// signature. Drops `blocked` (only meaningful while typing). Returns null for
// a 'none' decision — an annotation never stores one (the editor refuses
// first), and the stamp treats a missing decision as "decide the old way".
export function storedDecision(decision) {
  if (!decision || decision.v !== 1 || decision.path === 'none') return null;
  const rest = { ...decision };
  delete rest.blocked;
  return rest;
}

// ---- refusal at input -------------------------------------------------------------
//
// The editor calls this on every input with the text it had last accepted
// (`prev`) and the text it has now (`next`). Returns
//   { text, decision, refused /* the char the note names, or null */ }
// where `text` is what the editor must show: `next` itself when one font can
// write it; `next` with the unwritable characters stripped (a paste carrying
// an emoji keeps the rest of the paste); or `prev` when every char is
// writable by some font but no single font takes them all — the keystroke
// that broke the line is undone.
export function acceptLineInput(prev, next, candidates) {
  const decision = decideLineFont(next, candidates);
  // No candidate loaded means no judgment can be made — never a reason to
  // refuse the user's typing (the editor does not attach without fonts; this
  // keeps the rule true for any other caller too).
  if (!(candidates || []).some((c) => c && c.parsed)) return { text: next, decision, refused: null };
  if (decision.path !== 'none') return { text: next, decision, refused: null };

  if (decision.blocked.length) {
    const stripped = [...next].filter((ch) => !decision.blocked.includes(drawnForm(ch))).join('');
    const again = decideLineFont(stripped, candidates);
    if (again.path !== 'none') return { text: stripped, decision: again, refused: decision.blocked[0] };
  }

  const prevDecision = decideLineFont(prev, candidates);
  return { text: prev, decision: prevDecision, refused: firstNewChar(prev, next) ?? decision.blocked[0] ?? null };
}

// The first character of `next` that is not where it was in `prev` — the one
// just typed, for the note.
function firstNewChar(prev, next) {
  const a = [...prev];
  const b = [...next];
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return b[i] ?? null;
}

// ---- the candidate ladder for one line ---------------------------------------
//
// Given the line's dominant-run font facts (core/font-fingerprint.js's
// resolveFontFingerprint shape: baseFont, programName, family bucket, bold,
// italic), name the bundled faces that follow the line's own font:
//   clone       — exact metric clone by name (/BaseFont, else the embedded
//                 program's own name): Arial→Arimo, Calibri→Carlito, …
//   substitute  — the fingerprint's measured family bucket (serif→Tinos,
//                 mono→Cousine, sans→Arimo), else Arimo by default.
//                 NEVER Helvetica: standard-14 is WinAnsi-only and the screen
//                 draws it with Arial, so it can never be what the user saw.
// Weight/italic come from the dominant run — the line is written in ONE face,
// the dominant run's, so a bold word on a regular line un-bolds (his answer 1).
// Slice 3 widens the substitute evidence (name keywords, PANOSE, flags, shape).
export function faceLadder(fp) {
  const facts = fp || {};
  const variant = `${facts.bold ? '1' : '0'}${facts.italic ? '1' : '0'}`;
  const faceOf = (family) => CLONE_FONT_VARIANTS[family]?.[variant] || null;
  const out = [];
  const cloneFamily = cloneFamilyFor(facts.baseFont) || cloneFamilyFor(facts.programName);
  if (cloneFamily && faceOf(cloneFamily)) out.push({ path: 'clone', face: faceOf(cloneFamily), evidence: 'name' });
  const bucket = FAMILY_BUCKET_TO_CLONE[facts.family] || null;
  const subFamily = bucket || 'Arimo';
  const subFace = faceOf(subFamily);
  if (subFace && !out.some((c) => c.face === subFace)) {
    out.push({ path: 'substitute', face: subFace, evidence: bucket ? 'program' : 'default' });
  }
  return out;
}

// pdf-lib font name ('Carlito-Bold') → its family + style, for the committed
// annotation's fontFamily/bold/italic (the twin drawer's last-resort fallback
// and the format bar both read those).
export function faceStyle(face) {
  for (const [family, variants] of Object.entries(CLONE_FONT_VARIANTS)) {
    for (const [v, name] of Object.entries(variants)) {
      if (name === face) return { family, bold: v.startsWith('1'), italic: v.endsWith('1') };
    }
  }
  return null;
}

// The CSS family a bundled face is registered under in the browser — a
// prefixed name, never 'Arimo': index.html already declares woff2
// @font-face rules under the plain family names, and a FontFace added under
// the same name would merge with them (the browser could then paint from the
// woff2, not from the bytes the stamp embeds).
export function faceCssFamily(face) {
  return `pdflokal-face-${String(face).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}
