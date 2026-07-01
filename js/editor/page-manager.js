/*
 * PDFLokal - editor/page-manager.js (ES Module)
 * "Kelola Halaman" modal: reorder, rotate, delete, multi-select bulk actions
 * (rotate / delete / split), and add pages (PDF / image).
 *
 * SELECTION MODEL: there is no separate "Split mode". Selection is always
 * available via each tile's checkbox and is tracked by PAGE OBJECT REFERENCE
 * (uePmState.selectedForExtract) — so it survives reorder/delete without any
 * index remapping. When ≥1 page is selected, the context bar swaps from the
 * reorder hint to a bulk-action bar.
 */

import { ueState, uePmState, mutatePages } from '../lib/state.js';
import { emit } from '../lib/events.js';
import { showToast, showFullscreenLoading, hideFullscreenLoading, downloadBlob, getDownloadFilename } from '../lib/utils.js';
import { openModal, closeModal } from '../lib/navigation.js';
import { ueRenderSelectedPage, ueCreatePageSlots } from './page-rendering.js';
import { drawRotatedThumbnail } from './canvas-utils.js';
import { ueAddFiles } from './file-loading.js';
import { ueSaveUndoState } from './undo-redo.js';
import { track } from '../lib/analytics.js';

// ============================================================
// OPEN / CLOSE
// ============================================================

export function uePmOpenModal() {
  if (ueState.pages.length === 0) {
    showToast('Tambahkan halaman terlebih dahulu', 'error');
    return;
  }

  uePmState.isOpen = true;
  uePmState.selectedForExtract = [];
  // WHY name kept: 'gabungkan_used' preserves analytics history even though the
  // surface is now "Kelola Halaman". Migrate deliberately, not by accident.
  track('gabungkan_used', { pageCount: ueState.pages.length });

  // WHY disconnect: pageCanvases indices go stale after reorder/delete in the
  // modal; the observer would render wrong pages. Reconnected via
  // ueCreatePageSlots() in uePmCloseModal.
  if (ueState.pageObserver) ueState.pageObserver.disconnect();

  uePmRenderPages();
  openModal('ue-gabungkan-modal');

  initUePmFileInput();
  initUePmImageInput();
}

export function uePmCloseModal(skipHistoryBack = false) {
  uePmState.isOpen = false;
  uePmState.selectedForExtract = [];
  if (uePmState.dropIndicator?.parentNode) uePmState.dropIndicator.remove();

  closeModal('ue-gabungkan-modal', skipHistoryBack);

  // WHY rAF: defer the heavy slot rebuild until the close transition is done,
  // otherwise ueCreatePageSlots layout-thrashes mid-animation.
  requestAnimationFrame(() => {
    ueCreatePageSlots();
    emit('pages:changed', { source: 'user' });
    if (ueState.selectedPage >= 0) ueRenderSelectedPage();
  });
}

// ============================================================
// RENDER
// ============================================================

function uePmUpdatePageCount() {
  const el = document.getElementById('ue-pm-page-count');
  if (el) el.textContent = ueState.pages.length + ' halaman';
}

const isSelected = (page) => uePmState.selectedForExtract.includes(page);

// Build the thumbnail canvas for a tile (thumbCanvas — pageCanvases is stale
// while the modal is open because the observer is disconnected).
function buildTileThumb(page) {
  const src = page.thumbCanvas || null;
  if (src && page.rotation !== 0) return drawRotatedThumbnail(src, page.rotation);
  const canvas = document.createElement('canvas');
  canvas.width = src ? src.width : page.canvas.width;
  canvas.height = src ? src.height : page.canvas.height;
  if (src) canvas.getContext('2d').drawImage(src, 0, 0);
  return canvas;
}

const ICON = {
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>',
  rotate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.85.83 6.72 2.24"/><path d="M21 3v6h-6"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>',
};

