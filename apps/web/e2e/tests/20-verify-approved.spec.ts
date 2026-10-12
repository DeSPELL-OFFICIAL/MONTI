import { test, expect, type Browser } from '@playwright/test';
import { USERS } from '../fixtures/personas';
import { closePersona, ensureAccount, openPersona } from '../utils/session';
import { hasTicketFor, seesApproved } from '../utils/claim';
import { getEvent } from '../utils/scenario-state';

/**
 * Read-only verification, NO on-chain operations (LIVE RUN 6). Scenario d approved Event 7's
 * ClaimRequests on chain (all Approved, tokenIds minted). This confirms the attendee side: an
 * approved requester either reads the 승인됨 state on /claim, or already holds the minted ticket in
 * 내 티켓 (the durable success signal once the mint is indexed). It only logs in (passkey, free) and
 * reads two screens — it never creates, claims, requests, or approves, so it spends nothing.
 *
 * Personas are indices into USERS (0 = persona-02). Default checks one reused requester (02) and one
 * fresh requester (06). Override with E2E_VERIFY_PERSONAS="0,4,5".
 */
const APPROVAL_TITLE = 'Approval-only test event';

test('verify: approved requesters see 승인 or hold the minted ticket (read-only)', async ({ browser }: { browser: Browser }) => {
  const appr = getEvent('approval');
  test.skip(!appr, 'needs the approval event id in scenario.json');
  const apprId = appr!.id;

  const idxs = (process.env.E2E_VERIFY_PERSONAS ?? '0,4').split(',').map((s) => Number(s.trim()));
  for (const i of idxs) {
    const persona = USERS[i]!;
    const session = await openPersona(browser, persona);
    await ensureAccount(session);
    const ticket = await hasTicketFor(session.page, APPROVAL_TITLE);
    const approved = await seesApproved(session.page, apprId);
    console.log(`VERIFY ${persona.id}: hasTicket=${ticket} seesApproved=${approved}`);
    await closePersona(session).catch(() => undefined);
    // The user-facing truth of an approved request is the minted ticket; the 승인됨 alert is the
    // transient state before it. Either one proves the approval reached the attendee.
    expect(ticket || approved, `${persona.id} sees approval or holds ticket`).toBe(true);
  }
});
