import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifecycleResult } from '../lifecycle';
import { keccak256, toBytes } from 'viem';
import type { EventDraft, StoredEventDraft } from '../../shared/api/firestore';

let store: StoredEventDraft[] = [];
const listEventDrafts = vi.fn(async () => [...store].sort((a, b) => b.updatedAt - a.updatedAt));
const saveEventDraft = vi.fn(async (id: string, draft: EventDraft) => {
  store = [{ id, updatedAt: 2_000, data: draft }, ...store.filter((row) => row.id !== id)];
});
const deleteEventDraft = vi.fn(async (id: string) => {
  store = store.filter((row) => row.id !== id);
});
const loadEventArt = vi.fn(async () => [{ preset: 'c' as const }, { imageCid: 'bafkmine' }]);
const loadMyProfile = vi.fn(async () => ({ displayName: '김태완' }));
vi.mock('../../shared/api/firestore', () => ({
  listEventDrafts, saveEventDraft, deleteEventDraft, loadEventArt, loadMyProfile,
}));
/** The indexer's answer about this person as an organiser, which the scene now reads too. */
const orgRefetch = vi.fn(async () => [] as { orgId: string; canCreateEvent: boolean }[]);
const orgsListed = vi.fn(() => [] as { orgId: string; canCreateEvent: boolean }[]);
vi.mock('../useMyOrgs', () => ({
  useMyOrgs: () => ({
    orgs: orgsListed(), canCreateEvent: false, isLoading: false, isError: false,
    error: null, refetch: orgRefetch,
  }),
}));


const pinEventMetadata = vi.fn(async (_args: unknown) => ({ metadataCid: 'bafyNew' }));
const saveEventArt = vi.fn(async (_args: unknown) => ({ ok: true as const }));
const setEventPrivate = vi.fn(async (_args: unknown) => ({ ok: true as const }));
const getEventPrivate = vi.fn(async (_args: unknown) => ({ venue: '서울 용산구 한남동 12-3' }));
const pinEventImage = vi.fn(async () => ({ cid: 'bafkposter' }));
vi.mock('../../shared/api/functions', async (orig) => ({
  ...(await orig<typeof import('../../shared/api/functions')>()),
  api: { pinEventMetadata, saveEventArt, setEventPrivate, getEventPrivate, pinEventImage },
}));

interface SentOp { functionName: string; orgId: bigint; args: readonly unknown[] }
const ticketOp = vi.fn(async (_options: SentOp) => ({ success: true, userOpHash: '0x', logs: [] }));
vi.mock('../../shared/chain/ops', async (orig) => ({
  ...(await orig<typeof import('../../shared/chain/ops')>()),
  ticketOp,
}));

const ACCOUNT = `0x${'ab'.repeat(20)}` as const;
vi.mock('../../shared/chain/accounts', () => ({ getStaffAccount: async () => ({ address: ACCOUNT }) }));

// The relayed draft save is mocked at the module seam; lifecycle.test.ts covers the transport.
const saveDraft = vi.fn<(eventId: bigint, orgId: bigint, meta: unknown, tiers: unknown) => Promise<LifecycleResult>>(async () => ({ state: 'done' }));
vi.mock('../lifecycle', () => ({ saveDraft }));

const gql = vi.fn(async () => ({ Event: [EVENT], Tier: TIERS }));
vi.mock('../../shared/envio/client', () => ({ gql }));

const fetchEventMetadata = vi.fn(async (_cid: string) => META);
vi.mock('../../shared/envio/ipfs', async (orig) => ({
  ...(await orig<typeof import('../../shared/envio/ipfs')>()),
  fetchEventMetadata,
}));

vi.mock('../../shared/config', async (orig) => ({
  ...(await orig<typeof import('../../shared/config')>()),
  getConfig: () => ({ ipfsGateway: 'https://gw.test/' }),
}));

/** One event as the four sources hold it: the chain's numbers, the document's words. */
const EVENT = {
  id: '7', orgId: '9', imageCid: 'bafyOld',
  startsAt: '1900000000', endsAt: '1900010000', saleStart: '1800000000', saleEnd: '1900010000',
  transferable: true, transferCutoffSeconds: '7200', maxTransfers: 3, category: 2,
  regionCode: keccak256(toBytes('KR-11')), status: 'Draft', requireKyc: false,
};
const TIERS = [
  { id: '7-0', eventId: '7', idx: 0, name: '일반', priceUsdCents: '0', supply: '100', minted: '4', maxPerWallet: '2', seated: false },
  { id: '7-1', eventId: '7', idx: 1, name: '학생', priceUsdCents: '0', supply: '20', minted: '0', maxPerWallet: '1', seated: false },
];
const META = {
  title: '재즈 나이트', description: '한남동 재즈 라이브 공연', image: 'https://gw.test/bafkposter',
  imageCid: 'bafkposter', venue: '', category: 2, region: 'KR-11',
  tags: ['재즈', '라이브'], venueHidden: true, timeHidden: false,
};

