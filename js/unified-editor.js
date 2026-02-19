/*
 * ============================================================
 * PDFLokal - unified-editor.js
 * Unified PDF Editor Workspace
 * ============================================================
 *
 * PURPOSE:
 *   The flagship multi-document PDF editor. Handles file loading,
 *   page rendering, sidebar thumbnails, canvas-based annotation
 *   editing (whiteout, text, signatures), zoom, rotation, undo/redo,
 *   PDF export, and the Gabungkan (page manager) modal.
 *
 * GLOBAL STATE DEFINED HERE:
 *   - ueState {}       — Editor state (pages, annotations, zoom, etc.)
 *   - uePmState {}     — Page manager modal state (line ~2150)
 *
 * FUNCTIONS EXPORTED (called by other files):
 *   ueAddFiles(), initUnifiedEditor(), ueReset(), ueSelectPage(),
 *   ueDownload(), ueUndoAnnotation(), ueRedoAnnotation(),
 *   ueRotateCurrentPage(), ueSetTool(), ueRedrawAnnotations(),
 *   ueSaveEditUndoState(), ueUpdateStatus(), ueConfirmText(),
 *   uePmOpenModal(), uePmCloseModal(), uePmToggleExtractMode()
 *
 * FUNCTIONS IMPORTED (defined in other files):
 *   From app.js:
 *     showToast(), showFullscreenLoading(), hideFullscreenLoading(),
 *     checkFileSize(), convertImageToPdf(), downloadBlob(),
 *     getDownloadFilename(), pushModalState(), mobileState,
 *     state (reads state.currentTool, state.signatureImage),
 *     navHistory
 *   From pdf-tools.js:
 *     openSignatureModal(), openTextModal(), getTextModalSettings(),
 *     optimizeSignatureImage()
 *
 * LOAD ORDER: Must load AFTER app.js AND pdf-tools.js
 * ============================================================
 */

// ============================================================
// CONSTANTS
// ============================================================

// CSS_FONT_MAP is now defined in js/lib/state.js and available via window.CSS_FONT_MAP

// ============================================================
// CANVAS UTILITIES (extracted from ueSetupCanvasEvents closure)
// ============================================================

// Get the canvas element for the currently selected page
function ueGetCurrentCanvas() {
  const entry = ueState.pageCanvases[ueState.selectedPage];
  return entry ? entry.canvas : null;
}

// Convert mouse/touch event coords to canvas-pixel coords
function ueGetCoords(e, canvas) {
  const dpr = ueState.devicePixelRatio || window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (canvas.width / canvas.clientWidth / dpr);
  const y = (e.clientY - rect.top) * (canvas.height / canvas.clientHeight / dpr);
  return { x, y };
}

// Check if (x, y) is on a resize handle of the given annotation
function ueGetResizeHandle(anno, x, y) {
  if (anno.locked) return null;
  const handleSize = 12;

  let corners;
  if (anno.type === 'text') {
    const bounds = getTextBounds(anno);
    corners = [
      { pos: 'tl', hx: bounds.x, hy: bounds.y },
      { pos: 'tr', hx: bounds.x + bounds.width, hy: bounds.y },
      { pos: 'bl', hx: bounds.x, hy: bounds.y + bounds.height },
      { pos: 'br', hx: bounds.x + bounds.width, hy: bounds.y + bounds.height }
    ];
  } else if (anno.type === 'signature') {
    corners = [
      { pos: 'tl', hx: anno.x, hy: anno.y },
      { pos: 'tr', hx: anno.x + anno.width, hy: anno.y },
      { pos: 'bl', hx: anno.x, hy: anno.y + anno.height },
      { pos: 'br', hx: anno.x + anno.width, hy: anno.y + anno.height }
    ];
  } else {
    return null;
  }

  for (const h of corners) {
    if (Math.abs(x - h.hx) < handleSize && Math.abs(y - h.hy) < handleSize) {
      return h.pos;
    }
  }
  return null;
}

// ============================================================
// UNIFIED EDITOR STATE
// ============================================================

// ueState is now defined in js/lib/state.js and available via window.ueState

// ============================================================
// FILE LOADING & INPUT HANDLING
// Functions: initUnifiedEditorInput, ueAddFiles, handlePdfFile, handleImageFile
// ============================================================

function initUnifiedEditorInput() {
  const input = document.getElementById('ue-file-input');
  if (input && !input._ueInitialized) {
    input._ueInitialized = true;
    input.addEventListener('change', async (e) => {
      if (e.target.files.length > 0) {
        showFullscreenLoading('Memuat PDF...');
        try {
          await ueAddFiles(e.target.files);
        } catch (error) {
          console.error('Error loading PDF:', error);
          showToast('Gagal memuat PDF', 'error');
        } finally {
          hideFullscreenLoading();
          e.target.value = '';
        }
      }
    });
  }
}

// USER FLOW: File loading into unified editor
// Called from: app.js (dropzone, Merge/Split cards), or ue-file-input in editor workspace
// For each file → handlePdfFile (extracts all pages) or handleImageFile (converts to single-page PDF)
// After loading → ueRenderThumbnails() + ueSelectPage(0) to show first page
async function ueAddFiles(files) {
  if (!files || files.length === 0) return;

  for (const file of files) {
    // Validate file type
    const isPdf = file.type === 'application/pdf';
    const isImage = file.type.startsWith('image/');

    if (!isPdf && !isImage) {
      showToast(`File ${file.name} bukan PDF atau gambar. Diabaikan.`, 'warning');
      continue;
    }

    // Check file size
    if (!checkFileSize(file)) continue;

    try {
      if (isPdf) {
        await handlePdfFile(file);
      } else {
        await handleImageFile(file);
      }
    } catch (error) {
      console.error('Error loading file:', error);
      showToast(error.message || `Gagal memuat ${file.name}`, 'error');
    }
  }

  // Rebuild page slots for new page count
  ueCreatePageSlots();

  ueRenderThumbnails();
  ueUpdatePageCount();
  document.getElementById('ue-download-btn').disabled = false;

  // Auto-select first page if none selected
  if (ueState.selectedPage === -1 && ueState.pages.length > 0) {
    ueSelectPage(0);
    // Scroll body to top so user sees toolbar and first page, not middle of page
    window.scrollTo(0, 0);
  }
}

// Handle PDF file loading
async function handlePdfFile(file) {
  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  const sourceIndex = ueState.sourceFiles.length;
  const sourceName = file.name.replace('.pdf', '').substring(0, 15);

  ueState.sourceFiles.push({ name: file.name, bytes });

  // Load PDF with PDF.js
  const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;

  // Save undo state
  ueSaveUndoState();

  // Add all pages
  for (let i = 0; i < pdf.numPages; i++) {
    const page = await pdf.getPage(i + 1);
    const viewport = page.getViewport({ scale: 0.5 }); // Thumbnail scale

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');

    await page.render({ canvasContext: ctx, viewport }).promise;

    ueState.pages.push({
      pageNum: i,
      sourceIndex,
      sourceName,
      rotation: 0,
      canvas,
      isFromImage: false  // NEW FIELD
    });

    // Initialize annotations for this page
    ueState.annotations[ueState.pages.length - 1] = [];
  }
}

// Handle image file loading (converts to PDF)
async function handleImageFile(file) {
  // Convert image to PDF
  const pdfBytes = await convertImageToPdf(file);

  // Store converted PDF in sourceFiles
  const sourceIndex = ueState.sourceFiles.length;
  const sourceName = file.name.replace(/\.(png|jpg|jpeg|webp|gif)$/i, '').substring(0, 15);

  // Create a TRUE copy of the bytes to prevent ArrayBuffer detachment issues
  // new Uint8Array(pdfBytes) shares the same buffer, so we use slice() for a deep copy
  const bytesCopy = pdfBytes.slice();

  ueState.sourceFiles.push({
    name: file.name,
    bytes: bytesCopy  // Store as PDF bytes, not image bytes
  });

  // Render thumbnail using PDF.js (use the original for rendering)
  const pdf = await pdfjsLib.getDocument({ data: pdfBytes }).promise;
  const page = await pdf.getPage(1);  // Always page 1 for images

  const viewport = page.getViewport({ scale: 0.5 });

  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');

  await page.render({ canvasContext: ctx, viewport }).promise;

  // Save undo state
  ueSaveUndoState();

  // Add to pages array
  ueState.pages.push({
    pageNum: 0,  // Always 0 for single-page image PDFs
    sourceIndex,
    sourceName,
    rotation: 0,
    canvas,
    isFromImage: true  // NEW FIELD - marks as image-sourced
  });

  // Initialize annotations for this page
  ueState.annotations[ueState.pages.length - 1] = [];
}

// ============================================================
// SIDEBAR THUMBNAILS & DRAG-DROP REORDER
// Functions: ueRenderThumbnails, ueSetupSidebarDragDrop
// ============================================================

function ueRenderThumbnails() {
  const container = document.getElementById('ue-thumbnails');
  container.innerHTML = '';

  if (ueState.pages.length === 0) {
    container.innerHTML = `
      <div class="drop-hint" onclick="document.getElementById('ue-file-input').click()">
        <svg class="drop-hint-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 32px; height: 32px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        <span class="drop-hint-text" style="font-size: 0.8125rem;">Upload PDF</span>
      </div>
    `;
    return;
  }

  ueState.pages.forEach((page, index) => {
    const item = document.createElement('div');
    // Detect orientation based on canvas dimensions
    const isLandscape = page.canvas.width > page.canvas.height;
    item.className = 'ue-thumbnail' + (index === ueState.selectedPage ? ' selected' : '') + (isLandscape ? ' landscape' : ' portrait');
    item.draggable = true;
    item.dataset.index = index;
    item.onclick = () => ueSelectPage(index);

    // Clone the thumbnail canvas
    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = page.canvas.width;
    thumbCanvas.height = page.canvas.height;
    thumbCanvas.getContext('2d').drawImage(page.canvas, 0, 0);
    // Apply rotation transform if page is rotated
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

    // Delete button
    const delBtn = document.createElement('button');
    delBtn.className = 'ue-thumbnail-delete';
    delBtn.innerHTML = '×';
    delBtn.onclick = (e) => {
      e.stopPropagation();
      ueDeletePage(index);
    };
    item.appendChild(delBtn);

    container.appendChild(item);
  });

  // Setup drag-drop reordering
  ueSetupSidebarDragDrop();
}

