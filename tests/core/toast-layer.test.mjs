/*
 * THE TOAST IS IN THE TOP LAYER ONLY WHILE IT IS VISIBLE.
 * ============================================================================
 * #toast is a popover="manual" so it can paint above a modal sheet. A manual
 * popover stays open until hidePopover(), and an open popover paints above
 * EVERY non-top-layer element (#support-card, #install-card, #maker-card,
 * #vote-card). Leaving it open after the fade put an invisible-but-stacked
 * toast over those cards for the rest of the session, and let a faded toast's
 * box overlay the celebrate card's top edge. So: showPopover() when a toast
 * appears, hidePopover() once its fade is done.
 *
 * createToast is the logic app.js's toast()/hideToast() are made of; these tests
 * drive the real controller with a fake element and a fake clock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const { createToast, TOAST_FADE_MS } = await import('../../js/v2/toast-layer.js');
const { raiseToTopLayer, dropFromTopLayer } = await import('../../js/v2/top-layer.js');

function fakeEl() {
  const classes = new Set();
  const el = {
    textContent: '', open: false, calls: [],
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    matches: (sel) => sel === ':popover-open' && el.open,
    showPopover() { el.calls.push('show'); el.open = true; },
    hidePopover() { el.calls.push('hide'); el.open = false; },
  };
  return el;
}

// A manual clock: timers fire in time order when advance() passes them.
function fakeClock() {
  let now = 0; let seq = 0; const timers = new Map();
  return {
    schedule: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    cancel: (id) => { timers.delete(id); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); now = due[1].at; due[1].fn();
      }
      now = end;
    },
  };
}

function make(durationMs = () => 2600) {
  const el = fakeEl(); const clock = fakeClock();
  const toast = createToast({
    el, durationMs, raise: raiseToTopLayer, drop: dropFromTopLayer,
    schedule: clock.schedule, cancel: clock.cancel,
  });
  return { el, clock, toast };
}

test('a toast enters the top layer when it shows', () => {
  const { el, toast } = make();
  toast.show('Halaman dihapus');
  assert.equal(el.textContent, 'Halaman dihapus');
  assert.ok(el.classList.contains('show'));
  assert.equal(el.open, true);
});

test('after the fade it LEAVES the top layer, so it cannot stack over cards', () => {
  const { el, clock, toast } = make();
  toast.show('x');
  clock.advance(2599);
  assert.ok(el.classList.contains('show'));
  assert.equal(el.open, true);
  clock.advance(1); // duration reached: fade starts, still in the top layer
  assert.ok(!el.classList.contains('show'));
  assert.equal(el.open, true, 'still open during the fade, or the fade-out is cut');
  clock.advance(TOAST_FADE_MS);
  assert.equal(el.open, false, 'popover closed once the fade is done');
});

test('a toast replacing a fading one cancels the pending close', () => {
  const { el, clock, toast } = make();
  toast.show('one');
  clock.advance(2600 + TOAST_FADE_MS - 1); // fade nearly done
  toast.show('two');
  clock.advance(10);
  assert.equal(el.open, true, 'the stale close must not hide the new toast');
  assert.ok(el.classList.contains('show'));
  clock.advance(2600 + TOAST_FADE_MS);
  assert.equal(el.open, false);
});

test('every show re-raises (hide then show) so it lands above a dialog opened since', () => {
  const { el, toast } = make();
  toast.show('one');
  el.calls.length = 0;
  toast.show('two');
  assert.deepEqual(el.calls, ['hide', 'show']);
});

test('hide() pulls it down early and still closes the popover after the fade', () => {
  const { el, clock, toast } = make();
  toast.show('x');
  toast.hide();
  assert.ok(!el.classList.contains('show'));
  assert.equal(el.open, true);
  clock.advance(TOAST_FADE_MS);
  assert.equal(el.open, false);
  // and the old duration timer is gone: nothing fires later
  clock.advance(10000);
  assert.equal(el.open, false);
});

test('the duration comes from durationMs(msg)', () => {
  const { el, clock, toast } = make((m) => (m.length > 3 ? 5000 : 1000));
  toast.show('ab');
  clock.advance(1000);
  assert.ok(!el.classList.contains('show'));
  toast.show('abcd');
  clock.advance(4999);
  assert.ok(el.classList.contains('show'));
  clock.advance(1);
  assert.ok(!el.classList.contains('show'));
});

test('the fade window covers the CSS opacity transition on #toast', () => {
  const css = read('index.html').match(/#toast \{([^}]*)\}/)[1];
  const m = css.match(/transition:\s*opacity\s*([\d.]+)(m?s)/);
  assert.ok(m, '#toast must keep its opacity transition');
  const ms = m[2] === 's' ? parseFloat(m[1]) * 1000 : parseFloat(m[1]);
  assert.ok(TOAST_FADE_MS >= ms, `TOAST_FADE_MS ${TOAST_FADE_MS} must be >= the ${ms}ms transition`);
});

test('app.js builds toast()/hideToast() on createToast and no longer pokes .show by hand', () => {
  const src = read('js/v2/app.js');
  assert.match(src, /import \{[^}]*createToast[^}]*\} from '\.\/toast-layer\.js'/);
  const toastFn = src.match(/function toast\(msg\) \{[\s\S]*?\n\}/)[0];
  assert.match(toastFn, /toastCtl\.show\(msg\)/);
  const hideFn = src.match(/function hideToast\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(hideFn, /toastCtl\.hide\(\)/);
  assert.doesNotMatch(src, /toastEl\.classList\.remove\('show'\)/,
    'removing .show by hand leaves the popover open in the top layer; use hideToast()');
});
