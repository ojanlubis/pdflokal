/*
 * PDFLokal — v2/app.js  (EDITOR V2 SHELL — the clean rebuild)
 * ============================================================================
 * The application layer: owns the Doc, the history, the tool state, and the
 * DOM chrome. All heavy lifting is delegated:
 *   - model + mutations  → js/core/  (headless, tested in Node)
 *   - page views / slots → js/render/page-view.js
 *   - streaming window   → js/render/viewport.js  (phone-validated)
 *   - input              → js/render/interaction.js (one pointer path)
 *   - PDF I/O            → js/core/import.js + js/core/export.js
 *
 * Interaction rules implemented here (product-definition §6):
 *   - tools are verbs; Pilih is home (text/signature return to it after use;
 *     whiteout stays sticky — the honest multi-stamp exception)
 *   - every action reversible; no confirm dialogs
 *   - nothing hover-only; touch targets ≥44px
 */

import { createDoc, createAnnotation, getPage, getSource } from '../core/model.js';
import {
  addAnnotation, removeAnnotation, updateAnnotation, clearSelection, selectAnnotation,
  moveAnnotation,
} from '../core/operations.js';
import { createHistory, record, undo, redo, canUndo, canRedo } from '../core/history.js';
import { importPdf, importImage, createPageRasterizer } from '../core/import.js';
import { createPageSlot, syncOverlay, textFontCss } from '../render/page-view.js';
import { createViewportStream } from '../render/viewport.js';
import { createInteraction } from '../render/interaction.js';
import { createFormatBar } from './format-bar.js';
import { createTextRunIndex, mapRunFont } from './text-runs.js';
import { createPageManager } from './page-manager.js';
import { createSignatureModal } from './signature-modal.js';
import { createDownloadSheet } from './download-sheet.js';
import { track } from '../lib/analytics.js';
import { createCelebration } from './celebrate.js';
import { applyIntentCopy } from './intent-copy.js';
import { ensurePdfLib } from '../core/vendor.js';
import { readPageContents, extractFontMetrics } from '../core/redact.js';
import { planRunRemoval } from '../core/text-walk.js';
import { extractFontProgram } from '../core/reinsert.js';

// WHY there is no `window.pdfjsLib.…workerSrc = …` line here any more: pdf.js is
// loaded on demand now (core/vendor.js), so touching it at module top-level
// would resurrect the very boot-time dependency we removed. The worker path is
// set inside ensurePdfJs(), the instant the lib lands.

// ---- state (ONE doc, ONE history — everything else is DOM or derived) -------
let doc = createDoc(); // replaced wholesale by "Buka Baru" (File menu)
const history = createHistory();
let slots = [];
let rasterizer = null;
let zoom = 1;
let tool = 'select';
let storedSignature = null;   // { dataUrl, width, height } from the sig modal
let baseName = 'dokumen';
let editingAnno = null;       // text annotation currently in the inline editor
let editingEl = null;         // its contenteditable (format bar restyles it live)
let editingIsReplace = false; // Ganti Teks draft open → NO format bar (see below)

const scrollEl = document.getElementById('v2-scroll');
const stage = document.getElementById('v2-stage');
const emptyEl = document.getElementById('empty');
const pill = document.getElementById('v2-pill');
const toastEl = document.getElementById('toast');

// ---- small helpers -----------------------------------------------------------
let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

// ---- processing telegraph ----------------------------------------------------
// WHY: a real user merged 35 files and thought the app had errored — the dropzone
// sat frozen through the whole parse loop with no feedback (contact-form, Jul 2026).
// This overlay covers that surface and shows honest, advancing progress. The 180ms
// delay means instant loads never flash it (feedback without jank). General word
// "Memproses" (not "menjepit") — comprehension of THIS step is the whole point.
// Null-safe: app.js is shared by index.html AND the generated SEO pages. If a page
// ships without the overlay markup (e.g. an SEO page generated before it existed),
// these must degrade to no-ops, NOT crash the whole module at load. (Sentry
// JAVASCRIPT-J: the overlay landed in index.html but the SEO pages weren't
// regenerated, so `.querySelector` on null killed the editor on every SEO page.)
const loadingOverlay = document.getElementById('v2-loading');
const lpFill = loadingOverlay?.querySelector('.lp-fill');
const lpCount = loadingOverlay?.querySelector('.lp-count');
let processingTimer = null;

function showProcessing(total) {
  if (!loadingOverlay) return;
  clearTimeout(processingTimer);
  updateProcessing(0, total);
  processingTimer = setTimeout(() => { loadingOverlay.hidden = false; }, 180);
}
function updateProcessing(done, total) {
  if (!loadingOverlay) return;
  if (total > 1) {
    // Determinate: count = file we're working on now; fill = files finished.
    lpFill.classList.remove('lp-indet');
    lpFill.style.width = Math.round((done / total) * 100) + '%';
    lpCount.textContent = `${Math.min(done + 1, total)} dari ${total} file`;
    lpCount.hidden = false;
  } else {
    // Single file: no honest sub-file count exists — indeterminate bar, no number.
    lpFill.classList.add('lp-indet');
    lpFill.style.width = '';
    lpCount.hidden = true;
  }
}
function hideProcessing() {
  if (!loadingOverlay) return;
  clearTimeout(processingTimer);
  loadingOverlay.hidden = true;
  lpFill.style.width = '0';
  lpFill.classList.remove('lp-indet');
}

function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  // The chokepoint every export path funnels through — celebrate here, AFTER
  // the save was triggered. (Wave 5: reward the "I got my file" moment.)
  celebration.onDownloadSuccess();
}
const celebration = createCelebration({ toast });

// ---- zoom ---------------------------------------------------------------------
// transform:scale + a sizer that carries the scaled layout size. NOT CSS zoom:
// zoom's coordinate reporting was quirky pre-Chrome-128, and old Androids are
// exactly who we build for. gBCR under transform returns visual coords on every
// engine ever — which is what interaction.js divides by zoom.
const sizer = document.getElementById('v2-sizer');
function applyZoom() {
  stage.style.transform = `scale(${zoom})`;
  // offsetWidth/Height are layout (pre-transform) sizes — scale them ourselves.
  sizer.style.width = Math.ceil(stage.offsetWidth * zoom) + 'px';
  sizer.style.height = Math.ceil(stage.offsetHeight * zoom) + 'px';
  stream.refresh(0);
}
document.getElementById('z-in').onclick = () => { zoom = Math.min(zoom + 0.25, 3); applyZoom(); };
document.getElementById('z-out').onclick = () => { zoom = Math.max(zoom - 0.25, 0.3); applyZoom(); };

// ---- camera: pinch-zoom + pan (the Google-Maps feel, founder ask) ----------------
// One-finger pan = NATIVE container scroll (overflow auto on both axes — free,
// smooth, momentum included). Two fingers = our pinch: preventDefault on the
// 2-touch touchstart keeps the browser from claiming the gesture, zoom anchors
// on the pinch midpoint so the paper under your fingers stays put.
function setZoomAnchored(next, midX, midY) {
  const clamped = Math.min(3, Math.max(0.3, next));
  if (clamped === zoom) return;
  const rect = scrollEl.getBoundingClientRect();
  const mx = midX - rect.left;
  const my = midY - rect.top;
  // Content point under the midpoint, rescaled to the new zoom.
  const cx = (scrollEl.scrollLeft + mx) * (clamped / zoom);
  const cy = (scrollEl.scrollTop + my) * (clamped / zoom);
  zoom = clamped;
  applyZoom();
  scrollEl.scrollLeft = cx - mx;
  scrollEl.scrollTop = cy - my;
}

let pinch = null;
let pinchRaf = false;
scrollEl.addEventListener('touchstart', (e) => {
  if (e.touches.length === 2) {
    e.preventDefault(); // ours, not the browser's
    // A finger that landed on a selected object may have started a drag —
    // abort it and put the object back. Pinching must never fling things.
    interaction.cancelGesture();
    const [a, b] = e.touches;
    pinch = { d0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1, z0: zoom };
  }
}, { passive: false });
scrollEl.addEventListener('touchmove', (e) => {
  if (!pinch || e.touches.length !== 2) return;
  e.preventDefault();
  if (pinchRaf) return; // rAF-throttle: refresh loops slots, keep it 1×/frame
  pinchRaf = true;
  const [a, b] = e.touches;
  const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const midX = (a.clientX + b.clientX) / 2;
  const midY = (a.clientY + b.clientY) / 2;
  requestAnimationFrame(() => {
    pinchRaf = false;
    if (pinch) setZoomAnchored(pinch.z0 * (d / pinch.d0), midX, midY);
  });
}, { passive: false });
const endPinch = (e) => { if (e.touches.length < 2) pinch = null; };
scrollEl.addEventListener('touchend', endPinch);
scrollEl.addEventListener('touchcancel', endPinch);