// Setup sidebar drag-drop reordering (mirrors uePmEnableDragReorder for vertical layout)
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

  // Use event delegation on container
  container.addEventListener('dragstart', (e) => {
    const item = e.target.closest('.ue-thumbnail');
    if (!item) return;

    ueSaveUndoState();
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
      // Handle container edges
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

    // Find where the indicator is positioned
    const indicator = ueState.sidebarDropIndicator;
    if (!indicator || !indicator.parentNode) {
      removeDropIndicator();
      return;
    }

    // Find the insertion index based on indicator position
    const items = Array.from(container.querySelectorAll('.ue-thumbnail'));
    let insertAt = 0;

    // Find which item the indicator is before
    const nextSibling = indicator.nextElementSibling;
    if (nextSibling && nextSibling.classList.contains('ue-thumbnail')) {
      insertAt = parseInt(nextSibling.dataset.index);
    } else {
      // Indicator is at the end
      insertAt = items.length;
    }

    // Track the page user is currently viewing
    const viewedPage = ueState.pages[ueState.selectedPage];

    // Remove the page first
    const [movedPage] = ueState.pages.splice(draggedIndex, 1);

    // Adjust insertion point if we removed from before it
    if (draggedIndex < insertAt) {
      insertAt--;
    }

    // Insert at new position
    ueState.pages.splice(insertAt, 0, movedPage);

    // Reindex annotations
    uePmReindexAnnotations(draggedIndex, insertAt);

    // Update selectedPage to follow the viewed page
    const newViewedIndex = ueState.pages.indexOf(viewedPage);
    if (newViewedIndex !== -1) {
      ueState.selectedPage = newViewedIndex;
    }

    // Re-render (this will reset _sidebarDragSetup via innerHTML clear)
    container._sidebarDragSetup = false;
    ueRenderThumbnails();

    removeDropIndicator();
  });
}

// ============================================================
// PAGE SLOTS & MULTI-CANVAS DOM
// Functions: ueCreatePageSlots, ueHighlightThumbnail
// ============================================================

// Create (or rebuild) one .ue-page-slot > canvas per page inside #ue-pages-container.
// Called after files are loaded, pages added/removed, or undo/redo restores pages.
function ueCreatePageSlots() {
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
    // Use first page's aspect ratio as default for consistent sizing.
    const pageInfo = ueState.pages[i];
    const refPage = pageInfo.canvas || (ueState.pages[0] && ueState.pages[0].canvas);
    if (refPage) {
      const aspect = refPage.height / refPage.width;
      const placeholderW = Math.min(maxWidth, 800);
      const placeholderH = Math.round(placeholderW * aspect);
      const dpr = window.devicePixelRatio || 1;
      // Set both CSS size and canvas buffer so unrendered pages show as blank white
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
// On mobile, CSS overrides this with height: auto !important.
function ueSetWrapperHeight() {
  const wrapper = document.getElementById('ue-canvas-wrapper');
  if (!wrapper || ueState.pages.length === 0) return;

  // Only apply on desktop (>900px)
  if (window.innerWidth <= 900) {
    wrapper.style.height = '';
    return;
  }

  // Use first page slot's canvas CSS height as reference
  const firstPC = ueState.pageCanvases[0];
  if (!firstPC) return;

  const canvasH = firstPC.canvas.offsetHeight || parseInt(firstPC.canvas.style.height) || 600;
  // Add padding for gap and breathing room (container padding + gap + a little extra)
  const wrapperH = canvasH + 80;
  wrapper.style.height = wrapperH + 'px';
}

// Lightweight sidebar highlight — toggles .selected class without full ueRenderThumbnails() call.
// Used by scroll sync and event delegation to avoid expensive thumbnail re-renders.
function ueHighlightThumbnail(index) {
  // Highlight sidebar thumbnail
  const thumbnails = document.querySelectorAll('#ue-thumbnails .ue-thumb');
  thumbnails.forEach((thumb, i) => {
    thumb.classList.toggle('selected', i === index);
  });

  // Scroll sidebar thumbnail into view
  if (thumbnails[index]) {
    thumbnails[index].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // Highlight page slot in main canvas area
  ueState.pageCanvases.forEach((pc, i) => {
    pc.slot.classList.toggle('selected', i === index);
  });

  // Update page count footer
  const footer = document.getElementById('ue-page-count');
  if (footer) {
    footer.textContent = ueState.pages.length + ' halaman';
  }
}

// ============================================================
// PAGE SELECTION & RENDERING
// Functions: ueSelectPage, ueRenderSelectedPage
// ============================================================

// Switch to a specific page by index. Renders it on the canvas and highlights sidebar thumbnail.
function ueSelectPage(index) {
  if (index < 0 || index >= ueState.pages.length) return;

  // Clear selection and confirm button when switching pages
  ueState.selectedAnnotation = null;
  ueHideConfirmButton();

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

// Set of page indices currently being rendered (prevents concurrent renders of same page)
const ueRenderingPages = new Set();

// Render a single page to its own canvas
async function ueRenderPageCanvas(index) {
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

    if (!ueState.eventsSetup) {
      ueSetupCanvasEvents();
    }
  } catch (error) {
    console.error('Error rendering page ' + index + ':', error);
  } finally {
    ueRenderingPages.delete(index);
  }
}

// Redraw annotations on a specific page's canvas
function ueRedrawPageAnnotations(index) {
  const entry = ueState.pageCanvases[index];
  if (!entry || !entry.rendered) return;

  const canvas = entry.canvas;
  const ctx = canvas.getContext('2d');

  const cache = ueState.pageCaches[index];
  if (cache) ctx.putImageData(cache, 0, 0);
  ctx.setTransform(ueState.devicePixelRatio, 0, 0, ueState.devicePixelRatio, 0, 0);

  const annotations = ueState.annotations[index] || [];
  annotations.forEach((anno, i) => {
    const isSelected = ueState.selectedAnnotation &&
      ueState.selectedAnnotation.pageIndex === index &&
      ueState.selectedAnnotation.index === i;
    ueDrawAnnotation(ctx, anno, isSelected);
  });
}

// Render all currently visible pages (used after zoom/resize)
let ueRenderVisibleRafId = null;
function ueRenderVisiblePages() {
  // Debounce with rAF to avoid flooding renders during rapid zoom/resize
  if (ueRenderVisibleRafId) cancelAnimationFrame(ueRenderVisibleRafId);
  ueRenderVisibleRafId = requestAnimationFrame(() => {
    ueRenderVisibleRafId = null;
    ueState.pageCanvases.forEach((pc, i) => {
      // Re-render pages that are already rendered (visible or recently visible)
      if (pc.rendered) {
        pc.rendered = false; // Force re-render
        ueRenderPageCanvas(i);
      }
    });
  });
}

// Compatibility wrapper — renders the selected page
function ueRenderSelectedPage() {
  if (ueState.selectedPage >= 0) {
    const entry = ueState.pageCanvases[ueState.selectedPage];
    if (entry) entry.rendered = false; // Force re-render
    ueRenderPageCanvas(ueState.selectedPage);
  }
}

// Setup IntersectionObserver for lazy rendering
function ueSetupIntersectionObserver() {
  if (ueState.pageObserver) ueState.pageObserver.disconnect();

  const wrapper = document.getElementById('ue-canvas-wrapper');
  if (!wrapper) return;

  // Track which pages are currently in/near viewport for memory management
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
        // Un-render pages far from viewport to save memory (keep slot dimensions)
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
    rootMargin: '200px 0px' // Pre-render pages 200px above/below viewport
  });

  // Observe all page slots
  ueState.pageCanvases.forEach(pc => {
    ueState.pageObserver.observe(pc.slot);
  });
}

// Scroll sync: update selectedPage based on scroll position
function ueSetupScrollSync() {
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

        // Update mobile UI
        if (typeof ueMobileUpdatePageIndicator === 'function') {
          ueMobileUpdatePageIndicator();
        }
      }
    }, 100);
  });
}

// ============================================================
// ZOOM & ROTATION
// Functions: ueZoomIn, ueZoomOut, ueZoomReset, ueRotateCurrentPage, ueUpdateZoomDisplay
// ============================================================

function ueZoomIn() {
  ueState.zoomLevel = Math.min(ueState.zoomLevel + 0.25, 3);
  ueUpdateZoomDisplay();
  ueRenderVisiblePages();
}

function ueZoomOut() {
  ueState.zoomLevel = Math.max(ueState.zoomLevel - 0.25, 0.5);
  ueUpdateZoomDisplay();
  ueRenderVisiblePages();
}

function ueZoomReset() {
  ueState.zoomLevel = 1.0;
  ueUpdateZoomDisplay();
  ueRenderVisiblePages();
}

// Rotate current page 90 degrees clockwise
function ueRotateCurrentPage() {
  if (ueState.pages.length === 0 || ueState.selectedPage < 0) return;

  ueSaveUndoState();

  const page = ueState.pages[ueState.selectedPage];
  page.rotation = ((page.rotation || 0) + 90) % 360;

  // Re-render the page with new rotation
  ueRenderSelectedPage();

  // Update thumbnails to reflect rotation
  ueRenderThumbnails();

  showToast('Halaman diputar', 'success');
}

function ueUpdateZoomDisplay() {
  const display = document.getElementById('ue-zoom-level');
  if (display) {
    display.textContent = Math.round(ueState.zoomLevel * 100) + '%';
  }
}

// ============================================================
// CANVAS EVENT HANDLING (mouse, touch, drag, resize, double-click)
// Functions: ueSetupCanvasEvents (single large closure)
// ============================================================

