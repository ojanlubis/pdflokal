/*
 * PDFLokal - editor/page-rendering.js (ES Module)
 * Page slots, canvas rendering, IntersectionObserver, scroll sync,
 * page selection, page deletion, status updates
 */

import { ueState, state, mobileState, OBSERVER_ROOT_MARGIN, MAX_CANVAS_DPR } from '../lib/state.js';
import { emit } from '../lib/events.js';
import { showToast, loadPdfDocument } from '../lib/utils.js';
import { ueRedrawPageAnnotations } from './annotations.js';
import { ueRenderThumbnails } from './sidebar.js';

// WHY: Prevents same page rendering twice concurrently. PDF.js render is async;
// duplicate renders corrupt canvas (overlapping drawImage calls).
const ueRenderingPages = new Set();

// Debounced thumbnail refresh after lazy page renders
let thumbnailRefreshTimer = null;

// rAF debounce ID for ueRenderVisiblePages
let ueRenderVisibleRafId = null;

// WHY: scrollSyncEnabled prevents feedback loop — ueSelectPage() calls scrollIntoView()
// which triggers scroll handler which calls ueSelectPage(). Disabled during programmatic
// scroll, re-enabled after 500ms. scrollSyncTimeoutId prevents stacking.
let scrollSyncTimeoutId = null;

// Scroll handler reference (for cleanup in ueRemoveScrollSync)
let scrollHandler = null;

// Resize handler reference (for cleanup in ueRemoveScrollSync)
let resizeHandler = null;

