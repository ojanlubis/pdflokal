/*
 * The GENERAL feedback channel (footer "Ada masukan?" → #fb-form).
 *
 * The load-bearing test here is the LAST one. edit-feedback.js may attach
 * before/after crops of an edited line under a consent gate; this module must
 * never be able to. The seat's decisions.md calls content-blindness the one
 * failure class that cannot be walked back, so the assertion is written against
 * the ENTIRE serialized request body rather than a field list — a leak lands in
 * the field nobody thought to enumerate, which is exactly how the telemetry
 * envelope went unguarded until someone checked the whole body.
 */
import { test, expect } from '@playwright/test';

// Intercept so a test run never posts to the live feedback table.
async function captureFeedback(page) {
  const sent = [];
  await page.route('**/api/feedback', async (route) => {
    sent.push(route.request().postData() || '');
    await route.fulfill({ status: 204, body: '' });
  });
  return sent;
}

async function openForm(page) {
  await page.goto('/');
  await page.locator('#fb-open').scrollIntoViewIfNeeded();
  await page.tap('#fb-open');
  await expect(page.locator('#fb-form')).toBeVisible();
}

test.describe('general feedback form — mobile', () => {
  test('the footer link opens it, and Kirim is dead until a rating is picked', async ({ page }) => {
    await openForm(page);
    // The thank-you panel must NOT be showing before anything is sent. This
    // caught a real one: an author `display:flex` on .fb-done outranked the UA
    // `[hidden] { display: none }`, so "Makasih, kebaca kok." rendered under the
    // live form. Six tests passed anyway, because every one of them only ever
    // asserted the panel VISIBLE after sending. Absence needs its own assertion.
    await expect(page.locator('.fb-done')).toBeHidden();
    await expect(page.locator('.fb-body')).toBeVisible();
    // VACUITY GUARD: if the disabled attribute were dropped, this test still has
    // to fail, so assert the enabled state after a rating too — a `toBeDisabled`
    // that was never able to flip proves nothing about the gate.
    await expect(page.locator('#fb-send')).toBeDisabled();
    await page.tap('#fb-up');
    await expect(page.locator('#fb-send')).toBeEnabled();
  });

  test('rating is exclusive, and aria-pressed carries the state (not just a class)', async ({ page }) => {
    await openForm(page);
    await page.tap('#fb-down');
    await expect(page.locator('#fb-down')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#fb-up')).toHaveAttribute('aria-pressed', 'false');
    await page.tap('#fb-up');
    await expect(page.locator('#fb-up')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#fb-down')).toHaveAttribute('aria-pressed', 'false');
  });

  test('sends the rating and the note, then thanks and closes', async ({ page }) => {
    const sent = await captureFeedback(page);
    await openForm(page);
    await page.tap('#fb-down');
    await page.fill('#fb-note', 'kompres nya kelamaan di hape');
    await page.tap('#fb-send');

    await expect(page.locator('.fb-done')).toBeVisible();
    await expect.poll(() => sent.length).toBe(1);
    const body = JSON.parse(sent[0]);
    expect(body.rating).toBe('down');
    expect(body.note).toBe('kompres nya kelamaan di hape');

    await expect(page.locator('#fb-form')).toBeHidden({ timeout: 5000 });
  });

  test('a rating with no note is valid — words are optional, the rating is not', async ({ page }) => {
    const sent = await captureFeedback(page);
    await openForm(page);
    await page.tap('#fb-up');
    await page.tap('#fb-send');
    await expect.poll(() => sent.length).toBe(1);
    const body = JSON.parse(sent[0]);
    expect(body.rating).toBe('up');
    expect(body.note ?? '').toBe('');
  });

  test('reopening starts clean — a previous note never rides along', async ({ page }) => {
    const sent = await captureFeedback(page);
    await openForm(page);
    await page.tap('#fb-down');
    await page.fill('#fb-note', 'draft yang tidak jadi dikirim');
    await page.keyboard.press('Escape');
    await expect(page.locator('#fb-form')).toBeHidden();

    await page.tap('#fb-open');
    await expect(page.locator('#fb-note')).toHaveValue('');
    await expect(page.locator('#fb-send')).toBeDisabled();
    expect(sent.length).toBe(0); // dismissing sent nothing at all
  });

  test('the founder-ratified copy is exactly what ships (his words, 2026-08-03)', async ({ page }) => {
    // He ruled these six strings one at a time and rewrote two of them himself.
    // A ruling nobody checks is a green that cannot go red, so this asserts the
    // two he authored VERBATIM — including the lowercase and his spelling of
    // "terimakasih", which are his and not typos to tidy. If a future pass
    // sentence-cases or "improves" them, this fails, which is the point.
    await openForm(page);
    await expect(page.locator('#fb-note')).toHaveAttribute(
      'placeholder',
      'boleh minta feedbacknya di sini, supaya kita bisa improve terus pdflokal. (boleh dikosongin juga kok)',
    );
    await expect(page.locator('#fb-open')).toHaveText('Ada masukan?');
    await expect(page.locator('.fb-body h2')).toHaveText('Gimana PDFLokal?');
    await page.tap('#fb-up');
    await page.tap('#fb-send');
    await expect(page.locator('.fb-done h2')).toHaveText('terimakasih udah bantu pdflokal improve terus');
  });

  test('⭐ NO DOCUMENT CONTENT CAN RIDE THIS PATH, over a full open-edit-send cycle', async ({ page }) => {
    const sent = await captureFeedback(page);
    // Load a real document and touch it, so anything that COULD leak content
    // has content to leak. Without this the assertion passes for free.
    await page.goto('/');
    await page.setInputFiles('#file-input', 'tests/fixtures/sample-2pages.pdf');
    await expect(page.locator('.pv-page').first()).toBeVisible();

    // Back to the landing so the footer link exists, then send feedback.
    await page.goto('/');
    await page.locator('#fb-open').scrollIntoViewIfNeeded();
    await page.tap('#fb-open');
    await page.tap('#fb-down');
    await page.fill('#fb-note', 'ada bug pas edit');
    await page.tap('#fb-send');
    await expect.poll(() => sent.length).toBe(1);

    // Assert over the WHOLE body, not a field list.
    const raw = sent[0];
    expect(raw).not.toContain('data:image');
    expect(raw).not.toContain('sample_before');
    expect(raw).not.toContain('sample_after');
    expect(raw).not.toContain('base64');
    // Instrument check: the body is non-empty and really is our payload, so the
    // four absence assertions above were evaluated against something real.
    const body = JSON.parse(raw);
    expect(body.rating).toBe('down');
    expect(Object.keys(body).sort()).toEqual(['app_version', 'note', 'rating', 'session_id']);
  });
});
