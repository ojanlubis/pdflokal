/*
 * PDFLokal — core/font-fingerprint.js  (RUNG 2 — read the embedded PROGRAM's
 * own truth, spec-edit-fidelity-instrumentation.md Increment A)
 * ============================================================================
 * WHY this module exists: the founder's org-structure.pdf field test (phone
 * gate on 83631c8, decisions.md 2026-07-23) found `"T & PPGA"` (bold, all-caps)
 * baking THIN after a Ganti Teks replace. Root cause verified against the
 * file's own bytes: `/BaseFont = CIDFont+F1`, `Flags = 6`, no `/FontWeight` —
 * the PDF WRAPPER (core/font-style.js's rung 1) genuinely has nothing to say.
 * But the EMBEDDED PROGRAM underneath that uninformative wrapper name is
 * "Arial-BoldMT" — self-identifying as bold FOUR redundant ways (name-table
 * subfamily "Bold", OS/2.usWeightClass 700, OS/2.fsSelection.bold, PANOSE
 * weight byte 7). Verified empirically (this builder's Step 0 dump, kept in
 * the PR notes) before writing a line of this ladder rung — READ the
 * artifact, don't guess at it.
 *
 * Same vendor-injection discipline as every core/ sibling: fontkit is passed
 * in by the caller (already-registered on the pdf-lib doc, or handed in
 * directly for the PURE fingerprintProgram/fingerprintProgramBytes below) —
 * this file has zero top-level vendor imports of its own.
 *
 * Rung 2's OWN internal ladder (first confident answer wins, spec's own
 * stated preference order: name-table words, then OS/2, then PANOSE):
 *   1. 'program-name' — the program's OWN name table (postscriptName /
 *      subfamilyName / fullName) parsed with the SAME PostScript-convention
 *      regex font-style.js's rung 1 already uses on the PDF wrapper's name —
 *      just aimed at the artifact's own name instead of the generator's
 *      label for it.
 *   2. 'os2' — OS/2.usWeightClass >= 600 -> bold; OS/2.fsSelection's own
 *      bold/italic bits (a real struct fontkit already decodes, not a raw
 *      bitmask this file has to mask itself).
 *   3. 'panose' — byte 1 (familyType) must be 2 (Latin Text) for byte 2/3 to
 *      mean what the spec assumes; byte 2 (serifStyle) buckets serif/sans,
 *      byte 3 (weight) >= 7 -> bold (spec's own threshold).
 * `mono` and a `post`-table italic corroboration ride ALONGSIDE whichever
 * rung answers bold — `post.isFixedPitch`/`post.italicAngle` are direct
 * fields the font ships (not a measurement), so they're read every time,
 * never gated behind which style rung fired.
 *
 * Rung 3 (geometry — stem-width/outline measurement) is DELIBERATELY NOT
 * built here. Step 0's empirical dump proved rung 2 answers the founder's own
 * defect FOUR redundant ways with zero ambiguity; shipping an outline-scanning
 * weight/serif heuristic with no real defect it would additionally fix and no
 * fixture corpus to validate it against would be exactly the "coin-flip
 * measurement" the honesty contract forbids shipping. If a future case proves
 * rung 2 insufficient, that is its own fork conversation (decisions.md
 * 2026-07-23's own tripwire), not a corner cut here.
 */

import { parseStyleFromName, getFontStyleInfo, isInformativeBaseFont } from './font-style.js';
import { extractFontProgram } from './doc-fonts.js';

