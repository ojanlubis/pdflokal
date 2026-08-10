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
 *
 * Increment D (spec-edit-fidelity-instrumentation.md, decisions.md
 * 2026-07-23/2026-07-27): optionally accepts TWO small PNG data URLs —
 * `sample_before`/`sample_after`, the pristine/stamped crop of one edited
 * line's own box — sent ONLY when the user tapped 👎 then Kirim and saw the
 * exact crops first. Never trust client-side caps: every check below
 * (prefix, base64 shape, per-crop byte cap, combined byte cap, all-or-
 * nothing pairing) is re-enforced here even though js/v2/telemetry.js and
 * js/core/feedback-sample.js already enforce the same caps client-side. Any
 * single thing off drops the WHOLE sample — rating+note still land, exactly
 * like a 👎 with no sample ever did. This file does NOT import
 * core/feedback-sample.js — same reason readBody() below is duplicated
 * rather than shared (this stays a single self-contained edge function, no
 * cross-import); keep the two constant sets in sync by hand if caps change.
 */
export const config = { runtime: 'nodejs', api: { bodyParser: false } };

// Notes are short reactions, not essays — a much smaller cap than telemetry's
// 32KB batch. NOTE_MAX bounds the stored string; MAX_BODY_BYTES bounds the raw
// request so a hostile client can't stream megabytes at us before we slice.
// MAX_BODY_BYTES is sized for the Increment D sample case (two base64 PNGs,
// ~54.6KB each at the 40KB-raw cap, ~109KB combined) plus JSON/field
// overhead and a safety margin — comfortably bounded either way, never
// unbounded.
const NOTE_MAX = 1000;
const MAX_BODY_BYTES = 200 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APP_VERSION_RE = /^[0-9a-f]{7,40}$|^dev$/;

// ---- Increment D: sample validation (mirrors js/core/feedback-sample.js) ----
const SAMPLE_DATA_URL_PREFIX = 'data:image/png;base64,';
const SAMPLE_MAX_BYTES = 40 * 1024;       // per crop
const SAMPLE_TOTAL_MAX_BYTES = 70 * 1024; // before + after combined (see core/feedback-sample.js's own WHY: deliberately < 2x)
const SAMPLE_BASE64_RE = /^[A-Za-z0-9+/]+=*$/;

// Decoded byte length of a `data:image/png;base64,...` string, without
// allocating a Buffer for the whole thing — string arithmetic only. Returns
// Infinity (never NaN, never throws) for anything not a plausible PNG data
// URL, so every caller can compare it against a cap with a plain `>`.
function dataUrlBytes(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(SAMPLE_DATA_URL_PREFIX)) return Infinity;
  const b64 = dataUrl.slice(SAMPLE_DATA_URL_PREFIX.length);
  if (b64.length === 0 || b64.length % 4 !== 0 || !SAMPLE_BASE64_RE.test(b64)) return Infinity;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

// Validates the {sample_before, sample_after} pair off a parsed body. Returns
// {before, after} when BOTH are present, well-formed, and within the caps
// (individually and combined) — otherwise null, meaning "send no sample",
// never "send half of it". A single field present without its pair is
// treated as malformed (never storable alone — the founder's own "before AND
// after, the defect IS the comparison" ruling, decisions.md 2026-07-27).
function validateSample(body) {
  const before = body?.sample_before;
  const after = body?.sample_after;
  if (before === undefined && after === undefined) return null; // no sample offered — fine
  if (typeof before !== 'string' || typeof after !== 'string') return null;
  const b = dataUrlBytes(before);
  const a = dataUrlBytes(after);
  if (!Number.isFinite(b) || !Number.isFinite(a)) return null;
  if (b > SAMPLE_MAX_BYTES || a > SAMPLE_MAX_BYTES) return null;
  if (b + a > SAMPLE_TOTAL_MAX_BYTES) return null;
  return { before, after };
}

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

    // Increment D: the opt-in before/after crop pair. validateSample() drops
    // the WHOLE sample (never a partial one) on anything off — the rating+
    // note above are already extracted and land regardless.
    const sample = validateSample(body);

    // THE CLIENT'S OWN ANSWER WINS — mirroring api/t.js's 2026-07-29 reversal,
    // which this file missed until the 2026-08-09 audit (finding 4). The same
    // js/v2/telemetry.js sends the same /api/rev-pinned SHA here as to /api/t;
    // preferring the server's arrival-time SHA instead named whatever deploy
    // happened to be live when the 👎 arrived, not the build the user ran —
    // the exact attribution defect t.js's reversal removed. Server SHA stays
    // as the floor for 'dev' (first seconds, offline, old cached clients).
    const serverSha = String(process.env.VERCEL_GIT_COMMIT_SHA || '').toLowerCase();
    const clientSha = /^[0-9a-f]{7,40}$/.test(appVersion) ? appVersion : '';
    const storedVersion = clientSha || (/^[0-9a-f]{7,40}$/.test(serverSha) ? serverSha : appVersion);

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
        body: JSON.stringify([{
          session_id: sessionId,
          app_version: storedVersion,
          rating,
          note,
          sample_before: sample?.before ?? null,
          sample_after: sample?.after ?? null,
        }]),
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
