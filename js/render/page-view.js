/*
 * PDFLokal — render/page-view.js  (RENDER LAYER — Phase 1)
 * ============================================================================
 * Renders one core Page as an IMAGE-BACKED view:
 *   - background = the rasterized page as an <img>  → survives the mobile GPU
 *     backing-store purge that blanks live <canvas>es. Zoom = CSS transform on
 *     the parent (atomic, GPU-accelerated, no re-render, no flicker).
 *   - annotations = ONE overlay layer above the <img>. Stacking is decided ONLY
 *     by z-index WITHIN this overlay, so an annotation can never hide behind
 *     another page's canvas (the old bug). The active object is always top-most.
 *
 * Coordinates are page-space px (== PDF points, top-left origin). The whole page
 * view is sized to the page's point dimensions; zoom is a transform:scale() the
 * caller applies to a wrapper — so annotation↔page registration is exact at any
 * zoom without recomputing anything.
 *
 * Reads the core model only. No ueState, no vendor libs. DOM out.
 *
 * `page.editApplied` (spec-live-surgery.md §5/§8.3, increment 3): an optional
 * Set<annotationId>, the SAME render-layer-cache pattern as `page.raster` —
 * not a core model field, just a value app.js stashes directly on the page
 * object. When present, it names exactly which cover/text ids a SUCCESSFUL
 * Ganti bake consumed (js/core/page-surgery.js's buildEditedPageBytes
 * `applied` set, read back verbatim) — those ids are baked into the raster
 * and must NOT also draw as a DOM overlay (Decision 1). Anything else
 * (declined edits, ordinary annotations) renders exactly as before
 * (Decision 2).
 */
import { orderedForPaint, annotationZIndex } from '../core/annotation-order.js';
import { turnOf } from '../core/annotation-geometry.js';
import { t as tr } from '../lib/i18n.js';

// SINGLE SOURCE OF TRUTH for a page's displayed size, in page-space px. It
// swaps for 90/270 — the raster is rendered pre-rotated, so the view (and every
// annotation coordinate) lives in the ROTATED frame. The per-page strip
// (v2/page-strip.js) sizes itself from this so it is exactly as wide as the page.
export function pageDisplaySize(page) {
  const rotated = (page.rotation || 0) % 180 !== 0;
  return {
    width: rotated ? page.height : page.width,
    height: rotated ? page.width : page.height,
  };
}

// Render a full page view (background + annotation overlay).
// opts.activeId = id of the currently-active annotation → rendered on top.
// opts.label   = placeholder caption (e.g. "Hal 42").
export function renderPageView(page, opts = {}) {
  const { activeId = null } = opts;
  const view = document.createElement('div');
  view.className = 'pv-page';
  view.dataset.pageId = page.id;
  const { width: w, height: h } = pageDisplaySize(page);
  view.style.cssText =
    `position:relative;flex:0 0 auto;width:${w}px;height:${h}px;` +
    'background:#fff;box-shadow:0 2px 12px rgba(63,49,35,.16);border-radius:2px';

  // Intentional placeholder text (e.g. "Hal 42") so a flung-past page reads as
  // "loading", not "broken". Stored on the view so clearPageRaster can reuse it.
  if (opts.label) view.dataset.phLabel = opts.label;

  if (page.raster) attachRaster(view, page.raster);
  else attachPlaceholder(view);

  const overlay = document.createElement('div');
  overlay.className = 'pv-overlay';
  overlay.style.cssText = 'position:absolute;inset:0';
  // PAINT ORDER (core/annotation-order.js, founder ruling 2026-08-09): Tip-Ex
  // is a GROUND, not a layer. orderedForPaint returns a COPY — page.annotations
  // itself must stay in creation order, because page-surgery.js pairs Ganti
  // covers to their replacement text by walking that same array.
  for (const anno of orderedForPaint(page.annotations)) {
    // spec-live-surgery.md §5/§8.3 (increment 3, Decision 1/2): a SUCCESSFUL
    // committed Ganti edit's cover+text are baked into the raster — drawing
    // them ALSO as a DOM overlay would double-paint. A DECLINED edit's cover
    // (and its twin text, when native-insert alone declined) still renders —
    // see the editApplied skip below.
    if (page.editApplied?.has(anno.id)) continue;
    const el = renderAnnotationEl(anno);
    // Top of its OWN band, never top of everything — a held Tip-Ex used to get
    // z-index 1000 and so appeared above the text it belongs under, then
    // dropped behind on deselect. The screen lied while you were editing.
    el.style.zIndex = String(annotationZIndex(anno, { selected: anno.id === activeId }));
    overlay.appendChild(el);
  }
  view.appendChild(overlay);
  return view;
}

