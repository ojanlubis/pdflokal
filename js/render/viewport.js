/*
 * PDFLokal — render/viewport.js  (RENDER LAYER — streaming window)
 * ============================================================================
 * The GTA-maps streaming engine, extracted from the lab harness after it was
 * validated on a real Android (Jul 2026). Owns WHEN pages rasterize/release;
 * owns nothing about HOW they look (page-view.js) or WHAT they mean (core/).
 *
 * The three locked behaviors (memory/render-architecture-2026-07.md):
 *   1. STREAM — rasterize only pages within `loadScreens` of the viewport,
 *      release beyond `keepScreens`. Memory stays bounded on ANY doc size —
 *      the only approach that survives low-end Android ("1 juta phones").
 *   2. RENDER-ON-SETTLE — while flinging faster than `fling` px/frame we do
 *      NOT rasterize (travelling, not reading) but we still RELEASE far pages.
 *      On settle (`settleMs`) we catch up and sharpen. Never fight the finger.
 *   3. TELEGRAPH — position changes are reported so the UI can show a pill;
 *      placeholders are page-view.js's job. This module stays chrome-free.
 *
 * Container-scroll (not body-scroll) by design: `overscroll-behavior: contain`
 * on the scroll element kills the edge-overscroll recomposition flicker that
 * body scroll can never avoid (old editor's known limitation).
 */

// slots: () => [{ page, view, loading }] — owned by the editor, read here.
// rasterize: (page) => Promise<raster> — adapter around createPageRasterizer.
export function createViewportStream({
  scrollEl,
  slots,
  rasterize,
  loadScreens = 2,
  keepScreens = 4,
  fling = 45,
  settleMs = 130,
  onPosition = null, // (currentPageNumber, total) — fires on scroll for the pill
}) {
  let ticking = false;
  let lastTop = 0;
  let settleTimer = null;
  let attached = false;

  function refresh(velocity = 0) {
    const list = slots();
    if (list.length === 0) return;
    const sc = scrollEl.getBoundingClientRect();
    const loadPad = sc.height * loadScreens;
    const keepPad = sc.height * keepScreens;
    const flinging = velocity > fling;

    for (const slot of list) {
      const r = slot.view.getBoundingClientRect();
      const near = r.bottom > sc.top - loadPad && r.top < sc.bottom + loadPad;
      const far = r.bottom < sc.top - keepPad || r.top > sc.bottom + keepPad;

      if (far && slot.page.raster) {
        slot.release();               // release always — bounds memory even mid-fling
      } else if (near && !flinging && !slot.page.raster && !slot.loading) {
        slot.loading = true;          // rasterize only when NOT flinging
        rasterize(slot.page)
          .then((raster) => { slot.attach(raster); slot.loading = false; })
          .catch(() => { slot.loading = false; });
      }
    }
  }

  function reportPosition() {
    if (!onPosition) return;
    const list = slots();
    if (list.length === 0) return;
    const mid = scrollEl.getBoundingClientRect().top + scrollEl.clientHeight / 2;
    let current = 1;
    for (let i = 0; i < list.length; i += 1) {
      if (list[i].view.getBoundingClientRect().top <= mid) current = i + 1; else break;
    }
    onPosition(current, list.length);
  }

  function onScroll() {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        const top = scrollEl.scrollTop;
        const v = Math.abs(top - lastTop);
        lastTop = top;
        refresh(v);                   // gated: skips rasterizing during a fast fling
        reportPosition();
      });
    }
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => refresh(0), settleMs); // catch up once settled
  }

  const onResize = () => refresh(0);

  function attach() {
    if (attached) return;
    attached = true;
    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
  }

  function detach() {
    if (!attached) return;
    attached = false;
    scrollEl.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onResize);
    clearTimeout(settleTimer);
  }

  return { refresh, attach, detach, reportPosition };
}
