/*
 * PDFLokal - pdf-tools/drag-reorder.js (ES Module)
 * Generic drag-reorder utility for lists
 * Used by: merge list, image-to-pdf list, page manager grid
 */

import { state } from '../lib/state.js';

// WHY: Event delegation on the container instead of per-item listeners.
// Previous approach added listeners to every .file-item on each call,
// stacking N×listeners after N re-renders. Delegation adds once.
export function enableDragReorder(containerId, stateArray, isPages = false) {
  const container = document.getElementById(containerId);
  const selector = isPages ? '.page-item' : '.file-item';

  // Prevent stacking: one set of delegated handlers per container
  if (container._dragReorderSetup) return;
  container._dragReorderSetup = true;

  let draggedItem = null;

  container.addEventListener('dragstart', (e) => {
    const item = e.target.closest(selector);
    if (!item) return;
    draggedItem = item;
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });

  container.addEventListener('dragend', (e) => {
    const item = e.target.closest(selector);
    if (item) item.classList.remove('dragging');
    draggedItem = null;
  });

  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    const item = e.target.closest(selector);
    if (!item || item === draggedItem || !draggedItem) return;

    const rect = item.getBoundingClientRect();
    const midX = rect.left + rect.width / 2;

    if (e.clientX < midX) {
      item.before(draggedItem);
    } else {
      item.after(draggedItem);
    }

    updateStateOrder(container, stateArray, isPages);
  });
}

function updateStateOrder(container, stateArray, isPages) {
  const items = container.querySelectorAll(isPages ? '.page-item' : '.file-item');
  const newOrder = [];

  items.forEach(item => {
    if (isPages) {
      const pageNum = Number.parseInt(item.dataset.page);
      if (!Number.isNaN(pageNum)) newOrder.push(pageNum);
    } else {
      const index = Number.parseInt(item.dataset.index);
      if (!Number.isNaN(index) && stateArray[index]) {
        newOrder.push(stateArray[index]);
      }
    }
  });

  if (isPages) {
    state.pagesOrder = newOrder;
  } else {
    stateArray.length = 0;
    newOrder.forEach(item => stateArray.push(item));
  }
}
