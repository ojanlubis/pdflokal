/*
 * A PHONE PHOTO MUST OPEN WHOLE, AND ZOOM-OUT MUST BE ABLE TO REACH THAT VIEW.
 *
 * An image page is as wide in points as it is in pixels (core/import.js), so a
 * 3024px photo is a 3024pt page. On a 412px phone the fit is 0.131, but the zoom
 * floor was a flat 0.3: the photo opened at 907px (over twice the screen) and the
 * zoom-out button clamped at the same 0.3, so it did nothing.
 *
 * The decision lives in core/zoom.js; app.js must ask it (it is DOM-at-import,
 * so the wiring is guarded by reading its source, like file-kind.test.mjs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { openingZoom, zoomFloor, clampZoom, ZOOM_MIN, ZOOM_MAX, ZOOM_STEP } =
  await import('../../js/core/zoom.js');
const APP = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'js', 'v2', 'app.js'), 'utf8');

const PHONE = { viewport: 412, desktop: false };

test('a 3024pt phone photo opens inside the phone screen', () => {
  const z = openingZoom({ ...PHONE, pageWidth: 3024 });
  assert.ok(z * 3024 <= 412 - 16 + 1e-6, `page renders ${Math.round(z * 3024)}px on a 412px screen`);
});

test('zoom-out from the opening view of a photo is not a dead tap, and reaches the whole page', () => {
  const widest = 3024;
  const floor = zoomFloor({ ...PHONE, widestPageWidth: widest });
  // Zoomed in on the photo, repeated zoom-out ends at the fit, not at 0.3.
  let z = 1;
  for (let i = 0; i < 12; i++) z = clampZoom(z - ZOOM_STEP, { floor, current: z });
  assert.ok(z * widest <= 412, `after zoom-out the page is ${Math.round(z * widest)}px wide`);
});

test('an A4 page keeps the usual floor and opening zoom', () => {
  assert.equal(zoomFloor({ ...PHONE, widestPageWidth: 595 }), ZOOM_MIN);
  assert.ok(Math.abs(openingZoom({ ...PHONE, pageWidth: 595 }) - (412 - 16) / 595) < 1e-9);
  let z = 1;
  for (let i = 0; i < 12; i++) z = clampZoom(z - ZOOM_STEP, { floor: ZOOM_MIN, current: z });
  assert.equal(z, ZOOM_MIN);
});

test('the floor is the widest page, not the opening page', () => {
  // Page 1 is an A4; a later page is a 3024pt photo. Open on page 1 as before,
  // but let the user zoom out far enough to see the photo whole.
  assert.ok(Math.abs(openingZoom({ ...PHONE, pageWidth: 595, widestPageWidth: 3024 }) - (412 - 16) / 595) < 1e-9);
  assert.ok(zoomFloor({ ...PHONE, widestPageWidth: 3024 }) < 0.14);
});

test('the floor never exceeds the usual 0.3, and never goes to zero or NaN', () => {
  assert.equal(zoomFloor({ ...PHONE, widestPageWidth: 100 }), ZOOM_MIN);
  assert.equal(zoomFloor({ ...PHONE, widestPageWidth: 0 }), ZOOM_MIN);
  assert.equal(zoomFloor({ ...PHONE, widestPageWidth: NaN }), ZOOM_MIN);
});

test('a view already below the floor is never lifted by zoom-out, and zoom-in is capped', () => {
  assert.equal(clampZoom(0.1 - ZOOM_STEP, { floor: 0.3, current: 0.1 }), 0.1);
  assert.equal(clampZoom(9, { floor: 0.3, current: 1 }), ZOOM_MAX);
});

test('desktop is unchanged: a wide photo on a laptop still floors at 0.3', () => {
  const d = { viewport: 1512, desktop: true };
  assert.equal(zoomFloor({ ...d, widestPageWidth: 3024 }), ZOOM_MIN);
  assert.ok(Math.abs(openingZoom({ ...d, pageWidth: 595 }) - (1512 - 96) / 595) < 1e-9);
});

test('app.js asks core/zoom.js for the range instead of carrying its own', () => {
  assert.match(APP, /from '\.\.\/core\/zoom\.js'/);
  assert.doesNotMatch(APP, /Math\.max\(0\.3,/, 'no inline 0.3 floor in openingZoom');
  assert.doesNotMatch(APP, /const ZOOM_MIN\b/, 'ZOOM_MIN must have one home');
  const zOut = APP.slice(APP.indexOf("on('z-out'"), APP.indexOf("on('z-out'") + 400);
  assert.match(zOut, /zoomFloor|currentZoomFloor/, 'the zoom-out button must use the document floor');
  const setZ = APP.slice(APP.indexOf('function setZoomAnchored'), APP.indexOf('function setZoomAnchored') + 300);
  assert.match(setZ, /clampZoom/, 'pinch/wheel/keys must clamp through the same floor');
});
