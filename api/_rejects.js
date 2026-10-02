/*
 * PDFLokal — api/_rejects.js  (THE REJECTION COUNTER: what api/t.js throws away)
 * ============================================================================
 * Added 2026-10-02 (seat TODO "telemetry rejection counter"; the bench's
 * proposal of 2026-08-09, `git show 642722b:docs/proposal-telemetry-skew.md`).
 *
 * THE DEFECT IT ANSWERS. api/t.js drops anything it cannot trust and says
 * nothing: a missing thing looked identical to a perfect thing. Until the rate
 * was visible, "strict or tolerant validation?" meant inventing a threshold from
 * nothing. This counts the drops. It does NOT change what is dropped: every
 * verdict in t.js is exactly what it was, this only keeps a tally of them.
 *
 * WHERE IT GOES. One row per (Jakarta day, reason, event, prop) in the events
 * database's `telemetry_rejects` table (scripts/turso-events-migration.sql),
 * `n` incremented by upsert: a table that grows with the number of DISTINCT
 * causes, never with traffic, so a hostile client cannot grow it. Same database
 * as `events` on purpose: the read-only rail token already covers it, and the
 * daily watch (api/cron/watch.js) reads it into its row.
 *
 * ⚠️ CONTENT-BLIND, BY CONSTRUCTION AND NOT BY CARE. The rail is string-free by
 * law and a discarded payload is exactly the thing we have not decided to trust.
 * So a row can carry only members of closed lists we wrote:
 *   reason  one of ALL_REASONS (anything else is not counted at all)
 *   event   the event's name, ONLY when it is a key of SCHEMA and the failure
 *           happened inside a known event; '' otherwise. An unknown event's name
 *           is whatever the sender typed.
 *   prop    a prop key declared by the SCHEMA for that event, ONLY for
 *           missing_prop / bad_value; '' otherwise. An unknown prop's name is
 *           sender-controlled, so it is never recorded.
 * '' and not NULL: SQLite treats NULLs in a primary key as distinct, which
 * would turn the upsert into an insert per drop.
 *
 * UNITS. `n` counts EVENTS for the event-level reasons and REQUESTS for the
 * request-level ones (a request that never got as far as events). Read them
 * apart: REQUEST_REASONS below is the list of the latter.
 *
 * NEVER THROWS, never delays the 204 beyond the one awaited write, and a failed
 * write is logged as counts and a short code only (same law as the events log).
 */
import { SCHEMA, REJECT_REASONS } from '../js/core/telemetry-schema.js';
import { tursoInsert, placeholders } from './_turso.js';
import { jakartaDay } from './_watch.js';

// Request-level: the whole POST was discarded before any event was looked at.
export const REQUEST_REASONS = Object.freeze([
  'body_too_big',     // over the 32 KB cap
  'body_unreadable',  // the stream errored
  'bad_json',         // the body is not JSON
  'bad_session_id',   // envelope: session_id missing or not a UUID
  'bad_app_version',  // envelope: app_version missing or not a SHA / 'dev'
  'no_events',        // envelope: `events` missing, not an array, or empty
]);
// Event-level: one event of an otherwise-readable batch was discarded.
export const EVENT_REASONS = Object.freeze([
  'events_over_cap',  // past the 50th event of a batch (counted per event)
  'event_malformed',  // not an object, or its `event` is not a string
  ...REJECT_REASONS,  // unknown_event, unknown_prop, missing_prop, bad_value
]);
export const ALL_REASONS = Object.freeze([...REQUEST_REASONS, ...EVENT_REASONS]);

// The two reasons that name a prop, and the three that may name an event.
const NAMES_PROP = new Set(['missing_prop', 'bad_value']);
const NAMES_EVENT = new Set(['unknown_prop', 'missing_prop', 'bad_value']);

export function createTally() {
  const cells = new Map(); // `${reason}\u0000${event}\u0000${prop}` -> { reason, event, prop, n }
  return {
    // add(reason, { event, prop, n }) — event/prop are the SENDER'S values and are
    // only kept if they pass the closed-list tests; n defaults to 1.
    add(reason, { event, prop, n = 1 } = {}) {
      if (!ALL_REASONS.includes(reason)) return;
      if (!Number.isInteger(n) || n < 1) return;
      const knownEvent = NAMES_EVENT.has(reason) && typeof event === 'string' && Object.hasOwn(SCHEMA, event);
      const ev = knownEvent ? event : '';
      const pr = knownEvent && NAMES_PROP.has(reason) && typeof prop === 'string' && Object.hasOwn(SCHEMA[ev], prop) ? prop : '';
      const key = `${reason}\u0000${ev}\u0000${pr}`;
      const cell = cells.get(key);
      if (cell) cell.n += n; else cells.set(key, { reason, event: ev, prop: pr, n });
    },
    entries: () => [...cells.values()],
    get size() { return cells.size; },
  };
}

// The statement, exported so a test can run the REAL SQL against a real SQLite.
export function upsertSql(rowCount) {
  return `insert into telemetry_rejects (day, reason, event, prop, n) values ${placeholders(rowCount, 5)} `
    + 'on conflict (day, reason, event, prop) do update set n = telemetry_rejects.n + excluded.n';
}

/** Write the tally. One statement, one round trip, and only when there is
 *  something to say: a batch with no drops costs nothing extra. */
export async function flushRejects(tally, { url, token, override = null, now = Date.now() } = {}) {
  try {
    const rows = tally.entries();
    if (rows.length === 0) return;
    const day = jakartaDay(new Date(now));
    const out = await tursoInsert({
      url, token,
      sql: upsertSql(rows.length),
      values: rows.flatMap((r) => [day, r.reason, r.event, r.prop, r.n]),
      expected: rows.length,
      override,
    });
    // A table the migration has not created yet shows up here as sql_SQLITE_ERROR
    // on every dropped batch, until scripts/turso-events-migration.sql is applied.
    if (out.error) console.error(`[telemetry] reject-count FAILED error=${out.error} cells=${rows.length}`);
    else if (!out.dark && out.written !== rows.length) console.error(`[telemetry] reject-count SHORT written=${out.written ?? 'unknown'} cells_expected=${rows.length}`);
  } catch {
    // Counting what we drop must never be the thing that breaks the endpoint.
  }
}
