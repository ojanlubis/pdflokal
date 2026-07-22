/*
 * PDFLokal — core/page-surgery.js  (RUNG B+C — the per-page surgery pipeline)
 * ============================================================================
 * Extracted out of core/export.js (founder ruling 2026-07-20, executing
 * spec-live-surgery.md's build order §8.1: "Extract the per-page surgery+
 * insert pipeline from export.js into core/page-surgery.js; buildPdfBytes
 * calls it; prove export parity"). runSurgery/applyPageSurgery are the two
 * callers' (export at download, the editor at commit) shared entry points.
 *
 * WHY this lives outside export.js now: export.js already produces the whole
 * document's honest result at download time — that's still its only job.
 * spec-live-surgery.md's next increment (not this one) makes the EDITOR itself
 * re-render a page's background raster from a surgically-modified copy at
 * commit time, using this exact same pipeline. Two callers must share ONE
 * honest implementation of "cut the original run, try to write the
 * replacement back with the best font the ladder resolves" — that pipeline
 * can't keep living inside export.js's module once a second, non-export
 * caller needs it. This module is that single home.
 *
 * RUNG C REBUILD (spec-edit-rebuild-composite.md, founder-ruled Path B,
 * 2026-07-22): planNativeInserts no longer hand-writes a content-stream
 * snippet (core/reinsert.js's old planNativeInsert/appendNativeText) or
 * composes a missing glyph from the subset's own outlines (core/compose.js).
 * Both files retired whole in increment 2 (spec §1's DIES list) — the write
 * mechanism is now core/stamp.js's resolveStampFont + pdfPage.drawText():
 * pdf-lib itself lays out, encodes, and embeds the replacement, so this
 * function is ASYNC (it awaits stamp.js's font-embed).
 *
 * Same vendor-injection discipline as redact.js/doc-fonts.js/stamp.js: PDFLib
 * and fontkit are passed in by the caller — this file has zero vendor
 * imports.
 */

import { removeRunsFromPdfPage } from './redact.js';
import { resolveStampFont, stampText } from './stamp.js';

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
  // Per-candidate surgery outcome for telemetry (spec-telemetry.md §3), kept
  // beside the working sets so the app layer can fire the `surgery` event
  // without re-deriving what runSurgery already decided. coverId -> {matched,
  // reason}. reason is 'clean' when every fragment cut, else 'no-match': the
  // code only knows matched:boolean per target (planRunRemoval), so the
  // schema's finer 'untrustworthy-run' isn't distinguishable here — exactly
  // the best-effort the schema author flagged for surgery.reason.
  const surgeryByCover = new Map();
  const candidates = annotations.filter(
    (a) => a.type === 'whiteout' && a.replaceTargets?.length && a.replaceBox && overlapsBirthBox(a),
  );
  if (candidates.length === 0) return { skipCovers, insertByCover, surgeryByCover };
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
      const matched = slice.length > 0 && slice.every((r) => r.matched);
      surgeryByCover.set(a.id, { matched, reason: matched ? 'clean' : 'no-match' });
      if (matched) {
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
  return { skipCovers, insertByCover, surgeryByCover };
}

// ---- Rung C: the composite stamp (own-font or clone, own-font-first) --------

// For every TEXT annotation born from a Ganti Teks replace (carries
// replaceCoverId — see js/v2/app.js's smartReplace/openTextEditor) whose
// cover's surgery just succeeded, resolve a font via stamp.js's ladder and
// STAMP its text into the page with pdf-lib's own drawText — never a
// hand-rolled content-stream snippet. Returns the set of annotation ids
// painted (native OR clone) — the drawing loop below skips those. Any
// decline (mixed fonts, multiline, missing glyph, unsupported font shape, no
// clone route, no fontkit, …) or thrown error just leaves the id out of the
// set: the twin drawer paints it exactly as today. Never a hard failure —
// mirrors runSurgery's discipline one level up. ASYNC (unlike the old
// planNativeInserts): stamp.js's ladder awaits pdf-lib's own embedFont.
export async function planNativeInserts(pdfPage, PDFLib, fontkit, annotations, skipCovers, insertByCover) {
  const skipDraw = new Set();
  // Per-annotation insert outcome for telemetry (spec-telemetry.md §3):
  // annoId -> { path:'native'|'clone'|'twin', reason }. 'native' when the
  // doc's own embedded font program covered the text; 'clone' when it didn't
  // but font-decide.js's /BaseFont routing found a bundled metric-twin that
  // does; 'twin' + the verbatim decline reason when both rungs declined and
  // it fell back to a metric-twin ANNOTATION instead — this is the
  // highest-value beta signal (WHY a replacement isn't the document's own
  // font). The app layer fires `insert` from this at commit.
  const insertOutcomes = new Map();
  if (!fontkit) return { skipDraw, insertOutcomes }; // same deps guard as the custom-font embed path
  for (const anno of annotations) {
    if (anno.type !== 'text' || !anno.replaceCoverId || !skipCovers.has(anno.replaceCoverId)) continue;
    const insert = insertByCover.get(anno.replaceCoverId);
    if (!insert) continue;
    try {
      const text = anno.text ?? '';
      const style = { bold: !!anno.bold, italic: !!anno.italic };
      const resolved = await resolveStampFont(pdfPage, PDFLib, fontkit, insert, text, style);
      if (resolved.ok) {
        stampText(pdfPage, PDFLib, resolved.font, insert, text, anno.color);
        skipDraw.add(anno.id);
        insertOutcomes.set(anno.id, { path: resolved.path, reason: 'clean' });
      } else {
        insertOutcomes.set(anno.id, { path: 'twin', reason: resolved.reason });
      }
    } catch (err) {
      // A rare throw drops to the twin draw exactly as before; leave it out of
      // insertOutcomes rather than mislabel it as a specific decline reason —
      // the surgery event still carries this edit, and `insert` simply won't
      // fire for it (better silent than a wrong enum).
      console.warn('[core/page-surgery] stamp failed, falling back to twin draw:', err);
    }
  }
  return { skipDraw, insertOutcomes };
}

