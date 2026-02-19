/**
 * PDFLokal Theme Management (ES Module)
 * Handles dark mode toggle and persistence
 */

// Constants
const THEME_KEY = 'pdflokal_theme'; // Values: 'light' or 'dark'
const THEME_ATTR = 'data-theme';

// State
let currentTheme = 'light';

/**
 * Initialize theme system
 */
function initTheme() {
  const savedTheme = localStorage.getItem(THEME_KEY) || 'light';
  applyTheme(savedTheme);
  initToggleButton();
}

function toggleTheme() {
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  setTheme(newTheme);
}

function setTheme(theme) {
  if (!['light', 'dark'].includes(theme)) {
    console.warn('Invalid theme:', theme);
    return;
  }
  localStorage.setItem(THEME_KEY, theme);
  applyTheme(theme);
}

function getCurrentTheme() {
  return currentTheme;
}

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute(THEME_ATTR, theme);
  updateMetaThemeColor(theme);
  updateToggleButton();
}

function updateMetaThemeColor(theme) {
  let metaThemeColor = document.querySelector('meta[name="theme-color"]');

  if (!metaThemeColor) {
    metaThemeColor = document.createElement('meta');
    metaThemeColor.name = 'theme-color';
    document.head.appendChild(metaThemeColor);
  }

  metaThemeColor.content = theme === 'dark' ? '#1a1a1a' : '#ffffff';
}

function initToggleButton() {
  const toggleCheckbox = document.getElementById('theme-toggle-checkbox');
  if (toggleCheckbox) {
    toggleCheckbox.addEventListener('change', toggleTheme);
  }
}

function updateToggleButton() {
  const toggleCheckbox = document.getElementById('theme-toggle-checkbox');
  const toggleLabel = document.querySelector('.theme-toggle');

  if (!toggleCheckbox) return;

  toggleCheckbox.checked = currentTheme === 'dark';

  if (toggleLabel) {
    const label = currentTheme === 'dark' ? 'Ganti ke mode terang' : 'Ganti ke mode gelap';
    toggleLabel.setAttribute('aria-label', label);
    toggleLabel.setAttribute('title', label);
  }
}

// Public API
export const themeAPI = {
  init: initTheme,
  toggle: toggleTheme,
  set: setTheme,
  get: getCurrentTheme
};

// Window bridge
window.themeAPI = themeAPI;

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initTheme);
} else {
  initTheme();
}
