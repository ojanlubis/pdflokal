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
 */

// Render a full page view (background + annotation overlay).
// opts.activeId = id of the currently-active annotation → rendered on top.
// opts.label   = placeholder caption (e.g. "Hal 42").
export function renderPageView(page, opts = {}) {
  const { activeId = null } = opts;
  const view = document.createElement('div');
  view.className = 'pv-page';
  view.dataset.pageId = page.id;
  // Displayed size swaps for 90/270 — the raster is rendered pre-rotated, so
  // the view (and every annotation coordinate) lives in the ROTATED frame.
  const rotated = (page.rotation || 0) % 180 !== 0;
  const w = rotated ? page.height : page.width;
  const h = rotated ? page.width : page.height;
  view.style.cssText =
    `position:relative;flex:0 0 auto;width:${w}px;height:${h}px;` +
    'background:#fff;box-shadow:0 2px 14px rgba(0,0,0,.14);border-radius:2px';

  // Intentional placeholder text (e.g. "Hal 42") so a flung-past page reads as
  // "loading", not "broken". Stored on the view so clearPageRaster can reuse it.
  if (opts.label) view.dataset.phLabel = opts.label;

  if (page.raster) attachRaster(view, page.raster);
  else attachPlaceholder(view);

  const overlay = document.createElement('div');
  overlay.className = 'pv-overlay';
  overlay.style.cssText = 'position:absolute;inset:0';
  for (const anno of page.annotations) {
    const el = renderAnnotationEl(anno);
    el.style.zIndex = anno.id === activeId ? '1000' : '1'; // active always on top
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
  ph.textContent = view.dataset.phLabel || 'memuat…';
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

// Called when a page leaves the window — drop the image to free memory, restore
// the placeholder. Scrolling back re-rasterizes it (a brief, bounded load).
export function clearPageRaster(view) {
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
};

// SSOT for a text annotation's CSS font string (page-view + inline editor).
export function textFontCss(anno) {
  const family = FONT_CSS[anno.fontFamily] || FONT_CSS['Helvetica'];
  return `${anno.italic ? 'italic ' : ''}${anno.bold ? '700 ' : '400 '}${anno.fontSize || 24}px ${family}`;
}

// One annotation as a positioned DOM element (page-space px).
export function renderAnnotationEl(anno) {
  const el = document.createElement('div');
  el.className = 'pv-anno pv-anno-' + anno.type;
  el.dataset.annoId = anno.id;
  el.style.cssText = `position:absolute;left:${anno.x || 0}px;top:${anno.y || 0}px`;
  // WHY: on touch, preventDefault in pointerdown does NOT stop the browser
  // hijacking the gesture for scroll — only touch-action does. Without this,
  // dragging an annotation on a phone scrolls the page instead (old bug class).
  if (anno.type === 'text' || anno.type === 'whiteout' || anno.type === 'signature') {
    el.style.touchAction = 'none';
  }

  if (anno.type === 'text') {
    el.textContent = anno.text || '';
    el.style.font = textFontCss(anno);
    el.style.color = anno.color || '#000';
    el.style.whiteSpace = 'pre';
    el.style.lineHeight = '1.2';
    // Finger-sized hit area without moving the visual position: small text at
    // page zoom ~0.6 is a <20px target — padding grows the hit box, the
    // negative margin cancels the layout shift. (≥44px rule, product def §6.5.)
    el.style.padding = '10px';
    el.style.margin = '-10px';
  } else if (anno.type === 'whiteout') {
    el.style.width = (anno.width || 0) + 'px';
    el.style.height = (anno.height || 0) + 'px';
    el.style.background = '#fff';
  } else if (anno.type === 'signature' && anno.image) {
    const im = document.createElement('img');
    im.src = anno.image;
    im.draggable = false;
    im.style.cssText = `display:block;width:${anno.width || 150}px;height:auto;pointer-events:none;user-select:none`;
    el.appendChild(im);
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
  for (const anno of page.annotations) {
    const el = renderAnnotationEl(anno);
    const active = anno.id === activeId;
    el.style.zIndex = active ? '1000' : '1';
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
  el.style.outline = '1.5px solid #4f8ef7';
  el.style.outlineOffset = '2px';
  const resizable = anno.type === 'whiteout' || anno.type === 'signature';
  if (!resizable) return;
  const h = document.createElement('div');
  h.className = 'pv-handle';
  h.dataset.handle = 'se';
  h.style.cssText =
    'position:absolute;right:-11px;bottom:-11px;width:22px;height:22px;' +
    'display:flex;align-items:center;justify-content:center;cursor:nwse-resize;touch-action:none';
  const dot = document.createElement('div');
  dot.style.cssText =
    'width:12px;height:12px;border-radius:50%;background:#4f8ef7;border:2px solid #fff;' +
    'box-shadow:0 1px 4px rgba(0,0,0,.35)';
  h.appendChild(dot);
  el.appendChild(h);
}

export function undecorateSelected(el) {
  el.classList.remove('pv-selected');
  el.style.outline = '';
  el.style.outlineOffset = '';
  el.style.zIndex = '1';
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
    release() {
      page.raster = null;
      clearPageRaster(view);
    },
  };
  return slot;
}
