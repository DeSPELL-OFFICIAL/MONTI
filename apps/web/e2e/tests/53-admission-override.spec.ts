import { expect, test, type Response } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ADMIN } from '../fixtures/personas';
import { closePersona, ensureAccount, openPersona } from '../utils/session';

/**
 * Batch H — step 3 (admission) live against production. The organiser (E2E_ADMIN, persona-07 on
 * Run 4) admits the attendee's held ticket through the STAFF gate console's manual-override flow,
 * end to end in one in-process session (the gate device key lives in IndexedDB for the whole run,
 * so this is not split across commands):
 *
 *   A. /staff/setup — file a fresh pending gate for the event (submitPendingGate).
 *   B. /org/events/<id>/gates — approve it (등록 → registerGate) and open it (열기 → openGate).
 *   C. /staff/setup — the chain now says registered+open; set the manual-approval PIN; open console.
 *   D. /staff/gate — 수동 승인하기 → search the attendee by tokenId → PIN → 수동 승인 → manualOverride
 *      (the organiser is the org owner → approver → route resolves to manualOverride).
 *
 * It then STOPS. Release + refund are the orchestrator's; nothing here polls them, and no private
 * key is ever touched — every write is the organiser's own relayed/passkey action. usedAt is
 * verified on chain by cast afterwards; the UI proof is the 들여보냈어요 outcome.
 */

const ARTIFACTS = 'e2e/.artifacts';
const DIAG_PATH = `${ARTIFACTS}/53-admission-diag.json`;
const EVENT_ID = process.env.EVENT_ID ?? '';
const TOKEN_ID = process.env.TOKEN_ID ?? '';
const PIN = '2468';

interface RelaySub { status?: string; relayId?: string; txHash?: string; from?: string; at: string }

