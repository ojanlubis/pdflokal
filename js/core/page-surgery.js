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

import { removeRunsFromPdfPage, readPageContents, readStreamText, extractFontMetrics, fontMetricsOfResources } from './redact.js';
import { walkShowOps } from './text-walk.js';
import { INVISIBLE_RENDER_MODES } from './text-visibility.js';
import { resolveStampFont, stampText, stampBlock, blockText } from './stamp.js';
import { glyphShortfallBucket } from './telemetry-schema.js';
import { totalPageRotation } from './page-rotation.js';

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

// ---- painters the cut cannot reach ----------------------------------------
//
// WHY (field reports 100500 and 100504, 2026-10-24/25: "Jatimpark Group" and
// "Mr Saturnino Antonio Morais" shown with the new words drawn over the old,
// both reported surgery {matched:true, reason:'clean'}): the cut edits ONE
// thing, the page's own content stream. Two other things paint on a page and
// the cut never sees them:
//   - a Form XObject (`/Fm0 Do`): its text is painted where the page's CTM
//     puts it, but its ops live in another stream;
//   - an annotation's appearance stream (FreeText, a filled form field, a
//     stamp): pdf.js paints it into the raster (core/import.js, default
//     annotationMode) and every reader paints it ABOVE the page content.
// pdf.js's text layer (which is what the user taps, js/v2/text-runs.js)
// includes the first and excludes the second, so a copy of the line drawn by
// either one survives the cut. Reproduced with constructed fixtures in
// tests/core/page-surgery-unreached.test.mjs: a FreeText or a text field
// repeating the line, and a shadow copy in a Form XObject offset far enough
// (5pt at 14pt) that pdf.js groups it into a line of its own. The cut found
// and removed its ops, so 'clean' was true of the content stream and false of
// the page.
//
// So before cutting, each edit asks: does anything the cut cannot reach paint
// visible text inside this line? If so the edit declines, exactly as a no-match
// does: no cut, no stamp, the cover stays (on screen the DOM cover hides the
// raster; export.js flattens a painted annotation under that cover, see
// flattenPaintedAnnotations). It reports reason 'unreached'. A cut cannot fix
// a copy it cannot reach, and removing the other painter would delete more
// than the user asked to change (a stamp, a signature field).

const MAX_FORM_DEPTH = 4; // forms painting forms; a cycle or a deep tree stops here

const mulM = (A, B) => [
  A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3],
  A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3],
  A[4] * B[0] + A[5] * B[2] + B[4], A[4] * B[1] + A[5] * B[3] + B[5],
];

// A record that puts ink on the page: a non-empty string in a render mode that
// paints (Tr 3 / 7 are an OCR layer or a clip, not marks).
function paintsText(rec) {
  if (INVISIBLE_RENDER_MODES.has(rec.tr)) return false;
  return rec.tokens.some((t) => t.t === 'str' && /[^\s\0]/.test(t.v));
}

function numbersOf(arr, PDFLib, n) {
  const { PDFArray, PDFNumber } = PDFLib;
  if (!(arr instanceof PDFArray) || arr.size() !== n) return null;
  const out = arr.asArray().map((v) => arr.context?.lookup?.(v) ?? v)
    .map((v) => (v instanceof PDFNumber ? v.asNumber() : NaN));
  return out.every(Number.isFinite) ? out : null;
}

// Every text record painted by the Form XObjects that `src` invokes, in page
// space, recursively. `resources` is the dict `src`'s names resolve against.
function formTextRecords(src, fonts, resources, ctm, PDFLib, context, depth, seen, out) {
  const { PDFName, PDFDict, PDFStream } = PDFLib;
  const xobjects = resources instanceof PDFDict ? resources.lookup(PDFName.of('XObject')) : null;
  const records = walkShowOps(src, fonts, {
    ctm,
    onDo: (name, doCtm) => {
      if (depth >= MAX_FORM_DEPTH || !(xobjects instanceof PDFDict)) return;
      const ref = xobjects.get(PDFName.of(name));
      const form = context.lookup(ref);
      if (!(form instanceof PDFStream) || seen.has(form)) return;
      if (form.dict.lookup(PDFName.of('Subtype')) !== PDFName.of('Form')) return;
      seen.add(form);
      const matrix = numbersOf(form.dict.lookup(PDFName.of('Matrix')), PDFLib, 6) || [1, 0, 0, 1, 0, 0];
      // A form without its own /Resources uses the ones it is painted with
      // (PDF 1.1 files; the spec still allows it).
      const own = form.dict.lookup(PDFName.of('Resources'));
      const formRes = own instanceof PDFDict ? own : resources;
      const formFonts = own instanceof PDFDict ? fontMetricsOfResources(own, context, PDFLib) : fonts;
      let formSrc;
      try { formSrc = readStreamText(form, PDFLib); } catch { return; } // undecodable: nothing provable
      out.push(...formTextRecords(formSrc, formFonts, formRes, mulM(matrix, doCtm), PDFLib, context, depth + 1, seen, []));
    },
  });
  if (depth > 0) out.push(...records); // depth 0 is the page itself: the cut's own business
  return out;
}

