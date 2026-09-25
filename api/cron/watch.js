/*
 * PDFLokal — api/cron/watch.js  (THE DAILY WATCH — Vercel Cron, 10:00 WIB)
 * ============================================================================
 * Reads the rail (Turso), evaluates the rail floor + A1-A6 (api/_watch.js),
 * writes ONE row to `routine_runs` (routine = 'vercel-watch'), and emails
 * Fauzan through tolongingetin ONLY when something fired. Quiet when healthy:
 * the row is the proof it ran, and the cloud routine reads it (routine brief
 * §6.6, the watchmen).
 *
 * Schedule: vercel.json `crons`. Declared in seat STATE.md (shared-scheduler
 * rule 2). KILL SWITCH: set WATCH_DISABLED=1 in Vercel env — the job then
 * records a 'disabled' row and does nothing else. No redeploy of code needed.
 *
 * FAIL LOUD: a rail it cannot read is itself the alarm, never a skipped check.
 * An unreachable Turso, or a refused query, fires 'unreadable' and emails.
 *
 * PRIVACY: counts only in the row. A4's note TEXT goes to his inbox and
 * nowhere else — never into routine_runs, never into a log.
 */
import { cronAuthorized } from '../_cron.js';
import { tursoQuery, tursoWrite, arg } from '../_turso.js';
import { BASELINE_DAYS, floorFromDays, evaluateAlarms, jakartaDay, jakartaMidnight } from '../_watch.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// seat specs/telemetry-alerts.md "Synthetic sessions": excluded from every read.
const MARKER = '00000000-0000-4000-8000-00000000c0de';

const events = () => ({ url: process.env.TURSO_EVENTS_URL, token: process.env.TURSO_EVENTS_TOKEN });
const feedback = () => ({ url: process.env.TURSO_FEEDBACK_URL, token: process.env.TURSO_FEEDBACK_TOKEN });
// The rail stores ts as TEXT; every bound is an explicit-millisecond ISO
// string (STATE: '…30.290Z' < '…30Z' in SQLite, so never bound without ms).
const ago = (now, ms) => new Date(now.getTime() - ms).toISOString();

async function one(db, sql, args) {
  const r = await tursoQuery({ ...db, sql, args: args.map(arg) });
  if (!r.ok) throw new Error(`read ${r.reason}`);
  return r.rows;
}

export async function measure(now = new Date()) {
  const ev = events();
  const since29 = jakartaMidnight(new Date(now.getTime() - (BASELINE_DAYS + 1) * DAY_MS));
  const today0 = jakartaMidnight(now);

  const days = await one(ev,
    `select substr(datetime(ts, '+7 hours'), 1, 10) as d, count(distinct session_id)
     from events where ts >= ? and ts < ? and session_id <> ? group by d`,
    [since29, today0, MARKER]);
  const floor = floorFromDays(new Map(days.map(([d, n]) => [d, Number(n)])), now);

  const [[a1]] = await one(ev,
    `select count(*) from events where event in ('ganti_tap','ganti_commit') and ts > ?`,
    [ago(now, 2 * DAY_MS)]);
  const [[a2n, a2low]] = await one(ev,
    `select count(*), coalesce(sum(json_extract(props,'$.weight_ratio') in ('lower','much-lower')),0)
     from events where event = 'visual_oracle' and ts > ?`, [ago(now, 7 * DAY_MS)]);
  const [[a3n, a3twin]] = await one(ev,
    `select count(*), coalesce(sum(json_extract(props,'$.path') = 'twin'),0)
     from events where event = 'insert' and ts > ?`, [ago(now, 7 * DAY_MS)]);
  const [[a6]] = await one(ev,
    `with s as (
       select session_id,
              sum(event = 'failure' and not (json_extract(props,'$.stage') = 'import'
                  and json_extract(props,'$.reason') in ('encrypted','corrupt'))) as hard_fails,
              sum(event = 'export') as exports,
              sum(event in ('ganti_commit','tool_use')) as work
       from events where ts > ? and session_id <> ? group by session_id)
     select count(*) from s where hard_fails > 0 and exports = 0 and work > 0`,
    [ago(now, DAY_MS), MARKER]);

  const fb = feedback();
  const notes = await one(fb,
    `select ts, rating, note from feedback where note is not null and ts > ? order by ts desc`,
    [ago(now, DAY_MS)]);
  const [[a5total, a5down]] = await one(fb,
    `select count(*), coalesce(sum(rating = 'down'),0) from feedback where ts > ?`,
    [ago(now, 7 * DAY_MS)]);

  return {
    floor,
    a1: Number(a1),
    a2: { n: Number(a2n), low: Number(a2low) },
    a3: { n: Number(a3n), twin: Number(a3twin) },
    a4: notes.length,
    a5: { total: Number(a5total), down: Number(a5down) },
    a6: Number(a6),
    notes,
  };
}

