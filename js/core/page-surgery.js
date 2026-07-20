/*
 * PDFLokal — core/page-surgery.js  (RUNG B+C — the per-page surgery pipeline)
 * ============================================================================
 * Extracted out of core/export.js (founder ruling 2026-07-20, executing
 * spec-live-surgery.md's build order §8.1: "Extract the per-page surgery+
 * insert pipeline from export.js into core/page-surgery.js; buildPdfBytes
 * calls it; prove export parity"). PURE REFACTOR — runSurgery and
 * planNativeInserts move here UNCHANGED (same names, same signatures, same
 * behavior), export.js now imports and calls them.
 *
 * WHY this lives outside export.js now: export.js already produces the whole
 * document's honest result at download time — that's still its only job.
 * spec-live-surgery.md's next increment (not this one) makes the EDITOR itself
 * re-render a page's background raster from a surgically-modified copy at
 * commit time, using this exact same pipeline. Two callers (export at
 * download, the editor at commit) must share ONE honest implementation of
 * "cut the original run, try to write the replacement back with the
 * document's own font" — that pipeline can't keep living inside export.js's
 * module once a second, non-export caller needs it. This module is that
 * single home; export.js is now just one of its two callers.
 *
 * Same vendor-injection discipline as redact.js/reinsert.js: PDFLib and
 * fontkit are passed in by the caller — this file has zero vendor imports.
 */

import { removeRunsFromPdfPage } from './redact.js';
import { planNativeInsert, appendNativeText, extractFontProgram, lookupFontObject } from './reinsert.js';
import { planComposedInsert, patchToUnicodeForMarks } from './compose.js';

// ---- Rung B: honest replacement (surgery) ------------------------------------

// WHY 60%: replaceBox is the cover's BIRTH-TIME rect; if the user later drags
// the cover away from it, they've un-covered the original words — the surgery
// intent (born together with the cover) no longer holds, and cutting the show
// ops would leave a hole with nothing drawn over it. A small nudge (still
// mostly overlapping) is not a "moved away" — hence a threshold, not exact
// equality. Both rects are page-space top-left, same frame — plain rect math.
const REPLACE_OVERLAP_MIN = 0.6;

function overlapsBirthBox(anno) {
  const box = anno.replaceBox;
  const boxArea = box.w * box.h;
  if (boxArea <= 0) return false;
  const ix0 = Math.max(anno.x, box.x);
  const iy0 = Math.max(anno.y, box.y);
  const ix1 = Math.min(anno.x + anno.width, box.x + box.w);
  const iy1 = Math.min(anno.y + anno.height, box.y + box.h);
  const iw = Math.max(0, ix1 - ix0);
  const ih = Math.max(0, iy1 - iy0);
  return (iw * ih) >= REPLACE_OVERLAP_MIN * boxArea;
}

// Cut the original show-text ops for every whiteout cover that still carries
// a valid, un-moved replace intent. Returns { skipCovers, insertByCover }:
// skipCovers is the set of annotation ids whose cover should be SKIPPED at
// draw time (the true background shows through — strictly better than a
// sampled-color rectangle); insertByCover maps that SAME cover id to the
// text-walk.js `insert` geometry the removed run painted with — Rung C's
// native re-insert needs it to write the replacement back with the
// document's own font (see planNativeInserts below). Never throws: any
// surgery failure falls back to both empty, so the cover ships and the
// export lives.
//
// replaceTargets is an ARRAY (founder ruling 2026-07-19: the LINE is the
// editing primitive — a whole-line target can in principle span more than one
// content-stream cut). All candidates' targets are flattened into ONE
// removeRunsFromPdfPage call (it already accepts an array), then results are
// sliced back per annotation in the same order they were flattened.
export function runSurgery(pdfPage, PDFLib, annotations) {
  const skipCovers = new Set();
  const insertByCover = new Map();
  const candidates = annotations.filter(
    (a) => a.type === 'whiteout' && a.replaceTargets?.length && a.replaceBox && overlapsBirthBox(a),
  );
  if (candidates.length === 0) return { skipCovers, insertByCover };
  try {
    const flatTargets = [];
    const spans = []; // [start, end) into flatTargets, per candidate
    for (const a of candidates) {
      spans.push([flatTargets.length, flatTargets.length + a.replaceTargets.length]);
      flatTargets.push(...a.replaceTargets);
    }
    const { results } = removeRunsFromPdfPage(pdfPage, PDFLib, flatTargets);
    candidates.forEach((a, i) => {
      const [start, end] = spans[i];
      const slice = results.slice(start, end);
      // WHY all-matched, not any-matched: a partial match means some of the
      // line's fragments got cut and some didn't — the already-cut ops are
      // gone from the content stream either way, so the cover MUST stay to
      // hide the now-broken remainder. Never leave a half-removed line
      // uncovered.
      if (slice.length > 0 && slice.every((r) => r.matched)) {
        skipCovers.add(a.id);
        // The line always STARTS at its first target — the honest entry
        // point for where replacement text should paint, even on the (not
        // yet produced, but architecturally allowed) multi-target line.
        insertByCover.set(a.id, slice[0].insert);
      }
    });
  } catch (err) {
    // WHY warn-and-continue: an export must NEVER fail or degrade because
    // surgery had trouble — the Rung A cover fallback is always still there.
    console.warn('[core/page-surgery] surgery failed, covers kept:', err);
  }
  return { skipCovers, insertByCover };
}