function ueSetupCanvasEvents() {
  if (ueState.eventsSetup) return;
  ueState.eventsSetup = true;

  // Event delegation: attach to the pages container, not individual canvases
  const container = document.getElementById('ue-pages-container');
  if (!container) return;

  // Closure state for drag/draw operations
  // Note: isDragging/isResizing live on ueState (not here) for sharing with pinch-to-zoom handler
  let isDrawing = false;
  let startX, startY;
  let dragOffsetX, dragOffsetY;
  let hasMovedOrResized = false;
  let preChangeState = null;

  // Double-tap detection state
  let touchLastTap = 0;
  let touchLastCoords = null;
  const DOUBLE_TAP_DELAY = 300;
  const DOUBLE_TAP_DISTANCE = 30;

  // Find the canvas and page index from an event target (delegation helper)
  function getCanvasAndIndex(target) {
    const canvas = target.closest ? target.closest('.ue-page-slot canvas') : null;
    if (!canvas) return null;
    const slot = canvas.parentElement;
    const pageIndex = parseInt(slot.dataset.pageIndex, 10);
    if (isNaN(pageIndex)) return null;
    return { canvas, pageIndex };
  }

  // Build info from mouse event (returns null if not on a canvas)
  function infoFromMouse(e) {
    const hit = getCanvasAndIndex(e.target);
    if (!hit) return null;
    const coords = ueGetCoords(e, hit.canvas);
    return { canvas: hit.canvas, pageIndex: hit.pageIndex, x: coords.x, y: coords.y };
  }

  // Build info from touch event (returns null if not on a canvas)
  function infoFromTouch(e) {
    const touch = (e.touches && e.touches.length) ? e.touches[0] : e.changedTouches[0];
    // For touch events, target is always the element where touchstart began
    const hit = getCanvasAndIndex(e.target);
    if (!hit) return null;
    const coords = ueGetCoords(touch, hit.canvas);
    return { canvas: hit.canvas, pageIndex: hit.pageIndex, x: coords.x, y: coords.y };
  }

  container.addEventListener('mousedown', (e) => {
    const info = infoFromMouse(e);
    if (!info) return;
    // Auto-select the page that was clicked
    if (info.pageIndex !== ueState.selectedPage) {
      ueState.selectedPage = info.pageIndex;
      ueHighlightThumbnail(info.pageIndex);
    }
    handleDown(info);
  });
  container.addEventListener('mousemove', (e) => {
    const info = infoFromMouse(e);
    if (!info) return;
    handleMove(info);
  });
  container.addEventListener('mouseup', (e) => {
    const info = infoFromMouse(e);
    if (!info) return;
    handleUp(info);
  });
  container.addEventListener('dblclick', (e) => {
    const info = infoFromMouse(e);
    if (!info) return;
    handleDoubleClick(info);
  });
  container.addEventListener('mouseleave', () => {
    isDrawing = false;
    ueState.isDragging = false;
    ueState.isResizing = false;
    if (ueState.pendingSignature) {
      ueState.signaturePreviewPos = null;
      ueRedrawAnnotations();
    }
  });

  container.addEventListener('touchstart', (e) => {
    const info = infoFromTouch(e);
    if (!info) return;

    // Only preventDefault when a tool is active or we hit an annotation
    // Otherwise let the browser handle native scrolling
    const toolActive = ueState.currentTool && ueState.currentTool !== 'select';
    const hitAnno = ueState.currentTool === 'select' &&
      ueFindAnnotationAt(info.pageIndex, info.x, info.y);
    const pendingSig = ueState.pendingSignature && state.signatureImage;
    if (toolActive || hitAnno || pendingSig) {
      e.preventDefault();
    }

    // Auto-select the page that was touched
    if (info.pageIndex !== ueState.selectedPage) {
      ueState.selectedPage = info.pageIndex;
      ueHighlightThumbnail(info.pageIndex);
    }

    // Double-tap detection
    const now = Date.now();
    if (now - touchLastTap < DOUBLE_TAP_DELAY && touchLastCoords) {
      const distance = Math.sqrt(
        Math.pow(info.x - touchLastCoords.x, 2) +
        Math.pow(info.y - touchLastCoords.y, 2)
      );
      if (distance < DOUBLE_TAP_DISTANCE) {
        handleDoubleClick(info);
        return;
      }
    }
    touchLastTap = now;
    touchLastCoords = { x: info.x, y: info.y };
    handleDown(info);
  }, { passive: false });

  container.addEventListener('touchmove', (e) => {
    const info = infoFromTouch(e);
    if (!info) return;
    // Only preventDefault when actively interacting (dragging, drawing, resizing)
    if (ueState.isDragging || ueState.isResizing || isDrawing ||
        (ueState.currentTool && ueState.currentTool !== 'select')) {
      e.preventDefault();
    }
    handleMove(info);
  }, { passive: false });

  container.addEventListener('touchend', (e) => {
    const info = infoFromTouch(e);
    if (!info) return;
    e.preventDefault();
    handleUp(info);
  }, { passive: false });

  // --- Event handlers (accept { canvas, pageIndex, x, y }) ---

  function handleDown({ canvas, pageIndex, x, y }) {
    startX = x;
    startY = y;

    // If pending signature, place it immediately on click
    if (ueState.pendingSignature && state.signatureImage) {
      uePlaceSignature(x, y);
      return;
    }

    // Check for annotation selection and resize
    if (ueState.currentTool === 'select') {
      // First check if clicking on a resize handle of selected annotation
      if (ueState.selectedAnnotation) {
        const anno = ueState.annotations[ueState.selectedAnnotation.pageIndex][ueState.selectedAnnotation.index];
        const handle = ueGetResizeHandle(anno, x, y);
        if (handle) {
          hasMovedOrResized = false;
          preChangeState = JSON.parse(JSON.stringify(ueState.annotations));
          ueState.isResizing = true;
          ueState.resizeHandle = handle;

          if (anno.type === 'text') {
            const bounds = getTextBounds(anno);
            ueState.resizeStartInfo = {
              x: anno.x, y: anno.y, fontSize: anno.fontSize,
              width: bounds.width, height: bounds.height
            };
          } else {
            ueState.resizeStartInfo = {
              x: anno.x, y: anno.y,
              width: anno.width, height: anno.height,
              aspectRatio: anno.width / anno.height
            };
          }
          return;
        }
      }

      const clicked = ueFindAnnotationAt(x, y);
      if (clicked) {
        const anno = ueState.annotations[clicked.pageIndex][clicked.index];
        if (anno.locked) {
          if (anno.type === 'signature') {
            const annoId = `${clicked.pageIndex}-${clicked.index}`;
            if (ueState.lastLockedToastAnnotation !== annoId) {
              showToast('Tanda tangan terkunci. Klik dua kali untuk membuka kunci.', 'info');
              ueState.lastLockedToastAnnotation = annoId;
            }
          }
          ueState.selectedAnnotation = clicked;
          ueRedrawAnnotations();
          return;
        }
        hasMovedOrResized = false;
        preChangeState = JSON.parse(JSON.stringify(ueState.annotations));
        ueState.selectedAnnotation = clicked;
        ueState.lastLockedToastAnnotation = null;
        ueState.isDragging = true;
        dragOffsetX = x - anno.x;
        dragOffsetY = y - (anno.type === 'text' ? anno.y - anno.fontSize : anno.y);
        ueRedrawAnnotations();
        ueShowConfirmButton(anno, clicked);
        return;
      } else {
        ueState.selectedAnnotation = null;
        ueState.lastLockedToastAnnotation = null;
        ueHideConfirmButton();
        ueRedrawAnnotations();
      }
    }

    if (!ueState.currentTool || ueState.currentTool === 'select') return;
    isDrawing = true;
  }

  function handleMove({ canvas, pageIndex, x, y }) {
    // Update cursor for resize handles when hovering
    if (ueState.currentTool === 'select' && ueState.selectedAnnotation && !ueState.isResizing && !ueState.isDragging) {
      const anno = ueState.annotations[ueState.selectedAnnotation.pageIndex][ueState.selectedAnnotation.index];
      const handle = ueGetResizeHandle(anno, x, y);
      if (handle) {
        const cursors = { 'tl': 'nwse-resize', 'tr': 'nesw-resize', 'bl': 'nesw-resize', 'br': 'nwse-resize' };
        canvas.style.cursor = cursors[handle];
      } else {
        canvas.style.cursor = 'default';
      }
    }

    // Handle signature preview following cursor
    if (ueState.pendingSignature && state.signatureImage) {
      ueState.signaturePreviewPos = { x, y };
      ueRedrawAnnotations();
      ueDrawSignaturePreview(x, y);
      return;
    }

    // Handle resizing annotation
    if (ueState.isResizing && ueState.selectedAnnotation && ueState.resizeStartInfo) {
      const anno = ueState.annotations[ueState.selectedAnnotation.pageIndex][ueState.selectedAnnotation.index];
      const info = ueState.resizeStartInfo;
      const handle = ueState.resizeHandle;

      if (anno.type === 'text') {
        const ctx = canvas.getContext('2d');
        let newWidth;
        if (handle === 'br' || handle === 'tr') {
          newWidth = Math.max(20, x - info.x);
        } else {
          newWidth = Math.max(20, info.x + info.width - x);
        }
        const scale = newWidth / info.width;
        const newFontSize = Math.max(6, Math.min(120, info.fontSize * scale));
        anno.fontSize = newFontSize;
        const newBounds = getTextBounds(anno, ctx);

        if (handle === 'br') {
          anno.x = info.x;
          anno.y = info.y + (anno.fontSize - info.fontSize);
        } else if (handle === 'bl') {
          anno.x = info.x + info.width - newBounds.width;
          anno.y = info.y + (anno.fontSize - info.fontSize);
        } else if (handle === 'tr') {
          anno.x = info.x;
          anno.y = info.y + info.height - newBounds.height + (anno.fontSize - info.fontSize);
        } else if (handle === 'tl') {
          anno.x = info.x + info.width - newBounds.width;
          anno.y = info.y + info.height - newBounds.height + (anno.fontSize - info.fontSize);
        }

        hasMovedOrResized = true;
        ueRedrawAnnotations();
        ueUpdateConfirmButtonPosition(anno);
        return;

      } else if (anno.type === 'signature') {
        let newWidth, newHeight, newX, newY;
        if (handle === 'br') {
          newWidth = Math.max(50, x - info.x);
          newHeight = newWidth / info.aspectRatio;
          newX = info.x; newY = info.y;
        } else if (handle === 'bl') {
          newWidth = Math.max(50, info.x + info.width - x);
          newHeight = newWidth / info.aspectRatio;
          newX = info.x + info.width - newWidth; newY = info.y;
        } else if (handle === 'tr') {
          newWidth = Math.max(50, x - info.x);
          newHeight = newWidth / info.aspectRatio;
          newX = info.x; newY = info.y + info.height - newHeight;
        } else if (handle === 'tl') {
          newWidth = Math.max(50, info.x + info.width - x);
          newHeight = newWidth / info.aspectRatio;
          newX = info.x + info.width - newWidth; newY = info.y + info.height - newHeight;
        }
        anno.x = newX; anno.y = newY;
        anno.width = newWidth; anno.height = newHeight;
        hasMovedOrResized = true;
        ueRedrawAnnotations();
        ueUpdateConfirmButtonPosition(anno);
        return;
      }
    }

    // Handle dragging annotation
    if (ueState.isDragging && ueState.selectedAnnotation) {
      const anno = ueState.annotations[ueState.selectedAnnotation.pageIndex][ueState.selectedAnnotation.index];
      if (anno.type === 'text') {
        anno.x = x - dragOffsetX;
        anno.y = y - dragOffsetY + anno.fontSize;
      } else {
        anno.x = x - dragOffsetX;
        anno.y = y - dragOffsetY;
      }
      hasMovedOrResized = true;
      ueRedrawAnnotations();
      ueUpdateConfirmButtonPosition(anno);
      return;
    }

    // Handle whiteout preview
    if (!isDrawing || ueState.currentTool !== 'whiteout') return;
    ueRedrawAnnotations();
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.strokeStyle = '#3B82F6';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 3]);
    ctx.fillRect(Math.min(startX, x), Math.min(startY, y), Math.abs(x - startX), Math.abs(y - startY));
    ctx.strokeRect(Math.min(startX, x), Math.min(startY, y), Math.abs(x - startX), Math.abs(y - startY));
    ctx.setLineDash([]);
  }

  function handleUp({ canvas, pageIndex, x, y }) {
    if (ueState.isResizing) {
      if (hasMovedOrResized && preChangeState) {
        ueState.editUndoStack.push(preChangeState);
        ueState.editRedoStack = [];
        if (ueState.editUndoStack.length > 50) ueState.editUndoStack.shift();
      }
      ueState.isResizing = false;
      ueState.resizeHandle = null;
      ueState.resizeStartInfo = null;
      hasMovedOrResized = false;
      preChangeState = null;
      canvas.style.cursor = 'default';
      return;
    }

    if (ueState.isDragging) {
      if (hasMovedOrResized && preChangeState) {
        ueState.editUndoStack.push(preChangeState);
        ueState.editRedoStack = [];
        if (ueState.editUndoStack.length > 50) ueState.editUndoStack.shift();
      }
      ueState.isDragging = false;
      hasMovedOrResized = false;
      preChangeState = null;
      canvas.style.cursor = 'default';
      return;
    }

    if (!isDrawing) return;
    isDrawing = false;

    if (ueState.currentTool === 'whiteout') {
      const width = Math.abs(x - startX);
      const height = Math.abs(y - startY);
      if (width > 5 && height > 5) {
        ueSaveEditUndoState();
        ueState.annotations[pageIndex].push({
          type: 'whiteout',
          x: Math.min(startX, x),
          y: Math.min(startY, y),
          width,
          height
        });
        ueRedrawAnnotations();
      }
    } else if (ueState.currentTool === 'text') {
      ueState.pendingTextPosition = { x: startX, y: startY };
      ueOpenTextModal();
    } else if (ueState.currentTool === 'signature' && state.signatureImage) {
      uePlaceSignature(startX, startY);
    }
  }

  function handleDoubleClick({ canvas, pageIndex, x, y }) {
    if (ueState.currentTool !== 'select') return;

    const result = ueFindAnnotationAt(x, y);
    if (!result) return;

    const anno = ueState.annotations[result.pageIndex][result.index];

    // Unlock signature
    if (anno && anno.type === 'signature' && anno.locked) {
      anno.locked = false;
      ueState.lastLockedToastAnnotation = null;
      ueRedrawAnnotations();
      ueShowConfirmButton(anno, result);
      return;
    }

    // Edit text annotation
    if (!anno || anno.type !== 'text' || anno.locked) return;
    ueCreateInlineTextEditor(anno, result.pageIndex, result.index);
  }
}

