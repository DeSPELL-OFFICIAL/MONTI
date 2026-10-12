import { test, expect, chromium, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OPEN, isEntryScreen } from '../utils/openStart';

/**
 * Open mode, hackathon submission: create the English demo event as a one-tap organizer, prove a
 * judge's session persists (reloads + closing/reopening the browser profile), and audit every
 * screen's visible text for Hangul and crypto jargon.
 *
 * Opt-in: `E2E_AUTH_MODE=open` and `DEMO_DIR` (a folder kept between runs: the browser profiles
 * live there, so the organizer and the judge can be reopened later). The `create` test publishes
 * on chain; run the others with `EVENT_ID` set to its result.
 */
const AUTH_MODE = process.env.E2E_AUTH_MODE ?? '';
const DIR = process.env.DEMO_DIR ?? '';
const EVENT_ID = process.env.EVENT_ID ?? '';
const BASE = process.env.E2E_BASE_URL ?? 'https://monti.despell.io';

const BANNED = /\b(wallet|token|transaction|blockchain|hash|signature|gas|USDC|on-chain|onchain|mint\w*|crypto\w*)\b/gi;
const HANGUL = /[가-힣]+[^\n]{0,40}/g;

function log(file: string, row: unknown): void {
  mkdirSync(DIR, { recursive: true });
  appendFileSync(join(DIR, file), `${JSON.stringify(row)}\n`);
}

