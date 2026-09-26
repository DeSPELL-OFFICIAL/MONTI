import { test, expect } from '@playwright/test';
import { ADMIN, USERS } from '../fixtures/personas';
import { closePersona, ensureAccount, openPersona, pool, type PersonaSession } from '../utils/session';
import { createOrganizerAndEvent, publishEvent } from '../utils/organizer';
import { approveAll, approveSelected, claimFree, hasTicketFor, myTickets, requestApproval, seesApproved } from '../utils/claim';

/**
 * The real-usage scenarios, serial and single-worker because every one spends on-chain
 * operations through a shared paymaster. The nine-user fan-out throttles to three at a time.
 *
 * Approval scenarios (d and the approval-required event in a) run only with E2E_APPROVAL=1 AND a
 * build where VITE_APPROVAL_MODES=on — both arrive with the 01c deploy. Paid tickets stay
 * blocked by the contract, so scenario a asserts the honest block rather than a sale.
 */
const APPROVAL = process.env.E2E_APPROVAL === '1';

const FREE_TITLE = '무료 선착순 테스트 행사';
const SOLDOUT_TITLE = '5석 한정 마감 테스트';
const APPROVAL_TITLE = '관리자 승인 테스트 행사';

test.describe.serial('MONTI persona harness (admin + 9 users)', () => {
  let admin: PersonaSession;
  const users: PersonaSession[] = [];
  let freeEventId = '';
  let soldOutEventId = '';
  let approvalEventId = '';

  test.afterAll(async () => {
    for (const s of users) await closePersona(s).catch(() => undefined);
    if (admin) await closePersona(admin).catch(() => undefined);
  });

  test('a: admin signs up and creates events (free 선착순, paid → blocked, approval flagged)', async ({ browser }) => {
    admin = await openPersona(browser, ADMIN);
    await ensureAccount(admin);

    const free = await createOrganizerAndEvent(admin.page, {
      personaId: ADMIN.id,
      orgName: '몬티 크루',
      title: FREE_TITLE,
      intro: 'E2E 자동화가 만든 무료 선착순 행사입니다. 누구나 바로 티켓을 받을 수 있어요.',
      venue: '서울 성수동 테스트홀',
      tiers: [{ kind: '무료', mode: '선착순', name: '일반', supply: 100 }],
    });
    expect(free.blocked).toBe(false);
    expect(free.eventId).toBeTruthy();
    freeEventId = free.eventId!;
    await publishEvent(admin.page, ADMIN.id, freeEventId);

    // Approval-required event — only when the flag AND the build allow it.
    if (APPROVAL) {
      const appr = await createOrganizerAndEvent(admin.page, {
        personaId: ADMIN.id,
        orgName: '몬티 크루',
        title: APPROVAL_TITLE,
        intro: 'E2E 자동화가 만든 관리자 승인 행사입니다. 신청 후 승인되면 발급됩니다.',
        venue: '서울 성수동 테스트홀',
        tiers: [{ kind: '무료', mode: '관리자 승인', name: '일반', supply: 100 }],
      });
      expect(appr.eventId).toBeTruthy();
      approvalEventId = appr.eventId!;
      await publishEvent(admin.page, ADMIN.id, approvalEventId);
    }

    // Paid tier — expected to hold the create button disabled with the honest block copy.
    const paid = await createOrganizerAndEvent(admin.page, {
      personaId: ADMIN.id,
      orgName: '몬티 크루',
      title: '유료 티켓 테스트 행사',
      intro: 'E2E 자동화가 만든 유료 행사입니다. 유료는 아직 막혀 있어야 합니다.',
      venue: '서울 성수동 테스트홀',
      tiers: [{ kind: '유료', name: 'VIP', price: 10000, limit: 2 }],
    });
    expect(paid.blocked).toBe(true);
    expect(paid.eventId).toBeNull();
  });

  test('b + c: 9 users sign up (throttled to 3) and claim the free event', async ({ browser }) => {
    expect(freeEventId, 'free event must exist from scenario a').toBeTruthy();
    await pool(USERS, 3, async (persona) => {
      const session = await openPersona(browser, persona);
      users.push(session);
      await ensureAccount(session);
    });
    expect(users.length).toBe(9);

    for (const session of users) {
      const outcome = await claimFree(session.page, session.persona.id, freeEventId);
      expect(['claimed', 'confirming'], `${session.persona.id} claim outcome`).toContain(outcome);
    }
    // The ticket shows in 내 티켓 with its TicketArt (art label carries the event title).
    for (const session of users) {
      expect(await hasTicketFor(session.page, FREE_TITLE), `${session.persona.id} ticket visible`).toBe(true);
      expect(await myTickets(session.page, session.persona.id)).toBeGreaterThanOrEqual(1);
    }
  });

  test('e: claiming the same event twice hits the per-person limit copy', async () => {
    const session = users[0];
    const outcome = await claimFree(session.page, session.persona.id, freeEventId);
    expect(outcome).toBe('limit');
  });

  test('d: approval flow — request, approve 4 selected + 전체 승인, users see 승인됨', async () => {
    test.skip(!APPROVAL, 'approval UI (신청 관리) + VITE_APPROVAL_MODES arrive with the 01c deploy');
    expect(approvalEventId).toBeTruthy();
    for (const session of users) {
      const r = await requestApproval(session.page, session.persona.id, approvalEventId);
      expect(['pending', 'confirming']).toContain(r);
    }
    await approveSelected(admin.page, approvalEventId, 4);
    await approveAll(admin.page, approvalEventId);
    for (const session of users) {
      expect(await seesApproved(session.page, approvalEventId)).toBe(true);
    }
  });

  test('f: sold-out — a 5-seat event with 9 claimers, the last see 마감 copy', async () => {
    const soldOut = await createOrganizerAndEvent(admin.page, {
      personaId: ADMIN.id,
      orgName: '몬티 크루',
      title: SOLDOUT_TITLE,
      intro: 'E2E 자동화가 만든 5석 한정 행사입니다. 5명이 받으면 마감됩니다.',
      venue: '서울 성수동 테스트홀',
      tiers: [{ kind: '무료', mode: '선착순', name: '일반', supply: 5 }],
    });
    expect(soldOut.eventId).toBeTruthy();
    soldOutEventId = soldOut.eventId!;
    await publishEvent(admin.page, ADMIN.id, soldOutEventId);

    // Sequential, with a beat between each, so the indexer's minted count can catch up and the
    // 마감 copy (which reads supply−minted off the indexer) is the honest result for late claimers.
    const outcomes: string[] = [];
    for (const session of users) {
      outcomes.push(await claimFree(session.page, session.persona.id, soldOutEventId));
      await session.page.waitForTimeout(2500);
    }
    const got = outcomes.filter((o) => o === 'claimed' || o === 'confirming').length;
    const blocked = outcomes.filter((o) => o === 'soldout' || o === 'failed').length;
    // At most five could really be minted; the rest must be turned away.
    expect(got).toBeLessThanOrEqual(6);
    expect(blocked).toBeGreaterThan(0);
    expect(outcomes.slice(5).some((o) => o === 'soldout')).toBe(true);
  });
});
