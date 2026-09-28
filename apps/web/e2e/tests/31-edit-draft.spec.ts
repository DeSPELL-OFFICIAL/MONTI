import { test, expect } from '@playwright/test';
import { ADMIN } from '../fixtures/personas';
import { closePersona, ensureAccount, openPersona } from '../utils/session';
import { createOrganizerAndEvent, publishEvent } from '../utils/organizer';
import { timed } from '../fixtures/timings';

/**
 * Edit a Draft, then publish — the whole "make it, fix it, ship it" loop for an organiser.
 *
 * Extra scenario, off by default (`E2E_EXTRA=1`): it creates, updates and publishes an event, all
 * sponsored on-chain ops, so the controller schedules it against the paymaster budget.
 *
 * Steps, exactly as the app allows them:
 *  1. Admin creates a NEW event and stops on the done screen — a Draft, deliberately NOT published.
 *  2. It is reopened from 주최자 홈 → 행사 현황, whose 행사 정보 고치기 link opens the same creation
 *     scene on the existing event (EditEvent writes a draft from it, `updateEventMeta` on save).
 *  3. The title and the start time are changed, and the scene's 저장 sends `updateEventMeta`.
 *  4. The event is published (Draft → Published).
 *  5. The published event is asserted to carry the edited values: the public event screen's title
 *     is the new one, and the indexer's `Event.startsAt` falls on the edited date.
 *
 * Editing closes the moment an event is published (`updateEventMeta` reverts past Draft), which is
 * why the edit happens before the publish and never after.
 */

const EXTRA = process.env.E2E_EXTRA === '1';
const describe = EXTRA ? test.describe : test.describe.skip;

/** Copy strings, verbatim from apps/web/src (organizer/copy.ts). */
const C = {
  dashEdit: '행사 정보 고치기', // Dashboard edit link (offered only while Draft)
  sceneTitle: '행사 만들기', // CreateEvent scene heading
  editSave: '저장', // scene action button in edit mode (copy.scene.tiers.save)
  titleLabel: '제목',
  startLabel: '시작',
} as const;

/** A YYYY-MM-DDTHH:00 string in Asia/Seoul, `days` from now — safely in the future. */
function futureLocal(days: number, hour: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  const date = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
  return `${date}T${String(hour).padStart(2, '0')}:00`;
}

/** The Seoul calendar date (YYYY-MM-DD) of a Unix-seconds instant. */
function seoulDate(epochSeconds: number): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(epochSeconds * 1000));
}

