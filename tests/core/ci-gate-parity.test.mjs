/*
 * CI and the local gate make the same safety claim. Keep this check outside
 * the workflow so a YAML edit cannot silently redefine both the rule and its
 * verifier at once.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github/workflows/e2e.yml'), 'utf8');
const GATE = fs.readFileSync(path.join(ROOT, 'scripts/qa-gate.mjs'), 'utf8');

// A command's identity is the program plus its leading non-flag words
// (`npm run seo:check`, `npx playwright test`); flags after it are tuning, not
// a different stage, so `npx playwright test --forbid-only` is still the
// Playwright stage.
const identity = (words) => {
  const out = [];
  for (const w of words) { if (w.startsWith('-')) break; out.push(w); }
  return out.join(' ');
};

// CI steps that install the runner, not stages that judge the tree.
const isSetup = (command) => /^npm ci$|^npx playwright install(-deps)?\b/.test(command);

test('CI runs every stage in the authoritative local gate, in order', () => {
  const commands = [...WORKFLOW.matchAll(/^\s*-\s+run:\s+(.+)$/gm)].map((match) => match[1].trim());
  const required = ['npm run lint', 'npm run seo:check', 'npm run test:core', 'npx playwright test'];
  const positions = required.map((command) => commands.indexOf(command));

  assert.ok(positions.every((position) => position >= 0),
    `CI commands ${JSON.stringify(commands)} must include ${JSON.stringify(required)}`);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b),
    'CI must preserve the gate order: lint, SEO, core, Playwright');
});

// The test above pins CI against a HARD-CODED list, so deleting a stage from
// scripts/qa-gate.mjs (e.g. the seo:check stage) left it green: the gate
// silently stopped mirroring CI. This one reads the stage commands out of the
// gate itself and demands the same ordered list as CI's run steps, both ways:
// a stage only CI runs, or only the gate runs, is red.
test('the gate\'s stages and CI\'s run steps are the same commands, in the same order', () => {
  const gateCalls = [...GATE.matchAll(/\bstage\(\s*'([A-Z]+)'\s*,\s*'([\w-]+)'\s*,\s*\[([^\]]*)\]/g)]
    .map((m) => ({ name: m[1], cmd: m[2], args: [...m[3].matchAll(/'([^']*)'/g)].map((a) => a[1]) }));
  const gate = gateCalls.map((c) => identity([c.cmd, ...c.args]));
  const ci = [...WORKFLOW.matchAll(/^\s*(?:-\s+)?run:\s+(.+)$/gm)]
    .map((m) => identity(m[1].trim().split(/\s+/)))
    .filter((command) => !isSetup(command));

  // VACUITY: a parser that finds nothing on both sides agrees with itself.
  assert.ok(gate.length >= 4, `parsed only ${JSON.stringify(gate)} out of scripts/qa-gate.mjs; repoint the parser`);
  assert.ok(gate.includes('npm run seo:check'), 'the gate must run seo:check (CI does)');
  assert.deepEqual(ci, gate, 'CI run steps and qa-gate.mjs stages must be the same commands in the same order');

  // A stray test.only must fail the gate exactly as it fails CI.
  const pw = gateCalls.find((c) => identity([c.cmd, ...c.args]) === 'npx playwright test');
  assert.ok(pw?.args.includes('--forbid-only'), 'the gate\'s Playwright stage must pass --forbid-only');
});

test('CI wakes for every source family that can affect a gate result', () => {
  // Since 2026-11-03 the filter is a DENY-list (his branch + CI rules, seat decisions): with
  // predicate-quantifier 'every', a changed file triggers e2e unless it matches one of the '!' patterns.
  // So the guard is: the quantifier and the catch-all are there, every code family stays OUTSIDE the
  // exclusions, and the one data path the exclusions exist for (js/updates.js) is inside them.
  // History kept: en/**, i18n/** and sitemap.xml once fell outside an allow-list and a PR touching only
  // them skipped every test until the nightly run after merge.
  const filter = WORKFLOW.match(/runnable:\n((?:\s+- '[^']+'\n)+)/)?.[1] ?? '';
  const patterns = [...filter.matchAll(/- '([^']+)'/g)].map((m) => m[1]);
  assert.match(WORKFLOW, /predicate-quantifier:\s*'every'/, 'the paths filter must use predicate-quantifier every');
  assert.ok(patterns.includes('**'), `the deny-list needs its catch-all '**': ${JSON.stringify(patterns)}`);

  const toRe = (glob) => new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    // Placeholders first: converting '**' to '.*' and THEN '*' would rewrite that '.*' into '.[^/]*'.
    .replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0002').replace(/\*/g, '[^/]*')
    .replace(/\u0001/g, '(?:.*/)?').replace(/\u0002/g, '.*') + '$');
  const excluded = patterns.filter((x) => x.startsWith('!')).map((x) => toRe(x.slice(1)));
  const skips = (file) => excluded.some((re) => re.test(file));

  for (const file of ['index.html', 'dukung.html', 'css/tokens.css', 'js/v2/app.js', 'js/core/export.js', 'api/t.js',
    'seo/pages.json', 'scripts/gen-seo-pages.js', 'tests/core/zoom.test.mjs', 'en/index.html', 'i18n/markup.en.json',
    'sitemap.xml', 'vercel.json', 'sw.js', 'package.json', '.github/workflows/e2e.yml']) {
    assert.ok(!skips(file), `${file} is code, but the paths filter excludes it from e2e`);
  }
  assert.ok(skips('js/updates.js'), 'js/updates.js is data only and must skip e2e (lint.yml runs its core check)');

  assert.doesNotMatch(WORKFLOW, /['"]editor-v2\.html['"]/,
    'the deleted editor-v2.html entry must not masquerade as CI coverage');
});

test('the core stage discovers every core test on the Node version CI pins', () => {
  const script = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts['test:core'];

  // Node 20 — pinned in every workflow — has no CLI glob matcher; Node 22+ does.
  // A QUOTED pattern therefore reaches Node as one literal path and CI dies in
  // 30s, while every local gate (Node 22+) stays green and claims parity. Let
  // the SHELL expand the pattern and neither version is special.
  assert.doesNotMatch(script, /['"]/, `test:core must not quote its pattern: ${script}`);
  assert.doesNotMatch(script, /\*\*/, `test:core must not rely on recursive globbing: ${script}`);

  // A shell glob sees one level only. Without this, the day a core test moves
  // into a subdirectory it stops running and NOTHING goes red — a pass that
  // means "not looked at". This is that red.
  const core = path.join(ROOT, 'tests/core');
  const nested = fs.readdirSync(core, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((dir) => fs.readdirSync(path.join(core, dir.name), { recursive: true })
      .filter((name) => String(name).endsWith('.test.mjs'))
      .map((name) => path.join(dir.name, String(name))));

  assert.deepEqual(nested, [],
    'tests/core/*.test.mjs cannot reach these; move them up or widen the script AND this test');
});

test('CI gives the browser suite a job budget it can actually finish in', () => {
  // Measured 2026-08-31 on a healthy Mac: Playwright alone = 11.3 min with NO
  // retries. CI sets CI=true, so playwright.config.js retries once and a run
  // with any flake costs more. The old budget was 10 min, so every runnable CI
  // run since at least 6c4b500 was CANCELLED mid-suite — which reports as a
  // failed check without ever naming a failing test.
  const budget = Number(WORKFLOW.match(/^\s*timeout-minutes:\s*(\d+)\s*$/m)?.[1]);

  assert.ok(budget >= 30,
    `the e2e job budget is ${budget}min; the suite needs >11min plus retries, so anything under 30 kills it mid-run`);
});
