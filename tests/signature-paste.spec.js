/*
 * PDFLokal — paste an image into the signature "Upload Foto" flow.
 *
 * Wave 1: users had to download → save → re-upload a signature image (three
 * round-trips) for something already on their clipboard. Now, while the signature
 * modal is open, Ctrl/Cmd+V routes the pasted image straight to loadSignatureImage,
 * which advances to the background-removal modal. Paraf (draw-only) is excluded.
 */
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PDF = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');

async function loadEditor(page) {
  await page.goto('/alat-gambar.html');
  await page.setInputFiles('#file-input', SAMPLE_PDF);
  await page.waitForFunction(() => document.body.classList.contains('editor-active'));
  await page.waitForFunction(() => window.ueState?.pages?.length === 2);
}

// Dispatch a synthetic paste carrying a small PNG, as if the user hit Ctrl/Cmd+V.
async function pasteImage(page) {
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 40; canvas.height = 20;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 40, 20);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    const file = new File([blob], 'pasted.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  });
}

test.describe('Signature clipboard paste', () => {
  test('paste while signature modal open → advances to bg-removal modal', async ({ page }) => {
    await loadEditor(page);

    await page.evaluate(() => window.openSignatureModal());
    await page.waitForFunction(() =>
      document.getElementById('signature-modal')?.classList.contains('active'));

    await pasteImage(page);

    // loadSignatureImage closes the signature modal and opens signature-bg-modal.
    await page.waitForFunction(() =>
      document.getElementById('signature-bg-modal')?.classList.contains('active'),
      null, { timeout: 5000 });
    await expect(page.locator('#signature-modal')).not.toHaveClass(/active/);
    // The uploaded image is now staged for background removal.
    expect(await page.evaluate(() => !!window.state?.signatureUploadImage)).toBe(true);
  });

  test('paste with NO signature modal open does not open the bg-removal modal', async ({ page }) => {
    await loadEditor(page);
    // No modal open — a stray paste in the editor must not hijack into the sig flow.
    await pasteImage(page);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() =>
      document.getElementById('signature-bg-modal')?.classList.contains('active'))).toBe(false);
  });
});
