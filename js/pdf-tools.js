// ============================================================
// LEGACY MERGE PDF (kept for future use)
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
    downloadBlob(new Blob([mergedBytes], { type: 'application/pdf' }), getDownloadFilename({originalName: state.mergeFiles[0]?.name, extension: 'pdf'}));
    
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

        downloadBlob(new Blob([bytes], { type: 'application/pdf' }), getDownloadFilename({originalName: state.currentPDFName, suffix: `page${i + 1}`, extension: 'pdf'}));
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
        downloadBlob(new Blob([bytes], { type: 'application/pdf' }), getDownloadFilename({originalName: state.currentPDFName, suffix: `page${r + 1}`, extension: 'pdf'}));
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
      downloadBlob(new Blob([bytes], { type: 'application/pdf' }), getDownloadFilename({originalName: state.currentPDFName, extension: 'pdf'}));

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
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), getDownloadFilename({originalName: state.currentPDFName, extension: 'pdf'}));
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
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), getDownloadFilename({originalName: state.currentPDFName, extension: 'pdf'}));
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
            downloadBlob(blob, getDownloadFilename({originalName: state.currentPDFName, suffix: `page${pageNum}`, extension: format}));
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

    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), getDownloadFilename({originalName: state.currentPDFName, extension: 'pdf'}));

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

  const protectBtn = document.getElementById('protect-btn');
  const originalText = protectBtn.innerHTML;

  // Show loading state
  protectBtn.disabled = true;
  protectBtn.innerHTML = `
    <svg class="btn-spinner" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M12 2v4m0 12v4m-7.07-3.93l2.83-2.83m8.48-8.48l2.83-2.83M2 12h4m12 0h4m-3.93 7.07l-2.83-2.83M7.76 7.76L4.93 4.93"/>
    </svg>
    Memproses...
  `;

  try {
    // Load the PDF with pdf-lib to ensure it's valid
    const srcDoc = await PDFLib.PDFDocument.load(state.currentPDFBytes);
    const pdfBytes = await srcDoc.save();

    // Encrypt with @pdfsmaller/pdf-encrypt-lite
    const encryptedBytes = await window.encryptPDF(
      new Uint8Array(pdfBytes),
      password,
      password // Use same password for both user and owner
    );

    downloadBlob(new Blob([encryptedBytes], { type: 'application/pdf' }), getDownloadFilename({originalName: state.currentPDFName, extension: 'pdf'}));
    showToast('PDF berhasil diproteksi!', 'success');

  } catch (error) {
    console.error('Error protecting PDF:', error);
    showToast('Gagal memproteksi PDF', 'error');
  } finally {
    // Restore button state
    protectBtn.disabled = false;
    protectBtn.innerHTML = originalText;
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
  if (!canvas) return; // Skip if in Unified Editor or canvas not found
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
      // Build font string with bold/italic and family
      let textFontStyle = '';
      if (anno.italic) textFontStyle += 'italic ';
      if (anno.bold) textFontStyle += 'bold ';

      // Map font family to CSS equivalent
      let textCssFontFamily = 'Helvetica, Arial, sans-serif';
      if (anno.fontFamily === 'Times-Roman') textCssFontFamily = 'Times New Roman, Times, serif';
      else if (anno.fontFamily === 'Courier') textCssFontFamily = 'Courier New, Courier, monospace';
      else if (anno.fontFamily === 'Montserrat') textCssFontFamily = 'Montserrat, sans-serif';
      else if (anno.fontFamily === 'Carlito') textCssFontFamily = 'Carlito, Calibri, sans-serif';

      ctx.font = `${textFontStyle}${anno.fontSize}px ${textCssFontFamily}`;
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

  // Update canvas cursor (only for legacy editor)
  const canvas = document.getElementById('edit-canvas');
  if (canvas) {
    canvas.className = 'editor-canvas';
    if (tool) {
      canvas.classList.add(`tool-${tool}`);
    }
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
function initTextModalControls() {
  const boldBtn = document.getElementById('modal-text-bold');
  const italicBtn = document.getElementById('modal-text-italic');
  const colorPresets = document.querySelectorAll('.color-preset-btn');
  const colorPicker = document.getElementById('modal-text-color');

  // Bold toggle
  boldBtn.onclick = () => {
    boldBtn.classList.toggle('active');
    updateTextPreview();
  };

  // Italic toggle
  italicBtn.onclick = () => {
    italicBtn.classList.toggle('active');
    updateTextPreview();
  };

  // Color presets
  colorPresets.forEach(btn => {
    btn.onclick = () => {
      const color = btn.dataset.color;
      colorPicker.value = color;
      colorPresets.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      updateTextPreview();
    };
  });

  // Color picker change
  colorPicker.oninput = () => {
    colorPresets.forEach(b => b.classList.remove('active'));
    updateTextPreview();
  };
}

function openTextModal() {
  // Minimize changelog when opening modal
  if (window.changelogAPI) {
    window.changelogAPI.minimize();
  }

  const modal = document.getElementById('text-input-modal');
  modal.classList.add('active');
  pushModalState('text-input-modal');

  const textInput = document.getElementById('text-input-field');
  textInput.value = '';
  textInput.focus();

  // Reset to defaults
  document.getElementById('modal-font-family').value = 'Helvetica';
  document.getElementById('modal-font-size').value = '16';
  document.getElementById('modal-text-bold').classList.remove('active');
  document.getElementById('modal-text-italic').classList.remove('active');
  document.getElementById('modal-text-color').value = '#000000';

  // Set black as active preset
  document.querySelectorAll('.color-preset-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.color === '#000000');
  });

  // Setup live preview
  initTextModalControls();
  updateTextPreview();

  textInput.oninput = updateTextPreview;
  document.getElementById('modal-font-size').oninput = updateTextPreview;
  document.getElementById('modal-font-family').onchange = updateTextPreview;

  // Enter key to submit (Shift+Enter for new line)
  textInput.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      confirmTextInput();
    }
  };
}

