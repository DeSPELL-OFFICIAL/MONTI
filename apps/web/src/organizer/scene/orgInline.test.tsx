import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, type Hex } from 'viem';
import { ticketAbi } from '../../shared/chain/abis';
import type { EventDraft, StoredEventDraft } from '../../shared/api/firestore';

let store: StoredEventDraft[] = [];
const listEventDrafts = vi.fn(async () => [...store].sort((a, b) => b.updatedAt - a.updatedAt));
const saveEventDraft = vi.fn(async (id: string, draft: EventDraft) => {
  store = [...store.filter((row) => row.id !== id), { id, updatedAt: Date.now(), data: draft }];
});
const deleteEventDraft = vi.fn(async () => undefined);
const loadMyProfile = vi.fn(async () => ({ displayName: '김태완' }));
vi.mock('../../shared/api/firestore', () => ({
  listEventDrafts, saveEventDraft, deleteEventDraft, loadMyProfile,
}));

/** What the indexer lists, and what it lists when asked a second time. */
type Listed = { orgId: string; name: string; role: string; bits: number; canCreateEvent: boolean };
const ORG: Listed = { orgId: '9', name: '재즈 컴퍼니', role: 'owner', bits: 0, canCreateEvent: true };
let listed: Listed[] = [];
const orgRefetch = vi.fn(async () => listed);
vi.mock('../useMyOrgs', () => ({
  useMyOrgs: () => ({
    orgs: listed, canCreateEvent: listed.some((org) => org.canCreateEvent),
    isLoading: false, isError: false, error: null, refetch: orgRefetch,
  }),
}));

const createOrganizerForMe = vi.fn(async (_args: { name: string }) => ({ orgId: '9' }));
const pinEventMetadata = vi.fn(async (_args: unknown) => ({ metadataCid: 'bafyMeta' }));
const pinEventImage = vi.fn(async () => ({ cid: 'bafkposter' }));
const saveEventArt = vi.fn(async (_args: unknown) => ({ ok: true as const }));
const setEventPrivate = vi.fn(async (_args: unknown) => ({ ok: true as const }));
vi.mock('../../shared/api/functions', async (orig) => ({
  ...(await orig<typeof import('../../shared/api/functions')>()),
  api: { createOrganizerForMe, pinEventMetadata, pinEventImage, saveEventArt, setEventPrivate },
}));

/**
 * The create path's relay transport (ERC-2771). This file is about which organisation the event
 * lands under, so a single `sendAction` that resolves `confirmed` with the new id is all it needs;
 * the org id it carries is a field of the encoded `EventMeta`, decoded from the calldata below.
 */
type RelayResult = { eventId?: string } | undefined;
const sendAction = vi.fn(
  async (
    _kind: string, _to: string, _data: Hex, _onSent?: (relayId: string) => void,
  ): Promise<RelayResult> => ({ eventId: '12' }),
);
const followRelay = vi.fn(async (_relayId: string): Promise<RelayResult> => ({ eventId: '12' }));
vi.mock('../../shared/relay/sendAction', () => ({ sendAction, followRelay }));

const TICKET = `0x${'33'.repeat(20)}` as const;
vi.mock('../../shared/config', async (orig) => ({
  ...(await orig<typeof import('../../shared/config')>()),
  getConfig: () => ({ addresses: { ticket: TICKET }, ipfsGateway: 'https://gw.test/' }),
}));

const { DraftPublish } = await import('./DraftPublish');
const { emptyEventDraft, emptyEventDraftTier } = await import('../useEventDraft');
const { organizerCopy } = await import('../copy');
const copy = organizerCopy.ko.scene;

function Probe() {
  return <p>{`landed:${useLocation().pathname}`}</p>;
}

/** The org id the event was created under, decoded from the one relayed `publishEvent` calldata. */
function sentOrgId(call = 0): bigint {
  const data = sendAction.mock.calls[call]?.[2] as Hex;
  const { args = [] } = decodeFunctionData({ abi: ticketAbi, data });
  return (args[0] as { orgId: bigint }).orgId;
}

/** Everything filled in but the organisation, which is the whole subject of this file. */
const READY: EventDraft = {
  ...emptyEventDraft,
  orgId: '',
  title: '재즈 나이트',
  description: '한남동 재즈 라이브 공연',
  posterCid: 'bafkposter',
  regionCode: 'KR-11',
  venue: '서울 용산구 한남동',
  startsAt: 1_900_000_000,
  endsAt: 1_900_010_000,
  tiers: [{ ...emptyEventDraftTier, name: '일반' }],
};

