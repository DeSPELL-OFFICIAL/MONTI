import { expect, type Page } from '@playwright/test';
import { OTP_CODE, type Persona } from '../fixtures/personas';
import { timed } from '../fixtures/timings';
import { shot } from './shots';
import { openStart } from './openStart';

/** `E2E_AUTH_MODE=open`: the target build has no phone sign-in — a person is made by Get started. */
export const OPEN_MODE = process.env.E2E_AUTH_MODE === 'open';

/** Copy strings, verbatim from apps/web/src/shared/copy/en.ts — the selectors are the words. */
const C = {
  phoneLabel: 'Enter your phone number',
  sendCode: 'Send code',
  codeLabel: 'Enter the 6-digit code',
  verify: 'Verify',
  registerTitle: 'Create your account',
  registerCta: 'Start',
  registerRetry: 'Try again',
  deviceSkip: 'Continue anyway',
  doneTitle: 'You are all set',
  nameLabel: 'What should we call you?',
  doneCta: 'Get started',
  alreadyTitle: 'Sign in', // /login lands here if the number is already registered
  // Recover.tsx (recover.* / common.retry) — a returning number on a fresh device lands here.
  recoverTitle: 'Set up again on this phone',
  recoverCta: 'Set up again',
  recoverRetry: 'Try again',
} as const;

/** How long the one-tap register chain (passkey → device key → on-chain identity) may take. */
const REGISTER_TIMEOUT_MS = Number(process.env.E2E_REGISTER_TIMEOUT_MS ?? 4 * 60 * 1000);

/** What `signUp` actually did — a first-time registration, or a recovery of a re-registered number. */
export interface SignupResult {
  /** True when the number was already active on chain and we drove `/recover` instead of register. */
  recovered: boolean;
}

/**
 * The full first-time signup, exactly as a person does it:
 * phone → SMS code 123456 → 계정 만들기 (one tap: 잠금 + 휴대폰 등록 + 신원 등록) → optional name.
 * The passkey ceremony resolves against the context's WebAuthn virtual authenticator.
 *
 * A number whose on-chain identity outlived its Firestore person (a soft-deleted admin that a
 * backend reset could not touch) is already `active`, so Verify sends it to `/recover` rather than
 * `/signup/register` — `getSignupStatus()` tells the two apart. The same SMS flow then re-issues the
 * passkey + device key through `recoverAccess`, so the harness branches on where Verify lands and
 * drives recovery as a user would. `recovered` in the result lets reuse logic record what happened.
 */
export async function signUp(page: Page, persona: Persona): Promise<SignupResult> {
  if (OPEN_MODE) {
    // Open mode: no phone, no OTP, no passkey — one tap on /start makes a fresh person in this context.
    await timed(persona.id, 'signup.open', async () => {
      await openStart(page);
      await page.waitForTimeout(1500);
      await shot(page, `${persona.id}-after-get-started`);
    });
    return { recovered: false };
  }
  await timed(persona.id, 'signup.phone', async () => {
    await page.goto('/signup/phone');
    await page.getByLabel(C.phoneLabel, { exact: true }).fill(persona.phone);
    await shot(page, `${persona.id}-signup-phone`);
    await page.getByRole('button', { name: C.sendCode }).click();
    // Firebase phone auth hands us the code screen. The `monti:e2e` flag every persona context
    // sets (see session.ts) swaps the live reCAPTCHA for Firebase's mock verifier on the
    // whitelisted test numbers, so no picture challenge appears and the send is immediate.
    await expect(page).toHaveURL(/\/signup\/verify/, { timeout: 60_000 });
  });

  const landed = await timed(persona.id, 'signup.verify', async () => {
    await page.getByLabel(C.codeLabel, { exact: true }).fill(OTP_CODE);
    await shot(page, `${persona.id}-signup-verify-code`);
    await page.getByRole('button', { name: C.verify, exact: true }).click();
    // Verify routes a first-time number to the combined register screen, and a number that is
    // already `active` on chain (re-registered: on-chain identity outlived its Firestore person) to
    // `/recover`. Wait for whichever it is — anything else (e.g. a bounce to /login for an
    // already-registered number) throws here with the actual URL in the message.
    await page.waitForURL(/\/signup\/register(\/|$|\?)|\/recover(\/|$|\?)/, { timeout: 60_000 });
    return /\/recover/.test(page.url()) ? 'recover' : 'register';
  });

  if (landed === 'recover') {
    await timed(persona.id, 'signup.recover', async () => {
      await runRecover(page);
    });
    return { recovered: true };
  }

  await timed(persona.id, 'signup.register', async () => {
    await runRegister(page, persona.id);
  });

  await timed(persona.id, 'signup.done', async () => {
    await expect(page.getByRole('heading', { name: C.doneTitle })).toBeVisible({ timeout: 30_000 });
    if (persona.displayName) {
      await page.getByLabel(C.nameLabel, { exact: true }).fill(persona.displayName);
    }
    await shot(page, `${persona.id}-signup-done`);
    await page.getByRole('button', { name: C.doneCta, exact: true }).click();
    // Fresh signup lands on 탐색 ('/'); an invited one on the inbox.
    await expect(page).toHaveURL(/(\/|\/tickets\/inbox)$/, { timeout: 30_000 });
    await page.waitForTimeout(1500);
    await shot(page, `${persona.id}-after-signup-home`);
  });

  return { recovered: false };
}

