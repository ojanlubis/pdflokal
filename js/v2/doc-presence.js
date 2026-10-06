/*
 * PDFLokal — v2/doc-presence.js  (which saved documents are open in which tab)
 * ============================================================================
 * The multi-tab rule from specs/spec-simpan-editan.md, and nothing more: there is
 * NO live sync between tabs. Each tab is its own document with its own autosave
 * slot, and tabs never write into each other's slot. For that to hold, a tab must
 * be able to say "this slot is mine" and another tab must be able to see it.
 *
 *   - Web Locks (navigator.locks): a tab holds an exclusive lock named after the
 *     entry for as long as the document is open. The browser releases it when the
 *     tab dies, crash or not, which no flag in storage could do. claim() uses
 *     `ifAvailable`, so it is ATOMIC: two tabs racing to open the same entry
 *     cannot both win, and the loser opens a copy. heldElsewhere() uses query().
 *   - Fallback, BroadcastChannel: presence pings ("who has what?"). Best effort,
 *     with a small race window a lock does not have. Used only where Web Locks is
 *     missing.
 *   - Neither: single-tab behaviour. Nothing is ever "elsewhere", claim() succeeds.
 * Every path is total: a backend that throws degrades to single-tab, never to a
 * broken editor.
 *
 * Both backends are injectable so the whole contract runs under node --test
 * (tests/core/doc-presence.test.mjs).
 */
export const LOCK_PREFIX = 'pdflokal-doc:';
const CHANNEL = 'pdflokal-doc-presence';

export function createPresence({
  locks = globalThis.navigator?.locks,
  makeChannel = (name) => (typeof globalThis.BroadcastChannel === 'function' ? new globalThis.BroadcastChannel(name) : null),
  wait = 150, // how long a channel "who has what?" waits for answers
} = {}) {
  const mine = new Set();
  const releasers = new Map(); // id -> resolve fn of the held lock's promise

  const useLocks = !!(locks && typeof locks.request === 'function' && typeof locks.query === 'function');
  let channel = null;
  if (!useLocks) {
    try { channel = makeChannel(CHANNEL); } catch { channel = null; }
  }
  const mode = useLocks ? 'locks' : channel ? 'channel' : 'none';

  // ---- channel backend ----
  let askSeq = 0;
  const waiting = new Map(); // nonce -> Set collecting ids
  if (channel) {
    const onMessage = (e) => {
      const msg = e?.data;
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'who') {
        try { channel.postMessage({ t: 'have', n: msg.n, ids: [...mine] }); } catch { /* closed */ }
      } else if (msg.t === 'have' && waiting.has(msg.n) && Array.isArray(msg.ids)) {
        for (const id of msg.ids) waiting.get(msg.n).add(String(id));
      }
    };
    if (typeof channel.addEventListener === 'function') channel.addEventListener('message', onMessage);
    else channel.onmessage = onMessage;
  }
  function askOthers() {
    return new Promise((resolve) => {
      const n = `${Date.now()}-${askSeq++}`;
      const got = new Set();
      waiting.set(n, got);
      try { channel.postMessage({ t: 'who', n }); } catch { /* closed: nobody answers */ }
      setTimeout(() => { waiting.delete(n); resolve(got); }, wait);
    });
  }

  return {
    mode,
    mine: () => new Set(mine),

    // Hold `id` for as long as this tab keeps the document open. true = it is ours.
    async claim(id) {
      if (mine.has(id)) return true;
      if (mode === 'locks') {
        try {
          return await new Promise((resolve, reject) => {
            Promise.resolve(locks.request(`${LOCK_PREFIX}${id}`, { mode: 'exclusive', ifAvailable: true }, (lock) => {
              if (!lock) { resolve(false); return undefined; }
              mine.add(id);
              resolve(true);
              return new Promise((release) => { releasers.set(id, release); });
            })).catch(reject);
          });
        } catch {
          mine.add(id); // the lock service failed: behave as single-tab
          return true;
        }
      }
      if (mode === 'channel') {
        if ((await askOthers()).has(id)) return false;
        mine.add(id);
        return true;
      }
      mine.add(id);
      return true;
    },

    release(id) {
      mine.delete(id);
      const r = releasers.get(id);
      if (r) { releasers.delete(id); r(); }
    },

    // Ids held by OTHER tabs (never this tab's own).
    async heldElsewhere() {
      try {
        if (mode === 'locks') {
          const { held = [] } = await locks.query();
          return new Set(held
            .map((l) => l.name)
            .filter((n) => typeof n === 'string' && n.startsWith(LOCK_PREFIX))
            .map((n) => n.slice(LOCK_PREFIX.length))
            .filter((id) => !mine.has(id)));
        }
        if (mode === 'channel') {
          const got = await askOthers();
          for (const id of mine) got.delete(id);
          return got;
        }
      } catch { /* degrade to single-tab */ }
      return new Set();
    },
  };
}
