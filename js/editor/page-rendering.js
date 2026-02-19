/*
 * PDFLokal - editor/page-rendering.js (ES Module)
 * Page slots, canvas rendering, IntersectionObserver, scroll sync,
 * page selection, page deletion, status updates
 */

import { ueState, state, mobileState } from '../lib/state.js';
import { showToast } from '../lib/utils.js';
import { ueRedrawPageAnnotations } from './annotations.js';
import { ueRenderThumbnails } from './sidebar.js';

// Set of page indices currently being rendered (prevents concurrent renders of same page)
const ueRenderingPages = new Set();

// rAF debounce ID for ueRenderVisiblePages
let ueRenderVisibleRafId = null;

// ============================================================
// PAGE SLOTS & MULTI-CANVAS DOM
// ============================================================

// Create (or rebuild) one .ue-page-slot > canvas per page inside #ue-pages-container.
export function ueCreatePageSlots() {
  const container = document.getElementById('ue-pages-container');
  if (!container) return;

  // Disconnect previous observer before rebuilding
  if (ueState.pageObserver) ueState.pageObserver.disconnect();

  container.innerHTML = '';
  ueState.pageCanvases = [];

  // Calculate placeholder dimensions from thumbnail aspect ratios
  const wrapper = document.getElementById('ue-canvas-wrapper');
  const maxWidth = wrapper ? wrapper.clientWidth - 16 : 600;

  for (let i = 0; i < ueState.pages.length; i++) {
    const slot = document.createElement('div');
    slot.className = 'ue-page-slot';
    slot.dataset.pageIndex = i;

    const canvas = document.createElement('canvas');
    canvas.className = 'ue-page-canvas';

    // Set placeholder size from thumbnail dimensions so IntersectionObserver works.
    const pageInfo = ueState.pages[i];
    const refPage = pageInfo.canvas || (ueState.pages[0] && ueState.pages[0].canvas);
    if (refPage) {
      const aspect = refPage.height / refPage.width;
      const placeholderW = Math.min(maxWidth, 800);
      const placeholderH = Math.round(placeholderW * aspect);
      const dpr = window.devicePixelRatio || 1;
      canvas.style.width = placeholderW + 'px';
      canvas.style.height = placeholderH + 'px';
      canvas.width = placeholderW * dpr;
      canvas.height = placeholderH * dpr;
    }

    slot.appendChild(canvas);
    container.appendChild(slot);

    ueState.pageCanvases.push({ slot, canvas, rendered: false });
  }

  // Apply current tool cursor to all canvases
  if (ueState.currentTool) {
    ueState.pageCanvases.forEach(pc => {
      pc.canvas.className = 'ue-page-canvas tool-' + ueState.currentTool;
    });
  }

  // Setup lazy rendering observer
  ueSetupIntersectionObserver();

  // Set wrapper height based on first page (desktop only)
  ueSetWrapperHeight();
}

// Set canvas wrapper height to show ~1 full page on desktop.
export function ueSetWrapperHeight() {
  const wrapper = document.getElementById('ue-canvas-wrapper');
  if (!wrapper || ueState.pages.length === 0) return;

  // Only apply on desktop (>900px)
  if (window.innerWidth <= 900) {
    wrapper.style.height = '';
    return;
  }

  const firstPC = ueState.pageCanvases[0];
  if (!firstPC) return;

  const canvasH = firstPC.canvas.offsetHeight || parseInt(firstPC.canvas.style.height) || 600;
  const wrapperH = canvasH + 80;
  wrapper.style.height = wrapperH + 'px';
}