// ---- streaming helpers (Phase 2: swap in / release the page image) ---------

// A calm "loading" placeholder — shown for pages not yet rasterized. NOT blank,
// so fast-scroll reads as loading, not flicker.
function attachPlaceholder(view) {
  if (view.querySelector('.pv-ph') || view.querySelector('.pv-bg')) return;
  const ph = document.createElement('div');
  ph.className = 'pv-ph';
  ph.style.cssText =
    'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
    'color:#c4c4c4;font-size:13px;background:#fff';
  ph.textContent = view.dataset.phLabel || tr('render.loading');
  view.insertBefore(ph, view.firstChild);
}

function attachRaster(view, raster) {
  const img = document.createElement('img');
  img.className = 'pv-bg';
  img.src = raster.dataUrl;
  img.draggable = false;
  img.alt = '';
  img.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;user-select:none;pointer-events:none;' +
    'opacity:0;transition:opacity .12s ease';
  view.insertBefore(img, view.firstChild);
  requestAnimationFrame(() => { img.style.opacity = '1'; });
  return img;
}

// Called when a page enters the window and has been rasterized.
export function setPageRaster(view, raster) {
  if (view.querySelector('.pv-bg')) return;
  view.querySelector('.pv-ph')?.remove();
  attachRaster(view, raster);
}

// Swap in a NEW raster for a page that is ALREADY showing one — a commit or
// undo/redo re-bake (spec-live-surgery.md §5/§7/§8.3, increment 3's "no
// visible seam" law), never the first-render/streaming-entry case (that
// stays setPageRaster above, which deliberately no-ops when a `.pv-bg`
// already exists). The new <img> is decoded OFF-DOM first — by the time it
// touches the DOM it is already paintable — then insertion of the new node
// and removal of the old one happen in the SAME synchronous tick (no
// `await` between them), so the browser can only ever paint the FINAL state;
// there is no frame where neither image (or a blank view) is on screen.
//
// WHY a per-view sequence (found 2026-10-10): what to remove used to be read
// BEFORE the decode await. Two overlapping swaps (a sharpen and a re-bake on the
// same page) both captured the same old image and both inserted theirs, so the
// one that finished FIRST could end up painted on top (stale picture, leaked
// <img>); a release during the decode left the new image under a placeholder
// that nothing removed. Last ISSUED wins, as in core/import.js's renderSeq:
// a swap that is no longer the newest for this view, or whose view was released
// meanwhile, stands down, and the winner clears every old layer it finds.
const viewSeq = new WeakMap();
const bumpView = (view) => { const n = (viewSeq.get(view) || 0) + 1; viewSeq.set(view, n); return n; };

export async function swapPageRaster(view, raster) {
  const seq = bumpView(view);
  const img = document.createElement('img');
  img.className = 'pv-bg';
  img.src = raster.dataUrl;
  img.draggable = false;
  img.alt = '';
  img.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;user-select:none;pointer-events:none';
  try {
    await img.decode();
  } catch {
    // decode() can reject (or be unsupported) — proceed anyway; the swap
    // below is still correct, it just didn't get the pre-decode guarantee.
  }
  if (viewSeq.get(view) !== seq) return; // a newer swap, or a release, owns this view now
  const stale = view.querySelectorAll('.pv-bg, .pv-ph');
  view.insertBefore(img, view.firstChild);
  for (const el of stale) el.remove();
}

