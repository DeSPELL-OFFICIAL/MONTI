import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ADMIN, USERS } from '../fixtures/personas';
import { BASE_URL, closePersona, ensureAccount, openPersona } from '../utils/session';

/**
 * A screenshot tour for a design review — every key screen at phone width, plus one narrow pass.
 *
 * Extra scenario, off by default (`E2E_EXTRA=1`). It spends nothing on chain: it only signs three
 * personas in with their stored passkeys (free) and reads screens; the claim sheet is opened but
 * never sent. Each frame is saved to `e2e/.artifacts/screens/<name>.png` (gitignored) and listed in
 * `e2e/.artifacts/screens/index.md`.
 *
 * The tour is resilient on purpose: a screen that will not load is noted and skipped rather than
 * aborting the rest, because a half-finished tour is still worth reviewing.
 */

const EXTRA = process.env.E2E_EXTRA === '1';
const describe = EXTRA ? test.describe : test.describe.skip;

const EVENT_ID = process.env.E2E_SHOTS_EVENT ?? '6';
const REQUESTS_EVENT = process.env.E2E_SHOTS_REQUESTS_EVENT ?? '7';
const DIR = 'e2e/.artifacts/screens';

const PHONE = { width: 390, height: 844 } as const;
const NARROW = { width: 360, height: 740 } as const;

const MOBILE = {
  baseURL: BASE_URL,
  viewport: PHONE,
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  locale: 'ko-KR',
  timezoneId: 'Asia/Seoul',
} as const;

interface Shot {
  name: string;
  note: string;
}

