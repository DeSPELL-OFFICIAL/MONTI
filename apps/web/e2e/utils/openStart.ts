import { expect, type Page } from '@playwright/test';
import { en } from '../../src/attendee/start/copy';

/**
 * Open mode (`VITE_AUTH_MODE=open`) helpers. The start screen's strings come from the screen's own
 * copy module, so a wording change cannot leave this helper asserting on a stale sentence. The app
 * is English-only.
 */
function exact(text: string): RegExp {
  return new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}

export const OPEN = {
  startTitle: exact(en.title),
  startCta: exact(en.cta),
  // The shared-copy labels the claim and ticket screens use (claim.cta, claim.done, tickets.title in
  // shared/copy/en.ts). Held here, not imported, so this file does not drag the app's i18n runtime
  // into Playwright.
  claimCta: exact('Get a ticket'),
  claimDone: exact("You got your ticket · It's in My tickets"),
  claimAlready: /You already have/,
  ticketsTitle: exact('My tickets'),
} as const;

/** Allowed slack for the one-tap start: ~15 s normally, plus cold starts and a busy attester. */
const START_BUDGET_MS = 120_000;

/** Open `/start`, tap Get started, and wait until the app has left it (signed in). */
export async function openStart(page: Page, returnTo?: string): Promise<void> {
  const query = returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : '';
  await page.goto(`/start${query}`);
  await expect(page.getByRole('heading', { name: OPEN.startTitle })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: OPEN.startCta }).click();
  await page.waitForURL((url) => url.pathname !== '/start', { timeout: START_BUDGET_MS });
}

/** True when the page is on a guarded or public app screen rather than an entry screen. */
export function isEntryScreen(page: Page): boolean {
  const { pathname } = new URL(page.url());
  return pathname === '/start' || pathname === '/login' || pathname.startsWith('/signup/') || pathname === '/recover';
}
