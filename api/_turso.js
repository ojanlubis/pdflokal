/*
 * PDFLokal — api/_turso.js  (Turso / libSQL writer, shared by t.js and feedback.js)
 * ============================================================================
 * Added 2026-09-16 for the dual-write soak; since 2026-09-25 the rail's ONLY
 * store (Neon removed after the history was backfilled and fingerprint-
 * verified). Neon Free billed AWAKE-TIME and pdflokal writes thin, constant,
 * all day, the worst possible shape for that meter; Turso bills rows.
 *
 * ⭐ ZERO DEPENDENCIES. Turso documents its SQL-over-HTTP protocol, so this is
 * plain `fetch`. (Neon's driver was the one npm dependency pdflokal ever took,
 * because Neon documented only the package, not the wire. It left with Neon.)
 *
 * ⚠️⚠️ THE TRAP THIS FILE EXISTS TO AVOID — MEASURED 2026-09-16 AGAINST THE REAL
 * DATABASE, not read off a doc. A REJECTED STATEMENT COMES BACK AS **HTTP 200**:
 *
 *     HTTP_STATUS=200
 *     {"results":[{"type":"error","error":{
 *        "message":"SQLite error: CHECK constraint failed: events_session_id_shape_chk",
 *        "code":"SQLITE_CONSTRAINT"}}, ...]}
 *
 * So `fetch(...).then(r => r.ok)` reports SUCCESS for a write the database
 * refused. That is the EXACT shape of the Jul 7-11 blackout (~97% of analytics
 * lost for five days, every layer green) that `api/t.js` describes in its own
 * header — the version that `await fetch(...)` and discarded the result. Walking
 * back into it while migrating away from it would be the whole joke.
 *
 * Therefore THREE gates, and all three are load-bearing:
 *   1. transport  — `r.ok`, catches network and 4xx/5xx
 *   2. STATEMENT  — every `results[i].type === 'ok'`   ← the blackout gate
 *   3. COUNT      — `affected_row_count === expected`  ← a partial write is the
 *                   same blackout one layer smaller
 *
 * CONTENT-BLIND, deliberately, same law as the Neon path: counts and the error's
 * CODE only. Never the error `message` — SQLite quotes the offending VALUE back
 * at you, and a log is a place row content must not reach.
 *
 * NEVER THROWS. The caller's 204 to the browser must be unaffected by anything
 * that happens in here, in either direction.
 */

// The CLI and Vercel hand out `libsql://host`. The HTTP API is the same host
// over https. Accept either spelling so a copied-and-pasted value cannot
// silently produce an unreachable URL.
export function toHttpUrl(url) {
  if (!url) return null;
  const trimmed = String(url).trim().replace(/\/+$/, '');
  if (trimmed.startsWith('libsql://')) return `https://${trimmed.slice('libsql://'.length)}`;
  if (trimmed.startsWith('https://')) return trimmed;
  if (trimmed.startsWith('http://')) return null; // refuse plaintext, never downgrade a token
  return `https://${trimmed}`;
}

// A libSQL HTTP arg. `null` must be sent as {"type":"null"} — omitting it or
// sending JSON null is not the same thing and binds wrongly.
export function arg(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'number') return { type: 'float', value: v };
  return { type: 'text', value: String(v) };
}

/**
 * Execute ONE parameterised statement and verify it actually wrote.
 * Returns { ok, written, reason } and never throws.
 *
 * `reason` is a short machine-readable token for the log — never free text from
 * the database.
 */
