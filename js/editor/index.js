/*
 * PDFLokal - editor/index.js (ES Module Barrel)
 * Re-exports all editor sub-modules + window bridges for onclick handlers
 */

// Re-export everything
export { ueGetCurrentCanvas, ueGetCoords, ueGetResizeHandle, getTextBounds } from './canvas-utils.js';

export {
  ueRedrawAnnotations, ueRedrawPageAnnotations,
  ueDrawAnnotation, ueDrawSelectionHandles, ueFindAnnotationAt
} from './annotations.js';

export {
  ueSaveUndoState, ueUndo, ueRedo,
  ueSaveEditUndoState, ueUndoAnnotation, ueRedoAnnotation,
  ueClearPageAnnotations
} from './undo-redo.js';

export {
  ueZoomIn, ueZoomOut, ueZoomReset,
  ueRotateCurrentPage, ueUpdateZoomDisplay
} from './zoom-rotate.js';

export {
  uePlaceSignature, ueDrawSignaturePreview,
  ueShowConfirmButton, ueUpdateConfirmButtonPosition, ueHideConfirmButton,
  ueConfirmSignature, ueDeleteSignature, ueUpdateDownloadButtonState
} from './signatures.js';

export {
  ueCreatePageSlots, ueSetWrapperHeight, ueHighlightThumbnail,
  ueSelectPage, ueRenderPageCanvas, ueRenderVisiblePages, ueRenderSelectedPage,
  ueSetupIntersectionObserver, ueSetupScrollSync,
  ueDeletePage, ueUpdatePageCount, ueUpdateStatus
} from './page-rendering.js';

export { ueRenderThumbnails, toggleSidebarFileMenu, closeSidebarFileMenu, ueReplaceFiles } from './sidebar.js';

export { initUnifiedEditorInput, ueAddFiles } from './file-loading.js';

export { ueSetupCanvasEvents } from './canvas-events.js';

export {
  ueSetTool, ueOpenSignatureModal, ueOpenTextModal, ueConfirmText,
  ueOpenWatermarkModal, ueOpenPageNumModal,
  toggleMoreTools, closeMoreTools,
  ueOpenProtectModal, closeEditorProtectModal, applyEditorProtect
} from './tools.js';

export { ueBuildFinalPDF, ueDownload } from './pdf-export.js';

export {
  uePmOpenModal, uePmCloseModal, uePmRenderPages,
  uePmReindexAnnotations,
  uePmToggleExtractMode, uePmTogglePageSelection,
  uePmSelectAll, uePmDeselectAll, uePmExtractSelected
} from './page-manager.js';

export {
  ueReset, ueShowSignatureHint, ueDismissSignatureHint,
  initUnifiedEditor
} from './lifecycle.js';

// ============================================================
// Window bridges
// ============================================================
// index.html has ~88 inline onclick="fn()" handlers that need global access.
// These assignments make every editor function available on window.*.
// They also provide the global names that other modules reference via window.*
// to break circular import chains (see comments in individual modules).

// Canvas utils
import { ueGetCurrentCanvas, ueGetCoords, ueGetResizeHandle, getTextBounds } from './canvas-utils.js';
window.ueGetCurrentCanvas = ueGetCurrentCanvas;
window.ueGetCoords = ueGetCoords;
window.ueGetResizeHandle = ueGetResizeHandle;
window.getTextBounds = getTextBounds;

// Annotations
import { ueRedrawAnnotations, ueRedrawPageAnnotations, ueDrawAnnotation, ueDrawSelectionHandles, ueFindAnnotationAt } from './annotations.js';
window.ueRedrawAnnotations = ueRedrawAnnotations;
window.ueRedrawPageAnnotations = ueRedrawPageAnnotations;
window.ueDrawAnnotation = ueDrawAnnotation;
window.ueDrawSelectionHandles = ueDrawSelectionHandles;
window.ueFindAnnotationAt = ueFindAnnotationAt;

// Undo/Redo
import { ueSaveUndoState, ueUndo, ueRedo, ueSaveEditUndoState, ueUndoAnnotation, ueRedoAnnotation, ueClearPageAnnotations } from './undo-redo.js';
window.ueSaveUndoState = ueSaveUndoState;
window.ueUndo = ueUndo;
window.ueRedo = ueRedo;
window.ueSaveEditUndoState = ueSaveEditUndoState;
window.ueUndoAnnotation = ueUndoAnnotation;
window.ueRedoAnnotation = ueRedoAnnotation;
window.ueClearPageAnnotations = ueClearPageAnnotations;

// Zoom & Rotate
import { ueZoomIn, ueZoomOut, ueZoomReset, ueRotateCurrentPage, ueUpdateZoomDisplay } from './zoom-rotate.js';
window.ueZoomIn = ueZoomIn;
window.ueZoomOut = ueZoomOut;
window.ueZoomReset = ueZoomReset;
window.ueRotateCurrentPage = ueRotateCurrentPage;
window.ueUpdateZoomDisplay = ueUpdateZoomDisplay;

