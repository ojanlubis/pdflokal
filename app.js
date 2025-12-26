/*
 * ============================================================
 * PDFLokal - Main Application
 * ============================================================
 * Client-side PDF & Image manipulation tool
 * No files are ever uploaded - everything runs in browser
 * ============================================================
 */

// ============================================================
// GLOBAL STATE
// ============================================================

const state = {
  currentTool: null,
  currentPDF: null,
  currentPDFBytes: null,
  currentImages: [],
  mergeFiles: [],
  splitPages: [],
  rotatePages: [],
  pagesOrder: [],
  editAnnotations: {},
  currentEditPage: 0,
  currentEditTool: null,
  cropRect: null,
  currentCropPage: 0,
  signaturePad: null,
  signatureImage: null,
  signatureUploadImage: null,  // For uploaded signature image
  signatureUploadCanvas: null, // Canvas for signature bg removal
  originalImage: null,
  originalImageName: null,
  // Additional state for proper cleanup
  imgToPdfFiles: [],
  pdfImgPages: [],
  compressedBlob: null,
  originalImageSize: 0,
  originalWidth: 0,
  originalHeight: 0,
  // Track setup states to prevent duplicate event listeners
  workspaceDropZonesSetup: new Set(),
  cropCanvasSetup: false,
  editCanvasSetup: false,
  // Track blob URLs for cleanup
  blobUrls: [],
  compressPreviewUrl: null,
  // Page Manager unified state
  pmPages: [], // Array of { pageNum, sourceFile, sourceName, rotation, selected, canvas }
  pmSourceFiles: [], // Array of { name, bytes }
  pmUndoStack: [],   // Undo stack for page manager
  pmRedoStack: [],   // Redo stack for page manager
  // Original filename tracking
  originalPDFName: null,  // Original PDF filename for output naming
  // Enhanced PDF Editor state
  editUndoStack: [],           // Stack of previous annotation states for undo
  editRedoStack: [],           // Stack of undone states for redo
  selectedAnnotation: null,    // Currently selected annotation { pageNum, index }
  pendingTextPosition: null,   // Position where text will be placed { x, y }
  editPageScales: {},          // Per-page scale factors for accurate coordinate mapping
  editDevicePixelRatio: 1,     // Device pixel ratio for high-DPI displays
};

// ============================================================
// INITIALIZATION
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  initDropZone();
  initToolCards();
  initFileInputs();
  initRangeSliders();
  initSignaturePad();
});

function initDropZone() {
  const dropzone = document.getElementById('main-dropzone');
  const fileInput = document.getElementById('file-input');

  dropzone.addEventListener('click', () => fileInput.click());
  
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('drag-over');
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('drag-over');
  });

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    handleDroppedFiles(e.dataTransfer.files);
  });

  fileInput.addEventListener('change', (e) => {
    handleDroppedFiles(e.target.files);
  });
}

function initToolCards() {
  document.querySelectorAll('.tool-card:not(.disabled)').forEach(card => {
    card.addEventListener('click', () => {
      const tool = card.dataset.tool;
      showTool(tool);
    });
  });
}

function initFileInputs() {
  // Page Manager input
  const pmInput = document.getElementById('pm-file-input');
  if (pmInput) {
    pmInput.addEventListener('change', (e) => {
      pmAddFiles(e.target.files);
      e.target.value = '';
    });
  }

  // Image to PDF input
  const imgPdfInput = document.getElementById('img-pdf-input');
  if (imgPdfInput) {
    imgPdfInput.addEventListener('change', (e) => {
      addImagesToPDF(e.target.files);
      e.target.value = '';
    });
  }

  // Compress PDF input
  const compressPdfInput = document.getElementById('compress-pdf-input');
  if (compressPdfInput) {
    compressPdfInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        loadPDFForTool(e.target.files[0], 'compress-pdf');
      }
      e.target.value = '';
    });
  }

  // PDF to Image input
  const pdfImgInput = document.getElementById('pdf-img-input');
  if (pdfImgInput) {
    pdfImgInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        loadPDFForTool(e.target.files[0], 'pdf-to-img');
      }
      e.target.value = '';
    });
  }

  // Protect PDF input
  const protectInput = document.getElementById('protect-input');
  if (protectInput) {
    protectInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        loadPDFForTool(e.target.files[0], 'protect');
      }
      e.target.value = '';
    });
  }

  // Unlock PDF input
  const unlockInput = document.getElementById('unlock-input');
  if (unlockInput) {
    unlockInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        loadPDFForTool(e.target.files[0], 'unlock');
      }
      e.target.value = '';
    });
  }

  // Page Numbers input
  const pageNumbersInput = document.getElementById('page-numbers-input');
  if (pageNumbersInput) {
    pageNumbersInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        loadPDFForTool(e.target.files[0], 'page-numbers');
      }
      e.target.value = '';
    });
  }

  // Compress Image input
  const compressImgInput = document.getElementById('compress-img-input');
  if (compressImgInput) {
    compressImgInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        loadImageForTool(e.target.files[0], 'compress-img');
      }
      e.target.value = '';
    });
  }

  // Resize Image input
  const resizeInput = document.getElementById('resize-input');
  if (resizeInput) {
    resizeInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        loadImageForTool(e.target.files[0], 'resize');
      }
      e.target.value = '';
    });
  }

  // Convert Image input
  const convertInput = document.getElementById('convert-input');
  if (convertInput) {
    convertInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        loadImageForTool(e.target.files[0], 'convert-img');
      }
      e.target.value = '';
    });
  }

  // Remove Background input
  const removeBgInput = document.getElementById('remove-bg-input');
  if (removeBgInput) {
    removeBgInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        loadImageForTool(e.target.files[0], 'remove-bg');
      }
      e.target.value = '';
    });
  }

  // Signature Upload input
  const sigUploadInput = document.getElementById('signature-upload-input');
  if (sigUploadInput) {
    sigUploadInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        loadSignatureImage(e.target.files[0]);
      }
      e.target.value = '';
    });
  }

  // Initialize drop hint drag-over effects
  initDropHints();
}

function initDropHints() {
  document.querySelectorAll('.drop-hint').forEach(hint => {
    hint.addEventListener('dragover', (e) => {
      e.preventDefault();
      hint.classList.add('drag-over');
    });
    hint.addEventListener('dragleave', () => {
      hint.classList.remove('drag-over');
    });
    hint.addEventListener('drop', (e) => {
      e.preventDefault();
      hint.classList.remove('drag-over');
      // The workspace drop handler will handle the actual file processing
    });
  });
}

function initRangeSliders() {
  document.querySelectorAll('.range-slider input[type="range"]').forEach(slider => {
    const valueSpan = slider.parentElement.querySelector('.range-value');
    slider.addEventListener('input', () => {
      valueSpan.textContent = slider.value + '%';
    });
  });
}

function initSignaturePad() {
  const canvas = document.getElementById('signature-canvas');
  if (canvas && typeof SignaturePad !== 'undefined') {
    state.signaturePad = new SignaturePad(canvas, {
      backgroundColor: 'rgb(255, 255, 255)',
      penColor: 'rgb(0, 0, 0)'
    });
    
    // Resize canvas
    function resizeCanvas() {
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      canvas.width = canvas.offsetWidth * ratio;
      canvas.height = canvas.offsetHeight * ratio;
      canvas.getContext('2d').scale(ratio, ratio);
      state.signaturePad.clear();
    }
    
    window.addEventListener('resize', resizeCanvas);
    setTimeout(resizeCanvas, 100);
  }
}

// ============================================================
// FILE HANDLING
// ============================================================

function handleDroppedFiles(files) {
  if (!files || files.length === 0) return;

  const file = files[0];
  const isPDF = file.type === 'application/pdf';
  const isImage = file.type.startsWith('image/');

  if (!isPDF && !isImage) {
    showToast('File tidak didukung. Gunakan PDF, JPG, PNG, atau WebP.', 'error');
    return;
  }

  // If no tool is selected, suggest based on file type
  if (!state.currentTool) {
    if (isPDF) {
      // Default to Page Manager for all PDF operations
      showTool('page-manager');
      pmAddFiles(files);
    } else if (isImage && files.length > 1) {
      showTool('img-to-pdf');
      addImagesToPDF(files);
    } else if (isImage) {
      showTool('compress-img');
      loadImageForTool(file, 'compress-img');
    }
  }
}

async function loadPDFForTool(file, tool) {
  try {
    const arrayBuffer = await file.arrayBuffer();
    state.currentPDFBytes = new Uint8Array(arrayBuffer);
    state.currentPDFName = file.name;
    
    // Load with PDF.js for rendering
    state.currentPDF = await pdfjsLib.getDocument({ data: state.currentPDFBytes.slice() }).promise;
    
    // Initialize tool-specific views
    switch (tool) {
      case 'pdf-to-img':
        await renderPdfImgPages();
        document.getElementById('pdf-img-btn').disabled = false;
        break;
      case 'edit':
        await initEditMode();
        document.getElementById('edit-btn').disabled = false;
        break;
      case 'compress-pdf':
        await showPDFPreview('compress-pdf-preview');
        document.getElementById('compress-pdf-btn').disabled = false;
        break;
      case 'protect':
        await showPDFPreview('protect-preview');
        document.getElementById('protect-btn').disabled = false;
        break;
      case 'unlock':
        await showPDFPreview('unlock-preview');
        document.getElementById('unlock-btn').disabled = false;
        break;
      case 'watermark':
        await initWatermarkMode();
        document.getElementById('watermark-btn').disabled = false;
        break;
      case 'page-numbers':
        await showPDFPreview('page-numbers-preview');
        document.getElementById('page-numbers-btn').disabled = false;
        break;
      case 'crop':
        await initCropMode();
        document.getElementById('crop-btn').disabled = false;
        break;
    }
  } catch (error) {
    console.error('Error loading PDF:', error);
    showToast('Gagal memuat PDF. File mungkin rusak atau terenkripsi.', 'error');
  }
}

async function loadImageForTool(file, tool) {
  try {
    state.originalImage = await loadImage(file);
    state.originalImageName = file.name;

    switch (tool) {
      case 'compress-img':
        // Hide drop hint, show comparison
        const compressHint = document.getElementById('compress-img-hint');
        const compressComparison = document.getElementById('compress-img-comparison');
        if (compressHint) compressHint.classList.add('hidden');
        if (compressComparison) compressComparison.classList.remove('hidden');

        document.getElementById('compress-original').src = state.originalImage.src;
        document.getElementById('compress-original-size').textContent = `Original: ${formatFileSize(file.size)}`;
        state.originalImageSize = file.size;
        updateCompressPreview();
        document.getElementById('compress-img-btn').disabled = false;
        break;
      case 'resize':
        // Hide drop hint, show preview
        const resizeHint = document.getElementById('resize-hint');
        const resizePreviewBox = document.getElementById('resize-preview-box');
        if (resizeHint) resizeHint.classList.add('hidden');
        if (resizePreviewBox) resizePreviewBox.classList.remove('hidden');

        document.getElementById('resize-preview').src = state.originalImage.src;
        document.getElementById('resize-width').value = state.originalImage.naturalWidth;
        document.getElementById('resize-height').value = state.originalImage.naturalHeight;
        state.originalWidth = state.originalImage.naturalWidth;
        state.originalHeight = state.originalImage.naturalHeight;
        document.getElementById('resize-dimensions').textContent = `Dimensi: ${state.originalWidth} × ${state.originalHeight}`;
        document.getElementById('resize-btn').disabled = false;
        break;
      case 'convert-img':
        // Hide drop hint, show preview
        const convertHint = document.getElementById('convert-hint');
        const convertPreviewBox = document.getElementById('convert-preview-box');
        if (convertHint) convertHint.classList.add('hidden');
        if (convertPreviewBox) convertPreviewBox.classList.remove('hidden');

        document.getElementById('convert-preview').src = state.originalImage.src;
        const ext = file.name.split('.').pop().toLowerCase();
        document.getElementById('convert-info').textContent = `Format saat ini: ${ext.toUpperCase()}`;
        document.getElementById('convert-btn').disabled = false;
        break;
      case 'remove-bg':
        // Hide drop hint, show comparison
        const removeBgHint = document.getElementById('remove-bg-hint');
        const removeBgComparison = document.getElementById('remove-bg-comparison');
        if (removeBgHint) removeBgHint.classList.add('hidden');
        if (removeBgComparison) removeBgComparison.classList.remove('hidden');

        document.getElementById('remove-bg-original').src = state.originalImage.src;
        updateRemoveBgPreview();
        document.getElementById('remove-bg-btn').disabled = false;
        break;
    }
  } catch (error) {
    console.error('Error loading image:', error);
    showToast('Gagal memuat gambar.', 'error');
  }
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const blobUrl = URL.createObjectURL(file);
    img.onload = () => {
      // Store the blob URL on the image for later cleanup
      img._blobUrl = blobUrl;
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(blobUrl);
      reject(new Error('Failed to load image'));
    };
    img.src = blobUrl;
  });
}

// Helper function to escape HTML and prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Helper function to revoke blob URL from an image
function cleanupImage(img) {
  if (img && img._blobUrl) {
    URL.revokeObjectURL(img._blobUrl);
    img._blobUrl = null;
  }
}

// ============================================================
// NAVIGATION
// ============================================================

function showHome() {
  document.getElementById('home-view').style.display = 'block';
  document.querySelectorAll('.workspace').forEach(ws => ws.classList.remove('active'));
  state.currentTool = null;
  resetState();
}

function showTool(tool) {
  document.getElementById('home-view').style.display = 'none';
  document.querySelectorAll('.workspace').forEach(ws => ws.classList.remove('active'));

  const workspace = document.getElementById(`${tool}-workspace`);
  if (workspace) {
    workspace.classList.add('active');
    state.currentTool = tool;

    // Setup drop zones for workspaces
    setupWorkspaceDropZone(tool);

    // Initialize unified editor when opened
    if (tool === 'unified-editor') {
      initUnifiedEditor();
    }
  }
}

function setupWorkspaceDropZone(tool) {
  // Prevent duplicate event listeners
  if (state.workspaceDropZonesSetup.has(tool)) {
    return;
  }

  const workspace = document.getElementById(`${tool}-workspace`);
  if (!workspace) return;

  state.workspaceDropZonesSetup.add(tool);

  workspace.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  workspace.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = e.dataTransfer.files;

    if (tool === 'page-manager') {
      pmAddFiles(files);
    } else if (tool === 'merge') {
      addMergeFiles(files);
    } else if (tool === 'img-to-pdf') {
      addImagesToPDF(files);
    } else if (files.length === 1) {
      const file = files[0];
      if (file.type === 'application/pdf') {
        loadPDFForTool(file, tool);
      } else if (file.type.startsWith('image/')) {
        loadImageForTool(file, tool);
      }
    }
  });
}

function resetState() {
  state.currentPDF = null;
  state.currentPDFBytes = null;
  state.currentImages = [];
  state.mergeFiles = [];
  state.splitPages = [];
  state.rotatePages = [];
  state.pagesOrder = [];
  state.editAnnotations = {};
  state.currentEditPage = 0;

  // Cleanup original image blob URL
  cleanupImage(state.originalImage);
  state.originalImage = null;
  state.originalImageName = null;
  state.originalImageSize = 0;
  state.originalWidth = 0;
  state.originalHeight = 0;

  // Cleanup images to PDF
  state.imgToPdfFiles.forEach(item => cleanupImage(item.img));
  state.imgToPdfFiles = [];

  // Reset other state
  state.pdfImgPages = [];
  state.compressedBlob = null;
  state.cropRect = null;
  state.currentCropPage = 0;
  state.currentEditTool = null;
  state.signatureImage = null;

  // Cleanup compress preview URL
  if (state.compressPreviewUrl) {
    URL.revokeObjectURL(state.compressPreviewUrl);
    state.compressPreviewUrl = null;
  }

  // Reset canvas setup flags so they can be re-initialized
  state.cropCanvasSetup = false;
  state.editCanvasSetup = false;

  // Reset Page Manager state
  state.pmPages = [];
  state.pmSourceFiles = [];

  // Reset Unified Editor state
  if (typeof ueReset === 'function') {
    ueReset();
  }
}

// ============================================================
// PAGE MANAGER (Unified: Merge, Split, Reorder, Rotate, Delete)
// ============================================================

async function pmAddFiles(files) {
  const container = document.getElementById('pm-pages');

  // Clear placeholder if this is the first file
  if (state.pmPages.length === 0) {
    container.innerHTML = '<div class="spinner"></div>';
  }

  for (const file of files) {
    if (file.type !== 'application/pdf') {
      showToast(`${file.name} bukan file PDF`, 'error');
      continue;
    }

    try {
      const bytes = await file.arrayBuffer();
      const sourceIndex = state.pmSourceFiles.length;
      state.pmSourceFiles.push({ name: file.name, bytes: new Uint8Array(bytes) });

      // Load with PDF.js to get page count and thumbnails
      const pdf = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;

      for (let i = 1; i <= pdf.numPages; i++) {
        state.pmPages.push({
          pageNum: i,
          sourceIndex: sourceIndex,
          sourceName: file.name,
          rotation: 0,
          selected: false
        });
      }
    } catch (error) {
      console.error('Error loading PDF:', error);
      showToast(`Gagal memuat ${file.name}`, 'error');
    }
  }

  await pmRenderPages();
  pmUpdateStatus();
  pmUpdateDownloadButton();
}

