/*
 * PDFLokal - init.js (ES Module)
 * Main entry point: app bootstrap, browser checks, mobile detection
 *
 * This is the single <script type="module"> entry point.
 * All other modules are loaded via import.
 */

// Shared foundations
import { mobileState } from './lib/state.js';
import { showToast } from './lib/utils.js';
import { initNavigationHistory } from './lib/navigation.js';

// Feature modules (side-effect imports — set up window bridges on load)
import './theme.js';
import './changelog.js';

// WHY: Dynamic import so homepage (dropzone, tool cards) is interactive immediately.
// Editor + pdf-tools are ~260KB across 22 sub-modules. Static import blocks ALL code
// until every module is fetched + parsed. Dynamic import loads them in background;
// window bridges are ready well before user opens the editor.
import('./editor/index.js');
import('./pdf-tools/index.js');
import('./mobile-ui.js');
import('./image-tools.js');

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

// WHY: Only detect touch capability — it doesn't change after init.
// Layout decisions use CSS @media (max-width: 900px) as single source of truth.
// Previous approach used JS width check at 768px which mismatched CSS at 900px,
// causing unreliable behavior in the 768-900px range (tablet dead zone).
function detectMobile() {
  mobileState.isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  document.body.classList.toggle('is-touch', mobileState.isTouch);

  // Update dropzone text for touch devices
  const dropzoneText = document.querySelector('#main-dropzone h3');
  if (dropzoneText) {
    dropzoneText.textContent = mobileState.isTouch
      ? 'Ketuk untuk pilih file'
      : 'Seret file ke sini atau klik untuk pilih';
  }
}

// ============================================================
// INITIALIZATION
// ============================================================

function initApp() {
  checkBrowserCompatibility();
  detectMobile();

  // WHY: No resize/orientation listeners needed for detectMobile — isTouch
  // capability doesn't change. Layout adapts via CSS @media queries.

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
