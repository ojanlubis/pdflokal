/*
 * PDFLokal - editor/page-manager.js (ES Module)
 * Gabungkan (page manager) modal: drag-drop reorder, rotate, delete, split/extract
 */

import { ueState, uePmState, navHistory } from '../lib/state.js';
import { showToast, showFullscreenLoading, hideFullscreenLoading, downloadBlob, getDownloadFilename } from '../lib/utils.js';
import { pushModalState } from '../lib/navigation.js';
import { ueRenderThumbnails } from './sidebar.js';
import { ueUpdatePageCount, ueRenderSelectedPage } from './page-rendering.js';
import { ueAddFiles } from './file-loading.js';
import { ueSaveUndoState } from './undo-redo.js';

// Open the page manager modal
export function uePmOpenModal() {
  if (ueState.pages.length === 0) {
    showToast('Tambahkan halaman terlebih dahulu', 'error');
    return;
  }

  uePmState.isOpen = true;
  uePmState.extractMode = false;
  uePmState.selectedForExtract = [];

  uePmRenderPages();
  uePmUpdateUI();

  document.getElementById('ue-gabungkan-modal').classList.add('active');
  pushModalState('ue-gabungkan-modal');

  initUePmFileInput();
  initUePmImageInput();
}

// Close the page manager modal
export function uePmCloseModal(skipHistoryBack = false) {
  uePmState.isOpen = false;
  document.getElementById('ue-gabungkan-modal').classList.remove('active');

  if (uePmState.dropIndicator && uePmState.dropIndicator.parentNode) {
    uePmState.dropIndicator.remove();
  }

  document.getElementById('ue-pm-extract-mode-btn').classList.remove('active');
  document.getElementById('ue-pm-extract-actions').style.display = 'none';
  document.getElementById('ue-pm-extract-btn').style.display = 'none';

  navHistory.currentModal = null;
  if (!skipHistoryBack && navHistory.currentView === 'modal') {
    history.back();
  }

  // Heavy rendering after modal visually closes (defer to next frame)
  requestAnimationFrame(() => {
    ueRenderThumbnails();
    ueUpdatePageCount();
    if (ueState.selectedPage >= 0) {
      ueRenderSelectedPage();
    }
  });
}

function uePmUpdateUI() {
  document.getElementById('ue-pm-page-count').textContent = ueState.pages.length + ' halaman';
}

