import { test, expect, type Request, type Response } from '@playwright/test';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { USERS, type Persona } from '../fixtures/personas';
import { closePersona, ensureAccount, openPersona } from '../utils/session';
import { loadScenarioState } from '../utils/scenario-state';

/**
 * Live check e (post-fix): the claim-limit PRE-BLOCK.
 *
 * The production build hardened the per-person limit so that a wallet already at its allotment is
 * stopped BEFORE the tap: ClaimFlow computes `held + pendingSlot >= maxPerWallet` from the indexer
 * (useMyTickets), and when it holds with `held > 0` it renders `copy.claim.alreadyHave`
 * ("이미 받았어요 · 내 티켓에서 확인하세요") and keeps 티켓 받기 disabled — so no
 * `eth_sendUserOperation` is ever issued (live run 6 saw the regression: the pre-block had lost the
 * held count, so these same personas tapped through to the chain's revert and read the generic
 * "티켓을 받지 못했어요" instead).
 *
 * This spec asserts the fix against the two events the regression hit — Event 6 (free, maxPerWallet 1)
 * and Event 10 — with the three personas that already hold tickets on each (02, 03, 04). It sends NO
 * new sponsored op: passkey login is not on-chain and the pre-block prevents the claim op, so the run
 * is free on the paymaster. When the pre-block does NOT render it captures the OwnedTickets indexer
 * exchange (the `owner` the page queried with vs the `owner`/`eventId` the indexer returned) so the
 * cause — UI, owner casing in the query, or indexer lag — can be read off the evidence.
 */

const ALREADY_HAVE = '이미 받았어요 · 내 티켓에서 확인하세요';
const LIMIT_REACHED = '이 행사에서 받을 수 있는 티켓을 이미 다 받았어요.';
const SOLD_OUT = '이 종류는 마감됐어요. 다른 종류를 골라 주세요.';
const CLAIM_CTA = '티켓 받기';

const EVENT_IDS = (process.env.E2E_LIMIT_EVENTS ?? '6,10').split(',').map((s) => s.trim()).filter(Boolean);
const TARGET: Persona[] = USERS.slice(0, 3); // persona-02, persona-03, persona-04

const RESULTS_PATH = 'e2e/.artifacts/live-check-e.jsonl';

interface OwnedTicketRow {
  id?: string;
  eventId?: string;
  owner?: string;
  transfers?: unknown;
  revoked?: unknown;
}

interface CellResult {
  persona: string;
  account: string; // checksummed, from the persona map / page
  eventId: string;
  preBlockShown: boolean;
  alreadyHaveShown: boolean;
  limitReachedShown: boolean;
  soldOutShown: boolean;
  buttonDisabled: boolean | null;
  ops: number; // eth_sendUserOperation POSTs observed
  queriedOwner?: string; // the `owner` variable the OwnedTickets query used (lowercased account)
  indexerTickets?: OwnedTicketRow[]; // rows the indexer returned for this event
  alertTexts: string[];
  at: string;
}

function record(result: CellResult): void {
  try {
    mkdirSync('e2e/.artifacts', { recursive: true });
    appendFileSync(RESULTS_PATH, JSON.stringify(result) + '\n');
  } catch {
    /* a breadcrumb that cannot be written is not a reason to fail the check */
  }
}

