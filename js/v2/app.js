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
import { failureReason } from '../core/failure-reason.js';
import { isStandardFamily, unencodableInStandardFont } from '../core/text-encode.js';
import {
  addAnnotation, removeAnnotation, updateAnnotation, clearSelection, selectAnnotation,
  moveAnnotation, normalizePageWidths,
} from '../core/operations.js';
import { createHistory, record, undo, redo, canUndo, canRedo } from '../core/history.js';
import { importPdf, importImage, createPageRasterizer, probeTextLayer } from '../core/import.js';
import {
  pagesBucket, durationBucket, ratioBucket, inkRatioBucket, intentValue,
  unsupportedCharClass,
} from '../core/telemetry-schema.js';
import { compareRegions } from '../core/visual-oracle.js';
import { validateSample } from '../core/feedback-sample.js';
import { createPageSlot, syncOverlay, textFontCss } from '../render/page-view.js';
import { createViewportStream } from '../render/viewport.js';
import { RASTER_BASE, sharpenScale, maxPixelsFor } from '../render/sharpen.js';
import { createInteraction } from '../render/interaction.js';
import { createFormatBar } from './format-bar.js';
import { createTextRunIndex, mapRunFont, MIN_HIT } from './text-runs.js';
import { resolveTap } from '../core/text-lines.js';
import { createPageManager } from './page-manager.js';
import { createSignatureModal } from './signature-modal.js';
import { createDownloadSheet } from './download-sheet.js';
import { track } from '../lib/analytics.js';
import { tel } from './telemetry.js';
import { showEditFeedback, dismissEditFeedback, setFeedbackSample } from './edit-feedback.js';
import { initFeedbackForm } from './feedback-form.js';
import { createCelebration } from './celebrate.js';
import { initInstallPrompt, isStandalone } from './install-prompt.js';
import { applyIntentCopy } from './intent-copy.js';
import { ensurePdfLib } from '../core/vendor.js';
import { readPageContents, extractFontMetrics } from '../core/redact.js';
import { planRunRemoval } from '../core/text-walk.js';
import { extractFontProgram, lookupFontObject } from '../core/doc-fonts.js';
import { textCoveredBy } from '../core/stamp.js';
import { resolveFontFingerprint, FAMILY_BUCKET_TO_CLONE, isInformativeBaseFont } from '../core/font-fingerprint.js';
import { cloneFamilyFor } from '../core/font-decide.js';
import { buildEditedPageBytes, editSignature, pageEdits } from '../core/page-surgery.js';

// WHY there is no `window.pdfjsLib.…workerSrc = …` line here any more: pdf.js is
// loaded on demand now (core/vendor.js), so touching it at module top-level
// would resurrect the very boot-time dependency we removed. The worker path is
// set inside ensurePdfJs(), the instant the lib lands.

// ---- telemetry: device class (spec-telemetry.md §3's doc_open/commit_paint) --
// Mirrors the old wing's detectMobile() thresholds (js/init.js) exactly — that
// SSOT convention (vw<=599 phone, <=900 tablet, else desktop) already matches
// this app's own 900px mobile-layout breakpoint, so v2 gets the same bucket a
// user on the old wing would have gotten, for free comparability.
function deviceClass() {
  const vw = window.innerWidth;
  if (vw <= 599) return 'phone';
  if (vw <= 900) return 'tablet';
  return 'desktop';
}

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

// ---- BETA edit-feedback (founder ruling 2026-07-22, SIMPLIFIED) -----------------
// Ask 👍/👎 ONCE, on the FIRST successful commit of a document. The founder
// killed the earlier debounced/idle version — "to make a toast like that is just
// bollocks; default it to the first commit, simpler, no algo, less chance to be
// buggy." Reset on a fresh document so a new editing session can be asked again.
let feedbackAsked = false;
function resetEditFeedback() { feedbackAsked = false; dismissEditFeedback(); }

const scrollEl = document.getElementById('v2-scroll');
const stage = document.getElementById('v2-stage');
const emptyEl = document.getElementById('empty');
const pill = document.getElementById('v2-pill');
const toastEl = document.getElementById('toast');

// ---- small helpers -----------------------------------------------------------

// SINGLE SOURCE OF TRUTH for `failure.reason`. Used by the import path and by
// the global runtime handler at the bottom of this file, so the two can never
// classify the same error differently.
//
// ⚠️ READS `err.name` AND NEVER `err.message`. A name is a fixed identifier
// ('PasswordException'); a message is free text that can quote the user's
// document straight back to us — a PDF parse error can carry stream content.
// This is the same discipline that keeps the export-failure branch off
// err.message, and the reason the rail is content-blind BY CONSTRUCTION rather
// than by remembering to be careful at each call site.
//
// Anything unrecognised is 'unknown', deliberately: an unclassified failure
// must still be COUNTED, or the rail goes quiet exactly when something new
// breaks. Most runtime errors will land here, and that is fine — the value is
// knowing they happen and how often, not naming them.
// isStandalone() -> the schema's enum. Never throws: a detector failure must
// not drop the whole doc_open event, which carries text_layer/pages/device too.
function displayMode() {
  try { return isStandalone() ? 'standalone' : 'browser'; } catch { return 'browser'; }
}

// failureReason moved to core/failure-reason.js (2026-07-28) so the EXPORT path
// can share it. It had to grow pdf-lib awareness to be worth sharing: pdf-lib
// throws plain `Error` for everything, so a name-only classifier reports
// 'unknown' for every export failure there is.

let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

