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
export function renderPageView(page, { activeId = null } = {}) {
  const view = document.createElement('div');
  view.className = 'pv-page';
  view.dataset.pageId = page.id;
  view.style.cssText =
    `position:relative;flex:0 0 auto;width:${page.width}px;height:${page.height}px;` +
    'background:#fff;box-shadow:0 2px 14px rgba(0,0,0,.14);border-radius:2px';

  if (page.raster) {
    const img = document.createElement('img');
    img.className = 'pv-bg';
    img.src = page.raster.dataUrl;
    img.draggable = false;
    img.alt = '';
    img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;user-select:none;pointer-events:none';
    view.appendChild(img);
  }

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

// One annotation as a positioned DOM element (page-space px).
export function renderAnnotationEl(anno) {
  const el = document.createElement('div');
  el.className = 'pv-anno pv-anno-' + anno.type;
  el.dataset.annoId = anno.id;
  el.style.cssText = `position:absolute;left:${anno.x || 0}px;top:${anno.y || 0}px`;

  if (anno.type === 'text') {
    el.textContent = anno.text || '';
    el.style.font =
      `${anno.italic ? 'italic ' : ''}${anno.bold ? '700 ' : '400 '}` +
      `${anno.fontSize || 24}px ${anno.fontFamily || 'Helvetica, Arial, sans-serif'}`;
    el.style.color = anno.color || '#000';
    el.style.whiteSpace = 'pre';
    el.style.lineHeight = '1.2';
  } else if (anno.type === 'whiteout') {
    el.style.width = (anno.width || 0) + 'px';
    el.style.height = (anno.height || 0) + 'px';
    el.style.background = '#fff';
  } else if (anno.type === 'signature' && anno.image) {
    const im = document.createElement('img');
    im.src = anno.image;
    im.style.cssText = `display:block;width:${anno.width || 150}px;height:auto`;
    el.appendChild(im);
  }
  return el;
}
