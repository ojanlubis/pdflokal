/*
 * PDFLokal — api/t.js  (telemetry sink — Vercel serverless function, Node ESM)
 * ============================================================================
 * spec-telemetry.md §1/§6. POST-only. Validates every event against the SAME
 * schema module the client uses (js/core/telemetry-schema.js) so client and
 * server can never drift on what's allowed. An off-schema event, or a
 * malformed envelope, is a DECLINE (dropped) — never a 400 that would fail
 * an otherwise-good batch for one bad event, or an error the client has to
 * handle. This endpoint responds 204 in every case except a non-POST method.
 *
 * ON NEON SINCE 2026-08-23 (seat `specs/spec-rail-to-neon.md`). It used to POST
 * to Supabase's PostgREST endpoint with a service-role key. PostgREST is a front
 * door built so BROWSERS can reach a database safely; pdflokal's browser never
 * went there and never will — this function is the only writer. So the door and
 * the RLS lock on it were paid for and never used, and the rail now speaks
 * plain SQL to Neon over HTTP.
 *
 * THE ZERO-DEPENDENCY LAW IS RELAXED HERE, and only here. `@neondatabase/
 * serverless` is pdflokal's first production dependency. The alternative was
 * Neon's raw HTTP endpoint, which would have kept plain `fetch` — but Neon
 * documents only the npm package, not the wire contract underneath it, and the
 * rail's whole failure mode is going quiet. A documented dependency beats an
 * undocumented protocol on the one path that must never break silently. The
 * CLIENT is untouched: still no build step, still no dependencies.
 *
 * Never stores IP or UA raw (spec §2) — neither is read from the request at
 * all; the client already sends a coarse, typed `device` prop where relevant.
 */

// bodyParser MUST be off: we enforce the ≤32KB cap by counting raw bytes off
// the stream ourselves. If Vercel's default JSON body-parser ran first, it
// would already have consumed the request stream by the time this handler
// sees `req`, and our own req.on('data') would never fire (readBody() would
// hang until the function times out). Same config key on Vercel's Node
// functions as Next.js API routes (@vercel/node implements the same bridge).
export const config = { runtime: 'nodejs', api: { bodyParser: false } };

import { neon } from '@neondatabase/serverless';
import { validateEvent } from '../js/core/telemetry-schema.js';

// ⚠️ TEST SEAM, and the ONLY reason anything but `handler` is exported here.
// tests/core/*.mjs swap in a recorder so the delivery tests assert on the SQL
// and its parameters — OUR contract — instead of on the driver's HTTP wire
// format, which is Neon's and undocumented. Stubbing global fetch would have
// worked and would have pinned us to a protocol we do not own. Pass null to
// restore the real driver.
let queryOverride = null;
export function __setQueryForTests(fn) { queryOverride = fn; }

// Returns (text, params) => node-postgres-shaped result. fullResults is on so
// the caller can read `rowCount` — see the SHORT-write check below, which is
// the positive control that makes "no error" mean something.
function makeQuery(dsn) {
  const sql = neon(dsn);
  return (text, params) => sql.query(text, params, { fullResults: true });
}

const MAX_EVENTS = 50;
const MAX_BODY_BYTES = 32 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APP_VERSION_RE = /^[0-9a-f]{7,40}$|^dev$/;