// Pull a toast down early. Needed when a dialog opens on top of one: a toast
// lives 2.6s, so a message from the previous action can still be on screen and
// CONTRADICT the dialog. Caught by screenshotting the scan offer — the Ganti
// arm-toast ("Tap tulisan yang mau kamu ubah") was sitting under a sheet whose
// whole point is that there IS no tulisan to tap. No test could have seen that.
function hideToast() {
  clearTimeout(toastTimer);
  toastEl.classList.remove('show');
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
initInstallPrompt(); // homepage "install to home screen" chip + adaptive card (off the download moment)
// The general feedback channel: a footer link, never prompted. Separate from
// edit-feedback.js on purpose — that module owns the consent-gated image path
// and must keep a single door. See feedback-form.js's header.
initFeedbackForm();

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
  // Zoom itself still does NOT render — this only arms a timer. See the
  // focused-page sharpening block below for why that distinction is the point.
  scheduleSharpen();
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
// Declared HERE, above the stream, not down in the sharpening block where the
// rest of it lives: the rasterize adapter below closes over it, so it must be
// initialized before anything can call that adapter. See the long note on
// focusedPageId in the focused-page sharpening section.
let focusedPageId = null;
const stream = createViewportStream({
  scrollEl,
  slots: () => slots,
  rasterize: (page) => rasterizer.rasterize(page, { scale: rasterScaleFor(page) }),
  onPosition: (current, total) => {
    pill.textContent = `${current} / ${total}`;
    pill.classList.add('show');
    clearTimeout(pillTimer);
    pillTimer = setTimeout(() => pill.classList.remove('show'), 750);
    // Free ride: onPosition already walked the slots to find `current`, so the
    // focused page is known here without a second sweep. See focusedPageId.
    focusedPageId = slots[current - 1] ? slots[current - 1].page.id : null;
    // The focus moved. Debounced, so a fling costs one pass at the end of it,
    // not one per frame — and the pass is a no-op scan unless something is
    // actually sitting above the baseline.
    scheduleSharpen();
  },
});
stream.attach();

// ---- focused-page sharpening ---------------------------------------------------
// WHY: zoom is a single CSS transform on the stage (applyZoom above) and that
// stays — it is atomic, GPU composited, flicker-free, and keeps annotation
// registration exact at any zoom. But scale(3) over a RASTER_BASE raster is
// showing 6× the page out of 2× the pixels, so the paper goes soft. (Export is
// untouched and vector — export.js copyPages. We preview lossily, never ship
// lossily.)
//
// So: zoom renders NOTHING. When it SETTLES, we re-bake the ONE page under the
// viewport midline at the resolution the screen is actually painting, and we
// put it back to RASTER_BASE the moment it stops being that page or the zoom
// comes back down. Three properties this must never trade away:
//
//   1. pages stay <img> — we swap the raster inside the same tag (slot.reattach
//      → swapPageRaster), never move to a live <canvas>, which mobile browsers
//      blank under memory pressure (page-view.js header).
//   2. zoom never triggers a render — only SHARPEN_SETTLE_MS after the last
//      zoom or scroll event does.
//   3. memory stays bounded — ONCE SETTLED, at most one page holds a raster
//      above RASTER_BASE. Enforced by SCANNING every slot each pass rather than
//      by remembering an id: history.js's restore() spread-copies doc.pages into
//      fresh objects, so a remembered id survives an undo while the object it
//      named does not. The scan reads the artifact (page.raster.scale), which
//      cannot go stale.
//      ⚠️ "Settled" is not a weasel word, it is the honest bound. During a focus
//      handoff at high zoom the old page's downgrade and the new page's upgrade
//      are both in flight (deliberately — see reRasterAt), so TWO high-scale
//      rasters coexist for the length of one render. Transient, self-clearing,
//      and one extra page; it is not the unbounded case and it is worth naming
//      rather than implying an absolute the code does not deliver.
//      The fleet raster budget tests/mobile/bigdoc-stress.spec.js measures is
//      unchanged: nothing here fires unless the user zooms (sharpen.js's
//      DPR_CAP is what guarantees that), and it changes exactly one page.
//
// KNOWN, PRE-EXISTING, NOT FIXED HERE: history.js's snapshot() spread-copies
// each page, so `raster` rides into the undo stack BY REFERENCE. A Ganti commit
// made while zoomed therefore pins that commit's high-scale dataUrl in the undo
// stack (limit 50) even after the live page downgrades. This was already true at
// RASTER_BASE; sharpening multiplies the per-entry worst case by (scale/2)².
// Live/fleet memory is untouched — the undo stack is a separate budget nobody
// has ever bounded by bytes. Flagged for the seat, not fixed in this change.
const SHARPEN_SETTLE_MS = 200; // > viewport.js's settleMs (130): let the stream catch up first

let sharpenTimer = null;
// Test hooks, and the honest kind: `superseded` counts ONLY the branch where
// core/import.js's renderSeq guard discarded our render because a later one
// won. A spec asserting it can prove the supersede fired, not merely that
// nothing broke.
const sharpenStats = { issued: 0, applied: 0, superseded: 0, standDown: 0 };

// page.id -> the scale of the last rasterize WE issued that has not resolved.
//
// NOT a second cancellation mechanism — renderSeq (core/import.js) is still the
// only thing that discards a loser, and this map never cancels anything. It
// answers a different question: "where is this page HEADED?" A pass that read
// `page.raster.scale` alone would see the OLD value while a render is in flight,
// conclude there is nothing to do, issue nothing — and then the in-flight render
// would land and install a raster nobody wants any more. That is precisely the
// orphan the rapid-zoom case produces. Knowing what we asked for lets the later
// pass ISSUE the overriding call, which is what arms renderSeq.
//
// It can still go stale (a page released mid-flight, a rasterize from another
// path). That is why the pass ALSO scans `page.raster.scale`: the map catches
// what the scan cannot see yet, the scan catches what the map got wrong. Each
// covers the other's blind spot, and the scan is the one that is always
// eventually right, because it reads the artifact.
const sharpenIntent = new Map();

// The page under the viewport midline, held as an ID — not an index (pages get
// inserted and deleted) and not an object (history.js's restore() spread-copies
// doc.pages into fresh objects on undo, so a held reference goes stale in
// silence while an id does not).
//
// Updated in exactly two places, both of which already know the answer: the
// stream's onPosition, which is handed `current` for free on every scroll, and
// the start of each sharpen pass, which covers zoom, load and stage rebuilds.
//
// WHY IT IS CACHED AT ALL: rasterScaleFor sits on the STREAMING hot path — the
// stream calls it for every page entering the window. Recomputing the focus
// there would run stream.currentIndex()'s getBoundingClientRect walk once per
// entering page, inside a loop that dirties layout by swapping placeholders for
// images, i.e. a forced synchronous reflow each time. On a 120-page document
// that is the difference between linear and quadratic, on precisely the path
// tests/mobile/bigdoc-stress.spec.js exists to protect.
//
// (The `let` itself is up beside the stream — the rasterize adapter closes over
// it and would hit the temporal dead zone if it were declared here.)

function refreshFocus() {
  const i = stream.currentIndex();
  focusedPageId = i >= 0 && slots[i] ? slots[i].page.id : null;
}

function focusedSlot() {
  if (focusedPageId === null) return null;
  return slots.find((s) => s.page.id === focusedPageId) || null;
}

// The scale a given page should be rastered at RIGHT NOW. Baseline for the
// whole fleet; the sharpened scale only for the focused page. Every rasterize
// call in this file goes through here — the two hardcoded `{ scale: 2 }`s this
// replaced are exactly how the softness survived: the streaming entry path and
// the Ganti re-bake path each had their own copy of the number.
function rasterScaleFor(page) {
  if (page.id !== focusedPageId) return RASTER_BASE;
  return sharpenScale({
    pageWidth: page.width,
    pageHeight: page.height,
    zoom,
    dpr: window.devicePixelRatio,
    maxPixels: maxPixelsFor(deviceClass()),
  });
}

function scheduleSharpen() {
  clearTimeout(sharpenTimer);
  sharpenTimer = setTimeout(() => { runSharpen(); }, SHARPEN_SETTLE_MS);
}

// Where a page is HEADED: the scale of our last outstanding request if there is
// one, else the scale actually installed, else null (no raster at all — a
// released or not-yet-streamed page, which holds no memory and needs nothing).
function targetScaleOf(slot) {
  const intent = sharpenIntent.get(slot.page.id);
  if (intent !== undefined) return intent;
  return slot.page.raster ? slot.page.raster.scale : null;
}

// Re-bake ONE slot at an explicit scale and swap it in. Fire-and-forget: the
// ordering guarantee is renderSeq's, not a queue's.
async function reRasterAt(slot, scale) {
  const page = slot.page;
  sharpenIntent.set(page.id, scale);
  sharpenStats.issued += 1;
  let raster;
  try {
    raster = await rasterizer.rasterize(page, { scale });
  } catch {
    // A render can fail (a broken page, or the rasterizer destroyed under us by
    // "Buka Baru"). Nothing to show and nothing to fix — the page keeps the
    // raster it already had, which is always a valid one. Swallowed rather than
    // left to reject: these are fire-and-forget, so an unhandled rejection here
    // would surface in Sentry as an app error for something that is cosmetic.
    sharpenIntent.delete(page.id);
    return false;
  }
  if (sharpenIntent.get(page.id) === scale) sharpenIntent.delete(page.id); // settled

  // SUPERSEDE — core/import.js's renderSeq, reused rather than reinvented. It
  // already tags every rasterize with a per-page monotonic seq and lets the last
  // ISSUED win; the loser gets back the WINNER's raster and never wrote its own.
  // So we detect our loss by reading that artifact — the scale that came back is
  // not the scale we asked for — instead of keeping a flag of our own. This is
  // the whole rapid-zoom story: a 6× render still in flight when the user zooms
  // back out must not land on top of the 2× that replaced it.
  if (!raster || raster.scale !== scale) { sharpenStats.superseded += 1; return false; }
  // Stage rebuilt under us (undo/redo, page delete) — same law as rebakePage:
  // stand down rather than clobber newer state.
  if (slots.find((s) => s.page.id === page.id) !== slot) { sharpenStats.standDown += 1; return false; }
  await slot.reattach(raster);
  sharpenStats.applied += 1;
  return true;
}

function runSharpen() {
  if (!rasterizer || slots.length === 0) return;
  refreshFocus(); // once per pass — the only place the gBCR walk is affordable
  const focus = focusedSlot();
  const want = focus ? rasterScaleFor(focus.page) : RASTER_BASE;

  // DOWNGRADE FIRST. This is the whole memory guarantee: a user who zooms in and
  // back out, or zooms in and scrolls on, must not leave a 6× raster resident.
  for (const slot of slots) {
    if (slot === focus && want > RASTER_BASE) continue; // re-targeted just below
    const cur = targetScaleOf(slot);
    if (cur === null || cur <= RASTER_BASE) continue;
    reRasterAt(slot, RASTER_BASE);
  }

  // UPGRADE the focused page. Skipped when it holds no raster at all — it is
  // mid-stream, and the stream's own rasterize already asks rasterScaleFor.
  if (focus && want > RASTER_BASE && focus.page.raster && targetScaleOf(focus) !== want) {
    reRasterAt(focus, want);
  }
}

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
    // Beta note lives HERE (not just the button's title=) because a title tip
    // is desktop-hover only — ~half of pdflokal's traffic is mobile and would
    // never see "beta". The arm-toast announces it on every device, once per
    // arming, right as the user starts. Verb shifted ganti→edit to match the
    // renamed button (taste: the verb matches the interaction model everywhere).
    if (t === 'ganti') toast('Edit teks asli, fitur beta. Tap tulisan yang mau kamu ubah');
  });
}

// ---- Ganti Teks (Edit Teks Asli, Rung A — seat spec-edit-teks-asli.md) -----------
// Tap a PRINTED run → cover it with a color-matched Tip-Ex + reopen the same
// words as an editable text object, pre-selected so typing replaces. One
// gesture, ONE undo step (recorded here; the editor commit skips its own).
const textRuns = createTextRunIndex({ getDoc: () => doc });

// ---- Rung C — live doc-font preview (founder ruling, tonight 2026-07-19) ---------
// core/export.js already writes the FINAL file with the document's own
// embedded font when coverage allows it (core/stamp.js's ladder) — but until
// now the EDITOR only ever showed the twin CSS font while typing/after commit, so
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

// spec-live-surgery.md increment 2 (§3/§4/§8.2): the rasterizer's injected
// boundary onto a page's committed edits, WITHOUT core/import.js ever
// importing this v2 app module. Reuses the SAME dry-run pdf-lib doc
// smartReplace/prepareDocFont already cache per source above — copyPages
// only READS srcDoc (buildPdfBytes' own srcDocCache already shares one load
// across every page of a source the same way), so handing the throwaway
// dry-run doc to buildEditedPageBytes is safe even though it was originally
// named for a different caller.
//
// Only the PIPELINE lands here, not its trigger: nothing yet calls
// rasterizer.invalidateEditedPage() or re-rasterizes on commit/undo/redo
// (that's increment 3) — this provider just answers "what should this
// page's background be, right now" correctly whenever createPageRasterizer
// happens to ask (first render, zoom change, viewport re-entry). Any
// failure — missing source, no PDFLib/fontkit, buildEditedPageBytes
// throwing — returns null so the rasterizer falls back to the plain source
// render; a broken edited-page build must never break rasterization.
async function editedPageProvider(page) {
  try {
    if (!editSignature(page)) { page.editApplied = null; return null; } // no committed edits — today's path
    const source = getSource(doc, page.sourceId);
    if (!source) { page.editApplied = null; return null; }
    const { PDFLib, fontkit } = await ensurePdfLib();
    const srcDoc = await getDryRunDoc(PDFLib, source);
    const result = await buildEditedPageBytes(srcDoc, page, page.annotations, { PDFLib, fontkit });
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
    // events for the edit it just committed — WITHOUT this provider (which
    // also runs on plain zoom/viewport re-renders) ever firing telemetry
    // itself. Data here; the firing is gated to the commit path in commit().
    page.editOutcomes = result.outcomes || [];
    return result.bytes ? { bytes: result.bytes } : null;
  } catch (err) {
    console.warn('editedPageProvider gagal, pakai raster asli:', err);
    page.editApplied = null;
    page.editOutcomes = null;
    return null;
  }
}