// Desktop: trackpad pinch arrives as ctrl+wheel; cmd+wheel for mouse users.
scrollEl.addEventListener('wheel', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  setZoomAnchored(zoom * (e.deltaY < 0 ? 1.1 : 0.9), e.clientX, e.clientY);
}, { passive: false });

// ---- streaming viewport --------------------------------------------------------
let pillTimer = null;
const stream = createViewportStream({
  scrollEl,
  slots: () => slots,
  rasterize: (page) => rasterizer.rasterize(page, { scale: 2 }),
  onPosition: (current, total) => {
    pill.textContent = `${current} / ${total}`;
    pill.classList.add('show');
    clearTimeout(pillTimer);
    pillTimer = setTimeout(() => pill.classList.remove('show'), 750);
  },
});
stream.attach();

// ---- stage sync ----------------------------------------------------------------
// Full rebuild from the model. Cheap in practice: rasters ride on page objects
// (shared through history snapshots), so undo/redo re-shows pages instantly —
// no PDF.js work. Per-gesture hot paths never come through here.
function rebuildStage() {
  stage.innerHTML = ''; // detaches gantiGlowEl too — drop the stale reference
  clearGantiGlow();
  slots = doc.pages.map((page, i) => {
    const slot = createPageSlot(page, {
      activeId: doc.selection.annotationId,
      label: `Hal ${i + 1}`,
    });
    stage.appendChild(slot.view);
    return slot;
  });
  interaction.refreshSelection();
  refreshChrome();
  applyZoom(); // stage layout size changed → re-size the sizer (also refreshes)
}

// Re-render one page's overlay after a structural annotation change.
function syncPage(pageId) {
  const slot = slots.find((s) => s.page.id === pageId);
  // syncOverlay does overlay.innerHTML = '' — that would silently detach
  // gantiGlowEl if it happened to be riding THIS page's overlay; drop the
  // reference rather than leave it dangling (see rebuildStage).
  if (gantiGlowEl && slot?.view.contains(gantiGlowEl)) clearGantiGlow();
  if (slot) syncOverlay(slot.page, slot.view, { activeId: doc.selection.annotationId });
  interaction.refreshSelection();
  refreshChrome();
}

function refreshChrome() {
  document.getElementById('btn-undo').disabled = !canUndo(history);
  document.getElementById('btn-redo').disabled = !canRedo(history);
  document.getElementById('btn-download').disabled = doc.pages.length === 0;
  document.getElementById('btn-pages').disabled = doc.pages.length === 0;
  document.getElementById('btn-file').disabled = doc.pages.length === 0;
  // Hapus stays enabled with pages: no selection = arms delete-mode.
  document.getElementById('btn-delete-anno').disabled = doc.pages.length === 0;
  syncFormatBar();
  syncSigBar();
}

// ---- format bar ----------------------------------------------------------------
// Visible whenever text is in play: selected text anno, inline editing, or the
// Teks tool armed. Sticky defaults feed new annotations.
function selectedTextAnno() {
  const id = doc.selection.annotationId;
  if (!id) return null;
  for (const page of doc.pages) {
    const a = page.annotations.find((x) => x.id === id);
    if (a) return a.type === 'text' ? a : null;
  }
  return null;
}

const formatBar = createFormatBar({
  el: document.getElementById('format-bar'),
  getDoc: () => doc,
  history,
  getTarget: () => editingAnno || selectedTextAnno(),
  onStyled: (anno) => {
    // Restyle the open inline editor live; re-render the committed element.
    if (editingEl && editingAnno && anno.id === editingAnno.id) {
      editingEl.style.font = textFontCss(anno);
      editingEl.style.color = anno.color || '#000';
    }
    for (const page of doc.pages) {
      if (page.annotations.some((a) => a.id === anno.id)) { syncPage(page.id); break; }
    }
  },
  onDefaults: (d) => {
    // Un-committed draft (new text, no annotation yet): restyle the editor live.
    if (editingEl && !editingAnno) {
      editingEl.style.font = textFontCss(d);
      editingEl.style.color = d.color || '#000';
    }
  },
});

function syncFormatBar() {
  // FOUNDER RULING (2026-07-18, banked in ojan-ui-taste): editing ≠ redefining.
  // A Ganti Teks draft's contract is IDENTITY with the printed original —
  // offering font/color pickers there misreads the intent ("they want to edit,
  // not redefine the text"). Fidelity is the machine's job (sampling, Rung C
  // font matching), never a decision pushed to the user. The bar returns for
  // authoring flows and for a committed text object selected afterwards.
  const editing = (editingAnno || editingEl) && !editingIsReplace;
  formatBar.sync(!!(editing || (!editingIsReplace && selectedTextAnno()) || tool === 'text'));
}

// ---- tools ----------------------------------------------------------------------
function setTool(next) {
  tool = next;
  // The steering highlight belongs to the 'ganti' tool only — leaving it lit
  // after a tool switch (e.g. Escape, or the on-off toggle) would show a
  // commit target for a gesture that no longer exists.
  if (next !== 'ganti') clearGantiGlow();
  if (next !== 'signature') {
    const g = document.getElementById('sig-ghost');
    if (g) g.style.display = 'none';
  }
  for (const btn of document.querySelectorAll('#toolbar .tool[data-tool]')) {
    const active = btn.dataset.tool === next;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  }
  // Delete-mode is armed via #btn-delete-anno (no data-tool: its tap can also
  // mean "delete the selection"). Armed = lit, same grammar as every tool.
  document.getElementById('btn-delete-anno').classList.toggle('active', next === 'delete');
  // While a placement tool is active the page must not pan under the finger.
  stage.style.touchAction = next === 'select' ? '' : 'none';
  syncFormatBar();
  syncSigBar();
}
for (const btn of document.querySelectorAll('#toolbar .tool[data-tool]')) {
  btn.addEventListener('click', () => {
    const t = btn.dataset.tool;
    // FOUNDER RULING (2026-07-19, banked in ojan-ui-taste): a lit tool button
    // is an ON-OFF switch — tapping it again disarms back to neutral. This is
    // also the ONLY touch-side escape from an armed tool (Escape is keyboard).
    if (tool === t) { setTool('select'); return; }
    if (t === 'signature' && !storedSignature) { signatureModal.open(); return; }
    setTool(t);
    if (t === 'text') toast('Pilih tempat untuk menulis');
    if (t === 'whiteout') toast('Seret di halaman untuk menutup teks');
    if (t === 'signature') toast('Pilih tempat untuk menempatkan tanda tangan');
    if (t === 'ganti') toast('Tap tulisan yang mau kamu ganti');
  });
}

// ---- Ganti Teks (Edit Teks Asli, Rung A — seat spec-edit-teks-asli.md) -----------
// Tap a PRINTED run → cover it with a color-matched Tip-Ex + reopen the same
// words as an editable text object, pre-selected so typing replaces. One
// gesture, ONE undo step (recorded here; the editor commit skips its own).
const textRuns = createTextRunIndex({ getDoc: () => doc });

// ---- Rung C — live doc-font preview (founder ruling, tonight 2026-07-19) ---------
// core/export.js already writes the FINAL file with the document's own
// embedded font when coverage allows it (core/reinsert.js) — but until now the
// EDITOR only ever showed the twin CSS font while typing/after commit, so
// "what you see" and "what you get" visibly diverged for exactly the window
// between tap and download. This loads the SAME font program into the browser
// via the FontFace API so the draft (and the committed annotation, until
// export) render in the document's real font live. The twin stays right
// behind it in the CSS font stack as the honest per-glyph fallback: if a
// later-typed char isn't in the doc font, the browser's own fallback to the
// twin IS the preview of exactly what export's coverage check will do.