// Reads the request body as text, capping at maxBytes. Returns null (never
// throws) if the stream errors OR the cap is exceeded — both are treated as
// "can't use this request", which the handler turns into a fast 204.
function readBody(req, maxBytes) {
  return new Promise((resolve) => {
    let size = 0;
    let over = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (over) return;
      size += chunk.length;
      if (size > maxBytes) { over = true; return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  try {
    const raw = await readBody(req, MAX_BODY_BYTES);
    if (raw === null) { res.status(204).end(); return; } // over budget or unreadable — drop

    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      res.status(204).end(); // malformed envelope — drop, never error to the client
      return;
    }

    const sessionId = envelope?.session_id;
    const appVersion = envelope?.app_version;
    const events = Array.isArray(envelope?.events) ? envelope.events : null;

    // session_id must be a real UUID and app_version must match the expected
    // shape (a commit SHA or literally 'dev') — either failing means we
    // can't trust the envelope at all, so the WHOLE batch is dropped (per
    // spec: "if ALL are invalid or the envelope is malformed, 204 anyway").
    if (
      typeof sessionId !== 'string' || !UUID_RE.test(sessionId)
      || typeof appVersion !== 'string' || !APP_VERSION_RE.test(appVersion)
      || !events || events.length === 0
    ) {
      res.status(204).end();
      return;
    }

    // ⚠️ THE CLIENT'S OWN ANSWER WINS NOW, AND THAT IS A REVERSAL (2026-07-29).
    // This used to stamp the SERVER's deploy SHA unconditionally, because the
    // client could only ever say 'dev'. The cost was invisible until a real
    // incident: one 82-minute session on 2026-07-28 carried FOUR app_versions.
    // Nothing had reloaded — four deploys had simply landed while it was
    // flushing. The field described OUR deploy timeline, not the user's code,
    // so no failure could be attributed to the build that caused it.
    //
    // /api/rev now lets the client name the build it actually loaded, pinned at
    // page load. If it says a real SHA, believe it: it is closer to the running
    // code than anything this function can know at arrival time. Fall back to
    // the server SHA when the client still says 'dev' (first batches, offline,
    // or an old cached client) — that is the previous behaviour, kept as the
    // floor rather than the ceiling.
    //
    // Yes, a hostile client could post any 40-hex string. It is telemetry, it
    // is already shape-validated, and it carries no user content; the trade is
    // worth an answerable attribution question.
    const serverSha = String(process.env.VERCEL_GIT_COMMIT_SHA || '').toLowerCase();
    const clientSha = /^[0-9a-f]{7,40}$/.test(appVersion) ? appVersion : '';
    const storedVersion = clientSha || (/^[0-9a-f]{7,40}$/.test(serverSha) ? serverSha : appVersion);

    // PER-EVENT TIMESTAMPS (2026-07-28). This used to be ONE `new Date()` for the
    // whole batch, so every event in a flush shared a `ts` to the millisecond.
    // Intra-session ordering worked only by `id`, and anything reasoning about
    // INTERVALS — a funnel, an alarm, "how long between tap and commit" — was
    // reasoning about nothing.
    //
    // The client sends `dt`: milliseconds before ITS flush, never an absolute
    // clock reading. A client clock can be wrong by hours; a relative offset
    // cannot import that error. So the only clock that matters is this one:
    // ts = received - dt.
    //
    // Validated defensively because `dt` rides the envelope, NOT the props —
    // validateEvent never sees it. A missing, negative, non-finite or absurd
    // value collapses to 0 (= "now"), which degrades to the old behaviour for
    // that single event rather than writing a garbage row or dropping it.
    const capped = events.slice(0, MAX_EVENTS);
    const received = Date.now();
    const MAX_EVENT_AGE_MS = 6 * 60 * 60 * 1000;
    const rows = [];
    for (const e of capped) {
      if (!e || typeof e.event !== 'string') continue; // malformed single event — drop it, not the batch
      const { ok, clean } = validateEvent(e.event, e.props);
      if (!ok) continue; // off-schema single event — silently dropped, never 400s the batch
      const rawDt = Number(e.dt); // NOT `raw` — that is the request body above
      const dt = Number.isFinite(rawDt) ? Math.max(0, Math.min(MAX_EVENT_AGE_MS, Math.round(rawDt))) : 0;
      const ts = new Date(received - dt).toISOString();
      rows.push({ ts, session_id: sessionId, app_version: storedVersion, event: e.event, props: clean });
    }

    if (rows.length === 0) { res.status(204).end(); return; }

    // ⚠️ THE DARK BRANCH. No DATABASE_URL means every event is dropped and
    // NOTHING anywhere goes red — by design ("rail dark, never broken"), and
    // therefore the one thing a deploy order can get catastrophically wrong.
    // The env var must exist BEFORE the code that reads it ships. Vercel
    // injects it from the linked Neon store, so in practice it is present or
    // the store is gone.
    const dsn = process.env.DATABASE_URL;
    if (!dsn && !queryOverride) { res.status(204).end(); return; }

    // Awaited on purpose (not true fire-and-forget): a Vercel Node invocation
    // can be frozen the instant a response is sent, so an un-awaited insert
    // could silently never land. The round-trip (tens of ms) is invisible to
    // the browser — sendBeacon doesn't wait on this response.
    //
    // WHY A FAILED WRITE IS LOGGED AT ALL (2026-07-28 — telemetry suite class
    // C): this used to `await fetch(...)` and DISCARD the result. `fetch`
    // rejects only on a NETWORK failure, so an error RESPONSE — 401, 400,
    // 409, 5xx, quota — resolved normally, fell through, and we 204'd. The
    // single most likely failure mode could not even reach the catch. That is
    // the Jul 7-11 blackout's shape (~97% of analytics lost for five days,
    // every layer green), and it poisons our own instruments: the seat's
    // wild-liveness check reads what is IN the table, so if writes can fail
    // silently, a zero means "never emitted" OR "emitted and rejected" and
    // nothing can tell them apart.
    //
    // The driver removes that trap BY CONSTRUCTION — a rejected statement is a
    // thrown NeonDbError, not a resolved response — but the trap is not what
    // this catch is for. It is for being able to SAY how much was lost.
    //
    // ⭐ AND THE ROW COUNT IS CHECKED, which the PostgREST version could not do:
    // "no error" is only worth something next to "and it wrote what I gave it".
    // A silent partial write is the same blackout one layer smaller.
    //
    // CONTENT-BLIND, deliberately: counts, the error's NAME, and its SQLSTATE
    // only. Never `err.message` — a driver or Postgres error quotes the
    // offending VALUE back at you, and a log is a place row content must not
    // reach (same reasoning that kept the export-failure branch off
    // `err.message`). The 204 to the CLIENT is unchanged and must stay
    // unchanged: telemetry may never break or delay the editor.
    //
    // One statement, one round trip, up to 50 rows — parameterized, never
    // interpolated. Only the placeholder skeleton is built from the row count.
    const placeholders = rows
      .map((_, i) => `($${i * 5 + 1}::timestamptz,$${i * 5 + 2}::uuid,$${i * 5 + 3},$${i * 5 + 4},$${i * 5 + 5}::jsonb)`)
      .join(',');
    const params = rows.flatMap((r) => [r.ts, r.session_id, r.app_version, r.event, JSON.stringify(r.props)]);
    try {
      const query = queryOverride || makeQuery(dsn);
      const out = await query(
        `insert into events (ts, session_id, app_version, event, props) values ${placeholders}`,
        params,
      );
      const written = out?.rowCount;
      if (written !== rows.length) {
        console.error(`[telemetry] insert SHORT written=${written ?? 'unknown'} rows_expected=${rows.length}`);
      }
    } catch (err) {
      console.error(`[telemetry] insert FAILED error=${err?.name ?? 'Error'} code=${err?.code ?? 'none'} rows_dropped=${rows.length}`);
    }

    res.status(204).end();
  } catch {
    // Absolutely never surface a 5xx for a telemetry drop.
    res.status(204).end();
  }
}