// spec-live-surgery.md §5/§8.3 (increment 3): re-render `pageId`'s background
// raster from its CURRENT edit set and swap it in with no blank frame
// (page-view.js's swapPageRaster — holds the old raster until the new
// dataUrl's img.decode() resolves). Called right after a Ganti commit touches
// a page's edit set, and after any undo/redo whose edit-signature changed
// (see syncEditedRasters below). editedPageProvider (above) is what actually
// determines the applied/declined outcome, as a side effect of the SAME
// buildEditedPageBytes call the raster is built from — this function never
// re-derives that outcome itself.
//
// RETURN CONTRACT (fixed 2026-07-27, bug 1 — founder field test, 444-page
// doc): returns the raster THIS call actually attached, or a falsy value
// when it stood down. Confirmed empirically (not the originally-suspected
// mechanism — see decisions.md): calling rebuildStage() alone mid-flight
// does NOT corrupt page.raster, because rasterizer.rasterize() (core/
// import.js) writes page.raster itself as a side effect, independent of
// THIS function's own slot-identity check — that check only gates the DOM
// swap (slot.reattach), so a stood-down bake used to leave page.raster
// correct but the on-screen pixels stale. The confirmed data-corrupting path
// is undo/redo: history.js's restore() SPREAD-COPIES doc.pages into fresh
// objects (`{...p}`), so a rebakePage() in flight when that happens writes
// its result onto the now-orphaned OLD page object — invisible to anyone
// who re-reads `getPage(doc, pageId).raster` afterward, which instead sees
// whatever the POST-undo page object's raster is. On a 444-page doc the
// rasterize() await is slow enough to widen this window a lot. The caller
// (this commit's own .then()) must use THIS return value as the after-
// raster and decline entirely when it's falsy — never re-derive from
// page.raster, which may have moved on to a different object by the time
// the caller reads it. Same law as the style-race fix (stamp.js): derive
// from what was actually produced, never inherit from shared state that may
// not reflect it anymore.
async function rebakePage(pageId) {
  if (!rasterizer) return null;
  const slot = slots.find((s) => s.page.id === pageId);
  if (!slot) return null;
  const page = slot.page;
  rasterizer.invalidateEditedPage(page.id); // reuse inc.2's invalidate (spec §8.2)
  if (!editSignature(page)) page.editApplied = null; // no edits left — nothing to suppress
  // rasterScaleFor, not a hardcoded 2: committing a Ganti edit on the page you
  // are zoomed into must not SOFTEN it. Baking at the baseline here would undo
  // the sharpen at exactly the moment the user is staring at the result.
  const raster = await rasterizer.rasterize(page, { scale: rasterScaleFor(page) });
  // Stale guard: a fast undo/redo (or page delete) may have rebuilt the stage
  // while this rasterize() was in flight — only swap if this slot is still
  // the page's current, live one. syncEditedRasters below re-derives from
  // scratch for whatever page set actually ends up live, so this rebake
  // simply stands down rather than clobbering newer state.
  if (slots.find((s) => s.page.id === pageId) !== slot) return null;
  await slot.reattach(raster);
  return raster;
}

// spec-edit-fidelity-instrumentation.md Increment C: crops ONE box (page-
// space points, top-left frame — same convention as annotation x/y/w/h and
// replaceBox) out of an already-rasterized {dataUrl,width,height,scale} and
// returns it as ImageData.
//
// PM-flagged 2026-07-26: the original version of this function did a plain
// `new Image()` + drawImage, which decodes the ENTIRE page PNG synchronously
// on the main thread — twice (pristine + stamped), right when the bake
// resolves and the user is looking at their fresh edit. On a low-end phone
// with a large page that's plausibly 100-300ms of jank landing at exactly
// the wrong moment. Preferred path now: `createImageBitmap(blob, sx, sy, sw,
// sh)` decodes OFF the main thread and only the requested region — precisely
// this use case. `img.decode()`+drawImage is kept as a FALLBACK (never worse
// than before this fix) for any engine/shape where the bitmap path throws.
function boxToRasterPx(raster, box) {
  const s = raster.scale;
  return {
    cx: Math.round(box.x * s),
    cy: Math.round(box.y * s),
    cw: Math.max(1, Math.round(box.w * s)),
    ch: Math.max(1, Math.round(box.h * s)),
  };
}

// PM question, 2026-07-26: should a crop that spills past its raster's own
// edge decline outright, rather than trust ALPHA_MIN alone to neutralize the
// padding? Yes — this is the layer that CAN answer it (core/visual-oracle.js
// only ever sees already-cropped ImageData, no raster dimensions to compare
// against, see that module's own header note). A box whose requested pixels
// spill outside [0,raster.width) x [0,raster.height) means the geometry
// itself doesn't fit what's being measured against — decline before even
// fetching/decoding, rather than return a technically-alpha-correct but
// still partially-fabricated comparison.
function boxFitsRaster(raster, box) {
  const { cx, cy, cw, ch } = boxToRasterPx(raster, box);
  return cx >= 0 && cy >= 0 && cx + cw <= raster.width && cy + ch <= raster.height;
}

async function cropRasterRegion(raster, box) {
  const { cx, cy, cw, ch } = boxToRasterPx(raster, box);

  try {
    const blob = await (await fetch(raster.dataUrl)).blob();
    const bitmap = await createImageBitmap(blob, cx, cy, cw, ch);
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return ctx.getImageData(0, 0, cw, ch);
  } catch {
    // Fallback: the original main-thread Image decode. Still correct, just
    // not off-thread — covers any browser/shape that declines the bitmap
    // crop overload above.
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = raster.dataUrl; });
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, -cx, -cy);
    return ctx.getImageData(0, 0, cw, ch);
  }
}

// WHY requestIdleCallback (setTimeout fallback for Safari, which still
// doesn't ship it): measuring must not disturb what it measures. Even the
// off-thread createImageBitmap path above still ends in a main-thread canvas
// draw + getImageData — running that right when the bake resolves competes
// with the commit paint the user is watching. A telemetry number arriving
// ~200ms late costs nothing; a stutter at the commit moment costs the exact
// thing this instrument exists to protect against. Do NOT move this back
// onto the commit path as an "optimization" — that reintroduces the jank
// risk this fix removes.
function runWhenIdle(fn) {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 2000 });
  else setTimeout(fn, 0);
}

// spec-edit-fidelity-instrumentation.md Increment C: the visual oracle. Crops
// the edited line's OWN region (the cover's replaceBox — the birth-time rect
// that already bounds the ORIGINAL text, the same box surgery/insert use) out
// of the PRISTINE raster (the page as it looked right before this commit's
// bake — `prevRaster`, captured by the caller before rebakePage overwrote
// page.raster) and the STAMPED one (the raster rebakePage just produced),
// then fires content-blind ink-shape ratios. Wrapped whole and never awaited
// by its caller (fire-and-forget past that point too) — a crop/decode
// failure, a scale mismatch, or a declined compareRegions() (no ink on one
// side, e.g. a pure-deletion edit with nothing painted back) just means no
// event fires. NEVER blocks or fails the commit — same discipline as every
// other ladder event on this path (surgery/insert already follow it).
async function runVisualOracle(prevRaster, newRaster, box) {
  try {
    if (!prevRaster || !newRaster || !box) return;
    if (prevRaster.scale !== newRaster.scale) return; // different render generations — not comparable
    // Decline before ever fetching/decoding when the box would spill past
    // EITHER raster's own edge (boxFitsRaster's own WHY comment) — a line
    // near a page border, or a replaceBox wider than the remaining margin.
    if (!boxFitsRaster(prevRaster, box) || !boxFitsRaster(newRaster, box)) return;
    const [pristineImg, stampedImg] = await Promise.all([
      cropRasterRegion(prevRaster, box),
      cropRasterRegion(newRaster, box),
    ]);
    const result = compareRegions(pristineImg, stampedImg);
    if (!result) return;
    tel('visual_oracle', {
      weight_ratio: ratioBucket(result.weightRatio),
      height_ratio: ratioBucket(result.heightRatio),
      // ink_ratio (2026-07-28 incident fix): a DIFFERENT bucketer than
      // weight_ratio/height_ratio on purpose — see inkRatioBucket's own
      // header comment in core/telemetry-schema.js for why reusing
      // ratioBucket()'s cuts here would silently hide the exact defect this
      // field exists to catch.
      ink_ratio: inkRatioBucket(result.inkRatio),
      overflow: result.overflow,
    });
  } catch (err) {
    console.warn('[v2/app] visual oracle gagal (skip):', err);
  }
}

// spec-edit-fidelity-instrumentation.md Increment D: encodes ONE already-
// cropped ImageData region (the SAME crop cropRasterRegion produces for the
// oracle above — no second cropper) down to a bounded PNG data URL for the
// consent-gated feedback sample. PNG, not JPEG: these crops are a single
// text line on a flat page background — overwhelmingly solid colour with
// sharp glyph edges, exactly the content PNG's lossless compression handles
// well, while JPEG's block-DCT would blur the very glyph edges the
// founder's own bug is about ("thin vs bold") without reliably beating PNG's
// size on this content. SAMPLE_MAX_WIDTH matches the spec's "~600px wide".
const SAMPLE_MAX_WIDTH = 600;
function imageDataToSampleDataUrl(imageData) {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext('2d').putImageData(imageData, 0, 0);
  if (imageData.width <= SAMPLE_MAX_WIDTH) return canvas.toDataURL('image/png');
  const scale = SAMPLE_MAX_WIDTH / imageData.width;
  const small = document.createElement('canvas');
  small.width = SAMPLE_MAX_WIDTH;
  small.height = Math.max(1, Math.round(imageData.height * scale));
  small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height);
  return small.toDataURL('image/png');
}

// spec-edit-fidelity-instrumentation.md Increment D: the consent-gated
// sample. Reuses Increment C's own crop path (boxFitsRaster/cropRasterRegion)
// rather than a second cropper — same box, same decline discipline: a box
// that doesn't fit either raster means no sample, exactly like the oracle
// above declines a comparison it can't trust. Returns null (never throws) on
// ANY decline — a missing raster, a box that doesn't fit, or either encoded
// crop landing over its byte cap after downsampling (validateSample, shared
// with js/v2/telemetry.js and mirrored server-side in api/feedback.js).
// The caller only ever gets back a sample that's already safe to render and
// send, never a partial one.
async function captureFeedbackSample(prevRaster, newRaster, box) {
  try {
    if (!prevRaster || !newRaster || !box) return null;
    if (prevRaster.scale !== newRaster.scale) return null;
    if (!boxFitsRaster(prevRaster, box) || !boxFitsRaster(newRaster, box)) return null;
    const [beforeImg, afterImg] = await Promise.all([
      cropRasterRegion(prevRaster, box),
      cropRasterRegion(newRaster, box),
    ]);
    const sample = {
      before: imageDataToSampleDataUrl(beforeImg),
      after: imageDataToSampleDataUrl(afterImg),
    };
    return validateSample(sample); // enforces the byte caps; null if either/both over
  } catch (err) {
    console.warn('[v2/app] feedback sample gagal (skip):', err);
    return null;
  }
}

