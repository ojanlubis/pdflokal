#!/usr/bin/env node
/*
 * PDFLokal — scripts/qa-gate.mjs  (THE GATE)
 * ============================================================================
 * The machine QA gate: lint -> core -> Playwright, run as ONE owned sequence,
 * on a tree proven not to move underneath it.
 *
 * WHY THIS EXISTS — read this before "simplifying" the fingerprint away:
 *   2026-07-28, day 1 of Edit in production. A full sweep returned
 *   `266 passed, exit 0` and it was worthless. It ran 13:23:40 -> 13:29:44;
 *   another session committed js/core/page-surgery.js + js/v2/app.js at
 *   13:28:39 — sixty-five seconds before the run ended. `npx serve` reads from
 *   DISK, so the early tests loaded the old modules and the late tests loaded
 *   the new ones. The suite never tested one codebase. It tested two.
 *
 *   Nothing was broken. Nothing errored. The output was character-for-character
 *   what a real green looks like. That is the whole problem: a green assembled
 *   from a moving tree is not merely wrong, it is wrong in the one shape this
 *   project keeps getting caught by — a confident, plausible value derived from
 *   data nobody verified (CC memory `plausible-answer-from-unchecked-data`,
 *   seventh instance, this time inside the safety net itself).
 *
 * WHAT IT ADDS over the raw lint/core/playwright sequence
 *   A content fingerprint of EVERY file the dev server can hand to a test,
 *   plus HEAD — captured before, after, AND sampled every few seconds
 *   throughout. If any of them ever disagrees, the run is VOID — not passed,
 *   not failed. VOID exits 90 so no caller can mistake it for either. A voided
 *   run must never be reportable as a pass.
 *
 *   The sampling is not belt-and-braces, it closes a real hole: a before/after
 *   comparison only sees NET change. A file written at minute two and deleted
 *   at minute five is served to every test in between and leaves both endpoints
 *   identical — the guard would report a confident green over a tree that did
 *   move. That is the same defect shape the guard exists to catch, so the guard
 *   does not get to commit it. Sampling sees the transient; the endpoints alone
 *   cannot.
 *
 * WHY THE FINGERPRINT IS CONTENT-ONLY (no mtimes, no `git status`)
 *   mtimes change on a checkout that restores identical bytes, which would void
 *   honest runs. `git status` is blind to the case that actually bit us —
 *   another session COMMITTING mid-run leaves a clean tree at a different HEAD.
 *   We need both halves: HEAD catches commits, the digest catches uncommitted
 *   edits, and untracked files count too because `serve` will happily serve one.
 *
 * THE GUARD WAS PROVEN ABLE TO FAIL BEFORE IT WAS TRUSTED — and that is not a
 * comment, it is `--self-test`. Same tree twice -> identical digest; one byte
 * changed -> different digest. Run it against a scratch directory (never the
 * repo) so proving the alarm works can never itself corrupt a run. A guard
 * nobody has watched go red is decoration, exactly like the green it exists to
 * catch. If you change `fingerprint()`, run `--self-test` again.
 *
 * USAGE
 *   node scripts/qa-gate.mjs              # the gate (npm run gate)
 *   node scripts/qa-gate.mjs --self-test  # prove the guard can fail
 *
 * EXIT CODES — distinct on purpose, do not collapse them
 *   0   GREEN  every stage passed on a tree that did not move
 *   1   RED    a stage failed on a stable tree (a real failure)
 *   90  VOID   the tree moved; this run gates NOTHING, re-run it
 *   99  usage/environment error
 *
 * ONE OWNER, ONE INVOCATION. Two concurrent Playwright runs fight over port
 * 5050 and produce phantom ERR_CONNECTION_REFUSED failures that look real.
 * The session rooted in app/ owns this; subagents run lint + core only.
 */

import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Everything the dev server can serve to a test, plus the test sources
// themselves. `seo` holds generated pages that specs navigate to; the root
// *.html files are the app's own entry points (index.html, alat-gambar.html…).
//
// `scripts` is watched even though nothing serves it: it holds the fixture
// generators, and this gate. A run whose fixtures were regenerated halfway
// through is as meaningless as one whose modules changed.
const WATCHED_DIRS = ['js', 'tests', 'seo', 'scripts'];

// Watched because they define what the run MEANS, not what it serves. Change
// `playwright.config.js` mid-run and the second half tests a different set of
// projects than the first; change `package.json` and the stage commands differ.
const WATCHED_FILES = ['package.json', 'playwright.config.js', 'eslint.config.js'];

const WATCHED_ROOT_FILES = (root) => [
  ...readdirSync(root).filter((f) => f.endsWith('.html')),
  ...WATCHED_FILES,
];

// Never fingerprint these: they are outputs of the run itself, so including
// them would void every run on its own artifacts.
const IGNORED = new Set(['node_modules', '.git', 'test-results', 'playwright-report', '.DS_Store']);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // a watched dir that doesn't exist is not an error
  }
  for (const e of entries) {
    if (IGNORED.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile()) out.push(full);
  }
  return out;
}

// SINGLE SOURCE OF TRUTH for "did the tree move". Content-only and
// order-independent: paths are sorted, and each file contributes its path plus
// its bytes, so a rename is as visible as an edit.
function fingerprint(root, dirs = WATCHED_DIRS, rootFiles = true) {
  const files = [];
  for (const d of dirs) walk(path.join(root, d), files);
  if (rootFiles) {
    for (const f of WATCHED_ROOT_FILES(root)) {
      const full = path.join(root, f);
      // A watched file that doesn't exist is not an error — but it must still
      // be VISIBLE to the digest, so that CREATING it mid-run counts as the
      // tree moving rather than silently passing.
      try {
        statSync(full);
        files.push(full);
      } catch { /* absent: contributes nothing, and appearing later changes the digest */ }
    }
  }
  files.sort();
  const h = createHash('sha256');
  for (const f of files) {
    h.update(path.relative(root, f));
    h.update('\0');
    h.update(readFileSync(f));
    h.update('\0');
  }
  return { digest: h.digest('hex').slice(0, 32), count: files.length };
}

