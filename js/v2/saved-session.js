/*
 * PDFLokal — v2/saved-session.js  (the open document's relationship to the saved store)
 * ============================================================================
 * Glue between app.js, the pure rules (core/saved-docs.js), the store
 * (saved-store.js) and the tab presence (doc-presence.js). specs/spec-simpan-editan.md
 * is the authority; this file is "who writes what, when".
 *
 * SLOTS. The tab's one open document has two possible stored identities:
 *   autoId    its AUTOSAVE slot. Allocated when the document opens; the entry
 *             itself only appears on the first change (spec: "every recorded
 *             change updates the open document's autosave"). A reopened autosave
 *             adopts its old id, so editing continues the same slot.
 *   manualId  the MANUAL entry it is linked to, if any: set by "Simpan editan" or
 *             by opening a manual entry. Saving again updates that entry.
 * The tab holds a lock (doc-presence.js) on each, for as long as the document is
 * open. A tab never writes an id it does not hold.
 *
 * COPIES. Opening an entry another tab holds claims nothing and opens a COPY:
 * fresh autoId, no manual link. Two tabs therefore never write the same slot.
 *
 * FAILURE POLICY (spec: tell the user once, never break editing). Every storage
 * call here is inside a catch. An autosave failure toasts ONCE per page session; a
 * manual save failure always toasts (the user is waiting on that answer). A
 * "blocked" store (private mode, storage disabled) switches autosave off for the
 * session instead of failing every second.
 *
 * WHAT IT NEVER DOES: read the document before a debounce fires (history.record()
 * runs BEFORE its mutation), save while an editor draft is open (a Ganti cover
 * exists before its replacement does), or send a file name anywhere.
 */
import {
  serializeDoc, deserializeDoc, blobOf, createAutosaveScheduler, storageFailureKind, SavedDocError,
} from '../core/saved-docs.js';
import { pagesBucket } from '../core/telemetry-schema.js';

function newId(prefix) {
  let rnd = '';
  try {
    const a = new Uint32Array(2);
    globalThis.crypto.getRandomValues(a);
    rnd = `${a[0].toString(36)}${a[1].toString(36)}`;
  } catch { rnd = Math.random().toString(36).slice(2, 12); }
  return `${prefix}-${Date.now().toString(36)}-${rnd}`;
}

