/*
 * PDFLokal — scripts/android-verify.mjs
 * ============================================================================
 * Drive REAL Android Chrome (emulator or USB device) with Playwright over CDP.
 * This is the tier-2 mobile verification loop: what Playwright's mobile
 * emulation can't catch (real compositor, GPU raster, Android keyboard),
 * this can — without needing the founder's phone.
 *
 * One-time setup (documented in docs/android-verification.md):
 *   1. Emulator running:  $ANDROID_HOME/emulator/emulator -avd pdflokal-test
 *   2. Local server:      npx serve -p 5050 .
 *   3. This script does the rest (adb reverse + CDP forward + drive).
 *
 * Usage:
 *   node scripts/android-verify.mjs [url-path] [screenshot-name]
 *   node scripts/android-verify.mjs /editor-v2.html v2-loaded
 */
import { chromium } from '@playwright/test';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADB = process.env.ADB || `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
const urlPath = process.argv[2] || '/editor-v2.html';
const shotName = process.argv[3] || 'android-verify';
const OUT = process.env.SHOT_DIR || '/tmp';

function adb(cmd) { return execSync(`"${ADB}" ${cmd}`, { encoding: 'utf8' }).trim(); }

// Plumb: app server into the device, DevTools socket out of it.
adb('reverse tcp:5050 tcp:5050');
adb('forward tcp:9222 localabstract:chrome_devtools_remote');
// Make sure Chrome is up (idempotent).
adb('shell am start -n com.android.chrome/com.google.android.apps.chrome.Main');
await new Promise((r) => setTimeout(r, 1500));

const browser = await chromium.connectOverCDP('http://localhost:9222');
const context = browser.contexts()[0];
const page = context.pages()[0] || (await context.newPage());

await page.goto(`http://localhost:5050${urlPath}`);
await page.waitForLoadState('networkidle');

// If this is editor v2, run the core flow: load fixture → wait for raster.
if (urlPath.includes('editor-v2')) {
  const fixture = path.join(__dirname, '..', 'tests', 'fixtures', 'sample-2pages.pdf');
  await page.setInputFiles('#file-input', fixture);
  await page.waitForSelector('.pv-page .pv-bg', { timeout: 15000 });
  console.log('pages:', await page.locator('.pv-page').count(),
    '| rasters:', await page.locator('.pv-bg').count());
}

const shot = `${OUT}/${shotName}.png`;
await page.screenshot({ path: shot });
console.log('screenshot:', shot);
console.log('UA:', await page.evaluate(() => navigator.userAgent));
await browser.close();