function headSha(root) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout.trim();
}

// ---------------------------------------------------------------------------
// --self-test: prove the alarm can go red, in a scratch dir, never the repo.
// ---------------------------------------------------------------------------
function selfTest() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'pdflokal-gate-'));
  try {
    mkdirSync(path.join(scratch, 'js'), { recursive: true });
    const probe = path.join(scratch, 'js', 'probe.js');
    writeFileSync(probe, 'export const a = 1;\n');

    const a = fingerprint(scratch, ['js'], false);
    const b = fingerprint(scratch, ['js'], false);
    if (a.digest !== b.digest) {
      console.error('SELF-TEST FAILED: the same tree produced two digests — the fingerprint is not deterministic.');
      return 1;
    }

    writeFileSync(probe, 'export const a = 1; // one byte more\n');
    const c = fingerprint(scratch, ['js'], false);
    if (c.digest === a.digest) {
      console.error('SELF-TEST FAILED: an edited file produced the SAME digest — the guard is blind and gates nothing.');
      return 1;
    }

    writeFileSync(probe, 'export const a = 1;\n');
    const d = fingerprint(scratch, ['js'], false);
    if (d.digest !== a.digest) {
      console.error('SELF-TEST FAILED: restoring the original bytes did not restore the digest — the guard would void honest runs.');
      return 1;
    }

    // A new untracked file must register: `serve` would happily serve it.
    writeFileSync(path.join(scratch, 'js', 'stray.js'), 'export const b = 2;\n');
    if (fingerprint(scratch, ['js'], false).digest === a.digest) {
      console.error('SELF-TEST FAILED: an added file produced the SAME digest.');
      return 1;
    }

    console.log('SELF-TEST PASSED — the guard is deterministic, detects edits, detects additions, and restores cleanly.');
    console.log(`  stable digest ${a.digest} (${a.count} file)`);
    console.log(`  after 1-byte edit ${c.digest}`);
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// the gate
// ---------------------------------------------------------------------------
function stage(name, cmd, args) {
  console.log(`\n=== ${name} ===`);
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: REPO, stdio: 'inherit', shell: false });
    child.on('close', (code) => {
      console.log(`${name}: exit ${code ?? 1}`);
      resolve(code ?? 1);
    });
    child.on('error', (err) => {
      console.error(`${name}: failed to launch — ${err.message}`);
      resolve(1);
    });
  });
}

// Watches the tree for the WHOLE run, not just its endpoints. Records every
// distinct (HEAD, digest) it ever sees; more than one means the tree moved,
// even if it moved back before we finished.
function startWatcher(intervalMs = 4000) {
  const seen = new Map(); // "head|digest" -> { at, digest, head }
  const record = (label) => {
    const head = headSha(REPO);
    const { digest, count } = fingerprint(REPO);
    const key = `${head}|${digest}`;
    if (!seen.has(key)) seen.set(key, { at: new Date().toISOString(), head, digest, count, label });
    return { head, digest, count };
  };
  const first = record('start');
  const timer = setInterval(() => record('during'), intervalMs);
  timer.unref?.();
  return {
    first,
    stop() {
      clearInterval(timer);
      const last = record('end');
      return { states: [...seen.values()], last };
    },
  };
}

async function main() {
  if (process.argv.includes('--self-test')) process.exit(selfTest());

  try {
    statSync(path.join(REPO, 'package.json'));
  } catch {
    console.error(`qa-gate: not a pdflokal checkout: ${REPO}`);
    process.exit(99);
  }

  const watcher = startWatcher();
  console.log('=== GATE START ===');
  console.log(`HEAD        ${watcher.first.head ?? '(no git)'}`);
  console.log(`fingerprint ${watcher.first.digest} (${watcher.first.count} files watched, sampled every 4s)`);

  const lint = await stage('LINT', 'npm', ['run', 'lint']);
  const core = await stage('CORE', 'npm', ['run', 'test:core']);
  const pw = await stage('PLAYWRIGHT', 'npx', ['playwright', 'test']);

  const { states, last } = watcher.stop();
  console.log('\n=== GATE END ===');
  console.log(`HEAD        ${last.head ?? '(no git)'}`);
  console.log(`fingerprint ${last.digest} (${last.count} files watched)`);

  // VOID is checked FIRST and beats everything. On a moving tree we cannot say
  // "passed" and we cannot say "failed" — only that we learned nothing.
  if (states.length > 1) {
    console.error(`\nVERDICT=VOID — the tree moved under this run (${states.length} distinct states seen). It gates NOTHING.`);
    for (const s of states) {
      console.error(`  ${s.at}  head=${(s.head ?? 'none').slice(0, 7)}  files=${s.digest}  (${s.label})`);
    }
    console.error('  Another session almost certainly wrote to the tree. Re-run once it is idle.');
    process.exit(90);
  }

  if (lint || core || pw) {
    console.error(`\nVERDICT=RED (lint=${lint} core=${core} playwright=${pw}) on stable tree ${last.head}`);
    process.exit(1);
  }

  console.log(`\nVERDICT=GREEN on stable tree ${last.head}`);
  process.exit(0);
}

main();
