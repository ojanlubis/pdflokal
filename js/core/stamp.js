/*
 * PDFLokal — core/stamp.js  (THE WRITE PATH — pdf-lib resolves + embeds + lays out)
 * ============================================================================
 * spec-edit-rebuild-composite.md (founder-ruled Path B, 2026-07-22): we stop
 * hand-writing glyph operations into a foreign generator's content stream
 * (core/reinsert.js's whole approach). Instead: pdf-lib itself lays out,
 * encodes, and embeds the replacement text — one system controls both sides
 * of encode/decode, so the entire write-side bug class (subset cmaps,
 * hand-rolled TJ advances, in-stream CTM, byte-encoding) is DELETED, not
 * fixed. This module is the font-RESOLVE ladder feeding that single
 * `pdfPage.drawText()` call.
 *
 * Same vendor-injection discipline as every core/ sibling: PDFLib and fontkit
 * are passed in by the caller — this file has zero vendor imports.
 *
 * The ladder (first rung that PROVES itself wins; every decline is typed,
 * same honesty contract as reinsert.js — never guess a substitute font):
 *   1. doc-subset ('native') — the doc's OWN embedded font program, proven to
 *      cover every character (incl. a real space glyph) before pdf-lib is
 *      asked to embed it. Near-pixel-perfect: the document's own outlines.
 *   2. clone ('clone') — font-decide.js's /BaseFont routing to the bundled
 *      Croscore/crosextra metric-twin family. Same widths by construction;
 *      outlines near-identical, not pixel-identical (honest cost, spec §6).
 *   3. (no rung 3 here) — a typed decline from THIS module means the caller
 *      (page-surgery.js) leaves the edit to today's twin drawer. Zero new
 *      code for that tier — it already exists.
 *
 * Reason vocabulary is telemetry-schema.js's `insert.reason` enum, reused
 * verbatim wherever an existing value fits (decline-never-guess extends to
 * "don't invent a new enum value when an old one already means this").
 */

import { extractFontProgram, lookupFontObject } from './doc-fonts.js';
import { drawTextSafe } from './text-encode.js';
import { getFontStyleInfo } from './font-style.js';
import { cloneFamilyFor } from './font-decide.js';
import { CLONE_FONT_VARIANTS, CLONE_FONT_URLS } from './clone-fonts.js';
import { fingerprintProgram, FAMILY_BUCKET_TO_CLONE } from './font-fingerprint.js';

// ---- shared little helpers ---------------------------------------------------

