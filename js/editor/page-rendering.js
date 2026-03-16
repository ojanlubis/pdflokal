/*
 * PDFLokal - editor/page-rendering.js (ES Module)
 * PageRenderer class — owns the render pipeline: page slots, canvas rendering,
 * IntersectionObserver, scroll sync, page selection/deletion, status updates.
 *
 * All render-pipeline state (formerly scattered module-level closures) is now
 * encapsulated as instance properties. A single instance is created/destroyed
 * by lifecycle.js via createPageRenderer()/destroyPageRenderer().
 *
 * Backward compatibility: all 14 original exports are thin wrappers that
 * delegate to the singleton `renderer` instance. No consumer changes needed.
 */

import { ueState, state, OBSERVER_ROOT_MARGIN, MAX_CANVAS_DPR } from '../lib/state.js';
import { emit } from '../lib/events.js';
import { showToast, loadPdfDocument } from '../lib/utils.js';
import { ueRedrawPageAnnotations } from './annotations.js';
import { ueRenderThumbnails } from './sidebar.js';

// ============================================================
// PageRenderer CLASS
// ============================================================

class PageRenderer {
  constructor() {
    // WHY: Prevents same page rendering twice concurrently. PDF.js render is async;
    // duplicate renders corrupt canvas (overlapping drawImage calls).
    this._renderingPages = new Set();

    // Debounced thumbnail refresh after lazy page renders
    this._thumbnailRefreshTimer = null;

    // rAF debounce ID for renderVisiblePages
    this._renderVisibleRafId = null;

    // WHY: scrollSyncEnabled (in ueState) prevents feedback loop — selectPage() calls
    // scrollIntoView() which triggers scroll handler which calls selectPage(). Disabled
    // during programmatic scroll, re-enabled after 500ms. _scrollSyncTimeoutId prevents stacking.
    this._scrollSyncTimeoutId = null;

    // Scroll + resize handler references (for cleanup in removeScrollSync)
    this._scrollHandler = null;
    // WHY CONSOLIDATED: Previously two resize handlers existed — one in lifecycle.js
    // (200ms, ueSetWrapperHeight + ueRenderVisiblePages) and one here (300ms,
    // ueCreatePageSlots + ueRenderVisiblePages). ueCreatePageSlots already calls
    // ueSetWrapperHeight, so the lifecycle handler was a strict subset. Single handler
    // eliminates the double-render on every browser resize.
    this._resizeHandler = null;

    // PDF.js document cache — reuse across renders, destroyed on reset
    this._pdfDocCache = new Map();

    // Guard: prevents setupScrollSync from attaching duplicate listeners
    this._scrollSyncSetup = false;

    // TODO: wire deviceCapability.maxCanvasPixels for pixel-budget rendering
  }

  // ============================================================
  // PAGE SLOTS & MULTI-CANVAS DOM
  // ============================================================

  // Create (or rebuild) one .ue-page-slot > canvas per page inside #ue-pages-container.
  createPageSlots() {
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
    this.setupIntersectionObserver();

    // Set wrapper height based on first page (desktop only)
    this.setWrapperHeight();
  }

  // No-op — body scroll replaces wrapper scroll; no fixed height needed.
  setWrapperHeight() {
    const wrapper = document.getElementById('ue-canvas-wrapper');
    if (wrapper) wrapper.style.height = '';
  }

  // Lightweight sidebar highlight + bottom bar page indicator
  highlightThumbnail(index) {
    // WHY: On mobile (≤900px), sidebar is hidden and page slot outline is hidden.
    // Skip all DOM class toggling to avoid repaints during scroll sync.
    const isMobileView = window.matchMedia('(max-width: 900px)').matches;

    if (!isMobileView) {
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
    }

    // Update bottom bar page indicator (both desktop and mobile)
    const pageIndicator = document.getElementById('ue-page-indicator');
    if (pageIndicator && ueState.pages.length > 0) {
      pageIndicator.textContent = 'Hal ' + (index + 1) + '/' + ueState.pages.length;
    }
  }

  // ============================================================
  // PAGE SELECTION & RENDERING
  // ============================================================