// ============================================================
// INLINE TEXT EDITING (double-click to edit text annotations)
// Functions: ueCreateInlineTextEditor
// ============================================================

function ueCreateInlineTextEditor(anno, pageIndex, index) {
  // Remove existing editor
  const existing = document.getElementById('inline-text-editor');
  if (existing) existing.remove();

  const canvas = ueGetCurrentCanvas();
  const wrapper = document.getElementById('ue-canvas-wrapper');
  if (!canvas || !wrapper) return;

  // Use same approach as ueUpdateConfirmButtonPosition for accurate positioning
  const canvasRect = canvas.getBoundingClientRect();
  const wrapperRect = wrapper.getBoundingClientRect();

  const dpr = ueState.devicePixelRatio;
  const scaleX = canvas.clientWidth / (canvas.width / dpr);
  const scaleY = canvas.clientHeight / (canvas.height / dpr);

  // Get text bounds and convert to CSS pixels (with canvas offset)
  const bounds = getTextBounds(anno);
  const left = bounds.x * scaleX + (canvasRect.left - wrapperRect.left);
  const top = bounds.y * scaleY + (canvasRect.top - wrapperRect.top);
  const fontSize = anno.fontSize * scaleX;

  // Build font string
  let fontStyle = '';
  if (anno.italic) fontStyle += 'italic ';
  if (anno.bold) fontStyle += 'bold ';

  const cssFontFamily = CSS_FONT_MAP[anno.fontFamily] || CSS_FONT_MAP['Helvetica'];

  // Hide original text
  anno._editing = true;
  ueRedrawAnnotations();

  // Create contenteditable div (better than textarea for styling control)
  const editor = document.createElement('div');
  editor.id = 'inline-text-editor';
  editor.contentEditable = 'true';
  editor.innerText = anno.text;
  editor.style.cssText = `
    position: absolute;
    left: ${left}px;
    top: ${top}px;
    min-width: 20px;
    font: ${fontStyle}${fontSize}px ${cssFontFamily};
    color: ${anno.color || '#000000'};
    background: transparent;
    border: 1px dashed rgba(0, 123, 255, 0.4);
    padding: 0;
    margin: 0;
    line-height: 1.2;
    white-space: pre-wrap;
    outline: none;
    z-index: 10000;
  `;

  const originalText = anno.text;

  const saveEdit = () => {
    const newText = editor.innerText.trim();
    delete anno._editing;

    if (newText && newText !== originalText) {
      const undoState = JSON.parse(JSON.stringify(ueState.annotations));
      ueState.editUndoStack.push(undoState);
      ueState.editRedoStack = [];
      if (ueState.editUndoStack.length > 50) ueState.editUndoStack.shift();
      anno.text = newText;
    }

    ueRedrawAnnotations();
    editor.remove();
  };

  const cancelEdit = () => {
    delete anno._editing;
    ueRedrawAnnotations();
    editor.remove();
  };

  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  });

  editor.addEventListener('blur', () => setTimeout(saveEdit, 100));

  wrapper.style.position = 'relative';
  wrapper.appendChild(editor);
  editor.focus();

  // Select all text
  const range = document.createRange();
  range.selectNodeContents(editor);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

// ============================================================
// SIGNATURE PLACEMENT & MANAGEMENT
// ============================================================
// USER FLOW: Signature end-to-end
// 1. User clicks "Tanda Tangan" button → ueOpenSignatureModal() → openSignatureModal() [pdf-tools.js]
// 2. User draws/uploads signature → useSignature() or useSignatureFromUpload() [pdf-tools.js]
//    → sets state.signatureImage, calls ueSetTool('signature'), sets ueState.pendingSignature = true
// 3. Signature ghost follows cursor via ueDrawSignaturePreview() (called from canvas mousemove)
// 4. User clicks canvas → uePlaceSignature(x, y) → creates annotation, shows confirm button
// 5. User clicks confirm → ueConfirmSignature() → locks annotation (locked=true)
// 6. Locked signatures show "double-click to unlock" toast on click (once per signature)
//
// Functions: uePlaceSignature, ueDrawSignaturePreview, ueShowConfirmButton,
//            ueUpdateConfirmButtonPosition, ueHideConfirmButton,
//            ueConfirmSignature, ueDeleteSignature, ueUpdateDownloadButtonState
// ============================================================

function uePlaceSignature(x, y) {
  const pageIndex = ueState.selectedPage;
  if (pageIndex < 0 || !state.signatureImage) return;

  ueSaveEditUndoState();
  const img = new Image();
  img.src = state.signatureImage;
  img.onload = () => {
    const aspectRatio = img.width / img.height;
    const sigWidth = 150;
    const sigHeight = sigWidth / aspectRatio;
    const newAnno = {
      type: 'signature',
      image: state.signatureImage,
      x: x - sigWidth / 2,  // Center signature on click
      y: y - sigHeight / 2,
      width: sigWidth,
      height: sigHeight,
      cachedImg: img,
      locked: false
    };
    ueState.annotations[pageIndex].push(newAnno);

    // Select the newly placed signature
    const newIndex = ueState.annotations[pageIndex].length - 1;
    ueState.selectedAnnotation = { pageIndex, index: newIndex };

    // Clear pending state and switch to select tool
    ueState.pendingSignature = false;
    ueState.signaturePreviewPos = null;

    ueRedrawAnnotations();

    // Show confirm button on the new signature
    ueShowConfirmButton(newAnno, ueState.selectedAnnotation);

    // Switch to select tool so user can move/edit the signature
    ueSetTool('select');

    // Update download button to show pulse animation
    ueUpdateDownloadButtonState();

    // Haptic feedback for mobile
    if (mobileState.isTouch && navigator.vibrate) {
      navigator.vibrate(20);
    }

    // Update mobile sign button state
    if (typeof ueMobileUpdateSignButton === 'function') {
      ueMobileUpdateSignButton();
    }
  };
}

// Draw signature preview at cursor
function ueDrawSignaturePreview(x, y) {
  if (!state.signatureImage) return;

  const canvas = ueGetCurrentCanvas();
  const ctx = canvas.getContext('2d');

  const img = new Image();
  img.src = state.signatureImage;

  if (img.complete) {
    const aspectRatio = img.width / img.height;
    const sigWidth = 150;
    const sigHeight = sigWidth / aspectRatio;

    // Draw semi-transparent preview centered on cursor
    ctx.globalAlpha = 0.6;
    ctx.drawImage(img, x - sigWidth / 2, y - sigHeight / 2, sigWidth, sigHeight);
    ctx.globalAlpha = 1.0;

    // Draw dashed border
    ctx.strokeStyle = '#3B82F6';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 3]);
    ctx.strokeRect(x - sigWidth / 2, y - sigHeight / 2, sigWidth, sigHeight);
    ctx.setLineDash([]);
  }
}

// Show confirm button for signature
function ueShowConfirmButton(anno, annoRef) {
  if (anno.type !== 'signature' || anno.locked) {
    ueHideConfirmButton();
    return;
  }

  const btn = document.getElementById('signature-btn-wrapper');
  if (!btn) return;
  btn.style.display = 'inline-flex';

  const confirmBtn = document.getElementById('signature-confirm-btn');
  confirmBtn.onclick = () => ueConfirmSignature(annoRef);

  const deleteBtn = document.getElementById('signature-delete-btn');
  deleteBtn.onclick = () => ueDeleteSignature(annoRef);

  ueUpdateConfirmButtonPosition(anno);
}

// Update confirm button position
function ueUpdateConfirmButtonPosition(anno) {
  const btn = document.getElementById('signature-btn-wrapper');
  if (!btn || btn.style.display === 'none') return;

  const canvas = ueGetCurrentCanvas();
  const wrapper = document.getElementById('ue-canvas-wrapper');
  if (!canvas || !wrapper) return;

  const canvasRect = canvas.getBoundingClientRect();
  const wrapperRect = wrapper.getBoundingClientRect();

  // Convert annotation coords to screen coords
  const scaleX = canvas.clientWidth / (canvas.width / ueState.devicePixelRatio);
  const scaleY = canvas.clientHeight / (canvas.height / ueState.devicePixelRatio);

  const screenX = (anno.x + anno.width / 2) * scaleX + canvasRect.left - wrapperRect.left;
  const screenY = (anno.y + anno.height) * scaleY + canvasRect.top - wrapperRect.top + 8;

  btn.style.left = screenX + 'px';
  btn.style.top = screenY + 'px';
  btn.style.transform = 'translateX(-50%)';
}

// Hide confirm button
function ueHideConfirmButton() {
  const btn = document.getElementById('signature-btn-wrapper');
  if (btn) {
    btn.style.display = 'none';
  }
}

// Confirm (lock) signature
function ueConfirmSignature(annoRef) {
  const anno = ueState.annotations[annoRef.pageIndex][annoRef.index];
  if (anno) {
    anno.locked = true;
    ueHideConfirmButton();
    ueState.selectedAnnotation = null;
    ueRedrawAnnotations();
    showToast('Tanda tangan dikonfirmasi', 'success');
  }
}

// Delete signature
function ueDeleteSignature(annoRef) {
  const anno = ueState.annotations[annoRef.pageIndex][annoRef.index];
  if (anno) {
    ueSaveEditUndoState();
    ueState.annotations[annoRef.pageIndex].splice(annoRef.index, 1);
    ueHideConfirmButton();
    ueState.selectedAnnotation = null;
    ueRedrawAnnotations();
    showToast('Tanda tangan dihapus', 'success');
  }
}