test('53 · settlement step 3 — organiser admits attendee via staff manual override', async ({ browser }) => {
  test.setTimeout(8 * 60 * 1000);
  expect(EVENT_ID, 'EVENT_ID env must be the event id').not.toBe('');
  expect(TOKEN_ID, 'TOKEN_ID env must be persona-08 tokenId from step 2').not.toBe('');
  mkdirSync(ARTIFACTS, { recursive: true });
  const diag: Record<string, unknown> = { persona: ADMIN.id, eventId: EVENT_ID, tokenId: TOKEN_ID, startedAt: new Date().toISOString() };
  const relaySubs: RelaySub[] = [];

  const admin = await openPersona(browser, ADMIN);
  try {
    const page = admin.page;

    // Capture every relayAction submission (registerGate / openGate / manualOverride all ride it),
    // in order, so the last before admission is the override and `from` is the approver account.
    const onResponse = (response: Response): void => {
      void (async () => {
        try {
          const req = response.request();
          if (req.method() !== 'POST') return;
          if (!response.url().toLowerCase().includes('relayaction')) return;
          let from: string | undefined;
          try {
            const body = JSON.parse(req.postData() ?? '') as { data?: { req?: { from?: string } } };
            from = body.data?.req?.from;
          } catch { /* ignore */ }
          const text = await response.text().catch(() => '');
          try {
            const parsed = JSON.parse(text) as { result?: Record<string, unknown> };
            if (parsed.result) {
              relaySubs.push({
                status: parsed.result.status as string | undefined,
                relayId: parsed.result.relayId as string | undefined,
                txHash: parsed.result.txHash as string | undefined,
                from,
                at: new Date().toISOString(),
              });
            }
          } catch { /* ignore */ }
        } catch { /* capture never throws into the flow */ }
      })();
    };
    page.on('response', onResponse);

    await ensureAccount(admin);

    // ---- PHASE A: file a fresh pending gate for the event. ----
    await page.goto('/staff/setup');
    const eventField = page.getByLabel('행사 번호');
    await expect(eventField).toBeVisible({ timeout: 30_000 });
    await eventField.fill(EVENT_ID);
    await page.getByRole('button', { name: '이 행사에 등록 요청', exact: true }).click();
    const submittedText = page.getByText('등록을 요청했어요. 관리자가 승인하면 이 화면이 저절로 넘어가요.', { exact: true });
    const payloadShown = page.getByText('게이트 계정 주소', { exact: true });
    await expect(submittedText.or(payloadShown)).toBeVisible({ timeout: 45_000 });
    diag.pendingFiled = true;
    console.log('[53] PHASE A: pending gate filed');

    // ---- PHASE B: organiser approves (registerGate) then opens (openGate). ----
    await page.goto(`/org/events/${EVENT_ID}/gates`);
    const notAllowed = page.getByText('이 행사의 입구를 관리할 권한이 없어요', { exact: true });
    await expect(page.getByRole('heading', { name: '승인을 기다리는 단말기', exact: true })).toBeVisible({ timeout: 30_000 });
    if (await notAllowed.isVisible().catch(() => false)) throw new Error('persona-07 lacks PERM_MANAGE_GATES — cannot approve gate');
    const registerBtn = page.getByRole('button', { name: '등록', exact: true }).first();
    await expect(registerBtn).toBeVisible({ timeout: 30_000 });
    await registerBtn.click();
    console.log('[53] PHASE B: registerGate sent, waiting for indexer to list the gate');
    await page.waitForTimeout(3000);

    // The registered list is indexer-sourced, so poll (reload) until the gate shows with a 열기
    // (closed) or 닫기 (already open) button, then open it.
    const openBtn = page.getByRole('button', { name: '열기', exact: true }).first();
    const closeBtn = page.getByRole('button', { name: '닫기', exact: true }).first();
    let opened = false;
    const openDeadline = Date.now() + 160_000;
    while (Date.now() < openDeadline) {
      await page.goto(`/org/events/${EVENT_ID}/gates`);
      await page.waitForTimeout(3000);
      if (await closeBtn.isVisible().catch(() => false)) { opened = true; break; }
      if (await openBtn.isVisible().catch(() => false)) {
        await openBtn.click();
        await page.waitForTimeout(6000);
        opened = true;
        break;
      }
      await page.waitForTimeout(4000);
    }
    diag.gateOpened = opened;
    expect(opened, 'registered gate must appear (indexer) and be opened').toBe(true);
    console.log(`[53] PHASE B: gate opened=${opened}`);

    // ---- PHASE C: back to setup — registered+open, set PIN, open the console. ----
    await page.goto('/staff/setup');
    await expect(page.getByRole('heading', { name: '등록됐어요', exact: true })).toBeVisible({ timeout: 60_000 });
    const gateIdDd = page.locator('.gate-setup__facts dd').first();
    diag.gateId = (await gateIdDd.innerText().catch(() => '')).trim();
    console.log(`[53] PHASE C: registered, gateId=${diag.gateId}`);
    await page.getByLabel('새 PIN').fill(PIN);
    await page.getByLabel('한 번 더').fill(PIN);
    await page.getByRole('button', { name: 'PIN 저장', exact: true }).click();
    await expect(page.getByText('PIN을 저장했어요.', { exact: true })).toBeVisible({ timeout: 15_000 });
    // 입장 받기 시작 needs the chain to say open (openGate confirmed) AND pin ready — poll it.
    const startBtn = page.getByRole('button', { name: '입장 받기 시작', exact: true });
    await expect(startBtn).toBeVisible({ timeout: 90_000 });
    await startBtn.click();
    await page.waitForURL(/\/staff\/gate/, { timeout: 20_000 });
    console.log('[53] PHASE C: PIN set, console opened');

    // ---- PHASE D: manual override. Retry snapshot inclusion by re-issuing (reload) the gate. ----
    const openOverrideBtn = page.getByRole('button', { name: '수동 승인하기', exact: true });
    let approved = false;
    let lastDetail = '';
    for (let attempt = 0; attempt < 4 && !approved; attempt++) {
      // Wait for the console (snapshot issued on mount) and open the override dialog.
      await expect(openOverrideBtn).toBeVisible({ timeout: 60_000 });
      await openOverrideBtn.click();
      const searchBox = page.getByLabel('이름 또는 표 번호');
      await expect(searchBox).toBeVisible({ timeout: 10_000 });
      await searchBox.fill(TOKEN_ID);
      await page.waitForTimeout(1500);
      const match = page.locator('.gate-dialog__matches li button').first();
      const emptyHint = page.getByText('명단에서 찾지 못했어요. 다르게 넣어 보세요.', { exact: true });
      if (await match.isVisible().catch(() => false)) {
        await match.click();
      } else {
        // Not in this snapshot yet (indexer lag). Cancel, reload the gate to re-issue, retry.
        lastDetail = (await emptyHint.isVisible().catch(() => false)) ? 'not in snapshot' : 'no match element';
        console.log(`[53] PHASE D attempt ${attempt}: ${lastDetail}; re-issuing snapshot`);
        await page.getByRole('button', { name: '취소', exact: true }).click().catch(() => undefined);
        await page.goto('/staff/gate');
        await page.waitForTimeout(8000);
        continue;
      }
      await expect(page.getByText('들여보낼 사람', { exact: true })).toBeVisible({ timeout: 5000 });
      await page.getByLabel('PIN').fill(PIN);
      // canApprove resolves async to the owner → the button becomes 수동 승인 (manualOverride route).
      const approveBtn = page.getByRole('button', { name: '수동 승인', exact: true });
      await expect(approveBtn).toBeVisible({ timeout: 20_000 });
      await approveBtn.click();
      const approvedLine = page.getByText('들여보냈어요.', { exact: true });
      const failedLine = page.getByText('보내지 못했어요. 다시 해 보세요.', { exact: true });
      const deniedLine = page.getByText('이 계정에는 손으로 들여보낼 권한이 없어요. 관리자에게 문의하세요.', { exact: true });
      const overrideDeadline = Date.now() + 90_000;
      while (Date.now() < overrideDeadline) {
        if (await approvedLine.isVisible().catch(() => false)) { approved = true; break; }
        if (await deniedLine.isVisible().catch(() => false)) { lastDetail = 'denied'; break; }
        if (await failedLine.isVisible().catch(() => false)) { lastDetail = 'failed'; break; }
        await page.waitForTimeout(2000);
      }
      if (!approved) {
        console.log(`[53] PHASE D attempt ${attempt}: outcome=${lastDetail}`);
        // Capture approver/role facts even on non-approval, then reload to retry.
        await page.screenshot({ path: `${ARTIFACTS}/53-override-attempt${attempt}.png`, fullPage: true }).catch(() => undefined);
        if (lastDetail === 'denied') break; // a rights problem will not fix on retry
        await page.goto('/staff/gate');
        await page.waitForTimeout(6000);
      }
    }

    // Capture the approver + role shown in the outcome, and the override tx/relay from the network.
    diag.approved = approved;
    diag.approverShown = (await page.locator('.gate-dialog__facts dd.mono').first().innerText().catch(() => '')).trim();
    diag.roleShown = (await page.locator('.gate-dialog__facts dd').nth(1).innerText().catch(() => '')).trim();
    diag.relaySubs = relaySubs;
    diag.lastDetail = lastDetail;
    const overrideSub = relaySubs[relaySubs.length - 1];
    diag.overrideRelay = overrideSub ?? null;
    diag.approverFrom = overrideSub?.from ?? null;
    console.log(`[53] PHASE D: approved=${approved} approverShown=${diag.approverShown} overrideRelay=${JSON.stringify(overrideSub)}`);
    await page.screenshot({ path: `${ARTIFACTS}/53-override-final.png`, fullPage: true }).catch(() => undefined);
    expect(approved, `manual override must land on 들여보냈어요 (lastDetail=${lastDetail})`).toBe(true);
  } finally {
    diag.finishedAt = new Date().toISOString();
    writeFileSync(DIAG_PATH, JSON.stringify(diag, null, 2));
    console.log(`[53] diag written: ${DIAG_PATH}`);
    await closePersona(admin);
  }
});
