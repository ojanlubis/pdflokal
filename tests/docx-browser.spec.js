/*
 * PDF -> .docx, the BROWSER SHELL, in real Chromium (js/docx/client.js + worker.js + stream.js,
 * driven through the dev-only page /lab-docx.html). The conversion engine itself is covered in
 * node by tests/core/docx-*.test.mjs; this file is what node cannot say:
 *
 *   - the converter RUNS IN A WEB WORKER, and the page stays alive while it does;
 *   - the .docx it produces really is a zip of well-formed XML holding the PDF's words;
 *   - cancel kills the work at once and leaves no document behind;
 *   - the size/page caps stop a run with their own error code;
 *   - the same all works under the REAL production CSP (served by the demo rig, not by `serve`,
 *     which sends no headers: see tests/csp-live-policy.spec.js for why that distinction matters);
 *   - NOTHING of it loads on a normal page: not by a byte.
 *
 * Fixtures are the repo's own (tests/fixtures); the 104-file corpus is outside the served root and
 * is the gate's job (scripts/docx-gate.mjs).
 */
import { test, expect } from '@playwright/test';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE = '/tests/fixtures/sample-2pages.pdf';
const LOREM = '/tests/fixtures/nasty/lorem-full.pdf';
const SCAN = '/tests/fixtures/nasty/scan-bersih.pdf';
const BIG = '/tests/fixtures/bigdoc-120.pdf';

const openLab = async (page, base = '') => {
  await page.goto(`${base}/lab-docx.html`);
  await page.waitForFunction(() => !!window.labDocx);
};

