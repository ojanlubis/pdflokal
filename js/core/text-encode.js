/*
 * PDFLokal — core/text-encode.js  (MAKE PASTED TEXT SURVIVE A STANDARD FONT)
 * ============================================================================
 * SINGLE SOURCE OF TRUTH for normalising annotation text before it is drawn
 * with one of pdf-lib's STANDARD fonts (Helvetica / Times / Courier).
 *
 * WHY THIS EXISTS — the 2026-07-28 incident. A standard font encodes through
 * WinAnsi (cp1252). Hand pdf-lib a single codepoint outside that set and it
 * throws a BARE `Error` ("WinAnsi cannot encode …"), and js/core/export.js's
 * annotation loop has no per-annotation guard — so ONE character anywhere in
 * the document aborts the ENTIRE export. Every retry fails identically,
 * because nothing about the document has changed.
 *
 * That is exactly what one user hit: 82 minutes, 174 text annotations, 41
 * download attempts, zero successes, and no way to know which annotation was
 * poisoned. Helvetica is the DEFAULT (js/v2/format-bar.js), so this is the
 * ordinary path, not an exotic one.
 *
 * WHAT ACTUALLY POISONS IT is the invisible half of pasted text. Measured
 * against the vendored pdf-lib: curly quotes, en/em dashes, NBSP, bullets and
 * ellipses are all FINE. What throws is
 *   U+2009 thin space      — number/currency formatting out of Word
 *   U+200B zero-width space — pasted from a web page
 *   U+2011 non-breaking hyphen — Word autoformat
 *   U+2212 minus sign      — Word/Excel
 *   U+FEFF byte-order mark — pasted from a file
 * Every one of them is INVISIBLE or indistinguishable from an ASCII character
 * the user believes they typed. Someone pasting 174 blocks of Indonesian text
 * out of Word will carry at least one, and will never see it.
 *
 * SO THE MAPPING IS DELIBERATELY CONSERVATIVE: each entry maps to the
 * character it already LOOKS like, or to nothing when it was already
 * invisible. Nothing a reader can see changes. This is not a general
 * transliterator and must not become one — a mapping that altered visible text
 * would be silently rewriting the user's document, which is worse than the
 * crash it prevents.
 *
 * ⚠️ WHAT THIS DELIBERATELY DOES NOT FIX: a genuinely unrenderable character —
 * an emoji, or CJK — in a standard font. Those still throw, and the export
 * still fails. Dropping them would silently delete something the user typed
 * and can SEE; that is a product call, not a bug fix, so it is left to the
 * seat. What changed is that the failure now reports `reason: 'unsupported'`
 * instead of 'unknown' (core/failure-reason.js), so we can find out whether it
 * ever actually happens instead of guessing.
 */

// NUMERIC CODEPOINTS, NOT LITERAL CHARACTERS, ON PURPOSE. Every key here is
// invisible or looks exactly like an ASCII character, so a literal table would
// be unreviewable and one editor-normalisation away from silently changing
// meaning -- the same property that makes these characters dangerous in the
// first place. Writing this file the obvious way mangled it twice before it
// was written this way. Numbers cannot be normalised.
//
// Each entry: a codepoint WinAnsi cannot encode -> what it already looks like.
// tests/core/text-encode.test.mjs re-derives the throwing set from the REAL
// vendored pdf-lib on every run, so this table cannot silently fall behind.
const LOOKALIKES = new Map([
  // Zero-width / formatting marks -- already invisible, so they map to nothing.
  [0x200b, ''],  // ZERO WIDTH SPACE        (pasted from a web page)
  [0x200c, ''],  // ZERO WIDTH NON-JOINER
  [0x200d, ''],  // ZERO WIDTH JOINER
  [0x2060, ''],  // WORD JOINER
  [0xfeff, ''],  // BYTE ORDER MARK         (pasted from a file)
  // Fixed-width and typographic spaces -> an ordinary space.
  [0x2000, ' '], [0x2001, ' '], [0x2002, ' '], [0x2003, ' '], [0x2004, ' '],
  [0x2005, ' '], [0x2006, ' '], [0x2007, ' '], [0x2008, ' '],
  [0x2009, ' '],  // THIN SPACE             (currency formatting out of Word)
  [0x200a, ' '], [0x202f, ' '], [0x205f, ' '], [0x3000, ' '], [0x1680, ' '],
  // Hyphen and minus variants -> the ASCII hyphen they are drawn as.
  [0x2010, '-'],  // HYPHEN
  [0x2011, '-'],  // NON-BREAKING HYPHEN    (Word autoformat)
  [0x2012, '-'],  // FIGURE DASH
  [0x2212, '-'],  // MINUS SIGN             (Word/Excel)
  // Primes -> the quotes they are mistaken for.
  [0x2032, "'"], [0x2033, '"'],
  // Line/paragraph separators -> a plain newline, which the caller splits on.
  [0x2028, '\n'], [0x2029, '\n'],
].map(([cp, to]) => [String.fromCodePoint(cp), to]));