export async function tursoWrite({ url, token, sql, args, expected, timeoutMs = 4000 }) {
  const endpoint = toHttpUrl(url);
  // DARK BRANCH: no config means no write and no noise ("rail dark, never
  // broken"). The daily watch is what notices a rail that went dark.
  if (!endpoint || !token) return { ok: false, written: 0, reason: 'unconfigured' };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${endpoint}/v2/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{ type: 'execute', stmt: { sql, args } }, { type: 'close' }],
      }),
      signal: ctl.signal,
    });

    // GATE 1 — transport.
    if (!res.ok) return { ok: false, written: 0, reason: `http_${res.status}` };

    const body = await res.json();
    const results = Array.isArray(body?.results) ? body.results : [];
    if (results.length === 0) return { ok: false, written: 0, reason: 'no_results' };

    // GATE 2 — THE BLACKOUT GATE. A refused statement arrives inside a 200.
    const bad = results.find((r) => r?.type === 'error');
    if (bad) return { ok: false, written: 0, reason: `sql_${bad?.error?.code ?? 'unknown'}` };

    // GATE 3 — a silent partial write is the same blackout one layer smaller.
    const exec = results.find((r) => r?.response?.type === 'execute');
    const written = exec?.response?.result?.affected_row_count ?? null;
    if (written !== expected) {
      return { ok: false, written: written ?? 0, reason: `short_${written ?? 'unknown'}` };
    }
    return { ok: true, written, reason: null };
  } catch (err) {
    // AbortError included — a slow Turso must never hold the function open.
    return { ok: false, written: 0, reason: err?.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The rail's one insert path (api/t.js, api/feedback.js) since Neon was
 * removed 2026-09-25. Returns { dark, written, error } and never throws:
 *   dark     no Turso config — the deliberate "rail dark, never broken" branch
 *   error    a short token (transport, statement code, or a thrown error's
 *            NAME) — never a message, which can quote row content
 *   written  rows the store says it wrote; the caller compares to expected
 *
 * `override` is each endpoint's test seam: tests intercept at OUR contract,
 * the SQL and its plain values, and return { rowCount } or throw.
 */
export async function tursoInsert({ url, token, sql, values, expected, override = null }) {
  if (override) {
    try {
      const out = await override(sql, values);
      return { dark: false, written: out?.rowCount, error: null };
    } catch (err) {
      return { dark: false, written: 0, error: err?.name ?? 'Error' };
    }
  }
  const out = await tursoWrite({ url, token, sql, args: values.map(arg), expected });
  if (out.ok) return { dark: false, written: out.written, error: null };
  if (out.reason === 'unconfigured') return { dark: true, written: 0, error: null };
  const short = /^short_(\d+|unknown)$/.exec(out.reason ?? '');
  if (short) return { dark: false, written: short[1] === 'unknown' ? undefined : Number(short[1]), error: null };
  return { dark: false, written: 0, error: out.reason };
}

// Builds `values (?,?,?),(?,?,?)...` for a multi-row insert. Only the
// placeholder skeleton is built from the row count; every value is bound.
export function placeholders(rowCount, colCount) {
  return Array.from({ length: rowCount }, () => `(${Array(colCount).fill('?').join(',')})`).join(',');
}

// A libSQL HTTP cell back to a JS value. Integers arrive as STRINGS (they may
// exceed 2^53); callers that need a number convert explicitly.
function cellValue(cell) {
  if (!cell || cell.type === 'null') return null;
  if (cell.type === 'float') return Number(cell.value);
  return cell.value ?? null;
}

/**
 * Run ONE read and return every row as an array of values, in column order.
 * Returns { ok, rows, cols, reason } and never throws. Same two gates as
 * tursoScalar. Used by the cron jobs (api/cron/), which read many rows — an
 * empty result is `rows: []` and ok, because "no rows" is an answer here.
 */
export async function tursoQuery({ url, token, sql, args = [], timeoutMs = 20000 }) {
  const endpoint = toHttpUrl(url);
  if (!endpoint || !token) return { ok: false, rows: [], cols: [], reason: 'unconfigured' };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${endpoint}/v2/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{ type: 'execute', stmt: { sql, args } }, { type: 'close' }],
      }),
      signal: ctl.signal,
    });
    if (!res.ok) return { ok: false, rows: [], cols: [], reason: `http_${res.status}` };

    const body = await res.json();
    const results = Array.isArray(body?.results) ? body.results : [];
    const bad = results.find((r) => r?.type === 'error');
    if (bad) return { ok: false, rows: [], cols: [], reason: `sql_${bad?.error?.code ?? 'unknown'}` };

    const exec = results.find((r) => r?.response?.type === 'execute');
    if (!exec) return { ok: false, rows: [], cols: [], reason: 'no_results' };
    const result = exec.response.result;
    return {
      ok: true,
      cols: (result.cols ?? []).map((c) => c.name),
      rows: (result.rows ?? []).map((row) => row.map(cellValue)),
      reason: null,
    };
  } catch (err) {
    return { ok: false, rows: [], cols: [], reason: err?.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run ONE read and return the first column of the first row.
 * Returns { ok, value, reason } and never throws. Same first two gates as
 * tursoWrite (transport, then the statement's own type — a refused statement
 * still arrives as HTTP 200); the third gate is "a row came back", since a
 * scalar read with no row is not a zero.
 */
export async function tursoScalar({ url, token, sql, args = [], timeoutMs = 3000 }) {
  const endpoint = toHttpUrl(url);
  if (!endpoint || !token) return { ok: false, value: null, reason: 'unconfigured' };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${endpoint}/v2/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{ type: 'execute', stmt: { sql, args } }, { type: 'close' }],
      }),
      signal: ctl.signal,
    });
    if (!res.ok) return { ok: false, value: null, reason: `http_${res.status}` };

    const body = await res.json();
    const results = Array.isArray(body?.results) ? body.results : [];
    const bad = results.find((r) => r?.type === 'error');
    if (bad) return { ok: false, value: null, reason: `sql_${bad?.error?.code ?? 'unknown'}` };

    const exec = results.find((r) => r?.response?.type === 'execute');
    const cell = exec?.response?.result?.rows?.[0]?.[0];
    if (!cell) return { ok: false, value: null, reason: 'no_row' };
    return { ok: true, value: cell.value ?? null, reason: null };
  } catch (err) {
    return { ok: false, value: null, reason: err?.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}