// Same hex->0..1 conversion reinsert.js used to have — ported, not imported:
// reinsert.js retired whole in increment 2 (spec §1's DIES list), so this
// survivor keeps its own tiny copy rather than a link to a file that's gone.
export function hexToRgb01(hex) {
  const h = (hex || '#000000').replace('#', '');
  return [
    Number.parseInt(h.slice(0, 2), 16) / 255,
    Number.parseInt(h.slice(2, 4), 16) / 255,
    Number.parseInt(h.slice(4, 6), 16) / 255,
  ];
}

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
// it used to sit one line above it, and fontkit parses LAZILY — a wild font
// whose tables only fault when a cmap is first consulted threw
// `undefined is not an object (evaluating 'e.tables')` from INSIDE this call,
// straight past a catch that only ever covered the two lines below. It
// surfaced on app.js's commit-time notice prediction, which is not armored,
// so commit() died and the user's replacement silently never applied.
// Declining (false) is the correct answer to a fault, not a rethrow: it makes
// rung 1 fall through to clone/twin, and a font we cannot interrogate is by
// definition one we cannot PROVE is right.
function glyphPaints(font, cp) {
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
// EXPORTED (spec-edit-rebuild-composite.md increment 2): js/v2/app.js's
// draft-time notice prediction needs the EXACT same answer this module's own
// rung 1 (tryNativeSubset) uses at commit time — the toast may not lie about
// what export will do, so the two call sites share this ONE implementation
// rather than each hand-rolling their own coverage loop that could drift
// apart. Same NFC normalize (a user typing e + combining-acute means é —
// judge coverage on the composed form, one char at a time) and the same
// space carve-out glyphPaints already gives (cp 32 is exempt from the
// contour check, but still gated on the font actually having a cmap entry
// for it).
export function textCoveredBy(parsedFont, text) {
  for (const ch of text.normalize('NFC')) {
    if (!glyphPaints(parsedFont, ch.codePointAt(0))) return false;
  }
  return true;
}

// spec-edit-fidelity-instrumentation.md Increment B: the `insert` telemetry
// event's glyph-shortfall count — "how many chars did the doc's OWN subset
// lack" (the "why did rung 1 decline" signal). Same NFC-normalize + coverage
// test as textCoveredBy, just counting instead of short-circuiting on the
// first miss — deliberately a SEPARATE pass (not a byproduct of
// textCoveredBy) so the common case (fully covered, the overwhelming
// majority of edits) never pays for a count it doesn't need.
export function countMissingGlyphs(parsedFont, text) {
  let n = 0;
  for (const ch of text.normalize('NFC')) {
    if (!glyphPaints(parsedFont, ch.codePointAt(0))) n += 1;
  }
  return n;
}

// ---- per-document embed cache -------------------------------------------------

// WeakMap<pdfLibDoc, Map<key, entry>> — "one embed per (font, doc) cached
// across edits" (spec §2). Keyed off the pdf-lib DOCUMENT object (pdfPage.doc)
// so multiple edits committed in the same export (buildPdfBytes' one shared
// newDoc across every source page) or the same live-surgery commit
// (buildEditedPageBytes' one newDoc per call, still shared across that page's
// own multiple Ganti pairs) never re-embed the same bytes twice.
//
// Native entries are keyed by the resolved font DICT object itself (a stable
// reference per actual font program on a given page — two different pages
// sharing the same newDoc can each use resource name "/F1" for entirely
// different fonts, so the fontName STRING alone would be an unsafe key; the
// dict object is not). Clone entries are keyed by a `clone:<pdf-lib-name>`
// STRING instead — deliberately the opposite shape, so the two families of
// key can never collide in the same Map (object identity vs string
// equality are never SameValueZero-equal to one another).
const docFontCaches = new WeakMap();
function getDocCache(pdfLibDoc) {
  let cache = docFontCaches.get(pdfLibDoc);
  if (!cache) {
    cache = new Map();
    docFontCaches.set(pdfLibDoc, cache);
  }
  return cache;
}

// ---- shared: parse-or-reuse a page font program, cached per-doc ------------

// Get {fontObj, entry:{parsed, bytes, embedded}} for `fontName`, reusing the
// SAME per-doc cache entry keyed by the font dict object (see docFontCaches'
// own docstring below) — whichever rung asks FIRST parses it, every later
// rung (including the style-fingerprint resolve in tryClone below) reuses
// the same parsed fontkit object, never re-decoding the bytes twice.
// { ok:false, reason } on any decline (missing program, malformed bytes) —
// never throws (mirrors extractFontProgram/getFontStyleInfo's own contract).
function getOrParseFont(pdfPage, PDFLib, fontkit, fontName, cache) {
  const fontObj = lookupFontObject(pdfPage, PDFLib, fontName);
  if (!fontObj) return { ok: false, reason: 'unsupported-font' };
  let entry = cache.get(fontObj);
  if (!entry) {
    const extracted = extractFontProgram(pdfPage, PDFLib, fontName);
    if (!extracted.ok) return extracted; // { ok:false, reason } verbatim
    try {
      entry = { parsed: fontkit.create(extracted.bytes), bytes: extracted.bytes, embedded: null };
    } catch {
      // A malformed subset fontkit refuses to parse — a genuine decline,
      // never a guess (spec §3 rung 1).
      return { ok: false, reason: 'unsupported-font' };
    }
    cache.set(fontObj, entry);
  }
  return { ok: true, fontObj, entry };
}

// ---- rung 1: doc-subset -------------------------------------------------------

async function tryNativeSubset(pdfPage, PDFLib, fontkit, insert, text, cache) {
  if (!fontkit) return { ok: false, reason: 'unsupported-font' };
  const got = getOrParseFont(pdfPage, PDFLib, fontkit, insert.fontName, cache);
  if (!got.ok) return got;
  const { entry } = got;

  try {
    if (!textCoveredBy(entry.parsed, text)) {
      return { ok: false, reason: 'missing-glyph', glyphShortfall: countMissingGlyphs(entry.parsed, text) };
    }

    if (!entry.embedded) {
      // WHY here, not at buildEditedPageBytes/buildPdfBytes call sites only:
      // registerFontkit is idempotent to call twice, but this is the ONE spot
      // that actually NEEDS it (embedFont on raw bytes) — the caller-side
      // registration (export.js's buildPdfBytes, page-surgery.js's
      // buildEditedPageBytes) is the doc-level precondition this assumes.
      entry.embedded = await pdfPage.doc.embedFont(entry.bytes);
    }
    return { ok: true, font: entry.embedded };
  } catch {
    // Any pdf-lib embed throw on a malformed subset — a genuine decline,
    // never a guess (spec §3 rung 1).
    return { ok: false, reason: 'unsupported-font' };
  }
}

// ---- rung 2: clone -------------------------------------------------------------

const FONT_FETCH_TIMEOUT_MS = 10000; // same guard as export.js's embedCustomFont

async function fetchCloneFontBytes(fontName) {
  const url = CLONE_FONT_URLS[fontName];
  if (!url) throw new Error(`stamp.js: no clone font URL for ${fontName}`);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FONT_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.arrayBuffer();
  } finally {
    clearTimeout(timeoutId);
  }
}