test.describe('PDF to Word shell: worker, cancel, caps', () => {
  test('converts in a worker; the .docx is a clean zip holding the words of both pages', async ({ page }) => {
    await openLab(page);
    const r = await page.evaluate(async (url) => {
      const seen = [];
      const out = await window.labDocx.convertUrl(url, { mode: 'worker', onProgress: (d, t) => seen.push([d, t]) });
      return { ...out, seen };
    }, SAMPLE);
    expect(r.mode).toBe('worker');
    expect(r.inspect.problems).toEqual([]);
    expect(r.inspect.entries[0]).toBe('[Content_Types].xml');
    for (const part of ['word/document.xml', 'word/styles.xml', 'word/numbering.xml', '_rels/.rels', 'word/_rels/document.xml.rels']) expect(r.inspect.entries).toContain(part);
    expect(r.inspect.text).toContain('Test Page 1');
    expect(r.inspect.text).toContain('Test Page 2');
    expect(r.seen).toEqual([[1, 2], [2, 2]]); // a progress call per page, in order
    expect(r.writer.pages).toBe(2);
    expect(r.stats.errors).toEqual([]);
    expect(r.size).toBeGreaterThan(1000);
  });

  test('the main-thread fallback gives the same words (an engine that cannot start the worker still converts)', async ({ page }) => {
    await openLab(page);
    const [w, m] = await page.evaluate(async (url) => {
      const a = await window.labDocx.convertUrl(url, { mode: 'worker' });
      const b = await window.labDocx.convertUrl(url, { mode: 'main' });
      return [a, b];
    }, LOREM);
    expect(m.mode).toBe('main');
    expect(m.inspect.problems).toEqual([]);
    expect(m.inspect.text).toContain('CONTOH DOKUMEN LOREM');
    expect(m.inspect.text).toBe(w.inspect.text);
  });

  test('a worker that cannot start falls back to the main thread by itself', async ({ page }) => {
    await page.route('**/js/docx/worker.js', (route) => route.fulfill({ status: 404, body: 'gone' }));
    await openLab(page);
    const r = await page.evaluate(async (url) => {
      const modes = [];
      const out = await window.labDocx.convertUrl(url, { onMode: (m) => modes.push(m) });
      return { mode: out.mode, modes, text: out.inspect.text };
    }, SAMPLE);
    expect(r.mode).toBe('main');
    expect(r.modes).toEqual(['worker', 'main']);
    expect(r.text).toContain('Test Page 2');
  });

  test('pictures survive the worker: the scan comes out with a JPEG made by the canvas, not a PNG', async ({ page }) => {
    await openLab(page);
    const r = await page.evaluate((url) => window.labDocx.convertUrl(url, { mode: 'worker' }), SCAN);
    expect(r.inspect.problems).toEqual([]);
    expect(r.inspect.media).toBeGreaterThan(0);
    expect(r.inspect.entries.some((n) => /^word\/media\/image\d+\.jpeg$/.test(n))).toBe(true);
    expect(r.stats.imagesFailed).toBe(0);
  });

  test('the page stays alive while a 120-page document converts in the worker', async ({ page }) => {
    test.setTimeout(90_000);
    await openLab(page);
    const r = await page.evaluate(async (url) => {
      const buf = await (await fetch(url)).arrayBuffer();
      let last = performance.now(); let worst = 0; let ticks = 0;
      const beat = setInterval(() => { const n = performance.now(); worst = Math.max(worst, n - last); last = n; ticks += 1; }, 10);
      const t0 = performance.now();
      const out = await window.labDocx.convert(buf, { mode: 'worker' });
      const ms = performance.now() - t0;
      clearInterval(beat);
      return { ms, worst, ticks, pages: out.writer.pages };
    }, BIG);
    expect(r.pages).toBe(120);
    expect(r.ticks).toBeGreaterThan(10); // the page kept running its own timers the whole time
    expect(r.worst).toBeLessThan(400); // and never went away for as long as the conversion takes
  });

  test('cancel: aborting stops the worker, rejects with AbortError and delivers no document', async ({ page }) => {
    test.setTimeout(90_000);
    await openLab(page);
    const r = await page.evaluate(async (url) => {
      const buf = await (await fetch(url)).arrayBuffer();
      const ctl = new AbortController();
      let doneAt = 0; let aborted = 0; let progressAfter = 0;
      const t0 = performance.now();
      let outcome;
      try {
        await window.labDocx.convert(buf, { mode: 'worker', signal: ctl.signal, onProgress: (d) => { if (aborted) progressAfter += 1; if (d === 3 && !aborted) { aborted = performance.now(); ctl.abort(); } } });
        outcome = 'finished';
      } catch (e) { outcome = e.name; doneAt = performance.now(); }
      // wait: a killed worker must not keep reporting
      await new Promise((res) => setTimeout(res, 500));
      return { outcome, rejectMs: doneAt - aborted, progressAfter, total: doneAt - t0 };
    }, BIG);
    expect(r.outcome).toBe('AbortError');
    expect(r.rejectMs).toBeLessThan(250); // at once: not "after the current page", not "after the batch"
    expect(r.progressAfter).toBe(0);
  });

  test('an already-aborted signal never starts a worker', async ({ page }) => {
    await openLab(page);
    const r = await page.evaluate(async (url) => {
      const buf = await (await fetch(url)).arrayBuffer();
      const ctl = new AbortController(); ctl.abort();
      let workers = 0;
      const W = window.Worker;
      window.Worker = function Spy(...a) { workers += 1; return new W(...a); };
      let name = null;
      try { await window.labDocx.convert(buf, { signal: ctl.signal }); } catch (e) { name = e.name; }
      window.Worker = W;
      return { name, workers };
    }, SAMPLE);
    expect(r).toEqual({ name: 'AbortError', workers: 0 });
  });

  test('caps: too many pages and too large a file each stop the run with their own code, before any document', async ({ page }) => {
    await openLab(page);
    const r = await page.evaluate(async (url) => {
      const buf = await (await fetch(url)).arrayBuffer();
      const code = async (limits) => { try { await window.labDocx.convert(buf, { mode: 'worker', limits }); return 'ok'; } catch (e) { return `${e.name}:${e.code}:${JSON.stringify(e.detail || {})}`; } };
      return { pages: await code({ maxPages: 1 }), input: await code({ maxInputBytes: 100 }), output: await code({ maxOutputBytes: 100 }), fine: await code({ maxPages: 2 }) };
    }, SAMPLE);
    expect(r.pages).toBe('LimitError:too-many-pages:{"pages":2,"max":1}');
    expect(r.input).toMatch(/^LimitError:input-too-large:/);
    expect(r.output).toMatch(/^LimitError:output-too-large:/);
    expect(r.fine).toBe('ok');
  });

  test('the dev page works end to end by hand: pick a file, convert, progress, save link', async ({ page }) => {
    await openLab(page);
    await page.setInputFiles('#file', path.join(ROOT, 'tests/fixtures/sample-2pages.pdf'));
    await expect(page.locator('#go')).toBeEnabled();
    await page.click('#go');
    await expect(page.locator('#status')).toContainText('selesai', { timeout: 20_000 });
    await expect(page.locator('#save')).toBeVisible();
    expect(await page.locator('#save').getAttribute('href')).toMatch(/^blob:/);
    expect(await page.locator('#bar').getAttribute('value')).toBe('2');
  });
});