/** The indexer's `Event.startsAt`, in Unix seconds, or 0 when it could not be read. */
async function eventStartsAt(envioUrl: string, id: string): Promise<number> {
  if (!envioUrl) return 0;
  try {
    const res = await fetch(envioUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'query EventStart($id: String!) { Event(where: { id: { _eq: $id } }) { id startsAt status } }',
        variables: { id },
      }),
    });
    const body = (await res.json()) as { data?: { Event?: Array<{ startsAt?: string }> } };
    return Number(body.data?.Event?.[0]?.startsAt ?? 0);
  } catch {
    return 0;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('MONTI edit draft then publish (admin)', () => {
  test('admin edits a draft event title + time, then publishes', async ({ browser }) => {
    const admin = await openPersona(browser, ADMIN);

    // Capture the indexer endpoint off any Event query the organiser screens already send.
    let envioUrl = '';
    admin.page.on('request', (req) => {
      if (envioUrl) return;
      const post = req.postData() ?? '';
      if (req.method() === 'POST' && post.includes('startsAt') && post.includes('Event')) envioUrl = req.url();
    });

    try {
      await ensureAccount(admin);

      const stamp = Date.now();
      const oldTitle = `수정 전 행사 ${stamp}`;
      const newTitle = `수정된 행사 ${stamp}`;
      const newStart = futureLocal(6, 19); // distinct from the created event's futureLocal(2, 12)
      const wantDate = newStart.slice(0, 10);

      // 1) Create a Draft — do NOT publish (createOrganizerAndEvent stops on the done screen).
      const created = await createOrganizerAndEvent(admin.page, {
        personaId: ADMIN.id,
        orgName: '몬티 크루',
        title: oldTitle,
        intro: 'E2E 자동화가 만든 편집 테스트 행사입니다. 공개 전에 제목과 시간을 고칩니다.',
        venue: '서울 성수동 테스트홀',
        tiers: [{ kind: '무료', mode: '선착순', name: '일반', supply: 100 }],
      });
      expect(created.blocked).toBe(false);
      expect(created.eventId).toBeTruthy();
      const eventId = created.eventId!;

      // 2) Reopen from 주최자 홈 → 행사 현황 → 행사 정보 고치기, retrying until the event is indexed.
      await timed(ADMIN.id, 'edit.reopen', async () => {
        await admin.page.goto('/org');
        await admin.page.getByRole('heading', { name: '주최자' }).waitFor({ state: 'visible', timeout: 30_000 }).catch(() => undefined);

        const editLink = admin.page.getByRole('link', { name: C.dashEdit, exact: true });
        const loadDeadline = Date.now() + 150_000;
        while (Date.now() < loadDeadline) {
          await admin.page.goto(`/org/events/${eventId}`);
          await admin.page.waitForTimeout(2000);
          if (await editLink.isVisible().catch(() => false)) break;
          await admin.page.waitForTimeout(3000);
        }
        await expect(editLink).toBeVisible({ timeout: 30_000 });
        await editLink.click();

        // EditEvent reads the event, writes a draft and replaces to the scene. Re-open on a failed read.
        const editSave = admin.page.locator('.sticky-bar__buttons').getByRole('button', { name: C.editSave, exact: true });
        const sceneDeadline = Date.now() + 150_000;
        while (Date.now() < sceneDeadline && !(await editSave.isVisible({ timeout: 4000 }).catch(() => false))) {
          await admin.page.goto(`/org/events/${eventId}/edit`);
          await admin.page.waitForTimeout(3000);
        }
        await expect(admin.page.getByRole('heading', { name: C.sceneTitle })).toBeVisible({ timeout: 30_000 });
        await expect(editSave).toBeVisible({ timeout: 30_000 });
      });

      // 3) Change title + start time, then 저장 (updateEventMeta).
      await timed(ADMIN.id, 'edit.fields', async () => {
        const titleInput = admin.page.locator('label.field', { hasText: C.titleLabel }).locator('input, textarea').first();
        await titleInput.fill(newTitle, { force: true });
        const startInput = admin.page.locator('label.field', { hasText: C.startLabel }).locator('input[type="datetime-local"]').first();
        await startInput.fill(newStart, { force: true });
      });

      await timed(ADMIN.id, 'edit.save', async () => {
        const editSave = admin.page.locator('.sticky-bar__buttons').getByRole('button', { name: C.editSave, exact: true });
        await editSave.evaluate((el) => (el as HTMLButtonElement).click());
        // On success EditEvent's onCreated navigates to the dashboard; a slow op leaves the scene up
        // with the button pressable again (re-checks the same op — never a second event).
        const backOnDash = new RegExp(`/org/events/${eventId}(?:[/?#]|$)`);
        const deadline = Date.now() + 6 * 60 * 1000;
        while (Date.now() < deadline && !backOnDash.test(admin.page.url())) {
          if (/\/org\/new\//.test(admin.page.url()) && (await editSave.isEnabled().catch(() => false))) {
            await editSave.evaluate((el) => (el as HTMLButtonElement).click()).catch(() => undefined);
          }
          await admin.page.waitForTimeout(3000);
        }
        await expect(admin.page).toHaveURL(backOnDash, { timeout: 60_000 });
      });

      // 4) Publish (Draft → Published).
      await publishEvent(admin.page, ADMIN.id, eventId);

      // 5a) The published event shows the edited title on its public screen.
      await timed(ADMIN.id, 'edit.verify-title', async () => {
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
          await admin.page.goto(`/events/${eventId}`);
          if (await admin.page.getByRole('heading', { name: newTitle }).isVisible({ timeout: 12_000 }).catch(() => false)) return;
          await admin.page.waitForTimeout(5000);
        }
        throw new Error(`published event ${eventId} never showed the edited title`);
      });
      await expect(admin.page.getByRole('heading', { name: newTitle })).toBeVisible();

      // 5b) The indexer's start time is the edited date.
      const gotDate = await timed(ADMIN.id, 'edit.verify-time', async (): Promise<string> => {
        const deadline = Date.now() + 90_000;
        let last = '';
        while (Date.now() < deadline) {
          const startsAt = await eventStartsAt(envioUrl, eventId);
          if (startsAt > 0) {
            last = seoulDate(startsAt);
            if (last === wantDate) return last;
          }
          await sleep(5000);
        }
        return last;
      });
      expect(gotDate, `published event start date is the edited ${wantDate}`).toBe(wantDate);
    } finally {
      await closePersona(admin).catch(() => undefined);
    }
  });
});
