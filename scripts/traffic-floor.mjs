#!/usr/bin/env node
/*
 * PDFLokal — scripts/traffic-floor.mjs  (THE ALARM)
 * ============================================================================
 * Fails loudly when traffic falls off a cliff. Run daily by
 * .github/workflows/traffic-floor.yml.
 *
 * WHY THIS EXISTS — read this before deleting it as noise:
 *   Jul 7–11 2026, pdflokal.id lost ~97% of its analytics for FIVE DAYS and
 *   nobody noticed. Sessions went 59–85/day → 1–6/day. The GA4 measurement ID had
 *   entered a state Google would not serve (HTTP 404 on gtag/js), so no hit ever
 *   fired. Every dashboard stayed green: the Ads pixel kept returning 200, and
 *   GA4 Admin cheerfully said "Data collection is active in the past 48 hours"
 *   while, one panel deeper, its OWN diagnostics said "your tag has never been
 *   detected."
 *
 *   The bug was the 404. THE FAILURE WAS THE SILENCE. An "active collection"
 *   banner structurally cannot detect a 97% loss — only VOLUME can. This script
 *   is the volume check that should have existed.
 *
 * WHAT IT WATCHES
 *   1. GA4 sessions (property 528550405, hostName = www.pdflokal.id).
 *      Yesterday vs the MEDIAN of the previous 28 days. Median, not mean, so one
 *      viral day doesn't raise the floor and mask a real collapse afterwards.
 *   2. Search Console impressions — the SEO channel we just built (Jul 2026).
 *      OPTIONAL: skipped with a clear notice if the service account has no GSC
 *      access, so the GA4 alarm still runs. To enable, add
 *      pdflokal-ga4-reader@pdflokal-mcp.iam.gserviceaccount.com as a user on the
 *      sc-domain:pdflokal.id property in Search Console.
 *
 * ZERO DEPENDENCIES on purpose: the service-account JWT is signed with node:crypto
 * and the APIs are called with plain fetch. This project does not take npm deps
 * lightly, and a monitoring script that rots because of a transitive dependency is
 * worse than no monitoring script.
 *
 * FAIL-LOUD, NOT FAIL-QUIET: if the API errors, we EXIT NONZERO. A monitor that
 * silently stops monitoring is the exact failure it exists to prevent.
 */

import { createSign } from 'node:crypto';

const GA4_PROPERTY = '528550405';
const HOSTNAME = 'www.pdflokal.id';
const GSC_SITE = 'sc-domain:pdflokal.id';

// Alarm when yesterday is below this fraction of the 28-day median. 0.4 is loose
// enough to ignore a quiet Sunday and tight enough that the Jul 7 collapse
// (85/day → 1/day = 0.01) would have paged on day one.
const FLOOR_RATIO = 0.4;
// Below this, ratios are meaningless — a site doing 3 sessions/day doesn't need
// an alarm, it needs users.
const MIN_BASELINE = 10;

function creds() {
  const raw = process.env.GA4_SA_JSON;
  if (!raw) {
    console.error('✖ GA4_SA_JSON is not set.');
    console.error('  Locally:  export GA4_SA_JSON="$(cat ~/.config/gcloud/pdflokal-ga4-reader.json)"');
    console.error('  In CI:    add it as a repository secret (Settings → Secrets → Actions).');
    process.exit(1);
  }
  return JSON.parse(raw);
}

// Service-account JWT → OAuth2 access token. ~30 lines, no googleapis dep.
async function accessToken(sa, scopes) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'RS256', typ: 'JWT' });
  const body = b64({
    iss: sa.client_email,
    scope: scopes.join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  });
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(sa.private_key, 'base64url');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${head}.${body}.${sig}`,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

const ymd = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d; };

async function ga4Daily(token) {
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${GA4_PROPERTY}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dateRanges: [{ startDate: ymd(daysAgo(29)), endDate: ymd(daysAgo(1)) }],
      dimensions: [{ name: 'date' }],
      metrics: [{ name: 'sessions' }],
      // hostName filter: the property has some cross-site leakage from a shared
      // Google tag (see memory/ga4-shared-tag-carrier.md). Count OUR traffic only.
      dimensionFilter: { filter: { fieldName: 'hostName', stringFilter: { value: HOSTNAME } } },
      orderBys: [{ dimension: { dimensionName: 'date' } }],
    }),
  });
  if (!res.ok) throw new Error(`GA4 runReport failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return (json.rows ?? []).map((r) => ({
    date: r.dimensionValues[0].value,
    sessions: Number(r.metricValues[0].value),
  }));
}

