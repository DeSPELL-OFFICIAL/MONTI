import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createPublicClient, http } from 'viem';
import { ADMIN } from '../fixtures/personas';
import { closePersona, ensureAccount, openPersona } from '../utils/session';
import { createOrganizerAndEvent, publishEvent } from '../utils/organizer';
import { recordEvent } from '../utils/scenario-state';

/**
 * Per-op relayer cost is read straight off the relayer EOA's balance via RPC (every write is
 * relayer-sponsored; see e2e/README.md). The harness logs the balance at each on-chain phase so the
 * operator gets setPolicy/createEvent/publish deltas without pausing the single-command run.
 */
const RELAYER = '0xFA93A9dB40a4396a8CdcF63991FA8615d1A35fFd' as const;
const BAL_RPC = process.env.E2E_RPC_URL ?? 'https://testnet-rpc.monad.xyz';
const balClient = createPublicClient({ transport: http(BAL_RPC) });
const relayerMon = (): Promise<bigint> => balClient.getBalance({ address: RELAYER });
const fmtMon = (wei: bigint): string => (Number(wei) / 1e18).toFixed(9);

/**
 * Batch H — programmable-settlement demo, step 1 (정산 규칙 확정) live against production.
 *
 * The "paid" event is modelled as a FREE on-chain event plus a settlement overlay: the price and
 * the revenue split live in `settlements/{eventId}` and are enforced by the `purchaseTicket`
 * callable; the organiser configures them in the dashboard's 정산 설정 section (SettlementSection).
 * Reaching a confirmed policy is the precondition for every downstream step (purchase, admission,
 * release, refund), so this spec drives that section and records exactly what the UI does.
 *
 * Runs fresh in-process in ONE command (Blocker B /recover guard forbids cross-command reuse).
 */

const ARTIFACTS = 'e2e/.artifacts';
const DIAG_PATH = `${ARTIFACTS}/50-settlement-diag.json`;

/** Three valid-format recipient test addresses for the non-platform split rows. */
const RECIPIENTS = [
  { role: '아티스트', pct: '60', tag: 'artist', addr: '0x1111111111111111111111111111111111111111' },
  { role: '공연장', pct: '20', tag: 'venue', addr: '0x2222222222222222222222222222222222222222' },
  { role: '기획', pct: '15', tag: 'planning', addr: '0x3333333333333333333333333333333333333333' },
];

