import { test, expect, type Page } from '@playwright/test';
import { USERS, type Persona } from '../fixtures/personas';
import { closePersona, ensureAccount, openPersona } from '../utils/session';
import { attachBundlerCapture } from '../utils/bundler-capture';
import { timed } from '../fixtures/timings';

/**
 * 친구에게 주기 — persona-02 hands their Event 6 ticket to persona-08 (who holds none there).
 *
 * Extra scenario, off by default: it spends a sponsored on-chain op (the hand-over itself), so it
 * runs only under `E2E_EXTRA=1` and the controller schedules it against the paymaster budget.
 *
 * It drives the real UI — ticket detail → 친구에게 주기 → recipient by phone → 찾기 — and then
 * follows whichever hand-over the app routes to, because the app implements two and both are the
 * "give to a friend" flow:
 *
 *  - **direct member hand-over** (Confirm.tsx → `safeTransferFrom`): the number belongs to a member,
 *    so the app resolves it to an account and the sender confirms; the token moves at once.
 *  - **invite / offer** (useInvite.ts → `createTransferInvite` + `createOffer`, Inbox.tsx →
 *    `acceptOffer`): the number belongs to nobody yet, so the sender makes an offer and the
 *    recipient collects it from 받은 티켓함.
 *
 * The durable proof either way is the indexer's `Ticket.owner`: it is read straight off the indexer
 * (the same endpoint the app queries) before and after, and it must move off persona-02 to a new,
 * non-empty account. Both screens' copy is asserted along the path taken. Bundler errors on either
 * side are captured to the artifacts.
 */

const EXTRA = process.env.E2E_EXTRA === '1';
const describe = EXTRA ? test.describe : test.describe.skip;

const EVENT_ID = process.env.E2E_TRANSFER_EVENT ?? '6';
const SENDER: Persona = USERS[0]!; // persona-02
const RECIPIENT: Persona = USERS[6]!; // persona-08

/** Copy strings, verbatim from apps/web/src (tickets/transfer in ko.ts). */
const C = {
  ticketsTitle: '내 티켓',
  transfer: '친구에게 주기',
  byPhone: '전화번호',
  findCta: '찾기',
  confirmTitle: '이 분에게 줄까요?',
  confirmCta: '친구에게 주기',
  confirming: '아직 확인 중이에요. 잠시 뒤 내 티켓에서 확인해 주세요.',
  inviteTitle: '아직 가입하지 않은 번호예요',
  inviteCta: '초대 문자 보내기',
  inviteSent: '초대를 보냈어요. 상대가 가입하면 티켓이 자동으로 전달됩니다.',
  inboxTitle: '친구가 보낸 티켓',
  accept: '받기',
  accepted: '티켓을 받았어요',
  stateBefore: '입장 전',
} as const;

interface OwnedRow {
  id: string;
  eventId: string | number;
  owner: string;
  revoked?: unknown;
}

/**
 * Watch a page's `OwnedTickets` traffic: it captures the indexer endpoint (from the request URL)
 * and the last rows the indexer returned for this account (from the response body). Both are what
 * 내 티켓 already asks for, so nothing extra is issued.
 */
function watchOwned(page: Page): { rows: () => OwnedRow[]; envioUrl: () => string } {
  let rows: OwnedRow[] = [];
  let url = '';
  page.on('request', (req) => {
    if (url) return;
    const post = req.postData() ?? '';
    if (req.method() === 'POST' && post.includes('OwnedTickets')) url = req.url();
  });
  page.on('response', (resp) => {
    void (async () => {
      try {
        const post = resp.request().postData() ?? '';
        if (!post.includes('OwnedTickets')) return;
        const text = await resp.text().catch(() => '');
        const body = JSON.parse(text) as { data?: { Ticket?: OwnedRow[] } };
        if (body.data?.Ticket) rows = body.data.Ticket;
      } catch {
        /* the capture must never throw into the flow */
      }
    })();
  });
  return { rows: () => rows, envioUrl: () => url };
}

