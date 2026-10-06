/*
 * PDFLokal — v2/page-strip.js  (the per-page control strip in the main stage)
 * ============================================================================
 * A slim bar above EACH page: "Halaman 3" on the left; move up, move down,
 * rotate, delete on the right. The Halaman sheet's jobs, at the page itself.
 *
 * It is NOT a second implementation: every button calls the page manager's own
 * movePage / rotatePages / deletePages (page-manager.js), so a click here and the
 * same act in the sheet are one function — one undo step, the same core op, the
 * same telemetry name, the same thumbnail invalidation, the same toast.
 *
 * WHERE IT LIVES: the strip is a SIBLING of the .pv-page view, inside a
 * .pv-slot wrapper — never inside the view. interaction.js hit-tests with
 * closest('.pv-page'), so a press on the strip is invisible to it (no
 * deselect, no placement); page coordinates are measured off the view, so the
 * strip cannot shift them; export reads the model, never the DOM.
 *
 * WHY THE SIZE IS DIVIDED BY THE ZOOM (index.html, .pv-strip): the stage is one
 * CSS transform: scale(zoom), so a 44px button would render at 29px on a phone
 * (zoom ~0.66) and 105px on a laptop (2.38). The strip's lengths are written in
 * units of --u = 1px / zoom, so it LAYS OUT at size/zoom and RENDERS at the same
 * size at every zoom, while its width stays the page's own layout width and so
 * follows the rendered page exactly. app.js publishes --zoom on the stage.
 * The cost: the stage is no longer linear in zoom (the strips add a constant
 * on-screen height), which app.js's setZoomAnchored accounts for.
 */
import { t as tr } from '../lib/i18n.js';
import { setUnavailable } from './page-manager.js';
import { pageDisplaySize } from '../render/page-view.js';

// Same icon family as the toolbar (Feather/Lucide, 24 viewBox, 2px round stroke).
// Chevrons and trash are the toolbar's own paths; the toolbar has no rotate, so
// that one is the family's rotate-cw.
const ICONS = {
  up: '<polyline points="18 15 12 9 6 15"/>',
  down: '<polyline points="6 9 12 15 18 9"/>',
  rotate: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  delete: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
};

// act -> locale key. Literal keys, so tests/core/i18n.test.mjs can see them.
const LABEL = {
  up: () => tr('pm.moveUp'),
  down: () => tr('pm.moveDown'),
  rotate: () => tr('pm.rotate'),
  delete: () => tr('pm.delete'),
};

function iconButton(act) {
  const b = document.createElement('button');
  b.type = 'button';
  // data-strip-act, NOT data-act: the Halaman bulk bar owns [data-act="rotate"] / "delete"
  // and a dozen specs (and the page manager's own handler) select by that name.
  b.dataset.stripAct = act;
  const label = LABEL[act]();
  b.setAttribute('aria-label', label);
  b.title = label;
  // Static strings only (ICONS above) — no document-derived text reaches innerHTML.
  b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[act]}</svg>`;
  return b;
}

// deps = { stage, scrollEl, getDoc, pageManager }
export function createPageStrips(deps) {
  const { stage, scrollEl, pageManager } = deps;

  // The strip for a page, as built for position `index` of `total`.
  function buildStrip(page, index, total) {
    const strip = document.createElement('div');
    strip.className = 'pv-strip';
    // NOT data-page-id: that attribute means "the page view" to every query that
    // looks one up (tests, page-manager). This one names the strip.
    strip.dataset.stripFor = page.id;
    strip.setAttribute('role', 'group');
    strip.setAttribute('aria-label', tr('pm.page', { n: index + 1 }));

    const label = document.createElement('span');
    label.className = 'pv-strip-label';
    label.textContent = tr('pm.page', { n: index + 1 });
    strip.appendChild(label);

    const btns = document.createElement('span');
    btns.className = 'pv-strip-btns';
    for (const act of ['up', 'down', 'rotate', 'delete']) btns.appendChild(iconButton(act));
    strip.appendChild(btns);

    // Unavailable, not absent (same convention as the Halaman bulk bar).
    setUnavailable(btns.querySelector('[data-strip-act="up"]'), index === 0);
    setUnavailable(btns.querySelector('[data-strip-act="down"]'), index === total - 1);
    setUnavailable(btns.querySelector('[data-strip-act="delete"]'), total <= 1);
    return strip;
  }

  // The page view wrapped with its strip. The wrapper is exactly as wide as the
  // page, so the strip (width:100%) follows the page's width at every zoom.
  function wrap(view, page, index, total) {
    const slot = document.createElement('div');
    slot.className = 'pv-slot';
    slot.style.width = `${pageDisplaySize(page).width}px`;
    slot.appendChild(buildStrip(page, index, total));
    slot.appendChild(view);
    return slot;
  }

  // Matched by comparison, not interpolated into a selector (ids are ours, but
  // a selector built from data is a bug waiting for the day an id has a quote).
  const stripOf = (id) => [...stage.querySelectorAll('.pv-strip')].find((el) => el.dataset.stripFor === id) || null;

  stage.addEventListener('click', (e) => {
    const btn = e.target.closest?.('.pv-strip [data-strip-act]');
    if (!btn) return;
    // aria-disabled buttons still receive click / Enter / Space: they do nothing.
    if (btn.getAttribute('aria-disabled') === 'true') return;
    const id = btn.closest('.pv-strip').dataset.stripFor;
    const act = btn.dataset.stripAct;
    const doc = deps.getDoc();
    const index = doc.pages.findIndex((p) => p.id === id);
    if (index === -1) return;

    const hadFocus = document.activeElement === btn;
    // Keep the acted-on page where the user's eye is: remember its strip's
    // viewport position, restore it after the rebuild (so ↑ can be clicked
    // repeatedly on a page that is moving through the document).
    const before = stripOf(id)?.getBoundingClientRect().top;

    let done = false;
    if (act === 'up') done = pageManager.movePage(id, index - 1);
    else if (act === 'down') done = pageManager.movePage(id, index + 1);
    else if (act === 'rotate') done = pageManager.rotatePages([id]);
    else if (act === 'delete') done = pageManager.deletePages([id]);
    if (!done) return;

    if (act === 'delete') {
      // The page is gone: hand focus to the SAFE button (rotate) of whichever page
      // now sits at that position, never to another delete (Enter held down
      // would eat the document).
      if (hadFocus) {
        const next = deps.getDoc().pages[Math.min(index, deps.getDoc().pages.length - 1)];
        const el = next && stripOf(next.id)?.querySelector('[data-strip-act="rotate"]');
        el?.focus({ preventScroll: true });
      }
      return;
    }
    const after = stripOf(id);
    if (!after) return;
    if (before !== undefined) scrollEl.scrollTop += after.getBoundingClientRect().top - before;
    if (hadFocus) after.querySelector(`[data-strip-act="${act}"]`)?.focus({ preventScroll: true });
  });

  return { wrap };
}
