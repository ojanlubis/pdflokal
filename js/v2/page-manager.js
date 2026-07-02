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

  // ---- open / close -----------------------------------------------------------
  function open() {
    selected.clear();
    render();
    sheet.showModal();
  }
  function close() { sheet.close(); }
  sheet.addEventListener('click', (e) => { if (e.target === sheet) close(); });

  // ---- rendering ----------------------------------------------------------------
  function render() {
    const doc = deps.getDoc();
    grid.innerHTML = '';
    doc.pages.forEach((page, i) => grid.appendChild(renderTile(page, i)));

    // [+] add tile — merge more files without leaving the sheet.
    const add = document.createElement('button');
    add.className = 'pm-tile pm-add';
    add.innerHTML = '<span>+</span>Tambah PDF';
    add.addEventListener('click', () => deps.onAddFiles());
    grid.appendChild(add);

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
    tile.setAttribute('aria-label', `Halaman ${index + 1}`);
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

    const im = document.createElement('div');
    im.className = 'pm-thumb';
    im.style.aspectRatio = String(1 / ratio);
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
    bulkBar.classList.toggle('show', n > 0);
    bulkBar.querySelector('.pm-count').textContent = `${n} dipilih`;
    // Deleting every page is blocked (an empty doc is a dead end, not a state).
    bulkBar.querySelector('[data-act="delete"]').disabled = n >= deps.getDoc().pages.length;
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

  function wireTile(tile, page) {
    let pressTimer = null;
    let start = null;
    let drag = null; // { placeholder, rect, lastX, lastY, raf }

    tile.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.pm-add')) return;
      start = { x: e.clientX, y: e.clientY, id: e.pointerId };
      if (e.pointerType === 'mouse') {
        pressTimer = 0;           // mouse: drag arms on first movement
      } else {
        pressTimer = setTimeout(() => { armDrag(e); }, LONG_PRESS_MS); // touch: long-press
      }
    });

    function armDrag(e) {
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
      tile.style.pointerEvents = 'none'; // elementFromPoint must see through it

      drag = { placeholder, rect, lastX: e.clientX ?? start.x, lastY: e.clientY ?? start.y, raf: false };
      // The pointer may be gone by the time the long-press timer fires.
      try { tile.setPointerCapture(e.pointerId ?? start.id); } catch { /* keep dragging uncaptured */ }
      if (navigator.vibrate) navigator.vibrate(10);
    }

    tile.addEventListener('pointermove', (e) => {
      if (!start) return;
      if (!drag) {
        const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
        if (pressTimer === 0 && moved > DRAG_SLOP) armDrag(e);          // mouse
        else if (moved > DRAG_SLOP) { clearTimeout(pressTimer); pressTimer = null; } // touch → scroll
        return;
      }
      e.preventDefault();
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      if (drag.raf) return;
      drag.raf = true;
      requestAnimationFrame(() => {
        if (!drag) return;
        drag.raf = false;
        // The page rides the finger.
        tile.style.transform =
          `translate(${drag.lastX - start.x}px, ${drag.lastY - start.y}px) scale(1.04)`;
        // Crossing a neighbor opens its slot: placeholder moves, tiles glide.
        const over = document.elementFromPoint(drag.lastX, drag.lastY)
          ?.closest('.pm-tile:not(.pm-add):not(.pm-placeholder)');
        if (over) {
          const r = over.getBoundingClientRect();
          const after = drag.lastX > r.left + r.width / 2; // grid flows left→right
          const target = after ? over.nextSibling : over;
          if (target !== drag.placeholder) {
            flipTiles(() => grid.insertBefore(drag.placeholder, target));
          }
        }
      });
    });

    const end = (e) => {
      clearTimeout(pressTimer);
      if (drag) {
        const d = drag;
        drag = null;
        // Settle the page into the open slot (fixed → slot rect)…
        const slotRect = d.placeholder.getBoundingClientRect();
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          // …then commit: the model index = placeholder's position in the grid.
          const tiles = [...grid.querySelectorAll('.pm-tile:not(.pm-add):not(.pm-drag-ghost)')];
          const toIndex = tiles.indexOf(d.placeholder);
          const doc = deps.getDoc();
          const fromIndex = doc.pages.findIndex((p) => p.id === page.id);
          if (toIndex !== -1 && toIndex !== fromIndex) {
            record(deps.history, doc);
            reorderPage(doc, page.id, toIndex);
            deps.onDocChanged();
          }
          render(); // rebuild clears all inline drag styles
        };
        if (REDUCED_MOTION) { settle(); return; }
        tile.style.transition = 'transform .18s cubic-bezier(.2,.8,.2,1)';
        tile.style.transform =
          `translate(${slotRect.left - d.rect.left}px, ${slotRect.top - d.rect.top}px)`;
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

  // ---- bulk actions ---------------------------------------------------------------
  bulkBar.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act || selected.size === 0) return;
    const doc = deps.getDoc();
    const pages = doc.pages.filter((p) => selected.has(p.id));

    if (act === 'rotate') {
      record(deps.history, doc);
      for (const p of pages) {
        rotatePage(doc, p.id, 90);
        p.raster = null;             // raster is now the wrong orientation
        thumbs.delete(p.id);         // thumb too
      }
      render();
      deps.onDocChanged();
    } else if (act === 'delete') {
      if (pages.length >= doc.pages.length) return; // guarded in UI as well
      record(deps.history, doc);
      for (const p of pages) removePage(doc, p.id);
      selected.clear();
      render();
      deps.onDocChanged();
      deps.toast(`${pages.length} halaman dihapus`);
    } else if (act === 'extract') {
      deps.onExtract(pages);
    } else if (act === 'clear') {
      selected.clear();
      render();
    }
  });

  return { open, close, render };
}