function closeTextModal(skipHistoryBack = false) {
  const modal = document.getElementById('text-input-modal');
  modal.classList.remove('active');
  state.pendingTextPosition = null;
  navHistory.currentModal = null;
  if (!skipHistoryBack && navHistory.currentView === 'modal') {
    history.back();
  }
}

function updateTextPreview() {
  const text = document.getElementById('text-input-field').value || 'Preview teks';
  const fontSize = document.getElementById('modal-font-size').value;
  const color = document.getElementById('modal-text-color').value;
  const fontFamily = document.getElementById('modal-font-family').value;
  const isBold = document.getElementById('modal-text-bold').classList.contains('active');
  const isItalic = document.getElementById('modal-text-italic').classList.contains('active');

  const preview = document.getElementById('text-preview');
  preview.textContent = text;
  preview.style.fontSize = fontSize + 'px';
  preview.style.color = color;
  preview.style.fontWeight = isBold ? 'bold' : 'normal';
  preview.style.fontStyle = isItalic ? 'italic' : 'normal';

  // Map font family to CSS
  let cssFontFamily = 'Helvetica, Arial, sans-serif';
  if (fontFamily === 'Times-Roman') cssFontFamily = 'Times New Roman, Times, serif';
  else if (fontFamily === 'Courier') cssFontFamily = 'Courier New, Courier, monospace';
  else if (fontFamily === 'Montserrat') cssFontFamily = 'Montserrat, sans-serif';
  else if (fontFamily === 'Carlito') cssFontFamily = 'Carlito, Calibri, sans-serif';
  preview.style.fontFamily = cssFontFamily;
}

