import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createPublicClient, http } from 'viem';
import { ADMIN } from '../fixtures/personas';
import { closePersona, ensureAccount, openPersona } from '../utils/session';
import { publishEvent } from '../utils/organizer';
import { recordEvent } from '../utils/scenario-state';

/**
 * Batch H — step 1 FINISH. The 50 spec creates the event, but the 정산 설정 price field only renders
 * once the Envio indexer has surfaced the event's tier (Dashboard keys the price inputs to the
 * indexer tiers). On Run 4 the indexer had not caught up inside 50's 120s window, so the event was
 * created (id via EVENT_ID) but left Draft with no policy. This spec reuses that organiser
 * (E2E_ADMIN) and the existing event, waits (longer) for the price field, confirms the $30 split
 * policy and publishes — the downstream precondition for purchase/admission.
 *
 * It creates NO new event and spends no USDC; it only sets the policy and publishes the Draft.
 */

const ARTIFACTS = 'e2e/.artifacts';
const DIAG_PATH = `${ARTIFACTS}/50b-finish-diag.json`;
const EVENT_ID = process.env.EVENT_ID ?? '';

const RELAYER = '0xFA93A9dB40a4396a8CdcF63991FA8615d1A35fFd' as const;
const BAL_RPC = process.env.E2E_RPC_URL ?? 'https://testnet-rpc.monad.xyz';
const balClient = createPublicClient({ transport: http(BAL_RPC) });
const relayerMon = (): Promise<bigint> => balClient.getBalance({ address: RELAYER });
const fmtMon = (wei: bigint): string => (Number(wei) / 1e18).toFixed(9);

/** The three non-platform recipient rows; MONTI 5% platform row is pre-seeded and locked (row 0). */
const RECIPIENTS = [
  { role: '아티스트', pct: '60', tag: 'artist', addr: '0x1111111111111111111111111111111111111111' },
  { role: '공연장', pct: '20', tag: 'venue', addr: '0x2222222222222222222222222222222222222222' },
  { role: '기획', pct: '15', tag: 'planning', addr: '0x3333333333333333333333333333333333333333' },
];

