/**
 * PDFLokal Theme Management
 * Handles dark mode toggle and persistence
 */

(function() {
  'use strict';

  // Constants
  const THEME_KEY = 'pdflokal_theme'; // Values: 'light' or 'dark'
  const THEME_ATTR = 'data-theme';

  // State
  let currentTheme = 'light';

  // Public API (matches existing pattern from changelog.js)
  window.themeAPI = {
    init: initTheme,
    toggle: toggleTheme,
    set: setTheme,
    get: getCurrentTheme
  };

  /**
   * Initialize theme system
   * Called from app.js initApp() function
   */
  function initTheme() {
    // Load saved preference or default to 'light'
    const savedTheme = localStorage.getItem(THEME_KEY) || 'light';

    // Apply theme
    applyTheme(savedTheme);

    // Initialize toggle button
    initToggleButton();
  }

  /**
   * Toggle between light and dark
   */
  function toggleTheme() {
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
  }

  /**
   * Set theme preference
   * @param {string} theme - 'light' or 'dark'
   */
  function setTheme(theme) {
    if (!['light', 'dark'].includes(theme)) {
      console.warn('Invalid theme:', theme);
      return;
    }

    // Save to localStorage
    localStorage.setItem(THEME_KEY, theme);

    // Apply theme
    applyTheme(theme);
  }

  /**
   * Get current applied theme
   * @returns {string} 'light' or 'dark'
   */
  function getCurrentTheme() {
    return currentTheme;
  }

  /**
   * Apply theme to DOM
   * @param {string} theme - 'light' or 'dark'
   */
  function applyTheme(theme) {
    currentTheme = theme;

    // Update HTML data attribute
    document.documentElement.setAttribute(THEME_ATTR, theme);

    // Update meta theme-color for mobile browsers
    updateMetaThemeColor(theme);

    // Update toggle button icon
    updateToggleButton();
  }

  /**
   * Update mobile browser theme color
   * @param {string} theme
   */
  function updateMetaThemeColor(theme) {
    let metaThemeColor = document.querySelector('meta[name="theme-color"]');

    if (!metaThemeColor) {
      metaThemeColor = document.createElement('meta');
      metaThemeColor.name = 'theme-color';
      document.head.appendChild(metaThemeColor);
    }

    // Set color based on theme (matches header background)
    metaThemeColor.content = theme === 'dark' ? '#1a1a1a' : '#ffffff';
  }

  /**
   * Initialize toggle checkbox event listener
   */
  function initToggleButton() {
    const toggleCheckbox = document.getElementById('theme-toggle-checkbox');
    if (toggleCheckbox) {
      toggleCheckbox.addEventListener('change', toggleTheme);
    }
  }

  /**
   * Update toggle checkbox state and aria-label
   */
  function updateToggleButton() {
    const toggleCheckbox = document.getElementById('theme-toggle-checkbox');
    const toggleLabel = document.querySelector('.theme-toggle');

    if (!toggleCheckbox) return;

    // Update checkbox checked state
    toggleCheckbox.checked = currentTheme === 'dark';

    // Update aria-label for accessibility
    if (toggleLabel) {
      const label = currentTheme === 'dark' ? 'Ganti ke mode terang' : 'Ganti ke mode gelap';
      toggleLabel.setAttribute('aria-label', label);
      toggleLabel.setAttribute('title', label);
    }
  }

  // Initialize when DOM is ready (matches app.js pattern)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTheme);
  } else {
    initTheme();
  }
})();