// ---- Rung C: native re-insert (own-font replacement) ------------------------

// Font-fidelity tier 2 fallback: try composing the missing glyph(s) from the
// subset's own outlines. Returns true when the composed paint landed (caller
// adds the anno to skipDraw), false on ANY decline — the twin draw is always
// still there. Kept out of planNativeInserts' loop body so the loop reads as
// the decision ladder it is: native → composed → twin.
function planComposedFallback(pdfPage, PDFLib, fontkit, insert, anno) {
  try {
    // Type0 gate: extractFontProgram succeeding on a /Type0 dict already
    // implies Identity-H (it declines every other Type0 encoding) — so the
    // shape test is just the subtype read; the extract does the rest.
    const { PDFName, PDFRef } = PDFLib;
    const context = pdfPage.doc.context;
    const fontObj = lookupFontObject(pdfPage, PDFLib, insert.fontName);
    if (!fontObj) return false;
    const subtypeRaw = fontObj.get(PDFName.of('Subtype'));
    const subtype = subtypeRaw instanceof PDFRef ? context.lookup(subtypeRaw) : subtypeRaw;
    if (!(subtype instanceof PDFName) || subtype.toString() !== '/Type0') return false;

    const extracted = extractFontProgram(pdfPage, PDFLib, insert.fontName);
    if (!extracted.ok) return false;
    const font = fontkit.create(extracted.bytes);

    const plan = planComposedInsert(font, extracted.bytes, insert, anno.text, anno.color);
    if (!plan.ok) return false;
    appendNativeText(pdfPage, PDFLib, plan.snippet);
    // Extraction honesty (spec §4 step 6): best-effort by design — the
    // composed paint ships even when the font carries no ToUnicode to patch.
    patchToUnicodeForMarks(pdfPage, PDFLib, insert.fontName, plan.marks);
    return true;
  } catch (err) {
    console.warn('[core/page-surgery] composed insert failed, falling back to twin draw:', err);
    return false;
  }
}

