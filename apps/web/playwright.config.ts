import { defineConfig } from '@playwright/test';

/**
 * Real-usage E2E harness for the MONTI attendee web app, run against the PRODUCTION site.
 *
 * Passkeys pin the WebAuthn RP ID to `monti.despell.io` (VITE_RP_ID in the deployed bundle),
 * so localhost cannot be used — the target is the real site. A CDP WebAuthn virtual
 * authenticator (see e2e/fixtures/webauthn.ts) makes `navigator.credentials.create/get`
 * succeed headlessly, which is why the browser must be Chromium.
 *
 * Everything is serial and single-worker: each scenario deploys smart accounts and mints
 * tickets on chain through a shared paymaster, so parallel tests would race the same nonce
 * and the same supply. Fan-out that the scenarios do want (nine users signing up at once) is
 * done inside a single test with several browser contexts, throttled by hand to three.
 */
export default defineConfig({
  testDir: './e2e/tests',
  outputDir: './e2e/.artifacts',
  fullyParallel: false,
  workers: 1,
  // On-chain retries are handled in-code; a Playwright-level retry would double-spend (re-claim,
  // re-create) rather than recover, so there are none.
  retries: 0,
  // A single scenario can sign up nine people and mint nine tickets, each an on-chain user
  // operation that waits for finalisation. The budget is generous on purpose.
  timeout: Number(process.env.E2E_TEST_TIMEOUT_MS ?? 20 * 60 * 1000),
  expect: { timeout: Number(process.env.E2E_EXPECT_TIMEOUT_MS ?? 30_000) },
  reporter: [
    ['list'],
    ['html', { outputFolder: './e2e/.report', open: 'never' }],
    ['json', { outputFile: './e2e/.artifacts/results.json' }],
  ],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'https://monti.despell.io',
    // A phone-sized viewport, iPhone-13-like. isMobile/hasTouch are Chromium-only, which is
    // the browser this harness needs anyway.
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    // No UA spoof: an iPhone UA on a desktop Chromium is a mismatch that tanks the invisible
    // reCAPTCHA score and forces the image challenge. The app detects native through Capacitor,
    // not the UA, so the real headed Chromium UA is both truer and quieter.
    // Headed by default: a headless browser scores low enough that Firebase's invisible
    // reCAPTCHA escalates to a picture challenge no automation may solve. Set E2E_HEADLESS=1
    // to force headless (the WebAuthn virtual authenticator works either way).
    headless: process.env.E2E_HEADLESS === '1',
    launchOptions: {
      args: ['--disable-blink-features=AutomationControlled'],
    },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: Number(process.env.E2E_ACTION_TIMEOUT_MS ?? 30_000),
    navigationTimeout: Number(process.env.E2E_NAV_TIMEOUT_MS ?? 60_000),
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
