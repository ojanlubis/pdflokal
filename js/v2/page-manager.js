/*
 * PDFLokal — v2/page-manager.js  ("Halaman" sheet: assemble = ~36% of actions)
 * ============================================================================
 * One touch-first surface for reorder / rotate / delete / extract / add —
 * replacing BOTH the old sidebar and the old Kelola Halaman modal.
 *
 * Interaction model (carried from the liked #73 redesign, minus its debt):
 *   - tap a tile        → toggle selection (always available, no mode switch)
 *   - bulk bar          → Putar / Hapus / Ekstrak on the selection
 *   - drag to reorder   → POINTER-based with long-press arm on touch (the old
 *                         HTML5 DnD never fired on touch — that whole bug class
 *                         is gone by construction)
 *   - [+] tile          → append more PDFs (merge)
 *
 * Every mutation: record(history) once → core op → onDocChanged() (the app
 * rebuilds the stage). Thumbnails are cached by page.id and NEVER touch
 * page.raster (the main view's streaming state).
 */

import { removePage, reorderPage, rotatePage } from '../core/operations.js';
import { record } from '../core/history.js';
import { track } from '../lib/analytics.js';
import { t as tr } from '../lib/i18n.js';

// SINGLE SOURCE OF TRUTH for "unavailable, not absent": aria-disabled, never the
// disabled attribute (a native-disabled button leaves the tab order). The bulk
// bar below and the per-page strip (page-strip.js) both use it.
export function setUnavailable(btn, off) {
  if (off) btn.setAttribute('aria-disabled', 'true');
  else btn.removeAttribute('aria-disabled');
}

const LONG_PRESS_MS = 280;
const DRAG_SLOP = 8; // px of movement that cancels a pending long-press