function buildPageTile(page, index) {
  const item = document.createElement('div');
  item.className = 'ue-pm-page-item' + (isSelected(page) ? ' selected' : '');
  item.dataset.index = index;
  item.draggable = true;

  item.appendChild(buildTileThumb(page));

  // Checkbox — always visible, select by reference.
  const checkbox = document.createElement('button');
  checkbox.type = 'button';
  checkbox.className = 'ue-pm-page-checkbox';
  checkbox.setAttribute('aria-label', 'Pilih halaman ' + (index + 1));
  checkbox.setAttribute('aria-pressed', isSelected(page) ? 'true' : 'false');
  checkbox.innerHTML = ICON.check;
  checkbox.onclick = (e) => { e.stopPropagation(); uePmTogglePageSelection(page); };
  item.appendChild(checkbox);

  // Actions — always visible (NOT hover-only), ≥44px touch targets.
  const actions = document.createElement('div');
  actions.className = 'ue-pm-page-actions';

  const rotateBtn = document.createElement('button');
  rotateBtn.type = 'button';
  rotateBtn.className = 'ue-pm-page-action-btn';
  rotateBtn.title = 'Putar 90°';
  rotateBtn.setAttribute('aria-label', 'Putar halaman ' + (index + 1));
  rotateBtn.innerHTML = ICON.rotate;
  rotateBtn.onclick = (e) => { e.stopPropagation(); uePmRotatePage(index); };
  actions.appendChild(rotateBtn);

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'ue-pm-page-action-btn delete';
  deleteBtn.title = 'Hapus';
  deleteBtn.setAttribute('aria-label', 'Hapus halaman ' + (index + 1));
  deleteBtn.innerHTML = ICON.trash;
  deleteBtn.onclick = (e) => { e.stopPropagation(); uePmDeletePage(index); };
  actions.appendChild(deleteBtn);

  item.appendChild(actions);

  const numBadge = document.createElement('span');
  numBadge.className = 'ue-pm-page-number';
  numBadge.textContent = index + 1;
  item.appendChild(numBadge);

  if (ueState.sourceFiles.length > 1) {
    const srcBadge = document.createElement('span');
    srcBadge.className = 'ue-pm-source-badge';
    srcBadge.textContent = page.sourceName;
    item.appendChild(srcBadge);
  }

  if (page.rotation !== 0) {
    const rotBadge = document.createElement('span');
    rotBadge.className = 'ue-pm-rotation-badge';
    rotBadge.textContent = page.rotation + '°';
    item.appendChild(rotBadge);
  }

  return item;
}

// A dashed "＋ PDF" / "＋ Gambar" tile at the end of the grid.
function buildAddTile(kind) {
  const label = kind === 'pdf' ? 'PDF' : 'Gambar';
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'ue-pm-add-tile';
  tile.setAttribute('aria-label', 'Tambah ' + label);
  tile.innerHTML = `<span class="ue-pm-add-icon">${ICON.plus}</span><span class="ue-pm-add-label">${label}</span>`;
  tile.onclick = () => {
    const inputId = kind === 'pdf' ? 'ue-pm-file-input' : 'ue-pm-image-input';
    document.getElementById(inputId).click();
  };
  return tile;
}

export function uePmRenderPages() {
  const container = document.getElementById('ue-pm-pages');
  container.innerHTML = '';

  // Drop selection refs whose page no longer exists (after delete).
  uePmState.selectedForExtract = uePmState.selectedForExtract.filter(p => ueState.pages.includes(p));

  ueState.pages.forEach((page, index) => container.appendChild(buildPageTile(page, index)));
  container.appendChild(buildAddTile('pdf'));
  container.appendChild(buildAddTile('image'));

  uePmEnableDragReorder();
  uePmUpdatePageCount();
  uePmUpdateSelectionUI();
}

// ============================================================
// SELECTION + BULK ACTIONS
// ============================================================

function uePmUpdateSelectionUI() {
  const count = uePmState.selectedForExtract.length;
  const hint = document.getElementById('ue-pm-hint');
  const actions = document.getElementById('ue-pm-selection-actions');
  const countEl = document.getElementById('ue-pm-selection-count');
  if (countEl) countEl.textContent = count + ' dipilih';
  if (hint) hint.hidden = count > 0;
  if (actions) actions.hidden = count === 0;
}

