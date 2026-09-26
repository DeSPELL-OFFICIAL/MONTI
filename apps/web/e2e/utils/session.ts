import type { Browser, BrowserContext, Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { attachAuthenticator, type CdpCredential, type VirtualAuthenticator } from '../fixtures/webauthn';
import type { Persona } from '../fixtures/personas';
import { login, signUp } from './signup';

const STATE_DIR = 'e2e/.state';
export const BASE_URL = process.env.E2E_BASE_URL ?? 'https://monti.despell.io';

/**
 * Manually-created contexts do not inherit the project's `use`, so every persona context is
 * given the same phone-sized, ko-KR, Seoul-time profile the config's default context has.
 */
const MOBILE = {
  baseURL: BASE_URL,
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  locale: 'ko-KR',
  timezoneId: 'Asia/Seoul',
} as const;

export interface PersonaSession {
  persona: Persona;
  context: BrowserContext;
  page: Page;
  auth: VirtualAuthenticator;
  /** True when a persisted storage state was loaded (a previous run signed this persona up). */
  hasState: boolean;
}

/**
 * Prepare every persona context before its first page load. Two init scripts, run on every
 * document (fresh contexts and the storage-state reuse path alike):
 *
 * 1. The `monti:e2e` opt-in flag. `shared/api/auth.ts` reads it in `verifier()` before building
 *    the RecaptchaVerifier and, when it is `'1'`, sets `appVerificationDisabledForTesting` — the
 *    SDK swaps in a mock verifier, but only for the project's whitelisted TEST phone numbers, so
 *    the flag cannot be abused. This is what lets test-number signups skip the captcha.
 * 2. A trim of the loudest automation signals — harmless with the bypass on, kept so a run
 *    without the flag (or against a build that predates it) still fares as well as it can.
 */
async function prepareContext(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    try {
      localStorage.setItem('monti:e2e', '1');
    } catch {
      /* localStorage throws in a sandboxed/opaque-origin frame; the flag simply stays off */
    }
  });
  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko', 'en-US', 'en'] });
      // A plausible chrome runtime object; its absence is a known automation tell.
      const w = window as unknown as { chrome?: unknown };
      if (!w.chrome) w.chrome = { runtime: {} };
    } catch {
      /* nothing here is worth failing a run over */
    }
  });
}

const statePath = (p: Persona): string => `${STATE_DIR}/${p.id}.state.json`;
const credsPath = (p: Persona): string => `${STATE_DIR}/${p.id}.creds.json`;

/** New browser context for a persona, its passkey store restored and authenticator attached. */
export async function openPersona(browser: Browser, persona: Persona): Promise<PersonaSession> {
  mkdirSync(STATE_DIR, { recursive: true });
  const hasState = existsSync(statePath(persona));
  const context = await browser.newContext({
    ...MOBILE,
    storageState: hasState ? statePath(persona) : undefined,
  });
  await prepareContext(context);
  const page = await context.newPage();
  const auth = await attachAuthenticator(page);
  if (existsSync(credsPath(persona))) {
    const creds = JSON.parse(readFileSync(credsPath(persona), 'utf8')) as CdpCredential[];
    await auth.importCredentials(creds);
  }
  return { persona, context, page, auth, hasState };
}

/** Sign the persona in: reuse a persisted passkey if there is one, otherwise sign up fresh. */
export async function ensureAccount(session: PersonaSession): Promise<void> {
  const canReuse = session.hasState && existsSync(credsPath(session.persona));
  if (canReuse && (await login(session.page, session.persona))) return;
  await signUp(session.page, session.persona);
  await persist(session);
}

/** Persist storage state (incl. localStorage `monti.passkey`) and the authenticator credentials. */
export async function persist(session: PersonaSession): Promise<void> {
  mkdirSync(STATE_DIR, { recursive: true });
  await session.context.storageState({ path: statePath(session.persona) });
  const creds = await session.auth.exportCredentials();
  writeFileSync(credsPath(session.persona), JSON.stringify(creds, null, 2));
}

export async function closePersona(session: PersonaSession): Promise<void> {
  await session.auth.detach();
  await session.context.close();
}

/**
 * Run an async job over items with at most `limit` in flight — the throttle the nine-user
 * fan-out asks for (three signups at a time, not nine reCAPTCHA widgets at once).
 */
export async function pool<T, R>(items: T[], limit: number, job: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await job(items[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
