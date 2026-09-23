/*
 * PDFLokal — core/clone-fonts.js  (shared clone-font catalog)
 * ============================================================================
 * WHY this exists as its own module: core/export.js's FONT_NAME_MAP/
 * CUSTOM_FONT_URLS already list every embeddable font pdf-lib knows how to
 * fetch+embed, including the five Croscore/crosextra clone families
 * (Arimo/Tinos/Cousine — Croscore — plus Carlito/Caladea — crosextra —
 * font-decide.js's CLONE_TABLE targets). Rung 2 of core/stamp.js's font
 * ladder (spec-edit-rebuild-composite.md §3) needs that SAME weight-file ->
 * URL mapping to fetch the identical font file export.js would embed for an
 * authored Arimo/etc. text annotation — but stamp.js can't import export.js
 * directly: export.js -> page-surgery.js -> stamp.js is already a chain, and
 * export.js importing stamp.js's own values back would close it into a
 * cycle. Factored here once, imported by BOTH export.js (which spreads these
 * into its own FONT_NAME_MAP/CUSTOM_FONT_URLS so nothing drifts) and
 * stamp.js — one map, never two copies to fall out of sync.
 */

// family -> { [bold][italic] } -> pdf-lib font name, exactly export.js's
// FONT_NAME_MAP shape, restricted to the five clone families font-decide.js's
// cloneFamilyFor() can return.
export const CLONE_FONT_VARIANTS = {
  Arimo:   { '00': 'Arimo',   '10': 'Arimo-Bold',   '01': 'Arimo-Italic',   '11': 'Arimo-BoldItalic' },
  Tinos:   { '00': 'Tinos',   '10': 'Tinos-Bold',   '01': 'Tinos-Italic',   '11': 'Tinos-BoldItalic' },
  Cousine: { '00': 'Cousine', '10': 'Cousine-Bold', '01': 'Cousine-Italic', '11': 'Cousine-BoldItalic' },
  Carlito: { '00': 'Carlito', '10': 'Carlito-Bold', '01': 'Carlito-Italic', '11': 'Carlito-BoldItalic' },
  Caladea: { '00': 'Caladea', '10': 'Caladea-Bold', '01': 'Caladea-Italic', '11': 'Caladea-BoldItalic' },
};

// pdf-lib font name -> self-hosted TrueType path (fonts/ttf/, decoded once
// from the fonts/*.woff2 the page's @font-face uses — pdf-lib embeds bytes
// verbatim and a PDF cannot carry WOFF2; see isSfntFontProgram), exactly export.js's
// CUSTOM_FONT_URLS shape, same restriction.
export const CLONE_FONT_URLS = {
  Arimo: 'fonts/ttf/arimo-regular.ttf',
  'Arimo-Bold': 'fonts/ttf/arimo-bold.ttf',
  'Arimo-Italic': 'fonts/ttf/arimo-italic.ttf',
  'Arimo-BoldItalic': 'fonts/ttf/arimo-bolditalic.ttf',
  Tinos: 'fonts/ttf/tinos-regular.ttf',
  'Tinos-Bold': 'fonts/ttf/tinos-bold.ttf',
  'Tinos-Italic': 'fonts/ttf/tinos-italic.ttf',
  'Tinos-BoldItalic': 'fonts/ttf/tinos-bolditalic.ttf',
  Cousine: 'fonts/ttf/cousine-regular.ttf',
  'Cousine-Bold': 'fonts/ttf/cousine-bold.ttf',
  'Cousine-Italic': 'fonts/ttf/cousine-italic.ttf',
  'Cousine-BoldItalic': 'fonts/ttf/cousine-bolditalic.ttf',
  Carlito: 'fonts/ttf/carlito-regular.ttf',
  'Carlito-Bold': 'fonts/ttf/carlito-bold.ttf',
  'Carlito-Italic': 'fonts/ttf/carlito-italic.ttf',
  'Carlito-BoldItalic': 'fonts/ttf/carlito-bolditalic.ttf',
  Caladea: 'fonts/ttf/caladea-regular.ttf',
  'Caladea-Bold': 'fonts/ttf/caladea-bold.ttf',
  'Caladea-Italic': 'fonts/ttf/caladea-italic.ttf',
  'Caladea-BoldItalic': 'fonts/ttf/caladea-bolditalic.ttf',
};

// True when `bytes` open with an sfnt tag — the only container a PDF's
// /FontFile2 (or /FontFile3 OpenType) can hold. pdf-lib's embedFont writes
// the bytes it is given VERBATIM, so a .woff2 handed to it ships as an
// invalid font program: every glyph a dot in Chrome/Preview/Acrobat, while
// pdf.js substitutes by name and hides it (tests/core/export-font-program).
export function isSfntFontProgram(bytes) {
  if (!bytes || bytes.length < 4) return false;
  const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  return tag === '\x00\x01\x00\x00' || tag === 'true' || tag === 'OTTO';
}
