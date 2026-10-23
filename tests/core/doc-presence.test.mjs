/*
 * Headless tests for js/v2/doc-presence.js — which documents are open in which tab.
 * The multi-tab rule (specs/spec-simpan-editan.md): a tab holds a Web Lock named after
 * its document slot; another tab sees the lock and treats that entry as open elsewhere.
 * Where Web Locks is missing, BroadcastChannel presence pings; where neither exists,
 * single-tab behaviour (nothing is ever "elsewhere").
 *
 * The fakes below implement the two semantics the code depends on: `ifAvailable` locks
 * (null callback argument when held) and a query() that lists held names from every
 * tab. A real browser is exercised by tests/saved-multitab.spec.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPresence, LOCK_PREFIX } from '../../js/v2/doc-presence.js';

function lockManager() {
  const held = new Set();
  return {
    request(name, opts, cb) {
      if (opts?.ifAvailable && held.has(name)) return Promise.resolve(cb(null));
      held.add(name);
      let out;
      try { out = Promise.resolve(cb({ name })); } catch (e) { held.delete(name); throw e; }
      return out.finally(() => held.delete(name));
    },
    query: async () => ({ held: [...held].map((name) => ({ name, mode: 'exclusive' })), pending: [] }),
    _held: held,
  };
}

function channelHub() {
  const members = new Set();
  return (name) => {
    const me = { name, onmessage: null, closed: false, postMessage(msg) { for (const o of members) if (o !== me && !o.closed && o.onmessage) setImmediate(() => o.onmessage({ data: JSON.parse(JSON.stringify(msg)) })); }, close() { me.closed = true; members.delete(me); } };
    members.add(me);
    me.addEventListener = (type, fn) => { if (type === 'message') me.onmessage = fn; };
    return me;
  };
}

test('locks: a claimed id is held, shows as elsewhere to another tab, and frees on release', async () => {
  const mgr = lockManager();
  const a = createPresence({ locks: mgr }); const b = createPresence({ locks: mgr });
  assert.equal(a.mode, 'locks');
  assert.equal(await a.claim('x1'), true);
  assert.ok(mgr._held.has(`${LOCK_PREFIX}x1`));
  assert.deepEqual([...await b.heldElsewhere()], ['x1']);
  assert.deepEqual([...await a.heldElsewhere()], [], 'a tab never sees its OWN slot as elsewhere');
  a.release('x1');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([...await b.heldElsewhere()], []);
});

test('locks: claiming an id another tab holds fails atomically (this is what makes "open a copy" race-free)', async () => {
  const mgr = lockManager();
  const a = createPresence({ locks: mgr }); const b = createPresence({ locks: mgr });
  assert.equal(await a.claim('x1'), true);
  assert.equal(await b.claim('x1'), false);
  assert.ok(!b.mine().has('x1'));
  assert.equal(await b.claim('x2'), true);
});

test('locks: foreign lock names are ignored', async () => {
  const mgr = lockManager();
  mgr._held.add('some-other-lock');
  const a = createPresence({ locks: mgr });
  assert.deepEqual([...await a.heldElsewhere()], []);
});

test('channel fallback: the same answers through presence pings', async () => {
  const hub = channelHub();
  const a = createPresence({ locks: null, makeChannel: hub, wait: 20 });
  const b = createPresence({ locks: null, makeChannel: hub, wait: 20 });
  assert.equal(a.mode, 'channel');
  assert.equal(await a.claim('x1'), true);
  assert.deepEqual([...await b.heldElsewhere()], ['x1']);
  assert.deepEqual([...await a.heldElsewhere()], []);
  assert.equal(await b.claim('x1'), false);
  a.release('x1');
  assert.deepEqual([...await b.heldElsewhere()], []);
  assert.equal(await b.claim('x1'), true);
});

test('neither Web Locks nor BroadcastChannel: single-tab behaviour, nothing ever throws', async () => {
  const p = createPresence({ locks: null, makeChannel: () => null });
  assert.equal(p.mode, 'none');
  assert.equal(await p.claim('x1'), true);
  assert.deepEqual([...await p.heldElsewhere()], []);
  p.release('x1');
});

test('a locks backend that throws degrades to single-tab instead of breaking the editor', async () => {
  const p = createPresence({ locks: { request: () => { throw new Error('SecurityError'); }, query: () => Promise.reject(new Error('x')) }, makeChannel: () => null });
  assert.equal(await p.claim('x1'), true);
  assert.deepEqual([...await p.heldElsewhere()], []);
});
