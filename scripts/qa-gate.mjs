#!/usr/bin/env node
/*
 * PDFLokal — scripts/qa-gate.mjs  (THE GATE)
 * ============================================================================
 * The machine QA gate: lint -> seo:check -> core -> Playwright, run as ONE owned
 * sequence, on a tree proven not to move underneath it. The stage list MIRRORS
 * CI: anything CI runs that this does not means the gate can be green while CI
 * is red, which destroys the only claim it makes.
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

/*
 * ⚠️ THE WILD CORPUS IS EXCLUDED, AND IT IS A PERFORMANCE FIX WITH TEETH.
 *
 * `tests/fixtures/wild` is 564 MB of real documents (one file alone is 83 MB).
 * The sampler re-fingerprints every 4 SECONDS, so a 10-minute run was hashing
 * roughly 85 GB. The gate went from a ~6.5m baseline to 10-13m the moment that
 * corpus landed, and three runs were misread as machine contention — including
 * one RED that re-ran clean and cost a round of "did my change break this".
 *
 * ⭐ THE MISDIAGNOSIS IS THE POINT: the slow runs were blamed on other browsers
 * competing for CPU. They were the gate competing with ITSELF. The duration
 * line added minutes earlier is what made the size of the gap visible enough
 * to go looking, which is exactly what a signal is for.
 *
 * Excluding it is safe, not a compromise: the corpus is GITIGNORED, no test
 * writes to it, and the guard's question is "did the code under test move" —
 * to which a bag of read-only fixtures can only ever answer no. A corpus that
 * DID change mid-run would be a person adding files by hand, which the file
 * COUNT in the verdict line still surfaces.
 */
const IGNORED_PATHS = ['tests/fixtures/wild'];

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
    if (IGNORED_PATHS.some((p) => full.endsWith(path.sep + p.split('/').join(path.sep)))) continue;
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
// Stage durations are recorded, not just exit codes. See DURATIONS below for
// why a slow run is a signal in its own right.
const TIMINGS = {};

function stage(name, cmd, args, { env = process.env } = {}) {
  console.log(`\n=== ${name} ===`);
  const t0 = Date.now();
  return new Promise((resolve) => {
    const done = (code) => {
      TIMINGS[name] = (Date.now() - t0) / 1000;
      console.log(`${name}: exit ${code} (${TIMINGS[name].toFixed(1)}s)`);
      resolve(code);
    };
    const child = spawn(cmd, args, { cwd: REPO, stdio: 'inherit', shell: false, env });
    child.on('close', (code) => done(code ?? 1));
    child.on('error', (err) => {
      console.error(`${name}: failed to launch — ${err.message}`);
      done(1);
    });
  });
}

/*
 * DURATIONS — "was this machine starved while the gate ran?"
 * ==========================================================================
 * The fingerprint guard answers "did the TREE move under this run" and voids
 * the verdict when it did. It cannot see the other way a run gets corrupted:
 * the MACHINE being oversubscribed. Twice now a run has gone RED at ~10.6m
 * against a ~6.5m baseline with no change to the tree, and passed clean on
 * re-run, while a second browser was being driven alongside it.
 *
 * ⚠️ WHY THIS IS NOT COSMETIC. A spurious RED is not a harmless false alarm.
 * It costs a re-run and a paragraph of reasoning about whether the change
 * broke something — and the third time, with a REAL failure buried inside a
 * slow run, the natural move is "probably contention, re-run". A flaky red
 * trains you to ignore reds. Naming the suspicion in the verdict line is what
 * stops that from being a judgement call made under annoyance.
 *
 * DELIBERATELY: it does not fail, and it does not auto-retry. The action is a
 * human one — distrust this verdict and re-run — exactly as exit 90 says the
 * tree moved rather than trying to recover from it.
 *
 * ⭐ THE BASELINE TAKES ANY RUN THAT EXECUTED EVERY STAGE, RED OR GREEN.
 * The first version took GREEN runs only, and that was wrong in the one way an
 * instrument must never be wrong: it deserted you at the first sign of trouble.
 * On a machine that has started misbehaving, the runs you need to compare
 * against are exactly the ones going red, so a green-only baseline goes silent
 * during the window it exists for. (PM's correction, 2026-07-30.)
 *
 * The real discriminator is not the verdict, it is whether every stage RAN. A
 * run that stopped early contributes a meaningless four-second "total" and
 * drags the median through the floor; a run where all four stages executed and
 * playwright merely ended on a failing assertion is a perfectly good duration
 * sample. Today's 13.3m RED read `lint 1s · seo 0s · core 2s · playwright
 * 795s` — every stage ran, and it was the most informative sample of the day.
 *
 * MEDIAN, not mean, so one odd outlier cannot move it far.
 */
