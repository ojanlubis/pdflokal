/*
 * PDFLokal smoke + regression suite.
 *
 * Each `regression:` test maps to a real production bug fix. If one of these
 * goes red, the underlying class of bug has come back.
 *
 *   - regression #1 — Escape in inline editor used to bubble to the global
 *     Escape handler and kick the user back to the homepage.
 *   - regression #2 — A failed font fetch was re-attempted once per
 *     annotation; embedding 4 Montserrat annotations meant 4 round-trips.
 *   - regression #3 — Annotations on rotated pages exported at wrong
 *     coordinates (pdf-lib setRotation is metadata-only).
 */
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PDF = path.join(__dirname, 'fixtures', 'sample-2pages.pdf');

// WHY: The dropzone is a button; the real file input is `#file-input` (hidden
// behind it). Setting it directly is far more reliable than simulating the
// native file picker, which Playwright can't drive headless.
async function loadSamplePdf(page) {
  await page.setInputFiles('#file-input', SAMPLE_PDF);
  await page.waitForFunction(() => document.body.classList.contains('editor-active'));
  await page.waitForSelector('.ue-page-slot canvas', { state: 'attached' });
  await page.waitForFunction(() => window.ueState?.pages?.length === 2);
  await page.waitForFunction(() => window.state?.currentTool === 'unified-editor');
  // WHY: Canvas event listeners are wired by ueSetupCanvasEvents() which is
  // invoked from the page renderer's first successful render — NOT from
  // editor init. Without this wait, clicks on the canvas hit a listener-less
  // container and the text/whiteout tools silently no-op.
  await page.waitForFunction(() => window.ueState?.eventsSetup === true);
}

async function getPageCanvasBox(page, pageIndex) {
  const handle = page.locator('.ue-page-slot canvas').nth(pageIndex);
  await handle.waitFor({ state: 'visible' });
  return await handle.boundingBox();
}

// WHY: Adds a text annotation via the canonical text-tool → inline-edit → Enter
// flow that ships in PR2 (UX audit H1/H2). To pick a non-default fontFamily,
// poke lastTextOptions before clicking — that's the same lever the user gets,
// since with inline editing the modal isn't part of first creation anymore.
async function addTextAnnotation(page, pageIndex, { x, y, text, fontFamily }) {
  if (fontFamily) {
    await page.evaluate((ff) => { window.ueState.lastTextOptions.fontFamily = ff; }, fontFamily);
  }
  // WHY: Dispatch the mousedown/mouseup pair directly on the canvas and call
  // ueSetTool via the window bridge — both bypass focus/scroll quirks that
  // make page.mouse.click + page.keyboard.press unreliable for a tall canvas
  // with a sticky overlay toolbar.
  await page.evaluate(() => window.ueSetTool('text'));
  await page.waitForFunction(() => window.ueState?.currentTool === 'text');
  await page.evaluate(({ p, cx, cy }) => {
    const canvas = document.querySelectorAll('.ue-page-slot canvas')[p];
    const rect = canvas.getBoundingClientRect();
    const sx = rect.left + cx;
    const sy = rect.top + cy;
    const opts = { bubbles: true, cancelable: true, clientX: sx, clientY: sy, button: 0 };
    canvas.dispatchEvent(new MouseEvent('mousedown', opts));
    canvas.dispatchEvent(new MouseEvent('mouseup', opts));
  }, { p: pageIndex, cx: x, cy: y });
  await page.waitForSelector('#inline-text-editor');
  await page.locator('#inline-text-editor').focus();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await page.waitForSelector('#inline-text-editor', { state: 'detached' });
}

