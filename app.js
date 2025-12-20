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
        document.getElementById('compress-original').src = state.originalImage.src;
        document.getElementById('compress-original-size').textContent = `Original: ${formatFileSize(file.size)}`;
        state.originalImageSize = file.size;
        updateCompressPreview();
        document.getElementById('compress-img-btn').disabled = false;
        break;
      case 'resize':
        document.getElementById('resize-preview').src = state.originalImage.src;
        document.getElementById('resize-width').value = state.originalImage.naturalWidth;
        document.getElementById('resize-height').value = state.originalImage.naturalHeight;
        state.originalWidth = state.originalImage.naturalWidth;
        state.originalHeight = state.originalImage.naturalHeight;
        document.getElementById('resize-dimensions').textContent = `Dimensi: ${state.originalWidth} × ${state.originalHeight}`;
        document.getElementById('resize-btn').disabled = false;
        break;
      case 'convert-img':
        document.getElementById('convert-preview').src = state.originalImage.src;
        const ext = file.name.split('.').pop().toLowerCase();
        document.getElementById('convert-info').textContent = `Format saat ini: ${ext.toUpperCase()}`;
        document.getElementById('convert-btn').disabled = false;
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
    container.innerHTML = '<p style="color: var(--text-tertiary); width: 100%; text-align: center; padding: 2rem;">Seret file PDF ke sini atau klik "Tambah PDF"</p>';
    return;
  }

  for (let i = 0; i < state.pmPages.length; i++) {
    const pageData = state.pmPages[i];
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

      const div = document.createElement('div');
      div.className = 'page-item' + (pageData.selected ? ' selected' : '');
      div.dataset.index = i;
      div.draggable = true;

      // Apply rotation transform
      if (pageData.rotation !== 0) {
        canvas.style.transform = `rotate(${pageData.rotation}deg)`;
      }

      div.appendChild(canvas);

      // Page number badge
      const numBadge = document.createElement('span');
      numBadge.className = 'page-item-number';
      numBadge.textContent = i + 1;
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
        pmDeletePage(i);
      };
      div.appendChild(delBtn);

      // Click to select
      div.addEventListener('click', () => {
        pageData.selected = !pageData.selected;
        div.classList.toggle('selected', pageData.selected);
        pmUpdateStatus();
      });

      container.appendChild(div);
    } catch (error) {
      console.error('Error rendering page:', error);
    }
  }

  // Enable drag-and-drop reordering
  pmEnableDragReorder();
}

function pmEnableDragReorder() {
  const container = document.getElementById('pm-pages');
  let draggedItem = null;
  let draggedIndex = -1;

  container.querySelectorAll('.page-item').forEach((item) => {
    item.addEventListener('dragstart', (e) => {
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
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });

    item.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!draggedItem) return;

      const targetIndex = parseInt(item.dataset.index);
      if (draggedIndex !== targetIndex) {
        // Reorder in state
        const [movedPage] = state.pmPages.splice(draggedIndex, 1);
        state.pmPages.splice(targetIndex, 0, movedPage);
        pmRenderPages();
      }
    });
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

function pmRotateSelected(degrees) {
  const hasSelection = state.pmPages.some(p => p.selected);

  if (!hasSelection) {
    showToast('Pilih halaman yang ingin diputar', 'error');
    return;
  }

  state.pmPages.forEach(p => {
    if (p.selected) {
      p.rotation = ((p.rotation + degrees) % 360 + 360) % 360;
    }
  });

  pmRenderPages();
  showToast('Halaman diputar!', 'success');
}

function pmDeleteSelected() {
  const hasSelection = state.pmPages.some(p => p.selected);

  if (!hasSelection) {
    showToast('Pilih halaman yang ingin dihapus', 'error');
    return;
  }

  state.pmPages = state.pmPages.filter(p => !p.selected);
  pmRenderPages();
  pmUpdateStatus();
  pmUpdateDownloadButton();
  showToast('Halaman dihapus!', 'success');
}

function pmDeletePage(index) {
  state.pmPages.splice(index, 1);
  pmRenderPages();
  pmUpdateStatus();
  pmUpdateDownloadButton();
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
        downloadBlob(new Blob([bytes], { type: 'application/pdf' }), `halaman_${i + 1}.pdf`);
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
      downloadBlob(new Blob([bytes], { type: 'application/pdf' }), 'extracted.pdf');
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
      downloadBlob(new Blob([bytes], { type: 'application/pdf' }), 'output.pdf');
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
            downloadBlob(blob, `halaman_${pageNum}.${format}`);
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

    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), 'compressed.pdf');

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
    
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), 'protected.pdf');
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
    
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), 'unlocked.pdf');
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
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), 'watermarked.pdf');
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
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), 'numbered.pdf');
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
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), 'cropped.pdf');
    showToast('PDF berhasil di-crop!', 'success');

  } catch (error) {
    console.error('Error cropping PDF:', error);
    showToast('Gagal meng-crop PDF', 'error');
  }
}

