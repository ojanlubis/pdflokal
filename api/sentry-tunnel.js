/*
 * Sentry event tunnel — Vercel Edge Function.
 *
 * WHY: Ad blockers (uBlock Origin, AdGuard, Brave Shields, Pi-hole, DuckDuckGo)
 * block requests to *.ingest.sentry.io by default. For a privacy-first product
 * like PDFLokal whose audience is more likely to block telemetry, an estimated
 * ~40-50% of errors never reach Sentry without tunneling. This function lets
 * the browser POST to /api/sentry-tunnel on our own domain, which ad blockers
 * don't filter, then forwards the envelope to Sentry server-side.
 *
 * Validates the DSN host + project ID against an allowlist so this endpoint
 * can't be abused to relay arbitrary traffic to other Sentry projects.
 *
 * Reference: https://docs.sentry.io/platforms/javascript/troubleshooting/#using-the-tunnel-option
 */

export const config = { runtime: 'edge' };

// SINGLE SOURCE OF TRUTH — must match the DSN in index.html.
const SENTRY_HOST = 'o4511472486580224.ingest.us.sentry.io';
const ALLOWED_PROJECT_IDS = ['4511472494313472'];

export default async function handler(request) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const envelope = await request.text();
    const headerLine = envelope.split('\n', 1)[0];
    const header = JSON.parse(headerLine);

    const dsn = new URL(header.dsn);
    const projectId = dsn.pathname.replace(/^\//, '');

    if (dsn.hostname !== SENTRY_HOST) {
      return new Response('Invalid DSN host', { status: 400 });
    }
    if (!ALLOWED_PROJECT_IDS.includes(projectId)) {
      return new Response('Invalid project id', { status: 400 });
    }

    const upstream = `https://${SENTRY_HOST}/api/${projectId}/envelope/`;
    const upstreamResponse = await fetch(upstream, {
      method: 'POST',
      body: envelope,
      headers: { 'Content-Type': 'application/x-sentry-envelope' },
    });

    // Mirror Sentry's status back to the client so the SDK's transport
    // can react to ingestion failures the same way it would directly.
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: { 'Content-Type': upstreamResponse.headers.get('Content-Type') ?? 'application/json' },
    });
  } catch (err) {
    return new Response(`Tunnel error: ${err.message}`, { status: 500 });
  }
}