/**
 * The one-tap register chain, with a bounded retry. It can revert on a busy attester or a slow
 * block, and the screen then turns the button into 다시 시도하기 — pressing it resumes rather
 * than restarts, so a retry is safe and never mints a second passkey.
 */
async function runRegister(page: Page, personaId: string): Promise<void> {
  await expect(page.getByRole('heading', { name: C.registerTitle })).toBeVisible({ timeout: 30_000 });
  const start = page.getByRole('button', { name: C.registerCta, exact: true });
  const retry = page.getByRole('button', { name: C.registerRetry, exact: true });
  const skip = page.getByRole('button', { name: C.deviceSkip, exact: true });

  await shot(page, `${personaId}-signup-register`);
  await start.click();
  await page.waitForTimeout(1200);
  await shot(page, `${personaId}-signup-registering`);
  const deadline = Date.now() + REGISTER_TIMEOUT_MS;
  let attempts = 1;
  while (Date.now() < deadline) {
    // Success: the guard sent us on to the done screen.
    if (/\/signup\/done/.test(page.url())) return;
    // A key store that does not exist at all (private window) — cannot happen on this browser,
    // but if it ever shows, continuing is the only move left and we let the run note it.
    if (await skip.isVisible().catch(() => false)) {
      await skip.click();
      return;
    }
    if (attempts < 4 && (await retry.isVisible().catch(() => false))) {
      attempts += 1;
      await retry.click();
    }
    await page.waitForTimeout(1500);
  }
  await expect(page, 'register chain did not reach /signup/done in time').toHaveURL(/\/signup\/done/);
}

/**
 * Drive the lost-device/recovery screen (Recover.tsx) exactly as a returning person does it: one tap
 * on 새로 설정하기 mints a fresh passkey (resolved against the virtual authenticator) and device key
 * and hands them to `recoverAccess`, which rotates the account's owner on chain, waits for finality
 * and mints a Firebase session — all inside that single call, so it is one `confirming` phase, not a
 * stepper. On success the screen calls `markDeviceHealthy()` and navigates to `/tickets`, so the
 * device-health guard passes and does not bounce the recovered person straight back here.
 *
 * On failure the screen shows the reason and turns the button into 다시 시도; pressing it re-runs the
 * same recovery (a fresh challenge each time), so a bounded retry is safe. A ROTATION_COOLDOWN /
 * RECOVERY_RATE_LIMIT reason is terminal for this run — it never clears within the window — so the
 * throw surfaces the on-screen reason instead of looping silently.
 */
async function runRecover(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: C.recoverTitle })).toBeVisible({ timeout: 30_000 });
  const cta = page.getByRole('button', { name: C.recoverCta, exact: true });
  const retry = page.getByRole('button', { name: C.recoverRetry, exact: true });

  await cta.click();
  const deadline = Date.now() + REGISTER_TIMEOUT_MS;
  let attempts = 1;
  while (Date.now() < deadline) {
    // Success: recoverAccess landed and the screen navigated to 내 티켓.
    if (/\/tickets(\/|$)/.test(page.url())) return;
    // A fresh tab opened straight on /recover with no person to recover is sent to /login; that
    // should not happen here (Verify wrote the personId first), but if it does, stop and say so.
    if (/\/login(\/|$)/.test(page.url())) break;
    if (attempts < 4 && (await retry.isVisible().catch(() => false))) {
      attempts += 1;
      await retry.click();
    }
    await page.waitForTimeout(1500);
  }
  if (/\/tickets(\/|$)/.test(page.url())) return;
  const reason = (await page.locator('[role="alert"], .alert').first().innerText().catch(() => '')) || '(no on-screen reason)';
  throw new Error(`recover did not reach /tickets within the window (url=${page.url()}); screen said: ${reason.trim()}`);
}

/**
 * Log a persona back in with the passkey already stored in this context (localStorage
 * `monti.passkey`) and re-added to the virtual authenticator. Used on re-runs so an expensive
 * on-chain signup is not repeated.
 */
export async function login(page: Page, persona: Persona): Promise<boolean> {
  return timed(persona.id, 'login', async () => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    // Success routes to 내 티켓; failure keeps us on /login with an error.
    try {
      await expect(page).toHaveURL(/\/tickets/, { timeout: 45_000 });
      // signInWithCustomToken persists the session to IndexedDB asynchronously; give that write
      // time to land before the next full reload, or the reload comes up anonymous.
      await page.waitForTimeout(4000);
      return true;
    } catch {
      return false;
    }
  });
}