/** The indexer's own answer for who owns a token right now — the authoritative "did it move". */
async function ownerOf(envioUrl: string, id: string): Promise<string> {
  if (!envioUrl) return '';
  try {
    const res = await fetch(envioUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'query TicketOwner($id: String!) { Ticket(where: { id: { _eq: $id } }) { id owner eventId } }',
        variables: { id },
      }),
    });
    const body = (await res.json()) as { data?: { Ticket?: Array<{ owner?: string }> } };
    return (body.data?.Ticket?.[0]?.owner ?? '').toLowerCase();
  } catch {
    return '';
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('MONTI transfer (persona-02 → persona-08)', () => {
  test(`persona-02 gives their Event ${EVENT_ID} ticket to persona-08`, async ({ browser }) => {
    const sender = await openPersona(browser, SENDER);
    const recipient = await openPersona(browser, RECIPIENT);
    const senderWatch = watchOwned(sender.page);
    const recipientWatch = watchOwned(recipient.page);
    const senderCapture = attachBundlerCapture(sender.page, { persona: SENDER.id, eventId: EVENT_ID });
    const recipientCapture = attachBundlerCapture(recipient.page, { persona: RECIPIENT.id, eventId: EVENT_ID });

    try {
      await ensureAccount(sender);
      await ensureAccount(recipient);

      // Warm 내 티켓 so OwnedTickets fires: it gives us the indexer endpoint and persona-02's rows.
      await sender.page.goto('/tickets');
      await expect(sender.page.getByRole('heading', { name: C.ticketsTitle })).toBeVisible({ timeout: 60_000 });
      await sender.page.waitForTimeout(3000);

      const held = senderWatch.rows().find((r) => String(r.eventId) === EVENT_ID && !r.revoked);
      test.skip(!held, `persona-02 holds no Event ${EVENT_ID} ticket in the indexer — nothing to give`);
      const tokenId = held!.id;
      const senderAccount = (held!.owner ?? '').toLowerCase();
      const envioUrl = senderWatch.envioUrl();

      // Warm the recipient's list too, so its OwnedTickets endpoint/rows are live for the after-check.
      await recipient.page.goto('/tickets');
      await expect(recipient.page.getByRole('heading', { name: C.ticketsTitle })).toBeVisible({ timeout: 60_000 });
      await recipient.page.waitForTimeout(2000);

      const ownerBefore = await ownerOf(envioUrl, tokenId);
      expect(ownerBefore === '' || ownerBefore === senderAccount, 'indexer owner starts on persona-02').toBe(true);

      // Open the ticket and start the hand-over.
      await timed(SENDER.id, 'transfer.open-detail', async () => {
        await sender.page.goto(`/tickets/${tokenId}`);
        await expect(sender.page.getByRole('button', { name: C.transfer, exact: true })).toBeVisible({ timeout: 30_000 });
      });
      await sender.page.getByRole('button', { name: C.transfer, exact: true }).click();
      await expect(sender.page).toHaveURL(new RegExp(`/tickets/${tokenId}/transfer$`), { timeout: 30_000 });

      // Name the recipient by phone (a member resolves to a direct hand-over; a non-member to an invite).
      await sender.page.getByRole('tab', { name: C.byPhone, exact: true }).click();
      await sender.page.locator('input[type="tel"]').first().fill(RECIPIENT.national);
      await sender.page.getByRole('button', { name: C.findCta, exact: true }).click();

      const confirmHeading = sender.page.getByRole('heading', { name: C.confirmTitle });
      const inviteHeading = sender.page.getByRole('heading', { name: C.inviteTitle });
      await expect(confirmHeading.or(inviteHeading)).toBeVisible({ timeout: 60_000 });

      let path: 'direct' | 'invite';
      if (await inviteHeading.isVisible().catch(() => false)) {
        path = 'invite';
        // Sender's screen copy: the invite is made (createTransferInvite + createOffer), then 초대 보냄.
        await timed(SENDER.id, 'transfer.invite', async () => {
          await sender.page.getByRole('button', { name: C.inviteCta, exact: true }).first().click();
          await expect(sender.page).toHaveURL(new RegExp(`/tickets/${tokenId}/transfer/invite$`), { timeout: 30_000 });
          await sender.page.getByRole('button', { name: C.inviteCta, exact: true }).click();
          await expect(sender.page.getByText(C.inviteSent, { exact: true })).toBeVisible({ timeout: 4 * 60 * 1000 });
        });
        // Recipient's screen copy: the offer waits in 받은 티켓함 and 받기 collects it (acceptOffer).
        const accepted = await timed(RECIPIENT.id, 'transfer.accept', async (): Promise<boolean> => {
          const deadline = Date.now() + 4 * 60 * 1000;
          while (Date.now() < deadline) {
            await recipient.page.goto('/tickets/inbox');
            await expect(recipient.page.getByRole('heading', { name: C.inboxTitle })).toBeVisible({ timeout: 30_000 });
            const acceptBtn = recipient.page.getByRole('button', { name: C.accept, exact: true }).first();
            if (await acceptBtn.isVisible().catch(() => false)) {
              await acceptBtn.click();
              if (await recipient.page.getByText(C.accepted, { exact: true }).first().isVisible({ timeout: 4 * 60 * 1000 }).catch(() => false)) {
                return true;
              }
            }
            await recipient.page.waitForTimeout(4000);
          }
          return false;
        });
        expect(accepted, 'persona-08 collected the offer and saw 티켓을 받았어요').toBe(true);
      } else {
        path = 'direct';
        // Sender's screen copy: the confirmation names the recipient; confirming hands it over.
        await timed(SENDER.id, 'transfer.confirm', async () => {
          await sender.page.getByRole('button', { name: C.confirmCta, exact: true }).click();
          const deadline = Date.now() + 4 * 60 * 1000;
          while (Date.now() < deadline) {
            if (/\/tickets(?:\/(?!.*transfer)|$)/.test(sender.page.url()) && !/\/transfer/.test(sender.page.url())) return;
            if (await sender.page.getByText(C.confirming, { exact: true }).isVisible().catch(() => false)) return;
            await sender.page.waitForTimeout(2000);
          }
        });
      }

      // The durable proof, whichever path: indexer Ticket.owner moved off persona-02.
      const ownerAfter = await timed('transfer', 'verify.owner-moved', async (): Promise<string> => {
        const deadline = Date.now() + 3 * 60 * 1000;
        let owner = senderAccount;
        while (Date.now() < deadline) {
          owner = await ownerOf(envioUrl, tokenId);
          if (owner !== '' && owner !== senderAccount) return owner;
          await sleep(5000);
        }
        return owner;
      });
      expect(ownerAfter, `Event ${EVENT_ID} token ${tokenId} left persona-02 (${path} path)`).not.toBe(senderAccount);
      expect(ownerAfter, 'the indexer shows a new, non-empty owner').not.toBe('');

      // Recipient's screen copy: the token is now theirs and reads 입장 전 on its detail.
      const recipientHolds = await timed(RECIPIENT.id, 'verify.recipient-detail', async (): Promise<boolean> => {
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline) {
          await recipient.page.goto(`/tickets/${tokenId}`);
          if (await recipient.page.getByText(C.stateBefore, { exact: true }).isVisible({ timeout: 15_000 }).catch(() => false)) {
            return true;
          }
          await recipient.page.waitForTimeout(4000);
        }
        return false;
      });
      expect(recipientHolds, 'persona-08 now holds the ticket (내 티켓 detail shows 입장 전)').toBe(true);

      // Sender's screen: the indexer no longer lists the token among persona-02's held tickets.
      await sender.page.goto('/tickets');
      await sender.page.waitForTimeout(3000);
      expect(senderWatch.rows().some((r) => r.id === tokenId), 'persona-02 no longer holds the token').toBe(false);
      // Best-effort corroboration from the recipient's own list.
      expect.soft(recipientWatch.rows().some((r) => r.id === tokenId), 'persona-08 OwnedTickets lists the token').toBe(true);
    } finally {
      // Any bundler error seen on either side goes to the artifacts and the friction log.
      if (senderCapture.errors.length > 0) senderCapture.flushFailure('transfer sender');
      if (recipientCapture.errors.length > 0) recipientCapture.flushFailure('transfer recipient');
      senderCapture.detach();
      recipientCapture.detach();
      await closePersona(sender).catch(() => undefined);
      await closePersona(recipient).catch(() => undefined);
    }
  });
});
