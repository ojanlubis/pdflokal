/*
 * PDFLokal — render/interaction.js  (RENDER LAYER — the ONE input path)
 * ============================================================================
 * Pointer events only (mouse + touch + pen unified) — invariant #4: mobile and
 * desktop share the same input path, different ergonomics. Delegated on the
 * stage container; nothing here is hover-only.
 *
 * Hit-testing is DOM-based (closest('.pv-anno') / closest('.pv-page')) because
 * annotations ARE elements in the new render layer. The old editor needed
 * ~200 lines of canvas pixel math for this; that entire class of code is gone.
 *
 * Mutations go through core/operations (invariant #5). Undo is recorded ONCE
 * per gesture, lazily on the first real movement — a plain tap never pollutes
 * the undo stack.
 *
 * Gesture-continuity rule: while a pointer is captured we NEVER rebuild the
 * overlay (that would destroy the captured element). Selection is decorated
 * in place; structural re-syncs happen on gesture end via onChange.
 */

import { selectAnnotation, clearSelection, moveAnnotation, resizeAnnotation } from '../core/operations.js';
import { record } from '../core/history.js';
import { decorateSelected, undecorateSelected } from './page-view.js';

const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_DIST = 30;

// ctx = {
//   stage:      container holding .pv-page views
//   getDoc:     () => Doc
//   getZoom:    () => number (CSS scale on the stage)
//   getTool:    () => 'select' | 'text' | 'whiteout' | 'signature' | 'paraf'
//   history:    core history (or null to disable undo recording)
//   onChange:   (kind, payload) => void   — 'select' | 'move' | 'resize' | 'draw'
//   onPlace:    (tool, {pageId, x, y}) => void — tap-to-place for text/signature
//   onEditText: (annotationId) => void — double-tap on a text annotation
// }
export function createInteraction(ctx) {
  const { stage } = ctx;
  let gesture = null;        // the active pointer gesture (one at a time)
  let selectedEl = null;     // decorated element (kept in sync with doc.selection)
  let lastTap = { t: 0, x: 0, y: 0, annoId: null };

  // ---- coordinate mapping (screen → page-space points) ----------------------
  function toPage(e, pageView) {
    const r = pageView.getBoundingClientRect();
    const zoom = ctx.getZoom();
    return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom };
  }

  // ---- selection (surgical decorate/undecorate; no overlay rebuild) ---------
  function setSelected(annoEl, anno) {
    if (selectedEl && selectedEl !== annoEl) undecorateSelected(selectedEl);
    selectedEl = annoEl || null;
    const doc = ctx.getDoc();
    if (anno) {
      selectAnnotation(doc, anno.id);
      if (annoEl) {
        annoEl.style.zIndex = '1000'; // active object is ALWAYS top-most (§6.2)
        if (!annoEl.classList.contains('pv-selected')) decorateSelected(annoEl, anno);
      }
    } else {
      clearSelection(doc);
    }
    ctx.onChange?.('select', { annotation: anno || null });
  }

  // Re-apply selection chrome after an external overlay rebuild (undo, add…).
  function refreshSelection() {
    selectedEl = null;
    const doc = ctx.getDoc();
    const id = doc.selection.annotationId;
    if (!id) return;
    const el = stage.querySelector(`[data-anno-id="${id}"]`);
    if (el) selectedEl = el;
  }

  function findAnno(doc, annoId) {
    for (const page of doc.pages) {
      const a = page.annotations.find((x) => x.id === annoId);
      if (a) return { page, anno: a };
    }
    return null;
  }

  // ---- gestures --------------------------------------------------------------

  function startDrag(e, annoEl, page, anno) {
    const zoom = ctx.getZoom();
    gesture = {
      kind: 'move', pointerId: e.pointerId, annoEl, page, anno, zoom,
      startX: e.clientX, startY: e.clientY,
      baseX: anno.x || 0, baseY: anno.y || 0,
      moved: false,
    };
    annoEl.setPointerCapture(e.pointerId);
  }

  function startResize(e, annoEl, page, anno) {
    const zoom = ctx.getZoom();
    // Signatures resize aspect-locked (image); whiteouts resize freely.
    const aspect = anno.type === 'signature' && anno.width && anno.height
      ? anno.width / anno.height : null;
    gesture = {
      kind: 'resize', pointerId: e.pointerId, annoEl, page, anno, zoom, aspect,
      startX: e.clientX, startY: e.clientY,
      baseW: anno.width || 0, baseH: anno.height || 0,
      moved: false,
    };
    annoEl.setPointerCapture(e.pointerId);
  }

  function startDraw(e, pageView, page) {
    const p = toPage(e, pageView);
    gesture = {
      kind: 'draw', pointerId: e.pointerId, pageView, page,
      originX: p.x, originY: p.y,
      el: null, anno: null, moved: false,
    };
    pageView.setPointerCapture(e.pointerId);
  }

  function onPointerDown(e) {
    if (gesture) return;                    // one gesture at a time
    if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
    const doc = ctx.getDoc();
    const tool = ctx.getTool();

    const handleEl = e.target.closest?.('.pv-handle');
    const annoEl = e.target.closest?.('.pv-anno');
    const pageView = e.target.closest?.('.pv-page');
    if (!pageView) return;
    const pageId = pageView.dataset.pageId;
    const page = doc.pages.find((pg) => pg.id === pageId);
    if (!page) return;

    // 1) Resize handle beats everything.
    if (handleEl && selectedEl && selectedEl.contains(handleEl)) {
      const found = findAnno(doc, selectedEl.dataset.annoId);
      if (found) {
        e.preventDefault();
        startResize(e, selectedEl, found.page, found.anno);
        return;
      }
    }

    // 2) Annotation hit → select + maybe drag (any tool: touching wins).
    if (annoEl) {
      const anno = page.annotations.find((a) => a.id === annoEl.dataset.annoId);
      if (anno) {
        e.preventDefault();                 // annotation hit: block scroll, we drag

        // Double-tap on text → edit (works for touch AND mouse double-click).
        const now = Date.now();
        const isDouble = anno.id === lastTap.annoId &&
          now - lastTap.t < DOUBLE_TAP_MS &&
          Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < DOUBLE_TAP_DIST;
        lastTap = { t: now, x: e.clientX, y: e.clientY, annoId: anno.id };

        setSelected(annoEl, anno);
        if (isDouble && anno.type === 'text') {
          ctx.onEditText?.(anno.id);
          return;
        }
        startDrag(e, annoEl, page, anno);
        return;
      }
    }

    // 3) Empty page space: tool decides.
    if (tool === 'whiteout') {
      e.preventDefault();
      startDraw(e, pageView, page);
    } else if (tool === 'text' || tool === 'signature' || tool === 'paraf') {
      // WHY preventDefault: onPlace may create + focus an inline editor NOW.
      // Canceling pointerdown suppresses the compatibility mousedown that
      // would otherwise fire right after and BLUR it (mouse only — touch
      // orders compat events after pointerup, which is why only desktop broke).
      e.preventDefault();
      const p = toPage(e, pageView);
      ctx.onPlace?.(tool, { pageId: page.id, x: p.x, y: p.y });
    } else {
      setSelected(null, null);              // select tool: tap empty = deselect
    }
  }

  function onPointerMove(e) {
    if (!gesture || e.pointerId !== gesture.pointerId) return;
    const doc = ctx.getDoc();
    const dx = (e.clientX - gesture.startX) / gesture.zoom;
    const dy = (e.clientY - gesture.startY) / gesture.zoom;

    if (gesture.kind === 'move') {
      if (!gesture.moved && (dx || dy)) {
        gesture.moved = true;
        if (ctx.history) record(ctx.history, doc);   // one undo step per gesture
      }
      if (!gesture.moved) return;
      // Through the single mutation path (clamps to page), then surgical DOM.
      const a = moveAnnotation(doc, gesture.anno.id,
        (gesture.baseX + dx) - (gesture.anno.x || 0),
        (gesture.baseY + dy) - (gesture.anno.y || 0));
      if (a) {
        gesture.annoEl.style.left = a.x + 'px';
        gesture.annoEl.style.top = a.y + 'px';
      }
    } else if (gesture.kind === 'resize') {
      if (!gesture.moved && (dx || dy)) {
        gesture.moved = true;
        if (ctx.history) record(ctx.history, doc);
      }
      if (!gesture.moved) return;
      const w = gesture.baseW + dx;
      const h = gesture.aspect ? w / gesture.aspect : gesture.baseH + dy;
      const a = resizeAnnotation(doc, gesture.anno.id, { width: w, height: h });
      if (a) {
        gesture.annoEl.style.width = a.width + 'px';
        if (gesture.anno.type === 'whiteout') gesture.annoEl.style.height = a.height + 'px';
        const img = gesture.annoEl.querySelector('img');
        if (img) img.style.width = a.width + 'px';
      }
    } else if (gesture.kind === 'draw') {
      // Whiteout draw: create lazily on first movement (a stray tap draws nothing).
      if (!gesture.anno) {
        if (!dx && !dy) return;
        if (ctx.history) record(ctx.history, doc);
        gesture.moved = true;
        // The editor owns creation (it has the factory); we hand it geometry.
        const created = ctx.onDrawStart?.({
          pageId: gesture.page.id, x: gesture.originX, y: gesture.originY,
        });
        if (!created) { gesture = null; return; }
        gesture.anno = created;
        gesture.el = gesture.pageView.querySelector(`[data-anno-id="${created.id}"]`);
      }
      const p = toPage(e, gesture.pageView);
      const x = Math.min(gesture.originX, p.x);
      const y = Math.min(gesture.originY, p.y);
      const w = Math.abs(p.x - gesture.originX);
      const h = Math.abs(p.y - gesture.originY);
      const a = resizeAnnotation(doc, gesture.anno.id, { x, y, width: w, height: h });
      if (a && gesture.el) {
        gesture.el.style.left = a.x + 'px';
        gesture.el.style.top = a.y + 'px';
        gesture.el.style.width = a.width + 'px';
        gesture.el.style.height = a.height + 'px';
      }
    }
  }

  function onPointerEnd(e) {
    if (!gesture || e.pointerId !== gesture.pointerId) return;
    const g = gesture;
    gesture = null;
    if (!g.moved) return;                    // taps already handled on down
    const kind = g.kind === 'draw' ? 'draw' : g.kind;
    ctx.onChange?.(kind, { annotation: g.anno });
  }

  stage.addEventListener('pointerdown', onPointerDown);
  stage.addEventListener('pointermove', onPointerMove);
  stage.addEventListener('pointerup', onPointerEnd);
  stage.addEventListener('pointercancel', onPointerEnd);

  function destroy() {
    stage.removeEventListener('pointerdown', onPointerDown);
    stage.removeEventListener('pointermove', onPointerMove);
    stage.removeEventListener('pointerup', onPointerEnd);
    stage.removeEventListener('pointercancel', onPointerEnd);
  }

  return { destroy, setSelected, refreshSelection };
}