/*
 * ⚠️ ESTABLISHED BEHAVIOUR OF THIS MACHINE, not an anecdote. Recorded here
 * because it is the first thing to check, and because the natural instinct on
 * a red gate is to bisect a change that is not the cause.
 *
 *   A SLOW RUN GOES SPURIOUSLY RED. Three for three on 2026-07-30: a run at
 *   roughly 2x baseline failed one or two tests that then passed in isolation,
 *   on a tree that had already gated green.
 *
 * Two causes have been traced, and both are fixable rather than facts of life:
 *   - the gate re-hashing 564 MB of wild-corpus fixtures every 4 seconds
 *     (fixed: IGNORED_PATHS above)
 *   - a second browser competing for the machine, from an MCP screenshot pass
 *     or leftover `serve` processes from a sweep
 *
 * SO: on a RED at materially over baseline, RE-RUN BEFORE INVESTIGATING. If it
 * goes green on a quiet machine, the first run gated nothing. If it fails the
 * same way twice, it is real and worth the bisect.
 *
 * The danger this note exists to hold off: once "probably contention" becomes
 * the reflex, a genuine failure buried in a slow run gets waved through. The
 * SLOW suffix is deliberately loud so the judgement is made from a number
 * rather than from irritation.
 */
const BASELINE_FILE = path.join(REPO, '.gate-baseline.json');
const BASELINE_KEEP = 10;
const SLOW_FACTOR = 1.5;

function readBaseline() {
  try {
    const j = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
    return Array.isArray(j.greenTotals) ? j.greenTotals.filter((n) => Number.isFinite(n) && n > 0) : [];
  } catch { return []; }
}

function median(xs) {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// Only called once every stage has a recorded duration. A VOID run never gets
// here (it exits first), and a run missing a stage timing is not a sample.
function recordSample(total) {
  if (Object.keys(TIMINGS).length < 4) return;
  try {
    const next = [...readBaseline(), total].slice(-BASELINE_KEEP);
    writeFileSync(BASELINE_FILE, JSON.stringify({ greenTotals: next }, null, 1));
  } catch { /* never let bookkeeping break a verdict */ }
}

// Returns a suffix for the verdict line, or '' when there is nothing to say.
// Silent until there is enough history to have an opinion: a baseline of one
// run is not a baseline, it is the previous run.
function slowSuffix(total) {
  const base = median(readBaseline());
  if (base === null || readBaseline().length < 3) return '';
  if (total <= base * SLOW_FACTOR) return '';
  return ` (SLOW: ${(total / 60).toFixed(1)}m vs ${(base / 60).toFixed(1)}m baseline`
    + ' — the machine was likely starved. RE-RUN BEFORE BELIEVING THIS)';
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
  // WHY SEO:CHECK IS A GATE STAGE (added 2026-07-28): CI's lint workflow runs it
  // and the gate did not, so the gate could be GREEN while CI went RED — which
  // makes it useless for the one job it exists to do, "is this safe to push".
  // Found the hard way: commit 24f54a7 added a <dialog> to index.html, the
  // generator embeds the app shell into all 12 SEO pages, and every one of them
  // was left stale. Three gate runs passed over that tree.
  const seo = await stage('SEO', 'npm', ['run', 'seo:check']);
  const core = await stage('CORE', 'npm', ['run', 'test:core']);
  // The authoritative sweep must own the server it judges. Reusing an
  // unrelated process makes the first half of the suite depend on somebody
  // else's lifecycle: when that owner exits, every remaining page.goto()
  // becomes ERR_CONNECTION_REFUSED. Targeted local runs may still reuse a
  // developer server; only the gate closes this escape hatch.
  const pw = await stage('PLAYWRIGHT', 'npx', ['playwright', 'test'], {
    env: { ...process.env, PDFLOKAL_GATE_OWNS_SERVER: '1' },
  });

  const { states, last } = watcher.stop();
  const total = Object.values(TIMINGS).reduce((a, b) => a + b, 0);
  const slow = slowSuffix(total);

  console.log('\n=== GATE END ===');
  console.log(`duration    ${(total / 60).toFixed(1)}m  (${Object.entries(TIMINGS).map(([k, v]) => `${k.toLowerCase()} ${v.toFixed(0)}s`).join(' · ')})`);
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

  // A RED run still executed all four stages, so its duration is a valid
  // sample. Recording it is what keeps the SLOW signal alive on a machine that
  // has started going red.
  recordSample(total);

  if (lint || seo || core || pw) {
    console.error(`\nVERDICT=RED (lint=${lint} seo=${seo} core=${core} playwright=${pw}) on stable tree ${last.head}${slow}`);
    process.exit(1);
  }

  console.log(`\nVERDICT=GREEN on stable tree ${last.head}${slow}`);
  process.exit(0);
}

main();
