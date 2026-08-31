#!/usr/bin/env node
/*
 * PDFLokal — scripts/rail-floor.mjs  (THE RAIL'S ALARM)
 * ============================================================================
 * Fails loudly when the TELEMETRY RAIL goes quiet. Run daily by
 * .github/workflows/rail-floor.yml. Sibling of scripts/traffic-floor.mjs and
 * deliberately separate from it.
 *
 * WHY A SECOND ALARM — read this before deleting it as duplication:
 *   traffic-floor.mjs watches GA4. GA4 and the rail are DIFFERENT INSTRUMENTS
 *   and they die independently, so a green GA4 says nothing about the rail:
 *
 *     - api/t.js and api/feedback.js answer 204 when DATABASE_URL is missing.
 *       That is deliberate ("dark, never broken" — feedback must never degrade
 *       the editor), and it means a deploy landing before its env var exists
 *       drops every event with nothing going red anywhere.
 *     - Neon Free gives 100 CU-hours per project per month, metered on
 *       AWAKE-TIME, not requests. Exhausting it SUSPENDS the compute until the
 *       1st. The endpoints keep answering 204. The site keeps working. GA4
 *       keeps recording sessions. The rail is simply gone.
 *
 *   In both cases the product is fine and the instrument is dead, which is the
 *   worst shape a failure can have here. Only VOLUME can see it.
 *
 * WHY SESSIONS AND NOT EVENTS:
 *   Events per day swing far harder than sessions (measured 2026-08-25..31:
 *   209 -> 4,707 events/day while sessions moved 22 -> 188). An events floor
 *   would cry wolf on a quiet day and stay silent through a partial loss.
 *   Distinct session_id per day is the honest unit.
 *
 * WHY 0.25 AND NOT traffic-floor's 0.4 — MEASURED, NOT INHERITED:
 *   Backtested over the rail's own 42 days of history (2026-07-20..08-30),
 *   taking each day against the median of its preceding 28:
 *     ratio 0.40 -> 1 false alarm in 14 eligible days (2026-08-17, a real but
 *                   quiet day: 26 sessions against a median of 99)
 *     ratio 0.30 -> 1 false alarm
 *     ratio 0.25 -> 0
 *     ratio 0.20 -> 0
 *   One false alarm in fourteen days is how an alarm becomes noise and gets
 *   muted, which is the failure traffic-floor.yml's own comment warns about.
 *   0.25 still catches everything this exists for: at today's median of ~90 the
 *   floor is ~23/day, a dark rail is 0, and a Jul-7-shaped 97% collapse is ~3.
 *   Re-run the backtest before changing this number.
 *
 * FAIL-LOUD, NOT FAIL-QUIET: an unreachable database EXITS NONZERO with the
 * likely causes named. A monitor that silently stops monitoring is the exact
 * failure it exists to prevent — and "cannot reach the rail" is itself the
 * alarm condition, not an excuse to skip the check.
 */

import { neon } from '@neondatabase/serverless';

export const FLOOR_RATIO = 0.25;
export const MIN_BASELINE = 10;
export const BASELINE_DAYS = 28;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Median of a numeric array. Median, not mean, so one viral day cannot raise
 *  the floor and mask a real collapse the following week. */
export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * The whole decision, kept pure so a test can actually drive it.
 * `priorSessions` is the BASELINE_DAYS days before yesterday, oldest first.
 */
export function evaluateFloor(yesterdaySessions, priorSessions) {
  const baseline = median(priorSessions);
  const floor = Math.round(baseline * FLOOR_RATIO);
  // Below MIN_BASELINE a ratio is meaningless — a rail carrying 3 sessions/day
  // does not need an alarm, it needs users.
  if (baseline < MIN_BASELINE) {
    return { baseline, floor, breached: false, skipped: true };
  }
  return { baseline, floor, breached: yesterdaySessions < floor, skipped: false };
}

/** Y-M-D in Asia/Jakarta. WIB is a fixed UTC+7 with no DST, so day arithmetic
 *  by whole days is safe here. */
