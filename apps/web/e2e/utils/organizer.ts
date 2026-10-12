import { expect, type Locator, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { timed } from '../fixtures/timings';
import { eventStatus, pollUntil, TICKET_ADDRESS } from './chain';
import { shot } from './shots';

const HERE = dirname(fileURLToPath(import.meta.url));
export const POSTER = resolve(HERE, '../assets/poster.jpg');

/**
 * Copy strings, verbatim from apps/web/src/organizer/copy.ts (scene, scene.publishScreen,
 * settlement). v2 flow (design §5): 만들기 → 다음 (draft only, no chain) → 공개 screen (split rules
 * for a paid event, saved in the draft) → 공개하기 → confirm sheet → ONE publishEvent write.
 */
const C = {
  sceneTitle: 'Create an event',
  posterAdd: 'Add a poster',
  posterChange: 'Change the poster',
  crop: 'Use this photo',
  resumeKeep: 'Carry on',
  quickStart: 'Quick start',
  quickFree: 'Free, first come',
  quickApproval: 'Free, organizer approves',
  quickPaid: 'Paid, general admission',
  title: 'Title',
  intro: 'About this event',
  startsAt: 'Starts',
  venue: 'Where',
  tierName: 'Ticket type (e.g. General, VIP)',
  supply: 'Quantity',
  amount: 'Amount',
  next: 'Next',
  // publish screen
  publishTitle: 'Publish',
  publish: 'Publish',
  confirm: 'Yes, publish it',
  confirmHeading: 'Publish it as it is?',
  splitIntro: 'Decide who gets how much of each ticket sale',
  addRow: 'Add recipient',
  orgName: 'Organizer name',
  checkLater: 'Check later',
} as const;

export interface TierSpec {
  kind: 'Free' | 'Paid';
  /** Free tiers only: 선착순 (auto) or 관리자 승인 (approval, flag-gated). */
  mode?: 'first-come' | 'approval';
  name?: string;
  supply?: number;
  /** Paid only: whole US dollars (the chain stores amount × 100 as `priceUsdCents`). */
  price?: number;
}

/** One split row besides the locked MONTI 5% row. The rows plus 5% must make 100%. */
export interface SplitRecipient {
  role: string;
  pct: string;
  tag: string;
  addr: string;
}

export interface EventSpec {
  personaId: string;
  orgName: string;
  title: string;
  intro: string;
  venue: string;
  tiers: TierSpec[];
  /** Required when a tier is paid; ignored for a free event. */
  split?: SplitRecipient[];
}

export interface PublishResult {
  eventId: string;
  /** 네, 공개할게요 → the done screen, in ms (the one publish write, as the organiser waits it). */
  publishMs: number;
}

/**
 * A field's control (input/textarea/select), located structurally by its wrapping
 * `<label class="field">` and the exact label text (Field.tsx). The scene re-renders while the
 * poster uploads behind it, which churns accessible-name resolution; a structural locator always
 * resolves, and `.fill(v, { force: true })` at the call site skips the stability gate.
 */
function fieldInput(scope: Page | Locator, label: string): Locator {
  return scope.locator('label.field', { hasText: label }).locator('input, textarea, select').first();
}

/** A YYYY-MM-DDTHH:00 string in Asia/Seoul, `days` from now — safely in the future. */
function futureLocal(days: number, hour: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  const date = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
  return `${date}T${String(hour).padStart(2, '0')}:00`;
}

/** A DOM click — the sticky bar and the motion sheets are often "not stable" for a pointer click. */
async function press(locator: Locator): Promise<void> {
  await locator.evaluate((el) => (el as HTMLButtonElement).click());
}

/**
 * The whole v2 organiser flow as a person does it, ending on a Published event:
 *
 *   1. /org/new — poster (optional), title/intro/time/place, the first ticket kind (and its price
 *      when paid), 다음. Nothing touches the chain here; the draft is saved.
 *   2. /org/new/<draftId>/publish — for a paid event the split rules (rows + the locked MONTI 5%),
 *      the organiser name when this person has none, 공개하기 → 네, 공개할게요.
 *   3. the one relayed `publishEvent` → /org/new/done/<eventId>, then `eventStatus == 1` on chain.
 */
export async function createDraftAndPublish(page: Page, spec: EventSpec): Promise<PublishResult> {
  return timed(spec.personaId, 'create-and-publish', async () => {
    await gotoCreate(page);
    await page.waitForTimeout(1000);
    await shot(page, 'org-create-form-empty');

    // A prior draft puts the scene `inert` behind the resume sheet; answer it before anything.
    const resumeKeep = page.getByRole('button', { name: C.resumeKeep, exact: true });
    if (await resumeKeep.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false)) {
      await press(resumeKeep).catch(() => undefined);
      await resumeKeep.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => undefined);
    }

    // The poster is optional (a default A4 one is generated at publish). E2E_UPLOAD_POSTER=1 drives
    // the full picker/crop flow instead.
    if (process.env.E2E_UPLOAD_POSTER === '1') {
      await page.getByRole('button', { name: C.posterAdd, exact: true })
        .or(page.getByRole('button', { name: C.posterChange, exact: true }))
        .first()
        .evaluate((el) => (el as HTMLButtonElement).click());
      await page.locator('dialog.poster-modal input[type="file"]').setInputFiles(POSTER);
      const crop = page.getByRole('button', { name: C.crop, exact: true });
      await crop.waitFor({ state: 'attached', timeout: 15_000 });
      await press(crop);
      await expect(page.getByRole('button', { name: C.posterChange, exact: true })).toBeVisible({ timeout: 30_000 });
    }

    await fieldInput(page, C.title).fill(spec.title, { force: true });
    await fieldInput(page, C.intro).fill(spec.intro, { force: true }).catch(() => undefined);
    await fieldInput(page, C.startsAt).fill(futureLocal(2, 12), { force: true });
    await fieldInput(page, C.venue).fill(spec.venue, { force: true });

    const t0 = spec.tiers[0]!;
    const quick = page.getByRole('group', { name: C.quickStart });
    if (t0.kind === 'Paid') {
      await press(quick.getByRole('button', { name: C.quickPaid, exact: true }));
    } else if (t0.mode === 'approval') {
      const chip = quick.getByRole('button', { name: C.quickApproval, exact: true });
      if (!(await chip.isEnabled())) {
        throw new Error('APPROVAL_MODE_DISABLED: VITE_APPROVAL_MODES is off in this build');
      }
      await press(chip);
    } else {
      await press(quick.getByRole('button', { name: C.quickFree, exact: true }));
    }
    const card = page.locator('.tier-card').first();
    if (t0.name) await fieldInput(card, C.tierName).fill(t0.name, { force: true });
    if (t0.supply !== undefined) await fieldInput(card, C.supply).fill(String(t0.supply), { force: true });
    if (t0.kind === 'Paid') await fieldInput(card, C.amount).fill(String(t0.price ?? 30), { force: true });

    await shot(page, 'org-create-form-filled');
    const next = page.getByRole('button', { name: C.next, exact: true });
    await expect(next).toBeEnabled({ timeout: 30_000 });
    await press(next);
    const publishRe = /\/org\/new\/([^/]+)\/publish/;
    await expect(page).toHaveURL(publishRe, { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: C.publishTitle, level: 1 })).toBeVisible({ timeout: 30_000 });
    await shot(page, 'org-publish-screen');

    if (spec.tiers.some((tier) => tier.kind === 'Paid')) await fillSplit(page, spec.split ?? []);

    const org = fieldInput(page, C.orgName);
    if (await org.isVisible().catch(() => false)) await org.fill(spec.orgName, { force: true });

    const publishBtn = page.getByRole('button', { name: C.publish, exact: true }).last();
    await expect(publishBtn).toBeEnabled({ timeout: 30_000 });
    await press(publishBtn);
    const sheet = page.getByRole('dialog', { name: C.confirmHeading });
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(600);
    await shot(page, 'org-publish-confirm-sheet');
    const publishAt = Date.now();
    await press(sheet.getByRole('button', { name: C.confirm, exact: true }));
    await page.waitForTimeout(1200);
    await shot(page, 'org-publish-sending');

    const doneRe = /\/org\/new\/done\/(\d+)/;
    const later = page.getByRole('button', { name: C.checkLater, exact: true });
    const deadline = Date.now() + 6 * 60 * 1000;
    while (Date.now() < deadline && !doneRe.test(page.url())) {
      // The determinate wait times out into 다시 시도/나중에 확인 while the relay is still out:
      // pressing 공개하기 again follows the same relay (never a second publish, no sheet).
      if (await later.isVisible().catch(() => false)) {
        await page.waitForTimeout(10_000);
        await press(publishBtn).catch(() => undefined);
      }
      await page.waitForTimeout(2000);
    }
    await expect(page).toHaveURL(doneRe, { timeout: 90_000 });
    const publishMs = Date.now() - publishAt;
    const eventId = page.url().match(doneRe)?.[1] ?? '';
    await page.waitForTimeout(1500);
    await shot(page, 'org-publish-done');

    await assertPublished(eventId);
    return { eventId, publishMs };
  });
}