// Called when a page leaves the window — drop the image to free memory, restore
// the placeholder. Scrolling back re-rasterizes it (a brief, bounded load).
export function clearPageRaster(view) {
  bumpView(view); // a swap still decoding must not re-attach to a released page
  view.querySelector('.pv-bg')?.remove();
  attachPlaceholder(view);
}

// Render-side font map. Canonical names match core annotations AND the export
// adapter's PDF font resolution — same keys as the old CSS_FONT_MAP, duplicated
// here on purpose: the render layer must not import old-editor modules.
export const FONT_CSS = {
  'Helvetica': 'Helvetica, Arial, sans-serif',
  'Times-Roman': '"Times New Roman", Times, serif',
  'Courier': '"Courier New", Courier, monospace',
  'Montserrat': 'Montserrat, sans-serif',
  'Carlito': 'Carlito, Calibri, sans-serif',
  // Metric clones (font-fidelity tier 1, core/font-decide.js) — the system
  // original rides second in each stack: identical widths, so layout is
  // stable even before the lazy woff2 arrives.
  'Arimo': 'Arimo, Arial, Helvetica, sans-serif',
  'Tinos': 'Tinos, "Times New Roman", Times, serif',
  'Cousine': 'Cousine, "Courier New", Courier, monospace',
  'Caladea': 'Caladea, Cambria, serif',
};

// The ONE face a decided line paints in (core/line-font.js), or null. A
// decision names the CSS family the editor registered from the very bytes the
// stamp embeds; 'none' is never stored, so any stored decision has one.
export function decidedFontFamily(anno) {
  const d = anno && anno.fontDecision;
  return d && d.path && d.path !== 'none' && d.css ? d.css : null;
}

// SSOT for a text annotation's CSS font string (page-view + inline editor).
export function textFontCss(anno) {
  // THE EDIT PRINCIPLE (seat decisions.md 2026-10-01): a decided line renders
  // in exactly ONE family — no stack, so the browser has no second font to
  // fall back to per glyph (the decision already proved this face paints
  // every char). Weight/style are the ones the face was REGISTERED with
  // (carried on the decision), so CSS matches the one face present; asking
  // for 700 against a regular face would make the browser fake-bold it — a
  // second font in disguise. applyTextFont below also turns kerning and
  // synthesis off, because pdf-lib's drawText applies neither (it sums raw
  // advances), so the screen must not either.
  const decided = decidedFontFamily(anno);
  if (decided) {
    const d = anno.fontDecision;
    return `${d.italic ? 'italic ' : ''}${d.bold ? '700 ' : '400 '}${anno.fontSize || 24}px "${decided}"`;
  }
  const family = FONT_CSS[anno.fontFamily] || FONT_CSS['Helvetica'];
  // Rung C live-font-preview (2026-07-19): a committed Ganti replacement whose
  // draft successfully loaded the document's OWN embedded font (js/v2/app.js's
  // prepareDocFont) carries docFontFamily — a FontFace already registered on
  // document.fonts under that name. Prepending it keeps the committed
  // annotation looking like the document between commit and export; the twin
  // stack stays right behind it as the per-glyph fallback (a char the doc font
  // doesn't cover silently falls through to the twin — the same honest
  // preview export's own coverage check performs).
  const stack = anno.docFontFamily ? `"${anno.docFontFamily}", ${family}` : family;
  return `${anno.italic ? 'italic ' : ''}${anno.bold ? '700 ' : '400 '}${anno.fontSize || 24}px ${stack}`;
}

// Put a text annotation's font on an element — the overlay's text and the
// inline editor both go through here. WHY not just `el.style.font = …`: the
// `font` shorthand resets font-kerning back to `auto` on every assignment, and
// a decided line must paint with kerning OFF (pdf-lib's drawText sums raw
// glyph advances — verified in the vendored CustomFontEmbedder, which never
// reads kerning) or the editor's word is wider/narrower than the file's.
export function applyTextFont(el, anno) {
  el.style.font = textFontCss(anno);
  // The `font` shorthand above resets line-height. A paragraph (Rung D,
  // core/block-edit.js) is laid out at its OWN leading — the editor and the
  // committed overlay both — so it is re-applied here, the one place every
  // font change passes through.
  const lead = blockLineHeight(anno);
  if (lead) el.style.lineHeight = `${lead}px`;
  if (decidedFontFamily(anno)) {
    el.style.fontKerning = 'none';
    el.style.fontSynthesis = 'none';
    el.dataset.fontDecided = '1';
  } else {
    el.style.fontSynthesis = '';
    delete el.dataset.fontDecided;
  }
}

