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

import { createDoc, createAnnotation, getPage, findAnnotation, isCopyable, cloneForPaste } from '../core/model.js';
import { failureReason, failureCause } from '../core/failure-reason.js';
import { isStandardFamily, unencodableInStandardFont } from '../core/text-encode.js';
import {
  addAnnotation, removeAnnotation, updateAnnotation, clearSelection, selectAnnotation,
  moveAnnotation, normalizePageWidths, duplicateAnnotation,
} from '../core/operations.js';
import { createHistory, record, undo, redo, canUndo, canRedo, markClean, markChanged, settle } from '../core/history.js';
import { setLeaveGuard } from './leave-guard.js';
import { rasterFitsShape } from '../core/raster-key.js';
import { importPdf, importImage, createPageRasterizer, probeTextLayer, pdfLibLoadError } from '../core/import.js';
import {
  pagesBucket, durationBucket, intentValue,
  unsupportedCharClass, ocrLinesBucket, zoomBucket,
} from '../core/telemetry-schema.js';
import { createOcrIndex, ocrEngineLoaded } from './ocr-runs.js';
import { scanAppearance, scanPaper } from './scan-appearance.js';
import { createPageSlot, pageDisplaySize, syncOverlay, textFontCss, applyTextFont, measureTextAnnoWidth } from '../render/page-view.js';
import { createViewportStream } from '../render/viewport.js';
import { RASTER_BASE, sharpenScale, maxPixelsFor, imageScaleCap } from '../render/sharpen.js';
import { createInteraction } from '../render/interaction.js';
import { createFormatBar } from './format-bar.js';
import { createTextRunIndex, mapRunFont, MIN_HIT } from './text-runs.js';
import { createGantiSteer } from './ganti-steer.js';
import { resolveTap, draftFontSize } from '../core/text-lines.js';
import { createPageManager } from './page-manager.js';
import { createPageStrips } from './page-strip.js';
import { createSignatureModal } from './signature-modal.js';
import { createDownloadSheet } from './download-sheet.js';
import { track } from '../lib/analytics.js';
import { t as tr } from '../lib/i18n.js';
// ⚠️ IMPORTED UNDER A DIFFERENT NAME, and the local `tel` below wraps it.
// WHY: the bug-report prompt needs "the first COMMITTED edit of the day", and
// there is no single commit chokepoint — outcomes fire from nine call sites
// (whiteout, text, text_inline, signature, paraf, delete, merge, ganti_commit).
// Touching all nine would be nine chances to miss one, and a tenth tool added
// later would silently not count. The rail ALREADY draws the line this needs:
// 2026-09-10 split `tool_use` into intent ('arm', 'sig_modal_open') and outcome.
// Wrapping the one function every one of them already calls means the prompt
// inherits that taxonomy instead of keeping a second copy of it.
import { tel as telSend } from './telemetry.js';
import { createBugReportPrompt } from './bug-report-prompt.js';
import { showEditFeedback, dismissEditFeedback, setFeedbackSample } from './edit-feedback.js';
import { initFeedbackForm } from './feedback-form.js';
import { createCelebration } from './celebrate.js';
import { initInstallPrompt, isStandalone } from './install-prompt.js';
import { initMakerCard, initVisitorCount } from './maker-card.js';
import { initH1Rotation } from './h1-rotation.js';
import { applyIntentCopy } from './intent-copy.js';
import { ensurePdfLib } from '../core/vendor.js';

// ---- the bug-report prompt's edit trigger -------------------------------------
// The actions on `tool_use` that mean AN EDIT WAS APPLIED TO THE DOCUMENT.
// Deliberately NOT the whole enum: 'arm' and 'sig_modal_open' are the INTENT half
// (a tool reached for, nothing changed), 'select' is picking a tool, and
// 'pages_open' opens a sheet. None of those is a commit, and counting them would
// fire the prompt at someone who has not yet done anything they could find a bug
// in. `ganti_commit` is its own event, not a tool_use, so it is named separately.
const COMMIT_ACTIONS = new Set(['whiteout', 'text', 'text_inline', 'signature', 'paraf', 'delete', 'original_delete', 'merge']);
const bugPrompt = createBugReportPrompt();

// Every existing `tel(...)` call site keeps working untouched — this is the one
// place that knows the prompt exists.
function tel(event, props) {
  telSend(event, props);
  // ⚠️ TOTAL, and in this order. Telemetry is the load-bearing call; a nudge is
  // not. If anything in here ever throws, it must not take the rail down with it
  // — that would be a cosmetic feature breaking an instrument, which is the
  // inversion this codebase keeps paying for.
  try {
    if (event === 'ganti_commit' || (event === 'tool_use' && COMMIT_ACTIONS.has(props?.action))) {
      bugPrompt.onEditCommit();
    }
  } catch { /* a prompt may never break the rail */ }
}
import { textCoveredBy } from '../core/stamp.js';
import { faceStyle } from '../core/line-font.js';
import {
  toastDurationMs, firstTimeForDoc, alreadyShownForDoc, armEditNoticeKey, lineOutgrew,
} from './edit-expectations.js';
import { planBlockEdit, blockOfLine, blockAnnotation, logicalTextOf } from '../core/block-edit.js';
import { totalPageRotation } from '../core/page-rotation.js';
import { styleBlockEditor, placeBlockEditor, readEditorLines } from './block-editor.js';
import { pageEdits } from '../core/page-surgery.js';
import { whiteoutRingPoints, whiteoutColorFrom, paperPoints, inkPoints, coverColorFrom, inkColorFrom } from '../core/color-sample.js';
import { hitTestEditedLine, hitTestOcrEdit, editOwningLine } from '../core/edit-hit.js';
import { createEditBake, runWhenIdle } from './edit-bake.js';
import { createDocFontLive } from './doc-font-live.js';

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
const history = createHistory(undefined, { carryRaster: rasterFitsShape, onDirtyChange: setLeaveGuard });
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

// ---- on(): the ONLY way this file binds a listener at module top level --------
// WHY: every binding below runs while the module is EXECUTING, so a throw here
// aborts the whole graph — no editor, no toolbar, and no telemetry either,
// because js/v2/telemetry.js is imported by this same graph and dies with it.
// A top-level bind straight onto a #fm-pages lookup did exactly that
// for real users (Sentry JAVASCRIPT-V/J, 6 events, 2026-08-18 to 08-30): a
// stale HTML was served beside a fresh app.js, one id was absent, and the
// entire product was dead with nothing left alive to report it.
// So a missing element costs ONE control and nothing else. Accepts an id or an
// already-resolved element (a top-level const can be null for the same reason);
// forwards listener options; returns the element it bound, or null.
// SINGLE SOURCE OF TRUTH for top-level listener binding in this file.
function on(target, type, handler, opts) {
  const el = typeof target === 'string' ? document.getElementById(target) : target;
  if (!el) return null;
  el.addEventListener(type, handler, opts);
  return el;
}

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
  // Scales with length (edit-expectations.js): a sentence of a dozen words is
  // not readable in 2.6 s. Short text keeps the old 2.6 s.
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), toastDurationMs(msg));
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
    lpCount.textContent = tr('loading.count', { n: Math.min(done + 1, total), total });
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

// `whole`: the file is the whole document, not a picked subset (Ekstrak, or the
// Unduh sheet's chosen pages). The feature vote follows only whole-document downloads.
function download(blob, filename, { whole = false } = {}) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  // The chokepoint every export path funnels through — celebrate here, AFTER
  // the save was triggered. (Wave 5: reward the "I got my file" moment.)
  celebration.onDownloadSuccess({ whole });
  // The bug-report prompt's OTHER trigger (founder, 2026-09-16: "pertamakali
  // berhasil download sama pertamakali commit editan di hari itu"). Both call the
  // same capped entry point, so "whichever happens first" falls out of the cap
  // rather than the two triggers needing to know about each other.
  //
  // It deliberately does NOT share a cap with celebration above — that was
  // offered and refused: "engga. gpp dua ajakan. most user ignore the share
  // anyway." So a user can see both on one day, by his ruling.
  bugPrompt.onDownloadSuccess();
}
const celebration = createCelebration({ toast });
initInstallPrompt(); // homepage "install to home screen" chip + adaptive card (off the download moment)
initMakerCard();    // homepage: Ojan + his last approved updates (js/updates.js)
initVisitorCount(); // header count, homepage + editor (api/visitors.js)
initH1Rotation();   // homepage: the headline drifts for returning visitors (core/h1-rotation.js)
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
  // The per-page strip (page-strip.js) divides its lengths by this so it renders
  // at one size at every zoom. Set BEFORE the offset measurements below: the
  // strip's layout height depends on it, and the sizer is built from that.
  stage.style.setProperty('--zoom', String(zoom));
  // offsetWidth/Height are layout (pre-transform) sizes — scale them ourselves.
  sizer.style.width = Math.ceil(stage.offsetWidth * zoom) + 'px';
  sizer.style.height = Math.ceil(stage.offsetHeight * zoom) + 'px';
  stream.refresh(0);
  // Zoom itself still does NOT render — this only arms a timer. See the
  // focused-page sharpening block below for why that distinction is the point.
  scheduleSharpen();
}
// The zoom a freshly opened document lands on.
//
// WHY DESKTOP FITS THE WIDTH INSTEAD OF SITTING AT 1:1 (founder, 1 Sep 2026,
// with a screenshot of an invoice arrowed "too far" on both sides): 1:1 means
// an A4 is 595 CSS px, so on a 1512px laptop the page is a stamp in a field of
// grey and two thirds of the window is wasted. The old expression was
// `Math.min(1, fit)` — the cap only ever bit on desktop, where `fit` is
// comfortably above 1, and it pinned every desktop session to the smallest
// reading the formula could give. The user CAN zoom in, but the +/- pill is
// bottom-right chrome a first-time Indonesian user does not go looking for, so
// "they can zoom" is not an answer to "they never will".
//
// Mobile and tablet keep the cap exactly as it was. There the fit is BELOW 1
// (a phone is narrower than an A4 point-for-point), so the cap is inert for the
// common case and only guards the small-page one — a 200pt receipt blowing up
// to 3x on a phone is not what anyone asked for, and he asked about desktop.
//
// The gutter is the margin he left room for, and it is 48px a side rather than
// the 8 the old expression used because a vertical scrollbar (~15px) appears
// the moment the page is taller than the window — which, fitted to width, it
// now always is. Measuring clientWidth before that scrollbar exists and then
// filling to the last pixel would hand every desktop user a horizontal
// scrollbar on open.
const OPENING_GUTTER_DESKTOP = 96; // 48 a side
const OPENING_GUTTER_TOUCH = 16;
function openingZoom(pageWidth) {
  if (!(pageWidth > 0)) return 1;
  const desktop = deviceClass() === 'desktop';
  const gutter = desktop ? OPENING_GUTTER_DESKTOP : OPENING_GUTTER_TOUCH;
  const fit = (scrollEl.clientWidth - gutter) / pageWidth;
  // Same clamps the +/- buttons obey, so the opening view is always a zoom the
  // user could have reached by hand.
  return Math.max(0.3, Math.min(fit, desktop ? 3 : 1));
}
// zoom_tap reports the zoom BEFORE the press (core/telemetry-schema.js says why).
// Emitted ahead of the change so `zoom` is still the view being rejected; the
// tel() call is try/catch-armoured, so it can never stop the zoom from happening.
// SINGLE SOURCE OF TRUTH for how far and how finely the view zooms: the +/-
// buttons, setZoomAnchored (pinch, wheel, keys) and the zoom keys all read these.
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.25;
on('z-in', 'click', () => {
  tel('zoom_tap', { dir: 'in', level: zoomBucket(zoom), device: deviceClass() });
  zoom = Math.min(zoom + ZOOM_STEP, ZOOM_MAX); applyZoom();
});
on('z-out', 'click', () => {
  tel('zoom_tap', { dir: 'out', level: zoomBucket(zoom), device: deviceClass() });
  zoom = Math.max(zoom - ZOOM_STEP, ZOOM_MIN); applyZoom();
});

// ---- contact bookmark: tap the tab, the panel slides up; tap again or tap
// outside to close. Same toggle + outside-pointerdown-close idiom as the
// File menu below (fileBtn/fileMenu) — kept local since it has no other
// dependency on this block. ---------------------------------------------
// ⚠️ THE GUARD IS THE LOAD-BEARING PART, not the toggle. THIRTEEN pages import
// this module (every page carrying #zoom-ctl), and only index.html has the
// bookmark markup — the editor chrome is hand-copied inline per page, so the
// other twelve have z-in, btn-file and toast but NOT this tab. Unguarded, the
// addEventListener below threw `Cannot read properties of null` at MODULE TOP
// LEVEL on all twelve, which kills the whole import graph: page renders, every
// button dead, file-input never wired. Caught by tests/compress-target.spec.js
// (.pv-bg never appears → 30s timeout ×3) — measured RED here, GREEN on the
// clean tree, so the gate earned its keep.
// This is the SAME defect class fixed in js/v2/telemetry.js in this very commit.
// Fixing it in one module and re-introducing it in a sibling, in one sitting, is
// why the rule is structural and not a reminder: A TOP-LEVEL LOOKUP OF AN
// INDEX-ONLY ELEMENT IS ALWAYS GUARDED.
// ⚠️ THE CONTACT TAB'S WIRING LIVES IN js/v2/feedback-form.js NOW (2026-09-09).
// It used to toggle a panel of social handles from here. He retired the handles
// and the panel with them; the tab opens the feedback dialog, so its listener
// belongs beside the dialog it opens rather than in app.js's top-level block.
// The guarded-lookup rule that this block used to demonstrate still stands and
// is demonstrated by every on() call above it.

// ---- camera: pinch-zoom + pan (the Google-Maps feel, founder ask) ----------------
// One-finger pan = NATIVE container scroll (overflow auto on both axes — free,
// smooth, momentum included). Two fingers = our pinch: preventDefault on the
// 2-touch touchstart keeps the browser from claiming the gesture, zoom anchors
// on the pinch midpoint so the paper under your fingers stays put.
function setZoomAnchored(next, midX, midY) {
  const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
  if (clamped === zoom) return;
  const rect = scrollEl.getBoundingClientRect();
  const mx = midX - rect.left;
  const my = midY - rect.top;
  // Content point under the midpoint, rescaled to the new zoom.
  const cx = (scrollEl.scrollLeft + mx) * (clamped / zoom);
  const cy = (scrollEl.scrollTop + my) * (clamped / zoom);
  // The y axis is NOT linear in zoom any more: the per-page strips keep a
  // constant on-screen height (page-strip.js), so a plain rescale of the content
  // offset drifts by (strips above the point) x (strip height) x (1 - ratio).
  // Anchor on the page under the midpoint instead: remember where the point sits
  // inside that page (page-space px, which DO scale linearly) and put it back.
  let ref = null;
  for (const s of slots) { if (s.view.getBoundingClientRect().top <= midY) ref = s.view; else break; }
  const refOffset = ref ? (midY - ref.getBoundingClientRect().top) / zoom : 0;
  zoom = clamped;
  applyZoom();
  scrollEl.scrollLeft = cx - mx;
  if (ref && ref.isConnected) {
    scrollEl.scrollTop += ref.getBoundingClientRect().top + refOffset * zoom - midY;
  } else {
    scrollEl.scrollTop = cy - my;
  }
}