// spec-live-surgery.md §5/§8.3 (increment 3): after undo/redo swaps in a new
// set of pages, any page whose edit-signature actually CHANGED needs its
// raster re-baked — a page that lost its last edit must revert to the plain
// source render, a page whose edits came back (redo) must re-bake. Diffed by
// page.id against the PRE-history-op pages (ids are stable across undo/redo —
// history.js's snapshot/restore both spread-copy the same id onto a fresh
// object), so this is a plain signature comparison, never a re-derivation of
// WHAT changed. Pages whose signature is unchanged are left alone — undo/redo
// elsewhere in the doc must not pay for a re-bake it didn't cause.
function syncEditedRasters(prevPages) {
  const prevSig = new Map(prevPages.map((p) => [p.id, editSignature(p)]));
  for (const page of doc.pages) {
    if (editSignature(page) !== (prevSig.get(page.id) ?? '')) {
      rebakePage(page.id).catch((err) => console.warn('rebakePage (undo/redo) gagal:', err));
    }
  }
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
      return { cssFamily, fontkitFont, flavor };
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
    // ONE TARGET PER CONSTITUENT RUN, not one blended target — the same
    // correction 39e0b9f made to smartReplace's surgery geometry at the
    // bottom of this file. This call site was missed by that fix.
    //
    // WHY it matters here: a blended target takes its `size` from the LINE
    // (text-lines.js's dominant run), so planRunRemoval's per-target sizeOk
    // gate silently rejects any run painted at a materially different size,
    // and `insert` then describes only whichever ops survived that filter.
    // With per-run targets each run keeps its own size and is matched on its
    // own terms, so the answer is correct BY CONSTRUCTION rather than by
    // luck — and, just as importantly, the per-run results make a
    // multi-font line VISIBLE instead of collapsing it to one blended guess.
    //
    // Byte-identical no-op on a single-run line (the overwhelming common
    // case): `line.runs` has one entry whose `.pdf` IS `line.pdf`.
    const targets = line.runs?.length ? line.runs.map((r) => r.pdf) : [line.pdf];
    const { results } = planRunRemoval(joined, fonts, targets);
    const names = results.map((r) => r.insert?.fontName || null);

    // WHICH run's font represents the line — and what that entitles us to say
    // about it. Seat ruling 2026-07-28 (option C): the two halves of "the
    // line's font" have DIFFERENT epistemic status, so they get different
    // policies.
    //
    // FAMILY is answerable. The draft has to render in something, and the
    // DOMINANT run (widest by pdf.len) is defensible: it is already what
    // core/text-lines.js calls this line's font, it is what the hover glow
    // implies, and it is most of the glyphs. Note it is a proxy — a dash
    // leader can out-width the text it trails — but it is the same proxy the
    // rest of the system already uses, so this stays consistent rather than
    // inventing a third answer to a question that already had two.
    //
    // WEIGHT is NOT answerable on a line whose runs use different fonts. It
    // was being taken from planRunRemoval's `insert`, which reports the FIRST
    // run BY CONTENT-STREAM POSITION — a different selector from the dominant
    // one, so on `Nama : Budi` (bold label painted first, regular value wider)
    // the two disagreed and `draft.bold = draft.bold || fp.bold` bolded the
    // ENTIRE replacement, value included. Since a mixed-font line also makes
    // the native stamp decline, the twin fallback then RENDERED that wrong
    // flag — a visible defect, not just a telemetry one.
    //
    // So: answer what's answerable, decline what isn't. One policy for both is
    // what produced the defect.
    let domIdx = 0;
    for (let i = 1; i < targets.length; i += 1) {
      if ((targets[i]?.len ?? 0) > (targets[domIdx]?.len ?? 0)) domIdx = i;
    }
    const fontName = names[domIdx] || names.find(Boolean);
    if (!fontName) return; // unmatched / declined run — no font to learn
    const mixedFonts = new Set(names.filter(Boolean)).size > 1;

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
    const fp = resolveFontFingerprint(pdfPage, PDFLib, fontkit, fontName);
    if (fp.ok && !mixedFonts && (fp.bold || fp.italic)) {
      draft.bold = draft.bold || fp.bold;
      draft.italic = draft.italic || fp.italic;
      // Live-restyle the open draft the same way docFontFamily does below —
      // the twin font stays, only weight/style changes, so this is safe to
      // apply even if the doc-font FontFace load (next) ultimately declines.
      if (draft.editorEl && draft.editorEl.isConnected) draft.editorEl.style.font = textFontCss(draft);
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
        if (draft.editorEl && draft.editorEl.isConnected) draft.editorEl.style.font = textFontCss(draft);
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

    const result = await loadDocFont(page.sourceId, fontName, pdfPage, PDFLib, fontkit);
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
    if (!result) return; // extraction/parse/FontFace decline — twin stays, honestly

    // Guard: the draft may have been cancelled/committed already, or a NEWER
    // tap may have replaced it — only this draft's own reference matters.
    draft.docFontFamily = result.cssFamily;
    draft.docFontkitFont = result.fontkitFont; // commit-time coverage check (see commit())
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
    if (draft?.editorEl?.isConnected) draft.editorEl.dataset.stylePrepared = '1';
  }
}

// spec-live-surgery.md §5 Decision 3 (increment 4 — re-edit): does `x, y`
// land inside a committed edit's OWN box? Scoped to page.annotations (the
// live model — never the pristine source), so this is orthogonal to
// textRuns.hitTest, which only ever knows about the ORIGINAL bytes and would
// have no idea an edit exists at all. Boxes come from each edit's cover's
// replaceBox — the pristine-source line geometry captured at the edit's
// BIRTH, not the cover's current x/y/width/height — because that birth box
// is the one guaranteed to still be the honest target (a committed edit
// never drags, spec Decision 1, but anchoring to replaceBox rather than
// "wherever the cover currently sits" is the same defensive discipline
// core/page-surgery.js's own overlapsBirthBox already applies at export/bake
// time). Reuses core/text-lines.js's resolveTap (same clamped, finger-sized
// inflation as every other tap) scoped to just this page's edited lines, so
// a tap that's a few px off a small edited line still resolves the same way
// a fresh line tap would.
function hitTestEditedLine(page, x, y) {
  const edits = pageEdits(page);
  if (edits.length === 0) return null;
  const boxes = edits.map((edit) => ({
    x: edit.cover.replaceBox.x, y: edit.cover.replaceBox.y,
    w: edit.cover.replaceBox.w, h: edit.cover.replaceBox.h,
    edit,
  }));
  const hit = resolveTap(boxes, x, y, MIN_HIT);
  return hit ? hit.edit : null;
}

// spec-live-surgery.md §5 Decision 3 (increment 4): reopen Ganti Teks on an
// ALREADY-EDITED line. Prefills with the edit's CURRENT text (the paired
// replacement text annotation) — never the original line's words — and
// keeps the same size/font/color/box the edit already has (no re-sampling;
// matchReplaceColors already did that work when the edit was first made).
// Nothing about the model is touched here at tap time — only at commit
// (openTextEditor's commit(), the `draft.reEdit` branch) does the actual
// drop-and-reapply happen. That means Escape / no-op-retype leaves the
// existing edit completely untouched, same "nothing is true until commit"
// discipline smartReplace's own onCancel gives a fresh replace.
// Font-fidelity note: the prefill's fontFamily/bold/italic/docFontFamily are
// only the SYNCHRONOUS starting point (whatever the previous commit landed
// with) — prepareDocFont below re-derives the doc-font/clone-routing decision
// from scratch off cover.replaceTargets[0] (the pristine-source line), same
// as a fresh smartReplace, since that pristine target is the one durable
// truth a re-edit can trust (the committed replacement carries no cached
// docFontkitFont/flavor/coverage fields to reuse).
function reEditLine(pageId, cover, replacement) {
  const box = cover.replaceBox;
  track('editor_action', { action: 'ganti_teks_reedit' });
  const draft = {
    text: replacement?.text ?? '',
    fontSize: replacement?.fontSize ?? Math.min(120, Math.max(6, Math.round(box.h))),
    fontFamily: replacement?.fontFamily,
    bold: !!replacement?.bold,
    italic: !!replacement?.italic,
    color: replacement?.color,
    docFontFamily: replacement?.docFontFamily,
    // Everything commit's `draft.reEdit` branch needs to remove the PREVIOUS
    // edit and reapply a fresh one against the SAME pristine-source target
    // (Decision 3: drop-and-reapply, never surgery-on-surgery).
    reEdit: {
      coverId: cover.id,
      textId: replacement?.id ?? null,
      targets: cover.replaceTargets,
      box: { x: box.x, y: box.y, w: box.w, h: box.h },
      coverColor: cover.color,
    },
  };
  openTextEditor({ pageId, x: box.x, y: box.y, anno: null, draft });
  setTool('select');
  toastEl.classList.remove('show');
  // Re-derive the doc font / coverage-check / clone-routing decision the same
  // way smartReplace does (prepareDocFont only ever reads `line.pdf` —
  // cover.replaceTargets[0] IS that same pdf-space target, captured at the
  // original edit's birth). Fire-and-forget: the twin (already showing via
  // draft.fontFamily) is the honest fallback until/unless this resolves.
  if (cover.replaceTargets?.[0]) {
    prepareDocFont(pageId, { pdf: cover.replaceTargets[0] }, draft);
  }
}

