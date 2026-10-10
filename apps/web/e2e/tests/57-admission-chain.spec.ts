import { expect, test, type Response } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createPublicClient, defineChain, http, type Hex } from 'viem';
import { ADMIN } from '../fixtures/personas';
import { closePersona, ensureAccount, openPersona } from '../utils/session';

/**
 * Batch H — Run 5, step 3 as a SALVAGE/resume spec: admit an already-purchased (escrow HELD) ticket
 * on an existing published event, reusing the organiser/admin session. Same gate-open interception
 * as 55 (the frozen GATES_QUERY has no chain fallback, so the 열기 button is injected and the open
 * WRITE it fires is real). Takes EVENT_ID + TOKEN_ID. Reuses ADMIN (E2E_ADMIN) — if passkey reuse
 * does not hold, ensureAccount throws and the salvage is impossible without re-running the chain.
 */

const ARTIFACTS = 'e2e/.artifacts';
const DIAG_PATH = `${ARTIFACTS}/57-admission-diag.json`;
const EVENT_ID = process.env.EVENT_ID ?? '';
const TOKEN_ID = process.env.TOKEN_ID ?? '';
const PIN = '2468';

const HERE = dirname(fileURLToPath(import.meta.url));
const deployments = JSON.parse(
  readFileSync(resolve(HERE, '../../../../packages/shared/src/deployments/10143.json'), 'utf8'),
) as { chainId: number; organizers: Hex };
const RPC = process.env.E2E_RPC_URL ?? 'https://testnet-rpc.monad.xyz';
const RELAYER = '0xFA93A9dB40a4396a8CdcF63991FA8615d1A35fFd' as const;
const monad = defineChain({ id: deployments.chainId, name: 'Monad Testnet', nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const chain = createPublicClient({ chain: monad, transport: http(RPC) });
const relayerMon = (): Promise<bigint> => chain.getBalance({ address: RELAYER });
const fmt = (wei: bigint): string => (Number(wei) / 1e18).toFixed(9);
const organizersAbi = [
  { type: 'function', name: 'gateOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'gateInfo', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [
    { name: 'eventId', type: 'uint256' }, { name: 'account', type: 'address' }, { name: 'kx', type: 'bytes32' },
    { name: 'ky', type: 'bytes32' }, { name: 'open', type: 'bool' }, { name: 'revoked', type: 'bool' }] },
] as const;
const gateOf = (acct: Hex): Promise<bigint> => chain.readContract({ address: deployments.organizers, abi: organizersAbi, functionName: 'gateOf', args: [acct] }) as Promise<bigint>;
const gateOpen = async (gateId: bigint): Promise<boolean> => {
  const info = (await chain.readContract({ address: deployments.organizers, abi: organizersAbi, functionName: 'gateInfo', args: [gateId] })) as readonly unknown[];
  return Boolean(info[4]);
};

test('57 · settlement step 3 (salvage) — organiser admits a HELD ticket, one process', async ({ browser }) => {
  test.setTimeout(12 * 60 * 1000);
  expect(EVENT_ID, 'EVENT_ID').not.toBe('');
  expect(TOKEN_ID, 'TOKEN_ID').not.toBe('');
  mkdirSync(ARTIFACTS, { recursive: true });
  const eventId = EVENT_ID; const tokenId = TOKEN_ID;
  const diag: Record<string, unknown> = { admin: ADMIN.id, eventId, tokenId, startedAt: new Date().toISOString() };

  const admin = await openPersona(browser, ADMIN);
  let injectGate: { id: string; account: string; isOpen: boolean } | null = null;
  await admin.context.route('**/graphql', async (route) => {
    const req = route.request(); const body = req.postData() ?? '';
    if (req.method() === 'POST' && body.includes('EventGates') && injectGate) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { Gate: [{
        id: injectGate.id, eventId, account: injectGate.account, kx: `0x${'00'.repeat(32)}`, ky: `0x${'00'.repeat(32)}`,
        isOpen: injectGate.isOpen, revoked: false }] } }) });
      return;
    }
    await route.continue();
  });

  try {
    const page = admin.page;
    const relaySubs: Array<{ status?: string; relayId?: string; txHash?: string; from?: string }> = [];
    let gateAccount: string | undefined;
    page.on('response', (response: Response) => {
      void (async () => {
        try {
          const req = response.request();
          if (req.method() !== 'POST') return;
          const url = response.url().toLowerCase();
          if (url.includes('submitpendinggate')) {
            try { const b = JSON.parse(req.postData() ?? '') as { data?: { gateAccount?: string } }; if (b.data?.gateAccount) gateAccount = b.data.gateAccount; } catch { /* */ }
          }
          if (url.includes('relayaction')) {
            let from: string | undefined;
            try { const b = JSON.parse(req.postData() ?? '') as { data?: { req?: { from?: string } } }; from = b.data?.req?.from; } catch { /* */ }
            const parsed = JSON.parse(await response.text().catch(() => '')) as { result?: Record<string, unknown> };
            if (parsed.result) relaySubs.push({ status: parsed.result.status as string, relayId: parsed.result.relayId as string, txHash: parsed.result.txHash as string, from });
          }
        } catch { /* */ }
      })();
    });

    await ensureAccount(admin); // reuse the organiser session (throws if the passkey does not hold)
    const bA = await relayerMon().catch(() => 0n);
    diag.relayerStart = fmt(bA);

    // PHASE A — (re-)file the pending gate; the gate key is restored from this persona's IndexedDB.
    await page.goto('/staff/setup');
    const eventField = page.getByLabel('행사 번호');
    await expect(eventField).toBeVisible({ timeout: 30_000 });
    await eventField.fill(eventId);
    await page.getByRole('button', { name: '이 행사에 등록 요청', exact: true }).click();
    await expect(page.getByText('등록을 요청했어요. 관리자가 승인하면 이 화면이 저절로 넘어가요.', { exact: true })
      .or(page.getByText('게이트 계정 주소', { exact: true })).first()).toBeVisible({ timeout: 45_000 });
    await page.waitForTimeout(2500);
    if (!gateAccount) gateAccount = (await page.locator('input[value^="0x"]').first().inputValue().catch(() => '')) || undefined;
    // The gate may already be registered from a prior attempt; resolve its id either way.
    let gateId = gateAccount ? await gateOf(gateAccount as Hex).catch(() => 0n) : 0n;
    diag.gateAccount = gateAccount;
    console.log(`[57] PHASE A gateAccount=${gateAccount} preGateId=${gateId}`);
    expect(gateAccount, 'gate account captured').toBeTruthy();

    // PHASE B — approve (registerGate) if needed, then open (openGate via injected row).
    await page.goto(`/org/events/${eventId}/gates`);
    await expect(page.getByRole('heading', { name: '승인을 기다리는 단말기', exact: true })).toBeVisible({ timeout: 30_000 });
    if (gateId === 0n) {
      const registerBtn = page.getByRole('button', { name: '등록', exact: true }).first();
      if (await registerBtn.isVisible().catch(() => false)) {
        await registerBtn.click();
        const gd = Date.now() + 120_000;
        while (Date.now() < gd) { gateId = await gateOf(gateAccount as Hex).catch(() => 0n); if (gateId !== 0n) break; await page.waitForTimeout(4000); }
      }
    }
    diag.gateId = gateId.toString();
    console.log(`[57] PHASE B gateId=${gateId}`);
    expect(gateId, 'gate registered on chain').not.toBe(0n);

    let opened = await gateOpen(gateId).catch(() => false);
    if (!opened) {
      injectGate = { id: gateId.toString(), account: gateAccount as string, isOpen: false };
      await page.goto(`/org/events/${eventId}/gates`);
      const openBtn = page.getByRole('button', { name: '열기', exact: true }).first();
      await expect(openBtn).toBeVisible({ timeout: 30_000 });
      await openBtn.click();
      const od = Date.now() + 120_000;
      while (Date.now() < od) { if (await gateOpen(gateId).catch(() => false)) { opened = true; break; } await page.waitForTimeout(4000); }
    }
    injectGate = { id: gateId.toString(), account: gateAccount as string, isOpen: true };
    diag.gateOpened = opened;
    console.log(`[57] PHASE B gate open=${opened}`);
    expect(opened, 'gate open on chain').toBe(true);

    // PHASE C — staff setup reads registered+open from chain; PIN; console.
    await page.goto('/staff/setup');
    await expect(page.getByRole('heading', { name: '등록됐어요', exact: true })).toBeVisible({ timeout: 60_000 });
    await page.getByLabel('새 PIN').fill(PIN);
    await page.getByLabel('한 번 더').fill(PIN);
    await page.getByRole('button', { name: 'PIN 저장', exact: true }).click();
    await expect(page.getByText('PIN을 저장했어요.', { exact: true })).toBeVisible({ timeout: 15_000 });
    const startBtn = page.getByRole('button', { name: '입장 받기 시작', exact: true });
    await expect(startBtn).toBeVisible({ timeout: 90_000 });
    await startBtn.click();
    await page.waitForURL(/\/staff\/gate/, { timeout: 20_000 });
    console.log('[57] PHASE C console opened');

    // PHASE D — override by tokenId (chain fallback resolves the HELD ticket).
    const bOv = await relayerMon().catch(() => 0n);
    const openOverrideBtn = page.getByRole('button', { name: '수동 승인하기', exact: true });
    let approved = false; let lastDetail = '';
    for (let attempt = 0; attempt < 4 && !approved; attempt++) {
      await expect(openOverrideBtn).toBeVisible({ timeout: 60_000 });
      await openOverrideBtn.click();
      const searchBox = page.getByLabel('이름 또는 티켓 번호');
      await expect(searchBox).toBeVisible({ timeout: 10_000 });
      await searchBox.fill(tokenId);
      const match = page.locator('.gate-dialog__matches li button').first();
      let hasMatch = false; const md = Date.now() + 20_000;
      while (Date.now() < md) { if (await match.isVisible().catch(() => false)) { hasMatch = true; break; } await page.waitForTimeout(1500); }
      if (!hasMatch) { lastDetail = 'no match'; await page.getByRole('button', { name: '취소', exact: true }).click().catch(() => undefined); await page.goto('/staff/gate'); await page.waitForTimeout(6000); continue; }
      await match.click();
      await expect(page.getByText('들여보낼 사람', { exact: true })).toBeVisible({ timeout: 5000 });
      await page.getByLabel('PIN').fill(PIN);
      const approveBtn = page.getByRole('button', { name: '수동 승인', exact: true });
      await expect(approveBtn).toBeVisible({ timeout: 20_000 });
      await approveBtn.click();
      const approvedLine = page.getByText('들여보냈어요.', { exact: true });
      const deniedLine = page.getByText('이 계정에는 손으로 들여보낼 권한이 없어요. 관리자에게 문의하세요.', { exact: true });
      const failedLine = page.getByText('보내지 못했어요. 다시 해 보세요.', { exact: true });
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
    const bAf = await relayerMon().catch(() => 0n);
    diag.overrideApproved = approved; diag.lastDetail = lastDetail;
    diag.overrideRelay = relaySubs[relaySubs.length - 1] ?? null;
    diag.overrideConfirmedAt = new Date().toISOString();
    diag.costOverride = fmt(bOv - bAf);
    console.log(`[57] PHASE D approved=${approved} override=${fmt(bOv - bAf)} MON relay=${JSON.stringify(diag.overrideRelay)}`);
    await page.screenshot({ path: `${ARTIFACTS}/57-override.png`, fullPage: true }).catch(() => undefined);
    expect(approved, `manual override lands on 들여보냈어요 (lastDetail=${lastDetail})`).toBe(true);
  } finally {
    diag.finishedAt = new Date().toISOString();
    writeFileSync(DIAG_PATH, JSON.stringify(diag, null, 2));
    console.log(`[57] diag written: ${DIAG_PATH}`);
    await closePersona(admin).catch(() => undefined);
  }
});
