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
  await page.goto(`/claim/${eventId}`);
  return page.getByText(C.approved, { exact: true }).isVisible({ timeout: 30_000 }).catch(() => false);
}

/**
 * Approval-mode organiser actions. The 신청 관리 (request management) screen is not in this
 * build — it arrives with the 01c deploy that also flips VITE_APPROVAL_MODES — so these throw a
 * clear signal until then. The flagged scenario is skipped unless E2E_APPROVAL=1.
 */
export async function approveSelected(_admin: Page, _eventId: string, _count: number): Promise<void> {
  throw new Error('APPROVAL_UI_NOT_DEPLOYED: 신청 관리 screen arrives with the 01c deploy');
}
export async function approveAll(_admin: Page, _eventId: string): Promise<void> {
  throw new Error('APPROVAL_UI_NOT_DEPLOYED: 신청 관리 screen arrives with the 01c deploy');
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

/** Whether a ticket whose art names `title` is present in 내 티켓 (TicketArt + state badge). */
export async function hasTicketFor(page: Page, title: string): Promise<boolean> {
  await page.goto('/tickets');
  await expect(page.getByRole('heading', { name: C.ticketsTab })).toBeVisible({ timeout: 30_000 });
  const art = page.locator('.ticket-row__art [aria-label]');
  const count = await art.count();
  for (let i = 0; i < count; i++) {
    const label = (await art.nth(i).getAttribute('aria-label')) ?? '';
    if (label.includes(title)) return true;
  }
  return false;
}