async function smartReplace(pageId, x, y) {
  // spec-live-surgery.md §5 Decision 3 (increment 4): a tap inside an
  // ALREADY-EDITED line's own box routes to RE-EDIT, checked BEFORE the
  // fresh hitTest below — that hitTest reads pdf.js's getTextContent() off
  // the PRISTINE source (js/v2/text-runs.js), which never sees a committed
  // edit and would otherwise reopen Ganti prefilled with the ORIGINAL words,
  // silently discarding the user's own edit (the founder-verified bug this
  // increment exists to fix).
  const page = getPage(doc, pageId);
  if (page) {
    const hit = hitTestEditedLine(page, x, y);
    if (hit) { tel('ganti_tap', { hit: true }); reEditLine(pageId, hit.cover, hit.replacement); return; }
  }
  // Founder ruling 2026-07-19: the LINE is the editing primitive — hitTest
  // now resolves to a Line (core/text-lines.js), one or more fragments
  // clustered by geometry. On a single-fragment-per-line document (every
  // pre-line fixture) a Line IS a Run, so this whole flow is unchanged.
  const line = await textRuns.hitTest(pageId, x, y);
  if (!line) {
    tel('ganti_tap', { hit: false });
    const runs = await textRuns.getRuns(pageId);
    if (runs.length === 0) {
      // The router (two-ladder ruling, seat decisions.md 2026-07-18): no text
      // layer = a scan/photo — that's the dokumen-foto ladder, not this one.
      track('ganti_no_text_layer');
      showScanOffer();
    } else {
      toast('Nggak kena tulisan, tap tepat di teksnya ya');
    }
    return;
  }
  tel('ganti_tap', { hit: true });
  record(history, doc);
  const cover = addAnnotation(doc, pageId, createAnnotation('whiteout', {
    x: line.x, y: line.y, width: line.w, height: line.h,
    // Carries the surgery intent (Rung B honest-replacement — seat spec):
    // replaceTargets is an ARRAY of user-space geometry (core/redact.js's
    // frame) — ONE TARGET PER CONSTITUENT RUN, not one blended target
    // spanning the whole line (founder field report 2026-07-28: a form row
    // shaped "Label : Value, " + a dashed leader running to the margin left
    // the value's own text un-cut while `surgery` still reported
    // matched:true/clean). core/text-lines.js's assembleLine derives the
    // merged Line's OWN `pdf.size`/`ux`/`uy` from the DOMINANT run — the
    // widest one, always the dash leader here — so feeding that ONE blended
    // target into core/text-walk.js's per-target sizeOk gate silently
    // rejected the label/value run (wrong size vs. the leader's) while
    // matching the leader trivially: only the leader got cut, the real text
    // survived, and the native re-insert's origin landed at the leader's own
    // start (i.e. where the untouched original visually ENDS). Each run
    // keeps its OWN size/position here, so the SAME per-target sizeOk gate
    // correctly isolates and cuts every fragment individually — for a
    // single-fragment line (the overwhelming common case) `line.runs` has
    // exactly one entry whose `.pdf` is byte-identical to `line.pdf`
    // (text-lines.js's own assembleLine sets both from the same single run),
    // so this is a no-op there. replaceBox is this cover's OWN creation-time
    // page-space rect, so export can confirm the cover is still where it was
    // born before cutting the original show-text ops — move the cover away
    // and you've un-covered the text, so the surgery intent no longer holds
    // (see core/export.js). See core/page-surgery.js's runSurgery for the
    // matching aggregation this multi-target shape requires (mixedFonts now
    // checked ACROSS every target of one cover, not just within one).
    replaceTargets: line.runs.map((r) => r.pdf),
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
    // BUG FIX (founder phone test, 2026-07-19): solid BLACK bold text was
    // coming back visibly GRAY. Root cause — the old code ranked all 24
    // interior samples by |luminance - paper|, took the top QUARTILE (up to
    // 6 points), then took the MEDIAN of that quartile. A glyph's bounding
    // box is mostly background even for bold text (strokes cover maybe a
    // third of their own box), so most "farthest from paper" samples that
    // land near a stroke land on its ANTI-ALIASED EDGE (a partial ink/paper
    // blend), not its solid interior — genuinely solid-black pixels are rare
    // in a sparse grid. The median of a quartile stuffed with edge pixels
    // lands in the middle of the ink<->paper range: literal gray, not a
    // sampling fluke. Fix: find the single most extreme (most ink-like)
    // sample actually seen, then keep only samples within a tight band of
    // THAT extreme — the genuine ink-CORE cluster — and median only those.
    // A real solid-ink glyph always has a few pixels near its own extreme;
    // partial-coverage edge pixels fall well short of it and get excluded
    // instead of diluting the result toward gray.
    const dists = inside.map((p) => Math.abs(lumOf(p) - paperLum));
    const maxDist = inside.length ? Math.max(...dists) : 0;
    // Anti-aliased gray on plain paper must NOT tint the text — only adopt
    // the ink color when SOMETHING in the box clearly separates from paper.
    if (maxDist > 40) {
      const CORE_BAND = 0.75; // keep samples within 25% of the extreme seen
      const core = inside.filter((_, i) => dists[i] >= maxDist * CORE_BAND);
      draft.color = medColor(core);
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
    if (kind === 'draw') {
      track('editor_action', { action: 'whiteout' });
      tel('tool_use', { tool: 'tipex', action: 'whiteout' }); // spec-telemetry.md §6.2
      setTool('select');
    }
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
      tel('tool_use', { tool: 'ttd', action: storedSignature.subtype === 'paraf' ? 'paraf' : 'signature' });
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
// THE ONLY WAY THE KELOLA-HALAMAN SHEET OPENS. Two affordances reach it — the
// toolbar `Halaman` button and the File menu's `Atur Halaman` (his ruling
// 2026-08-09: the double is fine because one of them sits inside a closed
// dropdown and does not compete for attention). A second call site that
// re-implemented "open + tel" would drift: the telemetry would silently stop
// counting one of the two routes. So there is one function, and both listeners
// call it.
function openPagesSheet() {
  pageManager.open();
  // Discoverability signal (spec-telemetry.md §6.2) — armIntent()'s own note
  // above explains why this never existed before: card clicks fired NOTHING.
  // The payload stays route-agnostic on purpose: `pages_open` is pinned by
  // tests/core/telemetry-schema.test.mjs, and "which button" is not a question
  // anyone has asked of the rail.
  tel('tool_use', { tool: 'halaman', action: 'pages_open' });
}
document.getElementById('btn-pages').addEventListener('click', openPagesSheet);
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
    // spec-live-surgery.md §5/§8.3 (increment 3): did THIS commit create,
    // re-type, or clear a Ganti edit's cover/text (an annotation carrying
    // replaceCoverId, or the cover it points at)? Gates the re-bake below —
    // ordinary authored text never touches a page's edit set, so it must
    // never pay for a rasterize+swap it has no stake in.
    let touchedEdit = false;
    // Ganti/Edit telemetry (spec-telemetry.md §3): set ONLY for a Ganti
    // interaction — `draft` is always a Ganti draft (smartReplace/reEditLine;
    // plain Teks passes none) and anno.replaceCoverId marks a committed
    // replacement. gantiOutcome stays null for ordinary authored text, so
    // ganti_commit never fires for it. gantiCoverId lets the post-bake read
    // pull THIS edit's surgery/insert outcome; gantiDocFont is the synchronous
    // "did the commit land in the document's own font" signal (font_path).
    let gantiOutcome = null;
    let gantiCoverId = null;
    let gantiDocFont = false;
    if (anno) {
      if (text && text !== anno.text) {
        record(history, doc);
        updateAnnotation(doc, anno.id, { text });
        track('editor_action', { action: 'text_inline' });
        tel('tool_use', { tool: 'teks', action: 'text_inline' });
        touchedEdit = !!anno.replaceCoverId;
        if (anno.replaceCoverId) {
          gantiOutcome = 'commit'; gantiCoverId = anno.replaceCoverId; gantiDocFont = !!anno.docFontFamily;
        }
      } else if (!text) {
        record(history, doc);
        removeAnnotation(doc, anno.id);
        touchedEdit = !!anno.replaceCoverId;
        if (anno.replaceCoverId) { gantiOutcome = 'commit'; gantiCoverId = anno.replaceCoverId; }
      }
    } else if (draft && text === String(draft.text || '').trim()) {
      // BUG FIX (founder field test, 2026-07-19): tap a line, change NOTHING,
      // blur — must behave EXACTLY like the empty/Escape backout below, not
      // create a cover + a same-text replacement annotation (the founder
      // watched pixels change after "doing nothing"). Compare the committed
      // text against the PREFILL (draft.text, trimmed) — there is no `anno`
      // yet on this path, so this is the Ganti-draft equivalent of the
      // `anno` branch's own `text !== anno.text` no-op guard above.
      if (draft.onCancel) draft.onCancel();
      gantiOutcome = 'noop';
      gantiCoverId = draft.replaceCoverId ?? draft.reEdit?.coverId ?? null;
      gantiDocFont = !!draft.docFontFamily;
    } else if (text) {
      // Ganti Teks recorded its ONE undo step before the cover was placed —
      // recording again here would split one gesture into two undos. A
      // re-edit draft (below) is the mirror-image case: nothing about the
      // model was touched when the editor opened (reEditLine only reads),
      // so `recorded` is left unset on purpose — THIS is where a re-edit's
      // one undo step is born, right before its drop-and-reapply mutates
      // anything.
      if (!draft?.recorded) record(history, doc);
      let d = { ...formatBar.getDefaults(), ...(draft || {}) };
      if (draft?.reEdit) {
        // spec-live-surgery.md §5 Decision 3 (increment 4): RE-EDIT commit =
        // drop-and-reapply from the pristine source, never surgery-on-
        // surgery. Remove the previous edit's cover+text pair entirely, then
        // create a FRESH pair anchored to the SAME original target geometry
        // the first edit captured (draft.reEdit.targets/box are the OLD
        // cover's own replaceTargets/replaceBox — the pristine-source line —
        // never anything about the current, already-baked page).
        // buildEditedPageBytes always re-derives a page's edited bytes from
        // srcDoc (the untouched source) on every bake regardless of what the
        // model looked like before — this fresh pair is what keeps the
        // MODEL's own story matching that reality: exactly one edit per
        // original line, never two annotations stacked on the same target.
        removeAnnotation(doc, draft.reEdit.coverId);
        if (draft.reEdit.textId) removeAnnotation(doc, draft.reEdit.textId);
        const newCover = addAnnotation(doc, pageId, createAnnotation('whiteout', {
          x: draft.reEdit.box.x, y: draft.reEdit.box.y,
          width: draft.reEdit.box.w, height: draft.reEdit.box.h,
          color: draft.reEdit.coverColor,
          replaceTargets: draft.reEdit.targets,
          replaceBox: draft.reEdit.box,
        }));
        d = { ...d, replaceCoverId: newCover.id };
      }
      // replaceCoverId only ever comes from a Ganti Teks draft — omit the key
      // entirely for ordinary authored text rather than carry an undefined.
      const replaceProps = d.replaceCoverId ? { replaceCoverId: d.replaceCoverId } : {};
      // docFontFamily only ever lands via prepareDocFont on a Ganti draft —
      // same omit-if-absent shape, so a committed annotation without a live
      // doc font carries no dead key. render/page-view.js's textFontCss reads
      // this to keep the committed replacement looking like the document.
      const docFontProps = d.docFontFamily ? { docFontFamily: d.docFontFamily } : {};
      // styleSource (spec-edit-fidelity-instrumentation.md Increment B): the
      // fingerprint ladder rung that decided THIS draft's bold/italic —
      // carried onto the committed text annotation so stamp.js's clone rung
      // can echo it into the `insert` telemetry event at export/bake time
      // without re-deriving anything. Same omit-if-absent shape as
      // docFontProps — ordinary authored text never carries a styleSource.
      const styleSourceProps = d.styleSource ? { styleSource: d.styleSource } : {};
      // Founder ruling (2026-07-19): when a substitute font WILL be used for
      // this Ganti replacement, say so plainly at commit — decided with
      // whatever prepareDocFont has managed to load by NOW (it's async; a
      // very fast typist can commit before it lands). Rebuilt (spec-edit-
      // rebuild-composite.md increment 2, Path B): compose.js retired, so a
      // char the doc font doesn't cover natively is no longer offered a
      // "composed from the subset's own outlines" escape — it falls straight
      // to whatever core/stamp.js's resolveStampFont will actually do at
      // export (clone rung if font-decide.js routes one, else twin), and the
      // notice policy judges THAT prediction. textCoveredBy is the exact same
      // coverage function stamp.js's own doc-subset rung calls at commit time
      // (imported from core/stamp.js, not reimplemented) — the toast can never
      // drift from what export actually does. Clone/twin substitutes keep this
      // one unchanged sentence — one grammar for every substitute tier
      // (ratified over per-tier wording). Ordinary (non-Ganti) text never
      // carries replaceCoverId, so never toasts here.
      if (d.replaceCoverId) {
        const covered = !!d.docFontkitFont && textCoveredBy(d.docFontkitFont, text);
        // Name-only ruling (2026-07-20 evening): a file with NO embedded
        // program + an exact metric clone routed = nothing real was
        // substituted — silent. See prepareDocFont for the fields' WHY.
        const nameOnlyClone = d.fontUnembedded && d.cloneRouted;
        if (!covered && !nameOnlyClone) toast('Huruf ini memakai font pengganti yang mirip');
        // font_path is 'doc-font' only when the document's OWN font paints
        // this — a name-only clone is still a substitute, so it reads as
        // 'twin' (the schema's font_path enum has no separate 'clone' value).
        gantiOutcome = 'commit';
        gantiCoverId = d.replaceCoverId;
        gantiDocFont = covered;
      }
      const created = addAnnotation(doc, pageId, createAnnotation('text', {
        text, x, y,
        fontSize: d.fontSize, fontFamily: d.fontFamily,
        bold: d.bold, italic: d.italic, color: d.color,
        ...replaceProps,
        ...docFontProps,
        ...styleSourceProps,
      }));
      // Authored text stays SELECTED (the user sees it's an object; a format
      // tweak right after the blur-commit still lands). A Ganti Teks commit
      // does NOT auto-select: post-commit selection resurfaces the format bar
      // on the flow's last frame — the redefine-invitation the founder ruled
      // out (taste-judge finding, night run 2026-07-19). A later deliberate
      // tap still selects it like any text object — one grammar, kept.
      if (!draft) selectAnnotation(doc, created.id);
      // TELL THEM NOW, WHILE THE CURSOR IS STILL THERE. A standard font encodes
      // through WinAnsi; an emoji or a CJK character in one makes pdf-lib throw
      // at export, and core/export.js has no per-annotation guard, so the whole
      // document fails to save. Discovering that at Unduh means discovering it
      // after all the work is done (2026-07-28: 41 attempts, 82 minutes, zero
      // exports). Here it costs one keystroke to fix.
      //
      // WARN, never DROP (founder ruling via PM, 2026-07-29): deleting a
      // character the user can SEE is worse than telling them about it. The
      // export decline stays as the backstop. Same shape as the encrypted-PDF
      // warning at import.
      // AUTHORED TEXT ONLY. A Ganti Teks replace has already run a real
      // coverage check against the document's own font a few lines up, and
      // says something more precise ("font pengganti yang mirip"). Warning
      // here too would overwrite that with a blunter message, and would be a
      // FALSE ALARM whenever the clone font can paint the glyph (Arimo has
      // Cyrillic; the export would have been fine). Caught by
      // tests/font-coverage.spec.js, which is exactly what it is there for.
      if (!d.replaceCoverId && isStandardFamily(d.fontFamily)) {
        const bad = unencodableInStandardFont(text);
        if (bad.length) {
          // COPY IS PLACEHOLDER - client-facing words are Fauzan's, per the seat.
          toast(`Huruf ${bad.slice(0, 3).join(' ')} nggak bisa disimpan pakai font ini`); // TODO(copy): his words
          // `class` from the FIRST offending character only, through
          // unsupportedCharClass — which returns an enum and nothing else, so
          // the character cannot ride along. 'emoji' and 'cjk' are entirely
          // different product problems and were indistinguishable here until
          // 2026-08-09. blocked:false because this is a WARN, not a DROP: the
          // text below is committed either way (founder ruling 2026-07-29).
          tel('failure', {
            stage: 'commit',
            reason: 'unsupported',
            class: unsupportedCharClass(bad[0]),
            blocked: false,
          });
        }
      }
      track('editor_action', { action: 'text' });
      tel('tool_use', { tool: 'teks', action: 'text' });
      touchedEdit = !!d.replaceCoverId;
    } else if (draft?.onCancel) {
      // Ganti Teks backed out with nothing typed — take the cover back too.
      draft.onCancel();
      gantiOutcome = 'cancel';
      gantiCoverId = draft.replaceCoverId ?? draft.reEdit?.coverId ?? null;
      gantiDocFont = !!draft.docFontFamily;
    } else if (draft?.reEdit) {
      // EMPTY RE-EDIT COMMIT = DELETE THE EDIT (founder ok, 2026-08-09 —
      // maintenance audit finding 1). Same grammar as the `anno` branch above:
      // committing empty removes the thing being edited — here, the edit pair
      // itself, so the ORIGINAL printed text returns on the next bake. Before
      // this branch existed, an empty re-edit fell through every case and
      // silently did nothing: the user deleted the text, blurred, and watched
      // the baked replacement come back — with no way to reach the edit via
      // Hapus either (a baked edit's cover+text are suppressed from the
      // overlay, so they are untappable). Escape does NOT land here — the
      // keydown handler restores the prefill first, which the no-op guard
      // absorbs.
      record(history, doc);
      removeAnnotation(doc, draft.reEdit.coverId);
      if (draft.reEdit.textId) removeAnnotation(doc, draft.reEdit.textId);
      touchedEdit = true;
      gantiOutcome = 'commit';
      gantiCoverId = null; // the pair is gone — no post-bake outcome to read
      gantiDocFont = false;
    }
    syncPage(pageId);
    setTool('select');
    // ganti_commit (spec-telemetry.md §3): fires for EVERY Ganti interaction
    // outcome — commit / cancel / noop — never for ordinary authored text
    // (gantiOutcome stays null). Synchronous: font_path is the draft-time
    // reality the user committed in, distinct from the export-time `insert`
    // event fired post-bake below.
    if (gantiOutcome) {
      tel('ganti_commit', { outcome: gantiOutcome, font_path: gantiDocFont ? 'doc-font' : 'twin' });
    }
    // spec-live-surgery.md §5/§8.3 (increment 3): a Ganti edit's cover/text
    // just changed — bake it into the page's raster now, then re-sync the
    // overlay once the bake resolves so the suppression (page.editApplied)
    // matches the new reality. Fire-and-forget from commit()'s own POV: the
    // tool has already returned to Pilih; the brief window before the bake
    // lands (~85-90ms, spec §6) is the same latency the taste-judge already
    // accepted, and the raster swap itself never flashes (page-view.js's
    // swapPageRaster holds the old raster until the new one decodes).
    if (touchedEdit) {
      const t0 = performance.now();
      // Increment C (visual oracle): snapshot the PRISTINE raster + the
      // edited line's own box BEFORE rebakePage overwrites page.raster with
      // the stamped one — this is the one moment both renders exist at once.
      const pageBeforeBake = getPage(doc, pageId);
      const prevRaster = pageBeforeBake?.raster || null;
      const oracleBox = gantiCoverId
        ? pageBeforeBake?.annotations.find((a) => a.id === gantiCoverId)?.replaceBox
        : null;
      rebakePage(pageId).then((attachedRaster) => {
        syncPage(pageId);
        // commit_paint (spec-telemetry.md §3): the REAL device commit→pixels
        // latency the desktop-only spike could never measure — the ladder's
        // whole reason for the rail. surgery/insert read THIS edit's outcome
        // off the fresh bake (editedPageProvider stashed page.editOutcomes as a
        // side effect of the SAME buildEditedPageBytes call this rebake ran).
        tel('commit_paint', {
          duration: durationBucket(performance.now() - t0),
          pages: pagesBucket(doc.pages.length),
          device: deviceClass(),
        });
        const page = getPage(doc, pageId);
        const oc = gantiCoverId && page?.editOutcomes?.find((o) => o.coverId === gantiCoverId);
        if (oc) {
          tel('surgery', oc.surgery);
          if (oc.insert) tel('insert', oc.insert);
        }
        // BUG 1 FIX (2026-07-27, founder field test on a 444-page doc): the
        // "after" raster for the oracle/sample MUST be what rebakePage()
        // actually attached (its return value), never a fresh re-read of
        // `page?.raster` — that shared property can belong to a DIFFERENT
        // page object by the time this .then() runs (confirmed mechanism:
        // an undo/redo mid-bake replaces doc.pages with fresh objects via
        // history.js's restore(); rebakePage's own return-null-on-stand-down
        // contract is what lets this line stop trusting stale shared state).
        // A falsy attachedRaster means THIS bake stood down — decline BOTH
        // the oracle and the sample entirely rather than risk silently
        // comparing pristine-vs-pristine (a confident "near-parity"/
        // identical-crop result from a comparison that never actually
        // happened is exactly the failure this instrumentation exists to
        // prevent, worse on big docs where the race is most likely).
        if (attachedRaster) {
          // Increment C: snapshot done, but defer the actual crop+decode+
          // compare work to idle (runWhenIdle's own WHY comment) — never
          // awaited either way, so a slow/failed comparison can't delay
          // anything below it (the feedback ask, or any future code here);
          // runVisualOracle's own try/catch is the last line of defense
          // regardless of when it runs.
          runWhenIdle(() => runVisualOracle(prevRaster, attachedRaster, oracleBox));
        }
        // Beta feedback: ask once, on the first successful commit of this doc.
        if (gantiOutcome === 'commit' && !feedbackAsked) {
          feedbackAsked = true;
          showEditFeedback();
          // Increment D: only THIS commit's sample is ever worth capturing —
          // the pill never reopens after (feedbackAsked latches above), so
          // every later commit skips the encode work entirely. Deferred to
          // idle for the SAME reason as the oracle above (runWhenIdle's own
          // WHY comment): capture must never compete with the commit paint
          // the user is watching. setFeedbackSample() is a safe no-op if the
          // round already resolved (an impatient 👍) by the time this lands.
          // A falsy attachedRaster means: don't even attempt the capture —
          // the pill simply doesn't offer the sample this time (same
          // silent-decline discipline as a box that doesn't fit the raster).
          if (attachedRaster) {
            runWhenIdle(() => {
              captureFeedbackSample(prevRaster, attachedRaster, oracleBox)
                .then(setFeedbackSample)
                .catch(() => setFeedbackSample(null));
            });
          }
        }
      }).catch((err) => console.warn('rebakePage gagal:', err));
    }
  };

  ed.addEventListener('blur', commit);
  ed.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ed.blur(); }
    // Escape = back out. Restore what the editor OPENED with, so commit()'s
    // no-op guards absorb it: the annotation's own text, or a RE-EDIT's
    // prefill (draft.text). Restoring '' on a re-edit would read as a
    // deliberate empty commit — which now DELETES the edit (the
    // `draft.reEdit` empty branch below) — the opposite of backing out.
    // A fresh Ganti draft keeps '' on purpose: its empty commit is the
    // cancel that takes the cover back.
    if (e.key === 'Escape') { ed.textContent = anno?.text ?? (draft?.reEdit ? draft.text : '') ?? ''; ed.blur(); }
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
  tel('tool_use', { tool: 'hapus', action: 'delete' }); // spec-telemetry.md §6.2
  if (pageId) syncPage(pageId);
}

// spec-live-surgery.md §5/§8.3 (increment 3): undo/redo can bring a page's
// committed edits into or out of existence — capture the PRE-op pages so
// syncEditedRasters can diff edit-signatures by page.id afterward and
// re-bake only the pages that actually changed.
function doUndo() {
  const prevPages = doc.pages;
  if (undo(history, doc)) { pageManager.invalidateThumbs(); rebuildStage(); syncEditedRasters(prevPages); }
}
function doRedo() {
  const prevPages = doc.pages;
  if (redo(history, doc)) { pageManager.invalidateThumbs(); rebuildStage(); syncEditedRasters(prevPages); }
}
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
  // A fresh document (first load / after Buka Baru) is a new editing session —
  // the beta feedback may be asked again. A merge-add into an open doc doesn't reset.
  if (doc.pages.length === 0) resetEditFeedback();
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
  const pagesBefore = doc.pages.length;
  const firstLoad = pagesBefore === 0;
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
      // Capture the declared intent SYNCHRONOUSLY, before any await/async .then:
      // applyIntent() clears pendingIntent after this loop, and the PDF branch's
      // doc_open fires from a probe .then that can resolve later — reading it
      // inside the callback would race to 'none'. intentValue() also sanitises a
      // user-controlled ?buat= down to the enum. (Merge-adds are !firstLoad with
      // pendingIntent already null → 'none', which is correct: only the opening
      // file carries the arrival intent.)
      const docIntent = intentValue(pendingIntent);
      if (isPdf(f)) {
        const importedPages = await importPdf(doc, { name: f.name, bytes });
        // A protected PDF opens and renders perfectly (PDF.js decrypts) but can
        // NEVER be written back — pdf-lib has no decryption. Say so HERE, at
        // import, rather than letting them edit a 444-page document and meet
        // the failure at Unduh (founder field report, the KBLI table).
        //
        // Viewing is left completely alone on purpose: PDF.js renders these
        // fine, and refusing the file outright would throw away real value for
        // no reason. We warn about the edge, we don't build a wall.
        //
        // We CANNOT offer to remove the protection — no decrypt path exists
        // anywhere in this stack (pdf-lib: none; pdf-encrypt-lite: RC4 encrypt
        // only) — so this must never imply one.
        //
        // COPY IS PLACEHOLDER — client-facing words are Fauzan's, per the seat.
        if (doc.sources.at(-1)?.encrypted) {
          toast('PDF ini terkunci, bisa dibaca, tapi nggak bisa disimpan ulang'); // TODO(copy): his words
          // blocked:FALSE — this file OPENED and is fully editable. It shares
          // its stage and reason with the genuine decline further down (the
          // file that could not be opened at all), and until 2026-08-09 the
          // only thing telling them apart on the rail was whether a `doc_open`
          // happened to arrive alongside — a per-session join, unreliable by
          // construction. See the failure event's own note in
          // core/telemetry-schema.js.
          tel('failure', { stage: 'import', reason: 'encrypted', class: 'none', blocked: false });
        }
        // doc_open (spec-telemetry.md §3 — scan-vs-born-digital ratio). The
        // text-layer probe re-opens the PDF independently (probeTextLayer,
        // core/import.js) — NOT awaited: it must never slow down a multi-file
        // merge loop, and a probe failure is just "don't know" (dropped).
        probeTextLayer(bytes)
          .then((hasText) => tel('doc_open', {
            text_layer: hasText, pages: pagesBucket(importedPages.length), device: deviceClass(), intent: docIntent,
            display_mode: displayMode(),
          }))
          .catch(() => {});
      } else {
        await importImage(doc, { name: f.name, bytes, mimeType: f.type });
        // An image page has no text layer at all — that's the scan ladder's
        // own job (spec-edit-dokumen-foto.md), not this rail's.
        tel('doc_open', { text_layer: false, pages: pagesBucket(1), device: deviceClass(), intent: docIntent, display_mode: displayMode() });
      }
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
      // ALSO on the first-party rail (telemetry suite class D, 2026-07-28).
      // This used to be GA4-only, which meant the single clearest "is it
      // broken?" signal we have — a file the user could not open at all — was
      // invisible to the rail the auto-push policy leans on, and ad-blockers
      // drop GA4 wholesale for a large share of our users.
      //
      // The reason is classified from the error's NAME, never its message: a
      // name is a fixed identifier ('PasswordException'), a message can quote
      // the document back to us. Same discipline as the export-failure branch.
      // Anything we cannot classify is 'unknown' — which must stay COUNTED,
      // because an unclassified failure is exactly when the rail needs to be
      // loud rather than silent.
      // blocked:TRUE — the genuine decline. This file did not open at all, so
      // the user is standing still. Its twin above (the protected-PDF notice)
      // carries the same stage and reason and blocked:false.
      tel('failure', { stage: 'import', reason: failureReason(err), class: 'none', blocked: true });
    }
  }

  // Every file failed → leave the landing untouched, say it plainly, bail. Also
  // guards the doc.pages[0] read below, which would throw on an empty document.
  if (doc.pages.length === 0) {
    toast(usable.length === 1
      ? 'File itu nggak bisa dibuka, mungkin kosong atau rusak'
      : 'Nggak ada file yang bisa dibuka, mungkin kosong atau rusak');
    return;
  }

  // Every page takes the width of the first page (founder note 6 Aug 2026).
  // The rule and all its edge cases live in core/operations.js — this is only
  // the trigger, and it is HERE rather than inside importPdf/importImage on
  // purpose: normalising per-file would re-run mid-loop and anchor on a
  // document that isn't finished assembling yet. It runs after the whole batch,
  // once, and no-ops unless two or more files actually contributed pages.
  //
  // Placed BEFORE the rasterizer and rebuildStage below: both read page.width,
  // and a raster taken at the pre-normalisation size would have to be thrown
  // away immediately.
  normalizePageWidths(doc);

  if (!rasterizer) rasterizer = createPageRasterizer(doc, { editedPageProvider });
  emptyEl.style.display = 'none';
  // Capture BEFORE clearing: this is the real "editor becomes active" transition,
  // and it must fire exactly once. `firstLoad` (pagesBefore === 0) is NOT the same
  // signal — Buka Baru (resetDoc) also produces pagesBefore === 0 on the very next
  // loadFilesInner call, but is-empty was already removed and never re-added, so
  // gating on firstLoad here would push a second, orphaned back-button guard entry
  // every time someone starts over. See wireDialogHistory below for the other half.
  const wasEmpty = document.body.classList.contains('is-empty');
  document.body.classList.remove('is-empty'); // landing yields, editor chrome returns
  if (wasEmpty) pushEditorHistoryState();

  if (firstLoad) {
    zoom = Math.min(1, (scrollEl.clientWidth - 16) / doc.pages[0].width);
  }
  rebuildStage(); // applies zoom + sizer at the end
  // A non-first load that actually grew the doc IS a merge (gabung). Fire at
  // COMPLETION so it counts real merges from EVERY entry point — the [+] tile,
  // the File menu, dropping more files onto an open doc — not sheet-opens. GA4's
  // gabungkan_used fired on page-manager open, which also covers split/reorder/
  // delete; this is the clean, merge-only signal the first-party rail lacked.
  if (!firstLoad && doc.pages.length > pagesBefore) {
    tel('tool_use', { tool: 'gabung', action: 'merge' });
  }
  // Honest close-out: skips take priority over the merge tally — the user needs to
  // know something was left out more than they need the count.
  if (failed > 0) {
    toast(`${failed} file dilewati, kosong atau rusak`);
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

// Mobile navbar burger — Github / Dukung / Bahasa live behind it below 900px.
// CSS hides the button and the drawer above that width; the listeners below
// cost nothing to keep attached at desktop widths, same as lihatBtn above.
const burgerBtn = document.getElementById('ld-burger');
const burgerMenu = document.getElementById('ld-burger-menu');
if (burgerBtn && burgerMenu) {
  const closeBurger = () => {
    burgerMenu.hidden = true;
    burgerBtn.setAttribute('aria-expanded', 'false');
  };
  const openBurger = () => {
    burgerMenu.hidden = false;
    burgerBtn.setAttribute('aria-expanded', 'true');
  };
  burgerBtn.addEventListener('click', () => {
    if (burgerMenu.hidden) openBurger(); else closeBurger();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !burgerMenu.hidden) {
      closeBurger();
      burgerBtn.focus();
    }
  });
  // Click outside the open drawer (and not on the button that opened it) closes it.
  document.addEventListener('click', (e) => {
    if (burgerMenu.hidden) return;
    if (burgerMenu.contains(e.target) || burgerBtn.contains(e.target)) return;
    closeBurger();
  });
}

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
document.getElementById('fm-pages').addEventListener('click', () => {
  toggleFileMenu(false);
  openPagesSheet(); // the SAME opener the toolbar button uses — never a second one
});