/** A persistent Chromium profile, phone-sized like the config. Closing and reopening it is a real restart. */
async function profile(name: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(join(DIR, 'profiles', name), {
    headless: process.env.E2E_HEADLESS === '1',
    baseURL: BASE,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'en-US',
    timezoneId: 'Asia/Seoul',
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

const consoleErrors: Array<{ url: string; text: string }> = [];
function watch(page: Page): void {
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push({ url: page.url(), text: m.text() }); });
  page.on('pageerror', (e) => consoleErrors.push({ url: page.url(), text: `pageerror: ${e.message}` }));
}

/** Screenshot + innerText + Hangul/banned-word scan + console errors since the last audit. */
async function audit(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(2500);
  mkdirSync(join(DIR, 'screens'), { recursive: true });
  await page.screenshot({ path: join(DIR, 'screens', `audit-${name}.png`), fullPage: true }).catch(() => undefined);
  const text = await page.locator('body').innerText().catch(() => '');
  const hangul = text.match(HANGUL) ?? [];
  const banned = [...text.matchAll(BANNED)].map((m) => text.slice(Math.max(0, m.index! - 40), m.index! + 40).replace(/\n/g, ' | '));
  const errors = consoleErrors.splice(0);
  log('audit.jsonl', { name, url: page.url(), hangul, banned, errors, text });
}

async function signedIn(page: Page): Promise<void> {
  await page.goto('/tickets');
  await expect(page.getByRole('heading', { name: OPEN.ticketsTitle })).toBeVisible({ timeout: 30_000 });
  expect(isEntryScreen(page), `bounced to ${page.url()}`).toBe(false);
}

/** Tap Get started and time it; returns ms from the tap to leaving /start. */
async function start(page: Page): Promise<number> {
  await page.goto('/start');
  await expect(page.getByRole('heading', { name: OPEN.startTitle })).toBeVisible({ timeout: 30_000 });
  const t0 = Date.now();
  await page.getByRole('button', { name: OPEN.startCta }).click();
  await page.waitForURL((url) => url.pathname !== '/start', { timeout: 120_000 });
  return Date.now() - t0;
}

async function accountOf(page: Page): Promise<string> {
  await page.goto('/me');
  await page.waitForTimeout(3000);
  const hrefs = await page.locator('a[href*="/address/"]').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
  return hrefs.map((h) => h.match(/0x[0-9a-fA-F]{40}/)?.[0]).find(Boolean) ?? '';
}

function field(scope: Page | Locator, label: string): Locator {
  return scope.locator('label.field', { hasText: label }).locator('input, textarea, select').first();
}
async function press(locator: Locator): Promise<void> {
  await locator.evaluate((el) => (el as HTMLElement).click());
}
function tomorrowEvening(): string {
  const d = new Date(Date.now() + 86_400_000);
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return `${date}T19:00`;
}

test.describe.configure({ mode: 'serial' });
test.describe('open mode: demo event + persistence + English audit', () => {
  test.skip(AUTH_MODE !== 'open' || DIR === '', 'set E2E_AUTH_MODE=open and DEMO_DIR');

  test('entry redirects: /login and /signup/phone land on /start', async ({ page }) => {
    for (const path of ['/start', '/login', '/signup/phone']) {
      await page.goto(path);
      await page.waitForTimeout(2500);
      log('redirects.jsonl', { from: path, to: new URL(page.url()).pathname });
      expect(new URL(page.url()).pathname).toBe('/start');
    }
  });

  test('create the demo event as a one-tap organizer', async () => {
    test.skip(EVENT_ID !== '', 'already created');
    const ctx = await profile('organizer');
    const page = ctx.pages()[0] ?? await ctx.newPage();
    watch(page);
    page.on('response', async (res) => {
      if (/relayAction|relayClaim|startSignup|registerIdentity/.test(res.url())) {
        log('network.jsonl', { url: res.url(), status: res.status(), body: await res.text().catch(() => '') });
      }
    });

    const startMs = await start(page);
    const account = await accountOf(page);
    log('demo.jsonl', { step: 'organizer-start', startMs, account });

    await page.goto('/org/new');
    await expect(page.getByRole('heading', { name: 'Create an event' })).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1500);
    const resume = page.getByRole('button', { name: 'Carry on', exact: true });
    if (await resume.isVisible().catch(() => false)) await press(resume);

    await field(page, 'Title').fill('Monad Metropolis Demo Night', { force: true });
    await field(page, 'About this event').fill(
      'A night of demos at Monad Metropolis. Your ticket is bound to you: tap your phone at the door to get in, and it cannot be resold or scalped.',
      { force: true },
    );
    await field(page, 'Starts').fill(tomorrowEvening(), { force: true });
    await field(page, 'Where').fill('Seoul', { force: true });

    const quick = page.getByRole('group', { name: 'Quick start' });
    await press(quick.getByRole('button', { name: 'Free, first come', exact: true }));
    const card1 = page.locator('.tier-card').first();
    await field(card1, 'Ticket type (e.g. General, VIP)').fill('General', { force: true });
    await field(card1, 'Quantity').fill('200', { force: true });

    // Second type behind More settings.
    const more = page.locator('details summary', { hasText: 'More settings' });
    if (await more.count()) await press(more.first());
    await press(page.getByRole('button', { name: 'Add a ticket type', exact: true }));
    const card2 = page.locator('.tier-card').nth(1);
    await expect(card2).toBeVisible({ timeout: 10_000 });
    await field(card2, 'Ticket type (e.g. General, VIP)').fill('Supporter', { force: true });
    await field(card2, 'Quantity').fill('50', { force: true });
    await press(card2.getByRole('group', { name: 'Price' }).getByRole('button', { name: 'Paid', exact: true }));
    await field(card2, 'Amount').fill('1', { force: true });
    await page.waitForTimeout(1000);
    await audit(page, '10-org-create-filled');

    await press(page.getByRole('button', { name: 'Next', exact: true }));
    await expect(page).toHaveURL(/\/org\/new\/([^/]+)\/publish/, { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Publish', level: 1 })).toBeVisible({ timeout: 30_000 });

    // Revenue split: MONTI 5% is locked; the organizer takes the other 95% to their own account.
    const rows = page.locator('li.split-row');
    await expect(rows.first()).toBeVisible({ timeout: 30_000 });
    if ((await rows.count()) < 2) {
      await press(page.getByRole('button', { name: 'Add recipient', exact: true }));
      await page.waitForTimeout(300);
    }
    const row = rows.nth(1);
    await row.locator('input').nth(0).fill('Organizer', { force: true });
    await row.locator('input').nth(1).fill('95', { force: true });
    await row.locator('input').nth(2).fill('organizer', { force: true });
    const summary = row.locator('details.more summary');
    if (await summary.isVisible().catch(() => false)) await summary.click().catch(() => undefined);
    await row.locator('details.more input').first().fill(account, { force: true });
    const org = field(page, 'Organizer name');
    if (await org.isVisible().catch(() => false)) await org.fill('Monad Metropolis', { force: true });
    await audit(page, '11-org-publish-split');

    const publish = page.getByRole('button', { name: 'Publish', exact: true }).last();
    await expect(publish).toBeEnabled({ timeout: 30_000 });
    await press(publish);
    const sheet = page.getByRole('dialog', { name: 'Publish it as it is?' });
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    await audit(page, '12-org-publish-confirm');
    const t0 = Date.now();
    await press(sheet.getByRole('button', { name: 'Yes, publish it', exact: true }));
    const done = /\/org\/new\/done\/(\d+)/;
    await expect(page).toHaveURL(done, { timeout: 6 * 60_000 });
    const urlMs = Date.now() - t0;
    await expect(page.getByText(/Your event is live/i).first()).toBeVisible({ timeout: 60_000 }).catch(() => undefined);
    const liveMs = Date.now() - t0;
    const eventId = page.url().match(done)?.[1] ?? '';
    log('demo.jsonl', { step: 'published', eventId, account, urlMs, liveMs });
    await audit(page, '13-org-publish-done');
    await ctx.close();
  });

  test('judge: fresh profile, Get started, reload x3, close and reopen the browser', async () => {
    const ctx = await profile('judge');
    let page = ctx.pages()[0] ?? await ctx.newPage();
    watch(page);
    const startMs = await start(page);
    const landed = new URL(page.url()).pathname;
    log('demo.jsonl', { step: 'judge-start', startMs, landed });
    for (let i = 1; i <= 3; i++) {
      await page.reload();
      await page.waitForTimeout(3000);
      log('demo.jsonl', { step: `judge-reload-${i}`, path: new URL(page.url()).pathname });
      expect(isEntryScreen(page)).toBe(false);
    }
    await signedIn(page);
    const account = await accountOf(page);
    await ctx.close();

    const again = await profile('judge');
    page = again.pages()[0] ?? await again.newPage();
    await page.goto('/');
    await page.waitForTimeout(4000);
    const home = new URL(page.url()).pathname;
    await signedIn(page);
    const account2 = await accountOf(page);
    log('demo.jsonl', { step: 'judge-reopen', home, account, account2, same: account === account2 });
    expect(account2).toBe(account);
    await again.close();
  });

  test('English audit of every screen', async () => {
    test.skip(EVENT_ID === '', 'set EVENT_ID');
    // Judge side (fresh profile so /start is seen signed out).
    const judge = await profile('audit-judge');
    const page = judge.pages()[0] ?? await judge.newPage();
    watch(page);
    await page.goto('/start');
    await audit(page, '20-start');
    const startMs = await start(page);
    log('demo.jsonl', { step: 'audit-judge-start', startMs });
    await page.goto('/');
    await audit(page, '21-home');
    await page.goto(`/events/${EVENT_ID}`);
    await audit(page, '22-event');
    await page.goto(`/claim/${EVENT_ID}`);
    await audit(page, '23-claim');
    if (process.env.DEMO_CLAIM !== '0') {
      const cta = page.getByRole('button', { name: OPEN.claimCta });
      await expect(cta).toBeEnabled({ timeout: 30_000 });
      const c0 = Date.now();
      await cta.click();
      await expect(page.getByText(OPEN.claimDone).or(page.getByText(OPEN.claimAlready))).toBeVisible({ timeout: 3 * 60_000 });
      log('demo.jsonl', { step: 'audit-claim', claimMs: Date.now() - c0 });
      await audit(page, '24-claim-done');
      await page.goto('/tickets');
      await expect.poll(async () => { await page.reload(); await page.waitForTimeout(3000); return page.locator('.ticket-row').count(); },
        { timeout: 120_000, intervals: [1000] }).toBeGreaterThan(0);
      await audit(page, '25-tickets');
      await page.locator('.ticket-row').first().click();
      await page.waitForURL(/\/tickets\/\d+/, { timeout: 30_000 });
      await audit(page, '26-ticket');
      const details = page.locator('details summary').first();
      if (await details.isVisible().catch(() => false)) await details.click();
      else await page.getByRole('button', { name: /Details/i }).first().click().catch(() => undefined);
      await audit(page, '27-ticket-details');
      log('demo.jsonl', { step: 'judge-ticket', url: page.url() });
    } else {
      await page.goto('/tickets');
      await audit(page, '25-tickets');
    }
    await page.goto('/me');
    await audit(page, '28-profile');
    await page.goto(`/settlement/${EVENT_ID}`);
    await audit(page, '29-settlement');
    await page.goto('/staff/setup');
    await audit(page, '30-staff-setup');
    await judge.close();

    // Organizer side (the profile the create test left behind).
    const org = await profile('organizer');
    const op = org.pages()[0] ?? await org.newPage();
    watch(op);
    await op.goto('/org');
    await audit(op, '40-org-home');
    await op.goto(`/org/events/${EVENT_ID}`);
    await audit(op, '41-org-event');
    await op.goto(`/org/events/${EVENT_ID}/gates`);
    await audit(op, '42-org-gates');
    await op.goto(`/events/${EVENT_ID}`);
    await audit(op, '43-event-as-organizer');
    if (process.env.DRAFT_ID) {
      await op.goto(`/org/new/${process.env.DRAFT_ID}`);
      await audit(op, '44-org-draft');
      await op.goto(`/org/new/${process.env.DRAFT_ID}/publish`);
      await audit(op, '45-org-publish-split');
    }
    await org.close();
  });
});
