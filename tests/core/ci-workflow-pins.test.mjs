/*
 * The CI install steps' two hardening choices, held to the files they depend on.
 *
 *   npm ci --ignore-scripts   safe only while no dependency CI installs needs a
 *                             lifecycle script. Today the lockfile's only
 *                             install script is fsevents, an optional macOS-only
 *                             package npm never installs on the Linux runners.
 *   npx playwright@<version>  the browser-installing steps pin the CLI to the
 *                             lockfile's @playwright/test, so the browser build
 *                             always matches the runner that drives it.
 * Either drifts silently (a new package with a postinstall; a Playwright bump
 * without the workflow) and CI only breaks later, far from the cause.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const LOCK = JSON.parse(read('package-lock.json'));
const WORKFLOWS = ['.github/workflows/e2e.yml', '.github/workflows/lint.yml'];

test('every npm ci in CI ignores lifecycle scripts', () => {
  let seen = 0;
  for (const wf of WORKFLOWS) {
    for (const m of read(wf).matchAll(/^\s*-?\s*run:\s+(npm ci\b.*)$/gm)) {
      seen += 1;
      assert.match(m[1], /--ignore-scripts\b/, `${wf}: ${m[1]}`);
    }
  }
  assert.ok(seen >= 2, `VACUITY GUARD: found ${seen} npm ci steps`);
});

test('no dependency CI installs on Linux needs an install script (so --ignore-scripts loses nothing)', () => {
  const needing = Object.entries(LOCK.packages || {})
    .filter(([, v]) => v.hasInstallScript)
    // Optional and not for Linux: npm skips it on the runner, scripts or not.
    .filter(([, v]) => !(v.optional && Array.isArray(v.os) && !v.os.includes('linux')))
    .map(([k]) => k);
  assert.deepEqual(needing, [], 'a package now runs an install script: decide whether CI may skip it, then update this test');
  const scripts = Object.keys(JSON.parse(read('package.json')).scripts || {});
  assert.deepEqual(scripts.filter((s) => /^(pre|post)?(install|prepare)$/.test(s)), [], 'the root package has a lifecycle script');
});

test('the browser-installing npx steps pin the lockfile\'s Playwright', () => {
  const version = LOCK.packages['node_modules/@playwright/test']?.version;
  assert.match(version || '', /^\d+\.\d+\.\d+$/, 'VACUITY GUARD: the lockfile names a Playwright version');
  const installs = [...read('.github/workflows/e2e.yml').matchAll(/^\s*run:\s+(npx playwright\S*\s+install\S*.*)$/gm)].map((m) => m[1]);
  assert.ok(installs.length >= 2, `VACUITY GUARD: found ${JSON.stringify(installs)}`);
  for (const cmd of installs) assert.ok(cmd.startsWith(`npx playwright@${version} `), `${cmd} must pin ${version}`);
});
