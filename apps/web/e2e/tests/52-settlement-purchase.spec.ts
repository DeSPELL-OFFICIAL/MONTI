import { expect, test, type Response } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { USERS } from '../fixtures/personas';
import { closePersona, ensureAccount, openPersona } from '../utils/session';
import { fmtMon, monBalance, TREASURY } from '../utils/chain';

/**
 * v2 step 2 (attendee SUBMITS the purchase). Sibling of 51, which opens the sheet but deliberately
 * does not submit; this one pays with the mock card. In v2 that is ONE `SettlementVault.purchase`
 * sent by the treasury — mint + escrow in the same transaction, so the ticket and the held payment
 * appear together or not at all (a failure reads "결제가 완료되지 않았어요 · 청구된 금액은 없어요").
 *
 * Precondition: a priced event published with its split (55, or `createDraftAndPublish`) and a
 * treasury with USDC + MON. Pass the event id via EVENT_ID, the price via E2E_PRICE_USD (default
 * 30) and the attendee via E2E_USER_FROM. This spec:
 *   2a. signs persona-08 in and opens /claim/<eventId>;
 *   2b. taps 결제하고 받기 $30.00 → the mock card sheet opens;
 *   2c. fills the demo card field and taps the sheet's pay button → waits for 결제 완료;
 *   2d. follows 내 티켓 보기 → the ticket detail, and asserts the receipt reads 보관 중.
 *
 * It captures the attendee smart-account address, the minted tokenId and the deposit tx hash off
 * the purchaseTicket callable's network traffic and the ticket detail, for on-chain verification.
 * Exactly ONE purchase is made (persona-08): no other money moves.
 */

const ARTIFACTS = 'e2e/.artifacts';
const DIAG_PATH = `${ARTIFACTS}/52-purchase-diag.json`;
const EVENT_ID = process.env.EVENT_ID ?? '';
const PRICE = process.env.E2E_PRICE_USD ?? '30';

/** Card placeholder copy on the mock sheet — a demo field that is never read or sent. */
const CARD_PLACEHOLDER = '0000 0000 0000 0000 (테스트)';
const SHEET_NAME = '결제';
const PAY_RE = /결제하고 받기/;
/** The sheet's own pay button reads "$30.00 결제하기" (the claim CTA keeps 결제하고 받기). */
const SHEET_PAY_RE = /결제하기/;
const DONE_TEXT = '결제 완료 · 티켓을 받았어요';
/** The done link opens the new ticket's receipt; 내 티켓 보기 only when no token id came back yet. */
const TO_TICKETS = /^(영수증 보기|내 티켓 보기)$/;
const STATUS_HELD = '결제 금액 보관 중 · 입장하면 자동으로 나눠 보내요';
const RECEIPT_TITLE = '영수증';

interface PurchaseWire {
  account?: string;
  orderId?: string;
  tokenId?: string;
  status?: string;
  relayId?: string;
  txHash?: string;
  error?: unknown;
}