async function pmRenderPages() {
  const container = document.getElementById('pm-pages');
  container.innerHTML = '';

  if (state.pmPages.length === 0) {
    container.classList.add('empty');
    container.innerHTML = `
      <div class="drop-hint" onclick="document.getElementById('pm-file-input').click()">
        <svg class="drop-hint-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        <span class="drop-hint-text">Seret file PDF ke sini atau klik untuk upload</span>
        <span class="drop-hint-subtext">PDF</span>
      </div>`;
    return;
  }

  container.classList.remove('empty');

  for (let i = 0; i < state.pmPages.length; i++) {
    const pageData = state.pmPages[i];

    // Use cached canvas if available, otherwise render
    if (!pageData.canvas) {
      const sourceFile = state.pmSourceFiles[pageData.sourceIndex];
      try {
        const pdf = await pdfjsLib.getDocument({ data: sourceFile.bytes.slice() }).promise;
        const page = await pdf.getPage(pageData.pageNum);

        const scale = 0.3;
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');

        await page.render({ canvasContext: ctx, viewport }).promise;
        pageData.canvas = canvas; // Cache the canvas
      } catch (error) {
        console.error('Error rendering page:', error);
        continue;
      }
    }

    const div = pmCreatePageElement(pageData, i);
    container.appendChild(div);
  }

  // Enable drag-and-drop reordering
  pmEnableDragReorder();
}

function pmCreatePageElement(pageData, index) {
  const div = document.createElement('div');
  div.className = 'page-item' + (pageData.selected ? ' selected' : '');
  div.dataset.index = index;
  div.draggable = true;

  // Clone the cached canvas
  const canvas = pageData.canvas.cloneNode(true);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(pageData.canvas, 0, 0);

  // Apply rotation transform
  if (pageData.rotation !== 0) {
    canvas.style.transform = `rotate(${pageData.rotation}deg)`;
  }

  div.appendChild(canvas);

  // Page number badge
  const numBadge = document.createElement('span');
  numBadge.className = 'page-item-number';
  numBadge.textContent = index + 1;
  div.appendChild(numBadge);

  // Source file badge (truncated name)
  const sourceBadge = document.createElement('span');
  sourceBadge.className = 'page-source';
  sourceBadge.textContent = pageData.sourceName.replace('.pdf', '').substring(0, 8);
  sourceBadge.title = pageData.sourceName;
  div.appendChild(sourceBadge);

  // Rotation badge if rotated
  if (pageData.rotation !== 0) {
    const rotBadge = document.createElement('span');
    rotBadge.className = 'page-rotation-badge';
    rotBadge.textContent = pageData.rotation + '°';
    div.appendChild(rotBadge);
  }

  // Delete button
  const delBtn = document.createElement('button');
  delBtn.className = 'delete-btn';
  delBtn.textContent = '×';
  delBtn.onclick = (e) => {
    e.stopPropagation();
    pmDeletePage(index);
  };
  div.appendChild(delBtn);

  // Click to select
  div.addEventListener('click', () => {
    pageData.selected = !pageData.selected;
    div.classList.toggle('selected', pageData.selected);
    pmUpdateStatus();
  });

  return div;
}

function pmEnableDragReorder() {
  const container = document.getElementById('pm-pages');
  let draggedItem = null;
  let draggedIndex = -1;
  let dropIndicator = null;

  // Create drop indicator element
  function getDropIndicator() {
    if (!dropIndicator) {
      dropIndicator = document.createElement('div');
      dropIndicator.className = 'drop-indicator';
    }
    return dropIndicator;
  }

  function removeDropIndicator() {
    if (dropIndicator && dropIndicator.parentNode) {
      dropIndicator.remove();
    }
  }

  container.querySelectorAll('.page-item').forEach((item) => {
    item.addEventListener('dragstart', (e) => {
      pmSaveUndoState(); // Save state before reordering
      draggedItem = item;
      draggedIndex = parseInt(item.dataset.index);
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    item.addEventListener('dragend', () => {
      if (draggedItem) {
        draggedItem.classList.remove('dragging');
        draggedItem = null;
      }
      removeDropIndicator();
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (!draggedItem || item === draggedItem) return;

      const rect = item.getBoundingClientRect();
      const midpoint = rect.left + rect.width / 2;
      const indicator = getDropIndicator();

      // Show indicator on left or right side based on mouse position
      if (e.clientX < midpoint) {
        item.before(indicator);
      } else {
        item.after(indicator);
      }
    });

    item.addEventListener('dragleave', () => {
      // Don't remove immediately - let dragover on next item handle it
    });

    item.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!draggedItem) return;

      const targetIndex = parseInt(item.dataset.index);
      const rect = item.getBoundingClientRect();
      const midpoint = rect.left + rect.width / 2;
      const insertBefore = e.clientX < midpoint;

      // Calculate final position
      let newIndex = insertBefore ? targetIndex : targetIndex + 1;
      if (draggedIndex < targetIndex) newIndex--;

      if (draggedIndex !== newIndex && newIndex !== draggedIndex + 1 || insertBefore && draggedIndex !== targetIndex) {
        // Reorder in state
        const [movedPage] = state.pmPages.splice(draggedIndex, 1);
        const adjustedIndex = draggedIndex < (insertBefore ? targetIndex : targetIndex + 1)
          ? (insertBefore ? targetIndex - 1 : targetIndex)
          : (insertBefore ? targetIndex : targetIndex + 1);
        state.pmPages.splice(adjustedIndex, 0, movedPage);

        // Move DOM element directly
        if (insertBefore) {
          item.before(draggedItem);
        } else {
          item.after(draggedItem);
        }

        pmUpdateIndices();
      }

      removeDropIndicator();
    });
  });

  // Handle drops on the container itself (for first/last position)
  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!draggedItem) return;

    const items = container.querySelectorAll('.page-item:not(.dragging)');
    if (items.length === 0) return;

    const indicator = getDropIndicator();
    const containerRect = container.getBoundingClientRect();
    const firstItem = items[0];
    const lastItem = items[items.length - 1];
    const firstRect = firstItem.getBoundingClientRect();
    const lastRect = lastItem.getBoundingClientRect();

    // Check if near left edge (before first item)
    if (e.clientX < firstRect.left) {
      firstItem.before(indicator);
    }
    // Check if near right edge (after last item)
    else if (e.clientX > lastRect.right) {
      lastItem.after(indicator);
    }
  });

  container.addEventListener('drop', (e) => {
    if (!draggedItem) return;
    // Only handle if dropped on container, not on items
    if (e.target === container || e.target.classList.contains('drop-indicator')) {
      e.preventDefault();

      const items = container.querySelectorAll('.page-item:not(.dragging)');
      if (items.length === 0) return;

      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      const firstRect = firstItem.getBoundingClientRect();
      const lastRect = lastItem.getBoundingClientRect();

      let newIndex = -1;

      // Dropped before first item
      if (e.clientX < firstRect.left + firstRect.width / 2) {
        newIndex = 0;
        if (draggedIndex !== 0) {
          const [movedPage] = state.pmPages.splice(draggedIndex, 1);
          state.pmPages.unshift(movedPage);
          container.insertBefore(draggedItem, firstItem);
          pmUpdateIndices();
        }
      }
      // Dropped after last item
      else if (e.clientX > lastRect.left + lastRect.width / 2) {
        newIndex = state.pmPages.length - 1;
        if (draggedIndex !== state.pmPages.length - 1) {
          const [movedPage] = state.pmPages.splice(draggedIndex, 1);
          state.pmPages.push(movedPage);
          container.appendChild(draggedItem);
          pmUpdateIndices();
        }
      }

      removeDropIndicator();
    }
  });
}

function pmUpdateIndices() {
  const container = document.getElementById('pm-pages');
  container.querySelectorAll('.page-item').forEach((item, i) => {
    item.dataset.index = i;
    const numBadge = item.querySelector('.page-item-number');
    if (numBadge) numBadge.textContent = i + 1;
  });
}

function pmSelectAll() {
  state.pmPages.forEach(p => p.selected = true);
  document.querySelectorAll('#pm-pages .page-item').forEach(item => {
    item.classList.add('selected');
  });
  pmUpdateStatus();
}

function pmDeselectAll() {
  state.pmPages.forEach(p => p.selected = false);
  document.querySelectorAll('#pm-pages .page-item').forEach(item => {
    item.classList.remove('selected');
  });
  pmUpdateStatus();
}

// Page Manager Undo/Redo System
function pmSaveUndoState() {
  // Deep clone current pages state (without canvas which can't be cloned)
  const snapshot = state.pmPages.map(p => ({
    pageNum: p.pageNum,
    sourceIndex: p.sourceIndex,
    sourceName: p.sourceName,
    rotation: p.rotation,
    selected: p.selected
  }));
  state.pmUndoStack.push(snapshot);
  state.pmRedoStack = []; // Clear redo on new action

  // Limit stack size
  if (state.pmUndoStack.length > 50) {
    state.pmUndoStack.shift();
  }
}

async function pmUndo() {
  if (state.pmUndoStack.length === 0) {
    showToast('Tidak ada yang bisa di-undo', 'info');
    return;
  }

  // Save current state to redo
  const currentSnapshot = state.pmPages.map(p => ({
    pageNum: p.pageNum,
    sourceIndex: p.sourceIndex,
    sourceName: p.sourceName,
    rotation: p.rotation,
    selected: p.selected
  }));
  state.pmRedoStack.push(currentSnapshot);

  // Restore previous state
  const previousState = state.pmUndoStack.pop();
  state.pmPages = previousState.map(p => ({ ...p, canvas: null }));

  await pmRenderPages();
  pmUpdateStatus();
  pmUpdateDownloadButton();
  showToast('Undo berhasil', 'success');
}

async function pmRedo() {
  if (state.pmRedoStack.length === 0) {
    showToast('Tidak ada yang bisa di-redo', 'info');
    return;
  }

  // Save current state to undo
  const currentSnapshot = state.pmPages.map(p => ({
    pageNum: p.pageNum,
    sourceIndex: p.sourceIndex,
    sourceName: p.sourceName,
    rotation: p.rotation,
    selected: p.selected
  }));
  state.pmUndoStack.push(currentSnapshot);

  // Restore next state
  const nextState = state.pmRedoStack.pop();
  state.pmPages = nextState.map(p => ({ ...p, canvas: null }));

  await pmRenderPages();
  pmUpdateStatus();
  pmUpdateDownloadButton();
  showToast('Redo berhasil', 'success');
}

function pmRotateSelected(degrees) {
  const hasSelection = state.pmPages.some(p => p.selected);

  if (!hasSelection) {
    showToast('Pilih halaman yang ingin diputar', 'error');
    return;
  }

  pmSaveUndoState();
  const container = document.getElementById('pm-pages');
  const items = container.querySelectorAll('.page-item');

  state.pmPages.forEach((p, i) => {
    if (p.selected) {
      p.rotation = ((p.rotation + degrees) % 360 + 360) % 360;

      // Update CSS transform on canvas (no re-render)
      const item = items[i];
      const canvas = item.querySelector('canvas');
      if (canvas) {
        canvas.style.transform = p.rotation !== 0 ? `rotate(${p.rotation}deg)` : '';
      }

      // Update or add/remove rotation badge
      let rotBadge = item.querySelector('.page-rotation-badge');
      if (p.rotation !== 0) {
        if (!rotBadge) {
          rotBadge = document.createElement('span');
          rotBadge.className = 'page-rotation-badge';
          item.appendChild(rotBadge);
        }
        rotBadge.textContent = p.rotation + '°';
      } else if (rotBadge) {
        rotBadge.remove();
      }
    }
  });

  showToast('Halaman diputar!', 'success');
}

function pmDeleteSelected() {
  const hasSelection = state.pmPages.some(p => p.selected);

  if (!hasSelection) {
    showToast('Pilih halaman yang ingin dihapus', 'error');
    return;
  }

  pmSaveUndoState();
  const container = document.getElementById('pm-pages');

  // Remove selected DOM elements and filter state
  state.pmPages.forEach((p, i) => {
    if (p.selected) {
      const item = container.querySelector(`[data-index="${i}"]`);
      if (item) item.remove();
    }
  });

  state.pmPages = state.pmPages.filter(p => !p.selected);

  // Update indices after removal
  pmUpdateIndices();
  pmUpdateStatus();
  pmUpdateDownloadButton();

  // Show placeholder if empty
  if (state.pmPages.length === 0) {
    container.innerHTML = '<p style="color: var(--text-tertiary); width: 100%; text-align: center; padding: 2rem;">Seret file PDF ke sini atau klik "Tambah PDF"</p>';
  }

  showToast('Halaman dihapus!', 'success');
}

function pmDeletePage(index) {
  pmSaveUndoState();
  const container = document.getElementById('pm-pages');
  const item = container.querySelector(`[data-index="${index}"]`);
  if (item) item.remove();

  state.pmPages.splice(index, 1);

  // Update indices after removal
  pmUpdateIndices();
  pmUpdateStatus();
  pmUpdateDownloadButton();

  // Show placeholder if empty
  if (state.pmPages.length === 0) {
    container.innerHTML = '<p style="color: var(--text-tertiary); width: 100%; text-align: center; padding: 2rem;">Seret file PDF ke sini atau klik "Tambah PDF"</p>';
  }
}

function pmUpdateStatus() {
  const total = state.pmPages.length;
  const selected = state.pmPages.filter(p => p.selected).length;
  const statusEl = document.getElementById('pm-status');

  if (total === 0) {
    statusEl.textContent = '';
  } else if (selected > 0) {
    statusEl.textContent = `${selected} dari ${total} halaman dipilih`;
  } else {
    statusEl.textContent = `${total} halaman total dari ${state.pmSourceFiles.length} file`;
  }
}

function pmUpdateDownloadButton() {
  const btn = document.getElementById('pm-download-btn');
  btn.disabled = state.pmPages.length === 0;
}

async function pmDownload() {
  if (state.pmPages.length === 0) return;

  const action = document.getElementById('pm-action').value;
  const progress = document.getElementById('pm-progress');
  const progressFill = progress.querySelector('.progress-fill');
  const progressText = progress.querySelector('.progress-text');
  const btn = document.getElementById('pm-download-btn');

  progress.classList.remove('hidden');
  btn.disabled = true;

  try {
    if (action === 'split-each') {
      // Each page as separate file
      for (let i = 0; i < state.pmPages.length; i++) {
        progressText.textContent = `Memproses halaman ${i + 1}...`;
        progressFill.style.width = `${((i + 1) / state.pmPages.length) * 100}%`;

        const pageData = state.pmPages[i];
        const sourceFile = state.pmSourceFiles[pageData.sourceIndex];

        const srcDoc = await PDFLib.PDFDocument.load(sourceFile.bytes);
        const newDoc = await PDFLib.PDFDocument.create();
        const [page] = await newDoc.copyPages(srcDoc, [pageData.pageNum - 1]);

        // Apply rotation
        if (pageData.rotation !== 0) {
          page.setRotation(PDFLib.degrees(pageData.rotation));
        }

        newDoc.addPage(page);
        const bytes = await newDoc.save();
        const baseName = state.pmSourceFiles[0]?.name?.replace(/\.pdf$/i, '') || 'halaman';
        downloadBlob(new Blob([bytes], { type: 'application/pdf' }), `${baseName}_halaman${i + 1}.pdf`);
        await sleep(100);
      }
      showToast('Semua halaman berhasil dipisah!', 'success');

    } else if (action === 'extract') {
      // Extract selected pages
      const selectedPages = state.pmPages.filter(p => p.selected);

      if (selectedPages.length === 0) {
        showToast('Pilih halaman yang ingin diekstrak', 'error');
        progress.classList.add('hidden');
        btn.disabled = false;
        return;
      }

      progressText.textContent = 'Mengekstrak halaman terpilih...';

      const newDoc = await PDFLib.PDFDocument.create();

      for (let i = 0; i < selectedPages.length; i++) {
        const pageData = selectedPages[i];
        const sourceFile = state.pmSourceFiles[pageData.sourceIndex];
        const srcDoc = await PDFLib.PDFDocument.load(sourceFile.bytes);
        const [page] = await newDoc.copyPages(srcDoc, [pageData.pageNum - 1]);

        if (pageData.rotation !== 0) {
          page.setRotation(PDFLib.degrees(pageData.rotation));
        }

        newDoc.addPage(page);
        progressFill.style.width = `${((i + 1) / selectedPages.length) * 100}%`;
      }

      const bytes = await newDoc.save();
      const baseName = state.pmSourceFiles[0]?.name?.replace(/\.pdf$/i, '') || 'extracted';
      downloadBlob(new Blob([bytes], { type: 'application/pdf' }), `${baseName}_extracted.pdf`);
      showToast('Halaman berhasil diekstrak!', 'success');

    } else {
      // Save all pages (merged, reordered, rotated)
      progressText.textContent = 'Menggabungkan halaman...';

      const newDoc = await PDFLib.PDFDocument.create();

      for (let i = 0; i < state.pmPages.length; i++) {
        const pageData = state.pmPages[i];
        const sourceFile = state.pmSourceFiles[pageData.sourceIndex];
        const srcDoc = await PDFLib.PDFDocument.load(sourceFile.bytes);
        const [page] = await newDoc.copyPages(srcDoc, [pageData.pageNum - 1]);

        if (pageData.rotation !== 0) {
          page.setRotation(PDFLib.degrees(pageData.rotation));
        }

        newDoc.addPage(page);
        progressFill.style.width = `${((i + 1) / state.pmPages.length) * 100}%`;
      }

      const bytes = await newDoc.save();
      const baseName = state.pmSourceFiles[0]?.name?.replace(/\.pdf$/i, '') || 'output';
      const suffix = state.pmSourceFiles.length > 1 ? 'merged' : 'edited';
      downloadBlob(new Blob([bytes], { type: 'application/pdf' }), `${baseName}_${suffix}.pdf`);
      showToast('PDF berhasil disimpan!', 'success');
    }

  } catch (error) {
    console.error('Error processing PDF:', error);
    showToast('Gagal memproses PDF', 'error');
  } finally {
    progress.classList.add('hidden');
    btn.disabled = false;
  }
}

// ============================================================
// LEGACY MERGE PDF (kept for compatibility, redirects to Page Manager)
// ============================================================

