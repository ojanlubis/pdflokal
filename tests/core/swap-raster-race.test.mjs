/*
 * OVERLAPPING RASTER SWAPS: THE LAST ONE ISSUED IS THE ONE ON SCREEN.
 * ============================================================================
 * swapPageRaster used to decide what to remove BEFORE awaiting the new image's
 * decode. Two swaps on one page (a sharpen and a re-bake) both captured the same
 * old <img>, both inserted theirs, and whichever decoded FIRST ended up on top;
 * a release (page scrolled away) during the decode left the new image under a
 * placeholder nothing removed. Driven with a minimal stub DOM whose decode()
 * resolution order the test controls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---- a DOM just big enough for page-view.js's streaming helpers -------------
function el(tag) {
  const node = {
    tag, className: '', style: {}, dataset: {}, children: [], parent: null, src: '',
    insertBefore(child) { child.parent = node; node.children.unshift(child); return child; },
    remove() { if (node.parent) node.parent.children = node.parent.children.filter((c) => c !== node); node.parent = null; },
    querySelector(sel) { return node.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) {
      const classes = sel.split(',').map((s) => s.trim().replace(/^\./, ''));
      return node.children.filter((c) => classes.includes(c.className));
    },
  };
  return node;
}
const decodes = [];
globalThis.document = {
  createElement(tag) {
    const n = el(tag);
    if (tag === 'img') n.decode = () => new Promise((r) => decodes.push({ img: n, go: r }));
    return n;
  },
};
globalThis.requestAnimationFrame = (f) => f();

const { swapPageRaster, clearPageRaster } = await import('../../js/render/page-view.js');
const settle = () => new Promise((r) => setTimeout(r, 0));
const layers = (view) => view.children.map((c) => `${c.className}:${c.src}`);

function viewWithRaster(src) {
  const view = el('div');
  const old = el('img'); old.className = 'pv-bg'; old.src = src;
  view.insertBefore(old);
  return view;
}

test('1. known-positive: a single swap replaces the old image', async () => {
  decodes.length = 0;
  const view = viewWithRaster('old');
  const p = swapPageRaster(view, { dataUrl: 'new' });
  decodes[0].go(); await p;
  assert.deepEqual(layers(view), ['pv-bg:new']);
});

test('2. two overlapping swaps: the LATER one wins even when the earlier decodes last', async () => {
  decodes.length = 0;
  const view = viewWithRaster('old');
  const a = swapPageRaster(view, { dataUrl: 'A' });
  const b = swapPageRaster(view, { dataUrl: 'B' });
  decodes[1].go(); await settle(); // B decodes first
  decodes[0].go(); await settle(); // the older A lands afterwards
  await Promise.all([a, b]);
  assert.deepEqual(layers(view), ['pv-bg:B'], 'a stale raster is on screen, or an extra <img> leaked');
});

test('3. a release during the decode wins: placeholder only, no orphan image under it', async () => {
  decodes.length = 0;
  const view = viewWithRaster('old');
  view.dataset.phLabel = 'Hal 1';
  const p = swapPageRaster(view, { dataUrl: 'new' });
  clearPageRaster(view);
  decodes[0].go(); await p;
  assert.deepEqual(layers(view), ['pv-ph:'], 'the swap re-attached an image to a released page');
});