// pdf-lib load of a SOURCE's bytes, cached per sourceId — a throwaway dry-run
// doc, never mutated or saved, shared across every line tapped on that source
// so re-tapping the same page doesn't re-parse the PDF each time.
const pdfLibDocCache = new Map(); // sourceId -> Promise<PDFLib PDFDocument>
function getDryRunDoc(PDFLib, source) {
  if (!pdfLibDocCache.has(source.id)) {
    pdfLibDocCache.set(source.id, PDFLib.PDFDocument.load(source.bytes));
  }
  return pdfLibDocCache.get(source.id);
}

// Outcome cache, keyed by sourceId + RESOURCE font name (not by line — many
// lines on a page share one font resource): { cssFamily, fontkitFont } once
// the FontFace has actually loaded, or null once we've tried and it failed
// (missing program / FontFace refused the bytes / standard-14 with nothing to
// load) — null is remembered so a failed font isn't re-attempted on every tap.
const docFontCache = new Map(); // `${sourceId}:${fontName}` -> Promise<{cssFamily, fontkitFont}|null>
const addedFontFaces = new Set(); // live FontFace objects on document.fonts — swept on Buka Baru

// A resource font name can carry PDF name-escape bytes (#xx) or characters
// invalid in a CSS custom ident — collapse to a safe, still-unique token.
function sanitizeForCssIdent(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
}

// Load (or reuse) the doc font for one resource font name on one source.
// Returns null on ANY decline (never throws into the caller) — extraction
// failure, fontkit parse failure, or the FontFace API itself refusing the
// bytes are all the same honest "no live preview for this line", the twin
// stays exactly as it already was.
function loadDocFont(sourceId, fontName, pdfPage, PDFLib, fontkit) {
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
        return null; // decline, never guess — same law as reinsert.js's planNativeInsert
      }
      const cssFamily = `pdflokal-doc-${sanitizeForCssIdent(sourceId)}-${sanitizeForCssIdent(fontName)}`;
      let face;
      try {
        face = new FontFace(cssFamily, extracted.bytes);
        await face.load();
      } catch (_err) {
        // Some CFF shapes need an explicit sfnt/OpenType wrap the FontFace
        // constructor won't infer from raw bytes alone — decline rather than
        // throw; the twin (already showing) is the honest fallback.
        return null;
      }
      document.fonts.add(face);
      addedFontFaces.add(face);
      return { cssFamily, fontkitFont };
    })().catch(() => null));
  }
  return docFontCache.get(key);
}

// Fire-and-forget from smartReplace: never blocks the editor opening (the
// twin shows immediately, same as before this feature existed). `draft` is
// the SAME object handed to openTextEditor — mutated in place once the doc
// font lands, so the commit path (reading draft fields at blur/Enter time)
// picks it up for free if it arrives before the user finishes typing.
async function prepareDocFont(pageId, line, draft) {
  try {
    const page = getPage(doc, pageId);
    const source = page && getSource(doc, page.sourceId);
    if (!source) return;
    const { PDFLib, fontkit } = await ensurePdfLib();
    const srcDoc = await getDryRunDoc(PDFLib, source);
    const pdfPage = srcDoc.getPages()[page.sourcePageNum];
    if (!pdfPage) return;
    // DRY RUN ONLY: learns the resource font name painting this line on the
    // SOURCE page. Nothing here is written back anywhere — same throwaway
    // read core/redact.js's own removeRunsFromPdfPage performs for real at
    // export time, run here purely to look.
    const joined = readPageContents(pdfPage, PDFLib);
    const fonts = extractFontMetrics(pdfPage, PDFLib);
    const { results } = planRunRemoval(joined, fonts, [line.pdf]);
    const fontName = results[0]?.insert?.fontName;
    if (!fontName) return; // unmatched / declined run — no font to learn

    const result = await loadDocFont(page.sourceId, fontName, pdfPage, PDFLib, fontkit);
    if (!result) return; // extraction/parse/FontFace decline — twin stays, honestly

    // Guard: the draft may have been cancelled/committed already, or a NEWER
    // tap may have replaced it — only this draft's own reference matters.
    draft.docFontFamily = result.cssFamily;
    draft.docFontkitFont = result.fontkitFont; // commit-time coverage check
    if (draft.editorEl && draft.editorEl.isConnected) {
      // Progressive swap: prepend the doc font ahead of whatever twin stack
      // is already set — the browser's own per-glyph fallback to that twin
      // for any char the doc font doesn't cover is EXACTLY the honest
      // preview of what export will do.
      const twinStack = draft.editorEl.style.fontFamily;
      draft.editorEl.style.fontFamily = `"${result.cssFamily}", ${twinStack}`;
    }
  } catch (err) {
    console.warn('prepareDocFont gagal:', err);
  }
}

async function smartReplace(pageId, x, y) {
  // Founder ruling 2026-07-19: the LINE is the editing primitive — hitTest
  // now resolves to a Line (core/text-lines.js), one or more fragments
  // clustered by geometry. On a single-fragment-per-line document (every
  // pre-line fixture) a Line IS a Run, so this whole flow is unchanged.
  const line = await textRuns.hitTest(pageId, x, y);
  if (!line) {
    const runs = await textRuns.getRuns(pageId);
    if (runs.length === 0) {
      // The router (two-ladder ruling, seat decisions.md 2026-07-18): no text
      // layer = a scan/photo — that's the dokumen-foto ladder, not this one.
      track('ganti_no_text_layer');
      toast('Halaman ini hasil scan/foto — teksnya belum bisa diganti');
    } else {
      toast('Nggak kena tulisan — tap tepat di teksnya ya');
    }
    return;
  }
  record(history, doc);
  const cover = addAnnotation(doc, pageId, createAnnotation('whiteout', {
    x: line.x, y: line.y, width: line.w, height: line.h,
    // Carries the surgery intent (Rung B honest-replacement — seat spec):
    // replaceTargets is an ARRAY of user-space geometry (core/redact.js's
    // frame) — one whole-line target, spanning every fragment pdf.js split
    // the line into; replaceBox is this cover's OWN creation-time page-space
    // rect, so export can confirm the cover is still where it was born before
    // cutting the original show-text ops — move the cover away and you've
    // un-covered the text, so the surgery intent no longer holds (see
    // core/export.js).
    replaceTargets: [line.pdf],
    replaceBox: { x: line.x, y: line.y, w: line.w, h: line.h },
  }));
  syncPage(pageId);
  track('editor_action', { action: 'ganti_teks' });
  const draft = {
    text: line.str,
    fontSize: Math.min(120, Math.max(6, Math.round(line.size))),
    fontFamily: mapRunFont(line.fontFamily, line.fontName),
    recorded: true,
    // Rung C (core/export.js): pairs the committed TEXT annotation with the
    // cover it replaces, so export can try writing it natively into the
    // content stream with the document's OWN font once surgery on THIS cover
    // has proven the original run is truly gone.
    replaceCoverId: cover.id,
    // Backing out (Escape / empty commit) must not leave a mute cover over
    // the original words — the cover belongs to the replace, not to itself.
    onCancel: () => { removeAnnotation(doc, cover.id); syncPage(pageId); },
  };
  openTextEditor({ pageId, x: line.x, y: line.y, anno: null, draft });
  // Disarm NOW, not at commit (founder ruling, Jul 18 phone test): with the
  // tool still armed, the tap that should only COMMIT also fired a second
  // replace (miss toast / surprise editor). Click-down elsewhere = commit.
  setTool('select');
  // The arm toast ("Tap tulisan…") must not outlive its own step — with the
  // editor open it instructs a thing already done (taste-judge, path law).
  toastEl.classList.remove('show');
  matchReplaceColors(cover, draft, pageId, line); // async; colors land live
  prepareDocFont(pageId, line, draft); // async; never blocks the editor opening
}

