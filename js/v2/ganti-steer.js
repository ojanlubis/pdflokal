/*
 * PDFLokal — v2/ganti-steer.js  (EDIT'S STEERING GLOW)
 * ============================================================================
 * Moved out of js/v2/app.js (2026-10-10), behaviour unchanged. The one glow
 * that shows which printed line an Edit press would take: one reusable div,
 * moved (not recreated) between page overlays, hit-tested at most once a
 * frame, and never left lit by a hit-test that resolved after a newer one or
 * after the tool moved on.
 *
 * FOUNDER RULING (2026-07-19, "mending opsi a" — QUIET PAGE): when Ganti Teks
 * is armed the page shows NO per-line hint boxes. On a dense document
 * everything is tappable, so marking everything marks nothing. The armed-mode
 * affordance is now ONLY: the arm toast + this glow (hover on fine pointers,
 * press-steer on touch) — one reusable div, moved (not recreated) between page
 * overlays as the press/drag/hover resolves to different lines. Solid
 * chrome-red, matches the founder's camera-first release-commit law: nothing
 * is true until the finger lifts, but the user must see what WOULD happen.
 *
 * deps (getters, never captured values: Buka Baru replaces the slots):
 *   hitTest(pageId, x, y) -> Promise<line|null>   (textRuns.hitTest)
 *   getTool() -> string
 *   getSlots() -> slot[]
 */
export function createGantiSteer({ hitTest, getTool, getSlots }) {
  let glowEl = null;
  let steerSeq = 0;     // guards against a late hitTest landing after a newer one
  let steerRaf = null;
  let steerPending;     // undefined = nothing queued (null is a valid "clear" value)

  function clear() {
    if (glowEl) { glowEl.remove(); glowEl = null; }
  }

  async function apply(pt) {
    const seq = (steerSeq += 1);
    if (!pt) { clear(); return; }
    const line = await hitTest(pt.pageId, pt.x, pt.y);
    // Stale guard: a newer steer landed first, or the tool moved on while this
    // hitTest (async — first call per page extracts text) was in flight.
    if (seq !== steerSeq || getTool() !== 'ganti') return;
    if (!line) { clear(); return; }
    const slot = getSlots().find((s) => s.page.id === pt.pageId);
    const overlay = slot?.view.querySelector('.pv-overlay');
    if (!overlay) { clear(); return; }
    if (!glowEl) {
      glowEl = document.createElement('div');
      glowEl.className = 'pv-ganti-glow';
    }
    glowEl.style.cssText =
      `position:absolute;left:${line.x}px;top:${line.y}px;width:${line.w}px;height:${line.h}px;` +
      'pointer-events:none;border:1.5px solid rgba(220,38,38,.8);background:rgba(220,38,38,.08);border-radius:2px;';
    if (glowEl.parentElement !== overlay) overlay.appendChild(glowEl);
  }

  return {
    // rAF-throttled: interaction.js forwards a raw pointermove stream (steering +
    // fine-pointer hover) — coalesce to one hitTest per frame instead of one per
    // event.
    onSteer(pt) {
      steerPending = pt;
      if (steerRaf) return;
      steerRaf = requestAnimationFrame(() => {
        steerRaf = null;
        apply(steerPending);
      });
    },
    clear,
    // A caller about to empty an overlay (syncOverlay does innerHTML = '') drops
    // the glow first if it rides THAT view, rather than leave a dangling node.
    detachIfIn(view) {
      if (glowEl && view && view.contains(glowEl)) clear();
    },
  };
}
