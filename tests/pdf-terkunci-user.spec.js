/*
 * A user-password-protected PDF cannot be opened AT ALL — not even PDF.js can
 * decrypt it without the password, unlike terkunci.pdf's empty-user-password
 * shape (pdf-terkunci.spec.js), which PDF.js renders with no prompt. This app
 * never supplies an onPassword callback (js/core/import.js), so
 * pdfjsLib.getDocument() rejects with PasswordException and the file lands in
 * the SAME "every file failed" branch as a genuinely empty/corrupt file
 * (js/v2/app.js, doc.pages.length === 0).
 *
 * STATE.md "RATIFIED 2026-08-14" ruled these two causes need different
 * words: a locked file is not the same problem as a broken one, and telling
 * the user "mungkin kosong atau rusak" about a file that is neither is
 * actively misleading. This is a genuine behaviour change (the code did not
 * distinguish them before) gated on `usable.length === 1 &&
 * failureReason(err) === 'encrypted'` — a multi-file batch keeps the
 * existing generic wording, because no ratified string covers that case.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NASTY = (n) => path.join(__dirname, 'fixtures', 'nasty', n);

test.describe('a PDF that needs a password PDF.js does not have', () => {
  test('single file: "File itu dikunci sandi, jadi nggak bisa dibuka di sini" — never the empty/corrupt wording', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('#file-input', NASTY('terkunci-user.pdf'));

    await expect(page.locator('#toast')).toHaveText('File itu dikunci sandi, jadi nggak bisa dibuka di sini');
    // Never the generic wording this branch used to always say.
    await expect(page.locator('#toast')).not.toContainText(/kosong atau rusak/);

    // Nothing opened — same dead-end shape as the genuine empty/corrupt decline.
    const pages = await page.evaluate(() => window.v2.getDoc().pages.length);
    expect(pages).toBe(0);
  });

  test('CONTROL: a genuinely corrupt single file keeps the OLD wording — the distinction only fires for PasswordException', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('#file-input', {
      name: 'rusak.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\nthis is not a pdf at all\n'),
    });

    await expect(page.locator('#toast')).toHaveText('File itu nggak bisa dibuka, mungkin kosong atau rusak');
    await expect(page.locator('#toast')).not.toContainText(/dikunci sandi/);
  });

  test('CONTROL: a multi-file batch where the only file is locked keeps the PLURAL generic wording — no ratified string covers that case', async ({ page }) => {
    await page.goto('/');
    // Two files handed to the SAME input in one go so usable.length === 2,
    // not two separate setInputFiles calls (which would each be a fresh
    // single-file load). Playwright cannot mix a path string with a buffer
    // object in one call, so both are read as buffers.
    await page.setInputFiles('#file-input', [
      {
        name: 'terkunci-user.pdf',
        mimeType: 'application/pdf',
        buffer: fs.readFileSync(NASTY('terkunci-user.pdf')),
      },
      {
        name: 'rusak2.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.4\nalso not a real pdf\n'),
      },
    ]);

    await expect(page.locator('#toast')).toHaveText('Nggak ada file yang bisa dibuka, mungkin kosong atau rusak');
    await expect(page.locator('#toast')).not.toContainText(/dikunci sandi/);
  });
});