const { EditEvent } = await import('./EditEvent');
const { ko: sharedCopy } = await import('../../shared/copy/index');
const { CreateEvent } = await import('./CreateEvent');
const { organizerCopy } = await import('../copy');
const copy = organizerCopy.ko.scene;

function Probe() {
  return <p>{`landed:${useLocation().pathname}`}</p>;
}

/** The whole of the organiser's side of an edit: the prefill screen and the scene. */
function open(at = '/org/events/7/edit'): void {
  render(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route path="/org/events/:eventId/edit" element={<EditEvent />} />
        <Route path="/org/new/:draftId" element={<CreateEvent />} />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** What the prefill wrote, which is what the scene then opens. */
function written(): EventDraft {
  return saveEventDraft.mock.calls[0]?.[1] as EventDraft;
}

beforeAll(() => {
  URL.createObjectURL = () => 'blob:art';
  URL.revokeObjectURL = () => undefined;
});

beforeEach(() => {
  localStorage.clear();
  store = [];
  gql.mockResolvedValue({ Event: [EVENT], Tier: TIERS });
  fetchEventMetadata.mockResolvedValue(META);
  getEventPrivate.mockResolvedValue({ venue: '서울 용산구 한남동 12-3' });
  loadEventArt.mockResolvedValue([{ preset: 'c' }, { imageCid: 'bafkmine' }]);
  pinEventMetadata.mockResolvedValue({ metadataCid: 'bafyNew' });
  ticketOp.mockResolvedValue({ success: true, userOpHash: '0x', logs: [] });
  saveDraft.mockReset().mockResolvedValue({ state: 'done' });
  saveEventArt.mockResolvedValue({ ok: true });
  setEventPrivate.mockResolvedValue({ ok: true });
});

describe('reopening the scene on an event that already exists', () => {
  it('prefills from all four places the event lives, and lands in the scene', async () => {
    open();
    await waitFor(() => expect(saveEventDraft).toHaveBeenCalled());
    const draft = written();

    // The chain's own numbers, through the indexer.
    expect(draft).toMatchObject({
      orgId: '9',
      category: 2,
      startsAt: 1_900_000_000,
      endsAt: 1_900_010_000,
      transferable: true,
      transferCutoffHours: 2,
      requireKyc: false,
      editingEventId: '7',
    });
    // The words, from the pinned document — and the region from it too, because the chain
    // holds only `keccak256('KR-11')`, which nothing can turn back into a region.
    expect(draft).toMatchObject({
      title: '재즈 나이트',
      description: '한남동 재즈 라이브 공연',
      posterCid: 'bafkposter',
      regionCode: 'KR-11',
      tags: ['재즈', '라이브'],
      venueHidden: true,
      timeHidden: false,
    });
    // The hidden venue is in no public document at all; the callable is the only copy of it.
    expect(getEventPrivate).toHaveBeenCalledWith({ eventId: '7' });
    expect(draft.venue).toBe('서울 용산구 한남동 12-3');
    // The kinds, with the pictures folded back into the two fields the draft keeps apart.
    expect(draft.tiers).toEqual([
      { name: '일반', supply: 100, maxPerWallet: 2, currency: 'free', amount: 0, design: 'c', imageCid: '' },
      { name: '학생', supply: 20, maxPerWallet: 1, currency: 'free', amount: 0, design: 'a', imageCid: 'bafkmine' },
    ]);
    // Neither duplicate guard is carried over: this draft made no event, it opened one.
    expect(draft.createdEventId).toBe('');
    expect(draft.submittedOpHash).toBe('');

    // And the fields are on screen, in the scene itself rather than in a second copy of it.
    expect(await screen.findByDisplayValue('재즈 나이트')).toBeInTheDocument();
    expect(screen.getByDisplayValue('서울 용산구 한남동 12-3')).toBeInTheDocument();
  });

  it('refuses a published event instead of letting the whole screen be filled in first', async () => {
    gql.mockResolvedValue({ Event: [{ ...EVENT, status: 'Published' }], Tier: TIERS });
    open();
    expect(await screen.findByText(copy.edit.notDraft)).toBeInTheDocument();
    expect(saveEventDraft).not.toHaveBeenCalled();
  });

  it('refuses rather than prefilling blanks when the document cannot be read', async () => {
    fetchEventMetadata.mockRejectedValue(new Error('IPFS_504'));
    open();
    expect(await screen.findByText(sharedCopy.common.error)).toBeInTheDocument();
    expect(saveEventDraft).not.toHaveBeenCalled();
  });

  /**
   * The same rule for the pictures as for the words. `saveEventArt` replaces the document, so
   * a prefill that read `[]` from a failed read and then saved would write every kind back as
   * the first preset and erase whatever an organiser had uploaded.
   */
  it('refuses when the stored pictures cannot be read, and never saves defaults over them', async () => {
    loadEventArt.mockRejectedValue(new Error('offline'));
    open();
    expect(await screen.findByText(sharedCopy.common.error)).toBeInTheDocument();
    expect(saveEventDraft).not.toHaveBeenCalled();
    expect(saveEventArt).not.toHaveBeenCalled();
  });

  it('offers a retry that runs the whole prefill again once the read comes back', async () => {
    const user = userEvent.setup();
    loadEventArt.mockRejectedValueOnce(new Error('offline'));
    open();
    await screen.findByText(sharedCopy.common.error);

    await user.click(screen.getByRole('button', { name: sharedCopy.common.retry }));
    await waitFor(() => expect(saveEventDraft).toHaveBeenCalled());
    expect((saveEventDraft.mock.calls[0]?.[1] as EventDraft).tiers[0]?.design).toBe('c');
  });
});

describe('saving an edit', () => {
  /** The whole point of W12: the same scene, and `updateEventMeta` in place of `createEvent`. */
  it('re-pins the document, sends updateEventMeta and runs the same follow-ups', async () => {
    const user = userEvent.setup();
    open();
    await waitFor(() => expect(saveEventDraft).toHaveBeenCalled());
    const draftId = saveEventDraft.mock.calls[0]?.[0] as string;

    await screen.findByDisplayValue('재즈 나이트');
    await user.type(screen.getByDisplayValue('재즈 나이트'), '!');

    // The one button says 저장 on an edit, not 행사 만들기.
    const save = await screen.findByRole('button', { name: copy.tiers.save });
    expect(screen.queryByRole('button', { name: copy.tiers.create })).toBeNull();
    await user.click(save);

    // 1. a fresh document, because the chain's hashes and its `imageCid` are written together.
    await waitFor(() => expect(pinEventMetadata).toHaveBeenCalled());
    expect(pinEventMetadata).toHaveBeenCalledWith({
      orgId: '9',
      meta: expect.objectContaining({
        name: '재즈 나이트!',
        imageCid: 'bafkposter',
        tags: ['재즈', '라이브'],
        venueHidden: true,
        timeHidden: false,
      }),
    });
    // The hidden venue never leaves the browser in the pinned half.
    expect((pinEventMetadata.mock.calls[0]?.[0] as { meta: Record<string, unknown> }).meta.venue)
      .toBeUndefined();

    // 2. `updateEventMeta` via the ticket relay (saveDraft), never a second `createEvent`.
    await waitFor(() => expect(saveDraft).toHaveBeenCalled());
    const [savedEventId, savedOrgId, savedMeta] =
      saveDraft.mock.calls[0] as unknown as [bigint, bigint, Record<string, unknown>, unknown];
    expect(savedEventId).toBe(7n);
    expect(savedOrgId).toBe(9n);
    expect(savedMeta).toMatchObject({
      imageCid: 'bafyNew',
      titleHash: keccak256(toBytes('재즈 나이트!')),
      // Hidden or not, the hash on chain is of the real venue.
      venueHash: keccak256(toBytes('서울 용산구 한남동 12-3')),
      regionCode: keccak256(toBytes('KR-11')),
    });
    expect(ticketOp).not.toHaveBeenCalled();

    // 3. the same two follow-ups, addressed at the event that already existed.
    await waitFor(() => expect(saveEventArt).toHaveBeenCalledWith({
      eventId: '7',
      tiers: [{ preset: 'c' }, { imageCid: 'bafkmine' }],
    }));
    expect(setEventPrivate).toHaveBeenCalledWith({ eventId: '7', venue: '서울 용산구 한남동 12-3' });

    // 4. the draft goes, and the organiser is back on the event — not on the done screen.
    await waitFor(() => expect(screen.getByText('landed:/org/events/7')).toBeInTheDocument());
    expect(deleteEventDraft).toHaveBeenCalledWith(draftId);
  });

  it('keeps the draft and says so when a follow-up did not land', async () => {
    saveEventArt.mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    open();
    await waitFor(() => expect(saveEventDraft).toHaveBeenCalled());
    const draftId = saveEventDraft.mock.calls[0]?.[0] as string;

    await screen.findByDisplayValue('재즈 나이트');
    await user.click(await screen.findByRole('button', { name: copy.tiers.save }));

    expect(await screen.findByText(copy.publishProblems.followUpFailed)).toBeInTheDocument();
    // Pressing 저장 again is the retry: every step of an update replaces rather than adds.
    expect(deleteEventDraft).not.toHaveBeenCalledWith(draftId);
    expect(screen.queryByText('landed:/org/events/7')).toBeNull();
  });

  it('says the event has been published when the chain refuses the update', async () => {
    saveDraft.mockResolvedValue({ state: 'refused', problem: 'notDraft' });
    const user = userEvent.setup();
    open();
    await waitFor(() => expect(saveEventDraft).toHaveBeenCalled());

    await screen.findByDisplayValue('재즈 나이트');
    await user.click(await screen.findByRole('button', { name: copy.tiers.save }));

    expect(await screen.findByText(copy.publishProblems.notDraft)).toBeInTheDocument();
    expect(saveEventArt).not.toHaveBeenCalled();
  });
});