// PANOSE Latin Text (familyType===2) serif-style byte (index 1, i.e. the
// PANOSE spec's own "byte 2"): 2-10 are genuine serif terminal styles
// (Cove/Obtuse Cove/Square Cove/Obtuse Square Cove/Square/Thin/Bone/
// Exaggerated/Triangle); 11-15 are ALL sans variants (Normal Sans/Obtuse
// Sans/Perp Sans/Flared/Rounded — "Flared"/"Rounded" describe a SANS
// stroke's terminal treatment, not a serif). Verified against this repo's
// own bundled Carlito (panose serifStyle=15 "Rounded" — a real sans font,
// metric-twin for Calibri) to make sure this bucket boundary is right, not
// assumed from the spec prose alone. 0/1 ("Any"/"No Fit") mean the foundry
// declined to say — this module declines right along with it rather than
// guessing a bucket. familyType values other than 2 (Latin Hand Written,
// Decorative, Symbol, …) reuse these SAME byte positions for unrelated
// concepts — reading them as serif/sans would be a misread, not a
// measurement, so those decline too.
const SERIF_STYLE_BYTES = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10]);
const SANS_STYLE_BYTES = new Set([11, 12, 13, 14, 15]);
const PANOSE_BOLD_THRESHOLD = 7; // spec's own stated threshold (byte 3, weight)
const OS2_BOLD_WEIGHT = 600; // spec's own stated threshold (usWeightClass)

function familyFromPanose(panose) {
  if (!panose || panose.length < 2 || panose[0] !== 2) return null;
  const serifStyle = panose[1];
  if (SERIF_STYLE_BYTES.has(serifStyle)) return 'serif';
  if (SANS_STYLE_BYTES.has(serifStyle)) return 'sans';
  return null;
}

function weightFromPanose(panose) {
  if (!panose || panose.length < 3 || panose[0] !== 2) return null;
  const w = panose[2];
  if (w === 0 || w === 1) return null; // 'Any' / 'No Fit' — declined, not guessed
  return w >= PANOSE_BOLD_THRESHOLD;
}

// Pure — takes an ALREADY-PARSED fontkit font object (fontkit.create's
// return value), never touches PDFLib/the page. Returns
// { ok, bold, italic, mono, family, styleSource, programName } or
// { ok:false } on a font with nothing at all to say (no name, no OS/2, no
// PANOSE, not fixed-pitch, zero italic angle) — genuinely never happens for
// a real sfnt in practice, but the decline-never-guess discipline stays even
// here.
export function fingerprintProgram(font) {
  if (!font) return { ok: false };

  const post = font.post || null;
  const mono = !!(post && post.isFixedPitch);
  const italicFromPost = !!(post && typeof post.italicAngle === 'number' && post.italicAngle !== 0);

  const os2 = font['OS/2'] || null;
  const panoseFamily = familyFromPanose(os2 && os2.panose);
  const family = mono ? 'mono' : panoseFamily;
  const programName = font.postscriptName || font.familyName || '';

  // Rung 2a: the program's own name table — same convention font-style.js's
  // parseStyleFromName already parses, aimed at postscriptName/subfamilyName/
  // fullName instead of the PDF wrapper's /BaseFont.
  const nameParts = [font.postscriptName, font.subfamilyName, font.fullName].filter(Boolean).join(' ');
  const fromName = parseStyleFromName(nameParts);
  if (fromName.bold || fromName.italic) {
    return {
      ok: true, bold: fromName.bold, italic: fromName.italic || italicFromPost,
      mono, family, styleSource: 'program-name', programName,
    };
  }

  // Rung 2b: OS/2 — usWeightClass and fsSelection are metrics DESIGNED for
  // exactly this substitution decision (fsSelection is already a decoded
  // struct with .bold/.italic booleans, not a bitmask this file re-masks).
  if (os2 && (Number.isFinite(os2.usWeightClass) || os2.fsSelection)) {
    const bold = (Number.isFinite(os2.usWeightClass) && os2.usWeightClass >= OS2_BOLD_WEIGHT)
      || !!(os2.fsSelection && os2.fsSelection.bold);
    const italic = !!(os2.fsSelection && os2.fsSelection.italic)
      || !!(font.head && font.head.macStyle && font.head.macStyle.italic)
      || italicFromPost;
    return { ok: true, bold, italic, mono, family, styleSource: 'os2', programName };
  }

  // Rung 2c: PANOSE weight byte alone (OS/2 present but silent on both
  // usWeightClass and fsSelection — rare, but PANOSE is its own table).
  const panoseWeight = weightFromPanose(os2 && os2.panose);
  if (panoseWeight !== null || panoseFamily) {
    return {
      ok: true, bold: !!panoseWeight, italic: italicFromPost, mono,
      family, styleSource: 'panose', programName,
    };
  }

  // Nothing style-wise fired, but the 'post' table itself is a direct field
  // (not a measurement) — still worth reporting alone.
  if (mono || italicFromPost) {
    return { ok: true, bold: false, italic: italicFromPost, mono, family, styleSource: 'os2', programName };
  }

  return { ok: false };
}

