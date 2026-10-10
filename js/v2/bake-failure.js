/*
 * PDFLokal — v2/bake-failure.js  (the commit-time bake's own failure witness)
 * ============================================================================
 * WHY THIS EXISTS (seat ruling, his "boleh", 2026-10-01). A Ganti Teks commit
 * re-bakes the page through core/page-surgery.js's buildEditedPageBytes. When
 * that throws, the provider below swallows it on purpose — a broken bake must
 * never break rasterisation — and the page quietly repaints its untouched
 * source. Until now NOTHING said so: `commit_paint` still fired, and
 * `visual_oracle` compared the untouched page with itself and called it
 * near-parity. The rail first heard about it at EXPORT, where the same throw
 * killed every download. Measured 2026-09-24..29: 4 phone sessions, 2 visitors,
 * 33 export `RangeError`s, zero files — and every one of those sessions had
 * already shown the signature at commit (commit_paint with no `surgery`).
 *
 * WHAT IT SENDS
 *   - rail: failure{stage:'commit'} + failure_cause{stage:'commit'}. Enums only
 *     (core/telemetry-schema.js has no string prop), so no message can ride.
 *   - Sentry: the error, SCRUBBED (scrubbedError below), tagged commit-bake, so
 *     the next occurrence finally brings a stack. Nothing ever called
 *     captureException before, which is why Sentry has no record of this.
 *
 * ⚠️ MEANING CHANGED 2026-10-11 (founder ruling, seat decisions.md item 3):
 * failureReason()'s 'unsupported' (a blown stack, a `cannot encode` throw) is
 * recorded as 'unsupported' — before that date it was rewritten to 'unknown'.
 * `commit/unsupported` rows now come from two sources: the committed
 * unencodable character (js/v2/app.js, class names the script) and this bake
 * failure (class 'none', blocked:false; failure_cause says 'stack' or 'encode').
 * `commit/unknown` narrowed and `commit/unsupported` broadened (filter class
 * 'none' to separate the bake source). Do not compare counts across
 * 2026-10-11 blindly.
 *
 * blocked:false, truthfully: the commit itself went through — the edit is in
 * the model and on screen as an overlay. What it forewarns is the export,
 * which reports its own blocked:true if it dies. Same shape as the encrypted
 * import notice.
 */
import { failureReason, failureCause } from '../core/failure-reason.js';

