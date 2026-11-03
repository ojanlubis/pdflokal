/*
 * core/ios.js — the one "is this an iPhone/iPad" rule. The Unduh sheet's
 * where-did-my-file-go toast (Files app on iOS, Download elsewhere) and the
 * install prompt both ask it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isIOS } from '../../js/core/ios.js';

test('iPhone, iPad and iPod user agents are iOS', () => {
  for (const ua of [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15',
  ]) assert.equal(isIOS({ userAgent: ua, platform: 'iPhone', maxTouchPoints: 5 }), true, ua);
});

test('an iPad asking for the desktop site (a Mac UA with a touch screen) is iOS', () => {
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
  assert.equal(isIOS({ userAgent: mac, platform: 'MacIntel', maxTouchPoints: 5 }), true);
  // A real Mac has no touch screen: not iOS, so it hears "folder Download".
  assert.equal(isIOS({ userAgent: mac, platform: 'MacIntel', maxTouchPoints: 0 }), false);
});

test('Android, Windows and an empty navigator are not iOS', () => {
  assert.equal(isIOS({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36', platform: 'Linux armv8l', maxTouchPoints: 5 }), false);
  assert.equal(isIOS({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120', platform: 'Win32', maxTouchPoints: 10 }), false);
  assert.equal(isIOS({}), false);
  assert.equal(isIOS(), false);
});
