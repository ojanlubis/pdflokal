/*
 * A REPLACE (Ganti / Buka Baru) MUST NOT WIPE THE OPEN DOCUMENT UNTIL THE NEW FILE HAS PAGES.
 * ============================================================================
 * Bug: a HEIC photo, a password PDF or a corrupt PDF passes the type and size
 * check (any image/* is "an image"; a PDF is a PDF by name), so the replace paths
 * called resetDoc() and only then found out, in the import loop, that the file
 * cannot be decoded. The user landed on the empty landing with the old work AND
 * its undo history gone. #178 closed only the type/size half.
 *
 * The fix stages the replace: loadFilesInner imports into a FRESH Doc and
 * resetDoc(staged) runs only when that Doc has pages. app.js is not loadable
 * headless, so this EXECUTES the real source text of the handlers, loadFiles,
 * loadFilesInner and resetDoc against stubs (the technique of
 * incoming-files.test.mjs): break the logic and it goes red. Browser half:
 * tests/drop-choice.spec.js ('a replace with a file that cannot be decoded') and
 * tests/file-flow-guards.spec.js (Buka Baru with a file that cannot open).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APP = fs.readFileSync(path.join(ROOT, 'js/v2/app.js'), 'utf8');
const { checkIncoming, replaceRefusal } = await import('../../js/core/incoming-files.js');
const { createDoc, createSource, createPage } = await import('../../js/core/model.js');
const { addSource, addPages } = await import('../../js/core/operations.js');
const { createHistory, record, undo, redo, isDirty, markClean, markChanged } = await import('../../js/core/history.js');
const { baseNameOf } = await import('../../js/core/file-kind.js');

function cut(anchor, open, close) {
  const start = APP.indexOf(anchor);
  assert.ok(start >= 0, `anchor not found: ${anchor}`);
  let i = open === '{' ? APP.slice(start).search(/\)\s*\{/) + start : start;
  i = APP.indexOf(open, i);
  let depth = 0;
  for (; i < APP.length; i++) {
    if (APP[i] === open) depth++;
    else if (APP[i] === close && --depth === 0) return APP.slice(start, i + 1) + (open === '(' ? ';' : '');
  }
  throw new Error(`unbalanced: ${anchor}`);
}

// Any identifier app.js owns that the test does not name is a no-op "anything"
// (callable, chainable, never thenable) so the real code can run end to end.
function anything() {
  const f = function () { return anything(); };
  return new Proxy(f, {
    get: (_t, k) => (k === 'then' || typeof k === 'symbol' ? undefined : anything()),
    apply: () => anything(),
  });
}

const handlers = {};
const SRC = `
  let loadingFiles = false; let pendingReplace = false;
  ${cut('function toastRefusal(', '{', '}')}
  ${cut('async function refuseReplace(', '{', '}')}
  ${cut('async function loadFiles(', '{', '}')}
  ${cut('async function loadFilesInner(', '{', '}')}
  ${cut('async function resetDoc(', '{', '}')}
  ${cut('function doDownload(', '{', '}')}
  ${cut("on(fileInput, 'change'", '(', ')')}
  ${cut("on('dc-replace', 'click'", '(', ')')}
  return { setPending(v) { pendingReplace = v; }, download: () => doDownload(), load: (f, o) => loadFiles(f, o) };`;

// A PDF-or-image fake File; `name` ending .heic / .locked.pdf is what the stub importers cannot decode.
const file = (name, type) => ({ name, type, size: 10, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
const undecodable = (name) => /\.heic$|\.locked\.pdf$|\.rusak\.pdf$/.test(name);

function world() {
  const toasts = [];
  const resets = [];
  const oldDoc = createDoc();
  const oldSource = addSource(oldDoc, createSource({ name: 'lama.pdf', bytes: new Uint8Array([9]), numPages: 2 }));
  addPages(oldDoc, [0, 1].map((n) => createPage({ source: oldSource, sourcePageNum: n, width: 100, height: 100, rotation: 0 })));
  const history = createHistory();
  record(history, oldDoc); // an edit the user would lose to a wipe

  const env = {
    doc: oldDoc,
    history,
    baseName: 'lama',
    rasterizer: null,
    zoom: 1,
    dropped: null,
    pendingIntent: null,
    checkIncoming,
    replaceRefusal,
    baseNameOf,
    createDoc,
    toast: (m) => toasts.push(m),
    sheetOpens: [],
    downloadSheet: { open: (...a) => env.sheetOpens.push(a) },
    tr: (k) => k,
    importPdf: async (d, { name }) => {
      if (undecodable(name)) throw new Error('password or corrupt');
      const src = addSource(d, createSource({ name, bytes: new Uint8Array([1]), numPages: 1 }));
      const p = createPage({ source: src, sourcePageNum: 0, width: 50, height: 50, rotation: 0 });
      addPages(d, [p]);
      return [p];
    },
    importImage: async (d, { name }) => {
      if (undecodable(name)) throw new Error('createImageBitmap: cannot decode');
      const src = addSource(d, createSource({ name, bytes: new Uint8Array([1]), numPages: 1 }));
      addPages(d, [createPage({ source: src, sourcePageNum: 0, width: 50, height: 50, rotation: 0, isFromImage: true })]);
      return [];
    },
    rebuildLoadError: async () => null,
    firstUnrebuildableSource: async () => null,
    probeTextLayer: async () => false,
    failureReason: () => 'unknown',
    failureCause: () => ({}),
    normalizePageWidths: () => {},
    markChanged,
    markClean,
    document: {
      body: { classList: { contains: () => false, add() {}, remove() {} } },
      getElementById: () => ({ open: false }),
    },
    window: { history: { state: { v2doc: true } } },
    console: { warn() {}, error() {}, log() {} },
    rebuildVerdicts: new Map(),
    pageManager: { invalidateThumbs() {} },
    textRuns: { destroy: async () => {} },
    ocrIndex: { invalidateAll() {} },
    editBake: { reset() {} },
    docFontLive: { reset() {} },
    slots: [],
    stage: { innerHTML: 'old stage' },
    emptyEl: { style: {} },
    on: (target, ev, fn) => { handlers[typeof target === 'string' ? target : 'fileInput'] = fn; },
    fileInput: { value: 'x', setAttribute() {} },
    DEFAULT_ACCEPT: '',
    takeDropped: () => env.dropped,
    resetEditFeedback: () => resets.push('feedback'),
    // The real resetDoc runs; this only lets the test see that it ran.
    openingZoom: () => 1,
    intentValue: () => 'none',
    tel: () => {},
    track: () => {},
  };
  const names = new Set(Object.keys(env));
  const scope = new Proxy(env, {
    has: (_t, k) => typeof k === 'string' && k !== '__scope' && (names.has(k) || !(k in globalThis)),
    get: (t, k) => (k === Symbol.unscopables ? undefined : (k in t ? t[k] : anything())),
    set: (t, k, v) => { t[k] = v; return true; },
  });
  const api = new Function('__scope', `with (__scope) { ${SRC} }`)(scope);
  return { env, api, toasts, oldDoc, history, handlers };
}

const PICKS = {
  heic: [file('foto.heic', 'image/heic')],
  lockedPdf: [file('rahasia.locked.pdf', 'application/pdf')],
  corruptPdf: [file('rusak.rusak.pdf', 'application/pdf')],
};

const sig = (history) => history.undoStack.length;

for (const [name, run] of [
  ['Ganti (dc-replace)', (w, files) => { w.env.dropped = files; return handlers['dc-replace'](); }],
  ['Buka Baru (picker change handler)', (w, files) => { w.api.setPending(true); return handlers.fileInput({ target: { files } }); }],
]) {
  for (const [kind, files] of Object.entries(PICKS)) {
    test(`${name}: a ${kind} that cannot be decoded leaves the open document and its undo history alone`, async () => {
      const w = world();
      const undoDepth = sig(w.history);
      assert.ok(undoDepth > 0, 'VACUITY GUARD: there is history to lose');
      await run(w, files);
      assert.equal(w.env.doc, w.oldDoc, 'the same Doc object is still the open document');
      assert.equal(w.env.doc.pages.length, 2, 'both original pages are still there');
      assert.equal(sig(w.history), undoDepth, 'undo history not emptied');
      assert.ok(isDirty(w.history), 'the edit is still unsaved work');
      assert.equal(w.env.baseName, 'lama', 'the export name did not become the failed file');
      assert.equal(w.env.stage.innerHTML, 'old stage', 'the stage was not emptied');
      assert.deepEqual(w.toasts, ['toast.openFailedOne'], 'the user is told, with the existing words');
    });
  }

  test(`${name}: a good file replaces the document and starts a clean history`, async () => {
    const w = world();
    await run(w, [file('baru.pdf', 'application/pdf')]);
    assert.notEqual(w.env.doc, w.oldDoc);
    assert.deepEqual(w.env.doc.pages.map((p) => p.sourceId === undefined), [false]);
    assert.equal(w.env.doc.pages.length, 1);
    assert.equal(sig(w.history), 0, 'a fresh document starts with an empty undo stack');
    assert.equal(w.env.baseName, 'baru');
    assert.equal(w.env.stage.innerHTML, '', 'the old stage was cleared at the commit');
  });

  test(`${name}: one undecodable file next to a good one is skipped and the good one replaces`, async () => {
    const w = world();
    await run(w, [file('foto.heic', 'image/heic'), file('baru.png', 'image/png')]);
    assert.notEqual(w.env.doc, w.oldDoc);
    assert.equal(w.env.doc.pages.length, 1);
    assert.equal(w.env.baseName, 'foto', 'named after the first file picked, as a normal open is');
    assert.deepEqual(w.toasts, ['toast.skipped']);
  });
}

test('after a refused replace, undo on the live document still reverses the edit made before it', async () => {
  const w = world();
  w.oldDoc.pages[0].rotation = 90; // the edit; world() recorded the pre-edit snapshot
  w.api.setPending(true);
  await handlers.fileInput({ target: { files: PICKS.heic } });
  // Through env, not oldDoc: it is whatever the APP now holds as its document and history.
  assert.equal(w.env.doc.pages[0].rotation, 90, 'the edit survived the refused replace');
  undo(w.env.history, w.env.doc);
  assert.equal(w.env.doc.pages[0].rotation, 0, 'undo restores the pre-edit state on the open document');
  redo(w.env.history, w.env.doc);
  assert.equal(w.env.doc.pages[0].rotation, 90, 'redo too');
});

// Unduh / Ctrl+S while a staged replace is loading: the OLD document is still
// live under the load, so the sheet would open on it, pre-build its bytes, and
// the commit would then swap doc and baseName under the open sheet.
for (const [name, run] of [
  ['Ganti', (w, files) => { w.env.dropped = files; return handlers['dc-replace'](); }],
  ['Buka Baru', (w, files) => { w.api.setPending(true); return handlers.fileInput({ target: { files } }); }],
]) {
  test(`Unduh does not open the sheet on the old document while ${name} is loading`, async () => {
    const w = world();
    let release;
    const gate = new Promise((r) => { release = r; });
    const realImport = w.env.importPdf;
    w.env.importPdf = async (...a) => { await gate; return realImport(...a); };

    w.api.download();
    assert.equal(w.env.sheetOpens.length, 1, 'KNOWN-POSITIVE: with no load running Unduh opens the sheet');
    w.env.sheetOpens.length = 0;

    const running = run(w, [file('baru.pdf', 'application/pdf')]);
    await new Promise((r) => setImmediate(r)); // let the load reach the gated import
    w.api.download();
    assert.equal(w.env.sheetOpens.length, 0, 'no sheet over the old document mid-replace');
    assert.deepEqual(w.toasts, ['toast.stillLoading'], 'told with the existing words');

    release();
    await running;
    w.env.sheetOpens.length = 0;
    w.api.download();
    assert.equal(w.env.sheetOpens.length, 1, 'once the load is over Unduh opens again, on the new document');
  });
}

test('Ctrl/Cmd+S and the Unduh button both go through doDownload', () => {
  assert.match(APP, /on\('btn-download', 'click', doDownload\)/);
  assert.match(cut("document.addEventListener('keydown', (e) => {\n  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 's')", '(', ')'), /\bdoDownload\(\)/);
});

test('appending a file that cannot be decoded still keeps the open document (the old behaviour)', async () => {
  const w = world();
  await w.api.load(PICKS.heic);
  assert.equal(w.env.doc, w.oldDoc);
  assert.equal(w.env.doc.pages.length, 2);
});

test('resetDoc is only awaited once, at the commit inside loadFilesInner', () => {
  assert.equal([...APP.matchAll(/await resetDoc\(/g)].length, 1);
  assert.match(cut('async function loadFilesInner(', '{', '}'), /await resetDoc\(/);
});
