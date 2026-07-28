/*
 * THE SCAN DEAD END — tapping Edit on a page with no text layer.
 * ============================================================================
 * Until 2026-07-28 this was a dead end: one toast, and nothing else. The rail
 * says ~6% of daily users were walking into it (29 events / 7 users on the 27th,
 * 51 / 6 on the 28th) and the number was RISING, because Edit is new.
 *
 * Tip-Ex and Teks already work on a scan — they cover the image and write over
 * it. What was missing was the affordance, not the capability. So the offer
 * EXPLAINS first and then offers; it never silently swaps the tool, which would
 * be the app doing something the user didn't ask for.
 *
 * ⚠️ WHAT THE EVENT DELIBERATELY DOES NOT MEASURE. `accepted` fires only from
 * this offer, and only when the tool genuinely ARMS. Someone arming Tip-Ex on a
 * scan WITHOUT having hit the wall is ordinary use — whiting out a signature
 * line, filling a scanned form — and counting them would import a population
 * that never wanted OCR, making the workaround look better than it is. The
 * wider "can they finish without OCR" number is a rail QUERY over the sequence
 * (ganti_no_text_layer -> tool_use), which per-event timestamps made answerable.
 * Events record what happened; joins answer why.
 *
 * Copy is asserted LOOSELY (a marker word, never a sentence): every string is a
 * TODO(copy) placeholder until Fauzan writes them, and pinning his words here
 * would mean this file has to change when he rules.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { armGanti } from './helpers/lines.js';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NASTY = (n) => path.join(__dirname, 'fixtures', 'nasty', n);
const SCAN = NASTY('mirip-scan.pdf'); // a page with no text layer

async function captureRail(page) {
  await page.addInitScript(() => {
    window.__rail = [];
    const push = (url, txt) => {
      try { window.__rail.push({ url: String(url), body: JSON.parse(txt) }); } catch { /* non-JSON */ }
    };
    navigator.sendBeacon = (url, blob) => {
      Promise.resolve(blob && blob.text ? blob.text() : blob).then((t) => push(url, t));
      return true;
    };
    const origFetch = window.fetch ? window.fetch.bind(window) : null;
    window.fetch = (url, opts) => {
      if (typeof url === 'string' && url.includes('/api/') && opts?.body) push(url, String(opts.body));
      return origFetch ? origFetch(url, opts) : Promise.resolve(new Response('{}'));
    };
  });
}

const railEvents = async (page) => {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  return page.evaluate(() => (window.__rail || [])
    .filter((b) => b.url.includes('/api/t'))
    .flatMap((b) => b.body.events || []));
};

const scanOffers = async (page) => (await railEvents(page)).filter((e) => e.event === 'scan_offer');

// WHY POLL rather than read once: the capture shim reads the beacon via
// blob.text(), which resolves a MICROTASK after sendBeacon returns — so a single
// read can see an empty list even though the flush fired. Three tests in this
// file passed or failed on that timing before this helper existed, and an
// assertion over an empty array passes for free, so a "no outcome" bug would
// have looked identical to a race.
async function outcomesAfter(page, n = 1) {
  await expect
    .poll(async () => (await scanOffers(page)).filter((e) => e.props.action !== 'shown').length)
    .toBe(n);
  return (await scanOffers(page)).filter((e) => e.props.action !== 'shown');
}

// Open a scan and tap the middle of page 1 with Ganti armed — the dead end.
async function hitTheWall(page) {
  await captureRail(page);
  await page.goto('/');
  await page.setInputFiles('#file-input', SCAN);
  await expectFirstPage(page);
  await armGanti(page);
  const box = await page.locator('.pv-page').first().boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('#scan-offer')).toBeVisible();
}

test.describe('scan dead end', () => {
  test('tapping Edit on a scan EXPLAINS and offers a route — it does not silently swap tools', async ({ page }) => {
    await hitTheWall(page);

    // It explains before it offers, and it must not promise OCR.
    const sheet = page.locator('#scan-offer');
    await expect(sheet).toContainText(/scan|gambar/i);
    await expect(sheet).not.toContainText(/OCR/i);

    // Nothing was armed on our behalf — the user has not asked for a tool yet.
    const tool = await page.evaluate(() => window.v2.getTool());
    expect(tool).toBe('ganti');

    await expect.poll(async () => (await scanOffers(page)).length).toBe(1);
    const offers = await scanOffers(page);
    expect(offers[0].props).toEqual({ action: 'shown', tool: 'none' });
  });

  for (const [btn, toolId, name] of [['#so-tipex', 'tipex', 'tipex'], ['#so-teks', 'teks', 'teks']]) {
    test(`taking the ${name} route ARMS the tool and reports accepted exactly once`, async ({ page }) => {
      await hitTheWall(page);
      await page.click(btn);
      await expect(page.locator('#scan-offer')).toBeHidden();

      // `accepted` means the tool actually armed, not that a button was pressed.
      expect(await page.evaluate(() => window.v2.getTool())).toBe(toolId);

      // EXACTLY ONE outcome. The close handler fires on button-driven closes too,
      // so without the resolved guard this would report accepted AND dismissed —
      // inflating both halves of the number the OCR decision rests on.
      const outcomes = await outcomesAfter(page, 1);
      expect(outcomes[0].props).toEqual({ action: 'accepted', tool: name });
    });
  }

  test('dismissing reports dismissed exactly once, and arms nothing', async ({ page }) => {
    await hitTheWall(page);
    await page.click('#so-dismiss');
    await expect(page.locator('#scan-offer')).toBeHidden();

    expect(await page.evaluate(() => window.v2.getTool())).toBe('ganti');
    const outcomes = await outcomesAfter(page, 1);
    expect(outcomes[0].props).toEqual({ action: 'dismissed', tool: 'none' });
  });

  test('Escape counts as a dismissal — closing without choosing is a rejection', async ({ page }) => {
    await hitTheWall(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('#scan-offer')).toBeHidden();

    const outcomes = await outcomesAfter(page, 1);
    expect(outcomes[0].props).toEqual({ action: 'dismissed', tool: 'none' });
  });

  test('CONTROL: a page WITH text shows no offer — the trigger is the missing text layer', async ({ page }) => {
    await captureRail(page);
    await page.goto('/');
    await page.setInputFiles('#file-input', NASTY('surat-word.pdf'));
    await expectFirstPage(page);
    await armGanti(page);
    const box = await page.locator('.pv-page').first().boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    await expect(page.locator('#scan-offer')).toBeHidden();
    expect(await scanOffers(page)).toEqual([]);
  });
});