// Update download button state (pulse animation when signatures exist)
function ueUpdateDownloadButtonState() {
  const btn = document.getElementById('ue-download-btn');
  if (!btn) return;

  // Check if any signatures exist
  let hasSignatures = false;
  for (const pageIndex in ueState.annotations) {
    if (ueState.annotations[pageIndex].some(a => a.type === 'signature')) {
      hasSignatures = true;
      break;
    }
  }

  btn.classList.toggle('has-signatures', hasSignatures);
}

// ============================================================
// ANNOTATION DRAWING & HIT TESTING
// Functions: ueRedrawAnnotations, ueDrawAnnotation, ueDrawSelectionHandles,
//            getTextBounds, ueFindAnnotationAt
// ============================================================

function ueRedrawAnnotations() {
  // Redraw annotations on all rendered pages
  ueState.pageCanvases.forEach((pc, i) => {
    if (pc.rendered) ueRedrawPageAnnotations(i);
  });
}

// Draw a single annotation
function ueDrawAnnotation(ctx, anno, isSelected) {
  switch (anno.type) {
    case 'whiteout':
      ctx.fillStyle = 'white';
      ctx.fillRect(anno.x, anno.y, anno.width, anno.height);
      if (isSelected) ueDrawSelectionHandles(ctx, anno.x, anno.y, anno.width, anno.height);
      break;
    case 'text':
      // Skip rendering if currently being edited
      if (anno._editing) break;

      // Build font string with bold/italic and family
      let fontStyle = '';
      if (anno.italic) fontStyle += 'italic ';
      if (anno.bold) fontStyle += 'bold ';

      const cssFontFamily = CSS_FONT_MAP[anno.fontFamily] || CSS_FONT_MAP['Helvetica'];

      ctx.font = `${fontStyle}${anno.fontSize}px ${cssFontFamily}`;
      ctx.fillStyle = anno.color;
      const lines = anno.text.split('\n');
      lines.forEach((line, i) => ctx.fillText(line, anno.x, anno.y + i * anno.fontSize * 1.2));
      if (isSelected) {
        const bounds = getTextBounds(anno, ctx);
        ueDrawSelectionHandles(ctx, bounds.x - 2, bounds.y - 2, bounds.width + 4, bounds.height + 4);
      }
      break;
    case 'signature':
      if (anno.cachedImg && anno.cachedImg.complete) {
        ctx.drawImage(anno.cachedImg, anno.x, anno.y, anno.width, anno.height);
        // Show handles only if selected and not locked
        if (isSelected && !anno.locked) {
          ueDrawSelectionHandles(ctx, anno.x, anno.y, anno.width, anno.height);
        } else if (isSelected && anno.locked) {
          // Draw a subtle locked indicator (just border, no handles)
          ctx.strokeStyle = '#10B981';
          ctx.lineWidth = 2;
          ctx.setLineDash([]);
          ctx.strokeRect(anno.x - 2, anno.y - 2, anno.width + 4, anno.height + 4);
        }
      } else if (anno.image) {
        const img = new Image();
        img.src = anno.image;
        anno.cachedImg = img;
      }
      break;
    case 'watermark':
      ctx.save();
      ctx.translate(anno.x, anno.y);
      ctx.rotate(anno.rotation * Math.PI / 180);
      ctx.font = `${anno.fontSize}px Arial`;
      ctx.fillStyle = anno.color;
      ctx.globalAlpha = anno.opacity;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(anno.text, 0, 0);
      ctx.restore();
      break;
    case 'pageNumber':
      ctx.font = `${anno.fontSize}px Arial`;
      ctx.fillStyle = anno.color;
      ctx.fillText(anno.text, anno.x, anno.y);
      break;
  }
}

// Draw selection handles
function ueDrawSelectionHandles(ctx, x, y, width, height) {
  ctx.strokeStyle = '#3B82F6';
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 3]);
  ctx.strokeRect(x - 2, y - 2, width + 4, height + 4);
  ctx.setLineDash([]);

  const handleSize = 8;
  ctx.fillStyle = '#3B82F6';
  ctx.fillRect(x - handleSize / 2 - 2, y - handleSize / 2 - 2, handleSize, handleSize);
  ctx.fillRect(x + width - handleSize / 2 + 2, y - handleSize / 2 - 2, handleSize, handleSize);
  ctx.fillRect(x - handleSize / 2 - 2, y + height - handleSize / 2 + 2, handleSize, handleSize);
  ctx.fillRect(x + width - handleSize / 2 + 2, y + height - handleSize / 2 + 2, handleSize, handleSize);
}

// Calculate accurate bounds for text annotation (handles multi-line)
function getTextBounds(anno, ctx) {
  if (!ctx) {
    const canvas = ueGetCurrentCanvas();
    ctx = canvas.getContext('2d');
  }

  // Match font styling from rendering
  let fontStyle = '';
  if (anno.italic) fontStyle += 'italic ';
  if (anno.bold) fontStyle += 'bold ';

  const cssFontFamily = CSS_FONT_MAP[anno.fontFamily] || CSS_FONT_MAP['Helvetica'];
  ctx.font = `${fontStyle}${anno.fontSize}px ${cssFontFamily}`;

  // Calculate max width across all lines
  const lines = anno.text.split('\n');
  let maxWidth = 0;
  for (const line of lines) {
    const metrics = ctx.measureText(line);
    maxWidth = Math.max(maxWidth, metrics.width);
  }

  const totalHeight = anno.fontSize * lines.length * 1.2;

  return {
    x: anno.x,
    y: anno.y - anno.fontSize,
    width: maxWidth,
    height: totalHeight
  };
}

// Find annotation at position
function ueFindAnnotationAt(pageIndexOrX, xOrY, maybeY) {
  // Supports both (pageIndex, x, y) and legacy (x, y) signatures
  let pageIndex, x, y;
  if (maybeY !== undefined) {
    pageIndex = pageIndexOrX;
    x = xOrY;
    y = maybeY;
  } else {
    pageIndex = ueState.selectedPage;
    x = pageIndexOrX;
    y = xOrY;
  }

  const annotations = ueState.annotations[pageIndex] || [];
  for (let i = annotations.length - 1; i >= 0; i--) {
    const anno = annotations[i];
    let bounds;
    switch (anno.type) {
      case 'whiteout':
      case 'signature':
        bounds = { x: anno.x, y: anno.y, w: anno.width, h: anno.height };
        break;
      case 'text':
        const textBounds = getTextBounds(anno);
        bounds = { x: textBounds.x, y: textBounds.y, w: textBounds.width, h: textBounds.height };
        break;
      default:
        continue;
    }
    if (x >= bounds.x && x <= bounds.x + bounds.w && y >= bounds.y && y <= bounds.y + bounds.h) {
      return { pageIndex, index: i };
    }
  }
  return null;
}

// ============================================================
// PAGE OPERATIONS (delete, count, status)
// Functions: ueDeletePage, ueUpdatePageCount, ueUpdateStatus
// ============================================================

function ueDeletePage(index) {
  if (ueState.pages.length <= 1) {
    showToast('Tidak bisa menghapus halaman terakhir', 'error');
    return;
  }

  ueSaveUndoState();
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

// Update page count
function ueUpdatePageCount() {
  document.getElementById('ue-page-count').textContent = ueState.pages.length + ' halaman';
}

// Update status (supports different message for mobile)
function ueUpdateStatus(message, mobileMessage) {
  const status = document.getElementById('ue-editor-status');
  if (status) {
    if (mobileMessage && mobileState.isMobile) {
      status.textContent = mobileMessage;
    } else {
      status.textContent = message;
    }
  }
}

// ============================================================
// TOOL SELECTION & MODAL WRAPPERS
// Functions: ueSetTool, ueOpenSignatureModal, ueOpenTextModal, ueConfirmText,
//            ueOpenWatermarkModal, ueOpenPageNumModal, toggleMoreTools,
//            closeMoreTools, ueOpenProtectModal, closeEditorProtectModal,
//            applyEditorProtect
// ============================================================

function ueSetTool(tool) {
  ueState.currentTool = tool;

  // Clear selection and hide confirm button when switching tools
  if (tool !== 'select') {
    ueState.selectedAnnotation = null;
    ueHideConfirmButton();
  }

  // Clear pending signature when switching to a different tool
  if (tool !== 'signature') {
    ueState.pendingSignature = false;
    ueState.signaturePreviewPos = null;
  }

  // Update toolbar UI
  document.querySelectorAll('#unified-editor-workspace .editor-tool-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.editTool === tool);
  });

  // Apply cursor class to ALL page canvases
  ueState.pageCanvases.forEach(pc => {
    pc.canvas.className = 'ue-page-canvas tool-' + tool;
  });

  const toolNames = {
    'select': 'Pilih & pindahkan anotasi',
    'whiteout': 'Klik dan seret untuk menggambar area whiteout',
    'text': 'Klik untuk menambah teks',
    'signature': 'Klik untuk menempatkan tanda tangan'
  };
  ueUpdateStatus(toolNames[tool] || 'Pilih alat untuk mengedit');
}

// Open signature modal (reuse existing)
function ueOpenSignatureModal() {
  // Dismiss the first-use tooltip when clicked
  ueDismissSignatureHint();
  openSignatureModal(); // → pdf-tools.js
  // After signature is created, switch to signature placement mode
}

// Open text modal — delegates to shared modal in pdf-tools.js
function ueOpenTextModal() {
  openTextModal(); // → pdf-tools.js
}

// Confirm text input - modified to work with unified editor
function ueConfirmText() {
  const settings = getTextModalSettings(); // → pdf-tools.js

  if (!settings.text) {
    showToast('Masukkan teks terlebih dahulu', 'error');
    return;
  }

  ueSaveEditUndoState();
  ueState.annotations[ueState.selectedPage].push({
    type: 'text',
    text: settings.text,
    x: ueState.pendingTextPosition.x,
    y: ueState.pendingTextPosition.y,
    fontSize: settings.fontSize,
    color: settings.color,
    fontFamily: settings.fontFamily,
    bold: settings.bold,
    italic: settings.italic
  });

  document.getElementById('text-input-modal').classList.remove('active');
  ueRedrawAnnotations();
  ueState.pendingTextPosition = null;
  ueSetTool('select'); // Reset to select tool after adding text
}

// Watermark modal
function ueOpenWatermarkModal() {
  document.getElementById('editor-watermark-modal').classList.add('active');
  pushModalState('editor-watermark-modal');
}

// Page number modal
function ueOpenPageNumModal() {
  document.getElementById('editor-pagenum-modal').classList.add('active');
  pushModalState('editor-pagenum-modal');
}

// More Tools Dropdown
function toggleMoreTools(e) {
  e.stopPropagation();
  const btn = document.getElementById('more-tools-btn');
  const dropdown = document.getElementById('more-tools-dropdown');

  if (dropdown.classList.contains('active')) {
    dropdown.classList.remove('active');
  } else {
    // Position dropdown below the button
    const rect = btn.getBoundingClientRect();
    dropdown.style.top = (rect.bottom + 4) + 'px';
    dropdown.style.left = rect.left + 'px';
    dropdown.classList.add('active');
  }
}

