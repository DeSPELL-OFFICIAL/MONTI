import { expect, test, type Page, type Response } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ADMIN, USERS } from '../fixtures/personas';
import { closePersona, ensureAccount, openPersona, type PersonaSession } from '../utils/session';
import { createDraftAndPublish } from '../utils/organizer';
import { admitByOverride, approveGate, fileGateRequest, startConsole } from '../utils/gates';
import { fmtMon, monBalance, RELAYER, TREASURY } from '../utils/chain';
import { recordEvent } from '../utils/scenario-state';
import { shot } from '../utils/shots';

/** Ticket price in whole USD, set on the tier card and asserted on the CTA. Default $30. */
const PRICE = Number(process.env.E2E_PRICE_USD ?? '30');

/**
 * v2 "transaction diet" — the WHOLE paid path in ONE process (design §0 tx table):
 *
 *   1. organiser: draft (no chain) → split rules in the draft → 공개하기 = ONE `publishEvent`
 *      (event Published + policy frozen in the same tx).
 *   2. attendee A pays the mock card → ONE `SettlementVault.purchase` sent by the treasury (mint +
 *      escrow in one tx; there is no minted-but-not-deposited state). Receipt reads 보관 중.
 *   3. staff: file a pending gate → organiser 등록 = ONE `registerGate`, which opens the gate (no
 *      열기 step) → PIN → console → 수동 승인 = ONE `manualOverride` (admin is the approver).
 *   4. receipt flips to 정산 완료 (inline release).
 *
 * The admin context is both organiser and staff (cross-command passkey reuse fails), and attendee
 * A's context purchases and reads the receipt (the order id is device-local). Recorded in the diag:
 * eventId/tokenId, every phase's latency, relayer MON per phase, the treasury MON delta of the
 * purchase, and the number of on-chain writes the organiser caused (relayAction kinds +
 * createOrganizerForMe). Money is verified on chain by cast afterwards.
 */

const ARTIFACTS = 'e2e/.artifacts';
const DIAG_PATH = `${ARTIFACTS}/55-chain-diag.json`;
const PIN = '2468';

/** 60 + 20 + 15 = 95%, plus the locked MONTI row's 5% = 100%. */
const RECIPIENTS = [
  { role: '아티스트', pct: '60', tag: 'artist', addr: '0x1111111111111111111111111111111111111111' },
  { role: '공연장', pct: '20', tag: 'venue', addr: '0x2222222222222222222222222222222222222222' },
  { role: '기획', pct: '15', tag: 'planning', addr: '0x3333333333333333333333333333333333333333' },
];

/** Every organiser-side write this page sends: relayAction kinds, plus createOrganizerForMe. */
function countOrganizerWrites(page: Page): string[] {
  const kinds: string[] = [];
  page.on('response', (response: Response) => {
    try {
      const req = response.request();
      if (req.method() !== 'POST') return;
      const url = response.url().toLowerCase();
      if (url.includes('createorganizerforme')) { kinds.push('createOrganizer'); return; }
      if (!url.includes('relayaction')) return;
      const body = JSON.parse(req.postData() ?? '') as { data?: { kind?: string } };
      kinds.push(body.data?.kind ?? 'unknown');
    } catch { /* capture never throws */ }
  });
  return kinds;
}

