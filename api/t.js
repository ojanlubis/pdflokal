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
 * No npm dependencies at all (task law: the client stays no-build-step; this
 * function is server code Vercel deploys, but it stays equally dependency-
 * free) — inserts go straight to Supabase's PostgREST endpoint via plain
 * fetch with the service-role key, which bypasses RLS (the migration leaves
 * the `events` table RLS-on-with-no-policies: service key in, anon/
 * authenticated get nothing).
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

import { validateEvent } from '../js/core/telemetry-schema.js';

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

    // Stamp the SERVER's own deployed commit SHA (Vercel system env) rather
    // than the client's self-report. WHY: js/v2/telemetry.js reads its version
    // from a <meta name="pdflokal-rev"> that nothing stamps (there is no build
    // step to inject it — the moat), so the client ALWAYS sends 'dev'. This
    // function, however, knows its own deploy SHA. Prefer it; fall back to the
    // already-validated client value on local/preview where the env var is
    // absent. (Requires Vercel "Automatically expose System Environment
    // Variables" — default on.)
    const serverSha = String(process.env.VERCEL_GIT_COMMIT_SHA || '').toLowerCase();
    const storedVersion = /^[0-9a-f]{7,40}$/.test(serverSha) ? serverSha : appVersion;

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

    const url = process.env.TELEMETRY_SUPABASE_URL;
    const key = process.env.TELEMETRY_SUPABASE_SERVICE_KEY;
    if (!url || !key) { res.status(204).end(); return; } // rail dark (env not configured yet), never broken

    // Awaited on purpose (not true fire-and-forget): a Vercel Node invocation
    // can be frozen the instant a response is sent, so an un-awaited insert
    // could silently never land. The extra Supabase round-trip (tens of ms)
    // is invisible to the browser — sendBeacon doesn't wait on this response.
    // WHY THE RESPONSE IS CHECKED (2026-07-28 — telemetry suite class C):
    // this used to be `await fetch(...)` with the result DISCARDED. `fetch`
    // rejects only on a NETWORK failure, so a Supabase error RESPONSE — 401
    // (bad key), 400 (schema/column mismatch), 409, 5xx, quota — resolved
    // normally, fell straight through, and we 204'd. The single most likely
    // failure mode was not merely unreported: it could not even reach the
    // catch below.
    //
    // That is the Jul 7-11 blackout's shape (~97% of analytics lost for five
    // days, every layer green). And it undermines our own instruments: the
    // seat's wild-liveness check reads what is IN the table, so if writes can
    // fail silently, a zero means "never emitted" OR "emitted and rejected"
    // and NOTHING can tell them apart. Every liveness result and alarm
    // threshold rests on arrival ≈ emission; this is what makes that
    // assumption checkable.
    //
    // The 204 to the CLIENT is unchanged and must stay unchanged — telemetry
    // may never break or delay the editor. What changed is that we are no
    // longer blind to ourselves.
    //
    // CONTENT-BLIND, deliberately: status code, row count, and the error's
    // NAME only. Never `err.message` and never the response body — a thrown
    // message or a PostgREST error can quote row content back into the log,
    // and a log is a place content must not reach either (same reasoning that
    // kept the export-failure branch off `err.message`).
    try {
      const r = await fetch(`${url}/rest/v1/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: key,
          Authorization: `Bearer ${key}`,
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(rows),
      });
      if (!r?.ok) {
        console.error(`[telemetry] insert REJECTED status=${r?.status ?? 'none'} rows_dropped=${rows.length}`);
      }
    } catch (err) {
      console.error(`[telemetry] insert FAILED error=${err?.name ?? 'Error'} rows_dropped=${rows.length}`);
    }

    res.status(204).end();
  } catch {
    // Absolutely never surface a 5xx for a telemetry drop.
    res.status(204).end();
  }
}
