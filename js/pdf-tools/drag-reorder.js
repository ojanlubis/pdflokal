/*
 * PDFLokal - pdf-tools/drag-reorder.js (ES Module)
 * Generic drag-reorder utility for lists
 * Used by: merge list, image-to-pdf list, page manager grid
 */

import { state } from '../lib/state.js';

export function enableDragReorder(containerId, stateArray, isPages = false) {
  const container = document.getElementById(containerId);
  let draggedItem = null;

  container.querySelectorAll(isPages ? '.page-item' : '.file-item').forEach(item => {
    item.addEventListener('dragstart', (e) => {
      draggedItem = item;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      draggedItem = null;
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (item === draggedItem) return;

      const rect = item.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;

      if (e.clientX < midX) {
        container.insertBefore(draggedItem, item);
      } else {
        container.insertBefore(draggedItem, item.nextSibling);
      }

      updateStateOrder(container, stateArray, isPages);
    });
  });
}

function updateStateOrder(container, stateArray, isPages) {
  const items = container.querySelectorAll(isPages ? '.page-item' : '.file-item');
  const newOrder = [];

  items.forEach(item => {
    if (isPages) {
      const pageNum = parseInt(item.dataset.page);
      if (!isNaN(pageNum)) newOrder.push(pageNum);
    } else {
      const index = parseInt(item.dataset.index);
      if (!isNaN(index) && stateArray[index]) {
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
