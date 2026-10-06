/*
 * PDFLokal — v2/saved-store.js  (IndexedDB for "Simpan editan")
 * ============================================================================
 * The I/O half of specs/spec-simpan-editan.md. Everything decidable without a
 * browser (what a document serializes to, which autosaves to evict, when to save)
 * is in core/saved-docs.js and tested headlessly; this file only moves that data
 * in and out of IndexedDB. NOTHING here is ever uploaded: the file's bytes stay in
 * the user's browser, on this device, and are deletable from the saved list.
 *
 * SCHEMA — database `pdflokal-saved`, version 1, three stores:
 *   entries  keyPath id      small meta, the only thing the LIST reads:
 *                            { id, kind: 'auto'|'manual', name, createdAt,
 *                              updatedAt, pages, sourceIds, blobBytes, stateBytes }
 *   states   keyPath id      { id, state }   the plain-data document state
 *                            (core/saved-docs.js serializeDoc), rewritten on
 *                            every autosave
 *   blobs    keyPath key     { key: `${entryId}|${sourceId}`, entryId, sourceId,
 *                            bytes: ArrayBuffer }   written ONCE per entry (a
 *                            source is append-only), index `entry` on entryId
 * Three stores so that listing a dozen saved documents never loads a 40 MB PDF
 * or a signature's data URL, and so an autosave rewrites a few KB, not the file.
 *
 * ONE TRANSACTION PER SAVE: meta + state + any new blobs + the autosave
 * evictions commit or roll back together. A save that hits the quota therefore
 * leaves the previous save intact instead of an entry without its bytes.
 *
 * `needBytes`: save() refuses (writing nothing) when an entry's state names a
 * source whose bytes are not stored and the caller did not send them. That is
 * what happens when the entry was deleted or evicted by ANOTHER tab while this
 * tab kept editing: the caller retries with every blob. Trusting the caller's
 * "already written" bookkeeping would instead leave an entry that cannot reopen.
 */
import { autosaveEvictions } from '../core/saved-docs.js';

const DB_NAME = 'pdflokal-saved';
const DB_VERSION = 1;

const wrap = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

const blobKey = (entryId, sourceId) => `${entryId}|${sourceId}`;

