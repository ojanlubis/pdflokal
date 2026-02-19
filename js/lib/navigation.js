/*
 * ============================================================
 * PDFLokal - js/lib/navigation.js
 * Navigation & History Management
 * ============================================================
 *
 * Handles workspace switching, browser back button, modals,
 * and workspace drop zones.
 *
 * IMPORTS: state, navHistory, mobileState from ./state.js
 *          showToast, cleanupImage from ./utils.js
 *
 * NOTE: Calls to unified-editor functions (initUnifiedEditor,
 *       ueReset, uePmCloseModal) go through window.* since
 *       unified-editor.js is still a global script in Phase 1.
 *
 * LOAD ORDER: After state.js and utils.js
 * ============================================================
 */

import { state, navHistory, mobileState } from './state.js';
import { showToast, showFullscreenLoading, hideFullscreenLoading, cleanupImage } from './utils.js';

// ============================================================
// HISTORY STATE MANAGEMENT
// ============================================================

// Push state when entering workspace
export function pushWorkspaceState(tool) {
  history.pushState({ view: 'workspace', tool }, '', `#${tool}`);
  navHistory.currentView = 'workspace';
  navHistory.currentWorkspace = tool;
  navHistory.currentModal = null;
}

// Push state when opening modal
export function pushModalState(modalId) {
  history.pushState({
    view: 'modal',
    modal: modalId,
    tool: navHistory.currentWorkspace
  }, '', null);
  navHistory.currentView = 'modal';
  navHistory.currentModal = modalId;
}

// Close all modals
export function closeAllModals() {
  // Close signature modal
  const sigModal = document.getElementById('signature-modal');
  if (sigModal?.classList.contains('active')) {
    sigModal.classList.remove('active');
  }

  // Close signature background modal
  const sigBgModal = document.getElementById('signature-bg-modal');
  if (sigBgModal?.classList.contains('active')) {
    sigBgModal.classList.remove('active');
  }

  // Close text modal
  const textModal = document.getElementById('text-input-modal');
  if (textModal?.classList.contains('active')) {
    textModal.classList.remove('active');
  }

  // Close page manager modal
  const pmModal = document.getElementById('ue-gabungkan-modal');
  if (pmModal?.classList.contains('active')) {
    if (typeof window.uePmCloseModal === 'function') {
      window.uePmCloseModal(true); // true = skip history manipulation
    }
  }

  // Close watermark modal
  const wmModal = document.getElementById('editor-watermark-modal');
  if (wmModal?.classList.contains('active')) {
    wmModal.classList.remove('active');
  }

  // Close page number modal
  const pnModal = document.getElementById('editor-pagenum-modal');
  if (pnModal?.classList.contains('active')) {
    pnModal.classList.remove('active');
  }

  // Close protect modal
  const protectModal = document.getElementById('editor-protect-modal');
  if (protectModal?.classList.contains('active')) {
    protectModal.classList.remove('active');
  }

  navHistory.currentModal = null;
}

// ============================================================
// NAVIGATION
// ============================================================

// Navigate back to homepage
export function showHome(skipPushState = false) {
  document.getElementById('home-view').style.display = 'block';
  document.querySelectorAll('.workspace').forEach(ws => ws.classList.remove('active'));
  closeAllModals();
  state.currentTool = null;
  resetState();

  // Restore changelog badge when returning to home
  if (window.changelogAPI) {
    window.changelogAPI.restore();
  }

  // Update navigation history
  if (!skipPushState) {
    history.pushState({ view: 'home' }, '', '#');
  }
  navHistory.currentView = 'home';
  navHistory.currentWorkspace = null;
  navHistory.currentModal = null;
}

// Navigate to a workspace
export function showTool(tool, skipPushState = false) {
  // Hide changelog when leaving home-view
  if (window.changelogAPI) {
    window.changelogAPI.hide();
  }

  document.getElementById('home-view').style.display = 'none';
  document.querySelectorAll('.workspace').forEach(ws => ws.classList.remove('active'));

  const workspace = document.getElementById(`${tool}-workspace`);
  if (workspace) {
    workspace.classList.add('active');
    state.currentTool = tool;

    // Scroll to top when opening workspace
    window.scrollTo(0, 0);

    // Push browser history state
    if (!skipPushState) {
      pushWorkspaceState(tool);
    }

    // Setup drop zones for workspaces
    setupWorkspaceDropZone(tool);

    // Initialize unified editor when opened
    if (tool === 'unified-editor') {
      if (typeof window.initUnifiedEditor === 'function') {
        window.initUnifiedEditor();
      }

      // Initialize mobile enhancements
      if (mobileState.isMobile || mobileState.isTouch) {
        setTimeout(() => {
          if (typeof window.initMobileEditorEnhancements === 'function') {
            window.initMobileEditorEnhancements();
          }
          if (typeof window.ueMobileUpdatePageIndicator === 'function') {
            window.ueMobileUpdatePageIndicator();
          }
        }, 100);
      }
    }
  }
}

// ============================================================
// WORKSPACE DROP ZONES
// ============================================================

export function setupWorkspaceDropZone(tool) {
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

  workspace.addEventListener('drop', async (e) => {
    e.preventDefault();
    const files = e.dataTransfer.files;

    if (files.length === 0) return;

    // Determine loading message based on file type
    const isPDF = files[0].type === 'application/pdf';
    const loadingMessage = isPDF ? 'Memuat PDF...' : 'Memuat gambar...';

    showFullscreenLoading(loadingMessage);
    try {
      if (tool === 'merge') {
        await window.addMergeFiles(files);
      } else if (tool === 'img-to-pdf') {
        await window.addImagesToPDF(files);
      } else if (files.length === 1) {
        const file = files[0];
        if (file.type === 'application/pdf') {
          await window.loadPDFForTool(file, tool);
        } else if (file.type.startsWith('image/')) {
          await window.loadImageForTool(file, tool);
        }
      }
    } catch (error) {
      console.error('Error handling dropped files:', error);
      showToast('Gagal memuat file', 'error');
    } finally {
      hideFullscreenLoading();
    }
  });
}

// ============================================================
// STATE RESET
// ============================================================

export function resetState() {
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
  state.editCanvasSetup = false;

  // Reset Page Manager state
  state.pmPages = [];
  state.pmSourceFiles = [];

  // Reset Unified Editor state
  if (typeof window.ueReset === 'function') {
    window.ueReset();
  }
}

// ============================================================
// BROWSER BACK BUTTON
// ============================================================

export function initNavigationHistory() {
  // Set initial state
  history.replaceState({ view: 'home' }, '', window.location.pathname);

  window.addEventListener('popstate', (event) => {
    if (event.state) {
      if (event.state.view === 'workspace') {
        // Close any open modal, stay in workspace
        closeAllModals();
        navHistory.currentView = 'workspace';
        navHistory.currentModal = null;
      } else if (event.state.view === 'home') {
        // Go back to home
        closeAllModals();
        showHome(true); // true = skip pushState
      }
    } else {
      // No state = we're at home or initial load
      closeAllModals();
      showHome(true);
    }
  });
}

// ============================================================
// WINDOW BRIDGE (for non-module scripts and onclick handlers)
// ============================================================

window.pushWorkspaceState = pushWorkspaceState;
window.pushModalState = pushModalState;
window.closeAllModals = closeAllModals;
window.showHome = showHome;
window.showTool = showTool;
window.setupWorkspaceDropZone = setupWorkspaceDropZone;
window.resetState = resetState;
window.initNavigationHistory = initNavigationHistory;
