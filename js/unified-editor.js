// ============================================================
// UNIFIED EDITOR WORKSPACE
// ============================================================

// State for unified editor
const ueState = {
  pages: [],            // Array of { pageNum, sourceIndex, sourceName, rotation, canvas }
  sourceFiles: [],      // Array of { name, bytes }
  selectedPage: -1,     // Currently selected page index
  currentTool: null,    // Current edit tool
  annotations: {},      // Per-page annotations: { pageIndex: [...] }
  undoStack: [],        // Undo stack for page operations
  redoStack: [],        // Redo stack for page operations
  editUndoStack: [],    // Undo stack for annotations
  editRedoStack: [],    // Redo stack for annotations
  selectedAnnotation: null,
  pendingTextPosition: null,
  pageScales: {},
  devicePixelRatio: 1,
  canvasSetup: false,
  pageCache: null,      // Cached rendered page for smooth dragging
  zoomLevel: 1.0,       // Zoom level (1.0 = fit width)
  // Signature enhancements
  pendingSignature: false,      // Whether signature is attached to cursor
  signaturePreviewPos: null,    // Current cursor position for preview { x, y }
  resizeHandle: null,           // Current resize handle being dragged ('tl', 'tr', 'bl', 'br')
  resizeStartInfo: null,        // Initial annotation state when resize started
  // Touch interaction state (shared with pinch-to-zoom handler)
  isDragging: false,            // Whether annotation is being dragged
  isResizing: false,            // Whether annotation is being resized
  // Sidebar drag-drop state
  sidebarDropIndicator: null,
  // Track last annotation that showed "locked" toast (to avoid spam)
  lastLockedToastAnnotation: null,
};

// Initialize unified editor file input
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

