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
  togglePageSelection,
  renderPdfImgPages,
  selectAllPdfImgPages,
  convertPDFtoImages,
  showPDFPreview,
  compressPDF,
  protectPDF
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

// Standalone tools (PDF-to-Image, Compress, Protect)
import {
  renderPdfImgPages, selectAllPdfImgPages, convertPDFtoImages,
  showPDFPreview, compressPDF, protectPDF
} from './standalone-tools.js';
window.renderPdfImgPages = renderPdfImgPages;
window.selectAllPdfImgPages = selectAllPdfImgPages;
window.convertPDFtoImages = convertPDFtoImages;
window.showPDFPreview = showPDFPreview;
window.compressPDF = compressPDF;
window.protectPDF = protectPDF;
