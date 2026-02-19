/*
 * ============================================================
 * PDFLokal - app.js
 * Application Bootstrap & Remaining Logic
 * ============================================================
 *
 * PURPOSE:
 *   Bootstrap file. Handles initialization, file handling,
 *   keyboard shortcuts, and mobile UI for the unified editor.
 *
 * STATE & UTILITIES: Moved to js/lib/state.js, js/lib/utils.js,
 *   and js/lib/navigation.js (loaded as ES modules before this file).
 *
 * GLOBALS AVAILABLE VIA WINDOW BRIDGE:
 *   state, mobileState, navHistory, ueState, uePmState,
 *   showToast, showFullscreenLoading, hideFullscreenLoading,
 *   formatFileSize, downloadBlob, getDownloadFilename, checkFileSize,
 *   loadImage, convertImageToPdf, cleanupImage, escapeHtml, sleep, debounce,
 *   showHome, showTool, pushWorkspaceState, pushModalState, closeAllModals,
 *   setupWorkspaceDropZone, resetState, initNavigationHistory
 *
 * LOAD ORDER: Must load AFTER js/lib/*.js modules, BEFORE pdf-tools.js
 * ============================================================
 */

// ============================================================
// BROWSER COMPATIBILITY CHECK
// ============================================================

function checkBrowserCompatibility() {
  const required = [
    { feature: 'Promise', check: typeof Promise !== 'undefined' },
    { feature: 'Blob', check: typeof Blob !== 'undefined' },
    { feature: 'Canvas', check: !!document.createElement('canvas').getContext },
    { feature: 'fetch', check: typeof fetch !== 'undefined' },
    { feature: 'FileReader', check: typeof FileReader !== 'undefined' }
  ];

  const missing = required.filter(r => !r.check);
  if (missing.length > 0) {
    showToast(`Browser tidak mendukung fitur: ${missing.map(m => m.feature).join(', ')}. Silakan gunakan browser modern.`, 'error');
    return false;
  }
  return true;
}

// ============================================================
// MOBILE DETECTION
// ============================================================

function detectMobile() {
  mobileState.viewportWidth = window.innerWidth;
  mobileState.viewportHeight = window.innerHeight;
  mobileState.isMobile = window.innerWidth < 768;
  mobileState.isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  mobileState.orientation = window.innerHeight > window.innerWidth ? 'portrait' : 'landscape';

  // Update body classes for CSS targeting
  document.body.classList.toggle('is-mobile', mobileState.isMobile);
  document.body.classList.toggle('is-touch', mobileState.isTouch);
  document.body.classList.toggle('is-landscape', mobileState.orientation === 'landscape');

  // Update dropzone text for mobile/touch devices
  const dropzoneText = document.querySelector('#main-dropzone h3');
  const dropzoneSubtext = document.querySelector('#main-dropzone p');
  const mainFileInput = document.getElementById('file-input');

  if (dropzoneText) {
    if (mobileState.isMobile || mobileState.isTouch) {
      dropzoneText.textContent = 'Ketuk, lalu pilih Foto/Media untuk browse file PDF';
    } else {
      dropzoneText.textContent = 'Seret file ke sini atau klik untuk pilih';
    }
  }

  // Mobile: PDF only on main dropzone
  if (mobileState.isMobile) {
    if (mainFileInput) {
      mainFileInput.accept = '.pdf,application/pdf';
    }
    if (dropzoneSubtext) {
      dropzoneSubtext.textContent = 'PDF';
    }
  } else {
    if (mainFileInput) {
      mainFileInput.accept = '.pdf,image/*,application/pdf';
    }
    if (dropzoneSubtext) {
      dropzoneSubtext.textContent = 'PDF or Image';
    }
  }
}

// ============================================================
// INITIALIZATION
// ============================================================

function initApp() {
  // Check browser compatibility first
  checkBrowserCompatibility();

  // Initialize mobile detection first
  detectMobile();

  // Listen for resize and orientation changes
  window.addEventListener('resize', debounce(detectMobile, 150));
  window.addEventListener('orientationchange', () => {
    setTimeout(detectMobile, 100);
  });

  // Initialize theme system
  if (window.themeAPI) {
    window.themeAPI.init();
  }

  initDropZone();
  initToolCards();
  initFileInputs();
  initRangeSliders();
  initSignaturePad();
  initNavigationHistory();
}