// A paragraph's line height in display px (its own leading), or null. Reads a
// committed annotation's `block` or a paragraph draft's plan — same fields.
export function blockLineHeight(anno) {
  const b = anno && anno.block;
  return b && b.k > 0 && b.leading > 0 ? b.k * b.leading : null;
}

// Rung D: a committed paragraph, one absolutely placed row per PAINTED line
// (block.lines, the breaks the editor showed), each laid out by the same CSS
// the paragraph editor used — same face, size, line height, alignment — so the
// rows' baselines and justified edges are the editor's own. A row is
// justified exactly when core/reflow.js layoutLines would stretch it: not the
// last line, not before a typed break, and it has a space to stretch.
function renderBlockRows(el, anno) {
  const b = anno.block;
  const lead = b.k * b.leading;
  const last = b.lines.length - 1;
  b.lines.forEach((line, i) => {
    const row = document.createElement('div');
    const indent = i === 0 && b.align !== 'right' ? b.k * (b.indent || 0) : 0;
    applyTextFont(row, anno);
    const stretch = b.align === 'justify' && i !== last && !line.hard && line.text.includes(' ');
    const align = b.align === 'justify' ? 'left' : b.align;
    row.style.cssText += `;position:absolute;left:${indent}px;top:${i * lead}px;width:${b.k * b.width - indent}px;`
      + `height:${lead}px;white-space:pre;text-align:${stretch ? 'justify' : align};`
      + `text-align-last:${stretch ? 'justify' : align}`;
    row.textContent = line.text;
    el.appendChild(row);
  });
  el.style.width = `${b.k * b.width}px`;
  el.style.height = `${b.lines.length * lead}px`;
}

// SINGLE SOURCE OF TRUTH for how WIDE a text annotation paints, in page-space
// px — the same question renderAnnotationEl answers by letting the element
// auto-size under `white-space: pre`, asked without needing the element.
//
// WHY it has to exist: a committed Ganti replacement is BAKED into the page
// raster a beat after commit, and its overlay element is then removed. Anything
// that needs the painted extent after that — hit-testing a tap on an
// already-edited line, above all — has no DOM left to measure and must derive
// it. Measuring through textFontCss() is what keeps this honest: same font
// stack, same size, same weight the overlay paints with, including the
// docFontFamily FontFace when one loaded. A second, independently-written
// measurement would drift from what the user actually sees, which is the whole
// thing the caller is trying to hit.
//
// Page-space, not viewport: fontSize and x/y are page-space px (that is how
// renderAnnotationEl positions), so measureText returns page-space px too.
let measureCtx = null;
export function measureTextAnnoWidth(anno) {
  if (!anno || anno.type !== 'text' || !anno.text) return 0;
  measureCtx = measureCtx || document.createElement('canvas').getContext('2d');
  measureCtx.font = textFontCss(anno);
  // Same no-kerning rule as applyTextFont, or this measures a width the
  // overlay does not paint.
  if ('fontKerning' in measureCtx) measureCtx.fontKerning = decidedFontFamily(anno) ? 'none' : 'auto';
  return measureCtx.measureText(anno.text).width;
}

// A TURNED OBJECT on screen (founder ruling 2026-10-11, "semua harus ngikut
// rotasi"): text and signatures carry `turn`, the quarter turns their page
// made under them, and x/y is their ORIGIN (core/annotation-geometry.js
// turnAnnotation). Drawn as a CSS rotate about that origin, which is the same
// clockwise matrix the model and the file use (turnVector; export.js
// objectPoint), so screen and download agree. `origin` is where x/y sits
// inside the element: '10px 10px' for a plain text overlay (its padding ring),
// '0 0' for everything else. The browser hit-tests the rotated box, so
// selection, drag and delete need nothing more. data-turn is for the specs.
// Exported: the inline editor (js/v2/app.js openTextEditor) opens turned too.
export function applyTurn(el, anno, origin = '0 0') {
  const turn = turnOf(anno);
  if (!turn) {
    el.style.transform = '';
    el.style.transformOrigin = '';
    delete el.dataset.turn;
    return;
  }
  el.style.transformOrigin = origin;
  el.style.transform = `rotate(${turn}deg)`;
  el.dataset.turn = String(turn);
}