// Start over: a FRESH doc + history. The signature stays (it's the user's,
// not the document's). Cancelling the picker leaves everything untouched.
async function resetDoc() {
  doc = createDoc();
  history.undoStack.length = 0;
  history.redoStack.length = 0;
  // Page ids are module-global monotonic (core/model.js's _seq) — the old
  // doc's thumbnail cache entries can never be hit again OR evicted, so
  // without this they are pure retained garbage, megabytes per Buka Baru on
  // a large document (maintenance audit 2026-08-09, finding 3).
  pageManager.invalidateThumbs();
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

// ---- Android back button: closes the open sheet OR asks before leaving, never
// leaves the app silently ----------------------------------------------------------
// Every dialog open pushes one history entry; the hardware/gesture back pops it
// and we close the dialog. UI-initiated closes (✕, backdrop, Escape, success)
// consume their entry with history.back() — guarded so our own back() doesn't
// cascade into closing the next dialog underneath (nested pm-over-download case).
//
// Below ALL of that sits one more entry, pushed once when a document loads
// (loadFilesInner, `pushEditorHistoryState` below) — every dialog entry stacks on
// TOP of it, never replaces it. Without this entry, back with no sheet open popped
// straight out of the site with no confirmation, silently discarding an unsaved
// document. With it, back with no sheet open lands here and the popstate handler
// below offers #home-confirm instead — the same dialog the wordmark (`#btn-home`)
// already uses, so cancel/confirm are not duplicated, just reused.
function pushEditorHistoryState() {
  window.history.pushState({ v2doc: true }, '');
}

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

    // Landed on neither a dialog entry NOR our own guard entry, with the editor
    // still active → back walked (or was coalesced) straight past the guard
    // toward leaving the app. Ask, don't leave. Re-push the guard FIRST, so it
    // sits beneath the dialog entry showModal() is about to push — cancelling
    // #home-confirm then lands back on a guarded entry (its `close` handler
    // above just calls history.back(), same as any other dialog), and a second
    // real back reaches this exact branch again instead of exiting straight
    // through. Skipped when `cur` is set (a dialog is still open, handled by
    // the cascade above) or when we're already sitting on the guard entry
    // itself (nothing to do — this is the normal "sheets closed, doc open" rest
    // state, e.g. after the nested-sheet peel-back above).
    if (!cur && !window.history.state?.v2doc && !document.body.classList.contains('is-empty')) {
      pushEditorHistoryState();
      document.getElementById('home-confirm').showModal();
    }
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
  getRasterizer: () => rasterizer, // tests: drive the real live-surgery raster path (tests/live-raster.spec.js)
  celebration, // tests: drive the post-download routing (install nudge vs share card)
  // tests/zoom-sharpen.spec.js. `superseded` is the honest one: it counts ONLY
  // renders that core/import.js's renderSeq guard threw away because a later
  // render for the same page won. A spec can therefore prove the supersede
  // fired, rather than proving nothing visibly broke.
  getSharpenStats: () => ({ ...sharpenStats, base: RASTER_BASE }),
};

