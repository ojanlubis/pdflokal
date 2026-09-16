/*
 * PDFLokal — api/_turso.js  (Turso / libSQL writer, shared by t.js and feedback.js)
 * ============================================================================
 * Added 2026-09-16 for the DUAL-WRITE soak (seat `specs/spec-rail-to-turso.md`).
 * Neon Free bills AWAKE-TIME and pdflokal writes thin, constant, all day — the
 * worst possible shape for that meter — so the rail is moving to a vendor that
 * bills rows. During the soak BOTH stores are written and compared daily; Neon
 * stays the source of truth until the comparison has been green for days.
 *
 * ⭐ THE ZERO-DEPENDENCY LAW IS RESTORED HERE. `api/t.js` took pdflokal's first
 * production dependency (`@neondatabase/serverless`) for one stated reason: Neon
 * documents the npm package and NOT the wire contract underneath it, and
 * building the rail's only write path on an undocumented shape trades a
 * dependency for a silent-breakage risk. Turso documents its SQL-over-HTTP
 * protocol, so that reason does not apply and this file is plain `fetch`.
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
  // DARK BRANCH, same semantics as the Neon path: no config means no write and
  // no noise. During the soak this is the normal state until the env vars land.
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

// Builds `values (?,?,?),(?,?,?)...` for a multi-row insert. Only the
// placeholder skeleton is built from the row count; every value is bound.
export function placeholders(rowCount, colCount) {
  return Array.from({ length: rowCount }, () => `(${Array(colCount).fill('?').join(',')})`).join(',');
}