function getTextModalSettings() {
  return {
    text: document.getElementById('text-input-field').value.trim(),
    fontSize: parseInt(document.getElementById('modal-font-size').value) || 16,
    color: document.getElementById('modal-text-color').value,
    fontFamily: document.getElementById('modal-font-family').value,
    bold: document.getElementById('modal-text-bold').classList.contains('active'),
    italic: document.getElementById('modal-text-italic').classList.contains('active')
  };
}

function confirmTextInput() {
  // Check if we're in unified editor mode
  if (state.currentTool === 'unified-editor' && ueState.pendingTextPosition) {
    ueConfirmText();
    return;
  }

  const settings = getTextModalSettings();

  if (!settings.text) {
    showToast('Masukkan teks terlebih dahulu', 'error');
    return;
  }

  if (!state.pendingTextPosition) {
    showToast('Posisi teks tidak valid', 'error');
    closeTextModal();
    return;
  }

  saveUndoState();
  state.editAnnotations[state.currentEditPage].push({
    type: 'text',
    text: settings.text,
    x: state.pendingTextPosition.x,
    y: state.pendingTextPosition.y,
    fontSize: settings.fontSize,
    color: settings.color,
    fontFamily: settings.fontFamily,
    bold: settings.bold,
    italic: settings.italic
  });

  closeTextModal();
  renderEditPage();
  setEditTool('select'); // Reset to select tool after adding text
  updateEditorStatus('Teks ditambahkan');
}

// Signature Modal
function openSignatureModal() {
  // Minimize changelog when opening modal
  if (window.changelogAPI) {
    window.changelogAPI.minimize();
  }

  const modal = document.getElementById('signature-modal');
  modal.classList.add('active');
  setEditTool('signature');
  pushModalState('signature-modal');

  // Default to upload tab
  switchSignatureTab('upload');

  setTimeout(() => {
    const canvas = document.getElementById('signature-canvas');
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    canvas.width = canvas.offsetWidth * ratio;
    canvas.height = canvas.offsetHeight * ratio;
    canvas.getContext('2d').scale(ratio, ratio);
    if (state.signaturePad) state.signaturePad.clear();
  }, 100);
}

function closeSignatureModal(skipHistoryBack = false) {
  const modal = document.getElementById('signature-modal');
  modal.classList.remove('active');
  navHistory.currentModal = null;
  if (!skipHistoryBack && navHistory.currentView === 'modal') {
    history.back();
  }
}

function clearSignature() {
  if (state.signaturePad) {
    state.signaturePad.clear();
  }
}

function useSignature() {
  if (state.signaturePad && !state.signaturePad.isEmpty()) {
    // Get the drawn signature
    const signatureCanvas = document.getElementById('signature-canvas');

    // Create a temporary canvas for background removal
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = signatureCanvas.width;
    tempCanvas.height = signatureCanvas.height;
    const ctx = tempCanvas.getContext('2d');

    // Draw the signature
    ctx.drawImage(signatureCanvas, 0, 0);

    // Apply background removal (make white pixels transparent)
    const imageData = ctx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
    const data = imageData.data;
    const threshold = 240; // Threshold for white background

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      // Make white/near-white pixels transparent
      if (r >= threshold && g >= threshold && b >= threshold) {
        data[i + 3] = 0; // Set alpha to 0 (transparent)
      }
    }

    ctx.putImageData(imageData, 0, 0);
    state.signatureImage = tempCanvas.toDataURL('image/png');

    closeSignatureModal();
    // Check if in unified editor mode
    if (state.currentTool === 'unified-editor') {
      ueSetTool('signature');
      // Enable signature preview attached to cursor
      ueState.pendingSignature = true;
      ueState.signaturePreviewPos = null;
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
    const text = btn.textContent.toLowerCase().trim();
    const shouldBeActive = (tab === 'upload' && text === 'upload gambar') ||
                          (tab === 'draw' && text === 'gambar');
    btn.classList.toggle('active', shouldBeActive);
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
    // Pass true to skip history.back() since we're immediately replacing with bg modal state
    closeSignatureModal(true);
    openSignatureBgModal();
  } catch (error) {
    showToast('Gagal memuat gambar', 'error');
    throw error; // Re-throw so app.js can catch it
  }
}