// PDF.js document cache — reuse across renders, destroyed on reset
const pdfDocCache = new Map();

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
  let maxWidth = wrapper ? wrapper.clientWidth - 16 : 600;
  // Guard: if layout hasn't reflowed yet, use a sensible fallback
  if (maxWidth <= 100) maxWidth = 600;

  for (let i = 0; i < ueState.pages.length; i++) {
    const slot = document.createElement('div');
    slot.className = 'ue-page-slot';
    slot.dataset.pageIndex = i;

    const canvas = document.createElement('canvas');
    canvas.className = 'ue-page-canvas';

    // Set placeholder size from thumbnail dimensions so IntersectionObserver works.
    const pageInfo = ueState.pages[i];
    const refPage = pageInfo.canvas || ueState.pages[0]?.canvas;
    if (refPage) {
      const aspect = refPage.height / refPage.width;
      const placeholderW = Math.min(maxWidth, 800);
      const placeholderH = Math.round(placeholderW * aspect);
      canvas.style.width = placeholderW + 'px';
      canvas.style.height = placeholderH + 'px';
      // WHY: Placeholders only need correct CSS dimensions for IntersectionObserver.
      // Buffer at 1x — will be overwritten at clamped DPR when actually rendered.
      canvas.width = placeholderW;
      canvas.height = placeholderH;
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

// No-op — body scroll replaces wrapper scroll; no fixed height needed.
export function ueSetWrapperHeight() {
  const wrapper = document.getElementById('ue-canvas-wrapper');
  if (wrapper) wrapper.style.height = '';
}

// Lightweight sidebar highlight + bottom bar page indicator
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

  // Update bottom bar page indicator
  const pageIndicator = document.getElementById('ue-page-indicator');
  if (pageIndicator && ueState.pages.length > 0) {
    pageIndicator.textContent = 'Hal ' + (index + 1) + '/' + ueState.pages.length;
  }
}

// ============================================================
// PAGE SELECTION & RENDERING
// ============================================================

export function ueSelectPage(index) {
  if (index < 0 || index >= ueState.pages.length) return;

  // Clear selection and confirm button when switching pages
  ueState.selectedAnnotation = null;
  // ueHideConfirmButton lives in signatures.js; importing it here would create
  // a circular chain (page-rendering ↔ signatures via canvas-events).
  window.ueHideConfirmButton();

  ueState.selectedPage = index;
  emit('page:selected', { index });

  // Show pages container, hide empty state
  document.getElementById('ue-empty-state').style.display = 'none';
  const pagesContainer = document.getElementById('ue-pages-container');
  if (pagesContainer) pagesContainer.style.display = 'flex';

  // Scroll the selected page into view (suppress scroll-sync feedback loop)
  const entry = ueState.pageCanvases[index];
  if (entry) {
    clearTimeout(scrollSyncTimeoutId);
    ueState.scrollSyncEnabled = false;
    entry.slot.scrollIntoView({ behavior: 'smooth', block: 'center' });
    scrollSyncTimeoutId = setTimeout(() => { ueState.scrollSyncEnabled = true; }, 500);
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

  // These mobile-ui.js functions are registered as window globals by that module.
  // The bare `typeof` check works because window properties are accessible as
  // bare names in the global scope, even from ES modules.
  if (typeof window.ueMobileUpdatePageIndicator === 'function') {
    window.ueMobileUpdatePageIndicator();
  }
  if (typeof window.ueMobileUpdateSignButton === 'function') {
    window.ueMobileUpdateSignButton();
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
    const pdf = await pdfDocCache.get(pageInfo.sourceIndex)
      || await (async () => {
        const doc = await loadPdfDocument(sourceFile.bytes);
        pdfDocCache.set(pageInfo.sourceIndex, doc);
        return doc;
      })();
    const page = await pdf.getPage(pageInfo.pageNum + 1);

    const canvas = entry.canvas;
    const ctx = canvas.getContext('2d');
    // WHY: Clamp DPR to MAX_CANVAS_DPR. At 200% zoom on Retina, raw DPR = 4,
    // making each A4 canvas ~42MB. Clamping to 2 keeps quality sharp while
    // preventing GPU memory exhaustion that silently breaks canvas allocation.
    const dpr = ueState.devicePixelRatio = Math.min(window.devicePixelRatio || 1, MAX_CANVAS_DPR);

    const wrapper = document.getElementById('ue-canvas-wrapper');
    const maxWidth = wrapper.clientWidth - 16;
    const naturalViewport = page.getViewport({ scale: 1, rotation: pageInfo.rotation });

    // WHY: Layout reflow race — workspace may be visible but clientWidth not yet computed.
    // Retry after 150ms rather than fail. Happens on first load when showTool() and
    // ueCreatePageSlots() run in same frame.
    if (maxWidth <= 100) {
      ueRenderingPages.delete(index);
      setTimeout(() => ueRenderPageCanvas(index), 150);
      return;
    }

    const baseScale = maxWidth / naturalViewport.width;
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

    // Guard: page may have been deleted/reordered during async render
    if (index >= ueState.pages.length || ueState.pages[index] !== pageInfo) {
      return;
    }

    ueState.pageCaches[index] = ctx.getImageData(0, 0, canvas.width, canvas.height);
    entry.rendered = true;

    ueRedrawPageAnnotations(index);

    // Refresh thumbnails after lazy render (debounced to batch multiple page renders)
    clearTimeout(thumbnailRefreshTimer);
    thumbnailRefreshTimer = setTimeout(() => ueRenderThumbnails(), 200);

    // WHY window.*: page-rendering ↔ canvas-events circular import.
    // canvas-events imports ueRenderPageCanvas; page-rendering needs ueSetupCanvasEvents.
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
// WHY rAF: Coalesces rapid zoom/resize events into single render pass.
// Timeout-based debounce causes mid-paint jank; rAF is paint-cycle-aware.
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
  if (ueState.selectedPage >= 0 && ueState.selectedPage < ueState.pageCanvases.length) {
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

  const visiblePages = new Set();

  // root: null → observe against viewport (body scroll)
  ueState.pageObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const slot = entry.target;
      const index = Number.parseInt(slot.dataset.pageIndex, 10);
      if (Number.isNaN(index)) return;

      const pc = ueState.pageCanvases[index];
      if (!pc) return;

      if (entry.isIntersecting) {
        visiblePages.add(index);
        if (!pc.rendered) ueRenderPageCanvas(index);
      } else {
        visiblePages.delete(index);
        // WHY threshold 4: Each canvas ~4MB at 2x DPR. Clearing offscreen canvases
        // balances memory vs re-render cost. Was 8, reduced after mobile OOM reports.
        if (pc.rendered && ueState.pageCanvases.length > 4) {
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
    root: null,
    rootMargin: OBSERVER_ROOT_MARGIN
  });

  ueState.pageCanvases.forEach(pc => {
    ueState.pageObserver.observe(pc.slot);
  });
}

export function ueSetupScrollSync() {
  if (window._ueScrollSyncSetup) return;
  window._ueScrollSyncSetup = true;

  let scrollTimeout;
  scrollHandler = () => {
    // Only sync when unified editor is active
    if (state.currentTool !== 'unified-editor') return;
    if (ueState.scrollSyncEnabled === false) return;
    if (ueState.isRestoring) return;

    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      const viewportCenter = window.innerHeight / 2;
      let closestIndex = 0;
      let closestDistance = Infinity;

      ueState.pageCanvases.forEach((pc, i) => {
        const slotRect = pc.slot.getBoundingClientRect();
        const slotCenter = slotRect.top + slotRect.height / 2;
        const distance = Math.abs(slotCenter - viewportCenter);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestIndex = i;
        }
      });

      if (closestIndex !== ueState.selectedPage) {
        ueState.selectedPage = closestIndex;
        ueHighlightThumbnail(closestIndex);

        // mobile-ui.js window global — see comment in ueSelectPage above
        if (typeof window.ueMobileUpdatePageIndicator === 'function') {
          window.ueMobileUpdatePageIndicator();
        }
      }
    }, 100);
  };
  window.addEventListener('scroll', scrollHandler);

  // WHY: Browser zoom triggers 'resize'. Re-render pages so canvas buffers
  // match new DPR/viewport. Debounced to avoid re-rendering during drag-resize.
  let resizeTimeout;
  resizeHandler = () => {
    if (state.currentTool !== 'unified-editor') return;
    if (ueState.pages.length === 0) return;
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      ueCreatePageSlots();
      ueRenderVisiblePages();
    }, 300);
  };
  window.addEventListener('resize', resizeHandler);
}