test('50 · settlement step 1 — organiser confirms the $30 split policy', async ({ browser }) => {
  test.setTimeout(10 * 60 * 1000);
  mkdirSync(ARTIFACTS, { recursive: true });
  const diag: Record<string, unknown> = { persona: ADMIN.id, startedAt: new Date().toISOString() };

  const admin = await openPersona(browser, ADMIN);
  try {
    // 1a. Fresh admin signup (personas were reset clean).
    await ensureAccount(admin);
    const page = admin.page;

    // 1b. Create the event that will carry the settlement overlay. Paid tiers are still blocked at
    // the create scene, so the on-chain event is a free tier; the "$30" lives entirely in the
    // settlement policy configured below.
    const balStart = await relayerMon().catch(() => 0n);
    (diag as Record<string, string>).relayerMonStart = fmtMon(balStart);
    console.log(`[50] relayer MON (before create): ${fmtMon(balStart)}`);
    const created = await createOrganizerAndEvent(page, {
      personaId: ADMIN.id,
      orgName: '몬티 정산 테스트',
      title: '정산 데모 공연 H',
      intro: '프로그래머블 정산 데모 행사입니다.',
      venue: '서울 테스트홀',
      tiers: [{ kind: '무료', mode: '선착순', name: '일반', supply: 50 }],
    });
    diag.eventId = created.eventId;
    diag.createBlocked = created.blocked;
    console.log(`[50] event created: id=${created.eventId} blocked=${created.blocked}`);
    expect(created.eventId, 'event should be created').not.toBeNull();
    const eventId = created.eventId!;
    recordEvent('free', { id: eventId, published: false, title: '정산 데모 공연 H' });
    const balAfterCreate = await relayerMon().catch(() => 0n);
    (diag as Record<string, string>).relayerMonAfterCreate = fmtMon(balAfterCreate);
    (diag as Record<string, string>).costCreate = fmtMon(balStart - balAfterCreate);
    console.log(`[50] relayer MON (after create): ${fmtMon(balAfterCreate)} · createEvent=${fmtMon(balStart - balAfterCreate)}`);

    // 1c. Open the organiser dashboard and wait for the 정산 설정 section + its price field (which
    // only renders once the indexer has surfaced the event's tier).
    const card = page.locator('section.card', { has: page.getByRole('heading', { name: '정산 설정', exact: true }) });
    const priceInput = page.locator('input[placeholder="30"]');
    let sectionReady = false;
    // Run 4: widened from 120s. The price field only renders once the indexer surfaces the
    // just-created event's tier, and cross-command session reuse fails (passkey session does not
    // hold) — so create → 정산 설정 → 확정 → publish must all land in THIS one session; give the
    // indexer up to 5 min to catch up rather than splitting into a second command.
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      await page.goto(`/org/events/${eventId}`);
      await page.waitForTimeout(2500);
      if (await page.getByRole('heading', { name: '정산 설정', exact: true }).isVisible().catch(() => false)) {
        if (await priceInput.first().isVisible().catch(() => false)) { sectionReady = true; break; }
      }
      await page.waitForTimeout(3000);
    }
    diag.settlementSectionVisible = await page
      .getByRole('heading', { name: '정산 설정', exact: true })
      .isVisible()
      .catch(() => false);
    diag.priceFieldVisible = sectionReady;
    console.log(`[50] 정산 설정 visible=${diag.settlementSectionVisible} priceField=${sectionReady}`);

    if (sectionReady) {
      // 1d. Fill the $30 ticket price.
      await priceInput.first().fill('30').catch((e) => console.log(`[50] price fill failed: ${e}`));

      // 1e. Add the three non-platform recipient rows (the MONTI 5% platform row is pre-seeded).
      const addRow = page.getByRole('button', { name: '수령인 추가', exact: true });
      for (let i = 0; i < RECIPIENTS.length; i++) {
        await addRow.click().catch(() => undefined);
        await page.waitForTimeout(300);
      }
      const rows = page.locator('li.split-row');
      diag.rowCount = await rows.count().catch(() => -1);

      // Row 0 is the locked MONTI platform row; fill rows 1..n with the recipients.
      for (let i = 0; i < RECIPIENTS.length; i++) {
        const row = rows.nth(i + 1);
        const r = RECIPIENTS[i]!;
        try {
          await row.locator('input').nth(0).fill(r.role, { force: true }); // 역할/이름
          await row.locator('input').nth(1).fill(r.pct, { force: true }); // 비율 %
          await row.locator('input').nth(2).fill(r.tag, { force: true }); // 태그
          const summary = row.locator('details.more summary');
          if (await summary.isVisible().catch(() => false)) await summary.click().catch(() => undefined);
          await row.locator('details.more input').first().fill(r.addr, { force: true }); // 수령 계정
        } catch (e) {
          console.log(`[50] recipient row ${i} fill issue: ${e}`);
        }
      }

      // 1f. Observe the result: the sum, the platform row's rendered content, the confirm button,
      // and whatever validation message the editor shows.
      const confirmBtn = page.getByRole('button', { name: '정산 규칙 확정', exact: true });
      await page.waitForTimeout(800);
      diag.sumText = (await card.locator('.settlement-sum').first().innerText().catch(() => '')) || '';
      diag.confirmVisible = await confirmBtn.isVisible().catch(() => false);
      diag.confirmDisabled = await confirmBtn.isDisabled().catch(() => null);
      diag.platformRowText = (await rows.nth(0).innerText().catch(() => '')) || '';
      diag.platformRowHasAccountInput = (await rows.nth(0).locator('input').count().catch(() => 0));
      diag.alertText = (await card.locator('.alert, [role="alert"]').allInnerTexts().catch(() => [])).join(' | ');
      console.log(`[50] sum=${JSON.stringify(diag.sumText)} confirmDisabled=${diag.confirmDisabled} alert=${JSON.stringify(diag.alertText)}`);
      console.log(`[50] platformRow inputs=${diag.platformRowHasAccountInput} text=${JSON.stringify(diag.platformRowText)}`);

      // Capture the editor state (sum/rows/alert) before acting, so the artifact exists regardless.
      await page.screenshot({ path: `${ARTIFACTS}/50-settlement-section.png`, fullPage: true }).catch(() => undefined);

      // 1g. With VITE_ADDR_PLATFORM configured, the locked MONTI row seeds with a valid account, so
      // 정산 규칙 확정 must now be ENABLED. Press it → device signs → relaySetPolicy → the relay doc is
      // followed until the policy confirms (phase 'done' swaps the editor for the 정산 규칙 확정됨 alert
      // and the 정산 내역 보기 link).
      expect(diag.confirmDisabled, '정산 규칙 확정 must be enabled once VITE_ADDR_PLATFORM is set').toBe(false);
      await confirmBtn.click();
      const publicLink = card.getByRole('link', { name: '정산 내역 보기', exact: true });
      const confirmedChip = card.getByText('정산 규칙 확정됨', { exact: true });
      let policyConfirmed = false;
      const confirmDeadline = Date.now() + 100_000;
      while (Date.now() < confirmDeadline) {
        if (await publicLink.isVisible().catch(() => false)) { policyConfirmed = true; break; }
        if (await confirmedChip.isVisible().catch(() => false)) { policyConfirmed = true; break; }
        await page.waitForTimeout(3000);
      }
      diag.policyConfirmed = policyConfirmed;
      diag.afterConfirmAlert = (await card.locator('.alert, [role="alert"]').allInnerTexts().catch(() => [])).join(' | ');
      const balAfterPolicy = await relayerMon().catch(() => 0n);
      (diag as Record<string, string>).relayerMonAfterPolicy = fmtMon(balAfterPolicy);
      (diag as Record<string, string>).costSetPolicy = fmtMon(balAfterCreate - balAfterPolicy);
      console.log(`[50] policy confirmed=${policyConfirmed} · relaySetPolicy=${fmtMon(balAfterCreate - balAfterPolicy)} MON · alert=${JSON.stringify(diag.afterConfirmAlert)}`);
      await page.screenshot({ path: `${ARTIFACTS}/50-settlement-confirmed.png`, fullPage: true }).catch(() => undefined);
      expect(policyConfirmed, 'relaySetPolicy should confirm within 100s').toBe(true);

      // 1h. Publish the event so step 2's attendee purchase path exists.
      const publishResult = await publishEvent(page, ADMIN.id, eventId);
      diag.publishResult = publishResult;
      recordEvent('free', { id: eventId, published: publishResult === 'published', title: '정산 데모 공연 H' });
      const balAfterPublish = await relayerMon().catch(() => 0n);
      (diag as Record<string, string>).relayerMonAfterPublish = fmtMon(balAfterPublish);
      (diag as Record<string, string>).costPublish = fmtMon(balAfterPolicy - balAfterPublish);
      console.log(`[50] publish=${publishResult} · publish cost=${fmtMon(balAfterPolicy - balAfterPublish)} MON · relayer now ${fmtMon(balAfterPublish)}`);
    }
  } finally {
    diag.finishedAt = new Date().toISOString();
    writeFileSync(DIAG_PATH, JSON.stringify(diag, null, 2));
    console.log(`[50] diag written: ${DIAG_PATH}`);
    await closePersona(admin);
  }
});
