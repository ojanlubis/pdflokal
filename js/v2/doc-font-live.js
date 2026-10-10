/*
 * PDFLokal — v2/doc-font-live.js  (EDIT TYPES IN THE DOCUMENT'S OWN FONT, LIVE)
 * ============================================================================
 * Moved out of js/v2/app.js (2026-10-10), behaviour unchanged. Rung C's live
 * doc-font preview: when Edit opens on a printed line, load the SAME font
 * program the stamp will embed (the document's own subset, a metric clone, a
 * substitute) into the browser via the FontFace API, decide ONE face for the
 * line (js/v2/line-font-live.js), and restyle the open draft in place.
 *
 * Owns the per-document font caches (reset() on Buka Baru: every FontFace it
 * registered belongs to the document being closed).
 *
 * deps (getters, never captured values: Buka Baru replaces the doc):
 *   getDoc()
 *   getDryRunDoc(PDFLib, source)   js/v2/edit-bake.js's cached dry-run pdf-lib doc
 *   tel(event, props)              app.js's OWN tel wrapper (see edit-bake.js)
 *   toast(msg)
 */
import { getPage, getSource } from '../core/model.js';
import { ensurePdfLib } from '../core/vendor.js';
import { extractFontProgram, lookupFontObject } from '../core/doc-fonts.js';
import { resolveFontFingerprint, docFontFaceDescriptors, FAMILY_BUCKET_TO_CLONE, isInformativeBaseFont } from '../core/font-fingerprint.js';
import { cloneFamilyFor } from '../core/font-decide.js';
import { faceLadder } from '../core/line-font.js';
import { nativeCandidate } from '../core/stamp.js';
import { dominantLineFont } from '../core/redact.js';
import { applyTextFont } from '../render/page-view.js';
import { loadFaceFont, startLineFont, refusalNote } from './line-font-live.js';