// ---- Ganti Teks steering highlight (press→steer→release-commit, 2026-07-19) ------
// FOUNDER RULING (2026-07-19, "mending opsi a" — QUIET PAGE): when Ganti Teks
// is armed the page shows NO per-line hint boxes. On a dense document
// everything is tappable, so marking everything marks nothing. The armed-mode
// affordance is now ONLY: the arm toast + this glow (hover on fine pointers,
// press-steer on touch) — one reusable div, moved (not recreated) between page
// overlays as the press/drag/hover resolves to different lines. Solid
// chrome-red, matches the founder's camera-first release-commit law: nothing
// is true until the finger lifts, but the user must see what WOULD happen.
let gantiGlowEl = null;
let gantiSteerSeq = 0;    // guards against a late hitTest landing after a newer one
let gantiSteerRaf = null;
let gantiSteerPending;    // undefined = nothing queued (null is a valid "clear" value)

function clearGantiGlow() {
  if (gantiGlowEl) { gantiGlowEl.remove(); gantiGlowEl = null; }
}

async function applyGantiSteer(pt) {
  const seq = (gantiSteerSeq += 1);
  if (!pt) { clearGantiGlow(); return; }
  const line = await textRuns.hitTest(pt.pageId, pt.x, pt.y);
  // Stale guard: a newer steer landed first, or the tool moved on while this
  // hitTest (async — first call per page extracts text) was in flight.
  if (seq !== gantiSteerSeq || tool !== 'ganti') return;
  if (!line) { clearGantiGlow(); return; }
  const slot = slots.find((s) => s.page.id === pt.pageId);
  const overlay = slot?.view.querySelector('.pv-overlay');
  if (!overlay) { clearGantiGlow(); return; }
  if (!gantiGlowEl) {
    gantiGlowEl = document.createElement('div');
    gantiGlowEl.className = 'pv-ganti-glow';
  }
  gantiGlowEl.style.cssText =
    `position:absolute;left:${line.x}px;top:${line.y}px;width:${line.w}px;height:${line.h}px;` +
    'pointer-events:none;border:1.5px solid rgba(220,38,38,.8);background:rgba(220,38,38,.08);border-radius:2px;';
  if (gantiGlowEl.parentElement !== overlay) overlay.appendChild(gantiGlowEl);
}

// rAF-throttled: interaction.js forwards a raw pointermove stream (steering +
// fine-pointer hover) — coalesce to one hitTest per frame instead of one per
// event.
function onGantiSteer(pt) {
  gantiSteerPending = pt;
  if (gantiSteerRaf) return;
  gantiSteerRaf = requestAnimationFrame(() => {
    gantiSteerRaf = null;
    applyGantiSteer(gantiSteerPending);
  });
}

// ---- carried-signature ghost (desktop telegraph, founder Jul 3) -------------------
// After drawing a TTD, the "place it" state must be visible: on fine pointers
// the signature itself rides the cursor, translucent, until the click drops
// it. Touch has no cursor — there the persistent sig-bar hint does this job.
const sigGhost = document.createElement('img');
sigGhost.id = 'sig-ghost';
sigGhost.alt = '';
sigGhost.style.cssText =
  'position:fixed;z-index:70;pointer-events:none;opacity:.55;display:none;' +
  'filter:drop-shadow(0 4px 10px rgba(63,49,35,.25))';
document.body.appendChild(sigGhost);
const FINE_POINTER = window.matchMedia('(pointer: fine)').matches;

document.addEventListener('pointermove', (e) => {
  if (FINE_POINTER && tool === 'signature' && storedSignature) {
    const w = (storedSignature.subtype === 'paraf' ? 80 : 150) * zoom;
    const h = w * (storedSignature.height / storedSignature.width);
    if (sigGhost.dataset.sig !== storedSignature.dataUrl.slice(-40)) {
      sigGhost.src = storedSignature.dataUrl;
      sigGhost.dataset.sig = storedSignature.dataUrl.slice(-40);
    }
    sigGhost.style.width = w + 'px';
    sigGhost.style.height = h + 'px';
    sigGhost.style.left = (e.clientX - w / 2) + 'px';
    sigGhost.style.top = (e.clientY - h / 2) + 'px';
    sigGhost.style.display = '';
  } else if (sigGhost.style.display !== 'none') {
    sigGhost.style.display = 'none';
  }
});

// Hapus works BOTH ways (founder ask): with a selection it deletes now; with
// nothing selected it arms delete-mode — the next tapped object is removed.
document.getElementById('btn-delete-anno').addEventListener('click', () => {
  if (tool === 'delete') { setTool('select'); return; } // toggle off (on-off law)
  if (doc.selection.annotationId) { deleteSelected(); return; }
  setTool('delete');
  toast('Pilih objek yang mau dihapus');
});

// ---- Tip-Ex color matching -------------------------------------------------------
// Zero-UI "colour matching tool", decided AT STROKE START (founder: the user
// should see the matched color WHILE drawing, not a white→color jump at the
// end). Sample two rings around the press point from the page raster and take
// the per-channel median — thin ink strokes lose the vote to the surrounding
// paper, so covering text on a cream scan yields cream. White stays white.
async function withPageRasterCtx(pageId) {
  const page = doc.pages.find((p) => p.id === pageId);
  if (!page?.raster) return null; // page not rasterized — callers keep defaults
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = page.raster.dataUrl; });
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.drawImage(img, 0, 0);
  const rotated = (page.rotation || 0) % 180 !== 0;
  const frameW = rotated ? page.height : page.width;
  return { cx, w: c.width, h: c.height, s: img.width / frameW }; // s = raster px per page point
}
const medOf = (arr) => arr.sort((a, b) => a - b)[Math.floor(arr.length / 2)];
const medColor = (px) =>
  `#${[0, 1, 2].map((ch) => medOf(px.map((p) => p[ch])).toString(16).padStart(2, '0')).join('')}`;
const lumOf = (p) => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];

function takeSample(r, x, y, into) {
  if (x < 0 || y < 0 || x >= r.w || y >= r.h) return;
  const px = r.cx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
  into.push([px[0], px[1], px[2]]);
}

async function matchWhiteoutColor(anno, pageId, ox, oy) {
  try {
    const r = await withPageRasterCtx(pageId);
    if (!r) return;
    const samples = [];
    for (const radius of [6 * r.s, 12 * r.s]) {
      for (let i = 0; i < 10; i += 1) {
        const ang = (Math.PI * 2 * i) / 10;
        takeSample(r, ox * r.s + radius * Math.cos(ang), oy * r.s + radius * Math.sin(ang), samples);
      }
    }
    if (samples.length < 8) return;
    const color = medColor(samples);
    updateAnnotation(doc, anno.id, { color });
    // Mid-gesture: update the LIVE element directly — rebuilding the overlay
    // here would destroy the element holding the pointer capture.
    const el = stage.querySelector(`[data-anno-id="${anno.id}"]`);
    if (el) el.style.background = color;
  } catch { /* sampling is best-effort; white stays */ }
}

// Ganti Teks colors, one raster read: the ring sampler above fails on big/bold
// runs — rings around the CENTER land on ink, and the founder's deck title got
// a dark slab for a cover (phone test, Jul 18). Paper is sampled just OUTSIDE
// the line's box instead; ink = the in-box cluster farthest in luminance from
// that paper, so a navy heading is retyped in navy without asking. Ink lands on
// the DRAFT object live (the open editor restyles; commit reads the draft).
// 4th arg only ever reads x/y/w/h — a Line has those fields same as a Run did,
// verified against core/text-lines.js's assembleLine() shape.
async function matchReplaceColors(cover, draft, pageId, line) {
  try {
    const r = await withPageRasterCtx(pageId);
    if (!r) return;
    const o = 3 * r.s;
    const paper = [];
    for (let i = 0; i <= 4; i += 1) {
      const x = (line.x + (line.w * i) / 4) * r.s;
      takeSample(r, x, line.y * r.s - o, paper);
      takeSample(r, x, (line.y + line.h) * r.s + o, paper);
    }
    for (const fy of [0.25, 0.75]) {
      takeSample(r, line.x * r.s - o, (line.y + line.h * fy) * r.s, paper);
      takeSample(r, (line.x + line.w) * r.s + o, (line.y + line.h * fy) * r.s, paper);
    }
    if (paper.length < 6) return;
    const coverColor = medColor(paper);
    updateAnnotation(doc, cover.id, { color: coverColor });
    const el = stage.querySelector(`[data-anno-id="${cover.id}"]`);
    if (el) el.style.background = coverColor;

    const paperLum = lumOf(paper.map((p) => [p[0], p[1], p[2]])
      .reduce((a, b) => [a[0] + b[0] / paper.length, a[1] + b[1] / paper.length, a[2] + b[2] / paper.length], [0, 0, 0]));
    const inside = [];
    for (let ix = 1; ix <= 8; ix += 1) {
      for (let iy = 1; iy <= 3; iy += 1) {
        takeSample(r, (line.x + (line.w * ix) / 9) * r.s, (line.y + (line.h * iy) / 4) * r.s, inside);
      }
    }
    const ranked = inside.sort((a, b) => Math.abs(lumOf(b) - paperLum) - Math.abs(lumOf(a) - paperLum));
    const ink = ranked.slice(0, Math.max(3, Math.floor(ranked.length / 4)));
    // Anti-aliased gray on plain paper must NOT tint the text — only adopt the
    // ink color when it clearly separates from the paper.
    if (ink.length && Math.abs(lumOf(ink[Math.floor(ink.length / 2)]) - paperLum) > 40) {
      draft.color = medColor(ink);
      if (editingEl && !editingAnno) editingEl.style.color = draft.color;
    }
  } catch { /* best-effort; white cover + default ink stand */ }
}

