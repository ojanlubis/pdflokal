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

import { extractFontProgram, lookupFontObject } from './reinsert.js';
import { getFontStyleInfo } from './font-style.js';
import { cloneFamilyFor } from './font-decide.js';
import { CLONE_FONT_VARIANTS, CLONE_FONT_URLS } from './clone-fonts.js';

// ---- shared little helpers ---------------------------------------------------

// Same hex->0..1 conversion reinsert.js already has — ported, not imported:
// reinsert.js is dormant-but-present in this increment and retires whole in
// increment 2 (spec §1's DIES list), so a survivor that needs to outlive it
// gets its own tiny copy here rather than a link to a file about to vanish.
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
function glyphPaints(font, cp) {
  if (!font.hasGlyphForCodePoint(cp)) return false;
  if (cp === 32) return true;
  try {
    const g = font.glyphForCodePoint(cp);
    if (!g || g.id === 0) return false; // .notdef
    const cmds = g.path && g.path.commands;
    return Array.isArray(cmds) && cmds.length > 0;
  } catch {
    return false;
  }
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

// ---- rung 1: doc-subset -------------------------------------------------------

async function tryNativeSubset(pdfPage, PDFLib, fontkit, insert, text, cache) {
  if (!fontkit) return { ok: false, reason: 'unsupported-font' };
  const extracted = extractFontProgram(pdfPage, PDFLib, insert.fontName);
  if (!extracted.ok) return extracted; // { ok:false, reason } verbatim

  const fontObj = lookupFontObject(pdfPage, PDFLib, insert.fontName);
  // Can't actually happen — extractFontProgram just proved this exact walk
  // resolves — but "can't happen" stays a decline here too (reinsert.js's own
  // discipline), never an assumed non-null.
  if (!fontObj) return { ok: false, reason: 'unsupported-font' };

  try {
    let entry = cache.get(fontObj);
    if (!entry) {
      entry = { parsed: fontkit.create(extracted.bytes), embedded: null };
      cache.set(fontObj, entry);
    }

    const normalized = text.normalize('NFC');
    for (const ch of normalized) {
      if (!glyphPaints(entry.parsed, ch.codePointAt(0))) return { ok: false, reason: 'missing-glyph' };
    }

    if (!entry.embedded) {
      // WHY here, not at buildEditedPageBytes/buildPdfBytes call sites only:
      // registerFontkit is idempotent to call twice, but this is the ONE spot
      // that actually NEEDS it (embedFont on raw bytes) — the caller-side
      // registration (export.js's buildPdfBytes, page-surgery.js's
      // buildEditedPageBytes) is the doc-level precondition this assumes.
      entry.embedded = await pdfPage.doc.embedFont(extracted.bytes);
    }
    return { ok: true, font: entry.embedded };
  } catch {
    // Any fontkit parse / pdf-lib embed throw on a malformed subset — a
    // genuine decline, never a guess (spec §3 rung 1).
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

async function tryClone(pdfPage, PDFLib, fontkit, insert, text, style, cache) {
  // Headless-node guard: no fontkit (embedFont needs it for anything but
  // pdf-lib's own standard-14) or no fetch (can't reach the self-hosted
  // woff2) both mean this rung simply cannot run here.
  if (!fontkit || typeof fetch !== 'function') return { ok: false, reason: 'clone-unavailable' };

  const info = getFontStyleInfo(pdfPage, PDFLib, insert.fontName);
  if (!info.ok) return { ok: false, reason: 'unsupported-font' };

  const family = cloneFamilyFor(info.baseFont);
  if (!family) return { ok: false, reason: 'clone-unavailable' };

  const variant = `${style?.bold ? '1' : '0'}${style?.italic ? '1' : '0'}`;
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

    const normalized = text.normalize('NFC');
    for (const ch of normalized) {
      if (!glyphPaints(entry.parsed, ch.codePointAt(0))) return { ok: false, reason: 'missing-glyph' };
    }

    if (!entry.embedded) entry.embedded = await pdfPage.doc.embedFont(entry.bytes);
    return { ok: true, font: entry.embedded };
  } catch {
    return { ok: false, reason: 'clone-unavailable' };
  }
}

// ---- the ladder ---------------------------------------------------------------

// req shape: insert (text-walk.js's per-target insert block, incl.
// mixedFonts), text (the FINAL typed replacement), style ({bold, italic} —
// the replacement annotation's OWN style, used only to pick the clone's
// weight file).
// Returns { ok:true, font, path:'native'|'clone' } or { ok:false, reason } —
// never throws (every internal failure is caught and typed above).
export async function resolveStampFont(pdfPage, PDFLib, fontkit, insert, text, style) {
  // Structural guards first, exactly reinsert.js's own order: a single
  // pdfPage.drawText() call paints ONE baseline in ONE font for the WHOLE
  // string, regardless of which rung supplies that font, so these declines
  // apply before either rung is even attempted.
  if (insert.mixedFonts) return { ok: false, reason: 'mixed-fonts' };
  if (text.includes('\n')) return { ok: false, reason: 'multiline' };
  if (text.length === 0) return { ok: false, reason: 'empty' };

  const cache = getDocCache(pdfPage.doc);

  const rung1 = await tryNativeSubset(pdfPage, PDFLib, fontkit, insert, text, cache);
  if (rung1.ok) return { ok: true, font: rung1.font, path: 'native' };

  const rung2 = await tryClone(pdfPage, PDFLib, fontkit, insert, text, style, cache);
  if (rung2.ok) return { ok: true, font: rung2.font, path: 'clone' };

  // The FINAL decline is rung 2's own reason — rung 1's reason was only ever
  // a "try the next rung" signal, never surfaced past this point (mirrors
  // planNativeInserts' old missing-glyph -> compose -> twin chain, just one
  // rung further now).
  return { ok: false, reason: rung2.reason };
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
  pdfPage.drawText(text, opts);
}
