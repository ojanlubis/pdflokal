/*
 * PDFLokal - editor/sidebar.js (ES Module)
 * Sidebar file dropdown, thumbnails, and drag-drop reordering
 */

import { ueState } from '../lib/state.js';
import { getThumbnailSource } from './canvas-utils.js';
import { showToast, showFullscreenLoading, hideFullscreenLoading } from '../lib/utils.js';

// ============================================================
// FILE OPERATIONS
// ============================================================

// Replace all files: reset editor, then open file picker
export function ueReplaceFiles() {
  let input = document.getElementById('ue-replace-input');
  if (!input) return;

  // One-shot handler so it doesn't stack
  const handler = async (e) => {
    input.removeEventListener('change', handler);
    const filesArray = Array.from(e.target.files);
    if (filesArray.length === 0) return;
    input.value = ''; // Reset AFTER converting to array (FileList is a live collection)

    // Reset editor then load new files
    window.ueReset();
    showFullscreenLoading('Memuat file...');
    try {
      await window.ueAddFiles(filesArray);
    } catch (err) {
      console.error('Error replacing files:', err);
      showToast('Gagal memuat file', 'error');
    } finally {
      hideFullscreenLoading();
    }
  };
  input.addEventListener('change', handler);
  input.click();
}

// Editor header file dropdown
export function toggleEditorFileMenu(e) {
  e.stopPropagation();
  const dropdown = document.getElementById('editor-file-dropdown');
  if (dropdown) dropdown.classList.toggle('open');
}

export function closeEditorFileMenu() {
  const dropdown = document.getElementById('editor-file-dropdown');
  if (dropdown) dropdown.classList.remove('open');
}

// Close file menus when clicking outside
document.addEventListener('click', (e) => {
  // Sidebar file dropdown
  const sidebarDropdown = document.querySelector('.unified-sidebar .sidebar-file-dropdown');
  if (sidebarDropdown && sidebarDropdown.classList.contains('open') && !sidebarDropdown.contains(e.target)) {
    sidebarDropdown.classList.remove('open');
  }
  // Editor header file dropdown
  const editorDropdown = document.getElementById('editor-file-dropdown');
  if (editorDropdown && editorDropdown.classList.contains('open') && !editorDropdown.contains(e.target)) {
    editorDropdown.classList.remove('open');
  }
});

// Render sidebar thumbnails
export function ueRenderThumbnails() {
  const container = document.getElementById('ue-thumbnails');
  container.innerHTML = '';

  if (ueState.pages.length === 0) {
    container.innerHTML = `
      <div class="drop-hint" onclick="document.getElementById('ue-file-input').click()">
        <svg class="drop-hint-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 24px; height: 24px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        <span class="drop-hint-text" style="font-size: 0.75rem;">Upload PDF</span>
      </div>
    `;
    return;
  }

  ueState.pages.forEach((page, index) => {
    const item = document.createElement('div');
    const sourceCanvas = getThumbnailSource(index);
    const canvasWidth = sourceCanvas ? sourceCanvas.width : page.canvas.width;
    const canvasHeight = sourceCanvas ? sourceCanvas.height : page.canvas.height;
    const isLandscape = canvasWidth > canvasHeight;
    item.className = 'ue-thumbnail' + (index === ueState.selectedPage ? ' selected' : '') + (isLandscape ? ' landscape' : ' portrait');
    item.draggable = true;
    item.dataset.index = index;
    // Use window.* to avoid circular import with page-rendering
    item.onclick = () => window.ueSelectPage(index);

    // Clone the thumbnail canvas
    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = sourceCanvas ? sourceCanvas.width : canvasWidth;
    thumbCanvas.height = sourceCanvas ? sourceCanvas.height : canvasHeight;
    if (sourceCanvas) {
      thumbCanvas.getContext('2d').drawImage(sourceCanvas, 0, 0);
    }
    if (page.rotation && page.rotation !== 0) {
      thumbCanvas.style.transform = `rotate(${page.rotation}deg)`;
    }
    item.appendChild(thumbCanvas);

    // Page number badge
    const numBadge = document.createElement('span');
    numBadge.className = 'ue-thumbnail-number';
    numBadge.textContent = index + 1;
    item.appendChild(numBadge);

    // Source file badge (if multiple sources)
    if (ueState.sourceFiles.length > 1) {
      const srcBadge = document.createElement('span');
      srcBadge.className = 'ue-thumbnail-source';
      srcBadge.textContent = page.sourceName;
      item.appendChild(srcBadge);
    }

    // Delete button (use window.* to avoid circular import)
    const delBtn = document.createElement('button');
    delBtn.className = 'ue-thumbnail-delete';
    delBtn.innerHTML = '&times;';
    delBtn.onclick = (e) => {
      e.stopPropagation();
      window.ueDeletePage(index);
    };
    item.appendChild(delBtn);

    container.appendChild(item);
  });

  // Setup drag-drop reordering
  ueSetupSidebarDragDrop();
}

