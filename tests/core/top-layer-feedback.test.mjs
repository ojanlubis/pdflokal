/*
 * TRANSIENT FEEDBACK MUST PAINT ABOVE AN OPEN MODAL SHEET.
 * ============================================================================
 * `dialog.showModal()` puts the sheet in the browser's TOP LAYER. Nothing in
 * the normal stacking order outranks the top layer, so `#toast` (z-index 40)
 * and `#v2-loading` (z-index 60) painted UNDER the Halaman sheet, the Unduh
 * sheet and every other dialog. The visible damage: Ekstrak looked dead, the
 * user tapped it again and got a second file; "Halaman dihapus", the merge
 * result and every refusal toast fired behind the sheet and were never seen.
 *
 * The only way above a modal dialog is to be in the top layer yourself and
 * enter it AFTER the dialog did. `popover="manual"` + `showPopover()` is that,
 * with no new dependency. These tests pin the three pieces that must hold
 * together: the helper that re-raises, the markup that makes the element a
 * popover, and the app.js call sites that raise it on every show.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const { raiseToTopLayer, dropFromTopLayer } = await import('../../js/v2/top-layer.js');

// A popover-capable element reduced to what the helper may touch. `open`
// mirrors :popover-open; `calls` is the order of top-layer operations.
function fakePopover(open = false) {
  const el = {
    open, calls: [],
    matches: (sel) => sel === ':popover-open' && el.open,
    showPopover() { el.calls.push('show'); el.open = true; },
    hidePopover() { el.calls.push('hide'); el.open = false; },
  };
  return el;
}

test('a closed element is shown into the top layer', () => {
  const el = fakePopover(false);
  assert.equal(raiseToTopLayer(el), true);
  assert.deepEqual(el.calls, ['show']);
});

test('an element already in the top layer is re-entered, so it lands ABOVE a dialog opened since', () => {
  // A manual popover that is already open keeps its OLD place in the top-layer
  // order. A sheet opened after the first toast sits above it unless the
  // toast leaves and re-enters.
  const el = fakePopover(true);
  assert.equal(raiseToTopLayer(el), true);
  assert.deepEqual(el.calls, ['hide', 'show']);
  assert.equal(el.open, true);
});

test('a browser without the Popover API degrades to the old stacking, never throws', () => {
  assert.equal(raiseToTopLayer({ matches: () => false }), false);
  assert.equal(raiseToTopLayer(null), false);
  assert.doesNotThrow(() => dropFromTopLayer(null));
  assert.doesNotThrow(() => dropFromTopLayer({ matches: () => false }));
});

test('a throwing showPopover (detached element) is swallowed', () => {
  const el = fakePopover(false);
  el.showPopover = () => { throw new Error('InvalidStateError'); };
  assert.equal(raiseToTopLayer(el), false);
});

test('dropFromTopLayer leaves only an open popover', () => {
  const open = fakePopover(true);
  dropFromTopLayer(open);
  assert.deepEqual(open.calls, ['hide']);
  const closed = fakePopover(false);
  dropFromTopLayer(closed);
  assert.deepEqual(closed.calls, []);
});

test('index.html: #toast and #v2-loading are manual popovers', () => {
  const html = read('index.html');
  assert.match(html, /<div id="toast"[^>]*\spopover="manual"/, '#toast must be popover="manual"');
  assert.match(html, /<div id="v2-loading"[^>]*\spopover="manual"/, '#v2-loading must be popover="manual"');
});

test('index.html: the popover UA defaults are reset so the toast keeps its place', () => {
  // [popover] ships inset:0 + margin:auto + a border, which would centre the
  // toast on the screen instead of 130px above the bottom edge.
  const css = read('index.html');
  const toast = css.match(/#toast \{([^}]*)\}/)[1];
  assert.match(toast, /margin:\s*0/);
  assert.match(toast, /top:\s*auto/);
  assert.match(toast, /right:\s*auto/);
  assert.match(toast, /border:\s*0|border:\s*none/);
  const loading = css.match(/#v2-loading \{([^}]*)\}/)[1];
  assert.match(loading, /margin:\s*0/);
  assert.match(loading, /width:\s*auto/);
  assert.match(loading, /height:\s*auto/);
});

test('app.js raises the toast and the processing overlay on EVERY show', () => {
  const src = read('js/v2/app.js');
  assert.match(src, /import \{[^}]*raiseToTopLayer[^}]*\} from '\.\/top-layer\.js'/);
  const toastFn = src.match(/function toast\(msg\) \{[\s\S]*?\n\}/)[0];
  assert.match(toastFn, /raiseToTopLayer\(toastEl\)/, 'toast() must re-raise per call');
  const showFn = src.match(/function showProcessing\(total\) \{[\s\S]*?\n\}/)[0];
  assert.match(showFn, /raiseToTopLayer\(loadingOverlay\)/);
  const hideFn = src.match(/function hideProcessing\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(hideFn, /dropFromTopLayer\(loadingOverlay\)/);
});
