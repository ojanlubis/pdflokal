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
 * Same discipline as api/t.js otherwise: POST-only, we count raw body bytes
 * ourselves (bodyParser off), and EVERY case except a non-POST is a fast 204 —
 * a bad/oversized/misconfigured request is silently dropped, never a 4xx/5xx
 * the client has to handle (feedback must never degrade the editor). Never
 * stores IP or UA — neither is read from the request at all.
 *
 * ON NEON SINCE 2026-08-23, alongside api/t.js and for the same reasons (seat
 * `specs/spec-rail-to-neon.md`): the browser never reached this database, so
 * PostgREST's whole job was work nobody asked for. Same `DATABASE_URL`, same
 * Neon project, its own table.
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

import { neon } from '@neondatabase/serverless';

// ⚠️ TEST SEAM — same one api/t.js carries, and duplicated for the same reason
// readBody() below is: each function stays a single self-contained file. Tests
// assert on the SQL and its parameters (ours) rather than the driver's HTTP
// wire format (Neon's, undocumented).
let queryOverride = null;
export function __setQueryForTests(fn) { queryOverride = fn; }

function makeQuery(dsn) {
  const sql = neon(dsn);
  return (text, params) => sql.query(text, params, { fullResults: true });
}

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

// Basic per-IP rate limiting (bounded to one warm instance — resets on cold
// start, but that's fine: its job is only to stop a scripted flood from
// exhausting the database connection pool between deploys/idle-outs, not to
// be a durable global limiter). Map is capped so a burst of distinct IPs
// can't grow it unbounded on a long-lived warm instance.
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 10;
const rateLimitHits = new Map();

function isRateLimited(ip) {
  if (rateLimitHits.size > 5000) rateLimitHits.clear();
  const now = Date.now();
  const hit = rateLimitHits.get(ip);
  if (!hit || now - hit.start > RATE_LIMIT_WINDOW_MS) {
    rateLimitHits.set(ip, { start: now, count: 1 });
    return false;
  }
  hit.count += 1;
  return hit.count > RATE_LIMIT_MAX;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  if (ip && isRateLimited(ip)) { res.status(429).end(); return; }

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

    const dsn = process.env.DATABASE_URL;
    if (!dsn && !queryOverride) { res.status(204).end(); return; } // rail dark, never broken

    // ⭐ THIS BRANCH USED TO BE BLIND, and it was blind for three weeks after
    // api/t.js stopped being (2026-07-28): `await fetch(...)` with the result
    // discarded, inside an EMPTY catch. A rejected insert resolved normally and
    // vanished; a network throw was swallowed without a word. The fix never
    // travelled from the sibling file, which is what happens when two files
    // hold one lesson by hand.
    //
    // It matters more here than for events, not less: a 👎 is rarer than a
    // doc_open by three orders of magnitude, so losing them is invisible in
    // aggregate — a dead feedback loop looks exactly like a well-liked
    // product. Content-blind for the same reason as api/t.js, and more
    // pointedly: this row carries a note the user TYPED. Never `err.message`.
    try {
      const query = queryOverride || makeQuery(dsn);
      const out = await query(
        `insert into feedback (session_id, app_version, rating, note, sample_before, sample_after)
         values ($1::uuid,$2,$3,$4,$5,$6)`,
        [sessionId, storedVersion, rating, note, sample?.before ?? null, sample?.after ?? null],
      );
      if (out?.rowCount !== 1) {
        console.error(`[feedback] insert SHORT written=${out?.rowCount ?? 'unknown'} rows_expected=1`);
      }
    } catch (err) {
      console.error(`[feedback] insert FAILED error=${err?.name ?? 'Error'} code=${err?.code ?? 'none'} rows_dropped=1`);
    }

    res.status(204).end();
  } catch {
    res.status(204).end();
  }
}
