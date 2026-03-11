/*
 * PDFLokal - mobile-ui.js (ES Module)
 * Mobile navigation, page picker, and mobile editor UI
 */

import { ueState, mobileState } from './lib/state.js';

// WHY: Editor functions accessed via window.* bridges (set by editor/index.js)
// instead of static import. Static import pulled in 15 editor sub-modules and blocked
// homepage from being interactive. These functions are only called when the editor is
// active, so window bridges are guaranteed set by then.

// ============================================================
// MOBILE PAGE NAVIGATION
// ============================================================

export function ueMobilePrevPage() {
  if (ueState.selectedPage > 0) {
    window.ueSelectPage(ueState.selectedPage - 1);
    ueMobileUpdatePageIndicator();

    if (mobileState.isTouch && navigator.vibrate) {
      navigator.vibrate(10);
    }
  }
}

export function ueMobileNextPage() {
  if (ueState.selectedPage < ueState.pages.length - 1) {
    window.ueSelectPage(ueState.selectedPage + 1);
    ueMobileUpdatePageIndicator();

    if (mobileState.isTouch && navigator.vibrate) {
      navigator.vibrate(10);
    }
  }
}

export function ueMobileUpdatePageIndicator() {
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

// ============================================================
// MOBILE PAGE PICKER
// ============================================================

export function ueMobileOpenPagePicker() {
  const picker = document.getElementById('ue-mobile-page-picker');
  const grid = document.getElementById('ue-mobile-page-grid');

  if (!picker || !grid || ueState.pages.length === 0) return;

  grid.innerHTML = '';
  ueState.pages.forEach((page, index) => {
    const thumb = document.createElement('div');
    thumb.className = 'mobile-page-thumb' + (index === ueState.selectedPage ? ' selected' : '');
    thumb.setAttribute('role', 'button');
    thumb.setAttribute('tabindex', '0');
    thumb.setAttribute('aria-label', `Halaman ${index + 1}`);

    const selectThisPage = () => {
      window.ueSelectPage(index);
      ueMobileUpdatePageIndicator();
      ueMobileClosePagePicker();

      if (mobileState.isTouch && navigator.vibrate) {
        navigator.vibrate(10);
      }
    };
    thumb.onclick = selectThisPage;
    // WHY: div[role="button"] needs explicit keydown for Enter/Space activation.
    thumb.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectThisPage();
      }
    });

    if (page.canvas) {
      const sourceCanvas = window.getThumbnailSource(index);
      const thumbCanvas = document.createElement('canvas');
      const scale = 0.3;
      const refWidth = sourceCanvas ? sourceCanvas.width : page.canvas.width;
      const refHeight = sourceCanvas ? sourceCanvas.height : page.canvas.height;
      thumbCanvas.width = refWidth * scale;
      thumbCanvas.height = refHeight * scale;
      if (sourceCanvas) {
        thumbCanvas.getContext('2d').drawImage(sourceCanvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
      }
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

export function ueMobileClosePagePicker() {
  const picker = document.getElementById('ue-mobile-page-picker');
  if (picker) {
    picker.classList.remove('active');
  }
  document.body.style.overflow = '';
}

// ============================================================
// MOBILE TOOLS DROPDOWN
// ============================================================

export function toggleMobileTools() {
  const dropdown = document.getElementById('mobile-tools-dropdown');
  if (dropdown) {
    dropdown.classList.toggle('active');
  }
}

export function closeMobileTools() {
  const dropdown = document.getElementById('mobile-tools-dropdown');
  if (dropdown) {
    dropdown.classList.remove('active');
  }
}

export function ueMobileUpdateSignButton() {
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

  if (dropdown?.classList.contains('active')) {
    if (!dropdown.contains(e.target) && e.target !== moreBtn && !moreBtn.contains(e.target)) {
      closeMobileTools();
    }
  }
});

// ============================================================
// MOBILE EDITOR ENHANCEMENTS
// ============================================================

// Called by navigation.js (showTool) and init.js when the editor opens.
// WHY: Hook point for mobile-specific setup. No-op for now, but callers
// already reference it — removing would break the interface contract.
export function initMobileEditorEnhancements() {
  // Intentionally empty — future mobile enhancements go here
}

// ============================================================
// Window bridges (for HTML onclick handlers and cross-module calls)
// ============================================================

window.ueMobilePrevPage = ueMobilePrevPage;
window.ueMobileNextPage = ueMobileNextPage;
window.ueMobileUpdatePageIndicator = ueMobileUpdatePageIndicator;
window.ueMobileOpenPagePicker = ueMobileOpenPagePicker;
window.ueMobileClosePagePicker = ueMobileClosePagePicker;
window.toggleMobileTools = toggleMobileTools;
window.closeMobileTools = closeMobileTools;
window.ueMobileUpdateSignButton = ueMobileUpdateSignButton;
window.initMobileEditorEnhancements = initMobileEditorEnhancements;
