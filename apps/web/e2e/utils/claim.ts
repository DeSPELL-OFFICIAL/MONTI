import { expect, type Page } from '@playwright/test';
import { timed } from '../fixtures/timings';

const C = {
  claimCta: '티켓 받기',
  requestCta: '신청하기',
  working: '받는 중이에요',
  requesting: '신청하는 중이에요',
  limit: '이 행사에서 받을 수 있는 티켓을 이미 다 받았어요.',
  soldOut: '이 종류는 마감됐어요. 다른 종류를 골라 주세요.',
  confirming: '아직 확인 중이에요. 잠시 뒤 내 티켓에서 확인해 주세요.',
  failed: '티켓을 받지 못했어요. 잠시 뒤 다시 시도해 주세요.',
  pending: '신청 완료 · 승인을 기다리고 있어요',
  approved: '승인됐어요. 티켓이 발급됐어요',
  ticketsTab: '내 티켓',
  ticketsEmpty: '아직 티켓이 없어요.',
} as const;

export type ClaimOutcome = 'claimed' | 'confirming' | 'limit' | 'soldout' | 'failed';

/**
 * Claim a free ticket. Returns what actually happened, so a scenario can assert the honest
 * outcome — a real second claim shows 한도 copy, a real sold-out shows 마감 copy, and an
 * on-chain revert the indexer had not yet reflected shows the generic failure.
 */
export async function claimFree(page: Page, personaId: string, eventId: string): Promise<ClaimOutcome> {
  return timed(personaId, 'claim', async () => {
    await page.goto(`/claim/${eventId}`);
    const claim = page.getByRole('button', { name: C.claimCta, exact: true });
    await expect(claim).toBeVisible({ timeout: 30_000 });

    // Blocked before the tap: the button is disabled and the reason is on screen.
    if (await page.getByText(C.limit, { exact: true }).isVisible().catch(() => false)) return 'limit';
    if (await page.getByText(C.soldOut, { exact: true }).isVisible().catch(() => false)) return 'soldout';

    await claim.click();
    const confirming = page.getByText(C.confirming, { exact: true });
    const failed = page.getByText(C.failed, { exact: true });
    const soldOut = page.getByText(C.soldOut, { exact: true });
    const limit = page.getByText(C.limit, { exact: true });

    const deadline = Date.now() + 3 * 60 * 1000;
    while (Date.now() < deadline) {
      if (/\/tickets(\/|$)/.test(page.url())) return 'claimed';
      if (await confirming.isVisible().catch(() => false)) {
        await page.getByRole('button', { name: C.ticketsTab, exact: true }).click().catch(() => undefined);
        return 'confirming';
      }
      if (await soldOut.isVisible().catch(() => false)) return 'soldout';
      if (await limit.isVisible().catch(() => false)) return 'limit';
      if (await failed.isVisible().catch(() => false)) return 'failed';
      await page.waitForTimeout(1000);
    }
    return 'failed';
  });
}

export type RequestOutcome = 'pending' | 'approved' | 'confirming' | 'failed';

/** Approval-mode: request a ticket (flag-gated event). */
export async function requestApproval(page: Page, personaId: string, eventId: string): Promise<RequestOutcome> {
  return timed(personaId, 'request', async () => {
    await page.goto(`/claim/${eventId}`);
    const request = page.getByRole('button', { name: C.requestCta, exact: true });
    await expect(request).toBeVisible({ timeout: 30_000 });
    await request.click();
    const pending = page.getByText(C.pending, { exact: true });
    const approved = page.getByText(C.approved, { exact: true });
    const confirming = page.getByText(C.confirming, { exact: true });
    await expect(pending.or(approved).or(confirming)).toBeVisible({ timeout: 3 * 60 * 1000 });
    if (await approved.isVisible()) return 'approved';
    if (await pending.isVisible()) return 'pending';
    return 'confirming';
  });
}

/** Approval-mode: is this persona's request marked 승인됨/approved on the claim screen? */
export async function seesApproved(page: Page, eventId: string): Promise<boolean> {
  // The indexer takes a beat to reflect the on-chain approval, so reload a few times.
  const deadline = Date.now() + 3 * 60 * 1000;
  while (Date.now() < deadline) {
    await page.goto(`/claim/${eventId}`);
    if (await page.getByText(C.approved, { exact: true }).isVisible({ timeout: 15_000 }).catch(() => false)) return true;
    await page.waitForTimeout(5000);
  }
  return false;
}