// ---- placement zoom: you cannot aim at what you cannot see ----------------------
// The reading zoom and the WORKING zoom are not the same number, and until now
// one variable served both. Fitted to a phone's width an A4 sits at zoom 0.666,
// which puts the document's own body type at ~10px on screen (measured,
// surat-resmi.pdf on a Pixel 7) — and the editing chrome, being inside the same
// transform, at 14px against a 44px touch floor. So the user is asked to place
// something precisely against type they can barely read, with a tool the same
// two-thirds too small. The rail says exactly that: every tool needing a precise
// tap collapses on phone (tipex 45.3%, hapus 53.1%, teks 54.3%) while every
// sheet- or modal-driven tool holds (ttd 82.6%, gabung 77.1%).
//
// ⚠️ GATED ON THE ZOOM, NOT ON THE DEVICE, and that is the whole point. Desktop
// does not have this problem because it is zoomed IN (2.38 after openingZoom),
// not because it is a desktop — so the condition never fires there and no
// `isDesktop` fork exists to keep true. The cases a device fork would get wrong
// come out right for free: a tablet opening at 1.0, a desktop user who pressed
// `−` twice, and a large-format page whose fit-width lands below 1.
//
// NO AUTO-RESTORE, deliberately. Phone sessions that place anything place a
// median of 3–5 things, so bouncing back to reading zoom after each commit would
// mean a zoom animation every other action — the "jumpy, lost my place" failure
// this is supposed to prevent. The user keeps the working zoom and leaves it with
// the same `−` they already know. Fauzan's eye on that; it is a feel call.
const PLACEMENT_MIN_ZOOM = 1.25;

function zoomForPlacement(pageId, x, y) {
  if (zoom >= PLACEMENT_MIN_ZOOM) return; // already a working zoom — leave it alone
  const slot = slots.find((s) => s.page.id === pageId);
  if (!slot) return;
  // onPlace speaks PAGE coordinates; setZoomAnchored wants CLIENT ones. Convert
  // here rather than widening interaction.js's contract — the render layer has no
  // business knowing about zoom policy.
  const r = slot.view.getBoundingClientRect();
  setZoomAnchored(PLACEMENT_MIN_ZOOM, r.left + x * zoom, r.top + y * zoom);
}

// ---- keep the editor above the on-screen keyboard --------------------------------
// The keyboard takes roughly half a phone screen and the browser does NOT move a
// contenteditable inside a scrolling container out from under it. Typing into a
// box you cannot see is the same defect as aiming at type you cannot read, one
// step later — so the zoom above would only move the failure rather than fix it.
//
// visualViewport is the only thing that reports the keyboard: window.innerHeight
// does not change on iOS, and on Android it changes inconsistently. Absent (old
// Android), this is a no-op and the editor behaves exactly as it did before.
// LIMIT, stated: #v2-sizer's bottom padding is 104px, so an editor opened on the
// very last line of the last page may have no scroll room left to rise into.
function keepAboveKeyboard(el) {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  const MARGIN = 24;
  const nudge = () => {
    if (!el.isConnected) return;
    const r = el.getBoundingClientRect();
    const visibleBottom = vv.offsetTop + vv.height;
    if (r.bottom > visibleBottom - MARGIN) {
      scrollEl.scrollTop += r.bottom - (visibleBottom - MARGIN);
    } else if (r.top < vv.offsetTop + MARGIN) {
      scrollEl.scrollTop -= (vv.offsetTop + MARGIN) - r.top;
    }
  };
  vv.addEventListener('resize', nudge);
  vv.addEventListener('scroll', nudge);
  // The keyboard ANIMATES in, so the resize that matters can land after focus.
  // One late pass catches the settled height without polling.
  const settle = setTimeout(nudge, 300);
  return () => {
    clearTimeout(settle);
    vv.removeEventListener('resize', nudge);
    vv.removeEventListener('scroll', nudge);
  };
}

let pinch = null;
let pinchRaf = false;
on(scrollEl, 'touchstart', (e) => {
  if (e.touches.length === 2) {
    e.preventDefault(); // ours, not the browser's
    // A finger that landed on a selected object may have started a drag —
    // abort it and put the object back. Pinching must never fling things.
    interaction.cancelGesture();
    const [a, b] = e.touches;
    pinch = { d0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1, z0: zoom };
  }
}, { passive: false });
on(scrollEl, 'touchmove', (e) => {
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
on(scrollEl, 'touchend', endPinch);
on(scrollEl, 'touchcancel', endPinch);

// Desktop: trackpad pinch arrives as ctrl+wheel; cmd+wheel for mouse users.
on(scrollEl, 'wheel', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  if (gestureZoom0 !== null) return; // a Safari pinch is already driving the zoom
  setZoomAnchored(zoom * (e.deltaY < 0 ? 1.1 : 0.9), e.clientX, e.clientY);
}, { passive: false });

// Keyboard zoom: Ctrl/Cmd + = / + / - / 0, the keys every editor and browser taught.
// Without this they zoomed the BROWSER's UI (toolbar, sheets and all) while the
// page stayed the same size relative to it. Same step and clamps as the +/-
// buttons; 0 = fit the focused page to the width, the same fit a document opens
// at (openingZoom). CAPTURE phase so it also works inside the inline text editor,
// which stops propagation of every keydown. Anchored on the viewport centre, so
// the paper under your eyes stays put. NOT telemetered: `zoom_tap` means a press
// of the on-screen pill (core/telemetry-schema.js) and a keypress would change
// what that field counts. No document, or a sheet open: the browser keeps its keys.
function fitWidthZoom() {
  const pg = getPage(doc, focusedPageId) || doc.pages[0];
  return openingZoom(pageDisplaySize(pg).width);
}
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || doc.pages.length === 0) return;
  if (document.querySelector('dialog[open]')) return;
  let next;
  if (e.key === '=' || e.key === '+' || e.code === 'NumpadAdd') next = zoom + ZOOM_STEP;
  else if (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract') next = zoom - ZOOM_STEP;
  else if (e.key === '0' || e.code === 'Numpad0') next = fitWidthZoom();
  else return;
  e.preventDefault();
  const r = scrollEl.getBoundingClientRect();
  setZoomAnchored(next, r.left + r.width / 2, r.top + r.height / 2);
}, true);

// Hold Space and drag = pan (grab cursor), the hand every canvas editor has. The
// tool in use is irrelevant: while Space is down the press belongs to the camera,
// so it never starts a move, a Tip-Ex stroke or a selection. The capture-phase
// pointerdown on scrollEl runs BEFORE interaction.js's listener on the stage and
// stops it there, which also covers the grey margin around the pages. Mouse and
// pen only: touch already pans natively. Space is left alone in any field, on a
// button or link (it activates those), with a sheet open, and with a modifier.
// preventDefault on the keydown, or the browser scrolls a page down per press.
let spaceHeld = false;
let panDrag = null;
const panStyle = document.createElement('style');
panStyle.textContent = '.space-pan, .space-pan * { cursor: grab !important }'
  + ' .space-pan.panning, .space-pan.panning * { cursor: grabbing !important }';
document.head.appendChild(panStyle);
function endSpacePan() {
  spaceHeld = false;
  panDrag = null;
  scrollEl.classList.remove('space-pan', 'panning');
}
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.ctrlKey || e.metaKey || e.altKey) return;
  if (doc.pages.length === 0 || document.querySelector('dialog[open]')) return;
  if (e.target.isContentEditable || e.target.closest?.('input, select, textarea')) return;
  // A button or link keeps Space only when the KEYBOARD focused it. Chrome and
  // Firefox also focus a button on mouse click, so after a click on a zoom or
  // tool button Space-pan never armed and the Space release clicked it again.
  // preventDefault on the keydown stops that activation; blur moves focus off.
  if (e.target.closest?.('button, a')) {
    let keyboardFocus = true;
    try { keyboardFocus = e.target.matches(':focus-visible'); } catch { /* old engine: keep Space for the control */ }
    if (keyboardFocus) return;
    e.target.blur();
  }
  e.preventDefault();
  spaceHeld = true;
  scrollEl.classList.add('space-pan');
});
// Meta too: macOS sends no keyup for a key released while Cmd is held, so
// Space up during a Cmd+wheel zoom would leave pan mode stuck on.
document.addEventListener('keyup', (e) => { if (e.code === 'Space' || e.key === 'Meta') endSpacePan(); });
window.addEventListener('blur', endSpacePan); // alt-tab with Space down: keyup never arrives
on(scrollEl, 'pointerdown', (e) => {
  if (!spaceHeld || e.pointerType === 'touch' || e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation(); // interaction.js never sees this press
  panDrag = { id: e.pointerId, x: e.clientX, y: e.clientY, left: scrollEl.scrollLeft, top: scrollEl.scrollTop };
  scrollEl.setPointerCapture(e.pointerId);
  scrollEl.classList.add('panning');
}, true);
on(scrollEl, 'pointermove', (e) => {
  if (!panDrag || e.pointerId !== panDrag.id) return;
  scrollEl.scrollLeft = panDrag.left - (e.clientX - panDrag.x);
  scrollEl.scrollTop = panDrag.top - (e.clientY - panDrag.y);
});
const endPan = (e) => {
  if (!panDrag || e.pointerId !== panDrag.id) return;
  panDrag = null;
  scrollEl.classList.remove('panning');
};
on(scrollEl, 'pointerup', endPan);
on(scrollEl, 'pointercancel', endPan);

// Safari trackpad pinch: WebKit does NOT send ctrl+wheel for it (Chrome and
// Firefox do, handled above); it sends gesture events whose `scale` runs from 1
// at the start of the pinch. Same anchored zoom as every other path. Stands down
// while a touch pinch is live (iOS can send both for one gesture), and the wheel
// handler stands down while a gesture is, so one pinch is never applied twice.
// Not testable in Chromium: tests/v2-zoom-keys.spec.js drives it with synthetic events.
let gestureZoom0 = null;
on(scrollEl, 'gesturestart', (e) => {
  if (pinch) return;
  e.preventDefault();
  gestureZoom0 = zoom;
}, { passive: false });
on(scrollEl, 'gesturechange', (e) => {
  if (pinch || gestureZoom0 === null) return;
  e.preventDefault();
  const r = scrollEl.getBoundingClientRect();
  setZoomAnchored(gestureZoom0 * e.scale, e.clientX ?? r.left + r.width / 2, e.clientY ?? r.top + r.height / 2);
}, { passive: false });
on(scrollEl, 'gestureend', (e) => { e.preventDefault(); gestureZoom0 = null; }, { passive: false });

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
  const budget = maxPixelsFor(deviceClass());
  const scale = page.id !== focusedPageId ? RASTER_BASE : sharpenScale({
    pageWidth: page.width,
    pageHeight: page.height,
    zoom,
    dpr: window.devicePixelRatio,
    maxPixels: budget,
  });
  // An image page never past its own pixels or the budget (render/sharpen.js
  // imageScaleCap: a phone photo at scale 2 was a blank 48MP canvas on iOS).
  return Math.min(scale, imageScaleCap(page, budget));
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
  stage.innerHTML = ''; // detaches the steering glow too — drop the stale reference
  gantiSteer.clear();
  slots = doc.pages.map((page, i) => {
    const slot = createPageSlot(page, {
      activeId: doc.selection.annotationId,
      label: tr('page.short', { n: i + 1 }),
    });
    // The page view rides inside a .pv-slot wrapper with its control strip
    // (page-strip.js); slot.view stays the .pv-page itself for everything else.
    stage.appendChild(pageStrips.wrap(slot.view, page, i, doc.pages.length));
    return slot;
  });
  interaction.refreshSelection();
  refreshChrome();
  applyZoom(); // stage layout size changed → re-size the sizer (also refreshes)
}

// Re-render one page's overlay after a structural annotation change.
// WHY deferred while an editor is open on the page (found 2026-10-10): every
// bake ends in syncPage (Hapus's bakeAfterEditChange, Edit's commit), and
// syncOverlay empties the overlay, the open inline editor included. Hapus a
// line, tap Edit on the next one before the bake lands, and the editor vanished
// mid-word: the typed text was lost and the following keystrokes hit the tool
// keys (an "s" opened the signature sheet). The page re-syncs the moment that
// editor closes (flushDeferredSync, from commit()).
const deferredSync = new Set();
function flushDeferredSync() {
  const ids = [...deferredSync];
  deferredSync.clear();
  for (const id of ids) syncPage(id);
}

