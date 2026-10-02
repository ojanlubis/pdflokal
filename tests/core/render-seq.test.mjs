/*
 * renderSeq — the stale-guard in core/import.js createPageRasterizer.rasterize.
 * ============================================================================
 * THE CLAIM: for ONE page, the last-ISSUED rasterize wins, not the
 * last-RESOLVED. Without it a plain-page render issued before an edit committed
 * can resolve after the edited page's render and overwrite page.raster: the edit
 * visually reverts (the founder's intermittent "doubling", 2026-07-20).
 *
 * WHY THIS IS A HEADLESS TEST AND NOT A BROWSER ONE. tests/zoom-sharpen.spec.js
 * tried to make the overlap happen with real pdf.js renders and measured it
 * never does (issued 10, applied 10, superseded 0 even at 20x CPU throttling):
 * `sharpenIntent` prevents the overlap upstream, so the guard is a backstop the
 * browser path cannot reach on demand. A timing test was removed for that
 * reason. This one has NO TIMING IN IT: `renderToCanvas` is injected, each call
 * returns a promise this file resolves BY HAND, in the order it chooses. The
 * ordering is the test's input, never the machine's.
 *
 * PROVEN RED: delete the `if (renderSeq.get(page.id) !== seq) return
 * page.raster;` line in js/core/import.js and the three ordering tests fail.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPageRasterizer } from '../../js/core/import.js';
import { createDoc } from '../../js/core/model.js';

// A render whose resolution the test owns. `calls` records issue order.
function controlledRender() {
  const calls = [];
  const render = (page, scale) => {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    const call = { page, scale, resolve: (label) => resolve({
      width: 10, height: 20, toDataURL: () => `data:${label}`,
    }) };
    calls.push(call);
    return promise;
  };
  return { render, calls };
}

const makePage = (id) => ({ id, sourceId: 's', sourcePageNum: 0, width: 10, height: 20, annotations: [], raster: null });
const rig = () => {
  const { render, calls } = controlledRender();
  const r = createPageRasterizer(createDoc(), { renderToCanvas: render });
  return { r, calls };
};
// Let queued microtasks (the awaits inside rasterize) run, with no timers.
const settle = () => new Promise((res) => setImmediate(res));

test('control: a lone rasterize applies its result', async () => {
  const { r, calls } = rig();
  const page = makePage('p1');
  const pending = r.rasterize(page, { scale: 2 });
  calls[0].resolve('only');
  const out = await pending;
  assert.equal(page.raster.dataUrl, 'data:only');
  assert.equal(out, page.raster);
  assert.equal(page.raster.scale, 2);
});

test('older render resolving AFTER the newer one is discarded (the doubling bug)', async () => {
  const { r, calls } = rig();
  const page = makePage('p1');
  const plain = r.rasterize(page, { scale: 2 });   // issued first: the stale one
  const edited = r.rasterize(page, { scale: 2 });  // issued second: must win
  calls[1].resolve('edited');
  await edited;
  assert.equal(page.raster.dataUrl, 'data:edited');
  calls[0].resolve('plain');                        // resolves LAST
  const lateResult = await plain;
  assert.equal(page.raster.dataUrl, 'data:edited', 'the stale plain render must not overwrite the edit');
  assert.equal(lateResult.dataUrl, 'data:edited', 'the stale caller is handed the current raster, not its own');
});

test('older render resolving BEFORE the newer one still never lands', async () => {
  const { r, calls } = rig();
  const page = makePage('p1');
  const plain = r.rasterize(page, { scale: 2 });
  const edited = r.rasterize(page, { scale: 2 });
  calls[0].resolve('plain');                        // resolves first, but was superseded at issue
  await plain;
  await settle();
  assert.equal(page.raster, null, 'a superseded render installs nothing, even when nothing newer has landed yet');
  calls[1].resolve('edited');
  await edited;
  assert.equal(page.raster.dataUrl, 'data:edited');
});

test('last ISSUED wins across three overlapping renders in scrambled order', async () => {
  const { r, calls } = rig();
  const page = makePage('p1');
  const a = r.rasterize(page, { scale: 1 });
  const b = r.rasterize(page, { scale: 2 });
  const c = r.rasterize(page, { scale: 3 });
  calls[1].resolve('b');
  calls[2].resolve('c');
  calls[0].resolve('a');
  await Promise.all([a, b, c]);
  assert.equal(page.raster.dataUrl, 'data:c');
  assert.equal(page.raster.scale, 3);
});

test('different pages never supersede each other', async () => {
  const { r, calls } = rig();
  const p1 = makePage('p1');
  const p2 = makePage('p2');
  const a = r.rasterize(p1, { scale: 2 });
  const b = r.rasterize(p2, { scale: 2 });
  calls[1].resolve('two');
  calls[0].resolve('one');
  await Promise.all([a, b]);
  assert.equal(p1.raster.dataUrl, 'data:one');
  assert.equal(p2.raster.dataUrl, 'data:two');
});

test('a thumb or raw canvas issued later does NOT take the guard from rasterize', async () => {
  // rasterizeThumb / renderCanvas install nothing, so they must not discard a
  // rasterize that is still in flight (core/import.js says so in a comment;
  // this is the only thing holding the comment to the code).
  const { r, calls } = rig();
  const page = makePage('p1');
  const main = r.rasterize(page, { scale: 2 });
  const thumb = r.rasterizeThumb(page, { width: 5 });
  const raw = r.renderCanvas(page, { scale: 4 });
  calls[1].resolve('thumb');
  calls[2].resolve('raw');
  calls[0].resolve('main');
  await Promise.all([main, thumb, raw]);
  assert.equal(page.raster.dataUrl, 'data:main');
});