// Initialize when DOM is ready (same pattern as changelog.js)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

// ============================================================
// DROPZONE
// ============================================================

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

  fileInput.addEventListener('change', async (e) => {
    await handleDroppedFiles(e.target.files);
    e.target.value = '';
  });
}

// ============================================================
// TOOL CARDS
// ============================================================

function initToolCards() {
  document.querySelectorAll('.tool-card:not(.disabled)').forEach(card => {
    card.addEventListener('click', () => {
      const tool = card.dataset.tool;

      // Handle merge-pdf and split-pdf separately (don't call showTool)
      if (tool === 'merge-pdf') {
        handleEditorCardWithFilePicker('merge');
        return;
      }
      if (tool === 'split-pdf') {
        handleEditorCardWithFilePicker('split');
        return;
      }

      showTool(tool);
    });
  });
}

// Merge/Split PDF cards (bypasses showTool — keeps home visible during file picking)
function handleEditorCardWithFilePicker(mode) {
  const inputId = mode + '-pdf-input';
  let input = document.getElementById(inputId);
  if (!input) {
    input = document.createElement('input');
    input.type = 'file';
    input.id = inputId;
    input.multiple = true;
    input.accept = '.pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/*';
    input.style.display = 'none';
    document.body.appendChild(input);

    input.addEventListener('change', async (e) => {
      if (e.target.files.length > 0) {
        const filesArray = Array.from(e.target.files);
        input.value = '';

        showFullscreenLoading('Memuat PDF...');

        try {
          const workspace = document.getElementById('unified-editor-workspace');
          if (workspace) {
            initUnifiedEditor();
            await ueAddFiles(filesArray);

            document.getElementById('home-view').style.display = 'none';
            workspace.classList.add('active');
            state.currentTool = 'unified-editor';
            window.scrollTo(0, 0);
            pushWorkspaceState('unified-editor');

            if (mobileState.isMobile || mobileState.isTouch) {
              initMobileEditorEnhancements();
              ueMobileUpdatePageIndicator();
            }

            uePmOpenModal();

            setTimeout(() => {
              if (mode === 'split' && !uePmState.extractMode) {
                uePmToggleExtractMode();
              }
              hideFullscreenLoading();
            }, 100);
          }
        } catch (error) {
          console.error('Error loading PDFs:', error);
          hideFullscreenLoading();
          showToast('Gagal memuat PDF', 'error');
        }
      }
    });
  }
  input.click();
}

// ============================================================
// FILE INPUTS
// ============================================================