// ---- interaction wiring ------------------------------------------------------------
const interaction = createInteraction({
  stage,
  getDoc: () => doc,
  getZoom: () => zoom,
  getTool: () => tool,
  history,
  onChange: (kind) => {
    // Tip-Ex stroke finished (color was already matched at stroke START):
    // return home to Pilih (founder: whiteout should NOT stay sticky).
    if (kind === 'draw') { track('editor_action', { action: 'whiteout' }); setTool('select'); }
    refreshChrome();
  },
  onDeleteTap: (annoId, pageId) => {
    record(history, doc);
    removeAnnotation(doc, annoId);
    syncPage(pageId);
    setTool('select'); // one delete per arming; undo covers mistakes
  },
  onPlace: (t, { pageId, x, y }) => {
    if (t === 'text') {
      openTextEditor({ pageId, x, y, anno: null });
    } else if (t === 'ganti') {
      smartReplace(pageId, x, y); // async: extraction may need a moment on first tap
    } else if (t === 'signature' && storedSignature) {
      record(history, doc);
      // Paraf places small (initials), signature at document scale.
      const w = storedSignature.subtype === 'paraf' ? 80 : 150;
      const h = w * (storedSignature.height / storedSignature.width);
      const created = addAnnotation(doc, pageId, createAnnotation('signature', {
        image: storedSignature.dataUrl, subtype: storedSignature.subtype,
        x: Math.max(0, x - w / 2), y: Math.max(0, y - h / 2), width: w, height: h,
      }));
      track('editor_action', { action: storedSignature.subtype === 'paraf' ? 'paraf' : 'signature' });
      selectAnnotation(doc, created.id); // selected → "Semua Hal." is one tap away
      syncPage(pageId);
      setTool('select'); // tools are verbs; back home
    }
  },
  onDrawStart: ({ pageId, x, y }) => {
    // Whiteout drag-to-draw. interaction.js already recorded history.
    const anno = addAnnotation(doc, pageId, createAnnotation('whiteout', {
      x, y, width: 8, height: 8,
    }));
    syncPage(pageId);
    matchWhiteoutColor(anno, pageId, x, y); // async; colors the rect while drawing
    return anno;
  },
  onEditText: (annoId) => {
    for (const page of doc.pages) {
      const anno = page.annotations.find((a) => a.id === annoId);
      if (anno) { openTextEditor({ pageId: page.id, x: anno.x, y: anno.y, anno }); return; }
    }
  },
  onGantiSteer,
});

// ---- page manager (Halaman sheet) -----------------------------------------------
const pageManager = createPageManager({
  sheet: document.getElementById('pm-sheet'),
  grid: document.getElementById('pm-grid'),
  bulkBar: document.getElementById('pm-bulk'),
  pickBar: document.getElementById('pm-pickbar'),
  getDoc: () => doc,
  history,
  getRasterizer: () => rasterizer,
  onDocChanged: () => { textRuns.invalidateAll(); rebuildStage(); },
  onAddFiles: () => document.getElementById('file-input').click(),
  onExtract: async (pages) => {
    // Export ONLY the selected pages: a shallow Doc sharing the same sources.
    try {
      toast('Sebentar, lagi disiapkan');
      const [{ buildPdfBytes }, { PDFLib, fontkit }] = await Promise.all([
        import('../core/export.js'),
        ensurePdfLib(), // pdf-lib + fontkit: export-only, fetched at the moment of intent
      ]);
      const subset = { sources: doc.sources, pages, selection: { pageId: null, annotationId: null } };
      const bytes = await buildPdfBytes(subset, { PDFLib, fontkit });
      download(new Blob([bytes], { type: 'application/pdf' }), `${baseName}-halaman-${pages.length}.pdf`);
      toast(`Selesai! ${pages.length} halaman diekstrak jadi PDF baru`);
    } catch (err) {
      console.error(err);
      toast('Waduh, gagal mengekstrak. Coba sekali lagi ya');
    }
  },
  toast,
});
document.getElementById('btn-pages').addEventListener('click', () => pageManager.open());
document.getElementById('pm-close').addEventListener('click', () => pageManager.close());

// ---- inline text editing ------------------------------------------------------------
// One code path for "place new text" and "edit existing text": a contenteditable
// positioned in the page overlay at page coords. Commit on blur / Enter.
function openTextEditor({ pageId, x, y, anno, draft }) {
  const slot = slots.find((s) => s.page.id === pageId);
  if (!slot) return;
  const overlay = slot.view.querySelector('.pv-overlay');
  // New text starts from the format bar's sticky defaults (Canva behavior).
  // A `draft` (Ganti Teks) pre-seeds content + matched font over those defaults.
  const style = anno || (draft ? { ...formatBar.getDefaults(), ...draft } : formatBar.getDefaults());

  const ed = document.createElement('div');
  ed.className = 'v2-text-edit';
  ed.contentEditable = 'true';
  ed.style.left = (anno ? anno.x : x) + 'px';
  ed.style.top = (anno ? anno.y : y) + 'px';
  ed.style.font = textFontCss(style);
  ed.style.color = style.color || '#000';
  ed.textContent = anno?.text || draft?.text || '';

  // Hide the original while editing (the editor visually replaces it).
  const origEl = anno ? overlay.querySelector(`[data-anno-id="${anno.id}"]`) : null;
  if (origEl) origEl.style.visibility = 'hidden';

  editingAnno = anno || null;
  editingEl = ed;
  editingIsReplace = !!draft;
  // Rung C live-font-preview: prepareDocFont (fired from smartReplace, still
  // in flight) needs to reach THIS specific editor element once the doc font
  // lands — the draft is its only handle, since a newer tap can open another
  // editor (and another draft) before this async work resolves.
  if (draft) draft.editorEl = ed;
  syncFormatBar();

  let committed = false; // guard: blur fires after Enter-commit too
  const commit = () => {
    if (committed) return;
    committed = true;
    const text = ed.textContent.trim();
    ed.remove();
    editingAnno = null;
    editingEl = null;
    editingIsReplace = false;
    if (anno) {
      if (text && text !== anno.text) {
        record(history, doc);
        updateAnnotation(doc, anno.id, { text });
        track('editor_action', { action: 'text_inline' });
      } else if (!text) {
        record(history, doc);
        removeAnnotation(doc, anno.id);
      }
    } else if (text) {
      // Ganti Teks recorded its ONE undo step before the cover was placed —
      // recording again here would split one gesture into two undos.
      if (!draft?.recorded) record(history, doc);
      const d = { ...formatBar.getDefaults(), ...(draft || {}) };
      // replaceCoverId only ever comes from a Ganti Teks draft — omit the key
      // entirely for ordinary authored text rather than carry an undefined.
      const replaceProps = d.replaceCoverId ? { replaceCoverId: d.replaceCoverId } : {};
      // docFontFamily only ever lands via prepareDocFont on a Ganti draft —
      // same omit-if-absent shape, so a committed annotation without a live
      // doc font carries no dead key. render/page-view.js's textFontCss reads
      // this to keep the committed replacement looking like the document.
      const docFontProps = d.docFontFamily ? { docFontFamily: d.docFontFamily } : {};
      // Founder ruling (tonight, 2026-07-19): when a substitute font WILL be
      // used for this Ganti replacement, say so plainly at commit — decided
      // with whatever prepareDocFont has managed to load by NOW (it's async;
      // a very fast typist can commit before it lands). No doc font loaded
      // (extraction declined / FontFace refused / a standard-14 font with
      // nothing to embed) OR the loaded font doesn't cover every non-space
      // char of the FINAL typed text → the honest substitute notice. Ordinary
      // (non-Ganti) text never carries replaceCoverId, so never toasts here.
      if (d.replaceCoverId) {
        const covered = !!d.docFontkitFont
          && [...text].every((ch) => ch === ' ' || d.docFontkitFont.hasGlyphForCodePoint(ch.codePointAt(0)));
        if (!covered) toast('Huruf ini memakai font pengganti yang mirip');
      }
      const created = addAnnotation(doc, pageId, createAnnotation('text', {
        text, x, y,
        fontSize: d.fontSize, fontFamily: d.fontFamily,
        bold: d.bold, italic: d.italic, color: d.color,
        ...replaceProps,
        ...docFontProps,
      }));
      // Authored text stays SELECTED (the user sees it's an object; a format
      // tweak right after the blur-commit still lands). A Ganti Teks commit
      // does NOT auto-select: post-commit selection resurfaces the format bar
      // on the flow's last frame — the redefine-invitation the founder ruled
      // out (taste-judge finding, night run 2026-07-19). A later deliberate
      // tap still selects it like any text object — one grammar, kept.
      if (!draft) selectAnnotation(doc, created.id);
      track('editor_action', { action: 'text' });
    } else if (draft?.onCancel) {
      // Ganti Teks backed out with nothing typed — take the cover back too.
      draft.onCancel();
    }
    syncPage(pageId);
    setTool('select');
  };

  ed.addEventListener('blur', commit);
  ed.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ed.blur(); }
    if (e.key === 'Escape') { ed.textContent = anno?.text || ''; ed.blur(); }
    e.stopPropagation(); // don't trigger app shortcuts while typing
  });
  ed.addEventListener('pointerdown', (e) => e.stopPropagation());

  overlay.appendChild(ed);
  ed.focus();
  // Place the caret at the end (mobile keyboards otherwise start at 0).
  // Guarded (Sentry JAVASCRIPT-D): iOS WebKit can leave the selection
  // rangeless after selectAllChildren — collapseToEnd() then throws
  // InvalidStateError. Caret-at-start beats a dead text tool.
  const sel = window.getSelection();
  sel.selectAllChildren(ed);
  // Ganti Teks keeps the prefill SELECTED — typing straight over the old words
  // is the whole gesture. Everyone else gets caret-at-end as before.
  if (!draft && sel.rangeCount > 0) sel.collapseToEnd();
}

