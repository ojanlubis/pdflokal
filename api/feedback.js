/*
 * PDFLokal — api/feedback.js  (human-feedback sink — Vercel serverless, Node ESM)
 * ============================================================================
 * The BETA edit feature's thumbs loop (founder ruling 2026-07-22). Sibling of
 * api/t.js and DELIBERATELY separate from it: api/t.js validates against the
 * string-free SCHEMA and writes the machine-typed `events` table; THIS endpoint
 * accepts the ONE user-authored free field in the whole surface — a typed note
 * — and writes its OWN `feedback` table, so the events rail's "no string field
 * ever" invariant is never touched (spec-telemetry.md §2).
 *
 * Same discipline as api/t.js otherwise: POST-only, ZERO npm deps, we count raw
 * body bytes ourselves (bodyParser off), and EVERY case except a non-POST is a
 * fast 204 — a bad/oversized/misconfigured request is silently dropped, never a
 * 4xx/5xx the client has to handle (feedback must never degrade the editor).
 * Reuses the SAME Supabase project + service-role env vars api/t.js uses
 * (service key bypasses the feedback table's RLS; anon/authenticated get
 * nothing). Never stores IP or UA — neither is read from the request at all.
 */
export const config = { runtime: 'nodejs', api: { bodyParser: false } };

// Notes are short reactions, not essays — a much smaller cap than telemetry's
// 32KB batch. NOTE_MAX bounds the stored string; MAX_BODY_BYTES bounds the raw
// request so a hostile client can't stream megabytes at us before we slice.
const NOTE_MAX = 1000;
const MAX_BODY_BYTES = 8 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APP_VERSION_RE = /^[0-9a-f]{7,40}$|^dev$/;

// Reads the request body as text, capping at maxBytes. Returns null (never
// throws) on a stream error OR the cap being exceeded — both become a fast 204.
// (Same reader as api/t.js — kept inline rather than shared so each function
// stays a single self-contained file with no cross-import at the edge.)
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

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.status(204).end(); // malformed — drop, never error to the client
      return;
    }

    const sessionId = body?.session_id;
    const appVersion = body?.app_version;
    const rating = body?.rating;

    // session_id must be a real UUID, app_version the expected shape, rating
    // exactly 'up'|'down' — any failing means we can't trust the payload, so
    // it's dropped (204, never a 4xx).
    if (
      typeof sessionId !== 'string' || !UUID_RE.test(sessionId)
      || typeof appVersion !== 'string' || !APP_VERSION_RE.test(appVersion)
      || (rating !== 'up' && rating !== 'down')
    ) {
      res.status(204).end();
      return;
    }

    // note: optional, user-authored, trimmed + capped. This is the one free
    // field — never a document's content (the client only ever sends what the
    // user typed into the feedback box), and never rendered back anywhere.
    let note = null;
    if (typeof body?.note === 'string') {
      const t = body.note.trim().slice(0, NOTE_MAX);
      if (t) note = t;
    }

    // Stamp the SERVER's own deploy SHA (same reasoning as api/t.js: the client
    // can't stamp a real version — no build step — so it sends 'dev'; prefer
    // the env SHA, fall back to the already-validated client value locally).
    const serverSha = String(process.env.VERCEL_GIT_COMMIT_SHA || '').toLowerCase();
    const storedVersion = /^[0-9a-f]{7,40}$/.test(serverSha) ? serverSha : appVersion;

    const url = process.env.TELEMETRY_SUPABASE_URL;
    const key = process.env.TELEMETRY_SUPABASE_SERVICE_KEY;
    if (!url || !key) { res.status(204).end(); return; } // rail dark (env not set), never broken

    try {
      await fetch(`${url}/rest/v1/feedback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: key,
          Authorization: `Bearer ${key}`,
          Prefer: 'return=minimal',
        },
        body: JSON.stringify([{ session_id: sessionId, app_version: storedVersion, rating, note }]),
      });
    } catch {
      // Insert failed (network, Supabase down) — still a fast 204; the client
      // never learns, exactly like api/t.js.
    }

    res.status(204).end();
  } catch {
    res.status(204).end();
  }
}