// Setup sidebar drag-drop reordering
function ueSetupSidebarDragDrop() {
  const container = document.getElementById('ue-thumbnails');
  if (!container || container._sidebarDragSetup) return;
  container._sidebarDragSetup = true;

  let draggedItem = null;
  let draggedIndex = -1;

  function getDropIndicator() {
    if (!ueState.sidebarDropIndicator) {
      ueState.sidebarDropIndicator = document.createElement('div');
      ueState.sidebarDropIndicator.className = 'ue-sidebar-drop-indicator';
    }
    return ueState.sidebarDropIndicator;
  }

  function removeDropIndicator() {
    if (ueState.sidebarDropIndicator && ueState.sidebarDropIndicator.parentNode) {
      ueState.sidebarDropIndicator.remove();
    }
  }

  container.addEventListener('dragstart', (e) => {
    const item = e.target.closest('.ue-thumbnail');
    if (!item) return;

    // Use window.* to avoid circular import with undo-redo
    window.ueSaveUndoState();
    draggedItem = item;
    draggedIndex = parseInt(item.dataset.index);
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', draggedIndex);
  });

  container.addEventListener('dragend', (e) => {
    const item = e.target.closest('.ue-thumbnail');
    if (item) {
      item.classList.remove('dragging');
    }
    draggedItem = null;
    draggedIndex = -1;
    removeDropIndicator();
  });

  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!draggedItem) return;

    const item = e.target.closest('.ue-thumbnail');
    if (!item || item === draggedItem) {
      const items = container.querySelectorAll('.ue-thumbnail:not(.dragging)');
      if (items.length === 0) return;

      const indicator = getDropIndicator();
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      const firstRect = firstItem.getBoundingClientRect();
      const lastRect = lastItem.getBoundingClientRect();

      if (e.clientY < firstRect.top) {
        firstItem.before(indicator);
      } else if (e.clientY > lastRect.bottom) {
        lastItem.after(indicator);
      }
      return;
    }

    const rect = item.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    const indicator = getDropIndicator();

    if (e.clientY < midpoint) {
      item.before(indicator);
    } else {
      item.after(indicator);
    }
  });

  container.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!draggedItem) return;

    const indicator = ueState.sidebarDropIndicator;
    if (!indicator || !indicator.parentNode) {
      removeDropIndicator();
      return;
    }

    const items = Array.from(container.querySelectorAll('.ue-thumbnail'));
    let insertAt = 0;

    const nextSibling = indicator.nextElementSibling;
    if (nextSibling && nextSibling.classList.contains('ue-thumbnail')) {
      insertAt = parseInt(nextSibling.dataset.index);
    } else {
      insertAt = items.length;
    }

    // Snapshot pages BEFORE splice for reference-based reindex
    const oldPages = [...ueState.pages];
    const viewedPage = ueState.pages[ueState.selectedPage];

    const [movedPage] = ueState.pages.splice(draggedIndex, 1);

    if (draggedIndex < insertAt) {
      insertAt--;
    }

    ueState.pages.splice(insertAt, 0, movedPage);

    // Rebuild annotations + caches using reference equality
    window.rebuildAnnotationMapping(oldPages);

    // Update selectedPage to follow the viewed page
    const newViewedIndex = ueState.pages.indexOf(viewedPage);
    if (newViewedIndex !== -1) {
      ueState.selectedPage = newViewedIndex;
    }

    // Rebuild page slots (fixes observer stale indices) + re-render sidebar
    container._sidebarDragSetup = false;
    window.ueCreatePageSlots();
    ueRenderThumbnails();

    removeDropIndicator();
  });
}
