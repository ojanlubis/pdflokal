/*
 * SIGNED-DOCUMENT DETECTION — core/import.js detectSigned.
 * ============================================================================
 * A document carrying an e-meterai or a PAdES signature opens fine here and
 * exports to a file that fails verification, because export rebuilds with
 * pdf-lib and the digest covers bytes that no longer exist. detectSigned is
 * what lets the download sheet say so.
 *
 * ⚠️ WHAT THIS FILE CANNOT PROVE. There is no real Peruri E-METERAI on this
 * bench. tests/fixtures/nasty/bermeterai.pdf is a structurally shaped
 * signature dictionary written by scripts/gen-fixture-bermeterai.mjs — it
 * proves the detector reads the right bytes, and nothing about a real stamped
 * document. Do not upgrade a green here into "verified against an e-meterai".
 *
 * What DID come from the real world (2026-09-09, wild corpus, see the walk
 * below): one genuinely signed Indonesian government PDF —
 * `adbe.pkcs7.detached` with a DocMDP `/Type /SigRef` — is detected, and the
 * other 153 wild documents are not. So the detector is proven against a real
 * PAdES signature and still unproven against a Peruri meterai specifically.
 *
 * THE HALF THAT CARRIES THE INFORMATION is the negative side. A predicate that
 * returned `true` for everything would satisfy every assertion about the
 * signed fixture. So the corpus sweep below — every PDF fixture in the repo
 * reading `false` — is the test with power, and the tightening cases prove the
 * scan is a byte-range test rather than a substring search.
 * [[fixture-must-distinguish]]
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectSigned } from '../../js/core/import.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURES = path.join(root, 'tests/fixtures');
const bytesOf = (p) => new Uint8Array(fs.readFileSync(p));
const latin1 = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

// Every COMMITTED .pdf under tests/fixtures, at any depth. Kept as a live walk
// rather than a hand-written list: a fixture added tomorrow joins the control
// group automatically, which is the only way this sweep stays a corpus test.
//
// `wild/` is skipped because it is gitignored — it is not on CI, so an
// assertion over it would mean one thing on this machine and nothing at all in
// the pipeline. It was swept by hand instead, 2026-09-09: 154 real documents,
// exactly ONE flagged, and that one is a genuine `adbe.pkcs7.detached` DocMDP
// certification signature on a real Indonesian government PDF (a TRUE
// positive — see this file's own header for what is still unproven). 153
// ordinary real-world documents read false.
const SKIP_DIRS = new Set(['wild']);
function allPdfs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allPdfs(p));
    else if (entry.name.toLowerCase().endsWith('.pdf')) out.push(p);
  }
  return out;
}

test('detectSigned: the signed fixture reads as signed', () => {
  const signed = path.join(FIXTURES, 'nasty/bermeterai.pdf');
  assert.equal(detectSigned(bytesOf(signed)), true);
});

test('CONTROL: no unsigned fixture in the repo is flagged', () => {
  const pdfs = allPdfs(FIXTURES).filter((p) => path.basename(p) !== 'bermeterai.pdf');
  // Guard the instrument before believing its verdict: an empty sweep would
  // pass for free. [[assertions-over-empty-sets]]
  assert.ok(pdfs.length >= 20, `expected a real corpus, walked ${pdfs.length} PDFs`);
  const flagged = pdfs.filter((p) => detectSigned(bytesOf(p))).map((p) => path.relative(root, p));
  assert.deepEqual(flagged, [], 'these unsigned fixtures were flagged as signed');
});

test('detectSigned: the marker alone is not enough — a byte RANGE is', () => {
  // Bare marker, no array: a name that merely starts with it, and the literal
  // words inside a page of text about signatures. Both must read false, or the
  // scan is a substring search wearing a detector's name.
  assert.equal(detectSigned(latin1('%PDF-1.7\n/ByteRangeFoo 12\n')), false);
  assert.equal(detectSigned(latin1('%PDF-1.7\n(Lihat /ByteRange di spesifikasi) Tj\n')), false);
  assert.equal(detectSigned(latin1('%PDF-1.7\n/ByteRange /Indirect\n')), false);
  assert.equal(detectSigned(latin1('%PDF-1.7\n/ByteRange [/Name]\n')), false);
  // …and the real shape, in the spacings a writer may legally choose.
  assert.equal(detectSigned(latin1('/ByteRange[0 840 960 1200]')), true);
  assert.equal(detectSigned(latin1('/ByteRange [ 0 840 960 1200 ]')), true);
  assert.equal(detectSigned(latin1('/ByteRange\n[0 840 960 1200]')), true);
});

test('detectSigned: never throws, and garbage means "we do not know"', () => {
  // Same discipline as detectEncrypted: not knowing must not block an import
  // that would otherwise work, so every unreadable input answers false rather
  // than raising into the import loop.
  for (const input of [null, undefined, new Uint8Array(0), new Uint8Array([0x2f]), 'not bytes', 42, {}]) {
    assert.equal(detectSigned(input), false, `threw or flagged on ${String(input)}`);
  }
});