/**
 * Normalise text so a WinAnsi standard font can encode it, WITHOUT changing
 * anything a reader can see. Characters outside the mapping are left alone —
 * including ones that will still throw, deliberately (see the header).
 * @param {string} text
 * @returns {string}
 */
export function toStandardFontSafe(text) {
  const s = String(text ?? '');
  // Fast path: pasted text is usually clean, and this runs per line per
  // annotation — 174 annotations is a real workload.
  let needs = false;
  for (const ch of s) {
    if (LOOKALIKES.has(ch)) { needs = true; break; }
  }
  if (!needs) return s;
  let out = '';
  for (const ch of s) out += LOOKALIKES.has(ch) ? LOOKALIKES.get(ch) : ch;
  return out;
}

// WinAnsi (cp1252) is what pdf-lib's STANDARD fonts can encode. Everything
// else in that font throws at export — which core/export.js cannot survive,
// because its annotation loop has no per-annotation guard.
//
// The set is DERIVED, not remembered: tests/core/text-encode.test.mjs walks
// real codepoints through the real vendored pdf-lib and asserts this predicate
// agrees with it exactly. A remembered table would drift silently and start
// either crying wolf or missing the crash.
const WINANSI_SPECIALS = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
  0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

function encodableInStandardFont(cp) {
  if (cp >= 0x20 && cp <= 0x7e) return true;   // ASCII
  if (cp >= 0xa0 && cp <= 0xff) return true;   // Latin-1 supplement
  if (cp === 0x0a || cp === 0x0d) return true; // newlines: the caller splits on them
  return WINANSI_SPECIALS.has(cp);
}

// The pdf-lib standard families. The clone/custom families embed real font
// files and do NOT throw on an unknown glyph, so they are deliberately not
// warned about here (they paint .notdef, which is a different, quieter defect
// and needs font introspection to detect honestly).
const STANDARD_FAMILIES = new Set(['Helvetica', 'Times-Roman', 'Courier']);

export function isStandardFamily(fontFamily) {
  return STANDARD_FAMILIES.has(fontFamily || 'Helvetica');
}

/**
 * Characters in `text` that a STANDARD font cannot paint, after the lookalike
 * rescue above has done what it can. Returns a de-duplicated array, in the
 * order they appear, so a warning can show the user what to look for.
 *
 * Emoji and CJK land here. They are NOT dropped: deleting something the user
 * can see is worse than telling them about it (founder ruling via PM,
 * 2026-07-29 — warn at commit, keep the export decline as the backstop).
 */
export function unencodableInStandardFont(text) {
  const out = [];
  const seen = new Set();
  for (const ch of toStandardFontSafe(text)) {
    const cp = ch.codePointAt(0);
    if (encodableInStandardFont(cp) || seen.has(ch)) continue;
    seen.add(ch);
    out.push(ch);
  }
  return out;
}
