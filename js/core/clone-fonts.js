/*
 * PDFLokal — core/clone-fonts.js  (shared clone-font catalog)
 * ============================================================================
 * WHY this exists as its own module: core/export.js's FONT_NAME_MAP/
 * CUSTOM_FONT_URLS already list every embeddable font pdf-lib knows how to
 * fetch+embed, including the five Croscore/crosextra clone families
 * (Arimo/Tinos/Cousine — Croscore — plus Carlito/Caladea — crosextra —
 * font-decide.js's CLONE_TABLE targets). Rung 2 of core/stamp.js's font
 * ladder (spec-edit-rebuild-composite.md §3) needs that SAME weight-file ->
 * URL mapping to fetch the identical woff2 export.js would embed for an
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

// pdf-lib font name -> self-hosted woff2 path, exactly export.js's
// CUSTOM_FONT_URLS shape, same restriction.
export const CLONE_FONT_URLS = {
  Arimo: 'fonts/arimo-regular.woff2',
  'Arimo-Bold': 'fonts/arimo-bold.woff2',
  'Arimo-Italic': 'fonts/arimo-italic.woff2',
  'Arimo-BoldItalic': 'fonts/arimo-bolditalic.woff2',
  Tinos: 'fonts/tinos-regular.woff2',
  'Tinos-Bold': 'fonts/tinos-bold.woff2',
  'Tinos-Italic': 'fonts/tinos-italic.woff2',
  'Tinos-BoldItalic': 'fonts/tinos-bolditalic.woff2',
  Cousine: 'fonts/cousine-regular.woff2',
  'Cousine-Bold': 'fonts/cousine-bold.woff2',
  'Cousine-Italic': 'fonts/cousine-italic.woff2',
  'Cousine-BoldItalic': 'fonts/cousine-bolditalic.woff2',
  Carlito: 'fonts/carlito-regular.woff2',
  'Carlito-Bold': 'fonts/carlito-bold.woff2',
  'Carlito-Italic': 'fonts/carlito-italic.woff2',
  'Carlito-BoldItalic': 'fonts/carlito-bolditalic.woff2',
  Caladea: 'fonts/caladea-regular.woff2',
  'Caladea-Bold': 'fonts/caladea-bold.woff2',
  'Caladea-Italic': 'fonts/caladea-italic.woff2',
  'Caladea-BoldItalic': 'fonts/caladea-bolditalic.woff2',
};