// deps = {
//   sheet:        the <dialog>
//   grid:         tile container
//   bulkBar:      bulk-action bar el
//   getDoc, history,
//   getRasterizer: () => rasterizer (has rasterizeThumb)
//   onDocChanged: () => void       — app rebuilds the main stage
//   onAddFiles:   () => void       — opens the file input (append/merge)
//   onExtract:    (pages) => void  — download selected pages as a new PDF
//   toast:        (msg) => void
// }
export function createPageManager(deps) {
  const { sheet, grid, bulkBar } = deps;
  const selected = new Set();          // page ids (UI-transient, not core state)
  const thumbs = new Map();            // page.id -> dataUrl (invalidated on rotate)
  let thumbQueue = Promise.resolve();  // serialize thumb renders (keep UI smooth)
  let pickResolve = null;              // non-null = PICK MODE (Unduh sheet asked)

  // ---- open / close -----------------------------------------------------------
  function open() {
    selected.clear();
    render();
    sheet.showModal();
    // Same event name as the old modal — dashboard continuity across the swap.
    track('gabungkan_used', { pageCount: deps.getDoc().pages.length });
  }
  function close() { sheet.close(); }
  sheet.addEventListener('click', (e) => { if (e.target === sheet) close(); });

  // ---- pick mode: the SAME surface, borrowed by the Unduh sheet ---------------
  // One place to select pages in the whole app (founder-locked). Resolves with
  // the chosen page ids in document order, or null on cancel.
  function openPick(preselected = []) {
    return new Promise((resolve) => {
      pickResolve = resolve;
      selected.clear();
      for (const id of preselected) selected.add(id);
      render();
      sheet.showModal();
    });
  }
  function finishPick(ids) {
    const resolve = pickResolve;
    pickResolve = null;
    sheet.close();
    resolve?.(ids);
  }
  sheet.addEventListener('close', () => {
    // Escape / backdrop while picking = cancel, never a dangling promise.
    if (pickResolve) { const r = pickResolve; pickResolve = null; r(null); }
  });
  deps.pickBar.querySelector('#pm-pick-cancel').addEventListener('click', () => finishPick(null));
  deps.pickBar.querySelector('#pm-pick-ok').addEventListener('click', () => {
    const ordered = deps.getDoc().pages.filter((p) => selected.has(p.id)).map((p) => p.id);
    finishPick(ordered.length ? ordered : null);
  });

  // ---- rendering ----------------------------------------------------------------
  // Sentry fee8a76e: a grid rebuild while a drag is mid-flight detaches the
  // placeholder + cached slot elements that dragLoop's insertBefore relies on
  // (NotFoundError, 18 users in 9 days). No rebuild during a drag — the
  // request parks here and end()/settle() flushes it.
  let dragActive = false;
  function render() {
    // Parked, not queued: every drag ends in settle(), which always renders —
    // the fresh rebuild supersedes whatever asked mid-drag.
    if (dragActive) return;
    const doc = deps.getDoc();
    grid.innerHTML = '';
    doc.pages.forEach((page, i) => grid.appendChild(renderTile(page, i)));

    // [+] add tile — merge more files without leaving the sheet. (Not while
    // picking pages for a download — that's a selection moment, not editing.)
    if (!pickResolve) {
      const add = document.createElement('button');
      add.className = 'pm-tile pm-add';
      add.innerHTML = '<span>+</span>Tambah PDF';
      add.addEventListener('click', () => deps.onAddFiles());
      grid.appendChild(add);
    }

    renderBulkBar();
  }

  function renderTile(page, index) {
    const tile = document.createElement('div');
    tile.className = 'pm-tile';
    tile.dataset.pageId = page.id;
    // Keyboard path: tiles are toggle buttons (drag-reorder stays pointer-only;
    // bulk actions cover the same jobs for keyboard users).
    tile.setAttribute('role', 'button');
    tile.setAttribute('tabindex', '0');
    tile.setAttribute('aria-label', tr('pm.page', { n: index + 1 }));
    tile.setAttribute('aria-pressed', String(selected.has(page.id)));
    tile.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (selected.has(page.id)) selected.delete(page.id);
        else selected.add(page.id);
        tile.classList.toggle('sel', selected.has(page.id));
        tile.setAttribute('aria-pressed', String(selected.has(page.id)));
        renderBulkBar();
      }
    });
    if (selected.has(page.id)) tile.classList.add('sel');

    const rotated = (page.rotation || 0) % 180 !== 0;
    const ratio = rotated ? page.width / page.height : page.height / page.width;
    // The TILE carries the aspect ratio (deterministic grid row sizing); the
    // thumb just fills it. A width-dependent child height (aspect-ratio on the
    // thumb) hit a grid auto-row cyclic-sizing quirk: rows collapsed under
    // multi-row layouts while single rows measured fine.
    tile.style.aspectRatio = String(1 / ratio);

    const im = document.createElement('div');
    im.className = 'pm-thumb';
    const cached = thumbs.get(page.id);
    if (cached) im.style.backgroundImage = `url(${cached})`;
    else queueThumb(page, im);
    tile.appendChild(im);

    const num = document.createElement('span');
    num.className = 'pm-num';
    num.textContent = String(index + 1);
    tile.appendChild(num);

    const check = document.createElement('span');
    check.className = 'pm-check';
    check.textContent = '✓';
    tile.appendChild(check);

    wireTile(tile, page);
    return tile;
  }

  function queueThumb(page, el) {
    thumbQueue = thumbQueue.then(async () => {
      if (!sheet.open) return; // sheet closed mid-queue; skip quietly
      try {
        const t = await deps.getRasterizer().rasterizeThumb(page, { width: 150 });
        thumbs.set(page.id, t.dataUrl);
        el.style.backgroundImage = `url(${t.dataUrl})`;
      } catch { /* tile keeps its blank placeholder */ }
    });
  }

  function renderBulkBar() {
    const n = selected.size;
    if (pickResolve) {
      // Pick mode: bulk actions hidden; the pick bar is the only exit.
      bulkBar.classList.remove('show');
      deps.pickBar.classList.add('show');
      deps.pickBar.querySelector('#pm-pick-ok').textContent = tr('pm.use', { n });
      deps.pickBar.querySelector('#pm-pick-ok').disabled = n === 0;
      return;
    }
    deps.pickBar.classList.remove('show');
    // Always shown once the sheet is open (not just after a tile is picked) —
    // the bar states what the sheet can do before anything is touched, rather
    // than hiding every action behind a selection the user has to discover.
    bulkBar.classList.add('show');
    // Only touch the live region when the text changes: re-writing identical
    // text can make a screen reader repeat "0 dipilih" on every render.
    const count = bulkBar.querySelector('.pm-count');
    const label = tr('pm.selected', { count: n });
    if (count.textContent !== label) count.textContent = label;
    const empty = n === 0;
    // aria-disabled, NOT the disabled attribute: a native-disabled button leaves
    // the tab order and a screen reader's walk, so a keyboard user would never
    // meet Putar/Ekstrak/Hapus at zero selection (the very gap this bar closes),
    // and focus is dropped to <body> if the focused action disables itself.
    // The click handler below ignores aria-disabled buttons.
    setUnavailable(bulkBar.querySelector('[data-act="rotate"]'), empty);
    setUnavailable(bulkBar.querySelector('[data-act="extract"]'), empty);
    // Deleting every page is blocked (an empty doc is a dead end, not a state).
    setUnavailable(bulkBar.querySelector('[data-act="delete"]'), empty || n >= deps.getDoc().pages.length);
    // Batal has nothing to cancel at zero — keep it out of the tab order too.
    // If it holds focus as it goes, hand focus to the first tile rather than
    // letting the dialog fall back to <body>.
    const clear = bulkBar.querySelector('[data-act="clear"]');
    if (empty && !clear.hidden && document.activeElement === clear) {
      grid.querySelector('.pm-tile:not(.pm-add)')?.focus();
    }
    clear.hidden = empty;
  }

  // ---- FLIP reorder: grab a REAL page and move it -----------------------------------
  // The grabbed tile goes position:fixed and rides the finger 1:1; an invisible
  // placeholder holds its slot; crossing another tile moves the placeholder and
  // every displaced tile GLIDES to its new spot (FLIP: transform-only, GPU-
  // composited — no per-frame layout beyond the one grid reflow on slot change).
  const REDUCED_MOTION = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  function flipTiles(mutate) {
    const tiles = [...grid.querySelectorAll('.pm-tile:not(.pm-drag-ghost)')];
    const before = new Map(tiles.map((t) => [t, t.getBoundingClientRect()]));
    mutate();
    if (REDUCED_MOTION) return;
    for (const t of tiles) {
      const a = before.get(t);
      const b = t.getBoundingClientRect();
      const dx = a.left - b.left;
      const dy = a.top - b.top;
      if (!dx && !dy) continue;
      t.style.transition = 'none';
      t.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(() => {
        t.style.transition = 'transform .22s cubic-bezier(.2,.8,.2,1)';
        t.style.transform = '';
        t.addEventListener('transitionend', () => { t.style.transition = ''; }, { once: true });
      });
    }
  }

  // Long-press on a tile must never pop the browser context menu mid-drag.
  grid.addEventListener('contextmenu', (e) => e.preventDefault());

  const SCROLL_EDGE = 56;   // px from the grid's top/bottom that auto-scrolls
  const SCROLL_MAX = 14;    // px per frame at the deepest edge

  function wireTile(tile, page) {
    let pressTimer = null;
    let start = null;
    let drag = null; // { placeholder, rect, pointerId, originX, originY, lastX, lastY, slots, pIndex }

    tile.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.pm-add')) return;
      // ONE POINTER OWNS THE TILE (Sentry JAVASCRIPT-F, Android Chrome, 5 events
      // Jul 8 → Sep 16). A second finger on a pressed tile used to start a
      // second long-press timer while the first stayed armed; the second
      // finger's release then ended the press as a tap (start = null), and
      // 280ms after the FIRST touch its timer still fired, armed a drag, and
      // the rAF loop read start.x off null on every frame. The second pointer
      // is ignored here and in end() below; the first keeps its press.
      if (start) return;
      start = { x: e.clientX, y: e.clientY, id: e.pointerId };
      if (e.pointerType === 'mouse') {
        pressTimer = 0;           // mouse: drag arms on first movement
      } else {
        pressTimer = setTimeout(() => { armDrag(e); }, LONG_PRESS_MS); // touch: long-press
      }
    });

    // Slot geometry cache — offsetLeft/Top are LAYOUT coordinates: immune to
    // both in-flight FLIP transforms and grid scrolling. This is what makes
    // the insertion decision stable (no arguing with our own animation) and
    // auto-scroll free (content coords don't move when the grid scrolls).
    function recacheSlots() {
      const kids = [...grid.children].filter((c) =>
        c !== tile && c.classList.contains('pm-tile') && !c.classList.contains('pm-add'));
      drag.pIndex = kids.indexOf(drag.placeholder);
      drag.slots = kids
        .filter((c) => c !== drag.placeholder)
        .map((el) => ({ el, left: el.offsetLeft, top: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight }));
    }

    function armDrag(e) {
      if (pickResolve) return; // pick mode is selection-only — no reordering
      // Defensive (Sentry JAVASCRIPT-E): render() only parks while a drag is
      // ACTIVE — a rebuild during the long-press wait (thumbnail upgrade)
      // detaches this tile, and insertBefore against an orphan throws.
      // Stale tile → don't arm; the rebuilt tile carries fresh listeners.
      // No press → nothing to arm either (a drag is a press that lasted).
      if (!start || tile.parentNode !== grid) { start = null; pressTimer = null; return; }
      const rect = tile.getBoundingClientRect();
      const placeholder = document.createElement('div');
      placeholder.className = 'pm-tile pm-placeholder';
      placeholder.style.height = rect.height + 'px';
      grid.insertBefore(placeholder, tile);

      // Lift the real tile out of the grid, exactly where it was.
      tile.classList.add('pm-drag-ghost');
      tile.style.position = 'fixed';
      tile.style.left = rect.left + 'px';
      tile.style.top = rect.top + 'px';
      tile.style.width = rect.width + 'px';
      tile.style.zIndex = '50';
      tile.style.pointerEvents = 'none';

      // The drag carries its own origin and pointer: the loop below and the
      // window listeners read only `drag`, never the tap-state `start`, so
      // the two cannot disagree about whether a drag is alive.
      drag = {
        placeholder, rect, pointerId: start.id,
        originX: start.x, originY: start.y,
        lastX: e.clientX ?? start.x, lastY: e.clientY ?? start.y,
      };
      dragActive = true;
      recacheSlots();
      // The pointer may be gone by the time the long-press timer fires.
      try { tile.setPointerCapture(e.pointerId ?? start.id); } catch { /* keep dragging uncaptured */ }
      // WHY window listeners: the lifted tile has pointerEvents:none, so if
      // pointer capture fails or is lost mid-drag, its own pointerup never
      // fires and the ghost hangs in the air with its placeholder (founder-
      // caught, Jul 4, desktop). The window hears the release no matter where
      // it lands — even outside the dialog. Removed in end().
      drag.winMove = (ev) => {
        if (!drag || ev.pointerId !== drag.pointerId) return; // another finger: not ours
        ev.preventDefault();
        drag.lastX = ev.clientX;
        drag.lastY = ev.clientY;
      };
      drag.winEnd = (ev) => end(ev);
      // WHY touchmove too: tiles carry touch-action: pan-y, and
      // pointermove.preventDefault() does NOT revoke the browser's pan claim —
      // vertical finger movement after the lift made Chrome fire pointercancel
      // (drag dies, grid scrolls; founder, Jul 5, mobile prod). Consuming
      // touchmove non-passively while armed is the only mid-gesture veto;
      // touch-action changes after touchstart are ignored. Removed in end().
      drag.winTouchMove = (ev) => { if (ev.cancelable) ev.preventDefault(); };
      window.addEventListener('pointermove', drag.winMove);
      window.addEventListener('pointerup', drag.winEnd);
      window.addEventListener('pointercancel', drag.winEnd);
      window.addEventListener('touchmove', drag.winTouchMove, { passive: false });
      if (navigator.vibrate) navigator.vibrate(10);
      requestAnimationFrame(dragLoop);
    }

    // One continuous loop per drag (not per pointermove): the ghost follows the
    // finger, the grid auto-scrolls near its edges — including while the finger
    // rests there — and the insertion index is re-derived from cached layout.
    function dragLoop() {
      if (!drag) return;
      tile.style.transform =
        `translate(${drag.lastX - drag.originX}px, ${drag.lastY - drag.originY}px) scale(1.045) rotate(1.5deg)`;

      // Auto-scroll: proportional to how deep the finger is in the edge zone.
      const gr = grid.getBoundingClientRect();
      if (grid.scrollHeight > grid.clientHeight) {
        if (drag.lastY < gr.top + SCROLL_EDGE) {
          grid.scrollTop -= SCROLL_MAX * ((gr.top + SCROLL_EDGE - drag.lastY) / SCROLL_EDGE);
        } else if (drag.lastY > gr.bottom - SCROLL_EDGE) {
          grid.scrollTop += SCROLL_MAX * ((drag.lastY - (gr.bottom - SCROLL_EDGE)) / SCROLL_EDGE);
        }
      }

      // Insertion index from CONTENT coordinates (scroll- and animation-proof):
      // a slot counts as "before the finger" if its row is fully above, or it's
      // on the finger's row with its center to the left.
      const px = drag.lastX - gr.left + grid.scrollLeft;
      const py = drag.lastY - gr.top + grid.scrollTop;
      let D = 0;
      for (const s of drag.slots) {
        if (s.top + s.h <= py) D += 1;
        else if (py >= s.top && px > s.left + s.w / 2) D += 1;
      }
      if (D !== drag.pIndex) {
        // Defensive (Sentry fee8a76e): if anything rebuilt the grid under us,
        // the cached refs are detached — inserting against them throws.
        if (drag.placeholder.parentNode !== grid) { end({ type: 'pointercancel' }); return; }
        let target = drag.slots[D]?.el ?? grid.querySelector('.pm-add');
        if (target && target.parentNode !== grid) { recacheSlots(); target = null; }
        flipTiles(() => grid.insertBefore(drag.placeholder, target));
        recacheSlots(); // layout changed → new truth
      }
      requestAnimationFrame(dragLoop);
    }

    tile.addEventListener('pointermove', (e) => {
      if (!start || e.pointerId !== start.id) return; // see pointerdown: one pointer owns the tile
      if (!drag) {
        const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
        if (pressTimer === 0 && moved > DRAG_SLOP) armDrag(e);          // mouse
        else if (moved > DRAG_SLOP) { clearTimeout(pressTimer); pressTimer = null; } // touch → scroll
        return;
      }
      e.preventDefault();
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
    });

    const end = (e) => {
      // A pointer that never owned the tile has nothing to end (see pointerdown).
      // The drag loop's synthetic cancel carries no pointerId and always passes.
      if (start && e.pointerId !== undefined && e.pointerId !== start.id) return;
      clearTimeout(pressTimer);
      if (drag) {
        const d = drag;
        drag = null; // stops the loop
        window.removeEventListener('pointermove', d.winMove);
        window.removeEventListener('pointerup', d.winEnd);
        window.removeEventListener('pointercancel', d.winEnd);
        window.removeEventListener('touchmove', d.winTouchMove);
        // Settle target from LAYOUT coords (a mid-glide placeholder's gBCR lies).
        const gr = grid.getBoundingClientRect();
        const slotLeft = gr.left + d.placeholder.offsetLeft - grid.scrollLeft;
        const slotTop = gr.top + d.placeholder.offsetTop - grid.scrollTop;
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          // Commit: the model index = placeholder's position in the grid.
          const tiles = [...grid.querySelectorAll('.pm-tile:not(.pm-add):not(.pm-drag-ghost)')];
          const toIndex = tiles.indexOf(d.placeholder);
          if (toIndex !== -1) movePage(page.id, toIndex);
          dragActive = false;
          render(); // rebuild clears all inline drag styles + flushes any parked render
        };
        if (REDUCED_MOTION) { settle(); return; }
        tile.style.transition = 'transform .18s cubic-bezier(.2,.8,.2,1)';
        tile.style.transform =
          `translate(${slotLeft - d.rect.left}px, ${slotTop - d.rect.top}px)`;
        tile.addEventListener('transitionend', settle, { once: true });
        setTimeout(settle, 260); // safety: transitionend can be swallowed
      } else if (start && pressTimer !== null && e.type === 'pointerup') {
        // It was a tap → toggle selection.
        if (selected.has(page.id)) selected.delete(page.id);
        else selected.add(page.id);
        tile.classList.toggle('sel', selected.has(page.id));
        tile.setAttribute('aria-pressed', String(selected.has(page.id)));
        renderBulkBar();
      }
      start = null;
      pressTimer = null;
    };
    tile.addEventListener('pointerup', end);
    tile.addEventListener('pointercancel', end);
  }

  // ---- the three page mutations: SINGLE SOURCE OF TRUTH -----------------------------
  // The Halaman sheet (bulk bar, drag) AND the per-page strip in the main stage
  // (page-strip.js) both come through here, so a click on either is the same
  // act: one undo step, the same core op, the same telemetry name, the same
  // thumbnail invalidation, the same toast. Each returns false when it did
  // nothing (and then recorded nothing).
  function movePage(pageId, toIndex) {
    const doc = deps.getDoc();
    const fromIndex = doc.pages.findIndex((p) => p.id === pageId);
    if (fromIndex === -1 || toIndex === fromIndex || toIndex < 0 || toIndex >= doc.pages.length) return false;
    record(deps.history, doc);
    reorderPage(doc, pageId, toIndex);
    track('editor_action', { action: 'reorder' });
    deps.onDocChanged();
    return true;
  }

  function rotatePages(ids) {
    const doc = deps.getDoc();
    const pages = doc.pages.filter((p) => ids.includes(p.id));
    if (pages.length === 0) return false;
    record(deps.history, doc);
    for (const p of pages) {
      rotatePage(doc, p.id, 90);
      p.raster = null;             // raster is now the wrong orientation
      thumbs.delete(p.id);         // thumb too
    }
    track('editor_action', { action: 'rotate' });
    if (sheet.open) render();
    deps.onDocChanged();
    return true;
  }

  function deletePages(ids) {
    const doc = deps.getDoc();
    const pages = doc.pages.filter((p) => ids.includes(p.id));
    // Deleting every page is blocked (an empty doc is a dead end, not a state).
    if (pages.length === 0 || pages.length >= doc.pages.length) return false;
    record(deps.history, doc);
    for (const p of pages) { removePage(doc, p.id); thumbs.delete(p.id); selected.delete(p.id); }
    track('editor_action', { action: 'delete_page' });
    if (sheet.open) render();
    deps.onDocChanged();
    deps.toast(tr('pm.deleted', { count: pages.length }));
    return true;
  }

  // ---- bulk actions ---------------------------------------------------------------
  bulkBar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    const act = btn?.dataset.act;
    // aria-disabled buttons still receive click/Enter/Space: they must do nothing.
    if (!act || selected.size === 0 || btn.getAttribute('aria-disabled') === 'true') return;
    const doc = deps.getDoc();
    const pages = doc.pages.filter((p) => selected.has(p.id));

    if (act === 'rotate') {
      rotatePages(pages.map((p) => p.id));
    } else if (act === 'delete') {
      deletePages(pages.map((p) => p.id));
    } else if (act === 'extract') {
      track('editor_action', { action: 'split' }); // old name kept: extract IS split
      deps.onExtract(pages);
    } else if (act === 'clear') {
      selected.clear();
      render();
    }
  });

  // Undo/redo can revert rotations the thumb cache baked in (review M4) — the
  // caller flushes us wholesale; thumbs regenerate lazily on next open.
  function invalidateThumbs() { thumbs.clear(); }

  return {
    open,
    openPick,
    close,
    render,
    movePage,
    rotatePages,
    deletePages,
    invalidateThumbs,
    // Test hook only (tests/buka-baru-thumbs.spec.js): the thumb cache is
    // otherwise unobservable, and its leak-on-Buka-Baru regression needs a
    // way to go red. Never used by product code.
    thumbCount: () => thumbs.size,
  };
}
