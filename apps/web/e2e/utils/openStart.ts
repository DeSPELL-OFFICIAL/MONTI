import { expect, type Page } from '@playwright/test';
import { en, ko } from '../../src/attendee/start/copy';

/**
 * Open mode (`VITE_AUTH_MODE=open`) helpers. The start screen's strings come from the screen's own
 * copy module, so a wording change cannot leave this helper asserting on a stale sentence. Both
 * languages are accepted: the browser locale is ko-KR, while the deployed build may pin English.
 */
function either(a: string, b: string): RegExp {
  const esc = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^(${esc(a)}|${esc(b)})$`);
}

export const OPEN = {
  startTitle: either(en.title, ko.title),
  startCta: either(en.cta, ko.cta),
  // The shared-copy labels the claim and ticket screens use, en first (claim.cta, claim.done,
  // tickets.title in shared/copy). Held here, not imported, so this file does not drag the app's
  // i18n runtime into Playwright.
  claimCta: either('Get a ticket', '티켓 받기'),
  claimDone: either("You got your ticket · It's in My Tickets", '티켓을 받았어요 · 내 티켓에 있어요'),
  claimAlready: /You already have|이미 받았어요/,
  ticketsTitle: either('My tickets', '내 티켓'),
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