test('50b · settlement step 1 finish — confirm $30 split on existing event + publish', async ({ browser }) => {
  test.setTimeout(4 * 60 * 1000);
  expect(EVENT_ID, 'EVENT_ID env must be the step-1 (50) event id').not.toBe('');
  mkdirSync(ARTIFACTS, { recursive: true });
  const diag: Record<string, unknown> = { persona: ADMIN.id, eventId: EVENT_ID, startedAt: new Date().toISOString() };

  const admin = await openPersona(browser, ADMIN);
  try {
    await ensureAccount(admin);
    const page = admin.page;
    const eventId = EVENT_ID;

    // Wait for the 정산 설정 section's price field (it renders only once the indexer lists the tier).
    const priceInput = page.locator('input[placeholder="30"]');
    const card = page.locator('section.card', { has: page.getByRole('heading', { name: '정산 설정', exact: true }) });
    let sectionReady = false;
    const deadline = Date.now() + 140_000;
    while (Date.now() < deadline) {
      await page.goto(`/org/events/${eventId}`);
      await page.waitForTimeout(2500);
      if (await page.getByRole('heading', { name: '정산 설정', exact: true }).isVisible().catch(() => false)) {
        if (await priceInput.first().isVisible().catch(() => false)) { sectionReady = true; break; }
      }
      await page.waitForTimeout(3000);
    }
    diag.priceFieldVisible = sectionReady;
    console.log(`[50b] priceField ready=${sectionReady}`);
    expect(sectionReady, 'price field must render (indexer must have surfaced the tier)').toBe(true);

    // Fill the $30 price.
    await priceInput.first().fill('30');

    // Add the three non-platform recipient rows (platform MONTI 5% is pre-seeded, row 0).
    const addRow = page.getByRole('button', { name: '수령인 추가', exact: true });
    for (let i = 0; i < RECIPIENTS.length; i++) {
      await addRow.click().catch(() => undefined);
      await page.waitForTimeout(300);
    }
    const rows = page.locator('li.split-row');
    diag.rowCount = await rows.count().catch(() => -1);
    for (let i = 0; i < RECIPIENTS.length; i++) {
      const row = rows.nth(i + 1);
      const r = RECIPIENTS[i]!;
      try {
        await row.locator('input').nth(0).fill(r.role, { force: true });
        await row.locator('input').nth(1).fill(r.pct, { force: true });
        await row.locator('input').nth(2).fill(r.tag, { force: true });
        const summary = row.locator('details.more summary');
        if (await summary.isVisible().catch(() => false)) await summary.click().catch(() => undefined);
        await row.locator('details.more input').first().fill(r.addr, { force: true });
      } catch (e) {
        console.log(`[50b] recipient row ${i} fill issue: ${e}`);
      }
    }

    await page.waitForTimeout(800);
    const confirmBtn = page.getByRole('button', { name: '정산 규칙 확정', exact: true });
    diag.sumText = (await card.locator('.settlement-sum').first().innerText().catch(() => '')) || '';
    diag.confirmDisabled = await confirmBtn.isDisabled().catch(() => null);
    console.log(`[50b] sum=${JSON.stringify(diag.sumText)} confirmDisabled=${diag.confirmDisabled}`);
    await page.screenshot({ path: `${ARTIFACTS}/50b-settlement-section.png`, fullPage: true }).catch(() => undefined);
    expect(diag.confirmDisabled, '정산 규칙 확정 must be enabled').toBe(false);

    const balBeforePolicy = await relayerMon().catch(() => 0n);
    await confirmBtn.click();
    const publicLink = card.getByRole('link', { name: '정산 내역 보기', exact: true });
    const confirmedChip = card.getByText('정산 규칙 확정됨', { exact: true });
    let policyConfirmed = false;
    const confirmDeadline = Date.now() + 100_000;
    while (Date.now() < confirmDeadline) {
      if (await publicLink.isVisible().catch(() => false)) { policyConfirmed = true; break; }
      if (await confirmedChip.isVisible().catch(() => false)) { policyConfirmed = true; break; }
      await page.waitForTimeout(3000);
    }
    diag.policyConfirmed = policyConfirmed;
    const balAfterPolicy = await relayerMon().catch(() => 0n);
    (diag as Record<string, string>).costSetPolicy = fmtMon(balBeforePolicy - balAfterPolicy);
    console.log(`[50b] policy confirmed=${policyConfirmed} · relaySetPolicy=${fmtMon(balBeforePolicy - balAfterPolicy)} MON`);
    await page.screenshot({ path: `${ARTIFACTS}/50b-settlement-confirmed.png`, fullPage: true }).catch(() => undefined);
    expect(policyConfirmed, 'relaySetPolicy should confirm within 100s').toBe(true);

    // Publish the event so purchase + admission paths exist.
    const publishResult = await publishEvent(page, ADMIN.id, eventId);
    diag.publishResult = publishResult;
    recordEvent('free', { id: eventId, published: publishResult === 'published', title: '정산 데모 공연 H' });
    const balAfterPublish = await relayerMon().catch(() => 0n);
    (diag as Record<string, string>).costPublish = fmtMon(balAfterPolicy - balAfterPublish);
    console.log(`[50b] publish=${publishResult} · publish cost=${fmtMon(balAfterPolicy - balAfterPublish)} MON · relayer ${fmtMon(balAfterPublish)}`);
    // 'confirming' means the publish relay landed but the chain status read lagged inside the
    // helper window; on-chain eventStatus is verified authoritatively by cast after this spec.
    expect(['published', 'confirming'], 'publish must send').toContain(publishResult);
  } finally {
    diag.finishedAt = new Date().toISOString();
    writeFileSync(DIAG_PATH, JSON.stringify(diag, null, 2));
    console.log(`[50b] diag written: ${DIAG_PATH}`);
    await closePersona(admin);
  }
});