// One annotation as a positioned DOM element (page-space px).
export function renderAnnotationEl(anno) {
  const el = document.createElement('div');
  el.className = 'pv-anno pv-anno-' + anno.type;
  el.dataset.annoId = anno.id;
  el.style.cssText = `position:absolute;left:${anno.x || 0}px;top:${anno.y || 0}px`;
  // NOTE: no touch-action here on purpose. An UNSELECTED annotation must let
  // the browser take the gesture as camera (scroll) — selection commits at
  // release (interaction.js tap-candidate). decorateSelected() sets
  // touch-action:none so the SELECTED object drags instead of scrolling.

  if (anno.type === 'text' && anno.block && Array.isArray(anno.block.lines)) {
    el.style.color = anno.color || '#000';
    renderBlockRows(el, anno);
    applyTurn(el, anno);
  } else if (anno.type === 'text') {
    el.textContent = anno.text || '';
    applyTextFont(el, anno);
    el.style.color = anno.color || '#000';
    el.style.whiteSpace = 'pre';
    el.style.lineHeight = '1.2';
    // Finger-sized hit area without moving the visual position: small text at
    // page zoom ~0.6 is a <20px target — padding grows the hit box, the
    // negative margin cancels the layout shift. (≥44px rule, product def §6.5.)
    el.style.padding = '10px';
    el.style.margin = '-10px';
    applyTurn(el, anno, '10px 10px');
  } else if (anno.type === 'whiteout') {
    el.style.width = (anno.width || 0) + 'px';
    el.style.height = (anno.height || 0) + 'px';
    el.style.background = anno.color || '#fff';
    if (anno.ocrBox && anno.paperImage) {
      el.style.backgroundImage = `url("${anno.paperImage}")`;
      el.style.backgroundSize = '100% 100%';
    }
  } else if (anno.type === 'signature' && anno.image) {
    const im = document.createElement('img');
    im.src = anno.image;
    im.draggable = false;
    im.style.cssText = `display:block;width:${anno.width || 150}px;height:auto;pointer-events:none;user-select:none`;
    el.appendChild(im);
    applyTurn(el, anno);
  } else if (anno.type === 'watermark') {
    el.textContent = anno.text || '';
    el.style.font = `700 ${anno.fontSize || 48}px Helvetica, Arial, sans-serif`;
    el.style.color = anno.color || '#888';
    el.style.opacity = String(anno.opacity ?? 0.3);
    el.style.transform = `rotate(${anno.rotation ?? -45}deg)`;
    el.style.transformOrigin = 'center';
    el.style.whiteSpace = 'nowrap';
    el.style.pointerEvents = 'none'; // watermarks are page-level, not draggable
  } else if (anno.type === 'pageNumber') {
    el.textContent = anno.text || '';
    el.style.font = `${anno.fontSize || 12}px Helvetica, Arial, sans-serif`;
    el.style.color = anno.color || '#000';
    el.style.pointerEvents = 'none';
  }
  return el;
}

// ---- surgical sync (model → DOM without touching the page image) -----------