async function addMergeFiles(files) {
  const fileList = document.getElementById('merge-file-list');
  
  // Clear placeholder
  if (state.mergeFiles.length === 0) {
    fileList.innerHTML = '';
  }
  
  for (const file of files) {
    if (file.type !== 'application/pdf') {
      showToast(`${file.name} bukan file PDF`, 'error');
      continue;
    }
    
    try {
      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      const page = await pdf.getPage(1);
      
      // Render thumbnail
      const scale = 0.3;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      
      await page.render({ canvasContext: ctx, viewport }).promise;
      
      const fileItem = createFileItem(file.name, formatFileSize(file.size), canvas.toDataURL(), state.mergeFiles.length);
      fileList.appendChild(fileItem);
      
      state.mergeFiles.push({
        name: file.name,
        bytes: bytes
      });
      
    } catch (error) {
      console.error('Error processing file:', error);
      showToast(`Gagal memproses ${file.name}`, 'error');
    }
  }
  
  // Add the "add file" button
  updateMergeAddButton();
  document.getElementById('merge-btn').disabled = state.mergeFiles.length < 2;
  
  // Enable drag to reorder
  enableDragReorder('merge-file-list', state.mergeFiles);
}

function createFileItem(name, size, thumbnail, index) {
  const div = document.createElement('div');
  div.className = 'file-item';
  div.dataset.index = index;
  div.draggable = true;

  // Escape HTML to prevent XSS
  const safeName = escapeHtml(name);
  const safeSize = escapeHtml(size);

  div.innerHTML = `
    <div class="file-item-preview">
      <img src="${thumbnail}" alt="preview">
    </div>
    <div class="file-item-info">
      <div class="file-item-name" title="${safeName}">${safeName}</div>
      <div class="file-item-size">${safeSize}</div>
    </div>
    <button class="file-item-remove">×</button>
  `;

  // Add click handler safely (avoid inline onclick with index)
  div.querySelector('.file-item-remove').addEventListener('click', () => removeMergeFile(index));

  return div;
}

function updateMergeAddButton() {
  const fileList = document.getElementById('merge-file-list');
  const existing = fileList.querySelector('.add-file-btn');
  if (existing) existing.remove();
  
  const addBtn = document.createElement('button');
  addBtn.className = 'add-file-btn';
  addBtn.innerHTML = `
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M12 5v14M5 12h14"/>
    </svg>
    <span>Tambah File</span>
  `;
  addBtn.onclick = () => document.getElementById('merge-input').click();
  fileList.appendChild(addBtn);
}

function removeMergeFile(index) {
  state.mergeFiles.splice(index, 1);
  refreshMergeList();
}

async function refreshMergeList() {
  const fileList = document.getElementById('merge-file-list');
  fileList.innerHTML = '';

  if (state.mergeFiles.length === 0) {
    fileList.innerHTML = '<p style="color: var(--text-tertiary); width: 100%; text-align: center;">Seret file PDF ke sini atau gunakan tombol di bawah</p>';
    document.getElementById('merge-btn').disabled = true;
    return;
  }

  // Use for...of to maintain order and await properly
  for (let i = 0; i < state.mergeFiles.length; i++) {
    const file = state.mergeFiles[i];
    try {
      const pdf = await pdfjsLib.getDocument({ data: file.bytes.slice() }).promise;
      const page = await pdf.getPage(1);

      const scale = 0.3;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');

      await page.render({ canvasContext: ctx, viewport }).promise;

      const fileItem = createFileItem(file.name, '', canvas.toDataURL(), i);
      const addBtn = fileList.querySelector('.add-file-btn');
      if (addBtn) {
        fileList.insertBefore(fileItem, addBtn);
      } else {
        fileList.appendChild(fileItem);
      }
    } catch (error) {
      console.error('Error refreshing file:', error);
    }
  }

  updateMergeAddButton();
  document.getElementById('merge-btn').disabled = state.mergeFiles.length < 2;
  enableDragReorder('merge-file-list', state.mergeFiles);
}

async function mergePDFs() {
  if (state.mergeFiles.length < 2) return;
  
  const progress = document.getElementById('merge-progress');
  const progressFill = progress.querySelector('.progress-fill');
  const progressText = progress.querySelector('.progress-text');
  
  progress.classList.remove('hidden');
  document.getElementById('merge-btn').disabled = true;
  
  try {
    const mergedPdf = await PDFLib.PDFDocument.create();
    
    for (let i = 0; i < state.mergeFiles.length; i++) {
      progressText.textContent = `Memproses file ${i + 1} dari ${state.mergeFiles.length}...`;
      progressFill.style.width = `${((i + 1) / state.mergeFiles.length) * 100}%`;
      
      const pdf = await PDFLib.PDFDocument.load(state.mergeFiles[i].bytes);
      const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
      pages.forEach(page => mergedPdf.addPage(page));
    }
    
    progressText.textContent = 'Menyimpan...';
    const mergedBytes = await mergedPdf.save();
    downloadBlob(new Blob([mergedBytes], { type: 'application/pdf' }), 'merged.pdf');
    
    showToast('PDF berhasil digabung!', 'success');
    
  } catch (error) {
    console.error('Error merging PDFs:', error);
    showToast('Gagal menggabung PDF', 'error');
  } finally {
    progress.classList.add('hidden');
    document.getElementById('merge-btn').disabled = false;
  }
}

// ============================================================
// SPLIT PDF
// ============================================================

async function renderSplitPages() {
  const container = document.getElementById('split-pages');
  container.innerHTML = '<div class="spinner"></div>';
  
  state.splitPages = [];
  const numPages = state.currentPDF.numPages;
  
  container.innerHTML = '';
  
  for (let i = 1; i <= numPages; i++) {
    const page = await state.currentPDF.getPage(i);
    const scale = 0.5;
    const viewport = page.getViewport({ scale });
    
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    
    await page.render({ canvasContext: ctx, viewport }).promise;
    
    const pageItem = document.createElement('div');
    pageItem.className = 'page-item';
    pageItem.dataset.page = i;
    pageItem.onclick = () => togglePageSelection(pageItem, i, 'split');
    
    pageItem.innerHTML = `
      <canvas></canvas>
      <div class="page-item-number">${i}</div>
      <div class="page-item-checkbox">✓</div>
    `;
    
    pageItem.querySelector('canvas').replaceWith(canvas);
    container.appendChild(pageItem);
    
    state.splitPages.push({ page: i, selected: false });
  }
  
  // Setup split mode change
  document.getElementById('split-mode').onchange = (e) => {
    const rangeInput = document.getElementById('split-range-input');
    rangeInput.style.display = e.target.value === 'range' ? 'flex' : 'none';
  };
}

function togglePageSelection(element, pageNum, tool) {
  element.classList.toggle('selected');
  
  if (tool === 'split') {
    const page = state.splitPages.find(p => p.page === pageNum);
    if (page) page.selected = !page.selected;
  } else if (tool === 'pdf-img') {
    const page = state.pdfImgPages.find(p => p.page === pageNum);
    if (page) page.selected = !page.selected;
  }
}

function selectAllPages() {
  const container = document.getElementById('split-pages');
  container.querySelectorAll('.page-item').forEach(item => {
    item.classList.add('selected');
  });
  state.splitPages.forEach(p => p.selected = true);
}

function deselectAllPages() {
  const container = document.getElementById('split-pages');
  container.querySelectorAll('.page-item').forEach(item => {
    item.classList.remove('selected');
  });
  state.splitPages.forEach(p => p.selected = false);
}

async function splitPDF() {
  const mode = document.getElementById('split-mode').value;
  const progress = document.getElementById('split-progress');
  const progressFill = progress.querySelector('.progress-fill');
  const progressText = progress.querySelector('.progress-text');
  const splitBtn = document.getElementById('split-btn');

  // Helper to hide progress and enable button
  const cleanup = () => {
    progress.classList.add('hidden');
    splitBtn.disabled = false;
  };

  progress.classList.remove('hidden');
  splitBtn.disabled = true;

  try {
    const srcDoc = await PDFLib.PDFDocument.load(state.currentPDFBytes);

    if (mode === 'each') {
      // Each page as separate file - create zip
      for (let i = 0; i < srcDoc.getPageCount(); i++) {
        progressText.textContent = `Memproses halaman ${i + 1}...`;
        progressFill.style.width = `${((i + 1) / srcDoc.getPageCount()) * 100}%`;

        const newDoc = await PDFLib.PDFDocument.create();
        const [page] = await newDoc.copyPages(srcDoc, [i]);
        newDoc.addPage(page);
        const bytes = await newDoc.save();

        downloadBlob(new Blob([bytes], { type: 'application/pdf' }), `halaman_${i + 1}.pdf`);
        await sleep(100); // Small delay between downloads
      }

      showToast('Semua halaman berhasil dipisah!', 'success');

    } else if (mode === 'range') {
      // Split by range
      const rangeStr = document.getElementById('split-range').value;
      const ranges = parsePageRanges(rangeStr, srcDoc.getPageCount());

      if (ranges.length === 0) {
        showToast('Format range tidak valid', 'error');
        cleanup();
        return;
      }

      for (let r = 0; r < ranges.length; r++) {
        progressText.textContent = `Memproses range ${r + 1}...`;
        progressFill.style.width = `${((r + 1) / ranges.length) * 100}%`;

        const newDoc = await PDFLib.PDFDocument.create();
        const pageIndices = ranges[r].map(p => p - 1);
        const pages = await newDoc.copyPages(srcDoc, pageIndices);
        pages.forEach(page => newDoc.addPage(page));

        const bytes = await newDoc.save();
        downloadBlob(new Blob([bytes], { type: 'application/pdf' }), `split_${r + 1}.pdf`);
        await sleep(100);
      }

      showToast('PDF berhasil dipisah!', 'success');

    } else {
      // Extract selected pages
      const selectedPages = state.splitPages.filter(p => p.selected).map(p => p.page - 1);

      if (selectedPages.length === 0) {
        showToast('Pilih minimal satu halaman', 'error');
        cleanup();
        return;
      }

      progressText.textContent = 'Mengekstrak halaman...';

      const newDoc = await PDFLib.PDFDocument.create();
      const pages = await newDoc.copyPages(srcDoc, selectedPages);
      pages.forEach(page => newDoc.addPage(page));

      const bytes = await newDoc.save();
      downloadBlob(new Blob([bytes], { type: 'application/pdf' }), 'extracted.pdf');

      showToast('Halaman berhasil diekstrak!', 'success');
    }

  } catch (error) {
    console.error('Error splitting PDF:', error);
    showToast('Gagal memisah PDF', 'error');
  } finally {
    cleanup();
  }
}

function parsePageRanges(str, maxPages) {
  const ranges = [];
  const parts = str.split(',').map(s => s.trim()).filter(s => s);
  
  for (const part of parts) {
    if (part.includes('-')) {
      const [start, end] = part.split('-').map(s => parseInt(s.trim()));
      if (!isNaN(start) && !isNaN(end) && start >= 1 && end <= maxPages && start <= end) {
        const range = [];
        for (let i = start; i <= end; i++) range.push(i);
        ranges.push(range);
      }
    } else {
      const page = parseInt(part);
      if (!isNaN(page) && page >= 1 && page <= maxPages) {
        ranges.push([page]);
      }
    }
  }
  
  return ranges;
}

// ============================================================
// ROTATE PDF
// ============================================================

async function renderRotatePages() {
  const container = document.getElementById('rotate-pages');
  container.innerHTML = '<div class="spinner"></div>';
  
  state.rotatePages = [];
  const numPages = state.currentPDF.numPages;
  
  container.innerHTML = '';
  
  for (let i = 1; i <= numPages; i++) {
    const page = await state.currentPDF.getPage(i);
    const scale = 0.5;
    const viewport = page.getViewport({ scale });
    
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    
    await page.render({ canvasContext: ctx, viewport }).promise;
    
    const pageItem = document.createElement('div');
    pageItem.className = 'page-item';
    pageItem.dataset.page = i;
    pageItem.onclick = () => pageItem.classList.toggle('selected');
    
    pageItem.innerHTML = `
      <canvas></canvas>
      <div class="page-item-number">${i}</div>
      <div class="page-item-checkbox">✓</div>
    `;
    
    pageItem.querySelector('canvas').replaceWith(canvas);
    container.appendChild(pageItem);
    
    state.rotatePages.push({ page: i, rotation: 0, canvas });
  }
}

function rotateSelected(degrees) {
  const container = document.getElementById('rotate-pages');
  const selected = container.querySelectorAll('.page-item.selected');

  selected.forEach(item => {
    const pageNum = parseInt(item.dataset.page);
    const pageState = state.rotatePages.find(p => p.page === pageNum);
    if (pageState) {
      // Fix negative rotation: ensure result is always positive
      pageState.rotation = ((pageState.rotation + degrees) % 360 + 360) % 360;
      const canvas = item.querySelector('canvas');
      canvas.style.transform = `rotate(${pageState.rotation}deg)`;
    }
  });
}

function rotateAll(degrees) {
  state.rotatePages.forEach(pageState => {
    // Fix negative rotation: ensure result is always positive
    pageState.rotation = ((pageState.rotation + degrees) % 360 + 360) % 360;
  });
  
  const container = document.getElementById('rotate-pages');
  container.querySelectorAll('.page-item canvas').forEach((canvas, i) => {
    canvas.style.transform = `rotate(${state.rotatePages[i].rotation}deg)`;
  });
}

async function saveRotatedPDF() {
  try {
    const srcDoc = await PDFLib.PDFDocument.load(state.currentPDFBytes);
    
    state.rotatePages.forEach(pageState => {
      if (pageState.rotation !== 0) {
        const page = srcDoc.getPage(pageState.page - 1);
        const currentRotation = page.getRotation().angle;
        page.setRotation(PDFLib.degrees(currentRotation + pageState.rotation));
      }
    });
    
    const bytes = await srcDoc.save();
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), 'rotated.pdf');
    showToast('PDF berhasil diputar!', 'success');
    
  } catch (error) {
    console.error('Error rotating PDF:', error);
    showToast('Gagal memutar PDF', 'error');
  }
}

// ============================================================
// PAGES (REORDER/DELETE)
// ============================================================

async function renderPagesGrid() {
  const container = document.getElementById('pages-grid');
  container.innerHTML = '<div class="spinner"></div>';
  
  state.pagesOrder = [];
  const numPages = state.currentPDF.numPages;
  
  container.innerHTML = '';
  
  for (let i = 1; i <= numPages; i++) {
    const page = await state.currentPDF.getPage(i);
    const scale = 0.5;
    const viewport = page.getViewport({ scale });
    
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    
    await page.render({ canvasContext: ctx, viewport }).promise;
    
    const pageItem = document.createElement('div');
    pageItem.className = 'page-item';
    pageItem.dataset.page = i;
    pageItem.draggable = true;
    pageItem.onclick = (e) => {
      if (!e.target.closest('.file-item-remove')) {
        pageItem.classList.toggle('selected');
      }
    };
    
    pageItem.innerHTML = `
      <canvas></canvas>
      <div class="page-item-number">${i}</div>
      <div class="page-item-checkbox">✓</div>
      <button class="file-item-remove" onclick="event.stopPropagation(); deletePageFromGrid(${i})">×</button>
    `;
    
    pageItem.querySelector('canvas').replaceWith(canvas);
    container.appendChild(pageItem);
    
    state.pagesOrder.push(i);
  }
  
  enableDragReorder('pages-grid', state.pagesOrder, true);
}

function deletePageFromGrid(pageNum) {
  const index = state.pagesOrder.indexOf(pageNum);
  if (index > -1) {
    state.pagesOrder.splice(index, 1);
    const container = document.getElementById('pages-grid');
    const item = container.querySelector(`[data-page="${pageNum}"]`);
    if (item) item.remove();
    
    // Renumber visible pages
    container.querySelectorAll('.page-item').forEach((item, i) => {
      item.querySelector('.page-item-number').textContent = i + 1;
    });
  }
  
  if (state.pagesOrder.length === 0) {
    document.getElementById('pages-btn').disabled = true;
  }
}

function deleteSelectedPages() {
  const container = document.getElementById('pages-grid');
  const selected = container.querySelectorAll('.page-item.selected');
  
  selected.forEach(item => {
    const pageNum = parseInt(item.dataset.page);
    deletePageFromGrid(pageNum);
  });
}

async function saveReorderedPDF() {
  if (state.pagesOrder.length === 0) {
    showToast('Tidak ada halaman tersisa', 'error');
    return;
  }
  
  try {
    const srcDoc = await PDFLib.PDFDocument.load(state.currentPDFBytes);
    const newDoc = await PDFLib.PDFDocument.create();
    
    const pageIndices = state.pagesOrder.map(p => p - 1);
    const pages = await newDoc.copyPages(srcDoc, pageIndices);
    pages.forEach(page => newDoc.addPage(page));
    
    const bytes = await newDoc.save();
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), 'reordered.pdf');
    showToast('PDF berhasil disimpan!', 'success');
    
  } catch (error) {
    console.error('Error saving PDF:', error);
    showToast('Gagal menyimpan PDF', 'error');
  }
}

// ============================================================
// DRAG REORDER
// ============================================================

