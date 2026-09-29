import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventDraft, RelayView, StoredEventDraft } from '../shared/api/firestore';

let store: StoredEventDraft[] = [];
const listEventDrafts = vi.fn(async () => [...store]);
const deleteEventDraft = vi.fn(async (id: string) => {
  store = store.filter((row) => row.id !== id);
});
const saveEventDraft = vi.fn(async () => undefined);
// What the followed `relays/{relayId}` document reports; each test sets it before mounting, and the
// mock hands it to the banner's subscriber synchronously (one delivery is enough for these cases).
let relayView: RelayView | null = { status: 'pending' };
const watchRelay = vi.fn((_id: string, onChange: (relay: RelayView | null) => void) => {
  onChange(relayView);
  return () => undefined;
});
vi.mock('../shared/api/firestore', () => ({ listEventDrafts, deleteEventDraft, saveEventDraft, watchRelay }));

const saveEventArt = vi.fn(async () => ({ ok: true }));
const setEventPrivate = vi.fn(async () => ({ ok: true }));
vi.mock('../shared/api/functions', () => ({ api: { saveEventArt, setEventPrivate } }));

const navigate = vi.fn();
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

const { PendingCreateBanner } = await import('./PendingCreateBanner');
const { organizerCopy } = await import('./copy');
const { emptyEventDraft, emptyEventDraftTier } = await import('./useEventDraft');
const copy = organizerCopy.ko.home;

const RELAY_ID = 'relay-abc';

const WAITING: EventDraft = {
  ...emptyEventDraft,
  orgId: '9',
  title: '  재즈 나이트  ',
  posterCid: 'bafkposter',
  submittedRelayId: RELAY_ID,
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
  watchRelay.mockClear();
  relayView = { status: 'pending' };
  saveEventArt.mockResolvedValue({ ok: true });
  setEventPrivate.mockResolvedValue({ ok: true });
});

describe('the home pending-create banner', () => {
  it('shows nothing, and follows no relay, when no draft is waiting on one', async () => {
    open();
    await waitFor(() => expect(listEventDrafts).toHaveBeenCalled());
    expect(screen.queryByText(copy.pendingCreate)).toBeNull();
    expect(watchRelay).not.toHaveBeenCalled();
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

  it('shows the 확인 중 banner, with a way back in, while the relay is still sent', async () => {
    store = [{ id: 'd-1', updatedAt: 1, data: WAITING }];
    relayView = { status: 'sent' };
    open();
    expect(await screen.findByText(copy.pendingCreate)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: copy.pendingCreateOpen }))
      .toHaveAttribute('href', '/org/new/d-1');
    await waitFor(() => expect(watchRelay)
      .toHaveBeenCalledWith(RELAY_ID, expect.any(Function), expect.any(Function)));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('runs the follow-ups and goes to the done screen once the relay confirms', async () => {
    store = [{ id: 'd-1', updatedAt: 1, data: WAITING }];
    relayView = { status: 'confirmed', result: { eventId: '12' } };
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

  it('says the create failed, with a link back in, when the relay failed', async () => {
    store = [{ id: 'd-1', updatedAt: 1, data: WAITING }];
    relayView = { status: 'failed', error: { code: 'TX_REVERT', message: 'reverted' } };
    open();
    expect(await screen.findByText(copy.pendingCreateFailed)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: copy.pendingCreateOpen }))
      .toHaveAttribute('href', '/org/new/d-1');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('sends them back into the draft when the relay confirmed but named no event id', async () => {
    store = [{ id: 'd-1', updatedAt: 1, data: WAITING }];
    relayView = { status: 'confirmed', result: {} };
    open();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/org/new/d-1'));
    expect(saveEventArt).not.toHaveBeenCalled();
  });
});