// tolongingetin: the machine's one rail to his inbox (routine brief §8.2).
// A key IS its inbox; there is no recipient field. One email per day at most:
// idem_key is the Jakarta date, so a retried cron cannot send twice.
async function email({ subject, body, day }) {
  const key = process.env.TOLONGINGETIN_KEY;
  if (!key) return 'no-key';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch('https://tolongingetin.id/api/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: subject.slice(0, 200), body: body.slice(0, 10000), idem_key: `pdflokal-watch:${day}` }),
      signal: ctl.signal,
    });
    if (r.ok) {
      const j = await r.json().catch(() => ({}));
      return j?.status === 'duplicate' ? 'duplicate' : 'ok';
    }
    return `http_${r.status}`;
  } catch (err) {
    return err?.name === 'AbortError' ? 'timeout' : 'network';
  } finally {
    clearTimeout(timer);
  }
}

async function record(status, findings, note) {
  const w = await tursoWrite({
    ...events(),
    sql: `insert into routine_runs (routine, status, window_hours, findings, note) values (?, ?, ?, ?, ?)`,
    args: ['vercel-watch', status, 24, JSON.stringify(findings), note].map(arg),
    expected: 1,
  });
  return w.ok ? 'ok' : w.reason;
}

export default async function handler(req, res) {
  if (!cronAuthorized(req)) {
    res.status(401).end();
    return;
  }
  const now = new Date();
  const day = jakartaDay(now);

  if (process.env.WATCH_DISABLED === '1') {
    const rec = await record('disabled', { day }, 'WATCH_DISABLED=1');
    res.status(200).json({ status: 'disabled', record: rec });
    return;
  }

  let m;
  try {
    m = await measure(now);
  } catch (err) {
    // The rail cannot be read. That IS the alarm.
    const reason = String(err?.message ?? 'unknown').slice(0, 60);
    const sent = await email({
      day,
      subject: 'pdflokal: 🔴 watch nggak bisa baca rail',
      body: `Watch harian pdflokal gagal membaca Turso (${reason}).\n\nSitusnya mungkin sehat. Yang mati bisa jadi instrumennya: token/URL Turso di Vercel, atau Turso-nya sendiri.\n\nDicek otomatis oleh /api/cron/watch.`,
    });
    const rec = await record('fail', { day, error: reason, email: sent }, 'rail unreadable');
    res.status(500).json({ status: 'fail', error: reason, email: sent, record: rec });
    return;
  }

  const fired = evaluateAlarms(m);
  const { notes, ...numbers } = m;
  const findings = { day, ...numbers, fired: fired.map((f) => f.id) };
  let sent = 'not-needed';
  if (fired.length) {
    const noteText = notes.length
      ? `\n\nCatatan feedback (24 jam), apa adanya:\n${notes.map(([ts, rating, note]) => `- ${ts.slice(0, 16).replace('T', ' ')} UTC ${rating === 'down' ? '👎' : '👍'} ${note}`).join('\n')}`
      : '';
    sent = await email({
      day,
      subject: `pdflokal: ${fired.length === 1 ? fired[0].line.split(':')[0] : `${fired.length} alarm`} (${day})`,
      body: `${fired.map((f) => f.line).join('\n')}${noteText}\n\nKemarin: ${m.floor.yesterday} sesi (median ${m.floor.baseline}).\nDicek otomatis oleh /api/cron/watch. Batasnya di specs/telemetry-alerts.md.`,
    });
  }
  findings.email = sent;
  const status = fired.some((f) => f.id === 'floor' || f.id === 'A1') ? 'fail' : fired.length ? 'warn' : 'ok';
  const rec = await record(status, findings, fired.length ? fired.map((f) => f.id).join(',') : 'quiet');
  res.status(200).json({ status, fired: findings.fired, email: sent, record: rec });
}
