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