// WHY: Same reasoning as addTextAnnotation — dispatch events directly so we
// don't fight the sticky toolbar or the tall-canvas scrolling problem.
// Text annotations have no width property — bounds come from text metrics,
// so we measure inline before computing the click point.
async function dispatchDoubleClickOnAnnotation(page, pageIndex, annoIndex) {
  await page.evaluate(({ p, a }) => {
    const anno = window.ueState.annotations[p][a];
    const canvas = document.querySelectorAll('.ue-page-slot canvas')[p];
    const ctx = canvas.getContext('2d');
    // Approximate bounds the same way getTextBounds does it
    ctx.font = window.buildCanvasFont ? window.buildCanvasFont(anno) : `${anno.fontSize}px sans-serif`;
    const lines = (anno.text ?? '').split('\n');
    const width = anno.width ?? Math.max(...lines.map((line) => ctx.measureText(line).width));
    const height = anno.height ?? (anno.fontSize * lines.length * 1.2);
    const topY = anno.type === 'text' ? anno.y - anno.fontSize : anno.y;
    const rect = canvas.getBoundingClientRect();
    const scale = canvas.clientWidth / (canvas.width / window.ueState.devicePixelRatio);
    const sx = rect.left + (anno.x + width / 2) * scale;
    const sy = rect.top + (topY + height / 2) * scale;
    const opts = { bubbles: true, cancelable: true, clientX: sx, clientY: sy, button: 0 };
    canvas.dispatchEvent(new MouseEvent('mousedown', opts));
    canvas.dispatchEvent(new MouseEvent('mouseup', opts));
    canvas.dispatchEvent(new MouseEvent('mousedown', opts));
    canvas.dispatchEvent(new MouseEvent('mouseup', opts));
    canvas.dispatchEvent(new MouseEvent('dblclick', opts));
  }, { p: pageIndex, a: annoIndex });
}

// WHY: Only JS exceptions and page errors should fail tests. Console errors
// from missing favicons / analytics 404s are noise unrelated to app health.
function watchForJsErrors(page) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (/Failed to load resource/i.test(text)) return; // network noise
    errors.push(text);
  });
  return errors;
}

test.describe('smoke', () => {
  test('homepage loads with no JS errors', async ({ page }) => {
    const errors = watchForJsErrors(page);
    await page.goto('/');
    await expect(page.locator('#main-dropzone')).toBeVisible();
    await expect(page).toHaveTitle(/PDFLokal/);
    expect(errors).toEqual([]);
  });

  test('Sentry SDK loads with no CSP violations and is disabled off-prod', async ({ page }) => {
    // Capture CSP violations before any script runs
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => {
        window.__cspViolations = window.__cspViolations || [];
        window.__cspViolations.push({
          directive: e.violatedDirective,
          blockedURI: e.blockedURI,
        });
      });
    });
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const info = await page.evaluate(() => ({
      sentryGlobal: typeof window.Sentry,
      clientExists: !!window.Sentry?.getClient(),
      enabled: !!window.Sentry?.getClient()?.getOptions()?.enabled,
      release: window.Sentry?.getClient()?.getOptions()?.release,
      tunnel: window.Sentry?.getClient()?.getOptions()?.tunnel,
      cspViolations: window.__cspViolations || [],
    }));

    expect(info.sentryGlobal).toBe('object');
    expect(info.clientExists).toBe(true);
    // Off-prod (localhost / preview deploys) must stay silent — DSN exposed
    // but no events sent. Prod-only enable is the privacy promise.
    expect(info.enabled).toBe(false);
    expect(typeof info.release).toBe('string');
    expect(info.release.length).toBeGreaterThan(0);
    // Tunnel must be configured so ad blockers can't drop events.
    expect(info.tunnel).toBe('/api/sentry-tunnel');
    expect(info.cspViolations).toEqual([]);
  });

  test('dropping a PDF opens editor and renders all pages', async ({ page }) => {
    await page.goto('/');
    await loadSamplePdf(page);
    await expect(page.locator('#ue-pages-container')).toBeVisible();
    const canvases = await page.locator('.ue-page-slot canvas').count();
    expect(canvases).toBe(2);
  });

  test('export download produces a non-empty PDF', async ({ page }) => {
    await page.goto('/');
    await loadSamplePdf(page);

    const downloadPromise = page.waitForEvent('download');
    await page.locator('#ue-download-btn').click();
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);

    expect(bytes.length).toBeGreaterThan(500);
    expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
  });
});

