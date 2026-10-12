import { test, expect, type Browser, type Page } from '@playwright/test';
import { ADMIN, USERS, type Persona } from '../fixtures/personas';
import { closePersona, ensureAccount, openPersona, pool, type PersonaSession } from '../utils/session';
import { createDraftAndPublish } from '../utils/organizer';
import { approveAll, approveSelected, claimFree, hasTicketFor, myTickets, requestApproval, seesApproved } from '../utils/claim';
import { getClaim, getEvent, markPublished, recordClaim, recordEvent, recordPersona } from '../utils/scenario-state';

/**
 * The real-usage scenarios, single-worker because every one spends on-chain operations the MONTI
 * relayer pays for. The nine-user fan-out throttles to three at a time.
 *
 * Approval scenarios (d and the approval-required event in a) run only with E2E_APPROVAL=1 AND a
 * build where VITE_APPROVAL_MODES=on — both arrive with the 01c deploy. Paid events (split rules
 * in the draft, one publish, one purchase) are covered end to end by 55.
 *
 * Independence (task-claim-failure-report §6): scenarios do NOT share describe-scope `let`s. When
 * one fails, Playwright restarts the worker and re-imports this module, which would reset any such
 * state to undefined and make every later scenario collapse in a millisecond ("unevaluated"). So
 * the cross-scenario facts — event ids by kind, published flags, the persona phone→uid/account
 * map, the claim ledger — are persisted to e2e/.state/scenario.json (scenario-state.ts) and read
 * back at the start of each scenario. Browser sessions cannot be serialised, so they are cached
 * per worker and reconstructed from the on-disk persona passkey state when the cache is empty. A
 * scenario that is missing a prerequisite skips with a clear reason instead of throwing.
 */
const APPROVAL = process.env.E2E_APPROVAL === '1';

const FREE_TITLE = 'Free first-come test event';
const SOLDOUT_TITLE = '5-seat sell-out test';
const APPROVAL_TITLE = 'Approval-only test event';

const now = (): string => new Date().toISOString();

// Fan-out size, tunable so a budget-limited live run can spend fewer relayed ops. Default 9 keeps
// the original full run; a reduced pass sets E2E_USERS (e.g. 3 for b+c, 4 for f). The first `USERS`
// personas are used, so the reduced set is always persona-02 … persona-(01+N).
const USER_COUNT = Math.min(Number(process.env.E2E_USERS ?? 9), USERS.length);
// Sold-out scenario f: seat count and how the "마감" assertion indexes the turned-away claimers.
const SOLDOUT_SUPPLY = Number(process.env.E2E_SOLDOUT_SUPPLY ?? 5);

// Live browser sessions, cached for this worker and keyed by persona id. A worker restart empties
// the cache; ensureSession then rebuilds each from the persisted passkey state (session.ts).
const sessions = new Map<string, PersonaSession>();

/** Best-effort Firebase Auth uid, read from IndexedDB — the account half of the map comes from the
 * account observed on the relay callable during a claim (relay-capture.ts). Never throws. */
async function readUid(page: Page): Promise<string | undefined> {
  try {
    return await page.evaluate(
      () =>
        new Promise<string | undefined>((resolve) => {
          try {
            const open = indexedDB.open('firebaseLocalStorageDb');
            open.onerror = () => resolve(undefined);
            open.onsuccess = () => {
              try {
                const db = open.result;
                if (!db.objectStoreNames.contains('firebaseLocalStorage')) return resolve(undefined);
                const req = db.transaction('firebaseLocalStorage', 'readonly').objectStore('firebaseLocalStorage').getAll();
                req.onerror = () => resolve(undefined);
                req.onsuccess = () => {
                  const rows = (req.result ?? []) as Array<{ value?: { uid?: string } }>;
                  for (const row of rows) if (row?.value?.uid) return resolve(row.value.uid);
                  resolve(undefined);
                };
              } catch {
                resolve(undefined);
              }
            };
          } catch {
            resolve(undefined);
          }
        }),
    );
  } catch {
    return undefined;
  }
}

/** Open (or reuse) a persona's session, signing it in, and record what we learn about it. */
async function ensureSession(browser: Browser, persona: Persona): Promise<PersonaSession> {
  const cached = sessions.get(persona.id);
  if (cached) return cached;
  const session = await openPersona(browser, persona);
  await ensureAccount(session);
  sessions.set(persona.id, session);
  recordPersona(persona.id, { phone: persona.phone, signedUp: true, uid: await readUid(session.page) });
  return session;
}

/** Ensure the first `count` attendee personas are signed in — cold opens throttled to three. */
async function ensureUsers(browser: Browser, count: number): Promise<PersonaSession[]> {
  const wanted = USERS.slice(0, count);
  await pool(wanted, 3, async (persona) => {
    await ensureSession(browser, persona);
  });
  return wanted.map((p) => sessions.get(p.id)!);
}