// Is the record's origin inside the target's span? The same band
// text-walk.js's planRunRemoval uses to call a record "inside" a target
// (0.4em across the baseline, from 0.35em before the start to the end).
function insideSpan(rec, t) {
  const vx = rec.x - t.x0;
  const vy = rec.y - t.y0;
  const along = vx * t.ux + vy * t.uy;
  const perp = Math.abs(vx * t.uy - vy * t.ux);
  return perp <= 0.4 * t.size && along >= -0.35 * t.size && along <= t.len;
}

// The target's painted box, axis-aligned in page space: descender (-0.25em)
// to ascent (1em) across the baseline, start to end along it.
function spanBox(t) {
  const [vx, vy] = [-t.uy, t.ux];
  const pts = [];
  for (const a of [0, t.len]) {
    for (const b of [-0.25 * t.size, t.size]) pts.push([t.x0 + t.ux * a + vx * b, t.y0 + t.uy * a + vy * b]);
  }
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

const ANNOT_HIDDEN = 1 << 1;
const ANNOT_NO_VIEW = 1 << 5;

// The page's annotations whose appearance paints visible text: [{ rect }].
// The test is on the appearance a reader paints (/AP /N, chosen by /AS when it
// is a dict of states), never on /Contents or /V, which say what an
// annotation means, not what it draws.
function textPaintingAnnotations(pdfPage, PDFLib) {
  const { PDFName, PDFArray, PDFDict, PDFStream, PDFNumber } = PDFLib;
  const context = pdfPage.doc.context;
  const annots = pdfPage.node.lookup(PDFName.of('Annots'));
  if (!(annots instanceof PDFArray)) return [];
  const found = [];
  for (const entry of annots.asArray()) {
    const annot = context.lookup(entry);
    if (!(annot instanceof PDFDict)) continue;
    const flags = annot.lookup(PDFName.of('F'));
    if ((flags instanceof PDFNumber ? flags.asNumber() : 0) & (ANNOT_HIDDEN | ANNOT_NO_VIEW)) continue;
    const r = numbersOf(annot.lookup(PDFName.of('Rect')), PDFLib, 4);
    const ap = annot.lookup(PDFName.of('AP'));
    if (!r || !(ap instanceof PDFDict)) continue;
    let n = ap.lookup(PDFName.of('N'));
    if (n instanceof PDFDict && !(n instanceof PDFStream)) {
      const state = annot.lookup(PDFName.of('AS'));
      n = state instanceof PDFName ? n.lookup(state) : null;
    }
    if (!(n instanceof PDFStream)) continue;
    const own = n.dict.lookup(PDFName.of('Resources'));
    let src;
    try { src = readStreamText(n, PDFLib); } catch { continue; }
    const fonts = fontMetricsOfResources(own, context, PDFLib);
    const direct = walkShowOps(src, fonts);
    const nested = formTextRecords(src, fonts, own, [1, 0, 0, 1, 0, 0], PDFLib, context, 0, new Set([n]), []);
    if (!direct.concat(nested).some(paintsText)) continue;
    found.push({ rect: [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])] });
  }
  return found;
}

