/*
 * The rail's alarm must fire on a dead rail and stay silent on a quiet one.
 * An alarm that cries wolf gets muted, and a muted alarm is worse than none —
 * so the false-alarm case below is pinned against the rail's OWN history, not
 * against a number someone liked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { median, evaluateFloor, jakartaDay, jakartaMidnight, floorFromDays, evaluateAlarms, FLOOR_RATIO, MIN_BASELINE, BASELINE_DAYS }
  from '../../api/_watch.js';

// The rail's real daily distinct-session counts, 2026-07-20..08-30 (42 days),
// read from Neon on 2026-08-31. This is the fixture that chose FLOOR_RATIO.
const REAL_SERIES = [
  129, 141, 186, 154, 135, 110, 151, 227, 221, 247, 205, 155, 68, 40,
  99, 116, 99, 96, 61, 48, 35, 83, 99, 92, 99, 86, 37, 30,
  26, 78, 99, 88, 93, 71, 58, 85, 36, 106, 150, 189, 122, 100,
];

test('median resists a single viral day, which a mean would not', () => {
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([1, 2, 3, 4]), 3); // rounded midpoint
  assert.equal(median([]), 0);
  // one 10,000-session day must not drag the floor up
  assert.equal(median([90, 90, 90, 90, 10000]), 90);
});

test('THE CASE THIS EXISTS FOR: a dark rail is a breach, not missing data', () => {
  const prior = Array(BASELINE_DAYS).fill(90);
  const v = evaluateFloor(0, prior);
  assert.equal(v.breached, true, 'zero sessions against a healthy baseline must breach');
  assert.equal(v.skipped, false);
});

test('a Jul-7-shaped collapse (97% loss) breaches', () => {
  const prior = Array(BASELINE_DAYS).fill(90);
  assert.equal(evaluateFloor(3, prior).breached, true);
});

test('a healthy day does not breach', () => {
  const prior = Array(BASELINE_DAYS).fill(90);
  assert.equal(evaluateFloor(100, prior).breached, false);
});

test('REGRESSION: the configured ratio fires on NO day of the rail\'s own history', () => {
  const fired = [];
  for (let i = BASELINE_DAYS; i < REAL_SERIES.length; i += 1) {
    const v = evaluateFloor(REAL_SERIES[i], REAL_SERIES.slice(i - BASELINE_DAYS, i));
    if (v.breached) fired.push(`day ${i}: ${REAL_SERIES[i]} < floor ${v.floor} (median ${v.baseline})`);
  }
  assert.deepEqual(fired, [],
    `FLOOR_RATIO ${FLOOR_RATIO} cries wolf on real traffic — a muted alarm is worse than none`);
});

test('the quietest real day (26 vs a median of 99) is NOT an outage', () => {
  const prior = REAL_SERIES.slice(0, BASELINE_DAYS);
  const v = evaluateFloor(26, prior);
  assert.equal(v.baseline, 99);
  assert.equal(v.breached, false, '2026-08-17 was quiet, not dark — 0.4 got this wrong');
});

test('below MIN_BASELINE there is no verdict, and no alarm', () => {
  const v = evaluateFloor(0, Array(BASELINE_DAYS).fill(MIN_BASELINE - 1));
  assert.equal(v.skipped, true);
  assert.equal(v.breached, false, 'a rail with no traffic needs users, not an alarm');
});

test('the day boundary is Jakarta, not the runner\'s timezone', () => {
  // 2026-08-30T17:30Z is already 2026-08-31 in WIB (UTC+7).
  assert.equal(jakartaDay(new Date('2026-08-30T17:30:00Z')), '2026-08-31');
  assert.equal(jakartaDay(new Date('2026-08-30T16:59:00Z')), '2026-08-30');
});

// ── the day assembly (was checkRail; the SQL now lives in api/cron/watch.js) ──

const NOW = new Date('2026-08-31T04:00:00Z'); // 11:00 WIB on the 31st
const DAY_MS = 24 * 60 * 60 * 1000;
const dayOf = (n) => jakartaDay(new Date(NOW.getTime() - n * DAY_MS));

test('floorFromDays: a healthy rail reports alive and names the Jakarta day', () => {
  const m = new Map();
  for (let i = 1; i <= 29; i += 1) m.set(dayOf(i), 90);
  const r = floorFromDays(m, NOW);
  assert.equal(r.day, '2026-08-30');
  assert.equal(r.yesterday, 90);
  assert.equal(r.breached, false);
});

test('floorFromDays: yesterday MISSING is a dark rail, not missing data', () => {
  const m = new Map();
  for (let i = 2; i <= 29; i += 1) m.set(dayOf(i), 90); // every day EXCEPT yesterday
  const r = floorFromDays(m, NOW);
  assert.equal(r.yesterday, 0, 'a day with no events produces no row, it must read as zero');
  assert.equal(r.breached, true, 'the whole point: silence must be loud');
});

test('jakartaMidnight: the WIB day start, in the rail\'s ms ts format', () => {
  assert.equal(jakartaMidnight(new Date('2026-08-30T17:30:00Z')), '2026-08-30T17:00:00.000Z');
  assert.equal(jakartaMidnight(new Date('2026-08-30T16:59:00Z')), '2026-08-29T17:00:00.000Z');
});

// ── A1-A6: the thresholds copy seat specs/telemetry-alerts.md exactly ─────────

const QUIET = {
  floor: { breached: false }, a1: 5, a6: 0, a4: 0,
  a2: { n: 72, low: 10 }, a3: { n: 67, twin: 10 }, a5: { total: 20, down: 2 },
};
const ids = (m) => evaluateAlarms({ ...QUIET, ...m }).map((f) => f.id);

test('evaluateAlarms: a healthy day fires nothing', () => {
  assert.deepEqual(ids({}), []);
});

test('evaluateAlarms: each rule fires on its own condition, and only then', () => {
  assert.deepEqual(ids({ floor: { breached: true, yesterday: 0, floor: 23, baseline: 90 } }), ['floor']);
  assert.deepEqual(ids({ a1: 0 }), ['A1']);
  assert.deepEqual(ids({ a6: 1 }), ['A6'], 'A6 threshold is 1, ruled by Fauzan 2026-07-29');
  assert.deepEqual(ids({ a2: { n: 10, low: 3 } }), ['A2']);
  assert.deepEqual(ids({ a2: { n: 10, low: 2 } }), [], 'A2 is > 20%, not >=');
  assert.deepEqual(ids({ a2: { n: 9, low: 9 } }), [], 'A2 needs n >= 10');
  assert.deepEqual(ids({ a3: { n: 10, twin: 4 } }), ['A3']);
  assert.deepEqual(ids({ a3: { n: 10, twin: 3 } }), [], 'A3 is > 30%');
  assert.deepEqual(ids({ a5: { total: 5, down: 3 } }), ['A5']);
  assert.deepEqual(ids({ a5: { total: 4, down: 4 } }), [], 'A5 needs total >= 5');
  assert.deepEqual(ids({ a4: 1 }), ['A4'], 'a human wrote words: always');
});

test('evaluateAlarms: the rail-dead signals come first', () => {
  assert.deepEqual(ids({ a4: 2, a1: 0, floor: { breached: true, yesterday: 0, floor: 23, baseline: 90 } }), ['floor', 'A1', 'A4']);
});
