/*
 * THE PASTED SCREENSHOT on the general feedback form.
 * ============================================================================
 * RULED 2026-09-09. He approved an image on general feedback, then scoped how:
 * "gausah ada tombolnya, bilang aja diplaceholdernya 'tulis feedbacknya di
 * sini, atau boleh paste screenshot'".
 *
 * ⚠️ WHAT THESE TESTS ACTUALLY GUARD, and it is not the feature. The product's
 * claim is that a document never leaves the device. The ONLY thing that makes
 * an image defensible here is that the user performed a deliberate paste — so
 * the tests below pin the ABSENCE of every other route: no attach button, no
 * reach into the editor, nothing retained after Batal. A test that only proved
 * "pasting works" would go green on a build that also uploaded automatically.
 */
import { test, expect } from '@playwright/test';

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// Paste a real image the way a browser does: a DataTransfer carrying a File.
// Synthesising the module's internal state instead would test nothing about
// whether the paste path is wired at all.
async function pasteImage(page) {
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'shot.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const note = document.getElementById('fb-note');
    note.focus();
    note.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, PNG_1x1);
  await page.waitForSelector('#fb-shot:not([hidden])', { timeout: 5000 });
}

test.describe('feedback — the pasted screenshot', () => {
  test('the placeholder is his, verbatim, and there is NO attach button', async ({ page }) => {
    await page.goto('/');
    await page.click('#fb-open');
    await expect(page.locator('#fb-note')).toHaveAttribute(
      'placeholder', 'tulis feedbacknya di sini, atau boleh paste screenshot',
    );
    // The absence IS the ruling. A file input anywhere in this dialog would be
    // the convenience he declined, and the thing that turns a deliberate act
    // into a default.
    expect(await page.locator('#fb-form input[type="file"]').count()).toBe(0);
  });

  test('a pasted image is shown BACK before it can be sent, and can be removed', async ({ page }) => {
    await page.goto('/');
    await page.click('#fb-open');
    await expect(page.locator('#fb-shot')).toBeHidden();

    await pasteImage(page);
    await expect(page.locator('#fb-shot')).toBeVisible();
    const src = await page.locator('#fb-shot-img').getAttribute('src');
    // Re-encoded, not passed through: a PNG went in, a JPEG must come out. That
    // round trip is also what drops the source's metadata block.
    expect(src.startsWith('data:image/jpeg;base64,')).toBe(true);

    await page.click('#fb-shot-clear');
    await expect(page.locator('#fb-shot')).toBeHidden();
  });

  test('THE SEND CARRIES IT — and the payload is the screenshot field, not a sample', async ({ page }) => {
    const bodies = [];
    await page.route('**/api/feedback', async (route) => {
      bodies.push(JSON.parse(route.request().postData() || '{}'));
      await route.fulfill({ status: 204, body: '' });
    });
    await page.goto('/');
    await page.click('#fb-open');
    await pasteImage(page);
    await page.click('#fb-up');
    await page.click('#fb-send');
    await expect.poll(() => bodies.length).toBeGreaterThan(0);

    const body = bodies[0];
    expect(body.rating).toBe('up');
    expect(typeof body.screenshot).toBe('string');
    expect(body.screenshot.startsWith('data:image/jpeg;base64,')).toBe(true);
    // ⚠️ THE CROP PAIR MUST NEVER APPEAR ON THIS PATH. It belongs to
    // edit-feedback.js, has a different producer, a different validator and a
    // different consent story. The day the two share a field is the day a crop
    // can ride out on a route nobody audited.
    expect(body.sample_before).toBeUndefined();
    expect(body.sample_after).toBeUndefined();
  });

  test('CONTROL: no paste, no image field at all', async ({ page }) => {
    const bodies = [];
    await page.route('**/api/feedback', async (route) => {
      bodies.push(JSON.parse(route.request().postData() || '{}'));
      await route.fulfill({ status: 204, body: '' });
    });
    await page.goto('/');
    await page.click('#fb-open');
    await page.fill('#fb-note', 'tanpa gambar');
    await page.click('#fb-down');
    await page.click('#fb-send');
    await expect.poll(() => bodies.length).toBeGreaterThan(0);
    expect(bodies[0].screenshot).toBeUndefined();
    expect(bodies[0].note).toBe('tanpa gambar');
  });

  test('Batal does not keep the image for the next time the form opens', async ({ page }) => {
    // Re-opening with an attachment still loaded would be re-consenting on the
    // user's behalf to something they had already backed out of.
    await page.goto('/');
    await page.click('#fb-open');
    await pasteImage(page);
    await page.click('#fb-cancel');
    await page.click('#fb-open');
    await expect(page.locator('#fb-shot')).toBeHidden();
  });
});