export function uePmTogglePageSelection(page) {
  const i = uePmState.selectedForExtract.indexOf(page);
  if (i === -1) uePmState.selectedForExtract.push(page);
  else uePmState.selectedForExtract.splice(i, 1);

  const idx = ueState.pages.indexOf(page);
  const item = document.querySelector(`.ue-pm-page-item[data-index="${idx}"]`);
  if (item) {
    const on = isSelected(page);
    item.classList.toggle('selected', on);
    item.querySelector('.ue-pm-page-checkbox')?.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  uePmUpdateSelectionUI();
}

export function uePmSelectAll() {
  uePmState.selectedForExtract = [...ueState.pages];
  uePmRenderPages();
}

export function uePmDeselectAll() {
  uePmState.selectedForExtract = [];
  uePmRenderPages();
}

export function uePmRotateSelected() {
  const sel = uePmState.selectedForExtract;
  if (sel.length === 0) return;
  ueSaveUndoState();
  track('editor_action', { action: 'rotate' });
  sel.forEach(page => { page.rotation = ((page.rotation + 90) % 360 + 360) % 360; });
  uePmRenderPages();
  showToast(`${sel.length} halaman diputar`, 'success');
}

export function uePmDeleteSelected() {
  const sel = uePmState.selectedForExtract;
  if (sel.length === 0) return;
  if (sel.length >= ueState.pages.length) {
    showToast('Tidak bisa menghapus semua halaman', 'error');
    return;
  }
  if (!confirm(`Hapus ${sel.length} halaman terpilih?`)) return;

  ueSaveUndoState();
  track('editor_action', { action: 'delete_page' });
  const toRemove = new Set(sel);
  // mutatePages re-keys annotations/pageCaches/pageScales/selection atomically.
  mutatePages(() => {
    ueState.pages = ueState.pages.filter(p => !toRemove.has(p));
  });
  uePmState.selectedForExtract = [];
  emit('pages:changed', { source: 'user' });
  uePmRenderPages();
  showToast(`${toRemove.size} halaman dihapus`, 'success');
}

export async function uePmExtractSelected() {
  const sel = uePmState.selectedForExtract;
  if (sel.length === 0) {
    showToast('Pilih halaman yang ingin di-split', 'error');
    return;
  }

  // Keep the current page order for the new document.
  const ordered = ueState.pages.filter(p => sel.includes(p));

  try {
    const newDoc = await PDFLib.PDFDocument.create();
    for (const pageData of ordered) {
      const sourceFile = ueState.sourceFiles[pageData.sourceIndex];
      const srcDoc = await PDFLib.PDFDocument.load(sourceFile.bytes);
      const [pg] = await newDoc.copyPages(srcDoc, [pageData.pageNum]);
      if (pageData.rotation !== 0) pg.setRotation(PDFLib.degrees(pageData.rotation));
      newDoc.addPage(pg);
    }

    const bytes = await newDoc.save();
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), getDownloadFilename({ originalName: ueState.sourceFiles[0]?.name, extension: 'pdf' }));
    track('editor_action', { action: 'split' });
    showToast(`${ordered.length} halaman berhasil di-split!`, 'success');
    uePmDeselectAll();
  } catch (error) {
    console.error('Error splitting pages:', error);
    showToast('Gagal split halaman', 'error');
  }
}

// ============================================================
// PER-PAGE ROTATE / DELETE
// ============================================================

function uePmRotatePage(index) {
  ueSaveUndoState();
  track('editor_action', { action: 'rotate' });
  const page = ueState.pages[index];
  page.rotation = ((page.rotation + 90) % 360 + 360) % 360;
  uePmRenderPages();
  showToast('Halaman diputar', 'success');
}

function uePmDeletePage(index) {
  if (ueState.pages.length <= 1) {
    showToast('Tidak bisa menghapus halaman terakhir', 'error');
    return;
  }
  if (!confirm('Hapus halaman ini?')) return;

  ueSaveUndoState();
  track('editor_action', { action: 'delete_page' });
  mutatePages(() => {
    ueState.pages.splice(index, 1);
  });
  emit('pages:changed', { source: 'user' });
  uePmRenderPages();
  showToast('Halaman dihapus', 'success');
}

// ============================================================
// REORDER (drag-and-drop) — SSOT ueReorderPages
// ============================================================

// SINGLE SOURCE OF TRUTH — reorder atomically via mutatePages (re-keys
// annotations, pageCaches, pageScales, selectedPage, selectedAnnotation).
// WHY centralized: sidebar drag-drop and modal drop both funnel here.
export function ueReorderPages(fromIndex, insertAt) {
  mutatePages(() => {
    const [movedPage] = ueState.pages.splice(fromIndex, 1);
    if (fromIndex < insertAt) insertAt--;
    ueState.pages.splice(insertAt, 0, movedPage);
  });
  track('editor_action', { action: 'reorder' });
  emit('pages:changed', { source: 'user' });
}

