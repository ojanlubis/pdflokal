/**
 * PDFLokal Theme Management (ES Module)
 *
 * ⚠️ TWO OWNERS, ONE RULE EACH, AND THAT SPLIT IS THE WHOLE DESIGN.
 *
 *   css/tokens.css  owns THE SYSTEM DEFAULT. `@media (prefers-color-scheme:
 *                   dark)` on `:root:not([data-theme="light"])`.
 *   this file       owns AN EXPLICIT OVERRIDE, and nothing else.
 *
 * So "no stored choice" is expressed by REMOVING the attribute, never by
 * writing `data-theme="light"`. Writing it would pin the user to light forever
 * and silently ignore every later change to their OS setting — which is exactly
 * what the old `safeLocalGet(THEME_KEY) || 'light'` line did. It defeated the
 * stated reason for wanting dark mode at all: the machine already knows.
 *
 * ⚠️ AND NOTHING IS WRITTEN TO STORAGE ON FIRST VISIT. Persisting the resolved
 * system value on load looks harmless and converts every visitor into someone
 * with an explicit preference they never expressed.
 *
 * ⚠️ NO IMPORTS, DELIBERATELY. This used to import js/lib/utils.js for two
 * localStorage helpers. js/lib/utils.js belongs to the OLD WING and dies at
 * demolition; index.html (v2) could not load this module without dragging the
 * old wing into v2's module graph. The helpers are eight lines and they live
 * here now so this file outlives that.
 */

const THEME_KEY = 'pdflokal_theme'; // 'light' | 'dark' | absent = follow the OS
const THEME_ATTR = 'data-theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

// Private browsing and locked-down storage throw on access, not on write.
function safeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}

function systemPrefersDark() {
  return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches;
}

/** The stored choice, or null when the user has never expressed one. */
function storedChoice() {
  const v = safeGet(THEME_KEY);
  return v === 'light' || v === 'dark' ? v : null;
}

/** What the user actually SEES right now — stored choice, else the OS. */
function getCurrentTheme() {
  return storedChoice() || (systemPrefersDark() ? 'dark' : 'light');
}

/**
 * Apply a choice, or hand control back to the OS when `theme` is null.
 * WHY the null branch removes the attribute rather than setting a value: see
 * the header. `:root:not([data-theme="light"])` in tokens.css is what reads it.
 */
function applyTheme(theme) {
  if (theme === null) document.documentElement.removeAttribute(THEME_ATTR);
  else document.documentElement.setAttribute(THEME_ATTR, theme);
  updateMetaThemeColor();
  updateToggleButton();
}

function setTheme(theme) {
  if (!['light', 'dark'].includes(theme)) {
    console.warn('Invalid theme:', theme);
    return;
  }
  safeSet(THEME_KEY, theme);
  applyTheme(theme);
}

function toggleTheme() {
  setTheme(getCurrentTheme() === 'light' ? 'dark' : 'light');
}

/**
 * WHY this reads the token instead of carrying its own hex: the browser chrome
 * colour and the page ground are the same fact. Two copies of it drift, and the
 * old copy said #1a1a1a while the dark ground is #171717 — close enough that
 * nobody would ever notice the seam, which is what makes it a bad kind of bug.
 */
function updateMetaThemeColor() {
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  meta.content = bg || (getCurrentTheme() === 'dark' ? '#171717' : '#ffffff');
}

function initToggleButton() {
  const toggleCheckbox = document.getElementById('theme-toggle-checkbox');
  if (toggleCheckbox) toggleCheckbox.addEventListener('change', toggleTheme);
}

function updateToggleButton() {
  const toggleCheckbox = document.getElementById('theme-toggle-checkbox');
  const toggleLabel = document.querySelector('.theme-toggle');
  if (!toggleCheckbox) return;

  const current = getCurrentTheme();
  toggleCheckbox.checked = current === 'dark';

  if (toggleLabel) {
    const label = current === 'dark' ? 'Ganti ke mode terang' : 'Ganti ke mode gelap';
    toggleLabel.setAttribute('aria-label', label);
    toggleLabel.setAttribute('title', label);
  }
}

function initTheme() {
  // Re-assert the stored choice (the inline boot snippet in <head> already did
  // this before first paint; this is idempotent and covers pages without it),
  // or hand control back to the OS.
  applyTheme(storedChoice());

  // Follow the OS live — but ONLY while the user has expressed no preference.
  // Re-reading storedChoice() inside the listener matters: the user may choose a
  // theme after this listener is attached, and it must stop overriding them.
  if (typeof window.matchMedia === 'function') {
    window.matchMedia(DARK_QUERY).addEventListener('change', () => {
      if (storedChoice() === null) applyTheme(null);
    });
  }

  initToggleButton();
}

// Public API
export const themeAPI = {
  init: initTheme,
  toggle: toggleTheme,
  set: setTheme,
  get: getCurrentTheme,
  /** Forget the explicit choice and follow the OS again. */
  clear: () => { try { localStorage.removeItem(THEME_KEY); } catch { /* ignore */ } applyTheme(null); },
};

// Window bridge
window.themeAPI = themeAPI;

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initTheme);
} else {
  initTheme();
}
