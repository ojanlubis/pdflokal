/*
 * PDFLokal — v2/bug-report-prompt.js  (the "kabarin saya kalo ada bug" nudge)
 * ============================================================================
 * Founder ask, 2026-09-16, verbatim: "masalah utama kita, ada banyak bug tapi
 * silent, dicatch sama user langsung, jd kita minta tolong ke user, kalo ada bug
 * minta tolong laporkan di pojok kiri bawah gitu."
 *
 * WHY THIS EXISTS, in one line: on this product the expensive bug produces a
 * plausible WRONG ANSWER and tells nobody. The rail measures the blindness — in
 * one 14-day window 566 sessions opened a document and edited it and never
 * exported, against 13 sessions with an export failure. People leave, and
 * nothing records why.
 *
 * ⚠️ AND THE MOAT IS WHAT MAKES THE REPORT HARD. Nothing is ever uploaded, so we
 * are asking about a document we will NEVER be able to look at. The only evidence
 * a user can hand us is words and the screenshot they paste themselves into the
 * feedback dialog (core/feedback-shot.js). That is why this points at that dialog
 * rather than, say, collecting anything itself: the dialog is the only place the
 * report can carry proof.
 *
 * WHAT IT IS NOT. Not a modal. A dialog mid-edit costs the edit, and editing is
 * the product. This is the cheapest rung of the disclosure funnel that can still
 * speak: a small card that names the thing and points at a control that is
 * ALREADY THERE — `#contact-tab-btn` ("Ada masukan?"), fixed bottom-left since
 * 2026-09-09. The card teaches a location; the location outlives the card.
 *
 * COPY IS THE FOUNDER'S, VERBATIM (EXCLUDE 2 — he waived looking at surfaces,
 * never writing them). Do not edit these two strings:
 *   small : "Halo user PDFLokal"
 *   big   : "Mohon kabarin saya ya kalo ada bug, di sini"
 * Note the FIRST PERSON: "kabarin saya", not "kami". A person is asking, which is
 * the same voice as the Ojan / mesindev.com byline inside the dialog itself.
 *
 * TRIGGERS, his call: the first successful DOWNLOAD or the first committed EDIT
 * of the day, whichever lands first. Once per calendar day either way.
 *
 * CAP MECHANISM mirrors celebrate.js deliberately — same shape, own keys — so
 * there is one idiom for "once per calendar day" in this codebase rather than two
 * that can drift. He was offered a shared cap with celebrate's share/tip card and
 * REFUSED it (2026-09-16: "engga. gpp dua ajakan. most user ignore the share
 * anyway"), so the two caps are independent on purpose. Do not merge them.
 */

const LAST_SHOWN_KEY = 'pdflokal_bugreport_last';
const AUTO_DISMISS_MS = 9000;

// localStorage throws in some private modes and can silently accept a write that
// never persists. Same defensive shape as the visitor_id write-back check: a
// failure degrades this to once-per-SESSION, never to every-single-commit.
function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }

export function createBugReportPrompt() {
  let shownThisSession = false;
  let card = null;
  let timer = null;

  function dismiss() {
    if (!card) return;
    clearTimeout(timer);
    card.classList.remove('show');
    const gone = card;
    card = null;
    setTimeout(() => gone.remove(), 260);
  }

  function build() {
    // ⚠️ DOM, never innerHTML. Repo law — these strings are ours today, but the
    // rule is what stops the next person interpolating a filename in here.
    const el = document.createElement('div');
    el.id = 'bug-prompt';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');

    const small = document.createElement('div');
    small.className = 'bp-small';
    small.textContent = 'Halo user PDFLokal';

    const big = document.createElement('div');
    big.className = 'bp-big';
    big.textContent = 'Mohon kabarin saya ya kalo ada bug, di sini';

    // Not an <h1>: the page already has one, and the editor is CONSOLE mode
    // where display sizes are forbidden (specs/design-system.md). The founder
    // said "h1" meaning WEIGHT, not the tag — it renders at --fs-2, which
    // tokens.css marks as the editor's ceiling.
    el.append(small, big);

    // The whole card is the target. Clicking it opens the very dialog it points
    // at, by dispatching a click on the existing button rather than opening the
    // dialog directly — ONE door, one code path (feedback-form.js owns it).
    el.addEventListener('click', () => {
      dismiss();
      document.getElementById('contact-tab-btn')?.click();
    });

    return el;
  }

  let pending = false;

  function onVisible() {
    if (document.hidden) return;
    document.removeEventListener('visibilitychange', onVisible);
    pending = false;
    reveal();
  }

  // ⚠️⚠️ THE BUG THIS SHAPE EXISTS TO PREVENT — FOUND BY LOOKING, 2026-09-16.
  // The first version spent the day's cap the instant a trigger fired, then
  // showed the card on the next animation frame, then armed a 9s dismiss timer.
  // Watched in a real browser with the tab backgrounded: rAF is PAUSED while a
  // tab is hidden, so `show` was never added and the card sat at opacity 0 —
  // while setTimeout keeps running in the background, so the timer fired,
  // removed the invisible card, and the cap for the day was already gone.
  //
  // That is not an edge case. THE DOWNLOAD TRIGGER IS PRECISELY THE MOMENT A
  // REAL TAB LOSES VISIBILITY — Android's download sheet, the system
  // notification, the "open with" prompt. As first written, the download path
  // would have routinely burned the day's only showing on a card nobody could
  // see, and reported success while doing it: a silent failure inside the one
  // feature built to catch silent failures.
  //
  // So: nothing is spent and no timer runs until the card is VISIBLY on screen.
  // A trigger that lands while hidden is remembered and fires on return.
  function reveal() {
    // Re-checked here, not only at trigger time: while hidden, the user may
    // have gone back to the landing, where the anchor no longer exists.
    if (document.body.classList.contains('is-empty')) return;

    shownThisSession = true;
    safeSet(LAST_SHOWN_KEY, new Date().toDateString()); // spent only when SEEN

    card = build();
    document.body.appendChild(card);
    // Force a synchronous style flush so the hidden start state is committed,
    // then flip the class. NOT requestAnimationFrame: rAF is the call that was
    // paused, and this path must not depend on anything a hidden tab suspends.
    void card.offsetWidth;
    card.classList.add('show');

    // Auto-dismisses because this fires MID-EDIT and must not become furniture.
    // Missing it costs nothing — the button it points at is permanent, which is
    // the whole reason this card teaches a location instead of being one.
    timer = setTimeout(dismiss, AUTO_DISMISS_MS);
  }

  function maybeShow() {
    // Never over the landing: the anchor it points at is display:none there
    // (body.is-empty), so the arrow would aim at nothing.
    if (document.body.classList.contains('is-empty')) return false;
    if (shownThisSession || pending) return false;
    if (safeGet(LAST_SHOWN_KEY) === new Date().toDateString()) return false;

    if (document.hidden) {
      pending = true;
      document.addEventListener('visibilitychange', onVisible);
      return true; // accepted; it will show on return, and not before
    }
    reveal();
    return true;
  }

  // ⚠️ THE DOWNLOAD MOMENT IS ALREADY OCCUPIED — FOUND BY SCREENSHOT, 2026-09-16.
  // celebrate.js shows #support-card ("Selesai, filemu udah jadi!") ~200ms after
  // the same download, pinned to the same bottom edge. Rendered at 375px, that
  // card sat directly ON TOP of this one and hid it completely — the prompt was
  // in the DOM, at opacity 1, and unreadable. Every functional check passed.
  //
  // He ruled that two asks on one day are fine ("gpp dua ajakan"), so the answer
  // is not to suppress either. It is to SEQUENCE them: on the download trigger,
  // wait for whichever download-moment card is up to close, then ask.
  // #vote-card is the Play Store drive that can take the same slot
  // (PLAYSTORE_CAMPAIGN in celebrate.js); it is checked for the same reason.
  //
  // The edit-commit trigger needs none of this: nothing else fires on a commit.
  //
  // ⚠️ AND #toast, FOUND BY THE DARK-MODE SCREENSHOT, same day. The Tip-Ex arm
  // hint ("Seret di halaman untuk menutup teks") is centred at bottom:76px and at
  // 375px it runs straight through this card. It is up at exactly the moment of a
  // first commit — arm, then drag — so on the EDIT trigger this was the common
  // case, not a corner. A toast always self-clears after 2.6s (app.js toast()),
  // so waiting on it is short and bounded.
  const OCCUPANTS = ['#support-card.show', '#vote-card.show', '#toast.show'];
  const SETTLE_MS = 450; // celebrate's own card appears 200ms after the download
  const POLL_MS = 400;
  // The celebrate card waits on the USER to close it, who may never do so. After
  // this long the trigger gives up WITHOUT spending the day, so a later commit or
  // download can try again. Without a bound this is a poll that never ends.
  const MAX_WAIT_MS = 60000;

  function occupied() {
    return OCCUPANTS.some((sel) => document.querySelector?.(sel));
  }

  // The same gates maybeShow applies, checked up front, so a trigger on a day
  // already spent never starts a polling loop for nothing.
  function gatesOpen() {
    if (document.body.classList.contains('is-empty')) return false;
    if (shownThisSession || pending) return false;
    if (safeGet(LAST_SHOWN_KEY) === new Date().toDateString()) return false;
    return true;
  }

  function deferUntilClear(firstDelay) {
    pending = true;
    let waited = 0;
    const tick = () => {
      if (occupied()) {
        waited += POLL_MS;
        if (waited >= MAX_WAIT_MS) { pending = false; return; } // not spent — retry later
        setTimeout(tick, POLL_MS);
        return;
      }
      pending = false;
      maybeShow();
    };
    setTimeout(tick, firstDelay);
    return true;
  }

  function onDownloadSuccess() {
    if (!gatesOpen()) return false;
    // Always deferred: celebrate's card is not up YET at this instant — it
    // arrives ~200ms later — so "is the floor clear right now" would say yes and
    // then be wrong a moment later.
    return deferUntilClear(SETTLE_MS);
  }

  function onEditCommit() {
    if (!gatesOpen()) return false;
    // Immediate when nothing is in the way, which is what keeps this path
    // synchronous in the common case; deferred only behind a live toast.
    if (!occupied()) return maybeShow();
    return deferUntilClear(POLL_MS);
  }

  return {
    // Both triggers share one cap, so "whichever is first" falls out for free
    // rather than needing the two to know about each other.
    onDownloadSuccess,
    onEditCommit,
    // Test seam only.
    __dismiss: dismiss,
  };
}
