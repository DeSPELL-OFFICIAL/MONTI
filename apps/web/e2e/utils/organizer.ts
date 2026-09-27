import { expect, type Locator, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { timed } from '../fixtures/timings';

const HERE = dirname(fileURLToPath(import.meta.url));
export const POSTER = resolve(HERE, '../assets/poster.jpg');

/** Copy strings, verbatim from apps/web/src/organizer/copy.ts (scene) and ko.ts. */
const C = {
  fab: '행사 만들기',
  posterAdd: '포스터 올리기',
  posterChange: '포스터 바꾸기',
  filePick: '사진 고르기',
  crop: '이 사진으로 정하기',
  resumeFresh: '새로 만들기',
  resumeKeep: '이어서 작성하기',
  quickStart: '빠른 시작',
  quickFree: '무료 선착순',
  quickApproval: '무료 관리자 승인',
  quickPaid: '유료 일반',
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
  // The publish op's wait can give up before the receipt lands; the scene then says this and
  // keeps the button pressable so a second press re-checks the same op (never a second event).
  createConfirming: '만드는 중이에요',
  // publish (organizer dashboard)
  publish: '공개하기',
  publishConfirm: '네, 진행할게요',
  published: '공개했어요',
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

/**
 * A field's control (input/textarea/select), located structurally by its wrapping
 * `<label class="field">` and the exact label text (Field.tsx). R2's "motion + Apple-like polish"
 * re-renders the scene while the poster uploads behind it, which churns the accessible-name
 * resolution getByLabel relied on and keeps the field "not stable"; a structural locator always
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

/**
 * The whole creation scene as a person does it: FAB → (org name) → poster → title/intro/time/
 * place → ticket kinds → 행사 만들기. A paid tier is expected to block: the button stays
 * disabled and the honest "유료 티켓은 곧 열려요…" line shows, so the util asserts that and
 * returns `blocked` instead of publishing.
 */
export async function createOrganizerAndEvent(page: Page, spec: EventSpec): Promise<CreateResult> {
  return timed(spec.personaId, 'create-event', async () => {
    await gotoCreate(page);

    // R2 change (was: addLocatorHandler auto-dismiss mid-action): the creation scene now renders
    // **inert** behind a resume sheet whenever a prior draft exists — `<div className="scene"
    // inert={asking}>` in CreateEvent — so *nothing* in the scene (the poster button included) can
    // be interacted with until the "이어서 작성할까요?" question is answered. The sheet is a motion
    // spring (Sheet = m.div sliding up), so its button is briefly "not stable"; fire the DOM click
    // directly and wait for the sheet to leave (asking→false lifts inert) before touching the scene.
    // 이어서 작성하기 keeps the draft; every field below is overwritten regardless. (The old
    // addLocatorHandler looped here: it fought the spring and the inert scene instead of resolving
    // the decision up front.)
    const resumeKeep = page.getByRole('button', { name: C.resumeKeep, exact: true });
    if (await resumeKeep.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false)) {
      await resumeKeep.evaluate((el) => (el as HTMLButtonElement).click()).catch(() => undefined);
      await resumeKeep.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => undefined);
    }

    // Poster — Batch 2 made it OPTIONAL (plan B-2): a blank one is auto-filled at publish with a
    // default A4 poster (CreateEvent.tsx line ~121; eventProblems never lists poster, so the create
    // button enables without one). The harness therefore SKIPS the upload by default and exercises
    // that auto-default. Set E2E_UPLOAD_POSTER=1 to still drive the full picker/crop flow.
    const uploadPoster = process.env.E2E_UPLOAD_POSTER === '1';
    if (uploadPoster) {
      // Open the picker whether the card offers 포스터 올리기 (empty) or 포스터 바꾸기 (a resumed
      // draft already had one). Fire the DOM click directly — the card can still be settling from
      // the sheet's exit, and the button's own onClick is all that opens the modal.
      await page.getByRole('button', { name: C.posterAdd, exact: true })
        .or(page.getByRole('button', { name: C.posterChange, exact: true }))
        .first()
        .evaluate((el) => (el as HTMLButtonElement).click());
      // The picker is a showModal <dialog class="poster-modal"> and its file input sits inside a
      // wrapping <label> (Field.tsx) whose text Chromium does not apply as the input's accessible
      // name, so getByLabel no longer resolves. Target it by CSS in the modal.
      await page.locator('dialog.poster-modal input[type="file"]').setInputFiles(POSTER);
      const crop = page.getByRole('button', { name: C.crop, exact: true });
      await crop.waitFor({ state: 'attached', timeout: 15_000 });
      await crop.evaluate((el) => (el as HTMLButtonElement).click());
      // The modal closes and the card shows the picture; the upload runs behind the scene.
      await expect(page.getByRole('button', { name: C.posterChange, exact: true })).toBeVisible({ timeout: 30_000 });
    }

    // Force-fill through the structural field locator: a poster upload (when enabled) keeps the
    // scene re-rendering, so getByLabel churns and the plain fill stalls on the stability gate.
    await fieldInput(page, C.title).fill(spec.title, { force: true });
    // Batch 2 relaxed 소개 to allow an empty value (placeholder instead of the 10-char minimum), and
    // the field lives behind the 더 설정하기 fold, so filling it is best-effort — a blank intro is a
    // valid event now, and the create must not hinge on reaching a folded, optional box.
    await fieldInput(page, C.intro).fill(spec.intro, { force: true }).catch(() => undefined);
    await fieldInput(page, C.startsAt).fill(futureLocal(2, 12), { force: true });
    await fieldInput(page, C.venue).fill(spec.venue, { force: true });

    // Ticket kind via the 빠른 시작 preset — one tap sets the first kind and its receiving method.
    // Fire the DOM click directly (evaluate) for the same reason the fields are force-filled.
    const t0 = spec.tiers[0]!;
    const quick = page.getByRole('group', { name: C.quickStart });
    if (t0.kind === '유료') {
      await quick.getByRole('button', { name: C.quickPaid, exact: true }).evaluate((el) => (el as HTMLButtonElement).click());
    } else if (t0.mode === '관리자 승인') {
      const chip = quick.getByRole('button', { name: C.quickApproval, exact: true });
      if (!(await chip.isEnabled())) {
        throw new Error('APPROVAL_MODE_DISABLED: VITE_APPROVAL_MODES is off in this build; the approval preset opens with the 01c deploy');
      }
      await chip.evaluate((el) => (el as HTMLButtonElement).click());
    } else {
      await quick.getByRole('button', { name: C.quickFree, exact: true }).evaluate((el) => (el as HTMLButtonElement).click());
    }
    // Fine-tune the first kind's name and supply in its card.
    const card = page.locator('.tier-card').first();
    if (t0.name) await fieldInput(card, C.tierName).fill(t0.name, { force: true });
    if (t0.supply !== undefined) await fieldInput(card, C.supply).fill(String(t0.supply), { force: true });

    // Organiser name, only when this person has none yet (first event).
    const org = fieldInput(page, C.orgName);
    if (await org.isVisible().catch(() => false)) await org.fill(spec.orgName, { force: true });

    const hasPaid = spec.tiers.some((t) => t.kind === '유료');
    const createBtn = page.getByRole('button', { name: C.create, exact: true });
    if (hasPaid) {
      await expect(page.getByText(C.paidBlocked)).toBeVisible();
      await expect(createBtn).toBeDisabled();
      return { eventId: null, blocked: true };
    }

    await expect(createBtn).toBeEnabled({ timeout: 30_000 });
    // The sticky action bar can sit under the 더 설정하기 <details>, which intercepts the pointer;
    // fire the button's own click so the publish starts regardless of the overlap.
    const doneRe = /\/org\/new\/done\/(\d+)/;
    const confirming = page.getByText(C.createConfirming);
    await createBtn.evaluate((el) => (el as HTMLButtonElement).click());
    const deadline = Date.now() + 6 * 60 * 1000;
    while (Date.now() < deadline && !doneRe.test(page.url())) {
      // A slow on-chain create makes the client's wait give up into "만드는 중이에요…", which keeps
      // the button pressable: pressing again re-checks the same op (it never makes a second event)
      // and navigates to the done screen once it has landed.
      if (await confirming.isVisible().catch(() => false)) {
        await page.waitForTimeout(15_000);
        await createBtn.evaluate((el) => (el as HTMLButtonElement).click()).catch(() => undefined);
      }
      await page.waitForTimeout(2000);
    }
    await expect(page).toHaveURL(doneRe, { timeout: 90_000 });
    const eventId = page.url().match(doneRe)?.[1] ?? null;
    return { eventId, blocked: false };
  });
}

