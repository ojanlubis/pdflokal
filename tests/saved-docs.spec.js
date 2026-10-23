/*
 * "Simpan editan" in a real browser (specs/spec-simpan-editan.md; BUILT, NOT RELEASED).
 *
 * The pure rules are in tests/core/saved-docs.test.mjs and tests/core/doc-presence.test.mjs.
 * This file is what only a browser can prove: IndexedDB really holds the document across a
 * reload, a restored Ganti edit really is RE-BAKED by the viewport stream (nothing in the
 * saved data is a picture), two tabs really see each other through Web Locks, the Ojan card
 * really waits for the dialog, and the leave guard really stays down after a reopen.
 *
 * Every case that says "restored" compares the document MODEL against a snapshot taken
 * before the reload, deep-equal, with the ids unchanged: a spot check of one annotation
 * would pass a serializer that forgot a Ganti cover's replaceTargets.
 *
 * `serviceWorkers: 'block'`: the SW serves our modules after the first load and page.route
 * never sees requests the SW makes (copied from tests/maker-card.spec.js).
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { armGanti, tapLine } from './helpers/lines.js';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');
const REAL_UPDATES = fs.readFileSync(path.join(__dirname, '..', 'js', 'updates.js'), 'utf8');
const MAC = process.platform === 'darwin';

test.use({ serviceWorkers: 'block' });

// 1x1 transparent PNG: a signature that is real enough to be a data URL.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function addText(page, text) {
  await page.click('[data-tool="text"]'); // the button, not the 't' key: after a file pick the focus sits on the file input, which swallows shortcuts
  await page.click('.pv-page >> nth=0', { position: { x: 200, y: 260 } });
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await expect(page.locator('.pv-anno-text', { hasText: text })).toHaveCount(1);
}

// A document that has had every kind of edit the editor can make: authored text, a Ganti
// replacement, a Tip-Ex whiteout, a signature, a rotated page, a reordered page.
async function openAndEdit(page, { url = '/' } = {}) {
  await page.goto(url);
  await page.setInputFiles('#file-input', FIXTURE);
  await expectFirstPage(page);
  await addText(page, 'Halo');
  await armGanti(page);
  await tapLine(page, { str: 'Test Page 1' });
  await page.keyboard.type('Surat Baru');
  await page.keyboard.press('Enter');
  await expect(page.locator('.v2-text-edit')).toHaveCount(0);
  await page.evaluate(async (png) => {
    const { record } = await import('/js/core/history.js');
    const { createAnnotation } = await import('/js/core/model.js');
    const { addAnnotation, rotatePage, reorderPage } = await import('/js/core/operations.js');
    const doc = window.v2.getDoc();
    const h = window.v2.history;
    record(h, doc);
    addAnnotation(doc, doc.pages[1].id, createAnnotation('whiteout', { x: 20, y: 30, width: 80, height: 20, color: '#ffffff' }));
    addAnnotation(doc, doc.pages[1].id, createAnnotation('signature', { image: png, x: 50, y: 80, width: 60, height: 30 }));
    record(h, doc);
    rotatePage(doc, doc.pages[1].id, 90);
    record(h, doc);
    reorderPage(doc, doc.pages[0].id, 1);
  }, PNG);
}

// The document as the user would see it: structure only (never raster/edit caches).
const snapshot = (page) => page.evaluate(() => window.v2.getDoc().pages.map((p) => ({
  id: p.id, sourceId: p.sourceId, sourcePageNum: p.sourcePageNum, rotation: p.rotation, width: p.width, height: p.height,
  annotations: p.annotations.map((a) => ({ ...a })),
})));

// "Buka Baru" with a new file, resolved only when the NEW document is the live one. Waiting for
// the first page image is not enough: the old document's page is still on screen until the
// swap lands, and a spec that reads the store in that window races the autosave it is checking
// (found as a 1-in-8 flake in "Buka Baru autosaves the document it replaces first").
async function bukaBaru(page) {
  const before = await page.evaluate(() => window.v2.getDoc().pages[0]?.id ?? null);
  await page.click('#btn-file');
  await page.click('#fm-new');
  await page.setInputFiles('#file-input', FIXTURE);
  await expect.poll(() => page.evaluate((old) => {
    const first = window.v2.getDoc().pages[0];
    return !!first && first.id !== old;
  }, before)).toBe(true);
  await expectFirstPage(page);
}

const storeList = (page) => page.evaluate(() => window.v2.saved.store.list());

// Wait until the autosave has caught up with the live document (debounce + write).
async function autosaveCaughtUp(page) {
  await expect.poll(async () => page.evaluate(async () => {
    const own = window.v2.saved.session.ownIds()[0];
    const loaded = own ? await window.v2.saved.store.load(own) : null;
    if (!loaded) return 'no entry yet';
    const stored = JSON.stringify(loaded.state.pages.map((p) => [p.id, p.rotation, p.annotations.length]));
    const live = JSON.stringify(window.v2.getDoc().pages.map((p) => [p.id, p.rotation, p.annotations.length]));
    return stored === live ? 'caught up' : 'behind';
  }), { timeout: 8000 }).toBe('caught up');
}

async function menuSave(page) {
  await page.click('#btn-file');
  await page.click('#fm-save');
}

// The reopen ask is up on a landing that has an autosave: leave it for "see all", which is the way
// to the list from the homepage.
async function openListFromAsk(page) {
  await expect(page.locator('#saved-ask')).toBeVisible();
  await page.locator('#saved-ask .sv-link').click();
  await expect(page.locator('#saved-list')).toBeVisible();
}

test.describe('manual save', () => {
  test('save, reload, open from the list: text, whiteout, signature, order, rotation and the Ganti edit come back', async ({ page }) => {
    await openAndEdit(page);
    const before = await snapshot(page);
    expect(before.flatMap((p) => p.annotations).map((a) => a.type).sort(), 'the fixture edit set').toEqual(['signature', 'text', 'text', 'whiteout', 'whiteout']);
    const gantiCover = before.flatMap((p) => p.annotations).find((a) => a.replaceTargets);
    expect(gantiCover, 'a Ganti cover exists').toBeTruthy();

    await menuSave(page);
    await expect(page.locator('#toast')).toContainText('Tersimpan');
    expect((await storeList(page)).filter((e) => e.kind === 'manual')).toHaveLength(1);

    // Saving again on the same open document UPDATES that entry, never adds one.
    await menuSave(page);
    await expect(page.locator('#toast')).toContainText('diperbarui');
    expect((await storeList(page)).filter((e) => e.kind === 'manual')).toHaveLength(1);

    await autosaveCaughtUp(page);
    await page.reload();
    await openListFromAsk(page);
    const manualRow = page.locator('#saved-list .sv-row', { has: page.locator('.sv-open') }).first();
    await expect(manualRow).toBeVisible();
    await page.locator('#saved-list').getByText('Yang kamu simpan').waitFor();
    await page.locator('#saved-list .sv-open').first().click();
    await expectFirstPage(page);

    expect(await snapshot(page), 'the document model is identical, ids and all').toEqual(before);

    // The Ganti edit was RE-BAKED, not restored as a picture: the page that holds the cover
    // gets editApplied from the real provider once its raster is rendered.
    await expect.poll(() => page.evaluate((coverId) => {
      const p = window.v2.getDoc().pages.find((x) => x.annotations.some((a) => a.id === coverId));
      return !!p?.raster && p.editApplied instanceof Set && p.editApplied.has(coverId);
    }, gantiCover.id), { timeout: 15000 }).toBe(true);
  });

  test('a reopened manual entry is linked: Simpan editan updates it instead of adding another', async ({ page }) => {
    await openAndEdit(page);
    await menuSave(page);
    await expect.poll(async () => (await storeList(page)).filter((e) => e.kind === 'manual').length).toBe(1);
    await autosaveCaughtUp(page);
    await page.reload();
    await openListFromAsk(page);
    await page.locator('#saved-list .sv-open').first().click();
    await expectFirstPage(page);
    await addText(page, 'Tambahan');
    await menuSave(page);
    await expect(page.locator('#toast')).toContainText('diperbarui');
    const manual = (await storeList(page)).filter((e) => e.kind === 'manual');
    expect(manual).toHaveLength(1);
    const state = await page.evaluate((id) => window.v2.saved.store.load(id).then((l) => JSON.stringify(l.state)), manual[0].id);
    expect(state).toContain('Tambahan');
  });

  test('the list shows storage used and the plain browser-storage note, and marks the open document as open now', async ({ page }) => {
    await openAndEdit(page);
    await menuSave(page);
    await page.click('#btn-file');
    await page.click('#fm-saved');
    const list = page.locator('#saved-list');
    await expect(list).toBeVisible();
    await expect(list.locator('.sv-storage')).toContainText(/(KB|MB|GB)/);
    await expect(list.locator('.sv-note').first()).toContainText('penyimpanan browser');
    // Safari's 7-day note is for Safari only; this is Chromium.
    await expect(list.locator('.sv-safari')).toHaveCount(0);
    const del = list.locator('.sv-row', { hasText: 'sample-2pages' }).locator('.sv-del');
    // The open document's own entries are marked and not deletable from under it.
    await expect(list.locator('.sv-tag').first()).toContainText('Sedang dibuka');
    await expect(del).toHaveCount(0);
  });

  test('delete: first tap arms, second tap deletes the document whole, linked autosave included', async ({ page }) => {
    await openAndEdit(page);
    await menuSave(page);
    await expect.poll(async () => (await storeList(page)).filter((e) => e.kind === 'manual').length).toBe(1);
    await autosaveCaughtUp(page);
    // A second, different document, so the list has two rows.
    await bukaBaru(page);
    await addText(page, 'Dokumen B');
    await autosaveCaughtUp(page);
    await page.reload();
    await openListFromAsk(page);
    expect((await storeList(page)).length, 'manual A, autosave A, autosave B').toBe(3);
    await expect(page.locator('#saved-list .sv-row'), 'document A is one row, not two').toHaveCount(2);
    const del = page.locator('#saved-list .sv-row', { has: page.locator('.sv-del') }).first().locator('.sv-del');
    await del.click();
    await expect(del).toHaveText('Yakin hapus?');
    expect((await storeList(page)).length, 'one tap deletes nothing').toBe(3);
    await del.click();
    await expect.poll(async () => (await storeList(page)).length, { message: 'A went whole: its autosave too' }).toBe(1);
    await expect(page.locator('#saved-list .sv-row')).toHaveCount(1);
    // ...and nothing of it is left behind in the store.
    const left = await page.evaluate(() => new Promise((resolve) => {
      const open = indexedDB.open('pdflokal-saved');
      open.onsuccess = () => {
        const tx = open.result.transaction(['entries', 'states', 'blobs'], 'readonly');
        const n = {};
        for (const k of ['entries', 'states', 'blobs']) tx.objectStore(k).count().onsuccess = (e) => { n[k] = e.target.result; };
        tx.oncomplete = () => resolve(n);
      };
    }));
    expect(left).toEqual({ entries: 1, states: 1, blobs: 1 });
  });

  test('the list shows a saved document once: manual save + its own autosave is ONE row, under "Yang kamu simpan"', async ({ page }) => {
    await openAndEdit(page);
    await menuSave(page);
    await expect.poll(async () => (await storeList(page)).filter((e) => e.kind === 'manual').length).toBe(1);
    await autosaveCaughtUp(page);
    expect((await storeList(page)).map((e) => e.kind).sort(), 'both entries exist in the store').toEqual(['auto', 'manual']);
    await page.reload();
    await openListFromAsk(page);
    const list = page.locator('#saved-list');
    await expect(list.locator('.sv-row')).toHaveCount(1);
    await expect(list.locator('.sv-group')).toHaveText(['Yang kamu simpan']);
    await expect(list.locator('.sv-row')).toContainText('sample-2pages');
  });

  test('a manual entry opened later and edited: its autosave is the same document too', async ({ page }) => {
    await openAndEdit(page);
    await menuSave(page);
    await expect.poll(async () => (await storeList(page)).filter((e) => e.kind === 'manual').length).toBe(1);
    await autosaveCaughtUp(page);
    await page.reload();
    await openListFromAsk(page);
    await page.locator('#saved-list .sv-open').first().click();
    await expectFirstPage(page);
    await addText(page, 'Sesudah dibuka');
    await autosaveCaughtUp(page);
    // The slot now in use is a NEW autosave naming the manual entry.
    const autos = (await storeList(page)).filter((e) => e.kind === 'auto');
    expect(autos.some((e) => e.manualId)).toBe(true);
    await page.evaluate(() => window.v2.saved.ui.openList());
    await expect(page.locator('#saved-list .sv-row')).toHaveCount(1);
  });

  test.describe('Safari', () => {
    test.use({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15' });
    test('the 7-day note appears for Safari/WebKit, in the list and in the save toast', async ({ page }) => {
      await openAndEdit(page);
      await menuSave(page);
      await expect(page.locator('#toast')).toContainText('Safari');
      await page.click('#btn-file');
      await page.click('#fm-saved');
      await expect(page.locator('#saved-list .sv-safari')).toBeVisible();
    });
  });
});

test.describe('autosave and the reopen ask', () => {
  test('autosave, reload: the dialog asks, Buka lagi restores everything and continues the same slot', async ({ page }) => {
    await openAndEdit(page);
    const before = await snapshot(page);
    await autosaveCaughtUp(page);
    const slot = await page.evaluate(() => window.v2.saved.session.ownIds()[0]);

    await page.reload();
    const ask = page.locator('#saved-ask');
    await expect(ask).toBeVisible();
    await expect(ask).toContainText('sample-2pages');
    await ask.getByRole('button', { name: 'Buka lagi' }).click();
    await expectFirstPage(page);
    expect(await snapshot(page)).toEqual(before);
    expect(await page.evaluate(() => window.v2.saved.session.ownIds()), 'the reopened autosave keeps its own slot').toEqual([slot]);
    // Still one autosave entry: editing now continues the same slot.
    await addText(page, 'Lanjut');
    await autosaveCaughtUp(page);
    expect((await storeList(page)).filter((e) => e.kind === 'auto')).toHaveLength(1);
  });

  test('a file opened under the ask closes it: the editor is clickable, not behind the backdrop', async ({ page }) => {
    await openAndEdit(page);
    await autosaveCaughtUp(page);
    await page.reload();
    await expect(page.locator('#saved-ask')).toBeVisible();
    await page.setInputFiles('#file-input', FIXTURE);
    await expectFirstPage(page);
    await expect(page.locator('#saved-ask')).not.toBeVisible();
    // A modal left standing would swallow this click (v2-leave-guard.spec.js does exactly this after a reload).
    await page.keyboard.press('t');
    await page.click('.pv-page >> nth=0', { position: { x: 200, y: 200 }, timeout: 5000 });
    await expect(page.locator('.v2-text-edit')).toBeFocused();
  });

  test('"Nanti aja" closes it and leaves the entry in place', async ({ page }) => {
    await openAndEdit(page);
    await autosaveCaughtUp(page);
    await page.reload();
    await page.locator('#saved-ask').getByRole('button', { name: 'Nanti aja' }).click();
    await expect(page.locator('#saved-ask')).not.toBeVisible();
    expect((await storeList(page)).filter((e) => e.kind === 'auto')).toHaveLength(1);
    expect(await page.evaluate(() => document.body.classList.contains('is-empty'))).toBe(true);
  });

  test('"Nanti aja" is remembered: no nagging on the next landing, but a NEWER autosave asks again', async ({ page }) => {
    await openAndEdit(page);
    await autosaveCaughtUp(page);
    const slot = await page.evaluate(() => window.v2.saved.session.ownIds()[0]);
    await page.reload();
    await page.locator('#saved-ask').getByRole('button', { name: 'Nanti aja' }).click();
    await expect.poll(async () => (await storeList(page)).find((e) => e.id === slot)?.declinedAt).toBeTruthy();
    // Same entry, unchanged: left alone, on this and every later landing.
    for (let i = 0; i < 2; i++) {
      await page.reload();
      await page.waitForTimeout(1200);
      await expect(page.locator('#saved-ask')).not.toBeVisible();
    }
    // A DIFFERENT document autosaved after the decline: asks again.
    await page.setInputFiles('#file-input', FIXTURE);
    await expectFirstPage(page);
    await addText(page, 'Dokumen lain');
    await autosaveCaughtUp(page);
    await page.reload();
    await expect(page.locator('#saved-ask')).toBeVisible();
    await expect(page.locator('#saved-ask')).toContainText('sample-2pages');
    const newest = await page.evaluate(() => window.v2.saved.store.list().then((es) => es[0].id));
    expect(newest).not.toBe(slot);
  });

  test('"Nanti aja" then the SAME slot edited again: the ask comes back for it', async ({ page }) => {
    await openAndEdit(page);
    await autosaveCaughtUp(page);
    const slot = await page.evaluate(() => window.v2.saved.session.ownIds()[0]);
    await page.reload();
    await page.locator('#saved-ask').getByRole('button', { name: 'Nanti aja' }).click();
    await expect.poll(async () => (await storeList(page)).find((e) => e.id === slot)?.declinedAt).toBeTruthy();
    expect(await page.evaluate((id) => window.v2.saved.session.openEntry(id), slot)).toBe(true);
    await addText(page, 'Diubah setelah ditolak');
    await autosaveCaughtUp(page);
    expect((await storeList(page)).find((e) => e.id === slot).declinedAt, 'a later save clears the decline').toBeUndefined();
    await page.reload();
    await expect(page.locator('#saved-ask')).toBeVisible();
  });

  test('the dialog is skipped on a page that arrived with an intent', async ({ page }) => {
    await openAndEdit(page);
    await autosaveCaughtUp(page);
    await page.goto('/kompres-pdf');
    await page.waitForTimeout(1200);
    await expect(page.locator('#saved-ask')).not.toBeVisible();
  });

  test('a first-time visitor with nothing stored sees no dialog', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1200);
    await expect(page.locator('#saved-ask')).not.toBeVisible();
  });

  test('autosave keeps the last 5 documents and never evicts a manual save', async ({ page }) => {
    test.setTimeout(120_000);
    await openAndEdit(page);
    await menuSave(page);
    await expect.poll(async () => (await storeList(page)).filter((e) => e.kind === 'manual').length).toBe(1);
    const manualId = (await storeList(page)).find((e) => e.kind === 'manual').id;
    // Seven further documents, one autosave each (Buka Baru swaps the document and its slot).
    for (let i = 0; i < 7; i++) {
      await bukaBaru(page);
      await addText(page, `Dokumen ${i}`);
      await autosaveCaughtUp(page);
    }
    const entries = await storeList(page);
    expect(entries.filter((e) => e.kind === 'auto'), 'last five autosaves').toHaveLength(5);
    expect(entries.some((e) => e.id === manualId), 'the manual save survived').toBe(true);
    // The five kept are the five NEWEST, not any five.
    const autos = entries.filter((e) => e.kind === 'auto').sort((a, b) => b.updatedAt - a.updatedAt);
    const texts = await page.evaluate((ids) => Promise.all(ids.map((id) => window.v2.saved.store.load(id).then((l) => JSON.stringify(l.state))
      .then((s) => /Dokumen (\d)/.exec(s)?.[1]))), autos.map((e) => e.id));
    expect(texts).toEqual(['6', '5', '4', '3', '2']);
    // And the evicted ones left nothing behind: no orphan state or bytes.
    const orphans = await page.evaluate(() => new Promise((resolve) => {
      const open = indexedDB.open('pdflokal-saved');
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction(['entries', 'states', 'blobs'], 'readonly');
        const ids = new Set();
        const out = { states: 0, blobs: 0 };
        tx.objectStore('entries').getAllKeys().onsuccess = (e) => e.target.result.forEach((k) => ids.add(k));
        tx.objectStore('states').getAllKeys().onsuccess = (e) => { out.states = e.target.result.filter((k) => !ids.has(k)).length; };
        tx.objectStore('blobs').getAll().onsuccess = (e) => { out.blobs = e.target.result.filter((b) => !ids.has(b.entryId)).length; };
        tx.oncomplete = () => resolve(out);
      };
    }));
    expect(orphans).toEqual({ states: 0, blobs: 0 });
  });

  test('bytes are written once per slot: later autosaves rewrite state only', async ({ page }) => {
    await openAndEdit(page);
    await autosaveCaughtUp(page);
    const id = await page.evaluate(() => window.v2.saved.session.ownIds()[0]);
    // Count blob writes from now on.
    await page.evaluate(() => {
      window.__blobPuts = 0;
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function patched(...a) { if (this.name === 'blobs') window.__blobPuts += 1; return put.apply(this, a); };
    });
    await addText(page, 'Satu lagi');
    await autosaveCaughtUp(page);
    expect(await page.evaluate(() => window.__blobPuts)).toBe(0);
    const loaded = await page.evaluate((i) => window.v2.saved.store.load(i).then((l) => l.blobs.size), id);
    expect(loaded).toBe(1);
  });

  test('an entry that lost its bytes (deleted from another tab) is rewritten whole by the next autosave', async ({ page }) => {
    await openAndEdit(page);
    await autosaveCaughtUp(page);
    const id = await page.evaluate(() => window.v2.saved.session.ownIds()[0]);
    await page.evaluate((i) => window.v2.saved.store.remove(i), id);
    await addText(page, 'Setelah dihapus');
    await expect.poll(() => page.evaluate((i) => window.v2.saved.store.load(i).then((l) => (l ? l.blobs.size : -1)), id), { timeout: 8000 }).toBe(1);
    // ... and it can be opened.
    await page.reload();
    await page.locator('#saved-ask').getByRole('button', { name: 'Buka lagi' }).click();
    await expectFirstPage(page);
  });
});

test.describe('a reopened document and the leave guard', () => {
  test('not dirty and no undo history after a reopen; the first new edit arms the guard', async ({ page }) => {
    const seen = [];
    page.on('dialog', (d) => { seen.push(d.type()); d.accept(); });
    await openAndEdit(page);
    await autosaveCaughtUp(page);
    await page.reload();
    await page.locator('#saved-ask').getByRole('button', { name: 'Buka lagi' }).click();
    await expectFirstPage(page);

    const st = await page.evaluate(() => ({
      dirty: window.v2.history.current !== window.v2.history.cleanId,
      undo: window.v2.history.undoStack.length, redo: window.v2.history.redoStack.length,
      undoDisabled: document.getElementById('btn-undo').disabled,
    }));
    expect(st).toEqual({ dirty: false, undo: 0, redo: 0, undoDisabled: true });

    // The browser really is not asked: a reload right after the reopen raises no beforeunload.
    seen.length = 0;
    await page.mouse.click(5, 5); // user activation, no mutation
    await page.reload();
    expect(seen).toEqual([]);

    // Positive control (an assertion about silence needs a case where it speaks): the same page,
    // reopened and then edited, DOES ask.
    await page.locator('#saved-ask').getByRole('button', { name: 'Buka lagi' }).click();
    await expectFirstPage(page);
    await addText(page, 'Teks tambahan');
    seen.length = 0;
    await page.mouse.click(5, 5);
    await page.reload();
    expect(seen).toEqual(['beforeunload']);
  });
});

test.describe('opening a saved document over a dirty one', () => {
  test('the guard that was up for the old document comes down for the reopened one', async ({ page }) => {
    const seen = [];
    page.on('dialog', (d) => { seen.push(d.type()); d.accept(); });
    await openAndEdit(page);
    await menuSave(page);
    await expect.poll(async () => (await storeList(page)).filter((e) => e.kind === 'manual').length).toBe(1);
    // A second, edited, undownloaded document replaces it (Buka Baru).
    await bukaBaru(page);
    await addText(page, 'Dokumen kedua');
    const armed = () => page.evaluate(() => window.v2.history.current !== window.v2.history.cleanId);
    expect(await armed(), 'precondition: the second document is dirty, so the guard is up').toBe(true);

    await page.click('#btn-file');
    await page.click('#fm-saved');
    const manual = page.locator('#saved-list .sv-row', { has: page.locator('.sv-open') }).filter({ hasText: 'Yang kamu simpan' });
    await page.locator('#saved-list .sv-group', { hasText: 'Yang kamu simpan' }).waitFor();
    await page.locator('#saved-list .sv-list').first().locator('.sv-open').click();
    await expect(page.locator('#saved-list')).not.toBeVisible();
    void manual;

    expect(await armed()).toBe(false);
    expect(await page.evaluate(() => window.v2.history.undoStack.length)).toBe(0);
    // The document that was replaced was not lost: its autosave holds it.
    await expect.poll(async () => (await storeList(page)).filter((e) => e.kind === 'auto').length, { timeout: 8000 }).toBeGreaterThan(0);
    const texts = await page.evaluate(() => window.v2.saved.store.list().then((es) => Promise.all(es.filter((e) => e.kind === 'auto')
      .map((e) => window.v2.saved.store.load(e.id).then((l) => JSON.stringify(l.state))))));
    expect(texts.some((t) => t.includes('Dokumen kedua'))).toBe(true);

    seen.length = 0;
    await page.mouse.click(5, 5);
    await page.reload();
    expect(seen).toEqual([]);
  });
});

test.describe('the Ojan card waits for the reopen dialog', () => {
  const approved = (src) => src.replaceAll('approved: false', 'approved: true');
  async function mock(page) {
    await page.route('**/api/visitors', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ visitors: 184 }) }));
    await page.route('**/js/updates.js', (r) => r.fulfill({ contentType: 'text/javascript', body: approved(REAL_UPDATES) }));
  }

  test('with an autosave, the card stays hidden while the dialog is open and shows after it closes', async ({ page }) => {
    await mock(page);
    await openAndEdit(page);
    await autosaveCaughtUp(page);
    await page.reload();
    const ask = page.locator('#saved-ask');
    await expect(ask).toBeVisible();
    // The card's own delay is 900 ms; wait well past it. Both never show together.
    await page.waitForTimeout(2500);
    await expect(ask).toBeVisible();
    await expect(page.locator('#maker-card')).toBeHidden();
    await ask.getByRole('button', { name: 'Nanti aja' }).click();
    await expect(page.locator('#maker-card')).toBeVisible();
  });

  test('"Lihat semua" keeps the card waiting until the list is closed as well', async ({ page }) => {
    await mock(page);
    await openAndEdit(page);
    await autosaveCaughtUp(page);
    await page.reload();
    await page.locator('#saved-ask .sv-link').click();
    await expect(page.locator('#saved-list')).toBeVisible();
    await page.waitForTimeout(2000);
    await expect(page.locator('#maker-card')).toBeHidden();
    await page.locator('#saved-list .sv-x').click();
    await expect(page.locator('#maker-card')).toBeVisible();
  });

  test('the reopen button is the accent button, legible (a screenshot caught it white on white once)', async ({ page }) => {
    await openAndEdit(page);
    await autosaveCaughtUp(page);
    await page.reload();
    const open = page.locator('#saved-ask').getByRole('button', { name: 'Buka lagi' });
    await expect(open).toBeVisible();
    await expect(open).toHaveCSS('background-color', 'rgb(220, 38, 38)');
    await expect(open).toHaveCSS('color', 'rgb(255, 255, 255)');
  });

  test('the dialog and the card are never visible in the same frame', async ({ page }) => {
    await mock(page);
    await openAndEdit(page);
    await autosaveCaughtUp(page);
    await page.addInitScript(() => {
      window.__both = 0;
      const tick = () => {
        const dlg = document.getElementById('saved-ask');
        const card = document.getElementById('maker-card');
        if (dlg?.open && card && !card.hidden) window.__both += 1;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.reload();
    await expect(page.locator('#saved-ask')).toBeVisible();
    await page.waitForTimeout(1500);
    await page.locator('#saved-ask').getByRole('button', { name: 'Nanti aja' }).click();
    await expect(page.locator('#maker-card')).toBeVisible();
    expect(await page.evaluate(() => window.__both)).toBe(0);
  });

  test('without an autosave the card shows on its usual schedule', async ({ page }) => {
    await mock(page);
    await page.goto('/');
    await expect(page.locator('#maker-card')).toBeVisible();
    await expect(page.locator('#saved-ask')).not.toBeVisible();
  });

  test('nothing but the card ever sits in the bottom-right corner while the dialog is up', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openAndEdit(page);
    await autosaveCaughtUp(page);
    await page.reload();
    await expect(page.locator('#saved-ask')).toBeVisible();
    const box = await page.locator('#saved-ask .sheet').boundingBox();
    // The sheet is centred on the overlay, nowhere near the corner the Ojan card owns.
    expect(box.x + box.width).toBeLessThan(1280 - 200);
    expect(box.y + box.height).toBeLessThan(800 - 150);
  });
});

