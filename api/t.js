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

    const capped = events.slice(0, MAX_EVENTS);
    const ts = new Date().toISOString();
    const rows = [];
    for (const e of capped) {
      if (!e || typeof e.event !== 'string') continue; // malformed single event — drop it, not the batch
      const { ok, clean } = validateEvent(e.event, e.props);
      if (!ok) continue; // off-schema single event — silently dropped, never 400s the batch
      rows.push({ ts, session_id: sessionId, app_version: appVersion, event: e.event, props: clean });
    }

    if (rows.length === 0) { res.status(204).end(); return; }

    const url = process.env.TELEMETRY_SUPABASE_URL;
    const key = process.env.TELEMETRY_SUPABASE_SERVICE_KEY;
    if (!url || !key) { res.status(204).end(); return; } // rail dark (env not configured yet), never broken

    // Awaited on purpose (not true fire-and-forget): a Vercel Node invocation
    // can be frozen the instant a response is sent, so an un-awaited insert
    // could silently never land. The extra Supabase round-trip (tens of ms)
    // is invisible to the browser — sendBeacon doesn't wait on this response.
    try {
      await fetch(`${url}/rest/v1/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: key,
          Authorization: `Bearer ${key}`,
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(rows),
      });
    } catch {
      // Insert failed (network, Supabase down, etc.) — still a fast 204;
      // the client never learns telemetry failed (spec: never block/delay UX).
    }

    res.status(204).end();
  } catch {
    // Absolutely never surface a 5xx for a telemetry drop.
    res.status(204).end();
  }
}