// ---- The scan dead end -------------------------------------------------------------------
// Someone tapped Edit on a page with NO TEXT LAYER — a scan or a photo. Until
// 2026-07-28 that was a dead end: one toast, and nothing else. ~6% of daily
// users were walking into it and the number was rising, because Edit is new.
//
// Tip-Ex and Teks ALREADY work on a scan — they cover and write over the image.
// What was missing was the affordance, not the capability. So: EXPLAIN, then
// offer. Never silently swap the tool — that would be the app doing something
// the user didn't ask for (seat ruling).
//
// The copy must NOT imply OCR is coming; that is an open founder call.
//
// `accepted` fires when the tool is actually ARMED, never on the button click.
// A click measures the button; we need the behaviour. And it fires ONLY from
// this offer — someone arming Tip-Ex on a scan without hitting the wall is
// normal use (whiting out a signature line, filling a scanned form) and counting
// it would import a population that never wanted OCR. The organic case is a rail
// QUERY over the sequence, which per-event timestamps now make answerable.
function showScanOffer() {
  const dlg = document.getElementById('scan-offer');
  if (!dlg) { toast('Halaman ini hasil scan/foto, teksnya belum bisa diedit'); return; }
  // The arm-toast from arming Ganti is still on screen and says the opposite of
  // what this sheet says. One message at a time.
  hideToast();

  // EXACTLY ONE outcome event per showing. `resolved` is a closure flag, not DOM
  // state: the close handler below fires on every close INCLUDING the ones the
  // buttons trigger, so without this a user who accepts would be counted as
  // having both accepted AND dismissed — inflating both halves of the number the
  // OCR decision rests on.
  let resolved = false;
  const settle = (props) => {
    if (resolved) return;
    resolved = true;
    tel('scan_offer', props);
  };

  const take = (toolId, name) => () => {
    setTool(toolId);
    // Report acceptance only if the tool genuinely ARMED. If setTool declined,
    // the user did not get what they asked for, and recording it as accepted
    // would overstate how well the offer works.
    if (tool === toolId) settle({ action: 'accepted', tool: name });
    else settle({ action: 'dismissed', tool: 'none' });
    dlg.close();
  };

  dlg.querySelector('#so-tipex').onclick = take('tipex', 'tipex');
  dlg.querySelector('#so-teks').onclick = take('teks', 'teks');
  dlg.querySelector('#so-dismiss').onclick = () => { settle({ action: 'dismissed', tool: 'none' }); dlg.close(); };
  // Backdrop or Escape counts as a dismissal too: someone who closes without
  // choosing has rejected the offer just as much as one who taps "Nanti aja",
  // and treating those differently would flatter the affordance.
  dlg.addEventListener('close', function once() {
    dlg.removeEventListener('close', once);
    settle({ action: 'dismissed', tool: 'none' });
  });

  tel('scan_offer', { action: 'shown', tool: 'none' });
  dlg.showModal();
}


