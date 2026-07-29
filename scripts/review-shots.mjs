#!/usr/bin/env node
/*
 * REVIEW SHOTS — capture every changed surface, named in review order.
 *
 *   node scripts/review-shots.mjs            # -> review-shots/
 *
 * WHY THIS EXISTS AS A SCRIPT rather than a handful of ad-hoc captures: the set
 * has to be reproducible and identically framed each time it is regenerated, or
 * two rounds of review are comparing different things. It also numbers the
 * files, because the order they are looked at IS the review — landing first,
 * then the surfaces that inherit from it, then the editor.
 *
 * ⚠️ IT OWNS ITS SERVER AND REAPS IT IN A `finally`, ON ITS OWN PORT (3101).
 * Two servers left holding a port have starved a gate run in this repo, and a
 * leftover :5055 blocked a review the same week. Anything that binds a port
 * reaps it. It deliberately does NOT use 5050 (the suite's) or 3000 (the human's
 * review server), so this can run while either is up.
 */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import {
  mkdirSync, rmSync, readdirSync, readFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'review-shots');
const PORT = 3101;
const ORIGIN = `http://localhost:${PORT}`;
const FIXTURE = path.join(ROOT, 'tests/fixtures/sample-2pages.pdf');

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

let server = null;

async function waitForServer() {
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { if ((await fetch(`${ORIGIN}/`)).ok) return; } catch { /* not up yet */ }
  }
  throw new Error('the shot server never came up');
}

/*
 * ⚠️ `fullPage: true` IS USELESS ON THIS LANDING AND SILENTLY SO.
 * `#empty` is `position: absolute; inset: 0; overflow-y: auto` — the document
 * body is exactly viewport-height and the page scrolls an inner container. So
 * Playwright's fullPage capture had nothing extra to take and produced a file
 * BYTE-IDENTICAL to the viewport shot: two differently-named images of the same
 * thing, which is precisely the "both crops were the same stale image" trap this
 * repo has already been caught by once.
 *
 * `tall: true` instead measures the scroll container and sizes the VIEWPORT to
 * it, so the whole column really is in one frame. The size assertion at the end
 * of the run is what stops this regressing quietly.
 */
async function shot(browser, name, url, {
  viewport, dark = false, tall = false, prep = null,
}) {
  const ctx = await browser.newContext({
    viewport, colorScheme: dark ? 'dark' : 'light', deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  await page.goto(ORIGIN + url, { waitUntil: 'networkidle' });
  if (prep) await prep(page);

  if (tall) {
    const h = await page.evaluate(() => {
      const el = document.getElementById('empty');
      return el ? el.scrollHeight : document.documentElement.scrollHeight;
    });
    await page.setViewportSize({ width: viewport.width, height: Math.min(h + 40, 8000) });
    await page.waitForTimeout(500);
  }

  // The stamp animates in once (ld-thunk, .5s delay). Capturing under it gives
  // a different image every run, which is the one thing a review set must not do.
  await page.waitForTimeout(1400);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  await ctx.close();
  console.log(`  ✓ ${name}.png`);
}

try {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  server = spawn('npx', ['serve', '-p', String(PORT), '--no-clipboard', '--no-port-switching', '.'], {
    cwd: ROOT, stdio: 'ignore', detached: true,
  });
  await waitForServer();

  const browser = await chromium.launch();
  try {
    await shot(browser, '1-landing-desktop-light', '/', { viewport: DESKTOP });
    await shot(browser, '2-landing-desktop-dark', '/', { viewport: DESKTOP, dark: true });
    await shot(browser, '3-landing-phone-390', '/', { viewport: PHONE });

    // ⭐ THE DECISION SHOT. Not a surface to inspect — a call he is making. The
    // whole body now sits on ONE left edge under a full-width masthead, which is
    // broader than the question actually put to him (the privacy promise alone).
    // Full-page so the single edge is visible from hero to footer at once.
    await shot(browser, '4-landing-ONE-LEFT-EDGE-full', '/', { viewport: DESKTOP, tall: true });

    await shot(browser, '5-seo-page-kompres-pdf', '/kompres-pdf', { viewport: DESKTOP });
    await shot(browser, '6-privasi-light', '/privasi', { viewport: DESKTOP });
    await shot(browser, '7-privasi-dark', '/privasi', { viewport: DESKTOP, dark: true });
    await shot(browser, '8-dukung-dark', '/dukung', { viewport: DESKTOP, dark: true });

    await shot(browser, '9-editor-with-pdf', '/', {
      viewport: DESKTOP,
      prep: async (page) => {
        await page.setInputFiles('#file-input', FIXTURE);
        await page.waitForSelector('#v2-stage img, #v2-stage canvas', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1200);
      },
    });
  } finally {
    await browser.close();
  }

  /*
   * ⚠️ NO TWO SHOTS MAY BE THE SAME IMAGE. This set exists to be looked at, and
   * a duplicate is worse than a missing file: a reviewer sees nine names, nine
   * thumbnails, and believes nine surfaces were checked. The first run of this
   * script produced 1-landing-desktop-light and 4-landing-ONE-LEFT-EDGE-full at
   * byte-identical size, because `fullPage` did nothing on a page whose scroll
   * lives in an inner container. Hashing catches that; counting files does not.
   */
  const seen = new Map();
  for (const f of readdirSync(OUT).sort()) {
    const hash = createHash('sha256').update(readFileSync(path.join(OUT, f))).digest('hex').slice(0, 12);
    if (seen.has(hash)) {
      throw new Error(
        `review-shots: ${f} is byte-identical to ${seen.get(hash)}. Two names, one image — `
        + 'the reviewer would believe both surfaces were captured. Fix the capture, not this check.',
      );
    }
    seen.set(hash, f);
  }
  console.log(`\n  ${seen.size} distinct shots — no duplicates\n  ${OUT}\n`);
} finally {
  // Process GROUP: killing the wrapper orphans the npx child, which then holds
  // the port forever. Learned twice.
  if (server) { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* already gone */ } }
}