function open(draft: EventDraft = READY, id = 'd-42'): void {
  store = [{ id, updatedAt: 1_000, data: draft }];
  render(
    <MemoryRouter initialEntries={[`/org/new/${id}/publish`]}>
      <Routes>
        <Route path="/org/new/:draftId/publish" element={<DraftPublish />} />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function ready(): Promise<void> {
  await screen.findByRole('heading', { name: READY.title });
}

/**
 * {@link ready} plus the organiser line actually carrying its prefill.
 *
 * The draft's title and its `orgPendingName` arrive in the same state update, but the name
 * reaches the box one render later — an effect reads `draft.orgPendingName || displayName`
 * and sets it. A press landing inside that window finds `orgName` still empty, so `만들기`
 * reports the empty box and scrolls to it instead of publishing: no organisation is made and
 * the button never goes dead. Under a loaded runner that window is wide enough to hit, which
 * is exactly how a green suite turned red once in three runs.
 *
 * Every test that presses `만들기` expecting a publish therefore waits for the box, not just
 * for the title. This tightens the setup; it asserts nothing the test was not already relying
 * on being true.
 */
async function readyToPublish(orgName: string): Promise<void> {
  await ready();
  await waitFor(() => expect(screen.getByLabelText(copy.org.label)).toHaveValue(orgName));
}

/** 공개하기, and — when the confirm sheet opens — 네, 공개할게요. */
async function create(): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: copy.publishScreen.publish }));
  const confirm = screen.queryByRole('button', { name: copy.publishScreen.confirm });
  if (confirm !== null) await user.click(confirm);
}

beforeAll(() => {
  URL.createObjectURL = () => 'blob:art';
  URL.revokeObjectURL = () => undefined;
});

beforeEach(() => {
  localStorage.clear();
  store = [];
  listed = [];
  // The scene reads the profile in two places now — the organiser line prefills from it and
  // the ticket preview prints it — so this is a standing answer rather than a one-shot.
  loadMyProfile.mockResolvedValue({ displayName: '김태완' });
  createOrganizerForMe.mockResolvedValue({ orgId: '9' });
  pinEventMetadata.mockResolvedValue({ metadataCid: 'bafyMeta' });
  sendAction.mockResolvedValue({ eventId: '12' });
});

/**
 * The founder's second tap, the other half of it (plan section B-4). `주최사 만들기` used to be
 * a screen somebody had to pass through before they could make an event; it is one line above
 * the button now, and only for somebody who has no organisation at all.
 */
describe('the organiser line', () => {
  it('is prefilled with the name this person already gave', async () => {
    open();
    await ready();
    await waitFor(() => expect(screen.getByLabelText(copy.org.label)).toHaveValue('김태완'));
    expect(screen.getByText(copy.org.help)).toBeInTheDocument();
  });

  it('is not drawn at all for somebody who already organises', async () => {
    listed = [ORG];
    open();
    await ready();
    expect(screen.queryByLabelText(copy.org.label)).toBeNull();
  });

  it('says what is wrong rather than sending an organisation called nothing', async () => {
    loadMyProfile.mockResolvedValue({ displayName: '' });
    open();
    await ready();
    await create();

    expect(await screen.findByText(copy.publishProblems.orgName)).toBeInTheDocument();
    expect(createOrganizerForMe).not.toHaveBeenCalled();
    expect(pinEventMetadata).not.toHaveBeenCalled();
  });
});

