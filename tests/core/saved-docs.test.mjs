/*
 * Headless tests for core/saved-docs.js — "Simpan editan" (specs/spec-simpan-editan.md).
 * Run: npm run test:core
 *
 * What each group exists to catch, so none can pass by looking at nothing:
 *   - round trip:  a field the serializer forgets (a Ganti cover's replaceTargets,
 *                  an OCR cover's paperImage, a paragraph block) silently turns a
 *                  restored edit into a different edit. The fixture carries EVERY
 *                  annotation kind, and the comparison is deep-equal against the
 *                  live doc, not a spot check.
 *   - caches:      page.raster / editApplied (a Set) / editOutcomes are render
 *                  caches. Saving them is megabytes of PNG at best and, for
 *                  editApplied, a restored page whose overlay is suppressed
 *                  before any bake has produced the picture that justifies it.
 *   - ids:         annotations reference each other by id (replaceCoverId ...).
 *                  Restore keeps ids verbatim, so the id counter MUST move past
 *                  them or the next annotation of the restored session collides.
 *   - eviction:    last 5 autosaves by recency, manual saves never.
 *   - scheduler:   debounced, one run at a time, never loses a change that
 *                  arrives while a save is in flight.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDoc, createSource, createPage, createAnnotation, nextId, _resetIds } from '../../js/core/model.js';
import {
  addSource, addPages, removePage, reorderPage, rotatePage, addAnnotation, selectAnnotation,
} from '../../js/core/operations.js';
import {
  SAVED_VERSION, AUTOSAVE_KEEP, serializeDoc, deserializeDoc, SavedDocError,
  autosaveEvictions, reopenCandidate, createAutosaveScheduler, needsSafariNote, storageFailureKind, blobOf,
} from '../../js/core/saved-docs.js';

const bytes = (...n) => new Uint8Array(n);

// A document that has had every kind of edit the editor can make.
function editedDoc() {
  _resetIds();
  const doc = createDoc();
  const a = addSource(doc, createSource({ name: 'kontrak.pdf', bytes: bytes(1, 2, 3, 4), numPages: 3, encrypted: true, signed: true }));
  const b = addSource(doc, createSource({ name: 'foto.jpg', bytes: bytes(9, 8, 7), numPages: 1 }));
  const pages = [0, 1, 2].map((n) => createPage({ source: a, sourcePageNum: n, width: 595, height: 842 }));
  pages[0].baseRotation = 90; // set by importPdf, not by createPage
  const img = createPage({ source: b, sourcePageNum: 0, width: 600, height: 400, isFromImage: true });
  addPages(doc, [...pages, img]);

  const [p1, p2, p3] = pages;
  // plain authored text + whiteout + signature
  addAnnotation(doc, p1.id, createAnnotation('text', { text: 'halo', x: 10, y: 20, fontSize: 14, fontFamily: 'Helvetica', bold: true, italic: false, color: '#000000' }));
  addAnnotation(doc, p1.id, createAnnotation('whiteout', { x: 5, y: 6, width: 100, height: 20, color: '#ffffff' }));
  addAnnotation(doc, p1.id, createAnnotation('signature', { image: 'data:image/png;base64,AAAA', x: 50, y: 60, width: 150, height: 50 }));
  // Ganti: a cover bound to the original line + its replacement text
  const cover = addAnnotation(doc, p2.id, createAnnotation('whiteout', {
    x: 72, y: 100, width: 200, height: 14, color: '#fefefe',
    replaceTargets: [{ x: 72, y: 100, w: 120, h: 14, size: 12 }, { x: 192, y: 100, w: 80, h: 14, size: 12 }],
    replaceBox: { x: 72, y: 100, w: 200, h: 14 },
  }));
  addAnnotation(doc, p2.id, createAnnotation('text', {
    text: 'baru', x: 72, y: 100, fontSize: 12, fontFamily: 'Arimo', bold: false, italic: false, color: '#111111',
    replaceCoverId: cover.id, docFontFamily: 'doc-font-1', fontDecision: { path: 'native', flips: 0 },
  }));
  // OCR: a cover with a painted paper patch + its replacement
  const ocrCover = addAnnotation(doc, p3.id, createAnnotation('whiteout', {
    x: 20, y: 30, width: 90, height: 12, color: '#eeeeee', paperImage: 'data:image/png;base64,BBBB', ocrBox: { x: 20, y: 30, w: 90, h: 12 },
  }));
  addAnnotation(doc, p3.id, createAnnotation('text', { text: 'hasil scan', x: 20, y: 30, fontSize: 11, fontFamily: 'Helvetica', ocrCoverId: ocrCover.id }));
  // Paragraph block (Rung D)
  const blockCover = addAnnotation(doc, p3.id, createAnnotation('whiteout', {
    x: 20, y: 200, width: 300, height: 60, replaceTargets: [{ x: 20, y: 200, w: 300, h: 15, size: 12 }], replaceBox: { x: 20, y: 200, w: 300, h: 60 },
  }));
  addAnnotation(doc, p3.id, createAnnotation('text', {
    text: 'satu\ndua', x: 20, y: 200, fontSize: 12, replaceCoverId: blockCover.id,
    block: { lines: ['satu', 'dua'], k: 1, size: 12, leading: 1.2, srcLines: 4, below: null, disp: { x: 20, y: 200, w: 300 } },
  }));
  // legacy kinds the model still names
  addAnnotation(doc, img.id, createAnnotation('watermark', { text: 'DRAFT', opacity: 0.3 }));
  addAnnotation(doc, img.id, createAnnotation('pageNumber', { position: 'bottom-center' }));

  rotatePage(doc, p1.id, 90);
  rotatePage(doc, p2.id, 270);
  return { doc, cover };
}

// Render caches the app hangs on live pages — must never reach the saved state.
function dirtyCaches(doc) {
  for (const p of doc.pages) {
    p.raster = { dataUrl: 'data:image/png;base64,CCCC', width: 10, height: 10, scale: 2 };
    p.editApplied = new Set(p.annotations.map((a) => a.id));
    p.editOutcomes = [{ coverId: 'x', matched: true }];
  }
}

const liveShape = (doc) => doc.pages.map((p) => {
  const { raster, editApplied, editOutcomes, ...rest } = p;
  void raster; void editApplied; void editOutcomes;
  return rest;
});

function roundTrip(doc, name = 'kontrak') {
  const { state, blobs } = serializeDoc(doc, { name });
  const bySource = new Map(blobs.map((b) => [b.sourceId, b.bytes]));
  return { state, blobs, restored: deserializeDoc(state, bySource) };
}

// ---- round trip ----------------------------------------------------------------

test('round trip: every annotation kind, rotation, flags and bytes come back exactly', () => {
  const { doc } = editedDoc();
  const kinds = new Set(doc.pages.flatMap((p) => p.annotations.map((a) => a.type)));
  // VACUITY GUARD: the fixture must really contain every kind, or "every kind" proves nothing.
  assert.deepEqual([...kinds].sort(), ['pageNumber', 'signature', 'text', 'watermark', 'whiteout']);
  assert.ok(doc.pages.flatMap((p) => p.annotations).some((a) => a.replaceTargets), 'fixture lacks a Ganti cover');
  assert.ok(doc.pages.flatMap((p) => p.annotations).some((a) => a.paperImage), 'fixture lacks an OCR cover');
  assert.ok(doc.pages.flatMap((p) => p.annotations).some((a) => a.block), 'fixture lacks a paragraph block');

  dirtyCaches(doc);
  const { restored } = roundTrip(doc);
  assert.equal(restored.name, 'kontrak');
  assert.deepEqual(restored.doc.pages.map((p) => ({ ...p, raster: undefined })).map(({ raster, ...r }) => (void raster, r)), liveShape(doc));
  assert.deepEqual(restored.doc.sources, doc.sources);
  assert.deepEqual(restored.doc.selection, { pageId: null, annotationId: null });
});

test('round trip: encrypted and signed flags survive, per source', () => {
  const { doc } = editedDoc();
  const { restored } = roundTrip(doc);
  const [a, b] = restored.doc.sources;
  assert.deepEqual([a.encrypted, a.signed, b.encrypted, b.signed], [true, true, false, false]);
});

test('round trip: deleted and reordered pages stay deleted and reordered; their annotations travel', () => {
  const { doc } = editedDoc();
  const [p1, p2, p3] = doc.pages;
  removePage(doc, p2.id);
  reorderPage(doc, p3.id, 0);
  const order = doc.pages.map((p) => p.id);
  assert.deepEqual(order.slice(0, 2), [p3.id, p1.id]);
  const { restored } = roundTrip(doc);
  assert.deepEqual(restored.doc.pages.map((p) => p.id), order);
  assert.ok(!restored.doc.pages.some((p) => p.id === p2.id), 'a deleted page came back');
  assert.equal(restored.doc.pages[0].annotations.length, p3.annotations.length);
});

test('round trip: a source nothing uses any more still saves (merge then delete is undoable only by history, which is not saved)', () => {
  const { doc } = editedDoc();
  for (const p of [...doc.pages].filter((p) => p.isFromImage)) removePage(doc, p.id);
  const { state, restored } = roundTrip(doc);
  assert.equal(restored.doc.sources.length, 2, 'sources are saved whole: pages reference them by id');
  assert.equal(state.sources.length, 2);
});

test('the cross-references between annotations are intact after restore (ids are verbatim)', () => {
  const { doc, cover } = editedDoc();
  const { restored } = roundTrip(doc);
  const all = restored.doc.pages.flatMap((p) => p.annotations);
  const replacement = all.find((a) => a.replaceCoverId === cover.id);
  assert.ok(replacement, 'the replacement lost its cover id');
  assert.ok(all.some((a) => a.id === cover.id), 'the cover the replacement points at is gone');
  const ocr = all.find((a) => a.ocrCoverId);
  assert.ok(all.some((a) => a.id === ocr.ocrCoverId));
  for (const p of restored.doc.pages) assert.ok(restored.doc.sources.some((s) => s.id === p.sourceId));
});

// ---- caches, purity, shape --------------------------------------------------------

test('render caches never reach the saved state; the restored page has raster null and no editApplied', () => {
  const { doc } = editedDoc();
  dirtyCaches(doc);
  const { state, restored } = roundTrip(doc);
  const text = JSON.stringify(state);
  assert.ok(!text.includes('CCCC'), 'a page raster leaked into the saved state');
  for (const p of state.pages) {
    for (const k of ['raster', 'editApplied', 'editOutcomes']) assert.ok(!(k in p), `state page carries ${k}`);
  }
  for (const p of restored.doc.pages) {
    assert.equal(p.raster, null);
    assert.ok(!('editApplied' in p) || p.editApplied == null, 'restored page must not suppress overlays before a bake');
  }
});

test('the state is plain data: JSON round-trips to the same thing, and holds no bytes', () => {
  const { doc } = editedDoc();
  const { state } = serializeDoc(doc, { name: 'x' });
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
  assert.equal(state.v, SAVED_VERSION);
  assert.ok(state.sources.every((s) => !('bytes' in s)), 'bytes belong in blobs, written once per slot');
});

test('serializing never mutates the live doc, and later edits never reach an earlier state', () => {
  const { doc } = editedDoc();
  const before = JSON.stringify(liveShape(doc));
  const { state } = serializeDoc(doc, { name: 'x' });
  assert.equal(JSON.stringify(liveShape(doc)), before);
  const frozen = JSON.stringify(state);
  doc.pages[0].annotations[0].text = 'diubah sesudahnya';
  doc.pages[1].annotations[1].fontDecision.path = 'x';
  doc.pages[0].rotation = 180;
  assert.equal(JSON.stringify(state), frozen, 'the saved state aliases live objects');
});

test('blobs: one per source, the SAME bytes, never a view that drags a whole buffer along', () => {
  const { doc } = editedDoc();
  const big = new Uint8Array(100).map((_, i) => i);
  doc.sources[0].bytes = big.subarray(10, 14); // a view into a larger buffer
  const { blobs } = serializeDoc(doc, { name: 'x' });
  assert.equal(blobs.length, 2);
  const first = blobs.find((b) => b.sourceId === doc.sources[0].id);
  assert.deepEqual([...new Uint8Array(first.bytes)], [10, 11, 12, 13]);
  assert.equal(first.bytes.byteLength, 4, 'a view was stored with its whole backing buffer');
});

test('haveBytes: sources already stored are left out of the blobs, so an autosave does not re-copy the file', () => {
  const { doc } = editedDoc();
  const [a, b] = doc.sources;
  const { state, blobs } = serializeDoc(doc, { name: 'x', haveBytes: new Set([a.id]) });
  assert.deepEqual(blobs.map((x) => x.sourceId), [b.id]);
  assert.equal(state.sources.length, 2, 'the state still names every source');
  assert.equal(blobOf(a).bytes.byteLength, 4);
});

test('scheduler: run() starts synchronously inside flush(), so it reads the doc before it is replaced', () => {
  let started = false;
  const s = createAutosaveScheduler({ run: () => { started = true; return new Promise(() => {}); }, setTimer: () => 1, clearTimer: () => {} });
  s.touch(); s.flush();
  assert.equal(started, true);
});

// ---- restore: ids and validation -----------------------------------------------------

test('restore moves the id counter past every restored id', () => {
  const { doc } = editedDoc();
  const { state, blobs } = serializeDoc(doc, { name: 'x' });
  _resetIds(); // a fresh page load: the counter starts over
  const restored = deserializeDoc(state, new Map(blobs.map((b) => [b.sourceId, b.bytes])));
  const taken = new Set([...restored.doc.sources.map((s) => s.id), ...restored.doc.pages.map((p) => p.id), ...restored.doc.pages.flatMap((p) => p.annotations.map((a) => a.id))]);
  for (const prefix of ['src', 'page', 'anno']) {
    const fresh = nextId(prefix);
    assert.ok(!taken.has(fresh), `${fresh} collides with a restored id`);
  }
});

test('a damaged record is refused with a reason, never half-restored', () => {
  const { doc } = editedDoc();
  const { state, blobs } = serializeDoc(doc, { name: 'x' });
  const map = () => new Map(blobs.map((b) => [b.sourceId, b.bytes]));
  const clone = () => JSON.parse(JSON.stringify(state));
  const refused = (s, m, code) => assert.throws(() => deserializeDoc(s, m), (e) => e instanceof SavedDocError && e.code === code, code);

  refused({ ...clone(), v: 99 }, map(), 'version');
  refused(null, map(), 'shape');
  refused({ ...clone(), pages: 'x' }, map(), 'shape');
  const missing = map(); missing.delete(state.sources[0].id);
  refused(clone(), missing, 'missing-bytes');
  const orphan = clone(); orphan.pages[0].sourceId = 'src_nope';
  refused(orphan, map(), 'orphan-page');
  const rot = clone(); rot.pages[0].rotation = 45;
  refused(rot, map(), 'bad-page');
  const dim = clone(); dim.pages[0].width = 0;
  refused(dim, map(), 'bad-page');
  const range = clone(); range.pages[0].sourcePageNum = 99;
  refused(range, map(), 'bad-page');
  const noAnnos = clone(); delete noAnnos.pages[0].annotations;
  refused(noAnnos, map(), 'bad-page');
});

test('selection is not saved: a restored doc has nothing selected', () => {
  const { doc } = editedDoc();
  selectAnnotation(doc, doc.pages[0].annotations[0].id);
  assert.ok(doc.selection.annotationId);
  const { state, restored } = roundTrip(doc);
  assert.ok(!('selection' in state));
  assert.equal(restored.doc.selection.annotationId, null);
});

// ---- eviction: last 5 autosaves, manual never --------------------------------------------

const entry = (id, kind, updatedAt) => ({ id, kind, name: id, updatedAt });

test('autosave eviction keeps the newest 5 and never touches a manual save', () => {
  assert.equal(AUTOSAVE_KEEP, 5);
  const entries = [
    ...[1, 2, 3, 4, 5, 6, 7].map((n) => entry(`a${n}`, 'auto', n * 1000)),
    ...[1, 2, 3].map((n) => entry(`m${n}`, 'manual', n)), // older than every autosave, still safe
  ];
  const gone = autosaveEvictions(entries);
  assert.deepEqual(gone.sort(), ['a1', 'a2']);
});

test('eviction: at or under the cap evicts nothing; the order of the input does not matter', () => {
  const five = [5, 3, 1, 4, 2].map((n) => entry(`a${n}`, 'auto', n));
  assert.deepEqual(autosaveEvictions(five), []);
  assert.deepEqual(autosaveEvictions([]), []);
  const six = [6, 1, 5, 2, 4, 3].map((n) => entry(`a${n}`, 'auto', n));
  assert.deepEqual(autosaveEvictions(six), ['a1']);
});

test('eviction spares a slot another tab holds open, and evicts the next-oldest instead', () => {
  const six = [1, 2, 3, 4, 5, 6].map((n) => entry(`a${n}`, 'auto', n));
  const gone = autosaveEvictions(six, { protect: new Set(['a1']) });
  assert.deepEqual(gone, ['a2']);
  // the cap still counts the protected one: 5 kept = a1 (held) + the 4 newest
  const kept = six.filter((e) => !gone.includes(e.id));
  assert.equal(kept.length, 5);
  assert.ok(kept.some((e) => e.id === 'a1'));
});

// ---- the reopen candidate -----------------------------------------------------------------------

test('reopen candidate: the latest autosave; null when none, or when it is open in another tab', () => {
  const entries = [entry('a1', 'auto', 1), entry('a2', 'auto', 9), entry('m1', 'manual', 99)];
  assert.equal(reopenCandidate(entries, new Set()).id, 'a2', 'a manual save is never the reopen ask');
  assert.equal(reopenCandidate(entries, new Set(['a2'])), null, 'the latest is open elsewhere: skip the dialog, do not fall back to an older one');
  assert.equal(reopenCandidate([entry('m1', 'manual', 1)], new Set()), null);
  assert.equal(reopenCandidate([], new Set()), null);
});

// ---- the debounced scheduler ---------------------------------------------------------------------------

function fakeTimers() {
  let now = 0; let next = 1; const timers = new Map();
  return {
    setTimer: (fn, ms) => { const id = next++; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    advance: async (ms) => {
      now += ms;
      for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); }
      await new Promise((r) => setImmediate(r));
    },
    pending: () => timers.size,
  };
}

test('scheduler: a burst of changes is ONE save, 1 s after the last', async () => {
  const T = fakeTimers(); let runs = 0;
  const s = createAutosaveScheduler({ run: async () => { runs++; }, setTimer: T.setTimer, clearTimer: T.clearTimer });
  s.touch(); await T.advance(400); s.touch(); await T.advance(400); s.touch();
  await T.advance(999);
  assert.equal(runs, 0, 'saved before the quiet second elapsed');
  await T.advance(1);
  assert.equal(runs, 1);
  await T.advance(5000);
  assert.equal(runs, 1, 'nothing changed, nothing to save');
});

test('scheduler: a change that lands WHILE a save runs is saved afterwards, never dropped', async () => {
  const T = fakeTimers(); let runs = 0; let release;
  const s = createAutosaveScheduler({
    run: () => { runs++; return runs === 1 ? new Promise((r) => { release = r; }) : Promise.resolve(); },
    setTimer: T.setTimer, clearTimer: T.clearTimer,
  });
  s.touch(); await T.advance(1000);
  assert.equal(runs, 1);
  s.touch(); await T.advance(1000);
  assert.equal(runs, 1, 'two saves must never overlap');
  release(); await T.advance(0); // let the first save finish before time moves on
  await T.advance(1000);
  assert.equal(runs, 2);
});

test('scheduler: drain() saves a change that is pending BEHIND a save in flight (Buka Baru during an autosave must not lose it)', async () => {
  const T = fakeTimers(); let runs = 0; let release; const order = [];
  const s = createAutosaveScheduler({
    run: () => { runs++; order.push(`start${runs}`); return runs === 1 ? new Promise((r) => { release = () => { order.push('end1'); r(); }; }) : Promise.resolve(); },
    setTimer: T.setTimer, clearTimer: T.clearTimer,
  });
  s.touch(); await T.advance(1000);       // save 1 starts and hangs
  s.touch();                              // a newer change lands while it runs
  const drained = s.drain();
  await T.advance(0);
  assert.equal(runs, 1, 'the second save waits for the first');
  release();
  await drained;
  assert.equal(runs, 2, 'drain saved the newer change too');
  assert.deepEqual(order, ['start1', 'end1', 'start2']);
  assert.equal(s.pending, false);
});

test('scheduler: drain() with nothing pending returns at once, and gives up on a draft that never closes', async () => {
  const T = fakeTimers(); let runs = 0; let open = true;
  const s = createAutosaveScheduler({ run: async () => { runs++; }, canRun: () => !open, setTimer: T.setTimer, clearTimer: T.clearTimer });
  await s.drain();
  assert.equal(runs, 0);
  s.touch();
  await s.drain(); // an editor draft is open: do not save a half-made edit, do not hang either
  assert.equal(runs, 0);
  open = false;
  await s.drain();
  assert.equal(runs, 1);
});

test('scheduler: canRun false (an editor draft is open) postpones, and saves once it is closed', async () => {
  const T = fakeTimers(); let runs = 0; let open = true;
  const s = createAutosaveScheduler({ run: async () => { runs++; }, canRun: () => !open, setTimer: T.setTimer, clearTimer: T.clearTimer });
  s.touch(); await T.advance(1000); await T.advance(1000); await T.advance(1000);
  assert.equal(runs, 0);
  open = false; await T.advance(1000);
  assert.equal(runs, 1);
});

test('scheduler: flush saves now if something is pending, and is a no-op otherwise; cancel forgets it', async () => {
  const T = fakeTimers(); let runs = 0;
  const s = createAutosaveScheduler({ run: async () => { runs++; }, setTimer: T.setTimer, clearTimer: T.clearTimer });
  s.flush(); await T.advance(0);
  assert.equal(runs, 0);
  s.touch(); s.flush(); await T.advance(0);
  assert.equal(runs, 1);
  await T.advance(5000);
  assert.equal(runs, 1, 'the flushed change must not also fire from its timer');
  s.touch(); s.cancel(); await T.advance(5000);
  assert.equal(runs, 1);
  assert.equal(T.pending(), 0);
});

test('scheduler: a throwing save is reported, does not stop later saves, and does not unhandled-reject', async () => {
  const T = fakeTimers(); let runs = 0; const errors = [];
  const s = createAutosaveScheduler({
    run: async () => { runs++; if (runs === 1) throw new Error('quota'); },
    onError: (e) => errors.push(e.message), setTimer: T.setTimer, clearTimer: T.clearTimer,
  });
  s.touch(); await T.advance(1000);
  assert.deepEqual(errors, ['quota']);
  s.touch(); await T.advance(1000);
  assert.equal(runs, 2);
});

// ---- small pure helpers ---------------------------------------------------------------------------------------

test('Safari/WebKit note: Safari and every iOS browser, never Chrome/Firefox/Edge on a desktop or Android', () => {
  const safariMac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
  const iphoneSafari = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
  const iphoneChrome = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0 Mobile/15E148 Safari/604.1';
  const chromeMac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
  const edge = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 Edg/124.0';
  const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
  const firefox = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:125.0) Gecko/20100101 Firefox/125.0';
  assert.equal(needsSafariNote(safariMac), true);
  assert.equal(needsSafariNote(iphoneSafari), true);
  assert.equal(needsSafariNote(iphoneChrome), true, 'iOS Chrome is WebKit underneath');
  for (const ua of [chromeMac, edge, android, firefox, '', undefined]) assert.equal(needsSafariNote(ua), false, String(ua));
});

test('storage failure kinds: quota, blocked/private, other', () => {
  assert.equal(storageFailureKind({ name: 'QuotaExceededError' }), 'quota');
  assert.equal(storageFailureKind({ name: 'SecurityError' }), 'blocked');
  assert.equal(storageFailureKind({ name: 'InvalidStateError' }), 'blocked');
  assert.equal(storageFailureKind({ name: 'UnknownError' }), 'other');
  assert.equal(storageFailureKind(null), 'other');
});
