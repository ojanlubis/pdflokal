/*
 * PDFLokal — sentry-init.js  (error monitoring bootstrap)
 * ============================================================================
 * WHY this is a FILE and not the inline <script> it used to be:
 *   Sentry (209 KB) is now loaded with `defer` so it stops blocking the landing
 *   page. But a deferred script hasn't executed yet while the parser is still
 *   walking the document — so an INLINE init would run first and find
 *   `window.Sentry` undefined, silently disabling error monitoring.
 *   A deferred FILE, placed right after sentry.min.js, executes in document
 *   order: sentry.min.js → this → app.js (module). Sentry is therefore live
 *   before any app code runs, which is the whole point of having it.
 *
 * Keep this in sync with the init block in alat-gambar.html (the old wing has
 * its own copy and dies at demolition).
 */

// eslint-disable-next-line no-undef
if (window.Sentry) Sentry.init({
  dsn: 'https://0913dcff45e0045c49dfe1b14f34c65f@o4511472486580224.ingest.us.sentry.io/4511472494313472',
  tunnel: '/api/sentry-tunnel',
  enabled: location.hostname === 'pdflokal.id' || location.hostname === 'www.pdflokal.id',
  release: window.APP_VERSION,
  sampleRate: 1.0,
  // Third-party noise, not our code: ad blockers / privacy extensions hook
  // window.fetch and cancel Google's analytics + ads requests (gtag →
  // doubleclick), which surface as unhandled "Failed to fetch" rejections.
  // Filter by SOURCE so genuine first-party errors still report. (Sentry
  // JAVASCRIPT-C / -A were pure extension noise. We make zero first-party
  // fetches for file work — 100% client-side — so these are never actionable.)
  denyUrls: [
    /chrome-extension:\/\//i,
    /moz-extension:\/\//i,
    /safari-(web-)?extension:\/\//i,
    /^chrome:\/\//i,
    /doubleclick\.net/i,
    /googletagmanager\.com/i,
    /google-analytics\.com/i,
    /googlesyndication\.com/i,
    /google-adservices\.com/i,
    /\/gtag\//i,
  ],
  // SINGLE SOURCE OF TRUTH — exactly ONE ignoreErrors key. A second one would
  // silently overwrite this entire list (last key wins in a JS object literal).
  ignoreErrors: [
    // Stackless variants of the denyUrls above — a bare rejection has no frames,
    // so denyUrls cannot match it; match the message too.
    'Load failed',                                    // Safari's phrasing
    'NetworkError when attempting to fetch resource', // Firefox's phrasing
    // WHY this matters MORE in v2 than in the old wing: app.js is a real ES
    // module, so every flaky mobile connection that drops a dynamic import
    // lands here. Each browser words it differently — Chrome "Failed to fetch
    // dynamically imported module", Firefox "error loading", Safari "Importing
    // a module script failed" — all the same transient network class, none
    // actionable. (Also covers bare 'Failed to fetch'.)
    /(Importing a module script failed|Failed to fetch|(fetch|loading) dynamically imported module)/i,
    // Battle-tested entries adapted from Excalidraw's sentry.ts.
    "undefined is not an object (evaluating 'window.__pad.performLoop')",
    "InvalidStateError: Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.",
    /QuotaExceededError: (The quota has been exceeded|.*setItem.*Storage)/i,
    'Internal error opening backing store for indexedDB.open',
  ],
  replaysSessionSampleRate: 0.10,
  replaysOnErrorSampleRate: 1.0,
  integrations: [
    // eslint-disable-next-line no-undef
    Sentry.replayIntegration({
      maskAllText: true,
      maskAllInputs: true,
      blockAllMedia: true,
      // v2 pages are <img>, not <canvas> — the block list must cover .pv-bg
      // (page images) and signature images, or replays would record user
      // documents. Privacy first, always.
      block: ['canvas', '.pv-bg', '.pv-anno img', '.pm-thumb', '#sig-preview'],
    }),
  ],
  beforeSend(event) {
    // Strip URL fragments before an event leaves the device — they can carry
    // UI state we never want in a third-party service. Privacy first, always.
    // WHY split, not regex: SonarCloud S5852 flags greedy `.*$` as ReDoS-prone.
    if (event.request?.url) {
      event.request.url = event.request.url.split('#')[0];
    }
    return event;
  },
});
