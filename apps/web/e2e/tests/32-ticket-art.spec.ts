import { test, expect, type Page } from '@playwright/test';
import { ADMIN, USERS, type Persona } from '../fixtures/personas';
import { closePersona, ensureAccount, openPersona } from '../utils/session';
import { timed } from '../fixtures/timings';

/**
 * The one part of a ticket editable after publishing: its art. The admin swaps Event 6's ticket
 * picture on the dashboard (preset → another preset) and persona-02's ticket detail must render the
 * new one — the art lives in `eventArt/{eventId}` (not on the chain), so a holder's ticket picks up
 * the change with no re-mint.
 *
 * Extra scenario, off by default (`E2E_EXTRA=1`). `saveEventArt` is a Firestore write, not a
 * sponsored op, so this is cheap — but it is gated with the rest so `pnpm -F web e2e` stays the core
 * suite. Passkey logins are free.
 *
 * The detectable signal is `data-preset` on the ticket SVG (buildTicketSvg emits it for a bundled
 * backdrop): it is read on persona-02's detail before, and polled until it becomes the new preset.
 */

const EXTRA = process.env.E2E_EXTRA === '1';
const describe = EXTRA ? test.describe : test.describe.skip;

const EVENT_ID = process.env.E2E_ART_EVENT ?? '6';
const HOLDER: Persona = USERS[0]!; // persona-02

/** Copy strings, verbatim from apps/web/src (organizer/copy.ts dashboard.art, art preset names). */
const C = {
  ticketsTitle: '내 티켓',
  artTitle: '티켓 이미지',
  artChange: '바꾸기',
  artSaved: '저장했어요',
  presetA: '오로라', // preset 'a'
  presetB: '잉걸', // preset 'b'
} as const;

interface OwnedRow {
  id: string;
  eventId: string | number;
  owner: string;
  revoked?: unknown;
}

/** Capture 내 티켓's OwnedTickets rows so the holder's Event token can be found by event id. */
function watchOwned(page: Page): () => OwnedRow[] {
  let rows: OwnedRow[] = [];
  page.on('response', (resp) => {
    void (async () => {
      try {
        const post = resp.request().postData() ?? '';
        if (!post.includes('OwnedTickets')) return;
        const text = await resp.text().catch(() => '');
        const body = JSON.parse(text) as { data?: { Ticket?: OwnedRow[] } };
        if (body.data?.Ticket) rows = body.data.Ticket;
      } catch {
        /* never throw into the flow */
      }
    })();
  });
  return () => rows;
}

describe('MONTI ticket art change (admin → persona-02 detail)', () => {
  test(`admin swaps Event ${EVENT_ID} ticket art; persona-02's detail renders it`, async ({ browser }) => {
    const admin = await openPersona(browser, ADMIN);
    const holder = await openPersona(browser, HOLDER);

    try {
      await ensureAccount(admin);
      await ensureAccount(holder);

      // Find persona-02's Event token.
      const owned = watchOwned(holder.page);
      await holder.page.goto('/tickets');
      await expect(holder.page.getByRole('heading', { name: C.ticketsTitle })).toBeVisible({ timeout: 60_000 });
      await holder.page.waitForTimeout(3000);
      const held = owned().find((r) => String(r.eventId) === EVENT_ID && !r.revoked);
      test.skip(!held, `persona-02 holds no Event ${EVENT_ID} ticket in the indexer — nothing to check`);
      const tokenId = held!.id;

      // Read the preset the holder's detail shows now (null when a picture was uploaded instead).
      await holder.page.goto(`/tickets/${tokenId}`);
      const detailArt = holder.page.locator('.ticket-detail-art svg').first();
      await expect(detailArt).toBeVisible({ timeout: 30_000 });
      const before = await detailArt.getAttribute('data-preset');
      // Pick a preset that is definitely a change.
      const target: 'a' | 'b' = before === 'b' ? 'a' : 'b';
      const targetName = target === 'a' ? C.presetA : C.presetB;

      // Admin: dashboard → 티켓 이미지 → 바꾸기 (first kind) → pick the target preset → 저장했어요.
      await timed(ADMIN.id, 'art.change', async () => {
        const section = admin.page.locator('.event-art');
        const loadDeadline = Date.now() + 120_000;
        while (Date.now() < loadDeadline) {
          await admin.page.goto(`/org/events/${EVENT_ID}`);
          await admin.page.waitForTimeout(2000);
          if (await section.getByRole('heading', { name: C.artTitle }).isVisible().catch(() => false)) break;
          await admin.page.waitForTimeout(3000);
        }
        await expect(section.getByRole('heading', { name: C.artTitle })).toBeVisible({ timeout: 30_000 });

        const firstCard = section.locator('.tier-card').first();
        await firstCard.getByRole('button', { name: C.artChange, exact: true }).click();
        const carousel = firstCard.locator('.art-carousel');
        await expect(carousel).toBeVisible({ timeout: 15_000 });
        await carousel.getByRole('radio', { name: targetName, exact: true }).click();
        await expect(section.getByText(C.artSaved, { exact: true })).toBeVisible({ timeout: 60_000 });
      });

      // Holder: the ticket detail renders the new preset within a minute.
      const rendered = await timed(HOLDER.id, 'art.propagate', async (): Promise<boolean> => {
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          await holder.page.goto(`/tickets/${tokenId}`);
          const svg = holder.page.locator('.ticket-detail-art svg[data-preset]').first();
          if (await svg.isVisible({ timeout: 15_000 }).catch(() => false)) {
            if ((await svg.getAttribute('data-preset')) === target) return true;
          }
          await holder.page.waitForTimeout(4000);
        }
        return false;
      });
      expect(rendered, `persona-02's ticket detail renders the new preset "${target}"`).toBe(true);
    } finally {
      await closePersona(admin).catch(() => undefined);
      await closePersona(holder).catch(() => undefined);
    }
  });
});