// WHY: Shared by both inline-editor tests — opens the editor on annotation 0,
// replaces the existing text, then exits via the given key (Enter or Escape).
async function reopenAnnotationAndType(page, replacement, exitKey) {
  await page.keyboard.press('v');
  await dispatchDoubleClickOnAnnotation(page, 0, 0);
  await page.waitForSelector('#inline-text-editor', { state: 'visible' });
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(replacement);
  await page.keyboard.press(exitKey);
  await page.waitForSelector('#inline-text-editor', { state: 'detached' });
}

test.describe('inline text editor', () => {
  test('regression #1: Escape cancels edit without kicking user home', async ({ page }) => {
    await page.goto('/');
    await loadSamplePdf(page);
    await addTextAnnotation(page, 0, { x: 100, y: 100, text: 'original' });
    await reopenAnnotationAndType(page, 'changed', 'Escape');

    // Bug #1 invariant: user stays in editor — NOT kicked back to homepage
    await expect(page.locator('body')).toHaveClass(/editor-active/);
    // Bug #1 invariant: text was NOT mutated
    const text = await page.evaluate(() => window.ueState.annotations[0][0].text);
    expect(text).toBe('original');
  });

  test('Enter saves edit and updates annotation text', async ({ page }) => {
    await page.goto('/');
    await loadSamplePdf(page);
    await addTextAnnotation(page, 0, { x: 100, y: 100, text: 'before' });
    await reopenAnnotationAndType(page, 'after', 'Enter');

    const text = await page.evaluate(() => window.ueState.annotations[0][0].text);
    expect(text).toBe('after');
  });
});

test.describe('escape cascade', () => {
  // WHY: Companion to regression #1 but for the OTHER escape path. Before this
  // fix, Escape from any modal/dropdown that wasn't `shortcuts-modal` fell
  // through to showHome() and wiped the user's annotations. Documented in
  // memory/ux-audit-2026-05-30.md (finding C1).
  test('regression: Escape from signature modal closes only the modal', async ({ page }) => {
    await page.goto('/');
    await loadSamplePdf(page);
    await addTextAnnotation(page, 0, { x: 100, y: 100, text: 'do-not-lose' });

    await page.evaluate(() => window.ueOpenSignatureModal());
    await page.waitForFunction(() => document.getElementById('signature-modal')?.classList.contains('active'));

    await page.keyboard.press('Escape');

    await page.waitForFunction(() => !document.getElementById('signature-modal')?.classList.contains('active'));
    await expect(page.locator('body')).toHaveClass(/editor-active/);
    const text = await page.evaluate(() => window.ueState.annotations[0][0]?.text);
    expect(text).toBe('do-not-lose');
  });

  test('regression: Escape from Lainnya dropdown closes only the dropdown', async ({ page }) => {
    await page.goto('/');
    await loadSamplePdf(page);
    await addTextAnnotation(page, 0, { x: 100, y: 100, text: 'still-here' });

    await page.locator('#ft-more-btn').click();
    await page.waitForFunction(() => document.getElementById('ft-more-dropdown')?.classList.contains('active'));

    await page.keyboard.press('Escape');

    await page.waitForFunction(() => !document.getElementById('ft-more-dropdown')?.classList.contains('active'));
    await expect(page.locator('body')).toHaveClass(/editor-active/);
    const text = await page.evaluate(() => window.ueState.annotations[0][0]?.text);
    expect(text).toBe('still-here');
  });

  test('Escape with no overlay open still exits editor', async ({ page }) => {
    await page.goto('/');
    await loadSamplePdf(page);

    await page.keyboard.press('Escape');

    await expect(page.locator('body')).not.toHaveClass(/editor-active/);
  });
});

