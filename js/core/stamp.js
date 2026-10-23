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
 * ONE FONT PER LINE (2026-10-01): when the committed annotation carries the
 * editor's fontDecision (core/line-font.js), the ladder above does not run —
 * the stamp embeds exactly the decided font after re-verifying it with the
 * same decideLineFont, so the file holds the face the user watched while
 * typing. The ladder remains for edits committed without a decision, and as
 * the fallback when a decision fails to verify (reported, never silent).
 *
 * Reason vocabulary is telemetry-schema.js's `insert.reason` enum, reused
 * verbatim wherever an existing value fits (decline-never-guess extends to
 * "don't invent a new enum value when an old one already means this").
 */

import { extractFontProgram, lookupFontObject } from './doc-fonts.js';
import { drawTextSafe, toStandardFontSafe } from './text-encode.js';
import { getFontStyleInfo } from './font-style.js';
import { cloneFamilyFor } from './font-decide.js';
import { CLONE_FONT_VARIANTS, CLONE_FONT_URLS, isSfntFontProgram } from './clone-fonts.js';
import { fingerprintProgram, FAMILY_BUCKET_TO_CLONE } from './font-fingerprint.js';
import { textCoveredBy, countMissingGlyphs, decideLineFont } from './line-font.js';
import { placeBlockLines } from './block-edit.js';

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

// Coverage (glyphPaints / textCoveredBy / countMissingGlyphs) MOVED to
// core/line-font.js on 2026-10-01: decideLineFont needs it, and this module now
// calls decideLineFont as its verifier — two homes would import each other.
// Re-exported here so js/v2/app.js's commit-time prediction and every existing
// test keep importing it from the module whose rung 1 it describes.
export { textCoveredBy, countMissingGlyphs };

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

// ---- save-time readiness ----------------------------------------------------
//
// ⚠️ pdf-lib's embedFont() is LAZY. It returns a PDFFont having read almost
// nothing; the FontDescriptor is only written at `doc.save()`, and THAT is
// when it reads italicAngle (the `post` table), ascent/descent/capHeight/
// xHeight, bbox, `post.isFixedPitch` and `head.macStyle`. A document subset
// missing one of those tables therefore passes every check below, embeds
// "successfully" — and then throws from inside save(), which is outside every
// try in this file. The rung's decline never fires, and the whole export dies.
//
// Measured on the rail 2026-09-21: `export / TypeError / undefined-prop`,
// three sessions, 3-48 retries each, zero files. Every Unduh throws the same way
// because the edit is still in the document. Reproduced on two wild fixtures:
// `Cannot read properties of undefined (reading 'italicAngle')` from pdf-lib's
// embedFontDescriptor. This reads exactly those fields NOW, while a throw
// can still decline rung 1 and fall to the clone/twin rungs as designed.
export function fontEmbedsAtSave(parsed) {
  try {
    const { bbox } = parsed;
    const nums = [parsed.italicAngle, parsed.ascent, parsed.descent, bbox.minX, bbox.minY, bbox.maxX, bbox.maxY];
    // capHeight/xHeight are optional to pdf-lib (`l||a`, `h||0`), but reading
    // them still dereferences OS/2 inside fontkit, so they must not throw.
    void parsed.capHeight; void parsed.xHeight;
    void parsed.post.isFixedPitch; void parsed.head.macStyle.italic;
    if (!nums.every((n) => Number.isFinite(n))) return false;
    return glyphsReadableAtSave(parsed);
  } catch {
    return false;
  }
}

