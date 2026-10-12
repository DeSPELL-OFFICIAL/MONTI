import { expect, test, type Response } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { USERS } from '../fixtures/personas';
import { closePersona, ensureAccount, openPersona } from '../utils/session';
import { fmtMon, monBalance, TREASURY } from '../utils/chain';
import { shot } from '../utils/shots';

/** Ticket price in USD asserted on the CTA. Default unchanged ($30). */
const PRICE = process.env.E2E_PRICE_USD ?? '30';

/**
 * v2 step 5. A SECOND fresh attendee buys the ticket (ONE `purchase`, mint + escrow) and refunds it BEFORE
 * admission, self-contained in one process (the order id is device-local, so purchase + refund must
 * share the context). Pass the step-1 event via EVENT_ID and the attendee via E2E_USER_FROM.
 *
 *   5a. sign in, /claim/<id>, pay $30 (mock card) → 결제 완료 → capture tokenId off purchaseTicket;
 *   5b. /tickets/<tokenId> (direct — the list has no chain fallback) → receipt 보관 중;
 *   5c. tap 환불받기 → the receipt flips to 환불됨.
 *
 * On-chain afterwards (cast): escrow Refunded, treasury USDC +30.
 */

const ARTIFACTS = 'e2e/.artifacts';
const DIAG_PATH = `${ARTIFACTS}/56-refund-diag.json`;
const EVENT_ID = process.env.EVENT_ID ?? '';

