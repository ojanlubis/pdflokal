/*
 * PDFLokal — drop an OS file onto the sidebar thumbnail list to APPEND pages.
 *
 * Wave 1: previously a file dropped on the sidebar was eaten by the reorder
 * handler, and a file dropped on the canvas REPLACES the doc (workspace dropzone).
 * Now dropping on #ue-thumbnails appends — the obvious "add these to my doc" intent.
 *
 * Critical: #ue-thumbnails is inside #unified-editor-workspace, whose drop handler
 * replaces the file. The sidebar handler must stopPropagation so append doesn't
 * turn into replace. This test proves 2 pages + a 1-page drop = 3 (not 1).
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

// Dispatch a synthetic OS file drop of the given URL onto #ue-thumbnails.
async function dropFileOnSidebar(page, url, { dragOverOnly = false } = {}) {
  return page.evaluate(async ({ u, dragOverOnly }) => {
    const res = await fetch(u);
    const buf = await res.arrayBuffer();
    const file = new File([buf], 'dropped.pdf', { type: 'application/pdf' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const container = document.getElementById('ue-thumbnails');
    container.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    if (dragOverOnly) return container.classList.contains('drag-over-files');
    container.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    return null;
  }, { u: url, dragOverOnly });
}

test.describe('Sidebar drop-to-append', () => {
  test('dropping a PDF on the sidebar appends its pages (does not replace)', async ({ page }) => {
    await loadEditor(page);
    expect(await page.evaluate(() => window.ueState.pages.length)).toBe(2);

    await dropFileOnSidebar(page, '/tests/fixtures/sample-2pages.pdf');

    // 2 existing + 2 dropped = 4. If stopPropagation failed, the workspace dropzone
    // would have replaced the doc and length would be 2 (or the drop would no-op).
    await page.waitForFunction(() => window.ueState?.pages?.length === 4, null, { timeout: 10_000 });
    expect(await page.evaluate(() => window.ueState.sourceFiles.length)).toBe(2);
  });

  test('dragging a file over the sidebar shows the drop-target hint', async ({ page }) => {
    await loadEditor(page);
    const hasHint = await dropFileOnSidebar(page, '/tests/fixtures/sample-2pages.pdf', { dragOverOnly: true });
    expect(hasHint).toBe(true);
  });
});