// ---- signature modal (draw / upload / paraf) --------------------------------------------
const signatureModal = createSignatureModal({
  modal: document.getElementById('sig-modal'),
  toast,
  onReady: (sig) => {
    storedSignature = sig; // { dataUrl, width, height, subtype }
    // Founder punch list #1: if a placed signature is SELECTED when the user
    // redraws, they're fixing THAT one — swap its image in place instead of
    // making them delete + re-place. Otherwise arm placement as before.
    const found = selectedSignatureAnno();
    if (found) {
      record(history, doc);
      found.anno.image = sig.dataUrl;
      found.anno.height = found.anno.width * (sig.height / sig.width);
      rebuildStage();
      toast('Tanda tangan diganti');
      return;
    }
    setTool('signature');
    toast(sig.subtype === 'paraf'
      ? 'Pilih tempat untuk menempatkan paraf'
      : 'Pilih tempat untuk menempatkan tanda tangan');
  },
});

// ---- "Semua Hal." — copy the selected signature/paraf to every page ----------------------
function selectedSignatureAnno() {
  const id = doc.selection.annotationId;
  if (!id) return null;
  for (const page of doc.pages) {
    const a = page.annotations.find((x) => x.id === id);
    if (a) return a.type === 'signature' ? { page, anno: a } : null;
  }
  return null;
}

// The strip serves two moments: a selected signature (→ Semua Hal.) and the
// armed TTD tool (→ Gambar Ulang, so the saved signature is never a trap).
function syncSigBar() {
  const found = selectedSignatureAnno();
  const armed = tool === 'signature' && !!storedSignature;
  const bar = document.getElementById('sig-bar');
  const allBtn = document.getElementById('btn-all-pages');
  const redrawBtn = document.getElementById('btn-redraw-sig');
  // Punch list #1: a SELECTED signature also offers Gambar Ulang — "it placed
  // the old ttd" must be fixable right where the user is looking.
  bar.classList.toggle('show', !!found || armed);
  allBtn.style.display = found && doc.pages.length > 1 ? '' : 'none';
  redrawBtn.style.display = (armed || found) ? '' : 'none';
  document.getElementById('sig-bar-label').textContent = found
    ? (found.anno.subtype === 'paraf' ? 'Paraf terpilih' : 'Tanda tangan terpilih')
    : (armed ? 'Pilih tempat untuk menempatkan' : '');
}
document.getElementById('btn-redraw-sig').addEventListener('click', () => signatureModal.open());

document.getElementById('btn-all-pages').addEventListener('click', () => {
  const found = selectedSignatureAnno();
  if (!found) return;
  const { page: home, anno } = found;
  record(history, doc);
  for (const page of doc.pages) {
    if (page.id === home.id) continue;
    // Same position on every page; each copy is its OWN object (new id) so it
    // moves/deletes independently afterwards.
    addAnnotation(doc, page.id, createAnnotation('signature', {
      image: anno.image, subtype: anno.subtype,
      x: anno.x, y: anno.y, width: anno.width, height: anno.height,
    }));
  }
  rebuildStage();
  toast(`Oke, ditaruh di ${doc.pages.length - 1} halaman lainnya juga`);
});

// ---- delete / undo / redo ------------------------------------------------------------
function deleteSelected() {
  const id = doc.selection.annotationId;
  if (!id) return;
  let pageId = null;
  for (const page of doc.pages) {
    if (page.annotations.some((a) => a.id === id)) { pageId = page.id; break; }
  }
  record(history, doc);
  removeAnnotation(doc, id);
  if (pageId) syncPage(pageId);
}

function doUndo() { if (undo(history, doc)) { pageManager.invalidateThumbs(); rebuildStage(); } }
function doRedo() { if (redo(history, doc)) { pageManager.invalidateThumbs(); rebuildStage(); } }
document.getElementById('btn-undo').addEventListener('click', doUndo);
document.getElementById('btn-redo').addEventListener('click', doRedo);

document.addEventListener('keydown', (e) => {
  // Never hijack typing surfaces (the inline editor stops propagation itself).
  if (e.target.matches?.('input, select, textarea, [contenteditable="true"]')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); }
  else if (mod && e.key === 'y') { e.preventDefault(); doRedo(); }
  else if (mod && e.key === 's') { e.preventDefault(); doDownload(); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && doc.selection.annotationId) {
    e.preventDefault(); deleteSelected();
  } else if (e.key === 'Escape') {
    // Native <dialog> closes itself on Escape; this handles the editor surface.
    clearSelection(doc);
    interaction.setSelected(null, null);
    setTool('select');
  } else if (!mod && doc.pages.length > 0) {
    // Tool verbs — same keys as the old editor (muscle memory carries over).
    const k = e.key.toLowerCase();
    if (k === 'v') setTool('select');
    else if (k === 't') setTool('text');
    else if (k === 'w') setTool('whiteout');
    else if (k === 'g') setTool('ganti');
    else if (k === 's' || k === 'p') {
      if (storedSignature) setTool('signature');
      else signatureModal.open();
    }
  }
});

