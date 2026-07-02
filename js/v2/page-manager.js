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

  // ---- tile interaction: tap = select, long-press (touch) / drag (mouse) = reorder
  function wireTile(tile, page) {
    let pressTimer = null;
    let start = null;
    let dragging = false;

    tile.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.pm-add')) return;
      start = { x: e.clientX, y: e.clientY, id: e.pointerId };
      if (e.pointerType === 'mouse') {
        // Mouse: drag arms immediately on movement; click stays a click.
        pressTimer = 0;
      } else {
        // Touch: long-press arms the drag (instant drag would fight scroll).
        pressTimer = setTimeout(() => { armDrag(e); }, LONG_PRESS_MS);
      }
    });

    function armDrag(e) {
      dragging = true;
      tile.classList.add('dragging');
      tile.setPointerCapture(e.pointerId ?? start.id);
      if (navigator.vibrate) navigator.vibrate(10);
    }

    tile.addEventListener('pointermove', (e) => {
      if (!start) return;
      const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
      if (!dragging) {
        if (pressTimer === 0 && moved > DRAG_SLOP) armDrag(e);          // mouse
        else if (moved > DRAG_SLOP) { clearTimeout(pressTimer); pressTimer = null; } // touch: became a scroll
        return;
      }
      e.preventDefault();
      // Live insertion hint: mark the tile currently under the pointer.
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.pm-tile:not(.pm-add)');
      for (const t of grid.querySelectorAll('.pm-tile.drop-hint')) t.classList.remove('drop-hint');
      if (over && over !== tile) over.classList.add('drop-hint');
    });

    const end = (e) => {
      clearTimeout(pressTimer);
      if (dragging) {
        dragging = false;
        tile.classList.remove('dragging');
        const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.pm-tile:not(.pm-add)');
        for (const t of grid.querySelectorAll('.pm-tile.drop-hint')) t.classList.remove('drop-hint');
        if (over && over !== tile) {
          const doc = deps.getDoc();
          const toIndex = doc.pages.findIndex((p) => p.id === over.dataset.pageId);
          record(deps.history, doc);
          reorderPage(doc, page.id, toIndex);
          render();
          deps.onDocChanged();
        }
      } else if (start && pressTimer !== null) {
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
    tile.addEventListener('pointercancel', () => {
      clearTimeout(pressTimer);
      dragging = false;
      tile.classList.remove('dragging');
      start = null; pressTimer = null;
    });
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
