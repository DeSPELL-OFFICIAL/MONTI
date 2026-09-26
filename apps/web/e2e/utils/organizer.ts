import { expect, type Locator, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { timed } from '../fixtures/timings';

const HERE = dirname(fileURLToPath(import.meta.url));
export const POSTER = resolve(HERE, '../assets/poster.jpg');

/** Copy strings, verbatim from apps/web/src/organizer/copy.ts (scene) and ko.ts. */
const C = {
  fab: '만들기',
  posterAdd: '포스터 올리기',
  posterChange: '포스터 바꾸기',
  filePick: '사진 고르기',
  crop: '이 사진으로 정하기',
  resumeFresh: '새로 만들기',
  title: '제목',
  intro: '소개',
  startsAt: '시작',
  region: '지역',
  venue: '장소',
  more: '더 설정하기',
  tierName: '티켓 종류 (예: 일반, VIP)',
  supply: '수량',
  amount: '금액',
  perWallet: '1인당 한도',
  free: '무료',
  paid: '유료',
  receiveAuto: '선착순 자동 승인',
  receiveApproval: '관리자 승인 후 발급',
  addTier: '종류 추가',
  orgName: '주최자 이름',
  create: '행사 만들기',
  paidBlocked: '유료 티켓은 곧 열려요. 지금은 무료로만 만들 수 있어요',
  // publish (organizer dashboard)
  publish: '발행하기',
  publishConfirm: '네, 진행할게요',
  published: '발행했어요',
  publishConfirming: '아직 확인 중이에요',
} as const;

export interface TierSpec {
  kind: '무료' | '유료';
  /** Free tiers only: 선착순 (auto) or 관리자 승인 (approval, flag-gated). */
  mode?: '선착순' | '관리자 승인';
  name?: string;
  supply?: number;
  /** Paid only. */
  price?: number;
  limit?: number;
}

export interface EventSpec {
  personaId: string;
  orgName: string;
  title: string;
  intro: string;
  venue: string;
  tiers: TierSpec[];
}

export interface CreateResult {
  eventId: string | null;
  /** True when a paid tier held the create button disabled and the block copy was shown. */
  blocked: boolean;
}

/** A YYYY-MM-DDTHH:00 string in Asia/Seoul, `days` from now — safely in the future. */
function futureLocal(days: number, hour: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  const date = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
  return `${date}T${String(hour).padStart(2, '0')}:00`;
}

/**
 * The whole creation scene as a person does it: FAB → (org name) → poster → title/intro/time/
 * place → ticket kinds → 행사 만들기. A paid tier is expected to block: the button stays
 * disabled and the honest "유료 티켓은 곧 열려요…" line shows, so the util asserts that and
 * returns `blocked` instead of publishing.
 */
export async function createOrganizerAndEvent(page: Page, spec: EventSpec): Promise<CreateResult> {
  return timed(spec.personaId, 'create-event', async () => {
    await page.goto('/');
    await page.getByRole('button', { name: C.fab, exact: true }).click();
    await expect(page).toHaveURL(/\/org\/new/, { timeout: 30_000 });

    // A leftover autosaved draft asks to be resumed; start clean.
    const fresh = page.getByRole('button', { name: C.resumeFresh, exact: true });
    if (await fresh.isVisible().catch(() => false)) await fresh.click();

    // Poster.
    await page.getByRole('button', { name: C.posterAdd, exact: true }).click();
    await page.getByLabel(C.filePick, { exact: true }).setInputFiles(POSTER);
    await page.getByRole('button', { name: C.crop, exact: true }).click();
    // The modal closes and the card shows the picture; the upload runs behind the scene.
    await expect(page.getByRole('button', { name: C.posterChange, exact: true })).toBeVisible({ timeout: 30_000 });

    await page.getByLabel(C.title, { exact: true }).fill(spec.title);
    await page.getByLabel(C.intro, { exact: true }).fill(spec.intro);
    await page.getByLabel(C.startsAt, { exact: true }).fill(futureLocal(2, 12));
    await page.getByLabel(C.venue, { exact: true }).fill(spec.venue);

    // Ticket kinds. The first exists; extra ones are added from the fold.
    for (let i = 1; i < spec.tiers.length; i++) {
      await openMore(page);
      await page.getByRole('button', { name: C.addTier, exact: true }).click();
    }
    for (let i = 0; i < spec.tiers.length; i++) {
      await configureTier(page.locator('.tier-card').nth(i), spec.tiers[i]);
    }

    // Organiser name, only when this person has none yet (first event).
    const org = page.getByLabel(C.orgName, { exact: true });
    if (await org.isVisible().catch(() => false)) await org.fill(spec.orgName);

    const hasPaid = spec.tiers.some((t) => t.kind === '유료');
    const createBtn = page.getByRole('button', { name: C.create, exact: true });
    if (hasPaid) {
      await expect(page.getByText(C.paidBlocked)).toBeVisible();
      await expect(createBtn).toBeDisabled();
      return { eventId: null, blocked: true };
    }

    await expect(createBtn).toBeEnabled({ timeout: 30_000 });
    await createBtn.click();
    await expect(page).toHaveURL(/\/org\/new\/done\/\d+/, { timeout: 4 * 60 * 1000 });
    const eventId = page.url().split('/').pop() ?? null;
    return { eventId, blocked: false };
  });
}

async function openMore(page: Page): Promise<void> {
  const summary = page.getByText(C.more, { exact: true });
  // <details> — click the summary only if it is still closed.
  const open = await page.locator('details.more[open]').count();
  if (open === 0) await summary.click();
}

async function configureTier(card: Locator, tier: TierSpec): Promise<void> {
  if (tier.name) await card.getByLabel('티켓 종류 (예: 일반, VIP)', { exact: true }).fill(tier.name);
  if (tier.supply !== undefined) await card.getByLabel('수량', { exact: true }).fill(String(tier.supply));
  if (tier.kind === '유료') {
    await card.getByRole('button', { name: '유료', exact: true }).click();
    if (tier.price !== undefined) await card.getByLabel('금액', { exact: true }).fill(String(tier.price));
    if (tier.limit !== undefined) await card.getByLabel('1인당 한도', { exact: true }).fill(String(tier.limit));
  } else {
    await card.getByRole('button', { name: '무료', exact: true }).click();
    if (tier.mode === '관리자 승인') {
      // Flag-gated: the chip is disabled until VITE_APPROVAL_MODES is on (the 01c deploy).
      const chip = card.getByRole('button', { name: '관리자 승인 후 발급', exact: true });
      if (!(await chip.isEnabled())) {
        throw new Error('APPROVAL_MODE_DISABLED: VITE_APPROVAL_MODES is off in this build; the approval option opens with the 01c deploy');
      }
      await chip.click();
    } else if (tier.mode === '선착순') {
      await card.getByRole('button', { name: '선착순 자동 승인', exact: true }).click();
    }
  }
}

/**
 * Publish a draft event so attendees can claim it. `createEvent` makes a Draft and `claim`
 * refuses anything that is not Published, so every claim scenario runs this first.
 * Returns 'published' | 'confirming' — the latter meaning the op is still landing (indexer lag).
 */
export async function publishEvent(page: Page, personaId: string, eventId: string): Promise<'published' | 'confirming'> {
  return timed(personaId, 'publish-event', async () => {
    await page.goto(`/org/events/${eventId}`);
    await page.getByRole('button', { name: C.publish, exact: true }).click();
    await page.getByRole('button', { name: C.publishConfirm, exact: true }).click();
    const done = page.getByText(C.published, { exact: true });
    const confirming = page.getByText(C.publishConfirming);
    await expect(done.or(confirming)).toBeVisible({ timeout: 3 * 60 * 1000 });
    return (await done.isVisible()) ? 'published' : 'confirming';
  });
}