async function gscImpressions(token) {
  const res = await fetch(
    `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(GSC_SITE)}/searchAnalytics/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // GSC data lags ~2 days; asking for yesterday returns nothing and would
        // read as a crash. Compare a recent window to an older one instead.
        startDate: ymd(daysAgo(31)),
        endDate: ymd(daysAgo(3)),
        dimensions: ['date'],
        rowLimit: 100,
      }),
    },
  );
  if (res.status === 403) return { skipped: true };
  if (!res.ok) throw new Error(`GSC query failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return { rows: (json.rows ?? []).map((r) => ({ date: r.keys[0], impressions: r.impressions })) };
}

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ---- main -------------------------------------------------------------------
const sa = creds();
let failed = false;

const token = await accessToken(sa, [
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/webmasters.readonly',
]);

// ---- 1. GA4 sessions --------------------------------------------------------
const days = await ga4Daily(token);
if (days.length < 2) {
  console.error('✖ GA4 returned almost no data. That is itself the alarm — check the tag on the live wire:');
  console.error('    curl -o /dev/null -w "%{http_code} %{size_download}" "https://www.googletagmanager.com/gtag/js?id=G-7J8JF8XZ1Q&cx=c"');
  console.error('    (~549KB + 200 = real container · ~413KB + 200 = GENERIC DECOY · 404 = refused)');
  process.exit(1);
}

// CRITICAL: look yesterday up BY DATE. Do NOT take the last row.
//   GA4 omits days that have no data. On a TOTAL outage — zero sessions, the
//   loudest thing that can happen — yesterday simply has no row, and the last row
//   would be some earlier, healthy day. The alarm would compare the wrong day and
//   report "within floor" precisely when the site had gone dark.
//   A missing row means ZERO. It is the alarm, not the absence of one.
const yDate = ymd(daysAgo(1)).replace(/-/g, '');
const byDate = new Map(days.map((d) => [d.date, d.sessions]));
const ySessions = byDate.get(yDate) ?? 0;
const baseline = median(days.filter((d) => d.date !== yDate).map((d) => d.sessions));
const floor = Math.round(baseline * FLOOR_RATIO);

console.log('── GA4 sessions (www.pdflokal.id)');
console.log(`   yesterday (${yDate}): ${ySessions}${byDate.has(yDate) ? '' : '  ← NO ROW AT ALL (treated as zero)'}`);
console.log(`   28-day median:        ${baseline}`);
console.log(`   floor (${FLOOR_RATIO * 100}% of median): ${floor}`);

if (baseline < MIN_BASELINE) {
  console.log(`   ⓘ baseline below ${MIN_BASELINE}/day — too small to alarm on meaningfully. Skipping.`);
} else if (ySessions < floor) {
  console.error(`\n🚨 TRAFFIC FLOOR BREACHED: ${ySessions} sessions vs a floor of ${floor}.`);
  console.error('   This is what a 97% analytics blackout looked like on Jul 7 2026, and it went');
  console.error('   unnoticed for five days because nothing was watching VOLUME.');
  console.error('\n   Check, in this order — and trust NO single green signal:');
  console.error('   1. Is the tag served?  curl -o /dev/null -w "%{http_code} %{size_download}" \\');
  console.error('        "https://www.googletagmanager.com/gtag/js?id=G-7J8JF8XZ1Q&cx=c"');
  console.error('      ~549KB+200 = real · ~413KB+200 = GENERIC DECOY (a 200 proves NOTHING) · 404 = refused');
  console.error('   2. Does a real beacon fire? Load the site in a CLEAN browser profile (a desktop');
  console.error('      extension eats GA beacons — see memory/ga4-shared-tag-carrier.md) and look');
  console.error('      for g/collect?tid=G-7J8JF8XZ1Q returning 204.');
  console.error('   3. Does GA4 Realtime show it? Check LATE — a 204 means ACCEPTED, not COUNTED.');
  console.error('   4. Or the site is genuinely down / deploy broke. Check that too.');
  failed = true;
} else {
  console.log('   ✅ within floor');
}

// ---- 2. Search Console impressions ------------------------------------------
console.log('\n── Search Console impressions (the SEO channel)');
const gsc = await gscImpressions(token);
if (gsc.skipped) {
  console.log('   ⓘ SKIPPED — the service account has no Search Console access (403).');
  console.log(`   To arm this half: add ${sa.client_email}`);
  console.log(`   as a user on ${GSC_SITE} in Search Console → Settings → Users and permissions.`);
  console.log('   The GA4 alarm above still runs. This is a gap, not a failure.');
} else if (gsc.rows.length < 14) {
  console.log(`   ⓘ only ${gsc.rows.length} days of data — too new to set a floor. Skipping.`);
} else {
  const recent = gsc.rows.slice(-7).map((r) => r.impressions);
  const prior = gsc.rows.slice(0, -7).map((r) => r.impressions);
  const recentMed = median(recent);
  const priorMed = median(prior);
  const gscFloor = Math.round(priorMed * FLOOR_RATIO);
  console.log(`   last 7d median:   ${recentMed}`);
  console.log(`   prior median:     ${priorMed}`);
  if (priorMed < MIN_BASELINE) {
    console.log(`   ⓘ baseline below ${MIN_BASELINE} — too small to alarm on. Skipping.`);
  } else if (recentMed < gscFloor) {
    console.error(`\n🚨 SEARCH IMPRESSIONS FLOOR BREACHED: ${recentMed} vs a floor of ${gscFloor}.`);
    console.error('   Either we were de-indexed, robots.txt/noindex regressed, or the site broke.');
    console.error('   Check: curl -s https://www.pdflokal.id/robots.txt   (must NOT Disallow: /)');
    console.error('   Check: the tool pages still return 200 and carry no <meta name="robots" content="noindex">');
    failed = true;
  } else {
    console.log('   ✅ within floor');
  }
}

process.exit(failed ? 1 : 0);
