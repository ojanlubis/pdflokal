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

import { selectAnnotation, clearSelection, moveAnnotation, resizeAnnotation, updateAnnotation } from '../core/operations.js';
import { record } from '../core/history.js';
import { decorateSelected, undecorateSelected } from './page-view.js';

const TAP_SLOP = 12; // px of finger movement beyond which a press is not a tap

// ctx = {
//   stage:      container holding .pv-page views
//   getDoc:     () => Doc
//   getZoom:    () => number (CSS scale on the stage)
//   getTool:    () => 'select' | 'text' | 'whiteout' | 'signature' | 'paraf' | 'ganti'
//   history:    core history (or null to disable undo recording)
//   onChange:   (kind, payload) => void   — 'select' | 'move' | 'resize' | 'draw'
//   onPlace:    (tool, {pageId, x, y}) => void — tap-to-place for text/signature;
//               for 'ganti' this now fires at RELEASE (see startGanti below)
//   onEditText: (annotationId) => void — click/tap on an already-selected text
//   onGantiSteer: ({pageId, x, y} | null) => void — live line-highlight while
//               a Ganti Teks press/drag/hover is in flight; null clears it
// }
export function createInteraction(ctx) {
  const { stage } = ctx;
  let gesture = null;        // the active pointer gesture (one at a time)
  let tapCandidate = null;   // touch press waiting to become a tap at RELEASE
  let selectedEl = null;     // decorated element (kept in sync with doc.selection)

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
  // MUST actually decorate (review H2): renderPageView sets only z-index, so a
  // rebuildStage that keeps a selection (undo/redo, Semua Hal.) would leave the
  // selected object without outline/handle AND without touch-action:none —
  // invisible selection that scrolls instead of dragging on a phone.
  function refreshSelection() {
    selectedEl = null;
    const doc = ctx.getDoc();
    const id = doc.selection.annotationId;
    if (!id) return;
    const el = stage.querySelector(`[data-anno-id="${id}"]`);
    if (!el) return;
    selectedEl = el;
    const found = findAnno(doc, id);
    if (found && !el.classList.contains('pv-selected')) {
      el.style.zIndex = '1000';
      decorateSelected(el, found.anno);
    }
  }

  function findAnno(doc, annoId) {
    for (const page of doc.pages) {
      const a = page.annotations.find((x) => x.id === annoId);
      if (a) return { page, anno: a };
    }
    return null;
  }

  // ---- gestures --------------------------------------------------------------

  function startDrag(e, annoEl, page, anno, wasSelected = false) {
    const zoom = ctx.getZoom();
    gesture = {
      kind: 'move', pointerId: e.pointerId, annoEl, page, anno, zoom,
      startX: e.clientX, startY: e.clientY,
      baseX: anno.x || 0, baseY: anno.y || 0,
      moved: false, wasSelected,
    };
    annoEl.setPointerCapture(e.pointerId);
  }

  function startResize(e, annoEl, page, anno) {
    const zoom = ctx.getZoom();
    // Signatures resize aspect-locked (image); whiteouts resize freely; text
    // resizes by SCALING fontSize (same handle gesture as TTD — founder ask).
    const aspect = anno.type === 'signature' && anno.width && anno.height
      ? anno.width / anno.height : null;
    gesture = {
      kind: 'resize', pointerId: e.pointerId, annoEl, page, anno, zoom, aspect,
      startX: e.clientX, startY: e.clientY,
      baseW: anno.width || 0, baseH: anno.height || 0,
      baseFontSize: anno.fontSize || 24,
      baseElW: annoEl.offsetWidth || 1, // layout px, unaffected by transform
      moved: false,
    };
    annoEl.setPointerCapture(e.pointerId);
  }

  function startDraw(e, pageView, page) {
    const p = toPage(e, pageView);
    gesture = {
      kind: 'draw', pointerId: e.pointerId, pageView, page,
      // zoom/startX/startY MUST be here like every gesture: onPointerMove's
      // shared delta math reads them. Their absence made dx NaN and silently
      // killed whiteout-draw entirely (caught by the founder, Jul 2).
      zoom: ctx.getZoom(),
      startX: e.clientX, startY: e.clientY,
      originX: p.x, originY: p.y,
      el: null, anno: null, moved: false,
    };
    pageView.setPointerCapture(e.pointerId);
  }

  // Ganti Teks: press → highlight the line under the finger (nothing
  // committed), move → re-target live (steering), release → commit at the
  // RELEASE point via onPlace. WHY (founder field report, dense documents,
  // 2026-07-19): pointer-DOWN commit meant a fat finger couldn't aim a single
  // printed line among many tight ones — no way to correct before the editor
  // opened on the wrong line. This mirrors the camera-first release-commit
  // law whiteout already uses to steal the armed gesture for its own verb
  // (draw); Ganti's verb is "aim", and a quick tap (press+release in place)
  // still reduces to the old outcome.
  function startGanti(e, pageView, page) {
    const p = toPage(e, pageView);
    gesture = {
      kind: 'ganti', pointerId: e.pointerId, pageView, pageId: page.id,
      // zoom/startX/startY kept for parity with every other gesture even
      // though this one doesn't use the shared delta math — their absence
      // silently NaN'd whiteout-draw once (see startDraw above); not worth
      // re-learning that lesson for a second gesture kind.
      zoom: ctx.getZoom(), startX: e.clientX, startY: e.clientY,
    };
    // Light up BEFORE capturing: setPointerCapture is a no-op for the
    // highlight either way, but keeping onGantiSteer first means a capture
    // failure can never swallow the "lit at press" affordance the founder
    // asked for.
    ctx.onGantiSteer?.({ pageId: page.id, x: p.x, y: p.y });
    pageView.setPointerCapture(e.pointerId);
  }

  function onPointerDown(e) {
    if (gesture || tapCandidate) return;    // one gesture at a time
    if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
    const doc = ctx.getDoc();
    const tool = ctx.getTool();
    const isTouch = e.pointerType !== 'mouse';

    const handleEl = e.target.closest?.('.pv-handle');
    const annoEl = e.target.closest?.('.pv-anno');
    const pageView = e.target.closest?.('.pv-page');
    if (!pageView) return;
    const pageId = pageView.dataset.pageId;
    const page = doc.pages.find((pg) => pg.id === pageId);
    if (!page) return;

    // 1) Resize handle beats everything (explicit chrome, unambiguous).
    if (handleEl && selectedEl && selectedEl.contains(handleEl)) {
      const found = findAnno(doc, selectedEl.dataset.annoId);
      if (found) {
        e.preventDefault();
        startResize(e, selectedEl, found.page, found.anno);
        return;
      }
    }

    // 2) An ARMED tool beats annotation hits — so Tip-Ex can cover a spot and
    //    Teks can then write ON TOP of that cover (founder use case). Arming a
    //    tool is explicit intent; every tool returns home after its verb.
    if (tool === 'whiteout') {
      e.preventDefault();
      startDraw(e, pageView, page);
      return;
    }
    if (tool === 'ganti') {
      // Press→steer→release-commit (see startGanti's WHY comment) — Ganti no
      // longer commits at pointerDOWN, so it does NOT join the immediate
      // onPlace branch below (text/signature/paraf still do — unchanged).
      e.preventDefault();
      startGanti(e, pageView, page);
      return;
    }
    if (tool === 'text' || tool === 'signature' || tool === 'paraf') {
      // WHY preventDefault: onPlace may create + focus an inline editor NOW.
      // Canceling pointerdown suppresses the compatibility mousedown that
      // would otherwise fire right after and BLUR it (mouse only — touch
      // orders compat events after pointerup, which is why only desktop broke).
      e.preventDefault();
      const p = toPage(e, pageView);
      ctx.onPlace?.(tool, { pageId: page.id, x: p.x, y: p.y });
      return;
    }

    // 3) Annotation hit.
    if (annoEl) {
      const anno = page.annotations.find((a) => a.id === annoEl.dataset.annoId);
      if (anno) {
        if (tool === 'delete') {
          e.preventDefault();
          ctx.onDeleteTap?.(anno.id, page.id);
          return;
        }

        if (!isTouch) {
          // Mouse: select + drag immediately (no camera gesture to conflict
          // with). Whether this click can become "edit" is decided at RELEASE
          // (no-move + was already selected) — see onPointerEnd.
          e.preventDefault();
          const wasSelected = doc.selection.annotationId === anno.id;
          setSelected(annoEl, anno);
          startDrag(e, annoEl, page, anno, wasSelected);
          return;
        }

        if (doc.selection.annotationId === anno.id) {
          // Touch on the ALREADY-selected object: that's a deliberate grab —
          // drag it. (decorateSelected set touch-action:none on it, so the
          // browser won't steal the gesture for scrolling.)
          e.preventDefault();
          startDrag(e, annoEl, page, anno, true);
          return;
        }

        // Touch on an UNSELECTED object: selection commits at RELEASE, never
        // at press (founder's model). No preventDefault, no capture — if the
        // finger moves, the browser takes it as CAMERA (scroll) and fires
        // pointercancel, which clears the candidate. A clean press+release
        // within the slop is a tap → select.
        tapCandidate = { pointerId: e.pointerId, annoId: anno.id, annoEl, x: e.clientX, y: e.clientY };
        return;
      }
    }

    // 4) Empty page, Pilih tool: same release-commit rule — a tap deselects,
    //    a drag is the camera. (Mouse deselects on press, as ever.)
    if (!isTouch) setSelected(null, null);
    else tapCandidate = { pointerId: e.pointerId, annoId: null, annoEl: null, x: e.clientX, y: e.clientY };
  }

  function onPointerMove(e) {
    if (!gesture || e.pointerId !== gesture.pointerId) {
      // Fine-pointer hover preview (Sejda-style, founder-requested): with NO
      // gesture in flight and a mouse roaming while Ganti is armed, forward
      // the position so the line highlight can track the cursor before any
      // press — cheap, the ctx handler (app.js) throttles via rAF.
      if (!gesture && e.pointerType === 'mouse' && ctx.getTool() === 'ganti') {
        const hoverPage = e.target.closest?.('.pv-page');
        if (hoverPage) {
          const p = toPage(e, hoverPage);
          ctx.onGantiSteer?.({ pageId: hoverPage.dataset.pageId, x: p.x, y: p.y });
        } else {
          ctx.onGantiSteer?.(null);
        }
      }
      return;
    }
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
      if (gesture.anno.type === 'text') {
        // Text resize = fontSize scaling (no width/height on text annos).
        const factor = Math.max(0.2, (gesture.baseElW + dx) / gesture.baseElW);
        const fontSize = Math.min(120, Math.max(6, Math.round(gesture.baseFontSize * factor)));
        updateAnnotation(doc, gesture.anno.id, { fontSize });
        gesture.annoEl.style.fontSize = fontSize + 'px'; // longhand beats the shorthand
      } else {
        const w = gesture.baseW + dx;
        const h = gesture.aspect ? w / gesture.aspect : gesture.baseH + dy;
        const a = resizeAnnotation(doc, gesture.anno.id, { width: w, height: h });
        if (a) {
          gesture.annoEl.style.width = a.width + 'px';
          if (gesture.anno.type === 'whiteout') gesture.annoEl.style.height = a.height + 'px';
          const img = gesture.annoEl.querySelector('img');
          if (img) img.style.width = a.width + 'px';
        }
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
    } else if (gesture.kind === 'ganti') {
      // Steering: re-target the highlight live, nothing committed yet.
      const p = toPage(e, gesture.pageView);
      ctx.onGantiSteer?.({ pageId: gesture.pageId, x: p.x, y: p.y });
    }
  }

  function onPointerEnd(e) {
    // Release-commit for touch taps (founder's model: selection at UNPRESS).
    // A scroll-take-over fires pointercancel → the candidate dies silently.
    if (tapCandidate && e.pointerId === tapCandidate.pointerId) {
      const tc = tapCandidate;
      tapCandidate = null;
      const isTap = e.type === 'pointerup' &&
        Math.hypot(e.clientX - tc.x, e.clientY - tc.y) < TAP_SLOP;
      if (!isTap) return;
      if (tc.annoId) {
        const doc = ctx.getDoc();
        const found = findAnno(doc, tc.annoId);
        if (found) setSelected(tc.annoEl, found.anno);
      } else {
        setSelected(null, null);
      }
      return;
    }

    // Ganti Teks: release commits (pointerup) at the RELEASE point via the
    // existing onPlace/smartReplace path; a cancel (scroll/pinch stole the
    // gesture) clears the highlight with no commit at all. This gesture has
    // no "moved" concept — unlike move/resize/draw, EVERY release commits,
    // a still-finger tap included — so it's handled before the generic
    // moved-gated logic below, not through it.
    if (gesture && gesture.kind === 'ganti' && e.pointerId === gesture.pointerId) {
      const g = gesture;
      gesture = null;
      ctx.onGantiSteer?.(null);
      if (e.type === 'pointerup') {
        const p = toPage(e, g.pageView);
        ctx.onPlace?.('ganti', { pageId: g.pageId, x: p.x, y: p.y });
      }
      return;
    }

    if (!gesture || e.pointerId !== gesture.pointerId) return;
    const g = gesture;
    gesture = null;
    if (!g.moved) {
      // Release-without-drag on an ALREADY-selected text enters editing — the
      // Figma/PowerPoint model (founder, Jul 3): first click/tap selects, the
      // next one edits; a double-click from unselected composes the same two
      // steps, so no double-tap timing window is needed at all.
      if (g.kind === 'move' && e.type === 'pointerup' && g.wasSelected && g.anno.type === 'text') {
        ctx.onEditText?.(g.anno.id);
      }
      return;
    }
    const kind = g.kind === 'draw' ? 'draw' : g.kind;
    ctx.onChange?.(kind, { annotation: g.anno });
  }

  // Abort the in-flight gesture and put the object back — called by the app
  // when a second finger lands (pinch): a finger that happened to start on a
  // selected object must not fling it across the page.
  function cancelGesture() {
    tapCandidate = null;
    if (!gesture) return;
    const g = gesture;
    gesture = null;
    // A second finger landing mid-steer (pinch) must not leave the highlight
    // stuck lit with no gesture left to clear it — no geometry to restore
    // either, ganti never mutates the doc until release.
    if (g.kind === 'ganti') { ctx.onGantiSteer?.(null); return; }
    if (!g.moved) return;
    const doc = ctx.getDoc();
    if (g.kind === 'move') {
      const a = moveAnnotation(doc, g.anno.id,
        g.baseX - (g.anno.x || 0), g.baseY - (g.anno.y || 0));
      if (a) { g.annoEl.style.left = a.x + 'px'; g.annoEl.style.top = a.y + 'px'; }
    } else if (g.kind === 'resize') {
      if (g.anno.type === 'text') {
        updateAnnotation(doc, g.anno.id, { fontSize: g.baseFontSize });
        g.annoEl.style.fontSize = g.baseFontSize + 'px';
      } else {
        const a = resizeAnnotation(doc, g.anno.id, { width: g.baseW, height: g.baseH });
        if (a) {
          g.annoEl.style.width = a.width + 'px';
          if (g.anno.type === 'whiteout') g.annoEl.style.height = a.height + 'px';
          const img = g.annoEl.querySelector('img');
          if (img) img.style.width = a.width + 'px';
        }
      }
    }
    // A draw in progress is left as-is (undo removes it) — restoring a half-
    // drawn whiteout mid-pinch would surprise more than it helps.
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

  return { destroy, setSelected, refreshSelection, cancelGesture };
}
