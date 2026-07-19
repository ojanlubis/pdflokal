/*
 * Line-addressing helpers for the Ganti Teks suites.
 *
 * WHY this exists (QUIET PAGE, founder ruling 2026-07-19 "mending opsi a"):
 * arming Ganti Teks no longer paints per-line hint boxes — on a dense document
 * everything is tappable, so marking everything marks nothing. The specs used
 * those boxes as their TAP-FINDING scaffolding ("click the Nth hint"). This
 * helper replaces that scaffolding with something more honest anyway: lines
 * are addressed by their TEXT (or paint-order index) through the app's OWN
 * line index (window.v2.textRuns — the very geometry hitTest resolves taps
 * against), then mapped page-space → viewport through the page element.
 *
 * All current ganti fixtures put their subject lines on PAGE 1 — the lookup
 * deliberately stays single-page until a spec needs more.
 */
import { expect } from '@playwright/test';

export async function armGanti(page) {
  await page.click('[data-tool="ganti"]');
  // No hint layer to wait for (quiet page) — the tool state IS the signal;
  // anything geometry-dependent awaits the line index itself via lineBox().
  await page.waitForFunction(() => window.v2?.getTool() === 'ganti');
}

// Viewport-space box of a printed line, addressed by { str, nth } (nth match
// of a substring, paint order) or { index } (paint-order line index). Scrolls
// the line toward mid-viewport first so the returned center is clickable.
export async function lineBox(page, target) {
  const t = { nth: 0, ...target };
  const box = await page.evaluate(async (q) => {
    const pg = window.v2.getDoc().pages[0];
    const lines = await window.v2.textRuns.getLines(pg.id);
    const line = q.str !== undefined
      ? lines.filter((l) => l.str.includes(q.str))[q.nth]
      : lines[q.index];
    if (!line) return null;
    const view = document.querySelector(`.pv-page[data-page-id="${pg.id}"]`);
    // Page-space px → viewport px: rect/offset ratio absorbs the zoom
    // transform (the same relationship the hint boxes' raw-px styling relied
    // on). Scroll first, then re-measure — the rect moves with the scroll.
    let r = view.getBoundingClientRect();
    const sy = r.height / view.offsetHeight;
    const centerDocY = r.top + window.scrollY + (line.y + line.h / 2) * sy;
    window.scrollTo(0, Math.max(0, centerDocY - window.innerHeight / 2));
    r = view.getBoundingClientRect();
    const sx = r.width / view.offsetWidth;
    const sy2 = r.height / view.offsetHeight;
    return {
      x: r.left + line.x * sx,
      y: r.top + line.y * sy2,
      width: line.w * sx,
      height: line.h * sy2,
      str: line.str,
    };
  }, t);
  if (!box) throw new Error(`lineBox: no line for ${JSON.stringify(t)}`);
  return box;
}

export function centerOf(box) {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

// Click a line and wait for the prefilled inline editor (the old tapRun/
// tapLine contract, minus the hint DOM).
export async function tapLine(page, target) {
  const c = centerOf(await lineBox(page, target));
  await page.mouse.click(c.x, c.y);
  await expect(page.locator('.v2-text-edit')).toBeVisible();
}

// A visible point on page 1 that overlaps NO line (with generous padding) —
// real margin, not "probably empty". Candidates keep the top corners first:
// they are always inside the viewport right after open.
export async function marginPoint(page) {
  const pt = await page.evaluate(async () => {
    const pg = window.v2.getDoc().pages[0];
    const lines = await window.v2.textRuns.getLines(pg.id);
    const view = document.querySelector(`.pv-page[data-page-id="${pg.id}"]`);
    const r = view.getBoundingClientRect();
    const sx = r.width / view.offsetWidth;
    const sy = r.height / view.offsetHeight;
    const boxes = lines.map((l) => ({
      x: r.left + l.x * sx, y: r.top + l.y * sy, w: l.w * sx, h: l.h * sy,
    }));
    const pad = 24;
    const cands = [
      { x: r.left + 8, y: r.top + 8 },
      { x: r.right - 8, y: r.top + 8 },
      { x: r.left + 8, y: r.bottom - 8 },
      { x: r.right - 8, y: r.bottom - 8 },
      { x: r.left + r.width / 2, y: r.top + 8 },
    ];
    return cands.find((c) => !boxes.some((b) => c.x >= b.x - pad && c.x <= b.x + b.w + pad
      && c.y >= b.y - pad && c.y <= b.y + b.h + pad)) || null;
  });
  if (!pt) throw new Error('marginPoint: every candidate overlapped a line — fixture geometry changed');
  return pt;
}