// ---- the composed pipeline ----------------------------------------------------

// Run BOTH rungs, in the exact order buildPdfBytes has always run them, over
// one already-copied pdf-lib page. This is the ONE call a caller needs —
// export.js and (spec-live-surgery.md increment 2) the editor's live
// re-render both call this instead of re-deriving the sequencing themselves.
// ASYNC (spec-edit-rebuild-composite.md increment 1): planNativeInserts now
// awaits stamp.js's font-resolve ladder (fontkit parse + pdf-lib embedFont),
// so this and every caller must await it too.
//
// WHY surgery runs before the stamp, and both run before ANY OTHER drawing:
// runSurgery must cut ops out of the copied page's ORIGINAL content stream
// before pdf-lib's first draw call (drawRectangle/drawText/embedFont-then-
// draw/…) appends its OWN content stream to the page — run it after and
// removeRunsFromPdfPage would have to contend with content pdf-lib itself
// just wrote (and rewrite the wrong stream at that). The stamp's own
// drawText call has no such ordering constraint against ITSELF (it's pdf-lib
// drawing through pdf-lib's own normal path), but it must still land before
// any OTHER caller-side draw for the same "don't contend with content pdf-lib
// just wrote for THIS page" reason. Callers that draw annotations afterward
// (e.g. export.js's ANNOTATION_DRAWERS loop) get the ordering guarantee for
// free by calling this function first, before their own first draw.
export async function applyPageSurgery(pdfPage, PDFLib, fontkit, annotations) {
  const { skipCovers, insertByCover, surgeryByCover } = runSurgery(pdfPage, PDFLib, annotations);
  const { skipDraw, insertOutcomes } = await planNativeInserts(pdfPage, PDFLib, fontkit, annotations, skipCovers, insertByCover);
  // surgeryByCover/insertOutcomes are telemetry-only extras (spec-telemetry.md
  // §3); export.js reads only skipCovers/skipDraw/insertByCover — additive, so
  // its destructure is untouched.
  return { skipCovers, skipDraw, insertByCover, surgeryByCover, insertOutcomes };
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
// Exported (spec-live-surgery.md §5/§8.4, increment 4): js/v2/app.js's
// tap→edit entry needs the SAME "what counts as a committed edit" filter this
// module already uses internally, to detect a tap landing on an
// ALREADY-EDITED line (re-edit) before running a fresh hitTest against the
// pristine source. One filter, two callers — never let app.js re-derive its
// own notion of "edit" that could drift from this one.
function pageEdits(page) {
  return page.annotations
    .filter((anno) => anno.type === 'whiteout' && anno.replaceTargets?.length && anno.replaceBox)
    .map((cover) => ({
      coverId: cover.id,
      cover,
      targets: cover.replaceTargets,
      replacement: page.annotations.find((anno) => anno.type === 'text' && anno.replaceCoverId === cover.id),
    }));
}
export { pageEdits };

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
  // fontkit is only needed for the stamp's native/clone rungs (core/stamp.js
  // embeds raw font bytes via fontkit); a headless caller injecting only
  // PDFLib still gets valid bytes — every Ganti replacement just declines to
  // the twin draw (same guard export.js's buildPdfBytes already applies to
  // its own newDoc).
  if (fontkit) newDoc.registerFontkit(fontkit);
  // ONE copyPages call — variant B from the timing spike
  // (tests/spike/live-surgery-timing-lib.js): a page-scoped save is cheaper
  // than a whole-doc save on large files, identical on small ones.
  const [copiedPage] = await newDoc.copyPages(srcDoc, [page.sourcePageNum]);
  const pdfPage = newDoc.addPage(copiedPage);
  // Same rotation handling as buildPdfBytes' own copyPages path, exactly:
  // the copy already carries the source page's inherited /Rotate; only an
  // explicit page.rotation (a user-applied in-editor rotate) overrides it.
  if (page.rotation) pdfPage.setRotation(PDFLib.degrees(page.rotation));

  const { skipCovers, skipDraw, surgeryByCover, insertOutcomes } = await applyPageSurgery(pdfPage, PDFLib, fontkit, annotations);

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

  // Per-edit telemetry outcomes (spec-telemetry.md §3), built for EVERY
  // candidate — including a fully-declined edit (bytes null below), which is
  // exactly the signal worth capturing. app.js fires the surgery/insert events
  // from this ONLY on the commit path; a plain re-render reads the same array
  // harmlessly. insert is null when the edit has no replacement text (a pure
  // deletion) or its native-insert wasn't attempted (surgery declined first).
  const outcomes = editCoverIds.map((coverId) => {
    const surgery = surgeryByCover.get(coverId) || { matched: false, reason: 'no-match' };
    const replAnno = annotations.find((a) => a.type === 'text' && a.replaceCoverId === coverId);
    const insert = replAnno ? (insertOutcomes.get(replAnno.id) || null) : null;
    return { coverId, surgery, insert };
  });

  if (applied.size === 0) return { bytes: null, applied, declined, outcomes };

  const bytes = await newDoc.save({ useObjectStreams: true, addDefaultPage: false });
  return { bytes, applied, declined, outcomes };
}
