/*
 * TELEMETRY SUITE — class B: CONTENT-BLINDNESS.
 * ============================================================================
 * "Nothing the user's document contains ever leaves the device on the rail."
 *
 * WHY THIS CLASS IS DIFFERENT FROM EVERY OTHER ONE, and why it never gets
 * deferred: **every other class fails recoverably.** A dead event, an
 * unproven delivery, a missing failure signal — we lose data, we fix it, we
 * backfill. **This one cannot be walked back.** A document string that leaves a
 * device is out, permanently, and it breaks the sentence the whole product is
 * built on: *"Filemu nggak pernah pergi ke server."*
 *
 * ⚠️ HOW THIS WILL ACTUALLY REGRESS — read this before adding a prop.
 * **Nobody will ever decide to send user content.** It will arrive attached to
 * something that looks like a fix. The real near-miss, 2026-07-28: while fixing
 * the protected-PDF export failure, the obvious implementation was to branch on
 * the caught error's `.message`. Convenient, correct-looking — and a thrown
 * message can quote the document back to us (a PDF parse error can carry object
 * or stream content). **That would have been a privacy leak wearing a bug fix's
 * costume.** It was avoided by branching on the SOURCE's own recorded boolean
 * instead. Expect the next one to look equally reasonable.
 *
 * WHAT ALREADY GUARDS THIS, so this file adds what's missing rather than
 * repeating it:
 *   - tests/core/telemetry-schema.test.mjs proves NO string-typed prop exists
 *     anywhere in SCHEMA, and that unknown props fail the WHOLE event. That is
 *     the structural guarantee — a free-text field cannot be declared.
 *   - tests/edit-feedback.spec.js proves the consent-gated /api/feedback sample
 *     sends images only on an explicit 👎 → Kirim.
 *
 * WHAT WAS MISSING, and is here: nothing asserted the ABSENCE of document text
 * across a whole real payload. The existing tests check named fields. A leak
 * arrives in a field nobody thought to check — which is exactly why the
 * assertion below reads the entire serialized body rather than any field list.
 *
 * The fixture text is chosen to be unmistakable: "Budi Santoso Wijaya" and
 * "Pondok Sapi" appear in no source file, no enum, and no UI string, so a match
 * cannot be a coincidence.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { armGanti, tapLine } from './helpers/lines.js';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NASTY = (n) => path.join(__dirname, 'fixtures', 'nasty', n);

// Every /api/* body this page sends, captured verbatim as TEXT — deliberately
// not parsed into fields, because a leak lands in a field we didn't enumerate.
async function captureBodies(page) {
  await page.addInitScript(() => {
    window.__bodies = [];
    navigator.sendBeacon = (url, blob) => {
      Promise.resolve(blob && blob.text ? blob.text() : blob)
        .then((t) => window.__bodies.push({ url: String(url), text: String(t) }));
      return true;
    };
    const origFetch = window.fetch ? window.fetch.bind(window) : null;
    window.fetch = (url, opts) => {
      if (typeof url === 'string' && url.includes('/api/') && opts?.body) {
        window.__bodies.push({ url: String(url), text: String(opts.body) });
      }
      return origFetch ? origFetch(url, opts) : Promise.resolve(new Response('{}'));
    };
  });
}

const flush = (page) => page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});

const railBodies = async (page) => {
  await flush(page);
  return page.evaluate(() => (window.__bodies || []).filter((b) => b.url.includes('/api/t')));
};

// WHY this exists rather than a bare railBodies() call: the capture shim reads
// the beacon's Blob via `blob.text()`, which resolves a microtask AFTER
// sendBeacon returns — so reading immediately can see an empty list even though
// the flush fired. Poll for the events to arrive, then assert on them. Without
// this, every "does not contain" below would pass VACUOUSLY against an empty
// payload, which is the trap the count guard exists to catch.
async function railEventsAtLeast(page, n) {
  await expect.poll(async () => (await railBodies(page))
    .flatMap((b) => JSON.parse(b.text).events || []).length).toBeGreaterThan(n);
  return railBodies(page);
}

test.describe('telemetry is content-blind', () => {
  test('a full edit+export cycle sends NO document text, and no file name, on the rail', async ({ page }) => {
    await captureBodies(page);
    await page.goto('/');
    await page.setInputFiles('#file-input', NASTY('label-tebal.pdf'));
    await expectFirstPage(page);

    // Drive the paths that emit the most events: tap, commit, export.
    await armGanti(page);
    await tapLine(page, { str: 'Budi Santoso' });
    await expect(page.locator('.v2-text-edit')).toHaveAttribute('data-style-prepared', '1');
    await page.locator('.v2-text-edit').evaluate((el) => { el.textContent = ''; });
    await page.keyboard.type('Siti Rahayu');
    await page.keyboard.press('Enter');
    await expect(page.locator('.v2-text-edit')).toHaveCount(0);

    await page.click('#btn-download');
    await expect(page.locator('#dl-sheet')).toBeVisible();
    const dl = page.waitForEvent('download').catch(() => null);
    await page.click('#ds-cta');
    await dl;

    // The assertions can only mean something if events were actually sent.
    // Without this, every "does not contain" below passes vacuously on an empty
    // list — the same trap class A's scan guard exists for.
    const bodies = await railEventsAtLeast(page, 3);
    const all = bodies.map((b) => b.text).join('\n');
    // Text the user can SEE in the document — the original and the replacement.
    for (const secret of ['Budi', 'Santoso', 'Wijaya', 'Siti', 'Rahayu', 'FORMULIR', 'Jalan Merdeka']) {
      expect(all, `document text "${secret}" reached the rail`).not.toContain(secret);
    }
    // The FILE NAME is document-derived too, and is the easiest thing to attach
    // to an event "just for debugging".
    for (const frag of ['label-tebal', '.pdf']) {
      expect(all, `file name fragment "${frag}" reached the rail`).not.toContain(frag);
    }
  });

  test('the envelope carries exactly session_id + app_version + events — nothing else', async ({ page }) => {
    await captureBodies(page);
    await page.goto('/');
    await page.setInputFiles('#file-input', NASTY('label-tebal.pdf'));
    await expectFirstPage(page);

    const bodies = await railEventsAtLeast(page, 0);

    for (const b of bodies) {
      const env = JSON.parse(b.text);
      // Pinned deliberately. A URL, a referrer, a user-agent or a "context"
      // blob added here would each be a content channel that no per-event
      // schema check would ever see — validateEvent only inspects props.
      expect(Object.keys(env).sort()).toEqual(['app_version', 'events', 'session_id']);
      expect(typeof env.session_id).toBe('string');
      expect(env.session_id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(Array.isArray(env.events)).toBe(true);
    }
  });

  test('a FAILING document sends the failure event and still no content — errors are the leak vector', async ({ page }) => {
    await captureBodies(page);
    await page.goto('/');
    // terkunci.pdf makes the export throw. The thrown message is exactly the
    // string a "helpful" implementation would attach to the failure event.
    await page.setInputFiles('#file-input', NASTY('terkunci.pdf'));
    await expectFirstPage(page);

    await page.click('#btn-download');
    await expect(page.locator('#dl-sheet')).toBeVisible();
    await page.click('#ds-cta');

    await expect.poll(async () => (await railBodies(page))
      .flatMap((b) => JSON.parse(b.text).events || [])
      .some((e) => e.event === 'failure')).toBe(true);

    const all = (await railBodies(page)).map((b) => b.text).join('\n');
    // The real thrown text, and the document's own words. Neither may appear.
    for (const secret of ['TABEL KONVERSI', 'HALAMAN DUA', 'Baris contoh', 'ignoreEncryption', 'PDFDocument', 'terkunci.pdf']) {
      expect(all, `"${secret}" reached the rail from an error path`).not.toContain(secret);
    }
  });
});