// bytes -> fontkit.create -> fingerprintProgram. Never throws (a malformed/
// unparseable program is a genuine decline, same discipline as every other
// core/ reader touching font bytes).
export function fingerprintProgramBytes(fontkit, bytes) {
  if (!fontkit) return { ok: false };
  try {
    return fingerprintProgram(fontkit.create(bytes));
  } catch {
    return { ok: false };
  }
}

// The measured-family -> clone-family bucket (spec Increment A's "twin
// selection" bullet): used ONLY when font-decide.js's exact-name routing
// (cloneFamilyFor) has already declined on BOTH the wrapper's /BaseFont and
// the program's own name — a bucket is a weaker signal than an exact match,
// so it is deliberately the LAST resort, never tried first.
export const FAMILY_BUCKET_TO_CLONE = { serif: 'Tinos', mono: 'Cousine', sans: 'Arimo' };

// The FULL ladder for one page-Resources font: rung 1 (font-style.js's
// getFontStyleInfo, the PDF wrapper) first, rung 2 (this module, the
// embedded program) only when rung 1 genuinely has nothing to say
// (styleSource 'none' — an uninformative name AND no Flags/FontWeight
// corroboration). Returns a single unified shape every caller (js/v2/app.js's
// prepareDocFont, telemetry) can read without knowing which rung fired.
// Never throws — every internal step is already decline-typed, and this
// orchestrator adds one more try/catch belt for the fontkit parse.
export function resolveFontFingerprint(page, PDFLib, fontkit, fontName) {
  const info = getFontStyleInfo(page, PDFLib, fontName);
  const base = {
    ok: false, bold: false, italic: false, mono: false, family: null,
    styleSource: 'none', embedded: false, subtype: 'other', baseFont: '', programName: '',
  };
  if (!info.ok) return base;

  if (info.styleSource !== 'none') {
    return {
      ok: true, bold: info.bold, italic: info.italic, mono: false, family: null,
      styleSource: info.styleSource, embedded: info.embedded, subtype: info.subtype,
      baseFont: info.baseFont, programName: '',
    };
  }

  // Rung 1 declined (uninformative /BaseFont, no Flags/FontWeight signal) —
  // try the embedded program itself, when there's a program AND fontkit to
  // read it with.
  if (fontkit) {
    try {
      const extracted = extractFontProgram(page, PDFLib, fontName);
      if (extracted.ok) {
        const fp = fingerprintProgramBytes(fontkit, extracted.bytes);
        if (fp.ok) {
          return {
            ok: true, bold: fp.bold, italic: fp.italic, mono: fp.mono, family: fp.family,
            styleSource: fp.styleSource, embedded: info.embedded, subtype: info.subtype,
            baseFont: info.baseFont, programName: fp.programName,
          };
        }
      }
    } catch { /* decline, never throw — rung 2 simply didn't pan out */ }
  }

  return {
    ok: true, bold: false, italic: false, mono: false, family: null, styleSource: 'none',
    embedded: info.embedded, subtype: info.subtype, baseFont: info.baseFont, programName: '',
  };
}

// Re-exported purely so callers that only need the informativeness test
// don't have to import font-style.js separately for it.
export { isInformativeBaseFont };