test.describe('inline text on first creation', () => {
  // UX audit H1/H2 — first creation goes straight into the inline editor with
  // last-used formatting, no modal in between.
  test('Escape on empty new annotation removes the orphan', async ({ page }) => {
    await page.goto('/');
    await loadSamplePdf(page);

    await page.evaluate(() => window.ueSetTool('text'));
    await page.evaluate(() => {
      const canvas = document.querySelector('.ue-page-slot canvas');
      const rect = canvas.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, clientX: rect.left + 100, clientY: rect.top + 100, button: 0 };
      canvas.dispatchEvent(new MouseEvent('mousedown', opts));
      canvas.dispatchEvent(new MouseEvent('mouseup', opts));
    });
    await page.waitForSelector('#inline-text-editor');

    // Annotation must exist while editing
    expect(await page.evaluate(() => window.ueState.annotations[0]?.length)).toBe(1);

    await page.locator('#inline-text-editor').focus();
    await page.keyboard.press('Escape');
    await page.waitForSelector('#inline-text-editor', { state: 'detached' });

    // Orphan must be gone after cancel
    expect(await page.evaluate(() => window.ueState.annotations[0]?.length || 0)).toBe(0);
    await expect(page.locator('body')).toHaveClass(/editor-active/);
  });

  test('successful save updates lastTextOptions for the next annotation', async ({ page }) => {
    await page.goto('/');
    await loadSamplePdf(page);
    await page.evaluate(() => { window.ueState.lastTextOptions.fontFamily = 'Carlito'; });
    await addTextAnnotation(page, 0, { x: 80, y: 80, text: 'first' });

    // The created annotation must reflect the lastTextOptions we forced
    const first = await page.evaluate(() => window.ueState.annotations[0][0]);
    expect(first.fontFamily).toBe('Carlito');

    // And lastTextOptions is now sticky for the next click — verified by
    // creating a second annotation without specifying fontFamily.
    await addTextAnnotation(page, 0, { x: 80, y: 160, text: 'second' });
    const second = await page.evaluate(() => window.ueState.annotations[0][1]);
    expect(second.fontFamily).toBe('Carlito');
  });
});

test.describe('signature modal', () => {
  // UX audit H4 — Gambar (draw) is the default tab. Without this, opening
  // the signature modal on mobile (where finger-draw is the primary intent)
  // showed Upload Foto first and added an extra tap for the common case.
  test('opens with Gambar (draw) tab active', async ({ page }) => {
    await page.goto('/');
    await loadSamplePdf(page);
    await page.evaluate(() => window.ueOpenSignatureModal());
    await page.waitForFunction(() => document.getElementById('signature-modal')?.classList.contains('active'));

    const activeTab = await page.evaluate(() => {
      const tabs = document.querySelectorAll('#signature-modal button[role="tab"]');
      return Array.from(tabs).find(t => t.getAttribute('aria-selected') === 'true')?.textContent?.trim();
    });
    expect(activeTab).toBe('Gambar');
  });
});