export function createSavedSession({
  store, presence,
  getDoc,            // () => Doc (live)
  getName,           // () => display name of the open document
  isBusy,            // () => true while an editor draft is open
  adopt,             // async ({ doc, name }) => void: put a restored doc on screen
  toast,             // (message) => void
  msg,               // (key) => string: the failure copy lives in locales
  tel,               // (event, props) => void (additive events only)
  now = Date.now,
}) {
  let slot = null;            // { autoId, manualId, ready, have: Map(entryId -> Set(sourceId)) }
  let disabled = false;       // storage blocked: autosave is off for this session
  let autoFailureToasted = false;
  let persistAsked = false;
  let inFlight = Promise.resolve();

  const scheduler = createAutosaveScheduler({
    run: () => runAutosave(),
    canRun: () => !isBusy(),
    onError: (err) => reportAutoFailure(err),
  });

  // ---- slot lifecycle --------------------------------------------------------

  // A document just became the open one. `autoId`/`manualId` are set when it is a
  // reopened entry this tab now owns; `have` says which sources are already stored.
  function begin({ autoId = null, manualId = null, have = new Map() } = {}) {
    releaseSlot();
    const id = autoId || newId('a');
    const claims = [presence.claim(id)];
    if (manualId) claims.push(presence.claim(manualId));
    slot = { autoId: id, manualId: manualId || null, have, ready: Promise.all(claims).then(() => undefined) };
  }

  function releaseSlot() {
    if (!slot) return;
    presence.release(slot.autoId);
    if (slot.manualId) presence.release(slot.manualId);
    slot = null;
  }

  // The open document is going away ("Buka Baru", or another entry replacing it):
  // save what is pending NOW (run() reads the live doc synchronously, before the
  // caller replaces it), wait for the write, release the locks. Never throws.
  async function end() {
    try {
      scheduler.flush();
      await inFlight;
    } catch { /* a failed last save is reported by its own path */ }
    scheduler.cancel();
    releaseSlot();
  }

  // ---- writing ---------------------------------------------------------------

  // Step 1, SYNCHRONOUS: read the live document into a job. Nothing before this
  // may await, or a flush() ahead of "Buka Baru" would capture the NEW document.
  function capture(forSlot, { id, kind }) {
    const doc = getDoc();
    if (!doc.pages.length) return null;
    const name = getName();
    const have = forSlot.have.get(id) || new Set();
    const cap = serializeDoc(doc, { name, haveBytes: have });
    return {
      forSlot, id, kind, cap,
      sources: doc.sources.slice(), // refs only: for a full retry if the store lacks bytes
      pageCount: doc.pages.length,
      meta: {
        id, kind, name, updatedAt: now(), createdAt: now(),
        pages: doc.pages.length,
        sourceIds: cap.state.sources.map((s) => s.id),
        stateBytes: JSON.stringify(cap.state).length,
      },
    };
  }

  // Step 2, async: write the job. -> the store's result.
  async function commit(job, protect = new Set()) {
    const { meta, cap, sources } = job;
    let res = await store.save({ meta, state: cap.state, blobs: cap.blobs, protect });
    if (!res.ok) {
      // The entry lost bytes (deleted or evicted from another tab): send them all.
      res = await store.save({ meta, state: cap.state, blobs: sources.map(blobOf), protect });
    }
    if (res.ok) job.forSlot.have.set(job.id, new Set(meta.sourceIds));
    return res;
  }

  async function protectedIds() {
    try { return new Set([...presence.mine(), ...(await presence.heldElsewhere())]); } catch { return presence.mine(); }
  }

  function runAutosave() {
    if (disabled || !slot) return undefined;
    const mine = slot;
    const job = capture(mine, { id: mine.autoId, kind: 'auto' }); // before any await
    if (!job) return undefined;
    const work = (async () => {
      await mine.ready;
      await commit(job, await protectedIds());
    })();
    inFlight = work.catch(() => {});
    return work;
  }

  function reportAutoFailure(err) {
    const kind = storageFailureKind(err);
    if (kind === 'blocked') disabled = true;
    if (autoFailureToasted) return;
    autoFailureToasted = true;
    toast(msg(failureCopyKey(err)));
  }

  // storage failure -> the key of the copy that explains it (locales: saved.fail*)
  function failureCopyKey(err) {
    const kind = storageFailureKind(err);
    return kind === 'quota' ? 'quota' : kind === 'blocked' ? 'blocked' : 'other';
  }

  // ---- public ----------------------------------------------------------------

  // Called on every document change (history onChange).
  function touch() {
    if (disabled) return;
    if (!slot) begin();
    scheduler.touch();
  }

  // "Simpan editan". Resolves { ok } and always tells the user the outcome.
  async function saveManual() {
    const doc = getDoc();
    if (!doc.pages.length) return { ok: false };
    if (!slot) begin();
    const mine = slot;
    const update = !!mine.manualId;
    const id = mine.manualId || newId('m');
    const job = capture(mine, { id, kind: 'manual' }); // the document as it is at the tap
    try {
      await mine.ready;
      const claimed = update || await presence.claim(id);
      if (!claimed) throw Object.assign(new Error('claim'), { name: 'InvalidStateError' });
      // persist() on the FIRST manual save of the session. The browser decides;
      // the UI never promises permanence (spec).
      if (!persistAsked) { persistAsked = true; store.requestPersist(); }
      const res = await commit(job);
      if (!res.ok) throw new Error('save refused');
      if (slot === mine) mine.manualId = id; else presence.release(id);
      tel('save_manual', { pages: pagesBucket(job.pageCount), update });
      return { ok: true, update };
    } catch (err) {
      if (!update) presence.release(id);
      toast(msg(failureCopyKey(err)));
      return { ok: false };
    }
  }

  // Open a stored entry in this tab. `copy` forces a copy; it is also what happens
  // by itself when another tab holds the entry. Resolves true when it is open.
  async function openEntry(id) {
    if (presence.mine().has(id)) return true; // already this tab's document
    let loaded;
    try { loaded = await store.load(id); } catch (err) { toast(msg(storageFailureKind(err) === 'blocked' ? 'blocked' : 'openFail')); return false; }
    if (!loaded?.state) { toast(msg('openFail')); return false; }
    let restored;
    try {
      restored = deserializeDoc(loaded.state, loaded.blobs);
    } catch (err) {
      if (!(err instanceof SavedDocError)) console.warn('saved doc unreadable:', err);
      toast(msg('openFail'));
      return false;
    }
    const kind = loaded.meta.kind;
    // Claim BEFORE adopting: the lock is the atomic answer to "may this tab own
    // that slot?". Refused means another tab has it, and this tab opens a copy.
    const owned = await presence.claim(id);
    await end(); // the document being replaced is saved first (its autosave keeps it)
    try {
      await adopt({ doc: restored.doc, name: restored.name || loaded.meta.name });
    } catch (err) {
      if (owned) presence.release(id);
      console.warn('restore failed:', err);
      toast(msg('openFail'));
      return false;
    }
    const have = new Map(owned ? [[id, new Set(loaded.meta.sourceIds)]] : []);
    if (owned && kind === 'auto') begin({ autoId: id, have });
    else if (owned && kind === 'manual') begin({ manualId: id, have });
    else begin();
    return true;
  }

  async function remove(id) {
    try { await store.remove(id); return true; } catch (err) { toast(msg(storageFailureKind(err) === 'blocked' ? 'blocked' : 'other')); return false; }
  }

  return {
    begin, end, touch, saveManual, openEntry, remove,
    flush: () => scheduler.flush(),
    ownIds: () => (slot ? [slot.autoId, slot.manualId].filter(Boolean) : []),
    get disabled() { return disabled; },
  };
}