// A resource font name can carry PDF name-escape bytes (#xx) or characters
// invalid in a CSS custom ident — collapse to a safe, still-unique token.
function sanitizeForCssIdent(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function createDocFontLive({ getDoc, getDryRunDoc, tel, toast }) {
  // Outcome cache, keyed by sourceId + RESOURCE font name (not by line — many
  // lines on a page share one font resource): { cssFamily, fontkitFont } once
  // the FontFace has actually loaded, or null once we've tried and it failed
  // (missing program / FontFace refused the bytes / standard-14 with nothing to
  // load) — null is remembered so a failed font isn't re-attempted on every tap.
  const docFontCache = new Map(); // `${sourceId}:${fontName}` -> Promise<{cssFamily, fontkitFont}|null>
  const addedFontFaces = new Set(); // live FontFace objects on document.fonts — swept on Buka Baru

  // Load (or reuse) the doc font for one resource font name on one source.
  // Returns null on ANY decline (never throws into the caller) — extraction
  // failure, fontkit parse failure, or the FontFace API itself refusing the
  // bytes are all the same honest "no live preview for this line", the twin
  // stays exactly as it already was.
  function loadDocFont(sourceId, fontName, pdfPage, PDFLib, fontkit, facts) {
    const key = `${sourceId}:${fontName}`;
    if (!docFontCache.has(key)) {
      docFontCache.set(key, (async () => {
        let extracted;
        try {
          extracted = extractFontProgram(pdfPage, PDFLib, fontName);
        } catch {
          return null;
        }
        if (!extracted.ok) return null;
        let fontkitFont;
        try {
          fontkitFont = fontkit.create(extracted.bytes);
        } catch {
          return null; // decline, never guess — same law as stamp.js's resolveStampFont
        }
        // Font shape, for font_seen telemetry's FLAVOR enum (spec-telemetry.md
        // §3) — the doc-subset ladder rung itself is shape-agnostic (fontkit
        // reads any program by codepoint); this is purely a reporting signal.
        let flavor = 'other';
        try {
          const { PDFName, PDFRef } = PDFLib;
          const fontObj = lookupFontObject(pdfPage, PDFLib, fontName);
          const stRaw = fontObj && fontObj.get(PDFName.of('Subtype'));
          const st = stRaw instanceof PDFRef ? pdfPage.doc.context.lookup(stRaw) : stRaw;
          if (st instanceof PDFName) flavor = st.toString() === '/Type0' ? 'type0' : st.toString() === '/TrueType' ? 'truetype' : 'other';
        } catch { /* flavor stays 'other' — telemetry just reports 'other' */ }
        const cssFamily = `pdflokal-doc-${sanitizeForCssIdent(sourceId)}-${sanitizeForCssIdent(fontName)}`;
        let face;
        try {
          // Descriptors from the font's own facts, or a bold program is faux-bolded
          // again by CSS font-weight:700 (see core/font-fingerprint.js).
          face = new FontFace(cssFamily, extracted.bytes, docFontFaceDescriptors(facts));
          await face.load();
        } catch (_err) {
          // Some CFF shapes need an explicit sfnt/OpenType wrap the FontFace
          // constructor won't infer from raw bytes alone — decline rather than
          // throw; the twin (already showing) is the honest fallback.
          return null;
        }
        document.fonts.add(face);
        addedFontFaces.add(face);
        // bytes ride along for core/stamp.js's nativeCandidate gates (sfnt +
        // save-time readiness) — the editor may only offer the doc font if the
        // stamp would embed these exact bytes.
        // bold/italic: the descriptors this FontFace was REGISTERED with, so a
        // decided line can ask CSS for exactly that face (render/page-view.js).
        const descriptors = docFontFaceDescriptors(facts);
        return {
          cssFamily, fontkitFont, flavor, bytes: extracted.bytes,
          bold: descriptors.weight === '700', italic: descriptors.style === 'italic',
        };
      })().catch(() => null));
    }
    return docFontCache.get(key);
  }

  // Fire-and-forget from smartReplace: never blocks the editor opening (the
  // twin shows immediately, same as before this feature existed). `draft` is
  // the SAME object handed to openTextEditor — mutated in place once the doc
  // font lands, so the commit path (reading draft fields at blur/Enter time)
  // picks it up for free if it arrives before the user finishes typing.
  //
  // ONE FONT PER LINE (2026-10-01, the founder's edit principle): this used to
  // end by PREPENDING the doc font to the twin's CSS stack, so a char the doc
  // subset lacked painted in the twin — one letter in another font while
  // typing, then the whole line in the clone after the bake. Now it loads every
  // candidate (doc font, clone, substitute) from the bytes the stamp embeds and
  // hands them to js/v2/line-font-live.js, which renders ONE face per decision.
  //
  // `seed` is a committed edit's stored fontDecision (re-edit): the line's
  // resource key and its bundled faces come from it instead of being re-derived.
  async function prepareDocFont(pageId, line, draft, seed = null) {
    try {
      const doc = getDoc();
      const page = getPage(doc, pageId);
      const source = page && getSource(doc, page.sourceId);
      if (!source) return;
      const { PDFLib, fontkit } = await ensurePdfLib();
      const srcDoc = await getDryRunDoc(PDFLib, source);
      const pdfPage = srcDoc.getPages()[page.sourcePageNum];
      if (!pdfPage) return;
      let fontName = null;
      let mixedFonts = false;
      if (seed) {
        // RE-EDIT, seeded from the stored decision. Before 2026-10-01 a re-edit
        // re-ran the dry run below on cover.replaceTargets[0] alone — on a
        // multi-run line that is the first-painted run, not the dominant one,
        // so a re-edit could load a different font than the edit was made in.
        fontName = seed.lineKey ?? seed.ladder?.find((c) => c.path === 'native')?.key ?? null;
      } else {
        ({ fontName, mixedFonts } = dominantLineFont(pdfPage, PDFLib, line));
      }
      // An unmatched line has no font of its own to learn — it still gets a
      // decision (the default substitute below), never the twin's stack.
      const fp = fontName
        ? resolveFontFingerprint(pdfPage, PDFLib, fontkit, fontName)
        : { ok: false };

      // BUG FIX (founder field test, 2026-07-19, bold Arial headings): pdf.js's
      // OWN getTextContent() never exposes the real font name to the main
      // thread — text-runs.js's `fontFamily` is pdf.js's generic CSS collapse
      // ('serif'/'sans-serif'/'monospace'), not the ascii PostScript name (see
      // js/core/font-style.js's header for how this was verified against the
      // vendored pdf.worker.min.js). The document's own /Font resource dict
      // has the real name — read INDEPENDENTLY of whether the font PROGRAM
      // below loads: a bold heading whose program we decline to extract (e.g.
      // a simple TrueType font outside loadDocFont's Type0/Identity-H scope)
      // still has a /BaseFont worth parsing for "Bold"/"Italic".
      //
      // spec-edit-fidelity-instrumentation.md Increment A (founder phone-gate,
      // org-structure.pdf's "T & PPGA" -> thin, 2026-07-23): resolveFontFingerprint
      // is the FULL ladder — rung 1 (font-style.js's /BaseFont+Flags read,
      // exactly what used to happen here) first, then rung 2 (the EMBEDDED
      // PROGRAM's own name table/OS-2/PANOSE, core/font-fingerprint.js) only
      // when rung 1 is genuinely uninformative (an 'CIDFont+F1'-shaped wrapper
      // name with no corroborating Flags/FontWeight) — never guessing "regular"
      // just because the WRAPPER stayed silent.
      if (fp.ok && !mixedFonts && (fp.bold || fp.italic)) {
        draft.bold = draft.bold || fp.bold;
        draft.italic = draft.italic || fp.italic;
        // Live-restyle the open draft the same way docFontFamily does below —
        // the twin font stays, only weight/style changes, so this is safe to
        // apply even if the doc-font FontFace load (next) ultimately declines.
        if (draft.editorEl && draft.editorEl.isConnected) applyTextFont(draft.editorEl, draft);
      }
      if (fp.ok) {
        // styleSource rides the draft -> the committed text annotation's own
        // field (see commit() below) so stamp.js's clone rung can report WHICH
        // rung decided the weight it embeds, at commit time, without ever
        // re-deriving it (Increment B's `insert.style_source`).
        //
        // On a mixed-font line we declined to decide a weight, so the honest
        // value is 'none' — NOT the rung that would have decided it. 'none' is
        // already in the schema's STYLE_SOURCE enum, so this needs no schema
        // change and no migration, and from the first event the rail can tell
        // "we read bold off the /BaseFont" apart from "we declined to guess".
        // That distinction is also the only way we will ever learn how common
        // mixed lines actually are in real documents — nothing measures it today.
        draft.styleSource = mixedFonts ? 'none' : fp.styleSource;
      }
      // Font-fidelity tier 1 (core/font-decide.js, founder-ratified 2026-07-20):
      // the real /BaseFont routes the SUBSTITUTE tier to a metric-identical
      // clone (Calibri→Carlito, Arial→Arimo, …) instead of mapRunFont's generic
      // bucket — same widths by construction, so the replacement occupies
      // exactly the original's space. Applied to the draft (and live-restyled)
      // BEFORE the doc-font load below: if that load succeeds, the doc font
      // still renders in front and this clone is the per-glyph fallback; if it
      // declines, the clone IS the committed family. Honesty unchanged: a clone
      // is still a substitute — the commit toast keeps firing (one grammar).
      if (fp.ok) {
        // Exact name routing stays FIRST (stronger signal than any
        // measurement) — tried against the WRAPPER's /BaseFont, same as
        // before. Increment A's "twin selection" ruling: when that declines,
        // fall to the fingerprint's own MEASURED family bucket (serif->Tinos,
        // mono->Cousine, sans->Arimo) instead of leaving the draft on
        // mapRunFont's generic Helvetica guess — a real bundled font with real
        // outlines beats a standard-14 name with none. This bucket fallback
        // NEVER sets cloneRouted (below) — only an EXACT name match earns the
        // silent name-only carve-out (founder ruling 2026-07-20), a measured
        // bucket is still an honest substitute worth the commit toast.
        const clone = cloneFamilyFor(fp.baseFont) || FAMILY_BUCKET_TO_CLONE[fp.family] || null;
        if (clone) {
          draft.fontFamily = clone;
          if (draft.editorEl && draft.editorEl.isConnected) applyTextFont(draft.editorEl, draft);
        }
        // Name-only ruling (founder, 2026-07-20 evening — the e-AHU case): a
        // font that provably embeds NO program has no outlines of its own —
        // every viewer already substitutes for it. When the exact-match clone
        // fired on top of that, the commit stays SILENT: a notice would compare
        // our substitute against an original that never existed. Both facts
        // ride the draft so commit() can apply the ruling without re-reading
        // the PDF. Absent fields (async race lost) → conservative toast, same
        // as every other race here.
        draft.fontUnembedded = !fp.embedded;
        draft.cloneRouted = !!cloneFamilyFor(fp.baseFont);
      }

      // The line's bundled faces (clone by name, substitute by evidence), loading
      // in parallel with the doc font — from the stored ladder on a re-edit.
      const faces = seed?.ladder
        ? seed.ladder.filter((c) => c.path === 'clone' || c.path === 'substitute')
        : faceLadder(fp.ok ? fp : null);
      const facesLoading = Promise.all(faces.map((f) => loadFaceFont(f.face, fontkit)
        .then((r) => (r ? {
          path: f.path, face: f.face, evidence: f.evidence, css: r.css, parsed: r.parsed, bold: r.bold, italic: r.italic,
        } : null))));

      const result = fontName ? await loadDocFont(page.sourceId, fontName, pdfPage, PDFLib, fontkit, fp) : null;
      // font_seen (spec-telemetry.md §3, widened spec-edit-fidelity-
      // instrumentation.md Increment B): the doc font we tried to load for this
      // edit, PLUS the font-fact fields the fingerprint ladder above already
      // computed — content-blind (enums/bools), never the font's own name.
      // flavor maps loadDocFont's own shape read to the schema's FLAVOR list;
      // extract is 'ok' when the FontFace loaded, else 'declined'. NOTE: on a
      // decline the flavor isn't recomputed here (loadDocFont only returns it
      // on success) — collapsed to 'other', a conscious v1 simplification (the
      // primary signal is the ok-rate + the flavor of docs that DO load). A
      // finer failed/declined split is an easy follow-up if the data warrants it.
      if (fontName) {
        tel('font_seen', {
          flavor: result?.flavor === 'type0' ? 'type0-identity-h'
            : result?.flavor === 'truetype' ? 'truetype-simple' : 'other',
          extract: result ? 'ok' : 'declined',
          embedded: fp.ok ? fp.embedded : false,
          subtype: fp.ok ? fp.subtype : 'other',
          name_informative: fp.ok ? isInformativeBaseFont(fp.baseFont) : false,
          bold: fp.ok ? fp.bold : false,
          style_source: fp.ok ? fp.styleSource : 'none',
        });
      }
      if (result) {
        draft.docFontFamily = result.cssFamily;
        draft.docFontkitFont = result.fontkitFont; // commit-time coverage check (see commit())
      }
      // The doc font is a candidate only behind the stamp's OWN embed gates —
      // offering one the stamp would refuse is seeing ≠ file again.
      const native = result
        ? nativeCandidate({ parsed: result.fontkitFont, bytes: result.bytes, key: fontName, css: result.cssFamily })
        : null;
      if (native) Object.assign(native, { bold: result.bold, italic: result.italic });
      const faceCandidates = await facesLoading;
      // Guard: the draft may have been cancelled/committed already, or a NEWER
      // tap may have replaced it — startLineFont declines a detached editor.
      draft.lineFont = startLineFont({
        draft,
        candidates: [native, ...faceCandidates],
        lineKey: fontName,
        onRefuse: (ch) => toast(refusalNote(ch)),
        // Rung D: a paragraph editor re-seats its first baseline on every face.
        onShow: () => draft.onFontShown?.(),
      });
    } catch (err) {
      console.warn('prepareDocFont gagal:', err);
    } finally {
      // WHY this exists: prepareDocFont is fire-and-forget, and until now it had
      // NO observable completion — which is precisely why the 2026-07-23 defect
      // (an unawaited call baking thin on a lost race, decisions.md) was so hard
      // to pin. A test could only budget a timeout and hope.
      //
      // This flag says "finished DECIDING", never "decided bold" — deliberately,
      // so it stays true under any styling policy (apply / decline / defer) and
      // a test waiting on it can't pass or hang because the policy changed. Set
      // in `finally` so every early return and every throw still resolves it;
      // a signal that only fires on the happy path is the kind of green that
      // can't go red.
      if (draft?.editorEl?.isConnected) {
        // A paragraph editor's face may have changed above without a decision
        // (no candidate loaded): re-seat its baseline on whatever it paints now.
        draft.onFontShown?.();
        draft.editorEl.dataset.stylePrepared = '1';
      }
    }
  }

  return {
    prepareDocFont,
    reset() {
      docFontCache.clear();
      for (const face of addedFontFaces) document.fonts.delete(face);
      addedFontFaces.clear();
    },
  };
}