// ---- nothing loads until someone converts -------------------------------------------------------
test.describe('PDF to Word shell: costs a normal page nothing', () => {
  for (const url of ['/', '/en', '/edit-pdf.html', '/gabung-pdf.html']) {
    test(`${url} requests nothing from js/docx or the lab page`, async ({ page }) => {
      const seen = [];
      page.on('request', (req) => { seen.push(req.url()); });
      await page.goto(url);
      await page.waitForLoadState('networkidle');
      expect(seen.filter((u) => /\/js\/docx\/|lab-docx/.test(u))).toEqual([]);
    });
  }

  test('no page of the product links the lab page, the service worker does not precache it, the sitemap does not list it', async () => {
    const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
    expect(read('sw.js')).not.toMatch(/docx|lab-docx/);
    expect(read('sitemap.xml')).not.toMatch(/lab-docx/);
    const pages = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html') && f !== 'lab-docx.html');
    for (const f of pages) expect(read(f), f).not.toMatch(/lab-docx|js\/docx\//);
    expect(read('lab-docx.html')).toMatch(/<meta name="robots" content="noindex/);
  });
});

// ---- under the real production CSP --------------------------------------------------------------
test.describe('PDF to Word shell under the production CSP', () => {
  const PORT = 5058;
  const ORIGIN = `http://localhost:${PORT}`;
  let rig = null;
  test.beforeAll(async () => {
    rig = spawn('node', [path.join(ROOT, 'scripts/ocr-demo.mjs')], { cwd: ROOT, stdio: 'ignore', detached: true, env: { ...process.env, OCR_DEMO_PORT: String(PORT) } });
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      try { if ((await fetch(`${ORIGIN}/`)).ok) return; } catch { /* not up yet */ }
    }
    throw new Error('the CSP rig never came up');
  });
  test.afterAll(() => { if (rig) { try { process.kill(-rig.pid, 'SIGTERM'); } catch { /* gone */ } } });

  test('worker, nested pdf.js worker, dynamic import and canvas encode all run; nothing is blocked', async ({ page }) => {
    const blocked = [];
    page.on('console', (m) => { if (/Content Security Policy|violates/i.test(m.text())) blocked.push(m.text()); });
    await openLab(page, ORIGIN);
    // the rig really serves the policy (a guard: without it this test proves nothing)
    const csp = await page.evaluate(async () => (await fetch('/lab-docx.html')).headers.get('content-security-policy'));
    expect(csp).toContain("worker-src 'self' blob:");
    const r = await page.evaluate(async ([a, b]) => {
      const t = await window.labDocx.convertUrl(a, { mode: 'worker' });
      const s = await window.labDocx.convertUrl(b, { mode: 'worker' });
      return { mode: t.mode, text: t.inspect.text, problems: t.inspect.problems, media: s.inspect.media };
    }, [SAMPLE, SCAN]);
    expect(r.mode).toBe('worker');
    expect(r.problems).toEqual([]);
    expect(r.text).toContain('Test Page 2');
    expect(r.media).toBeGreaterThan(0);
    expect(blocked).toEqual([]);
  });
});