// ============================================================
// EDIT PDF (Whiteout, Text, Signature)
// ============================================================

async function initEditMode() {
  state.currentEditPage = 0;
  state.editAnnotations = {};
  state.currentEditTool = null;
  
  for (let i = 0; i < state.currentPDF.numPages; i++) {
    state.editAnnotations[i] = [];
  }
  
  await renderEditPage();
  setupEditCanvas();
}

async function renderEditPage() {
  const canvas = document.getElementById('edit-canvas');
  const ctx = canvas.getContext('2d');

  const page = await state.currentPDF.getPage(state.currentEditPage + 1);
  const scale = 1.5;
  const viewport = page.getViewport({ scale });

  canvas.width = viewport.width;
  canvas.height = viewport.height;

  await page.render({ canvasContext: ctx, viewport }).promise;

  // Draw annotations - await each one to ensure images are loaded
  const annotations = state.editAnnotations[state.currentEditPage] || [];
  for (const anno of annotations) {
    await drawAnnotation(ctx, anno);
  }

  document.getElementById('edit-page-info').textContent =
    `Halaman ${state.currentEditPage + 1} dari ${state.currentPDF.numPages}`;

  document.getElementById('edit-prev').disabled = state.currentEditPage === 0;
  document.getElementById('edit-next').disabled = state.currentEditPage === state.currentPDF.numPages - 1;
}

function drawAnnotation(ctx, anno) {
  return new Promise((resolve) => {
    switch (anno.type) {
      case 'whiteout':
        ctx.fillStyle = 'white';
        ctx.fillRect(anno.x, anno.y, anno.width, anno.height);
        resolve();
        break;
      case 'text':
        ctx.font = `${anno.fontSize}px Arial`;
        ctx.fillStyle = anno.color;
        ctx.fillText(anno.text, anno.x, anno.y);
        resolve();
        break;
      case 'signature':
        if (anno.image && anno.cachedImg) {
          // Use cached image if available
          ctx.drawImage(anno.cachedImg, anno.x, anno.y, anno.width, anno.height);
          resolve();
        } else if (anno.image) {
          // Load image and cache it for future renders
          const img = new Image();
          img.onload = () => {
            anno.cachedImg = img;
            ctx.drawImage(img, anno.x, anno.y, anno.width, anno.height);
            resolve();
          };
          img.onerror = () => resolve();
          img.src = anno.image;
        } else {
          resolve();
        }
        break;
      default:
        resolve();
    }
  });
}

function setupEditCanvas() {
  // Prevent duplicate event listeners
  if (state.editCanvasSetup) {
    return;
  }

  const canvas = document.getElementById('edit-canvas');
  if (!canvas) return;

  state.editCanvasSetup = true;

  let isDrawing = false;
  let startX, startY;

  canvas.addEventListener('mousedown', (e) => {
    if (!state.currentEditTool) return;

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    startX = (e.clientX - rect.left) * scaleX;
    startY = (e.clientY - rect.top) * scaleY;
    isDrawing = true;
  });

  canvas.addEventListener('mousemove', (e) => {
    if (!isDrawing || state.currentEditTool !== 'whiteout') return;

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const currentX = (e.clientX - rect.left) * scaleX;
    const currentY = (e.clientY - rect.top) * scaleY;

    // Draw preview
    renderEditPage().then(() => {
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.strokeStyle = '#ccc';
      ctx.fillRect(
        Math.min(startX, currentX),
        Math.min(startY, currentY),
        Math.abs(currentX - startX),
        Math.abs(currentY - startY)
      );
      ctx.strokeRect(
        Math.min(startX, currentX),
        Math.min(startY, currentY),
        Math.abs(currentX - startX),
        Math.abs(currentY - startY)
      );
    });
  });

  canvas.addEventListener('mouseup', (e) => {
    if (!isDrawing) return;
    isDrawing = false;

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const endX = (e.clientX - rect.left) * scaleX;
    const endY = (e.clientY - rect.top) * scaleY;

    if (state.currentEditTool === 'whiteout') {
      state.editAnnotations[state.currentEditPage].push({
        type: 'whiteout',
        x: Math.min(startX, endX),
        y: Math.min(startY, endY),
        width: Math.abs(endX - startX),
        height: Math.abs(endY - startY)
      });
      renderEditPage();
    } else if (state.currentEditTool === 'text') {
      const text = prompt('Masukkan teks:');
      if (text) {
        const fontSize = parseInt(document.getElementById('edit-font-size').value);
        const color = document.getElementById('edit-text-color').value;
        state.editAnnotations[state.currentEditPage].push({
          type: 'text',
          text,
          x: startX,
          y: startY,
          fontSize,
          color
        });
        renderEditPage();
      }
    } else if (state.currentEditTool === 'signature' && state.signatureImage) {
      state.editAnnotations[state.currentEditPage].push({
        type: 'signature',
        image: state.signatureImage,
        x: startX,
        y: startY,
        width: 150,
        height: 75
      });
      renderEditPage();
    }
  });

  // Handle mouse leaving the canvas
  canvas.addEventListener('mouseleave', () => {
    isDrawing = false;
  });
}

