import { expect, type Page } from '@playwright/test';
import { timed } from '../fixtures/timings';
import { attachRelayCapture } from './relay-capture';

const C = {
  claimCta: 'Get a ticket',
  requestCta: 'Request a ticket',
  working: 'Getting your ticket',
  // Success is now an in-place 완료 state on the claim screen (ClaimFlow phase 'done'),
  // not a silent navigate('/tickets') — plan T-SIMP-1 ③. This copy is how a claim reads as landed.
  done: "You got your ticket · It's in My tickets",
  requesting: 'Sending your request',
  limit: 'You already have every ticket this event allows.',
  alreadyHave: 'You already have your tickets for this event. Check My tickets.',
  soldOut: 'This type is sold out. Please pick another one.',
  confirming: 'Still confirming. Your ticket will show up under My tickets shortly.',
  failed: 'Could not get the ticket. Please try again shortly.',
  pending: 'Request sent · waiting for approval',
  approved: 'Approved. You got your ticket',
  ticketsTab: 'Tickets',
  ticketsTitle: 'My tickets',
  ticketsEmpty: 'No tickets yet.',
} as const;

export type ClaimOutcome = 'claimed' | 'confirming' | 'limit' | 'soldout' | 'failed';

/**
 * Claim a free ticket. Returns what actually happened, so a scenario can assert the honest
 * outcome — a real second claim shows 한도 copy, a real sold-out shows 마감 copy, and an
 * on-chain revert the indexer had not yet reflected shows the generic failure.
 */
