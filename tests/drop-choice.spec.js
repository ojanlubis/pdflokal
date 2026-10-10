/*
 * PDFLokal — a file dropped onto an OPEN document asks: add, or replace?
 * And File > Buka Baru asks first when there are edits nobody downloaded.
 *
 * His ask 2026-10-09. Before it, a drop on an open doc appended silently, and
 * Buka Baru wiped the doc and its undo history the moment a file was picked.
 * Red on revert: without #drop-choice the second case appends 2+2 pages with no
 * dialog; without #new-confirm the Buka Baru case never sees a dialog.
 * Not run by the foreground gate (nightly CI).
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectFirstPage } from './helpers/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');

async function open(page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await expectFirstPage(page);
}

// A synthetic OS file drop of the 2-page fixture onto the page.
async function dropFixture(page) {
  await page.evaluate(async () => {
    const buf = await (await fetch('/tests/fixtures/sample-2pages.pdf')).arrayBuffer();
    const dt = new DataTransfer();
    dt.items.add(new File([buf], 'dropped.pdf', { type: 'application/pdf' }));
    document.getElementById('v2-stage').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
}

async function addText(page, text = 'Halo') {
  await page.keyboard.press('t');
  await page.click('.pv-page >> nth=0', { position: { x: 200, y: 200 } });
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await expect(page.locator('.pv-anno-text').last()).toHaveText(text);
}

const pageCount = (page) => page.evaluate(() => window.v2.getDoc().pages.length);

test.describe('drop onto the canvas', () => {
  test('onto an empty canvas the file just opens, no question', async ({ page }) => {
    await page.goto('/');
    await dropFixture(page);
    await expectFirstPage(page);
    await expect(page.locator('#drop-choice')).not.toBeVisible();
    expect(await pageCount(page)).toBe(2);
  });

  test('onto an open doc it asks; Tambah appends', async ({ page }) => {
    await open(page);
    await dropFixture(page);
    await expect(page.locator('#drop-choice')).toBeVisible();
    expect(await pageCount(page)).toBe(2); // nothing happens until they choose
    await page.click('#dc-add');
    await expect(page.locator('#drop-choice')).not.toBeVisible();
    await expect.poll(() => pageCount(page)).toBe(4);
  });

  test('Ganti replaces the doc and its undo history', async ({ page }) => {
    await open(page);
    await addText(page);
    await dropFixture(page);
    await page.click('#dc-replace');
    await expect.poll(() => page.evaluate(() => window.v2.getDoc().sources.length)).toBe(1);
    expect(await pageCount(page)).toBe(2);
    await expect(page.locator('.pv-anno-text')).toHaveCount(0);
    expect(await page.evaluate(() => window.v2.history.undoStack.length)).toBe(0);
  });

  test('Ganti with a file we cannot open refuses and keeps the doc and its edits', async ({ page }) => {
    // Red on revert: resetDoc ran before loadFiles' type check, so a dropped
    // .docx emptied the editor (0 pages, no landing) and the undo history.
    await open(page);
    await addText(page);
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['x'], 'surat.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
      document.getElementById('v2-stage').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await page.click('#dc-replace');
    await page.waitForTimeout(500); // give a wrongly-ordered wipe time to land
    expect(await pageCount(page)).toBe(2);
    await expect(page.locator('.pv-anno-text')).toHaveCount(1);
    expect(await page.evaluate(() => window.v2.history.undoStack.length)).toBeGreaterThan(0);
    await expect(page.locator('body')).not.toHaveClass(/is-empty/);
  });

  test('Batal and Esc leave the doc untouched', async ({ page }) => {
    await open(page);
    await dropFixture(page);
    await page.click('#dc-cancel');
    await expect(page.locator('#drop-choice')).not.toBeVisible();
    await dropFixture(page);
    await expect(page.locator('#drop-choice')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#drop-choice')).not.toBeVisible();
    // Give a wrongly-wired load time to land before asserting it didn't.
    await page.waitForTimeout(500);
    expect(await pageCount(page)).toBe(2);
  });
});

test.describe('File > Buka Baru', () => {
  test('a clean doc goes straight to the picker', async ({ page }) => {
    await open(page);
    await page.click('#btn-file');
    await page.click('#fm-new');
    await expect(page.locator('#new-confirm')).not.toBeVisible();
  });

  test('with edits it asks; Batal keeps them, Buka Baru proceeds', async ({ page }) => {
    await open(page);
    await addText(page, 'Satu');
    await page.click('#btn-file');
    await page.click('#fm-new');
    await expect(page.locator('#new-confirm')).toBeVisible();
    await page.click('#nc-cancel');
    await expect(page.locator('#new-confirm')).not.toBeVisible();
    await expect(page.locator('.pv-anno-text')).toHaveCount(1);

    await page.click('#btn-file');
    await page.click('#fm-new');
    await page.click('#nc-go');
    await page.setInputFiles('#file-input', FIXTURE);
    await expectFirstPage(page);
    await expect(page.locator('.pv-anno-text')).toHaveCount(0);
    expect(await page.evaluate(() => window.v2.history.undoStack.length)).toBe(0);
  });

  test('Buka Baru with a file we cannot open refuses and keeps the doc and its edits', async ({ page }) => {
    await open(page);
    await addText(page, 'Satu');
    await page.click('#btn-file');
    await page.click('#fm-new');
    await page.click('#nc-go');
    await page.setInputFiles('#file-input', { name: 'surat.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('x') });
    await page.waitForTimeout(500);
    expect(await pageCount(page)).toBe(2);
    await expect(page.locator('.pv-anno-text')).toHaveCount(1);
    await expect(page.locator('body')).not.toHaveClass(/is-empty/);
  });
});