// Add PDF and image files to unified editor
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

  ueRenderThumbnails();
  ueUpdatePageCount();
  document.getElementById('ue-download-btn').disabled = false;

  // Auto-select first page if none selected
  if (ueState.selectedPage === -1 && ueState.pages.length > 0) {
    ueSelectPage(0);
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

// Render thumbnails in sidebar
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

// Select a page
function ueSelectPage(index) {
  if (index < 0 || index >= ueState.pages.length) return;

  // Clear selection and confirm button when switching pages
  ueState.selectedAnnotation = null;
  ueHideConfirmButton();

  ueState.selectedPage = index;
  ueRenderThumbnails();
  ueRenderSelectedPage();

  // Show canvas, hide empty state
  document.getElementById('ue-empty-state').style.display = 'none';
  document.getElementById('ue-canvas').style.display = 'block';

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

// Render lock to prevent concurrent renders
let ueRenderLock = false;

// Render selected page on main canvas
async function ueRenderSelectedPage() {
  if (ueState.selectedPage < 0) return;
  if (ueRenderLock) return; // Skip if already rendering

  ueRenderLock = true;

  const pageInfo = ueState.pages[ueState.selectedPage];
  const sourceFile = ueState.sourceFiles[pageInfo.sourceIndex];

  try {
    const pdf = await pdfjsLib.getDocument({ data: sourceFile.bytes.slice() }).promise;
    const page = await pdf.getPage(pageInfo.pageNum + 1);

    const canvas = document.getElementById('ue-canvas');
    const ctx = canvas.getContext('2d');
    const dpr = ueState.devicePixelRatio = window.devicePixelRatio || 1;

    // Calculate scale based on width only - allow vertical scrolling
    const wrapper = document.getElementById('ue-canvas-wrapper');
    const maxWidth = wrapper.clientWidth - 16;  // Small margin for cleaner appearance
    const naturalViewport = page.getViewport({ scale: 1, rotation: pageInfo.rotation });

    // Ensure we have valid dimensions
    if (maxWidth <= 100) {
      console.warn('Invalid wrapper dimensions, retrying...', { maxWidth });
      ueRenderLock = false;
      setTimeout(() => ueRenderSelectedPage(), 150);
      return;
    }

    // Scale to fit width, then apply zoom level
    let baseScale = maxWidth / naturalViewport.width;
    let scale = baseScale * ueState.zoomLevel;
    scale = Math.max(scale, 0.25);  // Minimum scale
    scale = Math.min(scale, 4);     // Maximum scale

    const viewport = page.getViewport({ scale, rotation: pageInfo.rotation });

    // Store scale info
    ueState.pageScales[ueState.selectedPage] = {
      scale,
      pdfWidth: naturalViewport.width,
      pdfHeight: naturalViewport.height,
      canvasWidth: viewport.width,
      canvasHeight: viewport.height
    };

    // Set canvas size
    canvas.width = viewport.width * dpr;
    canvas.height = viewport.height * dpr;
    canvas.style.width = viewport.width + 'px';
    canvas.style.height = viewport.height + 'px';

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    await page.render({ canvasContext: ctx, viewport }).promise;

    // Cache the page for smooth annotation drawing
    ueState.pageCache = ctx.getImageData(0, 0, canvas.width, canvas.height);

    // Draw annotations
    ueRedrawAnnotations();

    // Setup canvas events if not done
    if (!ueState.canvasSetup) {
      ueSetupCanvasEvents();
    }

  } catch (error) {
    console.error('Error rendering page:', error);
    showToast('Gagal merender halaman', 'error');
  } finally {
    ueRenderLock = false;
  }
}

// Zoom controls
function ueZoomIn() {
  ueState.zoomLevel = Math.min(ueState.zoomLevel + 0.25, 3);
  ueUpdateZoomDisplay();
  ueRenderSelectedPage();
}

function ueZoomOut() {
  ueState.zoomLevel = Math.max(ueState.zoomLevel - 0.25, 0.5);
  ueUpdateZoomDisplay();
  ueRenderSelectedPage();
}

function ueZoomReset() {
  ueState.zoomLevel = 1.0;
  ueUpdateZoomDisplay();
  ueRenderSelectedPage();
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

// Setup canvas events for editing
function ueSetupCanvasEvents() {
  if (ueState.canvasSetup) return;
  ueState.canvasSetup = true;

  const canvas = document.getElementById('ue-canvas');
  let isDrawing = false;
  // isDragging and isResizing are now on ueState for sharing with pinch-to-zoom handler
  let startX, startY;
  let dragOffsetX, dragOffsetY;
  let hasMovedOrResized = false;  // Track if actual movement happened (for undo)
  let preChangeState = null;  // Store annotations state before drag/resize

  // Double-tap detection state
  let touchLastTap = 0;
  let touchLastCoords = null;
  const DOUBLE_TAP_DELAY = 300; // ms
  const DOUBLE_TAP_DISTANCE = 30; // pixels

  function getCoords(e) {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / canvas.clientWidth / ueState.devicePixelRatio);
    const y = (e.clientY - rect.top) * (canvas.height / canvas.clientHeight / ueState.devicePixelRatio);
    return { x, y };
  }

  // Check if clicking on a resize handle
  function getResizeHandle(anno, x, y) {
    if (anno.locked) return null;
    const handleSize = 12;

    let bounds;
    if (anno.type === 'text') {
      bounds = getTextBounds(anno);
      const handles = [
        { pos: 'tl', hx: bounds.x, hy: bounds.y },
        { pos: 'tr', hx: bounds.x + bounds.width, hy: bounds.y },
        { pos: 'bl', hx: bounds.x, hy: bounds.y + bounds.height },
        { pos: 'br', hx: bounds.x + bounds.width, hy: bounds.y + bounds.height }
      ];
      for (const h of handles) {
        if (Math.abs(x - h.hx) < handleSize && Math.abs(y - h.hy) < handleSize) {
          return h.pos;
        }
      }
    } else if (anno.type === 'signature') {
      const handles = [
        { pos: 'tl', hx: anno.x, hy: anno.y },
        { pos: 'tr', hx: anno.x + anno.width, hy: anno.y },
        { pos: 'bl', hx: anno.x, hy: anno.y + anno.height },
        { pos: 'br', hx: anno.x + anno.width, hy: anno.y + anno.height }
      ];
      for (const h of handles) {
        if (Math.abs(x - h.hx) < handleSize && Math.abs(y - h.hy) < handleSize) {
          return h.pos;
        }
      }
    }
    return null;
  }

  canvas.addEventListener('mousedown', (e) => handleDown(getCoords(e)));
  canvas.addEventListener('mousemove', (e) => handleMove(getCoords(e)));
  canvas.addEventListener('mouseup', (e) => handleUp(getCoords(e)));
  canvas.addEventListener('dblclick', (e) => handleDoubleClick(getCoords(e)));
  canvas.addEventListener('mouseleave', () => {
    isDrawing = false;
    ueState.isDragging = false;
    ueState.isResizing = false;
    // Clear signature preview when leaving canvas
    if (ueState.pendingSignature) {
      ueState.signaturePreviewPos = null;
      ueRedrawAnnotations();
    }
  });

  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const coords = getCoords(e.touches[0]);

    // Double-tap detection
    const now = Date.now();
    const timeDiff = now - touchLastTap;

    if (timeDiff < DOUBLE_TAP_DELAY && touchLastCoords) {
      const distance = Math.sqrt(
        Math.pow(coords.x - touchLastCoords.x, 2) +
        Math.pow(coords.y - touchLastCoords.y, 2)
      );

      if (distance < DOUBLE_TAP_DISTANCE) {
        // Double-tap detected - handle as double-click
        handleDoubleClick(coords);
        return;
      }
    }

    touchLastTap = now;
    touchLastCoords = coords;

    handleDown(coords);
  }, { passive: false });
  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    handleMove(getCoords(e.touches[0]));
  }, { passive: false });
  canvas.addEventListener('touchend', (e) => {
    e.preventDefault();
    handleUp(getCoords(e.changedTouches[0]));
  }, { passive: false });

  function handleDown({ x, y }) {
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
        const handle = getResizeHandle(anno, x, y);
        if (handle) {
          hasMovedOrResized = false;  // Will be set true if actual resize happens
          preChangeState = JSON.parse(JSON.stringify(ueState.annotations));  // Save state before change
          ueState.isResizing = true;
          ueState.resizeHandle = handle;

          if (anno.type === 'text') {
            const bounds = getTextBounds(anno);
            ueState.resizeStartInfo = {
              x: anno.x,
              y: anno.y,
              fontSize: anno.fontSize,
              width: bounds.width,
              height: bounds.height
            };
          } else {
            ueState.resizeStartInfo = {
              x: anno.x,
              y: anno.y,
              width: anno.width,
              height: anno.height,
              aspectRatio: anno.width / anno.height
            };
          }
          return;
        }
      }

      const clicked = ueFindAnnotationAt(x, y);
      if (clicked) {
        const anno = ueState.annotations[clicked.pageIndex][clicked.index];
        // Check if this annotation is locked
        if (anno.locked) {
          // Can't drag locked annotations
          if (anno.type === 'signature') {
            // Only show toast once per annotation (avoid spam)
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
        hasMovedOrResized = false;  // Will be set true if actual drag happens
        preChangeState = JSON.parse(JSON.stringify(ueState.annotations));  // Save state before change
        ueState.selectedAnnotation = clicked;
        ueState.lastLockedToastAnnotation = null;  // Reset when selecting different annotation
        ueState.isDragging = true;
        dragOffsetX = x - anno.x;
        dragOffsetY = y - (anno.type === 'text' ? anno.y - anno.fontSize : anno.y);
        ueRedrawAnnotations();
        ueShowConfirmButton(anno, clicked);
        return;
      } else {
        ueState.selectedAnnotation = null;
        ueState.lastLockedToastAnnotation = null;  // Reset when deselecting
        ueHideConfirmButton();
        ueRedrawAnnotations();
      }
    }

    if (!ueState.currentTool || ueState.currentTool === 'select') return;
    isDrawing = true;
  }

  function handleMove({ x, y }) {
    const canvas = document.getElementById('ue-canvas');

    // Update cursor for resize handles when hovering
    if (ueState.currentTool === 'select' && ueState.selectedAnnotation && !ueState.isResizing && !ueState.isDragging) {
      const anno = ueState.annotations[ueState.selectedAnnotation.pageIndex][ueState.selectedAnnotation.index];
      const handle = getResizeHandle(anno, x, y);
      if (handle) {
        const cursors = {
          'tl': 'nwse-resize',
          'tr': 'nesw-resize',
          'bl': 'nesw-resize',
          'br': 'nwse-resize'
        };
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
        // TEXT RESIZE LOGIC
        const ctx = canvas.getContext('2d');

        // Calculate new width based on which handle is being dragged
        let newWidth;
        if (handle === 'br' || handle === 'tr') {
          // Right handles: width increases as x increases
          newWidth = Math.max(20, x - info.x);
        } else {
          // Left handles: width increases as x decreases
          newWidth = Math.max(20, info.x + info.width - x);
        }

        // Calculate scale factor based on width change
        const scale = newWidth / info.width;

        // Apply to fontSize with 6-120pt constraints
        const newFontSize = Math.max(6, Math.min(120, info.fontSize * scale));
        anno.fontSize = newFontSize;

        // Recalculate bounds with new fontSize
        const newBounds = getTextBounds(anno, ctx);

        // Adjust position to keep opposite corner fixed
        // Key: anno.y is the baseline (not top), so when fontSize changes, baseline must adjust
        // to keep the visual top/bottom of bounds in the correct position
        if (handle === 'br') {
          // Bottom-right: keep top-left of bounds fixed at (info.x, info.y - info.fontSize)
          anno.x = info.x;
          anno.y = info.y + (anno.fontSize - info.fontSize);
        } else if (handle === 'bl') {
          // Bottom-left: keep top-right of bounds fixed
          anno.x = info.x + info.width - newBounds.width;
          anno.y = info.y + (anno.fontSize - info.fontSize);
        } else if (handle === 'tr') {
          // Top-right: keep bottom-left of bounds fixed
          anno.x = info.x;
          anno.y = info.y + info.height - newBounds.height + (anno.fontSize - info.fontSize);
        } else if (handle === 'tl') {
          // Top-left: keep bottom-right of bounds fixed
          anno.x = info.x + info.width - newBounds.width;
          anno.y = info.y + info.height - newBounds.height + (anno.fontSize - info.fontSize);
        }

        hasMovedOrResized = true;
        ueRedrawAnnotations();
        ueUpdateConfirmButtonPosition(anno);
        return;

      } else if (anno.type === 'signature') {
        // SIGNATURE RESIZE LOGIC
        let newWidth, newHeight, newX, newY;

        // Calculate new dimensions based on which handle is being dragged
        if (handle === 'br') {
          newWidth = Math.max(50, x - info.x);
          newHeight = newWidth / info.aspectRatio;
          newX = info.x;
          newY = info.y;
        } else if (handle === 'bl') {
          newWidth = Math.max(50, info.x + info.width - x);
          newHeight = newWidth / info.aspectRatio;
          newX = info.x + info.width - newWidth;
          newY = info.y;
        } else if (handle === 'tr') {
          newWidth = Math.max(50, x - info.x);
          newHeight = newWidth / info.aspectRatio;
          newX = info.x;
          newY = info.y + info.height - newHeight;
        } else if (handle === 'tl') {
          newWidth = Math.max(50, info.x + info.width - x);
          newHeight = newWidth / info.aspectRatio;
          newX = info.x + info.width - newWidth;
          newY = info.y + info.height - newHeight;
        }

        anno.x = newX;
        anno.y = newY;
        anno.width = newWidth;
        anno.height = newHeight;
        hasMovedOrResized = true;  // Mark that actual resize happened

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
      hasMovedOrResized = true;  // Mark that actual drag happened
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

  function handleUp({ x, y }) {
    const canvas = document.getElementById('ue-canvas');

    if (ueState.isResizing) {
      // Save undo state only if actual resize happened
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
      // Save undo state only if actual drag happened
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

    const pageIndex = ueState.selectedPage;

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
      // This case is now handled by pendingSignature flow
      uePlaceSignature(startX, startY);
    }
  }

  function handleDoubleClick({ x, y }) {
    // Only allow double-click edit when in select mode
    if (ueState.currentTool !== 'select') return;

    // Find annotation at click position
    const result = ueFindAnnotationAt(x, y);
    if (!result) return;

    // Get actual annotation
    const anno = ueState.annotations[result.pageIndex][result.index];

    // Unlock signature
    if (anno && anno.type === 'signature' && anno.locked) {
      anno.locked = false;
      ueState.lastLockedToastAnnotation = null;  // Reset toast tracking after unlock
      ueRedrawAnnotations();
      ueShowConfirmButton(anno, result);
      return;
    }

    // Only handle text annotations
    if (!anno || anno.type !== 'text' || anno.locked) return;

    // Create inline editor
    ueCreateInlineTextEditor(anno, result.pageIndex, result.index);
  }
}

// Create inline text editor for annotation
function ueCreateInlineTextEditor(anno, pageIndex, index) {
  // Remove existing editor
  const existing = document.getElementById('inline-text-editor');
  if (existing) existing.remove();

  const canvas = document.getElementById('ue-canvas');
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

  let cssFontFamily = 'Helvetica, Arial, sans-serif';
  if (anno.fontFamily === 'Times-Roman') cssFontFamily = 'Times New Roman, Times, serif';
  else if (anno.fontFamily === 'Courier') cssFontFamily = 'Courier New, Courier, monospace';
  else if (anno.fontFamily === 'Montserrat') cssFontFamily = 'Montserrat, sans-serif';
  else if (anno.fontFamily === 'Carlito') cssFontFamily = 'Carlito, Calibri, sans-serif';

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

// Place signature at position
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

  const canvas = document.getElementById('ue-canvas');
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

  const canvas = document.getElementById('ue-canvas');
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

// Redraw annotations
function ueRedrawAnnotations() {
  const canvas = document.getElementById('ue-canvas');
  const ctx = canvas.getContext('2d');

  // Restore cached page
  if (ueState.pageCache) {
    ctx.putImageData(ueState.pageCache, 0, 0);
  }
  ctx.setTransform(ueState.devicePixelRatio, 0, 0, ueState.devicePixelRatio, 0, 0);

  const annotations = ueState.annotations[ueState.selectedPage] || [];
  annotations.forEach((anno, i) => {
    const isSelected = ueState.selectedAnnotation &&
      ueState.selectedAnnotation.pageIndex === ueState.selectedPage &&
      ueState.selectedAnnotation.index === i;
    ueDrawAnnotation(ctx, anno, isSelected);
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

      // Map font family to CSS equivalent
      let cssFontFamily = 'Helvetica, Arial, sans-serif';
      if (anno.fontFamily === 'Times-Roman') cssFontFamily = 'Times New Roman, Times, serif';
      else if (anno.fontFamily === 'Courier') cssFontFamily = 'Courier New, Courier, monospace';
      else if (anno.fontFamily === 'Montserrat') cssFontFamily = 'Montserrat, sans-serif';
      else if (anno.fontFamily === 'Carlito') cssFontFamily = 'Carlito, sans-serif';

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
    const canvas = document.getElementById('ue-canvas');
    ctx = canvas.getContext('2d');
  }

  // Match font styling from rendering
  let fontStyle = '';
  if (anno.italic) fontStyle += 'italic ';
  if (anno.bold) fontStyle += 'bold ';

  let cssFontFamily = 'Helvetica, Arial, sans-serif';
  if (anno.fontFamily === 'Times-Roman')
    cssFontFamily = 'Times New Roman, Times, serif';
  else if (anno.fontFamily === 'Courier')
    cssFontFamily = 'Courier New, Courier, monospace';

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
function ueFindAnnotationAt(x, y) {
  const annotations = ueState.annotations[ueState.selectedPage] || [];
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
      return { pageIndex: ueState.selectedPage, index: i };
    }
  }
  return null;
}

// Delete a page
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
  Object.keys(ueState.annotations).forEach((key, i) => {
    const idx = parseInt(key);
    if (idx > index) {
      newAnnotations[idx - 1] = ueState.annotations[idx];
    } else if (idx < index) {
      newAnnotations[idx] = ueState.annotations[idx];
    }
  });
  ueState.annotations = newAnnotations;

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

// Set current tool
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

  const canvas = document.getElementById('ue-canvas');
  if (canvas) {
    canvas.className = 'editor-canvas tool-' + tool;
  }

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
  openSignatureModal();
  // After signature is created, switch to signature placement mode
}

// Open text modal - uses shared openTextModal()
function ueOpenTextModal() {
  openTextModal();
}

// Confirm text input - modified to work with unified editor
function ueConfirmText() {
  const settings = getTextModalSettings();

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

// Undo/Redo for page operations
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

// Download PDF
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

// Reset unified editor state
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
  ueState.pageCache = null;
  ueState.zoomLevel = 1.0;
  ueUpdateZoomDisplay();

  document.getElementById('ue-empty-state').style.display = 'flex';
  document.getElementById('ue-canvas').style.display = 'none';
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

  // Setup resize handler for responsive canvas
  if (!window._ueResizeHandler) {
    let resizeTimeout;
    window._ueResizeHandler = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        if (state.currentTool === 'unified-editor' && ueState.selectedPage >= 0) {
          ueRenderSelectedPage();
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

  // Re-render the selected page to recalculate canvas size after transition
  setTimeout(() => {
    if (ueState.selectedPage >= 0) {
      ueRenderSelectedPage();
    }
  }, 350); // Wait for CSS transition to complete
}

// ============================================================
// PAGE MANAGER MODAL FOR UNIFIED EDITOR
// ============================================================

const uePmState = {
  isOpen: false,
  extractMode: false,
  selectedForExtract: [],
  draggedIndex: -1,
  dropIndicator: null
};

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
