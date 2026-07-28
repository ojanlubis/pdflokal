/*
 * Waiting for the FIRST page raster.
 * ============================================================================
 * Every spec that opens a document starts by waiting for `.pv-page .pv-bg` to
 * appear. There were 60 copies of that line, each inheriting playwright.config's
 * global 5s `expect` timeout — and first render is the single slowest thing the
 * app does: fetch pdf.js, spin the worker, parse the document, rasterize page 1.
 *
 * WHY THIS EXISTS: on 2026-07-28 a full gate returned RED on
 * `edit-feedback.spec.js:78` — `toBeVisible` timing out at 5s inside openDoc,
 * before any edit. It was environmental: the machine had rebooted 21 minutes
 * earlier and was at load 3.6 with VoiceMemos + coreaudiod on ~50% CPU, and the
 * run took 12.2m against its usual 5.6m. The same spec passed 11/11 in
 * isolation and 267/267 on a clean re-run.
 *
 * It is fixed anyway, and NOT because a flaky test is annoying. Once the
 * auto-push policy arms, the gate is the only thing between a change and
 * production, and a load-induced red teaches "just re-run it". **A gate people
 * have learned to re-roll is not a gate** — it is the green-that-can't-go-red
 * disease approached from the other side, and the retry habit is how a REAL
 * failure eventually gets dismissed.
 *
 * WHY A BUDGET AND NOT A DETERMINISTIC SIGNAL — the honest answer, so nobody
 * later assumes this number was picked by feel:
 *
 * The seat's standing preference is to remove a race rather than budget for it
 * (and that is what `prepareDocFont`'s `data-style-prepared` did). It does not
 * apply here. **No render-completion signal exists** — `js/render/` emits no
 * event, dispatches nothing, and exposes no "first raster attached" state; the
 * only settle machinery is `viewport.js`'s internal scroll timer. And
 * `.pv-bg` becoming visible is not a lagging proxy for completion: the element
 * IS attached at the moment the raster lands, so this wait already resolves as
 * early as it possibly can. There is no race to remove — Playwright polls and
 * returns immediately on success. What was wrong was only the DEADLINE.
 *
 * So this is a budget, deliberately, and it buys 4x headroom over the global 5s
 * rather than being tuned down to whatever last made the suite pass. The global
 * `expect` timeout stays at 5s on purpose: raising it would slow every genuine
 * failure in the suite from 5s to 20s, and most assertions here are about DOM
 * that is already present. Only first render deserves the headroom.
 *
 * If someone ever adds a real completion event to js/render/, delete the budget
 * and wait on that instead — that would be strictly better, and this comment is
 * the note explaining why it wasn't done today.
 */
import { expect } from '@playwright/test';

// 4x the global expect timeout. Not tuned to a passing run: chosen so a machine
// under heavy load (the observed bad case ran ~2.2x slower than normal end to
// end) still clears it with room, while a genuinely broken first render still
// fails inside the 30s test timeout rather than hanging it.
export const FIRST_RENDER_MS = 20_000;

// SINGLE SOURCE OF TRUTH for "the document is open and page 1 is on screen".
export async function expectFirstPage(page) {
  await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible({ timeout: FIRST_RENDER_MS });
}