// Remove scroll sync listener (called from ueReset)
export function ueRemoveScrollSync() {
  if (scrollHandler) {
    window.removeEventListener('scroll', scrollHandler);
    scrollHandler = null;
  }
  if (resizeHandler) {
    window.removeEventListener('resize', resizeHandler);
    resizeHandler = null;
  }
  window._ueScrollSyncSetup = false;
}

// Clear PDF document cache (called from ueReset)
export function clearPdfDocCache() {
  pdfDocCache.forEach(doc => { try { doc.destroy(); } catch (_e) { /* ignore */ } });
  pdfDocCache.clear();
}

// ============================================================
// PAGE OPERATIONS
// ============================================================

export function ueDeletePage(index) {
  if (ueState.pages.length <= 1) {
    showToast('Tidak bisa menghapus halaman terakhir', 'error');
    return;
  }

  // Clear selected annotation if it's on the deleted page
  if (ueState.selectedAnnotation?.pageIndex === index) {
    ueState.selectedAnnotation = null;
    window.ueHideConfirmButton();
  }

  // WHY window.*: page-rendering ↔ undo-redo circular import.
  // undo-redo imports ueCreatePageSlots from page-rendering.
  window.ueSaveUndoState();
  const oldPages = [...ueState.pages];
  ueState.pages.splice(index, 1);

  // Rebuild annotations + caches using reference equality
  window.rebuildAnnotationMapping(oldPages);

  // Remove slot from DOM and rebuild pageCanvases
  const removed = ueState.pageCanvases.splice(index, 1);
  if (removed[0]) removed[0].slot.remove();
  ueState.pageCanvases.forEach((pc, i) => {
    pc.slot.dataset.pageIndex = i;
  });

  // Re-setup observer so its internal visiblePages set is fresh
  ueSetupIntersectionObserver();

  // Adjust selection
  if (ueState.selectedPage >= ueState.pages.length) {
    ueState.selectedPage = ueState.pages.length - 1;
  }

  emit('pages:changed', { source: 'user' });

  if (ueState.selectedPage >= 0) {
    ueSelectPage(ueState.selectedPage);
  }
}

export function ueUpdatePageCount() {
  // Update bottom bar page indicator
  const pageIndicator = document.getElementById('ue-page-indicator');
  if (pageIndicator) {
    const current = ueState.selectedPage >= 0 ? ueState.selectedPage + 1 : 1;
    const total = ueState.pages.length || 1;
    pageIndicator.textContent = 'Hal ' + current + '/' + total;
  }
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