/**
 * Open the creation scene. The 탐색 FAB is the human entry point, but its destination varies —
 * an organiser who already owns an org lands on the organiser home, not the creation scene — so
 * the harness navigates straight to `/org/new`. `RequireSession` shows a spinner while the
 * Firebase session rehydrates after the reload and redirects to `/login` only when truly
 * anonymous, so the scene heading is the signal, retried through the rehydration window.
 */
async function gotoCreate(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    await page.goto('/org/new');
    await page.waitForTimeout(1500);
    if (
      /\/org\/new/.test(page.url()) &&
      (await page.getByRole('heading', { name: C.create }).isVisible({ timeout: 8000 }).catch(() => false))
    ) {
      return;
    }
    // Redirected to /login (anonymous) or still rehydrating — wait and retry.
    await page.waitForTimeout(2000);
  }
  throw new Error('could not open /org/new — persona not signed in');
}

/**
 * Publish a draft event so attendees can claim it. `createEvent` makes a Draft and `claim`
 * refuses anything that is not Published, so every claim scenario runs this first.
 * Returns 'published' | 'confirming' — the latter meaning the op is still landing (indexer lag).
 */
export async function publishEvent(page: Page, personaId: string, eventId: string): Promise<'published' | 'confirming'> {
  return timed(personaId, 'publish-event', async () => {
    const publishBtn = page.getByRole('button', { name: C.publish, exact: true });
    // A just-created event is a Draft, and its 발행하기 button appears only once the organizer page
    // has loaded the newly-indexed event. Right after createEvent the indexer lags a few seconds, so
    // the page briefly shows neither the button nor the event — and the old shortcut ("button not
    // visible ⇒ already Published") misread that empty window as published, left the event a Draft
    // forever, and made every downstream claim fail. Poll the page until the Draft's button appears
    // before deciding; only conclude "already published" after a generous wait with no button.
    let draftReady = false;
    const loadDeadline = Date.now() + 120_000;
    while (Date.now() < loadDeadline) {
      await page.goto(`/org/events/${eventId}`);
      await page.waitForTimeout(2000);
      if (await publishBtn.isVisible().catch(() => false)) { draftReady = true; break; }
      await page.waitForTimeout(3000);
    }
    if (!draftReady) return 'published';
    await publishBtn.evaluate((el) => (el as HTMLButtonElement).click());
    await page.getByRole('button', { name: C.publishConfirm, exact: true }).click();
    // The op's wait can time out; the truth is whether the event left Draft. 발행하기 shows only
    // for a Draft, so once a reload no longer offers it the event is Published.
    const done = page.getByText(C.published, { exact: true });
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      if (await done.isVisible().catch(() => false)) return 'published';
      await page.waitForTimeout(8000);
      await page.goto(`/org/events/${eventId}`);
      await page.waitForTimeout(2000);
      if (!(await publishBtn.isVisible().catch(() => false))) return 'published';
    }
    return 'confirming';
  });
}