// Arrow-key nudge for the selected annotation (1px, Shift = 10px) — parity
// with the live editor's #74. Separate listener: it must also work while a
// tool other than Pilih is active.
let nudgeLast = 0;
document.addEventListener('keydown', (e) => {
  if (!doc.selection.annotationId) return;
  if (e.target.matches?.('input, select, textarea, [contenteditable="true"]')) return;
  const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
  if (!dir) return;
  e.preventDefault();
  const step = e.shiftKey ? 10 : 1;
  // One undo step per nudge burst: only record when the previous keydown was >600ms ago.
  const now = Date.now();
  if (!nudgeLast || now - nudgeLast > 600) record(history, doc);
  nudgeLast = now;
  const a = moveAnnotation(doc, doc.selection.annotationId, dir[0] * step, dir[1] * step);
  if (a) {
    const el = stage.querySelector(`[data-anno-id="${a.id}"]`);
    if (el) { el.style.left = a.x + 'px'; el.style.top = a.y + 'px'; }
  }
});

// ---- file loading (multi-file = merge, by construction) --------------------------------
// Size guard (carried from the live app): block at 100MB — a 100MB+ file will OOM
// the weak phones we build for before it ever renders. (The old >20MB heads-up
// toast was retired when the processing overlay landed — see showProcessing.)
const SIZE_BLOCK = 100 * 1024 * 1024;

let loadingFiles = false; // re-entry guard: double-taps and rapid picks interleave imports

async function loadFiles(files) {
  if (loadingFiles) { toast('Sebentar ya, file sebelumnya masih dimuat'); return; }
  loadingFiles = true;
  try {
    await loadFilesInner(files);
  } finally {
    loadingFiles = false;
    hideProcessing();
  }
}

async function loadFilesInner(files) {
  const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
  const isImg = (f) => f.type.startsWith('image/');
  // In picker order: PDFs append their pages, images become one page each.
  const usable = [...files].filter((f) => isPdf(f) || isImg(f));
  if (usable.length === 0) { toast('Pilih file PDF atau gambar ya'); return; }
  const oversize = usable.find((f) => f.size > SIZE_BLOCK);
  if (oversize) { toast(`"${oversize.name}" terlalu besar (maks 100MB)`); return; }
  const firstLoad = doc.pages.length === 0;
  if (firstLoad) baseName = usable[0].name.replace(/\.[^.]+$/, '');

  // Telegraph the parse loop. Note the >20MB heads-up toast is gone: it fired
  // here but sat hidden BEHIND this overlay (z-order), and the overlay itself
  // — plus its "diproses di HP-mu" note — is the honest heads-up now.
  showProcessing(usable.length);
  // Per-file resilience: one empty/corrupt/unreadable file must NOT crash the whole
  // load. Before this guard, a 0-byte PDF (Sentry JAVASCRIPT-H) and a file that went
  // unreadable after the picker handed its reference (JAVASCRIPT-G) both bubbled to
  // onunhandledrejection — the user saw a silent broken load. Now we skip the bad
  // one, keep the good ones, and say so plainly. Honest failure is still feedback.
  let failed = 0;
  for (let i = 0; i < usable.length; i++) {
    const f = usable[i];
    updateProcessing(i, usable.length); // i files done, working on i+1
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (bytes.length === 0) throw new Error('empty file'); // 0-byte → JAVASCRIPT-H
      if (isPdf(f)) await importPdf(doc, { name: f.name, bytes });
      else await importImage(doc, { name: f.name, bytes, mimeType: f.type });
      // Carry the intent so the funnel joins up: intent_armed → file_loaded →
      // download. Without it we'd know people PRESSED "Pisah PDF" but not whether
      // any ever brought a file — the half that matters. applyIntent() clears it below.
      track('file_loaded', {
        tool: 'editor-v2',
        fileType: isPdf(f) ? 'pdf' : 'image',
        intent: pendingIntent || 'none',
      });
    } catch (err) {
      // Expected class: the user brought a bad file. Swallow at the user level (no
      // Sentry noise), keep a console trail for us, count it for the notice below.
      failed++;
      console.warn('Lewati file yang gagal dibuka:', f.name, err);
      track('file_failed', { tool: 'editor-v2', fileType: isPdf(f) ? 'pdf' : 'image' });
    }
  }

  // Every file failed → leave the landing untouched, say it plainly, bail. Also
  // guards the doc.pages[0] read below, which would throw on an empty document.
  if (doc.pages.length === 0) {
    toast(usable.length === 1
      ? 'File itu nggak bisa dibuka — mungkin kosong atau rusak'
      : 'Nggak ada file yang bisa dibuka — mungkin kosong atau rusak');
    return;
  }

  if (!rasterizer) rasterizer = createPageRasterizer(doc);
  emptyEl.style.display = 'none';
  document.body.classList.remove('is-empty'); // landing yields, editor chrome returns

  if (firstLoad) {
    zoom = Math.min(1, (scrollEl.clientWidth - 16) / doc.pages[0].width);
  }
  rebuildStage(); // applies zoom + sizer at the end
  // Honest close-out: skips take priority over the merge tally — the user needs to
  // know something was left out more than they need the count.
  if (failed > 0) {
    toast(`${failed} file dilewati — kosong atau rusak`);
  } else if (!firstLoad) {
    toast(`Dijepit jadi satu, sekarang ${doc.pages.length} halaman`);
  }
  // If the Halaman sheet triggered this add, refresh its grid in place.
  if (document.getElementById('pm-sheet').open) pageManager.render();

  // The intent hook: a landing card (or a future /gabung-pdf page via ?buat=)
  // told us what the user came to do — configure the editor for it, once.
  if (firstLoad && pendingIntent) {
    const intent = pendingIntent;
    pendingIntent = null;
    applyIntent(intent);
  }
}

// ---- the landing: dropzone, tool cards, intent hook -------------------------------
// Three ways an intent reaches us, in priority order:
//   1. ?buat=gabung          — a link from anywhere (the original hook, bet 5.3)
//   2. <body data-intent>    — an SEO tool page (/gabung-pdf) declaring what it IS
//   3. a tool-card click     — set below, on the way to the file picker
// (2) is what makes the generated landing pages more than brochures: land on
// /kompres-pdf, drop a file, and the compress sheet is already open.
let pendingIntent = new URLSearchParams(window.location.search).get('buat')
  || document.body.dataset.intent
  || null;

function applyIntent(intent) {
  if (intent === 'ttd' || intent === 'paraf') {
    // Same semantics as the toolbar button: no stored signature → the modal
    // opens to make one; otherwise arm placement.
    if (!storedSignature) { signatureModal.open(); return; }
    setTool('signature');
    toast('Pilih tempat untuk menempatkan tanda tangan');
  } else if (intent === 'teks') {
    setTool('text');
    toast('Pilih tempat untuk menulis');
  } else if (intent === 'tipex') {
    setTool('whiteout');
    toast('Seret di halaman untuk menutup teks');
  } else if (intent === 'kompres') {
    // /kompres-pdf-500kb declares <body data-intent="kompres" data-target="512000">.
    // The sheet validates it against its own TARGETS list, so a junk value just
    // falls back to Otomatis rather than becoming a bogus cap.
    const target = Number(document.body.dataset.target) || null;
    downloadSheet.open({ size: 'kompres', target });
  }
  else if (intent === 'gambar') downloadSheet.open({ format: 'img' });
  else if (intent === 'split' || intent === 'halaman') pageManager.open();
  else if (intent === 'gabung') toast('Tambah file lainnya lewat menu File di kiri atas');
}

const fileInput = document.getElementById('file-input');
const DEFAULT_ACCEPT = fileInput.getAttribute('accept');
document.getElementById('btn-open').addEventListener('click', () => fileInput.click());

// Foto jadi PDF narrows the picker to images; everything else keeps both.
//
// `source` answers a question we could NOT answer before: which tool cards do
// people actually press, and do the SEO pages send anyone? Card clicks emitted
// NOTHING — track() fired on file_loaded and editor_action, but the intent itself
// was never recorded. That's why "is Kelola Halaman discoverable?" has been parked
// in the backlog waiting for data that was never going to arrive: nothing was
// sending it. Three sources, one event:
//   card      — pressed a tool card (on the homepage or on a tool page)
//   seo_page  — landed on /gabung-pdf etc, which declares <body data-intent>
//   query     — arrived via ?buat=… (a link from anywhere)
// The funnel then reads: intent_armed → file_loaded → download.
function armIntent(intent, source) {
  pendingIntent = intent;
  fileInput.setAttribute('accept', intent === 'foto' ? 'image/*' : DEFAULT_ACCEPT);
  // Re-word the editor around the job while we're at it. Arming the right TOOL but
  // then describing it in generic words threw the intent away — someone who came
  // to /pisah-pdf was shown a button labelled "Ekstrak" and no mention of "pisah".
  applyIntentCopy(intent);
  track('intent_armed', { intent, source });
}