function enableDragReorder(containerId, stateArray, isPages = false) {
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
      
      // Update state array
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

// ============================================================
// PDF TO IMAGE
// ============================================================

async function renderPdfImgPages() {
  const container = document.getElementById('pdf-img-pages');
  container.innerHTML = '<div class="spinner"></div>';
  container.classList.remove('empty');

  state.pdfImgPages = [];
  const numPages = state.currentPDF.numPages;

  container.innerHTML = '';
  
  for (let i = 1; i <= numPages; i++) {
    const page = await state.currentPDF.getPage(i);
    const scale = 0.5;
    const viewport = page.getViewport({ scale });
    
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    
    await page.render({ canvasContext: ctx, viewport }).promise;
    
    const pageItem = document.createElement('div');
    pageItem.className = 'page-item selected';
    pageItem.dataset.page = i;
    pageItem.onclick = () => togglePageSelection(pageItem, i, 'pdf-img');
    
    pageItem.innerHTML = `
      <canvas></canvas>
      <div class="page-item-number">${i}</div>
      <div class="page-item-checkbox">✓</div>
    `;
    
    pageItem.querySelector('canvas').replaceWith(canvas);
    container.appendChild(pageItem);
    
    state.pdfImgPages.push({ page: i, selected: true });
  }
}

function selectAllPdfImgPages() {
  const container = document.getElementById('pdf-img-pages');
  container.querySelectorAll('.page-item').forEach(item => item.classList.add('selected'));
  state.pdfImgPages.forEach(p => p.selected = true);
}

async function convertPDFtoImages() {
  const selectedPages = state.pdfImgPages.filter(p => p.selected);
  if (selectedPages.length === 0) {
    showToast('Pilih minimal satu halaman', 'error');
    return;
  }

  const format = document.getElementById('img-format').value;
  const scale = parseFloat(document.getElementById('img-scale').value);

  const progress = document.getElementById('pdf-img-progress');
  const progressFill = progress.querySelector('.progress-fill');
  const progressText = progress.querySelector('.progress-text');

  progress.classList.remove('hidden');
  document.getElementById('pdf-img-btn').disabled = true;

  try {
    for (let i = 0; i < selectedPages.length; i++) {
      const pageNum = selectedPages[i].page;
      progressText.textContent = `Mengkonversi halaman ${pageNum}...`;
      progressFill.style.width = `${((i + 1) / selectedPages.length) * 100}%`;

      const page = await state.currentPDF.getPage(pageNum);
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');

      await page.render({ canvasContext: ctx, viewport }).promise;

      const mimeType = format === 'png' ? 'image/png' : 'image/jpeg';
      const quality = format === 'png' ? undefined : 0.92;

      // Await blob creation to ensure proper ordering
      await new Promise((resolve) => {
        canvas.toBlob((blob) => {
          if (blob) {
            const baseName = state.currentPDFName?.replace(/\.pdf$/i, '') || 'halaman';
            downloadBlob(blob, `${baseName}_page${pageNum}.${format}`);
          }
          resolve();
        }, mimeType, quality);
      });

      await sleep(100);
    }

    showToast('Semua halaman berhasil dikonversi!', 'success');

  } catch (error) {
    console.error('Error converting PDF to images:', error);
    showToast('Gagal mengkonversi PDF', 'error');
  } finally {
    progress.classList.add('hidden');
    document.getElementById('pdf-img-btn').disabled = false;
  }
}

// ============================================================
// COMPRESS PDF
// ============================================================

async function showPDFPreview(containerId) {
  const container = document.getElementById(containerId);
  
  try {
    const page = await state.currentPDF.getPage(1);
    const scale = 0.5;
    const viewport = page.getViewport({ scale });
    
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    
    await page.render({ canvasContext: ctx, viewport }).promise;
    
    container.innerHTML = '';
    container.appendChild(canvas);
    canvas.style.maxWidth = '300px';
    canvas.style.borderRadius = 'var(--radius-md)';
    canvas.style.boxShadow = 'var(--shadow-paper)';
    
  } catch (error) {
    container.innerHTML = '<p style="color: var(--text-tertiary)">Gagal memuat preview</p>';
  }
}

async function compressPDF() {
  const quality = parseInt(document.getElementById('pdf-quality').value) / 100;

  const progress = document.getElementById('compress-pdf-progress');
  const progressFill = progress.querySelector('.progress-fill');
  const progressText = progress.querySelector('.progress-text');

  progress.classList.remove('hidden');
  document.getElementById('compress-pdf-btn').disabled = true;

  try {
    progressText.textContent = 'Menganalisis PDF...';

    const srcDoc = await PDFLib.PDFDocument.load(state.currentPDFBytes, {
      ignoreEncryption: true
    });

    const pages = srcDoc.getPages();

    for (let i = 0; i < pages.length; i++) {
      progressText.textContent = `Memproses halaman ${i + 1} dari ${pages.length}...`;
      progressFill.style.width = `${((i + 1) / pages.length) * 100}%`;
      // Small delay to show progress
      await sleep(50);
    }

    progressText.textContent = 'Mengoptimasi struktur PDF...';

    // Use object streams for better compression of PDF structure
    const bytes = await srcDoc.save({
      useObjectStreams: true,
      addDefaultPage: false,
    });

    const originalSize = state.currentPDFBytes.length;
    const newSize = bytes.length;
    const reduction = ((originalSize - newSize) / originalSize * 100).toFixed(1);

    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), getOutputFilename('compressed'));

    if (newSize < originalSize) {
      showToast(`PDF dikompres! Berkurang ${reduction}%`, 'success');
    } else {
      // More informative message about limitations
      showToast('Ukuran tidak berubah. Fitur ini hanya mengoptimasi struktur PDF, bukan gambar di dalamnya.', 'info');
    }

  } catch (error) {
    console.error('Error compressing PDF:', error);
    showToast('Gagal mengkompres PDF', 'error');
  } finally {
    progress.classList.add('hidden');
    document.getElementById('compress-pdf-btn').disabled = false;
  }
}

// ============================================================
// PROTECT PDF
// ============================================================

async function protectPDF() {
  const password = document.getElementById('protect-password').value;
  const confirm = document.getElementById('protect-password-confirm').value;
  
  if (!password) {
    showToast('Masukkan password', 'error');
    return;
  }
  
  if (password !== confirm) {
    showToast('Password tidak cocok', 'error');
    return;
  }
  
  try {
    const srcDoc = await PDFLib.PDFDocument.load(state.currentPDFBytes);
    
    const bytes = await srcDoc.save({
      userPassword: password,
      ownerPassword: password,
    });
    
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), getOutputFilename('protected'));
    showToast('PDF berhasil diproteksi!', 'success');
    
  } catch (error) {
    console.error('Error protecting PDF:', error);
    showToast('Gagal memproteksi PDF', 'error');
  }
}

// ============================================================
// UNLOCK PDF
// ============================================================

async function unlockPDF() {
  const password = document.getElementById('unlock-password').value;
  
  if (!password) {
    showToast('Masukkan password', 'error');
    return;
  }
  
  try {
    const srcDoc = await PDFLib.PDFDocument.load(state.currentPDFBytes, {
      password: password
    });
    
    const bytes = await srcDoc.save();
    
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), getOutputFilename('unlocked'));
    showToast('PDF berhasil dibuka!', 'success');
    
  } catch (error) {
    console.error('Error unlocking PDF:', error);
    showToast('Password salah atau PDF tidak bisa dibuka', 'error');
  }
}

// ============================================================
// WATERMARK PDF
// ============================================================

async function initWatermarkMode() {
  state.currentWatermarkPage = 0;
  await updateWatermarkPreview();
}

async function updateWatermarkPreview() {
  if (!state.currentPDF) return;
  
  const canvas = document.getElementById('watermark-preview-canvas');
  const ctx = canvas.getContext('2d');
  
  const page = await state.currentPDF.getPage(1);
  const scale = 1;
  const viewport = page.getViewport({ scale });
  
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  
  await page.render({ canvasContext: ctx, viewport }).promise;
  
  // Draw watermark preview
  const text = document.getElementById('watermark-text').value || 'WATERMARK';
  const size = parseInt(document.getElementById('watermark-size').value);
  const color = document.getElementById('watermark-color').value;
  const opacity = parseInt(document.getElementById('watermark-opacity').value) / 100;
  const rotation = parseInt(document.getElementById('watermark-rotation').value);
  
  // Update opacity display
  document.querySelector('#watermark-workspace .range-value').textContent = 
    document.getElementById('watermark-opacity').value + '%';
  
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(rotation * Math.PI / 180);
  ctx.font = `${size}px Arial`;
  ctx.fillStyle = color;
  ctx.globalAlpha = opacity;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

async function addWatermark() {
  const text = document.getElementById('watermark-text').value || 'WATERMARK';
  const size = parseInt(document.getElementById('watermark-size').value);
  const color = document.getElementById('watermark-color').value;
  const opacity = parseInt(document.getElementById('watermark-opacity').value) / 100;
  const rotation = parseInt(document.getElementById('watermark-rotation').value);
  
  try {
    const srcDoc = await PDFLib.PDFDocument.load(state.currentPDFBytes);
    const pages = srcDoc.getPages();
    
    // Convert hex color to RGB
    const r = parseInt(color.slice(1, 3), 16) / 255;
    const g = parseInt(color.slice(3, 5), 16) / 255;
    const b = parseInt(color.slice(5, 7), 16) / 255;
    
    const font = await srcDoc.embedFont(PDFLib.StandardFonts.Helvetica);
    
    for (const page of pages) {
      const { width, height } = page.getSize();
      
      page.drawText(text, {
        x: width / 2 - (text.length * size * 0.3),
        y: height / 2,
        size: size,
        font: font,
        color: PDFLib.rgb(r, g, b),
        opacity: opacity,
        rotate: PDFLib.degrees(rotation),
      });
    }
    
    const bytes = await srcDoc.save();
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), getOutputFilename('watermark'));
    showToast('Watermark berhasil ditambahkan!', 'success');
    
  } catch (error) {
    console.error('Error adding watermark:', error);
    showToast('Gagal menambahkan watermark', 'error');
  }
}

// ============================================================
// PAGE NUMBERS
// ============================================================

async function addPageNumbers() {
  const position = document.getElementById('page-num-position').value;
  const format = document.getElementById('page-num-format').value;
  const startNum = parseInt(document.getElementById('page-num-start').value) || 1;
  const fontSize = parseInt(document.getElementById('page-num-size').value);
  
  try {
    const srcDoc = await PDFLib.PDFDocument.load(state.currentPDFBytes);
    const pages = srcDoc.getPages();
    const font = await srcDoc.embedFont(PDFLib.StandardFonts.Helvetica);
    const totalPages = pages.length;
    
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const { width, height } = page.getSize();
      const pageNum = startNum + i;
      
      let text;
      switch (format) {
        case 'page-of':
          text = `Halaman ${pageNum} dari ${totalPages + startNum - 1}`;
          break;
        case 'dash':
          text = `- ${pageNum} -`;
          break;
        default:
          text = `${pageNum}`;
      }
      
      const textWidth = font.widthOfTextAtSize(text, fontSize);
      let x, y;
      
      switch (position) {
        case 'bottom-left':
          x = 40;
          y = 30;
          break;
        case 'bottom-right':
          x = width - textWidth - 40;
          y = 30;
          break;
        case 'top-center':
          x = (width - textWidth) / 2;
          y = height - 30;
          break;
        case 'top-left':
          x = 40;
          y = height - 30;
          break;
        case 'top-right':
          x = width - textWidth - 40;
          y = height - 30;
          break;
        default: // bottom-center
          x = (width - textWidth) / 2;
          y = 30;
      }
      
      page.drawText(text, {
        x,
        y,
        size: fontSize,
        font,
        color: PDFLib.rgb(0, 0, 0),
      });
    }
    
    const bytes = await srcDoc.save();
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), getOutputFilename('numbered'));
    showToast('Nomor halaman berhasil ditambahkan!', 'success');
    
  } catch (error) {
    console.error('Error adding page numbers:', error);
    showToast('Gagal menambahkan nomor halaman', 'error');
  }
}

// ============================================================
// CROP PDF
// ============================================================

async function initCropMode() {
  state.currentCropPage = 0;
  state.cropRect = null;
  await renderCropPage();
  setupCropCanvas();
}

async function renderCropPage() {
  const canvas = document.getElementById('crop-canvas');
  const ctx = canvas.getContext('2d');
  
  const page = await state.currentPDF.getPage(state.currentCropPage + 1);
  const scale = 1;
  const viewport = page.getViewport({ scale });
  
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  
  await page.render({ canvasContext: ctx, viewport }).promise;
  
  document.getElementById('crop-page-info').textContent = 
    `Halaman ${state.currentCropPage + 1} dari ${state.currentPDF.numPages}`;
  
  // Redraw crop rect if exists
  if (state.cropRect) {
    drawCropRect();
  }
}

function setupCropCanvas() {
  // Prevent duplicate event listeners
  if (state.cropCanvasSetup) {
    return;
  }

  const canvas = document.getElementById('crop-canvas');
  if (!canvas) return;

  state.cropCanvasSetup = true;

  let isDrawing = false;
  let startX, startY;

  canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    startX = (e.clientX - rect.left) * scaleX;
    startY = (e.clientY - rect.top) * scaleY;
    isDrawing = true;
  });

  canvas.addEventListener('mousemove', (e) => {
    if (!isDrawing) return;

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const currentX = (e.clientX - rect.left) * scaleX;
    const currentY = (e.clientY - rect.top) * scaleY;

    state.cropRect = {
      x: Math.min(startX, currentX),
      y: Math.min(startY, currentY),
      width: Math.abs(currentX - startX),
      height: Math.abs(currentY - startY)
    };

    renderCropPage();
  });

  canvas.addEventListener('mouseup', () => {
    isDrawing = false;
  });

  // Also handle mouse leaving the canvas
  canvas.addEventListener('mouseleave', () => {
    isDrawing = false;
  });
}

function drawCropRect() {
  if (!state.cropRect) return;
  
  const canvas = document.getElementById('crop-canvas');
  const ctx = canvas.getContext('2d');
  
  // Draw semi-transparent overlay outside crop area
  ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
  
  // Top
  ctx.fillRect(0, 0, canvas.width, state.cropRect.y);
  // Bottom
  ctx.fillRect(0, state.cropRect.y + state.cropRect.height, canvas.width, canvas.height - state.cropRect.y - state.cropRect.height);
  // Left
  ctx.fillRect(0, state.cropRect.y, state.cropRect.x, state.cropRect.height);
  // Right
  ctx.fillRect(state.cropRect.x + state.cropRect.width, state.cropRect.y, canvas.width - state.cropRect.x - state.cropRect.width, state.cropRect.height);
  
  // Draw crop border
  ctx.strokeStyle = '#dc2626';
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 5]);
  ctx.strokeRect(state.cropRect.x, state.cropRect.y, state.cropRect.width, state.cropRect.height);
}

function cropPrevPage() {
  if (state.currentCropPage > 0) {
    state.currentCropPage--;
    renderCropPage();
  }
}

function cropNextPage() {
  if (state.currentCropPage < state.currentPDF.numPages - 1) {
    state.currentCropPage++;
    renderCropPage();
  }
}

function resetCrop() {
  state.cropRect = null;
  renderCropPage();
}

async function applyCrop() {
  if (!state.cropRect) {
    showToast('Tentukan area crop terlebih dahulu', 'error');
    return;
  }

  try {
    const srcDoc = await PDFLib.PDFDocument.load(state.currentPDFBytes);
    const pages = srcDoc.getPages();
    const applyToAll = document.getElementById('crop-all-pages').checked;

    // Get the canvas dimensions
    const canvas = document.getElementById('crop-canvas');

    // Get the current page being viewed for scale calculation
    const currentPage = pages[state.currentCropPage];
    const { width: currentPageWidth, height: currentPageHeight } = currentPage.getSize();

    // Calculate scale based on current page
    const scaleX = currentPageWidth / canvas.width;
    const scaleY = currentPageHeight / canvas.height;

    if (applyToAll) {
      // Apply to all pages - need to recalculate for each page size
      for (const page of pages) {
        const { width: pageWidth, height: pageHeight } = page.getSize();

        // Scale the crop rectangle relative to each page's dimensions
        const pageScaleX = pageWidth / currentPageWidth;
        const pageScaleY = pageHeight / currentPageHeight;

        // PDF coordinates start from bottom-left
        const cropBox = {
          x: state.cropRect.x * scaleX * pageScaleX,
          y: pageHeight - (state.cropRect.y + state.cropRect.height) * scaleY * pageScaleY,
          width: state.cropRect.width * scaleX * pageScaleX,
          height: state.cropRect.height * scaleY * pageScaleY
        };

        // Clamp crop box to page bounds
        cropBox.x = Math.max(0, Math.min(cropBox.x, pageWidth));
        cropBox.y = Math.max(0, Math.min(cropBox.y, pageHeight));
        cropBox.width = Math.min(cropBox.width, pageWidth - cropBox.x);
        cropBox.height = Math.min(cropBox.height, pageHeight - cropBox.y);

        page.setCropBox(cropBox.x, cropBox.y, cropBox.width, cropBox.height);
      }
    } else {
      // Apply to current page only
      const { width: pageWidth, height: pageHeight } = currentPage.getSize();

      // PDF coordinates start from bottom-left
      const cropBox = {
        x: state.cropRect.x * scaleX,
        y: pageHeight - (state.cropRect.y + state.cropRect.height) * scaleY,
        width: state.cropRect.width * scaleX,
        height: state.cropRect.height * scaleY
      };

      currentPage.setCropBox(cropBox.x, cropBox.y, cropBox.width, cropBox.height);
    }

    const bytes = await srcDoc.save();
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), getOutputFilename('cropped'));
    showToast('PDF berhasil di-crop!', 'success');

  } catch (error) {
    console.error('Error cropping PDF:', error);
    showToast('Gagal meng-crop PDF', 'error');
  }
}

// ============================================================
// EDIT PDF (Whiteout, Text, Signature) - Enhanced Version
// ============================================================

async function initEditMode() {
  state.currentEditPage = 0;
  state.editAnnotations = {};
  state.currentEditTool = null;
  state.editUndoStack = [];
  state.editRedoStack = [];
  state.selectedAnnotation = null;
  state.pendingTextPosition = null;
  state.editPageScales = {};
  state.editDevicePixelRatio = window.devicePixelRatio || 1;

  for (let i = 0; i < state.currentPDF.numPages; i++) {
    state.editAnnotations[i] = [];
  }

  // Setup keyboard shortcuts
  setupEditKeyboardShortcuts();

  await renderEditPage();
  setupEditCanvas();
  updateEditorStatus('Pilih alat untuk mulai mengedit');
}

// Cached PDF page image for smooth dragging
let editPageCache = null;