// For every TEXT annotation born from a Ganti Teks replace (carries
// replaceCoverId — see js/v2/app.js's smartReplace/openTextEditor) whose
// cover's surgery just succeeded, try to write its text INTO the content
// stream using the document's OWN font instead of drawing a metric-twin
// annotation on top. Returns the set of annotation ids painted natively —
// the drawing loop below skips those. Any decline (mixed fonts, multiline,
// missing glyph, unsupported font shape, no fontkit, …) or thrown error just
// leaves the id out of the set: the twin drawer paints it exactly as today.
// Never a hard failure — mirrors runSurgery's discipline one level up.
export function planNativeInserts(pdfPage, PDFLib, fontkit, annotations, skipCovers, insertByCover) {
  const skipDraw = new Set();
  if (!fontkit) return skipDraw; // same deps guard as the custom-font embed path
  for (const anno of annotations) {
    if (anno.type !== 'text' || !anno.replaceCoverId || !skipCovers.has(anno.replaceCoverId)) continue;
    const insert = insertByCover.get(anno.replaceCoverId);
    if (!insert) continue;
    try {
      const plan = planNativeInsert(pdfPage, PDFLib, fontkit, { insert, text: anno.text, color: anno.color });
      if (plan.ok) {
        appendNativeText(pdfPage, PDFLib, plan.snippet);
        skipDraw.add(anno.id);
      } else if (plan.reason === 'missing-glyph') {
        // Font-fidelity tier 2 (core/compose.js, founder-ratified 2026-07-20):
        // a missing glyph may still be COMPOSABLE from outlines the subset
        // itself carries (É = E + é's own acute) — the document's own font
        // stays on the page. Gated to Type0 (the GID-writable shape; a
        // simple-TrueType font writes encoding bytes, which cannot reach an
        // un-cmapped mark). 'missing-glyph' is the ONLY rescued decline:
        // mixed-fonts/multiline/unsupported-* stay declined exactly as
        // before. Any compose decline or throw lands back on the twin draw —
        // same never-a-hard-failure discipline as everything else here.
        const composed = planComposedFallback(pdfPage, PDFLib, fontkit, insert, anno);
        if (composed) skipDraw.add(anno.id);
      }
    } catch (err) {
      console.warn('[core/page-surgery] native re-insert failed, falling back to twin draw:', err);
    }
  }
  return skipDraw;
}

// ---- the composed pipeline ----------------------------------------------------

// Run BOTH rungs, in the exact order buildPdfBytes has always run them, over
// one already-copied pdf-lib page. This is the ONE call a caller needs —
// export.js and (spec-live-surgery.md increment 2) the editor's live
// re-render both call this instead of re-deriving the sequencing themselves.
//
// WHY surgery runs before native-insert, and both run before ANY drawing:
// runSurgery must cut ops out of the copied page's ORIGINAL content stream
// before pdf-lib's first draw call (drawRectangle/drawText/…) appends its OWN
// content stream to the page — run it after and removeRunsFromPdfPage would
// have to contend with content pdf-lib itself just wrote (and rewrite the
// wrong stream at that). planNativeInserts' appendNativeText has the same
// constraint (see reinsert.js) — its append must land before pdf-lib's first
// draw call touches this page. Callers that draw annotations afterward (e.g.
// export.js's ANNOTATION_DRAWERS loop) get the ordering guarantee for free by
// calling this function first, before their own first draw.
export function applyPageSurgery(pdfPage, PDFLib, fontkit, annotations) {
  const { skipCovers, insertByCover } = runSurgery(pdfPage, PDFLib, annotations);
  const skipDraw = planNativeInserts(pdfPage, PDFLib, fontkit, annotations, skipCovers, insertByCover);
  return { skipCovers, skipDraw, insertByCover };
}

// ---- Rung D: the editor's own per-page pipeline (spec-live-surgery.md §3/§4) --
// buildPdfBytes above needs the WHOLE document; the editor needs exactly ONE
// page's bytes, on demand, at commit time — same two rungs, same honesty,
// scoped down. Both callers converge on applyPageSurgery(); this section adds
// the second caller's own entry points.

// A committed Ganti pair on `page`: a whiteout cover carrying replaceTargets/
// replaceBox, paired with the text annotation (if any) whose replaceCoverId
// points back at it. This is the SAME candidate shape runSurgery's own
// `candidates` filter uses (type==='whiteout' && replaceTargets?.length &&
// replaceBox) — deliberately not re-deriving a different notion of "edit".
// Freeform annotations (signatures, standalone Teks, real whiteout, TTD) never
// match this filter, so they never count as edits (spec §2).
function pageEdits(page) {
  return page.annotations
    .filter((anno) => anno.type === 'whiteout' && anno.replaceTargets?.length && anno.replaceBox)
    .map((cover) => ({
      coverId: cover.id,
      targets: cover.replaceTargets,
      replacement: page.annotations.find((anno) => anno.type === 'text' && anno.replaceCoverId === cover.id),
    }));
}

