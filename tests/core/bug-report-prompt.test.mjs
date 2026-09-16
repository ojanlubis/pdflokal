/*
 * v2/bug-report-prompt.js — the once-a-day nudge's GATING.
 * ============================================================================
 * Added 2026-09-16 with the founder's bug-report prompt.
 *
 * What is actually worth pinning here is not that a card appears — it is the
 * three ways this could quietly become wrong:
 *   1. it fires MORE than once a day (an interruption mid-edit, repeated)
 *   2. it fires on the landing, where the control it points at is display:none
 *      and the tail would aim at nothing
 *   3. it stops firing entirely when localStorage throws (private mode), which
 *      would look identical to "the feature is fine, nobody qualified today"
 *
 * The copy is asserted VERBATIM because it is the founder's, ratified 2026-09-16,
 * and EXCLUDE 2 makes it un-editable by any session. A test is the only thing
 * that makes silently rewording it go red.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Minimal DOM. Deliberately hand-built rather than jsdom: this module touches
// six DOM calls and a dependency would be a larger surface than the thing tested.
function installDom({ storageThrows = false, hidden = false } = {}) {
  const store = new Map();
  const listeners = new Map();
  const made = [];
  const docListeners = {};

  const mkEl = (tag) => {
    const el = {
      tagName: tag, id: '', className: '', textContent: '',
      children: [], attrs: {}, _listeners: {},
      classList: {
        _s: new Set(),
        add(...c) { c.forEach((x) => this._s.add(x)); },
        remove(...c) { c.forEach((x) => this._s.delete(x)); },
        contains(c) { return this._s.has(c); },
      },
      setAttribute(k, v) { this.attrs[k] = v; },
      append(...kids) { this.children.push(...kids); },
      appendChild(k) { this.children.push(k); return k; },
      addEventListener(ev, fn) { this._listeners[ev] = fn; },
      remove() { const i = made.indexOf(this); if (i >= 0) made.splice(i, 1); },
      get text() { return this.children.map((c) => c.textContent).join('|'); },
      offsetWidth: 0,
    };
    made.push(el);
    return el;
  };

  const body = mkEl('body');
  globalThis.document = {
    body,
    hidden,
    createElement: mkEl,
    getElementById: (id) => listeners.get(id) || null,
    __register: (id, el) => listeners.set(id, el),
    addEventListener(ev, fn) { (docListeners[ev] ||= []).push(fn); },
    removeEventListener(ev, fn) { docListeners[ev] = (docListeners[ev] || []).filter((f) => f !== fn); },
    // Test helper: flip visibility and fire the event the way a browser does.
    __setHidden(h) { this.hidden = h; (docListeners.visibilitychange || []).slice().forEach((f) => f()); },
  };
  globalThis.localStorage = {
    getItem(k) { if (storageThrows) throw new Error('denied'); return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { if (storageThrows) throw new Error('denied'); store.set(k, v); },
  };
  globalThis.requestAnimationFrame = (fn) => fn();

  // A controllable timer queue. The download trigger POLLS while another card is
  // up, so a timer that runs synchronously would recurse forever — and one that
  // never runs would make every download test pass vacuously. `flush()` runs the
  // short timers (the settle/poll steps) and deliberately never the 9s
  // auto-dismiss, which is what lets a test look at the card after revealing it.
  const timers = [];
  globalThis.setTimeout = (fn, ms = 0) => { timers.push({ fn, ms }); return timers.length; };
  globalThis.clearTimeout = () => {};
  const flush = () => {
    for (let guard = 0; guard < 200; guard += 1) {
      const i = timers.findIndex((t) => t.ms < 5000);
      if (i < 0) return;
      timers.splice(i, 1)[0].fn();
    }
    throw new Error('flush: timers never settled — a poll loop is not terminating');
  };

  // Occupants of the download moment (celebrate's #support-card, the Play Store
  // #vote-card). Only the `.show` form is ever queried.
  const occupants = new Set();
  document.querySelector = (sel) => (occupants.has(sel) ? {} : null);

  // Run exactly ONE pending short timer — how a test watches a poll loop that is
  // SUPPOSED to keep spinning, without flush()'s run-until-quiet semantics.
  const step = () => {
    const i = timers.findIndex((t) => t.ms < 5000);
    if (i < 0) return false;
    timers.splice(i, 1)[0].fn();
    return true;
  };

  return { body, store, made, flush, step, occupants };
}

let mod;
beforeEach(async () => {
  // Fresh module instance per test so `shownThisSession` cannot leak across.
  mod = await import(`../../js/v2/bug-report-prompt.js?t=${Math.random()}`);
});

function cardsIn(body) {
  return body.children.filter((c) => c.id === 'bug-prompt');
}

test('the founder copy is verbatim — both lines, exactly as he wrote them', async () => {
  const { body } = installDom();
  mod.createBugReportPrompt().onEditCommit();
  const card = cardsIn(body)[0];
  assert.ok(card, 'a card must exist');
  const texts = card.children.map((c) => c.textContent);
  assert.deepEqual(texts, [
    'Halo user PDFLokal',
    'Mohon kabarin saya ya kalo ada bug, di sini',
  ], 'EXCLUDE 2: this copy is his and may not be reworded by a session');
});

test('ONCE PER DAY: a second commit the same day shows nothing', () => {
  const { body } = installDom();
  const p = mod.createBugReportPrompt();
  assert.equal(p.onEditCommit(), true, 'first commit shows it');
  assert.equal(p.onEditCommit(), false, 'second must not');
  assert.equal(p.onEditCommit(), false);
  assert.equal(cardsIn(body).length, 1);
});

test('EITHER TRIGGER, ONE CAP: a download after a commit does not show a second card', () => {
  const { body } = installDom();
  const p = mod.createBugReportPrompt();
  assert.equal(p.onEditCommit(), true);
  assert.equal(p.onDownloadSuccess(), false, '"whichever is first" must fall out of the shared cap');
  assert.equal(cardsIn(body).length, 1);
});

test('and the other order: a commit after a download is equally capped', () => {
  const { body, flush } = installDom();
  const p = mod.createBugReportPrompt();
  assert.equal(p.onDownloadSuccess(), true);
  assert.equal(p.onEditCommit(), false, 'already pending — must not race the download into a second card');
  flush();
  assert.equal(p.onEditCommit(), false, 'and still capped once it has shown');
  assert.equal(cardsIn(body).length, 1);
});

test('the day is persisted, so a NEW session on the same day still shows nothing', () => {
  const { store } = installDom();
  assert.equal(mod.createBugReportPrompt().onEditCommit(), true);
  assert.equal(store.get('pdflokal_bugreport_last'), new Date().toDateString());
  // A fresh instance is a fresh page load; only the stored date can stop it.
  assert.equal(mod.createBugReportPrompt().onEditCommit(), false);
});

test('a DIFFERENT day shows it again', () => {
  const { store } = installDom();
  store.set('pdflokal_bugreport_last', 'Mon Jan 01 2001');
  assert.equal(mod.createBugReportPrompt().onEditCommit(), true);
});

test('NEVER ON THE LANDING: the control it points at is display:none there', () => {
  const { body } = installDom();
  body.classList.add('is-empty');
  assert.equal(mod.createBugReportPrompt().onEditCommit(), false);
  assert.equal(cardsIn(body).length, 0, 'the tail would point at nothing');
});

test('PRIVATE MODE: storage throwing degrades to once-per-session, never to silence', () => {
  const { body } = installDom({ storageThrows: true });
  const p = mod.createBugReportPrompt();
  assert.equal(p.onEditCommit(), true, 'it must still show — a thrown getItem is not a "shown already"');
  assert.equal(p.onEditCommit(), false, 'and must not repeat within the session');
  assert.equal(cardsIn(body).length, 1);
});

test('clicking the card opens the EXISTING door rather than a second code path', () => {
  const { body } = installDom();
  let clicked = 0;
  document.__register('contact-tab-btn', { click: () => { clicked += 1; } });
  mod.createBugReportPrompt().onEditCommit();
  cardsIn(body)[0]._listeners.click();
  assert.equal(clicked, 1, 'feedback-form.js must stay the single owner of that dialog');
});

// ---- THE BACKGROUND-TAB BUG, found by watching it in a real browser --------
// The first version spent the day's cap at trigger time and relied on
// requestAnimationFrame to reveal the card. In a hidden tab rAF is paused while
// setTimeout is not, so the dismiss timer removed a card that had never become
// visible, and the day was already used up. The DOWNLOAD trigger is exactly the
// moment a real tab loses visibility (Android's download sheet, the system
// notification), so this was the common case, not a corner.
test('HIDDEN TAB: a trigger while hidden shows NOTHING and spends NOTHING', () => {
  const { body, store, flush } = installDom({ hidden: true });
  const p = mod.createBugReportPrompt();
  assert.equal(p.onDownloadSuccess(), true, 'the trigger is accepted');
  flush();
  assert.equal(cardsIn(body).length, 0, 'but nothing is put on a screen nobody is looking at');
  assert.equal(store.has('pdflokal_bugreport_last'), false,
    'THE BUG: the cap must not be spent on a card nobody saw');
});

test('HIDDEN TAB: it appears, visibly, when the user comes back — and only then is the day spent', () => {
  const { body, store, flush } = installDom({ hidden: true });
  const p = mod.createBugReportPrompt();
  p.onDownloadSuccess();
  flush();
  document.__setHidden(false);
  const cards = cardsIn(body);
  assert.equal(cards.length, 1, 'shown on return');
  assert.ok(cards[0].classList.contains('show'),
    'and actually VISIBLE — the original bug left it in the DOM at opacity 0');
  assert.equal(store.get('pdflokal_bugreport_last'), new Date().toDateString());
});

test('HIDDEN TAB: a second trigger while still hidden does not queue a second card', () => {
  const { body, flush } = installDom({ hidden: true });
  const p = mod.createBugReportPrompt();
  p.onDownloadSuccess();
  flush();
  assert.equal(p.onEditCommit(), false, 'already pending');
  document.__setHidden(false);
  assert.equal(cardsIn(body).length, 1);
});

test('HIDDEN TAB: if the user went back to the landing while away, it does not show on return', () => {
  const { body, flush } = installDom({ hidden: true });
  const p = mod.createBugReportPrompt();
  p.onDownloadSuccess();
  flush();
  body.classList.add('is-empty'); // user pressed Home while the download sheet was up
  document.__setHidden(false);
  assert.equal(cardsIn(body).length, 0, 'the anchor is gone, so the tail would point at nothing');
});

test('VISIBLE TAB: the card is revealed synchronously, never left at opacity 0', () => {
  const { body } = installDom();
  // Deliberately BREAK requestAnimationFrame: the reveal must not depend on it,
  // because rAF is the exact call a hidden tab suspends.
  globalThis.requestAnimationFrame = () => {};
  mod.createBugReportPrompt().onEditCommit();
  assert.ok(cardsIn(body)[0].classList.contains('show'),
    'visible without any animation frame ever running');
});

// ---- THE COLLISION, found by SCREENSHOT at 375px ---------------------------
// celebrate.js shows #support-card ~200ms after the same download, pinned to the
// same bottom edge, and in the rendered page it sat directly on top of this card.
// The prompt was in the DOM, at opacity 1, and unreadable — every functional check
// above passed. He ruled two asks are fine, so they are SEQUENCED, not suppressed.
test('COLLISION: while the celebrate card is up, the prompt WAITS instead of rendering under it', () => {
  const { body, store, flush, step, occupants } = installDom();
  occupants.add('#support-card.show');
  const p = mod.createBugReportPrompt();
  assert.equal(p.onDownloadSuccess(), true);
  // Drive five REAL poll cycles while the celebrate card is still up. Each step
  // executes the pending timer; if the prompt ignored the occupant, the first
  // step would render it. flush() is not used here: it would spin forever by
  // design, because waiting IS the correct behaviour.
  const polled = [];
  for (let i = 0; i < 5; i += 1) {
    assert.equal(step(), true, `cycle ${i}: the loop must still be polling, not have given up`);
    polled.push(cardsIn(body).length);
  }
  assert.deepEqual(polled, [0, 0, 0, 0, 0], 'never drawn underneath another card');
  assert.equal(store.has('pdflokal_bugreport_last'), false, 'and the day is not spent while waiting');

  occupants.delete('#support-card.show'); // user closes "Selesai, filemu udah jadi!"
  flush();
  assert.equal(cardsIn(body).length, 1, 'then it asks');
  assert.ok(cardsIn(body)[0].classList.contains('show'));
});

test('COLLISION: the Play Store vote card is treated the same way', () => {
  const { body, flush, occupants } = installDom();
  occupants.add('#vote-card.show');
  const p = mod.createBugReportPrompt();
  p.onDownloadSuccess();
  assert.equal(cardsIn(body).length, 0);
  occupants.delete('#vote-card.show');
  flush();
  assert.equal(cardsIn(body).length, 1);
});

test('COLLISION: the EDIT trigger is immediate when nothing is in the way', () => {
  const { body } = installDom();
  mod.createBugReportPrompt().onEditCommit();
  assert.equal(cardsIn(body).length, 1, 'no timers involved on the common path');
});

// Found by the DARK-MODE screenshot: the Tip-Ex arm hint is centred at
// bottom:76px and at 375px it runs straight through this card — and it is on
// screen at exactly the moment of a first commit (arm, then drag).
test('COLLISION: the EDIT trigger waits behind a live toast instead of rendering through it', () => {
  const { body, store, step, flush, occupants } = installDom();
  occupants.add('#toast.show');
  const p = mod.createBugReportPrompt();
  assert.equal(p.onEditCommit(), true);
  for (let i = 0; i < 3; i += 1) {
    assert.equal(step(), true, 'still polling');
    assert.equal(cardsIn(body).length, 0, 'never drawn through the hint toast');
  }
  assert.equal(store.has('pdflokal_bugreport_last'), false);
  occupants.delete('#toast.show'); // toast() self-clears after 2.6s
  flush();
  assert.equal(cardsIn(body).length, 1);
});

test('GIVE UP, DON\'T SPEND: a card left open forever ends the wait without using the day', () => {
  const { body, store, step, occupants } = installDom();
  occupants.add('#support-card.show'); // the user never closes it
  const p = mod.createBugReportPrompt();
  p.onDownloadSuccess();
  // 60s at 400ms per poll is 150 cycles, plus the settle step. Run past it.
  let cycles = 0;
  while (step()) { cycles += 1; assert.ok(cycles < 400, 'the wait must be BOUNDED'); }
  assert.ok(cycles > 100, `gave up too early (${cycles} cycles)`);
  assert.equal(cardsIn(body).length, 0);
  assert.equal(store.has('pdflokal_bugreport_last'), false, 'giving up must not spend the day');
  // And it is no longer pending, so a later trigger that day can still try.
  occupants.delete('#support-card.show');
  assert.equal(p.onEditCommit(), true, 'a later commit gets its chance');
  assert.equal(cardsIn(body).length, 1);
});

test('a download on a day already spent does not start a polling loop', () => {
  const { store } = installDom();
  store.set('pdflokal_bugreport_last', new Date().toDateString());
  const before = globalThis.setTimeout;
  let scheduled = 0;
  globalThis.setTimeout = (...a) => { scheduled += 1; return before(...a); };
  assert.equal(mod.createBugReportPrompt().onDownloadSuccess(), false);
  assert.equal(scheduled, 0, 'no timer for a prompt that cannot show');
});