async function renderEditPage() {
  const canvas = document.getElementById('edit-canvas');
  const ctx = canvas.getContext('2d');
  const dpr = state.editDevicePixelRatio;

  const page = await state.currentPDF.getPage(state.currentEditPage + 1);

  // Use adaptive scaling based on container width
  const wrapper = document.querySelector('.editor-canvas-wrapper');
  const maxWidth = wrapper ? wrapper.clientWidth - 40 : 800;
  const naturalViewport = page.getViewport({ scale: 1 });

  // Calculate scale to fit width while maintaining quality
  let scale = Math.min(maxWidth / naturalViewport.width, 2);
  scale = Math.max(scale, 1); // Minimum scale of 1

  const viewport = page.getViewport({ scale });

  // Store scale info for this page for coordinate transformation
  state.editPageScales[state.currentEditPage] = {
    scale: scale,
    pdfWidth: naturalViewport.width,
    pdfHeight: naturalViewport.height,
    canvasWidth: viewport.width,
    canvasHeight: viewport.height
  };

  // Set canvas size accounting for device pixel ratio for crisp rendering
  canvas.width = viewport.width * dpr;
  canvas.height = viewport.height * dpr;
  canvas.style.width = viewport.width + 'px';
  canvas.style.height = viewport.height + 'px';

  // Scale context for high-DPI displays
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  await page.render({ canvasContext: ctx, viewport }).promise;

  // Cache the rendered PDF page (without annotations) for smooth dragging
  editPageCache = ctx.getImageData(0, 0, canvas.width, canvas.height);

  // Draw annotations
  redrawAnnotationsOnly();

  document.getElementById('edit-page-info').textContent =
    `Halaman ${state.currentEditPage + 1} dari ${state.currentPDF.numPages}`;

  document.getElementById('edit-prev').disabled = state.currentEditPage === 0;
  document.getElementById('edit-next').disabled = state.currentEditPage === state.currentPDF.numPages - 1;
}

// Synchronous function to redraw annotations from cache - used during drag
function redrawAnnotationsOnly() {
  const canvas = document.getElementById('edit-canvas');
  const ctx = canvas.getContext('2d');

  // Restore cached PDF page
  if (editPageCache) {
    ctx.putImageData(editPageCache, 0, 0);
  }

  // Reset transform after putImageData (which resets it)
  ctx.setTransform(state.editDevicePixelRatio, 0, 0, state.editDevicePixelRatio, 0, 0);

  // Draw annotations synchronously
  const annotations = state.editAnnotations[state.currentEditPage] || [];
  for (let i = 0; i < annotations.length; i++) {
    const anno = annotations[i];
    const isSelected = state.selectedAnnotation &&
                       state.selectedAnnotation.pageNum === state.currentEditPage &&
                       state.selectedAnnotation.index === i;
    drawAnnotationSync(ctx, anno, isSelected);
  }
}

// Synchronous version of drawAnnotation for drag operations
function drawAnnotationSync(ctx, anno, isSelected = false) {
  switch (anno.type) {
    case 'whiteout':
      ctx.fillStyle = 'white';
      ctx.fillRect(anno.x, anno.y, anno.width, anno.height);
      if (isSelected) {
        drawSelectionHandles(ctx, anno.x, anno.y, anno.width, anno.height);
      }
      break;
    case 'text':
      ctx.font = `${anno.fontSize}px Arial`;
      ctx.fillStyle = anno.color;
      const lines = anno.text.split('\n');
      lines.forEach((line, i) => {
        ctx.fillText(line, anno.x, anno.y + (i * anno.fontSize * 1.2));
      });
      if (isSelected) {
        const metrics = ctx.measureText(anno.text);
        const textHeight = anno.fontSize * lines.length * 1.2;
        drawSelectionHandles(ctx, anno.x - 2, anno.y - anno.fontSize, metrics.width + 4, textHeight + 4);
      }
      break;
    case 'signature':
      if (anno.image) {
        // Create and cache image if not already cached
        if (!anno.cachedImg) {
          const img = new Image();
          img.src = anno.image;
          anno.cachedImg = img;
        }
        // Draw if image is loaded (data URLs load almost instantly)
        if (anno.cachedImg.complete && anno.cachedImg.naturalWidth > 0) {
          ctx.drawImage(anno.cachedImg, anno.x, anno.y, anno.width, anno.height);
          if (isSelected) {
            drawSelectionHandles(ctx, anno.x, anno.y, anno.width, anno.height);
          }
        }
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
      // Adjust text alignment based on position
      if (anno.position.includes('center')) {
        ctx.textAlign = 'center';
      } else if (anno.position.includes('right')) {
        ctx.textAlign = 'right';
      } else {
        ctx.textAlign = 'left';
      }
      ctx.fillText(anno.text, anno.x, anno.y);
      ctx.textAlign = 'left'; // Reset
      break;
  }
}

function drawAnnotation(ctx, anno, isSelected = false) {
  return new Promise((resolve) => {
    switch (anno.type) {
      case 'whiteout':
        ctx.fillStyle = 'white';
        ctx.fillRect(anno.x, anno.y, anno.width, anno.height);
        if (isSelected) {
          drawSelectionHandles(ctx, anno.x, anno.y, anno.width, anno.height);
        }
        resolve();
        break;
      case 'text':
        ctx.font = `${anno.fontSize}px Arial`;
        ctx.fillStyle = anno.color;
        // Handle multi-line text
        const lines = anno.text.split('\n');
        lines.forEach((line, i) => {
          ctx.fillText(line, anno.x, anno.y + (i * anno.fontSize * 1.2));
        });
        if (isSelected) {
          // Calculate text bounds for selection
          const metrics = ctx.measureText(anno.text);
          const textHeight = anno.fontSize * lines.length * 1.2;
          drawSelectionHandles(ctx, anno.x - 2, anno.y - anno.fontSize, metrics.width + 4, textHeight + 4);
        }
        resolve();
        break;
      case 'signature':
        if (anno.image && anno.cachedImg) {
          ctx.drawImage(anno.cachedImg, anno.x, anno.y, anno.width, anno.height);
          if (isSelected) {
            drawSelectionHandles(ctx, anno.x, anno.y, anno.width, anno.height);
          }
          resolve();
        } else if (anno.image) {
          const img = new Image();
          img.onload = () => {
            anno.cachedImg = img;
            ctx.drawImage(img, anno.x, anno.y, anno.width, anno.height);
            if (isSelected) {
              drawSelectionHandles(ctx, anno.x, anno.y, anno.width, anno.height);
            }
            resolve();
          };
          img.onerror = () => resolve();
          img.src = anno.image;
        } else {
          resolve();
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
        resolve();
        break;
      case 'pageNumber':
        ctx.font = `${anno.fontSize}px Arial`;
        ctx.fillStyle = anno.color;
        if (anno.position.includes('center')) {
          ctx.textAlign = 'center';
        } else if (anno.position.includes('right')) {
          ctx.textAlign = 'right';
        } else {
          ctx.textAlign = 'left';
        }
        ctx.fillText(anno.text, anno.x, anno.y);
        ctx.textAlign = 'left';
        resolve();
        break;
      default:
        resolve();
    }
  });
}

function drawSelectionHandles(ctx, x, y, width, height) {
  // Draw selection border
  ctx.strokeStyle = '#3B82F6';
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 3]);
  ctx.strokeRect(x - 2, y - 2, width + 4, height + 4);
  ctx.setLineDash([]);

  // Draw corner handles
  const handleSize = 8;
  ctx.fillStyle = '#3B82F6';

  // Top-left
  ctx.fillRect(x - handleSize/2 - 2, y - handleSize/2 - 2, handleSize, handleSize);
  // Top-right
  ctx.fillRect(x + width - handleSize/2 + 2, y - handleSize/2 - 2, handleSize, handleSize);
  // Bottom-left
  ctx.fillRect(x - handleSize/2 - 2, y + height - handleSize/2 + 2, handleSize, handleSize);
  // Bottom-right
  ctx.fillRect(x + width - handleSize/2 + 2, y + height - handleSize/2 + 2, handleSize, handleSize);
}

function getCanvasCoordinates(e, canvas) {
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (canvas.width / canvas.clientWidth / state.editDevicePixelRatio);
  const y = (e.clientY - rect.top) * (canvas.height / canvas.clientHeight / state.editDevicePixelRatio);
  return { x, y };
}

function setupEditCanvas() {
  if (state.editCanvasSetup) {
    return;
  }

  const canvas = document.getElementById('edit-canvas');
  if (!canvas) return;

  state.editCanvasSetup = true;

  let isDrawing = false;
  let isDragging = false;
  let isResizing = false;
  let startX, startY;
  let dragOffsetX, dragOffsetY;

  // Mouse event handlers
  canvas.addEventListener('mousedown', (e) => handlePointerDown(e, canvas));
  canvas.addEventListener('mousemove', (e) => handlePointerMove(e, canvas));
  canvas.addEventListener('mouseup', (e) => handlePointerUp(e, canvas));
  canvas.addEventListener('mouseleave', () => { isDrawing = false; isDragging = false; });

  // Touch event handlers for mobile support
  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const touch = e.touches[0];
    handlePointerDown({ clientX: touch.clientX, clientY: touch.clientY }, canvas);
  }, { passive: false });

  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    const touch = e.touches[0];
    handlePointerMove({ clientX: touch.clientX, clientY: touch.clientY }, canvas);
  }, { passive: false });

  canvas.addEventListener('touchend', (e) => {
    e.preventDefault();
    const touch = e.changedTouches[0];
    handlePointerUp({ clientX: touch.clientX, clientY: touch.clientY }, canvas);
  }, { passive: false });

  function handlePointerDown(e, canvas) {
    const { x, y } = getCanvasCoordinates(e, canvas);
    startX = x;
    startY = y;

    // Check if clicking on an existing annotation (select mode)
    if (state.currentEditTool === 'select') {
      const clickedAnno = findAnnotationAt(x, y);
      if (clickedAnno) {
        // Save undo state BEFORE we start dragging (so we can undo to original position)
        saveUndoState();
        state.selectedAnnotation = clickedAnno;
        isDragging = true;
        const anno = state.editAnnotations[clickedAnno.pageNum][clickedAnno.index];
        dragOffsetX = x - anno.x;
        dragOffsetY = y - (anno.type === 'text' ? anno.y - anno.fontSize : anno.y);
        redrawAnnotationsOnly();
        return;
      } else {
        state.selectedAnnotation = null;
        redrawAnnotationsOnly();
      }
    }

    if (!state.currentEditTool || state.currentEditTool === 'select') return;
    isDrawing = true;
  }

  function handlePointerMove(e, canvas) {
    const { x, y } = getCanvasCoordinates(e, canvas);

    // Handle dragging selected annotation - use synchronous redraw for smooth movement
    if (isDragging && state.selectedAnnotation) {
      const anno = state.editAnnotations[state.selectedAnnotation.pageNum][state.selectedAnnotation.index];
      if (anno.type === 'text') {
        anno.x = x - dragOffsetX;
        anno.y = y - dragOffsetY + anno.fontSize;
      } else {
        anno.x = x - dragOffsetX;
        anno.y = y - dragOffsetY;
      }
      // Use synchronous redraw from cache - no async issues
      redrawAnnotationsOnly();
      return;
    }

    if (!isDrawing || state.currentEditTool !== 'whiteout') return;

    // Draw preview for whiteout - use synchronous redraw
    redrawAnnotationsOnly();
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.strokeStyle = '#3B82F6';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 3]);
    ctx.fillRect(
      Math.min(startX, x),
      Math.min(startY, y),
      Math.abs(x - startX),
      Math.abs(y - startY)
    );
    ctx.strokeRect(
      Math.min(startX, x),
      Math.min(startY, y),
      Math.abs(x - startX),
      Math.abs(y - startY)
    );
    ctx.setLineDash([]);
  }

  function handlePointerUp(e, canvas) {
    const { x, y } = getCanvasCoordinates(e, canvas);

    // Handle end of drag (undo state was already saved in handlePointerDown)
    if (isDragging) {
      isDragging = false;
      return;
    }

    if (!isDrawing) return;
    isDrawing = false;

    if (state.currentEditTool === 'whiteout') {
      const width = Math.abs(x - startX);
      const height = Math.abs(y - startY);
      if (width > 5 && height > 5) { // Minimum size
        saveUndoState();
        state.editAnnotations[state.currentEditPage].push({
          type: 'whiteout',
          x: Math.min(startX, x),
          y: Math.min(startY, y),
          width,
          height
        });
        renderEditPage();
      }
    } else if (state.currentEditTool === 'text') {
      state.pendingTextPosition = { x: startX, y: startY };
      openTextModal();
    } else if (state.currentEditTool === 'signature' && state.signatureImage) {
      saveUndoState();
      // Calculate signature size based on page scale (adaptive sizing)
      const pageScale = state.editPageScales[state.currentEditPage];
      const sigWidth = Math.min(200, pageScale.canvasWidth * 0.3);
      const sigHeight = sigWidth / 2; // Maintain 2:1 aspect ratio

      const annotation = {
        type: 'signature',
        image: state.signatureImage,
        x: startX,
        y: startY,
        width: sigWidth,
        height: sigHeight
      };

      // Pre-cache the image for immediate visual rendering
      const img = new Image();
      img.onload = () => {
        annotation.cachedImg = img;
        renderEditPage();
        updateEditorStatus('Tanda tangan ditambahkan');
      };
      img.onerror = () => {
        // Still render even if image fails to load
        renderEditPage();
        updateEditorStatus('Tanda tangan ditambahkan');
      };
      img.src = state.signatureImage;

      state.editAnnotations[state.currentEditPage].push(annotation);
    }
  }
}

function findAnnotationAt(x, y) {
  const annotations = state.editAnnotations[state.currentEditPage] || [];
  // Check in reverse order (topmost first)
  for (let i = annotations.length - 1; i >= 0; i--) {
    const anno = annotations[i];
    let bounds;

    if (anno.type === 'whiteout' || anno.type === 'signature') {
      bounds = { x: anno.x, y: anno.y, width: anno.width, height: anno.height };
    } else if (anno.type === 'text') {
      // Approximate text bounds
      const canvas = document.getElementById('edit-canvas');
      const ctx = canvas.getContext('2d');
      ctx.font = `${anno.fontSize}px Arial`;
      const metrics = ctx.measureText(anno.text);
      const lines = anno.text.split('\n');
      bounds = {
        x: anno.x,
        y: anno.y - anno.fontSize,
        width: metrics.width,
        height: anno.fontSize * lines.length * 1.2
      };
    }

    if (bounds &&
        x >= bounds.x && x <= bounds.x + bounds.width &&
        y >= bounds.y && y <= bounds.y + bounds.height) {
      return { pageNum: state.currentEditPage, index: i };
    }
  }
  return null;
}

function setEditTool(tool) {
  state.currentEditTool = tool;
  state.selectedAnnotation = null;

  document.querySelectorAll('.editor-tool-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.editTool === tool);
  });

  // Update canvas cursor
  const canvas = document.getElementById('edit-canvas');
  canvas.className = 'editor-canvas';
  if (tool) {
    canvas.classList.add(`tool-${tool}`);
  }

  // Update status message
  const messages = {
    'select': 'Klik anotasi untuk memilih, seret untuk memindahkan',
    'whiteout': 'Seret untuk menggambar area whiteout',
    'text': 'Klik di mana Anda ingin menambahkan teks',
    'signature': state.signatureImage ? 'Klik untuk menempatkan tanda tangan' : 'Buat tanda tangan terlebih dahulu'
  };
  updateEditorStatus(messages[tool] || 'Pilih alat untuk mulai mengedit');

  renderEditPage();
}

function updateEditorStatus(message) {
  const statusEl = document.querySelector('#editor-status .status-text');
  if (statusEl) {
    statusEl.textContent = message;
  }
}

function editPrevPage() {
  if (state.currentEditPage > 0) {
    state.selectedAnnotation = null;
    state.currentEditPage--;
    renderEditPage();
  }
}

function editNextPage() {
  if (state.currentEditPage < state.currentPDF.numPages - 1) {
    state.selectedAnnotation = null;
    state.currentEditPage++;
    renderEditPage();
  }
}

// Undo/Redo System
function saveUndoState() {
  // Deep clone the current annotations
  const currentState = JSON.parse(JSON.stringify(state.editAnnotations));
  state.editUndoStack.push(currentState);
  state.editRedoStack = []; // Clear redo stack when new action is performed

  // Limit undo stack to 50 states
  if (state.editUndoStack.length > 50) {
    state.editUndoStack.shift();
  }
}

function undoEdit() {
  if (state.editUndoStack.length === 0) {
    showToast('Tidak ada yang bisa di-undo', 'info');
    return;
  }

  // Save current state to redo stack
  const currentState = JSON.parse(JSON.stringify(state.editAnnotations));
  state.editRedoStack.push(currentState);

  // Restore previous state
  const previousState = state.editUndoStack.pop();

  // Preserve cached images
  for (const pageNum in previousState) {
    for (const anno of previousState[pageNum]) {
      if (anno.type === 'signature' && anno.image) {
        // Find matching annotation in current state to copy cached image
        const currentAnno = state.editAnnotations[pageNum]?.find(
          a => a.type === 'signature' && a.image === anno.image
        );
        if (currentAnno?.cachedImg) {
          anno.cachedImg = currentAnno.cachedImg;
        }
      }
    }
  }

  state.editAnnotations = previousState;
  state.selectedAnnotation = null;
  renderEditPage();
  showToast('Undo berhasil', 'success');
}

function redoEdit() {
  if (state.editRedoStack.length === 0) {
    showToast('Tidak ada yang bisa di-redo', 'info');
    return;
  }

  // Save current state to undo stack
  const currentState = JSON.parse(JSON.stringify(state.editAnnotations));
  state.editUndoStack.push(currentState);

  // Restore next state
  const nextState = state.editRedoStack.pop();

  // Preserve cached images
  for (const pageNum in nextState) {
    for (const anno of nextState[pageNum]) {
      if (anno.type === 'signature' && anno.image) {
        const currentAnno = state.editAnnotations[pageNum]?.find(
          a => a.type === 'signature' && a.image === anno.image
        );
        if (currentAnno?.cachedImg) {
          anno.cachedImg = currentAnno.cachedImg;
        }
      }
    }
  }

  state.editAnnotations = nextState;
  state.selectedAnnotation = null;
  renderEditPage();
  showToast('Redo berhasil', 'success');
}

