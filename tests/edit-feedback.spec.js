/*
 * Edit (Teks Asli) BETA — rename + beta badge + first-commit feedback + telemetry.
 * ============================================================================
 * Founder pivot 2026-07-22, WHEN-to-ask settled after three tries: not per-commit
 * (naggy), not in the download sheet ("wrong place"), not a debounced idle-timer
 * ("bollocks, buggy") → SIMPLEST: ask ONCE, on the FIRST successful commit of a
 * document. This gate pins:
 *   - the tool is renamed "Edit", carries a VISIBLE beta badge + arm-toast;
 *   - the pill appears on the first commit; not before a commit; once per doc;
 *   - 👍 / 👎+note both send to /api/feedback (session-correlated, no doc text),
 *     and the 👎 placeholder ASKS for detail;
 *   - the ladder telemetry (ganti_tap/ganti_commit/surgery/insert/commit_paint)
 *     fires, so a 👎 is correlatable with what the edit did.
 *
 * Fixture: undangan-cid.pdf ("Rapat Anggota Tahunan 2026" ×3), middle repeat.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { armGanti, tapLine } from './helpers/lines.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NASTY = (name) => path.join(__dirname, 'fixtures', 'nasty', name);

// ONE capture helper for BOTH transports feedback() can use. PM-flagged
// 2026-07-27: two separate capture mechanisms (a sendBeacon-only spy plus a
// fetch-only spy) is exactly the drift hazard that broke this file —
// Increment D gave feedback() a second transport (a sample-bearing send
// takes a plain, non-keepalive fetch; everything else still takes
// sendBeacon — see js/v2/telemetry.js's own transport-finding comment), and
// the pre-Increment-D test below kept using a beacon-only spy, so its poll
// silently waited forever on a channel the real send never used. Every
// feedback spec — this file's whole point — now installs ONE spy that
// normalizes both transports into the SAME window.__beacons list, tagged
// with which channel actually carried it (`transport: 'beacon'|'fetch'`,
// plus `keepalive` for the fetch case). An "absence of X" assertion is only
// trustworthy if it's checking a list that COULD have shown X — a single
// merged list makes that automatic instead of something each test has to
// get right by hand.
async function captureFeedbackSends(page) {
  await page.addInitScript(() => {
    window.__beacons = [];
    navigator.sendBeacon = (url, blob) => {
      Promise.resolve(blob && blob.text ? blob.text() : blob)
        .then((txt) => {
          try { window.__beacons.push({ url: String(url), body: JSON.parse(txt), transport: 'beacon' }); } catch { /* non-JSON */ }
        });
      return true;
    };
    const origFetch = window.fetch ? window.fetch.bind(window) : null;
    window.fetch = (url, opts) => {
      try {
        if (typeof url === 'string' && url.includes('/api/')) {
          let body = null;
          try { body = opts && typeof opts.body === 'string' ? JSON.parse(opts.body) : null; } catch { /* non-JSON */ }
          window.__beacons.push({ url: String(url), body, transport: 'fetch', keepalive: !!(opts && opts.keepalive) });
        }
      } catch { /* never let the spy itself break the app */ }
      // Still calls through — a real (likely-failing, since there's no
      // actual serverless function behind the static test server) network
      // attempt, harmless either way since feedback()'s fetch call is
      // itself .catch(() => {})'d.
      return origFetch ? origFetch(url, opts) : Promise.reject(new Error('no fetch in this environment'));
    };
  });
}
const beacons = (page) => page.evaluate(() => (window.__beacons || []).slice());
const feedbackRecords = async (page) => (await beacons(page)).filter((b) => b.url.includes('/api/feedback'));
const feedbackBodies = async (page) => (await feedbackRecords(page)).map((b) => b.body);
const fakeTabHidden = (page) => page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});

async function openDoc(page, fixture) {
  await page.goto('/');
  await page.setInputFiles('#file-input', fixture);
  await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();
}

async function editMiddleLine(page, newText) {
  await armGanti(page);
  await tapLine(page, { str: 'Rapat Anggota Tahunan 2026', nth: 1 });
  await page.keyboard.type(newText);
  await page.keyboard.press('Enter');
  await expect(page.locator('.v2-text-edit')).toHaveCount(0);
}