  selectPage(index) {
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
      clearTimeout(this._scrollSyncTimeoutId);
      ueState.scrollSyncEnabled = false;
      entry.slot.scrollIntoView({ behavior: 'smooth', block: 'center' });
      this._scrollSyncTimeoutId = setTimeout(() => { ueState.scrollSyncEnabled = true; }, 500);
    }

    // Ensure the page is rendered
    if (entry && !entry.rendered) {
      this.renderPageCanvas(index);
    }

    this.highlightThumbnail(index);

    this.updateStatus(
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
  async renderPageCanvas(index) {
    if (index < 0 || index >= ueState.pages.length) return;
    if (this._renderingPages.has(index)) return;

    this._renderingPages.add(index);

    const pageInfo = ueState.pages[index];
    const sourceFile = ueState.sourceFiles[pageInfo.sourceIndex];
    const entry = ueState.pageCanvases[index];
    if (!entry) { this._renderingPages.delete(index); return; }

    try {
      const pdf = await this._pdfDocCache.get(pageInfo.sourceIndex)
        || await (async () => {
          const doc = await loadPdfDocument(sourceFile.bytes);
          this._pdfDocCache.set(pageInfo.sourceIndex, doc);
          return doc;
        })();
      const page = await pdf.getPage(pageInfo.pageNum + 1);

      const canvas = entry.canvas;
      // WHY willReadFrequently: pageCaches stores getImageData() after each render,
      // and ueRedrawPageAnnotations() calls putImageData() to restore clean state.
      // Without this flag, each getImageData() triggers an expensive GPU→CPU sync
      // that blocks the main thread (causes visible scroll jank on mobile).
      // With the flag, Chrome keeps the bitmap in CPU memory — readbacks are instant.
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      // WHY: Clamp DPR to MAX_CANVAS_DPR. At 200% zoom on Retina, raw DPR = 4,
      // making each A4 canvas ~42MB. Clamping to 2 keeps quality sharp while
      // preventing GPU memory exhaustion that silently breaks canvas allocation.
      const dpr = ueState.devicePixelRatio = Math.min(window.devicePixelRatio || 1, MAX_CANVAS_DPR);

      const wrapper = document.getElementById('ue-canvas-wrapper');
      const maxWidth = wrapper.clientWidth - 16;
      const naturalViewport = page.getViewport({ scale: 1, rotation: pageInfo.rotation });

      // WHY: Layout reflow race — workspace may be visible but clientWidth not yet computed.
      // Retry after 150ms rather than fail. Happens on first load when showTool() and
      // createPageSlots() run in same frame.
      if (maxWidth <= 100) {
        this._renderingPages.delete(index);
        setTimeout(() => this.renderPageCanvas(index), 150);
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

      const newBufW = viewport.width * dpr;
      const newBufH = viewport.height * dpr;

      // WHY: Only reassign canvas.width/height if dimensions actually changed.
      // Assigning canvas.width (even to the same value) clears all canvas content.
      // For evicted pages being re-rendered at same zoom, this avoids a visible
      // blank flash during the async PDF.js render.
      if (canvas.width !== newBufW || canvas.height !== newBufH) {
        canvas.width = newBufW;
        canvas.height = newBufH;
        canvas.style.width = viewport.width + 'px';
        canvas.style.height = viewport.height + 'px';
      }

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
      clearTimeout(this._thumbnailRefreshTimer);
      this._thumbnailRefreshTimer = setTimeout(() => ueRenderThumbnails(), 200);

      // WHY window.*: page-rendering ↔ canvas-events circular import.
      // canvas-events imports ueRenderPageCanvas; page-rendering needs ueSetupCanvasEvents.
      if (!ueState.eventsSetup) {
        window.ueSetupCanvasEvents();
      }
    } catch (error) {
      console.error('Error rendering page ' + index + ':', error);
    } finally {
      this._renderingPages.delete(index);
    }
  }

  // Render all currently visible pages (used after zoom/resize)
  // WHY rAF: Coalesces rapid zoom/resize events into single render pass.
  // Timeout-based debounce causes mid-paint jank; rAF is paint-cycle-aware.
  renderVisiblePages() {
    if (this._renderVisibleRafId) cancelAnimationFrame(this._renderVisibleRafId);
    this._renderVisibleRafId = requestAnimationFrame(() => {
      this._renderVisibleRafId = null;
      ueState.pageCanvases.forEach((pc, i) => {
        if (pc.rendered) {
          pc.rendered = false;
          this.renderPageCanvas(i);
        }
      });
    });
  }

  // Compatibility wrapper — renders the selected page
  renderSelectedPage() {
    if (ueState.selectedPage >= 0 && ueState.selectedPage < ueState.pageCanvases.length) {
      const entry = ueState.pageCanvases[ueState.selectedPage];
      if (entry) entry.rendered = false;
      this.renderPageCanvas(ueState.selectedPage);
    }
  }

  // ============================================================
  // INTERSECTION OBSERVER & SCROLL SYNC
  // ============================================================

  setupIntersectionObserver() {
    if (ueState.pageObserver) ueState.pageObserver.disconnect();

    // root: null → observe against viewport (body scroll)
    ueState.pageObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        const slot = entry.target;
        const index = Number.parseInt(slot.dataset.pageIndex, 10);
        if (Number.isNaN(index)) return;

        const pc = ueState.pageCanvases[index];
        if (!pc) return;

        // WHY: Only render pages entering viewport. NO eviction of pages leaving.
        // Previous eviction code (clearRect, rendered=false, cache delete) caused
        // visible white flash flicker on mobile when scrolling back to evicted pages.
        // Canvas memory stays allocated (GPU backing store is fixed by dimensions
        // regardless of content). Only CPU-side ImageData cache could be freed,
        // but the re-render cost + flicker outweighs the memory savings.
        // For very large documents (>50 pages), memory may become an issue —
        // address with page-at-a-time mode in the future, not eviction.
        if (entry.isIntersecting && !pc.rendered) {
          this.renderPageCanvas(index);
        }
      });
    }, {
      root: null,
      // WHY: Mobile fast-scroll covers more distance per frame than desktop.
      // 200px buffer isn't enough — pages enter viewport before render completes,
      // causing visible blank canvases. 600px ≈ 1.5 screen heights of pre-render.
      // WHY: CSS @media is the single source of truth for mobile detection.
      // matchMedia aligns with CSS breakpoint (900px), avoiding the old 768px mismatch.
      rootMargin: window.matchMedia('(max-width: 900px)').matches ? '600px 0px' : OBSERVER_ROOT_MARGIN
    });

    ueState.pageCanvases.forEach(pc => {
      ueState.pageObserver.observe(pc.slot);
    });
  }

  setupScrollSync() {
    if (this._scrollSyncSetup) return;
    this._scrollSyncSetup = true;

    let scrollTimeout;
    this._scrollHandler = () => {
      // Only sync when unified editor is active
      if (state.currentTool !== 'unified-editor') return;
      if (ueState.scrollSyncEnabled === false) return;
      if (ueState.isRestoring) return;

      clearTimeout(scrollTimeout);
      // WHY 150ms: Debounce scroll sync to avoid expensive getBoundingClientRect
      // calls during momentum scroll. 100ms was too aggressive on mobile.
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
          // WHY: Only update highlight — do NOT call selectPage() here.
          // selectPage() calls scrollIntoView() which fights user scroll,
          // causing auto-jump to top/bottom on mobile momentum scroll.
          ueState.selectedPage = closestIndex;
          emit('page:selected', { index: closestIndex });
          this.highlightThumbnail(closestIndex);

          // mobile-ui.js window global — see comment in selectPage above
          if (typeof window.ueMobileUpdatePageIndicator === 'function') {
            window.ueMobileUpdatePageIndicator();
          }
        }
      }, 150);
    };
    window.addEventListener('scroll', this._scrollHandler);

    // WHY: Browser zoom triggers 'resize'. Re-render pages so canvas buffers
    // match new DPR/viewport. Debounced to avoid re-rendering during drag-resize.
    // WHY CONSOLIDATED: This single handler replaces two previously duplicated handlers
    // (lifecycle.js 200ms + page-rendering.js 300ms). createPageSlots() already calls
    // setWrapperHeight(), so the lifecycle handler was a strict subset.
    let resizeTimeout;
    this._resizeHandler = () => {
      if (state.currentTool !== 'unified-editor') return;
      if (ueState.pages.length === 0) return;
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        this.createPageSlots();
        this.renderVisiblePages();
      }, 300);
    };
    window.addEventListener('resize', this._resizeHandler);
  }

  // Remove scroll sync listeners (called from destroy)
  removeScrollSync() {
    if (this._scrollHandler) {
      window.removeEventListener('scroll', this._scrollHandler);
      this._scrollHandler = null;
    }
    if (this._resizeHandler) {
      window.removeEventListener('resize', this._resizeHandler);
      this._resizeHandler = null;
    }
    this._scrollSyncSetup = false;
  }

  // Clear PDF document cache
  clearPdfDocCache() {
    this._pdfDocCache.forEach(doc => { try { doc.destroy(); } catch (_e) { /* ignore */ } });
    this._pdfDocCache.clear();
  }

  // ============================================================
  // PAGE OPERATIONS
  // ============================================================

  deletePage(index) {
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
    this.setupIntersectionObserver();

    // Adjust selection
    if (ueState.selectedPage >= ueState.pages.length) {
      ueState.selectedPage = ueState.pages.length - 1;
    }

    emit('pages:changed', { source: 'user' });

    if (ueState.selectedPage >= 0) {
      this.selectPage(ueState.selectedPage);
    }
  }

  updatePageCount() {
    // Update bottom bar page indicator
    const pageIndicator = document.getElementById('ue-page-indicator');
    if (pageIndicator) {
      const current = ueState.selectedPage >= 0 ? ueState.selectedPage + 1 : 1;
      const total = ueState.pages.length || 1;
      pageIndicator.textContent = 'Hal ' + current + '/' + total;
    }
  }

  // Update status (supports different message for mobile)
  updateStatus(message, mobileMessage) {
    const status = document.getElementById('ue-editor-status');
    if (status) {
      if (mobileMessage && window.matchMedia('(max-width: 900px)').matches) {
        status.textContent = mobileMessage;
      } else {
        status.textContent = message;
      }
    }
  }

  // ============================================================
  // LIFECYCLE
  // ============================================================

  // Clean up all resources owned by this instance
  destroy() {
    this.removeScrollSync();
    this.clearPdfDocCache();
    if (ueState.pageObserver) {
      ueState.pageObserver.disconnect();
      ueState.pageObserver = null;
    }
  }
}

