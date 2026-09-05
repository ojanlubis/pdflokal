/*
 * failure.reason classification (headless) — core/failure-reason.js.
 *
 * THE POINT OF THIS FILE: on 2026-07-28 a real user hit 41 consecutive export
 * failures and the rail recorded `reason: 'unknown'` for every one, so we
 * learned nothing from 41 samples. Two separate defects produced that:
 *   1. download-sheet.js hard-coded the literal 'unknown'.
 *   2. The classifier only knew PDF.js's NAMED exception classes, while the
 *      export path throws pdf-lib errors — every one of which is a plain
 *      `Error`. Fixing (1) alone would have changed nothing.
 *
 * SO THE pdf-lib CASES GENERATE REAL ERRORS. They load genuinely broken bytes
 * through the actual vendored pdf-lib and classify whatever comes back. If a
 * vendor upgrade rewords its exceptions, these go RED — whereas hardcoding the
 * strings here would let the classifier silently rot back to 'unknown' for
 * everything while this file still passed. A test that cannot notice the thing
 * it exists to protect is the defect it is protecting against.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { failureReason, failureCause } from '../../js/core/failure-reason.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'window', 'define', 'globalThis',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports && Object.keys(module.exports).length ? module.exports : globalThis.PDFLib;
};
const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
const fixture = (n) => new Uint8Array(fs.readFileSync(path.join(root, 'tests/fixtures/nasty', n)));

// Throw for real, then classify what actually came out.
async function reasonFromLoading(bytes) {
  try {
    await PDFLib.PDFDocument.load(bytes);
    return null; // loaded fine — no error to classify
  } catch (err) {
    return { reason: failureReason(err), name: err.name };
  }
}

test('1. PDF.js named exceptions still classify by name alone', () => {
  assert.equal(failureReason({ name: 'PasswordException' }), 'encrypted');
  assert.equal(failureReason({ name: 'InvalidPDFException' }), 'corrupt');
  assert.equal(failureReason({ name: 'UnknownErrorException' }), 'unsupported');
  assert.equal(failureReason({ name: 'TimeoutError' }), 'timeout');
  assert.equal(failureReason({ name: 'QuotaExceededError' }), 'out-of-memory');
});

test('2. REAL pdf-lib encryption error is named, not swallowed as unknown', async () => {
  const got = await reasonFromLoading(fixture('terkunci.pdf'));
  assert.ok(got, 'terkunci.pdf must actually fail to load — otherwise this proves nothing');
  // The whole reason this file exists: pdf-lib gives us NOTHING to switch on.
  assert.equal(got.name, 'Error', 'if pdf-lib ever starts throwing named errors, simplify this module');
  assert.equal(got.reason, 'encrypted');
});

test('3. REAL pdf-lib parse failure classifies as corrupt, not unknown', async () => {
  // A truncated file: PDF.js reconstructs and renders it, pdf-lib refuses.
  // That divergence is exactly how a document can look fine for 82 minutes and
  // never once export.
  const whole = fs.readFileSync(path.join(root, 'tests/fixtures/nasty/surat-word.pdf'));
  const got = await reasonFromLoading(new Uint8Array(whole.subarray(0, whole.length - 40)));
  assert.ok(got, 'the truncated file must actually fail to load');
  assert.equal(got.name, 'Error');
  assert.equal(got.reason, 'corrupt');
});

test('4. CONTROL: a healthy document produces no error at all', async () => {
  // Guards against a classifier that "works" only because everything throws.
  assert.equal(await reasonFromLoading(fixture('surat-word.pdf')), null);
});

test('5. allocation ceilings are out-of-memory, whatever threw them', () => {
  assert.equal(failureReason(new RangeError('Invalid string length')), 'out-of-memory');
  assert.equal(failureReason(new RangeError('Array buffer allocation failed')), 'out-of-memory');
  assert.equal(failureReason({ name: 'Error', message: 'out of memory' }), 'out-of-memory');
});

test('6. a blown stack is NOT out-of-memory — it would send us hunting wrong', () => {
  assert.equal(failureReason(new RangeError('Maximum call stack size exceeded')), 'unsupported');
});

test('6b. a RangeError with no allocation evidence stays UNKNOWN, not invented', () => {
  // The first draft bucketed every RangeError as out-of-memory. RangeError is
  // also a bad array length, a bad radix, a bad date. Guessing there would put
  // a confident wrong cause on the rail — the same defect as a hard-coded
  // reason, only harder to spot because it varies.
  assert.equal(failureReason(new RangeError('bad stream in "Jalan Merdeka 17"')), 'unknown');
  assert.equal(failureReason(new RangeError('Invalid array length')), 'unknown');
});

test('7. genuinely unrecognised errors still say unknown — honestly', () => {
  assert.equal(failureReason(new Error('something we have never seen')), 'unknown');
  assert.equal(failureReason(new TypeError('x is not a function')), 'unknown');
  assert.equal(failureReason(null), 'unknown');
  assert.equal(failureReason(undefined), 'unknown');
  assert.equal(failureReason('a string, not an Error'), 'unknown');
});

test('8. every returned value is in the telemetry schema enum', async () => {
  // A reason the schema rejects is dropped at the edge — the event would
  // vanish rather than arrive mislabelled, which is harder to notice.
  const { SCHEMA } = await import('../../js/core/telemetry-schema.js');
  const allowed = new Set(SCHEMA.failure.reason);
  const probes = [
    { name: 'PasswordException' }, { name: 'InvalidPDFException' },
    { name: 'UnknownErrorException' }, { name: 'TimeoutError' },
    { name: 'QuotaExceededError' }, { name: 'AbortError' },
    new RangeError('Invalid string length'), new RangeError('Maximum call stack size exceeded'),
    new Error('is encrypted'), new Error('Failed to parse PDF document'), new Error('nope'),
  ];
  assert.ok(allowed.size > 0, 'schema enum must be non-empty or this assertion is vacuous');
  for (const p of probes) assert.ok(allowed.has(failureReason(p)), `${failureReason(p)} not in schema`);
});

// ---------------------------------------------------------------------------
// failureCause (2026-09-06): the two facts a developer reads first off a stack
// trace, as enums. `reason` was 'unknown' for the majority of real failures.
// ---------------------------------------------------------------------------

test('10. failureCause: name is the constructor collapsed to the enum, hint is the wording family', () => {
  assert.deepEqual(failureCause(new TypeError("Cannot read properties of undefined (reading 'width')")),
    { name: 'TypeError', hint: 'undefined-prop' });
  assert.deepEqual(failureCause(new Error('WinAnsi cannot encode "✓" (0x2713)')), { name: 'Error', hint: 'encode' });
  assert.deepEqual(failureCause(new RangeError('Array buffer allocation failed')), { name: 'RangeError', hint: 'alloc' });
  assert.deepEqual(failureCause(new RangeError('Maximum call stack size exceeded')), { name: 'RangeError', hint: 'stack' });
  assert.deepEqual(failureCause({ name: 'InvalidStateError', message: 'The source image could not be decoded.' }),
    { name: 'InvalidStateError', hint: 'image' });
  assert.deepEqual(failureCause(new Error('Failed to parse PDF document (line:0 col:0 offset=0): No PDF header found')),
    { name: 'Error', hint: 'parse' });
  assert.deepEqual(failureCause(new Error('Input document to `PDFDocument.load` is encrypted.')), { name: 'Error', hint: 'encrypted' });
  assert.deepEqual(failureCause({ name: 'PasswordException', message: 'No password given' }), { name: 'other', hint: 'encrypted' });
  assert.deepEqual(failureCause(new Error('something we have never seen')), { name: 'Error', hint: 'none' });
});

test('11. failureCause: garbage in, enum out — never a throw, never a string of the input', () => {
  assert.deepEqual(failureCause(null), { name: 'none', hint: 'none' });
  assert.deepEqual(failureCause(undefined), { name: 'none', hint: 'none' });
  assert.deepEqual(failureCause('a string, not an Error'), { name: 'other', hint: 'none' });
  assert.deepEqual(failureCause({ name: 'Rp 10.000 untuk Budi', message: 'Jalan Merdeka 17' }), { name: 'other', hint: 'none' });
});

test('12. failureCause: every value it can return is in the failure_cause schema enums, and the event validates', async () => {
  const { SCHEMA, validateEvent } = await import('../../js/core/telemetry-schema.js');
  const names = new Set(SCHEMA.failure_cause.name);
  const hints = new Set(SCHEMA.failure_cause.hint);
  assert.ok(names.size > 5 && hints.size > 5, 'enums must be non-empty or this is vacuous');
  const probes = [
    null, undefined, 'x', {}, new Error(''), new TypeError('x is not a function'), new RangeError('Invalid string length'),
    new SyntaxError('Unexpected token'), new ReferenceError('foo is not defined'),
    { name: 'QuotaExceededError', message: 'quota' }, { name: 'AbortError', message: 'The user aborted a request.' },
    { name: 'NetworkError', message: 'A network error occurred.' }, { name: 'SecurityError', message: 'Tainted canvases may not be exported.' },
    { name: 'DataCloneError', message: 'could not be cloned' }, { name: 'WeirdName', message: 'fetch failed' },
    new Error('Worker crashed: wasm compile'), new Error('HTTP 404'), new Error('Font glyph missing in cmap'),
    new Error('The image could not be decoded'), new Error('timeout of 10000ms exceeded'),
    // A message that quotes a document: the hint must be a family label, never the words.
    new Error('Cannot read properties of null (reading "Nama: Siti Rahayu")'),
  ];
  for (const p of probes) {
    const cause = failureCause(p);
    assert.ok(names.has(cause.name), `${cause.name} not in schema names`);
    assert.ok(hints.has(cause.hint), `${cause.hint} not in schema hints`);
    for (const stage of SCHEMA.failure_cause.stage) {
      assert.equal(validateEvent('failure_cause', { stage, ...cause }).ok, true);
    }
    const flat = JSON.stringify(cause);
    assert.ok(!/Siti|Rahayu|Merdeka|Budi/.test(flat), 'document words reached the cause');
  }
});

test('13. failureCause and the schema agree on the enum lists BOTH ways (no dead member either side)', async () => {
  // Every schema NAME other than the two sentinels must be reachable from a real error of that name,
  // and every HINT must be reachable from some message — otherwise the schema claims evidence the
  // classifier can never produce.
  const { SCHEMA } = await import('../../js/core/telemetry-schema.js');
  for (const name of SCHEMA.failure_cause.name) {
    if (name === 'other' || name === 'none') continue;
    assert.equal(failureCause({ name, message: '' }).name, name, `schema name ${name} is not recognised by failureCause`);
  }
  const samples = {
    encode: 'WinAnsi cannot encode', glyph: 'no glyph', alloc: 'out of memory', stack: 'Maximum call stack size exceeded',
    encrypted: 'is encrypted', parse: 'Failed to parse PDF', image: 'image decode', 'undefined-prop': 'x is not a function',
    worker: 'worker died', fetch: 'fetch failed', timeout: 'timed out', none: '',
  };
  for (const hint of SCHEMA.failure_cause.hint) {
    assert.ok(hint in samples, `schema hint ${hint} has no sample here — add one`);
    assert.equal(failureCause(new Error(samples[hint])).hint, hint, `hint ${hint} unreachable`);
  }
});