export async function claimFree(page: Page, personaId: string, eventId: string): Promise<ClaimOutcome> {
  const capture = attachRelayCapture(page, { persona: personaId, eventId });
  try {
    const outcome = await timed(personaId, 'claim', async (): Promise<ClaimOutcome> => {
      await page.goto(`/claim/${eventId}`);
      const claim = page.getByRole('button', { name: C.claimCta, exact: true });
      await expect(claim).toBeVisible({ timeout: 30_000 });

      // Blocked before the tap. On a cold /claim load the held/pending counts have not resolved yet
      // (the button shows a quiet 확인 중… and stays disabled), so the pre-block reason can lag a
      // beat — poll until a block reason shows OR the button becomes enabled (claimable). An
      // already-holder sees `alreadyHave`, a maxPerWallet-0 tier sees `limitReached`; both are a
      // 'limit' outcome and both keep 받기 disabled, so a tap would only time out on the disabled
      // button (live run 7, scenario e: alreadyHave was unrecognised → click on disabled → timeout).
      const limitTxt = page.getByText(C.limit, { exact: true });
      const alreadyTxt = page.getByText(C.alreadyHave, { exact: true });
      const soldTxt = page.getByText(C.soldOut, { exact: true });
      const preBlockDeadline = Date.now() + 20_000;
      while (Date.now() < preBlockDeadline) {
        if (await limitTxt.isVisible().catch(() => false)) return 'limit';
        if (await alreadyTxt.isVisible().catch(() => false)) return 'limit';
        if (await soldTxt.isVisible().catch(() => false)) return 'soldout';
        if (await claim.isEnabled().catch(() => false)) break;
        await page.waitForTimeout(500);
      }

      await claim.click();
      const confirming = page.getByText(C.confirming, { exact: true });
      const done = page.getByText(C.done, { exact: true });
      const failed = page.getByText(C.failed, { exact: true });
      const soldOut = page.getByText(C.soldOut, { exact: true });
      const limit = page.getByText(C.limit, { exact: true });

      const deadline = Date.now() + 3 * 60 * 1000;
      while (Date.now() < deadline) {
        if (/\/tickets(\/|$)/.test(page.url())) return 'claimed';
        // The claim now completes in place (no auto-navigate): the 완료 alert is the success signal.
        if (await done.isVisible().catch(() => false)) return 'claimed';
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
    // A real failure: pull the relayClaim callable's refusal out of the page's network log into the
    // artifacts and the friction log (a `sent` relay that later fails leaves its reason only in the
    // relays/{id} doc, so flushFailure records a bare breadcrumb then). Let the response handler drain.
    if (outcome === 'failed') {
      await page.waitForTimeout(500).catch(() => undefined);
      capture.flushFailure();
    }
    return outcome;
  } finally {
    capture.detach();
  }
}

export type RequestOutcome = 'pending' | 'approved' | 'confirming' | 'failed';

/** Approval-mode: request a ticket (flag-gated event). */
export async function requestApproval(page: Page, personaId: string, eventId: string): Promise<RequestOutcome> {
  // A request is a relayClaim call with mode:'request', so the relay capture records this persona's
  // account (request-only personas never claim, so this is the only place their account is seen) and
  // any request refusal. Not for the reused-pending fast path, but harmless there — it sees no relay.
  const capture = attachRelayCapture(page, { persona: personaId, eventId });
  try {
    return await timed(personaId, 'request', async () => {
    await page.goto(`/claim/${eventId}`);
    const pending = page.getByText(C.pending, { exact: true });
    const approved = page.getByText(C.approved, { exact: true });
    const confirming = page.getByText(C.confirming, { exact: true });
    const request = page.getByRole('button', { name: C.requestCta, exact: true });
    // Re-run resilience: a request this persona already made in an earlier run renders the
    // pending/approved state directly (ClaimFlow's hasLiveRequest branch has no 신청하기 button),
    // so wait for the screen to resolve to EITHER that state or a fresh request button, then branch.
    await expect(pending.or(approved).or(request)).toBeVisible({ timeout: 30_000 });
    if (await approved.isVisible().catch(() => false)) return 'approved';
    if (await pending.isVisible().catch(() => false)) return 'pending';
    await request.click();
    // Grace window first, WITHOUT reloading: let the op submit and land on its own — the op's wait
    // runs up to 45s and ClaimFlow refetches the request status once when it settles (fast path:
    // pending shows in a few seconds). A reload mid-send would be needless churn here.
    const natural = pending.or(approved).or(confirming);
    if (await natural.waitFor({ state: 'visible', timeout: 90_000 }).then(() => true).catch(() => false)) {
      if (await approved.isVisible().catch(() => false)) return 'approved';
      if (await pending.isVisible().catch(() => false)) return 'pending';
      return 'confirming';
    }
    // Landed but the single refetch missed the row: requests, unlike claims, have no re-poll loop
    // (a real product friction — LIVE RUN 5 saw the pending state lag the indexer past this window
    // for some users), so reload to force useMyRequest to re-read the now-indexed request. The op
    // already landed, so it is not re-clicked. Honest: throws if nothing ever surfaces.
    const deadline = Date.now() + 2 * 60 * 1000;
    while (Date.now() < deadline) {
      await page.goto(`/claim/${eventId}`);
      await page.waitForTimeout(3000);
      if (await approved.isVisible().catch(() => false)) return 'approved';
      if (await pending.isVisible().catch(() => false)) return 'pending';
      if (await confirming.isVisible().catch(() => false)) return 'confirming';
      await page.waitForTimeout(4000);
    }
    throw new Error(`request for ${personaId} on ${eventId} never surfaced pending/approved/confirming`);
    });
  } catch (cause) {
    capture.flushFailure('request');
    throw cause;
  } finally {
    capture.detach();
  }
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
  title: 'Requests',
  empty: 'No requests are waiting',
  approveSelected: 'Approve selected',
  approveAll: 'Approve all',
  confirming: 'Still confirming. Refresh in a moment to see the change',
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
    await expect(page.getByRole('heading', { name: C.ticketsTitle })).toBeVisible({ timeout: 30_000 });
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
    await expect(page.getByRole('heading', { name: C.ticketsTitle })).toBeVisible({ timeout: 30_000 });
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