test.describe('paraf modal', () => {
  // UX audit H7 — "Tempel di semua halaman" checkbox in the paraf modal lets
  // Pak Hadi paraf a 20-page deed in one click. Before, the apply-to-all
  // button only surfaced after placing one and selecting it.
  test('checked + place clones paraf onto every page', async ({ page }) => {
    await page.goto('/');
    await loadSamplePdf(page);

    // Prepare a paraf image without actually drawing on the canvas
    await page.evaluate(() => {
      // Stub a 1×1 PNG as the paraf image to skip the SignaturePad/canvas path
      window.state.signatureImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=';
      window.ueState.pendingSignature = true;
      window.ueState.pendingSignatureWidth = window.ueState.pendingSignatureWidth || 80;
      window.ueState.pendingSubtype = 'paraf';
      window.ueState.pendingApplyToAllPages = true; // the audit-finding behavior
      window.ueSetTool('paraf');
    });

    // Place once at page 0
    await page.evaluate(async () => {
      const canvas = document.querySelectorAll('.ue-page-slot canvas')[0];
      const rect = canvas.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, clientX: rect.left + 60, clientY: rect.top + 60, button: 0 };
      canvas.dispatchEvent(new MouseEvent('mousedown', opts));
      canvas.dispatchEvent(new MouseEvent('mouseup', opts));
      // wait for the async signature image load + place
      await new Promise(r => setTimeout(r, 300));
    });

    await page.waitForFunction(() =>
      (window.ueState.annotations[0] || []).some(a => a.subtype === 'paraf') &&
      (window.ueState.annotations[1] || []).some(a => a.subtype === 'paraf')
    );

    // Both pages now have a paraf
    const counts = await page.evaluate(() => ({
      p0: (window.ueState.annotations[0] || []).filter(a => a.subtype === 'paraf').length,
      p1: (window.ueState.annotations[1] || []).filter(a => a.subtype === 'paraf').length,
      flag: window.ueState.pendingApplyToAllPages,
    }));
    expect(counts.p0).toBe(1);
    expect(counts.p1).toBe(1);
    // Flag must reset after one use so the next paraf isn't silently cloned
    expect(counts.flag).toBe(false);
  });

  test('opening paraf modal resets the apply-all checkbox to unchecked', async ({ page }) => {
    await page.goto('/');
    await loadSamplePdf(page);

    await page.evaluate(() => {
      const cb = document.getElementById('paraf-apply-all');
      if (cb) cb.checked = true; // simulate leftover state from prior open
      window.openParafModal();
    });

    const isChecked = await page.evaluate(() => document.getElementById('paraf-apply-all')?.checked);
    expect(isChecked).toBe(false);
  });
});

test.describe('export pipeline', () => {
  test('regression #2: failed font fetch is NOT retried per annotation', async ({ page }) => {
    // WHY counter is local + reset before download: CSS @font-face also pulls
    // Montserrat woff2 files when the canvas renders Montserrat text, and
    // those hits should not count against the bug's invariant. We only care
    // about embed-time fetches during ueBuildFinalPDF.
    let montserratFetchCount = 0;
    await page.route('**/fonts/montserrat-*.woff2', (route) => {
      montserratFetchCount += 1;
      return route.fulfill({ status: 500, body: 'forced failure' });
    });

    await page.goto('/');
    await loadSamplePdf(page);

    for (let i = 0; i < 4; i += 1) {
      await addTextAnnotation(page, 0, {
        x: 80 + i * 10,
        y: 80 + i * 30,
        text: `M${i}`,
        fontFamily: 'Montserrat',
      });
    }

    montserratFetchCount = 0; // ignore CSS fetches triggered during annotation render
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#ue-download-btn').click();
    await downloadPromise;

    // Bug #2 invariant: failed font is fetched at most once thanks to the
    // negative-cache write after the fallback embed.
    expect(montserratFetchCount).toBeLessThanOrEqual(1);
  });

  test('regression #3: rotated page export succeeds without JS errors', async ({ page }) => {
    const errors = watchForJsErrors(page);
    await page.goto('/');
    await loadSamplePdf(page);

    // Rotate page 0 to 90° via R shortcut
    await page.evaluate(() => window.ueSelectPage(0));
    await page.keyboard.press('r');
    await page.waitForFunction(() => window.ueState.pages[0].rotation === 90);

    await addTextAnnotation(page, 0, { x: 50, y: 50, text: 'R' });

    const downloadPromise = page.waitForEvent('download');
    await page.locator('#ue-download-btn').click();
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);

    expect(bytes.length).toBeGreaterThan(500);
    expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
    expect(errors).toEqual([]);
  });
});