test.describe('two tabs', () => {
  test('the second tab marks the open document as open elsewhere, skips the dialog, and opens a COPY', async ({ context, page }) => {
    await openAndEdit(page);
    await autosaveCaughtUp(page);
    const slotA = await page.evaluate(() => window.v2.saved.session.ownIds()[0]);

    const tab2 = await context.newPage();
    await tab2.goto('/');
    // The latest autosave is open in tab 1: no dialog here.
    await tab2.waitForTimeout(1200);
    await expect(tab2.locator('#saved-ask')).not.toBeVisible();

    await tab2.evaluate(() => window.v2.saved.ui.openList());
    const row = tab2.locator('#saved-list .sv-row', { hasText: 'sample-2pages' }).first();
    await expect(row.locator('.sv-tag')).toContainText('Terbuka di tab lain');
    await expect(row.locator('.sv-del'), 'an entry another tab holds is not deletable').toHaveCount(0);
    await expect(row.locator('.sv-open')).toHaveText('Buka salinan');

    await row.locator('.sv-open').click();
    await expectFirstPage(tab2);
    const ids = await tab2.evaluate(() => window.v2.saved.session.ownIds());
    expect(ids, 'a copy has a slot of its own').toHaveLength(1);
    expect(ids[0]).not.toBe(slotA);
    // Same content in both tabs, no live sync, nothing written yet by the copy.
    expect(await snapshot(tab2)).toEqual(await snapshot(page));
    expect((await storeList(tab2)).filter((e) => e.kind === 'auto')).toHaveLength(1);

    // Editing the copy creates ITS OWN autosave slot and never touches tab 1's.
    const beforeA = await page.evaluate((id) => window.v2.saved.store.load(id).then((l) => JSON.stringify(l.state)), slotA);
    await addText(tab2, 'Hanya di tab dua');
    await autosaveCaughtUp(tab2);
    expect((await storeList(tab2)).filter((e) => e.kind === 'auto')).toHaveLength(2);
    expect(await page.evaluate((id) => window.v2.saved.store.load(id).then((l) => JSON.stringify(l.state)), slotA)).toBe(beforeA);
  });

  test('closing the first tab frees its entries: the dialog comes back for a new tab', async ({ context, page }) => {
    await openAndEdit(page);
    await autosaveCaughtUp(page);
    const tab2 = await context.newPage();
    await tab2.goto('/');
    await tab2.waitForTimeout(800);
    await expect(tab2.locator('#saved-ask')).not.toBeVisible();
    await page.close();
    // The browser drops a closed tab's locks; the next landing offers the autosave again.
    await expect.poll(async () => {
      await tab2.reload();
      await tab2.waitForTimeout(700);
      return tab2.locator('#saved-ask').isVisible();
    }, { timeout: 15000 }).toBe(true);
  });

  test('a stale-lock race: two tabs opening the same entry at once cannot both own it', async ({ context, page }) => {
    await openAndEdit(page);
    await autosaveCaughtUp(page);
    await page.reload();
    await page.locator('#saved-ask').getByRole('button', { name: 'Nanti aja' }).click();
    const id = (await storeList(page)).find((e) => e.kind === 'auto').id;
    const tab2 = await context.newPage();
    await tab2.goto('/'); // (declined above, so no ask here either)
    const results = await Promise.all([page, tab2].map((p) => p.evaluate((i) => window.v2.saved.session.openEntry(i), id)));
    expect(results).toEqual([true, true]); // both end up with a document...
    const owners = await Promise.all([page, tab2].map((p) => p.evaluate((i) => window.v2.saved.session.ownIds().includes(i), id)));
    expect(owners.filter(Boolean), '...but exactly one OWNS the slot').toHaveLength(1);
  });
});

