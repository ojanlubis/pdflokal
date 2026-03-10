/*
 * PDFLokal - init.js (ES Module)
 * Main entry point: app bootstrap, browser checks, mobile detection
 *
 * This is the single <script type="module"> entry point.
 * All other modules are loaded via import.
 */

// Shared foundations
import { mobileState } from './lib/state.js';
import { showToast, debounce } from './lib/utils.js';
import { initNavigationHistory } from './lib/navigation.js';

// Feature modules (side-effect imports — set up window bridges on load)
import './theme.js';
import './changelog.js';
import './pdf-tools/index.js';
import './editor/index.js';

// Split-out init modules
import { initDropZone, initFileInputs } from './init-file-handling.js';
import {
  initToolCards, initRangeSliders, initSignaturePad,
  initParafPad, initModalBackdropClose
} from './init-ui.js';

// New modules
import { setupKeyboardShortcuts } from './keyboard.js';

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
  checkBrowserCompatibility();
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
  initParafPad();
  setupKeyboardShortcuts();
  initNavigationHistory();
  initModalBackdropClose();
}

// Modules execute after DOM parsing — readyState is 'interactive' or later
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

// ============================================================
// Window bridges
// ============================================================

window.detectMobile = detectMobile;
