import { expect, test, type Response } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ADMIN, ALL_PERSONAS } from '../fixtures/personas';
import { closePersona, ensureAccount, openPersona } from '../utils/session';
import { admitByOverride, approveGate, fileGateRequest, startConsole } from '../utils/gates';
import { fmtMon, monBalance, RELAYER } from '../utils/chain';

/**
 * v2 step 3 (admission), resumable: admit an attendee's HELD ticket on an existing published event.
 *
 *   A. /staff/setup — file a pending gate for the event (submitPendingGate).
 *   B. /org/events/<id>/gates — 등록 = ONE `registerGate`, which opens the gate (design D3; no 열기).
 *   C. /staff/setup — registered+open on chain; set the PIN; open the console.
 *   D. /staff/gate — 수동 승인하기 → tokenId → PIN → 수동 승인.
 *
 * Who presses 수동 승인 decides the path (design D5):
 *   - default: ADMIN, the org owner → approver → ONE relayed `manualOverride` → 들여보냈어요.
 *   - `E2E_OVERRIDE_PERSONA=<id|index>`: a persona that is already a manager WITHOUT approval on this
 *     org runs C–D → the `requestOverride` callable files an off-chain request (no chain write) →
 *     요청됨 — 승인 대기. The approver then sees it in the console's request list.
 *
 * Takes EVENT_ID + TOKEN_ID (from 55 or 52). usedAt/release are verified on chain afterwards.
 */

const ARTIFACTS = 'e2e/.artifacts';
const DIAG_PATH = `${ARTIFACTS}/53-admission-diag.json`;
const EVENT_ID = process.env.EVENT_ID ?? '';
const TOKEN_ID = process.env.TOKEN_ID ?? '';
const PIN = '2468';
const REQUESTER = process.env.E2E_OVERRIDE_PERSONA ?? '';

function personaFor(raw: string) {
  const wanted = raw.replace(/^persona-/, '').padStart(2, '0');
  const found = ALL_PERSONAS.find((p) => p.id === raw || p.id === `persona-${wanted}`);
  if (!found) throw new Error(`E2E_OVERRIDE_PERSONA=${raw} is not one of ${ALL_PERSONAS.map((p) => p.id).join(', ')}`);
  return found;
}

test('53 · v2 admission — gate opens on approve, then manual override (or an off-chain request)', async ({ browser }) => {
  test.setTimeout(10 * 60 * 1000);
  expect(EVENT_ID, 'EVENT_ID env must be the event id').not.toBe('');
  expect(TOKEN_ID, 'TOKEN_ID env must be the HELD ticket').not.toBe('');
  mkdirSync(ARTIFACTS, { recursive: true });
  const diag: Record<string, unknown> = {
    organizer: ADMIN.id, requester: REQUESTER || null, eventId: EVENT_ID, tokenId: TOKEN_ID,
    startedAt: new Date().toISOString(),
  };

  const admin = await openPersona(browser, ADMIN);
  const staff = REQUESTER ? await openPersona(browser, personaFor(REQUESTER)) : admin;
  const relayKinds: string[] = [];
  for (const session of new Set([admin, staff])) {
    session.page.on('response', (response: Response) => {
      try {
        const req = response.request();
        if (req.method() !== 'POST' || !response.url().toLowerCase().includes('relayaction')) return;
        const body = JSON.parse(req.postData() ?? '') as { data?: { kind?: string } };
        relayKinds.push(body.data?.kind ?? 'unknown');
      } catch { /* capture never throws */ }
    });
  }

  try {
    await ensureAccount(admin);
    if (staff !== admin) await ensureAccount(staff);

    // A — the staff device files; B — the organiser approves (opens on register).
    const gateAccount = await fileGateRequest(staff.page, EVENT_ID);
    diag.gateAccount = gateAccount;
    const gate = await approveGate(admin.page, EVENT_ID, gateAccount);
    diag.gateId = gate.gateId.toString();
    diag.registerLatencyMs = gate.registerMs;
    diag.gateOpenOnRegister = gate.openOnRegister;
    diag.gateOpenedSeparately = gate.openedSeparately;
    console.log(`[53] gate=${gate.gateId} openOnRegister=${gate.openOnRegister}`);

    // C–D on the staff device.
    await startConsole(staff.page, PIN);
    const before = await monBalance(RELAYER);
    const outcome = await admitByOverride(staff.page, TOKEN_ID, PIN);
    const after = await monBalance(RELAYER);
    diag.override = { result: outcome.result, lastDetail: outcome.lastDetail, latencyMs: outcome.latencyMs };
    diag.requestCalls = outcome.requestCalls;
    diag.relayKinds = relayKinds;
    diag.costOverride = fmtMon(before - after);
    console.log(`[53] override=${outcome.result} in ${outcome.latencyMs}ms relayKinds=${relayKinds.join(',')}`);

    if (REQUESTER) {
      expect(outcome.result, `a manager without approval files a request (lastDetail=${outcome.lastDetail})`).toBe('requested');
      expect(outcome.requestCalls.length, 'requestOverride callable was called').toBeGreaterThan(0);
      expect(relayKinds, 'a request is not a chain write').not.toContain('requestOverride');
    } else {
      expect(outcome.result, `manual override lands on 들여보냈어요 (lastDetail=${outcome.lastDetail})`).toBe('approved');
      expect(relayKinds.filter((kind) => kind === 'manualOverride'), 'exactly one manualOverride').toHaveLength(1);
    }
    await staff.page.screenshot({ path: `${ARTIFACTS}/53-override-final.png`, fullPage: true }).catch(() => undefined);
  } finally {
    diag.finishedAt = new Date().toISOString();
    writeFileSync(DIAG_PATH, JSON.stringify(diag, null, 2));
    console.log(`[53] diag written: ${DIAG_PATH}`);
    if (staff !== admin) await closePersona(staff).catch(() => undefined);
    await closePersona(admin).catch(() => undefined);
  }
});
