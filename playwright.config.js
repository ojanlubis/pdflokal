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
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
