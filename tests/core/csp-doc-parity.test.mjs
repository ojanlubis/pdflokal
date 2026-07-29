/*
 * The security doc's CSP must equal the CSP we actually serve.
 *
 * WHY THIS EXISTS. `docs/security.md` carried a hand-copied CSP that had drifted
 * from `vercel.json`: it showed `'unsafe-eval'` in `script-src`, which the live
 * policy has never contained. Nobody mistyped it recently, it simply was never
 * re-checked after the policy tightened.
 *
 * ⚠️ THE DRIFT WAS IN THE DANGEROUS DIRECTION. The doc claimed MORE permission
 * than the browser grants, so it reads as reassurance for exactly the capability
 * that will fail. It was found while checking whether WebAssembly could run for
 * OCR: the doc says eval is allowed, the live policy blocks wasm outright, and
 * only the live policy is real. A doc that overstates permission does not create
 * a hole, it creates a confident wrong plan.
 *
 * This is the same defect shape as SPACE_GAP_FACTOR having a private copy in a
 * test file: one rule, two homes, no mechanism holding them together. The fix is
 * not "remember to update both" - it is this test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

function liveCsp() {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  for (const entry of cfg.headers || []) {
    for (const h of entry.headers || []) {
      if (String(h.key).toLowerCase() === 'content-security-policy') return h.value;
    }
  }
  return null;
}

// Directive name -> sorted source list, so formatting and ordering differences
// between the two files never fail the test but a real difference always does.
function parse(csp) {
  const out = new Map();
  for (const part of csp.split(';')) {
    const bits = part.trim().split(/\s+/).filter(Boolean);
    if (!bits.length) continue;
    out.set(bits[0], bits.slice(1).sort().join(' '));
  }
  return out;
}

function documentedCsp() {
  const md = fs.readFileSync(path.join(ROOT, 'docs/security.md'), 'utf8');
  const head = md.indexOf('## Content Security Policy');
  assert.ok(head !== -1, 'docs/security.md no longer documents a CSP at all');
  const open = md.indexOf('```', head);
  const close = md.indexOf('```', open + 3);
  assert.ok(open !== -1 && close !== -1, 'the CSP code block in docs/security.md is malformed');
  return md.slice(open + 3, close).trim();
}

test('1. the documented CSP matches the CSP vercel.json actually serves', () => {
  const live = liveCsp();
  assert.ok(live, 'vercel.json serves no Content-Security-Policy at all');
  const a = parse(live);
  const b = parse(documentedCsp());

  // VACUITY GUARD: an empty parse on either side would make every comparison
  // below pass for free, which is precisely how the drift survived this long.
  assert.ok(a.size >= 8, `parsed only ${a.size} live directives - the parser is broken`);
  assert.ok(b.size >= 8, `parsed only ${b.size} documented directives - the doc block is broken`);

  const names = [...new Set([...a.keys(), ...b.keys()])].sort();
  const diffs = names
    .filter((n) => a.get(n) !== b.get(n))
    .map((n) => `  ${n}\n    vercel.json: ${a.get(n) ?? '(absent)'}\n    docs:        ${b.get(n) ?? '(absent)'}`);

  assert.deepEqual(
    diffs, [],
    `docs/security.md and vercel.json disagree about the CSP:\n${diffs.join('\n')}\n\n`
    + 'vercel.json is the source of truth. Update the doc, never the other way round.',
  );
});

test('2. the claim that started this: no eval permission is granted today', () => {
  // Pinned explicitly because it is the specific thing the doc got wrong, and
  // because granting it is a real security decision that must be deliberate.
  // If someone adds 'wasm-unsafe-eval' to ship OCR, this test goes red and the
  // change has to be acknowledged rather than slipped in.
  const script = parse(liveCsp()).get('script-src') || '';
  for (const token of ["'unsafe-eval'", "'wasm-unsafe-eval'"]) {
    assert.equal(
      script.includes(token), false,
      `script-src now grants ${token}. That is a deliberate security decision (WebAssembly needs it), `
      + 'so update this test and docs/security.md together, and say so in the commit.',
    );
  }
});
