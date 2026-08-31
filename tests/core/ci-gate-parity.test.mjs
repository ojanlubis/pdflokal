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

test('CI runs every stage in the authoritative local gate, in order', () => {
  const commands = [...WORKFLOW.matchAll(/^\s*-\s+run:\s+(.+)$/gm)].map((match) => match[1].trim());
  const required = ['npm run lint', 'npm run seo:check', 'npm run test:core', 'npx playwright test'];
  const positions = required.map((command) => commands.indexOf(command));

  assert.ok(positions.every((position) => position >= 0),
    `CI commands ${JSON.stringify(commands)} must include ${JSON.stringify(required)}`);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b),
    'CI must preserve the gate order: lint, SEO, core, Playwright');
});

test('CI wakes for every source family that can affect a gate result', () => {
  for (const pattern of ['*.html', 'css/**', 'js/**', 'api/**', 'seo/**', 'scripts/**', 'tests/**']) {
    assert.match(WORKFLOW, new RegExp(`['\"]${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['\"]`),
      `paths filter must include ${pattern}`);
  }

  assert.doesNotMatch(WORKFLOW, /['\"]editor-v2\.html['\"]/,
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