// AUTHORITATIVE bold/italic/family-source resolution — CORRECTNESS, not a
// telemetry nicety (founder-flagged 2026-07-26, spec-edit-fidelity-
// instrumentation.md). js/v2/app.js's prepareDocFont computes this SAME
// style/family ladder (core/font-fingerprint.js) asynchronously and
// UNAWAITED at draft-open time — a slow device or a fast typist can commit
// before it resolves, leaving the annotation's own bold/italic at the format
// bar's plain defaults (false), NOT the document's own truth. Trusting that
// blindly in the clone rung would pick the WRONG weight file — Arimo-Regular
// instead of Arimo-Bold — baking the founder's exact "T & PPGA" defect right
// back, just moved one layer down from where it was originally diagnosed.
// So: when the caller's own style already carries a RESOLVED styleSource (a
// real ladder rung fired before commit, not the race-lost/nothing-found
// 'none'), trust it as a fast path — it already IS this same ladder's
// verdict, no re-parse needed. Otherwise resolve fresh, right here, against
// the real document — rung 1 first (getFontStyleInfo, free, no parsing),
// rung 2 (the embedded program's own fingerprint) only when THAT is also
// uninformative, reusing the per-doc `cache` (getOrParseFont) so this never
// re-parses a program another rung (rung 1's own native-subset attempt)
// already read. Called ONCE per resolveStampFont call, used for BOTH the
// clone rung's weight-file pick AND the telemetry on every path (native
// included) — the document is the one authority; the draft's prediction is
// only ever a hint it can be wrong about, and that must hold everywhere this
// value is reported, not just where it changes what gets embedded.
function resolveAuthoritativeStyle(pdfPage, PDFLib, fontkit, fontName, style, cache) {
  const hintSource = style?.styleSource || 'none';
  if (hintSource !== 'none') return { bold: !!style.bold, italic: !!style.italic, styleSource: hintSource };

  const info = getFontStyleInfo(pdfPage, PDFLib, fontName);
  if (info.ok && info.styleSource !== 'none') {
    return { bold: info.bold, italic: info.italic, styleSource: info.styleSource };
  }

  if (fontkit) {
    const got = getOrParseFont(pdfPage, PDFLib, fontkit, fontName, cache);
    if (got.ok) {
      const fp = fingerprintProgram(got.entry.parsed);
      if (fp.ok) return { bold: fp.bold, italic: fp.italic, styleSource: fp.styleSource };
    }
  }

  // Nothing resolved anywhere — honest 'none', same shape as every other
  // decline-never-guess reader in this module.
  return { bold: !!style?.bold, italic: !!style?.italic, styleSource: 'none' };
}

