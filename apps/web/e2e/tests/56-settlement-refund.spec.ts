import { expect, test, type Response } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { USERS } from '../fixtures/personas';
import { closePersona, ensureAccount, openPersona } from '../utils/session';

/**
 * Batch H — Run 5, step 5. A SECOND fresh attendee buys the $30 ticket and then refunds it BEFORE
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
  const wire: { account?: string; orderId?: string; tokenId?: string; status?: string } = {};

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
          if (!isPurchase && !url.includes('relay')) return;
          if (isPurchase) { try { const b = JSON.parse(req.postData() ?? '') as { data?: { auth?: { account?: string } } }; if (b.data?.auth?.account) wire.account = b.data.auth.account; } catch { /* */ } }
          const parsed = JSON.parse(await response.text().catch(() => '')) as { result?: Record<string, unknown> };
          if (parsed.result) {
            wire.orderId = (parsed.result.orderId as string | undefined) ?? wire.orderId;
            wire.tokenId = (parsed.result.tokenId as string | undefined) ?? wire.tokenId;
            wire.status = (parsed.result.status as string | undefined) ?? wire.status;
          }
        } catch { /* */ }
      })();
    });

    await ensureAccount(user);
    await page.goto(`/claim/${EVENT_ID}`);
    const payCta = page.getByRole('button', { name: /결제하고 받기/ });
    await expect(payCta).toBeVisible({ timeout: 60_000 });
    await expect(payCta).toBeEnabled({ timeout: 30_000 });
    expect((await payCta.innerText()).trim(), 'CTA shows $30').toContain('$30');
    await payCta.click();
    const sheet = page.getByRole('dialog', { name: '결제' });
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    await page.getByPlaceholder('0000 0000 0000 0000 (테스트)').fill('4242424242424242');
    const payBtn = sheet.getByRole('button', { name: /결제하고 받기/ });
    await expect(payBtn).toBeEnabled({ timeout: 10_000 });
    await payBtn.click();
    const doneAlert = sheet.getByText('결제 완료 · 티켓을 받았어요', { exact: true });
    const toTickets = sheet.getByRole('link', { name: '내 티켓 보기', exact: true });
    let purchased = false; const pd = Date.now() + 180_000;
    while (Date.now() < pd) { if (await doneAlert.isVisible().catch(() => false) || await toTickets.isVisible().catch(() => false)) { purchased = true; break; } await page.waitForTimeout(2000); }
    diag.purchased = purchased; diag.wire = { ...wire };
    console.log(`[56] purchased=${purchased} wire=${JSON.stringify(wire)}`);
    expect(purchased, 'purchase reaches 결제 완료').toBe(true);
    expect(wire.tokenId, 'tokenId captured').toBeTruthy();
    const tokenId = wire.tokenId!;
    diag.tokenId = tokenId; diag.attendeeAccount = wire.account;

    await page.goto(`/tickets/${tokenId}`);
    await expect(page.getByRole('heading', { name: '영수증', exact: true })).toBeVisible({ timeout: 45_000 });
    const heldLine = page.getByText('보관 중 · 입장하면 정산돼요', { exact: true });
    let held = false; const hd = Date.now() + 60_000;
    while (Date.now() < hd) { if (await heldLine.isVisible().catch(() => false)) { held = true; break; } await page.waitForTimeout(2000); }
    diag.receiptHeld = held;
    await page.screenshot({ path: `${ARTIFACTS}/56-refund-held.png`, fullPage: true }).catch(() => undefined);
    expect(held, 'receipt reads 보관 중 before refund').toBe(true);

    const refundBtn = page.getByRole('button', { name: '환불받기', exact: true });
    await expect(refundBtn).toBeVisible({ timeout: 20_000 });
    await refundBtn.click();
    const refundedLine = page.getByText('환불됨', { exact: true });
    let refunded = false; const fd = Date.now() + 120_000;
    while (Date.now() < fd) { if (await refundedLine.isVisible().catch(() => false)) { refunded = true; break; } await page.waitForTimeout(2500); }
    diag.refunded = refunded; diag.refundObservedAt = new Date().toISOString();
    console.log(`[56] refunded=${refunded}`);
    await page.screenshot({ path: `${ARTIFACTS}/56-refund-done.png`, fullPage: true }).catch(() => undefined);
    expect(refunded, 'receipt flips to 환불됨').toBe(true);
  } finally {
    diag.finishedAt = new Date().toISOString();
    writeFileSync(DIAG_PATH, JSON.stringify(diag, null, 2));
    console.log(`[56] diag written: ${DIAG_PATH}`);
    await closePersona(user).catch(() => undefined);
  }
});
