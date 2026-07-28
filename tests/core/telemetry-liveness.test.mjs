/*
 * TELEMETRY SUITE — class A: LIVENESS.
 * ============================================================================
 * "Every declared event is actually emitted by some code path."
 *
 * WHY THIS EXISTS: on 2026-07-28, `block_edit` was declared in SCHEMA, had a
 * VALID_PROPS fixture in telemetry-schema.test.mjs, and was documented in
 * ../specs/spec-telemetry.md as "Rung D's evidence, live from day one of the
 * merge". **Nothing anywhere emitted it.** We had been gathering evidence for
 * the paragraph-reflow decision and gathering ZERO — with the validator green,
 * the fixture green, and every test passing.
 *
 * That is this project's recurring defect at instrumentation level: the schema
 * agrees, the fixture agrees, and the data does not exist. A declared-but-dead
 * event is worse than a missing one, because it makes the schema CLAIM evidence
 * we do not have about a decision that is still open. It also violates the
 * schema's own stated law — "anything not emitted by code does not enter an
 * enum" — which was written down and then not enforced by anything.
 *
 * This is the first class of the telemetry suite because the suite is the
 * precondition for the auto-push policy: "the telemetry catches everything" has
 * to be CHECKABLE before it can be leaned on. It is deliberately the cheapest
 * class, so the harness proves itself before harder classes rest on it.
 *
 * A STATIC SOURCE SCAN, on purpose. A runtime test can only prove that the
 * paths a test happens to drive emit something; it can never prove the absence
 * of a dead declaration. The trade is that this test knows about `tel('name')`
 * as a syntactic shape — verified 2026-07-28 that every call site in js/ uses a
 * string literal (the only non-literal is tel's own definition). If someone
 * introduces a computed event name, THIS TEST GOES RED rather than silently
 * under-counting, which is the correct failure direction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SCHEMA } from '../../js/core/telemetry-schema.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const JS = path.join(ROOT, 'js');
const TEL_DEF = path.join(JS, 'v2', 'telemetry.js'); // defines tel(); not a call site

function sourceFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'vendor') continue; // third-party bundles, not our call sites
    const full = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(full, out);
    else if (e.isFile() && e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// Comments in this repo discuss `tel()` in prose constantly (the header above
// does it twice). A scanner that reads prose as code reports phantom call sites
// — and a noisy assertion is one somebody eventually deletes, which is the
// failure mode this file's own message warns about. Strip block comments and
// whole-line comments before scanning. Deliberately NOT a full parser: it
// over-strips nothing that could contain a real call, because a `tel(...)` on
// the same line as trailing prose is still seen.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
}

// Every `tel(` occurrence, split into literal event names and anything else.
function scanCallSites() {
  const literals = new Map(); // event -> [relative file paths]
  const nonLiteral = [];
  for (const f of sourceFiles(JS)) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/\btel\(\s*([^),]*)/g)) {
      const arg = m[1].trim();
      const lit = /^'([a-z_]+)'$/.exec(arg);
      if (lit) {
        if (!literals.has(lit[1])) literals.set(lit[1], []);
        literals.get(lit[1]).push(path.relative(ROOT, f));
      } else if (f !== TEL_DEF) {
        nonLiteral.push(`${path.relative(ROOT, f)}: tel(${arg}…`);
      }
    }
  }
  return { literals, nonLiteral };
}

test('LIVENESS: every SCHEMA event is emitted by at least one code path', () => {
  const { literals } = scanCallSites();
  const declared = Object.keys(SCHEMA);
  const dead = declared.filter((e) => !literals.has(e));

  assert.deepEqual(
    dead, [],
    `these events are DECLARED but emitted by nothing — either wire them or delete them from SCHEMA.\n`
    + `A declared-but-dead event makes the schema claim evidence we do not have.\n`
    + `  dead: ${dead.join(', ')}`,
  );
});

test('LIVENESS: every tel() call site names a declared event (typos caught statically)', () => {
  const { literals } = scanCallSites();
  const undeclared = [...literals.keys()].filter((e) => !(e in SCHEMA));

  assert.deepEqual(
    undeclared, [],
    `these events are emitted but not declared in SCHEMA — validateEvent would drop them at\n`
    + `runtime, silently, so the data would simply never arrive.\n`
    + `  ${undeclared.map((e) => `${e} (${literals.get(e).join(', ')})`).join('\n  ')}`,
  );
});

test('LIVENESS: no computed event names — the static scan must stay able to see every call site', () => {
  const { nonLiteral } = scanCallSites();
  assert.deepEqual(
    nonLiteral, [],
    `tel() called with a non-literal event name. The liveness scan above cannot see these, so it\n`
    + `would silently UNDER-count coverage and report dead events as live (or vice versa).\n`
    + `If a computed name is genuinely needed, this test has to grow a way to resolve it —\n`
    + `do not just delete the assertion.\n  ${nonLiteral.join('\n  ')}`,
  );
});

// The guard's own falsifiability: if the scanner silently found nothing (a bad
// path, a changed call shape, a rename), every assertion above would pass
// vacuously — dead events look live when the "declared" set is empty, and typos
// look clean when the "emitted" set is empty. Both directions are pinned.
test('LIVENESS: the scan is actually finding things — the assertions above cannot pass vacuously', () => {
  const { literals } = scanCallSites();
  assert.ok(Object.keys(SCHEMA).length >= 10, `SCHEMA looks empty (${Object.keys(SCHEMA).length}) — did the import break?`);
  assert.ok(literals.size >= 10, `found only ${literals.size} emitted events — did the scan path or the tel() call shape change?`);
  // A known-good spot check: doc_open is the oldest event on the rail and is
  // emitted from the import path. If this stops matching, the scanner moved.
  assert.ok(literals.has('doc_open'), 'doc_open not found by the scan — the scanner is broken, not the code');
});
