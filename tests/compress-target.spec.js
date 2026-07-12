/*
 * PDFLokal — tests/compress-target.spec.js
 * ============================================================================
 * Target-size compression: the Indonesian wedge (Jul 2026).
 *
 * WHY THIS SUITE EXISTS, and why it is not just "does compression work":
 *   The feature's promise is not "smaller". It is "it will FIT" — under 500KB,
 *   under 1MB, whatever the CPNS/SNBP/e-filing portal demands. That promise has
 *   exactly one way to betray the user, and it is not a crash:
 *
 *     A berkas the user BELIEVES is under the cap, but isn't.
 *
 *   They upload it, the portal rejects it (often with no message), and they find
 *   out at the deadline. That is strictly worse than being told "177 KB — belum
 *   masuk 100 KB", which at least lets them act.
 *
 *   So the invariant under test is an HONESTY invariant, checked against the real
 *   downloaded bytes — never against what the UI claims:
 *     - if the UI says it fits, the BYTES must fit
 *     - if the BYTES don't fit, the UI must say so
 *   Both directions. A test that only checks the happy path would have passed on
 *   a build that silently rounded 640 KB down to "500 KB ✓".
 */

import { test, expect } from '@playwright/test';

const CAPS = [
  { slug: 'kompres-pdf-500kb', bytes: 500 * 1024, label: '500 KB', pages: 3 },
  { slug: 'kompres-pdf-100kb', bytes: 100 * 1024, label: '100 KB', pages: 3 },
  // The forced miss. 14 heavy scan pages cannot reach 100 KB at any rung on the
  // ladder, so this exercises the path where honesty is load-bearing.
  { slug: 'kompres-pdf-100kb', bytes: 100 * 1024, label: '100 KB', pages: 14, expectMiss: true },
];

// Build scan-like pages in-browser: white paper + a photo + "text" rules. Real
// fixtures are all under 40 KB, which never engages the compressor at all.
// Deliberately NOT random noise — noise is incompressible and would fake a miss.
async function loadScanLikeDoc(page, n) {
  await page.evaluate(async (count) => {
    const files = [];
    for (let p = 0; p < count; p++) {
      const c = document.createElement('canvas');
      c.width = 1700; c.height = 2338; // A4-ish at ~200dpi
      const x = c.getContext('2d');
      x.fillStyle = '#fdfdfb'; x.fillRect(0, 0, c.width, c.height);
      const g = x.createLinearGradient(0, 0, c.width, c.height);
      g.addColorStop(0, '#c9b8a0'); g.addColorStop(1, '#6d7f92');
      x.fillStyle = g; x.fillRect(120, 140, 1460, 620);
      x.fillStyle = '#1a1a1a';
      for (let i = 0; i < 260; i++) x.fillRect(140, 840 + i * 5.6, 300 + ((i * 137) % 1100), 2.4);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.96));
      files.push(new File([blob], `scan-${p + 1}.jpg`, { type: 'image/jpeg' }));
    }
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, n);
  await page.waitForSelector('.pv-bg', { timeout: 30_000 });
}

for (const cap of CAPS) {
  const title = `${cap.slug} · ${cap.pages} pages → ${cap.expectMiss ? 'honest miss' : `fits ${cap.label}`}`;

  test(title, async ({ page }) => {
    test.slow(); // the ladder does ~3 full re-rasterisations

    await page.goto(`/${cap.slug}`);

    // The page must declare the cap — this is what makes it a tool, not a brochure.
    await expect(page.locator('body')).toHaveAttribute('data-target', String(cap.bytes));

    await loadScanLikeDoc(page, cap.pages);

    // Intent fires: the sheet self-opens on Kompres with the cap pre-selected.
    await expect(page.locator('#dl-sheet')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#ds-target button.on')).toHaveText(cap.label);

    // Wait out the target search (the CTA narrates "Mencari ukuran yang pas…").
    await page.waitForFunction(() => {
      const m = document.querySelector('#ds-cta-main');
      return m && !/Mencari/.test(m.textContent) && /\d/.test(m.textContent);
    }, { timeout: 180_000 });

    const sub = (await page.locator('#ds-cta-sub').textContent()) ?? '';

    const dl = page.waitForEvent('download', { timeout: 60_000 });
    await page.click('#ds-cta');
    const download = await dl;
    const chunks = [];
    for await (const c of await download.createReadStream()) chunks.push(c);
    const out = Buffer.concat(chunks);

    expect(out.subarray(0, 5).toString(), 'output must be a real PDF').toBe('%PDF-');

    const fits = out.length <= cap.bytes;
    const claimsFit = /muat di bawah/.test(sub);
    const claimsMiss = /belum masuk/.test(sub);

    // THE HONESTY INVARIANT — both directions, against the real bytes.
    if (claimsFit) {
      expect(fits, `UI claimed it fits ${cap.label} but the file is ${Math.round(out.length / 1024)} KB`).toBe(true);
    }
    if (!fits) {
      expect(claimsMiss, `file is ${Math.round(out.length / 1024)} KB (over ${cap.label}) but the UI did not say so`).toBe(true);
    }

    if (cap.expectMiss) {
      expect(fits, 'this fixture is meant to be un-fittable — if it now fits, the ladder changed and this test is no longer testing the miss path').toBe(false);
      expect(sub).toContain('belum masuk');
    } else {
      expect(fits, `expected to fit under ${cap.label}, got ${Math.round(out.length / 1024)} KB`).toBe(true);
    }
  });
}