// ============================================================
// SINGLETON INSTANCE & LIFECYCLE EXPORTS
// ============================================================

let renderer = null;

export function createPageRenderer() {
  renderer = new PageRenderer();
}

export function destroyPageRenderer() {
  renderer?.destroy();
  renderer = null;
}

// ============================================================
// THIN WRAPPERS (backward-compatible exports)
// All consumers continue importing these exact function names.
// ============================================================

export function ueCreatePageSlots() { renderer?.createPageSlots(); }
export function ueSetWrapperHeight() { renderer?.setWrapperHeight(); }
export function ueHighlightThumbnail(index) { renderer?.highlightThumbnail(index); }
export function ueSelectPage(index) { renderer?.selectPage(index); }
export async function ueRenderPageCanvas(index) { return renderer?.renderPageCanvas(index); }
export function ueRenderVisiblePages() { renderer?.renderVisiblePages(); }
export function ueRenderSelectedPage() { renderer?.renderSelectedPage(); }
export function ueSetupIntersectionObserver() { renderer?.setupIntersectionObserver(); }
export function ueSetupScrollSync() { renderer?.setupScrollSync(); }
export function ueRemoveScrollSync() { renderer?.removeScrollSync(); }
export function clearPdfDocCache() { renderer?.clearPdfDocCache(); }
export function ueDeletePage(index) { renderer?.deletePage(index); }
export function ueUpdatePageCount() { renderer?.updatePageCount(); }
export function ueUpdateStatus(message, mobileMessage) { renderer?.updateStatus(message, mobileMessage); }
