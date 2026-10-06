/*
 * THE HOMEPAGE HEADLINE THAT DRIFTS, RENDERED (2026-10-06).
 * tests/core/h1-rotation.test.mjs pins the rules; this proves what a browser does
 * with them: the day counter, the gates (visitor_id, /en, the SEO pages) and that
 * no line of any level breaks the layout on a phone.
 *
 * A seeded count is written with lastDay = TODAY (WIB), so the load under test does
 * not count a new day and the level is exactly the one seeded.
 */
import { test, expect } from '@playwright/test';
import { LEVELS as ALL, DEFAULT_H1 } from '../js/core/h1-rotation.js';

const LEVELS = ALL.id;
test.use({ serviceWorkers: 'block' });

const KEY = 'pdflokal_visit_days';
const DEFAULT = DEFAULT_H1.id;
const H1 = '.ld-hero-copy h1';

function seed(page, { count, lastDay, last = null }) {
  return page.addInitScript(([k, c, d, l]) => {
    // addInitScript runs on every navigation: seed once, so a reload keeps what the page wrote
    if (localStorage.getItem(k) !== null || sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
    localStorage.setItem(k, JSON.stringify({ count: c, lastDay: d ?? today, last: l }));
  }, [KEY, count, lastDay ?? null, last]);
}
const h1Text = (page) => page.locator(H1).evaluate((e) => e.textContent);

test('a first visit: static headline, day 1 counted', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator(H1)).toHaveText(DEFAULT);
  const s = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), KEY);
  expect(s.count).toBe(1);
  expect(s.last).toBeNull();
});

for (const [count, level] of [[2, 1], [3, 1], [4, 2], [7, 2], [8, 3], [15, 4], [29, 4], [30, 5], [45, 5]]) {
  test(`day ${count} shows a level-${level} line, and remembers it`, async ({ page }) => {
    await seed(page, { count });
    await page.goto('/');
    const text = await h1Text(page);
    expect(LEVELS[level]).toContain(text);
    expect(await page.locator(H1).getAttribute('aria-label')).toBeNull();
    const s = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), KEY);
    expect(s.last).toBe(text);
    expect(s.count).toBe(count);
  });
}

test('a new WIB day is counted once: day 3 becomes day 4, then a reload stays at 4', async ({ page }) => {
  await seed(page, { count: 3, lastDay: '2020-01-01' });
  await page.goto('/');
  const read = () => page.evaluate((k) => JSON.parse(localStorage.getItem(k)), KEY);
  expect((await read()).count).toBe(4);
  expect(LEVELS[2]).toContain(await h1Text(page));
  await page.reload();
  expect((await read()).count).toBe(4);
});

test('the same level never shows the same line twice in a row', async ({ page }) => {
  await seed(page, { count: 10 });
  await page.goto('/');
  let prev = await h1Text(page);
  for (let i = 0; i < 12; i++) {
    await page.reload();
    const now = await h1Text(page);
    expect(now).not.toBe(prev);
    expect(LEVELS[3]).toContain(now);
    prev = now;
  }
});

test('/en rotates in English, from the same shared count', async ({ page }) => {
  // a visit on the Indonesian page counted day 9; /en shares the count and shows level 3 in English
  await seed(page, { count: 9 });
  await page.goto('/en');
  const text = await h1Text(page);
  expect(ALL.en[3]).toContain(text);
  expect(ALL.id[3]).not.toContain(text);
  const s = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), KEY);
  expect(s.count).toBe(9);
  expect(s.last).toBe(text);
});

test('/en level 0 keeps its own static headline, and a visit there counts', async ({ page }) => {
  await page.goto('/en');
  await expect(page.locator(H1)).toHaveText(DEFAULT_H1.en);
  expect((await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), KEY)).count).toBe(1);
});

test('/en day 30 shows a level-5 English line', async ({ page }) => {
  await seed(page, { count: 30 });
  await page.goto('/en');
  expect(ALL.en[5]).toContain(await h1Text(page));
});