// THE OTHER HALF OF save(): the widths. Without `{subset:true}` pdf-lib's
// CustomFontEmbedder writes the /W array for EVERY code point in the font's
// cmap (allGlyphsInFontSortedById -> computeWidths), reading each glyph's
// advanceWidth. fontkit answers that from the glyph's own outline header, so a
// subset whose glyf/loca runs past the end of its bytes (a truncated or damaged
// FontFile2 stream) parses, passes every descriptor field above, embeds, and
// then throws `RangeError: Trying to access beyond buffer length` from inside
// save(). The first real one, 2026-10-01 (Sentry JAVASCRIPT-17, tag
// stage:commit-bake): the bake swallowed it, and export would have died on it.
// This walks exactly the glyphs pdf-lib will walk, now, while a throw can still
// decline the rung. Memoised per parsed font: callers ask on every keystroke.
const glyphsReadable = new WeakMap();
function glyphsReadableAtSave(parsed) {
  if (glyphsReadable.has(parsed)) return glyphsReadable.get(parsed);
  let ok = true;
  try {
    for (const cp of parsed.characterSet) {
      if (!Number.isFinite(parsed.glyphForCodePoint(cp).advanceWidth)) { ok = false; break; }
    }
  } catch {
    ok = false;
  }
  glyphsReadable.set(parsed, ok);
  return ok;
}

// ---- rung 1: doc-subset -------------------------------------------------------

async function tryNativeSubset(pdfPage, PDFLib, fontkit, insert, text, cache) {
  if (!fontkit) return { ok: false, reason: 'unsupported-font' };
  const got = getOrParseFont(pdfPage, PDFLib, fontkit, insert.fontName, cache);
  if (!got.ok) return got;
  const { entry } = got;
  // Before embedFont, never after: once embedded, the font sits in the doc's
  // font list and save() will try it regardless of what this rung returns.
  if (!entry.embedded && !fontEmbedsAtSave(entry.parsed)) return { ok: false, reason: 'unsupported-font' };
  // fontkit parses WOFF2 happily, and pdf-lib re-embeds these bytes verbatim —
  // so a file pdflokal itself exported before 2026-09-23 (WOFF2 as FontFile2)
  // would carry its bug into the new edit. Decline; the clone rung is sfnt.
  if (!entry.embedded && !isSfntFontProgram(entry.bytes)) return { ok: false, reason: 'unsupported-font' };

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

// ---- the live decision's font (core/line-font.js) -----------------------------

// The SAME gates tryNativeSubset applies before embedding a document's own
// program, packaged as a decideLineFont candidate that the editor
// (js/v2/line-font-live.js) and the stamp both build. WHY one helper: if the
// editor offered a native candidate this module would then refuse to embed,
// the editor would show the document's font while the file got another one —
// the seeing ≠ file the decision exists to remove. null = not offered.
export function nativeCandidate({ parsed, bytes, key, css }) {
  if (!parsed || !bytes) return null;
  if (!fontEmbedsAtSave(parsed)) return null;
  if (!isSfntFontProgram(bytes)) return null;
  return { path: 'native', parsed, key, ...(css ? { css } : {}) };
}

// Embed exactly the font a stored decision names, after VERIFYING it with the
// same decideLineFont the editor decided with, on the same bytes: the doc's
// own program read off THIS page by resource key (native), or the bundled TTF
// the editor loaded its FontFace from (clone/substitute). { ok:true, font } or
// { ok:false } — never throws, never substitutes: a failed verify is the
// caller's to report. Exported for core/export.js, which draws a declined
// Ganti edit with this same font instead of the twin's Helvetica.
export async function resolveDecidedFont(pdfPage, PDFLib, fontkit, decision, text) {
  if (!fontkit || !decision || decision.v !== 1) return { ok: false };
  const cache = getDocCache(pdfPage.doc);
  try {
    let entry;
    let candidate = null;
    if (decision.path === 'native') {
      if (!decision.key) return { ok: false };
      const got = getOrParseFont(pdfPage, PDFLib, fontkit, decision.key, cache);
      if (!got.ok) return { ok: false };
      entry = got.entry;
      candidate = entry.embedded
        ? { path: 'native', parsed: entry.parsed, key: decision.key }
        : nativeCandidate({ parsed: entry.parsed, bytes: entry.bytes, key: decision.key });
    } else if (decision.path === 'clone' || decision.path === 'substitute') {
      if (!CLONE_FONT_URLS[decision.face] || typeof fetch !== 'function') return { ok: false };
      const key = `clone:${decision.face}`; // the same cache slot tryClone fills
      entry = cache.get(key);
      if (!entry) {
        const bytes = await fetchCloneFontBytes(decision.face);
        entry = { bytes, parsed: fontkit.create(bytes), embedded: null };
        cache.set(key, entry);
      }
      candidate = { path: decision.path, parsed: entry.parsed, face: decision.face };
    }
    if (!candidate) return { ok: false };
    if (decideLineFont(text, [candidate]).path === 'none') return { ok: false };
    if (!entry.embedded) entry.embedded = await pdfPage.doc.embedFont(entry.bytes);
    return { ok: true, font: entry.embedded };
  } catch {
    return { ok: false };
  }
}

// Rung 1's own diagnostic without rung 1's side effect: how many chars the
// first run's embedded subset lacks, behind the same gates, WITHOUT embedding
// it (a decided clone must not drag an unused doc font into the file). Keeps
// `insert.glyph_shortfall` meaning exactly what it meant before decisions.
function nativeShortfall(pdfPage, PDFLib, fontkit, fontName, text, cache) {
  if (!fontkit) return 0;
  const got = getOrParseFont(pdfPage, PDFLib, fontkit, fontName, cache);
  if (!got.ok) return 0;
  const { entry } = got;
  if (!entry.embedded && (!fontEmbedsAtSave(entry.parsed) || !isSfntFontProgram(entry.bytes))) return 0;
  return textCoveredBy(entry.parsed, text) ? 0 : countMissingGlyphs(entry.parsed, text);
}

const DECIDED_PATHS = new Set(['native', 'clone', 'substitute']);

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
    const bytes = await res.arrayBuffer();
    // Same law as export.js: pdf-lib embeds bytes verbatim, and a PDF cannot
    // carry a WOFF/WOFF2 program. Throwing declines the rung (clone-unavailable).
    if (!isSfntFontProgram(new Uint8Array(bytes))) throw new Error(`stamp.js: ${url} is not an sfnt font program`);
    return bytes;
  } finally {
    clearTimeout(timeoutId);
  }
}

