/*
 * PDFLokal — api/_watch.js  (THE DAILY WATCH: the rules, kept pure)
 * ============================================================================
 * The rules api/cron/watch.js evaluates every morning. Moved here 2026-09-25
 * from two places that had stopped running: the rail-floor GitHub workflow
 * (never armed — its secret was never added) and the laptop alarm that read
 * seat `specs/telemetry-alerts.md` A1-A6 (fell out of the scheduler in late
 * August). Founder ask: "move the rails and alerts from github to vercel cron".
 *
 * THRESHOLDS ARE TUNED IN THE SPEC, NOT HERE. `specs/telemetry-alerts.md` is
 * the authority for A1-A6 and says why each number is what it is; the numbers
 * below copy it. Change the spec first, then this file, in one commit.
 *
 * Pure on purpose: every function takes numbers and returns a verdict, so the
 * tests drive the real decision without a database.
 */

// ---- the rail floor (was scripts/rail-floor.mjs) ---------------------------
// WHY 0.25: backtested over the rail's own 42 days (2026-07-20..08-30), each
// day against the median of its preceding 28 — 0.40 and 0.30 each cried wolf
// once on a real quiet day, 0.25 never did, and it still catches a dark rail
// (0) and a Jul-7-shaped 97% collapse. Re-run the backtest before changing it.
export const FLOOR_RATIO = 0.25;
export const MIN_BASELINE = 10;
export const BASELINE_DAYS = 28;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Median, not mean, so one viral day cannot raise the floor and mask a real
 *  collapse the following week. */
export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export function evaluateFloor(yesterdaySessions, priorSessions) {
  const baseline = median(priorSessions);
  const floor = Math.round(baseline * FLOOR_RATIO);
  // Below MIN_BASELINE a ratio is meaningless: a rail carrying 3 sessions a
  // day does not need an alarm, it needs users.
  if (baseline < MIN_BASELINE) return { baseline, floor, breached: false, skipped: true };
  return { baseline, floor, breached: yesterdaySessions < floor, skipped: false };
}

/** Y-M-D in Asia/Jakarta (fixed UTC+7, no DST). */
export function jakartaDay(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

/** Midnight WIB that starts `date`'s Jakarta day, as the rail's ts format. */
export function jakartaMidnight(date) {
  return new Date(`${jakartaDay(date)}T00:00:00.000+07:00`).toISOString();
}

/**
 * yesterday + the BASELINE_DAYS before it, from a {day: sessions} map.
 * A day with no events produces NO ROW, and that is precisely the dark rail:
 * missing reads as 0, never as "no data, skip".
 */
export function floorFromDays(byDay, now) {
  const day = jakartaDay(new Date(now.getTime() - DAY_MS));
  const yesterday = byDay.get(day) ?? 0;
  const prior = [];
  for (let i = BASELINE_DAYS; i >= 1; i -= 1) {
    prior.push(byDay.get(jakartaDay(new Date(now.getTime() - (i + 1) * DAY_MS))) ?? 0);
  }
  return { day, yesterday, ...evaluateFloor(yesterday, prior) };
}

// ---- A1-A6 (seat specs/telemetry-alerts.md) --------------------------------
/**
 * `m` is the measured numbers; returns the alarms that fired, worst first.
 * Each carries a short Indonesian line for the email, numbers only — never a
 * note's text (A4's notes travel separately, to the inbox only).
 */
export function evaluateAlarms(m) {
  const fired = [];
  if (m.floor && m.floor.breached) {
    fired.push({ id: 'floor', line: `Rail sepi: ${m.floor.yesterday} sesi kemarin, batas ${m.floor.floor} (median ${m.floor.baseline}). Situs mungkin sehat, cek apakah instrumennya mati.` });
  }
  if (m.a1 === 0) {
    fired.push({ id: 'A1', line: 'A1: nol ganti_tap/ganti_commit dalam 48 jam. Rail putus atau Edit nggak kepakai.' });
  }
  if (m.a6 >= 1) {
    fired.push({ id: 'A6', line: `A6: ${m.a6} sesi kerja beneran lalu gagal tanpa file (24 jam).` });
  }
  if (m.a2 && m.a2.n >= 10 && m.a2.low / m.a2.n > 0.20) {
    fired.push({ id: 'A2', line: `A2: ${m.a2.low}/${m.a2.n} visual_oracle lebih tipis dari aslinya (7 hari, batas 20%).` });
  }
  if (m.a3 && m.a3.n >= 10 && m.a3.twin / m.a3.n > 0.30) {
    fired.push({ id: 'A3', line: `A3: ${m.a3.twin}/${m.a3.n} insert jatuh ke font twin (7 hari, batas 30%).` });
  }
  if (m.a5 && m.a5.total >= 5 && m.a5.down / m.a5.total > 0.40) {
    fired.push({ id: 'A5', line: `A5: ${m.a5.down}/${m.a5.total} feedback jempol bawah (7 hari, batas 40%).` });
  }
  if (m.a4 >= 1) {
    fired.push({ id: 'A4', line: `A4: ${m.a4} catatan feedback baru (24 jam), teksnya di bawah.` });
  }
  return fired;
}
