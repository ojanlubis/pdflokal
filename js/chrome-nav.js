/**
 * PDFLokal — mobile burger nav for privasi.html and dukung.html.
 *
 * Ported from js/v2/app.js's landing burger (the block wiring #ld-burger /
 * #ld-burger-menu there). index.html is locked while another session edits
 * it, and js/v2/app.js is a large editor module these two static pages have
 * no business importing — so this is the same ~25 lines, factored into its
 * own tiny module rather than duplicated once per page (CLAUDE.md: "one
 * rule, one home"). No imports, same style as js/theme.js.
 *
 * The language control (.ld-lang) needs no JS: it's a native <details>, and
 * it is a placeholder that must not persist or change anything — see
 * css/chrome.css and specs/design-system.md for why.
 */
const burgerBtn = document.getElementById('ld-burger');
const burgerMenu = document.getElementById('ld-burger-menu');

if (burgerBtn && burgerMenu) {
  const closeBurger = () => {
    burgerMenu.hidden = true;
    burgerBtn.setAttribute('aria-expanded', 'false');
  };
  const openBurger = () => {
    burgerMenu.hidden = false;
    burgerBtn.setAttribute('aria-expanded', 'true');
  };
  burgerBtn.addEventListener('click', () => {
    if (burgerMenu.hidden) openBurger(); else closeBurger();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !burgerMenu.hidden) {
      closeBurger();
      burgerBtn.focus();
    }
  });
  // Click outside the open drawer (and not on the button that opened it) closes it.
  document.addEventListener('click', (e) => {
    if (burgerMenu.hidden) return;
    if (burgerMenu.contains(e.target) || burgerBtn.contains(e.target)) return;
    closeBurger();
  });
}
