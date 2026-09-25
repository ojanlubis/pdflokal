/*
 * PDFLokal — api/_cron.js  (who may call api/cron/*)
 * ============================================================================
 * Vercel Cron calls a function with `Authorization: Bearer $CRON_SECRET` when
 * the project has a CRON_SECRET env var. Every api/cron/ endpoint checks it
 * first, so the jobs cannot be triggered, or their output read, by anyone else.
 *
 * FAIL CLOSED: no CRON_SECRET configured means NOTHING may call these — a
 * missing secret must never turn a private job into a public one.
 */
import { timingSafeEqual } from 'node:crypto';

export function cronAuthorized(req, secret = process.env.CRON_SECRET) {
  if (!secret) return false;
  const got = Buffer.from(String(req.headers?.authorization ?? ''));
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}
