import { expect, test, type BrowserContext, type Page, type Response } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createPublicClient, defineChain, http, type Hex } from 'viem';
import { ADMIN, USERS } from '../fixtures/personas';
import { closePersona, ensureAccount, openPersona, type PersonaSession } from '../utils/session';
import { createOrganizerAndEvent, publishEvent } from '../utils/organizer';
import { recordEvent } from '../utils/scenario-state';
import { shot } from '../utils/shots';

/** Ticket price in USD set in 정산 설정 and asserted on the CTA. Default unchanged ($30). */
const PRICE = process.env.E2E_PRICE_USD ?? '30';

/**
 * Batch H — Run 5. The WHOLE settlement money path, steps 1→4, in ONE in-process command.
 *
 * Why one command: the admin persona is BOTH the organiser (step 1) and the staff approver
 * (step 3), and cross-command passkey session reuse fails (Run 2/4). Attendee A's receipt (step 4)
 * also needs the SAME context that purchased (the order id is device-local, orderStore.ts). So the
 * admin context is kept alive across steps 1&3 and attendee A's across steps 2&4 — nothing is
 * split across commands.
 *
 * The hosted indexer is frozen, so three live gaps are navigated:
 *   - organiser dashboard price field + publish button: chain fallbacks (useEventTiers/StatusWithFallback).
 *   - attendee ticket DETAIL: chain fallback (useTicketDetail). The LIST has no fallback, so step 2
 *     navigates straight to /tickets/<tokenId> with the tokenId captured off purchaseTicket.
 *   - organiser gates registered-list (GATES_QUERY) has NO fallback, so the 열기 button never renders.
 *     This spec intercepts only that one query on the admin context and injects the just-registered
 *     gate (its real on-chain gateId), so the OPEN WRITE that the button fires is real and the
 *     staff setup then reads open=true from chain. Everything else hits the live indexer.
 *
 * Money is verified on chain by cast afterwards; this spec records eventId, tokenId, the attendee
 * account, relayer MON per phase, and the override/deposit relay ids.
 */

const ARTIFACTS = 'e2e/.artifacts';
const DIAG_PATH = `${ARTIFACTS}/55-chain-diag.json`;
const PIN = '2468';

