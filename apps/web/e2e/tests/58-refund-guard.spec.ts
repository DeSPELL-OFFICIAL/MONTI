import { expect, test, type Page, type Response } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ticketAbi } from '@monti/shared';
import { ADMIN, USERS } from '../fixtures/personas';
import { closePersona, ensureAccount, openPersona, type PersonaSession } from '../utils/session';
import { createDraftAndPublish } from '../utils/organizer';
import { approveGate, fileGateRequest, startConsole } from '../utils/gates';
import { chain, TICKET_ADDRESS } from '../utils/chain';
import { shot } from '../utils/shots';

/**
 * v2 refund guard, end to end, in ONE process — a refunded ticket must not get anyone in.
 *
 * One process because a v2-registered persona cannot be reused from a saved state: the restored
 * IndexedDB device key cannot sign, so the device-health guard sends it to /recover. Both
 * personas are therefore fresh signups (E2E_ADMIN organiser, E2E_USER_FROM attendee).
 *
 *   0. organiser publishes a paid event; attendee pays (one purchase) and refunds (one refund).
 *   a. attendee, same device: `/tickets/<id>/enter` and `/transfer` answer
 *      "환불된 티켓이에요 · 입장할 수 없어요" + 티켓으로 돌아가기, no step.
 *   c. organiser files + registers a gate and opens the console: the staff snapshot
 *      (issueSnapshot) does not carry the refunded ticket and its last four digits find nobody.
 *   b. the full number (chain fallback row) → PIN → 수동 승인 → relayAction refused
 *      (TicketRevoked, details.reason TICKET_REFUNDED), the dialog reads 취소된 티켓, `usedAt` stays 0.
 */

const PRICE = Number(process.env.E2E_PRICE_USD ?? '10');
const ARTIFACTS = 'e2e/.artifacts';
const DIAG_PATH = `${ARTIFACTS}/58-refund-guard-diag.json`;
const PIN = '1357';
const REFUNDED_LINE = "Refunded ticket · it can't be used to enter";
const BACK = 'Back to the ticket';
const RECIPIENTS = [
  { role: 'Artist', pct: '60', tag: 'artist', addr: '0x1111111111111111111111111111111111111111' },
  { role: 'Venue', pct: '20', tag: 'venue', addr: '0x2222222222222222222222222222222222222222' },
  { role: 'Producer', pct: '15', tag: 'planning', addr: '0x3333333333333333333333333333333333333333' },
];

async function usedAt(tokenId: string): Promise<bigint> {
  // uint64 comes back as a number from viem; normalise.
  return BigInt(await chain.readContract({ address: TICKET_ADDRESS, abi: ticketAbi, functionName: 'usedAt', args: [BigInt(tokenId)] }) as number | bigint);
}

/** Opens a guarded route; reports whether the refunded sentence + back button replaced the step. */
async function guardedRoute(page: Page, path: string, name: string): Promise<{ blocked: boolean; back: boolean; url: string }> {
  await page.goto(path);
  const blocked = await page.getByText(REFUNDED_LINE, { exact: true }).waitFor({ state: 'visible', timeout: 30_000 }).then(() => true).catch(() => false);
  const back = await page.getByRole('button', { name: BACK, exact: true }).isVisible().catch(() => false);
  await page.waitForTimeout(500);
  await shot(page, name);
  return { blocked, back, url: new URL(page.url()).pathname };
}

/** Pays the mock card on /claim/<id>; answers the tokenId off `purchaseTicket`. */
async function purchase(page: Page, eventId: string, diag: Record<string, unknown>): Promise<string> {
  const wire: { tokenId?: string; orderId?: string; txHash?: string; refundTxHash?: string } = {};
  page.on('response', (response: Response) => {
    void (async () => {
      try {
        const url = response.url().toLowerCase();
        if (response.request().method() !== 'POST' || !(url.includes('purchaseticket') || url.includes('refundorder'))) return;
        const parsed = JSON.parse(await response.text().catch(() => '')) as { result?: Record<string, unknown> };
        if (!parsed.result) return;
        wire.tokenId = (parsed.result.tokenId as string | undefined) ?? wire.tokenId;
        wire.orderId = (parsed.result.orderId as string | undefined) ?? wire.orderId;
        wire.txHash = (parsed.result.txHash as string | undefined) ?? wire.txHash;
        wire.refundTxHash = (parsed.result.refundTxHash as string | undefined) ?? wire.refundTxHash;
        diag.wire = { ...wire };
      } catch { /* capture never throws */ }
    })();
  });
  await page.goto(`/claim/${eventId}`);
  const payCta = page.getByRole('button', { name: /Buy for \$/ });
  await expect(payCta).toBeEnabled({ timeout: 60_000 });
  await payCta.click();
  const sheet = page.getByRole('dialog', { name: 'Card payment' });
  await expect(sheet).toBeVisible({ timeout: 10_000 });
  await page.getByPlaceholder('0000 0000 0000 0000 (test)').fill('4242424242424242');
  const payBtn = sheet.getByRole('button', { name: /^Pay \$/ });
  await expect(payBtn).toBeEnabled({ timeout: 10_000 });
  const at = Date.now();
  await payBtn.click();
  await expect(sheet.getByText('Paid · your ticket is ready', { exact: true })
    .or(sheet.getByRole('link', { name: /^(See receipt|See my tickets)$/ })).first()).toBeVisible({ timeout: 180_000 });
  diag.purchaseLatencyMs = Date.now() - at;
  await expect.poll(() => wire.tokenId, { timeout: 15_000 }).toBeTruthy();
  return wire.tokenId!;
}

