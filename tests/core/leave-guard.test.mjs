/*
 * Headless test for the browser's "leave site?" prompt (js/v2/leave-guard.js).
 * Run: npm run test:core
 *
 * THE PROPERTY: closing the tab or quitting asks first whenever there is work
 * nobody has downloaded. Two sources of that work:
 *   1. the document's history says it changed (core/history.js -> setLeaveGuard);
 *   2. an inline text editor is OPEN and holds text it did not open with.
 * The second exists because the editor now stays open across a window or app
 * switch (js/v2/editor-blur.js): typed text on a clean document is not in the
 * history yet, so without it Cmd+Tab, then quitting the browser, lost the text
 * with no prompt (founder ruling 2026-10-06: the leave warning ships).
 * The editor side must not record a history step, so it is a live check read
 * at unload time, registered by the editor and released by its commit.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// leave-guard.js binds to the global `window`; a bare EventTarget stands in.
globalThis.window = new EventTarget();
const lg = await import('../../js/v2/leave-guard.js');

// What the browser does on close: dispatch a cancelable beforeunload and show
// its prompt only when a handler cancelled it.
function wouldPrompt() {
  const e = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
}

beforeEach(() => { lg.setLeaveGuard(false); });

test('history dirty prompts; clean does not', () => {
  assert.equal(wouldPrompt(), false);
  lg.setLeaveGuard(true);
  assert.equal(wouldPrompt(), true);
  lg.setLeaveGuard(false);
  assert.equal(wouldPrompt(), false);
});

test('an open editor holding typed text prompts on a clean document', () => {
  let typed = false;
  const release = lg.guardDraft(() => typed);
  assert.equal(wouldPrompt(), false, 'editor open, nothing typed yet');
  typed = true;
  assert.equal(wouldPrompt(), true, 'typed text not in the history yet');
  release();
  assert.equal(wouldPrompt(), false, 'committed: history owns it from here');
});

test('a stale editor check reads false, so a destroyed editor never prompts by itself', () => {
  // An editor removed without its commit (a file dropped while typing) leaves
  // its registration; the check is live, so it reads its own element's state.
  const release = lg.guardDraft(() => false);
  assert.equal(wouldPrompt(), false);
  release();
});

test('releasing an older editor does not drop the newer editor\'s hold', () => {
  // Opening a second editor focuses it; the first one's blur commits AFTER
  // the second registered. Its release must leave the second one armed.
  const releaseFirst = lg.guardDraft(() => true);
  const releaseSecond = lg.guardDraft(() => true);
  releaseFirst();
  assert.equal(wouldPrompt(), true);
  releaseSecond();
  assert.equal(wouldPrompt(), false);
});

test('history dirty still prompts while an editor is open and unchanged', () => {
  const release = lg.guardDraft(() => false);
  lg.setLeaveGuard(true);
  assert.equal(wouldPrompt(), true);
  release();
  assert.equal(wouldPrompt(), true);
});