const HERE = dirname(fileURLToPath(import.meta.url));
const deployments = JSON.parse(
  readFileSync(resolve(HERE, '../../../../packages/shared/src/deployments/10143.json'), 'utf8'),
) as { chainId: number; ticket: Hex; organizers: Hex };
const RPC = process.env.E2E_RPC_URL ?? 'https://testnet-rpc.monad.xyz';
const RELAYER = '0xFA93A9dB40a4396a8CdcF63991FA8615d1A35fFd' as const;
const monad = defineChain({
  id: deployments.chainId,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const chain = createPublicClient({ chain: monad, transport: http(RPC) });
const relayerMon = (): Promise<bigint> => chain.getBalance({ address: RELAYER });
const fmt = (wei: bigint): string => (Number(wei) / 1e18).toFixed(9);

const organizersAbi = [
  { type: 'function', name: 'gateOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  {
    type: 'function', name: 'gateInfo', stateMutability: 'view', inputs: [{ type: 'uint256' }],
    outputs: [
      { name: 'eventId', type: 'uint256' }, { name: 'account', type: 'address' },
      { name: 'kx', type: 'bytes32' }, { name: 'ky', type: 'bytes32' },
      { name: 'open', type: 'bool' }, { name: 'revoked', type: 'bool' },
    ],
  },
] as const;
const gateOf = (acct: Hex): Promise<bigint> =>
  chain.readContract({ address: deployments.organizers, abi: organizersAbi, functionName: 'gateOf', args: [acct] }) as Promise<bigint>;
const gateOpen = async (gateId: bigint): Promise<boolean> => {
  const info = (await chain.readContract({ address: deployments.organizers, abi: organizersAbi, functionName: 'gateInfo', args: [gateId] })) as readonly unknown[];
  return Boolean(info[4]);
};

const RECIPIENTS = [
  { role: '아티스트', pct: '60', tag: 'artist', addr: '0x1111111111111111111111111111111111111111' },
  { role: '공연장', pct: '20', tag: 'venue', addr: '0x2222222222222222222222222222222222222222' },
  { role: '기획', pct: '15', tag: 'planning', addr: '0x3333333333333333333333333333333333333333' },
];

test('55 · settlement chain — organiser + attendee + staff, one process', async ({ browser }) => {
  test.setTimeout(15 * 60 * 1000);
  mkdirSync(ARTIFACTS, { recursive: true });
  const attendeeA = USERS[0]!;
  const diag: Record<string, unknown> = { admin: ADMIN.id, attendeeA: attendeeA.id, startedAt: new Date().toISOString() };

  const admin = await openPersona(browser, ADMIN);
  let userA: PersonaSession | null = null;

  // ---- gate interception: inject the just-registered gate into the frozen GATES_QUERY so the
  // organiser's 열기 button renders and fires the REAL openGate write. ----
  let injectGate: { id: string; account: string; isOpen: boolean } | null = null;
  let injectEventId = '';
  await admin.context.route('**/graphql', async (route) => {
    const req = route.request();
    const body = req.postData() ?? '';
    if (req.method() === 'POST' && body.includes('EventGates') && injectGate) {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ data: { Gate: [{
          id: injectGate.id, eventId: injectEventId, account: injectGate.account,
          kx: `0x${'00'.repeat(32)}`, ky: `0x${'00'.repeat(32)}`,
          isOpen: injectGate.isOpen, revoked: false,
        }] } }),
      });
      return;
    }
    await route.continue();
  });

  try {
    const page = admin.page;
    await page.goto('/');
    await page.waitForTimeout(3000);
    await shot(page, 'landing');
    await ensureAccount(admin);
    await page.goto('/org');
    await page.waitForTimeout(3000);
    await shot(page, 'org-home-before-create');

    // =========================== STEP 1 — organiser policy + publish ===========================
    const b0 = await relayerMon().catch(() => 0n);
    diag.relayerStart = fmt(b0);
    console.log(`[55] relayer MON start ${fmt(b0)}`);
    const created = await createOrganizerAndEvent(page, {
      personaId: ADMIN.id, orgName: '몬티 정산 테스트', title: '정산 데모 공연 H5',
      intro: '프로그래머블 정산 데모 행사입니다.', venue: '서울 테스트홀',
      tiers: [{ kind: '무료', mode: '선착순', name: '일반', supply: 50 }],
    });
    expect(created.eventId, 'event created').not.toBeNull();
    const eventId = created.eventId!;
    injectEventId = eventId;
    diag.eventId = eventId;
    recordEvent('free', { id: eventId, published: false, title: '정산 데모 공연 H5' });
    const b1 = await relayerMon().catch(() => 0n);
    diag.costCreate = fmt(b0 - b1);
    console.log(`[55] STEP1 event=${eventId} createEvent=${fmt(b0 - b1)} MON`);

    // Open the dashboard; the price field renders from the chain fallback (indexer frozen).
    const card = page.locator('section.card', { has: page.getByRole('heading', { name: '정산 설정', exact: true }) });
    const priceInput = page.locator('input[placeholder="30"]');
    const t0 = Date.now();
    let priceReady = false;
    const priceDeadline = Date.now() + 150_000;
    while (Date.now() < priceDeadline) {
      await page.goto(`/org/events/${eventId}`);
      await page.waitForTimeout(2500);
      if (await page.getByRole('heading', { name: '정산 설정', exact: true }).isVisible().catch(() => false)
        && await priceInput.first().isVisible().catch(() => false)) { priceReady = true; break; }
      await page.waitForTimeout(3000);
    }
    diag.priceFieldRenderMs = Date.now() - t0;
    diag.priceFieldReady = priceReady;
    console.log(`[55] STEP1 price field ready=${priceReady} in ${diag.priceFieldRenderMs}ms (fallback under test)`);
    expect(priceReady, '정산 설정 price field must render (chain fallback)').toBe(true);

    await shot(page, 'org-dashboard-settlement-empty');
    await priceInput.first().fill(PRICE);
    const addRow = page.getByRole('button', { name: '수령인 추가', exact: true });
    for (let i = 0; i < RECIPIENTS.length; i++) { await addRow.click().catch(() => undefined); await page.waitForTimeout(300); }
    const rows = page.locator('li.split-row');
    for (let i = 0; i < RECIPIENTS.length; i++) {
      const row = rows.nth(i + 1); const r = RECIPIENTS[i]!;
      await row.locator('input').nth(0).fill(r.role, { force: true });
      await row.locator('input').nth(1).fill(r.pct, { force: true });
      await row.locator('input').nth(2).fill(r.tag, { force: true });
      const summary = row.locator('details.more summary');
      if (await summary.isVisible().catch(() => false)) await summary.click().catch(() => undefined);
      await row.locator('details.more input').first().fill(r.addr, { force: true });
    }
    const confirmBtn = page.getByRole('button', { name: '정산 규칙 확정', exact: true });
    await page.waitForTimeout(800);
    diag.sumText = (await card.locator('.settlement-sum').first().innerText().catch(() => '')) || '';
    expect(await confirmBtn.isDisabled().catch(() => true), '정산 규칙 확정 must be enabled').toBe(false);
    await shot(page, 'org-policy-form-filled');
    const policyClickAt = Date.now();
    await confirmBtn.click();
    await page.waitForTimeout(1000);
    await shot(page, 'org-policy-confirming');
    const publicLink = card.getByRole('link', { name: '정산 내역 보기', exact: true });
    const confirmedChip = card.getByText('정산 규칙 확정됨', { exact: true });
    let policyConfirmed = false;
    const cd = Date.now() + 120_000;
    while (Date.now() < cd) {
      if (await publicLink.isVisible().catch(() => false) || await confirmedChip.isVisible().catch(() => false)) { policyConfirmed = true; break; }
      await page.waitForTimeout(3000);
    }
    diag.policyConfirmed = policyConfirmed;
    diag.policyLatencyMs = Date.now() - policyClickAt;
    await shot(page, 'org-policy-confirmed');
    const b2 = await relayerMon().catch(() => 0n);
    diag.costSetPolicy = fmt(b1 - b2);
    console.log(`[55] STEP1 policy confirmed=${policyConfirmed} setPolicy=${fmt(b1 - b2)} MON`);
    expect(policyConfirmed, 'relaySetPolicy must confirm').toBe(true);

    const publishAt = Date.now();
    const publishResult = await publishEvent(page, ADMIN.id, eventId);
    diag.publishResult = publishResult;
    diag.publishLatencyMs = Date.now() - publishAt;
    await page.goto(`/org/events/${eventId}`);
    await page.waitForTimeout(3000);
    await shot(page, 'org-dashboard-published');
    recordEvent('free', { id: eventId, published: publishResult === 'published', title: '정산 데모 공연 H5' });
    const b3 = await relayerMon().catch(() => 0n);
    diag.costPublish = fmt(b2 - b3);
    console.log(`[55] STEP1 publish=${publishResult} publish=${fmt(b2 - b3)} MON`);
    expect(publishResult, 'event must publish').toBe('published');

    // =========================== STEP 2 — attendee A pays $30 ===========================
    userA = await openPersona(browser, attendeeA);
    const aPage = userA.page;
    const wire: { account?: string; orderId?: string; tokenId?: string; status?: string; txHash?: string } = {};
    aPage.on('response', (response: Response) => {
      void (async () => {
        try {
          const req = response.request();
          if (req.method() !== 'POST') return;
          const url = response.url().toLowerCase();
          const isPurchase = url.includes('purchaseticket');
          // tokenId can also land on a relay follow-up; capture it from any callable result.
          if (!isPurchase && !url.includes('relay')) return;
          if (isPurchase) {
            try { const b = JSON.parse(req.postData() ?? '') as { data?: { auth?: { account?: string } } }; if (b.data?.auth?.account) wire.account = b.data.auth.account; } catch { /* */ }
          }
          const parsed = JSON.parse(await response.text().catch(() => '')) as { result?: Record<string, unknown> };
          if (parsed.result) {
            wire.orderId = (parsed.result.orderId as string | undefined) ?? wire.orderId;
            wire.tokenId = (parsed.result.tokenId as string | undefined) ?? wire.tokenId;
            wire.status = (parsed.result.status as string | undefined) ?? wire.status;
            wire.txHash = (parsed.result.depositTxHash as string | undefined) ?? (parsed.result.txHash as string | undefined) ?? wire.txHash;
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
    await aPage.waitForTimeout(800);
    await shot(aPage, 'attendee-payment-sheet');
    await aPage.getByPlaceholder('0000 0000 0000 0000 (테스트)').fill('4242424242424242');
    // The sheet's own button reads "$30.00 결제하기"; the claim CTA behind it keeps 결제하고 받기.
    const payBtn = sheet.getByRole('button', { name: /결제하기/ });
    await expect(payBtn).toBeEnabled({ timeout: 10_000 });
    await shot(aPage, 'attendee-payment-card-filled');
    const payClickAt = Date.now();
    await payBtn.click();
    await aPage.waitForTimeout(1000);
    await shot(aPage, 'attendee-payment-processing');
    const doneAlert = sheet.getByText('결제 완료 · 티켓을 받았어요', { exact: true });
    const toTickets = sheet.getByRole('link', { name: /^(영수증 보기|내 티켓 보기)$/ });
    let purchased = false;
    const pd = Date.now() + 180_000;
    while (Date.now() < pd) {
      if (await doneAlert.isVisible().catch(() => false) || await toTickets.isVisible().catch(() => false)) { purchased = true; break; }
      await aPage.waitForTimeout(2000);
    }
    diag.purchased = purchased; diag.wire = { ...wire };
    diag.purchaseLatencyMs = Date.now() - payClickAt;
    await shot(aPage, 'attendee-payment-done');
    console.log(`[55] STEP2 purchased=${purchased} latency=${diag.purchaseLatencyMs}ms wire=${JSON.stringify(wire)}`);
    expect(purchased, 'purchase reaches 결제 완료').toBe(true);
    expect(wire.tokenId, 'tokenId captured from purchaseTicket').toBeTruthy();
    const tokenId = wire.tokenId!;
    diag.tokenId = tokenId; diag.attendeeAccount = wire.account;

    // Go straight to the detail by captured tokenId (the LIST has no chain fallback).
    await aPage.goto(`/tickets/${tokenId}`);
    await expect(aPage.getByRole('heading', { name: '영수증', exact: true })).toBeVisible({ timeout: 45_000 });
    const heldLine = aPage.getByText('결제 금액 보관 중 · 입장하면 자동으로 나눠 보내요', { exact: true });
    let held = false; const hd = Date.now() + 60_000;
    while (Date.now() < hd) { if (await heldLine.isVisible().catch(() => false)) { held = true; break; } await aPage.waitForTimeout(2000); }
    diag.receiptHeld = held;
    console.log(`[55] STEP2 receipt 보관 중=${held}`);
    await aPage.screenshot({ path: `${ARTIFACTS}/55-step2-receipt-held.png`, fullPage: true }).catch(() => undefined);
    await shot(aPage, 'attendee-receipt-held');
    await aPage.goto('/tickets');
    await aPage.waitForTimeout(4000);
    await shot(aPage, 'attendee-ticket-list');
    const b4 = await relayerMon().catch(() => 0n);
    diag.costPurchase = fmt(b3 - b4);
    console.log(`[55] STEP2 purchase(mint+deposit) relayer=${fmt(b3 - b4)} MON`);
    expect(held, 'receipt reads 보관 중 (escrow Held)').toBe(true);

    // =========================== STEP 3 — staff manual override ===========================
    const relaySubs: Array<{ status?: string; relayId?: string; txHash?: string; from?: string }> = [];
    page.on('response', (response: Response) => {
      void (async () => {
        try {
          const req = response.request();
          if (req.method() !== 'POST' || !response.url().toLowerCase().includes('relayaction')) return;
          let from: string | undefined;
          try { const b = JSON.parse(req.postData() ?? '') as { data?: { req?: { from?: string } } }; from = b.data?.req?.from; } catch { /* */ }
          const parsed = JSON.parse(await response.text().catch(() => '')) as { result?: Record<string, unknown> };
          if (parsed.result) relaySubs.push({ status: parsed.result.status as string, relayId: parsed.result.relayId as string, txHash: parsed.result.txHash as string, from });
        } catch { /* */ }
      })();
    });

    // PHASE A — staff device files a pending gate. Sniff submitPendingGate for the gate account.
    let gateAccount: string | undefined;
    page.on('response', (response: Response) => {
      void (async () => {
        try {
          const req = response.request();
          if (req.method() !== 'POST' || !response.url().toLowerCase().includes('submitpendinggate')) return;
          const b = JSON.parse(req.postData() ?? '') as { data?: { gateAccount?: string } };
          if (b.data?.gateAccount) gateAccount = b.data.gateAccount;
        } catch { /* */ }
      })();
    });
    await page.goto('/staff/setup');
    const eventField = page.getByLabel('행사 번호');
    await expect(eventField).toBeVisible({ timeout: 30_000 });
    await eventField.fill(eventId);
    await shot(page, 'staff-setup-event-number');
    await page.getByRole('button', { name: '이 행사에 등록 요청', exact: true }).click();
    await expect(page.getByText('등록을 요청했어요. 관리자가 승인하면 이 화면이 저절로 넘어가요.', { exact: true })
      .or(page.getByText('게이트 계정 주소', { exact: true })).first()).toBeVisible({ timeout: 45_000 });
    await page.waitForTimeout(2000);
    await shot(page, 'staff-setup-pending');
    if (!gateAccount) {
      // fallback: read the shown account value off the setup screen
      gateAccount = (await page.locator('input[value^="0x"]').first().inputValue().catch(() => '')) || undefined;
    }
    diag.gateAccount = gateAccount;
    console.log(`[55] STEP3-A pending filed, gateAccount=${gateAccount}`);
    expect(gateAccount, 'gate account captured').toBeTruthy();

    // PHASE B — organiser approves (registerGate) then opens (openGate via injected gate row).
    await page.goto(`/org/events/${eventId}/gates`);
    await expect(page.getByRole('heading', { name: '승인을 기다리는 단말기', exact: true })).toBeVisible({ timeout: 30_000 });
    const registerBtn = page.getByRole('button', { name: '등록', exact: true }).first();
    await expect(registerBtn).toBeVisible({ timeout: 30_000 });
    await shot(page, 'org-gates-pending-register');
    const registerClickAt = Date.now();
    await registerBtn.click();
    console.log('[55] STEP3-B registerGate sent; polling chain for gateId');
    let gateId = 0n; const gd = Date.now() + 120_000;
    while (Date.now() < gd) { gateId = await gateOf(gateAccount as Hex).catch(() => 0n); if (gateId !== 0n) break; await page.waitForTimeout(4000); }
    diag.gateId = gateId.toString();
    diag.registerLatencyMs = Date.now() - registerClickAt;
    await shot(page, 'org-gates-after-register');
    console.log(`[55] STEP3-B registered gateId=${gateId} in ${diag.registerLatencyMs}ms`);
    expect(gateId, 'registerGate landed on chain').not.toBe(0n);
    const b5 = await relayerMon().catch(() => 0n);
    diag.costRegister = fmt(b4 - b5);

    // The registered list now has a chain fallback (gateInfo probing) and the indexer is live, so
    // first try the REAL list; inject the registered gate only if 열기 does not render natively.
    const openBtn = page.getByRole('button', { name: '열기', exact: true }).first();
    let nativeOpen = false; const nd = Date.now() + 60_000;
    while (Date.now() < nd) {
      await page.goto(`/org/events/${eventId}/gates`);
      if (await openBtn.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false)) { nativeOpen = true; break; }
      await page.waitForTimeout(3000);
    }
    diag.gateListNative = nativeOpen;
    if (!nativeOpen) {
      console.log('[55] STEP3-B 열기 not rendered natively in 60s — injecting gate row (fallback)');
      injectGate = { id: gateId.toString(), account: gateAccount as string, isOpen: false };
      await page.goto(`/org/events/${eventId}/gates`);
    }
    await expect(openBtn).toBeVisible({ timeout: 30_000 });
    await shot(page, 'org-gates-registered-open-button');
    const openClickAt = Date.now();
    await openBtn.click();
    console.log('[55] STEP3-B openGate sent; polling chain for open=true');
    let opened = false; const od = Date.now() + 120_000;
    while (Date.now() < od) { if (await gateOpen(gateId).catch(() => false)) { opened = true; break; } await page.waitForTimeout(4000); }
    if (injectGate) injectGate.isOpen = true;
    diag.gateOpened = opened;
    diag.openLatencyMs = Date.now() - openClickAt;
    await page.waitForTimeout(2000);
    await shot(page, 'org-gates-opened');
    const b6 = await relayerMon().catch(() => 0n);
    diag.costOpen = fmt(b5 - b6);
    console.log(`[55] STEP3-B gate open=${opened} openGate=${fmt(b5 - b6)} MON`);
    expect(opened, 'openGate landed on chain').toBe(true);

    // PHASE C — staff setup now reads registered+open from chain; set PIN; open console.
    await page.goto('/staff/setup');
    await expect(page.getByRole('heading', { name: '등록됐어요', exact: true })).toBeVisible({ timeout: 60_000 });
    await shot(page, 'staff-setup-registered');
    await page.getByLabel('새 PIN').fill(PIN);
    await page.getByLabel('한 번 더').fill(PIN);
    await page.getByRole('button', { name: 'PIN 저장', exact: true }).click();
    await expect(page.getByText('PIN을 저장했어요.', { exact: true })).toBeVisible({ timeout: 15_000 });
    const startBtn = page.getByRole('button', { name: '입장 받기 시작', exact: true });
    await expect(startBtn).toBeVisible({ timeout: 90_000 });
    await shot(page, 'staff-setup-pin-saved');
    await startBtn.click();
    await page.waitForURL(/\/staff\/gate/, { timeout: 20_000 });
    await page.waitForTimeout(2500);
    await shot(page, 'staff-console');
    console.log('[55] STEP3-C console opened');

    // PHASE D — manual override by tokenId (chain fallback resolves the just-minted ticket).
    const openOverrideBtn = page.getByRole('button', { name: '수동 승인하기', exact: true });
    let approved = false; let lastDetail = ''; let approveClickAt = 0;
    for (let attempt = 0; attempt < 4 && !approved; attempt++) {
      await expect(openOverrideBtn).toBeVisible({ timeout: 60_000 });
      await openOverrideBtn.click();
      const searchBox = page.getByLabel('이름 또는 표 번호');
      await expect(searchBox).toBeVisible({ timeout: 10_000 });
      await searchBox.fill(tokenId);
      const match = page.locator('.gate-dialog__matches li button').first();
      let hasMatch = false; const md = Date.now() + 20_000;
      while (Date.now() < md) { if (await match.isVisible().catch(() => false)) { hasMatch = true; break; } await page.waitForTimeout(1500); }
      if (!hasMatch) {
        lastDetail = 'no match (chain resolve)';
        await page.getByRole('button', { name: '취소', exact: true }).click().catch(() => undefined);
        await page.goto('/staff/gate'); await page.waitForTimeout(6000); continue;
      }
      await shot(page, 'staff-override-search-match');
      await match.click();
      await expect(page.getByText('들여보낼 사람', { exact: true })).toBeVisible({ timeout: 5000 });
      await page.getByLabel('PIN').fill(PIN);
      const approveBtn = page.getByRole('button', { name: '수동 승인', exact: true });
      await expect(approveBtn).toBeVisible({ timeout: 20_000 });
      await shot(page, 'staff-override-confirm-dialog');
      approveClickAt = Date.now();
      diag.overrideClickedAt = new Date(approveClickAt).toISOString();
      await approveBtn.click();
      await page.waitForTimeout(800);
      await shot(page, 'staff-override-sending');
      const approvedLine = page.getByText('들여보냈어요.', { exact: true });
      const failedLine = page.getByText('보내지 못했어요. 다시 해 보세요.', { exact: true });
      const deniedLine = page.getByText('이 계정에는 손으로 들여보낼 권한이 없어요. 관리자에게 문의하세요.', { exact: true });
      const ovd = Date.now() + 90_000;
      while (Date.now() < ovd) {
        if (await approvedLine.isVisible().catch(() => false)) { approved = true; break; }
        if (await deniedLine.isVisible().catch(() => false)) { lastDetail = 'denied'; break; }
        if (await failedLine.isVisible().catch(() => false)) { lastDetail = 'failed'; break; }
        await page.waitForTimeout(2000);
      }
      if (!approved && lastDetail === 'denied') break;
      if (!approved) { await page.goto('/staff/gate'); await page.waitForTimeout(6000); }
    }
    diag.overrideApproved = approved; diag.lastDetail = lastDetail;
    diag.overrideRelay = relaySubs[relaySubs.length - 1] ?? null;
    diag.relaySubs = relaySubs;
    diag.overrideConfirmedAt = new Date().toISOString();
    diag.overrideLatencyMs = approveClickAt ? Date.now() - approveClickAt : null;
    await shot(page, 'staff-override-approved');
    const b7 = await relayerMon().catch(() => 0n);
    diag.costOverride = fmt(b6 - b7);
    console.log(`[55] STEP3-D approved=${approved} override=${fmt(b6 - b7)} MON relay=${JSON.stringify(diag.overrideRelay)}`);
    await page.screenshot({ path: `${ARTIFACTS}/55-step3-override.png`, fullPage: true }).catch(() => undefined);
    expect(approved, `manual override lands on 들여보냈어요 (lastDetail=${lastDetail})`).toBe(true);

    // =========================== STEP 4 — receipt flips to 정산 완료 (inline release) ===========
    await aPage.goto(`/tickets/${tokenId}`);
    const releasedLine = aPage.getByText('정산 완료 · 정해진 비율대로 나눠 보냈어요', { exact: true });
    let released = false; const rd = Date.now() + 120_000;
    while (Date.now() < rd) { if (await releasedLine.isVisible().catch(() => false)) { released = true; break; } await aPage.goto(`/tickets/${tokenId}`); await aPage.waitForTimeout(4000); }
    diag.receiptReleased = released;
    diag.releaseObservedAt = new Date().toISOString();
    diag.releaseUiLatencyFromOverrideClickMs = approveClickAt ? Date.now() - approveClickAt : null;
    console.log(`[55] STEP4 receipt 정산 완료=${released}`);
    await aPage.screenshot({ path: `${ARTIFACTS}/55-step4-receipt-released.png`, fullPage: true }).catch(() => undefined);
    await shot(aPage, 'attendee-receipt-settled');
    await aPage.goto(`/settlement/${eventId}`);
    await aPage.waitForTimeout(5000);
    await shot(aPage, 'public-settlement-page');
    await page.goto(`/org/events/${eventId}`);
    await page.waitForTimeout(4000);
    await shot(page, 'org-dashboard-after-settlement');
    // best-effort (release is verified on chain regardless); do not fail the chain on a slow mirror
    if (!released) console.log('[55] STEP4 receipt not yet flipped in-window — verify release on chain');
  } finally {
    diag.finishedAt = new Date().toISOString();
    writeFileSync(DIAG_PATH, JSON.stringify(diag, null, 2));
    console.log(`[55] diag written: ${DIAG_PATH}`);
    if (userA) await closePersona(userA).catch(() => undefined);
    await closePersona(admin).catch(() => undefined);
  }
});
