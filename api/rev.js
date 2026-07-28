/*
 * PDFLokal — api/rev.js  (WHICH BUILD IS THE BROWSER ACTUALLY RUNNING?)
 * ============================================================================
 * Returns this deployment's own commit SHA. GET-only, takes no input at all.
 *
 * WHY IT EXISTS. `failure` events could not be attributed to a code version.
 * The client sends the literal 'dev' (nothing stamps <meta name="pdflokal-rev">
 * — there is no build step, that is the moat), so api/t.js overwrote it with
 * the SERVER's deploy SHA at the moment each batch ARRIVED. On 2026-07-28 that
 * made one 82-minute session carry FOUR app_versions: four deploys landed while
 * it was flushing. Nothing reloaded. The field described our deploy timeline,
 * not the user's code — so "did the build we just shipped break this?" was
 * unanswerable, which is the question the ship-tonight loop rests on.
 *
 * WHY THIS IS NOT A BUILD STEP. The moat forbids a bundler, not a request to
 * our own origin. This function already knows its SHA the same way api/t.js
 * does; it just says it out loud. One tiny GET, fetched lazily, blocking
 * nothing. (PM's call, 2026-07-29 — and they were right that api/t.js already
 * proves the SHA is available server-side.)
 *
 * CONTENT-BLIND BY CONSTRUCTION: it reads no body, no query, no header, and no
 * cookie. There is no input to leak.
 *
 * ⚠️ THE ONE CASE WHERE THE ANSWER CAN STILL BE WRONG, stated so nobody trusts
 * it further than it earns: this reports the deploy that is live NOW, not the
 * deploy whose JS the browser is executing. sw.js is network-first for our own
 * ES modules AND for HTML navigations, so online those are the same thing. The
 * gap is: load OFFLINE from the service-worker cache (old modules), then
 * reconnect, then this resolves with a NEWER sha. Offline at load means this
 * fetch fails too and the client keeps 'dev' — so the failure degrades to the
 * old behaviour rather than to a confident lie. The reconnect case remains, and
 * it is the reason this is fetched once at init rather than retried.
 *
 * NO BROWSER CACHING. Each Vercel deployment serves its own functions, so the
 * value is constant per deployment — but a browser cache would happily outlive
 * the deployment and report a stale SHA with total confidence, which is the
 * exact defect this endpoint was built to remove.
 */
export const config = { runtime: 'nodejs' };

const SHA_RE = /^[0-9a-f]{7,40}$/;

export default function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).end();
    return;
  }
  const sha = String(process.env.VERCEL_GIT_COMMIT_SHA || '').toLowerCase();
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // 'dev' on local and on any preview without the system env var, which is the
  // same honest fallback js/v2/telemetry.js uses. Never guess a SHA.
  res.status(200).end(JSON.stringify({ rev: SHA_RE.test(sha) ? sha : 'dev' }));
}
