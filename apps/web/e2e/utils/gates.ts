import { expect, type Page, type Response } from '@playwright/test';
import type { Hex } from 'viem';
import { gateOf, gateOpen, pollUntil } from './chain';
import { shot } from './shots';

/** Copy strings, verbatim from apps/web/src/staff/copy.ts and organizer/copy.ts (gates). */
const S = {
  eventLabel: '행사 번호',
  apply: '이 행사에 등록 요청',
  submitted: '등록을 요청했어요. 관리자가 승인하면 이 화면이 저절로 넘어가요.',
  pendingHeading: '승인을 기다리는 단말기',
  register: '등록',
  // v2 (design D3): registerGate opens the terminal; 다시 열기 exists only for one that was closed.
  reopen: '다시 열기',
  legacyOpen: '열기',
  registered: '등록됐어요',
  newPin: '새 PIN',
  pinAgain: '한 번 더',
  savePin: 'PIN 저장',
  pinSaved: 'PIN을 저장했어요.',
  start: '입장 받기 시작',
  openOverride: '수동 승인하기',
  search: '이름 또는 티켓 번호',
  chosen: '들여보낼 사람',
  pin: 'PIN',
  approve: '수동 승인',
  approved: '들여보냈어요.',
  requested: '요청됨 — 승인 대기',
  failed: '보내지 못했어요. 다시 해 보세요.',
  denied: '이 계정에는 손으로 들여보낼 권한이 없어요. 관리자에게 문의하세요.',
  cancel: '취소',
} as const;

/** PHASE A — the staff device (this page) files a pending gate for `eventId`; answers its account. */
export async function fileGateRequest(page: Page, eventId: string): Promise<Hex> {
  let gateAccount: string | undefined;
  const sniff = (response: Response): void => {
    void (async () => {
      try {
        const req = response.request();
        if (req.method() !== 'POST' || !response.url().toLowerCase().includes('submitpendinggate')) return;
        const body = JSON.parse(req.postData() ?? '') as { data?: { gateAccount?: string } };
        if (body.data?.gateAccount) gateAccount = body.data.gateAccount;
      } catch { /* capture never throws */ }
    })();
  };
  page.on('response', sniff);
  try {
    await page.goto('/staff/setup');
    const field = page.getByLabel(S.eventLabel);
    await expect(field).toBeVisible({ timeout: 30_000 });
    await field.fill(eventId);
    await shot(page, 'staff-setup-event-number');
    await page.getByRole('button', { name: S.apply, exact: true }).click();
    // The fallback block shows only a short device name; its full account rides on `data-gate-account`.
    await expect(page.getByText(S.submitted, { exact: true }).or(page.locator('[data-gate-account]')).first())
      .toBeVisible({ timeout: 45_000 });
    await page.waitForTimeout(2000);
    await shot(page, 'staff-setup-pending');
    if (!gateAccount) gateAccount = (await page.locator('[data-gate-account]').first().getAttribute('data-gate-account').catch(() => null)) ?? undefined;
  } finally {
    page.off('response', sniff);
  }
  expect(gateAccount, 'gate account captured').toBeTruthy();
  return gateAccount as Hex;
}

export interface GateApproval {
  gateId: bigint;
  /** 등록 → on-chain registration, ms. */
  registerMs: number;
  /** True when the gate was open on chain right after registration (the v2 behaviour). */
  openOnRegister: boolean;
  /** True when a separate 열기/다시 열기 press was still needed (tolerated, recorded). */
  openedSeparately: boolean;
}

/**
 * PHASE B — the organiser approves the pending terminal (등록 → one `registerGate`). v2 opens it in
 * the same write, so the gate must read open on chain without any 열기 step. If a build still shows
 * an open button and the chain says closed, it is pressed once and `openedSeparately` records it.
 */
export async function approveGate(page: Page, eventId: string, gateAccount: Hex): Promise<GateApproval> {
  let gateId = await gateOf(gateAccount);
  let registerMs = 0;
  if (gateId === 0n) {
    await page.goto(`/org/events/${eventId}/gates`);
    await expect(page.getByRole('heading', { name: S.pendingHeading, exact: true })).toBeVisible({ timeout: 30_000 });
    const registerBtn = page.getByRole('button', { name: S.register, exact: true }).first();
    await expect(registerBtn).toBeVisible({ timeout: 30_000 });
    await shot(page, 'org-gates-pending-register');
    const at = Date.now();
    await registerBtn.click();
    gateId = await pollUntil(() => gateOf(gateAccount), 120_000);
    registerMs = Date.now() - at;
    await shot(page, 'org-gates-after-register');
  }
  expect(gateId, 'registerGate landed on chain').not.toBe(0n);

  const openOnRegister = await pollUntil(() => gateOpen(gateId), 20_000, 2000);
  let openedSeparately = false;
  if (!openOnRegister) {
    await page.goto(`/org/events/${eventId}/gates`);
    const openBtn = page.getByRole('button', { name: S.reopen, exact: true })
      .or(page.getByRole('button', { name: S.legacyOpen, exact: true })).first();
    if (await openBtn.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true).catch(() => false)) {
      await openBtn.click();
      openedSeparately = await pollUntil(() => gateOpen(gateId), 120_000);
    }
  }
  expect(openOnRegister || openedSeparately, 'gate open on chain').toBe(true);
  return { gateId, registerMs, openOnRegister, openedSeparately };
}