test.describe('MONTI persona harness (admin + 9 users)', () => {
  test.afterAll(async () => {
    for (const s of sessions.values()) await closePersona(s).catch(() => undefined);
    sessions.clear();
  });

  test('a: admin signs up and publishes events (free 선착순, approval flagged) — one write each', async ({ browser }) => {
    const admin = await ensureSession(browser, ADMIN);

    // v2: draft → 공개 is ONE publishEvent, and the event is Published on chain when it returns.
    const free = await createDraftAndPublish(admin.page, {
      personaId: ADMIN.id,
      orgName: 'Monti Crew',
      title: FREE_TITLE,
      intro: 'A free first-come event made by the E2E run. Anyone can get a ticket right away.',
      venue: 'Test Hall, Seongsu, Seoul',
      tiers: [{ kind: 'Free', mode: 'first-come', name: 'General', supply: 100 }],
    });
    expect(free.eventId).toBeTruthy();
    recordEvent('free', { id: free.eventId, published: true, title: FREE_TITLE });
    markPublished('free', true);

    // Approval-required event — only when the flag AND the build allow it.
    if (APPROVAL) {
      const appr = await createDraftAndPublish(admin.page, {
        personaId: ADMIN.id,
        orgName: 'Monti Crew',
        title: APPROVAL_TITLE,
        intro: 'An approval-only event made by the E2E run. Tickets are issued once a request is approved.',
        venue: 'Test Hall, Seongsu, Seoul',
        tiers: [{ kind: 'Free', mode: 'approval', name: 'General', supply: 100 }],
      });
      expect(appr.eventId).toBeTruthy();
      recordEvent('approval', { id: appr.eventId, published: true, title: APPROVAL_TITLE });
      markPublished('approval', true);
    }
    // Paid events (split rules + one publish) are covered end to end by 55.
  });

  test('b + c: users sign up (throttled to 3) and claim the free event', async ({ browser }) => {
    const free = getEvent('free');
    test.skip(!free, 'needs the free event from scenario a (scenario.json has no free event)');
    const freeId = free!.id;

    const users = await ensureUsers(browser, USER_COUNT);
    expect(users.length).toBe(USER_COUNT);

    for (const session of users) {
      const outcome = await claimFree(session.page, session.persona.id, freeId);
      recordClaim({ personaId: session.persona.id, eventId: freeId, outcome, at: now() });
      expect(['claimed', 'confirming'], `${session.persona.id} claim outcome`).toContain(outcome);
    }
    // The ticket shows in 내 티켓 with its TicketArt (art label carries the event title).
    for (const session of users) {
      expect(await hasTicketFor(session.page, FREE_TITLE), `${session.persona.id} ticket visible`).toBe(true);
      const count = await myTickets(session.page, session.persona.id);
      const prior = getClaim(session.persona.id, freeId);
      recordClaim({ personaId: session.persona.id, eventId: freeId, outcome: prior?.outcome ?? 'claimed', ticketCount: count, at: now() });
      expect(count).toBeGreaterThanOrEqual(1);
    }
  });

  test('e: claiming the same event twice hits the per-person limit copy', async ({ browser }) => {
    const free = getEvent('free');
    test.skip(!free, 'needs the free event from scenario a');
    const priorClaim = getClaim(USERS[0]!.id, free!.id);
    test.skip(
      !priorClaim || (priorClaim.outcome !== 'claimed' && priorClaim.outcome !== 'confirming'),
      'needs a prior successful claim on the free event (scenario b+c did not run to completion)',
    );

    const [session] = await ensureUsers(browser, 1);
    const outcome = await claimFree(session!.page, session!.persona.id, free!.id);
    recordClaim({ personaId: session!.persona.id, eventId: free!.id, outcome, at: now() });
    expect(outcome).toBe('limit');
  });

  test('d: approval flow — reuse pending, add fresh requests, approve 선택 + 전체, users see 승인됨', async ({ browser }) => {
    test.skip(!APPROVAL, 'approval UI (신청 관리) + VITE_APPROVAL_MODES require E2E_APPROVAL=1 and the approval build');
    const appr = getEvent('approval');
    test.skip(!appr, 'needs the approval event (scenario.json has no approval event — run scenario a with E2E_APPROVAL=1)');
    const apprId = appr!.id;

    // Budget-aware reuse (LIVE RUN 6): Event 7 already carries on-chain Pending ClaimRequests from an
    // earlier run (personas 02–05). We do NOT re-request from all nine — that would mint redundant
    // request ops. `EXISTING_REQUESTERS` are the personas already Pending (USERS[0..existing-1]);
    // `NEW_REQUESTS` submits fresh requests from the personas after them (USERS[existing..]) to prove
    // the Batch-2 request→대기 re-poll works from a cold start — the exact step that FAILED in run 5.
    const existing = Number(process.env.E2E_EXISTING_REQUESTERS ?? 4);
    const fresh = Number(process.env.E2E_NEW_REQUESTS ?? 0);
    const selected = Number(process.env.E2E_APPROVE_SELECTED ?? 2);

    const admin = await ensureSession(browser, ADMIN);

    // Fresh requests first: each must surface as 대기(pending)/확인 중 on its own (re-poll from scratch).
    for (let i = existing; i < existing + fresh && i < USERS.length; i++) {
      const persona = USERS[i]!;
      const session = await ensureSession(browser, persona);
      const r = await requestApproval(session.page, persona.id, apprId);
      recordClaim({ personaId: persona.id, eventId: apprId, outcome: `request:${r}`, at: now() });
      expect(['pending', 'confirming'], `${persona.id} request`).toContain(r);
    }

    // Approve a subset (선택 승인), then everyone still waiting (전체 승인).
    await approveSelected(admin.page, apprId, selected);
    await approveAll(admin.page, apprId);

    // Every requester — the reused Pending set plus any fresh ones — should now be approved. The
    // DURABLE success signal is the minted ticket in 내 티켓: once an approval mints and the indexer
    // reflects it, ClaimFlow's /claim screen no longer renders the transient 승인 alert (useMyRequest
    // stops returning a live Pending row and the claim screen falls back to its base state), so a
    // fresh reload that only looks for 승인됐어요 misses it (LIVE RUN 6 finding). Prefer the ticket,
    // fall back to the alert for the brief pre-mint window.
    const verifyCount = Math.min(existing + fresh, USERS.length);
    const verifiers = await ensureUsers(browser, verifyCount);
    for (const session of verifiers) {
      const ok = (await hasTicketFor(session.page, APPROVAL_TITLE)) || (await seesApproved(session.page, apprId));
      recordClaim({ personaId: session.persona.id, eventId: apprId, outcome: ok ? 'approved' : 'not-approved', at: now() });
      expect(ok, `${session.persona.id} holds the approved ticket or sees 승인`).toBe(true);
    }
  });

  test('f: sold-out — a limited-seat event with more claimers than seats, the last see 마감 copy', async ({ browser }) => {
    // Self-provisioning: f always mints its own fresh limited-seat event, so it does not depend on any
    // earlier scenario and a re-run after a worker restart never reuses a partly-claimed event. Seat
    // count and claimer count are tunable (SOLDOUT_SUPPLY / USER_COUNT) for a budget-limited run.
    const admin = await ensureSession(browser, ADMIN);
    const soldOut = await createDraftAndPublish(admin.page, {
      personaId: ADMIN.id,
      orgName: 'Monti Crew',
      title: SOLDOUT_TITLE,
      intro: `A ${SOLDOUT_SUPPLY}-seat event made by the E2E run. It sells out after ${SOLDOUT_SUPPLY} people.`,
      venue: 'Test Hall, Seongsu, Seoul',
      tiers: [{ kind: 'Free', mode: 'first-come', name: 'General', supply: SOLDOUT_SUPPLY }],
    });
    expect(soldOut.eventId).toBeTruthy();
    const soldOutId = soldOut.eventId;
    recordEvent('soldOut', { id: soldOutId, published: true, title: SOLDOUT_TITLE });
    markPublished('soldOut', true);

    const users = await ensureUsers(browser, USER_COUNT);
    // Sequential, with a beat between each, so the indexer's minted count can catch up and the
    // 마감 copy (which reads supply−minted off the indexer) is the honest result for late claimers.
    const outcomes: string[] = [];
    for (const session of users) {
      const outcome = await claimFree(session.page, session.persona.id, soldOutId);
      recordClaim({ personaId: session.persona.id, eventId: soldOutId, outcome, at: now() });
      outcomes.push(outcome);
      await session.page.waitForTimeout(2500);
    }
    const got = outcomes.filter((o) => o === 'claimed' || o === 'confirming').length;
    const blocked = outcomes.filter((o) => o === 'soldout' || o === 'failed').length;
    // At most SOLDOUT_SUPPLY (+1 for an indexer-lagged in-flight mint) could really be minted; the
    // claimers beyond the seat count must be turned away, and at least one late one must read 마감.
    expect(got).toBeLessThanOrEqual(SOLDOUT_SUPPLY + 1);
    expect(blocked).toBeGreaterThan(0);
    expect(outcomes.slice(SOLDOUT_SUPPLY).some((o) => o === 'soldout')).toBe(true);
  });
});