// Signature Background Removal Modal
function openSignatureBgModal() {
  // Minimize changelog when opening modal
  if (window.changelogAPI) {
    window.changelogAPI.minimize();
  }

  const modal = document.getElementById('signature-bg-modal');
  modal.classList.add('active');

  // IMPORTANT: Use replaceState instead of pushState to replace the signature-modal
  // history state (which we just closed). This prevents orphaned history states.
  // If we pushed here, the history would be: [workspace, signature-modal (closed), bg-modal]
  // With replace, it's clean: [workspace, bg-modal]
  history.replaceState({
    view: 'modal',
    modal: 'signature-bg-modal',
    tool: navHistory.currentWorkspace
  }, '', null);
  navHistory.currentView = 'modal';
  navHistory.currentModal = 'signature-bg-modal';

  // Show original image
  document.getElementById('sig-bg-original').src = state.signatureUploadImage.src;

  // Initialize preview
  updateSignatureBgPreview();
}

function closeSignatureBgModal(skipHistoryBack = false) {
  const modal = document.getElementById('signature-bg-modal');
  modal.classList.remove('active');

  // Cleanup
  if (state.signatureUploadImage && state.signatureUploadImage._blobUrl) {
    URL.revokeObjectURL(state.signatureUploadImage._blobUrl);
  }
  state.signatureUploadImage = null;
  state.signatureUploadCanvas = null;

  navHistory.currentModal = null;
  if (!skipHistoryBack && navHistory.currentView === 'modal') {
    history.back();
  }
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
    // Enable signature preview attached to cursor
    ueState.pendingSignature = true;
    ueState.signaturePreviewPos = null;
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
  pushModalState('editor-watermark-modal');
}

function closeEditorWatermarkModal(skipHistoryBack = false) {
  document.getElementById('editor-watermark-modal').classList.remove('active');
  navHistory.currentModal = null;
  if (!skipHistoryBack && navHistory.currentView === 'modal') {
    history.back();
  }
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
  pushModalState('editor-pagenum-modal');
}

function closeEditorPageNumModal(skipHistoryBack = false) {
  document.getElementById('editor-pagenum-modal').classList.remove('active');
  navHistory.currentModal = null;
  if (!skipHistoryBack && navHistory.currentView === 'modal') {
    history.back();
  }
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

    // Font cache for all text annotations
    const fontCache = {};

    // Helper to get the right font based on family, bold, italic
    async function getTextFont(fontFamily, bold, italic) {
      let fontName = fontFamily || 'Helvetica';

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
      }

      if (!fontCache[fontName]) {
        fontCache[fontName] = await srcDoc.embedFont(PDFLib.StandardFonts[fontName]);
      }
      return fontCache[fontName];
    }

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

          // Get the appropriate font based on family and style
          const textFont = await getTextFont(anno.fontFamily, anno.bold, anno.italic);

          // Text position conversion
          const pdfX = anno.x * scaleX;
          const pdfY = pdfHeight - anno.y * scaleY;
          const pdfFontSize = anno.fontSize * scaleX;

          // Handle multi-line text
          const lines = anno.text.split('\n');
          for (let idx = 0; idx < lines.length; idx++) {
            page.drawText(lines[idx], {
              x: pdfX,
              y: pdfY - (idx * pdfFontSize * 1.2),
              size: pdfFontSize,
              font: textFont,
              color: PDFLib.rgb(r, g, b),
            });
          }
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
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), getDownloadFilename({originalName: state.currentPDFName, extension: 'pdf'}));
    showToast('PDF berhasil disimpan!', 'success');

  } catch (error) {
    console.error('Error saving edited PDF:', error);
    showToast('Gagal menyimpan PDF: ' + error.message, 'error');
  }
}