// ---- Global error capture -> the first-party rail ---------------------------------------
// WHY THIS EXISTS (2026-07-28, telemetry suite class D): Editor v2 had NO global
// error capture of ANY kind. `js/lib/errors.js` looks like it covers this, but it
// is imported only by `js/init.js`, which is loaded only by `alat-gambar.html` —
// the OLD wing. So on the live product an uncaught error reached Sentry and
// nothing else: not GA4, not the first-party rail. That is a direct hole in
// "the telemetry catches everything", which is the precondition of the auto-push
// policy — the rail could not answer "is it broken?" for the one class of
// failure that means the app fell over.
//
// CONTENT-BLIND BY CONSTRUCTION, not by care: this sends a stage and a bucketed
// reason, and `SCHEMA` has no string-typed prop anywhere, so an error message
// CANNOT ride along even by accident. That is the property the GA4 path lacks —
// it is why the fix is "emit an enum here" rather than "sanitise the message
// there". We never read `err.message`; a name is a fixed identifier, a message
// can quote the user's document back to us.
//
// CAPPED on purpose: one broken rAF or scroll handler can throw thousands of
// times a second, and an unbounded handler would flood the batch queue and
// evict real events. After the cap we stop reporting — the first few are what
// tell us something broke; the rest tell us nothing new and cost us signal.
const RUNTIME_FAILURE_CAP = 5;
let runtimeFailures = 0;

function reportRuntimeFailure(err) {
  try {
    if (runtimeFailures >= RUNTIME_FAILURE_CAP) return;
    runtimeFailures += 1;
    // blocked:true — an uncaught throw is a real failure, never a forewarning.
    tel('failure', { stage: 'runtime', reason: failureReason(err), class: 'none', blocked: true });
  } catch {
    // Error reporting must never itself throw into app code — same law as tel().
  }
}

window.addEventListener('error', (e) => reportRuntimeFailure(e?.error));
window.addEventListener('unhandledrejection', (e) => reportRuntimeFailure(e?.reason));

// ---- PWA: register the service worker ---------------------------------------------------
// Enhancement only — makes the app installable + offline. Silent-fail on purpose:
// a registration error must NEVER surface to the user or block the editor. Shared
// by index.html AND the generated SEO pages (all register the same root-scoped SW).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