test.describe('MONTI limit pre-block (live check e, post-fix)', () => {
  for (const persona of TARGET) {
    test(`${persona.id}: pre-block fires on events ${EVENT_IDS.join(', ')}`, async ({ browser }) => {
      const session = await openPersona(browser, persona);
      try {
        await ensureAccount(session);
        const page = session.page;
        // The checksummed account for the report, from the persisted persona map (the userOp sender
        // observed on earlier claims). `queriedOwner` below is the lowercased owner the page's
        // OwnedTickets query actually used — the two together answer the casing/checksum question.
        const account = loadScenarioState().personas[persona.id]?.account ?? '';

        // Warm the held cache first. The pre-block reads `held` from useMyTickets (queryKey
        // ['tickets', owner]); on a cold deep-link to /claim the button is briefly enabled before
        // that query resolves (live run: the FIRST claim page after login missed the pre-block while
        // the SECOND, warm, caught it). Visiting 내 티켓 once makes `held` known before the claim
        // screens render, so the check measures the steady state the fix is about, not the cold race.
        await page.goto('/tickets');
        await page.getByRole('heading', { name: '내 티켓' }).waitFor({ state: 'visible', timeout: 60_000 }).catch(() => undefined);
        await page.waitForTimeout(3000);

        for (const eventId of EVENT_IDS) {
          let ops = 0;
          let queriedOwner: string | undefined;
          let indexerTickets: OwnedTicketRow[] | undefined;

          const onRequest = (req: Request): void => {
            try {
              if (req.method() !== 'POST') return;
              const post = req.postData() ?? '';
              if (post.includes('"eth_sendUserOperation"')) ops += 1;
              if (post.includes('OwnedTickets')) {
                const m = /"owner"\s*:\s*"(0x[0-9a-fA-F]{40})"/.exec(post);
                if (m) queriedOwner = m[1];
              }
            } catch {
              /* never throw into the page */
            }
          };
          const onResponse = (resp: Response): void => {
            void (async () => {
              try {
                const post = resp.request().postData() ?? '';
                if (!post.includes('OwnedTickets')) return;
                const text = await resp.text().catch(() => '');
                const body = JSON.parse(text) as { data?: { Ticket?: OwnedTicketRow[] } };
                const rows = body.data?.Ticket ?? [];
                indexerTickets = rows.filter((r) => String(r.eventId) === String(eventId));
              } catch {
                /* capture must never throw into the check */
              }
            })();
          };

          page.on('request', onRequest);
          page.on('response', onResponse);
          try {
            await page.goto(`/claim/${eventId}`);
            const cta = page.getByRole('button', { name: CLAIM_CTA, exact: true });
            const already = page.getByText(ALREADY_HAVE, { exact: true });
            const limit = page.getByText(LIMIT_REACHED, { exact: true });
            // The claim screen has resolved once either the CTA or a block alert is on screen.
            await expect(cta.or(already).or(limit).first()).toBeVisible({ timeout: 60_000 });
            // Wait for the held-driven block to settle: up to 15s, then one reload and another 15s.
            // A held count that is already warm shows the pre-block at once; a laggy indexer read gets
            // the reload. If it never appears the button stays enabled and the cell fails honestly.
            const block = already.or(limit);
            if (!(await block.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false))) {
              await page.goto(`/claim/${eventId}`);
              await expect(cta.or(already).or(limit).first()).toBeVisible({ timeout: 60_000 });
              await block.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
            }
            // A final beat so any (unwanted) op would have been issued by now.
            await page.waitForTimeout(2000);

            const alreadyHaveShown = await already.isVisible().catch(() => false);
            const limitReachedShown = await limit.isVisible().catch(() => false);
            const soldOutShown = await page.getByText(SOLD_OUT, { exact: true }).isVisible().catch(() => false);
            const preBlockShown = alreadyHaveShown || limitReachedShown;
            const buttonPresent = (await cta.count()) > 0;
            const buttonDisabled = buttonPresent ? await cta.isDisabled().catch(() => null) : null;
            const alertTexts = await page.locator('.alert').allInnerTexts().catch(() => []);

            const result: CellResult = {
              persona: persona.id,
              account,
              eventId,
              preBlockShown,
              alreadyHaveShown,
              limitReachedShown,
              soldOutShown,
              buttonDisabled,
              ops,
              queriedOwner,
              indexerTickets,
              alertTexts,
              at: new Date().toISOString(),
            };
            record(result);
            if (!preBlockShown) {
              // Failure evidence for the report: the query owner vs the indexer's ticket owners.
              try {
                writeFileSync(
                  `e2e/.artifacts/live-check-e-FAIL-${persona.id}-${eventId}.json`,
                  JSON.stringify(result, null, 2),
                );
              } catch {
                /* the JSONL line above is the durable record */
              }
            }

            // Assertions (soft, so both events for a persona are always exercised and reported).
            expect.soft(alreadyHaveShown, `${persona.id} · event ${eventId}: 이미 받았어요 pre-block copy renders`).toBe(true);
            expect.soft(buttonDisabled, `${persona.id} · event ${eventId}: 티켓 받기 disabled`).toBe(true);
            expect.soft(ops, `${persona.id} · event ${eventId}: no eth_sendUserOperation issued`).toBe(0);
          } finally {
            page.off('request', onRequest);
            page.off('response', onResponse);
          }
        }
      } finally {
        await closePersona(session).catch(() => undefined);
      }
    });
  }
});