function uePmGetDropIndicator() {
  if (!uePmState.dropIndicator) {
    uePmState.dropIndicator = document.createElement('div');
    uePmState.dropIndicator.className = 'ue-pm-drop-indicator';
  }
  return uePmState.dropIndicator;
}

function uePmRemoveDropIndicator() {
  if (uePmState.dropIndicator?.parentNode) uePmState.dropIndicator.remove();
}

function uePmEnableDragReorder() {
  const container = document.getElementById('ue-pm-pages');
  let draggedItem = null;
  let draggedIndex = -1;

  container.querySelectorAll('.ue-pm-page-item').forEach((item) => {
    item.addEventListener('dragstart', (e) => {
      // WHY: don't start a reorder when the press began on a control (checkbox,
      // rotate, delete) — those are clicks, not drags.
      if (e.target.closest('.ue-pm-page-checkbox, .ue-pm-page-action-btn')) {
        e.preventDefault();
        return;
      }
      ueSaveUndoState();
      draggedItem = item;
      draggedIndex = Number.parseInt(item.dataset.index);
      uePmState.draggedIndex = draggedIndex;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', draggedIndex);
    });

    item.addEventListener('dragend', () => {
      if (draggedItem) {
        draggedItem.classList.remove('dragging');
        draggedItem = null;
      }
      uePmState.draggedIndex = -1;
      uePmRemoveDropIndicator();
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (!draggedItem || item === draggedItem) return;
      const rect = item.getBoundingClientRect();
      const midpoint = rect.left + rect.width / 2;
      const indicator = uePmGetDropIndicator();
      if (e.clientX < midpoint) item.before(indicator);
      else item.after(indicator);
    });

    item.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!draggedItem) return;
      const targetIndex = Number.parseInt(item.dataset.index);
      const rect = item.getBoundingClientRect();
      const midpoint = rect.left + rect.width / 2;
      const insertAt = e.clientX < midpoint ? targetIndex : targetIndex + 1;
      ueReorderPages(draggedIndex, insertAt);
      uePmRenderPages();
      uePmRemoveDropIndicator();
    });
  });

  // Container-level dragover: place indicator at the ends of the row.
  container.addEventListener('dragover', (e) => {
    if (!draggedItem) return;
    e.preventDefault();
    const items = container.querySelectorAll('.ue-pm-page-item:not(.dragging)');
    if (items.length === 0) return;
    const indicator = uePmGetDropIndicator();
    const firstRect = items[0].getBoundingClientRect();
    const lastRect = items[items.length - 1].getBoundingClientRect();
    if (e.clientX < firstRect.left) items[0].before(indicator);
    else if (e.clientX > lastRect.right) items[items.length - 1].after(indicator);
  });

  container.addEventListener('drop', (e) => {
    if (!draggedItem) return;
    e.preventDefault();
    const indicator = uePmState.dropIndicator;
    if (!indicator?.parentNode) { uePmRemoveDropIndicator(); return; }
    const items = Array.from(container.querySelectorAll('.ue-pm-page-item'));
    const nextSibling = indicator.nextElementSibling;
    const insertAt = (nextSibling?.classList.contains('ue-pm-page-item'))
      ? Number.parseInt(nextSibling.dataset.index)
      : items.length;
    ueReorderPages(draggedIndex, insertAt);
    uePmRenderPages();
    uePmRemoveDropIndicator();
  });
}

// ============================================================
// ADD PAGES (PDF / IMAGE)
// ============================================================

function initUePmFileInput() {
  wireAddInput('ue-pm-file-input', 'Menambahkan PDF...', 'Gagal menambahkan PDF');
}

function initUePmImageInput() {
  wireAddInput('ue-pm-image-input', 'Menambahkan gambar...', 'Gagal menambahkan gambar');
}

function wireAddInput(inputId, loadingMsg, errorMsg) {
  const input = document.getElementById(inputId);
  if (!input || input._uePmInitialized) return;
  input._uePmInitialized = true;
  input.addEventListener('change', async (e) => {
    if (e.target.files.length === 0) return;
    showFullscreenLoading(loadingMsg);
    try {
      await ueAddFiles(e.target.files);
      if (uePmState.isOpen) uePmRenderPages();
    } catch (error) {
      console.error(errorMsg + ':', error);
      showToast(errorMsg, 'error');
    } finally {
      hideFullscreenLoading();
      e.target.value = '';
    }
  });
}