// A stable string over a page's committed edit set — the memo key
// core/import.js's edited-page cache (and any future caller) uses to decide
// "has this page's edit set actually changed since I last baked it". Empty
// string means "no committed edits", i.e. the plain source render is already
// correct. Built ONLY from fields that actually change buildEditedPageBytes'
// output (target geometry, replacement text, its style) — an unrelated
// annotation field (e.g. the cover's own current x/y, which surgery never
// reads) must NOT appear here, or a no-op change would falsely invalidate a
// still-correct cache.
export function editSignature(page) {
  const edits = pageEdits(page);
  if (edits.length === 0) return '';
  const parts = edits.map(({ coverId, targets, replacement }) => ({
    coverId,
    targets,
    text: replacement?.text ?? null,
    style: replacement
      ? {
        fontFamily: replacement.fontFamily,
        fontSize: replacement.fontSize,
        bold: !!replacement.bold,
        italic: !!replacement.italic,
        color: replacement.color,
      }
      : null,
  }));
  return JSON.stringify(parts);
}

// Build a single-page PDF for `page` carrying the SAME surgery + native-
// insert pipeline export.js runs at download time — the editor's live re-
// render calls this at commit (spec-live-surgery.md §3/§4) so a page's
// background raster shows the truth instead of a DOM cover+sticker collage.
//
// `srcDoc` is the ALREADY-LOADED pdf-lib document for the page's source
// (callers are expected to cache this per source, same discipline
// buildPdfBytes' own srcDocCache and js/v2/app.js's pdfLibDocCache already
// follow — copyPages only READS srcDoc, so sharing one load across many
// pages/edits is safe). `annotations` is the page's own annotation list —
// the SAME input shape buildPdfBytes hands to applyPageSurgery; this
// function does not pre-filter it down to just the Ganti pairs —
// applyPageSurgery already scopes itself to whiteout-with-replaceTargets /
// text-with-replaceCoverId internally, exactly as it does for export.
//
// Declined edits are NEVER drawn into these bytes (spec Decision 2 default:
// a declined edit stays a DOM-overlay cover, not baked Tip-Ex) — unlike
// buildPdfBytes, there is no ANNOTATION_DRAWERS loop here at all.
//
// Returns `{ bytes: null, applied: new Set(), declined }` when nothing
// applied — the caller must render the plain source page in that case.
export async function buildEditedPageBytes(srcDoc, page, annotations, deps = {}) {
  const { PDFLib, fontkit } = deps;
  const newDoc = await PDFLib.PDFDocument.create();
  // ONE copyPages call — variant B from the timing spike
  // (tests/spike/live-surgery-timing-lib.js): a page-scoped save is cheaper
  // than a whole-doc save on large files, identical on small ones.
  const [copiedPage] = await newDoc.copyPages(srcDoc, [page.sourcePageNum]);
  const pdfPage = newDoc.addPage(copiedPage);
  // Same rotation handling as buildPdfBytes' own copyPages path, exactly:
  // the copy already carries the source page's inherited /Rotate; only an
  // explicit page.rotation (a user-applied in-editor rotate) overrides it.
  if (page.rotation) pdfPage.setRotation(PDFLib.degrees(page.rotation));

  const { skipCovers, skipDraw } = applyPageSurgery(pdfPage, PDFLib, fontkit, annotations);

  // Every whiteout carrying a replace intent is a candidate edit (regardless
  // of whether its birth-box overlap still holds — see overlapsBirthBox
  // above); any that didn't make skipCovers declined, exactly answering the
  // question runSurgery itself already asked internally — read back out here
  // so the caller knows which covers still need their DOM-overlay fallback
  // (spec Decision 2 default).
  const editCoverIds = annotations
    .filter((anno) => anno.type === 'whiteout' && anno.replaceTargets?.length && anno.replaceBox)
    .map((anno) => anno.id);
  const declined = editCoverIds.filter((coverId) => !skipCovers.has(coverId));
  const applied = new Set([...skipCovers, ...skipDraw]);

  if (applied.size === 0) return { bytes: null, applied, declined };

  const bytes = await newDoc.save({ useObjectStreams: true, addDefaultPage: false });
  return { bytes, applied, declined };
}
