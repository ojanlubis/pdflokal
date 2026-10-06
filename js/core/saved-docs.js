/*
 * PDFLokal — core/saved-docs.js  (HEADLESS — "Simpan editan", pure half)
 * ============================================================================
 * Spec: specs/spec-simpan-editan.md (the seat). Two ways a document survives
 * leaving the tab, both only in the user's browser (IndexedDB, js/v2/saved-store.js):
 * a manual save, and an automatic "last 5 opened". This file is everything about
 * them that needs no browser: turning a Doc into plain data and back, which
 * autosaves to evict, which one to offer on return, and the debounce that decides
 * WHEN to save. The I/O is elsewhere on purpose, so all of this runs under
 * `node --test` (tests/core/saved-docs.test.mjs).
 *
 * WHAT IS SAVED, AND WHAT IS NOT. The Doc is already one source of truth
 * (model.js): sources (raw bytes), pages (order, rotation, size) and the
 * annotations each page owns. That is the whole saved state. NOT saved:
 *   - undo history (spec: a reopened doc starts with a clean stack);
 *   - selection;
 *   - RENDER CACHES the app hangs on live pages — `raster`, `editApplied`
 *     (a Set), `editOutcomes`. They are derived. Restore leaves `raster: null`,
 *     which is exactly the state undo leaves a page in when its raster no longer
 *     fits, so the viewport stream renders it through the edited-page provider
 *     and a Ganti edit is RE-BAKED from the pristine source bytes + the
 *     annotations. Nothing here bakes anything.
 * The test of "is this field state or cache" is the key list RENDER_CACHE below;
 * everything else on a page is kept, so a field importPdf adds tomorrow
 * (`baseRotation` was added exactly that way) is saved without anyone remembering.
 *
 * IDS ARE KEPT VERBATIM (see model.js reserveIds): annotations reference each
 * other by id, and re-minting would mean rewriting every such field.
 *
 * BYTES LIVE APART FROM STATE. serializeDoc returns `state` (plain JSON-safe
 * data) and `blobs` (one per source). The store writes the blobs once per slot
 * and only the state on every later autosave: a 40 MB PDF is not rewritten
 * because someone moved a text box.
 */
import { createDoc, reserveIds } from './model.js';

export const SAVED_VERSION = 1;
export const AUTOSAVE_KEEP = 5;      // spec: the last 5 documents, by last change
export const AUTOSAVE_DELAY_MS = 1000; // spec: ~1 s after the last change

// Page keys that are caches of what the screen shows, never document state.
// ⚠️ A new render cache on a page must be added here or it gets saved (a Set
// would not even survive JSON). tests/core/saved-docs.test.mjs checks the three
// that exist today.
const RENDER_CACHE = ['raster', 'editApplied', 'editOutcomes'];

const ROTATIONS = new Set([0, 90, 180, 270]);

export class SavedDocError extends Error {
  // code: 'version' | 'shape' | 'missing-bytes' | 'orphan-page' | 'bad-page'
  constructor(code, detail = '') {
    super(`saved document unreadable: ${code}${detail ? ` (${detail})` : ''}`);
    this.name = 'SavedDocError';
    this.code = code;
  }
}

