import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeEventTopics, numberToHex } from 'viem';
import { ticketAbi } from '../shared/chain/abis';
import type { EventDraft, StoredEventDraft } from '../shared/api/firestore';

let store: StoredEventDraft[] = [];
const listEventDrafts = vi.fn(async () => [...store]);
const deleteEventDraft = vi.fn(async (id: string) => {
  store = store.filter((row) => row.id !== id);
});
const saveEventDraft = vi.fn(async () => undefined);
vi.mock('../shared/api/firestore', () => ({ listEventDrafts, deleteEventDraft, saveEventDraft }));

const resolveSubmittedOp = vi.fn(async () => ({ state: 'pending' as string, logs: [] as unknown[] }));
vi.mock('../shared/chain/ops', () => ({ resolveSubmittedOp }));

const saveEventArt = vi.fn(async () => ({ ok: true }));
const setEventPrivate = vi.fn(async () => ({ ok: true }));
vi.mock('../shared/api/functions', () => ({ api: { saveEventArt, setEventPrivate } }));

// `createdEventId` keeps only the Ticket contract's own logs, so the mocked config's ticket
// address has to match the CREATED_LOG address below.
vi.mock('../shared/config', async (orig) => ({
  ...(await orig<typeof import('../shared/config')>()),
  getConfig: () => ({ addresses: { ticket: `0x${'33'.repeat(20)}` } }),
}));

const navigate = vi.fn();
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

const { PendingCreateBanner } = await import('./PendingCreateBanner');
const { organizerCopy } = await import('./copy');
const { emptyEventDraft, emptyEventDraftTier } = await import('./useEventDraft');
const copy = organizerCopy.ko.home;

const TICKET = `0x${'33'.repeat(20)}` as const;
const HASH = `0x${'11'.repeat(32)}` as const;

/** `EventCreated(eventId=12, orgId=9, creator)`, so the landed path can read the number. */
const CREATED_LOG = {
  address: TICKET,
  topics: [
    encodeEventTopics({ abi: ticketAbi, eventName: 'EventCreated', args: { eventId: 12n } })[0],
    numberToHex(12n, { size: 32 }),
    numberToHex(9n, { size: 32 }),
    `0x${'00'.repeat(12)}${'ab'.repeat(20)}`,
  ],
  data: '0x',
};

const WAITING: EventDraft = {
  ...emptyEventDraft,
  orgId: '9',
  title: '  재즈 나이트  ',
  posterCid: 'bafkposter',
  submittedOpHash: HASH,
  tiers: [{ ...emptyEventDraftTier, design: 'c' }],
};

function open(): void {
  render(
    <MemoryRouter>
      <PendingCreateBanner />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  store = [];
  navigate.mockReset();
  deleteEventDraft.mockClear();
  saveEventArt.mockClear();
  setEventPrivate.mockClear();
  resolveSubmittedOp.mockResolvedValue({ state: 'pending', logs: [] });
  saveEventArt.mockResolvedValue({ ok: true });
  setEventPrivate.mockResolvedValue({ ok: true });
});

describe('the home pending-create banner', () => {
  it('shows nothing when no draft is waiting on an op', async () => {
    open();
    await waitFor(() => expect(listEventDrafts).toHaveBeenCalled());
    expect(screen.queryByText(copy.pendingCreate)).toBeNull();
    expect(resolveSubmittedOp).not.toHaveBeenCalled();
  });

  it('ignores a draft that already has an event id, or is an edit', async () => {
    store = [
      { id: 'd-done', updatedAt: 2, data: { ...WAITING, createdEventId: '5' } },
      { id: 'd-edit', updatedAt: 1, data: { ...WAITING, editingEventId: '7' } },
    ];
    open();
    await waitFor(() => expect(listEventDrafts).toHaveBeenCalled());
    expect(screen.queryByText(copy.pendingCreate)).toBeNull();
  });

  it('shows the 확인 중 banner, with a way back in, while the op is still pending', async () => {
    store = [{ id: 'd-1', updatedAt: 1, data: WAITING }];
    open();
    expect(await screen.findByText(copy.pendingCreate)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: copy.pendingCreateOpen }))
      .toHaveAttribute('href', '/org/new/d-1');
  });

  it('runs the follow-ups and goes to the done screen once the op has landed', async () => {
    store = [{ id: 'd-1', updatedAt: 1, data: WAITING }];
    resolveSubmittedOp.mockResolvedValue({ state: 'landed', logs: [CREATED_LOG] });
    open();
    await waitFor(() => expect(saveEventArt).toHaveBeenCalledWith({
      eventId: '12', tiers: [{ preset: 'c' }],
    }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(
      '/org/new/done/12',
      expect.objectContaining({
        state: expect.objectContaining({ draftId: 'd-1', title: '재즈 나이트', followUpFailed: false }),
      }),
    ));
    // Both writes landed, so the draft is thrown away.
    expect(deleteEventDraft).toHaveBeenCalledWith('d-1');
  });

  it('says the create failed, with a link back in, when the op reverted', async () => {
    store = [{ id: 'd-1', updatedAt: 1, data: WAITING }];
    resolveSubmittedOp.mockResolvedValue({ state: 'failed', logs: [] });
    open();
    expect(await screen.findByText(copy.pendingCreateFailed)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: copy.pendingCreateOpen }))
      .toHaveAttribute('href', '/org/new/d-1');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('surfaces the same way back in when the op is stuck in the mempool (stale)', async () => {
    store = [{ id: 'd-1', updatedAt: 1, data: WAITING }];
    resolveSubmittedOp.mockResolvedValue({ state: 'stale', logs: [] });
    open();
    expect(await screen.findByText(copy.pendingCreateFailed)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: copy.pendingCreateOpen }))
      .toHaveAttribute('href', '/org/new/d-1');
    expect(navigate).not.toHaveBeenCalled();
  });
});