// Lightweight sidebar highlight
export function ueHighlightThumbnail(index) {
  const thumbnails = document.querySelectorAll('#ue-thumbnails .ue-thumb');
  thumbnails.forEach((thumb, i) => {
    thumb.classList.toggle('selected', i === index);
  });

  if (thumbnails[index]) {
    thumbnails[index].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  ueState.pageCanvases.forEach((pc, i) => {
    pc.slot.classList.toggle('selected', i === index);
  });

  const footer = document.getElementById('ue-page-count');
  if (footer) {
    footer.textContent = ueState.pages.length + ' halaman';
  }
}

// ============================================================
// PAGE SELECTION & RENDERING
// ============================================================

export function ueSelectPage(index) {
  if (index < 0 || index >= ueState.pages.length) return;

  // Clear selection and confirm button when switching pages
  ueState.selectedAnnotation = null;
  window.ueHideConfirmButton();

  ueState.selectedPage = index;

  // Show pages container, hide empty state
  document.getElementById('ue-empty-state').style.display = 'none';
  const pagesContainer = document.getElementById('ue-pages-container');
  if (pagesContainer) pagesContainer.style.display = 'flex';

  // Scroll the selected page into view (suppress scroll-sync feedback loop)
  const entry = ueState.pageCanvases[index];
  if (entry) {
    ueState.scrollSyncEnabled = false;
    entry.slot.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => { ueState.scrollSyncEnabled = true; }, 500);
  }

  // Ensure the page is rendered
  if (entry && !entry.rendered) {
    ueRenderPageCanvas(index);
  }

  ueHighlightThumbnail(index);

  ueUpdateStatus(
    'Halaman ' + (index + 1) + ' dipilih. Gunakan alat di atas untuk mengedit.',
    'Halaman ' + (index + 1) + ' dipilih. Gunakan toolbar di bawah untuk pindah halaman.'
  );

  // Update mobile UI
  if (typeof ueMobileUpdatePageIndicator === 'function') {
    ueMobileUpdatePageIndicator();
  }
  if (typeof ueMobileUpdateSignButton === 'function') {
    ueMobileUpdateSignButton();
  }
}

// Render a single page to its own canvas
export async function ueRenderPageCanvas(index) {
  if (index < 0 || index >= ueState.pages.length) return;
  if (ueRenderingPages.has(index)) return;

  ueRenderingPages.add(index);

  const pageInfo = ueState.pages[index];
  const sourceFile = ueState.sourceFiles[pageInfo.sourceIndex];
  const entry = ueState.pageCanvases[index];
  if (!entry) { ueRenderingPages.delete(index); return; }

  try {
    const pdf = await pdfjsLib.getDocument({ data: sourceFile.bytes.slice() }).promise;
    const page = await pdf.getPage(pageInfo.pageNum + 1);

    const canvas = entry.canvas;
    const ctx = canvas.getContext('2d');
    const dpr = ueState.devicePixelRatio = window.devicePixelRatio || 1;

    const wrapper = document.getElementById('ue-canvas-wrapper');
    const maxWidth = wrapper.clientWidth - 16;
    const naturalViewport = page.getViewport({ scale: 1, rotation: pageInfo.rotation });

    if (maxWidth <= 100) {
      ueRenderingPages.delete(index);
      setTimeout(() => ueRenderPageCanvas(index), 150);
      return;
    }

    let baseScale = maxWidth / naturalViewport.width;
    let scale = baseScale * ueState.zoomLevel;
    scale = Math.max(scale, 0.25);
    scale = Math.min(scale, 4);

    const viewport = page.getViewport({ scale, rotation: pageInfo.rotation });

    ueState.pageScales[index] = {
      scale,
      pdfWidth: naturalViewport.width,
      pdfHeight: naturalViewport.height,
      canvasWidth: viewport.width,
      canvasHeight: viewport.height
    };

    canvas.width = viewport.width * dpr;
    canvas.height = viewport.height * dpr;
    canvas.style.width = viewport.width + 'px';
    canvas.style.height = viewport.height + 'px';

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    await page.render({ canvasContext: ctx, viewport }).promise;

    ueState.pageCaches[index] = ctx.getImageData(0, 0, canvas.width, canvas.height);
    entry.rendered = true;

    ueRedrawPageAnnotations(index);

    // Setup canvas events once (use window.* to avoid circular import)
    if (!ueState.eventsSetup) {
      window.ueSetupCanvasEvents();
    }
  } catch (error) {
    console.error('Error rendering page ' + index + ':', error);
  } finally {
    ueRenderingPages.delete(index);
  }
}

// Render all currently visible pages (used after zoom/resize)
export function ueRenderVisiblePages() {
  if (ueRenderVisibleRafId) cancelAnimationFrame(ueRenderVisibleRafId);
  ueRenderVisibleRafId = requestAnimationFrame(() => {
    ueRenderVisibleRafId = null;
    ueState.pageCanvases.forEach((pc, i) => {
      if (pc.rendered) {
        pc.rendered = false;
        ueRenderPageCanvas(i);
      }
    });
  });
}

// Compatibility wrapper — renders the selected page
export function ueRenderSelectedPage() {
  if (ueState.selectedPage >= 0) {
    const entry = ueState.pageCanvases[ueState.selectedPage];
    if (entry) entry.rendered = false;
    ueRenderPageCanvas(ueState.selectedPage);
  }
}

// ============================================================
// INTERSECTION OBSERVER & SCROLL SYNC
// ============================================================

