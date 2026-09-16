/*
 * Playwright must never import tests/core — pinned 2026-09-16.
 *
 * A project-level `testIgnore` REPLACES the top-level one. The chromium project
 * set only ['mobile/**'], so Playwright imported every tests/core/*.test.mjs and
 * node:test ran them on import, inside Playwright's single process, unseen —
 * until one core file leaked a fake setTimeout and froze CI's E2E run into its
 * 45-minute timeout (run 35077471690). This asserts the RESOLVED ignore list per
 * project, which is the thing that actually decides what gets imported.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import config from '../../playwright.config.js';

const asList = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

// Deliberately NOT minimatch: it is only a transitive dependency here, and a
// test must not lean on a package nobody declared. The globs in this config are
// simple enough to read exactly: `dir/**`, and `dir/**/*.spec.js`.
function covers(glob, file) {
  if (glob instanceof RegExp) return glob.test(file);
  const [head] = String(glob).split('/');
  const fileHead = file.split('/')[0];
  if (head === '**') return true;
  return head === fileHead;
}

test('every Playwright project either ignores core/** or only matches outside it', () => {
  assert.ok(config.projects?.length >= 1, 'no projects found — the assertion below would pass vacuously');
  const probe = 'core/bug-report-prompt.test.mjs';
  for (const p of config.projects) {
    // A project-level testIgnore replaces the top-level one; fall back only if absent.
    const ignore = asList(p.testIgnore ?? config.testIgnore);
    const ignored = ignore.some((g) => covers(g, probe));
    const match = asList(p.testMatch ?? config.testMatch);
    const matchedOnlyElsewhere = match.length > 0 && !match.some((g) => covers(g, probe));
    assert.ok(ignored || matchedOnlyElsewhere,
      `project "${p.name}" would import ${probe} into Playwright's process`);
  }
});
