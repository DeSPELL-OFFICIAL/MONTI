import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, keccak256, toBytes, type Hex } from 'viem';
import { ticketAbi } from '../../shared/chain/abis';
import type { EventDraft, StoredEventDraft } from '../../shared/api/firestore';
import { ko as sharedKo } from '../../shared/copy/index';

let store: StoredEventDraft[] = [];
const listEventDrafts = vi.fn(async () => [...store].sort((a, b) => b.updatedAt - a.updatedAt));
const saveEventDraft = vi.fn(async (_id: string, _draft: EventDraft) => undefined);
const deleteEventDraft = vi.fn(async (id: string) => {
  store = store.filter((row) => row.id !== id);
});
const loadMyProfile = vi.fn(async () => ({ displayName: '김태완' }));
vi.mock('../../shared/api/firestore', () => ({
  listEventDrafts, saveEventDraft, deleteEventDraft, loadMyProfile,
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


interface PinCall {
  orgId: string;
  meta: {
    name: string; description: string; imageCid: string;
    venue?: string; category?: number; region?: string;
    tags?: string[]; venueHidden?: boolean; timeHidden?: boolean;
  };
}
const pinEventImage = vi.fn(async () => ({ cid: 'bafkposter' }));
const pinEventMetadata = vi.fn(async (_args: PinCall) => ({ metadataCid: 'bafyMeta' }));
const saveEventArt = vi.fn(async (_args: unknown) => ({ ok: true as const }));
const setEventPrivate = vi.fn(async (_args: unknown) => ({ ok: true as const }));
vi.mock('../../shared/api/functions', async (orig) => ({
  ...(await orig<typeof import('../../shared/api/functions')>()),
  api: { pinEventImage, pinEventMetadata, saveEventArt, setEventPrivate },
}));

/**
 * The relay transport the create path now takes (ERC-2771, retiring the sponsored userOp). One
 * relayed `createEvent` goes out through `sendAction`, which follows the `relays/{relayId}`
 * document to a settled `result.eventId`; a submission the draft already recorded is resumed with
 * `followRelay`. These two are the whole of what `usePublish` imports from this module.
 *
 * The default resolves as an already-`confirmed` relay (`onSent` never fires): the id is known
 * the moment `sendAction` returns, which is the happy path. A test that wants the broadcast-but-
 * not-settled (`sent`) state fires the `onSent` callback itself and leaves the promise pending.
 */
type RelayResult = { eventId?: string } | undefined;
const sendAction = vi.fn(
  async (
    _kind: string, _to: string, _data: Hex, _onSent?: (relayId: string) => void,
    _extra?: { reasons?: string[] },
  ): Promise<RelayResult> => ({ eventId: '12' }),
);
const followRelay = vi.fn(async (_relayId: string): Promise<RelayResult> => ({ eventId: '12' }));
vi.mock('../../shared/relay/sendAction', () => ({ sendAction, followRelay }));

const TICKET = `0x${'33'.repeat(20)}` as const;
const PLATFORM = `0x${'cc'.repeat(20)}` as const;
/** Whether this build has the settlement wiring (vault + token + platform row account). */
let settlementOn = false;
vi.mock('../../shared/config', async (orig) => ({
  ...(await orig<typeof import('../../shared/config')>()),
  getConfig: () => ({
    addresses: { ticket: TICKET, ...(settlementOn ? { platform: PLATFORM } : {}) },
    ipfsGateway: 'https://gw.test/',
  }),
  settlementEnabled: () => settlementOn,
}));

// The default-poster rasteriser needs a canvas jsdom does not have, so it is stubbed to raw
// base64; that the create path renders and pins it is what is under test (T-SIMP-9).
vi.mock('./autoPoster', () => ({
  renderAutoPoster: vi.fn(async () => 'AUTO64'),
  buildPosterSvg: () => '<svg/>',
}));

const { CreateEvent } = await import('./CreateEvent');
const { DraftPublish } = await import('./DraftPublish');
const { emptyEventDraft, emptyEventDraftTier } = await import('../useEventDraft');
const { organizerCopy } = await import('../copy');
const copy = organizerCopy.ko.scene;
// Dynamic, not a top-level import: the module is mocked, and pulling a named export at the top of
// the file would run the mock factory before the mocked callables above are initialised. The
// factory preserves this export (`...(await orig())`), so the real `CallableError` is what both
// this file and `usePublish` reference — `cause instanceof CallableError` still holds.
const { CallableError } = await import('../../shared/api/functions');

/** Where a navigation landed, and what it carried — the handover is what the retry runs on. */
let handed: unknown = null;
function handover(): unknown {
  return handed;
}
function Probe() {
  const location = useLocation();
  handed = location.state;
  return <p>{`landed:${location.pathname}`}</p>;
}

/** The `relays/{relayId}` a `sent` (broadcast, not yet settled) createEvent recorded on the draft. */
const SUBMITTED = 'relay-9';

/** The `EventMeta`/tiers the create path encoded into its one relayed `createEvent` calldata. */
function createArgs(call = 0): { meta: Record<string, unknown>; tiers: unknown[] } {
  const data = sendAction.mock.calls[call]?.[2] as Hex;
  const { args = [] } = decodeFunctionData({ abi: ticketAbi, data });
  return { meta: args[0] as Record<string, unknown>, tiers: args[1] as unknown[] };
}

const READY: EventDraft = {
  ...emptyEventDraft,
  orgId: '9',
  title: '  재즈 나이트  ',
  description: '한남동 재즈 라이브 공연',
  posterCid: 'bafkposter',
  category: 2,
  tags: [' #재즈 ', '라이브', '재즈'],
  regionCode: 'KR-11',
  venue: '서울 용산구 한남동',
  // Well in the future, so the derived sign-up window (now -> endsAt) is a real one.
  startsAt: 1_900_000_000,
  endsAt: 1_900_010_000,
  transferable: true,
  transferCutoffHours: 2,
  tiers: [
    { ...emptyEventDraftTier, name: '일반', supply: 100, maxPerWallet: 2, design: 'c' },
    { ...emptyEventDraftTier, name: '학생', supply: 20, maxPerWallet: 1, imageCid: 'bafkart' },
  ],
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

/** 공개하기 on the publish screen, and — when the confirm sheet opens — 네, 공개할게요. */
async function create(): Promise<void> {
  const user = userEvent.setup();
  await screen.findByRole('heading', { name: READY.title.trim() });
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
  handed = null;
  settlementOn = false;
  sendAction.mockResolvedValue({ eventId: '12' });
  followRelay.mockResolvedValue({ eventId: '12' });
  pinEventMetadata.mockResolvedValue({ metadataCid: 'bafyMeta' });
  saveEventArt.mockResolvedValue({ ok: true });
  setEventPrivate.mockResolvedValue({ ok: true });
});

describe('the publish path', () => {
  it('pins, creates, saves the pictures and throws the draft away, in that order', async () => {
    open();
    await create();
    await waitFor(() => expect(screen.getByText('landed:/org/new/done/12')).toBeInTheDocument());

    // 1. the readable half, with the tags normalised exactly as the server would.
    expect(pinEventMetadata).toHaveBeenCalledWith({
      orgId: '9',
      meta: {
        name: '재즈 나이트',
        description: '한남동 재즈 라이브 공연',
        imageCid: 'bafkposter',
        category: 2,
        region: 'KR-11',
        venue: '서울 용산구 한남동',
        tags: ['재즈', '라이브'],
        venueHidden: false,
        timeHidden: false,
      },
    });

    // 2. one relayed `createEvent`, built by the one helper that owns the hashing and handed to
    //    `sendAction('createEvent', 'ticket', <calldata>, onSent)`.
    expect(sendAction).toHaveBeenCalledWith(
      'createEvent', 'ticket', expect.any(String), expect.any(Function), { reasons: undefined },
    );
    const { meta, tiers } = createArgs();
    // The org id no longer rides beside the call — it is a field of the encoded `EventMeta`.
    expect(meta).toMatchObject({
      orgId: 9n,
      imageCid: 'bafyMeta',
      // The trimmed title is what is hashed, because the trimmed title is what is pinned.
      titleHash: keccak256(toBytes('재즈 나이트')),
      venueHash: keccak256(toBytes('서울 용산구 한남동')),
      regionCode: keccak256(toBytes('KR-11')),
      transferCutoffSeconds: 7_200,
      // Never asked for on screen, and there is one right answer for each.
      approvalRequired: false,
      maxTransfers: 3,
      // Sign-ups close when the event ends; they opened when it was created.
      saleEnd: BigInt(READY.endsAt),
    });
    // Derived rather than asked for: open now, close when the event ends. `createEvent` only
    // asks that the two are the right way round, and this pair always is.
    expect(meta.saleStart as bigint).toBeLessThan(meta.saleEnd as bigint);
    expect(Number(meta.saleStart)).toBeCloseTo(Math.floor(Date.now() / 1_000), -1);
    expect(tiers).toEqual([
      { name: '일반', priceUsdCents: 0n, supply: 100, minted: 0, maxPerWallet: 2, seated: false },
      { name: '학생', priceUsdCents: 0n, supply: 20, minted: 0, maxPerWallet: 1, seated: false },
    ]);

    // 3. the pictures, in tier order, as letters and CIDs and nothing else.
    expect(saveEventArt).toHaveBeenCalledWith({
      eventId: '12',
      tiers: [{ preset: 'c' }, { imageCid: 'bafkart' }],
    });

    // 4. nothing is hidden, so there is no private record to write.
    expect(setEventPrivate).not.toHaveBeenCalled();

    // 5. the draft is gone — one that outlived its event is a second event waiting to happen.
    expect(deleteEventDraft).toHaveBeenCalledWith('d-42');
  });

  /**
   * The end time is behind `더 설정하기` and most organisers never open it (plan section B-3),
   * so the number that reaches `Ticket.EventMeta` is almost always the derived one. `EventMeta`
   * is written once and `updateEventMeta` closes at publish: an `endsAt` of 0 here would be an
   * event that ended in 1970, with sign-ups closed before they opened, and nothing could repair
   * it. Every reader goes through `endsAtOf`, and this is the one that proves the chain does.
   */
  it('sends the derived end, and closes sign-ups on it, when nobody opened the fold', async () => {
    open({ ...READY, endsAt: 0 });
    await create();
    await waitFor(() => expect(screen.getByText('landed:/org/new/done/12')).toBeInTheDocument());

    const derived = BigInt(READY.startsAt + 7_200);
    const { meta } = createArgs();
    expect(meta.endsAt).toBe(derived);
    // `Ticket.createEvent` only asks that `saleStart < saleEnd`; the derived end is what makes
    // that true without a second date field ever being shown.
    expect(meta.saleEnd).toBe(derived);
    expect(meta.saleStart as bigint).toBeLessThan(meta.saleEnd as bigint);
    expect(meta.startsAt as bigint).toBeLessThan(meta.endsAt as bigint);
  });

  it('keeps a hidden venue out of the pin and puts it behind the callable instead', async () => {
    open({ ...READY, venueHidden: true, timeHidden: true });
    await create();
    await waitFor(() => expect(setEventPrivate).toHaveBeenCalledWith({
      eventId: '12', venue: '서울 용산구 한남동',
    }));

    const pinned = pinEventMetadata.mock.calls[0]?.[0];
    expect(Object.hasOwn(pinned?.meta ?? {}, 'venue')).toBe(false);
    expect(pinned?.meta).toMatchObject({ venueHidden: true, timeHidden: true });
    // The chain still carries the hash of the *real* venue, so the claim stays provable.
    const { meta } = createArgs();
    expect(meta).toMatchObject({ venueHash: keccak256(toBytes('서울 용산구 한남동')) });
  });

  /**
   * The event is on chain and the hidden venue exists nowhere else — the public document has
   * no `venue` key and `updateEventMeta` refuses anything past Draft. So the draft is held
   * open until both writes land, and the done screen is handed everything needed to finish.
   */
  it('keeps the draft when a follow-up did not land, and carries the retry across', async () => {
    saveEventArt.mockRejectedValue(new Error('offline'));
    open({ ...READY, venueHidden: true });
    await create();
    await waitFor(() => expect(screen.getByText('landed:/org/new/done/12')).toBeInTheDocument());
    expect(deleteEventDraft).not.toHaveBeenCalled();

    const state = handover() as {
      followUpFailed: boolean; draftId: string;
      plan: { eventId: string; venue: string | null; tiers: unknown[] };
      done: { artSaved: boolean; venueSaved: boolean };
    };
    expect(state.followUpFailed).toBe(true);
    expect(state.draftId).toBe('d-42');
    expect(state.plan).toMatchObject({ eventId: '12', venue: '서울 용산구 한남동' });
    // The venue went through even though the pictures did not: one refusal must not take the
    // other write down with it.
    expect(state.done).toEqual({ artSaved: false, venueSaved: true });
  });

  it('records the id on the draft before anything that could still fail', async () => {
    saveEventArt.mockRejectedValue(new Error('offline'));
    open();
    await create();
    await waitFor(() => expect(saveEventDraft).toHaveBeenCalled());
    const written = saveEventDraft.mock.calls.at(-1)?.[1] as { createdEventId?: string } | undefined;
    expect(written?.createdEventId).toBe('12');
  });

  it('never sends a second createEvent for a draft that already made one', async () => {
    open({ ...READY, createdEventId: '12' });
    await create();
    await waitFor(() => expect(saveEventArt).toHaveBeenCalled());
    expect(sendAction).not.toHaveBeenCalled();
    expect(followRelay).not.toHaveBeenCalled();
    expect(pinEventMetadata).not.toHaveBeenCalled();
  });

  /**
   * The poster is optional (plan B-2): a draft with an empty `posterCid` gets a default A4 poster
   * synthesised from its title and theme backdrop, pinned through the same `pinEventImage` path an
   * uploaded one takes — so the readable metadata still carries an `imageCid`.
   */
  it('auto-generates and pins a default poster when the draft has none (T-SIMP-9)', async () => {
    open({ ...READY, posterCid: '' });
    await create();
    await waitFor(() => expect(screen.getByText('landed:/org/new/done/12')).toBeInTheDocument());
    expect(pinEventImage).toHaveBeenCalledWith({ bytesBase64: 'AUTO64', kind: 'poster' });
    const pinned = pinEventMetadata.mock.calls.at(-1)?.[0];
    expect(pinned?.meta.imageCid).toBe('bafkposter');
  });
});

describe('when it does not land', () => {
  /**
   * The relayer answered `sent` (broadcast, not yet mined): `onSent` fires with the relay id and
   * the returned promise stays pending. The draft persists the id **before** the wait, and the
   * scene shows the determinate 확인 중 step, not an info-alert stacked on it (계획 §2a). Pressing
   * again follows the same relay document — it never sends a second createEvent.
   */
  it('shows the confirming wait when the relayer has broadcast, and follows rather than resending', async () => {
    const user = userEvent.setup();
    sendAction.mockImplementation(async (_kind, _to, _data, onSent) => {
      onSent?.('relay-1');
      return new Promise<RelayResult>(() => undefined);
    });
    followRelay.mockReturnValue(new Promise<RelayResult>(() => undefined));
    open();
    await create();
    await waitFor(() => expect(
      document.querySelector('.op-progress .steps__step--current .steps__label')?.textContent,
    ).toBe(sharedKo.op.confirming));
    expect(sendAction).toHaveBeenCalledTimes(1);
    // The relay id is written to the draft before the wait, so a reopen resumes rather than resends.
    await waitFor(() => {
      const written = saveEventDraft.mock.calls.at(-1)?.[1] as { submittedRelayId?: string } | undefined;
      expect(written?.submittedRelayId).toBe('relay-1');
    });

    // Pressing again follows the same relay document rather than sending a second publish.
    await user.click(screen.getByRole('button', { name: copy.publishScreen.publish }));
    await waitFor(() => expect(followRelay).toHaveBeenCalledWith('relay-1'));
    expect(sendAction).toHaveBeenCalledTimes(1);
  });

  it('finishes the event a broadcast relay actually created, on resume', async () => {
    followRelay.mockResolvedValue({ eventId: '12' });
    open({ ...READY, submittedRelayId: SUBMITTED });
    await create();
    await waitFor(() => expect(screen.getByText('landed:/org/new/done/12')).toBeInTheDocument());
    expect(followRelay).toHaveBeenCalledWith(SUBMITTED);
    expect(sendAction).not.toHaveBeenCalled();
    expect(saveEventArt).toHaveBeenCalled();
  });

  /**
   * The relayer settled the submission as `failed`: `followRelay` rejects with a `CallableError`
   * whose `details.code` is the bubbled `Ticket` error name. The submission is spent, so the
   * record is dropped and the rule is named — never sent a second time on this pass.
   */
  it('clears a spent relay and names the rule when the settle failed', async () => {
    followRelay.mockRejectedValueOnce(
      new CallableError('failed-precondition', 'InvalidTiers', { code: 'InvalidTiers' }),
    );
    open({ ...READY, submittedRelayId: SUBMITTED });
    await create();
    expect(await screen.findByText(copy.publishProblems.tiersEmpty)).toBeInTheDocument();
    expect(sendAction).not.toHaveBeenCalled();
    // The spent id is dropped, so a fresh 만들기 is free to send again.
    await waitFor(() => {
      const written = saveEventDraft.mock.calls.at(-1)?.[1] as { submittedRelayId?: string } | undefined;
      expect(written?.submittedRelayId).toBe('');
    });
  });

  /**
   * The same spent submission, but the failure carries no rule the organiser can fix — it reads
   * as the generic failure. Because the record was cleared, the next 만들기 sends one fresh
   * createEvent (the resume path never resends; a cleared draft is an ordinary create again).
   */
  it('sends one fresh createEvent after a spent relay is cleared', async () => {
    const user = userEvent.setup();
    followRelay.mockRejectedValueOnce(
      new CallableError('failed-precondition', 'TX_REVERT', { code: 'TX_REVERT' }),
    );
    open({ ...READY, submittedRelayId: SUBMITTED });
    await create();
    expect(await screen.findByText(copy.publishProblems.failed)).toBeInTheDocument();
    expect(sendAction).not.toHaveBeenCalled();

    // The relay id is gone, so pressing again (and confirming) sends a fresh publish and finishes.
    await user.click(screen.getByRole('button', { name: copy.publishScreen.publish }));
    await user.click(screen.getByRole('button', { name: copy.publishScreen.confirm }));
    await waitFor(() => expect(screen.getByText('landed:/org/new/done/12')).toBeInTheDocument());
    expect(sendAction).toHaveBeenCalledTimes(1);
    expect(followRelay).toHaveBeenCalledTimes(1);
  });

  /**
   * A dropped Firestore listener is not a verdict: the relay may still land, so the record and
   * the confirming wait both stay, and re-pressing follows the same document rather than resending.
   */
  it('keeps the relay and stays confirming when the listener drops', async () => {
    followRelay.mockRejectedValueOnce(new Error('listener dropped'));
    open({ ...READY, submittedRelayId: SUBMITTED });
    await create();
    await waitFor(() => expect(
      document.querySelector('.op-progress .steps__step--current .steps__label')?.textContent,
    ).toBe(sharedKo.op.confirming));
    expect(followRelay).toHaveBeenCalledWith(SUBMITTED);
    expect(sendAction).not.toHaveBeenCalled();
  });

  /**
   * A fresh createEvent the chain refuses: `sendAction` rejects with a `CallableError` whose
   * `details.code` is the bubbled `Ticket` error name, read off the same way the sponsored path
   * decoded a four-byte selector. `Unauthorized` is the organiser not owning the org.
   */
  it('names the rule when a fresh createEvent reverts', async () => {
    sendAction.mockRejectedValueOnce(
      new CallableError('failed-precondition', 'Unauthorized', { code: 'Unauthorized' }),
    );
    open();
    await create();
    expect(await screen.findByText(copy.publishProblems.notYourOrg)).toBeInTheDocument();
    expect(deleteEventDraft).not.toHaveBeenCalled();
  });

  /**
   * A confirmed relay that named no event id is a backend fault (the relayer fills
   * `result.eventId`), not a draft the organiser can fix — so it reads as the generic failure,
   * nothing is finished, and the draft is kept.
   */
  it('reads a confirmed relay that named no event id as the generic failure', async () => {
    sendAction.mockResolvedValue({});
    open();
    await create();
    expect(await screen.findByText(copy.publishProblems.failed)).toBeInTheDocument();
    expect(screen.queryByText(/^landed:/)).toBeNull();
    expect(deleteEventDraft).not.toHaveBeenCalled();
    expect(saveEventArt).not.toHaveBeenCalled();
  });

  it('names a refused tag rather than blaming the connection', async () => {
    pinEventMetadata.mockRejectedValue({ code: 'invalid-argument', message: 'BAD_TAGS' });
    open();
    await create();
    expect(await screen.findByText(copy.publishProblems.badTags)).toBeInTheDocument();
    expect(sendAction).not.toHaveBeenCalled();
  });

  /**
   * The day's pin cap: `pinEventImage`/`pinEventMetadata` answer `resource-exhausted` with a
   * `PIN_QUOTA` reason past the twentieth picture (functions/src/functions/organizer.ts). It is
   * not a draft the organiser can fix — the cap lifts tomorrow — so it earns its own inline
   * sentence rather than the generic "행사를 만들지 못했어요".
   */
  it('names the daily image quota rather than the generic failure', async () => {
    pinEventMetadata.mockRejectedValue({ code: 'resource-exhausted', message: 'PIN_QUOTA' });
    open();
    await create();
    expect(await screen.findByText(copy.publishProblems.imageQuota)).toBeInTheDocument();
    expect(screen.queryByText(copy.publishProblems.failed)).toBeNull();
    expect(sendAction).not.toHaveBeenCalled();
  });

  /**
   * The same cap, hit while the default poster is being pinned, and recognised by the
   * `resource-exhausted` code alone — so a reason that is not literally `PIN_QUOTA` still maps.
   */
  it('names the quota when the auto-poster pin is the one that hits it', async () => {
    pinEventImage.mockRejectedValueOnce({ code: 'resource-exhausted', message: '' });
    open({ ...READY, posterCid: '' });
    await create();
    expect(await screen.findByText(copy.publishProblems.imageQuota)).toBeInTheDocument();
    expect(pinEventMetadata).not.toHaveBeenCalled();
    expect(sendAction).not.toHaveBeenCalled();
  });
});

/**
 * expert-3 "minimum event": the founder's "동아리 공연, 내일 저녁, 무료 30명". With the batch-2/P1
 * defaults in force (auto poster on publish, next-Saturday start, optional 소개, optional 장소,
 * 수량 100, 서울, 종류 '일반') the only field still needing input on a fresh /org/new is the title;
 * everything else is defaulted, so the minimum is title + one tap on 행사 만들기 — two actions.
 */
function openFresh(): void {
  render(
    <MemoryRouter initialEntries={['/org/new']}>
      <Routes>
        <Route path="/org/new" element={<CreateEvent />} />
        <Route path="/org/new/:draftId" element={<CreateEvent />} />
        <Route path="/org/new/:draftId/publish" element={<DraftPublish />} />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Title, 다음, 공개하기, and the confirm — nothing on chain until the last one. */
async function minimumPublish(user: ReturnType<typeof userEvent.setup>): Promise<number> {
  let actions = 0;
  await user.type(screen.getByLabelText(copy.titleLabel), '동아리 공연'); actions += 1;
  await user.click(screen.getByRole('button', { name: copy.tiers.next })); actions += 1;
  expect(sendAction).not.toHaveBeenCalled();
  await user.click(await screen.findByRole('button', { name: copy.publishScreen.publish })); actions += 1;
  await user.click(screen.getByRole('button', { name: copy.publishScreen.confirm })); actions += 1;
  return actions;
}

describe('the minimum event', () => {
  it('reaches a published event in four taps (title, 다음, 공개하기, confirm)', async () => {
    // One team already exists, so no organiser-name tap is needed either.
    orgsListed.mockReturnValue([{ orgId: '9', canCreateEvent: true }]);
    const user = userEvent.setup();
    openFresh();
    await waitFor(() => expect(screen.getByLabelText(copy.titleLabel)).toBeInTheDocument());

    const actions = await minimumPublish(user);

    await waitFor(() => expect(screen.getByText('landed:/org/new/done/12')).toBeInTheDocument());
    // The default poster was synthesised and pinned — no poster upload tap was ever needed.
    expect(pinEventImage).toHaveBeenCalledWith({ bytesBase64: 'AUTO64', kind: 'poster' });
    // v2 minimum: the publish screen and its irreversible-confirm sheet are part of the flow.
    expect(actions).toBe(4);
    expect(sendAction).toHaveBeenCalledTimes(1);
  });

  /**
   * 장소는 이제 선택이다(P1): 제목만으로도 발행된다. 빈 장소는 빈 문자열로 핀되고 탐색 상세는
   * 기본 라벨 "장소 미정"으로 읽으므로, 장소는 더 이상 세는 동작이 아니다.
   */
  it('publishes with the venue left blank (optional now)', async () => {
    orgsListed.mockReturnValue([{ orgId: '9', canCreateEvent: true }]);
    const user = userEvent.setup();
    openFresh();
    await waitFor(() => expect(screen.getByLabelText(copy.titleLabel)).toBeInTheDocument());

    await minimumPublish(user);

    await waitFor(() => expect(screen.getByText('landed:/org/new/done/12')).toBeInTheDocument());
    const pinned = pinEventMetadata.mock.calls.at(-1)?.[0];
    expect(pinned?.meta).toMatchObject({ venue: '', venueHidden: false });
  });
});

/** v2: draft → 정산 규칙 → 공개. The split lives in the draft until the one publish write. */
describe('the publish screen', () => {
  const BAND = `0x${'a1'.repeat(20)}`;
  const PAID: EventDraft = {
    ...READY,
    tiers: [{ ...emptyEventDraftTier, name: 'VIP', supply: 10, maxPerWallet: 1, currency: 'USDC', amount: 30 }],
  };
  const split = (bandBps: number, platformBps = 500): string => JSON.stringify([
    { name: '밴드', account: BAND, bps: bandBps, tag: 'band', platform: false },
    { name: 'MONTI 플랫폼', account: PLATFORM, bps: platformBps, tag: 'platform', platform: true },
  ]);
  const publishButton = () => screen.getByRole('button', { name: copy.publishScreen.publish });

  it('shows no split rules card for a free event', async () => {
    open();
    await screen.findByRole('heading', { name: '재즈 나이트' });
    expect(screen.queryByText(copy.publishScreen.splitIntro)).toBeNull();
    expect(publishButton()).toBeEnabled();
  });

  it('holds 공개하기 on a paid event until the split adds up to 100%', async () => {
    settlementOn = true;
    open({ ...PAID, splitJson: split(9_000) });
    await screen.findByText(copy.publishScreen.splitIntro);
    expect(await screen.findByText(organizerCopy.ko.settlement.errors.badSum)).toBeInTheDocument();
    expect(publishButton()).toBeDisabled();
  });

  it('saves the edited split into the draft, and lets the event publish once it is valid', async () => {
    settlementOn = true;
    const user = userEvent.setup();
    open({ ...PAID, splitJson: split(9_000) });
    await screen.findByText(copy.publishScreen.splitIntro);
    const [bandPercent] = await screen.findAllByLabelText(organizerCopy.ko.settlement.percentLabel);
    await user.clear(bandPercent as HTMLElement);
    await user.type(bandPercent as HTMLElement, '95');
    expect(publishButton()).toBeEnabled();
    // The draft's device mirror is written on every change (Firestore follows on the debounce).
    const mirror = JSON.parse(localStorage.getItem('monti.eventDraft') ?? '{}') as { draft?: EventDraft };
    expect(JSON.parse(mirror.draft?.splitJson ?? '[]')).toEqual(JSON.parse(split(9_500)));
  });

  it('confirms what goes public — title, priced tickets, split rules — before sending anything', async () => {
    settlementOn = true;
    const user = userEvent.setup();
    open({ ...PAID, splitJson: split(9_500) });
    await screen.findByText(copy.publishScreen.splitIntro);
    await user.click(publishButton());

    const sheet = screen.getByRole('dialog', { name: copy.publishScreen.confirmHeading });
    expect(sheet).toHaveTextContent('VIP · $30.00');
    expect(sheet).toHaveTextContent('밴드 · 95%');
    expect(sheet).toHaveTextContent('MONTI 플랫폼 · 5%');
    expect(sheet).toHaveTextContent(copy.publishScreen.confirmBody);
    expect(sendAction).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: copy.publishScreen.cancel }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(sendAction).not.toHaveBeenCalled();
  });

  it('publishes a paid event in one write carrying the prices and one reason per recipient', async () => {
    settlementOn = true;
    open({ ...PAID, splitJson: split(9_500) });
    await create();
    await waitFor(() => expect(screen.getByText('landed:/org/new/done/12')).toBeInTheDocument());
    expect(sendAction).toHaveBeenCalledTimes(1);
    expect(sendAction.mock.calls[0]?.[4]).toEqual({ reasons: ['밴드', 'MONTI 플랫폼'] });
    expect(createArgs().tiers).toEqual([
      { name: 'VIP', priceUsdCents: 3_000n, supply: 10, minted: 0, maxPerWallet: 1, seated: false },
    ]);
  });

  it('says a paid event cannot publish where settlement is not set up', async () => {
    open({ ...PAID, splitJson: split(9_500) });
    await screen.findByRole('heading', { name: '재즈 나이트' });
    expect(screen.getByText(copy.publishScreen.blockers.settlementOff)).toBeInTheDocument();
    expect(publishButton()).toBeDisabled();
  });

  it('sends a draft with a broken creation rule back to 내용 고치기', async () => {
    open({ ...READY, tiers: [{ ...emptyEventDraftTier, name: '' }] });
    await screen.findByText(copy.publishScreen.blockers.draft);
    expect(publishButton()).toBeDisabled();
    expect(screen.getByRole('link', { name: copy.publishScreen.back })).toHaveAttribute('href', '/org/new/d-42');
  });
});