// Render all pages in the modal grid
export function uePmRenderPages() {
  const container = document.getElementById('ue-pm-pages');
  container.innerHTML = '';

  if (uePmState.extractMode) {
    container.classList.add('extract-mode');
  } else {
    container.classList.remove('extract-mode');
  }

  ueState.pages.forEach((page, index) => {
    const item = document.createElement('div');
    item.className = 'ue-pm-page-item';
    item.dataset.index = index;
    item.draggable = !uePmState.extractMode;

    if (uePmState.selectedForExtract.includes(index)) {
      item.classList.add('selected');
    }

    const canvas = document.createElement('canvas');
    canvas.width = page.canvas.width;
    canvas.height = page.canvas.height;
    canvas.getContext('2d').drawImage(page.canvas, 0, 0);
    if (page.rotation !== 0) {
      canvas.style.transform = `rotate(${page.rotation}deg)`;
    }
    item.appendChild(canvas);

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

    const actions = document.createElement('div');
    actions.className = 'ue-pm-page-actions';

    const rotateBtn = document.createElement('button');
    rotateBtn.className = 'ue-pm-page-action-btn';
    rotateBtn.title = 'Putar 90°';
    rotateBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.85.83 6.72 2.24"/><path d="M21 3v6h-6"/></svg>';
    rotateBtn.onclick = (e) => {
      e.stopPropagation();
      uePmRotatePage(index, 90);
    };
    actions.appendChild(rotateBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'ue-pm-page-action-btn delete';
    deleteBtn.title = 'Hapus';
    deleteBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
    deleteBtn.onclick = (e) => {
      e.stopPropagation();
      uePmDeletePage(index);
    };
    actions.appendChild(deleteBtn);

    item.appendChild(actions);

    const checkbox = document.createElement('div');
    checkbox.className = 'ue-pm-page-checkbox';
    checkbox.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
    item.appendChild(checkbox);

    item.onclick = () => {
      if (uePmState.extractMode) {
        uePmTogglePageSelection(index);
      }
    };

    container.appendChild(item);
  });

  if (!uePmState.extractMode) {
    uePmEnableDragReorder();
  }

  uePmUpdateUI();
}

// Enable drag-drop reordering in page manager
function uePmEnableDragReorder() {
  const container = document.getElementById('ue-pm-pages');
  let draggedItem = null;
  let draggedIndex = -1;

  function getDropIndicator() {
    if (!uePmState.dropIndicator) {
      uePmState.dropIndicator = document.createElement('div');
      uePmState.dropIndicator.className = 'ue-pm-drop-indicator';
    }
    return uePmState.dropIndicator;
  }

  function removeDropIndicator() {
    if (uePmState.dropIndicator && uePmState.dropIndicator.parentNode) {
      uePmState.dropIndicator.remove();
    }
  }

  container.querySelectorAll('.ue-pm-page-item').forEach((item) => {
    item.addEventListener('dragstart', (e) => {
      if (uePmState.extractMode) {
        e.preventDefault();
        return;
      }
      ueSaveUndoState();
      draggedItem = item;
      draggedIndex = parseInt(item.dataset.index);
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
      removeDropIndicator();
    });

    item.addEventListener('dragover', (e) => {
      if (uePmState.extractMode) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (!draggedItem || item === draggedItem) return;

      const rect = item.getBoundingClientRect();
      const midpoint = rect.left + rect.width / 2;
      const indicator = getDropIndicator();

      if (e.clientX < midpoint) {
        item.before(indicator);
      } else {
        item.after(indicator);
      }
    });

    item.addEventListener('dragleave', () => {
      // Keep indicator visible during drag
    });

    item.addEventListener('drop', (e) => {
      if (uePmState.extractMode) return;
      e.preventDefault();
      e.stopPropagation();
      if (!draggedItem) return;

      const targetIndex = parseInt(item.dataset.index);
      const rect = item.getBoundingClientRect();
      const midpoint = rect.left + rect.width / 2;
      const insertBefore = e.clientX < midpoint;

      const viewedPage = ueState.pages[ueState.selectedPage];
      let insertAt = insertBefore ? targetIndex : targetIndex + 1;

      const [movedPage] = ueState.pages.splice(draggedIndex, 1);

      if (draggedIndex < insertAt) {
        insertAt--;
      }

      ueState.pages.splice(insertAt, 0, movedPage);
      uePmReindexAnnotations(draggedIndex, insertAt);

      const newViewedIndex = ueState.pages.indexOf(viewedPage);
      if (newViewedIndex !== -1) {
        ueState.selectedPage = newViewedIndex;
      }

      uePmRenderPages();
      removeDropIndicator();
    });
  });

  // Handle container-level dragover
  container.addEventListener('dragover', (e) => {
    if (uePmState.extractMode || !draggedItem) return;
    e.preventDefault();

    const items = container.querySelectorAll('.ue-pm-page-item:not(.dragging)');
    if (items.length === 0) return;

    const indicator = getDropIndicator();
    const firstItem = items[0];
    const lastItem = items[items.length - 1];
    const firstRect = firstItem.getBoundingClientRect();
    const lastRect = lastItem.getBoundingClientRect();

    if (e.clientX < firstRect.left) {
      firstItem.before(indicator);
    } else if (e.clientX > lastRect.right) {
      lastItem.after(indicator);
    }
  });

  // Handle container-level drop
  container.addEventListener('drop', (e) => {
    if (uePmState.extractMode || !draggedItem) return;
    e.preventDefault();

    const indicator = uePmState.dropIndicator;
    if (!indicator || !indicator.parentNode) {
      removeDropIndicator();
      return;
    }

    const items = Array.from(container.querySelectorAll('.ue-pm-page-item'));
    let insertAt = 0;

    const nextSibling = indicator.nextElementSibling;
    if (nextSibling && nextSibling.classList.contains('ue-pm-page-item')) {
      insertAt = parseInt(nextSibling.dataset.index);
    } else {
      insertAt = items.length;
    }

    const viewedPage = ueState.pages[ueState.selectedPage];

    const [movedPage] = ueState.pages.splice(draggedIndex, 1);

    if (draggedIndex < insertAt) {
      insertAt--;
    }

    ueState.pages.splice(insertAt, 0, movedPage);
    uePmReindexAnnotations(draggedIndex, insertAt);

    const newViewedIndex = ueState.pages.indexOf(viewedPage);
    if (newViewedIndex !== -1) {
      ueState.selectedPage = newViewedIndex;
    }

    uePmRenderPages();
    removeDropIndicator();
  });
}

// Reindex annotations after page reorder
export function uePmReindexAnnotations(fromIndex, toIndex) {
  const oldAnnotations = { ...ueState.annotations };
  ueState.annotations = {};

  const indexMap = {};
  for (let i = 0; i < ueState.pages.length; i++) {
    indexMap[i] = i;
  }

  if (fromIndex < toIndex) {
    for (let i = fromIndex; i < toIndex; i++) {
      indexMap[i + 1] = i;
    }
    indexMap[fromIndex] = toIndex;
  } else {
    for (let i = toIndex + 1; i <= fromIndex; i++) {
      indexMap[i - 1] = i;
    }
    indexMap[fromIndex] = toIndex;
  }

  Object.keys(oldAnnotations).forEach(key => {
    const oldIdx = parseInt(key);
    let newIdx = oldIdx;
    if (oldIdx === fromIndex) {
      newIdx = toIndex;
    } else if (fromIndex < toIndex && oldIdx > fromIndex && oldIdx <= toIndex) {
      newIdx = oldIdx - 1;
    } else if (fromIndex > toIndex && oldIdx >= toIndex && oldIdx < fromIndex) {
      newIdx = oldIdx + 1;
    }
    ueState.annotations[newIdx] = oldAnnotations[key];
  });
}

// Rotate a page in the modal
function uePmRotatePage(index, degrees) {
  ueSaveUndoState();

  const page = ueState.pages[index];
  page.rotation = ((page.rotation + degrees) % 360 + 360) % 360;

  const item = document.querySelector(`.ue-pm-page-item[data-index="${index}"]`);
  if (item) {
    const canvas = item.querySelector('canvas');
    if (canvas) {
      canvas.style.transform = page.rotation !== 0 ? `rotate(${page.rotation}deg)` : '';
    }

    let rotBadge = item.querySelector('.ue-pm-rotation-badge');
    if (page.rotation !== 0) {
      if (!rotBadge) {
        rotBadge = document.createElement('span');
        rotBadge.className = 'ue-pm-rotation-badge';
        const actions = item.querySelector('.ue-pm-page-actions');
        if (actions) {
          item.insertBefore(rotBadge, actions);
        } else {
          item.appendChild(rotBadge);
        }
      }
      rotBadge.textContent = page.rotation + '°';
    } else if (rotBadge) {
      rotBadge.remove();
    }
  }

  showToast('Halaman diputar', 'success');
}

// Delete a page in the modal
function uePmDeletePage(index) {
  if (ueState.pages.length <= 1) {
    showToast('Tidak bisa menghapus halaman terakhir', 'error');
    return;
  }

  if (!confirm('Hapus halaman ini?')) {
    return;
  }

  ueSaveUndoState();

  const wasViewingDeletedPage = (ueState.selectedPage === index);
  const viewedPage = ueState.pages[ueState.selectedPage];

  ueState.pages.splice(index, 1);
  delete ueState.annotations[index];

  const newAnnotations = {};
  Object.keys(ueState.annotations).forEach(key => {
    const idx = parseInt(key);
    if (idx > index) {
      newAnnotations[idx - 1] = ueState.annotations[idx];
    } else {
      newAnnotations[idx] = ueState.annotations[idx];
    }
  });
  ueState.annotations = newAnnotations;

  if (wasViewingDeletedPage) {
    ueState.selectedPage = Math.min(index, ueState.pages.length - 1);
  } else {
    const newViewedIndex = ueState.pages.indexOf(viewedPage);
    if (newViewedIndex !== -1) {
      ueState.selectedPage = newViewedIndex;
    } else {
      ueState.selectedPage = Math.max(0, ueState.selectedPage - 1);
    }
  }

  uePmState.selectedForExtract = uePmState.selectedForExtract
    .filter(i => i !== index)
    .map(i => i > index ? i - 1 : i);

  uePmRenderPages();
  uePmUpdateSelectionCount();

  showToast('Halaman dihapus', 'success');
}

// Toggle extract mode
export function uePmToggleExtractMode() {
  uePmState.extractMode = !uePmState.extractMode;
  uePmState.selectedForExtract = [];

  const btn = document.getElementById('ue-pm-extract-mode-btn');
  const extractActions = document.getElementById('ue-pm-extract-actions');
  const extractBtn = document.getElementById('ue-pm-extract-btn');

  if (uePmState.extractMode) {
    btn.classList.add('active');
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg> Batal Split';
    extractActions.style.display = 'flex';
    extractBtn.style.display = 'inline-flex';
  } else {
    btn.classList.remove('active');
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v18"/><path d="M8 8H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h4"/><path d="M16 8h4a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-4"/><path d="M9 12H5"/><path d="M7 10l-2 2 2 2"/><path d="M15 12h4"/><path d="M17 10l2 2-2 2"/></svg> Split PDF';
    extractActions.style.display = 'none';
    extractBtn.style.display = 'none';
  }

  uePmRenderPages();
  uePmUpdateSelectionCount();
}

export function uePmTogglePageSelection(index) {
  const idx = uePmState.selectedForExtract.indexOf(index);
  if (idx === -1) {
    uePmState.selectedForExtract.push(index);
  } else {
    uePmState.selectedForExtract.splice(idx, 1);
  }

  const item = document.querySelector(`.ue-pm-page-item[data-index="${index}"]`);
  if (item) {
    item.classList.toggle('selected', uePmState.selectedForExtract.includes(index));
  }

  uePmUpdateSelectionCount();
}

export function uePmSelectAll() {
  uePmState.selectedForExtract = ueState.pages.map((_, i) => i);
  document.querySelectorAll('.ue-pm-page-item').forEach(item => {
    item.classList.add('selected');
  });
  uePmUpdateSelectionCount();
}

export function uePmDeselectAll() {
  uePmState.selectedForExtract = [];
  document.querySelectorAll('.ue-pm-page-item').forEach(item => {
    item.classList.remove('selected');
  });
  uePmUpdateSelectionCount();
}

function uePmUpdateSelectionCount() {
  const count = uePmState.selectedForExtract.length;
  document.getElementById('ue-pm-selection-count').textContent = count + ' halaman dipilih';

  const extractBtn = document.getElementById('ue-pm-extract-btn');
  extractBtn.disabled = count === 0;
  extractBtn.textContent = count > 0
    ? `Split ${count} halaman sebagai PDF baru`
    : 'Split sebagai PDF baru';
}

export async function uePmExtractSelected() {
  if (uePmState.selectedForExtract.length === 0) {
    showToast('Pilih halaman yang ingin di-split', 'error');
    return;
  }

  try {
    const sortedIndices = [...uePmState.selectedForExtract].sort((a, b) => a - b);

    const newDoc = await PDFLib.PDFDocument.create();

    for (const index of sortedIndices) {
      const pageData = ueState.pages[index];
      const sourceFile = ueState.sourceFiles[pageData.sourceIndex];
      const srcDoc = await PDFLib.PDFDocument.load(sourceFile.bytes);
      const [page] = await newDoc.copyPages(srcDoc, [pageData.pageNum]);

      if (pageData.rotation !== 0) {
        page.setRotation(PDFLib.degrees(pageData.rotation));
      }

      newDoc.addPage(page);
    }

    const bytes = await newDoc.save();
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), getDownloadFilename({ originalName: ueState.sourceFiles[0]?.name, extension: 'pdf' }));

    showToast(`${sortedIndices.length} halaman berhasil di-split!`, 'success');

    uePmToggleExtractMode();

  } catch (error) {
    console.error('Error splitting pages:', error);
    showToast('Gagal split halaman', 'error');
  }
}