test.describe('storage that fails never breaks editing', () => {
  const toastLog = (page) => page.addInitScript(() => {
    window.__toasts = [];
    document.addEventListener('DOMContentLoaded', () => {
      new MutationObserver(() => { const t = document.getElementById('toast').textContent; if (t) window.__toasts.push(t); })
        .observe(document.getElementById('toast'), { childList: true, characterData: true, subtree: true });
    });
  });

  test('IndexedDB blocked (private mode): the autosave says so ONCE, switches off, and editing carries on', async ({ page }) => {
    await toastLog(page);
    await page.addInitScript(() => { Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true }); });
    await page.goto('/');
    await page.setInputFiles('#file-input', FIXTURE);
    await expectFirstPage(page);
    await addText(page, 'Satu');
    await expect.poll(() => page.evaluate(() => window.__toasts.filter((t) => t.includes('nggak mengizinkan')).length), { timeout: 8000 }).toBe(1);
    await addText(page, 'Dua');
    await addText(page, 'Tiga');
    await page.waitForTimeout(2500);
    expect(await page.evaluate(() => window.__toasts.filter((t) => t.includes('nggak mengizinkan')).length), 'told once, not per edit').toBe(1);
    expect(await page.evaluate(() => window.v2.saved.session.disabled)).toBe(true);
    expect(await page.evaluate(() => window.v2.getDoc().pages[0].annotations.filter((a) => a.type === 'text').length), 'editing was never touched').toBe(3);
  });

  test('quota exceeded: one toast, no thrown errors, the manual save reports its own failure', async ({ page }) => {
    await toastLog(page);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await page.setInputFiles('#file-input', FIXTURE);
    await expectFirstPage(page);
    await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function patched(...a) {
        if (this.name === 'states' || this.name === 'entries') throw new DOMException('full', 'QuotaExceededError');
        return put.apply(this, a);
      };
    });
    await addText(page, 'Satu');
    await expect.poll(() => page.evaluate(() => window.__toasts.filter((t) => t.includes('penuh')).length), { timeout: 8000 }).toBe(1);
    await addText(page, 'Dua');
    await page.waitForTimeout(2500);
    expect(await page.evaluate(() => window.__toasts.filter((t) => t.includes('penuh')).length)).toBe(1);
    // A manual save always answers, because the user is waiting on it.
    await menuSave(page);
    await expect.poll(() => page.evaluate(() => window.__toasts.filter((t) => t.includes('penuh')).length)).toBe(2);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => window.v2.getDoc().pages[0].annotations.length)).toBe(2);
  });

  test('a damaged entry is refused with a message and leaves the editor usable', async ({ page }) => {
    await openAndEdit(page);
    await autosaveCaughtUp(page);
    const id = await page.evaluate(() => window.v2.saved.session.ownIds()[0]);
    // Corrupt the stored state: a page that names a source that is not there.
    await page.evaluate((i) => new Promise((resolve) => {
      const open = indexedDB.open('pdflokal-saved');
      open.onsuccess = () => {
        const tx = open.result.transaction('states', 'readwrite');
        const store = tx.objectStore('states');
        store.get(i).onsuccess = (e) => { const row = e.target.result; row.state.pages[0].sourceId = 'src_nope'; store.put(row); };
        tx.oncomplete = () => resolve();
      };
    }), id);
    await page.reload();
    await page.locator('#saved-ask').getByRole('button', { name: 'Buka lagi' }).click();
    await expect(page.locator('#toast')).toContainText('nggak bisa dibuka');
    // The ask stays so they can try the other route; the page is still the landing.
    expect(await page.evaluate(() => document.body.classList.contains('is-empty'))).toBe(true);
    await page.locator('#saved-ask').getByRole('button', { name: 'Nanti aja' }).click();
    await page.setInputFiles('#file-input', FIXTURE);
    await expectFirstPage(page);
  });
});

test.describe('Buka Baru and Ctrl+Z around the saved document', () => {
  test('Buka Baru autosaves the document it replaces first', async ({ page }) => {
    await openAndEdit(page);
    await bukaBaru(page);
    // The first document's last state is stored without waiting for the debounce.
    const autos = (await storeList(page)).filter((e) => e.kind === 'auto');
    expect(autos).toHaveLength(1);
    const stored = await page.evaluate((id) => window.v2.saved.store.load(id).then((l) => JSON.stringify(l.state)), autos[0].id);
    expect(stored).toContain('Surat Baru');
    expect(stored).toContain('Halo');
  });

  test('undo is a change too: the autosave follows it', async ({ page }) => {
    await openAndEdit(page);
    await autosaveCaughtUp(page);
    await page.keyboard.press(MAC ? 'Meta+z' : 'Control+z');
    await autosaveCaughtUp(page);
  });
});
