# Android Verification Loop (tier 2)

> **What this solves:** the old workflow's biggest friction — only the founder could
> verify mobile work, on his physical phone. Now the agent can self-verify on
> **real Android Chrome** (real compositor, real GPU raster path, Android keyboard)
> in an emulator, and the founder's phone becomes the *final* gate, not the inner loop.

## The two tiers

| Tier | What | Catches | Cost |
|------|------|---------|------|
| 1 | Playwright `mobile-chrome` project (Pixel 7 descriptor: touch, 412×915, DPR 2.6) | layout, touch-event logic, viewport bugs | free, runs in CI on every PR (`npm run test:mobile`) |
| 2 | Android emulator (AVD) + real Chrome, driven via adb + CDP | compositor/GPU class, Android keyboard, real scrolling physics | local only, needs the emulator running |
| final | Founder's physical phone (low-end reality, real network, real hands) | everything else | founder's time — spend it only on merge gates |

An emulator on an M-series Mac is **not** a Rp1-juta phone: it has the host's GPU and
RAM. Treat tier 2 as "real Chrome, ideal hardware". Memory-pressure behavior still
needs the low-end physical device.

## One-time setup (already done Jul 2026)

Installed via Homebrew + sdkmanager (~10GB total):
- OpenJDK (`brew install openjdk`) — sdkmanager needs it
- `brew install --cask android-commandlinetools`
- SDK packages into `~/Library/Android/sdk`: `platform-tools`, `emulator`,
  `system-images;android-35;google_apis_playstore;arm64-v8a` (Play image = Chrome preinstalled)
- `cmdline-tools;latest` installed INTO the sdk root (the Homebrew copy can't see
  the SDK — it resolves the root from its own path)
- AVD: `pdflokal-test` (Pixel 7, Android 15, arm64 — boots in ~15s on Apple Silicon)

## Daily use

```bash
# 1. boot the emulator (headless; ~15s)
~/Library/Android/sdk/emulator/emulator -avd pdflokal-test -no-window -no-audio -no-boot-anim &

# 2. serve the app
npx serve -p 5050 --no-clipboard .

# 3. drive real Chrome + screenshot (loads the 2-page fixture into editor-v2)
node scripts/android-verify.mjs /editor-v2.html my-check
```

`scripts/android-verify.mjs` does the plumbing every run (idempotent):
- `adb reverse tcp:5050 tcp:5050` — the device's localhost:5050 → the Mac's server
- `adb forward tcp:9222 localabstract:chrome_devtools_remote` — Chrome's DevTools socket
- `chromium.connectOverCDP('http://localhost:9222')` — full Playwright control of the
  REAL Chrome (goto, setInputFiles, locators, screenshots — everything works)

## Gotchas

- **Chrome first-run:** a fresh AVD shows Chrome's welcome + notification prompts once.
  Tap through manually (`adb shell input tap …` after `adb exec-out screencap`) or just
  do it once — the AVD persists state across boots.
- The Play-Store image is **not rootable** (`adb root` fails) — fine, nothing here needs root.
- Docker-Android is a dead end on macOS (no KVM). Don't retry it.
- Emulator screencap: `adb exec-out screencap -p > shot.png` (whole device); the script's
  Playwright screenshot is page-only and usually what you want.