function clearCurrentPageAnnotations() {
  if (state.editAnnotations[state.currentEditPage]?.length === 0) {
    showToast('Tidak ada anotasi di halaman ini', 'info');
    return;
  }

  if (confirm('Hapus semua anotasi di halaman ini?')) {
    saveUndoState();
    state.editAnnotations[state.currentEditPage] = [];
    state.selectedAnnotation = null;
    renderEditPage();
    showToast('Semua anotasi di halaman ini dihapus', 'success');
  }
}

function deleteSelectedAnnotation() {
  if (!state.selectedAnnotation) {
    showToast('Pilih anotasi terlebih dahulu', 'info');
    return;
  }

  saveUndoState();
  const { pageNum, index } = state.selectedAnnotation;
  state.editAnnotations[pageNum].splice(index, 1);
  state.selectedAnnotation = null;
  renderEditPage();
  showToast('Anotasi dihapus', 'success');
}

// Keyboard shortcuts
function setupEditKeyboardShortcuts() {
  const handler = (e) => {
    // Only handle when edit workspace is visible
    const editWorkspace = document.getElementById('edit-pdf-workspace');
    if (!editWorkspace || editWorkspace.style.display === 'none') return;

    // Don't handle if typing in input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    // Ctrl/Cmd + Z for undo
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      undoEdit();
    }
    // Ctrl/Cmd + Y or Ctrl/Cmd + Shift + Z for redo
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
      e.preventDefault();
      redoEdit();
    }
    // Delete or Backspace to delete selected annotation
    else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedAnnotation) {
      e.preventDefault();
      deleteSelectedAnnotation();
    }
    // Tool shortcuts
    else if (!e.ctrlKey && !e.metaKey) {
      switch (e.key.toLowerCase()) {
        case 'v': setEditTool('select'); break;
        case 'w': setEditTool('whiteout'); break;
        case 't': setEditTool('text'); break;
        case 's': openSignatureModal(); break;
        case 'escape':
          state.selectedAnnotation = null;
          state.currentEditTool = null;
          document.querySelectorAll('.editor-tool-btn').forEach(btn => btn.classList.remove('active'));
          renderEditPage();
          break;
      }
    }
  };

  document.addEventListener('keydown', handler);
  // Store reference to remove later if needed
  state.editKeyboardHandler = handler;
}

// Text Input Modal
function openTextModal() {
  const modal = document.getElementById('text-input-modal');
  modal.classList.add('active');

  const textInput = document.getElementById('text-input-field');
  textInput.value = '';
  textInput.focus();

  // Setup live preview
  updateTextPreview();

  textInput.addEventListener('input', updateTextPreview);
  document.getElementById('modal-font-size').addEventListener('change', updateTextPreview);
  document.getElementById('modal-text-color').addEventListener('input', updateTextPreview);
}

function closeTextModal() {
  const modal = document.getElementById('text-input-modal');
  modal.classList.remove('active');
  state.pendingTextPosition = null;
}

function updateTextPreview() {
  const text = document.getElementById('text-input-field').value || 'Preview teks';
  const fontSize = document.getElementById('modal-font-size').value;
  const color = document.getElementById('modal-text-color').value;

  const preview = document.getElementById('text-preview');
  preview.textContent = text;
  preview.style.fontSize = fontSize + 'px';
  preview.style.color = color;
}

function confirmTextInput() {
  // Check if we're in unified editor mode
  if (state.currentTool === 'unified-editor' && ueState.pendingTextPosition) {
    ueConfirmText();
    return;
  }

  const text = document.getElementById('text-input-field').value.trim();

  if (!text) {
    showToast('Masukkan teks terlebih dahulu', 'error');
    return;
  }

  if (!state.pendingTextPosition) {
    showToast('Posisi teks tidak valid', 'error');
    closeTextModal();
    return;
  }

  const fontSize = parseInt(document.getElementById('modal-font-size').value);
  const color = document.getElementById('modal-text-color').value;

  saveUndoState();
  state.editAnnotations[state.currentEditPage].push({
    type: 'text',
    text,
    x: state.pendingTextPosition.x,
    y: state.pendingTextPosition.y,
    fontSize,
    color
  });

  closeTextModal();
  renderEditPage();
  updateEditorStatus('Teks ditambahkan');
}

// Signature Modal
function openSignatureModal() {
  document.getElementById('signature-modal').classList.add('active');
  setEditTool('signature');

  // Reset to draw tab
  switchSignatureTab('draw');

  setTimeout(() => {
    const canvas = document.getElementById('signature-canvas');
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    canvas.width = canvas.offsetWidth * ratio;
    canvas.height = canvas.offsetHeight * ratio;
    canvas.getContext('2d').scale(ratio, ratio);
    if (state.signaturePad) state.signaturePad.clear();
  }, 100);
}

function closeSignatureModal() {
  document.getElementById('signature-modal').classList.remove('active');
}

function clearSignature() {
  if (state.signaturePad) {
    state.signaturePad.clear();
  }
}

function useSignature() {
  if (state.signaturePad && !state.signaturePad.isEmpty()) {
    state.signatureImage = state.signaturePad.toDataURL();
    closeSignatureModal();
    // Check if in unified editor mode
    if (state.currentTool === 'unified-editor') {
      ueSetTool('signature');
    } else {
      setEditTool('signature');
    }
    showToast('Klik pada PDF untuk menempatkan tanda tangan', 'success');
  } else {
    showToast('Buat tanda tangan terlebih dahulu', 'error');
  }
}

// Signature Tab Switching
function switchSignatureTab(tab) {
  // Update tab buttons
  document.querySelectorAll('.signature-tab').forEach(btn => {
    btn.classList.toggle('active', btn.textContent.toLowerCase().includes(tab === 'draw' ? 'gambar' : 'upload'));
  });

  // Update tab content
  document.getElementById('signature-draw-tab').classList.toggle('active', tab === 'draw');
  document.getElementById('signature-upload-tab').classList.toggle('active', tab === 'upload');

  // Re-init signature pad if switching to draw tab
  if (tab === 'draw') {
    setTimeout(() => {
      const canvas = document.getElementById('signature-canvas');
      if (canvas && state.signaturePad) {
        const ratio = Math.max(window.devicePixelRatio || 1, 1);
        canvas.width = canvas.offsetWidth * ratio;
        canvas.height = canvas.offsetHeight * ratio;
        canvas.getContext('2d').scale(ratio, ratio);
        state.signaturePad.clear();
      }
    }, 100);
  }
}

// Load Signature Image for Background Removal
async function loadSignatureImage(file) {
  try {
    const img = await loadImage(file);
    state.signatureUploadImage = img;

    // Close signature modal and open bg removal modal
    closeSignatureModal();
    openSignatureBgModal();
  } catch (error) {
    console.error('Error loading signature image:', error);
    showToast('Gagal memuat gambar', 'error');
  }
}

// Signature Background Removal Modal
function openSignatureBgModal() {
  document.getElementById('signature-bg-modal').classList.add('active');

  // Show original image
  document.getElementById('sig-bg-original').src = state.signatureUploadImage.src;

  // Initialize preview
  updateSignatureBgPreview();
}

function closeSignatureBgModal() {
  document.getElementById('signature-bg-modal').classList.remove('active');

  // Cleanup
  if (state.signatureUploadImage && state.signatureUploadImage._blobUrl) {
    URL.revokeObjectURL(state.signatureUploadImage._blobUrl);
  }
  state.signatureUploadImage = null;
  state.signatureUploadCanvas = null;
}

function updateSignatureBgPreview() {
  if (!state.signatureUploadImage) return;

  const threshold = parseInt(document.getElementById('sig-bg-threshold').value);

  // Update slider display
  document.getElementById('sig-bg-threshold-value').textContent = threshold;

  const canvas = document.getElementById('sig-bg-preview');
  const ctx = canvas.getContext('2d');

  // Set canvas size to match original image
  canvas.width = state.signatureUploadImage.naturalWidth;
  canvas.height = state.signatureUploadImage.naturalHeight;

  // Draw original image
  ctx.drawImage(state.signatureUploadImage, 0, 0);

  // Get image data
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  // Process each pixel - make white/near-white pixels transparent
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    // Check if pixel is white/near-white based on threshold
    if (r >= threshold && g >= threshold && b >= threshold) {
      data[i + 3] = 0; // Set alpha to 0 (transparent)
    }
  }

  // Put the modified image data back
  ctx.putImageData(imageData, 0, 0);

  // Store reference for use
  state.signatureUploadCanvas = canvas;
}

function useSignatureFromUpload() {
  if (!state.signatureUploadCanvas) {
    showToast('Tidak ada gambar untuk digunakan', 'error');
    return;
  }

  // Convert canvas to data URL and use as signature
  state.signatureImage = state.signatureUploadCanvas.toDataURL('image/png');

  closeSignatureBgModal();
  // Check if in unified editor mode
  if (state.currentTool === 'unified-editor') {
    ueSetTool('signature');
    ueUpdateStatus('Klik untuk menempatkan tanda tangan');
  } else {
    setEditTool('signature');
    updateEditorStatus('Klik untuk menempatkan tanda tangan');
  }
  showToast('Klik pada PDF untuk menempatkan tanda tangan', 'success');
}

// Editor Watermark Functions
function openEditorWatermarkModal() {
  document.getElementById('editor-watermark-modal').classList.add('active');
}

function closeEditorWatermarkModal() {
  document.getElementById('editor-watermark-modal').classList.remove('active');
}

function applyEditorWatermark() {
  const text = document.getElementById('editor-wm-text').value || 'WATERMARK';
  const fontSize = parseInt(document.getElementById('editor-wm-size').value);
  const color = document.getElementById('editor-wm-color').value;
  const opacity = parseInt(document.getElementById('editor-wm-opacity').value) / 100;
  const rotation = parseInt(document.getElementById('editor-wm-rotation').value);
  const applyTo = document.getElementById('editor-wm-pages').value;

  // Check if in unified editor mode
  if (state.currentTool === 'unified-editor') {
    ueSaveEditUndoState();
    const pageScale = ueState.pageScales[ueState.selectedPage] || { canvasWidth: 600, canvasHeight: 800 };
    const centerX = pageScale.canvasWidth / 2;
    const centerY = pageScale.canvasHeight / 2;

    const watermarkAnno = {
      type: 'watermark',
      text,
      fontSize,
      color,
      opacity,
      rotation,
      x: centerX,
      y: centerY
    };

    if (applyTo === 'all') {
      for (let i = 0; i < ueState.pages.length; i++) {
        if (!ueState.annotations[i]) ueState.annotations[i] = [];
        ueState.annotations[i].push({ ...watermarkAnno });
      }
      showToast('Watermark diterapkan ke semua halaman', 'success');
    } else {
      ueState.annotations[ueState.selectedPage].push(watermarkAnno);
      showToast('Watermark diterapkan', 'success');
    }

    closeEditorWatermarkModal();
    ueRedrawAnnotations();
    return;
  }

  saveUndoState();

  const canvas = document.getElementById('edit-canvas');
  const pageScale = state.editPageScales[state.currentEditPage];
  const centerX = pageScale.canvasWidth / 2;
  const centerY = pageScale.canvasHeight / 2;

  const watermarkAnno = {
    type: 'watermark',
    text,
    fontSize,
    color,
    opacity,
    rotation,
    x: centerX,
    y: centerY
  };

  if (applyTo === 'all') {
    // Apply to all pages
    for (let i = 0; i < state.currentPDF.numPages; i++) {
      state.editAnnotations[i].push({ ...watermarkAnno });
    }
    showToast('Watermark diterapkan ke semua halaman', 'success');
  } else {
    // Apply to current page only
    state.editAnnotations[state.currentEditPage].push(watermarkAnno);
    showToast('Watermark diterapkan', 'success');
  }

  closeEditorWatermarkModal();
  renderEditPage();
}

// Editor Page Number Functions
function openEditorPageNumModal() {
  document.getElementById('editor-pagenum-modal').classList.add('active');
}

function closeEditorPageNumModal() {
  document.getElementById('editor-pagenum-modal').classList.remove('active');
}

function applyEditorPageNumbers() {
  const position = document.getElementById('editor-pn-position').value;
  const format = document.getElementById('editor-pn-format').value;
  const fontSize = parseInt(document.getElementById('editor-pn-size').value);
  const startNum = parseInt(document.getElementById('editor-pn-start').value) || 1;

  // Check if in unified editor mode
  if (state.currentTool === 'unified-editor') {
    const totalPages = ueState.pages.length;
    ueSaveEditUndoState();

    for (let i = 0; i < totalPages; i++) {
      const pageNum = startNum + i;
      let text;

      switch (format) {
        case 'page-of':
          text = `Halaman ${pageNum} dari ${totalPages + startNum - 1}`;
          break;
        case 'dash':
          text = `- ${pageNum} -`;
          break;
        default:
          text = `${pageNum}`;
      }

      const pageScale = ueState.pageScales[i] || ueState.pageScales[ueState.selectedPage] || { canvasWidth: 600, canvasHeight: 800 };
      const canvasWidth = pageScale.canvasWidth;
      const canvasHeight = pageScale.canvasHeight;
      const margin = 30;

      let x, y;
      switch (position) {
        case 'bottom-left':
          x = margin; y = canvasHeight - margin; break;
        case 'bottom-right':
          x = canvasWidth - margin; y = canvasHeight - margin; break;
        case 'top-center':
          x = canvasWidth / 2; y = margin + fontSize; break;
        case 'top-left':
          x = margin; y = margin + fontSize; break;
        case 'top-right':
          x = canvasWidth - margin; y = margin + fontSize; break;
        default:
          x = canvasWidth / 2; y = canvasHeight - margin;
      }

      if (!ueState.annotations[i]) ueState.annotations[i] = [];
      ueState.annotations[i].push({
        type: 'pageNumber',
        text,
        fontSize,
        color: '#000000',
        x,
        y,
        position
      });
    }

    closeEditorPageNumModal();
    ueRedrawAnnotations();
    showToast('Nomor halaman ditambahkan ke semua halaman', 'success');
    return;
  }

  const totalPages = state.currentPDF.numPages;
  saveUndoState();

  for (let i = 0; i < totalPages; i++) {
    const pageNum = startNum + i;
    let text;

    switch (format) {
      case 'page-of':
        text = `Halaman ${pageNum} dari ${totalPages + startNum - 1}`;
        break;
      case 'dash':
        text = `- ${pageNum} -`;
        break;
      default:
        text = `${pageNum}`;
    }

    // Calculate position based on page scale
    const pageScale = state.editPageScales[i] || state.editPageScales[state.currentEditPage];
    const canvasWidth = pageScale?.canvasWidth || 600;
    const canvasHeight = pageScale?.canvasHeight || 800;
    const margin = 30;

    let x, y;
    switch (position) {
      case 'bottom-left':
        x = margin;
        y = canvasHeight - margin;
        break;
      case 'bottom-right':
        x = canvasWidth - margin;
        y = canvasHeight - margin;
        break;
      case 'top-center':
        x = canvasWidth / 2;
        y = margin + fontSize;
        break;
      case 'top-left':
        x = margin;
        y = margin + fontSize;
        break;
      case 'top-right':
        x = canvasWidth - margin;
        y = margin + fontSize;
        break;
      default: // bottom-center
        x = canvasWidth / 2;
        y = canvasHeight - margin;
    }

    state.editAnnotations[i].push({
      type: 'pageNumber',
      text,
      fontSize,
      color: '#000000',
      x,
      y,
      position
    });
  }

  closeEditorPageNumModal();
  renderEditPage();
  showToast('Nomor halaman ditambahkan ke semua halaman', 'success');
}