export function jakartaDay(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

const DAILY_SESSIONS_SQL = `
  select (ts at time zone 'Asia/Jakarta')::date::text as d,
         count(distinct session_id)::int as sessions
  from events
  where ts >= (date_trunc('day', now() at time zone 'Asia/Jakarta')
               - make_interval(days => $1::int)) at time zone 'Asia/Jakarta'
    and ts <   date_trunc('day', now() at time zone 'Asia/Jakarta') at time zone 'Asia/Jakarta'
  group by 1 order by 1
`;

/**
 * The volume half, with the query injected — the same test seam api/t.js and
 * api/feedback.js carry, and for the same reason: a monitor whose live path
 * has never run is not a monitor.
 */
export async function checkRail(query, now = new Date()) {
  const res = await query(DAILY_SESSIONS_SQL, [BASELINE_DAYS + 1]);
  const byDay = new Map(res.rows.map((r) => [r.d, Number(r.sessions)]));

  const day = jakartaDay(new Date(now.getTime() - DAY_MS));
  // A day with zero sessions produces NO ROW, and that is precisely the dark
  // rail. Missing must read as 0, never as "no data, skip".
  const yesterday = byDay.get(day) ?? 0;

  const prior = [];
  for (let i = BASELINE_DAYS; i >= 1; i -= 1) {
    prior.push(byDay.get(jakartaDay(new Date(now.getTime() - (i + 1) * DAY_MS))) ?? 0);
  }

  return { day, yesterday, ...evaluateFloor(yesterday, prior) };
}

async function main() {
  const dsn = process.env.RAIL_READONLY_URL || process.env.DATABASE_URL;
  if (!dsn) {
    console.error('\u2716 RAIL_READONLY_URL is not set.');
    console.error('  In CI: add it as a repository secret (Settings \u2192 Secrets \u2192 Actions).');
    console.error('  See the SETUP block in .github/workflows/rail-floor.yml.');
    process.exit(1);
  }

  const sql = neon(dsn);
  const query = (text, params) => sql.query(text, params, { fullResults: true });

  // Connectivity first, with its own error text. If this throws, the rail is
  // unreachable — which IS the alarm, so say what it usually means.
  try {
    await query('select 1', []);
  } catch (err) {
    console.error('\u{1F6A8} CANNOT REACH THE RAIL. This is the alarm, not a skipped check.');
    console.error(`   ${err?.message ?? err}`);
    console.error('   Likely causes, in the order they actually happen here:');
    console.error('     1. Neon compute SUSPENDED \u2014 Free plan CU-hours exhausted for the month.');
    console.error('     2. RAIL_READONLY_URL is wrong, revoked, or points at the old project.');
    console.error('     3. The Neon endpoint is down or the project was deleted.');
    console.error('   Note: api/t.js keeps answering 204 in all three, so the site looks fine.');
    process.exit(1);
  }

  const { day, yesterday, baseline, floor, breached, skipped } = await checkRail(query);

  console.log(`rail sessions ${day}: ${yesterday}`);
  console.log(`   ${BASELINE_DAYS}-day median: ${baseline}`);
  console.log(`   floor (${FLOOR_RATIO * 100}% of median): ${floor}`);

  if (skipped) {
    console.log(`\n\u23ED  baseline ${baseline} is below MIN_BASELINE ${MIN_BASELINE} \u2014 ratio not meaningful, no verdict.`);
    process.exit(0);
  }
  if (breached) {
    console.error(`\n\u{1F6A8} RAIL FLOOR BREACHED: ${yesterday} sessions vs a floor of ${floor}.`);
    console.error('   The SITE may be perfectly healthy \u2014 check GA4 before assuming an outage.');
    console.error('   If GA4 is fine and this is not, the INSTRUMENT died, not the product:');
    console.error('     \u2022 Neon compute suspended (Free plan CU-hours) \u2014 check the Neon console.');
    console.error('     \u2022 DATABASE_URL missing on the latest deploy \u2014 api/t.js 204s without it.');
    process.exit(1);
  }
  console.log(`\n\u2705 rail is alive: ${yesterday} \u2265 ${floor}.`);
  process.exit(0);
}

if (process.argv[1] && process.argv[1].endsWith('rail-floor.mjs')) {
  main().catch((err) => {
    console.error('\u{1F6A8} rail-floor failed to complete:', err?.stack ?? err);
    process.exit(1);
  });
}