function closeMoreTools() {
  document.getElementById('more-tools-dropdown').classList.remove('active');
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
  const container = document.querySelector('.editor-more-tools');
  if (container && !container.contains(e.target)) {
    closeMoreTools();
  }
});

// Kunci PDF modal
function ueOpenProtectModal() {
  document.getElementById('editor-protect-modal').classList.add('active');
  document.getElementById('editor-protect-password').value = '';
  document.getElementById('editor-protect-confirm').value = '';
  pushModalState('editor-protect-modal');
}

function closeEditorProtectModal(skipHistoryBack = false) {
  document.getElementById('editor-protect-modal').classList.remove('active');
  navHistory.currentModal = null;
  if (!skipHistoryBack && navHistory.currentView === 'modal') {
    history.back();
  }
}

async function applyEditorProtect() {
  const password = document.getElementById('editor-protect-password').value;
  const confirm = document.getElementById('editor-protect-confirm').value;

  if (!password) {
    showToast('Masukkan password', 'error');
    return;
  }

  if (password !== confirm) {
    showToast('Password tidak cocok', 'error');
    return;
  }

  try {
    // Build PDF with current annotations first
    const pdfBytes = await ueBuildFinalPDF();
    const pdfDoc = await PDFLib.PDFDocument.load(pdfBytes);

    const protectedBytes = await pdfDoc.save({
      userPassword: password,
      ownerPassword: password,
    });

    downloadBlob(new Blob([protectedBytes], { type: 'application/pdf' }), getDownloadFilename({ originalName: ueState.sourceFiles[0]?.name, extension: 'pdf' }));

    closeEditorProtectModal();
    showToast('PDF berhasil dikunci!', 'success');
  } catch (error) {
    console.error('Error protecting PDF:', error);
    showToast('Gagal mengunci PDF', 'error');
  }
}

// ============================================================
// UNDO / REDO (page operations + annotation operations)
// Functions: ueSaveUndoState, ueUndo, ueRedo, ueRestorePages,
//            ueSaveEditUndoState, ueUndoAnnotation, ueRedoAnnotation,
//            ueClearPageAnnotations
// ============================================================

function ueSaveUndoState() {
  ueState.undoStack.push(JSON.parse(JSON.stringify(ueState.pages.map(p => ({
    pageNum: p.pageNum,
    sourceIndex: p.sourceIndex,
    sourceName: p.sourceName,
    rotation: p.rotation
  })))));
  ueState.redoStack = [];
  if (ueState.undoStack.length > 50) ueState.undoStack.shift();
}

function ueUndo() {
  if (ueState.undoStack.length === 0) return;
  // Save current state to redo
  ueState.redoStack.push(JSON.parse(JSON.stringify(ueState.pages.map(p => ({
    pageNum: p.pageNum,
    sourceIndex: p.sourceIndex,
    sourceName: p.sourceName,
    rotation: p.rotation
  })))));

  const prevState = ueState.undoStack.pop();
  // Restore pages - need to regenerate thumbnails
  ueRestorePages(prevState);
}

function ueRedo() {
  if (ueState.redoStack.length === 0) return;
  // Save current to undo
  ueState.undoStack.push(JSON.parse(JSON.stringify(ueState.pages.map(p => ({
    pageNum: p.pageNum,
    sourceIndex: p.sourceIndex,
    sourceName: p.sourceName,
    rotation: p.rotation
  })))));

  const nextState = ueState.redoStack.pop();
  ueRestorePages(nextState);
}

async function ueRestorePages(pagesData) {
  // Regenerate pages from pagesData
  ueState.pages = [];
  for (const pageData of pagesData) {
    const source = ueState.sourceFiles[pageData.sourceIndex];
    const pdf = await pdfjsLib.getDocument({ data: source.bytes.slice() }).promise;
    const page = await pdf.getPage(pageData.pageNum + 1);
    const viewport = page.getViewport({ scale: 0.5, rotation: pageData.rotation });

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    ueState.pages.push({
      ...pageData,
      canvas
    });
  }
  ueState.pageCaches = {};
  ueCreatePageSlots();
  ueRenderThumbnails();
  ueUpdatePageCount();
  if (ueState.selectedPage >= ueState.pages.length) {
    ueState.selectedPage = ueState.pages.length - 1;
  }
  if (ueState.selectedPage >= 0) {
    ueSelectPage(ueState.selectedPage);
  }
}

// Undo/Redo for annotations
function ueSaveEditUndoState() {
  ueState.editUndoStack.push(JSON.parse(JSON.stringify(ueState.annotations)));
  ueState.editRedoStack = [];
  if (ueState.editUndoStack.length > 50) ueState.editUndoStack.shift();
}

function ueUndoAnnotation() {
  if (ueState.editUndoStack.length === 0) return;
  ueState.editRedoStack.push(JSON.parse(JSON.stringify(ueState.annotations)));
  ueState.annotations = ueState.editUndoStack.pop();
  ueState.selectedAnnotation = null;
  ueRedrawAnnotations();
}

function ueRedoAnnotation() {
  if (ueState.editRedoStack.length === 0) return;
  ueState.editUndoStack.push(JSON.parse(JSON.stringify(ueState.annotations)));
  ueState.annotations = ueState.editRedoStack.pop();
  ueState.selectedAnnotation = null;
  ueRedrawAnnotations();
}

// Clear page annotations
function ueClearPageAnnotations() {
  if (ueState.selectedPage < 0) return;
  if (ueState.annotations[ueState.selectedPage].length === 0) return;

  ueSaveEditUndoState();
  ueState.annotations[ueState.selectedPage] = [];
  ueState.selectedAnnotation = null;
  ueRedrawAnnotations();
  showToast('Semua edit di halaman ini dihapus', 'success');
}

// ============================================================
// PDF EXPORT (build final PDF with annotations)
// Functions: ueDownload (includes ueBuildFinalPDF logic inline)
// Note: Contains font embedding (Montserrat, Carlito) from /fonts/
// ============================================================
//
// USER FLOW: Download PDF
// 1. User clicks "Download PDF" or Ctrl+S → ueDownload()
// 2. Optimization check: if single file, no edits, no rotation → download original bytes (skip re-encoding)
// 3. Otherwise: create new PDFDocument via pdf-lib →
//    for each page: copy from source → apply rotation → embed annotations (whiteout, text, signatures)
// 4. Font embedding: standard fonts (Helvetica, Times, Courier) built-in;
//    custom fonts (Montserrat, Carlito) fetched from /fonts/ and embedded via fontkit
// 5. Save with useObjectStreams compression → downloadBlob()

