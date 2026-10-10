import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { USERS } from '../fixtures/personas';
import { closePersona, ensureAccount, openPersona } from '../utils/session';

/**
 * Batch H — programmable-settlement demo, step 3 (attendee side) live against production.
 *
 * Precondition: step 1 (50-settlement) has confirmed the $30 split policy and published the event.
 * Pass the event id via EVENT_ID. This spec proves two things without spending any USDC:
 *   3a. the PUBLIC settlement page `/settlement/<eventId>` renders the confirmed rules (no login);
 *   3b. an attendee (USERS[0], e.g. persona-06 with E2E_USER_FROM=06) sees the priced CTA
 *       "결제하고 받기 $30.00" and the mock card sheet (결제) opens on tap.
 * It deliberately does NOT submit the purchase — treasury USDC = 0 blocks the deposit (BLOCKED-USDC).
 */

const ARTIFACTS = 'e2e/.artifacts';
const DIAG_PATH = `${ARTIFACTS}/51-attendee-diag.json`;
const EVENT_ID = process.env.EVENT_ID ?? '';

test('51 · settlement step 3 — public rules render + attendee 결제하고 받기 $30', async ({ browser }) => {
  test.setTimeout(6 * 60 * 1000);
  expect(EVENT_ID, 'EVENT_ID env must be the step-1 event id').not.toBe('');
  mkdirSync(ARTIFACTS, { recursive: true });
  const attendee = USERS[0]!;
  const diag: Record<string, unknown> = { persona: attendee.id, eventId: EVENT_ID, startedAt: new Date().toISOString() };

  const user = await openPersona(browser, attendee);
  try {
    const page = user.page;

    // 3a. Public settlement page renders the confirmed rules (no login).
    await page.goto(`/settlement/${EVENT_ID}`);
    const rulesTitle = page.getByText('이 행사의 수익은 이렇게 나뉩니다', { exact: true });
    const emptyTitle = page.getByText('주최자가 정산 규칙을 아직 확정하지 않았어요', { exact: true });
    await expect(rulesTitle).toBeVisible({ timeout: 30_000 });
    await expect(emptyTitle).toHaveCount(0);
    diag.publicRulesRendered = true;
    diag.platformLabelVisible = await page.getByText('MONTI 플랫폼', { exact: true }).first().isVisible().catch(() => false);
    console.log(`[51] /settlement/${EVENT_ID} rules rendered=true platformLabel=${diag.platformLabelVisible}`);
    await page.screenshot({ path: `${ARTIFACTS}/51-settlement-public.png`, fullPage: true }).catch(() => undefined);

    // 3b. Attendee signs in and opens the claim page.
    await ensureAccount(user);
    diag.attendeeRecovered = user.recovered ?? false;
    await page.goto(`/claim/${EVENT_ID}`);

    // The priced CTA reads "결제하고 받기 $30.00" once the held/pending counts resolve (before that it
    // shows 확인 중… and is disabled, so match on the pay copy to wait past that transient state).
    const payCta = page.getByRole('button', { name: /결제하고 받기/ });
    await expect(payCta).toBeVisible({ timeout: 45_000 });
    await expect(payCta).toBeEnabled({ timeout: 30_000 });
    const ctaText = (await payCta.innerText()).trim();
    diag.ctaText = ctaText;
    console.log(`[51] attendee CTA = ${JSON.stringify(ctaText)}`);
    expect(ctaText, 'CTA must be the priced pay button').toContain('결제하고 받기');
    expect(ctaText, 'CTA must show the $30 price').toContain('$30');

    // 3c. Tap it → the mock card sheet (결제) opens. Do NOT submit (treasury USDC = 0 → BLOCKED-USDC).
    await payCta.click();
    const sheetTitle = page.getByRole('heading', { name: '카드 결제', exact: true });
    await expect(sheetTitle).toBeVisible({ timeout: 10_000 });
    const cardField = page.getByPlaceholder('0000 0000 0000 0000 (테스트)');
    diag.sheetOpened = await cardField.isVisible().catch(() => false);
    diag.testNoticeVisible = await page.getByText('테스트 결제예요 · 실제로 돈이 빠져나가지 않아요', { exact: true }).isVisible().catch(() => false);
    console.log(`[51] purchase sheet opened=${diag.sheetOpened} testNotice=${diag.testNoticeVisible} (NOT submitted)`);
    await page.screenshot({ path: `${ARTIFACTS}/51-attendee-sheet.png`, fullPage: true }).catch(() => undefined);
    expect(diag.sheetOpened, 'mock card sheet must open').toBe(true);
    // Intentionally no card input and no pay tap — the purchase step is BLOCKED-USDC.
  } finally {
    diag.finishedAt = new Date().toISOString();
    writeFileSync(DIAG_PATH, JSON.stringify(diag, null, 2));
    console.log(`[51] diag written: ${DIAG_PATH}`);
    await closePersona(user);
  }
});