async function saveEditedPDF() {
  try {
    const srcDoc = await PDFLib.PDFDocument.load(state.currentPDFBytes);
    const pages = srcDoc.getPages();

    // Embed font once for all text annotations
    const font = await srcDoc.embedFont(PDFLib.StandardFonts.Helvetica);

    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const annotations = state.editAnnotations[i] || [];
      const { width: pdfWidth, height: pdfHeight } = page.getSize();

      // Get the scale info for this page
      const pageScaleInfo = state.editPageScales[i];
      if (!pageScaleInfo && annotations.length > 0) {
        // If we don't have scale info (page wasn't viewed), we need to calculate it
        const pdfPage = await state.currentPDF.getPage(i + 1);
        const naturalViewport = pdfPage.getViewport({ scale: 1 });
        const wrapper = document.querySelector('.editor-canvas-wrapper');
        const maxWidth = wrapper ? wrapper.clientWidth - 40 : 800;
        let scale = Math.min(maxWidth / naturalViewport.width, 2);
        scale = Math.max(scale, 1);

        state.editPageScales[i] = {
          scale: scale,
          pdfWidth: naturalViewport.width,
          pdfHeight: naturalViewport.height,
          canvasWidth: naturalViewport.width * scale,
          canvasHeight: naturalViewport.height * scale
        };
      }

      const scaleInfo = state.editPageScales[i];
      if (!scaleInfo) continue;

      // Correct scale factors: canvas coordinates to PDF coordinates
      const scaleX = pdfWidth / scaleInfo.canvasWidth;
      const scaleY = pdfHeight / scaleInfo.canvasHeight;

      for (const anno of annotations) {
        if (anno.type === 'whiteout') {
          // Convert canvas coordinates to PDF coordinates
          const pdfX = anno.x * scaleX;
          const pdfY = pdfHeight - (anno.y + anno.height) * scaleY; // Y is flipped in PDF
          const pdfW = anno.width * scaleX;
          const pdfH = anno.height * scaleY;

          page.drawRectangle({
            x: pdfX,
            y: pdfY,
            width: pdfW,
            height: pdfH,
            color: PDFLib.rgb(1, 1, 1),
          });
        } else if (anno.type === 'text') {
          const hexColor = anno.color || '#000000';
          const r = parseInt(hexColor.slice(1, 3), 16) / 255;
          const g = parseInt(hexColor.slice(3, 5), 16) / 255;
          const b = parseInt(hexColor.slice(5, 7), 16) / 255;

          // Text position conversion
          const pdfX = anno.x * scaleX;
          const pdfY = pdfHeight - anno.y * scaleY;
          const pdfFontSize = anno.fontSize * scaleX;

          // Handle multi-line text
          const lines = anno.text.split('\n');
          lines.forEach((line, idx) => {
            page.drawText(line, {
              x: pdfX,
              y: pdfY - (idx * pdfFontSize * 1.2),
              size: pdfFontSize,
              font,
              color: PDFLib.rgb(r, g, b),
            });
          });
        } else if (anno.type === 'signature' && anno.image) {
          try {
            const pngImage = await srcDoc.embedPng(anno.image);
            const pdfX = anno.x * scaleX;
            const pdfY = pdfHeight - (anno.y + anno.height) * scaleY;
            const pdfW = anno.width * scaleX;
            const pdfH = anno.height * scaleY;

            page.drawImage(pngImage, {
              x: pdfX,
              y: pdfY,
              width: pdfW,
              height: pdfH,
            });
          } catch (imgError) {
            console.error('Error embedding signature:', imgError);
          }
        } else if (anno.type === 'watermark') {
          const hexColor = anno.color || '#888888';
          const r = parseInt(hexColor.slice(1, 3), 16) / 255;
          const g = parseInt(hexColor.slice(3, 5), 16) / 255;
          const b = parseInt(hexColor.slice(5, 7), 16) / 255;

          const pdfX = anno.x * scaleX;
          const pdfY = pdfHeight - anno.y * scaleY;
          const pdfFontSize = anno.fontSize * scaleX;

          // Estimate text width for centering
          const textWidth = anno.text.length * pdfFontSize * 0.5;

          page.drawText(anno.text, {
            x: pdfX - textWidth / 2,
            y: pdfY,
            size: pdfFontSize,
            font,
            color: PDFLib.rgb(r, g, b),
            opacity: anno.opacity,
            rotate: PDFLib.degrees(anno.rotation),
          });
        } else if (anno.type === 'pageNumber') {
          const pdfX = anno.x * scaleX;
          const pdfY = pdfHeight - anno.y * scaleY;
          const pdfFontSize = anno.fontSize * scaleX;

          // Adjust X position based on text alignment
          let adjustedX = pdfX;
          if (anno.position.includes('center')) {
            const textWidth = font.widthOfTextAtSize(anno.text, pdfFontSize);
            adjustedX = pdfX - textWidth / 2;
          } else if (anno.position.includes('right')) {
            const textWidth = font.widthOfTextAtSize(anno.text, pdfFontSize);
            adjustedX = pdfX - textWidth;
          }

          page.drawText(anno.text, {
            x: adjustedX,
            y: pdfY,
            size: pdfFontSize,
            font,
            color: PDFLib.rgb(0, 0, 0),
          });
        }
      }
    }

    const bytes = await srcDoc.save();
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), getOutputFilename('edited'));
    showToast('PDF berhasil disimpan!', 'success');

  } catch (error) {
    console.error('Error saving edited PDF:', error);
    showToast('Gagal menyimpan PDF: ' + error.message, 'error');
  }
}

// ============================================================
// COMPRESS IMAGE
// ============================================================

async function updateCompressPreview() {
  if (!state.originalImage) return;

  const quality = parseInt(document.getElementById('compress-quality').value) / 100;
  const format = document.getElementById('compress-format').value;

  // Update slider display
  document.querySelector('#compress-img-workspace .range-value').textContent =
    document.getElementById('compress-quality').value + '%';

  const canvas = document.createElement('canvas');
  canvas.width = state.originalImage.naturalWidth;
  canvas.height = state.originalImage.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(state.originalImage, 0, 0);

  const mimeType = `image/${format}`;

  canvas.toBlob((blob) => {
    if (blob) {
      // Revoke previous blob URL to prevent memory leak
      if (state.compressPreviewUrl) {
        URL.revokeObjectURL(state.compressPreviewUrl);
      }

      const url = URL.createObjectURL(blob);
      state.compressPreviewUrl = url;
      document.getElementById('compress-preview').src = url;
      document.getElementById('compress-preview-size').textContent = `Hasil: ${formatFileSize(blob.size)}`;
      state.compressedBlob = blob;

      // Calculate savings
      const savings = ((state.originalImageSize - blob.size) / state.originalImageSize * 100).toFixed(1);
      if (blob.size < state.originalImageSize) {
        document.getElementById('compress-preview-size').textContent += ` (hemat ${savings}%)`;
      }
    }
  }, mimeType, quality);
}

function downloadCompressedImage() {
  if (!state.compressedBlob) {
    showToast('Tidak ada gambar untuk didownload', 'error');
    return;
  }

  const format = document.getElementById('compress-format').value;
  const baseName = state.originalImageName.replace(/\.[^/.]+$/, '');
  downloadBlob(state.compressedBlob, `${baseName}_compressed.${format === 'jpeg' ? 'jpg' : format}`);
  showToast('Gambar berhasil dikompres!', 'success');
}

// ============================================================
// REMOVE BACKGROUND
// ============================================================

function updateRemoveBgPreview() {
  if (!state.originalImage) return;

  const threshold = parseInt(document.getElementById('remove-bg-threshold').value);

  // Update slider display
  document.getElementById('remove-bg-threshold-value').textContent = threshold;

  const canvas = document.getElementById('remove-bg-preview');
  const ctx = canvas.getContext('2d');

  // Set canvas size to match original image
  canvas.width = state.originalImage.naturalWidth;
  canvas.height = state.originalImage.naturalHeight;

  // Draw original image
  ctx.drawImage(state.originalImage, 0, 0);

  // Get image data
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  // Process each pixel - make white/near-white pixels transparent
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    // Check if pixel is white/near-white based on threshold
    // All RGB values must be >= threshold to be considered "white"
    if (r >= threshold && g >= threshold && b >= threshold) {
      data[i + 3] = 0; // Set alpha to 0 (transparent)
    }
  }

  // Put the modified image data back
  ctx.putImageData(imageData, 0, 0);

  // Store the canvas for download
  state.removeBgCanvas = canvas;
}

function downloadRemovedBgImage() {
  if (!state.removeBgCanvas) {
    showToast('Tidak ada gambar untuk didownload', 'error');
    return;
  }

  state.removeBgCanvas.toBlob((blob) => {
    if (blob) {
      const baseName = state.originalImageName.replace(/\.[^/.]+$/, '');
      downloadBlob(blob, `${baseName}_nobg.png`);
      showToast('Latar belakang berhasil dihapus!', 'success');
    }
  }, 'image/png');
}

// ============================================================
// RESIZE IMAGE
// ============================================================

function onResizeChange(changedField) {
  const lock = document.getElementById('resize-lock').checked;
  if (!lock || !state.originalWidth || !state.originalHeight) return;
  
  const aspectRatio = state.originalWidth / state.originalHeight;
  
  if (changedField === 'width') {
    const newWidth = parseInt(document.getElementById('resize-width').value) || 0;
    document.getElementById('resize-height').value = Math.round(newWidth / aspectRatio);
  } else {
    const newHeight = parseInt(document.getElementById('resize-height').value) || 0;
    document.getElementById('resize-width').value = Math.round(newHeight * aspectRatio);
  }
  
  updateResizeDimensions();
}

function applyResizePercent() {
  const percent = parseInt(document.getElementById('resize-percent').value);
  if (!percent || !state.originalWidth || !state.originalHeight) return;
  
  document.getElementById('resize-width').value = Math.round(state.originalWidth * percent / 100);
  document.getElementById('resize-height').value = Math.round(state.originalHeight * percent / 100);
  document.getElementById('resize-percent').value = '';
  
  updateResizeDimensions();
}

function updateResizeDimensions() {
  const width = document.getElementById('resize-width').value;
  const height = document.getElementById('resize-height').value;
  document.getElementById('resize-dimensions').textContent = `Dimensi: ${width} × ${height}`;
}

function downloadResizedImage() {
  const newWidth = parseInt(document.getElementById('resize-width').value);
  const newHeight = parseInt(document.getElementById('resize-height').value);
  
  if (!newWidth || !newHeight || !state.originalImage) {
    showToast('Masukkan dimensi yang valid', 'error');
    return;
  }
  
  const canvas = document.createElement('canvas');
  canvas.width = newWidth;
  canvas.height = newHeight;
  const ctx = canvas.getContext('2d');
  
  // Use better quality interpolation
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  
  ctx.drawImage(state.originalImage, 0, 0, newWidth, newHeight);
  
  // Determine format from original
  const ext = state.originalImageName.split('.').pop().toLowerCase();
  let mimeType = 'image/png';
  let extension = 'png';
  
  if (['jpg', 'jpeg'].includes(ext)) {
    mimeType = 'image/jpeg';
    extension = 'jpg';
  } else if (ext === 'webp') {
    mimeType = 'image/webp';
    extension = 'webp';
  }
  
  canvas.toBlob((blob) => {
    const baseName = state.originalImageName.replace(/\.[^/.]+$/, '');
    downloadBlob(blob, `${baseName}_${newWidth}x${newHeight}.${extension}`);
    showToast('Gambar berhasil diubah ukurannya!', 'success');
  }, mimeType, 0.92);
}

// ============================================================
// CONVERT IMAGE FORMAT
// ============================================================

function convertImage() {
  if (!state.originalImage) {
    showToast('Tidak ada gambar untuk dikonversi', 'error');
    return;
  }
  
  const format = document.getElementById('convert-format').value;
  const quality = parseInt(document.getElementById('convert-quality').value) / 100;
  
  const canvas = document.createElement('canvas');
  canvas.width = state.originalImage.naturalWidth;
  canvas.height = state.originalImage.naturalHeight;
  const ctx = canvas.getContext('2d');
  
  // For PNG with transparency, fill white background for JPEG
  if (format === 'jpeg') {
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  
  ctx.drawImage(state.originalImage, 0, 0);
  
  const mimeType = `image/${format}`;
  const extension = format === 'jpeg' ? 'jpg' : format;
  
  canvas.toBlob((blob) => {
    const baseName = state.originalImageName.replace(/\.[^/.]+$/, '');
    downloadBlob(blob, `${baseName}.${extension}`);
    showToast('Gambar berhasil dikonversi!', 'success');
  }, mimeType, quality);
}

// ============================================================
// IMAGES TO PDF
// ============================================================

async function addImagesToPDF(files) {
  const fileList = document.getElementById('img-pdf-file-list');

  // Clear placeholder and remove empty class
  if (state.imgToPdfFiles.length === 0) {
    fileList.innerHTML = '';
    fileList.classList.remove('empty');
  }
  
  for (const file of files) {
    if (!file.type.startsWith('image/')) {
      showToast(`${file.name} bukan file gambar`, 'error');
      continue;
    }
    
    try {
      const img = await loadImage(file);
      
      // Create thumbnail
      const canvas = document.createElement('canvas');
      const maxSize = 120;
      const ratio = Math.min(maxSize / img.naturalWidth, maxSize / img.naturalHeight);
      canvas.width = img.naturalWidth * ratio;
      canvas.height = img.naturalHeight * ratio;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      
      const fileItem = createImageFileItem(file.name, formatFileSize(file.size), canvas.toDataURL(), state.imgToPdfFiles.length);
      fileList.appendChild(fileItem);
      
      state.imgToPdfFiles.push({
        name: file.name,
        file: file,
        img: img
      });
      
    } catch (error) {
      console.error('Error processing image:', error);
      showToast(`Gagal memproses ${file.name}`, 'error');
    }
  }
  
  updateImgPdfAddButton();
  document.getElementById('img-pdf-btn').disabled = state.imgToPdfFiles.length === 0;
  enableDragReorder('img-pdf-file-list', state.imgToPdfFiles);
}

function createImageFileItem(name, size, thumbnail, index) {
  const div = document.createElement('div');
  div.className = 'file-item';
  div.dataset.index = index;
  div.draggable = true;

  // Escape HTML to prevent XSS
  const safeName = escapeHtml(name);
  const safeSize = escapeHtml(size);

  div.innerHTML = `
    <div class="file-item-preview">
      <img src="${thumbnail}" alt="preview">
    </div>
    <div class="file-item-info">
      <div class="file-item-name" title="${safeName}">${safeName}</div>
      <div class="file-item-size">${safeSize}</div>
    </div>
    <button class="file-item-remove">×</button>
  `;

  // Add click handler safely (avoid inline onclick with index)
  div.querySelector('.file-item-remove').addEventListener('click', () => removeImgPdfFile(index));

  return div;
}

function updateImgPdfAddButton() {
  const fileList = document.getElementById('img-pdf-file-list');
  const existing = fileList.querySelector('.add-file-btn');
  if (existing) existing.remove();
  
  const addBtn = document.createElement('button');
  addBtn.className = 'add-file-btn';
  addBtn.innerHTML = `
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M12 5v14M5 12h14"/>
    </svg>
    <span>Tambah Gambar</span>
  `;
  addBtn.onclick = () => document.getElementById('img-pdf-input').click();
  fileList.appendChild(addBtn);
}

function removeImgPdfFile(index) {
  state.imgToPdfFiles.splice(index, 1);
  refreshImgPdfList();
}

function refreshImgPdfList() {
  const fileList = document.getElementById('img-pdf-file-list');
  fileList.innerHTML = '';

  if (state.imgToPdfFiles.length === 0) {
    fileList.innerHTML = '<p style="color: var(--text-tertiary); width: 100%; text-align: center;">Seret gambar ke sini atau gunakan tombol di bawah</p>';
    document.getElementById('img-pdf-btn').disabled = true;
    return;
  }

  // Use for loop to maintain order (synchronous since we're just drawing to canvas)
  for (let i = 0; i < state.imgToPdfFiles.length; i++) {
    const imgFile = state.imgToPdfFiles[i];
    const canvas = document.createElement('canvas');
    const maxSize = 120;
    const ratio = Math.min(maxSize / imgFile.img.naturalWidth, maxSize / imgFile.img.naturalHeight);
    canvas.width = imgFile.img.naturalWidth * ratio;
    canvas.height = imgFile.img.naturalHeight * ratio;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imgFile.img, 0, 0, canvas.width, canvas.height);

    const fileItem = createImageFileItem(imgFile.name, '', canvas.toDataURL(), i);
    const addBtn = fileList.querySelector('.add-file-btn');
    if (addBtn) {
      fileList.insertBefore(fileItem, addBtn);
    } else {
      fileList.appendChild(fileItem);
    }
  }

  updateImgPdfAddButton();
  document.getElementById('img-pdf-btn').disabled = state.imgToPdfFiles.length === 0;
  enableDragReorder('img-pdf-file-list', state.imgToPdfFiles);
}

async function imagesToPDF() {
  if (state.imgToPdfFiles.length === 0) return;
  
  const pageSize = document.getElementById('img-pdf-size').value;
  const orientation = document.getElementById('img-pdf-orientation').value;
  
  const progress = document.getElementById('img-pdf-progress');
  const progressFill = progress.querySelector('.progress-fill');
  const progressText = progress.querySelector('.progress-text');
  
  progress.classList.remove('hidden');
  document.getElementById('img-pdf-btn').disabled = true;
  
  try {
    const pdfDoc = await PDFLib.PDFDocument.create();
    
    // Page dimensions
    const pageSizes = {
      a4: { width: 595.28, height: 841.89 },
      letter: { width: 612, height: 792 }
    };
    
    for (let i = 0; i < state.imgToPdfFiles.length; i++) {
      progressText.textContent = `Memproses gambar ${i + 1} dari ${state.imgToPdfFiles.length}...`;
      progressFill.style.width = `${((i + 1) / state.imgToPdfFiles.length) * 100}%`;
      
      const imgFile = state.imgToPdfFiles[i];
      const img = imgFile.img;
      
      // Get image bytes
      const imgBytes = await fetch(img.src).then(res => res.arrayBuffer());
      
      let embeddedImg;
      const fileType = imgFile.file.type;
      
      if (fileType === 'image/png') {
        embeddedImg = await pdfDoc.embedPng(imgBytes);
      } else if (fileType === 'image/jpeg' || fileType === 'image/jpg') {
        embeddedImg = await pdfDoc.embedJpg(imgBytes);
      } else {
        // Convert to PNG for other formats
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const pngDataUrl = canvas.toDataURL('image/png');
        const pngBytes = await fetch(pngDataUrl).then(res => res.arrayBuffer());
        embeddedImg = await pdfDoc.embedPng(pngBytes);
      }
      
      let pageWidth, pageHeight;
      
      if (pageSize === 'fit') {
        // Page size matches image
        pageWidth = embeddedImg.width;
        pageHeight = embeddedImg.height;
      } else {
        const dimensions = pageSizes[pageSize];
        
        // Determine orientation
        let isLandscape = false;
        if (orientation === 'landscape') {
          isLandscape = true;
        } else if (orientation === 'auto') {
          isLandscape = embeddedImg.width > embeddedImg.height;
        }
        
        if (isLandscape) {
          pageWidth = dimensions.height;
          pageHeight = dimensions.width;
        } else {
          pageWidth = dimensions.width;
          pageHeight = dimensions.height;
        }
      }
      
      const page = pdfDoc.addPage([pageWidth, pageHeight]);
      
      // Calculate image position to fit and center
      let imgWidth = embeddedImg.width;
      let imgHeight = embeddedImg.height;
      
      if (pageSize !== 'fit') {
        const scale = Math.min(
          (pageWidth - 40) / imgWidth,
          (pageHeight - 40) / imgHeight
        );
        imgWidth *= scale;
        imgHeight *= scale;
      }
      
      const x = (pageWidth - imgWidth) / 2;
      const y = (pageHeight - imgHeight) / 2;
      
      page.drawImage(embeddedImg, {
        x,
        y,
        width: imgWidth,
        height: imgHeight,
      });
    }
    
    progressText.textContent = 'Menyimpan PDF...';
    const pdfBytes = await pdfDoc.save();
    
    const firstImgName = state.imgToPdfFiles[0]?.name?.replace(/\.[^/.]+$/, '') || 'images';
    downloadBlob(new Blob([pdfBytes], { type: 'application/pdf' }), `${firstImgName}_converted.pdf`);
    showToast('PDF berhasil dibuat!', 'success');
    
  } catch (error) {
    console.error('Error creating PDF from images:', error);
    showToast('Gagal membuat PDF', 'error');
  } finally {
    progress.classList.add('hidden');
    document.getElementById('img-pdf-btn').disabled = false;
  }
}

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Generate output filename: [original]_[suffix].ext
function getOutputFilename(suffix, ext = 'pdf', originalName = null) {
  const baseName = originalName || state.currentPDFName || state.originalImageName || 'output';
  // Remove extension from base name
  const nameWithoutExt = baseName.replace(/\.[^/.]+$/, '');
  return `${nameWithoutExt}_${suffix}.${ext}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    ${type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ'}
    <span>${message}</span>
  `;
  
  container.appendChild(toast);
  
  setTimeout(() => {
    toast.style.animation = 'slideIn 0.3s ease reverse';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

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
};

// Initialize unified editor file input
function initUnifiedEditorInput() {
  const input = document.getElementById('ue-file-input');
  if (input && !input._ueInitialized) {
    input._ueInitialized = true;
    input.addEventListener('change', (e) => {
      ueAddFiles(e.target.files);
      e.target.value = '';
    });
  }
}

// Add PDF files to unified editor
async function ueAddFiles(files) {
  if (!files || files.length === 0) return;

  for (const file of files) {
    if (file.type !== 'application/pdf') {
      showToast('Hanya file PDF yang didukung', 'error');
      continue;
    }

    try {
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
        const viewport = page.getViewport({ scale: 0.5 }); // Thumbnail scale - larger for better visibility

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
          canvas
        });

        // Initialize annotations for this page
        ueState.annotations[ueState.pages.length - 1] = [];
      }

      ueRenderThumbnails();
      ueUpdatePageCount();
      document.getElementById('ue-download-btn').disabled = false;

      // Auto-select first page if none selected
      if (ueState.selectedPage === -1 && ueState.pages.length > 0) {
        ueSelectPage(0);
      }

    } catch (error) {
      console.error('Error loading PDF:', error);
      showToast('Gagal memuat PDF: ' + file.name, 'error');
    }
  }
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
    item.onclick = () => ueSelectPage(index);

    // Clone the thumbnail canvas
    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = page.canvas.width;
    thumbCanvas.height = page.canvas.height;
    thumbCanvas.getContext('2d').drawImage(page.canvas, 0, 0);
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
}