async function tryClone(pdfPage, PDFLib, fontkit, insert, text, resolvedStyle, cache) {
  // Headless-node guard: no fontkit (embedFont needs it for anything but
  // pdf-lib's own standard-14) or no fetch (can't reach the self-hosted
  // woff2) both mean this rung simply cannot run here.
  if (!fontkit || typeof fetch !== 'function') return { ok: false, reason: 'clone-unavailable' };

  const info = getFontStyleInfo(pdfPage, PDFLib, insert.fontName);
  if (!info.ok) return { ok: false, reason: 'unsupported-font' };

  let family = cloneFamilyFor(info.baseFont);
  // spec-edit-fidelity-instrumentation.md Increment A ("twin selection"): the
  // PDF WRAPPER's /BaseFont declined to route (an uninformative generator
  // name — org-structure.pdf's own 'CIDFont+F1'/'CIDFont+F2'). Before falling
  // to a measured bucket, try the EMBEDDED PROGRAM's own name through the
  // SAME exact-match table — the program's postscriptName ('Arial-BoldMT')
  // is frequently the foundry's real name even when the PDF generator's
  // wrapper name is a bare subset tag, and an exact match is a strictly
  // stronger signal than a serif/sans/mono bucket. Only when THAT also
  // declines does the measured family bucket (serif->Tinos, mono->Cousine,
  // sans->Arimo) fire — a bucket beats nothing, but never beats a name.
  if (!family) {
    const got = getOrParseFont(pdfPage, PDFLib, fontkit, insert.fontName, cache);
    if (got.ok) {
      const fp = fingerprintProgram(got.entry.parsed);
      if (fp.ok) family = cloneFamilyFor(fp.programName) || FAMILY_BUCKET_TO_CLONE[fp.family] || null;
    }
  }
  if (!family) return { ok: false, reason: 'clone-unavailable' };

  // resolvedStyle is ALREADY the authoritative bold/italic (resolveStampFont
  // computed it once, via resolveAuthoritativeStyle, before either rung ran)
  // — this rung only picks the weight FILE from it, never re-derives style.
  const variant = `${resolvedStyle.bold ? '1' : '0'}${resolvedStyle.italic ? '1' : '0'}`;
  const fontName = CLONE_FONT_VARIANTS[family]?.[variant];
  if (!fontName) return { ok: false, reason: 'clone-unavailable' };

  const key = `clone:${fontName}`;
  try {
    let entry = cache.get(key);
    if (!entry) {
      const bytes = await fetchCloneFontBytes(fontName);
      // WHY parse here (not just embed): the metric-twin routing table is
      // BaseFont-name-only — it says nothing about whether THIS clone's
      // program actually carries a glyph for every char in `text`. Verified
      // empirically: pdf-lib's drawText does NOT throw for an uncovered
      // codepoint against a custom embedded font — it silently paints
      // .notdef, i.e. the exact invisible-bake bug class this whole rebuild
      // exists to delete (module header). A clone is honest ONLY when it
      // actually covers the text, same discipline as rung 1.
      entry = { bytes, parsed: fontkit.create(bytes), embedded: null };
      cache.set(key, entry);
    }

    if (!textCoveredBy(entry.parsed, text)) return { ok: false, reason: 'missing-glyph' };

    if (!entry.embedded) entry.embedded = await pdfPage.doc.embedFont(entry.bytes);
    return { ok: true, font: entry.embedded };
  } catch {
    return { ok: false, reason: 'clone-unavailable' };
  }
}

// ---- the ladder ---------------------------------------------------------------