// A deep, independent copy. structuredClone where it exists; the JSON fallback is
// safe because a saved state is plain data by construction (that is tested).
function clonePlain(value) {
  if (typeof globalThis.structuredClone === 'function') return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

// The bytes as their OWN ArrayBuffer. A Uint8Array that is a view into a larger
// buffer (a subarray, a pooled read) would drag the whole backing store into
// IndexedDB's structured clone; copying out just the view's range prevents that.
function ownBuffer(bytes) {
  if (bytes instanceof ArrayBuffer) return bytes.slice(0);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

// One source's bytes as a blob record. Exported so the caller can build the rest
// on demand (the store asked for bytes it does not have: see saved-store.js).
export function blobOf(source) {
  return { sourceId: source.id, bytes: ownBuffer(source.bytes) };
}

// -> { state, blobs: [{ sourceId, bytes: ArrayBuffer }] }. Pure; never touches `doc`.
// `haveBytes` (a Set of source ids): sources whose bytes are already stored for
// this entry. They are left OUT of `blobs`, which is what makes an autosave cheap:
// copying a 40 MB PDF's bytes to write them a second time is the cost to avoid.
export function serializeDoc(doc, { name = '', haveBytes = new Set() } = {}) {
  const state = {
    v: SAVED_VERSION,
    name: String(name),
    sources: doc.sources.map((s) => ({
      id: s.id, name: s.name, numPages: s.numPages, encrypted: !!s.encrypted, signed: !!s.signed,
    })),
    pages: doc.pages.map((p) => {
      const kept = {};
      for (const [k, v] of Object.entries(p)) {
        if (k === 'annotations' || RENDER_CACHE.includes(k)) continue;
        kept[k] = v;
      }
      return { ...kept, annotations: clonePlain(p.annotations) };
    }),
  };
  const blobs = doc.sources.filter((s) => !haveBytes.has(s.id)).map(blobOf);
  return { state, blobs };
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const finitePos = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;

// state + a Map(sourceId -> ArrayBuffer | Uint8Array) -> { doc, name }.
// Validates before building: a damaged record is refused with a code, never
// half-restored into the editor. Moves the id counter past every restored id.
export function deserializeDoc(state, bytesBySource) {
  if (!isObj(state)) throw new SavedDocError('shape');
  if (state.v !== SAVED_VERSION) throw new SavedDocError('version', String(state.v));
  if (!Array.isArray(state.sources) || !Array.isArray(state.pages)) throw new SavedDocError('shape');

  const doc = createDoc();
  const bySrc = new Map();
  for (const s of state.sources) {
    if (!isObj(s) || typeof s.id !== 'string') throw new SavedDocError('shape', 'source');
    const raw = bytesBySource.get(s.id);
    if (!raw || !(raw.byteLength > 0)) throw new SavedDocError('missing-bytes', s.id);
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    const source = {
      id: s.id, name: s.name, bytes, numPages: s.numPages, encrypted: !!s.encrypted, signed: !!s.signed,
    };
    doc.sources.push(source);
    bySrc.set(s.id, source);
  }

  for (const p of state.pages) {
    if (!isObj(p) || typeof p.id !== 'string') throw new SavedDocError('shape', 'page');
    const source = bySrc.get(p.sourceId);
    if (!source) throw new SavedDocError('orphan-page', p.id);
    const okShape = finitePos(p.width) && finitePos(p.height)
      && ROTATIONS.has(p.rotation)
      && Number.isInteger(p.sourcePageNum) && p.sourcePageNum >= 0 && p.sourcePageNum < Math.max(1, source.numPages)
      && Array.isArray(p.annotations)
      && p.annotations.every((a) => isObj(a) && typeof a.id === 'string' && typeof a.type === 'string');
    if (!okShape) throw new SavedDocError('bad-page', p.id);
    doc.pages.push({ ...clonePlain(p), raster: null });
  }

  reserveIds([
    ...doc.sources.map((s) => s.id),
    ...doc.pages.map((p) => p.id),
    ...doc.pages.flatMap((p) => p.annotations.map((a) => a.id)),
  ]);
  return { doc, name: typeof state.name === 'string' ? state.name : '' };
}

// ---- which autosaves to drop ---------------------------------------------------

// Ids of autosave entries to evict so only the newest `keep` remain. MANUAL SAVES
// ARE NEVER RETURNED, however old. `protect` (ids open in some tab) are never
// returned either: a slot another tab is editing must not vanish under it — the
// cap is then met by evicting the next-oldest unprotected autosave instead.
export function autosaveEvictions(entries, { keep = AUTOSAVE_KEEP, protect = new Set() } = {}) {
  const autos = entries
    .filter((e) => e.kind === 'auto')
    .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1)); // newest first
  const over = autos.length - keep;
  if (over <= 0) return [];
  const gone = [];
  for (let i = autos.length - 1; i >= 0 && gone.length < over; i--) {
    if (!protect.has(autos[i].id)) gone.push(autos[i].id);
  }
  return gone;
}

// The autosave to offer a returning visitor, or null. The LATEST autosave only:
// if a tab already has it open the dialog is skipped, not downgraded to an older
// entry (spec: "skipped when the latest autosave is open in another tab").
//
// "Nanti aja" IS REMEMBERED (seat call 2026-10-06): declining stamps the entry with
// `declinedAt`, the `updatedAt` it had at that moment. The ask returns only when the
// latest autosave is NEWER than that: another document (a newer entry, no stamp) or the
// same slot edited since. It lives on the entry, in the same store, so no new browser
// storage key exists for /privasi to list.
export function reopenCandidate(entries, heldElsewhere) {
  const latest = entries
    .filter((e) => e.kind === 'auto')
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (!latest || heldElsewhere.has(latest.id)) return null;
  if (latest.declinedAt != null && latest.declinedAt >= latest.updatedAt) return null;
  return latest;
}

// What the saved LIST shows: one row per document. An autosave slot linked to a manual
// entry (the manual entry names its slot, or the autosave names its manual entry) is the
// same document twice, so only the manual one is shown ("Yang kamu simpan"). A link to
// something that no longer exists hides nothing. Order is kept.
export function visibleEntries(entries) {
  const manual = new Set(entries.filter((e) => e.kind === 'manual').map((e) => e.id));
  const slotsOfManual = new Set(entries.filter((e) => e.kind === 'manual' && e.slotId).map((e) => e.slotId));
  return entries.filter((e) => !(e.kind === 'auto' && (slotsOfManual.has(e.id) || (e.manualId && manual.has(e.manualId)))));
}

// ---- when to save --------------------------------------------------------------

// Debounced, single-flight scheduler. touch() on every document change; run()
// happens `delay` ms after the LAST touch. Properties the autosave depends on:
//   - never two runs at once, and a touch that lands DURING a run is saved after
//     it (a change must never be lost to timing);
//   - `canRun()` false (the app says an editor draft is open: a Ganti cover that
//     exists before its replacement does) postpones, polling every `delay`,
//     rather than saving a half-made edit;
//   - flush() saves now if anything is pending and nothing is running (pagehide: synchronous,
//     best effort); drain() also waits out a save in flight and saves what landed behind it;
//     cancel() forgets;
//   - run() throwing is reported to onError and never stops later saves.
export function createAutosaveScheduler({
  run, canRun = () => true, delay = AUTOSAVE_DELAY_MS, onError = () => {},
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id),
}) {
  let timer = null;
  let dirty = false;
  let running = false;
  let current = Promise.resolve(); // the save in flight; settles AFTER `running` is cleared

  const arm = () => {
    if (timer != null) clearTimer(timer);
    timer = setTimer(fire, delay);
  };

  function fire() {
    timer = null;
    if (!dirty) return;
    if (running || !canRun()) { arm(); return; }
    go();
  }

  function go() {
    dirty = false;
    running = true;
    // run() is CALLED synchronously: its first lines read the live document, and a
    // flush() that precedes "Buka Baru" must see the doc it is flushing, not the
    // empty one that replaces it a moment later.
    let started;
    try { started = Promise.resolve(run()); } catch (err) { started = Promise.reject(err); }
    current = started
      .catch((err) => { try { onError(err); } catch { /* reporting never breaks saving */ } })
      .finally(() => { running = false; if (dirty && timer == null) arm(); });
  }

  return {
    touch() { dirty = true; arm(); },
    flush() {
      if (!dirty || running || !canRun()) return;
      if (timer != null) { clearTimer(timer); timer = null; }
      go();
    },
    // Everything pending is saved, INCLUDING a change that landed behind a save in flight
    // (flush() skips those: one run at a time). The caller is about to replace the document
    // ("Buka Baru", opening another entry), so it waits. Returns without saving while an editor
    // draft is open (canRun false), because a half-made edit is not worth saving and a draft that
    // never closes must not hang the caller. At most a few rounds: a document that changes
    // faster than it can be saved is not drained forever.
    async drain() {
      for (let round = 0; round < 4; round++) {
        if (running) await current;
        if (!dirty || !canRun()) return;
        if (timer != null) { clearTimer(timer); timer = null; }
        go();
        await current;
      }
    },
    cancel() { dirty = false; if (timer != null) { clearTimer(timer); timer = null; } },
    get pending() { return dirty; },
  };
}

// ---- small pure helpers -----------------------------------------------------------

// WebKit deletes all of a site's storage after 7 days without a visit (ITP), so
// Safari users are told so where they save. That is Safari proper AND every
// browser on iOS (they are all WebKit underneath). Chrome/Edge/Firefox/Android
// carry "Safari" in their UA too, hence the exclusions.
export function needsSafariNote(ua) {
  if (typeof ua !== 'string' || ua === '') return false;
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  return /Safari\//.test(ua) && !/Chrome\/|Chromium\/|CriOS|FxiOS|Edg\/|EdgA\/|OPR\/|Android/.test(ua);
}

// What went wrong with a storage call, as one word the UI can act on.
//   quota   — the browser's storage is full
//   blocked — private mode / storage disabled / not allowed
//   other
export function storageFailureKind(err) {
  const name = err?.name;
  if (name === 'QuotaExceededError') return 'quota';
  if (name === 'SecurityError' || name === 'InvalidStateError' || name === 'NotAllowedError') return 'blocked';
  return 'other';
}