/**
 * The split rows on the publish screen: one 수령인 추가 per recipient, then name · % · tag and the
 * account under 수령 계정 정하기. Row 0 is the locked MONTI row (5%). The editor writes the draft's
 * `splitJson` on every change, and 공개하기 enables only once the sum is 100%.
 */
async function fillSplit(page: Page, recipients: SplitRecipient[]): Promise<void> {
  await expect(page.getByText(C.splitIntro, { exact: false })).toBeVisible({ timeout: 30_000 });
  const rows = page.locator('li.split-row');
  await expect(rows.first()).toBeVisible({ timeout: 30_000 });
  const addRow = page.getByRole('button', { name: C.addRow, exact: true });
  for (let i = 0; i < recipients.length; i++) {
    await press(addRow);
    await page.waitForTimeout(250);
  }
  for (let i = 0; i < recipients.length; i++) {
    const row = rows.nth(i + 1);
    const r = recipients[i]!;
    await row.locator('input').nth(0).fill(r.role, { force: true });
    await row.locator('input').nth(1).fill(r.pct, { force: true });
    await row.locator('input').nth(2).fill(r.tag, { force: true });
    const summary = row.locator('details.more summary');
    if (await summary.isVisible().catch(() => false)) await summary.click().catch(() => undefined);
    await row.locator('details.more input').first().fill(r.addr, { force: true });
  }
  await page.waitForTimeout(600);
  await shot(page, 'org-publish-split-filled');
}

/**
 * Truth is on chain, never the UI: v2 creates the event Published in the one write, so
 * `Ticket.eventStatus(eventId)` must read 1 shortly after the done screen.
 */
export async function assertPublished(eventId: string): Promise<void> {
  const status = await pollUntil(async () => ((await eventStatus(eventId).catch(() => -1)) === 1 ? 1 : 0), 90_000, 3000);
  if (status !== 1) {
    throw new Error(`event ${eventId} is not Published on Ticket ${TICKET_ADDRESS} 90s after the done screen`);
  }
}

/**
 * Open the creation scene. `RequireSession` shows a spinner while the Firebase session rehydrates
 * and redirects to `/login` only when truly anonymous, so the scene heading is the signal.
 */
async function gotoCreate(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    await page.goto('/org/new');
    await page.waitForTimeout(1500);
    if (
      /\/org\/new/.test(page.url()) &&
      (await page.getByRole('heading', { name: C.sceneTitle }).isVisible({ timeout: 8000 }).catch(() => false))
    ) {
      return;
    }
    await page.waitForTimeout(2000);
  }
  throw new Error('could not open /org/new — persona not signed in');
}