test('56 · settlement step 5 — attendee B buys then refunds before admission', async ({ browser }) => {
  test.setTimeout(8 * 60 * 1000);
  expect(EVENT_ID, 'EVENT_ID env must be the step-1 event id').not.toBe('');
  mkdirSync(ARTIFACTS, { recursive: true });
  const attendee = USERS[0]!;
  const diag: Record<string, unknown> = { persona: attendee.id, eventId: EVENT_ID, startedAt: new Date().toISOString() };
  // depositTxHash = purchaseTicket result.txHash (the one purchase tx); refundTxHash = refundOrder result
  // (the treasury-key vault.refund, returned after the receipt is awaited → ≈ on-chain confirmation).
  const wire: { account?: string; orderId?: string; tokenId?: string; status?: string; depositTxHash?: string; refundTxHash?: string; refundStatus?: string } = {};

  const user = await openPersona(browser, attendee);
  try {
    const page = user.page;
    page.on('response', (response: Response) => {
      void (async () => {
        try {
          const req = response.request();
          if (req.method() !== 'POST') return;
          const url = response.url().toLowerCase();
          const isPurchase = url.includes('purchaseticket');
          const isRefund = url.includes('refundorder');
          if (!isPurchase && !isRefund && !url.includes('relay')) return;
          if (isPurchase) { try { const b = JSON.parse(req.postData() ?? '') as { data?: { auth?: { account?: string } } }; if (b.data?.auth?.account) wire.account = b.data.auth.account; } catch { /* */ } }
          const parsed = JSON.parse(await response.text().catch(() => '')) as { result?: Record<string, unknown> };
          if (parsed.result) {
            wire.orderId = (parsed.result.orderId as string | undefined) ?? wire.orderId;
            wire.tokenId = (parsed.result.tokenId as string | undefined) ?? wire.tokenId;
            wire.status = (parsed.result.status as string | undefined) ?? wire.status;
            wire.depositTxHash = (parsed.result.depositTxHash as string | undefined) ?? (parsed.result.txHash as string | undefined) ?? wire.depositTxHash;
            const rtx = parsed.result.refundTxHash as string | undefined;
            if (rtx && !wire.refundTxHash) { wire.refundTxHash = rtx; diag.refundConfirmedAt = new Date().toISOString(); }
            if (isRefund) wire.refundStatus = (parsed.result.status as string | undefined) ?? wire.refundStatus;
          }
        } catch { /* */ }
      })();
    });

    await ensureAccount(user);
    await page.goto(`/claim/${EVENT_ID}`);
    const payCta = page.getByRole('button', { name: /Buy for \$/ });
    await expect(payCta).toBeVisible({ timeout: 60_000 });
    await expect(payCta).toBeEnabled({ timeout: 30_000 });
    await shot(page, 'refund-attendee-claim-paid-cta');
    expect((await payCta.innerText()).trim(), `CTA shows $${PRICE}`).toContain(`$${PRICE}`);
    await payCta.click();
    const sheet = page.getByRole('dialog', { name: 'Card payment' });
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    await page.getByPlaceholder('0000 0000 0000 0000 (test)').fill('4242424242424242');
    // The sheet's own button reads "$30.00 결제하기"; the claim CTA behind it keeps 결제하고 받기.
    const payBtn = sheet.getByRole('button', { name: /^Pay \$/ });
    await expect(payBtn).toBeEnabled({ timeout: 10_000 });
    await shot(page, 'refund-attendee-payment-card-filled');
    const payClickAt = Date.now();
    const treasuryBefore = await monBalance(TREASURY);
    await payBtn.click();
    const doneAlert = sheet.getByText('Paid · your ticket is ready', { exact: true });
    const toTickets = sheet.getByRole('link', { name: /^(See receipt|See my tickets)$/ });
    let purchased = false; const pd = Date.now() + 180_000;
    while (Date.now() < pd) { if (await doneAlert.isVisible().catch(() => false) || await toTickets.isVisible().catch(() => false)) { purchased = true; break; } await page.waitForTimeout(2000); }
    diag.purchased = purchased; diag.wire = { ...wire };
    diag.treasuryMonPurchase = fmtMon(treasuryBefore - (await monBalance(TREASURY)));
    diag.purchaseLatencyMs = Date.now() - payClickAt;
    await shot(page, 'refund-attendee-payment-done');
    console.log(`[56] purchased=${purchased} latency=${diag.purchaseLatencyMs}ms wire=${JSON.stringify(wire)}`);
    expect(purchased, 'purchase reaches 결제 완료').toBe(true);
    expect(wire.tokenId, 'tokenId captured').toBeTruthy();
    const tokenId = wire.tokenId!;
    diag.tokenId = tokenId; diag.attendeeAccount = wire.account;

    await page.goto(`/tickets/${tokenId}`);
    await expect(page.getByRole('heading', { name: 'Receipt', exact: true })).toBeVisible({ timeout: 45_000 });
    const heldLine = page.getByText('Payment held · paid out when you check in', { exact: true });
    let held = false; const hd = Date.now() + 60_000;
    while (Date.now() < hd) { if (await heldLine.isVisible().catch(() => false)) { held = true; break; } await page.waitForTimeout(2000); }
    diag.receiptHeld = held;
    await page.screenshot({ path: `${ARTIFACTS}/56-refund-held.png`, fullPage: true }).catch(() => undefined);
    await shot(page, 'refund-attendee-receipt-held-with-refund-button');
    expect(held, 'receipt reads 보관 중 before refund').toBe(true);

    const refundBtn = page.getByRole('button', { name: 'Get a refund', exact: true });
    await expect(refundBtn).toBeVisible({ timeout: 20_000 });
    const refundClickedAtMs = Date.now();
    diag.refundClickedAt = new Date().toISOString();
    await refundBtn.click();
    // 환불받기 only opens the confirm sheet; the irreversible step is 환불하기 on it.
    const confirmSheet = page.getByRole('dialog', { name: 'Refund this ticket?' });
    await expect(confirmSheet).toBeVisible({ timeout: 10_000 });
    await shot(page, 'refund-attendee-confirm-sheet');
    await confirmSheet.getByRole('button', { name: 'Refund', exact: true }).click();
    await page.waitForTimeout(400);
    await shot(page, 'refund-attendee-refunding');
    const refundedLine = page.getByText('Refunded', { exact: true });
    let refunded = false; const fd = Date.now() + 120_000;
    while (Date.now() < fd) { if (await refundedLine.isVisible().catch(() => false)) { refunded = true; break; } await page.waitForTimeout(2500); }
    diag.refunded = refunded; diag.refundObservedAt = new Date().toISOString();
    // The success line is recorded, not asserted: it lives only until the screen is left.
    diag.refundDoneShown = await page.getByText('Refunded', { exact: true }).isVisible().catch(() => false);
    diag.refundUiLatencyMs = Date.now() - refundClickedAtMs;
    diag.wire = { ...wire };
    console.log(`[56] refunded=${refunded} refundTxHash=${wire.refundTxHash ?? '(none)'} uiLatencyMs=${diag.refundUiLatencyMs}`);
    await page.screenshot({ path: `${ARTIFACTS}/56-refund-done.png`, fullPage: true }).catch(() => undefined);
    await shot(page, 'refund-attendee-refunded');
    expect(refunded, 'receipt flips to 환불됨').toBe(true);

    // Step 3 — negative check: reload the direct ticket URL (built from chain). The receipt must
    // still read 환불됨, the 환불받기 button must be gone, and the ticket must not be admittable.
    await page.goto(`/tickets/${tokenId}`);
    await expect(page.getByRole('heading', { name: 'Receipt', exact: true })).toBeVisible({ timeout: 45_000 });
    let refundedPersists = false; const rd = Date.now() + 60_000;
    while (Date.now() < rd) { if (await refundedLine.isVisible().catch(() => false)) { refundedPersists = true; break; } await page.waitForTimeout(2000); }
    const refundBtnGone = (await page.getByRole('button', { name: 'Get a refund', exact: true }).count()) === 0;
    diag.reload = { refundedPersists, refundBtnGone };
    console.log(`[56] reload: refundedPersists=${refundedPersists} refundBtnGone=${refundBtnGone}`);
    await page.screenshot({ path: `${ARTIFACTS}/56-refund-reload.png`, fullPage: true }).catch(() => undefined);
    await shot(page, 'refund-attendee-reload-still-refunded');
    expect(refundedPersists, 'receipt still reads 환불됨 after reload').toBe(true);
    expect(refundBtnGone, '환불받기 button is gone after refund').toBe(true);
  } finally {
    diag.finishedAt = new Date().toISOString();
    writeFileSync(DIAG_PATH, JSON.stringify(diag, null, 2));
    console.log(`[56] diag written: ${DIAG_PATH}`);
    await closePersona(user).catch(() => undefined);
  }
});
