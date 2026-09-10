/*
 * THE ONE EVENT THE RAIL CANNOT SEND ITSELF.
 * ============================================================================
 * When a skewed asset set kills js/v2/app.js at module top level, js/v2/telemetry.js
 * dies with it — it is in the same graph. So the rail's blindness to this failure
 * is STRUCTURAL, not a missing call site: there is no live code left to call
 * tel(). Nine Sentry events over twelve days and zero rows on our own rail.
 *
 * `boot_failure` is therefore emitted by the inline boot guard in index.html's
 * <head>, with a hand-built envelope and no imports of any kind. That makes it
 * the ONLY event on the rail whose call site is not a tel() in js/, which has
 * three consequences this file exists to pin:
 *
 *   1. api/t.js validates it against the SAME schema module, so the envelope has
 *      to be right by construction — an off-schema event is DROPPED SILENTLY,
 *      never a 400. A wrong shape here would look exactly like the outage it is
 *      reporting. Test 5 runs the actual bytes the page would send through the
 *      actual handler.
 *   2. the session id is generated inline. api/t.js drops the WHOLE batch on a
 *      session_id that is not a UUID — and js/v2/telemetry.js's own non-crypto
 *      fallback (`s-<base36>`) has exactly that defect today, out of scope here
 *      but the reason test 6 exists.
 *   3. telemetry-liveness.test.mjs scans js/ for tel() call sites and would call
 *      this event dead. It is taught about the inline emitter there, with a
 *      positive assertion, rather than exempted.
 *
 * ⚠️ app_version is 'dev', so api/t.js stamps its own deploy SHA. That is the
 * honest answer and not a shortcut: /api/rev cannot be consulted (no module),
 * nothing stamps the meta tag, and for a SKEW event "the build the user loaded"
 * is not a single value — a mixture of builds is what the event reports.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { SCHEMA, validateEvent } from '../../js/core/telemetry-schema.js';
import handler, { __setQueryForTests } from '../../api/t.js';
import { ROOT, guardOf, runGuard, SKEW_MESSAGES } from './boot-guard-harness.mjs';

const KINDS = ['missing-export', 'null-dom', 'syntax'];
const ACTIONS = ['heal', 'repeat', 'declined'];

test('1. SCHEMA declares boot_failure, and every prop is an enum (no string may reach the rail)', () => {
  const shape = SCHEMA.boot_failure;
  assert.ok(shape, 'boot_failure is not declared in SCHEMA. api/t.js runs this same module, so an '
    + 'undeclared event is dropped server-side and the outage stays invisible — which is the exact '
    + 'failure the event exists to end.');
  assert.deepEqual(Object.keys(shape).sort(), ['action', 'kind']);
  assert.deepEqual(shape.kind, KINDS);
  assert.deepEqual(shape.action, ACTIONS);
  for (const [prop, descriptor] of Object.entries(shape)) {
    assert.ok(Array.isArray(descriptor), `boot_failure.${prop} is not an enum — spec §2 forbids a string-typed prop anywhere in SCHEMA`);
  }
});

test('2. every kind/action pair validates, and invented ones are refused', () => {
  for (const kind of KINDS) {
    for (const action of ACTIONS) {
      assert.equal(validateEvent('boot_failure', { kind, action }).ok, true, `${kind}/${action} rejected`);
    }
  }
  assert.equal(validateEvent('boot_failure', { kind: 'network', action: 'heal' }).ok, false, 'an invented kind was accepted');
  assert.equal(validateEvent('boot_failure', { kind: 'syntax', action: 'reload' }).ok, false, 'an invented action was accepted');
  // No optional props anywhere in this schema — a missing one fails the whole event.
  assert.equal(validateEvent('boot_failure', { kind: 'syntax' }).ok, false, 'a missing prop was accepted');
  assert.equal(validateEvent('boot_failure', { kind: 'syntax', action: 'heal', extra: 1 }).ok, false, 'an unknown prop was accepted');
});

/* ---------------------------------------------------------------------------
 * WHAT THE PAGE ACTUALLY SENDS. Not a description of it — the bytes.
 * ------------------------------------------------------------------------- */
function beaconsOf(g) {
  return g.calls.beacons.map((b) => ({ url: b.url, payload: JSON.parse(b.body) }));
}

test('3. the guard reports every branch it takes: heal, repeat, declined', async () => {
  const heal = runGuard();
  await heal.error(SKEW_MESSAGES[0]);
  assert.equal(heal.calls.reloads, 1);
  assert.equal(beaconsOf(heal).length, 1, 'the heal was not reported');
  assert.equal(beaconsOf(heal)[0].payload.events[0].props.action, 'heal');

  // REPEAT is the one that matters: the guard already healed this session and the
  // page died anyway, so the reload did NOT fix it. Without this value the rail
  // would show a heal and nothing after it, which reads as a success.
  const repeat = runGuard({ healedAlready: true });
  await repeat.error(SKEW_MESSAGES[0]);
  assert.equal(repeat.calls.reloads, 0, 'the guard healed twice');
  assert.equal(beaconsOf(repeat)[0].payload.events[0].props.action, 'repeat',
    'a second failure after a heal is not distinguishable from the first on the rail');

  for (const opts of [{ online: false }, { storage: 'throws' }]) {
    const declined = runGuard(opts);
    await declined.error(SKEW_MESSAGES[0]);
    assert.equal(declined.calls.reloads, 0);
    assert.equal(beaconsOf(declined).length, 1, `no report for ${JSON.stringify(opts)} — a decline is still a boot failure`);
    assert.equal(beaconsOf(declined)[0].payload.events[0].props.action, 'declined');
  }
});