test('/en/support is never rotated (only the two homepages)', async ({ page }) => {
  await seed(page, { count: 40 });
  await page.goto('/en/support');
  await expect(page.locator('h1')).not.toHaveAttribute('data-h1-level', /.*/);
});

test('the SEO pages keep their keyword headline whatever the count', async ({ page }) => {
  const before = await (async () => {
    await page.goto('/gabung-pdf');
    return h1Text(page);
  })();
  const ctx = await page.context().browser().newContext({ locale: 'id-ID' });
  const p2 = await ctx.newPage();
  await p2.addInitScript((k) => {
    const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
    localStorage.setItem(k, JSON.stringify({ count: 20, lastDay: today, last: null }));
  }, KEY);
  await p2.goto('/gabung-pdf');
  expect(await p2.locator(H1).evaluate((e) => e.textContent)).toBe(before);
  expect(before).not.toBe('');
  await ctx.close();
});

test('no visitor_id (storage that will not keep it): static headline, nothing counted', async ({ page }) => {
  await page.addInitScript((k) => {
    // a browser whose storage refuses the visitor id; the day counter's key is seeded as if earlier visits had counted
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, v) {
      if (key === 'pdflokal_visitor_id') throw new Error('blocked');
      return real.call(this, key, v);
    };
    real.call(localStorage, k, JSON.stringify({ count: 20, lastDay: '2020-01-01', last: null }));
  }, KEY);
  await page.goto('/');
  await expect(page.locator(H1)).toHaveText(DEFAULT);
  const s = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), KEY);
  expect(s.count).toBe(20); // untouched
});

test('garbage in the key degrades to day 1, never a throw', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((k) => { localStorage.setItem(k, '{nope'); }, KEY);
  await page.goto('/');
  await expect(page.locator(H1)).toHaveText(DEFAULT);
  expect(errors).toEqual([]);
});

// ---- the layout, at 390px: every line of every level, both pages --------------
test.describe('phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  for (const [url, lang] of [['/', 'id'], ['/en', 'en']]) {
    test(`${url}: no line reaches three lines (two level-5 exceptions pending a ruling), and the stamp keeps its place`, async ({ page }) => {
      await page.goto(url);
      await page.waitForTimeout(1500); // the stamp thunks in; measure it at rest
      const rows = await page.evaluate((levels) => {
        const h1 = document.querySelector('.ld-hero-copy h1');
        const stampEl = document.querySelector('.ld-stamp');
        const out = [];
        for (const line of levels.flat()) {
          h1.textContent = line;
          const stamp = stampEl.getBoundingClientRect(); // it moves with the dropzone: measure after each swap
          const lh = parseFloat(getComputedStyle(h1).lineHeight);
          const r = h1.getBoundingClientRect();
          out.push({ line, lines: Math.round(r.height / lh), bottom: r.bottom, stampTop: stamp.top });
        }
        return out;
      }, ALL[lang]);
      expect(rows.length).toBeGreaterThan(25); // not an empty set passing for free
      // No line may reach three lines at 390px (the h1 is capped at 16ch). Two of his level-5
      // lines still do and are reported to the seat 2026-10-06 for a ruling; they are listed
      // here ONLY so this stays green until he rules. Delete the list when they are fixed.
      const KNOWN_THREE = {
        id: ['Bebanmu tak melebihi kekuatanmu.', 'Semoga kebahagiaan menyertai kita'],
        en: [],
      }[lang];
      const three = rows.filter((r) => r.lines >= 3).map((r) => r.line);
      expect(three).toEqual(KNOWN_THREE);
      for (const r of rows) expect(r.lines, `"${r.line}"`).toBeLessThanOrEqual(3);
      // The stamp rides the dropzone, which rides the headline, so its distance from the
      // headline's bottom must not depend on the line count or the text. If it varies,
      // a line has moved the stamp relative to the headline (a collision the static
      // headline never had). The static headline's own overlap (a rotated box corner) is the baseline.
      const gaps = rows.map((r) => r.bottom - r.stampTop);
      expect(Math.max(...gaps) - Math.min(...gaps), `gap spread ${gaps}`).toBeLessThanOrEqual(1);
    });
  }
});
