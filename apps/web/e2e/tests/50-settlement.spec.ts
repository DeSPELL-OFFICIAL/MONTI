import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ADMIN } from '../fixtures/personas';
import { closePersona, ensureAccount, openPersona } from '../utils/session';
import { createOrganizerAndEvent } from '../utils/organizer';
import { recordEvent } from '../utils/scenario-state';

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

    // 1c. Open the organiser dashboard and wait for the 정산 설정 section + its price field (which
    // only renders once the indexer has surfaced the event's tier).
    const card = page.locator('section.card', { has: page.getByRole('heading', { name: '정산 설정', exact: true }) });
    const priceInput = page.locator('input[placeholder="30"]');
    let sectionReady = false;
    const deadline = Date.now() + 120_000;
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

      // 1g. If the editor lets us, press 확정 and capture the outcome (confirmed vs error).
      if (diag.confirmDisabled === false) {
        await confirmBtn.click().catch(() => undefined);
        await page.waitForTimeout(8000);
        diag.afterConfirmAlert = (await card.locator('.alert, [role="alert"]').allInnerTexts().catch(() => [])).join(' | ');
        diag.afterConfirmUrl = page.url();
        console.log(`[50] after 확정: alert=${JSON.stringify(diag.afterConfirmAlert)}`);
      }
    }

    await page.screenshot({ path: `${ARTIFACTS}/50-settlement-section.png`, fullPage: true }).catch(() => undefined);
  } finally {
    diag.finishedAt = new Date().toISOString();
    writeFileSync(DIAG_PATH, JSON.stringify(diag, null, 2));
    console.log(`[50] diag written: ${DIAG_PATH}`);
    await closePersona(admin);
  }
});