export function ueSetupIntersectionObserver() {
  if (ueState.pageObserver) ueState.pageObserver.disconnect();

  const wrapper = document.getElementById('ue-canvas-wrapper');
  if (!wrapper) return;

  const visiblePages = new Set();

  ueState.pageObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const slot = entry.target;
      const index = parseInt(slot.dataset.pageIndex, 10);
      if (isNaN(index)) return;

      const pc = ueState.pageCanvases[index];
      if (!pc) return;

      if (entry.isIntersecting) {
        visiblePages.add(index);
        if (!pc.rendered) ueRenderPageCanvas(index);
      } else {
        visiblePages.delete(index);
        if (pc.rendered && ueState.pageCanvases.length > 8) {
          const nearVisible = Array.from(visiblePages).some(v => Math.abs(v - index) <= 3);
          if (!nearVisible) {
            pc.canvas.getContext('2d').clearRect(0, 0, pc.canvas.width, pc.canvas.height);
            pc.rendered = false;
            delete ueState.pageCaches[index];
          }
        }
      }
    });
  }, {
    root: wrapper,
    rootMargin: '200px 0px'
  });

  ueState.pageCanvases.forEach(pc => {
    ueState.pageObserver.observe(pc.slot);
  });
}

export function ueSetupScrollSync() {
  const wrapper = document.getElementById('ue-canvas-wrapper');
  if (!wrapper || wrapper._scrollSyncSetup) return;
  wrapper._scrollSyncSetup = true;

  let scrollTimeout;
  wrapper.addEventListener('scroll', () => {
    if (ueState.scrollSyncEnabled === false) return;

    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      const wrapperRect = wrapper.getBoundingClientRect();
      const wrapperCenter = wrapperRect.top + wrapperRect.height / 2;
      let closestIndex = 0;
      let closestDistance = Infinity;

      ueState.pageCanvases.forEach((pc, i) => {
        const slotRect = pc.slot.getBoundingClientRect();
        const slotCenter = slotRect.top + slotRect.height / 2;
        const distance = Math.abs(slotCenter - wrapperCenter);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestIndex = i;
        }
      });

      if (closestIndex !== ueState.selectedPage) {
        ueState.selectedPage = closestIndex;
        ueHighlightThumbnail(closestIndex);

        if (typeof ueMobileUpdatePageIndicator === 'function') {
          ueMobileUpdatePageIndicator();
        }
      }
    }, 100);
  });
}

// ============================================================
// PAGE OPERATIONS
// ============================================================

export function ueDeletePage(index) {
  if (ueState.pages.length <= 1) {
    showToast('Tidak bisa menghapus halaman terakhir', 'error');
    return;
  }

  // Use window.* to avoid circular import with undo-redo
  window.ueSaveUndoState();
  ueState.pages.splice(index, 1);
  delete ueState.annotations[index];

  // Reindex annotations
  const newAnnotations = {};
  Object.keys(ueState.annotations).forEach((key) => {
    const idx = parseInt(key);
    if (idx > index) {
      newAnnotations[idx - 1] = ueState.annotations[idx];
    } else if (idx < index) {
      newAnnotations[idx] = ueState.annotations[idx];
    }
  });
  ueState.annotations = newAnnotations;

  // Remove slot from DOM and rebuild pageCanvases / pageCaches
  const removed = ueState.pageCanvases.splice(index, 1);
  if (removed[0]) removed[0].slot.remove();
  delete ueState.pageCaches[index];

  // Re-index pageCaches and slot data attributes
  const newCaches = {};
  Object.keys(ueState.pageCaches).forEach((key) => {
    const idx = parseInt(key);
    newCaches[idx > index ? idx - 1 : idx] = ueState.pageCaches[idx];
  });
  ueState.pageCaches = newCaches;
  ueState.pageCanvases.forEach((pc, i) => {
    pc.slot.dataset.pageIndex = i;
  });

  // Re-setup observer so its internal visiblePages set is fresh
  ueSetupIntersectionObserver();

  // Adjust selection
  if (ueState.selectedPage >= ueState.pages.length) {
    ueState.selectedPage = ueState.pages.length - 1;
  }

  ueRenderThumbnails();
  ueUpdatePageCount();

  if (ueState.selectedPage >= 0) {
    ueSelectPage(ueState.selectedPage);
  }
}

export function ueUpdatePageCount() {
  document.getElementById('ue-page-count').textContent = ueState.pages.length + ' halaman';
}

// Update status (supports different message for mobile)
export function ueUpdateStatus(message, mobileMessage) {
  const status = document.getElementById('ue-editor-status');
  if (status) {
    if (mobileMessage && mobileState.isMobile) {
      status.textContent = mobileMessage;
    } else {
      status.textContent = message;
    }
  }
}
