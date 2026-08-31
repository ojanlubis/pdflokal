/*
 * Playwright smoke + regression suite for PDFLokal.
 * Chromium-only — manual Safari/Firefox spot-checks happen pre-release.
 * Spinning up `npx serve` matches local dev exactly (zero build step).
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = 5050;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests',
  // tests/core/ is the HEADLESS domain core suite — it runs under `node --test`
  // (npm run test:core), not Playwright. Keep the browser runner out of it.
  testIgnore: 'core/**',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',

    // WHY: the suite must never depend on the public internet being reachable.
    // index.html loads two gtag.js tags from www.googletagmanager.com. Those are
    // subresources, so the `load` event — which page.goto() waits for — cannot
    // fire until they settle. On a machine that cannot reach Google (a sandboxed
    // CI container, an offline laptop, a blocked network) they do not fail fast:
    // they HANG, and every page.goto() silently costs ~12.5s instead of ~0.2s.
    // A test that loads a page three or four times then blows the 30s timeout,
    // and it surfaces as "page.goto timeout" — which reads like a product bug
    // and is not one. Measured here: 12,500ms -> ~200ms per page load.
    //
    // All three flags are load-bearing, in this order:
    //   proxy-server=direct:// + proxy-bypass-list=*  Chromium otherwise inherits
    //     HTTPS_PROXY/https_proxy from the environment and sends external requests
    //     to that proxy. When it is the one that stalls, host-resolver-rules never
    //     even runs — the browser is not resolving the name, the proxy is. This
    //     pair is what actually collapsed the 12.5s; the DNS rule alone did NOT.
    //   host-resolver-rules=MAP * ~NOTFOUND EXCLUDE localhost  makes the lookup
    //     fail instantly on a machine that DOES have working DNS, so the suite
    //     behaves identically online and offline.
    //
    // Net effect: the browser under test can reach localhost and nothing else —
    // the right property for a 100%-client-side product. A test that reaches
    // outward now fails loudly instead of hanging. No test asserts gtag/GA4
    // behaviour (verified by grep), so this costs no coverage.
    launchOptions: {
      args: [
        '--proxy-server=direct://',
        '--proxy-bypass-list=*',
        '--host-resolver-rules=MAP * ~NOTFOUND EXCLUDE localhost',
      ],
    },
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      // tests/mobile/ runs under the mobile-chrome project only
      testIgnore: ['mobile/**'],
    },
    {
      // Real touch events + mobile viewport + DPR ~2.6. Catches the
      // layout/touch-logic bug class without a physical phone. The GPU/
      // compositor class still needs the Android emulator or a real device.
      name: 'mobile-chrome',
      use: { ...devices['Pixel 7'] },
      testMatch: 'mobile/**/*.spec.js',
    },
  ],

  webServer: {
    command: `npx serve -p ${PORT} --no-clipboard --no-port-switching .`,
    url: BASE_URL,
    timeout: 60_000,
    // A targeted local run may intentionally share the developer's server.
    // The gate is different: its verdict must bind to a server whose lifetime
    // it owns, so qa-gate.mjs disables reuse through this explicit wire.
    reuseExistingServer: !process.env.CI && !process.env.PDFLOKAL_GATE_OWNS_SERVER,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
