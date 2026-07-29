/*
 * THE THEME BOOT SNIPPET: three copies, one behaviour.
 * ============================================================================
 * A four-line inline script in <head> applies an explicit theme choice before
 * first paint. It has to be inline (an external file cannot beat first paint)
 * and it has to be in three hand-maintained files — index.html, privasi.html,
 * dukung.html. The 12 SEO pages inherit index.html's copy through the
 * generator, so they are not a separate home.
 *
 * Three copies of anything is a drift pair waiting to happen, and this repo has
 * been burned by exactly that twice (docs/security.md's CSP, SPACE_GAP_FACTOR).
 * "Remember to update all three" is not a mechanism. This is.
 *
 * ⚠️ THE SECOND TEST IS THE IMPORTANT ONE and it is not about parity at all.
 * The snippet must NOT resolve the system preference. That is css/tokens.css's
 * job, via `:root:not([data-theme="light"])`. If someone "improves" the snippet
 * by making it read prefers-color-scheme and stamp the result, every first-time
 * visitor arrives with an explicit attribute they never chose, the media query
 * stops applying, and the page silently stops following the OS forever after.
 * The page would look perfectly correct on the machine of whoever made the
 * change.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PAGES = ['index.html', 'privasi.html', 'dukung.html'];

// The boot snippet is the inline <script> that touches the theme key.
const SNIPPET = /<script>(?![\s\S]{0,40}type=)[^<]*pdflokal_theme[^<]*<\/script>/g;

function bootOf(file) {
  const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const hits = html.match(SNIPPET) || [];
  return { file, hits };
}

test('1. all three pages carry exactly one boot snippet, byte-identical', () => {
  const found = PAGES.map(bootOf);

  for (const { file, hits } of found) {
    assert.equal(hits.length, 1,
      `${file} has ${hits.length} theme-boot snippets, expected exactly 1. `
      + (hits.length === 0
        ? 'Without it, a user whose chosen theme differs from their OS sees a flash of the wrong one on every page load.'
        : 'Two copies in one file will fight over the attribute.'));
  }

  // VACUITY GUARD: a regex that matched nothing would make the comparison below
  // pass trivially, which is the shape this whole file exists to prevent.
  const snippets = found.map((f) => f.hits[0]);
  assert.ok(snippets[0].length > 80, `the matched snippet is only ${snippets[0].length} chars — the regex is matching the wrong thing`);

  const [first, ...rest] = snippets;
  for (let i = 0; i < rest.length; i++) {
    assert.equal(rest[i], first,
      `${PAGES[i + 1]}'s theme boot has drifted from ${PAGES[0]}'s.\n`
      + `  ${PAGES[0]}: ${first}\n  ${PAGES[i + 1]}: ${rest[i]}`);
  }
});

test('2. the snippet does NOT resolve the system preference — that is CSS\'s job', () => {
  const snippet = bootOf('index.html').hits[0];

  assert.equal(
    /prefers-color-scheme|matchMedia/.test(snippet), false,
    'the theme boot snippet now resolves the system preference itself. It must not.\n'
    + 'css/tokens.css owns the system default via :root:not([data-theme="light"]), and it can '
    + 'only do that if a page with no stored choice reaches the browser with NO data-theme '
    + 'attribute. Stamping the resolved value here gives every first-time visitor an explicit '
    + 'preference they never expressed, and the page stops following their OS from then on — '
    + 'on a machine where the OS and the stamped value agree, this looks completely fine.',
  );

  assert.equal(
    /setItem/.test(snippet), false,
    'the theme boot writes to localStorage. Nothing may be persisted on first visit: it converts '
    + 'a visitor with no preference into one with a preference they never chose.',
  );

  assert.ok(
    /getItem\(\s*'pdflokal_theme'\s*\)/.test(snippet),
    'the snippet no longer reads the stored theme key, so an explicit choice is not applied before paint',
  );
  assert.ok(
    /'light'/.test(snippet) && /'dark'/.test(snippet),
    'the snippet no longer validates the stored value against light/dark, so any junk in '
    + 'localStorage would be written straight onto the document as a data-theme attribute',
  );
});

test('3. theme.js never persists a resolved system value, and clears by REMOVING the attribute', () => {
  // ⚠️ COMMENTS STRIPPED FIRST. The header of theme.js QUOTES the old defective
  // line to explain why it is gone, and the first version of this test matched
  // that quotation and failed a correct file. A source-scanning test that reads
  // prose is testing the documentation.
  const js = fs.readFileSync(path.join(ROOT, 'js/theme.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  // The exact defect this replaced: `safeLocalGet(THEME_KEY) || 'light'` — a
  // hard default that ignored the OS entirely.
  assert.equal(
    /\|\|\s*'light'/.test(js), false,
    "js/theme.js has a `|| 'light'` fallback again. That is the original defect: it pins every "
    + 'visitor to light regardless of their OS setting, which defeats the reason for having dark '
    + 'mode at all. Absent storage means FOLLOW THE SYSTEM, expressed by removing the attribute.',
  );

  assert.ok(
    /removeAttribute\(\s*THEME_ATTR\s*\)/.test(js),
    'js/theme.js no longer removes data-theme for the no-choice case. Setting data-theme="light" '
    + 'instead would suppress the prefers-color-scheme rule in tokens.css permanently.',
  );

  // It must not drag the old wing into v2's module graph.
  assert.equal(
    /^import .*lib\/utils/m.test(js), false,
    'js/theme.js imports js/lib/utils.js again. That file belongs to the OLD WING and dies at '
    + 'demolition; index.html loads this module, so the import would pull the old wing into v2.',
  );
});