function syncPage(pageId) {
  const slot = slots.find((s) => s.page.id === pageId);
  if (editingEl && slot?.view.contains(editingEl)) {
    deferredSync.add(pageId);
    refreshChrome();
    return;
  }
  // syncOverlay does overlay.innerHTML = '' — that would silently detach the
  // steering glow if it happened to be riding THIS page's overlay; drop the
  // reference rather than leave it dangling (see rebuildStage).
  gantiSteer.detachIfIn(slot?.view);
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
  const found = id ? findAnnotation(doc, id) : null;
  return found && found.annotation.type === 'text' ? found.annotation : null;
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
  if (next !== 'ganti') gantiSteer.clear();
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
// data-tool is the DOM's vocabulary; the rail's is telemetry-schema.js's
// `tool` enum. They are deliberately not the same words (the markup is
// English, the schema is the product's own Indonesian verbs), so the mapping
// lives here, once, instead of at each emit site.
const ARM_TOOL = { text: 'teks', whiteout: 'tipex', ganti: 'ganti', signature: 'ttd' };
for (const btn of document.querySelectorAll('#toolbar .tool[data-tool]')) {
  btn.addEventListener('click', () => {
    const t = btn.dataset.tool;
    // FOUNDER RULING (2026-07-19, banked in ojan-ui-taste): a lit tool button
    // is an ON-OFF switch — tapping it again disarms back to neutral. This is
    // also the ONLY touch-side escape from an armed tool (Escape is keyboard).
    if (tool === t) { setTool('select'); return; }
    // ⚠️ THE ARM EVENT GOES HERE, IN THE CLICK HANDLER, AND NOT IN setTool().
    // setTool is called ~10 times per edit by the editor itself — after every
    // commit, on Escape, on delete, on home — and all but a handful are the
    // editor talking to itself. Emitting from there would bury the one signal
    // this event exists for (a person REACHING for a tool) under machine
    // noise, and would report a disarm as an arm. Above the signature branch
    // on purpose: pressing TTD with no saved signature never reaches setTool,
    // and that is precisely the path that was invisible.
    if (ARM_TOOL[t]) tel('tool_use', { tool: ARM_TOOL[t], action: 'arm' });
    if (t === 'signature' && !storedSignature) { openSignatureModal(); return; }
    setTool(t);
    if (t === 'text') toast(tr('toast.armText'));
    if (t === 'whiteout') toast(tr('toast.armWhiteout'));
    if (t === 'signature') toast(tr('toast.armSignature'));
    // Beta note lives HERE (not just the button's title=) because a title tip
    // is desktop-hover only — ~half of pdflokal's traffic is mobile and would
    // never see "beta". The arm-toast announces it on every device, once per
    // arming, right as the user starts. Verb shifted ganti→edit to match the
    // renamed button (taste: the verb matches the interaction model everywhere).
    if (t === 'ganti') {
      // A locked or signed file gets its own sentence INSTEAD of the beta line,
      // once per document (edit-expectations.js armEditNoticeKey). Literal keys
      // here so tests/core/i18n.test.mjs can see every one being read.
      const notice = armEditNoticeKey(doc);
      if (notice === 'armEditLocked') toast(tr('toast.armEditLocked'));
      else if (notice === 'armEditSigned') toast(tr('toast.armEditSigned'));
      else toast(tr('toast.armEdit'));
    }
  });
}

// The two injected halves of core/edit-hit.js: the overlay's own measurer and
// the editor's one finger-sized hit law.
const EDIT_HIT = { measure: measureTextAnnoWidth, minHit: MIN_HIT };

// ---- Ganti Teks (Edit Teks Asli, Rung A — seat spec-edit-teks-asli.md) -----------
// Tap a PRINTED run → cover it with a color-matched Tip-Ex + reopen the same
// words as an editable text object, pre-selected so typing replaces. One
// gesture, ONE undo step (recorded here; the editor commit skips its own).
const textRuns = createTextRunIndex({ getDoc: () => doc });

// ---- Rung S2 — the same gesture on a SCAN (seat spec-edit-dokumen-foto.md) -------
// text-runs.js coming back empty IS the router: no visible text objects means
// the page is a photograph of words, and those words have to be RECOGNISED
// before anything can be tapped. Same Line shape out, so everything below
// this line — the cover, the prefilled editor, the color match — is the code
// that already ships. Created lazily-empty: nothing here loads the 5 MB
// engine until a user asks for it (js/v2/ocr-engine.js's header).
const ocrIndex = createOcrIndex({ getDoc: () => doc, rasterizer: { renderCanvas: (page, o) => rasterizer.renderCanvas(page, o) } });

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

// The bake pipeline (edited-page provider, re-bake, undo/redo re-sync, visual
// oracle, feedback sample) lives in js/v2/edit-bake.js with its WHYs. The names
// below are its functions, so every call site in this file reads as before.
const editBake = createEditBake({
  getDoc: () => doc,
  getSlots: () => slots,
  getRasterizer: () => rasterizer,
  rasterScaleFor,
  tel,
  getSentry: () => window.Sentry || null,
});
const { editedPageProvider, getDryRunDoc, rebakePage, syncEditedRasters, runVisualOracle, captureFeedbackSample } = editBake;

// Rung C's live doc-font preview (loadDocFont / prepareDocFont and their
// caches) lives in js/v2/doc-font-live.js with its WHYs.
const docFontLive = createDocFontLive({ getDoc: () => doc, getDryRunDoc, tel, toast });
const { prepareDocFont } = docFontLive;

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
// with); its fontDecision (2026-10-01) is the face the editor opens in. The
// candidates are re-loaded by prepareDocFont below, seeded from that stored
// decision (see the call's own note) — the committed replacement carries no
// live font objects to reuse.
function reEditLine(pageId, cover, replacement) {
  const box = cover.replaceBox;
  track('editor_action', { action: 'ganti_teks_reedit' });
  const draft = {
    text: replacement?.text ?? '',
    originalWidth: box.w, // see smartReplace's draft
    fontSize: replacement?.fontSize ?? Math.min(120, Math.max(6, Math.round(box.h))),
    fontFamily: replacement?.fontFamily,
    bold: !!replacement?.bold,
    italic: !!replacement?.italic,
    color: replacement?.color,
    docFontFamily: replacement?.docFontFamily,
    // The committed edit's font decision: the editor opens IN that face (its
    // FontFace is still registered), and prepareDocFont re-loads the same
    // candidates from it rather than re-deriving them.
    ...(replacement?.fontDecision ? { fontDecision: replacement.fontDecision } : {}),
    // RUNG D: a committed paragraph reopens as the paragraph — the stored
    // geometry IS the plan (core/block-edit.js blockAnnotation), and the box
    // is the cover's birth box.
    ...(replacement?.block ? { block: { ...replacement.block, box: { ...box } } } : {}),
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
  openTextEditor({ pageId, x: draft.block ? draft.block.disp.x : box.x, y: box.y, anno: null, draft });
  setTool('select');
  toastEl.classList.remove('show');
  // Seed font preparation from the STORED decision (edit font design, Gaps):
  // it names the line's own resource and the bundled faces the edit was made
  // with. An edit committed before decisions existed has none — then the
  // dry run sees ALL of the line's targets, so it finds the same dominant run
  // a fresh tap does (it used to see replaceTargets[0] only).
  if (replacement?.fontDecision) {
    void prepareDocFont(pageId, null, draft, replacement.fontDecision); // never rejects: try/catch inside
  } else if (cover.replaceTargets?.length) {
    void prepareDocFont(pageId, { runs: cover.replaceTargets.map((pdf) => ({ pdf })) }, draft);
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
    const hit = hitTestEditedLine(page, x, y, EDIT_HIT);
    if (hit) { tel('ganti_tap', { hit: true }); reEditLine(pageId, hit.cover, hit.replacement); return; }
    // RUNG S2, same guard one ladder over, and it is NOT optional here: OCR
    // reads the PRISTINE pixels, so a word already covered still recognises
    // as its original text. Without this, a second tap on an edited word
    // stacks a second cover and a second text object on top of the first —
    // two replacements painted over each other, which is worse than the
    // born-digital version of this bug because nothing on a scan visually
    // says an edit is already there.
    const ocrHit = hitTestOcrEdit(page, x, y, MIN_HIT);
    if (ocrHit) { tel('ganti_tap', { hit: true }); reEditOcrLine(pageId, ocrHit.cover, ocrHit.replacement); return; }
  }
  // A page that has been recognised is a SCAN, and its tap targets are OCR
  // boxes. Checked before the pdf.js path below because that path would do
  // the expensive walk only to come back empty — empty is what routed the
  // page here in the first place.
  if (ocrIndex.hasLines(pageId)) {
    const ocrLine = ocrIndex.hitTest(pageId, x, y);
    if (!ocrLine) { tel('ganti_tap', { hit: false }); toast(tr('toast.missedText')); return; }
    tel('ganti_tap', { hit: true });
    ocrReplace(pageId, ocrLine);
    return;
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
      showScanOffer(pageId);
    } else {
      // The page has text but none under the finger: say what it IS, not just
      // that it missed (a picture of words cannot be edited, only covered). The
      // OCR-scan miss above keeps missedText: there the lines are guesses and
      // "tap right on it" is the useful advice.
      toast(tr('toast.notText'));
    }
    return;
  }
  tel('ganti_tap', { hit: true });
  // RUNG D (his call, seat decisions.md 2026-10-01 malam final): "if paragraph,
  // edit the whole paragraph". A line paragraph-detect.js placed in a
  // body-text block opens the WHOLE block when core/block-edit.js can prove it
  // (alignment, no rotation, one size, nothing else inside the box, not a
  // list). Anything it cannot prove declines, named on the rail, to exactly
  // the per-line edit below — never a guess.
  if (line.blockId !== null && line.blockId !== undefined) {
    // The index reads the PRISTINE file, so a line Hapus deleted (or Edit already
    // owns) is still in it and would be prefilled back into the paragraph, and
    // committing would write it into the file again. Detect the paragraph over
    // the lines the page still shows: a hole at either end leaves a shorter
    // paragraph, a hole in the middle breaks it and the tap falls to the line
    // edit below.
    const ownedTargets = page ? pageEdits(page).flatMap((e) => e.targets) : [];
    let pageLines = await textRuns.getLines(pageId);
    let blockLine = line;
    if (ownedTargets.length) {
      pageLines = await textRuns.getLinesWithout(pageId, ownedTargets);
      blockLine = resolveTap(pageLines, x, y, MIN_HIT);
    }
    const block = blockLine ? blockOfLine(pageLines, blockLine) : null;
    if (block) {
      const verdict = planBlockEdit(block, pageLines, { rotation: page ? totalPageRotation(page) : 0 });
      if (verdict.ok) {
        tel('block_edit', { outcome: 'open', block_lines: block.lines.length });
        openBlockReplace(pageId, blockLine, verdict.plan);
        return;
      }
      tel('block_edit', { outcome: 'decline', decline_reason: verdict.reason, block_lines: block.lines.length });
    }
  }
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
    // The original line's width: the editor never wraps a single line, so the
    // first time typing outgrows this the person is told (openTextEditor).
    originalWidth: line.w,
    fontSize: draftFontSize(line.size),
    fontFamily: mapRunFont(line.fontFamily, line.fontName),
    recorded: true,
    // Rung C (core/export.js): pairs the committed TEXT annotation with the
    // cover it replaces, so export can try writing it natively into the
    // content stream with the document's OWN font once surgery on THIS cover
    // has proven the original run is truly gone.
    replaceCoverId: cover.id,
    // Backing out (Escape / empty commit) must not leave a mute cover over
    // the original words — the cover belongs to the replace, not to itself.
    onCancel: () => { removeAnnotation(doc, cover.id); settle(history); syncPage(pageId); },
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

// RUNG D: smartReplace's tail for a whole paragraph. Same one-undo-step cover +
// prefilled editor + colour match + font preparation as a line; what differs
// is the target (every run of every line of the block — replaceTargets was
// always an array), the box (the block's), and the draft's `block` plan, which
// openTextEditor turns into the paragraph's box.
function openBlockReplace(pageId, line, plan) {
  record(history, doc);
  const cover = addAnnotation(doc, pageId, createAnnotation('whiteout', {
    x: plan.box.x, y: plan.box.y, width: plan.box.w, height: plan.box.h,
    replaceTargets: plan.targets,
    replaceBox: { x: plan.box.x, y: plan.box.y, w: plan.box.w, h: plan.box.h },
  }));
  syncPage(pageId);
  track('editor_action', { action: 'ganti_teks' });
  const draft = {
    text: plan.text,
    fontSize: plan.k * plan.size,
    fontFamily: mapRunFont(line.fontFamily, line.fontName),
    recorded: true,
    replaceCoverId: cover.id,
    onCancel: () => { removeAnnotation(doc, cover.id); settle(history); syncPage(pageId); },
    block: plan,
  };
  openTextEditor({ pageId, x: plan.disp.x, y: plan.box.y, anno: null, draft });
  setTool('select');
  toastEl.classList.remove('show');
  matchReplaceColors(cover, draft, pageId, line); // async; colors land live
  // The font is decided over the WHOLE paragraph: every run of every line goes
  // to the dry run, so its dominant run is the paragraph's, not the tapped line's.
  prepareDocFont(pageId, { runs: plan.runs }, draft);
}

// ---- Rung S2: the same gesture on a scan (spec-edit-dokumen-foto.md §3) -------------
//
// Everything below reuses Ganti Teks's machinery and changes exactly one
// thing: where the box came from. Born-digital, the box is a text object
// pdf.js reported; on a scan it is a box an OCR engine recognised. The cover,
// the prefilled editor, the color match, the one-undo-step discipline are all
// the shipped code.
//
// ⚠️ THE PAIR CARRIES `ocrBox`/`ocrCoverId`, NEVER `replaceBox`/`replaceTargets`,
// and the distinct names are the safety property, not a style choice. Those
// two fields are SURGERY INTENT: core/page-surgery.js and core/export.js each
// filter on `type === 'whiteout' && replaceTargets?.length && replaceBox` and
// then CUT the matching show-ops out of the page's content stream. A scan has
// no show-ops carrying its words — they are pixels — so a scan cover that
// carried those fields would point the cutter at whatever text the page DOES
// have (a header, a stamp, a searchable scan's own invisible layer) and delete
// it. Naming the fields differently means the export path cannot see an S2
// pair at all: it exports as what it is, a filled rect and a text object.

// Tap a recognised line → cover it → reopen its words as an editable draft.
function ocrReplace(pageId, line) {
  record(history, doc);
  const cover = addAnnotation(doc, pageId, createAnnotation('whiteout', {
    x: line.x, y: line.y, width: line.w, height: line.h,
    ocrBox: { x: line.x, y: line.y, w: line.w, h: line.h },
  }));
  syncPage(pageId);
  track('editor_action', { action: 'ganti_scan' });
  const draft = {
    text: line.str,
    // core/ocr-lines.js already clamped this to the same 6..120 range a
    // born-digital draft uses — taking it as given rather than re-deriving it
    // keeps ONE rule for what the editor will accept.
    fontSize: line.size,
    // Pixel comparison can select a bundled substitute, never recover the
    // original font. Uncertain matches retain the established default.
    fontFamily: 'Helvetica',
    recorded: true,
    ocrCoverId: cover.id,
    onCancel: () => { removeAnnotation(doc, cover.id); settle(history); syncPage(pageId); },
  };
  openTextEditor({ pageId, x: line.x, y: line.y, anno: null, draft });
  setTool('select'); // disarm now, not at commit — same founder ruling as smartReplace
  toastEl.classList.remove('show');
  // Paper and ink sampled off the raster. This matters MORE on a scan than on
  // a born-digital page: paper in a photograph is never #fff, and a pure-white
  // cover on a grey-white scan is a visible patch.
  matchScanAppearance(cover, draft, pageId, line);
}

async function matchScanAppearance(cover, draft, pageId, line) {
  const originalDoc = doc;
  try {
    const result = await scanAppearance(await withPageRasterCtx(pageId), line);
    // Undo/new-file/re-edit must not attach a late result to a restored copy.
    if (doc !== originalDoc || findAnnotation(doc, cover.id)?.annotation !== cover) return;
    const ed = draft.editorEl;
    // Commit freezes appearance too: a download begun immediately after it
    // must not race a later patch being installed in the preview/model.
    if (!ed?.isConnected || editingEl !== ed) return;
    if (result.paperImage) {
      updateAnnotation(doc, cover.id, { paperImage: result.paperImage });
      const el = stage.querySelector(`[data-anno-id="${cover.id}"]`);
      if (el) { el.style.backgroundImage = `url("${result.paperImage}")`; el.style.backgroundSize = '100% 100%'; }
    }
    if (draft.appearanceLocked) return;
    if (result.lettering) {
      const { x, y, score: _score, ...style } = result.lettering;
      Object.assign(draft, style, { scanPlacement: { x, y } });
      ed.style.font = textFontCss(draft); ed.style.color = draft.color || '#000';
      ed.style.left = `${x}px`; ed.style.top = `${y}px`;
    } else {
      await matchReplaceColors(cover, draft, pageId, line);
    }
  } catch { /* best effort; the immediate editor keeps its original defaults */ }
}

// Reopen a committed S2 edit. Same drop-and-reapply shape as reEditLine, and
// for the same reason: one edit per original line, never two stacked on it.
function reEditOcrLine(pageId, cover, replacement) {
  const box = cover.ocrBox;
  track('editor_action', { action: 'ganti_scan_reedit' });
  const draft = {
    text: replacement?.text ?? '',
    fontSize: replacement?.fontSize ?? Math.min(120, Math.max(6, Math.round(box.h))),
    fontFamily: replacement?.fontFamily,
    bold: !!replacement?.bold,
    italic: !!replacement?.italic,
    color: replacement?.color,
    ocrReEdit: {
      coverId: cover.id,
      textId: replacement?.id ?? null,
      box: { x: box.x, y: box.y, w: box.w, h: box.h },
      coverColor: cover.color,
      paperImage: cover.paperImage,
    },
  };
  openTextEditor({ pageId, x: replacement?.x ?? box.x, y: replacement?.y ?? box.y, anno: null, draft });
  setTool('select');
  toastEl.classList.remove('show');
}

// Recognise a page, then hand it to the tap gesture. The 5 MB engine is
// fetched HERE and nowhere else — only ever from a user's explicit tap on the
// scan sheet, never from a page-load or a render path (js/v2/ocr-engine.js).
async function runOcrOnPage(pageId) {
  if (ocrIndex.hasLines(pageId)) { armOcrTap(pageId); return; }
  // Reuses the existing processing overlay verbatim ("Memproses…" + the
  // privacy note that is true here too — recognition runs in the tab, and no
  // pixel leaves it). A second progress vocabulary for the same idea would be
  // a new surface to justify and new words to rule, for no gain.
  const engineWasCached = ocrEngineLoaded();
  showProcessing(1);
  const t0 = performance.now();
  try {
    const lines = await ocrIndex.run(pageId);
    hideProcessing();
    tel('ocr_run', {
      lines: ocrLinesBucket(lines.length),
      duration: durationBucket(performance.now() - t0),
      // Read BEFORE this run's own worker was torn down but AFTER the engine
      // landed, so a first run reports false and every later one true — which
      // is the split that makes the duration number readable at all.
      engine_cached: engineWasCached,
    });
    if (lines.length === 0) { toast(tr('toast.noReadableText')); return; }
    armOcrTap(pageId);
  } catch (err) {
    hideProcessing();
    console.warn('OCR gagal:', err);
    // Distinct from "nothing found" on purpose: a failed engine and a blank
    // page need different things said, and collapsing them would tell a user
    // whose download broke that their document has no text on it.
    // failureReason(err), never a literal: a hard-coded reason is
    // indistinguishable from a real classification once it is on the rail, and
    // that is precisely how 41 export failures all reported 'unknown' on
    // 2026-07-28 (core/failure-reason.js's header). `stage:'ocr'` already
    // isolates this population, so whatever the classifier can say about the
    // error is pure added signal.
    tel('failure', { stage: 'ocr', reason: failureReason(err), class: 'none', blocked: true });
    tel('failure_cause', { stage: 'ocr', ...failureCause(err) });
    toast(tr('toast.scanFailed'));
  }
}

// setTool('ganti') fires its own arm toast for the BORN-DIGITAL ladder
// ("Edit teks asli, fitur beta…"), which names the wrong ladder for a scan.
// Ours is raised after it, deliberately, so the message left standing is the
// true one — one message at a time, the same rule showScanOffer's hideToast()
// exists to keep.
function armOcrTap() {
  setTool('ganti');
  toast(tr('toast.armEditShort'));
}

// ---- Ganti Teks steering highlight (press→steer→release-commit, 2026-07-19) ------
// The quiet-page glow lives in js/v2/ganti-steer.js (the founder's ruling with it).
const gantiSteer = createGantiSteer({
  hitTest: (pageId, x, y) => textRuns.hitTest(pageId, x, y),
  getTool: () => tool,
  getSlots: () => slots,
});

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
    const w = 150 * zoom;
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
on('btn-delete-anno', 'click', () => {
  if (tool === 'delete') { setTool('select'); return; } // toggle off (on-off law)
  if (doc.selection.annotationId) { deleteSelected(); return; }
  // Hapus is not in #toolbar's data-tool loop, so it needs its own arm. The
  // delete-now branch above deliberately does NOT emit one: that press is an
  // outcome, and `tool_use`/hapus/delete already reports it.
  tel('tool_use', { tool: 'hapus', action: 'arm' });
  setTool('delete');
  toast(tr('toast.pickObject'));
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
// Read the raster at `pts` (raster px); points off the raster are skipped.
// The arithmetic on the samples is core/color-sample.js's.
function sampleAt(r, pts) {
  const out = [];
  for (const [x, y] of pts) {
    if (x < 0 || y < 0 || x >= r.w || y >= r.h) continue;
    const px = r.cx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
    out.push([px[0], px[1], px[2]]);
  }
  return out;
}

async function matchWhiteoutColor(anno, pageId, ox, oy) {
  try {
    const r = await withPageRasterCtx(pageId);
    if (!r) return;
    const color = whiteoutColorFrom(sampleAt(r, whiteoutRingPoints(ox, oy, r.s)));
    if (!color) return;
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
    if (cover.ocrBox && (findAnnotation(doc, cover.id)?.annotation !== cover
      || draft.appearanceLocked || editingEl !== draft.editorEl)) return;
    const paper = sampleAt(r, paperPoints(line, r.s));
    const coverColor = coverColorFrom(paper);
    if (!coverColor) return;
    updateAnnotation(doc, cover.id, { color: coverColor });
    const el = stage.querySelector(`[data-anno-id="${cover.id}"]`);
    if (el) el.style.backgroundColor = coverColor;
    // The ink-core rule (and why it is not a quartile median) is
    // core/color-sample.js inkColorFrom's.
    const ink = inkColorFrom(sampleAt(r, inkPoints(line, r.s)), paper);
    if (ink) {
      draft.color = ink;
      if (editingEl && !editingAnno) editingEl.style.color = draft.color;
    }
  } catch { /* best-effort; white cover + default ink stand */ }
}

// ---- Hapus on the PDF's OWN text (founder ruling 2026-10-02) ---------------------
// "itu naturally yang mereka mau, let's facilitate it": with Hapus armed, a tap
// on a printed line DELETES it. A toast explaining Tip-Ex was rejected.
//
// THE PRIMITIVE ALREADY EXISTED: a whiteout cover carrying replaceTargets +
// replaceBox with NO partner text annotation. core/page-surgery.js cuts the
// original show-ops for any such cover (runSurgery's candidates filter does not
// look for a replacement), planNativeInserts only stamps when a text annotation
// points back, and buildEditedPageBytes documents `insert: null` as "a pure
// deletion". So this is Ganti Teks minus the editor, and export, live bake,
// undo and re-edit all come with it. The screen and the file agree for the
// same reason a Ganti edit's do: one pipeline builds both.
//
// THE UNIT IS THE LINE, NOT THE PARAGRAPH (Ganti opens a whole paragraph when
// core/block-edit.js can prove it). Rung D exists because retyped text has to
// REFLOW; a deletion has nothing to reflow, Hapus's grammar everywhere is one
// object per tap, and one tap wiping a fifteen-line paragraph is the bigger
// surprise on a phone, even with undo. A whole paragraph still goes through
// Edit: clear it and commit (see commit()'s empty-draft branch).
//
// WHERE SURGERY DECLINES (a run it cannot match), the cover stays as a visible
// Tip-Ex rectangle and ships as one: the words are hidden, not removed. That is
// what Ganti already does under the same condition, and `surgery` on the rail
// says how often it happens. Undo is how a declined delete is taken back: a tap
// on that cover with Hapus armed is treated as a tap on the printed line under
// it (interaction.js), never as a request to delete the cover.

// A throwaway draft for matchReplaceColors, which wants one to hand its ink
// colour to. Nothing here has an editor, so ink is unused; editorEl:null makes
// the OCR guard inside it (`editingEl !== draft.editorEl`) pass when no editor
// is open, which is always the case here (arming Hapus blurred any editor).
const noDraft = () => ({ editorEl: null, appearanceLocked: false });

function missOriginal() {
  // Nothing printed under the finger: blank paper, an image, a drawing, or a scan
  // that was never recognised. Silent on screen (a toast was ruled out), counted
  // on the rail so "what do people tap that we cannot delete" is answerable.
  tel('tool_use', { tool: 'hapus', action: 'original_miss' });
}

// After the model changed: paint now, then bake the page so the file's truth
// (the cut ops) replaces the cover. Same order as commit(): sync first, bake
// second, sync again once the bake resolves so suppression matches reality.
// `coverId` is passed only for a NEW cover, so its `surgery` outcome is read
// (a re-delete of a replacement's text was already reported when it was made).
function bakeAfterEditChange(pageId, coverId) {
  syncPage(pageId);
  rebakePage(pageId).then(() => {
    syncPage(pageId);
    const oc = coverId && getPage(doc, pageId)?.editOutcomes?.find((o) => o.coverId === coverId);
    if (oc) tel('surgery', oc.surgery);
  }).catch((err) => console.warn('rebakePage gagal:', err));
}

// Born-digital: one cover over the tapped line's own runs, nothing written back.
async function deleteOriginalLine(pageId, line) {
  record(history, doc);
  const cover = addAnnotation(doc, pageId, createAnnotation('whiteout', {
    x: line.x, y: line.y, width: line.w, height: line.h,
    // One target per constituent run, exactly as smartReplace builds them (see the
    // long WHY there: a blended target silently cuts only the dominant run).
    replaceTargets: line.runs.map((r) => r.pdf),
    replaceBox: { x: line.x, y: line.y, w: line.w, h: line.h },
  }));
  tel('tool_use', { tool: 'hapus', action: 'original_delete' });
  syncPage(pageId);
  // Colour first, bake after: if the bake declines, the cover that stays must
  // already match the paper rather than flash white on a coloured page.
  await matchReplaceColors(cover, noDraft(), pageId, line);
  bakeAfterEditChange(pageId, cover.id);
}

// Paint a scan cover in the paper sampled around its box (no lettering: a
// deletion has no text to match). Best effort, like matchScanAppearance: if the
// raster cannot be read the white patch stands.
async function paintScanPaper(cover, pageId, box) {
  try {
    const result = scanPaper(await withPageRasterCtx(pageId), box);
    if (findAnnotation(doc, cover.id)?.annotation !== cover) return; // undone meanwhile
    if (result.paperImage) {
      updateAnnotation(doc, cover.id, { paperImage: result.paperImage });
      const el = stage.querySelector(`[data-anno-id="${cover.id}"]`);
      if (el) { el.style.backgroundImage = `url("${result.paperImage}")`; el.style.backgroundSize = '100% 100%'; }
    } else {
      await matchReplaceColors(cover, noDraft(), pageId, box);
    }
  } catch { /* the white patch stands */ }
}

// Recognised scan (Rung S2's index, only present after the person recognised the
// page through Edit): the same cover Ganti would place, with no text over it. A
// scan has no show-ops to cut, so this is a Tip-Ex patch sized to the line and
// painted in the sampled paper, and it exports as exactly that. NEVER carries
// replaceTargets/replaceBox (see the S2 header above: those fields point the
// cutter at the page's real text).
async function deleteOcrLine(pageId, line) {
  record(history, doc);
  const box = { x: line.x, y: line.y, w: line.w, h: line.h };
  const cover = addAnnotation(doc, pageId, createAnnotation('whiteout', {
    x: box.x, y: box.y, width: box.w, height: box.h, ocrBox: box,
  }));
  tel('tool_use', { tool: 'hapus', action: 'original_delete' });
  syncPage(pageId);
  await paintScanPaper(cover, pageId, box);
}

// The tapped spot is inside a line that an edit already owns. With a
// replacement painted there, the replacement is what the person sees and taps:
// remove it and keep the cover, so the line stays deleted (the same shape as an
// emptied Ganti commit). With none, the line is already gone: nothing to do.
function deleteEditedReplacement(pageId, edit) {
  // Already deleted: the finger is on a printed line that is gone. Not a MISS
  // (the rail's 'original_miss' is "nothing printed here"), and a double-tap
  // makes this the common second tap, so it is silent and changes nothing.
  if (!edit.replacement) return;
  record(history, doc);
  removeAnnotation(doc, edit.replacement.id);
  tel('tool_use', { tool: 'hapus', action: 'original_delete' });
  bakeAfterEditChange(pageId, null);
}

async function deleteOriginalAt(pageId, x, y) {
  if (!getPage(doc, pageId)) return;
  if (ocrIndex.hasLines(pageId)) {
    const ocrLine = ocrIndex.hitTest(pageId, x, y);
    if (ocrLine) await deleteOcrLine(pageId, ocrLine); else missOriginal();
    return;
  }
  const line = await textRuns.hitTest(pageId, x, y);
  // Re-read AFTER the await: an undo or a second tap may have landed meanwhile,
  // and everything below must see the model as it is NOW. From here to the
  // addAnnotation inside deleteOriginalLine nothing yields, so two quick taps on
  // one line cannot both create a cover (the second sees the first as owner).
  const page = getPage(doc, pageId);
  if (!page) return;
  if (!line) {
    // Not over any printed line, but a replacement longer than the words it
    // replaced paints past its birth box (field report 2026-08-26): that overflow
    // is visible, so it is tappable.
    const hit = hitTestEditedLine(page, x, y, EDIT_HIT);
    if (hit?.replacement) deleteEditedReplacement(pageId, hit); else missOriginal();
    return;
  }
  // Pristine-first, NOT hitTestEditedLine-first: that function inflates every
  // edit's box toward a finger-sized target, and a deleted line has no ink to
  // show where its box ends, so it would swallow taps meant for the line beside it.
  // Ownership is geometric: an edit owns the line whose centre is in its birth box.
  const owner = editOwningLine(page, line);
  if (owner) { deleteEditedReplacement(pageId, owner); return; }
  await deleteOriginalLine(pageId, line);
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
    const gone = findAnnotation(doc, annoId)?.annotation;
    record(history, doc);
    removeAnnotation(doc, annoId);
    // ⚠️ THE ARMED PATH'S OWN OUTCOME. `arm` is emitted only when Hapus is pressed
    // with nothing selected (btn-delete-anno), and that is exactly the path that
    // lands HERE; `delete` was emitted only from deleteSelected(), the other
    // path. So arm and delete never co-occurred for one gesture, and every
    // person who armed Hapus and deleted their own object read on the rail as
    // armed-and-gave-up. Same event deleteSelected sends: the meaning ("a Hapus
    // delete happened") is unchanged, only the missing call site.
    tel('tool_use', { tool: 'hapus', action: 'delete' });
    // The replacement text of an edit that is baked into the page raster (or is
    // being: the overlay shows it until the bake lands) is only on screen because
    // of that raster. Removing the annotation without a re-bake leaves the old
    // raster up, and then the screen says the text is deleted while the model
    // (and so the file) says nothing of the kind, or the reverse.
    if (gone?.replaceCoverId) bakeAfterEditChange(pageId, null); else syncPage(pageId);
    setTool('select'); // one delete per arming; undo covers mistakes
  },
  // Hapus armed, a tap landed on none of OUR objects: the PDF's own printed text.
  // Stays armed (founder, 2026-10-02): taking several lines out is the normal
  // use, and Hapus itself toggles off. NOT the own-object path above, which
  // disarms after one delete.
  onDeleteOriginal: ({ pageId, x, y }) => { void deleteOriginalAt(pageId, x, y); },
  onPlace: (t, { pageId, x, y }) => {
    // ONLY the two tools that open an editor, and the restriction is evidence,
    // not tidiness. onPlace fires AFTER the tap has landed, so the zoom cannot
    // improve the aim that just happened — what it improves is the typing and
    // the repositioning that follow (phone sessions already reposition more than
    // desktop: median 3, mean 6.6 placements before abandoning). A signature
    // drop has no such follow-through, so zooming there would move the page for
    // no gain — and `ttd` is the BEST-performing tool on phone (82.6% vs 91.3%
    // desktop, the smallest gap of any tool). Handing a view-jump to the one
    // thing that already works is the wrong risk. teks (54.3%) is the loss.
    if (t === 'text' || t === 'ganti') zoomForPlacement(pageId, x, y);
    if (t === 'text') {
      openTextEditor({ pageId, x, y, anno: null });
    } else if (t === 'ganti') {
      smartReplace(pageId, x, y); // async: extraction may need a moment on first tap
    } else if (t === 'signature' && storedSignature) {
      record(history, doc);
      const w = 150; // signature at document scale
      const h = w * (storedSignature.height / storedSignature.width);
      const created = addAnnotation(doc, pageId, createAnnotation('signature', {
        image: storedSignature.dataUrl,
        x: Math.max(0, x - w / 2), y: Math.max(0, y - h / 2), width: w, height: h,
      }));
      track('editor_action', { action: 'signature' });
      tel('tool_use', { tool: 'ttd', action: 'signature' });
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
    const found = findAnnotation(doc, annoId);
    if (found) {
      const { page, annotation: anno } = found;
      openTextEditor({ pageId: page.id, x: anno.x, y: anno.y, anno });
    }
  },
  onGantiSteer: gantiSteer.onSteer,
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
  onDocChanged: () => { textRuns.invalidateAll(); ocrIndex.invalidateAll(); rebuildStage(); },
  onAddFiles: () => pickFiles(),
  onExtract: async (pages) => {
    // The tap, on the rail (2026-10-02). Split/Ekstrak was invisible to it: GA4's
    // editor_action/split is the only other trace and GA4 is ad-blocked wholesale
    // for a large share of users. Fired here, not in page-manager.js, which has no
    // tel import and whose only job is the selection. An intent-side action like
    // 'arm' — it is deliberately NOT in COMMIT_ACTIONS (nothing was edited).
    tel('tool_use', { tool: 'halaman', action: 'extract' });
    const t0 = performance.now(); // extract_export.duration — tap to bytes-in-hand
    // Export ONLY the selected pages: a shallow Doc sharing the same sources.
    try {
      toast(tr('toast.preparing'));
      const { buildPdfArtifact } = await import('./pdf-builder.js');
      const subset = { sources: doc.sources, pages, selection: { pageId: null, annotationId: null } };
      // Same font-fallback witness the Unduh sheet carries (download-sheet.js,
      // audit finding 2): a failed font fetch substitutes Helvetica in the
      // kept file, and the user must hear about it — the warn toast outranks
      // the success one (same "skips take priority" law as the load loop).
      const { bytes, fontFallback } = await buildPdfArtifact(subset);
      download(new Blob([bytes], { type: 'application/pdf' }), `${baseName}-halaman-${pages.length}.pdf`);
      // The file exists now — whatever the toast below says. Its own event rather
      // than an `export`: see extract_export in core/telemetry-schema.js for why
      // folding it into the Unduh sheet's event would corrupt that funnel.
      tel('extract_export', {
        duration: durationBucket(performance.now() - t0),
        pages: pagesBucket(pages.length),
        pages_scope: pages.length >= doc.pages.length ? 'all' : 'some',
      });
      if (fontFallback) {
        // Ratified by Fauzan 2026-08-14 (PM STATE.md "RATIFIED 2026-08-14").
        toast(tr('toast.fontSubstituteResult'));
        tel('failure', { stage: 'export', reason: 'font-fallback', class: 'none', blocked: false });
      } else {
        toast(tr('toast.extractDone', { count: pages.length }));
      }
    } catch (err) {
      console.error(err);
      toast(tr('toast.extractFailed'));
    }
  },
  toast,
});
// The per-page control strip above each page in the stage (↑ ↓ putar hapus). It
// drives the SAME pageManager mutations as the sheet, so there is one behaviour.
// rebuildStage() above calls it; it is only ever called after module start-up.
const pageStrips = createPageStrips({ stage, scrollEl, getDoc: () => doc, pageManager });
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
on('btn-pages', 'click', openPagesSheet);
on('pm-close', 'click', () => pageManager.close());

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
  applyTextFont(ed, style);
  ed.style.color = style.color || '#000';
  ed.textContent = anno?.text || draft?.text || '';
  // RUNG D: a paragraph draft turns the editor into the paragraph's box (its
  // width, alignment, indent; line height comes with the font, above).
  const blockPlan = draft?.block || null;
  if (blockPlan) styleBlockEditor(ed, blockPlan);

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
  // Font estimation may finish after the editor opens. Once someone types,
  // their text must not change size/position underneath their caret.
  if (draft?.ocrCoverId) {
    ed.addEventListener('input', () => { draft.appearanceLocked = true; });
    ed.addEventListener('compositionstart', () => { draft.appearanceLocked = true; });
  }
  syncFormatBar();

  let committed = false; // guard: blur fires after Enter-commit too
  let escaped = false;   // Escape = back out; an empty commit without it = delete the line
  let releaseKeyboardWatch = () => {};
  const commit = () => {
    if (committed) return;
    committed = true;
    releaseKeyboardWatch(); // before ed.remove(), so the listener never outlives its element
    // RUNG D: read the paragraph's line breaks off the editor BEFORE it leaves
    // the DOM — they are what the file will hold (js/v2/block-editor.js).
    const blockLines = blockPlan ? readEditorLines(ed) : null;
    const blockTop = blockPlan ? parseFloat(ed.style.top) : null;
    const text = blockLines ? logicalTextOf(blockLines) : ed.textContent.trim();
    ed.remove();
    editingAnno = null;
    editingEl = null;
    editingIsReplace = false;
    // After the rest of this commit has run: a sync deferred while the editor
    // was open (see syncPage) catches up now.
    if (deferredSync.size) Promise.resolve().then(flushDeferredSync);
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
    let gantiFlips = 0; // whole-line face changes while typing, for `insert`
    if (anno) {
      if (text && text !== anno.text) {
        record(history, doc);
        updateAnnotation(doc, anno.id, { text });
        track('editor_action', { action: 'text_inline' });
        tel('tool_use', { tool: 'teks', action: 'text_inline' });
        touchedEdit = !!anno.replaceCoverId;
        if (anno.replaceCoverId) {
          // ⚠️ KNOWN ASYMMETRY (audit 2026-08-09, finding 9): here font_path's
          // 'doc-font' means only "a doc FontFace was loaded" (presence) —
          // the fresh-commit branch below runs a real per-glyph coverage
          // check (textCoveredBy). The committed annotation carries no
          // docFontkitFont to re-check against, and changing what an EXISTING
          // telemetry field means is EXCLUDE 4 (his hand) — so this stays,
          // stated rather than silent. Rail readers: re-typed edits are the
          // weaker population.
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
      if (draft?.ocrReEdit) {
        // Rung S2's mirror of the reEdit branch below. Drop the previous
        // cover+text pair and rebuild against the SAME recognised box, so a
        // page never accumulates two edits over one line. No surgery is
        // involved on this ladder (there are no show-ops to cut), so unlike
        // the born-digital branch there is no pristine-source target to
        // re-anchor to — the recognised box IS the durable anchor.
        removeAnnotation(doc, draft.ocrReEdit.coverId);
        if (draft.ocrReEdit.textId) removeAnnotation(doc, draft.ocrReEdit.textId);
        const newCover = addAnnotation(doc, pageId, createAnnotation('whiteout', {
          x: draft.ocrReEdit.box.x, y: draft.ocrReEdit.box.y,
          width: draft.ocrReEdit.box.w, height: draft.ocrReEdit.box.h,
          color: draft.ocrReEdit.coverColor,
          ...(draft.ocrReEdit.paperImage ? { paperImage: draft.ocrReEdit.paperImage } : {}),
          ocrBox: draft.ocrReEdit.box,
        }));
        d = { ...d, ocrCoverId: newCover.id };
      }
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
      // Rung S2's pairing key. Same omit-if-absent shape, and deliberately NOT
      // replaceCoverId: that name is what core/page-surgery.js looks for when
      // it decides a text annotation should be stamped natively into a page
      // whose original run it just cut. Nothing was cut here.
      const ocrProps = d.ocrCoverId ? { ocrCoverId: d.ocrCoverId } : {};
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
      // THE LINE'S FONT DECISION (core/line-font.js), decided on the text being
      // committed — the one face the editor painted, which the stamp follows
      // and re-verifies and export draws when surgery declines. A bundled face
      // also sets fontFamily/bold/italic to match it, so even the twin drawer's
      // last resort draws the face the user saw. Absent when the editor's fonts
      // had not loaded yet: the old ladder decides, as before (decided_live
      // false on the rail).
      const fontDecision = d.replaceCoverId && draft?.lineFont ? draft.lineFont.decideNow(text) : null;
      const faceProps = fontDecision?.face ? faceStyle(fontDecision.face) : null;
      const fontDecisionProps = fontDecision ? { fontDecision } : {};
      if (fontDecision) gantiFlips = draft.lineFont.flips;
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
        // A paragraph's typed line breaks are layout, not glyphs to cover.
        const coverText = blockLines ? text.replace(/[\r\n]/g, '') : text;
        const covered = !!d.docFontkitFont && textCoveredBy(d.docFontkitFont, coverText);
        // Name-only ruling (2026-07-20 evening): a file with NO embedded
        // program + an exact metric clone routed = nothing real was
        // substituted — silent. See prepareDocFont for the fields' WHY.
        const nameOnlyClone = d.fontUnembedded && d.cloneRouted;
        if (!covered && !nameOnlyClone) toast(tr('toast.fontSubstituteChar'));
        // font_path is 'doc-font' only when the document's OWN font paints
        // this — a name-only clone is still a substitute, so it reads as
        // 'twin' (the schema's font_path enum has no separate 'clone' value).
        gantiOutcome = 'commit';
        gantiCoverId = d.replaceCoverId;
        gantiDocFont = covered;
      }
      // RUNG D: the painted lines + the paragraph's geometry ride the
      // replacement (core/block-edit.js blockAnnotation); it sits where the
      // editor sat.
      const blockProps = blockLines && d.replaceCoverId ? { block: blockAnnotation(draft.block, blockLines) } : {};
      const created = addAnnotation(doc, pageId, createAnnotation('text', {
        text,
        x: blockProps.block ? draft.block.disp.x : (d.scanPlacement?.x ?? x),
        y: blockProps.block ? blockTop : (d.scanPlacement?.y ?? y),
        fontSize: d.fontSize, fontFamily: faceProps?.family ?? d.fontFamily,
        bold: faceProps ? faceProps.bold : d.bold, italic: faceProps ? faceProps.italic : d.italic, color: d.color,
        ...replaceProps,
        ...ocrProps,
        ...docFontProps,
        ...styleSourceProps,
        ...fontDecisionProps,
        ...blockProps,
      }));
      // RUNG D, spec §6 (his ⚖, recommended default): width is law, height is
      // not. A paragraph that grew past its own lines into the text below it
      // says so once, plainly; nothing is shrunk or clipped.
      if (blockProps.block) {
        const b = blockProps.block;
        // Ink, not line boxes: the last baseline plus a descender (the same
        // measure the page-bottom guard uses), against the top of the box of
        // the nearest line below.
        const grownBottom = b.disp.y + (b.lines.length - 1) * b.k * b.leading + 0.25 * b.k * b.size;
        if (b.lines.length > b.srcLines && b.below !== null && grownBottom > b.below) toast(tr('toast.blockGrew'));
      }
      // Authored text stays SELECTED (the user sees it's an object; a format
      // tweak right after the blur-commit still lands). A Ganti Teks commit
      // does NOT auto-select: post-commit selection resurfaces the format bar
      // on the flow's last frame — the redefine-invitation the founder ruled
      // out (taste-judge finding, night run 2026-07-19). A later deliberate
      // tap still selects it like any text object — one grammar, kept.
      if (!draft) selectAnnotation(doc, created.id);
      // COUNT IT, DON'T WARN ABOUT IT (changed 2026-09-06). This used to toast
      // `Huruf ✓ nggak bisa disimpan pakai font ini` — true from 2026-07-29,
      // when a character a standard font cannot encode aborted the whole
      // export, and the toast was the only defence. It is FALSE now:
      // core/export.js paints such an annotation as an image the browser
      // rendered (drawTextAsImage, js/v2/text-raster.js) and the export goes
      // through. The rail showed the warning never worked as a defence anyway:
      // one user pressed through it 24 times in 14 minutes and still left with
      // nothing (2026-08-31). A warning that names a wall that no longer
      // exists is copy doing no job, so it is deleted rather than reworded
      // (his standing instruction, 2026-08-28); if he wants a heads-up that
      // the character ships as an image, that is his copy to write.
      //
      // The failure event STAYS, unchanged in meaning: `commit/unsupported`
      // has always meant "a character the standard font cannot encode was
      // committed", and it still does — it is now also the count of
      // annotations that take the raster path at export. blocked:false as
      // before: the text below is committed either way.
      // AUTHORED TEXT ONLY. A Ganti Teks replace runs a real coverage check
      // against the document's own font a few lines up and reports through
      // `insert` instead. Caught by tests/font-coverage.spec.js.
      if (!d.replaceCoverId && isStandardFamily(d.fontFamily)) {
        const bad = unencodableInStandardFont(text);
        if (bad.length) {
          // `class` from the FIRST offending character only, through
          // unsupportedCharClass — which returns an enum and nothing else, so
          // the character cannot ride along. 'emoji' and 'cjk' are entirely
          // different product problems and were indistinguishable here until
          // 2026-08-09.
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
    } else if ((draft?.replaceCoverId || draft?.ocrCoverId) && !escaped) {
      // EMPTY FRESH COMMIT = DELETE THE LINE (founder ruling 2026-10-02, with
      // Hapus: "itu naturally yang mereka mau"). Clearing a line's words and
      // committing used to be the BACKOUT: onCancel took the cover back and the
      // original stayed, so a person who deleted the text watched it not be
      // deleted. Now the cover stays and no replacement is written: a pure
      // deletion, the same pair Hapus makes (cover with replaceTargets, no text
      // over it). For a paragraph draft it is the whole paragraph, which is what
      // clearing the whole paragraph means. ONE undo step, already recorded when
      // the cover was placed (`recorded: true`).
      // BACKING OUT IS UNCHANGED: Escape sets `escaped` (the keydown handler
      // below), which skips this branch and lands in the cancel one after it.
      // A scan draft has nothing to cut, so nothing to re-bake; its cover is the
      // deletion, and it needs the paper the editor's own appearance pass may
      // not have painted yet (that pass stands down once the editor is gone).
      const cov = findAnnotation(doc, draft.replaceCoverId || draft.ocrCoverId)?.annotation;
      if (cov?.ocrBox && !cov.paperImage) void paintScanPaper(cov, pageId, cov.ocrBox);
      touchedEdit = !!draft.replaceCoverId;
      gantiOutcome = 'delete';
      gantiCoverId = draft.replaceCoverId ?? null;
      gantiDocFont = false;
    } else if (draft?.onCancel) {
      // Ganti Teks backed out with nothing typed — take the cover back too.
      draft.onCancel();
      gantiOutcome = 'cancel';
      gantiCoverId = draft.replaceCoverId ?? draft.reEdit?.coverId ?? null;
      gantiDocFont = !!draft.docFontFamily;
    } else if (draft?.ocrReEdit) {
      // EMPTY RE-EDIT COMMIT = DELETE THE EDIT, rung S2's half. Identical
      // grammar to the born-digital branch below, and identical reason: before
      // this existed, clearing an S2 replacement and committing fell through
      // every case and silently did nothing — the user deleted the text,
      // blurred, and the old replacement was still sitting there.
      // What "the original returns" MEANS differs by ladder, and the
      // difference is why this is a separate branch rather than an extra
      // condition on the next one: born-digital has to un-bake a surgery, so
      // it sets touchedEdit and pays for a re-render. Here the original is
      // simply the pixels under the cover — removing the pair uncovers them,
      // and there is nothing to re-bake because nothing was ever cut.
      record(history, doc);
      removeAnnotation(doc, draft.ocrReEdit.coverId);
      if (draft.ocrReEdit.textId) removeAnnotation(doc, draft.ocrReEdit.textId);
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
          // flips is editor state (js/v2/line-font-live.js), so it joins the
          // stamp's outcome here rather than riding the model.
          if (oc.insert) tel('insert', { ...oc.insert, flips: gantiFlips });
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
    // Ctrl/Cmd+B / I = the format bar's buttons, for the WHOLE box. WHY
    // preventDefault always: the browser's native contenteditable bold styles
    // only the selection and is read back with textContent on commit, so it was
    // silently lost. WHY toggle only when !editingIsReplace: a Ganti draft hides
    // the format bar (founder ruling: editing != redefining), and with no
    // annotation yet the toggle would rewrite the sticky defaults behind it.
    // Ctrl/Cmd+U: no underline feature, so swallow the native one.
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const mk = e.key.toLowerCase();
      if (mk === 'b' || mk === 'i' || mk === 'u') {
        e.preventDefault();
        if (!editingIsReplace) {
          if (mk === 'b') formatBar.toggleBold();
          else if (mk === 'i') formatBar.toggleItalic();
        }
      }
    }
    // Escape = back out. Restore what the editor OPENED with, so commit()'s
    // no-op guards absorb it: the annotation's own text, or a RE-EDIT's
    // prefill (draft.text). Restoring '' on a re-edit would read as a
    // deliberate empty commit — which now DELETES the edit (the
    // `draft.reEdit` empty branch below) — the opposite of backing out.
    // A fresh Ganti draft keeps '' but SAYS it is backing out (`escaped`): its
    // empty commit used to be the cancel that takes the cover back, and now an
    // empty commit deletes the line (commit()'s fresh-draft branch), so the two
    // can no longer share one signal. The flag, not a restored prefill, because a
    // paragraph's editor reads its text back as laid-out rows and a rewritten
    // textContent is not guaranteed to read back as the same words.
    // ocrReEdit sits beside reEdit here for the same reason it does in
    // commit(): a rung S2 re-edit is a re-edit, and Escape must back out of
    // one rather than empty-commit it into a deletion.
    if (e.key === 'Escape') {
      escaped = true;
      ed.textContent = anno?.text ?? ((draft?.reEdit || draft?.ocrReEdit) ? draft.text : '') ?? '';
      ed.blur();
    }
    e.stopPropagation(); // don't trigger app shortcuts while typing
  });
  ed.addEventListener('pointerdown', (e) => e.stopPropagation());

  overlay.appendChild(ed);
  ed.focus();
  // SINGLE-LINE EDIT ONLY (a paragraph reflows, so it has no such limit): the
  // first time per document the typed text is wider than the original line,
  // say the line cannot wrap. The once-per-document check runs BEFORE the one
  // offsetWidth read, so after the message it costs nothing per keystroke.
  // offsetWidth is page-space layout px (pre-zoom), the same frame as
  // originalWidth, which comes from line.w.
  if (draft && !blockPlan && draft.originalWidth > 0) {
    const onWider = () => {
      if (alreadyShownForDoc(doc, 'lineNoWrap')) { ed.removeEventListener('input', onWider); return; }
      if (!lineOutgrew(ed.offsetWidth, draft.originalWidth)) return;
      // Never over another message: the refused-character note fires on the same
      // keystroke and would be replaced before anyone read it. Wait for a quiet
      // moment instead; the line is still too wide on the next keystroke.
      if (toastEl.classList.contains('show')) return;
      if (firstTimeForDoc(doc, 'lineNoWrap')) toast(tr('toast.lineNoWrap'));
      ed.removeEventListener('input', onWider);
    };
    ed.addEventListener('input', onWider);
  }
  if (blockPlan) {
    // First baseline onto the paragraph's first baseline — now, once the
    // editor has a layout, and again on every face change (prepareDocFont /
    // line-font-live.js call draft.onFontShown) or late web-font load.
    const place = () => placeBlockEditor(ed, blockPlan);
    draft.onFontShown = place;
    place();
    document.fonts?.ready?.then(place).catch(() => {});
    // Width is law, height is not — and the page's bottom is not a wall
    // either (founder, 2026-10-01: "the user sees it leave the page, so the
    // promise holds"). A paragraph may grow past the page; the editor paints
    // the overflow on the grey canvas (no ancestor of .v2-text-edit clips:
    // .pv-page and .pv-overlay set no overflow), the commit writes every
    // line at its own baseline even where y < 0, and the file simply holds
    // that text outside the page box. This used to refuse the keystroke with
    // toast.blockPastPage; the refusal is gone, not softened.
  }
  // focus is what raises the keyboard, so the watch starts here and is released
  // in commit() above — the only path out of this editor.
  releaseKeyboardWatch = keepAboveKeyboard(ed);
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

// ---- signature modal (draw / upload) --------------------------------------------
// The signature the open modal will REPLACE, or null for "make a new one". Set
// only by Gambar Ulang, read once by onReady. WHY not "whatever is selected at
// onReady": a pasted image is a signature-type object and stays selected after
// the paste, so tapping TTD to make a first signature swapped the user's pasted
// stamp or logo for the drawing. Replacing is an explicit act, never a side effect.
let redrawTargetId = null;
// SINGLE SOURCE OF TRUTH for opening the sheet: every open states its target, so
// a cancelled Gambar Ulang can never leave one behind for the next TTD tap.
function openSignatureModal(targetId = null) {
  redrawTargetId = targetId;
  signatureModal.open();
}
const signatureModal = createSignatureModal({
  modal: document.getElementById('sig-modal'),
  toast,
  onReady: (sig) => {
    storedSignature = sig; // { dataUrl, width, height }
    // Founder punch list #1: if a placed signature is SELECTED when the user
    // redraws, they're fixing THAT one — swap its image in place instead of
    // making them delete + re-place. Otherwise arm placement as before.
    const targetId = redrawTargetId;
    redrawTargetId = null;
    const hit = targetId ? findAnnotation(doc, targetId) : null;
    const found = hit && hit.annotation.type === 'signature' ? { page: hit.page, anno: hit.annotation } : null;
    if (found) {
      record(history, doc);
      found.anno.image = sig.dataUrl;
      found.anno.height = found.anno.width * (sig.height / sig.width);
      rebuildStage();
      toast(tr('toast.signatureReplaced'));
      return;
    }
    setTool('signature');
    toast(tr('toast.armSignature'));
  },
});

// ---- "Semua Hal." — copy the selected signature to every page ----------------------
function selectedSignatureAnno() {
  const id = doc.selection.annotationId;
  const found = id ? findAnnotation(doc, id) : null;
  return found && found.annotation.type === 'signature'
    ? { page: found.page, anno: found.annotation }
    : null;
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
    ? tr('sigBar.signatureSelected')
    : (armed ? tr('sigBar.armed') : '');
}
on('btn-redraw-sig', 'click', () => openSignatureModal(selectedSignatureAnno()?.anno.id ?? null));

on('btn-all-pages', 'click', () => {
  const found = selectedSignatureAnno();
  if (!found) return;
  const { page: home, anno } = found;
  record(history, doc);
  for (const page of doc.pages) {
    if (page.id === home.id) continue;
    // Same position on every page; each copy is its OWN object (new id) so it
    // moves/deletes independently afterwards.
    addAnnotation(doc, page.id, createAnnotation('signature', {
      image: anno.image,
      x: anno.x, y: anno.y, width: anno.width, height: anno.height,
    }));
  }
  rebuildStage();
  toast(tr('toast.signatureCopied', { count: doc.pages.length - 1 }));
});

// ---- delete / undo / redo ------------------------------------------------------------
function deleteSelected() {
  const id = doc.selection.annotationId;
  if (!id) return;
  const found = findAnnotation(doc, id);
  const pageId = found?.page.id ?? null;
  record(history, doc);
  removeAnnotation(doc, id);
  tel('tool_use', { tool: 'hapus', action: 'delete' }); // spec-telemetry.md §6.2
  // Same reason as onDeleteTap: a replacement's text is part of the baked page.
  if (pageId && found.annotation.replaceCoverId) bakeAfterEditChange(pageId, null);
  else if (pageId) syncPage(pageId);
}

// ---- copy / cut / paste / duplicate (Canva/Figma-style) -----------------------------
// The app's OWN clipboard, in memory only: the system clipboard is never written,
// and read only through the `paste` event the user's own Ctrl/Cmd+V raises (see
// the paste listener below; signature-modal.js owns paste while its sheet is
// open). `annoClipboard` is a detached snapshot (core/model.js cloneForPaste), so
// editing the source after Ctrl+C cannot change what Ctrl+V pastes. `pasteCount`
// steps the paste +10px from the SOURCE position each time, Canva-style.
let annoClipboard = null;
let pasteCount = 0;
// True while the in-app copy is plausibly still the NEWEST thing on the user's
// clipboard. The app never writes the system clipboard, so it cannot see another
// app copy over it; what it CAN see is the window losing focus (you have to leave
// to copy elsewhere) or a native copy/cut inside the page. Either one ends the
// claim, and a later paste then goes to what the system clipboard carries.
let annoCopyFresh = false;
const staleAnnoCopy = () => { annoCopyFresh = false; };
window.addEventListener('blur', staleAnnoCopy);
document.addEventListener('visibilitychange', staleAnnoCopy);
document.addEventListener('copy', staleAnnoCopy);
document.addEventListener('cut', staleAnnoCopy);

function selectedFound() {
  const id = doc.selection.annotationId;
  return id ? findAnnotation(doc, id) : null;
}

// True when a copyable annotation is now on the app clipboard.
function copySelected() {
  const found = selectedFound();
  if (!found || !isCopyable(found.annotation)) return false; // doc-bound kinds: see cloneForPaste
  annoClipboard = cloneForPaste(found.annotation);
  pasteCount = 0;
  annoCopyFresh = true;
  return true;
}

// The page a paste lands on: the selected object's page if it is on screen,
// else the page under the viewport midline (focusedPageId), else the selection's
// page, else the first page.
function pasteTargetPageId() {
  const found = selectedFound();
  const vp = scrollEl.getBoundingClientRect();
  const onScreen = (pageId) => {
    const slot = slots.find((s) => s.page.id === pageId);
    if (!slot) return false;
    const r = slot.view.getBoundingClientRect();
    return r.bottom > vp.top && r.top < vp.bottom;
  };
  if (found && onScreen(found.page.id)) return found.page.id;
  if (focusedPageId && getPage(doc, focusedPageId)) return focusedPageId;
  if (doc.selection.pageId && getPage(doc, doc.selection.pageId)) return doc.selection.pageId;
  return doc.pages[0]?.id ?? null;
}

// ONE undo step: record, add + offset the copy, select it, repaint the pages involved.
function placeCopy(pageId, src, n) {
  if (!pageId || !isCopyable(src)) return null;
  const prev = selectedFound();
  record(history, doc);
  const clone = duplicateAnnotation(doc, pageId, src, n);
  if (!clone) return null;
  selectAnnotation(doc, clone.id);
  // The old selection's chrome must go: repaint its page too when it is another one.
  if (prev && prev.page.id !== pageId) syncPage(prev.page.id);
  syncPage(pageId);
  return clone;
}

// The paste (a system-clipboard image or text, see the listener below) shares
// placeCopy's contract: ONE undo step, the new object selected, the pages involved
// repainted, and the tool back to Pilih ("tools are verbs").
function placePasted(pageId, type, props) {
  const prev = selectedFound();
  record(history, doc);
  const created = addAnnotation(doc, pageId, createAnnotation(type, props));
  selectAnnotation(doc, created.id);
  if (prev && prev.page.id !== pageId) syncPage(prev.page.id);
  syncPage(pageId);
  if (tool !== 'select') setTool('select');
  return created;
}

// The middle of what the user can see of `pageId`, in that page's own px (what
// annotations are positioned in). A page scrolled out of view falls back to its
// own middle.
function visibleCentreOf(pageId) {
  const slot = slots.find((sl) => sl.page.id === pageId);
  const { width, height } = pageDisplaySize(getPage(doc, pageId));
  if (!slot) return { x: width / 2, y: height / 2 };
  const r = slot.view.getBoundingClientRect();
  const vp = scrollEl.getBoundingClientRect();
  const left = Math.max(r.left, vp.left), right = Math.min(r.right, vp.right);
  const top = Math.max(r.top, vp.top), bottom = Math.min(r.bottom, vp.bottom);
  if (right <= left || bottom <= top) return { x: width / 2, y: height / 2 };
  return { x: ((left + right) / 2 - r.left) / zoom, y: ((top + bottom) / 2 - r.top) / zoom };
}

const PASTE_IMAGE_MAX_PX = 1200;  // longer side kept in the file; same cap as a drawn/uploaded signature
const PASTE_IMAGE_PAGE_FRAC = 0.6; // an image never lands bigger than this share of the page's width or height

// A pasted image becomes a signature-type object (movable, aspect-locked resize,
// Semua Hal.) — the one image object the model and export already have. It is
// decoded and re-drawn on a canvas, never uploaded: the bytes stay in this tab.
// PNG unless the source is a JPEG, which export embeds as JPEG (a photo
// re-encoded as PNG would bloat the file several times over).
async function pasteImageFile(file) {
  const img = new Image();
  const url = URL.createObjectURL(file);
  try {
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url; });
  } catch { return; } finally { URL.revokeObjectURL(url); }
  if (doc.pages.length === 0 || !img.naturalWidth || !img.naturalHeight) return;
  const k = Math.min(1, PASTE_IMAGE_MAX_PX / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.naturalWidth * k));
  c.height = Math.max(1, Math.round(img.naturalHeight * k));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const image = file.type === 'image/jpeg' ? c.toDataURL('image/jpeg', 0.92) : c.toDataURL('image/png');
  const pageId = pasteTargetPageId();
  if (!pageId) return;
  const pg = pageDisplaySize(getPage(doc, pageId));
  const fit = Math.min(1, (pg.width * PASTE_IMAGE_PAGE_FRAC) / c.width, (pg.height * PASTE_IMAGE_PAGE_FRAC) / c.height);
  const width = c.width * fit;
  const height = c.height * fit;
  const mid = visibleCentreOf(pageId);
  placePasted(pageId, 'signature', {
    image, width, height,
    x: Math.max(0, Math.min(pg.width - width, mid.x - width / 2)),
    y: Math.max(0, Math.min(pg.height - height, mid.y - height / 2)),
  });
}

// Plain text becomes a text object in the bar's current style, exactly what the
// Teks tool would have made (the same defaults, the same export path: newlines
// are lines, odd whitespace is normalised at export).
function pasteText(text) {
  const pageId = pasteTargetPageId();
  if (!pageId) return;
  const pg = pageDisplaySize(getPage(doc, pageId));
  const mid = visibleCentreOf(pageId);
  placePasted(pageId, 'text', {
    ...formatBar.getDefaults(), text,
    x: Math.max(0, Math.min(pg.width - 20, mid.x - 60)),
    y: Math.max(0, Math.min(pg.height - 20, mid.y - 10)),
  });
}

// Ctrl/Cmd+V from the SYSTEM clipboard, read through the paste event only (never
// the async Clipboard API: no permission prompt, and only what the user just
// asked to paste). Order, a judgment call and why:
//   1. the in-app copy while it is fresh (annoCopyFresh): the user pressed
//      Ctrl+C on an object a moment ago and the system clipboard still holds
//      whatever was there BEFORE, which is almost always stale (a URL, last
//      week's screenshot). The keydown handler already took this case; it is
//      repeated here for pastes that arrive without that keydown (context menu).
//   2. an image on the system clipboard, then 3. its plain text.
//   4. otherwise a stale in-app copy, e.g. the system clipboard held a file.
// Stands down for: an open sheet (the signature dialog has its own paste), any
// field or the inline editor (native paste into the text), no document, and a
// paste another listener already took.
document.addEventListener('paste', (e) => {
  if (e.defaultPrevented || doc.pages.length === 0 || document.querySelector('dialog[open]')) return;
  // WHY isContentEditable, not a selector on the target: a paste's target is the
  // element holding the caret, which after a rich paste into the inline editor
  // is a <span> INSIDE it. The selector missed, and the next Ctrl+V placed a new
  // object and tore the open editor out of the DOM, losing what was typed.
  if (e.target.isContentEditable || e.target.closest?.('input, select, textarea')) return;
  if (annoClipboard && annoCopyFresh) { if (pasteCopy()) e.preventDefault(); return; }
  const cd = e.clipboardData;
  let file = null;
  for (const item of cd?.items || []) {
    if (item.kind === 'file' && item.type.startsWith('image/')) { file = item.getAsFile(); if (file) break; }
  }
  if (file) { e.preventDefault(); void pasteImageFile(file); return; }
  const text = (cd?.getData('text/plain') || '').replace(/\r\n?/g, '\n').trim();
  if (text) { e.preventDefault(); pasteText(text); return; }
  if (annoClipboard && pasteCopy()) e.preventDefault();
});

function pasteCopy() {
  if (!annoClipboard) return false;
  pasteCount += 1;
  return !!placeCopy(pasteTargetPageId(), annoClipboard, pasteCount);
}

// Duplicate in place: +10px on the selection's own page, clipboard untouched
// (Figma's Ctrl+D). The copy is selected, so a second press cascades.
function duplicateSelected() {
  const found = selectedFound();
  return !!(found && placeCopy(found.page.id, found.annotation, 1));
}

// spec-live-surgery.md §5/§8.3 (increment 3): undo/redo can bring a page's
// committed edits into or out of existence — capture the PRE-op pages so
// syncEditedRasters can diff edit-signatures by page.id afterward and
// re-bake only the pages that actually changed.
function doUndo() {
  const prevPages = doc.pages;
  if (undo(history, doc)) afterHistoryStep(prevPages);
}
function doRedo() {
  const prevPages = doc.pages;
  if (redo(history, doc)) afterHistoryStep(prevPages);
}
function afterHistoryStep(prevPages) {
  pageManager.invalidateThumbs();
  rebuildStage();
  syncEditedRasters(prevPages);
  // Ctrl+Z is allowed inside the Halaman sheet (keydown below), so its grid
  // must show the restored pages, or the next drag reorders a stale grid.
  if (document.getElementById('pm-sheet').open) pageManager.render();
}
on('btn-undo', 'click', doUndo);
on('btn-redo', 'click', doRedo);

document.addEventListener('keydown', (e) => {
  // Never hijack typing surfaces (the inline editor stops propagation itself).
  if (e.target.isContentEditable || e.target.closest?.('input, select, textarea')) return;
  const mod = e.ctrlKey || e.metaKey;
  // WHY lowercased: Shift (or CapsLock) turns e.key into 'Z', so a bare
  // `e.key === 'z'` never matched Ctrl/Cmd+Shift+Z and redo-by-keyboard never fired.
  const key = e.key.toLowerCase();
  // WHY the open-sheet guard: the editor's keys must not act on the document
  // behind a sheet. Ctrl+Z behind Unduh changed the doc after the sheet built
  // its bytes, so the download was the old state and markClean then called the
  // changed doc saved; Delete on a focused Halaman tile deleted the editor's
  // selected annotation. Kept: Escape (resets the tool, the dialog closes
  // itself) and undo/redo in the Halaman sheet, whose page moves it shows live,
  // but only when it is the ONLY open dialog: in pick mode it sits on top of
  // Unduh, and querySelector returns the first in DOM order (#pm-sheet), which
  // let Ctrl+Z through behind Unduh's already-built bytes.
  const openSheets = document.querySelectorAll('dialog[open]');
  if (openSheets.length && e.key !== 'Escape'
    && !(openSheets.length === 1 && openSheets[0].id === 'pm-sheet' && mod && (key === 'z' || key === 'y'))) return;
  if (mod && key === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); }
  else if (mod && key === 'y') { e.preventDefault(); doRedo(); }
  else if (mod && !e.altKey && !e.shiftKey && 'cxvd'.includes(key) && key.length === 1 && !document.querySelector('dialog[open]')) {
    // WHY the open-dialog guard: preventDefault on Ctrl+V's keydown suppresses the
    // `paste` event, which the signature sheet needs for image paste. WHY no
    // preventDefault when there is nothing to do: native behaviour stays intact.
    // Shift is excluded (Ctrl+Shift+C is the browser's inspector). C/X also stand
    // down while the user has native text selected somewhere (toast, sheet copy).
    const textSelected = !!window.getSelection?.()?.toString();
    if (key === 'c' && !textSelected) { if (copySelected()) e.preventDefault(); }
    else if (key === 'x' && !textSelected) { if (copySelected()) { e.preventDefault(); deleteSelected(); } }
    else if (key === 'v') {
      // Only a FRESH in-app copy is pasted here (and so suppresses the paste event);
      // anything else falls through to the paste listener, which can read the system clipboard.
      if (annoClipboard && annoCopyFresh && pasteCopy()) e.preventDefault();
    }
    else if (key === 'd' && selectedFound()) { e.preventDefault(); duplicateSelected(); } // browsers bookmark on Ctrl+D
  }
  else if (mod && !e.altKey && (key === 'b' || key === 'i') && selectedTextAnno()) {
    // Same as the format bar's B / I (preventDefault: Firefox opens bookmarks on Ctrl+B).
    e.preventDefault();
    if (key === 'b') formatBar.toggleBold(); else formatBar.toggleItalic();
  }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && doc.selection.annotationId) {
    e.preventDefault(); deleteSelected();
  } else if (e.key === 'Escape') {
    // Native <dialog> closes itself on Escape; this handles the editor surface.
    clearSelection(doc);
    interaction.setSelected(null, null);
    setTool('select');
  } else if (!mod && doc.pages.length > 0) {
    // Tool verbs — same keys as the old editor (muscle memory carries over).
    const k = key;
    if (k === 'v') setTool('select');
    else if (k === 't') setTool('text');
    else if (k === 'w') setTool('whiteout');
    else if (k === 'g') setTool('ganti');
    else if (k === 's' || k === 'p') {
      if (storedSignature) setTool('signature');
      else openSignatureModal();
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

// ---- the merge guard: a document that cannot be rebuilt must not be merged ----
//
// Two parsers read every file: PDF.js to show it, pdf-lib to write it back. They
// do not agree on every file (core/import.js pdfLibLoadError has the why). A
// single untouched file never meets pdf-lib (core/export.js passThroughSource
// hands its bytes back), so a lone file is NEVER checked here; it keeps opening,
// editing-for-view and downloading as before. A MERGE always rebuilds, so the
// moment a second file would join, every PDF involved is proven loadable by
// pdf-lib first, and a file that is not is declined through the same path as
// any unreadable file (skipped, counted on the rail as import/corrupt). Nothing
// is rasterised or repaired: the user's document is never changed behind their
// back, and they learn which file to leave out while it still costs nothing.
// Rail before this: `export/corrupt`, 5 sessions, every one a merge, no file.
const rebuildVerdicts = new Map(); // sourceId -> Promise<Error|null>

// pdf-lib's load error for `bytes`, or null. If pdf-lib itself cannot be
// fetched (offline) we do not know, and not knowing never blocks an import.
async function rebuildLoadError(bytes) {
  let PDFLib;
  try { ({ PDFLib } = await ensurePdfLib()); } catch { return null; }
  return pdfLibLoadError(PDFLib, bytes);
}

// The first already-open PDF source pdf-lib cannot rebuild, as its error, or null.
// Verdicts are cached per source so a later merge does not parse it again.
async function firstUnrebuildableSource() {
  for (const source of doc.sources) {
    if (!doc.pages.some((p) => p.sourceId === source.id && !p.isFromImage)) continue; // an image's bytes are not parsed
    if (!rebuildVerdicts.has(source.id)) rebuildVerdicts.set(source.id, rebuildLoadError(source.bytes));
    const err = await rebuildVerdicts.get(source.id);
    if (err) return err;
  }
  return null;
}

let loadingFiles = false; // re-entry guard: double-taps and rapid picks interleave imports

async function loadFiles(files) {
  if (loadingFiles) { toast(tr('toast.stillLoading')); return; }
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
  if (usable.length === 0) { toast(tr('toast.pickFile')); return; }
  const oversize = usable.find((f) => f.size > SIZE_BLOCK);
  if (oversize) { toast(tr('toast.tooBig', { name: oversize.name })); return; }
  const pagesBefore = doc.pages.length;
  const firstLoad = pagesBefore === 0;
  if (firstLoad) baseName = usable[0].name.replace(/\.[^.]+$/, '');

  // Telegraph the parse loop. Note the >20MB heads-up toast is gone: it fired
  // here but sat hidden BEHIND this overlay (z-order), and the overlay itself
  // — plus its "diproses di HP-mu" note — is the honest heads-up now.
  showProcessing(usable.length);
  // A merge rebuilds the document, so every PDF in it must be one pdf-lib can
  // parse (see the merge guard above). Already-open sources first: if one of
  // THEM cannot be rebuilt, adding anything makes the export impossible, and
  // blaming the new file would be wrong. Say which side it is, and stop.
  const rebuilds = doc.sources.length > 0 || usable.length > 1;
  if (doc.sources.length > 0) {
    const err = await firstUnrebuildableSource();
    if (err) {
      toast(tr('toast.mergeBlocked'));
      // NOT failure/import/corrupt: that triple means "THIS file could not be
      // opened", and the new file here would have opened fine. The open document
      // is the one that cannot be rebuilt, so it gets its own event (schema:
      // merge_blocked) and the import/corrupt count stays about new files only.
      tel('merge_blocked', { reason: 'open_unrebuildable', pages: pagesBucket(doc.pages.length) });
      return;
    }
  }
  // Per-file resilience: one empty/corrupt/unreadable file must NOT crash the whole
  // load. Before this guard, a 0-byte PDF (Sentry JAVASCRIPT-H) and a file that went
  // unreadable after the picker handed its reference (JAVASCRIPT-G) both bubbled to
  // onunhandledrejection — the user saw a silent broken load. Now we skip the bad
  // one, keep the good ones, and say so plainly. Honest failure is still feedback.
  let failed = 0;
  let lastFailureReason = null; // see the catch block below and the toast after the loop
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
        // Same catch as any unreadable file: skipped, rail import/corrupt, blocked:true.
        if (rebuilds) {
          const loadErr = await rebuildLoadError(bytes);
          if (loadErr) throw loadErr;
        }
        const importedPages = await importPdf(doc, { name: f.name, bytes });
        if (rebuilds) rebuildVerdicts.set(doc.sources.at(-1).id, Promise.resolve(null)); // just proven
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
          toast(tr('toast.lockedReadOnly')); // TODO(copy): his words
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
        // Read SYNCHRONOUSLY, for the same reason docIntent is: the probe's
        // .then can resolve after the NEXT file in a multi-file merge loop has
        // already been added, and `doc.sources.at(-1)` would then describe the
        // wrong file.
        const docSigned = !!doc.sources.at(-1)?.signed;
        probeTextLayer(bytes)
          .then((hasText) => tel('doc_open', {
            text_layer: hasText, signed: docSigned,
            pages: pagesBucket(importedPages.length), device: deviceClass(), intent: docIntent,
            display_mode: displayMode(),
          }))
          .catch(() => {});
      } else {
        await importImage(doc, { name: f.name, bytes, mimeType: f.type });
        // An image page has no text layer at all — that's the scan ladder's
        // own job (spec-edit-dokumen-foto.md), not this rail's.
        // signed:false — an image has no PDF structure to carry a signature.
        tel('doc_open', { text_layer: false, signed: false, pages: pagesBucket(1), device: deviceClass(), intent: docIntent, display_mode: displayMode() });
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
      // lastFailureReason feeds the single-file toast below (STATE.md
      // "RATIFIED 2026-08-14"): a user-password-protected PDF (PDF.js itself
      // throws PasswordException, unlike terkunci.pdf's empty-user-password
      // shape which opens fine) deserves "dikunci sandi", not "kosong atau
      // rusak". Only meaningful when usable.length === 1 below — a multi-file
      // batch has no single reason to report and keeps the generic wording.
      // Calls failureReason(err) again rather than reusing a shared variable
      // in the tel() call below: tests/core/telemetry-coverage.test.mjs's
      // COVERAGE guard only accepts `failureReason(err)` or the DETERMINED
      // literals as the `reason` VALUE EXPRESSION at each tel('failure', …)
      // call site, so it can prove nothing hard-codes a rail value — an
      // indirection through an unrelated-looking variable is exactly what it
      // exists to catch.
      lastFailureReason = failureReason(err);
      tel('failure', { stage: 'import', reason: failureReason(err), class: 'none', blocked: true });
      // WHAT threw, as two enums (core/telemetry-schema.js failure_cause). The
      // import bucket was 'unknown' for 15 sessions in 14 days and nobody could
      // say whether that was HEIC, a giant photo, or our own code.
      tel('failure_cause', { stage: 'import', ...failureCause(err) });
    }
  }

  // Every file failed → leave the landing untouched, say it plainly, bail. Also
  // guards the doc.pages[0] read below, which would throw on an empty document.
  // After Buka Baru the landing is NOT showing (resetDoc emptied the editor in
  // place), so put it back: a blank editor with stale chrome was the result.
  if (doc.pages.length === 0) {
    document.body.classList.add('is-empty');
    emptyEl.style.display = '';
    refreshChrome();
    const singleLocked = usable.length === 1 && lastFailureReason === 'encrypted';
    toast(singleLocked
      ? tr('toast.openLocked')
      : usable.length === 1
        ? tr('toast.openFailedOne')
        : tr('toast.openFailedAll'));
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
  // A failed Buka Baru returns to the landing while still sitting on the guard
  // entry it pushed earlier; pushing again would orphan a second one.
  if (wasEmpty && !window.history.state?.v2doc) pushEditorHistoryState();

  if (firstLoad) {
    zoom = openingZoom(doc.pages[0].width);
  }
  rebuildStage(); // applies zoom + sizer at the end
  // A non-first load that actually grew the doc IS a merge (gabung). Fire at
  // COMPLETION so it counts real merges from EVERY entry point — the [+] tile,
  // the File menu, dropping more files onto an open doc — not sheet-opens. GA4's
  // gabungkan_used fired on page-manager open, which also covers split/reorder/
  // delete; this is the clean, merge-only signal the first-party rail lacked.
  if (!firstLoad && doc.pages.length > pagesBefore) {
    markChanged(history); // a merge is not undoable: an undo barrier (core/history.js)
    refreshChrome(); // the barrier just emptied the stacks; grey Undo/Redo now
    tel('tool_use', { tool: 'gabung', action: 'merge' });
  }
  // Honest close-out: skips take priority over the merge tally — the user needs to
  // know something was left out more than they need the count.
  if (failed > 0) {
    toast(tr('toast.skipped', { count: failed }));
  } else if (!firstLoad) {
    toast(tr('toast.merged', { count: doc.pages.length }));
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
    if (!storedSignature) { openSignatureModal(); return; }
    setTool('signature');
    toast(tr('toast.armSignature'));
  } else if (intent === 'teks') {
    setTool('text');
    toast(tr('toast.armText'));
  } else if (intent === 'tipex') {
    setTool('whiteout');
    toast(tr('toast.armWhiteout'));
  } else if (intent === 'kompres') {
    // /kompres-pdf-500kb declares <body data-intent="kompres" data-target="500000">.
    // The sheet validates it against its own TARGETS list, so a junk value just
    // falls back to Otomatis rather than becoming a bogus cap.
    const target = Number(document.body.dataset.target) || null;
    downloadSheet.open({ size: 'kompres', target });
  }
  else if (intent === 'gambar') downloadSheet.open({ format: 'img' });
  // openPagesSheet(), not pageManager.open(): the sheet opening is what
  // tool_use/pages_open counts, and an intent that opens it for the user (the
  // /pisah-pdf and Halaman cards) was the one route to it the rail could not see.
  // The population of that action now includes auto-opens; doc_open.intent in the
  // same session is what separates them from a deliberate press.
  else if (intent === 'split' || intent === 'halaman') openPagesSheet();
  else if (intent === 'gabung') toast(tr('toast.addMoreFiles'));
}

const fileInput = document.getElementById('file-input');
const DEFAULT_ACCEPT = fileInput.getAttribute('accept');
on('btn-open', 'click', () => fileInput.click());

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

// The Template row leaves for template.pdflokal.id, so nothing downstream of
// this page can ever attribute the visit back. Without this event the row is
// unmeasurable, and an unmeasurable funnel cannot be judged — which is the only
// reason it was added.
//
// ⚠️ THE KEY IS `doc`, NOT `source`. GA4 treats source/medium/campaign/term/
// content/gclid as TRAFFIC-SOURCE fields, and track() forwards `data` straight
// to gtag(). Passing `source: 'card'` here would rewrite the session's real
// attribution and show up as our own UI vocabulary in the acquisition report —
// which is exactly the defect that ate 20.3% of this site's sessions every day
// in August (decisions.md 2026-09-02).
for (const card of document.querySelectorAll('.tl-doc[data-doc]')) {
  card.addEventListener('click', () => {
    track('template_card', { doc: card.dataset.doc });
  });
}

const lihatBtn = document.getElementById('ld-lihat');
const moreGrid = document.getElementById('ld-more');
on(lihatBtn, 'click', () => {
  const open = moreGrid.hidden;
  moreGrid.hidden = !open;
  lihatBtn.setAttribute('aria-expanded', String(open));
  lihatBtn.firstChild.textContent = open ? tr('landing.hideTools') : tr('landing.showTools');
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
on(fileBtn, 'click', (e) => { e.stopPropagation(); toggleFileMenu(fileMenu.hidden); });
document.addEventListener('pointerdown', (e) => {
  if (!fileMenu.hidden && !e.target.closest('.file-menu-wrap')) toggleFileMenu(false);
});
// WHY every in-editor add goes through here with an explicit mode: a Buka Baru
// whose picker was CANCELLED used to stay armed (only `change` cleared it; a
// cancelled picker fires `cancel` at best, nothing at all on older Safari), so
// the next Tambah file wiped the document instead of merging into it. Setting
// the mode at every open is the fix that needs no event. (Not a `cancel`
// listener: headless Chromium auto-dismisses the picker the moment it opens,
// which would disarm every Buka Baru a spec drives with setInputFiles.)
function pickFiles(replace = false) {
  pendingReplace = replace; // applied when the picker actually returns files
  fileInput.click();
}
on('fm-add', 'click', () => {
  toggleFileMenu(false);
  pickFiles(); // appends → merge, the default loadFiles path
});
on('fm-new', 'click', () => {
  toggleFileMenu(false);
  pickFiles(true);
});
on('fm-pages', 'click', () => {
  toggleFileMenu(false);
  openPagesSheet(); // the SAME opener the toolbar button uses — never a second one
});

// Start over: a FRESH doc + history. The signature stays (it's the user's,
// not the document's). Cancelling the picker leaves everything untouched.
async function resetDoc() {
  doc = createDoc();
  history.undoStack.length = 0;
  history.redoStack.length = 0;
  markClean(history); // a fresh doc has nothing to lose; takes the leave guard down
  // Page ids are module-global monotonic (core/model.js's _seq) — the old
  // doc's thumbnail cache entries can never be hit again OR evicted, so
  // without this they are pure retained garbage, megabytes per Buka Baru on
  // a large document (maintenance audit 2026-08-09, finding 3).
  pageManager.invalidateThumbs();
  if (rasterizer) { await rasterizer.destroy(); rasterizer = null; }
  await textRuns.destroy(); // fresh doc = fresh sources; cached pdf.js docs die with the old one
  ocrIndex.invalidateAll(); // recognised boxes belong to the OLD document's pixels
  // Rung C live-font-preview: the doc-font caches are keyed by sourceId — a
  // fresh doc means fresh (or reused-but-unrelated) source ids, and every
  // FontFace we registered on document.fonts belongs to the OLD document. Not
  // clearing them would leak faces forever across repeated Buka Baru, and
  // document.fonts.check() for a stale name would still (wrongly) report true.
  editBake.reset();
  rebuildVerdicts.clear();
  docFontLive.reset();
  slots = [];
  stage.innerHTML = '';
  baseName = 'dokumen';
  setTool('select');
}
on(fileInput, 'change', async (e) => {
  const files = e.target.files;
  if (files?.length) {
    if (pendingReplace) await resetDoc();
    await loadFiles(files).catch((err) => { console.error(err); toast(tr('toast.openFailed')); });
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
  // The whole document is now a file: nothing left to lose on leave.
  onWholeDocExported: () => markClean(history),
  toast,
  // For export_intent's `device` prop. Injected rather than imported because
  // deviceClass() is app.js-local (it reads the live viewport), and the sheet
  // must not grow a second, drifting definition of what a phone is.
  deviceClass,
});
function doDownload() {
  if (doc.pages.length === 0) return;
  downloadSheet.open();
}
on('btn-download', 'click', doDownload);
// Ctrl/Cmd+S = the Unduh button. CAPTURE phase on purpose: the inline text editor
// stops propagation of every keydown it sees (so typing never fires tool verbs),
// and the main handler above stands down inside any field, so a bubbling listener
// never saw Ctrl+S where people reach for it most, mid-typing, and the browser's
// own Save Page opened over the editor. preventDefault runs even with no document
// open or a sheet already up: "save this page" is never what the key means here.
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 's') return;
  e.preventDefault();
  if (document.querySelector('dialog[open]')) return;
  doDownload();
}, true);

// ---- wordmark → home (punch list #3) --------------------------------------------
// On the landing the wordmark is already home; with a doc open it asks first —
// a reload throws away un-downloaded edits.
on('btn-home', 'click', () => {
  if (document.body.classList.contains('is-empty')) return;
  document.getElementById('home-confirm').showModal();
});
on('hc-cancel', 'click', () => {
  document.getElementById('home-confirm').close();
});
on('hc-go', 'click', () => {
  // The user was just asked (this dialog); the browser's own prompt would be a second ask.
  setLeaveGuard(false);
  // The wordmark's own href is this page's home ('/' or '/en'), so /en does not
  // send an English reader to the Indonesian page.
  window.location.assign(document.querySelector('a.ld-mark')?.getAttribute('href') || '/');
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
  // tests: rung S2's recognised-line geometry, the scan-side twin of textRuns.
  // Exposed for the same reason — a spec must address a line by its WORDS, not
  // by a pixel guess, or the test only proves where we assumed the ink was.
  ocrIndex,
  runOcrOnPage, // tests: drive recognition without going through the sheet
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
// (An older note here said the copy must not imply OCR is coming. That call was
// made: rung S2 ships and #so-ocr is the OCR entry point — see index.html.)
//
// `accepted` fires when the tool is actually ARMED, never on the button click.
// A click measures the button; we need the behaviour. And it fires ONLY from
// this offer — someone arming Tip-Ex on a scan without hitting the wall is
// normal use (whiting out a signature line, filling a scanned form) and counting
// it would import a population that never wanted OCR. The organic case is a rail
// QUERY over the sequence, which per-event timestamps now make answerable.
function showScanOffer(pageId) {
  const dlg = document.getElementById('scan-offer');
  if (!dlg) { toast(tr('toast.scanNotEditable')); return; }
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

  // First arg is the DOM tool id (data-tool), second the rail's word (ARM_TOOL).
  // They differ on purpose; arming 'tipex'/'teks' armed a tool that does not
  // exist and left the page unscrollable (touchAction none) on a phone.
  dlg.querySelector('#so-tipex').onclick = take('whiteout', 'tipex');
  dlg.querySelector('#so-teks').onclick = take('text', 'teks');
  // RUNG S2. Settles as `accepted` on the CLICK rather than on an armed tool,
  // unlike the two above, and the difference is honest rather than sloppy:
  // recognition takes seconds and can fail, so there is no synchronous "the
  // tool armed" fact to read here. What this measures is that the user chose
  // OCR; whether it then WORKED is `ocr_run` / `failure{stage:'ocr'}`, which
  // is the pair a rail query joins. Folding the outcome into this event would
  // reintroduce exactly the one-value-two-meanings problem the header warns
  // about.
  const ocrBtn = dlg.querySelector('#so-ocr');
  if (ocrBtn) {
    ocrBtn.onclick = () => {
      settle({ action: 'accepted', tool: 'ocr' });
      dlg.close();
      runOcrOnPage(pageId);
    };
  }
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
    tel('failure_cause', { stage: 'runtime', ...failureCause(err) });
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
//
// ⚠️ KEEP THIS THE LAST STATEMENT IN THE FILE. The 'pdflokal:booted' message is
// sw.js's ONLY proof that this page's module set linked and ran: it is what makes
// the set of files this load fetched a COMPLETE generation, the only kind sw.js
// will ever serve offline (sw.js, GENERATIONS). Reaching this line means every
// static import resolved and the whole top level above evaluated. Moved earlier,
// it would vouch for a set that can still die below it.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // No block comment in this catch: several tests strip block comments with a
    // lazy regex, and the accept string for images earlier in this file opens
    // one as far as that regex can tell, so a closer here swallows the file.
    const firstVisit = !navigator.serviceWorker.controller;
    try {
      navigator.serviceWorker.controller?.postMessage({ type: 'pdflokal:booted' });
    } catch {
      // enhancement only
    }
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    // FIRST VISIT: no worker saw this load, so it has no offline generation and an
    // install made now would launch offline into a dead shell. Once the worker
    // takes control, hand it the module URLs this page actually ran so it can
    // adopt them as a generation (sw.js ADOPTION; it keeps nothing if a deploy
    // landed meanwhile). Same reach as 'booted': only a page that got here.
    if (firstVisit) {
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        try {
          const urls = performance.getEntriesByType('resource').map((e) => e.name);
          navigator.serviceWorker.controller?.postMessage({ type: 'pdflokal:adopt', urls });
        } catch {
          // enhancement only
        }
      }, { once: true });
    }
  });
}