test('4. kind is classified, not guessed — the two mechanisms stay distinguishable on the rail', async () => {
  const expected = [
    ['missing-export', SKEW_MESSAGES[0]],
    ['null-dom', SKEW_MESSAGES[1]],
    ['missing-export', SKEW_MESSAGES[2]],
    ['null-dom', SKEW_MESSAGES[3]],
    ['missing-export', SKEW_MESSAGES[4]],
    ['null-dom', SKEW_MESSAGES[5]],
  ];
  for (const [kind, msg] of expected) {
    const g = runGuard();
    await g.error(msg);
    assert.equal(beaconsOf(g)[0].payload.events[0].props.kind, kind,
      `"${msg}" was classified as ${beaconsOf(g)[0].payload.events[0].props.kind}, expected ${kind}. `
      + 'STALE-HTML and STALE-MODULE need different remedies; one bucket for both makes the rail '
      + 'unable to say which half is happening.');
  }
});

test('5. DELIVERY: the exact bytes the page sends are accepted and written by api/t.js', async () => {
  const g = runGuard();
  await g.error(SKEW_MESSAGES[0]);
  const beacon = g.calls.beacons[0];
  assert.equal(beacon.url, '/api/t', `the guard posts to ${beacon.url}, not the telemetry sink`);

  // Drive the REAL handler with the REAL payload. An off-schema event is dropped
  // silently by design, so "no error" proves nothing — the row count does.
  // /6, not /5: visitor_id joined the insert as a 6th column 2026-09-10. This
  // hand-built inline envelope never carries one (no imports, so no
  // localStorage read — see the file header), api/t.js stores NULL for it,
  // and the placeholder skeleton is still 6 columns wide either way.
  let captured = null;
  __setQueryForTests((text, params) => { captured = { text, params }; return { rowCount: params.length / 6 }; });
  try {
    const req = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      on(evt, cb) { if (evt === 'data') cb(Buffer.from(beacon.body, 'utf8')); if (evt === 'end') cb(); return this; },
    };
    const res = { code: null, status(c) { this.code = c; return this; }, end() { return this; } };
    await handler(req, res);
    assert.equal(res.code, 204);
  } finally {
    __setQueryForTests(null);
  }

  assert.ok(captured, 'api/t.js attempted NO insert for the boot beacon — the event was dropped, which '
    + 'is what an off-schema envelope looks like: no error, no 400, no row.');
  const [, sessionId, , event, props] = captured.params;
  assert.equal(event, 'boot_failure');
  assert.deepEqual(JSON.parse(props), { kind: 'missing-export', action: 'heal' });
  assert.match(sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
});

test('6. the session id is a real UUID even without crypto.randomUUID', async () => {
  // api/t.js's UUID_RE drops the WHOLE batch on a malformed session_id, and
  // randomUUID is absent on iOS Safari < 15.4 and in any non-secure context —
  // which is not an edge case for a guard that fires on flaky mobile networks.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (let i = 0; i < 50; i++) {
    const g = runGuard({ randomUUID: false });
    // eslint-disable-next-line no-await-in-loop
    await g.error(SKEW_MESSAGES[1]);
    const id = JSON.parse(g.calls.beacons[0].body).session_id;
    assert.match(id, UUID, `the fallback session id "${id}" is not a UUID, so api/t.js drops the whole batch`);
  }
});

test('7. the envelope is shaped the way api/t.js requires, field by field', async () => {
  const g = runGuard();
  await g.error(SKEW_MESSAGES[1]);
  const p = JSON.parse(g.calls.beacons[0].body);
  assert.deepEqual(Object.keys(p).sort(), ['app_version', 'events', 'session_id']);
  assert.match(p.app_version, /^[0-9a-f]{7,40}$|^dev$/, 'app_version fails api/t.js APP_VERSION_RE — the batch would be dropped');
  assert.equal(p.events.length, 1);
  assert.deepEqual(Object.keys(p.events[0]).sort(), ['dt', 'event', 'props']);
  assert.equal(p.events[0].dt, 0, 'dt must be 0 — the failure is happening right now, and a wrong dt writes the row at the wrong time');
});

test('8. an unrelated error is NOT reported — the beacon must not become a generic error rail', async () => {
  for (const msg of ['ResizeObserver loop completed with undelivered notifications.', 'Failed to fetch', '']) {
    const g = runGuard();
    // eslint-disable-next-line no-await-in-loop
    await g.error(msg);
    assert.deepEqual(g.calls.beacons, [], `the guard reported an unrelated error: ${JSON.stringify(msg)}`);
  }
  // And after load, when the guard is disarmed, nothing is reported at all.
  const g = runGuard();
  await g.load();
  await g.error(SKEW_MESSAGES[0]);
  assert.deepEqual(g.calls.beacons, [], 'the guard still reports after window load');
});

test('9. the emitter is in all 13 pages, byte-identical — the rail must not see only the landing', () => {
  const bodies = JSON.parse(fs.readFileSync(path.join(ROOT, 'seo/pages.json'), 'utf8'))
    .pages.map((p) => `${p.slug}.html`);
  for (const file of ['index.html', ...bodies]) {
    const g = guardOf(file);
    assert.equal(g.length, 1, `${file} carries ${g.length} boot guards`);
    assert.ok(g[0].includes('boot_failure'), `${file}'s boot guard sends no boot_failure event. Run \`npm run seo\`.`);
    assert.equal(g[0], guardOf('index.html')[0], `${file}'s guard has drifted from index.html's`);
  }
});