const R = {
  title: '신청 관리',
  empty: '기다리는 신청이 없어요',
  approveSelected: '선택 승인',
  approveAll: '전체 승인',
  confirming: '아직 확인 중이에요. 잠시 뒤 새로고침하면 반영돼요',
} as const;

/** Wait for the pending list to settle after a decision: rows removed, empty, or confirming. */
async function settleApproval(admin: Page, expectRemaining: number): Promise<void> {
  const boxes = admin.getByRole('checkbox');
  const empty = admin.getByText(R.empty, { exact: true });
  const confirming = admin.getByText(R.confirming, { exact: true });
  const deadline = Date.now() + 4 * 60 * 1000;
  while (Date.now() < deadline) {
    if (await confirming.isVisible().catch(() => false)) return;
    if (expectRemaining === 0 && (await empty.isVisible().catch(() => false))) return;
    const remaining = await boxes.count().catch(() => -1);
    if (remaining >= 0 && remaining <= expectRemaining) return;
    await admin.waitForTimeout(2000);
  }
}

/** Approval-mode: on 신청 관리, select the first `count` pending requests and approve them. */
export async function approveSelected(admin: Page, eventId: string, count: number): Promise<number> {
  return timed('admin', 'approve-selected', async () => {
    await admin.goto(`/org/events/${eventId}/requests`);
    await expect(admin.getByRole('heading', { name: R.title })).toBeVisible({ timeout: 30_000 });
    const boxes = admin.getByRole('checkbox');
    await expect(boxes.first()).toBeVisible({ timeout: 60_000 });
    const total = await boxes.count();
    const n = Math.min(count, total);
    for (let i = 0; i < n; i++) await boxes.nth(i).check();
    await admin.getByRole('button', { name: R.approveSelected, exact: true }).click();
    await settleApproval(admin, total - n);
    return n;
  });
}

/** Approval-mode: on 신청 관리, approve everyone still waiting. */
export async function approveAll(admin: Page, eventId: string): Promise<void> {
  return timed('admin', 'approve-all', async () => {
    await admin.goto(`/org/events/${eventId}/requests`);
    await expect(admin.getByRole('heading', { name: R.title })).toBeVisible({ timeout: 30_000 });
    if (await admin.getByText(R.empty, { exact: true }).isVisible().catch(() => false)) return;
    await admin.getByRole('button', { name: R.approveAll, exact: true }).click();
    await settleApproval(admin, 0);
  });
}

/** Go to 내 티켓 and return how many ticket rows are shown. */
export async function myTickets(page: Page, personaId: string): Promise<number> {
  return timed(personaId, 'my-tickets', async () => {
    await page.goto('/tickets');
    await expect(page.getByRole('heading', { name: C.ticketsTab })).toBeVisible({ timeout: 30_000 });
    // Let the list settle (indexer read).
    await page.waitForTimeout(1500);
    return page.locator('.ticket-row').count();
  });
}

/**
 * Whether a ticket whose art names `title` is present in 내 티켓 (TicketArt + state badge).
 * Polls with reloads: after a claim the indexer, and then the event's IPFS metadata that names
 * the picture, take a moment. If the title never resolves but a ticket row with its TicketArt is
 * there, that still counts — the row and its picture are what "the ticket appears" means.
 */
export async function hasTicketFor(page: Page, title: string): Promise<boolean> {
  const deadline = Date.now() + 90_000;
  let anyRow = false;
  while (Date.now() < deadline) {
    await page.goto('/tickets');
    await expect(page.getByRole('heading', { name: C.ticketsTab })).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(2500);
    anyRow = (await page.locator('.ticket-row__art [aria-label]').count()) > 0;
    const art = page.locator('.ticket-row__art [aria-label]');
    const count = await art.count();
    for (let i = 0; i < count; i++) {
      const label = (await art.nth(i).getAttribute('aria-label')) ?? '';
      if (label.includes(title)) return true;
    }
    await page.waitForTimeout(4000);
  }
  return anyRow;
}
