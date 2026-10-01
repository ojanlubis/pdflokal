/*
 * PDFLokal — v2/edited-page-provider.js  (the rasterizer's door onto committed edits)
 * ============================================================================
 * MOVED out of js/v2/app.js (2026-10-01) so the one behaviour the seat ruled on
 * that day — a bake that throws must SAY so — can be driven by a test against
 * the real provider instead of a source scan. The body is unchanged apart from
 * the catch's report; app.js injects what used to be module globals.
 *
 * spec-live-surgery.md increment 2 (§3/§4/§8.2): the rasterizer's injected
 * boundary onto a page's committed edits, WITHOUT core/import.js ever
 * importing this v2 app module. Reuses the SAME dry-run pdf-lib doc
 * smartReplace/prepareDocFont already cache per source — copyPages only READS
 * srcDoc (buildPdfBytes' own srcDocCache already shares one load across every
 * page of a source the same way), so handing the throwaway dry-run doc to
 * buildEditedPageBytes is safe even though it was originally named for a
 * different caller.
 *
 * This provider answers "what should this page's background be, right now"
 * whenever createPageRasterizer asks (first render, zoom change, viewport
 * re-entry, and the commit's own rebakePage). Any failure — missing source, no
 * PDFLib/fontkit, buildEditedPageBytes throwing — returns null so the
 * rasterizer falls back to the plain source render; a broken edited-page build
 * must never break rasterization. Since 2026-10-01 that fallback is no longer
 * silent: `onBakeFailure(err, page)` is told, and app.js reports it (see
 * js/v2/bake-failure.js for what is sent and why).
 */
import { buildEditedPageBytes, editSignature } from '../core/page-surgery.js';

export function createEditedPageProvider({
  getSource, loadPdfLib, getSrcDoc, onBakeFailure = () => {}, build = buildEditedPageBytes,
}) {
  return async function editedPageProvider(page) {
    try {
      if (!editSignature(page)) { page.editApplied = null; return null; } // no committed edits — today's path
      const source = getSource(page.sourceId);
      if (!source) { page.editApplied = null; return null; }
      const { PDFLib, fontkit } = await loadPdfLib();
      const srcDoc = await getSrcDoc(PDFLib, source);
      const result = await build(srcDoc, page, page.annotations, { PDFLib, fontkit });
      // Increment 3 (spec-live-surgery.md §5/§8.3): stash exactly which cover/
      // text annotation ids THIS bake consumed, directly on the page (the same
      // render-layer-cache pattern as page.raster — see page-view.js's header
      // comment). js/render/page-view.js's overlay builder reads this to skip
      // drawing a SUCCESSFUL edit's cover/text as a DOM overlay (Decision 1) —
      // reading it straight off buildEditedPageBytes' own `applied` set means
      // the overlay can never independently disagree with what the raster
      // actually shows. A declined edit's ids are simply absent from this set,
      // so its cover (and, if native-insert alone declined, its twin text)
      // keep rendering exactly as before (Decision 2).
      page.editApplied = result.bytes ? result.applied : new Set();
      // Stash the per-edit telemetry outcomes on the page (same render-cache
      // pattern as editApplied) so commit()'s rebake can fire the surgery/insert
      // events for the edit it just committed. A SUCCESSFUL bake never fires
      // telemetry from here — this provider also runs on plain zoom/viewport
      // re-renders. Data here; the firing is gated to the commit path in commit().
      page.editOutcomes = result.outcomes || [];
      return result.bytes ? { bytes: result.bytes } : null;
    } catch (err) {
      // THE ONE EXCEPTION to "no telemetry from the provider": a FAILED bake.
      // commit() cannot see it — it reads page.editOutcomes, which is null here,
      // and simply fires nothing, which is exactly how 4 sessions lost every
      // download with the rail silent until export. onBakeFailure dedupes per
      // edit signature, so a re-render of the same broken state is one report.
      // State first, report second, report GUARDED: the fallback must hold
      // even when the reporter cannot (a malformed page that made the build
      // throw can make the reporter's own key computation throw too).
      page.editApplied = null;
      page.editOutcomes = null;
      try { onBakeFailure(err, page); } catch { /* reporting never breaks the fallback */ }
      return null;
    }
  };
}
