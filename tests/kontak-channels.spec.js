/*
 * THE CONTACT BOOKMARK — his five channels, and the size he ruled.
 * ============================================================================
 * The floating tab bottom-left in the editor, and the panel it opens.
 *
 * WHY THE HANDLES ARE PINNED VERBATIM, which is unusual for this suite: every
 * href here is a live link that carries FAUZAN'S NAME. A typo does not 404 —
 * social platforms hand a near-miss username to whoever actually owns it, so
 * the failure mode is a working link to a stranger's account, shipped on his
 * product, indistinguishable from correct until someone clicks it. That is not
 * a copy test; it is the same class as a wrong bank number.
 *
 * SOURCE OF TRUTH: engine/wiki/machine/public-identity.md. The handles are NOT
 * decided here and NOT decided in index.html — both read from that page, which
 * is the machine's one home for them. He is `okeojan` on TikTok and X,
 * `ojan.lubis` on Instagram and Threads. If this test and the wiki ever
 * disagree, the wiki wins and this file is the bug.
 *
 * ⚠️ AND IT PINS THE COUNT, deliberately. On 2026-08-23 the wiki page listed
 * THREE channels and he had to be asked for the other two — a list of three
 * reads identically whether three is the answer or three is what someone
 * happened to know. `toEqual` on the whole array (not `toContain` per link)
 * is what makes a silently-dropped channel fail here.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Verbatim, in order, from the wiki table.
const CHANNELS = [
  'https://tiktok.com/@okeojan',
  'https://instagram.com/ojan.lubis',
  'https://www.threads.com/@ojan.lubis',
  'https://x.com/okeojan',
  'https://ojanlubis.id',
];

async function openEditor(page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', path.join(__dirname, 'fixtures', 'sample-2pages.pdf'));
  await expectFirstPage(page);
}

test.describe('the contact bookmark', () => {
  test('the tab is small furniture, not a banner — 40x40, no wider than the zoom control', async ({ page }) => {
    // RULED BY FAUZAN 2026-08-23: "chip kontak saya di sini kegedean, kecilin
    // lagi". The labelled version was 44x131 — nearly 3x #zoom-ctl's footprint
    // on the opposite corner, and on desktop it overlapped the document. The
    // assertion is RELATIVE to #zoom-ctl rather than a bare pixel count,
    // because "the two floating controls weigh the same" is the actual rule;
    // a hardcoded 40 would go green if both were re-inflated together.
    await openEditor(page);
    const chip = await page.locator('#contact-tab-btn').boundingBox();
    const zoom = await page.locator('#zoom-ctl').boundingBox();
    expect(chip.width).toBeLessThanOrEqual(zoom.width);
    expect(chip.height).toBeLessThanOrEqual(zoom.width);

    // Icon-only, so the words have to survive somewhere a screen reader and a
    // desktop hover can both still reach. Losing the label was the cost of the
    // size; losing the NAME would be a different, worse change.
    await expect(page.locator('#contact-tab-btn')).toHaveAttribute('aria-label', 'Kontak saya');
    await expect(page.locator('#contact-tab-btn')).toHaveAttribute('title', 'Kontak saya');
    expect((await page.locator('#contact-tab-btn').innerText()).trim()).toBe('');
  });

  test('every channel he ships as himself is there, and no other', async ({ page }) => {
    await openEditor(page);
    await page.click('#contact-tab-btn');
    await expect(page.locator('#contact-tab-panel')).toBeVisible();

    const hrefs = await page.locator('#contact-tab-panel a').evaluateAll(
      (els) => els.map((e) => e.getAttribute('href')),
    );
    expect(hrefs).toEqual(CHANNELS);

    // Every one opens away from the editor, and carries rel=noopener — a
    // target=_blank without it hands the opened tab a live handle on this one.
    for (const a of await page.locator('#contact-tab-panel a').all()) {
      const href = await a.getAttribute('href');
      await expect(a, href).toHaveAttribute('target', '_blank');
      expect(await a.getAttribute('rel'), href).toContain('noopener');
    }
  });

  test('the panel is really closed when it is closed', async ({ page }) => {
    // visibility, not just opacity: an invisible-but-present panel still takes
    // taps and still reads aloud, which is the bug #support-card already had.
    await openEditor(page);
    const first = page.locator('#contact-tab-panel a').first();
    await expect(first).toBeHidden();
    await page.click('#contact-tab-btn');
    await expect(first).toBeVisible();
  });
});