// File input handlers for adding pages from modal
function initUePmFileInput() {
  const input = document.getElementById('ue-pm-file-input');
  if (input && !input._uePmInitialized) {
    input._uePmInitialized = true;
    input.addEventListener('change', async (e) => {
      if (e.target.files.length > 0) {
        showFullscreenLoading('Menambahkan PDF...');
        try {
          await ueAddFiles(e.target.files);
          if (uePmState.isOpen) {
            uePmRenderPages();
          }
        } catch (error) {
          console.error('Error adding PDF:', error);
          showToast('Gagal menambahkan PDF', 'error');
        } finally {
          hideFullscreenLoading();
          e.target.value = '';
        }
      }
    });
  }
}

function initUePmImageInput() {
  const input = document.getElementById('ue-pm-image-input');
  if (input && !input._uePmInitialized) {
    input._uePmInitialized = true;
    input.addEventListener('change', async (e) => {
      if (e.target.files.length > 0) {
        showFullscreenLoading('Menambahkan gambar...');
        try {
          await ueAddFiles(e.target.files);
          if (uePmState.isOpen) {
            uePmRenderPages();
          }
        } catch (error) {
          console.error('Error adding images:', error);
          showToast('Gagal menambahkan gambar', 'error');
        } finally {
          hideFullscreenLoading();
          e.target.value = '';
        }
      }
    });
  }
}
