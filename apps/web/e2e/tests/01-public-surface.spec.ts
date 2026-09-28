import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ADMIN } from '../fixtures/personas';
import { closePersona, openPersona } from '../utils/session';

/**
 * Everything reachable at 390px WITHOUT signing in — the surface reCAPTCHA does not gate. It
 * captures real screenshots and page text so the persona reviews and friction log rest on what
 * the app actually renders in production, not only on a reading of the source.
 */
const SHOTS = 'e2e/.artifacts/shots';

test('public surface: discover, event detail, signup entry, login', async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true });
  const s = await openPersona(browser, ADMIN);
  const page = s.page;
  const notes: Record<string, unknown> = {};
  try {
    // 탐색 (Discover) — public event list + FAB.
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '탐색' })).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(2500);
    const cards = await page.locator('.event-card').count();
    notes.discoverEventCards = cards;
    notes.fabVisible = await page.getByRole('button', { name: '행사 만들기', exact: true }).isVisible();
    notes.discoverText = (await page.locator('main.screen').innerText()).slice(0, 1500);
    await page.screenshot({ path: `${SHOTS}/10-discover.png`, fullPage: true });

    // First event's public detail, if any event is published.
    if (cards > 0) {
      await page.locator('.event-card a').first().click();
      await expect(page).toHaveURL(/\/events\//, { timeout: 20_000 });
      await page.waitForTimeout(2000);
      notes.eventDetailUrl = page.url();
      notes.eventDetailText = (await page.locator('main.screen').innerText()).slice(0, 2000);
      await page.screenshot({ path: `${SHOTS}/11-event-detail.png`, fullPage: true });
    }

    // Signup entry — the phone screen (up to, not through, reCAPTCHA).
    await page.goto('/signup/phone');
    await expect(page.getByRole('heading', { name: '휴대폰 번호를 입력해 주세요' })).toBeVisible();
    notes.phoneScreenText = (await page.locator('main.screen').innerText()).slice(0, 800);
    await page.getByLabel('휴대폰 번호를 입력해 주세요', { exact: true }).fill('01000000001');
    await page.screenshot({ path: `${SHOTS}/12-signup-phone.png`, fullPage: true });

    // Login screen.
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: '다시 오셨네요' })).toBeVisible();
    notes.loginText = (await page.locator('main.screen').innerText()).slice(0, 600);
    await page.screenshot({ path: `${SHOTS}/13-login.png`, fullPage: true });

    // Guarded route while anonymous → should redirect to /login.
    await page.goto('/tickets');
    await page.waitForTimeout(1500);
    notes.ticketsWhileAnonUrl = page.url();
    await page.screenshot({ path: `${SHOTS}/14-tickets-anon.png`, fullPage: true });

    writeFileSync(`${SHOTS}/notes.json`, JSON.stringify(notes, null, 2));
    console.log('PUBLIC_SURFACE_NOTES', JSON.stringify(notes));
  } finally {
    await closePersona(s);
  }
});