// Select a page
function ueSelectPage(index) {
  if (index < 0 || index >= ueState.pages.length) return;

  ueState.selectedPage = index;
  ueRenderThumbnails();
  ueRenderSelectedPage();

  // Show canvas, hide empty state
  document.getElementById('ue-empty-state').style.display = 'none';
  document.getElementById('ue-canvas').style.display = 'block';

  ueUpdateStatus('Halaman ' + (index + 1) + ' dipilih. Gunakan alat di atas untuk mengedit.');
}

// Render selected page on main canvas
async function ueRenderSelectedPage() {
  if (ueState.selectedPage < 0) return;

  const pageInfo = ueState.pages[ueState.selectedPage];
  const sourceFile = ueState.sourceFiles[pageInfo.sourceIndex];

  try {
    const pdf = await pdfjsLib.getDocument({ data: sourceFile.bytes.slice() }).promise;
    const page = await pdf.getPage(pageInfo.pageNum + 1);

    const canvas = document.getElementById('ue-canvas');
    const ctx = canvas.getContext('2d');
    const dpr = ueState.devicePixelRatio = window.devicePixelRatio || 1;

    // Calculate scale to fit wrapper - maximize canvas size
    const wrapper = document.getElementById('ue-canvas-wrapper');
    const maxWidth = wrapper.clientWidth - 16;  // Minimal padding
    const maxHeight = wrapper.clientHeight - 16;
    const naturalViewport = page.getViewport({ scale: 1, rotation: pageInfo.rotation });

    // Ensure we have valid dimensions
    if (maxWidth <= 100 || maxHeight <= 100) {
      console.warn('Invalid wrapper dimensions, retrying...', { maxWidth, maxHeight });
      setTimeout(() => ueRenderSelectedPage(), 150);
      return;
    }

    let scale = Math.min(
      maxWidth / naturalViewport.width,
      maxHeight / naturalViewport.height,
      4  // Allow larger scaling for better use of space
    );
    scale = Math.max(scale, 0.5);

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
  }
}

// Setup canvas events for editing
function ueSetupCanvasEvents() {
  if (ueState.canvasSetup) return;
  ueState.canvasSetup = true;

  const canvas = document.getElementById('ue-canvas');
  let isDrawing = false;
  let isDragging = false;
  let startX, startY;
  let dragOffsetX, dragOffsetY;

  function getCoords(e) {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / canvas.clientWidth / ueState.devicePixelRatio);
    const y = (e.clientY - rect.top) * (canvas.height / canvas.clientHeight / ueState.devicePixelRatio);
    return { x, y };
  }

  canvas.addEventListener('mousedown', (e) => handleDown(getCoords(e)));
  canvas.addEventListener('mousemove', (e) => handleMove(getCoords(e)));
  canvas.addEventListener('mouseup', (e) => handleUp(getCoords(e)));
  canvas.addEventListener('mouseleave', () => { isDrawing = false; isDragging = false; });

  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    handleDown(getCoords(e.touches[0]));
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

    // Check for annotation selection
    if (ueState.currentTool === 'select') {
      const clicked = ueFindAnnotationAt(x, y);
      if (clicked) {
        ueSaveEditUndoState();
        ueState.selectedAnnotation = clicked;
        isDragging = true;
        const anno = ueState.annotations[clicked.pageIndex][clicked.index];
        dragOffsetX = x - anno.x;
        dragOffsetY = y - (anno.type === 'text' ? anno.y - anno.fontSize : anno.y);
        ueRedrawAnnotations();
        return;
      } else {
        ueState.selectedAnnotation = null;
        ueRedrawAnnotations();
      }
    }

    if (!ueState.currentTool || ueState.currentTool === 'select') return;
    isDrawing = true;
  }

  function handleMove({ x, y }) {
    // Handle dragging annotation
    if (isDragging && ueState.selectedAnnotation) {
      const anno = ueState.annotations[ueState.selectedAnnotation.pageIndex][ueState.selectedAnnotation.index];
      if (anno.type === 'text') {
        anno.x = x - dragOffsetX;
        anno.y = y - dragOffsetY + anno.fontSize;
      } else {
        anno.x = x - dragOffsetX;
        anno.y = y - dragOffsetY;
      }
      ueRedrawAnnotations();
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
    if (isDragging) {
      isDragging = false;
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
      ueSaveEditUndoState();
      const img = new Image();
      img.src = state.signatureImage;
      img.onload = () => {
        const aspectRatio = img.width / img.height;
        const sigWidth = 150;
        const sigHeight = sigWidth / aspectRatio;
        ueState.annotations[pageIndex].push({
          type: 'signature',
          image: state.signatureImage,
          x: startX,
          y: startY,
          width: sigWidth,
          height: sigHeight,
          cachedImg: img
        });
        ueRedrawAnnotations();
        ueSetTool('select');
      };
    }
  }
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
      ctx.font = `${anno.fontSize}px Arial`;
      ctx.fillStyle = anno.color;
      const lines = anno.text.split('\n');
      lines.forEach((line, i) => ctx.fillText(line, anno.x, anno.y + i * anno.fontSize * 1.2));
      if (isSelected) {
        const metrics = ctx.measureText(anno.text);
        ueDrawSelectionHandles(ctx, anno.x - 2, anno.y - anno.fontSize, metrics.width + 4, anno.fontSize * lines.length * 1.2 + 4);
      }
      break;
    case 'signature':
      if (anno.cachedImg && anno.cachedImg.complete) {
        ctx.drawImage(anno.cachedImg, anno.x, anno.y, anno.width, anno.height);
        if (isSelected) ueDrawSelectionHandles(ctx, anno.x, anno.y, anno.width, anno.height);
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
  ctx.fillRect(x - handleSize/2 - 2, y - handleSize/2 - 2, handleSize, handleSize);
  ctx.fillRect(x + width - handleSize/2 + 2, y - handleSize/2 - 2, handleSize, handleSize);
  ctx.fillRect(x - handleSize/2 - 2, y + height - handleSize/2 + 2, handleSize, handleSize);
  ctx.fillRect(x + width - handleSize/2 + 2, y + height - handleSize/2 + 2, handleSize, handleSize);
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
        const canvas = document.getElementById('ue-canvas');
        const ctx = canvas.getContext('2d');
        ctx.font = `${anno.fontSize}px Arial`;
        const metrics = ctx.measureText(anno.text);
        bounds = { x: anno.x, y: anno.y - anno.fontSize, w: metrics.width, h: anno.fontSize * 1.2 };
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

// Update status
function ueUpdateStatus(message) {
  const status = document.getElementById('ue-editor-status');
  if (status) status.querySelector('.status-text').textContent = message;
}

// Set current tool
function ueSetTool(tool) {
  ueState.currentTool = tool;

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
  openSignatureModal();
  // After signature is created, switch to signature placement mode
}

// Open text modal
function ueOpenTextModal() {
  const modal = document.getElementById('text-input-modal');
  modal.classList.add('active');
  document.getElementById('text-input-field').value = '';
  document.getElementById('text-input-field').focus();

  // Update preview
  const previewEl = document.getElementById('text-preview');
  const fontSizeEl = document.getElementById('modal-font-size');
  const colorEl = document.getElementById('modal-text-color');

  function updatePreview() {
    previewEl.style.fontSize = fontSizeEl.value + 'px';
    previewEl.style.color = colorEl.value;
    previewEl.textContent = document.getElementById('text-input-field').value || 'Preview teks...';
  }

  document.getElementById('text-input-field').oninput = updatePreview;
  fontSizeEl.onchange = updatePreview;
  colorEl.onchange = updatePreview;
  updatePreview();
}

// Confirm text input - modified to work with unified editor
const originalConfirmTextInput = typeof confirmTextInput === 'function' ? confirmTextInput : null;

function ueConfirmText() {
  const text = document.getElementById('text-input-field').value.trim();
  if (!text) {
    showToast('Masukkan teks terlebih dahulu', 'error');
    return;
  }

  const fontSize = parseInt(document.getElementById('modal-font-size').value);
  const color = document.getElementById('modal-text-color').value;

  ueSaveEditUndoState();
  ueState.annotations[ueState.selectedPage].push({
    type: 'text',
    text,
    x: ueState.pendingTextPosition.x,
    y: ueState.pendingTextPosition.y,
    fontSize,
    color
  });

  document.getElementById('text-input-modal').classList.remove('active');
  ueRedrawAnnotations();
  ueState.pendingTextPosition = null;
}

// Watermark modal
function ueOpenWatermarkModal() {
  document.getElementById('editor-watermark-modal').classList.add('active');
}

// Page number modal
function ueOpenPageNumModal() {
  document.getElementById('editor-pagenum-modal').classList.add('active');
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

  try {
    const newDoc = await PDFLib.PDFDocument.create();
    let helveticaFont = null;

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
              if (!helveticaFont) {
                helveticaFont = await newDoc.embedFont(PDFLib.StandardFonts.Helvetica);
              }
              const lines = anno.text.split('\n');
              const hexColor = anno.color.replace('#', '');
              const r = parseInt(hexColor.substr(0, 2), 16) / 255;
              const g = parseInt(hexColor.substr(2, 2), 16) / 255;
              const b = parseInt(hexColor.substr(4, 2), 16) / 255;
              lines.forEach((line, lineIdx) => {
                page.drawText(line, {
                  x: anno.x * scaleX,
                  y: height - (anno.y + lineIdx * anno.fontSize * 1.2) * scaleY,
                  size: anno.fontSize * scaleY,
                  font: helveticaFont,
                  color: PDFLib.rgb(r, g, b)
                });
              });
              break;
            case 'signature':
              const pngImage = await newDoc.embedPng(anno.image);
              page.drawImage(pngImage, {
                x: anno.x * scaleX,
                y: height - (anno.y + anno.height) * scaleY,
                width: anno.width * scaleX,
                height: anno.height * scaleY
              });
              break;
            case 'watermark':
              if (!helveticaFont) {
                helveticaFont = await newDoc.embedFont(PDFLib.StandardFonts.Helvetica);
              }
              const wmHex = anno.color.replace('#', '');
              page.drawText(anno.text, {
                x: anno.x * scaleX,
                y: height - anno.y * scaleY,
                size: anno.fontSize * scaleY,
                font: helveticaFont,
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

    const pdfBytes = await newDoc.save();
    const filename = ueState.sourceFiles.length === 1
      ? ueState.sourceFiles[0].name.replace('.pdf', '-edited.pdf')
      : 'edited-document.pdf';
    downloadBlob(new Blob([pdfBytes], { type: 'application/pdf' }), filename);
    showToast('PDF berhasil diunduh!', 'success');

  } catch (error) {
    console.error('Error saving PDF:', error);
    showToast('Gagal menyimpan PDF', 'error');
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

  document.getElementById('ue-empty-state').style.display = 'flex';
  document.getElementById('ue-canvas').style.display = 'none';
  document.getElementById('ue-download-btn').disabled = true;
  ueRenderThumbnails();
  ueUpdatePageCount();
}

// Initialize when showing unified editor
function initUnifiedEditor() {
  initUnifiedEditorInput();
  ueState.devicePixelRatio = window.devicePixelRatio || 1;

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
    thumbnails.addEventListener('drop', (e) => {
      e.preventDefault();
      thumbnails.classList.remove('drag-over');
      ueAddFiles(e.dataTransfer.files);
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
// KEYBOARD SHORTCUTS
// ============================================================

document.addEventListener('keydown', (e) => {
  // Escape to go back
  if (e.key === 'Escape' && state.currentTool) {
    showHome();
  }

  // Ctrl+Z for undo in edit mode
  if (e.key === 'z' && (e.ctrlKey || e.metaKey) && state.currentTool === 'edit') {
    e.preventDefault();
    undoEdit();
  }

  // Ctrl+Z for undo in unified editor
  if (e.key === 'z' && (e.ctrlKey || e.metaKey) && state.currentTool === 'unified-editor') {
    e.preventDefault();
    ueUndoAnnotation();
  }

  // Keyboard shortcuts for unified editor tools
  if (state.currentTool === 'unified-editor' && ueState.selectedPage >= 0) {
    if (e.key === 'v' && !e.ctrlKey && !e.metaKey) {
      ueSetTool('select');
    } else if (e.key === 'w' && !e.ctrlKey && !e.metaKey) {
      ueSetTool('whiteout');
    } else if (e.key === 't' && !e.ctrlKey && !e.metaKey) {
      ueSetTool('text');
    } else if (e.key === 's' && !e.ctrlKey && !e.metaKey) {
      ueOpenSignatureModal();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (ueState.selectedAnnotation) {
        e.preventDefault();
        ueSaveEditUndoState();
        ueState.annotations[ueState.selectedAnnotation.pageIndex].splice(ueState.selectedAnnotation.index, 1);
        ueState.selectedAnnotation = null;
        ueRedrawAnnotations();
      }
    }
  }
});

// ============================================================
// HANDLE PASTE
// ============================================================

document.addEventListener('paste', async (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) {
        if (state.currentTool === 'img-to-pdf') {
          addImagesToPDF([file]);
        } else if (state.currentTool === 'compress-img' || state.currentTool === 'resize' || state.currentTool === 'convert-img' || state.currentTool === 'remove-bg') {
          loadImageForTool(file, state.currentTool);
        } else if (!state.currentTool) {
          showTool('compress-img');
          loadImageForTool(file, 'compress-img');
        }
      }
    }
  }
});

// ============================================================
// SERVICE WORKER (for offline support - optional)
// ============================================================

// Uncomment to enable offline support
/*
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(registration => {
        console.log('SW registered:', registration);
      })
      .catch(error => {
        console.log('SW registration failed:', error);
      });
  });
}
*/

// ============================================================
// FUTURE BACKEND FEATURES
// ============================================================
/*
 * The following features require server-side processing and cannot
 * be implemented purely in the browser:
 * 
 * 1. PDF to Word (.docx) conversion
 * 2. PDF to Excel (.xlsx) conversion
 * 3. Word/Excel/PowerPoint to PDF conversion
 * 4. OCR (Optical Character Recognition)
 * 
 * Implementation options when ready:
 * 
 * Option 1: Serverless Functions + LibreOffice
 *   - Deploy on AWS Lambda / Google Cloud Functions / Vercel
 *   - Use libreoffice-lambda: https://github.com/nickatnight/libreoffice-lambda
 *   - Pros: Pay per use, scales automatically
 *   - Cons: Cold start latency, 50MB limit on Lambda
 * 
 * Option 2: CloudConvert API
 *   - https://cloudconvert.com/api
 *   - Cost: ~$0.01-0.05 per conversion
 *   - Pros: Reliable, high quality, many formats
 *   - Cons: External dependency, cost per conversion
 * 
 * Option 3: Self-hosted LibreOffice
 *   - Docker container with LibreOffice headless
 *   - Use unoconv or LibreOffice CLI
 *   - Pros: No external costs, full control
 *   - Cons: Need to manage infrastructure
 * 
 * Option 4: Gotenberg
 *   - https://gotenberg.dev/
 *   - Docker-based conversion service
 *   - Pros: Easy to deploy, many formats
 *   - Cons: Need to manage infrastructure
 * 
 * Privacy considerations for server features:
 *   - Files should be deleted immediately after processing
 *   - Use HTTPS for all transfers
 *   - Consider client-side encryption before upload
 *   - Be transparent with users about data handling
 * 
 * When to implement: When MAU > 10K or donation revenue covers costs
 */