// AUTHORITATIVE bold/italic/family-source resolution — CORRECTNESS, not a
// telemetry nicety (founder-flagged 2026-07-26, spec-edit-fidelity-
// instrumentation.md). js/v2/doc-font-live.js's prepareDocFont computes this SAME
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
// draft-time race (js/v2/doc-font-live.js's prepareDocFont, unawaited) can never pick
// the wrong clone weight file), decision (the annotation's fontDecision from
// core/line-font.js, or null for an edit committed before decisions existed
// or before the editor's fonts loaded).
//
// WITH a decision, the stamp FOLLOWS it: the font the user watched while
// typing is the font embedded, re-verified here with the same decideLineFont
// on the same bytes. The `mixed-fonts` decline does not apply — a decision is
// by construction ONE font for the whole line (his answer 1: the bold word
// un-bolds), so "the line's runs use several fonts" no longer stops the stamp.
// A failed verify falls to the old ladder and says so (`decidedLive:false`).
// Returns { ok:true, font, path:'native'|'clone', decision, decidedLive } or
// { ok:false, reason, decision:'none', decidedLive } — never throws. A
// substitute bakes as path 'clone' (the telemetry `path` enum keeps its
// meaning); `decision` carries the finer value.
export async function resolveStampFont(pdfPage, PDFLib, fontkit, insert, text, style, decision = null) {
  // Structural guards FIRST, exactly reinsert.js's own order, and BEFORE any
  // font work at all (incl. the authoritative style resolve below) — a
  // single pdfPage.drawText() call paints ONE baseline in ONE font for the
  // WHOLE string regardless of which rung supplies that font, so these
  // declines never even need to know what the font is.
  const styleSourceHint = style?.styleSource || 'none';
  const decided = !!decision && decision.v === 1 && DECIDED_PATHS.has(decision.path);
  const decline = (reason, styleSource, glyphShortfall) => ({
    ok: false, reason, styleSource, glyphShortfall, decision: 'none', decidedLive: false,
  });
  if (insert.mixedFonts && !decided) return decline('mixed-fonts', styleSourceHint, 0);
  if (text.includes('\n')) return decline('multiline', styleSourceHint, 0);
  if (text.length === 0) return decline('empty', styleSourceHint, 0);

  const cache = getDocCache(pdfPage.doc);

  // style_source (spec-edit-fidelity-instrumentation.md Increment B, fixed
  // 2026-07-26 — see resolveAuthoritativeStyle's own WHY): resolved ONCE,
  // authoritatively, here — used for EVERY remaining return (native, clone,
  // clone's own decline) so a lost draft-time race never lies about what the
  // ladder actually decided, on ANY path, not just the one that bakes a
  // weight file.
  const resolved = resolveAuthoritativeStyle(pdfPage, PDFLib, fontkit, insert.fontName, style, cache);
  const styleSource = resolved.styleSource;

  if (decided) {
    const r = await resolveDecidedFont(pdfPage, PDFLib, fontkit, decision, text);
    if (r.ok) {
      const glyphShortfall = decision.path === 'native'
        ? 0 : nativeShortfall(pdfPage, PDFLib, fontkit, insert.fontName, text, cache);
      return {
        ok: true, font: r.font, path: decision.path === 'native' ? 'native' : 'clone',
        decision: decision.path, decidedLive: true, styleSource, glyphShortfall,
      };
    }
    // The decision did not verify against the document: the old ladder runs,
    // guards included, and the telemetry says the editor's choice did not hold.
    if (insert.mixedFonts) return decline('mixed-fonts', styleSource, 0);
  }

  const rung1 = await tryNativeSubset(pdfPage, PDFLib, fontkit, insert, text, cache);
  if (rung1.ok) {
    return { ok: true, font: rung1.font, path: 'native', decision: 'native', decidedLive: false, styleSource, glyphShortfall: 0 };
  }
  const shortfall = rung1.glyphShortfall || 0;

  const rung2 = await tryClone(pdfPage, PDFLib, fontkit, insert, text, resolved, cache);
  if (rung2.ok) {
    return { ok: true, font: rung2.font, path: 'clone', decision: 'clone', decidedLive: false, styleSource, glyphShortfall: shortfall };
  }

  // The FINAL decline is rung 2's own reason — rung 1's reason was only ever
  // a "try the next rung" signal, never surfaced past this point (mirrors
  // planNativeInserts' old missing-glyph -> compose -> twin chain, just one
  // rung further now).
  return decline(rung2.reason, styleSource, shortfall);
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

// RUNG D: a whole paragraph, one drawText per stored line (per word on a
// justified line), at the positions core/block-edit.js places them with THIS
// font's own advance widths. `block` is the committed annotation's `block`:
// its lines are the breaks the editor painted, never re-wrapped here.
// Horizontal by construction (a rotated block declines at tap time).
export function stampBlock(pdfPage, PDFLib, font, block, color) {
  const [r, g, b] = hexToRgb01(color);
  const size = block.size;
  // Measure exactly the string drawTextSafe will hand pdf-lib.
  const widthOf = (str) => font.widthOfTextAtSize(toStandardFontSafe(str), size);
  for (const line of placeBlockLines(block, widthOf)) {
    for (const seg of line.segments) {
      drawTextSafe(pdfPage, seg.text, { x: seg.x, y: line.y, size, font, color: PDFLib.rgb(r, g, b) });
    }
  }
}

// The text a block's font must cover: every painted line, breaks dropped.
export function blockText(block) {
  return block.lines.map((l) => l.text).join(' ');
}