// Signatures
import { uePlaceSignature, ueDrawSignaturePreview, ueShowConfirmButton, ueUpdateConfirmButtonPosition, ueHideConfirmButton, ueConfirmSignature, ueDeleteSignature, ueUpdateDownloadButtonState } from './signatures.js';
window.uePlaceSignature = uePlaceSignature;
window.ueDrawSignaturePreview = ueDrawSignaturePreview;
window.ueShowConfirmButton = ueShowConfirmButton;
window.ueUpdateConfirmButtonPosition = ueUpdateConfirmButtonPosition;
window.ueHideConfirmButton = ueHideConfirmButton;
window.ueConfirmSignature = ueConfirmSignature;
window.ueDeleteSignature = ueDeleteSignature;
window.ueUpdateDownloadButtonState = ueUpdateDownloadButtonState;

// Page rendering
import { ueCreatePageSlots, ueSetWrapperHeight, ueHighlightThumbnail, ueSelectPage, ueRenderPageCanvas, ueRenderVisiblePages, ueRenderSelectedPage, ueSetupIntersectionObserver, ueSetupScrollSync, ueDeletePage, ueUpdatePageCount, ueUpdateStatus } from './page-rendering.js';
window.ueCreatePageSlots = ueCreatePageSlots;
window.ueSetWrapperHeight = ueSetWrapperHeight;
window.ueHighlightThumbnail = ueHighlightThumbnail;
window.ueSelectPage = ueSelectPage;
window.ueRenderPageCanvas = ueRenderPageCanvas;
window.ueRenderVisiblePages = ueRenderVisiblePages;
window.ueRenderSelectedPage = ueRenderSelectedPage;
window.ueSetupIntersectionObserver = ueSetupIntersectionObserver;
window.ueSetupScrollSync = ueSetupScrollSync;
window.ueDeletePage = ueDeletePage;
window.ueUpdatePageCount = ueUpdatePageCount;
window.ueUpdateStatus = ueUpdateStatus;

// Sidebar
import { ueRenderThumbnails, toggleSidebarFileMenu, closeSidebarFileMenu, ueReplaceFiles } from './sidebar.js';
window.ueRenderThumbnails = ueRenderThumbnails;
window.toggleSidebarFileMenu = toggleSidebarFileMenu;
window.closeSidebarFileMenu = closeSidebarFileMenu;
window.ueReplaceFiles = ueReplaceFiles;

// File loading
import { initUnifiedEditorInput, ueAddFiles } from './file-loading.js';
window.initUnifiedEditorInput = initUnifiedEditorInput;
window.ueAddFiles = ueAddFiles;

// Canvas events
import { ueSetupCanvasEvents } from './canvas-events.js';
window.ueSetupCanvasEvents = ueSetupCanvasEvents;

// Tools
import { ueSetTool, ueOpenSignatureModal, ueOpenTextModal, ueConfirmText, ueOpenWatermarkModal, ueOpenPageNumModal, toggleMoreTools, closeMoreTools, ueOpenProtectModal, closeEditorProtectModal, applyEditorProtect } from './tools.js';
window.ueSetTool = ueSetTool;
window.ueOpenSignatureModal = ueOpenSignatureModal;
window.ueOpenTextModal = ueOpenTextModal;
window.ueConfirmText = ueConfirmText;
window.ueOpenWatermarkModal = ueOpenWatermarkModal;
window.ueOpenPageNumModal = ueOpenPageNumModal;
window.toggleMoreTools = toggleMoreTools;
window.closeMoreTools = closeMoreTools;
window.ueOpenProtectModal = ueOpenProtectModal;
window.closeEditorProtectModal = closeEditorProtectModal;
window.applyEditorProtect = applyEditorProtect;

// PDF export
import { ueBuildFinalPDF, ueDownload } from './pdf-export.js';
window.ueBuildFinalPDF = ueBuildFinalPDF;
window.ueDownload = ueDownload;

// Page manager
import { uePmOpenModal, uePmCloseModal, uePmRenderPages, uePmReindexAnnotations, uePmToggleExtractMode, uePmTogglePageSelection, uePmSelectAll, uePmDeselectAll, uePmExtractSelected } from './page-manager.js';
window.uePmOpenModal = uePmOpenModal;
window.uePmCloseModal = uePmCloseModal;
window.uePmRenderPages = uePmRenderPages;
window.uePmReindexAnnotations = uePmReindexAnnotations;
window.uePmToggleExtractMode = uePmToggleExtractMode;
window.uePmTogglePageSelection = uePmTogglePageSelection;
window.uePmSelectAll = uePmSelectAll;
window.uePmDeselectAll = uePmDeselectAll;
window.uePmExtractSelected = uePmExtractSelected;

// Lifecycle
import { ueReset, ueShowSignatureHint, ueDismissSignatureHint, initUnifiedEditor } from './lifecycle.js';
window.ueReset = ueReset;
window.ueShowSignatureHint = ueShowSignatureHint;
window.ueDismissSignatureHint = ueDismissSignatureHint;
window.initUnifiedEditor = initUnifiedEditor;