async function ueDownload() {
  if (ueState.pages.length === 0) {
    showToast('Tidak ada halaman untuk diunduh', 'error');
    return;
  }

  const downloadBtn = document.getElementById('ue-download-btn');
  const originalText = downloadBtn.innerHTML;

  // Optimization: If PDF is unmodified, download original bytes to avoid pdf-lib re-encoding bloat
  // Check if: single file + no reordering + no rotations + no annotations
  if (ueState.sourceFiles.length === 1) {
    let isUnmodified = true;
    const sourceFile = ueState.sourceFiles[0];

    // Check if pages are in original order and unrotated
    for (let i = 0; i < ueState.pages.length; i++) {
      const page = ueState.pages[i];
      if (page.sourceIndex !== 0 || page.pageNum !== i || page.rotation !== 0) {
        isUnmodified = false;
        break;
      }

      // Check if page has annotations
      const annotations = ueState.annotations[i] || [];
      if (annotations.length > 0) {
        isUnmodified = false;
        break;
      }
    }

    // If unmodified, download original bytes without re-encoding
    if (isUnmodified) {
      console.log('[PDF Download] Unmodified PDF detected, downloading original bytes');
      downloadBlob(
        new Blob([sourceFile.bytes], { type: 'application/pdf' }),
        getDownloadFilename({ originalName: sourceFile.name, extension: 'pdf' })
      );
      showToast('PDF berhasil diunduh!', 'success');
      return;
    }
  }

  // Show loading state
  downloadBtn.disabled = true;
  downloadBtn.innerHTML = `
    <svg class="btn-spinner" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M12 2v4m0 12v4m-7.07-3.93l2.83-2.83m8.48-8.48l2.83-2.83M2 12h4m12 0h4m-3.93 7.07l-2.83-2.83M7.76 7.76L4.93 4.93"/>
    </svg>
    Memproses...
  `;

  try {
    const newDoc = await PDFLib.PDFDocument.create();
    newDoc.registerFontkit(fontkit); // Register fontkit for custom font embedding
    const fontCache = {};

    // Self-hosted fonts for offline support and privacy
    const customFontUrls = {
      'Montserrat': 'fonts/montserrat-regular.woff2',
      'Montserrat-Bold': 'fonts/montserrat-bold.woff2',
      'Montserrat-Italic': 'fonts/montserrat-italic.woff2',
      'Montserrat-BoldItalic': 'fonts/montserrat-bolditalic.woff2',
      'Carlito': 'fonts/carlito-regular.woff2',
      'Carlito-Bold': 'fonts/carlito-bold.woff2',
      'Carlito-Italic': 'fonts/carlito-italic.woff2',
      'Carlito-BoldItalic': 'fonts/carlito-bolditalic.woff2'
    };

    // Helper to get the right font based on family, bold, italic
    async function getFont(fontFamily, bold, italic) {
      console.log('[PDF Export] getFont called:', { fontFamily, bold, italic });
      let fontName = fontFamily || 'Helvetica';
      let isCustomFont = false;

      // Map font family + style to pdf-lib StandardFonts or custom font names
      if (fontFamily === 'Helvetica') {
        if (bold && italic) fontName = 'HelveticaBoldOblique';
        else if (bold) fontName = 'HelveticaBold';
        else if (italic) fontName = 'HelveticaOblique';
        else fontName = 'Helvetica';
      } else if (fontFamily === 'Times-Roman') {
        if (bold && italic) fontName = 'TimesRomanBoldItalic';
        else if (bold) fontName = 'TimesRomanBold';
        else if (italic) fontName = 'TimesRomanItalic';
        else fontName = 'TimesRoman';
      } else if (fontFamily === 'Courier') {
        if (bold && italic) fontName = 'CourierBoldOblique';
        else if (bold) fontName = 'CourierBold';
        else if (italic) fontName = 'CourierOblique';
        else fontName = 'Courier';
      } else if (fontFamily === 'Montserrat') {
        isCustomFont = true;
        if (bold && italic) fontName = 'Montserrat-BoldItalic';
        else if (bold) fontName = 'Montserrat-Bold';
        else if (italic) fontName = 'Montserrat-Italic';
        else fontName = 'Montserrat';
      } else if (fontFamily === 'Carlito') {
        isCustomFont = true;
        if (bold && italic) fontName = 'Carlito-BoldItalic';
        else if (bold) fontName = 'Carlito-Bold';
        else if (italic) fontName = 'Carlito-Italic';
        else fontName = 'Carlito';
      } else {
        // Unknown font family - fall back to Helvetica
        console.warn('[PDF Export] Unknown font family:', fontFamily, '- falling back to Helvetica');
        if (bold && italic) fontName = 'HelveticaBoldOblique';
        else if (bold) fontName = 'HelveticaBold';
        else if (italic) fontName = 'HelveticaOblique';
        else fontName = 'Helvetica';
      }

      if (!fontCache[fontName]) {
        if (isCustomFont) {
          // Fetch and embed custom font from local files
          try {
            const fontUrl = customFontUrls[fontName];
            const fontResponse = await fetch(fontUrl);
            const fontBytes = await fontResponse.arrayBuffer();
            fontCache[fontName] = await newDoc.embedFont(fontBytes);
            console.log('[PDF Export] ✓ Embedded font:', fontName, `(${(fontBytes.byteLength / 1024).toFixed(1)}KB)`);
          } catch (err) {
            console.error('[PDF Export] ✗ Failed to load font:', fontName, err);
            // Fallback to Helvetica
            const fallbackName = bold ? 'Helvetica-Bold' : 'Helvetica';
            if (!fontCache[fallbackName]) {
              fontCache[fallbackName] = await newDoc.embedFont(PDFLib.StandardFonts[fallbackName]);
            }
            return fontCache[fallbackName];
          }
        } else {
          // Embed standard PDF font
          const standardFont = PDFLib.StandardFonts[fontName];
          if (!standardFont) {
            console.error('[PDF Export] Invalid standard font name:', fontName, '- available fonts:', Object.keys(PDFLib.StandardFonts));
            // Fall back to Helvetica
            const fallback = bold ? PDFLib.StandardFonts.HelveticaBold : PDFLib.StandardFonts.Helvetica;
            fontCache[fontName] = await newDoc.embedFont(fallback);
          } else {
            fontCache[fontName] = await newDoc.embedFont(standardFont);
          }
        }
      }
      return fontCache[fontName];
    }

    for (let i = 0; i < ueState.pages.length; i++) {
      const pageInfo = ueState.pages[i];
      const source = ueState.sourceFiles[pageInfo.sourceIndex];
      const srcDoc = await PDFLib.PDFDocument.load(source.bytes);

      const [copiedPage] = await newDoc.copyPages(srcDoc, [pageInfo.pageNum]);

      // Apply rotation
      if (pageInfo.rotation !== 0) {
        copiedPage.setRotation(PDFLib.degrees(pageInfo.rotation));
      }

      newDoc.addPage(copiedPage);

      // Apply annotations
      const annotations = ueState.annotations[i] || [];
      if (annotations.length > 0) {
        const page = newDoc.getPages()[i];
        const { width, height } = page.getSize();
        const scaleInfo = ueState.pageScales[i] || { canvasWidth: width, canvasHeight: height };
        const scaleX = width / scaleInfo.canvasWidth;
        const scaleY = height / scaleInfo.canvasHeight;

        for (const anno of annotations) {
          switch (anno.type) {
            case 'whiteout':
              page.drawRectangle({
                x: anno.x * scaleX,
                y: height - (anno.y + anno.height) * scaleY,
                width: anno.width * scaleX,
                height: anno.height * scaleY,
                color: PDFLib.rgb(1, 1, 1)
              });
              break;
            case 'text':
              const textFont = await getFont(anno.fontFamily, anno.bold, anno.italic);
              const lines = anno.text.split('\n');
              const hexColor = anno.color.replace('#', '');
              const r = parseInt(hexColor.substr(0, 2), 16) / 255;
              const g = parseInt(hexColor.substr(2, 2), 16) / 255;
              const b = parseInt(hexColor.substr(4, 2), 16) / 255;
              for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
                page.drawText(lines[lineIdx], {
                  x: anno.x * scaleX,
                  y: height - (anno.y + lineIdx * anno.fontSize * 1.2) * scaleY,
                  size: anno.fontSize * scaleY,
                  font: textFont,
                  color: PDFLib.rgb(r, g, b)
                });
              }
              break;
            case 'signature':
              // Detect image format from data URL and use appropriate embed function
              const isJpeg = anno.image.startsWith('data:image/jpeg');
              const signatureImage = isJpeg
                ? await newDoc.embedJpg(anno.image)
                : await newDoc.embedPng(anno.image);
              page.drawImage(signatureImage, {
                x: anno.x * scaleX,
                y: height - (anno.y + anno.height) * scaleY,
                width: anno.width * scaleX,
                height: anno.height * scaleY
              });
              break;
            case 'watermark':
              const wmFont = await getFont('Helvetica', false, false);
              const wmHex = anno.color.replace('#', '');
              page.drawText(anno.text, {
                x: anno.x * scaleX,
                y: height - anno.y * scaleY,
                size: anno.fontSize * scaleY,
                font: wmFont,
                color: PDFLib.rgb(
                  parseInt(wmHex.substr(0, 2), 16) / 255,
                  parseInt(wmHex.substr(2, 2), 16) / 255,
                  parseInt(wmHex.substr(4, 2), 16) / 255
                ),
                opacity: anno.opacity,
                rotate: PDFLib.degrees(anno.rotation)
              });
              break;
          }
        }
      }
    }

    // Save with compression to reduce file size
    const pdfBytes = await newDoc.save({
      useObjectStreams: true,  // Enable object streams for better compression
      addDefaultPage: false     // Don't add blank page if empty
    });
    downloadBlob(new Blob([pdfBytes], { type: 'application/pdf' }), getDownloadFilename({ originalName: ueState.sourceFiles[0]?.name, extension: 'pdf' }));
    showToast('PDF berhasil diunduh!', 'success');

  } catch (error) {
    console.error('Error saving PDF:', error);
    showToast('Gagal menyimpan PDF', 'error');
  } finally {
    // Restore button state
    downloadBtn.disabled = false;
    downloadBtn.innerHTML = originalText;
  }
}

// ============================================================
// EDITOR LIFECYCLE (reset, init, signature hints, sidebar toggle)
// Functions: ueReset, ueShowSignatureHint, ueDismissSignatureHint,
//            initUnifiedEditor, ueToggleSidebar
// ============================================================

function ueReset() {
  ueState.pages = [];
  ueState.sourceFiles = [];
  ueState.selectedPage = -1;
  ueState.currentTool = null;
  ueState.annotations = {};
  ueState.undoStack = [];
  ueState.redoStack = [];
  ueState.editUndoStack = [];
  ueState.editRedoStack = [];
  ueState.selectedAnnotation = null;
  ueState.pendingTextPosition = null;
  ueState.pageScales = {};
  ueState.pageCaches = {};
  ueState.pageCanvases = [];
  if (ueState.pageObserver) { ueState.pageObserver.disconnect(); ueState.pageObserver = null; }
  ueState.scrollSyncEnabled = true;
  ueState.zoomLevel = 1.0;
  ueUpdateZoomDisplay();

  document.getElementById('ue-empty-state').style.display = 'flex';
  // Clear pages container
  const pagesContainer = document.getElementById('ue-pages-container');
  if (pagesContainer) {
    pagesContainer.innerHTML = '';
    pagesContainer.style.display = 'none';
  }
  document.getElementById('ue-download-btn').disabled = true;
  ueRenderThumbnails();
  ueUpdatePageCount();
}

// Show first-use signature tooltip
function ueShowSignatureHint() {
  const HINT_KEY = 'pdflokal_signature_hint_shown';
  if (localStorage.getItem(HINT_KEY)) return;

  const tooltip = document.getElementById('signature-hint-tooltip');
  if (!tooltip) return;

  // Show tooltip after a short delay
  setTimeout(() => {
    tooltip.classList.add('show');
  }, 500);

  // Auto-dismiss after 5 seconds
  setTimeout(() => {
    ueDismissSignatureHint();
  }, 5500);
}

// Dismiss signature hint tooltip
function ueDismissSignatureHint() {
  const HINT_KEY = 'pdflokal_signature_hint_shown';
  const tooltip = document.getElementById('signature-hint-tooltip');
  if (tooltip) {
    tooltip.classList.remove('show');
  }
  localStorage.setItem(HINT_KEY, 'true');
}

// Initialize when showing unified editor
function initUnifiedEditor() {
  initUnifiedEditorInput();
  ueState.devicePixelRatio = window.devicePixelRatio || 1;

  // Show first-use signature tooltip
  ueShowSignatureHint();

  // Setup drop zone for thumbnails area
  const thumbnails = document.getElementById('ue-thumbnails');
  if (thumbnails && !thumbnails._dropSetup) {
    thumbnails._dropSetup = true;
    thumbnails.addEventListener('dragover', (e) => {
      e.preventDefault();
      thumbnails.classList.add('drag-over');
    });
    thumbnails.addEventListener('dragleave', () => {
      thumbnails.classList.remove('drag-over');
    });
    thumbnails.addEventListener('drop', async (e) => {
      e.preventDefault();
      thumbnails.classList.remove('drag-over');
      if (e.dataTransfer.files.length > 0) {
        showFullscreenLoading('Menambahkan PDF...');
        try {
          await ueAddFiles(e.dataTransfer.files);
        } catch (error) {
          console.error('Error adding PDF:', error);
          showToast('Gagal menambahkan PDF', 'error');
        } finally {
          hideFullscreenLoading();
        }
      }
    });
  }

  // Setup scroll sync for continuous vertical scroll
  ueSetupScrollSync();

  // Setup resize handler — re-render visible pages on window resize
  if (!window._ueResizeHandler) {
    let resizeTimeout;
    window._ueResizeHandler = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        if (state.currentTool === 'unified-editor' && ueState.pages.length > 0) {
          ueSetWrapperHeight();
          ueRenderVisiblePages();
        }
      }, 200);
    };
    window.addEventListener('resize', window._ueResizeHandler);
  }
}

// Toggle sidebar visibility
function ueToggleSidebar() {
  const sidebar = document.getElementById('unified-sidebar');
  const toggleBtn = sidebar.querySelector('.sidebar-toggle-btn');

  sidebar.classList.toggle('collapsed');

  // Update button title
  const isCollapsed = sidebar.classList.contains('collapsed');
  toggleBtn.title = isCollapsed ? 'Tampilkan sidebar' : 'Sembunyikan sidebar';

  // Re-render visible pages to recalculate canvas size after transition
  setTimeout(() => {
    if (ueState.pages.length > 0) {
      ueRenderVisiblePages();
    }
  }, 350); // Wait for CSS transition to complete
}

// ============================================================
// PAGE MANAGER MODAL ("Gabungkan" / Merge modal)
// ============================================================
// State: uePmState {}
// Functions: uePmOpenModal, uePmCloseModal, uePmUpdateUI, uePmRenderPages,
//            uePmEnableDragReorder, uePmReindexAnnotations, uePmRotatePage,
//            uePmDeletePage, uePmToggleExtractMode, uePmTogglePageSelection,
//            uePmSelectAll, uePmDeselectAll, uePmUpdateSelectionCount,
//            uePmExtractSelected, initUePmFileInput, initUePmImageInput

// uePmState is now defined in js/lib/state.js and available via window.uePmState

// Open the page manager modal
function uePmOpenModal() {
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

  // Initialize file input handlers
  initUePmFileInput();
  initUePmImageInput();
}