/** PHASE C — the setup screen reads registered+open from chain; set the PIN; open the console. */
export async function startConsole(page: Page, pin: string): Promise<void> {
  await page.goto('/staff/setup');
  await expect(page.getByRole('heading', { name: S.registered, exact: true })).toBeVisible({ timeout: 60_000 });
  await shot(page, 'staff-setup-registered');
  await page.getByLabel(S.newPin).fill(pin);
  await page.getByLabel(S.pinAgain).fill(pin);
  await page.getByRole('button', { name: S.savePin, exact: true }).click();
  await expect(page.getByText(S.pinSaved, { exact: true })).toBeVisible({ timeout: 15_000 });
  const start = page.getByRole('button', { name: S.start, exact: true });
  await expect(start).toBeVisible({ timeout: 90_000 });
  await shot(page, 'staff-setup-pin-saved');
  await start.click();
  await page.waitForURL(/\/staff\/gate/, { timeout: 20_000 });
  await page.waitForTimeout(2500);
  await shot(page, 'staff-console');
}

export interface OverrideOutcome {
  /** `approved` — manualOverride landed (들여보냈어요); `requested` — the off-chain request was filed. */
  result: 'approved' | 'requested' | 'failed';
  lastDetail: string;
  /** 수동 승인 pressed → outcome shown, ms. */
  latencyMs: number | null;
  /** Bodies of the `requestOverride` callable this page sent (v2 P4: no chain write). */
  requestCalls: unknown[];
}

/**
 * PHASE D — 수동 승인하기 → search by tokenId → PIN → 수동 승인. An approver's press is one relayed
 * `manualOverride` (→ 들여보냈어요); a manager without approval files `requestOverride` with the
 * backend instead (→ 요청됨 — 승인 대기, no chain write). The snapshot may lag a just-minted ticket,
 * so a miss is retried by reloading the console.
 */
export async function admitByOverride(page: Page, tokenId: string, pin: string): Promise<OverrideOutcome> {
  const requestCalls: unknown[] = [];
  const sniff = (response: Response): void => {
    try {
      const req = response.request();
      if (req.method() !== 'POST' || !response.url().toLowerCase().includes('requestoverride')) return;
      requestCalls.push(JSON.parse(req.postData() ?? 'null'));
    } catch { /* capture never throws */ }
  };
  page.on('response', sniff);
  let result: OverrideOutcome['result'] = 'failed';
  let lastDetail = '';
  let pressedAt = 0;
  let outcomeAt = 0;
  try {
    const openBtn = page.getByRole('button', { name: S.openOverride, exact: true });
    for (let attempt = 0; attempt < 4 && result === 'failed'; attempt++) {
      await expect(openBtn).toBeVisible({ timeout: 60_000 });
      await openBtn.click();
      const search = page.getByLabel(S.search);
      await expect(search).toBeVisible({ timeout: 10_000 });
      await search.fill(tokenId);
      const match = page.locator('.gate-dialog__matches li button').first();
      const found = await match.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true).catch(() => false);
      if (!found) {
        lastDetail = 'no match (snapshot lag)';
        await page.getByRole('button', { name: S.cancel, exact: true }).click().catch(() => undefined);
        await page.goto('/staff/gate');
        await page.waitForTimeout(6000);
        continue;
      }
      await shot(page, 'staff-override-search-match');
      await match.click();
      await expect(page.getByText(S.chosen, { exact: true })).toBeVisible({ timeout: 5000 });
      await page.getByLabel(S.pin, { exact: true }).fill(pin);
      const approveBtn = page.getByRole('button', { name: S.approve, exact: true });
      await expect(approveBtn).toBeVisible({ timeout: 20_000 });
      await shot(page, 'staff-override-confirm-dialog');
      pressedAt = Date.now();
      await approveBtn.click();
      await page.waitForTimeout(800);
      await shot(page, 'staff-override-sending');
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        if (await page.getByText(S.approved, { exact: true }).isVisible().catch(() => false)) { result = 'approved'; outcomeAt = Date.now(); break; }
        if (await page.getByText(S.requested, { exact: true }).isVisible().catch(() => false)) { result = 'requested'; outcomeAt = Date.now(); break; }
        if (await page.getByText(S.denied, { exact: true }).isVisible().catch(() => false)) { lastDetail = 'denied'; break; }
        if (await page.getByText(S.failed, { exact: true }).isVisible().catch(() => false)) { lastDetail = 'failed'; break; }
        await page.waitForTimeout(2000);
      }
      if (result === 'failed' && lastDetail === 'denied') break;
      if (result === 'failed') { await page.goto('/staff/gate'); await page.waitForTimeout(6000); }
    }
    await shot(page, `staff-override-${result}`);
  } finally {
    page.off('response', sniff);
  }
  return { result, lastDetail, latencyMs: pressedAt && outcomeAt ? outcomeAt - pressedAt : null, requestCalls };
}