function initFileInputs() {
  // Image to PDF input
  const imgPdfInput = document.getElementById('img-pdf-input');
  if (imgPdfInput) {
    imgPdfInput.addEventListener('change', async (e) => {
      if (e.target.files.length > 0) {
        showFullscreenLoading('Memuat gambar...');
        try {
          await addImagesToPDF(e.target.files);
        } catch (error) {
          console.error('Error loading images:', error);
          showToast('Gagal memuat gambar', 'error');
        } finally {
          hideFullscreenLoading();
          e.target.value = '';
        }
      }
    });
  }

  // Compress PDF input
  const compressPdfInput = document.getElementById('compress-pdf-input');
  if (compressPdfInput) {
    compressPdfInput.addEventListener('change', async (e) => {
      if (e.target.files.length > 0) {
        showFullscreenLoading('Memuat PDF...');
        try {
          await loadPDFForTool(e.target.files[0], 'compress-pdf');
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

  // PDF to Image input
  const pdfImgInput = document.getElementById('pdf-img-input');
  if (pdfImgInput) {
    pdfImgInput.addEventListener('change', async (e) => {
      if (e.target.files.length > 0) {
        showFullscreenLoading('Memuat PDF...');
        try {
          await loadPDFForTool(e.target.files[0], 'pdf-to-img');
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

  // Protect PDF input
  const protectInput = document.getElementById('protect-input');
  if (protectInput) {
    protectInput.addEventListener('change', async (e) => {
      if (e.target.files.length > 0) {
        showFullscreenLoading('Memuat PDF...');
        try {
          await loadPDFForTool(e.target.files[0], 'protect');
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

  // Compress Image input
  const compressImgInput = document.getElementById('compress-img-input');
  if (compressImgInput) {
    compressImgInput.addEventListener('change', async (e) => {
      if (e.target.files.length > 0) {
        showFullscreenLoading('Memuat gambar...');
        try {
          await loadImageForTool(e.target.files[0], 'compress-img');
        } catch (error) {
          console.error('Error loading image:', error);
          showToast('Gagal memuat gambar', 'error');
        } finally {
          hideFullscreenLoading();
          e.target.value = '';
        }
      }
    });
  }

  // Resize Image input
  const resizeInput = document.getElementById('resize-input');
  if (resizeInput) {
    resizeInput.addEventListener('change', async (e) => {
      if (e.target.files.length > 0) {
        showFullscreenLoading('Memuat gambar...');
        try {
          await loadImageForTool(e.target.files[0], 'resize');
        } catch (error) {
          console.error('Error loading image:', error);
          showToast('Gagal memuat gambar', 'error');
        } finally {
          hideFullscreenLoading();
          e.target.value = '';
        }
      }
    });
  }

  // Convert Image input
  const convertInput = document.getElementById('convert-input');
  if (convertInput) {
    convertInput.addEventListener('change', async (e) => {
      if (e.target.files.length > 0) {
        showFullscreenLoading('Memuat gambar...');
        try {
          await loadImageForTool(e.target.files[0], 'convert-img');
        } catch (error) {
          console.error('Error loading image:', error);
          showToast('Gagal memuat gambar', 'error');
        } finally {
          hideFullscreenLoading();
          e.target.value = '';
        }
      }
    });
  }

  // Remove Background input
  const removeBgInput = document.getElementById('remove-bg-input');
  if (removeBgInput) {
    removeBgInput.addEventListener('change', async (e) => {
      if (e.target.files.length > 0) {
        showFullscreenLoading('Memuat gambar...');
        try {
          await loadImageForTool(e.target.files[0], 'remove-bg');
        } catch (error) {
          console.error('Error loading image:', error);
          showToast('Gagal memuat gambar', 'error');
        } finally {
          hideFullscreenLoading();
          e.target.value = '';
        }
      }
    });
  }

  // Signature Upload input
  const sigUploadInput = document.getElementById('signature-upload-input');
  if (sigUploadInput) {
    sigUploadInput.addEventListener('change', async (e) => {
      if (e.target.files.length > 0) {
        showFullscreenLoading('Memuat tanda tangan...');
        try {
          await loadSignatureImage(e.target.files[0]); // → pdf-tools.js
        } catch (error) {
          showToast('Gagal memuat tanda tangan', 'error');
        } finally {
          hideFullscreenLoading();
          e.target.value = '';
        }
      }
    });
  }

  // Initialize drop hint drag-over effects
  initDropHints();
}

function initDropHints() {
  document.querySelectorAll('.drop-hint, .workspace .dropzone, .preview-area .dropzone, .page-grid .dropzone, .file-list .dropzone').forEach(hint => {
    if (hint.id === 'main-dropzone') return;

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

async function handleDroppedFiles(files) {
  if (!files || files.length === 0) return;

  const file = files[0];

  if (!checkFileSize(file)) return;

  const isPDF = file.type === 'application/pdf';
  const isImage = file.type.startsWith('image/');

  if (!isPDF && !isImage) {
    showToast('File tidak didukung. Gunakan PDF, JPG, PNG, atau WebP.', 'error');
    return;
  }

  if (mobileState.isMobile && isImage && !isPDF) {
    showToast('Di perangkat mobile, gunakan tool khusus gambar untuk memproses gambar.', 'info');
    return;
  }

  showFullscreenLoading(isPDF ? 'Memuat PDF...' : 'Memuat gambar...');

  try {
    if (!state.currentTool) {
      if (isPDF) {
        showTool('unified-editor');
        await ueAddFiles(files);
      } else if (isImage && files.length > 1) {
        showTool('img-to-pdf');
        await addImagesToPDF(files);
      } else if (isImage) {
        showTool('compress-img');
        await loadImageForTool(file, 'compress-img');
      }
    }
  } catch (error) {
    console.error('Error loading file:', error);
    showToast('Gagal memuat file', 'error');
  } finally {
    hideFullscreenLoading();
  }
}

async function loadPDFForTool(file, tool) {
  try {
    const arrayBuffer = await file.arrayBuffer();
    state.currentPDFBytes = new Uint8Array(arrayBuffer);
    state.currentPDFName = file.name;

    state.currentPDF = await pdfjsLib.getDocument({ data: state.currentPDFBytes.slice() }).promise;

    switch (tool) {
      case 'pdf-to-img':
        await renderPdfImgPages();
        document.getElementById('pdf-img-btn').disabled = false;
        break;
      case 'compress-pdf':
        await showPDFPreview('compress-pdf-preview');
        document.getElementById('compress-pdf-btn').disabled = false;
        break;
      case 'protect':
        await showPDFPreview('protect-preview');
        document.getElementById('protect-btn').disabled = false;
        break;
    }
  } catch (error) {
    console.error('Error loading PDF:', error);
    const errorMsg = error.message || '';
    if (errorMsg.includes('password') || errorMsg.includes('encrypted')) {
      showToast('PDF ini dilindungi password. File tidak dapat dibuka tanpa password.', 'error');
    } else if (errorMsg.includes('Invalid') || errorMsg.includes('corrupt')) {
      showToast('File PDF rusak atau tidak valid. Coba file lain.', 'error');
    } else {
      showToast('Gagal memuat PDF. File mungkin rusak atau terenkripsi.', 'error');
    }
  }
}

async function loadImageForTool(file, tool) {
  try {
    state.originalImage = await loadImage(file);
    state.originalImageName = file.name;

    switch (tool) {
      case 'compress-img':
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

// ============================================================
// KEYBOARD SHORTCUTS
// ============================================================

document.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();

  const activeEl = document.activeElement;
  const isTyping = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable);

  // Escape - close modals or go back home
  if (e.key === 'Escape') {
    const shortcutsModal = document.getElementById('shortcuts-modal');
    if (shortcutsModal && shortcutsModal.classList.contains('active')) {
      closeShortcutsModal();
      return;
    }
    if (state.currentTool) {
      showHome();
    }
  }

  // Ctrl+S / Cmd+S - Download PDF in unified editor
  if ((e.ctrlKey || e.metaKey) && key === 's') {
    e.preventDefault();
    if (state.currentTool === 'unified-editor' && ueState.pages.length > 0) {
      ueDownload();
    }
  }

  // Ctrl+Z for undo in unified editor
  if (key === 'z' && (e.ctrlKey || e.metaKey) && state.currentTool === 'unified-editor') {
    e.preventDefault();
    ueUndoAnnotation();
  }

  // Ctrl+Y for redo in unified editor
  if (key === 'y' && (e.ctrlKey || e.metaKey) && state.currentTool === 'unified-editor') {
    e.preventDefault();
    ueRedoAnnotation();
  }

  // Keyboard shortcuts for unified editor tools (only when not typing)
  if (state.currentTool === 'unified-editor' && !isTyping) {
    if (ueState.selectedPage >= 0) {
      if (key === 'v' && !e.ctrlKey && !e.metaKey) {
        ueSetTool('select');
      } else if (key === 'w' && !e.ctrlKey && !e.metaKey) {
        ueSetTool('whiteout');
      } else if (key === 't' && !e.ctrlKey && !e.metaKey) {
        ueSetTool('text');
      } else if (key === 's' && !e.ctrlKey && !e.metaKey) {
        ueOpenSignatureModal();
      } else if (key === 'r' && !e.ctrlKey && !e.metaKey) {
        ueRotateCurrentPage();
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

    if (e.key === 'ArrowLeft' && ueState.selectedPage > 0) {
      e.preventDefault();
      ueSelectPage(ueState.selectedPage - 1);
    } else if (e.key === 'ArrowRight' && ueState.selectedPage < ueState.pages.length - 1) {
      e.preventDefault();
      ueSelectPage(ueState.selectedPage + 1);
    }

    if (e.key === '?' || (e.shiftKey && key === '/')) {
      e.preventDefault();
      openShortcutsModal();
    }
  }
});

// ============================================================
// KEYBOARD SHORTCUTS MODAL
// ============================================================

function openShortcutsModal() {
  const modal = document.getElementById('shortcuts-modal');
  if (modal) {
    modal.classList.add('active');
  }
}

function closeShortcutsModal() {
  const modal = document.getElementById('shortcuts-modal');
  if (modal) {
    modal.classList.remove('active');
  }
}

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
// MOBILE NAVIGATION & UI FUNCTIONS
// ============================================================

function ueMobilePrevPage() {
  if (ueState.selectedPage > 0) {
    ueSelectPage(ueState.selectedPage - 1);
    ueMobileUpdatePageIndicator();

    if (mobileState.isTouch && navigator.vibrate) {
      navigator.vibrate(10);
    }
  }
}

function ueMobileNextPage() {
  if (ueState.selectedPage < ueState.pages.length - 1) {
    ueSelectPage(ueState.selectedPage + 1);
    ueMobileUpdatePageIndicator();

    if (mobileState.isTouch && navigator.vibrate) {
      navigator.vibrate(10);
    }
  }
}

function ueMobileUpdatePageIndicator() {
  const indicator = document.getElementById('ue-mobile-page-indicator');
  const prevBtn = document.getElementById('ue-mobile-prev');
  const nextBtn = document.getElementById('ue-mobile-next');

  if (!indicator) return;

  const current = ueState.selectedPage + 1;
  const total = ueState.pages.length;

  indicator.innerHTML = `Halaman <strong>${current}</strong> / ${total}`;

  if (prevBtn) prevBtn.disabled = ueState.selectedPage <= 0;
  if (nextBtn) nextBtn.disabled = ueState.selectedPage >= ueState.pages.length - 1;
}

function ueMobileOpenPagePicker() {
  const picker = document.getElementById('ue-mobile-page-picker');
  const grid = document.getElementById('ue-mobile-page-grid');

  if (!picker || !grid || ueState.pages.length === 0) return;

  grid.innerHTML = '';
  ueState.pages.forEach((page, index) => {
    const thumb = document.createElement('div');
    thumb.className = 'mobile-page-thumb' + (index === ueState.selectedPage ? ' selected' : '');
    thumb.onclick = () => {
      ueSelectPage(index);
      ueMobileUpdatePageIndicator();
      ueMobileClosePagePicker();

      if (mobileState.isTouch && navigator.vibrate) {
        navigator.vibrate(10);
      }
    };

    if (page.canvas) {
      const thumbCanvas = document.createElement('canvas');
      const scale = 0.3;
      thumbCanvas.width = page.canvas.width * scale;
      thumbCanvas.height = page.canvas.height * scale;
      const ctx = thumbCanvas.getContext('2d');
      ctx.drawImage(page.canvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
      thumb.appendChild(thumbCanvas);
    }

    const num = document.createElement('span');
    num.className = 'mobile-page-thumb-number';
    num.textContent = index + 1;
    thumb.appendChild(num);

    grid.appendChild(thumb);
  });

  picker.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function ueMobileClosePagePicker() {
  const picker = document.getElementById('ue-mobile-page-picker');
  if (picker) {
    picker.classList.remove('active');
  }
  document.body.style.overflow = '';
}

function toggleMobileTools() {
  const dropdown = document.getElementById('mobile-tools-dropdown');
  if (dropdown) {
    dropdown.classList.toggle('active');
  }
}

function closeMobileTools() {
  const dropdown = document.getElementById('mobile-tools-dropdown');
  if (dropdown) {
    dropdown.classList.remove('active');
  }
}

function ueMobileUpdateSignButton() {
  const signBtn = document.getElementById('ue-mobile-sign-btn');
  if (!signBtn) return;

  const currentPageAnnotations = ueState.annotations[ueState.selectedPage] || [];
  const hasSignature = currentPageAnnotations.some(a => a.type === 'signature');

  signBtn.classList.toggle('has-signature', hasSignature);
}

// Close mobile tools when clicking outside
document.addEventListener('click', function(e) {
  const dropdown = document.getElementById('mobile-tools-dropdown');
  const moreBtn = document.getElementById('ue-mobile-more-btn');

  if (dropdown && dropdown.classList.contains('active')) {
    if (!dropdown.contains(e.target) && e.target !== moreBtn && !moreBtn.contains(e.target)) {
      closeMobileTools();
    }
  }
});

function initMobileEditorEnhancements() {
  // Placeholder for future mobile-specific enhancements
}