// req shape: insert (text-walk.js's per-target insert block, incl.
// mixedFonts), text (the FINAL typed replacement), style ({bold, italic,
// styleSource} — the replacement annotation's OWN draft-time HINT, not
// necessarily authoritative: resolveAuthoritativeStyle re-derives it against
// the real document whenever styleSource is absent/'none', so a lost
// draft-time race (js/v2/app.js's prepareDocFont, unawaited) can never pick
// the wrong clone weight file).
// Returns { ok:true, font, path:'native'|'clone' } or { ok:false, reason } —
// never throws (every internal failure is caught and typed above).
export async function resolveStampFont(pdfPage, PDFLib, fontkit, insert, text, style) {
  // Structural guards FIRST, exactly reinsert.js's own order, and BEFORE any
  // font work at all (incl. the authoritative style resolve below) — a
  // single pdfPage.drawText() call paints ONE baseline in ONE font for the
  // WHOLE string regardless of which rung supplies that font, so these
  // declines never even need to know what the font is.
  const styleSourceHint = style?.styleSource || 'none';
  if (insert.mixedFonts) return { ok: false, reason: 'mixed-fonts', styleSource: styleSourceHint, glyphShortfall: 0 };
  if (text.includes('\n')) return { ok: false, reason: 'multiline', styleSource: styleSourceHint, glyphShortfall: 0 };
  if (text.length === 0) return { ok: false, reason: 'empty', styleSource: styleSourceHint, glyphShortfall: 0 };

  const cache = getDocCache(pdfPage.doc);

  // style_source (spec-edit-fidelity-instrumentation.md Increment B, fixed
  // 2026-07-26 — see resolveAuthoritativeStyle's own WHY): resolved ONCE,
  // authoritatively, here — used for EVERY remaining return (native, clone,
  // clone's own decline) so a lost draft-time race never lies about what the
  // ladder actually decided, on ANY path, not just the one that bakes a
  // weight file.
  const resolved = resolveAuthoritativeStyle(pdfPage, PDFLib, fontkit, insert.fontName, style, cache);
  const styleSource = resolved.styleSource;

  const rung1 = await tryNativeSubset(pdfPage, PDFLib, fontkit, insert, text, cache);
  if (rung1.ok) return { ok: true, font: rung1.font, path: 'native', styleSource, glyphShortfall: 0 };
  const shortfall = rung1.glyphShortfall || 0;

  const rung2 = await tryClone(pdfPage, PDFLib, fontkit, insert, text, resolved, cache);
  if (rung2.ok) return { ok: true, font: rung2.font, path: 'clone', styleSource, glyphShortfall: shortfall };

  // The FINAL decline is rung 2's own reason — rung 1's reason was only ever
  // a "try the next rung" signal, never surfaced past this point (mirrors
  // planNativeInserts' old missing-glyph -> compose -> twin chain, just one
  // rung further now).
  return { ok: false, reason: rung2.reason, styleSource, glyphShortfall: shortfall };
}

// One pdfPage.drawText() call — position/size/direction come from the walk
// exactly as the deleted appendNativeText snippet did (spec §2): `insert.x/y`
// IS the absolute baseline origin (not a box top), `insert.size` the em size,
// `insert.ux/uy` the baseline's unit direction vector.
export function stampText(pdfPage, PDFLib, font, insert, text, color) {
  const [r, g, b] = hexToRgb01(color);
  const opts = {
    x: insert.x,
    y: insert.y,
    size: insert.size,
    font,
    color: PDFLib.rgb(r, g, b),
  };
  // Omit `rotate` for the identity direction (ux=1, uy=0) — pdf-lib defaults
  // to unrotated, and skipping the call avoids a degrees(0) no-op object for
  // the overwhelmingly common case.
  if (!(insert.ux === 1 && insert.uy === 0)) {
    opts.rotate = PDFLib.degrees((Math.atan2(insert.uy, insert.ux) * 180) / Math.PI);
  }
  // Through the ONE door: a pasted thin space or ZWSP reaching pdf-lib's
  // WinAnsi encoder throws and aborts the whole export. That is the
  // 2026-07-29 live breakage, on a build that already "fixed" WinAnsi at a
  // different call site. See text-encode.js's drawTextSafe.
  drawTextSafe(pdfPage, text, opts);
}