describe('resolving the organisation inside 공개하기', () => {
  it('makes one under the name in the box, and creates the event under it', async () => {
    open();
    await readyToPublish('김태완');
    await create();

    await waitFor(() => expect(createOrganizerForMe).toHaveBeenCalledWith({ name: '김태완' }));
    // The name is written to the draft **before** the callable, so a run that dies mid-call
    // leaves something the next attempt can recognise.
    const before = saveEventDraft.mock.calls
      .map(([, written]) => written as EventDraft)
      .find((written) => written.orgPendingName !== '');
    expect(before?.orgPendingName).toBe('김태완');

    // And the event goes to the organisation that call produced — the pin and the encoded
    // `EventMeta.orgId` both name it.
    await waitFor(() => expect(pinEventMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: '9' }),
    ));
    await waitFor(() => expect(sendAction).toHaveBeenCalled());
    expect(sentOrgId()).toBe(9n);
    // Cleared once it answered: a draft still carrying a name is a run that did not finish.
    const after = saveEventDraft.mock.calls.at(-1)?.[1] as EventDraft;
    expect(after).toMatchObject({ orgId: '9', orgPendingName: '' });
  });

  /** The callable is not idempotent: a second call is a second organisation. */
  it('creates one at most once per draft, however often 만들기 is pressed', async () => {
    pinEventMetadata.mockRejectedValueOnce({ code: 'unavailable', message: 'offline' });
    open();
    await readyToPublish('김태완');
    await create();
    await waitFor(() => expect(createOrganizerForMe).toHaveBeenCalledTimes(1));
    await screen.findByText(copy.publishProblems.pinFailed);

    // The pin failed, so the organiser presses again. The organisation already exists and its
    // number is on the draft — nothing asks for a second one.
    await create();
    await waitFor(() => expect(pinEventMetadata).toHaveBeenCalledTimes(2));
    expect(createOrganizerForMe).toHaveBeenCalledTimes(1);
  });

  it('uses an organisation the indexer already listed instead of making another', async () => {
    listed = [ORG];
    open();
    await ready();
    await create();

    await waitFor(() => expect(pinEventMetadata).toHaveBeenCalled());
    expect(createOrganizerForMe).not.toHaveBeenCalled();
    expect(pinEventMetadata.mock.calls[0]?.[0]).toMatchObject({ orgId: '9' });
  });

  /**
   * The re-entry the guard exists for: a previous attempt wrote the name down and then the app
   * died — during the call, or waiting for the receipt. The organisation may well exist, so the
   * indexer is asked again before anything is sent.
   */
  it('asks the indexer again before making a second organisation for the same draft', async () => {
    listed = [];
    orgRefetch.mockImplementationOnce(async () => [ORG]);
    open({ ...READY, orgPendingName: '몬티 크루' });
    await readyToPublish('몬티 크루');
    await create();

    await waitFor(() => expect(orgRefetch).toHaveBeenCalled());
    expect(createOrganizerForMe).not.toHaveBeenCalled();
    await waitFor(() => expect(pinEventMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: '9' }),
    ));
  });

  /**
   * The same re-entry, pressed twice in a row. `createOrganizerForMe` is not idempotent, so
   * the second press must find the button already refusing: the phase is claimed before the
   * indexer is asked, and 만들기 goes dead the moment the first press starts.
   */
  it('makes one organisation when 만들기 is double-tapped on that same draft', async () => {
    let letTheIndexerAnswer = (): void => undefined;
    orgRefetch.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { letTheIndexerAnswer = resolve; });
      return [];
    });
    open({ ...READY, orgPendingName: '몬티 크루' });
    await readyToPublish('몬티 크루');

    const button = screen.getByRole('button', { name: copy.publishScreen.publish });
    await act(async () => { fireEvent.click(button); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: copy.publishScreen.confirm })); });
    // The indexer has not answered; without the fix the button is still live here.
    expect(button).toBeDisabled();
    await act(async () => { fireEvent.click(button); });

    await act(async () => { letTheIndexerAnswer(); });
    await waitFor(() => expect(createOrganizerForMe).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(pinEventMetadata).toHaveBeenCalledTimes(1));
    expect(orgRefetch).toHaveBeenCalledTimes(1);
  });

  it('makes one after all when the second look still finds nothing', async () => {
    open({ ...READY, orgPendingName: '몬티 크루' });
    await readyToPublish('몬티 크루');
    await create();

    await waitFor(() => expect(createOrganizerForMe).toHaveBeenCalledWith({ name: '몬티 크루' }));
    expect(orgRefetch).toHaveBeenCalled();
  });

  it('names the cap rather than blaming the connection', async () => {
    createOrganizerForMe.mockRejectedValueOnce(
      Object.assign(new Error('ORG_LIMIT'), { code: 'failed-precondition' }),
    );
    open();
    await readyToPublish('김태완');
    await create();

    expect(await screen.findByText(copy.publishProblems.orgLimit)).toBeInTheDocument();
    expect(pinEventMetadata).not.toHaveBeenCalled();
  });
});