test.describe('edit beta: rename + first-commit feedback', () => {
  test('the tool is renamed Edit with a VISIBLE beta badge + beta arm-toast', async ({ page }) => {
    await openDoc(page, NASTY('undangan-cid.pdf'));
    const btn = page.locator('[data-tool="ganti"]');
    await expect(btn).toContainText('Edit');
    await expect(btn).not.toContainText('Ganti');
    const badge = btn.locator('.beta-tag');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText(/beta/i);
    await armGanti(page);
    await expect(page.locator('#toast')).toContainText(/beta/i);
  });

  test('the pill appears on the first commit; 👍 sends rating:up (no note)', async ({ page }) => {
    await captureFeedbackSends(page);
    await openDoc(page, NASTY('undangan-cid.pdf'));
    await editMiddleLine(page, 'Rapat Baru');

    const pill = page.locator('#edit-feedback');
    await expect(pill).toHaveClass(/show/);
    await pill.locator('[aria-label="Bagus"]').click();

    await expect.poll(async () => (await feedbackBodies(page)).some((b) => b.rating === 'up')).toBe(true);
    const fb = (await feedbackBodies(page)).find((b) => b.rating === 'up');
    expect(fb).not.toHaveProperty('note');
    expect(fb.session_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  // Re-pinned 2026-07-27 (Increment D, PM-flagged): the ORIGINAL name here
  // said "never doc text" as if this feature never sends anything DERIVED
  // from the document — that stopped being literally true the moment
  // Increment D shipped (it deliberately sends IMAGES of the edited line's
  // own text, WITH consent). What this test actually still pins, and what
  // remains true unconditionally: the note/rating fields themselves never
  // carry the document's text AS TEXT — no silent string leak into the one
  // free field. Whether an image sample rides along on this particular
  // Kirim is timing-dependent (capture is idle-deferred) and NOT what this
  // test asserts either way; "images only via the consented ask, never
  // otherwise" is pinned explicitly in the "Increment D" describe block
  // below, which is the right place to read for that invariant now.
  test('👎 -> Kirim sends rating+note; the note/rating fields never carry document text AS TEXT', async ({ page }) => {
    await captureFeedbackSends(page);
    await openDoc(page, NASTY('undangan-cid.pdf'));
    await editMiddleLine(page, 'Rapat Baru');

    const pill = page.locator('#edit-feedback');
    await expect(pill).toHaveClass(/show/);
    await pill.locator('[aria-label="Kurang pas"]').click();
    const note = pill.locator('.ef-note');
    await expect(note).toBeVisible();
    await expect(note).toHaveAttribute('placeholder', /improve/i);
    await note.fill('hurufnya beda dikit');
    await pill.locator('.ef-send').click();

    await expect.poll(async () => (await feedbackBodies(page))[0])
      .toEqual(expect.objectContaining({ rating: 'down', note: 'hurufnya beda dikit' }));
    const fb = (await feedbackBodies(page))[0];
    expect(fb.note).not.toContain('Rapat');
    // If a sample happened to be ready in time, it's still just base64 PNG
    // bytes — never a literal text match for the edited string either.
    if (fb.sample_before) expect(fb.sample_before).not.toContain('Rapat');
    if (fb.sample_after) expect(fb.sample_after).not.toContain('Rapat');
  });

  test('never asks before a commit (arm + cancel shows no pill)', async ({ page }) => {
    await openDoc(page, NASTY('undangan-cid.pdf'));
    await armGanti(page);
    await tapLine(page, { str: 'Rapat Anggota Tahunan 2026', nth: 1 });
    await page.keyboard.press('Escape');
    await expect(page.locator('.v2-text-edit')).toHaveCount(0);
    await page.waitForTimeout(300);
    await expect(page.locator('#edit-feedback')).toHaveCount(0);
  });

  test('asks only ONCE — a second commit does not re-open the pill', async ({ page }) => {
    await openDoc(page, NASTY('undangan-cid.pdf'));
    await editMiddleLine(page, 'Rapat Baru');
    await expect(page.locator('#edit-feedback')).toHaveClass(/show/);
    // answer + let it fade, then edit again
    await page.locator('#edit-feedback [aria-label="Bagus"]').click();
    await page.waitForTimeout(300);
    await editMiddleLine(page, 'Rapat Lagi');
    await page.waitForTimeout(300);
    await expect(page.locator('#edit-feedback')).not.toHaveClass(/show/);
  });

  test('the ladder telemetry events fire (correlated with the edit)', async ({ page }) => {
    await captureFeedbackSends(page);
    await openDoc(page, NASTY('undangan-cid.pdf'));
    await editMiddleLine(page, 'Rapat Baru');

    const evNames = async () => {
      await fakeTabHidden(page);
      return (await beacons(page)).filter((b) => b.url.includes('/api/t')).flatMap((b) => (b.body.events || []).map((e) => e.event));
    };
    await expect.poll(evNames).toContain('commit_paint');

    const evs = (await beacons(page)).filter((b) => b.url.includes('/api/t')).flatMap((b) => b.body.events || []);
    const names = evs.map((e) => e.event);
    expect(names).toContain('ganti_tap');
    expect(names).toContain('ganti_commit');
    expect(names).toContain('surgery');
    expect(evs.find((e) => e.event === 'ganti_commit').props.outcome).toBe('commit');
    expect(evs.find((e) => e.event === 'surgery').props).toEqual({ matched: true, reason: 'clean' });
    // style_source (spec-edit-fidelity-instrumentation.md Increment B; FIXED
    // 2026-07-26, founder-flagged correctness bug): used to ride on js/v2/
    // app.js's prepareDocFont's async race and flake under full-suite load.
    // core/stamp.js's resolveStampFont now resolves AUTHORITATIVELY against
    // the real document on every path — undangan-cid.pdf's Montserrat font
    // has an informative /BaseFont, so this resolves cleanly to 'pdf-name'
    // every run.
    expect(evs.find((e) => e.event === 'insert').props).toEqual({
      path: 'native', reason: 'clean', style_source: 'pdf-name', glyph_shortfall: 0,
    });
  });
});

// spec-edit-fidelity-instrumentation.md Increment D — the consent-gated
// sample: 👎 → (once js/v2/app.js's idle-deferred capture lands) the pill
// grows the founder's verbatim ask + two rendered crops; ONLY a Kirim tap on
// THAT ask sends them. Everything else — 👍, "Nggak usah", abandoning —
// stays exactly as before this increment: rating(+note), never an image.
test.describe('edit beta: Increment D consent-gated sample', () => {
  test('👎 renders two non-empty crops (Asli/Hasil); Kirim sends them via fetch, never sendBeacon', async ({ page }) => {
    await captureFeedbackSends(page);
    await openDoc(page, NASTY('undangan-cid.pdf'));
    await editMiddleLine(page, 'Rapat Baru');

    const pill = page.locator('#edit-feedback');
    await expect(pill).toHaveClass(/show/);
    await pill.locator('[aria-label="Kurang pas"]').click();
    await expect(pill.locator('.ef-note')).toBeVisible();

    // Capture is deferred (requestIdleCallback) — poll for the ask block.
    await expect.poll(() => pill.locator('.ef-crop-item').count(), { timeout: 5000 }).toBe(2);
    await expect(pill.locator('.ef-ask-q')).toHaveText('Boleh kami minta dua potongan ini?');
    await expect(pill.locator('.ef-ask-sub')).toHaveText(
      'Sebelum dan sesudahnya, biar kami bisa analisis fiturnya kurang di mana. Nggak ada isi file lain.',
    );
    await expect(pill.locator('.ef-crop-label').nth(0)).toHaveText('Asli');
    await expect(pill.locator('.ef-crop-label').nth(1)).toHaveText('Hasil');

    // Both crops must actually render something, not just carry an empty src.
    await expect.poll(async () => pill.locator('.ef-crop-img').evaluateAll(
      (imgs) => imgs.length === 2 && imgs.every((img) => img.naturalWidth > 0 && img.naturalHeight > 0),
    )).toBe(true);
    const srcs = await pill.locator('.ef-crop-img').evaluateAll((imgs) => imgs.map((img) => img.getAttribute('src')));
    expect(srcs).toHaveLength(2);
    for (const src of srcs) expect(src).toMatch(/^data:image\/png;base64,/);
    // PM-flagged 2026-07-27 (bug 1, 444-page field test): "both non-empty"
    // is satisfied by two IDENTICAL pristine crops — worthless as a
    // regression guard for the exact defect that shipped (the "after" crop
    // silently staying the PRISTINE render when rebakePage's stale-guard
    // stands down). The crops must actually DIFFER — Asli is the original
    // line, Hasil is the stamped one, and this edit changed the text.
    expect(srcs[0]).not.toBe(srcs[1]);

    await pill.locator('.ef-send').click();

    await expect.poll(async () => (await feedbackRecords(page)).length).toBeGreaterThan(0);
    const [{ body, transport, keepalive }] = await feedbackRecords(page);
    expect(body.rating).toBe('down');
    expect(body.sample_before).toMatch(/^data:image\/png;base64,/);
    expect(body.sample_after).toMatch(/^data:image\/png;base64,/);
    // The transport finding: a sample-bearing send takes a plain fetch, NOT
    // keepalive (keepalive shares sendBeacon's ~64KiB cap — see js/v2/
    // telemetry.js's own comment) and NOT sendBeacon at all.
    expect(transport).toBe('fetch');
    expect(keepalive).toBe(false);
  });

  test('"Nggak usah" sends rating+note but NO images, even though a sample was offered', async ({ page }) => {
    await captureFeedbackSends(page);
    await openDoc(page, NASTY('undangan-cid.pdf'));
    await editMiddleLine(page, 'Rapat Baru');

    const pill = page.locator('#edit-feedback');
    await pill.locator('[aria-label="Kurang pas"]').click();
    await expect.poll(() => pill.locator('.ef-crop-item').count(), { timeout: 5000 }).toBe(2);
    // Same non-vacuous check as the Kirim test above: two crops that were
    // silently identical would still satisfy a mere "2 items rendered" poll.
    const offeredSrcs = await pill.locator('.ef-crop-img').evaluateAll((imgs) => imgs.map((img) => img.getAttribute('src')));
    expect(offeredSrcs[0]).not.toBe(offeredSrcs[1]);

    await pill.locator('.ef-note').fill('kurang pas dikit');
    await pill.locator('.ef-skip').click();

    await expect.poll(async () => (await feedbackRecords(page)).length).toBeGreaterThan(0);
    const records = await feedbackRecords(page);
    const rec = records.find((r) => r.body.rating === 'down');
    expect(rec).toBeTruthy();
    expect(rec.body.note).toBe('kurang pas dikit');
    expect(rec.body).not.toHaveProperty('sample_before');
    expect(rec.body).not.toHaveProperty('sample_after');
    // "Nggak usah" never takes the fetch path — that only fires when a
    // sample is actually attached to the feedback() call — checked on the
    // SAME merged list the presence poll above already used, so a
    // regression that routed this send through fetch instead would have
    // failed that poll, not silently passed this one.
    expect(rec.transport).toBe('beacon');
    expect(records.some((r) => r.transport === 'fetch')).toBe(false);
  });

  test('👍 sends NO images — the up-vote path never carries a sample, by construction', async ({ page }) => {
    await captureFeedbackSends(page);
    await openDoc(page, NASTY('undangan-cid.pdf'));
    await editMiddleLine(page, 'Rapat Baru');

    const pill = page.locator('#edit-feedback');
    await expect(pill).toHaveClass(/show/);
    await pill.locator('[aria-label="Bagus"]').click();

    await expect.poll(async () => (await feedbackRecords(page)).some((r) => r.body.rating === 'up')).toBe(true);
    const records = await feedbackRecords(page);
    const rec = records.find((r) => r.body.rating === 'up');
    expect(rec.body).not.toHaveProperty('sample_before');
    expect(rec.body).not.toHaveProperty('sample_after');
    expect(rec.transport).toBe('beacon');
    expect(records.some((r) => r.transport === 'fetch')).toBe(false);
  });

  test('abandoning an open 👎 (Buka Baru mid-note) records rating with NO images', async ({ page }) => {
    await captureFeedbackSends(page);
    await openDoc(page, NASTY('undangan-cid.pdf'));
    await editMiddleLine(page, 'Rapat Baru');

    const pill = page.locator('#edit-feedback');
    await pill.locator('[aria-label="Kurang pas"]').click();
    await expect(pill.locator('.ef-note')).toBeVisible();
    // Don't wait for the ask block on purpose — this pins the abandon path
    // regardless of whether capture had landed yet.

    // "Buka Baru": File menu -> Buka Baru -> pick a new file. resetDoc() zeroes
    // doc.pages BEFORE loadFiles() runs, so loadFiles's own `doc.pages.length
    // === 0` check fires resetEditFeedback() -> dismissEditFeedback() ->
    // finish(), which records the still-open 👎 note-less, sample-less.
    await page.click('#btn-file');
    await page.click('#fm-new');
    await page.setInputFiles('#file-input', NASTY('undangan-cid.pdf'));
    await expect(page.locator('.pv-page .pv-bg').first()).toBeVisible();

    await expect.poll(async () => (await feedbackRecords(page)).length).toBeGreaterThan(0);
    const records = await feedbackRecords(page);
    const rec = records.find((r) => r.body.rating === 'down');
    expect(rec).toBeTruthy();
    expect(rec.body).not.toHaveProperty('note');
    expect(rec.body).not.toHaveProperty('sample_before');
    expect(rec.body).not.toHaveProperty('sample_after');
    expect(rec.transport).toBe('beacon');
    expect(records.some((r) => r.transport === 'fetch')).toBe(false);
  });
});

// BUG 1 (PM-flagged 2026-07-27, founder field test on a 444-page doc): the
// pill showed the SAME text ("TIM PENYUSUN") in both Asli and Hasil — the
// oracle would have silently corrupted the same way (weight_ratio/
// height_ratio reading exact parity forever, "confidently healthy" while
// blind). EMPIRICALLY CONFIRMED mechanism (three throwaway diagnostic
// Playwright runs, not the originally-suspected one): calling rebuildStage()
// alone mid-rebake does NOT corrupt page.raster — rasterizer.rasterize()
// (core/import.js) writes page.raster itself, independent of app.js's own
// slot-identity stale-guard, so a stood-down bake used to leave the DATA
// correct and only the on-screen PIXELS stale. The confirmed data-
// corrupting path is undo/redo: history.js's restore() SPREAD-COPIES
// doc.pages into fresh objects, so an in-flight rebakePage()'s result lands
// on the now-orphaned OLD page object — invisible to a later re-read of
// getPage(doc, pageId).raster, which sees the POST-undo object instead. A
// 444-page doc's slow rasterize() await just widens the window for this (or
// any future doc.pages-replacing action) to land. Reproduced here
// deterministically on a 1-page fixture via an artificial rasterize delay +
// a REAL Ctrl+Z mid-flight — no need for an actual 444-page document.
test.describe('edit beta: BUG 1 — stale rebake must never compare pristine-vs-pristine', () => {
  test('an undo mid-rebake declines BOTH the oracle and the sample, never a bogus identical comparison', async ({ page }) => {
    await captureFeedbackSends(page);
    await openDoc(page, NASTY('undangan-cid.pdf'));

    // Delay ONLY the rasterize() call this commit's own rebakePage() makes,
    // just long enough to fire a real undo while it's still in flight.
    await page.evaluate(() => {
      const raz = window.v2.getRasterizer();
      const orig = raz.rasterize.bind(raz);
      let armed = true;
      raz.rasterize = (...args) => {
        if (armed) {
          armed = false;
          window.__raceStarted = true;
          return new Promise((resolve) => { setTimeout(() => resolve(orig(...args)), 500); });
        }
        return orig(...args);
      };
    });

    await editMiddleLine(page, 'Rapat Baru');
    await page.waitForFunction(() => window.__raceStarted === true);
    await page.keyboard.press('Control+z'); // races the still-in-flight rebake
    await page.waitForTimeout(900); // let the delayed rebake resolve well after the undo

    // No visual_oracle event — the bake it would have to compare against
    // never actually landed for this generation. (Sanity: a real commit DID
    // happen — this must be a TARGETED decline, not "nothing ran at all".)
    await fakeTabHidden(page);
    const evs = (await beacons(page)).filter((b) => b.url.includes('/api/t')).flatMap((b) => b.body.events || []);
    const names = evs.map((e) => e.event);
    expect(names).toContain('ganti_commit');
    expect(names).toContain('commit_paint');
    expect(names).not.toContain('visual_oracle');

    // And the feedback pill's sample offer declines the same way: 👎 shows
    // the plain note only — no ask block, no crops, never a bogus identical
    // pair rendered as if it were a real before/after.
    const pill = page.locator('#edit-feedback');
    await expect(pill).toHaveClass(/show/);
    await pill.locator('[aria-label="Kurang pas"]').click();
    await expect(pill.locator('.ef-note')).toBeVisible();
    await page.waitForTimeout(600); // idle-deferred capture would have landed by now if it ran at all
    expect(await pill.locator('.ef-crop-item').count()).toBe(0);
  });
});