function setEditTool(tool) {
  state.currentEditTool = tool;
  
  document.querySelectorAll('.editor-tool-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.editTool === tool);
  });
  
  document.getElementById('text-controls').style.display = 
    tool === 'text' ? 'flex' : 'none';
}

function editPrevPage() {
  if (state.currentEditPage > 0) {
    state.currentEditPage--;
    renderEditPage();
  }
}

function editNextPage() {
  if (state.currentEditPage < state.currentPDF.numPages - 1) {
    state.currentEditPage++;
    renderEditPage();
  }
}

function undoEdit() {
  const annotations = state.editAnnotations[state.currentEditPage];
  if (annotations && annotations.length > 0) {
    annotations.pop();
    renderEditPage();
  }
}

// Signature Modal
function openSignatureModal() {
  document.getElementById('signature-modal').classList.add('active');
  setEditTool('signature');
  
  // Resize canvas after modal opens
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
    showToast('Klik pada PDF untuk menempatkan tanda tangan', 'success');
  } else {
    showToast('Buat tanda tangan terlebih dahulu', 'error');
  }
}

async function saveEditedPDF() {
  try {
    const srcDoc = await PDFLib.PDFDocument.load(state.currentPDFBytes);
    const pages = srcDoc.getPages();
    
    // Get scale factor
    const canvas = document.getElementById('edit-canvas');
    const firstPage = pages[0];
    const { width: pageWidth, height: pageHeight } = firstPage.getSize();
    
    // We need to approximate - the canvas was rendered at 1.5x scale
    const scale = 1.5;
    
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const annotations = state.editAnnotations[i] || [];
      const { width, height } = page.getSize();
      
      for (const anno of annotations) {
        const scaleX = width / (canvas.width / scale);
        const scaleY = height / (canvas.height / scale);
        
        if (anno.type === 'whiteout') {
          page.drawRectangle({
            x: anno.x * scaleX / scale,
            y: height - (anno.y + anno.height) * scaleY / scale,
            width: anno.width * scaleX / scale,
            height: anno.height * scaleY / scale,
            color: PDFLib.rgb(1, 1, 1),
          });
        } else if (anno.type === 'text') {
          const font = await srcDoc.embedFont(PDFLib.StandardFonts.Helvetica);
          const hexColor = anno.color;
          const r = parseInt(hexColor.slice(1, 3), 16) / 255;
          const g = parseInt(hexColor.slice(3, 5), 16) / 255;
          const b = parseInt(hexColor.slice(5, 7), 16) / 255;
          
          page.drawText(anno.text, {
            x: anno.x * scaleX / scale,
            y: height - anno.y * scaleY / scale,
            size: anno.fontSize * scaleX / scale,
            font,
            color: PDFLib.rgb(r, g, b),
          });
        } else if (anno.type === 'signature' && anno.image) {
          const pngImage = await srcDoc.embedPng(anno.image);
          page.drawImage(pngImage, {
            x: anno.x * scaleX / scale,
            y: height - (anno.y + anno.height) * scaleY / scale,
            width: anno.width * scaleX / scale,
            height: anno.height * scaleY / scale,
          });
        }
      }
    }
    
    const bytes = await srcDoc.save();
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), 'edited.pdf');
    showToast('PDF berhasil disimpan!', 'success');
    
  } catch (error) {
    console.error('Error saving edited PDF:', error);
    showToast('Gagal menyimpan PDF', 'error');
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
  
  // Clear placeholder
  if (state.imgToPdfFiles.length === 0) {
    fileList.innerHTML = '';
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
    
    downloadBlob(new Blob([pdfBytes], { type: 'application/pdf' }), 'images.pdf');
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
        } else if (state.currentTool === 'compress-img' || state.currentTool === 'resize' || state.currentTool === 'convert-img') {
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
