import { expect, type Page } from '@playwright/test';
import { OTP_CODE, type Persona } from '../fixtures/personas';
import { timed } from '../fixtures/timings';

/** Copy strings, verbatim from apps/web/src/shared/copy/ko.ts — the selectors are the words. */
const C = {
  phoneLabel: '휴대폰 번호를 입력해 주세요',
  sendCode: '인증번호 받기',
  codeLabel: '인증번호 6자리를 입력해 주세요',
  verify: '확인',
  registerTitle: '계정 만들기',
  registerCta: '시작하기',
  registerRetry: '다시 시도하기',
  deviceSkip: '이대로 계속하기',
  doneTitle: '준비가 끝났어요',
  nameLabel: '어떻게 불러 드릴까요?',
  doneCta: '시작하기',
  alreadyTitle: '다시 오셨네요', // /login lands here if the number is already registered
} as const;

/** How long the one-tap register chain (passkey → device key → on-chain identity) may take. */
const REGISTER_TIMEOUT_MS = Number(process.env.E2E_REGISTER_TIMEOUT_MS ?? 4 * 60 * 1000);

/**
 * The full first-time signup, exactly as a person does it:
 * phone → SMS code 123456 → 계정 만들기 (one tap: 잠금 + 휴대폰 등록 + 신원 등록) → optional name.
 * The passkey ceremony resolves against the context's WebAuthn virtual authenticator.
 */
export async function signUp(page: Page, persona: Persona): Promise<void> {
  await timed(persona.id, 'signup.phone', async () => {
    await page.goto('/signup/phone');
    await page.getByLabel(C.phoneLabel, { exact: true }).fill(persona.phone);
    await page.getByRole('button', { name: C.sendCode }).click();
    // Firebase phone auth hands us the code screen. The `monti:e2e` flag every persona context
    // sets (see session.ts) swaps the live reCAPTCHA for Firebase's mock verifier on the
    // whitelisted test numbers, so no picture challenge appears and the send is immediate.
    await expect(page).toHaveURL(/\/signup\/verify/, { timeout: 60_000 });
  });

  await timed(persona.id, 'signup.verify', async () => {
    await page.getByLabel(C.codeLabel, { exact: true }).fill(OTP_CODE);
    await page.getByRole('button', { name: C.verify, exact: true }).click();
    // finishSignup writes persons/{id}; the guard then routes to the combined register screen.
    await expect(page).toHaveURL(/\/signup\/register/, { timeout: 60_000 });
  });

  await timed(persona.id, 'signup.register', async () => {
    await runRegister(page);
  });

  await timed(persona.id, 'signup.done', async () => {
    await expect(page.getByRole('heading', { name: C.doneTitle })).toBeVisible({ timeout: 30_000 });
    if (persona.displayName) {
      await page.getByLabel(C.nameLabel, { exact: true }).fill(persona.displayName);
    }
    await page.getByRole('button', { name: C.doneCta, exact: true }).click();
    // Fresh signup lands on 탐색 ('/'); an invited one on the inbox.
    await expect(page).toHaveURL(/(\/|\/tickets\/inbox)$/, { timeout: 30_000 });
  });
}

/**
 * The one-tap register chain, with a bounded retry. It can revert on a busy attester or a slow
 * block, and the screen then turns the button into 다시 시도하기 — pressing it resumes rather
 * than restarts, so a retry is safe and never mints a second passkey.
 */
async function runRegister(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: C.registerTitle })).toBeVisible({ timeout: 30_000 });
  const start = page.getByRole('button', { name: C.registerCta, exact: true });
  const retry = page.getByRole('button', { name: C.registerRetry, exact: true });
  const skip = page.getByRole('button', { name: C.deviceSkip, exact: true });

  await start.click();
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
 * Log a persona back in with the passkey already stored in this context (localStorage
 * `monti.passkey`) and re-added to the virtual authenticator. Used on re-runs so an expensive
 * on-chain signup is not repeated.
 */
export async function login(page: Page, persona: Persona): Promise<boolean> {
  return timed(persona.id, 'login', async () => {
    await page.goto('/login');
    await page.getByRole('button', { name: '로그인', exact: true }).click();
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