// For each candidate, true when something the cut cannot reach paints visible
// text inside one of its targets. Never throws: a page whose forms or
// annotations cannot be read answers false for all, i.e. exactly today.
function unreachedByCandidate(pdfPage, PDFLib, candidates) {
  try {
    const context = pdfPage.doc.context;
    const formText = formTextRecords(
      readPageContents(pdfPage, PDFLib), extractFontMetrics(pdfPage, PDFLib),
      pdfPage.node.Resources(), [1, 0, 0, 1, 0, 0], PDFLib, context, 0, new Set(), [],
    ).filter(paintsText);
    const annots = textPaintingAnnotations(pdfPage, PDFLib);
    if (formText.length === 0 && annots.length === 0) return candidates.map(() => false);
    return candidates.map((a) => a.replaceTargets.some((t) => {
      if (formText.some((rec) => insideSpan(rec, t))) return true;
      const [x0, y0, x1, y1] = spanBox(t);
      return annots.some(({ rect }) => rect[0] < x1 && x0 < rect[2] && rect[1] < y1 && y0 < rect[3]);
    }));
  } catch (err) {
    console.warn('[core/page-surgery] painter census failed, edits unchanged:', err);
    return candidates.map(() => false);
  }
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
  // reason}:
  //   'no-match' — nothing cut for at least one of the cover's targets
  //   'residual' — everything matched, AND painted content we declined still
  //                sits inside a span we were asked to clear. We cut, but we
  //                CANNOT claim the target is clear.
  //   'clean'    — everything matched and nothing was left inside.
  //   'unreached' — something the cut cannot reach (a Form XObject, an
  //                annotation's appearance) paints text inside the line, so
  //                the edit declined BEFORE cutting (matched:false). See the
  //                painter census above.
  //
  // WHY 'residual' exists (founder field report 2026-07-28): before it, the
  // only outcomes were 'clean' and 'no-match', so a cut that removed a dash
  // leader and left the actual text standing reported `matched:true,
  // reason:'clean'` — a confident wrong value, the shape this project has been
  // fighting all week (CC memory `plausible-answer-from-unchecked-data`), in
  // the one instrument meant to catch it. `matched:true` only ever meant "a
  // match was found", never "the target's content is gone"; 'residual' is how
  // the difference finally reaches the rail.
  //
  // NOTE this is the TELEMETRY half only. A residual cover is still skipped
  // below (matched === true), so output is byte-identical to before this
  // change — whether a residual cut should KEEP its cover is a visible-pixels
  // decision and is the founder's, not this module's.
  //
  // planRunRemoval's badBts decline surfaces here as matched:false and is
  // reported as 'no-match'. The schema used to carry a separate
  // 'untrustworthy-run' for it, which nothing here could ever emit — deleted
  // 2026-08-09. If that decline is worth telling apart from a plain no-match,
  // this is the function that has to start saying so first.
  const surgeryByCover = new Map();
  const eligible = annotations.filter(
    (a) => a.type === 'whiteout' && a.replaceTargets?.length && a.replaceBox && overlapsBirthBox(a),
  );
  if (eligible.length === 0) return { skipCovers, insertByCover, surgeryByCover };
  const unreached = unreachedByCandidate(pdfPage, PDFLib, eligible);
  eligible.forEach((a, i) => { if (unreached[i]) surgeryByCover.set(a.id, { matched: false, reason: 'unreached' }); });
  // Only the reachable ones are cut: an unreached edit keeps every op of its
  // line, so its cover hides an intact original rather than a half-cut one.
  const candidates = eligible.filter((_, i) => !unreached[i]);
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
      // Summed across the cover's targets, not any-of: two targets each leaving
      // one run behind is worse than one, and the count is the only thing that
      // can later tell "a stray footnote marker" from "half the line survived".
      const residual = slice.reduce((n, r) => n + (r.residual || 0), 0);
      let reason;
      if (!matched) reason = 'no-match';
      else if (residual > 0) reason = 'residual';
      else reason = 'clean';
      surgeryByCover.set(a.id, { matched, reason });
      if (matched) {
        skipCovers.add(a.id);
        // The line always STARTS at its first target — the honest entry
        // point for where replacement text should paint, on a multi-target
        // line (js/v2/app.js's smartReplace now sends one target PER
        // constituent run — founder field report 2026-07-28, the dash-leader
        // form-row defect: a merged single target picked its size from the
        // widest run and silently mismatched the rest).
        //
        // mixedFonts must be recomputed ACROSS every target here, not just
        // trusted from slice[0]'s own per-target value: text-walk.js's
        // planRunRemoval only ever compares fontNames WITHIN one target's own
        // matched ops, so a genuinely mixed-font line (e.g. a bold heading
        // fragment + a regular body fragment text-lines.js clusters into one
        // Line — see text-lines.test.mjs's "dominant style" case) now reports
        // mixedFonts:false on EVERY one of its single-run targets even though
        // the LINE as a whole mixes fonts. Missing this would make stamp.js
        // silently stamp the whole replacement in whichever run happened to
        // be first — a confident wrong font, the same defect CLASS this fix
        // exists to remove (see plausible-answer-from-unchecked-data in the
        // seat's memory). Aggregating here is what keeps the "decline native
        // stamp on a genuinely mixed-font line" guarantee true after
        // switching to per-run targets.
        const first = slice[0].insert;
        const mixedAcrossTargets = slice.some((r) => r.insert.fontName !== first.fontName);
        insertByCover.set(a.id, mixedAcrossTargets ? { ...first, mixedFonts: true } : first);
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
      // RUNG D: a whole-paragraph edit carries its painted lines on `block`.
      // The font is resolved (and the decision re-verified) over the lines
      // joined — the same characters, minus breaks, so the stamp's single-line
      // `multiline` guard is not what decides a paragraph — then every line
      // is stamped at its own baseline (core/block-edit.js placeBlockLines).
      const isBlock = !!(anno.block && Array.isArray(anno.block.lines) && anno.block.lines.length);
      const text = isBlock ? blockText(anno.block) : (anno.text ?? '');
      // styleSource (spec-edit-fidelity-instrumentation.md Increment B):
      // riding on the annotation since js/v2/doc-font-live.js's prepareDocFont is the
      // ONLY place that ever decides it (draft.styleSource -> the committed
      // text annotation's own field) — stamp.js never re-derives style, only
      // echoes this through for the `insert` telemetry event.
      const style = { bold: !!anno.bold, italic: !!anno.italic, styleSource: anno.styleSource || 'none' };
      // fontDecision (core/line-font.js): the ONE font the editor showed while
      // the user typed. The stamp follows it and re-verifies it; null for an
      // edit committed before its fonts loaded (old ladder, as before).
      const resolved = await resolveStampFont(pdfPage, PDFLib, fontkit, insert, text, style, anno.fontDecision || null);
      const styleSource = resolved.styleSource || 'none';
      const glyphShortfall = glyphShortfallBucket(resolved.glyphShortfall);
      // decision/decided_live are ADDITIVE (B8): path/reason keep their
      // meaning; `decision` adds the substitute rung `path` cannot name, and
      // decided_live says whether the editor's choice is what got baked.
      const decisionProps = { decision: resolved.decision || 'none', decided_live: !!resolved.decidedLive };
      // block_lines/reflowed: OPTIONAL `insert` props (telemetry-schema.js
      // OPTIONAL_PROPS), present only for a paragraph edit.
      if (isBlock) Object.assign(decisionProps, { block_lines: anno.block.lines.length, reflowed: !!anno.block.reflowed });
      if (resolved.ok) {
        if (isBlock) stampBlock(pdfPage, PDFLib, resolved.font, anno.block, anno.color);
        else stampText(pdfPage, PDFLib, resolved.font, insert, text, anno.color);
        skipDraw.add(anno.id);
        insertOutcomes.set(anno.id, {
          path: resolved.path, reason: 'clean', style_source: styleSource, glyph_shortfall: glyphShortfall,
          ...decisionProps,
        });
      } else {
        insertOutcomes.set(anno.id, {
          path: 'twin', reason: resolved.reason, style_source: styleSource, glyph_shortfall: glyphShortfall,
          ...decisionProps,
        });
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
    // The line's font decision changes what the stamp embeds, so a changed
    // decision with identical text MUST re-bake (B1).
    fontDecision: replacement?.fontDecision ?? null,
    // RUNG D: a paragraph's painted line breaks are what the stamp draws; the
    // same words broken differently must re-bake.
    block: replacement?.block ?? null,
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
  // Same rotation handling as buildPdfBytes' own copyPages path, exactly —
  // and that is load-bearing here, not merely tidy: core/import.js's
  // rasterizer treats an EDITED page's baked bytes as authoritative and reads
  // their /Rotate straight back, where a plain page is rendered at
  // baseRotation + rotation. So if these two disagree, an edited page and an
  // unedited page of the SAME document face different ways ON SCREEN.
  //
  // Until 2026-08-09 this was `if (page.rotation) setRotation(page.rotation)`,
  // which is ABSOLUTE and discarded the source's inherited /Rotate — see
  // core/page-rotation.js for the whole story.
  const totalRotation = totalPageRotation(page);
  if (totalRotation !== pdfPage.getRotation().angle) {
    pdfPage.setRotation(PDFLib.degrees(totalRotation));
  }

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
