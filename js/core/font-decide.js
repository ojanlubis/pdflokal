/*
 * PDFLokal — core/font-decide.js  (FONT-FIDELITY tier 1 — exact-clone routing)
 * ============================================================================
 * WHY this module exists (spec-font-fidelity-engine.md §2/§3, founder-ratified
 * 2026-07-20): when a Ganti Teks replacement can't be written with the
 * document's OWN font, the substitute picker today is v2/text-runs.js's
 * mapRunFont — a generic bucket fed by pdf.js's collapsed 'serif/sans-serif/
 * monospace', because pdf.js never surfaces the real font name. But the PDF's
 * own /BaseFont (already read by core/font-style.js for bold/italic) DOES name
 * the real font — and for the fonts Indonesian documents actually use (Word's
 * kit), metric-IDENTICAL open clones exist. Routing on /BaseFont turns "a
 * look-alike bucket guess" into "the same widths by construction": layout
 * provably cannot shift.
 *
 * This module is deliberately DUMB: one normalization + one lookup, pure
 * string-in/string-out, no vendor deps, no DOM — so both call sites (the
 * editor's draft styling in v2/app.js and any future export-side consumer)
 * cannot disagree. The decline value is null, and the caller's fallback is
 * exactly yesterday's behavior (mapRunFont) — same decline-never-guess shape
 * as every reader in core/.
 *
 * HONESTY (founder-ratified 2026-07-20): a clone is still a SUBSTITUTE — the
 * commit toast keeps firing with today's copy, one grammar for every
 * substitute tier. Only `native`/`composed` (the document's own outlines) are
 * silent. Do not add per-tier toast wording — that precision was explicitly
 * declined; it belongs in telemetry when the rail lands.
 */

// The metric-clone table — EXACT matches against a normalized /BaseFont (see
// normalizeBaseFont below); values are families wired through core/export.js's
// FONT_NAME_MAP + index.html's @font-face set. Croscore (Arimo/Tinos/Cousine)
// and crosextra (Carlito/Caladea) are built metric-compatible with their
// targets — same advance widths per glyph, so a replacement line occupies
// exactly the space the original did.
//
// WHY exact match, never prefix: 'ArialNarrow' and 'CambriaMath' would
// prefix-match 'arial'/'cambria' — and their metrics are genuinely DIFFERENT
// (condensed / math spacing). Routing them would shift layout, falsifying the
// one guarantee this tier exists to make. A name outside this set declines to
// null and the caller keeps yesterday's twin behavior — decline, never guess.
//
// 'helvetica'/'times'/'courier' route to the clones too: same widths as the
// standard-14 metrics pdf-lib uses today, but with real embedded outlines
// instead of viewer-substituted rendering.
const CLONE_TABLE = new Map([
  ['arial', 'Arimo'],
  ['helvetica', 'Arimo'],
  ['liberationsans', 'Arimo'],
  ['arimo', 'Arimo'],
  ['timesnewroman', 'Tinos'],
  ['times', 'Tinos'],
  ['timesroman', 'Tinos'], // 'Times-Roman': 'Roman' is a style word, but stripping it would mangle 'timesnewROMAN' — alias instead
  ['liberationserif', 'Tinos'],
  ['tinos', 'Tinos'],
  ['couriernew', 'Cousine'],
  ['courier', 'Cousine'],
  ['liberationmono', 'Cousine'],
  ['cousine', 'Cousine'],
  ['calibri', 'Carlito'],
  ['carlito', 'Carlito'],
  ['cambria', 'Caladea'],
  ['caladea', 'Caladea'],
]);

// A /BaseFont name arrives as PostScript convention: optional 6-letter subset
// prefix ('ABCDEF+'), CamelCase or hyphenated family, style suffixes
// ('-BoldMT', 'PS-BoldItalicMT', ',Bold'). Style is NOT this module's job —
// core/font-style.js already parses bold/italic separately, and the clone's
// weight file is picked by the existing resolveFontName variant logic. Here
// the whole name is case-folded and stripped of non-letters, then ONLY the
// four style words our weight files actually cover (plus Monotype/PostScript
// suffix noise) are cut. Width-changing variant words ('Narrow', 'Light',
// 'Condensed', 'Math') are deliberately NOT stripped — they must break the
// exact match and decline, because no file we ship carries those metrics.
export function normalizeBaseFont(baseFont) {
  let s = String(baseFont || '');
  const plus = s.indexOf('+');
  // exactly the 6-uppercase-letter subset tag, nothing else, gets stripped —
  // a '+' elsewhere is part of a (weird but legal) name
  if (plus === 6 && /^[A-Z]{6}$/.test(s.slice(0, 6))) s = s.slice(7);
  s = s.toLowerCase().replace(/[^a-z]/g, '');
  // longest-first so 'bolditalic' goes before 'bold'; 'psmt'/'ps'/'mt' are
  // the Monotype/PostScript tails on exactly the families this table serves
  // (ArialMT, TimesNewRomanPSMT, CourierNewPS-BoldMT).
  for (const tok of ['bolditalic', 'italic', 'oblique', 'bold', 'regular', 'psmt', 'ps', 'mt']) {
    s = s.replaceAll(tok, '');
  }
  return s;
}

// The tier-1 decision: normalized /BaseFont → clone family, or null (caller
// falls back to mapRunFont — yesterday's behavior, unchanged).
export function cloneFamilyFor(baseFont) {
  return CLONE_TABLE.get(normalizeBaseFont(baseFont)) || null;
}