if (pendingIntent) {
  // ?buat= wins over <body data-intent> in the pendingIntent lookup above, so the
  // source has to be resolved the same way round or the attribution lies.
  const fromQuery = Boolean(new URLSearchParams(window.location.search).get('buat'));
  armIntent(pendingIntent, fromQuery ? 'query' : 'seo_page');
}

// The tool cards are real <a href="/gabung-pdf"> links so Googlebot can crawl
// INTO each tool — as <button>s they were a dead end and the site had exactly one
// indexable URL. preventDefault keeps the human behaviour identical: click a card,
// the file picker opens immediately, no page load in between. Crawlers (and
// middle-click / cmd-click, which we must not steal) follow the href instead.
for (const card of document.querySelectorAll('.ld-card[data-intent]')) {
  card.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // let the browser open it
    e.preventDefault();
    armIntent(card.dataset.intent, 'card');
    fileInput.click();
  });
}

const lihatBtn = document.getElementById('ld-lihat');
const moreGrid = document.getElementById('ld-more');
lihatBtn.addEventListener('click', () => {
  const open = moreGrid.hidden;
  moreGrid.hidden = !open;
  lihatBtn.setAttribute('aria-expanded', String(open));
  lihatBtn.firstChild.textContent = open ? 'Sembunyikan' : 'Lihat semua alat';
});

// The dropzone welcomes an incoming drag (border + tint via .over).
const dropzoneEl = document.getElementById('btn-open');
for (const ev of ['dragenter', 'dragover']) {
  dropzoneEl.addEventListener(ev, (e) => { e.preventDefault(); dropzoneEl.classList.add('over'); });
}
for (const ev of ['dragleave', 'drop']) {
  dropzoneEl.addEventListener(ev, () => dropzoneEl.classList.remove('over'));
}

// ---- File menu: add more files or start over WITHOUT a page refresh ----------------
const fileMenu = document.getElementById('file-menu');
const fileBtn = document.getElementById('btn-file');
let pendingReplace = false; // next file selection replaces the doc instead of appending

function toggleFileMenu(show) {
  fileMenu.hidden = !show;
  fileBtn.setAttribute('aria-expanded', String(show));
}
fileBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleFileMenu(fileMenu.hidden); });
document.addEventListener('pointerdown', (e) => {
  if (!fileMenu.hidden && !e.target.closest('.file-menu-wrap')) toggleFileMenu(false);
});
document.getElementById('fm-add').addEventListener('click', () => {
  toggleFileMenu(false);
  fileInput.click(); // appends → merge, the default loadFiles path
});
document.getElementById('fm-new').addEventListener('click', () => {
  toggleFileMenu(false);
  pendingReplace = true; // applied when the picker actually returns files
  fileInput.click();
});

// Start over: a FRESH doc + history. The signature stays (it's the user's,
// not the document's). Cancelling the picker leaves everything untouched.
async function resetDoc() {
  doc = createDoc();
  history.undoStack.length = 0;
  history.redoStack.length = 0;
  if (rasterizer) { await rasterizer.destroy(); rasterizer = null; }
  await textRuns.destroy(); // fresh doc = fresh sources; cached pdf.js docs die with the old one
  // Rung C live-font-preview: the doc-font caches are keyed by sourceId — a
  // fresh doc means fresh (or reused-but-unrelated) source ids, and every
  // FontFace we registered on document.fonts belongs to the OLD document. Not
  // clearing them would leak faces forever across repeated Buka Baru, and
  // document.fonts.check() for a stale name would still (wrongly) report true.
  pdfLibDocCache.clear();
  docFontCache.clear();
  for (const face of addedFontFaces) document.fonts.delete(face);
  addedFontFaces.clear();
  slots = [];
  stage.innerHTML = '';
  baseName = 'dokumen';
  setTool('select');
}
fileInput.addEventListener('change', async (e) => {
  const files = e.target.files;
  if (files?.length) {
    if (pendingReplace) await resetDoc();
    await loadFiles(files).catch((err) => { console.error(err); toast('Gagal membuka file'); });
  }
  pendingReplace = false; // picker cancelled → nothing was destroyed
  fileInput.value = '';
  fileInput.setAttribute('accept', DEFAULT_ACCEPT); // undo any intent narrowing (Foto jadi PDF)
});

// Drag & drop anywhere (desktop).
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer?.files?.length) loadFiles(e.dataTransfer.files);
});

// ---- download: the Unduh sheet (output pipeline) ------------------------------------------
// Opening it starts building the REAL PDF in the background — by the time the
// 90% user taps the big button, the bytes are already there.
const downloadSheet = createDownloadSheet({
  modal: document.getElementById('dl-sheet'),
  getDoc: () => doc,
  getBaseName: () => baseName,
  pickPages: (preselected) => pageManager.openPick(preselected),
  download,
  toast,
});
function doDownload() {
  if (doc.pages.length === 0) return;
  downloadSheet.open();
}
document.getElementById('btn-download').addEventListener('click', doDownload);

// ---- wordmark → home (punch list #3) --------------------------------------------
// On the landing the wordmark is already home; with a doc open it asks first —
// a reload throws away un-downloaded edits.
document.getElementById('btn-home').addEventListener('click', () => {
  if (document.body.classList.contains('is-empty')) return;
  document.getElementById('home-confirm').showModal();
});
document.getElementById('hc-cancel').addEventListener('click', () => {
  document.getElementById('home-confirm').close();
});
document.getElementById('hc-go').addEventListener('click', () => {
  window.location.assign('/');
});

// ---- Android back button: closes the open sheet, never leaves the app -----------------
// Every dialog open pushes one history entry; the hardware/gesture back pops it
// and we close the dialog. UI-initiated closes (✕, backdrop, Escape, success)
// consume their entry with history.back() — guarded so our own back() doesn't
// cascade into closing the next dialog underneath (nested pm-over-download case).
(function wireDialogHistory() {
  // NOTE: window.history everywhere — plain `history` is SHADOWED in this
  // module by the undo history (const history = createHistory()).
  const dialogs = ['pm-sheet', 'sig-modal', 'dl-sheet', 'home-confirm'].map((id) => document.getElementById(id));
  const stack = []; // open dialogs in STACKING order (array order lies for nesting)
  let expectPop = false;

  for (const dlg of dialogs) {
    const nativeShow = dlg.showModal.bind(dlg);
    dlg.showModal = () => {
      if (dlg.open) return; // double-tap/double-Ctrl+S: showModal throws on open dialogs
      nativeShow();
      window.history.pushState({ v2dlg: dlg.id }, '');
      stack.push(dlg);
    };
    dlg.addEventListener('close', () => {
      const i = stack.lastIndexOf(dlg);
      if (i !== -1) stack.splice(i, 1);
      // Closed by UI code → its history entry is stale; consume it silently.
      if (window.history.state?.v2dlg === dlg.id) {
        expectPop = true;
        window.history.back();
      }
    });
  }

  window.addEventListener('popstate', () => {
    if (expectPop) { expectPop = false; return; }
    // Hardware back: close every dialog stacked ABOVE the entry we landed on.
    // Rapid double-back COALESCES two traversals into one popstate — closing
    // only the top layer would strand the lower sheet open with no history
    // entry left (the next back would exit the app with a sheet showing).
    const cur = window.history.state?.v2dlg || null;
    const keepIdx = cur ? stack.findIndex((d) => d.id === cur) : -1;
    const toClose = stack.slice(keepIdx + 1).reverse();
    for (const d of toClose) if (d.open) d.close();
  });
}());

// ---- test hooks (same pattern the old suite relies on) ----------------------------------
window.v2 = {
  getDoc: () => doc,
  getSlots: () => slots,
  textRuns, // tests: line geometry for string-addressed taps (quiet-page ruling removed the hint boxes specs used to click)
  loadFiles,
  setTool,
  getTool: () => tool,
  history,
  pageManager, // tests: force a grid re-render mid-drag (Sentry fee8a76e repro)
};
