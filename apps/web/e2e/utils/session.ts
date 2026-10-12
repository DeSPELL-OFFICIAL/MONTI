import type { Browser, BrowserContext, Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { attachAuthenticator, type CdpCredential, type VirtualAuthenticator } from '../fixtures/webauthn';
import { PERSONA_OFFSET, type Persona } from '../fixtures/personas';
import { login, OPEN_MODE, signUp } from './signup';

const STATE_DIR = 'e2e/.state';
export const BASE_URL = process.env.E2E_BASE_URL ?? 'https://monti.despell.io';

/**
 * Manually-created contexts do not inherit the project's `use`, so every persona context is
 * given the same phone-sized, en-US, Seoul-time profile the config's default context has.
 */
const MOBILE = {
  baseURL: BASE_URL,
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  locale: 'en-US',
  timezoneId: 'Asia/Seoul',
} as const;

export interface PersonaSession {
  persona: Persona;
  context: BrowserContext;
  page: Page;
  auth: VirtualAuthenticator;
  /** True when a persisted storage state was loaded (a previous run signed this persona up). */
  hasState: boolean;
  /**
   * True when this persona reached its signed-in state through `/recover` (its number was already
   * active on chain and had to re-issue the passkey) rather than a first-time signup. Persisted in
   * the per-persona meta file so a later run's reuse logic knows how this account came to be.
   */
  recovered: boolean;
}

/**
 * A little per-persona metadata that outlives a single run but is not part of the browser storage
 * state — currently just whether the account was recovered. Kept in its own file so the Playwright
 * storage state and the authenticator credentials stay exactly what they were.
 */
interface PersonaMeta {
  recovered?: boolean;
  recoveredAt?: string;
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
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      // A plausible chrome runtime object; its absence is a known automation tell.
      const w = window as unknown as { chrome?: unknown };
      if (!w.chrome) w.chrome = { runtime: {} };
    } catch {
      /* nothing here is worth failing a run over */
    }
  });
}

// State/creds/meta are namespaced by the dialled offset (`persona-01@10.*`): rotating the TEST
// numbers must never restore a burned number's passkey session saved under a prior offset.
const statePath = (p: Persona): string => `${STATE_DIR}/${p.id}@${PERSONA_OFFSET}.state.json`;
const credsPath = (p: Persona): string => `${STATE_DIR}/${p.id}@${PERSONA_OFFSET}.creds.json`;
const metaPath = (p: Persona): string => `${STATE_DIR}/${p.id}@${PERSONA_OFFSET}.meta.json`;

/** Read the per-persona meta file, or an empty record if it is missing/unreadable. Never throws. */
function readMeta(p: Persona): PersonaMeta {
  try {
    return JSON.parse(readFileSync(metaPath(p), 'utf8')) as PersonaMeta;
  } catch {
    return {};
  }
}

/** Merge a patch into the per-persona meta file. */
function writeMeta(p: Persona, patch: PersonaMeta): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(metaPath(p), JSON.stringify({ ...readMeta(p), ...patch }, null, 2));
}

/** New browser context for a persona, its passkey store restored and authenticator attached. */
export async function openPersona(browser: Browser, persona: Persona): Promise<PersonaSession> {
  mkdirSync(STATE_DIR, { recursive: true });
  // Open mode has no reusable personas: every context is a brand-new person, so no state is restored.
  const hasState = !OPEN_MODE && existsSync(statePath(persona));
  const context = await browser.newContext({
    ...MOBILE,
    storageState: hasState ? statePath(persona) : undefined,
  });
  await prepareContext(context);
  const page = await context.newPage();
  const auth = await attachAuthenticator(page);
  if (!OPEN_MODE && existsSync(credsPath(persona))) {
    const creds = JSON.parse(readFileSync(credsPath(persona), 'utf8')) as CdpCredential[];
    await auth.importCredentials(creds);
  }
  return { persona, context, page, auth, hasState, recovered: readMeta(persona).recovered === true };
}

/** Sign the persona in: reuse a persisted passkey if there is one, otherwise sign up fresh. */
export async function ensureAccount(session: PersonaSession): Promise<void> {
  const canReuse = session.hasState && existsSync(credsPath(session.persona));
  if (canReuse) {
    // Passkey login is intermittently refused right after a cold function, and can reach 내 티켓
    // before signInWithCustomToken has persisted the session (a later reload then comes up
    // anonymous). Retry generously — each attempt remounts and mints a fresh challenge — and only
    // accept an attempt whose session is durable.
    for (let attempt = 0; attempt < 6; attempt++) {
      if ((await login(session.page, session.persona)) && (await isSignedIn(session.page))) {
        // Re-persist so the credential counter and storage stay fresh for the next run.
        await persist(session).catch(() => undefined);
        return;
      }
      await session.page.waitForTimeout(3000);
    }
    // The account is already registered on chain, so a fresh signup would only bounce to /login.
    throw new Error(`login reuse failed for ${session.persona.id}: passkey session did not hold`);
  }
  // Fresh: first-time signup, or — for a re-registered number whose on-chain identity outlived its
  // Firestore person — recovery. `signUp` branches on where Verify lands and tells us which it was.
  const { recovered } = await signUp(session.page, session.persona);
  // Open-mode identities are throwaway; persisting them would shadow the phone personas' state files.
  if (OPEN_MODE) return;
  session.recovered = recovered;
  if (recovered) writeMeta(session.persona, { recovered: true, recoveredAt: new Date().toISOString() });
  await persist(session);
}

/** Whether the session is durable: a guarded route stays put instead of bouncing to /login. */
async function isSignedIn(page: Page): Promise<boolean> {
  await page.goto('/tickets');
  await page.waitForTimeout(3000);
  return /\/tickets(\/|$)/.test(page.url());
}

/**
 * Persist storage state (incl. localStorage `monti.passkey`) and the authenticator credentials.
 *
 * `indexedDB: true` (Playwright ≥1.51 serialises IndexedDB, incl. non-extractable CryptoKeys) is
 * essential: the browser **device key** is a non-extractable P-256 `CryptoKeyPair` in IndexedDB
 * (`monti-device-key`, `src/shared/deviceKey/web.ts`). Without it a reused persona lost its
 * registered device key, minted a fresh unregistered one, and `relayClaim` rejected the
 * `ClaimAuth` deviceSig as `BAD_DEVICE_SIG`. `openPersona` restores this automatically by passing
 * the saved state file as `storageState` to `newContext` (IndexedDB is rehydrated with it).
 */
export async function persist(session: PersonaSession): Promise<void> {
  mkdirSync(STATE_DIR, { recursive: true });
  await session.context.storageState({ path: statePath(session.persona), indexedDB: true });
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