test('52 · v2 settlement step 2 — attendee pays in one purchase and the receipt reads 보관 중', async ({ browser }) => {
  test.setTimeout(4 * 60 * 1000);
  expect(EVENT_ID, 'EVENT_ID env must be the step-1 event id').not.toBe('');
  mkdirSync(ARTIFACTS, { recursive: true });
  const attendee = USERS[0]!;
  const diag: Record<string, unknown> = { persona: attendee.id, eventId: EVENT_ID, startedAt: new Date().toISOString() };
  const wire: PurchaseWire = {};

  const user = await openPersona(browser, attendee);
  try {
    const page = user.page;

    // Passive capture of the purchaseTicket callable: the request body carries the attendee's
    // smart-account (data.auth.account) and the response result carries orderId/tokenId/status.
    const onResponse = (response: Response): void => {
      void (async () => {
        try {
          const req = response.request();
          if (req.method() !== 'POST') return;
          if (!response.url().toLowerCase().includes('purchaseticket')) return;
          const post = req.postData() ?? '';
          try {
            const body = JSON.parse(post) as { data?: { auth?: { account?: string } } };
            if (typeof body.data?.auth?.account === 'string') wire.account = body.data.auth.account;
          } catch { /* ignore */ }
          const text = await response.text().catch(() => '');
          try {
            const parsed = JSON.parse(text) as { result?: Record<string, unknown>; error?: unknown };
            if (parsed.result) {
              wire.orderId = parsed.result.orderId as string | undefined;
              wire.tokenId = (parsed.result.tokenId as string | undefined) ?? wire.tokenId;
              wire.status = parsed.result.status as string | undefined;
              wire.relayId = parsed.result.relayId as string | undefined;
              wire.txHash = (parsed.result.txHash as string | undefined) ?? wire.txHash;
            } else if (parsed.error) {
              wire.error = parsed.error;
            }
          } catch { /* ignore */ }
        } catch { /* capture must never throw into the flow */ }
      })();
    };
    page.on('response', onResponse);

    // 2a. Sign the attendee in and open the claim page.
    await ensureAccount(user);
    diag.attendeeRecovered = user.recovered ?? false;
    await page.goto(`/claim/${EVENT_ID}`);

    // 2b. The priced CTA → the mock card sheet. Wait past the transient 확인 중… disabled state.
    const payCta = page.getByRole('button', { name: PAY_RE });
    await expect(payCta).toBeVisible({ timeout: 45_000 });
    await expect(payCta).toBeEnabled({ timeout: 30_000 });
    const ctaText = (await payCta.innerText()).trim();
    diag.ctaText = ctaText;
    expect(ctaText, `CTA must show the $${PRICE} price`).toContain(`$${PRICE}`);
    await payCta.click();

    const sheet = page.getByRole('dialog', { name: SHEET_NAME });
    await expect(sheet).toBeVisible({ timeout: 10_000 });

    // 2c. Fill the demo card field (never read/sent) and submit the sheet's pay button. The pay
    // button shares the CTA copy, so it is scoped to the sheet dialog to avoid the claim CTA.
    const cardField = page.getByPlaceholder(CARD_PLACEHOLDER);
    await expect(cardField).toBeVisible({ timeout: 10_000 });
    await cardField.fill('4242424242424242');
    const payBtn = sheet.getByRole('button', { name: SHEET_PAY_RE });
    await expect(payBtn).toBeEnabled({ timeout: 10_000 });
    console.log(`[52] submitting mock purchase for ${attendee.id} on event ${EVENT_ID}`);
    const treasuryBefore = await monBalance(TREASURY);
    const payAt = Date.now();
    await payBtn.click();

    // Wait for 결제 완료 (the done state) or a determinate error. The one purchase is sent by the
    // treasury, so give it room; a failure Alert surfaces inside the sheet.
    const doneAlert = sheet.getByText(DONE_TEXT, { exact: true });
    const toTickets = sheet.getByRole('link', { name: TO_TICKETS });
    const errorAlert = sheet.locator('.alert, [role="alert"]');
    let purchased = false;
    const payDeadline = Date.now() + 150_000;
    while (Date.now() < payDeadline) {
      if (await doneAlert.isVisible().catch(() => false)) { purchased = true; break; }
      if (await toTickets.isVisible().catch(() => false)) { purchased = true; break; }
      const errTxt = (await errorAlert.allInnerTexts().catch(() => [])).join(' | ').trim();
      if (errTxt && !errTxt.includes('테스트')) { diag.payError = errTxt; break; }
      await page.waitForTimeout(2000);
    }
    diag.purchased = purchased;
    diag.purchaseLatencyMs = Date.now() - payAt;
    diag.treasuryMonPurchase = fmtMon(treasuryBefore - (await monBalance(TREASURY)));
    diag.wire = wire;
    console.log(`[52] purchase done=${purchased} wire=${JSON.stringify(wire)} payError=${JSON.stringify(diag.payError ?? null)}`);
    await page.screenshot({ path: `${ARTIFACTS}/52-purchase-done.png`, fullPage: true }).catch(() => undefined);
    expect(purchased, `purchase must reach 결제 완료 (payError=${JSON.stringify(diag.payError ?? null)})`).toBe(true);

    // 2d. Follow 내 티켓 보기 → the ticket list → the one ticket's detail. The tokenId is the
    // detail route segment, the authoritative UI source of it.
    await toTickets.click();
    await page.waitForURL(/\/tickets(\/|$)/, { timeout: 30_000 });
    // 영수증 보기 lands on the detail itself; 내 티켓 보기 lands on the list, one tap away.
    if (!/\/tickets\/\d+/.test(page.url())) {
      const ticketRow = page.locator('a.ticket-row').first();
      await expect(ticketRow).toBeVisible({ timeout: 45_000 });
      await ticketRow.click();
    }
    await page.waitForURL(/\/tickets\/\d+/, { timeout: 30_000 });
    const tokenIdFromUrl = page.url().match(/\/tickets\/(\d+)/)?.[1];
    diag.tokenIdFromUrl = tokenIdFromUrl;
    if (tokenIdFromUrl && !wire.tokenId) wire.tokenId = tokenIdFromUrl;
    console.log(`[52] ticket detail tokenId=${tokenIdFromUrl}`);

    // The receipt reads 보관 중 once the order doc reflects the deposit. It is watched live, so
    // poll a short while for the status line to settle.
    const receiptTitle = page.getByRole('heading', { name: RECEIPT_TITLE, exact: true });
    const heldLine = page.getByText(STATUS_HELD, { exact: true });
    await expect(receiptTitle).toBeVisible({ timeout: 30_000 });
    let held = false;
    const heldDeadline = Date.now() + 60_000;
    while (Date.now() < heldDeadline) {
      if (await heldLine.isVisible().catch(() => false)) { held = true; break; }
      await page.waitForTimeout(2000);
    }
    diag.receiptHeld = held;

    // The deposit/receipt tx hash sits on the 결제 기록 원본 link (in a <details>), href = explorer/tx/<hash>.
    const receiptLink = page.getByRole('link', { name: '결제 기록 원본', exact: true });
    const href = await receiptLink.getAttribute('href').catch(() => null);
    const txFromHref = href?.match(/\/tx\/(0x[0-9a-fA-F]+)/)?.[1];
    if (txFromHref) wire.txHash = wire.txHash ?? txFromHref;
    diag.depositTxHash = wire.txHash ?? null;
    diag.wire = wire;
    console.log(`[52] receiptHeld=${held} tokenId=${wire.tokenId} account=${wire.account} depositTx=${wire.txHash}`);
    await page.screenshot({ path: `${ARTIFACTS}/52-ticket-receipt.png`, fullPage: true }).catch(() => undefined);
    expect(held, 'receipt must read 보관 중 (escrow Held)').toBe(true);
    expect(wire.tokenId, 'a tokenId must be captured').toBeTruthy();
    expect(wire.account, 'attendee smart-account must be captured').toBeTruthy();
  } finally {
    diag.finishedAt = new Date().toISOString();
    writeFileSync(DIAG_PATH, JSON.stringify(diag, null, 2));
    console.log(`[52] diag written: ${DIAG_PATH}`);
    await closePersona(user);
  }
});