describe('MONTI screenshot tour (390×844)', () => {
  const shots: Shot[] = [];

  async function shoot(page: Page, name: string, note: string): Promise<void> {
    try {
      await page.waitForTimeout(700); // let the route-slide and any list stagger settle
      await page.screenshot({ path: `${DIR}/${name}.png` });
      shots.push({ name, note });
    } catch (error) {
      // A frame that could not be taken must not sink the rest of the tour.
      console.log(`screenshot "${name}" skipped: ${String(error).slice(0, 140)}`);
    }
  }

  /** Go to a path and, best-effort, wait for a heading before the screenshot settles. */
  async function nav(page: Page, path: string, heading?: string): Promise<void> {
    await page.goto(path);
    if (heading !== undefined) {
      await page.getByRole('heading', { name: heading }).first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => undefined);
    }
  }

  /** Answer the create scene's resume question, if it asks, with a fresh (empty) draft. */
  async function freshScene(page: Page): Promise<void> {
    const fresh = page.getByRole('button', { name: '새로 만들기', exact: true });
    if (await fresh.isVisible({ timeout: 5000 }).catch(() => false)) {
      await fresh.evaluate((el) => (el as HTMLButtonElement).click()).catch(() => undefined);
      await fresh.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
    }
    await page.getByRole('heading', { name: '행사 만들기' }).first().waitFor({ state: 'visible', timeout: 20_000 }).catch(() => undefined);
  }

  test.afterAll(async () => {
    try {
      mkdirSync(DIR, { recursive: true });
      const lines = [
        '# MONTI E2E screenshot tour',
        '',
        `Target: ${BASE_URL} · viewport ${PHONE.width}×${PHONE.height} (one ${NARROW.width}×${NARROW.height} pass).`,
        `Captured ${shots.length} frame(s).`,
        '',
        ...shots.map((s) => `- \`${s.name}.png\` — ${s.note}`),
        '',
      ];
      writeFileSync(`${DIR}/index.md`, lines.join('\n'));
    } catch {
      /* the PNGs are the deliverable; the index is a convenience */
    }
  });

  test('capture the design-review screens', async ({ browser }) => {
    // A signed-out visitor, a holder (persona-02), a non-holder (persona-08) and the admin.
    const signedOut: BrowserContext = await browser.newContext({ ...MOBILE });
    const holder = await openPersona(browser, USERS[0]!);
    const nonHolder = await openPersona(browser, USERS[6]!);
    const admin = await openPersona(browser, ADMIN);

    try {
      await ensureAccount(holder);
      await ensureAccount(nonHolder);
      await ensureAccount(admin);

      // --- Discover, signed out then in ---
      const out = await signedOut.newPage();
      await nav(out, '/', '탐색');
      await shoot(out, '10-discover-signed-out', 'Discover (탐색), signed out');
      await out.close();

      await nav(holder.page, '/', '탐색');
      await shoot(holder.page, '11-discover-signed-in', 'Discover (탐색), signed in as persona-02');

      // --- Event detail: holder vs non-holder ---
      await nav(holder.page, `/events/${EVENT_ID}`);
      await shoot(holder.page, `12-event-detail-holder`, `Event ${EVENT_ID} detail as a holder (persona-02)`);

      await nav(nonHolder.page, `/events/${EVENT_ID}`);
      await shoot(nonHolder.page, `13-event-detail-non-holder`, `Event ${EVENT_ID} detail as a non-holder (persona-08)`);

      // --- Claim inline sheet (opened, never sent) ---
      const getTicket = nonHolder.page.getByRole('button', { name: '티켓 받기', exact: true })
        .or(nonHolder.page.getByRole('button', { name: '신청하기', exact: true }));
      if (await getTicket.first().isVisible({ timeout: 10_000 }).catch(() => false)) {
        await getTicket.first().click().catch(() => undefined);
        await nonHolder.page.waitForTimeout(1200);
      }
      await shoot(nonHolder.page, '14-claim-sheet', 'Claim inline sheet on the event detail');

      // --- 내 티켓 list + one ticket detail ---
      await nav(holder.page, '/tickets', '내 티켓');
      await shoot(holder.page, '15-tickets-list', '내 티켓 list');
      const firstRow = holder.page.locator('a.ticket-row').first();
      if (await firstRow.isVisible({ timeout: 10_000 }).catch(() => false)) {
        await firstRow.click().catch(() => undefined);
        await holder.page.waitForURL(/\/tickets\/[^/]+$/, { timeout: 20_000 }).catch(() => undefined);
        await shoot(holder.page, '16-ticket-detail', '내 티켓 detail (used overlay is not exercised here)');
      }

      // --- Profile, verify ---
      await nav(holder.page, '/me', '프로필');
      await shoot(holder.page, '17-profile', 'Profile (프로필)');
      await nav(holder.page, '/me/verify', '신분증과 얼굴을 확인할게요');
      await shoot(holder.page, '18-verify', 'Identity verification screen');

      // --- Organiser home ---
      await nav(admin.page, '/org', '주최자');
      await shoot(admin.page, '20-organizer-home', 'Organiser home (주최자)');

      // --- Create scene: top, tickets section, poster dialog ---
      await admin.page.goto('/org/new');
      await freshScene(admin.page);
      await shoot(admin.page, '21-create-top', 'Create scene — top');
      await admin.page.locator('#scene-tickets').scrollIntoViewIfNeeded().catch(() => undefined);
      await shoot(admin.page, '22-create-tickets', 'Create scene — tickets section');
      const posterBtn = admin.page.getByRole('button', { name: '포스터 올리기', exact: true })
        .or(admin.page.getByRole('button', { name: '포스터 바꾸기', exact: true }));
      if (await posterBtn.first().isVisible({ timeout: 8000 }).catch(() => false)) {
        await posterBtn.first().evaluate((el) => (el as HTMLButtonElement).click()).catch(() => undefined);
        await admin.page.locator('dialog.poster-modal').waitFor({ state: 'visible', timeout: 8000 }).catch(() => undefined);
        await shoot(admin.page, '23-create-poster-dialog', 'Create scene — poster dialog open');
        await admin.page.keyboard.press('Escape').catch(() => undefined);
        await admin.page.locator('dialog.poster-modal').waitFor({ state: 'hidden', timeout: 8000 }).catch(() => undefined);
      }

      // --- Created / publish screen, requests screen ---
      await nav(admin.page, `/org/new/done/${EVENT_ID}`, '행사를 만들었어요');
      await shoot(admin.page, '24-created-publish', 'Created / publish screen');
      await nav(admin.page, `/org/events/${REQUESTS_EVENT}/requests`, '신청 관리');
      await shoot(admin.page, '25-requests', `Requests screen (Event ${REQUESTS_EVENT})`);

      // --- One narrow pass of the create scene (360×740) ---
      await admin.page.setViewportSize(NARROW);
      await admin.page.goto('/org/new');
      await freshScene(admin.page);
      await shoot(admin.page, '30-create-360', 'Create scene at 360×740');
      await admin.page.setViewportSize(PHONE);

      expect(shots.length, 'the tour captured at least some frames').toBeGreaterThan(0);
    } finally {
      await signedOut.close().catch(() => undefined);
      await closePersona(holder).catch(() => undefined);
      await closePersona(nonHolder).catch(() => undefined);
      await closePersona(admin).catch(() => undefined);
    }
  });
});
