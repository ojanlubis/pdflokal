/*
 * PDFLokal - lib/errors.js (ES Module)
 * Global error capture — funnels uncaught errors + promise rejections into
 * track('client_error', ...) so production failures surface in the analytics
 * dashboard. Bridge for now; swap destination to Sentry in Tier 2.
 *
 * WHY: Before this, runtime errors in production were silent. Only ESLint ran
 * in CI, and only the user's own browser console showed them. We have no
 * verification layer for "did this regression actually break things for users."
 */

import { track } from './analytics.js';

// WHY: Cap stack to 500 chars — Vercel Analytics custom event values are
// truncated past ~255 chars per field, and stacks are mostly redundant past
// the top few frames. 500 gives headroom for the analytics dashboard's
// own truncation while keeping the most relevant frames.
function trimStack(stack) {
  if (typeof stack !== 'string') return '';
  return stack.length > 500 ? stack.slice(0, 500) : stack;
}

// WHY: Vercel Analytics rejects nested objects in event data. Flatten + coerce.
function safe(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value);
}

let installed = false;

export function installErrorCapture() {
  if (installed) return;
  installed = true;

  window.addEventListener('error', (event) => {
    track('client_error', {
      kind: 'error',
      message: safe(event.message),
      source: safe(event.filename),
      line: safe(event.lineno),
      col: safe(event.colno),
      stack: trimStack(event.error?.stack),
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    track('client_error', {
      kind: 'unhandledrejection',
      message: safe(message),
      stack: trimStack(reason?.stack),
    });
  });
}