// ---- privacy: what may reach Sentry -----------------------------------------
//
// EXCLUDE 3: no document content leaves the browser. A thrown message CAN quote
// the document or the user's own text: pdf-lib's WinAnsi encoder quotes the
// character it refused, its CMap writer prints the codepoint in hex, a parse
// error can name a stream filter or a font out of the file. So the message is
// ALLOWLISTED, never sanitised: it survives only if, with every digit run
// collapsed to '#', it is exactly one of these engine/library phrasings, which
// carry no data by construction. Anything else becomes '[scrubbed]'.
const SAFE_MESSAGES = [
  // RangeError family, V8 / JavaScriptCore / SpiderMonkey wordings.
  /^Offset is outside the bounds of the DataView$/,
  /^Out of bounds access$/,
  /^offset is out of bounds$/i,
  /^Source is too large$/,
  /^Start offset -?# is outside the bounds of the buffer$/,
  /^Invalid DataView length -?#$/,
  /^Invalid (typed )?array length(: -?#(\.#)?)?$/,
  /^Array size is not a small enough positive integer\.?$/,
  /^Invalid string length$/,
  /^Maximum call stack size exceeded\.?$/,
  /^too much recursion$/,
  /^Array buffer allocation failed$/,
  /^(Trying to access beyond buffer length|Index out of range|Attempt to access memory outside buffer bounds)$/,
  /^start offset of \w+ should be a multiple of #$/,
  /^byte length of \w+ should be a multiple of #$/,
  // TypeError family: the property name is an identifier from OUR code (or a
  // minified one), never a value from the file.
  /^Cannot read propert(y|ies) of (undefined|null) \(reading '[A-Za-z_$][\w$]*'\)$/,
  /^(undefined|null) is not an object \(evaluating '[A-Za-z_$][\w$.]*'\)$/,
];

export function safeErrorMessage(err) {
  const raw = typeof err?.message === 'string' ? err.message : '';
  const shaped = raw.replace(/\d+/g, '#');
  return SAFE_MESSAGES.some((re) => re.test(shaped)) ? shaped : '[scrubbed]';
}

// A NEW Error carrying only the collapsed name, the allowlisted message and the
// stack FRAMES. The original is never handed to Sentry: V8 writes the raw
// message into the first line(s) of `err.stack`, so passing the original — or
// its stack verbatim — would ship the very text the allowlist refused.
// Frames: V8's `    at …` lines; JavaScriptCore/SpiderMonkey's `fn@url:l:c`
// lines (those engines never put the message in `stack`).
export function scrubbedError(err) {
  // The constructor name is a code identifier (RangeError, pdf-lib's own
  // UnexpectedObjectTypeError), never document text — kept when it has that
  // shape, because it is the best discriminator Sentry can be given.
  const rawName = typeof err?.name === 'string' ? err.name : '';
  const out = new Error(safeErrorMessage(err));
  out.name = /^[A-Za-z_$][\w$]{0,60}Error$/.test(rawName) ? rawName : 'Error';
  const lines = typeof err?.stack === 'string' ? err.stack.split('\n') : [];
  const v8 = lines.filter((l) => /^\s+at /.test(l));
  const frames = v8.length ? v8 : lines.filter((l) => /^[^\s]*@.*:\d+:\d+$/.test(l));
  out.stack = v8.length ? [`${out.name}: ${out.message}`, ...frames].join('\n') : frames.join('\n');
  return out;
}

// ---- the reporter -------------------------------------------------------------
//
// ONCE PER EDIT STATE, CAPPED PER SESSION. `key` is the page's edit signature,
// which every commit changes and a plain re-render (zoom, scroll back into
// view) does not — so a page that re-renders ten times reports its one broken
// bake once, while each new commit that still fails is its own row. The cap
// is the same reasoning as RUNTIME_FAILURE_CAP in app.js: the first few say it
// broke, a retry loop's hundredth says nothing new and evicts real events.
export const BAKE_FAILURE_CAP = 5;

export function createBakeFailureReporter({ tel, getSentry = () => null, cap = BAKE_FAILURE_CAP } = {}) {
  const seen = new Set();
  return function reportBakeFailure(err, key) {
    try {
      if (seen.has(key) || seen.size >= cap) return false;
      seen.add(key);
      const reason = failureReason(err);
      tel('failure', {
        stage: 'commit',
        reason,
        class: 'none',
        blocked: false,
      });
      tel('failure_cause', { stage: 'commit', ...failureCause(err) });
      const S = getSentry();
      if (S && typeof S.captureException === 'function') {
        const safe = scrubbedError(err);
        const send = () => S.captureException(safe, { tags: { stage: 'commit-bake' } });
        // BREADCRUMBS, the second door. Sentry attaches recent console calls
        // to every event, and this same bake has just console.warn'ed raw
        // errors (page-surgery.js's stamp fallback logs the WinAnsi throw,
        // which QUOTES the user's character). So this one event goes out with
        // its breadcrumbs emptied by an event processor on a forked scope.
        // Probed against the vendored 10.55.0 bundle: the obvious
        // `withIsolationScope(s => s.clearBreadcrumbs())` does NOT fork in the
        // browser SDK — it wiped the live trail for every later event too.
        // withScope + addEventProcessor emptied this event only.
        // No withScope (an unexpected build): DON'T send — an event we cannot
        // strip is an event that may carry the document.
        if (typeof S.withScope === 'function') {
          S.withScope((scope) => {
            scope.addEventProcessor((event) => { event.breadcrumbs = []; return event; });
            send();
          });
        }
      }
      return true;
    } catch {
      // Reporting must never throw into the bake's own fallback path.
      return false;
    }
  };
}