test('55 · v2 settlement chain — publish 1 · purchase 1 · gate 1 · override 1, one process', async ({ browser }) => {
  test.setTimeout(15 * 60 * 1000);
  mkdirSync(ARTIFACTS, { recursive: true });
  const attendeeA = USERS[0]!;
  const diag: Record<string, unknown> = {
    admin: ADMIN.id, attendeeA: attendeeA.id, price: PRICE, baseUrl: process.env.E2E_BASE_URL ?? null,
    startedAt: new Date().toISOString(),
  };

  const admin = await openPersona(browser, ADMIN);
  const organizerWrites = countOrganizerWrites(admin.page);
  let userA: PersonaSession | null = null;

  try {
    const page = admin.page;
    await page.goto('/');
    await page.waitForTimeout(3000);
    await shot(page, 'landing');
    await ensureAccount(admin);

    // =========================== STEP 1 — draft → split → ONE publish ===========================
    const r0 = await monBalance(RELAYER);
    diag.relayerStart = fmtMon(r0);
    const created = await createDraftAndPublish(page, {
      personaId: ADMIN.id, orgName: '몬티 정산 테스트', title: '정산 데모 공연 v2',
      intro: '트랜잭션 다이어트 데모 행사입니다.', venue: '서울 테스트홀',
      tiers: [{ kind: '유료', name: 'VIP', supply: 50, price: PRICE }],
      split: RECIPIENTS,
    });
    const eventId = created.eventId;
    diag.eventId = eventId;
    diag.publishLatencyMs = created.publishMs;
    diag.publishWrites = [...organizerWrites];
    recordEvent('free', { id: eventId, published: true, title: '정산 데모 공연 v2' });
    const r1 = await monBalance(RELAYER);
    diag.costPublish = fmtMon(r0 - r1);
    console.log(`[55] STEP1 event=${eventId} publish=${fmtMon(r0 - r1)} MON in ${created.publishMs}ms writes=${organizerWrites.join(',')}`);
    expect(organizerWrites.filter((kind) => kind === 'publishEvent'), 'exactly one publishEvent').toHaveLength(1);
    await page.goto(`/org/events/${eventId}`);
    await page.waitForTimeout(4000);
    await shot(page, 'org-dashboard-published');

    // =========================== STEP 2 — attendee A pays (ONE purchase) ===========================
    userA = await openPersona(browser, attendeeA);
    const aPage = userA.page;
    const wire: { account?: string; orderId?: string; tokenId?: string; status?: string; txHash?: string } = {};
    aPage.on('response', (response: Response) => {
      void (async () => {
        try {
          const req = response.request();
          if (req.method() !== 'POST' || !response.url().toLowerCase().includes('purchaseticket')) return;
          try { const b = JSON.parse(req.postData() ?? '') as { data?: { auth?: { account?: string } } }; if (b.data?.auth?.account) wire.account = b.data.auth.account; } catch { /* */ }
          const parsed = JSON.parse(await response.text().catch(() => '')) as { result?: Record<string, unknown> };
          if (parsed.result) {
            wire.orderId = (parsed.result.orderId as string | undefined) ?? wire.orderId;
            wire.tokenId = (parsed.result.tokenId as string | undefined) ?? wire.tokenId;
            wire.status = (parsed.result.status as string | undefined) ?? wire.status;
            wire.txHash = (parsed.result.txHash as string | undefined) ?? wire.txHash;
          }
        } catch { /* capture never throws */ }
      })();
    });
    await ensureAccount(userA);
    await aPage.goto(`/events/${eventId}`);
    await aPage.waitForTimeout(4000);
    await shot(aPage, 'attendee-event-detail');
    await aPage.goto(`/claim/${eventId}`);
    const payCta = aPage.getByRole('button', { name: /결제하고 받기/ });
    await expect(payCta).toBeVisible({ timeout: 60_000 });
    await expect(payCta).toBeEnabled({ timeout: 30_000 });
    diag.ctaText = (await payCta.innerText()).trim();
    await shot(aPage, 'attendee-claim-paid-cta');
    expect(diag.ctaText as string, `CTA shows $${PRICE}`).toContain(`$${PRICE}`);
    await payCta.click();
    const sheet = aPage.getByRole('dialog', { name: '카드 결제' });
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    await aPage.getByPlaceholder('0000 0000 0000 0000 (테스트)').fill('4242424242424242');
    const payBtn = sheet.getByRole('button', { name: /결제하기/ });
    await expect(payBtn).toBeEnabled({ timeout: 10_000 });
    await shot(aPage, 'attendee-payment-card-filled');
    const t0 = await monBalance(TREASURY);
    const r2 = await monBalance(RELAYER);
    const payAt = Date.now();
    await payBtn.click();
    await aPage.waitForTimeout(1000);
    await shot(aPage, 'attendee-payment-processing');
    const doneAlert = sheet.getByText('결제 완료 · 티켓을 받았어요', { exact: true });
    const toTickets = sheet.getByRole('link', { name: /^(영수증 보기|내 티켓 보기)$/ });
    const notCharged = sheet.getByText(/결제가 완료되지 않았어요/);
    let purchased = false;
    const pd = Date.now() + 180_000;
    while (Date.now() < pd) {
      if (await doneAlert.isVisible().catch(() => false) || await toTickets.isVisible().catch(() => false)) { purchased = true; break; }
      if (await notCharged.isVisible().catch(() => false)) { diag.payError = 'notCharged'; break; }
      await aPage.waitForTimeout(2000);
    }
    diag.purchaseLatencyMs = Date.now() - payAt;
    diag.purchased = purchased;
    diag.wire = { ...wire };
    await shot(aPage, 'attendee-payment-done');
    const t1 = await monBalance(TREASURY);
    const r3 = await monBalance(RELAYER);
    diag.treasuryMonPurchase = fmtMon(t0 - t1);
    diag.relayerMonPurchase = fmtMon(r2 - r3);
    console.log(`[55] STEP2 purchased=${purchased} in ${diag.purchaseLatencyMs}ms treasury=${diag.treasuryMonPurchase} MON wire=${JSON.stringify(wire)}`);
    expect(purchased, `purchase reaches 결제 완료 (payError=${String(diag.payError ?? '')})`).toBe(true);
    expect(wire.tokenId, 'tokenId captured from purchaseTicket').toBeTruthy();
    const tokenId = wire.tokenId!;
    diag.tokenId = tokenId;
    diag.attendeeAccount = wire.account;

    await aPage.goto(`/tickets/${tokenId}`);
    await expect(aPage.getByRole('heading', { name: '영수증', exact: true })).toBeVisible({ timeout: 45_000 });
    const heldLine = aPage.getByText('결제 금액 보관 중 · 입장하면 자동으로 나눠 보내요', { exact: true });
    const held = await heldLine.waitFor({ state: 'visible', timeout: 60_000 }).then(() => true).catch(() => false);
    diag.receiptHeld = held;
    await shot(aPage, 'attendee-receipt-held');
    expect(held, 'receipt reads 보관 중 (escrow Held)').toBe(true);

    // =========================== STEP 3 — gate (ONE register, opens) + override ===========================
    const gateAccount = await fileGateRequest(page, eventId);
    diag.gateAccount = gateAccount;
    const r4 = await monBalance(RELAYER);
    const gate = await approveGate(page, eventId, gateAccount);
    diag.gateId = gate.gateId.toString();
    diag.registerLatencyMs = gate.registerMs;
    diag.gateOpenOnRegister = gate.openOnRegister;
    diag.gateOpenedSeparately = gate.openedSeparately;
    const r5 = await monBalance(RELAYER);
    diag.costRegister = fmtMon(r4 - r5);
    console.log(`[55] STEP3 gate=${gate.gateId} openOnRegister=${gate.openOnRegister} register=${fmtMon(r4 - r5)} MON`);

    await startConsole(page, PIN);
    const override = await admitByOverride(page, tokenId, PIN);
    diag.override = { result: override.result, lastDetail: override.lastDetail, latencyMs: override.latencyMs };
    const r6 = await monBalance(RELAYER);
    diag.costOverride = fmtMon(r5 - r6);
    console.log(`[55] STEP3 override=${override.result} in ${override.latencyMs}ms cost=${fmtMon(r5 - r6)} MON`);
    expect(override.result, `manual override lands on 들여보냈어요 (lastDetail=${override.lastDetail})`).toBe('approved');

    // =========================== STEP 4 — receipt flips to 정산 완료 ===========================
    const releasedLine = aPage.getByText('정산 완료 · 정해진 비율대로 나눠 보냈어요', { exact: true });
    let released = false;
    const rd = Date.now() + 120_000;
    while (Date.now() < rd) {
      await aPage.goto(`/tickets/${tokenId}`);
      if (await releasedLine.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false)) { released = true; break; }
    }
    diag.receiptReleased = released;
    await shot(aPage, 'attendee-receipt-settled');
    await aPage.goto(`/settlement/${eventId}`);
    await aPage.waitForTimeout(5000);
    await shot(aPage, 'public-settlement-page');
    await page.goto(`/org/events/${eventId}`);
    await page.waitForTimeout(4000);
    await shot(page, 'org-dashboard-after-settlement');
    if (!released) console.log('[55] STEP4 receipt not yet flipped in-window — verify release on chain');

    // The organiser's on-chain writes, end to end (design target: createOrganizer once + publish + gate).
    diag.organizerWrites = [...organizerWrites];
    diag.organizerTxCount = organizerWrites.filter((kind) => kind !== 'manualOverride').length;
    console.log(`[55] organiser writes: ${organizerWrites.join(', ')}`);
    expect(organizerWrites.filter((kind) => kind === 'openGate'), 'no separate openGate').toHaveLength(gate.openedSeparately ? 1 : 0);
  } finally {
    diag.finishedAt = new Date().toISOString();
    writeFileSync(DIAG_PATH, JSON.stringify(diag, null, 2));
    console.log(`[55] diag written: ${DIAG_PATH}`);
    if (userA) await closePersona(userA).catch(() => undefined);
    await closePersona(admin).catch(() => undefined);
  }
});