test('58 · refund guard — refunded ticket cannot enter, transfer, or be admitted by override', async ({ browser }) => {
  test.setTimeout(15 * 60 * 1000);
  mkdirSync(ARTIFACTS, { recursive: true });
  const diag: Record<string, unknown> = { admin: ADMIN.id, attendee: USERS[0]!.id, startedAt: new Date().toISOString() };
  let admin: PersonaSession | null = null;
  let attendee: PersonaSession | null = null;
  try {
    // ============================== 0 — publish, buy, refund ==============================
    admin = await openPersona(browser, ADMIN);
    const page = admin.page;
    await ensureAccount(admin);
    const { eventId } = await createDraftAndPublish(page, {
      personaId: ADMIN.id, orgName: 'Monti Refund Guard', title: 'Refund guard demo v2',
      intro: 'Checks that a refunded ticket cannot get in.', venue: 'Test Hall, Seoul',
      tiers: [{ kind: 'Paid', name: 'GA', supply: 20, price: PRICE }],
      split: RECIPIENTS,
    });
    diag.eventId = eventId;
    console.log(`[58] event=${eventId}`);

    attendee = await openPersona(browser, USERS[0]!);
    const ap = attendee.page;
    await ensureAccount(attendee);
    const tokenId = await purchase(ap, eventId, diag);
    diag.tokenId = tokenId;
    await ap.goto(`/tickets/${tokenId}`);
    await expect(ap.getByText('Payment held · paid out when you check in', { exact: true })).toBeVisible({ timeout: 60_000 });
    await ap.getByRole('button', { name: 'Get a refund', exact: true }).click();
    const confirm = ap.getByRole('dialog', { name: 'Refund this ticket?' });
    await expect(confirm).toBeVisible({ timeout: 10_000 });
    await confirm.getByRole('button', { name: 'Refund', exact: true }).click();
    await expect(ap.getByText('Refunded', { exact: true })).toBeVisible({ timeout: 120_000 });
    await shot(ap, 'guard-receipt-refunded');
    const usedBefore = await usedAt(tokenId);
    diag.usedAtBefore = usedBefore.toString();
    console.log(`[58] token=${tokenId} refunded; usedAt=${usedBefore}`);
    expect(usedBefore, 'refunded ticket starts unused').toBe(0n);

    // ============================== 4a — attendee deep links (same device) ==============================
    const enter = await guardedRoute(ap, `/tickets/${tokenId}/enter`, 'guard-enter-refunded');
    const transfer = await guardedRoute(ap, `/tickets/${tokenId}/transfer`, 'guard-transfer-refunded');
    diag.enter = enter; diag.transfer = transfer;
    if (transfer.back) {
      await ap.getByRole('button', { name: BACK, exact: true }).click();
      await ap.waitForURL(new RegExp(`/tickets/${tokenId}$`), { timeout: 15_000 }).catch(() => undefined);
      diag.backLandsOn = new URL(ap.url()).pathname;
    }
    console.log(`[58] 4a enter=${JSON.stringify(enter)} transfer=${JSON.stringify(transfer)} back→${String(diag.backLandsOn)}`);

    // ============================== 4c/4b — organiser at the gate ==============================
    const snapshots: { status: number; bytes: number; hasRefunded: boolean }[] = [];
    const relayErrors: unknown[] = [];
    const relayKinds: string[] = [];
    page.on('response', (response: Response) => {
      void (async () => {
        try {
          const req = response.request();
          if (req.method() !== 'POST') return;
          const url = response.url().toLowerCase();
          if (url.includes('issuesnapshot')) {
            const text = await response.text().catch(() => '');
            snapshots.push({ status: response.status(), bytes: text.length, hasRefunded: text.includes(tokenId) });
          } else if (url.includes('relayaction')) {
            const body = JSON.parse(req.postData() ?? '') as { data?: { kind?: string } };
            relayKinds.push(body.data?.kind ?? 'unknown');
            const parsed = JSON.parse(await response.text().catch(() => '')) as { error?: unknown };
            if (parsed.error) relayErrors.push({ kind: body.data?.kind, status: response.status(), error: parsed.error });
          }
        } catch { /* capture never throws */ }
      })();
    });
    const gateAccount = await fileGateRequest(page, eventId);
    const gate = await approveGate(page, eventId, gateAccount);
    diag.gate = { account: gateAccount, id: gate.gateId.toString(), registerMs: gate.registerMs, openOnRegister: gate.openOnRegister };
    await startConsole(page, PIN);
    await page.waitForTimeout(4000);

    const openBtn = page.getByRole('button', { name: 'Approve by hand', exact: true });
    await expect(openBtn).toBeVisible({ timeout: 60_000 });
    await openBtn.click();
    const search = page.getByLabel('Name or ticket number');
    await expect(search).toBeVisible({ timeout: 10_000 });
    const last4 = tokenId.slice(-4);
    await search.fill(last4);
    await page.waitForTimeout(3000);
    const last4Matches = await page.locator('.gate-dialog__matches li button').allInnerTexts().catch(() => [] as string[]);
    await shot(page, 'guard-search-last4');
    diag.search = { last4, matches: last4Matches, snapshots: [...snapshots] };
    console.log(`[58] 4c last4=${last4} matches=${JSON.stringify(last4Matches)} snapshots=${JSON.stringify(snapshots)}`);

    await search.fill(tokenId);
    const match = page.locator('.gate-dialog__matches li button').first();
    const resolved = await match.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true).catch(() => false);
    diag.fullNumberResolved = resolved;
    let line = '';
    if (resolved) {
      await match.click();
      await expect(page.getByText('Letting in', { exact: true })).toBeVisible({ timeout: 5000 });
      await page.getByLabel('PIN', { exact: true }).fill(PIN);
      const approveBtn = page.getByRole('button', { name: 'Approve manually', exact: true });
      await expect(approveBtn).toBeVisible({ timeout: 20_000 });
      await shot(page, 'guard-override-confirm');
      const pressedAt = Date.now();
      await approveBtn.click();
      const outcome = page.locator('.gate-dialog__outcome-line');
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        line = (await outcome.innerText().catch(() => '')).trim();
        if (line.includes('Ticket cancelled') || line.includes('They are in.') || relayErrors.length > 0) break;
        await page.waitForTimeout(1000);
      }
      await page.waitForTimeout(1500);
      line = (await outcome.innerText().catch(() => '')).trim();
      diag.override = { line, latencyMs: Date.now() - pressedAt, relayKinds: [...relayKinds], relayErrors: [...relayErrors] };
      await shot(page, 'guard-override-refused');
      console.log(`[58] 4b line="${line}" kinds=${relayKinds.join(',')} errors=${JSON.stringify(relayErrors)}`);
    }
    await page.waitForTimeout(15_000);
    const usedAfter = await usedAt(tokenId);
    diag.usedAtAfter = usedAfter.toString();
    diag.snapshotsFinal = [...snapshots];

    // ============================== assertions ==============================
    expect(enter.blocked && enter.back, '/enter shows the refunded sentence + 티켓으로 돌아가기').toBe(true);
    expect(transfer.blocked && transfer.back, '/transfer shows the refunded sentence + 티켓으로 돌아가기').toBe(true);
    expect(last4Matches, 'last four digits find nobody in the snapshot').toHaveLength(0);
    expect(snapshots.some((s) => s.hasRefunded), 'issueSnapshot never carries the refunded token').toBe(false);
    expect(resolved, 'full number resolves (the chain fallback reads only isRevoked)').toBe(true);
    expect(line, 'override refused as 취소된 티켓').toContain('Ticket cancelled');
    expect(JSON.stringify(relayErrors), 'relayAction refused with TICKET_REFUNDED').toContain('TICKET_REFUNDED');
    expect(usedAfter, 'usedAt stays 0 — no on-chain admission').toBe(0n);
  } finally {
    diag.finishedAt = new Date().toISOString();
    writeFileSync(DIAG_PATH, JSON.stringify(diag, null, 2));
    console.log(`[58] diag written: ${DIAG_PATH}`);
    if (attendee) await closePersona(attendee).catch(() => undefined);
    if (admin) await closePersona(admin).catch(() => undefined);
  }
});