export function createSavedStore({ idb = globalThis.indexedDB } = {}) {
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!idb) { reject(Object.assign(new Error('indexedDB unavailable'), { name: 'SecurityError' })); return; }
      let req;
      try { req = idb.open(DB_NAME, DB_VERSION); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('entries', { keyPath: 'id' });
        db.createObjectStore('states', { keyPath: 'id' });
        db.createObjectStore('blobs', { keyPath: 'key' }).createIndex('entry', 'entryId');
      };
      req.onsuccess = () => {
        const db = req.result;
        // Another tab upgrading the schema (a later release) must not hang behind us.
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(Object.assign(new Error('blocked'), { name: 'InvalidStateError' }));
    });
    // A failed open is retried on the next call, not remembered forever.
    dbPromise.catch(() => { dbPromise = null; });
    return dbPromise;
  }

  // Run `work(tx)` in one transaction; resolves with its value once the
  // transaction has COMMITTED (not merely when the last request returned).
  async function inTx(stores, mode, work) {
    const db = await open();
    return new Promise((resolve, reject) => {
      let tx;
      try { tx = db.transaction(stores, mode); } catch (e) { reject(e); return; }
      let result;
      let failure = null;
      tx.oncomplete = () => (failure ? reject(failure) : resolve(result));
      tx.onabort = () => reject(failure || tx.error || new Error('aborted'));
      tx.onerror = () => { failure = failure || tx.error; };
      Promise.resolve()
        .then(() => work(tx))
        .then((v) => { result = v; })
        .catch((e) => { failure = e; try { tx.abort(); } catch { /* already finished */ } });
    });
  }

  async function deleteEntryIn(tx, id) {
    tx.objectStore('entries').delete(id);
    tx.objectStore('states').delete(id);
    const blobs = tx.objectStore('blobs');
    const keys = await wrap(blobs.index('entry').getAllKeys(id));
    for (const k of keys) blobs.delete(k);
  }

  return {
    // All entries' meta, newest first. Never loads state or bytes.
    async list() {
      const all = await inTx(['entries'], 'readonly', (tx) => wrap(tx.objectStore('entries').getAll()));
      return all.sort((a, b) => b.updatedAt - a.updatedAt);
    },

    // { meta, state, blobs: Map(sourceId -> ArrayBuffer) } or null.
    async load(id) {
      return inTx(['entries', 'states', 'blobs'], 'readonly', async (tx) => {
        const meta = await wrap(tx.objectStore('entries').get(id));
        if (!meta) return null;
        const row = await wrap(tx.objectStore('states').get(id));
        const blobRows = await wrap(tx.objectStore('blobs').index('entry').getAll(id));
        return {
          meta,
          state: row?.state ?? null,
          blobs: new Map(blobRows.map((b) => [b.sourceId, b.bytes])),
        };
      });
    },

    // Write one entry. `blobs`: [{ sourceId, bytes }] to store now (omit sources
    // already stored). `protect`: ids open in some tab, never evicted.
    // -> { ok: true, evicted: [ids] } | { ok: false, needBytes: [sourceIds] }
    async save({ meta, state, blobs = [], protect = new Set() }) {
      return inTx(['entries', 'states', 'blobs'], 'readwrite', async (tx) => {
        const entries = tx.objectStore('entries');
        const blobStore = tx.objectStore('blobs');
        const before = await wrap(entries.get(meta.id));

        const have = new Set(blobs.map((b) => b.sourceId));
        const missing = [];
        for (const sid of meta.sourceIds) {
          if (have.has(sid)) continue;
          if (!(await wrap(blobStore.count(blobKey(meta.id, sid))))) missing.push(sid);
        }
        // Nothing has been written yet, so returning here commits an empty transaction.
        if (missing.length) return { ok: false, needBytes: missing };

        tx.objectStore('states').put({ id: meta.id, state });
        for (const b of blobs) blobStore.put({ key: blobKey(meta.id, b.sourceId), entryId: meta.id, sourceId: b.sourceId, bytes: b.bytes });
        // The size is re-summed only when bytes were written (the first save of an
        // entry); every later autosave keeps the figure it already has.
        let blobBytes = before?.blobBytes ?? 0;
        if (blobs.length) {
          const rows = await wrap(blobStore.index('entry').getAll(meta.id));
          blobBytes = rows.reduce((n, r) => n + r.bytes.byteLength, 0);
        }
        entries.put({ ...meta, createdAt: before?.createdAt ?? meta.createdAt, blobBytes });

        let evicted = [];
        if (meta.kind === 'auto') {
          const all = await wrap(entries.getAll());
          evicted = autosaveEvictions(all, { protect: new Set([...protect, meta.id]) });
          for (const id of evicted) await deleteEntryIn(tx, id);
        }
        return { ok: true, evicted };
      });
    },

    async remove(id) {
      await inTx(['entries', 'states', 'blobs'], 'readwrite', (tx) => deleteEntryIn(tx, id));
    },

    // { usage, quota } for this origin, or null where the browser will not say.
    // usage is the WHOLE site (the offline app files count too), which is what the
    // spec asks the list to show: the browser's storage for PDFLokal on this device.
    async estimate() {
      try {
        const e = await globalThis.navigator?.storage?.estimate?.();
        return e && Number.isFinite(e.usage) ? { usage: e.usage, quota: e.quota } : null;
      } catch { return null; }
    },

    // Ask the browser not to evict our data under storage pressure. Called on the
    // first MANUAL save only. The UI never promises permanence (spec): this is a
    // request the browser may decline, and nothing here depends on the answer.
    async requestPersist() {
      try { return !!(await globalThis.navigator?.storage?.persist?.()); } catch { return false; }
    },
  };
}