// Close the page manager modal
function uePmCloseModal(skipHistoryBack = false) {
  uePmState.isOpen = false;
  document.getElementById('ue-gabungkan-modal').classList.remove('active');

  // Clean up drop indicator
  if (uePmState.dropIndicator && uePmState.dropIndicator.parentNode) {
    uePmState.dropIndicator.remove();
  }

  // Reset extract mode UI
  document.getElementById('ue-pm-extract-mode-btn').classList.remove('active');
  document.getElementById('ue-pm-extract-actions').style.display = 'none';
  document.getElementById('ue-pm-extract-btn').style.display = 'none';

  // Sync thumbnails in main sidebar
  ueRenderThumbnails();
  ueUpdatePageCount();

  // Re-render selected page if needed
  if (ueState.selectedPage >= 0) {
    ueRenderSelectedPage();
  }

  navHistory.currentModal = null;
  if (!skipHistoryBack && navHistory.currentView === 'modal') {
    history.back();
  }
}

// Update modal UI elements
function uePmUpdateUI() {
  document.getElementById('ue-pm-page-count').textContent = ueState.pages.length + ' halaman';
}

// Render all pages in the modal grid
function uePmRenderPages() {
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

    // Check if selected for extract
    if (uePmState.selectedForExtract.includes(index)) {
      item.classList.add('selected');
    }

    // Canvas thumbnail
    const canvas = document.createElement('canvas');
    canvas.width = page.canvas.width;
    canvas.height = page.canvas.height;
    canvas.getContext('2d').drawImage(page.canvas, 0, 0);
    if (page.rotation !== 0) {
      canvas.style.transform = `rotate(${page.rotation}deg)`;
    }
    item.appendChild(canvas);

    // Page number badge
    const numBadge = document.createElement('span');
    numBadge.className = 'ue-pm-page-number';
    numBadge.textContent = index + 1;
    item.appendChild(numBadge);

    // Source badge (if multiple sources)
    if (ueState.sourceFiles.length > 1) {
      const srcBadge = document.createElement('span');
      srcBadge.className = 'ue-pm-source-badge';
      srcBadge.textContent = page.sourceName;
      item.appendChild(srcBadge);
    }

    // Rotation badge (if rotated)
    if (page.rotation !== 0) {
      const rotBadge = document.createElement('span');
      rotBadge.className = 'ue-pm-rotation-badge';
      rotBadge.textContent = page.rotation + '°';
      item.appendChild(rotBadge);
    }

    // Action buttons (rotate and delete) - always visible
    const actions = document.createElement('div');
    actions.className = 'ue-pm-page-actions';

    // Rotate button
    const rotateBtn = document.createElement('button');
    rotateBtn.className = 'ue-pm-page-action-btn';
    rotateBtn.title = 'Putar 90°';
    rotateBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.85.83 6.72 2.24"/><path d="M21 3v6h-6"/></svg>';
    rotateBtn.onclick = (e) => {
      e.stopPropagation();
      uePmRotatePage(index, 90);
    };
    actions.appendChild(rotateBtn);

    // Delete button
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

    // Checkbox for extract mode
    const checkbox = document.createElement('div');
    checkbox.className = 'ue-pm-page-checkbox';
    checkbox.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
    item.appendChild(checkbox);

    // Click handler for extract mode selection
    item.onclick = () => {
      if (uePmState.extractMode) {
        uePmTogglePageSelection(index);
      }
    };

    container.appendChild(item);
  });

  // Enable drag-drop if not in extract mode
  if (!uePmState.extractMode) {
    uePmEnableDragReorder();
  }

  uePmUpdateUI();
}

// Enable drag-drop reordering
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

      // Track the page user is currently viewing
      const viewedPage = ueState.pages[ueState.selectedPage];

      // Calculate where to insert (before removing the dragged item)
      let insertAt = insertBefore ? targetIndex : targetIndex + 1;

      // Remove the page first
      const [movedPage] = ueState.pages.splice(draggedIndex, 1);

      // Adjust insertion point if we removed from before it
      if (draggedIndex < insertAt) {
        insertAt--;
      }

      // Insert at new position
      ueState.pages.splice(insertAt, 0, movedPage);

      // Reindex annotations
      uePmReindexAnnotations(draggedIndex, insertAt);

      // Update selectedPage to follow the viewed page
      const newViewedIndex = ueState.pages.indexOf(viewedPage);
      if (newViewedIndex !== -1) {
        ueState.selectedPage = newViewedIndex;
      }

      // Re-render
      uePmRenderPages();

      removeDropIndicator();
    });
  });

  // Handle container-level dragover (for edges and indicator)
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

  // Handle container-level drop (catches drops on indicator or container)
  container.addEventListener('drop', (e) => {
    if (uePmState.extractMode || !draggedItem) return;
    e.preventDefault();

    // Find where the indicator is positioned
    const indicator = uePmState.dropIndicator;
    if (!indicator || !indicator.parentNode) {
      removeDropIndicator();
      return;
    }

    // Find the insertion index based on indicator position
    const items = Array.from(container.querySelectorAll('.ue-pm-page-item'));
    let insertAt = 0;

    // Find which item the indicator is before
    const nextSibling = indicator.nextElementSibling;
    if (nextSibling && nextSibling.classList.contains('ue-pm-page-item')) {
      insertAt = parseInt(nextSibling.dataset.index);
    } else {
      // Indicator is at the end
      insertAt = items.length;
    }

    // Track the page user is currently viewing
    const viewedPage = ueState.pages[ueState.selectedPage];

    // Remove the page first
    const [movedPage] = ueState.pages.splice(draggedIndex, 1);

    // Adjust insertion point if we removed from before it
    if (draggedIndex < insertAt) {
      insertAt--;
    }

    // Insert at new position
    ueState.pages.splice(insertAt, 0, movedPage);

    // Reindex annotations
    uePmReindexAnnotations(draggedIndex, insertAt);

    // Update selectedPage to follow the viewed page
    const newViewedIndex = ueState.pages.indexOf(viewedPage);
    if (newViewedIndex !== -1) {
      ueState.selectedPage = newViewedIndex;
    }

    // Re-render
    uePmRenderPages();

    removeDropIndicator();
  });
}

// Reindex annotations after page reorder
function uePmReindexAnnotations(fromIndex, toIndex) {
  const oldAnnotations = { ...ueState.annotations };
  ueState.annotations = {};

  // Create mapping of old index to new index
  const indexMap = {};
  for (let i = 0; i < ueState.pages.length; i++) {
    indexMap[i] = i;
  }

  // Adjust indices based on the move
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

  // Remap annotations to new indices
  Object.keys(oldAnnotations).forEach(key => {
    const oldIdx = parseInt(key);
    // Find which page this annotation belonged to
    // The page at old position 'key' is now at a new position
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

// Rotate a page
function uePmRotatePage(index, degrees) {
  ueSaveUndoState();

  const page = ueState.pages[index];
  page.rotation = ((page.rotation + degrees) % 360 + 360) % 360;

  // Update thumbnail in modal
  const item = document.querySelector(`.ue-pm-page-item[data-index="${index}"]`);
  if (item) {
    const canvas = item.querySelector('canvas');
    if (canvas) {
      canvas.style.transform = page.rotation !== 0 ? `rotate(${page.rotation}deg)` : '';
    }

    // Update rotation badge
    let rotBadge = item.querySelector('.ue-pm-rotation-badge');
    if (page.rotation !== 0) {
      if (!rotBadge) {
        rotBadge = document.createElement('span');
        rotBadge.className = 'ue-pm-rotation-badge';
        // Insert before actions div
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

// Delete a page
function uePmDeletePage(index) {
  if (ueState.pages.length <= 1) {
    showToast('Tidak bisa menghapus halaman terakhir', 'error');
    return;
  }

  if (!confirm('Hapus halaman ini?')) {
    return;
  }

  ueSaveUndoState();

  // Track if we're deleting the viewed page
  const wasViewingDeletedPage = (ueState.selectedPage === index);
  const viewedPage = ueState.pages[ueState.selectedPage];

  // Remove page
  ueState.pages.splice(index, 1);
  delete ueState.annotations[index];

  // Reindex annotations after deletion
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

  // Update viewed page index
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

  // Update extract selections if needed
  uePmState.selectedForExtract = uePmState.selectedForExtract
    .filter(i => i !== index)
    .map(i => i > index ? i - 1 : i);

  // Re-render
  uePmRenderPages();
  uePmUpdateSelectionCount();

  showToast('Halaman dihapus', 'success');
}

// Toggle extract mode
function uePmToggleExtractMode() {
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

// Toggle page selection for extract
function uePmTogglePageSelection(index) {
  const idx = uePmState.selectedForExtract.indexOf(index);
  if (idx === -1) {
    uePmState.selectedForExtract.push(index);
  } else {
    uePmState.selectedForExtract.splice(idx, 1);
  }

  // Update UI
  const item = document.querySelector(`.ue-pm-page-item[data-index="${index}"]`);
  if (item) {
    item.classList.toggle('selected', uePmState.selectedForExtract.includes(index));
  }

  uePmUpdateSelectionCount();
}

// Select all pages for extract
function uePmSelectAll() {
  uePmState.selectedForExtract = ueState.pages.map((_, i) => i);
  document.querySelectorAll('.ue-pm-page-item').forEach(item => {
    item.classList.add('selected');
  });
  uePmUpdateSelectionCount();
}

// Deselect all pages
function uePmDeselectAll() {
  uePmState.selectedForExtract = [];
  document.querySelectorAll('.ue-pm-page-item').forEach(item => {
    item.classList.remove('selected');
  });
  uePmUpdateSelectionCount();
}

// Update selection count display
function uePmUpdateSelectionCount() {
  const count = uePmState.selectedForExtract.length;
  document.getElementById('ue-pm-selection-count').textContent = count + ' halaman dipilih';

  const extractBtn = document.getElementById('ue-pm-extract-btn');
  extractBtn.disabled = count === 0;
  extractBtn.textContent = count > 0
    ? `Split ${count} halaman sebagai PDF baru`
    : 'Split sebagai PDF baru';
}

// Extract selected pages to new PDF
async function uePmExtractSelected() {
  if (uePmState.selectedForExtract.length === 0) {
    showToast('Pilih halaman yang ingin di-split', 'error');
    return;
  }

  try {
    // Sort indices for consistent order
    const sortedIndices = [...uePmState.selectedForExtract].sort((a, b) => a - b);

    // Create new PDF
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

    // Exit extract mode after successful extraction
    uePmToggleExtractMode();

  } catch (error) {
    console.error('Error splitting pages:', error);
    showToast('Gagal split halaman', 'error');
  }
}

// Initialize file input for adding pages from modal
function initUePmFileInput() {
  const input = document.getElementById('ue-pm-file-input');
  if (input && !input._uePmInitialized) {
    input._uePmInitialized = true;
    input.addEventListener('change', async (e) => {
      if (e.target.files.length > 0) {
        showFullscreenLoading('Menambahkan PDF...');
        try {
          await ueAddFiles(e.target.files);
          // Re-render modal content if open
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
          // Re-render modal content if open
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
