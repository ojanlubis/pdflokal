/*
 * PDFLokal — tests/module-graph-alive.spec.js
 * ============================================================================
 * Every shipped page loads its module graph WITHOUT a top-level throw.
 *
 * WHY THIS SUITE EXISTS, and why it is not "does the page load":
 *   The editor chrome is hand-copied inline into THIRTEEN pages. `js/v2/app.js`
 *   is imported by all of them, but each page carries a slightly different set
 *   of elements. A top-level `document.getElementById('x').addEventListener(...)`
 *   for an element that exists on only SOME of them throws during module
 *   evaluation — and an ES module that throws while evaluating takes the whole
 *   import graph with it.
 *
 *   The failure is uniquely nasty because the page still LOOKS fine:
 *
 *     HTML renders · CSS applies · and every single control is dead.
 *
 *   No blank screen, no error banner, nothing a human glancing at it would
 *   catch. The user taps a tool and nothing happens.
 *
 * MEASURED, 2026-08-22 — this is not hypothetical:
 *   The contact bookmark shipped its markup to index.html only. On the other
 *   twelve pages `#contact-tab-btn` was null and app.js died at module scope.
 *   It surfaced three towns over, as `.pv-bg` never appearing in
 *   compress-target.spec.js — a 30s timeout x3 with nothing naming the cause.
 *   Sentry already carries the same signature from production (JAVASCRIPT-J,
 *   `Cannot read properties of null (reading 'addEventListener')`, culprit
 *   `?(app)`), and js/v2/telemetry.js took the identical fix in the SAME commit
 *   for `crypto.randomUUID`. Three instances, one shape.
 *
 * WHAT MAKES THIS GO RED (the required question):
 *   Reverting the `if (contactTabBtn && contactTabPanel)` guard in js/v2/app.js
 *   turns twelve of these assertions red in about a second. Verified by doing
 *   exactly that before this file was written — the unguarded tree threw on
 *   12/21 pages, the guarded tree on 0/21.
 *
 *   It is deliberately a PAGEERROR check and not a "click something" check:
 *   asserting on behaviour would need per-page knowledge of what each page
 *   offers, which is how a suite quietly stops covering the pages nobody
 *   remembered to add.
 * ============================================================================
 */
import { test, expect } from '@playwright/test';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Enumerated from disk, never hand-listed. A hand-list is how a NEW page joins
// the product and silently joins nothing else.
const PAGES = readdirSync(APP_ROOT)
  .filter((f) => f.endsWith('.html'))
  .sort();

test('the page set is non-empty and was read from disk', () => {
  // Guards the guard: if the glob ever returns [], every test below would
  // vacuously pass and this suite would become decoration.
  expect(PAGES.length).toBeGreaterThan(10);
});

for (const page of PAGES) {
  test(`${page} evaluates its modules with no top-level throw`, async ({ page: p }) => {
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));

    await p.goto(`/${page}`);
    // Module evaluation is not tied to load; give the graph a beat to run.
    await p.waitForLoadState('networkidle');

    expect(
      errors,
      `${page} threw during module evaluation — the page renders but every ` +
        `control is dead. Usually a top-level getElementById() for an element ` +
        `this page does not carry. Guard the lookup.`,
    ).toEqual([]);
  });
}
