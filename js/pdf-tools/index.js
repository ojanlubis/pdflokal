/*
 * PDFLokal - pdf-tools/index.js (ES Module Barrel)
 * Re-exports all pdf-tools sub-modules + window bridges for onclick handlers
 */

// Re-export everything
export { enableDragReorder } from './drag-reorder.js';

export {
  openTextModal,
  closeTextModal,
  updateTextPreview,
  getTextModalSettings,
  confirmTextInput
} from './text-modal.js';

export {
  openSignatureModal,
  closeSignatureModal,
  clearSignature,
  useSignature,
  switchSignatureTab,
  loadSignatureImage,
  openSignatureBgModal,
  closeSignatureBgModal,
  updateSignatureBgPreview,
  optimizeSignatureImage,
  useSignatureFromUpload
} from './signature-modal.js';

export {
  openEditorWatermarkModal,
  closeEditorWatermarkModal,
  applyEditorWatermark
} from './watermark-modal.js';

export {
  openEditorPageNumModal,
  closeEditorPageNumModal,
  applyEditorPageNumbers
} from './pagenum-modal.js';

export {
  addMergeFiles,
  refreshMergeList,
  mergePDFs,
  renderSplitPages,
  togglePageSelection,
  selectAllPages,
  deselectAllPages,
  splitPDF,
  renderRotatePages,
  rotateSelected,
  rotateAll,
  saveRotatedPDF,
  renderPagesGrid,
  deletePageFromGrid,
  deleteSelectedPages,
  saveReorderedPDF,
  renderPdfImgPages,
  selectAllPdfImgPages,
  convertPDFtoImages,
  showPDFPreview,
  compressPDF,
  protectPDF,
  initEditMode,
  renderEditPage,
  drawAnnotationSync,
  drawAnnotation,
  drawSelectionHandles,
  setEditTool,
  updateEditorStatus,
  editPrevPage,
  editNextPage,
  saveUndoState,
  undoEdit,
  redoEdit,
  clearCurrentPageAnnotations,
  deleteSelectedAnnotation,
  saveEditedPDF
} from './standalone-tools.js';

// ============================================================
// Window bridges (for HTML onclick handlers and non-module scripts)
// ============================================================

// Drag reorder
import { enableDragReorder } from './drag-reorder.js';
window.enableDragReorder = enableDragReorder;

// Text modal
import { openTextModal, closeTextModal, getTextModalSettings, confirmTextInput } from './text-modal.js';
window.openTextModal = openTextModal;
window.closeTextModal = closeTextModal;
window.getTextModalSettings = getTextModalSettings;
window.confirmTextInput = confirmTextInput;

// Signature modal
import {
  openSignatureModal, closeSignatureModal, clearSignature, useSignature,
  switchSignatureTab, loadSignatureImage, openSignatureBgModal,
  closeSignatureBgModal, updateSignatureBgPreview, optimizeSignatureImage,
  useSignatureFromUpload
} from './signature-modal.js';
window.openSignatureModal = openSignatureModal;
window.closeSignatureModal = closeSignatureModal;
window.clearSignature = clearSignature;
window.useSignature = useSignature;
window.switchSignatureTab = switchSignatureTab;
window.loadSignatureImage = loadSignatureImage;
window.openSignatureBgModal = openSignatureBgModal;
window.closeSignatureBgModal = closeSignatureBgModal;
window.updateSignatureBgPreview = updateSignatureBgPreview;
window.optimizeSignatureImage = optimizeSignatureImage;
window.useSignatureFromUpload = useSignatureFromUpload;

// Watermark modal
import { openEditorWatermarkModal, closeEditorWatermarkModal, applyEditorWatermark } from './watermark-modal.js';
window.openEditorWatermarkModal = openEditorWatermarkModal;
window.closeEditorWatermarkModal = closeEditorWatermarkModal;
window.applyEditorWatermark = applyEditorWatermark;

// Page number modal
import { openEditorPageNumModal, closeEditorPageNumModal, applyEditorPageNumbers } from './pagenum-modal.js';
window.openEditorPageNumModal = openEditorPageNumModal;
window.closeEditorPageNumModal = closeEditorPageNumModal;
window.applyEditorPageNumbers = applyEditorPageNumbers;

// Standalone tools
import {
  addMergeFiles, refreshMergeList, mergePDFs,
  renderSplitPages, togglePageSelection, selectAllPages, deselectAllPages, splitPDF,
  renderRotatePages, rotateSelected, rotateAll, saveRotatedPDF,
  renderPagesGrid, deletePageFromGrid, deleteSelectedPages, saveReorderedPDF,
  renderPdfImgPages, selectAllPdfImgPages, convertPDFtoImages,
  showPDFPreview, compressPDF, protectPDF,
  initEditMode, renderEditPage, setEditTool, updateEditorStatus,
  editPrevPage, editNextPage, saveUndoState, undoEdit, redoEdit,
  clearCurrentPageAnnotations, deleteSelectedAnnotation, saveEditedPDF
} from './standalone-tools.js';
window.addMergeFiles = addMergeFiles;
window.refreshMergeList = refreshMergeList;
window.mergePDFs = mergePDFs;
window.renderSplitPages = renderSplitPages;
window.togglePageSelection = togglePageSelection;
window.selectAllPages = selectAllPages;
window.deselectAllPages = deselectAllPages;
window.splitPDF = splitPDF;
window.renderRotatePages = renderRotatePages;
window.rotateSelected = rotateSelected;
window.rotateAll = rotateAll;
window.saveRotatedPDF = saveRotatedPDF;
window.renderPagesGrid = renderPagesGrid;
window.deletePageFromGrid = deletePageFromGrid;
window.deleteSelectedPages = deleteSelectedPages;
window.saveReorderedPDF = saveReorderedPDF;
window.renderPdfImgPages = renderPdfImgPages;
window.selectAllPdfImgPages = selectAllPdfImgPages;
window.convertPDFtoImages = convertPDFtoImages;
window.showPDFPreview = showPDFPreview;
window.compressPDF = compressPDF;
window.protectPDF = protectPDF;
window.initEditMode = initEditMode;
window.renderEditPage = renderEditPage;
window.setEditTool = setEditTool;
window.updateEditorStatus = updateEditorStatus;
window.editPrevPage = editPrevPage;
window.editNextPage = editNextPage;
window.saveUndoState = saveUndoState;
window.undoEdit = undoEdit;
window.redoEdit = redoEdit;
window.clearCurrentPageAnnotations = clearCurrentPageAnnotations;
window.deleteSelectedAnnotation = deleteSelectedAnnotation;
window.saveEditedPDF = saveEditedPDF;
