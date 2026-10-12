import { test, expect } from '@playwright/test';
import { OPEN, isEntryScreen, openStart } from '../utils/openStart';

/**
 * Open mode end to end (`VITE_AUTH_MODE=open` on the deployed build): a fresh browser taps Get
 * started, gets an identity with no phone and no passkey, keeps it across a reload (Firebase's
 * persisted session), claims a FREE ticket of `EVENT_ID`, and finds it in My tickets.
 *
 * Opt-in: runs only with `E2E_AUTH_MODE=open` (the target build must be in open mode) and
 * `EVENT_ID` (a published event with a free tier). It claims for real on chain, so it is never part
 * of a default run.
 */
const AUTH_MODE = process.env.E2E_AUTH_MODE ?? '';
const EVENT_ID = process.env.EVENT_ID ?? '';

test.describe('open mode: one-tap start', () => {
  test.skip(AUTH_MODE !== 'open', 'set E2E_AUTH_MODE=open against an open-mode build');

  // The `page` fixture is a brand-new context (baseURL and the phone viewport from the config, no
  // stored session, no device key) — exactly a judge's first visit.
  test('start, survive a reload, claim a free ticket, see it in My tickets', async ({ page }) => {
    await openStart(page);
    await expect.poll(() => new URL(page.url()).pathname).toBe('/');

    // The persisted Firebase session carries the claims, so a reload lands signed in, not on /start.
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3_000);
    expect(new URL(page.url()).pathname).toBe('/');
    // A guarded screen is the real proof: anonymous would be bounced to /start.
    await page.goto('/tickets');
    await expect(page.getByRole('heading', { name: OPEN.ticketsTitle })).toBeVisible({ timeout: 30_000 });
    expect(isEntryScreen(page), `redirected to ${page.url()} after reload`).toBe(false);

    test.skip(EVENT_ID === '', 'set EVENT_ID to a published event with a free tier to claim');

    await page.goto(`/claim/${EVENT_ID}`);
    expect(isEntryScreen(page)).toBe(false);
    const claim = page.getByRole('button', { name: OPEN.claimCta });
    await expect(claim).toBeVisible({ timeout: 30_000 });
    await expect(claim).toBeEnabled({ timeout: 30_000 });
    await claim.click();
    await expect(page.getByText(OPEN.claimDone).or(page.getByText(OPEN.claimAlready)))
      .toBeVisible({ timeout: 3 * 60_000 });

    await page.goto('/tickets');
    await expect(page.getByRole('heading', { name: OPEN.ticketsTitle })).toBeVisible({ timeout: 30_000 });
    // The indexer takes a moment after the claim; reload until the row is there.
    await expect.poll(async () => {
      await page.reload();
      await page.waitForTimeout(3_000);
      return page.locator('.ticket-row').count();
    }, { timeout: 120_000, intervals: [1_000] }).toBeGreaterThan(0);
  });

  test('a guarded event link opened signed out comes back to the claim after Get started', async ({ page }) => {
    test.skip(EVENT_ID === '', 'set EVENT_ID to follow the claim link');
    await page.goto(`/claim/${EVENT_ID}`);
    await page.waitForURL(/\/start\?returnTo=/, { timeout: 30_000 });
    await page.getByRole('button', { name: OPEN.startCta }).click();
    await page.waitForURL(new RegExp(`/claim/${EVENT_ID}`), { timeout: 120_000 });
    await expect(page.getByRole('button', { name: OPEN.claimCta })).toBeVisible({ timeout: 30_000 });
  });
});
