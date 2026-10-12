import { expect, test, type Response } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ADMIN } from '../fixtures/personas';
import { closePersona, ensureAccount, openPersona } from '../utils/session';
import { admitByOverride, approveGate, fileGateRequest, startConsole } from '../utils/gates';
import { fmtMon, gateOf, monBalance, RELAYER } from '../utils/chain';

/**
 * v2 step 3 as a SALVAGE/resume spec: admit an already-purchased (escrow HELD) ticket on an existing
 * published event, reusing the organiser session for both the organiser and the staff device. The
 * gate may already be registered from an earlier attempt — then registration is skipped and the
 * chain's answer is used. v2 opens a gate on registration, so there is no 열기 step and no indexer
 * interception any more. Takes EVENT_ID + TOKEN_ID.
 */

const ARTIFACTS = 'e2e/.artifacts';
const DIAG_PATH = `${ARTIFACTS}/57-admission-diag.json`;
const EVENT_ID = process.env.EVENT_ID ?? '';
const TOKEN_ID = process.env.TOKEN_ID ?? '';
const PIN = '2468';

test('57 · v2 admission (salvage) — organiser admits a HELD ticket, one process', async ({ browser }) => {
  test.setTimeout(12 * 60 * 1000);
  expect(EVENT_ID, 'EVENT_ID').not.toBe('');
  expect(TOKEN_ID, 'TOKEN_ID').not.toBe('');
  mkdirSync(ARTIFACTS, { recursive: true });
  const diag: Record<string, unknown> = { admin: ADMIN.id, eventId: EVENT_ID, tokenId: TOKEN_ID, startedAt: new Date().toISOString() };
  const admin = await openPersona(browser, ADMIN);
  const relayKinds: string[] = [];
  admin.page.on('response', (response: Response) => {
    try {
      const req = response.request();
      if (req.method() !== 'POST' || !response.url().toLowerCase().includes('relayaction')) return;
      const body = JSON.parse(req.postData() ?? '') as { data?: { kind?: string } };
      relayKinds.push(body.data?.kind ?? 'unknown');
    } catch { /* capture never throws */ }
  });

  try {
    const page = admin.page;
    await ensureAccount(admin);
    const gateAccount = await fileGateRequest(page, EVENT_ID);
    diag.gateAccount = gateAccount;
    diag.preGateId = (await gateOf(gateAccount)).toString();
    const gate = await approveGate(page, EVENT_ID, gateAccount);
    diag.gateId = gate.gateId.toString();
    diag.gateOpenOnRegister = gate.openOnRegister;
    diag.gateOpenedSeparately = gate.openedSeparately;
    console.log(`[57] gate=${gate.gateId} openOnRegister=${gate.openOnRegister}`);

    await startConsole(page, PIN);
    const before = await monBalance(RELAYER);
    const outcome = await admitByOverride(page, TOKEN_ID, PIN);
    const after = await monBalance(RELAYER);
    diag.override = { result: outcome.result, lastDetail: outcome.lastDetail, latencyMs: outcome.latencyMs };
    diag.relayKinds = relayKinds;
    diag.costOverride = fmtMon(before - after);
    console.log(`[57] override=${outcome.result} cost=${diag.costOverride} MON`);
    await page.screenshot({ path: `${ARTIFACTS}/57-override.png`, fullPage: true }).catch(() => undefined);
    expect(outcome.result, `manual override lands on 들여보냈어요 (lastDetail=${outcome.lastDetail})`).toBe('approved');
  } finally {
    diag.finishedAt = new Date().toISOString();
    writeFileSync(DIAG_PATH, JSON.stringify(diag, null, 2));
    console.log(`[57] diag written: ${DIAG_PATH}`);
    await closePersona(admin).catch(() => undefined);
  }
});