// Rebuild ONLY the overlay from the model. Cheap (a handful of annos per page)
// and never disturbs the raster <img> — so a selection change or an added
// annotation can never cause a page flash. The drag hot path bypasses even
// this (interaction.js updates left/top style directly).
export function syncOverlay(page, view, opts = {}) {
  const { activeId = null } = opts;
  const overlay = view.querySelector('.pv-overlay');
  if (!overlay) return;
  overlay.innerHTML = '';
  // Same paint order as renderPageView and as core/export.js — one contract
  // (core/annotation-order.js), and a COPY, never a reorder of the model.
  for (const anno of orderedForPaint(page.annotations)) {
    // See renderPageView's identical skip — same suppression signal, kept in
    // lockstep so a resync (undo/redo, format bar, drag) never re-draws a
    // baked edit's overlay back into existence.
    if (page.editApplied?.has(anno.id)) continue;
    const el = renderAnnotationEl(anno);
    const active = anno.id === activeId;
    el.style.zIndex = String(annotationZIndex(anno, { selected: active }));
    if (active) decorateSelected(el, anno);
    overlay.appendChild(el);
  }
}

// Selection chrome: outline + resize handle, ALL inside the annotation element
// so it inherits the element's stacking (top-most with it — invariant §6.2).
// 22px handle hit-area (44px effective with padding at typical zoom) for touch.
// Exported: interaction.js decorates IN PLACE during gestures — rebuilding the
// overlay mid-gesture would destroy the element holding the pointer capture.
export function decorateSelected(el, anno) {
  el.classList.add('pv-selected');
  el.style.outline = '1.5px solid #dc2626';
  el.style.outlineOffset = '2px';
  // Selected = grabbable: the browser must NOT take a drag on it as scroll.
  // (touch-action must be set BEFORE the gesture starts — this is that moment.)
  el.style.touchAction = 'none';
  // Text is resizable too: dragging its handle scales fontSize (founder ask).
  const resizable = anno.type === 'whiteout' || anno.type === 'signature' || anno.type === 'text';
  if (!resizable) return;
  const h = document.createElement('div');
  h.className = 'pv-handle';
  h.dataset.handle = 'se';
  h.style.cssText =
    'position:absolute;right:-11px;bottom:-11px;width:22px;height:22px;' +
    'display:flex;align-items:center;justify-content:center;cursor:nwse-resize;touch-action:none';
  const dot = document.createElement('div');
  dot.style.cssText =
    'width:12px;height:12px;border-radius:50%;background:#dc2626;border:2px solid #fff;' +
    'box-shadow:0 1px 4px rgba(0,0,0,.35)';
  h.appendChild(dot);
  el.appendChild(h);
}

// ⚠️ THE TYPE COMES OFF THE ELEMENT because that is all the caller has —
// interaction.js holds a DOM node, not the model object, when it drops a
// selection. renderAnnotationEl writes `pv-anno-<type>`, so the class IS the
// record of what this element is. Getting it wrong would put a deselected
// Tip-Ex back into the text band, which is the very defect this change
// removes; annotationRank falls back to the default for anything unreadable,
// so the worst case is a whiteout drawn one band too high rather than a throw.
export function undecorateSelected(el) {
  const type = /pv-anno-([a-zA-Z]+)/.exec(el.className)?.[1];
  el.classList.remove('pv-selected');
  el.style.outline = '';
  el.style.outlineOffset = '';
  el.style.zIndex = String(annotationZIndex({ type }, { selected: false }));
  el.style.touchAction = ''; // back to camera-first (see decorateSelected)
  el.querySelector('.pv-handle')?.remove();
}

// ---- slot factory (page + view + streaming hooks travel together) -----------

// A slot pairs a core Page with its DOM view and owns the raster attach/release
// pair, so the viewport-stream engine (viewport.js) never reaches into either.
export function createPageSlot(page, opts = {}) {
  const view = renderPageView(page, opts);
  const slot = {
    page,
    view,
    loading: false,
    attach(raster) {
      page.raster = raster;
      setPageRaster(view, raster);
    },
    // Increment 3 (spec-live-surgery.md §5/§7/§8.3): the re-bake swap for a
    // page that's ALREADY rastered (a Ganti commit, or an undo/redo whose
    // edit-signature changed) — never the first-render path, that's still
    // attach() above. No blank frame (swapPageRaster holds the old raster
    // until the new one is decoded).
    async reattach(raster) {
      page.raster = raster;
      await swapPageRaster(view, raster);
    },
    release() {
      page.raster = null;
      clearPageRaster(view);
    },
  };
  return slot;
}
